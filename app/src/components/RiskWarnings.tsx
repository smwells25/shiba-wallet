import React, { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { toHex, type AssetChange } from '@shiba-wallet/chains-evm';
import { useTheme } from '../theme';
import { usePrefs } from '../wallet/PrefsContext';
import { useWallet } from '../wallet/WalletContext';
import { listTokens } from '../wallet/tokens';
import { approvalTokensForChain } from '../wallet/approvals';
import { getIndexerConfig } from '../wallet/indexer';
import { getAaConfig } from '../wallet/aa';
import { computeRiskLines, gatherRiskFacts, ownWalletAddresses, type RiskLine } from '../wallet/risk';

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
 * gate. With an endpoint the card always shows at least what the
 * recipient is (contract / regular account), and says plainly what could
 * not be checked (a failed check is "unknown", never a warning); without
 * one it shows only calldata-derived approval warnings, or nothing. The chain is the ACTIVE
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
  const ownKey = accountList.map((a) => `${a.index}:${a.name}:${a.evmAddress ?? ''}`).join(',').toLowerCase();
  const [lines, setLines] = useState<RiskLine[] | null>(null);

  const dataHex = data === undefined ? '0x' : typeof data === 'string' ? data.toLowerCase() : toHex(data);
  const changesKey = assetChanges
    ? assetChanges.map((c) => JSON.stringify(c, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).join(';')
    : String(assetChanges);
  const key = `${url ?? ''}|${evmChain.caip2}|${wallet}|${to}|${counterparty ?? ''}|${dataHex}|${changesKey}|${ownKey}`;

  // New inputs clear the shown lines while rendering (React's "adjust state
  // when a prop changes" pattern), so the card goes back to its loading
  // state before the effect below gathers the new facts.
  const [shownKey, setShownKey] = useState(key);
  if (shownKey !== key) {
    setShownKey(key);
    setLines(null);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let tracked: Awaited<ReturnType<typeof listTokens>> = [];
      try {
        tracked = await listTokens(evmChain.caip2);
      } catch {
        tracked = [];
      }
      // The active chain's history indexer, when configured, lets the
      // first-interaction check also cover plain ETH transfers.
      let indexerUrl: string | null = null;
      try {
        indexerUrl = (await getIndexerConfig(evmChain.caip2)).url;
      } catch {
        indexerUrl = null;
      }
      // The wallet's own smart-account addresses (Kernel counterfactuals and
      // recovered accounts) come from the active chain's AA configuration;
      // with them a send between own accounts reads as such (finding 13).
      let aa: Awaited<ReturnType<typeof getAaConfig>> | null = null;
      try {
        aa = await getAaConfig(evmChain.caip2);
      } catch {
        aa = null;
      }
      const ownAccounts = ownWalletAddresses(accountList, aa);
      const facts = await gatherRiskFacts({
        url,
        wallet,
        to,
        ...(counterparty ? { counterparty } : {}),
        data: dataHex,
        ...(assetChanges !== undefined ? { assetChanges } : {}),
        chainCaip2: evmChain.caip2,
        ownAddresses: [...ownAddresses, ...ownAccounts.map((o) => o.address)],
        ownAccounts,
        indexerUrl,
        // Tracked tokens plus the known test-network tokens (tokens.ts).
        trackedTokens: approvalTokensForChain(tracked, evmChain.caip2).map((t) => ({
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` serializes every input of the checks (url, chain, wallet, to, counterparty, calldata, the asset changes and the wallet's accounts). ownAddresses and accountList are new arrays on every render and callers may pass assetChanges inline, so listing them would re-run the network checks without any input having changed. The AA configuration is read inside the effect.
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
            style={[styles.warning, styles.row, { backgroundColor: theme.warningSurface, borderColor: theme.warningBorder }]}
          >
            {/* The glyph is decoration; the tone is spoken in the label instead. */}
            <Text
              accessibilityElementsHidden
              importantForAccessibility="no"
              style={[styles.line, styles.bold, { color: theme.warningText }]}
            >
              ⚠
            </Text>
            <Text
              accessibilityLabel={`Warning: ${line.text}`}
              style={[styles.line, styles.bold, styles.lineText, { color: theme.warningText }]}
            >
              {line.text}
            </Text>
          </View>
        ) : (
          <View
            key={`${i}-${line.type}`}
            style={[styles.notice, styles.row, { backgroundColor: theme.card, borderColor: theme.border }]}
          >
            <Text
              accessibilityElementsHidden
              importantForAccessibility="no"
              style={[styles.line, { color: theme.text }]}
            >
              ⓘ
            </Text>
            <Text
              accessibilityLabel={`Note: ${line.text}`}
              style={[styles.line, styles.lineText, { color: theme.text }]}
            >
              {line.text}
            </Text>
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
  row: {
    flexDirection: 'row',
    gap: 6,
  },
  lineText: {
    flex: 1,
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
