import React, { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ActivityIndicator, Alert, Linking, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { KERNEL_WEBAUTHN_VALIDATOR } from '@shiba-wallet/chains-evm';
import type { RootStackParamList } from '../navigation';
import { Button, TestNetworksOnlyCard, WarningBox, screenStyle } from '../components';
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
import { loadPasskeyNative } from '../wallet/passkey-native';
import { readinessGate } from '../config/readiness';
import {
  PASSKEY_AUDIT_NOTE,
  PASSKEY_EXPLANATION,
  PASSKEY_OS_CLEANUP_NOTE,
  PASSKEY_SELF_CALL_RISK,
  PASSKEY_WIPE_NOTE,
  createPasskeyBundle,
  finalizePasskeyInstall,
  finalizePasskeyRemove,
  installPasskey,
  makePasskeyAssert,
  passkeyRecordForAccount,
  passkeyStatusText,
  passkeyTestCalls,
  passkeyUserName,
  preparePasskeyCalls,
  preparePasskeyInstall,
  preparePasskeyRemove,
  readPasskeyStatus,
  reconcilePasskeyRecord,
  registerPasskey,
  removePasskey,
  resetPasskeys,
  resolvePasskeyAccount,
  sendPasskeyCalls,
  type PasskeyAccountResolution,
  type PasskeyBundle,
  type PasskeyChainStatus,
  type PasskeyGate,
  type PasskeyInstallPlan,
  type PasskeyNative,
  type PasskeyRecord,
  type PasskeyRegistration,
} from '../wallet/passkeys';

type Props = NativeStackScreenProps<RootStackParamList, 'Passkey'>;

type Phase =
  | 'main'
  | 'registering'
  | 'quoting'
  | 'confirm-install'
  | 'confirm-test'
  | 'confirm-remove'
  | 'sending'
  | 'progress';

interface Progress {
  kind: 'install' | 'test' | 'remove';
  userOpHash: string;
  state: 'pending' | 'done' | 'failed' | 'timeout';
  txHash: string | null;
  detail: string | null;
}

const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  // Polyfilled from expo-crypto in src/polyfills.ts (first import of the app).
  globalThis.crypto.getRandomValues(out);
  return out;
}

const short = (hex: string) => `${hex.slice(0, 10)}…${hex.slice(-8)}`;

/**
 * Passkey (phase 8 item 3, app half): add, test and remove a device passkey
 * as an ADDITIONAL signer on the active account's deployed Kernel v3.3 smart
 * account on the active EVM chain. See ../wallet/passkeys.ts for the rules:
 * the install and the removal are ordinary ROOT-signed smart-account
 * operations through the normal confirm idioms (bundler estimate gate,
 * network badge, fee, biometric gate, signWith with expectAddress = the
 * owner EOA, sendAa); the test operation is signed by the passkey alone
 * through the platform prompt and never touches the owner key. Adding and
 * testing need the native module and a configured rpId (the gate note is
 * shown otherwise); removing an installed passkey needs only the recovery
 * phrase, so it works everywhere.
 */
