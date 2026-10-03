// Settings "Recovery phrase protection" copy, entirely OFFLINE: pins every
// status sentence, the confirm dialog and the outcome alerts produced by
// src/wallet/phrase-protection-copy.ts for each storageProtection() /
// upgradePhraseProtection() state documented in src/wallet/storage.ts,
// and drives the real key vault (createKeyVault over an in-memory
// secure-store fake) through opt-in → protect → biometric change so the
// copy is checked against statuses the vault itself produces.
//
// Run from the app directory:
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-settings-protection.mjs
//
// The phrase used is the public BIP-39 test mnemonic ("abandon … about").

import { readFileSync } from 'node:fs';
import {
  PHRASE_UNREADABLE_MESSAGE,
  createKeyVault,
} from '../src/wallet/storage.ts';
import {
  CANCELLED_TEXT,
  NOT_ATTEMPTED_TEXT,
  PROTECT_BUTTON_TITLE,
  PROTECT_CONFIRM_MESSAGE,
  PROTECT_CONFIRM_TITLE,
  STANDARD_COPY_NOTE,
  describeProtectionStatus,
  describeRevealFailure,
  describeUpgradeOutcome,
  protectionDate,
} from '../src/wallet/phrase-protection-copy.ts';

let passed = 0;
let failed = 0;
function check(name, ok) {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}`);
  }
}

const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const SINCE = Date.UTC(2026, 9, 2, 12, 0, 0);

function status(over) {
  return {
    phrase: 'standard',
    reason: 'not-attempted',
    detail: null,
    biometricsAvailable: true,
    protectedSince: null,
    standardCopyPresent: true,
    sessionKeys: 'standard',
    policy: 'opt-in',
    canProtectNow: true,
    ...over,
  };
}

// Exact strings from the task brief (do not reword).
const EXPECTED = {
  protected:
    'Your recovery phrase is protected by biometrics (since 2026-10-02). Opening it needs your fingerprint or face every time. If you add or remove a fingerprint or face, or turn off the screen lock, this phone can no longer open it — keep your written recovery phrase safe.',
  standardNote: 'An unprotected copy is still being removed; it goes the next time you approve something.',
  noStrong:
    'This phone has no strong fingerprint or face unlock enrolled, so the phrase is in standard secure storage: code inside the app can read it while the phone is unlocked, and your screen lock is the main protection.',
  notAttempted:
    'Your recovery phrase is in standard secure storage. You can move it into biometric-protected storage below.',
  cancelled: 'Moving your phrase to biometric protection was cancelled.',
  platformRefused:
    'This phone refused biometric-protected storage (KeyStore error 7); the phrase stays in standard secure storage.',
  verifyFailed:
    'The protected copy could not be confirmed, so it was discarded; the phrase stays in standard storage (The protected copy read back different from the original.).',
  reverted: 'The protected copy stopped working after a biometric change; the wallet is using its standard copy.',
  policyOff: 'Biometric protection is turned off for this build.',
  confirm:
    'After this, opening your recovery phrase needs your fingerprint or face. If you ever add or remove a fingerprint or face, or turn off the screen lock, this phone will no longer be able to open the phrase and you will need your written backup. Make sure your written recovery phrase is safe before continuing.',
};

console.log('check-settings-protection: status copy');
{
  const v = describeProtectionStatus(
    status({ phrase: 'protected', reason: null, protectedSince: SINCE, standardCopyPresent: false, canProtectNow: false }),
  );
  check('protected: exact sentence with the date', v.text === EXPECTED.protected);
  check('protected: no removal note when no standard copy is left', v.note === null);
  check('protected: no button, not a warning', !v.showProtectButton && !v.warning);
  const w = describeProtectionStatus(
    status({ phrase: 'protected', reason: null, protectedSince: SINCE, standardCopyPresent: true, canProtectNow: false }),
  );
  check('protected + standard copy present: removal note', w.note === EXPECTED.standardNote && STANDARD_COPY_NOTE === EXPECTED.standardNote);
  check('protected with an unknown date says so', describeProtectionStatus(status({ phrase: 'protected', reason: null, protectedSince: null, canProtectNow: false })).text.includes('(since unknown date)'));
  check('protectionDate is YYYY-MM-DD (UTC)', protectionDate(SINCE) === '2026-10-02' && protectionDate(Number.NaN) === 'unknown date');

  const u = describeProtectionStatus(status({ phrase: 'unreadable', reason: null, detail: PHRASE_UNREADABLE_MESSAGE, canProtectNow: false }));
  check('unreadable: PHRASE_UNREADABLE_MESSAGE verbatim, as a warning, no button', u.text === PHRASE_UNREADABLE_MESSAGE && u.warning && !u.showProtectButton);

  const cases = [
    ['no-strong-biometrics', { canProtectNow: false, biometricsAvailable: false }, EXPECTED.noStrong, false],
    ['not-attempted', {}, EXPECTED.notAttempted, true],
    ['cancelled', { detail: 'User canceled' }, EXPECTED.cancelled, true],
    ['platform-refused', { detail: 'KeyStore error 7' }, EXPECTED.platformRefused, true],
    ['verify-failed', { detail: 'The protected copy read back different from the original.' }, EXPECTED.verifyFailed, true],
    ['reverted', { detail: null }, EXPECTED.reverted, true],
    ['policy-off', { canProtectNow: false, policy: 'off' }, EXPECTED.policyOff, false],
  ];
  for (const [reason, over, text, button] of cases) {
    const v2 = describeProtectionStatus(status({ reason, ...over }));
    check(`standard/${reason}: exact sentence`, v2.text === text);
    check(`standard/${reason}: button ${button ? 'shown' : 'hidden'} (follows canProtectNow)`, v2.showProtectButton === button);
  }
  check('platform-refused without detail drops the parentheses',
    describeProtectionStatus(status({ reason: 'platform-refused', detail: null })).text ===
      'This phone refused biometric-protected storage; the phrase stays in standard secure storage.');
  check('none: nothing shown, no button', describeProtectionStatus(status({ phrase: 'none', reason: null, canProtectNow: false })).text === null);
  check('exported constants match the brief', NOT_ATTEMPTED_TEXT === EXPECTED.notAttempted && CANCELLED_TEXT === EXPECTED.cancelled);
}

console.log('check-settings-protection: confirm dialog and outcome alerts');
{
  check('button title', PROTECT_BUTTON_TITLE === 'Protect with biometrics');
  check('confirm message exact', PROTECT_CONFIRM_MESSAGE === EXPECTED.confirm && PROTECT_CONFIRM_TITLE.length > 0);
  check('outcome protected', describeUpgradeOutcome({ outcome: 'protected', detail: null }).title === 'Recovery phrase protected');
  check('outcome cancelled starts with the status sentence', describeUpgradeOutcome({ outcome: 'cancelled', detail: 'x' }).message.startsWith(EXPECTED.cancelled));
  check('outcome platform-refused carries the detail', describeUpgradeOutcome({ outcome: 'platform-refused', detail: 'KeyStore error 7' }).message === EXPECTED.platformRefused);
  check('outcome verify-failed carries the detail',
    describeUpgradeOutcome({ outcome: 'verify-failed', detail: 'The protected copy read back different from the original.' }).message === EXPECTED.verifyFailed);
  const f = describeUpgradeOutcome({ outcome: 'failed', detail: 'disk full' });
  check('outcome failed names the detail and claims nothing about where the phrase is', f.message.includes('(disk full)') && !/stays in standard/.test(f.message));
  for (const o of ['already-protected', 'no-wallet', 'no-strong-biometrics', 'policy-off', 'skipped']) {
    const a = describeUpgradeOutcome({ outcome: o, detail: null });
    check(`outcome ${o} has a title and message`, a.title.length > 0 && a.message.length > 0);
  }
}

console.log('check-settings-protection: reveal failure');
{
  const r = describeRevealFailure(status({ phrase: 'unreadable', reason: null, canProtectNow: false }));
  check('unreadable → PHRASE_UNREADABLE_MESSAGE', r.message === PHRASE_UNREADABLE_MESSAGE);
  for (const p of ['unreadable', 'none', 'protected', 'standard']) {
    const m = describeRevealFailure(status({ phrase: p })).message;
    check(`${p}: no "No recovery phrase found" wording`, !/No recovery phrase found/i.test(m));
  }
}

console.log('check-settings-protection: against the real vault');
{
  // In-memory expo-secure-store fake: protected items are bound to a
  // "biometric set" that a test can change (the platform then deletes or
  // refuses to open them).
  const items = new Map();
  let bioSet = 1;
  let cancelNext = false;
  const backend = {
    async getItemAsync(key, opts) {
      const it = items.get(key);
      if (!it) return null;
      if (opts?.requireAuthentication) {
        if (cancelNext) {
          cancelNext = false;
          throw new Error('User canceled the authentication');
        }
        if (it.bio !== bioSet) return null;
      }
      return it.value;
    },
    async setItemAsync(key, value, opts) {
      if (opts?.requireAuthentication && cancelNext) {
        cancelNext = false;
        throw new Error('User canceled the authentication');
      }
      items.set(key, { value, bio: opts?.requireAuthentication ? bioSet : null });
    },
    async deleteItemAsync(key) {
      items.delete(key);
    },
    canUseBiometricAuthentication() {
      return true;
    },
    whenUnlockedThisDeviceOnly: 0,
  };
  const vault = createKeyVault(backend, { now: () => SINCE });
  await vault.saveNewPhrase(PHRASE);
  let st = await vault.status();
  check('opt-in fresh wallet → not-attempted copy with the button',
    describeProtectionStatus(st).text === EXPECTED.notAttempted && describeProtectionStatus(st).showProtectButton);

  cancelNext = true;
  let r = await vault.upgrade({});
  st = await vault.status();
  check('cancelled upgrade → cancelled alert and cancelled status with the button',
    r.outcome === 'cancelled' && describeProtectionStatus(st).text === EXPECTED.cancelled && describeProtectionStatus(st).showProtectButton);

  r = await vault.upgrade({});
  st = await vault.status();
  check('protect → "Recovery phrase protected" alert', describeUpgradeOutcome(r).title === 'Recovery phrase protected');
  check('protected status sentence from the vault', describeProtectionStatus(st).text === EXPECTED.protected && !describeProtectionStatus(st).showProtectButton);

  bioSet = 2; // a fingerprint was added
  let read = null;
  try {
    read = await vault.readPhrase('Reveal recovery phrase');
  } catch {
    read = null; // WalletContext.revealMnemonic swallows errors into null
  }
  st = await vault.status();
  check('after a biometric change the reveal yields nothing', read === null);
  check('…and the fresh status explains it with PHRASE_UNREADABLE_MESSAGE',
    st.phrase === 'unreadable' && describeRevealFailure(st).message === PHRASE_UNREADABLE_MESSAGE &&
      describeProtectionStatus(st).text === PHRASE_UNREADABLE_MESSAGE);
}

console.log('check-settings-protection: source rules');
{
  const src = readFileSync(new URL('../src/screens/SettingsScreen.tsx', import.meta.url), 'utf8');
  check('Settings no longer says "No recovery phrase found"', !/No recovery phrase found/.test(src));
  check('Settings calls upgradePhraseProtection only from the confirm dialog',
    (src.match(/upgradePhraseProtection\(/g) ?? []).length === 1 && /PROTECT_CONFIRM_MESSAGE/.test(src));
  check('Settings re-reads the status on focus', /useFocusEffect\(reloadProtection\)/.test(src));
}

console.log(`\ncheck-settings-protection: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
