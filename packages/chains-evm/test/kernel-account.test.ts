import { describe, expect, it } from 'vitest';
import {
  AbiCoder,
  Interface,
  ZeroAddress,
  concat,
  getCreate2Address,
  hashMessage,
  keccak256,
  randomBytes,
  recoverAddress,
  solidityPacked,
  toBeHex,
  zeroPadValue,
} from 'ethers';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import {
  ChainRegistry,
  HdKeyring,
  evmKeyProvider,
  type DerivedAccount,
} from '@shiba-wallet/core';
import {
  KERNEL_V3_3,
  createKernelAccountSpec,
  encodeErc7579Mode,
  encodeKernelExecute,
  encodeKernelInitData,
  kernelProxyInitCodeHash,
  kernelValidatorId,
  predictKernelAddress,
  verifyKernelDeployment,
} from '../src/kernel-account.js';
import { encodeFunctionCall } from '../src/abi.js';
import { SmartAccountClient } from '../src/smart-account.js';
import { ENTRYPOINT_V07, getUserOpHash } from '../src/userop.js';
import { toBytes, toHex } from '../src/encoding.js';
import type { JsonRpcTransport } from '../src/rpc.js';

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function ownerAccount(): DerivedAccount {
  const registry = new ChainRegistry();
  registry.register(evmKeyProvider);
  return HdKeyring.fromMnemonic(TEST_MNEMONIC, registry).getAccount('eip155:1');
}

/**
 * Ground truth pinned from the chain on 2026-10-01: KernelFactory
 * 0x2577...F2E9 getAddress(initData(owner 0x9858...Da94), bytes32(0)) via
 * eth_call returned this address on BOTH Sepolia
 * (ethereum-sepolia-rpc.publicnode.com) and Ethereum mainnet
 * (ethereum.publicnode.com), and EntryPoint v0.7 getSenderAddress reverted
 * with SenderAddressResult(this address) on Sepolia for both the meta
 * factory (deployWithFactory) and direct factory (createAccount) initCode.
 * Index 1 returned 0x84f1...A32a on both chains.
 */
const STANDARD_OWNER = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const ONCHAIN_ADDRESS_INDEX_0 = '0xB67b8b7cCA718EAC64d2b59ba568585A9FC69a42';
const ONCHAIN_ADDRESS_INDEX_1 = '0x84f11a7748751A75D189c6D128E291A3113Aa32a';
/** ZeroDev SDK KernelVersionToAddressesMap["0.3.3"].initCodeHash. */
const SDK_INIT_CODE_HASH = '0xc452397f1e7518f8cea0566ac057e243bb1643f6298aba8eec8cdee78ee3b3dd';

// Independent reference encodings (ethers.js), written from the Solidity
// sources of Kernel v3.3 (Kernel.sol, KernelFactory.sol, FactoryStaker.sol).
const kernelAbi = new Interface([
  'function initialize(bytes21 _rootValidator, address hook, bytes validatorData, bytes hookData, bytes[] initConfig)',
  'function execute(bytes32 execMode, bytes executionCalldata)',
  'function createAccount(bytes data, bytes32 salt)',
  'function getAddress(bytes data, bytes32 salt)',
  'function deployWithFactory(address factory, bytes createData, bytes32 salt)',
]);
const coder = AbiCoder.defaultAbiCoder();

function ethersInitData(owner: string): string {
  return kernelAbi.encodeFunctionData('initialize', [
    concat(['0x01', KERNEL_V3_3.ecdsaValidator]),
    ZeroAddress,
    owner,
    '0x',
    [],
  ]);
}

