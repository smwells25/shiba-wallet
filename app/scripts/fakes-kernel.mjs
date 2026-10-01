// Shared OFFLINE fakes for the phase 7 smart-account scripts
// (check-aa-kernel.mjs and check-wc-5792.mjs). Nothing here touches the
// network: a fake node emulates the read-only Kernel v3.3 surface the app
// uses (deployment verification views, the factory's getAddress, EntryPoint
// getNonce, ERC-20 balanceOf) plus an EMULATION of Kernel v3.3's
// isValidSignature for ERC-1271 / ERC-6492 checks, and a fake bundler
// records submitted UserOperations.
//
// The Kernel isValidSignature emulation follows the behavior documented in
// packages/chains-evm/src/kernel-account.ts (sources: zerodevapp/kernel tag
// v3.3): the signature is 0x01 || ECDSA validator (20 bytes) || 65-byte
// owner signature over Kernel's EIP-712 "Kernel(bytes32 hash)" wrapper
// under the account's own domain. The owner is recovered with ethers (an
// independent implementation), never with the engine under test.

import { ethers } from 'ethers';
import {
  ENTRYPOINT_V07,
  KERNEL_V3_3,
  kernelErc1271Digest,
  predictKernelAddress,
  selector,
  toBytes,
  toHex,
} from '@shiba-wallet/chains-evm';

export const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
/** Account 0 of the standard test mnemonic (public knowledge). */
export const OWNER_0 = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
/** Engine-predicted Kernel v3.3 account for OWNER_0, index 0 (AGENTS.md phase 7). */
export const KERNEL_ACCOUNT_0 = '0xB67b8b7cCA718EAC64d2b59ba568585A9FC69a42';
export const ERC1271_MAGIC = '0x1626ba7e';
export const USEROP_HASH = '0x' + 'ab'.repeat(32);

const sel = (signature) => toHex(selector(signature));
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const pad32 = (address) => '0x' + '0'.repeat(24) + address.slice(2).toLowerCase();
const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const abi = ethers.AbiCoder.defaultAbiCoder();
const kernelIface = new ethers.Interface([
  'function initialize(bytes21 rootValidator, address hook, bytes validatorData, bytes hookData, bytes[] initConfig)',
  'function deployWithFactory(address factory, bytes createData, bytes32 salt)',
  'function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)',
]);

/**
 * Emulates Kernel v3.3 isValidSignature(hash, sig) for `account` owned by
 * `owner` on `chainId`. Returns the ABI-encoded bytes4 result.
 */
export function emulateKernelIsValidSignature({ account, owner, chainId, input }) {
  const [hash, signature] = kernelIface.decodeFunctionData('isValidSignature', input);
  const sig = ethers.getBytes(signature);
  const fail = '0xffffffff' + '0'.repeat(56);
  if (sig.length !== 86 || sig[0] !== 0x01) return fail;
  const validator = ethers.getAddress(ethers.hexlify(sig.slice(1, 21)));
  if (!same(validator, KERNEL_V3_3.ecdsaValidator)) return fail;
  const digest = kernelErc1271Digest(ethers.getBytes(hash), { chainId, account });
  let recovered;
  try {
    recovered = ethers.recoverAddress(ethers.hexlify(digest), ethers.hexlify(sig.slice(21)));
  } catch {
    return fail;
  }
  return same(recovered, owner) ? ERC1271_MAGIC + '0'.repeat(56) : fail;
}

/**
 * Fake node for a Kernel v3.3 deployment on `chainId` (0x1 by default).
 * Options flip individual verification facts to exercise every refusal.
 */
