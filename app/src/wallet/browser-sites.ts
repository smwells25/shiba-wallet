// Explicit .ts extensions: this module is imported by scripts/check-browser.mjs
// under Node's type stripping, which resolves relative specifiers literally.
import type { KeyValueStore } from './tokens.ts';

/**
 * The in-app browser's allowlist, its origin parser and the per-origin
 * connection records (feature 79, the allowlisted-sites slice of
 * docs/DAPP_BROWSER.md section 5). Pure TypeScript with no React or React
 * Native imports, so scripts/check-browser.mjs exercises exactly this file.
 *
 * WHY THE WALLET HAS ITS OWN ORIGIN PARSER. react-native-webview 13.16.1
 * turns each `originWhitelist` entry into the regular expression
 * `^` + escaped entry, with `*` replaced by `.*` and no end anchor
 * (src/WebViewShared.tsx, originWhitelistToRegex), so the entry
 * `https://app.uniswap.org` also admits `https://app.uniswap.org.attacker.example`
 * (finding B1 of docs/DAPP_BROWSER.md section 3.3). Every allow / refuse
 * decision in the browser is therefore made here, by EXACT comparison of
 * the scheme, host and port this parser computes.
 *
 * The parser is deliberately stricter than the WHATWG URL standard: where
 * a browser would silently rewrite the input (a backslash read as a slash,
 * tabs and newlines removed, percent-encoded or non-ASCII host characters
 * decoded or converted), this parser refuses the input instead, so the
 * wallet never compares a string that differs from the one the web engine
 * will use. Whatever it accepts, it maps to exactly the origin that
 * WHATWG's `new URL(input).origin` gives (scripts/check-browser.mjs compares
 * the two on every accepted test input).
 */

/** A parsed web origin: lower-case scheme and host, and a non-default port or ''. */
export interface WebOrigin {
  scheme: string;
  host: string;
  /** '' for the scheme's default port (443 for https), else the decimal port. */
  port: string;
  /** scheme://host[:port], the form WHATWG's URL.origin serialises. */
  origin: string;
  /**
   * True when the authority carried a user-info part ("name@" or
   * "name:password@"), which is a known way to make a URL look like another
   * site's. The host above is the REAL host after the "@". Such a URL is
   * never allowlisted.
   */
  hadUserinfo: boolean;
}

/**
 * Default ports of WHATWG's special schemes, removed from the origin as
 * URL.origin does. Only https is ever allowlisted; the others are here so
 * the parser agrees with WHATWG on every input it accepts.
 */
const DEFAULT_PORTS: Readonly<Record<string, string>> = { https: '443', http: '80', wss: '443', ws: '80', ftp: '21' };

/**
 * Parses a URL (or an origin) into its origin, or returns null when the
 * input is not something this wallet will compare: no scheme, a scheme
 * without "//", an empty, non-ASCII, percent-encoded or bracketed (IPv6)
 * host, a port outside 0–65535, or any whitespace, control character or
 * backslash anywhere in the input.
 */
export function parseWebOrigin(input: unknown): WebOrigin | null {
  if (typeof input !== 'string' || input.length === 0 || input.length > 8192) return null;
  // Control characters, spaces, DEL and backslashes anywhere: WHATWG strips
  // tabs and newlines and treats "\" as "/" for special schemes, so the web
  // engine and a naive parser would disagree about the host.
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f || code === 0x5c) return null;
  }
  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)/.exec(input);
  if (!schemeMatch) return null;
  const scheme = schemeMatch[1]!.toLowerCase();
  let authority = schemeMatch[2]!;
  let hadUserinfo = false;
  const at = authority.lastIndexOf('@');
  if (at >= 0) {
    hadUserinfo = true;
    authority = authority.slice(at + 1);
  }
  let hostPart = authority;
  let portPart: string | null = null;
  const colon = authority.lastIndexOf(':');
  if (colon >= 0) {
    hostPart = authority.slice(0, colon);
    portPart = authority.slice(colon + 1);
  }
  // ASCII letters, digits, hyphens and dots only. This refuses non-ASCII
  // (internationalised) hosts — WHATWG would convert them to punycode — and
  // "%" (WHATWG percent-decodes hosts) and "[" (IPv6 literals). A punycode
  // host ("xn--…") is plain ASCII and is compared exactly as written.
  if (hostPart.length === 0 || hostPart.length > 253 || !/^[A-Za-z0-9.-]+$/.test(hostPart)) return null;
  if (hostPart.startsWith('.') || hostPart.includes('..')) return null;
  const host = hostPart.toLowerCase();
  let port = '';
  if (portPart !== null && portPart !== '') {
    if (!/^[0-9]{1,5}$/.test(portPart)) return null;
    const n = Number(portPart);
    if (n > 65535) return null;
    port = String(n);
  }
  if (port === DEFAULT_PORTS[scheme]) port = '';
  return { scheme, host, port, origin: `${scheme}://${host}${port ? `:${port}` : ''}`, hadUserinfo };
}

