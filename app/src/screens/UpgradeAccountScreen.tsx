import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { Button, TestNetworksOnlyCard, WarningBox, screenStyle } from '../components';
import { useTheme, type Theme } from '../theme';
import { useWallet } from '../wallet/WalletContext';
import { usePrefs } from '../wallet/PrefsContext';
import { requireLocalAuth } from '../wallet/biometric';
import { formatUnits } from '../wallet/balances';
import {
  EVM_CHAIN_ID,
  QUOTE_ENDPOINT_CHANGED_TITLE,
  describeSendError,
  quoteEndpointChange,
} from '../wallet/send';
import { getEndpoint, withEndpoint } from '../config/networks';
import { getAaConfig, isEip7702Owner, setAccountEip7702, type AaChainConfig } from '../wallet/aa';
import {
  FOREIGN_DELEGATE_WARNING,
  REVOKE_NOTE,
  SET_CODE_EXECUTION_GAS,
  SET_CODE_NO_SIMULATION_NOTE,
  SET_CODE_WARNING,
  UPGRADE_EXPLANATION,
  UPGRADE_RECEIVE_NOTE,
  WALLET_7702_DELEGATE,
  delegationStatusText,
  prepareSetCodeTx,
  sendSetCodeTx,
  waitForSetCode,
  type SetCodeAction,
  type SetCodeQuote,
} from '../wallet/delegation';
import { useAccountDelegation } from '../wallet/useDelegation';
import { readinessGate } from '../config/readiness';

type Props = NativeStackScreenProps<RootStackParamList, 'UpgradeAccount'>;

type Phase = 'overview' | 'quoting' | 'confirm' | 'sending' | 'success';

const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });

function exact(amount: bigint, decimals: number): string {
  return formatUnits(amount, decimals, decimals);
}

/**
 * "Upgrade this account" (phase 8 item 1, EIP-7702): turns the ACTIVE
 * account's EOA into a Kernel v3.3 smart account at the same address, shows
 * the live delegation status, and undoes it. Two upgrade routes:
 *  - with the next smart-account send (default when a verified bundler
 *    exists): records the owner as 'kernel-7702' for the active chain
 *    (aa.ts setAccountEip7702); nothing is signed here — the next send with
 *    "Send from smart account" on carries the authorization, and its
 *    confirm screen says so;
 *  - now, with a self-sponsored type-0x04 transaction from the EOA
 *    (delegation.ts prepareSetCodeTx / sendSetCodeTx), through the normal
 *    EOA confirm idioms (network badge, fee, biometric gate) but without the
 *    eth_call gate, which cannot show what a set-code transaction does.
 * Revocation is always a self-sponsored type-0x04 transaction whose tuple
 * names the zero address. Every signature happens after requireLocalAuth,
 * through signWith(expectAddress = the EOA), for the pinned delegate or the
 * zero address only, on the active chain only (ADR D6).
 */
