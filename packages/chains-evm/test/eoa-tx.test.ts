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
import { signEip1559, type Eip1559Transaction } from '../src/eoa-tx.js';
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
