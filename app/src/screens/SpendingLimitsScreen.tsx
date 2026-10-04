import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Platform, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { FungibleAsset } from '@shiba-wallet/core';
import type { RootStackParamList } from '../navigation';
import { Button, WarningBox, screenStyle } from '../components';
import { useTheme } from '../theme';
import { useWallet } from '../wallet/WalletContext';
import { usePrefs } from '../wallet/PrefsContext';
import { EVM_CHAIN_ID } from '../wallet/send';
import { listTokens } from '../wallet/tokens';
import { formatUnits, parseUnits } from '../wallet/balances';
import { evmProfileByCaip2 } from '../config/evm-chain';
import {
  NATIVE_TOKEN,
  SPENDING_HONESTY_SENTENCE,
  SPENDING_NO_ONCHAIN_NOTE,
  SPENDING_NOT_COUNTED_BEFORE_NOTE,
  SPENDING_SCREEN_EXPLAINER,
  WINDOW_PRESETS,
  listSpendingPolicies,
  listSpendingScopes,
  parseCustomWindow,
  policySummary,
  removeSpendingPolicy,
  resetSpendingLimits,
  saveSpendingPolicy,
  spendingHistoryDamaged,
  spendingReadouts,
  spendingTokenOptions,
  spentReadoutText,
  windowLabel,
  type SpendingPolicy,
  type SpendingReadout,
  type SpendingScope,
  type WindowUnit,
} from '../wallet/spending-policy';

type Props = NativeStackScreenProps<RootStackParamList, 'SpendingLimits'>;

const UNITS: WindowUnit[] = ['minutes', 'hours', 'days'];

/**
 * Spending limits (phase 12 item 3): per-token caps over a rolling window
 * for the ACTIVE account on the ACTIVE EVM network, checked by this app
 * before it signs (wallet/spending-policy.ts). Every surface carries the
 * honesty sentence: nothing on-chain enforces these limits.
 */
