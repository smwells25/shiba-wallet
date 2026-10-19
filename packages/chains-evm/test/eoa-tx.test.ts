import { describe, expect, it } from 'vitest';
import { Transaction, Wallet } from 'ethers';
import { HDKey } from '@scure/bip32';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  ChainRegistry,
  HdKeyring,
  evmKeyProvider,
  mnemonicToSeed,
  type DerivedAccount,
} from '@shiba-wallet/core';
import {
  eip1559SigningHash,
  recoverEip1559Signer,
  serializeSignedEip1559,
  signEip1559,
  type Eip1559Signature,
  type Eip1559Transaction,
} from '../src/eoa-tx.js';
import { toBytes } from '../src/encoding.js';
import { minimalBytes, rlpEncode } from '../src/rlp.js';
import { toHex } from '../src/encoding.js';

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function ownerAccount(): DerivedAccount {
  const registry = new ChainRegistry();
  registry.register(evmKeyProvider);
  return HdKeyring.fromMnemonic(TEST_MNEMONIC, registry).getAccount('eip155:1');
}

/** ethers Wallet over the same key, as the independent reference signer. */
function referenceWallet(): Wallet {
  const seed = mnemonicToSeed(TEST_MNEMONIC);
  const node = HDKey.fromMasterSeed(seed).derive("m/44'/60'/0'/0/0");
  return new Wallet(bytesToHex(node.privateKey!));
}

const baseTx: Eip1559Transaction = {
  chainId: 1n,
  nonce: 7n,
  maxPriorityFeePerGas: 1_500_000_000n,
  maxFeePerGas: 42_000_000_000n,
  gasLimit: 21_000n,
  to: '0x2222222222222222222222222222222222222222',
  value: 123_456_789_000_000_000n,
};

async function ethersRaw(tx: Eip1559Transaction): Promise<string> {
  return referenceWallet().signTransaction(
    Transaction.from({
      type: 2,
      chainId: tx.chainId,
      nonce: Number(tx.nonce),
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      maxFeePerGas: tx.maxFeePerGas,
      gasLimit: tx.gasLimit,
      to: tx.to ?? null,
      value: tx.value,
      data: tx.data ? toHex(tx.data) : '0x',
      accessList: (tx.accessList ?? []).map((e) => ({
        address: e.address,
        storageKeys: e.storageKeys,
      })),
    }),
  );
}

describe('EIP-1559 signing vs ethers', () => {
  it('produces byte-identical raw transactions for a plain transfer', async () => {
    const signed = signEip1559(baseTx, ownerAccount());
    expect(signed.rawHex).toBe(await ethersRaw(baseTx));
    expect(signed.txHash).toBe(Transaction.from(signed.rawHex).hash);
  });

  it('matches for zero value, empty nonce, and calldata', async () => {
    const tx: Eip1559Transaction = {
      ...baseTx,
      nonce: 0n,
      value: 0n,
      data: utf8ToBytes('doge says hi'),
      gasLimit: 100_000n,
    };
    expect(signEip1559(tx, ownerAccount()).rawHex).toBe(await ethersRaw(tx));
  });

  it('matches with an access list and an L2 chain id', async () => {
    const tx: Eip1559Transaction = {
      ...baseTx,
      chainId: 8453n,
      accessList: [
        {
          address: '0x3333333333333333333333333333333333333333',
          storageKeys: [
            '0x0000000000000000000000000000000000000000000000000000000000000001',
          ],
        },
      ],
    };
    expect(signEip1559(tx, ownerAccount()).rawHex).toBe(await ethersRaw(tx));
  });

  it('matches for contract deployment (no to address)', async () => {
    const tx: Eip1559Transaction = {
      ...baseTx,
      to: undefined,
      data: utf8ToBytes('constructor-code'),
      gasLimit: 500_000n,
    };
    expect(signEip1559(tx, ownerAccount()).rawHex).toBe(await ethersRaw(tx));
  });
});

describe('RLP encoder', () => {
  // Canonical examples from the Ethereum wiki / yellow paper appendix B.
  it('encodes canonical cases', () => {
    expect(bytesToHex(rlpEncode(new Uint8Array(0)))).toBe('80');
    expect(bytesToHex(rlpEncode(new Uint8Array([0x00])))).toBe('00');
    expect(bytesToHex(rlpEncode(new Uint8Array([0x7f])))).toBe('7f');
    expect(bytesToHex(rlpEncode(utf8ToBytes('dog')))).toBe('83646f67');
    expect(bytesToHex(rlpEncode([])))
      .toBe('c0');
    expect(bytesToHex(rlpEncode([utf8ToBytes('cat'), utf8ToBytes('dog')]))).toBe(
      'c88363617483646f67',
    );
    // 56-byte string crosses into long-form length encoding.
    const fiftySix = new Uint8Array(56).fill(0x61);
    expect(bytesToHex(rlpEncode(fiftySix)).slice(0, 4)).toBe('b838');
  });

  it('encodes integers minimally', () => {
    expect(minimalBytes(0n).length).toBe(0);
    expect(bytesToHex(minimalBytes(15n))).toBe('0f');
    expect(bytesToHex(minimalBytes(1024n))).toBe('0400');
  });
});

