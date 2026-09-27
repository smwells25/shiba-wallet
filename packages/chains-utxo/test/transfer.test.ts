import { describe, expect, it } from 'vitest';
import * as bitcoin from 'bitcoinjs-lib';
import { bitcoinKeyProvider, mnemonicToSeed } from '@shiba-wallet/core';
import { BITCOIN } from '../src/address.js';
import { buildTransfer, signAndBroadcast } from '../src/transfer.js';
import { esploraTransport, type UtxoTransport } from '../src/transport.js';
import type { Utxo } from '../src/coinselect.js';

const seed = mnemonicToSeed(
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
);
const account = bitcoinKeyProvider.deriveAccount(seed, 0, 0);
const recipient = bitcoinKeyProvider.deriveAccount(seed, 0, 1);

const utxos: Utxo[] = [
  { txid: '75ddabb27b8845f5247975c8a5ba7c6f336c4570708ebe230caf6db5217ae858', vout: 0, value: 80_000n },
  { txid: '1dea7cd05979072a3578cab271c02244ea8a090bbb46aa680a65ecd027048d83', vout: 3, value: 20_000n },
];

describe('buildTransfer (pure, offline)', () => {
  it('lays out inputs from selection and recipient + change outputs', () => {
    const built = buildTransfer({
      network: BITCOIN,
      fromAddress: account.address,
      utxos,
      toAddress: recipient.address,
      amount: 50_000n,
      feeRate: 2,
    });
    expect(built.inputKind).toBe('p2wpkh');
    expect(built.tx.inputs).toHaveLength(1); // 80k coin alone covers it
    expect(built.tx.outputs[0]!.value).toBe(50_000n);
    // input value = amount + fee + change, conservation of satoshis
    const change = built.tx.outputs[1]!.value;
    expect(80_000n).toBe(50_000n + built.fee + change);
  });

  it('rejects taproot recipients loudly', () => {
    expect(() =>
      buildTransfer({
        network: BITCOIN,
        fromAddress: account.address,
        utxos,
        toAddress: 'bc1p' + 'q'.repeat(55), // malformed anyway, must not be silently accepted
        amount: 1_000n,
        feeRate: 1,
      }),
    ).toThrow();
  });
});

describe('signAndBroadcast', () => {
  it('broadcasts a transaction that bitcoinjs-lib parses to the same txid', async () => {
    const built = buildTransfer({
      network: BITCOIN,
      fromAddress: account.address,
      utxos,
      toAddress: recipient.address,
      amount: 90_000n, // forces both inputs to be spent
      feeRate: 1,
    });
    expect(built.tx.inputs).toHaveLength(2);

    let broadcastHex = '';
    const transport: UtxoTransport = {
      getUtxos: async () => utxos,
      // Independent check: hand the raw hex to bitcoinjs-lib and let IT
      // compute the txid we must match.
      broadcastTx: async (rawTxHex) => {
        broadcastHex = rawTxHex;
        return bitcoin.Transaction.fromHex(rawTxHex).getId();
      },
    };

    const txid = await signAndBroadcast(built, account, transport);
    expect(txid).toMatch(/^[0-9a-f]{64}$/);
    // The broadcast transaction spends both inputs with witnesses present.
    const parsed = bitcoin.Transaction.fromHex(broadcastHex);
    expect(parsed.ins).toHaveLength(2);
    expect(parsed.ins.every((i) => i.witness.length === 2)).toBe(true);
  });

  it('fails when the backend reports a different txid', async () => {
    const built = buildTransfer({
      network: BITCOIN,
      fromAddress: account.address,
      utxos,
      toAddress: recipient.address,
      amount: 10_000n,
      feeRate: 1,
    });
    const transport: UtxoTransport = {
      getUtxos: async () => utxos,
      broadcastTx: async () => 'ff'.repeat(32),
    };
    await expect(signAndBroadcast(built, account, transport)).rejects.toThrow(
      /does not match local txid/,
    );
  });
});

describe('esploraTransport', () => {
  it('GETs address UTXOs and converts values to bigint sats', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push({ url, ...(init ? { init } : {}) });
      return new Response(
        JSON.stringify([{ txid: 'ab'.repeat(32), vout: 1, value: 12345, status: {} }]),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const transport = esploraTransport('https://example.invalid/api/', fetchFn);
    const result = await transport.getUtxos('bc1qexample');
    expect(calls[0]!.url).toBe('https://example.invalid/api/address/bc1qexample/utxo');
    expect(result).toEqual([{ txid: 'ab'.repeat(32), vout: 1, value: 12345n }]);
  });

  it('POSTs raw hex to /tx and returns the txid body', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push({ url, ...(init ? { init } : {}) });
      return new Response('cd'.repeat(32), { status: 200 });
    }) as unknown as typeof fetch;

    const transport = esploraTransport('https://example.invalid/api', fetchFn);
    const txid = await transport.broadcastTx('0200deadbeef');
    expect(calls[0]!.url).toBe('https://example.invalid/api/tx');
    expect(calls[0]!.init?.method).toBe('POST');
    expect(calls[0]!.init?.body).toBe('0200deadbeef');
    expect(txid).toBe('cd'.repeat(32));
  });

  it('surfaces the node rejection reason on broadcast failure', async () => {
    const fetchFn = (async () =>
      new Response('sendrawtransaction RPC error: min relay fee not met', {
        status: 400,
      })) as unknown as typeof fetch;
    const transport = esploraTransport('https://example.invalid/api', fetchFn);
    await expect(transport.broadcastTx('00')).rejects.toThrow(
      /HTTP 400: sendrawtransaction RPC error: min relay fee not met/,
    );
  });
});
