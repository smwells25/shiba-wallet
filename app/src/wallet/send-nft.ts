import type { DerivedAccount } from '@shiba-wallet/core';
import {
  NodeClient,
  decodeAddress,
  decodeUint256,
  encodeErc1155BalanceOf,
  encodeErc1155SafeTransferFrom,
  encodeErc721OwnerOf,
  encodeErc721SafeTransferFrom,
  httpTransport as evmHttpTransport,
  simulateCall,
  toHex,
  type JsonRpcTransport,
  type NftStandard,
  type SimulationResult,
} from '@shiba-wallet/chains-evm';
// Explicit .ts extensions: this module is imported by scripts/check-nfts.mjs
// under Node's type stripping, which resolves relative specifiers literally.
import {
  chainHasL1DataFee,
  describeSendError,
  opStackFeeTotal,
  quoteOpStackFees,
  sendEvm,
  type EvmSendQuote,
  type OpStackFees,
  type SendResult,
} from './send.ts';

/**
 * NFT send flow (phase 7 item 4): quoting and sign+broadcast for ERC-721
 * and ERC-1155 transfers on the EOA path, mirroring ./send-erc20.ts.
 *
 * The transaction is an ordinary EIP-1559 EOA transaction: value 0, `to` =
 * the NFT contract, `data` = safeTransferFrom calldata from the engine
 * (packages/chains-evm erc721.ts / erc1155.ts, selectors computed from the
 * canonical signatures and pinned against ethers). sendNft reshapes the
 * quote into an EvmSendQuote and delegates to send.ts's sendEvm, so there
 * is exactly one EVM signing and broadcast path in the app.
 *
 * Unlike ERC-20 sends (pinned to mainnet), NFT sends follow the ACTIVE EVM
 * chain: the caller passes the active profile's CAIP-2 id, the endpoint's
 * eth_chainId must match it, and the NFT's own CAIP-19 chain must match it
 * too, so a Sepolia NFT can never be quoted against mainnet or vice versa.
 *
 * Ownership is re-checked on-chain at quote time (ownerOf for ERC-721,
 * balanceOf for ERC-1155): the indexer's list can lag behind the chain,
 * and the chain is the authority on what this account can send.
 *
 * Free of React Native imports so scripts/check-nfts.mjs exercises this
 * exact code with a fake JSON-RPC node.
 */

/**
 * Fallback gas limit, used only when eth_estimateGas itself reverts (it
 * executes the transfer, so a doomed transfer fails estimation too). In
 * that state the pre-flight simulation fails as well and the send stays
 * blocked behind the explicit override switch. Plain NFT transfers are
 * typically well under 100k gas, but a safe transfer to a contract runs the
 * recipient's onERC721Received / onERC1155Received hook, whose cost is
 * arbitrary; 250k is a deliberate over-estimate, and unused gas is not
 * charged.
 */
export const NFT_TRANSFER_GAS_FALLBACK = 250_000n;

/** Serializable description of the NFT handed to the Send screen route. */
export interface NftSendParams {
  /** CAIP-19 id with a decimal token id (core nonFungibleAssetId). */
  assetId: string;
  standard: NftStandard;
  /** Sanitized display name and collection title (display only). */
  name: string;
  collection: string;
  /** Indexer-reported balance as a decimal string (bounds the 1155 input). */
  balance: string;
}

export interface NftSendQuote {
  kind: 'nft';
  standard: NftStandard;
  /** Final recipient — the safeTransferFrom `to`, not the tx `to`. */
  to: string;
  /** NFT contract (EIP-55) — the transaction's `to`. */
  contract: string;
  tokenId: bigint;
  /** Copies sent: always 1n for ERC-721. */
  amount: bigint;
  /** On-chain balance at quote time (1n/0n for ERC-721 via ownerOf). */
  ownedBalance: bigint;
  /** Sender's ETH balance in wei (gas is paid in ETH). */
  ethBalance: bigint;
  nonce: bigint;
  chainId: bigint;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /**
   * Worst-case fee in wei: gasLimit * maxFeePerGas, plus the OP-stack L1
   * data fee reserve and operator fee on chains that have them (`opStack`).
   */
  fee: bigint;
  data: Uint8Array;
  /** eth_call pre-flight; a failure blocks unless explicitly overridden. */
  simulation: SimulationResult;
  gasIsFallback: boolean;
  /** OP-stack fee parts (Base Sepolia), included in `fee`; absent elsewhere. */
  opStack?: OpStackFees;
}

