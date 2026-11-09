// Explicit .ts extensions: scripts/check-insights.mjs loads this module under
// Node's type stripping, which resolves relative specifiers literally.
import { t } from '../i18n/index.ts';
import { spokenMaskedText, withShortAddresses } from '../a11y.ts';
import { maskAmount } from '../config/prefs.ts';
import { describeDefaultFallbackNote, endpointHost, type DefaultChoice } from '../config/endpoint-probe.ts';
import { describeAge } from './prices.ts';
import { formatMoney, moneyCompare, type Money, type PortfolioSummary } from './portfolio.ts';
import {
  describeApprovalAmount,
  isUnlimitedNow,
  partitionApprovals,
  refusedNote,
  scannedRangeNote,
  type ApprovalItem,
  type ApprovalScan,
} from './approvals.ts';
import { describeProtectionStatus } from './phrase-protection-copy.ts';
import { USEROP_UNKNOWN_AFTER_MS, type PendingRegistry } from './pending-transactions.ts';
import type { PriceAlertBook } from './price-alerts.ts';
import type { StorageProtection } from './storage.ts';
import type { LockKind } from './pin.ts';

/**
 * Portfolio insights and risk overview (phase 25 item 2, feature 99): ONE
 * read-only screen that states what the wallet already knows about where the
 * value sits and what could put it at risk.
 *
 * NO REQUEST OF ITS OWN. Every line is built from data the wallet already
 * read or stored:
 *  - concentration: the Portfolio screen's last COMPLETE reading in this
 *    session (recordPortfolioSnapshot, kept in memory only), never a new
 *    balance or price read;
 *  - token approvals: the Approvals screen's last search in this session for
 *    the same account and network (recordApprovalsSnapshot, memory only);
 *  - the phrase's protection (storage.ts storageProtection, the same read
 *    Settings makes), the app lock (the PIN record's presence and kind, read
 *    at launch) and auto-lock (preferences);
 *  - broadcasts waiting or with an unknown outcome (the pending registry,
 *    pending-transactions.ts, as stored);
 *  - the default endpoints as the last check in this session left them
 *    (config/networks.ts peekEndpointHealth: storage plus the default
 *    resolver's in-memory cache, never a probe);
 *  - watched, imported, multi-signature and hidden accounts (the account
 *    list); spending limits and price alerts (as stored); the active network
 *    (preferences and config/readiness.ts isTestNetwork).
 * When a snapshot does not exist the line says so and names the screen that
 * makes it ("see Portfolio", "see Approvals"); it never reads in its place.
 *
 * HONESTY RULES (the Portfolio screen's): a read that failed is "could not be
 * read", never a figure; test assets are "test, no value" and never in a
 * share; an unpriced asset is named, not valued; Hide amounts masks every
 * amount, every dollar value and every share (a share of net worth tells
 * how the holdings are split, so it is masked with them); every line is a
 * statement, never advice beyond naming the screen to open, and nothing is
 * scored, ranked or coloured. The one ordering rule is written on the
 * screen: unlimited token approvals are listed first.
 *
 * EXACTNESS. Shares are exact fractions of the exact Money values the
 * Portfolio screen computed (portfolio.ts), rounded to a tenth of a percent
 * only for display.
 *
 * PRIVACY OF THE SNAPSHOTS. They live in this module's memory only (no
 * storage key), keyed by the storage profile (store-keys.ts: the duress
 * wallet's profile never sees the primary wallet's snapshot) and by the
 * accounts and network they were read for. They are gone when the app's
 * process ends.
 *
 * Free of React Native imports so scripts/check-insights.mjs runs it under
 * plain Node with fakes.
 */

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** One source's answer: a value, or why it could not be read. */
export type Read<T> = { status: 'ok'; value: T } | { status: 'error'; message: string };

/** The stored and in-memory sources the screen reads (each injected, so the check drives them with fakes). */
export interface InsightReaders {
  protection: () => Promise<StorageProtection>;
  pending: () => Promise<PendingRegistry>;
  spendingScopes: () => Promise<{ scopes: { scope: { chain: string; owner: string }; count: number }[]; damaged: boolean }>;
  priceAlerts: () => Promise<PriceAlertBook>;
  endpoints: () => Promise<readonly EndpointHealthLine[]>;
}

