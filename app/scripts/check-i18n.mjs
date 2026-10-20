// Localisation groundwork (phase 22 item 6, feature 91), entirely OFFLINE:
// the string tables (app/src/i18n/en.ts, the source of truth, and es.ts, the
// Spanish first draft), the one accessor (app/src/i18n/index.ts: t, tx,
// localize), the device-wide language choice through the storage seam
// (i18n/language-store.ts, i18n/app-language.ts), the locale-aware Activity
// times (i18n/format.ts), the readiness switchboard's text (i18n/
// readiness-text.ts) and the TESTNET banner (i18n/banner.ts).
//
// What it proves:
//  - every migrated id is in both tables, no id is unused, the placeholders
//    of the two languages match, and a missing Spanish entry falls back to
//    English (never to the id);
//  - BYTE IDENTITY: every English entry equals the text the app showed
//    before the migration — against scripts/fixtures/i18n-english-before.json
//    (the English as found in the checkout of commit c5baff6, where it stood),
//    against the constants the older suites pin (imported from the wallet
//    modules), and by rendering the old functions and the new ones side by
//    side (readiness rows for every phrase state, inbox, PIN messages, the
//    Activity times, the banner, the spoken links);
//  - the exact-amount strings are byte-identical in English and in Spanish
//    (no amount goes through the tables or Intl);
//  - source scans: every tx('…') literal and every <T>…</T> text is a table
//    entry, every <T> sits inside a <Text>, only the accessor reads the
//    tables;
//  - the stored language choice (strict parse, device scope, the same key
//    for a second wallet profile) and the controller (save first, then apply);
//  - mutants (rewritten copies of the i18n modules, and broken tables), each
//    shown caught.
//
// Run from the app directory:
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-i18n.mjs

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

import * as I from '../src/i18n/index.ts';
import { en } from '../src/i18n/en.ts';
import { es } from '../src/i18n/es.ts';
import * as LS from '../src/i18n/language-store.ts';
import { createLanguageController } from '../src/i18n/app-language.ts';
import { decimalSeparatorsFor, localTimestampLabel } from '../src/i18n/format.ts';
import * as RT from '../src/i18n/readiness-text.ts';
import { testnetBannerText } from '../src/i18n/banner.ts';
import * as R from '../src/config/readiness.ts';
import { EVM_PROFILES, EVM_TEST_PROFILES } from '../src/config/evm-chain.ts';
import { STORE_KEYS, profileBoundStore, storeKeyScope } from '../src/wallet/store-keys.ts';
import { timestampLabel, directionLabel } from '../src/wallet/history.ts';
import * as inbox from '../src/wallet/inbox.ts';
import * as notif from '../src/wallet/notifications.ts';
import * as duress from '../src/wallet/duress.ts';
import * as lock from '../src/wallet/lock.ts';
import * as pin from '../src/wallet/pin.ts';
import * as sp from '../src/wallet/screen-protection.ts';
import * as ids from '../src/wallet/account-ids.ts';
import * as wo from '../src/wallet/watch-only.ts';
import { RECOVERED_NOT_DERIVABLE_NOTE } from '../src/wallet/recovery.ts';
import * as aa from '../src/wallet/aa.ts';
import { REBASING_TOKEN_NOTE } from '../src/wallet/tokens.ts';
import { COLD_SIGN_HOME_LINK, COLD_SIGN_LINK_HINT } from '../src/wallet/cold-signing.ts';
import * as as from '../src/wallet/activity-sentences.ts';
import { LOAD_MORE_RETRY_FOOTER } from '../src/wallet/history-controller.ts';
import { NOTE_PRIVACY_LINE } from '../src/wallet/notes.ts';
import { AUTO_LOCK_CHOICES } from '../src/config/prefs.ts';
import { formatBalanceDisplay } from '../src/wallet/balances.ts';
import { activityRowSpokenLead, sendLinkHint, spokenLinkText } from '../src/a11y.ts';

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const SRC = join(APP, 'src');
const read = (rel) => readFileSync(join(APP, rel), 'utf8');
const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9]*)\}/g;
const placeholders = (s) => [...new Set([...s.matchAll(PLACEHOLDER)].map((m) => m[1]))].sort();
const isTemplate = (s) => placeholders(s).length > 0;
const EN_IDS = Object.keys(en);

// ---------------------------------------------------------------------------
console.log('check-i18n: the tables');
// ---------------------------------------------------------------------------
{
  const missing = EN_IDS.filter((id) => typeof es[id] !== 'string');
  check(`every one of the ${EN_IDS.length} migrated ids has a Spanish entry`, missing.length === 0, missing.join(', '));
  const extra = Object.keys(es).filter((id) => !(id in en));
  check('…and Spanish has no id English lacks', extra.length === 0, extra.join(', '));
  const mismatch = EN_IDS.filter((id) => typeof es[id] === 'string' && placeholders(en[id]).join() !== placeholders(es[id]).join());
  check('the placeholders of every Spanish entry are exactly the English ones', mismatch.length === 0, mismatch.join(', '));
  const empty = [...EN_IDS.filter((id) => !en[id].trim()), ...Object.keys(es).filter((id) => !es[id].trim())];
  check('no entry is empty', empty.length === 0, empty.join(', '));
  const seen = new Map();
  const dup = [];
  for (const id of EN_IDS) {
    if (isTemplate(en[id])) continue;
    if (seen.has(en[id])) dup.push(`${seen.get(en[id])} = ${id}`);
    seen.set(en[id], id);
  }
  check('every placeholder-free English text is one entry (the English → id map is exact)', dup.length === 0, dup.join('; '));
  // A Spanish text that is itself an English entry must translate to itself,
  // or localize() would translate an already translated string again.
  const unstable = Object.entries(es).filter(([id, v]) => seen.has(v) && seen.get(v) !== id && es[seen.get(v)] !== v).map(([id]) => id);
  check('a Spanish text equal to another English entry translates to itself (localize is a fixed point)', unstable.length === 0, unstable.join(', '));
  const idShape = EN_IDS.filter((id) => !/^[a-z][A-Za-z0-9-]*(\.[A-Za-z0-9-]+)+$/.test(id));
  check('ids are stable dotted names ("area.what")', idShape.length === 0, idShape.join(', '));
}

