import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, Text, TextInput, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { NodeClient, httpTransport, type JsonRpcTransport } from '@shiba-wallet/chains-evm';
import { Button, TestNetworksOnlyCard, WarningBox, screenStyle } from '../components';
import {
  InfoRow,
  PasteOrScan,
  PayloadQr,
  RecoveryNetworkBadge,
  ShareActions,
  WeightProgress,
  recoveryLayout as styles,
} from '../components/RecoveryViews';
import { pickRecordFile } from '../components/RecordFileActions';
import { useTheme } from '../theme';
import { readinessGate } from '../config/readiness';
import { getEndpoint } from '../config/networks';
import { useWallet } from '../wallet/WalletContext';
import { usePrefs } from '../wallet/PrefsContext';
import { requireLocalAuth } from '../wallet/biometric';
import { formatBalanceDisplay, formatUnits, parseUnits } from '../wallet/balances';
import { EVM_CHAIN_ID, validateRecipient } from '../wallet/send';
import { listTokens } from '../wallet/tokens';
import {
  aaErc20TransferCalls,
  describeAaError,
  getAaConfig,
  waitForAaReceipt,
  type AaClientBundle,
  type AaSendQuote,
} from '../wallet/aa';
import {
  MAX_MULTISIG_COSIGNERS,
  MULTISIG_DEPLOY_NOTE,
  MULTISIG_FRESH_DEPLOY_NOTE,
  MULTISIG_FUND_AND_RETRY,
  MULTISIG_PHRASE_SIGNER_ONLY,
  MULTISIG_TITLE,
  MultisigAuthCancelledError,
  REMOVE_MULTISIG_TITLE,
  addMultisigApproval,
  buildMultisigConfig,
  checkMultisigNetwork,
  chooseMultisigIndex,
  cosignWithGate,
  createMultisigRecord,
  describeMultisigCall,
  encodeMultisigRequestPayload,
  exportMultisigAccount,
  importMultisigRecord,
  listMultisigRecords,
  multisigAddressFor,
  multisigDisplayName,
  multisigConfigOf,
  multisigExportFileName,
  multisigExposureLine,
  multisigFileText,
  multisigOperationCalls,
  multisigQrValue,
  multisigRequestShareText,
  multisigShapeLabel,
  multisigWeightProgress,
  parseMultisigAccountImport,
  prepareMultisigRequest,
  prepareMultisigSubmission,
  readMultisigOnChain,
  recordMultisigOutcome,
  removeMultisigMessage,
  removeMultisigRecord,
  reviewMultisigRequestAsCosigner,
  saveMultisigOperation,
  submitMultisigWithGate,
  type KnownToken,
  type MultisigConfigCheck,
  type MultisigCosignReview,
  type MultisigCosignerDraft,
  type MultisigOperationRecord,
  type MultisigRecord,
  type OwnAccount,
} from '../wallet/multisig';
import {
  MultisigCallsView,
  MultisigFileExportButton,
  MultisigHonesty,
  MultisigRefusedFeatures,
} from './MultisigViews';

type Phase =
  | 'list'
  | 'create'
  | 'create-review'
  | 'detail'
  | 'send-form'
  | 'collect'
  | 'confirm'
  | 'sending'
  | 'progress'
  | 'import'
  | 'import-review'
  | 'cosign-input'
  | 'cosign-review'
  | 'cosign-done';

interface Progress {
  userOpHash: string;
  state: 'pending' | 'done' | 'timeout';
  success: boolean | null;
  txHash: string | null;
}

const NATIVE = 'native';

/**
 * Multi-signature accounts (feature 24, phase 17 item 1; docs/MULTISIG.md
 * section 11). Everything a multisig needs lives on this one screen, so it
 * works without the account switcher: create (deploy fresh, never convert),
 * add one from another phone's record, receive (the address and its QR
 * code), build an operation as a signing request for the co-signers (QR,
 * file, copy), collect their approvals (scan, file, paste) with a weight
 * bar, submit through the ordinary smart-account confirm with this
 * wallet's account as the submitter, and the mirror: approve someone else's
 * request as a co-signer. The honesty lines (../wallet/multisig.ts) are on
 * every phase. Test networks only (readiness row 'multisig').
 *
 * Keys: none is read until the final step of a submit or a co-signer
 * approval, and then only inside signWith, after the device check
 * (submitMultisigWithGate / cosignWithGate).
 */
