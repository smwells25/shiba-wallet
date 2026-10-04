import { useEffect, useState } from 'react';
import { subscribeAaStateChanges } from './aa';

/**
 * A counter that increases whenever the smart-account configuration is
 * written or a smart-account operation is accepted (aa.ts
 * subscribeAaStateChanges). The Home eligibility hooks (sessions,
 * guardians, passkeys) add it to their effect dependencies, so their links
 * are re-checked after a bundler or factory is saved, an account is
 * upgraded, or an operation that may deploy the account was sent, without
 * a relaunch. The readiness gate is unaffected: the hooks still ask
 * isAaConfigured, which applies it.
 */
export function useAaStateRevision(): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => subscribeAaStateChanges(() => setRevision((value) => value + 1)), []);
  return revision;
}
