import type { DerivedAccount } from '@shiba-wallet/core';
import { toChecksumAddress } from '@shiba-wallet/core';
import {
  NodeClient,
  decodeUint256,
  encodeFunctionCall,
  httpTransport as evmHttpTransport,
  minimalBytes,
  rlpEncode,
  signEip1559,
  simulateCall,
  toBytes,
  toHex,
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
import { endpointHost, isEndpointFailure } from '../config/endpoint-probe.ts';
// Pure data with no imports (see its file comment), so no cycle.
import { evmProfileByCaip2 } from '../config/evm-chain.ts';

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
  data?: Uint8Array,
  expectedCaip2: string = EVM_CHAIN_ID,
): Promise<EvmSendQuote> {
  const transport = evmHttpTransport(url);
  const node = new NodeClient(transport);

  const [chainId, balance, nonce, fees] = await Promise.all([
    node.chainId(),
    node.getBalance(from),
    node.getTransactionCount(from),
    node.suggestFees(),
  ]);

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

  const dataHex = data && data.length > 0 ? toHex(data) : undefined;
  let gasLimit: bigint;
  try {
    gasLimit = await node.estimateGas({ from, to, value: amount, data: dataHex });
  } catch {
    try {
      gasLimit = await node.estimateGas({ from, to, value: 0n, data: dataHex });
    } catch (error) {
      throw asEstimateRevert(error, dataHex === undefined);
    }
  }

  // OP-stack chains only (config/evm-chain.ts l1DataFee): price the exact
  // unsigned transaction sendEvm will sign. Other chains make no extra call.
  const opStack = chainHasL1DataFee(chainId)
    ? await quoteOpStackFees(transport, {
        chainId,
        nonce,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        maxFeePerGas: fees.maxFeePerGas,
        gasLimit,
        to,
        value: amount,
        ...(data && data.length > 0 ? { data } : {}),
      })
    : undefined;

  const fee = gasLimit * fees.maxFeePerGas + opStackFeeTotal(opStack);
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
    node.suggestFees(),
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
 * the account. Never called for a send the node refused. Returns the
 * unsubscribe function.
 */
export function addEvmSentListener(listener: EvmSentListener): () => void {
  evmSentListeners.add(listener);
  return () => {
    evmSentListeners.delete(listener);
  };
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
  const txid = await node.sendRawTransaction(signed.rawHex);
  notifyEvmSent({ from: signer.address, quote, txid });
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
 */
export function describeSendError(error: unknown, symbol: string): { title: string; detail: string } {
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
  if (/not enough eth to pay the network fee/i.test(detail) || /insufficient funds for gas/i.test(detail)) {
    return { title: 'Not enough ETH to pay the network fee.', detail };
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
  if (isEndpointFailure(error)) {
    // Transport-level failure (no answer, refused, rate limited): say so
    // plainly instead of implying the transaction itself was rejected.
    return {
      title: 'Could not reach the network endpoint. Check your connection.',
      detail,
    };
  }
  return { title: 'The transaction could not be sent.', detail };
}