export function PasskeyScreen({ navigation }: Props) {
  const theme = useTheme();
  const { accounts, activeAccount, signWith } = useWallet();
  const { evmChain } = usePrefs();
  const owner = accounts.find((a) => a.chainId === EVM_CHAIN_ID)?.address ?? null;
  const symbol = evmChain.displaySymbol;
  // Mainnet readiness (config/readiness.ts): passkeys are test-network only.
  // Status reads and removal stay available; passkeys.ts refuses the
  // install, the test operation and dApp signatures too.
  const readiness = readinessGate('passkeys', evmChain.caip2);

  const [gate, setGate] = useState<PasskeyGate | null>(null);
  const [native, setNative] = useState<PasskeyNative | null>(null);
  const [bundle, setBundle] = useState<AaClientBundle | null>(null);
  const [resolution, setResolution] = useState<PasskeyAccountResolution | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [record, setRecord] = useState<PasskeyRecord | null>(null);
  const [status, setStatus] = useState<PasskeyChainStatus | null>(null);
  const [phase, setPhase] = useState<Phase>('main');
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingInstall, setPendingInstall] = useState<{ registration: PasskeyRegistration; plan: PasskeyInstallPlan } | null>(null);
  const [pendingTest, setPendingTest] = useState<{ pbundle: PasskeyBundle; quote: AaSendQuote } | null>(null);
  const [pendingRemove, setPendingRemove] = useState<AaSendQuote | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);

  useEffect(() => {
    navigation.setOptions({ title: 'Passkey' });
  }, [navigation]);

  useEffect(() => {
    loadPasskeyNative().then(
      (r) => {
        setGate(r.gate);
        setNative(r.native);
      },
      (e: unknown) =>
        setGate({ ok: false, kind: 'native-missing', reason: e instanceof Error ? e.message : String(e) }),
    );
  }, []);

  const account = resolution?.ok ? resolution.account : null;

  const setup = useCallback(() => {
    if (!owner || !activeAccount) return;
    loadPasskeyContext(owner, activeAccount.index, evmChain.caip2, BigInt(evmChain.chainIdDecimal)).then(
      (ctx) => {
        setSetupError(null);
        setBundle(ctx.bundle);
        setResolution(ctx.resolution);
      },
      (e: unknown) => setSetupError(e instanceof Error ? e.message : String(e)),
    );
  }, [owner, activeAccount, evmChain.caip2, evmChain.chainIdDecimal]);
  useEffect(setup, [setup]);

  const reloadStatus = useCallback(() => {
    if (!account || !bundle) return;
    passkeyRecordForAccount(evmChain.caip2, account).then(
      (r) => {
        setRecord(r);
        if (!r) {
          void readPasskeyStatus(bundle.node, account, null).then(setStatus);
          return;
        }
        // A receipt wait that ended early leaves 'installing'; the chain decides.
        reconcilePasskeyRecord(bundle.node, r, AsyncStorage).then(
          (out) => {
            setRecord(out.record);
            setStatus(out.status);
          },
          () => void readPasskeyStatus(bundle.node, account, r).then(setStatus),
        );
      },
      () => setRecord(null),
    );
  }, [account, bundle, evmChain.caip2]);
  useEffect(reloadStatus, [reloadStatus]);

  const describe = (e: unknown) => {
    const { title, detail } =
      describeAaError(e, { accountType: 'kernel-v3.3', deployed: true }) ?? describeSendError(e, symbol);
    return `${title}\n${detail}`;
  };

  // ------------------------------------------------------------ actions

  const onAdd = async () => {
    if (!gate?.ok || !native || !bundle || !account || !owner || !activeAccount) return;
    setActionError(null);
    setPhase('registering');
    let registration: PasskeyRegistration;
    try {
      registration = await registerPasskey(native, {
        rpId: gate.rpId,
        challenge: randomBytes(32),
        userId: randomBytes(16),
        userName: passkeyUserName(activeAccount.name, account, evmChain.label),
        excludeIds: record ? [record.credentialId] : [],
      });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
      setPhase('main');
      return;
    }
    setPhase('quoting');
    try {
      const plan = await preparePasskeyInstall(bundle, owner, account, registration);
      setPendingInstall({ registration, plan });
      setPhase('confirm-install');
    } catch (e) {
      // The platform already created the passkey; it is unused until installed.
      setActionError(`${describe(e)}\n\n${PASSKEY_OS_CLEANUP_NOTE}`);
      setPhase('main');
    }
  };

  const onInstall = async () => {
    const p = pendingInstall;
    if (!p || !bundle || !account || !owner || !activeAccount || !gate?.ok) return;
    const auth = await requireLocalAuth('Approve adding this passkey to your smart account');
    if (!auth.ok) {
      Alert.alert('Not added', auth.message);
      return;
    }
    setPhase('sending');
    try {
      const { record: saved, userOpHash } = await installPasskey({
        plan: p.plan,
        registration: p.registration,
        chain: evmChain.caip2,
        account,
        owner,
        accountIndex: activeAccount.index,
        rpId: gate.rpId,
        store: AsyncStorage,
        // The OWNER key signs the install (root validator), only for the
        // owner EOA the quote was prepared for.
        submit: (q) => signWith(EVM_CHAIN_ID, owner, (signer) => sendAa(bundle, signer, q)),
      });
      setPendingInstall(null);
      setProgress({ kind: 'install', userOpHash, state: 'pending', txHash: null, detail: null });
      setPhase('progress');
      void finalizePasskeyInstall(bundle, saved, AsyncStorage).then(
        ({ receipt, status: st }) =>
          setProgress((prev) =>
            prev && prev.userOpHash === userOpHash
              ? { ...prev, state: receipt.success === false ? 'failed' : 'done', txHash: receipt.txHash, detail: passkeyStatusText(st) }
              : prev,
          ),
        () => setProgress((prev) => (prev && prev.userOpHash === userOpHash ? { ...prev, state: 'timeout' } : prev)),
      );
    } catch (e) {
      Alert.alert('Not added', describe(e));
      setPhase('confirm-install');
    }
    reloadStatus();
  };

  const onTestQuote = async () => {
    if (!gate?.ok || !native || !bundle || !record) return;
    setActionError(null);
    setPhase('quoting');
    try {
      const pbundle = createPasskeyBundle(bundle, record, makePasskeyAssert(native, record));
      const quote = await preparePasskeyCalls(pbundle, passkeyTestCalls(record), { displayTo: record.owner });
      setPendingTest({ pbundle, quote });
      setPhase('confirm-test');
    } catch (e) {
      setActionError(describe(e));
      setPhase('main');
    }
  };

  const onTest = async () => {
    const t = pendingTest;
    if (!t) return;
    // No app-level biometric gate here: the platform passkey prompt that
    // follows IS the user-verification step, and the validator rejects any
    // assertion without the UV flag on-chain.
    setPhase('sending');
    try {
      const { userOpHash } = await sendPasskeyCalls(t.pbundle, t.quote);
      setPendingTest(null);
      setProgress({ kind: 'test', userOpHash, state: 'pending', txHash: null, detail: null });
      setPhase('progress');
      void t.pbundle.client.waitForReceipt(userOpHash, { timeoutMs: 120_000, pollMs: 3_000 }).then(
        (raw) => {
          const s = summarizeAaReceipt(raw);
          setProgress((prev) =>
            prev && prev.userOpHash === userOpHash ? { ...prev, state: s.success === false ? 'failed' : 'done', txHash: s.txHash } : prev,
          );
        },
        () => setProgress((prev) => (prev && prev.userOpHash === userOpHash ? { ...prev, state: 'timeout' } : prev)),
      );
    } catch (e) {
      Alert.alert('Passkey test not sent', describe(e));
      setPhase('confirm-test');
    }
  };

  const onRemoveQuote = async () => {
    if (!bundle || !account || !owner) return;
    setActionError(null);
    setPhase('quoting');
    try {
      setPendingRemove(await preparePasskeyRemove(bundle, owner, account));
      setPhase('confirm-remove');
    } catch (e) {
      setActionError(describe(e));
      setPhase('main');
    }
  };

  const onRemove = async () => {
    const quote = pendingRemove;
    if (!quote || !bundle || !account || !owner) return;
    const auth = await requireLocalAuth('Approve removing the passkey from your smart account');
    if (!auth.ok) {
      Alert.alert('Not removed', auth.message);
      return;
    }
    setPhase('sending');
    try {
      const { userOpHash } = await removePasskey({
        chain: evmChain.caip2,
        account,
        quote,
        store: AsyncStorage,
        submit: (q) => signWith(EVM_CHAIN_ID, owner, (signer) => sendAa(bundle, signer, q)),
      });
      setPendingRemove(null);
      setProgress({ kind: 'remove', userOpHash, state: 'pending', txHash: null, detail: null });
      setPhase('progress');
      void finalizePasskeyRemove(bundle, evmChain.caip2, account, userOpHash, AsyncStorage).then(
        ({ receipt, status: st, forgotten }) =>
          setProgress((prev) =>
            prev && prev.userOpHash === userOpHash
              ? {
                  ...prev,
                  state: receipt.success === false ? 'failed' : 'done',
                  txHash: receipt.txHash,
                  detail: forgotten ? `Removed; the passkey details were deleted from this device. ${PASSKEY_OS_CLEANUP_NOTE}` : passkeyStatusText(st),
                }
              : prev,
          ),
        () => setProgress((prev) => (prev && prev.userOpHash === userOpHash ? { ...prev, state: 'timeout' } : prev)),
      );
    } catch (e) {
      Alert.alert('Not removed', describe(e));
      setPhase('confirm-remove');
    }
  };

  const onResetList = () => {
    Alert.alert(
      'Reset the saved passkey details?',
      'This only clears what this device remembers. Passkeys installed in your smart accounts stay installed; ' +
        'remove them on this screen first if you no longer want them.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Reset', style: 'destructive', onPress: () => void resetPasskeys().then(reloadStatus, reloadStatus) },
      ],
    );
  };

  // ------------------------------------------------------------ render

  const header = (
    <>
      <Text style={[styles.networkLine, { color: theme.textMuted }]}>
        {evmChain.label}
        {evmChain.testnet ? ' · TESTNET' : ''} · chain id {evmChain.chainIdDecimal}
      </Text>
      <Row label="Owner account (adds and removes the passkey)" value={activeAccount?.name ?? 'Account'} sub={owner} theme={theme} />
      {account ? <Row label="Kernel smart account (address unchanged)" value={account} mono theme={theme} /> : null}
    </>
  );

  if (phase === 'progress' && progress) {
    const what = progress.kind === 'install' ? 'Passkey install' : progress.kind === 'remove' ? 'Passkey removal' : 'Passkey test operation';
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <Text style={[styles.title, { color: theme.success }]}>{what} sent to the bundler</Text>
        <Text style={[styles.label, { color: theme.textMuted }]}>UserOperation hash</Text>
        <Text selectable style={[styles.monoText, { color: theme.text }]}>{progress.userOpHash}</Text>
        {progress.kind === 'test' ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>Signed by the passkey only; your recovery phrase was not used.</Text>
        ) : null}
        {progress.state === 'pending' ? (
          <View style={styles.center}>
            <ActivityIndicator color={theme.accent} />
            <Text style={[styles.hint, { color: theme.textMuted }]}>Bundling… waiting for the receipt.</Text>
          </View>
        ) : null}
        {progress.state === 'done' ? (
          <Text style={[styles.ok, { color: theme.success }]}>
            Included on-chain — succeeded.{progress.detail ? ` ${progress.detail}.` : ''}
          </Text>
        ) : null}
        {progress.state === 'failed' ? (
          <WarningBox>Included, but the operation reverted.{progress.detail ? ` ${progress.detail}.` : ''}</WarningBox>
        ) : null}
        {progress.state === 'timeout' ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            Not included within two minutes. It may still be included; this screen reads the status from the chain.
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
            setPhase('main');
            reloadStatus();
          }}
        />
      </ScrollView>
    );
  }

  const feeRows = (q: AaSendQuote) => (
    <>
      <Row
        label={q.sponsored ? 'Network fee' : 'Max network fee (bundler estimate)'}
        value={q.sponsored ? 'Sponsored — the account pays 0' : `${formatUnits(q.fee, 18, 18)} ${symbol}`}
        theme={theme}
      />
      <Row label="Smart account balance" value={`${formatUnits(q.senderBalance, 18, 18)} ${symbol}`} theme={theme} />
      <Text style={[styles.ok, { color: theme.success }]}>Bundler gas estimate passed (eth_estimateUserOperationGas).</Text>
    </>
  );

  const busy = (
    <View style={styles.center}>
      <ActivityIndicator size="large" color={theme.accent} />
      <Text style={[styles.hint, { color: theme.textMuted }]}>Signing and sending…</Text>
    </View>
  );

  if ((phase === 'confirm-install' || (phase === 'sending' && pendingInstall)) && pendingInstall) {
    const { registration, plan } = pendingInstall;
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <NetworkBadge label={evmChain.label} testnet={evmChain.testnet} theme={theme} />
        <Text style={[styles.title, { color: theme.text }]}>Add this passkey to your smart account?</Text>
        {header}
        <Text style={[styles.hint, { color: theme.text }]}>{PASSKEY_EXPLANATION}</Text>
        <WarningBox>{PASSKEY_SELF_CALL_RISK}</WarningBox>
        {!evmChain.testnet ? <WarningBox>{PASSKEY_AUDIT_NOTE}</WarningBox> : null}
        <Row label="Passkey public key (P-256)" value={`x ${short('0x' + registration.publicKey.x.toString(16).padStart(64, '0'))}`} mono theme={theme} />
        <Row label="Credential id" value={registration.credentialIdB64} mono theme={theme} />
        <Row
          label="Validator module"
          value={KERNEL_WEBAUTHN_VALIDATOR.address}
          sub={`ZeroDev WebAuthnValidator v${KERNEL_WEBAUTHN_VALIDATOR.version} (code verified on this chain)`}
          mono
          theme={theme}
        />
        <Row
          label="Signature check"
          value={plan.usePrecompiled ? 'P-256 precompile (0x100) on this chain' : 'Daimo P-256 verifier contract (no precompile here)'}
          sub={plan.usePrecompiled ? null : 'Each passkey operation then costs roughly 315,000 more gas.'}
          theme={theme}
        />
        {registration.backupEligible ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            Your phone may sync this passkey to your other devices (iCloud Keychain / Google Password Manager); any
            device that has it can sign for the smart account.
          </Text>
        ) : null}
        <Row
          label="Install operation"
          value={`1 call to your own account (installModule), 0 ${symbol}`}
          sub="Signed by your account key (recovery phrase) as the account's root validator."
          theme={theme}
        />
        {feeRows(plan.quote)}
        {phase === 'sending' ? (
          busy
        ) : (
          <>
            <Button title="Add passkey" onPress={() => void onInstall()} />
            <Button
              title="Cancel"
              variant="secondary"
              onPress={() => {
                setPendingInstall(null);
                setActionError(PASSKEY_OS_CLEANUP_NOTE);
                setPhase('main');
              }}
            />
          </>
        )}
      </ScrollView>
    );
  }

  if ((phase === 'confirm-test' || (phase === 'sending' && pendingTest)) && pendingTest) {
    const q = pendingTest.quote;
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <NetworkBadge label={evmChain.label} testnet={evmChain.testnet} theme={theme} />
        <Text style={[styles.title, { color: theme.text }]}>Test the passkey</Text>
        {header}
        <Row
          label="Test operation"
          value={`A call with 0 ${symbol} and no data to your owner address`}
          sub={`${q.to} — a call to the smart account itself is refused by design.`}
          theme={theme}
        />
        <Row label="Signer" value="This phone's passkey (platform prompt follows)" sub="Your recovery phrase is not used." theme={theme} />
        {feeRows(q)}
        {phase === 'sending' ? (
          busy
        ) : (
          <>
            <Button title="Sign with passkey and send" onPress={() => void onTest()} />
            <Button
              title="Back"
              variant="secondary"
              onPress={() => {
                setPendingTest(null);
                setPhase('main');
              }}
            />
          </>
        )}
      </ScrollView>
    );
  }

  if ((phase === 'confirm-remove' || (phase === 'sending' && pendingRemove)) && pendingRemove) {
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <NetworkBadge label={evmChain.label} testnet={evmChain.testnet} theme={theme} />
        <Text style={[styles.title, { color: theme.text }]}>Remove the passkey</Text>
        {header}
        <Row
          label="Operation"
          value="2 calls to your own account: uninstallValidation for the passkey validator, then revoke its access"
          sub="Signed by your account key (recovery phrase). Afterwards the passkey can no longer sign for this account."
          theme={theme}
        />
        {feeRows(pendingRemove)}
        {phase === 'sending' ? (
          busy
        ) : (
          <>
            <Button title="Remove passkey" variant="destructive" onPress={() => void onRemove()} />
            <Button
              title="Back"
              variant="secondary"
              onPress={() => {
                setPendingRemove(null);
                setPhase('main');
              }}
            />
          </>
        )}
      </ScrollView>
    );
  }

  const installedHere = status?.kind === 'active' && record?.localStatus === 'installed';
  const somethingOnChain = status?.kind === 'active' || status?.kind === 'other' || status?.kind === 'partial';
  return (
    <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
      {readiness ? <TestNetworksOnlyCard feature={readiness.feature} hint={readiness.hint} /> : null}
      <Text style={[styles.title, { color: theme.text }]}>Passkey (device biometrics signer)</Text>
      <Text style={[styles.hint, { color: theme.text }]}>{PASSKEY_EXPLANATION}</Text>
      {gate && !gate.ok ? <WarningBox>{gate.reason}</WarningBox> : null}
      {header}
      <WarningBox>{PASSKEY_SELF_CALL_RISK}</WarningBox>
      <Text style={[styles.hint, { color: theme.textMuted }]}>{PASSKEY_AUDIT_NOTE}</Text>
      {!owner ? <Text style={[styles.error, { color: theme.danger }]}>No Ethereum address for this account.</Text> : null}
      {setupError ? <Text style={[styles.error, { color: theme.danger }]}>{setupError}</Text> : null}
      {resolution === null && !setupError && owner ? <ActivityIndicator color={theme.accent} /> : null}
      {resolution && !resolution.ok ? <WarningBox>{resolution.reason}</WarningBox> : null}
      {actionError ? <WarningBox>{actionError}</WarningBox> : null}
      {phase === 'registering' || phase === 'quoting' ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.accent} />
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            {phase === 'registering' ? 'Waiting for the passkey prompt…' : 'Reading the account and asking the bundler…'}
          </Text>
        </View>
      ) : null}
      {resolution?.ok && phase === 'main' ? (
        <>
          <Text style={[styles.sectionTitle, { color: theme.text }]}>Status</Text>
          <Text style={[styles.status, { color: installedHere ? theme.success : theme.text }]}>
            {status ? passkeyStatusText(status) : 'Reading status…'}
          </Text>
          {record ? (
            <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
              <Row label="Credential id" value={record.credentialId} mono theme={theme} />
              <Row label="Relying party (rpId)" value={record.rpId} theme={theme} />
              <Row
                label="Added"
                value={new Date(record.createdAt).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}
                sub={`Local state: ${record.localStatus}${record.usePrecompiled ? ' · P-256 precompile' : ' · Daimo verifier'}`}
                theme={theme}
              />
            </View>
          ) : null}
          {status?.kind === 'none' ? (
            <Button title="Add passkey" onPress={() => void onAdd()} disabled={!gate?.ok || !native || readiness !== null} />
          ) : null}
          {installedHere ? (
            <Button title="Test passkey" variant="secondary" onPress={() => void onTestQuote()} disabled={!gate?.ok || !native || readiness !== null} />
          ) : null}
          {somethingOnChain ? <Button title="Remove passkey" variant="destructive" onPress={() => void onRemoveQuote()} /> : null}
          <Text style={[styles.hint, { color: theme.textMuted }]}>{PASSKEY_WIPE_NOTE}</Text>
          <Button title="Refresh status" variant="secondary" onPress={reloadStatus} />
          <Button title="Reset saved passkey details" variant="secondary" onPress={onResetList} />
        </>
      ) : null}
    </ScrollView>
  );
}

