// Explicit .ts extensions: this module is imported by
// scripts/check-typed-data.mjs under Node's type stripping, which resolves
// relative specifiers literally.
import { toChecksumAddress } from '@shiba-wallet/core';
import { toBytes, type RecipientClass, type TypedDataDomain, type TypedDataTypes } from '@shiba-wallet/chains-evm';
import { formatUnits, groupThousands } from './balances.ts';
import { maskAmount } from '../config/prefs.ts';

/**
 * Plain-language summaries of EIP-712 typed-data requests for the
 * WalletConnect approval sheet (threat-model finding N-07: permit-style
 * signatures are the most likely route to a mainnet drain, and the sheet
 * used to show only raw JSON).
 *
 * INFORMATIONAL ONLY. The summary never decides anything: the request is
 * still parsed, domain-checked and hashed by walletconnect.ts
 * parseTypedDataV4 exactly as before, the raw message stays on screen below
 * the summary, and a request that cannot be summarised is shown with the
 * generic field list — never declined for that reason.
 *
 * A schema is recognised only when the request's OWN type definition for
 * the primary type (and its nested structs) matches the canonical one field
 * for field — names, types and order — because those definitions are what
 * the signed digest commits to. A look-alike type with an extra or renamed
 * field gets the generic list.
 *
 * Canonical sources (fetched 2026-10-02):
 *  - EIP-2612 (Final), ethereum/ERCs ERCS/erc-2612.md: typehash
 *    keccak256("Permit(address owner,address spender,uint256 value,uint256
 *    nonce,uint256 deadline)"); the token is the domain's verifyingContract;
 *    `deadline` bounds when the signature can be submitted ("can be set to
 *    uint(-1) to create Permits that effectively never expire"); the
 *    resulting allowance itself does not expire.
 *  - DAI-style permit, makerdao/dss src/dai.sol at fa4f6630: typehash of
 *    "Permit(address holder,address spender,uint256 nonce,uint256 expiry,
 *    bool allowed)"; `require(expiry == 0 || now <= expiry)` (expiry 0 never
 *    expires) and `uint wad = allowed ? uint(-1) : 0` (allowed = unlimited,
 *    not allowed = revoke).
 *  - Uniswap Permit2, Uniswap/permit2 at cc56ad0f: src/libraries/PermitHash.sol
 *    (PermitDetails(address token,uint160 amount,uint48 expiration,uint48
 *    nonce); PermitSingle(PermitDetails details,address spender,uint256
 *    sigDeadline); PermitBatch(PermitDetails[] details,address spender,
 *    uint256 sigDeadline); TokenPermissions(address token,uint256 amount);
 *    PermitTransferFrom(TokenPermissions permitted,address spender,uint256
 *    nonce,uint256 deadline); PermitBatchTransferFrom(TokenPermissions[]
 *    permitted,...); the Witness variants append one witness field);
 *    src/EIP712.sol (domain EIP712Domain(string name,uint256 chainId,address
 *    verifyingContract) with name "Permit2", no version);
 *    src/interfaces/IAllowanceTransfer.sol ("Setting amount to
 *    type(uint160).max sets an unlimited approval"); src/libraries/
 *    Allowance.sol (expiration 0 = BLOCK_TIMESTAMP_EXPIRATION, i.e. stored
 *    as the current block's timestamp); src/libraries/Permit2Lib.sol line 27
 *    and test/utils/DeployPermit2.sol: the canonical address
 *    0x000000000022D473030F116dDEE9F6B43aC78BA3 (eth_getCode returned the
 *    same 9,152 bytes on mainnet and Sepolia, 2026-10-02).
 */

export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
export const MAX_UINT256 = (1n << 256n) - 1n;
export const MAX_UINT160 = (1n << 160n) - 1n;
export const MAX_UINT48 = (1n << 48n) - 1n;
/** Expiries further out than this get a warning line. */
export const FAR_FUTURE_SECONDS = 30 * 24 * 60 * 60;
/** Beyond year 9999 a timestamp is shown as "never". */
const LAST_DISPLAYABLE_SECOND = 253_402_300_799n;
const MAX_GENERIC_ROWS = 60;

export type TypedDataSummaryKind =
  | 'erc2612-permit'
  | 'dai-permit'
  | 'permit2-allowance'
  | 'permit2-transfer'
  | 'generic';

