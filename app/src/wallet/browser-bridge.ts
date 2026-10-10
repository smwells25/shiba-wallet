// Explicit .ts extensions: this module is imported by scripts/check-browser.mjs
// under Node's type stripping, which resolves relative specifiers literally.
import {
  EIP7702_WC_REFUSAL,
  WC_5792_METHODS,
  WC_ERRORS,
  WC_SIGNING_METHODS,
  hexChainIdOf,
  methodMentionsEip7702,
  type WcClient,
  type WcResponse,
} from './walletconnect.ts';
import { assertFeatureAllowed, readinessRefusal } from '../config/readiness.ts';
import {
  BROWSER_SITES,
  isAllowlistedOrigin,
  loadBrowserConnections,
  parseWebOrigin,
  saveBrowserConnections,
  forgetBrowserConnections,
  type BrowserConnectionRecord,
} from './browser-sites.ts';
import { BROWSER_BRIDGE_CHANNEL, type ShimPayload } from './browser-provider-script.ts';
import type { KeyValueStore } from './tokens.ts';

/**
 * The in-app browser's bridge (feature 79; docs/DAPP_BROWSER.md section 5,
 * "the smallest safe slice"). Pure TypeScript with no React or React Native
 * imports, so scripts/check-browser.mjs drives it, with a fake page, through
 * the REAL WcController exactly as the app does.
 *
 * ONE APPROVAL PATH. The bridge is a WcClient (walletconnect.ts) whose
 * sessions are the per-origin browser connections, keyed "browser:<origin>".
 * A page's eth_requestAccounts becomes a session_proposal and its signing
 * requests become session_request events on the app's single WcController
 * queue, so the existing approval sheet, the eth_call / bundler gates, the
 * balance preview, the risk card, the biometric prompt, the SIWE gate and
 * ADR D6 serve the browser unchanged. CompositeWcClient below lets one
 * controller serve both WalletKit and the browser, so there is never a
 * second queue or a second sheet. NOTHING HERE SIGNS: this file imports no
 * key storage and never sees a DerivedAccount (scripts/check-browser.mjs
 * checks the browser files' sources for that).
 *
 * WHAT IS ACCEPTED FROM A PAGE (findings B2 and B3 of section 3.3). A
 * message is acted on only when the origin the web view reported for it
 * EQUALS the current top-level origin, and that origin is on the
 * allowlist; anything else is dropped without an answer (acceptsFrameMessage).
 * On iOS and on Android's WEB_MESSAGE_LISTENER path the reported origin is
 * the sending frame's, so this drops every cross-origin iframe. On
 * Android's fallback bridge the library reports the TOP page's URL for
 * every frame (RNCWebView.java RNCWebViewBridge.postMessage uses
 * mWebView.getUrl()), so there a cross-origin iframe's message cannot be
 * told apart from the page's own; only a development build that refuses
 * the fallback path can close that (section 5.5). The screen shows which
 * path the page reports, as a heuristic only.
 *
 * CHAIN POLICY (section 2.6). eth_chainId is the active profile's chain,
 * answered locally; wallet_switchEthereumChain goes to the controller's
 * decideSwitchChain (null for the active chain, refused otherwise, never
 * switching the wallet); a connection serves only the chain it was
 * approved on (its requests carry that chain, so the controller declines
 * them after a mode change); the page receives chainChanged and
 * accountsChanged when the wallet's mode or account changes
 * (notifyContextChanged).
 */

// ---------------------------------------------------------------------------
// Method table (section 2.3 minus ERC-7715, EIP-2255 and ERC-7846)
// ---------------------------------------------------------------------------

export const BROWSER_TOPIC_PREFIX = 'browser:';

/** True for a topic the browser bridge owns. */
export function isBrowserTopic(topic: unknown): topic is string {
  return typeof topic === 'string' && topic.startsWith(BROWSER_TOPIC_PREFIX);
}

/** The topic of an origin's connection. */
export function browserTopicFor(origin: string): string {
  return `${BROWSER_TOPIC_PREFIX}${origin}`;
}

/**
 * The methods a browser connection asks for in its proposal. The
 * controller's decideProposal intersects them with what the account type
 * supports (buildApprovedNamespaces approves only methods both sides list),
 * so a regular account gets the signing methods and the chain switch, and a
 * smart account also gets ERC-5792. ERC-7715 is deliberately not requested,
 * so even a Kernel connection never approves it in this slice.
 */
export const BROWSER_PROPOSAL_METHODS: readonly string[] = [
  ...WC_SIGNING_METHODS,
  'wallet_switchEthereumChain',
  ...WC_5792_METHODS,
];
export const BROWSER_EVENTS: readonly string[] = ['accountsChanged', 'chainChanged'];

/** Requests that go to the approval queue (the controller decides them). */
export const BROWSER_QUEUED_METHODS: readonly string[] = BROWSER_PROPOSAL_METHODS;

/**
 * Read-only methods proxied to the wallet's own endpoint for the active
 * chain (section 2.3's list, plus the two fee reads eth_gasPrice and
 * eth_maxPriorityFeePerGas, which wallet libraries call before suggesting a
 * transaction; a judgement). Everything else is refused.
 */
export const BROWSER_READ_METHODS: readonly string[] = [
  'eth_blockNumber',
  'eth_call',
  'eth_estimateGas',
  'eth_getBalance',
  'eth_getTransactionCount',
  'eth_getCode',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_feeHistory',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_getLogs',
];

