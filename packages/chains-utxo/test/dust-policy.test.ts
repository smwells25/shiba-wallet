import { describe, expect, it } from 'vitest';
import * as bitcoin from 'bitcoinjs-lib';
import { bitcoinKeyProvider, dogecoinKeyProvider, mnemonicToSeed } from '@shiba-wallet/core';
import {
  BITCOIN,
  BITCOIN_TESTNET,
  DOGECOIN,
  DOGECOIN_TESTNET,
  addressToScriptPubKey,
  p2pkhScript,
  p2wpkhScript,
  scriptPubKeyToAddress,
  type UtxoNetwork,
} from '../src/address.js';
import {
  DUST_P2PKH,
  DUST_P2WPKH,
  dustThreshold,
  estimateVsize,
  selectCoins,
  type Utxo,
} from '../src/coinselect.js';
import {
  BITCOIN_CORE_DUST_POLICY,
  DOGECOIN_CORE_DUST_POLICY,
  DOGECOIN_HARD_DUST_LIMIT,
  DOGECOIN_SOFT_DUST_LIMIT,
} from '../src/dust.js';
import { bytesToHex } from '../src/encoding.js';
import { buildTransfer } from '../src/transfer.js';
import { serializeTransaction, signTransaction } from '../src/tx.js';

/**
 * Per-chain dust policy. Dogecoin Core 1.14.9 (dogecoin/dogecoin at tag
 * v1.14.9, src/policy/policy.h) sets DEFAULT_DUST_LIMIT =
 * RECOMMENDED_MIN_TX_FEE = COIN / 100 (0.01 DOGE, the "soft" limit that
 * costs an extra 0.01 DOGE fee per output below it, src/dogecoin-fees.cpp
 * GetDogecoinDustFee) and DEFAULT_HARD_DUST_LIMIT = DEFAULT_DUST_LIMIT / 10
 * (0.001 DOGE, below which the transaction is non-standard). The wallet
 * uses the soft limit for every Dogecoin output; Bitcoin keeps Bitcoin
 * Core's 546 / 294 satoshis.
 */

const seed = mnemonicToSeed(
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
);

const DOGE_PER_KB_FLOOR = 1000; // the app's Dogecoin floor: 1000 koinu/byte = 0.01 DOGE/kB
// Dogecoin is legacy-only: 1-in 2-out P2PKH = 226 bytes, 1-in 1-out = 192.
const FEE_1IN_2OUT = 226_000n;
const FEE_1IN_1OUT = 192_000n;

const doge = dogecoinKeyProvider.deriveAccount(seed, 0, 0);
const dogeRecipient = dogecoinKeyProvider.deriveAccount(seed, 0, 1);

function dogeUtxo(value: bigint, vout = 0): Utxo {
  return { txid: '5a'.repeat(32), vout, value };
}

function buildDoge(amount: bigint, utxos: Utxo[], network: UtxoNetwork = DOGECOIN) {
  return buildTransfer({
    network,
    fromAddress: doge.address,
    utxos,
    toAddress: dogeRecipient.address,
    amount,
    feeRate: DOGE_PER_KB_FLOOR,
    version: 1,
  });
}

describe('dust policy constants', () => {
  it('keeps Bitcoin Core thresholds and adds the verified Dogecoin limits', () => {
    expect(DUST_P2PKH).toBe(546n);
    expect(DUST_P2WPKH).toBe(294n);
    expect(BITCOIN_CORE_DUST_POLICY).toEqual({ legacy: 546n, p2wpkh: 294n });
    // COIN = 100000000 (src/amount.h); soft = COIN / 100, hard = soft / 10.
    expect(DOGECOIN_SOFT_DUST_LIMIT).toBe(100_000_000n / 100n);
    expect(DOGECOIN_HARD_DUST_LIMIT).toBe(DOGECOIN_SOFT_DUST_LIMIT / 10n);
    expect(DOGECOIN_CORE_DUST_POLICY).toEqual({ legacy: 1_000_000n, p2wpkh: 1_000_000n });
  });

  it('attaches the right policy to each built-in network', () => {
    expect(BITCOIN.dustPolicy).toBe(BITCOIN_CORE_DUST_POLICY);
    expect(BITCOIN_TESTNET.dustPolicy).toBe(BITCOIN_CORE_DUST_POLICY);
    expect(DOGECOIN.dustPolicy).toBe(DOGECOIN_CORE_DUST_POLICY);
    expect(DOGECOIN_TESTNET.dustPolicy).toBe(DOGECOIN_CORE_DUST_POLICY);
  });

  it('dustThreshold defaults to Bitcoin Core and honours a chain policy', () => {
    const pkh = p2pkhScript(new Uint8Array(20).fill(2));
    const wpkh = p2wpkhScript(new Uint8Array(20).fill(1));
    expect(dustThreshold(pkh)).toBe(546n);
    expect(dustThreshold(wpkh)).toBe(294n);
    expect(dustThreshold(pkh, DOGECOIN_CORE_DUST_POLICY)).toBe(1_000_000n);
  });
});

