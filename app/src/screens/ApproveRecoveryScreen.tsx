import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Linking, ScrollView, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { BundlerClient, ENTRYPOINT_V07, httpTransport, toHex, type JsonRpcTransport } from '@shiba-wallet/chains-evm';
import type { RootStackParamList } from '../navigation';
import { Button, TestNetworksOnlyCard, WarningBox, screenStyle } from '../components';
import { RecipientContactNotice } from '../components/Contacts';
import {
  GuardianSetView,
  InfoRow,
  PasteOrScan,
  PayloadQr,
  RecoveryNetworkBadge,
  ShareActions,
  recoveryLayout as styles,
} from '../components/RecoveryViews';
import { useTheme } from '../theme';
import { readinessGate } from '../config/readiness';
import { getEndpoint } from '../config/networks';
import { useWallet } from '../wallet/WalletContext';
import { usePrefs } from '../wallet/PrefsContext';
import { requireLocalAuth } from '../wallet/biometric';
import { formatUnits } from '../wallet/balances';
import { EVM_CHAIN_ID, describeSendError } from '../wallet/send';
import { checkAaQuoteBeforeApproval, describeAaError, getAaConfig, summarizeAaReceipt, type AaReceiptSummary } from '../wallet/aa';
import { listContacts, matchRecipient, type Contact } from '../wallet/contacts';
import {
  APPROVER_WARNING,
  GUARDIAN_SUBMITS_NOTE,
  addApprovalToProgress,
  encodeRecoveryRequestPayload,
  formatDuration,
  loadRecoveryProgressList,
  prepareGuardianSubmission,
  proposalStatusText,
  reviewRecoveryRequest,
  saveRecoveryProgress,
  signRecoveryApproval,
  submitGuardianRecovery,
  type GuardianRequestReview,
  type GuardianSubmissionQuote,
  type RecoveryProgress,
} from '../wallet/recovery';

type Props = NativeStackScreenProps<RootStackParamList, 'ApproveRecovery'>;

type Phase = 'input' | 'reviewing' | 'review' | 'signed' | 'submit-confirm' | 'sending' | 'submitted';

/**
 * "Approve a recovery" — the guardian side (phase 8 item 4). The ACTIVE
 * account acts as the guardian. A request is pasted or scanned (or picked
 * from a recovery in progress on this device), re-derived by the engine and
 * checked against the chain (recovery.ts reviewRecoveryRequest); the screen
 * shows the account, the proposed new owner and the proposal id in full,
 * with the plain warning that approving hands control of the account to the
 * new owner. Signing happens only on an explicit tap, after a confirmation
 * and the biometric gate, through signWith (expectAddress = the guardian's
 * EOA); the approval leaves as a QR code / text. Nothing here is ever
 * triggered by WalletConnect (walletconnect.ts refuses guardian requests).
 * A guardian can also SUBMIT the final recovery operation (the contract
 * requires a guardian's signature on it): delay 0 with enough approvals, or
 * after an on-chain approval's delay; the account pays the gas.
 */