/** Methods refused by name, each with the reason the page receives (code 4200). */
export const BROWSER_REFUSED_METHODS: Readonly<Record<string, string>> = {
  wallet_addEthereumChain:
    'This wallet does not add networks for websites; it works only on its own fixed networks.',
  eth_sign: 'eth_sign is not supported: it signs raw hashes that cannot be shown to the user.',
  eth_signTypedData: 'Only eth_signTypedData_v4 is supported.',
  eth_signTypedData_v1: 'Only eth_signTypedData_v4 is supported.',
  eth_signTypedData_v3: 'Only eth_signTypedData_v4 is supported.',
  eth_signTransaction: 'This wallet signs only transactions it sends itself (eth_sendTransaction).',
  eth_sendRawTransaction: 'This wallet does not broadcast transactions signed elsewhere.',
  wallet_requestPermissions: 'Use eth_requestAccounts to connect.',
  wallet_getPermissions: 'Use eth_accounts to read the connected account.',
  wallet_revokePermissions: 'Disconnect from the wallet’s Connections screen.',
  wallet_connect: 'wallet_connect (ERC-7846, a draft) is not offered; use eth_requestAccounts.',
  wallet_getSupportedExecutionPermissions: 'Execution permissions (ERC-7715) are not offered in the in-app browser.',
  wallet_requestExecutionPermissions: 'Execution permissions (ERC-7715) are not offered in the in-app browser.',
  wallet_revokeExecutionPermission: 'Execution permissions (ERC-7715) are not offered in the in-app browser.',
  wallet_getGrantedExecutionPermissions: 'Execution permissions (ERC-7715) are not offered in the in-app browser.',
  wallet_showCallsStatus: 'Batch status is available through wallet_getCallsStatus only.',
  wallet_watchAsset: 'Add tokens from the wallet’s Tokens screen.',
  eth_subscribe: 'Subscriptions are not offered; poll instead.',
  eth_unsubscribe: 'Subscriptions are not offered; poll instead.',
};

export type BrowserMethodClass =
  | { kind: 'eip7702' }
  | { kind: 'chain-id' }
  | { kind: 'net-version' }
  | { kind: 'accounts' }
  | { kind: 'connect' }
  | { kind: 'queue' }
  | { kind: 'read' }
  | { kind: 'refused'; reason: string }
  | { kind: 'unknown' };

/** Where one method goes. The 7702 test runs first, as in parseWcRequest. */
export function classifyBrowserMethod(method: string): BrowserMethodClass {
  if (methodMentionsEip7702(method)) return { kind: 'eip7702' };
  if (method === 'eth_chainId') return { kind: 'chain-id' };
  if (method === 'net_version') return { kind: 'net-version' };
  if (method === 'eth_accounts') return { kind: 'accounts' };
  if (method === 'eth_requestAccounts') return { kind: 'connect' };
  if (BROWSER_QUEUED_METHODS.includes(method)) return { kind: 'queue' };
  if (BROWSER_READ_METHODS.includes(method)) return { kind: 'read' };
  const reason = Object.prototype.hasOwnProperty.call(BROWSER_REFUSED_METHODS, method)
    ? BROWSER_REFUSED_METHODS[method]
    : undefined;
  if (reason !== undefined) return { kind: 'refused', reason };
  return { kind: 'unknown' };
}

// ---------------------------------------------------------------------------
// Errors (EIP-1193 "Provider Errors")
// ---------------------------------------------------------------------------

/** EIP-1193's provider error codes (ethereum/EIPs EIPS/eip-1193.md at af3a7802). */
export const EIP1193_ERRORS = {
  userRejected: 4001,
  unauthorized: 4100,
  unsupportedMethod: 4200,
  disconnected: 4900,
  chainDisconnected: 4901,
} as const;

/** EIP-1474 (Stagnant) "-32005 Limit exceeded: Request exceeds defined limit". */
export const LIMIT_EXCEEDED = -32005;

/**
 * WalletConnect SDK error codes (walletconnect.ts WC_ERRORS, from
 * @walletconnect/utils getSdkError) mapped to EIP-1193's. The first four
 * are docs/DAPP_BROWSER.md section 2.3; the last three are judgements:
 * UNSUPPORTED_EVENTS and UNSUPPORTED_NAMESPACE_KEY mean "the wallet does not
 * support what was asked" (4200), and USER_DISCONNECTED means the site is no
 * longer authorised (4100). Every other code (ERC-5792's 57xx, EIP-1193's
 * own 4xxx from ERC-7715 paths, JSON-RPC's -326xx) passes through unchanged.
 */
export const WC_TO_EIP1193: Readonly<Record<number, number>> = {
  [WC_ERRORS.userRejected.code]: EIP1193_ERRORS.userRejected,
  [WC_ERRORS.unsupportedChains.code]: EIP1193_ERRORS.chainDisconnected,
  [WC_ERRORS.unsupportedMethods.code]: EIP1193_ERRORS.unsupportedMethod,
  [WC_ERRORS.unsupportedAccounts.code]: EIP1193_ERRORS.unauthorized,
  [WC_ERRORS.unsupportedEvents.code]: EIP1193_ERRORS.unsupportedMethod,
  [WC_ERRORS.unsupportedNamespaceKey.code]: EIP1193_ERRORS.unsupportedMethod,
  [WC_ERRORS.userDisconnected.code]: EIP1193_ERRORS.unauthorized,
};

export interface PageError {
  code: number;
  message: string;
  data?: unknown;
}

/** The error the page receives for an error the queue answered with. */
export function translateWcError(error: { code: number; message: string; data?: unknown }): PageError {
  const code = WC_TO_EIP1193[error.code] ?? error.code;
  return { code, message: String(error.message).slice(0, 2000), ...(error.data !== undefined ? { data: error.data } : {}) };
}

export const NOT_CONNECTED_MESSAGE =
  'This site is not connected to the wallet. Ask to connect first (eth_requestAccounts).';
export const NO_ACCOUNT_MESSAGE =
  'The active account cannot connect to sites: the wallet holds no key for it. Switch to one of your own accounts.';
export const TOO_MANY_WAITING_MESSAGE =
  'Too many requests from this site are already waiting for an answer in the wallet.';
export const READ_RATE_MESSAGE = 'Too many network reads from this site; slow down.';
export const READ_UNAVAILABLE_MESSAGE = 'The wallet’s network endpoint did not answer this read.';

// ---------------------------------------------------------------------------
// Messages from the page
// ---------------------------------------------------------------------------

/** Largest bridge message accepted (typed data can be long; a judgement). */
export const MAX_BRIDGE_MESSAGE_CHARS = 512 * 1024;

export type BridgeMessage =
  | { type: 'request'; id: number; method: string; params: unknown }
  | { type: 'hello'; hasListener: boolean; chainId: string | null };

/**
 * Parses one bridge message. Returns null (and the caller drops it without
 * an answer) for anything that is not this channel's well-formed JSON with
 * the current nonce: oversized, unparseable, another channel or load, a
 * request id that is not a positive integer, a method that is not a short
 * identifier, or params that are neither absent, an array nor an object.
 */
