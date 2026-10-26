// Cold signing for a SMART ACCOUNT, the app half (phase 23 item 5).
//
// A WATCH-ONLY account whose watched address is the OWNER of a Kernel v3.3
// smart account: the off-line signer holds the owner key, this phone holds
// only addresses. The send is quoted exactly as the Send screen quotes a
// smart-account send (aa.ts prepareAaSend / prepareAaErc20Send through
// prepareAaCalls: the bundler estimate, the deposit headroom, the fees over
// the bundler's floor), shown on the same confirm (fee, deposit row, preview,
// risk card, "Bundler gas estimate passed"), and then, instead of signing,
// the engine prepares the operation for an external signer
// (SmartAccountClient.prepareUserOperationForExternalSigner, with the Send
// screen's signedFeeGuard as beforeSign) and builds the request
// (cold-userop.ts buildColdUserOpRequest). The request goes out as QR codes
// with its own part prefix "SW-CU:" (never the regular flow's "SW-CS:"), the
// signature comes back by scan or paste, and the engine's
// submitColdUserOpRequest checks it against the STORED request, re-reads the
// chain and runs the caller's beforeSign (the bundler-floor check, then
// signedFeeGuard) before eth_sendUserOperation.
//
// THE FEES ARE FIXED AT PREPARATION: the owner's signature covers them
// through the userOpHash, so a bundler floor that rises before submission is
// a refusal and a fresh request, never a reprice.
//
// The account: the watched owner's own Kernel v3.3 account at CREATE2 index
// COLD_AA_ACCOUNT_INDEX (0; aa.ts explains the rule), with no paymaster and
// no token fee (aa.ts createColdOwnerAaClient). EIP-7702, recovered,
// multisig, passkey and session-key bundles are refused before any request.
//
// Free of React Native (Node's type stripping runs it in
// scripts/check-cold-aa.mjs; hence the explicit .ts extensions). It reads no
// key, no secret and no storage, and signs nothing: the owner is an address
// on every path, and the engine's address-only owner throws if anything tries
// to sign with it.

import {
  KERNEL_V3_3,
  KERNEL_V3_3_ECDSA_ROOT_SCHEME,
  NodeClient,
  buildColdUserOpRequest,
  predictKernelAddress,
  readKernelOwner,
  requiredPrefund,
  submitColdUserOpRequest,
  verifyColdUserOpSignature,
  COLD_USEROP_EXPIRED,
  type ColdUserOpRequest,
  type ColdUserOpVerified,
  type UserOperation,
} from '@shiba-wallet/chains-evm';
import { toChecksumAddress } from '@shiba-wallet/core';
import {
  AA_FEE_ROSE_NEXT_STEP,
  AaFeeRoseError,
  COLD_AA_ACCOUNT_INDEX,
  QUOTE_FAILED_TITLE,
  addressOnlyOwner,
  assertQuoteFeesMeetBundlerFloor,
  checkAaQuoteBeforeApproval,
  claimQuoteForSubmission,
  describeAaError,
  forgetSmartAccountAddress,
  isBundlerFeeFloorRefusal,
  notifyAaOperationSent,
  submitWithPendingRecord,
  prepareAaErc20Send,
  prepareAaSend,
  signedFeeGuard,
  type AaClientBundle,
  type AaErc20Target,
  type AaSendQuote,
} from './aa.ts';
import { formatUnits } from './balances.ts';
import { createQrPartCodec, type QrPartScan, type QrPartScanResult } from './qr-parts.ts';
import { COLD_SIGN_QR_MAX_PARTS, COLD_SIGN_QR_PART_MAX_BYTES } from './cold-signing.ts';
// Pure data with no imports (see its file comment).
import { evmProfileByCaip2 } from '../config/evm-chain.ts';
import {
  BroadcastAlreadyHandedOverError,
  describeBroadcastOutcome,
  isBroadcastOutcomeUnknown,
} from './broadcast-outcome.ts';
import { eip155Caip2 } from '../config/readiness.ts';
import type { BroadcastSpend } from './broadcast-spend.ts';

// ---------------------------------------------------------------------------
// QR codes in parts: the request's own prefix
// ---------------------------------------------------------------------------

