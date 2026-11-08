import { base58 } from '@scure/base';
import type { HistoryEntry, HistoryPage, HistoryProvider } from '@shiba-wallet/core';
import type { JsonRpcTransport } from './rpc.js';
import { findAssociatedTokenAddress } from './splToken.js';
import { tokenProgramId } from './tokenExtensions.js';

/**
 * Transaction history via the standard RPC methods, verified against
 * solana.com/docs/rpc:
 *  - getSignaturesForAddress(address, {limit, before}): newest-to-oldest
 *    [{signature, slot, err, memo, blockTime, confirmationStatus}]; the
 *    `before` config field pages backwards from a signature.
 *  - getTransaction(signature, {encoding: 'json', commitment,
 *    maxSupportedTransactionVersion}): meta.fee in lamports and
 *    meta.preBalances/postBalances indexed to
 *    transaction.message.accountKeys (base58 strings under json encoding).
 *
 * Amount enrichment costs one getTransaction call per entry, so it is
 * bounded by `enrichLimit` (default 10 per page); entries past the bound
 * carry no amount, and the app may re-request details lazily.
 *
 * Token transfers (pass p24-unblock finding 2). The same getTransaction
 * answer carries meta.preTokenBalances and meta.postTokenBalances, each an
 * array (or null) of token-balance objects with the fields
 *   accountIndex   index into transaction.message.accountKeys of the token
 *                  account whose balance is reported,
 *   mint           the token's mint, base-58,
 *   owner          the token account's owner, base-58 — "when the validator
 *                  recorded it. This field may be omitted.",
 *   uiTokenAmount  { amount: raw base-10 integer string, decimals: u8, … }
 * (solana.com/docs/rpc/http/gettransaction, read on 2026-11-08 from its
 * source solana-foundation/solana-com at 31f66e08,
 * apps/docs/content/docs/en/rpc/http/gettransaction.mdx lines 312–317 and
 * 351–366, because solana.com answered HTTP 429; the json-encoding example
 * there carries both arrays too). The provider pairs the two arrays by
 * accountIndex and sums, per mint, the change of every token account whose
 * owner is the queried address; a balance with no owner is never
 * attributed. A transaction that changed no such balance yields exactly the
 * entry it yielded before this was added (key for key). One that did yields
 * one token entry per mint whose balance changed (direction, assetAmount,
 * assetDecimals, contract = the mint, counterparty = the one other owner
 * whose balance of that mint moved the opposite way, when there is exactly
 * one), followed by the native entry only when lamports other than the fee
 * moved too (rent for a new token account, for example); the fee goes on
 * the native entry, or on the first token entry when no lamports moved, so
 * a token transfer never reads as a "self" entry of 0. The provider does not
 * know symbols: the app labels a mint from its own tracked and known lists.
 *
 * Plain SOL transfers (pass p24-solfix2 finding E). When no token balance of
 * the address changed and lamports other than the fee moved, the native
 * entry also names its counterparty when exactly ONE other account in
 * transaction.message.accountKeys changed by the opposite amount (the fee
 * separated from the fee payer, account 0, as for the address itself);
 * otherwise no counterparty, as before. Only the static account keys are
 * searched (pre/postBalances of addresses loaded from lookup tables have no
 * key in the json encoding's accountKeys), so nothing is guessed.
 *
 * Token accounts (pass p24-solfix2, the history gap). getSignaturesForAddress
 * "Returns confirmed transaction signatures for transactions that reference
 * the supplied address in `accountKeys`, newest first" (solana.com/docs/rpc/
 * http/getsignaturesforaddress, read on 2026-11-08 from its source
 * solana-foundation/solana-com at 31f66e08, apps/docs/content/docs/en/rpc/
 * http/getsignaturesforaddress.mdx lines 11–12, sha256 1e84d3e7…3c39). A token
 * transfer into a token account that already exists references only that
 * token account, not its owner's wallet address, so listing the wallet
 * alone misses every such incoming transfer (seen on devnet on 2026-11-08:
 * 4abaH… is listed for Account 2's USDC account Ffqp…eedc and not for its
 * wallet 9WMg…471n, on two RPCs). With `followTokenMints`, the provider
 * also lists the signatures of the address's ASSOCIATED token accounts for
 * those mints — derived with no request (findAssociatedTokenAddress, under
 * both the classic SPL Token program and Token-2022, because the program of
 * a tracked mint is not known without reading the mint; an account that
 * never existed answers an empty list once and is then done) — and merges
 * the streams. Token accounts that are not associated accounts of a
 * followed mint are not followed (the wallet never sends from them either).
 * At most SOLANA_HISTORY_MAX_FOLLOWED_MINTS mints (two accounts each) are
 * followed, in the order given; later mints are not.
 *
 * Fields relied on (the same document, lines 168–198 and 226–275): the
 * config's `limit` ("Maximum transaction signatures to return (between 1
 * and 1,000)"), `before` ("Start searching backwards from this transaction
 * signature"), the result "ordered from newest to oldest", each element's
 * `signature`, `slot` ("The slot that contains the block with the
 * transaction"), `err`, `blockTime` and `confirmationStatus`. `until` is
 * not used: every page of every stream pages backwards with `before` only.
 *
 * THE MERGE RULE (the EVM merged feed's rule, app/src/wallet/
 * smart-account-history.ts). Each followed address is a stream in slot
 * order (newest first). A stream's frontier is the slot of the oldest
 * signature fetched from it; a stream whose last request returned fewer
 * than `pageSize` signatures has no more and no frontier. The bound is the
 * HIGHEST frontier among the streams that still have more, and a signature
 * is listed only when its slot is STRICTLY above the bound — then every
 * stream has fetched every signature of that slot, so a transaction that
 * touches the wallet AND a token account is listed once (de-duplicated by
 * signature) and no later page can bring anything newer. (Strictly, not "at
 * or above": a page boundary can split one slot, and the same transaction
 * can sit in two streams, one of which has not reached it yet.) Listed
 * signatures are ordered by slot, then blockTime, newest first, then by
 * stream (the address itself first, then the token accounts in order).
 * When more than `pageSize` signatures are listable, the page ends at a
 * slot boundary (every listable signature of the slot of the pageSize-th
 * one is listed too), so no slot is split between pages. When nothing is
 * listable, the stream(s) at the bound are fetched again, within
 * SOLANA_HISTORY_MAX_SIGNATURE_REQUESTS signature requests per page (a
 * judgement); should that budget run out with nothing listable — only
 * possible when one address has more than about that many pages of
 * signatures in a single slot — the signatures AT the bound are listed too,
 * and a transaction of that slot could then appear twice across pages.
 *
 * THE CURSOR. Without followed token accounts the cursor is exactly the old
 * one: the oldest signature of a full page (a bare base-58 string). With
 * them it is JSON {"v":1,"s":[[address, before | null, done 0 | 1], …]},
 * the queried address first, then each followed token account: `before` is
 * the last signature of that stream that has been LISTED (signatures
 * fetched but not listed are fetched again next time), `done` that the
 * stream has nothing more. A bare cursor is still accepted: it continues
 * the address's own stream only, as before (that session started without
 * followed accounts, and starting one now would list newer entries after
 * older ones). In a JSON cursor, a token account the provider would not
 * derive now (a mint no longer followed) is dropped, and a newly followed
 * one is not added until the history is read again from the top; anything
 * else malformed is refused with "Unrecognized history cursor".
 *
 * Requests per page: one getSignaturesForAddress per stream that still has
 * more (1 + 2 per followed mint on the first page), a further one per
 * stream at the bound only while nothing is listable, never more than
 * SOLANA_HISTORY_MAX_SIGNATURE_REQUESTS; plus at most `enrichLimit`
 * getTransaction calls, as before.
 */

