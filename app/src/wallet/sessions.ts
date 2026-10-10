import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ENTRYPOINT_V07,
  KERNEL_PERMISSION_MODULES,
  NodeClient,
  SmartAccountClient,
  assertCallsAllowed,
  createSessionKeyAccount,
  generateSessionPrivateKey,
  grantToErc7715Request,
  kernelSessionSpec,
  parseSessionKeyGrant,
  permissionRevokeCall,
  permissionValidationId,
  prepareKernelPermissionInstall,
  readDelegationStatus,
  readKernelPermissionState,
  readSessionSigner,
  selector as abiSelector,
  serializeSessionKeyGrant,
  sessionNonceKey,
  parseSubscription,
  subscriptionMatchesGrant,
  toBytes,
  toHex,
  validateSessionKeyGrant,
  type Call,
  type Erc7715PermissionRequest,
  type JsonRpcTransport,
  type KernelPermissionInstall,
  type SerializedSessionKeyGrant,
  type SerializedSubscriptionGrant,
  type SessionAllowedCall,
  type SessionKeyGrant,
  type SubscriptionGrant,
} from '@shiba-wallet/chains-evm';
import { toChecksumAddress, type DerivedAccount } from '@shiba-wallet/core';
// Explicit .ts extensions: this module is imported by scripts/check-sessions.mjs
// under Node's type stripping, which resolves relative specifiers literally.
import {
  bundlerFeeFloor,
  describeAaError,
  paymasterProbeTransport,
  prepareAaCalls,
  quoteFeesOverFloor,
  retitleQuoteFailure,
  type AaAccountType,
  type TransportFactory,
  resolveAaSender,
  summarizeAaReceipt,
  type AaClientBundle,
  type AaReceiptSummary,
  type AaSendQuote,
  AA_DEPOSIT_TOPUP_VERIFICATION_GAS,
  MULTISIG_CONFIG_BUNDLE_REFUSAL,
} from './aa.ts';
import { formatUnits, parseUnits } from './balances.ts';
import { readAtInclusionBlock } from './recovery.ts';
import { WALLET_7702_DELEGATE } from './delegation.ts';
import { EVM_CHAIN_ID, validateRecipient } from './send.ts';
import type { KeyValueStore } from './tokens.ts';
import { assertFeatureAllowed, eip155Caip2 } from '../config/readiness.ts';
import { NO_ANSWER_SENTENCE, isEndpointFailure, sanitizeEndpointMessage } from '../config/endpoint-probe.ts';
import { suggestFeesRetryingOnce } from './fee-read.ts';

/**
 * Session keys for the app (phase 8 item 2, app half), on the engine's
 * Kernel v3.3 permission support (packages/chains-evm/src/kernel-permissions.ts,
 * whose header lists every source; AGENTS.md phase 8 records the live
 * Sepolia proof: install, use, rejection of disallowed calls, revocation).
 *
 * WHAT A SESSION IS. A fresh secp256k1 key that may sign UserOperations for
 * an already-deployed Kernel account (a factory-deployed Kernel v3.3 account,
 * or the user's own EOA upgraded to Kernel v3.3 with EIP-7702), but only
 * within limits the ACCOUNT enforces on-chain: an allowlist of (target,
 * function selector, per-call value cap) entries (CallPolicy), a mandatory
 * validity window (TimestampPolicy) and an optional total gas budget
 * (GasPolicy). The seed-derived owner stays the root validator (ADR D1).
 *
 * KEY STORAGE (non-custodial invariant, see ./storage.ts). Session private
 * keys are generated on the device with the engine's
 * generateSessionPrivateKey (noble's CSPRNG-backed randomSecretKey) and
 * persisted ONLY through a SessionKeyVault — in the app that is
 * storage.ts sessionKeyVault, i.e. expo-secure-store with the same
 * WHEN_UNLOCKED_THIS_DEVICE_ONLY accessibility as the mnemonic — under one
 * entry per account + chain + permission id. Everything else about a session
 * (the serialized grant, which contains only the session key's ADDRESS, the
 * permission id, a label, the creation time, the install mode) is public
 * data and lives in AsyncStorage under SESSIONS_KEY. No function here ever
 * writes key material to the KeyValueStore. This module never imports
 * ./storage.ts or expo-secure-store itself (so Node can load it for
 * scripts/check-sessions.mjs); callers inject the vault.
 *
 * KEY USE. A session key signs only through sendSessionCalls, which builds
 * the engine's kernelSessionSpec (it refuses any signer but the session key,
 * checks every call against the grant before signing, and routes the nonce
 * to the permission's nonce key) and a SmartAccountClient of its own. The
 * owner key is never involved: this module has no access to the mnemonic or
 * to WalletContext.signWith. Calls outside the grant are refused locally
 * BEFORE any network request or vault read.
 *
 * INSTALL MODE. Only the explicit, root-signed install is used: the
 * engine's installCalls (installValidations + grantAccess as self-calls)
 * go through the normal smart-account confirm (prepareAaCalls → bundler
 * estimate → biometric gate → sendAa), so the grant is live on-chain before
 * any session operation. Enable mode is NOT used in this slice: an enable
 * signature that was never used cannot be cancelled before its expiry (the
 * engine's caveat, AGENTS.md phase 8 item 2).
 *
 * REVOCATION. permissionRevokeCall (uninstallValidation with policyCount + 1
 * empty deinit entries) through the same root-signed confirm; once the
 * bundler accepted it, the session key is deleted from the vault and the
 * record is marked revoked. A revoked permission id can never be reused
 * (the pinned policies keep a Deprecated status), so every grant uses a
 * fresh session key.
 *
 * WHAT DOES NOT SURVIVE A WIPE OR RESTORE. Grants live on-chain, but this
 * list and the session keys exist only on this device. After a wipe or a
 * restore from the recovery phrase the wallet no longer knows about them;
 * they stay active until they expire or are revoked (SESSIONS_WIPE_WARNING).
 */

export const SESSIONS_KEY = 'shiba-wallet.sessions.v1';
const STORE_VERSION = 1;

/** Secure storage for session private keys (storage.ts provides the app's). */
export interface SessionKeyVault {
  save(id: string, privateKeyHex: string): Promise<void>;
  load(id: string): Promise<string | null>;
  remove(id: string): Promise<void>;
}

/** Expiry choices offered by the grant form (the window is mandatory). */
export const SESSION_EXPIRY_PRESETS: readonly { label: string; seconds: number }[] = [
  { label: '10 minutes', seconds: 600 },
  { label: '1 hour', seconds: 3600 },
  { label: '24 hours', seconds: 86400 },
];

export const SESSIONS_WIPE_WARNING =
  'Sessions are enforced by your account on-chain, but this list and the session keys exist only ' +
  'on this device. Wiping the wallet or restoring it from the recovery phrase loses both, while ' +
  'the grants stay active on-chain until they expire. Revoke sessions you no longer need before ' +
  'wiping, and revoke everything you no longer recognise.';

export const SESSIONS_INSTALL_MODE_NOTE =
  'Installed with an ordinary operation signed by your account key, so the permission is live ' +
  'on-chain before the session key signs anything. (The alternative "enable mode" signature is ' +
  'not used: an unused enable signature cannot be cancelled before it expires.)';

export const SESSIONS_AUDIT_NOTE =
  'The session permission modules (ZeroDev ECDSASigner, CallPolicy v0.0.4, TimestampPolicy, ' +
  'GasPolicy) have no published security audit that names them. Treat sessions as experimental ' +
  'with real funds.';

export const SESSION_SIMPLE_REFUSAL =
  'Sessions need a Kernel v3.3 account: this network’s smart-account type is SimpleAccount, which ' +
  'has no permission system. Choose Kernel v3.3 in Settings → Account Abstraction, or upgrade this ' +
  'account (EIP-7702).';

export const SESSION_UNDEPLOYED_REFUSAL =
  'Your Kernel smart account is not deployed yet. Permissions are installed into the account’s ' +
  'code, so send one smart-account transaction first (it deploys the account), then grant a session.';

export const SESSION_NOT_UPGRADED_REFUSAL =
  'This account is set to use its EIP-7702 upgrade, but the upgrade is not active on-chain yet. ' +
  'Finish the upgrade first (Upgrade this account), then grant a session.';

export type SessionAccountKind = 'kernel-v3.3' | 'kernel-7702';

/**
 * Where a session came from: the manual grant form, a dApp's ERC-7715
 * request, the subscription template (./subscriptions.ts), or a recurring
 * payment (./recurring.ts): the same grant template as a subscription, but
 * its key never leaves this device and the wallet itself sends each payment
 * after the user confirms it.
 */
export type SessionSource = 'manual' | 'erc7715' | 'subscription' | 'recurring';

/**
 * True for the sources whose record carries subscription terms
 * (SessionSubscriptionMeta): subscriptions and recurring payments. Both use
 * the engine's subscription grant template.
 */
export function sessionCarriesTerms(source: SessionSource): boolean {
  return source === 'subscription' || source === 'recurring';
}

/**
 * Subscription terms stored with a session record (source 'subscription').
 * Public data only. On every load the terms are re-parsed and must map to
 * exactly the record's grant (engine subscriptionMatchesGrant), so the
 * stored description can never disagree with what is installed.
 */
export interface SessionSubscriptionMeta {
  terms: SerializedSubscriptionGrant;
  /** Display symbol and decimals of the token (or the native currency). */
  tokenSymbol: string;
  tokenDecimals: number;
  /**
   * Date.now() when the subscriber confirmed handing the key to the merchant
   * (the key was deleted from this device at that moment), or null while the
   * key is still on this device waiting to be exported.
   */
  keyExportedAt: number | null;
}

