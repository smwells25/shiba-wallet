import { describe, expect, it } from 'vitest';
import {
  Interface,
  Signature,
  Transaction,
  Wallet,
  hashAuthorization,
  hashMessage,
  recoverAddress,
  verifyAuthorization,
} from 'ethers';
import { HDKey } from '@scure/bip32';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  ChainRegistry,
  HdKeyring,
  evmKeyProvider,
  mnemonicToSeed,
  type DerivedAccount,
} from '@shiba-wallet/core';
import {
  EIP7702_SET_CODE_TX_TYPE,
  ZERO_ADDRESS,
  eip7702AuthorizationDigest,
  eip7702SigningHash,
  readDelegationStatus,
  recoverEip7702Authority,
  revokeDelegationAuthorization,
  selfSponsoredAuthorizationNonce,
  setCodeIntrinsicGas,
  signEip7702Authorization,
  signEip7702Transaction,
  toRpcEip7702Auth,
  type Eip7702Transaction,
  type SignedEip7702Authorization,
} from '../src/eip7702.js';
import {
  KERNEL_7702_SIGNATURE_PREFIX,
  KERNEL_V3_3,
  KERNEL_V3_3_7702_DELEGATE,
  createKernel7702AccountSpec,
  kernelErc1271Digest,
} from '../src/kernel-account.js';
import { SmartAccountClient } from '../src/smart-account.js';
import { ENTRYPOINT_V07, getUserOpHash } from '../src/userop.js';
import { toRpcUserOperation, type JsonRpcTransport } from '../src/rpc.js';
import { toBytes, toHex } from '../src/encoding.js';

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const SEPOLIA = 11155111n;

function account(addressIndex = 0): DerivedAccount {
  const registry = new ChainRegistry();
  registry.register(evmKeyProvider);
  return HdKeyring.fromMnemonic(TEST_MNEMONIC, registry).getAccount('eip155:1', 0, addressIndex);
}

/** ethers Wallet over the same key: the independent reference implementation. */
function referenceWallet(addressIndex = 0): Wallet {
  const node = HDKey.fromMasterSeed(mnemonicToSeed(TEST_MNEMONIC)).derive(`m/44'/60'/0'/0/${addressIndex}`);
  return new Wallet(bytesToHex(node.privateKey!));
}

function ethersAuth(signed: SignedEip7702Authorization) {
  return {
    chainId: signed.chainId,
    address: signed.address,
    nonce: signed.nonce,
    signature: Signature.from({ r: toHex(signed.r), s: toHex(signed.s), yParity: signed.yParity }),
  };
}

