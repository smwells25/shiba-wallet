import React, { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { toHex, type AssetChange } from '@shiba-wallet/chains-evm';
import { useTheme } from '../theme';
import { usePrefs } from '../wallet/PrefsContext';
import { useWallet } from '../wallet/WalletContext';
import { listTokens } from '../wallet/tokens';
import { tokensForChain } from '../wallet/approvals';
import { computeRiskLines, gatherRiskFacts, type RiskLine } from '../wallet/risk';

export const RISK_TITLE = 'Risk checks';
export const RISK_FOOTNOTE =
  'Checked with public on-chain data only. No warning here does not mean a transaction is safe.';

/**
 * Risk warnings for an EVM confirm screen (phase 7, item 5). Drop-in, one
 * line, beside BalanceChangePreview:
 *
 *   <RiskWarnings url={url} wallet={from} to={txTo} data={calldata} />
 *
 * and, when the paid party differs from the transaction's `to` (an ERC-20
 * or NFT transfer, where `to` is the token contract):
 *
 *   <RiskWarnings url={url} wallet={from} to={quote.contract} counterparty={quote.to} data={quote.data} />
 *
 * Pass `assetChanges` when the caller already holds the balance-change
 * preview's changes; without them, direct approve / setApprovalForAll calls
 * are decoded from the calldata (see wallet/risk.ts). Purely informational:
 * it never blocks or unblocks anything — the eth_call gate stays the only
 * gate. Renders nothing when no signal applies or when every check failed
 * (a failed check is "unknown", never a warning). The chain is the ACTIVE
 * EVM chain from preferences. The look-alike contact warning is not
 * repeated here; it stays with RecipientContactNotice.
 */
export function RiskWarnings({
  url,
  wallet,
  to,
  counterparty,
  data,
  assetChanges,
}: {
  /** The active chain's endpoint (the same one the quote used); null = calldata-only checks. */
  url: string | null;
  /** The sending address (EOA, or the smart account on the AA path). */
  wallet: string;
  /** The transaction's `to`. */
  to: string;
  /** The party being paid, when different from `to`. */
  counterparty?: string;
  /** Calldata (bytes or 0x hex); absent or empty for a plain transfer. */
  data?: Uint8Array | string;
  /** The preview's asset changes, when the caller has them. */
  assetChanges?: AssetChange[] | null;
}) {
  const theme = useTheme();
  const { evmChain } = usePrefs();
  const { accountList } = useWallet();
  // The wallet's own EVM addresses: a recipient among them that is upgraded
  // to the wallet's pinned Kernel delegate is expected, not a risk.
  const ownAddresses = accountList
    .map((a) => a.evmAddress)
    .filter((a): a is string => typeof a === 'string');
  const ownKey = ownAddresses.join(',').toLowerCase();
  const [lines, setLines] = useState<RiskLine[] | null>(null);

  const dataHex = data === undefined ? '0x' : typeof data === 'string' ? data.toLowerCase() : toHex(data);
  const changesKey = assetChanges
    ? assetChanges.map((c) => JSON.stringify(c, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).join(';')
    : String(assetChanges);
  const key = `${url ?? ''}|${evmChain.caip2}|${wallet}|${to}|${counterparty ?? ''}|${dataHex}|${changesKey}|${ownKey}`;

  useEffect(() => {
    let cancelled = false;
    setLines(null);
    (async () => {
      let tracked: Awaited<ReturnType<typeof listTokens>> = [];
      try {
        tracked = await listTokens();
      } catch {
        tracked = [];
      }
      const facts = await gatherRiskFacts({
        url,
        wallet,
        to,
        ...(counterparty ? { counterparty } : {}),
        data: dataHex,
        ...(assetChanges !== undefined ? { assetChanges } : {}),
        chainCaip2: evmChain.caip2,
        ownAddresses,
        trackedTokens: tokensForChain(tracked, evmChain.caip2).map((t) => ({
          address: t.address,
          symbol: t.symbol,
        })),
      });
      return computeRiskLines(facts);
    })().then(
      (next) => {
        if (!cancelled) setLines(next);
      },
      () => {
        if (!cancelled) setLines([]);
      },
    );
    return () => {
      cancelled = true;
    };
    // `key` captures every input of the checks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (lines === null) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="small" color={theme.accent} />
        <Text style={[styles.muted, { color: theme.textMuted }]}>Running risk checks…</Text>
      </View>
    );
  }
  if (lines.length === 0) return null;

  return (
    <View style={styles.block}>
      <Text style={[styles.title, { color: theme.text }]}>{RISK_TITLE}</Text>
      {lines.map((line, i) =>
        line.tone === 'warning' ? (
          // Same visible warning style as BalanceChangePreview's warning lines.
          <View
            key={`${i}-${line.type}`}
            style={[styles.warning, { backgroundColor: theme.warningSurface, borderColor: theme.warningBorder }]}
          >
            <Text style={[styles.line, styles.bold, { color: theme.warningText }]}>⚠ {line.text}</Text>
          </View>
        ) : (
          <View
            key={`${i}-${line.type}`}
            style={[styles.notice, { backgroundColor: theme.card, borderColor: theme.border }]}
          >
            <Text style={[styles.line, { color: theme.text }]}>ⓘ {line.text}</Text>
          </View>
        ),
      )}
      <Text style={[styles.muted, { color: theme.textMuted }]}>{RISK_FOOTNOTE}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    gap: 6,
  },
  title: {
    fontSize: 15,
    fontWeight: '600',
  },
  loading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  line: {
    fontSize: 15,
    lineHeight: 21,
  },
  bold: {
    fontWeight: '700',
  },
  muted: {
    fontSize: 12,
    lineHeight: 17,
  },
  warning: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 8,
  },
  notice: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 8,
  },
});