describe('Kernel v3.3 encodings vs ethers', () => {
  it('validator id is 0x01 || validator address (bytes21)', () => {
    expect(toHex(kernelValidatorId(KERNEL_V3_3.ecdsaValidator))).toBe(
      '0x01' + KERNEL_V3_3.ecdsaValidator.slice(2).toLowerCase(),
    );
  });

  it('initialize calldata matches ethers and uses the on-chain selector 0x3c3b752b', () => {
    const owner = ownerAccount();
    const ours = toHex(encodeKernelInitData(owner.address, KERNEL_V3_3.ecdsaValidator));
    expect(ours).toBe(ethersInitData(owner.address));
    // Selector observed as a PUSH4 in the deployed implementation's bytecode.
    expect(ours.slice(0, 10)).toBe('0x3c3b752b');
  });

  it('single-call execute: mode 0x00.., executionCalldata = encodePacked(to, value, data)', () => {
    const call = {
      to: '0x1111111111111111111111111111111111111111',
      value: 123456789n,
      data: utf8ToBytes('transfer-calldata'),
    };
    const ours = encodeKernelExecute([call]);
    const mode = '0x' + '00'.repeat(32);
    const packed = solidityPacked(['address', 'uint256', 'bytes'], [call.to, call.value, toHex(call.data)]);
    expect(toHex(ours)).toBe(kernelAbi.encodeFunctionData('execute', [mode, packed]));
    // execute(bytes32,bytes) selector, same as the ERC-7579 interface.
    expect(toHex(ours.slice(0, 4))).toBe(kernelAbi.getFunction('execute')!.selector);
    expect(toHex(ours.slice(0, 4))).toBe('0xe9ae5c53');
  });

  it('single-call with empty data still packs 52 bytes (decodeSingle needs > 0x33)', () => {
    const ours = encodeKernelExecute([
      { to: '0x2222222222222222222222222222222222222222', value: 0n, data: new Uint8Array(0) },
    ]);
    const [mode, execData] = kernelAbi.decodeFunctionData('execute', toHex(ours));
    expect(mode).toBe('0x' + '00'.repeat(32));
    expect(toBytes(execData as string).length).toBe(52);
  });

  it('batch execute: mode 0x01.., executionCalldata = abi.encode(Execution[])', () => {
    const calls = [
      { to: '0x1111111111111111111111111111111111111111', value: 0n, data: utf8ToBytes('first') },
      { to: '0x2222222222222222222222222222222222222222', value: 42n, data: new Uint8Array(0) },
      { to: '0x3333333333333333333333333333333333333333', value: 7n, data: new Uint8Array(70).fill(9) },
    ];
    const ours = encodeKernelExecute(calls);
    const mode = '0x01' + '00'.repeat(31);
    const execData = coder.encode(
      ['tuple(address target, uint256 value, bytes callData)[]'],
      [calls.map((c) => [c.to, c.value, toHex(c.data)])],
    );
    expect(toHex(ours)).toBe(kernelAbi.encodeFunctionData('execute', [mode, execData]));
  });

  it('mode word layout: callType, execType, then zero unused/selector/payload bytes', () => {
    expect(toHex(encodeErc7579Mode(0x01, 0x01))).toBe('0x0101' + '00'.repeat(30));
    expect(() => encodeKernelExecute([])).toThrow(/At least one call/);
  });
});

describe('ABI encoder extensions (bytesN, tuples) vs ethers', () => {
  it('encodes static tuples inline and mixed static/dynamic tuple arrays', () => {
    const ours = encodeFunctionCall('f((address,uint256),bytes4,(uint256,bytes)[],uint256)', [
      {
        kind: 'tuple',
        items: [
          { kind: 'address', value: '0x1111111111111111111111111111111111111111' },
          { kind: 'uint256', value: 5n },
        ],
      },
      { kind: 'fixedBytes', value: new Uint8Array([0xde, 0xad, 0xbe, 0xef]) },
      {
        kind: 'array',
        items: [
          { kind: 'tuple', items: [{ kind: 'uint256', value: 1n }, { kind: 'bytes', value: utf8ToBytes('a') }] },
          { kind: 'tuple', items: [{ kind: 'uint256', value: 2n }, { kind: 'bytes', value: new Uint8Array(40) }] },
        ],
      },
      { kind: 'uint256', value: 9n },
    ]);
    const reference = new Interface([
      'function f((address,uint256) a, bytes4 b, (uint256,bytes)[] c, uint256 d)',
    ]).encodeFunctionData('f', [
      ['0x1111111111111111111111111111111111111111', 5n],
      '0xdeadbeef',
      [
        [1n, toHex(utf8ToBytes('a'))],
        [2n, toHex(new Uint8Array(40))],
      ],
      9n,
    ]);
    expect(toHex(ours)).toBe(reference);
    expect(() =>
      encodeFunctionCall('g(bytes32)', [{ kind: 'fixedBytes', value: new Uint8Array(33) }]),
    ).toThrow(/1 to 32 bytes/);
  });
});

