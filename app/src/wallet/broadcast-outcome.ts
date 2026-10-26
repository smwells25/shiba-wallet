// Broadcasts whose answer never came (phase 23 item 8).
//
// The engine's httpTransport gives up on eth_sendRawTransaction and
// eth_sendUserOperation after BROADCAST_TIMEOUT_MS (chains-evm rpc.ts) and
// throws BroadcastTimeoutError. That does NOT mean the broadcast failed: the
// request may have reached the endpoint, which may have forwarded it. So the
// send paths record the transaction (or UserOperation) in the pending
// registry BEFORE the request leaves the device, keep that record when the
// answer never comes, and report the outcome as UNKNOWN — never "not sent".
// Activity's "Pending on this phone" then settles it (included, dropped or
// replaced). This module holds the error types and the sentences; it imports
// only the engine and the pending registry's constants, so send.ts, aa.ts,
// sessions.ts and the describers can all use it without a cycle.

import { BROADCAST_TIMEOUT_MS, isBroadcastTimeoutError } from '@shiba-wallet/chains-evm';
import { PENDING_POLL_MS } from './pending-transactions.ts';

/** What was handed over: a regular transaction or a smart-account operation. */
export type BroadcastKind = 'tx' | 'userop';

const WAIT_SECONDS = Math.round(BROADCAST_TIMEOUT_MS / 1000);
const POLL_SECONDS = Math.round(PENDING_POLL_MS / 1000);

export const BROADCAST_OUTCOME_UNKNOWN_TITLE = 'No answer from the network in time.';

/** A regular transaction, listed under Pending on this phone (the usual case). */
export const BROADCAST_TX_UNKNOWN_SENTENCE =
  `The network endpoint did not answer within ${WAIT_SECONDS} seconds, so this wallet does not know whether ` +
  'the transaction was sent. It is listed under Pending on this phone in Activity, which checks it every ' +
  `${POLL_SECONDS} seconds; do not send it again until that list says what happened.`;

/** A regular transaction whose pending record could not be written. */
export const BROADCAST_TX_UNKNOWN_UNLISTED_SENTENCE =
  `The network endpoint did not answer within ${WAIT_SECONDS} seconds, so this wallet does not know whether ` +
  'the transaction was sent, and it could not add it to Pending on this phone. Look the transaction up in a ' +
  'block explorer before sending anything again.';

/** A smart-account operation, listed under Pending on this phone. */
export const BROADCAST_USEROP_UNKNOWN_SENTENCE =
  `The bundler did not answer within ${WAIT_SECONDS} seconds, so this wallet does not know whether it ` +
  'received the operation. It is listed under Pending on this phone in Activity; tap Check status there, and ' +
  'do not send it again until that list says what happened.';

/** A smart-account operation whose pending record could not be written. */
export const BROADCAST_USEROP_UNKNOWN_UNLISTED_SENTENCE =
  `The bundler did not answer within ${WAIT_SECONDS} seconds, so this wallet does not know whether it ` +
  'received the operation, and it could not add it to Pending on this phone. Look the operation up in an ' +
  'ERC-4337 explorer before sending anything again.';

/** A broadcast that timed out on a path that keeps no pending record (the engine's bare error). */
export const BROADCAST_UNKNOWN_SENTENCE =
  `The network did not answer within ${WAIT_SECONDS} seconds, so this wallet does not know whether it was ` +
  'sent. Check this account in a block explorer before sending anything again.';

export const BROADCAST_ALREADY_HANDED_OVER_TITLE = 'Already handed to the network once.';

/** The same quote approved again after its broadcast got no answer. */
export const BROADCAST_ALREADY_HANDED_OVER_SENTENCE =
  'This transaction was already handed to the network endpoint once and whether it was accepted is still ' +
  'unknown, so this wallet did not hand it over a second time. Check Pending on this phone in Activity; ' +
  'review a new send only if that list says it was dropped.';

