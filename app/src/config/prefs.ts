import AsyncStorage from '@react-native-async-storage/async-storage';
// Explicit .ts extension: scripts/check-devmode.mjs loads this module under
// Node's type stripping, which resolves relative specifiers literally.
import { EVM_SEPOLIA, isCustomNetworkId, isTestProfileId, type EvmNetworkChoice, type TestNetworkId } from './evm-chain.ts';
import { ensureCustomNetworksLoaded } from '../wallet/custom-networks.ts';

/**
 * App preferences (phase 4, items 5 + 6; phase 6, item 2; phase 10, item
 * 3): the developer test-network choice, the balance-privacy toggle, the
 * auto-lock threshold,
 * the fiat-display toggle and the app-wide screen protection (phase 17). All of them are
 * plain configuration, not secrets, so they live in AsyncStorage like the
 * endpoint overrides (config/networks.ts) — never in the secure store,
 * which holds only the mnemonic (wallet/storage.ts).
 *
 * Every function takes an injectable KeyValueStore so
 * scripts/check-devmode.mjs can exercise the exact store logic under Node
 * with an in-memory map (the aa.ts / tokens.ts pattern). Corrupt JSON or
 * unavailable storage falls back to the defaults without overwriting the
 * stored value.
 */

/** Structural copy of wallet/tokens.ts's KeyValueStore (AsyncStorage fits). */
export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

const PREFS_KEY = 'shiba-wallet.prefs.v1';

export interface AppPrefs {
  /**
   * The Developer network choice (phase 10, item 3; feature 33): null =
   * Ethereum mainnet everywhere, otherwise the CAIP-2 id of the test profile
   * in use (config/evm-chain.ts EVM_TEST_PROFILES) or of a network the user
   * added (wallet/custom-networks.ts). The field keeps its old name; a
   * custom network may be a MAIN network — whether the active network is a
   * test network is the profile's `testnet` flag (evmProfileFor), never this
   * field.
   */
  testNetwork: EvmNetworkChoice | null;
  /**
   * Always equal to `testNetwork !== null`: true while the EVM slot is on any
   * network other than Ethereum mainnet. The name dates from phase 4, when
   * Sepolia was the only other network; it is kept (and still stored) so
   * installs from before `testNetwork` keep working. Migration: a stored
   * `sepolia: true` without `testNetwork` reads as Sepolia. It does NOT mean
   * "test funds" once a custom main network is chosen; screens that say
   * "test" read evmChain.testnet.
   */
  sepolia: boolean;
  /** Mask all displayed amounts as •••• (item 5.2). */
  hideAmounts: boolean;
  /**
   * Auto-lock threshold in milliseconds, or null for off (item 5.1). The
   * app locks behind the biometric gate when it returns from background
   * after at least this long. Only meaningful on devices where
   * localAuthAvailable() is true — Settings hides the option otherwise.
   */
  autoLockMs: number | null;
  /**
   * Show fiat (USD) values next to crypto amounts (phase 6, item 2).
   * Default ON. Prices come from CoinGecko (wallet/prices.ts); turning this
   * off stops every price request — the price hook checks it before any
   * network call, so with it off CoinGecko is never contacted.
   */
  showFiat: boolean;
  /**
   * App-wide screen protection (phase 17 item 0; the Chairperson's decision
   * of 2026-10-10). Default ON: the whole app is protected from screenshots,
   * screen recording and the app-switcher preview (wallet/screen-protection.ts
   * applies it). Turning it off releases only the app-wide protection; the
   * screens that show the recovery phrase or a private key keep their own.
   * Any stored value that is not a boolean reads as ON.
   */
  screenProtection: boolean;
  /**
   * Local reminders (phase 17 item 2; wallet/notifications.ts). Default OFF:
   * a notification is an opt-in. Only an explicit stored `true` reads as on.
   */
  notifications: boolean;
}

export const DEFAULT_PREFS: AppPrefs = {
  testNetwork: null,
  sepolia: false,
  hideAmounts: false,
  autoLockMs: null,
  showFiat: true,
  screenProtection: true,
  notifications: false,
};

/** The selectable auto-lock thresholds: off, 1 minute, 5 minutes. */
export const AUTO_LOCK_CHOICES: { label: string; ms: number | null }[] = [
  { label: 'Off', ms: null },
  { label: '1 min', ms: 60_000 },
  { label: '5 min', ms: 300_000 },
];