/** How many mints' associated token accounts the history follows at most (two accounts each). */
export const SOLANA_HISTORY_MAX_FOLLOWED_MINTS = 4;

/** The most getSignaturesForAddress requests one history page makes (a judgement: 2 × (1 + 2 × 4)). */
export const SOLANA_HISTORY_MAX_SIGNATURE_REQUESTS = 18;

const UNRECOGNIZED_CURSOR = 'Unrecognized history cursor';
const BASE58_TEXT = /^[1-9A-HJ-NP-Za-km-z]{1,100}$/;

interface SignatureInfo {
  signature: string;
  slot: number;
  err: unknown;
  blockTime: number | null;
  confirmationStatus: string | null;
}

interface TokenBalanceDetail {
  accountIndex?: unknown;
  mint?: unknown;
  owner?: unknown;
  uiTokenAmount?: { amount?: unknown; decimals?: unknown } | null;
}

interface TransactionDetail {
  meta: {
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: TokenBalanceDetail[] | null;
    postTokenBalances?: TokenBalanceDetail[] | null;
  } | null;
  transaction: { message: { accountKeys: string[] } };
}

export interface SolanaHistoryOptions {
  pageSize?: number;
  /** How many entries per page get amount/fee details fetched. */
  enrichLimit?: number;
  /**
   * Token mints (base-58) whose associated token accounts of the queried
   * address are listed too and merged with the address's own signatures (see
   * the module comment). Absent or empty: the provider lists the address
   * alone and its pages and cursors are exactly the old ones.
   */
  followTokenMints?: readonly string[];
}

