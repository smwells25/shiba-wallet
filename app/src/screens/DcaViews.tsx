import React from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, View } from 'react-native';
import { describePeriod, type DcaTerms, type SessionKeyGrant } from '@shiba-wallet/chains-evm';
import { Button, WarningBox, useFieldLabels, HiddenFieldLabel } from '../components';
import { GrantReview } from '../components/SessionGrantViews';
import { useTheme } from '../theme';
import { formatUnits } from '../wallet/balances';
import type { AaSendQuote } from '../wallet/aa';
import {
  SUBSCRIPTION_MAX_PAYMENTS,
  SUBSCRIPTION_MAX_PERIOD_SECONDS,
  SUBSCRIPTION_PERIOD_UNITS,
  SUBSCRIPTION_REQUOTE_FEE_TOLERANCE_PERCENT,
  cardShowsBatchingWarning,
  customPeriodSeconds,
  feeBudgetPlaceholder,
  feeBudgetTooSmallWarning,
  formFeeHintShown,
  permissionIdAtStartNote,
  subscriptionMinPeriodSeconds,
  subscriptionPeriodPresets,
  withSubscriptionFeeCeiling,
  type SubscriptionFeeSource,
} from '../wallet/subscriptions';
import {
  SESSIONS_INSTALL_MODE_NOTE,
  pendingSessionOperation,
  sessionLocalStatusText,
  sessionStatusText,
  type SessionChainStatus,
  type SessionRecord,
} from '../wallet/sessions';
import type { RecurringDue } from '../wallet/recurring';
import {
  DCA_AUDIT_NOTE,
  DCA_CARD_NOTE,
  DCA_COMPLETED_TEXT,
  DCA_FORM_INTRO,
  DCA_INSTALL_PADDING_NOTE,
  DCA_KEY_HOLDER_TEXT,
  DCA_PAY_PROMPT_NOTE,
  DCA_SPENDING_NOTE,
  DCA_START_NOTE,
  DCA_SWAP_GAS_ALLOWANCE,
  DCA_WHILE_OPEN_NOTE,
  dcaFeeBudgetHint,
  dcaFeeBudgetPricingNote,
  dcaFeeBudgetFormNote,
  dcaInstallFunding,
  dcaKeyStatusText,
  dcaLastSwapLines,
  dcaMarketLines,
  dcaReview,
  dcaSetupCostNote,
  dcaSetupFundingWarning,
  dcaShortWindowWarning,
  dcaStatusLines,
  dcaSummary,
} from '../wallet/dca';
import { dcaTermsOf } from '../wallet/sessions';

/**
 * The recurring-swap (dollar-cost averaging) views of the Sessions screen
 * (phase 19 item 2): the form, the review and the card. Presentational only:
 * every action is the Sessions screen's (SessionsScreen.tsx), and every
 * sentence comes from ../wallet/dca.ts (the engine's describeDca and DCA_*
 * refusals verbatim, arranged in the design note's order).
 */

export interface DcaFormState {
  /** Decimal test ETH sold per swap. */
  amount: string;
  /** The minimum as a percentage of the quote at review (default 95). */
  floorPercent: string;
  periodSeconds: number;
  periodCustom: boolean;
  customCount: string;
  customUnit: number;
  count: string;
  feeBudget: string;
  /** True once the user typed a fee budget (until then the suggestion follows the number of swaps). */
  feeEdited: boolean;
  label: string;
}

