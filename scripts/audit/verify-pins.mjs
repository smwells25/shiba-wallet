#!/usr/bin/env node
/**
 * verify-pins.mjs — read-only verification of every contract address the
 * wallet pins (phase 23 item 1, the audit pack; docs/AUDIT_SCOPE.md
 * section 5).
 *
 * WHAT IT DOES
 *  1. Collects the pinned addresses by IMPORTING the code that pins them:
 *     the engine's built modules (packages/chains-evm/dist, so run
 *     `npm run build` first if the engine sources changed) and the app's
 *     TypeScript tables through Node's type stripping (as the check scripts
 *     under app/scripts do). Every pin carries the source file and line
 *     where the address is written. A few facts that the code documents only
 *     in comments (an implementation address, a byte length) are attached
 *     as "documented" facts, with their file and line, and are reported,
 *     never used to decide a pass.
 *  2. For each address on each network where the code uses it, reads
 *     eth_getCode (byte length and keccak-256), compares the keccak with a
 *     code hash the CODE pins (only hashes present in code; where the code
 *     pins none the table says "no pinned hash"), reads the fixed facts the
 *     source documents (entryPoint(), token(), eid(), localDomain(),
 *     symbol() and so on), reads the ERC-1967 implementation slot, and asks
 *     Sourcify's public API (GET sourcify.dev/server/v2/contract/{chain}/
 *     {address}) for the verification status. A failed read is reported as
 *     "could not read"; it is never a pass.
 *  3. Prints one table per network and a summary with counts, then a
 *     cross-network code comparison. Exit code 1 when any expected code is
 *     missing, a pinned code hash does not match, or a documented fixed fact
 *     reads differently; 2 on a usage error; 0 otherwise.
 *
 * READ-ONLY. Only eth_chainId, eth_blockNumber, eth_getCode, eth_call and
 * eth_getStorageAt are sent, to the keyless public endpoints the app itself
 * uses (app/src/config/evm-chain.ts defaultRpcUrls), plus two documented
 * keyless main-network endpoints for Circle's documented mainnet paymaster
 * (see EXTRA_NETWORKS). Nothing is signed or sent; no file under .dev-wallet
 * is read.
 *
 * USAGE
 *   node scripts/audit/verify-pins.mjs                 all networks, live
 *   node scripts/audit/verify-pins.mjs --network 1     one network (chain id
 *                                                      or a key: mainnet,
 *                                                      sepolia, base-sepolia,
 *                                                      arbitrum-sepolia,
 *                                                      op-sepolia, hoodi,
 *                                                      base, arbitrum-one)
 *   node scripts/audit/verify-pins.mjs --offline       list the pins only;
 *                                                      no network request
 *   --json <file>                                      also write every
 *                                                      result as JSON
 *   --no-sourcify                                      skip the Sourcify GETs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The app's package.json has no "type" field; Node re-parses its .ts files as
// ES modules and warns once per file. That warning says nothing about pins.
const originalEmitWarning = process.emitWarning;
process.emitWarning = function filteredWarning(warning, ...rest) {
  const text = String(warning && warning.message ? warning.message : warning);
  const code = typeof rest[0] === 'object' && rest[0] ? rest[0].code : rest[1];
  if (code === 'MODULE_TYPELESS_PACKAGE_JSON' || text.includes('Reparsing as ES module')) return;
  return originalEmitWarning.call(process, warning, ...rest);
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const opts = { network: null, offline: false, json: null, sourcify: true };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--offline') opts.offline = true;
  else if (a === '--no-sourcify') opts.sourcify = false;
  else if (a === '--network') opts.network = argv[++i] ?? null;
  else if (a === '--json') opts.json = argv[++i] ?? null;
  else if (a === '--help' || a === '-h') {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
    process.exit(0);
  } else {
    console.error(`Unknown argument: ${a}`);
    process.exit(2);
  }
}
if ((argv.includes('--network') && !opts.network) || (argv.includes('--json') && !opts.json)) {
  console.error('--network and --json each need a value.');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Imports of the pinning code
// ---------------------------------------------------------------------------

const evm = await imp('packages/chains-evm/dist/index.js');
const assetDiff = await imp('packages/chains-evm/dist/asset-diff.js');
const core = await imp('packages/core/dist/index.js');
const chainsApp = await imp('app/src/config/evm-chain.ts');
const tokensApp = await imp('app/src/wallet/tokens.ts');
const erc20App = await imp('app/src/wallet/erc20.ts');
const typedApp = await imp('app/src/wallet/typed-data-summary.ts');
const sendApp = await imp('app/src/wallet/send.ts');
const { keccak_256 } = await import('@noble/hashes/sha3.js');

const { encodeFunctionCall, toHex, toBytes } = evm;
const checksum = (a) => core.toChecksumAddress(toBytes(a));
const lower = (a) => String(a).toLowerCase();
const same = (a, b) => lower(a) === lower(b);

// ---------------------------------------------------------------------------
// Source citations: file:line of the first line holding the needle
// ---------------------------------------------------------------------------

const fileCache = new Map();
function cite(rel, needle) {
  if (!fileCache.has(rel)) fileCache.set(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n'));
  const lines = fileCache.get(rel);
  const n = lower(needle);
  // Prefer the line where the needle is a quoted string literal (the pin
  // itself) over a comment that mentions it.
  let idx = lines.findIndex((l) => lower(l).includes(`'${n}'`) && !/^\s*(\*|\/\/)/.test(l));
  if (idx < 0) idx = lines.findIndex((l) => lower(l).includes(n));
  if (idx < 0) throw new Error(`Collector bug: ${needle} is not written in ${rel}`);
  return `${rel}:${idx + 1}`;
}

// ---------------------------------------------------------------------------
// Networks
// ---------------------------------------------------------------------------

const P = {
  mainnet: chainsApp.EVM_MAINNET,
  sepolia: chainsApp.EVM_SEPOLIA,
  'base-sepolia': chainsApp.EVM_BASE_SEPOLIA,
  'arbitrum-sepolia': chainsApp.EVM_ARBITRUM_SEPOLIA,
  'op-sepolia': chainsApp.EVM_OP_SEPOLIA,
  hoodi: chainsApp.EVM_HOODI,
};
const NETWORKS = Object.entries(P).map(([key, p]) => ({
  key,
  chainId: Number(p.chainIdDecimal),
  label: p.label,
  rpcUrls: [...p.defaultRpcUrls],
  rpcSource: 'app/src/config/evm-chain.ts defaultRpcUrls',
  kernel: p.kernelV33Verified === true,
}));

/**
 * Main networks the app has no profile for, read ONLY for Circle's
 * documented mainnet paymaster (token-paymaster.ts mainnetAddress: "Documented
 * mainnet address on Arbitrum and Base"). Each endpoint is cited.
 */
const EXTRA_NETWORKS = [
  {
    key: 'base',
    chainId: 8453,
    label: 'Base (mainnet)',
    rpcUrls: ['https://mainnet.base.org'],
    rpcSource: `docs.base.org quoted at ${cite('app/src/config/evm-chain.ts', '| RPC endpoint | `https://mainnet.base.org`')}`,
    kernel: false,
  },
  {
    key: 'arbitrum-one',
    chainId: 42161,
    label: 'Arbitrum One (mainnet)',
    rpcUrls: ['https://arb1.arbitrum.io/rpc'],
    rpcSource: 'docs.arbitrum.io/for-devs/dev-tools-and-resources/chain-info, "Arbitrum One" row (fetched 2026-10-25)',
    kernel: false,
  },
];
const ALL_NETWORKS = [...NETWORKS, ...EXTRA_NETWORKS];
const byChain = (id) => ALL_NETWORKS.find((n) => n.chainId === id);
const KERNEL_CHAINS = NETWORKS.filter((n) => n.kernel).map((n) => n.chainId); // 1, 11155111, 84532, 421614, 11155420
const TEST_KERNEL_CHAINS = KERNEL_CHAINS.filter((c) => c !== 1);

// ---------------------------------------------------------------------------
// The collector
// ---------------------------------------------------------------------------

/**
 * A pin: one address on a set of networks.
 *  expect: 'code' (a contract must be there), 'no-code' (the source states
 *    the address holds no contract code), 'eoa-or-delegated' (an account
 *    the source names as an externally owned account; EIP-7702 delegation
 *    is reported, not failed), 'optional' (a refusal-list entry: absent code
 *    is not a failure).
 *  hashes: { chainId: keccak } pinned in CODE (hashSource cites it).
 *  checks: fact checks, each (ctx) => Promise<{ name, ok: true|false|null, detail }>.
 *  documented: facts written only in comments, reported for comparison.
 */
const pins = [];
function pin(p) {
  pins.push({ expect: 'code', hashes: {}, checks: [], documented: [], ...p, address: checksum(p.address) });
}

const KERNEL_FILE = 'packages/chains-evm/src/kernel-account.ts';
const PERM_FILE = 'packages/chains-evm/src/kernel-permissions.ts';
const RECOVERY_FILE = 'packages/chains-evm/src/kernel-recovery.ts';
const WEBAUTHN_FILE = 'packages/chains-evm/src/kernel-webauthn.ts';
const SPEND_FILE = 'packages/chains-evm/src/kernel-spending.ts';
const CIRCLE_FILE = 'packages/chains-evm/src/token-paymaster.ts';
const PIMLICO_FILE = 'packages/chains-evm/src/erc7677-token-paymaster.ts';
const DCA_FILE = 'packages/chains-evm/src/kernel-dca.ts';
const STAKING_FILE = 'packages/chains-evm/src/staking.ts';
const LZ_FILE = 'packages/chains-evm/src/bridge/layerzero-oft.ts';
const CCTP_FILE = 'packages/chains-evm/src/bridge/cctp-v2.ts';
const ENS_FILE = 'packages/chains-evm/src/ens.ts';
const ENS_REG_FILE = 'packages/chains-evm/src/ens-register.ts';
const ENS_SMOKE_FILE = 'scripts/testnet/ens-register-smoke.mjs';
const ASSET_FILE = 'packages/chains-evm/src/asset-diff.ts';
const ACTIVITY_FILE = 'packages/chains-evm/src/activity-decode.ts';
const USEROP_FILE = 'packages/chains-evm/src/userop.ts';
const CHAIN_FILE = 'app/src/config/evm-chain.ts';
const TOKENS_FILE = 'app/src/wallet/tokens.ts';