export interface SummaryRow {
  label: string;
  value: string;
  /** Monospace (addresses, hex). */
  mono?: boolean;
  /** Render as a warning-coloured value (e.g. "Unlimited"). */
  emphasis?: boolean;
}

export interface TypedDataSummary {
  kind: TypedDataSummaryKind;
  /** Short heading, e.g. "Token approval (EIP-2612 permit)". */
  title: string;
  /** One or two plain sentences on what signing allows. */
  explanation: string;
  rows: SummaryRow[];
  /**
   * Every address the signature gives rights to (spenders), in full. The
   * sheet shows each with the contacts exact-match rule and checks it with
   * classifyRecipient (spenderRiskWarnings).
   */
  spenders: string[];
  /** Warning lines known without any network lookup. */
  warnings: string[];
}

/** A tracked token as tokens.ts listTokens() returns it (only the fields used). */
export interface TrackedTokenRef {
  assetId: { chainId: string; namespace: string; reference: string };
  symbol: string;
  decimals: number;
}

export interface SummarizeOptions {
  /** The address that would sign (the session's bound EOA or smart account). */
  signer: string;
  /** Current time, seconds since the epoch. */
  nowSec: number;
  /** CAIP-2 id of the ACTIVE chain (tracked-token lookups match it exactly). */
  chainCaip2: string;
  trackedTokens: readonly TrackedTokenRef[];
  /** The Hide amounts preference: finite amounts are masked; "Unlimited" never is. */
  hidden: boolean;
}

export interface TypedDataInput {
  domain: TypedDataDomain;
  types: TypedDataTypes;
  primaryType: string;
  message: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

function toBig(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(v.trim())) return BigInt(v.trim());
  throw new Error('not an integer');
}

function toAddress(v: unknown): string {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error('not an address');
  return toChecksumAddress(toBytes(v));
}

function toBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 1 || v === '1') return true;
  if (v === 'false' || v === 0 || v === '0') return false;
  throw new Error('not a bool');
}

function sameAddress(a: string | undefined, b: string): boolean {
  return typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
}

