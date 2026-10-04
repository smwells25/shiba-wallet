import AsyncStorage from '@react-native-async-storage/async-storage';
import { toChecksumAddress as checksumBytes } from '@shiba-wallet/core';
import type { FungibleAsset } from '@shiba-wallet/core';
import {
  SPENDING_LIMIT_NATIVE_TOKEN,
  SPENDING_POLICY_MAX_WINDOW_SECONDS,
  SPENDING_POLICY_MIN_WINDOW_SECONDS,
  balanceDeltasFromAssetChanges,
  evaluateSpendingPolicy,
  outflowsFromDeltas,
  simulateAssetChanges,
  toBytes,
  toHex,
  validateSpendingPolicy,
} from '@shiba-wallet/chains-evm';
import type {
  AssetChange,
  SpendingPolicyDecision,
  SpendingPolicyEntry,
  SpendingPolicyRule,
  SpendingRecord,
} from '@shiba-wallet/chains-evm';
// Explicit .ts extensions: this module is imported by
// scripts/check-spending-policy.mjs under Node's type stripping, which
// resolves relative specifiers literally.
import { addEvmSentListener, type EvmSendQuote, type EvmSentEvent } from './send.ts';
import { addAaSentListener, type AaSendQuote, type AaSentEvent } from './aa.ts';
import type { Erc20SendQuote } from './send-erc20.ts';
import type { NftSendQuote } from './send-nft.ts';
import type { KeyValueStore } from './tokens.ts';
import { knownTokensForChain } from './tokens.ts';
import { formatUnits, groupThousands } from './balances.ts';
import { simulationTransport } from './simulation.ts';
import { maskAmount } from '../config/prefs.ts';

/**
 * App-enforced spending policy (phase 12 item 3; feature 19 at the honest
 * level).
 *
 * WHAT THIS IS. Per-token caps over a rolling time window ("at most 0.1 ETH
 * per 24 hours"), set per account and per EVM network, checked by THIS APP
 * before it signs a send. The arithmetic is the engine's:
 * packages/chains-evm/src/kernel-spending.ts validateSpendingPolicy (every
 * saved list is validated by it), evaluateSpendingPolicy (the decision —
 * enforcement is always 'client-side'), balanceDeltasFromAssetChanges and
 * outflowsFromDeltas (what a simulated operation takes out of the account).
 *
 * WHAT THIS IS NOT. Nothing on-chain enforces it. Phase 11 item 1 found that
 * no deployed, audited module can enforce an account-wide limit on Kernel
 * v3.3 (ZeroDev's SpendingLimit hook implements the Kernel v3.0 postCheck
 * and reverts every operation on v3.1–v3.3; and the owner EOA can bypass any
 * validation hook with a direct transaction). So every screen says
 * SPENDING_HONESTY_SENTENCE, and nothing here claims more.
 *
 * SCOPE. A policy belongs to (CAIP-2 EVM chain, owner EOA address). The
 * owner is the active account's own Ethereum address — the key that signs
 * both its plain sends and its smart-account operations — so one policy
 * covers what leaves the EOA AND what leaves its smart account (both are
 * the same user-facing account). Bitcoin, Dogecoin and Solana are not
 * covered (the engine's rules are EVM addresses).
 *
 * WHAT COUNTS. The outflows of the transaction or operation from the
 * address that sends it: from the balance-change simulation (eth_simulateV1
 * through simulation.ts's transport and the engine's simulateAssetChanges —
 * the same computation as the confirm screen's preview card) when it is
 * available, combined with what the wallet itself can read from the
 * transaction (native value; ERC-20 transfer/transferFrom calldata; the
 * swap's quoted sell amount): per token, the LARGER of the two, so a
 * preview can add an outflow the calldata hides but can never lower what
 * the wallet knows leaves the account. Without a preview, only the
 * transaction's own amounts count, and the review says so. The network fee
 * counts only for a native-coin policy whose "count network fees" switch is
 * on (default off); the fee counted is the quote's worst case.
 *
 * HISTORY. A spend is recorded ONLY when the node accepted the transaction
 * (send.ts sendEvm → addEvmSentListener, after eth_sendRawTransaction
 * returned a hash) or the bundler accepted the operation (aa.ts sendAa →
 * addAaSentListener, after eth_sendUserOperation returned a hash). Failed or
 * refused sends are never recorded. Acceptance is not inclusion: an
 * accepted transaction that later fails still counts (the conservative
 * side). Only tokens that have a policy in the scope are recorded, and only
 * while one exists ("Sends made before a limit existed are not counted").
 * Records older than the scope's longest window are pruned.
 *
 * FAILURE MODES. Unreadable or malformed stored data fails CLOSED for the
 * check (the send is not signed; the message points at Settings, where the
 * data can be reset) — a limit that silently stops limiting would be worse.
 * A scope with no policy costs nothing: no simulation, no history.
 *
 * Deliberately free of React Native imports (AsyncStorage is injectable) so
 * scripts/check-spending-policy.mjs exercises the exact code the screens
 * run.
 */

// ---------------------------------------------------------------------------
// User-facing sentences (asserted by scripts/check-spending-policy.mjs)
// ---------------------------------------------------------------------------

/** Settings section title and screen title. */
export const SPENDING_SECTION_TITLE = 'Spending limits (this app only)';

/** Shown on every spending-limit surface (mirrors the readiness card's honesty). */
export const SPENDING_HONESTY_SENTENCE =
  'Enforced by this app only. Anyone with your recovery phrase, and keys used outside this app, ' +
  'are not limited.';

/** Settings hint above the button. */
export const SPENDING_SETTINGS_HINT =
  'Set a maximum per token over a time window (for example 0.1 ETH per 24 hours) for this ' +
  'account on this network. The app checks it before it signs a send, swap, smart-account ' +
  'operation or WalletConnect transaction.';

