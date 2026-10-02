import React, { useCallback, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ActivityIndicator, Alert, Linking, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { KernelGuardianSet } from '@shiba-wallet/chains-evm';
import type { RootStackParamList } from '../navigation';
import { Button, WarningBox, screenStyle } from '../components';
import { ContactPicker, RecipientContactNotice } from '../components/Contacts';
import {
  GuardianExposureWarning,
  GuardianSetView,
  InfoRow,
  PasteOrScan,
  PayloadQr,
  RecoveryNetworkBadge,
  ShareActions,
  recoveryLayout as styles,
} from '../components/RecoveryViews';
import { useTheme } from '../theme';
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
  type AaClientBundle,
} from '../wallet/aa';
import { findExactContact, listContacts, matchRecipient, type Contact } from '../wallet/contacts';
import {
  DEFAULT_GUARDIAN_DELAY_SECONDS,
  delayPresetsFor,
  EMPTY_GUARDIAN_DRAFT,
  GUARDIANS_AUDIT_NOTE,
  GUARDIANS_MAINNET_ACK,
  GUARDIANS_MAINNET_CONDITION,
  GUARDIANS_TRADE_OFF,
  NO_VETO_ACK_TEXT,
  PROPOSAL_DISCOVERY_NOTE,
  RECOVERED_NOT_DERIVABLE_NOTE,
  RECOVERY_RECORD_NOTE,
  addWatchedProposal,
  buildGuardianSet,
  ensureFactoryKernelRecord,
  finalizeGuardianOperation,
  formatDuration,
  getRecoveryRecord,
  markRecordExported,
  prepareGuardianInstallQuote,
  prepareGuardianRemoveQuote,
  prepareGuardianRenewQuote,
  prepareVetoQuote,
  readGuardianStatus,
  readProposalView,
  recordExport,
  removeWatchedProposal,
  resolveGuardianAccount,
  submitGuardianOperation,
  syncRecordGuardiansFromChain,
  validateGuardianSetForAccount,
  type GuardianAccountResolution,
  type GuardianDraft,
  type GuardianOperationQuote,
  type GuardianStatus,
  type ProposalView,
  type RecoveryRecordEntry,
} from '../wallet/recovery';

type Props = NativeStackScreenProps<RootStackParamList, 'Guardians'>;

type Phase = 'overview' | 'form' | 'quoting' | 'confirm' | 'sending' | 'progress' | 'backup';

interface Progress {
  kind: GuardianOperationQuote['kind'];
  userOpHash: string;
  state: 'pending' | 'done' | 'failed' | 'timeout';
  txHash: string | null;
  detail: string | null;
}

/**
 * Guardians (social recovery), phase 8 item 4, app half: set up, review,
 * change and remove the guardians of the active account's DEPLOYED Kernel
 * v3.3 account on the active EVM chain, back up its recovery record, and
 * veto recovery proposals. See ../wallet/recovery.ts for the rules: every
 * operation here is ROOT-signed by the owner through the normal
 * smart-account confirm (bundler estimate gate, network badge, fee,
 * biometric gate, signWith(expectAddress = the owner EOA), sendAa); the
 * mandatory exposure warning is shown on the form, the confirm screen and
 * the status card; a guardian setup is never described as safe.
 */
