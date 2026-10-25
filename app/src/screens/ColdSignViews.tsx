import React, { useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { Button, WarningBox } from '../components';
import { PayloadQr } from '../components/RecoveryViews';
import { QrScanner } from '../components/QrScanner';
import { AaDepositNote } from '../components/AaDepositNote';
import { BalanceChangePreview } from '../components/BalanceChangePreview';
import { RiskWarnings } from '../components/RiskWarnings';
import { SpendingPolicyNotice } from '../components/SpendingPolicyViews';
import { useTheme, type Theme } from '../theme';
import { formatUnits } from '../wallet/balances';
import {
  AA_DEPOSIT_ROW_LABEL,
  AA_SELF_PAID_FEE_SENTENCE,
  aaAccountTypeLabel,
  aaPreviewNote,
  aaRiskWarningTarget,
  aaSenderLabel,
  aaMaxAdjustmentSentence,
  kernelDeploymentNote,
  smartAccountDeploymentNote,
  type AaSendQuote,
} from '../wallet/aa';
import {
  COLD_AA_ACCOUNT_NOTE,
  COLD_AA_ESTIMATE_PASSED,
  COLD_AA_OWNER_ROW_LABEL,
  COLD_AA_PAYMASTER_NOT_USED_NOTE,
  acceptColdAaQrScan,
  coldAaQrPartCaption,
  splitColdAaQrParts,
  type ColdAaAccount,
} from '../wallet/cold-aa';
import {
  COLD_SIGN_QR_TOO_LARGE,
  acceptColdSignQrScan,
  coldSignQrPagedNote,
  coldSignQrPartCaption,
  coldSignQrProgressLine,
  splitColdSignQrParts,
  type ColdSignQrScan,
  type ColdSignQrScanResult,
} from '../wallet/cold-signing';

/**
 * Which kind of multi-part QR code a view shows or reads: the regular
 * cold-signing request ("SW-CS:", the default) or the smart-account request
 * ("SW-CU:", wallet/cold-aa.ts). Each kind collects only its own parts.
 */
export interface ColdQrKind {
  split: (payload: string) => string[] | null;
  accept: (scan: ColdSignQrScan | null, data: string) => ColdSignQrScanResult;
  partCaption: (caption: string, index: number, total: number) => string;
}

export const COLD_SIGN_QR_KIND: ColdQrKind = {
  split: splitColdSignQrParts,
  accept: acceptColdSignQrScan,
  partCaption: coldSignQrPartCaption,
};

export const COLD_AA_QR_KIND: ColdQrKind = {
  split: splitColdAaQrParts,
  accept: acceptColdAaQrScan,
  partCaption: (_caption, index, total) => coldAaQrPartCaption(index, total),
};

/**
 * A cold-signing request as QR codes: one code when it fits, otherwise
 * numbered parts ("SW-CS:<n>/<total>:…", wallet/cold-signing.ts
 * splitColdSignQrParts) shown one at a time with Previous part / Next part,
 * as the multisig screens show theirs.
 */
export function ColdSignPayloadQr({ payload, caption, kind = COLD_SIGN_QR_KIND }: { payload: string; caption: string; kind?: ColdQrKind }) {
  const theme = useTheme();
  const parts = kind.split(payload);
  const [page, setPage] = useState(0);
  if (!parts) {
    return <Text style={[styles.hint, { color: theme.textMuted }]}>{COLD_SIGN_QR_TOO_LARGE}</Text>;
  }
  const total = parts.length;
  const index = Math.min(page, total - 1);
  return (
    <View style={styles.stack}>
      {total > 1 ? <Text style={[styles.hint, { color: theme.text }]}>{coldSignQrPagedNote(total)}</Text> : null}
      <PayloadQr value={parts[index]!} caption={kind.partCaption(caption, index, total)} />
      {total > 1 ? (
        <View style={styles.row}>
          <Button title="Previous part" variant="secondary" disabled={index === 0} onPress={() => setPage(index - 1)} />
          <Button title="Next part" variant="secondary" disabled={index === total - 1} onPress={() => setPage(index + 1)} />
        </View>
      ) : null}
    </View>
  );
}

/**
 * The scan button for the signer's answer. A whole code goes straight to
 * `onComplete`; the parts of a multi-part code are collected across scans
 * (acceptColdSignQrScan). The caller hands the text to
 * verifyColdSignSignature with the STORED request; nothing here trusts it.
 */
export function ColdSignScanButton({
  title,
  rationale,
  onComplete,
  onError,
  kind = COLD_SIGN_QR_KIND,
}: {
  title: string;
  rationale: string;
  onComplete: (text: string) => void;
  onError: (message: string) => void;
  kind?: ColdQrKind;
}) {
  const theme = useTheme();
  const [visible, setVisible] = useState(false);
  const [scan, setScan] = useState<ColdSignQrScan | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const startOver = () => {
    setScan(null);
    setProgress(null);
  };
  return (
    <View style={styles.stack}>
      <Button
        title={scan ? 'Scan the next part' : title}
        accessibilityLabel={scan ? `Scan the next part: ${title}` : title}
        variant="secondary"
        onPress={() => setVisible(true)}
      />
      {progress ? <Text style={[styles.hint, { color: theme.text }]}>{progress}</Text> : null}
      {scan ? <Button title="Start over" variant="secondary" onPress={startOver} /> : null}
      <QrScanner
        visible={visible}
        rationale={rationale}
        onScanned={(data) => {
          setVisible(false);
          try {
            const result = kind.accept(scan, data);
            if (result.kind === 'complete') {
              startOver();
              onComplete(result.text);
            } else {
              setScan(result.scan);
              setProgress(coldSignQrProgressLine(result.received, result.total, result.repeated));
            }
          } catch (e) {
            onError(e instanceof Error ? e.message : String(e));
          }
        }}
        onClose={() => setVisible(false)}
      />
    </View>
  );
}

const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });

