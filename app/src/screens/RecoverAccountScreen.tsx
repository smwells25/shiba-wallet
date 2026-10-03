import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, Text, TextInput, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { httpTransport, type JsonRpcTransport, type KernelRecoveryMetadata } from '@shiba-wallet/chains-evm';
import type { RootStackParamList } from '../navigation';
import { Button, TestNetworksOnlyCard, WarningBox, screenStyle } from '../components';
import {
  GuardianSetView,
  InfoRow,
  PasteOrScan,
  PayloadQr,
  RecoveryNetworkBadge,
  ShareActions,
  WeightProgress,
  recoveryLayout as styles,
} from '../components/RecoveryViews';
import { RecordFileExportButton, pickRecordFile } from '../components/RecordFileActions';
import { useTheme } from '../theme';
import { readinessGate } from '../config/readiness';
import { getEndpoint } from '../config/networks';
import { useWallet } from '../wallet/WalletContext';
import { usePrefs } from '../wallet/PrefsContext';
import { requireLocalAuth } from '../wallet/biometric';
import { formatUnits } from '../wallet/balances';
import { EVM_CHAIN_ID, describeSendError } from '../wallet/send';
import {
  GUARDIAN_SUBMITS_NOTE,
  NEW_WALLET_PAYS_NOTE,
  QR_MAX_BYTES,
  RECOVERED_NOT_DERIVABLE_NOTE,
  addApprovalToProgress,
  applyRecordImport,
  attachRecoveredAccount,
  draftRecoveryProgress,
  encodeRecoveryRequestPayload,
  findRecoveryTransaction,
  formatDuration,
  getRecoveryProgress,
  parseRecordFile,
  parseRecordText,
  prepareApproveWithSig,
  prepareRecoveryStart,
  readRecoveryStage,
  rebuildRecoveryRecord,
  recordExport,
  recoveryApprovalProgress,
  recoveryRequestShareText,
  removeRecoveryProgress,
  reviewRecordImport,
  saveRecoveryProgress,
  searchOwnedKernelAccounts,
  sendApproveWithSig,
  utf8Length,
  waitForTransaction,
  type ApproveWithSigQuote,
  type RecordImportReview,
  type RecoveryCandidate,
  type RecoveryProgress,
  type RecoveryStage,
} from '../wallet/recovery';

type Props = NativeStackScreenProps<RootStackParamList, 'RecoverAccount'>;

type Phase = 'start' | 'checking' | 'candidate' | 'import-review' | 'progress' | 'approve-confirm' | 'sending' | 'attached';

/**
 * "Recover an account with guardians" (phase 8 item 4) — the lost-phrase
 * case on a NEW wallet. The ACTIVE account's EOA becomes the new owner of a
 * Kernel v3.3 account this wallet does not control yet:
 *  1. the lost account's address (or its backed-up recovery record) is
 *     checked on-chain (recovery.ts prepareRecoveryStart: a Kernel v3.3
 *     proxy with ACTIVE guardians), and the engine builds the request;
 *  2. the request goes to the guardians as a QR code / shareable text; their
 *     approvals come back the same way and are verified one by one
 *     (verifyGuardianApproval), with the weight shown;
 *  3. with a delay, this wallet sends the approvals on-chain
 *     (approveWithSig — anyone may; this account pays) and counts down;
 *  4. a guardian submits the final operation (the contract requires a
 *     guardian's signature on it; GUARDIAN_SUBMITS_NOTE);
 *  5. once the chain shows the new owner, "Use this recovered account"
 *     attaches it — only after verifyKernelAccountForOwner — and appends the
 *     owner change to the account's recovery record.
 * The same screen restores a record whose account this wallet already owns
 * ("import a recovery record"), and can search recent blocks for accounts
 * owned by the active account.
 */