export function GuardiansScreen({ navigation }: Props) {
  const theme = useTheme();
  const { accounts, activeAccount, signWith } = useWallet();
  const { evmChain } = usePrefs();
  const evm = accounts.find((a) => a.chainId === EVM_CHAIN_ID) ?? null;
  const owner = evm?.address ?? null;
  const ownerPath = evm?.path ?? null;
  const symbol = evmChain.displaySymbol;
  const chain = evmChain.caip2;

  const [bundle, setBundle] = useState<AaClientBundle | null>(null);
  const [resolution, setResolution] = useState<GuardianAccountResolution | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [entry, setEntry] = useState<RecoveryRecordEntry | null>(null);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [status, setStatus] = useState<GuardianStatus | null>(null);
  const [proposals, setProposals] = useState<ProposalView[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactsNetworkId, setContactsNetworkId] = useState<string | null>(null);

  const [phase, setPhase] = useState<Phase>('overview');
  const [renewing, setRenewing] = useState(false);
  const [drafts, setDrafts] = useState<GuardianDraft[]>([{ ...EMPTY_GUARDIAN_DRAFT }, { ...EMPTY_GUARDIAN_DRAFT }]);
  const [threshold, setThreshold] = useState('2');
  const [delaySeconds, setDelaySeconds] = useState(DEFAULT_GUARDIAN_DELAY_SECONDS);
  const [noVetoAck, setNoVetoAck] = useState(false);
  const [mainnetAck, setMainnetAck] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [pickerFor, setPickerFor] = useState<number | null>(null);
  const [operation, setOperation] = useState<GuardianOperationQuote | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [watchInput, setWatchInput] = useState('');
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    navigation.setOptions({ title: 'Guardians' });
  }, [navigation]);

  // Countdowns on the proposal list tick once a second.
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  const account = resolution?.ok ? resolution.account : null;

  // Resolve the active account's Kernel account; state is set only from
  // promise callbacks (react-hooks lint rules this app follows).
  const setup = useCallback(() => {
    if (!owner || !activeAccount) return;
    loadGuardianContext(owner, activeAccount.index, chain, BigInt(evmChain.chainIdDecimal)).then(
      (ctx) => {
        setSetupError(null);
        setContactsNetworkId(ctx.contactsNetworkId);
        setBundle(ctx.bundle);
        setResolution(ctx.resolution);
      },
      (e: unknown) => setSetupError(e instanceof Error ? e.message : String(e)),
    );
  }, [owner, activeAccount, chain, evmChain.chainIdDecimal]);
  useEffect(setup, [setup]);

  // The account's recovery record: started here for a factory account
  // (the engine checks the CREATE2 lineage); a recovered account brings its
  // own (attached by the recovery flow or imported).
  const reload = useCallback(() => {
    if (!resolution?.ok || !bundle || !owner || !activeAccount) return;
    const r = resolution;
    (async () => {
      let e: RecoveryRecordEntry | null = null;
      let recErr: string | null = null;
      try {
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
      } catch (err) {
        // Shown on screen; the chain status is still read below.
        recErr = `The recovery record could not be read or started: ${err instanceof Error ? err.message : String(err)}`;
      }
      const st = await readGuardianStatus(bundle.node, r.account, e);
      const views = await Promise.all(
        (e?.watched ?? []).map((w) => readProposalView(bundle.node, r.account, w, st.state.set?.threshold ?? null)),
      );
      return { e, st, views, recErr };
    })().then(
      ({ e, st, views, recErr }) => {
        setRecordError(recErr);
        setEntry(e);
        setStatus(st);
        setProposals(views);
      },
      (err: unknown) => setRecordError(err instanceof Error ? err.message : String(err)),
    );
  }, [resolution, bundle, owner, activeAccount, chain, ownerPath]);
  useEffect(reload, [reload]);

  useEffect(() => {
    if (!contactsNetworkId) return;
    listContacts(contactsNetworkId).then(setContacts, () => setContacts([]));
  }, [contactsNetworkId]);

  /** A guardian's label: the recovery record's, else an EXACT contact match. */
  const labelFor = useCallback(
    (address: string): string | null => {
      const recorded = entry?.metadata.guardians?.guardians.find((g) => g.address.toLowerCase() === address.toLowerCase());
      if (recorded?.label) return recorded.label;
      return contactsNetworkId ? (findExactContact(contactsNetworkId, address, contacts)?.name ?? null) : null;
    },
    [entry, contacts, contactsNetworkId],
  );

  const draftMatches = useMemo(
    () =>
      drafts.map((d) =>
        contactsNetworkId && d.address.trim() ? matchRecipient(contactsNetworkId, d.address.trim(), contacts) : null,
      ),
    [drafts, contacts, contactsNetworkId],
  );

  /** The form's set when it validates (engine rules), for the live exposure warning. */
  const draftSet = useMemo((): { set: KernelGuardianSet; labels: Record<string, string> } | null => {
    if (!account || !owner) return null;
    try {
      const built = buildGuardianSet({ drafts, threshold, delaySeconds, noVetoAcknowledged: noVetoAck });
      return validateGuardianSetForAccount(built.set, { account, owner }) === null ? built : null;
    } catch {
      return null;
    }
  }, [drafts, threshold, delaySeconds, noVetoAck, account, owner]);

  const draftLabelFor = useCallback(
    (address: string) => draftSet?.labels[address.toLowerCase()] ?? labelFor(address),
    [draftSet, labelFor],
  );

  // ------------------------------------------------------------ actions

  const describe = (e: unknown) =>
    (bundle ? describeAaError(e, { accountType: bundle.accountType, deployed: true }) : null) ?? describeSendError(e, symbol);

  const onReview = async () => {
    if (!bundle || !account || !owner) return;
    setFormError(null);
    if (!evmChain.testnet && !mainnetAck) {
      setFormError(GUARDIANS_MAINNET_CONDITION);
      return;
    }
    let built: { set: KernelGuardianSet; labels: Record<string, string> };
    try {
      built = buildGuardianSet({ drafts, threshold, delaySeconds, noVetoAcknowledged: noVetoAck });
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
      return;
    }
    // The engine's refusal is shown verbatim, before any network request.
    const refusal = validateGuardianSetForAccount(built.set, { account, owner });
    if (refusal) {
      setFormError(refusal);
      return;
    }
    setPhase('quoting');
    try {
      const op = renewing
        ? await prepareGuardianRenewQuote(bundle, owner, account, built.set, built.labels)
        : await prepareGuardianInstallQuote(bundle, owner, account, built.set, built.labels);
      setOperation(op);
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
      setOperation(await prepareGuardianRemoveQuote(bundle, owner, account));
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

  const onConfirm = async () => {
    const op = operation;
    if (!op || !bundle || !owner) return;
    const what =
      op.kind === 'install'
        ? 'Approve installing guardians'
        : op.kind === 'renew'
          ? 'Approve changing the guardians'
          : op.kind === 'remove'
            ? 'Approve removing the guardians'
            : 'Approve vetoing this recovery';
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
        // The OWNER key signs (root validator), only for the owner EOA the
        // quote was prepared for.
        submit: (q) => signWith(EVM_CHAIN_ID, owner, (signer) => sendAa(bundle, signer, q)),
      });
      setProgress({ kind: op.kind, userOpHash, state: 'pending', txHash: null, detail: null });
      setPhase('progress');
      void finalizeGuardianOperation({
        bundle,
        userOpHash,
        chain,
        account: op.account,
        kind: op.kind,
        store: AsyncStorage,
      }).then(
        ({ receipt, matches }) =>
          setProgress((prev) =>
            prev && prev.userOpHash === userOpHash
              ? {
                  ...prev,
                  state: receipt.success === false ? 'failed' : 'done',
                  txHash: receipt.txHash,
                  detail:
                    op.kind === 'veto'
                      ? null
                      : matches
                        ? 'The recovery record matches the chain.'
                        : 'The recovery record does not match the chain yet; use “Update record from chain” on the Guardians screen.',
                }
              : prev,
          ),
        () => setProgress((prev) => (prev && prev.userOpHash === userOpHash ? { ...prev, state: 'timeout' } : prev)),
      );
    } catch (e) {
      const { title, detail } = describe(e);
      Alert.alert(title, detail);
      setPhase('confirm');
      reload();
    }
  };

  const onWatch = () => {
    if (!account) return;
    addWatchedProposal(chain, account, watchInput).then(
      () => {
        setWatchInput('');
        reload();
      },
      (e: unknown) => Alert.alert('Not added', e instanceof Error ? e.message : String(e)),
    );
  };

  const startForm = (renew: boolean) => {
    setRenewing(renew);
    setFormError(null);
    if (renew && status?.state.set) {
      const s = status.state.set;
      setDrafts(s.guardians.map((g) => ({ address: g.address, label: labelFor(g.address) ?? '', weight: String(g.weight) })));
      setThreshold(String(s.threshold));
      setDelaySeconds(s.delaySeconds);
      setNoVetoAck(s.delaySeconds === 0);
    }
    setPhase('form');
  };

  // ------------------------------------------------------------ render

  const header = (
    <>
      <Text style={[styles.hint, { color: theme.textMuted }]}>
        {evmChain.label}
        {evmChain.testnet ? ' · TESTNET' : ''} · chain id {evmChain.chainIdDecimal}
      </Text>
      <InfoRow label="Owner account (signs setup, changes and vetoes)" value={activeAccount?.name ?? 'Account'} sub={owner} />
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

  if (phase === 'backup' && entry) {
    const exp = recordExport(entry.metadata);
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <Text style={[styles.title, { color: theme.text }]}>Back up the recovery record</Text>
        <Text style={[styles.hint, { color: theme.text }]}>{RECOVERY_RECORD_NOTE}</Text>
        <PayloadQr value={exp.qrValue} caption={`Recovery record for ${entry.metadata.account} (${exp.bytes} bytes)`} />
        <ShareActions text={exp.shareText} shareTitle="Recovery record" />
        <Button
          title="I saved it somewhere other than this phone"
          onPress={() => {
            markRecordExported(entry.metadata.chainId, entry.metadata.account).then(
              (e) => {
                setEntry(e);
                setPhase('overview');
              },
              (err: unknown) => Alert.alert('Not saved', err instanceof Error ? err.message : String(err)),
            );
          }}
        />
        <Button title="Later" variant="secondary" onPress={() => setPhase('overview')} />
      </ScrollView>
    );
  }

  if (phase === 'progress' && progress) {
    const what =
      progress.kind === 'install'
        ? 'Guardian setup'
        : progress.kind === 'renew'
          ? 'Guardian change'
          : progress.kind === 'remove'
            ? 'Guardian removal'
            : 'Veto';
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <Text style={[styles.title, { color: theme.success }]}>{what} sent to the bundler</Text>
        <InfoRow label="UserOperation hash" value={progress.userOpHash} monoValue />
        {progress.state === 'pending' ? (
          <View style={styles.center}>
            <ActivityIndicator color={theme.accent} />
            <Text style={[styles.hint, { color: theme.textMuted }]}>Bundling… waiting for the receipt.</Text>
          </View>
        ) : null}
        {progress.state === 'done' ? (
          <Text style={[styles.ok, { color: theme.success }]}>
            Included on-chain — succeeded.{progress.detail ? ` ${progress.detail}` : ''}
          </Text>
        ) : null}
        {progress.state === 'failed' ? <WarningBox>Included, but the operation reverted. {progress.detail ?? ''}</WarningBox> : null}
        {progress.state === 'timeout' ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            Not included within two minutes. It may still be included; the Guardians screen reads the chain.
          </Text>
        ) : null}
        {progress.txHash ? (
          <Button
            title="View bundle transaction"
            variant="secondary"
            onPress={() => void Linking.openURL(`${evmChain.explorerTxBase}${progress.txHash}`)}
          />
        ) : null}
        {progress.state === 'done' && (progress.kind === 'install' || progress.kind === 'renew') ? (
          <>
            <WarningBox>
              Back up the updated recovery record now. It lists your guardians and every owner this account has
              had; a restored wallet needs it once an owner has changed.
            </WarningBox>
            <Button
              title="Back up the recovery record"
              onPress={() => {
                setProgress(null);
                getRecoveryRecord(chain, account ?? '').then((e) => {
                  setEntry(e);
                  setPhase(e ? 'backup' : 'overview');
                }, () => setPhase('overview'));
              }}
            />
          </>
        ) : null}
        <Button
          title="Done"
          variant={progress.state === 'done' && progress.kind !== 'veto' && progress.kind !== 'remove' ? 'secondary' : 'primary'}
          onPress={() => {
            setProgress(null);
            setOperation(null);
            setPhase('overview');
            reload();
          }}
        />
      </ScrollView>
    );
  }

  if ((phase === 'confirm' || phase === 'sending') && operation) {
    const q = operation.quote;
    const title =
      operation.kind === 'install'
        ? 'Install these guardians?'
        : operation.kind === 'renew'
          ? 'Replace the guardians?'
          : operation.kind === 'remove'
            ? 'Remove all guardians?'
            : 'Veto this recovery?';
    const opLine =
      operation.kind === 'install'
        ? '2 calls to your own account: installModule (WeightedECDSAValidator, allowed to call only doRecovery) and installModule (RecoveryAction)'
        : operation.kind === 'renew'
          ? 'One call from your account to the guardian contract: renew (replaces the whole list, threshold and delay)'
          : operation.kind === 'remove'
            ? '3 calls to your own account: uninstallValidation, revoke doRecovery access, uninstallModule (RecoveryAction)'
            : `One call from your account to the guardian contract: veto(${operation.proposalHash})`;
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <RecoveryNetworkBadge label={evmChain.label} testnet={evmChain.testnet} />
        <Text style={[styles.title, { color: theme.text }]}>{title}</Text>
        {header}
        {operation.set ? (
          <>
            <GuardianSetView set={operation.set} labelFor={(a) => operation.labels[a.toLowerCase()] ?? labelFor(a)} />
            <GuardianExposureWarning set={operation.set} labelFor={(a) => operation.labels[a.toLowerCase()] ?? labelFor(a)} />
            <Text style={[styles.hint, { color: theme.textMuted }]}>{GUARDIANS_AUDIT_NOTE}</Text>
            {!evmChain.testnet ? <WarningBox>{GUARDIANS_MAINNET_CONDITION}</WarningBox> : null}
          </>
        ) : null}
        {operation.kind === 'remove' ? (
          <Text style={[styles.hint, { color: theme.text }]}>
            After this, nobody can recover the account with guardians, and guardians can no longer sign messages as
            the account. Your recovery phrase still controls it.
          </Text>
        ) : null}
        {operation.kind === 'veto' ? (
          <Text style={[styles.hint, { color: theme.text }]}>
            The proposal is marked rejected and can never execute. A veto stops only this proposal: the guardians
            can propose again. Ask them what happened, and if you no longer trust them, remove or replace them.
          </Text>
        ) : null}
        <InfoRow label="Operation" value={opLine} sub="Signed by your account key as the account's root validator." />
        <InfoRow
          label={q.sponsored ? 'Network fee' : 'Max network fee (bundler estimate)'}
          value={q.sponsored ? 'Sponsored — the account pays 0' : `${formatUnits(q.fee, 18, 18)} ${symbol}`}
        />
        <InfoRow label="Account balance" value={`${formatUnits(q.senderBalance, 18, 18)} ${symbol}`} />
        <Text style={[styles.ok, { color: theme.success }]}>
          Bundler gas estimate passed (eth_estimateUserOperationGas simulated the operation).
        </Text>
        {phase === 'sending' ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={theme.accent} />
            <Text style={[styles.hint, { color: theme.textMuted }]}>Signing and sending…</Text>
          </View>
        ) : (
          <>
            <Button
              title={
                operation.kind === 'install'
                  ? 'Install guardians'
                  : operation.kind === 'renew'
                    ? 'Replace guardians'
                    : operation.kind === 'remove'
                      ? 'Remove guardians'
                      : 'Veto'
              }
              variant={operation.kind === 'remove' || operation.kind === 'veto' ? 'destructive' : 'primary'}
              onPress={() => void onConfirm()}
            />
            <Button
              title="Back"
              variant="secondary"
              onPress={() => {
                const back = operation.kind === 'install' || operation.kind === 'renew' ? 'form' : 'overview';
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
        <Text style={[styles.title, { color: theme.text }]}>{renewing ? 'Change guardians' : 'Set up guardians'}</Text>
        {header}
        <Text style={[styles.hint, { color: theme.text }]}>{GUARDIANS_TRADE_OFF}</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Each guardian is an Ethereum address (a key held by someone you trust). Recovery needs guardians whose
          weights add up to the threshold.
        </Text>
        {drafts.map((d, i) => (
          <View key={i} style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
            <Text style={[styles.hint, { color: theme.textMuted }]}>Guardian {i + 1}</Text>
            <TextInput
              value={d.address}
              onChangeText={(t) => setDrafts((p) => p.map((x, j) => (j === i ? { ...x, address: t } : x)))}
              placeholder="Guardian address (0x…)"
              placeholderTextColor={theme.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              style={[styles.input, { color: theme.text, borderColor: theme.border }]}
            />
            {draftMatches[i] && draftMatches[i]!.kind !== 'none' ? (
              <RecipientContactNotice match={draftMatches[i]!} address={d.address.trim()} />
            ) : null}
            <Button title="Pick from contacts" variant="secondary" onPress={() => setPickerFor(i)} />
            <TextInput
              value={d.label}
              onChangeText={(t) => setDrafts((p) => p.map((x, j) => (j === i ? { ...x, label: t } : x)))}
              placeholder="Label (optional, stored in the recovery record)"
              placeholderTextColor={theme.textMuted}
              style={[styles.input, { color: theme.text, borderColor: theme.border }]}
            />
            <TextInput
              value={d.weight}
              onChangeText={(t) => setDrafts((p) => p.map((x, j) => (j === i ? { ...x, weight: t } : x)))}
              placeholder="Weight (1 or more)"
              placeholderTextColor={theme.textMuted}
              keyboardType="number-pad"
              style={[styles.input, { color: theme.text, borderColor: theme.border }]}
            />
            {drafts.length > 1 ? (
              <Button title="Remove this guardian" variant="secondary" onPress={() => setDrafts((p) => p.filter((_, j) => j !== i))} />
            ) : null}
          </View>
        ))}
        <Button title="Add another guardian" variant="secondary" onPress={() => setDrafts((p) => [...p, { ...EMPTY_GUARDIAN_DRAFT }])} />
        <Text style={[styles.hint, { color: theme.textMuted }]}>Threshold (total weight needed to recover)</Text>
        <TextInput
          value={threshold}
          onChangeText={setThreshold}
          keyboardType="number-pad"
          style={[styles.input, { color: theme.text, borderColor: theme.border }]}
        />
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Delay between the guardians’ on-chain approval and the change of owner. During the delay you can veto
          from this wallet.
        </Text>
        {delayPresetsFor(evmChain.testnet).map((p) => (
          <Button
            key={p.seconds}
            title={delaySeconds === p.seconds ? `✓ ${p.label}` : p.label}
            variant={delaySeconds === p.seconds ? 'primary' : 'secondary'}
            onPress={() => setDelaySeconds(p.seconds)}
          />
        ))}
        {delaySeconds === 0 ? (
          <View style={styles.toggleRow}>
            <Text style={[styles.toggleLabel, { color: theme.text }]}>{NO_VETO_ACK_TEXT}</Text>
            <Switch value={noVetoAck} onValueChange={setNoVetoAck} />
          </View>
        ) : null}
        {draftSet ? (
          <GuardianExposureWarning set={draftSet.set} labelFor={draftLabelFor} />
        ) : (
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            The warning about what these guardians could do appears here once the list is complete.
          </Text>
        )}
        <Text style={[styles.hint, { color: theme.textMuted }]}>{GUARDIANS_AUDIT_NOTE}</Text>
        {!evmChain.testnet ? (
          <>
            <WarningBox>{GUARDIANS_MAINNET_CONDITION}</WarningBox>
            <View style={styles.toggleRow}>
              <Text style={[styles.toggleLabel, { color: theme.text }]}>{GUARDIANS_MAINNET_ACK}</Text>
              <Switch value={mainnetAck} onValueChange={setMainnetAck} />
            </View>
          </>
        ) : null}
        {formError ? <WarningBox>{formError}</WarningBox> : null}
        {phase === 'quoting' ? (
          <View style={styles.center}>
            <ActivityIndicator color={theme.accent} />
            <Text style={[styles.hint, { color: theme.textMuted }]}>Reading the account and asking the bundler…</Text>
          </View>
        ) : (
          <>
            <Button title="Review" onPress={() => void onReview()} />
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
            if (index !== null) {
              setDrafts((p) => p.map((x, j) => (j === index ? { ...x, address: c.address, label: x.label || c.name } : x)));
            }
          }}
          onClose={() => setPickerFor(null)}
        />
      </ScrollView>
    );
  }

  // ------------------------------------------------------------ overview
  const set = status?.state.set ?? null;
  const configured = status?.state.validatorInitialized === true;
  return (
    <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {header}
      {!owner ? <Text style={[styles.error, { color: theme.danger }]}>No Ethereum address for this account.</Text> : null}
      {setupError ? <Text style={[styles.error, { color: theme.danger }]}>{setupError}</Text> : null}
      {resolution === null && !setupError && owner ? <ActivityIndicator color={theme.accent} /> : null}
      {resolution && !resolution.ok ? <WarningBox>{resolution.reason}</WarningBox> : null}
      {recordError ? <WarningBox>{recordError}</WarningBox> : null}
      {resolution?.ok ? (
        <>
          <Text style={[styles.sectionTitle, { color: theme.text }]}>Guardians</Text>
          {status === null ? <ActivityIndicator color={theme.accent} /> : null}
          {status && !configured ? (
            <>
              <Text style={[styles.hint, { color: theme.text }]}>No guardians are set up for this account.</Text>
              <Text style={[styles.hint, { color: theme.textMuted }]}>{GUARDIANS_TRADE_OFF}</Text>
              <Button title="Set up guardians" onPress={() => startForm(false)} />
            </>
          ) : null}
          {status && configured && set ? (
            <>
              <Text style={[styles.ok, { color: status.state.active ? theme.text : theme.danger }]}>
                {status.state.active
                  ? 'Guardians are installed and can recover this account.'
                  : 'Guardians are only partly installed on-chain (recovery would not work). Remove them and set them up again.'}
              </Text>
              <GuardianSetView set={set} labelFor={labelFor} />
              <GuardianExposureWarning set={set} labelFor={labelFor} />
              <Text style={[styles.hint, { color: theme.textMuted }]}>{GUARDIANS_AUDIT_NOTE}</Text>
              <Button title="Change guardians (renew)" variant="secondary" onPress={() => startForm(true)} />
              <Button title="Remove guardians" variant="destructive" onPress={() => void onRemoveQuote()} />
            </>
          ) : null}

          <Text style={[styles.sectionTitle, { color: theme.text }]}>Recovery proposals (veto)</Text>
          <Text style={[styles.hint, { color: theme.textMuted }]}>{PROPOSAL_DISCOVERY_NOTE}</Text>
          {proposals.length === 0 ? <Text style={[styles.hint, { color: theme.textMuted }]}>None watched.</Text> : null}
          {proposals.map((p) => {
            const left = p.state?.status === 'approved' ? Math.max(0, p.state.validAfter - now) : null;
            return (
              <View key={p.hash} style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
                <InfoRow label="Proposal id" value={p.hash} monoValue />
                {p.newOwner ? <InfoRow label="Proposed new owner" value={p.newOwner} monoValue /> : null}
                <Text style={[styles.ok, { color: p.canVeto ? theme.danger : theme.text }]}>{p.text}</Text>
                {left !== null && left > 0 ? (
                  <Text style={[styles.hint, { color: theme.text }]}>Time left before it can execute: {formatDuration(left)}</Text>
                ) : null}
                {p.canVeto ? <Button title="Veto" variant="destructive" onPress={() => void onVetoQuote(p.hash)} /> : null}
                <Button
                  title="Stop watching"
                  variant="secondary"
                  onPress={() => void removeWatchedProposal(chain, resolution.account, p.hash).then(reload, reload)}
                />
              </View>
            );
          })}
          <PasteOrScan
            value={watchInput}
            onChange={setWatchInput}
            placeholder="Paste a recovery request or a proposal id (0x…)"
            rationale="Scan the recovery request your guardian showed you."
          />
          <Button title="Watch this proposal" variant="secondary" disabled={!watchInput.trim() || !entry} onPress={onWatch} />

          <Text style={[styles.sectionTitle, { color: theme.text }]}>Recovery record</Text>
          <Text style={[styles.hint, { color: theme.textMuted }]}>{RECOVERY_RECORD_NOTE}</Text>
          {entry ? (
            <>
              <Text style={[styles.hint, { color: entry.exportedAt ? theme.text : theme.danger }]}>
                {entry.exportedAt
                  ? `Backed up off-device ${new Date(entry.exportedAt).toISOString().slice(0, 10)}.`
                  : 'Not backed up since its last change.'}
              </Text>
              {status?.recordCheck ? (
                status.recordCheck.ok ? (
                  <Text style={[styles.ok, { color: theme.success }]}>Matches the chain ✓</Text>
                ) : (
                  <>
                    <WarningBox>Differs from the chain: {status.recordCheck.problems.join('; ')}</WarningBox>
                    <Button
                      title="Update record from chain"
                      variant="secondary"
                      onPress={() => {
                        if (!bundle) return;
                        syncRecordGuardiansFromChain(bundle.node, chain, resolution.account).then(reload, (e: unknown) =>
                          Alert.alert('Not updated', e instanceof Error ? e.message : String(e)),
                        );
                      }}
                    />
                  </>
                )
              ) : null}
              <Button title="Back up the recovery record" variant="secondary" onPress={() => setPhase('backup')} />
            </>
          ) : (
            <Text style={[styles.hint, { color: theme.textMuted }]}>
              No record for this account on this device. Import it on the Recover screen (Settings → Guardians).
            </Text>
          )}
          <Button title="Refresh" variant="secondary" onPress={reload} />
        </>
      ) : null}
    </ScrollView>
  );
}

/**
 * The active account's guardian context: its AA bundle from the verified
 * configuration (with the owner, so a recovered or 7702 account gets its own
 * bundle), whether guardians can live there, and the contacts network id.
 */
async function loadGuardianContext(
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
        reason: `${e instanceof Error ? e.message : String(e)} Guardians need a verified bundler and a deployed Kernel v3.3 account.`,
      },
      contactsNetworkId: endpoint.network.chainId,
    };
  }
  return { bundle, resolution: await resolveGuardianAccount(bundle, owner), contactsNetworkId: endpoint.network.chainId };
}
