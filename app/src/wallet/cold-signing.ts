// Cold signing, the QR half (feature 11, phase 22 item 3).
//
// A WATCH-ONLY account is the on-line half of an air-gapped signer: the
// wallet prepares a send for the watched address exactly as the Send screen
// does (validation, quote, preview, risk card, spending limits), then shows
// the UNSIGNED transaction as QR codes instead of signing it. An off-line
// signer that holds the watched address's key signs it and shows its
// signature as a QR code; the wallet scans it, checks it against the request
// it STORED (never against anything in the scanned text), attaches it and
// broadcasts through send.ts sendEvmWithSignature, the same broadcast and
// listeners as sendEvm (pending registry, spending recorder, Home refresh).
//
// THE FORMAT IS THIS WALLET'S OWN, NOT EIP-4527. EIP-4527 ("QR Code
// transmission protocol for wallets", ethereum/ERCs ERCS/erc-4527.md at
// 20942ae7, last changed 2024-05-22, read 2026-10-19, status Stagnant) carries
// requests as Blockchain Commons Uniform Resources ("eth-sign-request",
// "eth-signature") in CBOR with multi-part fountain codes. It was not
// implemented because, from the specification texts themselves:
//  1. eth-sign-request REQUIRES `derivation-path: #5.304(crypto-keypath)`
//     ("the key path for signing this request"), whose components and
//     source fingerprint come from the signer's own key sync (crypto-hdkey,
//     the EIP's set-up step 1). A watch-only account here is an address the
//     user typed; it has no derivation path or master fingerprint to put
//     there, and guessing one would make a Keystone-style signer look for
//     the wrong key.
//  2. The EIP's CDDL writes the data-type and derivation-path tags as
//     "#3.401(sign-data-type)" and "#5.304(crypto-keypath)", which are not
//     valid CDDL tag notation (#6.<tag>); the tag numbers cannot be read
//     from the text with certainty.
//  3. The EIP has no test vectors of its own ("The test cases can be found
//     on the `ur-registry-eth` package released by the Keystone team"), and
//     BCR-2020-005 (BlockchainCommons/Research papers/bcr-2020-005-ur.md at
//     66578898, read 2026-10-19) defines UR compliance as "Compliant UR
//     codec implementations MUST pass the unit tests from the reference
//     implementations", with the multi-part fountain code specified in a
//     separate guide (bcr-2024-001) — so a dependency-free implementation
//     could only be checked against third-party repositories' test files,
//     not against the specifications.
// The multi-part QR scheme below is the multisig screens' ("SW-MS:",
// phase 19 item 1) with its own prefix "SW-CS:", through the shared codec
// in ./qr-parts.ts.
//
// Free of React Native (Node's type stripping runs it in
// scripts/check-cold-signing.mjs; hence the explicit .ts extensions). It
// reads no key, no secret and no storage: there is nothing to sign here.

import {
  eip1559SigningHash,
  encodeErc20Transfer,
  recoverEip1559Signer,
  serializeSignedEip1559,
  toBytes,
  toHex,
  type Eip1559Signature,
  type Eip1559Transaction,
  type SignedEip1559,
} from '@shiba-wallet/chains-evm';
import { toChecksumAddress } from '@shiba-wallet/core';
import { formatUnits } from './balances.ts';
import { createQrPartCodec, type QrPartScan, type QrPartScanResult } from './qr-parts.ts';
// Pure data with no imports (see its file comment).
import { evmProfileByCaip2 } from '../config/evm-chain.ts';
import type { EvmSendQuote } from './send.ts';
import type { Erc20SendQuote } from './send-erc20.ts';

// ---------------------------------------------------------------------------
// Payload identifiers
// ---------------------------------------------------------------------------

/** The `type` of a request payload (the watch-only half → the off-line signer). */
export const COLD_SIGN_REQUEST_TYPE = 'shiba-wallet/cold-sign-request';
/** The `type` of a signature payload (the off-line signer → the watch-only half). */
export const COLD_SIGN_SIGNATURE_TYPE = 'shiba-wallet/cold-sign-signature';
export const COLD_SIGN_VERSION = 1;

/** EIP-2718 type byte of an EIP-1559 transaction, the only type a request may carry. */
export const COLD_SIGN_TX_TYPE = '0x2';

// ---------------------------------------------------------------------------
// QR codes in parts
// ---------------------------------------------------------------------------