// --- ERC-4337 EntryPoint v0.7 ----------------------------------------------
pin({
  group: 'ERC-4337 / Kernel v3.3',
  label: 'EntryPoint v0.7',
  address: evm.ENTRYPOINT_V07,
  chains: KERNEL_CHAINS,
  source: cite(USEROP_FILE, evm.ENTRYPOINT_V07),
});

// --- Kernel v3.3 core (KERNEL_V3_3; also the EIP-7702 delegate) ------------
const K = evm.KERNEL_V3_3;
const MS = chainsApp.MULTISIG_VERIFIED_NETWORKS;
const msHashes = (field) =>
  Object.fromEntries(Object.entries(MS).map(([caip2, f]) => [Number(caip2.split(':')[1]), f[field]]));
const msHashSource = () => cite(CHAIN_FILE, 'export const MULTISIG_VERIFIED_NETWORKS');

pin({
  group: 'ERC-4337 / Kernel v3.3',
  label: 'Kernel meta factory (FactoryStaker)',
  address: K.metaFactory,
  chains: KERNEL_CHAINS,
  source: cite(KERNEL_FILE, K.metaFactory),
  hashes: msHashes('metaFactoryCodeHash'),
  hashSource: msHashSource('metaFactoryCodeHash'),
  checks: [
    async (c) => entryPointStake(c, K.metaFactory, 'meta factory'),
    async (c) => boolCheck(c, K.metaFactory, 'approved(address)', [addrArg(K.factory)], true, 'approved(factory)'),
  ],
  documented: [{ fact: '1,871 bytes on the four test networks', source: cite(CHAIN_FILE, '(1,871 bytes)'), length: 1871 }],
});
pin({
  group: 'ERC-4337 / Kernel v3.3',
  label: 'KernelFactory',
  address: K.factory,
  chains: KERNEL_CHAINS,
  source: cite(KERNEL_FILE, K.factory),
  hashes: msHashes('factoryCodeHash'),
  hashSource: msHashSource('factoryCodeHash'),
  checks: [
    async (c) => addressCheck(c, K.factory, 'implementation()', [], K.implementation, 'implementation()'),
    async (c) => engineCheck(c, 'verifyKernelDeployment', async () => {
      await evm.verifyKernelDeployment(c.node);
      return 'all six checks passed';
    }),
  ],
  documented: [{ fact: '950 bytes on the four test networks', source: cite(CHAIN_FILE, '(950 bytes)'), length: 950 }],
});
pin({
  group: 'ERC-4337 / Kernel v3.3',
  label: 'Kernel v3.3 implementation (also the EIP-7702 delegate)',
  address: K.implementation,
  chains: KERNEL_CHAINS,
  source: `${cite(KERNEL_FILE, K.implementation)}; delegate ${cite(KERNEL_FILE, 'KERNEL_V3_3_7702_DELEGATE =')}`,
  hashes: msHashes('implementationCodeHash'),
  hashSource: msHashSource('implementationCodeHash'),
  checks: [
    async (c) => addressCheck(c, K.implementation, 'entrypoint()', [], evm.ENTRYPOINT_V07, 'entrypoint()'),
    async (c) => stringCheck(c, K.implementation, 'accountId()', K.accountId, 'accountId()'),
    async (c) => eip712DomainCheck(c, K.implementation, 'Kernel', K.version),
  ],
  documented: [{ fact: '24,469 bytes on the four test networks', source: cite(CHAIN_FILE, '(24,469 bytes)'), length: 24469 }],
});
pin({
  group: 'ERC-4337 / Kernel v3.3',
  label: 'Kernel ECDSA validator',
  address: K.ecdsaValidator,
  chains: KERNEL_CHAINS,
  source: cite(KERNEL_FILE, K.ecdsaValidator),
  checks: [async (c) => boolCheck(c, K.ecdsaValidator, 'isModuleType(uint256)', [uintArg(1n)], true, 'isModuleType(1)')],
});

// --- Permission modules ------------------------------------------------------
for (const [name, address] of Object.entries(evm.KERNEL_PERMISSION_MODULES)) {
  pin({
    group: 'Kernel permission modules',
    label: `Permission module: ${name}`,
    address,
    // kernel-permissions.ts: "identical addresses and runtime code on Ethereum
    // mainnet and Sepolia"; the app offers session keys on every test network
    // with the Kernel stack (readiness: test networks only).
    chains: KERNEL_CHAINS,
    source: cite(PERM_FILE, address),
  });
}

// --- Recovery modules and the multisig root ----------------------------------
const R = evm.KERNEL_RECOVERY_MODULES;
pin({
  group: 'Kernel recovery / multisig',
  label: 'WeightedECDSAValidator (guardians, heirs, multisig root)',
  address: R.weightedEcdsaValidator,
  chains: KERNEL_CHAINS,
  source: `${cite(RECOVERY_FILE, R.weightedEcdsaValidator)}; multisig ${cite('packages/chains-evm/src/kernel-multisig.ts', 'KERNEL_MULTISIG_VALIDATOR')}`,
  hashes: msHashes('weightedValidatorCodeHash'),
  hashSource: msHashSource('weightedValidatorCodeHash'),
  checks: [
    async (c) => boolCheck(c, R.weightedEcdsaValidator, 'isModuleType(uint256)', [uintArg(1n)], true, 'isModuleType(1)'),
    async (c) => eip712DomainCheck(c, R.weightedEcdsaValidator, evm.WEIGHTED_ECDSA_VALIDATOR_NAME, evm.WEIGHTED_ECDSA_VALIDATOR_VERSION),
  ],
  documented: [{ fact: '9,678 bytes on the four test networks', source: cite(CHAIN_FILE, '(9,678 bytes)'), length: 9678 }],
});
pin({
  group: 'Kernel recovery / multisig',
  label: 'RecoveryAction',
  address: R.recoveryAction,
  chains: KERNEL_CHAINS,
  source: cite(RECOVERY_FILE, R.recoveryAction),
  documented: [{ fact: '513 bytes, identical on mainnet and Sepolia (keccak 0xfcfe9c1a…cf89, truncated in the comment)', source: cite(RECOVERY_FILE, '0xfcfe9c1a'), length: 513, keccakPrefix: '0xfcfe9c1a', keccakSuffix: 'cf89' }],
});

// --- Passkeys ------------------------------------------------------------------
const W = evm.KERNEL_WEBAUTHN_VALIDATOR;
pin({
  group: 'Passkeys',
  label: 'WebAuthnValidator v0.0.3',
  address: W.address,
  chains: KERNEL_CHAINS,
  source: cite(WEBAUTHN_FILE, W.address),
  // verifyWebAuthnValidatorDeployment compares this hash on EVERY network it
  // runs on, so the pin applies wherever passkeys are offered.
  hashes: Object.fromEntries(KERNEL_CHAINS.map((c) => [c, W.runtimeCodeHash])),
  hashSource: cite(WEBAUTHN_FILE, W.runtimeCodeHash),
  checks: [
    async (c) => engineCheck(c, 'verifyWebAuthnValidatorDeployment', async () => {
      await evm.verifyWebAuthnValidatorDeployment(c.node);
      return 'code hash and isModuleType(1) passed';
    }),
  ],
});
pin({
  group: 'Passkeys',
  label: "Daimo P256Verifier (used when no P-256 precompile)",
  address: evm.DAIMO_P256_VERIFIER,
  chains: KERNEL_CHAINS,
  source: cite(WEBAUTHN_FILE, evm.DAIMO_P256_VERIFIER),
});

// --- SpendingLimit hook (pinned for the finding, never installed) ------------
const H = evm.ZERODEV_SPENDING_LIMIT_HOOK;
pin({
  group: 'Spending-limit hook (read for a finding, not installed)',
  label: 'ZeroDev SpendingLimit hook',
  address: H.address,
  // kernel-spending.ts: "same address and code on Ethereum mainnet and Sepolia".
  chains: [1, 11155111],
  source: cite(SPEND_FILE, H.address),
  hashes: { 1: H.runtimeCodeKeccak, 11155111: H.runtimeCodeKeccak },
  hashSource: cite(SPEND_FILE, H.runtimeCodeKeccak),
  documented: [{ fact: `runtimeCodeLength ${H.runtimeCodeLength} (a code constant)`, source: cite(SPEND_FILE, 'runtimeCodeLength:'), length: H.runtimeCodeLength }],
});
pin({
  group: 'Spending-limit hook (read for a finding, not installed)',
  label: 'ZeroDev SpendingLimit hook (legacy deployment)',
  address: evm.ZERODEV_SPENDING_LIMIT_HOOK_LEGACY,
  chains: [1, 11155111],
  expect: 'optional',
  source: cite(SPEND_FILE, evm.ZERODEV_SPENDING_LIMIT_HOOK_LEGACY),
  note: 'The source names no network for the legacy hook; read on mainnet and Sepolia, absence not a failure.',
});

// --- SimpleAccount pre-fill (Sepolia) ----------------------------------------
const SA = chainsApp.EVM_SEPOLIA.aaPrefill;
pin({
  group: 'SimpleAccount pre-fill',
  label: 'SimpleAccountFactory v0.7',
  address: SA.factory,
  chains: [11155111],
  source: cite(CHAIN_FILE, SA.factory),
  checks: [async (c) => addressCheck(c, SA.factory, 'accountImplementation()', [], SA.implementation, 'accountImplementation()')],
});
pin({
  group: 'SimpleAccount pre-fill',
  label: 'SimpleAccount implementation',
  address: SA.implementation,
  chains: [11155111],
  source: cite(CHAIN_FILE, SA.implementation),
  checks: [async (c) => addressCheck(c, SA.implementation, 'entryPoint()', [], SA.entryPoint, 'entryPoint()')],
});