export interface NftSendRequest {
  url: string;
  from: string;
  /** Validated recipient (EIP-55 normalized by validateRecipient). */
  to: string;
  contract: string;
  tokenId: bigint;
  standard: NftStandard;
  /** Copies to send; must be 1n for ERC-721. */
  amount: bigint;
  /** ACTIVE EVM chain (config/evm-chain.ts), e.g. 'eip155:11155111'. */
  expectedCaip2: string;
  /** CAIP-2 chain of the NFT's asset id; must equal expectedCaip2. */
  nftCaip2: string;
}

async function ethCall(transport: JsonRpcTransport, to: string, data: Uint8Array): Promise<string> {
  return (await transport('eth_call', [{ to, data: toHex(data) }, 'latest'])) as string;
}

/**
 * On-chain balance of one NFT for `owner`: ERC-721 → 1n when ownerOf
 * returns exactly `owner`, else 0n; ERC-1155 → balanceOf(owner, id).
 * An ownerOf revert (burned or never-minted id) throws a plain message.
 */
export async function fetchNftBalance(
  transport: JsonRpcTransport,
  standard: NftStandard,
  contract: string,
  tokenId: bigint,
  owner: string,
): Promise<bigint> {
  if (standard === 'erc721') {
    let current: string;
    try {
      current = decodeAddress(await ethCall(transport, contract, encodeErc721OwnerOf(tokenId)));
    } catch (e) {
      throw new Error(
        `The contract did not report an owner for this token (ownerOf failed: ${
          e instanceof Error ? e.message : String(e)
        }). It may have been burned or the contract is not a standard ERC-721.`,
      );
    }
    return current.toLowerCase() === owner.toLowerCase() ? 1n : 0n;
  }
  return decodeUint256(await ethCall(transport, contract, encodeErc1155BalanceOf(owner, tokenId)));
}

/** The safeTransferFrom calldata for this send (engine encoders). */
export function nftTransferCalldata(
  standard: NftStandard,
  from: string,
  to: string,
  tokenId: bigint,
  amount: bigint,
): Uint8Array {
  if (standard === 'erc721') {
    if (amount !== 1n) throw new Error('An ERC-721 token is sent as exactly one item.');
    return encodeErc721SafeTransferFrom(from, to, tokenId);
  }
  return encodeErc1155SafeTransferFrom(from, to, tokenId, amount);
}

/**
 * Parses the ERC-1155 amount field: a whole number of copies (ERC-1155
 * balances are integers; the optional metadata "decimals" is display-only
 * and not used here), at least 1 and at most `balance`. ERC-721 is always 1.
 */
export function parseNftAmount(text: string, standard: NftStandard, balance: bigint): bigint {
  if (standard === 'erc721') return 1n;
  const trimmed = text.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new Error('Enter a whole number of copies (no decimals).');
  }
  const amount = BigInt(trimmed);
  if (amount <= 0n) throw new Error('Amount must be at least 1.');
  if (amount > balance) {
    throw new Error(`You hold ${balance} of this item; you cannot send ${amount}.`);
  }
  return amount;
}

/**
 * NFT quote: the same discipline as prepareErc20Send — endpoint chain-id
 * verification, on-chain ownership/balance check, eth_estimateGas with a
 * documented fallback, ETH-balance-covers-fee check, and the eth_call
 * pre-flight of the exact calldata that will be signed.
 */
