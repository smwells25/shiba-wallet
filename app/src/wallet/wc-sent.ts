/**
 * What the WalletConnect sent view shows after a request from a dApp was
 * sent (feature 87 on the WalletConnect path; phase 18 polish): a
 * transaction from the regular account, a smart-account transaction, an
 * ERC-5792 batch, or a smart-account transaction the bundler accepted but
 * that was not included within the waiting time. Requests from the in-app
 * browser take the same paths, so they get the same view.
 *
 * Pure data and one ordering helper, with no React Native imports, so the
 * check scripts can load this file directly.
 *
 * The rule this file exists to keep: the dApp is answered first, exactly as
 * before the view existed, and the view is shown only afterwards. The answer
 * never waits for the user (or for the note the user may type).
 *
 * An OPEN outcome (the bounded-broadcast follow-ups of phase 23 item 8: the
 * node or bundler did not answer in time, answered HTTP 5xx, or the
 * connection failed before its answer arrived) completes the request like an
 * accepted one: the dApp gets the transaction hash (or the batch id) the
 * device computed before the broadcast, and the request is NOT put back in
 * the queue — a second approval would re-quote at the next nonce and could
 * send twice. The view then says the outcome is unknown.
 */
import {
  broadcastOutcomeReasonOf,
  broadcastOutcomeSentence,
  type BroadcastKind,
  type BroadcastOutcomeReason,
} from './broadcast-outcome.ts';

/** How far the smart-account operation behind a sent view has got. */
export type WcSentReceiptState = 'pending' | 'found' | 'timeout';

/**
 * A request the WalletConnect context has just sent, shown in place of the
 * approval sheet so the user can add a private note to it. The context
 * builds the result from the queue item it completed.
 */
export interface WcSentResult {
  /** Unique per sent request: the queue item's key. */
  key: string;
  /** For example "Transaction sent" or "Batch sent to the bundler". */
  title: string;
  dappName: string;
  /** CAIP-2 id of the network the request was validated against (the queue item's chain). */
  network: string;
  /**
   * The transaction hash: the regular account's transaction, or the bundle
   * transaction of a smart-account operation once it is known.
   */
  txid: string | null;
  /** The UserOperation hash of a smart-account operation, else null. */
  userOpHash: string | null;
  /** An optional sentence under the title (for example that the dApp was not notified). */
  detail?: string | null;
  /**
   * Smart-account operations only: whether the operation's receipt is still
   * awaited, was found, or was not found in time. Absent for a transaction
   * from the regular account and when nothing more will be awaited.
   */
  receiptState?: WcSentReceiptState;
  /** With receiptState 'found': the UserOperation's success flag when the bundler reported one. */
  success?: boolean | null;
  /** True when the broadcast's outcome is unknown (OpenBroadcast); the view's title is then not a success. */
  outcomeUnknown?: boolean;
}

/**
 * A broadcast whose outcome is open: what the device computed and recorded
 * before handing it over (the app's BroadcastOutcomeUnknownError).
 */