function InfoRow({ label, value, sub, monoValue = false, theme }: { label: string; value: string; sub?: string | null; monoValue?: boolean; theme: Theme }) {
  return (
    <View style={styles.rowBlock}>
      <Text style={[styles.label, { color: theme.textMuted }]}>{label}</Text>
      <Text selectable style={[monoValue ? styles.monoText : styles.body, { color: theme.text }]}>{value}</Text>
      {sub ? <Text style={[styles.hint, { color: theme.textMuted }]}>{sub}</Text> : null}
    </View>
  );
}

/**
 * The form's smart-account facts when "Send from the smart account" is on
 * (phase 23 item 5): the address with its deployment state, its balance and
 * its EntryPoint deposit, as the Send screen's smart-account form shows them,
 * plus what the account is and that no paymaster is used.
 */
export function ColdAaAccountCard({
  account,
  error,
  symbol,
  paymasterConfigured,
}: {
  account: ColdAaAccount | null;
  error: string | null;
  symbol: string;
  paymasterConfigured: boolean;
}) {
  const theme = useTheme();
  const fmt = (wei: bigint) => `${formatUnits(wei, 18, 18)} ${symbol}`;
  return (
    <View style={styles.stack}>
      <Text style={[styles.hint, { color: theme.textMuted }]}>{COLD_AA_ACCOUNT_NOTE}</Text>
      {paymasterConfigured ? <Text style={[styles.hint, { color: theme.textMuted }]}>{COLD_AA_PAYMASTER_NOT_USED_NOTE}</Text> : null}
      {error ? <Text style={[styles.body, { color: theme.danger }]}>{error}</Text> : null}
      {account ? (
        <>
          <InfoRow label="Smart account (Kernel v3.3)" value={account.address} sub={smartAccountDeploymentNote(account.deployed)} monoValue theme={theme} />
          <InfoRow label={`Smart account ${symbol} balance`} value={fmt(account.balance)} theme={theme} />
          {account.deposit !== null && account.deposit > 0n ? <InfoRow label={AA_DEPOSIT_ROW_LABEL} value={fmt(account.deposit)} theme={theme} /> : null}
        </>
      ) : null}
    </View>
  );
}

/**
 * The smart-account confirm, the same rows as the Send screen's
 * smart-account confirm (SendScreen.tsx, "confirm (smart account)"): the
 * account type tag, recipient and amount, the owner who signs (here off-line),
 * the sender and its balance, the deployment line, the worst-case fee with
 * its arithmetic, the EntryPoint deposit row, the total, the balance-change
 * preview of every call from the smart account, the risk card, the spending
 * notice and "Bundler gas estimate passed".
 */