export function DcaFormView(props: {
  header: React.ReactNode;
  form: DcaFormState;
  setForm: (update: (prev: DcaFormState) => DcaFormState) => void;
  testnet: boolean;
  symbol: string;
  account: string;
  feeBudgetText: string;
  /** The unedited suggestion behind feeBudgetText (subscriptions.ts suggestedFeeBudget) and the set-up fee kept back. */
  feeSuggestion: { capped: boolean; spare: bigint | null; uncapped: bigint | null };
  installKeptBack: bigint | null;
  feeFacts: { maxFeePerGas: bigint | null; feeSource: SubscriptionFeeSource | null; balance: bigint | null; deposit: bigint | null };
  /** The last live quote for the amount typed (null before one was read). */
  quote: { amountIn: bigint; amountOut: bigint } | null;
  quoteError: string | null;
  quoting: boolean;
  floorBps: number | null;
  error: string | null;
  busy: boolean;
  onQuote: () => void;
  onReview: () => void;
  onCancel: () => void;
}) {
  const theme = useTheme();
  const field = useFieldLabels();
  const { form, setForm } = props;
  const custom = customPeriodSeconds(form.customCount, form.customUnit, props.testnet);
  const customHint = custom.ok
    ? `One swap at most every ${describePeriod(custom.seconds)}.`
    : form.customCount.trim() === ''
      ? `From ${describePeriod(subscriptionMinPeriodSeconds(props.testnet))} to ${describePeriod(SUBSCRIPTION_MAX_PERIOD_SECONDS)}.`
      : custom.error;
  const fundingWarning = dcaSetupFundingWarning({
    maxFeePerGas: props.feeFacts.maxFeePerGas,
    balance: props.feeFacts.balance,
    deposit: props.feeFacts.deposit,
    account: props.account,
    nativeSymbol: props.symbol,
  });
  const input = [styles.input, { color: theme.text, borderColor: theme.controlBorder }];
  // Visible labels tied to their fields (pass p20c finding 1).
  const amountField = field('amount', `${props.symbol} to swap each period`);
  const floorField = field('floor', 'Minimum to receive per swap (% of the quote at review)');
  const countField = field('count', `Number of swaps (1–${SUBSCRIPTION_MAX_PAYMENTS}; sets the end date)`);
  const feeField = field('fee-budget', `Fee budget (${props.symbol}, all swaps together)`);
  const nameField = field('name', 'Name (optional)');
  return (
    <>
      <Text accessibilityRole="header" style={[styles.title, { color: theme.text }]}>New recurring swap</Text>
      {props.header}
      <Text style={[styles.hint, { color: theme.textMuted }]}>{DCA_FORM_INTRO}</Text>
      <WarningBox>{DCA_WHILE_OPEN_NOTE}</WarningBox>
      <Text style={[styles.hint, { color: theme.textMuted }]}>{DCA_SPENDING_NOTE}</Text>
      <Text style={[styles.hint, { color: theme.textMuted }]}>{dcaSetupCostNote(props.feeFacts.maxFeePerGas, props.symbol)}</Text>
      {fundingWarning ? <WarningBox>{fundingWarning}</WarningBox> : null}
      <Text {...amountField.label} style={[styles.label, { color: theme.textMuted }]}>{amountField.text}</Text>
      <TextInput
        {...amountField.input}
        value={form.amount}
        onChangeText={(t) => setForm((prev) => ({ ...prev, amount: t }))}
        placeholder={`Amount in ${props.symbol}`}
        placeholderTextColor={theme.textMuted}
        keyboardType="decimal-pad"
        style={input}
      />
      {dcaMarketLines({
        amountIn: props.quote?.amountIn ?? 0n,
        quotedOut: props.quote?.amountOut ?? null,
        floorBps: props.floorBps,
        nativeSymbol: props.symbol,
      }).map((line) => (
        <Text key={line} selectable style={[styles.hint, { color: theme.text }]}>
          {line}
        </Text>
      ))}
      {props.quoteError ? <WarningBox>{props.quoteError}</WarningBox> : null}
      {props.quoting ? (
        <ActivityIndicator color={theme.accent} />
      ) : (
        <Button title="Get a live quote" variant="secondary" onPress={props.onQuote} disabled={props.busy} />
      )}
      <Text {...floorField.label} style={[styles.label, { color: theme.textMuted }]}>{floorField.text}</Text>
      <TextInput
        {...floorField.input}
        value={form.floorPercent}
        onChangeText={(t) => setForm((prev) => ({ ...prev, floorPercent: t }))}
        keyboardType="decimal-pad"
        style={input}
      />
      <Text style={[styles.hint, { color: theme.textMuted }]}>
        The minimum is fixed when you start and never follows the price afterwards. Review reads a fresh quote and
        computes the minimum from it at this percentage.
      </Text>
      <Text style={[styles.label, { color: theme.textMuted }]}>Once every</Text>
      <View style={styles.rowButtons}>
        {subscriptionPeriodPresets(props.testnet).map((p) => {
          const chosen = !form.periodCustom && form.periodSeconds === p.seconds;
          return (
            <Button
              key={p.seconds}
              title={chosen ? `✓ ${p.label}` : p.label}
              variant={chosen ? 'primary' : 'secondary'}
              selected={chosen}
              onPress={() => setForm((prev) => ({ ...prev, periodSeconds: p.seconds, periodCustom: false }))}
            />
          );
        })}
        <Button
          title={form.periodCustom ? '✓ Custom' : 'Custom'}
          variant={form.periodCustom ? 'primary' : 'secondary'}
          selected={form.periodCustom}
          onPress={() => setForm((prev) => ({ ...prev, periodCustom: true }))}
        />
      </View>
      {form.periodCustom ? (
        <>
          <HiddenFieldLabel field={field('custom-period', 'Custom period length')} />
          <TextInput
            {...field('custom-period', 'Custom period length').input}
            value={form.customCount}
            onChangeText={(t) => setForm((prev) => ({ ...prev, customCount: t }))}
            placeholder="How many"
            placeholderTextColor={theme.textMuted}
            keyboardType="number-pad"
            style={input}
          />
          <View style={styles.rowButtons}>
            {SUBSCRIPTION_PERIOD_UNITS.map((u) => (
              <Button
                key={u.seconds}
                title={form.customUnit === u.seconds ? `✓ ${u.label}` : u.label}
                variant={form.customUnit === u.seconds ? 'primary' : 'secondary'}
                selected={form.customUnit === u.seconds}
                onPress={() => setForm((prev) => ({ ...prev, customUnit: u.seconds }))}
              />
            ))}
          </View>
          <Text style={[styles.hint, { color: theme.textMuted }]}>{customHint}</Text>
        </>
      ) : null}
      <Text {...countField.label} style={[styles.label, { color: theme.textMuted }]}>{countField.text}</Text>
      <TextInput
        {...countField.input}
        value={form.count}
        onChangeText={(t) => setForm((prev) => ({ ...prev, count: t }))}
        keyboardType="number-pad"
        style={input}
      />
      <Text {...feeField.label} style={[styles.label, { color: theme.textMuted }]}>{feeField.text}</Text>
      <TextInput
        {...feeField.input}
        value={props.feeBudgetText}
        onChangeText={(t) => setForm((prev) => ({ ...prev, feeBudget: t, feeEdited: t.trim() !== '' }))}
        placeholder={feeBudgetPlaceholder(props.symbol)}
        placeholderTextColor={theme.textMuted}
        keyboardType="decimal-pad"
        style={input}
      />
      <Text style={[styles.hint, { color: theme.textMuted }]}>{dcaFeeBudgetHint(props.symbol)}</Text>
      {/* The suggestion, or the cap note when the account cannot fund the
          usual budget. The cap note is a warning, so it is drawn as one
          (pass p20c finding 17), never in the muted hint grey; while Review's
          refusal is on screen neither is shown, so the shortfall is stated
          once, by the announced refusal below (finding 8). */}
      {formFeeHintShown({ feeEdited: form.feeEdited, formError: props.error })
        ? (() => {
            const note = dcaFeeBudgetFormNote({
              source: props.feeFacts.feeSource,
              suggestion: props.feeSuggestion,
              installKeptBack: props.installKeptBack,
              nativeSymbol: props.symbol,
            });
            return note.warning ? (
              <WarningBox>{note.text}</WarningBox>
            ) : (
              <Text style={[styles.hint, { color: theme.textMuted }]}>{note.text}</Text>
            );
          })()
        : null}
      {props.feeFacts.balance !== null ? (
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          {`The smart account holds ${formatUnits(props.feeFacts.balance, 18, 18)} ${props.symbol}` +
            (props.feeFacts.deposit !== null && props.feeFacts.deposit > 0n
              ? ` plus an EntryPoint deposit of ${formatUnits(props.feeFacts.deposit, 18, 18)} ${props.symbol}`
              : '') +
            ' (read just now).'}
        </Text>
      ) : null}
      <Text {...nameField.label} style={[styles.label, { color: theme.textMuted }]}>{nameField.text}</Text>
      <TextInput
        {...nameField.input}
        value={form.label}
        onChangeText={(t) => setForm((prev) => ({ ...prev, label: t }))}
        placeholder="e.g. weekly USDC"
        placeholderTextColor={theme.textMuted}
        maxLength={64}
        style={input}
      />
      {props.error ? <WarningBox announce>{props.error}</WarningBox> : null}
      {props.busy ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.accent} />
          <Text style={[styles.hint, { color: theme.textMuted }]}>Reading the pool, the account and asking the bundler…</Text>
        </View>
      ) : (
        <>
          <Button title="Review" onPress={props.onReview} />
          <Button title="Cancel" variant="secondary" onPress={props.onCancel} />
        </>
      )}
    </>
  );
}

