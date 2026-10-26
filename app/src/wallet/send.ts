import type { DerivedAccount } from '@shiba-wallet/core';
import { toChecksumAddress } from '@shiba-wallet/core';
import {
  NodeClient,
  decodeUint256,
  encodeFunctionCall,
  httpTransport as evmHttpTransport,
  minimalBytes,
  recoverEip1559Signer,
  rlpEncode,
  serializeSignedEip1559,
  signEip1559,
  simulateCall,
  toBytes,
  toHex,
  type Eip1559Signature,
  type Eip1559Transaction,
  type JsonRpcTransport,
  type SimulationResult,
} from '@shiba-wallet/chains-evm';
import {
  BITCOIN,
  DOGECOIN,
  addressToScriptPubKey,
  blockbookTransport,
  buildTransfer,
  dustThreshold,
  esploraTransport,
  estimateVsize,
  feeForVsize,
  signAndBroadcast,
  type BuiltTransfer,
  type UtxoNetwork,
  type UtxoTransport,
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
// Explicit .ts extension: this module is loaded directly by Node scripts
// under type stripping, which resolves relative specifiers literally.
// balances.ts imports nothing from this module, so the graph stays a DAG.
import { parseUnits } from './balances.ts';
// Type-free helper only; endpoint-probe.ts has no React Native imports.
import { endpointHost, isEndpointFailure, sanitizeEndpointMessage } from '../config/endpoint-probe.ts';
// Pure data with no imports (see its file comment), so no cycle.
import { evmProfileByCaip2 } from '../config/evm-chain.ts';
import { isRetryableFeeReadError, suggestFeesRetryingOnce } from './fee-read.ts';
// readiness.ts imports only config/evm-chain.ts, so no cycle.
import { isTestNetwork } from '../config/readiness.ts';
// pending-transactions.ts imports only types from this module, so the graph
// stays a DAG (send.ts → pending-transactions.ts).
import {
  REPLACEMENT_FEES_STALE,
  REPLACEMENT_QUOTE_USED,
  REPLACEMENT_UNDERPRICED_SENTENCE,
  alreadyIncludedSentence,
  groupStatus,
  meetsReplacementRule,
  nodeReader,
  nonceUsedSentence,
  forgetPendingTransaction,
  pooledFees,
  recordPendingTransactionBeforeBroadcast,
  replacementFees,
  txRecordFromQuote,
  type NonceGroup,
  type PendingStore,
  type PendingTxRecord,
  type ReplacementAction,
  type ReplacementFees,
} from './pending-transactions.ts';
// broadcast-outcome.ts imports only the engine and pending-transactions.ts.
import {
  BroadcastAlreadyHandedOverError,
  BroadcastOutcomeUnknownError,
  describeBroadcastOutcome,
  isBroadcastOutcomeUnknown,
} from './broadcast-outcome.ts';

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
  /**
   * Worst-case fee: gasLimit * maxFeePerGas, plus — on OP-stack chains only
   * — the reserved layer 1 data fee and the worst-case operator fee
   * (`opStack` below). Actual fee is usually lower.
   */
  fee: bigint;
  total: bigint;
  /** eth_call pre-flight result; a failure blocks the send unless overridden. */
  simulation: SimulationResult;
  /**
   * Optional calldata (WalletConnect eth_sendTransaction requests carry
   * contract-call data; the app's own plain transfers leave it unset).
   */
  data?: Uint8Array;
  /**
   * OP-stack fee parts (Base Sepolia), already included in `fee` and
   * `total`. Absent on chains without an L1 data fee (Ethereum mainnet and
   * Sepolia), whose quotes are unchanged.
   */
  opStack?: OpStackFees;
  /**
   * Present only when the amount came from the Max button
   * (PrepareEvmSendOptions.fromMax) and the fees had risen since the Max
   * figure was computed, so the quote lowered the amount to the balance
   * minus the current worst-case fee. `requested` is the amount the form
   * held; `amount` above is what will be signed. The confirm screen states
   * the change in a plain sentence (maxAdjustmentSentence). Absent in every
   * other case, so quotes without an adjustment are unchanged.
   */
  maxAdjustment?: { requested: bigint };
  /**
   * Present only on a minimum-fee rehearsal quote (Settings → Developer, test
   * networks only; see MINIMUM_FEE_REHEARSAL_SWITCH_LABEL below): the fees
   * above are then exactly a max fee of 1 wei and a priority fee of 1 wei,
   * and this records the base fee read at quote time for the confirm's
   * sentence. Absent on every other quote, which is unchanged.
   */
  minimumFee?: MinimumFeeRehearsal;
}

/** Options for prepareEvmSend beyond the positional arguments. */
export interface PrepareEvmSendOptions {
  /**
   * True when the amount is exactly the figure the Max button produced for
   * this account (SendScreen compares the amount text with the last Max
   * result). Fees are re-read at quote time, and on OP-stack chains the
   * layer 1 data fee follows Ethereum's fees from block to block, so the
   * worst-case fee can rise between the Max tap and Review. With this flag
   * the quote then lowers the amount to balance minus the current
   * worst-case fee and records the change in `maxAdjustment`, instead of
   * refusing the user's own Max. The amount is only ever lowered, never
   * raised, and the balance check below still applies to the result.
   */
  fromMax?: boolean;
  /**
   * The Send screen's minimum-fee rehearsal (Settings → Developer): price
   * this quote at a max fee of 1 wei and a priority fee of 1 wei per gas,
   * below the base fee, so no block can include it (EIP-1559) and it waits
   * in the pool until it is sped up or cancelled from Activity. Honoured only when the endpoint's
   * VERIFIED chain is a test network (config/readiness.ts isTestNetwork); on
   * any other network the option is ignored and the ordinary quote is
   * returned, without the `minimumFee` marker. Only the Send screen's
   * regular-account native send passes it; smart-account quotes (aa.ts)
   * never read it.
   */
  minimumFee?: boolean;
}

// ---------------------------------------------------------------------------
// Minimum-fee rehearsal (phase 21 item 3): an under-priced send on purpose
// ---------------------------------------------------------------------------
//
// The rehearsal must produce a transaction that STAYS pending, so the
// Activity card's Speed up and Cancel can be exercised. EIP-1559 (Final;
// ethereum/EIPs EIPS/eip-1559.md, last changed at ba6c342c, read 2026-10-15)
// makes a block invalid if it includes a transaction whose max fee is below
// the block's base fee:
//
//     # ensure that the user was willing to at least pay the base fee
//     assert transaction.max_fee_per_gas >= block.base_fee_per_gas
//
// The first version priced the max fee at the latest base fee + 1 wei, which
// a block can include; on Sepolia (blocks about a third full, base fee 16
// wei) such a send was mined in the next block (emulator pass p21c). A max
// fee of 1 wei, below the base fee, cannot be included while the base fee is
// above 1 wei (the phase-19 script's originals, at max fees of 1 and 7 wei
// against a 14-wei base fee, stayed pending until replaced). The speed-up and the cancellation of such a transaction
// are priced by prepareEvmReplacement at the node's current suggestion
// (base fee × 2 + the node's priority fee), which is never below the base
// fee and is far above the 10% / +1 wei replacement minimum of 2 / 2 wei.

/** The max fee of a minimum-fee rehearsal quote: 1 wei per gas. */
export const MINIMUM_FEE_MAX_FEE_WEI = 1n;

/** The priority fee of a minimum-fee rehearsal quote: 1 wei per gas. */
export const MINIMUM_FEE_PRIORITY_WEI = 1n;

/** What a minimum-fee rehearsal quote was priced from. */
export interface MinimumFeeRehearsal {
  /**
   * The latest block's base fee read at quote time. The fees do not depend on
   * it (always 1 / 1 wei); the confirm's sentence says whether 1 wei is below it.
   */
  baseFeePerGas: bigint;
}

/** Settings → Developer: the switch's label. */
export const MINIMUM_FEE_REHEARSAL_SWITCH_LABEL =
  'Send the next regular-account transaction at the minimum fee (to rehearse Speed up / Cancel)';

/** Settings → Developer: the note under the switch. */
export const MINIMUM_FEE_REHEARSAL_HINT =
  'Test networks only. The next native-coin or token send from the Send screen, with the smart account off, ' +
  'is priced at a max fee of 1 wei and a priority fee of 1 wei per gas. A block can include a transaction only ' +
  'if its max fee is at least the block’s base fee, so while the base fee is above 1 wei this one stays in the ' +
  'network’s pool until you speed it up or cancel it from Activity; the speed-up or cancellation is priced at ' +
  'the node’s normal fee suggestion, so a block can include it. The option turns itself off ' +
  'once that transaction is sent; going back from the confirm screen leaves it on, and it is off again whenever ' +
  'the app restarts. NFT sends, swaps, staking, app requests and smart-account operations are always priced ' +
  'normally. The node may refuse such an under-priced transaction outright ("transaction underpriced"); that ' +
  'is expected, because the nodes behind one endpoint address can apply different minimums, and the option ' +
  'then stays on until a send goes through or you turn it off. On the layer-2 test networks the transaction ' +
  'goes to the network’s sequencer, which may refuse it rather than hold it; that has not been tried.';

/** The Send confirm's warning on a minimum-fee rehearsal quote. */
export const MINIMUM_FEE_REHEARSAL_WARNING =
  'Minimum-fee rehearsal: this transaction offers a max fee of only 1 wei per gas, so while the network’s base ' +
  'fee is above that it stays pending until you speed it up or cancel it from Activity. The node may also ' +
  'refuse it outright.';

/** The network the rehearsal is armed for (CAIP-2), or null. Memory only: a restart turns it off. */
let minimumFeeArmedFor: string | null = null;
const minimumFeeListeners = new Set<() => void>();

function notifyMinimumFeeListeners(): void {
  for (const listener of [...minimumFeeListeners]) {
    try {
      listener();
    } catch {
      // Display refresh only.
    }
  }
}

/** True where the rehearsal may be offered: a test network (readiness isTestNetwork), never a main network. */
export function minimumFeeRehearsalOffered(caip2: string): boolean {
  return isTestNetwork(caip2);
}

/**
 * Turns the rehearsal on (for `caip2`) or off. Refused on a network that is
 * not a test network: the state stays off and false is returned. Returns
 * whether the rehearsal is now armed for `caip2`.
 */