export function parseBridgeMessage(data: unknown, nonce: string): BridgeMessage | null {
  if (typeof data !== 'string' || data.length === 0 || data.length > MAX_BRIDGE_MESSAGE_CHARS) return null;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const m = value as Record<string, unknown>;
  if (m.channel !== BROWSER_BRIDGE_CHANNEL || m.nonce !== nonce) return null;
  if (m.type === 'hello') {
    const chainId = typeof m.chainId === 'string' && /^0x[0-9a-fA-F]{1,16}$/.test(m.chainId) ? m.chainId.toLowerCase() : null;
    return { type: 'hello', hasListener: m.hasListener === true, chainId };
  }
  if (m.type !== 'request') return null;
  if (typeof m.id !== 'number' || !Number.isSafeInteger(m.id) || m.id <= 0) return null;
  if (typeof m.method !== 'string' || !/^[A-Za-z0-9_]{1,100}$/.test(m.method)) return null;
  const params = m.params;
  if (params !== undefined && (typeof params !== 'object' || params === null)) return null;
  return { type: 'request', id: m.id, method: m.method, params };
}

/**
 * THE FRAME RULE. True only when the origin the web view reported for a
 * message equals the current top-level origin AND that origin is on the
 * allowlist. Both sides go through the wallet's own parser
 * (browser-sites.ts parseWebOrigin); a user-info URL, another scheme, a
 * missing top origin (a navigation not yet committed) or any parse failure
 * gives false.
 */
export function acceptsFrameMessage(reportedUrl: unknown, topOrigin: string | null): boolean {
  if (!topOrigin || !isAllowlistedOrigin(topOrigin)) return false;
  const parsed = parseWebOrigin(reportedUrl);
  return parsed !== null && parsed.scheme === 'https' && !parsed.hadUserinfo && parsed.origin === topOrigin;
}

// ---------------------------------------------------------------------------
// Read proxy: validation, bounds and rate limit
// ---------------------------------------------------------------------------

/**
 * Per-origin read limits (judgements; EIP-1193 asks that "The Wallet
 * and/or Client rate-limit requests from the Provider"): at most 10 reads
 * in any one second, 120 in any one minute, and 4 in flight at once. The
 * allowlisted dApps read mostly through their own endpoints, so these
 * bound abuse of the wallet's free endpoints without being reached in
 * ordinary use.
 */
export const READ_RATE_LIMITS = { perSecond: 10, perMinute: 120, inFlight: 4 } as const;

/** eth_getLogs: at most this many blocks per query (a judgement). */
export const MAX_LOG_BLOCK_SPAN = 1000n;
/** eth_getLogs: at most this many addresses and topic alternatives (judgements). */
export const MAX_LOG_ADDRESSES = 20;
/** Largest params accepted for a read, as JSON (a judgement). */
export const MAX_READ_PARAMS_CHARS = 128 * 1024;

export class OriginRateLimiter {
  limits: { perSecond: number; perMinute: number; inFlight: number };
  now: () => number;
  stamps = new Map<string, number[]>();
  inFlight = new Map<string, number>();

  constructor(limits: { perSecond: number; perMinute: number; inFlight: number } = READ_RATE_LIMITS, now: () => number = Date.now) {
    this.limits = limits;
    this.now = now;
  }

  /** Takes a slot for one read, or says why not. Call the release function when the read ends. */
  acquire(origin: string): { ok: true; release: () => void } | { ok: false } {
    const t = this.now();
    const recent = (this.stamps.get(origin) ?? []).filter((s) => t - s < 60_000);
    const lastSecond = recent.filter((s) => t - s < 1_000).length;
    const flying = this.inFlight.get(origin) ?? 0;
    if (lastSecond >= this.limits.perSecond || recent.length >= this.limits.perMinute || flying >= this.limits.inFlight) {
      this.stamps.set(origin, recent);
      return { ok: false };
    }
    recent.push(t);
    this.stamps.set(origin, recent);
    this.inFlight.set(origin, flying + 1);
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.inFlight.set(origin, Math.max(0, (this.inFlight.get(origin) ?? 1) - 1));
      },
    };
  }
}

const HEX_QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/;
const HASH32 = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BLOCK_TAGS = ['latest', 'earliest', 'pending', 'safe', 'finalized'];

function isBlockRef(value: unknown): boolean {
  return typeof value === 'string' && (BLOCK_TAGS.includes(value) || HEX_QUANTITY.test(value));
}

function isBlockParam(value: unknown): boolean {
  if (isBlockRef(value)) return true;
  // EIP-1898 block objects: { blockHash } or { blockNumber }.
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => k !== 'requireCanonical');
  if (keys.length !== 1) return false;
  return (keys[0] === 'blockHash' && typeof o.blockHash === 'string' && HASH32.test(o.blockHash)) ||
    (keys[0] === 'blockNumber' && typeof o.blockNumber === 'string' && HEX_QUANTITY.test(o.blockNumber));
}

function isCallObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * eth_getLogs bound: a single block by hash, or an explicit numeric range
 * of at most MAX_LOG_BLOCK_SPAN blocks, or only the latest block (both
 * bounds absent or "latest", which is what JSON-RPC defaults them to). At
 * most MAX_LOG_ADDRESSES addresses and four topic positions of at most
 * MAX_LOG_ADDRESSES alternatives each. Returns the refusal, or null.
 */