// ---------------------------------------------------------------------------
console.log('check-i18n: the accessor');
// ---------------------------------------------------------------------------
{
  check('t() in English returns the table text for every placeholder-free id',
    EN_IDS.filter((id) => !isTemplate(en[id])).every((id) => I.t(id) === en[id]));
  check('t() fills {name} placeholders', I.t('home.token.send', { symbol: 'USDC' }) === 'Send USDC' && I.t('inbox.unread.many', { count: 7 }) === '7 unread entries.');
  check('a placeholder with no value is left as written (visible, never silently empty)', I.t('home.token.send') === 'Send {symbol}' && I.fill('a {x} b', { y: 1 }) === 'a {x} b');
  check('an extra parameter is ignored', I.t('receive.title.coin', { symbol: 'ETH', extra: 'x' }) === 'Receive ETH');
  check('English fallback: an id missing from the Spanish table gives the English text, never the id',
    I.translateFrom({ en, es: {} }, 'es', 'inbox.empty') === en['inbox.empty'] &&
      I.translateFrom({ en, es: {} }, 'es', 'home.token.send', { symbol: 'X' }) === 'Send X');
  check('…and Spanish is used where it exists', I.translateIn('es', 'inbox.empty') === es['inbox.empty'] && I.translateIn('es', 'home.token.send', { symbol: 'X' }) === 'Enviar X');
  check('localize: English is returned unchanged in English', I.localizeIn('en', 'Cancel') === 'Cancel');
  check('localize: an English entry becomes Spanish in Spanish', I.localizeIn('es', 'Cancel') === 'Cancelar' && I.localizeIn('es', inbox.INBOX_EMPTY) === es['inbox.empty']);
  check('localize: anything else is returned unchanged (an amount, an address, a name the user typed, an unmigrated sentence)',
    ['0.0002 test ETH', '0x772eAA1d3BEf14C0BD5cee980b90dB3FC680F44F', 'Account 1', 'Savings', 'This is not a table entry.'].every((x) => I.localizeIn('es', x) === x));
  check('localize keeps a link or chip decoration and translates the rest ("Send ↗", "✓ Off", "Upgraded ✓")',
    I.localizeIn('es', 'Send ↗') === 'Enviar ↗' && I.localizeIn('es', '✓ Off') === '✓ Desactivado' && I.localizeIn('es', 'Upgraded ✓') === 'Mejorada ✓' &&
      I.localizeIn('es', 'Nonsense ↗') === 'Nonsense ↗');
  check('the device locale tag picks the language: any Spanish tag → es, anything else → en',
    ['es', 'es_ES', 'es-419', 'ES_mx', ' es-AR '].every((x) => I.languageForLocaleTag(x) === 'es') &&
      ['en_US', 'en', 'fr_FR', 'pt-BR', '', null, undefined, 'e'].every((x) => I.languageForLocaleTag(x) === 'en'));
  check('a choice resolves: system follows the device, en / es are fixed',
    I.resolveLanguage('system', 'es_ES') === 'es' && I.resolveLanguage('system', 'de') === 'en' && I.resolveLanguage('en', 'es_ES') === 'en' && I.resolveLanguage('es', null) === 'es');
  check('setActiveLanguage switches and notifies once; an unknown language is ignored', (() => {
    let n = 0;
    const off = I.subscribeLanguage(() => { n += 1; });
    I.setActiveLanguage('es');
    const a = I.activeLanguage() === 'es' && I.t('common.cancel') === 'Cancelar' && I.tx('Cancel') === 'Cancelar';
    I.setActiveLanguage('es');
    I.setActiveLanguage('fr');
    I.setActiveLanguage('en');
    off();
    I.setActiveLanguage('es');
    I.setActiveLanguage('en');
    return a && n === 2 && I.activeLanguage() === 'en';
  })());
}

// ---------------------------------------------------------------------------
console.log('check-i18n: byte identity with the English before the migration (fixture from commit c5baff6)');
// ---------------------------------------------------------------------------
const FIXTURE = JSON.parse(read('scripts/fixtures/i18n-english-before.json'));
/** Static parts of a template (the text between placeholders). */
const partsOf = (t) => t.split(/\{[A-Za-z][A-Za-z0-9]*\}/);
/** The fixture's window rule: the parts in order, the first a suffix and the last a prefix of the old pieces. */
function partsMatch(want, have) {
  const k = want.length;
  for (let i = 0; i + k <= have.length; i++) {
    let ok = true;
    for (let j = 0; j < k && ok; j++) {
      const w = want[j];
      const h = have[i + j];
      if (k === 1) ok = h.includes(w);
      else if (j === 0) ok = h.endsWith(w);
      else if (j === k - 1) ok = h.startsWith(w);
      else ok = h === w;
    }
    if (ok) return true;
  }
  return false;
}
function fixtureProblems(table, fixture) {
  const p = [];
  const sections = ['literal', 'template', 'composite'];
  const known = new Set([...sections.flatMap((s) => Object.keys(fixture[s])), ...fixture.new]);
  for (const id of Object.keys(table)) if (!known.has(id)) p.push(`${id}: not in the fixture (neither migrated nor new)`);
  for (const id of known) if (!(id in table)) p.push(`${id}: in the fixture, not in the table`);
  // A "changed" entry (reworded on purpose after the migration, with its
  // reason) is compared with its new text, and its "before" must still be the
  // record of the text at the base commit.
  const changed = fixture.changed ?? {};
  for (const [id, c] of Object.entries(changed)) {
    const rec = sections.map((s) => fixture[s][id]).find(Boolean);
    if (!rec) p.push(`${id}: changed, but not a migrated entry`);
    else if (rec.en !== c.before) p.push(`${id}: its "before" is not the text at the base commit`);
    if (typeof c.why !== 'string' || c.why.length < 20) p.push(`${id}: changed without a reason`);
  }
  for (const s of sections) {
    for (const [id, f] of Object.entries(fixture[s])) {
      const want = changed[id] ? changed[id].en : f.en;
      if (table[id] !== undefined && table[id] !== want) p.push(`${id}: ${JSON.stringify(table[id])} is not the English ${changed[id] ? 'recorded as changed' : 'before'}, ${JSON.stringify(want)}`);
      if (s === 'template' && table[id] !== undefined && !partsMatch(partsOf(table[id]), f.old)) p.push(`${id}: its static parts are not the old ones`);
    }
  }
  return p;
}
{
  const p = fixtureProblems(en, FIXTURE);
  check(`every English entry is the text the app showed at ${FIXTURE.base} (${Object.keys(FIXTURE.literal).length} literals, ${Object.keys(FIXTURE.template).length} templates by their static parts, ${Object.keys(FIXTURE.composite).length} composites) or listed as new (${FIXTURE.new.length})`,
    p.length === 0, p.slice(0, 5).join('; '));
  // Phase 22 polish: the passphrase forms of the app-lock notes are new too.
  const LOCK_KIND_NEW = ['inbox.passphraseNote', 'settings.autoLock.hintWithPassphrase', 'settings.autoLock.withPassphraseNote',
    'settings.screenProtection.withPassphrase', 'settings.notifications.offWithPassphrase'];
  check('the new entries are exactly the Settings → Language ones and the five passphrase forms of the app-lock notes',
    FIXTURE.new.every((id) => id.startsWith('settings.language.') || LOCK_KIND_NEW.includes(id)) && LOCK_KIND_NEW.every((id) => FIXTURE.new.includes(id)));
  check('the changed entries are exactly the transaction-notes line (reworded for the records backup) and the watch-only notice (reworded for the off-line signer), each with its reason',
    JSON.stringify(Object.keys(FIXTURE.changed ?? {})) === JSON.stringify(['activity.note.privacy', 'notice.watchOnly']) &&
      en['activity.note.privacy'] === 'Notes are kept on this phone and are not sent anywhere. They are deleted when the wallet is wiped. A records backup (Settings → Records backup) includes them, and your recovery phrase restores them from it. Hide amounts does not hide them.');
  // Pass p22a: the shared watch-only notice no longer says the wallet cannot
  // send for the address (the off-line signer screen prepares sends for it,
  // and showed the notice right above saying so); the Spanish line follows.
  check('…the watch-only notice (exact): cannot sign, swap or recover; a send can be prepared with "Send with an off-line signer", in both languages, and never "cannot send"',
    en['notice.watchOnly'] === 'Watch-only: this wallet can show this address but holds no key for it, so it cannot sign, swap or recover anything for it. A send on an Ethereum network can still be prepared with "Send with an off-line signer" and signed by an off-line signer that holds its key.' &&
      en['notice.watchOnly'].includes(`"${en['home.link.coldSign']}"`) && !/cannot send/.test(en['notice.watchOnly']) &&
      es['notice.watchOnly'].includes(`«${es['home.link.coldSign']}»`) && !/No puede enviar/i.test(es['notice.watchOnly']));
  check('…mutant caught (p22a): the old notice that said it cannot send',
    fixtureProblems({ ...en, 'notice.watchOnly': FIXTURE.changed['notice.watchOnly'].before }, FIXTURE).length === 1);
}