/**
 * The associated token accounts of `owner` that the history follows for
 * `mints`: for each distinct valid mint, in the order given and at most
 * SOLANA_HISTORY_MAX_FOLLOWED_MINTS of them, the classic SPL Token account
 * and then the Token-2022 account. Derived with no request. An invalid
 * owner follows nothing.
 */
export function solanaFollowedTokenAccounts(owner: string, mints: readonly string[]): string[] {
  let ownerBytes: Uint8Array;
  try {
    ownerBytes = base58.decode(owner);
  } catch {
    return [];
  }
  if (ownerBytes.length !== 32) return [];
  const accounts: string[] = [];
  const seen = new Set<string>();
  for (const mint of mints) {
    if (seen.size >= SOLANA_HISTORY_MAX_FOLLOWED_MINTS) break;
    if (seen.has(mint) || !isValidSolanaAddress(mint)) continue;
    seen.add(mint);
    for (const kind of ['spl-token', 'token-2022'] as const) {
      const ata = findAssociatedTokenAddress({ owner: ownerBytes, mint: base58.decode(mint), tokenProgramId: tokenProgramId(kind) });
      const address = base58.encode(ata.address);
      if (address !== owner && !accounts.includes(address)) accounts.push(address);
    }
  }
  return accounts;
}

interface Stream {
  address: string;
  /** The last listed signature of this stream (where the next request starts), if any. */
  before: string | undefined;
  /** Signatures fetched this page, newest first. */
  fetched: SignatureInfo[];
  /** Whether the stream has been asked this page. */
  asked: boolean;
  /** Whether the last request returned a full page (so there may be more). */
  more: boolean;
}