export function checkGetLogsFilter(filter: unknown): string | null {
  if (typeof filter !== 'object' || filter === null || Array.isArray(filter)) return 'eth_getLogs: expected one filter object.';
  const f = filter as Record<string, unknown>;
  const allowed = ['address', 'topics', 'fromBlock', 'toBlock', 'blockHash'];
  if (Object.keys(f).some((k) => !allowed.includes(k))) return 'eth_getLogs: unexpected filter field.';
  if (f.blockHash !== undefined) {
    if (typeof f.blockHash !== 'string' || !HASH32.test(f.blockHash)) return 'eth_getLogs: malformed blockHash.';
    if (f.fromBlock !== undefined || f.toBlock !== undefined) return 'eth_getLogs: blockHash cannot be combined with a range.';
  } else {
    const from = f.fromBlock;
    const to = f.toBlock;
    const latestOnly = (from === undefined || from === 'latest') && (to === undefined || to === 'latest');
    if (!latestOnly) {
      if (typeof from !== 'string' || typeof to !== 'string' || !HEX_QUANTITY.test(from) || !HEX_QUANTITY.test(to)) {
        return `eth_getLogs: give an explicit block range (hex fromBlock and toBlock) of at most ${MAX_LOG_BLOCK_SPAN} blocks.`;
      }
      const a = BigInt(from);
      const b = BigInt(to);
      if (b < a || b - a + 1n > MAX_LOG_BLOCK_SPAN) {
        return `eth_getLogs: the block range may span at most ${MAX_LOG_BLOCK_SPAN} blocks.`;
      }
    }
  }
  if (f.address !== undefined) {
    const list = Array.isArray(f.address) ? f.address : [f.address];
    if (list.length === 0 || list.length > MAX_LOG_ADDRESSES || !list.every((a) => typeof a === 'string' && ADDRESS.test(a))) {
      return `eth_getLogs: address must be one address or a list of at most ${MAX_LOG_ADDRESSES}.`;
    }
  }
  if (f.topics !== undefined) {
    if (!Array.isArray(f.topics) || f.topics.length > 4) return 'eth_getLogs: at most four topic positions.';
    for (const t of f.topics) {
      if (t === null) continue;
      const alts = Array.isArray(t) ? t : [t];
      if (alts.length > MAX_LOG_ADDRESSES || !alts.every((x) => x === null || (typeof x === 'string' && HASH32.test(x)))) {
        return 'eth_getLogs: malformed topics.';
      }
    }
  }
  return null;
}

/**
 * Validates one read's params (EIP-1193 asks the wallet to "validate all
 * data sent from the Provider"). Returns the params array to forward, or
 * the refusal sentence.
 */
export function checkReadParams(method: string, params: unknown): { ok: true; params: unknown[] } | { ok: false; reason: string } {
  const p = params === undefined ? [] : params;
  if (!Array.isArray(p)) return { ok: false, reason: `${method}: params must be an array.` };
  let size = 0;
  try {
    size = JSON.stringify(p).length;
  } catch {
    return { ok: false, reason: `${method}: unreadable params.` };
  }
  if (size > MAX_READ_PARAMS_CHARS) return { ok: false, reason: `${method}: params too large.` };
  const bad = (why: string) => ({ ok: false as const, reason: `${method}: ${why}` });
  switch (method) {
    case 'eth_blockNumber':
    case 'eth_gasPrice':
    case 'eth_maxPriorityFeePerGas':
      return p.length === 0 ? { ok: true, params: p } : bad('takes no params.');
    case 'eth_getBalance':
    case 'eth_getTransactionCount':
    case 'eth_getCode':
      return p.length >= 1 && p.length <= 2 && typeof p[0] === 'string' && ADDRESS.test(p[0]) && (p.length === 1 || isBlockParam(p[1]))
        ? { ok: true, params: p }
        : bad('expected [address, block].');
    case 'eth_call':
    case 'eth_estimateGas': {
      if (p.length < 1 || p.length > 2 || !isCallObject(p[0]) || (p.length === 2 && !isBlockParam(p[1]))) {
        return bad('expected [call, block] (state overrides are not forwarded).');
      }
      const call = p[0] as Record<string, unknown>;
      if ('authorizationList' in call || 'authorization_list' in call) return bad(EIP7702_WC_REFUSAL);
      return { ok: true, params: p };
    }
    case 'eth_getTransactionByHash':
    case 'eth_getTransactionReceipt':
      return p.length === 1 && typeof p[0] === 'string' && HASH32.test(p[0]) ? { ok: true, params: p } : bad('expected [hash].');
    case 'eth_getBlockByNumber':
      return p.length === 2 && isBlockRef(p[0]) && typeof p[1] === 'boolean' ? { ok: true, params: p } : bad('expected [block, boolean].');
    case 'eth_getBlockByHash':
      return p.length === 2 && typeof p[0] === 'string' && HASH32.test(p[0]) && typeof p[1] === 'boolean'
        ? { ok: true, params: p }
        : bad('expected [hash, boolean].');
    case 'eth_feeHistory': {
      const count = p[0];
      const n = typeof count === 'number' ? count : typeof count === 'string' && HEX_QUANTITY.test(count) ? Number(BigInt(count)) : NaN;
      const percentiles = p[2];
      if (p.length < 2 || p.length > 3 || !Number.isInteger(n) || n < 1 || n > 1024 || !isBlockRef(p[1])) {
        return bad('expected [blockCount ≤ 1024, newestBlock, rewardPercentiles].');
      }
      if (percentiles !== undefined && (!Array.isArray(percentiles) || percentiles.length > 100 || !percentiles.every((x) => typeof x === 'number'))) {
        return bad('malformed reward percentiles.');
      }
      return { ok: true, params: p };
    }
    case 'eth_getLogs': {
      if (p.length !== 1) return bad('expected [filter].');
      const why = checkGetLogsFilter(p[0]);
      return why ? { ok: false, reason: why } : { ok: true, params: p };
    }
    default:
      return bad('not a proxied read.');
  }
}

/** What the read function answers: the endpoint's result, or its JSON-RPC error. */
export type ReadOutcome = { result: unknown } | { error: PageError };
export type BrowserReadRpc = (method: string, params: unknown[]) => Promise<ReadOutcome>;

/** The JSON-RPC error a page may see from the endpoint: integer code, short message, hex data only. */
export function sanitizeEndpointError(error: unknown): PageError {
  const e = (typeof error === 'object' && error !== null ? error : {}) as Record<string, unknown>;
  const code = typeof e.code === 'number' && Number.isInteger(e.code) ? e.code : -32603;
  const message = typeof e.message === 'string' ? e.message.slice(0, 500) : 'The endpoint returned an error.';
  const data = typeof e.data === 'string' && /^0x[0-9a-fA-F]*$/.test(e.data) && e.data.length <= 65_536 ? e.data : undefined;
  return data !== undefined ? { code, message, data } : { code, message };
}

/**
 * The real read function: one JSON-RPC POST to the wallet's endpoint for
 * the active chain, through the app's failover rule (`run` is
 * networks.ts withEndpoint in the app, a fake in the checks). Before the
 * first read through an endpoint URL, its eth_chainId is checked against
 * the active chain; a mismatch refuses every read through it. A transport
 * failure is thrown inside `run` so the failover rule can try the next
 * default endpoint, and becomes a generic sentence for the page: the page
 * never sees an endpoint URL (which may carry an API key) or an exception
 * text.
 */