// The composites, assembled the old way from their pieces.
{
  const old = {
    'lock.tryAgain': ['Wrong PIN. Try again.', `${en['lock.pin.wrong']} ${en['lock.tryAgain']}`],
    'lock.tryAgain.second': ['Try again in 1 second.', I.t('lock.tryAgain.second')],
    'lock.tryAgain.seconds': [`Try again in ${30} second${'s'}.`, I.t('lock.tryAgain.seconds', { count: 30 })],
    'readiness.details.show': ['Details for reviewers ' + '(show)', en['readiness.details.show']],
    'readiness.details.hide': ['Details for reviewers ' + '(hide)', en['readiness.details.hide']],
    'home.footer.derived': [`${'Account 1'}'s addresses, derived on this device ` + 'from your recovery phrase (one phrase backs up every account from it).', I.t('home.footer.derived', { name: 'Account 1' })],
    'home.footer.derivedYours': [`${'Your'} addresses, derived on this device ` + 'from your recovery phrase (one phrase backs up every account from it).', en['home.footer.derivedYours']],
    'receive.smart.note': ['A separate address controlled by this account’s key. Funds sent here are spent with “Send from smart account”, and the smart account pays its own gas from them.', en['receive.smart.note']],
    'activity.row.received': [`${directionLabel('in')} transaction`, en['activity.row.received']],
    'activity.row.sent': [`${directionLabel('out')} transaction`, en['activity.row.sent']],
    'activity.row.self': [`${directionLabel('self')} transaction`, en['activity.row.self']],
    'send.passkey.hint': ['Signs with this phone’s passkey instead of your account key. The smart account (the sender) and its address stay the same, and it pays the gas from its own balance as usual. Off by default; the account key signs otherwise.', en['send.passkey.hint']],
    'send.token.intro': [`Sending ${'USDC'} (ERC-20 token, contract ${'0x1c7D4B19…'}${'7c3DE57238'}) from${' your smart account'}.`, I.t('send.token.intro', { symbol: 'USDC', contract: '0x1c7D4B19…7c3DE57238', from: I.t('send.token.fromSmart') })],
    'send.utxo.feeRate.one': [`${5} sat/vB (target: ${1} block${''})`, I.t('send.utxo.feeRate.one', { rate: 5 })],
    'send.utxo.feeRate': [`${5} sat/vB (target: ${6} block${'s'})`, I.t('send.utxo.feeRate', { rate: 5, blocks: 6 })],
  };
  const bad = Object.entries(old).filter(([, [a, b]]) => a !== b).map(([id, [a, b]]) => `${id}: ${a} ≠ ${b}`);
  check(`the ${Object.keys(old).length} composites assemble to exactly the old text`, bad.length === 0, bad.join('; '));
  check('…and every composite in the fixture is assembled here (or is the banner, checked below)',
    Object.keys(FIXTURE.composite).every((id) => id in old || id === 'banner.testnet'));
}

// The pinned constants of the wallet modules (the older suites read these).
const CONSTANTS = {
  'inbox.title': inbox.INBOX_TITLE, 'inbox.intro': inbox.INBOX_INTRO, 'inbox.pinNote': inbox.INBOX_PIN_NOTE,
  'inbox.scheduledNote': inbox.INBOX_SCHEDULED_NOTE, 'inbox.empty': inbox.INBOX_EMPTY, 'inbox.readOnly': inbox.INBOX_READ_ONLY_MESSAGE,
  'inbox.reset.title': inbox.INBOX_RESET_TITLE, 'inbox.reset.body': inbox.INBOX_RESET_BODY, 'inbox.markAllRead': inbox.INBOX_MARK_ALL_READ,
  'inbox.recurringDue.title': notif.RECURRING_DUE_TITLE, 'inbox.recurringDue.body': notif.RECURRING_DUE_BODY,
  'inbox.swapDue.title': notif.RECURRING_SWAP_DUE_TITLE, 'inbox.swapDue.body': notif.RECURRING_SWAP_DUE_BODY,
  'inbox.takeover.title': notif.TAKEOVER_TITLE, 'inbox.takeover.body': notif.TAKEOVER_BODY,
  'inbox.kind.priceAlert': notif.PRICE_ALERT_TITLE, 'inbox.priceAlert.body': notif.PRICE_ALERT_BODY,
  'settings.notifications': notif.NOTIFICATIONS_SECTION_TITLE,
  'settings.notifications.offWithPin': duress.NOTIFICATIONS_OFF_WITH_PIN,
  'settings.screenProtection.withPin': duress.SCREEN_PROTECTION_WITH_PIN_NOTE,
  'settings.autoLock.withPinNote': duress.AUTO_LOCK_WITH_PIN_NOTE,
  'settings.autoLock.hintWithPin': lock.AUTO_LOCK_HINT_WITH_PIN,
  'settings.notifications.offWithPassphrase': duress.NOTIFICATIONS_OFF_WITH_PASSPHRASE,
  'settings.screenProtection.withPassphrase': duress.SCREEN_PROTECTION_WITH_PASSPHRASE_NOTE,
  'settings.autoLock.withPassphraseNote': duress.AUTO_LOCK_WITH_PASSPHRASE_NOTE,
  'settings.autoLock.hintWithPassphrase': lock.AUTO_LOCK_HINT_WITH_PASSPHRASE,
  'inbox.passphraseNote': inbox.INBOX_PASSPHRASE_NOTE,
  'lock.hint.startedLocked': lock.lockScreenHint(true), 'lock.hint.background': lock.lockScreenHint(false),
  'lock.pin.prompt': duress.PIN_PAD_TITLE, 'lock.phr.prompt': duress.lockCopy('phr').lockScreenPrompt,
  'lock.pin.checking': duress.lockCopy('pin').checking, 'lock.phr.checking': duress.lockCopy('phr').checking,
  'lock.pin.waitOver': pin.PIN_WAIT_OVER_MESSAGE, 'lock.phr.waitOver': pin.PASSPHRASE_WAIT_OVER_MESSAGE,
  'readiness.duress-pin.reason': duress.DURESS_READINESS_REASON,
  'settings.section.privacy': sp.SCREEN_PROTECTION_TITLE, 'settings.screenProtection.switch': sp.SCREEN_PROTECTION_SWITCH_LABEL,
  'settings.screenProtection.platform': sp.SCREEN_PROTECTION_PLATFORM_NOTE, 'settings.screenProtection.always': sp.SCREEN_PROTECTION_ALWAYS_NOTE,
  'settings.screenProtection.applying': sp.describeScreenProtectionStatus({ state: 'applying' }),
  'settings.screenProtection.on': sp.describeScreenProtectionStatus({ state: 'on' }),
  'settings.screenProtection.releasing': sp.describeScreenProtectionStatus({ state: 'releasing' }),
  'settings.screenProtection.off': sp.describeScreenProtectionStatus({ state: 'off' }),
  'notice.importedKey': ids.IMPORTED_KEY_NOT_BACKED_UP, 'notice.watchOnly': ids.WATCH_ONLY_NOTICE,
  'home.noChain.imported': ids.IMPORTED_KEY_NO_CHAIN, 'home.noChain.watchOnly': ids.WATCH_ONLY_NO_CHAIN, 'home.noChain.multisig': ids.MULTISIG_NO_CHAIN,
  'home.multisig.notice': wo.MULTISIG_ACCOUNT_NOTICE, 'receive.multisig.note': wo.MULTISIG_RECEIVE_NOTE,
  'receive.watched.note': wo.WATCHED_ADDRESS_RECEIVE_NOTE, 'receive.title.watched': wo.WATCHED_ADDRESS_TITLE,
  'receive.recovered.note': RECOVERED_NOT_DERIVABLE_NOTE,
  'receive.smart.notDeployed': aa.SMART_ACCOUNT_NOT_DEPLOYED_NOTE, 'receive.smart.deployed': aa.SMART_ACCOUNT_DEPLOYED_NOTE,
  'receive.smart.label.recovered': aa.smartAccountAddressLabel({ recovered: true, accountType: 'kernel-v3.3' }),
  'receive.smart.label.kernel': aa.smartAccountAddressLabel({ accountType: 'kernel-v3.3' }),
  'receive.smart.label.simple': aa.smartAccountAddressLabel({ accountType: 'simple' }),
  'receive.smart.label': aa.smartAccountAddressLabel({ accountType: 'kernel-7702' }),
  'home.rebasing': REBASING_TOKEN_NOTE,
  'home.link.coldSign': COLD_SIGN_HOME_LINK.replace(/\s+↗$/, ''), 'home.link.coldSign.hint': COLD_SIGN_LINK_HINT,
  'activity.row.unavailable': as.ROW_DETAILS_UNAVAILABLE_LINE, 'activity.row.loading': as.ROW_DETAILS_LOADING_LABEL,
  'activity.failedIncoming': as.FAILED_INCOMING_TITLE, 'activity.loadMoreRetry': LOAD_MORE_RETRY_FOOTER,
  'activity.note.privacy': NOTE_PRIVACY_LINE,
  'activity.direction.in': directionLabel('in'), 'inbox.kind.sent': directionLabel('out'), 'activity.direction.self': directionLabel('self'),
  'readiness.blockers': R.PLAIN_BLOCKERS, 'readiness.blockers.protected': R.PLAIN_BLOCKERS_PROTECTED, 'readiness.blockers.unprotected': R.PLAIN_BLOCKERS_UNPROTECTED,
  'readiness.status.mainnetOk': R.READINESS_STATUS_LABEL['mainnet-ok'], 'readiness.status.testnetOnly': R.READINESS_STATUS_LABEL['testnet-only'],
  'readiness.status.blocked': R.READINESS_STATUS_LABEL.blocked,
  'settings.autoLock.off': AUTO_LOCK_CHOICES[0].label, 'settings.autoLock.1min': AUTO_LOCK_CHOICES[1].label, 'settings.autoLock.5min': AUTO_LOCK_CHOICES[2].label,
};
{
  const bad = Object.entries(CONSTANTS).filter(([id, v]) => en[id] !== v).map(([id, v]) => `${id}: ${JSON.stringify(en[id])} ≠ ${JSON.stringify(v)}`);
  check(`the ${Object.keys(CONSTANTS).length} entries that the wallet modules also export equal those constants byte for byte`, bad.length === 0, bad.slice(0, 4).join('; '));
  check('…the smart-account label for an unknown type is "Smart account" (the fall-through)', aa.smartAccountAddressLabel({ accountType: 'other' }) === 'Smart account');
}

