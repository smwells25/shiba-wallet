/**
 * Subscription keeper for Kernel v3.3 session-key subscriptions on Sepolia
 * (phase 12 item 2), driven only by engine code
 * (packages/chains-evm/src/kernel-subscription.ts on top of
 * kernel-permissions.ts).
 *
 * ROLES. The SUBSCRIBER is the dev seed's Kernel account (index 2,
 * 0x1D723b78e1D0D84Fd0531e2686285fb1B6414106); its owner key installs and
 * revokes the grant through the same explicit, root-signed path the app uses
 * (installValidations + grantAccess as self-calls in one owner-signed
 * UserOperation). The KEEPER acts for the merchant and holds ONLY the session
 * private key (.dev-wallet/subscription-session.key) and the public grant
 * (.dev-wallet/subscription-grant.json): the `pull` and `run` commands never
 * read the recovery phrase, and `demo` runs every keeper step in a separate
 * child process to make that visible.
 *
 * COMMANDS (run from the repository root after `npm run build`):
 *   node scripts/testnet/subscription-keeper.mjs dry-run
 *       Read-only. eth_simulateV1 against the real Sepolia EntryPoint v0.7,
 *       Kernel v3.3 and ZeroDev modules, for the PUBLIC test mnemonic's
 *       undeployed Kernel account and a 5 USDC / 30-day subscription
 *       (Sepolia USDC balance set by a state override): deploy + install,
 *       pull 1, a second pull in the same period, an over-cap pull, the
 *       batch residual (two in-cap transfers in ONE operation), a pull to
 *       another recipient, pull 3, a pull beyond the count, revoke, a pull
 *       after revocation. Block times are overridden per simulated block.
 *       Nothing is signed with dev keys and nothing is broadcast.
 *   set -a; . .dev-wallet/env; set +a
 *   node scripts/testnet/subscription-keeper.mjs install [--period 120] [--periods 3] [--amount 1000] [--fee-budget-wei N]
 *       SUBSCRIBER (reads the mnemonic): native subscription to the dev
 *       seed's index-5 EOA; generates the session key (saved 0600 BEFORE the
 *       install is submitted), installs, reads the permission back.
 *   node scripts/testnet/subscription-keeper.mjs pull [--amount N] [--unchecked]
 *       KEEPER: one pull attempt. Without --unchecked a pull the account
 *       would refuse is refused locally first, from the on-chain state (too
 *       early for the next period, payments used up, ended or revoked) and
 *       the grant (cap, merchant). --unchecked skips those local checks so
 *       the ACCOUNT's own refusal can be recorded (negative tests); a refusal
 *       is printed as REJECTED with the bundler's verbatim text and, when the
 *       estimate already refused, a direct submission with the last accepted
 *       gas limits plus a decoded handleOps eth_call simulation.
 *   node scripts/testnet/subscription-keeper.mjs run [--once]
 *       KEEPER: pulls whenever a period opens until the grant is used up,
 *       expires or is revoked (or Ctrl-C).
 *   node scripts/testnet/subscription-keeper.mjs import <file> [--force]
 *       KEEPER: takes the app's one-time key hand-over (the JSON behind the
 *       QR on Sessions → Subscriptions, type shiba-wallet:subscription-key),
 *       checks that the key derives to the grant's session address and that
 *       the account stores exactly that signer for the permission, then
 *       writes the key and grant files used by `pull` / `run`.
 *   node scripts/testnet/subscription-keeper.mjs status
 *   node scripts/testnet/subscription-keeper.mjs revoke
 *       SUBSCRIBER: root-signed uninstallValidation.
 *   node scripts/testnet/subscription-keeper.mjs demo
 *       The full live sequence: install; pull 1 (accepted); an immediate
 *       second pull (must be refused: RateLimitPolicy); wait; pull 2; wait;
 *       an over-cap pull (must be refused: CallPolicy); pull 3; a fourth pull
 *       (must be refused: the count is used up); revoke; a pull after
 *       revocation (must be refused). Results go to
 *       scripts/testnet/runs/subscription-run.json (git-ignored; it holds
 *       only public facts — hashes, blocks, error names — so it must not
 *       live in .dev-wallet/, whose every value the secret scan treats as
 *       a secret).
 *
 * Environment: ZERODEV_PROJECT_ID (bundler
 * https://rpc.zerodev.app/api/v3/{id}/chain/11155111, never printed) or
 * BUNDLER_URL; NODE_URL (default the public Sepolia RPC). Sepolia only: the
 * script refuses any other chain id.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { ChainRegistry, HdKeyring, evmKeyProvider } from '../../packages/core/dist/index.js';
import {
  ENTRYPOINT_V07,
  KERNEL_PERMISSION_MODULES,
  NodeClient,
  SUBSCRIPTION_NATIVE,
  SmartAccountClient,
  createKernelAccountSpec,
  createSessionKeyAccount,
  decodeUint256,
  describeSubscription,
  encodeErc20BalanceOf,
  encodeFunctionCall,
  encodeKernelExecute,
  encodePermissionInstall,
  formatUtc,
  generateSessionPrivateKey,
  getUserOpHash,
  kernelSessionSpec,
  kernelSubscriptionSpec,
  nextPullAllowedAt,
  packInitCode,
  packPaymasterAndData,
  packUint128Pair,
  parseSubscription,
  permissionRevokeCall,
  prepareKernelPermissionInstall,
  readKernelPermissionState,
  readSessionSigner,
  readSubscriptionState,
  serializeSubscription,
  subscriptionPeriodCount,
  subscriptionPullCall,
  subscriptionToGrant,
  toBytes,
  toHex,
  toRpcUserOperation,
  verifyKernelDeployment,
} from '../../packages/chains-evm/dist/index.js';
import { SEPOLIA_RPC } from './config.mjs';

const SELF = fileURLToPath(import.meta.url);
const DEV = new URL('../../.dev-wallet/', import.meta.url);
const KEY_FILE = new URL('subscription-session.key', DEV);
const GRANT_FILE = new URL('subscription-grant.json', DEV);
const STATE_FILE = new URL('subscription-keeper-state.json', DEV);
// Public run record (no secrets): kept outside .dev-wallet/ so that the
// pre-commit secret scan, which treats every .dev-wallet value as a secret,
// does not flag the error names and hashes it quotes.
const RUNS_DIR = new URL('./runs/', import.meta.url);
const RUN_FILE = new URL('subscription-run.json', RUNS_DIR);

const CHAIN_ID = 11155111n;
const NODE_URL = process.env.NODE_URL ?? SEPOLIA_RPC;
const SUBSCRIBER_INDEX = 2n;
const EXPECTED_ACCOUNT = '0x1D723b78e1D0D84Fd0531e2686285fb1B6414106';
const MERCHANT_INDEX = 5;
const SEPOLIA_USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const PUBLIC_TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const BUNDLER_URL =
  process.env.BUNDLER_URL ??
  (process.env.ZERODEV_PROJECT_ID
    ? `https://rpc.zerodev.app/api/v3/${process.env.ZERODEV_PROJECT_ID}/chain/11155111`
    : undefined);
const PADDING = { verification: 120, call: 130, preVerification: 105 };

const argv = process.argv.slice(2);
const command = argv[0];
const flag = (name) => argv.includes(`--${name}`);
const option = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};

const node = async (method, params) => rawRpc(NODE_URL, method, params);
const nodeClient = new NodeClient(node);

/** Never print a bundler URL: it embeds the project id / API key. */
function mask(text) {
  let out = String(text);
  for (const secret of [process.env.ZERODEV_PROJECT_ID, BUNDLER_URL].filter(Boolean)) out = out.split(secret).join('<masked>');
  return out;
}