/**
 * The prefix of one part of a multi-part smart-account request:
 * "SW-CU:<n>/<total>:<chunk>". Distinct from the regular cold-signing
 * prefix "SW-CS:" (wallet/cold-signing.ts) and the multisig's "SW-MS:", so
 * a part of one kind of code can never complete another kind. A deploying
 * request is about 2.3 KB, so 3 parts at the shared 858-byte size.
 */
export const COLD_AA_QR_PART_PREFIX = 'SW-CU:';

export const COLD_AA_QR_DAMAGED =
  'This QR code looks like part of a Shiba Wallet smart-account signing code, but it is damaged. Scan it again.';

const codec = createQrPartCodec({
  prefix: COLD_AA_QR_PART_PREFIX,
  maxBytes: COLD_SIGN_QR_PART_MAX_BYTES,
  maxParts: COLD_SIGN_QR_MAX_PARTS,
  damagedSentence: COLD_AA_QR_DAMAGED,
});

/** The QR codes for a smart-account payload (one plain code when it fits, else "SW-CU:" parts); null when too large. */
export function splitColdAaQrParts(payload: string): string[] | null {
  return codec.split(payload);
}

/** Takes one scanned text (a whole payload or one "SW-CU:" part); see qr-parts.ts createQrPartCodec. */
export function acceptColdAaQrScan(scan: QrPartScan | null, data: string): QrPartScanResult {
  return codec.accept(scan, data);
}

/** The caption under the request's codes. */
export const COLD_AA_REQUEST_CAPTION = 'Smart-account signing request';

/** "Smart-account signing request — part i of N" (the caption alone for one code). */
export function coldAaQrPartCaption(index: number, total: number): string {
  return total > 1 ? `${COLD_AA_REQUEST_CAPTION} — part ${index + 1} of ${total}` : COLD_AA_REQUEST_CAPTION;
}

function refusePastedPart(text: string): void {
  const part = codec.partOf(text);
  if (part) {
    throw new ColdAaRefusedError(
      `This is part ${part.n} of ${part.total} of a multi-part QR code, not the whole text. Read every part with the ` +
        'scan button, or paste the whole text.',
    );
  }
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/** Thrown for this module's own refusals; the message is the sentence the screen shows. */
export class ColdAaRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ColdAaRefusedError';
  }
}

export const COLD_AA_BUNDLE_REFUSAL =
  'This operation can only be prepared for the watched address’s own Kernel v3.3 smart account, paying its own ' +
  'network fee: not for an EIP-7702 account, a recovered or multi-signature account, a passkey or session key, or ' +
  'with a paymaster. Nothing was prepared.';

export const COLD_AA_SELF_PAID_ONLY =
  'Signing with an off-line signer from a smart account is offered only when the account pays its own network fee: ' +
  'no paymaster and no fee in a token. Nothing was prepared.';

export const COLD_AA_ROOT_UNREADABLE =
  'The wallet could not read who signs for this smart account on-chain, so it did not prepare anything. Try again ' +
  'in a moment.';

export function coldAaRootChanged(sender: string, owner: string): string {
  return (
    `The smart account ${sender} no longer has the watched address ${owner} as its signer on-chain (its root ` +
    'validator or its ECDSA owner is different), so a signature from the watched address would be refused. Nothing ' +
    'was prepared.'
  );
}

export const COLD_AA_SENDER_CHANGED =
  'The operation was prepared for a different smart account from the one you reviewed, so it was refused. Nothing ' +
  'was prepared; review the send again.';

export const COLD_AA_DEPLOYMENT_CHANGED =
  'The smart account’s deployment changed since you reviewed this send (another operation deployed it), so the ' +
  'reviewed fee no longer describes it. Nothing was prepared; review the send again.';

export const COLD_AA_FEES_DIFFER =
  'This request’s fees differ from the ones you reviewed, so it was refused. Nothing was sent; review the send again.';

export const COLD_AA_NOT_SENT_TITLE = 'Not sent';

/**
 * Replaces AA_FEE_ROSE_NEXT_STEP ("Nothing was signed or sent…") when the
 * bundler's floor rose AFTER the off-line signer signed: something was
 * signed, but the signature covers the old fees and cannot be reused.
 */
export const COLD_AA_FEE_ROSE_AFTER_SIGNING =
  'Nothing was sent. The off-line signature covers the old fees and cannot be reused: review the send again and ' +
  'have the new request signed. The wallet never raises the fees of a signed operation.';

// ---------------------------------------------------------------------------
// The account
// ---------------------------------------------------------------------------

