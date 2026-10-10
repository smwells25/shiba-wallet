import React, { useCallback, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ActivityIndicator, Alert, Linking, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { KernelGuardianSet } from '@shiba-wallet/chains-evm';
import type { RootStackParamList } from '../navigation';
import { Button, WarningBox, screenStyle } from '../components';
import { localDateLabel } from '../config/dates';
import { ContactPicker, RecipientContactNotice } from '../components/Contacts';
import { GuardianSetView, InfoRow, PasteOrScan, RecoveryNetworkBadge, recoveryLayout as styles } from '../components/RecoveryViews';
import { AaDepositNote } from '../components/AaDepositNote';
import { useTheme } from '../theme';
import { getEndpoint } from '../config/networks';
import { useWallet } from '../wallet/WalletContext';
import { usePrefs } from '../wallet/PrefsContext';
import { requireLocalAuth } from '../wallet/biometric';
import { formatUnits } from '../wallet/balances';
import { EVM_CHAIN_ID, describeSendError } from '../wallet/send';
import {
  checkAaQuoteBeforeApproval,
  createAaClientFromConfig,
  describeAaError,
  getAaConfig,
  sendAa,
  type AaClientBundle,
} from '../wallet/aa';
import { findExactContact, listContacts, matchRecipient, type Contact } from '../wallet/contacts';
import {
  EMPTY_GUARDIAN_DRAFT,
  GUARDIANS_AUDIT_NOTE,
  RECOVERED_NOT_DERIVABLE_NOTE,
  addWatchedProposal,
  ensureFactoryKernelRecord,
  finalizeGuardianOperation,
  formatDuration,
  getRecoveryRecord,
  readGuardianStatus,
  removeWatchedProposal,
  resolveGuardianAccount,
  submitGuardianOperation,
  validateGuardianSetForAccount,
  prepareVetoQuote,
  type GuardianAccountResolution,
  type GuardianDraft,
  type GuardianOperationQuote,
  type GuardianStatus,
  type ProposalView,
  type RecoveryRecordEntry,
} from '../wallet/recovery';
import {
  DEFAULT_INHERITANCE_DELAY_SECONDS,
  INHERITANCE_ACK_TEXT,
  INHERITANCE_DELAY_PRESETS,
  INHERITANCE_HOW_IT_WORKS,
  INHERITANCE_PRODUCTION_NEEDS,
  INHERITANCE_REMOVE_NOTE,
  INHERITANCE_RISK_STATEMENT,
  INHERITANCE_TESTNET_ONLY,
  INHERITANCE_TITLE,
  MAX_HEIRS,
  buildHeirSet,
  canReviewHeirs,
  checkTakeoverAttempts,
  clearTakeoverScanState,
  describeHeirExposure,
  inheritanceConflict,
  isHeirRecord,
  prepareHeirInstallQuote,
  prepareHeirRemoveQuote,
  takeoverCoverageText,
  takeoverStatusText,
  type TakeoverCheckResult,
} from '../wallet/inheritance';

type Props = NativeStackScreenProps<RootStackParamList, 'Inheritance'>;

type Phase = 'overview' | 'form' | 'quoting' | 'confirm' | 'sending' | 'progress';

interface Progress {
  kind: GuardianOperationQuote['kind'];
  userOpHash: string;
  state: 'pending' | 'done' | 'failed' | 'timeout';
  txHash: string | null;
}

/** Local date and time of a millisecond timestamp ("2026-10-04 21:30"). */
function localTimeLabel(ms: number): string {
  const d = new Date(ms);
  return `${localDateLabel(ms)} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

/**
 * Inheritance switch (feature 48), phase 14 item 4: a TEST-NETWORK
 * DEMONSTRATION on the guardian modules (../wallet/inheritance.ts explains
 * why it is not offered with real funds). The risk statement is the first
 * thing on every phase of this screen. Owner side: name heirs with a long
 * delay, check for takeover attempts, veto, remove. Heir side: the guardian
 * recovery screens opened with role 'heir'. Every owner operation is
 * ROOT-signed through the normal smart-account confirm (bundler estimate,
 * fee floor, biometric gate, signWith(owner), sendAa).
 */
export function InheritanceScreen({ navigation }: Props) {
  const theme = useTheme();
  const { accounts, activeAccount, signWith } = useWallet();
  const { evmChain } = usePrefs();
  const evm = accounts.find((a) => a.chainId === EVM_CHAIN_ID) ?? null;
  const owner = evm?.address ?? null;
  const ownerPath = evm?.path ?? null;
  const symbol = evmChain.displaySymbol;
  const chain = evmChain.caip2;
  const chainId = BigInt(evmChain.chainIdDecimal);

  const [bundle, setBundle] = useState<AaClientBundle | null>(null);
  const [resolution, setResolution] = useState<GuardianAccountResolution | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [entry, setEntry] = useState<RecoveryRecordEntry | null>(null);
  const [status, setStatus] = useState<GuardianStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [check, setCheck] = useState<TakeoverCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactsNetworkId, setContactsNetworkId] = useState<string | null>(null);

  const [phase, setPhase] = useState<Phase>('overview');
  const [drafts, setDrafts] = useState<GuardianDraft[]>([{ ...EMPTY_GUARDIAN_DRAFT }]);
  const [threshold, setThreshold] = useState('1');
  const [delaySeconds, setDelaySeconds] = useState(DEFAULT_INHERITANCE_DELAY_SECONDS);
  const [ack, setAck] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [pickerFor, setPickerFor] = useState<number | null>(null);
  const [operation, setOperation] = useState<(GuardianOperationQuote & { vetoed?: string[] }) | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [watchInput, setWatchInput] = useState('');
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    navigation.setOptions({ title: INHERITANCE_TITLE });
  }, [navigation]);

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  const account = resolution?.ok ? resolution.account : null;

  const setup = useCallback(() => {
    if (!owner || !activeAccount) return;
    loadContext(owner, activeAccount.index, chain, chainId).then(
      (ctx) => {
        setSetupError(null);
        setContactsNetworkId(ctx.contactsNetworkId);
        setBundle(ctx.bundle);
        setResolution(ctx.resolution);
      },
      (e: unknown) => setSetupError(e instanceof Error ? e.message : String(e)),
    );
  }, [owner, activeAccount, chain, chainId]);
  useEffect(setup, [setup]);

  // The record (started here for a factory account, as on the Guardians screen) and the chain status.
  const reload = useCallback(() => {
    if (!resolution?.ok || !bundle || !owner || !activeAccount) return;
    const r = resolution;
    (async () => {
      let e: RecoveryRecordEntry | null = null;
      if (r.kind === 'factory') {
        e = (
          await ensureFactoryKernelRecord({
            chain,
            account: r.account,
            accountIndex: activeAccount.index,
            owner,
            ownerPath,
            factory: bundle.factory,
            implementation: bundle.kernel!.implementation,
            ecdsaValidator: bundle.kernel!.ecdsaValidator,
          })
        ).entry;
      } else {
        e = await getRecoveryRecord(chain, r.account);
      }
      const st = await readGuardianStatus(bundle.node, r.account, e);
      return { e, st };
    })().then(
      ({ e, st }) => {
        setLoadError(null);
        setEntry(e);
        setStatus(st);
      },
      (err: unknown) => setLoadError(err instanceof Error ? err.message : String(err)),
    );
  }, [resolution, bundle, owner, activeAccount, chain, ownerPath]);
  useEffect(reload, [reload]);

  useEffect(() => {
    if (!contactsNetworkId) return;
    listContacts(contactsNetworkId).then(setContacts, () => setContacts([]));
  }, [contactsNetworkId]);

  const heirsInstalled = status?.state.validatorInitialized === true && isHeirRecord(entry);
  const conflict = status ? inheritanceConflict(status.state, entry) : null;

  /** "Check for takeover attempts": on focus, and on demand. State is set only from the promise callbacks. */
  const runCheck = useCallback(() => {
    if (!bundle || !account || !heirsInstalled) return Promise.resolve();
    return checkTakeoverAttempts({
      node: bundle.node,
      chain,
      chainId,
      account,
      threshold: status?.state.set?.threshold ?? null,
    }).then(
      (result) => {
        setCheckError(null);
        setCheck(result);
      },
      (e: unknown) => setCheckError(e instanceof Error ? e.message : String(e)),
    );
  }, [bundle, account, heirsInstalled, chain, chainId, status]);

  useFocusEffect(
    useCallback(() => {
      void runCheck();
    }, [runCheck]),
  );

  const labelFor = useCallback(
    (address: string): string | null => {
      const recorded = entry?.metadata.guardians?.guardians.find((g) => g.address.toLowerCase() === address.toLowerCase());
      if (recorded?.label) return recorded.label;
      return contactsNetworkId ? (findExactContact(contactsNetworkId, address, contacts)?.name ?? null) : null;
    },
    [entry, contacts, contactsNetworkId],
  );

  const draftMatches = useMemo(
    () => drafts.map((d) => (contactsNetworkId && d.address.trim() ? matchRecipient(contactsNetworkId, d.address.trim(), contacts) : null)),
    [drafts, contacts, contactsNetworkId],
  );

  const draftSet = useMemo((): { set: KernelGuardianSet; labels: Record<string, string> } | null => {
    if (!account || !owner) return null;
    try {
      const built = buildHeirSet({ drafts, threshold, delaySeconds });
      return validateGuardianSetForAccount(built.set, { account, owner }) === null ? built : null;
    } catch {
      return null;
    }
  }, [drafts, threshold, delaySeconds, account, owner]);

  const describe = (e: unknown) =>
    (bundle ? describeAaError(e, { accountType: bundle.accountType, deployed: true }) : null) ?? describeSendError(e, symbol);

  // ------------------------------------------------------------ actions

  const onReview = async () => {
    if (!bundle || !account || !owner || !status) return;
    setFormError(null);
    let built: { set: KernelGuardianSet; labels: Record<string, string> };
    try {
      built = buildHeirSet({ drafts, threshold, delaySeconds });
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
      return;
    }
    const refusal = validateGuardianSetForAccount(built.set, { account, owner });
    if (refusal) {
      setFormError(refusal);
      return;
    }
    setPhase('quoting');
    try {
      setOperation(await prepareHeirInstallQuote(bundle, owner, account, built.set, built.labels, { acknowledged: ack, state: status.state, entry }));
      setPhase('confirm');
    } catch (e) {
      const { title, detail } = describe(e);
      setFormError(`${title}\n${detail}`);
      setPhase('form');
    }
  };

  const onRemoveQuote = async () => {
    if (!bundle || !account || !owner) return;
    try {
      setOperation(await prepareHeirRemoveQuote(bundle, owner, account, check?.views ?? []));
      setPhase('confirm');
    } catch (e) {
      const { title, detail } = describe(e);
      Alert.alert(title, detail);
    }
  };

  const onVetoQuote = async (hash: string) => {
    if (!bundle || !account || !owner) return;
    try {
      setOperation(await prepareVetoQuote(bundle, owner, account, hash));
      setPhase('confirm');
    } catch (e) {
      const { title, detail } = describe(e);
      Alert.alert(title, detail);
    }
  };

  const onCheckNow = () => {
    setChecking(true);
    void runCheck()?.finally(() => setChecking(false));
  };

  const onConfirm = async () => {
    const op = operation;
    if (!op || !bundle || !owner) return;
    const what =
      op.kind === 'install' ? 'Approve adding heirs' : op.kind === 'remove' ? 'Approve removing the heirs' : 'Approve vetoing this takeover';
    try {
      await checkAaQuoteBeforeApproval(bundle.bundler, op.quote);
    } catch (e) {
      const { title, detail } = describe(e);
      Alert.alert(title, detail);
      setOperation(null);
      setPhase(op.kind === 'install' ? 'form' : 'overview');
      return;
    }
    const auth = await requireLocalAuth(what);
    if (!auth.ok) {
      Alert.alert('Not sent', auth.message);
      return;
    }
    setPhase('sending');
    try {
      const { userOpHash } = await submitGuardianOperation({
        operation: op,
        chain,
        store: AsyncStorage,
        submit: (q) => signWith(EVM_CHAIN_ID, owner, (signer) => sendAa(bundle, signer, q)),
      });
      setProgress({ kind: op.kind, userOpHash, state: 'pending', txHash: null });
      setPhase('progress');
      if (op.kind === 'remove') void clearTakeoverScanState(chain, op.account).catch(() => undefined);
      void finalizeGuardianOperation({ bundle, userOpHash, chain, account: op.account, kind: op.kind, store: AsyncStorage }).then(
        ({ receipt }) =>
          setProgress((prev) =>
            prev && prev.userOpHash === userOpHash ? { ...prev, state: receipt.success === false ? 'failed' : 'done', txHash: receipt.txHash } : prev,
          ),
        () => setProgress((prev) => (prev && prev.userOpHash === userOpHash ? { ...prev, state: 'timeout' } : prev)),
      );
    } catch (e) {
      const { title, detail } = describe(e);
      Alert.alert(title, detail);
      setOperation(null);
      setPhase(op.kind === 'install' ? 'form' : 'overview');
      reload();
    }
  };

  const onWatch = () => {
    if (!account) return;
    addWatchedProposal(chain, account, watchInput).then(
      () => {
        setWatchInput('');
        void runCheck();
      },
      (e: unknown) => Alert.alert('Not added', e instanceof Error ? e.message : String(e)),
    );
  };

  // ------------------------------------------------------------ render

  const risk = <WarningBox>{INHERITANCE_RISK_STATEMENT}</WarningBox>;
  const header = (
    <>
      <Text style={[styles.hint, { color: theme.textMuted }]}>
        {evmChain.label}
        {evmChain.testnet ? ' · TESTNET' : ''} · chain id {evmChain.chainIdDecimal}
      </Text>
      <InfoRow label="Owner account (signs setup, vetoes and removal)" value={activeAccount?.name ?? 'Account'} sub={owner} />
      {resolution?.ok ? (
        <InfoRow
          label={resolution.kind === 'recovered' ? 'Recovered Kernel account' : 'Kernel smart account'}
          value={resolution.account}
          sub={resolution.kind === 'recovered' ? RECOVERED_NOT_DERIVABLE_NOTE : null}
          monoValue
        />
      ) : null}
    </>
  );

  if (phase === 'progress' && progress) {
    const what = progress.kind === 'install' ? 'Heir setup' : progress.kind === 'remove' ? 'Heir removal' : 'Veto';
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        {risk}
        <Text style={[styles.title, { color: theme.success }]}>{what} sent to the bundler</Text>
        <InfoRow label="UserOperation hash" value={progress.userOpHash} monoValue />
        {progress.state === 'pending' ? (
          <View style={styles.center}>
            <ActivityIndicator color={theme.accent} />
            <Text style={[styles.hint, { color: theme.textMuted }]}>Bundling… waiting for the receipt.</Text>
          </View>
        ) : null}
        {progress.state === 'done' ? <Text style={[styles.ok, { color: theme.success }]}>Included on-chain — succeeded.</Text> : null}
        {progress.state === 'failed' ? <WarningBox>Included, but the operation reverted.</WarningBox> : null}
        {progress.state === 'timeout' ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            Not included within two minutes. It may still be included; this screen reads the chain.
          </Text>
        ) : null}
        {progress.txHash && evmChain.explorerTxBase ? (
          <Button title="View bundle transaction" variant="secondary" onPress={() => void Linking.openURL(`${evmChain.explorerTxBase}${progress.txHash}`)} />
        ) : null}
        {progress.state === 'done' && progress.kind === 'install' ? (
          <Text style={[styles.hint, { color: theme.text }]}>
            Back up the updated recovery record from the Guardians screen: it now lists your heirs (role “heirs”).
          </Text>
        ) : null}
        <Button
          title="Done"
          onPress={() => {
            setProgress(null);
            setOperation(null);
            setCheck(null);
            setPhase('overview');
            reload();
          }}
        />
      </ScrollView>
    );
  }

  if ((phase === 'confirm' || phase === 'sending') && operation) {
    const q = operation.quote;
    const title = operation.kind === 'install' ? 'Add these heirs?' : operation.kind === 'remove' ? 'Remove the heirs?' : 'Veto this takeover?';
    const vetoCount = operation.vetoed?.length ?? 0;
    const opLine =
      operation.kind === 'install'
        ? '2 calls to your own account: installModule (WeightedECDSAValidator, allowed to call only doRecovery) and installModule (RecoveryAction)'
        : operation.kind === 'remove'
          ? `3 calls to your own account (uninstallValidation, revoke doRecovery access, uninstallModule (RecoveryAction))${
              vetoCount > 0 ? ` and ${vetoCount} veto call${vetoCount === 1 ? '' : 's'} to the guardian contract` : ''
            }`
          : `One call from your account to the guardian contract: veto(${operation.proposalHash})`;
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        {risk}
        <RecoveryNetworkBadge label={evmChain.label} testnet={evmChain.testnet} />
        <Text style={[styles.title, { color: theme.text }]}>{title}</Text>
        {header}
        {operation.set ? (
          <>
            <GuardianSetView set={operation.set} labelFor={(a) => operation.labels[a.toLowerCase()] ?? labelFor(a)} title="Heirs" memberNoun="Heir" />
            <WarningBox>{describeHeirExposure(operation.set, (a) => operation.labels[a.toLowerCase()] ?? labelFor(a))}</WarningBox>
            {INHERITANCE_HOW_IT_WORKS.map((line) => (
              <Text key={line} style={[styles.hint, { color: theme.textMuted }]}>
                • {line}
              </Text>
            ))}
            <Text style={[styles.hint, { color: theme.textMuted }]}>{GUARDIANS_AUDIT_NOTE}</Text>
          </>
        ) : null}
        {operation.kind === 'remove' ? <Text style={[styles.hint, { color: theme.text }]}>{INHERITANCE_REMOVE_NOTE}</Text> : null}
        {operation.kind === 'veto' ? (
          <Text style={[styles.hint, { color: theme.text }]}>
            The takeover is marked rejected and can never execute. A veto stops only this takeover: the heir can start
            another one. If you no longer trust the heir, remove them.
          </Text>
        ) : null}
        <InfoRow label="Operation" value={opLine} sub="Signed by your account key as the account's root validator." />
        <InfoRow
          label={q.sponsored ? 'Network fee' : 'Max network fee (bundler estimate)'}
          value={q.sponsored ? 'Sponsored — the account pays 0' : `${formatUnits(q.fee, 18, 18)} ${symbol}`}
        />
        <InfoRow label="Account balance" value={`${formatUnits(q.senderBalance, 18, 18)} ${symbol}`} />
        <AaDepositNote fee={q.fee} deposit={q.deposit} sponsored={q.sponsored} symbol={symbol} />
        <Text style={[styles.ok, { color: theme.success }]}>Bundler gas estimate passed (eth_estimateUserOperationGas simulated the operation).</Text>
        {phase === 'sending' ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={theme.accent} />
            <Text style={[styles.hint, { color: theme.textMuted }]}>Signing and sending…</Text>
          </View>
        ) : (
          <>
            <Button
              title={operation.kind === 'install' ? 'Add heirs' : operation.kind === 'remove' ? 'Remove heirs' : 'Veto'}
              variant={operation.kind === 'install' ? 'primary' : 'destructive'}
              onPress={() => void onConfirm()}
            />
            <Button
              title="Back"
              variant="secondary"
              onPress={() => {
                const back = operation.kind === 'install' ? 'form' : 'overview';
                setOperation(null);
                setPhase(back);
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
        {risk}
        <Text style={[styles.title, { color: theme.text }]}>Add heirs</Text>
        {header}
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Each heir is an Ethereum address held by the person you choose. A takeover needs heirs whose weights add up to
          the threshold (one heir with threshold 1 is the usual will).
        </Text>
        {drafts.map((d, i) => (
          <View key={i} style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
            <Text style={[styles.hint, { color: theme.textMuted }]}>Heir {i + 1}</Text>
            <TextInput
              value={d.address}
              onChangeText={(t) => setDrafts((p) => p.map((x, j) => (j === i ? { ...x, address: t } : x)))}
              accessibilityLabel={`Heir ${i + 1} address`}
              placeholder="Heir address (0x…)"
              placeholderTextColor={theme.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              style={[styles.input, { color: theme.text, borderColor: theme.border }]}
            />
            {draftMatches[i] && draftMatches[i]!.kind !== 'none' ? <RecipientContactNotice match={draftMatches[i]!} address={d.address.trim()} /> : null}
            <Button title="Pick from contacts" accessibilityLabel={`Pick heir ${i + 1} from contacts`} variant="secondary" onPress={() => setPickerFor(i)} />
            <TextInput
              value={d.label}
              onChangeText={(t) => setDrafts((p) => p.map((x, j) => (j === i ? { ...x, label: t } : x)))}
              accessibilityLabel={`Heir ${i + 1} label, optional`}
              placeholder="Label (optional, stored in the recovery record)"
              placeholderTextColor={theme.textMuted}
              style={[styles.input, { color: theme.text, borderColor: theme.border }]}
            />
            <TextInput
              value={d.weight}
              onChangeText={(t) => setDrafts((p) => p.map((x, j) => (j === i ? { ...x, weight: t } : x)))}
              accessibilityLabel={`Heir ${i + 1} weight`}
              placeholder="Weight (1 or more)"
              placeholderTextColor={theme.textMuted}
              keyboardType="number-pad"
              style={[styles.input, { color: theme.text, borderColor: theme.border }]}
            />
            {drafts.length > 1 ? (
              <Button title="Remove this heir" accessibilityLabel={`Remove heir ${i + 1}`} variant="secondary" onPress={() => setDrafts((p) => p.filter((_, j) => j !== i))} />
            ) : null}
          </View>
        ))}
        {drafts.length < MAX_HEIRS ? (
          <Button title="Add another heir" variant="secondary" onPress={() => setDrafts((p) => [...p, { ...EMPTY_GUARDIAN_DRAFT }])} />
        ) : null}
        <Text style={[styles.hint, { color: theme.textMuted }]}>Threshold (total weight a takeover needs)</Text>
        <TextInput
          value={threshold}
          onChangeText={setThreshold}
          accessibilityLabel="Threshold (total weight a takeover needs)"
          keyboardType="number-pad"
          style={[styles.input, { color: theme.text, borderColor: theme.border }]}
        />
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Delay between the heir’s on-chain approval and the takeover. During it, and until the takeover executes, you
          can veto from this wallet — if you know about it.
        </Text>
        {INHERITANCE_DELAY_PRESETS.map((p) => (
          <Button
            key={p.seconds}
            title={delaySeconds === p.seconds ? `✓ ${p.label}` : p.label}
            selected={delaySeconds === p.seconds}
            accessibilityLabel={`Delay ${p.label}`}
            variant={delaySeconds === p.seconds ? 'primary' : 'secondary'}
            onPress={() => setDelaySeconds(p.seconds)}
          />
        ))}
        {draftSet ? (
          <WarningBox>{describeHeirExposure(draftSet.set, (a) => draftSet.labels[a.toLowerCase()] ?? labelFor(a))}</WarningBox>
        ) : (
          <Text style={[styles.hint, { color: theme.textMuted }]}>What these heirs could do appears here once the list is complete.</Text>
        )}
        {INHERITANCE_HOW_IT_WORKS.map((line) => (
          <Text key={line} style={[styles.hint, { color: theme.textMuted }]}>
            • {line}
          </Text>
        ))}
        <Text style={[styles.hint, { color: theme.textMuted }]}>{GUARDIANS_AUDIT_NOTE}</Text>
        <View style={styles.toggleRow}>
          <Text style={[styles.toggleLabel, { color: theme.text }]}>{INHERITANCE_ACK_TEXT}</Text>
          <Switch accessibilityLabel={INHERITANCE_ACK_TEXT} value={ack} onValueChange={setAck} />
        </View>
        {formError ? <WarningBox>{formError}</WarningBox> : null}
        {phase === 'quoting' ? (
          <View style={styles.center}>
            <ActivityIndicator color={theme.accent} />
            <Text style={[styles.hint, { color: theme.textMuted }]}>Reading the account and asking the bundler…</Text>
          </View>
        ) : (
          <>
            <Button
              title="Review"
              onPress={() => void onReview()}
              disabled={!canReviewHeirs({ drafts, acknowledged: ack })}
            />
            <Button title="Cancel" variant="secondary" onPress={() => setPhase('overview')} />
          </>
        )}
        <ContactPicker
          visible={pickerFor !== null}
          contacts={contacts}
          networkLabel={evmChain.label}
          onPick={(c) => {
            const index = pickerFor;
            setPickerFor(null);
            if (index !== null) setDrafts((p) => p.map((x, j) => (j === index ? { ...x, address: c.address, label: x.label || c.name } : x)));
          }}
          onClose={() => setPickerFor(null)}
        />
      </ScrollView>
    );
  }

  // ------------------------------------------------------------ overview
  const set = status?.state.set ?? null;
  const pending: ProposalView[] = check?.pending ?? [];
  return (
    <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {risk}
      {!evmChain.testnet ? <WarningBox>{INHERITANCE_TESTNET_ONLY}</WarningBox> : null}
      {header}
      {!owner ? <Text style={[styles.error, { color: theme.danger }]}>No Ethereum address for this account.</Text> : null}
      {setupError ? <Text style={[styles.error, { color: theme.danger }]}>{setupError}</Text> : null}
      {resolution === null && !setupError && owner ? <ActivityIndicator color={theme.accent} /> : null}
      {resolution && !resolution.ok ? <WarningBox>{resolution.reason}</WarningBox> : null}
      {loadError ? <WarningBox>{loadError}</WarningBox> : null}
      {resolution?.ok ? (
        <>
          <Text style={[styles.sectionTitle, { color: theme.text }]}>Heirs</Text>
          {status === null ? <ActivityIndicator color={theme.accent} /> : null}
          {conflict ? (
            <>
              <WarningBox>{conflict}</WarningBox>
              <Button title="Open Guardians" variant="secondary" onPress={() => navigation.navigate('Guardians')} />
            </>
          ) : null}
          {status && !conflict && !heirsInstalled ? (
            <>
              <Text style={[styles.hint, { color: theme.text }]}>No heirs are set up for this account.</Text>
              <Button title="Add heirs" onPress={() => setPhase('form')} disabled={!evmChain.testnet} />
            </>
          ) : null}
          {heirsInstalled && set ? (
            <>
              <Text style={[styles.ok, { color: status?.state.active ? theme.text : theme.danger }]}>
                {status?.state.active
                  ? `Heirs are installed. Delay ${formatDuration(set.delaySeconds)}.`
                  : 'The heir modules are only partly installed (a takeover would not work). Remove them and add them again.'}
              </Text>
              <GuardianSetView set={set} labelFor={labelFor} title="Heirs" memberNoun="Heir" />
              <WarningBox>{describeHeirExposure(set, labelFor)}</WarningBox>

              <Text style={[styles.sectionTitle, { color: theme.text }]}>Takeover attempts</Text>
              {check ? (
                <>
                  <Text style={[styles.ok, { color: pending.length > 0 ? theme.danger : theme.text }]}>
                    {pending.length > 0
                      ? `${pending.length} takeover attempt${pending.length === 1 ? '' : 's'} found — see below.`
                      : 'No pending takeover attempts found.'}
                  </Text>
                  <Text style={[styles.hint, { color: theme.textMuted }]}>Last check: {localTimeLabel(check.lastCheckedAt)}</Text>
                  <Text style={[styles.hint, { color: theme.textMuted }]}>{takeoverCoverageText(check)}</Text>
                  {check.notes.map((n) => (
                    <Text key={n} style={[styles.hint, { color: theme.danger }]}>
                      {n}
                    </Text>
                  ))}
                </>
              ) : (
                <Text style={[styles.hint, { color: theme.textMuted }]}>Not checked yet.</Text>
              )}
              {checkError ? <WarningBox>The check failed: {checkError}</WarningBox> : null}
              {checking ? <ActivityIndicator color={theme.accent} /> : <Button title="Check for takeover attempts" variant="secondary" onPress={onCheckNow} />}
              {(check?.views ?? []).map((p) => (
                <View key={p.hash} style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
                  <InfoRow label="Takeover id (proposal)" value={p.hash} monoValue />
                  {p.newOwner ? <InfoRow label="Proposed new owner" value={p.newOwner} monoValue /> : null}
                  <Text style={[styles.ok, { color: p.canVeto && p.state?.status === 'approved' ? theme.danger : theme.text }]}>{takeoverStatusText(p, now)}</Text>
                  {p.canVeto ? (
                    <Button title="Veto" accessibilityLabel={`Veto takeover ${p.hash.slice(0, 10)}`} variant="destructive" onPress={() => void onVetoQuote(p.hash)} />
                  ) : null}
                  <Button
                    title="Stop watching"
                    accessibilityLabel={`Stop watching takeover ${p.hash.slice(0, 10)}`}
                    variant="secondary"
                    onPress={() => void removeWatchedProposal(chain, resolution.account, p.hash).then(() => runCheck(), () => runCheck())}
                  />
                </View>
              ))}
              <PasteOrScan
                value={watchInput}
                onChange={setWatchInput}
                placeholder="Paste a takeover request or its id (0x…)"
                rationale="Scan the takeover request your heir showed you."
              />
              <Button title="Watch this takeover" variant="secondary" disabled={!watchInput.trim() || !entry} onPress={onWatch} />

              <Text style={[styles.hint, { color: theme.text }]}>{INHERITANCE_REMOVE_NOTE}</Text>
              <Button title="Remove heirs" variant="destructive" onPress={() => void onRemoveQuote()} />
            </>
          ) : null}
        </>
      ) : null}

      <Text style={[styles.sectionTitle, { color: theme.text }]}>How this works</Text>
      {INHERITANCE_HOW_IT_WORKS.map((line) => (
        <Text key={line} style={[styles.hint, { color: theme.textMuted }]}>
          • {line}
        </Text>
      ))}
      <Text style={[styles.hint, { color: theme.textMuted }]}>{INHERITANCE_PRODUCTION_NEEDS}</Text>
      <Text style={[styles.hint, { color: theme.textMuted }]}>{GUARDIANS_AUDIT_NOTE}</Text>

      <Text style={[styles.sectionTitle, { color: theme.text }]}>If you are an heir</Text>
      <Text style={[styles.hint, { color: theme.textMuted }]}>
        Start a takeover from the account that should become the owner, then approve and submit it with your heir address.
      </Text>
      <Button title="Start a takeover (new owner = this account)" variant="secondary" onPress={() => navigation.navigate('RecoverAccount', { role: 'heir' })} />
      <Button title="Approve or submit a takeover (as the heir)" variant="secondary" onPress={() => navigation.navigate('ApproveRecovery', { role: 'heir' })} />
      <Button title="Refresh" variant="secondary" onPress={reload} />
    </ScrollView>
  );
}

/** The active account's AA bundle and its guardian-account resolution (as on the Guardians screen). */
async function loadContext(
  owner: string,
  accountIndex: number,
  caip2: string,
  chainId: bigint,
): Promise<{ bundle: AaClientBundle | null; resolution: GuardianAccountResolution; contactsNetworkId: string }> {
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
        reason: `${e instanceof Error ? e.message : String(e)} Heirs need a verified bundler and a deployed Kernel v3.3 account.`,
      },
      contactsNetworkId: endpoint.network.chainId,
    };
  }
  return { bundle, resolution: await resolveGuardianAccount(bundle, owner), contactsNetworkId: endpoint.network.chainId };
}