// --- Paymasters --------------------------------------------------------------
const C = evm.CIRCLE_TOKEN_PAYMASTER_V07;
const circleImplDoc = {
  84532: { address: '0x1E42055dECF050828AfE8bA0A374bC5F44CbFC8d', source: cite('packages/chains-evm/src/token-paymaster.ts', '0x1E42055dECF050828AfE8bA0A374bC5F44CbFC8d') },
  421614: { address: '0xD9d18FD662B5B2F567545C13fd1e902008beD755', source: cite('packages/chains-evm/src/token-paymaster.ts', '0xD9d18FD662B5B2F567545C13fd1e902008beD755') },
};
// Both implementation addresses are written only in comments of the engine
// file (cite() throws if they are not); they are compared, and a difference is
// reported as a failed fact because the comment states the deployment.
pin({
  group: 'Paymasters',
  label: "Circle token paymaster v0.7 (proxy)",
  address: C.testnetAddress,
  chains: Object.keys(C.tokens).map(Number),
  source: cite(CIRCLE_FILE, C.testnetAddress),
  checks: [
    async (c) => engineCheck(c, 'readCirclePaymasterState + circlePaymasterProblems', async () => {
      const s = await evm.readCirclePaymasterState(c.node, C.testnetAddress);
      const problems = evm.circlePaymasterProblems(s, { token: C.tokens[String(c.chainId)] });
      if (problems.length) throw new Error(problems.join(' '));
      const doc = circleImplDoc[c.chainId];
      const implNote = doc ? (same(doc.address, s.implementation) ? ` implementation ${s.implementation} = documented (${doc.source})` : ` implementation ${s.implementation} DIFFERS from documented ${doc.address} (${doc.source})`) : '';
      if (doc && !same(doc.address, s.implementation)) throw new Error(implNote.trim());
      return `entryPoint v0.7, token ${s.token}, not paused, staked ${fmtEth(s.stake)} / ${s.unstakeDelaySec} s, deposit ${fmtEth(s.deposit)}, feeSpread ${s.feeSpreadBips} bips, price ${s.nativeTokenPrice}, owner ${s.owner};${implNote}`;
    }),
  ],
});
pin({
  group: 'Paymasters',
  label: "Circle token paymaster, documented mainnet address (NOT verified by the project)",
  address: C.mainnetAddress,
  chains: [8453, 42161],
  source: cite(CIRCLE_FILE, C.mainnetAddress),
  checks: [
    async (c) => {
      // Read-only facts only; the expected token on Base / Arbitrum mainnet is
      // not pinned anywhere in code, so it is reported, not judged.
      try {
        const s = await evm.readCirclePaymasterState(c.node, C.mainnetAddress);
        return {
          name: 'readCirclePaymasterState (report only)',
          ok: same(s.entryPoint, evm.ENTRYPOINT_V07) ? true : false,
          detail: `entryPoint ${s.entryPoint}, token ${s.token}, paused ${s.paused}, staked ${s.staked} ${fmtEth(s.stake)} / ${s.unstakeDelaySec} s, deposit ${fmtEth(s.deposit)}, feeSpread ${s.feeSpreadBips} bips, additionalGasCharge ${s.additionalGasCharge}, implementation ${s.implementation}, owner ${s.owner}, oracle ${s.oracle}`,
        };
      } catch (e) {
        return { name: 'readCirclePaymasterState (report only)', ok: null, detail: `could not read: ${short(e)}` };
      }
    },
  ],
});
const PM = evm.PIMLICO_ERC20_PAYMASTER_V07;
pin({
  group: 'Paymasters',
  label: 'Pimlico ERC-20 paymaster singleton v0.7',
  address: PM.address,
  // Used on Ethereum Sepolia (tokens table); the code hash comment names
  // Ethereum Sepolia, Base Sepolia and Arbitrum Sepolia; docs/AUDIT_SCOPE.md
  // 5.2 and docs/MAINNET_READINESS.md section 2 call it source-verified on
  // Ethereum mainnet, so mainnet is read too.
  chains: [11155111, 84532, 421614, 1],
  source: cite(PIMLICO_FILE, PM.address),
  // pimlicoPaymasterProblems compares this hash on any network it runs on.
  hashes: { 11155111: PM.runtimeCodeKeccak, 84532: PM.runtimeCodeKeccak, 421614: PM.runtimeCodeKeccak, 1: PM.runtimeCodeKeccak },
  hashSource: cite(PIMLICO_FILE, PM.runtimeCodeKeccak),
  checks: [
    async (c) => engineCheck(c, 'readPimlicoPaymasterState', async () => {
      const s = await evm.readPimlicoPaymasterState(c.node);
      if (!same(s.entryPoint, evm.ENTRYPOINT_V07)) throw new Error(`entryPoint() is ${s.entryPoint}`);
      return `entryPoint v0.7, deposit ${fmtEth(s.deposit)}, staked ${s.staked}${s.staked ? ` (${fmtEth(s.stake)} / ${s.unstakeDelaySec} s)` : ''}`;
    }),
  ],
});

// --- Uniswap v3 (DCA), Ethereum Sepolia --------------------------------------
const U = evm.UNISWAP_V3_SEPOLIA;
pin({ group: 'Uniswap v3 (DCA)', label: 'UniswapV3Factory', address: U.factory, chains: [11155111], source: cite(DCA_FILE, U.factory) });
pin({
  group: 'Uniswap v3 (DCA)',
  label: 'SwapRouter02',
  address: U.swapRouter02,
  chains: [11155111],
  source: cite(DCA_FILE, U.swapRouter02),
  checks: [
    async (c) => addressCheck(c, U.swapRouter02, 'factory()', [], U.factory, 'factory()'),
    async (c) => addressCheck(c, U.swapRouter02, 'WETH9()', [], U.weth9, 'WETH9()'),
  ],
});
pin({
  group: 'Uniswap v3 (DCA)',
  label: 'QuoterV2',
  address: U.quoterV2,
  chains: [11155111],
  source: cite(DCA_FILE, U.quoterV2),
  checks: [async (c) => addressCheck(c, U.quoterV2, 'factory()', [], U.factory, 'factory()')],
});
for (const p of evm.DCA_PINNED_POOLS) {
  pin({
    group: 'Uniswap v3 (DCA)',
    label: `Pool ${p.label}`,
    address: p.pool,
    chains: [Number(p.chainId)],
    source: cite(DCA_FILE, p.pool),
    checks: [
      async (c) => addressCheck(c, U.factory, 'getPool(address,address,uint24)', [addrArg(p.token0), addrArg(p.token1), uintArg(BigInt(p.fee))], p.pool, 'factory.getPool(token0, token1, fee)'),
      async (c) => addressCheck(c, p.pool, 'factory()', [], U.factory, 'pool.factory()'),
      async (c) => addressCheck(c, p.pool, 'token0()', [], p.token0, 'token0()'),
      async (c) => addressCheck(c, p.pool, 'token1()', [], p.token1, 'token1()'),
      async (c) => uintCheck(c, p.pool, 'fee()', BigInt(p.fee), 'fee()'),
      async (c) => reportUint(c, p.pool, 'liquidity()', 'liquidity() (report only)'),
    ],
  });
}
const refusedChains = {
  // kernel-dca.ts comments: v1 "Ethereum mainnet and most networks; not
  // deployed on Sepolia per the docs"; the two Universal Routers by name.
  '0xE592427A0AEce92De3Edee1F18E0157C05861564': [1],
  '0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b': [11155111],
  '0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af': [1],
};
for (const r of evm.DCA_REFUSED_ROUTERS) {
  pin({
    group: 'Uniswap v3 (DCA)',
    label: `Refused by name: ${r.name} (${r.reason})`,
    address: r.address,
    chains: refusedChains[r.address] ?? [11155111],
    expect: 'optional',
    source: cite(DCA_FILE, r.address),
  });
}

// --- Activity labels pinned by literal address (activity-decode.ts KNOWN) ----
// The Kernel / EntryPoint / USDC / EURC / Permit2 entries reuse addresses
// collected above; the Uniswap ones below appear only here. Each is checked
// against the engine's own knownContract() so the parse cannot drift.
{
  const text = fs.readFileSync(path.join(ROOT, ACTIVITY_FILE), 'utf8');
  const re = /entries\(\[([0-9n,\s]+)\],\s*'(0x[0-9a-fA-F]{40})',\s*\{\s*name:\s*'([^']+)'/g;
  for (const m of text.matchAll(re)) {
    const chains = m[1].split(',').map((s) => Number(s.trim().replace(/n$/, ''))).filter(Boolean);
    const address = m[2];
    const name = m[3];
    for (const ch of chains) {
      const known = evm.knownContract(BigInt(ch), address);
      if (!known || known.name !== name) throw new Error(`Collector bug: knownContract(${ch}, ${address}) is not "${name}"`);
    }
    if (!/Uniswap/.test(name)) continue; // the others are collected from their own tables
    pin({ group: 'Activity labels', label: `Activity label: ${name}`, address, chains, source: cite(ACTIVITY_FILE, address) });
  }
}

// --- Staking -------------------------------------------------------------------
for (const d of Object.values(evm.LIDO_DEPLOYMENTS)) {
  const ch = Number(d.chain.split(':')[1]);
  pin({
    group: 'Staking',
    label: `Lido stETH (${d.status})`,
    address: d.stETH,
    chains: [ch],
    source: cite(STAKING_FILE, d.stETH),
    checks: [
      async (c) => engineCheck(c, 'verifyLidoDeployment', async () => {
        const problems = await evm.verifyLidoDeployment(c.node, d);
        if (problems.length) throw new Error(problems.join(' '));
        return 'symbols stETH / wstETH / unstETH, wstETH.stETH() and the locator\'s withdrawalQueue() match';
      }),
    ],
  });
  pin({ group: 'Staking', label: 'Lido wstETH', address: d.wstETH, chains: [ch], source: cite(STAKING_FILE, d.wstETH) });
  pin({ group: 'Staking', label: 'Lido withdrawal queue (unstETH)', address: d.withdrawalQueue, chains: [ch], source: cite(STAKING_FILE, d.withdrawalQueue) });
}
for (const d of Object.values(evm.ROCKET_POOL_DEPLOYMENTS)) {
  const ch = Number(d.chain.split(':')[1]);
  pin({
    group: 'Staking',
    label: 'Rocket Pool RocketStorage',
    address: d.storage,
    chains: [ch],
    source: cite(STAKING_FILE, d.storage),
    checks: [
      async (c) => engineCheck(c, 'resolveRocketPool', async () => {
        const r = await evm.resolveRocketPool(c.node, d);
        const last = '0x425E6f83e27f1676AD78BC39dA79C2C7b33d3Fd8';
        return `rocketTokenRETH = pinned rETH; deposit pool now ${r.depositPool}${same(r.depositPool, last) ? ' (= the last recorded, docs/AUDIT_SCOPE.md 5.5)' : ` (last recorded ${last})`}; settings ${r.settingsDeposit}`;
      }),
    ],
  });
  pin({ group: 'Staking', label: 'Rocket Pool rETH', address: d.rETH, chains: [ch], source: cite(STAKING_FILE, d.rETH) });
}