/** The watched owner's smart-account address: Kernel v3.3 at COLD_AA_ACCOUNT_INDEX (the pinned deployment). */
export function coldAaAccountAddress(owner: string): string {
  return predictKernelAddress(owner, { index: BigInt(COLD_AA_ACCOUNT_INDEX) });
}

/**
 * Refuses (ColdAaRefusedError, before any request) every bundle that is not
 * the plain cold-owner Kernel bundle aa.ts createColdOwnerAaClient builds.
 */
export function assertColdAaBundle(bundle: AaClientBundle): void {
  if (
    bundle.accountType !== 'kernel-v3.3' ||
    bundle.eip7702 !== undefined ||
    bundle.recovered !== undefined ||
    bundle.multisig !== undefined ||
    bundle.sponsored ||
    'passkey' in bundle ||
    bundle.accountIndex !== COLD_AA_ACCOUNT_INDEX
  ) {
    throw new ColdAaRefusedError(COLD_AA_BUNDLE_REFUSAL);
  }
}

/** Refuses a quote that is not a self-paid plain Kernel v3.3 quote for the watched owner's account. */
export function assertColdAaQuote(quote: AaSendQuote, owner: string): void {
  if (quote.sponsored || quote.tokenGas !== undefined) throw new ColdAaRefusedError(COLD_AA_SELF_PAID_ONLY);
  if (quote.accountType !== 'kernel-v3.3' || quote.eip7702 !== undefined || quote.recovered === true || quote.passkey === true) {
    throw new ColdAaRefusedError(COLD_AA_BUNDLE_REFUSAL);
  }
  if (quote.sender.toLowerCase() !== coldAaAccountAddress(owner).toLowerCase()) {
    throw new ColdAaRefusedError(COLD_AA_SENDER_CHANGED);
  }
}

/** What the form shows about the smart account (Send's smart-account form shows the same facts). */
export interface ColdAaAccount {
  /** EIP-55; counterfactual until deployed. */
  address: string;
  deployed: boolean;
  balance: bigint;
  /** The EntryPoint deposit; null when the read failed. */
  deposit: bigint | null;
}

/**
 * Reads the watched owner's smart account for the form: the endpoint's chain
 * id (must be the bundle's), the spec's address (the factory's answer checked
 * against the local CREATE2 prediction) equal to coldAaAccountAddress, and
 * its code, balance and EntryPoint deposit. Node only; no bundler request.
 */
export async function readColdAaAccount(bundle: AaClientBundle, owner: string): Promise<ColdAaAccount> {
  assertColdAaBundle(bundle);
  const node = new NodeClient(bundle.node);
  const chainId = await node.chainId();
  if (chainId !== bundle.chainId) {
    throw new Error(`Endpoint is chain id ${chainId}, expected ${bundle.chainId}. Check the RPC endpoint in Settings.`);
  }
  const address = await bundle.client.getAddress(addressOnlyOwner(owner));
  if (address.toLowerCase() !== coldAaAccountAddress(owner).toLowerCase()) throw new ColdAaRefusedError(COLD_AA_SENDER_CHANGED);
  const [deployed, balance, deposit] = await Promise.all([
    bundle.client.isDeployed(addressOnlyOwner(owner)),
    node.getBalance(address),
    bundle.client.getEntryPointDeposit(address).catch(() => null),
  ]);
  return { address: toChecksumAddress(hexBytes(address)), deployed, balance, deposit };
}

