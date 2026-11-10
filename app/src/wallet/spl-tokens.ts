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
  EXT,
  KNOWN_SOLANA_TOKENS,
  SOLANA_DEVNET_CAIP2,
  SOLANA_MAINNET_CAIP2,
  SPL_SENTENCES,
  SolanaRpcClient,
  SplTokenRefusal,
  compileMessage,
  decodeTransferFeeAmount,
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
  type TokenExtension,
  type TransferFeeConfig,
} from '@shiba-wallet/chains-solana';
import { isFeatureAllowed, readinessReason } from '../config/readiness.ts';
import { formatBalanceDisplay, formatUnits, parseUnits } from './balances.ts';
import { maskAmount } from '../config/prefs.ts';
import type { BroadcastRecordState, PendingSolanaRecord, SolanaTransferLike } from './pending-transactions.ts';
import type { BroadcastSpendState } from './broadcast-spend.ts';
import { t } from '../i18n/index.ts';

/**
 * The Solana slot's id: the mainnet CAIP-2 id the accounts, routes and
 * signWith carry (send.ts SOLANA_CHAIN_ID). The network actually serving the
 * slot is mainnet or devnet (config/defaults.ts resolveActiveNetworks); a
 * Solana key is the same on both, so signing always names the slot.
 */
export const SOLANA_SLOT_CHAIN_ID = SOLANA_MAINNET_CAIP2;

/**
 * True when a screen for the Solana slot shows the Solana devnet banner
 * (components/SolanaDevnetBanner.tsx; pass p24-solana finding 2): only for
 * the Solana slot (`slotChainId` is the route's chain id, the mainnet slot
 * id) and only while the "Use Solana devnet" switch is on. The Ethereum
 * network choice plays no part.
 */
export function solanaDevnetBannerShown(slotChainId: string | undefined, solanaDevnet: boolean): boolean {
  return solanaDevnet === true && slotChainId === SOLANA_SLOT_CHAIN_ID;
}

/**
 * The coin a Solana token send's network fee and rent are paid in, as the
 * screens name it on that network (pass p24-unblock findings 3 and 4): "test
 * SOL" on Solana devnet (config/defaults.ts SOLANA_DEVNET_NETWORK.symbol, the
 * symbol every devnet amount already shows), "SOL" otherwise.
 */
export function splNativeSymbol(caip2: string | null): string {
  return caip2 === SOLANA_DEVNET_CAIP2 ? 'test SOL' : 'SOL';
}

/** The Solana tokens screen's fee sentence, in the coin of the network in use. */
export function splTokensFeeSentence(caip2: string | null): string {
  return `Network fees for a token send are paid in ${splNativeSymbol(caip2)}.`;
}

/** The token-send form's opening sentence, in the coin of the network in use. */
export function splSendFormIntro(symbol: string, mint: string, networkLabel: string, nativeSymbol: string): string {
  return (
    `Sends ${symbol} (mint ${mint}) on ${networkLabel} from your associated token account. The network ` +
    `fee is paid in ${nativeSymbol}; if the recipient does not hold this token yet, this transaction also creates their token ` +
    'account and you pay its rent. Review shows every figure before anything is signed.'
  );
}

/** The token-send screen's title: the token and the network (pass p24-unblock finding 5: "Send USDC" also titles the Ethereum token send). */
export function splSendScreenTitle(symbol: string, caip2: string): string {
  return `Send ${symbol} on ${solanaNetworkLabel(caip2)}`;
}

/**
 * The balance line of a tracked token on the Solana tokens screen (pass
 * p24-unblock finding 8), read exactly as Home reads it (useSplTokens: the
 * associated token account, the one a send uses), masked by Hide amounts
 * like Home's rows; null before the balance is read.
 */
export function splManageBalanceLine(state: SplRowState | undefined, symbol: string, hidden: boolean): string | null {
  if (state === undefined) return null;
  if (state.status === 'error') return 'Balance: could not be read just now.';
  return `Balance: ${maskAmount(formatBalanceDisplay(state.associated, state.decimals), hidden)} ${symbol}`;
}