export function fakeKernelNode({
  chainIdHex = '0x1',
  codeAt = {},
  implementation = KERNEL_V3_3.implementation,
  entryPoint = ENTRYPOINT_V07,
  accountId = KERNEL_V3_3.accountId,
  approved = true,
  isValidator = true,
  lieAboutAddress = false,
  deployedAccounts = new Set(),
  balance = 10n ** 18n,
  tokenBalances = {},
  owners = {},
  calls = [],
} = {}) {
  const hasCode = (address) => {
    if (address.toLowerCase() in codeAt) return codeAt[address.toLowerCase()];
    if (
      [KERNEL_V3_3.factory, KERNEL_V3_3.implementation, KERNEL_V3_3.metaFactory, KERNEL_V3_3.ecdsaValidator].some(
        (a) => same(a, address),
      )
    ) {
      return true;
    }
    return [...deployedAccounts].some((a) => same(a, address));
  };
  const transport = async (method, params) => {
    calls.push({ method, params });
    if (method === 'eth_chainId') return chainIdHex;
    if (method === 'eth_getBalance') return '0x' + balance.toString(16);
    if (method === 'eth_getBlockByNumber') return { baseFeePerGas: '0x3b9aca00' };
    if (method === 'eth_maxPriorityFeePerGas') return '0x3b9aca00';
    if (method === 'eth_getCode') return hasCode(params[0]) ? '0x6001' : '0x';
    if (method === 'eth_call') {
      const [{ to, data }] = params;
      if (same(to, KERNEL_V3_3.factory) && data.startsWith(sel('implementation()'))) return pad32(implementation);
      if (same(to, KERNEL_V3_3.factory) && data.startsWith(sel('getAddress(bytes,bytes32)'))) {
        const [initData, salt] = abi.decode(['bytes', 'bytes32'], '0x' + data.slice(10));
        const init = kernelIface.decodeFunctionData('initialize', initData);
        const owner = ethers.getAddress(init[2]);
        const predicted = predictKernelAddress(owner, { index: BigInt(salt) });
        return pad32(lieAboutAddress ? '0x' + '99'.repeat(20) : predicted);
      }
      if (same(to, KERNEL_V3_3.implementation) && data.startsWith(sel('entrypoint()'))) return pad32(entryPoint);
      if (same(to, KERNEL_V3_3.implementation) && data.startsWith(sel('accountId()'))) {
        return abi.encode(['string'], [accountId]);
      }
      if (same(to, KERNEL_V3_3.metaFactory) && data.startsWith(sel('approved(address)'))) return word(approved ? 1 : 0);
      if (same(to, KERNEL_V3_3.ecdsaValidator) && data.startsWith(sel('isModuleType(uint256)'))) {
        return word(isValidator ? 1 : 0);
      }
      if (same(to, ENTRYPOINT_V07) && data.startsWith(sel('getNonce(address,uint192)'))) return '0x0';
      if (data.startsWith(sel('balanceOf(address)'))) {
        const holder = ethers.getAddress('0x' + data.slice(34, 74));
        const key = `${to.toLowerCase()}|${holder.toLowerCase()}`;
        return word(tokenBalances[key] ?? 0n);
      }
      if (data.startsWith(sel('isValidSignature(bytes32,bytes)')) && owners[to.toLowerCase()]) {
        if (!hasCode(to)) return '0x';
        return emulateKernelIsValidSignature({
          account: ethers.getAddress(to),
          owner: owners[to.toLowerCase()],
          chainId: BigInt(chainIdHex),
          input: data,
        });
      }
      throw new Error(`fake kernel node: unexpected eth_call to ${to} data ${data.slice(0, 10)}`);
    }
    if (method === 'eth_simulateV1') {
      // ERC-6492 verification: [factory call, isValidSignature] in one block.
      const [payload] = params;
      const [deploy, verify] = payload.blockStateCalls[0].calls;
      const out = [];
      let deployedHere = null;
      if (same(deploy.to, KERNEL_V3_3.metaFactory) && deploy.input.startsWith(sel('deployWithFactory(address,bytes,bytes32)'))) {
        const [factory, createData, salt] = kernelIface.decodeFunctionData('deployWithFactory', deploy.input);
        const init = kernelIface.decodeFunctionData('initialize', createData);
        const owner = ethers.getAddress(init[2]);
        deployedHere = { address: predictKernelAddress(owner, { index: BigInt(salt), factory }), owner };
        out.push({ status: '0x1', returnData: pad32(deployedHere.address), logs: [], gasUsed: '0x1' });
      } else {
        out.push({ status: '0x0', returnData: '0x', logs: [], gasUsed: '0x1', error: { message: 'unknown factory' } });
      }
      if (deployedHere && same(verify.to, deployedHere.address)) {
        out.push({
          status: '0x1',
          returnData: emulateKernelIsValidSignature({
            account: deployedHere.address,
            owner: deployedHere.owner,
            chainId: BigInt(chainIdHex),
            input: verify.input,
          }),
          logs: [],
          gasUsed: '0x1',
        });
      } else {
        out.push({ status: '0x1', returnData: '0x', logs: [], gasUsed: '0x1' });
      }
      return [{ calls: out }];
    }
    throw new Error(`fake kernel node: unexpected method ${method}`);
  };
  transport.calls = calls;
  return transport;
}