/** The prefix of one part of a multi-part cold-signing code: "SW-CS:<n>/<total>:<chunk>". */
export const COLD_SIGN_QR_PART_PREFIX = 'SW-CS:';
/**
 * Largest single code, in UTF-8 bytes: the same judgement as the multisig
 * screens (wallet/multisig.ts MULTISIG_QR_PART_MAX_BYTES = 858, the
 * byte-mode capacity of a version-20 QR code at error-correction level L
 * from the `qrcode` 1.5.4 encoder's capacity table), for reliable
 * phone-to-phone scanning.
 */
export const COLD_SIGN_QR_PART_MAX_BYTES = 858;
export const COLD_SIGN_QR_MAX_PARTS = 20;

export const COLD_SIGN_QR_DAMAGED =
  'This QR code looks like part of a Shiba Wallet cold-signing code, but it is damaged. Scan it again.';

const codec = createQrPartCodec({
  prefix: COLD_SIGN_QR_PART_PREFIX,
  maxBytes: COLD_SIGN_QR_PART_MAX_BYTES,
  maxParts: COLD_SIGN_QR_MAX_PARTS,
  damagedSentence: COLD_SIGN_QR_DAMAGED,
});

/** The QR codes for a payload (one plain code when it fits, else "SW-CS:" parts); null when too large. */
export function splitColdSignQrParts(payload: string): string[] | null {
  return codec.split(payload);
}

export type ColdSignQrScan = QrPartScan;
export type ColdSignQrScanResult = QrPartScanResult;

/** Takes one scanned text (a whole payload or one part); see qr-parts.ts createQrPartCodec. */
export function acceptColdSignQrScan(scan: ColdSignQrScan | null, data: string): ColdSignQrScanResult {
  return codec.accept(scan, data);
}

/** The scanner's progress line between parts. */
export function coldSignQrProgressLine(received: number, total: number, repeated = false): string {
  const missing = total - received;
  return (
    `${repeated ? 'That part was already read. ' : ''}${received} of ${total} parts read. ` +
    `Show the next part on the signer and scan it; ${missing} ${missing === 1 ? 'part is' : 'parts are'} still missing.`
  );
}

/** The caption under one code of a multi-part QR. */
export function coldSignQrPartCaption(caption: string, index: number, total: number): string {
  return total > 1 ? `${caption} — part ${index + 1} of ${total}` : caption;
}

/** The sentence above a multi-part QR code. */
export function coldSignQrPagedNote(total: number): string {
  return (
    `This is too much for one reliable QR code, so it is shown as ${total} codes. The off-line signer scans ` +
    'them one at a time; tap Next part after each one is read. The order does not matter.'
  );
}

export const COLD_SIGN_QR_TOO_LARGE = 'Too large for QR codes — use Share or Copy instead.';

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

/** The unsigned EIP-1559 transaction as the request carries it: integers in decimal, bytes in lowercase hex. */
export interface ColdSignTxFields {
  type: typeof COLD_SIGN_TX_TYPE;
  nonce: string;
  maxPriorityFeePerGas: string;
  maxFeePerGas: string;
  gasLimit: string;
  /** EIP-55. */
  to: string;
  value: string;
  /** "0x" for none. */
  data: string;
  /** Always empty: the wallet never builds an access list. */
  accessList: [];
}

export interface ColdSignRequest {
  type: typeof COLD_SIGN_REQUEST_TYPE;
  version: typeof COLD_SIGN_VERSION;
  /** 16 random bytes, "0x" + 32 lowercase hex: ties a signature to this request. */
  requestId: string;
  /** The EIP-155 chain id, decimal. */
  chainId: string;
  /** The watched address (the sender), EIP-55. */
  from: string;
  tx: ColdSignTxFields;
  /** A plain sentence for the signer's screen. The signer must decode the fields itself, never trust this. */
  summary: string;
  /** keccak256(0x02 || rlp(the nine EIP-1559 payload fields)): what the signer signs, for a cross-check. */
  signingHash: string;
}

export interface ColdSignSignaturePayload {
  type: typeof COLD_SIGN_SIGNATURE_TYPE;
  version: typeof COLD_SIGN_VERSION;
  requestId: string;
  /** The address the signer signed with, EIP-55. */
  signer: string;
  signingHash: string;
  yParity: 0 | 1;
  r: string;
  s: string;
}