export async function prepareNftSend(request: NftSendRequest): Promise<NftSendQuote> {
  const { url, from, to, contract, tokenId, standard, amount, expectedCaip2, nftCaip2 } = request;
  if (nftCaip2 !== expectedCaip2) {
    throw new Error(
      `This NFT is on ${nftCaip2}, but the wallet is on ${expectedCaip2}. ` +
        'Choose the matching test network (or Off for mainnet) in Settings → Developer.',
    );
  }
  const transport = evmHttpTransport(url);
  const node = new NodeClient(transport);
  const data = nftTransferCalldata(standard, from, to, tokenId, amount);

  const [chainId, ethBalance, nonce, fees] = await Promise.all([
    node.chainId(),
    node.getBalance(from),
    node.getTransactionCount(from),
    node.suggestFees(),
  ]);
  const expected = BigInt(expectedCaip2.split(':')[1]!);
  if (chainId !== expected) {
    throw new Error(
      `Endpoint is chain id ${chainId}, expected ${expected}. ` +
        'Check the RPC endpoint (and the test network choice under Settings → Developer) in Settings.',
    );
  }

  const ownedBalance = await fetchNftBalance(transport, standard, contract, tokenId, from);
  if (standard === 'erc721' && ownedBalance === 0n) {
    throw new Error('This account no longer owns this NFT (ownerOf names a different address).');
  }
  if (amount > ownedBalance) {
    throw new Error(
      `This account holds ${ownedBalance} of this item on-chain; you cannot send ${amount}.`,
    );
  }

  let gasLimit: bigint;
  let gasIsFallback = false;
  try {
    gasLimit = await node.estimateGas({ from, to: contract, value: 0n, data: toHex(data) });
  } catch {
    gasLimit = NFT_TRANSFER_GAS_FALLBACK;
    gasIsFallback = true;
  }
  // OP-stack chains only: the L1 data fee of the exact unsigned transaction
  // sendNft will sign, plus the operator fee (send.ts quoteOpStackFees).
  const opStack = chainHasL1DataFee(chainId)
    ? await quoteOpStackFees(transport, {
        chainId,
        nonce,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        maxFeePerGas: fees.maxFeePerGas,
        gasLimit,
        to: contract,
        value: 0n,
        data,
      })
    : undefined;
  const fee = gasLimit * fees.maxFeePerGas + opStackFeeTotal(opStack);
  if (fee > ethBalance) {
    throw new Error(
      `Not enough ETH to pay the network fee: the worst-case fee is ${fee} wei ` +
        `but the ETH balance is ${ethBalance} wei. NFT sends pay gas in ETH.`,
    );
  }

  const simulation = await simulateCall(transport, { from, to: contract, data });

  return {
    kind: 'nft',
    standard,
    to,
    contract,
    tokenId,
    amount,
    ownedBalance,
    ethBalance,
    nonce,
    chainId,
    gasLimit,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    fee,
    data,
    simulation,
    gasIsFallback,
    ...(opStack ? { opStack } : {}),
  };
}

/** ERC-1155 Max: the on-chain balance (gas is paid in ETH, not copies). */
export async function maxNft1155Send(
  url: string,
  from: string,
  contract: string,
  tokenId: bigint,
): Promise<bigint> {
  return fetchNftBalance(evmHttpTransport(url), 'erc1155', contract, tokenId, from);
}

/**
 * Signs and broadcasts through the existing sendEvm path: value 0, `to` =
 * the NFT contract, `data` = the quoted and simulated calldata. No second
 * signing path exists. `explorerTxBase` comes from the active profile.
 */
export async function sendNft(
  url: string,
  signer: DerivedAccount,
  quote: NftSendQuote,
  explorerTxBase: string | null,
): Promise<SendResult> {
  const evmQuote: EvmSendQuote = {
    kind: 'evm',
    to: quote.contract,
    amount: 0n,
    balance: quote.ethBalance,
    nonce: quote.nonce,
    chainId: quote.chainId,
    gasLimit: quote.gasLimit,
    maxFeePerGas: quote.maxFeePerGas,
    maxPriorityFeePerGas: quote.maxPriorityFeePerGas,
    fee: quote.fee,
    total: quote.fee,
    simulation: quote.simulation,
    data: quote.data,
  };
  return sendEvm(url, signer, evmQuote, explorerTxBase);
}

/** Plain-language titles for NFT send failures (falls back to send.ts). */
export function describeNftSendError(error: unknown): { title: string; detail: string } {
  const detail = error instanceof Error ? error.message : String(error);
  if (/no longer owns this NFT|holds \d+ of this item|did not report an owner/i.test(detail)) {
    return { title: 'This account cannot send this NFT right now.', detail };
  }
  if (/This NFT is on /.test(detail)) {
    return { title: 'This NFT belongs to the other network mode.', detail };
  }
  return describeSendError(error, 'ETH');
}