describe('a signature made elsewhere (cold signing): serializeSignedEip1559 / recoverEip1559Signer', () => {
  /** ethers' own signature over the same payload, as an independent off-line signer would return it. */
  function ethersSignature(tx: Eip1559Transaction): { sig: Eip1559Signature; serialized: string } {
    const wallet = referenceWallet();
    const unsigned = Transaction.from({
      type: 2,
      chainId: tx.chainId,
      nonce: Number(tx.nonce),
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      maxFeePerGas: tx.maxFeePerGas,
      gasLimit: tx.gasLimit,
      to: tx.to ?? null,
      value: tx.value,
      data: tx.data ? toHex(tx.data) : '0x',
      accessList: (tx.accessList ?? []).map((e) => ({ address: e.address, storageKeys: e.storageKeys })),
    });
    // The digest ethers signs must be the engine's signing hash.
    expect(unsigned.unsignedHash).toBe(toHex(eip1559SigningHash(tx)));
    const signature = wallet.signingKey.sign(unsigned.unsignedHash);
    unsigned.signature = signature;
    return {
      sig: { yParity: signature.yParity, r: toBytes(signature.r), s: toBytes(signature.s) },
      serialized: unsigned.serialized,
    };
  }

  // A small deterministic generator (xorshift), so the "random" cases are
  // reproducible.
  function cases(): Eip1559Transaction[] {
    let x = 0x9e3779b97f4a7c15n;
    const next = (bits: bigint) => {
      x ^= (x << 13n) & ((1n << 64n) - 1n);
      x ^= x >> 7n;
      x ^= (x << 17n) & ((1n << 64n) - 1n);
      return x % (1n << bits);
    };
    const out: Eip1559Transaction[] = [];
    for (let i = 0; i < 3; i++) {
      const to = '0x' + next(64n).toString(16).padStart(16, '0') + next(64n).toString(16).padStart(16, '0') + next(32n).toString(16).padStart(8, '0');
      const dataLen = Number(next(6n));
      const data = new Uint8Array(dataLen).map(() => Number(next(8n)));
      out.push({
        chainId: [1n, 11155111n, 11155420n][i]!,
        nonce: next(20n),
        maxPriorityFeePerGas: next(34n),
        maxFeePerGas: next(40n) + 1n,
        gasLimit: 21_000n + next(20n),
        to,
        value: i === 1 ? 0n : next(60n),
        ...(dataLen > 0 ? { data } : {}),
      });
    }
    return out;
  }

  it('attaches an outside signature byte for byte like ethers (three generated cases)', () => {
    for (const tx of cases()) {
      const { sig, serialized } = ethersSignature(tx);
      const signed = serializeSignedEip1559(tx, sig);
      expect(signed.rawHex).toBe(serialized);
      expect(signed.txHash).toBe(Transaction.from(serialized).hash);
      expect(recoverEip1559Signer(tx, sig)).toBe(referenceWallet().address);
    }
  });

  it('equals signEip1559 for the same transaction and key', () => {
    const tx: Eip1559Transaction = { ...baseTx, data: utf8ToBytes('cold') };
    const own = signEip1559(tx, ownerAccount());
    const parsed = Transaction.from(own.rawHex);
    const sig: Eip1559Signature = {
      yParity: parsed.signature!.yParity,
      r: toBytes(parsed.signature!.r),
      s: toBytes(parsed.signature!.s),
    };
    expect(serializeSignedEip1559(tx, sig).rawHex).toBe(own.rawHex);
    expect(recoverEip1559Signer(tx, sig)).toBe(ownerAccount().address);
  });

  it('recovers another address when any signed field differs (a tampered transaction)', () => {
    const { sig } = ethersSignature(baseTx);
    const wallet = referenceWallet().address;
    for (const tampered of [
      { ...baseTx, nonce: baseTx.nonce + 1n },
      { ...baseTx, value: baseTx.value + 1n },
      { ...baseTx, to: '0x2222222222222222222222222222222222222223' },
      { ...baseTx, chainId: 11155111n },
    ]) {
      let recovered: string | null = null;
      try {
        recovered = recoverEip1559Signer(tampered, sig);
      } catch {
        recovered = null;
      }
      expect(recovered).not.toBe(wallet);
    }
  });

  it('refuses a malformed or high-s signature', () => {
    const { sig } = ethersSignature(baseTx);
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const highS = toBytes('0x' + (n - BigInt(toHex(sig.s))).toString(16).padStart(64, '0'));
    const flipped: Eip1559Signature = { yParity: sig.yParity === 0 ? 1 : 0, r: sig.r, s: highS };
    expect(() => serializeSignedEip1559(baseTx, flipped)).toThrow(/EIP-2/);
    expect(() => recoverEip1559Signer(baseTx, flipped)).toThrow(/EIP-2/);
    expect(() => serializeSignedEip1559(baseTx, { ...sig, yParity: 2 as 0 })).toThrow(/yParity/);
    expect(() => serializeSignedEip1559(baseTx, { ...sig, r: new Uint8Array(32) })).toThrow(/range/);
    expect(() => serializeSignedEip1559(baseTx, { ...sig, s: sig.s.slice(1) })).toThrow(/32 bytes/);
  });
});
