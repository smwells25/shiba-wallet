/**
 * The mainnet-readiness switchboard (../config/readiness.ts) as the user
 * reads it, through the string table (phase 22 item 6). The table rows keep
 * their English fields — every check script and every refusal reads them —
 * and these functions give the text Settings → Mainnet readiness and the
 * "test networks only" cards show. In English each returns EXACTLY what the
 * old screen showed (scripts/check-i18n.mjs compares every row, every phrase
 * state, the intro and the hint).
 *
 * The plain-feature reasons are templates with a `{blockers}` placeholder:
 * the shared clause that readinessDisplayReason substitutes per phone
 * (PLAIN_BLOCKERS / _PROTECTED / _UNPROTECTED) is its own entry, so each
 * language substitutes its own clause.
 *
 * Network names (Ethereum Sepolia, Base Sepolia …) come from the profiles
 * and are never translated; only the joining words are ("o"/"y", which
 * Spanish writes "u"/"e" before a word starting with an o / i sound).
 */
import {
  type FeatureId,
  type FeatureReadiness,
  type PhraseProtectionState,
  type ReadinessStatus,
} from '../config/readiness.ts';
import { EVM_TEST_PROFILES } from '../config/evm-chain.ts';
import { activeLanguage, t, type Language, type StringId } from './index.ts';

/** "A, B or C" in the active language. */
export function joinNames(names: readonly string[], conjunction: 'or' | 'and', language: Language = activeLanguage()): string {
  if (names.length <= 1) return names.join('');
  const last = names[names.length - 1];
  let word = t(conjunction === 'or' ? 'common.or' : 'common.and');
  if (language === 'es') {
    // Spanish: "o" becomes "u" before an o / ho sound, "y" becomes "e"
    // before an i / hi sound (but not "hie" / "hia").
    if (conjunction === 'or' && /^h?o/i.test(last)) word = 'u';
    if (conjunction === 'and' && /^h?i(?![aeou])/i.test(last)) word = 'e';
  }
  return `${names.slice(0, -1).join(', ')} ${word} ${last}`;
}

function testNetworkNames(conjunction: 'or' | 'and'): string {
  return joinNames(
    EVM_TEST_PROFILES.map((p) => p.label),
    conjunction,
  );
}

/** Rows whose English reason contains PLAIN_BLOCKERS (their entry has `{blockers}`). */
const PLAIN_ROWS: ReadonlySet<FeatureId> = new Set<FeatureId>(['eoa-send', 'tokens', 'nft', 'swap', 'dogecoin-send', 'imported-key']);

export function readinessTitleId(id: FeatureId): StringId {
  return `readiness.${id}.title` as StringId;
}
export function readinessReasonId(id: FeatureId): StringId {
  return `readiness.${id}.reason` as StringId;
}

export function readinessTitleText(feature: FeatureReadiness): string {
  return t(readinessTitleId(feature.id));
}

const BLOCKERS: Readonly<Record<PhraseProtectionState, StringId>> = {
  unknown: 'readiness.blockers',
  protected: 'readiness.blockers.protected',
  unprotected: 'readiness.blockers.unprotected',
};

/** readinessDisplayReason, through the table. */
export function readinessReasonText(feature: FeatureReadiness, phrase: PhraseProtectionState): string {
  const id = readinessReasonId(feature.id);
  return PLAIN_ROWS.has(feature.id) ? t(id, { blockers: t(BLOCKERS[phrase]) }) : t(id);
}

export function readinessCardTitleText(feature: FeatureReadiness): string {
  return t('card.testNetworksOnly.title', { title: readinessTitleText(feature) });
}

const STATUS: Readonly<Record<ReadinessStatus, StringId>> = {
  'mainnet-ok': 'readiness.status.mainnetOk',
  'testnet-only': 'readiness.status.testnetOnly',
  blocked: 'readiness.status.blocked',
};
export function readinessStatusText(status: ReadinessStatus): string {
  return t(STATUS[status]);
}

/** The line under each row's reason. */
export function readinessEnforcementText(feature: FeatureReadiness): string {
  return feature.status === 'mainnet-ok'
    ? t('readiness.note.cleared')
    : feature.enforced
      ? t('readiness.note.enforced')
      : t('readiness.note.advisory');
}

export function readinessEvidenceText(feature: FeatureReadiness): string {
  return t('readiness.evidence', { ids: feature.evidence.join(', ') });
}

export function readinessIntroText(): string {
  return t('readiness.intro', { networks: testNetworkNames('and') });
}

export function readinessHintText(): string {
  return t('readiness.hint', { networks: testNetworkNames('or') });
}