export function UpgradeAccountScreen({ navigation }: Props) {
  const theme = useTheme();
  const { accounts, activeAccount, signWith } = useWallet();
  const { evmChain } = usePrefs();
  const address = accounts.find((a) => a.chainId === EVM_CHAIN_ID)?.address ?? null;
  const delegation = useAccountDelegation(address);
  const [config, setConfig] = useState<AaChainConfig | null>(null);
  const [phase, setPhase] = useState<Phase>('overview');
  const [quote, setQuote] = useState<SetCodeQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    txid: string;
    explorerUrl: string | null;
    action: SetCodeAction;
    receipt: 'pending' | 'confirmed' | 'failed' | 'timeout';
  } | null>(null);

  useEffect(() => {
    navigation.setOptions({ title: 'Upgrade this account' });
  }, [navigation]);

  const reloadConfig = useCallback(() => {
    getAaConfig(evmChain.caip2).then(setConfig, () => setConfig(null));
  }, [evmChain.caip2]);
  useEffect(reloadConfig, [reloadConfig]);

  const chainId = BigInt(evmChain.chainIdDecimal);
  const optedIn = config !== null && isEip7702Owner(config, address);
  const bundlerReady = config?.bundlerUrl != null;
  const status = delegation.status;
  const accountName = activeAccount?.name ?? 'This account';
  // Mainnet readiness (config/readiness.ts): the upgrade is test-network
  // only. Status reads, cancelling a pending upgrade and revoking stay
  // available; delegation.ts and aa.ts refuse the upgrade itself too.
  const gate = readinessGate('eip7702-upgrade', evmChain.caip2);

  const onUpgradeWithSend = () => {
    if (!address) return;
    Alert.alert(
      'Upgrade with the next smart-account send?',
      'Nothing is signed now. Your next send with "Send from smart account" turned on will ' +
        'carry the EIP-7702 authorization, and its confirm screen will say so. You can cancel ' +
        'before then.',
      [
        { text: 'Not now', style: 'cancel' },
        {
          text: 'Continue',
          onPress: () => {
            setAccountEip7702(evmChain.caip2, address, true).then(
              (c) => setConfig(c),
              (e: unknown) => Alert.alert('Not saved', e instanceof Error ? e.message : String(e)),
            );
          },
        },
      ],
    );
  };

  const onCancelPending = () => {
    if (!address) return;
    setAccountEip7702(evmChain.caip2, address, false).then(
      (c) => setConfig(c),
      (e: unknown) => Alert.alert('Not saved', e instanceof Error ? e.message : String(e)),
    );
  };

  const onUseUpgraded = () => {
    if (!address) return;
    // The account is already delegated to the wallet's Kernel delegate on
    // chain (for example after a restore): record it so smart-account sends
    // use the account at its own address. Signs nothing.
    setAccountEip7702(evmChain.caip2, address, true).then(
      (c) => setConfig(c),
      (e: unknown) => Alert.alert('Not saved', e instanceof Error ? e.message : String(e)),
    );
  };

  const onQuote = async (action: SetCodeAction) => {
    if (!address || !delegation.url) return;
    setError(null);
    setPhase('quoting');
    try {
      // The endpoint is resolved now and the quote runs through the shared
      // failover rule (config/networks.ts withEndpoint): a failing default
      // is reported and the whole quote is prepared again on the next
      // healthy candidate. The quote records the endpoint that answered
      // (quote.url) and is only ever sent through it.
      const { value: next, switched } = await withEndpoint(EVM_CHAIN_ID, (ep) =>
        prepareSetCodeTx({
          url: ep.url,
          from: address,
          action,
          expectedChainId: chainId,
        }),
      );
      // The status line was read through the endpoint that just failed;
      // read it again through the healthy one.
      if (switched) delegation.refresh();
      setQuote(next);
      setPhase('confirm');
    } catch (e) {
      const { title, detail } = describeSendError(e, evmChain.displaySymbol);
      setError(`${title}\n${detail}`);
      setPhase('overview');
    }
  };

  const onConfirm = async () => {
    if (!quote) return;
    // Quote pinning (same rule as the Send screen): the quote is one
    // endpoint's answer, and useAccountDelegation can move to another
    // endpoint after a failover while this screen is open. Re-resolve just
    // before the biometric gate; if the wallet would now use a different
    // endpoint, refuse and go back for a fresh quote — never patch it.
    let currentUrl: string | null = null;
    try {
      currentUrl = (await getEndpoint(EVM_CHAIN_ID))?.url ?? null;
    } catch {
      currentUrl = null;
    }
    const endpointChanged = quoteEndpointChange(quote.url, currentUrl);
    if (endpointChanged) {
      Alert.alert(QUOTE_ENDPOINT_CHANGED_TITLE, endpointChanged);
      setQuote(null);
      setPhase('overview');
      return;
    }
    // Everything below (signing, broadcast, receipt poll) uses the quote's
    // own endpoint.
    const url = quote.url;
    const auth = await requireLocalAuth(
      quote.action === 'upgrade' ? 'Approve upgrading this account' : 'Approve undoing the upgrade',
    );
    if (!auth.ok) {
      Alert.alert('Not sent', auth.message);
      return;
    }
    setPhase('sending');
    try {
      const sent = await signWith(EVM_CHAIN_ID, quote.from, (signer) =>
        sendSetCodeTx(url, signer, quote, evmChain.explorerTxBase),
      );
      // The transaction is on the network: record the account type for
      // smart-account sends (upgrade → kernel-7702; revoke → back to the
      // chain's factory type).
      const nextConfig = await setAccountEip7702(
        evmChain.caip2,
        quote.from,
        quote.action === 'upgrade',
      ).catch(() => null);
      if (nextConfig) setConfig(nextConfig);
      setResult({ ...sent, action: quote.action, receipt: 'pending' });
      setPhase('success');
      void waitForSetCode(url, sent.txid, quote.from, { chainId }).then(
        ({ success }) =>
          setResult((prev) =>
            prev && prev.txid === sent.txid ? { ...prev, receipt: success ? 'confirmed' : 'failed' } : prev,
          ),
        () =>
          setResult((prev) => (prev && prev.txid === sent.txid ? { ...prev, receipt: 'timeout' } : prev)),
      );
    } catch (e) {
      const { title, detail } = describeSendError(e, evmChain.displaySymbol);
      Alert.alert(title, detail);
      setPhase('confirm');
    }
  };

  if (!address) {
    return (
      <View style={[screenStyle(theme), styles.center]}>
        <Text style={{ color: theme.textMuted }}>No Ethereum address for this account.</Text>
      </View>
    );
  }

  // ------------------------------------------------------------- success
  if (phase === 'success' && result) {
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <Text style={[styles.successTitle, { color: theme.success }]}>Sent ✓</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          {result.action === 'upgrade'
            ? 'Upgrade transaction broadcast. Smart-account sends from this account now use it at its own address.'
            : 'Revocation broadcast. Smart-account sends from this account use the network’s smart-account type again.'}
        </Text>
        <Text style={[styles.label, { color: theme.textMuted }]}>Transaction id</Text>
        <View style={[styles.box, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <Text selectable style={[styles.monoText, { color: theme.text }]}>
            {result.txid}
          </Text>
        </View>
        {result.receipt === 'pending' ? (
          <View style={styles.center}>
            <ActivityIndicator size="small" color={theme.accent} />
            <Text style={[styles.hint, { color: theme.textMuted }]}>Waiting for inclusion…</Text>
          </View>
        ) : null}
        {result.receipt === 'confirmed' ? (
          <Text style={[styles.ok, { color: theme.success }]}>
            Included — status: {status ? delegationStatusText(status) : 're-reading…'}
          </Text>
        ) : null}
        {result.receipt === 'failed' ? (
          <WarningBox>
            The transaction was included but failed. Check the status below before trying again.
          </WarningBox>
        ) : null}
        {result.receipt === 'timeout' ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            Not included within two minutes. It may still be included; the status on the previous
            screen is read from the chain.
          </Text>
        ) : null}
        {result.explorerUrl ? (
          <Button
            title="View on block explorer"
            variant="secondary"
            onPress={() => void Linking.openURL(result.explorerUrl!)}
          />
        ) : null}
        <Button
          title="Done"
          onPress={() => {
            setResult(null);
            setQuote(null);
            setPhase('overview');
            delegation.refresh();
          }}
        />
      </ScrollView>
    );
  }

  // ------------------------------------------------------------- confirm
  if ((phase === 'confirm' || phase === 'sending') && quote) {
    const upgrade = quote.action === 'upgrade';
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <NetworkBadge label={evmChain.label} testnet={evmChain.testnet} theme={theme} />
        <Text style={[styles.title, { color: theme.text }]}>
          {upgrade ? 'Upgrade now with a transaction' : 'Revoke upgrade'}
        </Text>
        {upgrade ? <WarningBox>{SET_CODE_WARNING}</WarningBox> : null}
        <Row label="Account (sends and signs)" value={accountName} sub={quote.from} theme={theme} />
        <Row
          label={upgrade ? 'New code at your address (delegate)' : 'New code at your address'}
          value={upgrade ? quote.delegate : 'None — the delegation is removed (zero address)'}
          mono={upgrade}
          theme={theme}
        />
        <Row label="Current status" value={delegationStatusText(quote.statusBefore)} theme={theme} />
        <Row
          label="Transaction"
          value={`EIP-7702 set-code (type 0x04) to yourself, 0 ${evmChain.displaySymbol}`}
          sub={`Transaction nonce ${quote.nonce}; authorization nonce ${quote.authorizationNonce} (transaction nonce + 1, because you send it yourself); chain id ${quote.chainId}`}
          theme={theme}
        />
        <Row
          label="Max network fee"
          value={`${exact(quote.fee, 18)} ${evmChain.displaySymbol}`}
          sub={`Worst case: ${quote.gasLimit} gas (intrinsic ${quote.gasLimit - SET_CODE_EXECUTION_GAS} incl. 25,000 for the authorization, plus ${SET_CODE_EXECUTION_GAS} for the call) × ${exact(quote.maxFeePerGas, 9)} gwei. Unused gas is refunded.`}
          theme={theme}
        />
        <Row
          label={`Your ${evmChain.displaySymbol} balance`}
          value={`${exact(quote.balance, 18)} ${evmChain.displaySymbol}`}
          theme={theme}
        />
        <Text style={[styles.hint, { color: theme.textMuted }]}>{SET_CODE_NO_SIMULATION_NOTE}</Text>
        {upgrade ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>{UPGRADE_RECEIVE_NOTE}</Text>
        ) : (
          <Text style={[styles.hint, { color: theme.textMuted }]}>{REVOKE_NOTE}</Text>
        )}
        {phase === 'sending' ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={theme.accent} />
            <Text style={[styles.hint, { color: theme.textMuted }]}>Signing and broadcasting…</Text>
          </View>
        ) : (
          <>
            <Button
              title={upgrade ? 'Upgrade account' : 'Revoke upgrade'}
              variant={upgrade ? 'primary' : 'destructive'}
              onPress={() => void onConfirm()}
            />
            <Button title="Back" variant="secondary" onPress={() => setPhase('overview')} />
          </>
        )}
      </ScrollView>
    );
  }

  // ------------------------------------------------------------- overview
  return (
    <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
      <Text style={[styles.networkLine, { color: theme.textMuted }]}>
        {evmChain.label}
        {evmChain.testnet ? ' · TESTNET' : ''} · chain id {evmChain.chainIdDecimal}
      </Text>
      {gate ? <TestNetworksOnlyCard feature={gate.feature} hint={gate.hint} bodyStyle={styles.body} hintStyle={styles.hint} /> : null}
      <Row label="Account" value={accountName} sub={address} theme={theme} />
      <Text style={[styles.body, { color: theme.text }]}>{UPGRADE_EXPLANATION}</Text>
      <Row label="Kernel v3.3 delegate" value={WALLET_7702_DELEGATE} mono theme={theme} />
      <Text style={[styles.hint, { color: theme.textMuted }]}>{UPGRADE_RECEIVE_NOTE}</Text>

      <Text style={[styles.label, { color: theme.textMuted }]}>Current status</Text>
      {delegation.loading ? (
        <ActivityIndicator size="small" color={theme.accent} />
      ) : status === null ? (
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Status unknown: {delegation.error ?? 'not read yet'}
        </Text>
      ) : status.kind === 'other' ? (
        <View style={styles.block}>
          <WarningBox>
            Delegated elsewhere: {status.delegate}. {FOREIGN_DELEGATE_WARNING}
          </WarningBox>
        </View>
      ) : status.kind === 'contract' ? (
        <WarningBox>{delegationStatusText(status)}. The wallet cannot upgrade or revoke it.</WarningBox>
      ) : (
        <Text style={[styles.status, { color: status.kind === 'kernel-v3.3' ? theme.success : theme.text }]}>
          {delegationStatusText(status)}
        </Text>
      )}
      <Button title="Refresh status" variant="secondary" onPress={delegation.refresh} />

      {error ? <Text style={[styles.error, { color: theme.danger }]}>{error}</Text> : null}
      {phase === 'quoting' ? <ActivityIndicator size="small" color={theme.accent} /> : null}

      {status?.kind === 'plain' ? (
        <View style={styles.block}>
          {optedIn ? (
            <>
              <Text style={[styles.body, { color: theme.text }]}>
                Pending: your next send with &quot;Send from smart account&quot; on will carry the
                upgrade. Its confirm screen says so before anything is signed.
              </Text>
              <Button title="Cancel pending upgrade" variant="secondary" onPress={onCancelPending} />
            </>
          ) : (
            <>
              <Button
                title="Upgrade with the next smart-account send"
                onPress={onUpgradeWithSend}
                disabled={!bundlerReady || gate !== null}
              />
              <Text style={[styles.hint, { color: theme.textMuted }]}>
                {bundlerReady
                  ? 'No transaction now: the authorization rides on your next smart-account send ' +
                    'and the bundler includes it. Gas is paid from this account (or a configured ' +
                    'paymaster).'
                  : 'Needs a verified bundler for this network (Settings → Account Abstraction).'}
              </Text>
            </>
          )}
          <Button
            title="Upgrade now with a transaction"
            variant="secondary"
            onPress={() => void onQuote('upgrade')}
            disabled={phase === 'quoting' || !delegation.url || gate !== null}
          />
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            Sends one transaction from this account; it needs a little {evmChain.displaySymbol} for
            gas.
          </Text>
        </View>
      ) : null}

      {status?.kind === 'kernel-v3.3' && !optedIn ? (
        <View style={styles.block}>
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            This account is upgraded on-chain, but smart-account sends do not use it yet on this
            device.
          </Text>
          <Button
            title="Use this upgraded account for smart-account sends"
            variant="secondary"
            onPress={onUseUpgraded}
            disabled={gate !== null}
          />
        </View>
      ) : null}

      {status?.kind === 'kernel-v3.3' || status?.kind === 'other' ? (
        <View style={styles.block}>
          <Text style={[styles.hint, { color: theme.textMuted }]}>{REVOKE_NOTE}</Text>
          <Button
            title="Revoke upgrade"
            variant="destructive"
            onPress={() => void onQuote('revoke')}
            disabled={phase === 'quoting' || !delegation.url}
          />
        </View>
      ) : null}
    </ScrollView>
  );
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
      <Text
        selectable
        style={[styles.rowValue, { color: theme.text }, monoFont ? { fontFamily: mono, fontSize: 13 } : null]}
      >
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
  block: { gap: 8 },
  title: { fontSize: 18, fontWeight: '700' },
  networkLine: { fontSize: 13 },
  body: { fontSize: 15, lineHeight: 22 },
  label: { fontSize: 13, fontWeight: '600', marginTop: 4 },
  hint: { fontSize: 13, lineHeight: 19 },
  status: { fontSize: 16, fontWeight: '600' },
  ok: { fontSize: 15, fontWeight: '600' },
  error: { fontSize: 14, lineHeight: 20 },
  successTitle: { fontSize: 22, fontWeight: '700' },
  box: { borderWidth: 1, borderRadius: 10, padding: 12 },
  monoText: { fontFamily: mono, fontSize: 13 },
  badge: { borderWidth: 1, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 12 },
  badgeText: { fontSize: 13, fontWeight: '700', textAlign: 'center' },
  row: { borderBottomWidth: StyleSheet.hairlineWidth, paddingBottom: 8, gap: 2 },
  rowLabel: { fontSize: 12, fontWeight: '600' },
  rowValue: { fontSize: 15 },
  rowSub: { fontSize: 12, lineHeight: 17 },
});
