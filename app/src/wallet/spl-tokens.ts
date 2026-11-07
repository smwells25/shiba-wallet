// Solana tokens in the app (phase 24 item 1, the app half of feature 43):
// tracking a mint, the Home rows' balances and the send, all through the
// engine's token layer (packages/chains-solana tokenTransfer.ts and
// tokenExtensions.ts). This module only wires that layer to an RPC client,
// the readiness switchboard and the wallet's signing path; every protocol
// decision (which program, which instruction, which extension is refused,
// the transfer fee, the destination account) is the engine's, and every
// refusal sentence the engine writes is shown exactly as it is written.
//
// React-free with explicit .ts extensions, so scripts/check-spl-tokens.mjs
// runs this exact file under Node's type stripping.
import { base58 } from '@scure/base';
import { formatAssetId } from '@shiba-wallet/core';
import type { DerivedAccount, FungibleAsset } from '@shiba-wallet/core';
import {
  KNOWN_SOLANA_TOKENS,
  SOLANA_DEVNET_CAIP2,
  SOLANA_MAINNET_CAIP2,
  SPL_SENTENCES,
  SolanaRpcClient,
  SplTokenRefusal,
  compileMessage,
  findSolanaLookAlike,
  formatBaseUnits,
  httpTransport,
  listOwnerTokenAccounts,
  lookAlikeSentence,
  quoteSplTokenTransfer,
  readMintProfile,
  signTransaction,
  solanaFungibleAsset,
  type MintProfile,
  type SignatureStatus,
  type SplTokenTransferQuote,
} from '@shiba-wallet/chains-solana';
import { isFeatureAllowed, readinessReason } from '../config/readiness.ts';
import { parseUnits } from './balances.ts';

/**
 * The Solana slot's id: the mainnet CAIP-2 id the accounts, routes and
 * signWith carry (send.ts SOLANA_CHAIN_ID). The network actually serving the
 * slot is mainnet or devnet (config/defaults.ts resolveActiveNetworks); a
 * Solana key is the same on both, so signing always names the slot.
 */
export const SOLANA_SLOT_CHAIN_ID = SOLANA_MAINNET_CAIP2;

/** The network's name as the screens say it. */
export function solanaNetworkLabel(caip2: string): string {
  if (caip2 === SOLANA_DEVNET_CAIP2) return 'Solana devnet';
  if (caip2 === SOLANA_MAINNET_CAIP2) return 'Solana';
  return caip2;
}

// ---------------------------------------------------------------------------
// The readiness gate (row 'spl-tokens', test networks only, enforced)
// ---------------------------------------------------------------------------

/** What a refused send tells the user to do (the shared READINESS_TESTNET_HINT names only EVM networks). */
export const SPL_DEVNET_HINT = 'Turn on Solana devnet in Settings → Developer to send Solana tokens.';

/** The refusal shown wherever a Solana token send is refused by the switchboard. */
export function splSendRefusalText(): string {
  return `${readinessReason('spl-tokens')} ${SPL_DEVNET_HINT}`;
}

/** Thrown before any network request when the switchboard refuses a Solana token send. */
export class SplSendNotAllowedError extends Error {
  constructor() {
    super(splSendRefusalText());
    this.name = 'SplSendNotAllowedError';
  }
}

/** null when a Solana token send is allowed on `caip2` (Solana devnet only), else the refusal sentence. */
export function splSendGate(caip2: string): string | null {
  return isFeatureAllowed('spl-tokens', caip2) ? null : splSendRefusalText();
}

/** Throws SplSendNotAllowedError unless the readiness row 'spl-tokens' allows a send on `caip2`. */
export function assertSplSendAllowed(caip2: string): void {
  if (!isFeatureAllowed('spl-tokens', caip2)) throw new SplSendNotAllowedError();
}

// ---------------------------------------------------------------------------
// Tracking a mint
// ---------------------------------------------------------------------------

/** The sentence for text that is not a 32-byte base58 address. */
export const SPL_MINT_ADDRESS_INVALID = 'A mint address is a Solana address: base58 text that decodes to 32 bytes. This text is not one.';

/** Title, body and button of the Track confirmation for one mint. */
export interface TrackPrompt {
  title: string;
  message: string;
  confirm: string;
}