/** "0x1234…abcd" for prose; rows always carry the full address. */
export function shortAddr(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Absolute UTC time, e.g. "2026-11-01 14:05 UTC" (Intl-free, deterministic). */
export function formatUtc(seconds: bigint): string {
  const d = new Date(Number(seconds) * 1000);
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`
  );
}

function relative(seconds: bigint, nowSec: number): string {
  const delta = Number(seconds) - nowSec;
  if (delta < 0) return 'already passed';
  if (delta < 3600) return `in ${Math.max(1, Math.round(delta / 60))} min`;
  if (delta < 86_400) return `in ${Math.round(delta / 3600)} h`;
  const days = Math.round(delta / 86_400);
  return days < 730 ? `in ${days} days` : `in about ${Math.round(days / 365)} years`;
}

interface TimeView {
  text: string;
  /** True when it never ends or ends more than FAR_FUTURE_SECONDS from now. */
  farFuture: boolean;
  never: boolean;
}

function timeView(seconds: bigint, nowSec: number): TimeView {
  if (seconds > LAST_DISPLAYABLE_SECOND) {
    return { text: `never (${seconds.toString()} is beyond any real date)`, farFuture: true, never: true };
  }
  return {
    text: `${formatUtc(seconds)} (${relative(seconds, nowSec)})`,
    farFuture: Number(seconds) - nowSec > FAR_FUTURE_SECONDS,
    never: false,
  };
}

function trackedToken(token: string, opts: SummarizeOptions): TrackedTokenRef | null {
  return (
    opts.trackedTokens.find(
      (t) =>
        t.assetId.chainId === opts.chainCaip2 &&
        t.assetId.namespace === 'erc20' &&
        t.assetId.reference.toLowerCase() === token.toLowerCase(),
    ) ?? null
  );
}

/** "USDC" for a tracked token, else "token 0x1234…abcd (untracked)". */
function tokenName(token: string, opts: SummarizeOptions): string {
  const t = trackedToken(token, opts);
  return t ? t.symbol : `token ${shortAddr(token)} (untracked)`;
}

interface AmountView {
  text: string;
  unlimited: boolean;
}

/**
 * Exact amount in the token's decimals when the token is tracked on the
 * ACTIVE chain, else raw base units labelled as such. "Unlimited" exactly at
 * `unlimitedAt` (never masked); finite amounts follow Hide amounts.
 */
function amountView(raw: bigint, token: string, unlimitedAt: bigint, opts: SummarizeOptions): AmountView {
  if (raw === unlimitedAt) return { text: 'Unlimited', unlimited: true };
  const t = trackedToken(token, opts);
  if (t) {
    return {
      text: `${maskAmount(groupThousands(formatUnits(raw, t.decimals, t.decimals)), opts.hidden)} ${t.symbol}`,
      unlimited: false,
    };
  }
  return {
    text: `${maskAmount(raw.toString(), opts.hidden)} base units (raw — this token is not tracked, so its decimals are unknown)`,
    unlimited: false,
  };
}

// ---------------------------------------------------------------------------
// Schema matching
// ---------------------------------------------------------------------------

type FieldSig = readonly (readonly [type: string, name: string])[];

function structIs(types: TypedDataTypes, name: string, sig: FieldSig): boolean {
  const fields = (types as Record<string, unknown>)[name];
  if (!Array.isArray(fields) || fields.length !== sig.length) return false;
  return sig.every(([type, fieldName], i) => {
    const f = fields[i] as { type?: unknown; name?: unknown } | undefined;
    return f?.type === type && f?.name === fieldName;
  });
}

const ERC2612_PERMIT: FieldSig = [
  ['address', 'owner'],
  ['address', 'spender'],
  ['uint256', 'value'],
  ['uint256', 'nonce'],
  ['uint256', 'deadline'],
];
const DAI_PERMIT: FieldSig = [
  ['address', 'holder'],
  ['address', 'spender'],
  ['uint256', 'nonce'],
  ['uint256', 'expiry'],
  ['bool', 'allowed'],
];
const PERMIT_DETAILS: FieldSig = [
  ['address', 'token'],
  ['uint160', 'amount'],
  ['uint48', 'expiration'],
  ['uint48', 'nonce'],
];
const PERMIT_SINGLE: FieldSig = [
  ['PermitDetails', 'details'],
  ['address', 'spender'],
  ['uint256', 'sigDeadline'],
];
const PERMIT_BATCH: FieldSig = [
  ['PermitDetails[]', 'details'],
  ['address', 'spender'],
  ['uint256', 'sigDeadline'],
];
const TOKEN_PERMISSIONS: FieldSig = [
  ['address', 'token'],
  ['uint256', 'amount'],
];
const PERMIT_TRANSFER_FROM: FieldSig = [
  ['TokenPermissions', 'permitted'],
  ['address', 'spender'],
  ['uint256', 'nonce'],
  ['uint256', 'deadline'],
];
const PERMIT_BATCH_TRANSFER_FROM: FieldSig = [
  ['TokenPermissions[]', 'permitted'],
  ['address', 'spender'],
  ['uint256', 'nonce'],
  ['uint256', 'deadline'],
];

/** The Witness variants: the four transfer fields plus exactly one witness field. */
function witnessStruct(types: TypedDataTypes, name: string, base: FieldSig): { type: string; name: string } | null {
  const fields = (types as Record<string, unknown>)[name];
  if (!Array.isArray(fields) || fields.length !== base.length + 1) return null;
  if (!structIs({ [name]: fields.slice(0, base.length) } as unknown as TypedDataTypes, name, base)) return null;
  const w = fields[base.length] as { type?: unknown; name?: unknown };
  return typeof w?.type === 'string' && typeof w?.name === 'string' ? { type: w.type, name: w.name } : null;
}

function permit2DomainProblem(domain: TypedDataDomain): string | null {
  if (domain.name === 'Permit2' && sameAddress(domain.verifyingContract, PERMIT2_ADDRESS)) return null;
  const vc = domain.verifyingContract ? domain.verifyingContract : 'none';
  return (
    `This message has the shape of a Uniswap Permit2 signature, but its domain is ` +
    `"${domain.name ?? '(no name)'}" at ${vc}, not the canonical Permit2 contract ` +
    `${PERMIT2_ADDRESS}. A genuine Permit2 request always names that contract. ` +
    'Treat this as a likely phishing attempt.'
  );
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

const UNLIMITED_WARNING = (token: string, spender: string): string =>
  `UNLIMITED: this lets ${shortAddr(spender)} take ALL of your ${token} — now and in the ` +
  'future — until the approval is revoked. Only sign this for an app you fully trust.';

function signerRows(owner: string, opts: SummarizeOptions, label: string, warnings: string[]): SummaryRow {
  if (!sameAddress(owner, opts.signer)) {
    warnings.push(
      `The message names ${owner} as the ${label.toLowerCase()}, but the signing account is ` +
        `${opts.signer}. A permit for someone else's account is unusual — check what this dApp is doing.`,
    );
  }
  return { label, value: owner, mono: true };
}

