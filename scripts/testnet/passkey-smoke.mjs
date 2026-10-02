/**
 * Passkey (WebAuthn / P-256) smoke test on Sepolia (phase 8, item 3): Kernel
 * v3.3 with ZeroDev's WebAuthnValidator v0.0.3 installed as an ADDITIONAL
 * validator next to the seed-owned ECDSA root validator, driven only by engine
 * code (packages/chains-evm/src/kernel-webauthn.ts). READ-ONLY: every step is
 * one eth_simulateV1 request against the real EntryPoint v0.7, Kernel v3.3,
 * WebAuthnValidator, P256VERIFY precompile (0x100) and Daimo P256Verifier on
 * Sepolia. Nothing is signed for broadcast and nothing is sent.
 *
 * The passkey is SYNTHETIC: a fresh random P-256 key held by this process
 * (noble), wrapped in an authenticator emulation that produces real-shaped
 * WebAuthn assertions (authenticatorData with UP|UV, clientDataJSON
 * {"type":"webauthn.get","challenge":…,"origin":…}, DER signature). The
 * engine checks and encodes each assertion exactly as it would a device's.
 *
 * Simulated blocks, in order:
 *   install          ROOT-signed op: execute(installModule(1, validator, …)) —
 *                    (dry run: the same op also deploys the account)
 *   passkeyPrecompile  passkey-signed op, usePrecompiled = true   -> accepted
 *   erc1271          eth_call isValidSignature with a passkey ERC-1271 sig -> 0x1626ba7e
 *   passkeyDaimo     passkey-signed op, usePrecompiled = false  -> accepted
 *   wrongChallenge   passkey signature over a different hash     -> rejected
 *   dummyReplay      a VALID old assertion re-labelled with responseTypeLocation
 *                    = uint256 max (the unpatched v0.0.1/v0.0.2 bypass) -> rejected
 *   selfCall         passkey op calling the account itself, encoded around the
 *                    engine's local guard -> accepted ON-CHAIN (documents that
 *                    the guard is client-side only)
 *   uninstall        ROOT-signed passkeyUninstallCalls                -> accepted
 *   afterUninstall   passkey-signed op                                -> rejected
 * Gas: UserOperationEvent.actualGasUsed for the two passkey paths is printed,
 * plus a direct eth_estimateGas of the precompile and the Daimo verifier.
 *
 * Modes:
 *   PASSKEY_SMOKE_DRY_RUN=1  PUBLIC BIP-39 test mnemonic, its undeployed Kernel
 *                            account (index 0), deployment in the install op.
 *   default                  the dev seed's DEPLOYED account index 2
 *                            (0x1D723b78e1D0D84Fd0531e2686285fb1B6414106),
 *                            root ops signed in-process by the dev seed
 *                            (.dev-wallet/mnemonic.txt, git-ignored) and only
 *                            simulated; a balance override covers simulated gas.
 *
 * Run from the repository root after `npm run build`:
 *   PASSKEY_SMOKE_DRY_RUN=1 node scripts/testnet/passkey-smoke.mjs
 *   node scripts/testnet/passkey-smoke.mjs
 */
import { readFileSync } from 'node:fs';
import { p256 } from '@noble/curves/nist.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { ChainRegistry, HdKeyring, evmKeyProvider } from '../../packages/core/dist/index.js';
import {
  ENTRYPOINT_V07,
  KERNEL_WEBAUTHN_VALIDATOR,
  WEBAUTHN_DUMMY_RESPONSE_TYPE_LOCATION,
  base64UrlEncode,
  checkWebAuthnAssertion,
  createKernelAccountSpec,
  detectP256Precompile,
  encodeFunctionCall,
  encodeKernelExecute,
  encodeWebAuthnSignature,
  encodeWebAuthnSignatureFromAssertion,
  getUserOpHash,
  hashEip191Message,
  httpTransport,
  kernelPasskeySpec,
  packInitCode,
  packPaymasterAndData,
  packUint128Pair,
  passkeyInstallCall,
  passkeyUninstallCalls,
  readPasskeyValidatorState,
  signErc1271WithPasskey,
  toBytes,
  toHex,
  verifyKernelDeployment,
  verifyWebAuthnValidatorDeployment,
  webAuthnAuthenticatorIdHash,
  webAuthnMessageHash,
  webAuthnNonceKey,
} from '../../packages/chains-evm/dist/index.js';
import { SEPOLIA_RPC } from './config.mjs';