// --- LayerZero / Stargate ------------------------------------------------------
const LZ = evm.LAYERZERO_V2_TESTNET;
const lzChains = Object.keys(LZ).map(Number);
for (const ch of lzChains) {
  const e = LZ[ch];
  const others = lzChains.filter((o) => o !== ch);
  pin({
    group: 'LayerZero V2',
    label: `EndpointV2 (eid ${e.eid})`,
    address: e.endpoint,
    chains: [ch],
    source: cite(LZ_FILE, e.endpoint),
    checks: [
      async (c) => uintCheck(c, e.endpoint, 'eid()', BigInt(e.eid), 'eid()'),
      ...others.map((o) => async (c) => addressCheck(c, e.endpoint, 'defaultSendLibrary(uint32)', [uintArg(BigInt(LZ[o].eid))], e.sendUln302, `defaultSendLibrary(${LZ[o].eid})`)),
      ...others.map((o) => async (c) => addressCheck(c, e.endpoint, 'defaultReceiveLibrary(uint32)', [uintArg(BigInt(LZ[o].eid))], e.receiveUln302, `defaultReceiveLibrary(${LZ[o].eid})`)),
    ],
  });
  pin({ group: 'LayerZero V2', label: 'SendUln302', address: e.sendUln302, chains: [ch], source: cite(LZ_FILE, e.sendUln302) });
  pin({ group: 'LayerZero V2', label: 'ReceiveUln302', address: e.receiveUln302, chains: [ch], source: cite(LZ_FILE, e.receiveUln302) });
  pin({ group: 'LayerZero V2', label: 'Executor (LayerZero Labs)', address: e.executor, chains: [ch], source: cite(LZ_FILE, e.executor) });
  pin({ group: 'LayerZero V2', label: 'DVN (LayerZero Labs)', address: e.labsDvn, chains: [ch], source: cite(LZ_FILE, e.labsDvn) });
}
const STARGATE_OWNER = '0x5e6e4f234c7Ad525700fcF5B7862589950589ed5';
const STARGATE_PLANNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
for (const d of evm.STARGATE_V2_TESTNET_NATIVE_POOLS) {
  pin({
    group: 'Stargate V2',
    label: 'Stargate native ETH pool',
    address: d.address,
    chains: [d.chainId],
    source: cite(LZ_FILE, d.address),
    checks: [
      async (c) => addressCheck(c, d.address, 'token()', [], '0x0000000000000000000000000000000000000000', 'token() (native = 0)'),
      async (c) => uintCheck(c, d.address, 'sharedDecimals()', BigInt(d.sharedDecimals), 'sharedDecimals()'),
      async (c) => addressCheck(c, d.address, 'owner()', [], STARGATE_OWNER, 'owner()'),
    ],
  });
  pin({ group: 'Stargate V2', label: 'Stargate TokenMessaging (messaging OApp)', address: d.messagingOApp, chains: [d.chainId], source: cite(LZ_FILE, d.messagingOApp),
    checks: [async (c) => addressCheck(c, d.messagingOApp, 'endpoint()', [], LZ[d.chainId].endpoint, 'endpoint()')] });
}
const stargateChains = evm.STARGATE_V2_TESTNET_NATIVE_POOLS.map((d) => d.chainId);
pin({ group: 'Stargate V2', label: 'Stargate pool owner (stated: no contract code)', address: STARGATE_OWNER, chains: stargateChains, expect: 'no-code', source: cite(LZ_FILE, STARGATE_OWNER) });
pin({ group: 'Stargate V2', label: "Stargate pool planner (Hardhat account #0; stated EOA)", address: STARGATE_PLANNER, chains: stargateChains, expect: 'eoa-or-delegated', source: cite(LZ_FILE, STARGATE_PLANNER) });

// --- Circle CCTP V2 ------------------------------------------------------------
const CC = evm.CCTP_V2_TESTNET;
// CCTP_V2_TESTNET_DOMAINS is written as a literal in cctp-v2.ts; each entry is
// cited so a drift between this copy and the engine fails the collector.
const cctpDomains = { 11155111: 0, 11155420: 2, 421614: 3, 84532: 6 };
for (const [id, dom] of Object.entries(cctpDomains)) {
  cite(CCTP_FILE, `${id}: ${dom},`);
  if (!(id in evm.CCTP_V2_TESTNET_USDC)) throw new Error(`Collector bug: CCTP chain ${id} has no USDC entry`);
}
const cctpChains = Object.keys(evm.CCTP_V2_TESTNET_USDC).map(Number);
if (cctpChains.length !== Object.keys(cctpDomains).length) throw new Error('Collector bug: CCTP domain table changed');
pin({ group: 'Circle CCTP V2', label: 'TokenMessengerV2', address: CC.tokenMessengerV2, chains: cctpChains, source: cite(CCTP_FILE, CC.tokenMessengerV2) });
pin({
  group: 'Circle CCTP V2',
  label: 'MessageTransmitterV2',
  address: CC.messageTransmitterV2,
  chains: cctpChains,
  source: cite(CCTP_FILE, CC.messageTransmitterV2),
  checks: [async (c) => uintCheck(c, CC.messageTransmitterV2, 'localDomain()', BigInt(cctpDomains[c.chainId]), 'localDomain()')],
});
pin({
  group: 'Circle CCTP V2',
  label: 'TokenMinterV2',
  address: CC.tokenMinterV2,
  chains: cctpChains,
  source: cite(CCTP_FILE, CC.tokenMinterV2),
  checks: [async (c) => boolCheck(c, evm.CCTP_V2_TESTNET_USDC[c.chainId], 'isMinter(address)', [addrArg(CC.tokenMinterV2)], true, 'USDC.isMinter(TokenMinterV2)')],
});

// --- ENS -------------------------------------------------------------------------
pin({
  group: 'ENS',
  label: 'ENS Universal Resolver',
  address: evm.ENS_UNIVERSAL_RESOLVER,
  chains: evm.ENS_RESOLUTION_CHAIN_IDS.map(Number),
  source: cite(ENS_FILE, evm.ENS_UNIVERSAL_RESOLVER),
});

// --- ENSv2 on Ethereum Sepolia (wallet handles, phase 23 item 6) ------------------
// ens-register.ts pins the ENSv2 Sepolia deployment (ENS_V2_SEPOLIA) and its
// one payment token (ENS_V2_SEPOLIA_USDC). Two more addresses on the Universal
// Resolver's proxy chain are pinned only in the smoke script's code
// (MANAGED_URP, UR_V2); the engine comment gives them abbreviated. They are
// parsed from the script's source (importing it would run it) and cited there.
// The engine's own reads (readEnsRegistrarConfig, readEnsPricing,
// quoteEnsRegistration, readEnsOwnedResolver) first read the latest block with
// eth_getBlockByNumber, which this script does not send, so the same facts are
// read here with eth_call at 'latest' and compared with the same constants the
// engine compares; readEnsPrimaryName (eth_chainId + eth_call only) runs as is.
const ENSR = evm.ENS_V2_SEPOLIA;
const ENS_SEPOLIA = [Number(ENSR.chainId)];
const ensSmokeText = fs.readFileSync(path.join(ROOT, ENS_SMOKE_FILE), 'utf8');
const smokeConst = (name) => {
  const m = ensSmokeText.match(new RegExp(`^const ${name} = '(0x[0-9a-fA-F]{40})';`, 'm'));
  if (!m) throw new Error(`Collector bug: ${name} is not written in ${ENS_SMOKE_FILE}`);
  return m[1];
};
const ENS_MANAGED_URP = smokeConst('MANAGED_URP');
const ENS_UR_V2 = smokeConst('UR_V2');
// ETHRegistry root roles the registrar must hold: REGISTRAR | RENEW, the
// bitmap the smoke script asserts (1 | 1 << 16).
const ENS_REGISTRAR_ROLES = 1n | (1n << 16n);
const ensRolesSource = cite(ENS_SMOKE_FILE, '1n | (1n << 16n)');
const ensLimitsSource = cite(ENS_REG_FILE, 'export const ENS_V2_SEPOLIA_REGISTRAR_LIMITS');
const ensBytes = (s) => ({ kind: 'bytes', value: Buffer.from(s, 'utf8') });
const EIP165_IETHREGISTRAR = '0xc1401b80'; // docs/WALLET_HANDLES.md 3.3 (a document, not code: report only)