function summarizeErc2612(td: TypedDataInput, opts: SummarizeOptions): TypedDataSummary {
  const m = td.message;
  const owner = toAddress(m.owner);
  const spender = toAddress(m.spender);
  const value = toBig(m.value);
  const nonce = toBig(m.nonce);
  const deadline = toBig(m.deadline);
  const warnings: string[] = [];
  const rows: SummaryRow[] = [];
  const token = td.domain.verifyingContract ? toAddress(td.domain.verifyingContract) : null;
  if (!token) {
    warnings.push(
      'This permit names no token contract (the domain has no verifyingContract), so it is ' +
        'impossible to tell which token it approves.',
    );
  }
  const tokenLabel = token ? tokenName(token, opts) : 'an unnamed token';
  rows.push({ label: 'Token', value: token ?? 'not stated', mono: true });
  rows.push(signerRows(owner, opts, 'Owner', warnings));
  rows.push({ label: 'Spender', value: spender, mono: true });
  const amount = token ? amountView(value, token, MAX_UINT256, opts) : { text: value === MAX_UINT256 ? 'Unlimited' : value.toString(), unlimited: value === MAX_UINT256 };
  rows.push({ label: 'Amount', value: amount.text, emphasis: amount.unlimited });
  const dl = timeView(deadline, opts.nowSec);
  rows.push({ label: 'Signature usable until', value: dl.text });
  rows.push({ label: 'Nonce', value: nonce.toString() });
  if (amount.unlimited) warnings.push(UNLIMITED_WARNING(tokenLabel, spender));
  if (dl.farFuture) {
    warnings.push(
      dl.never
        ? 'This permit never expires: whoever holds the signature can submit it at any time.'
        : 'This permit can be submitted for more than 30 days: whoever holds the signature can use it until the date above.',
    );
  }
  return {
    kind: 'erc2612-permit',
    title: 'Token approval (EIP-2612 permit)',
    explanation:
      `Signing lets ${shortAddr(spender)} spend ${amount.unlimited ? 'an unlimited amount' : 'up to the amount below'} ` +
      `of ${tokenLabel} from your account. No transaction is needed: anyone holding this signature ` +
      'can submit it, and the approval then stays until it is used up or revoked.',
    rows,
    spenders: [spender],
    warnings,
  };
}

function summarizeDai(td: TypedDataInput, opts: SummarizeOptions): TypedDataSummary {
  const m = td.message;
  const holder = toAddress(m.holder);
  const spender = toAddress(m.spender);
  const nonce = toBig(m.nonce);
  const expiry = toBig(m.expiry);
  const allowed = toBool(m.allowed);
  const warnings: string[] = [];
  const token = td.domain.verifyingContract ? toAddress(td.domain.verifyingContract) : null;
  const tokenLabel = token ? tokenName(token, opts) : 'an unnamed token';
  const rows: SummaryRow[] = [
    { label: 'Token', value: token ?? 'not stated', mono: true },
    signerRows(holder, opts, 'Holder', warnings),
    { label: 'Spender', value: spender, mono: true },
    allowed
      ? { label: 'Amount', value: 'Unlimited', emphasis: true }
      : { label: 'Amount', value: 'None — this REVOKES the spender’s allowance (sets it to 0)' },
  ];
  // dai.sol: require(expiry == 0 || now <= expiry) — 0 never expires.
  const ex = expiry === 0n ? { text: 'never (expiry 0)', farFuture: true, never: true } : timeView(expiry, opts.nowSec);
  rows.push({ label: 'Signature usable until', value: ex.text });
  rows.push({ label: 'Nonce', value: nonce.toString() });
  if (allowed) warnings.push(UNLIMITED_WARNING(tokenLabel, spender));
  if (allowed && ex.farFuture) {
    warnings.push(
      ex.never
        ? 'This permit never expires: whoever holds the signature can submit it at any time.'
        : 'This permit can be submitted for more than 30 days: whoever holds the signature can use it until the date above.',
    );
  }
  return {
    kind: 'dai-permit',
    title: allowed ? 'Token approval (DAI-style permit)' : 'Approval removal (DAI-style permit)',
    explanation: allowed
      ? `Signing lets ${shortAddr(spender)} spend an unlimited amount of ${tokenLabel} from your account ` +
        '(this permit format has no amount: it is all or nothing). No transaction is needed: anyone ' +
        'holding this signature can submit it.'
      : `Signing sets ${shortAddr(spender)}’s allowance for ${tokenLabel} to zero.`,
    rows,
    spenders: [spender],
    warnings,
  };
}

