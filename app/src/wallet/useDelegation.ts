import { useCallback, useEffect, useRef, useState } from 'react';
import { getEndpoint } from '../config/networks';
import { usePrefs } from './PrefsContext';
import { EVM_CHAIN_ID } from './send';
import {
  cachedAccountDelegation,
  readAccountDelegation,
  subscribeDelegation,
  type AccountDelegation,
} from './delegation';

export interface DelegationState {
  /** null while loading, when no endpoint exists, or when the read failed. */
  status: AccountDelegation | null;
  loading: boolean;
  /** The read's error message; the UI shows "status unknown", never a guess. */
  error: string | null;
  /** The active EVM chain's RPC URL the status was read through. */
  url: string | null;
  /** Re-reads from the chain (bypassing the session cache). */
  refresh: () => void;
}

/**
 * EIP-7702 delegation status of `address` on the ACTIVE EVM chain, read
 * through ./delegation.ts (session cache per chain + address, eth_chainId
 * checked against the active profile). Re-renders when the wallet changes a
 * delegation (the cache notifies subscribers).
 */
export function useAccountDelegation(address: string | null | undefined): DelegationState {
  const { evmChain } = usePrefs();
  const chainId = BigInt(evmChain.chainIdDecimal);
  const [url, setUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<AccountDelegation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  // Set by refresh(): the next read bypasses the session cache.
  const forceRef = useRef(false);

  useEffect(() => subscribeDelegation(() => setNonce((n) => n + 1)), []);

  useEffect(() => {
    // No address (e.g. a non-EVM screen): nothing to read; the returned
    // state is masked below instead of being set here.
    if (!address) return;
    let cancelled = false;
    const force = forceRef.current;
    forceRef.current = false;
    (async () => {
      setLoading(true);
      setError(null);
      const endpoint = await getEndpoint(EVM_CHAIN_ID);
      const resolved = endpoint?.url ?? null;
      if (cancelled) return;
      setUrl(resolved);
      if (!resolved) {
        setStatus(null);
        setError('No RPC endpoint is configured for this network.');
        return;
      }
      const cached = force ? undefined : cachedAccountDelegation(resolved, address, chainId);
      if (cached) {
        setStatus(cached);
        return;
      }
      const next = await readAccountDelegation(resolved, address, { chainId, force });
      if (!cancelled) setStatus(next);
    })()
      .catch((e: unknown) => {
        if (!cancelled) {
          setStatus(null);
          setError(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // chainId is derived from evmChain.chainIdDecimal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, evmChain.chainIdDecimal, nonce]);

  const refresh = useCallback(() => {
    forceRef.current = true;
    setNonce((n) => n + 1);
  }, []);
  if (!address) return { status: null, loading: false, error: null, url, refresh };
  return { status, loading, error, url, refresh };
}
