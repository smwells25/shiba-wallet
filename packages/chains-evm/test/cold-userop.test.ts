import { describe, expect, it } from 'vitest';
import { Interface, getBytes, hashMessage, recoverAddress, Signature } from 'ethers';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ChainRegistry, HdKeyring, evmKeyProvider, type DerivedAccount } from '@shiba-wallet/core';
import {
  EXTERNAL_PREPARED_ALTERED,
  EXTERNAL_SIGNER_7702_REFUSAL,
  ExternalSignatureError,
  SmartAccountClient,
  addressOnlyOwner,
  recoverExternalSigner,
  type Call,
  type ExternalSignature,
  type PreparedExternalUserOperation,
  type SmartAccountSpec,
} from '../src/smart-account.js';
import {
  COLD_USEROP_7702_REFUSAL,
  COLD_USEROP_EXPIRED,
  COLD_USEROP_HASH_MISMATCH,
  COLD_USEROP_IS_THE_REQUEST,
  COLD_USEROP_NOT_A_REQUEST,
  COLD_USEROP_NOT_A_SIGNATURE,
  COLD_USEROP_OTHER_REQUEST,
  ColdUserOpRefusedError,
  KERNEL_ECDSA_ROOT_SCHEME_ID,
  KERNEL_V3_3_ECDSA_ROOT_SCHEME,
  buildColdUserOpRequest,
  buildColdUserOpSignature,
  coldUserOpDetails,
  decodeKernelExecuteCalls,
  parseColdUserOpRequest,
  preparedFromColdUserOpRequest,
  serializeColdUserOpRequest,
  submitColdUserOpRequest,
  verifyColdUserOpSignature,
  type ColdUserOpRequest,
} from '../src/cold-userop.js';
import { KERNEL_V3_3, createKernelAccountSpec, encodeKernelExecute, predictKernelAddress } from '../src/kernel-account.js';
import { ENTRYPOINT_V07, getUserOpHash } from '../src/userop.js';
import { toBytes, toHex } from '../src/encoding.js';
import { toRpcUserOperation, type JsonRpcTransport } from '../src/rpc.js';

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function account(index: number): DerivedAccount {
  const registry = new ChainRegistry();
  registry.register(evmKeyProvider);
  return HdKeyring.fromMnemonic(TEST_MNEMONIC, registry).getAccount('eip155:1', 0, index);
}

const OWNER = account(0);
const STRANGER = account(1);
const CHAIN = 11155111n;
const FEES = { maxFeePerGas: 2_310_000_000n, maxPriorityFeePerGas: 2_310_000_000n };
const RECIPIENT = '0x2222222222222222222222222222222222222222';
const CALLS: Call[] = [{ to: RECIPIENT, value: 100_000_000_000_000n, data: new Uint8Array(0) }];
const NOW = 1_800_000_000;

const GET_NONCE = '0x35567e1a'; // getNonce(address,uint192)
const BALANCE_OF = '0x70a08231'; // balanceOf(address)
const GET_ADDRESS = '0x48aac392'; // KernelFactory getAddress(bytes,bytes32), checked against ethers below

interface Recorded {
  method: string;
  params: unknown[];
}

/**
 * Fake node + bundler for the real Kernel v3.3 spec: the factory's
 * getAddress answers the local CREATE2 prediction, the EntryPoint answers a
 * nonce and a zero deposit, eth_getCode a configurable deployment state.
 */