/** Thrown for every refusal in this module; the message is the sentence the screen shows. */
export class ColdSignRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ColdSignRefusedError';
  }
}

const DECIMAL = /^(0|[1-9][0-9]{0,77})$/;
const HEX_DATA = /^0x([0-9a-f]{2})*$/;
const HASH32 = /^0x[0-9a-f]{64}$/;
const REQUEST_ID = /^0x[0-9a-f]{32}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function checksummed(address: string): string | null {
  if (!ADDRESS.test(address)) return null;
  try {
    return toChecksumAddress(toBytes(address));
  } catch {
    return null;
  }
}

/** The transaction a quote describes, built exactly as send.ts sendEvm / send-erc20.ts sendErc20 build it. */
export function coldSignTxFromQuote(quote: EvmSendQuote | Erc20SendQuote): Eip1559Transaction {
  if (quote.kind === 'erc20') {
    // send-erc20.ts sendErc20: to = the token contract, value 0, data = transfer calldata.
    return {
      chainId: quote.chainId,
      nonce: quote.nonce,
      maxPriorityFeePerGas: quote.maxPriorityFeePerGas,
      maxFeePerGas: quote.maxFeePerGas,
      gasLimit: quote.gasLimit,
      to: quote.contract,
      value: 0n,
      data: quote.data,
    };
  }
  return {
    chainId: quote.chainId,
    nonce: quote.nonce,
    maxPriorityFeePerGas: quote.maxPriorityFeePerGas,
    maxFeePerGas: quote.maxFeePerGas,
    gasLimit: quote.gasLimit,
    to: quote.to,
    value: quote.amount,
    ...(quote.data && quote.data.length > 0 ? { data: quote.data } : {}),
  };
}

/**
 * The EvmSendQuote send.ts broadcasts for a quote: the quote itself for a
 * native (or replacement) quote; for a token quote the same conversion as
 * send-erc20.ts sendErc20 (so the pending registry and the spending recorder
 * see exactly what they see for a regular token send).
 */
export function coldSignBroadcastQuote<Q extends EvmSendQuote>(quote: Q | Erc20SendQuote): Q | EvmSendQuote {
  if (quote.kind !== 'erc20') return quote;
  return {
    kind: 'evm',
    to: quote.contract,
    amount: 0n,
    balance: quote.ethBalance,
    nonce: quote.nonce,
    chainId: quote.chainId,
    gasLimit: quote.gasLimit,
    maxFeePerGas: quote.maxFeePerGas,
    maxPriorityFeePerGas: quote.maxPriorityFeePerGas,
    fee: quote.fee,
    total: quote.fee,
    simulation: quote.simulation,
    data: quote.data,
  };
}

/** The transaction a stored request describes (rebuilt from its fields, which were validated). */
export function coldSignTxFromRequest(request: ColdSignRequest): Eip1559Transaction {
  const data = request.tx.data === '0x' ? undefined : toBytes(request.tx.data);
  return {
    chainId: BigInt(request.chainId),
    nonce: BigInt(request.tx.nonce),
    maxPriorityFeePerGas: BigInt(request.tx.maxPriorityFeePerGas),
    maxFeePerGas: BigInt(request.tx.maxFeePerGas),
    gasLimit: BigInt(request.tx.gasLimit),
    to: request.tx.to,
    value: BigInt(request.tx.value),
    ...(data ? { data } : {}),
  };
}

/** What a request's call does, decoded from its fields (never from its summary). */
export type ColdSignCall =
  | { kind: 'native'; to: string; value: bigint }
  | { kind: 'erc20-transfer'; token: string; recipient: string; amount: bigint }
  | { kind: 'contract-call'; to: string; value: bigint; data: string };

const ERC20_TRANSFER_SELECTOR = toHex(encodeErc20Transfer('0x0000000000000000000000000000000000000000', 0n).slice(0, 4));

/**
 * Decodes the call: a plain transfer of the native coin (no data), an
 * ERC-20 transfer(address,uint256) with value 0 whose calldata is EXACTLY
 * what the engine's encodeErc20Transfer produces for the decoded arguments
 * (so dirty padding is not called a transfer), or any other contract call.
 */