/** Screen explainer (below the honesty sentence). */
export const SPENDING_SCREEN_EXPLAINER =
  'A limit covers what leaves this account on this network: your own address and its smart ' +
  'account. Amounts come from the balance-change preview when the network supports it, ' +
  'otherwise from the transaction itself. Network fees count only if you switch that on for ' +
  'the network’s own coin. Only sends made in this app while a limit exists are counted. ' +
  'Bitcoin, Dogecoin and Solana are not covered.';

/** Why on-chain limits are not offered (phase 11 item 1 finding). */
export const SPENDING_NO_ONCHAIN_NOTE =
  'Limits enforced by the blockchain are not offered: no audited module that works with this ' +
  'wallet’s smart accounts exists today, and the account’s own key could bypass one anyway.';

export const SPENDING_BLOCK_TITLE = 'Over your spending limit';
export const SPENDING_UNREADABLE_TITLE = 'Spending limits could not be checked';
export const SPENDING_UNREADABLE_MESSAGE =
  'Your spending limits could not be read, so this app did not sign anything. Try again; if it ' +
  'keeps happening, open Settings → Spending limits (this app only) and reset them.';
export const SPENDING_OVERRIDE_ALLOWED_SENTENCE =
  'This limit was set up to allow “Send anyway”. Choosing it still asks for the same device ' +
  'check (fingerprint, face or passcode) as every send.';
export const SPENDING_OVERRIDE_OFF_SENTENCE =
  'To send it, raise or remove the limit in Settings → Spending limits (this app only).';
export const SPENDING_QUOTE_BASIS_NOTE =
  'The balance-change preview was not available, so only the amounts this app could read from ' +
  'the transaction itself were counted; tokens a contract call might move were not.';
export const SPENDING_REVIEW_CHECKED_NOTE = 'Checked against this send when you confirm.';
export const SPENDING_NOT_COUNTED_BEFORE_NOTE = 'Sends made before a limit existed are not counted.';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Native coin of the EVM chain, as the engine names it (the zero address). */
export const NATIVE_TOKEN = SPENDING_LIMIT_NATIVE_TOKEN;

/** App choice (not a standard): at most this many limits per account and network. */
export const MAX_SPENDING_POLICIES = 8;

/**
 * App choice: at most this many history records per account and network
 * (newest kept). At one send a minute for 30 days that is far below the
 * real rate of any wallet; it bounds storage, not the check.
 */
export const MAX_SPENDING_RECORDS = 2000;

/** Staged checks are matched to a send for this long (milliseconds). */
export const STAGE_TTL_MS = 15 * 60 * 1000;

export interface SpendingScope {
  /** CAIP-2 EVM chain id, e.g. 'eip155:11155111'. */
  chain: string;
  /** The account's own EOA address (owner of its smart account). */
  owner: string;
}

export interface SpendingPolicy {
  id: string;
  /** EIP-55 ERC-20 contract, or NATIVE_TOKEN for the chain's coin. */
  token: string;
  symbol: string;
  decimals: number;
  /** Maximum outflow per window, in the token's base units. */
  cap: bigint;
  windowSeconds: number;
  /** Offer "Send anyway" (behind the device check) when this limit blocks. Default off. */
  allowOverride: boolean;
  /** Native coin only: count the worst-case network fee too. Default off. */
  countFees: boolean;
  /** Unix seconds. */
  createdAt: number;
}

export interface SpendingPolicyInput {
  token: string;
  symbol: string;
  decimals: number;
  cap: bigint;
  windowSeconds: number;
  allowOverride?: boolean;
  countFees?: boolean;
}

export interface SpendRecord {
  token: string;
  amount: bigint;
  /** Unix seconds when the node or bundler accepted the send. */
  at: number;
  /** 'fee' records count only for native policies with countFees. */
  kind: 'transfer' | 'fee';
  /** Transaction hash or userOpHash. */
  ref: string;
}

export interface Outflow {
  token: string;
  amount: bigint;
}

export interface SpendingCall {
  to: string;
  value: bigint;
  data?: Uint8Array;
}