const DRY_RUN = process.env.PASSKEY_SMOKE_DRY_RUN === '1';
const NODE_URL = process.env.NODE_URL ?? SEPOLIA_RPC;
const INDEX = BigInt(process.env.KERNEL_INDEX ?? (DRY_RUN ? '0' : '2'));
const EXPECTED_ACCOUNT = DRY_RUN ? '' : '0x1D723b78e1D0D84Fd0531e2686285fb1B6414106';
const PUBLIC_TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const CHAIN_ID = 11155111n;
const DEAD = '0x000000000000000000000000000000000000dEaD';
const ONE_ETH = '0xde0b6b3a7640000';

const node = httpTransport(NODE_URL);
const topic = (sig) => toHex(keccak_256(utf8ToBytes(sig)));
const USER_OPERATION_EVENT = topic('UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)');
const HANDLE_OPS_SIG =
  'handleOps((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes)[],address)';
const errorSelector = (sig) => topic(sig).slice(0, 10);
const KNOWN_ERRORS = Object.fromEntries(
  ['FailedOp(uint256,string)', 'FailedOpWithRevert(uint256,string,bytes)', 'InvalidValidator()', 'InvalidNonce()'].map((s) => [
    errorSelector(s),
    s,
  ]),
);

function describeRevert(data) {
  if (typeof data !== 'string' || data.length < 10) return `revert data ${data}`;
  const name = KNOWN_ERRORS[data.slice(0, 10).toLowerCase()];
  if (!name) return `revert ${data.slice(0, 10)}`;
  if (!name.startsWith('FailedOp')) return name;
  const body = data.slice(10);
  const word = (i) => body.slice(i * 64, i * 64 + 64);
  const strOffset = Number(BigInt('0x' + word(1))) / 32;
  const strLen = Number(BigInt('0x' + word(strOffset)));
  const reason = Buffer.from(body.slice((strOffset + 1) * 64, (strOffset + 1) * 64 + strLen * 2), 'hex').toString();
  return `${name.split('(')[0]}("${reason}")`;
}

function encodeHandleOps(op, beneficiary) {
  return encodeFunctionCall(HANDLE_OPS_SIG, [
    {
      kind: 'array',
      items: [
        {
          kind: 'tuple',
          items: [
            { kind: 'address', value: op.sender },
            { kind: 'uint256', value: op.nonce },
            { kind: 'bytes', value: packInitCode(op) },
            { kind: 'bytes', value: op.callData },
            { kind: 'fixedBytes', value: packUint128Pair(op.verificationGasLimit, op.callGasLimit) },
            { kind: 'uint256', value: op.preVerificationGas },
            { kind: 'fixedBytes', value: packUint128Pair(op.maxPriorityFeePerGas, op.maxFeePerGas) },
            { kind: 'bytes', value: packPaymasterAndData(op) },
            { kind: 'bytes', value: op.signature },
          ],
        },
      ],
    },
    { kind: 'address', value: beneficiary },
  ]);
}

/** UserOperationEvent for this hash: { success, actualGasUsed } or null. */
function userOpEvent(logs, userOpHash) {
  for (const log of logs ?? []) {
    if (log.topics?.[0]?.toLowerCase() !== USER_OPERATION_EVENT) continue;
    if (log.topics[1]?.toLowerCase() !== userOpHash.toLowerCase()) continue;
    const data = log.data.slice(2);
    return {
      success: BigInt('0x' + data.slice(64, 128)) === 1n,
      actualGasUsed: BigInt('0x' + data.slice(192, 256)),
    };
  }
  return null;
}

function loadOwner(mnemonic) {
  const registry = new ChainRegistry();
  registry.register(evmKeyProvider);
  return HdKeyring.fromMnemonic(mnemonic, registry).getAccount('eip155:1');
}