export function decodeColdSignCall(tx: Eip1559Transaction): ColdSignCall {
  const to = tx.to ?? '';
  if (!tx.data || tx.data.length === 0) return { kind: 'native', to, value: tx.value };
  const dataHex = toHex(tx.data);
  if (tx.value === 0n && tx.data.length === 68 && dataHex.slice(0, 10) === ERC20_TRANSFER_SELECTOR) {
    const recipient = toChecksumAddress(tx.data.slice(16, 36));
    const amount = BigInt(toHex(tx.data.slice(36, 68)));
    if (toHex(encodeErc20Transfer(recipient, amount)) === dataHex) {
      return { kind: 'erc20-transfer', token: to, recipient, amount };
    }
  }
  return { kind: 'contract-call', to, value: tx.value, data: dataHex };
}

/** A network's name for the summary: the profile's label, else "chain id N". */
function networkName(chainId: bigint): string {
  return evmProfileByCaip2(`eip155:${chainId}`)?.label ?? `chain id ${chainId}`;
}

/**
 * The plain sentence a request carries for the signer's screen. Every
 * address in full (the signer compares them character by character); every
 * amount exact.
 */
export function coldSignSummary(args: {
  tx: Eip1559Transaction;
  from: string;
  /** The native coin as the profile shows it ("test ETH" on test networks). */
  nativeSymbol: string;
  /** The token, for a token send. */
  token?: { symbol: string; decimals: number };
  /** The worst-case fee in wei, as the confirm shows it (incl. an OP-stack L1 fee). */
  fee: bigint;
  /** For a replacement: what it replaces. */
  replacement?: { action: 'speed-up' | 'cancel'; replaces: string };
}): string {
  const { tx, from, nativeSymbol, token, fee, replacement } = args;
  const call = decodeColdSignCall(tx);
  const where = `on ${networkName(tx.chainId)} (chain id ${tx.chainId})`;
  let what: string;
  if (call.kind === 'native') {
    what = replacement?.action === 'cancel' && call.value === 0n && call.to.toLowerCase() === from.toLowerCase()
      ? `Cancel: send 0 ${nativeSymbol} from ${from} to itself`
      : `Send ${formatUnits(call.value, 18, 18)} ${nativeSymbol} from ${from} to ${call.to}`;
  } else if (call.kind === 'erc20-transfer') {
    const amount = token ? `${formatUnits(call.amount, token.decimals, token.decimals)} ${token.symbol}` : `${call.amount} base units of the token`;
    what = `Send ${amount} (token contract ${call.token}) from ${from} to ${call.recipient}`;
  } else {
    what = `Call contract ${call.to} from ${from} with ${formatUnits(call.value, 18, 18)} ${nativeSymbol} and ${(call.data.length - 2) / 2} bytes of data`;
  }
  const prefix = replacement
    ? `${replacement.action === 'speed-up' ? 'Speed-up' : 'Cancellation'} of transaction ${replacement.replaces} (same nonce). `
    : '';
  return `${prefix}${what} ${where}, nonce ${tx.nonce}; network fee at most ${formatUnits(fee, 18, 18)} ${nativeSymbol}.`;
}

/** 16 random bytes as a request id. */
export function newColdSignRequestId(random: (n: number) => Uint8Array): string {
  const bytes = random(16);
  if (!(bytes instanceof Uint8Array) || bytes.length !== 16) throw new Error('The random source returned the wrong number of bytes.');
  return toHex(bytes);
}

/**
 * Builds the request for a quote of the watched address. Refuses a
 * contract creation (no recipient) and anything that is not a plain EIP-1559
 * transaction; the quote types the Send flow builds cannot carry an
 * authorization list, so a type-0x04 request cannot arise here (D6).
 */
