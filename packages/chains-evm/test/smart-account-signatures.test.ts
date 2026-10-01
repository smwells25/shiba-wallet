import { describe, expect, it } from 'vitest';
import {
  AbiCoder,
  Interface,
  TypedDataEncoder,
  Wallet,
  concat,
  hashMessage,
  id,
  keccak256,
  recoverAddress,
  toUtf8Bytes,
} from 'ethers';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import {
  ChainRegistry,
  HdKeyring,
  evmKeyProvider,
  type DerivedAccount,
} from '@shiba-wallet/core';
import {
  ERC1271_IS_VALID_SIGNATURE_SIGNATURE,
  ERC1271_MAGIC_VALUE,
  ERC1271_SELECTOR,
  decodeIsValidSignatureResult,
  encodeIsValidSignature,
  isErc1271MagicValue,
  verifyContractSignature,
} from '../src/erc1271.js';
import {
  ERC6492_MAGIC_SUFFIX,
  ecrecoverMatches,
  isErc6492Signature,
  unwrapErc6492Signature,
  verifyErc6492Signature,
  verifyWithDeploylessValidator,
  wrapErc6492Signature,
} from '../src/erc6492.js';
import {
  ERC7739_PERSONAL_SIGN_TYPEHASH,
  ERC7739_SUPPORT_MAGIC_V1,
  ERC7739_SUPPORT_PROBE_HASH,
  detectErc7739Support,
  erc7739ContentsDescription,
  erc7739PersonalSignDigest,
  erc7739PersonalSignRequest,
  erc7739TypedDataSignDigest,
  erc7739TypedDataSignRequest,
  erc7739VerifierView,
  readEip712Domain,
  wrapErc7739TypedDataSignature,
} from '../src/erc7739.js';
import {
  KERNEL_V3_3,
  KERNEL_WRAPPER_TYPE_HASH,
  createKernelAccountSpec,
  encodeKernelErc1271Signature,
  kernelErc1271Digest,
} from '../src/kernel-account.js';
import { createSimpleAccountSpec } from '../src/simple-account.js';
import { signHashForSmartAccount } from '../src/account-signatures.js';
import { SimulationUnsupportedError } from '../src/asset-diff.js';
import { encodeFunctionCall } from '../src/abi.js';
import { domainSeparator, hashStruct, typedDataDigest } from '../src/eip712.js';
import { eip191PrefixedMessage, hashEip191Message, withEthereumV } from '../src/smart-account.js';
import { toBytes, toHex, toWord } from '../src/encoding.js';
import type { JsonRpcTransport } from '../src/rpc.js';

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const STANDARD_OWNER = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const KERNEL_ACCOUNT = '0xB67b8b7cCA718EAC64d2b59ba568585A9FC69a42';
const SEPOLIA = 11155111n;
const coder = AbiCoder.defaultAbiCoder();

function ownerAccount(): DerivedAccount {
  const registry = new ChainRegistry();
  registry.register(evmKeyProvider);
  return HdKeyring.fromMnemonic(TEST_MNEMONIC, registry).getAccount('eip155:1');
}

function word(hex4: string): string {
  return hex4 + '00'.repeat(28);
}

/** Error shaped like httpTransport's for a JSON-RPC error response. */
function rpcError(code: number, message: string, method = 'eth_call'): Error {
  return new Error(`RPC error ${code}: ${message} (${method})`);
}

