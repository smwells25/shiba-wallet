import { useEffect, useState } from 'react';
import { getEndpoint } from '../config/networks';
import { usePrefs } from './PrefsContext';
import { useAaStateRevision } from './useAaStateRevision';
import { createAaClientFromConfig, effectiveAaAccountType, getAaConfig, isAaConfigured } from './aa';
import { EVM_CHAIN_ID } from './send';
import { resolveSessionAccount } from './sessions';

/**
 * True when the active account can hold session keys on the active EVM
 * chain (phase 8 item 2): its smart-account type is Kernel v3.3 and the
 * account is deployed, or it is upgraded to Kernel v3.3 with EIP-7702 and
 * the delegation is active on-chain (sessions.ts resolveSessionAccount).
 * Used only to decide whether Home shows the Sessions link; the Sessions
 * screen re-checks and explains any refusal. Read-only; false on any error.
 */
export function useSessionEligibility(owner: string | null | undefined, accountIndex: number | null, refreshKey = 0): boolean {
  const { evmChain } = usePrefs();
  // Re-check (keeping the last answer on screen meanwhile) when the AA
  // configuration changes, an operation is accepted, or the caller asks
  // (Home passes a counter that grows on focus and on pull-to-refresh).
  const revision = useAaStateRevision();
  // The answer is stored with the inputs it was computed for, so a stale
  // answer (another account or chain) is never shown while a new one loads.
  const key = `${evmChain.caip2}|${owner ?? ''}|${accountIndex ?? ''}`;
  const [answer, setAnswer] = useState<{ key: string; ok: boolean } | null>(null);
  useEffect(() => {
    if (!owner || accountIndex === null) return;
    let cancelled = false;
    (async () => {
      const config = await getAaConfig(evmChain.caip2);
      const type = effectiveAaAccountType(config, owner);
      if (type === 'simple' || !isAaConfigured(config, owner)) return false;
      const endpoint = await getEndpoint(EVM_CHAIN_ID);
      if (!endpoint?.url) return false;
      const bundle = createAaClientFromConfig(config, {
        nodeUrl: endpoint.url,
        chainId: BigInt(evmChain.chainIdDecimal),
        accountIndex,
        ownerAddress: owner,
      });
      return (await resolveSessionAccount(bundle, owner)).ok;
    })().then(
      (ok) => {
        if (!cancelled) setAnswer({ key, ok });
      },
      () => {
        if (!cancelled) setAnswer({ key, ok: false });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, owner, accountIndex, evmChain.caip2, evmChain.chainIdDecimal, revision, refreshKey]);
  return answer !== null && answer.key === key && answer.ok;
}