export function DcaReviewView(props: {
  badge: React.ReactNode;
  header: React.ReactNode;
  terms: DcaTerms;
  grant: SessionKeyGrant;
  quote: AaSendQuote;
  quoteAtReview: bigint;
  floorBps: number;
  account: string;
  symbol: string;
  nameFor: (address: string) => string | null;
  feeBudgetLowered: { from: bigint; to: bigint; keptBack: bigint } | null;
  feePricing: { maxFeePerGas: bigint | null; source: SubscriptionFeeSource | null; edited: boolean };
  sending: boolean;
  sendStage: 'requote' | 'signing';
  onStart: () => void;
  onBack: () => void;
  row: (label: string, value: string, sub?: string | null, monoFont?: boolean) => React.ReactNode;
}) {
  const theme = useTheme();
  const { terms, quote: q, symbol } = props;
  const review = dcaReview(terms, { nativeSymbol: symbol, stage: 'review' });
  const shortWindow = dcaShortWindowWarning(terms);
  const startButton = 'Start recurring swap';
  // The displayed worst case includes Start's re-quote tolerance, and the funding lines use it too.
  const shown = withSubscriptionFeeCeiling(q);
  const funding = dcaInstallFunding(shown, terms, symbol);
  const lowered = props.feeBudgetLowered;
  const [floorCaveat, ...restCaveats] = review.caveats;
  return (
    <>
      {props.badge}
      <Text accessibilityRole="header" style={[styles.title, { color: theme.text }]}>Start this recurring swap?</Text>
      {props.header}
      {/* The design note's order: the batching box, then "THE MINIMUM DOES NOT
          FOLLOW THE PRICE", no deadline, a reverting swap uses up its period,
          ETH left in the router on a partial fill, what the key can do,
          catch-up — before anything else. */}
      <WarningBox>{review.batching}</WarningBox>
      {floorCaveat ? <WarningBox>{floorCaveat}</WarningBox> : null}
      {restCaveats.map((line) => (
        <Text key={line} style={[styles.hint, { color: theme.text }]}>
          {line}
        </Text>
      ))}
      <Text style={[styles.ok, { color: theme.text }]}>{review.sentence}</Text>
      {dcaMarketLines({ amountIn: terms.amountIn, quotedOut: props.quoteAtReview, floorBps: props.floorBps, nativeSymbol: symbol }).map(
        (line) => (
          <Text key={line} selectable style={[styles.hint, { color: theme.text }]}>
            {line}
          </Text>
        ),
      )}
      <Text style={[styles.hint, { color: theme.textMuted }]}>{DCA_START_NOTE}</Text>
      <Text style={[styles.hint, { color: theme.text }]}>{DCA_WHILE_OPEN_NOTE}</Text>
      <Text style={[styles.hint, { color: theme.textMuted }]}>{DCA_PAY_PROMPT_NOTE}</Text>
      <Text style={[styles.hint, { color: theme.textMuted }]}>{DCA_SPENDING_NOTE}</Text>
      {shortWindow ? <WarningBox>{shortWindow}</WarningBox> : null}
      <Text style={[styles.label, { color: theme.textMuted }]}>Your account enforces on-chain:</Text>
      {review.enforced.map((line) => (
        <Text key={line} style={[styles.hint, { color: theme.text }]}>
          • {line}
        </Text>
      ))}
      <Text style={[styles.hint, { color: theme.textMuted }]}>{DCA_AUDIT_NOTE}</Text>
      <Text style={[styles.label, { color: theme.textMuted }]}>Technical details (the grant as installed)</Text>
      <GrantReview
        grant={props.grant}
        account={props.account}
        symbol={symbol}
        nameFor={props.nameFor}
        sessionKeyHolder={DCA_KEY_HOLDER_TEXT}
        permissionId={null}
      />
      <Text style={[styles.hint, { color: theme.textMuted }]}>{permissionIdAtStartNote(startButton)}</Text>
      <Text style={[styles.hint, { color: theme.textMuted }]}>{SESSIONS_INSTALL_MODE_NOTE}</Text>
      {props.row(
        'Set-up operation',
        `2 calls to your own account (installValidations, grantAccess), 0 ${symbol}`,
        "Signed by your account key as the account's root validator.",
      )}
      {props.row(
        q.sponsored ? 'Network fee' : 'Max network fee',
        q.sponsored ? 'Sponsored — the account pays 0' : `${formatUnits(shown.fee, 18, 18)} ${symbol}`,
        q.sponsored
          ? null
          : `The bundler's estimate (${formatUnits(q.fee, 18, 18)} ${symbol}) plus up to ` +
              `${SUBSCRIPTION_REQUOTE_FEE_TOLERANCE_PERCENT}% for the new quote taken when you tap ${startButton} ` +
              '(the clock restarts then). Nothing above this is ever signed; a higher fee brings you back here.',
      )}
      <Text style={[styles.hint, { color: theme.textMuted }]}>{DCA_INSTALL_PADDING_NOTE}</Text>
      <Text style={[styles.hint, { color: theme.textMuted }]}>{dcaSetupCostNote(props.feePricing.maxFeePerGas, symbol)}</Text>
      {props.row('Account balance', `${formatUnits(q.senderBalance, 18, 18)} ${symbol}`)}
      {q.deposit !== undefined && q.deposit > 0n
        ? props.row('EntryPoint deposit (pays fees first)', `${formatUnits(q.deposit, 18, 18)} ${symbol}`)
        : null}
      {funding.depositNote ? <Text style={[styles.hint, { color: theme.textMuted }]}>{funding.depositNote}</Text> : null}
      {lowered ? (
        <WarningBox>
          {`The suggested fee budget was lowered from ${formatUnits(lowered.from, 18, 18)} to ` +
            `${formatUnits(lowered.to, 18, 18)} ${symbol} so that ${formatUnits(lowered.keptBack, 18, 18)} ` +
            `${symbol} stays in the account for this set-up's own worst-case network fee.`}
        </WarningBox>
      ) : null}
      {funding.shortfall ? <WarningBox>{funding.shortfall}</WarningBox> : null}
      {funding.block ? <WarningBox>{funding.block}</WarningBox> : null}
      {(() => {
        const tooSmall = feeBudgetTooSmallWarning({
          feeBudgetWei: terms.feeBudgetWei,
          edited: props.feePricing.edited,
          maxFeePerGas: props.feePricing.maxFeePerGas,
          gasAllowance: DCA_SWAP_GAS_ALLOWANCE,
          nativeSymbol: symbol,
          word: 'swap',
        });
        return tooSmall ? <WarningBox>{tooSmall}</WarningBox> : null;
      })()}
      <Text style={[styles.hint, { color: theme.textMuted }]}>
        {dcaFeeBudgetPricingNote({
          budgetWei: terms.feeBudgetWei,
          count: terms.count,
          maxFeePerGas: props.feePricing.maxFeePerGas,
          source: props.feePricing.source,
          edited: props.feePricing.edited,
          nativeSymbol: symbol,
        })}
      </Text>
      <Text style={[styles.ok, { color: theme.success }]}>
        Bundler gas estimate passed (eth_estimateUserOperationGas simulated the set-up).
      </Text>
      {props.sending ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.accent} />
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            {props.sendStage === 'requote' ? 'Starting the clock now and asking the bundler again…' : 'Signing and sending…'}
          </Text>
        </View>
      ) : (
        <>
          {funding.canStart ? <Button title={startButton} onPress={props.onStart} /> : null}
          <Button title="Back" variant="secondary" onPress={props.onBack} />
        </>
      )}
    </>
  );
}