/** A synthetic platform authenticator (noble P-256): real-shaped assertions, UP|UV set. */
function syntheticAuthenticator() {
  const secret = p256.utils.randomSecretKey();
  const pub = p256.getPublicKey(secret, false);
  const publicKey = { x: BigInt(toHex(pub.slice(1, 33))), y: BigInt(toHex(pub.slice(33))) };
  const credentialId = p256.utils.randomSecretKey().slice(0, 16);
  const rpIdHash = keccak_256(utf8ToBytes('passkey-smoke.invalid')); // not checked on-chain
  const authenticatorData = new Uint8Array([...rpIdHash, 0x05, 0, 0, 0, 0]);
  return {
    publicKey,
    credentialId,
    async assert(challenge) {
      const clientDataJSON =
        `{"type":"webauthn.get","challenge":"${base64UrlEncode(challenge)}",` +
        '"origin":"https://passkey-smoke.invalid","crossOrigin":false}';
      const der = p256
        .Signature.fromBytes(p256.sign(webAuthnMessageHash(authenticatorData, clientDataJSON), secret, { prehash: false }))
        .toBytes('der');
      return { authenticatorData, clientDataJSON, signature: der };
    },
  };
}

async function main() {
  const chainId = BigInt(await node('eth_chainId', []));
  if (chainId !== CHAIN_ID) throw new Error(`Not Sepolia: chain id ${chainId}`);
  await verifyKernelDeployment(node);
  await verifyWebAuthnValidatorDeployment(node);
  const precompile = await detectP256Precompile(node);
  console.log(`WebAuthnValidator ${KERNEL_WEBAUTHN_VALIDATOR.address}: code hash verified; P256VERIFY precompile present: ${precompile}`);
  if (!precompile) console.log('  (no precompile: the precompile leg is expected to be rejected; the Daimo leg still runs)');

  const owner = DRY_RUN
    ? loadOwner(PUBLIC_TEST_MNEMONIC)
    : loadOwner(readFileSync(new URL('../../.dev-wallet/mnemonic.txt', import.meta.url), 'utf8').trim());
  const rootSpec = createKernelAccountSpec({ node, index: INDEX });
  const account = await rootSpec.getAddress(owner);
  if (EXPECTED_ACCOUNT && account.toLowerCase() !== EXPECTED_ACCOUNT.toLowerCase()) {
    throw new Error(`Account ${account} is not the expected ${EXPECTED_ACCOUNT}`);
  }
  const deployed = (await node('eth_getCode', [account, 'latest'])) !== '0x';
  console.log(`${DRY_RUN ? 'DRY RUN (public test mnemonic)' : 'DEV ACCOUNT (simulation only)'}: owner ${owner.address}, Kernel ${account}, deployed ${deployed}`);
  if (DRY_RUN && deployed) throw new Error('The dry run expects the public-mnemonic Kernel account to be undeployed');
  if (!DRY_RUN && !deployed) throw new Error('The dev account is expected to be deployed');
  if (deployed) {
    const state = await readPasskeyValidatorState(node, account);
    console.log(`Current passkey state: hook ${state.hook}, stored key ${state.publicKey ? 'present' : 'none'}`);
    if (state.publicKey) throw new Error('A passkey is already stored for this account; uninstall it first');
  }

  const passkey = syntheticAuthenticator();
  console.log(`Synthetic passkey public key x = 0x${passkey.publicKey.x.toString(16).padStart(64, '0').slice(0, 16)}…`);

  const rootNonce = deployed
    ? BigInt(
        await node('eth_call', [
          {
            to: ENTRYPOINT_V07,
            data: toHex(
              encodeFunctionCall('getNonce(address,uint192)', [
                { kind: 'address', value: account },
                { kind: 'uint256', value: 0n },
              ]),
            ),
          },
          'latest',
        ]),
      )
    : 0n;
  const passkeyKey = webAuthnNonceKey();
  const gas = {
    callGasLimit: 300_000n,
    verificationGasLimit: 1_200_000n,
    preVerificationGas: 100_000n,
    maxFeePerGas: 3_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  };
  const factory = deployed ? {} : await rootSpec.getFactoryArgs(owner);
  const hashOf = (op) => getUserOpHash(op, ENTRYPOINT_V07, CHAIN_ID);
  const rootSigned = (op) => ({ ...op, signature: rootSpec.signUserOpHash(owner, hashOf(op)) });
  const passkeySigned = async (op, usePrecompiled) => {
    const hash = hashOf(op);
    const assertion = await passkey.assert(hash);
    return {
      ...op,
      signature: encodeWebAuthnSignatureFromAssertion(assertion, hash, { usePrecompiled, publicKey: passkey.publicKey }),
    };
  };
  const spec = kernelPasskeySpec({
    account,
    publicKey: passkey.publicKey,
    usePrecompiled: precompile,
    chainId: CHAIN_ID,
    assert: (c) => passkey.assert(c),
  });
  const transfer = spec.encodeCalls([{ to: DEAD, value: 0n, data: new Uint8Array(0) }]);
  const ops = {};
  ops.install = rootSigned({
    sender: account,
    nonce: rootNonce,
    ...factory,
    callData: encodeKernelExecute([
      passkeyInstallCall(account, passkey.publicKey, webAuthnAuthenticatorIdHash(passkey.credentialId)),
    ]),
    ...gas,
  });
  ops.passkeyPrecompile = await passkeySigned({ sender: account, nonce: passkeyKey << 64n, callData: transfer, ...gas }, true);
  ops.passkeyDaimo = await passkeySigned({ sender: account, nonce: (passkeyKey << 64n) | 1n, callData: transfer, ...gas }, false);
  // Signature over some other hash, presented for the next passkey op.
  const nextBase = { sender: account, nonce: (passkeyKey << 64n) | 2n, callData: transfer, ...gas };
  const foreignHash = keccak_256(utf8ToBytes('some other operation'));
  const foreign = await passkey.assert(foreignHash);
  const foreignParts = checkWebAuthnAssertion(foreign, foreignHash, { publicKey: passkey.publicKey });
  ops.wrongChallenge = {
    ...nextBase,
    signature: encodeWebAuthnSignature({
      authenticatorData: foreign.authenticatorData,
      clientDataJSON: foreign.clientDataJSON,
      responseTypeLocation: foreignParts.responseTypeLocation,
      r: foreignParts.r,
      s: foreignParts.s,
      usePrecompiled: precompile,
    }),
  };
  ops.dummyReplay = {
    ...nextBase,
    signature: encodeWebAuthnSignature({
      authenticatorData: foreign.authenticatorData,
      clientDataJSON: foreign.clientDataJSON,
      responseTypeLocation: WEBAUTHN_DUMMY_RESPONSE_TYPE_LOCATION,
      r: foreignParts.r,
      s: foreignParts.s,
      usePrecompiled: precompile,
    }),
  };
  // Around the engine's guard (spec.encodeCalls refuses this): a self-call.
  const selfCall = encodeKernelExecute([
    {
      to: account,
      value: 0n,
      data: encodeFunctionCall('grantAccess(bytes21,bytes4,bool)', [
        { kind: 'fixedBytes', value: toBytes('0x01' + DEAD.slice(2)) },
        { kind: 'fixedBytes', value: toBytes('0xdeadbeef') },
        { kind: 'uint256', value: 0n },
      ]),
    },
  ]);
  ops.selfCall = await passkeySigned({ ...nextBase, callData: selfCall }, precompile);
  ops.uninstall = rootSigned({
    sender: account,
    nonce: rootNonce + 1n,
    callData: encodeKernelExecute(passkeyUninstallCalls(account)),
    ...gas,
  });
  ops.afterUninstall = await passkeySigned(
    { sender: account, nonce: (passkeyKey << 64n) | 3n, callData: transfer, ...gas },
    precompile,
  );

  // ERC-1271: a personal_sign-style hash signed by the passkey through Kernel's wrapper.
  const messageHash = hashEip191Message(utf8ToBytes('passkey smoke ERC-1271'));
  const erc1271Sig = await signErc1271WithPasskey(
    { assert: (c) => passkey.assert(c), publicKey: passkey.publicKey, usePrecompiled: precompile },
    messageHash,
    { chainId: CHAIN_ID, account },
  );
  const isValidSignatureCall = {
    from: owner.address,
    to: account,
    data: toHex(
      encodeFunctionCall('isValidSignature(bytes32,bytes)', [
        { kind: 'fixedBytes', value: messageHash },
        { kind: 'bytes', value: erc1271Sig },
      ]),
    ),
  };

  const from = owner.address;
  const callOf = (op) => ({ from, to: ENTRYPOINT_V07, data: toHex(encodeHandleOps(op, from)), gas: '0x1c9c380' });
  const order = [
    ['install', true],
    ['passkeyPrecompile', precompile],
    ['erc1271', true],
    ['passkeyDaimo', true],
    ['wrongChallenge', false],
    ['dummyReplay', false],
    ['selfCall', true],
    ['uninstall', true],
    ['afterUninstall', false],
  ];
  const result = await node('eth_simulateV1', [
    {
      blockStateCalls: order.map(([name], i) => ({
        ...(i === 0 ? { stateOverrides: { [account]: { balance: ONE_ETH }, [from]: { balance: ONE_ETH } } } : {}),
        calls: [name === 'erc1271' ? isValidSignatureCall : callOf(ops[name])],
      })),
    },
    'latest',
  ]);

  let failed = false;
  const gasUsed = {};
  order.forEach(([name, expected], i) => {
    const call = result[i].calls[0];
    let accepted;
    let detail;
    if (name === 'erc1271') {
      accepted = call.status === '0x1' && call.returnData?.slice(0, 10) === '0x1626ba7e';
      detail = `isValidSignature returned ${call.returnData?.slice(0, 10)} (${erc1271Sig.length} bytes)`;
    } else {
      const event = call.status === '0x1' ? userOpEvent(call.logs, toHex(hashOf(ops[name]))) : null;
      accepted = call.status === '0x1' && event?.success === true;
      if (event) gasUsed[name] = event.actualGasUsed;
      detail =
        call.status === '0x1'
          ? `UserOperationEvent success=${event?.success} actualGasUsed=${event?.actualGasUsed}; handleOps tx gas ${BigInt(call.gasUsed)}`
          : describeRevert(call.error?.data ?? call.returnData);
    }
    const ok = accepted === expected;
    if (!ok) failed = true;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${accepted ? 'accepted' : 'rejected'} (${detail})`);
  });

  // Direct cost of the two P-256 verification back ends (one 160-byte input).
  const probeSecret = p256.utils.randomSecretKey();
  const probeMsg = keccak_256(utf8ToBytes('gas probe'));
  const probeSig = p256.sign(probeMsg, probeSecret, { prehash: false });
  const probeInput = toHex(new Uint8Array([...probeMsg, ...probeSig, ...p256.getPublicKey(probeSecret, false).slice(1)]));
  for (const [label, to] of [
    ['P256VERIFY precompile 0x100', '0x0000000000000000000000000000000000000100'],
    ['Daimo P256Verifier', '0xc2b78104907F722DABAc4C69f826a522B2754De4'],
  ]) {
    const estimate = BigInt(await node('eth_estimateGas', [{ to, data: probeInput }]));
    console.log(`eth_estimateGas ${label}: ${estimate} (incl. 21,000 base + calldata)`);
  }
  if (gasUsed.passkeyPrecompile !== undefined && gasUsed.passkeyDaimo !== undefined) {
    console.log(
      `Passkey op actualGasUsed: precompile ${gasUsed.passkeyPrecompile}, Daimo ${gasUsed.passkeyDaimo} ` +
        `(difference ${gasUsed.passkeyDaimo - gasUsed.passkeyPrecompile})`,
    );
  }
  if (failed) throw new Error('Expectations not met');
  console.log('\nPASSKEY SMOKE PASSED (simulation only; nothing was broadcast).');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
