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
 */

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
}

export const WC_TX_SENT_TITLE = 'Transaction sent';
export const WC_TX_SENT_NOT_NOTIFIED_TITLE = 'Transaction sent, dApp not notified';
export const WC_BATCH_SENT_TITLE = 'Batch sent to the bundler';
export const WC_BATCH_SENT_NOT_NOTIFIED_TITLE = 'Batch sent, dApp not notified';
export const WC_SUBMITTED_NOT_INCLUDED_TITLE = 'Submitted, not yet included';

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
}): WcSentResult {
  return announceSent(buildWcSentResult(args));
}

function buildWcSentResult(args: Parameters<typeof wcSentResult>[0]): WcSentResult {
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