/** The heading and note above the recurring-swap cards. */
export function DcaListHeading({ count }: { count: number }) {
  const theme = useTheme();
  return (
    <>
      <Text accessibilityRole="header" style={[styles.sectionTitle, { color: theme.text }]}>Recurring swaps</Text>
      <Text style={[styles.hint, { color: theme.textMuted }]}>{count === 0 ? 'None on this device.' : DCA_CARD_NOTE}</Text>
    </>
  );
}

export function DcaCard(props: {
  record: SessionRecord;
  status: SessionChainStatus | 'loading' | undefined;
  due: RecurringDue | null;
  symbol: string;
  attemptLine: string | null;
  swapping: boolean;
  busy: boolean;
  readinessBlocked: boolean;
  onSwapNow: () => void;
  onRefresh: () => void;
  onRevoke: (options?: { forgetAfter?: boolean }) => void;
  onForget: () => void;
  row: (label: string, value: string, sub?: string | null, monoFont?: boolean) => React.ReactNode;
}) {
  const theme = useTheme();
  const { record: r, status, due, symbol } = props;
  const settled = status !== undefined && status !== 'loading';
  const statusLine = settled ? sessionStatusText(status) : 'Reading status…';
  const review = dcaReview(dcaTermsOf(r), { nativeSymbol: symbol, stage: 'set-up' });
  const live = cardShowsBatchingWarning(r, status, due?.kind === 'completed');
  return (
    <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
      <Text accessibilityRole="header" style={[styles.cardTitle, { color: theme.text }]}>{r.label}</Text>
      <Text style={[styles.hint, { color: theme.text }]}>{dcaSummary(r)}</Text>
      <Text style={[styles.status, { color: settled && status.kind === 'active' ? theme.success : theme.text }]}>{statusLine}</Text>
      {due
        ? dcaStatusLines(r, due, symbol, statusLine).map((line) => (
            <Text key={line} style={[styles.hint, { color: theme.text }]}>
              {line}
            </Text>
          ))
        : null}
      {dcaLastSwapLines(r).map((line) => (
        <Text key={line} style={[styles.hint, { color: theme.text }]}>
          {line}
        </Text>
      ))}
      <Text style={[styles.hint, { color: theme.textMuted }]}>{dcaKeyStatusText(r)}</Text>
      <Text style={[styles.hint, { color: theme.textMuted }]}>{sessionLocalStatusText(r)}</Text>
      {pendingSessionOperation(r) || props.swapping ? <ActivityIndicator color={theme.accent} /> : null}
      {props.attemptLine ? <WarningBox>{props.attemptLine}</WarningBox> : null}
      {due?.kind === 'due' ? (
        <Button
          title="Swap now"
          accessibilityHint="Checks the swap with the network and reads a fresh quote, then asks you to confirm before anything is sent."
          onPress={props.onSwapNow}
          disabled={props.busy || props.readinessBlocked}
        />
      ) : null}
      <Button title="Refresh status" variant="secondary" accessibilityLabel={`Refresh the status of ${r.label}`} onPress={props.onRefresh} />
      {live ? <WarningBox>{review.batching}</WarningBox> : null}
      {live && review.caveats[0] ? <WarningBox>{review.caveats[0]}</WarningBox> : null}
      <Text style={[styles.hint, { color: theme.text }]}>{review.sentence}</Text>
      {props.row('Permission id', r.permissionId, null, true)}
      {r.installUserOpHash ? props.row('Set-up UserOperation hash', r.installUserOpHash, null, true) : null}
      {r.revokeUserOpHash ? props.row('Revocation UserOperation hash', r.revokeUserOpHash, null, true) : null}
      {r.dca?.lastSwap ? props.row('Last swap UserOperation hash', r.dca.lastSwap.userOpHash, null, true) : null}
      {due?.kind === 'completed' && settled && status.kind === 'active' ? (
        <>
          <WarningBox>{DCA_COMPLETED_TEXT}</WarningBox>
          <Button title="Revoke and forget" variant="destructive" onPress={() => props.onRevoke({ forgetAfter: true })} disabled={props.busy} />
        </>
      ) : settled && (status.kind === 'active' || status.kind === 'unknown') ? (
        <Button title="Revoke (stop the recurring swap)" variant="destructive" onPress={() => props.onRevoke()} disabled={props.busy} />
      ) : null}
      {settled && (status.kind === 'revoked' || status.kind === 'not-installed') ? (
        <Button title="Forget" variant="secondary" onPress={props.onForget} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center', gap: 10, padding: 12 },
  title: { fontSize: 18, fontWeight: '700' },
  sectionTitle: { fontSize: 16, fontWeight: '700', marginTop: 8 },
  label: { fontSize: 13, fontWeight: '600', marginTop: 4 },
  hint: { fontSize: 13, lineHeight: 19 },
  ok: { fontSize: 15, fontWeight: '600' },
  status: { fontSize: 15, fontWeight: '600' },
  card: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 8 },
  cardTitle: { fontSize: 16, fontWeight: '700' },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  rowButtons: { gap: 8 },
});