export function buildColdSignRequest(args: {
  tx: Eip1559Transaction;
  from: string;
  summary: string;
  requestId: string;
}): ColdSignRequest {
  const { tx, summary, requestId } = args;
  const from = checksummed(args.from);
  if (!from) throw new ColdSignRefusedError('The sending address is not a valid Ethereum address. Nothing was prepared.');
  const to = tx.to ? checksummed(tx.to) : null;
  if (!to) throw new ColdSignRefusedError('A cold-signing request needs a recipient; contract creation is not offered. Nothing was prepared.');
  if ((tx.accessList ?? []).length > 0) {
    throw new ColdSignRefusedError('A cold-signing request never carries an access list. Nothing was prepared.');
  }
  if ('authorizationList' in (tx as object)) throw new ColdSignRefusedError(COLD_SIGN_TYPE_REFUSAL);
  if (!REQUEST_ID.test(requestId)) throw new Error('Malformed request id.');
  const request: ColdSignRequest = {
    type: COLD_SIGN_REQUEST_TYPE,
    version: COLD_SIGN_VERSION,
    requestId,
    chainId: tx.chainId.toString(),
    from,
    tx: {
      type: COLD_SIGN_TX_TYPE,
      nonce: tx.nonce.toString(),
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas.toString(),
      maxFeePerGas: tx.maxFeePerGas.toString(),
      gasLimit: tx.gasLimit.toString(),
      to,
      value: tx.value.toString(),
      data: tx.data && tx.data.length > 0 ? toHex(tx.data) : '0x',
      accessList: [],
    },
    summary,
    signingHash: '',
  };
  request.signingHash = toHex(eip1559SigningHash(coldSignTxFromRequest(request)));
  // The fields must survive the strict parser the signer uses.
  return parseColdSignRequest(serializeColdSignRequest(request));
}

/** The request as text, keys in a fixed order (what the QR codes and Copy carry). */
export function serializeColdSignRequest(request: ColdSignRequest): string {
  return JSON.stringify({
    type: request.type,
    version: request.version,
    requestId: request.requestId,
    chainId: request.chainId,
    from: request.from,
    tx: {
      type: request.tx.type,
      nonce: request.tx.nonce,
      maxPriorityFeePerGas: request.tx.maxPriorityFeePerGas,
      maxFeePerGas: request.tx.maxFeePerGas,
      gasLimit: request.tx.gasLimit,
      to: request.tx.to,
      value: request.tx.value,
      data: request.tx.data,
      accessList: [],
    },
    summary: request.summary,
    signingHash: request.signingHash,
  });
}

export const COLD_SIGN_TYPE_REFUSAL =
  'This request is not an ordinary EIP-1559 transaction (type 0x2). The wallet never asks an off-line signer to sign ' +
  'an EIP-7702 authorization or any other transaction type, so it was refused.';

export const COLD_SIGN_NOT_A_REQUEST =
  'This is not a Shiba Wallet cold-signing request. Scan or paste the request the watch-only wallet shows.';

function objectWithKeys(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((k, i) => k !== expected[i])) return null;
  return value as Record<string, unknown>;
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function refusePastedPart(text: string): void {
  const part = codec.partOf(text);
  if (part) {
    throw new ColdSignRefusedError(
      `This is part ${part.n} of ${part.total} of a multi-part QR code, not the whole text. Read every part with the ` +
        'scan button, or paste the whole text.',
    );
  }
}

const REQUEST_KEYS = ['type', 'version', 'requestId', 'chainId', 'from', 'tx', 'summary', 'signingHash'] as const;
const TX_KEYS = ['type', 'nonce', 'maxPriorityFeePerGas', 'maxFeePerGas', 'gasLimit', 'to', 'value', 'data', 'accessList'] as const;

/**
 * Parses a request strictly (the signer side, and buildColdSignRequest's own
 * self-check): exactly the expected keys, type 0x2 only (a type-0x04 request
 * or an `authorizationList` key is refused with COLD_SIGN_TYPE_REFUSAL),
 * canonical decimal integers, lowercase hex data, EIP-55 addresses, an
 * empty access list, and a signingHash equal to the one recomputed from the
 * fields.
 */