/** JSON-RPC that keeps error.data and non-2xx bodies (httpTransport drops both). */
async function rawRpc(url, method, params) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(mask(`HTTP ${response.status} for ${method}: ${text.slice(0, 500)}`));
  }
  if (body.error) {
    const error = new Error(
      mask(`RPC error ${body.error.code ?? '(no code)'}: ${body.error.message ?? JSON.stringify(body.error)} (${method})`),
    );
    error.data = body.error.data;
    throw error;
  }
  if (!response.ok) throw new Error(mask(`HTTP ${response.status} for ${method}`));
  return body.result;
}

function bundlerTransport() {
  if (!BUNDLER_URL) throw new Error('Set ZERODEV_PROJECT_ID (or BUNDLER_URL).');
  return (method, params) => rawRpc(BUNDLER_URL, method, params);
}

// ---------------------------------------------------------------------------
// Decoding refusals
// ---------------------------------------------------------------------------

const topic = (sig) => toHex(keccak_256(utf8ToBytes(sig)));
const errorSelector = (sig) => topic(sig).slice(0, 10);
const USER_OPERATION_EVENT = topic('UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)');
const TRANSFER_EVENT = topic('Transfer(address,address,uint256)');
const KNOWN_ERRORS = Object.fromEntries(
  [
    'FailedOp(uint256,string)',
    'FailedOpWithRevert(uint256,string,bytes)',
    // CallPolicy v0.0.4 (Sourcify full match).
    'InvalidCallType()',
    'InvalidCallData()',
    'CallViolatesParamRule()',
    'CallViolatesValueRule()',
    // Kernel v3.3.
    'InvalidValidator()',
    'InvalidNonce()',
    'PolicyFailed(uint256)',
    'SignerPrefixNotPresent()',
    'PermissionNotAlllowedForUserOp()',
    'InvalidValidationType()',
  ].map((s) => [errorSelector(s), s]),
);
/** Policy order from kernelPermissionFromGrant: [call, timestamp, gas, rateLimit]. */
const POLICY_NAMES = ['CallPolicy', 'TimestampPolicy', 'GasPolicy', 'RateLimitPolicy'];

function describeRevert(data) {
  if (typeof data !== 'string' || data.length < 10) return `revert data ${data}`;
  const sel = data.slice(0, 10).toLowerCase();
  const name = KNOWN_ERRORS[sel];
  if (!name) return `revert ${sel} (unknown selector)`;
  const body = data.slice(10);
  const word = (i) => body.slice(i * 64, i * 64 + 64);
  if (name === 'PolicyFailed(uint256)') {
    const i = Number(BigInt('0x' + word(0)));
    return `PolicyFailed(${i}) = ${POLICY_NAMES[i] ?? 'policy ' + i}`;
  }
  if (!name.startsWith('FailedOp')) return name;
  const strOffset = Number(BigInt('0x' + word(1))) / 32;
  const strLen = Number(BigInt('0x' + word(strOffset)));
  const reason = Buffer.from(body.slice((strOffset + 1) * 64, (strOffset + 1) * 64 + strLen * 2), 'hex').toString();
  let inner = '';
  if (name.startsWith('FailedOpWithRevert')) {
    const bOffset = Number(BigInt('0x' + word(2))) / 32;
    const bLen = Number(BigInt('0x' + word(bOffset)));
    const innerData = '0x' + body.slice((bOffset + 1) * 64, (bOffset + 1) * 64 + bLen * 2);
    inner = innerData === '0x' ? ' -> inner revert without data' : ` -> ${describeRevert(innerData)}`;
  }
  return `${name.split('(')[0]}("${reason}")${inner}`;
}

/** Every 0x… hex run of 8+ characters in an error message or its data, decoded where known. */
function decodeErrorText(error) {
  const parts = [];
  const candidates = [];
  if (typeof error?.data === 'string') candidates.push(error.data);
  if (error?.data && typeof error.data === 'object') candidates.push(...Object.values(error.data).filter((v) => typeof v === 'string'));
  for (const m of String(error?.message ?? error).matchAll(/0x[0-9a-fA-F]{8,}/g)) candidates.push(m[0]);
  for (const c of candidates) {
    const d = describeRevert(c);
    if (!d.includes('unknown selector') && !d.startsWith('revert data')) parts.push(d);
  }
  return [...new Set(parts)];
}

function encodeHandleOps(op, beneficiary) {
  const packed = {
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
  };
  return encodeFunctionCall(
    'handleOps((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes)[],address)',
    [{ kind: 'array', items: [packed] }, { kind: 'address', value: beneficiary }],
  );
}

