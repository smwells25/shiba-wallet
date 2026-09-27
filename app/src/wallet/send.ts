import type { DerivedAccount } from '@shiba-wallet/core';
import { toChecksumAddress } from '@shiba-wallet/core';
import {
  NodeClient,
  httpTransport as evmHttpTransport,
  signEip1559,
  simulateCall,
  toBytes,
  type Eip1559Transaction,
  type SimulationResult,
} from '@shiba-wallet/chains-evm';
import {
  BITCOIN,
  DOGECOIN,
  addressToScriptPubKey,
  buildTransfer,
  dustThreshold,
  esploraTransport,
  estimateVsize,
  feeForVsize,
  signAndBroadcast,
  type BuiltTransfer,
  type UtxoNetwork,
  type Utxo,
} from '@shiba-wallet/chains-utxo';
import {
  SolanaRpcClient,
  compileMessage,
  httpTransport as solanaHttpTransport,
  serializeMessage,
  signTransaction as signSolanaTransaction,
  systemTransfer,
  type CompiledMessage,
} from '@shiba-wallet/chains-solana';
import { base58, base64 } from '@scure/base';

/**
 * Send-flow engine glue: recipient validation, fee quoting, max-amount
 * computation, and sign+broadcast, one section per chain family. Every
 * cryptographic or protocol decision lives in the engine packages; this
 * module only wires them to endpoint URLs and turns engine errors into
 * user-facing language.
 *
 * Deliberately free of React Native imports so scripts/test-units.mjs can
 * exercise the validation helpers under plain Node, exactly like
 * balances.ts. All network state (endpoint URLs) is passed in by the
 * caller; nothing here reads configuration.
 *
 * Amounts are bigints in base units (wei / satoshi / lamport) end to end.
 */

/** CAIP-2 ids of the launch chains, matching src/config/defaults.ts. */
export const EVM_CHAIN_ID = 'eip155:1';
export const BITCOIN_CHAIN_ID = 'bip122:000000000019d6689c085ae165831e93';
export const DOGECOIN_CHAIN_ID = 'bip122:1a91e3dace36e2be3bf030a65679fe82';
export const SOLANA_CHAIN_ID = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

// ---------------------------------------------------------------------------
// Recipient validation (engine code does the real work in every branch)
// ---------------------------------------------------------------------------

export type RecipientValidation =
  | { ok: true; normalized: string; note?: string }
  | { ok: false; error: string };

function utxoNetworkFor(chainId: string): UtxoNetwork | undefined {
  if (chainId === BITCOIN_CHAIN_ID) return BITCOIN;
  if (chainId === DOGECOIN_CHAIN_ID) return DOGECOIN;
  return undefined;
}

/**
 * EVM address validation with EIP-55 handling, using core's
 * toChecksumAddress as the single source of truth:
 *  - all-lowercase (or all-uppercase) hex carries no checksum and is
 *    accepted, normalized to the checksummed form;
 *  - mixed-case input must match the EIP-55 checksum exactly, otherwise it
 *    is rejected — a failed checksum means at least one character is wrong.
 */
function validateEvmRecipient(address: string): RecipientValidation {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return {
      ok: false,
      error: 'An Ethereum address is 0x followed by exactly 40 hex characters.',
    };
  }
  const hex = address.slice(2);
  const checksummed = toChecksumAddress(toBytes(address.toLowerCase()));
  if (hex === hex.toLowerCase() || hex === hex.toUpperCase()) {
    // No checksum information present; accept and normalize.
    return { ok: true, normalized: checksummed, note: 'Address had no checksum; normalized.' };
  }
  if (address !== checksummed) {
    return {
      ok: false,
      error:
        'Bad EIP-55 checksum: the capitalization of this address does not ' +
        'match its checksum, so at least one character is mistyped.',
    };
  }
  return { ok: true, normalized: address };
}

/** Solana: a recipient is any base58 string decoding to 32 bytes. */
function validateSolanaRecipient(address: string): RecipientValidation {
  let decoded: Uint8Array;
  try {
    decoded = base58.decode(address);
  } catch {
    return { ok: false, error: 'Not a valid base58 Solana address.' };
  }
  if (decoded.length !== 32) {
    return {
      ok: false,
      error: `A Solana address decodes to 32 bytes; this one is ${decoded.length}.`,
    };
  }
  return { ok: true, normalized: address };
}