/**
 * The spoken label of a tracked token's details on the Solana tokens screen
 * (pass p24-solfix2 finding C): the lines it shows — the symbol, the name
 * and decimals, the mint, then the balance line (or "Balance hidden" under
 * Hide amounts, as the line itself is spoken) — as ONE element, so a screen
 * reader reads the balance before the row's Send and Remove buttons. As
 * separate texts TalkBack read the Send button between the mint and the
 * balance (the buttons sit beside the text column, the balance below them;
 * that TalkBack orders by position there is an inference from the pass, its
 * code is not on this machine). The mint is read in full, as on the confirm
 * screens.
 */
export function splManageRowSpokenLabel(p: {
  symbol: string;
  name: string;
  decimals: number;
  mint: string;
  balanceLine: string | null;
  balanceHidden: boolean;
}): string {
  const parts = [`${p.symbol}, ${p.name} · ${p.decimals} decimals`, `Mint ${p.mint}`];
  if (p.balanceLine !== null) parts.push(p.balanceHidden ? 'Balance hidden' : p.balanceLine.replace(/\.$/, ''));
  return `${parts.join('. ')}.`;
}

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
  /** The mint's TransferFeeConfig as the engine decoded it (classification.transferFee), else null. */
  transferFee: TransferFeeConfig | null;
}

/**
 * The read-back and Track prompt line for a mint with a TransferFeeConfig
 * (pass p24-solana finding 5), from the engine's decoded config: the rate in
 * basis points and the most it withholds per transfer, in the token's own
 * units. A rate of 0 is said as 0. A mint carries two rates (older and
 * newer); the engine applies the newer one from its epoch on
 * (transferFeeRateAt), so when they differ both are named with that epoch.
 * The fee withheld from a send is worked out again for that send and shown
 * on its confirm (quoteSplTokenTransfer).
 */
export function splTransferFeeLine(config: TransferFeeConfig, decimals: number, symbol: string | null): string {
  const amount = (v: bigint) => `${formatBaseUnits(v, decimals)}${symbol ? ` ${symbol}` : ''}`;
  const rate = (r: TransferFeeConfig['newerTransferFee']) => `${r.basisPoints} basis points (${amount(r.maximumFee)} max)`;
  const older = config.olderTransferFee;
  const newer = config.newerTransferFee;
  const same = older.basisPoints === newer.basisPoints && older.maximumFee === newer.maximumFee;
  return same
    ? `Transfer fee: ${rate(newer)} — shown again on every send.`
    : `Transfer fee: ${rate(older)} before epoch ${newer.epoch}, then ${rate(newer)} — shown again on every send.`;
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
    transferFee: profile.classification.transferFee,
  };
}