describe('Dogecoin recipient outputs', () => {
  const utxos = [dogeUtxo(500_000_000n)];

  it.each([
    ['one koinu below the soft limit', 999_999n],
    ['exactly the hard limit (0.001 DOGE)', 100_000n],
    ["Bitcoin Core's P2PKH floor", 546n],
    ['one koinu', 1n],
  ])('refuses %s with a plain-language dust error', (_label, amount) => {
    expect(() => buildDoge(amount, utxos)).toThrow(
      /below the Dogecoin dust limit: the smallest output this wallet will create is 0\.01 \(1000000 base units\)/,
    );
  });

  it('accepts exactly the soft limit (Dogecoin Core treats only "nValue < limit" as dust)', () => {
    const built = buildDoge(DOGECOIN_SOFT_DUST_LIMIT, utxos);
    expect(built.tx.outputs[0]!.value).toBe(1_000_000n);
  });

  it('applies the same limit on Dogecoin testnet', () => {
    const testnetFrom = dogecoinKeyProvider.deriveAccount(seed, 0, 0);
    expect(() =>
      buildTransfer({
        network: DOGECOIN_TESTNET,
        fromAddress: toTestnet(testnetFrom.address),
        utxos,
        toAddress: toTestnet(testnetFrom.address),
        amount: 999_999n,
        feeRate: DOGE_PER_KB_FLOOR,
      }),
    ).toThrow(/below the Dogecoin testnet dust limit/);
  });
});