/**
 * Local lifecycle (the on-chain status is read separately, see
 * readSessionStatus): installing = saved, install op not yet confirmed;
 * installed = install op succeeded and the state was read back; failed =
 * the install op was refused or reverted; revoking = revoke op accepted by
 * the bundler (key already deleted); revoked = revocation confirmed.
 */
export type SessionLocalStatus = 'installing' | 'installed' | 'failed' | 'revoking' | 'revoked';

export interface SessionRecord {
  /** CAIP-2 chain, e.g. eip155:11155111. */
  chain: string;
  /** The Kernel account the permission lives in (smart account or upgraded EOA). */
  account: string;
  /** The seed-derived owner EOA whose key installs and revokes. */
  owner: string;
  accountIndex: number;
  accountKind: SessionAccountKind;
  /** 0x + 8 hex characters. */
  permissionId: string;
  /** Number of policies (revocation needs policyCount + 1 deinit entries). */
  policyCount: number;
  /** The grant; contains the session key's ADDRESS only. */
  grant: SerializedSessionKeyGrant;
  /** dApp name, or "Manual". */
  label: string;
  source: SessionSource;
  /** The dApp's URL for ERC-7715 sessions (display only, unverified). */
  dappUrl: string | null;
  /** Date.now() when the grant was created. */
  createdAt: number;
  /** Always 'explicit' in this slice (see the module header). */
  installMode: 'explicit';
  /** True when the session's private key is in the vault (manual grants). */
  keyHeld: boolean;
  installUserOpHash: string | null;
  revokeUserOpHash: string | null;
  localStatus: SessionLocalStatus;
  /** Present exactly when source is 'subscription' or 'recurring' (sessionCarriesTerms). */
  subscription?: SessionSubscriptionMeta | null;
}

export interface SessionListLoad {
  records: SessionRecord[];
  /** True when stored data could not be fully read (some or all records dropped). */
  corrupt: boolean;
  /**
   * True when the whole list is unreadable (bad JSON or an unknown format).
   * Writes are refused in that state, so an unreadable list is never
   * silently overwritten; resetSessions clears it explicitly.
   */
  unreadable: boolean;
}

const LOCAL_STATUSES: readonly SessionLocalStatus[] = ['installing', 'installed', 'failed', 'revoking', 'revoked'];
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const PERMISSION_ID = /^0x[0-9a-fA-F]{8}$/;
const USEROP_HASH = /^0x[0-9a-fA-F]{64}$/;

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function eip155Decimal(chain: string): bigint {
  const match = /^eip155:([1-9][0-9]*)$/.exec(chain);
  if (!match) throw new Error(`Not an EVM chain id: ${chain}`);
  return BigInt(match[1]!);
}

/** Record key: one record per chain + account + permission id. */
export function sessionRecordKey(chain: string, account: string, permissionId: string): string {
  return `${chain}|${account.toLowerCase()}|${permissionId.toLowerCase()}`;
}

/**
 * The vault entry id for one session key: "<chain decimal>.<account>.<pid>"
 * (expo-secure-store keys may contain only alphanumerics, ".", "-" and "_",
 * per the installed expo-secure-store 57.0.4 SecureStore.d.ts, so the CAIP-2
 * colon is not used).
 */
export function sessionVaultId(chain: string, account: string, permissionId: string): string {
  return `${eip155Decimal(chain).toString()}.${account.toLowerCase()}.${permissionId.toLowerCase().replace(/^0x/, '')}`;
}

function reviveRecord(value: unknown): SessionRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  try {
    if (typeof v.chain !== 'string') return null;
    eip155Decimal(v.chain);
    if (typeof v.account !== 'string' || !ADDRESS.test(v.account)) return null;
    if (typeof v.owner !== 'string' || !ADDRESS.test(v.owner)) return null;
    if (typeof v.accountIndex !== 'number' || !Number.isSafeInteger(v.accountIndex) || v.accountIndex < 0) return null;
    if (v.accountKind !== 'kernel-v3.3' && v.accountKind !== 'kernel-7702') return null;
    if (typeof v.permissionId !== 'string' || !PERMISSION_ID.test(v.permissionId)) return null;
    if (typeof v.policyCount !== 'number' || !Number.isInteger(v.policyCount) || v.policyCount < 0 || v.policyCount > 253) {
      return null;
    }
    // Re-validates the stored grant (shape and rules; no clock check).
    parseSessionKeyGrant(v.grant);
    if (typeof v.label !== 'string' || v.label.length === 0 || v.label.length > 200) return null;
    if (v.source !== 'manual' && v.source !== 'erc7715' && v.source !== 'subscription' && v.source !== 'recurring') {
      return null;
    }
    const subscription = reviveSubscriptionMeta(v.subscription, v.grant, v.source);
    if (sessionCarriesTerms(v.source) ? subscription === null : v.subscription !== undefined && v.subscription !== null) {
      return null;
    }
    // A recurring payment's key is never handed over: a stored hand-over
    // time on one means the record was altered, so it is dropped.
    if (v.source === 'recurring' && subscription !== null && subscription.keyExportedAt !== null) return null;
    if (v.dappUrl !== null && typeof v.dappUrl !== 'string') return null;
    if (typeof v.createdAt !== 'number' || !Number.isFinite(v.createdAt)) return null;
    if (v.installMode !== 'explicit') return null;
    if (typeof v.keyHeld !== 'boolean') return null;
    const hashOrNull = (h: unknown) => h === null || (typeof h === 'string' && USEROP_HASH.test(h));
    if (!hashOrNull(v.installUserOpHash) || !hashOrNull(v.revokeUserOpHash)) return null;
    if (!LOCAL_STATUSES.includes(v.localStatus as SessionLocalStatus)) return null;
    return {
      chain: v.chain,
      account: v.account,
      owner: v.owner,
      accountIndex: v.accountIndex,
      accountKind: v.accountKind,
      permissionId: v.permissionId.toLowerCase(),
      policyCount: v.policyCount,
      grant: v.grant as SerializedSessionKeyGrant,
      label: v.label,
      source: v.source,
      dappUrl: (v.dappUrl as string | null) ?? null,
      createdAt: v.createdAt,
      installMode: 'explicit',
      keyHeld: v.keyHeld,
      installUserOpHash: (v.installUserOpHash as string | null) ?? null,
      revokeUserOpHash: (v.revokeUserOpHash as string | null) ?? null,
      localStatus: v.localStatus as SessionLocalStatus,
      ...(subscription ? { subscription } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * The grace period of a RECURRING payment, in seconds: one period. The grant
 * a recurring payment installs (recurring.ts recurringGrantFor) ends one
 * period after the terms' validUntil, so the last payment can be sent during
 * two periods instead of one (finding 3 of the 2026-10-09 recurring-payments
 * rehearsal: a late last payment plus a transient error lost it for good).
 * The number of payments is not changed by it; see recurringGrantFor for why
 * the extra period cannot allow one more payment. Merchant subscriptions do
 * not get it (subscriptions.ts subscriptionGrantFor explains why).
 */
export function recurringGraceSeconds(terms: Pick<SubscriptionGrant, 'periodSeconds'>): number {
  return terms.periodSeconds;
}

/**
 * Whether stored terms describe exactly `grant`: the engine's
 * subscriptionMatchesGrant (every field of the grant derived from the terms),
 * or, for a recurring payment only, the same grant with its validUntil one
 * grace period (recurringGraceSeconds) later. Nothing else is accepted, so
 * the stored description can still never disagree with what is installed.
 * Recurring payments set up before the grace period existed carry no grace
 * and still match the first form.
 */
export function termsMatchGrant(source: SessionSource, terms: SubscriptionGrant, grant: SessionKeyGrant): boolean {
  if (subscriptionMatchesGrant(terms, grant)) return true;
  if (source !== 'recurring') return false;
  return subscriptionMatchesGrant(terms, { ...grant, validUntil: grant.validUntil - recurringGraceSeconds(terms) });
}

/** Strict revival of subscription terms; null unless they map to exactly `grant` (termsMatchGrant). */
function reviveSubscriptionMeta(value: unknown, grant: unknown, source: SessionSource): SessionSubscriptionMeta | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  try {
    const terms = parseSubscription(v.terms);
    if (!termsMatchGrant(source, terms, parseSessionKeyGrant(grant))) return null;
    if (typeof v.tokenSymbol !== 'string' || v.tokenSymbol.length === 0 || v.tokenSymbol.length > 32) return null;
    if (typeof v.tokenDecimals !== 'number' || !Number.isInteger(v.tokenDecimals) || v.tokenDecimals < 0 || v.tokenDecimals > 36) {
      return null;
    }
    if (v.keyExportedAt !== null && (typeof v.keyExportedAt !== 'number' || !Number.isFinite(v.keyExportedAt))) return null;
    return {
      terms: v.terms as SerializedSubscriptionGrant,
      tokenSymbol: v.tokenSymbol,
      tokenDecimals: v.tokenDecimals,
      keyExportedAt: (v.keyExportedAt as number | null) ?? null,
    };
  } catch {
    return null;
  }
}

type RawRead =
  | { state: 'empty' }
  | { state: 'ok'; records: Record<string, unknown> }
  | { state: 'unreadable' };

async function readRaw(store: KeyValueStore): Promise<RawRead> {
  let text: string | null;
  try {
    text = await store.getItem(SESSIONS_KEY);
  } catch {
    return { state: 'unreadable' };
  }
  if (text === null) return { state: 'empty' };
  try {
    const parsed = JSON.parse(text) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as { version?: unknown }).version !== STORE_VERSION ||
      typeof (parsed as { records?: unknown }).records !== 'object' ||
      (parsed as { records?: unknown }).records === null ||
      Array.isArray((parsed as { records?: unknown }).records)
    ) {
      return { state: 'unreadable' };
    }
    return { state: 'ok', records: (parsed as { records: Record<string, unknown> }).records };
  } catch {
    return { state: 'unreadable' };
  }
}

