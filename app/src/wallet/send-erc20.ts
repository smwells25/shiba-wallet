import type { DerivedAccount } from '@shiba-wallet/core';
import {
  NodeClient,
  encodeErc20Transfer,
  httpTransport as evmHttpTransport,
  simulateCall,
  toHex,
  type SimulationResult,
} from '@shiba-wallet/chains-evm';
// Explicit .ts extensions: this module is imported by
// scripts/check-token-send.mjs under Node's type stripping, which resolves
// relative specifiers literally (same pattern as erc20.ts and tokens.ts).
import { EVM_CHAIN_ID, sendEvm, type EvmSendQuote, type SendResult } from './send.ts';
import { fetchErc20Balance } from './erc20.ts';

/**
 * ERC-20 send flow (phase 4, item 3): quoting, max-amount, and sign+
 * broadcast for token transfers on the EOA path. Lives in its own module —
 * not in send.ts — because it needs fetchErc20Balance from erc20.ts, and
 * erc20.ts already imports from send.ts; putting this here keeps the import
 * graph a DAG (send-erc20 -> {send, erc20} -> send) instead of creating a
 * send <-> erc20 cycle whose evaluation order differs between Metro and
 * Node's type stripping.
 *
 * The transaction itself is an ordinary EIP-1559 EOA transaction: value 0,
 * `to` = the token contract, `data` = transfer(recipient, amount) calldata
 * from the engine's encodeErc20Transfer. sendErc20 below reshapes the quote
 * and delegates to send.ts's sendEvm, so the signing/broadcast path is the
 * one already exercised by native sends.
 *
 * Deliberately free of React Native imports so scripts/check-token-send.mjs
 * can exercise this exact code under plain Node with a fake fetch. Amounts
 * are bigints: token amounts in the token's base units, fees in wei.
 *
 * SMART-ACCOUNT NOTE: the ERC-4337 path is deliberately out of scope for
 * token sends in this pass. Batching approve+transfer (or transfer alone)
 * through SmartAccountClient.sendCalls is a later slice; SendScreen hides
 * the smart-account toggle in token mode.
 */

/**
 * Fallback gas limit used only when eth_estimateGas itself reverts (the
 * node executes the transfer to estimate it, so a doomed transfer makes
 * estimation fail too). In that state the pre-flight simulation fails as
 * well and the send is blocked behind the explicit override switch; if the
 * user overrides anyway, this deliberate over-estimate keeps the
 * transaction submittable. Simple ERC-20 transfers observed on mainnet run
 * roughly 35k-80k gas depending on storage-slot state; 100k is headroom
 * above that range, and the unused portion of a gas limit is not charged.
 */
export const ERC20_TRANSFER_GAS_FALLBACK = 100_000n;

/**
 * Detects an ERC-20 transfer() that "succeeded" at the EVM level but
 * returned `false`. The honest quirk handling, in full:
 *
 *  - The ERC-20 standard declares `transfer(address,uint256) returns
 *    (bool)`, and well-behaved tokens either revert on failure or return
 *    the ABI word for true (0x...01).
 *  - Some tokens return `false` (a 32-byte zero word) instead of reverting
 *    when the transfer cannot happen (paused, blocklisted, insufficient
 *    balance in older implementations). For those, the transaction would
 *    be MINED SUCCESSFULLY, charge the full gas fee, and move no tokens —
 *    so a zero-word return from the pre-flight simulation must warn and
 *    block exactly like a revert.
 *  - USDT-style tokens (compiled against an interface with no return
 *    value) return NO data at all: eth_call yields "0x". That is normal
 *    for them and must NOT be treated as failure — on-chain callers only
 *    break on those tokens when they require a decoded bool, which we do
 *    not.
 *
 * Rule implemented: empty return data passes; return data that is nothing
 * but zero bytes is a `false` return and blocks; anything with a non-zero
 * byte (the canonical true word included) passes.
 */
export function erc20TransferReturnedFalse(returnData: string): boolean {
  const hex = returnData.startsWith('0x') ? returnData.slice(2) : returnData;
  if (hex.length === 0) return false; // no return value (USDT-style): fine
  return /^0+$/.test(hex); // all-zero return data decodes to false: block
}

export interface Erc20SendQuote {
  kind: 'erc20';
  /** Final token recipient — the transfer() argument, not the tx `to`. */
  to: string;
  /** Token contract address (EIP-55) — the transaction's `to`. */
  contract: string;
  /** Token symbol and decimals, for display only. */
  symbol: string;
  decimals: number;
  /** Token amount in the token's base units. */
  amount: bigint;
  /** Sender's token balance in base units (via fetchErc20Balance). */
  tokenBalance: bigint;
  /** Sender's ETH balance in wei — gas for a token send is paid in ETH. */
  ethBalance: bigint;
  nonce: bigint;
  chainId: bigint;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** Worst-case fee in WEI: gasLimit * maxFeePerGas. Never token units. */
  fee: bigint;
  /** transfer(recipient, amount) calldata from encodeErc20Transfer. */
  data: Uint8Array;
  /** eth_call pre-flight of the transfer; failure blocks unless overridden. */
  simulation: SimulationResult;
  /** Simulation succeeded but returned false — blocks like a revert. */
  returnedFalse: boolean;
  /** True when gasLimit is ERC20_TRANSFER_GAS_FALLBACK (estimation reverted). */
  gasIsFallback: boolean;
}