describe('Dogecoin change outputs', () => {
  const amount = 100_000_000n; // 1 DOGE

  it('sanity: the fee arithmetic these cases rely on', () => {
    const pkh = addressToScriptPubKey(doge.address, DOGECOIN);
    expect(estimateVsize('p2pkh', 1, [pkh, pkh])).toBe(226);
    expect(estimateVsize('p2pkh', 1, [pkh])).toBe(192);
  });

  it('keeps change of exactly 0.01 DOGE', () => {
    const built = buildDoge(amount, [dogeUtxo(amount + FEE_1IN_2OUT + DOGECOIN_SOFT_DUST_LIMIT)]);
    expect(built.tx.outputs).toHaveLength(2);
    expect(built.tx.outputs[1]!.value).toBe(DOGECOIN_SOFT_DUST_LIMIT);
    expect(built.fee).toBe(FEE_1IN_2OUT);
  });

  it('folds change one koinu below 0.01 DOGE into the fee', () => {
    const input = amount + FEE_1IN_2OUT + DOGECOIN_SOFT_DUST_LIMIT - 1n;
    const built = buildDoge(amount, [dogeUtxo(input)]);
    expect(built.tx.outputs).toHaveLength(1);
    expect(built.fee).toBe(input - amount);
    expect(built.fee).toBe(FEE_1IN_2OUT + 999_999n);
  });

  it('folds change in the old 546..999,999 koinu gap that Bitcoin thresholds allowed', () => {
    // 0.006 DOGE of would-be change: above Bitcoin Core's 546 sat floor (so
    // the old generic rule created it) but below Dogecoin's soft limit.
    const input = amount + FEE_1IN_2OUT + 600_000n;
    const withDogePolicy = buildDoge(amount, [dogeUtxo(input)]);
    expect(withDogePolicy.tx.outputs).toHaveLength(1);
    expect(withDogePolicy.fee).toBe(input - amount);

    // The same selection under Bitcoin Core's policy would have created it.
    const pkh = addressToScriptPubKey(doge.address, DOGECOIN);
    const generic = selectCoins({
      utxos: [dogeUtxo(input)],
      outputs: [{ value: amount, scriptPubKey: pkh }],
      feeRate: DOGE_PER_KB_FLOOR,
      inputKind: 'p2pkh',
      changeScriptPubKey: pkh,
    });
    expect(generic.change?.value).toBe(600_000n);
  });

  it('folds a remainder smaller than the change-output fee itself', () => {
    // Enough for the 1-out transaction but not for a change output at all.
    const input = amount + FEE_1IN_1OUT + 10_000n;
    const built = buildDoge(amount, [dogeUtxo(input)]);
    expect(built.tx.outputs).toHaveLength(1);
    expect(built.fee).toBe(FEE_1IN_1OUT + 10_000n);
  });

  it('never creates any output below 0.01 DOGE across a sweep of amounts and coins', () => {
    const coins = [
      dogeUtxo(1_234_567n, 0),
      dogeUtxo(250_000_000n, 1),
      dogeUtxo(3_000_000n, 2),
      dogeUtxo(100_456_789n, 3),
    ];
    const total = coins.reduce((s, u) => s + u.value, 0n);
    let built = 0;
    for (let a = 1_000_000n; a < total; a += 997_331n) {
      let result;
      try {
        result = buildDoge(a, coins);
      } catch (err) {
        expect(String(err)).toMatch(/Insufficient funds/);
        continue;
      }
      built++;
      for (const out of result.tx.outputs) expect(out.value).toBeGreaterThanOrEqual(DOGECOIN_SOFT_DUST_LIMIT);
      const inSum = result.tx.inputs.reduce((s, i) => s + i.value, 0n);
      const outSum = result.tx.outputs.reduce((s, o) => s + o.value, 0n);
      expect(inSum - outSum).toBe(result.fee);
    }
    expect(built).toBeGreaterThan(300);
  });

  it('signs a folded-change Dogecoin transfer that bitcoinjs-lib decodes to one output', () => {
    const input = amount + FEE_1IN_2OUT + 600_000n;
    const result = buildDoge(amount, [dogeUtxo(input)]);
    const signed = signTransaction(result.tx, doge);
    const parsed = bitcoin.Transaction.fromHex(
      bytesToHex(serializeTransaction(signed.tx, signed.signedInputs)),
    );
    expect(parsed.version).toBe(1);
    expect(parsed.outs).toHaveLength(1);
    expect(BigInt(parsed.outs[0]!.value)).toBe(amount);
  });
});