/** Parses a JSON cursor into the streams it continues, or throws UNRECOGNIZED_CURSOR. */
function parseFollowCursor(cursor: string, address: string, derived: readonly string[]): { stream: Stream; done: boolean }[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor);
  } catch {
    throw new Error(UNRECOGNIZED_CURSOR);
  }
  const record = parsed as { v?: unknown; s?: unknown };
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || Object.keys(parsed).sort().join() !== 's,v' || record.v !== 1 || !Array.isArray(record.s)) {
    throw new Error(UNRECOGNIZED_CURSOR);
  }
  const list = record.s as unknown[];
  if (list.length < 1 || list.length > 1 + 2 * SOLANA_HISTORY_MAX_FOLLOWED_MINTS) throw new Error(UNRECOGNIZED_CURSOR);
  const out: { stream: Stream; done: boolean }[] = [];
  const addresses = new Set<string>();
  list.forEach((item, i) => {
    if (!Array.isArray(item) || item.length !== 3) throw new Error(UNRECOGNIZED_CURSOR);
    const [who, before, done] = item as unknown[];
    if (typeof who !== 'string' || !isValidSolanaAddress(who) || addresses.has(who)) throw new Error(UNRECOGNIZED_CURSOR);
    if (before !== null && (typeof before !== 'string' || !BASE58_TEXT.test(before))) throw new Error(UNRECOGNIZED_CURSOR);
    if (done !== 0 && done !== 1) throw new Error(UNRECOGNIZED_CURSOR);
    if (i === 0 && who !== address) throw new Error(UNRECOGNIZED_CURSOR);
    addresses.add(who);
    // A token account the provider would not follow now is dropped.
    if (i > 0 && !derived.includes(who)) return;
    out.push({ stream: { address: who, before: before ?? undefined, fetched: [], asked: false, more: false }, done: done === 1 });
  });
  return out;
}