describe('Kernel v3.3 counterfactual address', () => {
  it('derives the standard test owner', () => {
    expect(ownerAccount().address).toBe(STANDARD_OWNER);
  });

  it('proxy init code hash equals the ZeroDev SDK published value', () => {
    expect(toHex(kernelProxyInitCodeHash(KERNEL_V3_3.implementation))).toBe(SDK_INIT_CODE_HASH);
  });

  it('local CREATE2 prediction equals ethers.getCreate2Address and the on-chain getAddress', () => {
    for (const [index, onchain] of [
      [0n, ONCHAIN_ADDRESS_INDEX_0],
      [1n, ONCHAIN_ADDRESS_INDEX_1],
    ] as const) {
      const salt = zeroPadValue(toBeHex(index), 32);
      const reference = getCreate2Address(
        KERNEL_V3_3.factory,
        keccak256(solidityPacked(['bytes', 'bytes32'], [ethersInitData(STANDARD_OWNER), salt])),
        SDK_INIT_CODE_HASH,
      );
      const ours = predictKernelAddress(STANDARD_OWNER, { index });
      expect(ours).toBe(reference);
      expect(ours).toBe(onchain);
    }
  });
});

function fakeFactoryNode(answer: string): {
  transport: JsonRpcTransport;
  calls: Array<{ method: string; params: unknown[] }>;
} {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  return {
    calls,
    transport: async (method, params) => {
      calls.push({ method, params });
      if (method === 'eth_call') return '0x' + answer.slice(2).toLowerCase().padStart(64, '0');
      throw new Error(`unexpected ${method}`);
    },
  };
}