function transports(state: { nonce: bigint; deployed: boolean; owner: string; index?: bigint }) {
  const calls: Recorded[] = [];
  const predicted = predictKernelAddress(state.owner, { index: state.index ?? 0n });
  const node: JsonRpcTransport = async (method, params) => {
    calls.push({ method, params });
    if (method === 'eth_getCode') return state.deployed ? '0x6001' : '0x';
    if (method === 'eth_call') {
      const { to, data } = params[0] as { to: string; data: string };
      if (data.startsWith(GET_NONCE) && to === ENTRYPOINT_V07) return '0x' + state.nonce.toString(16).padStart(64, '0');
      if (data.startsWith(BALANCE_OF) && to === ENTRYPOINT_V07) return '0x' + '00'.repeat(32);
      if (data.startsWith(GET_ADDRESS) && to === KERNEL_V3_3.factory) return '0x' + '00'.repeat(12) + predicted.slice(2).toLowerCase();
      throw new Error(`unexpected eth_call ${to} ${data.slice(0, 10)}`);
    }
    throw new Error(`unexpected node method ${method}`);
  };
  const sent: unknown[] = [];
  const bundler: JsonRpcTransport = async (method, params) => {
    calls.push({ method, params });
    if (method === 'eth_estimateUserOperationGas') {
      return { callGasLimit: '0xc350', verificationGasLimit: '0x61a80', preVerificationGas: '0xd6d8' };
    }
    if (method === 'eth_sendUserOperation') {
      sent.push(params[0]);
      return '0x' + 'ab'.repeat(32);
    }
    throw new Error(`unexpected bundler method ${method}`);
  };
  return { calls, node, bundler, sent, predicted };
}

function countingSpec(spec: SmartAccountSpec): { spec: SmartAccountSpec; signs: { count: number } } {
  const signs = { count: 0 };
  return {
    signs,
    spec: {
      ...spec,
      signUserOpHash: (owner, hash, context) => {
        signs.count++;
        return spec.signUserOpHash(owner, hash, context);
      },
    },
  };
}

function client(t: ReturnType<typeof transports>, spec?: SmartAccountSpec) {
  return new SmartAccountClient({
    chainId: CHAIN,
    entryPoint: ENTRYPOINT_V07,
    bundler: t.bundler,
    node: t.node,
    spec: spec ?? createKernelAccountSpec({ node: t.node }),
    depositTopUpVerificationGas: 40_000n,
  });
}

/** What the off-line key returns for a digest: (yParity, r, s) from core's r || s || recid. */
function signDigest(key: DerivedAccount, digest: Uint8Array): ExternalSignature {
  const sig = key.sign(digest);
  return { yParity: sig[64] as 0 | 1, r: sig.slice(0, 32), s: sig.slice(32, 64) };
}

async function prepareFor(nonce = 5n, deployed = false, calls: Call[] = CALLS) {
  const t = transports({ nonce, deployed, owner: OWNER.address });
  const c = client(t);
  const prepared = await c.prepareUserOperationForExternalSigner(OWNER.address, calls, FEES, {
    scheme: KERNEL_V3_3_ECDSA_ROOT_SCHEME,
  });
  return { t, c, prepared };
}

describe('pinned facts', () => {
  it('selectors used by the fake node and the decoder equal ethers', () => {
    const i = new Interface([
      'function getNonce(address,uint192)',
      'function balanceOf(address)',
      'function getAddress(bytes,bytes32)',
      'function execute(bytes32,bytes)',
    ]);
    expect(i.getFunction('getNonce')!.selector).toBe(GET_NONCE);
    expect(i.getFunction('balanceOf')!.selector).toBe(BALANCE_OF);
    expect(i.getFunction('getAddress')!.selector).toBe(GET_ADDRESS);
    expect(i.getFunction('execute')!.selector).toBe('0xe9ae5c53');
  });
});