export function createEndpointReadRpc(deps: {
  run: <T>(operation: (url: string) => Promise<T>) => Promise<T>;
  fetchFn: typeof fetch;
  chainIdHex: () => string;
}): BrowserReadRpc {
  const verified = new Set<string>();
  let nextId = 1;
  const post = async (url: string, method: string, params: unknown[]): Promise<ReadOutcome> => {
    const response = await deps.fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
    });
    if (!response.ok) throw new Error(`RPC HTTP error ${response.status} for ${method}`);
    const body = (await response.json()) as { result?: unknown; error?: unknown };
    if (body && typeof body === 'object' && 'error' in body && body.error !== undefined && body.error !== null) {
      return { error: sanitizeEndpointError(body.error) };
    }
    return { result: body?.result ?? null };
  };
  return async (method, params) => {
    const expected = deps.chainIdHex().toLowerCase();
    try {
      return await deps.run(async (url) => {
        const key = `${url}\u0000${expected}`;
        if (!verified.has(key)) {
          const answer = await post(url, 'eth_chainId', []);
          const reported = 'result' in answer && typeof answer.result === 'string' ? answer.result.toLowerCase() : null;
          if (reported === null || BigInt(reported) !== BigInt(expected)) {
            return {
              error: {
                code: EIP1193_ERRORS.chainDisconnected,
                message: 'The wallet’s network endpoint serves a different chain, so reads are not forwarded.',
              },
            };
          }
          verified.add(key);
        }
        return post(url, method, params);
      });
    } catch {
      return { error: { code: -32603, message: READ_UNAVAILABLE_MESSAGE } };
    }
  };
}

// ---------------------------------------------------------------------------
// The browser's WcClient
// ---------------------------------------------------------------------------

export interface BrowserBridgeContext {
  /** The ACTIVE account's EOA address, or null (watch-only, none). */
  address: string | null;
  /** CAIP-2 id of the active EVM chain. */
  activeChain: string;
}

/** One loaded page, as the screen attaches it. */
export interface BrowserPageHandle {
  /** The page's committed top-level origin (allowlisted). */
  origin: string;
  /** This web view's nonce (browser-provider-script.ts). */
  nonce: string;
  /** Runs injectJavaScript with deliverToPageScript(payload). */
  deliver: (payload: ShimPayload) => void;
  /** Informational only: what the page's shim says about the bridge object (heuristic for B3). */
  onHello?: (info: { hasListener: boolean }) => void;
}

interface PendingRequest {
  kind: 'request';
  origin: string;
  topic: string;
  page: number;
  pageRequestId: number;
}
interface PendingProposal {
  kind: 'proposal';
  origin: string;
  page: number;
  waiters: number[];
}

/** Most requests one origin may have waiting in the approval queue (a judgement). */
export const MAX_WAITING_PER_ORIGIN = 5;

type Listener = (args: never) => void;

export class BrowserBridgeClient implements WcClient {
  getContext: () => BrowserBridgeContext;
  readRpc: BrowserReadRpc;
  store: KeyValueStore | null;
  now: () => number;
  limiter: OriginRateLimiter;
  records = new Map<string, BrowserConnectionRecord>();
  ready: Promise<void>;
  listeners = new Map<string, Set<Listener>>();
  pending = new Map<number, PendingRequest | PendingProposal>();
  nextEventId = -1;
  page: (BrowserPageHandle & { generation: number; sent: { chainId: string; accounts: string } | null }) | null = null;
  pageGeneration = 0;
  /** Change listeners for the screens (connections list). */
  changeListeners = new Set<() => void>();
  /** Bumped on every change, for useSyncExternalStore snapshots. */
  version = 0;

  // No TS parameter properties: Node's strip-only type stripping rejects them.
  constructor(options: {
    getContext: () => BrowserBridgeContext;
    readRpc: BrowserReadRpc;
    store?: KeyValueStore | null;
    now?: () => number;
    limiter?: OriginRateLimiter;
  }) {
    this.getContext = options.getContext;
    this.readRpc = options.readRpc;
    this.store = options.store ?? null;
    this.now = options.now ?? Date.now;
    this.limiter = options.limiter ?? new OriginRateLimiter(READ_RATE_LIMITS, this.now);
    this.ready = this.store
      ? loadBrowserConnections(this.store).then((list) => {
          for (const r of list) this.records.set(r.origin, r);
          this.changed();
        })
      : Promise.resolve();
  }

  // ------------------------------------------------------------ WcClient

  async pair(): Promise<unknown> {
    throw new Error('The in-app browser does not pair; pairing is for WalletConnect.');
  }

  on(event: string, listener: Listener): unknown {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(event, set);
    return this;
  }