/** What the wallet knows about a mint before it is tracked. */
export interface MintPreview {
  caip2: string;
  mint: string;
  profile: MintProfile;
  /** The symbol from the mint's own metadata or Metaplex; else the engine's known-token table for this exact mint; else null (typed by the user). */
  symbol: string | null;
  name: string | null;
  /** Where the symbol came from. */
  symbolSource: 'metadata' | 'known' | null;
  /** The mint's own decimals. */
  decimals: number;
  /** The engine's refusal sentence when this token cannot be sent, else null. */
  sendRefusal: string | null;
  /** The look-alike sentence (engine's lookAlikeSentence) when the symbol imitates a known or tracked token, else null. */
  lookAlike: string | null;
}

/** Reference tokens for the look-alike rule on one network: the engine's known tokens and the tracked ones. */
function lookAlikeReferences(caip2: string, tracked: readonly FungibleAsset[]): { caip2: string; mint: string; symbol: string }[] {
  return [
    ...KNOWN_SOLANA_TOKENS.filter((t) => t.caip2 === caip2).map((t) => ({ caip2: t.caip2, mint: t.mint, symbol: t.symbol })),
    ...tracked
      .filter((t) => t.assetId.chainId === caip2)
      .map((t) => ({ caip2, mint: t.assetId.reference, symbol: t.symbol })),
  ];
}

/** The look-alike sentence for `symbol` on `mint`, or null. */
export function lookAlikeFor(
  caip2: string,
  mint: string,
  symbol: string | null,
  tracked: readonly FungibleAsset[],
): string | null {
  const hit = findSolanaLookAlike(caip2, mint, symbol, lookAlikeReferences(caip2, tracked));
  return hit && symbol ? lookAlikeSentence(symbol, hit.mint) : null;
}

/**
 * Reads and classifies a mint for the Track flow (readMintProfile; its
 * refusals — no account, another program, an unreadable mint — are thrown
 * with the engine's own sentences). An uninitialized mint cannot be tracked
 * (SPL_SENTENCES.notAMint). Every other class can be tracked and shown; a
 * class the engine refuses to send carries its refusal sentence, which the
 * Track prompt and the Home row repeat.
 */
export async function previewMint(
  client: SolanaRpcClient,
  caip2: string,
  mintText: string,
  tracked: readonly FungibleAsset[],
): Promise<MintPreview> {
  const mint = mintText.trim();
  let decoded: Uint8Array;
  try {
    decoded = base58.decode(mint);
  } catch {
    throw new SplTokenRefusal('bad-mint', SPL_MINT_ADDRESS_INVALID);
  }
  if (decoded.length !== 32) throw new SplTokenRefusal('bad-mint', SPL_MINT_ADDRESS_INVALID);
  const profile = await readMintProfile(client, mint);
  if (profile.classification.transferClass === 'not-a-mint') {
    throw new SplTokenRefusal('not-a-mint', SPL_SENTENCES.notAMint);
  }
  const known = KNOWN_SOLANA_TOKENS.find((t) => t.caip2 === caip2 && t.mint === mint) ?? null;
  const fromMeta = profile.metadata?.symbol ?? null;
  const symbol = fromMeta ?? known?.symbol ?? null;
  const symbolSource = fromMeta !== null ? 'metadata' : known ? 'known' : null;
  const name = profile.metadata?.name ?? known?.name ?? null;
  return {
    caip2,
    mint,
    profile,
    symbol,
    name,
    symbolSource,
    decimals: profile.parsed.decimals,
    sendRefusal: profile.classification.refusal,
    lookAlike: lookAlikeFor(caip2, mint, symbol, tracked),
  };
}

/** The Track confirmation: the full mint, the network, a look-alike warning and a send refusal when there is one. */
export function trackPrompt(preview: Pick<MintPreview, 'mint' | 'caip2' | 'lookAlike' | 'sendRefusal'>, symbol: string): TrackPrompt {
  return {
    title: `Track ${symbol}?`,
    message:
      `Mint ${preview.mint} on ${solanaNetworkLabel(preview.caip2)}.` +
      (preview.lookAlike ? ` Warning: ${preview.lookAlike}` : '') +
      (preview.sendRefusal ? ` This token can be tracked and shown, but this wallet will not send it: ${preview.sendRefusal}` : '') +
      ' Anyone can create a token with any name and symbol; track it only if this is the mint you expect.',
    confirm: `Track ${symbol}`,
  };
}

/** The asset stored for a previewed mint: CAIP-19 "token" namespace, the mint's own decimals. */
export function trackedAssetFor(preview: Pick<MintPreview, 'caip2' | 'mint' | 'decimals'>, symbol: string, name: string): FungibleAsset {
  return solanaFungibleAsset({ caip2: preview.caip2, mint: preview.mint, symbol, name: name || symbol, decimals: preview.decimals });
}

