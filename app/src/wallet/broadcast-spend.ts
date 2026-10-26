// Spending limits for broadcasts whose outcome may stay open (the
// bounded-broadcast follow-ups of phase 23 item 8).
//
// The app-enforced spending limits (./spending-policy.ts) used to count a
// send only once the node or bundler ACCEPTED it. A broadcast whose answer
// never came (BroadcastOutcomeUnknownError: no answer in time, an HTTP 5xx,
// a dropped connection) was therefore never counted although it may have
// gone through. The conservative rule this module carries:
//
//  1. the spend is counted BEFORE the request leaves the device, at the same
//     moment the pending registry records the transaction or operation, under
//     the hash computed on the device;
//  2. a definite refusal (the node or bundler answered with an error) releases
//     what THIS attempt counted;
//  3. an unknown outcome keeps it counted;
//  4. on acceptance the count stays, and when the node or bundler returned a
//     hash other than the device's the counted records take the returned one,
//     so the acceptance recorders (which record under the returned hash) find
//     it and add nothing: a send is counted once.
//
// A leaf module with no imports of its own, so send.ts, aa.ts and
// spending-policy.ts can all use it without a cycle. The recorder is
// registered by spending-policy.ts installSpendingRecorder (WalletContext);
// with none registered every function here does nothing.

/** One call of a spend, as spending-policy.ts SpendingCall. */
export interface BroadcastSpendCall {
  to: string;
  value: bigint;
  data?: Uint8Array;
}

/**
 * What a broadcast takes out of an account, as the acceptance recorders
 * count it: the account's limits (`chain`, `owner`), the address the
 * outflows leave (`spender`: the EOA, or the smart account), the calls and
 * the worst-case fee.
 */
export interface BroadcastSpend {
  /** CAIP-2 EVM chain id. */
  chain: string;
  /** The account whose limits apply (its own EOA address). */
  owner: string;
  spender: string;
  calls: readonly BroadcastSpendCall[];
  fee: bigint;
  /** The spending store (check scripts); the recorder's default otherwise. */
  store?: unknown;
  /** Unix seconds the spend is recorded at (the caller's clock); now otherwise. */
  now?: number;
}

/**
 * What counting a spend before its broadcast found: 'created' — this call
 * added records (so a refusal releases them); 'existed' — records with this
 * hash were already there (an earlier attempt), so a refusal never releases
 * them; 'none' — nothing to count (no limit covers it); 'failed' — the
 * history could not be read or written (the acceptance recorder still tries).
 */
export type BroadcastSpendState = 'created' | 'existed' | 'none' | 'failed';

export interface BroadcastSpendRecorder {
  record(spend: BroadcastSpend, ref: string): Promise<BroadcastSpendState>;
  release(spend: BroadcastSpend, ref: string): Promise<void>;
  accepted(spend: BroadcastSpend, ref: string, acceptedRef: string): Promise<void>;
}

const recorders = new Set<BroadcastSpendRecorder>();

/** Registers a recorder (spending-policy.ts). Returns the unsubscribe function. */
export function addBroadcastSpendRecorder(recorder: BroadcastSpendRecorder): () => void {
  recorders.add(recorder);
  return () => {
    recorders.delete(recorder);
  };
}

/** One recorder and what counting before the broadcast found. */
export type BroadcastSpendStates = [BroadcastSpendRecorder, BroadcastSpendState][];

/** Counts `spend` under `ref` with every recorder, awaited, before the broadcast. Never throws. */
export async function countSpendBeforeBroadcast(spend: BroadcastSpend | null | undefined, ref: string): Promise<BroadcastSpendStates> {
  const states: BroadcastSpendStates = [];
  if (!spend) return states;
  for (const recorder of [...recorders]) {
    let state: BroadcastSpendState;
    try {
      state = await recorder.record(spend, ref);
    } catch {
      state = 'failed';
    }
    states.push([recorder, state]);
  }
  return states;
}

/** A definite refusal: releases what THIS attempt counted ('created' only). Never throws. */
export async function releaseSpendAfterRefusal(
  spend: BroadcastSpend | null | undefined,
  ref: string,
  states: BroadcastSpendStates,
): Promise<void> {
  if (!spend) return;
  for (const [recorder, state] of states) {
    if (state !== 'created') continue;
    try {
      await recorder.release(spend, ref);
    } catch {
      // Bookkeeping only: a count that could not be released stays (the conservative side).
    }
  }
}

/** Accepted: the count stays, under the hash the node or bundler returned. Never throws. */
export async function spendAccepted(
  spend: BroadcastSpend | null | undefined,
  ref: string,
  acceptedRef: string,
  states: BroadcastSpendStates,
): Promise<void> {
  if (!spend) return;
  for (const [recorder, state] of states) {
    if (state !== 'created' && state !== 'existed') continue;
    try {
      await recorder.accepted(spend, ref, acceptedRef);
    } catch {
      // Bookkeeping only.
    }
  }
}
