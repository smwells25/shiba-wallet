// Explicit .ts extensions on relative imports: this module is loaded
// directly by scripts/check-payment-request.mjs under Node's type stripping.
import { formatAssetId } from '@shiba-wallet/core';
import type { FungibleAsset } from '@shiba-wallet/core';
import { normalizeEnsNameAscii } from '@shiba-wallet/chains-evm';
import { formatUnits, parseUnits } from './balances.ts';
import { SCHEME_BY_CHAIN } from './scan.ts';
import { STRIPPED_NAME_CHARS } from './names.ts';
import { EVM_PROFILES, type EvmChainProfile } from '../config/evm-chain.ts';

/**
 * Payment requests (phase 14 item 1, features 67 and 68): building the
 * payment URI that the Receive screen shows as text and as a QR code, and
 * parsing one that the Send screen scans or receives by paste.
 *
 * Formats, each verified from its specification on 2026-10-04:
 *
 * - EIP-681 (ethereum/ERCs ERCS/erc-681.md at 365b4c02, status Final):
 *     request        = schema_prefix target_address [ "@" chain_id ]
 *                      [ "/" function_name ] [ "?" parameters ]
 *     schema_prefix  = "ethereum" ":" [ "pay-" ]
 *     key            = "value" / "gas" / "gasLimit" / "gasPrice" / TYPE
 *     number         = [ "-" / "+" ] *DIGIT [ "." 1*DIGIT ]
 *                      [ ( "e" / "E" ) [ 1*DIGIT ] ]
 *   "Only integer numbers are allowed, so the exponent MUST be greater or
 *   equal to the number of decimals after the point." Native payments use
 *   `value` "in the atomic unit (i.e. wei)", with scientific notation
 *   "strongly encouraged" (example `?value=2.014e18`). ERC-20 payments
 *   call `transfer` with `address` and `uint256` parameters (example
 *   `ethereum:0x8920…/transfer?address=0x8e23…&uint256=1`). "If no
 *   chain_id is present, the client's current network setting remains
 *   effective." Gas values are "suggested user-editable values".
 *   Hexadecimal addresses "always take precedence over ENS names".
 * - BIP-321 (bitcoin/bips bip-0321.mediawiki at 927b6de9, status
 *   Complete; it replaces BIP-21): `bitcoin:[address][?params]`, amount
 *   "MUST be specified in decimal BTC", "Multiple query parameters with the
 *   same key MUST NOT be included for keys "label", "message", or "pop"",
 *   the invalid examples include two `amount` parameters, query keys are
 *   case-insensitive, and "If a client does not implement handling a query
 *   parameter which has a key prefixed with req-, it MUST consider the
 *   entire URI invalid. Any other query parameters which are not
 *   implemented, but which are not prefixed with a req-, can be safely
 *   ignored."
 * - Dogecoin: Dogecoin Core v1.14.9 src/qt/guiutil.cpp is the primary
 *   source: formatBitcoinURI builds `dogecoin:<address>` with `?amount=`
 *   (formatted in whole DOGE, 8 decimals), `label=` and `message=`
 *   (percent-encoded), and parseBitcoinURI accepts only the `dogecoin`
 *   scheme and returns false for any unhandled `req-` key. There is no
 *   Dogecoin BIP; the same BIP-321 rules are applied here.
 * - Solana Pay transfer requests (solana-foundation/pay at e22d0af4,
 *   typescript/packages/solana-pay/docs/src/SPEC.md):
 *   `solana:<recipient>?amount=&spl-token=&reference=&label=&message=&memo=`;
 *   "A single `amount` field is allowed", "a non-negative integer or
 *   decimal number of "user" units", "less than 1, it must have a leading
 *   0", "Scientific notation is prohibited", more decimals than supported
 *   → "reject the URL as malformed". `reference` values "must" be included
 *   in the transaction and `memo` "must be included in an SPL Memo
 *   instruction"; this wallet's Solana send cannot add either, so such
 *   requests are refused rather than paid without them. A pathname with
 *   ":" or "%" is a transaction request (the reference implementation's
 *   parseURL rule), which this wallet does not fetch.
 *
 * Unknown parameters are ignored only where the format says they may be
 * (BIP-321's non-`req-` keys). EIP-681 and Solana Pay say nothing about
 * unknown keys, so a key they do not define is refused (the Solana Pay
 * reference implementation ignores them; refusing is the stricter choice).
 *
 * Nothing in this module switches networks, adds tokens or decides what is
 * sent: it only turns a request into editable form values (or a refusal),
 * and the Send screen's validation, confirm, risk and biometric steps run
 * unchanged on them. Free of React Native imports.
 */

