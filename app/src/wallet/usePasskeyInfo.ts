import { useEffect, useState } from 'react';
import { getEndpoint } from '../config/networks';
import { usePrefs } from './PrefsContext';
import { useAaStateRevision } from './useAaStateRevision';
import { createAaClientFromConfig, effectiveAaAccountType, getAaConfig, isAaConfigured } from './aa';
import { EVM_CHAIN_ID } from './send';
import { passkeyRecordForOwner, resolvePasskeyAccount, type PasskeyRecord } from './passkeys';

export interface PasskeyInfo {
  /** The active account has a deployed Kernel v3.3 account it owns (a passkey can live there). */
  eligible: boolean;
  /** This device's installed passkey record for the active account on the active chain, if any. */
  record: PasskeyRecord | null;
}

const NONE: PasskeyInfo = { eligible: false, record: null };

/**
 * Phase 8 item 3 facts for Home and Send, for the active account on the
 * active EVM chain. Read-only; NONE on any error. The Passkey screen
 * re-checks everything, explains refusals and shows the development-build
 * note when the native module or the rpId is missing.
 */
export function usePasskeyInfo(owner: string | null | undefined, accountIndex: number | null, refreshKey = 0): PasskeyInfo {
  const { evmChain } = usePrefs();
  // Re-check (keeping the last answer on screen meanwhile) when the AA
  // configuration changes, an operation is accepted, or the caller asks
  // (Home passes a counter that grows on focus and on pull-to-refresh).
  const revision = useAaStateRevision();
  // The answer is stored with its inputs, so another account's or chain's
  // answer is never shown while a new one loads.
  const key = `${evmChain.caip2}|${owner ?? ''}|${accountIndex ?? ''}`;
  const [answer, setAnswer] = useState<{ key: string; info: PasskeyInfo } | null>(null);
  useEffect(() => {
    if (!owner || accountIndex === null) return;
    let cancelled = false;
    (async (): Promise<PasskeyInfo> => {
      const config = await getAaConfig(evmChain.caip2);
      if (effectiveAaAccountType(config, owner) !== 'kernel-v3.3' || !isAaConfigured(config, owner)) return NONE;
      const endpoint = await getEndpoint(EVM_CHAIN_ID);
      if (!endpoint?.url) return NONE;
      const bundle = createAaClientFromConfig(config, {
        nodeUrl: endpoint.url,
        chainId: BigInt(evmChain.chainIdDecimal),
        accountIndex,
        ownerAddress: owner,
      });
      const resolution = await resolvePasskeyAccount(bundle, owner);
      if (!resolution.ok) return NONE;
      const record = await passkeyRecordForOwner(evmChain.caip2, owner).catch(() => null);
      return {
        eligible: true,
        record: record && record.localStatus === 'installed' && record.account === resolution.account ? record : null,
      };
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
  }, [key, owner, accountIndex, evmChain.caip2, evmChain.chainIdDecimal, revision, refreshKey]);
  return answer !== null && answer.key === key ? answer.info : NONE;
}