/** The program as the screens name it. */
export function tokenProgramLabel(program: 'spl-token' | 'token-2022'): string {
  return program === 'token-2022' ? 'Token-2022 (Token Extensions)' : 'SPL Token';
}

// ---------------------------------------------------------------------------
// Home rows
// ---------------------------------------------------------------------------

/** One tracked token's row on Home. */
export type SplRowState =
  | {
      status: 'ok';
      /** The owner's associated token account balance (the sendable one); 0 when there is none. */
      associated: bigint;
      /** Base units in the owner's other token accounts of this mint (not sendable from here). */
      outside: bigint;
      outsideAccounts: number;
      /** The mint's own decimals (the display uses them). */
      decimals: number;
      /** The engine's refusal when this token cannot be sent, else null. */
      sendRefusal: string | null;
      /** True when the mint's decimals differ from the ones stored at Track time. */
      decimalsChanged: boolean;
      /** The network that answered. */
      networkChainId: string;
    }
  | { status: 'error'; message: string };

/**
 * Every tracked token's balance in one listing of the owner's token
 * accounts (listOwnerTokenAccounts: both programs, parsed from raw bytes,
 * foreign entries skipped), plus each mint's profile for its class. The
 * associated token account is the balance; anything in other accounts of
 * the same mint is counted separately and never sent from here (the
 * engine's quote sends only from the associated account).
 */
export async function loadSplTokenRows(
  client: SolanaRpcClient,
  owner: string,
  tokens: readonly FungibleAsset[],
  networkChainId: string,
): Promise<{ rows: Record<string, SplRowState>; skipped: number }> {
  const listing = await listOwnerTokenAccounts(client, owner);
  const rows: Record<string, SplRowState> = {};
  for (const token of tokens) {
    const id = formatAssetId(token.assetId);
    const mint = token.assetId.reference;
    try {
      const profile = await readMintProfile(client, mint);
      let associated = 0n;
      let outside = 0n;
      let outsideAccounts = 0;
      for (const entry of listing.accounts) {
        if (entry.account.mint !== mint) continue;
        if (entry.isAssociated) associated += entry.account.amount;
        else {
          outside += entry.account.amount;
          outsideAccounts += 1;
        }
      }
      rows[id] = {
        status: 'ok',
        associated,
        outside,
        outsideAccounts,
        decimals: profile.parsed.decimals,
        sendRefusal: profile.classification.refusal,
        decimalsChanged: profile.parsed.decimals !== token.decimals,
        networkChainId,
      };
    } catch (e) {
      rows[id] = { status: 'error', message: e instanceof Error ? e.message : 'The token could not be read.' };
    }
  }
  return { rows, skipped: listing.skipped };
}

/** The line under a row whose mint balance sits partly outside the associated account. */
export function splOutsideLine(amountDisplay: string, symbol: string, accounts: number): string {
  return (
    `Also ${amountDisplay} ${symbol} held outside the associated account ` +
    `(${accounts} other token account${accounts === 1 ? '' : 's'}), not sendable from here.`
  );
}

/** The line under a row whose token this wallet will not send. */
export function splCannotSendLine(refusal: string): string {
  return `Cannot be sent from this wallet: ${refusal}`;
}

/** The line under a row whose mint now reports other decimals than were stored. */
export function splDecimalsChangedLine(stored: number, actual: number): string {
  return (
    `The mint now reports ${actual} decimals, not the ${stored} recorded when this token was tracked. ` +
    'The balance uses the mint’s figure; a send is refused until you remove the token and track it again.'
  );
}

/** The line under the Solana rows when the listing skipped entries that failed its checks. */
export function splSkippedLine(skipped: number): string {
  return `${skipped} token account${skipped === 1 ? '' : 's'} returned by the network endpoint failed this wallet’s checks and ${skipped === 1 ? 'is' : 'are'} not shown.`;
}

// ---------------------------------------------------------------------------
// The send
// ---------------------------------------------------------------------------

/** A quoted Solana token send, with what the confirm shows. */
export interface SplSendQuote {
  caip2: string;
  owner: string;
  recipient: string;
  symbol: string;
  /** The URL the quote was read from; the transaction is sent there. */
  url: string;
  quote: SplTokenTransferQuote;
}

/**
 * Quotes a send of a tracked token. The readiness gate runs first, before
 * any request; the amount is parsed with the decimals stored at Track time;
 * then the engine's quoteSplTokenTransfer reads everything it decides on from
 * the chain (and refuses with its own sentences, including when the mint's
 * decimals no longer equal the stored ones).
 */
