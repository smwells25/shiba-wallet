// Sign-In with Ethereum (EIP-4361) for the WalletConnect approval sheet and
// the proof-of-ownership screen (phase 11 item 3).
//
// Source: EIP-4361 "Sign-In with Ethereum", status Final, as published in
// ethereum/ERCs ERCS/erc-4361.md at commit
// faa49e076526bade48318f0d6e04d9a73f82c131 (2025-08-05), rendered at
// https://eips.ethereum.org/EIPS/eip-4361. The parser below follows the
// "ABNF Message Format" section of that text term by term; where this file
// is stricter than the ABNF, or has to interpret it, the comment says so.
//
// This module is pure: no React, no storage, no network. It is imported by
// walletconnect.ts (the sheet state), proof.ts and the Node check scripts
// (scripts/check-siwe.mjs, check-wc.mjs, check-proof.mjs) under Node's type
// stripping, so relative imports carry explicit .ts extensions.
//
// Nothing here changes what is signed. A SIWE message is signed exactly
// like any other personal_sign message (EIP-191 over its exact bytes); the
// parse only drives the summary card and its warnings.

import { toChecksumAddress } from '@shiba-wallet/core';

/**
 * The phrase the EIP tells wallets to look for: "Wallet implementers SHOULD
 * warn users if the substring "wants you to sign in with your Ethereum
 * account" appears anywhere in an ERC-191 message signing request unless the
 * message fully conforms to the format" (Wallet Implementer Steps,
 * Verifying the Message Format).
 */
export const SIWE_MARKER = 'wants you to sign in with your Ethereum account';
const HEADER_SUFFIX = ' wants you to sign in with your Ethereum account:';

/**
 * Wallet policy, not a standard: the EIP sets no maximum lengths but says
 * implementers SHOULD choose them (Security Considerations, "Maximum
 * Lengths for ABNF Terms"). 16 KiB and 64 resources are far above any
 * real sign-in message and keep the parser and the card bounded.
 */
export const SIWE_MAX_BYTES = 16 * 1024;
export const SIWE_MAX_RESOURCES = 64;

export interface SiweTime {
  /** The RFC 3339 string exactly as written in the message. */
  raw: string;
  /** Milliseconds since the Unix epoch (UTC). */
  ms: number;
}

export interface SiweMessage {
  /** The optional scheme before "://", as written (null when absent). */
  scheme: string | null;
  /** The RFC 3986 authority exactly as written ([userinfo@]host[:port]). */
  domain: string;
  /** userinfo before "@", or null. */
  userinfo: string | null;
  /** The host, lowercased (reg-name, IPv4 or bracketed IP literal). */
  host: string;
  /** The port digits, or null when absent or empty. */
  port: string | null;
  /** The address exactly as written. */
  address: string;
  /**
   * True when the address is in EIP-55 mixed-case form (or has no letters).
   * A mixed-case address with a WRONG checksum never parses; an all-lower
   * or all-upper one parses with this flag false (see parseSiweMessage).
   */
  addressChecksummed: boolean;
  /** The statement line, or null when absent or empty. */
  statement: string | null;
  uri: string;
  version: '1';
  chainId: bigint;
  nonce: string;
  issuedAt: SiweTime;
  expirationTime: SiweTime | null;
  notBefore: SiweTime | null;
  requestId: string | null;
  /** Resource URIs in order ([] when the Resources section is absent or empty). */
  resources: string[];
}

export type SiweParseResult = { ok: true; message: SiweMessage } | { ok: false; error: string };

// --- RFC 3986 character classes (section 2) -------------------------------

const UNRESERVED = 'A-Za-z0-9\\-._~';
const SUB_DELIMS = "!$&'()*+,;=";
const GEN_DELIMS = ':/?#\\[\\]@';
const PCT = '%[0-9A-Fa-f]{2}';

/** scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) */
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*$/;
/** userinfo = *( unreserved / pct-encoded / sub-delims / ":" ) */
const USERINFO_RE = new RegExp(`^(?:[${UNRESERVED}${SUB_DELIMS}:]|${PCT})*$`);
/** reg-name = *( unreserved / pct-encoded / sub-delims ) — non-empty here (wallet policy). */
const REG_NAME_RE = new RegExp(`^(?:[${UNRESERVED}${SUB_DELIMS}]|${PCT})+$`);
/**
 * IP-literal = "[" ( IPv6address / IPvFuture ) "]". The IPv6 grammar is
 * checked at the character level only (hex digits, ":" and "." for an
 * embedded IPv4 tail); IPvFuture per its ABNF.
 */