describe('EIP-7702 authorization tuples', () => {
  const cases = [
    { chainId: 1n, address: KERNEL_V3_3_7702_DELEGATE, nonce: 0n },
    { chainId: SEPOLIA, address: KERNEL_V3_3_7702_DELEGATE, nonce: 7n },
    { chainId: SEPOLIA, address: ZERO_ADDRESS, nonce: 1n },
    { chainId: 0xffffffffffffn, address: '0x00000000000000000000000000000000000000ff', nonce: (1n << 64n) - 2n },
  ];

  it('digest equals ethers hashAuthorization: keccak256(0x05 || rlp([chain_id, address, nonce]))', () => {
    for (const auth of cases) {
      expect(toHex(eip7702AuthorizationDigest(auth))).toBe(hashAuthorization(auth));
    }
  });

  it('signature (yParity, r, s) equals ethers Wallet.authorizeSync and recovers to the EOA', () => {
    const owner = account(7);
    const wallet = referenceWallet(7);
    expect(wallet.address).toBe(owner.address);
    for (const auth of cases.slice(0, 3)) {
      const ours = signEip7702Authorization(auth, owner);
      const theirs = wallet.authorizeSync(auth);
      expect(ours.yParity).toBe(theirs.signature.yParity);
      expect(toHex(ours.r)).toBe(theirs.signature.r);
      expect(toHex(ours.s)).toBe(theirs.signature.s);
      expect(verifyAuthorization(auth, theirs.signature)).toBe(owner.address);
      expect(recoverEip7702Authority(ours)).toBe(owner.address);
    }
  });

  it('a tampered tuple recovers to a different authority', () => {
    const owner = account();
    const signed = signEip7702Authorization({ chainId: SEPOLIA, address: KERNEL_V3_3_7702_DELEGATE, nonce: 3n }, owner);
    expect(recoverEip7702Authority({ ...signed, nonce: 4n })).not.toBe(owner.address);
    expect(recoverEip7702Authority({ ...signed, chainId: 1n })).not.toBe(owner.address);
  });

  it('refuses chain id 0, out-of-range nonces, bad addresses and high-s tuples', () => {
    const owner = account();
    expect(() => signEip7702Authorization({ chainId: 0n, address: KERNEL_V3_3_7702_DELEGATE, nonce: 0n }, owner)).toThrow(/chain id 0/);
    expect(() => eip7702AuthorizationDigest({ chainId: 1n, address: ZERO_ADDRESS, nonce: (1n << 64n) - 1n })).toThrow(/nonce/);
    expect(() => eip7702AuthorizationDigest({ chainId: 1n, address: '0x1234', nonce: 0n })).toThrow(/address/);
    const signed = signEip7702Authorization({ chainId: 1n, address: ZERO_ADDRESS, nonce: 0n }, owner);
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const highS = toBytes('0x' + (n - BigInt(toHex(signed.s))).toString(16).padStart(64, '0'));
    expect(() => recoverEip7702Authority({ ...signed, s: highS })).toThrow(/secp256k1n\/2/);
  });

  it('revocation targets the zero address; self-sponsored nonce is tx nonce + 1', () => {
    expect(revokeDelegationAuthorization(SEPOLIA, 5n)).toEqual({ chainId: SEPOLIA, address: ZERO_ADDRESS, nonce: 5n });
    expect(selfSponsoredAuthorizationNonce(4n)).toBe(5n);
  });

  it('bundler wire form matches the viem formatter rules (hex quantities, 32-byte r/s, 1-byte yParity)', () => {
    const signed = signEip7702Authorization({ chainId: SEPOLIA, address: KERNEL_V3_3_7702_DELEGATE, nonce: 0n }, account(7));
    const rpc = toRpcEip7702Auth(signed);
    expect(Object.keys(rpc).sort()).toEqual(['address', 'chainId', 'nonce', 'r', 's', 'yParity']);
    expect(rpc.chainId).toBe('0xaa36a7');
    expect(rpc.nonce).toBe('0x0');
    expect(rpc.address).toBe(KERNEL_V3_3_7702_DELEGATE);
    expect(rpc.r).toMatch(/^0x[0-9a-f]{64}$/);
    expect(rpc.s).toMatch(/^0x[0-9a-f]{64}$/);
    expect(rpc.yParity).toBe(signed.yParity === 0 ? '0x00' : '0x01');
  });
});

