import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { parseSessionKeyGrant, toHex, type KernelPermissionInstall, type SessionKeyGrant } from '@shiba-wallet/chains-evm';
import type { RootStackParamList } from '../navigation';
import { Button, TestNetworksOnlyCard, WarningBox, screenStyle } from '../components';
import { ContactPicker, RecipientContactNotice } from '../components/Contacts';
import { GrantReview } from '../components/SessionGrantViews';
import { useTheme, type Theme } from '../theme';
import { getEndpoint } from '../config/networks';
import { useWallet } from '../wallet/WalletContext';
import { usePrefs } from '../wallet/PrefsContext';
import { requireLocalAuth } from '../wallet/biometric';
import { formatUnits } from '../wallet/balances';
import { EVM_CHAIN_ID, describeSendError } from '../wallet/send';
import {
  createAaClientFromConfig,
  describeAaError,
  getAaConfig,
  sendAa,
  summarizeAaReceipt,
  type AaClientBundle,
  type AaSendQuote,
} from '../wallet/aa';
import { findExactContact, listContacts, matchRecipient, type Contact } from '../wallet/contacts';
import { sessionKeyVault } from '../wallet/storage';
import { readinessGate } from '../config/readiness';
import {
  SESSIONS_AUDIT_NOTE,
  SESSIONS_INSTALL_MODE_NOTE,
  SESSIONS_WIPE_WARNING,
  SESSION_EXPIRY_PRESETS,
  buildManualGrant,
  finalizeSessionInstall,
  finalizeSessionRevoke,
  forgetSession,
  installSession,
  loadSessionsFor,
  newSessionKey,
  pendingSessionOperation,
  prepareSessionInstall,
  prepareSessionRevoke,
  readSessionStatus,
  resetSessions,
  resolveSessionAccount,
  revokeSession,
  sendSessionCalls,
  sessionLocalStatusText,
  sessionRecordKey,
  sessionStatusText,
  sessionTestCall,
  validateGrantForAccount,
  type AllowedCallDraft,
  type SessionAccountResolution,
  type SessionChainStatus,
  type SessionRecord,
} from '../wallet/sessions';

type Props = NativeStackScreenProps<RootStackParamList, 'Sessions'>;

type Phase = 'list' | 'form' | 'quoting' | 'confirm' | 'sending' | 'revoke-confirm' | 'progress';

const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });
const EMPTY_DRAFT: AllowedCallDraft = { target: '', selector: '', valueCapEth: '' };

interface PendingInstall {
  /** In memory only until the install is submitted (then in the vault) or discarded (zeroed). */
  privateKey: Uint8Array;
  grant: SessionKeyGrant;
  install: KernelPermissionInstall;
  quote: AaSendQuote;
}

interface Progress {
  kind: 'install' | 'revoke' | 'test';
  userOpHash: string;
  state: 'pending' | 'done' | 'failed' | 'timeout';
  txHash: string | null;
  detail: string | null;
}

/**
 * Sessions (phase 8 item 2, app half): grant, test and revoke session keys
 * on the active account's Kernel account (a deployed Kernel v3.3 smart
 * account, or the EOA upgraded to Kernel v3.3 with EIP-7702) on the active
 * EVM chain. See ../wallet/sessions.ts for the storage and signing rules:
 * session private keys live only in expo-secure-store; the install and the
 * revocation are ordinary root-signed smart-account operations through the
 * normal confirm idioms (bundler estimate gate, network badge, fee,
 * biometric gate, signWith with expectAddress = the owner EOA); a session
 * operation is signed by the session key alone and never touches the owner
 * key.
 */