describe('prepare runs the same pipeline as sendCalls, and the scheme reproduces the spec signature', () => {
  it('same requests, same operation, same userOpHash; scheme(owner key) == spec.signUserOpHash byte for byte', async () => {
    const a = transports({ nonce: 5n, deployed: false, owner: OWNER.address });
    const sent = await client(a).sendCalls(OWNER, CALLS, FEES);
    const b = transports({ nonce: 5n, deployed: false, owner: OWNER.address });
    const prepared = await client(b).prepareUserOperationForExternalSigner(OWNER.address, CALLS, FEES, {
      scheme: KERNEL_V3_3_ECDSA_ROOT_SCHEME,
    });
    // Identical request sequence up to the submission (sendCalls makes one more: eth_sendUserOperation).
    expect(b.calls.map((c) => c.method)).toEqual(a.calls.map((c) => c.method).slice(0, -1));
    expect(JSON.stringify(b.calls)).toBe(JSON.stringify(a.calls.slice(0, -1)));
    const { signature: _s, ...signedFields } = sent.userOp;
    const { signature: _p, ...preparedFields } = prepared.userOp;
    expect(preparedFields).toEqual(signedFields);
    expect(prepared.userOp.factory).toBe(KERNEL_V3_3.metaFactory);
    expect(toHex(prepared.userOpHash)).toBe(toHex(getUserOpHash(sent.userOp, ENTRYPOINT_V07, CHAIN)));
    // The digest is the EIP-191 form (ethers' hashMessage over the 32 raw bytes).
    expect(toHex(prepared.signingDigest)).toBe(hashMessage(prepared.userOpHash));
    const external = KERNEL_V3_3_ECDSA_ROOT_SCHEME.encodeSignature(signDigest(OWNER, prepared.signingDigest));
    expect(toHex(external)).toBe(toHex(sent.userOp.signature));
    expect(prepared.nonceKey).toBe(0n);
    expect(prepared.ownerAddress).toBe(OWNER.address);
  });

  it('the address-only owner cannot sign, and preparation never asks the spec to sign', async () => {
    const owner = addressOnlyOwner(OWNER.address.toLowerCase(), CHAIN);
    expect(owner.address).toBe(OWNER.address);
    expect(() => owner.sign(new Uint8Array(32))).toThrow(/not on this device/);
    expect(() => addressOnlyOwner('0x1234', CHAIN)).toThrow();
    const t = transports({ nonce: 1n, deployed: true, owner: OWNER.address });
    const counted = countingSpec(createKernelAccountSpec({ node: t.node }));
    await client(t, counted.spec).prepareUserOperationForExternalSigner(OWNER.address, CALLS, FEES, {
      scheme: KERNEL_V3_3_ECDSA_ROOT_SCHEME,
    });
    expect(counted.signs.count).toBe(0);
  });

  it('beforeSign at preparation sees the final operation and can stop it', async () => {
    const t = transports({ nonce: 1n, deployed: true, owner: OWNER.address });
    const seen: bigint[] = [];
    await expect(
      client(t).prepareUserOperationForExternalSigner(OWNER.address, CALLS, FEES, {
        scheme: KERNEL_V3_3_ECDSA_ROOT_SCHEME,
        beforeSign: (op) => {
          seen.push(op.maxFeePerGas);
          throw new Error('fee too high');
        },
      }),
    ).rejects.toThrow('fee too high');
    expect(seen).toEqual([FEES.maxFeePerGas]);
  });
});