/** Longest payload accepted (the Solana Pay reference parser's limit, used for every format). */
export const MAX_PAYMENT_URI_LENGTH = 2048;
/** Longest label or note the Receive screen puts into a request. */
export const MAX_REQUEST_TEXT_LENGTH = 100;

const MAX_UINT256 = (1n << 256n) - 1n;
/** Bitcoin and Dogecoin amounts are signed 64-bit integers of base units. */
const MAX_UTXO_AMOUNT = (1n << 63n) - 1n;
/** Solana lamports are unsigned 64-bit integers. */
const MAX_LAMPORTS = (1n << 64n) - 1n;

export type PaymentFamily = 'evm' | 'bitcoin' | 'dogecoin' | 'solana';

/** The format that applies to each family (the name shown on screen). */
export const STANDARD_BY_FAMILY: Record<PaymentFamily, string> = {
  evm: 'EIP-681',
  bitcoin: 'BIP-321',
  dogecoin: 'the Dogecoin payment-URI format',
  solana: 'Solana Pay',
};

/** Native coin decimals per family (ETH 18, BTC 8, DOGE 8, SOL 9). */
export const NATIVE_DECIMALS: Record<PaymentFamily, number> = {
  evm: 18,
  bitcoin: 8,
  dogecoin: 8,
  solana: 9,
};

const FAMILY_BY_SCHEME: Record<string, PaymentFamily> = {
  ethereum: 'evm',
  bitcoin: 'bitcoin',
  dogecoin: 'dogecoin',
  solana: 'solana',
};

/** The payment family of a Send/Receive slot (route chainId), or null. */
export function familyForSlot(slotChainId: string): PaymentFamily | null {
  const scheme = SCHEME_BY_CHAIN[slotChainId];
  return scheme ? (FAMILY_BY_SCHEME[scheme] ?? null) : null;
}

/**
 * True when `text` starts with the payment-URI scheme of THIS slot
 * (case-insensitive, RFC 3986 section 3.1). Another family's scheme returns
 * false, so the caller leaves it to the normal address validation, which
 * rejects it with its usual error.
 */