export function parseColdSignRequest(text: string): ColdSignRequest {
  refusePastedPart(text);
  const value = parseJsonObject(text);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ColdSignRefusedError(COLD_SIGN_NOT_A_REQUEST);
  const loose = value as Record<string, unknown>;
  if (loose.type !== COLD_SIGN_REQUEST_TYPE) throw new ColdSignRefusedError(COLD_SIGN_NOT_A_REQUEST);
  const txLoose = loose.tx as Record<string, unknown> | undefined;
  if (txLoose && typeof txLoose === 'object' && (txLoose.type !== COLD_SIGN_TX_TYPE || 'authorizationList' in txLoose)) {
    throw new ColdSignRefusedError(COLD_SIGN_TYPE_REFUSAL);
  }
  const bad = (what: string) => new ColdSignRefusedError(`This cold-signing request is malformed (${what}), so it was refused.`);
  const o = objectWithKeys(value, REQUEST_KEYS);
  if (!o) throw bad('unexpected or missing fields');
  if (o.version !== COLD_SIGN_VERSION) throw bad(`version ${String(o.version)} is not supported`);
  if (typeof o.requestId !== 'string' || !REQUEST_ID.test(o.requestId)) throw bad('request id');
  if (typeof o.chainId !== 'string' || !DECIMAL.test(o.chainId) || o.chainId === '0') throw bad('chain id');
  const from = typeof o.from === 'string' ? checksummed(o.from) : null;
  if (!from || from !== o.from) throw bad('sending address');
  if (typeof o.summary !== 'string' || o.summary.length > 2000) throw bad('summary');
  if (typeof o.signingHash !== 'string' || !HASH32.test(o.signingHash)) throw bad('signing hash');
  const t = objectWithKeys(o.tx, TX_KEYS);
  if (!t) throw bad('transaction fields');
  for (const k of ['nonce', 'maxPriorityFeePerGas', 'maxFeePerGas', 'gasLimit', 'value'] as const) {
    if (typeof t[k] !== 'string' || !DECIMAL.test(t[k] as string)) throw bad(k);
  }
  if (BigInt(t.maxPriorityFeePerGas as string) > BigInt(t.maxFeePerGas as string)) throw bad('priority fee above the max fee');
  const to = typeof t.to === 'string' ? checksummed(t.to) : null;
  if (!to || to !== t.to) throw bad('recipient');
  if (typeof t.data !== 'string' || !HEX_DATA.test(t.data)) throw bad('data');
  if (!Array.isArray(t.accessList) || t.accessList.length !== 0) throw bad('access list');
  const request: ColdSignRequest = {
    type: COLD_SIGN_REQUEST_TYPE,
    version: COLD_SIGN_VERSION,
    requestId: o.requestId,
    chainId: o.chainId,
    from,
    tx: {
      type: COLD_SIGN_TX_TYPE,
      nonce: t.nonce as string,
      maxPriorityFeePerGas: t.maxPriorityFeePerGas as string,
      maxFeePerGas: t.maxFeePerGas as string,
      gasLimit: t.gasLimit as string,
      to,
      value: t.value as string,
      data: t.data,
      accessList: [],
    },
    summary: o.summary,
    signingHash: o.signingHash,
  };
  if (toHex(eip1559SigningHash(coldSignTxFromRequest(request))) !== request.signingHash) {
    throw new ColdSignRefusedError(
      'This cold-signing request is inconsistent: its signing hash does not match its transaction fields, so it was refused.',
    );
  }
  return request;
}

// ---------------------------------------------------------------------------
// The signature
// ---------------------------------------------------------------------------

/** The signature payload for a request (the off-line signer's side: scripts/testnet/cold-signer.mjs). */
export function buildColdSignSignature(request: ColdSignRequest, signer: string, signature: Eip1559Signature): string {
  const payload: ColdSignSignaturePayload = {
    type: COLD_SIGN_SIGNATURE_TYPE,
    version: COLD_SIGN_VERSION,
    requestId: request.requestId,
    signer: checksummed(signer) ?? signer,
    signingHash: request.signingHash,
    yParity: signature.yParity,
    r: toHex(signature.r),
    s: toHex(signature.s),
  };
  return JSON.stringify(payload);
}

export const COLD_SIGN_NOT_A_SIGNATURE =
  'This is not a Shiba Wallet cold-signing signature. Nothing was sent. Scan the signature QR code the off-line signer ' +
  'shows after it signs.';

export const COLD_SIGN_IS_THE_REQUEST =
  'This is the signing request itself, not its signature. Nothing was sent. Scan the code the off-line signer shows ' +
  'after it has signed.';

export const COLD_SIGN_OTHER_REQUEST =
  'This signature belongs to another signing request, not the one shown on this screen, so it was refused. Nothing ' +
  'was sent. Scan the signature the off-line signer made for this request.';

export const COLD_SIGN_HASH_MISMATCH =
  'The off-line signer signed different transaction details from the ones shown here (the signing hash differs), so ' +
  'the signature was refused. Nothing was sent. Check that the signer read this request, and compare the recipient ' +
  'and amount it shows with this screen.';

export function coldSignWrongSigner(signer: string, watched: string): string {
  return (
    `This signature was made by ${signer}, not by the watched address ${watched}, so it was refused. Nothing was ` +
    'sent. Sign with the key of the watched address.'
  );
}