export function setMinimumFeeRehearsal(caip2: string, on: boolean): boolean {
  // Off is off for every network; on is only ever for a test network.
  const next = on && minimumFeeRehearsalOffered(caip2) ? caip2 : null;
  if (next !== minimumFeeArmedFor) {
    minimumFeeArmedFor = next;
    notifyMinimumFeeListeners();
  }
  return minimumFeeRehearsalArmed(caip2);
}

/** True when the next regular-account send on `caip2` is to be priced at the minimum fee. */
export function minimumFeeRehearsalArmed(caip2: string): boolean {
  return minimumFeeArmedFor !== null && minimumFeeArmedFor === caip2 && minimumFeeRehearsalOffered(caip2);
}

/** For React's useSyncExternalStore. Returns the unsubscribe function. */
export function subscribeMinimumFeeRehearsal(listener: () => void): () => void {
  minimumFeeListeners.add(listener);
  return () => {
    minimumFeeListeners.delete(listener);
  };
}

/** The rehearsal facts of a quote (EVM or ERC-20), or null for an ordinary quote. */
export function minimumFeeRehearsalOf(quote: object | null | undefined): MinimumFeeRehearsal | null {
  const facts = (quote as { minimumFee?: unknown } | null | undefined)?.minimumFee;
  return facts && typeof facts === 'object' && typeof (facts as MinimumFeeRehearsal).baseFeePerGas === 'bigint'
    ? (facts as MinimumFeeRehearsal)
    : null;
}

/**
 * One-shot: called by the Send screen once a quote was SENT (the node
 * accepted it). A rehearsal quote turns the option off; an ordinary quote
 * changes nothing. A cancelled confirm never calls this, so the option stays
 * on. Returns true when it turned the option off.
 */
export function consumeMinimumFeeRehearsal(quote: object | null | undefined): boolean {
  if (minimumFeeRehearsalOf(quote) === null || minimumFeeArmedFor === null) return false;
  minimumFeeArmedFor = null;
  notifyMinimumFeeListeners();
  return true;
}

/**
 * The confirm's fee line on a rehearsal quote (exact wei). It says the
 * transaction cannot be included only when that is true of the base fee read
 * at quote time (EIP-1559: a block may include it only if max fee >= base
 * fee); when the base fee is not above the max fee it says a block may
 * include it at once.
 */
export function minimumFeeRehearsalFeeLine(quote: {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  minimumFee?: MinimumFeeRehearsal;
}): string {
  const base = quote.minimumFee?.baseFeePerGas;
  const priced =
    `Priced at the minimum fee: a max fee of ${quote.maxFeePerGas} wei and a priority fee of ` +
    `${quote.maxPriorityFeePerGas} wei per gas`;
  if (base === undefined) return `${priced}.`;
  if (base > quote.maxFeePerGas) {
    return (
      `${priced}, below the latest block's base fee (${base} wei), so no block can include it until you ` +
      'speed it up or cancel it.'
    );
  }
  return (
    `${priced}. The latest block's base fee (${base} wei) is not above that, so a block may include it at once ` +
    'and it may never show as pending.'
  );
}

/** The latest block's base fee, with fee-read.ts's single same-endpoint retry on HTTP 400. */
async function readLatestBaseFee(transport: JsonRpcTransport): Promise<bigint> {
  const read = async () => {
    const block = (await transport('eth_getBlockByNumber', ['latest', false])) as { baseFeePerGas?: string } | null;
    if (!block?.baseFeePerGas) throw new Error('Node returned no baseFeePerGas; chain may not support EIP-1559');
    return BigInt(block.baseFeePerGas);
  };
  try {
    return await read();
  } catch (error) {
    if (!isRetryableFeeReadError(error)) throw error;
    return read();
  }
}

/**
 * The rehearsal's fees: max fee 1 wei and priority fee 1 wei, below the base
 * fee on purpose (see the section comment). The base fee is read only for the
 * confirm's sentence.
 */
async function minimumFees(
  transport: JsonRpcTransport,
): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; baseFeePerGas: bigint }> {
  const baseFeePerGas = await readLatestBaseFee(transport);
  return {
    maxFeePerGas: MINIMUM_FEE_MAX_FEE_WEI,
    maxPriorityFeePerGas: MINIMUM_FEE_PRIORITY_WEI,
    baseFeePerGas,
  };
}

/** The fields of a regular-account token quote (send-erc20.ts Erc20SendQuote) the rehearsal re-prices. */
export interface MinimumFeeRepriceable {
  chainId: bigint;
  nonce: bigint;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  fee: bigint;
  ethBalance: bigint;
  opStack?: OpStackFees;
}

/**
 * The token-send half of the rehearsal: re-prices a regular-account ERC-20
 * quote (send-erc20.ts prepareErc20Send, which takes no options) at the
 * minimum fee, for the exact unsigned transaction sendErc20 will sign (`tx`:
 * the token contract, value 0, the transfer calldata). On a network that is
 * not a test network (the quote's verified chain id) the quote is returned
 * unchanged. The worst-case fee is recomputed (gas × the new max fee, plus
 * the OP-stack layer 1 fee re-read for the re-priced bytes) and checked
 * against the fee coin balance like the original.
 */
export async function repriceTokenQuoteAtMinimumFee<Q extends MinimumFeeRepriceable>(
  url: string,
  quote: Q,
  tx: { to: string; value: bigint; data: Uint8Array },
  options: { transport?: JsonRpcTransport } = {},
): Promise<Q | (Q & { minimumFee: MinimumFeeRehearsal })> {
  if (!minimumFeeRehearsalOffered(`eip155:${quote.chainId}`)) return quote;
  const transport = options.transport ?? evmHttpTransport(url);
  const fees = await minimumFees(transport);
  const opStack = chainHasL1DataFee(quote.chainId)
    ? await quoteOpStackFees(transport, {
        chainId: quote.chainId,
        nonce: quote.nonce,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        maxFeePerGas: fees.maxFeePerGas,
        gasLimit: quote.gasLimit,
        to: tx.to,
        value: tx.value,
        ...(tx.data.length > 0 ? { data: tx.data } : {}),
      })
    : undefined;
  const fee = quote.gasLimit * fees.maxFeePerGas + opStackFeeTotal(opStack);
  if (fee > quote.ethBalance) {
    const feeSymbol = feeSymbolForChain(quote.chainId);
    throw new Error(
      `Not enough ${feeSymbol} to pay the network fee: the worst-case fee is ${fee} wei ` +
        `but the ${feeSymbol} balance is ${quote.ethBalance} wei.`,
    );
  }
  const { opStack: _previous, ...rest } = quote;
  void _previous;
  return {
    ...(rest as Q),
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    fee,
    ...(opStack ? { opStack } : {}),
    minimumFee: { baseFeePerGas: fees.baseFeePerGas },
  };
}

/**
 * Upper bound on re-pricing rounds when a Max amount is lowered on an
 * OP-stack chain. Lowering the value changes the unsigned transaction's
 * bytes, and the oracle prices those bytes, so the layer 1 data fee is
 * re-read for the exact transaction that will be signed. A smaller value
 * never has a longer encoding, so one round is normally enough; the bound
 * only stops a misbehaving oracle from looping. After it the ordinary
 * insufficient-funds refusal applies.
 */
const MAX_TRIM_ROUNDS = 3;

/**
 * The intrinsic gas of the cheapest possible transaction (21,000; the
 * Ethereum yellow paper's G_transaction, charged to every transaction). A
 * lower bound for any transaction's gas, used only for the payable-call
 * balance pre-check in prepareEvmSend, where a lower bound guarantees the
 * pre-check never refuses a transaction the balance could pay for.
 */
const MIN_TRANSACTION_GAS = 21_000n;

/** What SendScreen remembers about the last Max result (public data only). */
export interface LastMaxResult {
  /** The amount text the Max button wrote into the form. */
  text: string;
  /** The account the Max figure was computed for. */
  from: string;
  /** The route's chain id (CAIP-2) the Max figure was computed on. */
  chainId: string;
}

/**
 * True only when the form still holds exactly the text the Max button
 * wrote, for the same account and chain. Any edit of the amount, a switch
 * of account or chain, or no Max at all gives false, so an amount the user
 * typed is never lowered by prepareEvmSend.
 */
export function amountIsLastMax(
  last: LastMaxResult | null,
  current: { text: string; from: string; chainId: string },
): boolean {
  return (
    last !== null &&
    last.text === current.text &&
    last.from.toLowerCase() === current.from.toLowerCase() &&
    last.chainId === current.chainId
  );
}

/**
 * The plain sentence the confirm screen shows when a Max amount was
 * lowered at quote time. `format` renders a base-unit amount in the
 * chain's display units.
 */
export function maxAdjustmentSentence(
  quote: Pick<EvmSendQuote, 'amount' | 'maxAdjustment'>,
  format: (value: bigint) => string,
): string | null {
  if (!quote.maxAdjustment) return null;
  return (
    `The amount was lowered from ${format(quote.maxAdjustment.requested)} to ` +
    `${format(quote.amount)} because the network fee rose after you tapped Max. ` +
    'The amount plus the worst-case fee now equals your balance.'
  );
}

// ---------------------------------------------------------------------------
// OP-stack fees (layer 1 data fee and operator fee) — phase 11 item 5
// ---------------------------------------------------------------------------