/** Every stored session (oldest first). Never throws. */
export async function loadSessions(store: KeyValueStore = AsyncStorage): Promise<SessionListLoad> {
  const read = await readRaw(store);
  if (read.state === 'empty') return { records: [], corrupt: false, unreadable: false };
  if (read.state === 'unreadable') return { records: [], corrupt: true, unreadable: true };
  const records: SessionRecord[] = [];
  let dropped = 0;
  for (const [key, value] of Object.entries(read.records)) {
    const record = reviveRecord(value);
    if (!record || key !== sessionRecordKey(record.chain, record.account, record.permissionId)) {
      dropped += 1;
      continue;
    }
    records.push(record);
  }
  records.sort((a, b) => a.createdAt - b.createdAt);
  return { records, corrupt: dropped > 0, unreadable: false };
}

/** The sessions of one Kernel account on one chain. */
export async function loadSessionsFor(
  chain: string,
  account: string,
  store: KeyValueStore = AsyncStorage,
): Promise<SessionListLoad> {
  const all = await loadSessions(store);
  return { ...all, records: all.records.filter((r) => r.chain === chain && same(r.account, account)) };
}

const UNREADABLE_MESSAGE =
  'The saved session list could not be read, so nothing was changed. Use "Reset session list" on ' +
  'the Sessions screen to start a fresh list (on-chain grants are not affected).';

async function writeRecord(record: SessionRecord | null, key: string, store: KeyValueStore): Promise<void> {
  const read = await readRaw(store);
  if (read.state === 'unreadable') throw new Error(UNREADABLE_MESSAGE);
  const records = read.state === 'ok' ? { ...read.records } : {};
  if (record) records[key] = record;
  else delete records[key];
  await store.setItem(SESSIONS_KEY, JSON.stringify({ version: STORE_VERSION, records }));
}

export async function saveSessionRecord(record: SessionRecord, store: KeyValueStore = AsyncStorage): Promise<void> {
  await writeRecord(record, sessionRecordKey(record.chain, record.account, record.permissionId), store);
}

async function updateRecord(
  record: SessionRecord,
  patch: Partial<SessionRecord>,
  store: KeyValueStore,
): Promise<SessionRecord> {
  const next = { ...record, ...patch };
  await saveSessionRecord(next, store);
  return next;
}

/** Clears the whole local list (after an explicit confirmation on screen). */
export async function resetSessions(store: KeyValueStore = AsyncStorage): Promise<void> {
  await store.setItem(SESSIONS_KEY, JSON.stringify({ version: STORE_VERSION, records: {} }));
}

/**
 * Wipe support: deletes every session key the list knows about from the
 * vault, then the list itself. Best-effort per key (a missing entry is not
 * an error); keys of an unreadable list cannot be enumerated and are left.
 */
export async function forgetAllSessions(
  store: KeyValueStore,
  vault: SessionKeyVault,
): Promise<{ keysRemoved: number }> {
  const { records } = await loadSessions(store);
  let keysRemoved = 0;
  for (const r of records) {
    if (!r.keyHeld) continue;
    try {
      await vault.remove(sessionVaultId(r.chain, r.account, r.permissionId));
      keysRemoved += 1;
    } catch {
      // Keep going: one failed delete must not keep the others.
    }
  }
  await resetSessions(store);
  return { keysRemoved };
}

// ---------------------------------------------------------------------------
// Which account a session would live in
// ---------------------------------------------------------------------------

export type SessionAccountResolution =
  | { ok: true; account: string; kind: SessionAccountKind }
  | { ok: false; reason: string };

/**
 * Resolves the Kernel account of `ownerAddress` through the existing AA
 * bundle (createAaClientFromConfig decides the type: 'kernel-7702' for an
 * owner upgraded through "Upgrade this account", else the chain's type) and
 * refuses — with a plain sentence — when permissions cannot be installed
 * there: a SimpleAccount (no permission system), an undeployed Kernel
 * account (no code to install into), or a 7702 owner whose delegation to
 * the wallet's Kernel delegate is not active on-chain. Read-only.
 */
export async function resolveSessionAccount(
  bundle: AaClientBundle,
  ownerAddress: string,
): Promise<SessionAccountResolution> {
  // A multisig bundle never reaches here today (the screens refuse first); kept as defence in depth.
  if (bundle.accountType === 'kernel-multisig') return { ok: false, reason: MULTISIG_CONFIG_BUNDLE_REFUSAL };
  const reported = await new NodeClient(bundle.node).chainId();
  if (reported !== bundle.chainId) {
    return {
      ok: false,
      reason: `The RPC endpoint is chain id ${reported}, expected ${bundle.chainId}. Check the endpoint in Settings.`,
    };
  }
  if (bundle.accountType === 'simple') return { ok: false, reason: SESSION_SIMPLE_REFUSAL };
  if (bundle.accountType === 'kernel-7702') {
    const status = await readDelegationStatus(bundle.node, ownerAddress);
    if (status.kind !== 'delegated' || !same(status.delegate, WALLET_7702_DELEGATE)) {
      return { ok: false, reason: SESSION_NOT_UPGRADED_REFUSAL };
    }
    return { ok: true, account: toChecksumAddress(toBytes(ownerAddress.toLowerCase())), kind: 'kernel-7702' };
  }
  const account = await resolveAaSender(bundle, ownerAddress);
  const code = (await bundle.node('eth_getCode', [account, 'latest'])) as string;
  if (!code || code === '0x' || code === '0x0') return { ok: false, reason: SESSION_UNDEPLOYED_REFUSAL };
  return { ok: true, account, kind: 'kernel-v3.3' };
}

// ---------------------------------------------------------------------------
// Manual grant form → SessionKeyGrant
// ---------------------------------------------------------------------------

export interface AllowedCallDraft {
  /** Target address as typed or picked from contacts. */
  target: string;
  /** Empty (plain value transfer), 0x + 8 hex, or a signature like transfer(address,uint256). */
  selector: string;
  /** Per-call value cap in ETH; empty means 0. */
  valueCapEth: string;
}

/**
 * Parses the selector field: '' → null (empty calldata only); a 4-byte hex
 * selector; or a Solidity function signature, hashed with the engine's
 * selector() (keccak256 of the exact text with whitespace removed — the
 * signature must be in canonical form, e.g. "transfer(address,uint256)").
 */
export function parseSelectorInput(raw: string): string | null {
  const text = raw.replace(/\s+/g, '');
  if (text === '') return null;
  if (/^0x[0-9a-fA-F]{8}$/.test(text)) return text.toLowerCase();
  if (/^[A-Za-z_$][A-Za-z0-9_$]*\([A-Za-z0-9_,[\]()]*\)$/.test(text)) return toHex(abiSelector(text));
  throw new Error(
    'A function selector is 0x followed by 8 hex characters, or a canonical signature such as ' +
      'transfer(address,uint256). Leave it empty for a plain transfer with no data.',
  );
}

/**
 * Builds the grant from the form. Input errors (address, amounts, selector)
 * get plain messages; everything else — wildcard targets, self-calls,
 * duplicates, the window — is left to the engine's validateSessionKeyGrant,
 * whose message the screen shows verbatim (see validateGrantForAccount).
 */
export function buildManualGrant(args: {
  sessionKey: string;
  drafts: AllowedCallDraft[];
  expirySeconds: number;
  gasBudgetEth: string;
  /** Unix seconds. */
  now: number;
}): SessionKeyGrant {
  if (!SESSION_EXPIRY_PRESETS.some((p) => p.seconds === args.expirySeconds)) {
    throw new Error('Choose how long the session lasts.');
  }
  const calls: SessionAllowedCall[] = args.drafts.map((draft, i) => {
    const where = `Allowed call ${i + 1}`;
    const target = validateRecipient(EVM_CHAIN_ID, draft.target);
    if (!target.ok) throw new Error(`${where}: ${target.error}`);
    let selectorValue: string | null;
    try {
      selectorValue = parseSelectorInput(draft.selector);
    } catch (e) {
      throw new Error(`${where}: ${(e as Error).message}`);
    }
    let valueLimit = 0n;
    if (draft.valueCapEth.trim() !== '') {
      try {
        valueLimit = parseUnits(draft.valueCapEth, 18);
      } catch (e) {
        throw new Error(`${where}, value cap: ${(e as Error).message}`);
      }
    }
    return { target: target.normalized, selector: selectorValue, valueLimit };
  });
  let gasBudgetWei: bigint | undefined;
  if (args.gasBudgetEth.trim() !== '') {
    try {
      gasBudgetWei = parseUnits(args.gasBudgetEth, 18);
    } catch (e) {
      throw new Error(`Gas budget: ${(e as Error).message}`);
    }
  }
  return {
    sessionKey: args.sessionKey,
    calls,
    validAfter: 0,
    validUntil: args.now + args.expirySeconds,
    ...(gasBudgetWei !== undefined ? { gasBudgetWei } : {}),
  };
}