/** Fake bundler: v0.7 supported, fixed gas estimate, records the submitted op. */
export function fakeBundler({ estimateError = null, receipt = null, sendError = null } = {}) {
  const calls = [];
  const transport = async (method, params) => {
    calls.push({ method, params });
    if (method === 'eth_supportedEntryPoints') return [ENTRYPOINT_V07];
    if (method === 'eth_estimateUserOperationGas') {
      transport.lastEstimated = params[0];
      if (estimateError) throw new Error(estimateError);
      return { callGasLimit: '0x111', verificationGasLimit: '0x222', preVerificationGas: '0x333' };
    }
    if (method === 'eth_sendUserOperation') {
      if (sendError) throw new Error(sendError);
      transport.lastOp = params[0];
      return USEROP_HASH;
    }
    if (method === 'eth_getUserOperationReceipt') return receipt;
    throw new Error(`fake bundler: unexpected method ${method}`);
  };
  transport.calls = calls;
  return transport;
}

/** Rebuilds the engine UserOperation from its RPC form (for hashing). */
export function fromRpcOp(op) {
  return {
    sender: op.sender,
    nonce: BigInt(op.nonce),
    ...(op.factory ? { factory: op.factory, factoryData: toBytes(op.factoryData) } : {}),
    callData: toBytes(op.callData),
    callGasLimit: BigInt(op.callGasLimit),
    verificationGasLimit: BigInt(op.verificationGasLimit),
    preVerificationGas: BigInt(op.preVerificationGas),
    maxFeePerGas: BigInt(op.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(op.maxPriorityFeePerGas),
    signature: toBytes(op.signature),
  };
}

/** Decodes Kernel execute(bytes32 mode, bytes executionCalldata) into calls (ethers). */
export function decodeKernelExecute(callData) {
  const iface = new ethers.Interface(['function execute(bytes32 mode, bytes executionCalldata)']);
  const [mode, execution] = iface.decodeFunctionData('execute', callData);
  const modeBytes = ethers.getBytes(mode);
  const exec = ethers.getBytes(execution);
  if (modeBytes[0] === 0x00) {
    return {
      callType: 0,
      execType: modeBytes[1],
      calls: [
        {
          to: ethers.getAddress(ethers.hexlify(exec.slice(0, 20))),
          value: BigInt(ethers.hexlify(exec.slice(20, 52))),
          data: ethers.hexlify(exec.slice(52)),
        },
      ],
    };
  }
  const [executions] = abi.decode(['tuple(address,uint256,bytes)[]'], execution);
  return {
    callType: modeBytes[0],
    execType: modeBytes[1],
    calls: executions.map((e) => ({ to: e[0], value: e[1], data: e[2] })),
  };
}

export function memoryStore() {
  const map = new Map();
  return {
    getItem: async (k) => (map.has(k) ? map.get(k) : null),
    setItem: async (k, v) => void map.set(k, v),
    _map: map,
  };
}