describe('EIP-7702 set-code (type 0x04) transactions', () => {
  function delegationTx(owner: DerivedAccount, delegate: string, txNonce: bigint): Eip7702Transaction {
    const auth = signEip7702Authorization(
      { chainId: SEPOLIA, address: delegate, nonce: selfSponsoredAuthorizationNonce(txNonce) },
      owner,
    );
    return {
      chainId: SEPOLIA,
      nonce: txNonce,
      maxPriorityFeePerGas: 1_500_000_000n,
      maxFeePerGas: 30_000_000_000n,
      gasLimit: 120_000n,
      to: owner.address,
      value: 0n,
      data: new Uint8Array([0xde, 0xad, 0x00]),
      authorizationList: [auth],
    };
  }

  async function ethersRaw(tx: Eip7702Transaction, wallet: Wallet): Promise<string> {
    return wallet.signTransaction(
      Transaction.from({
        type: 4,
        chainId: tx.chainId,
        nonce: Number(tx.nonce),
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
        maxFeePerGas: tx.maxFeePerGas,
        gasLimit: tx.gasLimit,
        to: tx.to,
        value: tx.value,
        data: tx.data ? toHex(tx.data) : '0x',
        accessList: [],
        authorizationList: tx.authorizationList.map(ethersAuth),
      }),
    );
  }

  it('delegation tx bytes, hash and signing digest equal ethers', async () => {
    const owner = account(7);
    const tx = delegationTx(owner, KERNEL_V3_3_7702_DELEGATE, 0n);
    const ours = signEip7702Transaction(tx, owner);
    const theirs = await ethersRaw(tx, referenceWallet(7));
    expect(ours.rawHex).toBe(theirs);
    expect(ours.raw[0]).toBe(EIP7702_SET_CODE_TX_TYPE);
    const parsed = Transaction.from(ours.rawHex);
    expect(parsed.type).toBe(4);
    expect(parsed.from).toBe(owner.address);
    expect(parsed.hash).toBe(ours.txHash);
    expect(parsed.unsignedHash).toBe(toHex(eip7702SigningHash(tx)));
    expect(parsed.authorizationList).toHaveLength(1);
    const auth = parsed.authorizationList![0]!;
    expect(auth.address).toBe(KERNEL_V3_3_7702_DELEGATE);
    expect(auth.nonce).toBe(1n);
    expect(auth.chainId).toBe(SEPOLIA);
    expect(verifyAuthorization(auth, auth.signature)).toBe(owner.address);
  });

  it('revocation tx (zero-address tuple) equals ethers and parses back', async () => {
    const owner = account();
    const txNonce = 12n;
    const revoke = signEip7702Authorization(
      revokeDelegationAuthorization(SEPOLIA, selfSponsoredAuthorizationNonce(txNonce)),
      owner,
    );
    const tx: Eip7702Transaction = {
      chainId: SEPOLIA,
      nonce: txNonce,
      maxPriorityFeePerGas: 1n,
      maxFeePerGas: 2n,
      gasLimit: setCodeIntrinsicGas(1) + 10_000n,
      to: owner.address,
      value: 0n,
      authorizationList: [revoke],
    };
    const ours = signEip7702Transaction(tx, owner);
    expect(ours.rawHex).toBe(await ethersRaw(tx, referenceWallet()));
    const parsed = Transaction.from(ours.rawHex);
    expect(parsed.authorizationList![0]!.address).toBe(ZERO_ADDRESS);
    expect(parsed.authorizationList![0]!.nonce).toBe(13n);
  });

  it('refuses an empty authorization list (EIP-7702: such a transaction is invalid)', () => {
    const owner = account();
    const tx = { ...delegationTx(owner, KERNEL_V3_3_7702_DELEGATE, 0n), authorizationList: [] };
    expect(() => signEip7702Transaction(tx, owner)).toThrow(/at least one authorization/);
  });

  it('intrinsic gas is 21000 + 25000 per tuple plus calldata cost', () => {
    expect(setCodeIntrinsicGas(1)).toBe(46_000n);
    expect(setCodeIntrinsicGas(2, new Uint8Array([0, 1]))).toBe(71_000n + 4n + 16n);
  });
});

describe('delegation status', () => {
  const node = (code: string): JsonRpcTransport => async (method) => {
    if (method === 'eth_getCode') return code;
    throw new Error(method);
  };

  it('classifies empty code, a delegation indicator and contract code', async () => {
    expect(await readDelegationStatus(node('0x'), ZERO_ADDRESS)).toEqual({ kind: 'none' });
    const indicator = '0xef0100' + KERNEL_V3_3_7702_DELEGATE.slice(2).toLowerCase();
    expect(await readDelegationStatus(node(indicator), ZERO_ADDRESS)).toEqual({
      kind: 'delegated',
      delegate: KERNEL_V3_3_7702_DELEGATE,
    });
    expect(await readDelegationStatus(node('0x6080604052'), ZERO_ADDRESS)).toEqual({ kind: 'contract' });
  });
});

