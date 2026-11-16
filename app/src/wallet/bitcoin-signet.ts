// The Bitcoin slot on SIGNET (phase 28 item 2; Settings → Developer → "Use
// Bitcoin signet", AppPrefs.bitcoinSignet, off by default). Modelled on the
// Solana devnet switch (phase 24), with one difference that shapes this
// module: a signet address is NOT the mainnet address. Signet is derived with
// coin type 1 (BIP-44's "Bitcoin Testnet" row and SLIP-44's "Testnet (all
// coins)"; packages/core/src/chains/utxo.ts bitcoinSignetKeyProvider has the
// citations), m/84'/1'/N'/0/0 for account N, so it needs the seed once and
// cannot be computed from the cached mainnet address. Keeping coin type 0'
// and re-encoding the mainnet key with HRP "tb" would have avoided that, but
// it breaks the BIP-44 / SLIP-44 convention and the repository's own testnet
// scripts (scripts/testnet/setup.mjs, smoke.mjs), and anyone shown the signet
// address could re-encode it and find the account's mainnet address.
//
// The signet address of each recovery-phrase account is kept in the same
// public-account cache as the other addresses (wallet/storage.ts; public data
// only, no prompt to read), as one extra entry under the signet CAIP-2 id. A
// wallet derived before this slice has no such entry, so its signet address
// is worked out once from the phrase (one device prompt) when the user asks;
// until then the Bitcoin row says so instead of showing a mainnet address on
// a signet endpoint. Imported, watch-only and multisig accounts have no
// Bitcoin row at all, on either network.
//
// React-free with explicit .ts extensions, so scripts/check-btc-signet.mjs runs
// this exact file under Node's type stripping.
import { bitcoinSignetKeyProvider } from '@shiba-wallet/core';
import { BITCOIN_SIGNET, type UtxoNetwork } from '@shiba-wallet/chains-utxo';
import {
  BITCOIN_MAINNET_SLOT,
  BITCOIN_SIGNET_CAIP2,
  BITCOIN_SIGNET_NETWORK,
  type NetworkDefault,
} from '../config/defaults.ts';
import { deriveForAccount, type ChainAccount } from './accounts.ts';
import { t } from '../i18n/index.ts';

/** The signet address and path of one account (public data). */
export interface SignetAddress {
  address: string;
  path: string;
}

/** A public-cache entry (wallet/storage.ts PublicChainEntry). */
export interface SignetCacheEntry {
  chainId: string;
  address: string;
  path: string;
}

/** BIP-84 P2WPKH with HRP "tb": "tb1q" and 38 more bech32 characters (a 20-byte program). */
const SIGNET_ADDRESS = /^tb1q[02-9ac-hj-np-z]{38}$/;
const SIGNET_PATH = /^m\/84'\/1'\/[0-9]+'\/0\/0$/;

/**
 * Derives account `accountIndex`'s signet address from a seed, through the
 * same account mapping as Bitcoin mainnet (wallet/accounts.ts
 * derivationArgsFor: account N, address index 0). Only the address and the
 * path leave this function; the caller owns and zeroes the seed.
 */
export function deriveSignetAddress(seed: Uint8Array, accountIndex: number): SignetAddress {
  const derived = deriveForAccount(bitcoinSignetKeyProvider, seed, accountIndex);
  return { address: derived.address, path: derived.path };
}

/** The cache entry for a signet address (stored beside the launch chains' entries). */
export function signetCacheEntry(signet: SignetAddress): SignetCacheEntry {
  return { chainId: BITCOIN_SIGNET_CAIP2, address: signet.address, path: signet.path };
}

/**
 * The signet address in an account's cached entries, or null when there is
 * none or it is not a well-formed signet address and path (a malformed entry
 * is ignored, never shown: the address is worked out again instead).
 */
export function signetAddressFromCache(entries: readonly SignetCacheEntry[] | null): SignetAddress | null {
  const entry = entries?.find((e) => e.chainId === BITCOIN_SIGNET_CAIP2);
  if (!entry || !SIGNET_ADDRESS.test(entry.address) || !SIGNET_PATH.test(entry.path)) return null;
  return { address: entry.address, path: entry.path };
}

/**
 * The active account's rows as every screen sees them. With the switch off
 * the rows are returned unchanged (the same array). With it on, the Bitcoin
 * row keeps its slot id (accounts, routes and the per-slot UI keep matching,
 * as for Solana devnet) but carries the signet address and path, and the
 * signet network's name and coin ("Bitcoin signet", "test BTC"), so every
 * screen that names the row by its name and symbol (Receive's network line,
 * title and payment request, Activity's title, the Send title, amount label
 * and recipient placeholder) names signet without a change of its own; when the
 * signet address is not known yet the Bitcoin row is left out and `pending`
 * is true, so no screen can show or query the mainnet address on signet.
 * Accounts without a Bitcoin row (imported, watch-only, multisig) are
 * unaffected and never pending.
 */
export function withBitcoinSignetRow(
  rows: ChainAccount[],
  on: boolean,
  signet: SignetAddress | null | undefined,
): { rows: ChainAccount[]; pending: boolean } {
  if (!on) return { rows, pending: false };
  const at = rows.findIndex((r) => r.chainId === BITCOIN_MAINNET_SLOT);
  if (at === -1) return { rows, pending: false };
  if (!signet) return { rows: rows.filter((_, i) => i !== at), pending: true };
  return {
    rows: rows.map((r, i) =>
      i === at
        ? { ...r, name: BITCOIN_SIGNET_NETWORK.label, symbol: BITCOIN_SIGNET_NETWORK.symbol, address: signet.address, path: signet.path }
        : r,
    ),
    pending: false,
  };
}