function userOpEventSuccess(logs, userOpHash) {
  for (const log of logs ?? []) {
    if (log.topics?.[0]?.toLowerCase() !== USER_OPERATION_EVENT) continue;
    if (log.topics[1]?.toLowerCase() !== userOpHash.toLowerCase()) continue;
    return BigInt('0x' + log.data.slice(2 + 64, 2 + 128)) === 1n;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

function loadMnemonic() {
  return readFileSync(new URL('mnemonic.txt', DEV), 'utf8').trim();
}
function keyring(mnemonic) {
  const registry = new ChainRegistry();
  registry.register(evmKeyProvider);
  return HdKeyring.fromMnemonic(mnemonic, registry);
}
function readJson(url, fallback = null) {
  return existsSync(url) ? JSON.parse(readFileSync(url, 'utf8')) : fallback;
}
function writeJson(url, value) {
  mkdirSync(new URL('./', url), { recursive: true });
  writeFileSync(url, JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n', { mode: 0o600 });
  chmodSync(url, 0o600);
}
function loadGrantRecord() {
  const record = readJson(GRANT_FILE);
  if (!record) throw new Error('No .dev-wallet/subscription-grant.json; run `install` first.');
  return { ...record, subscription: parseSubscription(record.subscription) };
}
/** The keeper's only secret. */
function loadSessionKey() {
  const hex = readFileSync(KEY_FILE, 'utf8').trim();
  const bytes = toBytes(hex);
  try {
    return createSessionKeyAccount(bytes);
  } finally {
    bytes.fill(0);
  }
}

async function chainTime() {
  const block = await node('eth_getBlockByNumber', ['latest', false]);
  return Number(BigInt(block.timestamp));
}
async function requireSepolia() {
  const id = await nodeClient.chainId();
  if (id !== CHAIN_ID) throw new Error(`Not Sepolia: chain id ${id}`);
}
async function fees() {
  const f = await nodeClient.suggestFees();
  try {
    const price = await bundlerTransport()('pimlico_getUserOperationGasPrice', []);
    const s = price?.standard;
    if (s) {
      f.maxFeePerGas = [f.maxFeePerGas, BigInt(s.maxFeePerGas)].reduce((a, b) => (a > b ? a : b));
      f.maxPriorityFeePerGas = [f.maxPriorityFeePerGas, BigInt(s.maxPriorityFeePerGas)].reduce((a, b) => (a > b ? a : b));
    }
  } catch {
    // Not served: the node's suggestion stands; a bundler floor refusal is printed verbatim.
  }
  return f;
}

async function receiptSummary(client, userOpHash) {
  const r = await client.waitForReceipt(userOpHash, { timeoutMs: 240_000, pollMs: 4_000 });
  const success = r?.success === true || r?.success === '0x1';
  const tx = r?.receipt?.transactionHash ?? null;
  const block = r?.receipt?.blockNumber !== undefined ? Number(BigInt(r.receipt.blockNumber)) : null;
  let blockTime = null;
  if (block !== null) {
    const b = await node('eth_getBlockByNumber', ['0x' + block.toString(16), false]);
    blockTime = Number(BigInt(b.timestamp));
  }
  return { success, tx, block, blockTime, logs: r?.receipt?.logs ?? r?.logs ?? [] };
}

// ---------------------------------------------------------------------------
// SUBSCRIBER: install / revoke (owner key)
// ---------------------------------------------------------------------------

async function subscriberContext() {
  await requireSepolia();
  await verifyKernelDeployment(node);
  const keys = keyring(loadMnemonic());
  const owner = keys.getAccount('eip155:1');
  const merchant = keys.getAccount('eip155:1', 0, MERCHANT_INDEX).address;
  const rootSpec = createKernelAccountSpec({ node, index: SUBSCRIBER_INDEX });
  const account = await rootSpec.getAddress(owner);
  if (account.toLowerCase() !== EXPECTED_ACCOUNT.toLowerCase()) throw new Error(`Account ${account} is not ${EXPECTED_ACCOUNT}`);
  const code = await node('eth_getCode', [account, 'latest']);
  if (!code || code === '0x') throw new Error('The subscriber account must be deployed');
  const client = new SmartAccountClient({
    chainId: CHAIN_ID,
    entryPoint: ENTRYPOINT_V07,
    bundler: bundlerTransport(),
    node,
    spec: rootSpec,
    gasPaddingPct: PADDING,
  });
  return { owner, merchant, account, client };
}

async function install() {
  const { owner, merchant, account, client } = await subscriberContext();
  const period = Number(option('period', '120'));
  const periods = Number(option('periods', '3'));
  const now = await chainTime();
  const subscription = {
    merchant,
    token: SUBSCRIPTION_NATIVE,
    amountPerPeriod: BigInt(option('amount', '1000')),
    periodSeconds: period,
    // The first period opens shortly after the install is expected to land.
    startAt: now + Number(option('start-delay', '45')),
    validUntil: 0,
    feeBudgetWei: BigInt(option('fee-budget-wei', '9000000000000000')),
    label: 'Keeper test (native, 1000 wei)',
  };
  subscription.validUntil = subscription.startAt + period * periods;
  const sessionPrivateKey = generateSessionPrivateKey();
  const session = createSessionKeyAccount(sessionPrivateKey);
  const grant = subscriptionToGrant(subscription, session.address, { account, now });
  const description = describeSubscription(subscription, { symbol: 'test ETH', decimals: 18, nativeSymbol: 'test ETH' });
  console.log(`Subscriber ${account} (owner ${owner.address}); merchant ${merchant} (dev seed index ${MERCHANT_INDEX})`);
  console.log(`Review: ${description.sentence}`);
  for (const line of description.enforced) console.log(`  enforced: ${line}`);
  for (const line of description.caveats) console.log(`  caveat:   ${line}`);
  console.log(`Session key (address only): ${session.address}; ${subscriptionPeriodCount(subscription)} pulls`);

  const inst = await prepareKernelPermissionInstall(node, grant, { chainId: CHAIN_ID, account, now });
  const permissionId = toHex(inst.permissionId);
  // Key and public record are written BEFORE the install is submitted (the
  // app's order), so a crash can never leave a live grant without its key.
  writeFileSync(KEY_FILE, toHex(sessionPrivateKey) + '\n', { mode: 0o600 });
  chmodSync(KEY_FILE, 0o600);
  sessionPrivateKey.fill(0);
  const record = {
    chainId: CHAIN_ID.toString(),
    account,
    permissionId,
    policyCount: inst.policyCount,
    sessionKey: session.address,
    subscription: serializeSubscription(subscription),
    install: null,
    revoke: null,
  };
  writeJson(GRANT_FILE, record);
  writeJson(STATE_FILE, {});

  console.log(`Permission id ${permissionId}; install = ${inst.installCalls.length} self-calls (installValidations, grantAccess), owner-signed`);
  const f = await fees();
  const { userOpHash } = await client.sendCalls(owner, inst.installCalls, f);
  console.log(`  install accepted by the bundler: userOpHash ${userOpHash}`);
  const r = await receiptSummary(client, userOpHash);
  console.log(`  receipt: success=${r.success} tx ${r.tx} block ${r.block}`);
  record.install = { userOpHash, tx: r.tx, block: r.block, success: r.success };
  writeJson(GRANT_FILE, record);
  if (!r.success) throw new Error('Install did not succeed');
  const state = await readKernelPermissionState(node, account, inst.permissionId);
  const signer = await readSessionSigner(node, account, inst.permissionId);
  const sub = await readSubscriptionState(node, account, inst.permissionId, subscription);
  console.log(
    `  read back: installed=${state.installed} flag=0x${state.permissionFlag.toString(16).padStart(4, '0')} ` +
      `policies=[${state.policies.map((p) => p.policy).join(', ')}] sessionSigner=${signer}`,
  );
  console.log(
    `  RateLimitPolicy: status=${sub.rateLimitStatus} remaining=${sub.remainingPulls} next=${sub.nextSlotAt} ` +
      `interval=${sub.intervalSeconds}; GasPolicy budget left ${sub.feeBudgetLeftWei} wei`,
  );
  if (!state.installed || signer.toLowerCase() !== session.address.toLowerCase()) throw new Error('Read-back mismatch');
  const expectedPolicies = [
    KERNEL_PERMISSION_MODULES.callPolicy,
    KERNEL_PERMISSION_MODULES.timestampPolicy,
    KERNEL_PERMISSION_MODULES.gasPolicy,
    KERNEL_PERMISSION_MODULES.rateLimitPolicy,
  ].map((a) => a.toLowerCase());
  if (state.policies.map((p) => p.policy.toLowerCase()).join() !== expectedPolicies.join()) throw new Error('Policy list mismatch');
  return { ...record, readBack: { state, signer, subscriptionState: sub } };
}

async function revoke() {
  const { owner, account, client } = await subscriberContext();
  const record = loadGrantRecord();
  if (record.account.toLowerCase() !== account.toLowerCase()) throw new Error('Grant file is for another account');
  const f = await fees();
  const { userOpHash } = await client.sendCalls(
    owner,
    [permissionRevokeCall(account, record.permissionId, record.policyCount)],
    f,
  );
  console.log(`Revocation accepted by the bundler: userOpHash ${userOpHash}`);
  const r = await receiptSummary(client, userOpHash);
  console.log(`  receipt: success=${r.success} tx ${r.tx} block ${r.block}`);
  const state = await readKernelPermissionState(node, account, record.permissionId);
  const sub = await readSubscriptionState(node, account, record.permissionId, record.subscription);
  console.log(`  read back: installed=${state.installed} hook=${state.hook} signer=${state.signer}; RateLimitPolicy status=${sub.rateLimitStatus}`);
  const raw = readJson(GRANT_FILE);
  raw.revoke = { userOpHash, tx: r.tx, block: r.block, success: r.success, installedAfter: state.installed };
  writeJson(GRANT_FILE, raw);
  if (!r.success || state.installed) throw new Error('Revocation did not clear the permission');
  return raw.revoke;
}

// ---------------------------------------------------------------------------
// KEEPER: session key + grant only
// ---------------------------------------------------------------------------

function keeperClient(record, session, { unchecked }) {
  const spec = unchecked
    ? kernelSessionSpec({ account: record.account, sessionKey: record.sessionKey, permissionId: record.permissionId })
    : kernelSubscriptionSpec({
        account: record.account,
        sessionKey: record.sessionKey,
        permissionId: record.permissionId,
        subscription: record.subscription,
      });
  if (session.address.toLowerCase() !== record.sessionKey.toLowerCase()) throw new Error('Session key file does not match the grant');
  const bundler = bundlerTransport();
  const client = new SmartAccountClient({
    chainId: CHAIN_ID,
    entryPoint: ENTRYPOINT_V07,
    bundler,
    node,
    spec,
    gasPaddingPct: PADDING,
  });
  return { spec, client, bundler };
}

async function importHandOver() {
  await requireSepolia();
  const file = argv[1];
  if (!file || file.startsWith('--')) throw new Error('Usage: import <file with the app\'s hand-over JSON> [--force]');
  if (existsSync(KEY_FILE) && !flag('force')) throw new Error('A subscription key file already exists; pass --force to replace it.');
  const payload = JSON.parse(readFileSync(file, 'utf8'));
  if (payload?.type !== 'shiba-wallet:subscription-key' || payload.version !== 1) throw new Error('Not a subscription key hand-over (version 1)');
  if (BigInt(payload.chainId) !== CHAIN_ID) throw new Error(`Hand-over is for chain ${payload.chainId}, not Sepolia`);
  if (payload.entryPoint?.toLowerCase() !== ENTRYPOINT_V07.toLowerCase()) throw new Error('Unexpected EntryPoint');
  const subscription = parseSubscription(payload.subscription);
  const keyBytes = toBytes(payload.sessionPrivateKey);
  const session = createSessionKeyAccount(keyBytes);
  keyBytes.fill(0);
  if (session.address.toLowerCase() !== String(payload.sessionKey).toLowerCase()) throw new Error('The key does not derive to the stated session address');
  // The terms must map to the installed permission: same permission id, and
  // the account must store this session key as the permission's signer.
  const grant = subscriptionToGrant(subscription, session.address, { now: null });
  const inst = encodePermissionInstall(grant, { chainId: CHAIN_ID, account: payload.account, currentNonce: 0, validationNonce: 0, now: 0 });
  if (toHex(inst.permissionId).toLowerCase() !== String(payload.permissionId).toLowerCase()) {
    throw new Error('The terms do not produce the stated permission id');
  }
  const state = await readKernelPermissionState(node, payload.account, payload.permissionId);
  const signer = await readSessionSigner(node, payload.account, payload.permissionId);
  if (!state.installed || signer.toLowerCase() !== session.address.toLowerCase()) {
    throw new Error('The permission is not installed on-chain with this session key');
  }
  writeFileSync(KEY_FILE, String(payload.sessionPrivateKey).toLowerCase() + '\n', { mode: 0o600 });
  chmodSync(KEY_FILE, 0o600);
  writeJson(GRANT_FILE, {
    chainId: CHAIN_ID.toString(),
    account: payload.account,
    permissionId: String(payload.permissionId).toLowerCase(),
    policyCount: inst.policyCount,
    sessionKey: session.address,
    subscription: serializeSubscription(subscription),
    install: null,
    revoke: null,
  });
  const meta = await tokenMeta({ subscription });
  if (meta) writeJson(GRANT_FILE, { ...readJson(GRANT_FILE), token: meta });
  writeJson(STATE_FILE, {});
  console.log(`Imported: account ${payload.account}, permission ${payload.permissionId}, session key ${session.address}`);
  console.log(
    describeSubscription(subscription, {
      symbol: subscription.token === SUBSCRIPTION_NATIVE ? 'test ETH' : (meta?.symbol ?? 'base units'),
      decimals: subscription.token === SUBSCRIPTION_NATIVE ? 18 : (meta?.decimals ?? 0),
    }).sentence,
  );
}

/** Exact decimal rendering of base units (no floats). */
function formatBaseUnits(amount, decimals) {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  if (decimals === 0) return `${negative ? '-' : ''}${abs}`;
  const unit = 10n ** BigInt(decimals);
  const frac = (abs % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${abs / unit}${frac ? `.${frac}` : ''}`;
}

/**
 * The payment token's symbol and decimals: from the grant file when the
 * import stored them, else read from the token contract (symbol() and
 * decimals(); the symbol is shown only if it is short printable ASCII).
 * Null for a native subscription or when the reads fail.
 */
async function tokenMeta(record) {
  const sub = record.subscription;
  if (sub.token === SUBSCRIPTION_NATIVE) return null;
  if (record.token && typeof record.token.symbol === 'string' && Number.isInteger(record.token.decimals)) return record.token;
  try {
    const call = async (signature) =>
      node('eth_call', [{ to: sub.token, data: toHex(encodeFunctionCall(signature, [])) }, 'latest']);
    const decimals = Number(decodeUint256(await call('decimals()')));
    const raw = String(await call('symbol()'));
    // ABI string: offset, length, bytes.
    const len = Number(BigInt('0x' + raw.slice(2 + 64, 2 + 128)));
    const text = Buffer.from(raw.slice(2 + 128, 2 + 128 + len * 2), 'hex').toString('utf8');
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
    return { symbol: /^[\x20-\x7e]{1,16}$/.test(text) ? text : 'tokens', decimals };
  } catch {
    return null;
  }
}

/** "0.1 USDC (100000 base units)", "1000 wei", or "100000 base units" when the token is unknown. */
function describeAmount(amount, sub, meta) {
  if (sub.token === SUBSCRIPTION_NATIVE) return `${amount} wei`;
  return meta ? `${formatBaseUnits(amount, meta.decimals)} ${meta.symbol} (${amount} base units)` : `${amount} base units`;
}

/** The merchant's balance of what the subscription pays (ETH, or the token's balanceOf), at `block`. */
async function merchantHolding(sub, block = 'latest') {
  if (sub.token === SUBSCRIPTION_NATIVE) return BigInt(await node('eth_getBalance', [sub.merchant, block]));
  return decodeUint256(await node('eth_call', [{ to: sub.token, data: toHex(encodeErc20BalanceOf(sub.merchant)) }, block]));
}

async function status() {
  const record = loadGrantRecord();
  const s = await readSubscriptionState(node, record.account, record.permissionId, record.subscription);
  const now = await chainTime();
  const next = nextPullAllowedAt(s, now);
  console.log(JSON.stringify({ now, state: s, next }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  return { now, state: s, next };
}

/**
 * One pull attempt. Prints `RESULT {json}` for the demo orchestrator.
 * Outcomes: accepted (included, success), reverted (included, failed),
 * rejected (refused by the bundler before inclusion), refused-locally.
 */
async function pull({ amount, unchecked, batch }) {
  await requireSepolia();
  const record = loadGrantRecord();
  const session = loadSessionKey();
  const { spec, client, bundler } = keeperClient(record, session, { unchecked });
  const sub = record.subscription;
  const one = subscriptionPullCall(sub, amount ?? sub.amountPerPeriod);
  const calls = Array.from({ length: batch ?? 1 }, () => one);
  const now = await chainTime();
  const before = await readSubscriptionState(node, record.account, record.permissionId, sub).catch((e) => ({ error: e.message }));
  const meta = await tokenMeta(record);
  const label = `pull of ${describeAmount(amount ?? sub.amountPerPeriod, sub, meta)}${
    batch > 1 ? ` x${batch} (batch)` : ''
  }${unchecked ? ' [local checks skipped]' : ''}`;
  console.log(`Keeper: ${label} at chain time ${now} (${formatUtc(now)})`);
  const next = before.error ? null : nextPullAllowedAt(before, now);
  if (next) console.log(`  before: next pull ${JSON.stringify(next)}`);
  const result = { label, chainTime: now, before: before.error ? before : { ...before, feeBudgetLeftWei: String(before.feeBudgetLeftWei) } };
  // Local refusal of a pull the account would refuse anyway (2026-10-04
  // emulator run, finding 9): without --unchecked an early pull — or one
  // after the count is used up, the end, or a revocation — is refused here
  // from the on-chain state, before anything is signed or sent.
  if (!unchecked && (!next || next.kind !== 'now')) {
    result.outcome = 'refused-locally';
    result.reason = !next
      ? `the on-chain subscription state could not be read (${before.error}), so the pull was not attempted`
      : next.kind === 'later'
        ? `too early: the next payment opens at ${next.at} (${formatUtc(next.at)}), chain time is ${now}`
        : `no payment is open (${next.kind})`;
    console.log(`  REFUSED LOCALLY (nothing signed): ${result.reason}. Pass --unchecked to let the account refuse it.`);
    return emit(result);
  }
  const merchantBefore = await merchantHolding(sub);
  const f = await fees();
  let userOpHash;
  let stage = 'estimate';
  try {
    if (!unchecked) {
      // Local refusal first (kernelSubscriptionSpec checks again before signing).
      try {
        spec.encodeCalls(calls);
      } catch (e) {
        result.outcome = 'refused-locally';
        result.reason = e.message;
        console.log(`  REFUSED LOCALLY (nothing signed): ${e.message}`);
        return emit(result);
      }
    }
    const sent = await client.sendCalls(session, calls, f);
    userOpHash = sent.userOpHash;
    stage = 'receipt';
    saveGas(sent.userOp);
  } catch (error) {
    // Which bundler call refused: the client's error text names the method.
    stage = /eth_sendUserOperation/.test(error.message)
      ? 'submission (eth_sendUserOperation; the gas estimate had passed)'
      : /eth_estimateUserOperationGas/.test(error.message)
        ? 'estimate (eth_estimateUserOperationGas)'
        : 'before submission';
    result.outcome = 'rejected';
    result.stage = stage;
    result.reason = error.message;
    result.decoded = decodeErrorText(error);
    console.log(`  REJECTED at ${stage}: ${error.message}`);
    for (const d of result.decoded) console.log(`    decoded: ${d}`);
    // The estimate refused: also submit a fully signed op with the last
    // accepted gas limits, so the refusal at submission (and the on-chain
    // reason from a handleOps eth_call) is recorded too.
    const gas = readJson(STATE_FILE, {}).gas;
    if (gas && !stage.startsWith('submission')) {
      const direct = await directSubmission(record, spec, session, calls, f, gas, bundler);
      result.direct = direct;
      if (direct.userOpHash) userOpHash = direct.userOpHash;
    }
    if (!userOpHash) return emit(result);
  }
  console.log(`  accepted by the bundler: userOpHash ${userOpHash}`);
  result.userOpHash = userOpHash;
  const r = await receiptSummary(client, userOpHash);
  result.outcome = r.success ? 'accepted' : 'reverted';
  Object.assign(result, { tx: r.tx, block: r.block, blockTime: r.blockTime });
  const merchantAfter = await merchantHolding(sub, r.block !== null ? '0x' + r.block.toString(16) : 'latest');
  const delta = merchantAfter - merchantBefore;
  // Native pulls keep the old field name; ERC-20 pulls report the merchant's
  // TOKEN balance change (its ETH does not move in a token pull).
  if (sub.token === SUBSCRIPTION_NATIVE) result.merchantDeltaWei = delta.toString();
  else result.merchantDeltaBaseUnits = delta.toString();
  const after = await readSubscriptionState(node, record.account, record.permissionId, sub);
  result.after = { ...after, feeBudgetLeftWei: String(after.feeBudgetLeftWei) };
  console.log(
    `  receipt: success=${r.success} tx ${r.tx} block ${r.block} (block time ${r.blockTime}); merchant ${delta >= 0n ? '+' : ''}${describeAmount(delta, sub, meta)}; ` +
      `after: remaining ${after.remainingPulls}, next slot ${after.nextSlotAt}, fee budget left ${after.feeBudgetLeftWei} wei`,
  );
  return emit(result);
}

function saveGas(op) {
  const state = readJson(STATE_FILE, {});
  state.gas = {
    callGasLimit: op.callGasLimit.toString(),
    verificationGasLimit: op.verificationGasLimit.toString(),
    preVerificationGas: op.preVerificationGas.toString(),
  };
  writeJson(STATE_FILE, state);
}

/** Signs and submits directly (bypassing estimation) with known-good gas limits; records the bundler's answer. */
async function directSubmission(record, spec, session, calls, f, gas, bundler) {
  const nonceKey = spec.getNonceKey();
  const nonceWord = await node('eth_call', [
    {
      to: ENTRYPOINT_V07,
      data: toHex(
        encodeFunctionCall('getNonce(address,uint192)', [
          { kind: 'address', value: record.account },
          { kind: 'uint256', value: nonceKey },
        ]),
      ),
    },
    'latest',
  ]);
  const op = {
    sender: record.account,
    nonce: BigInt(nonceWord),
    callData: encodeKernelExecute(calls),
    callGasLimit: BigInt(gas.callGasLimit),
    verificationGasLimit: BigInt(gas.verificationGasLimit),
    preVerificationGas: BigInt(gas.preVerificationGas),
    maxFeePerGas: f.maxFeePerGas,
    maxPriorityFeePerGas: f.maxPriorityFeePerGas,
    signature: new Uint8Array(0),
  };
  op.signature = spec.signUserOpHash(session, getUserOpHash(op, ENTRYPOINT_V07, CHAIN_ID));
  const out = {};
  // The on-chain reason, from a read-only handleOps simulation.
  try {
    await node('eth_call', [{ from: record.sessionKey, to: ENTRYPOINT_V07, data: toHex(encodeHandleOps(op, record.sessionKey)), gas: '0x989680' }, 'latest']);
    out.simulation = 'handleOps eth_call succeeded';
  } catch (error) {
    out.simulation = describeRevert(error.data ?? (/(0x[0-9a-fA-F]{8,})/.exec(error.message) ?? [])[1]);
  }
  console.log(`    handleOps simulation: ${out.simulation}`);
  try {
    out.userOpHash = await bundler('eth_sendUserOperation', [toRpcUserOperation(op), ENTRYPOINT_V07]);
    out.submission = 'ACCEPTED by the bundler';
    console.log(`    direct submission ACCEPTED by the bundler: ${out.userOpHash}`);
  } catch (error) {
    out.submission = error.message;
    out.decoded = decodeErrorText(error);
    console.log(`    direct submission REJECTED: ${error.message}`);
  }
  return out;
}

function emit(result) {
  console.log(`RESULT ${JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
  return result;
}

async function run({ once }) {
  for (;;) {
    const record = loadGrantRecord();
    const s = await readSubscriptionState(node, record.account, record.permissionId, record.subscription);
    const now = await chainTime();
    const next = nextPullAllowedAt(s, now);
    console.log(`Keeper: ${JSON.stringify(next)}`);
    if (next.kind === 'now') {
      await pull({});
      if (once) return;
      continue;
    }
    if (next.kind !== 'later' || once) return;
    const waitMs = (next.at - now + 3) * 1000;
    console.log(`  next pull opens at ${next.at} (${formatUtc(next.at)}); sleeping ${Math.round(waitMs / 1000)} s (Ctrl-C to stop)`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

// ---------------------------------------------------------------------------
// DEMO orchestrator (subscriber steps in-process; keeper steps as children)
// ---------------------------------------------------------------------------

function keeperStep(args) {
  // The child gets ONLY what a keeper needs: the bundler credentials and RPC.
  const env = { PATH: process.env.PATH, ...(process.env.ZERODEV_PROJECT_ID ? { ZERODEV_PROJECT_ID: process.env.ZERODEV_PROJECT_ID } : {}) };
  if (process.env.BUNDLER_URL) env.BUNDLER_URL = process.env.BUNDLER_URL;
  if (process.env.NODE_URL) env.NODE_URL = process.env.NODE_URL;
  const child = spawnSync(process.execPath, [SELF, ...args], { env, encoding: 'utf8', timeout: 600_000 });
  process.stdout.write(child.stdout ?? '');
  process.stderr.write(child.stderr ?? '');
  const line = (child.stdout ?? '').split('\n').find((l) => l.startsWith('RESULT '));
  if (!line) throw new Error(`Keeper step ${args.join(' ')} produced no RESULT (exit ${child.status})`);
  return JSON.parse(line.slice(7));
}

async function waitUntil(t, why) {
  for (;;) {
    const now = await chainTime();
    if (now >= t) return now;
    const s = Math.min(t - now + 2, 30);
    console.log(`  waiting for ${why}: chain time ${now}, target ${t} (${t - now} s)`);
    await new Promise((r) => setTimeout(r, s * 1000));
  }
}

async function demo() {
  const run = { startedAt: new Date().toISOString(), steps: [] };
  const record = (name, expected, result) => {
    const ok = expected === 'accepted' ? result.outcome === 'accepted' : result.outcome === 'rejected' || result.outcome === 'refused-locally';
    run.steps.push({ name, expected, ok, ...result });
    writeJson(RUN_FILE, run);
    console.log(`\n==> ${ok ? 'AS EXPECTED' : 'UNEXPECTED'}: ${name} (expected ${expected}, got ${result.outcome})\n`);
    return ok;
  };
  console.log('== SUBSCRIBER: install (owner-signed, explicit) ==');
  const inst = await install();
  run.install = { ...inst.install, permissionId: inst.permissionId, sessionKey: inst.sessionKey, account: inst.account, subscription: inst.subscription };
  writeJson(RUN_FILE, run);
  const sub = parseSubscription(inst.subscription);
  const S = sub.startAt;
  const P = sub.periodSeconds;

  console.log('\n== KEEPER: period 1 ==');
  await waitUntil(S, 'period 1');
  record('period 1 pull', 'accepted', keeperStep(['pull']));
  console.log('== KEEPER: immediate second pull in period 1 (local check skipped; RateLimitPolicy must refuse) ==');
  const second = keeperStep(['pull', '--unchecked']);
  const secondOk = record('second pull in the same period', 'rejected', second);
  if (!secondOk && second.outcome === 'accepted') {
    console.log(`NOTE: the bundler accepted the early op; included in block ${second.block} at ${second.blockTime} (slot 2 opens ${S + P}).`);
  }

  console.log('\n== KEEPER: period 2 ==');
  await waitUntil(S + P, 'period 2');
  if (!(second.outcome === 'accepted')) record('period 2 pull', 'accepted', keeperStep(['pull']));

  console.log('\n== KEEPER: period 3 — over-cap first (local check skipped; CallPolicy must refuse) ==');
  await waitUntil(S + 2 * P, 'period 3');
  record('over-cap pull (amount + 1)', 'rejected', keeperStep(['pull', '--unchecked', '--amount', String(sub.amountPerPeriod + 1n)]));
  record('period 3 pull', 'accepted', keeperStep(['pull']));
  record('fourth pull (count used up)', 'rejected', keeperStep(['pull', '--unchecked']));

  console.log('\n== SUBSCRIBER: revoke (owner-signed) ==');
  run.revoke = await revoke();
  writeJson(RUN_FILE, run);
  console.log('\n== KEEPER after revocation ==');
  record('pull after revocation', 'rejected', keeperStep(['pull', '--unchecked']));
  run.finishedAt = new Date().toISOString();
  writeJson(RUN_FILE, run);
  const bad = run.steps.filter((s) => !s.ok);
  console.log(`\nDEMO ${bad.length === 0 ? 'PASSED' : 'FINISHED WITH UNEXPECTED STEPS: ' + bad.map((s) => s.name).join(', ')}`);
  console.log('Results: scripts/testnet/runs/subscription-run.json');
  if (bad.length) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// DRY RUN (eth_simulateV1, public test mnemonic, USDC via state override)
// ---------------------------------------------------------------------------

async function dryRun() {
  await requireSepolia();
  const keys = keyring(PUBLIC_TEST_MNEMONIC);
  const owner = keys.getAccount('eip155:1');
  const merchant = keys.getAccount('eip155:1', 0, MERCHANT_INDEX).address;
  const other = keys.getAccount('eip155:1', 0, 6).address;
  const rootSpec = createKernelAccountSpec({ node, index: 0n });
  const account = await rootSpec.getAddress(owner);
  const code = await node('eth_getCode', [account, 'latest']);
  if (code !== '0x') throw new Error('The dry run expects the public-mnemonic Kernel account to be undeployed');
  const latest = await chainTime();
  const MONTH = 2_592_000;
  const T0 = latest + 12;
  const S = T0 + 12;
  const session = createSessionKeyAccount(generateSessionPrivateKey());
  const sub = {
    merchant,
    token: SEPOLIA_USDC,
    amountPerPeriod: 5_000_000n,
    periodSeconds: MONTH,
    startAt: S,
    validUntil: S + 3 * MONTH,
    feeBudgetWei: 20_000_000_000_000_000n,
    label: 'Dry run (5 USDC / 30 days)',
  };
  const grant = subscriptionToGrant(sub, session.address, { account, now: latest });
  const d = describeSubscription(sub, { symbol: 'USDC', decimals: 6, nativeSymbol: 'test ETH' });
  console.log(`DRY RUN. Account ${account} (public test mnemonic, undeployed); merchant ${merchant}`);
  console.log(`Review: ${d.sentence}`);
  const inst = encodePermissionInstall(grant, { chainId: CHAIN_ID, account, currentNonce: 1, validationNonce: 0, now: latest });
  console.log(`Permission id ${toHex(inst.permissionId)}`);

  const gas = {
    callGasLimit: 3_000_000n,
    verificationGasLimit: 1_500_000n,
    preVerificationGas: 100_000n,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  };
  const subGas = { ...gas, verificationGasLimit: 600_000n, callGasLimit: 150_000n };
  const sign = (op, signer, spec) => ({ ...op, signature: spec.signUserOpHash(signer, getUserOpHash(op, ENTRYPOINT_V07, CHAIN_ID)) });
  const factory = await rootSpec.getFactoryArgs(owner);
  const raw = kernelSessionSpec({ account, sessionKey: session.address, permissionId: inst.permissionId });
  let seq = 0n;
  const sessionOp = (calls) => sign({ sender: account, nonce: (raw.nonceKey << 64n) + seq, callData: encodeKernelExecute(calls), ...subGas }, session, raw);
  const pullCall = (amount = sub.amountPerPeriod, to = merchant) =>
    subscriptionPullCall({ ...sub, merchant: to }, amount);

  // [name, block time, op builder, expect accepted?] — sequence numbers only
  // advance for operations expected to be included.
  const steps = [];
  steps.push(['deploy + explicit install (root)', T0, () => sign({ sender: account, nonce: 0n, ...factory, callData: encodeKernelExecute(inst.installCalls), ...gas }, owner, rootSpec), true]);
  steps.push(['pull 1 at the period start', S, () => sessionOp([pullCall()]), true]);
  steps.push(['second pull 5 s later (same period)', S + 5, () => sessionOp([pullCall()]), false]);
  steps.push(['over-cap pull (5.000001 USDC) in period 2', S + MONTH, () => sessionOp([pullCall(5_000_001n)]), false]);
  steps.push(['RESIDUAL: batch of two 5 USDC transfers in ONE operation, period 2', S + MONTH + 1, () => sessionOp([pullCall(), pullCall()]), true]);
  steps.push(['pull to another recipient in period 3', S + 2 * MONTH, () => sessionOp([pullCall(sub.amountPerPeriod, other)]), false]);
  steps.push(['pull 3', S + 2 * MONTH + 1, () => sessionOp([pullCall()]), true]);
  steps.push(['fourth pull (count used up)', S + 2 * MONTH + 2, () => sessionOp([pullCall(1n)]), false]);
  steps.push(['revoke (root)', S + 2 * MONTH + 3, () => sign({ sender: account, nonce: 1n, callData: encodeKernelExecute([permissionRevokeCall(account, inst.permissionId, inst.policyCount)]), ...gas }, owner, rootSpec), true]);
  steps.push(['pull after revocation', S + 2 * MONTH + 4, () => sessionOp([pullCall(1n)]), false]);

  const from = owner.address;
  // FiatTokenV2_2 balanceAndBlacklistStates: mapping at storage slot 9
  // (verified below by balanceOf inside the same simulation).
  const usdcSlot = toHex(keccak_256(toBytes('0x' + account.slice(2).toLowerCase().padStart(64, '0') + '9'.padStart(64, '0'))));
  const blockStateCalls = [];
  const ops = [];
  for (const [i, [name, time, build, expectOk]] of steps.entries()) {
    const op = build();
    ops.push(op);
    if (expectOk && name !== 'deploy + explicit install (root)' && !name.startsWith('revoke')) seq += 1n;
    blockStateCalls.push({
      blockOverrides: { time: '0x' + time.toString(16) },
      ...(i === 0
        ? {
            stateOverrides: {
              [account]: { balance: '0xde0b6b3a7640000' },
              [from]: { balance: '0xde0b6b3a7640000' },
              [SEPOLIA_USDC]: { stateDiff: { [usdcSlot]: '0x' + (100_000_000n).toString(16).padStart(64, '0') } },
            },
          }
        : {}),
      calls: [
        ...(i === 0
          ? [{ from, to: SEPOLIA_USDC, data: toHex(encodeFunctionCall('balanceOf(address)', [{ kind: 'address', value: account }])) }]
          : []),
        { from, to: ENTRYPOINT_V07, data: toHex(encodeHandleOps(op, from)), gas: '0x1c9c380' },
        { from, to: SEPOLIA_USDC, data: toHex(encodeFunctionCall('balanceOf(address)', [{ kind: 'address', value: merchant }])) },
      ],
    });
  }
  const result = await node('eth_simulateV1', [{ blockStateCalls }, 'latest']);
  const seeded = BigInt(result[0].calls[0].returnData);
  console.log(`USDC balance of the account after the state override: ${seeded} (expected 100000000)`);
  let failed = seeded !== 100_000_000n;
  steps.forEach(([name, time, , expectOk], i) => {
    const calls = result[i].calls;
    const call = calls[i === 0 ? 1 : 0];
    const hash = toHex(getUserOpHash(ops[i], ENTRYPOINT_V07, CHAIN_ID));
    const executed = call.status === '0x1' ? userOpEventSuccess(call.logs, hash) : null;
    const accepted = call.status === '0x1' && executed === true;
    const transfers = (call.logs ?? []).filter((l) => l.topics?.[0]?.toLowerCase() === TRANSFER_EVENT).length;
    const merchantUsdc = BigInt(calls[calls.length - 1].returnData);
    const detail = call.status === '0x1' ? `UserOperationEvent success=${executed}, ${transfers} Transfer log(s)` : describeRevert(call.error?.data ?? call.returnData);
    const ok = accepted === expectOk;
    if (!ok) failed = true;
    console.log(`${ok ? 'PASS' : 'FAIL'} [t=${time - S >= 0 ? 'S+' + (time - S) : 'S' + (time - S)}] ${name}: ${accepted ? 'accepted' : 'rejected'} (${detail}); merchant USDC ${merchantUsdc}`);
  });
  if (failed) throw new Error('Dry run expectations not met');
  console.log('\nDRY RUN PASSED. Note the RESIDUAL step: the account accepted two in-cap transfers in one operation');
  console.log('(10 USDC in one period under a 5 USDC cap). Nothing was broadcast.');
}

// ---------------------------------------------------------------------------

const commands = {
  'dry-run': dryRun,
  install,
  import: importHandOver,
  revoke,
  status,
  pull: () =>
    pull({
      amount: option('amount') !== undefined ? BigInt(option('amount')) : undefined,
      unchecked: flag('unchecked'),
      batch: Number(option('batch', '1')),
    }),
  run: () => run({ once: flag('once') }),
  demo,
};
if (!commands[command]) {
  console.error(`Usage: node scripts/testnet/subscription-keeper.mjs <${Object.keys(commands).join('|')}> [options]`);
  process.exit(2);
}
commands[command]().catch((error) => {
  console.error(`FAILED: ${mask(error.message)}`);
  process.exit(1);
});