const IP_LITERAL_RE = new RegExp(`^\\[(?:[0-9A-Fa-f:.]+|v[0-9A-Fa-f]+\\.[${UNRESERVED}${SUB_DELIMS}:]+)\\]$`);
/**
 * URI = scheme ":" hier-part [ "?" query ] [ "#" fragment ]. Checked as: a
 * valid scheme, then only characters RFC 3986 allows in a URI (unreserved,
 * reserved, pct-encoded), with at most one "#". This is a character-level
 * check, not the full hier-part grammar.
 */
const URI_BODY_RE = new RegExp(`^(?:[${UNRESERVED}${GEN_DELIMS}${SUB_DELIMS}]|${PCT})*$`);
/** statement = *( reserved / unreserved / " " ) — ASCII, no line breaks, no "%". */
const STATEMENT_RE = new RegExp(`^[${UNRESERVED}${GEN_DELIMS}${SUB_DELIMS} ]*$`);
/** request-id = *pchar; pchar = unreserved / pct-encoded / sub-delims / ":" / "@" */
const REQUEST_ID_RE = new RegExp(`^(?:[${UNRESERVED}${SUB_DELIMS}:@]|${PCT})*$`);
/** nonce = 8*( ALPHA / DIGIT ) */
const NONCE_RE = /^[A-Za-z0-9]{8,}$/;
/** chain-id = 1*DIGIT (capped at 78 digits, i.e. above any uint256). */
const CHAIN_ID_RE = /^[0-9]{1,78}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const PORT_RE = /^[0-9]*$/;

/**
 * RFC 3339 section 5.6 date-time. Per its note, "T" and "Z" may also be
 * lower case. time-secfrac is optional; time-offset is "Z" or +hh:mm/-hh:mm.
 */
const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

export function isRfc3986Uri(value: string): boolean {
  const colon = value.indexOf(':');
  if (colon <= 0) return false;
  if (!SCHEME_RE.test(value.slice(0, colon))) return false;
  const rest = value.slice(colon + 1);
  if (!URI_BODY_RE.test(rest)) return false;
  return rest.indexOf('#') === rest.lastIndexOf('#');
}

export interface Authority {
  userinfo: string | null;
  /** Lowercased host. */
  host: string;
  /** Port digits, or null when absent or empty. */
  port: string | null;
}

/** authority = [ userinfo "@" ] host [ ":" port ] (RFC 3986 section 3.2). */
export function parseAuthority(value: string): Authority | null {
  if (value.length === 0) return null;
  const at = value.indexOf('@');
  if (at !== value.lastIndexOf('@')) return null; // "@" is not allowed in userinfo or host
  let userinfo: string | null = null;
  let hostport = value;
  if (at >= 0) {
    userinfo = value.slice(0, at);
    if (!USERINFO_RE.test(userinfo)) return null;
    hostport = value.slice(at + 1);
  }
  let host: string;
  let portPart: string | null = null;
  if (hostport.startsWith('[')) {
    const close = hostport.indexOf(']');
    if (close < 0) return null;
    host = hostport.slice(0, close + 1);
    if (!IP_LITERAL_RE.test(host)) return null;
    const after = hostport.slice(close + 1);
    if (after.length > 0) {
      if (!after.startsWith(':')) return null;
      portPart = after.slice(1);
    }
  } else {
    const colon = hostport.indexOf(':');
    host = colon >= 0 ? hostport.slice(0, colon) : hostport;
    if (colon >= 0) portPart = hostport.slice(colon + 1);
    if (!REG_NAME_RE.test(host)) return null;
  }
  if (portPart !== null && !PORT_RE.test(portPart)) return null;
  return { userinfo, host: host.toLowerCase(), port: portPart ? portPart : null };
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Parses an RFC 3339 date-time with range checks; null when invalid. */
export function parseRfc3339(raw: string): SiweTime | null {
  const m = DATE_TIME_RE.exec(raw);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 60) return null; // 60 = leap second (RFC 3339 5.7)
  let offsetMinutes = 0;
  const offset = m[8];
  if (offset !== 'Z' && offset !== 'z') {
    const oh = Number(offset.slice(1, 3));
    const om = Number(offset.slice(4, 6));
    if (oh > 23 || om > 59) return null;
    offsetMinutes = (offset[0] === '-' ? -1 : 1) * (oh * 60 + om);
  }
  const fraction = m[7] ? Number(`0${m[7]}`) : 0;
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  // A leap second (:60) lands on the first instant of the next minute.
  d.setUTCHours(hour, minute, second, Math.floor(fraction * 1000));
  return { raw, ms: d.getTime() - offsetMinutes * 60_000 };
}