/**
 * Why a wallet must account for the L1 data fee, with sources (all read
 * 2026-10-03):
 *
 *  - docs.optimism.io, "Transaction fees on OP Mainnet"
 *    (https://docs.optimism.io/op-stack/transactions/fees): "OP Mainnet
 *    transaction fees are composed of an Execution gas fee, an L1 data
 *    fee, and after the Isthmus upgrade, an operator fee" and "totalFee =
 *    operatorFee + gasUsed * (baseFee + priorityFee) + l1Fee". Of the L1
 *    data fee: "This fee is deducted directly from the address that sent
 *    the transaction" and "It is currently not possible to limit the
 *    maximum L1 Data Fee that a transaction is willing to pay." Of the
 *    operator fee: "Pre-execution validation: Account must have enough ETH
 *    to cover worst-case gas + L1 data fees + worst-case operator fee".
 *  - op-geth (ethereum-optimism/op-geth, branch optimism at commit
 *    b355734b), core/state_transition.go, buyGas(): the balance the sender
 *    must hold is `balanceCheck = GasLimit * GasFeeCap`, then
 *    `balanceCheck.Add(balanceCheck, l1Cost)` and
 *    `balanceCheck.Add(balanceCheck, operatorCost.ToBig())` (lines 299–308),
 *    then `balanceCheck.Add(balanceCheck, st.msg.Value)` (line 310), and a
 *    smaller balance fails with ErrInsufficientFunds "have … want …"
 *    (lines 328–329). So a Max send that leaves exactly gasLimit ×
 *    maxFeePerGas behind is refused: the L1 cost must be left behind too.
 *  - The GasPriceOracle predeploy 0x420000000000000000000000000000000000000F
 *    (ethereum-optimism/optimism, develop at c8e4ba85,
 *    packages/contracts-bedrock/src/L2/GasPriceOracle.sol, version 1.6.0 —
 *    the version Base Sepolia's oracle reports): getL1Fee(bytes _data)
 *    takes the "Unsigned fully RLP-encoded transaction" and, since Fjord,
 *    computes the fee from its FastLZ-compressed size plus 68 bytes "to
 *    account for unsigned tx" (the signature the node will see).
 *    getL1FeeUpperBound(uint256 _unsignedTxSize) is the Fjord addition the
 *    specs (ethereum-optimism/specs, specs/protocol/fjord/predeploys.md)
 *    describe as "provided for callers who wish to estimate L1 transaction
 *    costs in the write path, and is much more gas efficient than
 *    getL1Fee" — i.e. for contracts paying gas on-chain, using a
 *    worst-case compression bound ("covers 99.99% txs"). The specs add:
 *    "Users can continue to use the getL1Fee method to estimate the L1 fee
 *    for a given transaction". A wallet's eth_call costs nothing, so this
 *    module calls getL1Fee with the EXACT unsigned transaction it is about
 *    to sign (the same choice viem 2.57.2's op-stack estimateL1Fee makes,
 *    which also serializes an unsigned EIP-1559 transaction for getL1Fee),
 *    and getOperatorFee(gasLimit) for the operator fee (0 on Base Sepolia
 *    on 2026-10-03: L1Block operatorFeeScalar and operatorFeeConstant both
 *    read 0, but the chain can change them, so the oracle is asked).
 *
 * Headroom (a judgement, not a standard): the L1 data fee follows the
 * Ethereum base fee and blob base fee relayed to the L2, "each fluctuates
 * at most by 12.5% between updates" (the docs page above), and it cannot
 * be capped by the transaction. The quote therefore RESERVES the oracle
 * estimate plus L1_DATA_FEE_HEADROOM_PERCENT (rounded up) — enough for
 * about three consecutive maximal increases (1.125^3 ≈ 1.42) plus the
 * small difference between "unsigned size + 68" and the signed bytes. The
 * reserve is what the fee, total and Max figures use; anything not charged
 * stays in the account. If the fee rises further before inclusion, the
 * node refuses the transaction for insufficient funds and nothing is
 * spent; the user reviews again.
 */
export const OP_STACK_GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000F';

/** Headroom reserved on top of GasPriceOracle.getL1Fee (see above). */
export const L1_DATA_FEE_HEADROOM_PERCENT = 50n;

export interface OpStackFees {
  /** GasPriceOracle.getL1Fee(unsigned transaction) at quote time, in wei. */
  l1DataFeeEstimate: bigint;
  /**
   * What the quote reserves for the L1 data fee: the estimate plus
   * L1_DATA_FEE_HEADROOM_PERCENT, rounded up. Included in `fee`.
   */
  l1DataFee: bigint;
  /** GasPriceOracle.getOperatorFee(gasLimit): worst-case operator fee. Included in `fee`. */
  operatorFee: bigint;
  /** Byte length of the unsigned transaction the oracle priced. */
  unsignedTxBytes: number;
}

/** True when the chain with this numeric id has an OP-stack L1 data fee (config/evm-chain.ts). */
export function chainHasL1DataFee(chainId: bigint): boolean {
  return evmProfileByCaip2(`eip155:${chainId}`)?.l1DataFee === true;
}

/**
 * The unsigned EIP-1559 transaction as GasPriceOracle.getL1Fee expects it:
 * 0x02 || rlp([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas,
 * gasLimit, to, value, data, accessList]) — the payload whose keccak256 the
 * sender signs (EIP-1559; the same nine fields, in the same order, as the
 * engine's eoa-tx.ts baseFields, which signEip1559 uses). The engine does
 * not export the bytes themselves, only their hash, so they are rebuilt
 * here from its RLP encoder; scripts/check-base.mjs pins the result
 * against ethers' Transaction.unsignedSerialized.
 */
export function serializeUnsignedEip1559(tx: Eip1559Transaction): Uint8Array {
  const fields = [
    minimalBytes(tx.chainId),
    minimalBytes(tx.nonce),
    minimalBytes(tx.maxPriorityFeePerGas),
    minimalBytes(tx.maxFeePerGas),
    minimalBytes(tx.gasLimit),
    tx.to ? toBytes(tx.to) : new Uint8Array(0),
    minimalBytes(tx.value),
    tx.data ?? new Uint8Array(0),
    (tx.accessList ?? []).map((entry) => [toBytes(entry.address), entry.storageKeys.map(toBytes)]),
  ];
  const body = rlpEncode(fields);
  const out = new Uint8Array(1 + body.length);
  out[0] = 0x02;
  out.set(body, 1);
  return out;
}

async function oracleUint(transport: JsonRpcTransport, data: Uint8Array, what: string): Promise<bigint> {
  let result: unknown;
  try {
    result = await transport('eth_call', [{ to: OP_STACK_GAS_PRICE_ORACLE, data: toHex(data) }, 'latest']);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not read the ${what} from the network's GasPriceOracle, so the full fee of this ` +
        `transaction is unknown. Nothing was signed. (${detail})`,
    );
  }
  if (typeof result !== 'string') {
    throw new Error(`The GasPriceOracle answered the ${what} request with no value. Nothing was signed.`);
  }
  return decodeUint256(result);
}

/**
 * Asks the OP-stack GasPriceOracle for the L1 data fee of `tx` (unsigned,
 * exactly as it will be signed) and the worst-case operator fee for its
 * gas limit, and applies the headroom. Any failure refuses the quote: a
 * fee the wallet cannot see must not be left out of the total.
 */
export async function quoteOpStackFees(
  transport: JsonRpcTransport,
  tx: Eip1559Transaction,
): Promise<OpStackFees> {
  const unsigned = serializeUnsignedEip1559(tx);
  const [l1DataFeeEstimate, operatorFee] = await Promise.all([
    oracleUint(
      transport,
      encodeFunctionCall('getL1Fee(bytes)', [{ kind: 'bytes', value: unsigned }]),
      'layer 1 data fee',
    ),
    oracleUint(
      transport,
      encodeFunctionCall('getOperatorFee(uint256)', [{ kind: 'uint256', value: tx.gasLimit }]),
      'operator fee',
    ),
  ]);
  const headroom = (l1DataFeeEstimate * L1_DATA_FEE_HEADROOM_PERCENT + 99n) / 100n;
  return {
    l1DataFeeEstimate,
    l1DataFee: l1DataFeeEstimate + headroom,
    operatorFee,
    unsignedTxBytes: unsigned.length,
  };
}

/** The OP-stack part of a quote's fee (0 when the chain has none). */
export function opStackFeeTotal(fees: OpStackFees | undefined): bigint {
  return fees ? fees.l1DataFee + fees.operatorFee : 0n;
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
 * override pointing at the wrong chain must not produce a signable
 * transaction), fetches balance/nonce/fees, estimates gas, and runs the
 * eth_call pre-flight simulation.
 *
 * `expectedCaip2` is the ACTIVE EVM chain (config/evm-chain.ts): callers
 * pass 'eip155:11155111' while Sepolia test mode is on, and the endpoint's
 * eth_chainId must match it exactly — the mainnet/testnet states can never
 * mix because a Sepolia endpoint fails a mainnet-mode quote and vice
 * versa. The default keeps the historical mainnet behavior for existing
 * callers and offline checks, which is fail-closed: a caller that forgets
 * to pass the test-mode chain gets a refusal, never a wrong-chain
 * signature.
 *
 * Fees per NodeClient.suggestFees (latest base fee doubled + node priority
 * fee); gas via eth_estimateGas. For a PLAIN transfer (no calldata), when
 * estimateGas rejects (typically because the amount exceeds the balance),
 * it is retried with value 0 — intrinsic gas for a transfer does not
 * depend on the value, and the insufficient-funds condition is reported
 * by the balance check after it. A transaction WITH calldata is never
 * retried with value 0: a payable call's behaviour depends on its value
 * (Lido's submit() reverts "ZERO_DEPOSIT" and Rocket Pool's deposit()
 * reverts below its minimum when the value is 0), so the retry would
 * replace the real problem with a misleading revert. Instead, a payable
 * call (calldata and a non-zero value) is first compared with the balance
 * at the smallest fee any transaction can cost (MIN_TRANSACTION_GAS at
 * the suggested max fee) and refused with the insufficient-funds wording
 * before any estimate is requested.
 *
 * `options.fromMax` marks an amount produced by the Max button; see
 * PrepareEvmSendOptions for how such an amount is lowered when the fee
 * rose after the Max tap.
 */