/**
 * The active account's passkey context: its AA bundle (from the verified
 * configuration, with the owner so an EIP-7702-upgraded account is
 * recognised and refused) and whether a passkey can live there.
 */
async function loadPasskeyContext(
  owner: string,
  accountIndex: number,
  caip2: string,
  chainId: bigint,
): Promise<{ bundle: AaClientBundle | null; resolution: PasskeyAccountResolution }> {
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
        reason: `${e instanceof Error ? e.message : String(e)} Passkeys need a verified bundler and a deployed Kernel v3.3 account.`,
      },
    };
  }
  return { bundle, resolution: await resolvePasskeyAccount(bundle, owner) };
}

function NetworkBadge({ label, testnet, theme }: { label: string; testnet: boolean; theme: Theme }) {
  if (testnet) {
    return (
      <View style={[styles.badge, { backgroundColor: theme.testnetFill, borderColor: theme.testnetFill }]}>
        <Text style={[styles.badgeText, { color: theme.onTestnetFill }]}>{label} TESTNET — test funds only</Text>
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
  badge: { borderWidth: 1, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 12 },
  badgeText: { fontSize: 13, fontWeight: '700', textAlign: 'center' },
  row: { borderBottomWidth: StyleSheet.hairlineWidth, paddingBottom: 8, gap: 2 },
  rowLabel: { fontSize: 12, fontWeight: '600' },
  rowValue: { fontSize: 15 },
  rowSub: { fontSize: 12, lineHeight: 17 },
});