describe('submitPreparedUserOperation', () => {
  it('sends exactly the operation sendCalls would have sent, with the spec never signing', async () => {
    const a = transports({ nonce: 5n, deployed: false, owner: OWNER.address });
    const viaSendCalls = await client(a).sendCalls(OWNER, CALLS, FEES);
    const t = transports({ nonce: 5n, deployed: false, owner: OWNER.address });
    const counted = countingSpec(createKernelAccountSpec({ node: t.node }));
    const c = client(t, counted.spec);
    const prepared = await c.prepareUserOperationForExternalSigner(OWNER.address, CALLS, FEES, {
      scheme: KERNEL_V3_3_ECDSA_ROOT_SCHEME,
    });
    const before = t.calls.length;
    const seen: Uint8Array[] = [];
    const result = await c.submitPreparedUserOperation(prepared, signDigest(OWNER, prepared.signingDigest), {
      beforeSign: (op) => {
        seen.push(op.signature);
      },
    });
    expect(JSON.stringify(t.sent[0])).toBe(JSON.stringify(toRpcUserOperation(viaSendCalls.userOp)));
    expect(result.userOpHash).toBe('0x' + 'ab'.repeat(32));
    expect(counted.signs.count).toBe(0);
    // beforeSign saw the estimation stub, as at preparation, not the real signature.
    expect(toHex(seen[0]!)).toBe(toHex(createKernelAccountSpec({ node: t.node }).stubSignature()));
    // Chain reads, then the submission: factory getAddress, nonce, code, send.
    expect(t.calls.slice(before).map((c) => c.method)).toEqual(['eth_call', 'eth_getCode', 'eth_sendUserOperation']);
  });

  it('refuses before any request: a wrong signer, a replayed signature, a high s, a bad yParity', async () => {
    const { t, c, prepared } = await prepareFor();
    const other = await prepareFor(5n, false, [{ to: RECIPIENT, value: 1n, data: new Uint8Array(0) }]);
    const before = t.calls.length;
    await expect(c.submitPreparedUserOperation(prepared, signDigest(STRANGER, prepared.signingDigest))).rejects.toThrow(
      /recovers to .* not to the owner/,
    );
    // A real owner signature, but over another prepared operation.
    await expect(
      c.submitPreparedUserOperation(prepared, signDigest(OWNER, other.prepared.signingDigest)),
    ).rejects.toThrow(ExternalSignatureError);
    // A raw-userOpHash signature (which the validator would accept) is not what was asked for.
    await expect(c.submitPreparedUserOperation(prepared, signDigest(OWNER, prepared.userOpHash))).rejects.toThrow(
      /not to the owner/,
    );
    const good = signDigest(OWNER, prepared.signingDigest);
    const n = secp256k1.Point.Fn.ORDER;
    const highS = toBytes('0x' + (n - BigInt(toHex(good.s))).toString(16).padStart(64, '0'));
    await expect(
      c.submitPreparedUserOperation(prepared, { yParity: good.yParity === 0 ? 1 : 0, r: good.r, s: highS }),
    ).rejects.toThrow(/above secp256k1n\/2/);
    await expect(c.submitPreparedUserOperation(prepared, { ...good, yParity: 2 as 0 })).rejects.toThrow(/yParity/);
    expect(t.calls.length).toBe(before);
    expect(t.sent).toEqual([]);
  });

  it('a tampered prepared record is refused before any request; the signed fees cannot be repriced', async () => {
    const { t, c, prepared } = await prepareFor();
    const sig = signDigest(OWNER, prepared.signingDigest);
    const before = t.calls.length;
    // Raising the fee in place: the stored hash no longer matches.
    const raised: PreparedExternalUserOperation = {
      ...prepared,
      userOp: { ...prepared.userOp, maxFeePerGas: prepared.userOp.maxFeePerGas * 2n },
    };
    await expect(c.submitPreparedUserOperation(raised, sig)).rejects.toThrow(EXTERNAL_PREPARED_ALTERED);
    // Only the stored userOpHash altered (fields and digest intact): still refused as altered.
    await expect(
      c.submitPreparedUserOperation({ ...prepared, userOpHash: new Uint8Array(32).fill(7) }, sig),
    ).rejects.toThrow(EXTERNAL_PREPARED_ALTERED);
    // Raising it AND recomputing the hash and digest consistently: the old signature recovers elsewhere.
    const hash = getUserOpHash(raised.userOp, ENTRYPOINT_V07, CHAIN);
    const consistent = { ...raised, userOpHash: hash, signingDigest: KERNEL_V3_3_ECDSA_ROOT_SCHEME.digest(hash) };
    await expect(c.submitPreparedUserOperation(consistent, sig)).rejects.toThrow(/not to the owner/);
    // Another recipient, consistently rehashed: refused the same way.
    const redirected = { ...prepared.userOp, callData: encodeKernelExecute([{ ...CALLS[0]!, to: STRANGER.address }]) };
    const h2 = getUserOpHash(redirected, ENTRYPOINT_V07, CHAIN);
    await expect(
      c.submitPreparedUserOperation(
        { ...prepared, userOp: redirected, userOpHash: h2, signingDigest: KERNEL_V3_3_ECDSA_ROOT_SCHEME.digest(h2) },
        sig,
      ),
    ).rejects.toThrow(/not to the owner/);
    // Another chain or EntryPoint.
    await expect(c.submitPreparedUserOperation({ ...prepared, chainId: 1n }, sig)).rejects.toThrow(/chain 1/);
    await expect(
      c.submitPreparedUserOperation({ ...prepared, entryPoint: '0x' + '11'.repeat(20) }, sig),
    ).rejects.toThrow(/EntryPoint/);
    expect(t.calls.length).toBe(before);
    expect(t.sent).toEqual([]);
  });

  it('the caller fee check runs last and a refusal sends nothing (the floor moved: prepare again)', async () => {
    const { t, c, prepared } = await prepareFor();
    await expect(
      c.submitPreparedUserOperation(prepared, signDigest(OWNER, prepared.signingDigest), {
        beforeSign: async () => {
          throw new Error("The bundler's minimum fee rose");
        },
      }),
    ).rejects.toThrow('minimum fee rose');
    expect(t.calls.some((x) => x.method === 'eth_getCode')).toBe(true);
    expect(t.sent).toEqual([]);
  });

  it('refuses a nonce used meanwhile and a deployment that already happened', async () => {
    const { t, c, prepared } = await prepareFor(5n, false);
    const sig = signDigest(OWNER, prepared.signingDigest);
    // Same transports, now answering a later nonce.
    const t2 = transports({ nonce: 6n, deployed: false, owner: OWNER.address });
    const c2 = client(t2);
    await expect(c2.submitPreparedUserOperation(prepared, sig)).rejects.toThrow(/nonce is now 6/);
    const t3 = transports({ nonce: 5n, deployed: true, owner: OWNER.address });
    await expect(client(t3).submitPreparedUserOperation(prepared, sig)).rejects.toThrow(/deploy it again/);
    const deployedPrep = await prepareFor(5n, true);
    const t4 = transports({ nonce: 5n, deployed: false, owner: OWNER.address });
    await expect(
      client(t4).submitPreparedUserOperation(deployedPrep.prepared, signDigest(OWNER, deployedPrep.prepared.signingDigest)),
    ).rejects.toThrow(/no code/);
    expect([...t2.sent, ...t3.sent, ...t4.sent, ...t.sent]).toEqual([]);
    void c;
  });

  it('an EIP-7702 spec is refused at preparation and submission, before any request (D6)', async () => {
    const t = transports({ nonce: 1n, deployed: true, owner: OWNER.address });
    const spec7702: SmartAccountSpec = {
      ...createKernelAccountSpec({ node: t.node }),
      getEip7702Authorization: async () => {
        throw new Error('must not be reached');
      },
    };
    const c = client(t, spec7702);
    await expect(
      c.prepareUserOperationForExternalSigner(OWNER.address, CALLS, FEES, { scheme: KERNEL_V3_3_ECDSA_ROOT_SCHEME }),
    ).rejects.toThrow(EXTERNAL_SIGNER_7702_REFUSAL);
    const { prepared } = await prepareFor(1n, true);
    await expect(c.submitPreparedUserOperation(prepared, signDigest(OWNER, prepared.signingDigest))).rejects.toThrow(
      EXTERNAL_SIGNER_7702_REFUSAL,
    );
    expect(t.calls).toEqual([]);
  });

  it('recoverExternalSigner agrees with ethers', async () => {
    const digest = toBytes(hashMessage(getBytes('0x' + '42'.repeat(32))));
    const sig = signDigest(OWNER, digest);
    const ethersAddress = recoverAddress(
      digest,
      Signature.from({ r: toHex(sig.r), s: toHex(sig.s), yParity: sig.yParity }),
    );
    expect(recoverExternalSigner(digest, sig)).toBe(ethersAddress);
    expect(ethersAddress).toBe(OWNER.address);
  });
});