describe('Kernel spec', () => {
  it('resolves the address via factory.getAddress eth_call, cross-checks it, and caches it', async () => {
    const { transport, calls } = fakeFactoryNode(ONCHAIN_ADDRESS_INDEX_0);
    const spec = createKernelAccountSpec({ node: transport });
    const owner = ownerAccount();
    expect(await spec.getAddress(owner)).toBe(ONCHAIN_ADDRESS_INDEX_0);
    expect(await spec.getAddress(owner)).toBe(ONCHAIN_ADDRESS_INDEX_0);
    expect(calls.length).toBe(1);
    const sent = calls[0]!.params[0] as { to: string; data: string };
    expect(sent.to).toBe(KERNEL_V3_3.factory);
    expect(sent.data).toBe(
      kernelAbi.encodeFunctionData('getAddress', [ethersInitData(owner.address), '0x' + '00'.repeat(32)]),
    );
  });

  it('refuses a factory answer that disagrees with the local CREATE2 prediction', async () => {
    const { transport } = fakeFactoryNode('0x00000000000000000000000000000000000000aa');
    const spec = createKernelAccountSpec({ node: transport });
    await expect(spec.getAddress(ownerAccount())).rejects.toThrow(/local CREATE2 prediction/);
  });

  it('builds meta-factory deployWithFactory factoryData by default', async () => {
    const { transport } = fakeFactoryNode(ONCHAIN_ADDRESS_INDEX_1);
    const spec = createKernelAccountSpec({ node: transport, index: 1n });
    const owner = ownerAccount();
    const { factory, factoryData } = await spec.getFactoryArgs(owner);
    expect(factory).toBe(KERNEL_V3_3.metaFactory);
    expect(toHex(factoryData)).toBe(
      kernelAbi.encodeFunctionData('deployWithFactory', [
        KERNEL_V3_3.factory,
        ethersInitData(owner.address),
        zeroPadValue('0x01', 32),
      ]),
    );
    expect(await spec.getAddress(owner)).toBe(ONCHAIN_ADDRESS_INDEX_1);
  });

  it('builds direct createAccount factoryData when the meta factory is disabled', async () => {
    const { transport } = fakeFactoryNode(ONCHAIN_ADDRESS_INDEX_0);
    const spec = createKernelAccountSpec({ node: transport, metaFactory: null });
    const owner = ownerAccount();
    const { factory, factoryData } = await spec.getFactoryArgs(owner);
    expect(factory).toBe(KERNEL_V3_3.factory);
    expect(toHex(factoryData)).toBe(
      kernelAbi.encodeFunctionData('createAccount', [ethersInitData(owner.address), '0x' + '00'.repeat(32)]),
    );
  });

  it('signs the EIP-191 form of the userOpHash as a bare 65-byte signature (no prefix)', () => {
    const { transport } = fakeFactoryNode(ONCHAIN_ADDRESS_INDEX_0);
    const spec = createKernelAccountSpec({ node: transport });
    const owner = ownerAccount();
    const hash = randomBytes(32);
    const sig = spec.signUserOpHash(owner, hash);
    expect(sig.length).toBe(65);
    expect([27, 28]).toContain(sig[64]);
    expect(recoverAddress(hashMessage(hash), toHex(sig))).toBe(owner.address);
  });

  it('stub signature is recoverable for arbitrary digests on both validator paths', () => {
    const { transport } = fakeFactoryNode(ONCHAIN_ADDRESS_INDEX_0);
    const stub = toHex(createKernelAccountSpec({ node: transport }).stubSignature());
    expect(toBytes(stub).length).toBe(65);
    for (let i = 0; i < 20; i++) {
      const digest = randomBytes(32);
      // ECDSAValidator tries the raw hash, then the EIP-191 hash; solady's
      // recover reverts on failure, so both must recover to some address.
      expect(recoverAddress(toHex(digest), stub)).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(recoverAddress(hashMessage(digest), stub)).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });
});

describe('Kernel spec through SmartAccountClient', () => {
  const FEES = { maxFeePerGas: 100n, maxPriorityFeePerGas: 2n };

  function transports(deployed: boolean) {
    const calls: Array<{ method: string; params: unknown[] }> = [];
    const node: JsonRpcTransport = async (method, params) => {
      calls.push({ method, params });
      if (method === 'eth_getCode') return deployed ? '0x6001' : '0x';
      if (method === 'eth_call') {
        const { to } = params[0] as { to: string };
        if (to === KERNEL_V3_3.factory) {
          return '0x' + ONCHAIN_ADDRESS_INDEX_0.slice(2).toLowerCase().padStart(64, '0');
        }
        if (to === ENTRYPOINT_V07) return '0x' + '00'.repeat(31) + '03'; // nonce 3
      }
      throw new Error(`unexpected node call ${method}`);
    };
    const bundler: JsonRpcTransport = async (method, params) => {
      calls.push({ method, params });
      if (method === 'eth_estimateUserOperationGas') {
        return { callGasLimit: '0x5000', verificationGasLimit: '0x60000', preVerificationGas: '0xc000' };
      }
      if (method === 'eth_sendUserOperation') return '0x' + 'ab'.repeat(32);
      throw new Error(`unexpected bundler call ${method}`);
    };
    return { calls, node, bundler };
  }

  it('runs stub -> estimate -> sign -> send for an undeployed account with a batch', async () => {
    const { calls, node, bundler } = transports(false);
    const spec = createKernelAccountSpec({ node });
    const client = new SmartAccountClient({ chainId: 11155111n, entryPoint: ENTRYPOINT_V07, bundler, node, spec });
    const owner = ownerAccount();
    const batch = [
      { to: '0x1111111111111111111111111111111111111111', value: 1n, data: new Uint8Array(0) },
      { to: '0x2222222222222222222222222222222222222222', value: 0n, data: utf8ToBytes('x') },
    ];
    const { userOpHash, userOp } = await client.sendCalls(owner, batch, FEES);

    expect(userOpHash).toBe('0x' + 'ab'.repeat(32));
    expect(calls.map((c) => c.method)).toEqual([
      'eth_call', // factory.getAddress (isDeployed needs the address first)
      'eth_getCode',
      'eth_call', // EntryPoint.getNonce(sender, key 0)
      'eth_estimateUserOperationGas',
      'eth_sendUserOperation',
    ]);

    // Nonce key 0 => Kernel decodes validation mode DEFAULT + type ROOT.
    const nonceCall = calls[2]!.params[0] as { to: string; data: string };
    expect(nonceCall.to).toBe(ENTRYPOINT_V07);
    expect(nonceCall.data).toBe(
      new Interface(['function getNonce(address sender, uint192 key)']).encodeFunctionData(
        'getNonce',
        [ONCHAIN_ADDRESS_INDEX_0, 0n],
      ),
    );
    expect(userOp.nonce).toBe(3n);

    expect(userOp.sender).toBe(ONCHAIN_ADDRESS_INDEX_0);
    expect(userOp.factory).toBe(KERNEL_V3_3.metaFactory);
    expect(toHex(userOp.callData)).toBe(toHex(encodeKernelExecute(batch)));

    // Gas estimation carried the stub; the submitted op carries the real signature.
    const estimated = calls[3]!.params[0] as { signature: string; factory: string };
    expect(estimated.signature).toBe(toHex(spec.stubSignature()));
    expect(estimated.factory).toBe(KERNEL_V3_3.metaFactory);
    const sent = calls[4]!.params as [{ signature: string; callData: string }, string];
    expect(sent[1]).toBe(ENTRYPOINT_V07);
    expect(sent[0].callData).toBe(toHex(userOp.callData));
    const digest = getUserOpHash(userOp, ENTRYPOINT_V07, 11155111n);
    expect(recoverAddress(hashMessage(digest), sent[0].signature)).toBe(owner.address);
  });

  it('omits factory args once deployed and encodes a single call', async () => {
    const { node, bundler } = transports(true);
    const client = new SmartAccountClient({
      chainId: 11155111n,
      entryPoint: ENTRYPOINT_V07,
      bundler,
      node,
      spec: createKernelAccountSpec({ node }),
    });
    const call = { to: ONCHAIN_ADDRESS_INDEX_0, value: 0n, data: new Uint8Array(0) };
    const { userOp } = await client.sendCalls(ownerAccount(), [call], FEES);
    expect(userOp.factory).toBeUndefined();
    expect(toHex(userOp.callData.slice(0, 4))).toBe('0xe9ae5c53');
    expect(toHex(userOp.callData.slice(4, 36))).toBe('0x' + '00'.repeat(32));
  });
});

describe('verifyKernelDeployment', () => {
  const abiString = (s: string) => coder.encode(['string'], [s]);
  const word = (hex: string) => zeroPadValue(hex, 32);

  function fakeChain(overrides: Partial<Record<string, string>> = {}): JsonRpcTransport {
    const selectorOf = (sig: string) => toHex(encodeFunctionCall(sig, []).slice(0, 4));
    const answers: Record<string, string> = {
      implementation: word(KERNEL_V3_3.implementation),
      entrypoint: word(ENTRYPOINT_V07),
      accountId: abiString(KERNEL_V3_3.accountId),
      approved: word('0x01'),
      isModuleType: word('0x01'),
      ...overrides,
    };
    return async (method, params) => {
      if (method === 'eth_getCode') {
        return overrides[`code:${params[0] as string}`] ?? '0x6080';
      }
      if (method === 'eth_call') {
        const data = (params[0] as { data: string }).data;
        const sel = data.slice(0, 10);
        if (sel === selectorOf('implementation()')) return answers.implementation;
        if (sel === selectorOf('entrypoint()')) return answers.entrypoint;
        if (sel === selectorOf('accountId()')) return answers.accountId;
        if (sel === toHex(encodeFunctionCall('approved(address)', [{ kind: 'address', value: ZeroAddress }]).slice(0, 4))) {
          return answers.approved;
        }
        if (sel === toHex(encodeFunctionCall('isModuleType(uint256)', [{ kind: 'uint256', value: 0n }]).slice(0, 4))) {
          return answers.isModuleType;
        }
      }
      throw new Error(`unexpected ${method}`);
    };
  }

  it('accepts the verified v3.3 deployment', async () => {
    const result = await verifyKernelDeployment(fakeChain());
    expect(result).toEqual({
      implementation: KERNEL_V3_3.implementation,
      entryPoint: ENTRYPOINT_V07,
      accountId: 'kernel.advanced.v0.3.3',
      metaFactoryApproved: true,
    });
  });

  it('rejects missing code, wrong implementation, wrong EntryPoint, wrong id, unapproved factory, non-validator', async () => {
    await expect(
      verifyKernelDeployment(fakeChain({ [`code:${KERNEL_V3_3.factory}`]: '0x' })),
    ).rejects.toThrow(/KernelFactory .* has no code/);
    await expect(
      verifyKernelDeployment(fakeChain({ implementation: word('0x1234') })),
    ).rejects.toThrow(/factory.implementation\(\)/);
    await expect(
      verifyKernelDeployment(fakeChain({ entrypoint: word('0x433700890211f2fbe8f3d6e8e6eb5e1e1fd6d3b4') })),
    ).rejects.toThrow(/kernel.entrypoint\(\)/);
    await expect(
      verifyKernelDeployment(fakeChain({ accountId: abiString('kernel.advanced.v0.3.1') })),
    ).rejects.toThrow(/accountId/);
    await expect(verifyKernelDeployment(fakeChain({ approved: word('0x00') }))).rejects.toThrow(
      /has not approved/,
    );
    await expect(verifyKernelDeployment(fakeChain({ isModuleType: word('0x00') }))).rejects.toThrow(
      /validator module/,
    );
  });
});