/**
 * Validates a recipient address for one launch chain. UTXO chains go
 * through chains-utxo's addressToScriptPubKey (the same decode the real
 * transaction output uses, so validation can never diverge from what gets
 * signed); its specific error messages (wrong network, taproot unsupported,
 * bad version byte) are surfaced verbatim.
 */
export function validateRecipient(chainId: string, rawAddress: string): RecipientValidation {
  const address = rawAddress.trim();
  if (address === '') return { ok: false, error: 'Enter a recipient address.' };
  if (chainId === EVM_CHAIN_ID) return validateEvmRecipient(address);
  if (chainId === SOLANA_CHAIN_ID) return validateSolanaRecipient(address);
  const network = utxoNetworkFor(chainId);
  if (network) {
    try {
      addressToScriptPubKey(address, network);
      return { ok: true, normalized: address };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Invalid address.' };
    }
  }
  return { ok: false, error: `Sending is not supported for chain ${chainId}.` };
}

// ---------------------------------------------------------------------------
// Quotes (fee preview + everything the confirm screen shows)
// ---------------------------------------------------------------------------

export interface EvmSendQuote {
  kind: 'evm';
  to: string;
  amount: bigint;
  balance: bigint;
  nonce: bigint;
  chainId: bigint;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** Worst-case fee: gasLimit * maxFeePerGas. Actual fee is usually lower. */
  fee: bigint;
  total: bigint;
  /** eth_call pre-flight result; a failure blocks the send unless overridden. */
  simulation: SimulationResult;
}

export interface UtxoSendQuote {
  kind: 'utxo';
  to: string;
  amount: bigint;
  balance: bigint;
  feeRate: number;
  /** Esplora confirmation target (blocks) the fee rate was taken from. */
  feeTarget: number;
  fee: bigint;
  total: bigint;
  built: BuiltTransfer;
}

export interface SolSendQuote {
  kind: 'sol';
  to: string;
  amount: bigint;
  balance: bigint;
  fee: bigint;
  /**
   * True when getFeeForMessage returned null and the long-standing default
   * of 5000 lamports per signature was used instead.
   */
  feeIsFallback: boolean;
  total: bigint;
}

export type SendQuote = EvmSendQuote | UtxoSendQuote | SolSendQuote;

/**
 * EVM quote: verifies the endpoint really is the expected chain (a user
 * override pointing at a testnet or the wrong chain must not produce a
 * signable mainnet transaction), fetches balance/nonce/fees, estimates
 * gas, and runs the eth_call pre-flight simulation.
 *
 * Fees per NodeClient.suggestFees (latest base fee doubled + node priority
 * fee); gas via eth_estimateGas. When estimateGas rejects because the
 * amount+fee exceeds the balance, it is retried with value 0 — intrinsic
 * gas for a transfer does not depend on the value, and the insufficient
 * funds condition is reported separately via the simulation/balance checks.
 */