function hexToBytes20(hex: string): Uint8Array {
  const out = new Uint8Array(20);
  for (let i = 0; i < 20; i++) out[i] = parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
}

/**
 * Strict EIP-4361 parser. Returns the fields or the first reason the text
 * does not conform. Interpretations, each a deliberate choice:
 *  - Line breaks are LF only (the ABNF's LF); any CR fails the parse, and so
 *    does a trailing line break (the ABNF ends at the last field).
 *  - Without a statement the ABNF yields TWO empty lines between the address
 *    and "URI: " (address LF, LF, [statement LF], LF). That is also what
 *    ox 0.9.3 Siwe.createMessage (the viem/ox builder) emits; a single
 *    empty line fails the parse.
 *  - A mixed-case address must be valid EIP-55 (the ABNF comment requires
 *    the checksum "where applicable (EOAs)"). All-lower / all-upper
 *    addresses parse with addressChecksummed = false because a contract
 *    account may legitimately be written without it.
 *  - The host must be non-empty (RFC 3986 allows an empty reg-name; a
 *    sign-in for "no site" is meaningless).
 *  - URIs are checked at the character level (see isRfc3986Uri).
 */
export function parseSiweMessage(text: string): SiweParseResult {
  const fail = (error: string): SiweParseResult => ({ ok: false, error });
  if (text.length > SIWE_MAX_BYTES) return fail(`longer than ${SIWE_MAX_BYTES} characters`);
  if (text.includes('\r')) return fail('uses carriage-return line breaks; the format allows LF only');
  const lines = text.split('\n');

  // Line 1: [ scheme "://" ] domain " wants you to sign in with your Ethereum account:"
  const header = lines[0];
  if (!header.endsWith(HEADER_SUFFIX)) {
    return fail('the first line must end with "wants you to sign in with your Ethereum account:"');
  }
  let originPart = header.slice(0, -HEADER_SUFFIX.length);
  let scheme: string | null = null;
  const sep = originPart.indexOf('://');
  if (sep >= 0) {
    scheme = originPart.slice(0, sep);
    if (!SCHEME_RE.test(scheme)) return fail(`"${scheme}" is not a valid URI scheme`);
    originPart = originPart.slice(sep + 3);
  }
  const authority = parseAuthority(originPart);
  if (!authority) return fail('the site name is not a valid domain (RFC 3986 authority)');

  // Line 2: address
  const address = lines[1];
  if (address === undefined || !ADDRESS_RE.test(address)) {
    return fail('the second line must be an Ethereum address (0x followed by 40 hex characters)');
  }
  const body = address.slice(2);
  const hasLower = /[a-f]/.test(body);
  const hasUpper = /[A-F]/.test(body);
  const checksummed = toChecksumAddress(hexToBytes20(address));
  let addressChecksummed = true;
  if (hasLower && hasUpper) {
    if (checksummed !== address) return fail('the address has a wrong EIP-55 checksum (capital letters)');
  } else if (hasLower || hasUpper) {
    addressChecksummed = address === checksummed;
  }

  // Line 3 empty, then [ statement LF ] LF "URI: "
  if (lines[2] !== '') return fail('an empty line must follow the address');
  let statement: string | null = null;
  let idx: number;
  if (lines[3] === '' && lines[4] !== undefined && lines[4].startsWith('URI: ')) {
    idx = 4;
  } else if (lines[3] !== undefined && lines[4] === '') {
    if (!STATEMENT_RE.test(lines[3])) {
      return fail('the statement may contain only plain ASCII letters, digits, spaces and URI punctuation');
    }
    statement = lines[3] === '' ? null : lines[3];
    idx = 5;
  } else if (lines[3] !== undefined && lines[3].startsWith('URI: ')) {
    return fail('without a statement the format needs two empty lines between the address and "URI:"');
  } else {
    return fail('the statement must be one line, with an empty line before "URI:"');
  }

  const field = (label: string): string | null => {
    const line = lines[idx];
    if (line === undefined || !line.startsWith(label)) return null;
    idx += 1;
    return line.slice(label.length);
  };

  const uri = field('URI: ');
  if (uri === null) return fail('"URI: " is missing or out of order');
  if (!isRfc3986Uri(uri)) return fail('the URI is not a valid RFC 3986 URI');
  const version = field('Version: ');
  if (version === null) return fail('"Version: " is missing or out of order');
  if (version !== '1') return fail(`version must be 1, not "${version}"`);
  const chainRaw = field('Chain ID: ');
  if (chainRaw === null) return fail('"Chain ID: " is missing or out of order');
  if (!CHAIN_ID_RE.test(chainRaw)) return fail('the chain ID must be digits only');
  const nonce = field('Nonce: ');
  if (nonce === null) return fail('"Nonce: " is missing or out of order');
  if (!NONCE_RE.test(nonce)) return fail('the nonce must be at least 8 letters or digits');
  const issuedRaw = field('Issued At: ');
  if (issuedRaw === null) return fail('"Issued At: " is missing or out of order');
  const issuedAt = parseRfc3339(issuedRaw);
  if (!issuedAt) return fail('"Issued At" is not a valid RFC 3339 date-time');

  let expirationTime: SiweTime | null = null;
  const expRaw = field('Expiration Time: ');
  if (expRaw !== null) {
    expirationTime = parseRfc3339(expRaw);
    if (!expirationTime) return fail('"Expiration Time" is not a valid RFC 3339 date-time');
  }
  let notBefore: SiweTime | null = null;
  const nbRaw = field('Not Before: ');
  if (nbRaw !== null) {
    notBefore = parseRfc3339(nbRaw);
    if (!notBefore) return fail('"Not Before" is not a valid RFC 3339 date-time');
  }
  const requestId = field('Request ID: ');
  if (requestId !== null && !REQUEST_ID_RE.test(requestId)) {
    return fail('the request ID contains characters a URI path segment cannot');
  }
  const resources: string[] = [];
  if (lines[idx] === 'Resources:') {
    idx += 1;
    while (idx < lines.length) {
      const line = lines[idx];
      if (line === '' && idx === lines.length - 1) return fail('the message ends with an extra line break');
      if (!line.startsWith('- ')) return fail(`resource line ${resources.length + 1} must start with "- "`);
      const resource = line.slice(2);
      if (!isRfc3986Uri(resource)) return fail(`resource ${resources.length + 1} is not a valid RFC 3986 URI`);
      resources.push(resource);
      if (resources.length > SIWE_MAX_RESOURCES) return fail(`more than ${SIWE_MAX_RESOURCES} resources`);
      idx += 1;
    }
  }
  if (idx < lines.length) {
    return lines[idx] === '' && idx === lines.length - 1
      ? fail('the message ends with an extra line break')
      : fail(`unexpected line ${idx + 1} ("${lines[idx].slice(0, 40)}")`);
  }

  return {
    ok: true,
    message: {
      scheme,
      domain: originPart,
      userinfo: authority.userinfo,
      host: authority.host,
      port: authority.port,
      address,
      addressChecksummed,
      statement,
      uri,
      version: '1',
      chainId: BigInt(chainRaw),
      nonce,
      issuedAt,
      expirationTime,
      notBefore,
      requestId,
      resources,
    },
  };
}

