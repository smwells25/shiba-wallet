import { useEffect, useState } from 'react';
import { getEndpoint } from '../config/networks';
import { usePrefs } from './PrefsContext';
import { createAaClientFromConfig, getAaConfig, isAaConfigured, recoveredAccountFor } from './aa';
import { EVM_CHAIN_ID } from './send';
import { getRecoveryProgress, resolveGuardianAccount } from './recovery';

export interface RecoveryInfo {
  /** The active account can open the Guardians screen (deployed Kernel v3.3 it owns). */
  guardiansEligible: boolean;
  /** A recovered Kernel account attached to the active account on the active chain. */
  recoveredAccount: string | null;
  /** A recovery (as the new owner) is in progress for the active account on the active chain. */
  recoveryInProgress: boolean;
}

const NONE: RecoveryInfo = { guardiansEligible: false, recoveredAccount: null, recoveryInProgress: false };

/**
 * Phase 8 item 4 facts for Home and Receive, for the active account on the
 * active EVM chain. Read-only; NONE on any error. The Guardians and Recover
 * screens re-check everything and explain refusals.
 */
export function useRecoveryInfo(owner: string | null | undefined, accountIndex: number | null): RecoveryInfo {
  const { evmChain } = usePrefs();
  // The answer is stored with its inputs, so another account's or chain's
  // answer is never shown while a new one loads.
  const key = `${evmChain.caip2}|${owner ?? ''}|${accountIndex ?? ''}`;
  const [answer, setAnswer] = useState<{ key: string; info: RecoveryInfo } | null>(null);
  useEffect(() => {
    if (!owner || accountIndex === null) return;
    let cancelled = false;
    (async (): Promise<RecoveryInfo> => {
      const [config, progress] = await Promise.all([
        getAaConfig(evmChain.caip2),
        getRecoveryProgress(evmChain.caip2, owner).catch(() => null),
      ]);
      const recoveredAccount = recoveredAccountFor(config, owner);
      let guardiansEligible = false;
      const endpoint = await getEndpoint(EVM_CHAIN_ID);
      if (endpoint?.url && isAaConfigured(config, owner)) {
        try {
          const bundle = createAaClientFromConfig(config, {
            nodeUrl: endpoint.url,
            chainId: BigInt(evmChain.chainIdDecimal),
            accountIndex,
            ownerAddress: owner,
          });
          if (bundle.accountType === 'kernel-v3.3') {
            guardiansEligible = (await resolveGuardianAccount(bundle, owner)).ok;
          }
        } catch {
          guardiansEligible = false;
        }
      }
      return { guardiansEligible, recoveredAccount, recoveryInProgress: progress !== null };
    })().then(
      (info) => {
        if (!cancelled) setAnswer({ key, info });
      },
      () => {
        if (!cancelled) setAnswer({ key, info: NONE });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, owner, accountIndex, evmChain.caip2, evmChain.chainIdDecimal]);
  return answer !== null && answer.key === key ? answer.info : NONE;
}