pin({
  group: 'ENSv2 (Sepolia)',
  label: 'ENSv2 ETHRegistrar',
  address: ENSR.ethRegistrar,
  chains: ENS_SEPOLIA,
  source: cite(ENS_REG_FILE, ENSR.ethRegistrar),
  checks: [
    async (c) => addressCheck(c, ENSR.ethRegistrar, 'rentPriceOracle()', [], ENSR.rentPriceOracle, 'rentPriceOracle() (the engine refuses a quote otherwise)'),
    async (c) => addressCheck(c, ENSR.ethRegistrar, 'ETH_REGISTRY()', [], ENSR.ethRegistry, 'ETH_REGISTRY() (the engine refuses a quote otherwise)'),
    ...[
      ['MIN_COMMITMENT_AGE()', 'minCommitmentAge'],
      ['MAX_COMMITMENT_AGE()', 'maxCommitmentAge'],
      ['MIN_REGISTER_DURATION()', 'minRegisterDuration'],
      ['GRACE_PERIOD()', 'gracePeriod'],
    ].map(([sig, key]) => async (c) => uintCheck(c, ENSR.ethRegistrar, sig, evm.ENS_V2_SEPOLIA_REGISTRAR_LIMITS[key], `${sig} = ENS_V2_SEPOLIA_REGISTRAR_LIMITS.${key} (${ensLimitsSource})`)),
    async (c) => reportBool(c, ENSR.ethRegistrar, 'supportsInterface(bytes4)', [{ kind: 'fixedBytes', value: toBytes(EIP165_IETHREGISTRAR) }], `supportsInterface(${EIP165_IETHREGISTRAR}) (report only; docs/WALLET_HANDLES.md 3.3 says true)`),
    async (c) => reportAddressWithCode(c, ENSR.ethRegistrar, 'owner()', 'owner() (report only; docs/WALLET_HANDLES.md 3.4: a key with no code)'),
    async (c) => reportAddressWithCode(c, ENSR.ethRegistrar, 'BENEFICIARY()', 'BENEFICIARY() (report only)'),
  ],
});
pin({
  group: 'ENSv2 (Sepolia)',
  label: 'ENSv2 ETHRegistry (.eth PermissionedRegistry)',
  address: ENSR.ethRegistry,
  chains: ENS_SEPOLIA,
  source: cite(ENS_REG_FILE, ENSR.ethRegistry),
  checks: [
    async (c) => boolCheck(c, ENSR.ethRegistry, 'hasRootRoles(uint256,address)', [uintArg(ENS_REGISTRAR_ROLES), addrArg(ENSR.ethRegistrar)], true, `hasRootRoles(REGISTRAR|RENEW, ETHRegistrar) (${ensRolesSource})`),
  ],
});
pin({
  group: 'ENSv2 (Sepolia)',
  label: 'ENSv2 RootRegistry',
  address: ENSR.rootRegistry,
  chains: ENS_SEPOLIA,
  source: cite(ENS_REG_FILE, ENSR.rootRegistry),
  checks: [
    async (c) => addressCheck(c, ENSR.rootRegistry, 'getSubregistry(string)', [ensBytes('eth')], ENSR.ethRegistry, 'getSubregistry("eth") = the pinned ETHRegistry'),
    async (c) => addressCheck(c, ENSR.rootRegistry, 'getResolver(string)', [ensBytes('reverse')], ENSR.reverseMirrorResolver, 'getResolver("reverse") = the pinned ENSV1Resolver mirror'),
  ],
});
pin({
  group: 'ENSv2 (Sepolia)',
  label: 'ENSv2 StandardRentPriceOracle',
  address: ENSR.rentPriceOracle,
  chains: ENS_SEPOLIA,
  source: cite(ENS_REG_FILE, ENSR.rentPriceOracle),
  checks: [
    async (c) => boolCheck(c, ENSR.rentPriceOracle, 'isPaymentToken(address)', [addrArg(evm.ENS_V2_SEPOLIA_USDC.address)], true, "isPaymentToken(Circle's Sepolia USDC)"),
    async (c) => {
      const name = `getPaymentTokenRatio(USDC) (report only; ${cite(ENS_REG_FILE, 'true / (1, 1000000)')} says (1, 1000000))`;
      try {
        const out = await call(c, ENSR.rentPriceOracle, 'getPaymentTokenRatio(address)', [addrArg(evm.ENS_V2_SEPOLIA_USDC.address)]);
        const n = asUint(out, 0);
        const d = asUint(out, 1);
        return { name, ok: true, detail: `(${n}, ${d})${n === 1n && d === 1000000n ? ' = the comment' : ' DIFFERS from the comment'}` };
      } catch (e) {
        return { name, ok: null, detail: `could not read: ${short(e)}` };
      }
    },
    async (c) => {
      // readPricingAt refuses unless the first priced label length is ENS_V2_MIN_LABEL_LENGTH.
      const name = `getBaseRates(): first priced label length = ENS_V2_MIN_LABEL_LENGTH ${evm.ENS_V2_MIN_LABEL_LENGTH} (${cite(ENS_REG_FILE, 'export const ENS_V2_MIN_LABEL_LENGTH')})`;
      try {
        const rates = asUintArray(await call(c, ENSR.rentPriceOracle, 'getBaseRates()'));
        const first = rates.findIndex((r) => r > 0n) + 1;
        return { name, ok: first === evm.ENS_V2_MIN_LABEL_LENGTH, detail: `rates [${rates.join(', ')}]; first priced ${first}` };
      } catch (e) {
        return { name, ok: null, detail: `could not read: ${short(e)}` };
      }
    },
  ],
});
pin({
  group: 'ENSv2 (Sepolia)',
  label: 'ENSv2 VerifiableFactory',
  address: ENSR.verifiableFactory,
  chains: ENS_SEPOLIA,
  source: cite(ENS_REG_FILE, ENSR.verifiableFactory),
  checks: [
    async (c) => addressCheck(c, ENSR.verifiableFactory, 'proxyLogic()', [], ENSR.verifiableProxyLogic, 'proxyLogic() = the pinned proxy logic'),
    async (c) => {
      // The engine's CREATE2 prediction against the factory's own answer, for a
      // sample owner (the registrar's address: any address serves).
      const owner = ENSR.ethRegistrar;
      const salt = evm.ensOwnedResolverSalt(owner);
      const mine = evm.predictVerifiableProxyAddress(owner, salt);
      return addressCheck(c, ENSR.verifiableFactory, 'predictProxyAddress(address,uint256)', [addrArg(owner), uintArg(salt)], mine, 'predictProxyAddress(sample owner, OwnedResolver salt) = the engine\'s predictVerifiableProxyAddress');
    },
  ],
});
pin({ group: 'ENSv2 (Sepolia)', label: "ENSv2 VerifiableFactory proxyLogic()", address: ENSR.verifiableProxyLogic, chains: ENS_SEPOLIA, source: cite(ENS_REG_FILE, ENSR.verifiableProxyLogic) });
pin({ group: 'ENSv2 (Sepolia)', label: 'ENSv2 PermissionedResolver implementation', address: ENSR.permissionedResolverImpl, chains: ENS_SEPOLIA, source: cite(ENS_REG_FILE, ENSR.permissionedResolverImpl) });
pin({ group: 'ENSv2 (Sepolia)', label: 'ENSv2 UserRegistry implementation', address: ENSR.userRegistryImpl, chains: ENS_SEPOLIA, source: cite(ENS_REG_FILE, ENSR.userRegistryImpl) });
pin({
  group: 'ENSv2 (Sepolia)',
  label: 'ENSv1 ReverseRegistrar (primary names)',
  address: ENSR.v1ReverseRegistrar,
  chains: ENS_SEPOLIA,
  source: cite(ENS_REG_FILE, ENSR.v1ReverseRegistrar),
  checks: [async (c) => addressCheck(c, ENSR.v1ReverseRegistrar, 'defaultResolver()', [], ENSR.v1DefaultResolver, 'defaultResolver() = the pinned v1 PublicResolver')],
});
pin({ group: 'ENSv2 (Sepolia)', label: 'ENSv1 PublicResolver (the ReverseRegistrar\'s default)', address: ENSR.v1DefaultResolver, chains: ENS_SEPOLIA, source: cite(ENS_REG_FILE, ENSR.v1DefaultResolver) });
pin({ group: 'ENSv2 (Sepolia)', label: 'ENSV1Resolver (reverse mirror)', address: ENSR.reverseMirrorResolver, chains: ENS_SEPOLIA, source: cite(ENS_REG_FILE, ENSR.reverseMirrorResolver) });
// The Universal Resolver proxy is collected above; on Sepolia its proxy chain
// is checked too (merged into the same row).
pin({
  group: 'ENS',
  label: 'ENS Universal Resolver',
  address: evm.ENS_UNIVERSAL_RESOLVER,
  chains: ENS_SEPOLIA,
  source: cite(ENS_FILE, evm.ENS_UNIVERSAL_RESOLVER),
  checks: [
    async (c) => slotAddressCheck(c, evm.ENS_UNIVERSAL_RESOLVER, ENS_MANAGED_URP, `ERC-1967 slot = MANAGED_URP (${cite(ENS_SMOKE_FILE, 'const MANAGED_URP =')})`),
    async (c) => reportAddressWithCode(c, evm.ENS_UNIVERSAL_RESOLVER, 'admin()', 'admin() (report only; docs/WALLET_HANDLES.md 3.4: no code)'),
  ],
});
pin({
  group: 'ENSv2 (Sepolia)',
  label: 'ManagedUniversalResolverProxy (pinned in the smoke script)',
  address: ENS_MANAGED_URP,
  chains: ENS_SEPOLIA,
  source: cite(ENS_SMOKE_FILE, 'const MANAGED_URP ='),
  checks: [
    async (c) => slotAddressCheck(c, ENS_MANAGED_URP, ENS_UR_V2, `ERC-1967 slot = UR_V2 (${cite(ENS_SMOKE_FILE, 'const UR_V2 =')})`),
    async (c) => addressCheck(c, ENS_MANAGED_URP, 'implementation()', [], ENS_UR_V2, 'implementation() = UR_V2'),
    async (c) => reportAddressWithCode(c, ENS_MANAGED_URP, 'admin()', 'admin() (report only; docs/WALLET_HANDLES.md 3.4: no code)'),
  ],
  documented: [{ fact: 'engine comment abbreviates it', source: cite(ENS_REG_FILE, '0x6d80…e6F1'), addressPrefix: '0x6d80', addressSuffix: 'e6F1' }],
});
pin({
  group: 'ENSv2 (Sepolia)',
  label: 'UniversalResolverV2 (pinned in the smoke script)',
  address: ENS_UR_V2,
  chains: ENS_SEPOLIA,
  source: cite(ENS_SMOKE_FILE, 'const UR_V2 ='),
  checks: [async (c) => addressCheck(c, ENS_UR_V2, 'ROOT_REGISTRY()', [], ENSR.rootRegistry, 'ROOT_REGISTRY() = the pinned RootRegistry')],
  documented: [{ fact: 'engine comment abbreviates it', source: cite(ENS_REG_FILE, '0x24E1…2D72'), addressPrefix: '0x24E1', addressSuffix: '2D72' }],
});
// readEnsPrimaryName through the Universal Resolver on both ENS networks, for
// an address with no expected primary name (the registrar's): the engine's own
// strict decode must answer without a refusal.
pin({
  group: 'ENS',
  label: 'ENS Universal Resolver',
  address: evm.ENS_UNIVERSAL_RESOLVER,
  chains: evm.ENS_RESOLUTION_CHAIN_IDS.map(Number),
  source: cite(ENS_FILE, evm.ENS_UNIVERSAL_RESOLVER),
  checks: [
    async (c) => engineCheck(c, 'readEnsPrimaryName (engine, sample address)', async () => {
      const r = await evm.readEnsPrimaryName(c.node, ENSR.ethRegistrar, BigInt(c.chainId));
      return `status ${r.status}${r.name ? ` (${r.name})` : ''} for ${ENSR.ethRegistrar}`;
    }),
  ],
});