// --- Classifying a personal_sign payload -----------------------------------

export type SiweClassification =
  | { kind: 'none' }
  /** Mentions the sign-in phrase but does not conform (or is not printable text). */
  | { kind: 'malformed'; reason: string; printable: boolean }
  | { kind: 'siwe'; message: SiweMessage };

/**
 * Decides whether a personal_sign payload is a SIWE message. `printableText`
 * is the sheet's display decode (walletconnect.ts decodeMessageForDisplay):
 * null when the bytes are not valid UTF-8 or contain control characters.
 * The phrase is searched case-insensitively in a lenient decode so a
 * non-printable or oddly-cased imitation still gets the EIP's warning.
 */
export function classifySiweBytes(bytes: Uint8Array, printableText: string | null): SiweClassification {
  const lenient = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (!lenient.toLowerCase().includes(SIWE_MARKER.toLowerCase())) return { kind: 'none' };
  if (printableText === null) {
    return { kind: 'malformed', reason: 'it is not plain printable text', printable: false };
  }
  const parsed = parseSiweMessage(printableText);
  if (!parsed.ok) return { kind: 'malformed', reason: parsed.error, printable: true };
  return { kind: 'siwe', message: parsed.message };
}

// --- Origin binding (EIP-4361 "Verifying the Request Origin") ---------------

