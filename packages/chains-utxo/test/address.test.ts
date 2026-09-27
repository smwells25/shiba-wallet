import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import * as bitcoin from 'bitcoinjs-lib';
import { bech32, bech32m } from '@scure/base';
import { hexToBytes } from '@noble/hashes/utils.js';
import {
  addressToScriptPubKey,
  BITCOIN,
  DOGECOIN,
  p2shScript,
  p2wpkhScript,
  scriptPubKeyToAddress,
} from '../src/address.js';
import { bytesToHex } from '../src/encoding.js';

/** bitcoinjs-lib's independent decoding of the same address. */
function bjsScript(address: string, network: bitcoin.networks.Network): string {
  return bitcoin.address.toOutputScript(address, network).toString('hex');
}

const dogeNetwork: bitcoin.networks.Network = {
  ...bitcoin.networks.bitcoin,
  messagePrefix: '\x19Dogecoin Signed Message:\n',
  bech32: '',
  pubKeyHash: 0x1e,
  scriptHash: 0x16,
  wif: 0x9e,
};

// Deterministic fixture addresses built from fixed hashes via bitcoinjs,
// then decoded by our code — so the two implementations must agree.
const hash20 = hexToBytes('79b000887626b294a914501a4cd226b58b235983');
const bech32Addr = bitcoin.payments.p2wpkh({ hash: Buffer.from(hash20) }).address!;
const p2pkhAddr = bitcoin.payments.p2pkh({ hash: Buffer.from(hash20) }).address!;
const p2shAddr = bitcoin.payments.p2sh({ hash: Buffer.from(hash20) }).address!;
const dogeP2pkhAddr = bitcoin.payments.p2pkh({
  hash: Buffer.from(hash20),
  network: dogeNetwork,
}).address!;
const dogeP2shAddr = bitcoin.payments.p2sh({
  hash: Buffer.from(hash20),
  network: dogeNetwork,
}).address!;

describe('address decoding matches bitcoinjs-lib', () => {
  it.each([
    ['bech32 P2WPKH', bech32Addr],
    ['base58 P2PKH', p2pkhAddr],
    ['base58 P2SH', p2shAddr],
  ])('Bitcoin %s', (_label, address) => {
    expect(bytesToHex(addressToScriptPubKey(address, BITCOIN))).toBe(
      bjsScript(address, bitcoin.networks.bitcoin),
    );
  });

  it.each([
    ['P2PKH', dogeP2pkhAddr],
    ['P2SH', dogeP2shAddr],
  ])('Dogecoin %s', (_label, address) => {
    expect(bytesToHex(addressToScriptPubKey(address, DOGECOIN))).toBe(
      bjsScript(address, dogeNetwork),
    );
  });

  it('accepts uppercase bech32 (BIP-173 allows all-upper)', () => {
    expect(bytesToHex(addressToScriptPubKey(bech32Addr.toUpperCase(), BITCOIN))).toBe(
      bytesToHex(p2wpkhScript(hash20)),
    );
  });
});

describe('address round-trips', () => {
  it.each([
    ['Bitcoin P2WPKH', bech32Addr, BITCOIN],
    ['Bitcoin P2PKH', p2pkhAddr, BITCOIN],
    ['Bitcoin P2SH', p2shAddr, BITCOIN],
    ['Dogecoin P2PKH', dogeP2pkhAddr, DOGECOIN],
    ['Dogecoin P2SH', dogeP2shAddr, DOGECOIN],
  ])('%s: address -> script -> address', (_label, address, network) => {
    const script = addressToScriptPubKey(address, network);
    expect(scriptPubKeyToAddress(script, network)).toBe(address);
  });

  it('P2SH script bytes have the expected template', () => {
    const script = addressToScriptPubKey(p2shAddr, BITCOIN);
    expect(bytesToHex(script)).toBe(bytesToHex(p2shScript(hash20)));
  });
});

describe('rejections', () => {
  it('rejects taproot with a clear "not supported yet" error', () => {
    // Build a valid witness-v1 (P2TR-shaped) bech32m address so the error
    // path is exercised with a genuinely well-formed taproot address.
    const program = new Uint8Array(32).fill(7);
    const taproot = bech32m.encode('bc', [1, ...bech32m.toWords(program)]);
    expect(() => addressToScriptPubKey(taproot, BITCOIN)).toThrow(
      /Taproot \(P2TR\) addresses are not supported yet/,
    );
  });

  it('rejects segwit addresses on Dogecoin', () => {
    expect(() => addressToScriptPubKey(bech32Addr, DOGECOIN)).toThrow(/not valid on this network/);
  });

  it('rejects base58 addresses with a foreign version byte', () => {
    // A Bitcoin P2PKH address (version 0x00) is not a Dogecoin address.
    expect(() => addressToScriptPubKey(p2pkhAddr, DOGECOIN)).toThrow(
      /unknown base58 version byte 0x0/,
    );
  });

  it('rejects garbage', () => {
    expect(() => addressToScriptPubKey('not-an-address', BITCOIN)).toThrow(/Unrecognized address/);
  });

  it('rejects segwit v0 programs of illegal length', () => {
    // 16-byte witness program with a valid bech32 checksum: structurally
    // decodable but forbidden for v0, which only defines 20 and 32 bytes.
    const bad = bech32.encode('bc', [0, ...bech32.toWords(new Uint8Array(16).fill(3))]);
    expect(() => addressToScriptPubKey(bad, BITCOIN)).toThrow(/must be 20 or 32 bytes/);
  });
});

describe('testnet networks', () => {
  it('encodes and round-trips testnet addresses', async () => {
    const { BITCOIN_TESTNET, DOGECOIN_TESTNET, addressToScriptPubKey, scriptPubKeyToAddress, p2pkhScript } = await import('../src/address.js');
    const hash = new Uint8Array(20).fill(7);
    // Bitcoin testnet native segwit: HRP tb, per chainparams.cpp.
    const { bech32 } = await import('@scure/base');
    const tbAddress = bech32.encode('tb', [0, ...bech32.toWords(hash)]);
    expect(addressToScriptPubKey(tbAddress, BITCOIN_TESTNET).length).toBe(22);
    // Dogecoin testnet p2pkh round-trip through version byte 0x71.
    const script = p2pkhScript(hash);
    const dogeTestnetAddr = scriptPubKeyToAddress(script, DOGECOIN_TESTNET);
    expect(addressToScriptPubKey(dogeTestnetAddr, DOGECOIN_TESTNET)).toEqual(script);
    // A mainnet address must be rejected on testnet.
    expect(() => addressToScriptPubKey('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', BITCOIN_TESTNET)).toThrow();
  });
});