describe('request and signature payloads', () => {
  async function request(deployed = false): Promise<{ req: ColdUserOpRequest; prepared: PreparedExternalUserOperation }> {
    const { prepared } = await prepareFor(5n, deployed);
    const req = buildColdUserOpRequest(prepared, {
      summary: 'Send 0.0001 test ETH to 0x2222…2222 and deploy the account.',
      accountIndex: deployed ? null : 0n,
      nowSeconds: NOW,
      requestId: '0x' + '5a'.repeat(16),
    });
    return { req, prepared };
  }

  it('round-trips, and the prepared operation read back is the original', async () => {
    const { req, prepared } = await request();
    expect(req.type).toBe('shiba-wallet/cold-sign-userop-request');
    expect(req.version).toBe(1);
    expect(req.scheme).toBe(KERNEL_ECDSA_ROOT_SCHEME_ID);
    expect(req.accountIndex).toBe('0');
    expect(req.expiresAt).toBe(String(NOW + 1800));
    const text = serializeColdUserOpRequest(req);
    expect(parseColdUserOpRequest(text)).toEqual(req);
    const back = preparedFromColdUserOpRequest(req);
    const { signature: _a, ...x } = back.userOp;
    const { signature: _b, ...y } = prepared.userOp;
    expect(x).toEqual(y);
    expect(toHex(back.userOpHash)).toBe(toHex(prepared.userOpHash));
    const details = coldUserOpDetails(req);
    expect(details.deploys).toBe(true);
    expect(details.calls).toEqual(CALLS.map((c) => ({ ...c, to: c.to })));
    expect(details.worstCaseFee).toBe(
      (prepared.userOp.verificationGasLimit + prepared.userOp.callGasLimit + prepared.userOp.preVerificationGas) *
        FEES.maxFeePerGas,
    );
    const deployedReq = (await request(true)).req;
    expect(deployedReq.accountIndex).toBeNull();
    expect(deployedReq.userOp.factory).toBeNull();
  });

  it('the signature payload verifies, and every refusal has its sentence', async () => {
    const { req } = await request();
    const sig = signDigest(OWNER, toBytes(req.signingDigest));
    const text = buildColdUserOpSignature(req, OWNER.address, sig);
    const verified = verifyColdUserOpSignature(text, req);
    expect(verified.signer).toBe(OWNER.address);
    const p = JSON.parse(text);
    expect(() => verifyColdUserOpSignature(serializeColdUserOpRequest(req), req)).toThrow(COLD_USEROP_IS_THE_REQUEST);
    expect(() => verifyColdUserOpSignature('{"type":"x"}', req)).toThrow(COLD_USEROP_NOT_A_SIGNATURE);
    expect(() => verifyColdUserOpSignature(JSON.stringify({ ...p, requestId: '0x' + '00'.repeat(16) }), req)).toThrow(
      COLD_USEROP_OTHER_REQUEST,
    );
    expect(() => verifyColdUserOpSignature(JSON.stringify({ ...p, userOpHash: '0x' + '00'.repeat(32) }), req)).toThrow(
      COLD_USEROP_HASH_MISMATCH,
    );
    expect(() => verifyColdUserOpSignature(JSON.stringify({ ...p, extra: 1 }), req)).toThrow(/unexpected or missing/);
    expect(() => verifyColdUserOpSignature(JSON.stringify({ ...p, signer: STRANGER.address }), req)).toThrow(
      /made by .* not by the owner/,
    );
    const stranger = buildColdUserOpSignature(req, OWNER.address, signDigest(STRANGER, toBytes(req.signingDigest)));
    expect(() => verifyColdUserOpSignature(stranger, req)).toThrow(/made by .* not by the owner/);
  });

  it('refuses EIP-7702 material, other types, altered fields and foreign deployments', async () => {
    const { req } = await request();
    const o = JSON.parse(serializeColdUserOpRequest(req));
    expect(() => parseColdUserOpRequest(JSON.stringify({ ...o, eip7702Auth: {} }))).toThrow(COLD_USEROP_7702_REFUSAL);
    expect(() =>
      parseColdUserOpRequest(JSON.stringify({ ...o, userOp: { ...o.userOp, authorizationList: [] } })),
    ).toThrow(COLD_USEROP_7702_REFUSAL);
    expect(() => parseColdUserOpRequest(JSON.stringify({ ...o, type: 'shiba-wallet/cold-sign-request' }))).toThrow(
      COLD_USEROP_NOT_A_REQUEST,
    );
    expect(() => parseColdUserOpRequest(JSON.stringify({ ...o, version: 2 }))).toThrow(/version 2/);
    // A changed fee with the stale hash.
    expect(() =>
      parseColdUserOpRequest(JSON.stringify({ ...o, userOp: { ...o.userOp, maxFeePerGas: '9' + o.userOp.maxFeePerGas } })),
    ).toThrow(/inconsistent|priority fee/);
    expect(() =>
      parseColdUserOpRequest(JSON.stringify({ ...o, userOp: { ...o.userOp, maxPriorityFeePerGas: '1', maxFeePerGas: '0' } })),
    ).toThrow(/priority fee above/);
    // Lower-case (non EIP-55) owner.
    expect(() => parseColdUserOpRequest(JSON.stringify({ ...o, owner: o.owner.toLowerCase() }))).toThrow(/owner/);
    // Another owner: the deployment data no longer belongs to it.
    expect(() => parseColdUserOpRequest(JSON.stringify({ ...o, owner: STRANGER.address }))).toThrow(
      /not the Kernel v3.3 account of its owner/,
    );
    // Another index.
    expect(() => parseColdUserOpRequest(JSON.stringify({ ...o, accountIndex: '1' }))).toThrow(
      /not the Kernel v3.3 account of its owner/,
    );
    // A deploying operation without its index.
    expect(() => parseColdUserOpRequest(JSON.stringify({ ...o, accountIndex: null }))).toThrow(/account index/);
    // Call data that is not a Kernel execute call.
    expect(() => parseColdUserOpRequest(JSON.stringify({ ...o, userOp: { ...o.userOp, callData: '0xdeadbeef' } }))).toThrow(
      ColdUserOpRefusedError,
    );
    // A nonce outside its stated key.
    expect(() => parseColdUserOpRequest(JSON.stringify({ ...o, nonceKey: '1' }))).toThrow(/nonce key/);
    // A lifetime over a day.
    expect(() => parseColdUserOpRequest(JSON.stringify({ ...o, expiresAt: String(NOW + 86_401) }))).toThrow(/lifetime/);
  });

  it('submitColdUserOpRequest: expiry first, then the signature, then the client', async () => {
    const t = transports({ nonce: 5n, deployed: false, owner: OWNER.address });
    const c = client(t);
    const prepared = await c.prepareUserOperationForExternalSigner(OWNER.address, CALLS, FEES, {
      scheme: KERNEL_V3_3_ECDSA_ROOT_SCHEME,
    });
    const req = buildColdUserOpRequest(prepared, { summary: 's', accountIndex: 0n, nowSeconds: NOW });
    const sigText = buildColdUserOpSignature(req, OWNER.address, signDigest(OWNER, prepared.signingDigest));
    const before = t.calls.length;
    await expect(submitColdUserOpRequest(c, req, sigText, { nowSeconds: NOW + 1801 })).rejects.toThrow(COLD_USEROP_EXPIRED);
    await expect(submitColdUserOpRequest(c, req, '{}', { nowSeconds: NOW })).rejects.toThrow(COLD_USEROP_NOT_A_SIGNATURE);
    expect(t.calls.length).toBe(before);
    const sent = await submitColdUserOpRequest(c, req, sigText, { nowSeconds: NOW + 1800 });
    expect(sent.userOp.signature.length).toBe(65);
    expect(recoverExternalSigner(prepared.signingDigest, signDigest(OWNER, prepared.signingDigest))).toBe(OWNER.address);
    expect(t.sent.length).toBe(1);
  });
});