export function isPaymentUriFor(slotChainId: string, text: string): boolean {
  const scheme = SCHEME_BY_CHAIN[slotChainId];
  if (!scheme) return false;
  const t = text.trim();
  return t.slice(0, scheme.length + 1).toLowerCase() === `${scheme}:`;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** What the Send screen knows when it parses a request. */
export interface PaymentRequestContext {
  /** The Send slot's chain id (route.params.chainId). */
  slotChainId: string;
  /** The ACTIVE EVM profile (only used on the EVM slot). */
  evmProfile?: Pick<EvmChainProfile, 'caip2' | 'chainIdDecimal' | 'label'>;
  /** The tracked tokens of the ACTIVE EVM network (only used on the EVM slot). */
  trackedTokens?: readonly FungibleAsset[];
}

export interface RequestedToken {
  /** CAIP-19 id from the tracked-token store (the Send route's tokenId). */
  assetId: string;
  symbol: string;
  contract: string;
  decimals: number;
}

export interface PaymentRequest {
  kind: 'request';
  family: PaymentFamily;
  /** The recipient as written in the request (an address, or on EVM possibly a name). */
  recipient: string;
  /** Requested amount in base units, or null when the request leaves it to the payer. */
  amount: bigint | null;
  /** The amount as an exact decimal for the amount field, or null. */
  amountText: string | null;
  /** The tracked token requested (EVM ERC-20 requests only). */
  token: RequestedToken | null;
  /** The EVM chain id the request names, or null when it names none. */
  chainId: bigint | null;
  /** Requester's label and note, decoded and cleaned for display (never verified). */
  label: string | null;
  message: string | null;
  /** Extra plain sentences (ignored suggestions, other payment methods offered). */
  notes: string[];
}

export type ParsedPaymentRequest =
  | { kind: 'not-a-request' }
  | { kind: 'refused'; message: string }
  | PaymentRequest;

function refuse(message: string): { kind: 'refused'; message: string } {
  return { kind: 'refused', message };
}

/** Splits a query into [key, value | null] pairs; empty segments are returned as ['', null]. */
function splitQuery(query: string): [string, string | null][] {
  return query.split('&').map((part) => {
    const eq = part.indexOf('=');
    return eq === -1 ? [part, null] : [part.slice(0, eq), part.slice(eq + 1)];
  });
}

/**
 * Percent-decodes requester text (UTF-8, RFC 3986) and cleans it for
 * display with the app-wide rule (./names.ts: control, bidirectional and
 * invisible characters removed, whitespace collapsed); long text is cut at
 * 200 characters. Returns null for empty text; throws on bad encoding.
 */
function decodeRequesterText(raw: string): string | null {
  const decoded = decodeURIComponent(raw);
  const cleaned = decoded
    .normalize('NFC')
    .replace(STRIPPED_NAME_CHARS, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (cleaned === '') return null;
  const chars = Array.from(cleaned);
  return chars.length > 200 ? `${chars.slice(0, 200).join('')}…` : cleaned;
}

/**
 * Parses an EIP-681 `number` into an exact non-negative integer. Refuses a
 * minus sign, missing digits, a bare exponent marker, hexadecimal, a
 * fractional result and anything above max uint256. Exported for tests.
 */
export function parseEip681Number(text: string): { ok: true; value: bigint } | { ok: false; error: string } {
  const m = /^([+-]?)([0-9]*)(?:\.([0-9]+))?(?:([eE])([0-9]*))?$/.exec(text);
  if (!m) return { ok: false, error: 'is not a number' };
  const [, sign, whole = '', fraction = '', e, exponentText = ''] = m;
  if (sign === '-') return { ok: false, error: 'is negative' };
  if (whole === '' && fraction === '') return { ok: false, error: 'has no digits' };
  if (e !== undefined && exponentText === '') return { ok: false, error: 'has an exponent marker without digits' };
  if (exponentText.length > 3) return { ok: false, error: 'is too large' };
  const exponent = exponentText === '' ? 0 : Number(exponentText);
  if (exponent < fraction.length) {
    return { ok: false, error: 'is not a whole number of the smallest unit (the exponent is smaller than the number of decimals)' };
  }
  let value = BigInt((whole === '' ? '0' : whole) + fraction);
  for (let i = 0; i < exponent - fraction.length; i++) {
    value *= 10n;
    if (value > MAX_UINT256) return { ok: false, error: 'is too large' };
  }
  if (value > MAX_UINT256) return { ok: false, error: 'is too large' };
  return { ok: true, value };
}

function evmNetworkName(chainId: bigint): string {
  const profile = EVM_PROFILES.find((p) => p.chainIdDecimal === chainId.toString());
  return profile
    ? `${profile.label} (chain id ${chainId.toString()})`
    : `the network with chain id ${chainId.toString()}`;
}

/** Parses an EVM address or name position; returns the normalized hex address, the name, or an error. */
function parseEvmTarget(raw: string): { ok: true; value: string; isName: boolean } | { ok: false } {
  if (/^0x/i.test(raw)) {
    if (!/^0[xX][0-9a-fA-F]{40}$/.test(raw)) return { ok: false };
    return { ok: true, value: `0x${raw.slice(2)}`, isName: false };
  }
  const name = normalizeEnsNameAscii(raw);
  if (!name.ok || name.name !== raw.toLowerCase()) return { ok: false };
  return { ok: true, value: raw, isName: true };
}

function parseEip681(body: string, ctx: PaymentRequestContext): ParsedPaymentRequest {
  const profile = ctx.evmProfile;
  if (!profile) return refuse('The active Ethereum network is not known yet. Try again in a moment.');
  let rest = body;
  if (rest.slice(0, 4).toLowerCase() === 'pay-') rest = rest.slice(4);
  const qIndex = rest.indexOf('?');
  const path = qIndex === -1 ? rest : rest.slice(0, qIndex);
  const query = qIndex === -1 ? null : rest.slice(qIndex + 1);
  const slash = path.indexOf('/');
  const beforeFunction = slash === -1 ? path : path.slice(0, slash);
  const functionName = slash === -1 ? null : path.slice(slash + 1);
  const at = beforeFunction.indexOf('@');
  const targetRaw = at === -1 ? beforeFunction : beforeFunction.slice(0, at);
  const chainRaw = at === -1 ? null : beforeFunction.slice(at + 1);

  const target = parseEvmTarget(targetRaw);
  if (!target.ok) {
    return refuse(
      `This payment request names "${targetRaw.slice(0, 64)}" as its target, which is neither ` +
        'an Ethereum address (0x followed by 40 hex characters) nor a name this wallet can look up.',
    );
  }

  let chainId: bigint | null = null;
  if (chainRaw !== null) {
    if (!/^[0-9]{1,20}$/.test(chainRaw)) return refuse('The network (chain id) in this payment request is not a number.');
    chainId = BigInt(chainRaw);
    const active = BigInt(profile.chainIdDecimal);
    if (chainId !== active) {
      const known = EVM_PROFILES.find((p) => p.chainIdDecimal === chainId!.toString());
      return refuse(
        `This payment request is for ${evmNetworkName(chainId)}, but the wallet is on ` +
          `${profile.label} (chain id ${profile.chainIdDecimal}). The wallet never switches networks ` +
          'for a request' +
          (known
            ? `: to pay on ${known.label}, switch networks under Settings → Developer, then scan or paste the request again.`
            : ', and it does not support that network.'),
      );
    }
  }

  if (functionName !== null && functionName !== 'transfer') {
    return refuse(
      `This request asks to call the contract function "${functionName.slice(0, 64)}". Only plain ` +
        'payments and token transfers are supported, so nothing was filled in.',
    );
  }

  const params = new Map<string, string>();
  if (query !== null) {
    for (const [key, value] of splitQuery(query)) {
      if (key === '' || value === null) return refuse('This payment request is malformed: every parameter must be written as key=value.');
      if (params.has(key)) return refuse(`This payment request lists the parameter "${key}" more than once, so it is ambiguous.`);
      params.set(key, value);
    }
  }

  const notes: string[] = [];
  for (const gasKey of ['gas', 'gasLimit', 'gasPrice']) {
    const v = params.get(gasKey);
    if (v === undefined) continue;
    const n = parseEip681Number(v);
    if (!n.ok) return refuse(`The "${gasKey}" value in this payment request ${n.error}.`);
    params.delete(gasKey);
    if (!notes.includes(EIP681_GAS_NOTE)) notes.push(EIP681_GAS_NOTE);
  }

  if (functionName === null) {
    // Native payment: only `value` remains defined.
    for (const key of params.keys()) {
      if (key !== 'value') {
        return refuse(
          `This payment request contains the parameter "${key.slice(0, 32)}", which the format does ` +
            'not define for a plain payment, so it was refused rather than half-read.',
        );
      }
    }
    let amount: bigint | null = null;
    const valueText = params.get('value');
    if (valueText !== undefined) {
      const n = parseEip681Number(valueText);
      if (!n.ok) return refuse(`The amount in this payment request ${n.error}.`);
      amount = n.value;
    }
    return {
      kind: 'request',
      family: 'evm',
      recipient: target.value,
      amount,
      amountText: amount === null ? null : formatUnits(amount, 18, 18),
      token: null,
      chainId,
      label: null,
      message: null,
      notes,
    };
  }

  // ERC-20 transfer: the target is the token contract.
  if (target.isName) {
    return refuse('This token request names the token contract by a name; only a contract address is accepted.');
  }
  for (const key of params.keys()) {
    if (key === 'value') {
      return refuse('This token request also asks for ETH to be sent along with the token transfer, which this wallet does not do.');
    }
    if (key !== 'address' && key !== 'uint256') {
      return refuse(
        `This token request contains the parameter "${key.slice(0, 32)}", which a token transfer ` +
          'does not use, so it was refused rather than half-read.',
      );
    }
  }
  const beneficiaryRaw = params.get('address');
  if (beneficiaryRaw === undefined) return refuse('This token request does not say who should be paid (no "address" parameter).');
  const beneficiary = parseEvmTarget(beneficiaryRaw);
  if (!beneficiary.ok) {
    return refuse('The recipient in this token request is neither an Ethereum address nor a name this wallet can look up.');
  }
  const contract = target.value.toLowerCase();
  const tracked = (ctx.trackedTokens ?? []).find(
    (t) =>
      t.assetId.chainId === profile.caip2 &&
      t.assetId.namespace === 'erc20' &&
      t.assetId.reference.toLowerCase() === contract,
  );
  if (!tracked) {
    return refuse(
      `The token contract ${target.value} in this payment request is not tracked on this network ` +
        `(${profile.label}). Add it under Manage tokens first if you trust it; the wallet never adds ` +
        'tokens from a payment request.',
    );
  }
  let amount: bigint | null = null;
  const amountRaw = params.get('uint256');
  if (amountRaw !== undefined) {
    const n = parseEip681Number(amountRaw);
    if (!n.ok) return refuse(`The token amount in this payment request ${n.error}.`);
    amount = n.value;
  }
  return {
    kind: 'request',
    family: 'evm',
    recipient: beneficiary.value,
    amount,
    amountText: amount === null ? null : formatUnits(amount, tracked.decimals, tracked.decimals),
    token: {
      assetId: formatAssetId(tracked.assetId),
      symbol: tracked.symbol,
      contract: tracked.assetId.reference,
      decimals: tracked.decimals,
    },
    chainId,
    label: null,
    message: null,
    notes,
  };
}

/** Ignored gas suggestions (EIP-681 calls them "suggested user-editable values"). */
export const EIP681_GAS_NOTE =
  'The request suggested gas settings. The wallet ignores them and uses its own fee quote, shown on the next screen.';

/** BIP-321 keys that are payment instructions this wallet cannot use (ignored, not refused). */
export const OTHER_PAYMENT_METHODS_NOTE =
  'The request also offers other payment methods (for example Lightning). This wallet pays the on-chain address only.';

/** Decimal amount rule shared by BIP-321 / Dogecoin (`*digit [ "." *digit ]`). */
function parseDecimalAmount(
  text: string,
  decimals: number,
  max: bigint,
  strictLeadingZero: boolean,
): { ok: true; value: bigint | null } | { ok: false; error: string } {
  if (text === '') return { ok: true, value: null };
  const pattern = strictLeadingZero ? /^[0-9]+(\.[0-9]+)?$/ : /^[0-9]*(\.[0-9]*)?$/;
  if (!pattern.test(text) || text === '.') {
    return { ok: false, error: 'is not a plain decimal number (digits and one "." only)' };
  }
  const dot = text.indexOf('.');
  if (dot !== -1 && text.length - dot - 1 > decimals) {
    return { ok: false, error: `has more than ${decimals} decimal places` };
  }
  const value = parseUnits(text, decimals);
  if (value > max) return { ok: false, error: 'is too large' };
  return { ok: true, value };
}

function parseBip321(body: string, family: 'bitcoin' | 'dogecoin'): ParsedPaymentRequest {
  const qIndex = body.indexOf('?');
  const address = qIndex === -1 ? body : body.slice(0, qIndex);
  const query = qIndex === -1 ? null : body.slice(qIndex + 1);
  const coin = family === 'bitcoin' ? 'BTC' : 'DOGE';
  const seen = new Set<string>();
  let amount: bigint | null = null;
  let label: string | null = null;
  let message: string | null = null;
  const notes: string[] = [];
  if (query !== null) {
    for (const [rawKey, rawValue] of splitQuery(query)) {
      if (rawKey === '' && rawValue === null) continue; // an empty parameter is allowed by the grammar
      const key = rawKey.toLowerCase(); // BIP-321: query keys are case-insensitive
      if (key.startsWith('req-')) {
        return refuse(
          `This payment request requires a feature this wallet does not support ("${rawKey.slice(0, 32)}"), ` +
            'so the whole request is refused, as the payment-URI standard requires.',
        );
      }
      if (key === 'amount' || key === 'label' || key === 'message' || key === 'pop') {
        if (seen.has(key)) return refuse(`This payment request lists "${key}" more than once, so it is invalid.`);
        seen.add(key);
      }
      const value = rawValue ?? '';
      try {
        if (key === 'amount') {
          const n = parseDecimalAmount(value, 8, MAX_UTXO_AMOUNT, false);
          if (!n.ok) return refuse(`The amount in this payment request ${n.error}.`);
          amount = n.value;
        } else if (key === 'label') {
          label = decodeRequesterText(value);
        } else if (key === 'message') {
          message = decodeRequesterText(value);
        } else if (key !== 'pop') {
          // lightning, lno, pay, sp, bc, tb and any future key: allowed to be ignored.
          if (!notes.includes(OTHER_PAYMENT_METHODS_NOTE)) notes.push(OTHER_PAYMENT_METHODS_NOTE);
        }
      } catch {
        return refuse('The text in this payment request is not correctly encoded.');
      }
    }
  }
  if (address === '') {
    return refuse(
      `This request has no on-chain ${coin} address (it only carries other payment instructions, ` +
        'such as Lightning), which this wallet cannot pay.',
    );
  }
  return {
    kind: 'request',
    family,
    recipient: address,
    amount,
    amountText: amount === null ? null : formatUnits(amount, 8, 8),
    token: null,
    chainId: null,
    label,
    message,
    notes,
  };
}

function parseSolanaPay(body: string): ParsedPaymentRequest {
  const qIndex = body.indexOf('?');
  const recipient = qIndex === -1 ? body : body.slice(0, qIndex);
  const query = qIndex === -1 ? null : body.slice(qIndex + 1);
  if (/[:%]/.test(recipient)) {
    return refuse(
      'This is a Solana Pay transaction request: it asks the wallet to fetch a transaction from ' +
        'a website. This wallet only pays plain transfer requests.',
    );
  }
  const seen = new Set<string>();
  let amount: bigint | null = null;
  let label: string | null = null;
  let message: string | null = null;
  if (query !== null) {
    for (const [key, value] of splitQuery(query)) {
      if (key === '' || value === null) return refuse('This payment request is malformed: every parameter must be written as key=value.');
      if (seen.has(key)) return refuse(`This payment request lists "${key.slice(0, 32)}" more than once; Solana Pay allows it once.`);
      seen.add(key);
      try {
        switch (key) {
          case 'amount': {
            const n = parseDecimalAmount(value, 9, MAX_LAMPORTS, true);
            if (!n.ok || n.value === null) {
              return refuse(`The amount in this payment request ${n.ok ? 'is empty' : n.error}.`);
            }
            amount = n.value;
            break;
          }
          case 'label':
            label = decodeRequesterText(value);
            break;
          case 'message':
            message = decodeRequesterText(value);
            break;
          case 'spl-token':
            return refuse('This request asks for an SPL token. Token payment requests on Solana are not supported yet; this wallet sends only SOL there.');
          case 'reference':
            return refuse(
              'This request asks the wallet to attach reference keys to the payment so the requester ' +
                'can find it. This wallet cannot add them yet, and paying without them could leave the ' +
                'payment unnoticed, so the request is refused.',
            );
          case 'memo':
            return refuse(
              'This request asks for an on-chain memo (an SPL Memo instruction) in the payment. This ' +
                'wallet cannot add one yet, so the request is refused rather than paid without it.',
            );
          default:
            return refuse(
              `This payment request contains the parameter "${key.slice(0, 32)}", which Solana Pay does ` +
                'not define, so it was refused rather than half-read.',
            );
        }
      } catch {
        return refuse('The text in this payment request is not correctly encoded.');
      }
    }
  }
  return {
    kind: 'request',
    family: 'solana',
    recipient,
    amount,
    amountText: amount === null ? null : formatUnits(amount, 9, 9),
    token: null,
    chainId: null,
    label,
    message,
    notes: [],
  };
}

/**
 * Parses a scanned or pasted payload on the Send screen's slot. Returns
 * 'not-a-request' when the payload does not start with THIS slot's scheme
 * (the caller then keeps the old behaviour: extractScannedAddress and the
 * normal validation), 'refused' with a plain sentence, or the request.
 * The recipient in a request is NOT validated here: the Send screen puts it
 * in the recipient field, where the usual validation runs.
 */
export function parsePaymentRequest(payload: string, ctx: PaymentRequestContext): ParsedPaymentRequest {
  if (!isPaymentUriFor(ctx.slotChainId, payload)) return { kind: 'not-a-request' };
  const family = familyForSlot(ctx.slotChainId);
  if (!family) return { kind: 'not-a-request' };
  const trimmed = payload.trim();
  if (trimmed.length > MAX_PAYMENT_URI_LENGTH) return refuse('This payment request is too long to be a normal payment request.');
  if (/[\s#]/.test(trimmed)) return refuse('This payment request contains spaces or a "#" fragment, which the format does not allow.');
  const body = trimmed.slice(trimmed.indexOf(':') + 1);
  switch (family) {
    case 'evm':
      return parseEip681(body, ctx);
    case 'bitcoin':
    case 'dogecoin':
      return parseBip321(body, family);
    case 'solana':
      return parseSolanaPay(body);
  }
}

/** Plain lines describing a parsed request on the Send form. */
export function describeParsedRequest(
  req: PaymentRequest,
  opts: { nativeSymbol: string; networkLabel: string },
): string[] {
  const symbol = req.token ? req.token.symbol : opts.nativeSymbol;
  const lines: string[] = [
    `Filled in from a payment request (${STANDARD_BY_FAMILY[req.family]}). Check every field before you tap Review; you can change any of them.`,
    req.amountText !== null
      ? `Asks for: ${req.amountText} ${symbol}${req.token ? ` (token contract ${req.token.contract})` : ''}.`
      : `Asks for: ${symbol}${req.token ? ` (token contract ${req.token.contract})` : ''}, amount not set — enter one.`,
    `Requested recipient: ${req.recipient}`,
  ];
  if (req.family === 'evm') {
    lines.push(
      req.chainId !== null
        ? `Network: ${opts.networkLabel} (chain id ${req.chainId.toString()}), the network the wallet is on.`
        : `The request does not name a network. It will be paid on ${opts.networkLabel}, the network the wallet is on; make sure that is the one the requester expects.`,
    );
  }
  if (req.label) lines.push(`Label from the requester (not verified): ${req.label}`);
  if (req.message) lines.push(`Message from the requester (not verified): ${req.message}`);
  return [...lines, ...req.notes];
}

// ---------------------------------------------------------------------------
// Building (the Receive screen)
// ---------------------------------------------------------------------------

export type BuildRequestInput =
  | {
      family: 'evm';
      address: string;
      /** The ACTIVE profile's chain id; always written into the URI. */
      chainIdDecimal: string;
      amount: bigint;
      /** Present for an ERC-20 request (a tracked token on the active network). */
      token?: { contract: string; decimals: number };
    }
  | {
      family: 'bitcoin' | 'dogecoin' | 'solana';
      address: string;
      amount: bigint;
      label?: string;
      message?: string;
    };

/**
 * Formats an amount of base units as EIP-681's scientific notation with the
 * asset's decimals as exponent (2014000000000000000 wei with 18 decimals →
 * "2.014e18", the specification's own example); zero decimals give a plain
 * integer. The result always satisfies "the exponent MUST be greater or
 * equal to the number of decimals after the point".
 */
export function formatEip681Amount(amount: bigint, decimals: number): string {
  if (amount < 0n) throw new Error('negative amount');
  if (decimals === 0) return amount.toString();
  return `${formatUnits(amount, decimals, decimals)}e${decimals}`;
}

/** Cleans optional requester text for a URI; returns null when empty, or an error. */
export function cleanRequestText(raw: string | undefined, what: 'label' | 'note'): { ok: true; text: string | null } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, text: null };
  // A non-global copy of the app-wide character class, so .test() keeps no state.
  if (new RegExp(STRIPPED_NAME_CHARS.source).test(raw)) {
    return { ok: false, error: `The ${what} contains hidden or control characters. Type it again without them.` };
  }
  const text = raw.replace(/\s+/gu, ' ').trim();
  if (text === '') return { ok: true, text: null };
  if (Array.from(text).length > MAX_REQUEST_TEXT_LENGTH) {
    return { ok: false, error: `The ${what} can be at most ${MAX_REQUEST_TEXT_LENGTH} characters.` };
  }
  return { ok: true, text };
}

/**
 * Builds the payment URI for the Receive screen. The amount must be
 * positive. EVM requests always carry the active chain id; label and note
 * exist only in the BIP-321 / Dogecoin / Solana Pay formats (EIP-681
 * defines none). Throws with a plain sentence on bad input.
 */
export function buildPaymentRequestUri(input: BuildRequestInput): string {
  if (input.amount <= 0n) throw new Error('Enter an amount greater than zero.');
  if (input.family === 'evm') {
    if (!/^0x[0-9a-fA-F]{40}$/.test(input.address)) throw new Error('The receiving address is not an Ethereum address.');
    if (!/^[1-9][0-9]*$/.test(input.chainIdDecimal)) throw new Error('The network chain id is not valid.');
    if (input.token) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(input.token.contract)) throw new Error('The token contract is not an address.');
      if (input.amount > MAX_UINT256) throw new Error('The amount is too large.');
      return (
        `ethereum:${input.token.contract}@${input.chainIdDecimal}/transfer` +
        `?address=${input.address}&uint256=${formatEip681Amount(input.amount, input.token.decimals)}`
      );
    }
    if (input.amount > MAX_UINT256) throw new Error('The amount is too large.');
    return `ethereum:${input.address}@${input.chainIdDecimal}?value=${formatEip681Amount(input.amount, 18)}`;
  }
  const max = input.family === 'solana' ? MAX_LAMPORTS : MAX_UTXO_AMOUNT;
  if (input.amount > max) throw new Error('The amount is too large.');
  const decimals = NATIVE_DECIMALS[input.family];
  const params = [`amount=${formatUnits(input.amount, decimals, decimals)}`];
  const label = cleanRequestText(input.label, 'label');
  if (!label.ok) throw new Error(label.error);
  const message = cleanRequestText(input.message, 'note');
  if (!message.ok) throw new Error(message.error);
  if (label.text) params.push(`label=${encodeURIComponent(label.text)}`);
  if (message.text) params.push(`message=${encodeURIComponent(message.text)}`);
  return `${input.family}:${input.address}?${params.join('&')}`;
}