// ---------------------------------------------------------------------------
console.log('check-i18n: the same English from the new text functions as from the old ones');
// ---------------------------------------------------------------------------
{
  const phrases = ['unknown', 'protected', 'unprotected'];
  const bad = [];
  for (const f of R.FEATURE_READINESS) {
    if (RT.readinessTitleText(f) !== f.title) bad.push(`${f.id} title`);
    for (const ph of phrases) if (RT.readinessReasonText(f, ph) !== R.readinessDisplayReason(f, ph)) bad.push(`${f.id} reason (${ph})`);
    if (RT.readinessStatusText(f.status) !== R.READINESS_STATUS_LABEL[f.status]) bad.push(`${f.id} status`);
    const oldNote = f.status === 'mainnet-ok' ? 'Cleared by the checklist.' : f.enforced
      ? 'Switched off on main networks in this build; it works on the test networks.'
      : 'Still works on mainnet in this build; not yet cleared for real funds.';
    if (RT.readinessEnforcementText(f) !== oldNote) bad.push(`${f.id} note`);
    if (RT.readinessEvidenceText(f) !== R.readinessEvidenceLine(f)) bad.push(`${f.id} evidence`);
    if (RT.readinessCardTitleText(f) !== `${f.title}: test networks only`) bad.push(`${f.id} card`);
  }
  check(`readiness: all ${R.FEATURE_READINESS.length} rows — title, reason for each of the 3 phrase states, status chip, enforcement line, evidence line, card title — equal the old text`,
    bad.length === 0, bad.join(', '));
  check('readiness: the intro and the hint equal READINESS_INTRO and READINESS_TESTNET_HINT',
    RT.readinessIntroText() === R.READINESS_INTRO && RT.readinessHintText() === R.READINESS_TESTNET_HINT);
  check('readiness: every row has a title and a reason entry', R.FEATURE_READINESS.every((f) => RT.readinessTitleId(f.id) in en && RT.readinessReasonId(f.id) in en));
}
{
  const oldUnread = (n) => (n === 0 ? 'No unread entries.' : n === 1 ? '1 unread entry.' : `${n} unread entries.`);
  const oldLink = (n) => (n > 0 ? `Inbox (${n} unread)` : 'Inbox');
  const oldKind = { 'recurring-due': 'Recurring payment', 'swap-due': 'Recurring swap', takeover: 'Security alert', 'price-alert': 'Price alert', sent: 'Sent', replacement: 'Speed-up or cancellation' };
  const oldVia = { 'in-app': 'shown in the wallet', notification: 'phone notification', scheduled: 'phone reminder set for this time' };
  const oldTarget = { Sessions: 'Opens the Sessions screen', Inheritance: 'Opens the Inheritance screen', PriceAlerts: 'Opens the price alerts', Activity: 'Opens Activity' };
  check('inbox: the unread line, the Home link and the kind / via / target labels are the old text',
    [0, 1, 2, 41].every((n) => inbox.inboxUnreadText(n) === oldUnread(n) && inbox.inboxLinkText(n) === oldLink(n)) &&
      Object.entries(oldKind).every(([k, v]) => inbox.inboxKindLabel(k) === v) &&
      Object.entries(oldVia).every(([k, v]) => inbox.inboxViaLabel(k) === v) &&
      Object.entries(oldTarget).every(([k, v]) => inbox.inboxTargetHint(k) === v));
  const now = 1_000_000;
  check('lock: the PIN and passphrase messages are the old text (wrong, wrong with a wait, too many, wait over, no PIN)',
    pin.pinAttemptMessage({ kind: 'wrong', fails: 1, until: 0 }, now) === 'Wrong PIN. Try again.' &&
      pin.pinAttemptMessage({ kind: 'wrong', fails: 5, until: now + 30_000 }, now) === 'Wrong PIN. Try again in 30 seconds.' &&
      pin.pinAttemptMessage({ kind: 'wait', until: now + 1_000 }, now) === 'Too many wrong PINs. Try again in 1 second.' &&
      pin.pinAttemptMessage({ kind: 'wait', until: now + 3_600_000 }, now) === 'Too many wrong PINs. Try again in 60 minutes.' &&
      pin.pinAttemptMessage({ kind: 'wait', until: now - 1 }, now) === pin.PIN_WAIT_OVER_MESSAGE &&
      pin.pinAttemptMessage({ kind: 'wrong', fails: 1, until: 0, lock: 'phr' }, now) === 'Wrong passphrase. Try again.' &&
      pin.pinAttemptMessage({ kind: 'wait', until: now + 29_000, lock: 'phr' }, now) === 'Too many wrong passphrases. Try again in 29 seconds.' &&
      pin.pinAttemptMessage({ kind: 'no-pin' }, now) === 'No app PIN is set on this phone.');
  check('a11y: links are spoken as before ("Send ↗" → "Send"), the Send hint names the coin, the second row of a transaction says so',
    spokenLinkText('Send ↗') === 'Send' && spokenLinkText('Passkey ✓') === 'Passkey' && spokenLinkText('Upgraded ✓') === 'Upgraded' &&
      spokenLinkText('Inheritance (demonstration)') === 'Inheritance (demonstration)' && sendLinkHint('test ETH') === 'Sends test ETH' &&
      activityRowSpokenLead({ sentence: 'x', loading: false, sameAsAbove: true, loadingLabel: 'y' }) === 'Same transaction as the row above. ');
  const banners = EVM_PROFILES.map((p) => p.bannerText).filter((b) => b !== null);
  const custom = 'TESTNET — Linea Sepolia test mode is on (a network you added). Amounts are test ETH, not real funds.';
  check(`the TESTNET banner: every built-in profile's sentence (${banners.length}) and a network the user added are shown unchanged in English`,
    banners.length === EVM_TEST_PROFILES.length && [...banners, custom, 'Something else'].every((b) => testnetBannerText(b) === b) &&
      banners.every((b) => b === I.t('banner.testnet', { network: /^TESTNET — (.+) test mode/.exec(b)[1] })));
  check('…in Spanish the network name (even a typed one) is put back unchanged into the Spanish sentence', (() => {
    I.setActiveLanguage('es');
    try {
      return testnetBannerText(custom) === 'RED DE PRUEBA: el modo de prueba Linea Sepolia está activado (una red que añadiste). Los importes son ETH de prueba, no fondos reales.' &&
        testnetBannerText(banners[0]).includes('Sepolia') && testnetBannerText('Something else') === 'Something else';
    } finally {
      I.setActiveLanguage('en');
    }
  })());
}