export function solanaHistoryProvider(
  transport: JsonRpcTransport,
  options: SolanaHistoryOptions = {},
): HistoryProvider {
  const pageSize = options.pageSize ?? 25;
  const enrichLimit = options.enrichLimit ?? 10;
  const followMints = options.followTokenMints ?? [];

  async function entriesFor(infos: readonly SignatureInfo[], address: string): Promise<HistoryEntry[]> {
    const entries: HistoryEntry[] = [];
    for (let i = 0; i < infos.length; i++) {
      const info = infos[i]!;
      const base: HistoryEntry = {
        id: info.signature,
        timestamp: info.blockTime,
        confirmed:
          info.confirmationStatus === 'confirmed' ||
          info.confirmationStatus === 'finalized',
        direction: 'self',
        ...(info.err !== null && info.err !== undefined ? { failed: true } : {}),
      };
      if (i < enrichLimit) entries.push(...(await enrich(transport, base, address)));
      else entries.push(base);
    }
    return entries;
  }

  /** The address's own signatures only: exactly the provider's old page and cursor. */
  async function ownPage(address: string, cursor: string | undefined): Promise<HistoryPage> {
    const config: Record<string, unknown> = { limit: pageSize, commitment: 'confirmed' };
    if (cursor) config.before = cursor;
    const infos = (await transport('getSignaturesForAddress', [
      address,
      config,
    ])) as SignatureInfo[];
    const entries = await entriesFor(infos, address);
    const last = infos[infos.length - 1];
    return {
      entries,
      ...(infos.length === pageSize && last ? { nextCursor: last.signature } : {}),
    };
  }

  /** The address and its followed token accounts, merged (see the module comment). */
  async function mergedPage(address: string, cursor: string | undefined, derived: readonly string[]): Promise<HistoryPage> {
    const continued =
      cursor === undefined
        ? [address, ...derived].map((who) => ({ stream: { address: who, before: undefined, fetched: [], asked: false, more: false } as Stream, done: false }))
        : parseFollowCursor(cursor, address, derived);
    const streams = continued.map((c) => c.stream);
    const doneFromCursor = new Set(continued.filter((c) => c.done).map((c) => c.stream));
    let requests = 0;
    const ask = async (s: Stream): Promise<void> => {
      const config: Record<string, unknown> = { limit: pageSize, commitment: 'confirmed' };
      const from = s.fetched.length > 0 ? s.fetched[s.fetched.length - 1]!.signature : s.before;
      if (from) config.before = from;
      requests++;
      const infos = (await transport('getSignaturesForAddress', [s.address, config])) as SignatureInfo[];
      s.fetched.push(...infos);
      s.asked = true;
      s.more = infos.length === pageSize;
    };
    const hasMore = (s: Stream) => !doneFromCursor.has(s) && (!s.asked || s.more);
    const frontier = (s: Stream) => (s.fetched.length > 0 ? s.fetched[s.fetched.length - 1]!.slot : Number.POSITIVE_INFINITY);
    const bound = () => streams.filter(hasMore).reduce((max, s) => Math.max(max, frontier(s)), Number.NEGATIVE_INFINITY);
    const above = (b: number, inclusive: boolean) =>
      streams.reduce((n, s) => n + s.fetched.filter((x) => (inclusive ? x.slot >= b : x.slot > b)).length, 0);

    for (const s of streams) if (hasMore(s)) await ask(s);
    let inclusive = false;
    for (;;) {
      const b = bound();
      if (above(b, false) > 0 || streams.filter(hasMore).length === 0) break;
      const atBound = streams.filter((s) => hasMore(s) && frontier(s) === b);
      if (requests + atBound.length > SOLANA_HISTORY_MAX_SIGNATURE_REQUESTS) {
        inclusive = true;
        break;
      }
      for (const s of atBound) await ask(s);
    }
    const b = bound();
    const candidates: { info: SignatureInfo; stream: number; index: number }[] = [];
    streams.forEach((s, stream) =>
      s.fetched.forEach((info, index) => {
        if (inclusive ? info.slot >= b : info.slot > b) candidates.push({ info, stream, index });
      }),
    );
    const time = (info: SignatureInfo) => (typeof info.blockTime === 'number' ? info.blockTime : Number.NEGATIVE_INFINITY);
    candidates.sort(
      (x, y) => y.info.slot - x.info.slot || time(y.info) - time(x.info) || x.stream - y.stream || x.index - y.index,
    );
    const cutSlot = candidates.length > pageSize ? candidates[pageSize - 1]!.info.slot : Number.NEGATIVE_INFINITY;
    const listedSignatures = new Set<string>();
    const listed: SignatureInfo[] = [];
    for (const c of candidates) {
      if (c.info.slot < cutSlot) continue;
      if (listedSignatures.has(c.info.signature)) continue;
      listedSignatures.add(c.info.signature);
      listed.push(c.info);
    }

    let anyLeft = false;
    const next = streams.map((s) => {
      let k = 0;
      while (k < s.fetched.length && listedSignatures.has(s.fetched[k]!.signature)) k++;
      const before = k > 0 ? s.fetched[k - 1]!.signature : s.before;
      const done = doneFromCursor.has(s) || (s.asked && !s.more && k === s.fetched.length);
      if (!done) anyLeft = true;
      return [s.address, before ?? null, done ? 1 : 0];
    });
    const entries = await entriesFor(listed, address);
    return {
      entries,
      ...(anyLeft ? { nextCursor: JSON.stringify({ v: 1, s: next }) } : {}),
    };
  }

  return {
    async getHistory(address: string, cursor?: string): Promise<HistoryPage> {
      const derived = followMints.length > 0 ? solanaFollowedTokenAccounts(address, followMints) : [];
      // The old single-stream page: no followed token accounts at the start
      // of the session, or a bare (old-format) cursor.
      if (cursor === undefined ? derived.length === 0 : !cursor.startsWith('{')) return ownPage(address, cursor);
      return mergedPage(address, cursor, derived);
    },
  };
}