export async function prepareEvmSend(
  url: string,
  from: string,
  to: string,
  amount: bigint,
  data?: Uint8Array,
  expectedCaip2: string = EVM_CHAIN_ID,
  options: PrepareEvmSendOptions = {},
): Promise<EvmSendQuote> {
  const requested = amount;
  const transport = evmHttpTransport(url);
  const node = new NodeClient(transport);

  const [chainId, balance, nonce, suggestedFees] = await Promise.all([
    node.chainId(),
    node.getBalance(from),
    node.getTransactionCount(from),
    suggestFeesRetryingOnce(node),
  ]);
  let fees = suggestedFees;

  const expected = BigInt(expectedCaip2.split(':')[1]!);
  if (chainId !== expected) {
    const expectedName =
      expected === 1n
        ? 'Ethereum mainnet'
        : expected === 11155111n
          ? 'Sepolia'
          : evmProfileByCaip2(`eip155:${expected}`)?.label;
    throw new Error(
      `Endpoint is chain id ${chainId}, expected ${expected}` +
        `${expectedName ? ` (${expectedName})` : ''}. ` +
        'Check the RPC endpoint (and the test network choice under Settings → Developer) in Settings.',
    );
  }

  // The minimum-fee rehearsal (options.minimumFee): only on a VERIFIED test
  // network; anywhere else the option is ignored and the quote is ordinary.
  let minimumFee: MinimumFeeRehearsal | undefined;
  if (options.minimumFee === true && minimumFeeRehearsalOffered(`eip155:${chainId}`)) {
    const rehearsal = await minimumFees(transport);
    fees = { maxFeePerGas: rehearsal.maxFeePerGas, maxPriorityFeePerGas: rehearsal.maxPriorityFeePerGas };
    minimumFee = { baseFeePerGas: rehearsal.baseFeePerGas };
  }

  const dataHex = data && data.length > 0 ? toHex(data) : undefined;

  // Payable contract calls only (calldata and a non-zero value): refuse a
  // value the balance cannot cover even at the smallest possible fee
  // BEFORE estimating, so the user reads "not enough ETH" rather than the
  // contract's reaction to a value it never receives. The bound is a lower
  // bound (every transaction costs at least MIN_TRANSACTION_GAS), so this
  // never refuses a transaction the balance could pay for; the exact
  // check with the estimated gas still follows below. Plain transfers and
  // value-0 calls are unchanged.
  if (dataHex !== undefined && amount > 0n) {
    const minimumFee = MIN_TRANSACTION_GAS * fees.maxFeePerGas;
    if (amount + minimumFee > balance) {
      throw new Error(
        `Insufficient funds: sending ${amount} wei plus a worst-case fee of at least ${minimumFee} wei ` +
          `exceeds the balance of ${balance} wei`,
      );
    }
  }

  let gasLimit: bigint;
  if (dataHex === undefined) {
    try {
      gasLimit = await node.estimateGas({ from, to, value: amount, data: dataHex });
    } catch {
      // Plain transfer: intrinsic gas does not depend on the value, so a
      // failure caused by the value exceeding the balance is retried with
      // value 0 and the balance check below reports the shortfall.
      try {
        gasLimit = await node.estimateGas({ from, to, value: 0n, data: dataHex });
      } catch (error) {
        throw asEstimateRevert(error, true);
      }
    }
  } else {
    // A transaction carrying calldata is NEVER retried with value 0: a
    // contract's behaviour can depend on the value (a payable stake or
    // deposit reverts with value 0), so the first failure is the answer.
    try {
      gasLimit = await node.estimateGas({ from, to, value: amount, data: dataHex });
    } catch (error) {
      throw asEstimateRevert(error, false);
    }
  }

  // OP-stack chains only (config/evm-chain.ts l1DataFee): price the exact
  // unsigned transaction sendEvm will sign. Other chains make no extra call.
  const priceOpStack = (value: bigint) =>
    quoteOpStackFees(transport, {
      chainId,
      nonce,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      maxFeePerGas: fees.maxFeePerGas,
      gasLimit,
      to,
      value,
      ...(data && data.length > 0 ? { data } : {}),
    });
  const hasOpStack = chainHasL1DataFee(chainId);
  let opStack = hasOpStack ? await priceOpStack(amount) : undefined;
  let fee = gasLimit * fees.maxFeePerGas + opStackFeeTotal(opStack);

  // Max amounts only (options.fromMax): when the fee rose since the Max
  // figure was computed, lower the amount to what the balance covers now.
  // Plain transfers only — a contract call's value is part of what the
  // caller asked for and is never changed here.
  if (options.fromMax === true && !(data && data.length > 0)) {
    for (let round = 0; round < MAX_TRIM_ROUNDS && amount + fee > balance; round++) {
      const lowered = balance - fee;
      if (lowered <= 0n) break;
      amount = lowered;
      if (!hasOpStack) break; // the fee does not depend on the value
      opStack = await priceOpStack(amount);
      fee = gasLimit * fees.maxFeePerGas + opStackFeeTotal(opStack);
    }
  }

  if (amount + fee > balance) {
    throw new Error(
      `Insufficient funds: sending ${amount} wei plus a worst-case fee of ${fee} wei ` +
        `exceeds the balance of ${balance} wei`,
    );
  }

  const simulation = await simulateCall(transport, { from, to, value: amount, data });

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
    ...(data && data.length > 0 ? { data } : {}),
    ...(opStack ? { opStack } : {}),
    ...(amount !== requested ? { maxAdjustment: { requested } } : {}),
    ...(minimumFee ? { minimumFee } : {}),
  };
}

/**
 * The maximum sendable amount for an EVM account: balance minus the
 * worst-case fee (gasLimit * maxFeePerGas) for a plain transfer, and on
 * OP-stack chains also minus the reserved L1 data fee and the worst-case
 * operator fee, because op-geth requires the sender to hold all of them
 * plus the value (see the OP-stack section above). Which chain applies is
 * decided by the endpoint's own eth_chainId; the quote that follows a Max
 * tap re-verifies the chain against the active profile anyway.
 */