/** The parts of config/networks.ts EndpointHealthPeek the lines use. */
export interface EndpointHealthLine {
  label: string;
  defaultUrls: readonly string[];
  overrideUrl: string | null;
  choice: DefaultChoice | null;
}

export interface InsightReads {
  protection: Read<StorageProtection>;
  pending: Read<PendingRegistry>;
  spendingScopes: Read<{ scopes: { scope: { chain: string; owner: string }; count: number }[]; damaged: boolean }>;
  priceAlerts: Read<PriceAlertBook>;
  endpoints: Read<readonly EndpointHealthLine[]>;
}

async function settle<T>(run: () => Promise<T>): Promise<Read<T>> {
  try {
    return { status: 'ok', value: await run() };
  } catch (e) {
    return { status: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

/** Reads every stored source, each on its own: one failing never hides the others. */
export async function readInsights(readers: InsightReaders): Promise<InsightReads> {
  const [protection, pending, spendingScopes, priceAlerts, endpoints] = await Promise.all([
    settle(readers.protection),
    settle(readers.pending),
    settle(readers.spendingScopes),
    settle(readers.priceAlerts),
    settle(readers.endpoints),
  ]);
  return { protection, pending, spendingScopes, priceAlerts, endpoints };
}

// ---------------------------------------------------------------------------
// Session snapshots (memory only)
// ---------------------------------------------------------------------------

export interface PortfolioSnapshot {
  /** The storage profile id it was read under (store-keys.ts activeStoreProfile().id). */
  profile: string;
  /** portfolioSnapshotKey of the accounts and network it was read for. */
  key: string;
  summary: PortfolioSummary;
  /** Balances the plan left unread (PORTFOLIO_MAX_READS). */
  notRead: number;
  /** Whether Show fiat values was on (with it off no price is requested). */
  showFiat: boolean;
  /** Unix ms when the reading finished. */
  at: number;
}

export interface ApprovalsSnapshot {
  profile: string;
  chainCaip2: string;
  /** The owner address searched (any case). */
  owner: string;
  scan: ApprovalScan;
  items: ApprovalItem[];
  at: number;
}

const portfolioSnapshots = new Map<string, PortfolioSnapshot>();
const approvalSnapshots = new Map<string, ApprovalsSnapshot>();
/** At most this many approvals searches are remembered (the oldest is dropped). */
export const MAX_APPROVAL_SNAPSHOTS = 8;

/**
 * The key a Portfolio reading is remembered by: every account's index,
 * address and hidden flag (the Portfolio screen's own reload key) and the
 * active EVM network.
 */
export function portfolioSnapshotKey(
  accounts: readonly { index: number; evmAddress: string | null; hidden: boolean }[],
  evmCaip2: string,
): string {
  return `${evmCaip2}|${accounts.map((a) => `${a.index}:${(a.evmAddress ?? '').toLowerCase()}:${a.hidden ? 1 : 0}`).join(',')}`;
}

/** Called by the Portfolio screen once every planned read has answered. */
export function recordPortfolioSnapshot(snapshot: PortfolioSnapshot): void {
  portfolioSnapshots.set(snapshot.profile, snapshot);
}

/** The last reading for exactly these accounts and network under this profile, or null. */
export function latestPortfolioSnapshot(profile: string, key: string): PortfolioSnapshot | null {
  const s = portfolioSnapshots.get(profile);
  return s && s.key === key ? s : null;
}

function approvalsKey(profile: string, chainCaip2: string, owner: string): string {
  return `${profile}|${chainCaip2}|${owner.toLowerCase()}`;
}

/** Called by the Approvals screen whenever its list is shown (after a search or a search further back). */
export function recordApprovalsSnapshot(snapshot: ApprovalsSnapshot): void {
  const key = approvalsKey(snapshot.profile, snapshot.chainCaip2, snapshot.owner);
  approvalSnapshots.delete(key);
  approvalSnapshots.set(key, snapshot);
  while (approvalSnapshots.size > MAX_APPROVAL_SNAPSHOTS) {
    const oldest = approvalSnapshots.keys().next().value as string;
    approvalSnapshots.delete(oldest);
  }
}

export function latestApprovalsSnapshot(profile: string, chainCaip2: string, owner: string): ApprovalsSnapshot | null {
  return approvalSnapshots.get(approvalsKey(profile, chainCaip2, owner)) ?? null;
}

/** Forgets every snapshot (the checks; nothing in the app needs it today). */
export function forgetInsightSnapshots(): void {
  portfolioSnapshots.clear();
  approvalSnapshots.clear();
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

/** A screen the line points to ("see <screen>"); the screen renders it as a button when the route is allowed. */
export type InsightLink = 'Portfolio' | 'Approvals' | 'Activity' | 'Endpoints' | 'SpendingLimits' | 'PriceAlerts';

export interface InsightLine {
  id: string;
  /** What is shown (may hold the Hide-amounts mask). */
  text: string;
  /** What a screen reader says: the masks in words, addresses shortened. */
  spoken: string;
}

export interface InsightSection {
  id: string;
  title: string;
  lines: InsightLine[];
  /** Where the section's facts come from, shown under it. */
  source: string;
  link: InsightLink | null;
}

/** The facts the lines need that are not reads (from the screen's contexts). */
export interface InsightContext {
  hidden: boolean;
  nowMs: number;
  profile: string;
  portfolioKey: string;
  evm: { caip2: string; label: string; testnet: boolean };
  solanaDevnet: boolean;
  /** The active account, or null. */
  account: { name: string; evmAddress: string | null } | null;
  counts: { watched: number; imported: number; multisig: number; hidden: number };
  appLock: { on: boolean | null; kind: LockKind };
  autoLockMs: number | null;
}

function line(id: string, text: string): InsightLine {
  return { id, text, spoken: spokenMaskedText(withShortAddresses(text)) };
}

function ageText(atMs: number, nowMs: number): string {
  const age = Math.max(0, nowMs - atMs);
  return age < 60_000 ? t('insights.age.justNow') : describeAge(age);
}

/**
 * A share of a whole as shown: a tenth of a percent, rounded half up
 * ("62.5%"); "less than 0.1%" for a positive share that rounds to zero; the
 * mask under Hide amounts. Null when the whole is not positive (no share).
 */
export function shareText(part: Money, whole: Money, hidden: boolean): string | null {
  if (whole.n <= 0n || whole.d <= 0n) return null;
  if (hidden) return maskAmount('', true);
  // part / whole × 1000, as an exact fraction: (pn·wd·1000) / (pd·wn).
  const num = part.n * whole.d * 1000n;
  const den = part.d * whole.n;
  let tenths = num / den;
  if ((num % den) * 2n >= den) tenths += 1n;
  if (tenths === 0n && part.n > 0n) return t('insights.share.below');
  return `${tenths / 10n}.${tenths % 10n}%`;
}

function list(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} ${t('common.and')} ${items[items.length - 1]!}`;
}

/** Where the value is: shares of the counted net worth by asset and by network. */
export function concentrationSection(snapshot: PortfolioSnapshot | null, ctx: InsightContext): InsightSection {
  const base = { id: 'concentration', title: t('insights.section.concentration'), link: 'Portfolio' as const };
  if (!snapshot) {
    return { ...base, lines: [line('none', t('insights.concentration.none'))], source: t('insights.source.portfolioScreen') };
  }
  const source = t('insights.source.portfolio', { age: ageText(snapshot.at, ctx.nowMs) });
  const s = snapshot.summary;
  if (!snapshot.showFiat) return { ...base, lines: [line('fiat-off', t('insights.concentration.fiatOff'))], source };
  const out: InsightLine[] = [];
  const missing = s.failedReads + s.unavailableReads + snapshot.notRead;
  if (missing > 0) out.push(line('incomplete', t('insights.concentration.incomplete', { count: missing })));
  const net = s.netWorth;
  if (net.n <= 0n) {
    out.push(line('nothing-priced', t('insights.concentration.nothingPriced')));
  } else {
    out.push(line('by-asset', t('insights.concentration.byAsset')));
    const assets = s.byAsset
      .filter((a) => a.status === 'priced' && a.value && a.value.n > 0n)
      .sort((a, b) => moneyCompare(b.value!, a.value!));
    for (const a of assets) {
      out.push(
        line(
          `asset:${a.asset.id}`,
          t('insights.concentration.line', {
            name: t('insights.concentration.assetName', { symbol: a.asset.symbol, network: a.asset.networkLabel }),
            share: shareText(a.value!, net, ctx.hidden)!,
            value: formatMoney(a.value!, { hidden: ctx.hidden }),
          }),
        ),
      );
    }
    out.push(line('by-network', t('insights.concentration.byNetwork')));
    const networks = s.byNetwork.filter((g) => g.value.n > 0n).sort((a, b) => moneyCompare(b.value, a.value));
    for (const g of networks) {
      out.push(
        line(
          `network:${g.key}`,
          t('insights.concentration.line', {
            name: g.label,
            share: shareText(g.value, net, ctx.hidden)!,
            value: formatMoney(g.value, { hidden: ctx.hidden }),
          }),
        ),
      );
    }
    out.push(line('rounding', t('insights.concentration.rounding')));
  }
  if (s.testSymbols.length > 0) out.push(line('test', t('insights.concentration.test', { list: list(s.testSymbols) })));
  if (s.unpricedSymbols.length > 0) out.push(line('no-price', t('insights.concentration.noPrice', { list: list(s.unpricedSymbols) })));
  if (ctx.counts.watched > 0) out.push(line('watched', t('insights.concentration.watched')));
  return { ...base, lines: out, source };
}

/** Active approvals in the Approvals screen's order, with every unlimited one first (the screen's stated rule). */
export function orderedActiveApprovals(items: readonly ApprovalItem[]): ApprovalItem[] {
  const { active } = partitionApprovals([...items]);
  return [...active.filter((i) => isUnlimitedNow(i)), ...active.filter((i) => !isUnlimitedNow(i))];
}

/** Token approvals of the active account on the active network, from the Approvals screen's last search. */
export function approvalsSection(snapshot: ApprovalsSnapshot | null, ctx: InsightContext): InsightSection {
  const base = { id: 'approvals', title: t('settings.section.approvals'), link: 'Approvals' as const };
  if (!ctx.account || !ctx.account.evmAddress) {
    return { ...base, lines: [line('no-account', t('insights.approvals.noAccount'))], source: t('insights.source.approvalsScreen') };
  }
  const who = { account: ctx.account.name, network: ctx.evm.label };
  if (!snapshot) {
    return { ...base, lines: [line('none', t('insights.approvals.none', who))], source: t('insights.source.approvalsScreen') };
  }
  const source = t('insights.source.approvals', { ...who, age: ageText(snapshot.at, ctx.nowMs) });
  const { active, unconfirmed } = partitionApprovals([...snapshot.items]);
  const ordered = orderedActiveApprovals(snapshot.items);
  const out: InsightLine[] = [
    line('counts', t('insights.approvals.counts', { active: active.length, unlimited: ordered.filter((i) => isUnlimitedNow(i)).length })),
  ];
  if (ordered.length === 0) out.push(line('none-active', t('insights.approvals.noneActive')));
  for (const item of ordered) {
    out.push(
      line(
        `item:${item.key}`,
        t('insights.approvals.line', {
          name: item.kind === 'erc20' ? item.symbol : item.title,
          permission: describeApprovalAmount(item, ctx.hidden),
          spender: item.kind === 'erc20' ? item.spender : item.operator,
        }),
      ),
    );
  }
  if (unconfirmed.length > 0) out.push(line('unconfirmed', t('insights.approvals.unconfirmed', { count: unconfirmed.length })));
  out.push(line('range', scannedRangeNote(snapshot.scan)));
  const refused = refusedNote(snapshot.scan);
  if (refused) out.push(line('refused', refused));
  return { ...base, lines: out, source };
}

/** The recovery phrase's protection, imported keys' storage, the app lock and auto-lock. */
export function keysSection(reads: Pick<InsightReads, 'protection'>, ctx: InsightContext): InsightSection {
  const out: InsightLine[] = [];
  if (reads.protection.status === 'error') {
    out.push(line('protection-error', t('insights.protection.error')));
  } else {
    const view = describeProtectionStatus(reads.protection.value);
    out.push(line('protection', view.text ?? t('insights.protection.none')));
    if (view.note) out.push(line('protection-note', view.note));
    if (view.importedNote) out.push(line('imported-storage', view.importedNote));
  }
  const lock =
    ctx.appLock.on === null
      ? t('insights.lock.unknown')
      : !ctx.appLock.on
        ? t('insights.lock.off')
        : ctx.appLock.kind === 'phr'
          ? t('insights.lock.passphrase')
          : t('insights.lock.pin');
  out.push(line('lock', lock));
  out.push(
    line(
      'auto-lock',
      ctx.autoLockMs === null
        ? t('insights.autoLock.off')
        : t('insights.autoLock.on', { minutes: Math.max(1, Math.round(ctx.autoLockMs / 60_000)) }),
    ),
  );
  return { id: 'keys', title: t('insights.section.keys'), lines: out, source: t('insights.source.keys'), link: null };
}

/** Broadcasts recorded as handed to the network and not yet seen included (every account and network on this phone). */
export function pendingSection(reads: Pick<InsightReads, 'pending'>, ctx: InsightContext): InsightSection {
  const base = { id: 'pending', title: t('insights.section.pending'), source: t('insights.source.pending'), link: 'Activity' as const };
  if (reads.pending.status === 'error') return { ...base, lines: [line('error', t('insights.pending.error'))] };
  const registry = reads.pending.value;
  const out: InsightLine[] = [];
  if (registry.readOnly) out.push(line('read-only', t('insights.pending.readOnly')));
  // A nonce with a speed-up or a cancellation is one waiting transaction: group by chain, sender and nonce.
  const groups = new Map<string, number>();
  let ops = 0;
  let oldOps = 0;
  for (const r of registry.records) {
    if (r.kind === 'tx') {
      const key = `${r.chain}|${r.from}|${r.nonce}`;
      const first = groups.get(key);
      groups.set(key, first === undefined ? r.sentAt : Math.min(first, r.sentAt));
    } else if (r.kind === 'userop') {
      ops += 1;
      if (ctx.nowMs - r.sentAt > USEROP_UNKNOWN_AFTER_MS) oldOps += 1;
    }
  }
  const oldTx = [...groups.values()].filter((sentAt) => ctx.nowMs - sentAt > USEROP_UNKNOWN_AFTER_MS).length;
  if (groups.size === 0 && ops === 0) {
    out.push(line('none', t('insights.pending.none')));
  } else {
    out.push(line('tx', t('insights.pending.tx', { count: groups.size, old: oldTx })));
    out.push(line('userop', t('insights.pending.userop', { count: ops, old: oldOps })));
    out.push(line('note', t('insights.pending.note')));
  }
  return { ...base, lines: out };
}

/** One line per active network: the last check of its endpoint in this session, as Settings shows it. */
export function endpointsSection(reads: Pick<InsightReads, 'endpoints'>): InsightSection {
  const base = { id: 'endpoints', title: t('settings.section.endpoints'), source: t('insights.source.endpoints'), link: 'Endpoints' as const };
  if (reads.endpoints.status === 'error') return { ...base, lines: [line('error', t('insights.endpoint.error'))] };
  const out: InsightLine[] = [];
  for (const e of reads.endpoints.value) {
    const id = `endpoint:${e.label}`;
    if (e.overrideUrl !== null) {
      out.push(line(id, t('insights.endpoint.override', { network: e.label, host: endpointHost(e.overrideUrl) })));
    } else if (e.defaultUrls.length === 0) {
      out.push(line(id, t('insights.endpoint.noneSet', { network: e.label })));
    } else if (!e.choice) {
      out.push(line(id, t('insights.endpoint.notChecked', { network: e.label })));
    } else {
      const note = describeDefaultFallbackNote(e.choice, e.defaultUrls);
      out.push(
        line(
          id,
          note
            ? t('insights.endpoint.fallback', { network: e.label, note })
            : t('insights.endpoint.ok', { network: e.label, host: endpointHost(e.defaultUrls[0]!) }),
        ),
      );
    }
  }
  return { ...base, lines: out };
}

/** Watched, imported, multi-signature and hidden accounts on this phone. */
export function accountsSection(ctx: InsightContext): InsightSection {
  return {
    id: 'accounts',
    title: t('insights.section.accounts'),
    lines: [
      line('watched', t('insights.accounts.watched', { count: ctx.counts.watched })),
      line('imported', t('insights.accounts.imported', { count: ctx.counts.imported })),
      line('multisig', t('insights.accounts.multisig', { count: ctx.counts.multisig })),
      line('hidden', t('insights.accounts.hidden', { count: ctx.counts.hidden })),
    ],
    source: t('insights.source.accounts'),
    link: null,
  };
}

/** Spending limits and price alerts, as stored. */
export function limitsSection(reads: Pick<InsightReads, 'spendingScopes' | 'priceAlerts'>, ctx: InsightContext): InsightSection {
  const out: InsightLine[] = [];
  const sp = reads.spendingScopes;
  if (sp.status === 'error' || sp.value.damaged) {
    out.push(line('limits-error', t('insights.limits.error')));
  } else if (sp.value.scopes.length === 0) {
    out.push(line('limits-none', t('insights.limits.none')));
  } else {
    const total = sp.value.scopes.reduce((n, s) => n + s.count, 0);
    out.push(line('limits', t('insights.limits.some', { scopes: sp.value.scopes.length, count: total })));
    const owner = ctx.account?.evmAddress?.toLowerCase() ?? null;
    const mine = owner ? sp.value.scopes.find((s) => s.scope.chain === ctx.evm.caip2 && s.scope.owner.toLowerCase() === owner) : undefined;
    if (ctx.account && owner) {
      out.push(line('limits-active', t('insights.limits.active', { account: ctx.account.name, network: ctx.evm.label, count: mine?.count ?? 0 })));
    }
  }
  const al = reads.priceAlerts;
  if (al.status === 'error' || al.value.damaged) out.push(line('alerts-error', t('insights.alerts.error')));
  else out.push(line('alerts', t('insights.alerts.count', { alerts: al.value.alerts.length, watched: al.value.watchlist.length })));
  return { id: 'limits', title: t('insights.section.limits'), lines: out, source: t('insights.source.limits'), link: 'SpendingLimits' };
}

/** The active network: a test network (no value) or a main network (real funds). */
export function networkSection(ctx: InsightContext): InsightSection {
  const out: InsightLine[] = [
    line('evm', ctx.evm.testnet ? t('insights.network.test', { network: ctx.evm.label }) : t('insights.network.main', { network: ctx.evm.label })),
  ];
  if (ctx.solanaDevnet) out.push(line('solana', t('insights.network.solanaDevnet')));
  return { id: 'network', title: t('insights.section.network'), lines: out, source: t('insights.source.network'), link: null };
}

/** Every section, in the screen's fixed order. */
export function buildInsightSections(args: {
  reads: InsightReads;
  portfolio: PortfolioSnapshot | null;
  approvals: ApprovalsSnapshot | null;
  ctx: InsightContext;
}): InsightSection[] {
  const { reads, ctx } = args;
  return [
    networkSection(ctx),
    concentrationSection(args.portfolio, ctx),
    approvalsSection(args.approvals, ctx),
    keysSection(reads, ctx),
    pendingSection(reads, ctx),
    endpointsSection(reads),
    accountsSection(ctx),
    limitsSection(reads, ctx),
  ];
}