  off(event: string, listener: Listener): unknown {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emitEvent(event: string, payload: unknown): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      (listener as (args: unknown) => void)(payload);
    }
  }

  /** True when a proposal id belongs to this client. */
  ownsProposal(id: number): boolean {
    return this.pending.get(id)?.kind === 'proposal';
  }

  getActiveSessions(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const r of this.records.values()) {
      const topic = browserTopicFor(r.origin);
      const host = parseWebOrigin(r.origin)?.host ?? r.origin;
      out[topic] = {
        topic,
        peer: { metadata: { name: host, url: r.origin, description: 'Opened in the wallet’s in-app browser', icons: [] } },
        namespaces: r.namespaces,
        // Browser connections do not expire on their own; they end on
        // Disconnect, on removal from the allowlist, or with the wallet.
        expiry: null,
        browser: true,
      };
    }
    return out;
  }

  async approveSession(args: { id: number; namespaces: Record<string, unknown> }): Promise<unknown> {
    const p = this.pending.get(args.id);
    if (!p || p.kind !== 'proposal') throw new Error('Unknown browser connection request.');
    const ctx = this.getContext();
    const accounts = Object.values(args.namespaces ?? {}).flatMap((ns) => {
      const list = (ns as { accounts?: unknown } | undefined)?.accounts;
      return Array.isArray(list) ? list.filter((a): a is string => typeof a === 'string') : [];
    });
    const parts = accounts.length === 1 ? accounts[0]!.split(':') : [];
    const address = parts[2];
    if (
      !ctx.address ||
      parts.length !== 3 ||
      `${parts[0]}:${parts[1]}` !== ctx.activeChain ||
      typeof address !== 'string' ||
      !ADDRESS.test(address) ||
      Object.keys(args.namespaces ?? {}).some((k) => k !== 'eip155')
    ) {
      throw new Error('The approved connection does not name exactly one account on the active chain.');
    }
    this.pending.delete(args.id);
    const record: BrowserConnectionRecord = {
      origin: p.origin,
      address,
      owner: ctx.address,
      chain: ctx.activeChain,
      namespaces: args.namespaces,
      approvedAt: this.now(),
    };
    this.records.set(p.origin, record);
    await this.persist();
    for (const waiter of p.waiters) this.answer(p.origin, p.page, waiter, { result: [address] });
    this.notifyContextChanged();
    this.changed();
    return { topic: browserTopicFor(p.origin) };
  }

  async rejectSession(args: { id: number; reason: { code: number; message: string } }): Promise<unknown> {
    const p = this.pending.get(args.id);
    if (!p || p.kind !== 'proposal') throw new Error('Unknown browser connection request.');
    this.pending.delete(args.id);
    const error = translateWcError(args.reason);
    for (const waiter of p.waiters) this.answer(p.origin, p.page, waiter, { error });
    return undefined;
  }

  async respondSessionRequest(args: { topic: string; response: WcResponse }): Promise<unknown> {
    const p = this.pending.get(args.response.id);
    // Already withdrawn (the page was left) or never ours: nobody is
    // waiting for this answer, so it is dropped rather than reported as a
    // failure after the user approved.
    if (!p || p.kind !== 'request' || p.topic !== args.topic) return undefined;
    this.pending.delete(args.response.id);
    if (args.response.error) {
      this.answer(p.origin, p.page, p.pageRequestId, { error: translateWcError(args.response.error) });
    } else {
      this.answer(p.origin, p.page, p.pageRequestId, { result: args.response.result ?? null });
    }
    return undefined;
  }

  async disconnectSession(args: { topic: string; reason: { code: number; message: string } }): Promise<unknown> {
    if (!isBrowserTopic(args.topic)) throw new Error('Not a browser connection.');
    const origin = args.topic.slice(BROWSER_TOPIC_PREFIX.length);
    this.records.delete(origin);
    await this.persist();
    // Requests still waiting from this origin: the page hears "no longer
    // authorised", and the controller drops them through session_delete.
    const error = translateWcError(args.reason ?? WC_ERRORS.userDisconnected);
    for (const [id, p] of [...this.pending]) {
      if (p.kind === 'request' && p.topic === args.topic) {
        this.pending.delete(id);
        this.answer(p.origin, p.page, p.pageRequestId, { error });
      }
    }
    this.emitEvent('session_delete', { id: 0, topic: args.topic });
    this.notifyContextChanged();
    this.changed();
    return undefined;
  }

  // -------------------------------------------------------- page side

  /**
   * Attaches the page now loaded in the web view (the screen calls this
   * when an allowlisted origin has committed). Anything still waiting from
   * an earlier page is withdrawn first. Returns the detach function.
   */
  attachPage(page: BrowserPageHandle): () => void {
    this.detachPage();
    this.pageGeneration += 1;
    const attached = { ...page, generation: this.pageGeneration, sent: null };
    this.page = attached;
    return () => {
      if (this.page === attached) this.detachPage();
    };
  }

  /** Withdraws everything waiting from the current page and forgets it. */
  detachPage(): void {
    const page = this.page;
    this.page = null;
    if (page) this.withdraw(page.origin, page.generation, 'was left or closed');
  }

  /**
   * Withdraws the requests one document left waiting: the page cannot
   * receive their answers any more (it was left, closed or reloaded), so
   * they leave the controller's queue (browser_requests_withdrawn).
   */
  withdraw(origin: string, generation: number, why: string): void {
    const ids: number[] = [];
    for (const [id, p] of [...this.pending]) {
      if (p.page === generation) {
        this.pending.delete(id);
        ids.push(id);
      }
    }
    if (ids.length > 0) {
      const host = parseWebOrigin(origin)?.host ?? origin;
      this.emitEvent('browser_requests_withdrawn', {
        ids,
        notice:
          `The page from ${host} ${why}, so its ${ids.length} waiting request(s) were withdrawn ` +
          'without an answer. Nothing was signed for them.',
      });
    }
  }

  /** The addresses eth_accounts returns for an origin right now ([] unless connected for the active account and chain). */
  servedAccounts(origin: string): string[] {
    const r = this.records.get(origin);
    const ctx = this.getContext();
    if (!r || !ctx.address) return [];
    if (r.chain !== ctx.activeChain || r.owner.toLowerCase() !== ctx.address.toLowerCase()) return [];
    return [r.address];
  }

  /**
   * Tells the attached page about a chain or account change (EIP-1193:
   * chainChanged and accountsChanged "MUST" be emitted when the values
   * change). The screen calls this when the wallet's mode or account
   * changes; approving and disconnecting call it too.
   */
  notifyContextChanged(): void {
    const page = this.page;
    if (!page) return;
    const ctx = this.getContext();
    const chainId = hexChainIdOf(ctx.activeChain);
    const accounts = this.servedAccounts(page.origin);
    const accountsKey = accounts.join(',').toLowerCase();
    const sent = page.sent;
    page.sent = { chainId, accounts: accountsKey };
    if (sent === null) return;
    if (sent.chainId !== chainId) page.deliver({ nonce: page.nonce, type: 'event', name: 'chainChanged', value: chainId });
    if (sent.accounts !== accountsKey) page.deliver({ nonce: page.nonce, type: 'event', name: 'accountsChanged', value: accounts });
  }

  /**
   * One message from the web view. `reportedUrl` is the URL or origin the
   * library reported for it (nativeEvent.url); `data` is nativeEvent.data.
   * Messages failing the frame rule or the parser are dropped without an
   * answer. Resolves when the message has been answered or queued.
   */
  async handleMessage(reportedUrl: unknown, data: unknown): Promise<void> {
    const page = this.page;
    if (!page || !acceptsFrameMessage(reportedUrl, page.origin)) return;
    const message = parseBridgeMessage(data, page.nonce);
    if (!message) return;
    if (message.type === 'hello') {
      // A shim says hello once per document, so a hello means a new
      // document (a load or reload): whatever the previous document left
      // waiting is withdrawn, and answers are matched to this document only
      // (its request ids start again at 1).
      if (page.sent !== null) {
        this.withdraw(page.origin, page.generation, 'was reloaded');
        this.pageGeneration += 1;
        page.generation = this.pageGeneration;
      }
      // The shim starts with the chain it was built with and no accounts;
      // anything newer is sent now (e.g. the accounts of a site connected
      // earlier, or a mode change during the load).
      page.sent = { chainId: message.chainId ?? hexChainIdOf(this.getContext().activeChain), accounts: '' };
      this.notifyContextChanged();
      page.onHello?.({ hasListener: message.hasListener });
      return;
    }
    const generation = page.generation;
    await this.ready;
    if (this.page !== page || page.generation !== generation) return;
    if (page.sent === null) this.notifyContextChanged();
    const reply = (outcome: { result: unknown } | { error: PageError }) =>
      this.answer(page.origin, generation, message.id, outcome);
    const ctx = this.getContext();

    // Readiness (config/readiness.ts 'dapp-browser'): test networks only,
    // enforced here as well as on the screen.
    try {
      assertFeatureAllowed('dapp-browser', ctx.activeChain);
    } catch {
      reply({ error: { code: EIP1193_ERRORS.disconnected, message: readinessRefusal('dapp-browser') } });
      return;
    }

    const route = classifyBrowserMethod(message.method);
    switch (route.kind) {
      case 'eip7702':
        // ADR D6, with WalletConnect's own sentence and code (5101 → 4200).
        reply({ error: translateWcError({ code: WC_ERRORS.unsupportedMethods.code, message: EIP7702_WC_REFUSAL }) });
        return;
      case 'chain-id':
        reply({ result: hexChainIdOf(ctx.activeChain) });
        return;
      case 'net-version':
        reply({ result: ctx.activeChain.split(':')[1] ?? '' });
        return;
      case 'accounts':
        reply({ result: this.servedAccounts(page.origin) });
        return;
      case 'connect':
        this.requestConnection({ origin: page.origin, generation }, message.id);
        return;
      case 'queue':
        this.queueRequest({ origin: page.origin, generation }, message.id, message.method, message.params);
        return;
      case 'read':
        await this.proxyRead({ origin: page.origin, generation }, message.id, message.method, message.params);
        return;
      case 'refused':
        reply({ error: { code: EIP1193_ERRORS.unsupportedMethod, message: route.reason } });
        return;
      default:
        reply({
          error: { code: EIP1193_ERRORS.unsupportedMethod, message: `The in-app browser does not support ${message.method}.` },
        });
    }
  }

  requestConnection(page: { origin: string; generation: number }, pageRequestId: number): void {
    const served = this.servedAccounts(page.origin);
    if (served.length > 0) {
      this.answer(page.origin, page.generation, pageRequestId, { result: served });
      return;
    }
    const ctx = this.getContext();
    if (!ctx.address) {
      this.answer(page.origin, page.generation, pageRequestId, {
        error: { code: EIP1193_ERRORS.unauthorized, message: NO_ACCOUNT_MESSAGE },
      });
      return;
    }
    // One connection request per page at a time: later ones wait for it.
    for (const p of this.pending.values()) {
      if (p.kind === 'proposal' && p.origin === page.origin && p.page === page.generation) {
        p.waiters.push(pageRequestId);
        return;
      }
    }
    const id = this.nextEventId--;
    this.pending.set(id, { kind: 'proposal', origin: page.origin, page: page.generation, waiters: [pageRequestId] });
    const host = parseWebOrigin(page.origin)?.host ?? page.origin;
    this.emitEvent('session_proposal', {
      id,
      params: {
        id,
        proposer: {
          metadata: { name: host, url: page.origin, description: 'Opened in the wallet’s in-app browser', icons: [] },
        },
        requiredNamespaces: {},
        optionalNamespaces: {
          eip155: { chains: [ctx.activeChain], methods: [...BROWSER_PROPOSAL_METHODS], events: [...BROWSER_EVENTS] },
        },
      },
      browserOrigin: page.origin,
    });
  }

  queueRequest(page: { origin: string; generation: number }, pageRequestId: number, method: string, params: unknown): void {
    const record = this.records.get(page.origin);
    if (!record) {
      this.answer(page.origin, page.generation, pageRequestId, {
        error: { code: EIP1193_ERRORS.unauthorized, message: NOT_CONNECTED_MESSAGE },
      });
      return;
    }
    // Like the WalletConnect SDK (sign-client isValidRequest), a method the
    // connection did not approve never reaches the queue.
    const approved = Object.values(record.namespaces).flatMap((ns) => {
      const list = (ns as { methods?: unknown } | undefined)?.methods;
      return Array.isArray(list) ? list : [];
    });
    if (!approved.includes(method)) {
      this.answer(page.origin, page.generation, pageRequestId, {
        error: { code: EIP1193_ERRORS.unsupportedMethod, message: `${method} is not offered on this connection.` },
      });
      return;
    }
    const topic = browserTopicFor(page.origin);
    const waiting = [...this.pending.values()].filter((p) => p.kind === 'request' && p.topic === topic).length;
    if (waiting >= MAX_WAITING_PER_ORIGIN) {
      this.answer(page.origin, page.generation, pageRequestId, { error: { code: LIMIT_EXCEEDED, message: TOO_MANY_WAITING_MESSAGE } });
      return;
    }
    const id = this.nextEventId--;
    this.pending.set(id, { kind: 'request', origin: page.origin, topic, page: page.generation, pageRequestId });
    // The request names the chain the connection was approved on, so after
    // a mode change the controller declines it with its mode-mismatch
    // sentence (WalletConnect's 5100 → 4901), exactly as for a WalletConnect
    // session approved in the other mode.
    this.emitEvent('session_request', {
      id,
      topic,
      params: { request: { method, params: params ?? [] }, chainId: record.chain },
      browserOrigin: page.origin,
    });
  }

  async proxyRead(page: { origin: string; generation: number }, pageRequestId: number, method: string, params: unknown): Promise<void> {
    const checked = checkReadParams(method, params);
    if (!checked.ok) {
      this.answer(page.origin, page.generation, pageRequestId, { error: { code: -32602, message: checked.reason } });
      return;
    }
    const slot = this.limiter.acquire(page.origin);
    if (!slot.ok) {
      this.answer(page.origin, page.generation, pageRequestId, { error: { code: LIMIT_EXCEEDED, message: READ_RATE_MESSAGE } });
      return;
    }
    let outcome: ReadOutcome;
    try {
      outcome = await this.readRpc(method, checked.params);
    } catch {
      outcome = { error: { code: -32603, message: READ_UNAVAILABLE_MESSAGE } };
    } finally {
      slot.release();
    }
    this.answer(page.origin, page.generation, pageRequestId, outcome);
  }

  /** Delivers an answer, only to the same page (origin and load) that asked. */
  answer(origin: string, generation: number, pageRequestId: number, outcome: { result: unknown } | { error: PageError }): void {
    const page = this.page;
    if (!page || page.generation !== generation || page.origin !== origin) return;
    if ('error' in outcome) {
      page.deliver({ nonce: page.nonce, type: 'response', id: pageRequestId, error: outcome.error });
    } else {
      page.deliver({ nonce: page.nonce, type: 'response', id: pageRequestId, result: outcome.result });
    }
  }

  // ------------------------------------------------------------ records

  /** The stored connections (for the Connections screen). */
  connections(): BrowserConnectionRecord[] {
    return [...this.records.values()];
  }

  subscribe(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  changed(): void {
    this.version += 1;
    for (const l of [...this.changeListeners]) l();
  }

  async persist(): Promise<void> {
    if (this.store) await saveBrowserConnections([...this.records.values()], this.store);
  }

  /**
   * Forgets every browser connection (wallet wipe): records, stored list,
   * and the controller's queued items (through session_delete).
   */
  async forgetAll(): Promise<void> {
    await this.ready;
    const topics = [...this.records.keys()].map(browserTopicFor);
    this.records.clear();
    if (this.store) await forgetBrowserConnections(this.store);
    for (const topic of topics) this.emitEvent('session_delete', { id: 0, topic });
    this.detachPage();
    this.changed();
  }
}