export function SpendingLimitsScreen({ navigation }: Props) {
  const theme = useTheme();
  const { accounts, activeAccount } = useWallet();
  const { evmChain, hideAmounts } = usePrefs();
  const owner = accounts.find((a) => a.chainId === EVM_CHAIN_ID)?.address ?? null;
  const scope = useMemo<SpendingScope | null>(
    () => (owner ? { chain: evmChain.caip2, owner } : null),
    [owner, evmChain.caip2],
  );

  const [tracked, setTracked] = useState<FungibleAsset[]>([]);
  const [readouts, setReadouts] = useState<SpendingReadout[]>([]);
  const [damaged, setDamaged] = useState(false);
  const [elsewhere, setElsewhere] = useState<{ scope: SpendingScope; count: number }[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Form (add or edit)
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [tokenChoice, setTokenChoice] = useState<string>(NATIVE_TOKEN);
  const [capText, setCapText] = useState('');
  const [windowChoice, setWindowChoice] = useState<number | 'custom'>(86400);
  const [customText, setCustomText] = useState('');
  const [customUnit, setCustomUnit] = useState<WindowUnit>('hours');
  const [allowOverride, setAllowOverride] = useState(false);
  const [countFees, setCountFees] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [editingPolicy, setEditingPolicy] = useState<SpendingPolicy | null>(null);
  const options = useMemo(() => {
    const base = spendingTokenOptions(evmChain.caip2, evmChain.displaySymbol, tracked);
    // A limit being edited keeps its token even if that token has since left
    // the tracked list (the token cannot be changed while editing).
    if (editingPolicy && !base.some((o) => o.token === editingPolicy.token)) {
      base.push({
        token: editingPolicy.token,
        symbol: editingPolicy.symbol,
        decimals: editingPolicy.decimals,
        label: `${editingPolicy.symbol} · ${editingPolicy.token.slice(0, 6)}…${editingPolicy.token.slice(-4)}`,
      });
    }
    return base;
  }, [evmChain.caip2, evmChain.displaySymbol, tracked, editingPolicy]);
  const chosen = options.find((o) => o.token === tokenChoice) ?? options[0]!;

  useEffect(() => {
    navigation.setOptions({ title: 'Spending limits' });
  }, [navigation]);

  const reload = useCallback(() => {
    if (!scope) return;
    let cancelled = false;
    Promise.all([
      listTokens().catch(() => [] as FungibleAsset[]),
      spendingReadouts(scope),
      listSpendingPolicies(scope),
      spendingHistoryDamaged(),
      listSpendingScopes(),
    ]).then(
      ([tokens, r, listing, historyDamaged, scopes]) => {
        if (cancelled) return;
        setTracked(tokens);
        setReadouts(r.readouts);
        setDamaged(r.damaged || listing.damaged || historyDamaged || scopes.damaged);
        setElsewhere(
          scopes.scopes.filter(
            (s) => !(s.scope.chain === scope.chain && s.scope.owner.toLowerCase() === scope.owner.toLowerCase()),
          ),
        );
        setLoaded(true);
      },
      () => {
        if (!cancelled) {
          setDamaged(true);
          setLoaded(true);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [scope]);

  useEffect(reload, [reload]);

  const resetForm = () => {
    setFormOpen(false);
    setEditingId(null);
    setEditingPolicy(null);
    setTokenChoice(NATIVE_TOKEN);
    setCapText('');
    setWindowChoice(86400);
    setCustomText('');
    setCustomUnit('hours');
    setAllowOverride(false);
    setCountFees(false);
    setFormError(null);
  };

  const onEdit = (p: SpendingPolicy) => {
    setFormOpen(true);
    setEditingId(p.id);
    setEditingPolicy(p);
    setTokenChoice(p.token);
    setCapText(formatUnits(p.cap, p.decimals, p.decimals));
    const preset = WINDOW_PRESETS.find((w) => w.seconds === p.windowSeconds);
    if (preset) {
      setWindowChoice(preset.seconds);
    } else {
      setWindowChoice('custom');
      if (p.windowSeconds % 86400 === 0) {
        setCustomText(String(p.windowSeconds / 86400));
        setCustomUnit('days');
      } else if (p.windowSeconds % 3600 === 0) {
        setCustomText(String(p.windowSeconds / 3600));
        setCustomUnit('hours');
      } else {
        setCustomText(String(Math.round(p.windowSeconds / 60)));
        setCustomUnit('minutes');
      }
    }
    setAllowOverride(p.allowOverride);
    setCountFees(p.countFees);
    setFormError(null);
  };

  const onSave = async () => {
    if (!scope) return;
    setFormError(null);
    let cap: bigint;
    try {
      cap = parseUnits(capText.trim(), chosen.decimals);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Enter the limit as a number.');
      return;
    }
    if (cap <= 0n) {
      setFormError('Enter a limit above zero.');
      return;
    }
    let windowSeconds: number;
    try {
      windowSeconds = windowChoice === 'custom' ? parseCustomWindow(customText, customUnit) : windowChoice;
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Choose a time window.');
      return;
    }
    setBusy(true);
    try {
      await saveSpendingPolicy(
        scope,
        {
          ...(editingId ? { id: editingId } : {}),
          token: chosen.token,
          symbol: chosen.symbol,
          decimals: chosen.decimals,
          cap,
          windowSeconds,
          allowOverride,
          countFees: chosen.token === NATIVE_TOKEN ? countFees : false,
        },
        options.map((o) => o.token),
      );
      resetForm();
      reload();
    } catch (e) {
      setFormError(`Not saved: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const onRemove = (p: SpendingPolicy) => {
    if (!scope) return;
    Alert.alert(
      `Remove the ${p.symbol} limit?`,
      `${policySummary(p, false)}. Sends of ${p.symbol} from this account on ${evmChain.label} will no ` +
        'longer be checked against it, and its spending record is deleted.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            try {
              await removeSpendingPolicy(scope, p.id);
            } catch (e) {
              Alert.alert('Not removed', e instanceof Error ? e.message : String(e));
            }
            if (editingId === p.id) resetForm();
            reload();
          },
        },
      ],
    );
  };

  const onReset = () => {
    Alert.alert(
      'Reset spending limits?',
      'The saved spending limits or their record could not be read. Resetting deletes every ' +
        'limit and every recorded send on all accounts and networks. Until then, this app does ' +
        'not sign sends from accounts it cannot check.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: async () => {
            await resetSpendingLimits();
            reload();
          },
        },
      ],
    );
  };

  const inputStyle = [
    styles.input,
    { color: theme.text, borderColor: theme.border, backgroundColor: theme.card },
  ];

  if (!scope) {
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <Text style={[styles.body, { color: theme.text }]}>No Ethereum account is loaded.</Text>
      </ScrollView>
    );
  }

  return (
    <ScrollView
      style={screenStyle(theme)}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={[styles.networkLine, { color: theme.textMuted }]}>
        {activeAccount ? `${activeAccount.name} · ` : ''}
        {owner!.slice(0, 6)}…{owner!.slice(-4)} · {evmChain.label}
      </Text>

      <WarningBox>{SPENDING_HONESTY_SENTENCE}</WarningBox>
      <Text style={[styles.hint, { color: theme.textMuted }]}>{SPENDING_SCREEN_EXPLAINER}</Text>
      <Text style={[styles.hint, { color: theme.textMuted }]}>{SPENDING_NO_ONCHAIN_NOTE}</Text>

      {damaged ? (
        <View style={styles.block}>
          <WarningBox>
            The saved spending limits or their record could not be read. Until they are reset, this
            app does not sign sends from an account and network it cannot check.
          </WarningBox>
          <Button title="Reset spending limits" variant="destructive" onPress={onReset} />
        </View>
      ) : null}

      <Text style={[styles.sectionTitle, { color: theme.text }]}>Limits on {evmChain.label}</Text>
      {loaded && readouts.length === 0 && !damaged ? (
        <Text style={[styles.body, { color: theme.textMuted }]}>
          No spending limits for this account on this network.
        </Text>
      ) : null}
      {readouts.map((r) => (
        <View
          key={r.policy.id}
          style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}
        >
          <Text style={[styles.cardTitle, { color: theme.text }]}>{policySummary(r.policy, hideAmounts)}</Text>
          <Text style={[styles.body, { color: theme.text }]}>{spentReadoutText(r, hideAmounts)}</Text>
          {r.policy.token !== NATIVE_TOKEN ? (
            <Text style={[styles.mono, { color: theme.textMuted }]}>Token contract {r.policy.token}</Text>
          ) : null}
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            {r.policy.allowOverride
              ? '“Send anyway” is allowed (after your device check).'
              : 'No “Send anyway”: sends over the limit are refused.'}
            {r.policy.token === NATIVE_TOKEN
              ? r.policy.countFees
                ? ' Network fees are counted.'
                : ' Network fees are not counted.'
              : ''}
          </Text>
          <View style={styles.choiceRow}>
            <Button title="Edit" variant="secondary" onPress={() => onEdit(r.policy)} style={styles.choiceButton} />
            <Button
              title="Remove"
              variant="secondary"
              onPress={() => onRemove(r.policy)}
              style={styles.choiceButton}
            />
          </View>
        </View>
      ))}
      <Text style={[styles.hint, { color: theme.textMuted }]}>{SPENDING_NOT_COUNTED_BEFORE_NOTE}</Text>

      {formOpen ? (
        <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <Text style={[styles.cardTitle, { color: theme.text }]}>
            {editingId ? 'Edit limit' : 'New limit'}
          </Text>

          <Text style={[styles.label, { color: theme.textMuted }]}>Token</Text>
          <View style={styles.choiceRow}>
            {options.map((o) => (
              <Button
                key={o.token}
                title={o.token === chosen.token ? `✓ ${o.label}` : o.label}
                variant={o.token === chosen.token ? 'primary' : 'secondary'}
                selected={o.token === chosen.token}
                disabled={editingId !== null && o.token !== chosen.token}
                onPress={() => {
                  setTokenChoice(o.token);
                  setFormError(null);
                }}
                style={styles.choiceButton}
              />
            ))}
          </View>

          <Text style={[styles.label, { color: theme.textMuted }]}>Limit ({chosen.symbol})</Text>
          <TextInput
            style={inputStyle}
            value={capText}
            onChangeText={(t) => {
              setCapText(t);
              setFormError(null);
            }}
            placeholder={`Maximum ${chosen.symbol} per window`}
            placeholderTextColor={theme.textMuted}
            keyboardType="decimal-pad"
            accessibilityLabel={`Limit in ${chosen.symbol}`}
          />

          <Text style={[styles.label, { color: theme.textMuted }]}>Time window</Text>
          <View style={styles.choiceRow}>
            {WINDOW_PRESETS.map((w) => (
              <Button
                key={w.seconds}
                title={windowChoice === w.seconds ? `✓ ${w.label}` : w.label}
                variant={windowChoice === w.seconds ? 'primary' : 'secondary'}
                selected={windowChoice === w.seconds}
                onPress={() => setWindowChoice(w.seconds)}
                style={styles.choiceButton}
              />
            ))}
            <Button
              title={windowChoice === 'custom' ? '✓ Custom' : 'Custom'}
              variant={windowChoice === 'custom' ? 'primary' : 'secondary'}
              selected={windowChoice === 'custom'}
              onPress={() => setWindowChoice('custom')}
              style={styles.choiceButton}
            />
          </View>
          {windowChoice === 'custom' ? (
            <>
              <TextInput
                style={inputStyle}
                value={customText}
                onChangeText={(t) => {
                  setCustomText(t);
                  setFormError(null);
                }}
                placeholder="Number"
                placeholderTextColor={theme.textMuted}
                keyboardType="number-pad"
                accessibilityLabel={`Custom window length in ${customUnit}`}
              />
              <View style={styles.choiceRow}>
                {UNITS.map((u) => (
                  <Button
                    key={u}
                    title={customUnit === u ? `✓ ${u}` : u}
                    variant={customUnit === u ? 'primary' : 'secondary'}
                    selected={customUnit === u}
                    onPress={() => setCustomUnit(u)}
                    style={styles.choiceButton}
                  />
                ))}
              </View>
              <Text style={[styles.hint, { color: theme.textMuted }]}>
                Between 1 minute and 366 days. The window rolls: a send counts until this much
                time has passed since it was sent.
              </Text>
            </>
          ) : (
            <Text style={[styles.hint, { color: theme.textMuted }]}>
              The window rolls: a send counts for {windowLabel(windowChoice)} after it was sent.
            </Text>
          )}

          <View style={styles.switchRow}>
            <Switch
              value={allowOverride}
              onValueChange={setAllowOverride}
              accessibilityLabel="Allow Send anyway when this limit is reached"
            />
            <Text style={[styles.switchLabel, { color: theme.text }]}>
              Allow “Send anyway” when this limit is reached (still asks for your device check).
              Off: sends over the limit are refused.
            </Text>
          </View>
          {chosen.token === NATIVE_TOKEN ? (
            <View style={styles.switchRow}>
              <Switch
                value={countFees}
                onValueChange={setCountFees}
                accessibilityLabel="Count network fees in this limit"
              />
              <Text style={[styles.switchLabel, { color: theme.text }]}>
                Count network fees too (the worst-case fee of each send). Off: only amounts sent
                count.
              </Text>
            </View>
          ) : null}

          {formError ? <Text style={[styles.error, { color: theme.danger }]}>{formError}</Text> : null}
          <Text style={[styles.hint, { color: theme.textMuted }]}>{SPENDING_HONESTY_SENTENCE}</Text>
          <Button
            title={busy ? 'Saving…' : editingId ? 'Save changes' : 'Save limit'}
            onPress={() => void onSave()}
            disabled={busy || damaged}
          />
          <Button title="Cancel" variant="secondary" onPress={resetForm} />
        </View>
      ) : (
        <Button
          title="Add a spending limit"
          onPress={() => {
            resetForm();
            setFormOpen(true);
          }}
          disabled={damaged || !loaded}
        />
      )}

      {elsewhere.length > 0 ? (
        <>
          <Text style={[styles.sectionTitle, { color: theme.text }]}>Limits elsewhere</Text>
          {elsewhere.map((s) => (
            <Text key={`${s.scope.chain}|${s.scope.owner}`} style={[styles.body, { color: theme.text }]}>
              {s.scope.owner.slice(0, 6)}…{s.scope.owner.slice(-4)} on{' '}
              {evmProfileByCaip2(s.scope.chain)?.label ?? s.scope.chain}: {s.count} limit
              {s.count === 1 ? '' : 's'}
            </Text>
          ))}
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            Switch to that account and network to see or change them.
          </Text>
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 24,
    gap: 14,
  },
  networkLine: {
    fontSize: 13,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: '600',
    marginTop: 8,
  },
  block: {
    gap: 10,
  },
  card: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    gap: 8,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '600',
  },
  body: {
    fontSize: 15,
    lineHeight: 21,
  },
  hint: {
    fontSize: 13,
    lineHeight: 18,
  },
  mono: {
    fontSize: 12,
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    marginTop: 4,
  },
  input: {
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 12,
    paddingHorizontal: 14,
    fontSize: 15,
  },
  choiceRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  choiceButton: {
    paddingHorizontal: 16,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  switchLabel: {
    flex: 1,
    fontSize: 14,
    lineHeight: 19,
  },
  error: {
    fontSize: 13,
    lineHeight: 18,
  },
});
