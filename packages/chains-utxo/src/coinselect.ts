import { isP2wpkhScript } from './address.js';
import { BITCOIN_CORE_DUST_POLICY, type DustPolicy } from './dust.js';
import { varIntSize } from './encoding.js';
import type { TransactionOutput } from './tx.js';

/**
 * Fee estimation and greedy coin selection. All arithmetic is in integer
 * satoshis (bigint) except the fee rate, which is the conventional sat/vB
 * number. Sizes are computed in weight units and converted to vsize with
 * the consensus ceil(weight / 4) rule so segwit's discount is exact.
 */

/** An unspent output as reported by the backend (Esplora-style). */
export interface Utxo {
  txid: string;
  vout: number;
  /** Value in satoshis. */
  value: bigint;
}

export type InputKind = 'p2pkh' | 'p2wpkh';

// The dust constants live in dust.ts (with their source citations) and are
// re-exported here so existing imports from this module keep working.
export { DUST_P2PKH, DUST_P2WPKH } from './dust.js';

/**
 * Dust threshold for the script an output would be locked to, under the
 * given chain policy (Bitcoin Core's 546 / 294 when none is given, which is
 * what every existing caller without a policy has always received).
 */
export function dustThreshold(
  scriptPubKey: Uint8Array,
  policy: DustPolicy = BITCOIN_CORE_DUST_POLICY,
): bigint {
  return isP2wpkhScript(scriptPubKey) ? policy.p2wpkh : policy.legacy;
}

/**
 * Weight (in weight units, 4 per non-witness byte) of one input, including
 * its share of witness data. Sizes assume a 72-byte DER signature (the
 * worst case with low-S) and a 33-byte compressed public key.
 *
 * - P2PKH input: 32 txid + 4 vout + 1 script length + 107 scriptSig
 *   (1+72 signature push, 1+33 pubkey push) + 4 sequence = 148 bytes,
 *   all non-witness: 592 WU.
 * - P2WPKH input: 41 non-witness bytes (32+4+1 empty script+4) = 164 WU,
 *   plus witness (1 item count + 1+72 signature + 1+33 pubkey = 108 bytes)
 *   at 1 WU each: 272 WU total, i.e. the familiar 68 vB estimate.
 */
const INPUT_WEIGHT: Record<InputKind, number> = {
  p2pkh: 148 * 4,
  p2wpkh: 41 * 4 + 108,
};

/** Weight of one serialized output: 8 value + CompactSize + script bytes. */
function outputWeight(scriptPubKey: Uint8Array): number {
  return (8 + varIntSize(scriptPubKey.length) + scriptPubKey.length) * 4;
}

/**
 * Estimated virtual size of a transaction with `inputCount` inputs of one
 * kind and the given output scripts. Overhead is version (4) + locktime (4)
 * + the two CompactSize counts, plus the segwit marker/flag pair (2 WU)
 * when any input carries a witness.
 */
export function estimateVsize(
  inputKind: InputKind,
  inputCount: number,
  outputScripts: Uint8Array[],
): number {
  let weight =
    (4 + 4 + varIntSize(inputCount) + varIntSize(outputScripts.length)) * 4 +
    inputCount * INPUT_WEIGHT[inputKind];
  if (inputKind === 'p2wpkh' && inputCount > 0) weight += 2; // marker + flag
  for (const script of outputScripts) weight += outputWeight(script);
  return Math.ceil(weight / 4);
}

/** Fee in satoshis for a vsize at the given rate, rounded up. */
export function feeForVsize(vsize: number, feeRateSatPerVb: number): bigint {
  if (!(feeRateSatPerVb > 0)) throw new Error(`Fee rate must be positive, got ${feeRateSatPerVb}`);
  return BigInt(Math.ceil(vsize * feeRateSatPerVb));
}

export interface CoinSelectionParams {
  utxos: Utxo[];
  /** The recipient outputs the transaction must pay. */
  outputs: TransactionOutput[];
  /** Fee rate in satoshis per virtual byte. */
  feeRate: number;
  /** Script template of the wallet's own UTXOs (all inputs are one kind). */
  inputKind: InputKind;
  /** Where change would go; decides the change output's size and dust floor. */
  changeScriptPubKey: Uint8Array;
  /**
   * The chain's dust policy (UtxoNetwork.dustPolicy). Defaults to Bitcoin
   * Core's thresholds; Dogecoin must pass DOGECOIN_CORE_DUST_POLICY, which
   * buildTransfer does automatically from the network.
   */
  dustPolicy?: DustPolicy;
}

export interface CoinSelectionResult {
  /** The chosen UTXOs, largest first. */
  inputs: Utxo[];
  /** Total fee the transaction will pay. */
  fee: bigint;
  /** Change output to append, or undefined when change would be dust. */
  change: TransactionOutput | undefined;
}

/**
 * Greedy largest-first selection: spend the biggest coins until the target
 * plus fees is covered. Simple and predictable; it minimizes input count
 * (and therefore fees) at the cost of consolidating value, which is a fine
 * default for a mobile wallet. After each added input we check two exits:
 *
 * 1. Funds cover target + fee for a transaction that includes a change
 *    output, with enough left over that the change clears its dust floor:
 *    finish with change.
 * 2. Funds cover target + fee without change: finish without change and
 *    let the sub-dust remainder go to the miner as extra fee.
 */
export function selectCoins(params: CoinSelectionParams): CoinSelectionResult {
  const { utxos, outputs, feeRate, inputKind, changeScriptPubKey } = params;
  const target = outputs.reduce((sum, o) => sum + o.value, 0n);
  const outputScripts = outputs.map((o) => o.scriptPubKey);
  const changeDust = dustThreshold(changeScriptPubKey, params.dustPolicy);

  const sorted = [...utxos].sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));
  const selected: Utxo[] = [];
  let total = 0n;

  for (const utxo of sorted) {
    selected.push(utxo);
    total += utxo.value;

    const feeWithChange = feeForVsize(
      estimateVsize(inputKind, selected.length, [...outputScripts, changeScriptPubKey]),
      feeRate,
    );
    if (total >= target + feeWithChange + changeDust) {
      return {
        inputs: selected,
        fee: feeWithChange,
        change: { value: total - target - feeWithChange, scriptPubKey: changeScriptPubKey },
      };
    }

    const feeNoChange = feeForVsize(estimateVsize(inputKind, selected.length, outputScripts), feeRate);
    if (total >= target + feeNoChange) {
      // Everything above the target is fee: the leftover is below the dust
      // floor, so a change output would be unrelayable anyway.
      return { inputs: selected, fee: total - target, change: undefined };
    }
  }

  throw new Error(
    `Insufficient funds: have ${total} sat across ${utxos.length} UTXOs, ` +
      `need ${target} sat plus fees at ${feeRate} sat/vB`,
  );
}
