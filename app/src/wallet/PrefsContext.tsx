import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { AppPrefs, DEFAULT_PREFS, loadPrefs, savePrefs } from '../config/prefs';
import { evmProfileFor, type EvmChainProfile, type TestNetworkId } from '../config/evm-chain';

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
  /** True while any test network is chosen (see AppPrefs.sepolia). */
  sepolia: boolean;
  /** The chosen test network's CAIP-2 id, or null for mainnet. */
  testNetwork: TestNetworkId | null;
  hideAmounts: boolean;
  autoLockMs: number | null;
  /** Show fiat values (default on); off means no price request is made. */
  showFiat: boolean;
  /**
   * The active EVM chain profile — THE config source screens use for
   * chain-id verification, explorer links, badges and AA prefill
   * (config/evm-chain.ts). Derived from `testNetwork`.
   */
  evmChain: EvmChainProfile;
  /** Legacy on/off: on keeps the chosen test network (Sepolia if none), off = mainnet. */
  setSepolia: (on: boolean) => Promise<void>;
  /** Chooses the test network (null = mainnet). */
  setTestNetwork: (network: TestNetworkId | null) => Promise<void>;
  setHideAmounts: (on: boolean) => Promise<void>;
  setAutoLockMs: (ms: number | null) => Promise<void>;
  setShowFiat: (on: boolean) => Promise<void>;
}

const PrefsContext = createContext<PrefsContextValue | null>(null);

export function PrefsProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [prefs, setPrefs] = useState<AppPrefs>({ ...DEFAULT_PREFS });

  useEffect(() => {
    let cancelled = false;
    loadPrefs().then(
      (p) => {
        if (!cancelled) {
          setPrefs(p);
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
      sepolia: prefs.sepolia,
      testNetwork: prefs.testNetwork,
      hideAmounts: prefs.hideAmounts,
      autoLockMs: prefs.autoLockMs,
      showFiat: prefs.showFiat,
      evmChain: evmProfileFor(prefs.testNetwork),
      setSepolia: (on) => patch({ sepolia: on }),
      setTestNetwork: (network) => patch({ testNetwork: network }),
      setHideAmounts: (on) => patch({ hideAmounts: on }),
      setAutoLockMs: (ms) => patch({ autoLockMs: ms }),
      setShowFiat: (on) => patch({ showFiat: on }),
    }),
    [ready, prefs, patch],
  );

  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

export function usePrefs(): PrefsContextValue {
  const ctx = useContext(PrefsContext);
  if (!ctx) throw new Error('usePrefs must be used inside PrefsProvider');
  return ctx;
}
