// Explicit .ts extensions: this module is imported by scripts/check-wc.mjs
// under Node's type stripping, which resolves relative specifiers literally.
import {
  WC_ERRORS,
  WcRequestRejection,
  accountMismatchMessage,
  decideSwitchChain,
  declineProposal,
  describeProposal,
  parseWcRequest,
  respondApproved,
  respondRejected,
  sessionAddressesOf,
  sessionBindsAddress,
  sessionChainsOf,
  summarizeSessions,
  type ParsedWcRequest,
  type WcClient,
  type WcProposalSummary,
  type WcRequestEvent,
  type WcSessionSummary,
} from './walletconnect.ts';

/**
 * App-wide WalletConnect request queue (phase 6, item 5). Pure TypeScript
 * with no React or React Native imports, so scripts/check-wc.mjs drives it
 * against a fake WalletKit client exactly as the app does.
 *
 * What it owns:
 *  - the SDK event listeners (session_proposal, session_request,
 *    session_delete, session_request_expire, proposal_expire), attached
 *    once for the life of the app by WalletConnectContext;
 *  - the approval queue: proposals and signing requests, strictly one at
 *    a time in arrival order (the head is the only item the UI shows);
 *  - the lock hold: while `locked` is true the head is null, so no
 *    approval UI renders and nothing can be claimed for action — items
 *    stay queued, untouched, until unlock;
 *  - automatic answers that need no user decision and touch no key:
 *    malformed / unsupported / wrong-chain requests, and requests for a
 *    session bound to an account other than the active one (phase 6
 *    item 3 — a session is bound to the EVM address it was approved
 *    with), are declined with the matching SDK error at once (never left
 *    to time out), and
 *    wallet_switchEthereumChain to the already-active chain is answered
 *    null (decideSwitchChain). These are answered even while locked: they
 *    reveal nothing and leaving them unanswered would block the SDK's own
 *    one-at-a-time request queue behind the lock screen;
 *  - notices: plain-language lines about those automatic answers,
 *    disconnects and expiries, for the UI to show.
 *
 * What it never does: sign, or decline a request because time passed. A
 * request only leaves the queue by an explicit user decision, by the dApp
 * deleting the session (session_delete — the SDK already failed its
 * pending requests with USER_DISCONNECTED, per sign-client engine
 * deleteSession), or by the SDK's own expiry event
 * (session_request_expire / proposal_expire, which the SDK emits after
 * deleting the pending item itself — engine deletePendingSessionRequest).
 *
 * Why an app-level queue at all, given the SDK already serializes: the
 * sign-client (src/controllers/engine.ts processSessionRequestQueue /
 * emitSessionRequest, 2.25.0) emits ONE session_request at a time, marks
 * its queue active until the wallet responds, and never re-emits an id it
 * already emitted in this process. A request emitted while no listener was
 * attached (previously: whenever the Connections screen was not mounted)
 * was therefore lost until an app restart AND blocked every later request.
 * The global listener removes that failure; this queue additionally keeps
 * proposals and requests in one ordered line and implements the lock hold.
 */

export type WcQueueItem =
  | {
      type: 'proposal';
      key: string;
      event: { id: number; params: unknown };
      summary: WcProposalSummary;
    }
  | {
      type: 'request';
      key: string;
      event: WcRequestEvent;
      parsed: ParsedWcRequest;
      /** The active chain the request was validated against on arrival. */
      chain: string;
      /**
       * The session's bound EVM address, which equalled the active
       * account's address on arrival. Approval re-checks it (see
       * staleAccountError) and the signer must control exactly it.
       */
      address: string;
    };

export interface WcNotice {
  id: number;
  text: string;
}

export interface WcControllerSnapshot {
  /** Every queued item, arrival order. */
  queue: readonly WcQueueItem[];
  /** The item the UI may show — queue[0], or null while locked. */
  head: WcQueueItem | null;
  locked: boolean;
  /** Key of the item currently being acted on (spinner), or null. */
  busyKey: string | null;
  sessions: readonly WcSessionSummary[];
  /** Newest first, at most MAX_NOTICES. */
  notices: readonly WcNotice[];
}

