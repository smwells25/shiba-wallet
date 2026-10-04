import React, { useEffect, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../theme';
import { usePrefs } from '../wallet/PrefsContext';
import { requireLocalAuth } from '../wallet/biometric';
import {
  SPENDING_HONESTY_SENTENCE,
  SPENDING_REVIEW_CHECKED_NOTE,
  SPENDING_SECTION_TITLE,
  evaluateBeforeSigning,
  overLimitPreviewLines,
  policySummary,
  spendingInputForQuote,
  spendingReadouts,
  spentReadoutText,
  type Outflow,
  type SpendingCheck,
  type SpendingReadout,
} from '../wallet/spending-policy';
import type { EvmSendQuote } from '../wallet/send';
import type { Erc20SendQuote } from '../wallet/send-erc20';
import type { NftSendQuote } from '../wallet/send-nft';
import type { AaSendQuote } from '../wallet/aa';

/**
 * Screen side of the app-enforced spending policy (wallet/spending-policy.ts).
 *
 * spendingGateForQuote is the one call every EVM confirm step makes AFTER
 * its eth_call (or bundler-estimate) gate and BEFORE its biometric gate. It
 * resolves true when the send may go on to that biometric gate:
 *  - no limit for this account and network, or the send fits: true;
 *  - over a limit: an alert naming the token, the cap, the window and what
 *    is already spent; "Send anyway" is offered only when every exceeded
 *    limit was set up with "allow override" (default off), and the send then
 *    still passes the screen's own biometric gate. On the passkey path,
 *    which has no app-level gate of its own, `authenticateOverride` makes the
 *    override itself ask for the device check;
 *  - stored limits unreadable: an alert and false (fail closed).
 */
export async function spendingGateForQuote(args: {
  chain: string;
  /** The account's own EOA (signer / smart-account owner). */
  owner: string;
  /** The EOA the quote was prepared for (ignored for smart-account quotes). */
  from: string;
  quote: EvmSendQuote | Erc20SendQuote | NftSendQuote | AaSendQuote;
  /** The quote's endpoint, used for the preview simulation. */
  url: string | null;
  /** Outflows the caller knows beyond the calls (the swap's sell amount). */
  quoteOutflows?: Outflow[];
  authenticateOverride?: boolean;
}): Promise<boolean> {
  let check: SpendingCheck;
  try {
    const input = spendingInputForQuote(args.quote, args.from);
    check = await evaluateBeforeSigning({
      scope: { chain: args.chain, owner: args.owner },
      spender: input.spender,
      calls: input.calls,
      fee: input.fee,
      url: args.url,
      ...(args.quoteOutflows ? { quoteOutflows: args.quoteOutflows } : {}),
    });
  } catch (e) {
    Alert.alert(
      'Spending limits could not be checked',
      `Nothing was signed. ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
  return confirmSpendingCheck(check, { authenticateOverride: args.authenticateOverride === true });
}

/** The alert half of the gate (exported for screens that build the check themselves). */
export function confirmSpendingCheck(
  check: SpendingCheck,
  options: { authenticateOverride?: boolean } = {},
): Promise<boolean> {
  if (check.status === 'no-policy' || check.status === 'allowed') return Promise.resolve(true);
  if (check.status === 'unreadable') {
    Alert.alert(check.title, check.message);
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    const buttons: { text: string; style?: 'cancel' | 'destructive'; onPress: () => void }[] = [
      { text: check.overrideAllowed ? 'Cancel' : 'OK', style: 'cancel', onPress: () => resolve(false) },
    ];
    if (check.overrideAllowed) {
      buttons.push({
        text: 'Send anyway',
        style: 'destructive',
        onPress: () => {
          if (!options.authenticateOverride) {
            resolve(true);
            return;
          }
          void requireLocalAuth('Send over your spending limit').then((auth) => {
            if (!auth.ok) Alert.alert('Not sent', auth.message);
            resolve(auth.ok);
          });
        },
      });
    }
    Alert.alert(check.title ?? 'Over your spending limit', check.message ?? '', buttons, {
      cancelable: true,
      onDismiss: () => resolve(false),
    });
  });
}

/**
 * The review line on confirm screens: this account's limits on the active
 * network with what is already spent in each window (masked under Hide
 * amounts), and the honesty sentence. Renders nothing when there is no
 * limit. The decision itself happens when the user confirms.
 *
 * With `quote` and `from` it also looks ahead (finding 12 of the rehearsal):
 * when the quote's own amounts already go over a limit, a warning line says
 * so BEFORE the user taps Send. The look-ahead runs the same evaluation as
 * the gate but without the preview simulation and without staging anything
 * for the recorder; the gate on tap is unchanged.
 */
export function SpendingPolicyNotice({
  owner,
  quote,
  from,
  quoteOutflows,
}: {
  owner: string | null;
  quote?: EvmSendQuote | Erc20SendQuote | NftSendQuote | AaSendQuote | null;
  from?: string | null;
  /** Outflows the gate also counts beyond the calls (the swap's sell amount). */
  quoteOutflows?: Outflow[];
}) {
  const theme = useTheme();
  const { evmChain, hideAmounts } = usePrefs();
  const [readouts, setReadouts] = useState<SpendingReadout[] | null>(null);
  const [damaged, setDamaged] = useState(false);
  const [lookAhead, setLookAhead] = useState<SpendingCheck | null>(null);
  // Callers pass quoteOutflows inline; a string key keeps the effect from
  // re-running on every render.
  const outflowsKey = quoteOutflows ? quoteOutflows.map((o) => `${o.token}:${o.amount}`).join(',') : '';

  useEffect(() => {
    let cancelled = false;
    if (!owner || !quote || !from) return;
    const extra: Outflow[] = outflowsKey
      ? outflowsKey.split(',').map((part) => {
          const [token, amount] = part.split(':');
          return { token: token!, amount: BigInt(amount!) };
        })
      : [];
    const input = spendingInputForQuote(quote, from);
    evaluateBeforeSigning({
      scope: { chain: evmChain.caip2, owner },
      spender: input.spender,
      calls: input.calls,
      fee: input.fee,
      url: null,
      quoteOutflows: extra,
      stage: false,
    }).then(
      (check) => {
        if (!cancelled) setLookAhead(check);
      },
      () => {
        if (!cancelled) setLookAhead(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [owner, quote, from, outflowsKey, evmChain.caip2]);

  useEffect(() => {
    let cancelled = false;
    if (!owner) return;
    spendingReadouts({ chain: evmChain.caip2, owner }).then(
      (r) => {
        if (cancelled) return;
        setReadouts(r.readouts);
        setDamaged(r.damaged);
      },
      () => {
        if (!cancelled) setDamaged(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [owner, evmChain.caip2]);

  if (!owner || (!damaged && (!readouts || readouts.length === 0))) return null;
  return (
    <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
      <Text style={[styles.title, { color: theme.text }]}>{SPENDING_SECTION_TITLE}</Text>
      {damaged ? (
        <Text style={[styles.line, { color: theme.danger }]}>
          Your spending limits could not be read; this send will not be signed until they are
          reset in Settings.
        </Text>
      ) : (
        readouts!.map((r) => (
          <Text key={r.policy.id} style={[styles.line, { color: theme.text }]}>
            {policySummary(r.policy, hideAmounts)}. {spentReadoutText(r, hideAmounts)}.
          </Text>
        ))
      )}
      {lookAhead
        ? overLimitPreviewLines(lookAhead, hideAmounts).map((line) => (
            <Text
              key={line}
              accessibilityLabel={`Warning: ${line}`}
              style={[styles.warning, { color: theme.warningText, backgroundColor: theme.warningSurface, borderColor: theme.warningBorder }]}
            >
              {line}
            </Text>
          ))
        : null}
      <Text style={[styles.muted, { color: theme.textMuted }]}>
        {SPENDING_REVIEW_CHECKED_NOTE} {SPENDING_HONESTY_SENTENCE}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    gap: 6,
  },
  title: {
    fontSize: 15,
    fontWeight: '600',
  },
  line: {
    fontSize: 14,
    lineHeight: 20,
  },
  muted: {
    fontSize: 12,
    lineHeight: 17,
  },
  warning: {
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '700',
    borderWidth: 1,
    borderRadius: 8,
    padding: 8,
  },
});