export interface SpendingTokenOption {
  token: string;
  symbol: string;
  decimals: number;
  /** "ETH (network coin)" / "USDC · 0xA0b8…eB48". */
  label: string;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const POLICIES_KEY = 'shiba-wallet.spending-policies.v1';
const HISTORY_KEY = 'shiba-wallet.spending-history.v1';
const STORE_VERSION = 1;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** EIP-55 form of a 0x-prefixed 20-byte hex address (core's toChecksumAddress over its bytes). */
function toChecksumAddress(address: string): string {
  return checksumBytes(toBytes(address.toLowerCase()));
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** The storage key of one account+network. */
export function scopeKey(scope: SpendingScope): string {
  if (!/^eip155:[1-9][0-9]*$/.test(scope.chain)) throw new Error(`Not an EVM chain id: ${scope.chain}`);
  if (!ADDRESS.test(scope.owner)) throw new Error(`Not an address: ${scope.owner}`);
  return `${scope.chain}|${scope.owner.toLowerCase()}`;
}

function parseScopeKey(key: string): SpendingScope | null {
  const [chain, owner, extra] = key.split('|');
  if (extra !== undefined || !chain || !owner) return null;
  if (!/^eip155:[1-9][0-9]*$/.test(chain) || !ADDRESS.test(owner)) return null;
  return { chain, owner: toChecksumAddress(owner) };
}

function sameToken(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Full-precision amount with thousands grouping ("1,234.5"). */
export function formatSpendAmount(amount: bigint, decimals: number): string {
  return groupThousands(formatUnits(amount, decimals, decimals));
}

/** "1 hour", "24 hours", "7 days", "30 days", "90 minutes", "36 hours"… */
export function windowLabel(seconds: number): string {
  if (seconds % 86400 === 0 && seconds !== 86400) {
    const days = seconds / 86400;
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  return `${seconds} seconds`;
}

/** The window picker's presets (1 h / 24 h / 7 d / 30 d); "Custom" is separate. */
export const WINDOW_PRESETS: readonly { label: string; seconds: number }[] = [
  { label: '1 hour', seconds: 3600 },
  { label: '24 hours', seconds: 86400 },
  { label: '7 days', seconds: 7 * 86400 },
  { label: '30 days', seconds: 30 * 86400 },
];

export type WindowUnit = 'minutes' | 'hours' | 'days';

/** A custom window from "N" + unit, within the engine's bounds (60 s to 366 days). */
export function parseCustomWindow(text: string, unit: WindowUnit): number {
  const trimmed = text.trim();
  if (!/^[0-9]{1,6}$/.test(trimmed)) throw new Error('Enter the window as a whole number.');
  const n = Number(trimmed);
  const seconds = n * (unit === 'minutes' ? 60 : unit === 'hours' ? 3600 : 86400);
  if (seconds < SPENDING_POLICY_MIN_WINDOW_SECONDS || seconds > SPENDING_POLICY_MAX_WINDOW_SECONDS) {
    throw new Error('The window must be between 1 minute and 366 days.');
  }
  return seconds;
}

/**
 * Tokens a policy may name on `chain`: the network's coin, the tracked
 * ERC-20 tokens on that chain (pass listTokens()), and the known test-network
 * tokens (tokens.ts KNOWN_TEST_NETWORK_TOKENS). The same list is the
 * engine's `knownTokens` at save time.
 */
export function spendingTokenOptions(
  chain: string,
  nativeSymbol: string,
  tracked: readonly FungibleAsset[],
): SpendingTokenOption[] {
  const out: SpendingTokenOption[] = [
    { token: NATIVE_TOKEN, symbol: nativeSymbol, decimals: 18, label: `${nativeSymbol} (network coin)` },
  ];
  const seen = new Set<string>();
  for (const asset of [...tracked, ...knownTokensForChain(chain)]) {
    if (asset.assetId.chainId !== chain || asset.assetId.namespace !== 'erc20') continue;
    const ref = asset.assetId.reference;
    if (!ADDRESS.test(ref) || seen.has(ref.toLowerCase())) continue;
    seen.add(ref.toLowerCase());
    const token = toChecksumAddress(ref);
    out.push({
      token,
      symbol: asset.symbol,
      decimals: asset.decimals,
      label: `${asset.symbol} · ${token.slice(0, 6)}…${token.slice(-4)}`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

type ReadOutcome<T> = { ok: true; data: Record<string, T[]> } | { ok: false; reason: 'damaged' | 'unreadable' };

function isPolicyJson(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.id === 'string' &&
    typeof p.token === 'string' &&
    ADDRESS.test(p.token) &&
    typeof p.symbol === 'string' &&
    typeof p.decimals === 'number' &&
    Number.isInteger(p.decimals) &&
    p.decimals >= 0 &&
    p.decimals <= 255 &&
    typeof p.cap === 'string' &&
    /^[0-9]{1,78}$/.test(p.cap) &&
    typeof p.windowSeconds === 'number' &&
    Number.isSafeInteger(p.windowSeconds) &&
    typeof p.allowOverride === 'boolean' &&
    typeof p.countFees === 'boolean' &&
    typeof p.createdAt === 'number' &&
    Number.isSafeInteger(p.createdAt)
  );
}

function isRecordJson(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.token === 'string' &&
    ADDRESS.test(r.token) &&
    typeof r.amount === 'string' &&
    /^[0-9]{1,78}$/.test(r.amount) &&
    typeof r.at === 'number' &&
    Number.isSafeInteger(r.at) &&
    (r.kind === 'transfer' || r.kind === 'fee') &&
    typeof r.ref === 'string'
  );
}

async function readBlob<T>(
  store: KeyValueStore,
  key: string,
  isEntry: (v: unknown) => boolean,
  revive: (v: Record<string, unknown>) => T,
): Promise<ReadOutcome<T>> {
  let raw: string | null;
  try {
    raw = await store.getItem(key);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  if (raw === null) return { ok: true, data: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'damaged' };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ok: false, reason: 'damaged' };
  const top = parsed as { version?: unknown; entries?: unknown };
  if (top.version !== STORE_VERSION || typeof top.entries !== 'object' || top.entries === null) {
    return { ok: false, reason: 'damaged' };
  }
  const data: Record<string, T[]> = {};
  for (const [k, list] of Object.entries(top.entries as Record<string, unknown>)) {
    if (!parseScopeKey(k) || !Array.isArray(list)) return { ok: false, reason: 'damaged' };
    // Strict: one malformed entry marks the whole store damaged, because a
    // limit that silently disappeared would stop limiting.
    if (!list.every(isEntry)) return { ok: false, reason: 'damaged' };
    data[k] = list.map((v) => revive(v as Record<string, unknown>));
  }
  return { ok: true, data };
}

function revivePolicy(p: Record<string, unknown>): SpendingPolicy {
  return {
    id: p.id as string,
    token: toChecksumAddress(p.token as string),
    symbol: p.symbol as string,
    decimals: p.decimals as number,
    cap: BigInt(p.cap as string),
    windowSeconds: p.windowSeconds as number,
    allowOverride: p.allowOverride as boolean,
    countFees: p.countFees as boolean,
    createdAt: p.createdAt as number,
  };
}

function reviveRecord(r: Record<string, unknown>): SpendRecord {
  return {
    token: toChecksumAddress(r.token as string),
    amount: BigInt(r.amount as string),
    at: r.at as number,
    kind: r.kind as 'transfer' | 'fee',
    ref: r.ref as string,
  };
}

const readPolicyBlob = (store: KeyValueStore) => readBlob(store, POLICIES_KEY, isPolicyJson, revivePolicy);
const readHistoryBlob = (store: KeyValueStore) => readBlob(store, HISTORY_KEY, isRecordJson, reviveRecord);

async function writePolicyBlob(store: KeyValueStore, data: Record<string, SpendingPolicy[]>): Promise<void> {
  const entries: Record<string, unknown[]> = {};
  for (const [k, list] of Object.entries(data)) {
    if (list.length === 0) continue;
    entries[k] = list.map((p) => ({ ...p, cap: p.cap.toString() }));
  }
  await store.setItem(POLICIES_KEY, JSON.stringify({ version: STORE_VERSION, entries }));
}

async function writeHistoryBlob(store: KeyValueStore, data: Record<string, SpendRecord[]>): Promise<void> {
  const entries: Record<string, unknown[]> = {};
  for (const [k, list] of Object.entries(data)) {
    if (list.length === 0) continue;
    entries[k] = list.map((r) => ({ ...r, amount: r.amount.toString() }));
  }
  await store.setItem(HISTORY_KEY, JSON.stringify({ version: STORE_VERSION, entries }));
}

// Every write goes through one queue: two sends accepted back to back must
// both land in the history (read-modify-write races would drop one).
let writeQueue: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(task, task);
  writeQueue = run.catch(() => undefined);
  return run;
}

/** Resolves once every queued write (including recordings) has finished. */
export async function flushSpendingWrites(): Promise<void> {
  await writeQueue;
}

export class SpendingStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpendingStoreError';
  }
}

const DAMAGED_WRITE_MESSAGE =
  'The saved spending limits could not be read, so nothing was changed. Reset them on this screen first.';

export interface PolicyListing {
  policies: SpendingPolicy[];
  /** True when stored data could not be read (writes refused until reset). */
  damaged: boolean;
}

/** The policies of one account+network. */
export async function listSpendingPolicies(
  scope: SpendingScope,
  store: KeyValueStore = AsyncStorage,
): Promise<PolicyListing> {
  const read = await readPolicyBlob(store);
  if (!read.ok) return { policies: [], damaged: true };
  return { policies: read.data[scopeKey(scope)] ?? [], damaged: false };
}

/** Every account+network that has at least one policy (for the screen's "elsewhere" list). */
export async function listSpendingScopes(
  store: KeyValueStore = AsyncStorage,
): Promise<{ scopes: { scope: SpendingScope; count: number }[]; damaged: boolean }> {
  const read = await readPolicyBlob(store);
  if (!read.ok) return { scopes: [], damaged: true };
  const scopes = Object.entries(read.data)
    .map(([k, list]) => ({ scope: parseScopeKey(k)!, count: list.length }))
    .filter((s) => s.count > 0);
  return { scopes, damaged: false };
}

function toRule(p: Pick<SpendingPolicy, 'token' | 'cap' | 'windowSeconds'>): SpendingPolicyRule {
  return { token: p.token, cap: p.cap, windowSeconds: p.windowSeconds };
}

/**
 * Validates a full list for one scope: the engine's validateSpendingPolicy
 * (non-empty, addresses, the account itself as a token, unknown tokens,
 * cap in 1..2^256−1, window in 60 s..366 days, one rule per token and
 * window) plus the app's own rules: at most MAX_SPENDING_POLICIES, fees only
 * on the native coin, symbol/decimals present.
 */
export function validatePolicyList(
  scope: SpendingScope,
  policies: SpendingPolicy[],
  knownTokens: readonly string[],
): void {
  if (policies.length > MAX_SPENDING_POLICIES) {
    throw new Error(`At most ${MAX_SPENDING_POLICIES} spending limits per account and network.`);
  }
  for (const p of policies) {
    if (p.countFees && !sameToken(p.token, NATIVE_TOKEN)) {
      throw new Error('Network fees can only be counted in a limit on the network’s own coin.');
    }
    if (!p.symbol.trim()) throw new Error('The token has no symbol.');
  }
  if (policies.length === 0) return;
  validateSpendingPolicy(policies.map(toRule), {
    account: scope.owner,
    knownTokens: knownTokens.filter((t) => !sameToken(t, NATIVE_TOKEN)),
  });
}

function newPolicyId(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Adds a policy (no `id`) or replaces the one with `id`. `knownTokens` are
 * the token addresses offered by spendingTokenOptions for this chain. Throws
 * (persisting nothing) when the engine or the app rules refuse the new list.
 */
export async function saveSpendingPolicy(
  scope: SpendingScope,
  input: SpendingPolicyInput & { id?: string },
  knownTokens: readonly string[],
  options: { store?: KeyValueStore; now?: number } = {},
): Promise<SpendingPolicy> {
  const store = options.store ?? AsyncStorage;
  return serialized(async () => {
    const read = await readPolicyBlob(store);
    if (!read.ok) throw new SpendingStoreError(DAMAGED_WRITE_MESSAGE);
    const key = scopeKey(scope);
    const current = read.data[key] ?? [];
    if (!ADDRESS.test(input.token)) throw new Error('Choose a token.');
    const existing = input.id ? current.find((p) => p.id === input.id) : undefined;
    if (input.id && !existing) throw new Error('That limit no longer exists.');
    const policy: SpendingPolicy = {
      id: existing?.id ?? newPolicyId(),
      token: toChecksumAddress(input.token),
      symbol: input.symbol,
      decimals: input.decimals,
      cap: input.cap,
      windowSeconds: input.windowSeconds,
      allowOverride: input.allowOverride ?? false,
      countFees: input.countFees ?? false,
      createdAt: existing?.createdAt ?? options.now ?? nowSeconds(),
    };
    const next = existing ? current.map((p) => (p.id === policy.id ? policy : p)) : [...current, policy];
    // Tokens of the OTHER saved limits stay valid even if they have since
    // left the tracked list (they were known when saved); the new or edited
    // limit must name a token offered now.
    const others = current.filter((p) => p.id !== policy.id).map((p) => p.token);
    validatePolicyList(scope, next, [...knownTokens, ...others]);
    await writePolicyBlob(store, { ...read.data, [key]: next });
    await pruneScopeHistory(store, scope, next, options.now ?? nowSeconds());
    return policy;
  });
}

/**
 * What makes an edit LOOSER than the saved limit (finding 10 of the
 * rehearsal): a higher cap, a shorter window (the same cap then allows more
 * per unit of time), turning on "Send anyway", or no longer counting network
 * fees. Each such change — and removing a limit — asks for the device check
 * first, like "Send anyway" does; tightening needs none. Which changes count
 * as loosening is a judgement call recorded here. Returns plain reasons
 * (empty when nothing loosens).
 */
export function policyLooseningReasons(
  previous: Pick<SpendingPolicy, 'cap' | 'windowSeconds' | 'allowOverride' | 'countFees'>,
  next: Pick<SpendingPolicy, 'cap' | 'windowSeconds' | 'allowOverride' | 'countFees'>,
): string[] {
  const reasons: string[] = [];
  if (next.cap > previous.cap) reasons.push('raises the limit');
  if (next.windowSeconds < previous.windowSeconds) reasons.push('shortens the time window');
  if (next.allowOverride && !previous.allowOverride) reasons.push('allows "Send anyway"');
  if (previous.countFees && !next.countFees) reasons.push('stops counting network fees');
  return reasons;
}

/** The device-check prompt for loosening an existing limit. */
export const SPENDING_LOOSEN_PROMPT = 'Loosen your spending limit';
/** The device-check prompt for removing a limit. */
export const SPENDING_REMOVE_PROMPT = 'Remove your spending limit';
/** The device-check prompt for resetting every limit. */
export const SPENDING_RESET_PROMPT = 'Reset your spending limits';

/** Removes one policy; its scope's history is pruned to what the remaining limits need. */
export async function removeSpendingPolicy(
  scope: SpendingScope,
  id: string,
  options: { store?: KeyValueStore; now?: number } = {},
): Promise<boolean> {
  const store = options.store ?? AsyncStorage;
  return serialized(async () => {
    const read = await readPolicyBlob(store);
    if (!read.ok) throw new SpendingStoreError(DAMAGED_WRITE_MESSAGE);
    const key = scopeKey(scope);
    const current = read.data[key] ?? [];
    const next = current.filter((p) => p.id !== id);
    if (next.length === current.length) return false;
    await writePolicyBlob(store, { ...read.data, [key]: next });
    await pruneScopeHistory(store, scope, next, options.now ?? nowSeconds());
    return true;
  });
}

/** Clears every policy and the whole history (Settings "Reset", and the wallet wipe). */
export async function resetSpendingLimits(store: KeyValueStore = AsyncStorage): Promise<void> {
  return serialized(async () => {
    await store.setItem(POLICIES_KEY, JSON.stringify({ version: STORE_VERSION, entries: {} }));
    await store.setItem(HISTORY_KEY, JSON.stringify({ version: STORE_VERSION, entries: {} }));
  });
}

/** True when the stored history is unreadable (the screen offers the reset). */
export async function spendingHistoryDamaged(store: KeyValueStore = AsyncStorage): Promise<boolean> {
  return !(await readHistoryBlob(store)).ok;
}

/** Drops records older than the scope's longest window, and all of them with no policy left. */
export function pruneRecords(records: SpendRecord[], policies: SpendingPolicy[], now: number): SpendRecord[] {
  if (policies.length === 0) return [];
  const longest = Math.max(...policies.map((p) => p.windowSeconds));
  const kept = records.filter((r) => r.at > now - longest);
  return kept.length > MAX_SPENDING_RECORDS ? kept.slice(kept.length - MAX_SPENDING_RECORDS) : kept;
}

async function pruneScopeHistory(
  store: KeyValueStore,
  scope: SpendingScope,
  policies: SpendingPolicy[],
  now: number,
): Promise<void> {
  const read = await readHistoryBlob(store);
  if (!read.ok) return; // left for the explicit reset
  const key = scopeKey(scope);
  const before = read.data[key] ?? [];
  const after = pruneRecords(before, policies, now);
  if (after.length === before.length) return;
  await writeHistoryBlob(store, { ...read.data, [key]: after });
}

/** The recorded spends of one scope (pruned view; nothing is written). */
export async function listSpendRecords(
  scope: SpendingScope,
  store: KeyValueStore = AsyncStorage,
): Promise<{ records: SpendRecord[]; damaged: boolean }> {
  const read = await readHistoryBlob(store);
  if (!read.ok) return { records: [], damaged: true };
  return { records: read.data[scopeKey(scope)] ?? [], damaged: false };
}

// ---------------------------------------------------------------------------
// What a transaction or operation takes out of the account
// ---------------------------------------------------------------------------

const TRANSFER_SELECTOR = 'a9059cbb'; // transfer(address,uint256)
const TRANSFER_FROM_SELECTOR = '23b872dd'; // transferFrom(address,address,uint256)

function word(hex: string, index: number): string | null {
  const start = 8 + index * 64;
  const w = hex.slice(start, start + 64);
  return w.length === 64 ? w : null;
}

/**
 * Outflows the wallet can read from the calls themselves: native value, and
 * ERC-20 transfer(to, amount) / transferFrom(spender, to, amount) calldata
 * (an NFT transferFrom has the same selector; it is counted only for a
 * contract that has a policy, where it is an ERC-20). `unreadable` is true
 * when some call carries calldata that is none of these, so its token
 * effects are unknown without a simulation.
 */
export function outflowsFromCalls(
  calls: readonly SpendingCall[],
  spender: string,
): { outflows: Outflow[]; unreadable: boolean } {
  const out = new Map<string, bigint>();
  const add = (token: string, amount: bigint) => {
    if (amount <= 0n) return;
    const key = token.toLowerCase();
    out.set(key, (out.get(key) ?? 0n) + amount);
  };
  let unreadable = false;
  for (const call of calls) {
    add(NATIVE_TOKEN, call.value);
    const data = call.data && call.data.length > 0 ? toHex(call.data).slice(2).toLowerCase() : '';
    if (!data) continue;
    const sel = data.slice(0, 8);
    if (sel === TRANSFER_SELECTOR && data.length === 8 + 128) {
      add(call.to, BigInt(`0x${word(data, 1)}`));
    } else if (sel === TRANSFER_FROM_SELECTOR && data.length === 8 + 192) {
      const from = `0x${word(data, 0)!.slice(24)}`;
      if (sameToken(from, spender)) add(call.to, BigInt(`0x${word(data, 2)}`));
    } else {
      unreadable = true;
    }
  }
  return {
    outflows: [...out.entries()].map(([token, amount]) => ({ token: toChecksumAddress(token), amount })),
    unreadable,
  };
}

/** Per token, the larger amount of the two lists. */
export function mergeOutflowsMax(a: readonly Outflow[], b: readonly Outflow[]): Outflow[] {
  const out = new Map<string, Outflow>();
  for (const o of [...a, ...b]) {
    const key = o.token.toLowerCase();
    const prev = out.get(key);
    if (!prev || o.amount > prev.amount) out.set(key, { token: toChecksumAddress(o.token), amount: o.amount });
  }
  return [...out.values()];
}

/** The engine's view of what simulated changes take out of `spender`. */
export function outflowsFromPreview(changes: AssetChange[], spender: string): Outflow[] {
  return outflowsFromDeltas(balanceDeltasFromAssetChanges(changes, spender));
}

/** The calls, sender and fee of any EVM confirm-screen quote. */
export function spendingInputForQuote(
  quote: EvmSendQuote | Erc20SendQuote | NftSendQuote | AaSendQuote,
  from: string,
): { spender: string; calls: SpendingCall[]; fee: bigint } {
  if (quote.kind === 'aa') {
    return { spender: quote.sender, calls: quote.calls, fee: quote.sponsored ? 0n : quote.fee };
  }
  if (quote.kind === 'evm') {
    return {
      spender: from,
      calls: [{ to: quote.to, value: quote.amount, ...(quote.data ? { data: quote.data } : {}) }],
      fee: quote.fee,
    };
  }
  // ERC-20 and NFT: value 0 to the contract, carrying the transfer calldata.
  return { spender: from, calls: [{ to: quote.contract, value: 0n, data: quote.data }], fee: quote.fee };
}

function callsFingerprint(chain: string, spender: string, calls: readonly SpendingCall[]): string {
  return (
    `${chain}|${spender.toLowerCase()}|` +
    calls
      .map((c) => `${c.to.toLowerCase()}:${c.value}:${c.data && c.data.length > 0 ? toHex(c.data) : '0x'}`)
      .join(',')
  );
}

// ---------------------------------------------------------------------------
// Staging: what the check counted, matched to the send that follows
// ---------------------------------------------------------------------------

interface StagedSpend {
  outflows: Outflow[];
  fee: bigint;
  stagedAt: number;
}

// In memory only. Keyed by the exact calls (chain, sender, to, value, data),
// so a staged check can only ever be recorded for the very transaction or
// operation it evaluated.
const staged = new Map<string, StagedSpend>();

function stage(fingerprint: string, spend: Omit<StagedSpend, 'stagedAt'>): void {
  const nowMs = Date.now();
  for (const [k, v] of staged) if (nowMs - v.stagedAt > STAGE_TTL_MS) staged.delete(k);
  staged.set(fingerprint, { ...spend, stagedAt: nowMs });
}

function takeStaged(fingerprint: string): StagedSpend | null {
  const s = staged.get(fingerprint);
  staged.delete(fingerprint);
  if (!s || Date.now() - s.stagedAt > STAGE_TTL_MS) return null;
  return s;
}

/** Test hook: forget every staged check. */
export function clearStagedSpends(): void {
  staged.clear();
}

// ---------------------------------------------------------------------------
// Recording (only after acceptance)
// ---------------------------------------------------------------------------

/**
 * Appends an ACCEPTED send to the history: the outflows the check staged for
 * exactly these calls, else what the calls themselves show. Only tokens with
 * a policy in the scope are kept; a fee record is added when the scope has a
 * native-coin policy (so switching "count network fees" on later has data).
 * Does nothing when the scope has no policy, and never throws (bookkeeping
 * must not turn an accepted send into an error).
 */
export async function recordAcceptedSpend(options: {
  scope: SpendingScope;
  spender: string;
  calls: readonly SpendingCall[];
  fee: bigint;
  ref: string;
  store?: KeyValueStore;
  now?: number;
}): Promise<void> {
  const store = options.store ?? AsyncStorage;
  const fingerprint = callsFingerprint(options.scope.chain, options.spender, options.calls);
  const stagedSpend = takeStaged(fingerprint);
  try {
    await serialized(async () => {
      const policiesRead = await readPolicyBlob(store);
      if (!policiesRead.ok) return;
      const policies = policiesRead.data[scopeKey(options.scope)] ?? [];
      if (policies.length === 0) return;
      const historyRead = await readHistoryBlob(store);
      if (!historyRead.ok) return; // fail-closed at check time already covers this
      const now = options.now ?? nowSeconds();
      const outflows = stagedSpend?.outflows ?? outflowsFromCalls(options.calls, options.spender).outflows;
      const fee = stagedSpend?.fee ?? options.fee;
      const covered = (token: string) => policies.some((p) => sameToken(p.token, token));
      const fresh: SpendRecord[] = outflows
        .filter((o) => o.amount > 0n && covered(o.token))
        .map((o) => ({ token: toChecksumAddress(o.token), amount: o.amount, at: now, kind: 'transfer' as const, ref: options.ref }));
      if (fee > 0n && covered(NATIVE_TOKEN)) {
        fresh.push({ token: NATIVE_TOKEN, amount: fee, at: now, kind: 'fee', ref: options.ref });
      }
      const key = scopeKey(options.scope);
      const merged = pruneRecords([...(historyRead.data[key] ?? []), ...fresh], policies, now);
      await writeHistoryBlob(store, { ...historyRead.data, [key]: merged });
    });
  } catch {
    // Best effort, see above.
  }
}

/** sendEvm listener: the EOA's own transaction, accepted by the node. */
export function evmSentRecorder(store: KeyValueStore = AsyncStorage): (event: EvmSentEvent) => Promise<void> {
  return (event) => {
    const input = spendingInputForQuote(event.quote, event.from);
    return recordAcceptedSpend({
      scope: { chain: `eip155:${event.quote.chainId}`, owner: event.from },
      spender: input.spender,
      calls: input.calls,
      fee: input.fee,
      ref: event.txid,
      store,
    });
  };
}

/** sendAa listener: the smart account's operation, accepted by the bundler. */
export function aaSentRecorder(store: KeyValueStore = AsyncStorage): (event: AaSentEvent) => Promise<void> {
  return (event) => {
    const input = spendingInputForQuote(event.quote, event.owner.address);
    return recordAcceptedSpend({
      scope: { chain: `eip155:${event.bundle.chainId}`, owner: event.owner.address },
      spender: input.spender,
      calls: input.calls,
      fee: input.fee,
      ref: event.userOpHash,
      store,
    });
  };
}

/**
 * Subscribes the recorders to send.ts and aa.ts (once, at app start —
 * WalletContext). Returns the unsubscribe function.
 */
export function installSpendingRecorder(store: KeyValueStore = AsyncStorage): () => void {
  const offEvm = addEvmSentListener(evmSentRecorder(store));
  const offAa = addAaSentListener(aaSentRecorder(store));
  return () => {
    offEvm();
    offAa();
  };
}

// ---------------------------------------------------------------------------
// The check (before signing)
// ---------------------------------------------------------------------------

export interface SpendingPolicyResult {
  policy: SpendingPolicy;
  /** The engine's entry (spentInWindow, proposed, remainingAfter, exceeds). */
  entry: SpendingPolicyEntry;
}

export type SpendingCheck =
  | { status: 'no-policy' }
  | { status: 'unreadable'; title: string; message: string }
  | {
      status: 'allowed' | 'blocked';
      /** The engine decision(s), merged in policy order; enforcement is always 'client-side'. */
      decision: SpendingPolicyDecision;
      results: SpendingPolicyResult[];
      /** 'preview' when the simulation's changes were used, else 'quote'. */
      basis: 'preview' | 'quote';
      outflows: Outflow[];
      /** True only when every exceeding policy allows "Send anyway". */
      overrideAllowed: boolean;
      /** Plain sentences for the alert (blocked) — null when allowed. */
      title: string | null;
      message: string | null;
      /** SPENDING_QUOTE_BASIS_NOTE when the basis is 'quote' and some calldata was unreadable. */
      note: string | null;
    };

export interface SpendingCheckInput {
  scope: SpendingScope;
  /** Address the value leaves from: the EOA, or the smart account. */
  spender: string;
  /** The exact calls that will be signed. */
  calls: readonly SpendingCall[];
  /** Worst-case network fee in native base units (0 when sponsored). */
  fee: bigint;
  /** Simulated changes from the preview, when the caller already has them. */
  previewChanges?: AssetChange[] | null;
  /** Extra outflows the caller knows (the swap's quoted sell amount). */
  quoteOutflows?: readonly Outflow[];
  /**
   * The quote's endpoint: when no previewChanges are given and a policy
   * exists, the check runs the same eth_simulateV1 preview against it.
   */
  url?: string | null;
  store?: KeyValueStore;
  now?: number;
  fetchFn?: typeof fetch;
  /**
   * False for a look-ahead that is not followed by signing (the confirm
   * screen's early warning): the counted outflows are then NOT staged for
   * the recorder. Default true.
   */
  stage?: boolean;
}

async function simulateOutflows(
  url: string,
  spender: string,
  calls: readonly SpendingCall[],
  fetchFn?: typeof fetch,
): Promise<AssetChange[] | null> {
  try {
    const result = await simulateAssetChanges(
      simulationTransport(url, fetchFn),
      calls.map((c) => ({
        from: spender,
        to: c.to,
        value: c.value,
        ...(c.data && c.data.length > 0 ? { data: c.data } : {}),
      })),
      spender,
    );
    // A reverted call's changes are discarded by the engine; such a
    // simulation says nothing reliable about the real outflow.
    if (!result.ok) return null;
    return result.changes;
  } catch {
    return null;
  }
}

/** The sentence for one exceeding policy (exact amounts; the alert follows an explicit tap). */
export function overLimitSentence(policy: SpendingPolicy, entry: SpendingPolicyEntry): string {
  const s = policy.symbol;
  const fmt = (n: bigint) => formatSpendAmount(n, policy.decimals);
  return (
    `This send would go over your spending limit for ${s}: ${fmt(policy.cap)} ${s} per ` +
    `${windowLabel(policy.windowSeconds)}. Already spent in this window: ${fmt(entry.spentInWindow)} ${s}; ` +
    `this send: ${fmt(entry.proposed)} ${s}${policy.countFees ? ' (network fee included)' : ''}.`
  );
}

/**
 * The decision before signing. Order at the call sites: after the eth_call
 * (or bundler-estimate) gate, before the biometric gate. Uses the engine's
 * evaluateSpendingPolicy, once for the policies that ignore fees and once
 * (with fee records and the quoted fee) for native policies that count them.
 * Also stages the counted outflows for the recorder (in memory; recorded
 * only if the node or bundler accepts the send).
 */
export async function evaluateBeforeSigning(input: SpendingCheckInput): Promise<SpendingCheck> {
  const store = input.store ?? AsyncStorage;
  const now = input.now ?? nowSeconds();
  const key = scopeKey(input.scope);
  const policiesRead = await readPolicyBlob(store);
  if (!policiesRead.ok) {
    return { status: 'unreadable', title: SPENDING_UNREADABLE_TITLE, message: SPENDING_UNREADABLE_MESSAGE };
  }
  const policies = policiesRead.data[key] ?? [];
  if (policies.length === 0) return { status: 'no-policy' };
  const historyRead = await readHistoryBlob(store);
  if (!historyRead.ok) {
    return { status: 'unreadable', title: SPENDING_UNREADABLE_TITLE, message: SPENDING_UNREADABLE_MESSAGE };
  }
  const history = historyRead.data[key] ?? [];

  const fromCalls = outflowsFromCalls(input.calls, input.spender);
  const known = mergeOutflowsMax(fromCalls.outflows, input.quoteOutflows ?? []);
  let changes = input.previewChanges ?? null;
  if (!changes && input.url) changes = await simulateOutflows(input.url, input.spender, input.calls, input.fetchFn);
  const basis: 'preview' | 'quote' = changes ? 'preview' : 'quote';
  const outflows = changes ? mergeOutflowsMax(outflowsFromPreview(changes, input.spender), known) : known;

  const asRecord = (r: SpendRecord): SpendingRecord => ({ token: r.token, amount: r.amount, at: r.at });
  const transferHistory = history.filter((r) => r.kind === 'transfer').map(asRecord);
  const allHistory = history.map(asRecord);
  const plain = policies.filter((p) => !p.countFees);
  const withFees = policies.filter((p) => p.countFees);
  const entryOf = new Map<string, SpendingPolicyEntry>();
  if (plain.length > 0) {
    const d = evaluateSpendingPolicy(plain.map(toRule), transferHistory, outflows, now);
    plain.forEach((p, i) => entryOf.set(p.id, d.entries[i]!));
  }
  if (withFees.length > 0) {
    const proposed = input.fee > 0n ? [...outflows, { token: NATIVE_TOKEN, amount: input.fee }] : outflows;
    const d = evaluateSpendingPolicy(withFees.map(toRule), allHistory, proposed, now);
    withFees.forEach((p, i) => entryOf.set(p.id, d.entries[i]!));
  }
  const results = policies.map((policy) => ({ policy, entry: entryOf.get(policy.id)! }));
  const decision: SpendingPolicyDecision = {
    allowed: !results.some((r) => r.entry.exceeds),
    enforcement: 'client-side',
    entries: results.map((r) => r.entry),
  };
  if (input.stage !== false) {
    stage(callsFingerprint(input.scope.chain, input.spender, input.calls), { outflows, fee: input.fee });
  }

  const note = basis === 'quote' && fromCalls.unreadable ? SPENDING_QUOTE_BASIS_NOTE : null;
  if (decision.allowed) {
    return { status: 'allowed', decision, results, basis, outflows, overrideAllowed: false, title: null, message: null, note };
  }
  const exceeding = results.filter((r) => r.entry.exceeds);
  const overrideAllowed = exceeding.every((r) => r.policy.allowOverride);
  const message = [
    ...exceeding.map((r) => overLimitSentence(r.policy, r.entry)),
    SPENDING_HONESTY_SENTENCE,
    ...(note ? [note] : []),
    overrideAllowed ? SPENDING_OVERRIDE_ALLOWED_SENTENCE : SPENDING_OVERRIDE_OFF_SENTENCE,
  ].join('\n\n');
  return {
    status: 'blocked',
    decision,
    results,
    basis,
    outflows,
    overrideAllowed,
    title: SPENDING_BLOCK_TITLE,
    message,
    note,
  };
}

/**
 * The confirm screen's early warning (finding 12 of the rehearsal): one line
 * per limit this send would exceed, shown BEFORE the user taps Send. Amounts
 * are masked under Hide amounts (the line is passive; the alert after the tap
 * keeps exact figures). The look-ahead counts only the amounts the quote
 * itself carries (no simulation), so the tap's check — which also uses the
 * preview — can still find more; the line says so.
 */
export function overLimitPreviewLines(check: SpendingCheck, hidden: boolean): string[] {
  if (check.status !== 'blocked') return [];
  return check.results
    .filter((r) => r.entry.exceeds)
    .map((r) => {
      const s = r.policy.symbol;
      const fmt = (n: bigint) => maskAmount(formatSpendAmount(n, r.policy.decimals), hidden);
      return (
        `This send would go over the limit for ${s} (${fmt(r.policy.cap)} ${s} per ` +
        `${windowLabel(r.policy.windowSeconds)}): already spent ${fmt(r.entry.spentInWindow)} ${s}, this send ` +
        `${fmt(r.entry.proposed)} ${s}${r.policy.countFees ? ' with the network fee' : ''}. ` +
        (r.policy.allowOverride
          ? 'Tapping Send will ask whether to send anyway.'
          : 'Tapping Send will stop it; raise or remove the limit first.')
      );
    });
}

// ---------------------------------------------------------------------------
// Readouts ("Spent in the current window")
// ---------------------------------------------------------------------------

export interface SpendingReadout {
  policy: SpendingPolicy;
  spentInWindow: bigint;
}

/** Spent per policy right now (the engine with nothing proposed). */
export async function spendingReadouts(
  scope: SpendingScope,
  options: { store?: KeyValueStore; now?: number } = {},
): Promise<{ readouts: SpendingReadout[]; damaged: boolean }> {
  const store = options.store ?? AsyncStorage;
  const now = options.now ?? nowSeconds();
  const policiesRead = await readPolicyBlob(store);
  const historyRead = await readHistoryBlob(store);
  if (!policiesRead.ok || !historyRead.ok) return { readouts: [], damaged: true };
  const key = scopeKey(scope);
  const policies = policiesRead.data[key] ?? [];
  const history = historyRead.data[key] ?? [];
  const readouts = policies.map((policy) => {
    const relevant = history
      .filter((r) => policy.countFees || r.kind === 'transfer')
      .map((r) => ({ token: r.token, amount: r.amount, at: r.at }));
    const d = evaluateSpendingPolicy([toRule(policy)], relevant, [], now);
    return { policy, spentInWindow: d.entries[0]!.spentInWindow };
  });
  return { readouts, damaged: false };
}

/** "Spent in the current window: 0.03 of 0.1 ETH" — amounts masked under Hide amounts. */
export function spentReadoutText(readout: SpendingReadout, hidden: boolean): string {
  const { policy } = readout;
  const spent = maskAmount(formatSpendAmount(readout.spentInWindow, policy.decimals), hidden);
  const cap = maskAmount(formatSpendAmount(policy.cap, policy.decimals), hidden);
  return `Spent in the current window: ${spent} of ${cap} ${policy.symbol}`;
}

/** "0.1 ETH per 24 hours" — masked under Hide amounts. */
export function policySummary(policy: SpendingPolicy, hidden: boolean): string {
  return `${maskAmount(formatSpendAmount(policy.cap, policy.decimals), hidden)} ${policy.symbol} per ${windowLabel(policy.windowSeconds)}`;
}