// --- Tokens and fixed addresses ---------------------------------------------------
const tokenRows = new Map(); // chainId:address -> { symbol, decimals, sources: [] }
function addToken(chainId, address, symbol, decimals, source) {
  const key = `${chainId}:${lower(address)}`;
  const row = tokenRows.get(key) ?? { chainId, address, symbol, decimals, sources: [] };
  if (row.symbol !== symbol || row.decimals !== decimals) throw new Error(`Collector: two tables disagree on ${key}: ${row.symbol}/${row.decimals} vs ${symbol}/${decimals}`);
  row.sources.push(source);
  tokenRows.set(key, row);
}
for (const [caip2, list] of Object.entries(tokensApp.KNOWN_TEST_NETWORK_TOKENS)) {
  for (const t of list) addToken(Number(caip2.split(':')[1]), t.assetId.reference, t.symbol, t.decimals, cite(TOKENS_FILE, t.assetId.reference));
}
for (const [caip2, list] of Object.entries(tokensApp.KNOWN_STAKING_TOKENS)) {
  for (const t of list) addToken(Number(caip2.split(':')[1]), t.assetId.reference, t.symbol, t.decimals, `${cite(TOKENS_FILE, t.assetId.reference)} (staking)`);
}
addToken(1, erc20App.USDC_MAINNET.assetId.reference, erc20App.USDC_MAINNET.symbol, erc20App.USDC_MAINNET.decimals, cite('app/src/wallet/erc20.ts', erc20App.USDC_MAINNET.assetId.reference));
for (const [id, usdc] of Object.entries(evm.CCTP_V2_TESTNET_USDC)) addToken(Number(id), usdc, 'USDC', 6, `${cite(CCTP_FILE, usdc)} (CCTP)`);
for (const [id, t] of Object.entries(C.tokens)) addToken(Number(id), t, 'USDC', 6, `${cite(CIRCLE_FILE, t)} (Circle paymaster token)`);
for (const [id, t] of Object.entries(PM.tokens)) addToken(Number(id), t, 'USDC', 6, `${cite(PIMLICO_FILE, t)} (Pimlico paymaster token)`);
{
  const t = evm.ENS_V2_SEPOLIA_USDC;
  addToken(Number(evm.ENS_V2_SEPOLIA.chainId), t.address, t.symbol, t.decimals, `${cite(ENS_REG_FILE, t.address)} (ENS registration payment token)`);
}
for (const row of tokenRows.values()) {
  pin({
    group: 'Tokens',
    label: `Token ${row.symbol}`,
    address: row.address,
    chains: [row.chainId],
    source: row.sources.join('; '),
    checks: [
      async (c) => stringCheck(c, row.address, 'symbol()', row.symbol, 'symbol()'),
      async (c) => uintCheck(c, row.address, 'decimals()', BigInt(row.decimals), 'decimals()'),
    ],
  });
}
pin({
  group: 'Fixed addresses',
  label: 'Uniswap Permit2 (typed-data summaries)',
  address: typedApp.PERMIT2_ADDRESS,
  chains: [1, 11155111, 84532],
  source: `${cite('app/src/wallet/typed-data-summary.ts', 'export const PERMIT2_ADDRESS')}; activity label ${cite(ACTIVITY_FILE, '0x000000000022D473030F116dDEE9F6B43aC78BA3')}`,
  documented: [{ fact: '9,152 bytes on mainnet and Sepolia (2026-10-02)', source: cite('app/src/wallet/typed-data-summary.ts', 'same 9,152 bytes'), length: 9152 }],
});
const wethChains = {
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': [1],
  '0xfff9976782d46cc05630d1f6ebab18b2324d6b14': [11155111],
  '0x4200000000000000000000000000000000000006': [84532, 11155420], // the OP-stack predeploy (asset-diff.ts comment)
};
for (const a of assetDiff.WRAPPED_NATIVE_TOKENS) {
  pin({
    group: 'Fixed addresses',
    label: 'WETH9 (wrap / unwrap decoding)',
    address: a,
    chains: wethChains[lower(a)] ?? [],
    source: cite(ASSET_FILE, a),
    checks: [async (c) => stringCheck(c, a, 'symbol()', 'WETH', 'symbol()')],
  });
}
pin({
  group: 'Fixed addresses',
  label: 'OP-stack GasPriceOracle predeploy (L1 data fee quotes)',
  address: sendApp.OP_STACK_GAS_PRICE_ORACLE,
  chains: NETWORKS.filter((n) => P[n.key].l1DataFee).map((n) => n.chainId),
  source: cite('app/src/wallet/send.ts', 'export const OP_STACK_GAS_PRICE_ORACLE'),
  checks: [async (c) => reportString(c, sendApp.OP_STACK_GAS_PRICE_ORACLE, 'version()', 'version() (report only)')],
});
pin({
  group: 'Fixed addresses',
  label: 'EIP-7708 protocol transfer-log emitter (decoded, never called)',
  address: evm.EIP7708_TRANSFER_LOG_ADDRESS,
  chains: KERNEL_CHAINS,
  expect: 'no-code',
  source: cite(ASSET_FILE, evm.EIP7708_TRANSFER_LOG_ADDRESS),
});

// ---------------------------------------------------------------------------
// Merge pins that name the same address on the same network
// ---------------------------------------------------------------------------

/** Rows: one per (network, address). */
function rowsFor(chainId) {
  const out = new Map();
  for (const p of pins) {
    if (!p.chains.includes(chainId)) continue;
    const key = lower(p.address);
    const row = out.get(key);
    if (!row) {
      out.set(key, { ...p, labels: [p.label], sources: [p.source], checks: [...p.checks], documented: [...p.documented], hash: p.hashes[chainId] ?? null, hashSources: p.hashes[chainId] ? [p.hashSource] : [] });
    } else {
      // A pin repeated for extra checks on one network adds no new label or source.
      if (!row.labels.includes(p.label)) row.labels.push(p.label);
      if (!row.sources.includes(p.source)) row.sources.push(p.source);
      row.checks.push(...p.checks);
      row.documented.push(...p.documented);
      if (p.hashes[chainId]) {
        if (row.hash && !same(row.hash, p.hashes[chainId])) throw new Error(`Collector: two pinned hashes for ${key} on ${chainId}`);
        row.hash = p.hashes[chainId];
        row.hashSources.push(p.hashSource);
      }
      // The strictest expectation wins.
      const rank = { code: 3, 'no-code': 2, 'eoa-or-delegated': 1, optional: 0 };
      if (rank[p.expect] > rank[row.expect]) row.expect = p.expect;
    }
  }
  return [...out.values()];
}

// ---------------------------------------------------------------------------
// Offline listing
// ---------------------------------------------------------------------------

const selected = opts.network
  ? ALL_NETWORKS.filter((n) => n.key === opts.network || String(n.chainId) === String(opts.network))
  : ALL_NETWORKS;
if (selected.length === 0) {
  console.error(`Unknown network ${opts.network}. Use a chain id or one of: ${ALL_NETWORKS.map((n) => n.key).join(', ')}.`);
  process.exit(2);
}