function sanitize(parsed: unknown): AppPrefs {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ...DEFAULT_PREFS };
  }
  const p = parsed as Record<string, unknown>;
  const autoLockOk =
    p.autoLockMs === null || AUTO_LOCK_CHOICES.some((c) => c.ms === p.autoLockMs);
  const testNetwork = sanitizeTestNetwork(p);
  return {
    testNetwork,
    sepolia: testNetwork !== null,
    hideAmounts:
      typeof p.hideAmounts === 'boolean' ? p.hideAmounts : DEFAULT_PREFS.hideAmounts,
    autoLockMs: autoLockOk ? (p.autoLockMs as number | null) : DEFAULT_PREFS.autoLockMs,
    showFiat: typeof p.showFiat === 'boolean' ? p.showFiat : DEFAULT_PREFS.showFiat,
    screenProtection:
      typeof p.screenProtection === 'boolean' ? p.screenProtection : DEFAULT_PREFS.screenProtection,
    notifications: p.notifications === true,
  };
}

/**
 * The network choice from stored (or patched) preferences:
 *  - a recognised test profile id in `testNetwork` wins;
 *  - so does the id of a REGISTERED custom network (feature 33; loadPrefs
 *    hydrates the registry before this runs, so a stored custom choice is
 *    recognised); the id of a custom network that is no longer registered
 *    is treated like any other unknown id below;
 *  - `testNetwork: null` means mainnet;
 *  - otherwise (no `testNetwork` field — an install from before Base Sepolia
 *    existed — or an id this build does not know) the legacy boolean
 *    decides: `sepolia: true` → Sepolia, anything else → mainnet. A damaged
 *    id therefore never moves a test-mode user onto mainnet while the
 *    stored boolean still says test mode.
 */
function sanitizeTestNetwork(p: Record<string, unknown>): EvmNetworkChoice | null {
  if (isTestProfileId(p.testNetwork)) return p.testNetwork;
  if (isCustomNetworkId(p.testNetwork)) return p.testNetwork;
  if (p.testNetwork === null) return null;
  return p.sepolia === true ? (EVM_SEPOLIA.caip2 as TestNetworkId) : null;
}

/**
 * Loads the preferences, falling back to defaults on any storage problem.
 *
 * It first makes sure the custom-network registry (config/evm-chain.ts) is
 * hydrated from the same store (wallet/custom-networks.ts
 * ensureCustomNetworksLoaded: read once per store, then kept in step by
 * that module's own writes), so a stored custom-network choice is
 * recognised here and every caller that resolves the active network from
 * these preferences — evmProfileFor, config/networks.ts, wallet/tokens.ts —
 * already sees the custom profiles. This is the single read path.
 */
export async function loadPrefs(store: KeyValueStore = AsyncStorage): Promise<AppPrefs> {
  await ensureCustomNetworksLoaded(store);
  try {
    const raw = await store.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    return sanitize(JSON.parse(raw) as unknown);
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/** Merges a partial update into the stored preferences and returns the result. */
export async function savePrefs(
  patch: Partial<AppPrefs>,
  store: KeyValueStore = AsyncStorage,
): Promise<AppPrefs> {
  const current = await loadPrefs(store);
  const merged: Record<string, unknown> = { ...current, ...patch };
  if (patch.testNetwork === undefined && typeof patch.sepolia === 'boolean') {
    // A boolean-only patch (the original Sepolia toggle's setter): off means
    // mainnet; on keeps the test network already chosen, else Sepolia.
    merged.testNetwork = patch.sepolia ? (current.testNetwork ?? EVM_SEPOLIA.caip2) : null;
  }
  // When both are given, testNetwork wins and `sepolia` is re-derived from it.
  const next = sanitize(merged);
  await store.setItem(PREFS_KEY, JSON.stringify(next));
  return next;
}

/**
 * Balance-privacy mask (item 5.2): every amount display goes through this
 * helper so the masked form is uniform. The symbol/ticker next to an
 * amount stays visible — hiding WHICH asset a row is would make the list
 * unusable; hiding HOW MUCH is the point.
 */
export function maskAmount(display: string, hidden: boolean): string {
  return hidden ? '••••' : display;
}