/**
 * The engine's validateSessionKeyGrant for this account. Returns null when
 * the grant is acceptable, else the engine's refusal text verbatim.
 */
export function validateGrantForAccount(grant: SessionKeyGrant, account: string, now?: number): string | null {
  try {
    validateSessionKeyGrant(grant, { account, ...(now !== undefined ? { now } : {}) });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** A fresh session key: the private key (to vault) and its address (into the grant). */
export function newSessionKey(): { privateKey: Uint8Array; address: string } {
  const privateKey = generateSessionPrivateKey();
  const address = createSessionKeyAccount(privateKey).address;
  return { privateKey, address };
}

// ---------------------------------------------------------------------------
// Plain-language rendering (shown before the biometric gate)
// ---------------------------------------------------------------------------

/**
 * Selectors the review screen names, computed from their signatures with
 * the engine's selector() (never hard-coded hex). Signatures from ERC-20
 * (EIP-20) and ERC-721 (EIP-721).
 */
const KNOWN_FUNCTIONS: { signature: string; note: string | null }[] = [
  { signature: 'transfer(address,uint256)', note: null },
  {
    signature: 'approve(address,uint256)',
    note:
      'Lets the session approve ANY spender for ANY amount of this token (ERC-20) or any token id ' +
      '(ERC-721). An approval outlives the session.',
  },
  {
    signature: 'transferFrom(address,address,uint256)',
    note: 'Moves tokens from any address that approved your account, to any recipient.',
  },
  {
    signature: 'setApprovalForAll(address,bool)',
    note: 'Lets the session give an operator control of ALL your NFTs in this collection. It outlives the session.',
  },
];
const KNOWN_BY_SELECTOR = new Map(
  KNOWN_FUNCTIONS.map((f) => [toHex(abiSelector(f.signature)), f] as const),
);

export interface AllowedCallDescription {
  title: string;
  details: string[];
  /** Present for functions that grant lasting power (approvals). */
  warning: string | null;
}

/** One allowed call in plain language. */
export function describeAllowedCall(
  call: SessionAllowedCall,
  context: { symbol: string; account: string; nameFor?: (address: string) => string | null },
): AllowedCallDescription {
  const name = context.nameFor?.(call.target) ?? null;
  const self = same(call.target, context.account);
  const who = self ? `your own account (${call.target})` : name ? `${name} (${call.target})` : call.target;
  const cap = `${formatUnits(call.valueLimit, 18, 18)} ${context.symbol}`;
  const details: string[] = [];
  let title: string;
  let warning: string | null = null;
  if (call.selector === null) {
    title =
      call.valueLimit === 0n
        ? `Call ${who} with no data and no ${context.symbol}`
        : `Send up to ${cap} per call to ${who}`;
    // The account's CallPolicy keys an empty-calldata call as function
    // 0x00000000, so calldata that merely STARTS with four zero bytes
    // matches the same entry (engine: kernel-permissions.ts
    // SessionAllowedCall.selector). Said plainly rather than overstated.
    details.push(
      'No contract function: meant for a plain transfer with empty calldata. The account enforces this as ' +
        'function 0x00000000, so a call whose data begins with 0x00000000 would also be allowed. That matters ' +
        'only if the target is a contract.',
    );
  } else {
    const known = KNOWN_BY_SELECTOR.get(call.selector.toLowerCase());
    const fn = known ? `${known.signature} (${call.selector})` : `function ${call.selector}`;
    title = `Call ${fn} on ${who}`;
    details.push(
      call.valueLimit === 0n
        ? `Sends no ${context.symbol} with the call.`
        : `Sends at most ${cap} with each call.`,
    );
    if (!call.rules || call.rules.length === 0) details.push('Any arguments are allowed.');
    for (const rule of call.rules ?? []) {
      details.push(
        `Argument word at byte offset ${rule.offset} must be ${rule.condition} ${rule.params.join(', ')}.`,
      );
    }
    warning = known?.note ?? null;
  }
  details.push('The cap is per call, not a total: the session may repeat this call until it expires.');
  return { title, details, warning };
}

/** The window and budget lines of a grant. */
export function describeGrantLimits(grant: SessionKeyGrant, symbol: string): string[] {
  const lines = [
    `Expires ${new Date(grant.validUntil * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')} ` +
      `(unix ${grant.validUntil}); enforced on-chain by the account.`,
  ];
  if (grant.validAfter > 0) lines.push(`Not valid before unix ${grant.validAfter}.`);
  lines.push(
    grant.gasBudgetWei !== undefined
      ? `Gas budget: at most ${formatUnits(grant.gasBudgetWei, 18, 18)} ${symbol} in fees across all of the ` +
          'session’s operations (worst-case accounting).'
      : `No gas budget: fees for the session’s operations are paid from the account’s ${symbol} until it expires.`,
  );
  if (grant.rateLimit) {
    // RateLimitPolicy semantics (verified source, see the engine's
    // kernel-subscription.ts header): `count` operations IN TOTAL, the k-th
    // valid from startAt + k × interval; a missed slot can be used later.
    const startAt = grant.rateLimit.startAt ?? 0;
    lines.push(
      `Rate limit: at most ${grant.rateLimit.count} operation${grant.rateLimit.count === 1 ? '' : 's'} in total, ` +
        `one more becoming valid every ${grant.rateLimit.intervalSeconds} s` +
        (startAt > 0
          ? ` from ${new Date(startAt * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}`
          : ' (no start time: every slot is already open, so only the total is limited)') +
        '; a missed slot can be used later. Counted per operation, not per transfer.',
    );
  }
  lines.push('A session key can never sign messages or logins for your account (ERC-1271 is switched off for it).');
  return lines;
}

// ---------------------------------------------------------------------------
// Install (root-signed, explicit)
// ---------------------------------------------------------------------------

export const SESSION_TUPLE_REFUSAL =
  'Installing a session must not also upgrade the account (EIP-7702). Upgrade the account first; ' +
  'nothing was signed.';

/**
 * Validates the grant locally FIRST (the engine's refusal is thrown
 * verbatim, with no network request), then reads the account's Kernel
 * state through the engine's prepareKernelPermissionInstall (fresh
 * permission id, current nonces) and prices the explicit installCalls as
 * ONE root-signed UserOperation with prepareAaCalls — the bundler estimate
 * is the pre-flight gate, exactly as for any smart-account send.
 */
export async function prepareSessionInstall(
  bundle: AaClientBundle,
  ownerAddress: string,
  account: string,
  grant: SessionKeyGrant,
  options: { now?: number } = {},
): Promise<{ install: KernelPermissionInstall; quote: AaSendQuote }> {
  // Mainnet readiness (config/readiness.ts): refused before any request
  // where session keys are not allowed.
  assertFeatureAllowed('session-keys', eip155Caip2(bundle.chainId));
  validateSessionKeyGrant(grant, { account, ...(options.now !== undefined ? { now: options.now } : {}) });
  const reported = await new NodeClient(bundle.node).chainId();
  if (reported !== bundle.chainId) {
    throw new Error(`Endpoint is chain id ${reported}, expected ${bundle.chainId}. Check the RPC endpoint in Settings.`);
  }
  const code = (await bundle.node('eth_getCode', [account, 'latest'])) as string;
  if (!code || code === '0x' || code === '0x0') throw new Error(SESSION_UNDEPLOYED_REFUSAL);
  const install = await prepareKernelPermissionInstall(bundle.node, grant, {
    chainId: bundle.chainId,
    account,
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  const quote = await prepareAaCalls(bundle, ownerAddress, install.installCalls, { displayTo: account });
  if (!same(quote.sender, account)) {
    throw new Error(`The configured smart account is ${quote.sender}, not ${account}. Nothing was signed.`);
  }
  if (quote.eip7702?.upgrade) throw new Error(SESSION_TUPLE_REFUSAL);
  if (!quote.deployed) throw new Error(SESSION_UNDEPLOYED_REFUSAL);
  return { install, quote };
}

/**
 * Persists and submits an install. Order: the session key (manual grants
 * only) goes into the vault and the record (status installing) into the
 * list BEFORE anything is submitted, so a crash after submission can never
 * leave a live permission the wallet has no record of. `submit` signs with
 * the OWNER key (in the app: signWith → sendAa after the biometric gate).
 * When submit throws, the record is kept as 'failed' (with its key) so the
 * on-chain status decides whether it can be forgotten.
 */
export async function installSession(args: {
  quote: AaSendQuote;
  install: KernelPermissionInstall;
  grant: SessionKeyGrant;
  chain: string;
  account: string;
  owner: string;
  accountIndex: number;
  accountKind: SessionAccountKind;
  label: string;
  source: SessionSource;
  dappUrl?: string | null;
  /** Required for sources 'subscription' and 'recurring' (and refused for the others). */
  subscription?: SessionSubscriptionMeta | null;
  /**
   * Manual grants, subscriptions and recurring payments: the session's
   * private key (stored in the vault; a subscription's key leaves it when it
   * is handed to the merchant, see releaseSessionKey; a recurring payment's
   * key never leaves it). ERC-7715: null (the dApp holds it).
   */
  sessionPrivateKey: Uint8Array | null;
  store: KeyValueStore;
  vault: SessionKeyVault | null;
  submit: (quote: AaSendQuote) => Promise<{ userOpHash: string }>;
}): Promise<{ record: SessionRecord; userOpHash: string }> {
  // Mainnet readiness: checked again before anything is stored or signed.
  assertFeatureAllowed('session-keys', args.chain);
  const permissionId = toHex(args.install.permissionId).toLowerCase();
  const calls = args.quote.calls;
  if (
    calls.length !== args.install.installCalls.length ||
    calls.some(
      (c, i) =>
        !same(c.to, args.install.installCalls[i]!.to) ||
        c.value !== args.install.installCalls[i]!.value ||
        toHex(c.data) !== toHex(args.install.installCalls[i]!.data),
    )
  ) {
    throw new Error('The quoted operation is not the session install it claims to be. Nothing was signed.');
  }
  if (sessionCarriesTerms(args.source) !== Boolean(args.subscription)) {
    throw new Error('Subscription terms belong exactly to subscription grants. Nothing was signed.');
  }
  if (args.source === 'recurring') {
    // The wallet sends each recurring payment itself, so the key must be
    // stored on this device, and it is never handed over.
    if (!args.sessionPrivateKey) throw new Error('A recurring payment needs its key on this device. Nothing was signed.');
    if (args.subscription!.keyExportedAt !== null) {
      throw new Error('A recurring payment’s key is never handed over. Nothing was signed.');
    }
  }
  if (args.subscription && !termsMatchGrant(args.source, parseSubscription(args.subscription.terms), args.grant)) {
    throw new Error('The subscription terms do not match the grant being installed. Nothing was signed.');
  }
  if (args.sessionPrivateKey) {
    const derived = createSessionKeyAccount(args.sessionPrivateKey).address;
    if (!same(derived, args.grant.sessionKey)) {
      throw new Error('The session key does not match the grant. Nothing was signed.');
    }
    if (!args.vault) throw new Error('No secure storage for the session key. Nothing was signed.');
    await args.vault.save(
      sessionVaultId(args.chain, args.account, permissionId),
      toHex(args.sessionPrivateKey),
    );
  }
  let record: SessionRecord = {
    chain: args.chain,
    account: args.account,
    owner: args.owner,
    accountIndex: args.accountIndex,
    accountKind: args.accountKind,
    permissionId,
    policyCount: args.install.policyCount,
    grant: serializeSessionKeyGrant(args.grant),
    label: args.label,
    source: args.source,
    dappUrl: args.dappUrl ?? null,
    createdAt: Date.now(),
    installMode: 'explicit',
    keyHeld: args.sessionPrivateKey !== null,
    installUserOpHash: null,
    revokeUserOpHash: null,
    localStatus: 'installing',
    ...(args.subscription ? { subscription: { ...args.subscription } } : {}),
  };
  try {
    await saveSessionRecord(record, args.store);
  } catch (e) {
    if (args.sessionPrivateKey && args.vault) {
      await args.vault.remove(sessionVaultId(args.chain, args.account, permissionId)).catch(() => undefined);
    }
    throw e;
  }
  let userOpHash: string;
  try {
    ({ userOpHash } = await args.submit(args.quote));
  } catch (e) {
    await updateRecord(record, { localStatus: 'failed' }, args.store).catch(() => undefined);
    throw e;
  }
  record = await updateRecord(record, { installUserOpHash: userOpHash }, args.store);
  return { record, userOpHash };
}

/**
 * An operation of this session that was sent to the bundler but not yet
 * settled locally (install accepted, record still 'installing'; revoke
 * accepted, record still 'revoking'), or null. The Sessions screen reads it
 * from the STORED record, so the sent operation and its outcome stay
 * visible even when the screen that sent it is gone (navigated away,
 * remounted, or the app restarted while waiting) — phase 10 item 1, bug 1.
 */
export function pendingSessionOperation(record: SessionRecord): { kind: 'install' | 'revoke'; userOpHash: string } | null {
  if (record.localStatus === 'installing' && record.installUserOpHash) {
    return { kind: 'install', userOpHash: record.installUserOpHash };
  }
  if (record.localStatus === 'revoking' && record.revokeUserOpHash) {
    return { kind: 'revoke', userOpHash: record.revokeUserOpHash };
  }
  return null;
}

/** The record's local lifecycle in plain words (shown with its operation hashes). */
export function sessionLocalStatusText(record: SessionRecord): string {
  switch (record.localStatus) {
    case 'installing':
      return record.installUserOpHash
        ? 'Install sent to the bundler; waiting for the receipt.'
        : 'Install not sent yet (or the app stopped before the bundler answered).';
    case 'installed':
      return 'Install included and read back from the chain.';
    case 'failed':
      return 'Install refused or reverted.';
    case 'revoking':
      return 'Revocation sent to the bundler; waiting for the receipt.';
    case 'revoked':
      return 'Revocation included and read back from the chain.';
  }
}

/**
 * Waits for the install operation's receipt, then reads the permission back
 * from the chain; the record becomes 'installed' only when the receipt
 * succeeded AND the on-chain state shows the grant's session key.
 */
export async function finalizeSessionInstall(
  bundle: AaClientBundle,
  record: SessionRecord,
  store: KeyValueStore,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<{ record: SessionRecord; receipt: AaReceiptSummary; status: SessionChainStatus }> {
  if (!record.installUserOpHash) throw new Error('This session has no install operation to wait for.');
  const raw = await bundle.client.waitForReceipt(record.installUserOpHash, {
    timeoutMs: options.timeoutMs ?? 120_000,
    pollMs: options.pollMs ?? 3_000,
  });
  const receipt = summarizeAaReceipt(raw);
  // Status as of the including block (the wallet's RPC may lag the
  // bundler's node by a block or two; see recovery.ts readAtInclusionBlock).
  const status = await readAtInclusionBlock(bundle.node, raw, (n) => definiteSessionStatus(n, record), {
    ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
  }).catch(() => readSessionStatus(bundle.node, record));
  const next =
    receipt.success === true && status.kind === 'active'
      ? await updateRecord(record, { localStatus: 'installed' }, store)
      : receipt.success === false
        ? await updateRecord(record, { localStatus: 'failed' }, store)
        : record;
  return { record: next, receipt, status };
}

// ---------------------------------------------------------------------------
// On-chain status
// ---------------------------------------------------------------------------

export type SessionChainStatus =
  | { kind: 'active'; expired: boolean }
  /** Not installed on-chain, and the wallet had installed or revoked it. */
  | { kind: 'revoked' }
  /** Not installed on-chain, and the install never confirmed. */
  | { kind: 'not-installed' }
  /**
   * `endpointFailure` is set when the read failed because the network
   * endpoint did not answer (isTransportFailure); the screen then retries the
   * read once on the next healthy default endpoint. `reason` is already
   * plain words in that case (never a raw Java exception).
   */
  | { kind: 'unknown'; reason: string; endpointFailure?: boolean };

/**
 * The session's status from the engine's readKernelPermissionState (plus
 * ECDSASigner's stored signer, which must be the grant's session key).
 * Read failures and inconsistent states are 'unknown' with the reason —
 * never a guess.
 */
export async function readSessionStatus(
  node: JsonRpcTransport,
  record: SessionRecord,
  now: number = Math.floor(Date.now() / 1000),
): Promise<SessionChainStatus> {
  try {
    const grant = parseSessionKeyGrant(record.grant);
    const state = await readKernelPermissionState(node, record.account, record.permissionId);
    const zero = (a: string) => /^0x0{40}$/i.test(a);
    if (state.installed) {
      if (!same(state.signer, KERNEL_PERMISSION_MODULES.ecdsaSigner)) {
        return { kind: 'unknown', reason: `Unexpected signer module ${state.signer} for this permission.` };
      }
      const signer = await readSessionSigner(node, record.account, record.permissionId);
      if (!same(signer, grant.sessionKey)) {
        return { kind: 'unknown', reason: `The account stores signer ${signer}, not this session’s key ${grant.sessionKey}.` };
      }
      return { kind: 'active', expired: now >= grant.validUntil };
    }
    if (zero(state.hook) && zero(state.signer)) {
      return record.localStatus === 'installing' || record.localStatus === 'failed'
        ? { kind: 'not-installed' }
        : { kind: 'revoked' };
    }
    return { kind: 'unknown', reason: 'The permission is only partly installed on-chain.' };
  } catch (e) {
    return unknownStatusFrom(e);
  }
}

/**
 * The 'unknown' status for a failed read: an endpoint that did not answer
 * is described in plain words with the sanitized technical detail
 * (sanitizeEndpointMessage strips Java exception class names, links and
 * advertisements); any other error keeps its message, as before.
 */
export function unknownStatusFrom(error: unknown): { kind: 'unknown'; reason: string; endpointFailure?: boolean } {
  if (isTransportFailure(error)) {
    const technical = sanitizeEndpointMessage(error instanceof Error ? error.message : String(error));
    return {
      kind: 'unknown',
      reason: `the network endpoint did not answer${technical ? ` (${technical.replace(/\.$/, '')})` : ''}`,
      endpointFailure: true,
    };
  }
  return { kind: 'unknown', reason: error instanceof Error ? error.message : String(error) };
}

// ---------------------------------------------------------------------------
// Endpoint failures on the Sessions screen (2026-10-04 emulator run, bug 4:
// a raw "fetch failed: java.net.UnknownHostException …" alert, and no
// failover on the subscription re-quote)
// ---------------------------------------------------------------------------

/**
 * True when `error` means the request got no usable answer from the endpoint
 * (a transport failure), so another default endpoint might succeed and the
 * user should be told in plain words that the network could not be reached.
 *
 * It is ../config/endpoint-probe.ts isEndpointFailure plus ONE shape that
 * function does not accept: Expo SDK 57's runtime replaces the global fetch
 * with expo/fetch (node_modules/expo/src/winter/runtime.native.ts installs
 * it unless EXPO_PUBLIC_USE_RN_FETCH is set, and this app does not set it),
 * and expo/fetch reports a failed request as a plain Error, not a TypeError,
 * whose message is "fetch failed: " followed by the platform's text
 * (node_modules/expo/src/winter/fetch/FetchErrors.ts, class FetchError
 * extends Error; fetch.ts wraps every failure of the native request in it).
 * isEndpointFailure accepts the "fetch failed" wording only on a TypeError
 * (React Native's own fetch and Node's undici), so on the device a DNS
 * failure such as "fetch failed: java.net.UnknownHostException: Unable to
 * resolve host …" was neither failed over nor described in plain words
 * (finding 1 of the 2026-10-09 recurring-payments rehearsal). The extra test
 * is anchored at the start of the message, so the engine's own texts such
 * as "UTXO fetch failed: HTTP 400 …" (an answer, not a transport failure)
 * are not matched. The same gap affects every other screen that relies on
 * isEndpointFailure alone; that function lives outside this module.
 */
export function isTransportFailure(error: unknown): boolean {
  if (isEndpointFailure(error)) return true;
  return error instanceof Error && /^fetch failed(?::|$)/.test(error.message);
}

/** Marker set on errors thrown by a session bundle's NODE transport. */
const NODE_ERROR_MARK = 'shibaNodeTransport';
/** Marker set on errors thrown by a send's BUNDLER transport: the JSON-RPC method that failed. */
const BUNDLER_METHOD_MARK = 'shibaBundlerMethod';

function markError(error: unknown, mark: string, value: unknown = true): void {
  if (error !== null && typeof error === 'object') {
    try {
      (error as Record<string, unknown>)[mark] = value;
    } catch {
      // A frozen error stays unmarked: it is then treated as unclassified.
    }
  }
}

function bundlerMethodOf(error: unknown): string | null {
  if (error === null || typeof error !== 'object') return null;
  const method = (error as Record<string, unknown>)[BUNDLER_METHOD_MARK];
  return typeof method === 'string' ? method : null;
}

/**
 * Wraps a node transport so the errors it throws are marked as the node's.
 * The smart-account quote talks to the node AND the bundler, whose
 * transport failures look alike; only a node failure may move the quote to
 * another default RPC endpoint (the failover rule of
 * ../config/endpoint-probe.ts runWithEndpointFailover). The error object is
 * passed through unchanged apart from the marker.
 */
export function markNodeErrors(transport: JsonRpcTransport): JsonRpcTransport {
  return async (method, params) => {
    try {
      return await transport(method, params);
    } catch (error) {
      // A frozen error stays unmarked: it is then not failed over.
      markError(error, NODE_ERROR_MARK);
      throw error;
    }
  };
}

/** True for a transport failure (isTransportFailure) thrown by a marked node transport. */
export function isNodeEndpointFailure(error: unknown): boolean {
  return (
    isTransportFailure(error) &&
    error !== null &&
    typeof error === 'object' &&
    (error as Record<string, unknown>)[NODE_ERROR_MARK] === true
  );
}

/**
 * Wraps a send's bundler transport so every error it throws carries the
 * JSON-RPC method that failed. Every bundler request of a send other than
 * eth_sendUserOperation (the fee floor, the gas estimate) happens BEFORE the
 * submission (engine SmartAccountClient.sendCalls submits last), so a
 * transport failure there means nothing was handed over; a transport failure
 * during eth_sendUserOperation itself leaves the outcome open (the bundler
 * may have received the operation before the connection failed).
 */
export function markBundlerErrors(transport: JsonRpcTransport): JsonRpcTransport {
  return async (method, params) => {
    try {
      return await transport(method, params);
    } catch (error) {
      markError(error, BUNDLER_METHOD_MARK, method);
      throw error;
    }
  };
}

/**
 * True for a transport failure (isTransportFailure) of a marked bundler
 * transport (markBundlerErrors) on a request made BEFORE the submission:
 * nothing was handed to the bundler.
 */
export function isBundlerTransportFailureBeforeSubmit(error: unknown): boolean {
  const method = bundlerMethodOf(error);
  return isTransportFailure(error) && method !== null && method !== 'eth_sendUserOperation';
}

/**
 * True for a transport failure (isTransportFailure) while the signed
 * operation was being handed to the bundler (eth_sendUserOperation, marked
 * by markBundlerErrors): the bundler may or may not have received it.
 */
export function isSubmissionTransportFailure(error: unknown): boolean {
  return isTransportFailure(error) && bundlerMethodOf(error) === 'eth_sendUserOperation';
}

/**
 * The transport factory for a session bundle on `nodeUrl`: the node's
 * transport marks its errors (markNodeErrors); the bundler gets `base`;
 * the paymaster keeps the probe transport that preserves a refusal's text
 * (aa.ts paymasterProbeTransport) when `base` is the plain HTTP transport,
 * exactly as createAaClient chooses it.
 */
export function sessionTransportFor(
  nodeUrl: string,
  base: TransportFactory,
  options: { paymasterUrl?: string | null; plainHttp?: boolean } = {},
): TransportFactory {
  return (url) => {
    if (url === nodeUrl) return markNodeErrors(base(url));
    if (options.plainHttp && options.paymasterUrl && url === options.paymasterUrl) return paymasterProbeTransport(url);
    return base(url);
  };
}

/** Alert title for a session or subscription step that could not reach the network endpoint. */
export const SESSION_UNREACHABLE_TITLE = 'Could not reach the network endpoint. Check your connection and try again.';

/**
 * Plain-language error for every quote, submit and status step of the
 * Sessions screen: the smart-account wording first (describeAaError: fee
 * rose, funding, bundler refusals with their text kept), then an endpoint
 * that did not answer (a plain sentence plus the sanitized technical
 * detail, never the raw platform exception), then the send wording.
 * `stage` 'quote' re-titles a generic failure as "The quote could not be
 * prepared." (nothing was signed at that step).
 */
export function describeSessionError(
  error: unknown,
  context: { accountType: AaAccountType; symbol: string; stage: 'quote' | 'send' },
  describeSend: (error: unknown, symbol: string) => { title: string; detail: string },
): { title: string; detail: string } {
  const aa = describeAaError(error, { accountType: context.accountType, deployed: true });
  if (aa) return aa;
  if (isTransportFailure(error)) {
    const technical = sanitizeEndpointMessage(error instanceof Error ? error.message : String(error));
    return {
      title: SESSION_UNREACHABLE_TITLE,
      detail:
        `${NO_ANSWER_SENTENCE} Nothing was ${context.stage === 'quote' ? 'signed' : 'sent'}.` +
        (technical ? `\n\nTechnical detail: ${technical}` : ''),
    };
  }
  const described = describeSend(error, context.symbol);
  return context.stage === 'quote' ? retitleQuoteFailure(described) : described;
}


/**
 * readSessionStatus for readAtInclusionBlock: an 'unknown' answer (which is
 * how a read the node could not serve yet shows up) is thrown so the read
 * is retried; after the wait, the last answer is used as it is.
 */
async function definiteSessionStatus(node: JsonRpcTransport, record: SessionRecord): Promise<SessionChainStatus> {
  const status = await readSessionStatus(node, record);
  if (status.kind === 'unknown') throw new Error(status.reason);
  return status;
}

export function sessionStatusText(status: SessionChainStatus): string {
  if (status.kind === 'active') return status.expired ? 'Active on-chain, but expired (revoke to clean up)' : 'Active';
  if (status.kind === 'revoked') return 'Revoked';
  if (status.kind === 'not-installed') return 'Not installed on-chain';
  return `Status unknown: ${status.reason}`;
}

// ---------------------------------------------------------------------------
// Session-signed operations (the owner key is never involved)
// ---------------------------------------------------------------------------

/** One allowed call as a test call: value 0, the selector alone as calldata (or none). */
export function sessionTestCall(call: SessionAllowedCall): Call {
  return {
    to: call.target,
    value: 0n,
    data: call.selector === null ? new Uint8Array(0) : toBytes(call.selector),
  };
}

/**
 * Signs and submits `calls` with the SESSION key. Order matters:
 *   1. the calls are checked against the stored grant locally (engine
 *      assertCallsAllowed) — a call outside the grant throws here, before
 *      any network request and before the vault is read;
 *   2. the node's chain id is read (the first network request) and must
 *      be the record's chain;
 *   3. the session key is loaded from the vault and must derive to the
 *      grant's session address;
 *   4. a SmartAccountClient is built around the engine's kernelSessionSpec
 *      (signs only with that key, checks the grant again, routes the nonce
 *      to the permission's nonce key via routeNode) and sendCalls runs the
 *      usual stub → estimate → sign → submit. No paymaster: session
 *      operations are paid by the account (GasPolicy / paymaster interplay
 *      was not run live; engine caveat).
 * Every node request of the engine's SmartAccountClient.sendCalls (the
 * account's code, its nonce, the EntryPoint deposit) happens BEFORE the
 * operation is handed to the bundler with eth_sendUserOperation, its last
 * step (packages/chains-evm/src/smart-account.ts sendCalls), so a node
 * failure here always means nothing was submitted.
 * The owner key is never requested: there is no signWith here and the
 * spec refuses any other signer.
 */
export async function sendSessionCalls(args: {
  bundle: Pick<AaClientBundle, 'node' | 'bundler' | 'chainId'>;
  record: SessionRecord;
  calls: Call[];
  vault: SessionKeyVault;
  /** Unix seconds for the local grant check. */
  now?: number;
}): Promise<{ userOpHash: string; client: SmartAccountClient }> {
  const { record, bundle } = args;
  // Mainnet readiness: using a session key is refused where session keys
  // are not allowed (revoking one never is), before the vault is read.
  assertFeatureAllowed('session-keys', record.chain);
  assertFeatureAllowed('session-keys', eip155Caip2(bundle.chainId));
  const grant = parseSessionKeyGrant(record.grant);
  assertCallsAllowed(grant, args.calls, args.now ?? Math.floor(Date.now() / 1000));
  if (record.localStatus === 'revoking' || record.localStatus === 'revoked') {
    throw new Error('This session was revoked.');
  }
  if (!record.keyHeld) {
    throw new Error(
      record.source === 'subscription'
        ? 'This subscription’s key was handed to the merchant and is no longer on this device.'
        : record.source === 'recurring'
          ? 'This recurring payment’s key is no longer on this device (it was revoked or removed), so it cannot pay.'
          : record.source === 'erc7715'
            ? 'This session’s key is held by the dApp that requested it, not by this wallet.'
            : 'This session’s key is no longer on this device.',
    );
  }
  if (eip155Decimal(record.chain) !== bundle.chainId) {
    throw new Error('This session belongs to another network.');
  }
  // Every node error of this send is marked as the node's (markNodeErrors)
  // and every bundler error with its method (markBundlerErrors), so a caller
  // can tell "nothing was handed to the bundler" from "the outcome is open"
  // (recurring.ts describeRecurringPaymentError) and fail over only on the
  // node.
  const node = markNodeErrors(bundle.node);
  const bundler = markBundlerErrors(bundle.bundler);
  const nodeClient = new NodeClient(node);
  // The endpoint's chain is checked BEFORE the key is read: a node that
  // cannot be reached (or serves another chain) is found before any system
  // prompt for the key, so a failover to another endpoint does not ask for
  // the key twice in the common case. The fees are read after the key (as
  // before), so they are as fresh as possible when the operation is signed.
  const reported = await nodeClient.chainId();
  if (reported !== bundle.chainId) {
    throw new Error(`Endpoint is chain id ${reported}, expected ${bundle.chainId}.`);
  }
  const stored = await args.vault.load(sessionVaultId(record.chain, record.account, record.permissionId));
  if (!stored) throw new Error('The session key is not on this device (it may have been deleted).');
  const keyBytes = toBytes(stored);
  let sessionAccount: DerivedAccount;
  try {
    sessionAccount = createSessionKeyAccount(keyBytes);
  } finally {
    keyBytes.fill(0);
  }
  if (!same(sessionAccount.address, grant.sessionKey)) {
    throw new Error('The stored session key does not match this session. Nothing was signed.');
  }
  const spec = kernelSessionSpec({
    account: record.account,
    sessionKey: grant.sessionKey,
    permissionId: record.permissionId,
    grant,
    ...(args.now !== undefined ? { now: () => args.now! } : {}),
  });
  // No quote is shown for a session-key operation; the fees are read here,
  // right before sending, with the same floor rule as every smart-account
  // quote (aa.ts quoteFeesOverFloor, which also meets a bundler's
  // maxFeePerGas minimum).
  const [suggested, floor] = await Promise.all([suggestFeesRetryingOnce(nodeClient), bundlerFeeFloor(bundler)]);
  const fees = quoteFeesOverFloor(suggested, floor);
  const client = new SmartAccountClient({
    chainId: bundle.chainId,
    entryPoint: ENTRYPOINT_V07,
    bundler,
    node: spec.routeNode(node),
    spec,
    // Same deposit top-up headroom as the owner-signed clients in aa.ts: a
    // bundler's estimate omits the EntryPoint deposit top-up that validation
    // performs at real fees, so the signed verification gas needs this margin
    // whenever the account's deposit is below the required prefund.
    depositTopUpVerificationGas: AA_DEPOSIT_TOPUP_VERIFICATION_GAS,
  });
  const { userOpHash } = await client.sendCalls(sessionAccount, args.calls, fees);
  return { userOpHash, client };
}

/** The uint192 EntryPoint nonce key a session's operations use (display / checks). */
export function sessionOperationNonceKey(record: SessionRecord): bigint {
  return sessionNonceKey(record.permissionId);
}

/**
 * Whether the Sessions screen may offer "Test this session". Never for a
 * subscription or a recurring payment: the only allowed call is a payment,
 * and any operation — even a zero-value one — would use up one of the
 * rate-limited payments (RateLimitPolicy counts operations).
 */
export function sessionCanBeTested(record: SessionRecord): boolean {
  return !sessionCarriesTerms(record.source) && record.keyHeld;
}

/**
 * The revoke confirm's sentence about the session key. The old fixed text
 * ("…the session key is deleted from this device") was also shown for a
 * subscription whose key had already been handed to the merchant and was no
 * longer on the device (finding 7 of the rehearsal); it is kept verbatim for
 * sessions whose key IS on this device.
 */
export function sessionRevokeKeySentence(record: Pick<SessionRecord, 'keyHeld' | 'source' | 'subscription'>): string {
  // A recurring payment's key is the "payment key" everywhere else on its
  // screens (finding 5 of the 2026-10-09 recurring-payments rehearsal).
  if (record.source === 'recurring') {
    return record.keyHeld
      ? 'Signed by your account key. Once the bundler accepts it, the payment key is deleted from this phone.'
      : 'Signed by your account key. The payment key is no longer on this phone; once the revocation is ' +
          'included on-chain, any copy of it stops working.';
  }
  if (record.keyHeld) {
    return 'Signed by your account key. Once the bundler accepts it, the session key is deleted from this device.';
  }
  if (record.source === 'subscription' && record.subscription?.keyExportedAt != null) {
    return (
      'Signed by your account key. This device no longer holds the subscription key (it was handed to the ' +
      'merchant); once the revocation is included on-chain, the merchant’s copy stops working.'
    );
  }
  if (record.source === 'erc7715') {
    return 'Signed by your account key. The dApp holds the session key; once the revocation is included on-chain, that key stops working.';
  }
  return (
    'Signed by your account key. The session key is no longer on this device; once the revocation is ' +
    'included on-chain, any copy of it stops working.'
  );
}

export type SessionProgressKind =
  | 'install'
  | 'subscription'
  | 'revoke'
  | 'subscription-revoke'
  | 'test'
  | 'recurring'
  | 'recurring-payment'
  | 'recurring-revoke';

/** Title of the Sessions screen's progress view. */
export function sessionProgressTitle(kind: SessionProgressKind): string {
  switch (kind) {
    case 'install':
      return 'Session install sent to the bundler';
    case 'subscription':
      return 'Subscription sent to the bundler';
    case 'revoke':
      return 'Revocation sent to the bundler';
    case 'subscription-revoke':
      return 'Subscription revocation sent to the bundler';
    case 'test':
      return 'Session test operation sent to the bundler';
    case 'recurring':
      return 'Recurring payment set-up sent to the bundler';
    case 'recurring-payment':
      return 'Payment sent to the bundler';
    case 'recurring-revoke':
      return 'Recurring payment revocation sent to the bundler';
  }
}

/**
 * The revoke confirm's words (finding 7 of the 2026-10-04 emulator run: a
 * subscription's revoke said "Revoke session"). A subscription is revoked
 * with the same operation as any session, but the user knows it as a
 * subscription, so the title and the button say so.
 */
export function revokeConfirmCopy(
  record: Pick<SessionRecord, 'source'>,
  title: string,
): { heading: string; button: string } {
  if (record.source === 'subscription') return { heading: `Revoke subscription “${title}”`, button: 'Revoke subscription' };
  if (record.source === 'recurring') return { heading: `Stop recurring payment “${title}”`, button: 'Revoke recurring payment' };
  return { heading: `Revoke session “${title}”`, button: 'Revoke session' };
}

/** The biometric prompt for a revocation (subscription, recurring payment or session wording). */
export function revokeApprovalPrompt(record: Pick<SessionRecord, 'source'>): string {
  if (record.source === 'subscription') return 'Approve revoking this subscription';
  if (record.source === 'recurring') return 'Approve revoking this recurring payment';
  return 'Approve revoking this session';
}

/**
 * Deletes a session's private key from this device and records that the
 * wallet no longer holds it (used once a subscription key has been handed to
 * the merchant). The vault entry is removed FIRST, so a failure to update the
 * list can never leave a key behind that the list says is gone.
 */
export async function releaseSessionKey(
  record: SessionRecord,
  store: KeyValueStore,
  vault: SessionKeyVault,
  patch: Partial<Pick<SessionRecord, 'subscription'>> = {},
): Promise<SessionRecord> {
  // A recurring payment's key stays on this device for its whole life; it
  // leaves the vault only through revokeSession, forgetSession or a wipe.
  if (record.source === 'recurring') {
    throw new Error('A recurring payment’s key never leaves this device. Revoke the recurring payment instead.');
  }
  if (!record.keyHeld) throw new Error('This session’s key is not on this device.');
  await vault.remove(sessionVaultId(record.chain, record.account, record.permissionId));
  return updateRecord(record, { keyHeld: false, ...patch }, store);
}

// ---------------------------------------------------------------------------
// Revocation and forgetting
// ---------------------------------------------------------------------------

/** Quotes the root-signed revocation (one self-call: uninstallValidation). */
export async function prepareSessionRevoke(
  bundle: AaClientBundle,
  ownerAddress: string,
  record: SessionRecord,
): Promise<AaSendQuote> {
  if (!same(ownerAddress, record.owner)) {
    throw new Error('Only the account that granted this session can revoke it. Switch to that account.');
  }
  const quote = await prepareAaCalls(
    bundle,
    ownerAddress,
    [permissionRevokeCall(record.account, record.permissionId, record.policyCount)],
    { displayTo: record.account },
  );
  if (!same(quote.sender, record.account)) {
    throw new Error(`This network’s smart account is ${quote.sender}, not the session’s ${record.account}.`);
  }
  if (quote.eip7702?.upgrade) throw new Error(SESSION_TUPLE_REFUSAL);
  return quote;
}

/**
 * Submits a revocation (owner-signed through `submit`); once the bundler
 * accepted it, deletes the session key from the vault and marks the record
 * 'revoking'. Deleting first is the safe direction: a key that no longer
 * exists cannot be used even if the revocation were to fail.
 */
export async function revokeSession(args: {
  record: SessionRecord;
  quote: AaSendQuote;
  store: KeyValueStore;
  vault: SessionKeyVault | null;
  submit: (quote: AaSendQuote) => Promise<{ userOpHash: string }>;
}): Promise<{ record: SessionRecord; userOpHash: string }> {
  const expected = permissionRevokeCall(args.record.account, args.record.permissionId, args.record.policyCount);
  const calls = args.quote.calls;
  if (calls.length !== 1 || !same(calls[0]!.to, expected.to) || toHex(calls[0]!.data) !== toHex(expected.data) || calls[0]!.value !== 0n) {
    throw new Error('The quoted operation is not this session’s revocation. Nothing was signed.');
  }
  const { userOpHash } = await args.submit(args.quote);
  if (args.record.keyHeld && args.vault) {
    await args.vault.remove(sessionVaultId(args.record.chain, args.record.account, args.record.permissionId));
  }
  const record = await updateRecord(
    args.record,
    { keyHeld: false, localStatus: 'revoking', revokeUserOpHash: userOpHash },
    args.store,
  );
  return { record, userOpHash };
}

/** Waits for the revocation receipt and marks the record revoked once the chain agrees. */
export async function finalizeSessionRevoke(
  bundle: AaClientBundle,
  record: SessionRecord,
  store: KeyValueStore,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<{ record: SessionRecord; receipt: AaReceiptSummary; status: SessionChainStatus }> {
  if (!record.revokeUserOpHash) throw new Error('This session has no revocation to wait for.');
  const raw = await bundle.client.waitForReceipt(record.revokeUserOpHash, {
    timeoutMs: options.timeoutMs ?? 120_000,
    pollMs: options.pollMs ?? 3_000,
  });
  const receipt = summarizeAaReceipt(raw);
  const status = await readAtInclusionBlock(bundle.node, raw, (n) => definiteSessionStatus(n, record), {
    ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
  }).catch(() => readSessionStatus(bundle.node, record));
  const next =
    receipt.success === true && status.kind === 'revoked'
      ? await updateRecord(record, { localStatus: 'revoked' }, store)
      : record;
  return { record: next, receipt, status };
}

/**
 * Removes a session from the list (and its key from the vault). Refused
 * while the permission is active or its status cannot be read, so the
 * wallet never forgets something live that it could still revoke.
 */
export async function forgetSession(args: {
  record: SessionRecord;
  node: JsonRpcTransport;
  store: KeyValueStore;
  vault: SessionKeyVault | null;
}): Promise<void> {
  const status = await readSessionStatus(args.node, args.record);
  if (status.kind === 'active' || status.kind === 'unknown') {
    throw new Error(
      status.kind === 'active'
        ? 'This session is still active on-chain. Revoke it first.'
        : `The on-chain status could not be read (${status.reason}), so the session was kept.`,
    );
  }
  if (args.record.keyHeld && args.vault) {
    await args.vault.remove(sessionVaultId(args.record.chain, args.record.account, args.record.permissionId));
  }
  await writeRecord(null, sessionRecordKey(args.record.chain, args.record.account, args.record.permissionId), args.store);
}

// ---------------------------------------------------------------------------
// ERC-7715 over WalletConnect
// ---------------------------------------------------------------------------

/**
 * ERC-7715 "Request Permissions from Wallets" (Draft), ethereum/ERCs
 * ERCS/erc-7715.md at commit 2adc3783667334a371eab433fecbe9953dc848e2
 * (2026-01-16; the latest commit touching the file when read on
 * 2026-10-01). Method names and shapes used here, quoted from that text:
 *  - wallet_getSupportedExecutionPermissions: answered without UI by
 *    ./walletconnect.ts decideSupportedExecutionPermissions (shape and the
 *    ERC's "rulesTypes" spelling quirk are documented there).
 *  - wallet_requestExecutionPermissions, params PermissionRequest[] with
 *    { chainId, from?, to, permission: { type, isAdjustmentAllowed, data },
 *    rules?: [{ type, data }] }; the only rule type the ERC defines is
 *    "expiry" ({ timestamp }). `to` "identifies the DApp session account
 *    associated with the permission" — so for these sessions the dApp holds
 *    the session key, never the wallet.
 *  - Response: PermissionResponse = PermissionRequest & { context: Hex;
 *    dependencies: { factory, factoryData }[]; delegationManager }, where
 *    "`delegationManager` is required as defined in ERC-7710" and the
 *    permission is redeemed through the delegation manager's
 *    redeemDelegations. Kernel's permission validator is NOT an ERC-7710
 *    delegation manager (the session key signs UserOperations for the
 *    account instead), so this wallet CANNOT produce a compliant response:
 *    `delegationManager` is omitted rather than invented (a made-up
 *    address would send dApp transactions somewhere meaningless), and the
 *    Kernel facts a dApp needs are returned under KERNEL_SESSION_RESPONSE_KEY.
 *    Only dApps that understand Kernel session keys can use the result —
 *    the approval sheet says so (ERC7715_LIMITATION_NOTE).
 *  - "If the request is malformed or the wallet is unable/unwilling to
 *    grant permissions, wallet MUST return an error with a code as defined
 *    in ERC-1193" — see ERC7715_ERRORS in ./walletconnect.ts.
 * The wallet-defined permission type and the request→grant mapping are the
 * engine's (ERC7715_CALLS_PERMISSION_TYPE, grantFromErc7715Request,
 * grantToErc7715Request).
 */
export const ERC7715_LIMITATION_NOTE =
  'Only dApps that understand Kernel session keys can use this. ERC-7715 expects an ERC-7710 ' +
  '"delegation manager" in the answer; this wallet’s sessions are Kernel permissions instead (the ' +
  'dApp’s key signs operations for your account), so that field is left out and the dApp receives ' +
  'the Kernel permission details instead.';

/** Namespaced Kernel facts added to the response (see the comment above). */
export const KERNEL_SESSION_RESPONSE_KEY = 'shiba-wallet:kernelPermission';

/**
 * Narrows a dApp's grant when it allowed adjustment (isAdjustmentAllowed
 * true): calls can be dropped and the expiry shortened, never widened.
 */
export function narrowGrant(
  original: SessionKeyGrant,
  options: { keep: readonly boolean[]; validUntil: number },
): SessionKeyGrant {
  if (options.keep.length !== original.calls.length) throw new Error('One keep flag per allowed call is required.');
  const calls = original.calls.filter((_, i) => options.keep[i]);
  if (calls.length === 0) throw new Error('Keep at least one allowed call, or decline the request.');
  if (options.validUntil > original.validUntil) throw new Error('The expiry can only be shortened.');
  return { ...original, calls, validUntil: options.validUntil };
}

/**
 * The answer to wallet_requestExecutionPermissions once the install is
 * confirmed on-chain: the request as granted (chainId, from = the Kernel
 * account, to = the dApp's session key, the wallet permission type with the
 * granted calls, the expiry rule — via the engine's grantToErc7715Request),
 * context = the permission's Kernel validation id, dependencies = [] (the
 * account is deployed; sessions are refused otherwise), NO
 * delegationManager (see above), plus the Kernel details.
 */
export function buildErc7715Response(
  record: SessionRecord,
  options: { isAdjustmentAllowed: boolean; installTransactionHash: string | null },
): Record<string, unknown> {
  const grant = parseSessionKeyGrant(record.grant);
  const granted: Erc7715PermissionRequest = grantToErc7715Request(grant, {
    chainId: eip155Decimal(record.chain),
    account: record.account,
    isAdjustmentAllowed: options.isAdjustmentAllowed,
  });
  return {
    ...granted,
    context: toHex(permissionValidationId(record.permissionId)),
    dependencies: [],
    [KERNEL_SESSION_RESPONSE_KEY]: {
      account: record.account,
      kernelVersion: '0.3.3',
      entryPoint: ENTRYPOINT_V07,
      permissionId: record.permissionId,
      validationId: toHex(permissionValidationId(record.permissionId)),
      nonceKey: '0x' + sessionNonceKey(record.permissionId).toString(16),
      signerModule: KERNEL_PERMISSION_MODULES.ecdsaSigner,
      signatureFormat: '0xff || 65-byte EIP-191 signature of the userOpHash by the session key',
      installUserOpHash: record.installUserOpHash,
      installTransactionHash: options.installTransactionHash,
    },
  };
}