// ---------------------------------------------------------------------------
// One controller for WalletConnect and the browser
// ---------------------------------------------------------------------------

/** Events only the browser emits; they are never registered on WalletKit. */
const BROWSER_ONLY_EVENTS = ['browser_requests_withdrawn'];

/** Removes the browser-only identity field from an event WalletKit emitted (defence in depth). */
export function stripBrowserFields(event: unknown): unknown {
  if (typeof event !== 'object' || event === null || !('browserOrigin' in event)) return event;
  const copy: Record<string, unknown> = { ...(event as Record<string, unknown>) };
  delete copy.browserOrigin;
  return copy;
}

/**
 * docs/DAPP_BROWSER.md section 2.7: "a composite client routing by topic
 * prefix lets one controller serve both sources from the moment the browser
 * opens". The WalletKit client arrives later (it starts lazily); listeners
 * registered before then are attached to it when it does.
 */
export class CompositeWcClient implements WcClient {
  browser: BrowserBridgeClient;
  wallet: WcClient | null = null;
  subscriptions: { event: string; listener: Listener; wrapped: Listener }[] = [];

  constructor(browser: BrowserBridgeClient) {
    this.browser = browser;
  }

  /** Attaches WalletKit (once); existing listeners are registered on it. */
  setWalletClient(client: WcClient): void {
    if (this.wallet === client) return;
    if (this.wallet) throw new Error('The WalletConnect client is already attached.');
    this.wallet = client;
    for (const s of this.subscriptions) {
      if (!BROWSER_ONLY_EVENTS.includes(s.event)) client.on(s.event, s.wrapped);
    }
  }