/**
 * A broadcast that got no answer in time, after the send path recorded it
 * (or tried to). `hash` is the transaction hash or userOpHash computed on the
 * device before the request left it; `recorded` says whether the pending
 * registry holds it. `technical` keeps the engine's message.
 */
export class BroadcastOutcomeUnknownError extends Error {
  readonly kind: BroadcastKind;
  readonly hash: string;
  readonly chain: string;
  readonly recorded: boolean;
  readonly technical: string;
  // No TS parameter properties: Node's strip-only type stripping rejects them.
  constructor(args: { kind: BroadcastKind; hash: string; chain: string; recorded: boolean; technical: string }) {
    super(broadcastOutcomeSentence(args.kind, args.recorded));
    this.name = 'BroadcastOutcomeUnknownError';
    this.kind = args.kind;
    this.hash = args.hash;
    this.chain = args.chain;
    this.recorded = args.recorded;
    this.technical = args.technical;
  }
}

/** Refusal of a quote (or signed transaction) whose earlier broadcast has an unknown outcome. */
export class BroadcastAlreadyHandedOverError extends Error {
  readonly hash: string;
  constructor(hash: string) {
    super(BROADCAST_ALREADY_HANDED_OVER_SENTENCE);
    this.name = 'BroadcastAlreadyHandedOverError';
    this.hash = hash;
  }
}

export function broadcastOutcomeSentence(kind: BroadcastKind, recorded: boolean): string {
  if (kind === 'tx') return recorded ? BROADCAST_TX_UNKNOWN_SENTENCE : BROADCAST_TX_UNKNOWN_UNLISTED_SENTENCE;
  return recorded ? BROADCAST_USEROP_UNKNOWN_SENTENCE : BROADCAST_USEROP_UNKNOWN_UNLISTED_SENTENCE;
}

function nameOf(error: unknown): string | null {
  if (error === null || typeof error !== 'object') return null;
  const name = (error as { name?: unknown }).name;
  return typeof name === 'string' ? name : null;
}

/** True for a broadcast whose outcome is unknown: the app's wrapper or the engine's bare timeout. */
export function isBroadcastOutcomeUnknown(error: unknown): boolean {
  return nameOf(error) === 'BroadcastOutcomeUnknownError' || isBroadcastTimeoutError(error);
}

/** True for the refusal of a quote whose earlier broadcast has an unknown outcome. */
export function isBroadcastAlreadyHandedOver(error: unknown): boolean {
  return nameOf(error) === 'BroadcastAlreadyHandedOverError';
}

/**
 * The title and sentence for an unknown outcome or for the second-attempt
 * refusal; null for every other error. Used first by describeSendError,
 * describeAaError and the recurring-payment and recurring-swap describers.
 */
export function describeBroadcastOutcome(error: unknown): { title: string; detail: string; technical?: string } | null {
  if (isBroadcastAlreadyHandedOver(error)) {
    return { title: BROADCAST_ALREADY_HANDED_OVER_TITLE, detail: BROADCAST_ALREADY_HANDED_OVER_SENTENCE };
  }
  if (nameOf(error) === 'BroadcastOutcomeUnknownError') {
    const e = error as BroadcastOutcomeUnknownError;
    const label = e.kind === 'tx' ? 'Transaction hash' : 'UserOperation hash';
    const technical = `${label}: ${e.hash}. ${e.technical}`;
    return {
      title: BROADCAST_OUTCOME_UNKNOWN_TITLE,
      detail: `${broadcastOutcomeSentence(e.kind, e.recorded)}\n\nTechnical detail: ${technical}`,
      technical,
    };
  }
  if (isBroadcastTimeoutError(error)) {
    const technical = (error as Error).message;
    return {
      title: BROADCAST_OUTCOME_UNKNOWN_TITLE,
      detail: `${BROADCAST_UNKNOWN_SENTENCE}\n\nTechnical detail: ${technical}`,
      technical,
    };
  }
  return null;
}