export interface Erc20SendRequest {
  url: string;
  from: string;
  /** Validated recipient (EIP-55 normalized by validateRecipient). */
  to: string;
  /** Token contract address from the tracked token's CAIP-19 reference. */
  contract: string;
  /** Token amount in base units (parseUnits with the token's decimals). */
  amount: bigint;
  symbol: string;
  decimals: number;
}

/**
 * ERC-20 quote: same discipline as prepareEvmSend (endpoint chain-id
 * verification, NodeClient fees/nonce, eth_estimateGas, eth_call
 * pre-flight), with the token-specific checks on top: the amount is
 * checked against the sender's token balance, and the worst-case fee —
 * which is paid in ETH, not in the token — is checked against the sender's
 * ETH balance with a plain-language error when it does not cover it.
 */
export async function prepareErc20Send(request: Erc20SendRequest): Promise<Erc20SendQuote> {
  const { url, from, to, contract, amount, symbol, decimals } = request;
  const transport = evmHttpTransport(url);
  const node = new NodeClient(transport);
  const data = encodeErc20Transfer(to, amount);

  const [chainId, ethBalance, tokenBalance, nonce, fees] = await Promise.all([
    node.chainId(),
    node.getBalance(from),
    fetchErc20Balance(url, contract, from),
    node.getTransactionCount(from),
    node.suggestFees(),
  ]);

  const expected = BigInt(EVM_CHAIN_ID.split(':')[1]!);
  if (chainId !== expected) {
    throw new Error(
      `Endpoint is chain id ${chainId}, expected ${expected} (Ethereum mainnet). ` +
        'Check the RPC endpoint in Settings.',
    );
  }

  if (amount > tokenBalance) {
    throw new Error(
      `Sending ${amount} base units of ${symbol} exceeds the token balance ` +
        `of ${tokenBalance} base units.`,
    );
  }

  // Estimation executes the transfer, so a transfer that would revert makes
  // eth_estimateGas revert too. Fall back to a documented over-estimate and
  // let the simulation below surface the actual failure with its decoded
  // reason (the send stays blocked behind the override switch).
  let gasLimit: bigint;
  let gasIsFallback = false;
  try {
    gasLimit = await node.estimateGas({ from, to: contract, value: 0n, data: toHex(data) });
  } catch {
    gasLimit = ERC20_TRANSFER_GAS_FALLBACK;
    gasIsFallback = true;
  }

  const fee = gasLimit * fees.maxFeePerGas;
  if (fee > ethBalance) {
    throw new Error(
      `Not enough ETH to pay the network fee: the worst-case fee is ${fee} wei ` +
        `but the ETH balance is ${ethBalance} wei. Token sends pay gas in ETH, ` +
        `not in ${symbol}.`,
    );
  }

  const simulation = await simulateCall(transport, { from, to: contract, data });
  const returnedFalse = simulation.ok && erc20TransferReturnedFalse(simulation.returnData);

  return {
    kind: 'erc20',
    to,
    contract,
    symbol,
    decimals,
    amount,
    tokenBalance,
    ethBalance,
    nonce,
    chainId,
    gasLimit,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    fee,
    data,
    simulation,
    returnedFalse,
    gasIsFallback,
  };
}

/**
 * Maximum sendable token amount: the full token balance — the fee is paid
 * in ETH, so it never reduces the token amount. What CAN refuse the max is
 * the ETH side: the worst-case fee for transferring the full balance is
 * checked against the ETH balance, and a shortfall throws the same
 * plain-language "Not enough ETH" error the quote uses. Gas is estimated
 * for transfer(recipient, fullBalance) when a validated recipient exists,
 * else for a self-transfer, whose calldata has the identical shape.
 */
export async function maxErc20Send(
  url: string,
  from: string,
  contract: string,
  to?: string,
): Promise<bigint> {
  const node = new NodeClient(evmHttpTransport(url));
  const [ethBalance, tokenBalance, fees] = await Promise.all([
    node.getBalance(from),
    fetchErc20Balance(url, contract, from),
    node.suggestFees(),
  ]);
  if (tokenBalance === 0n) return 0n;

  const data = encodeErc20Transfer(to ?? from, tokenBalance);
  let gasLimit: bigint;
  try {
    gasLimit = await node.estimateGas({ from, to: contract, value: 0n, data: toHex(data) });
  } catch {
    gasLimit = ERC20_TRANSFER_GAS_FALLBACK;
  }
  const fee = gasLimit * fees.maxFeePerGas;
  if (fee > ethBalance) {
    throw new Error(
      `Not enough ETH to pay the network fee: the worst-case fee is ${fee} wei ` +
        `but the ETH balance is ${ethBalance} wei. Token sends pay gas in ETH.`,
    );
  }
  return tokenBalance;
}

/**
 * Signs and broadcasts the token transfer through the existing sendEvm
 * path: value 0, `to` = the token contract, `data` = the transfer calldata
 * quoted (and simulated) above. Reshaping into an EvmSendQuote here means
 * the EIP-1559 signing and broadcast code is byte-for-byte the one native
 * sends use — no second signing path to keep correct.
 */
export async function sendErc20(
  url: string,
  signer: DerivedAccount,
  quote: Erc20SendQuote,
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
  return sendEvm(url, signer, evmQuote);
}
