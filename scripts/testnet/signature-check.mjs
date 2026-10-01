/**
 * Smart-account signature live check (phase 7, item 3), READ-ONLY.
 *
 * Signs a test message for the counterfactual (undeployed) Kernel v3.3
 * account of the PUBLIC BIP-39 test mnemonic on Sepolia, wraps it per
 * ERC-6492, and validates it against the live chain:
 *   1. the engine's ERC-6492 flow (eth_simulateV1: factory call, then
 *      isValidSignature, in one simulated block);
 *   2. independently, the ERC's deployless "ValidateSigOffchain" route, using
 *      the universal validator creation bytecode shipped by the ox library
 *      (app/node_modules/ox, a WalletConnect dependency) — only if present;
 *   3. negative controls: a different message, a signature bound to another
 *      chain id, and a flipped signature byte must all be rejected;
 *   4. the Kernel root-mode envelope (0x00 || signature) as an alternative;
 *   5. observations: the ERC-7739 support probe against the simulated
 *      deployed Kernel, and isValidSignature on the deployed SimpleAccount
 *      from the phase-2 smoke test.
 * No real keys are used and nothing is broadcast: every chain interaction is
 * eth_chainId, eth_getCode, eth_call or eth_simulateV1.
 *
 * Run from the repository root after `npm run build`:
 *   node scripts/testnet/signature-check.mjs
 *   NODE_URL=<other Sepolia RPC> node scripts/testnet/signature-check.mjs
 */
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import {
  ChainRegistry,
  HdKeyring,
  evmKeyProvider,
} from '../../packages/core/dist/index.js';
import {
  ERC7739_SUPPORT_PROBE_HASH,
  KERNEL_V3_3,
  createKernelAccountSpec,
  encodeIsValidSignature,
  hashEip191Message,
  httpTransport,
  kernelErc1271Digest,
  signHashForSmartAccount,
  toBytes,
  toHex,
  unwrapErc6492Signature,
  verifyErc6492Signature,
  verifyWithDeploylessValidator,
  withEthereumV,
  wrapErc6492Signature,
} from '../../packages/chains-evm/dist/index.js';
import { SEPOLIA_RPC } from './config.mjs';

const NODE_URL = process.env.NODE_URL ?? SEPOLIA_RPC;
const PUBLIC_TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const EXPECTED_ACCOUNT = '0xB67b8b7cCA718EAC64d2b59ba568585A9FC69a42';
/** SimpleAccount deployed by the phase-2 ERC-4337 smoke test (AGENTS.md task 8). */
const DEPLOYED_SIMPLE_ACCOUNT = '0xB8370410CCFc0c8A6069a60ccFBeb6D2e2130fa2';
const SEPOLIA = 11155111n;
const ZERO = '0x0000000000000000000000000000000000000000';

let failures = 0;
function check(label, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures += 1;
}

const node = httpTransport(NODE_URL);
const chainId = BigInt(await node('eth_chainId', []));
check('node is Sepolia', chainId === SEPOLIA, `eth_chainId ${chainId}`);

const registry = new ChainRegistry();
registry.register(evmKeyProvider);
const owner = HdKeyring.fromMnemonic(PUBLIC_TEST_MNEMONIC, registry).getAccount('eip155:1');
const spec = createKernelAccountSpec({ node });
const account = await spec.getAddress(owner);
check('counterfactual Kernel address', account === EXPECTED_ACCOUNT, account);
const code = await node('eth_getCode', [account, 'latest']);
check('account is NOT deployed (ERC-6492 case)', code === '0x', `eth_getCode ${code.slice(0, 12)}`);

const message = utf8ToBytes('Shiba Wallet ERC-6492 live check');
const hash = hashEip191Message(message);
const signed = await signHashForSmartAccount(spec, owner, hash, { chainId: SEPOLIA, node });
check('signature is ERC-6492 wrapped', signed.erc6492 && !signed.deployed);
console.log(`      message hash ${toHex(hash)}`);
console.log(`      signature    ${signed.signature.length} bytes`);

// 1. Engine flow over eth_simulateV1.
const result = await verifyErc6492Signature(node, account, hash, signed.signature);
check('engine ERC-6492 flow accepts it', result.valid && result.path === 'erc6492-counterfactual', JSON.stringify(result));