export function coldSignUnreadableSignature(detail: string): string {
  return `The signature could not be read (${detail}), so it was refused. Nothing was sent.`;
}

const SIGNATURE_KEYS = ['type', 'version', 'requestId', 'signer', 'signingHash', 'yParity', 'r', 's'] as const;

export interface ColdSignVerified {
  /** The transaction rebuilt from the STORED request. */
  tx: Eip1559Transaction;
  signature: Eip1559Signature;
  /** The signed raw transaction (0x02 || rlp(...)), its bytes and its hash. */
  signed: SignedEip1559;
  /** The recovered signer: always equal to the request's watched address. */
  signer: string;
}

/**
 * Checks a scanned or pasted signature against the request this screen
 * STORED, in this order, before anything can be broadcast:
 *  1. it is a signature payload (a request, a part or other text is refused);
 *  2. its request id is the stored request's (COLD_SIGN_OTHER_REQUEST);
 *  3. its signing hash is the one recomputed from the stored request
 *     (COLD_SIGN_HASH_MISMATCH: the signer signed something else);
 *  4. yParity 0 or 1, r and s 32 bytes, s at most secp256k1n / 2 (EIP-2);
 *  5. its stated signer is the watched address, and
 *  6. ecrecover over the stored request's signing hash gives the watched
 *     address (coldSignWrongSigner).
 * The transaction is rebuilt from the stored request's fields, never from
 * the scanned text, so the bytes broadcast are exactly the ones shown.
 */
export function verifyColdSignSignature(text: string, request: ColdSignRequest): ColdSignVerified {
  refusePastedPart(text);
  const value = parseJsonObject(text);
  const loose = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  if (loose?.type === COLD_SIGN_REQUEST_TYPE) throw new ColdSignRefusedError(COLD_SIGN_IS_THE_REQUEST);
  if (!loose || loose.type !== COLD_SIGN_SIGNATURE_TYPE) throw new ColdSignRefusedError(COLD_SIGN_NOT_A_SIGNATURE);
  const o = objectWithKeys(value, SIGNATURE_KEYS);
  if (!o) throw new ColdSignRefusedError(coldSignUnreadableSignature('unexpected or missing fields'));
  if (o.version !== COLD_SIGN_VERSION) throw new ColdSignRefusedError(coldSignUnreadableSignature(`version ${String(o.version)}`));
  if (typeof o.requestId !== 'string' || o.requestId.toLowerCase() !== request.requestId) {
    throw new ColdSignRefusedError(COLD_SIGN_OTHER_REQUEST);
  }
  const tx = coldSignTxFromRequest(request);
  const expectedHash = toHex(eip1559SigningHash(tx));
  if (typeof o.signingHash !== 'string' || o.signingHash.toLowerCase() !== expectedHash) {
    throw new ColdSignRefusedError(COLD_SIGN_HASH_MISMATCH);
  }
  if (o.yParity !== 0 && o.yParity !== 1) throw new ColdSignRefusedError(coldSignUnreadableSignature('yParity must be 0 or 1'));
  if (typeof o.r !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(o.r)) throw new ColdSignRefusedError(coldSignUnreadableSignature('r must be 32 bytes of hex'));
  if (typeof o.s !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(o.s)) throw new ColdSignRefusedError(coldSignUnreadableSignature('s must be 32 bytes of hex'));
  const signature: Eip1559Signature = { yParity: o.yParity, r: toBytes(o.r.toLowerCase()), s: toBytes(o.s.toLowerCase()) };
  const stated = typeof o.signer === 'string' ? checksummed(o.signer) : null;
  if (!stated) throw new ColdSignRefusedError(coldSignUnreadableSignature('signer address'));
  if (stated.toLowerCase() !== request.from.toLowerCase()) {
    throw new ColdSignRefusedError(coldSignWrongSigner(stated, request.from));
  }
  let recovered: string;
  try {
    recovered = recoverEip1559Signer(tx, signature);
  } catch (e) {
    throw new ColdSignRefusedError(coldSignUnreadableSignature(e instanceof Error ? e.message : String(e)));
  }
  if (recovered.toLowerCase() !== request.from.toLowerCase()) {
    throw new ColdSignRefusedError(coldSignWrongSigner(recovered, request.from));
  }
  const signed = serializeSignedEip1559(tx, signature);
  return { tx, signature, signed, signer: recovered };
}

