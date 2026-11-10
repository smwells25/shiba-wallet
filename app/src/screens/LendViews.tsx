import React from 'react';
import { Text, View } from 'react-native';
import type { LendingDeployment, LendingPosition, ReserveState } from '@shiba-wallet/chains-evm';
import type { Theme } from '../theme';
import { t } from '../i18n/index';
import { withShortAddresses } from '../a11y';
import { formatLending, reserveStateLines } from '../wallet/lending';
import { Row, stakingStyles as styles } from './StakingViews';

/**
 * Presentational pieces of the Lend screen (phase 26 item 2): what Aave and
 * this screen are, the honesty lines docs/LENDING_VAULTS.md section 7.4 asks
 * to be stated, the reserve as read just now, and the account's position.
 * The confirm rows and badge are the Staking screen's (StakingViews).
 */

/** The intro and the honesty lines, in this order, as plain sentences. */
export function lendingIntroLines(d: LendingDeployment): string[] {
  return [
    t('lend.intro', { aSymbol: d.aToken.symbol }),
    t('lend.honesty.market', { network: d.networkName }),
    t('lend.honesty.frozen'),
    t('lend.honesty.liquidity'),
    t('lend.honesty.interest', { aSymbol: d.aToken.symbol }),
    t('lend.honesty.noBorrow'),
    t('lend.honesty.ownAccount'),
    t('lend.honesty.audit'),
  ];
}

export function LendIntro({ deployment, theme }: { deployment: LendingDeployment; theme: Theme }) {
  const lines = lendingIntroLines(deployment);
  return (
    <View style={{ gap: 8 }}>
      {lines.map((line, i) => (
        <Text key={i} style={[styles.hint, { color: i === 0 ? theme.text : theme.textMuted }]}>
          {line}
        </Text>
      ))}
    </View>
  );
}

/** The reserve as the engine read it (every pinned fact re-checked first). */
export function LendReserveCard({ deployment, state, theme }: { deployment: LendingDeployment; state: ReserveState; theme: Theme }) {
  return (
    <View style={[{ borderRadius: 12, borderWidth: 1, padding: 14, gap: 8 }, { backgroundColor: theme.card, borderColor: theme.border }]}>
      <Text accessibilityRole="header" style={[styles.stepTitle, { color: theme.text }]}>
        {t('lend.reserve.title', { symbol: deployment.asset.symbol, network: deployment.networkName })}
      </Text>
      {reserveStateLines({ deployment, state }).map((line) => (
        <Text key={line} style={[styles.hint, { color: theme.textMuted }]}>
          {line}
        </Text>
      ))}
      <Row label={t('lend.reserve.pool')} value={deployment.pool} mono theme={theme} />
    </View>
  );
}

/** The holder's position (the aToken balance) and the asset it holds; Hide amounts masks both. */
export function LendPositionCard({
  deployment,
  position,
  holder,
  hidden,
  theme,
}: {
  deployment: LendingDeployment;
  position: LendingPosition;
  holder: { address: string; smartAccount: boolean };
  hidden: boolean;
  theme: Theme;
}) {
  const d = deployment;
  const show = (u: bigint) => (hidden ? `•••• ${d.asset.symbol}` : `${formatLending(u, d)} ${d.asset.symbol}`);
  const say = (label: string, u: bigint) => `${label}: ${hidden ? t('activity.amountHidden') : `${formatLending(u, d)} ${d.asset.symbol}`}`;
  const holderLine = holder.smartAccount
    ? t('lend.position.holderSmart', { address: holder.address })
    : t('lend.position.holderRegular', { address: holder.address });
  const suppliedLabel = t('lend.position.supplied');
  const heldLabel = t('lend.position.held', { symbol: d.asset.symbol });
  return (
    <View style={[{ borderRadius: 12, borderWidth: 1, padding: 14, gap: 8 }, { backgroundColor: theme.card, borderColor: theme.border }]}>
      <Text accessibilityRole="header" style={[styles.stepTitle, { color: theme.text }]}>{t('lend.position.title')}</Text>
      <Text selectable accessibilityLabel={withShortAddresses(holderLine)} style={[styles.hint, { color: theme.textMuted }]}>
        {holderLine}
      </Text>
      <Row
        label={suppliedLabel}
        value={show(position.supplied)}
        sub={t('lend.position.suppliedSub', { aSymbol: d.aToken.symbol })}
        spoken={`${say(suppliedLabel, position.supplied)}. ${t('lend.position.suppliedSub', { aSymbol: d.aToken.symbol })}`}
        theme={theme}
      />
      <Row label={heldLabel} value={show(position.walletBalance)} spoken={say(heldLabel, position.walletBalance)} theme={theme} />
    </View>
  );
}