export function RecoverAccountScreen({ navigation }: Props) {
  const theme = useTheme();
  const { accounts, activeAccount, accountList, addAccount, switchAccount, signWith } = useWallet();
  const { evmChain } = usePrefs();
  const evm = accounts.find((a) => a.chainId === EVM_CHAIN_ID) ?? null;
  const owner = evm?.address ?? null;
  const chain = evmChain.caip2;
  const chainId = BigInt(evmChain.chainIdDecimal);
  const symbol = evmChain.displaySymbol;
  // Mainnet readiness (config/readiness.ts): guardian recovery is
  // test-network only. Reading status, searching recent blocks, importing a
  // record and forgetting a recovery stay available; recovery.ts refuses
  // starting a recovery, sending approvals and attaching too.
  const readiness = readinessGate('guardians', chain);
  const readinessCard = readiness ? <TestNetworksOnlyCard feature={readiness.feature} hint={readiness.hint} style={styles.card} titleStyle={styles.ok} bodyStyle={styles.hint} hintStyle={styles.hint} /> : null;

  const [node, setNode] = useState<JsonRpcTransport | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('start');
  const [progress, setProgress] = useState<RecoveryProgress | null>(null);
  const [stage, setStage] = useState<RecoveryStage | null>(null);
  const [stageError, setStageError] = useState<string | null>(null);
  const [accountInput, setAccountInput] = useState('');
  const [recordInput, setRecordInput] = useState('');
  const [originalOwnerInput, setOriginalOwnerInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<RecoveryCandidate | null>(null);
  const [candidateMeta, setCandidateMeta] = useState<KernelRecoveryMetadata | null>(null);
  const [importReview, setImportReview] = useState<RecordImportReview | null>(null);
  const [approvalInput, setApprovalInput] = useState('');
  const [approveQuote, setApproveQuote] = useState<ApproveWithSigQuote | null>(null);
  const [txNote, setTxNote] = useState<string | null>(null);
  const [hashInput, setHashInput] = useState('');
  const [attachedMeta, setAttachedMeta] = useState<KernelRecoveryMetadata | null>(null);
  const [searchResult, setSearchResult] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    navigation.setOptions({ title: 'Recover an account' });
  }, [navigation]);

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    getEndpoint(EVM_CHAIN_ID).then(
      (endpoint) => {
        if (!endpoint?.url) setSetupError('No RPC endpoint is configured for this network.');
        else setNode(() => httpTransport(endpoint.url!));
      },
      (e: unknown) => setSetupError(e instanceof Error ? e.message : String(e)),
    );
  }, [chain]);

  // A recovery in progress for the active account (it survives restarts,
  // account switches and the delay).
  const loadProgress = useCallback(() => {
    if (!owner) return;
    getRecoveryProgress(chain, owner).then(
      (p) => {
        setProgress(p);
        if (p?.request) setPhase((prev) => (prev === 'start' ? 'progress' : prev));
      },
      () => setProgress(null),
    );
  }, [owner, chain]);
  useEffect(loadProgress, [loadProgress]);

  const refreshStage = useCallback(() => {
    if (!node || !progress?.request) return;
    readRecoveryStage(node, progress).then(
      ({ stage: s }) => {
        setStageError(null);
        setStage(s);
      },
      (e: unknown) => setStageError(e instanceof Error ? e.message : String(e)),
    );
  }, [node, progress]);
  useEffect(refreshStage, [refreshStage]);

  const ownerName = activeAccount?.name ?? 'This account';
  const guardianAccountsHere = (progress?.set?.guardians ?? [])
    .map((g) => accountList.find((a) => a.evmAddress?.toLowerCase() === g.address.toLowerCase()))
    .filter((a): a is NonNullable<typeof a> => a !== undefined);

  // ------------------------------------------------------------ actions

  const onFreshAccount = () => {
    Alert.alert(
      'Use a fresh account?',
      'A new account named “Recovered account” is added to this wallet and made active. Its key will become ' +
        'the owner of the recovered account. The app returns to Home; open “Recover an account with guardians” ' +
        'again to continue.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Add account',
          onPress: () => {
            void (async () => {
              try {
                const added = await addAccount('Recovered account');
                if (added.evmAddress) {
                  await saveRecoveryProgress(draftRecoveryProgress(chain, added.index, added.evmAddress));
                }
                await switchAccount(added.index);
              } catch (e) {
                Alert.alert('Not added', e instanceof Error ? e.message : String(e));
              }
            })();
          },
        },
      ],
    );
  };

  /**
   * Checks the lost account. `recordText` overrides the pasted record (the
   * "Import from file" button passes the file's text here), so a file goes
   * through exactly the same strict parse and review as pasted text.
   */
  const onCheck = async (recordText: string = recordInput) => {
    if (!node || !owner) return;
    setError(null);
    setCandidate(null);
    setImportReview(null);
    setPhase('checking');
    try {
      let meta: KernelRecoveryMetadata | null = null;
      let account = accountInput.trim();
      if (recordText.trim() !== '') {
        meta = parseRecordText(recordText);
        account = meta.account;
        // A record whose account one of THIS wallet's accounts already owns
        // is a restore: review and attach it instead of recovering.
        const owned = accountList
          .filter((a) => a.evmAddress)
          .map((a) => ({ index: a.index, address: a.evmAddress!, path: `m/44'/60'/0'/0/${a.index}` }));
        const review = await reviewRecordImport(node, recordText, owned);
        if (review.ownerAccount) {
          setImportReview(review);
          setPhase('import-review');
          return;
        }
      }
      if (!meta && originalOwnerInput.trim() !== '') {
        meta = rebuildRecoveryRecord({
          chainId,
          account,
          originalOwner: originalOwnerInput.trim(),
          recordedAt: Math.floor(Date.now() / 1000),
        });
      }
      const result = await prepareRecoveryStart(node, { chainId, account, newOwner: owner, metadata: meta });
      setCandidate(result);
      setCandidateMeta(meta);
      setPhase('candidate');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('start');
    }
  };

  /**
   * "Import from file": the system document picker (JSON files only), then
   * recovery.ts parseRecordFile (one JSON record per file, size cap, the
   * engine's strict parser), then the same check as a pasted record.
   */
  const onImportFile = async () => {
    setError(null);
    try {
      const picked = await pickRecordFile();
      if (!picked) return;
      const { text } = parseRecordFile(picked.text, { name: picked.name, size: picked.size, mimeType: picked.mimeType });
      setRecordInput(text);
      await onCheck(text);
    } catch (e) {
      setError(`The file was not imported: ${e instanceof Error ? e.message : String(e)}`);
      setPhase('start');
    }
  };

  const onCreateRequest = async () => {
    if (!candidate || candidate.kind !== 'recoverable' || !owner || !activeAccount) return;
    try {
      const base = progress && progress.request === null ? progress : draftRecoveryProgress(chain, activeAccount.index, owner);
      const saved = await saveRecoveryProgress({
        ...base,
        account: candidate.account,
        request: candidate.request,
        set: candidate.set,
        approvals: [],
        approveTxHash: null,
        metadata: candidateMeta,
      });
      setProgress(saved);
      setPhase('progress');
    } catch (e) {
      Alert.alert('Not saved', e instanceof Error ? e.message : String(e));
    }
  };

  const onAddApproval = async () => {
    if (!progress) return;
    try {
      const { progress: next, guardian, added } = addApprovalToProgress(progress, approvalInput);
      if (!added) {
        Alert.alert('Already added', `${guardian.address} has already approved.`);
        return;
      }
      setProgress(await saveRecoveryProgress(next));
      setApprovalInput('');
    } catch (e) {
      Alert.alert('Approval not accepted', e instanceof Error ? e.message : String(e));
    }
  };

  const onApproveQuote = async () => {
    if (!node || !progress || !owner) return;
    try {
      setApproveQuote(await prepareApproveWithSig(node, { progress, from: owner }));
      setPhase('approve-confirm');
    } catch (e) {
      const { title, detail } = describeSendError(e, symbol);
      Alert.alert(title, detail);
    }
  };

  const onApproveSend = async () => {
    if (!node || !approveQuote || !progress) return;
    const auth = await requireLocalAuth('Approve sending the guardians’ approvals');
    if (!auth.ok) {
      Alert.alert('Not sent', auth.message);
      return;
    }
    setPhase('sending');
    try {
      const txid = await signWith(EVM_CHAIN_ID, approveQuote.from, (signer) => sendApproveWithSig(node, signer, approveQuote));
      const saved = await saveRecoveryProgress({ ...progress, approveTxHash: txid });
      setProgress(saved);
      setApproveQuote(null);
      setTxNote(`Approvals sent: ${txid}. Waiting for inclusion…`);
      setPhase('progress');
      void waitForTransaction(node, txid).then(
        ({ success }) => {
          setTxNote(success ? `Approvals included on-chain (${txid}).` : `The approval transaction reverted (${txid}).`);
          refreshStage();
        },
        () => setTxNote(`Not included within two minutes (${txid}); it may still be. Refresh later.`),
      );
    } catch (e) {
      const { title, detail } = describeSendError(e, symbol);
      Alert.alert(title, detail);
      setPhase('approve-confirm');
    }
  };

  const onAttach = async () => {
    if (!node || !progress?.account || !owner) return;
    try {
      const found = await findRecoveryTransaction(node, progress.account, owner).catch(() => null);
      const pasted = hashInput.trim();
      const change = found
        ? { txHash: found.txHash, userOpHash: /^0x[0-9a-fA-F]{64}$/.test(pasted) ? pasted.toLowerCase() : null, blockNumber: found.blockNumber }
        : /^0x[0-9a-fA-F]{64}$/.test(pasted)
          ? { txHash: null, userOpHash: pasted.toLowerCase(), blockNumber: null }
          : null;
      const result = await attachRecoveredAccount({
        node,
        chain,
        account: progress.account,
        owner,
        ownerPath: evm?.path ?? null,
        metadata: progress.metadata,
        change,
      });
      await removeRecoveryProgress(chain, owner);
      setAttachedMeta(result.entry?.metadata ?? null);
      if (result.entry && !result.historyUpdated) {
        Alert.alert(
          'Attached; record not updated',
          'The account is attached, but its recovery record could not be extended: the recovery transaction was not ' +
            'found in recent blocks and no hash was pasted. The record still shows the previous owner.',
        );
      }
      setPhase('attached');
    } catch (e) {
      Alert.alert('Not attached', e instanceof Error ? e.message : String(e));
    }
  };

  const onApplyImport = async () => {
    if (!node || !importReview) return;
    try {
      const { attached, entry } = await applyRecordImport({ node, review: importReview });
      setAttachedMeta(entry.metadata);
      Alert.alert(
        attached ? 'Recovered account attached' : 'Record saved',
        attached
          ? `${importReview.metadata.account} is now used for smart-account sends by ${
              accountList.find((a) => a.index === importReview.ownerAccount?.index)?.name ?? 'its owner account'
            } on this network.`
          : 'This account is derivable from your recovery phrase; the record is kept for its history and guardians.',
      );
      setPhase('attached');
    } catch (e) {
      Alert.alert('Not imported', e instanceof Error ? e.message : String(e));
    }
  };

  const onCancelRecovery = () => {
    if (!owner) return;
    Alert.alert(
      'Forget this recovery?',
      'Only this device forgets it. Approvals already sent on-chain stay there; nothing else changes.',
      [
        { text: 'Keep', style: 'cancel' },
        {
          text: 'Forget',
          style: 'destructive',
          onPress: () => {
            void removeRecoveryProgress(chain, owner).then(() => {
              setProgress(null);
              setStage(null);
              setPhase('start');
            });
          },
        },
      ],
    );
  };

  const onSearch = () => {
    if (!node || !owner) return;
    setSearchResult('Searching the last ~9,000 blocks…');
    searchOwnedKernelAccounts(node, owner).then(
      ({ verified, rejected }) =>
        setSearchResult(
          verified.length > 0
            ? `Accounts owned by ${owner} (verified on-chain): ${verified.join(', ')}. Paste one above to attach it.`
            : `No verified accounts in recent blocks${rejected.length ? ` (${rejected.length} candidates failed verification)` : ''}. ` +
                'Older recoveries need the recovery record or the address.',
        ),
      (e: unknown) => setSearchResult(`Search failed: ${e instanceof Error ? e.message : String(e)}`),
    );
  };

  // ------------------------------------------------------------ render

  const ownerRow = (
    <InfoRow
      label="New owner (this wallet's account)"
      value={ownerName}
      sub={`${owner ?? ''}\nThe recovered account will be controlled by this account's key.`}
    />
  );

  if (phase === 'attached') {
    const exp = attachedMeta ? recordExport(attachedMeta) : null;
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <Text style={[styles.title, { color: theme.success }]}>Recovered account attached</Text>
        <WarningBox>{RECOVERED_NOT_DERIVABLE_NOTE}</WarningBox>
        {exp ? (
          <>
            <Text style={[styles.hint, { color: theme.text }]}>
              Back up the updated recovery record now (it lists the new owner):
            </Text>
            <PayloadQr value={exp.qrValue} caption="Recovery record" />
            {attachedMeta ? <RecordFileExportButton metadata={attachedMeta} /> : null}
            <ShareActions text={exp.shareText} shareTitle="Recovery record" />
          </>
        ) : (
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            No recovery record exists for this account on this device. Write down its address somewhere safe.
          </Text>
        )}
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          To hand this account to another of your accounts (for example the one you normally use), use Change owner. The
          address stays the same.
        </Text>
        <Button title="Change owner…" variant="secondary" onPress={() => navigation.navigate('OwnerRotation')} />
        <Button title="Done" onPress={() => navigation.navigate('Home')} />
      </ScrollView>
    );
  }

  if ((phase === 'approve-confirm' || phase === 'sending') && approveQuote) {
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <RecoveryNetworkBadge label={evmChain.label} testnet={evmChain.testnet} />
        <Text style={[styles.title, { color: theme.text }]}>Send the guardians’ approvals on-chain?</Text>
        <Text style={[styles.hint, { color: theme.text }]}>{NEW_WALLET_PAYS_NOTE}</Text>
        <InfoRow label="From (pays the fee)" value={ownerName} sub={approveQuote.from} />
        <InfoRow label="To (guardian contract)" value={approveQuote.to} monoValue />
        <InfoRow
          label="Call"
          value={`approveWithSig for proposal ${progress?.request?.callDataAndNonceHash ?? ''}`}
          sub={`${approveQuote.approvals} approval(s), weight ${approveQuote.weight}. 0 ${symbol} sent.`}
        />
        <InfoRow label="Max network fee" value={`${formatUnits(approveQuote.fee, 18, 18)} ${symbol}`} />
        <InfoRow label="Your balance" value={`${formatUnits(approveQuote.balance, 18, 18)} ${symbol}`} />
        <Text style={[styles.ok, { color: theme.success }]}>Gas estimate passed (eth_estimateGas simulated the call).</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          After inclusion the change can execute {progress?.set ? formatDuration(progress.set.delaySeconds) : ''} later; the
          current owner can veto it until then.
        </Text>
        {phase === 'sending' ? (
          <ActivityIndicator size="large" color={theme.accent} />
        ) : (
          <>
            <Button title="Send approvals" onPress={() => void onApproveSend()} />
            <Button title="Back" variant="secondary" onPress={() => setPhase('progress')} />
          </>
        )}
      </ScrollView>
    );
  }

  if (phase === 'progress' && progress?.request && progress.set) {
    const p = recoveryApprovalProgress(progress);
    const payload = encodeRecoveryRequestPayload(progress.request, progress.approvals);
    const labelFor = (a: string) =>
      progress.metadata?.guardians?.guardians.find((g) => g.address.toLowerCase() === a.toLowerCase())?.label ?? null;
    const secondsLeft = stage?.kind === 'waiting' ? Math.max(0, stage.validAfter - now) : null;
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {readinessCard}
        <Text style={[styles.title, { color: theme.text }]}>Recovering {progress.account}</Text>
        {ownerRow}
        <InfoRow label="Proposal id" value={progress.request.callDataAndNonceHash} monoValue />
        <GuardianSetView set={progress.set} labelFor={labelFor} />
        {setupError ? <WarningBox>{setupError}</WarningBox> : null}
        {stageError ? <WarningBox>{stageError}</WarningBox> : null}
        {stage === null && !stageError && !setupError ? <ActivityIndicator color={theme.accent} /> : null}
        {stage ? <StageLine stage={stage} secondsLeft={secondsLeft} /> : null}
        {txNote ? <Text style={[styles.hint, { color: theme.text }]}>{txNote}</Text> : null}

        {stage?.kind === 'recovered' ? (
          <>
            <Text style={[styles.hint, { color: theme.text }]}>
              The account’s owner is now this wallet’s account. Attach it to use it here. The wallet looks up the
              recovery transaction in recent blocks; if it is older, paste the transaction or UserOperation hash the
              guardian showed you (optional).
            </Text>
            <TextInput
              value={hashInput}
              onChangeText={setHashInput}
              placeholder="UserOperation or transaction hash (optional)"
              placeholderTextColor={theme.textMuted}
              autoCapitalize="none"
              style={[styles.input, { color: theme.text, borderColor: theme.border }]}
            />
            <Button title="Use this recovered account" onPress={() => void onAttach()} disabled={readiness !== null} />
          </>
        ) : null}

        {stage && (stage.kind === 'collecting' || stage.kind === 'ready-to-approve' || stage.kind === 'ready-to-submit') ? (
          <>
            <WeightProgress weight={p.weight} threshold={p.threshold} />
            {p.approvers.map((g) => (
              <Text key={g.address} style={[styles.hint, { color: theme.text }]}>
                ✓ {labelFor(g.address) ?? 'Guardian'} {g.address} (weight {g.weight})
              </Text>
            ))}
            <Text style={[styles.sectionTitle, { color: theme.text }]}>1. Send this request to your guardians</Text>
            <Text style={[styles.hint, { color: theme.textMuted }]}>
              Show the QR code in person, or share the text on a channel your guardians trust. They check the new owner
              address with you and approve in their wallet.
            </Text>
            <PayloadQr value={utf8Length(payload) <= QR_MAX_BYTES ? payload : null} caption="Recovery request (with the approvals so far)" />
            <ShareActions text={recoveryRequestShareText(progress.request, progress.approvals)} shareTitle="Recovery request" />
            <Text style={[styles.sectionTitle, { color: theme.text }]}>2. Add each approval you receive</Text>
            <PasteOrScan
              value={approvalInput}
              onChange={setApprovalInput}
              placeholder="Paste a guardian's approval (or a 65-byte signature from another wallet)"
              rationale="Scan the approval QR code your guardian shows you."
            />
            <Button title="Add approval" variant="secondary" disabled={!approvalInput.trim()} onPress={() => void onAddApproval()} />
          </>
        ) : null}

        {stage?.kind === 'ready-to-approve' ? (
          <>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>3. Send the approvals on-chain</Text>
            <Text style={[styles.hint, { color: theme.textMuted }]}>{NEW_WALLET_PAYS_NOTE}</Text>
            <Button title="Review the approval transaction" onPress={() => void onApproveQuote()} disabled={readiness !== null} />
          </>
        ) : null}

        {stage?.kind === 'ready-to-submit' ? (
          <>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>
              {progress.set.delaySeconds > 0 ? '4.' : '3.'} A guardian submits the recovery
            </Text>
            <Text style={[styles.hint, { color: theme.text }]}>{GUARDIAN_SUBMITS_NOTE}</Text>
            {progress.set.delaySeconds === 0 && p.possibleSubmitters.length > 0 ? (
              <Text style={[styles.hint, { color: theme.textMuted }]}>
                Guardians who can submit now (with the approvals in the QR code above):{' '}
                {p.possibleSubmitters.map((g) => labelFor(g.address) ?? g.address).join(', ')}.
              </Text>
            ) : null}
            {guardianAccountsHere.length > 0 ? (
              <WarningBox>
                {guardianAccountsHere.map((a) => a.name).join(', ')} of THIS wallet{' '}
                {guardianAccountsHere.length === 1 ? 'is a guardian' : 'are guardians'}. Switch to it and open Settings →
                Guardians → Approve a recovery to sign as that guardian.
              </WarningBox>
            ) : null}
          </>
        ) : null}

        {stage && (stage.kind === 'vetoed' || stage.kind === 'stale' || stage.kind === 'executed-other') ? (
          <Button title="Start over" onPress={() => void removeRecoveryProgress(chain, owner ?? '').then(() => { setProgress(null); setStage(null); setPhase('start'); })} />
        ) : null}
        <Button title="Refresh status" variant="secondary" onPress={refreshStage} />
        <Button title="Forget this recovery" variant="secondary" onPress={onCancelRecovery} />
      </ScrollView>
    );
  }

  if (phase === 'import-review' && importReview) {
    const ownerAccount = accountList.find((a) => a.index === importReview.ownerAccount?.index);
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        {readinessCard}
        <Text style={[styles.title, { color: theme.text }]}>Restore from a recovery record</Text>
        <InfoRow label="Account" value={importReview.metadata.account} monoValue />
        <InfoRow label="Owner on-chain" value={ownerAccount ? `${ownerAccount.name} (this wallet)` : 'unknown'} sub={importReview.onChainOwner} />
        <InfoRow label="Owners recorded" value={String(importReview.metadata.owners.length)} />
        {importReview.verification.ok ? (
          <Text style={[styles.ok, { color: theme.success }]}>The record matches the chain ✓</Text>
        ) : (
          <WarningBox>The record differs from the chain: {importReview.verification.problems.join('; ')}</WarningBox>
        )}
        {importReview.needsAttach ? <WarningBox>{RECOVERED_NOT_DERIVABLE_NOTE}</WarningBox> : null}
        <Button
          title={importReview.needsAttach ? 'Use this recovered account' : 'Save the record'}
          onPress={() => void onApplyImport()}
          disabled={importReview.needsAttach && readiness !== null}
        />
        <Button title="Back" variant="secondary" onPress={() => setPhase('start')} />
      </ScrollView>
    );
  }

  if (phase === 'candidate' && candidate) {
    if (candidate.kind === 'already-owner') {
      return (
        <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
          {readinessCard}
          <Text style={[styles.title, { color: theme.text }]}>This account is already yours</Text>
          <Text style={[styles.hint, { color: theme.text }]}>
            {ownerName} already owns {candidate.account} on-chain (checked: Kernel v3.3 proxy, owner validator, owner).
            No recovery is needed; attach it to use it in this wallet.
          </Text>
          <Button
            title="Use this recovered account"
            disabled={readiness !== null}
            onPress={() => {
              if (!node || !owner) return;
              attachRecoveredAccount({ node, chain, account: candidate.account, owner, ownerPath: evm?.path ?? null, metadata: candidateMeta }).then(
                (r) => {
                  setAttachedMeta(r.entry?.metadata ?? null);
                  setPhase('attached');
                },
                (e: unknown) => Alert.alert('Not attached', e instanceof Error ? e.message : String(e)),
              );
            }}
          />
          <Button title="Back" variant="secondary" onPress={() => setPhase('start')} />
        </ScrollView>
      );
    }
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        {readinessCard}
        <RecoveryNetworkBadge label={evmChain.label} testnet={evmChain.testnet} />
        <Text style={[styles.title, { color: theme.text }]}>Recover this account?</Text>
        <InfoRow label="Account to recover" value={candidate.account} monoValue />
        <InfoRow label="Current owner (not this wallet)" value={candidate.currentOwner} monoValue />
        {ownerRow}
        <GuardianSetView
          set={candidate.set}
          labelFor={(a) => candidateMeta?.guardians?.guardians.find((g) => g.address.toLowerCase() === a.toLowerCase())?.label ?? null}
        />
        <Text style={[styles.hint, { color: theme.text }]}>
          {candidate.set.delaySeconds > 0
            ? `Steps: your guardians approve; this wallet sends their approvals on-chain (it pays a small fee); after ${formatDuration(candidate.set.delaySeconds)} a guardian submits the change. The current owner can veto during the delay.`
            : 'Steps: your guardians approve; then a guardian submits the change. With no delay it takes effect at once.'}
        </Text>
        <WarningBox>{RECOVERED_NOT_DERIVABLE_NOTE}</WarningBox>
        {!candidateMeta ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            No recovery record was given, so the account’s history cannot be recorded. If you have its record (or the
            original owner address), go back and add it.
          </Text>
        ) : null}
        <Button title="Create the recovery request" onPress={() => void onCreateRequest()} disabled={readiness !== null} />
        <Button title="Back" variant="secondary" onPress={() => setPhase('start')} />
      </ScrollView>
    );
  }

  // ------------------------------------------------------------ start
  return (
    <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {readinessCard}
      <Text style={[styles.title, { color: theme.text }]}>Recover an account with guardians</Text>
      <Text style={[styles.hint, { color: theme.text }]}>
        For a Kernel smart account whose recovery phrase is lost: its guardians can make a key of THIS wallet the new
        owner. (If you still have the old phrase, import it instead — no guardians needed.)
      </Text>
      {setupError ? <WarningBox>{setupError}</WarningBox> : null}
      {ownerRow}
      {progress && !progress.request ? (
        <Text style={[styles.ok, { color: theme.success }]}>This account was added for the recovery. Continue below.</Text>
      ) : (
        <Button
          title="Use a fresh account for this (recommended)"
          variant="secondary"
          onPress={onFreshAccount}
          disabled={readiness !== null}
        />
      )}
      <Text style={[styles.sectionTitle, { color: theme.text }]}>The lost account</Text>
      <TextInput
        value={accountInput}
        onChangeText={setAccountInput}
        placeholder="Account address (0x…)"
        placeholderTextColor={theme.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        style={[styles.input, { color: theme.text, borderColor: theme.border }]}
      />
      <Text style={[styles.hint, { color: theme.textMuted }]}>Or its recovery record (recommended — it keeps the history):</Text>
      <PasteOrScan
        value={recordInput}
        onChange={setRecordInput}
        placeholder="Paste or scan the recovery record"
        rationale="Scan the recovery record QR code you saved."
      />
      <Button
        title="Import from file (.json)"
        variant="secondary"
        disabled={!node || !owner || phase === 'checking'}
        onPress={() => void onImportFile()}
      />
      <Text style={[styles.hint, { color: theme.textMuted }]}>
        No record? Optional: the account’s ORIGINAL owner address, so the wallet can rebuild its record.
      </Text>
      <TextInput
        value={originalOwnerInput}
        onChangeText={setOriginalOwnerInput}
        placeholder="Original owner address (optional)"
        placeholderTextColor={theme.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        style={[styles.input, { color: theme.text, borderColor: theme.border }]}
      />
      {error ? <WarningBox>{error}</WarningBox> : null}
      {phase === 'checking' ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.accent} />
          <Text style={[styles.hint, { color: theme.textMuted }]}>Checking the account on-chain…</Text>
        </View>
      ) : (
        <Button
          title="Check the account"
          disabled={!node || !owner || (accountInput.trim() === '' && recordInput.trim() === '') || readiness !== null}
          onPress={() => void onCheck(recordInput)}
        />
      )}
      <Text style={[styles.sectionTitle, { color: theme.text }]}>Already recovered elsewhere?</Text>
      <Text style={[styles.hint, { color: theme.textMuted }]}>
        Search recent blocks for Kernel accounts whose owner is {ownerName} (each result is verified on-chain).
      </Text>
      <Button title="Search recent blocks" variant="secondary" disabled={!node || !owner} onPress={onSearch} />
      {searchResult ? <Text selectable style={[styles.hint, { color: theme.text }]}>{searchResult}</Text> : null}
    </ScrollView>
  );
}