/**
 * The plain sentence the Receive screen shows under a request, saying
 * exactly what it encodes.
 */
export function describeBuiltRequest(
  input: BuildRequestInput,
  opts: { symbol: string; networkLabel: string },
): string {
  const decimals = input.family === 'evm' && input.token ? input.token.decimals : NATIVE_DECIMALS[input.family];
  const amount = formatUnits(input.amount, decimals, decimals);
  let s = `This request asks the payer to send exactly ${amount} ${opts.symbol}`;
  if (input.family === 'evm') {
    s += input.token ? ` (token contract ${input.token.contract})` : '';
    s += ` on ${opts.networkLabel} (chain id ${input.chainIdDecimal}) to your address ${input.address}.`;
  } else {
    s += ` on ${opts.networkLabel} to your address ${input.address}.`;
    const label = cleanRequestText(input.label, 'label');
    const message = cleanRequestText(input.message, 'note');
    if (label.ok && label.text) s += ` Label: "${label.text}".`;
    if (message.ok && message.text) s += ` Note: "${message.text}".`;
    if ((label.ok && label.text) || (message.ok && message.text)) {
      s += ' The label and note are readable by anyone who sees the code.';
    }
  }
  return `${s} The payer’s wallet shows these values for review; check what actually arrives.`;
}

/**
 * What the Send screen carries across a navigation.replace when a request
 * switches it between the native coin and a token: the values to put in
 * the (editable) fields and the lines of the "Payment request" box.
 */
export interface SendRequestPrefill {
  recipient: string;
  amountText: string | null;
  lines: string[];
}