// ---------------------------------------------------------------------------
console.log('check-i18n: formatting (times follow the language; amounts never do)');
// ---------------------------------------------------------------------------
{
  const now = Date.UTC(2026, 9, 19, 12, 0, 0);
  const s = Math.floor(now / 1000);
  const entries = [
    { timestamp: null, confirmed: false }, { timestamp: null, confirmed: true, blockHeight: 1234 }, { timestamp: s - 5, confirmed: true },
    { timestamp: s - 600, confirmed: true }, { timestamp: s - 7_200, confirmed: true }, { timestamp: s - 86_400 * 3, confirmed: true },
    { timestamp: Date.UTC(2026, 0, 1, 12) / 1000, confirmed: true }, { timestamp: Date.UTC(2025, 8, 30, 12) / 1000, confirmed: true },
  ];
  check(`English Activity times are history.ts timestampLabel byte for byte (${entries.length} cases)`, entries.every((e) => localTimestampLabel(e, now, 'en') === timestampLabel(e, now)));
  const esOut = entries.map((e) => localTimestampLabel(e, now, 'es', false));
  check('Spanish times use the Spanish words (fixed month table without Intl)',
    esOut[0] === 'pendiente' && esOut[1] === 'bloque 1234' && esOut[2] === 'justo ahora' && esOut[3] === 'hace 10 min' && esOut[4] === 'hace 2 h' &&
      esOut[6] === '1 ene 2026' && esOut[7] === '30 sept 2025', JSON.stringify(esOut));
  const viaIntl = localTimestampLabel(entries[6], now, 'es', true);
  const intlDirect = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(entries[6].timestamp * 1000));
  check('with Intl, the Spanish date is Intl.DateTimeFormat("es", day / short month / year) exactly', viaIntl === intlDirect, viaIntl);
  const realIntl = globalThis.Intl;
  globalThis.Intl = undefined;
  const noIntl = localTimestampLabel(entries[6], now, 'es', true);
  const noIntlSep = decimalSeparatorsFor('es');
  globalThis.Intl = realIntl;
  check('without Intl the date falls back to the fixed table, and the separators to their defaults', noIntl === '1 ene 2026' && noIntlSep.decimal === ',' && noIntlSep.group === '.');
  check('the locale separators are read (en "." and ","; es "," and "."), for a later slice', JSON.stringify(decimalSeparatorsFor('en')) === JSON.stringify({ decimal: '.', group: ',' }) &&
    JSON.stringify(decimalSeparatorsFor('es')) === JSON.stringify({ decimal: ',', group: '.' }));
  // The exact-amount rules: the same strings whatever the language.
  const amounts = () => [
    aa.exactAmountText(123_456_789_012_345_678n, 18), aa.exactAmountText(1n, 18), aa.exactAmountText(1_500_000n, 6),
    formatBalanceDisplay(107_672_250_846n, 18), formatBalanceDisplay(1_234_567_890_000_000_000_000n, 18), formatBalanceDisplay(0n, 8),
  ];
  const enAmounts = amounts();
  I.setActiveLanguage('es');
  const esAmounts = amounts();
  I.setActiveLanguage('en');
  check('the exact amount strings are byte-identical in English and in Spanish (no amount is localized)',
    JSON.stringify(enAmounts) === JSON.stringify(esAmounts) && enAmounts[0] === '0.123456789012345678' && enAmounts[1] === '0.000000000000000001' && enAmounts[3] === '< 0.000001',
    JSON.stringify(esAmounts));
  check('…and under English they are the strings the older suites pin', enAmounts[2] === '1.5' && enAmounts[5] === '0');
}

// ---------------------------------------------------------------------------
console.log('check-i18n: source scans (the accessor is the one door to the tables)');
// ---------------------------------------------------------------------------
function sourceFiles() {
  const out = [{ f: 'App.tsx', src: read('App.tsx') }];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) out.push({ f: relative(APP, p), src: readFileSync(p, 'utf8') });
    }
  })(SRC);
  return out;
}
const FILES = sourceFiles();
function collapseJsx(raw) {
  const lines = raw.split(/\r\n|\n|\r/);
  let last = 0;
  for (let i = 0; i < lines.length; i++) if (/[^ \t]/.test(lines[i])) last = i;
  let str = '';
  for (let i = 0; i < lines.length; i++) {
    let x = lines[i].replace(/\t/g, ' ');
    if (i !== 0) x = x.replace(/^[ ]+/, '');
    if (i !== lines.length - 1) x = x.replace(/[ ]+$/, '');
    if (x) { if (i !== last) x += ' '; str += x; }
  }
  return str.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}
