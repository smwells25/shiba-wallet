import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { toHex } from '@shiba-wallet/chains-evm';
import { useTheme } from '../theme';
import { useAppLock } from '../components/LockGate';
import {
  WcApprovalSheet,
  txApprovalAllowed,
  type AaBundleLoader,
  type ConnectAs,
  type SmartAccountOption,
  type TxQuoteState,
} from '../components/WcApprovalSheet';
import { getEndpoint } from '../config/networks';
import { requireLocalAuth } from './biometric';
import { usePrefs } from './PrefsContext';
import { useWallet } from './WalletContext';
import { accountLabel } from './accounts';
import { EVM_CHAIN_ID, describeSendError, sendEvm } from './send';
import {
  aaAccountTypeSignsMessages,
  createAaClientFromConfig,
  describeAaError,
  fetchUserOpReceipt,
  getAaConfig,
  isAaConfigured,
  resolveAaSender,
  sendAa,
  signHashAsSmartAccount,
  waitForAaReceipt,
} from './aa';
import {
  ERC5792_ERRORS,
  WC_SMART_ACCOUNT_METHODS,
  WC_SUPPORTED_METHODS,
  approveProposal,
  callsStatusFromReceipt,
  disconnectWcSession,
  findCallsRecord,
  generateCallsId,
  getWcProjectId,
  getWcUsed,
  initWalletConnect,
  respondApproved,
  respondRejected,
  saveCallsRecord,
  sessionAccountNote,
  sessionModeNote,
  setWcUsed,
  shouldStartWalletConnectAtLaunch,
  signDigest,
  smartBindingKey,
  smartBindingLabel,
  type WcClient,
  type WcSessionSummary,
  type WcSmartBinding,
} from './walletconnect';
import { WcController, type WcControllerSnapshot, type WcQueueItem } from './wc-controller';

/**
 * App-level WalletConnect (phase 6, item 5): owns the WalletKit client,
 * the event listeners (via WcController) and the approval sheet, mounted
 * ONCE inside LockGate so requests surface on any screen. The Connections
 * screen keeps pairing and session management and reads everything from
 * this context.
 *
 * Startup cost: the SDK (compat shim first, then @reown/walletkit — the
 * order lives in initWalletConnect and is unchanged) is started at launch
 * only when shouldStartWalletConnectAtLaunch holds — a project id exists
 * AND WalletConnect has been used on this device (see the marker in
 * walletconnect.ts). Otherwise it stays unevaluated until the Connections
 * screen calls ensureStarted(). Nothing here runs before a wallet exists.
 *
 * Security:
 *  - no approval UI renders while the app is locked (useAppLock) or while
 *    no wallet is ready; queued items wait, untouched, until unlock;
 *  - EVERY approval passes requireLocalAuth, then re-claims the item from
 *    the controller (which refuses while locked or if the item is gone),
 *    then re-checks the item's chain against the active chain and its
 *    bound account against the active account;
 *  - keys are only reached through WalletContext.signWith, which signs
 *    only with the active account and only if that account controls
 *    exactly the session's bound address (multi-account, phase 6 item 3);
 *  - nothing is declined because time passed.
 *
 * Smart-account connections (phase 7 items 2 and 3): when the active chain
 * has a verified AA configuration, the proposal sheet offers "connect as
 * the smart account". The binding (owner, account index, type, factory) is
 * recorded BEFORE the session is approved. Its requests: personal_sign /
 * eth_signTypedData_v4 are signed through aa.ts signHashAsSmartAccount
 * (ERC-1271 envelope, ERC-6492 when undeployed; refused for SimpleAccount),
 * eth_sendTransaction and wallet_sendCalls are sent as ONE UserOperation
 * via sendAa, gated by the bundler estimate instead of eth_call. The signer
 * is always the OWNER EOA through signWith (expectAddress = owner), and the
 * smart-account address is re-derived from the current configuration and
 * compared with the binding before anything is signed.
 */

export interface WcSessionView extends WcSessionSummary {
  /** Non-null when the session belongs to the other wallet mode (paused). */
  modeNote: string | null;
  /** Non-null when the session is bound to a non-active account (paused). */
  accountNote: string | null;
  /** "Account 1 (0x9858…Eda94)" for the bound account, or null if unknown. */
  accountLabel: string | null;
}