/**
 * The text of a chain badge: the symbol without the "test " that only the
 * signet row's symbol carries ("test BTC" → "BTC"), so the round badge keeps
 * three letters; every other symbol unchanged.
 */
export function badgeSymbol(symbol: string): string {
  return symbol.startsWith('test ') ? symbol.slice('test '.length) : symbol;
}

/** The network serving a slot's Bitcoin row: Bitcoin signet while the switch is on, else null (the slot's own). */
export function bitcoinSignetNetworkFor(slotChainId: string | undefined, on: boolean): NetworkDefault | null {
  return on && slotChainId === BITCOIN_MAINNET_SLOT ? BITCOIN_SIGNET_NETWORK : null;
}

/** Whether the signet banner is drawn on a screen of this slot (the Bitcoin screens while the switch is on). */
export function bitcoinSignetBannerShown(slotChainId: string | undefined, on: boolean): boolean {
  return bitcoinSignetNetworkFor(slotChainId, on) !== null;
}

/**
 * The chain id a UTXO send is signed for: Bitcoin signet when the endpoint
 * that quoted it is signet's, else the route's slot. The signer check in
 * wallet/accounts.ts deriveSignerFor then refuses unless the derived key
 * controls exactly the quoted address, so a quote made on one network can
 * never be signed with the other network's key.
 */
export function utxoSignChainFor(routeChainId: string, endpointChainId: string | null | undefined): string {
  return routeChainId === BITCOIN_MAINNET_SLOT && endpointChainId === BITCOIN_SIGNET_CAIP2 ? BITCOIN_SIGNET_CAIP2 : routeChainId;
}

/**
 * The UTXO address parameters a quote uses: Bitcoin signet's (the engine's
 * BITCOIN_SIGNET, HRP "tb") when the endpoint serving it is signet's, else the
 * slot's own network unchanged.
 */
export function utxoNetworkForEndpoint(endpointChainId: string | null | undefined, slotNetwork: UtxoNetwork): UtxoNetwork {
  return endpointChainId === BITCOIN_SIGNET_CAIP2 ? BITCOIN_SIGNET : slotNetwork;
}

/**
 * Whether Bitcoin MAINNET's Send form says which network the send is on and
 * what the app-wide TESTNET banner is about (pass p27-emu2 finding 9). That
 * banner (App.tsx TestnetBanner) is drawn on every screen, by design, while
 * an Ethereum test network is chosen in Settings → Developer, so on the
 * Bitcoin mainnet form it sat under a send of real funds. The note is shown
 * only when the route is the Bitcoin slot, the endpoint serving it is Bitcoin
 * mainnet (never on signet, which has its own banner), and the Ethereum test
 * banner is up. Dogecoin and Solana are untouched.
 */
export function bitcoinMainnetSendNoteShown(
  routeChainId: string,
  endpointChainId: string | null | undefined,
  evmTestBannerShown: boolean,
): boolean {
  return evmTestBannerShown && routeChainId === BITCOIN_MAINNET_SLOT && endpointChainId === BITCOIN_MAINNET_SLOT;
}

/**
 * The non-EVM addresses of a NON-active phrase account read from the public
 * cache (Portfolio): the Bitcoin slot carries the signet address while the
 * switch is on, and is left out when that address is not cached, never the
 * mainnet one. With the switch off, exactly the old mapping (the signet entry
 * itself never appears under any slot).
 */
export function cachedSlotAddresses(
  entries: readonly SignetCacheEntry[] | null,
  options: { bitcoinSignet: boolean; evmSlot: string },
): Record<string, string> | null {
  if (!entries) return null;
  const out: Record<string, string> = {};
  for (const e of entries) {
    if (e.chainId === options.evmSlot || e.chainId === BITCOIN_SIGNET_CAIP2) continue;
    out[e.chainId] = e.address;
  }
  if (options.bitcoinSignet && out[BITCOIN_MAINNET_SLOT] !== undefined) {
    const signet = signetAddressFromCache(entries);
    if (signet) out[BITCOIN_MAINNET_SLOT] = signet.address;
    else delete out[BITCOIN_MAINNET_SLOT];
  }
  return out;
}

/** The English device-prompt title (prompt titles stay English, as every other prompt does). */
export const BITCOIN_SIGNET_DERIVE_PROMPT = 'Work out your Bitcoin signet addresses';

export const bitcoinSignetText = {
  switchLabel: () => t('settings.btcSignet.label'),
  offNote: () => t('settings.btcSignet.offNote'),
  onNote: () => t('settings.btcSignet.onNote'),
  banner: () => t('banner.btcSignet'),
  cardLine: () => t('home.btcSignet.cardLine'),
  pending: () => t('home.btcSignet.pending'),
  deriveButton: () => t('home.btcSignet.derive'),
  deriveFailed: (reason: string) => t('home.btcSignet.deriveFailed', { reason }),
  receivePending: () => t('receive.btcSignet.pending'),
  mainnetSendNote: () => t('send.btc.mainnetNote'),
};