const DEFAULT_PORTS: Record<string, string> = { https: '443', http: '80', wss: '443', ws: '80' };

export interface ParsedOrigin {
  scheme: string;
  host: string;
  port: string | null;
}

/** scheme://authority from an origin or URL string, without relying on URL(). */
export function parseOriginUrl(url: string): ParsedOrigin | null {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)/.exec(url.trim());
  if (!m) return null;
  const authority = parseAuthority(m[2]);
  if (!authority) return null;
  return { scheme: m[1].toLowerCase(), host: authority.host, port: authority.port };
}

export type OriginProblem =
  | { kind: 'no-origin' }
  | { kind: 'host'; originHost: string; subdomain: boolean }
  | { kind: 'scheme'; messageScheme: string; originScheme: string }
  | { kind: 'port'; messagePort: string; originPort: string };

/**
 * The EIP's RECOMMENDED wallet algorithm, reduced to comparisons: scheme
 * (default https when the message names none), host (exact, case-
 * insensitive — a different subdomain is a different host), then port
 * (each side's explicit port, else its scheme's default). The EIP says a
 * wallet MUST reject a host mismatch outside developer mode; this wallet
 * WARNS instead and leaves the decision to the user (phase 11 item 3 brief:
 * never decline automatically) — recorded in the report as a deviation.
 */
export function checkSiweOrigin(message: SiweMessage, originUrl: string | null): OriginProblem[] {
  const origin = originUrl ? parseOriginUrl(originUrl) : null;
  if (!origin) return [{ kind: 'no-origin' }];
  const problems: OriginProblem[] = [];
  const scheme = (message.scheme ?? 'https').toLowerCase();
  if (message.host !== origin.host) {
    const subdomain =
      message.host.endsWith(`.${origin.host}`) || origin.host.endsWith(`.${message.host}`);
    problems.push({ kind: 'host', originHost: origin.host, subdomain });
    return problems; // a different site: scheme/port details would only add noise
  }
  if (scheme !== origin.scheme) {
    problems.push({ kind: 'scheme', messageScheme: scheme, originScheme: origin.scheme });
  }
  const messagePort = message.port ?? DEFAULT_PORTS[scheme] ?? '';
  const originPort = origin.port ?? DEFAULT_PORTS[origin.scheme] ?? '';
  if (messagePort !== originPort) {
    problems.push({ kind: 'port', messagePort: messagePort || '(none)', originPort: originPort || '(none)' });
  }
  return problems;
}

