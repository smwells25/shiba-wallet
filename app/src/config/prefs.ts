import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * App preferences (phase 4, items 5 + 6): the Sepolia developer-mode flag,
 * the balance-privacy toggle, and the auto-lock threshold. All three are
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
  /** Sepolia developer mode (item 6). Off = Ethereum mainnet everywhere. */
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
}

export const DEFAULT_PREFS: AppPrefs = {
  sepolia: false,
  hideAmounts: false,
  autoLockMs: null,
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
  return {
    sepolia: typeof p.sepolia === 'boolean' ? p.sepolia : DEFAULT_PREFS.sepolia,
    hideAmounts:
      typeof p.hideAmounts === 'boolean' ? p.hideAmounts : DEFAULT_PREFS.hideAmounts,
    autoLockMs: autoLockOk ? (p.autoLockMs as number | null) : DEFAULT_PREFS.autoLockMs,
  };
}

/** Loads the preferences, falling back to defaults on any storage problem. */
export async function loadPrefs(store: KeyValueStore = AsyncStorage): Promise<AppPrefs> {
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
  const next = sanitize({ ...current, ...patch });
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
