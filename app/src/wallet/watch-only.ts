// Watch-only accounts (Tier 1 feature 10): follow any Ethereum address with
// no key. Pure functions and screen copy, kept free of React Native so
// scripts/check-watch-only.mjs runs this exact file under Node's type
// stripping (hence the explicit .ts extensions on relative imports).
//
// What a watch-only account is: an EVM address the user typed, pasted or
// scanned, stored in EIP-55 form with a name in the account store
// (./accounts.ts) and NOTHING else. There is no key for it in secure
// storage, in the imported-key vault or anywhere in memory, so the wallet
// can show its balances, tokens, history and NFTs but can never sign or send
// for it. Its id range (./account-ids.ts) is refused by every derivation
// and imported-key helper, and WalletContext.signWith refuses it before
// anything is read (assertAccountCanSign).

import { EVM_CHAIN_ID, validateRecipient } from './send.ts';
import { extractScannedAddress } from './scan.ts';
import { watchOnlyDuplicateError } from './accounts.ts';

export {
  WATCH_ONLY_NOTICE,
  WATCH_ONLY_NO_CHAIN,
  WATCH_ONLY_SIGN_REFUSAL,
  WATCH_ONLY_NAME_SUFFIX,
} from './account-ids.ts';

/** An account the new watch-only address is checked against (public data only). */
export interface KnownAccount {
  /** The name as every screen shows it (with its suffix for imported and watch-only accounts). */
  name: string;
  /** Its Ethereum address, or null when it is not known without the phrase. */
  evmAddress: string | null;
  kind: 'phrase' | 'imported' | 'watch-only';
}

export type WatchAddressCheck =
  | {
      ok: true;
      /** EIP-55 form, as stored. */
      address: string;
      /** validateRecipient's note, e.g. that an all-lowercase address was given a checksum. */
      note?: string;
    }
  | { ok: false; error: string };

/** Refusal when the address is one of the wallet's own accounts. */
export function watchOnlyOwnAccountError(name: string, address: string): string {
  return (
    `This address is already one of your accounts: ${name} (${address}). The wallet holds its key, so ` +
    'there is nothing to watch.'
  );
}

/**
 * Validates a watch-only address and refuses one already in the wallet.
 *
 *  - Validation is the send flow's own validateRecipient for the EVM slot
 *    (engine-backed EIP-55 through core's toChecksumAddress): a wrong
 *    checksum is refused, an all-lowercase or all-uppercase address is
 *    accepted and stored in EIP-55 form. Nothing else is accepted.
 *  - An address equal (over the 20 bytes) to a recovery-phrase or imported
 *    account is refused ("this address is already one of your accounts"),
 *    and one already watched is refused as a duplicate.
 *
 * Only phrase accounts whose address is known can be checked; a phrase
 * account the user has not added yet cannot be recognised without
 * deriving every possible index (the key import has the same known gap).
 */
export function checkWatchAddress(raw: string, known: readonly KnownAccount[]): WatchAddressCheck {
  const validation = validateRecipient(EVM_CHAIN_ID, raw);
  if (!validation.ok) return { ok: false, error: validation.error };
  const address = validation.normalized;
  const lower = address.toLowerCase();
  const match = known.find((a) => a.evmAddress !== null && a.evmAddress.toLowerCase() === lower);
  if (match) {
    if (match.kind === 'watch-only') return { ok: false, error: watchOnlyDuplicateError(match.name, address) };
    return { ok: false, error: watchOnlyOwnAccountError(match.name, address) };
  }
  return validation.note ? { ok: true, address, note: validation.note } : { ok: true, address };
}

/**
 * A scanned QR payload as an address candidate: only the "ethereum:" scheme
 * (EIP-681) is stripped, exactly as on the Send screen; anything else is
 * returned trimmed, so checkWatchAddress refuses it with its normal error.
 * Scanning never widens validation.
 */
export function watchAddressFromScan(payload: string): string {
  return extractScannedAddress(EVM_CHAIN_ID, payload);
}

/**
 * The note shown when a newly added recovery-phrase account turns out to
 * have the address of a watch-only account (the user watched one of their
 * own phrase addresses before adding that account). The phrase account is
 * added either way (an index is never reused); the watch-only entry is now
 * redundant. Null when nothing matches.
 */
export function phraseAccountSameAsWatchedNote(
  added: { name: string; evmAddress: string | null },
  watched: readonly { name: string; evmAddress: string | null }[],
): string | null {
  if (!added.evmAddress) return null;
  const lower = added.evmAddress.toLowerCase();
  const match = watched.find((w) => w.evmAddress?.toLowerCase() === lower);
  if (!match) return null;
  return (
    `${added.name} comes from your recovery phrase and has the same address (${added.evmAddress}) as ` +
    `${match.name}. The wallet now holds this address's key, so you can remove the watch-only entry in ` +
    'Settings → Accounts.'
  );
}

