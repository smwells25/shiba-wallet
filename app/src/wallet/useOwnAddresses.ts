import { useEffect, useState } from 'react';
import { useWallet } from './WalletContext';
import { usePrefs } from './PrefsContext';
import { getAaConfig } from './aa';
import { useAaStateRevision } from './useAaStateRevision';
import { ownWalletAddresses, type OwnAddress } from './risk';

/**
 * The wallet's own EVM addresses on the ACTIVE network, with names: every
 * account's EOA plus the smart-account addresses known without a network
 * request (risk.ts ownWalletAddresses). Re-read when the AA configuration
 * changes. Until the configuration has been read, only the EOAs are known.
 */
export function useOwnEvmAddresses(): OwnAddress[] {
  const { accountList } = useWallet();
  const { evmChain } = usePrefs();
  const revision = useAaStateRevision();
  const accountsKey = accountList.map((a) => `${a.index}:${a.name}:${a.evmAddress ?? ''}`).join(',');
  const [loaded, setLoaded] = useState<{ key: string; own: OwnAddress[] } | null>(null);
  const key = `${evmChain.caip2}|${accountsKey}|${revision}`;

  useEffect(() => {
    let cancelled = false;
    getAaConfig(evmChain.caip2).then(
      (aa) => {
        if (!cancelled) setLoaded({ key, own: ownWalletAddresses(accountList, aa) });
      },
      () => {
        if (!cancelled) setLoaded({ key, own: ownWalletAddresses(accountList, null) });
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` covers the chain, every account's index, name and address, and the AA revision; accountList is a new array whenever the wallet context re-renders.
  }, [key]);

  return loaded && loaded.key === key ? loaded.own : ownWalletAddresses(accountList, null);
}