export function MultisigScreen() {
  const theme = useTheme();
  const navigation = useNavigation();
  const { accounts, activeAccount, accountList, signWith } = useWallet();
  const { evmChain } = usePrefs();
  const chain = evmChain.caip2;
  const nativeSymbol = evmChain.displaySymbol;
  const evm = accounts.find((a) => a.chainId === EVM_CHAIN_ID) ?? null;
  const activeAddress = evm?.address ?? null;
  const phraseSigner = activeAccount && !activeAccount.imported && !activeAccount.watchOnly ? activeAddress : null;
  const readiness = readinessGate('multisig', chain);

  const ownAccounts = useMemo<OwnAccount[]>(
    () =>
      accountList
        .filter((a) => a.evmAddress)
        .map((a) => ({ name: a.name, address: a.evmAddress!, kind: a.imported ? ('imported' as const) : ('phrase' as const) })),
    [accountList],
  );

  const [phase, setPhase] = useState<Phase>('list');
  const [records, setRecords] = useState<MultisigRecord[]>([]);
  const [balances, setBalances] = useState<Record<string, bigint | null>>({});
  const [nodeUrl, setNodeUrl] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [tokens, setTokens] = useState<(KnownToken & { assetId: string })[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Create form.
  const [localWeight, setLocalWeight] = useState('1');
  const [cosigners, setCosigners] = useState<MultisigCosignerDraft[]>([{ address: '', weight: '1' }]);
  const [threshold, setThreshold] = useState('2');
  const [nameInput, setNameInput] = useState('');
  const [reviewed, setReviewed] = useState<(MultisigConfigCheck & { ok: true }) | null>(null);

  // Detail / operations.
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [chainNote, setChainNote] = useState<string | null>(null);
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [asset, setAsset] = useState<string>(NATIVE);
  const [op, setOp] = useState<MultisigOperationRecord | null>(null);
  const [approvalInput, setApprovalInput] = useState('');
  const [submission, setSubmission] = useState<{ bundle: AaClientBundle; quote: AaSendQuote } | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);

  // Import and co-sign.
  const [importInput, setImportInput] = useState('');
  const [importParsed, setImportParsed] = useState<ReturnType<typeof parseMultisigAccountImport> | null>(null);
  const [cosignInput, setCosignInput] = useState('');
  const [cosignReview, setCosignReview] = useState<MultisigCosignReview | null>(null);
  const [cosignPayload, setCosignPayload] = useState<string | null>(null);

  const selected = records.find((r) => r.id === selectedId) ?? null;
  const node = useMemo<JsonRpcTransport | null>(() => (nodeUrl ? httpTransport(nodeUrl) : null), [nodeUrl]);

  useEffect(() => {
    navigation.setOptions({ title: MULTISIG_TITLE });
  }, [navigation]);

  useEffect(() => {
    getEndpoint(EVM_CHAIN_ID).then(
      (endpoint) => {
        if (!endpoint?.url) setSetupError('No RPC endpoint is configured for this network.');
        else {
          setSetupError(null);
          setNodeUrl(endpoint.url);
        }
      },
      (e: unknown) => setSetupError(e instanceof Error ? e.message : String(e)),
    );
    listTokens(chain).then(
      (list) =>
        setTokens(
          list.flatMap((t) =>
            t.assetId.namespace === 'erc20'
              ? [{ assetId: `erc20:${t.assetId.reference}`, contract: t.assetId.reference, symbol: t.symbol, decimals: t.decimals }]
              : [],
          ),
        ),
      () => setTokens([]),
    );
  }, [chain]);

  const reload = useCallback(async () => {
    const list = await listMultisigRecords(chain);
    setRecords(list);
    if (node) {
      const client = new NodeClient(node);
      const entries = await Promise.all(
        list.map(async (r) => [r.address, await client.getBalance(r.address).catch(() => null)] as const),
      );
      setBalances(Object.fromEntries(entries));
    }
    return list;
  }, [chain, node]);

  useFocusEffect(
    useCallback(() => {
      reload().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    }, [reload, setError]),
  );

  const symbolFor = (assetKey: string) => (assetKey === NATIVE ? nativeSymbol : tokens.find((t) => t.assetId === assetKey)?.symbol ?? '');
  const readinessCard = readiness ? (
    <TestNetworksOnlyCard feature={readiness.feature} hint={readiness.hint} style={styles.card} titleStyle={styles.ok} bodyStyle={styles.hint} hintStyle={styles.hint} />
  ) : null;
  const badge = <RecoveryNetworkBadge label={evmChain.label} testnet={evmChain.testnet} />;
  const errorBox = error ? <WarningBox>{error}</WarningBox> : null;

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  const openDetail = (record: MultisigRecord) => {
    setSelectedId(record.id);
    setError(null);
    setChainNote(null);
    setOp(record.operations.find((o) => o.status === 'collecting') ?? null);
    setPhase('detail');
    if (node) {
      readMultisigOnChain(node, record).then(
        (state) =>
          setChainNote(
            state.deployed
              ? state.problems.length > 0
                ? `On-chain check: ${state.problems.join(' ')}`
                : 'Deployed; its signer set and threshold on-chain match this record.'
              : MULTISIG_DEPLOY_NOTE,
          ),
        (e: unknown) => setChainNote(`Could not read the account on-chain: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
  };

  // ---------------------------------------------------------------------
  // Create
  // ---------------------------------------------------------------------
  const onReviewCreate = () => {
    setError(null);
    if (!phraseSigner) {
      setError(MULTISIG_PHRASE_SIGNER_ONLY);
      return;
    }
    const check = buildMultisigConfig({ localSigner: phraseSigner, localWeight, cosigners, threshold }, ownAccounts);
    if (!check.ok) {
      setError(check.error);
      return;
    }
    setReviewed(check);
    setPhase('create-review');
  };

  const onCreate = async () => {
    if (!reviewed || !phraseSigner || !node) return;
    setBusy(true);
    setError(null);
    try {
      const problems = await checkMultisigNetwork(node, chain);
      if (problems.length > 0) throw new Error(problems.join(' '));
      const record = await createMultisigRecord({ chain, config: reviewed.config, localSigner: phraseSigner, name: nameInput });
      await reload();
      setReviewed(null);
      setCosigners([{ address: '', weight: '1' }]);
      setNameInput('');
      openDetail(record);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  // ---------------------------------------------------------------------
  // Operations (submitting side)
  // ---------------------------------------------------------------------
  const onBuildRequest = async () => {
    if (!selected || !node) return;
    setError(null);
    const to = validateRecipient(EVM_CHAIN_ID, recipient);
    if (!to.ok) {
      setError(to.error);
      return;
    }
    let calls;
    try {
      if (asset === NATIVE) {
        calls = [{ to: to.normalized, value: parseUnits(amount, 18), data: new Uint8Array(0) }];
      } else {
        const token = tokens.find((t) => t.assetId === asset);
        if (!token) throw new Error('Choose a token tracked on this network.');
        calls = aaErc20TransferCalls(token.contract, to.normalized, parseUnits(amount, token.decimals));
      }
    } catch (e) {
      fail(e);
      return;
    }
    setBusy(true);
    try {
      const built = await prepareMultisigRequest({ record: selected, calls, node, nativeSymbol, tokens });
      await reload();
      setOp(built);
      setApprovalInput('');
      setPhase('collect');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const onAddApproval = async (text: string) => {
    if (!selected || !op) return;
    setError(null);
    try {
      const { op: next } = addMultisigApproval(selected, op, text);
      await saveMultisigOperation(selected.id, next);
      setOp(next);
      setApprovalInput('');
      await reload();
    } catch (e) {
      fail(e);
    }
  };

  const onPickApprovalFile = async () => {
    try {
      const picked = await pickRecordFile();
      if (!picked) return;
      await onAddApproval(multisigFileText(picked.text, picked));
    } catch (e) {
      fail(e);
    }
  };

  const onQuote = async () => {
    if (!selected || !op || !nodeUrl) return;
    setError(null);
    setBusy(true);
    try {
      const config = await getAaConfig(chain);
      if (!config.bundlerUrl) throw new Error('No bundler is configured for this network (Settings → Account Abstraction).');
      setSubmission(await prepareMultisigSubmission({ record: selected, op, nodeUrl, bundlerUrl: config.bundlerUrl }));
      setPhase('confirm');
    } catch (e) {
      const described = describeAaError(e, { accountType: 'kernel-multisig', deployed: !op.deploys, sender: selected.address });
      setError(described ? `${described.title}\n\n${described.detail}${op.deploys ? `\n\n${MULTISIG_FUND_AND_RETRY}` : ''}` : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = async () => {
    if (!selected || !op || !submission) return;
    setError(null);
    setPhase('sending');
    try {
      const { userOpHash } = await submitMultisigWithGate({
        record: selected,
        op,
        bundle: submission.bundle,
        quote: submission.quote,
        requireAuth: requireLocalAuth,
        signWith,
      });
      setProgress({ userOpHash, state: 'pending', success: null, txHash: null });
      setPhase('progress');
      await reload();
      const recordId = selected.id;
      const requestId = op.requestId;
      waitForAaReceipt(submission.bundle, userOpHash, { timeoutMs: 120_000, pollMs: 3_000 }).then(
        async ({ summary }) => {
          await recordMultisigOutcome(recordId, requestId, summary).catch(() => undefined);
          setProgress((p) => (p && p.userOpHash === userOpHash ? { ...p, state: 'done', success: summary.success, txHash: summary.txHash } : p));
          await reload().catch(() => undefined);
        },
        () => setProgress((p) => (p && p.userOpHash === userOpHash ? { ...p, state: 'timeout' } : p)),
      );
    } catch (e) {
      setSubmission(null);
      if (e instanceof MultisigAuthCancelledError) {
        Alert.alert('Not sent', e.message);
        setPhase('collect');
        return;
      }
      const described = describeAaError(e, { accountType: 'kernel-multisig', deployed: !op.deploys, sender: selected.address });
      setError(described ? `${described.title}\n\n${described.detail}${op.deploys ? `\n\n${MULTISIG_FUND_AND_RETRY}` : ''}` : String(e));
      setPhase('collect');
    }
  };

  // ---------------------------------------------------------------------
  // Import and co-sign
  // ---------------------------------------------------------------------
  const onReviewImport = (text: string) => {
    setError(null);
    try {
      setImportParsed(parseMultisigAccountImport(text));
      setPhase('import-review');
    } catch (e) {
      fail(e);
    }
  };

  const onImport = async () => {
    if (!importParsed || !node) return;
    setBusy(true);
    setError(null);
    try {
      if (importParsed.chain !== chain) {
        throw new Error(`This record is for chain id ${importParsed.facts.chainId}; switch to that network first (Settings → Developer).`);
      }
      const problems = await checkMultisigNetwork(node, chain);
      if (problems.length > 0) throw new Error(problems.join(' '));
      const record = await importMultisigRecord(importParsed, ownAccounts);
      await reload();
      setImportInput('');
      setImportParsed(null);
      openDetail(record);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const onReviewCosign = (text: string) => {
    setError(null);
    try {
      setCosignReview(
        reviewMultisigRequestAsCosigner(text, { activeChain: chain, activeAddress: phraseSigner, ownAccounts, records, nativeSymbol, tokens }),
      );
      setPhase('cosign-review');
    } catch (e) {
      fail(e);
    }
  };

  const onCosign = async () => {
    if (!cosignReview) return;
    setError(null);
    setBusy(true);
    try {
      const { payload } = await cosignWithGate({ review: cosignReview, requireAuth: requireLocalAuth, signWith });
      setCosignPayload(payload);
      setPhase('cosign-done');
    } catch (e) {
      if (e instanceof MultisigAuthCancelledError) Alert.alert('Not approved', e.message);
      else fail(e);
    } finally {
      setBusy(false);
    }
  };

  const pickInto = async (onText: (text: string) => void) => {
    try {
      const picked = await pickRecordFile();
      if (picked) onText(multisigFileText(picked.text, picked));
    } catch (e) {
      fail(e);
    }
  };

  const back = (to: Phase) => (
    <Button
      title="Back"
      variant="secondary"
      onPress={() => {
        setError(null);
        setPhase(to);
      }}
    />
  );

  const shell = (children: React.ReactNode, config: ReturnType<typeof multisigConfigOf> | null = null) => (
    <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {badge}
      {readinessCard}
      {setupError ? <WarningBox>{setupError}</WarningBox> : null}
      {children}
      {errorBox}
      <MultisigHonesty config={config} />
    </ScrollView>
  );

  // ---------------------------------------------------------------------
  // Phases
  // ---------------------------------------------------------------------
  if (phase === 'create') {
    return shell(
      <>
        <Text style={[styles.title, { color: theme.text }]}>New multi-signature account</Text>
        <Text style={[styles.hint, { color: theme.text }]}>{MULTISIG_FRESH_DEPLOY_NOTE}</Text>
        {phraseSigner ? (
          <InfoRow label="This wallet’s signer (the active account)" value={phraseSigner} sub={activeAccount?.name ?? null} monoValue />
        ) : (
          <WarningBox>{MULTISIG_PHRASE_SIGNER_ONLY}</WarningBox>
        )}
        <Text style={[styles.hint, { color: theme.textMuted }]}>Weight of this wallet’s signer</Text>
        <TextInput
          value={localWeight}
          onChangeText={setLocalWeight}
          keyboardType="number-pad"
          accessibilityLabel="Weight of this wallet’s signer"
          style={[styles.input, { color: theme.text, borderColor: theme.border }]}
        />
        {cosigners.map((c, i) => (
          <View key={i} style={[styles.card, { borderColor: theme.border }]}>
            <Text style={[styles.cardTitle, { color: theme.text }]}>Co-signer {i + 1}</Text>
            <PasteOrScan
              value={c.address}
              onChange={(text) => setCosigners((prev) => prev.map((x, j) => (j === i ? { ...x, address: text.replace(/^ethereum:/i, '').split(/[@?]/)[0]!.trim() } : x)))}
              placeholder={`Co-signer ${i + 1}: Ethereum address`}
              rationale="Scan the co-signer’s Ethereum address QR code."
            />
            <TextInput
              value={c.weight}
              onChangeText={(text) => setCosigners((prev) => prev.map((x, j) => (j === i ? { ...x, weight: text } : x)))}
              keyboardType="number-pad"
              accessibilityLabel={`Co-signer ${i + 1}: weight`}
              placeholder="Weight"
              placeholderTextColor={theme.textMuted}
              style={[styles.input, { color: theme.text, borderColor: theme.border }]}
            />
            {cosigners.length > 1 ? (
              <Button title={`Remove co-signer ${i + 1}`} variant="secondary" onPress={() => setCosigners((prev) => prev.filter((_, j) => j !== i))} />
            ) : null}
          </View>
        ))}
        {cosigners.length < MAX_MULTISIG_COSIGNERS ? (
          <Button title="Add a co-signer" variant="secondary" onPress={() => setCosigners((prev) => [...prev, { address: '', weight: '1' }])} />
        ) : null}
        <Text style={[styles.hint, { color: theme.textMuted }]}>Threshold: the combined weight every operation needs (at least two signers).</Text>
        <TextInput
          value={threshold}
          onChangeText={setThreshold}
          keyboardType="number-pad"
          accessibilityLabel="Threshold"
          style={[styles.input, { color: theme.text, borderColor: theme.border }]}
        />
        <TextInput
          value={nameInput}
          onChangeText={setNameInput}
          accessibilityLabel="Name (optional)"
          placeholder="Name (optional)"
          placeholderTextColor={theme.textMuted}
          style={[styles.input, { color: theme.text, borderColor: theme.border }]}
        />
        <Button title="Review" onPress={onReviewCreate} disabled={readiness !== null || !phraseSigner} />
        {back('list')}
      </>,
    );
  }

  if (phase === 'create-review' && reviewed) {
    let preview: { address: string; index: bigint } | null = null;
    let previewError: string | null = null;
    try {
      const index = chooseMultisigIndex(reviewed.config, chain, records);
      preview = { address: multisigAddressFor(reviewed.config, index), index };
    } catch (e) {
      previewError = e instanceof Error ? e.message : String(e);
    }
    return shell(
      <>
        <Text style={[styles.title, { color: theme.text }]}>Review the new multisig ({multisigShapeLabel(reviewed.config)})</Text>
        <Text style={[styles.hint, { color: theme.text }]}>{MULTISIG_FRESH_DEPLOY_NOTE}</Text>
        {preview ? (
          <InfoRow
            label="Account address (not deployed yet)"
            value={preview.address}
            sub={`CREATE2 index ${preview.index.toString()}: the address follows from the signer set, the threshold and this index (index 0 unless this phone already holds the same set here).`}
            monoValue
          />
        ) : null}
        {previewError ? <WarningBox>{previewError}</WarningBox> : null}
        {reviewed.config.signers.map((s) => (
          <InfoRow
            key={s.address}
            label={s.address.toLowerCase() === phraseSigner?.toLowerCase() ? 'This wallet’s signer' : 'Co-signer'}
            value={s.address}
            sub={`weight ${s.weight}`}
            monoValue
          />
        ))}
        <InfoRow label="Threshold" value={String(reviewed.config.threshold)} />
        {reviewed.warnings.map((w) => (
          <WarningBox key={w}>{w}</WarningBox>
        ))}
        <Text style={[styles.hint, { color: theme.textMuted }]}>{MULTISIG_DEPLOY_NOTE}</Text>
        {busy ? <ActivityIndicator color={theme.accent} /> : <Button title="Create this multisig" onPress={() => void onCreate()} disabled={readiness !== null || !preview || !node} />}
        {back('create')}
      </>,
      reviewed.config,
    );
  }

  if (phase === 'detail' && selected) {
    const config = multisigConfigOf(selected);
    const exported = exportMultisigAccount(selected);
    const balance = balances[selected.address];
    const finished = selected.operations.filter((o) => o.status !== 'collecting');
    return shell(
      <>
        <Text style={[styles.title, { color: theme.text }]}>{multisigDisplayName(selected)}</Text>
        <InfoRow label="Multisig address (receive here)" value={selected.address} monoValue />
        <PayloadQr value={selected.address} caption="The multisig account’s address. Anyone can send to it; moving funds out needs the co-signers." />
        <ShareActions text={selected.address} shareTitle="Multisig address" />
        <InfoRow label="Balance" value={balance === undefined ? 'Loading…' : balance === null ? 'Could not be read' : `${formatBalanceDisplay(balance, 18)} ${nativeSymbol}`} />
        <Text style={[styles.hint, { color: theme.text }]}>{chainNote ?? 'Checking the account on-chain…'}</Text>
        {selected.signers.map((s) => (
          <InfoRow
            key={s.address}
            label={s.address.toLowerCase() === selected.localSigner.toLowerCase() ? 'This wallet’s signer' : 'Co-signer'}
            value={s.address}
            sub={`weight ${s.weight}`}
            monoValue
          />
        ))}
        <InfoRow label="Threshold" value={`${selected.threshold} (${multisigShapeLabel(selected)})`} sub={`CREATE2 index ${selected.index}`} />
        {selected.localSigner.toLowerCase() !== (phraseSigner ?? '').toLowerCase() ? (
          <WarningBox>
            This wallet’s signer for this multisig is {selected.localSigner}. Switch to that account on Home to build or submit
            operations.
          </WarningBox>
        ) : null}
        {op ? (
          <Button title="Continue the operation being approved" onPress={() => setPhase('collect')} />
        ) : null}
        <Button
          title="New operation (send)"
          onPress={() => {
            setRecipient('');
            setAmount('');
            setAsset(NATIVE);
            setError(null);
            setPhase('send-form');
          }}
          disabled={readiness !== null || selected.localSigner.toLowerCase() !== (phraseSigner ?? '').toLowerCase()}
        />
        <Text style={[styles.sectionTitle, { color: theme.text }]}>Share the account with the co-signers</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          A co-signer adds the same account on their phone from this record (it contains no secrets).
        </Text>
        <PayloadQr value={exported.qrValue} caption="Multisig account record" />
        <ShareActions text={exported.shareText} shareTitle="Multisig account record" />
        <MultisigFileExportButton text={exported.json} fileName={multisigExportFileName('account', selected.chain, selected.address)} dialogTitle="Save the multisig record" />
        {finished.length > 0 ? (
          <View style={[styles.card, { borderColor: theme.border }]}>
            <Text style={[styles.cardTitle, { color: theme.text }]}>History</Text>
            {finished.map((o) => (
              <Text key={o.requestId} selectable style={[styles.hint, { color: theme.textMuted }]}>
                {o.status} · nonce {o.nonce} · request {o.requestId.slice(0, 10)}… · approvals{' '}
                {o.approvalIds.map((a) => `${a.signer.slice(0, 6)}… (${a.approvalId.slice(0, 10)}…)`).join(', ') || 'none'}
                {o.userOpHash ? ` · userOp ${o.userOpHash}` : ''}
                {o.txHash ? ` · tx ${o.txHash}` : ''}
                {`\n${o.summary}`}
              </Text>
            ))}
          </View>
        ) : null}
        <MultisigRefusedFeatures />
        <Button
          title="Remove from this wallet"
          variant="secondary"
          onPress={() =>
            Alert.alert(REMOVE_MULTISIG_TITLE, removeMultisigMessage(selected), [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Remove',
                style: 'destructive',
                onPress: () => {
                  removeMultisigRecord(selected.id).then(
                    () => {
                      setSelectedId(null);
                      setPhase('list');
                      void reload();
                    },
                    fail,
                  );
                },
              },
            ])
          }
        />
        {back('list')}
      </>,
      config,
    );
  }

  if (phase === 'send-form' && selected) {
    return shell(
      <>
        <Text style={[styles.title, { color: theme.text }]}>New operation from {multisigDisplayName(selected)}</Text>
        <Text style={[styles.hint, { color: theme.text }]}>
          This builds a signing request for the co-signers; nothing is signed or sent until enough of them approve and you
          submit.{selected.deployed.deployed ? '' : ` ${MULTISIG_DEPLOY_NOTE}`}
        </Text>
        <View style={styles.toggleRow}>
          {[NATIVE, ...tokens.map((t) => t.assetId)].map((key) => (
            <Button key={key} title={symbolFor(key)} variant="secondary" selected={asset === key} onPress={() => setAsset(key)} />
          ))}
        </View>
        <TextInput
          value={recipient}
          onChangeText={setRecipient}
          accessibilityLabel="Recipient address"
          placeholder="Recipient (0x…)"
          placeholderTextColor={theme.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.input, { color: theme.text, borderColor: theme.border }]}
        />
        <TextInput
          value={amount}
          onChangeText={setAmount}
          accessibilityLabel={`Amount in ${symbolFor(asset)}`}
          placeholder={`Amount (${symbolFor(asset)})`}
          placeholderTextColor={theme.textMuted}
          keyboardType="decimal-pad"
          style={[styles.input, { color: theme.text, borderColor: theme.border }]}
        />
        {busy ? <ActivityIndicator color={theme.accent} /> : <Button title="Build the signing request" onPress={() => void onBuildRequest()} disabled={readiness !== null || !node} />}
        {back('detail')}
      </>,
      multisigConfigOf(selected),
    );
  }

  if (phase === 'collect' && selected && op) {
    const p = multisigWeightProgress(selected, op);
    const payload = encodeMultisigRequestPayload(selected, op);
    return shell(
      <>
        <Text style={[styles.title, { color: theme.text }]}>Collect approvals · {multisigDisplayName(selected)}</Text>
        <InfoRow label="Request id (call data and nonce)" value={op.requestId} monoValue />
        <InfoRow label="Nonce" value={op.nonce} />
        <MultisigCallsView
          calls={multisigOperationCalls(op)}
          described={multisigOperationCalls(op).map((c) => describeMultisigCall(c, nativeSymbol, tokens))}
          nativeSymbol={nativeSymbol}
        />
        {op.deploys ? <Text style={[styles.hint, { color: theme.textMuted }]}>{MULTISIG_DEPLOY_NOTE}</Text> : null}
        <WeightProgress weight={p.weight} threshold={p.threshold} />
        <Text style={[styles.hint, { color: theme.text }]}>✓ This wallet’s signer {selected.localSigner} (weight {p.localWeight}, signs last when you submit)</Text>
        {p.approvers.map((a) => (
          <Text key={a.address} style={[styles.hint, { color: theme.text }]}>
            ✓ {a.address} (weight {a.weight})
          </Text>
        ))}
        <Text style={[styles.sectionTitle, { color: theme.text }]}>1. Send this request to the co-signers</Text>
        <PayloadQr value={multisigQrValue(payload)} caption="Multisig signing request" />
        <ShareActions text={multisigRequestShareText(selected, op)} shareTitle="Multisig signing request" />
        <MultisigFileExportButton text={payload} fileName={multisigExportFileName('request', selected.chain, selected.address)} dialogTitle="Save the signing request" />
        <Text style={[styles.sectionTitle, { color: theme.text }]}>2. Add each approval you receive</Text>
        <PasteOrScan
          value={approvalInput}
          onChange={setApprovalInput}
          placeholder="Paste a co-signer’s approval (or a 65-byte signature from another wallet)"
          rationale="Scan the approval QR code a co-signer shows you."
        />
        <Button title="Add approval" variant="secondary" disabled={!approvalInput.trim()} onPress={() => void onAddApproval(approvalInput)} />
        <Button title="Add an approval from a file" variant="secondary" onPress={() => void onPickApprovalFile()} />
        <Text style={[styles.sectionTitle, { color: theme.text }]}>3. Submit</Text>
        {busy ? (
          <ActivityIndicator color={theme.accent} />
        ) : (
          <Button title="Review and submit" onPress={() => void onQuote()} disabled={!p.ready || readiness !== null || !nodeUrl} />
        )}
        {!p.ready ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            Submitting needs weight {p.threshold}; this wallet’s signer and the approvals so far reach {p.weight}.
          </Text>
        ) : null}
        {back('detail')}
      </>,
      multisigConfigOf(selected),
    );
  }

  if ((phase === 'confirm' || phase === 'sending') && selected && op && submission) {
    const q = submission.quote;
    return shell(
      <>
        <Text style={[styles.title, { color: theme.text }]}>Submit the multisig operation</Text>
        <InfoRow label="From multi-signature account (co-signers approved)" value={q.sender} monoValue />
        <MultisigCallsView calls={q.calls} described={q.calls.map((c) => describeMultisigCall(c, nativeSymbol, tokens))} nativeSymbol={nativeSymbol} />
        <InfoRow
          label="Network fee (worst case, set by you as the submitter)"
          value={`${formatUnits(q.fee, 18, 18)} ${nativeSymbol}`}
          sub={q.deposit !== undefined && q.deposit > 0n ? `The account’s EntryPoint deposit of ${formatUnits(q.deposit, 18, 18)} ${nativeSymbol} pays first.` : 'Paid from the multisig’s own balance.'}
        />
        <InfoRow label="Total (worst case)" value={`${formatUnits(q.total, 18, 18)} ${nativeSymbol}`} />
        {!q.deployed ? <WarningBox>This operation also deploys the multisig account (its first operation).</WarningBox> : null}
        <Text style={[styles.hint, { color: theme.text }]}>
          Approvals: weight {multisigWeightProgress(selected, op).weight} of the threshold {selected.threshold}. Your device check
          comes next; this wallet’s signer then signs the final operation, and the signer module checks every approval again.
        </Text>
        {phase === 'sending' ? (
          <ActivityIndicator color={theme.accent} />
        ) : (
          <>
            <Button title="Approve and submit" onPress={() => void onSubmit()} disabled={readiness !== null} />
            <Button
              title="Back"
              variant="secondary"
              onPress={() => {
                setSubmission(null);
                setPhase('collect');
              }}
            />
          </>
        )}
      </>,
      multisigConfigOf(selected),
    );
  }

  if (phase === 'progress' && selected && progress) {
    return shell(
      <>
        <Text style={[styles.title, { color: theme.text }]}>
          {progress.state === 'pending'
            ? 'Submitted — waiting for inclusion…'
            : progress.state === 'timeout'
              ? 'Not included yet'
              : progress.success === false
                ? 'Included, but the operation failed'
                : 'Done'}
        </Text>
        <InfoRow label="UserOperation hash" value={progress.userOpHash} monoValue />
        {progress.txHash ? <InfoRow label="Transaction" value={progress.txHash} monoValue /> : null}
        {progress.state === 'pending' ? <ActivityIndicator color={theme.accent} /> : null}
        {progress.state === 'timeout' ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            The bundler has not reported it within two minutes. It may still be included; the UserOperation hash is the
            lookup key.
          </Text>
        ) : null}
        <Button
          title="Back to the multisig"
          onPress={() => {
            setOp(null);
            setSubmission(null);
            setProgress(null);
            setPhase('detail');
            void reload();
          }}
        />
      </>,
      multisigConfigOf(selected),
    );
  }

  if (phase === 'import') {
    return shell(
      <>
        <Text style={[styles.title, { color: theme.text }]}>Add a multisig from its record</Text>
        <Text style={[styles.hint, { color: theme.text }]}>
          Paste or scan the account record another signer shared, or open its file. The wallet checks that the address
          follows from the signer set and that one of your recovery-phrase accounts is a signer.
        </Text>
        <PasteOrScan value={importInput} onChange={setImportInput} placeholder="Paste the multisig record" rationale="Scan the multisig record QR code." />
        <Button title="Check the record" disabled={!importInput.trim()} onPress={() => onReviewImport(importInput)} />
        <Button title="Open a record file" variant="secondary" onPress={() => void pickInto(onReviewImport)} />
        {back('list')}
      </>,
    );
  }

  if (phase === 'import-review' && importParsed) {
    return shell(
      <>
        <Text style={[styles.title, { color: theme.text }]}>Add this multisig ({multisigShapeLabel(importParsed.config)})?</Text>
        <InfoRow label="Account" value={importParsed.facts.account} sub={`Chain id ${importParsed.facts.chainId} · CREATE2 index ${importParsed.facts.index}`} monoValue />
        {importParsed.config.signers.map((s) => {
          const own = ownAccounts.find((a) => a.address.toLowerCase() === s.address.toLowerCase());
          return <InfoRow key={s.address} label={own ? `Signer: ${own.name} (this wallet)` : 'Signer'} value={s.address} sub={`weight ${s.weight}`} monoValue />;
        })}
        <InfoRow label="Threshold" value={String(importParsed.config.threshold)} />
        {busy ? <ActivityIndicator color={theme.accent} /> : <Button title="Add to this wallet" onPress={() => void onImport()} disabled={readiness !== null || !node} />}
        {back('import')}
      </>,
      importParsed.config,
    );
  }

  if (phase === 'cosign-input') {
    return shell(
      <>
        <Text style={[styles.title, { color: theme.text }]}>Approve a request (as a co-signer)</Text>
        <Text style={[styles.hint, { color: theme.text }]}>
          Paste or scan the signing request the submitter shared, or open its file. You will see the account, the network,
          the nonce and every call in full before anything is signed.
        </Text>
        <PasteOrScan value={cosignInput} onChange={setCosignInput} placeholder="Paste the multisig signing request" rationale="Scan the signing request QR code." />
        <Button title="Review the request" disabled={!cosignInput.trim()} onPress={() => onReviewCosign(cosignInput)} />
        <Button title="Open a request file" variant="secondary" onPress={() => void pickInto(onReviewCosign)} />
        {back('list')}
      </>,
    );
  }

  if (phase === 'cosign-review' && cosignReview) {
    const r = cosignReview;
    return shell(
      <>
        <Text style={[styles.title, { color: theme.text }]}>Review before you approve</Text>
        <InfoRow
          label="Multisig account"
          value={r.request.account}
          sub={r.knownRecord ? multisigDisplayName(r.knownRecord) : `${multisigShapeLabel(r.config)}, not in this wallet`}
          monoValue
        />
        <InfoRow label="Network" value={`${r.networkLabel} (chain id ${r.request.chainId})`} />
        <InfoRow label="Nonce" value={r.request.nonce} />
        <InfoRow label="Request id (call data and nonce)" value={r.request.callDataAndNonceHash} monoValue />
        <InfoRow label="You approve as" value={r.signer.address} sub={`weight ${r.signer.weight} of the threshold ${r.config.threshold}`} monoValue />
        <MultisigCallsView calls={r.calls} described={r.described} nativeSymbol={nativeSymbol} />
        {r.warnings.map((w) => (
          <WarningBox key={w}>{w}</WarningBox>
        ))}
        {busy ? (
          <ActivityIndicator color={theme.accent} />
        ) : (
          <Button title="Approve as co-signer" onPress={() => void onCosign()} disabled={readiness !== null} />
        )}
        {back('cosign-input')}
      </>,
      r.config,
    );
  }

  if (phase === 'cosign-done' && cosignReview && cosignPayload) {
    return shell(
      <>
        <Text style={[styles.title, { color: theme.text }]}>Approval ready — give it to the submitter</Text>
        <Text style={[styles.hint, { color: theme.text }]}>
          Show the QR code to the submitter, or share the text or file. It approves only this request (these calls at nonce{' '}
          {cosignReview.request.nonce}); it is useless for anything else.
        </Text>
        <PayloadQr value={multisigQrValue(cosignPayload)} caption="Multisig approval" />
        <ShareActions text={cosignPayload} shareTitle="Multisig approval" />
        <MultisigFileExportButton
          text={cosignPayload}
          fileName={multisigExportFileName('approval', cosignReview.chain, cosignReview.request.account)}
          dialogTitle="Save the approval"
        />
        <Button
          title="Done"
          onPress={() => {
            setCosignInput('');
            setCosignReview(null);
            setCosignPayload(null);
            setPhase('list');
          }}
        />
      </>,
      cosignReview.config,
    );
  }

  // 'list' (and any phase whose data is gone).
  return shell(
    <>
      <Text style={[styles.title, { color: theme.text }]}>{MULTISIG_TITLE}</Text>
      <Text style={[styles.hint, { color: theme.text }]}>
        An account that needs several signers for every operation: this wallet’s account plus co-signers on other phones,
        each with a weight, and a threshold. {MULTISIG_FRESH_DEPLOY_NOTE}
      </Text>
      {records.length === 0 ? (
        <Text style={[styles.hint, { color: theme.textMuted }]}>No multi-signature account on {evmChain.label} yet.</Text>
      ) : (
        records.map((r) => {
          const b = balances[r.address];
          return (
            <View key={r.id} style={[styles.card, { borderColor: theme.border, backgroundColor: theme.card }]}>
              <Text style={[styles.cardTitle, { color: theme.text }]}>{multisigDisplayName(r)}</Text>
              <Text selectable style={[styles.mono, { color: theme.textMuted }]}>
                {r.address}
              </Text>
              <Text style={[styles.hint, { color: theme.text }]}>
                {b === undefined || b === null ? 'Balance unknown' : `${formatBalanceDisplay(b, 18)} ${nativeSymbol}`} ·{' '}
                {r.deployed.deployed ? 'deployed' : 'not deployed yet'}
                {r.operations.some((o) => o.status === 'collecting') ? ' · an operation is collecting approvals' : ''}
              </Text>
              <Text style={[styles.hint, { color: theme.textMuted }]}>{multisigExposureLine(multisigConfigOf(r))}</Text>
              <Button title={`Open ${r.name}`} variant="secondary" onPress={() => openDetail(r)} />
            </View>
          );
        })
      )}
      <Button
        title="Create a multisig"
        onPress={() => {
          setError(null);
          setPhase('create');
        }}
        disabled={readiness !== null}
      />
      <Button
        title="Add a multisig from a record"
        variant="secondary"
        onPress={() => {
          setError(null);
          setPhase('import');
        }}
        disabled={readiness !== null}
      />
      <Button
        title="Approve a request (as a co-signer)"
        variant="secondary"
        onPress={() => {
          setError(null);
          setPhase('cosign-input');
        }}
        disabled={readiness !== null}
      />
      <MultisigRefusedFeatures />
    </>,
  );
}