/** Every use of the accessor's call-site forms in one file. */
function scanFile({ f, src }) {
  const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, f.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const r = { tx: [], tIds: [], tLiteral: [], tExpr: [], tOutsideText: [], literals: new Set() };
  const strOf = (n) => (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? n.text : null);
  (function visit(n, inText) {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      const name = n.expression.text;
      const arg = n.arguments[0] ? strOf(n.arguments[0]) : null;
      if (name === 'tx' && arg !== null) r.tx.push(arg);
      if (name === 't' && arg !== null) r.tIds.push(arg);
    }
    const s = strOf(n);
    if (s !== null) r.literals.add(s);
    if (ts.isJsxText(n)) {
      const c = collapseJsx(n.text);
      if (c.trim()) { r.literals.add(c); r.literals.add(c.trim()); }
    }
    let text = inText;
    if (ts.isJsxElement(n)) {
      const tag = n.openingElement.tagName.getText(sf);
      if (tag === 'Text') text = true;
      if (tag === 'T') {
        if (!inText) r.tOutsideText.push(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
        for (const c of n.children) {
          if (ts.isJsxText(c)) { const v = collapseJsx(c.text).trim(); if (v) r.tLiteral.push(v); }
          else if (ts.isJsxExpression(c) && c.expression) r.tExpr.push(c.expression.getText(sf));
        }
      }
    }
    ts.forEachChild(n, (ch) => visit(ch, text));
  })(sf, false);
  return r;
}
const SCANS = FILES.map((x) => ({ f: x.f, ...scanFile(x) }));
const isEntryOrDecorated = (text) => I.idOfEnglish(text) !== null || I.localizeIn('es', text) !== text;
{
  const app = SCANS.filter((s) => !s.f.startsWith('src/i18n/'));
  const txAll = app.flatMap((s) => s.tx.map((v) => [s.f, v]));
  const txBad = txAll.filter(([, v]) => I.idOfEnglish(v) === null);
  check(`every tx('…') literal is a placeholder-free English entry (${txAll.length} calls)`, txAll.length >= 60 && txBad.length === 0, txBad.slice(0, 3).map((x) => x.join(': ')).join('; '));
  const tLit = app.flatMap((s) => s.tLiteral.map((v) => [s.f, v]));
  const tLitBad = tLit.filter(([, v]) => !isEntryOrDecorated(v));
  check(`every <T>text</T> is an English entry (or a decorated one) (${tLit.length} uses)`, tLit.length >= 30 && tLitBad.length === 0, tLitBad.slice(0, 3).map((x) => x.join(': ')).join('; '));
  const tExpr = app.flatMap((s) => s.tExpr.map((v) => [s.f, v]));
  const allowedCalls = /^lockScreenHint\(reconciled\.startedLocked\)$/;
  const exportedNames = new Map(Object.entries({
    INBOX_INTRO: 'inbox.intro', INBOX_PIN_NOTE: 'inbox.pinNote', INBOX_PASSPHRASE_NOTE: 'inbox.passphraseNote',
    NOTIFICATIONS_OFF_WITH_PASSPHRASE: 'settings.notifications.offWithPassphrase', AUTO_LOCK_HINT_WITH_PASSPHRASE: 'settings.autoLock.hintWithPassphrase',
    AUTO_LOCK_WITH_PASSPHRASE_NOTE: 'settings.autoLock.withPassphraseNote', SCREEN_PROTECTION_WITH_PASSPHRASE_NOTE: 'settings.screenProtection.withPassphrase', INBOX_EMPTY: 'inbox.empty', INBOX_SCHEDULED_NOTE: 'inbox.scheduledNote',
    NOTIFICATIONS_SECTION_TITLE: 'settings.notifications', NOTIFICATIONS_OFF_WITH_PIN: 'settings.notifications.offWithPin',
    AUTO_LOCK_HINT_WITH_PIN: 'settings.autoLock.hintWithPin', AUTO_LOCK_WITH_PIN_NOTE: 'settings.autoLock.withPinNote',
    SCREEN_PROTECTION_TITLE: 'settings.section.privacy', SCREEN_PROTECTION_SWITCH_LABEL: 'settings.screenProtection.switch',
    SCREEN_PROTECTION_WITH_PIN_NOTE: 'settings.screenProtection.withPin', SCREEN_PROTECTION_PLATFORM_NOTE: 'settings.screenProtection.platform',
    SCREEN_PROTECTION_ALWAYS_NOTE: 'settings.screenProtection.always', SPENDING_SECTION_TITLE: 'settings.section.spending',
    WATCHED_ADDRESS_RECEIVE_NOTE: 'receive.watched.note', MULTISIG_RECEIVE_NOTE: 'receive.multisig.note', RECOVERED_NOT_DERIVABLE_NOTE: 'receive.recovered.note',
    ROW_DETAILS_UNAVAILABLE_LINE: 'activity.row.unavailable', LOAD_MORE_RETRY_FOOTER: 'activity.loadMoreRetry',
  }));
  // `text` is Home's cardLink (its callers pass English literals, scanned as literals below).
  // Phase 22 polish: an app-lock note picked by the lock's kind,
  // `<kind> === 'phr' ? <passphrase constant> : <PIN constant>`, both known.
  const lockKindPick = (v) => {
    const m = /^(settingsLockKind|inboxLockKind) === 'phr' \? ([A-Z_]+) : ([A-Z_]+)$/.exec(v);
    return m !== null && exportedNames.has(m[2]) && exportedNames.has(m[3]) && m[2].includes('PASSPHRASE') && m[3].includes('PIN');
  };
  const tExprBad = tExpr.filter(([, v]) => !(v === 'text' || allowedCalls.test(v) || exportedNames.has(v) || lockKindPick(v)));
  check(`every <T>{…}</T> is a known constant, a PIN / passphrase pair picked by the lock's kind, lockScreenHint(…) or Home's link text (${tExpr.length} uses)`, tExprBad.length === 0, tExprBad.map((x) => x.join(': ')).join('; '));
  const picks = tExpr.filter(([, v]) => lockKindPick(v));
  check(`…the kind-picked app-lock notes: Settings' auto-lock hint and note, screen protection and notifications, and the inbox note (${picks.length})`,
    picks.length === 5 && ['AUTO_LOCK_HINT_WITH_PASSPHRASE', 'AUTO_LOCK_WITH_PASSPHRASE_NOTE', 'SCREEN_PROTECTION_WITH_PASSPHRASE_NOTE', 'NOTIFICATIONS_OFF_WITH_PASSPHRASE', 'INBOX_PASSPHRASE_NOTE']
      .every((n) => picks.some(([, v]) => v.includes(`? ${n} :`))));
  check('…mutant caught (polish): a pair whose passphrase branch is a PIN constant', !lockKindPick("settingsLockKind === 'phr' ? AUTO_LOCK_HINT_WITH_PIN : AUTO_LOCK_HINT_WITH_PIN"));
  const { SPENDING_SECTION_TITLE } = await import('../src/wallet/spending-policy.ts');
  check('…and each of those constants is an entry with the same English (the spending title too)',
    [...exportedNames.values()].every((id) => id in en && (CONSTANTS[id] === undefined || CONSTANTS[id] === en[id])) && SPENDING_SECTION_TITLE === en['settings.section.spending']);
  const outside = app.flatMap((s) => s.tOutsideText.map((l) => `${s.f}:${l}`));
  check('every <T> sits inside a <Text> (it renders a bare string)', outside.length === 0, outside.join(', '));
  const tIds = app.flatMap((s) => s.tIds.map((v) => [s.f, v]));
  const tIdBad = tIds.filter(([, v]) => !(v in en));
  check(`every t('id') names an existing entry (${tIds.length} calls)`, tIds.length >= 80 && tIdBad.length === 0, tIdBad.slice(0, 3).map((x) => x.join(': ')).join('; '));
  const tables = FILES.filter((x) => !x.f.startsWith('src/i18n/') && /from '[^']*i18n\/(en|es)(\.ts)?'/.test(x.src)).map((x) => x.f);
  check('only the accessor reads the tables (no file outside src/i18n imports en.ts or es.ts)', tables.length === 0, tables.join(', '));
}
// No unused ids: every entry is reached from the app's source.
function unusedIds(table, scans) {
  const app = scans.filter((s) => !s.f.startsWith('src/i18n/en') && !s.f.startsWith('src/i18n/es'));
  const literals = new Set(app.flatMap((s) => [...s.literals]));
  const decorated = new Set([...literals].map((v) => /^(✓\s+)?(.*?)(\s+[↗✓])?$/s.exec(v)?.[2]).filter(Boolean));
  const idRefs = new Set([...literals].filter((v) => v in table));
  const computed = new Set(R.FEATURE_READINESS.flatMap((f) => [RT.readinessTitleId(f.id), RT.readinessReasonId(f.id)]));
  // Constants: an entry whose English is exported by a wallet module and shown through a sink.
  const constants = new Set(Object.keys(CONSTANTS));
  return Object.keys(table).filter((id) => {
    const text = table[id];
    return !(idRefs.has(id) || computed.has(id) || constants.has(id) || literals.has(text) || decorated.has(text));
  });
}
{
  const unused = unusedIds(en, SCANS);
  check('no unused ids: every entry is named by id, computed for a readiness row, exported by a wallet module, or its English still stands at a call site',
    unused.length === 0, unused.join(', '));
}