/** The line shown once a signature passed every check. */
export function coldSignVerifiedLine(watched: string): string {
  return `Signature checked: made by the watched address ${watched} over exactly the transaction shown above.`;
}

// ---------------------------------------------------------------------------
// Who may use it
// ---------------------------------------------------------------------------

/**
 * Cold signing is offered ONLY for a watch-only account (the gate,
 * components/WatchOnlyGate.tsx with watch-only.ts, refuses the route for a
 * multisig; this refuses every account that holds a key in this wallet).
 * Null when allowed.
 */
export function coldSignAccountRefusal(account: { watchOnly: boolean; multisig?: boolean } | null): string | null {
  if (!account) return COLD_SIGN_NO_ACCOUNT;
  if (account.multisig === true) return COLD_SIGN_MULTISIG_REFUSAL;
  if (!account.watchOnly) return COLD_SIGN_HAS_KEY_REFUSAL;
  return null;
}

export const COLD_SIGN_NO_ACCOUNT = 'No account is active, so there is nothing to prepare.';
export const COLD_SIGN_HAS_KEY_REFUSAL =
  'Signing with an off-line signer is offered only for a watch-only account. This account’s key is in this wallet, ' +
  'so send from the Send screen instead.';
export const COLD_SIGN_MULTISIG_REFUSAL =
  'Signing with an off-line signer is not offered for a multi-signature account: its operations are signing ' +
  'requests for its co-signers, built on the Multisig screen.';

// ---------------------------------------------------------------------------
// Screen copy (pinned by scripts/check-cold-signing.mjs)
// ---------------------------------------------------------------------------

/** The choice that opens the flow from a watch-only account (Home's and Tokens' link). */
export const COLD_SIGN_CHOICE_TITLE = 'Send with an off-line signer';

export const COLD_SIGN_SCREEN_TITLE = 'Send with an off-line signer';

/** Home's link on a watch-only account's Ethereum card (the arrow is dropped from the spoken label). */
export const COLD_SIGN_HOME_LINK = 'Send with an off-line signer ↗';

/** The link's screen-reader hint. */
export const COLD_SIGN_LINK_HINT = 'Prepares a send for this watched address that an off-line signer holding its key signs';

export const COLD_SIGN_INTRO =
  'This address is watched: this wallet holds no key for it. You can still prepare a send here and have it signed ' +
  'by an off-line signer that holds the key, such as another device kept away from the internet. The wallet shows ' +
  'the unsigned transaction as QR codes, the signer signs it, and you scan its signature back. Nothing is sent until ' +
  'the wallet has checked that signature.';

export const COLD_SIGN_QR_CONTENTS =
  'These QR codes contain only the unsigned transaction (the network, the sending address, the nonce, the fees, the ' +
  'recipient, the amount and the call data), a plain summary and a request number. They contain no key and no ' +
  'secret: anyone who sees them learns what you plan to send, but cannot send it.';

export const COLD_SIGN_CHECK_ON_SIGNER =
  'Before signing, check on the off-line signer that it shows the same recipient, amount, network and fee as this ' +
  'screen. Sign only if they match.';

export const COLD_SIGN_FORMAT_NOTE =
  'This is Shiba Wallet’s own request format (shiba-wallet/cold-sign-request, version 1), not the EIP-4527 format ' +
  'some hardware signers read, so the off-line signer must understand this format.';

export const COLD_SIGN_SCAN_NOTE =
  'Scan the signature the off-line signer shows. A signature for a different request, from a different key or over ' +
  'changed transaction details is refused. The wallet broadcasts only after it has checked that the watched address ' +
  'signed exactly the transaction shown above.';

export const COLD_SIGN_REVIEW_AGAIN_NOTE =
  'The request is kept only while this screen is open. If you leave, review the send again and have the new request ' +
  'signed; an old signature is refused for a new request.';

export const COLD_SIGN_SHOW_BUTTON = 'Show for the off-line signer';
export const COLD_SIGN_SCAN_BUTTON = 'Scan the signature';
export const COLD_SIGN_PASTE_LABEL = 'Signature text from the signer';
export const COLD_SIGN_CHECK_PASTED_BUTTON = 'Check the pasted signature';
export const COLD_SIGN_BROADCAST_BUTTON = 'Broadcast the signed transaction';

export const COLD_SIGN_SCAN_RATIONALE =
  'The camera reads the signature QR code the off-line signer shows. Nothing is sent until the wallet has checked it.';
