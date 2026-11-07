import { useCallback, useEffect, useRef, useState } from 'react';
import type { FungibleAsset } from '@shiba-wallet/core';
import { NoEndpointError, withEndpoint } from '../config/networks';
import { SOLANA_SLOT_CHAIN_ID, loadSplTokenRows, solanaClient, type SplRowState } from './spl-tokens';
import { listSolanaTokens } from './tokens';
import { SOLANA_DEVNET_CAIP2, SOLANA_MAINNET_CAIP2 } from '@shiba-wallet/chains-solana';

/**
 * Home's Solana token rows (phase 24 item 1): the tracked tokens of the
 * network serving the Solana slot (Solana mainnet, or Solana devnet while
 * Settings → Developer → "Use Solana devnet" is on) and their balances, read
 * in one pass through the slot's endpoint with the shared failover rule
 * (config/networks.ts withEndpoint). The list is keyed by the network that
 * answered, so a devnet list is never shown under mainnet or the reverse.
 * Like the ERC-20 rows, the caller drives loads (on focus).
 */
export interface SplTokensHook {
  /** The CAIP-2 id of the network the list and balances belong to, or null before the first load. */
  network: string | null;
  tokens: FungibleAsset[];
  rows: Record<string, SplRowState>;
  /** Token accounts the listing skipped because they failed its checks. */
  skipped: number;
  /** The whole load failed (no endpoint, or the listing itself failed). */
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
}

export function useSplTokens(owner: string | undefined, solanaDevnet: boolean): SplTokensHook {
  const [state, setState] = useState<Omit<SplTokensHook, 'reload'>>({
    network: null,
    tokens: [],
    rows: {},
    skipped: 0,
    error: null,
    loading: false,
  });
  const generation = useRef(0);

  const reload = useCallback(async () => {
    if (!owner) return;
    const gen = ++generation.current;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const expected = solanaDevnet ? SOLANA_DEVNET_CAIP2 : SOLANA_MAINNET_CAIP2;
      const { value } = await withEndpoint(SOLANA_SLOT_CHAIN_ID, async (ep) => {
        const network = ep.network.chainId;
        // The endpoint must serve the network this hook was asked for (a
        // switch in Settings between the two reads is refused, not mixed).
        if (network !== expected) throw new Error(`The Solana endpoint serves ${network}, not ${expected}.`);
        const tokens = await listSolanaTokens(network);
        const loaded = tokens.length === 0 ? { rows: {}, skipped: 0 } : await loadSplTokenRows(solanaClient(ep.url), owner, tokens, network);
        return { network, tokens, ...loaded };
      });
      if (generation.current !== gen) return;
      setState({ ...value, error: null, loading: false });
    } catch (e) {
      if (generation.current !== gen) return;
      const message =
        e instanceof NoEndpointError
          ? 'No Solana endpoint is configured.'
          : `The Solana token balances could not be loaded. Technical detail: ${e instanceof Error ? e.message : String(e)}`;
      setState((prev) => ({ ...prev, error: message, loading: false }));
    }
  }, [owner, solanaDevnet]);

  // A different owner or a switch between mainnet and devnet drops what is
  // shown at once, so no previous network's balance stays under the new one.
  const lastKey = useRef(`${owner}|${solanaDevnet}`);
  useEffect(() => {
    const key = `${owner}|${solanaDevnet}`;
    if (lastKey.current === key) return;
    lastKey.current = key;
    generation.current += 1;
    setState({ network: null, tokens: [], rows: {}, skipped: 0, error: null, loading: false });
  }, [owner, solanaDevnet]);

  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  return { ...state, reload };
}