// EIP-712 Mail example (the EIP's own), reused by viem's ERC-7739 docs.
const MAIL_DOMAIN = {
  name: 'Ether Mail',
  version: '1',
  chainId: 1,
  verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC',
};
const MAIL_TYPES = {
  Person: [
    { name: 'name', type: 'string' },
    { name: 'wallet', type: 'address' },
  ],
  Mail: [
    { name: 'from', type: 'Person' },
    { name: 'to', type: 'Person' },
    { name: 'contents', type: 'string' },
  ],
};
const MAIL_MESSAGE = {
  from: { name: 'Cow', wallet: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826' },
  to: { name: 'Bob', wallet: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB' },
  contents: 'Hello, Bob!',
};
const KERNEL_LIKE_DOMAIN = {
  name: 'Kernel',
  version: '0.3.3',
  chainId: SEPOLIA,
  verifyingContract: KERNEL_ACCOUNT,
};
const FIXED_SIG = '0x' + 'ab'.repeat(64) + '1b';

/**
 * Independent reference values computed with viem 2.57.2
 * (viem/experimental/erc7739 hashTypedData, wrapTypedDataSignature,
 * hashMessage; viem serializeErc6492Signature, encodeFunctionData),
 * installed outside the repository on 2026-10-01 solely to produce them.
 */
const VIEM = {
  typedDataSignDigest: '0x72160a807bf431a5bc8eb69d9300208ebea54dbabb84e729cc432bdf218701c5',
  wrapped:
    '0x' +
    'ab'.repeat(64) +
    '1bf2cee375fa42b42143804025fc449deafd50cc031ca257e0b194a650a912090fc52c0ee5d84264471806290a3f2c4cecfc5490626bf912d01f240d7a274b371e4d61696c28506572736f6e2066726f6d2c506572736f6e20746f2c737472696e6720636f6e74656e747329506572736f6e28737472696e67206e616d652c616464726573732077616c6c657429004d',
  appDigest: '0xbe609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2',
  personalDigest: '0x10bb22595537631c74ec15a237b9f9bb793d60bd64e7d85629599e68775471fc',
  erc6492:
    '0x000000000000000000000000d703aae79538628d27099b8c4f621be4ccd142d5000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000004deadbeef000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000041abababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababab1b000000000000000000000000000000000000000000000000000000000000006492649264926492649264926492649264926492649264926492649264926492',
  isValidCalldata:
    '0x1626ba7e1111111111111111111111111111111111111111111111111111111111111111000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000021234000000000000000000000000000000000000000000000000000000000000',
};

describe('ERC-1271', () => {
  it('selector = magic value = bytes4(keccak256("isValidSignature(bytes32,bytes)")), pinned vs ethers', () => {
    expect(ERC1271_SELECTOR).toBe(id(ERC1271_IS_VALID_SIGNATURE_SIGNATURE).slice(0, 10));
    expect(ERC1271_SELECTOR).toBe('0x1626ba7e');
    expect(ERC1271_MAGIC_VALUE).toBe(ERC1271_SELECTOR);
  });

  it('isValidSignature calldata matches ethers and viem', () => {
    const hash = toBytes('0x' + '11'.repeat(32));
    const ours = toHex(encodeIsValidSignature(hash, toBytes('0x1234')));
    const reference = new Interface([
      'function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)',
    ]).encodeFunctionData('isValidSignature', [toHex(hash), '0x1234']);
    expect(ours).toBe(reference);
    expect(ours).toBe(VIEM.isValidCalldata);
    expect(() => encodeIsValidSignature(new Uint8Array(31), new Uint8Array(0))).toThrow(/32 bytes/);
  });

  it('decodes the bytes4 return strictly', () => {
    expect(decodeIsValidSignatureResult(toBytes(word('0x1626ba7e')))).toBe('0x1626ba7e');
    expect(isErc1271MagicValue(toBytes(word('0x1626ba7e')))).toBe(true);
    expect(isErc1271MagicValue(toBytes(word('0xffffffff')))).toBe(false);
    expect(() => decodeIsValidSignatureResult(toBytes('0x1626ba7e'))).toThrow(/32-byte/);
    expect(() => decodeIsValidSignatureResult(toBytes('0x1626ba7e' + '00'.repeat(27) + '01'))).toThrow(
      /padding/,
    );
    expect(isErc1271MagicValue(toBytes('0x1626ba7e'))).toBe(false);
  });

  it('verifyContractSignature: valid, rejected, reverted, no-code, and transport errors propagate', async () => {
    const hash = new Uint8Array(32).fill(7);
    const make = (call: () => unknown, code = '0x6001'): JsonRpcTransport => async (method) => {
      if (method === 'eth_getCode') return code;
      if (method === 'eth_call') return call();
      throw new Error(`unexpected ${method}`);
    };
    expect(await verifyContractSignature(make(() => word('0x1626ba7e')), KERNEL_ACCOUNT, hash, new Uint8Array(1))).toEqual({
      valid: true,
      magicValue: '0x1626ba7e',
    });
    expect(
      await verifyContractSignature(make(() => word('0xffffffff')), KERNEL_ACCOUNT, hash, new Uint8Array(1)),
    ).toMatchObject({ valid: false, reason: 'rejected' });
    expect(
      await verifyContractSignature(
        make(() => {
          throw rpcError(3, 'execution reverted');
        }),
        KERNEL_ACCOUNT,
        hash,
        new Uint8Array(1),
      ),
    ).toMatchObject({ valid: false, reason: 'reverted' });
    expect(
      await verifyContractSignature(make(() => '0x', '0x'), KERNEL_ACCOUNT, hash, new Uint8Array(1)),
    ).toMatchObject({ valid: false, reason: 'no-code' });
    expect(
      await verifyContractSignature(make(() => '0x1626ba7e'), KERNEL_ACCOUNT, hash, new Uint8Array(1)),
    ).toMatchObject({ valid: false, reason: 'malformed-return' });
    await expect(
      verifyContractSignature(
        make(() => {
          throw new Error('RPC HTTP error 429 for eth_call');
        }),
        KERNEL_ACCOUNT,
        hash,
        new Uint8Array(1),
      ),
    ).rejects.toThrow(/429/);
  });
});

describe('ERC-6492 envelope', () => {
  const parts = {
    factory: KERNEL_V3_3.metaFactory,
    factoryData: toBytes('0xdeadbeef'),
    signature: toBytes(FIXED_SIG),
  };

  it('wraps as abi.encode(address,bytes,bytes) || magicBytes, equal to ethers and viem', () => {
    const ours = toHex(wrapErc6492Signature(parts));
    const reference = concat([
      coder.encode(['address', 'bytes', 'bytes'], [parts.factory, '0xdeadbeef', FIXED_SIG]),
      ERC6492_MAGIC_SUFFIX,
    ]);
    expect(ours).toBe(reference);
    expect(ours).toBe(VIEM.erc6492);
    expect(ERC6492_MAGIC_SUFFIX).toBe('0x' + '6492'.repeat(16));
  });

  it('detects and unwraps; plain signatures are not envelopes', () => {
    const wrapped = wrapErc6492Signature(parts);
    expect(isErc6492Signature(wrapped)).toBe(true);
    expect(unwrapErc6492Signature(wrapped)).toEqual(parts);
    expect(isErc6492Signature(toBytes(FIXED_SIG))).toBe(false);
    expect(unwrapErc6492Signature(toBytes(FIXED_SIG))).toBeNull();
  });

  it('rejects malformed envelopes instead of half-reading them', () => {
    const magic = toBytes(ERC6492_MAGIC_SUFFIX);
    expect(() => unwrapErc6492Signature(magic)).toThrow(/shorter/);
    const wrapped = wrapErc6492Signature(parts);
    const dirty = wrapped.slice();
    dirty[0] = 1;
    expect(() => unwrapErc6492Signature(dirty)).toThrow(/dirty/);
    // Point the signature offset past the end.
    const badOffset = wrapped.slice();
    badOffset.set(toWord(10_000n), 64);
    expect(() => unwrapErc6492Signature(badOffset)).toThrow(/out of range/);
  });
});

describe('ERC-6492 verifier flow (fake node)', () => {
  const owner = ownerAccount();
  const hash = toBytes(hashMessage('verifier flow'));
  const inner = toBytes(FIXED_SIG);
  const wrapped = wrapErc6492Signature({
    factory: KERNEL_V3_3.metaFactory,
    factoryData: toBytes('0xdeadbeef'),
    signature: inner,
  });

  function node(opts: {
    code: string;
    ethCall?: () => unknown;
    simulate?: (payload: { blockStateCalls: { calls: Record<string, string>[] }[] }) => unknown;
  }): { transport: JsonRpcTransport; log: string[] } {
    const log: string[] = [];
    const transport: JsonRpcTransport = async (method, params) => {
      log.push(method);
      if (method === 'eth_getCode') return opts.code;
      if (method === 'eth_call' && opts.ethCall) return opts.ethCall();
      if (method === 'eth_simulateV1' && opts.simulate) return opts.simulate(params[0] as never);
      throw rpcError(-32601, 'the method does not exist/is not available', method);
    };
    return { transport, log };
  }

  it('counterfactual: simulates [factory call, isValidSignature(unwrapped)] in one block', async () => {
    let seen: Record<string, string>[] = [];
    const { transport } = node({
      code: '0x',
      simulate: (payload) => {
        seen = payload.blockStateCalls[0]!.calls;
        return [{ calls: [{ status: '0x1', returnData: '0x' }, { status: '0x1', returnData: word('0x1626ba7e') }] }];
      },
    });
    const result = await verifyErc6492Signature(transport, KERNEL_ACCOUNT, hash, wrapped);
    expect(result).toEqual({ valid: true, path: 'erc6492-counterfactual' });
    expect(seen).toHaveLength(2);
    expect(seen[0]!.to).toBe(KERNEL_V3_3.metaFactory);
    expect(seen[0]!.input).toBe('0xdeadbeef');
    expect(seen[1]!.to).toBe(KERNEL_ACCOUNT);
    expect(seen[1]!.input).toBe(toHex(encodeIsValidSignature(hash, inner)));
  });

  it('counterfactual: a failing factory call or a non-magic answer is invalid', async () => {
    const failed = node({
      code: '0x',
      simulate: () => [
        {
          calls: [
            { status: '0x0', returnData: '0x', error: { code: 3, message: 'execution reverted' } },
            { status: '0x1', returnData: '0x' },
          ],
        },
      ],
    });
    const r1 = await verifyErc6492Signature(failed.transport, KERNEL_ACCOUNT, hash, wrapped);
    expect(r1.valid).toBe(false);
    expect(r1.detail).toMatch(/factory\/prepare call failed/);
    const empty = node({
      code: '0x',
      simulate: () => [{ calls: [{ status: '0x1', returnData: '0x' }, { status: '0x1', returnData: '0x' }] }],
    });
    expect((await verifyErc6492Signature(empty.transport, KERNEL_ACCOUNT, hash, wrapped)).detail).toMatch(
      /did not leave code/,
    );
    const rejected = node({
      code: '0x',
      simulate: () => [{ calls: [{ status: '0x1', returnData: '0x' }, { status: '0x1', returnData: word('0xffffffff') }] }],
    });
    expect(await verifyErc6492Signature(rejected.transport, KERNEL_ACCOUNT, hash, wrapped)).toMatchObject({
      valid: false,
      path: 'erc6492-counterfactual',
    });
  });

  it('counterfactual: endpoints without eth_simulateV1 raise SimulationUnsupportedError', async () => {
    const { transport } = node({ code: '0x' });
    await expect(verifyErc6492Signature(transport, KERNEL_ACCOUNT, hash, wrapped)).rejects.toBeInstanceOf(
      SimulationUnsupportedError,
    );
  });

  it('deployed + envelope: ERC-1271 first; on rejection, prepare and retry', async () => {
    const direct = node({ code: '0x6001', ethCall: () => word('0x1626ba7e') });
    expect(await verifyErc6492Signature(direct.transport, KERNEL_ACCOUNT, hash, wrapped)).toEqual({
      valid: true,
      path: 'erc6492-deployed',
    });
    expect(direct.log).not.toContain('eth_simulateV1');
    const retry = node({
      code: '0x6001',
      ethCall: () => word('0xffffffff'),
      simulate: () => [{ calls: [{ status: '0x1', returnData: '0x' }, { status: '0x1', returnData: word('0x1626ba7e') }] }],
    });
    expect(await verifyErc6492Signature(retry.transport, KERNEL_ACCOUNT, hash, wrapped)).toEqual({
      valid: true,
      path: 'erc6492-prepare',
    });
  });

  it('no envelope: ERC-1271 when deployed, ecrecover when not', async () => {
    const deployed = node({ code: '0x6001', ethCall: () => word('0x1626ba7e') });
    expect(await verifyErc6492Signature(deployed.transport, KERNEL_ACCOUNT, hash, inner)).toEqual({
      valid: true,
      path: 'erc1271',
    });
    const eoaSig = withEthereumV(owner.sign(hash));
    const eoa = node({ code: '0x' });
    expect(await verifyErc6492Signature(eoa.transport, STANDARD_OWNER, hash, eoaSig)).toEqual({
      valid: true,
      path: 'ecrecover',
    });
    const other = await verifyErc6492Signature(eoa.transport, KERNEL_ACCOUNT, hash, eoaSig);
    expect(other).toMatchObject({ valid: false, path: 'ecrecover' });
    expect(other.detail).toContain(STANDARD_OWNER);
  });

  it('ecrecover path matches ethers recoverAddress and enforces v in {27, 28}', () => {
    const sig = withEthereumV(owner.sign(hash));
    expect(recoverAddress(toHex(hash), toHex(sig))).toBe(STANDARD_OWNER);
    expect(ecrecoverMatches(STANDARD_OWNER, hash, sig).valid).toBe(true);
    const v0 = sig.slice();
    v0[64] = v0[64]! - 27;
    expect(ecrecoverMatches(STANDARD_OWNER, hash, v0)).toMatchObject({ valid: false });
    expect(ecrecoverMatches(STANDARD_OWNER, hash, sig.slice(0, 64))).toMatchObject({ valid: false });
  });

  it('deployless validator route: creation code ++ abi.encode(signer, hash, signature), no `to`', async () => {
    const bytecode = toBytes('0x6080604052');
    let call: Record<string, string> = {};
    const transport: JsonRpcTransport = async (method, params) => {
      expect(method).toBe('eth_call');
      call = params[0] as Record<string, string>;
      return '0x01';
    };
    expect(await verifyWithDeploylessValidator(transport, bytecode, KERNEL_ACCOUNT, hash, wrapped)).toEqual({
      valid: true,
    });
    expect(call.to).toBeUndefined();
    expect(call.data).toBe(
      concat(['0x6080604052', coder.encode(['address', 'bytes32', 'bytes'], [KERNEL_ACCOUNT, toHex(hash), toHex(wrapped)])]),
    );
    const no: JsonRpcTransport = async () => '0x00';
    expect((await verifyWithDeploylessValidator(no, bytecode, KERNEL_ACCOUNT, hash, wrapped)).valid).toBe(false);
    const weird: JsonRpcTransport = async () => '0x' + '00'.repeat(32);
    await expect(verifyWithDeploylessValidator(weird, bytecode, KERNEL_ACCOUNT, hash, wrapped)).rejects.toThrow(
      /expected 0x01 or 0x00/,
    );
  });
});

describe('ERC-7739 nested typed data (wallet side)', () => {
  it('PersonalSign typehash equals the reference constant; support probe constants per the ERC', () => {
    expect(ERC7739_PERSONAL_SIGN_TYPEHASH).toBe(
      '0x983e65e5148e570cd828ead231ee759a8d7958721a768f93bc4483ba005c32de',
    );
    expect(ERC7739_PERSONAL_SIGN_TYPEHASH).toBe(id('PersonalSign(bytes prefixed)'));
    expect(ERC7739_SUPPORT_PROBE_HASH).toBe('0x' + '7739'.repeat(16));
    expect(ERC7739_SUPPORT_MAGIC_V1).toBe('0x77390001');
  });

  it('TypedDataSign digest (implicit mode) equals viem and an ethers encoding of the nested request', () => {
    const request = { domain: MAIL_DOMAIN, types: MAIL_TYPES, primaryType: 'Mail', message: MAIL_MESSAGE };
    const ours = toHex(erc7739TypedDataSignDigest(request, KERNEL_LIKE_DOMAIN));
    expect(ours).toBe(VIEM.typedDataSignDigest);
    const nested = erc7739TypedDataSignRequest(request, KERNEL_LIKE_DOMAIN);
    expect(TypedDataEncoder.hash(MAIL_DOMAIN, nested.types, nested.message)).toBe(ours);
    // The ERC's Solidity formula, from primitives (ethers keccak/abi):
    const contents = TypedDataEncoder.hashStruct('Mail', MAIL_TYPES, MAIL_MESSAGE);
    const typeHash = id(
      'TypedDataSign(Mail contents,string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)' +
        'Mail(Person from,Person to,string contents)Person(string name,address wallet)',
    );
    const structHash = keccak256(
      coder.encode(
        ['bytes32', 'bytes32', 'bytes32', 'bytes32', 'uint256', 'address', 'bytes32'],
        [typeHash, contents, id('Kernel'), id('0.3.3'), SEPOLIA, KERNEL_ACCOUNT, '0x' + '00'.repeat(32)],
      ),
    );
    expect(keccak256(concat(['0x1901', TypedDataEncoder.hashDomain(MAIL_DOMAIN), structHash]))).toBe(ours);
  });

  it('wrapped TypedDataSign signature equals viem and parses back through the reference verifier port', () => {
    const request = { domain: MAIL_DOMAIN, types: MAIL_TYPES, primaryType: 'Mail', message: MAIL_MESSAGE };
    const wrapped = wrapErc7739TypedDataSignature(toBytes(FIXED_SIG), request);
    expect(toHex(wrapped)).toBe(VIEM.wrapped);
    expect(erc7739ContentsDescription(MAIL_TYPES, 'Mail').mode).toBe('implicit');
    const appDigest = typedDataDigest(MAIL_DOMAIN, MAIL_TYPES, 'Mail', MAIL_MESSAGE);
    expect(toHex(appDigest)).toBe(VIEM.appDigest);
    const view = erc7739VerifierView(appDigest, wrapped, KERNEL_LIKE_DOMAIN);
    expect(view.workflow).toBe('TypedDataSign');
    if (!('digest' in view)) throw new Error('unexpected rejection');
    expect(toHex(view.digest)).toBe(VIEM.typedDataSignDigest);
    expect(toHex(view.innerSignature)).toBe(FIXED_SIG);
  });

  it('explicit mode when the contents type is not alphabetically first, and the account side agrees', () => {
    // "Order" depends on "Asset", which sorts first: contentsType must be
    // "Asset(...)Order(...)" (EIP-712 order under TypedDataSign), so the
    // name has to be appended (explicit mode).
    const types = {
      Asset: [
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint256' },
      ],
      Order: [
        { name: 'give', type: 'Asset' },
        { name: 'want', type: 'Asset' },
        { name: 'nonce', type: 'uint256' },
      ],
    };
    const message = {
      give: { token: '0x1111111111111111111111111111111111111111', amount: 5n },
      want: { token: '0x2222222222222222222222222222222222222222', amount: 7n },
      nonce: 1n,
    };
    const request = { domain: MAIL_DOMAIN, types, primaryType: 'Order', message };
    const description = erc7739ContentsDescription(types, 'Order');
    expect(description.mode).toBe('explicit');
    expect(description.contentsType).toBe(
      'Asset(address token,uint256 amount)Order(Asset give,Asset want,uint256 nonce)',
    );
    expect(description.contentsDescription).toBe(description.contentsType + 'Order');

    const owner = ownerAccount();
    const digest = erc7739TypedDataSignDigest(request, KERNEL_LIKE_DOMAIN);
    const nested = erc7739TypedDataSignRequest(request, KERNEL_LIKE_DOMAIN);
    expect(TypedDataEncoder.hash(MAIL_DOMAIN, nested.types, nested.message)).toBe(toHex(digest));
    const ownerSig = withEthereumV(owner.sign(digest));
    const wrapped = wrapErc7739TypedDataSignature(ownerSig, request);
    const view = erc7739VerifierView(typedDataDigest(MAIL_DOMAIN, types, 'Order', message), wrapped, KERNEL_LIKE_DOMAIN);
    if (view.workflow !== 'TypedDataSign' || !('digest' in view)) throw new Error('expected TypedDataSign');
    expect(view.contentsName).toBe('Order');
    expect(toHex(view.digest)).toBe(toHex(digest));
    expect(recoverAddress(toHex(view.digest), toHex(view.innerSignature))).toBe(STANDARD_OWNER);
  });

  it('PersonalSign digest equals viem and the ethers encoding of PersonalSign(bytes prefixed)', () => {
    const message = utf8ToBytes('Hello from Shiba Wallet');
    const ours = erc7739PersonalSignDigest(message, KERNEL_LIKE_DOMAIN);
    expect(toHex(ours)).toBe(VIEM.personalDigest);
    const request = erc7739PersonalSignRequest(message, KERNEL_LIKE_DOMAIN);
    expect(
      TypedDataEncoder.hash(KERNEL_LIKE_DOMAIN, { PersonalSign: [{ name: 'prefixed', type: 'bytes' }] }, request.message),
    ).toBe(toHex(ours));
    // The account side sees hash = hashMessage(m) and no appended data.
    const view = erc7739VerifierView(toBytes(hashMessage(message)), toBytes(FIXED_SIG), KERNEL_LIKE_DOMAIN);
    expect(view.workflow).toBe('PersonalSign');
    if (!('digest' in view)) throw new Error('unexpected');
    expect(toHex(view.digest)).toBe(toHex(ours));
  });

  it('refuses contents names the ERC tells accounts to reject, and TypedDataSign collisions', () => {
    const lower = { mail: MAIL_TYPES.Mail, Person: MAIL_TYPES.Person };
    expect(() => erc7739ContentsDescription(lower, 'mail')).toThrow(/lowercase/);
    expect(() =>
      erc7739ContentsDescription({ ...MAIL_TYPES, TypedDataSign: [{ name: 'x', type: 'uint256' }] }, 'Mail'),
    ).toThrow(/already defines a TypedDataSign/);
    expect(() => erc7739ContentsDescription(MAIL_TYPES, 'Missing')).toThrow(/not a struct/);
    // EIP712Domain entries in the request are ignored, not treated as contents.
    expect(
      erc7739ContentsDescription(
        { ...MAIL_TYPES, EIP712Domain: [{ name: 'name', type: 'string' }] },
        'Mail',
      ).contentsType,
    ).toBe('Mail(Person from,Person to,string contents)Person(string name,address wallet)');
  });

  it('verifier port rejects a crafted contentsName and falls back to PersonalSign on mismatch', () => {
    const request = { domain: MAIL_DOMAIN, types: MAIL_TYPES, primaryType: 'Mail', message: MAIL_MESSAGE };
    const appDigest = typedDataDigest(MAIL_DOMAIN, MAIL_TYPES, 'Mail', MAIL_MESSAGE);
    const sep = domainSeparator(MAIL_DOMAIN);
    const contents = hashStruct(MAIL_TYPES, 'Mail', MAIL_MESSAGE);
    const evil = utf8ToBytes('Mail(string x)mail x,');
    const crafted = toBytes(
      concat([FIXED_SIG, toHex(sep), toHex(contents), toHex(evil), '0x' + evil.length.toString(16).padStart(4, '0')]),
    );
    expect(erc7739VerifierView(appDigest, crafted, KERNEL_LIKE_DOMAIN)).toMatchObject({ workflow: 'TypedDataSign' });
    expect('rejected' in erc7739VerifierView(appDigest, crafted, KERNEL_LIKE_DOMAIN)).toBe(true);
    const wrapped = wrapErc7739TypedDataSignature(toBytes(FIXED_SIG), request);
    expect(erc7739VerifierView(new Uint8Array(32), wrapped, KERNEL_LIKE_DOMAIN).workflow).toBe('PersonalSign');
  });

  it('detectErc7739Support probes isValidSignature(0x7739…, "")', async () => {
    let data = '';
    const yes: JsonRpcTransport = async (_m, params) => {
      data = (params[0] as { data: string }).data;
      return word('0x77390001');
    };
    expect(await detectErc7739Support(yes, KERNEL_ACCOUNT)).toEqual({ supported: true, magicValue: '0x77390001' });
    expect(data).toBe(
      new Interface(['function isValidSignature(bytes32,bytes)']).encodeFunctionData('isValidSignature', [
        ERC7739_SUPPORT_PROBE_HASH,
        '0x',
      ]),
    );
    const reverts: JsonRpcTransport = async () => {
      throw rpcError(3, 'execution reverted');
    };
    expect(await detectErc7739Support(reverts, KERNEL_ACCOUNT)).toEqual({ supported: false });
    const other: JsonRpcTransport = async () => word('0xffffffff');
    expect((await detectErc7739Support(other, KERNEL_ACCOUNT)).supported).toBe(false);
  });

  it('readEip712Domain decodes ERC-5267 output and honours the fields bitmap', async () => {
    const encoded = coder.encode(
      ['bytes1', 'string', 'string', 'uint256', 'address', 'bytes32', 'uint256[]'],
      ['0x0f', 'Kernel', '0.3.3', SEPOLIA, KERNEL_ACCOUNT, '0x' + '00'.repeat(32), []],
    );
    const transport: JsonRpcTransport = async (_m, params) => {
      expect((params[0] as { data: string }).data).toBe(id('eip712Domain()').slice(0, 10));
      return encoded;
    };
    expect(await readEip712Domain(transport, KERNEL_ACCOUNT)).toEqual({
      domain: { name: 'Kernel', version: '0.3.3', chainId: SEPOLIA, verifyingContract: KERNEL_ACCOUNT },
      fields: 0x0f,
      extensions: [],
    });
  });
});

describe('Kernel v3.3 ERC-1271 envelope', () => {
  it('wrapper type hash equals keccak256("Kernel(bytes32 hash)") (Constants.sol at v3.3)', () => {
    expect(KERNEL_WRAPPER_TYPE_HASH).toBe(id('Kernel(bytes32 hash)'));
  });

  it('digest = EIP-712(Kernel domain of the account, Kernel{hash}), equal to ethers and the Solidity formula', () => {
    const hash = toBytes(hashMessage('Hello from Shiba Wallet'));
    const ours = toHex(kernelErc1271Digest(hash, { chainId: SEPOLIA, account: KERNEL_ACCOUNT }));
    expect(
      TypedDataEncoder.hash(KERNEL_LIKE_DOMAIN, { Kernel: [{ name: 'hash', type: 'bytes32' }] }, { hash: toHex(hash) }),
    ).toBe(ours);
    const separator = keccak256(
      coder.encode(
        ['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'],
        [
          id('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
          id('Kernel'),
          id('0.3.3'),
          SEPOLIA,
          KERNEL_ACCOUNT,
        ],
      ),
    );
    const structHash = keccak256(coder.encode(['bytes32', 'bytes32'], [KERNEL_WRAPPER_TYPE_HASH, toHex(hash)]));
    expect(keccak256(concat(['0x1901', separator, structHash]))).toBe(ours);
    // Bound to chain and account: different inputs, different digests.
    expect(toHex(kernelErc1271Digest(hash, { chainId: 1n, account: KERNEL_ACCOUNT }))).not.toBe(ours);
  });

  it('spec.signErc1271 returns 0x01 || ECDSA validator || owner signature over the wrapped digest', () => {
    const owner = ownerAccount();
    const spec = createKernelAccountSpec({ node: async () => '0x' });
    const hash = toBytes(hashMessage('Hello from Shiba Wallet'));
    const signature = spec.signErc1271!(owner, hash, { chainId: SEPOLIA, account: KERNEL_ACCOUNT });
    expect(signature.length).toBe(1 + 20 + 65);
    expect(toHex(signature.slice(0, 21))).toBe('0x01' + KERNEL_V3_3.ecdsaValidator.slice(2).toLowerCase());
    const digest = kernelErc1271Digest(hash, { chainId: SEPOLIA, account: KERNEL_ACCOUNT });
    expect(recoverAddress(toHex(digest), toHex(signature.slice(21)))).toBe(STANDARD_OWNER);
    expect(toHex(encodeKernelErc1271Signature(KERNEL_V3_3.ecdsaValidator, signature.slice(21)))).toBe(toHex(signature));
  });

  it('SimpleAccount (v0.7.0 sample has no isValidSignature) exposes no ERC-1271 signing', () => {
    const spec = createSimpleAccountSpec({ factory: KERNEL_V3_3.factory, node: async () => '0x' });
    expect(spec.signErc1271).toBeUndefined();
  });
});

describe('signHashForSmartAccount', () => {
  const owner = ownerAccount();
  const hash = hashEip191Message(utf8ToBytes('Hello from Shiba Wallet'));

  function kernelNode(code: string): JsonRpcTransport {
    return async (method) => {
      if (method === 'eth_call') return '0x' + '00'.repeat(12) + KERNEL_ACCOUNT.slice(2).toLowerCase();
      if (method === 'eth_getCode') return code;
      throw new Error(`unexpected ${method}`);
    };
  }

  it('EIP-191 helpers equal ethers hashMessage', () => {
    const m = utf8ToBytes('Hello from Shiba Wallet');
    expect(toHex(hash)).toBe(hashMessage(m));
    expect(toHex(eip191PrefixedMessage(m))).toBe(concat([toUtf8Bytes('\x19Ethereum Signed Message:\n23'), m]));
  });

  it('undeployed Kernel: ERC-6492 envelope around the Kernel envelope, factory args from the spec', async () => {
    const node = kernelNode('0x');
    const spec = createKernelAccountSpec({ node });
    const result = await signHashForSmartAccount(spec, owner, hash, { chainId: SEPOLIA, node });
    expect(result).toMatchObject({ account: KERNEL_ACCOUNT, deployed: false, erc6492: true });
    const parts = unwrapErc6492Signature(result.signature)!;
    const factoryArgs = await spec.getFactoryArgs(owner);
    expect(parts.factory).toBe(KERNEL_V3_3.metaFactory);
    expect(toHex(parts.factoryData)).toBe(toHex(factoryArgs.factoryData));
    expect(toHex(parts.signature)).toBe(
      toHex(spec.signErc1271!(owner, hash, { chainId: SEPOLIA, account: KERNEL_ACCOUNT })),
    );
    // factoryData is deployWithFactory(factory, initData, bytes32(index)).
    expect(toHex(parts.factoryData).slice(0, 10)).toBe(
      toHex(encodeFunctionCall('deployWithFactory(address,bytes,bytes32)', []).slice(0, 4)),
    );
  });

  it('deployed Kernel: plain Kernel envelope, no ERC-6492 wrapper', async () => {
    const node = kernelNode('0x6001');
    const result = await signHashForSmartAccount(createKernelAccountSpec({ node }), owner, hash, {
      chainId: SEPOLIA,
      node,
    });
    expect(result.erc6492).toBe(false);
    expect(result.signature.length).toBe(86);
  });

  it('refuses specs without ERC-1271 support rather than returning an owner-EOA signature', async () => {
    const node = kernelNode('0x');
    const spec = createSimpleAccountSpec({ factory: KERNEL_V3_3.factory, node });
    await expect(signHashForSmartAccount(spec, owner, hash, { chainId: SEPOLIA, node })).rejects.toThrow(
      /does not support ERC-1271/,
    );
  });

  it('the ethers Wallet for the standard mnemonic is the same owner (sanity)', () => {
    expect(Wallet.fromPhrase(TEST_MNEMONIC).address).toBe(STANDARD_OWNER);
  });
});