async function enrich(
  transport: JsonRpcTransport,
  entry: HistoryEntry,
  address: string,
): Promise<HistoryEntry[]> {
  try {
    const detail = (await transport('getTransaction', [
      entry.id,
      { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
    ])) as TransactionDetail | null;
    if (!detail?.meta) return [entry];

    const keys = detail.transaction.message.accountKeys;
    const index = keys.indexOf(address);
    const moves = solanaTokenMoves(detail.meta.preTokenBalances, detail.meta.postTokenBalances, address);
    if (index === -1) {
      // The address is not among the static account keys (a transfer into
      // one of its token accounts, found through that account's
      // signatures): its token movements, if any, without a fee it did not
      // pay; otherwise the bare entry, as before.
      return moves.length === 0 ? [entry] : tokenEntries(entry, moves);
    }

    const pre = BigInt(detail.meta.preBalances[index] ?? 0);
    const post = BigInt(detail.meta.postBalances[index] ?? 0);
    const fee = BigInt(detail.meta.fee);
    // The fee payer is account 0; only then did this address pay the fee.
    const paidFee = index === 0;
    let net = post - pre;
    if (paidFee) net += fee; // separate the fee from the value movement

    const direction = net > 0n ? 'in' : net < 0n ? 'out' : 'self';
    const native: HistoryEntry = {
      ...entry,
      direction,
      amount: net < 0n ? -net : net,
      ...(paidFee ? { fee } : {}),
    };
    // No token balance of this address changed: the entry this provider has
    // always returned, plus the one other account that received what this
    // address sent (or sent what it received), when there is exactly one.
    if (moves.length === 0) {
      const counterparty = net === 0n ? null : nativeCounterparty(detail, keys, index, net, fee);
      return [counterparty === null ? native : { ...native, counterparty }];
    }

    const tokens = tokenEntries(entry, moves);
    if (net === 0n) {
      // No lamports moved besides the fee: the fee rides on the first token
      // entry, and no native entry of 0 is listed.
      if (paidFee) tokens[0] = { ...tokens[0]!, fee };
      return tokens;
    }
    return [...tokens, { ...native, uid: `${entry.id}:native` }];
  } catch {
    // Detail lookups are best-effort; the signature listing already gave
    // us a valid (amount-less) entry.
    return [entry];
  }
}

/** One token entry per moved mint (see the module comment). */
function tokenEntries(entry: HistoryEntry, moves: readonly SolanaTokenMove[]): HistoryEntry[] {
  return moves.map((move) => ({
    ...entry,
    direction: move.change > 0n ? 'in' : 'out',
    uid: `${entry.id}:token:${move.mint}`,
    assetAmount: move.change < 0n ? -move.change : move.change,
    assetDecimals: move.decimals,
    contract: move.mint,
    ...(move.counterparty !== null ? { counterparty: move.counterparty } : {}),
  }));
}

/**
 * The one other static account whose lamports changed by exactly -net (the
 * fee separated when it is the fee payer, account 0), or null when there is
 * none or more than one, or a balance is unreadable.
 */
function nativeCounterparty(detail: TransactionDetail, keys: readonly string[], index: number, net: bigint, fee: bigint): string | null {
  const meta = detail.meta!;
  let found: string | null = null;
  for (let j = 0; j < keys.length; j++) {
    if (j === index) continue;
    const pre = meta.preBalances[j];
    const post = meta.postBalances[j];
    if (typeof pre !== 'number' || typeof post !== 'number' || !Number.isSafeInteger(pre) || !Number.isSafeInteger(post)) return null;
    let change = BigInt(post) - BigInt(pre);
    if (j === 0) change += fee;
    if (change !== -net) continue;
    const key = keys[j];
    if (typeof key !== 'string' || !isValidSolanaAddress(key) || found !== null) return null;
    found = key;
  }
  return found;
}

/** One mint whose balance, summed over the token accounts the address owns, changed in a transaction. */
export interface SolanaTokenMove {
  /** The mint, base-58, exactly as the node reported it. */
  mint: string;
  /** Signed change in the token's base units: positive received, negative sent. */
  change: bigint;
  decimals: number;
  /** The one other owner whose balance of this mint moved the opposite way, else null. */
  counterparty: string | null;
}

const DIGITS = /^[0-9]+$/;

interface ParsedBalance {
  accountIndex: number;
  mint: string;
  owner: string | null;
  amount: bigint;
  decimals: number;
}

function parseTokenBalances(list: TokenBalanceDetail[] | null | undefined): ParsedBalance[] | null {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) return null;
  const out: ParsedBalance[] = [];
  for (const b of list) {
    const amount = b?.uiTokenAmount?.amount;
    const decimals = b?.uiTokenAmount?.decimals;
    if (
      typeof b?.accountIndex !== 'number' || !Number.isInteger(b.accountIndex) || b.accountIndex < 0 ||
      typeof b.mint !== 'string' || !isValidSolanaAddress(b.mint) ||
      (b.owner !== undefined && (typeof b.owner !== 'string' || !isValidSolanaAddress(b.owner))) ||
      typeof amount !== 'string' || !DIGITS.test(amount) ||
      typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 255
    ) {
      return null;
    }
    out.push({ accountIndex: b.accountIndex, mint: b.mint, owner: typeof b.owner === 'string' ? b.owner : null, amount: BigInt(amount), decimals });
  }
  return out;
}

