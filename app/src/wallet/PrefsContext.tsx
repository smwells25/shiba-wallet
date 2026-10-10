import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { AppPrefs, DEFAULT_PREFS, loadPrefs, savePrefs } from '../config/prefs';
import {
  customEvmProfiles,
  evmProfileFor,
  subscribeCustomEvmProfiles,
  type EvmChainProfile,
  type EvmNetworkChoice,
} from '../config/evm-chain';

/**
 * React side of the app preferences (config/prefs.ts): one provider so
 * every screen reacts immediately when the Settings toggles change —
 * the Sepolia banner, the Home privacy mask and the lock threshold all
 * update without a restart. Non-React modules keep reading the same
 * AsyncStorage state through loadPrefs (e.g. config/networks.ts), and the
 * setters here persist first, then update React state, so the two views
 * never disagree for longer than one in-flight write.
 */
interface PrefsContextValue {
  /** False until the stored preferences finished loading. */
  ready: boolean;
  /**
   * True while the active EVM network is a TEST network: equal to
   * evmChain.testnet. For the built-in profiles this is exactly the stored
   * AppPrefs.sepolia (any test network chosen); for a network the user
   * added (feature 33) it is true only when that network counts as a test
   * network, NOT merely because a non-mainnet choice is stored — the
   * TESTNET banner (App.tsx) and the price requests (Home) key off this
   * value, and a custom MAIN network must never be called test mode.
   */
  sepolia: boolean;
  /** The chosen network's CAIP-2 id (a test profile or a custom network), or null for mainnet. */
  testNetwork: EvmNetworkChoice | null;
  /**
   * The networks the user added (feature 33, wallet/custom-networks.ts), in
   * the order they were added; updated whenever one is added or removed.
   */
  customNetworks: readonly EvmChainProfile[];
  hideAmounts: boolean;
  autoLockMs: number | null;
  /** Show fiat values (default on); off means no price request is made. */
  showFiat: boolean;
  /**
   * App-wide screen protection (default on; wallet/screen-protection.ts).
   * Only meaningful once `ready` is true: before that the root protects the
   * app whatever this says.
   */
  screenProtection: boolean;
  /** Local reminders (default off; wallet/notifications.ts). */
  notifications: boolean;
  /**
   * The active EVM chain profile — THE config source screens use for
   * chain-id verification, explorer links, badges and AA prefill
   * (config/evm-chain.ts). Derived from `testNetwork`.
   */
  evmChain: EvmChainProfile;
  /** Legacy on/off: on keeps the chosen test network (Sepolia if none), off = mainnet. */
  setSepolia: (on: boolean) => Promise<void>;
  /** Chooses the network: a test profile or a custom network (null = mainnet). */
  setTestNetwork: (network: EvmNetworkChoice | null) => Promise<void>;
  setHideAmounts: (on: boolean) => Promise<void>;
  setAutoLockMs: (ms: number | null) => Promise<void>;
  setShowFiat: (on: boolean) => Promise<void>;
  setScreenProtection: (on: boolean) => Promise<void>;
  setNotifications: (on: boolean) => Promise<void>;
}

const PrefsContext = createContext<PrefsContextValue | null>(null);

export function PrefsProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [prefs, setPrefs] = useState<AppPrefs>({ ...DEFAULT_PREFS });
  // The custom-network registry (config/evm-chain.ts) as React state. It is
  // hydrated by loadPrefs below before `ready`; afterwards every add,
  // removal or reset in wallet/custom-networks.ts updates the registry and
  // this listener re-reads the preferences too, because a removal or reset
  // may have moved the choice back to mainnet.
  const [customNetworks, setCustomNetworks] = useState<readonly EvmChainProfile[]>(() => customEvmProfiles());

  useEffect(
    () =>
      subscribeCustomEvmProfiles(() => {
        setCustomNetworks(customEvmProfiles());
        loadPrefs().then(setPrefs, () => undefined);
      }),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    loadPrefs().then(
      (p) => {
        if (!cancelled) {
          setPrefs(p);
          setCustomNetworks(customEvmProfiles());
          setReady(true);
        }
      },
      () => {
        if (!cancelled) setReady(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const patch = useCallback(async (update: Partial<AppPrefs>) => {
    // Persist first, then reflect in React state, so storage-reading code
    // (config/networks.ts) already sees the new value when screens rerender.
    const next = await savePrefs(update);
    setPrefs(next);
  }, []);

  const value = useMemo<PrefsContextValue>(
    () => ({
      ready,
      sepolia: evmProfileFor(prefs.testNetwork).testnet,
      testNetwork: prefs.testNetwork,
      hideAmounts: prefs.hideAmounts,
      autoLockMs: prefs.autoLockMs,
      showFiat: prefs.showFiat,
      screenProtection: prefs.screenProtection,
      notifications: prefs.notifications,
      customNetworks,
      // customNetworks is in the dependency list so a change to a custom
      // network's profile re-resolves the active one.
      evmChain: evmProfileFor(prefs.testNetwork),
      setSepolia: (on) => patch({ sepolia: on }),
      setTestNetwork: (network) => patch({ testNetwork: network }),
      setHideAmounts: (on) => patch({ hideAmounts: on }),
      setAutoLockMs: (ms) => patch({ autoLockMs: ms }),
      setShowFiat: (on) => patch({ showFiat: on }),
      setScreenProtection: (on) => patch({ screenProtection: on }),
      setNotifications: (on) => patch({ notifications: on }),
    }),
    [ready, prefs, patch, customNetworks],
  );

  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

export function usePrefs(): PrefsContextValue {
  const ctx = useContext(PrefsContext);
  if (!ctx) throw new Error('usePrefs must be used inside PrefsProvider');
  return ctx;
}