interface WalletConnectContextValue {
  /** undefined while loading; null when unset (WalletConnect off). */
  projectId: string | null | undefined;
  client: WcClient | null;
  initBusy: boolean;
  initError: string | null;
  /** Starts the SDK if it is not running yet (lazy path). */
  ensureStarted: () => void;
  sessions: WcSessionView[];
  notices: readonly { id: number; text: string }[];
  dismissNotice: (id: number) => void;
  /** Pairs with a validated wc: URI (records the "used" marker first). */
  pair: (uri: string) => Promise<void>;
  disconnect: (topic: string) => Promise<void>;
}

const WalletConnectContext = createContext<WalletConnectContextValue | null>(null);

const EMPTY_SNAPSHOT: WcControllerSnapshot = {
  queue: [],
  head: null,
  locked: false,
  busyKey: null,
  sessions: [],
  notices: [],
  smartBindings: [],
};
const noopSubscribe = () => () => {};
const emptySnapshot = () => EMPTY_SNAPSHOT;

export function WalletConnectProvider({ children }: { children: React.ReactNode }) {
  const theme = useTheme();
  const { status, accounts, signWith, accountForEvmAddress, activeAccount } = useWallet();
  const { evmChain } = usePrefs();
  const { locked } = useAppLock();

  // The ACTIVE account's EVM address: new sessions are approved with it,
  // and only sessions bound to it are served.
  const ethAddress = accounts.find((a) => a.chainId === EVM_CHAIN_ID)?.address ?? null;
  const labelFor = useCallback(
    (address: string) => {
      const account = accountForEvmAddress(address);
      return account ? accountLabel(account.name, account.evmAddress) : null;
    },
    [accountForEvmAddress],
  );
  /**
   * The ACTIVE chain's verified smart-account bundle for one account index
   * (null when no complete AA configuration or RPC endpoint exists).
   */
  const loadAaBundle = useCallback<AaBundleLoader>(
    async (accountIndex: number) => {
      const config = await getAaConfig(evmChain.caip2);
      if (!isAaConfigured(config)) return null;
      const endpoint = await getEndpoint(EVM_CHAIN_ID);
      if (!endpoint?.url) return null;
      return {
        bundle: createAaClientFromConfig(config, {
          nodeUrl: endpoint.url,
          chainId: BigInt(evmChain.chainIdDecimal),
          accountIndex,
        }),
        url: endpoint.url,
      };
    },
    [evmChain.caip2, evmChain.chainIdDecimal],
  );

  const activeIndex = activeAccount?.index ?? null;
  const smartOption = useCallback(async (): Promise<SmartAccountOption | null> => {
    if (activeIndex === null || !ethAddress) return null;
    const loaded = await loadAaBundle(activeIndex);
    if (!loaded) return null;
    const address = await resolveAaSender(loaded.bundle, ethAddress);
    return {
      address,
      accountType: loaded.bundle.accountType,
      signsMessages: aaAccountTypeSignsMessages(loaded.bundle.accountType),
    };
  }, [activeIndex, ethAddress, loadAaBundle]);

  /** ERC-5792 wallet_getCallsStatus: batch store + one bundler lookup. */
  const lookupCallsStatus = useCallback(
    async (args: { id: string; from: string; dappUrl: string }) => {
      const record = await findCallsRecord(args.id, args.from, args.dappUrl);
      if (!record) {
        return {
          error: { code: ERC5792_ERRORS.unknownBundle, message: 'This bundle id is unknown.' },
        };
      }
      const config = await getAaConfig(record.chain);
      if (!config.bundlerUrl) {
        return {
          error: {
            code: -32603,
            message: 'No bundler is configured for that chain any more, so the status is unknown.',
          },
        };
      }
      const receipt = await fetchUserOpReceipt(config.bundlerUrl, record.userOpHash);
      return { result: callsStatusFromReceipt(record, receipt) };
    },
    [],
  );
  const callsIdKnown = useCallback(
    async (args: { id: string; from: string; dappUrl: string }) =>
      (await findCallsRecord(args.id, args.from, args.dappUrl)) !== null,
    [],
  );

  // The controller reads the live context through a ref, so an address,
  // account or mode change is seen by the next event without re-attaching
  // listeners.
  const contextRef = useRef({
    address: ethAddress,
    activeChain: evmChain.caip2,
    labelFor,
    lookupCallsStatus,
    callsIdKnown,
    activeIndex,
  });
  contextRef.current = {
    address: ethAddress,
    activeChain: evmChain.caip2,
    labelFor,
    lookupCallsStatus,
    callsIdKnown,
    activeIndex,
  };

  // Hold approvals while locked AND while no wallet is ready.
  const hold = locked || status !== 'ready';
  const holdRef = useRef(hold);
  holdRef.current = hold;

  const [projectId, setProjectId] = useState<string | null | undefined>(undefined);
  const [startRequested, setStartRequested] = useState(false);
  // Bumped by ensureStarted so a failed start is retried when the
  // Connections screen is reopened (the screen's error text says so).
  const [startNonce, setStartNonce] = useState(0);
  const [client, setClient] = useState<WcClient | null>(null);
  const [controller, setController] = useState<WcController | null>(null);
  const [initBusy, setInitBusy] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);

  // Launch decision, once a wallet exists.
  useEffect(() => {
    if (status !== 'ready') return;
    let cancelled = false;
    (async () => {
      const [id, used] = await Promise.all([getWcProjectId(), getWcUsed()]);
      if (cancelled) return;
      setProjectId(id);
      if (shouldStartWalletConnectAtLaunch(id, used)) setStartRequested(true);
    })().catch(() => {
      if (!cancelled) setProjectId(null);
    });
    return () => {
      cancelled = true;
    };
  }, [status]);

  const ensureStarted = useCallback(() => {
    // Re-read the id: Settings may have changed it since launch (a change
    // after a successful start still needs a restart — the start effect
    // below reports that as an error, shown on the Connections screen).
    getWcProjectId().then(
      (id) => {
        setProjectId(id);
        setStartRequested(true);
        setStartNonce((n) => n + 1);
      },
      () => setProjectId(null),
    );
  }, []);

  // Start the SDK and attach the controller exactly once for the life of
  // the app. The listeners are detached only when the provider unmounts —
  // NOT when wallet status changes (a wipe/re-import must not leave the
  // SDK running with nobody listening; the hold covers the no-wallet
  // window instead).
  const detachRef = useRef<(() => void) | null>(null);
  const startedProjectIdRef = useRef<string | null>(null);
  useEffect(
    () => () => {
      detachRef.current?.();
      detachRef.current = null;
    },
    [],
  );
  useEffect(() => {
    if (!startRequested || !projectId || status !== 'ready') return;
    if (startedProjectIdRef.current !== null) {
      if (startedProjectIdRef.current !== projectId) {
        setInitError(
          'WalletConnect was already started with a different project id. ' +
            'Restart the app to apply the new one.',
        );
      }
      return;
    }
    let cancelled = false;
    setInitBusy(true);
    setInitError(null);
    initWalletConnect(projectId).then(
      (c) => {
        // initWalletConnect caches its promise per project id, so a run
        // cancelled mid-init simply picks the same client up next time.
        if (cancelled || startedProjectIdRef.current !== null) return;
        startedProjectIdRef.current = projectId;
        const ctl = new WcController(c, () => contextRef.current, {
          locked: holdRef.current,
          // Smart-account bindings persist next to the app's other
          // WalletConnect state (public data only).
          bindingStore: AsyncStorage,
        });
        detachRef.current = ctl.attach();
        setClient(c);
        setController(ctl);
        setInitBusy(false);
      },
      (e) => {
        if (cancelled) return;
        setInitBusy(false);
        setInitError(e instanceof Error ? e.message : 'WalletConnect could not be initialized.');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [startRequested, startNonce, projectId, status]);

  useEffect(() => {
    controller?.setLocked(hold);
  }, [controller, hold]);

  const snapshot = useSyncExternalStore(
    controller ? controller.subscribe : noopSubscribe,
    controller ? controller.getSnapshot : emptySnapshot,
  );

  // Keep the launch marker in step with what the SDK reports.
  const hasPendingProposal = snapshot.queue.some((i) => i.type === 'proposal');
  useEffect(() => {
    if (!controller) return;
    if (snapshot.sessions.length > 0) void setWcUsed(true).catch(() => {});
    else if (!hasPendingProposal) void setWcUsed(false).catch(() => {});
  }, [controller, snapshot.sessions.length, hasPendingProposal]);

  const pair = useCallback(
    async (uri: string) => {
      if (!client) throw new Error('WalletConnect is not running yet.');
      await setWcUsed(true).catch(() => {});
      await client.pair({ uri });
    },
    [client],
  );

  const disconnect = useCallback(
    async (topic: string) => {
      if (!client) return;
      try {
        await disconnectWcSession(client, topic);
      } catch {
        // Relay hiccups must not leave a ghost row; refresh regardless.
      }
      controller?.refreshSessions();
    },
    [client, controller],
  );

  // ------------------------------------------------------------ approvals

  /**
   * Approval of a request on a smart-account session (after the biometric
   * gate, the re-claim and the chain/account re-checks above).
   */
  const approveSmartRequest = useCallback(
    async (
      item: Extract<WcQueueItem, { type: 'request' }>,
      smart: WcSmartBinding,
      txQuote: TxQuoteState | null,
    ): Promise<void> => {
      if (!controller || !client) return;
      const declineWith = async (message: string, code = -32603) => {
        controller.release(item.key);
        await controller.decline(item.key, { code, message });
        Alert.alert('Request declined', message);
      };
      try {
        if (item.parsed.kind === 'personal_sign' || item.parsed.kind === 'typed_data') {
          const loaded = await loadAaBundle(smart.accountIndex);
          if (
            !loaded ||
            loaded.bundle.accountType !== smart.accountType ||
            loaded.bundle.factory.toLowerCase() !== smart.factory.toLowerCase()
          ) {
            await declineWith(
              'The smart-account settings changed since this connection was made, so the ' +
                'connected smart account cannot sign. Reconnect the dApp.',
            );
            return;
          }
          const digest =
            item.parsed.kind === 'personal_sign' ? item.parsed.digest : item.parsed.typedData.digest;
          // The OWNER key signs; signHashAsSmartAccount refuses unless the
          // owner's smart account is exactly the session's bound address.
          const signature = await signWith(EVM_CHAIN_ID, smart.owner, (signer) =>
            signHashAsSmartAccount(loaded.bundle, signer, digest, smart.address),
          );
          await respondApproved(client, item.event.topic, item.event.id, toHex(signature.signature));
          controller.complete(item.key);
          return;
        }

        if (
          txQuote?.status !== 'ready-aa' ||
          txQuote.quote.sender.toLowerCase() !== smart.address.toLowerCase() ||
          txQuote.owner.toLowerCase() !== smart.owner.toLowerCase()
        ) {
          controller.release(item.key);
          return;
        }
        const { quote, bundle } = txQuote;
        const dappUrl = controller.dappUrl(item.event.topic);

        if (item.parsed.kind === 'calls') {
          const batch = item.parsed.batch;
          if (
            batch.id !== null &&
            (await findCallsRecord(batch.id, smart.address, dappUrl)) !== null
          ) {
            await declineWith('There is already a batch submitted with this id.', ERC5792_ERRORS.duplicateId);
            return;
          }
          const { userOpHash } = await signWith(EVM_CHAIN_ID, smart.owner, (signer) =>
            sendAa(bundle, signer, quote),
          );
          // ERC-5792: the id is returned once the bundler accepted the
          // operation; inclusion is NOT awaited.
          const random = new Uint8Array(32);
          globalThis.crypto.getRandomValues(random);
          const id = batch.id ?? generateCallsId(random, userOpHash);
          await saveCallsRecord({
            id,
            userOpHash,
            chain: item.chain,
            from: smart.address,
            dappUrl,
            createdAt: Date.now(),
          }).catch(() => undefined);
          try {
            await respondApproved(client, item.event.topic, item.event.id, { id });
          } catch {
            controller.complete(item.key);
            Alert.alert(
              'Batch sent, dApp not notified',
              `The operation was submitted (UserOperation ${userOpHash}), but the reply to the ` +
                'dApp failed. Check it in an ERC-4337 explorer before retrying anything.',
            );
            return;
          }
          controller.complete(item.key);
          Alert.alert('Batch sent to the bundler', `UserOperation ${userOpHash}`);
          return;
        }

        if (item.parsed.kind !== 'transaction') {
          controller.release(item.key);
          return;
        }
        // eth_sendTransaction: ONE call through the smart account. The dApp
        // expects a transaction hash, so wait for inclusion and answer with
        // the bundle transaction's hash — never with the userOpHash, which
        // eth_getTransactionReceipt would not find.
        const { userOpHash } = await signWith(EVM_CHAIN_ID, smart.owner, (signer) =>
          sendAa(bundle, signer, quote),
        );
        let txHash: string | null = null;
        try {
          const { summary } = await waitForAaReceipt(bundle, userOpHash, {
            timeoutMs: 120_000,
            pollMs: 3_000,
          });
          txHash = summary.txHash;
        } catch {
          txHash = null;
        }
        if (!txHash) {
          await respondRejected(client, item.event.topic, item.event.id, {
            code: -32603,
            message:
              `Submitted as UserOperation ${userOpHash}, but no transaction hash was ` +
              'available within two minutes. It may still be included.',
          }).catch(() => undefined);
          controller.complete(item.key);
          Alert.alert(
            'Submitted, not yet included',
            `UserOperation ${userOpHash} was accepted by the bundler but not included within ` +
              'two minutes, so the dApp was told no transaction hash is available yet. Look the ' +
              'UserOperation hash up in an ERC-4337 explorer before retrying anything.',
          );
          return;
        }
        try {
          await respondApproved(client, item.event.topic, item.event.id, txHash);
        } catch {
          controller.complete(item.key);
          Alert.alert(
            'Transaction sent, dApp not notified',
            `The operation was included (${txHash}), but the reply to the dApp failed.`,
          );
          return;
        }
        controller.complete(item.key);
        Alert.alert('Transaction sent', txHash);
      } catch (e) {
        controller.release(item.key);
        const { title, detail } =
          describeAaError(e, {
            accountType: smart.accountType === 'kernel-v3.3' ? 'kernel-v3.3' : 'simple',
            deployed: txQuote?.status === 'ready-aa' ? txQuote.quote.deployed : null,
          }) ?? describeSendError(e, 'ETH');
        Alert.alert(title, detail);
      }
    },
    [controller, client, signWith, loadAaBundle],
  );

  const onApprove = useCallback(
    async (
      item: WcQueueItem,
      txQuote: TxQuoteState | null,
      overrideSimulation: boolean,
      connectAs: ConnectAs = 'eoa',
    ) => {
      if (!controller || !client) return;
      if (!controller.canAct(item.key)) return;
      const address = contextRef.current.address;
      if (!address) return;

      if (item.type === 'proposal') {
        const auth = await requireLocalAuth(`Connect to ${item.summary.name}`);
        if (!auth.ok) {
          Alert.alert('Not connected', auth.message);
          return;
        }
        if (!controller.begin(item.key)) return; // locked or gone meanwhile
        try {
          const activeChain = contextRef.current.activeChain;
          let connectAddress = address;
          let methods = WC_SUPPORTED_METHODS;
          if (connectAs === 'smart') {
            // Re-derive the smart account from the CURRENT configuration
            // (never from what the sheet displayed) and record the binding
            // before approving, so the first request already finds it.
            const index = contextRef.current.activeIndex;
            const loaded = index === null ? null : await loadAaBundle(index);
            if (!loaded || index === null) {
              throw new Error('No verified smart-account configuration exists for the active chain.');
            }
            connectAddress = await resolveAaSender(loaded.bundle, address);
            const binding: WcSmartBinding = {
              chain: activeChain,
              address: connectAddress,
              owner: address,
              accountIndex: index,
              accountType: loaded.bundle.accountType,
              factory: loaded.bundle.factory,
            };
            await controller.rememberSmartBinding(binding);
            methods = WC_SMART_ACCOUNT_METHODS;
          }
          const outcome = await approveProposal(
            client,
            item.event,
            connectAddress,
            activeChain,
            methods,
          );
          if (!outcome.approved) Alert.alert('Connection rejected', outcome.reason);
        } catch (e) {
          Alert.alert('Connection failed', e instanceof Error ? e.message : 'Approval failed.');
        } finally {
          // Sessions first, so the launch marker never sees a transient
          // "no sessions and no pending proposal" state.
          controller.refreshSessions();
          controller.complete(item.key);
        }
        return;
      }

      if (
        (item.parsed.kind === 'transaction' || item.parsed.kind === 'calls') &&
        !txApprovalAllowed(txQuote, overrideSimulation)
      ) {
        return;
      }
      const dapp = controller.dappName(item.event.topic);
      const promptTitle =
        item.parsed.kind === 'transaction'
          ? `Approve transaction for ${dapp}`
          : item.parsed.kind === 'calls'
            ? `Approve batch for ${dapp}`
            : `Sign for ${dapp}`;
      const auth = await requireLocalAuth(promptTitle);
      if (!auth.ok) {
        Alert.alert('Not approved', auth.message);
        return;
      }
      if (!controller.begin(item.key)) return; // locked or gone meanwhile
      const stale = controller.staleChainError(item) ?? controller.staleAccountError(item);
      if (stale) {
        // Release and immediately re-claim through decline() (same tick, so
        // nothing can interleave) to answer with the stale error
        // (UNSUPPORTED_CHAINS for a mode switch, UNSUPPORTED_ACCOUNTS for an
        // account switch).
        controller.release(item.key);
        await controller.decline(item.key, stale);
        Alert.alert('Request declined', stale.message);
        return;
      }
      if (item.smart) {
        await approveSmartRequest(item, item.smart, txQuote);
        return;
      }
      try {
        if (item.parsed.kind === 'calls') {
          controller.release(item.key);
          return; // batches exist only on smart-account sessions
        }
        if (item.parsed.kind === 'personal_sign' || item.parsed.kind === 'typed_data') {
          const digest =
            item.parsed.kind === 'personal_sign' ? item.parsed.digest : item.parsed.typedData.digest;
          // Signs only if the active account controls exactly the
          // session's bound address (re-checked just above).
          const signature = await signWith(EVM_CHAIN_ID, item.address, async (signer) =>
            signDigest(signer, digest),
          );
          await respondApproved(client, item.event.topic, item.event.id, signature);
          controller.complete(item.key);
          return;
        }
        // Transaction: sign + broadcast through the existing EOA machinery,
        // then hand the transaction hash back to the dApp.
        if (
          txQuote?.status !== 'ready' ||
          txQuote.from.toLowerCase() !== item.address.toLowerCase()
        ) {
          controller.release(item.key);
          return;
        }
        const { quote, url } = txQuote;
        const sent = await signWith(EVM_CHAIN_ID, item.address, (signer) =>
          sendEvm(url, signer, quote, evmChain.explorerTxBase),
        );
        // The transaction is on the network from here on. A failed relay
        // reply must not be reported as a failed send, and the item must not
        // return to the queue as if nothing had happened.
        try {
          await respondApproved(client, item.event.topic, item.event.id, sent.txid);
        } catch {
          controller.complete(item.key);
          Alert.alert(
            'Transaction sent, dApp not notified',
            `The transaction was broadcast (${sent.txid}), but the reply to the dApp failed. ` +
              'The dApp may not show it; check the transaction in a block explorer before retrying anything.',
          );
          return;
        }
        controller.complete(item.key);
        Alert.alert('Transaction sent', sent.txid);
      } catch (e) {
        controller.release(item.key);
        const { title, detail } = describeSendError(e, 'ETH');
        Alert.alert(title, detail);
      }
    },
    [controller, client, signWith, evmChain.explorerTxBase, loadAaBundle, approveSmartRequest],
  );

  const onReject = useCallback(
    (item: WcQueueItem) => {
      if (!controller) return;
      void controller.decline(item.key);
    },
    [controller],
  );

  const sessions = useMemo<WcSessionView[]>(() => {
    const bindings = new Map(
      snapshot.smartBindings.map((b) => [smartBindingKey(b.chain, b.address), b] as const),
    );
    return snapshot.sessions.map((s) => {
      let smart: WcSmartBinding | null = null;
      for (const chain of s.chains) {
        for (const a of s.addresses) smart = smart ?? bindings.get(smartBindingKey(chain, a)) ?? null;
      }
      if (smart) {
        const ownerLabel = labelFor(smart.owner) ?? smart.owner;
        return {
          ...s,
          modeNote: sessionModeNote(s.chains, evmChain.caip2),
          accountNote:
            ethAddress && smart.owner.toLowerCase() !== ethAddress.toLowerCase()
              ? `This connection belongs to the smart account of ${ownerLabel}. Paused while ` +
                `another account is active: its requests are declined until you switch back.`
              : null,
          accountLabel: smartBindingLabel(smart, labelFor),
        };
      }
      return {
        ...s,
        modeNote: sessionModeNote(s.chains, evmChain.caip2),
        accountNote: sessionAccountNote(s.addresses, ethAddress, labelFor),
        accountLabel: s.addresses[0] ? labelFor(s.addresses[0]) : null,
      };
    });
  }, [snapshot.sessions, snapshot.smartBindings, evmChain.caip2, ethAddress, labelFor]);

  const value = useMemo<WalletConnectContextValue>(
    () => ({
      projectId,
      client,
      initBusy,
      initError,
      ensureStarted,
      sessions,
      notices: snapshot.notices,
      dismissNotice: (id: number) => controller?.dismissNotice(id),
      pair,
      disconnect,
    }),
    [projectId, client, initBusy, initError, ensureStarted, sessions, snapshot.notices, controller, pair, disconnect],
  );

  const head = hold ? null : snapshot.head;
  const latestNotice = !hold && !head ? (snapshot.notices[0] ?? null) : null;
  const [seenNoticeId, setSeenNoticeId] = useState(0);

  return (
    <WalletConnectContext.Provider value={value}>
      <View style={styles.fill}>
        {children}
        {latestNotice && latestNotice.id > seenNoticeId ? (
          <View
            style={[styles.notice, { backgroundColor: theme.card, borderColor: theme.border }]}
            accessibilityLiveRegion="polite"
          >
            <Text style={[styles.noticeTitle, { color: theme.text }]}>WalletConnect</Text>
            <Text style={[styles.noticeText, { color: theme.text }]}>{latestNotice.text}</Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => setSeenNoticeId(latestNotice.id)}
              hitSlop={8}
            >
              <Text style={[styles.noticeDismiss, { color: theme.accent }]}>Dismiss</Text>
            </Pressable>
          </View>
        ) : null}
        {head ? (
          <WcApprovalSheet
            key={head.key}
            item={head}
            dappName={
              head.type === 'request' ? (controller?.dappName(head.event.topic) ?? 'Unknown dApp') : head.summary.name
            }
            busy={snapshot.busyKey === head.key}
            evmChain={evmChain}
            address={head.type === 'request' ? head.address : ethAddress}
            accountLabel={(() => {
              // Smart-account requests are labeled with their OWNER account.
              const shown =
                head.type === 'request' ? (head.smart ? head.smart.owner : head.address) : ethAddress;
              return shown ? (labelFor(shown) ?? shown) : null;
            })()}
            smartOption={smartOption}
            loadAaBundle={loadAaBundle}
            onApprove={(q, o, c) => void onApprove(head, q, o, c)}
            onReject={() => onReject(head)}
          />
        ) : null}
      </View>
    </WalletConnectContext.Provider>
  );
}

export function useWalletConnect(): WalletConnectContextValue {
  const ctx = useContext(WalletConnectContext);
  if (!ctx) throw new Error('useWalletConnect must be used inside WalletConnectProvider');
  return ctx;
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  notice: {
    position: 'absolute',
    top: 56,
    left: 16,
    right: 16,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    gap: 6,
    elevation: 4,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  noticeTitle: {
    fontSize: 13,
    fontWeight: '700',
  },
  noticeText: {
    fontSize: 14,
    lineHeight: 20,
  },
  noticeDismiss: {
    fontSize: 14,
    fontWeight: '600',
    alignSelf: 'flex-end',
  },
});