describe('Kernel v3.3 as an EIP-7702 delegate', () => {
  const FEES = { maxFeePerGas: 100n, maxPriorityFeePerGas: 2n };
  const OTHER_DELEGATE = '0x8a67b5020ee254ef48e3b6a04927f39baf7e408a';

  function transports(code: string, opts: { chainId?: string; pendingNonce?: string } = {}) {
    const calls: Array<{ method: string; params: unknown[] }> = [];
    const node: JsonRpcTransport = async (method, params) => {
      calls.push({ method, params });
      if (method === 'eth_getCode') return code;
      if (method === 'eth_chainId') return opts.chainId ?? '0xaa36a7';
      if (method === 'eth_getTransactionCount') return opts.pendingNonce ?? '0x2';
      if (method === 'eth_call') return '0x' + '00'.repeat(31) + '05'; // EntryPoint nonce 5
      throw new Error(`unexpected node call ${method}`);
    };
    const bundler: JsonRpcTransport = async (method, params) => {
      calls.push({ method, params });
      if (method === 'eth_estimateUserOperationGas') {
        return { callGasLimit: '0x5000', verificationGasLimit: '0x20000', preVerificationGas: '0xc000' };
      }
      if (method === 'eth_sendUserOperation') return '0x' + 'ab'.repeat(32);
      throw new Error(`unexpected bundler call ${method}`);
    };
    return { calls, node, bundler };
  }

  it('the delegate is the Kernel v3.3 implementation (ZeroDev SDK KERNEL_7702_DELEGATION_ADDRESS)', () => {
    expect(KERNEL_V3_3_7702_DELEGATE).toBe(KERNEL_V3_3.implementation);
    expect(KERNEL_V3_3_7702_DELEGATE).toBe('0xd6CEDDe84be40893d153Be9d467CD6aD37875b28');
  });

  it('sender is the EOA, no factory; first op carries a tuple for the Kernel implementation at the pending nonce', async () => {
    const owner = account(7);
    const { calls, node, bundler } = transports('0x', { pendingNonce: '0x2' });
    const spec = createKernel7702AccountSpec({ node, chainId: SEPOLIA });
    expect(await spec.getAddress(owner)).toBe(owner.address);
    await expect(spec.getFactoryArgs(owner)).rejects.toThrow(/no factory/);

    const client = new SmartAccountClient({ chainId: SEPOLIA, entryPoint: ENTRYPOINT_V07, bundler, node, spec });
    const batch = [
      { to: '0x1111111111111111111111111111111111111111', value: 1n, data: new Uint8Array(0) },
      { to: owner.address, value: 0n, data: new Uint8Array(0) },
    ];
    const { userOpHash, userOp } = await client.sendCalls(owner, batch, FEES);
    expect(userOpHash).toBe('0x' + 'ab'.repeat(32));
    expect(calls.map((c) => c.method)).toEqual([
      'eth_getCode',
      'eth_chainId',
      'eth_getTransactionCount',
      'eth_call', // EntryPoint.getNonce(EOA, key 0)
      'eth_estimateUserOperationGas',
      'eth_sendUserOperation',
    ]);
    expect(userOp.sender).toBe(owner.address);
    expect(userOp.factory).toBeUndefined();
    expect(userOp.nonce).toBe(5n);

    // Both the estimate and the send carry the same eip7702Auth tuple.
    for (const method of ['eth_estimateUserOperationGas', 'eth_sendUserOperation']) {
      const rpcOp = calls.find((c) => c.method === method)!.params[0] as Record<string, unknown>;
      expect(rpcOp.factory).toBeUndefined();
      expect(rpcOp.factoryData).toBeUndefined();
      const auth = rpcOp.eip7702Auth as Record<string, string>;
      expect(auth.address).toBe(KERNEL_V3_3.implementation);
      expect(auth.chainId).toBe('0xaa36a7');
      expect(auth.nonce).toBe('0x2');
      // ethers recovers the authority from the wire form.
      expect(
        verifyAuthorization(
          { chainId: BigInt(auth.chainId), address: auth.address, nonce: BigInt(auth.nonce) },
          Signature.from({ r: auth.r, s: auth.s, yParity: Number(auth.yParity) as 0 | 1 }),
        ),
      ).toBe(owner.address);
    }

    // callData is ERC-7579 execute(bytes32,bytes) directly: no initialize().
    const iface = new Interface(['function execute(bytes32 mode, bytes executionCalldata)']);
    expect(toHex(userOp.callData.slice(0, 4))).toBe(iface.getFunction('execute')!.selector);

    // EntryPoint v0.7's userOpHash ignores the tuple (it is not in the packed op).
    const hash = getUserOpHash(userOp, ENTRYPOINT_V07, SEPOLIA);
    const { eip7702Auth: _omit, ...withoutAuth } = userOp;
    expect(toHex(getUserOpHash(withoutAuth, ENTRYPOINT_V07, SEPOLIA))).toBe(toHex(hash));

    // Signature: 65-byte EIP-191 signature over the userOpHash by the EOA itself
    // (Kernel _verify7702Signature(toEthSignedMessageHash(userOpHash))).
    expect(userOp.signature).toHaveLength(65);
    expect(recoverAddress(hashMessage(hash), toHex(userOp.signature))).toBe(owner.address);
  });

  it('omits the tuple once the EOA is already delegated to Kernel', async () => {
    const owner = account(7);
    const indicator = '0xef0100' + KERNEL_V3_3.implementation.slice(2).toLowerCase();
    const { calls, node, bundler } = transports(indicator);
    const client = new SmartAccountClient({
      chainId: SEPOLIA,
      entryPoint: ENTRYPOINT_V07,
      bundler,
      node,
      spec: createKernel7702AccountSpec({ node, chainId: SEPOLIA }),
    });
    const { userOp } = await client.sendCalls(owner, [{ to: owner.address, value: 0n, data: new Uint8Array(0) }], FEES);
    expect(userOp.eip7702Auth).toBeUndefined();
    const rpcOp = calls.find((c) => c.method === 'eth_sendUserOperation')!.params[0] as Record<string, unknown>;
    expect(rpcOp.eip7702Auth).toBeUndefined();
    expect(calls.map((c) => c.method)).not.toContain('eth_getTransactionCount');
  });

  it('refuses to replace a foreign delegation unless allowRedelegation, and refuses a chain mismatch', async () => {
    const owner = account(7);
    const foreign = transports('0xef0100' + OTHER_DELEGATE.slice(2));
    await expect(
      createKernel7702AccountSpec({ node: foreign.node, chainId: SEPOLIA }).getEip7702Authorization!(owner),
    ).rejects.toThrow(/refusing to replace/);
    const allowed = await createKernel7702AccountSpec({
      node: foreign.node,
      chainId: SEPOLIA,
      allowRedelegation: true,
    }).getEip7702Authorization!(owner);
    expect(allowed?.address).toBe(KERNEL_V3_3.implementation);

    const wrongChain = transports('0x', { chainId: '0x1' });
    await expect(
      createKernel7702AccountSpec({ node: wrongChain.node, chainId: SEPOLIA }).getEip7702Authorization!(owner),
    ).rejects.toThrow(/does not match/);

    const contract = transports('0x6080');
    await expect(
      createKernel7702AccountSpec({ node: contract.node, chainId: SEPOLIA }).getEip7702Authorization!(owner),
    ).rejects.toThrow(/not a delegation indicator/);
  });

  it('ERC-1271 envelope is 0x00 || raw ECDSA over the Kernel wrapper digest bound to the EOA', () => {
    const owner = account(7);
    const spec = createKernel7702AccountSpec({ node: transports('0x').node, chainId: SEPOLIA });
    const hash = toBytes(hashMessage('hello 7702'));
    const context = { chainId: SEPOLIA, account: owner.address };
    const sig = spec.signErc1271!(owner, hash, context);
    expect(sig).toHaveLength(66);
    expect(sig[0]).toBe(KERNEL_7702_SIGNATURE_PREFIX);
    expect(recoverAddress(toHex(kernelErc1271Digest(hash, context)), toHex(sig.slice(1)))).toBe(owner.address);
  });

  it('wire op includes eip7702Auth only when set', () => {
    const owner = account(7);
    const base = {
      sender: owner.address,
      nonce: 0n,
      callData: new Uint8Array(0),
      callGasLimit: 1n,
      verificationGasLimit: 1n,
      preVerificationGas: 1n,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      signature: new Uint8Array(65),
    };
    expect('eip7702Auth' in toRpcUserOperation(base)).toBe(false);
    const auth = signEip7702Authorization({ chainId: SEPOLIA, address: KERNEL_V3_3.implementation, nonce: 0n }, owner);
    expect(toRpcUserOperation({ ...base, eip7702Auth: auth }).eip7702Auth).toEqual(toRpcEip7702Auth(auth));
  });
});