interface Permit2Grant {
  token: string;
  amount: bigint;
  expiration: bigint;
  nonce: bigint;
}

function readDetails(v: unknown): Permit2Grant {
  const d = v as Record<string, unknown>;
  if (typeof d !== 'object' || d === null) throw new Error('details');
  const amount = toBig(d.amount);
  const expiration = toBig(d.expiration);
  const nonce = toBig(d.nonce);
  if (amount > MAX_UINT160 || expiration > MAX_UINT48 || nonce > MAX_UINT48) throw new Error('range');
  return { token: toAddress(d.token), amount, expiration, nonce };
}

function summarizePermit2Allowance(
  td: TypedDataInput,
  batch: boolean,
  opts: SummarizeOptions,
): TypedDataSummary {
  const m = td.message;
  const spender = toAddress(m.spender);
  const sigDeadline = toBig(m.sigDeadline);
  const grants: Permit2Grant[] = batch
    ? (Array.isArray(m.details) ? m.details : (() => { throw new Error('details'); })()).map(readDetails)
    : [readDetails(m.details)];
  const warnings: string[] = [];
  const domainProblem = permit2DomainProblem(td.domain);
  if (domainProblem) warnings.push(domainProblem);
  const rows: SummaryRow[] = [{ label: 'Spender', value: spender, mono: true }];
  let anyUnlimited = false;
  let anyLongAllowance = false;
  grants.forEach((g, i) => {
    const n = grants.length > 1 ? ` ${i + 1}` : '';
    const amount = amountView(g.amount, g.token, MAX_UINT160, opts);
    rows.push({ label: `Token${n}`, value: g.token, mono: true });
    rows.push({ label: `Amount${n}`, value: amount.text, emphasis: amount.unlimited });
    // Allowance.sol: expiration 0 is stored as the current block's timestamp.
    let exText: string;
    if (g.expiration === 0n) {
      exText = 'only in the block where it is used (expiration 0)';
    } else {
      const ex = timeView(g.expiration, opts.nowSec);
      exText = ex.text;
      if (ex.farFuture) anyLongAllowance = true;
    }
    rows.push({ label: `Allowance expires${n}`, value: exText });
    rows.push({ label: `Nonce${n}`, value: g.nonce.toString() });
    if (amount.unlimited) {
      anyUnlimited = true;
      warnings.push(UNLIMITED_WARNING(tokenName(g.token, opts), spender));
    }
  });
  const sd = timeView(sigDeadline, opts.nowSec);
  rows.push({ label: 'Signature usable until', value: sd.text });
  if (anyLongAllowance) {
    warnings.push(
      'The allowance lasts more than 30 days (or never ends): the spender can keep moving these ' +
        'tokens until then unless you revoke it.',
    );
  }
  if (sd.farFuture) {
    warnings.push(
      sd.never
        ? 'The signature itself never expires: whoever holds it can submit it at any time.'
        : 'The signature can be submitted for more than 30 days.',
    );
  }
  return {
    kind: 'permit2-allowance',
    title: batch ? 'Token approvals (Permit2 PermitBatch)' : 'Token approval (Permit2 PermitSingle)',
    explanation:
      `Signing lets ${shortAddr(spender)} move ${anyUnlimited ? 'unlimited amounts of ' : ''}the tokens listed below ` +
      `out of your account through Permit2 (${shortAddr(PERMIT2_ADDRESS)}), until each allowance expires. ` +
      'No transaction is needed: anyone holding this signature can submit it.',
    rows,
    spenders: [spender],
    warnings,
  };
}