export interface WcControllerContext {
  /** The ACTIVE account's EVM address, or null when unavailable. */
  address: string | null;
  /** CAIP-2 id of the ACTIVE EVM chain (config/evm-chain.ts). */
  activeChain: string;
  /**
   * Display label for one of this wallet's addresses, e.g.
   * "Account 1 (0x9858…Eda94)", or null for an unknown address. Used only
   * in plain-language messages.
   */
  labelFor?: (address: string) => string | null;
}

const MAX_NOTICES = 5;

export class WcController {
  client: WcClient;
  getContext: () => WcControllerContext;
  queue: WcQueueItem[] = [];
  locked: boolean;
  busyKey: string | null = null;
  sessions: WcSessionSummary[] = [];
  notices: WcNotice[] = [];
  noticeSeq = 0;
  listeners = new Set<() => void>();
  snapshotCache: WcControllerSnapshot | null = null;

  // No TS parameter properties: Node's strip-only type stripping (used by
  // scripts/check-wc.mjs) rejects them.
  constructor(
    client: WcClient,
    getContext: () => WcControllerContext,
    options: { locked?: boolean } = {},
  ) {
    this.client = client;
    this.getContext = getContext;
    this.locked = options.locked ?? false;
  }

  // ------------------------------------------------------------ store API

  /** Subscribe to snapshot changes (React useSyncExternalStore shape). */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Stable snapshot object until the next change. */
  getSnapshot = (): WcControllerSnapshot => {
    if (!this.snapshotCache) {
      this.snapshotCache = {
        queue: [...this.queue],
        head: this.locked ? null : (this.queue[0] ?? null),
        locked: this.locked,
        busyKey: this.busyKey,
        sessions: [...this.sessions],
        notices: [...this.notices],
      };
    }
    return this.snapshotCache;
  };

  emit(): void {
    this.snapshotCache = null;
    for (const listener of [...this.listeners]) listener();
  }

  // ---------------------------------------------------------- SDK wiring

  /** Registers the SDK listeners; returns the detach function. */
  attach(): () => void {
    const onProposal = (e: { id: number; params: unknown }) => this.onProposal(e);
    const onRequest = (e: WcRequestEvent) => void this.onRequest(e);
    const onDelete = (e: { topic?: string }) => this.onSessionDelete(e);
    const onRequestExpire = (e: { id?: number }) => this.onRequestExpire(e);
    const onProposalExpire = (e: { id?: number }) => this.onProposalExpire(e);
    this.client.on('session_proposal', onProposal as never);
    this.client.on('session_request', onRequest as never);
    this.client.on('session_delete', onDelete as never);
    this.client.on('session_request_expire', onRequestExpire as never);
    this.client.on('proposal_expire', onProposalExpire as never);
    this.refreshSessions();
    return () => {
      this.client.off('session_proposal', onProposal as never);
      this.client.off('session_request', onRequest as never);
      this.client.off('session_delete', onDelete as never);
      this.client.off('session_request_expire', onRequestExpire as never);
      this.client.off('proposal_expire', onProposalExpire as never);
    };
  }

  refreshSessions(): void {
    try {
      this.sessions = summarizeSessions(this.client.getActiveSessions());
    } catch {
      this.sessions = [];
    }
    this.emit();
  }

  /** The bound address(es) of the live session for `topic` (empty if unknown). */
  sessionAddresses(topic: string): string[] {
    try {
      return sessionAddressesOf(this.client.getActiveSessions()[topic]);
    } catch {
      return [];
    }
  }

  /** Chains the live session for `topic` exposes (empty if unknown). */
  sessionChains(topic: string): string[] {
    try {
      return sessionChainsOf(this.client.getActiveSessions()[topic]);
    } catch {
      return [];
    }
  }