export async function prepareEvmSend(
  url: string,
  from: string,
  to: string,
  amount: bigint,
): Promise<EvmSendQuote> {
  const transport = evmHttpTransport(url);
  const node = new NodeClient(transport);

  const [chainId, balance, nonce, fees] = await Promise.all([
    node.chainId(),
    node.getBalance(from),
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

  let gasLimit: bigint;
  try {
    gasLimit = await node.estimateGas({ from, to, value: amount });
  } catch {
    gasLimit = await node.estimateGas({ from, to, value: 0n });
  }

  const fee = gasLimit * fees.maxFeePerGas;
  if (amount + fee > balance) {
    throw new Error(
      `Insufficient funds: sending ${amount} wei plus a worst-case fee of ${fee} wei ` +
        `exceeds the balance of ${balance} wei`,
    );
  }

  const simulation = await simulateCall(transport, { from, to, value: amount });

  return {
    kind: 'evm',
    to,
    amount,
    balance,
    nonce,
    chainId,
    gasLimit,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    fee,
    total: amount + fee,
    simulation,
  };
}

/**
 * The maximum sendable amount for an EVM account: balance minus the
 * worst-case fee (gasLimit * maxFeePerGas) for a plain transfer.
 */
export async function maxEvmSend(url: string, from: string, to?: string): Promise<bigint> {
  const node = new NodeClient(evmHttpTransport(url));
  const [balance, fees] = await Promise.all([node.getBalance(from), node.suggestFees()]);
  // Value does not change a transfer's intrinsic gas; estimate with 0 so
  // the call cannot fail for lack of funds. Falls back to the sender
  // itself when no recipient is typed yet (an EOA-to-EOA transfer).
  const gasLimit = await node.estimateGas({ from, to: to ?? from, value: 0n });
  const max = balance - gasLimit * fees.maxFeePerGas;
  return max > 0n ? max : 0n;
}

/** Shape of Esplora's GET /fee-estimates: { "<target blocks>": sat/vB }. */
type FeeEstimates = Record<string, number>;

/**
 * Fee rate from Esplora's GET /fee-estimates endpoint, which returns "an
 * object where the key is the confirmation target (in number of blocks)
 * and the value is the estimated feerate (in sat/vB)" (Esplora HTTP API
 * documentation, github.com/Blockstream/esplora API.md; targets 1-25, 144,
 * 504, 1008). Prefers a 3-block target, falling back to the nearest
 * available one, floored at 1 sat/vB (Esplora reports 1.0 minimum anyway).
 */
export async function fetchUtxoFeeRate(
  url: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ feeRate: number; target: number }> {
  const base = url.replace(/\/$/, '');
  const response = await fetchFn(`${base}/fee-estimates`);
  if (!response.ok) {
    throw new Error(`Fee estimate fetch failed: HTTP ${response.status} from /fee-estimates`);
  }
  const estimates = (await response.json()) as FeeEstimates;
  const targets = Object.keys(estimates)
    .map(Number)
    .filter((t) => Number.isFinite(t) && t > 0 && Number.isFinite(estimates[String(t)]))
    .sort((a, b) => a - b);
  if (targets.length === 0) {
    throw new Error('Endpoint returned no usable fee estimates (/fee-estimates was empty).');
  }
  const target =
    targets.find((t) => t >= 3) ?? targets[targets.length - 1]!;
  const feeRate = Math.max(1, estimates[String(target)]!);
  return { feeRate, target };
}

/**
 * UTXO quote: fetches the sender's UTXOs and a fee rate, then runs the
 * engine's buildTransfer (coin selection + dust rules) to get the exact
 * fee the signed transaction will pay. The BuiltTransfer is kept in the
 * quote and signed as-is at confirm time, so the fee shown is the fee paid.
 */
export async function prepareUtxoSend(
  url: string,
  network: UtxoNetwork,
  fromAddress: string,
  to: string,
  amount: bigint,
): Promise<UtxoSendQuote> {
  const transport = esploraTransport(url);
  const [utxos, { feeRate, target }] = await Promise.all([
    transport.getUtxos(fromAddress),
    fetchUtxoFeeRate(url),
  ]);
  const balance = utxos.reduce((sum, u) => sum + u.value, 0n);
  // The engine dust-checks the change output inside coin selection; the
  // recipient output is checked here, before building, because a sub-dust
  // payment would be refused by the network's relay policy.
  const toScript = addressToScriptPubKey(to, network);
  const dust = dustThreshold(toScript);
  if (amount < dust) {
    throw new Error(
      `Amount is below the dust limit for this address type (${dust} sat): ` +
        'the network would not relay it.',
    );
  }
  const built = buildTransfer({ network, fromAddress, utxos, toAddress: to, amount, feeRate });
  return {
    kind: 'utxo',
    to,
    amount,
    balance,
    feeRate,
    feeTarget: target,
    fee: built.fee,
    total: amount + built.fee,
    built,
  };
}

/**
 * Maximum sendable UTXO amount: everything minus the fee for spending all
 * UTXOs into a single output paying the (validated) recipient. Computed
 * with the engine's own size/fee arithmetic, then verified by iterating
 * buildTransfer — the returned amount is only accepted once buildTransfer
 * succeeds with exactly that amount, stepping down if a boundary case
 * (fee rounding) makes the first candidate infeasible.
 */
export async function maxUtxoSend(
  url: string,
  network: UtxoNetwork,
  fromAddress: string,
  to: string,
): Promise<{ amount: bigint; utxos: Utxo[] }> {
  const transport = esploraTransport(url);
  const [utxos, { feeRate }] = await Promise.all([
    transport.getUtxos(fromAddress),
    fetchUtxoFeeRate(url),
  ]);
  if (utxos.length === 0) throw new Error('No spendable coins on this address.');
  const total = utxos.reduce((sum, u) => sum + u.value, 0n);

  const inputScript = addressToScriptPubKey(fromAddress, network);
  const inputKind = inputScript.length === 22 ? 'p2wpkh' : 'p2pkh';
  const toScript = addressToScriptPubKey(to, network);
  const sweepFee = feeForVsize(estimateVsize(inputKind, utxos.length, [toScript]), feeRate);

  let amount = total - sweepFee;
  // Verification loop: candidate must build. Steps down at most a few
  // satoshis around integer fee-rounding boundaries.
  for (let i = 0; i < 8 && amount > 0n; i++) {
    try {
      buildTransfer({ network, fromAddress, utxos, toAddress: to, amount, feeRate });
      return { amount, utxos };
    } catch {
      amount -= 1n;
    }
  }
  throw new Error('Balance is too small to cover the network fee.');
}

const LAMPORTS_PER_SIGNATURE_FALLBACK = 5000n;

function solanaMessageFor(
  fromPublicKey: Uint8Array,
  to: string,
  lamports: bigint,
  recentBlockhash: string,
): CompiledMessage {
  return compileMessage({
    feePayer: fromPublicKey,
    recentBlockhash,
    instructions: [
      systemTransfer({ from: fromPublicKey, to: base58.decode(to), lamports }),
    ],
  });
}

/**
 * Solana quote. The fee comes from the getFeeForMessage RPC method, called
 * through the same injected-transport pattern as SolanaRpcClient's own
 * methods. Per the official reference (solana.com/docs/rpc/http/
 * getfeeformessage, fetched 2026-09-27): params are the base64-encoded
 * message plus an optional { commitment } config, and the result value is
 * the fee in lamports as a u64 — or null when the blockhash is no longer
 * valid, in which case the long-standing default of 5000 lamports per
 * signature is shown, flagged as an estimate.
 */
export async function prepareSolSend(
  url: string,
  fromAddress: string,
  to: string,
  lamports: bigint,
): Promise<SolSendQuote> {
  // A Solana address is the base58 encoding of the 32-byte public key, so
  // the sender's key comes straight from the displayed address.
  const fromPublicKey = base58.decode(fromAddress);
  const transport = solanaHttpTransport(url);
  const client = new SolanaRpcClient(transport);
  const [{ blockhash }, balance] = await Promise.all([
    client.getLatestBlockhash('confirmed'),
    client.getBalance(fromAddress, 'confirmed'),
  ]);
  const message = solanaMessageFor(fromPublicKey, to, lamports, blockhash);
  const result = (await transport('getFeeForMessage', [
    base64.encode(serializeMessage(message)),
    { commitment: 'confirmed' },
  ])) as { value: number | null } | null;
  const feeIsFallback = result?.value === null || result?.value === undefined;
  const fee = feeIsFallback
    ? LAMPORTS_PER_SIGNATURE_FALLBACK * BigInt(message.header.numRequiredSignatures)
    : BigInt(result!.value!);
  const total = lamports + fee;
  if (total > balance) {
    throw new Error(
      `Insufficient funds: sending ${lamports} lamports plus the ${fee} lamport fee ` +
        `exceeds the balance of ${balance} lamports`,
    );
  }
  return { kind: 'sol', to, amount: lamports, balance, fee, feeIsFallback, total };
}

/**
 * Maximum sendable lamports: balance minus the fee. The fee is quoted for
 * a self-transfer of 0 lamports — a message with the identical shape and
 * signature count as the real transfer, and Solana fees depend only on
 * signatures, not on the recipient or the amount.
 */
export async function maxSolSend(url: string, fromAddress: string): Promise<bigint> {
  const quote = await prepareSolSend(url, fromAddress, fromAddress, 0n);
  const max = quote.balance - quote.fee;
  return max > 0n ? max : 0n;
}

// ---------------------------------------------------------------------------
// Execution (sign + broadcast) — called only after the biometric gate
// ---------------------------------------------------------------------------

export interface SendResult {
  /** Transaction hash (EVM), txid (UTXO) or signature (Solana). */
  txid: string;
  /** Plain https block-explorer link, or null when none is verified. */
  explorerUrl: string | null;
}

/**
 * Signs and broadcasts an EOA EIP-1559 transfer through chains-evm.
 *
 * SMART-ACCOUNT SEAM: when a bundler endpoint is configured (phase 2 task
 * 3 pins the vendor config), this is the point where the flow forks — the
 * same quote's to/amount become a Call for SmartAccountClient.sendUserOp
 * (chains-evm), the signer stays the same seed-derived owner key, and the
 * quote gains paymaster fields. Everything before this function (recipient
 * validation, amount parsing, confirm UI) is path-agnostic by design.
 */
export async function sendEvm(
  url: string,
  signer: DerivedAccount,
  quote: EvmSendQuote,
): Promise<SendResult> {
  const tx: Eip1559Transaction = {
    chainId: quote.chainId,
    nonce: quote.nonce,
    maxPriorityFeePerGas: quote.maxPriorityFeePerGas,
    maxFeePerGas: quote.maxFeePerGas,
    gasLimit: quote.gasLimit,
    to: quote.to,
    value: quote.amount,
  };
  const signed = signEip1559(tx, signer);
  const node = new NodeClient(evmHttpTransport(url));
  const txid = await node.sendRawTransaction(signed.rawHex);
  return { txid, explorerUrl: `https://etherscan.io/tx/${txid}` };
}

/**
 * Signs the quoted BuiltTransfer and broadcasts it via the Esplora
 * transport. chains-utxo cross-checks the backend's txid against the
 * locally computed one. Explorer link only for Bitcoin: no Dogecoin
 * explorer has been verified for this wallet yet, so the txid is shown
 * without a link there.
 */
export async function sendUtxo(
  url: string,
  chainId: string,
  signer: DerivedAccount,
  quote: UtxoSendQuote,
): Promise<SendResult> {
  const txid = await signAndBroadcast(quote.built, signer, esploraTransport(url));
  const explorerUrl =
    chainId === BITCOIN_CHAIN_ID ? `https://blockstream.info/tx/${txid}` : null;
  return { txid, explorerUrl };
}

/**
 * Compiles a fresh message (new blockhash — the one quoted may have aged
 * past its validity window while the user read the confirm screen), signs
 * it, and broadcasts. The fee is per-signature and does not depend on the
 * blockhash, so the quoted fee stays accurate.
 */
export async function sendSol(
  url: string,
  signer: DerivedAccount,
  quote: SolSendQuote,
): Promise<SendResult> {
  const client = new SolanaRpcClient(solanaHttpTransport(url));
  const { blockhash } = await client.getLatestBlockhash('confirmed');
  const message = solanaMessageFor(signer.publicKey, quote.to, quote.amount, blockhash);
  const signed = signSolanaTransaction(message, [
    { publicKey: signer.publicKey, sign: (bytes) => signer.sign(bytes) },
  ]);
  const signature = await client.sendTransaction(signed.wireBytes);
  return { txid: signature, explorerUrl: `https://solscan.io/tx/${signature}` };
}

// ---------------------------------------------------------------------------
// Error translation
// ---------------------------------------------------------------------------

/**
 * Turns engine/RPC errors into plain language for the send screen, keeping
 * the original message as detail because it names the exact protocol-level
 * failure (dust threshold, insufficient funds arithmetic, node rejection).
 */
export function describeSendError(error: unknown, symbol: string): { title: string; detail: string } {
  const detail = error instanceof Error ? error.message : String(error);
  if (/insufficient funds/i.test(detail)) {
    return {
      title: `Not enough ${symbol} to cover this amount plus the network fee.`,
      detail,
    };
  }
  if (/dust/i.test(detail)) {
    return {
      title: 'Amount is below the dust limit — the network would refuse to relay it.',
      detail,
    };
  }
  if (/blockhash/i.test(detail)) {
    return { title: 'The network quote expired. Please review and try again.', detail };
  }
  return { title: 'The transaction could not be sent.', detail };
}