function summarizePermit2Transfer(
  td: TypedDataInput,
  batch: boolean,
  witness: { type: string; name: string } | null,
  opts: SummarizeOptions,
): TypedDataSummary {
  const m = td.message;
  const spender = toAddress(m.spender);
  const nonce = toBig(m.nonce);
  const deadline = toBig(m.deadline);
  const permittedRaw: unknown[] = batch
    ? Array.isArray(m.permitted)
      ? m.permitted
      : (() => {
          throw new Error('permitted');
        })()
    : [m.permitted];
  const permitted = permittedRaw.map((p) => {
    const o = p as Record<string, unknown>;
    if (typeof o !== 'object' || o === null) throw new Error('permitted');
    return { token: toAddress(o.token), amount: toBig(o.amount) };
  });
  const warnings: string[] = [];
  const domainProblem = permit2DomainProblem(td.domain);
  if (domainProblem) warnings.push(domainProblem);
  const rows: SummaryRow[] = [{ label: 'Spender', value: spender, mono: true }];
  permitted.forEach((p, i) => {
    const n = permitted.length > 1 ? ` ${i + 1}` : '';
    const amount = amountView(p.amount, p.token, MAX_UINT256, opts);
    rows.push({ label: `Token${n}`, value: p.token, mono: true });
    rows.push({ label: `Up to${n}`, value: amount.text, emphasis: amount.unlimited });
    if (amount.unlimited) warnings.push(UNLIMITED_WARNING(tokenName(p.token, opts), spender));
  });
  const dl = timeView(deadline, opts.nowSec);
  rows.push({ label: 'Signature usable until', value: dl.text });
  rows.push({ label: 'Nonce', value: nonce.toString() });
  if (witness) {
    rows.push({ label: 'Attached order', value: `${witness.name} (${witness.type}) — see the full message below` });
  }
  if (dl.farFuture) {
    warnings.push(
      dl.never
        ? 'This signature never expires: whoever holds it can use it at any time.'
        : 'This signature can be used for more than 30 days.',
    );
  }
  return {
    kind: 'permit2-transfer',
    title: batch ? 'One-time token transfers (Permit2)' : 'One-time token transfer (Permit2)',
    explanation:
      `Signing lets ${shortAddr(spender)} transfer, once, up to the amounts below out of your account ` +
      `through Permit2 (${shortAddr(PERMIT2_ADDRESS)}), before the deadline.` +
      (witness ? ' The transfer is tied to the attached order, which the dApp’s contract checks.' : ''),
    rows,
    spenders: [spender],
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Generic fallback
// ---------------------------------------------------------------------------

function sanitizeText(s: string): string {
  const cleaned = s.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, ' ');
  return cleaned.length > 200 ? `${cleaned.slice(0, 200)}…` : cleaned;
}

function baseValue(type: string, v: unknown): SummaryRow['value'] {
  if (type === 'address') {
    try {
      return toAddress(v);
    } catch {
      return String(v);
    }
  }
  if (/^u?int[0-9]*$/.test(type)) {
    try {
      return toBig(v).toString();
    } catch {
      return String(v);
    }
  }
  if (type === 'bool') return String(v);
  if (type === 'string') return typeof v === 'string' ? sanitizeText(v) : String(v);
  if (/^bytes[0-9]*$/.test(type)) {
    const s = typeof v === 'string' ? v : String(v);
    return s.length > 66 ? `${s.slice(0, 66)}… (${Math.max(0, (s.length - 2) >> 1)} bytes)` : s;
  }
  return typeof v === 'string' ? sanitizeText(v) : sanitizeText(JSON.stringify(v) ?? String(v));
}

function flatten(
  types: TypedDataTypes,
  type: string,
  value: unknown,
  label: string,
  depth: number,
  out: SummaryRow[],
): void {
  if (out.length >= MAX_GENERIC_ROWS) return;
  const array = /^(.*)\[[0-9]*\]$/.exec(type);
  if (array) {
    const items = Array.isArray(value) ? value : [];
    if (items.length === 0) out.push({ label, value: '(empty list)' });
    items.forEach((item, i) => flatten(types, array[1]!, item, `${label}[${i}]`, depth + 1, out));
    return;
  }
  const struct = (types as Record<string, unknown>)[type];
  if (Array.isArray(struct) && depth < 5) {
    const obj = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
    for (const f of struct as { name: string; type: string }[]) {
      flatten(types, f.type, obj[f.name], label ? `${label}.${f.name}` : f.name, depth + 1, out);
    }
    return;
  }
  out.push({ label, value: baseValue(type, value), mono: type === 'address' || type.startsWith('bytes') });
}

function summarizeGeneric(td: TypedDataInput): TypedDataSummary {
  const rows: SummaryRow[] = [
    { label: 'Message type', value: td.primaryType },
    { label: 'Domain', value: td.domain.name ?? '(no name)' },
    {
      label: 'Verifying contract',
      value: td.domain.verifyingContract ? baseValue('address', td.domain.verifyingContract) : 'none',
      mono: !!td.domain.verifyingContract,
    },
  ];
  const fields: SummaryRow[] = [];
  try {
    flatten(td.types, td.primaryType, td.message, '', 0, fields);
  } catch {
    // The raw message below is always shown.
  }
  rows.push(...fields);
  if (fields.length >= MAX_GENERIC_ROWS) {
    rows.push({ label: '…', value: 'More fields — see the full message below.' });
  }
  return {
    kind: 'generic',
    title: `Typed data: ${td.primaryType}`,
    explanation:
      'There is no specific summary for this kind of message. Read every field: typed-data ' +
      'signatures can authorize actions later (token permits, orders, logins).',
    rows,
    spenders: [],
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * The summary for one typed-data request. Never throws: a recognised
 * schema whose values cannot be read falls back to the generic list.
 */
export function summarizeTypedData(td: TypedDataInput, opts: SummarizeOptions): TypedDataSummary {
  try {
    const { types, primaryType } = td;
    if (primaryType === 'Permit' && structIs(types, 'Permit', ERC2612_PERMIT)) return summarizeErc2612(td, opts);
    if (primaryType === 'Permit' && structIs(types, 'Permit', DAI_PERMIT)) return summarizeDai(td, opts);
    if (structIs(types, 'PermitDetails', PERMIT_DETAILS)) {
      if (primaryType === 'PermitSingle' && structIs(types, 'PermitSingle', PERMIT_SINGLE)) {
        return summarizePermit2Allowance(td, false, opts);
      }
      if (primaryType === 'PermitBatch' && structIs(types, 'PermitBatch', PERMIT_BATCH)) {
        return summarizePermit2Allowance(td, true, opts);
      }
    }
    if (structIs(types, 'TokenPermissions', TOKEN_PERMISSIONS)) {
      if (primaryType === 'PermitTransferFrom' && structIs(types, primaryType, PERMIT_TRANSFER_FROM)) {
        return summarizePermit2Transfer(td, false, null, opts);
      }
      if (primaryType === 'PermitBatchTransferFrom' && structIs(types, primaryType, PERMIT_BATCH_TRANSFER_FROM)) {
        return summarizePermit2Transfer(td, true, null, opts);
      }
      if (primaryType === 'PermitWitnessTransferFrom') {
        const w = witnessStruct(types, primaryType, PERMIT_TRANSFER_FROM);
        if (w) return summarizePermit2Transfer(td, false, w, opts);
      }
      if (primaryType === 'PermitBatchWitnessTransferFrom') {
        const w = witnessStruct(types, primaryType, PERMIT_BATCH_TRANSFER_FROM);
        if (w) return summarizePermit2Transfer(td, true, w, opts);
      }
    }
  } catch {
    // Unreadable values in a known schema: fall through to the generic list.
  }
  return summarizeGeneric(td);
}

/**
 * Warnings from on-chain facts about the spenders (classifyRecipient,
 * fetched by the sheet). A failed lookup (null) raises nothing — unknown is
 * never shown as a warning.
 */
export function spenderRiskWarnings(
  spenders: readonly string[],
  classes: Readonly<Record<string, RecipientClass | null | undefined>>,
): string[] {
  const out: string[] = [];
  for (const spender of spenders) {
    const c = classes[spender.toLowerCase()];
    if (!c) continue;
    if (c.kind === 'eoa') {
      out.push(
        `The spender ${spender} is an ordinary account with no contract code. Approvals are ` +
          'normally given to contracts (routers, Permit2); a signature that lets a personal ' +
          'account move your tokens is a common way wallets are drained.',
      );
    } else if (c.kind === 'delegated-eoa') {
      out.push(
        `The spender ${spender} is an account with delegated code (EIP-7702, delegate ` +
          `${c.delegate}): whoever holds its key can move the approved tokens directly.`,
      );
    }
  }
  return out;
}