  dappName(topic: string): string {
    return this.sessions.find((s) => s.topic === topic)?.name ?? 'A dApp';
  }

  addNotice(text: string): void {
    this.noticeSeq += 1;
    this.notices = [{ id: this.noticeSeq, text }, ...this.notices].slice(0, MAX_NOTICES);
    this.emit();
  }

  dismissNotice(id: number): void {
    this.notices = this.notices.filter((n) => n.id !== id);
    this.emit();
  }

  // -------------------------------------------------------------- events

  onProposal(event: { id: number; params: unknown }): void {
    const key = `p:${event.id}`;
    if (this.queue.some((i) => i.key === key)) return; // at-least-once delivery
    const { activeChain } = this.getContext();
    this.queue.push({
      type: 'proposal',
      key,
      event,
      summary: describeProposal(event, [activeChain]),
    });
    this.emit();
  }

  /**
   * Routes one session_request: automatic answer (decline / switch no-op)
   * or into the approval queue. Returns when any automatic answer has been
   * sent, so tests can await it.
   */
  async onRequest(event: WcRequestEvent): Promise<void> {
    const key = `r:${event.id}`;
    if (this.queue.some((i) => i.key === key)) return; // at-least-once delivery
    const { address, activeChain, labelFor } = this.getContext();
    const method = event.params?.request?.method;
    const dapp = this.dappName(event.topic);

    if (!address) {
      await this.autoDecline(event, { code: -32603, message: 'Wallet account unavailable.' }, dapp);
      return;
    }

    // Account binding: a session serves only the account it was approved
    // with. After an account switch its requests are declined with a
    // plain sentence naming the bound account — never signed by the
    // active one, never left pending (the SDK would block every later
    // request behind it).
    const bound = this.sessionAddresses(event.topic);
    if (!sessionBindsAddress(bound, address)) {
      await this.autoDecline(
        event,
        {
          code: WC_ERRORS.unsupportedAccounts.code,
          message: accountMismatchMessage(bound, address, labelFor),
        },
        dapp,
      );
      return;
    }

    if (method === 'wallet_switchEthereumChain') {
      const decision = decideSwitchChain(event, activeChain, this.sessionChains(event.topic));
      if (decision.kind === 'answer') {
        try {
          await respondApproved(this.client, event.topic, event.id, decision.result);
        } catch {
          // Session gone mid-answer; nothing else to do.
        }
        return;
      }
      await this.autoDecline(event, decision.error, dapp);
      return;
    }

    let parsed: ParsedWcRequest;
    try {
      parsed = parseWcRequest(event, address, activeChain);
    } catch (e) {
      const rejection =
        e instanceof WcRequestRejection
          ? { code: e.code, message: e.message }
          : { code: -32603, message: 'The request could not be processed.' };
      await this.autoDecline(event, rejection, dapp);
      return;
    }
    this.queue.push({ type: 'request', key, event, parsed, chain: activeChain, address });
    this.emit();
  }

  async autoDecline(
    event: WcRequestEvent,
    error: { code: number; message: string },
    dapp: string,
  ): Promise<void> {
    try {
      await respondRejected(this.client, event.topic, event.id, error);
    } catch {
      // Session already gone; the notice still tells the user what happened.
    }
    this.addNotice(
      `Declined ${event.params?.request?.method ?? 'a request'} from ${dapp}: ${error.message}`,
    );
  }

  onSessionDelete(event: { topic?: string }): void {
    const topic = event?.topic;
    if (typeof topic === 'string') {
      const name = this.dappName(topic);
      const dropped = this.queue.filter((i) => i.type === 'request' && i.event.topic === topic);
      this.queue = this.queue.filter((i) => !(i.type === 'request' && i.event.topic === topic));
      if (this.busyKey && dropped.some((i) => i.key === this.busyKey)) this.busyKey = null;
      this.addNotice(
        dropped.length > 0
          ? `${name} disconnected; its ${dropped.length} pending request(s) were cancelled.`
          : `${name} disconnected.`,
      );
    }
    this.refreshSessions();
  }

