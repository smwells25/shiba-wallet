import { describe, expect, it } from 'vitest';
import { Interface } from 'ethers';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import {
  ChainRegistry,
  HdKeyring,
  evmKeyProvider,
  type DerivedAccount,
} from '@shiba-wallet/core';
import { encodeFunctionCall } from '../src/abi.js';
import { createSimpleAccountSpec } from '../src/simple-account.js';
import { toHex } from '../src/encoding.js';
import type { JsonRpcTransport } from '../src/rpc.js';

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function ownerAccount(): DerivedAccount {
  const registry = new ChainRegistry();
  registry.register(evmKeyProvider);
  return HdKeyring.fromMnemonic(TEST_MNEMONIC, registry).getAccount('eip155:1');
}

const FACTORY = '0x9406Cc6185a346906296840746125a0E44976454';

// Reference encodings from ethers.js, an independent ABI implementation.
const simpleAccountAbi = new Interface([
  'function execute(address dest, uint256 value, bytes func)',
  'function executeBatch(address[] dest, uint256[] value, bytes[] func)',
  'function createAccount(address owner, uint256 salt)',
  'function getAddress(address owner, uint256 salt)',
]);

describe('ABI encoder vs ethers', () => {
  it('encodes execute(address,uint256,bytes) identically', () => {
    const data = utf8ToBytes('transfer-calldata');
    const ours = encodeFunctionCall('execute(address,uint256,bytes)', [
      { kind: 'address', value: '0x1111111111111111111111111111111111111111' },
      { kind: 'uint256', value: 123456789n },
      { kind: 'bytes', value: data },
    ]);
    const reference = simpleAccountAbi.encodeFunctionData('execute', [
      '0x1111111111111111111111111111111111111111',
      123456789n,
      toHex(data),
    ]);
    expect(toHex(ours)).toBe(reference);
  });

  it('encodes executeBatch(address[],uint256[],bytes[]) identically', () => {
    const targets = [
      '0x1111111111111111111111111111111111111111',
      '0x2222222222222222222222222222222222222222',
    ];
    const values = [0n, 42n];
    const datas = [utf8ToBytes('first'), new Uint8Array(0)];
    const ours = encodeFunctionCall('executeBatch(address[],uint256[],bytes[])', [
      { kind: 'array', items: targets.map((value) => ({ kind: 'address' as const, value })) },
      { kind: 'array', items: values.map((value) => ({ kind: 'uint256' as const, value })) },
      { kind: 'array', items: datas.map((value) => ({ kind: 'bytes' as const, value })) },
    ]);
    const reference = simpleAccountAbi.encodeFunctionData('executeBatch', [
      targets,
      values,
      datas.map(toHex),
    ]);
    expect(toHex(ours)).toBe(reference);
  });

  it('encodes empty bytes and zero-length arrays identically', () => {
    const ours = encodeFunctionCall('executeBatch(address[],uint256[],bytes[])', [
      { kind: 'array', items: [] },
      { kind: 'array', items: [] },
      { kind: 'array', items: [] },
    ]);
    const reference = simpleAccountAbi.encodeFunctionData('executeBatch', [[], [], []]);
    expect(toHex(ours)).toBe(reference);
  });
});

describe('SimpleAccount spec', () => {
  const COUNTERFACTUAL = '0x00000000000000000000000000000000000000aa';

  function fakeNode(): { transport: JsonRpcTransport; calls: Array<{ method: string; params: unknown[] }> } {
    const calls: Array<{ method: string; params: unknown[] }> = [];
    return {
      calls,
      transport: async (method, params) => {
        calls.push({ method, params });
        if (method === 'eth_call') {
          return '0x' + COUNTERFACTUAL.slice(2).padStart(64, '0');
        }
        throw new Error(`unexpected ${method}`);
      },
    };
  }

  it('resolves and caches the counterfactual address via factory.getAddress', async () => {
    const { transport, calls } = fakeNode();
    const spec = createSimpleAccountSpec({ factory: FACTORY, node: transport, salt: 7n });
    const owner = ownerAccount();
    const first = await spec.getAddress(owner);
    const second = await spec.getAddress(owner);
    expect(first.toLowerCase()).toBe(COUNTERFACTUAL.toLowerCase());
    expect(second).toBe(first);
    expect(calls.length).toBe(1); // cached on the second read

    // The view call carried ethers-identical calldata.
    const expected = simpleAccountAbi.encodeFunctionData('getAddress', [owner.address, 7n]);
    expect((calls[0]!.params[0] as { data: string }).data).toBe(expected);
  });

  it('builds createAccount factoryData matching ethers', async () => {
    const { transport } = fakeNode();
    const spec = createSimpleAccountSpec({ factory: FACTORY, node: transport });
    const owner = ownerAccount();
    const { factory, factoryData } = await spec.getFactoryArgs(owner);
    expect(factory).toBe(FACTORY);
    expect(toHex(factoryData)).toBe(
      simpleAccountAbi.encodeFunctionData('createAccount', [owner.address, 0n]),
    );
  });

  it('routes one call to execute and several to executeBatch', () => {
    const { transport } = fakeNode();
    const spec = createSimpleAccountSpec({ factory: FACTORY, node: transport });
    const single = spec.encodeCalls([
      { to: '0x1111111111111111111111111111111111111111', value: 0n, data: new Uint8Array(0) },
    ]);
    expect(toHex(single.slice(0, 4))).toBe(
      simpleAccountAbi.getFunction('execute')!.selector,
    );
    const batch = spec.encodeCalls([
      { to: '0x1111111111111111111111111111111111111111', value: 0n, data: new Uint8Array(0) },
      { to: '0x2222222222222222222222222222222222222222', value: 1n, data: utf8ToBytes('x') },
    ]);
    expect(toHex(batch.slice(0, 4))).toBe(
      simpleAccountAbi.getFunction('executeBatch')!.selector,
    );
    expect(() => spec.encodeCalls([])).toThrow(/At least one call/);
  });
});