/** True only when both inputs parse and their origins are identical strings. */
export function sameOrigin(a: unknown, b: unknown): boolean {
  const pa = parseWebOrigin(a);
  const pb = parseWebOrigin(b);
  return pa !== null && pb !== null && pa.origin === pb.origin;
}

// ---------------------------------------------------------------------------
// The allowlist
// ---------------------------------------------------------------------------

export interface BrowserSite {
  /** The exact origin (https, lower-case host, no port, no path). */
  origin: string;
  /** Plain name for the Apps list. */
  name: string;
  /** One line for the Apps list: what a tester can do there. */
  description: string;
  /** Why the site is on the list (shown on the Apps screen, kept honest). */
  reason: string;
}

/**
 * The fixed allowlist: exact https origins, no wildcards, no user entries.
 * Only sites a tester can use on a test network today, each with the
 * reason it is here. The list is code, not configuration: adding a site is
 * a reviewed change.
 *
 * Kept short on purpose (docs/DAPP_BROWSER.md section 4.3, decision 2, and
 * section 4.2: NFT marketplaces stay off the list).
 */
export const BROWSER_SITES: readonly BrowserSite[] = [
  {
    origin: 'https://app.uniswap.org',
    name: 'Uniswap',
    description: 'Swap test tokens on Ethereum Sepolia.',
    // Phase 3 proved WalletConnect v2 live with this site, and every later
    // WalletConnect live test used it; phase 14 swapped on Uniswap v3 on
    // Sepolia (SwapRouter02 from docs.uniswap.org). Recorded in AGENTS.md.
    reason:
      'The decentralised exchange this wallet has already used on Ethereum Sepolia over WalletConnect.',
  },
  {
    origin: 'https://app.ens.dev',
    name: 'ENS (Sepolia)',
    description: 'Register and manage test-network ENS names on Ethereum Sepolia.',
    // ENS's own deployments page (docs.ens.domains/learn/deployments, read
    // 2026-10-09), section "Sepolia (ENSv2)": "Sepolia runs the ENSv2
    // contracts: the Universal Resolver and the ENS apps for Sepolia
    // resolve through this deployment. Interact with it via the ENS App",
    // linking https://app.ens.dev. The wallet already resolves Sepolia ENS
    // names on the Send screen (phase 14 item 2), so a name registered here
    // can be paid to there. Not yet opened in the wallet's browser.
    reason:
      'ENS’s own documentation names this site as the ENS app for Ethereum Sepolia; Send already resolves Sepolia names.',
  },
];

/** The allowlisted site for an exact origin, or null. */
export function siteForOrigin(origin: string): BrowserSite | null {
  return BROWSER_SITES.find((s) => s.origin === origin) ?? null;
}

/**
 * The allowlisted site a URL belongs to, or null. Requires https, no
 * user-info part, and an origin EXACTLY equal to an entry (so
 * "https://app.uniswap.org.attacker.example", "https://app.uniswap.org@evil.example",
 * "https://APP.uniswap.org:8443" and "https://app.uniswap.org." are all null).
 */
export function siteForUrl(url: unknown): BrowserSite | null {
  const parsed = parseWebOrigin(url);
  if (!parsed || parsed.scheme !== 'https' || parsed.hadUserinfo) return null;
  return siteForOrigin(parsed.origin);
}

/** True when `origin` (already an origin string) is on the allowlist. */
export function isAllowlistedOrigin(origin: string | null | undefined): boolean {
  return typeof origin === 'string' && siteForOrigin(origin) !== null;
}

// ---------------------------------------------------------------------------
// Navigation decisions
// ---------------------------------------------------------------------------

export type NavigationDecision =
  | { kind: 'allow' }
  /** Not loaded; the wallet may offer to open it in the system browser after a confirmation. */
  | { kind: 'external'; url: string; host: string }
  /** Not loaded and not offered anywhere (a non-https scheme, a user-info URL, unparseable). */
  | { kind: 'refuse'; reason: string };

export const NAV_REFUSAL_SCHEME =
  'This link uses a scheme other than https, so the in-app browser does not open it and does not hand it to another app.';
export const NAV_REFUSAL_USERINFO =
  'This link hides its real site behind a name and an "@", a known disguise, so the in-app browser does not open it.';
export const NAV_REFUSAL_UNREADABLE = 'This link could not be read, so the in-app browser does not open it.';