export interface OpenBroadcast {
  kind: BroadcastKind;
  /** The transaction hash or userOpHash computed on the device. */
  hash: string;
  recorded: boolean;
  reason: BroadcastOutcomeReason;
}

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * The open broadcast behind `error`, or null: only the app's
 * BroadcastOutcomeUnknownError of the expected kind carries a usable hash
 * (the engine's bare errors do not, and are left to the old error path).
 */
export function openBroadcastOf(error: unknown, kind: BroadcastKind): OpenBroadcast | null {
  if (error === null || typeof error !== 'object') return null;
  const e = error as { name?: unknown; kind?: unknown; hash?: unknown; recorded?: unknown };
  if (e.name !== 'BroadcastOutcomeUnknownError' || e.kind !== kind) return null;
  if (typeof e.hash !== 'string' || !HASH_RE.test(e.hash)) return null;
  return { kind, hash: e.hash, recorded: e.recorded === true, reason: broadcastOutcomeReasonOf(error) ?? 'timeout' };
}

/**
 * Runs a send (sendEvm / sendAa behind the device check) and returns either
 * its result or, when its outcome is open, the open broadcast; every other
 * error is thrown unchanged (the old path: the request goes back to the
 * queue with the error). The provider uses it on every WalletConnect and
 * in-app browser send path.
 */
export async function sentOrOpen<T>(
  run: () => Promise<T>,
  kind: BroadcastKind,
): Promise<{ value: T; open: null } | { value: null; open: OpenBroadcast }> {
  try {
    return { value: await run(), open: null };
  } catch (error) {
    const open = openBroadcastOf(error, kind);
    if (!open) throw error;
    return { value: null, open };
  }
}

export const WC_TX_SENT_TITLE = 'Transaction sent';
export const WC_TX_SENT_NOT_NOTIFIED_TITLE = 'Transaction sent, dApp not notified';
export const WC_BATCH_SENT_TITLE = 'Batch sent to the bundler';
export const WC_BATCH_SENT_NOT_NOTIFIED_TITLE = 'Batch sent, dApp not notified';
export const WC_SUBMITTED_NOT_INCLUDED_TITLE = 'Submitted, not yet included';
export const WC_OUTCOME_UNKNOWN_TITLE = 'Submitted, outcome unknown';
export const WC_OUTCOME_UNKNOWN_NOT_NOTIFIED_TITLE = 'Submitted, outcome unknown, dApp not notified';

/** After the outcome sentence, a regular-account transaction: what the dApp was told. */
export const WC_OPEN_TX_ANSWERED =
  'The dApp was given this transaction\'s hash, computed on this phone before it was handed over, so the request ' +
  'is not offered again: approving it a second time could send it twice.';
/** After the outcome sentence, a batch: what the dApp was told. */
export const WC_OPEN_BATCH_ANSWERED =
  'The dApp was given the batch id for this operation, as for an accepted batch, so the request is not offered ' +
  'again: approving it a second time could send it twice.';
/** After the outcome sentence, a smart-account transaction with no receipt in two minutes. */
export const WC_OPEN_NOT_INCLUDED =
  'No receipt arrived within two minutes, so the dApp was told no transaction hash is available yet, and the ' +
  'request is not offered again: approving it a second time could send it twice.';
/** When the reply to the dApp failed too. */
export const WC_OPEN_NOT_NOTIFIED =
  'The reply to the dApp failed as well; check the hash below in a block explorer before retrying anything.';

export const WC_TX_NOT_NOTIFIED_DETAIL =
  'The transaction was broadcast, but the reply to the dApp failed. The dApp may not show it; ' +
  'check the transaction in a block explorer before retrying anything.';
export const WC_SMART_TX_NOT_NOTIFIED_DETAIL =
  'The operation was included, but the reply to the dApp failed. The dApp may not show it; ' +
  'check the transaction in a block explorer before retrying anything.';
export const WC_BATCH_NOT_NOTIFIED_DETAIL =
  'The operation was submitted, but the reply to the dApp failed. Check it in an ERC-4337 ' +
  'explorer before retrying anything.';
export const WC_SUBMITTED_NOT_INCLUDED_DETAIL =
  'The bundler accepted the operation, but it was not included within two minutes, so the dApp ' +
  'was told no transaction hash is available yet. Look the UserOperation hash up in an ERC-4337 ' +
  'explorer before retrying anything.';

/** The line under the hashes while the receipt of a sent batch is awaited. */
export const WC_SENT_PENDING_LINE =
  'Waiting for the UserOperation receipt. The bundle transaction appears here once the operation is included.';
/** The line when no receipt arrived in time (the same sentence as the Send screen's). */
export const WC_SENT_TIMEOUT_LINE =
  'No receipt yet. The operation may still be included — keep the UserOperation hash above to look it up later.';
/** The warning when the operation was included but reverted (the same sentence as the Send screen's). */
export const WC_SENT_REVERTED_LINE =
  'The bundler reports the operation was included but reverted on-chain. The gas was still charged to the smart account.';

export type WcSentKind = 'eoa-transaction' | 'smart-transaction' | 'batch' | 'not-included';

/** The view's title and detail for an open outcome (the English outcome sentence, then what the dApp was told). */
function openSentWording(
  open: OpenBroadcast,
  kind: WcSentKind,
  dappNotified: boolean,
): { title: string; detail: string } {
  const told = kind === 'batch' ? WC_OPEN_BATCH_ANSWERED : kind === 'not-included' ? WC_OPEN_NOT_INCLUDED : WC_OPEN_TX_ANSWERED;
  const sentence = broadcastOutcomeSentence(open.kind, open.recorded, open.reason);
  return {
    title: dappNotified ? WC_OUTCOME_UNKNOWN_TITLE : WC_OUTCOME_UNKNOWN_NOT_NOTIFIED_TITLE,
    detail: `${sentence} ${told}${dappNotified ? '' : ` ${WC_OPEN_NOT_NOTIFIED}`}`,
  };
}

/*
 * The notifications inbox (wallet/inbox.ts, phase 22 item 5) lists every
 * sent view once. wcSentResult is called exactly once per sent request, at
 * the moment its view is shown (WalletConnectContext's four sent paths:
 * the batch, the not-included operation, the smart-account transaction and
 * the regular-account transaction), so it is where the view is announced to
 * the listeners. None is registered by default (the check scripts build
 * results without side effects); the app registers the inbox's recorder
 * (App.tsx). A listener never affects the result or the dApp's answer.
 */
const sentListeners = new Set<(result: WcSentResult) => void>();

/** Called with each sent view as it is shown. Returns the unsubscribe function. */
export function onWcSentShown(listener: (result: WcSentResult) => void): () => void {
  sentListeners.add(listener);
  return () => {
    sentListeners.delete(listener);
  };
}

function announceSent(result: WcSentResult): WcSentResult {
  for (const listener of [...sentListeners]) {
    try {
      listener(result);
    } catch {
      // A failing listener never affects the sent view.
    }
  }
  return result;
}

/**
 * Builds the sent view's content for one completed request. `dappNotified`
 * is false when the reply to the dApp failed (the view then says so, as the
 * alert used to).
 */
export function wcSentResult(args: {
  kind: WcSentKind;
  key: string;
  dappName: string;
  network: string;
  txid: string | null;
  userOpHash: string | null;
  dappNotified: boolean;
  /** smart-transaction only: the receipt's success flag. */
  success?: boolean | null;
  /**
   * The open broadcast when the outcome is unknown (sentOrOpen): the view says
   * so instead of "sent". Ignored for 'smart-transaction' (a receipt was
   * found, so the operation was included).
   */
  open?: OpenBroadcast | null;
}): WcSentResult {
  return announceSent(buildWcSentResult(args));
}

function buildWcSentResult(args: Parameters<typeof wcSentResult>[0]): WcSentResult {
  const built = buildBaseWcSentResult(args);
  if (!args.open || args.kind === 'smart-transaction') return built;
  return { ...built, ...openSentWording(args.open, args.kind, args.dappNotified), outcomeUnknown: true };
}

function buildBaseWcSentResult(args: Parameters<typeof wcSentResult>[0]): WcSentResult {
  const base = {
    key: args.key,
    dappName: args.dappName,
    network: args.network,
    txid: args.txid,
    userOpHash: args.userOpHash,
  };
  switch (args.kind) {
    case 'eoa-transaction':
      return {
        ...base,
        userOpHash: null,
        title: args.dappNotified ? WC_TX_SENT_TITLE : WC_TX_SENT_NOT_NOTIFIED_TITLE,
        detail: args.dappNotified ? null : WC_TX_NOT_NOTIFIED_DETAIL,
      };
    case 'smart-transaction':
      return {
        ...base,
        title: args.dappNotified ? WC_TX_SENT_TITLE : WC_TX_SENT_NOT_NOTIFIED_TITLE,
        detail: args.dappNotified ? null : WC_SMART_TX_NOT_NOTIFIED_DETAIL,
        receiptState: 'found',
        success: args.success ?? null,
      };
    case 'batch':
      return {
        ...base,
        txid: null,
        title: args.dappNotified ? WC_BATCH_SENT_TITLE : WC_BATCH_SENT_NOT_NOTIFIED_TITLE,
        detail: args.dappNotified ? null : WC_BATCH_NOT_NOTIFIED_DETAIL,
        receiptState: 'pending',
      };
    case 'not-included':
      // The dApp was answered with an error on purpose; "notified" does not
      // change the wording.
      return {
        ...base,
        txid: null,
        title: WC_SUBMITTED_NOT_INCLUDED_TITLE,
        detail: WC_SUBMITTED_NOT_INCLUDED_DETAIL,
      };
  }
}

/**
 * The receipt of a sent batch arrived (or the wait ended): the view of the
 * SAME request gains the bundle transaction's hash, so the note field moves
 * a note saved under the UserOperation hash to it (TransactionNoteField →
 * notes.ts linkUserOperation). Any other view, or none, is returned as is.
 */
export function withSentReceipt(
  current: WcSentResult | null,
  key: string,
  outcome: { kind: 'found'; success: boolean | null; txHash: string | null } | { kind: 'timeout' },
): WcSentResult | null {
  if (!current || current.key !== key || current.receiptState !== 'pending') return current;
  if (outcome.kind === 'timeout') return { ...current, receiptState: 'timeout' };
  return { ...current, receiptState: 'found', success: outcome.success, txid: outcome.txHash ?? current.txid };
}

/**
 * The completion order on every sent path: answer the dApp (a failed reply
 * is not a failed send), mark the queue item complete, and only then show
 * the sent view. Resolves to whether the dApp was answered.
 */
export async function answerDappThenShow(steps: {
  respond: () => Promise<unknown>;
  complete: () => void;
  show: (dappNotified: boolean) => void;
}): Promise<boolean> {
  let notified = true;
  try {
    await steps.respond();
  } catch {
    notified = false;
  }
  steps.complete();
  steps.show(notified);
  return notified;
}