export function SessionsScreen({ navigation }: Props) {
  const theme = useTheme();
  const { accounts, activeAccount, signWith } = useWallet();
  const { evmChain } = usePrefs();
  const owner = accounts.find((a) => a.chainId === EVM_CHAIN_ID)?.address ?? null;
  const symbol = evmChain.displaySymbol;
  // Mainnet readiness (config/readiness.ts): session keys are test-network
  // only. Status reads, revoking and forgetting stay available; sessions.ts
  // refuses granting and using a session too.
  const readiness = readinessGate('session-keys', evmChain.caip2);

  const [bundle, setBundle] = useState<AaClientBundle | null>(null);
  const [resolution, setResolution] = useState<SessionAccountResolution | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [records, setRecords] = useState<SessionRecord[]>([]);
  const [listFlags, setListFlags] = useState<{ corrupt: boolean; unreadable: boolean }>({ corrupt: false, unreadable: false });
  const [statuses, setStatuses] = useState<Record<string, SessionChainStatus | 'loading'>>({});
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactsNetworkId, setContactsNetworkId] = useState<string | null>(null);

  const [phase, setPhase] = useState<Phase>('list');
  const [drafts, setDrafts] = useState<AllowedCallDraft[]>([{ ...EMPTY_DRAFT }]);
  const [expirySeconds, setExpirySeconds] = useState(SESSION_EXPIRY_PRESETS[1]!.seconds);
  const [gasBudgetEth, setGasBudgetEth] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [pickerFor, setPickerFor] = useState<number | null>(null);
  const pending = useRef<PendingInstall | null>(null);
  const [pendingView, setPendingView] = useState<PendingInstall | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<{ record: SessionRecord; quote: AaSendQuote } | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);

  useEffect(() => {
    navigation.setOptions({ title: 'Sessions' });
  }, [navigation]);

  /** Zeroes and drops an unsubmitted session key. */
  const discardPending = useCallback(() => {
    pending.current?.privateKey.fill(0);
    pending.current = null;
    setPendingView(null);
  }, []);
  useEffect(() => discardPending, [discardPending]);

  const account = resolution?.ok ? resolution.account : null;

  // Resolve the active account's Kernel account through the AA bundle.
  // State is set only from promise callbacks (never synchronously in the
  // effect), per the react-hooks lint rules this app follows.
  const setup = useCallback(() => {
    if (!owner || !activeAccount) return;
    loadSessionContext(owner, activeAccount.index, evmChain.caip2, BigInt(evmChain.chainIdDecimal)).then(
      (ctx) => {
        setSetupError(null);
        setContactsNetworkId(ctx.contactsNetworkId);
        setBundle(ctx.bundle);
        setResolution(ctx.resolution);
      },
      (e: unknown) => setSetupError(e instanceof Error ? e.message : String(e)),
    );
  }, [owner, activeAccount, evmChain.caip2, evmChain.chainIdDecimal]);
  useEffect(setup, [setup]);

  // Operations this screen instance is already waiting for (its own sends,
  // and ones resumed from the stored list below), by userOpHash.
  const waitingFor = useRef(new Set<string>());
  const reloadRef = useRef<() => void>(() => undefined);
  const reloadList = useCallback(() => {
    if (!account) return;
    loadSessionsFor(evmChain.caip2, account).then(
      (load) => {
        setRecords(load.records);
        setListFlags({ corrupt: load.corrupt, unreadable: load.unreadable });
        if (!bundle) return;
        for (const r of load.records) {
          const key = sessionRecordKey(r.chain, r.account, r.permissionId);
          setStatuses((prev) => ({ ...prev, [key]: 'loading' }));
          void readSessionStatus(bundle.node, r).then((st) => setStatuses((prev) => ({ ...prev, [key]: st })));
          // An install or revocation that was sent but never settled — the
          // screen that sent it was closed or remounted while it waited (the
          // phase 10 emulator run lost the install's success screen that
          // way) — is resumed from the stored record, so its hash and outcome
          // are never lost.
          const op = pendingSessionOperation(r);
          if (op && !waitingFor.current.has(op.userOpHash)) {
            waitingFor.current.add(op.userOpHash);
            const settle = op.kind === 'install' ? finalizeSessionInstall : finalizeSessionRevoke;
            void settle(bundle, r, AsyncStorage).then(
              () => reloadRef.current(),
              // Not included yet (or unreadable): "Refresh status" tries again.
              () => waitingFor.current.delete(op.userOpHash),
            );
          }
        }
      },
      () => setListFlags({ corrupt: true, unreadable: true }),
    );
  }, [account, bundle, evmChain.caip2]);
  useEffect(() => {
    reloadRef.current = reloadList;
  }, [reloadList]);
  useEffect(reloadList, [reloadList]);

  useEffect(() => {
    if (!contactsNetworkId) return;
    listContacts(contactsNetworkId).then(setContacts, () => setContacts([]));
  }, [contactsNetworkId]);
  const nameFor = useCallback(
    (address: string) => (contactsNetworkId ? (findExactContact(contactsNetworkId, address, contacts)?.name ?? null) : null),
    [contacts, contactsNetworkId],
  );

  // ------------------------------------------------------------ actions

  const onReview = async () => {
    if (!bundle || !account || !owner) return;
    setFormError(null);
    discardPending();
    const key = newSessionKey();
    let grant: SessionKeyGrant;
    const now = Math.floor(Date.now() / 1000);
    try {
      grant = buildManualGrant({ sessionKey: key.address, drafts, expirySeconds, gasBudgetEth, now });
    } catch (e) {
      key.privateKey.fill(0);
      setFormError(e instanceof Error ? e.message : String(e));
      return;
    }
    // The engine's refusal (self-calls, wildcard targets, duplicates, the
    // window) is shown verbatim.
    const refusal = validateGrantForAccount(grant, account, now);
    if (refusal) {
      key.privateKey.fill(0);
      setFormError(refusal);
      return;
    }
    setPhase('quoting');
    try {
      const { install, quote } = await prepareSessionInstall(bundle, owner, account, grant, { now });
      pending.current = { privateKey: key.privateKey, grant, install, quote };
      setPendingView(pending.current);
      setPhase('confirm');
    } catch (e) {
      key.privateKey.fill(0);
      const { title, detail } =
        describeAaError(e, { accountType: bundle.accountType, deployed: true }) ?? describeSendError(e, symbol);
      setFormError(`${title}\n${detail}`);
      setPhase('form');
    }
  };

  const onInstall = async () => {
    const p = pending.current;
    if (!p || !bundle || !account || !owner || !resolution?.ok || !activeAccount) return;
    const auth = await requireLocalAuth('Approve granting this session');
    if (!auth.ok) {
      Alert.alert('Not granted', auth.message);
      return;
    }
    setPhase('sending');
    try {
      const { record, userOpHash } = await installSession({
        quote: p.quote,
        install: p.install,
        grant: p.grant,
        chain: evmChain.caip2,
        account,
        owner,
        accountIndex: activeAccount.index,
        accountKind: resolution.kind,
        label: 'Manual',
        source: 'manual',
        sessionPrivateKey: p.privateKey,
        store: AsyncStorage,
        vault: sessionKeyVault,
        // The OWNER key signs the install (root validator), only for the
        // owner EOA the quote was prepared for.
        submit: (q) => signWith(EVM_CHAIN_ID, owner, (signer) => sendAa(bundle, signer, q)),
      });
      discardPending();
      waitingFor.current.add(userOpHash);
      setProgress({ kind: 'install', userOpHash, state: 'pending', txHash: null, detail: null });
      setPhase('progress');
      void finalizeSessionInstall(bundle, record, AsyncStorage).then(
        ({ receipt, status }) =>
          setProgress((prev) =>
            prev && prev.userOpHash === userOpHash
              ? {
                  ...prev,
                  state: receipt.success === false ? 'failed' : 'done',
                  txHash: receipt.txHash,
                  detail: sessionStatusText(status),
                }
              : prev,
          ),
        () => setProgress((prev) => (prev && prev.userOpHash === userOpHash ? { ...prev, state: 'timeout' } : prev)),
      );
      reloadList();
    } catch (e) {
      const { title, detail } =
        describeAaError(e, { accountType: bundle.accountType, deployed: true }) ?? describeSendError(e, symbol);
      Alert.alert(title, detail);
      setPhase('confirm');
      reloadList();
    }
  };

  const onTest = async (record: SessionRecord, callIndex: number) => {
    if (!bundle) return;
    const grant = parseSessionKeyGrant(record.grant);
    const allowed = grant.calls[callIndex];
    if (!allowed) return;
    const call = sessionTestCall(allowed);
    Alert.alert(
      'Test this session?',
      `The SESSION key (not your account key) signs one operation: call ${call.to} with ` +
        `${call.data.length === 0 ? 'no data' : `only the selector ${toHex(call.data)} (no arguments)`} and 0 ${symbol}. ` +
        `Gas is paid by ${record.account}. A call with a selector but no arguments may be refused by the ` +
        'target contract; the bundler’s message is shown as returned.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Send test',
          onPress: () => {
            void (async () => {
              const auth = await requireLocalAuth('Approve a session-key test operation');
              if (!auth.ok) {
                Alert.alert('Not sent', auth.message);
                return;
              }
              try {
                const { userOpHash, client } = await sendSessionCalls({
                  bundle,
                  record,
                  calls: [call],
                  vault: sessionKeyVault,
                });
                setProgress({ kind: 'test', userOpHash, state: 'pending', txHash: null, detail: null });
                setPhase('progress');
                void client.waitForReceipt(userOpHash, { timeoutMs: 120_000, pollMs: 3_000 }).then(
                  (raw) => {
                    const s = summarizeAaReceipt(raw);
                    setProgress((prev) =>
                      prev && prev.userOpHash === userOpHash
                        ? { ...prev, state: s.success === false ? 'failed' : 'done', txHash: s.txHash }
                        : prev,
                    );
                  },
                  () => setProgress((prev) => (prev && prev.userOpHash === userOpHash ? { ...prev, state: 'timeout' } : prev)),
                );
              } catch (e) {
                Alert.alert('Session test refused', e instanceof Error ? e.message : String(e));
              }
            })();
          },
        },
      ],
    );
  };

  const onRevokeQuote = async (record: SessionRecord) => {
    if (!bundle || !owner) return;
    try {
      const quote = await prepareSessionRevoke(bundle, owner, record);
      setRevokeTarget({ record, quote });
      setPhase('revoke-confirm');
    } catch (e) {
      const { title, detail } =
        describeAaError(e, { accountType: bundle.accountType, deployed: true }) ?? describeSendError(e, symbol);
      Alert.alert(title, detail);
    }
  };

  const onRevoke = async () => {
    if (!revokeTarget || !bundle || !owner) return;
    const auth = await requireLocalAuth('Approve revoking this session');
    if (!auth.ok) {
      Alert.alert('Not revoked', auth.message);
      return;
    }
    setPhase('sending');
    try {
      const { record, userOpHash } = await revokeSession({
        record: revokeTarget.record,
        quote: revokeTarget.quote,
        store: AsyncStorage,
        vault: sessionKeyVault,
        submit: (q) => signWith(EVM_CHAIN_ID, owner, (signer) => sendAa(bundle, signer, q)),
      });
      setRevokeTarget(null);
      waitingFor.current.add(userOpHash);
      setProgress({ kind: 'revoke', userOpHash, state: 'pending', txHash: null, detail: null });
      setPhase('progress');
      void finalizeSessionRevoke(bundle, record, AsyncStorage).then(
        ({ receipt, status }) =>
          setProgress((prev) =>
            prev && prev.userOpHash === userOpHash
              ? {
                  ...prev,
                  state: receipt.success === false ? 'failed' : 'done',
                  txHash: receipt.txHash,
                  detail: sessionStatusText(status),
                }
              : prev,
          ),
        () => setProgress((prev) => (prev && prev.userOpHash === userOpHash ? { ...prev, state: 'timeout' } : prev)),
      );
      reloadList();
    } catch (e) {
      const { title, detail } =
        describeAaError(e, { accountType: bundle.accountType, deployed: true }) ?? describeSendError(e, symbol);
      Alert.alert(title, detail);
      setPhase('revoke-confirm');
    }
  };

  const onForget = (record: SessionRecord) => {
    if (!bundle) return;
    Alert.alert('Forget this session?', 'It is removed from this list (and its key from this device).', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Forget',
        style: 'destructive',
        onPress: () => {
          forgetSession({ record, node: bundle.node, store: AsyncStorage, vault: sessionKeyVault }).then(
            () => reloadList(),
            (e: unknown) => Alert.alert('Kept', e instanceof Error ? e.message : String(e)),
          );
        },
      },
    ]);
  };

  const onResetList = () => {
    Alert.alert(
      'Reset the session list?',
      'The unreadable list is cleared. This does NOT revoke anything on-chain: grants stay active until ' +
        'they expire, and the session keys the old list referenced stay unused in secure storage.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Reset', style: 'destructive', onPress: () => void resetSessions().then(reloadList, reloadList) },
      ],
    );
  };

  const draftMatches = useMemo(
    () =>
      drafts.map((d) =>
        contactsNetworkId && d.target.trim() ? matchRecipient(contactsNetworkId, d.target, contacts) : null,
      ),
    [drafts, contacts, contactsNetworkId],
  );

  // ------------------------------------------------------------ render

  const header = (
    <>
      <Text style={[styles.networkLine, { color: theme.textMuted }]}>
        {evmChain.label}
        {evmChain.testnet ? ' · TESTNET' : ''} · chain id {evmChain.chainIdDecimal}
      </Text>
      <Row label="Owner account (installs and revokes)" value={activeAccount?.name ?? 'Account'} sub={owner} theme={theme} />
      {resolution?.ok ? (
        <Row
          label={resolution.kind === 'kernel-7702' ? 'Kernel account (your upgraded address)' : 'Kernel smart account'}
          value={resolution.account}
          mono
          theme={theme}
        />
      ) : null}
    </>
  );

  if (phase === 'progress' && progress) {
    const what =
      progress.kind === 'install' ? 'Session install' : progress.kind === 'revoke' ? 'Revocation' : 'Session test operation';
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <Text style={[styles.title, { color: theme.success }]}>{what} sent to the bundler</Text>
        <Text style={[styles.label, { color: theme.textMuted }]}>UserOperation hash</Text>
        <Text selectable style={[styles.monoText, { color: theme.text }]}>
          {progress.userOpHash}
        </Text>
        {progress.kind === 'test' ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>Signed by the session key only.</Text>
        ) : null}
        {progress.state === 'pending' ? (
          <View style={styles.center}>
            <ActivityIndicator color={theme.accent} />
            <Text style={[styles.hint, { color: theme.textMuted }]}>Bundling… waiting for the receipt.</Text>
          </View>
        ) : null}
        {progress.state === 'done' ? (
          <Text style={[styles.ok, { color: theme.success }]}>
            Included on-chain — succeeded.{progress.detail ? ` Status: ${progress.detail}.` : ''}
          </Text>
        ) : null}
        {progress.state === 'failed' ? (
          <WarningBox>
            Included, but the operation reverted.{progress.detail ? ` Status: ${progress.detail}.` : ''}
          </WarningBox>
        ) : null}
        {progress.state === 'timeout' ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            Not included within two minutes. It may still be included; the list reads the status from the chain.
          </Text>
        ) : null}
        {progress.txHash ? (
          <Button
            title="View bundle transaction"
            variant="secondary"
            onPress={() => void Linking.openURL(`${evmChain.explorerTxBase}${progress.txHash}`)}
          />
        ) : null}
        <Button
          title="Done"
          onPress={() => {
            setProgress(null);
            setPhase('list');
            reloadList();
          }}
        />
      </ScrollView>
    );
  }

  if ((phase === 'confirm' || phase === 'sending') && pendingView && account) {
    const q = pendingView.quote;
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <NetworkBadge label={evmChain.label} testnet={evmChain.testnet} theme={theme} />
        <Text style={[styles.title, { color: theme.text }]}>Grant this session?</Text>
        {header}
        <GrantReview
          grant={pendingView.grant}
          account={account}
          symbol={symbol}
          nameFor={nameFor}
          sessionKeyHolder="this device (secure storage)"
          permissionId={toHex(pendingView.install.permissionId)}
        />
        <Text style={[styles.hint, { color: theme.textMuted }]}>{SESSIONS_INSTALL_MODE_NOTE}</Text>
        {!evmChain.testnet ? <WarningBox>{SESSIONS_AUDIT_NOTE}</WarningBox> : null}
        <Row
          label="Install operation"
          value={`2 calls to your own account (installValidations, grantAccess), 0 ${symbol}`}
          sub="Signed by your account key as the account's root validator."
          theme={theme}
        />
        <Row
          label={q.sponsored ? 'Network fee' : 'Max network fee (bundler estimate)'}
          value={q.sponsored ? 'Sponsored — the account pays 0' : `${formatUnits(q.fee, 18, 18)} ${symbol}`}
          theme={theme}
        />
        <Row label="Account balance" value={`${formatUnits(q.senderBalance, 18, 18)} ${symbol}`} theme={theme} />
        <Text style={[styles.ok, { color: theme.success }]}>
          Bundler gas estimate passed (eth_estimateUserOperationGas simulated the install).
        </Text>
        {phase === 'sending' ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={theme.accent} />
            <Text style={[styles.hint, { color: theme.textMuted }]}>Signing and sending…</Text>
          </View>
        ) : (
          <>
            <Button title="Grant session" onPress={() => void onInstall()} />
            <Button
              title="Back"
              variant="secondary"
              onPress={() => {
                discardPending();
                setPhase('form');
              }}
            />
          </>
        )}
      </ScrollView>
    );
  }

  if ((phase === 'revoke-confirm' || phase === 'sending') && revokeTarget) {
    const q = revokeTarget.quote;
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <NetworkBadge label={evmChain.label} testnet={evmChain.testnet} theme={theme} />
        <Text style={[styles.title, { color: theme.text }]}>Revoke session “{revokeTarget.record.label}”</Text>
        {header}
        <Row label="Permission id" value={revokeTarget.record.permissionId} mono theme={theme} />
        <Row
          label="Operation"
          value="One call to your own account: uninstallValidation for this permission"
          sub="Signed by your account key. Once the bundler accepts it, the session key is deleted from this device."
          theme={theme}
        />
        <Row
          label={q.sponsored ? 'Network fee' : 'Max network fee (bundler estimate)'}
          value={q.sponsored ? 'Sponsored — the account pays 0' : `${formatUnits(q.fee, 18, 18)} ${symbol}`}
          theme={theme}
        />
        <Text style={[styles.ok, { color: theme.success }]}>Bundler gas estimate passed.</Text>
        {phase === 'sending' ? (
          <ActivityIndicator size="large" color={theme.accent} />
        ) : (
          <>
            <Button title="Revoke session" variant="destructive" onPress={() => void onRevoke()} />
            <Button
              title="Back"
              variant="secondary"
              onPress={() => {
                setRevokeTarget(null);
                setPhase('list');
              }}
            />
          </>
        )}
      </ScrollView>
    );
  }

  if ((phase === 'form' || phase === 'quoting') && account) {
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={[styles.title, { color: theme.text }]}>Grant a session</Text>
        {header}
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          A session key is a new key on this device that may make ONLY the calls you list, until it
          expires. Your account enforces the limits on-chain. Each value cap is per call, not a total.
        </Text>
        {drafts.map((d, i) => (
          <View key={i} style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
            <Text style={[styles.label, { color: theme.textMuted }]}>Allowed call {i + 1}</Text>
            <TextInput
              value={d.target}
              onChangeText={(t) => setDrafts((prev) => prev.map((x, j) => (j === i ? { ...x, target: t } : x)))}
              placeholder="Target address (0x…)"
              placeholderTextColor={theme.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              style={[styles.input, { color: theme.text, borderColor: theme.border }]}
            />
            {draftMatches[i] && draftMatches[i]!.kind !== 'none' ? (
              <RecipientContactNotice match={draftMatches[i]!} address={d.target.trim()} />
            ) : null}
            <Button title="Pick from contacts" variant="secondary" onPress={() => setPickerFor(i)} />
            <TextInput
              value={d.selector}
              onChangeText={(t) => setDrafts((prev) => prev.map((x, j) => (j === i ? { ...x, selector: t } : x)))}
              placeholder="Function (optional): 0xa9059cbb or transfer(address,uint256)"
              placeholderTextColor={theme.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              style={[styles.input, { color: theme.text, borderColor: theme.border }]}
            />
            <TextInput
              value={d.valueCapEth}
              onChangeText={(t) => setDrafts((prev) => prev.map((x, j) => (j === i ? { ...x, valueCapEth: t } : x)))}
              placeholder={`Max ${symbol} per call (empty = 0)`}
              placeholderTextColor={theme.textMuted}
              keyboardType="decimal-pad"
              style={[styles.input, { color: theme.text, borderColor: theme.border }]}
            />
            {drafts.length > 1 ? (
              <Button
                title="Remove this call"
                variant="secondary"
                onPress={() => setDrafts((prev) => prev.filter((_, j) => j !== i))}
              />
            ) : null}
          </View>
        ))}
        <Button title="Add another allowed call" variant="secondary" onPress={() => setDrafts((p) => [...p, { ...EMPTY_DRAFT }])} />
        <Text style={[styles.label, { color: theme.textMuted }]}>Expires after (required)</Text>
        <View style={styles.rowButtons}>
          {SESSION_EXPIRY_PRESETS.map((p) => (
            <Button
              key={p.seconds}
              title={expirySeconds === p.seconds ? `✓ ${p.label}` : p.label}
              variant={expirySeconds === p.seconds ? 'primary' : 'secondary'}
              onPress={() => setExpirySeconds(p.seconds)}
            />
          ))}
        </View>
        <Text style={[styles.label, { color: theme.textMuted }]}>Gas budget (optional)</Text>
        <TextInput
          value={gasBudgetEth}
          onChangeText={setGasBudgetEth}
          placeholder={`Total ${symbol} the session may spend on fees`}
          placeholderTextColor={theme.textMuted}
          keyboardType="decimal-pad"
          style={[styles.input, { color: theme.text, borderColor: theme.border }]}
        />
        {formError ? <WarningBox>{formError}</WarningBox> : null}
        {phase === 'quoting' ? (
          <View style={styles.center}>
            <ActivityIndicator color={theme.accent} />
            <Text style={[styles.hint, { color: theme.textMuted }]}>Reading the account and asking the bundler…</Text>
          </View>
        ) : (
          <>
            <Button title="Review" onPress={() => void onReview()} />
            <Button title="Cancel" variant="secondary" onPress={() => setPhase('list')} />
          </>
        )}
        <ContactPicker
          visible={pickerFor !== null}
          contacts={contacts}
          networkLabel={evmChain.label}
          onPick={(c) => {
            const index = pickerFor;
            setPickerFor(null);
            if (index !== null) setDrafts((prev) => prev.map((x, j) => (j === index ? { ...x, target: c.address } : x)));
          }}
          onClose={() => setPickerFor(null)}
        />
      </ScrollView>
    );
  }

  // ------------------------------------------------------------ list
  return (
    <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
      {readiness ? <TestNetworksOnlyCard feature={readiness.feature} hint={readiness.hint} /> : null}
      {header}
      <WarningBox>{SESSIONS_WIPE_WARNING}</WarningBox>
      {!owner ? <Text style={[styles.error, { color: theme.danger }]}>No Ethereum address for this account.</Text> : null}
      {setupError ? <Text style={[styles.error, { color: theme.danger }]}>{setupError}</Text> : null}
      {resolution === null && !setupError && owner ? <ActivityIndicator color={theme.accent} /> : null}
      {resolution && !resolution.ok ? <WarningBox>{resolution.reason}</WarningBox> : null}
      {resolution?.ok ? (
        <>
          {!evmChain.testnet ? <Text style={[styles.hint, { color: theme.textMuted }]}>{SESSIONS_AUDIT_NOTE}</Text> : null}
          <Button
            title="Grant a new session"
            onPress={() => {
              setFormError(null);
              setPhase('form');
            }}
            disabled={listFlags.unreadable || readiness !== null}
          />
          {listFlags.unreadable ? (
            <>
              <WarningBox>
                The saved session list could not be read. Nothing was changed. Grants on-chain are not
                affected.
              </WarningBox>
              <Button title="Reset session list" variant="destructive" onPress={onResetList} />
            </>
          ) : listFlags.corrupt ? (
            <Text style={[styles.hint, { color: theme.textMuted }]}>
              Some saved sessions could not be read and are not shown.
            </Text>
          ) : null}
          <Text style={[styles.sectionTitle, { color: theme.text }]}>Sessions on this account</Text>
          {records.length === 0 ? (
            <Text style={[styles.hint, { color: theme.textMuted }]}>None on this device.</Text>
          ) : null}
          {records.map((r) => {
            const key = sessionRecordKey(r.chain, r.account, r.permissionId);
            const status = statuses[key];
            const grant = parseSessionKeyGrant(r.grant);
            const active = status !== undefined && status !== 'loading' && status.kind === 'active';
            const usable = active && !(status as { expired: boolean }).expired;
            return (
              <View key={key} style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
                <Text style={[styles.cardTitle, { color: theme.text }]}>
                  {r.label}
                  {r.source === 'erc7715' ? ' · requested over WalletConnect (ERC-7715)' : ''}
                </Text>
                <Text style={[styles.hint, { color: theme.textMuted }]}>
                  Created {new Date(r.createdAt).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')} ·
                  key {r.keyHeld ? 'on this device' : r.source === 'erc7715' ? 'held by the dApp' : 'deleted'}
                </Text>
                <Text
                  style={[
                    styles.status,
                    { color: active ? theme.success : status === 'loading' || status === undefined ? theme.textMuted : theme.text },
                  ]}
                >
                  {status === undefined || status === 'loading' ? 'Reading status…' : sessionStatusText(status)}
                </Text>
                <Text style={[styles.hint, { color: theme.textMuted }]}>{sessionLocalStatusText(r)}</Text>
                {pendingSessionOperation(r) ? <ActivityIndicator color={theme.accent} /> : null}
                {r.installUserOpHash ? (
                  <Row label="Install UserOperation hash" value={r.installUserOpHash} mono theme={theme} />
                ) : null}
                {r.revokeUserOpHash ? (
                  <Row label="Revocation UserOperation hash" value={r.revokeUserOpHash} mono theme={theme} />
                ) : null}
                <GrantReview
                  grant={grant}
                  account={r.account}
                  symbol={symbol}
                  nameFor={nameFor}
                  sessionKeyHolder={r.keyHeld ? 'this device' : r.source === 'erc7715' ? r.label : 'nobody (deleted)'}
                  permissionId={r.permissionId}
                />
                {usable && r.keyHeld
                  ? grant.calls.map((c, i) => (
                      <Button
                        key={`t${i}`}
                        title={`Test this session (allowed call ${i + 1})`}
                        variant="secondary"
                        onPress={() => void onTest(r, i)}
                        disabled={readiness !== null}
                      />
                    ))
                  : null}
                {status !== undefined && status !== 'loading' && (status.kind === 'active' || status.kind === 'unknown') ? (
                  <Button title="Revoke" variant="destructive" onPress={() => void onRevokeQuote(r)} />
                ) : null}
                {status !== undefined && status !== 'loading' && (status.kind === 'revoked' || status.kind === 'not-installed') ? (
                  <Button title="Forget" variant="secondary" onPress={() => onForget(r)} />
                ) : null}
              </View>
            );
          })}
          <Button title="Refresh status" variant="secondary" onPress={() => reloadList()} />
        </>
      ) : null}
    </ScrollView>
  );
}

/**
 * The active account's session context: its AA bundle (from the verified
 * configuration, with the owner so an EIP-7702-upgraded account gets the
 * kernel-7702 bundle), whether a session can live there, and the contacts
 * network id for name lookups.
 */
async function loadSessionContext(
  owner: string,
  accountIndex: number,
  caip2: string,
  chainId: bigint,
): Promise<{ bundle: AaClientBundle | null; resolution: SessionAccountResolution; contactsNetworkId: string }> {
  const endpoint = await getEndpoint(EVM_CHAIN_ID);
  if (!endpoint?.url) throw new Error('No RPC endpoint is configured for this network.');
  const config = await getAaConfig(caip2);
  let bundle: AaClientBundle;
  try {
    bundle = createAaClientFromConfig(config, { nodeUrl: endpoint.url, chainId, accountIndex, ownerAddress: owner });
  } catch (e) {
    return {
      bundle: null,
      resolution: {
        ok: false,
        reason: `${e instanceof Error ? e.message : String(e)} Sessions need a verified bundler and a Kernel v3.3 account.`,
      },
      contactsNetworkId: endpoint.network.chainId,
    };
  }
  return { bundle, resolution: await resolveSessionAccount(bundle, owner), contactsNetworkId: endpoint.network.chainId };
}

function NetworkBadge({ label, testnet, theme }: { label: string; testnet: boolean; theme: Theme }) {
  if (testnet) {
    return (
      <View style={[styles.badge, { backgroundColor: '#e07800', borderColor: '#e07800' }]}>
        <Text style={[styles.badgeText, { color: '#ffffff' }]}>{label} TESTNET — test funds only</Text>
      </View>
    );
  }
  return (
    <View style={[styles.badge, { backgroundColor: theme.dangerSurface, borderColor: theme.danger }]}>
      <Text style={[styles.badgeText, { color: theme.danger }]}>{label} Mainnet — real funds</Text>
    </View>
  );
}

function Row({
  label,
  value,
  sub = null,
  mono: monoFont,
  theme,
}: {
  label: string;
  value: string;
  sub?: string | null;
  mono?: boolean;
  theme: Theme;
}) {
  return (
    <View style={[styles.row, { borderColor: theme.border }]}>
      <Text style={[styles.rowLabel, { color: theme.textMuted }]}>{label}</Text>
      <Text selectable style={[styles.rowValue, { color: theme.text }, monoFont ? { fontFamily: mono, fontSize: 13 } : null]}>
        {value}
      </Text>
      {sub ? (
        <Text selectable style={[styles.rowSub, { color: theme.textMuted }]}>
          {sub}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: 24, gap: 14 },
  center: { alignItems: 'center', justifyContent: 'center', gap: 10, padding: 12 },
  title: { fontSize: 18, fontWeight: '700' },
  sectionTitle: { fontSize: 16, fontWeight: '700', marginTop: 8 },
  networkLine: { fontSize: 13 },
  label: { fontSize: 13, fontWeight: '600', marginTop: 4 },
  hint: { fontSize: 13, lineHeight: 19 },
  ok: { fontSize: 15, fontWeight: '600' },
  status: { fontSize: 15, fontWeight: '600' },
  error: { fontSize: 14, lineHeight: 20 },
  monoText: { fontFamily: mono, fontSize: 13 },
  card: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 8 },
  cardTitle: { fontSize: 16, fontWeight: '700' },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  rowButtons: { gap: 8 },
  badge: { borderWidth: 1, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 12 },
  badgeText: { fontSize: 13, fontWeight: '700', textAlign: 'center' },
  row: { borderBottomWidth: StyleSheet.hairlineWidth, paddingBottom: 8, gap: 2 },
  rowLabel: { fontSize: 12, fontWeight: '600' },
  rowValue: { fontSize: 15 },
  rowSub: { fontSize: 12, lineHeight: 17 },
});