export async function maxEvmSend(url: string, from: string, to?: string): Promise<bigint> {
  const transport = evmHttpTransport(url);
  const node = new NodeClient(transport);
  const [balance, fees, chainId] = await Promise.all([
    node.getBalance(from),
    suggestFeesRetryingOnce(node),
    node.chainId(),
  ]);
  // Value does not change a transfer's intrinsic gas; estimate with 0 so
  // the call cannot fail for lack of funds. Falls back to the sender
  // itself when no recipient is typed yet (an EOA-to-EOA transfer).
  const recipient = to ?? from;
  let gasLimit: bigint;
  try {
    gasLimit = await node.estimateGas({ from, to: recipient, value: 0n });
  } catch (error) {
    throw asEstimateRevert(error, true);
  }
  let opStackFee = 0n;
  if (chainHasL1DataFee(chainId)) {
    // The value is priced at the full balance: the sent amount is at most
    // that, so its RLP encoding is never longer and the estimate never low.
    const nonce = await node.getTransactionCount(from);
    opStackFee = opStackFeeTotal(
      await quoteOpStackFees(transport, {
        chainId,
        nonce,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        maxFeePerGas: fees.maxFeePerGas,
        gasLimit,
        to: recipient,
        value: balance,
      }),
    );
  }
  const max = balance - gasLimit * fees.maxFeePerGas - opStackFee;
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
 * Which backend a UTXO chain's endpoint speaks, with its extra headers.
 * 'esplora' (Bitcoin's default) keeps the historical behavior; 'blockbook'
 * (Dogecoin — config/defaults.ts) selects the engine's blockbookTransport
 * and Blockbook's estimatefee. `headers` carries the configured API key as
 * the api-key header (wallet/blockbook.ts) and is sent only to `url`.
 * `fetchFn` is injectable for the offline checks (scripts/check-doge.mjs).
 */
export interface UtxoBackendOptions {
  backend?: 'esplora' | 'blockbook';
  headers?: Record<string, string>;
  fetchFn?: typeof fetch;
}

function utxoTransportFor(url: string, options: UtxoBackendOptions): UtxoTransport {
  const extras = {
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
  };
  return options.backend === 'blockbook'
    ? blockbookTransport(url, extras)
    : esploraTransport(url);
}

/**
 * Dogecoin fee-rate floor: 1000 sat/vB == 0.01 DOGE/kB, the same
 * conservative norm scripts/testnet/smoke.mjs pays (Dogecoin Core's
 * default relay minimum is 0.001 DOGE/kB; 0.01 DOGE/kB is the
 * long-standing recommended rate wallets pay for reliable relay and
 * inclusion). The live Blockbook estimate for a 6-block target sat almost
 * exactly on this floor (0.01002934 DOGE/kB on 2026-09-28), so the floor
 * only bites when the backend's estimator reports an implausibly low rate.
 */
const BLOCKBOOK_MIN_FEE_RATE_SAT_PER_VB = 1000;

/**
 * Confirmation target for Blockbook fee estimates: 6 blocks ≈ 6 minutes at
 * Dogecoin's 1-minute block interval. Deliberately not the fastest target:
 * the live probe showed the 2-block estimate spiking ~50x (0.507 DOGE/kB)
 * while the 6-block estimate stayed at the 0.01 DOGE/kB norm.
 */
const BLOCKBOOK_FEE_TARGET_BLOCKS = 6;

/**
 * Fee rate from Blockbook's GET /api/v2/estimatefee/{blocks} endpoint.
 * Shape verified from the Blockbook v0.4.0 sources (docs/api.md documents
 * the API; the handler is server/public.go apiEstimateFee, routed at
 * api/v2/estimatefee/): the response is {"result": "<decimal string>"},
 * produced by AmountToDecimalString over the backend's estimatesmartfee
 * feerate — which Bitcoin/Dogecoin Core document as coin units per
 * kilobyte (BTC/kvB) — so `result` is COIN PER KILOBYTE as an exact
 * decimal string (strings because Dogecoin amounts overflow doubles).
 * Verified live 2026-09-28 against a Dogecoin-mainnet Blockbook:
 * /api/v2/estimatefee/6 answered {"result":"0.01002934"}.
 *
 * Conversion, exact bigint end to end:
 *   sat/kB  = parseUnits(result, 8)        (10^8 base units per coin)
 *   sat/vB  = ceil(sat_per_kB / 1000)      (1 kB = 1000 bytes; Dogecoin is
 *             pre-segwit legacy, so vsize == size and per-byte == per-vB)
 * rounded UP so the paid rate is never below the estimate, then floored at
 * BLOCKBOOK_MIN_FEE_RATE_SAT_PER_VB. The result fits comfortably in a
 * number (even the spiked live estimate was ~50728 sat/vB).
 */
export async function fetchBlockbookFeeRate(
  url: string,
  options: Omit<UtxoBackendOptions, 'backend'> = {},
): Promise<{ feeRate: number; target: number }> {
  const base = url.replace(/\/+$/, '');
  const fetchFn = options.fetchFn ?? fetch;
  const target = BLOCKBOOK_FEE_TARGET_BLOCKS;
  const response = await fetchFn(`${base}/api/v2/estimatefee/${target}`, {
    ...(options.headers ? { headers: options.headers } : {}),
  });
  if (!response.ok) {
    throw new Error(`Fee estimate fetch failed: HTTP ${response.status} from /api/v2/estimatefee`);
  }
  const body = (await response.json()) as { result?: unknown };
  if (typeof body.result !== 'string') {
    throw new Error('Endpoint returned no usable fee estimate (missing result string).');
  }
  let satPerKb: bigint;
  try {
    satPerKb = parseUnits(body.result, 8);
  } catch {
    throw new Error(`Endpoint returned an unusable fee estimate: "${body.result}"`);
  }
  const satPerVb = Number((satPerKb + 999n) / 1000n);
  return { feeRate: Math.max(BLOCKBOOK_MIN_FEE_RATE_SAT_PER_VB, satPerVb), target };
}

function fetchFeeRateFor(
  url: string,
  options: UtxoBackendOptions,
): Promise<{ feeRate: number; target: number }> {
  return options.backend === 'blockbook'
    ? fetchBlockbookFeeRate(url, { headers: options.headers, fetchFn: options.fetchFn })
    : fetchUtxoFeeRate(url, options.fetchFn ?? fetch);
}

/**
 * UTXO quote: fetches the sender's UTXOs and a fee rate, then runs the
 * engine's buildTransfer (coin selection + dust rules) to get the exact
 * fee the signed transaction will pay. The BuiltTransfer is kept in the
 * quote and signed as-is at confirm time, so the fee shown is the fee paid.
 * `options` selects the endpoint's backend (Esplora by default; Blockbook
 * for Dogecoin) — see UtxoBackendOptions.
 */
export async function prepareUtxoSend(
  url: string,
  network: UtxoNetwork,
  fromAddress: string,
  to: string,
  amount: bigint,
  options: UtxoBackendOptions = {},
): Promise<UtxoSendQuote> {
  const transport = utxoTransportFor(url, options);
  const [utxos, { feeRate, target }] = await Promise.all([
    transport.getUtxos(fromAddress),
    fetchFeeRateFor(url, options),
  ]);
  const balance = utxos.reduce((sum, u) => sum + u.value, 0n);
  // The engine dust-checks the change output inside coin selection; the
  // recipient output is checked here, before building, because a sub-dust
  // payment would be refused by the network's relay policy. The threshold
  // is the chain's own (UtxoNetwork.dustPolicy): Bitcoin Core's 546 / 294
  // sat, Dogecoin Core's 0.01 DOGE soft limit. buildTransfer applies the
  // same rule, so this check only gives the earlier, shorter message.
  const toScript = addressToScriptPubKey(to, network);
  const dust = dustThreshold(toScript, network.dustPolicy);
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
  options: UtxoBackendOptions = {},
): Promise<{ amount: bigint; utxos: Utxo[] }> {
  const transport = utxoTransportFor(url, options);
  const [utxos, { feeRate }] = await Promise.all([
    transport.getUtxos(fromAddress),
    fetchFeeRateFor(url, options),
  ]);
  if (utxos.length === 0) throw new Error('No spendable coins on this address.');
  const total = utxos.reduce((sum, u) => sum + u.value, 0n);

  const inputScript = addressToScriptPubKey(fromAddress, network);
  const inputKind = inputScript.length === 22 ? 'p2wpkh' : 'p2pkh';
  const toScript = addressToScriptPubKey(to, network);
  const sweepFee = feeForVsize(estimateVsize(inputKind, utxos.length, [toScript]), feeRate);

  let amount = total - sweepFee;
  let lastError: unknown;
  // Verification loop: candidate must build. Steps down at most a few
  // satoshis around integer fee-rounding boundaries.
  for (let i = 0; i < 8 && amount > 0n; i++) {
    try {
      buildTransfer({ network, fromAddress, utxos, toAddress: to, amount, feeRate });
      return { amount, utxos };
    } catch (e) {
      lastError = e;
      amount -= 1n;
    }
  }
  // A balance that covers the fee but would leave less than the chain's
  // dust limit (0.01 DOGE on Dogecoin) fails on the dust rule, not the fee:
  // pass the engine's dust message on so describeSendError names it.
  if (lastError instanceof Error && /dust/i.test(lastError.message)) throw lastError;
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
 * What sendEvm reports once the node accepted a transaction
 * (eth_sendRawTransaction returned its hash). Public data only: the sender
 * address, never the DerivedAccount.
 */
export interface EvmSentEvent {
  from: string;
  quote: EvmSendQuote;
  txid: string;
}

export type EvmSentListener = (event: EvmSentEvent) => void | Promise<void>;

const evmSentListeners = new Set<EvmSentListener>();

/**
 * Subscribes to accepted EOA transactions (every sendEvm caller: native,
 * ERC-20 and NFT sends, swaps, revokes, WalletConnect). Used by the
 * app-enforced spending policy (./spending-policy.ts) to record what left
 * the account. Never called for a send the node refused, nor for one whose
 * broadcast got no answer in time (its outcome is unknown; the pending
 * registry lists it instead). Returns the unsubscribe function.
 */
export function addEvmSentListener(listener: EvmSentListener): () => void {
  evmSentListeners.add(listener);
  return () => {
    evmSentListeners.delete(listener);
  };
}

export type SendAcceptedListener = () => void;

const sendAcceptedListeners = new Set<SendAcceptedListener>();

/**
 * Subscribes to "a transaction from this wallet was accepted by a node" on
 * ANY chain: sendEvm (and so every EOA EVM caller), sendUtxo, sendSol, the
 * EIP-7702 set-code transaction (delegation.ts) and the guardian
 * approveWithSig transaction (recovery.ts). Smart-account operations are
 * reported separately by aa.ts addAaSentListener. Home uses both to reload
 * its balances when it regains focus after a send. Carries no data on
 * purpose: it only says that balances may have moved. Returns the
 * unsubscribe function.
 */
export function addSendAcceptedListener(listener: SendAcceptedListener): () => void {
  sendAcceptedListeners.add(listener);
  return () => {
    sendAcceptedListeners.delete(listener);
  };
}

/** Best-effort fan-out: a failing listener never affects the send. */
export function notifySendAccepted(): void {
  for (const listener of [...sendAcceptedListeners]) {
    try {
      listener();
    } catch {
      // Listeners only refresh displays; the transaction was already accepted.
    }
  }
}

/** Best-effort fan-out: a failing listener never affects the send. */
function notifyEvmSent(event: EvmSentEvent): void {
  for (const listener of [...evmSentListeners]) {
    try {
      const result = listener(event);
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch(() => undefined);
      }
    } catch {
      // Listeners are bookkeeping; the transaction was already accepted.
    }
  }
}

// ---------------------------------------------------------------------------
// The pending registry (feature 95): every transaction sendEvm broadcasts
// ---------------------------------------------------------------------------

let pendingRecordStore: PendingStore | null = null;

/**
 * The store the pending recorder writes to (AsyncStorage when unset). For
 * the check scripts, which run under Node where AsyncStorage is not
 * available; null restores the default.
 */
export function setPendingRecordStore(store: PendingStore | null): void {
  pendingRecordStore = store;
}

/**
 * Transactions whose broadcast got no answer in time (phase 23 item 8): the
 * quote objects and the signed transactions' hashes. Neither goes out a
 * second time (BroadcastAlreadyHandedOverError): if the first one reached
 * the network, a second broadcast of the same quote is at best a duplicate
 * and, after a re-quote at the next nonce, a second payment. In memory only;
 * the pending registry is what survives a restart.
 */
const outcomeUnknownQuotes = new WeakSet<object>();
const outcomeUnknownHashes = new Set<string>();

/** True when this quote's broadcast got no answer in time (checked by screens before the device check). */
export function broadcastOutcomeUnknownFor(quote: object): boolean {
  return outcomeUnknownQuotes.has(quote);
}

/**
 * Every EOA broadcast of this module (sendEvm, sendEvmWithSignature and the
 * two replacement paths) goes through here (phase 23 item 8). In order:
 *
 *  1. a quote or signed transaction whose earlier broadcast has an unknown
 *     outcome is refused (BroadcastAlreadyHandedOverError) before anything
 *     is recorded or sent;
 *  2. the transaction is recorded in the pending registry (Activity's
 *     "Pending on this phone", which offers Speed up and Cancel) under the
 *     hash computed on the device — keccak256 of the signed serialization —
 *     and the write is AWAITED, so the record exists before the request
 *     leaves the device. Best effort: a failed write ('failed') does not
 *     stop the broadcast, as before;
 *  3. eth_sendRawTransaction, bounded by the engine's BROADCAST_TIMEOUT_MS:
 *     - accepted: the node's hash is returned (the record stays);
 *     - no answer in time: the quote and the hash are marked, the record
 *       stays, and BroadcastOutcomeUnknownError says the outcome is unknown
 *       (never "not sent"); the card's poll settles it;
 *     - any other error (the node refused, an HTTP error, no connection):
 *       the record this call created is removed again, so the card never
 *       lists a transaction the node answered with an error, and the error
 *       is rethrown unchanged (every existing translation still applies).
 *
 * Before phase 23 item 8 the record was written by a sent listener after the
 * node accepted; one record per hash either way (the registry is keyed by
 * chain and hash).
 */
async function broadcastRecorded(args: {
  node: NodeClient;
  rawHex: string;
  txHash: string;
  quote: object;
  record: () => PendingTxRecord;
  store: PendingStore | undefined;
}): Promise<string> {
  const hash = args.txHash.toLowerCase();
  if (outcomeUnknownQuotes.has(args.quote) || outcomeUnknownHashes.has(hash)) {
    throw new BroadcastAlreadyHandedOverError(hash);
  }
  let record: PendingTxRecord | null = null;
  try {
    record = args.record();
  } catch {
    record = null;
  }
  const state = record ? await recordPendingTransactionBeforeBroadcast(record, args.store) : 'failed';
  try {
    return await args.node.sendRawTransaction(args.rawHex);
  } catch (error) {
    if (isBroadcastOutcomeUnknown(error)) {
      outcomeUnknownQuotes.add(args.quote);
      outcomeUnknownHashes.add(hash);
      throw new BroadcastOutcomeUnknownError({
        kind: 'tx',
        hash,
        chain: record?.chain ?? '',
        recorded: state !== 'failed',
        technical: error instanceof Error ? error.message : String(error),
      });
    }
    if (record && state === 'created') {
      await forgetPendingTransaction({ chain: record.chain, hash }, args.store).catch(() => undefined);
    }
    throw error;
  }
}

/**
 * Signs and broadcasts an EOA EIP-1559 transfer through chains-evm.
 *
 * SMART-ACCOUNT SEAM: this is the point where the flow forks. The ERC-4337
 * path is implemented in ./aa.ts (phase 3; account types and batching in
 * phase 7): when the user enables the experimental smart-account toggle on
 * a chain with a verified bundler and factory, SendScreen quotes through
 * prepareAaSend (native) or prepareAaErc20Send (tokens), SwapScreen through
 * swap.ts prepareAaSwap (one atomic [approve, swap] batch), and
 * WalletConnect smart-account sessions through prepareAaCalls — all
 * submitted by sendAa (SmartAccountClient.sendCalls in chains-evm) instead
 * of this function. The recipient/amount come from the same validated
 * form, and the signer stays the same seed-derived owner key (the smart
 * account's owner, ADR D1). With the toggle off or the chain unconfigured,
 * this EOA path runs unchanged. Everything before the fork (recipient
 * validation, amount parsing) is path-agnostic by design.
 *
 * The broadcast goes through broadcastRecorded: the transaction is listed in
 * the pending registry before it is sent, the node gets at most
 * BROADCAST_TIMEOUT_MS to answer (an unanswered broadcast is reported as an
 * unknown outcome, never as not sent), and a quote whose broadcast got no
 * answer is never broadcast again.
 *
 * `explorerTxBase` comes from the active EVM chain profile
 * (config/evm-chain.ts): sepolia.etherscan.io in Sepolia test mode. The
 * default keeps the historical mainnet link for existing callers; null
 * yields no link at all.
 */
export async function sendEvm(
  url: string,
  signer: DerivedAccount,
  quote: EvmSendQuote,
  explorerTxBase: string | null = 'https://etherscan.io/tx/',
): Promise<SendResult> {
  const tx: Eip1559Transaction = {
    chainId: quote.chainId,
    nonce: quote.nonce,
    maxPriorityFeePerGas: quote.maxPriorityFeePerGas,
    maxFeePerGas: quote.maxFeePerGas,
    gasLimit: quote.gasLimit,
    to: quote.to,
    value: quote.amount,
    ...(quote.data && quote.data.length > 0 ? { data: quote.data } : {}),
  };
  const signed = signEip1559(tx, signer);
  const node = new NodeClient(evmHttpTransport(url));
  const txid = await broadcastRecorded({
    node,
    rawHex: signed.rawHex,
    txHash: signed.txHash,
    quote,
    record: () => txRecordFromQuote(signer.address, quote, signed.txHash, Date.now()),
    store: pendingRecordStore ?? undefined,
  });
  notifyEvmSent({ from: signer.address, quote, txid });
  notifySendAccepted();
  return { txid, explorerUrl: explorerTxBase ? `${explorerTxBase}${txid}` : null };
}

/** The transaction sendEvm signs for a quote (one mapping, shared by the cold-signed path below). */
function evmTxForQuote(quote: EvmSendQuote): Eip1559Transaction {
  return {
    chainId: quote.chainId,
    nonce: quote.nonce,
    maxPriorityFeePerGas: quote.maxPriorityFeePerGas,
    maxFeePerGas: quote.maxFeePerGas,
    gasLimit: quote.gasLimit,
    to: quote.to,
    value: quote.amount,
    ...(quote.data && quote.data.length > 0 ? { data: quote.data } : {}),
  };
}

/** The refusal when a signature made elsewhere was not made by the sending address. */
export const PRESIGNED_WRONG_SIGNER_SENTENCE =
  'The signature was not made by the sending address over this transaction, so nothing was sent.';

/**
 * Broadcasts a transaction signed ELSEWHERE (cold signing, phase 22 item 3:
 * the watch-only account's off-line signer) through the same path as
 * sendEvm: the transaction is rebuilt from the QUOTE exactly as sendEvm
 * builds it, the signature is attached (chains-evm serializeSignedEip1559,
 * pinned against ethers), the recovered signer must equal `from`, the
 * transaction is recorded in the pending registry before the broadcast (so
 * Activity's card applies) exactly as sendEvm does, and an accepted
 * broadcast notifies the same listeners as sendEvm (the spending recorder;
 * Home's refresh). No key is involved. sendEvm itself is unchanged; it cannot take
 * a signature because it signs with a DerivedAccount.
 */
export async function sendEvmWithSignature(
  url: string,
  from: string,
  quote: EvmSendQuote,
  signature: Eip1559Signature,
  explorerTxBase: string | null,
  options: { transport?: JsonRpcTransport } = {},
): Promise<SendResult> {
  const tx = evmTxForQuote(quote);
  if (recoverEip1559Signer(tx, signature).toLowerCase() !== from.toLowerCase()) {
    throw new Error(PRESIGNED_WRONG_SIGNER_SENTENCE);
  }
  const signed = serializeSignedEip1559(tx, signature);
  const node = new NodeClient(options.transport ?? evmHttpTransport(url));
  const txid = await broadcastRecorded({
    node,
    rawHex: signed.rawHex,
    txHash: signed.txHash,
    quote,
    record: () => txRecordFromQuote(from, quote, signed.txHash, Date.now()),
    store: pendingRecordStore ?? undefined,
  });
  notifyEvmSent({ from, quote, txid });
  notifySendAccepted();
  return { txid, explorerUrl: explorerTxBase ? `${explorerTxBase}${txid}` : null };
}

/**
 * Signs the quoted BuiltTransfer and broadcasts it via the endpoint's
 * transport (Esplora by default, Blockbook for Dogecoin — same backend
 * `options` as the quote). chains-utxo cross-checks the backend's txid
 * against the locally computed one. Explorer link only for Bitcoin: no
 * Dogecoin explorer has been verified for this wallet yet, so the txid is
 * shown without a link there.
 */
export async function sendUtxo(
  url: string,
  chainId: string,
  signer: DerivedAccount,
  quote: UtxoSendQuote,
  options: UtxoBackendOptions = {},
): Promise<SendResult> {
  const txid = await signAndBroadcast(quote.built, signer, utxoTransportFor(url, options));
  notifySendAccepted();
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
  notifySendAccepted();
  return { txid: signature, explorerUrl: `https://solscan.io/tx/${signature}` };
}

// ---------------------------------------------------------------------------
// Speed up / cancel a pending transaction (feature 95)
// ---------------------------------------------------------------------------

/**
 * A replacement quote: an ordinary EvmSendQuote (so the confirm screen, the
 * eth_call pre-flight and the signing are the ones every send uses) with the
 * facts of what it replaces.
 */
export interface EvmReplacementQuote extends EvmSendQuote {
  replacement: {
    action: ReplacementAction;
    /** What is recorded for the new transaction: a speed-up of a cancellation stays a cancellation. */
    recordedAction: ReplacementAction;
    /** Lower-case sender (the account that sent the original). */
    from: string;
    /** CAIP-2 id of the network. */
    chain: string;
    /** The wallet's original transaction for this nonce. */
    original: string;
    /** The newest broadcast for this nonce (the one the pool should now hold). */
    replaces: string;
    /** Every hash broadcast for this nonce so far. */
    hashes: string[];
    /** The highest fees broadcast for this nonce, the minimums over them and the node's suggestion. */
    pooled: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
    fees: ReplacementFees;
  };
}

/**
 * A replacement refused before anything was signed (already included, the
 * nonce used, the fees no longer high enough, the quote used once) or by the
 * node at broadcast (underpriced, nonce too low). `message` is the plain
 * sentence; `technical` the node's own text when there is one.
 */
export class ReplacementRefusedError extends Error {
  technical: string | null;
  // No TS parameter properties: Node's strip-only type stripping rejects them.
  constructor(message: string, technical: string | null = null) {
    super(message);
    this.name = 'ReplacementRefusedError';
    this.technical = technical;
  }
}

const usedReplacementQuotes = new WeakSet<object>();

/** True when this replacement quote was already submitted (checked before the device check). */
export function replacementQuoteUsed(quote: object): boolean {
  return usedReplacementQuotes.has(quote);
}

/**
 * Reads the nonce's status and refuses (ReplacementRefusedError) when a
 * broadcast for it is already in a block or the account's nonce has moved
 * past it. Shared by the quote and the check before approval.
 */
async function assertStillPending(transport: JsonRpcTransport, group: NonceGroup): Promise<void> {
  const status = await groupStatus(nodeReader(transport), group);
  if (status.state === 'mined') throw new ReplacementRefusedError(alreadyIncludedSentence(status.block));
  if (status.state === 'nonce-used') throw new ReplacementRefusedError(nonceUsedSentence(group.nonce));
}

/**
 * Prices a speed-up or a cancellation of the pending transaction `group`
 * (all broadcasts the wallet made for one nonce, from the pending registry).
 *
 *  - Refuses before anything else when the endpoint is not the group's
 *    chain, when any of its broadcasts is already included ("This
 *    transaction is already included in block N.") or when the account's
 *    'latest' nonce is past it.
 *  - Fees: per field, the larger of the 10% bumped minimum over the highest
 *    fees broadcast for this nonce (pending-transactions.ts replacementFees,
 *    the go-ethereum and reth replacement rules) and the node's current
 *    suggestion (suggestFeesRetryingOnce: the latest base fee × 2 + the
 *    node's priority fee). The max fee is therefore never below the base fee
 *    read here, so a block can include the replacement (EIP-1559) even when
 *    the original was a minimum-fee rehearsal priced at 1 / 1 wei, below the
 *    base fee, whose bumped minimum (2 / 2 wei) alone could not be included.
 *  - Speed-up: the NEWEST broadcast's recipient, value, calldata and gas
 *    limit, unchanged (so a speed-up of a cancellation stays a
 *    cancellation). Cancel: 0 to the sender's own address, no calldata, the
 *    gas limit from eth_estimateGas.
 *  - The worst case (gas limit × max fee, plus the layer 1 data fee on
 *    OP-stack chains, as prepareEvmSend) plus the value must fit the
 *    balance, which still holds the value because nothing for this nonce is
 *    included yet.
 *  - The eth_call pre-flight runs on the transaction that will be signed.
 */
export async function prepareEvmReplacement(
  url: string,
  group: NonceGroup,
  action: ReplacementAction,
  expectedCaip2: string,
  options: { transport?: JsonRpcTransport } = {},
): Promise<EvmReplacementQuote> {
  const transport = options.transport ?? evmHttpTransport(url);
  const node = new NodeClient(transport);
  const chainId = await node.chainId();
  if (`eip155:${chainId}` !== expectedCaip2 || group.chain !== expectedCaip2) {
    throw new ReplacementRefusedError(
      `The network endpoint serves chain id ${chainId}, but this transaction is on ${group.chain}. Nothing was signed.`,
    );
  }
  await assertStillPending(transport, group);

  const latest = group.latest;
  const from = group.from;
  const suggested = await suggestFeesRetryingOnce(node);
  const pooled = pooledFees(group.txs);
  const fees = replacementFees(pooled, suggested);

  const cancelling = action === 'cancel' || latest.action === 'cancel';
  const to = cancelling ? from : latest.to;
  const amount = cancelling ? 0n : BigInt(latest.value);
  const data = cancelling || latest.data === '0x' ? undefined : toBytes(latest.data);
  let gasLimit: bigint;
  if (action === 'cancel' && latest.action !== 'cancel') {
    try {
      gasLimit = await node.estimateGas({ from, to: from, value: 0n });
    } catch (error) {
      throw asEstimateRevert(error, true);
    }
  } else {
    gasLimit = BigInt(latest.gasLimit);
  }

  const nonce = BigInt(group.nonce);
  const opStack = chainHasL1DataFee(chainId)
    ? await quoteOpStackFees(transport, {
        chainId,
        nonce,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        maxFeePerGas: fees.maxFeePerGas,
        gasLimit,
        to,
        value: amount,
        ...(data ? { data } : {}),
      })
    : undefined;
  const fee = gasLimit * fees.maxFeePerGas + opStackFeeTotal(opStack);
  const balance = await node.getBalance(from);
  if (amount + fee > balance) {
    throw new Error(
      `Insufficient funds: sending ${amount} wei plus a worst-case fee of ${fee} wei ` +
        `exceeds the balance of ${balance} wei`,
    );
  }
  const simulation = await simulateCall(transport, { from, to, value: amount, data });
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
    ...(data ? { data } : {}),
    ...(opStack ? { opStack } : {}),
    replacement: {
      action,
      recordedAction: cancelling ? 'cancel' : 'speed-up',
      from,
      chain: group.chain,
      original: group.original.hash,
      replaces: latest.hash,
      hashes: group.txs.map((t) => t.hash),
      pooled,
      fees,
    },
  };
}

/**
 * The checks run BEFORE the device check (as checkAaQuoteBeforeApproval for
 * smart accounts): the quote was not submitted already, nothing for this
 * nonce is included and the nonce is still unused, and the quoted fees
 * still clear the bump over every broadcast for this nonce — `group` is the
 * group re-read from the registry just now, so a replacement sent in the
 * meantime (another screen) is seen. Throws ReplacementRefusedError.
 */
export async function checkReplacementBeforeApproval(
  url: string,
  quote: EvmReplacementQuote,
  group: NonceGroup,
  options: { transport?: JsonRpcTransport } = {},
): Promise<void> {
  if (usedReplacementQuotes.has(quote)) throw new ReplacementRefusedError(REPLACEMENT_QUOTE_USED);
  const transport = options.transport ?? evmHttpTransport(url);
  await assertStillPending(transport, group);
  if (!meetsReplacementRule(pooledFees(group.txs), quote)) throw new ReplacementRefusedError(REPLACEMENT_FEES_STALE);
}

/**
 * Signs and broadcasts a replacement, after the device check. A quote goes
 * out at most once. The signer must be the original's sender. Does NOT fan
 * out to the sent listeners (the spending recorder would count the value a
 * second time): the caller records the fee with recordAcceptedSpend
 * (pending-transactions.ts replacementSpendingInput). The new transaction
 * is recorded in the pending registry, linked to the one it replaces, just
 * BEFORE the broadcast (broadcastRecorded): removed again when the node
 * refuses it, kept when no answer comes in time (BroadcastOutcomeUnknownError). A node refusal is translated: "replacement transaction
 * underpriced" (go-ethereum txpool.ErrReplaceUnderpriced; reth's wording
 * contains "underpriced" too) and "nonce too low" (the nonce was used
 * meanwhile).
 */
export async function sendEvmReplacement(
  url: string,
  signer: DerivedAccount,
  quote: EvmReplacementQuote,
  explorerTxBase: string | null,
  options: { transport?: JsonRpcTransport; store?: PendingStore; now?: () => number } = {},
): Promise<SendResult> {
  if (usedReplacementQuotes.has(quote)) throw new ReplacementRefusedError(REPLACEMENT_QUOTE_USED);
  usedReplacementQuotes.add(quote);
  if (signer.address.toLowerCase() !== quote.replacement.from) {
    throw new ReplacementRefusedError(
      'The signing account is not the one that sent this transaction. Nothing was signed.',
    );
  }
  const tx: Eip1559Transaction = {
    chainId: quote.chainId,
    nonce: quote.nonce,
    maxPriorityFeePerGas: quote.maxPriorityFeePerGas,
    maxFeePerGas: quote.maxFeePerGas,
    gasLimit: quote.gasLimit,
    to: quote.to,
    value: quote.amount,
    ...(quote.data && quote.data.length > 0 ? { data: quote.data } : {}),
  };
  const signed = signEip1559(tx, signer);
  const node = new NodeClient(options.transport ?? evmHttpTransport(url));
  let txid: string;
  try {
    // Recorded (linked to what it replaces) before the request leaves the
    // device; removed again on a refusal, kept when no answer comes.
    txid = await broadcastRecorded({
      node,
      rawHex: signed.rawHex,
      txHash: signed.txHash,
      quote,
      record: () =>
        txRecordFromQuote(quote.replacement.from, quote, signed.txHash, (options.now ?? Date.now)(), {
          action: quote.replacement.recordedAction,
          replaces: quote.replacement.replaces,
        }),
      store: options.store ?? pendingRecordStore ?? undefined,
    });
  } catch (error) {
    if (isBroadcastOutcomeUnknown(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (/underpriced/i.test(message)) throw new ReplacementRefusedError(REPLACEMENT_UNDERPRICED_SENTENCE, message);
    if (/nonce too low/i.test(message)) {
      throw new ReplacementRefusedError(
        `The network refused the replacement because nonce ${quote.nonce} was already used: a transaction ` +
          'with this nonce was included in the meantime, so nothing more was sent. Activity shows which one ' +
          'once it refreshes.',
        message,
      );
    }
    throw error;
  }
  notifySendAccepted();
  return { txid, explorerUrl: explorerTxBase ? `${explorerTxBase}${txid}` : null };
}

/**
 * The cold-signed counterpart of sendEvmReplacement (phase 22 item 3): a
 * speed-up or cancellation of a WATCH-ONLY account's pending transaction,
 * signed by its off-line signer. Same rules in the same order as
 * sendEvmReplacement — the quote is claimed once, the sender must be the
 * one that sent the original, the transaction is rebuilt from the quote,
 * the node's refusals are translated with the same sentences, and the
 * replacement is recorded in the pending registry with its action and the
 * hash it replaces (before the broadcast, as sendEvmReplacement) — with the
 * signature attached instead of
 * made here, and the recovered signer required to equal that sender.
 * sendEvmReplacement itself is unchanged.
 */
export async function sendEvmReplacementWithSignature(
  url: string,
  from: string,
  quote: EvmReplacementQuote,
  signature: Eip1559Signature,
  explorerTxBase: string | null,
  options: { transport?: JsonRpcTransport; store?: PendingStore; now?: () => number } = {},
): Promise<SendResult> {
  if (usedReplacementQuotes.has(quote)) throw new ReplacementRefusedError(REPLACEMENT_QUOTE_USED);
  usedReplacementQuotes.add(quote);
  if (from.toLowerCase() !== quote.replacement.from) {
    throw new ReplacementRefusedError(
      'The signing account is not the one that sent this transaction. Nothing was signed.',
    );
  }
  const tx = evmTxForQuote(quote);
  if (recoverEip1559Signer(tx, signature).toLowerCase() !== quote.replacement.from) {
    throw new ReplacementRefusedError(PRESIGNED_WRONG_SIGNER_SENTENCE);
  }
  const signed = serializeSignedEip1559(tx, signature);
  const node = new NodeClient(options.transport ?? evmHttpTransport(url));
  let txid: string;
  try {
    // Recorded (linked to what it replaces) before the request leaves the
    // device; removed again on a refusal, kept when no answer comes.
    txid = await broadcastRecorded({
      node,
      rawHex: signed.rawHex,
      txHash: signed.txHash,
      quote,
      record: () =>
        txRecordFromQuote(quote.replacement.from, quote, signed.txHash, (options.now ?? Date.now)(), {
          action: quote.replacement.recordedAction,
          replaces: quote.replacement.replaces,
        }),
      store: options.store ?? pendingRecordStore ?? undefined,
    });
  } catch (error) {
    if (isBroadcastOutcomeUnknown(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (/underpriced/i.test(message)) throw new ReplacementRefusedError(REPLACEMENT_UNDERPRICED_SENTENCE, message);
    if (/nonce too low/i.test(message)) {
      throw new ReplacementRefusedError(
        `The network refused the replacement because nonce ${quote.nonce} was already used: a transaction ` +
          'with this nonce was included in the meantime, so nothing more was sent. Activity shows which one ' +
          'once it refreshes.',
        message,
      );
    }
    throw error;
  }
  notifySendAccepted();
  return { txid, explorerUrl: explorerTxBase ? `${explorerTxBase}${txid}` : null };
}

// ---------------------------------------------------------------------------
// Quote endpoint pinning (phase 9 item 5)
// ---------------------------------------------------------------------------

/** Alert title when a quote's endpoint is no longer the one in use. */
export const QUOTE_ENDPOINT_CHANGED_TITLE = 'Please review again';

/**
 * A quote is the answer of ONE endpoint: its nonce, fees, balance and
 * pre-flight simulation all came from the URL it was prepared with, and the
 * send must go out through that same URL. Endpoint failover (config/
 * networks.ts callWithFailover) can move the wallet to another default
 * endpoint while a confirm screen is open, and the user can change an
 * override in Settings. In both cases the quote is never patched or mixed:
 * the screen re-resolves the endpoint just before signing, and this
 * function returns the plain refusal to show when it differs from the
 * quote's (null when they match, so the send may proceed through
 * `quotedUrl`). Only host names are shown: an override URL can embed an
 * API key.
 */
export function quoteEndpointChange(
  quotedUrl: string,
  currentUrl: string | null | undefined,
): string | null {
  if (currentUrl === quotedUrl) return null;
  const now = currentUrl ? endpointHost(currentUrl) : null;
  return (
    `This quote came from ${endpointHost(quotedUrl)}, but the wallet would now ` +
    (now ? `use ${now}` : 'use no endpoint at all') +
    ' for this network. Nothing was signed or sent. Review the transaction ' +
    'again to get a fresh quote from the current endpoint.'
  );
}

// ---------------------------------------------------------------------------
// Error translation
// ---------------------------------------------------------------------------

/**
 * Title for a quote whose gas estimate reverted. Nothing was signed or sent,
 * so it uses the quote-step wording of aa.ts QUOTE_FAILED_TITLE (phase 11
 * item 2 bug fixes); the string is repeated here because aa.ts imports this
 * module.
 */
export const ESTIMATE_REVERT_TITLE = 'The quote could not be prepared.';

/** The plain sentence for a plain ETH transfer the recipient refused. */
export const PLAIN_TRANSFER_REJECTED_SENTENCE =
  'The recipient contract rejected a plain ETH transfer during estimation (execution reverted). ' +
  'Nothing was sent.';

/**
 * Thrown when eth_estimateGas reverts while a quote is prepared: the
 * recipient (or called contract) refused the transaction in simulation, so
 * no gas figure exists and nothing was attempted. Example: Permit2 has no
 * payable receive function, so a plain ETH transfer to it reverts (emulator
 * pass finding F3, 2026-10-03). `plainTransfer` is true for a value-only
 * transfer with no calldata. The node's own text stays in `message`.
 */
export class GasEstimateRevertError extends Error {
  plainTransfer: boolean;
  /** The revert reason after "execution reverted:", when the node sent one. */
  reason: string | null;
  // No TS parameter properties: Node's strip-only type stripping rejects them.
  constructor(message: string, plainTransfer: boolean, reason: string | null) {
    super(message);
    this.name = 'GasEstimateRevertError';
    this.plainTransfer = plainTransfer;
    this.reason = reason;
  }
}

/**
 * Wraps an eth_estimateGas failure: a revert becomes GasEstimateRevertError,
 * anything else (an unreachable endpoint, insufficient funds) is returned
 * unchanged so its own branch in describeSendError applies.
 */
function asEstimateRevert(error: unknown, plainTransfer: boolean): unknown {
  if (isEndpointFailure(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (!/revert/i.test(message)) return error;
  const reason = /execution reverted:\s*([^()]+?)\s*(?:\(|$)/i.exec(message)?.[1]?.trim() ?? null;
  return new GasEstimateRevertError(message, plainTransfer, reason && reason !== '' ? reason : null);
}

/** The plain sentence for a GasEstimateRevertError (detail line of the quote failure). */
export function estimateRevertSentence(error: GasEstimateRevertError): string {
  if (error.plainTransfer) {
    return error.reason
      ? `The recipient contract rejected a plain ETH transfer during estimation (execution reverted: ${error.reason}). Nothing was sent.`
      : PLAIN_TRANSFER_REJECTED_SENTENCE;
  }
  return (
    `The contract rejected this transaction during estimation (execution reverted${
      error.reason ? `: ${error.reason}` : ''
    }). Nothing was sent.`
  );
}

/**
 * Turns engine/RPC errors into plain language for the send screen, keeping
 * the original message as detail because it names the exact protocol-level
 * failure (dust threshold, insufficient funds arithmetic, node rejection).
 *
 * `symbol` names what is being sent (the token for a token send).
 * `feeSymbol` names the coin the network fee is paid in — the profile's
 * display symbol (evmChain.displaySymbol, "test ETH" on a test network);
 * it defaults to 'ETH' so callers that do not pass it read as before.
 */
/**
 * The coin a network's fee is paid in, as the screens name it (the
 * profile's displaySymbol: "ETH" on mainnet, "test ETH" on the test
 * networks, the coin a user-added network declared). 'ETH' for a chain the
 * app has no profile for. Used by the fee-shortfall sentences of
 * send-erc20.ts, send-nft.ts and delegation.ts (phase 20 item 3).
 */
export function feeSymbolForChain(chain: bigint | string): string {
  const caip2 = typeof chain === 'bigint' ? `eip155:${chain.toString()}` : chain;
  return evmProfileByCaip2(caip2)?.displaySymbol ?? 'ETH';
}

/**
 * Matches the fee-shortfall sentence those modules throw ("Not enough
 * <fee coin> to pay the network fee: …"), whatever the coin is called; the
 * fee coin is at most a few words, never a sentence.
 */
const FEE_SHORTFALL = /not enough [^.:\n]{1,40}? to pay the network fee/i;

/**
 * A node refusing a broadcast for its fee (pass p21e finding A2: shown raw as
 * "RPC error -32000: transaction underpriced (eth_sendRawTransaction)").
 * Matched conservatively on the wordings recorded from the clients the
 * wallet's endpoints run: go-ethereum and reth "transaction underpriced",
 * go-ethereum's "… gas tip cap 0, minimum needed 1" (phase 19 record), and
 * "max fee per gas less than block base fee" (go-ethereum core
 * ErrFeeCapTooLow, reth's equivalent). "replacement transaction
 * underpriced" (go-ethereum txpool.ErrReplaceUnderpriced) has its own
 * sentence: it means another transaction with the same nonce is pooled.
 */
const REPLACEMENT_UNDERPRICED = /replacement transaction underpriced/i;
const BROADCAST_UNDERPRICED =
  /transaction underpriced|gas tip cap \d+, minimum needed \d+|max fee per gas less than block base fee/i;

export const TX_UNDERPRICED_TITLE = 'The network endpoint refused the fee.';

export const TX_UNDERPRICED_SENTENCE =
  'The network endpoint refused this transaction because its fee is below what that node accepts ' +
  '("transaction underpriced"). Nothing was sent. Try again, or review the transaction again for a fresh fee.';

/** Added when the refused quote was the Developer minimum-fee rehearsal (Send screen). */
export const TX_UNDERPRICED_REHEARSAL_NOTE =
  'The minimum-fee rehearsal is still on and this screen still holds its quote: approve again to retry, ' +
  'or go back and turn the rehearsal off in Settings → Developer to send at the usual fee.';

export const TX_REPLACEMENT_UNDERPRICED_TITLE = 'Another transaction with the same nonce is waiting.';

export const TX_REPLACEMENT_UNDERPRICED_SENTENCE =
  'The network endpoint refused this transaction because it already holds a pending transaction from this ' +
  "account with the same nonce, and this one's fee is not high enough to replace it (\"replacement " +
  'transaction underpriced"). Nothing was sent. Wait for the pending transaction to be included, or speed it ' +
  'up or cancel it from Activity.';

export function describeSendError(
  error: unknown,
  symbol: string,
  feeSymbol: string = 'ETH',
  options: { minimumFeeRehearsal?: boolean } = {},
): { title: string; detail: string; technical?: string } {
  // A broadcast with no answer in time (phase 23 item 8): the outcome is
  // unknown, so it is never worded as "not sent" or "could not be sent".
  const outcome = describeBroadcastOutcome(error);
  if (outcome) return outcome;
  // A reverted gas estimate is a quote-step failure (nothing was attempted),
  // explained in one plain sentence rather than the node's "RPC error 3".
  if (error instanceof GasEstimateRevertError || (error as { name?: unknown } | null)?.name === 'GasEstimateRevertError') {
    return { title: ESTIMATE_REVERT_TITLE, detail: estimateRevertSentence(error as GasEstimateRevertError) };
  }
  const detail = error instanceof Error ? error.message : String(error);
  // Token sends (send-erc20.ts): the fee is paid in ETH, so an ETH
  // shortfall must never be titled with the token's symbol. This also
  // covers nodes rejecting a broadcast with "insufficient funds for
  // gas * price + value" on a value-0 token transaction.
  if (FEE_SHORTFALL.test(detail) || /insufficient funds for gas/i.test(detail)) {
    return { title: `Not enough ${feeSymbol} to pay the network fee.`, detail };
  }
  if (/exceeds the token balance/i.test(detail)) {
    return { title: `Not enough ${symbol}: the amount exceeds your token balance.`, detail };
  }
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
  if (REPLACEMENT_UNDERPRICED.test(detail)) {
    return {
      title: TX_REPLACEMENT_UNDERPRICED_TITLE,
      detail: `${TX_REPLACEMENT_UNDERPRICED_SENTENCE}\n\nTechnical detail: ${detail}`,
    };
  }
  if (BROADCAST_UNDERPRICED.test(detail)) {
    const rehearsal = options.minimumFeeRehearsal ? ` ${TX_UNDERPRICED_REHEARSAL_NOTE}` : '';
    return { title: TX_UNDERPRICED_TITLE, detail: `${TX_UNDERPRICED_SENTENCE}${rehearsal}\n\nTechnical detail: ${detail}` };
  }
  if (isEndpointFailure(error)) {
    // Transport-level failure (no answer, refused, rate limited): say so
    // plainly instead of implying the transaction itself was rejected.
    return {
      title: 'Could not reach the network endpoint. Check your connection.',
      detail,
    };
  }
  const httpAnswer = describeEndpointHttpAnswer(error);
  if (httpAnswer) return { title: 'The transaction could not be sent.', ...httpAnswer };
  return { title: 'The transaction could not be sent.', detail };
}

/**
 * A read that the endpoint answered with an HTTP error status that is not
 * an endpoint failure (isEndpointFailure: typically HTTP 400), in the
 * engine transports' wording "RPC HTTP error <status> for <method>"
 * (finding 3 of the phase 14 emulator pass: "RPC HTTP error 400 for
 * eth_getBlockByNumber" was shown raw under the quote title). Returns a
 * plain sentence plus the cleaned original text as a technical line
 * (../config/endpoint-probe.ts sanitizeEndpointMessage, the same pattern as
 * describeNetworkFailure). Broadcast methods (eth_send…, wallet_send…) are
 * left to the generic wording, because an HTTP error there does not tell
 * whether the transaction went out. Null for anything else.
 */
export function describeEndpointHttpAnswer(error: unknown): { detail: string; technical: string } | null {
  const raw = error instanceof Error ? error.message : String(error);
  const match = /\bRPC HTTP error (\d{3}) for ([A-Za-z0-9_]+)\b/.exec(raw);
  if (!match || /^(?:eth|wallet)_send/.test(match[2]!)) return null;
  return {
    detail:
      `The network endpoint answered a request for network data with an error (HTTP ${match[1]}) instead of ` +
      'the data. This is usually brief; try again in a moment.',
    technical: sanitizeEndpointMessage(raw),
  };
}
