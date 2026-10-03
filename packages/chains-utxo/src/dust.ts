/**
 * Per-chain dust policy: the smallest output value this wallet will ever
 * create, for recipient outputs and for change alike. Kept in its own
 * module with no imports so that address.ts (which attaches a policy to
 * each network) and coinselect.ts (which applies it) can both depend on it
 * without an import cycle.
 */

/**
 * The smallest output value (in the chain's base units: satoshis for
 * Bitcoin, koinu for Dogecoin) the wallet will create, per output script
 * type. Outputs below the applicable value are never created: a recipient
 * amount below it is refused with an error, and change below it is left to
 * the miner as extra fee.
 */
export interface DustPolicy {
  /** Minimum for P2PKH, P2SH and every other non-P2WPKH output script. */
  legacy: bigint;
  /** Minimum for P2WPKH outputs (segwit v0 key-hash). */
  p2wpkh: bigint;
}

/**
 * Bitcoin dust thresholds, verified against bitcoin/bitcoin
 * src/policy/policy.cpp (GetDustThreshold): an output is dust when spending
 * it would cost more in fees than it is worth, at the default dust relay
 * rate of 3000 sat/kvB. The source comments give the resulting numbers
 * directly:
 *   "182*dustRelayFee/1000 ... 546 satoshis" for a legacy P2PKH output, and
 *   "98*dustRelayFee/1000 ... 294 satoshis" for a segwit P2WPKH output.
 * Bitcoin Core treats an output as dust when its value is strictly below
 * the threshold, so an output of exactly 546 (or 294) satoshis is fine.
 */
export const DUST_P2PKH = 546n;
export const DUST_P2WPKH = 294n;

/** Bitcoin Core's policy, the default for any network without its own. */
export const BITCOIN_CORE_DUST_POLICY: DustPolicy = Object.freeze({
  legacy: DUST_P2PKH,
  p2wpkh: DUST_P2WPKH,
});

/**
 * Dogecoin dust limits, verified against dogecoin/dogecoin at tag v1.14.9
 * (the "Shibetoshi" release line). Dogecoin does not use Bitcoin's
 * fee-rate-derived dust formula; it uses two fixed amounts that apply to
 * every output script type alike:
 *
 *   src/amount.h:            static const CAmount COIN = 100000000;
 *   src/policy/policy.h:     static const CAmount RECOMMENDED_MIN_TX_FEE = COIN / 100;
 *   src/policy/policy.h:     static const CAmount DEFAULT_DUST_LIMIT = RECOMMENDED_MIN_TX_FEE;
 *   src/policy/policy.h:     static const CAmount DEFAULT_HARD_DUST_LIMIT = DEFAULT_DUST_LIMIT / 10;
 *
 * so the soft limit is 0.01 DOGE (1,000,000 koinu) and the hard limit is
 * 0.001 DOGE (100,000 koinu). CTxOut::IsDust in src/primitives/transaction.h
 * compares with a strict "nValue < dustLimit", so an output of exactly the
 * limit is not dust.
 *
 * - Hard limit: src/policy/policy.cpp IsStandardTx rejects a transaction
 *   with any output where txout.IsDust(nHardDustLimit), reason "dust", so
 *   such a transaction is non-standard and is neither accepted to the
 *   mempool nor relayed.
 * - Soft limit: src/dogecoin-fees.cpp GetDogecoinDustFee adds the soft
 *   limit (0.01 DOGE) to the required fee "for each output less than the
 *   (soft) dustlimit", and GetDogecoinMinRelayFee adds that to the minimum
 *   relay fee. src/validation.cpp AcceptToMemoryPoolWorker applies it to
 *   transactions arriving from peers (fLimitFree is true in
 *   src/net_processing.cpp), and with DEFAULT_LIMITFREERELAY = 0
 *   (src/validation.h) a transaction paying less is refused as "rate
 *   limited free transaction". The Dogecoin Core wallet applies the same
 *   surcharge when it builds transactions (src/wallet/wallet.cpp
 *   CWallet::GetRequiredFee), and its default change discard threshold is
 *   also 0.01 DOGE (DEFAULT_DISCARD_THRESHOLD = COIN / 100 in
 *   src/wallet/wallet.h).
 *
 * This wallet uses the SOFT limit as its dust threshold for both recipient
 * and change outputs. Because it never creates an output below 0.01 DOGE,
 * no transaction it builds is ever subject to the per-output surcharge, and
 * no surcharge arithmetic is needed in the fee calculation.
 */
export const DOGECOIN_SOFT_DUST_LIMIT = 1_000_000n; // 0.01 DOGE
export const DOGECOIN_HARD_DUST_LIMIT = 100_000n; // 0.001 DOGE

/** Dogecoin Core 1.14.9's policy as described above: one flat minimum. */
export const DOGECOIN_CORE_DUST_POLICY: DustPolicy = Object.freeze({
  legacy: DOGECOIN_SOFT_DUST_LIMIT,
  p2wpkh: DOGECOIN_SOFT_DUST_LIMIT,
});