// --- Display -----------------------------------------------------------------

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** "2021-09-30 16:25:24 UTC" (Intl-free, deterministic). */
export function formatUtcMs(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())} UTC`
  );
}

/** "in 5 min", "3 h ago", "just now" … */
export function relativeTime(ms: number, nowMs: number): string {
  const delta = ms - nowMs;
  const abs = Math.abs(delta) / 1000;
  if (abs < 60) return 'just now';
  let span: string;
  if (abs < 3600) span = `${Math.round(abs / 60)} min`;
  else if (abs < 86_400) span = `${Math.round(abs / 3600)} h`;
  else if (abs < 730 * 86_400) span = `${Math.round(abs / 86_400)} days`;
  else span = `about ${Math.round(abs / (365 * 86_400))} years`;
  return delta > 0 ? `in ${span}` : `${span} ago`;
}

export function formatSiweTime(time: SiweTime, nowMs: number): string {
  return `${formatUtcMs(time.ms)} (${relativeTime(time.ms, nowMs)})`;
}

export interface SiweRow {
  label: string;
  value: string;
  mono?: boolean;
}

export interface SiweSummary {
  /** "Sign in to example.com" */
  title: string;
  rows: SiweRow[];
  resources: string[];
  /** Shown in the warning style. */
  warnings: string[];
  /**
   * Set when the site does not match the request origin (host, scheme or
   * port after default ports) or the domain carries a userinfo@ part: the
   * EIP-4361 "MUST reject" case. The approval sheet then puts Sign behind
   * the existing risk switch (walletconnect.ts applySiweGate) — nothing is
   * declined automatically. Null otherwise; every other warning stays
   * informational.
   */
  gate: string | null;
  /** Plain hints (not warnings). */
  notes: string[];
}

export interface SiweDescribeContext {
  /**
   * Where the request came from: the WalletConnect Verify-attested origin
   * ('verify') or, when that is unknown, the URL the dApp gives for itself
   * in its session metadata ('metadata'); for the wallet's in-app browser,
   * the page's origin as the web view reported it ('browser'); null when
   * none exists.
   */
  origin: { url: string; source: 'verify' | 'metadata' | 'browser' } | null;
  /** The address this connection signs as (EOA or bound smart account). */
  sessionAddress: string;
  /** Numeric id of the ACTIVE chain. */
  activeChainId: bigint;
  /** Human name of a numeric chain id, or null when the wallet does not know it. */
  chainName: (chainId: bigint) => string | null;
  nowMs: number;
  /** Set on smart-account sessions (the signature is ERC-1271 / ERC-6492). */
  smartAccount: { address: string } | null;
}

export const SIWE_INFO_NOTE =
  'Signing logs you in to this site. It costs nothing and moves no funds, and the signature ' +
  'is the same ordinary message signature (EIP-191) the wallet always produces.';

export const SIWE_SMART_ACCOUNT_NOTE =
  'This connection signs as your smart account, so the site receives an ERC-1271 smart-account ' +
  'signature (ERC-6492-wrapped while the account is not deployed) and must check it on the ' +
  'chain named in the message. Sites that only accept plain account signatures will reject it.';

function chainLabel(id: bigint, ctx: SiweDescribeContext): string {
  const name = ctx.chainName(id);
  return name ? `${name} (chain ID ${id})` : `chain ID ${id}`;
}

/**
 * The summary card for a parsed SIWE message: every field (the EIP's
 * display rule — scheme, domain, address, statement and resources by
 * default, all other fields available), plus warnings for the cases that
 * make a sign-in suspicious. Informational only: nothing here declines.
 */
export function describeSiweMessage(message: SiweMessage, ctx: SiweDescribeContext): SiweSummary {
  const warnings: string[] = [];
  const notes: string[] = [];
  let gate: string | null = null;
  const site = message.domain;
  const host = message.host;

  // 1. Domain binding — "the wallet has to confirm that the SIWE Message is
  //    for the correct request origin ... otherwise the user is subject to
  //    phishing attacks" (EIP-4361 Security Considerations).
  for (const problem of checkSiweOrigin(message, ctx.origin?.url ?? null)) {
    if (problem.kind === 'no-origin') {
      warnings.push(
        `The wallet could not tell which site sent this request, so it cannot check that this ` +
          `sign-in is really for ${host}. Sign only if you opened ${host} yourself.`,
      );
    } else if (problem.kind === 'host') {
      gate = gate ?? `This sign-in is for ${host}, not the site that asked for it.`;
      const from =
        ctx.origin?.source === 'verify'
          ? `${problem.originHost} (confirmed by WalletConnect)`
          : ctx.origin?.source === 'browser'
            ? `${problem.originHost} (the page open in this wallet’s browser)`
            : `${problem.originHost} (the address the dApp gives for itself)`;
      warnings.push(
        `This sign-in is for ${host}, but the request came from ${from}. ` +
          (problem.subdomain ? 'A different subdomain is a different site. ' : '') +
          'A site that asks you to sign in to ANOTHER site is the typical sign-in phishing attack ' +
          '(EIP-4361, security considerations). Do not sign unless you are sure.',
      );
    } else if (problem.kind === 'scheme') {
      gate = gate ?? `This sign-in names ${problem.messageScheme}:// but the request came from a ${problem.originScheme}:// page.`;
      warnings.push(
        `This sign-in names ${problem.messageScheme}:// but the request came from a ` +
          `${problem.originScheme}:// page.`,
      );
    } else {
      gate = gate ?? `This sign-in is for port ${problem.messagePort} of ${host}, not the port the request came from.`;
      warnings.push(
        `This sign-in is for port ${problem.messagePort} of ${host}, but the request came from ` +
          `port ${problem.originPort}.`,
      );
    }
  }
  if (message.userinfo !== null) {
    gate = gate ?? `The site name hides the real site (${host}) behind "${message.userinfo}@".`;
    warnings.push(
      `The site name starts with "${message.userinfo}@". A user-name part like that is a trick ` +
        `used to disguise the real site, which is ${host}.`,
    );
  }
  if (ctx.origin?.source === 'metadata' && !warnings.length) {
    notes.push(
      'The site matches the address the dApp gives for itself; WalletConnect could not confirm ' +
        'where the request came from.',
    );
  }

  // 2. Account.
  if (message.address.toLowerCase() !== ctx.sessionAddress.toLowerCase()) {
    warnings.push(
      `This sign-in names the account ${message.address}, but this connection signs as ` +
        `${ctx.sessionAddress}. The site would receive a signature that does not match the ` +
        'account it names.',
    );
  }
  if (!message.addressChecksummed) {
    notes.push('The account is written without its EIP-55 capital-letter checksum.');
  }

  // 3. Chain.
  if (message.chainId !== ctx.activeChainId) {
    warnings.push(
      `This sign-in is for ${chainLabel(message.chainId, ctx)}, but the wallet is on ` +
        `${chainLabel(ctx.activeChainId, ctx)}.` +
        (ctx.smartAccount
          ? ' The site checks a smart-account signature on the chain in the message, where it may not be valid.'
          : ''),
    );
  }

  // 4. Validity window.
  if (message.expirationTime && message.expirationTime.ms <= ctx.nowMs) {
    warnings.push(
      `This sign-in expired ${relativeTime(message.expirationTime.ms, ctx.nowMs)} ` +
        `(${formatUtcMs(message.expirationTime.ms)}). A site should not ask you to sign an expired login.`,
    );
  }
  if (message.notBefore && message.notBefore.ms > ctx.nowMs) {
    warnings.push(
      `This sign-in only becomes valid ${relativeTime(message.notBefore.ms, ctx.nowMs)} ` +
        `(${formatUtcMs(message.notBefore.ms)}).`,
    );
  }

  if (ctx.smartAccount) notes.push(SIWE_SMART_ACCOUNT_NOTE);
  notes.push(SIWE_INFO_NOTE);

  const rows: SiweRow[] = [
    {
      label: 'Site',
      value: message.scheme ? `${message.scheme}://${site}` : `${site} (https assumed — no scheme given)`,
    },
    { label: 'Account', value: message.address, mono: true },
    { label: 'Network', value: chainLabel(message.chainId, ctx) },
  ];
  if (message.statement !== null) rows.push({ label: 'Statement', value: message.statement });
  rows.push({ label: 'URI', value: message.uri, mono: true });
  rows.push({ label: 'Version', value: message.version });
  rows.push({ label: 'Nonce', value: message.nonce, mono: true });
  rows.push({ label: 'Issued', value: formatSiweTime(message.issuedAt, ctx.nowMs) });
  rows.push({
    label: 'Expires',
    value: message.expirationTime ? formatSiweTime(message.expirationTime, ctx.nowMs) : 'No expiry set',
  });
  if (message.notBefore) rows.push({ label: 'Not before', value: formatSiweTime(message.notBefore, ctx.nowMs) });
  if (message.requestId !== null) rows.push({ label: 'Request ID', value: message.requestId, mono: true });

  return {
    title: `Sign in to ${host}`,
    rows,
    resources: message.resources,
    warnings,
    notes,
    gate:
      gate === null
        ? null
        : `${gate} Sign-In with Ethereum requires wallets to refuse this (EIP-4361, "Verifying the Request ` +
          'Origin"), so Sign stays off until you turn on the switch below.',
  };
}

/**
 * The warnings for a payload that mentions the sign-in phrase but does not
 * conform — the EIP's "SHOULD warn" case — plus the non-printable one.
 */
export function malformedSiweWarnings(reason: string, printable: boolean): string[] {
  const out = [
    `This message says "${SIWE_MARKER}" but does not follow the Sign-In with Ethereum format ` +
      `(${reason}). The wallet cannot check which site it logs you in to, so treat it as an ` +
      'ordinary message and sign only if you trust this dApp.',
  ];
  if (!printable) {
    out.push(
      'It also contains bytes that are not printable text, so what is shown may not be ' +
        'everything you sign.',
    );
  }
  return out;
}