/** Title of that note. */
export const PHRASE_ACCOUNT_WAS_WATCHED_TITLE = 'You were watching this address';

// ---------------------------------------------------------------------------
// Which screens a watch-only account may open
// ---------------------------------------------------------------------------

/**
 * Routes that work for a watch-only account: they only READ public data by
 * address (balances, tokens, history, NFTs) or manage the wallet itself
 * (Settings, contacts, adding accounts). It is an allow list on purpose:
 * every other route, including any route added later, is refused for a
 * watch-only account by the route gate (components/WatchOnlyGate.tsx)
 * before the screen mounts, i.e. before any network request or prompt.
 *
 * Not on the list yet, with the reason:
 *  - Receive: it also offers Send, payment requests, "Prove you own this
 *    address" and the smart-account box, none of which apply.
 *  - Approvals: its Revoke buttons quote, prompt and sign; a read-only
 *    form needs a guard inside ApprovalsScreen.
 */
export const WATCH_ONLY_ALLOWED_ROUTES: readonly string[] = [
  'Home',
  'Activity',
  'Nfts',
  'NftDetail',
  'Tokens',
  'Approvals',
  'Settings',
  'Contacts',
  'ImportKey',
];

/** Plain names for the refusal sentence; a route not named here is called "This screen". */
const ROUTE_FEATURES: Record<string, string> = {
  Send: 'Sending',
  Swap: 'Swapping',
  Receive: 'The receive screen',
  Approvals: 'Revoking token approvals',
  UpgradeAccount: 'The account upgrade',
  Sessions: 'Session keys',
  Guardians: 'Guardians',
  Passkey: 'A passkey signer',
  ProveOwnership: 'Proof of ownership',
  OwnerRotation: 'Changing a smart account owner',
  ApproveRecovery: 'Approving a recovery',
  RecoverAccount: 'Recovering an account',
  Connections: 'WalletConnect',
  SpendingLimits: 'Spending limits',
};

/**
 * The refusal sentence for opening `routeName` while a watch-only account
 * is active, or null when the route is allowed.
 */
export function watchOnlyRouteRefusal(routeName: string): string | null {
  if (WATCH_ONLY_ALLOWED_ROUTES.includes(routeName)) return null;
  const feature = ROUTE_FEATURES[routeName] ?? 'This screen';
  return (
    `${feature} is not available for a watch-only account: the wallet holds no key for this address, ` +
    'so it cannot sign or send anything for it. Switch to one of your own accounts to use it.'
  );
}

/** WalletConnect's refusal while a watch-only account is active (applied in WalletConnectContext). */
export const WATCH_ONLY_WC_REFUSAL =
  'WalletConnect connections are not offered for a watch-only account: the wallet holds no key for ' +
  'this address, so it could not sign anything a dApp asks for. Switch to one of your own accounts to ' +
  'connect.';

/**
 * The address WalletConnect may approve sessions with and serve requests
 * for: the active account's EVM address, or null for a watch-only account
 * (or none), which makes the controller decline requests and the provider
 * refuse proposals.
 */
export function walletConnectAddressFor(
  activeAccount: { watchOnly: boolean } | null,
  evmAddress: string | null,
): string | null {
  if (!activeAccount || activeAccount.watchOnly) return null;
  return evmAddress;
}

// ---------------------------------------------------------------------------
// Screen copy (pinned by scripts/check-watch-only.mjs)
// ---------------------------------------------------------------------------

/** The Settings → Accounts introduction to the add form. */
export const WATCH_ADDRESS_INTRO =
  'Follow any Ethereum address without its key: its balances, tokens, activity and NFTs appear like an ' +
  'account’s, but the wallet cannot send, sign or recover anything for it.';

/** Said once on the add form: watching an address is visible to the services that answer for it. */
export const WATCH_ADDRESS_PRIVACY_NOTE =
  'Watching an address reveals your interest in it to the network endpoints and indexers this wallet ' +
  'uses (Settings → Network endpoints and the history and NFT indexers), because the wallet asks them ' +
  'about this address.';

/** The account lists' sentence when watch-only accounts exist. */
export const WATCH_ONLY_LIST_HINT =
  'Watch-only accounts are addresses this wallet follows without a key; your recovery phrase has ' +
  'nothing to back up for them.';

export const REMOVE_WATCH_ONLY_TITLE = 'Stop watching this address?';

export function removeWatchOnlyMessage(name: string, address: string): string {
  return (
    `${name} (${address}) is removed from this wallet. Nothing secret is deleted, because the wallet ` +
    'never held a key for it, and nothing on-chain changes. You can watch it again at any time.'
  );
}

/** Home's footer for a watch-only account. */
export function watchOnlyFooterText(name: string): string {
  return (
    `${name} is an address you watch; this wallet holds no key for it, so it cannot send, swap or sign ` +
    'for it. Balances come from the RPC endpoints in Settings; pull down to refresh. Activity and NFTs ' +
    'read this address from the indexers in Settings.'
  );
}
