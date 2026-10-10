import React, { useCallback, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ActivityIndicator, Alert, Linking, ScrollView, Switch, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { KernelRecoveryMetadata } from '@shiba-wallet/chains-evm';
import type { RootStackParamList } from '../navigation';
import { Button, TestNetworksOnlyCard, WarningBox, screenStyle } from '../components';
import {
  GuardianSetView,
  InfoRow,
  PayloadQr,
  RecoveryNetworkBadge,
  ShareActions,
  recoveryLayout as styles,
} from '../components/RecoveryViews';
import { RecordFileExportButton } from '../components/RecordFileActions';
import { useTheme } from '../theme';
import { readinessGate } from '../config/readiness';
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
  type AaChainConfig,
  type AaClientBundle,
} from '../wallet/aa';
import { AaDepositNote } from '../components/AaDepositNote';
import {
  OWNER_ROTATION_EXPLANATION,
  OWNER_ROTATION_OLD_KEY_WARNING,
  RECOVERED_NOT_DERIVABLE_NOTE,
  RECOVERY_RECORD_NOTE,
  checkOwnerRotationTarget,
  evmAccountPath,
  finalizeOwnerRotation,
  getRecoveryRecord,
  listPendingOwnerRotations,
  markRecordExported,
  prepareOwnerRotationQuote,
  recordExport,
  resolveOwnerRotationAccount,
  submitOwnerRotation,
  waitAndFinalizeOwnerRotation,
  type OwnerRotationOutcome,
  type OwnerRotationQuote,
  type OwnerRotationResolution,
  type PendingOwnerRotation,
  type WalletOwnerAccount,
} from '../wallet/recovery';

type Props = NativeStackScreenProps<RootStackParamList, 'OwnerRotation'>;

type Phase = 'overview' | 'quoting' | 'confirm' | 'sending' | 'progress';

interface Progress {
  userOpHash: string;
  rotation: OwnerRotationQuote;
  previous: KernelRecoveryMetadata | null;
  recordError: string | null;
  outcome: OwnerRotationOutcome | null;
  receiptTx: string | null;
}

/**
 * "Change owner" (phase 8 follow-up): hands the active account's DEPLOYED
 * Kernel v3.3 account — derived from this account, or a recovered account
 * attached to it — to the EVM key of ANOTHER account of this wallet. The
 * in-app form of scripts/testnet/kernel-rotate-owner.mjs: one root operation
 * running the engine's ownerRotationCalls (and, if chosen, the guardian
 * removal), through the normal smart-account confirm (bundler estimate gate,
 * network badge, fee, biometric gate, signWith(current owner), sendAa). After
 * inclusion the owner is re-read on-chain, the recovery record gets the
 * owner-rotation entry, and the account is attached to the new owner's
 * account (../wallet/recovery.ts finalizeOwnerRotation). Refused: SimpleAccount,
 * EIP-7702 upgrades, undeployed and foreign-owned accounts, a new owner that is
 * the current owner, a guardian, or not one of this wallet's accounts.
 */