export function ApproveRecoveryScreen({ navigation }: Props) {
  const theme = useTheme();
  const { accounts, activeAccount, accountList, signWith } = useWallet();
  const { evmChain } = usePrefs();
  const evm = accounts.find((a) => a.chainId === EVM_CHAIN_ID) ?? null;
  const guardianAddress = evm?.address ?? null;
  const chainId = BigInt(evmChain.chainIdDecimal);
  const symbol = evmChain.displaySymbol;
  // Mainnet readiness (config/readiness.ts): guardian recovery is
  // test-network only, so reviewing, approving and submitting a request are
  // switched off here; recovery.ts refuses them too.
  const readiness = readinessGate('guardians', evmChain.caip2);

  const [node, setNode] = useState<JsonRpcTransport | null>(null);
  const [nodeError, setNodeError] = useState<string | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactsNetworkId, setContactsNetworkId] = useState<string | null>(null);
  const [local, setLocal] = useState<RecoveryProgress[]>([]);
  const [input, setInput] = useState('');
  const [phase, setPhase] = useState<Phase>('input');
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<GuardianRequestReview | null>(null);
  const [signed, setSigned] = useState<{ payload: string; signature: string } | null>(null);
  const [submission, setSubmission] = useState<GuardianSubmissionQuote | null>(null);
  const [submitted, setSubmitted] = useState<{ userOpHash: string; state: 'pending' | 'done' | 'timeout'; receipt: AaReceiptSummary | null } | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    navigation.setOptions({ title: 'Approve a recovery' });
  }, [navigation]);

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    getEndpoint(EVM_CHAIN_ID).then(
      (endpoint) => {
        if (!endpoint?.url) {
          setNodeError('No RPC endpoint is configured for this network.');
          return;
        }
        setNode(() => httpTransport(endpoint.url!));
        setContactsNetworkId(endpoint.network.chainId);
      },
      (e: unknown) => setNodeError(e instanceof Error ? e.message : String(e)),
    );
  }, [evmChain.caip2]);

  useEffect(() => {
    if (!contactsNetworkId) return;
    listContacts(contactsNetworkId).then(setContacts, () => setContacts([]));
  }, [contactsNetworkId]);

  const reloadLocal = useCallback(() => {
    loadRecoveryProgressList().then(
      (list) => setLocal(list.filter((p) => p.chain === evmChain.caip2 && p.request !== null)),
      () => setLocal([]),
    );
  }, [evmChain.caip2]);
  useEffect(reloadLocal, [reloadLocal]);

  /** Another account of THIS wallet that is a guardian of the reviewed account. */
  const otherGuardianAccounts = useMemo(() => {
    if (!review) return [];
    return accountList.filter(
      (a) =>
        a.evmAddress &&
        a.index !== activeAccount?.index &&
        review.set.guardians.some((g) => g.address.toLowerCase() === a.evmAddress!.toLowerCase()),
    );
  }, [review, accountList, activeAccount]);

  const localProgressFor = (r: GuardianRequestReview | null) =>
    r
      ? (local.find(
          (p) => p.request?.callDataAndNonceHash.toLowerCase() === r.request.callDataAndNonceHash.toLowerCase(),
        ) ?? null)
      : null;

  // ------------------------------------------------------------ actions

  const onReview = async (text: string) => {
    if (!node || !guardianAddress) return;
    setError(null);
    setPhase('reviewing');
    try {
      setReview(await reviewRecoveryRequest(node, { text, activeChainId: chainId, guardianAddress }));
      setPhase('review');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('input');
    }
  };

  const onApprove = () => {
    if (!review || !guardianAddress) return;
    Alert.alert(
      'Hand control of this account to the new owner?',
      `You are approving that ${review.request.newOwner} becomes the owner of ${review.request.account}. ` +
        'Only continue if the account holder asked you and you checked the new owner address with them.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Approve',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              const auth = await requireLocalAuth('Approve this recovery as a guardian');
              if (!auth.ok) {
                Alert.alert('Not approved', auth.message);
                return;
              }
              try {
                const out = await signWith(EVM_CHAIN_ID, guardianAddress, async (signer) => signRecoveryApproval(signer, review));
                setSigned({ payload: out.payload, signature: toHex(out.signature) });
                setPhase('signed');
              } catch (e) {
                Alert.alert('Not approved', e instanceof Error ? e.message : String(e));
              }
            })();
          },
        },
      ],
    );
  };

  const onAddToLocal = async () => {
    const p = localProgressFor(review);
    if (!p || !signed) return;
    try {
      const { progress, added } = addApprovalToProgress(p, signed.payload);
      if (added) await saveRecoveryProgress(progress);
      Alert.alert(added ? 'Added' : 'Already added', 'The recovery in progress on this device has this approval now.');
      reloadLocal();
    } catch (e) {
      Alert.alert('Not added', e instanceof Error ? e.message : String(e));
    }
  };

  const bundlerFor = async (): Promise<JsonRpcTransport> => {
    const config = await getAaConfig(evmChain.caip2);
    if (!config.bundlerUrl) {
      throw new Error('Submitting needs a verified bundler for this network (Settings → Account Abstraction).');
    }
    return httpTransport(config.bundlerUrl);
  };

  const onSubmitQuote = async () => {
    if (!node || !review || !guardianAddress) return;
    try {
      const bundler = await bundlerFor();
      setSubmission(
        await prepareGuardianSubmission({
          node,
          bundler,
          chainId,
          request: review.request,
          approvals: review.approvals.map((a) => a.signature),
          submitter: guardianAddress,
        }),
      );
      setPhase('submit-confirm');
    } catch (e) {
      const { title, detail } = describeSendError(e, symbol);
      Alert.alert(title, detail);
    }
  };

  const onSubmit = async () => {
    if (!node || !submission) return;
    // The bundler's fee floor, BEFORE the device check (aa.ts
    // checkAaQuoteBeforeApproval): when it rose above the reviewed fees, back
    // to the review, whose "Submit the recovery" quotes again; nothing was
    // approved.
    try {
      await checkAaQuoteBeforeApproval(await bundlerFor(), submission);
    } catch (e) {
      const { title, detail } =
        describeAaError(e, { accountType: 'kernel-v3.3', deployed: true }) ?? describeSendError(e, symbol);
      Alert.alert(title, detail);
      setSubmission(null);
      setPhase('review');
      return;
    }
    const auth = await requireLocalAuth('Approve submitting this recovery as a guardian');
    if (!auth.ok) {
      Alert.alert('Not sent', auth.message);
      return;
    }
    setPhase('sending');
    try {
      const bundler = await bundlerFor();
      const { userOpHash } = await signWith(EVM_CHAIN_ID, submission.submitter, (signer) =>
        submitGuardianRecovery({ quote: submission, node, bundler, chainId, signer }),
      );
      setSubmitted({ userOpHash, state: 'pending', receipt: null });
      setPhase('submitted');
      const client = new BundlerClient(bundler, ENTRYPOINT_V07);
      void (async () => {
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
          const raw = await client.getUserOperationReceipt(userOpHash);
          if (raw) return summarizeAaReceipt(raw);
          await new Promise((r) => setTimeout(r, 3_000));
        }
        throw new Error('timeout');
      })().then(
        (receipt) => setSubmitted((prev) => (prev && prev.userOpHash === userOpHash ? { ...prev, state: 'done', receipt } : prev)),
        () => setSubmitted((prev) => (prev && prev.userOpHash === userOpHash ? { ...prev, state: 'timeout' } : prev)),
      );
    } catch (e) {
      const { title, detail } =
        describeAaError(e, { accountType: 'kernel-v3.3', deployed: true }) ?? describeSendError(e, symbol);
      Alert.alert(title, detail);
      // The quote went out once and is used up (aa.ts
      // claimQuoteForSubmission): back to the review, whose "Submit the
      // recovery" quotes again with fresh fees.
      setSubmission(null);
      setPhase('review');
    }
  };

  // ------------------------------------------------------------ render

  const guardianRow = (
    <InfoRow
      label="Signing as guardian"
      value={activeAccount?.name ?? 'This account'}
      sub={guardianAddress}
    />
  );

  if (phase === 'submitted' && submitted) {
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <Text style={[styles.title, { color: theme.success }]}>Recovery submitted to the bundler</Text>
        <InfoRow label="UserOperation hash (send this to the account holder)" value={submitted.userOpHash} monoValue />
        {submitted.state === 'pending' ? (
          <View style={styles.center}>
            <ActivityIndicator color={theme.accent} />
            <Text style={[styles.hint, { color: theme.textMuted }]}>Bundling… waiting for the receipt.</Text>
          </View>
        ) : null}
        {submitted.state === 'done' && submitted.receipt ? (
          <Text style={[styles.ok, { color: submitted.receipt.success === false ? theme.danger : theme.success }]}>
            {submitted.receipt.success === false
              ? 'Included, but the operation reverted.'
              : 'Included on-chain. The account holder can now attach the account on their new wallet.'}
          </Text>
        ) : null}
        {submitted.state === 'timeout' ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>Not included within two minutes; it may still be.</Text>
        ) : null}
        {submitted.receipt?.txHash ? (
          <Button
            title="View bundle transaction"
            variant="secondary"
            onPress={() => void Linking.openURL(`${evmChain.explorerTxBase}${submitted.receipt!.txHash}`)}
          />
        ) : null}
        <ShareActions text={`Recovery submitted. UserOperation hash: ${submitted.userOpHash}`} shareTitle="Recovery submitted" />
        <Button title="Done" onPress={() => navigation.goBack()} />
      </ScrollView>
    );
  }

  if ((phase === 'submit-confirm' || phase === 'sending') && submission && review) {
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <RecoveryNetworkBadge label={evmChain.label} testnet={evmChain.testnet} />
        <Text style={[styles.title, { color: theme.text }]}>Submit the recovery?</Text>
        <WarningBox>{APPROVER_WARNING}</WarningBox>
        {guardianRow}
        <InfoRow label="Account" value={review.request.account} monoValue />
        <InfoRow label="NEW OWNER after this operation" value={review.request.newOwner} monoValue />
        <InfoRow label="Proposal id" value={review.request.callDataAndNonceHash} monoValue />
        <InfoRow
          label="Operation"
          value="doRecovery on the account (replaces its owner key), signed by your guardian key"
          sub={submission.approvals.length > 0 ? `Carries ${submission.approvals.length} other guardian approval(s).` : 'The proposal is already approved on-chain.'}
        />
        <InfoRow
          label="Max network fee — paid by the ACCOUNT being recovered"
          value={`${formatUnits(submission.fee, 18, 18)} ${symbol}`}
          sub={`Account balance: ${formatUnits(submission.accountBalance, 18, 18)} ${symbol}. You pay nothing.`}
        />
        <Text style={[styles.ok, { color: theme.success }]}>Bundler gas estimate passed.</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          The estimate uses a placeholder signature; the bundler checks your real signature only when it accepts the
          operation, so a rejection then is shown exactly as returned.
        </Text>
        {phase === 'sending' ? (
          <ActivityIndicator size="large" color={theme.accent} />
        ) : (
          <>
            <Button title="Submit recovery" variant="destructive" onPress={() => void onSubmit()} />
            <Button title="Back" variant="secondary" onPress={() => setPhase('review')} />
          </>
        )}
      </ScrollView>
    );
  }

  if (phase === 'signed' && signed && review) {
    const p = localProgressFor(review);
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <Text style={[styles.title, { color: theme.success }]}>Approval signed</Text>
        <Text style={[styles.hint, { color: theme.text }]}>
          Give this approval to the account holder (show the QR code, or share the text). It approves only proposal{' '}
          {review.request.callDataAndNonceHash}.
        </Text>
        <PayloadQr value={signed.payload} caption="Guardian approval" />
        <ShareActions text={signed.payload} shareTitle="Guardian approval" />
        {p ? (
          <Button title="Add it to the recovery in progress on this device" variant="secondary" onPress={() => void onAddToLocal()} />
        ) : null}
        <Button title="Done" onPress={() => setPhase('review')} />
      </ScrollView>
    );
  }

  if (phase === 'review' && review) {
    const g = review.guardian;
    const match = contactsNetworkId ? matchRecipient(contactsNetworkId, review.request.newOwner, contacts) : null;
    const delay = review.set.delaySeconds;
    const approvedWeight = review.approvals.reduce((s, a) => s + a.guardian.weight, 0);
    const canApprove = g !== null && review.nonceMatches && review.proposal.status === 'ongoing';
    const canSubmit =
      g !== null &&
      review.nonceMatches &&
      (delay === 0
        ? review.proposal.status === 'ongoing' &&
          (review.approvals.some((a) => a.guardian.address.toLowerCase() === g.address.toLowerCase())
            ? approvedWeight
            : approvedWeight + g.weight) >= review.set.threshold
        : review.proposal.status === 'approved' && review.proposal.validAfter <= now);
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        {readiness ? <TestNetworksOnlyCard feature={readiness.feature} hint={readiness.hint} style={styles.card} titleStyle={styles.ok} bodyStyle={styles.hint} hintStyle={styles.hint} /> : null}
        <RecoveryNetworkBadge label={evmChain.label} testnet={evmChain.testnet} />
        <Text style={[styles.title, { color: theme.text }]}>Recovery request</Text>
        <WarningBox>{APPROVER_WARNING}</WarningBox>
        {guardianRow}
        <InfoRow label="Account to be recovered" value={review.request.account} monoValue />
        <InfoRow label="Its owner now" value={review.currentOwner} monoValue />
        <InfoRow label="PROPOSED NEW OWNER" value={review.request.newOwner} monoValue />
        {match && match.kind !== 'none' ? <RecipientContactNotice match={match} address={review.request.newOwner} /> : null}
        <InfoRow label="Proposal id" value={review.request.callDataAndNonceHash} monoValue />
        <InfoRow label="Chain id · guardian nonce" value={`${review.request.chainId} · ${review.request.nonce}`} />
        <GuardianSetView
          set={review.set}
          labelFor={(address) => {
            // This wallet's own accounts by name ("you" for the signing one),
            // other guardians by their position in the on-chain set.
            if (guardianAddress && address.toLowerCase() === guardianAddress.toLowerCase()) {
              return `You (${activeAccount?.name ?? 'this account'})`;
            }
            const mine = accountList.find((a) => a.evmAddress?.toLowerCase() === address.toLowerCase());
            if (mine) return `${mine.name} (this wallet)`;
            const position = review.set.guardians.findIndex((g) => g.address.toLowerCase() === address.toLowerCase());
            return `Guardian ${position + 1}`;
          }}
        />
        <Text style={[styles.ok, { color: theme.text }]}>
          {proposalStatusText(review.proposal, review.set.threshold, now)}
        </Text>
        {review.approvals.length > 0 ? (
          <Text style={[styles.hint, { color: theme.text }]}>
            Carries {review.approvals.length} verified approval(s), weight {approvedWeight}:{' '}
            {review.approvals.map((a) => a.guardian.address).join(', ')}
          </Text>
        ) : null}
        {review.invalidApprovals.length > 0 ? (
          <WarningBox>Ignored approvals that did not verify: {review.invalidApprovals.join('; ')}</WarningBox>
        ) : null}
        {!review.nonceMatches ? (
          <WarningBox>This request is out of date (the account’s guardian nonce moved). Ask for a new one.</WarningBox>
        ) : null}
        {g === null ? (
          <WarningBox>
            {activeAccount?.name ?? 'This account'} ({guardianAddress}) is not a guardian of this account, so it cannot
            approve.
            {otherGuardianAccounts.length > 0
              ? ` ${otherGuardianAccounts.map((a) => a.name).join(', ')} of this wallet ${otherGuardianAccounts.length === 1 ? 'is' : 'are'} — switch to it first.`
              : ''}
          </WarningBox>
        ) : (
          <Text style={[styles.hint, { color: theme.text }]}>Your guardian weight: {g.weight}</Text>
        )}
        {canApprove ? (
          <Button title="Approve (sign as guardian)" variant="destructive" onPress={onApprove} disabled={readiness !== null} />
        ) : null}
        {canSubmit ? (
          <>
            <Text style={[styles.hint, { color: theme.textMuted }]}>{GUARDIAN_SUBMITS_NOTE}</Text>
            <Button
              title="Submit the recovery"
              variant="secondary"
              onPress={() => void onSubmitQuote()}
              disabled={readiness !== null}
            />
          </>
        ) : null}
        {delay > 0 && review.proposal.status === 'approved' && review.proposal.validAfter > now ? (
          <Text style={[styles.hint, { color: theme.text }]}>
            Approved on-chain; it can be submitted in {formatDuration(review.proposal.validAfter - now)}.
          </Text>
        ) : null}
        <Button title="Back" variant="secondary" onPress={() => setPhase('input')} />
      </ScrollView>
    );
  }

  return (
    <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {readiness ? <TestNetworksOnlyCard feature={readiness.feature} hint={readiness.hint} style={styles.card} titleStyle={styles.ok} bodyStyle={styles.hint} hintStyle={styles.hint} /> : null}
      <Text style={[styles.title, { color: theme.text }]}>Approve a recovery (as a guardian)</Text>
      <Text style={[styles.hint, { color: theme.text }]}>
        Someone who named you as a guardian lost access to their account and asks you to make a new key its owner. Paste
        or scan their request. Nothing is signed until you review it and tap Approve.
      </Text>
      {guardianRow}
      {nodeError ? <WarningBox>{nodeError}</WarningBox> : null}
      <PasteOrScan
        value={input}
        onChange={setInput}
        placeholder="Paste the recovery request"
        rationale="Scan the recovery request QR code on the account holder's new phone."
      />
      {error ? <WarningBox>{error}</WarningBox> : null}
      {phase === 'reviewing' ? (
        <ActivityIndicator color={theme.accent} />
      ) : (
        <Button
          title="Review request"
          disabled={!node || !input.trim() || readiness !== null}
          onPress={() => void onReview(input)}
        />
      )}
      {local.length > 0 ? (
        <>
          <Text style={[styles.sectionTitle, { color: theme.text }]}>Recoveries in progress on this device</Text>
          {local.map((p) => (
            <Button
              key={`${p.chain}|${p.newOwner}`}
              title={`Review the request for ${p.account}`}
              variant="secondary"
              disabled={readiness !== null}
              onPress={() => {
                const text = encodeRecoveryRequestPayload(p.request!, p.approvals);
                setInput(text);
                void onReview(text);
              }}
            />
          ))}
        </>
      ) : null}
    </ScrollView>
  );
}