  onRequestExpire(event: { id?: number }): void {
    this.dropExpired(`r:${event?.id}`, 'request');
  }

  onProposalExpire(event: { id?: number }): void {
    this.dropExpired(`p:${event?.id}`, 'connection request');
  }

  dropExpired(key: string, label: string): void {
    const item = this.queue.find((i) => i.key === key);
    if (!item) return;
    this.queue = this.queue.filter((i) => i.key !== key);
    if (this.busyKey === key) this.busyKey = null;
    const who = item.type === 'request' ? this.dappName(item.event.topic) : item.summary.name;
    this.addNotice(`A ${label} from ${who} expired before it was answered.`);
  }

  // ---------------------------------------------------------- lock hold

  setLocked(locked: boolean): void {
    if (this.locked === locked) return;
    this.locked = locked;
    this.emit();
  }

  // ------------------------------------------------------- user actions

  /** True when `key` is the visible head, unlocked, and nothing is busy. */
  canAct(key: string): boolean {
    return !this.locked && this.busyKey === null && this.queue[0]?.key === key;
  }

  /**
   * Claims the head for an action (sets busy). Returns null — and does
   * nothing — while locked, while another action runs, or if `key` is no
   * longer the head (expired / session deleted meanwhile).
   */
  begin(key: string): WcQueueItem | null {
    if (!this.canAct(key)) return null;
    this.busyKey = key;
    this.emit();
    return this.queue[0]!;
  }

  /** Ends an action without removing the item (e.g. a send failed). */
  release(key: string): void {
    if (this.busyKey !== key) return;
    this.busyKey = null;
    this.emit();
  }

  /** Removes a finished item and clears busy. */
  complete(key: string): void {
    this.queue = this.queue.filter((i) => i.key !== key);
    if (this.busyKey === key) this.busyKey = null;
    this.emit();
  }

  /**
   * Re-checks a claimed request against the CURRENT active chain: a mode
   * switch between arrival and approval must not let the wallet sign for a
   * chain that is no longer active. Returns the decline to send, or null.
   */
  staleChainError(item: WcQueueItem): { code: number; message: string } | null {
    if (item.type !== 'request') return null;
    const { activeChain } = this.getContext();
    if (item.chain === activeChain) return null;
    return {
      code: WC_ERRORS.unsupportedChains.code,
      message:
        'The wallet mode changed while this request was waiting, so it was declined. ' +
        'Send it again from the dApp.',
    };
  }

  /**
   * Re-checks a claimed request against the CURRENT active account: an
   * account switch between arrival and approval must not let the wallet
   * sign with an account the session is not bound to. Returns the decline
   * to send, or null.
   */
  staleAccountError(item: WcQueueItem): { code: number; message: string } | null {
    if (item.type !== 'request') return null;
    const { address, labelFor } = this.getContext();
    if (address && address.toLowerCase() === item.address.toLowerCase()) return null;
    return {
      code: WC_ERRORS.unsupportedAccounts.code,
      message: accountMismatchMessage([item.address], address ?? '', labelFor),
    };
  }

  /**
   * Explicit user decline of the head. Requests get USER_REJECTED (or a
   * given error); proposals get USER_REJECTED, or the specific SDK error
   * when the wallet cannot serve them (declineProposal). Returns false if
   * the item could not be claimed (locked / not head / busy).
   */
  async decline(key: string, error?: { code: number; message: string }): Promise<boolean> {
    const item = this.begin(key);
    if (!item) return false;
    try {
      if (item.type === 'proposal') {
        const { address, activeChain } = this.getContext();
        await declineProposal(this.client, item.event, address ?? '', activeChain);
      } else {
        await respondRejected(this.client, item.event.topic, item.event.id, error);
      }
    } catch {
      // The dApp side may have expired it or disconnected; move on.
    } finally {
      this.complete(key);
    }
    return true;
  }
}