/**
 * The token movements of `address` in one transaction, from
 * meta.preTokenBalances and meta.postTokenBalances (see the module comment
 * for the documented fields). Balances are paired by accountIndex (a token
 * account missing on one side counts as 0 there: created or closed in the
 * transaction). Only accounts whose recorded owner is `address` count as
 * its own; an account whose pre and post entries name different mints or
 * owners, or a mint reported with two different decimals, is not
 * interpreted. Any malformed element makes the whole answer uninterpreted
 * (an empty list), so nothing is guessed. Mints are listed in the order they
 * first appear (post, then pre).
 */
export function solanaTokenMoves(
  preList: TokenBalanceDetail[] | null | undefined,
  postList: TokenBalanceDetail[] | null | undefined,
  address: string,
): SolanaTokenMove[] {
  const pre = parseTokenBalances(preList);
  const post = parseTokenBalances(postList);
  if (pre === null || post === null) return [];
  const byIndex = new Map<number, { pre: ParsedBalance | null; post: ParsedBalance | null }>();
  const seen = (side: 'pre' | 'post', b: ParsedBalance): boolean => {
    const slot = byIndex.get(b.accountIndex) ?? { pre: null, post: null };
    if (slot[side] !== null) return false; // the same account twice on one side
    slot[side] = b;
    byIndex.set(b.accountIndex, slot);
    return true;
  };
  for (const b of post) if (!seen('post', b)) return [];
  for (const b of pre) if (!seen('pre', b)) return [];
  const order: string[] = [];
  const perMint = new Map<string, { decimals: number; mine: bigint; others: Map<string, bigint>; broken: boolean }>();
  for (const b of [...post, ...pre]) if (!order.includes(b.mint)) order.push(b.mint);
  for (const { pre: before, post: after } of byIndex.values()) {
    const ref = (after ?? before)!;
    const record = perMint.get(ref.mint) ?? { decimals: ref.decimals, mine: 0n, others: new Map(), broken: false };
    perMint.set(ref.mint, record);
    if (
      (before !== null && after !== null && (before.mint !== after.mint || before.owner !== after.owner || before.decimals !== after.decimals)) ||
      record.decimals !== ref.decimals
    ) {
      record.broken = true;
      continue;
    }
    if (ref.owner === null) continue;
    const change = (after?.amount ?? 0n) - (before?.amount ?? 0n);
    if (ref.owner === address) record.mine += change;
    else record.others.set(ref.owner, (record.others.get(ref.owner) ?? 0n) + change);
  }
  const moves: SolanaTokenMove[] = [];
  for (const mint of order) {
    const record = perMint.get(mint);
    if (!record || record.broken || record.mine === 0n) continue;
    const opposite = [...record.others.entries()].filter(([, change]) => (record.mine > 0n ? change < 0n : change > 0n));
    moves.push({
      mint,
      change: record.mine,
      decimals: record.decimals,
      counterparty: opposite.length === 1 ? opposite[0]![0] : null,
    });
  }
  return moves;
}

/** Quick validity check the app can use before querying. */
export function isValidSolanaAddress(address: string): boolean {
  try {
    return base58.decode(address).length === 32;
  } catch {
    return false;
  }
}