// 2. Independent deployless validator (ox's compiled UniversalSigValidator helper).
const oxPath = fileURLToPath(
  new URL('../../app/node_modules/ox/_esm/erc6492/SignatureErc6492.js', import.meta.url),
);
if (existsSync(oxPath)) {
  const ox = await import(pathToFileURL(oxPath).href);
  const bytecode = toBytes(ox.universalSignatureValidatorBytecode);
  const deployless = await verifyWithDeploylessValidator(node, bytecode, account, hash, signed.signature);
  check('ox universal validator (deployless eth_call) agrees', deployless.valid, JSON.stringify(deployless));
  const deploylessBad = await verifyWithDeploylessValidator(
    node,
    bytecode,
    account,
    hashEip191Message(utf8ToBytes('a different message')),
    signed.signature,
  );
  check('ox universal validator rejects a different message', !deploylessBad.valid, JSON.stringify(deploylessBad));
} else {
  console.log('SKIP  ox not installed under app/node_modules; deployless cross-check not run');
}

// 3. Negative controls through the engine flow.
const other = await verifyErc6492Signature(
  node,
  account,
  hashEip191Message(utf8ToBytes('a different message')),
  signed.signature,
);
check('rejects the signature for a different message', !other.valid, JSON.stringify(other));

const parts = unwrapErc6492Signature(signed.signature);
const mainnetBound = wrapErc6492Signature({
  ...parts,
  signature: spec.signErc1271(owner, hash, { chainId: 1n, account }),
});
const crossChain = await verifyErc6492Signature(node, account, hash, mainnetBound);
check('rejects a signature bound to chain id 1', !crossChain.valid, JSON.stringify(crossChain));

const flipped = parts.signature.slice();
flipped[30] ^= 0x01;
const tampered = await verifyErc6492Signature(
  node,
  account,
  hash,
  wrapErc6492Signature({ ...parts, signature: flipped }),
);
check('rejects a flipped signature byte', !tampered.valid, JSON.stringify(tampered));

// 4. Root-mode envelope: 0x00 || owner signature over the same wrapped digest.
const ownerSig = withEthereumV(owner.sign(kernelErc1271Digest(hash, { chainId: SEPOLIA, account })));
const rootMode = wrapErc6492Signature({
  ...parts,
  signature: new Uint8Array([0x00, ...ownerSig]),
});
const root = await verifyErc6492Signature(node, account, hash, rootMode);
check('root-mode envelope (0x00 || sig) is accepted too', root.valid, JSON.stringify(root));

// 5a. ERC-7739 support probe against the simulated-deployed Kernel.
const probe = await node('eth_simulateV1', [
  {
    blockStateCalls: [
      {
        calls: [
          { from: ZERO, to: parts.factory, input: toHex(parts.factoryData) },
          {
            from: ZERO,
            to: account,
            input: toHex(encodeIsValidSignature(toBytes(ERC7739_SUPPORT_PROBE_HASH), new Uint8Array(0))),
          },
        ],
      },
    ],
  },
  'latest',
]);
const probeCall = probe[0].calls[1];
console.log(
  `INFO  Kernel v3.3 ERC-7739 probe isValidSignature(0x7739…, ""): status ${probeCall.status}, ` +
    `returnData ${probeCall.returnData}${probeCall.error ? `, error ${JSON.stringify(probeCall.error)}` : ''}`,
);
check(
  'Kernel v3.3 does not answer the ERC-7739 probe with 0x7739…',
  !(probeCall.status === '0x1' && probeCall.returnData.startsWith('0x7739')),
);

// 5b. SimpleAccount v0.7.0 sample: isValidSignature should not exist.
const simpleCode = await node('eth_getCode', [DEPLOYED_SIMPLE_ACCOUNT, 'latest']);
try {
  const answer = await node('eth_call', [
    { to: DEPLOYED_SIMPLE_ACCOUNT, data: toHex(encodeIsValidSignature(hash, new Uint8Array(65))) },
    'latest',
  ]);
  console.log(`INFO  SimpleAccount ${DEPLOYED_SIMPLE_ACCOUNT} isValidSignature returned ${answer}`);
} catch (error) {
  console.log(
    `INFO  SimpleAccount ${DEPLOYED_SIMPLE_ACCOUNT} (code ${simpleCode.length > 2 ? 'present' : 'absent'}) ` +
      `isValidSignature: ${error.message}`,
  );
}

console.log(`\nKernel v3.3 constants used: factory ${KERNEL_V3_3.factory}, meta factory ${KERNEL_V3_3.metaFactory}`);
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