/**
 * What the browser does with a navigation (the library's
 * onShouldStartLoadWithRequest, the first URL before load, and new-window
 * requests).
 *
 * `isTopFrame` is reported by iOS only: the library's Android event has no
 * such field (android RNCWebViewClient.createWebViewEvent puts target, url,
 * loading, title, canGoBack and canGoForward, nothing else), so on Android
 * every navigation is judged as a top-frame navigation, which is the
 * stricter rule. A subframe (iOS, isTopFrame === false) may load any https
 * page and the blank documents frames start with: the frame rule in
 * browser-bridge.ts drops every message a subframe sends, so a frame can
 * show content but cannot reach the wallet.
 *
 * Nothing here ever calls Linking: a refused URL is simply not loaded. The
 * library's own Linking fallback (finding B6) is unreachable because the
 * screen passes originWhitelist={['*']}, whose expression `^.*` matches
 * every string, so the library always defers to this decision.
 */
export function decideNavigation(url: unknown, options: { isTopFrame?: boolean } = {}): NavigationDecision {
  if (typeof url !== 'string') return { kind: 'refuse', reason: NAV_REFUSAL_UNREADABLE };
  const subframe = options.isTopFrame === false;
  if (subframe && (url === 'about:blank' || url === 'about:srcdoc')) return { kind: 'allow' };
  const parsed = parseWebOrigin(url);
  if (!parsed) {
    return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(url) && !/^https:/i.test(url)
      ? { kind: 'refuse', reason: NAV_REFUSAL_SCHEME }
      : { kind: 'refuse', reason: NAV_REFUSAL_UNREADABLE };
  }
  if (parsed.scheme !== 'https') return { kind: 'refuse', reason: NAV_REFUSAL_SCHEME };
  if (parsed.hadUserinfo) return { kind: 'refuse', reason: NAV_REFUSAL_USERINFO };
  if (subframe) return { kind: 'allow' };
  if (siteForOrigin(parsed.origin)) return { kind: 'allow' };
  return { kind: 'external', url, host: parsed.host };
}

/** The confirmation shown before an off-list link opens in the system browser. */
export function externalLinkMessage(host: string, url: string): string {
  return (
    `${host} is not on this wallet’s list of apps, so it does not open in the in-app browser. ` +
    `Open it in the phone’s own browser instead? The wallet is not connected there.\n\n${url}`
  );
}

// ---------------------------------------------------------------------------
// Per-origin connection records (public data only)
// ---------------------------------------------------------------------------

/**
 * One connection the user approved for one origin: public data only (no
 * key material), stored beside the app's other connection state. A
 * smart-account connection records the smart account as `address` and its
 * owner EOA as `owner`; a regular one has owner === address.
 */
export interface BrowserConnectionRecord {
  origin: string;
  /** The address the site sees (EOA or smart account). */
  address: string;
  /** The account that must be active for the connection to be served. */
  owner: string;
  /** CAIP-2 id of the chain the connection was approved on. */
  chain: string;
  /** The approved WalletConnect-style namespaces (methods, events, CAIP-10 accounts). */
  namespaces: Record<string, unknown>;
  /** Unix milliseconds. */
  approvedAt: number;
}

export const BROWSER_CONNECTIONS_KEY = 'shiba-wallet.browser-connections.v1';

function isAddress(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function reviveRecord(value: unknown): BrowserConnectionRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Record<string, unknown>;
  if (typeof r.origin !== 'string' || !isAllowlistedOrigin(r.origin)) return null;
  if (!isAddress(r.address) || !isAddress(r.owner)) return null;
  if (typeof r.chain !== 'string' || !/^eip155:[0-9]{1,20}$/.test(r.chain)) return null;
  if (typeof r.namespaces !== 'object' || r.namespaces === null) return null;
  if (typeof r.approvedAt !== 'number' || !Number.isFinite(r.approvedAt)) return null;
  return {
    origin: r.origin,
    address: r.address,
    owner: r.owner,
    chain: r.chain,
    namespaces: r.namespaces as Record<string, unknown>,
    approvedAt: r.approvedAt,
  };
}

/**
 * Loads the stored records. A record for an origin that is no longer on
 * the allowlist, or a malformed one, is dropped (never served).
 */
export async function loadBrowserConnections(store: KeyValueStore): Promise<BrowserConnectionRecord[]> {
  let raw: string | null = null;
  try {
    raw = await store.getItem(BROWSER_CONNECTIONS_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    const seen = new Set<string>();
    const out: BrowserConnectionRecord[] = [];
    for (const entry of list) {
      const record = reviveRecord(entry);
      if (record && !seen.has(record.origin)) {
        seen.add(record.origin);
        out.push(record);
      }
    }
    return out;
  } catch {
    return [];
  }
}

export async function saveBrowserConnections(
  records: readonly BrowserConnectionRecord[],
  store: KeyValueStore,
): Promise<void> {
  await store.setItem(BROWSER_CONNECTIONS_KEY, JSON.stringify(records));
}

/** Removes every record (wallet wipe). */
export async function forgetBrowserConnections(store: KeyValueStore): Promise<void> {
  await store.setItem(BROWSER_CONNECTIONS_KEY, '[]');
}