if (opts.offline) {
  let total = 0;
  for (const n of selected) {
    const rows = rowsFor(n.chainId);
    total += rows.length;
    console.log(`\n## ${n.label} (chain ${n.chainId}) — ${rows.length} pinned addresses`);
    console.log('| What | Address | Expect | Pinned code hash | Source |');
    console.log('|---|---|---|---|---|');
    for (const r of rows) console.log(`| ${r.labels.join(' / ')} | ${r.address} | ${r.expect} | ${r.hash ?? '—'} | ${r.sources.join('; ')} |`);
  }
  console.log(`\n${total} (network, address) pairs collected from ${pins.length} pins. Offline: no request was made.`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Live reads
// ---------------------------------------------------------------------------

const RPC_TIMEOUT_MS = 20_000;
let rpcId = 0;
async function rpcPost(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host} for ${method}`);
  const body = await res.json();
  if (body.error) throw new Error(`RPC error ${body.error.code ?? ''}: ${String(body.error.message ?? JSON.stringify(body.error)).slice(0, 160)} (${method})`);
  if (!('result' in body)) throw new Error(`no result from ${new URL(url).host} for ${method}`);
  return body.result;
}

const ALLOWED_METHODS = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getCode', 'eth_call', 'eth_getStorageAt']);

/** A transport over the network's endpoints, each checked for its chain id once. */
async function makeNode(n) {
  const healthy = [];
  const notes = [];
  for (const url of n.rpcUrls) {
    try {
      const id = await rpcPost(url, 'eth_chainId', []);
      if (Number(BigInt(id)) !== n.chainId) {
        notes.push(`${new URL(url).host}: serves chain ${Number(BigInt(id))}, skipped`);
        continue;
      }
      const head = await rpcPost(url, 'eth_blockNumber', []);
      healthy.push({ url, head: Number(BigInt(head)) });
    } catch (e) {
      notes.push(`${new URL(url).host}: ${short(e)}`);
    }
  }
  // An endpoint far behind the others may serve old state; it is listed and
  // not used. 300 blocks is a judgement (about an hour on Ethereum, ten
  // minutes on OP-stack chains, about 75 s on Arbitrum).
  const best = Math.max(0, ...healthy.map((h) => h.head));
  for (const h of [...healthy]) {
    if (best - h.head > 300) {
      notes.push(`${new URL(h.url).host}: head ${h.head} is ${best - h.head} blocks behind ${best}, not used`);
      healthy.splice(healthy.indexOf(h), 1);
    }
  }
  const node = async (method, params) => {
    if (!ALLOWED_METHODS.has(method)) throw new Error(`verify-pins refuses ${method}: read-only methods only`);
    let last;
    for (const h of healthy) {
      try {
        return await rpcPost(h.url, method, params);
      } catch (e) {
        last = e;
        // An execution revert is an answer, not an endpoint failure.
        if (/RPC error (3|-32000|-32015)\b/.test(String(e.message)) && /revert/i.test(String(e.message))) throw e;
      }
    }
    throw last ?? new Error('no healthy endpoint');
  };
  return { node, healthy, notes };
}

// --- small ABI helpers -----------------------------------------------------------

const addrArg = (value) => ({ kind: 'address', value });
const uintArg = (value) => ({ kind: 'uint256', value });
async function call(c, to, sig, args = []) {
  const out = await c.node('eth_call', [{ to, data: toHex(encodeFunctionCall(sig, args)) }, 'latest']);
  if (typeof out !== 'string' || !/^0x[0-9a-fA-F]*$/.test(out)) throw new Error(`${sig} returned a non-hex answer`);
  return out;
}
function wordOf(hex, i) {
  const w = hex.slice(2 + i * 64, 2 + (i + 1) * 64);
  if (w.length !== 64) throw new Error('short answer');
  return w;
}
const asAddress = (hex, i = 0) => {
  const w = wordOf(hex, i);
  if (!/^0{24}/.test(w)) throw new Error('not an address word');
  return checksum('0x' + w.slice(24));
};
const asUint = (hex, i = 0) => BigInt('0x' + wordOf(hex, i));
function asStringAt(hex, headIndex) {
  const off = Number(asUint(hex, headIndex)) / 32;
  const len = Number(asUint(hex, off));
  const start = 2 + (off + 1) * 64;
  const bytes = Buffer.from(hex.slice(start, start + len * 2), 'hex');
  if (bytes.length !== len) throw new Error('short string');
  return bytes.toString('utf8');
}
async function addressCheck(c, to, sig, args, expected, name) {
  try {
    const got = asAddress(await call(c, to, sig, args));
    return { name, ok: same(got, expected), detail: same(got, expected) ? got : `${got} (expected ${checksum(expected)})` };
  } catch (e) {
    return { name, ok: null, detail: `could not read: ${short(e)}` };
  }
}
async function uintCheck(c, to, sig, expected, name) {
  try {
    const got = asUint(await call(c, to, sig));
    return { name, ok: got === expected, detail: got === expected ? String(got) : `${got} (expected ${expected})` };
  } catch (e) {
    return { name, ok: null, detail: `could not read: ${short(e)}` };
  }
}
async function boolCheck(c, to, sig, args, expected, name) {
  try {
    const got = asUint(await call(c, to, sig, args));
    if (got > 1n) throw new Error('not a boolean word');
    return { name, ok: (got === 1n) === expected, detail: String(got === 1n) };
  } catch (e) {
    return { name, ok: null, detail: `could not read: ${short(e)}` };
  }
}
async function stringCheck(c, to, sig, expected, name) {
  try {
    const got = evm.decodeAbiString(await call(c, to, sig));
    return { name, ok: got === expected, detail: got === expected ? JSON.stringify(got) : `${JSON.stringify(got)} (expected ${JSON.stringify(expected)})` };
  } catch (e) {
    return { name, ok: null, detail: `could not read: ${short(e)}` };
  }
}
async function reportString(c, to, sig, name) {
  try {
    return { name, ok: true, detail: JSON.stringify(evm.decodeAbiString(await call(c, to, sig))) };
  } catch (e) {
    return { name, ok: null, detail: `could not read: ${short(e)}` };
  }
}
async function reportUint(c, to, sig, name) {
  try {
    return { name, ok: true, detail: String(asUint(await call(c, to, sig))) };
  } catch (e) {
    return { name, ok: null, detail: `could not read: ${short(e)}` };
  }
}
async function reportBool(c, to, sig, args, name) {
  try {
    const got = asUint(await call(c, to, sig, args));
    if (got > 1n) throw new Error('not a boolean word');
    return { name, ok: true, detail: String(got === 1n) };
  } catch (e) {
    return { name, ok: null, detail: `could not read: ${short(e)}` };
  }
}
/** Reads an address-returning view and reports the address and whether it holds code. */
async function reportAddressWithCode(c, to, sig, name) {
  try {
    const got = asAddress(await call(c, to, sig));
    const code = await c.node('eth_getCode', [got, 'latest']);
    const len = typeof code === 'string' ? (code.length - 2) / 2 : null;
    const delegated = len === 23 && code.slice(2, 8).toLowerCase() === 'ef0100' ? `, an EIP-7702 delegation to ${checksum('0x' + code.slice(8))}` : '';
    return { name, ok: true, detail: `${got} (${len === 0 ? 'no code' : `${len} bytes of code${delegated}`})` };
  } catch (e) {
    return { name, ok: null, detail: `could not read: ${short(e)}` };
  }
}
/** The ERC-1967 implementation slot of `to` must hold `expected`. */
async function slotAddressCheck(c, to, expected, name) {
  try {
    const slot = await c.node('eth_getStorageAt', [to, ERC1967_SLOT, 'latest']);
    if (typeof slot !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(slot)) throw new Error('eth_getStorageAt returned a non-word answer');
    const got = checksum('0x' + slot.slice(2).padStart(64, '0').slice(24));
    return { name, ok: same(got, expected), detail: same(got, expected) ? got : `${got} (expected ${checksum(expected)})` };
  } catch (e) {
    return { name, ok: null, detail: `could not read: ${short(e)}` };
  }
}
/** A uint256[] return value (one dynamic array). */
function asUintArray(hex) {
  const off = Number(asUint(hex, 0)) / 32;
  const len = Number(asUint(hex, off));
  return Array.from({ length: len }, (_, i) => asUint(hex, off + 1 + i));
}
async function eip712DomainCheck(c, to, expectedName, expectedVersion) {
  const name = 'eip712Domain()';
  try {
    const out = await call(c, to, 'eip712Domain()');
    const n = asStringAt(out, 1);
    const v = asStringAt(out, 2);
    const chainId = asUint(out, 3);
    const verifying = asAddress(out, 4);
    const ok = n === expectedName && v === expectedVersion && chainId === BigInt(c.chainId) && same(verifying, to);
    return { name, ok, detail: `("${n}", "${v}", ${chainId}, ${verifying})${ok ? '' : ` (expected ("${expectedName}", "${expectedVersion}", ${c.chainId}, ${checksum(to)}))`}` };
  } catch (e) {
    return { name, ok: null, detail: `could not read: ${short(e)}` };
  }
}
async function entryPointStake(c, who, what) {
  const name = `EntryPoint stake of the ${what} (report only)`;
  try {
    const out = await call(c, evm.ENTRYPOINT_V07, 'getDepositInfo(address)', [addrArg(who)]);
    const staked = asUint(out, 1) !== 0n;
    return { name, ok: true, detail: `staked ${staked}, stake ${fmtEth(asUint(out, 2))}, unstake delay ${asUint(out, 3)} s, deposit ${fmtEth(asUint(out, 0))}` };
  } catch (e) {
    return { name, ok: null, detail: `could not read: ${short(e)}` };
  }
}
async function engineCheck(c, name, fn) {
  try {
    return { name, ok: true, detail: await fn() };
  } catch (e) {
    const msg = short(e);
    // A transport failure is "could not read"; anything else is the engine's refusal.
    const transport = /HTTP \d|timeout|aborted|fetch failed|no healthy endpoint/i.test(msg);
    return { name, ok: transport ? null : false, detail: transport ? `could not read: ${msg}` : msg };
  }
}
function fmtEth(wei) {
  const s = wei.toString().padStart(19, '0');
  const whole = s.slice(0, -18);
  const frac = s.slice(-18).replace(/0+$/, '');
  return `${whole}${frac ? '.' + frac : ''} ETH`;
}
function short(e) {
  return String(e && e.message ? e.message : e).replace(/\s+/g, ' ').slice(0, 220);
}

// --- Sourcify (read-only GET) ------------------------------------------------------

const sourcifyCache = new Map();
async function sourcify(chainId, address) {
  const key = `${chainId}:${lower(address)}`;
  if (sourcifyCache.has(key)) return sourcifyCache.get(key);
  const p = (async () => {
    const url = `https://sourcify.dev/server/v2/contract/${chainId}/${address}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
        if (res.status === 404) return 'none';
        if (res.status === 429 || res.status >= 500) {
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
          continue;
        }
        if (!res.ok) return `could not read (HTTP ${res.status})`;
        const body = await res.json();
        // Sourcify's own names (docs.sourcify.dev/docs/exact-match-vs-match):
        // "Exact Matches (prev. called \"perfect match\")" and "Matches (prev.
        // called \"partial match\")".
        if (body.match === 'exact_match') return 'exact_match';
        if (body.match === 'match') return 'match';
        if (body.match === null || body.match === undefined) return 'none';
        return `could not read (match "${body.match}")`;
      } catch (e) {
        if (attempt === 2) return `could not read (${short(e)})`;
      }
    }
    return 'could not read (rate limited)';
  })();
  sourcifyCache.set(key, p);
  return p;
}

// --- one row ---------------------------------------------------------------------

const ERC1967_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