  requireWallet(): WcClient {
    if (!this.wallet) throw new Error('WalletConnect is not running yet.');
    return this.wallet;
  }

  async pair(args: { uri: string }): Promise<unknown> {
    return this.requireWallet().pair(args);
  }

  async approveSession(args: { id: number; namespaces: Record<string, unknown> }): Promise<unknown> {
    return this.browser.ownsProposal(args.id) ? this.browser.approveSession(args) : this.requireWallet().approveSession(args);
  }

  async rejectSession(args: { id: number; reason: { code: number; message: string } }): Promise<unknown> {
    return this.browser.ownsProposal(args.id) ? this.browser.rejectSession(args) : this.requireWallet().rejectSession(args);
  }

  async respondSessionRequest(args: { topic: string; response: WcResponse }): Promise<unknown> {
    return isBrowserTopic(args.topic) ? this.browser.respondSessionRequest(args) : this.requireWallet().respondSessionRequest(args);
  }

  async disconnectSession(args: { topic: string; reason: { code: number; message: string } }): Promise<unknown> {
    return isBrowserTopic(args.topic) ? this.browser.disconnectSession(args) : this.requireWallet().disconnectSession(args);
  }

  getActiveSessions(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (this.wallet) {
      for (const [topic, session] of Object.entries(this.wallet.getActiveSessions())) {
        // A WalletConnect topic can never be a browser topic; skip one that is.
        if (!isBrowserTopic(topic)) out[topic] = session;
      }
    }
    return { ...out, ...this.browser.getActiveSessions() };
  }

  on(event: string, listener: Listener): unknown {
    // WalletKit's events lose any browser identity field, and a WalletKit
    // event naming a browser topic is dropped.
    const wrapped = ((e: unknown) => {
      const topic = (e as { topic?: unknown } | null)?.topic;
      if (isBrowserTopic(topic)) return;
      (listener as (args: unknown) => void)(stripBrowserFields(e));
    }) as Listener;
    this.subscriptions.push({ event, listener, wrapped });
    this.browser.on(event, listener);
    if (this.wallet && !BROWSER_ONLY_EVENTS.includes(event)) this.wallet.on(event, wrapped);
    return this;
  }

  off(event: string, listener: Listener): unknown {
    const index = this.subscriptions.findIndex((s) => s.event === event && s.listener === listener);
    this.browser.off(event, listener);
    if (index >= 0) {
      const [s] = this.subscriptions.splice(index, 1);
      if (this.wallet && s && !BROWSER_ONLY_EVENTS.includes(event)) this.wallet.off(event, s.wrapped);
    }
    return this;
  }
}

/** The allowlist's origins (for the screens and the checks). */
export function browserSiteOrigins(): string[] {
  return BROWSER_SITES.map((s) => s.origin);
}