export function ColdAaConfirm({
  quote,
  owner,
  url,
  symbol,
  networkLabel,
  bundlerUrl,
}: {
  quote: AaSendQuote;
  owner: string;
  url: string | null;
  symbol: string;
  networkLabel: string;
  bundlerUrl: string | null;
}) {
  const theme = useTheme();
  const fmt = (wei: bigint) => `${formatUnits(wei, 18, 18)} ${symbol}`;
  const gas = quote.callGasLimit + quote.verificationGasLimit + quote.preVerificationGas;
  const adjustment = aaMaxAdjustmentSentence(quote, fmt);
  return (
    <View style={styles.stack}>
      <Text style={[styles.tag, { color: theme.accent, borderColor: theme.accent }]}>
        EXPERIMENTAL · ERC-4337 smart account · {aaAccountTypeLabel(quote.accountType)}
      </Text>
      <InfoRow label="Network" value={networkLabel} theme={theme} />
      <InfoRow label="To" value={quote.to} monoValue theme={theme} />
      {quote.token ? (
        <>
          <InfoRow label="Amount" value={`${formatUnits(quote.token.amount, quote.token.decimals, quote.token.decimals)} ${quote.token.symbol}`} theme={theme} />
          <InfoRow label="Token contract" value={quote.token.contract} monoValue theme={theme} />
          {quote.tokenSpend ? (
            <InfoRow
              label={`Smart account ${quote.token.symbol} balance`}
              value={`${formatUnits(quote.tokenSpend.balance, quote.token.decimals, quote.token.decimals)} ${quote.token.symbol}`}
              theme={theme}
            />
          ) : null}
        </>
      ) : (
        <InfoRow label="Amount" value={fmt(quote.amount)} theme={theme} />
      )}
      {adjustment ? <WarningBox>{adjustment}</WarningBox> : null}
      <InfoRow label={COLD_AA_OWNER_ROW_LABEL} value={owner} monoValue theme={theme} />
      <InfoRow label={aaSenderLabel(quote)} value={quote.sender} monoValue theme={theme} />
      <InfoRow label={`Smart account ${symbol} balance`} value={fmt(quote.senderBalance)} theme={theme} />
      <InfoRow label="Deployment" value={quote.deployed ? 'Already deployed' : 'Will deploy with this send'} theme={theme} />
      {!quote.deployed ? <Text style={[styles.hint, { color: theme.textMuted }]}>{kernelDeploymentNote(bundlerUrl)}</Text> : null}
      <InfoRow label="Max network fee (bundler estimate)" value={fmt(quote.fee)} theme={theme} />
      <Text style={[styles.hint, { color: theme.textMuted }]}>
        {`Worst case at ${formatUnits(quote.maxFeePerGas, 9, 9)} gwei max fee × ${gas.toString()} gas (bundler eth_estimateUserOperationGas).` +
          (quote.deposit !== undefined && quote.deposit > 0n ? '' : ` ${AA_SELF_PAID_FEE_SENTENCE}`)}
      </Text>
      <AaDepositNote fee={quote.fee} deposit={quote.deposit} sponsored={false} symbol={symbol} />
      <InfoRow label={quote.token ? `Total ${symbol} (worst case)` : 'Total (worst case)'} value={fmt(quote.total)} theme={theme} />
      <BalanceChangePreview
        url={url}
        request={{ from: quote.sender, to: quote.calls[0]!.to, value: quote.calls[0]!.value, data: quote.calls[0]!.data }}
        batch={quote.calls.map((c) => ({ from: quote.sender, to: c.to, value: c.value, data: c.data }))}
        note={aaPreviewNote(quote)}
      />
      <RiskWarnings url={url} wallet={quote.sender} {...aaRiskWarningTarget(quote)} />
      <SpendingPolicyNotice owner={owner} quote={quote} from={owner} />
      <Text style={[styles.body, { color: theme.success }]}>{COLD_AA_ESTIMATE_PASSED}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: {
    gap: 8,
  },
  row: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
  },
  hint: {
    fontSize: 13,
    lineHeight: 19,
  },
  body: {
    fontSize: 15,
    lineHeight: 21,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
  },
  rowBlock: {
    gap: 2,
  },
  monoText: {
    fontFamily: mono,
    fontSize: 13,
  },
  tag: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    fontSize: 11,
    fontWeight: '700',
  },
});