async function verifyRow(c, row) {
  const r = { ...row, checks: undefined, length: null, keccak: null, delegatedTo: null, implementation: null, implSourcify: null, sourcifyStatus: null, facts: [], hashResult: 'no pinned hash', status: null, documentedResults: [] };
  let code;
  try {
    code = await c.node('eth_getCode', [row.address, 'latest']);
    if (typeof code !== 'string' || !/^0x[0-9a-fA-F]*$/.test(code)) throw new Error('eth_getCode returned a non-hex answer');
  } catch (e) {
    r.status = 'unreadable';
    r.error = short(e);
    return r;
  }
  const bytes = Buffer.from(code.slice(2), 'hex');
  r.length = bytes.length;
  r.keccak = bytes.length ? '0x' + Buffer.from(keccak_256(bytes)).toString('hex') : null;
  if (bytes.length === 23 && code.slice(2, 8).toLowerCase() === 'ef0100') r.delegatedTo = checksum('0x' + code.slice(8));

  if (row.expect === 'no-code') {
    // The source states "no contract code": an EIP-7702 designator is code.
    r.status = bytes.length === 0 ? 'confirmed-no-code' : 'unexpected-code';
    if (r.delegatedTo) r.note = `EIP-7702 delegated to ${r.delegatedTo}`;
    return r;
  }
  if (row.expect === 'eoa-or-delegated') {
    r.status = bytes.length === 0 ? 'confirmed-no-code' : r.delegatedTo ? 'eoa-delegated' : 'unexpected-code';
    if (r.delegatedTo) r.note = `an externally owned account carrying an EIP-7702 delegation to ${r.delegatedTo} (anyone holding the published key can set one)`;
    return r;
  }
  if (bytes.length === 0) {
    r.status = row.expect === 'optional' ? 'absent-optional' : 'missing';
    return r;
  }
  if (row.hash) r.hashResult = same(row.hash, r.keccak) ? 'match' : 'MISMATCH';
  for (const d of row.documented) {
    const parts = [];
    if (d.length !== undefined) parts.push(d.length === r.length ? `length ${r.length} = documented` : `length ${r.length} ≠ documented ${d.length}`);
    if (d.keccakPrefix) parts.push(r.keccak.startsWith(d.keccakPrefix) && r.keccak.endsWith(d.keccakSuffix) ? 'keccak agrees with the truncated documented value' : 'keccak differs from the truncated documented value');
    if (d.addressPrefix) parts.push(lower(r.address).startsWith(lower(d.addressPrefix)) && lower(r.address).endsWith(lower(d.addressSuffix)) ? `address agrees with the abbreviated ${d.addressPrefix}…${d.addressSuffix}` : `address differs from the abbreviated ${d.addressPrefix}…${d.addressSuffix}`);
    r.documentedResults.push(`${parts.join('; ')} (${d.source})`);
  }
  try {
    const slot = await c.node('eth_getStorageAt', [row.address, ERC1967_SLOT, 'latest']);
    if (typeof slot === 'string' && /^0x0*$/.test(slot) === false) {
      const impl = '0x' + slot.slice(2).padStart(64, '0').slice(24);
      r.implementation = checksum(impl);
    }
  } catch (e) {
    r.implementation = `could not read (${short(e)})`;
  }
  if (opts.sourcify) {
    r.sourcifyStatus = await sourcify(c.chainId, row.address);
    if (r.implementation && r.implementation.startsWith('0x')) r.implSourcify = await sourcify(c.chainId, r.implementation);
  } else {
    r.sourcifyStatus = 'not asked (--no-sourcify)';
  }
  for (const check of row.checks) r.facts.push(await check(c));
  const factFailed = r.facts.some((f) => f.ok === false);
  const factUnread = r.facts.some((f) => f.ok === null);
  const sourceBound = r.hashResult === 'match' || r.sourcifyStatus === 'exact_match' || r.sourcifyStatus === 'match';
  // For an ERC-1967 proxy the behaviour lives in the implementation, so the
  // implementation must be bound to source too (or the row stays unverified).
  // Proxies of other kinds (for example Lido's Aragon proxies) are not detected.
  r.implBound = !r.implementation || (r.implementation.startsWith('0x') && (r.implSourcify === 'exact_match' || r.implSourcify === 'match'));
  if (!r.implBound) r.reason = `the ERC-1967 implementation ${r.implementation} is not bound to source (Sourcify: ${r.implSourcify ?? 'not asked'})`;
  if (r.hashResult === 'MISMATCH') r.status = 'hash-mismatch';
  else if (factFailed) r.status = 'fact-failed';
  else if (sourceBound && !factUnread && r.implBound) r.status = 'verified';
  else r.status = 'present-unverified';
  return r;
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const started = new Date().toISOString();
console.log(`verify-pins: read-only check of the wallet's pinned addresses, ${started}`);
console.log(`Repository HEAD: ${readHead()}; engine dist built ${fs.statSync(path.join(ROOT, 'packages/chains-evm/dist/index.js')).mtime.toISOString()}`);

const results = [];
const FAIL_STATUSES = new Set(['missing', 'hash-mismatch', 'fact-failed', 'unexpected-code']);
const totals = {};
const sections = [];

// Pass 1: read every network.
for (const n of selected) {
  const rows = rowsFor(n.chainId);
  const { node, healthy, notes } = await makeNode(n);
  const section = { n, healthy, notes, rows: [] };
  sections.push(section);
  if (!healthy.length) {
    for (const row of rows) {
      const r = { network: n.key, chainId: n.chainId, ...row, checks: undefined, facts: [], documentedResults: [], status: 'unreadable', error: 'no endpoint answered with this chain id' };
      section.rows.push(r);
      results.push(r);
    }
    continue;
  }
  const c = { node, chainId: n.chainId };
  for (const r of await pool(rows, 4, (row) => verifyRow(c, row))) {
    const full = { network: n.key, chainId: n.chainId, ...r };
    section.rows.push(full);
    results.push(full);
  }
}

// Pass 2, identity: code byte-identical to the same address's code on another
// network where it is bound to source (a pinned hash or a Sourcify match) is
// bound to the same source. Such rows become verified-by-identity when every
// fact read as stated.
for (const r of results) {
  if (r.status !== 'present-unverified' || !r.keccak) continue;
  if ((r.facts ?? []).some((f) => f.ok !== true) || r.implBound === false) continue;
  const twin = results.find((o) => o !== r && o.status === 'verified' && same(o.address, r.address) && o.keccak === r.keccak);
  if (twin) {
    r.status = 'verified-by-identity';
    r.identity = `byte-identical to ${twin.network} (${twin.hashResult === 'match' ? 'pinned hash' : `Sourcify ${twin.sourcifyStatus}`} there)`;
  }
}

// Pass 3: print.
for (const { n, healthy, notes, rows } of sections) {
  console.log(`\n## ${n.label} (chain ${n.chainId})`);
  console.log(`Endpoints (${n.rpcSource}): ${healthy.length ? healthy.map((h) => `${new URL(h.url).host} (head ${h.head})`).join(', ') : 'NONE answered'}${notes.length ? `; not used: ${notes.join('; ')}` : ''}`);
  console.log('| What | Address | Bytes | keccak-256 of code | Pinned hash | Sourcify (impl) | Facts | Status |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const facts = [
      ...r.facts.map((f) => `${f.ok === true ? '✓' : f.ok === false ? '✗' : '?'} ${f.name}: ${f.detail}`),
      ...r.documentedResults.map((d) => `doc: ${d}`),
      ...(r.note ? [r.note] : []),
      ...(r.identity ? [r.identity] : []),
      ...(r.reason ? [`unverified because ${r.reason}`] : []),
      ...(r.error ? [r.error] : []),
    ].join('<br>');
    const sf = r.sourcifyStatus ? `${r.sourcifyStatus}${r.implementation ? ` (impl ${r.implementation}: ${r.implSourcify ?? '—'})` : ''}` : '—';
    console.log(`| ${r.labels.join(' / ')} | ${r.address} | ${r.length ?? '—'} | ${r.keccak ?? '—'} | ${r.hash ? `${r.hashResult}` : 'no pinned hash'} | ${sf} | ${facts || '—'} | ${r.status} |`);
  }
  const counts = countStatuses(rows);
  totals[n.key] = counts;
  console.log(`Summary ${n.label}: ${fmtCounts(counts)}`);
}

// Cross-network comparison: for each address read on two or more networks.
const byAddress = new Map();
for (const r of results) {
  if (!r.keccak) continue;
  const list = byAddress.get(lower(r.address)) ?? [];
  list.push(r);
  byAddress.set(lower(r.address), list);
}
console.log('\n## Cross-network code comparison (addresses with code on two or more networks)');
console.log('| Address | What | Networks with byte-identical code | Differs |');
console.log('|---|---|---|---|');
for (const list of byAddress.values()) {
  if (list.length < 2) continue;
  const groups = new Map();
  for (const r of list) groups.set(r.keccak, [...(groups.get(r.keccak) ?? []), `${r.network} (${r.length} B)`]);
  const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  console.log(`| ${list[0].address} | ${list[0].labels[0]} | ${sorted[0][1].join(', ')} | ${sorted.slice(1).map(([h, ns]) => `${ns.join(', ')} ${h.slice(0, 12)}…`).join('; ') || 'none'} |`);
}

console.log('\n## Summary');
const grand = {};
for (const [k, c] of Object.entries(totals)) {
  console.log(`- ${k}: ${fmtCounts(c)}`);
  for (const [s, v] of Object.entries(c)) grand[s] = (grand[s] ?? 0) + v;
}
console.log(`- all: ${fmtCounts(grand)}`);
console.log('Statuses: verified = code present, bound to source by a pinned code hash or a Sourcify exact_match / match, and every documented fact read as stated;');
console.log('verified-by-identity = byte-identical to the same address on another network where it is verified (named in the Facts column);');
console.log('present-unverified = code present but nothing binds it (or, for an ERC-1967 proxy, its implementation) to source, or a fact could not be read; missing = no code where the source expects a contract;');
console.log('unreadable = eth_getCode failed; hash-mismatch / fact-failed = the chain disagrees with the source; confirmed-no-code / eoa-delegated / unexpected-code = for addresses the source states are not contracts;');
console.log('Sourcify answers are printed as given: exact_match (formerly "perfect"), match (formerly "partial": the bytecode matches, the metadata hash does not), none (not verified on that chain).');
console.log('absent-optional = a refusal-list address with no code (not a failure).');

if (opts.json) {
  fs.writeFileSync(opts.json, JSON.stringify({ started, head: readHead(), totals, results: results.map(stripFns) }, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  console.log(`JSON written to ${opts.json}`);
}
const failures = results.filter((r) => FAIL_STATUSES.has(r.status));
if (failures.length) {
  console.log(`\nFAILED: ${failures.length} row(s): ${failures.map((f) => `${f.network} ${f.labels[0]} ${f.address} ${f.status}`).join('; ')}`);
  process.exit(1);
}
console.log('\nNo missing code, no hash mismatch and no failed fact. Rows marked present-unverified or unreadable still need a reader.');

function countStatuses(rows) {
  const c = {};
  for (const r of rows) c[r.status] = (c[r.status] ?? 0) + 1;
  return c;
}
function fmtCounts(c) {
  const order = ['verified', 'verified-by-identity', 'present-unverified', 'missing', 'unreadable', 'hash-mismatch', 'fact-failed', 'confirmed-no-code', 'eoa-delegated', 'unexpected-code', 'absent-optional'];
  return order.filter((s) => c[s]).map((s) => `${s} ${c[s]}`).join(', ') || 'nothing read';
}
function stripFns(r) {
  const { checks, ...rest } = r;
  void checks;
  return rest;
}
function readHead() {
  try {
    // In a linked worktree .git is a file "gitdir: <path>"; its refs live in
    // the common directory named by <gitdir>/commondir.
    let gitDir = path.join(ROOT, '.git');
    if (fs.statSync(gitDir).isFile()) {
      const m = fs.readFileSync(gitDir, 'utf8').match(/^gitdir:\s*(.+)$/m);
      if (!m) return 'unknown';
      gitDir = path.resolve(ROOT, m[1].trim());
    }
    const commonFile = path.join(gitDir, 'commondir');
    const commonDir = fs.existsSync(commonFile) ? path.resolve(gitDir, fs.readFileSync(commonFile, 'utf8').trim()) : gitDir;
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head;
    const ref = head.slice(5);
    const loose = path.join(commonDir, ref);
    if (fs.existsSync(loose)) return fs.readFileSync(loose, 'utf8').trim();
    const packed = fs.readFileSync(path.join(commonDir, 'packed-refs'), 'utf8').split('\n').find((l) => l.endsWith(' ' + ref));
    return packed ? packed.split(' ')[0] : 'unknown';
  } catch {
    return 'unknown';
  }
}