function StageLine({ stage, secondsLeft }: { stage: RecoveryStage; secondsLeft: number | null }) {
  const theme = useTheme();
  const text = (() => {
    switch (stage.kind) {
      case 'collecting':
        return 'Waiting for guardians’ approvals.';
      case 'ready-to-approve':
        return 'Enough approvals: send them on-chain to start the delay.';
      case 'waiting':
        return `Approved on-chain. The change can execute in ${formatDuration(secondsLeft ?? stage.secondsLeft)}. The current owner can veto until then.`;
      case 'ready-to-submit':
        return 'Ready: a guardian can submit the recovery now.';
      case 'recovered':
        return 'Recovered: this wallet’s account is now the owner.';
      case 'vetoed':
        return 'The current owner VETOED this recovery. It can never execute. Talk to your guardians before starting over.';
      case 'stale':
        return `These approvals are void: ${stage.reason}`;
      case 'executed-other':
        return `The proposal was consumed, but the owner is ${stage.owner}, not this wallet’s account.`;
    }
  })();
  const color =
    stage.kind === 'recovered' || stage.kind === 'ready-to-submit'
      ? theme.success
      : stage.kind === 'vetoed' || stage.kind === 'stale' || stage.kind === 'executed-other'
        ? theme.danger
        : theme.text;
  return <Text style={[styles.ok, { color }]}>{text}</Text>;
}

