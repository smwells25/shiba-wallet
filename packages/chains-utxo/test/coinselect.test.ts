import { describe, expect, it } from 'vitest';
import {
  DUST_P2PKH,
  DUST_P2WPKH,
  dustThreshold,
  estimateVsize,
  feeForVsize,
  selectCoins,
  type Utxo,
} from '../src/coinselect.js';
import { p2pkhScript, p2wpkhScript } from '../src/address.js';

const wpkh = p2wpkhScript(new Uint8Array(20).fill(1));
const pkh = p2pkhScript(new Uint8Array(20).fill(2));

function utxo(value: bigint, vout = 0): Utxo {
  return { txid: 'aa'.repeat(32), vout, value };
}

describe('size and fee estimation', () => {
  it('matches the textbook 1-in 2-out sizes', () => {
    // Classic reference numbers: a 1-input 2-output P2WPKH transaction is
    // 141 vB, and its all-legacy P2PKH counterpart is 226 bytes.
    expect(estimateVsize('p2wpkh', 1, [wpkh, wpkh])).toBe(141);
    expect(estimateVsize('p2pkh', 1, [pkh, pkh])).toBe(226);
  });

  it('rounds fees up and rejects nonpositive rates', () => {
    expect(feeForVsize(141, 1)).toBe(141n);
    expect(feeForVsize(141, 1.5)).toBe(212n); // 211.5 rounds up
    expect(() => feeForVsize(100, 0)).toThrow(/must be positive/);
  });

  it('applies the verified dust floors per script type', () => {
    expect(dustThreshold(wpkh)).toBe(DUST_P2WPKH);
    expect(dustThreshold(pkh)).toBe(DUST_P2PKH);
    expect(DUST_P2WPKH).toBe(294n);
    expect(DUST_P2PKH).toBe(546n);
  });
});

describe('greedy largest-first selection', () => {
  it('spends the largest coins first', () => {
    const result = selectCoins({
      utxos: [utxo(1_000n, 0), utxo(50_000n, 1), utxo(30_000n, 2)],
      outputs: [{ value: 40_000n, scriptPubKey: wpkh }],
      feeRate: 1,
      inputKind: 'p2wpkh',
      changeScriptPubKey: wpkh,
    });
    expect(result.inputs.map((u) => u.vout)).toEqual([1]);
    expect(result.fee).toBe(141n); // 1-in 2-out at 1 sat/vB
    expect(result.change?.value).toBe(50_000n - 40_000n - 141n);
  });

  it('adds more inputs when one is not enough', () => {
    const result = selectCoins({
      utxos: [utxo(30_000n, 0), utxo(20_000n, 1), utxo(50_000n, 2)],
      outputs: [{ value: 70_000n, scriptPubKey: wpkh }],
      feeRate: 2,
      inputKind: 'p2wpkh',
      changeScriptPubKey: wpkh,
    });
    expect(result.inputs.map((u) => u.vout)).toEqual([2, 0]);
    // 2-in 2-out p2wpkh = 209 vB, so 418 sat at 2 sat/vB.
    expect(result.fee).toBe(418n);
    expect(result.change?.value).toBe(80_000n - 70_000n - 418n);
  });

  it('drops sub-dust change into the fee', () => {
    // 10 300 sat coin, sending 10 000: after the 1-in 1-out fee (110 sat)
    // only 190 sat remain, below the 294 sat P2WPKH dust floor, so no
    // change output is created and the remainder goes to the miner.
    const result = selectCoins({
      utxos: [utxo(10_300n)],
      outputs: [{ value: 10_000n, scriptPubKey: wpkh }],
      feeRate: 1,
      inputKind: 'p2wpkh',
      changeScriptPubKey: wpkh,
    });
    expect(result.change).toBeUndefined();
    expect(result.fee).toBe(300n);
    expect(estimateVsize('p2wpkh', 1, [wpkh])).toBe(110);
  });

  it('accounts for the change output before declaring coverage', () => {
    // Exactly enough for target + no-change fee, but nowhere near enough
    // for a change output: must finish without change, not overshoot.
    const result = selectCoins({
      utxos: [utxo(10_110n)],
      outputs: [{ value: 10_000n, scriptPubKey: wpkh }],
      feeRate: 1,
      inputKind: 'p2wpkh',
      changeScriptPubKey: wpkh,
    });
    expect(result.change).toBeUndefined();
    expect(result.fee).toBe(110n);
  });

  it('throws a descriptive error on insufficient funds', () => {
    expect(() =>
      selectCoins({
        utxos: [utxo(1_000n)],
        outputs: [{ value: 5_000n, scriptPubKey: wpkh }],
        feeRate: 1,
        inputKind: 'p2wpkh',
        changeScriptPubKey: wpkh,
      }),
    ).toThrow(/Insufficient funds: have 1000 sat/);
  });
});