function hexBytes(address: string): Uint8Array {
  const clean = address.slice(2).toLowerCase();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/**
 * For a DEPLOYED account: its root validator must still be the pinned ECDSA
 * validator and that validator's stored owner the watched address
 * (kernel-recovery.ts readKernelOwner), else an off-line signature from the
 * watched address could not validate (AA24) and nothing is prepared. An
 * unreadable answer refuses too (fail closed).
 */
export async function assertColdAaRoot(bundle: AaClientBundle, sender: string, owner: string): Promise<void> {
  let state: Awaited<ReturnType<typeof readKernelOwner>>;
  try {
    state = await readKernelOwner(bundle.node, sender, KERNEL_V3_3.ecdsaValidator);
  } catch {
    throw new ColdAaRefusedError(COLD_AA_ROOT_UNREADABLE);
  }
  if (!state.ecdsaRoot || state.owner.toLowerCase() !== owner.toLowerCase()) {
    throw new ColdAaRefusedError(coldAaRootChanged(sender, owner));
  }
}

/** What the form asks to send. */
export type ColdAaTarget =
  | { kind: 'native'; to: string; amount: bigint; fromMax?: boolean }
  | { kind: 'erc20'; token: AaErc20Target & { amount: bigint } };

/**
 * The quote, exactly as the Send screen's smart-account quote (prepareAaSend
 * / prepareAaErc20Send), for the watched owner's account. Before any bundler
 * request: the bundle is the cold-owner bundle, and a DEPLOYED account still
 * has the watched address as its ECDSA root signer (assertColdAaRoot). After:
 * the quote is self-paid, plain Kernel v3.3, for coldAaAccountAddress(owner).
 */
export async function quoteColdAa(bundle: AaClientBundle, owner: string, target: ColdAaTarget): Promise<AaSendQuote> {
  assertColdAaBundle(bundle);
  const sender = coldAaAccountAddress(owner);
  const code = await bundle.node('eth_getCode', [sender, 'latest']);
  if (typeof code === 'string' && !/^0x0*$/i.test(code)) await assertColdAaRoot(bundle, sender, owner);
  const quote =
    target.kind === 'native'
      ? await prepareAaSend(bundle, owner, target.to, target.amount, target.fromMax === true ? { fromMax: true } : {})
      : await prepareAaErc20Send(bundle, owner, target.token);
  assertColdAaQuote(quote, owner);
  return quote;
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

/** The plain sentence the request carries (the signer decodes the fields itself and never trusts it). */
export function coldAaSummary(args: {
  quote: AaSendQuote;
  owner: string;
  /** The signed worst case (requiredPrefund of the prepared operation). */
  worstCaseFee: bigint;
  /** The native coin as the profile shows it ("test ETH"). */
  nativeSymbol: string;
}): string {
  const { quote, owner, worstCaseFee, nativeSymbol } = args;
  const what = quote.token
    ? `send ${formatUnits(quote.token.amount, quote.token.decimals, quote.token.decimals)} ${quote.token.symbol} ` +
      `(token contract ${quote.token.contract}) to ${quote.token.recipient}`
    : `send ${formatUnits(quote.amount, 18, 18)} ${nativeSymbol} to ${quote.to}`;
  const deploys = quote.deployed ? '' : '; this operation also deploys the smart account';
  return (
    `Smart-account operation from ${quote.sender} (owner ${owner}): ${what}${deploys}. ` +
    `Network fee at most ${formatUnits(worstCaseFee, 18, 18)} ${nativeSymbol}, paid by the smart account.`
  );
}

/**
 * Prepares the request for a reviewed quote, in this order: the bundle and
 * the quote are the cold kind; the purely network fee check the Send screen
 * runs before its device check (checkAaQuoteBeforeApproval: a quote already
 * used, or fees below the bundler's floor, is refused with nothing claimed);
 * the quote is claimed (one request per quote, aa.ts
 * claimQuoteForSubmission); the engine builds the operation exactly as
 * sendCalls would up to the signature, with beforeSign = signedFeeGuard
 * (the quoted fees exactly, the worst case at most the displayed fee); the
 * prepared operation carries no paymaster, the root nonce key, the reviewed
 * sender and the reviewed deployment state; then the engine's request, with
 * the CREATE2 index when the operation deploys the account.
 */
export async function prepareColdAaRequest(args: {
  bundle: AaClientBundle;
  owner: string;
  quote: AaSendQuote;
  nowSeconds: number;
  nativeSymbol: string;
  requestId?: string;
}): Promise<ColdUserOpRequest> {
  const { bundle, owner, quote } = args;
  assertColdAaBundle(bundle);
  assertColdAaQuote(quote, owner);
  await checkAaQuoteBeforeApproval(bundle.bundler, quote);
  claimQuoteForSubmission(quote);
  const fees = { maxFeePerGas: quote.maxFeePerGas, maxPriorityFeePerGas: quote.maxPriorityFeePerGas };
  const prepared = await bundle.client.prepareUserOperationForExternalSigner(owner, quote.calls, fees, {
    scheme: KERNEL_V3_3_ECDSA_ROOT_SCHEME,
    beforeSign: signedFeeGuard(fees, quote.fee),
  });
  if (prepared.userOp.paymaster !== undefined) throw new ColdAaRefusedError(COLD_AA_SELF_PAID_ONLY);
  if (prepared.nonceKey !== 0n) throw new ColdAaRefusedError(COLD_AA_BUNDLE_REFUSAL);
  if (prepared.userOp.sender.toLowerCase() !== quote.sender.toLowerCase()) throw new ColdAaRefusedError(COLD_AA_SENDER_CHANGED);
  const deploys = prepared.userOp.factory !== undefined;
  if (deploys === quote.deployed) throw new ColdAaRefusedError(COLD_AA_DEPLOYMENT_CHANGED);
  const summary = coldAaSummary({ quote, owner, worstCaseFee: requiredPrefund(prepared.userOp), nativeSymbol: args.nativeSymbol });
  return buildColdUserOpRequest(prepared, {
    summary,
    accountIndex: deploys ? BigInt(COLD_AA_ACCOUNT_INDEX) : null,
    nowSeconds: args.nowSeconds,
    ...(args.requestId ? { requestId: args.requestId } : {}),
  });
}

/** True once the request's lifetime is over (the engine's own rule: now > expiresAt). */
export function coldAaRequestExpired(request: ColdUserOpRequest, nowSeconds: number): boolean {
  return BigInt(nowSeconds) > BigInt(request.expiresAt);
}

/** "Expires at HH:MM UTC. …" for the request's expiry. */
export function coldAaExpiryLine(request: ColdUserOpRequest): string {
  const at = new Date(Number(request.expiresAt) * 1000);
  const hh = String(at.getUTCHours()).padStart(2, '0');
  const mm = String(at.getUTCMinutes()).padStart(2, '0');
  return `Expires at ${hh}:${mm} UTC. After that the signature is refused and a new request must be prepared.`;
}

// ---------------------------------------------------------------------------
// The signature and the submission
// ---------------------------------------------------------------------------

/**
 * Checks a scanned or pasted signature against the STORED request with no
 * network: a pasted part is refused, an expired request is refused with the
 * engine's COLD_USEROP_EXPIRED, then the engine's verifyColdUserOpSignature
 * (payload kind, exact keys, request id, recomputed hash and digest, low s,
 * the stated and the recovered signer equal to the owner).
 */
export function verifyColdAaSignature(text: string, request: ColdUserOpRequest, nowSeconds: number): ColdUserOpVerified {
  refusePastedPart(text);
  if (coldAaRequestExpired(request, nowSeconds)) throw new ColdAaRefusedError(COLD_USEROP_EXPIRED);
  return verifyColdUserOpSignature(text, request);
}

/**
 * Requests whose submission got no answer from the bundler in time (phase 23
 * item 8), by request id: never submitted a second time from this phone
 * (BroadcastAlreadyHandedOverError). In memory only.
 */
const outcomeUnknownRequests = new Set<string>();

/**
 * Submits a stored request with a scanned signature through the engine's
 * submitColdUserOpRequest: the expiry, the signature check against the
 * stored request, the chain reads (sender, nonce, deployment), then
 * beforeSign = the bundler-floor check (assertQuoteFeesMeetBundlerFloor,
 * which refuses with AaFeeRoseError 'floor' — a fresh request, never a
 * reprice) followed by signedFeeGuard against the reviewed fee, and only
 * then eth_sendUserOperation. On acceptance the smart account's cached
 * address is forgotten and notifyAaOperationSent fires once with kind
 * 'cold-aa' (the pending card's "from an off-line signer"). Since phase 23
 * item 8 the operation is listed in the pending registry just before it is
 * handed to the bundler (aa.ts submitWithPendingRecord); a bundler that
 * does not answer in time leaves it listed, throws
 * BroadcastOutcomeUnknownError, and the request is never submitted again
 * from this phone.
 */
export async function submitColdAa(args: {
  bundle: AaClientBundle;
  request: ColdUserOpRequest;
  quote: AaSendQuote;
  signatureText: string;
  nowSeconds: number;
  /** What it counts against the spending limits, counted before the broadcast (./broadcast-spend.ts). */
  spend?: BroadcastSpend;
}): Promise<{ userOpHash: string; userOp: UserOperation }> {
  const { bundle, request, quote } = args;
  assertColdAaBundle(bundle);
  if (outcomeUnknownRequests.has(request.requestId)) throw new BroadcastAlreadyHandedOverError(request.userOpHash);
  if (BigInt(request.chainId) !== bundle.chainId || request.sender.toLowerCase() !== quote.sender.toLowerCase()) {
    throw new ColdAaRefusedError(COLD_AA_SENDER_CHANGED);
  }
  const fees = { maxFeePerGas: BigInt(request.userOp.maxFeePerGas), maxPriorityFeePerGas: BigInt(request.userOp.maxPriorityFeePerGas) };
  if (fees.maxFeePerGas !== quote.maxFeePerGas || fees.maxPriorityFeePerGas !== quote.maxPriorityFeePerGas) {
    throw new ColdAaRefusedError(COLD_AA_FEES_DIFFER);
  }
  refusePastedPart(args.signatureText);
  const guard = signedFeeGuard(fees, quote.fee);
  // Listed in the pending registry before it is handed to the bundler
  // (phase 23 item 8); kept when the bundler does not answer in time.
  let result: { userOpHash: string; userOp: UserOperation };
  try {
    result = await submitWithPendingRecord(
      {
        chain: eip155Caip2(bundle.chainId),
        sender: request.sender,
        owner: request.owner,
        bundler: bundle.bundler,
        kind: 'cold-aa',
        resend: null,
      },
      (beforeSend) =>
        submitColdUserOpRequest(bundle.client, request, args.signatureText, {
          nowSeconds: args.nowSeconds,
          beforeSign: async (op) => {
            await assertQuoteFeesMeetBundlerFloor(bundle.bundler, fees);
            guard(op);
          },
          beforeSend,
        }),
      args.spend ?? null,
    );
  } catch (error) {
    if (isBroadcastOutcomeUnknown(error)) outcomeUnknownRequests.add(request.requestId);
    throw error;
  }
  forgetSmartAccountAddress(request.sender);
  notifyAaOperationSent({
    chain: eip155Caip2(bundle.chainId),
    userOpHash: result.userOpHash,
    sender: request.sender,
    owner: request.owner,
    bundler: bundle.bundler,
    sentAt: Date.now(),
    kind: 'cold-aa',
    resend: null,
  });
  return result;
}

/**
 * A failure as the screen shows it, and whether the request (or the quote)
 * is used up so the screen must return to the form:
 *  - this module's and the engine's refusals (ColdAaRefusedError,
 *    ColdUserOpRefusedError, ExternalSignatureError) as they are, titled
 *    "Not sent"; a bad scan keeps the request (scan again), an expired
 *    request or a chain-state refusal (nonce used, deployment changed) does
 *    not;
 *  - a fee rise (AaFeeRoseError, or the bundler's own floor refusal) with
 *    the Send screen's title; after signing, its closing sentence says the
 *    signature cannot be reused (COLD_AA_FEE_ROSE_AFTER_SIGNING);
 *  - everything else through describeAaError (funding, impossible
 *    estimates, a refused deployment), else the plain message.
 */
export function describeColdAaError(
  error: unknown,
  stage: 'quote' | 'prepare' | 'submit',
  context: { deployed: boolean | null; sender?: string | null; bundlerUrl?: string | null },
): { title: string; detail: string; back: boolean } {
  const name = (error as { name?: unknown } | null)?.name;
  const message = error instanceof Error ? error.message : String(error);
  // No answer from the bundler in time, or a second submission of such a
  // request (phase 23 item 8): the outcome is unknown and the request is
  // used up, so back to the form; never worded as "not sent".
  const outcome = describeBroadcastOutcome(error);
  if (outcome) return { title: outcome.title, detail: outcome.detail, back: true };
  if (name === 'ColdAaRefusedError' || name === 'ColdUserOpRefusedError' || name === 'ExternalSignatureError') {
    const back =
      stage !== 'submit' ||
      name === 'ExternalSignatureError' ||
      message === COLD_USEROP_EXPIRED ||
      message === COLD_AA_FEES_DIFFER ||
      message === COLD_AA_SENDER_CHANGED;
    return { title: stage === 'quote' ? QUOTE_FAILED_TITLE : COLD_AA_NOT_SENT_TITLE, detail: message, back };
  }
  if (name === 'FeatureNotAllowedError') return { title: COLD_AA_NOT_SENT_TITLE, detail: message, back: true };
  const described = describeAaError(error, {
    accountType: 'kernel-v3.3',
    deployed: context.deployed,
    ...(context.sender !== undefined ? { sender: context.sender } : {}),
    ...(context.bundlerUrl !== undefined ? { bundlerUrl: context.bundlerUrl } : {}),
  });
  const feeRose = error instanceof AaFeeRoseError || isBundlerFeeFloorRefusal(message);
  if (described) {
    const detail =
      stage === 'submit' && error instanceof AaFeeRoseError
        ? described.detail.replace(AA_FEE_ROSE_NEXT_STEP, COLD_AA_FEE_ROSE_AFTER_SIGNING)
        : described.detail;
    return { title: described.title, detail, back: stage !== 'submit' || feeRose };
  }
  return { title: stage === 'quote' ? QUOTE_FAILED_TITLE : COLD_AA_NOT_SENT_TITLE, detail: message, back: stage !== 'submit' };
}

// ---------------------------------------------------------------------------
// Who may use it, and the network
// ---------------------------------------------------------------------------

/** The network's name for the screens: the profile's label, else "chain id N". */
export function coldAaNetworkName(chainId: bigint): string {
  return evmProfileByCaip2(`eip155:${chainId}`)?.label ?? `chain id ${chainId}`;
}

// ---------------------------------------------------------------------------
// Screen copy (pinned by scripts/check-cold-aa.mjs)
// ---------------------------------------------------------------------------

export const COLD_AA_SWITCH_LABEL = 'Send from the smart account';

export const COLD_AA_SWITCH_HINT =
  'Sends from the watched address’s own Kernel v3.3 smart account instead; the off-line signer signs the operation ' +
  'as its owner';

export const COLD_AA_ACCOUNT_NOTE =
  'The smart account is the watched address’s Kernel v3.3 account at CREATE2 index 0, the address that follows from ' +
  'the owner alone. The off-line signer holds the owner key and signs the operation; the smart account pays its own ' +
  'network fee from its balance and EntryPoint deposit (no paymaster, no fee in a token).';

export const COLD_AA_PAYMASTER_NOT_USED_NOTE =
  'The sponsorship paymaster saved for this network is not used here: with an off-line signer the smart account ' +
  'pays its own network fee.';

export const COLD_AA_OWNER_ROW_LABEL = 'Owner (signs off-line)';

/** Byte-identical to the Send screen's smart-account confirm line (pinned against its source). */
export const COLD_AA_ESTIMATE_PASSED = 'Bundler gas estimate passed (eth_estimateUserOperationGas simulated the operation).';

export const COLD_AA_QR_CONTENTS =
  'These QR codes contain only the unsigned smart-account operation (the network, the EntryPoint, the smart account, ' +
  'its owner, the nonce, the gas limits, the fees and the calls), a plain summary, the userOpHash, the digest to ' +
  'sign and a request number. They contain no key and no secret: anyone who sees them learns what you plan to send, ' +
  'but cannot send it.';

export const COLD_AA_CHECK_ON_SIGNER =
  'Before signing, check on the off-line signer that it decodes the same recipient, amount, network, smart account ' +
  'and worst-case fee as this screen. Sign only if they match.';

export const COLD_AA_FORMAT_NOTE =
  'This is Shiba Wallet’s own request format (shiba-wallet/cold-sign-userop-request, version 1), not the EIP-4527 ' +
  'format some hardware signers read, so the off-line signer must understand this format.';

export const COLD_AA_FEES_FIXED_NOTE =
  'The network fees are fixed now: the owner’s signature covers them, so they cannot be raised after signing. If the ' +
  'bundler’s minimum fee rises above them before you submit, the wallet refuses to submit, and you review the send ' +
  'again and have a new request signed.';

export const COLD_AA_SCAN_NOTE =
  'Scan the signature the off-line signer shows. A signature for a different request, from a key other than the ' +
  'owner’s or over a changed operation is refused. The wallet submits to the bundler only after it has checked that ' +
  'the owner signed exactly the operation shown above.';

export const COLD_AA_REVIEW_AGAIN_NOTE =
  'The request is kept only while this screen is open, and only until it expires. If you leave, review the send ' +
  'again and have the new request signed; an old signature is refused for a new request.';

export const COLD_AA_SUBMIT_BUTTON = 'Submit to the bundler';

export const COLD_AA_SCAN_RATIONALE =
  'The camera reads the signature QR code the off-line signer shows. Nothing is sent until the wallet has checked it.';

export function coldAaVerifiedLine(owner: string): string {
  return `Signature checked: made by the owner ${owner} over exactly the operation shown above.`;
}