/** The Track confirmation: the full mint, the network, a look-alike warning and a send refusal when there is one. */
export function trackPrompt(
  preview: Pick<MintPreview, 'mint' | 'caip2' | 'lookAlike' | 'sendRefusal'> & Partial<Pick<MintPreview, 'transferFee' | 'decimals'>>,
  symbol: string,
): TrackPrompt {
  return {
    title: `Track ${symbol}?`,
    message:
      `Mint ${preview.mint} on ${solanaNetworkLabel(preview.caip2)}.` +
      (preview.lookAlike ? ` Warning: ${preview.lookAlike}` : '') +
      (preview.sendRefusal ? ` This token can be tracked and shown, but this wallet will not send it: ${preview.sendRefusal}` : '') +
      (preview.transferFee && preview.decimals !== undefined ? ` ${splTransferFeeLine(preview.transferFee, preview.decimals, symbol)}` : '') +
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
      /**
       * Base units held back in the associated token account as the issuer's
       * transfer fee (its TransferFeeAmount extension, decoded by the engine's
       * decodeTransferFeeAmount); 0 when the account has none. Not part of
       * `associated` and never sendable by the owner (pass p26-emu1 finding 3).
       */
      withheld: bigint;
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
      let withheld = 0n;
      let outside = 0n;
      let outsideAccounts = 0;
      for (const entry of listing.accounts) {
        if (entry.account.mint !== mint) continue;
        if (entry.isAssociated) {
          associated += entry.account.amount;
          withheld += splWithheldAmount(entry.account.extensions);
        } else {
          outside += entry.account.amount;
          outsideAccounts += 1;
        }
      }
      rows[id] = {
        status: 'ok',
        associated,
        withheld,
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

/**
 * Whether a Solana token row offers its "Send <SYM>" link (pass p24-solana
 * finding 7): only where a send is offered at all (the readiness gate gave
 * the row an onSend), the row read cleanly, the engine does not refuse the
 * class, the decimals are unchanged, and the associated token account (the
 * one a send uses) holds more than 0. At exactly 0 the link is hidden, since
 * the quote would refuse at Review with nothing to send; a balance held only
 * in other token accounts does not count, because a send never uses them.
 */
export function splSendLinkShown(state: SplRowState | undefined, sendOffered: boolean): boolean {
  return (
    sendOffered &&
    state !== undefined &&
    state.status === 'ok' &&
    state.sendRefusal === null &&
    !state.decimalsChanged &&
    state.associated > 0n
  );
}

/**
 * Whether Home's Solana card offers "Send ↗" for SOL (phase 25 item 0c; the
 * phase 24 status's follow-up "the Solana mainnet SOL card offers Send at 0
 * SOL"). The rule Home applies to a token row at a 0 balance
 * (splSendLinkShown), for the SOL balance: hidden only when the balance was
 * READ and is exactly 0 lamports, where a send could only be refused at
 * Review for want of SOL. Shown before the read and after a failed read (the
 * balance is not known to be 0 then), and at any balance above 0. Mainnet
 * and devnet alike; the Ethereum card does not use this rule.
 */
export function solSendLinkShown(state: { status: string; amount?: bigint } | undefined): boolean {
  return !(state !== undefined && state.status === 'ok' && state.amount === 0n);
}

/**
 * The amount "Max" fills in on the Solana token send's form (phase 24
 * follow-up): the owner's whole ASSOCIATED token account balance, the one
 * account a send uses (the engine's quote sends only from it), read from the
 * same row state Home reads (loadSplTokenRows). The network fee and any new
 * account's rent are paid in SOL, not in the token, so nothing is held back
 * from the token amount; the quote still refuses when the account's SOL
 * cannot cover them.
 *
 * The text is the exact balance in the mint's own decimals
 * (formatUnits with every fractional digit kept), not Home's display form:
 * formatBalanceDisplay cuts the fraction at 6 digits and shows a non-zero
 * balance below that as "< 0.000001", neither of which is the full balance
 * or a parseable amount. For a token with 6 decimals or fewer (every token
 * this wallet knows) and a balance of at least 0.000001 the two are the same
 * text. Tokens held in other token accounts of the mint are never counted.
 * A 0 balance gives "0" (Review then refuses it: "Enter an amount greater
 * than zero."). Null — Max offers nothing — before the row is read, when the
 * read failed, and when the mint now reports other decimals than were
 * stored at Track time (the amount would not parse with the stored ones and
 * the quote refuses such a send anyway).
 */
export function splMaxAmountText(state: SplRowState | undefined): string | null {
  if (state === undefined || state.status !== 'ok' || state.decimalsChanged) return null;
  return formatUnits(state.associated, state.decimals, state.decimals);
}

/** The line under the form when Max could not read the balance. */
export function splMaxUnavailableLine(state: SplRowState | undefined): string {
  if (state !== undefined && state.status === 'ok' && state.decimalsChanged) {
    return 'Max is not available: the mint now reports other decimals than were recorded when this token was tracked. Remove the token and track it again.';
  }
  return 'Max could not read this account’s token balance just now. Type the amount, or try Max again.';
}

/**
 * Reads the one row Max needs, with the same function Home's rows use
 * (loadSplTokenRows: the owner's token accounts on both programs, the
 * associated account's balance, the mint's own decimals). A failure of the
 * listing itself becomes an error row.
 */
export async function readSplMaxRow(
  client: SolanaRpcClient,
  owner: string,
  token: FungibleAsset,
  networkChainId: string,
): Promise<SplRowState> {
  try {
    const { rows } = await loadSplTokenRows(client, owner, [token], networkChainId);
    return rows[formatAssetId(token.assetId)] ?? { status: 'error', message: 'The token could not be read.' };
  } catch (e) {
    return { status: 'error', message: e instanceof Error ? e.message : 'The token could not be read.' };
  }
}

/**
 * The issuer's transfer fee withheld in a token account (pass p26-emu1
 * finding 3): the withheld_amount of its TransferFeeAmount extension, which a
 * TransferCheckedWithFee adds to the RECIPIENT's account (token-2022 at
 * 5170695d, program/src/processor.rs 570–592; the engine's
 * decodeTransferFeeAmount cites transfer_fee/mod.rs 176–181); 0 when the
 * account has no such extension. A malformed extension throws (the row is
 * then "could not be read" rather than a guessed figure).
 */
export function splWithheldAmount(extensions: readonly TokenExtension[]): bigint {
  const ext = extensions.find((e) => e.type === EXT.TransferFeeAmount);
  return ext ? decodeTransferFeeAmount(ext).withheldAmount : 0n;
}

/**
 * The line under a Solana token row whose associated account holds tokens
 * withheld as the issuer's transfer fee: the recipient of a fee-charging
 * transfer otherwise sees only the smaller amount that arrived (pass
 * p26-emu1: Account 2 read "Balance 1.98 SFEE" with nothing about the 0.02
 * SFEE withheld in its own account). The withdraw-withheld authority can
 * withdraw them and anyone can harvest them to the mint (the engine's
 * decodeTransferFeeAmount note, transfer_fee/instruction.rs 100–135); the
 * owner cannot send them.
 */
export function splWithheldLine(amountDisplay: string, symbol: string): string {
  return `${amountDisplay} ${symbol} is withheld in this token account as the issuer’s transfer fee; it is not yours to send.`;
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
    // The engine's not-enough-SOL refusal names the coin as this network's
    // screens do: "test SOL" on devnet, "SOL" on mainnet.
    nativeSymbol: splNativeSymbol(params.caip2),
  });
  return { caip2: params.caip2, owner: params.owner, recipient: params.recipient.trim(), symbol: params.token.symbol, url: params.url, quote };
}

/**
 * The Solana token send's confirm sentences about spending limits (phase 26
 * item 3b; until then the confirm said limits were for Ethereum networks
 * only, which was true while wallet/spending-policy.ts scopeKey refused any
 * chain id but eip155:<n>). Since then a Solana scope holds limits on Solana
 * tokens, keyed by mint (components/SpendingPolicyViews.tsx
 * SolanaSpendingPolicyNotice shows them): with no limit on this send's
 * token for this account and network the confirm says it is not counted
 * (splSpendingUncoveredNote); with one, it shows the limit and says the
 * network fee and rent, paid in SOL, are never counted against a token
 * limit (splSpendingFeeNote).
 */
export function splSpendingUncoveredNote(symbol: string, caip2: string): string {
  return t('spendingSol.confirm.uncovered', { symbol, network: solanaNetworkLabel(caip2) });
}

/** Beside a Solana token limit on the confirm: the fee and rent are SOL, never counted against a token limit. */
export function splSpendingFeeNote(caip2: string): string {
  return t('spendingSol.confirm.feeNote', { coin: splNativeSymbol(caip2) });
}

/** One Solana token send as the spending limits see it (spending-policy.ts SolanaSpendInput). */
export interface SplSpendInput {
  chain: string;
  owner: string;
  mint: string;
  /** The transferChecked amount, which leaves the sender's token account (the fee is SOL and is not part of it). */
  amount: bigint;
}

/** The limits' answer before the device check (spending-policy.ts SpendingCheck, structurally). */
export interface SplSpendingCheck {
  status: 'no-policy' | 'allowed' | 'blocked' | 'unreadable';
  title?: string | null;
  message?: string | null;
}

/**
 * The spending limits as runSplSend uses them (spending-policy.ts
 * solanaSpendingGate in the app): the check before the device check, the
 * count before the broadcast under the signature, its release after a
 * definite refusal when this attempt created it, the re-key when the node
 * returned another signature. An open outcome keeps the count.
 */
export interface SplSpendingGate {
  check: (input: SplSpendInput) => Promise<SplSpendingCheck>;
  record: (input: SplSpendInput, ref: string) => Promise<BroadcastSpendState>;
  release: (input: SplSpendInput, ref: string) => Promise<void>;
  accepted: (input: SplSpendInput, ref: string, acceptedRef: string) => Promise<void>;
}

/** Over a spending limit, or the limits could not be read: refused before the device check; nothing was signed. */
export class SplSpendingLimitError extends Error {
  readonly title: string;
  readonly detail: string;
  constructor(title: string, detail: string) {
    super(`${title}\n\n${detail}`);
    this.name = 'SplSpendingLimitError';
    this.title = title;
    this.detail = detail;
  }
}

/** One labelled row of the confirm view. */
export interface ConfirmRow {
  label: string;
  value: string;
}

function lamportsText(lamports: bigint, nativeSymbol: string): string {
  return `${lamports} lamports (${formatBaseUnits(lamports, 9)} ${nativeSymbol})`;
}

/**
 * The transfer-fee note beside a quote, worded with the fee's cap in the
 * token's own units ("at most 1 SFEE per transfer"), as the read-back's
 * splTransferFeeLine says "(1 SFEE max)" (pass p26-emu1 finding 4: the
 * Review showed the engine's "at most 1000000 base units per transfer").
 */
export function splFeeNoteText(basisPoints: number, maximumText: string): string {
  return (
    `The issuer charges a transfer fee of ${basisPoints} basis points (at most ${maximumText} per transfer), taken out of ` +
    'the amount the recipient receives. The issuer can change the fee; a change takes effect two epochs after it is made.'
  );
}

/**
 * The quote's notes as the Review shows them: the engine's notes unchanged,
 * except its transfer-fee note (SPL_SENTENCES.feeNote, which names the cap in
 * base units), recognised by exact equality for one of the mint's two rates
 * and re-worded by splFeeNoteText with the cap formatted in the token's own
 * decimals and the tracked symbol. The engine is not edited (packages/ stays
 * as it is); any other note, and a fee note that matches neither rate, is
 * shown as the engine wrote it.
 */
export function splQuoteNotes(q: Pick<SplSendQuote, 'symbol' | 'quote'>): string[] {
  const fee = q.quote.profile.classification.transferFee;
  if (fee === null) return [...q.quote.notes];
  const rates = [fee.olderTransferFee, fee.newerTransferFee].filter((r) => r.basisPoints !== 0);
  return q.quote.notes.map((note) => {
    const rate = rates.find((r) => note === SPL_SENTENCES.feeNote(r.basisPoints, r.maximumFee.toString()));
    return rate ? splFeeNoteText(rate.basisPoints, `${formatBaseUnits(rate.maximumFee, q.quote.decimals)} ${q.symbol}`) : note;
  });
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
  rows.push({ label: `Network fee (paid in ${nativeSymbol})`, value: lamportsText(quote.networkFeeLamports, nativeSymbol) });
  if (quote.createsDestination) {
    rows.push({ label: 'Rent for the recipient’s new token account (paid by you)', value: lamportsText(quote.rentLamports, nativeSymbol) });
  }
  rows.push({ label: `Total ${nativeSymbol} leaving your account`, value: lamportsText(quote.networkFeeLamports + quote.rentLamports, nativeSymbol) });
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
  /**
   * Called once, right after the node accepted the transaction (send.ts
   * notifySendAccepted in the app — the signal sendSol and every EVM send
   * give): Home then reloads its native rows when it regains focus, so the
   * Solana row shows the SOL the token send spent on its fee and on any new
   * token account's rent (pass p24-unblock finding 1: the SOL row stayed at
   * the old balance until a pull-to-refresh). Never called for a send that
   * was cancelled or refused.
   */
  notifyAccepted: () => void;
  /**
   * The pending registry (pending-transactions.ts
   * pendingSolanaBroadcastRecorder in the app; phase 25 item 0b): the
   * transfer is listed under "Pending on this phone" BEFORE it is handed to
   * the node, removed again only when the node refused it definitely and
   * this attempt created the record, and a send exactly like one still
   * listed is refused before any prompt. Best effort: a failure to write the
   * record never blocks the send, and a failure to read the list lets it go
   * ahead.
   */
  pending: {
    record: (record: PendingSolanaRecord) => Promise<BroadcastRecordState>;
    forget: (key: { chain: string; signature: string }) => Promise<void>;
    openLike: (like: SolanaTransferLike, nowMs: number) => Promise<PendingSolanaRecord | null>;
  };
  /**
   * The spending limits (phase 26 item 3b; spending-policy.ts
   * solanaSpendingGate in the app — the send screen always passes it). When
   * given, the send is checked before the device check (over a limit, or
   * unreadable limits: refused, nothing signed) and counted under its
   * signature before the broadcast. Absent: nothing is checked or counted.
   */
  spending?: SplSpendingGate;
  /** Clock (Unix milliseconds) for the record's sent time; Date.now by default. */
  now?: () => number;
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
 * The node gave no usable answer to sendTransaction (a dropped connection,
 * an HTTP 5xx, an answer that is not JSON-RPC): the transaction may have
 * been accepted. It is listed under "Pending on this phone" (when `listed`),
 * whose status check says what happened; this quote is never sent again.
 */
export class SplBroadcastOutcomeUnknownError extends Error {
  readonly signature: string;
  readonly listed: boolean;
  readonly technical: string;
  constructor(signature: string, listed: boolean, technical: string) {
    super(splOutcomeUnknownSentence(listed));
    this.name = 'SplBroadcastOutcomeUnknownError';
    this.signature = signature;
    this.listed = listed;
    this.technical = technical;
  }
}

/** The sentence for an open outcome (phase 25 item 0b). */
export function splOutcomeUnknownSentence(listed: boolean): string {
  return listed
    ? 'No usable answer came back from the network endpoint, so this wallet does not know whether the transaction was sent. ' +
        'It is listed under Pending on this phone, which checks it every 15 seconds; do not send it again until that list says what happened.'
    : 'No usable answer came back from the network endpoint, so this wallet does not know whether the transaction was sent, and it ' +
        'could not add it to Pending on this phone. Look the account up in a Solana block explorer before sending anything again.';
}

/** A quote whose broadcast got no usable answer is never handed over again. */
export class SplSendAlreadyHandedOverError extends Error {
  constructor() {
    super(
      'This transfer was already handed to the network endpoint once and whether it was accepted is still unknown, so it was not ' +
        'sent a second time. Check Pending on this phone; review a new send only if that list says it was dropped.',
    );
    this.name = 'SplSendAlreadyHandedOverError';
  }
}

/** The same send is still listed as pending: signing it again would make a second, separate transaction. */
export class SplSendStillPendingError extends Error {
  constructor(symbol: string) {
    super(
      `A send of the same amount of ${symbol} to the same recipient from this account is still listed under Pending on this phone. ` +
        'A Solana transaction signed again is a new transaction, so both could be included. Wait until that list says what ' +
        'happened before sending it again. Nothing was signed.',
    );
    this.name = 'SplSendStillPendingError';
  }
}

/**
 * Whether a sendTransaction failure is a definite refusal (nothing was
 * accepted, so a record this attempt created is removed). The engine's
 * Solana transport (packages/chains-solana/src/rpc.ts httpTransport) throws
 * "RPC error <code>: <message> (sendTransaction)" for a JSON-RPC error
 * answer — the node refused it, for example a failed pre-flight — and
 * "RPC HTTP error <status> for sendTransaction" for a non-2xx status. As for
 * the EVM broadcasts since phase 23 item 8, a parsed error and an HTTP 4xx
 * are definite; an HTTP 5xx, a rejected fetch and a body that is not
 * JSON-RPC are open outcomes, because the request may have reached the node.
 */
export function isDefiniteSendRefusal(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return /^RPC error -?\d+: /.test(message) || /^RPC HTTP error 4\d\d for /.test(message);
}

const handedOverQuotes = new WeakSet<SplSendQuote>();

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
  if (handedOverQuotes.has(q)) throw new SplSendAlreadyHandedOverError();
  const now = deps.now ?? Date.now;
  const like: SolanaTransferLike = {
    chain: q.caip2,
    sender: q.owner,
    mint: q.quote.mint,
    recipient: q.recipient,
    amount: q.quote.amount.toString(),
  };
  let open: PendingSolanaRecord | null = null;
  try {
    open = await deps.pending.openLike(like, now());
  } catch {
    open = null;
  }
  if (open) throw new SplSendStillPendingError(q.symbol);
  // Spending limits (phase 26 item 3b): before the device check, so a send
  // over a limit never reaches the prompt or the key.
  const spendInput: SplSpendInput = { chain: q.caip2, owner: q.owner, mint: q.quote.mint, amount: q.quote.amount };
  if (deps.spending) {
    let check: SplSpendingCheck;
    try {
      check = await deps.spending.check(spendInput);
    } catch {
      check = { status: 'unreadable', title: null, message: null };
    }
    if (check.status === 'blocked') {
      throw new SplSpendingLimitError(check.title ?? 'Over your spending limit', `${check.message ?? ''}\n\n${t('spendingSol.notSigned')}`.trim());
    }
    if (check.status === 'unreadable') {
      throw new SplSpendingLimitError(check.title ?? 'Spending limits could not be checked', check.message ?? t('spendingSol.checkFailed'));
    }
  }
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
    // Listed BEFORE the broadcast (phase 25 item 0b): an answer that never
    // arrives must still leave the transfer in "Pending on this phone".
    const record: PendingSolanaRecord = {
      kind: 'solana',
      ...like,
      signature: signed.signature,
      decimals: q.quote.decimals,
      symbol: q.symbol,
      sentAt: now(),
    };
    let state: BroadcastRecordState = 'failed';
    try {
      state = await deps.pending.record(record);
    } catch {
      state = 'failed';
    }
    // Counted against the spending limits BEFORE the broadcast, under the
    // signature (./broadcast-spend.ts rule 1); best effort: a failure to
    // write the count never blocks the send.
    let spendState: BroadcastSpendState = 'none';
    if (deps.spending) {
      try {
        spendState = await deps.spending.record(spendInput, record.signature);
      } catch {
        spendState = 'failed';
      }
    }
    let returned: string;
    try {
      returned = await deps.client.sendTransaction(signed.wireBytes);
    } catch (e) {
      if (isDefiniteSendRefusal(e)) {
        if (state === 'created') await deps.pending.forget({ chain: record.chain, signature: record.signature }).catch(() => undefined);
        // A definite refusal releases only what THIS attempt counted (rule 2).
        if (spendState === 'created') await deps.spending!.release(spendInput, record.signature).catch(() => undefined);
        throw e;
      }
      // An open outcome keeps the count (rule 3).
      handedOverQuotes.add(q);
      throw new SplBroadcastOutcomeUnknownError(record.signature, state !== 'failed', e instanceof Error ? e.message : String(e));
    }
    // Accepted: the count stays, under the signature the node returned (rule 4).
    if (deps.spending && (spendState === 'created' || spendState === 'existed') && returned !== record.signature) {
      await deps.spending.accepted(spendInput, record.signature, returned).catch(() => undefined);
    }
    return returned;
  });
  // The broadcast was accepted: balances may have moved (best effort: a
  // failing listener never affects the send that was already made).
  try {
    deps.notifyAccepted();
  } catch {
    // Listeners only refresh displays.
  }
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
