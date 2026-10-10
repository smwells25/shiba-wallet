import { useEffect, useState } from 'react';
import { useWallet } from './WalletContext';
import { usePrefs } from './PrefsContext';
import { getAaConfig } from './aa';
import { useAaStateRevision } from './useAaStateRevision';
import { ownWalletAddresses, type OwnAddress } from './risk';
import { ownMultisigAddresses } from './multisig';

/**
 * The wallet's own EVM addresses on the ACTIVE network, with names: every
 * account's EOA plus the smart-account addresses known without a network
 * request (risk.ts ownWalletAddresses), plus the multi-signature accounts
 * stored for this network ("Multisig 1 (2-of-3)", multisig.ts
 * ownMultisigAddresses), so the success screen names a send to the wallet's
 * own multisig instead of offering "Save as contact". Re-read when the AA
 * configuration changes. Until the configuration and the multisig records
 * have been read, only the EOAs are known.
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
    // ownMultisigAddresses never throws (an unreadable list gives none).
    Promise.all([getAaConfig(evmChain.caip2).catch(() => null), ownMultisigAddresses(evmChain.caip2)]).then(
      ([aa, multisigs]) => {
        if (!cancelled) setLoaded({ key, own: ownWalletAddresses(accountList, aa, multisigs) });
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