// ---------------------------------------------------------------------------
console.log('check-i18n: the stored language choice (device-wide, through the storage seam)');
// ---------------------------------------------------------------------------
function memoryStore() {
  const map = new Map();
  return { map, getItem: async (k) => (map.has(k) ? map.get(k) : null), setItem: async (k, v) => { map.set(k, v); }, removeItem: async (k) => { map.delete(k); } };
}
{
  check('the key is declared in the seam: shiba-wallet.language.v1, device scope, AsyncStorage',
    STORE_KEYS.language.name === 'shiba-wallet.language.v1' && STORE_KEYS.language.scope === 'device' && STORE_KEYS.language.backing === 'async-storage' &&
      storeKeyScope('shiba-wallet.language.v1') === 'device' && LS.LANGUAGE_STORE_KEY === 'shiba-wallet.language.v1');
  check('the stored form is {"v":1,"language":…} and reads back',
    LS.serializeLanguageChoice('es') === '{"v":1,"language":"es"}' && ['system', 'en', 'es'].every((c) => LS.parseLanguageChoice(LS.serializeLanguageChoice(c)) === c));
  check('a missing or malformed record reads as "system" (wrong version, extra key, unknown language, not JSON, an array)',
    [null, '{"v":2,"language":"es"}', '{"v":1,"language":"es","x":1}', '{"v":1,"language":"fr"}', 'es', '[]', '{"language":"es"}', '', 'null'].every((raw) => LS.parseLanguageChoice(raw) === 'system'));
  check('serializing an unknown choice throws', (() => { try { LS.serializeLanguageChoice('fr'); return false; } catch { return true; } })());
  const store = memoryStore();
  await LS.saveLanguageChoice(store, 'es');
  check('saved through the seam under exactly that key', store.map.get('shiba-wallet.language.v1') === '{"v":1,"language":"es"}' && store.map.size === 1);
  check('loaded back', (await LS.loadLanguageChoice(store)) === 'es');
  const decoy = profileBoundStore(store, { keyPrefix: 'w2' });
  check('a second wallet profile (a duress decoy) reads the SAME choice (device scope, never prefixed)', (await LS.loadLanguageChoice(decoy)) === 'es');
  await LS.saveLanguageChoice(decoy, 'en');
  check('…and its change is the phone\'s change (one record, unprefixed)', store.map.size === 1 && store.map.get('shiba-wallet.language.v1') === '{"v":1,"language":"en"}');
  const broken = { getItem: async () => { throw new Error('storage down'); }, setItem: async () => { throw new Error('storage down'); } };
  check('an unreadable store reads as "system"', (await LS.loadLanguageChoice(broken)) === 'system');
}
{
  // The controller, with the applied language recorded instead of the module state.
  const make = (store, tag = 'es_ES') => {
    const applied = [];
    const c = createLanguageController({ store, deviceTag: () => tag, apply: (l) => applied.push(l) });
    return { c, applied };
  };
  const s1 = memoryStore();
  await LS.saveLanguageChoice(s1, 'en');
  const a = make(s1);
  const started = a.c.start();
  const sync = [...a.applied];
  await started;
  check('start applies the device language at once (before the stored choice is read), then the stored choice',
    sync.join() === 'es' && a.applied.join() === 'es,en' && a.c.choice() === 'en' && a.c.language() === 'en');
  check('start runs once', (await a.c.start(), a.applied.length === 2));
  const b = make(memoryStore(), 'en_US');
  await b.c.start();
  check('with nothing stored the choice is "system" and follows the device', b.c.choice() === 'system' && b.c.language() === 'en');
  let notified = 0;
  b.c.subscribe(() => { notified += 1; });
  await b.c.choose('es');
  check('choose saves first, then applies and notifies', b.c.language() === 'es' && b.applied.at(-1) === 'es' && notified === 1);
  const failing = memoryStore();
  failing.setItem = async () => { throw new Error('disk full'); };
  const d = make(failing, 'en_US');
  await d.c.start();
  const before = d.applied.length;
  const refused = await d.c.choose('es').then(() => false, () => true);
  check('a failed save throws and changes nothing (no language applied, the choice unchanged)', refused && d.applied.length === before && d.c.choice() === 'system' && d.c.language() === 'en');
  const slow = memoryStore();
  await LS.saveLanguageChoice(slow, 'en');
  const realGet = slow.getItem;
  let release;
  slow.getItem = (k) => new Promise((resolve) => { release = () => resolve(realGet(k)); });
  const e = make(slow, 'en_US');
  const pending = e.c.start();
  await e.c.choose('es');
  release();
  await pending;
  check('a choice made while the stored one is still being read wins over the late read', e.c.choice() === 'es' && e.c.language() === 'es');
}
{
  const app = read('App.tsx');
  const settings = read('src/screens/SettingsScreen.tsx');
  check('the app starts the controller during its first render (React.useState initializer)', app.includes('React.useState(() => appLanguage().start());'));
  check('Settings offers System / English / Español from LANGUAGE_CHOICES through the controller, and says when a save failed',
    settings.includes('<LanguageSection />') && settings.includes('LANGUAGE_CHOICES.map((c) => {') && settings.includes("controller.choose(next).catch(() => setFailed(true));") &&
      settings.includes("t('settings.language.saveFailed')"));
  // Phase 22 polish (the guardian share-text residual): texts prepared for
  // someone else stay in English and name the English screens; the Language
  // section says so instead of translating them (the reader's language is
  // not the sender's).
  const recoverySrc = read('src/wallet/recovery.ts');
  const multisigSrc = read('src/wallet/multisig.ts');
  const sharedNoteShown = (src) =>
    /<Text style=\{\[styles\.hint, \{ color: theme\.textMuted \}\]\}>\{t\('settings\.language\.amounts'\)\}<\/Text>\s*<Text style=\{\[styles\.hint, \{ color: theme\.textMuted \}\]\}>\{t\('settings\.language\.shared'\)\}<\/Text>/.test(src);
  check('Settings → Language says texts for someone else stay in English and name English screens (exact), after the amounts note',
    en['settings.language.shared'] === 'Texts the wallet prepares for someone else to read, such as a recovery request for your guardians or a multisig signing request, stay in English in every language, and the screens they point to are named in English (for example Settings → Guardians (social recovery)).' &&
      typeof es['settings.language.shared'] === 'string' && es['settings.language.shared'].includes('Settings → Guardians (social recovery)') && sharedNoteShown(settings));
  check('…and that is true: the guardian and multisig share texts are built without the accessor, and the guardian one names the English path',
    !/from '\.\.\/i18n|from '\.\.\/i18n\/index/.test(recoverySrc) && !/i18n/.test(multisigSrc.split('\n').filter((l) => l.startsWith('import')).join('\n')) &&
      recoverySrc.includes("'Shiba Wallet: Settings → Guardians (social recovery) → Approve a recovery (as a guardian), then paste '"));
  check('…mutant caught (polish): the shared-texts sentence dropped from the Language section',
    !sharedNoteShown(settings.replace("{t('settings.language.shared')}", '')));
}