describe('decodeKernelExecuteCalls', () => {
  it('decodes single and batch calls exactly as encodeKernelExecute built them', () => {
    const single: Call[] = [{ to: RECIPIENT, value: 7n, data: toBytes('0xa9059cbb' + '00'.repeat(64)) }];
    const batch: Call[] = [
      { to: RECIPIENT, value: 0n, data: new Uint8Array(0) },
      { to: OWNER.address, value: 1n, data: toBytes('0x01020304') },
      { to: STRANGER.address, value: 10n ** 18n, data: toBytes('0x' + 'ff'.repeat(37)) },
    ];
    for (const calls of [single, batch]) {
      const decoded = decodeKernelExecuteCalls(encodeKernelExecute(calls));
      expect(decoded.map((c) => ({ ...c, data: toHex(c.data) }))).toEqual(
        calls.map((c) => ({ to: c.to, value: c.value, data: toHex(c.data) })),
      );
    }
  });

  it('refuses another function, a try-mode batch, trailing bytes and garbage', () => {
    const good = encodeKernelExecute(CALLS);
    expect(() => decodeKernelExecuteCalls(toBytes('0x12345678'))).toThrow(ColdUserOpRefusedError);
    const tryMode = good.slice();
    tryMode[4 + 1] = 0x01;
    expect(() => decodeKernelExecuteCalls(tryMode)).toThrow(/default execution type/);
    const trailing = new Uint8Array(good.length + 1);
    trailing.set(good);
    expect(() => decodeKernelExecuteCalls(trailing)).toThrow(/canonical/);
    const garbage = good.slice(0, 40);
    expect(() => decodeKernelExecuteCalls(garbage)).toThrow(ColdUserOpRefusedError);
  });
});