export async function quoteSplSend(
  client: SolanaRpcClient,
  params: { caip2: string; url: string; owner: string; recipient: string; token: FungibleAsset; amountText: string },
): Promise<SplSendQuote> {
  assertSplSendAllowed(params.caip2);
  if (params.token.assetId.chainId !== params.caip2) {
    throw new SplTokenRefusal(
      'wrong-network',
      `This token belongs to ${solanaNetworkLabel(params.token.assetId.chainId)}, not ${solanaNetworkLabel(params.caip2)}.`,
    );
  }
  let amount: bigint;
  try {
    amount = parseUnits(params.amountText, params.token.decimals);
  } catch (e) {
    // The amount parser's own sentence (balances.ts parseUnits), unchanged.
    throw new SplTokenRefusal('bad-amount', e instanceof Error ? e.message : String(e));
  }
  const quote = await quoteSplTokenTransfer(client, {
    caip2: params.caip2,
    owner: params.owner,
    recipient: params.recipient.trim(),
    mint: params.token.assetId.reference,
    amount,
    expectedDecimals: params.token.decimals,
  });
  return { caip2: params.caip2, owner: params.owner, recipient: params.recipient.trim(), symbol: params.token.symbol, url: params.url, quote };
}

/** One labelled row of the confirm view. */
export interface ConfirmRow {
  label: string;
  value: string;
}

function lamportsText(lamports: bigint, nativeSymbol: string): string {
  return `${lamports} lamports (${formatBaseUnits(lamports, 9)} ${nativeSymbol})`;
}

/** The confirm view's rows, in order. Every figure is the quote's own. */
export function splConfirmRows(q: SplSendQuote, nativeSymbol: string): ConfirmRow[] {
  const { quote } = q;
  const rows: ConfirmRow[] = [
    { label: 'From', value: q.owner },
    { label: 'To', value: q.recipient },
    { label: 'Amount', value: `${formatBaseUnits(quote.amount, quote.decimals)} ${q.symbol}` },
  ];
  if (quote.transferFee > 0n) {
    rows.push({ label: 'Issuer’s transfer fee (withheld from the amount)', value: `${formatBaseUnits(quote.transferFee, quote.decimals)} ${q.symbol}` });
    rows.push({ label: 'Recipient receives', value: `${formatBaseUnits(quote.recipientReceives, quote.decimals)} ${q.symbol}` });
  }
  rows.push({ label: 'Network fee (paid in SOL)', value: lamportsText(quote.networkFeeLamports, nativeSymbol) });
  if (quote.createsDestination) {
    rows.push({ label: 'Rent for the recipient’s new token account (paid by you)', value: lamportsText(quote.rentLamports, nativeSymbol) });
  }
  rows.push({ label: 'Total SOL leaving your account', value: lamportsText(quote.networkFeeLamports + quote.rentLamports, nativeSymbol) });
  rows.push({ label: 'Mint', value: quote.mint });
  rows.push({ label: 'Token program', value: tokenProgramLabel(quote.program) });
  rows.push({ label: 'Your token account', value: quote.sourceAccount });
  rows.push({
    label: 'Recipient’s token account',
    value: quote.createsDestination ? `${quote.destinationAccount} (created by this transaction)` : quote.destinationAccount,
  });
  return rows;
}

/**
 * The device prompt's title, worded like the SOL send's ("Approve sending
 * 0.5 SOL" — aa.ts sendApprovalPromptTitle): the quoted amount, exact.
 */
export function splApprovalPromptTitle(q: SplSendQuote): string {
  return `Approve sending ${formatBaseUnits(q.quote.amount, q.quote.decimals)} ${q.symbol}`;
}

/** The second endpoint to re-read the result on: the first default candidate that is not the one that sent, else null. */
export function secondReadUrl(sentUrl: string, defaultUrls: readonly string[]): string | null {
  return defaultUrls.find((u) => u !== sentUrl) ?? null;
}

/** What the success view says about the transaction after it was sent. */
export interface SplSendOutcome {
  signature: string;
  /** The sending endpoint's answer: confirmed, failed on-chain (with the reason), or not confirmed within the wait. */
  primary: { status: 'confirmed' } | { status: 'failed'; reason: string } | { status: 'not-confirmed'; reason: string };
  /** The re-read on another endpoint, or null when there is no other endpoint. */
  second: { url: string; status: 'seen'; confirmationStatus: string | null; failed: boolean } | { url: string; status: 'not-seen' } | { url: string; status: 'unreadable'; reason: string } | null;
}