// ---------------------------------------------------------------------------
console.log('check-i18n: mutants (each must be caught)');
// ---------------------------------------------------------------------------
const MUTANT_DIR = join(HERE, `.mutants-i18n-${process.pid}`);
mkdirSync(MUTANT_DIR, { recursive: true });
process.on('exit', () => rmSync(MUTANT_DIR, { recursive: true, force: true }));
let mutants = 0;
let mutantsCaught = 0;
/** Imports a copy of src/i18n/<file> with one replacement; its relative imports point at the real modules. */
async function mutant(file, from, to) {
  const src = read(`src/i18n/${file}`);
  if (!src.includes(from)) throw new Error(`mutant anchor missing in ${file}: ${from}`);
  let text = src.replace(from, to);
  const i18nDir = pathToFileURL(join(SRC, 'i18n')).href;
  const srcDir = pathToFileURL(SRC).href;
  text = text.replace(/from '\.\/([^']+)'/g, (_, p) => `from '${i18nDir}/${p}'`).replace(/from '\.\.\/([^']+)'/g, (_, p) => `from '${srcDir}/${p}'`);
  mutants += 1;
  const out = join(MUTANT_DIR, `m${mutants}-${file}`);
  writeFileSync(out, text);
  return import(pathToFileURL(out).href);
}
function caught(name, wasCaught) {
  if (wasCaught) mutantsCaught += 1;
  check(`mutant caught: ${name}`, wasCaught);
}
{
  const m = await mutant('index.ts', "return fill(typeof own === 'string' ? own : (tables.en[id] ?? en[id]), params);", 'return fill(typeof own === \'string\' ? own : id, params);');
  caught('no English fallback (a missing Spanish entry shows its id)', m.translateFrom({ en, es: {} }, 'es', 'inbox.empty') !== en['inbox.empty']);
}
{
  const m = await mutant('index.ts', '  if (!m || (!m[1] && !m[3])) return text;', '  if (!m || true) return text;');
  caught('decorated labels no longer translated ("Send ↗" stays English)', m.localizeIn('es', 'Send ↗') !== 'Enviar ↗');
}
{
  const m = await mutant('index.ts', "  const own = tables[language][id];", "  const own = tables.es[id];");
  caught('the language ignored (Spanish shown whatever the language)', m.translateFrom({ en, es }, 'en', 'inbox.empty') !== en['inbox.empty']);
}
{
  const m = await mutant('language-store.ts', '    return LANGUAGE_CHOICES.includes(record.language as LanguageChoice) ? (record.language as LanguageChoice) : \'system\';', "    return record.language as LanguageChoice;");
  caught('the stored choice accepted whatever language it names', m.parseLanguageChoice('{"v":1,"language":"fr"}') !== 'system');
}
{
  const m = await mutant('app-language.ts', '      await saveLanguageChoice(deps.store, choice);\n      chosenThisLaunch = true;\n      set(choice);', '      chosenThisLaunch = true;\n      set(choice);\n      await saveLanguageChoice(deps.store, choice);');
  const failing = memoryStore();
  failing.setItem = async () => { throw new Error('disk full'); };
  const applied = [];
  const c = m.createLanguageController({ store: failing, deviceTag: () => 'en', apply: (l) => applied.push(l) });
  await c.start();
  await c.choose('es').catch(() => {});
  caught('applied before the save (a failed save would still switch the language)', c.language() === 'es');
}
{
  const m = await mutant('format.ts', "  if (language === 'en') return timestampLabel(entry, nowMs);", "  if (language === 'xx') return timestampLabel(entry, nowMs);");
  const now = Date.UTC(2026, 9, 19, 12);
  const old = { timestamp: Math.floor(now / 1000) - 86_400 * 3, confirmed: true };
  caught('English Activity times no longer history.ts timestampLabel (a date three days back)', m.localTimestampLabel(old, now, 'en', false) !== timestampLabel(old, now));
}
{
  const m = await mutant('readiness-text.ts', "  protected: 'readiness.blockers.protected',\n  unprotected: 'readiness.blockers.unprotected',", "  protected: 'readiness.blockers.unprotected',\n  unprotected: 'readiness.blockers.protected',");
  const f = R.featureReadiness('eoa-send');
  caught('the phrase-protection clauses swapped in the readiness reasons', m.readinessReasonText(f, 'protected') !== R.readinessDisplayReason(f, 'protected'));
}
{
  const m = await mutant('banner.ts', "  if (custom) return t('banner.testnet.custom', { network: custom[1], symbol: custom[2] });", "  if (custom) return t('banner.testnet', { network: custom[1] });");
  const custom = 'TESTNET — Linea Sepolia test mode is on (a network you added). Amounts are test ETH, not real funds.';
  caught('a network the user added banner-ed like a built-in one (its words lost)', m.testnetBannerText(custom) !== custom);
}
// Table mutants: the same checks, run on broken copies of the tables.
{
  const esBroken = { ...es, 'home.token.send': 'Enviar' };
  caught('a Spanish entry that dropped its placeholder', placeholders(en['home.token.send']).join() !== placeholders(esBroken['home.token.send']).join());
  const esMissing = { ...es };
  delete esMissing['inbox.empty'];
  caught('a Spanish table missing an id', EN_IDS.some((id) => typeof esMissing[id] !== 'string'));
  const fixtureBadBefore = { ...FIXTURE, changed: { ...FIXTURE.changed, 'activity.note.privacy': { ...FIXTURE.changed['activity.note.privacy'], before: 'Notes are kept only on this phone.' } } };
  caught('a changed entry whose "before" is not the text at the base commit (a silent rewrite of history)', fixtureProblems(en, fixtureBadBefore).length === 1);
  const enChanged = { ...en, 'home.manageTokens': 'Manage Tokens' };
  caught('an English entry changed by one character (no longer the text before)', fixtureProblems(enChanged, FIXTURE).length === 1);
  const enExtra = { ...en, 'home.unusedThing': 'A sentence no screen shows.' };
  caught('an unused id added to the table', unusedIds(enExtra, SCANS).includes('home.unusedThing') && fixtureProblems(enExtra, FIXTURE).length === 1);
}
check(`at least six mutants, all caught (${mutantsCaught} of ${mutants + 5} including the table mutants)`, mutants + 5 >= 6 && mutantsCaught === mutants + 5);

console.log(`\ncheck-i18n: ${passed} passed, ${failed} failed (${mutants + 5} mutants)`);
if (failed > 0) process.exit(1);