describe('Bitcoin behaviour is unchanged', () => {
  // Raw signed transactions produced by the engine BEFORE per-chain dust
  // policy existed (commit f84f6e8 dist build), pinned byte for byte.
  const account = bitcoinKeyProvider.deriveAccount(seed, 0, 0);
  const recipient = bitcoinKeyProvider.deriveAccount(seed, 0, 1);
  const utxos: Utxo[] = [
    { txid: '75ddabb27b8845f5247975c8a5ba7c6f336c4570708ebe230caf6db5217ae858', vout: 0, value: 80_000n },
    { txid: '1dea7cd05979072a3578cab271c02244ea8a090bbb46aa680a65ecd027048d83', vout: 3, value: 20_000n },
  ];
  const pinned: Array<[string, bigint, number, bigint, string]> = [
    [
      'one input with change',
      50_000n,
      2,
      282n,
      '0200000000010158e87a21b56daf0c23be8e7070456c336f7cbaa5c8757924f545887bb2abdd750000000000ffffffff0250c30000000000001600149c90f934ea51fa0f6504177043e0908da69299831674000000000000160014c0cebcd6c3d3ca8c75dc5ec62ebe55330ef910e202473044022057a11f91f551d0288fa4820be81b8416367d9833b2db40b89e9c7f7c96fc2c3f02202e4d10620f9b650957150fc5613579ba18dbdb15c35f01ab51db6e4e26f0267901210330d54fd0dd420a6e5f8d3624f5f3482cae350f79d5f0753bf5beef9c2d91af3c00000000',
    ],
    [
      'sub-dust change folded into the fee',
      79_700n,
      1,
      300n,
      '0200000000010158e87a21b56daf0c23be8e7070456c336f7cbaa5c8757924f545887bb2abdd750000000000ffffffff0154370100000000001600149c90f934ea51fa0f6504177043e0908da692998302483045022100d0090ad3db07f02b607de3347d6b077975d552c04a8e55d8e0a9de9d4ffd1ef7022010ddfa37623404ca2f4696091df0267e24645d1f5b7a0dd5507dff4a7040d29c01210330d54fd0dd420a6e5f8d3624f5f3482cae350f79d5f0753bf5beef9c2d91af3c00000000',
    ],
    [
      'two inputs with change',
      90_000n,
      1,
      209n,
      '0200000000010258e87a21b56daf0c23be8e7070456c336f7cbaa5c8757924f545887bb2abdd750000000000ffffffff838d0427d0ec650a68aa46bb0b098aea4422c071b2ca78352a077959d07cea1d0300000000ffffffff02905f0100000000001600149c90f934ea51fa0f6504177043e0908da69299833f26000000000000160014c0cebcd6c3d3ca8c75dc5ec62ebe55330ef910e202483045022100ca996f476101bcec1d56e6c4a739e29421befb802f9721f5ecfce91aec756fef022027953da4f8b66ade6f2ca938159a3df025cb07a5cbd0fef701aa00cb92b5ad8e01210330d54fd0dd420a6e5f8d3624f5f3482cae350f79d5f0753bf5beef9c2d91af3c02483045022100fe9a6c0932d2e8c43d16e46bddc274060fa662548bc1f042bc5110bcb831c6a102202b5392687a5bf95443eae80cde6e5a916f178b4fd20db6273278121ed5ed7d2901210330d54fd0dd420a6e5f8d3624f5f3482cae350f79d5f0753bf5beef9c2d91af3c00000000',
    ],
    [
      'a 546 sat payment to a P2WPKH recipient',
      546n,
      1,
      141n,
      '0200000000010158e87a21b56daf0c23be8e7070456c336f7cbaa5c8757924f545887bb2abdd750000000000ffffffff0222020000000000001600149c90f934ea51fa0f6504177043e0908da6929983d135010000000000160014c0cebcd6c3d3ca8c75dc5ec62ebe55330ef910e202473044022069da0f30d21b6c0d65dd2cac5747fca12dc0f2735c86e2210320766bc028be79022049cbd8609ddf0829c7f692804d971a70c0602564acac8bcf20a80167b4c4be4c01210330d54fd0dd420a6e5f8d3624f5f3482cae350f79d5f0753bf5beef9c2d91af3c00000000',
    ],
  ];

  it.each(pinned)('%s: byte-identical to the pre-change engine', (_label, amount, feeRate, fee, rawHex) => {
    const built = buildTransfer({
      network: BITCOIN,
      fromAddress: account.address,
      utxos,
      toAddress: recipient.address,
      amount,
      feeRate,
    });
    expect(built.fee).toBe(fee);
    const signed = signTransaction(built.tx, account);
    expect(bytesToHex(serializeTransaction(signed.tx, signed.signedInputs))).toBe(rawHex);
  });

  it('a network object without a dustPolicy behaves exactly like BITCOIN', () => {
    const { dustPolicy: _omitted, ...bare } = BITCOIN;
    for (const [, amount, feeRate] of pinned) {
      const params = { fromAddress: account.address, utxos, toAddress: recipient.address, amount, feeRate };
      expect(buildTransfer({ network: bare, ...params })).toEqual(buildTransfer({ network: BITCOIN, ...params }));
    }
  });

  it('refuses a Bitcoin recipient output below its Bitcoin Core dust threshold', () => {
    expect(() =>
      buildTransfer({
        network: BITCOIN,
        fromAddress: account.address,
        utxos,
        toAddress: recipient.address, // P2WPKH: 294 sat threshold
        amount: 293n,
        feeRate: 1,
      }),
    ).toThrow(/below the Bitcoin dust limit: the smallest output this wallet will create is 0\.00000294 \(294 base units\)/);
  });
});

/** Re-encodes a Dogecoin mainnet P2PKH address under the testnet version byte. */
function toTestnet(mainnetAddress: string): string {
  return scriptPubKeyToAddress(addressToScriptPubKey(mainnetAddress, DOGECOIN), DOGECOIN_TESTNET);
}