/** The dependencies of runSplSend, injected so the check runs it with fakes. */
export interface SplSendDeps {
  /** The device check (biometric.ts requireLocalAuth). Called exactly once. */
  requireAuth: (title: string) => Promise<{ ok: true } | { ok: false; message: string }>;
  /** WalletContext.signWith: the active account's Solana key for one operation. Called exactly once. */
  signWith: <T>(chainId: string, expectAddress: string, fn: (account: DerivedAccount) => Promise<T>) => Promise<T>;
  /** The client for the quoted URL. */
  client: SolanaRpcClient;
  /** A client for the second endpoint (secondReadUrl), or null. */
  second: { url: string; client: SolanaRpcClient } | null;
  /** How long to wait for confirmation on the sending endpoint (default 60 s). */
  confirmTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** The device check was cancelled: nothing was signed or sent. */
export class SplSendCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SplSendCancelledError';
  }
}

/**
 * Signs and sends a quoted Solana token transfer: the readiness gate again,
 * ONE device check titled like the SOL send, then ONE signWith (the active
 * account's Solana key, refused by WalletContext unless it controls exactly
 * the quoted owner), which compiles the quote's instructions with a fresh
 * blockhash (the fee depends on the signature count, not the blockhash),
 * signs and broadcasts. Then the sending endpoint is asked to confirm and the
 * result is read again on a second endpoint.
 */
export async function runSplSend(deps: SplSendDeps, q: SplSendQuote): Promise<SplSendOutcome> {
  assertSplSendAllowed(q.caip2);
  const auth = await deps.requireAuth(splApprovalPromptTitle(q));
  if (!auth.ok) throw new SplSendCancelledError(auth.message);
  const signature = await deps.signWith(SOLANA_SLOT_CHAIN_ID, q.owner, async (signer) => {
    const { blockhash } = await deps.client.getLatestBlockhash('confirmed');
    const message = compileMessage({
      feePayer: signer.publicKey,
      recentBlockhash: blockhash,
      instructions: q.quote.instructions,
    });
    const signed = signTransaction(message, [{ publicKey: signer.publicKey, sign: (bytes) => signer.sign(bytes) }]);
    return deps.client.sendTransaction(signed.wireBytes);
  });
  let primary: SplSendOutcome['primary'];
  try {
    await deps.client.confirmTransaction(signature, {
      commitment: 'confirmed',
      timeoutMs: deps.confirmTimeoutMs ?? 60_000,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    });
    primary = { status: 'confirmed' };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    primary = /failed:/.test(reason) ? { status: 'failed', reason } : { status: 'not-confirmed', reason };
  }
  let second: SplSendOutcome['second'] = null;
  if (deps.second) {
    try {
      const [status] = await deps.second.client.getSignatureStatuses([signature], true);
      second = status
        ? {
            url: deps.second.url,
            status: 'seen',
            confirmationStatus: (status as SignatureStatus).confirmationStatus ?? null,
            failed: status.err !== null && status.err !== undefined,
          }
        : { url: deps.second.url, status: 'not-seen' };
    } catch (e) {
      second = { url: deps.second.url, status: 'unreadable', reason: e instanceof Error ? e.message : String(e) };
    }
  }
  return { signature, primary, second };
}

/** The success view's sentences about the result, from the outcome alone. */
export function splOutcomeLines(outcome: SplSendOutcome, hostOf: (url: string) => string): string[] {
  const lines: string[] = [];
  if (outcome.primary.status === 'confirmed') lines.push('The sending endpoint reports the transaction confirmed.');
  else if (outcome.primary.status === 'failed') lines.push(`The transaction failed on-chain. Technical detail: ${outcome.primary.reason}`);
  else lines.push(`The sending endpoint did not confirm the transaction within the wait; it may still be included. Technical detail: ${outcome.primary.reason}`);
  const s = outcome.second;
  if (s === null) lines.push('No second endpoint is configured for this network, so the result was not read again elsewhere.');
  else if (s.status === 'seen') {
    lines.push(
      s.failed
        ? `Read again on ${hostOf(s.url)}: the transaction is there and FAILED.`
        : `Read again on ${hostOf(s.url)}: the transaction is there (${s.confirmationStatus ?? 'status not given'}).`,
    );
  } else if (s.status === 'not-seen') lines.push(`Read again on ${hostOf(s.url)}: that endpoint does not list the transaction yet.`);
  else lines.push(`Read again on ${hostOf(s.url)}: that endpoint could not be read. Technical detail: ${s.reason}`);
  return lines;
}

/** A client over an https URL (the injected-transport pattern the rest of the app uses). */
export function solanaClient(url: string): SolanaRpcClient {
  return new SolanaRpcClient(httpTransport(url));
}