export function OwnerRotationScreen({ navigation }: Props) {
  const theme = useTheme();
  const { accounts, activeAccount, accountList, signWith, switchAccount } = useWallet();
  const { evmChain } = usePrefs();
  const evm = accounts.find((a) => a.chainId === EVM_CHAIN_ID) ?? null;
  const owner = evm?.address ?? null;
  const ownerPath = evm?.path ?? null;
  const symbol = evmChain.displaySymbol;
  const chain = evmChain.caip2;
  // Mainnet readiness (config/readiness.ts): owner changes are test-network
  // only. Status reads and finishing an owner change already sent stay
  // available; recovery.ts refuses a new owner change too.
  const readiness = readinessGate('owner-rotation', chain);

  const [bundle, setBundle] = useState<AaClientBundle | null>(null);
  const [config, setConfig] = useState<AaChainConfig | null>(null);
  const [resolution, setResolution] = useState<OwnerRotationResolution | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingOwnerRotation[]>([]);
  const [pendingNote, setPendingNote] = useState<string | null>(null);
  const [target, setTarget] = useState<WalletOwnerAccount | null>(null);
  const [removeGuardians, setRemoveGuardians] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('overview');
  const [rotation, setRotation] = useState<OwnerRotationQuote | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [backupMeta, setBackupMeta] = useState<KernelRecoveryMetadata | null>(null);

  useEffect(() => {
    navigation.setOptions({ title: 'Change owner' });
  }, [navigation]);

  /**
   * Every account of this wallet from the recovery phrase with an EVM key:
   * the only allowed new owners. Imported accounts are left out (ADR D9):
   * the phrase does not back up their keys, so the smart account could be
   * lost with this phone (recovery.ts refuses them as targets too).
   */
  const walletOwners = useMemo<WalletOwnerAccount[]>(
    () =>
      accountList
        .filter((a) => a.evmAddress && !a.imported)
        .map((a) => ({ index: a.index, name: a.name, address: a.evmAddress!, path: evmAccountPath(a.index) })),
    [accountList],
  );

  const setup = useCallback(() => {
    if (!owner || !activeAccount) return;
    (async () => {
      const endpoint = await getEndpoint(EVM_CHAIN_ID);
      if (!endpoint?.url) throw new Error('No RPC endpoint is configured for this network.');
      const cfg = await getAaConfig(chain);
      const pend = await listPendingOwnerRotations(chain, walletOwners);
      let b: AaClientBundle | null = null;
      let r: OwnerRotationResolution;
      try {
        b = createAaClientFromConfig(cfg, {
          nodeUrl: endpoint.url,
          chainId: BigInt(evmChain.chainIdDecimal),
          accountIndex: activeAccount.index,
          ownerAddress: owner,
        });
        r = await resolveOwnerRotationAccount(b, owner);
      } catch (e) {
        r = {
          ok: false,
          reason: `${e instanceof Error ? e.message : String(e)} Changing the owner needs a verified bundler and a deployed Kernel v3.3 account.`,
        };
      }
      return { b, cfg, r, pend };
    })().then(
      ({ b, cfg, r, pend }) => {
        setSetupError(null);
        setBundle(b);
        setConfig(cfg);
        setResolution(r);
        setPending(pend);
      },
      (e: unknown) => setSetupError(e instanceof Error ? e.message : String(e)),
    );
  }, [owner, activeAccount, chain, evmChain.chainIdDecimal, walletOwners]);
  useEffect(setup, [setup]);

  const account = resolution?.ok ? resolution.account : null;
  const guardianSet = resolution?.ok ? resolution.state.set : null;
  const guardiansPresent = resolution?.ok
    ? resolution.state.validationInstalled || resolution.state.validatorInitialized || resolution.state.recoveryRouted
    : false;

  /** Local refusal per candidate (no network), shown under each choice. */
  const refusalFor = useCallback(
    (w: WalletOwnerAccount): string | null =>
      account && owner && config
        ? checkOwnerRotationTarget({
            account,
            currentOwner: owner,
            newOwner: w.address,
            walletOwners,
            guardians: guardianSet?.guardians ?? null,
            config,
          })
        : null,
    [account, owner, config, walletOwners, guardianSet],
  );

  const describe = (e: unknown) =>
    (bundle ? describeAaError(e, { accountType: bundle.accountType, deployed: true }) : null) ?? describeSendError(e, symbol);

  const nameOf = (address: string): string | null =>
    walletOwners.find((w) => w.address.toLowerCase() === address.toLowerCase())?.name ?? null;

  // ------------------------------------------------------------ actions

  const onReview = async () => {
    if (!bundle || !owner || !activeAccount || !config || !target) return;
    setFormError(null);
    setPhase('quoting');
    try {
      const q = await prepareOwnerRotationQuote(bundle, {
        ownerAddress: owner,
        ownerIndex: activeAccount.index,
        ownerPath,
        newOwner: target,
        walletOwners,
        removeGuardians,
        chain,
        config,
      });
      setRotation(q);
      setPhase('confirm');
    } catch (e) {
      const { title, detail } = describe(e);
      setFormError(`${title}\n${detail}`);
      setPhase('overview');
    }
  };

  const onConfirm = async () => {
    const r = rotation;
    if (!r || !bundle || !owner || !config) return;
    // The bundler's fee floor, BEFORE the device check (aa.ts
    // checkAaQuoteBeforeApproval): when it rose above the reviewed fees,
    // Review prices the change again, nothing approved.
    try {
      await checkAaQuoteBeforeApproval(bundle.bundler, r.quote);
    } catch (e) {
      const { title, detail } = describe(e);
      Alert.alert(title, detail);
      setRotation(null);
      setPhase('overview');
      return;
    }
    const auth = await requireLocalAuth('Approve changing the owner key');
    if (!auth.ok) {
      Alert.alert('Not sent', auth.message);
      return;
    }
    setPhase('sending');
    try {
      const { userOpHash, previous, recordError } = await submitOwnerRotation({
        rotation: r,
        chain,
        store: AsyncStorage,
        // The CURRENT owner key signs (root validator), only for the owner
        // EOA the quote was prepared for.
        submit: (q) => signWith(EVM_CHAIN_ID, owner, (signer) => sendAa(bundle, signer, q)),
      });
      setProgress({ userOpHash, rotation: r, previous, recordError, outcome: null, receiptTx: null });
      setPhase('progress');
      void waitAndFinalizeOwnerRotation({ bundle, rotation: r, userOpHash, chain, previous, config }).then(
        ({ receipt, outcome }) =>
          setProgress((prev) =>
            prev && prev.userOpHash === userOpHash ? { ...prev, outcome, receiptTx: receipt?.txHash ?? null } : prev,
          ),
        (e: unknown) =>
          setProgress((prev) =>
            prev && prev.userOpHash === userOpHash
              ? { ...prev, outcome: { state: 'unverified', problems: [e instanceof Error ? e.message : String(e)] } }
              : prev,
          ),
      );
    } catch (e) {
      const { title, detail } = describe(e);
      Alert.alert(title, detail);
      // The quote went out once and is used up (aa.ts
      // claimQuoteForSubmission): Review prices the change again.
      setRotation(null);
      setPhase('overview');
    }
  };

  const recheck = (p: { account: string; previousOwner: string; newOwner: WalletOwnerAccount; userOpHash: string | null; removeGuardians: boolean; previous?: KernelRecoveryMetadata | null }, abandon = false) => {
    if (!bundle || !config) return;
    finalizeOwnerRotation({
      node: bundle.node,
      chain,
      account: p.account,
      previousOwner: p.previousOwner,
      newOwner: p.newOwner,
      removeGuardians: p.removeGuardians,
      userOpHash: p.userOpHash,
      previous: p.previous ?? null,
      config,
      abandon,
    }).then(
      (outcome) => {
        setPendingNote(outcomeText(outcome, p.newOwner.name));
        if (progress && progress.rotation.account === p.account) setProgress({ ...progress, outcome });
        setup();
      },
      (e: unknown) => Alert.alert('Not checked', e instanceof Error ? e.message : String(e)),
    );
  };

  // ------------------------------------------------------------ render

  const header = (
    <>
      <Text style={[styles.hint, { color: theme.textMuted }]}>
        {evmChain.label}
        {evmChain.testnet ? ' · TESTNET' : ''} · chain id {evmChain.chainIdDecimal}
      </Text>
      <InfoRow label="Current owner (signs this change)" value={activeAccount?.name ?? 'Account'} sub={owner} />
      {resolution?.ok ? (
        <InfoRow
          label={resolution.kind === 'recovered' ? 'Recovered Kernel account (address stays the same)' : 'Kernel smart account (address stays the same)'}
          value={resolution.account}
          sub={resolution.kind === 'recovered' ? RECOVERED_NOT_DERIVABLE_NOTE : null}
          monoValue
        />
      ) : null}
    </>
  );

  if (backupMeta) {
    const exp = recordExport(backupMeta);
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <Text style={[styles.title, { color: theme.text }]}>Back up the updated recovery record</Text>
        <Text style={[styles.hint, { color: theme.text }]}>{RECOVERY_RECORD_NOTE}</Text>
        <PayloadQr value={exp.qrValue} caption={`Recovery record for ${backupMeta.account} (${exp.bytes} bytes)`} />
        <RecordFileExportButton metadata={backupMeta} />
        <ShareActions text={exp.shareText} shareTitle="Recovery record" />
        <Button
          title="I saved it somewhere other than this phone"
          onPress={() => {
            markRecordExported(backupMeta.chainId, backupMeta.account).then(
              () => setBackupMeta(null),
              (err: unknown) => Alert.alert('Not saved', err instanceof Error ? err.message : String(err)),
            );
          }}
        />
        <Button title="Later" variant="secondary" onPress={() => setBackupMeta(null)} />
      </ScrollView>
    );
  }

  if (phase === 'progress' && progress) {
    const o = progress.outcome;
    const newName = progress.rotation.newOwner.name;
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <Text style={[styles.title, { color: theme.success }]}>Owner change sent to the bundler</Text>
        <InfoRow label="UserOperation hash" value={progress.userOpHash} monoValue />
        {progress.recordError ? (
          <WarningBox>
            The operation was accepted, but the recovery record could not be updated yet: {progress.recordError}. The
            wallet retries when the change is confirmed below.
          </WarningBox>
        ) : null}
        {o === null ? (
          <View style={styles.center}>
            <ActivityIndicator color={theme.accent} />
            <Text style={[styles.hint, { color: theme.textMuted }]}>Bundling… waiting for the receipt, then reading the owner on-chain.</Text>
          </View>
        ) : (
          <Text style={[styles.ok, { color: o.state === 'done' ? theme.success : o.state === 'pending' ? theme.text : theme.danger }]}>
            {outcomeText(o, newName)}
          </Text>
        )}
        {o?.state === 'done' && !o.recordCheck.ok ? (
          <WarningBox>The recovery record differs from the chain: {o.recordCheck.problems.join('; ')}</WarningBox>
        ) : null}
        {evmChain.explorerTxBase && (progress.receiptTx || (o?.state === 'done' && o.txHash)) ? (
          <Button
            title="View bundle transaction"
            variant="secondary"
            onPress={() => void Linking.openURL(`${evmChain.explorerTxBase}${progress.receiptTx ?? (o?.state === 'done' ? o.txHash : '')}`)}
          />
        ) : null}
        {o?.state === 'pending' || o?.state === 'unverified' ? (
          <Button
            title="Check again"
            variant="secondary"
            onPress={() =>
              recheck({
                account: progress.rotation.account,
                previousOwner: progress.rotation.currentOwner,
                newOwner: progress.rotation.newOwner,
                userOpHash: progress.userOpHash,
                removeGuardians: progress.rotation.removeGuardians,
                previous: progress.previous,
              })
            }
          />
        ) : null}
        {o?.state === 'done' ? (
          <>
            <WarningBox>
              Back up the updated recovery record now: it lists the new owner, and a wallet restored from your phrase may
              need it to find this account.
            </WarningBox>
            <Button
              title="Back up the recovery record"
              onPress={() => {
                getRecoveryRecord(chain, progress.rotation.account).then(
                  (e) => (e ? setBackupMeta(e.metadata) : Alert.alert('No record', 'There is no recovery record for this account on this device.')),
                  (err: unknown) => Alert.alert('Not read', err instanceof Error ? err.message : String(err)),
                );
              }}
            />
            <Button
              title={`Switch to ${newName}`}
              variant="secondary"
              onPress={() => void switchAccount(progress.rotation.newOwner.index)}
            />
          </>
        ) : null}
        <Button
          title="Done"
          variant="secondary"
          onPress={() => {
            setProgress(null);
            setRotation(null);
            setPhase('overview');
            setup();
          }}
        />
      </ScrollView>
    );
  }

  if ((phase === 'confirm' || phase === 'sending') && rotation) {
    const q = rotation.quote;
    const callCount = rotation.calls.length;
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <RecoveryNetworkBadge label={evmChain.label} testnet={evmChain.testnet} />
        <Text style={[styles.title, { color: theme.text }]}>Change the owner key?</Text>
        {header}
        <InfoRow label="Current owner (stops working for this account)" value={rotation.currentOwner} sub={nameOf(rotation.currentOwner)} monoValue />
        <InfoRow
          label="New owner (one of your accounts)"
          value={rotation.newOwner.address}
          sub={`${rotation.newOwner.name} · ${rotation.newOwner.path}`}
          monoValue
        />
        <WarningBox>{OWNER_ROTATION_OLD_KEY_WARNING}</WarningBox>
        {rotation.removeGuardians ? (
          <Text style={[styles.hint, { color: theme.text }]}>
            The guardians are removed in the same operation: afterwards nobody can recover this account with guardians,
            and they can no longer sign messages as the account.
          </Text>
        ) : rotation.guardians ? (
          <>
            <Text style={[styles.hint, { color: theme.text }]}>
              The guardians stay as they are. Together they can still replace the owner — including the new one.
            </Text>
            <GuardianSetView set={rotation.guardians} />
          </>
        ) : null}
        {rotation.attach ? (
          <Text style={[styles.hint, { color: theme.text }]}>
            After the change, smart-account sends from {rotation.newOwner.name} on this network use this account. Its
            address cannot be computed from {rotation.newOwner.name}’s key, so the wallet keeps it attached and the
            recovery record lists it.
            {rotation.newOwnerOwnSmartAccount
              ? ` While it is attached, ${rotation.newOwner.name}’s own smart account (${rotation.newOwnerOwnSmartAccount}) is not used for its smart-account sends; funds there stay where they are.`
              : ''}
          </Text>
        ) : (
          <Text style={[styles.hint, { color: theme.text }]}>
            This account is {rotation.newOwner.name}’s own smart account on this network (derived from its key), so it
            needs no attachment after the change.
          </Text>
        )}
        <InfoRow
          label="Operation"
          value={
            rotation.removeGuardians
              ? `${callCount} calls from your account: the owner validator’s onUninstall and onInstall(new owner), then uninstallValidation, revoke doRecovery access and uninstallModule (RecoveryAction)`
              : '2 calls from your account to the owner validator: onUninstall, then onInstall(new owner)'
          }
          sub="Signed by the current owner key as the account's root validator."
        />
        <InfoRow
          label={q.sponsored ? 'Network fee' : 'Max network fee (bundler estimate)'}
          value={q.sponsored ? 'Sponsored — the account pays 0' : `${formatUnits(q.fee, 18, 18)} ${symbol}`}
        />
        <InfoRow label="Account balance" value={`${formatUnits(q.senderBalance, 18, 18)} ${symbol}`} />
        <AaDepositNote fee={q.fee} deposit={q.deposit} sponsored={q.sponsored} symbol={symbol} />
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
            <Button title="Change owner" variant="destructive" onPress={() => void onConfirm()} />
            <Button
              title="Back"
              variant="secondary"
              onPress={() => {
                setRotation(null);
                setPhase('overview');
              }}
            />
          </>
        )}
      </ScrollView>
    );
  }

  // ------------------------------------------------------------ overview
  return (
    <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {readiness ? <TestNetworksOnlyCard feature={readiness.feature} hint={readiness.hint} style={styles.card} titleStyle={styles.ok} bodyStyle={styles.hint} hintStyle={styles.hint} /> : null}
      <Text style={[styles.title, { color: theme.text }]}>Change the owner key</Text>
      {header}
      {OWNER_ROTATION_EXPLANATION.map((line) => (
        <Text key={line} style={[styles.hint, { color: theme.text }]}>
          {line}
        </Text>
      ))}
      {!owner ? <Text style={[styles.error, { color: theme.danger }]}>No Ethereum address for this account.</Text> : null}
      {setupError ? <WarningBox>{setupError}</WarningBox> : null}
      {resolution === null && !setupError && owner ? <ActivityIndicator color={theme.accent} /> : null}
      {resolution && !resolution.ok ? <WarningBox>{resolution.reason}</WarningBox> : null}

      {pending.length > 0 ? (
        <>
          <Text style={[styles.sectionTitle, { color: theme.text }]}>Unfinished owner changes</Text>
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            The app was closed before these were confirmed. Check reads the owner on-chain and finishes the change (or
            tells you it is still pending).
          </Text>
          {pending.map((p) => (
            <View key={p.account} style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
              <InfoRow label="Account" value={p.account} monoValue />
              <InfoRow label="From" value={p.previousOwner} sub={nameOf(p.previousOwner)} monoValue />
              <InfoRow label="To" value={p.newOwner.address} sub={p.newOwner.name} monoValue />
              <Button
                title="Check and finish"
                variant="secondary"
                disabled={!bundle}
                onPress={() => recheck({ ...p, removeGuardians: false })}
              />
              <Button
                title="Forget (only if it never went through)"
                variant="secondary"
                disabled={!bundle}
                onPress={() =>
                  Alert.alert(
                    'Forget this owner change?',
                    'Only allowed while the chain still shows the previous owner. The recovery record goes back to the previous owner.',
                    [
                      { text: 'Keep', style: 'cancel' },
                      { text: 'Forget', style: 'destructive', onPress: () => recheck({ ...p, removeGuardians: false }, true) },
                    ],
                  )
                }
              />
            </View>
          ))}
          {pendingNote ? <Text style={[styles.hint, { color: theme.text }]}>{pendingNote}</Text> : null}
        </>
      ) : pendingNote ? (
        <Text style={[styles.hint, { color: theme.text }]}>{pendingNote}</Text>
      ) : null}

      {resolution?.ok ? (
        <>
          <Text style={[styles.sectionTitle, { color: theme.text }]}>New owner</Text>
          <Text style={[styles.hint, { color: theme.textMuted }]}>Choose which of your accounts’ keys will own this account.</Text>
          {walletOwners.map((w) => {
            const refusal = refusalFor(w);
            const chosen = target?.index === w.index;
            const isCurrent = owner !== null && w.address.toLowerCase() === owner.toLowerCase();
            return (
              <View key={w.index} style={[styles.card, { backgroundColor: theme.card, borderColor: chosen ? theme.accent : theme.border }]}>
                <Text style={[styles.cardTitle, { color: theme.text }]}>
                  {chosen ? '✓ ' : ''}
                  {w.name}
                  {isCurrent ? ' (current owner)' : ''}
                </Text>
                <Text selectable style={[styles.mono, { color: theme.textMuted }]}>
                  {w.address}
                </Text>
                {refusal && !isCurrent ? <Text style={[styles.hint, { color: theme.textMuted }]}>{refusal}</Text> : null}
                {!refusal ? (
                  <Button
                    title={chosen ? 'Chosen' : 'Make this the new owner'}
                    selected={chosen}
                    accessibilityLabel={`Make ${w.name} the new owner`}
                    variant={chosen ? 'primary' : 'secondary'}
                    onPress={() => setTarget(w)}
                    disabled={readiness !== null}
                  />
                ) : null}
              </View>
            );
          })}
          {walletOwners.length < 2 ? (
            <Text style={[styles.hint, { color: theme.textMuted }]}>
              This wallet has only one account. Add another account (Settings → Accounts) to hand this account to it.
            </Text>
          ) : null}
          {guardiansPresent ? (
            <View style={styles.toggleRow}>
              <Text style={[styles.toggleLabel, { color: theme.text }]}>
                Also remove the guardians in the same operation (otherwise they stay unchanged and can still replace the
                new owner)
              </Text>
              <Switch
                accessibilityLabel="Also remove the guardians in the same operation"
                value={removeGuardians}
                onValueChange={setRemoveGuardians}
              />
            </View>
          ) : null}
          {formError ? <WarningBox>{formError}</WarningBox> : null}
          {phase === 'quoting' ? (
            <View style={styles.center}>
              <ActivityIndicator color={theme.accent} />
              <Text style={[styles.hint, { color: theme.textMuted }]}>Reading the account and asking the bundler…</Text>
            </View>
          ) : (
            <Button title="Review" disabled={!target || readiness !== null} onPress={() => void onReview()} />
          )}
        </>
      ) : null}
      <Button title="Refresh" variant="secondary" onPress={setup} />
    </ScrollView>
  );
}

function outcomeText(o: OwnerRotationOutcome, newName: string): string {
  switch (o.state) {
    case 'done':
      return (
        `Included — the owner is now ${newName} (checked on-chain). Switch to ${newName} to use this smart account.` +
        (o.txHash ? '' : ' The transaction hash was not found in recent blocks; the record keeps the UserOperation hash.')
      );
    case 'pending':
      return 'Not confirmed yet: the chain still shows the previous owner. It may still be included; check again later.';
    case 'failed':
      return o.detail;
    case 'other-owner':
      return `The account is now owned by ${o.owner}, which is neither the previous nor the chosen owner. Nothing was changed on this device.`;
    case 'unverified':
      return `The ownership check failed, so nothing was attached: ${o.problems.join('; ')}.`;
  }
}

