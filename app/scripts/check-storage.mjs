// Threat-model finding N-01: the recovery phrase in biometric-protected
// secure storage. Exercises src/wallet/storage.ts (the exact module the app
// runs, under Node's type stripping) against a FAKE expo-secure-store that
// models the documented platform behaviour of expo-secure-store 57.0.4:
//
//  - Android: a requireAuthentication item prompts on every write AND read
//    (AESEncryptor.createEncryptedItem / decryptItem → BiometricPrompt);
//  - iOS: creating a new protected item does not prompt, reading or
//    updating one does (SecureStoreModule.swift set / update / get);
//  - iOS Expo Go: the protected write throws the module's
//    MissingPlistKeyException text;
//  - a biometric change invalidates protected items: reads return null
//    (Android KeyPermanentlyInvalidatedException → null);
//  - a user cancel is an error whose text contains "cancel".
//
// Covered: the migration state machine with a failure injected at every
// step (the phrase must stay readable after every one of them), interrupted
// migrations, invalidation with and without a leftover standard copy, the
// approval gate (one system prompt per operation, the single-use 30-second
// hold, cancel and fallback paths, the automatic upgrade at the first
// approval), corrupt meta handling, wipe, the public account cache, the
// session-key vault, the status reported to Settings, and source checks
// that the app reads the phrase only through storage.ts.
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-storage.mjs
//
// No device, no network. The phrase used is the public BIP-39 test vector.

import { readFileSync } from 'node:fs';
import {
  MNEMONIC_KEY,
  OTHER_WALLET_STORED_MESSAGE,
  PROTECTED_KEYCHAIN_SERVICE,
  PROTECTED_MNEMONIC_KEY,
  PHRASE_PROTECTION_POLICY,
  PHRASE_TICKET_TTL_MS,
  PHRASE_UNREADABLE_MESSAGE,
  PhraseAccessError,
  VAULT_META_KEY,
  createKeyVault,
  isCancellation,
  parseVaultMeta,
} from '../src/wallet/storage.ts';

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const OTHER = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

const ANDROID_CANCEL =
  'Could not Authenticate the user: User canceled the authentication. Cancel';
const IOS_CANCEL = 'User canceled the operation.';
const IOS_EXPO_GO =
  'You must set `NSFaceIDUsageDescription` in your Info.plist file to use the `requireAuthentication` option';

/**
 * Fake expo-secure-store. `fail` rules inject errors (or corrupt writes) on
 * the nth matching operation.
 */
function makeShim({ platform = 'android', canBio = true, expoGo = false } = {}) {
  const items = new Map(); // `${service}|${key}` → { value, auth, epoch }
  const shim = {
    platform,
    canBio,
    expoGo,
    epoch: 0,
    prompts: [], // titles shown
    responses: [], // queued 'ok' | 'cancel' | 'lockout' (default ok)
    rules: [], // { op, key, error?, corrupt?, skip? }
    items,
    whenUnlockedThisDeviceOnly: 5,
    id: (key, opts) => `${opts?.keychainService ?? 'default'}|${key}`,
    rule(op, key) {
      const i = shim.rules.findIndex((r) => r.op === op && (r.key === undefined || r.key === key));
      if (i < 0) return null;
      const r = shim.rules[i];
      if (r.skip && r.skip > 0) {
        r.skip -= 1;
        return null;
      }
      shim.rules.splice(i, 1);
      return r;
    },
    async prompt(title) {
      shim.prompts.push(title);
      const r = shim.responses.length > 0 ? shim.responses.shift() : 'ok';
      if (r === 'cancel') throw new Error(platform === 'android' ? ANDROID_CANCEL : IOS_CANCEL);
      if (r === 'lockout') throw new Error('Could not Authenticate the user: Lockout. Too many attempts.');
    },
    async getItemAsync(key, opts) {
      const r = shim.rule('get', key);
      if (r?.error) throw new Error(r.error);
      const rec = items.get(shim.id(key, opts));
      if (!rec) return null;
      if (rec.auth) {
        if (rec.epoch < shim.epoch) return null; // invalidated by a biometric change
        await shim.prompt(opts?.authenticationPrompt);
      }
      return r?.value !== undefined ? r.value : rec.value;
    },
    async setItemAsync(key, value, opts) {
      const r = shim.rule('set', key);
      if (r?.error) throw new Error(r.error);
      const id = shim.id(key, opts);
      if (opts?.requireAuthentication) {
        if (!shim.canBio) throw new Error('Could not Authenticate the user: No biometrics are currently enrolled');
        if (platform === 'ios' && shim.expoGo) throw new Error(IOS_EXPO_GO);
        if (platform === 'android') await shim.prompt(opts.authenticationPrompt);
        else if (items.has(id)) await shim.prompt(opts.authenticationPrompt);
      }
      items.set(id, { value: r?.corrupt ? `${value} x` : value, auth: !!opts?.requireAuthentication, epoch: shim.epoch });
    },
    async deleteItemAsync(key, opts) {
      const r = shim.rule('delete', key);
      if (r?.error) throw new Error(r.error);
      items.delete(shim.id(key, opts));
    },
    canUseBiometricAuthentication() {
      return shim.canBio;
    },
    has(key, service = 'default') {
      return items.has(`${service}|${key}`);
    },
    hasStandardPhrase() {
      return shim.has(MNEMONIC_KEY);
    },
    hasProtectedPhrase() {
      return shim.has(PROTECTED_MNEMONIC_KEY, PROTECTED_KEYCHAIN_SERVICE);
    },
    take() {
      const p = shim.prompts;
      shim.prompts = [];
      return p;
    },
  };
  return shim;
}

function clock(start = 1_700_000_000_000) {
  const c = { t: start, now: () => c.t };
  return c;
}

async function rejects(fn) {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}

/** Opens the phrase the way the app would, accepting prompts. */
async function readable(vault) {
  try {
    return await vault.readPhrase('read');
  } catch (e) {
    return e;
  }
}

// ---------------------------------------------------------------------------
console.log('check-storage: basics');
check('policy default is opt-in (CTO decision 2026-10-02: the move to protected storage is a user choice, pending the Chairperson)', PHRASE_PROTECTION_POLICY === 'opt-in');
check('ticket TTL is 30 s', PHRASE_TICKET_TTL_MS === 30_000);
check('cancel detection: Android text', isCancellation(new Error(ANDROID_CANCEL)));
check('cancel detection: iOS text', isCancellation(new Error(IOS_CANCEL)));
check('a lockout is not a cancel', !isCancellation(new Error('Could not Authenticate the user: Lockout.')));
check('meta parse: missing → null', parseVaultMeta(null) === null);
check('meta parse: garbage → corrupt', parseVaultMeta('{') === 'corrupt');
check('meta parse: wrong version → corrupt', parseVaultMeta('{"v":2,"phrase":"standard"}') === 'corrupt');
check('meta parse: unknown location → corrupt', parseVaultMeta('{"v":1,"phrase":"cloud"}') === 'corrupt');
check(
  'meta parse: unknown attempt outcome → corrupt',
  parseVaultMeta('{"v":1,"phrase":"standard","attempt":{"at":1,"outcome":"magic"}}') === 'corrupt',
);
{
  const m = parseVaultMeta('{"v":1,"phrase":"protected","protectedSince":5,"attempt":null,"unreadableSince":null}');
  check('meta parse: well-formed record', m !== 'corrupt' && m?.phrase === 'protected' && m.protectedSince === 5);
}

{
  const shim = makeShim();
  const vault = createKeyVault(shim);
  check('fresh install: no wallet', (await vault.phraseLocation()) === 'none');
  check('fresh install: readPhrase → null without prompting', (await vault.readPhrase('x')) === null && shim.take().length === 0);
  const st = await vault.status();
  check('fresh install: status none', st.phrase === 'none' && !st.canProtectNow);
  await vault.saveNewPhrase(PHRASE);
  check('saveNewPhrase writes the STANDARD copy only', shim.hasStandardPhrase() && !shim.hasProtectedPhrase());
  check('standard read has no prompt', (await vault.readPhrase('x')) === PHRASE && shim.take().length === 0);
  const st2 = await vault.status();
  check(
    'status standard / not-attempted / canProtectNow',
    st2.phrase === 'standard' && st2.reason === 'not-attempted' && st2.canProtectNow && st2.sessionKeys === 'standard',
    JSON.stringify(st2),
  );
}

// ---------------------------------------------------------------------------
console.log('check-storage: migration — happy paths');
for (const platform of ['android', 'ios']) {
  const shim = makeShim({ platform });
  const c = clock();
  const vault = createKeyVault(shim, { now: c.now });
  await vault.saveNewPhrase(PHRASE);
  shim.take();
  const r = await vault.upgrade({ prompt: 'P-write', checkPrompt: 'P-check' });
  const prompts = shim.take();
  check(`${platform}: upgrade → protected`, r.outcome === 'protected', JSON.stringify(r));
  check(
    `${platform}: prompts ${platform === 'android' ? '(write + check)' : '(check only; iOS create does not prompt)'}`,
    platform === 'android'
      ? prompts.length === 2 && prompts[0] === 'P-write' && prompts[1] === 'P-check'
      : prompts.length === 1 && prompts[0] === 'P-check',
    JSON.stringify(prompts),
  );
  check(`${platform}: standard copy deleted, protected copy present`, !shim.hasStandardPhrase() && shim.hasProtectedPhrase());
  check(`${platform}: location protected`, (await vault.phraseLocation()) === 'protected');
  check(`${platform}: a later read prompts once and returns the phrase`, (await vault.readPhrase('sign')) === PHRASE && shim.take().length === 1);
  const st = await vault.status();
  check(
    `${platform}: status protected with a date, session keys protected`,
    st.phrase === 'protected' && st.protectedSince === c.t && st.sessionKeys === 'protected' && !st.standardCopyPresent,
    JSON.stringify(st),
  );
  const again = await vault.upgrade();
  check(`${platform}: upgrading again → already-protected, no prompt`, again.outcome === 'already-protected' && shim.take().length === 0);
}

// ---------------------------------------------------------------------------
console.log('check-storage: migration — failure injected at every step');

/**
 * Each case: set up a standard wallet, inject a failure, run upgrade, then
 * require (1) the expected outcome, (2) the phrase is still readable and
 * identical, (3) no stray protected copy unless the outcome is protected.
 */
const failureCases = [
  { name: 'S1 no strong biometrics', setup: (s) => (s.canBio = false), outcome: 'no-strong-biometrics', reason: 'no-strong-biometrics' },
  { name: 'S2 write cancelled by the user', setup: (s) => s.responses.push('cancel'), outcome: 'cancelled', reason: 'cancelled' },
  {
    name: 'S2 write refused (Keystore error)',
    setup: (s) => s.rules.push({ op: 'set', key: PROTECTED_MNEMONIC_KEY, error: 'Could not encrypt the value: KeyStoreException' }),
    outcome: 'platform-refused',
    reason: 'platform-refused',
  },
  {
    name: 'S2 write refused AND the cleanup delete fails',
    setup: (s) => {
      s.rules.push({ op: 'set', key: PROTECTED_MNEMONIC_KEY, error: 'Keystore busy' });
      s.rules.push({ op: 'delete', key: PROTECTED_MNEMONIC_KEY, error: 'delete failed' });
    },
    outcome: 'platform-refused',
    reason: 'platform-refused',
  },
  // Android prompts for the write first; iOS does not (new item).
  { name: 'S3 read-back cancelled', setup: (s) => s.responses.push(...(s.platform === 'android' ? ['ok'] : []), 'cancel'), outcome: 'cancelled', reason: 'cancelled' },
  { name: 'S3 read-back lockout', setup: (s) => s.responses.push(...(s.platform === 'android' ? ['ok'] : []), 'lockout'), outcome: 'verify-failed', reason: 'verify-failed' },
  {
    name: 'S3 read-back differs (corrupted write)',
    setup: (s) => s.rules.push({ op: 'set', key: PROTECTED_MNEMONIC_KEY, corrupt: true }),
    outcome: 'verify-failed',
    reason: 'verify-failed',
  },
  {
    name: 'S3 read-back returns null',
    setup: (s) => s.rules.push({ op: 'get', key: PROTECTED_MNEMONIC_KEY, value: null }),
    outcome: 'verify-failed',
    reason: 'verify-failed',
  },
  {
    name: 'S4 meta write fails',
    setup: (s) => s.rules.push({ op: 'set', key: VAULT_META_KEY, error: 'disk full' }),
    outcome: 'failed',
    reason: 'platform-refused',
  },
];
for (const platform of ['android', 'ios']) {
  for (const fc of failureCases) {
    const shim = makeShim({ platform });
    const vault = createKeyVault(shim);
    await vault.saveNewPhrase(PHRASE);
    fc.setup(shim);
    const r = await vault.upgrade();
    shim.responses = [];
    shim.canBio = true;
    shim.rules = [];
    check(`${platform} ${fc.name}: outcome ${fc.outcome}`, r.outcome === fc.outcome, JSON.stringify(r));
    check(`${platform} ${fc.name}: standard copy untouched`, shim.hasStandardPhrase());
    check(`${platform} ${fc.name}: phrase still readable and identical`, (await readable(vault)) === PHRASE);
    if (fc.name !== 'S2 write refused AND the cleanup delete fails') {
      check(`${platform} ${fc.name}: no stray protected copy`, !shim.hasProtectedPhrase());
    }
    check(`${platform} ${fc.name}: location still standard`, (await vault.phraseLocation()) === 'standard');
    const st = await vault.status();
    if (fc.reason !== 'no-strong-biometrics') {
      check(`${platform} ${fc.name}: status reason ${fc.reason}`, st.phrase === 'standard' && st.reason === fc.reason, JSON.stringify(st));
    }
    // A retry with nothing injected completes.
    const retry = await vault.upgrade();
    check(`${platform} ${fc.name}: a clean retry protects the phrase`, retry.outcome === 'protected' && (await readable(vault)) === PHRASE);
  }
}

{
  // Expo Go on iOS: the module refuses the protected write.
  const shim = makeShim({ platform: 'ios', expoGo: true });
  const vault = createKeyVault(shim);
  await vault.saveNewPhrase(PHRASE);
  const r = await vault.upgrade();
  check('iOS Expo Go: platform-refused with the module text verbatim', r.outcome === 'platform-refused' && r.detail === IOS_EXPO_GO);
  const st = await vault.status();
  check('iOS Expo Go: status standard, detail verbatim', st.phrase === 'standard' && st.reason === 'platform-refused' && st.detail === IOS_EXPO_GO);
  check('iOS Expo Go: phrase readable', (await readable(vault)) === PHRASE);
}

{
  // S5: deleting the standard copy fails → protected + leftover; the next
  // protected read compares and finishes the job.
  const shim = makeShim();
  const vault = createKeyVault(shim);
  await vault.saveNewPhrase(PHRASE);
  shim.rules.push({ op: 'delete', key: MNEMONIC_KEY, error: 'busy' });
  const r = await vault.upgrade();
  check('S5 delete fails: outcome still protected', r.outcome === 'protected');
  check('S5 delete fails: both copies present', shim.hasStandardPhrase() && shim.hasProtectedPhrase());
  const st = await vault.status();
  check('S5 delete fails: status shows the standard copy is still present', st.phrase === 'protected' && st.standardCopyPresent);
  shim.take();
  check('S5 delete fails: next read uses the PROTECTED copy (one prompt)', (await vault.readPhrase('sign')) === PHRASE && shim.take().length === 1);
  check('S5 delete fails: …and then deletes the identical standard copy', !shim.hasStandardPhrase() && shim.hasProtectedPhrase());
}

{
  // A leftover standard copy that DIFFERS from the protected one is never deleted.
  const shim = makeShim();
  const vault = createKeyVault(shim);
  await vault.saveNewPhrase(PHRASE);
  shim.rules.push({ op: 'delete', key: MNEMONIC_KEY, error: 'busy' });
  await vault.upgrade();
  shim.items.get(`default|${MNEMONIC_KEY}`).value = OTHER;
  check('differing leftover: the protected copy is the wallet', (await vault.readPhrase('x')) === PHRASE);
  check('differing leftover: the standard copy is left alone (never delete when in doubt)', shim.hasStandardPhrase());
  const r = await vault.upgrade();
  check('differing leftover: upgrade never rewrites the protected copy from it', r.outcome === 'already-protected' && shim.items.get(`${PROTECTED_KEYCHAIN_SERVICE}|${PROTECTED_MNEMONIC_KEY}`).value === PHRASE);
}

// ---------------------------------------------------------------------------
console.log('check-storage: invalidation by a biometric change');
{
  const shim = makeShim();
  const c = clock();
  const vault = createKeyVault(shim, { now: c.now });
  await vault.saveNewPhrase(PHRASE);
  await vault.upgrade();
  shim.epoch += 1; // a fingerprint was added
  shim.take();
  const e = await rejects(() => vault.readPhrase('sign'));
  check('invalidated: readPhrase throws PhraseAccessError(unreadable)', e instanceof PhraseAccessError && e.reason === 'unreadable');
  check('invalidated: message tells the user to restore from the written backup', e?.message === PHRASE_UNREADABLE_MESSAGE && /written recovery phrase/.test(e.message));
  check('invalidated: no prompt was shown (the key is gone)', shim.take().length === 0);
  const st = await vault.status();
  check('invalidated: status unreadable', st.phrase === 'unreadable' && st.detail === PHRASE_UNREADABLE_MESSAGE, JSON.stringify(st));
  const gate = await vault.openPhraseForApproval('Unlock Shiba Wallet');
  check('invalidated: the approval gate falls back to the app prompt (lock screen stays unlockable)', gate.kind === 'fallback');
  check('invalidated: wallet is NOT reported as absent (no silent onboarding overwrite)', (await vault.phraseLocation()) === 'protected');
  // Re-import from the written backup.
  await vault.saveNewPhrase(PHRASE);
  check('re-import: standard copy written, stale protected copy removed', shim.hasStandardPhrase() && !shim.hasProtectedPhrase());
  const r = await vault.upgrade();
  check('re-import: protection works again', r.outcome === 'protected' && (await readable(vault)) === PHRASE);
  const st2 = await vault.status();
  check('re-import: status protected (unreadable mark cleared)', st2.phrase === 'protected');
}

{
  // Invalidated while a leftover standard copy exists → fall back to it.
  const shim = makeShim();
  const vault = createKeyVault(shim);
  await vault.saveNewPhrase(PHRASE);
  shim.rules.push({ op: 'delete', key: MNEMONIC_KEY, error: 'busy' });
  await vault.upgrade();
  shim.epoch += 1;
  shim.take();
  const gate = await vault.openPhraseForApproval('Approve');
  check('leftover + invalidated: gate does NOT count it as authenticated (no prompt was shown)', gate.kind === 'fallback');
  check('leftover + invalidated: the standard copy becomes the wallet again', (await vault.phraseLocation()) === 'standard');
  check('leftover + invalidated: phrase readable without a prompt', (await vault.readPhrase('x')) === PHRASE && shim.take().length === 0);
  const st = await vault.status();
  check('leftover + invalidated: status standard / reverted', st.phrase === 'standard' && st.reason === 'reverted', JSON.stringify(st));
}

// ---------------------------------------------------------------------------
console.log('check-storage: the approval gate (one prompt per operation)');
{
  const shim = makeShim();
  const c = clock();
  const vault = createKeyVault(shim, { now: c.now });
  await vault.saveNewPhrase(PHRASE);
  await vault.upgrade();
  shim.take();
  const g = await vault.openPhraseForApproval('Approve sending 1 ETH');
  check('protected: gate authenticated with ONE system prompt titled for the action', g.kind === 'authenticated' && JSON.stringify(shim.take()) === JSON.stringify(['Approve sending 1 ETH']));
  check('protected: the signing read right after uses the held phrase (no second prompt)', (await vault.readPhrase('sign')) === PHRASE && shim.take().length === 0);
  check('protected: the hold is single use', (await vault.readPhrase('sign')) === PHRASE && shim.take().length === 1);
  await vault.openPhraseForApproval('Approve');
  shim.take();
  c.t += PHRASE_TICKET_TTL_MS + 1;
  check('protected: an expired hold is not used (prompts again)', (await vault.readPhrase('sign')) === PHRASE && shim.take().length === 1);
  await vault.openPhraseForApproval('Approve');
  shim.take();
  vault.dropTicket();
  check('protected: dropTicket (app to background) forgets the hold', (await vault.readPhrase('sign')) === PHRASE && shim.take().length === 1);
  shim.responses.push('cancel');
  const gc = await vault.openPhraseForApproval('Approve');
  check('protected: a cancelled system prompt cancels the approval', gc.kind === 'cancelled');
  check('protected: …and holds nothing', (await vault.readPhrase('sign')) === PHRASE && shim.take().length === 2);
  shim.responses.push('lockout');
  const gl = await vault.openPhraseForApproval('Approve');
  check('protected: a lockout falls back to the app prompt (passcode fallback)', gl.kind === 'fallback' && /Lockout/.test(gl.detail ?? ''));
  shim.responses.push('cancel');
  const e = await rejects(() => vault.readPhrase('sign'));
  check('protected: signing read cancelled → PhraseAccessError(cancelled), nothing signed', e instanceof PhraseAccessError && e.reason === 'cancelled' && /Nothing was signed/.test(e.message));
  await vault.openPhraseForApproval('Approve');
  await vault.removePhrase();
  await vault.saveNewPhrase(OTHER);
  check('remove + saveNewPhrase: no held phrase of the old wallet leaks into the new one', (await vault.readPhrase('x')) === OTHER);
  await vault.upgrade();
  await vault.openPhraseForApproval('Approve');
  await vault.removePhrase();
  check('removePhrase drops a held phrase', (await vault.readPhrase('x')) === null);
}

{
  // Standard wallet, eligible device, policy automatic: the first approval
  // performs the migration and that approval needs no further prompt.
  for (const platform of ['android', 'ios']) {
    const shim = makeShim({ platform });
    const vault = createKeyVault(shim, { policy: 'automatic' });
    await vault.saveNewPhrase(PHRASE);
    shim.take();
    const g = await vault.openPhraseForApproval('Approve sending 1 ETH');
    const prompts = shim.take();
    check(`${platform} first approval: migrates and authenticates`, g.kind === 'authenticated' && (await vault.phraseLocation()) === 'protected');
    check(
      `${platform} first approval: prompts are the protection write (Android only) then the action`,
      platform === 'android'
        ? prompts.length === 2 && prompts[1] === 'Approve sending 1 ETH'
        : prompts.length === 1 && prompts[0] === 'Approve sending 1 ETH',
      JSON.stringify(prompts),
    );
    check(`${platform} first approval: signing needs no extra prompt`, (await vault.readPhrase('sign')) === PHRASE && shim.take().length === 0);
  }
}

{
  const shim = makeShim();
  const vault = createKeyVault(shim, { policy: 'automatic' });
  await vault.saveNewPhrase(PHRASE);
  shim.responses.push('cancel');
  const g = await vault.openPhraseForApproval('Approve');
  check('protection prompt cancelled at an approval → fallback (the ordinary prompt asks for the action)', g.kind === 'fallback');
  check('…phrase stays standard and readable', (await vault.phraseLocation()) === 'standard' && (await readable(vault)) === PHRASE);
  shim.take();
  const g2 = await vault.openPhraseForApproval('Approve');
  check('…not offered again in the same app session (no nagging)', g2.kind === 'fallback' && shim.take().length === 0);
  const st = await vault.status();
  check('…status standard / cancelled, still offerable from Settings', st.reason === 'cancelled' && st.canProtectNow);
  const manual = await vault.upgrade();
  check('…an explicit upgrade (Settings button) still runs', manual.outcome === 'protected');
  const auto = await createKeyVault(shim, { policy: 'automatic' }).upgrade({ automatic: true });
  check('automatic upgrade on an already-protected wallet → already-protected', auto.outcome === 'already-protected');
}

{
  const shim = makeShim({ canBio: false });
  const vault = createKeyVault(shim, { policy: 'automatic' });
  await vault.saveNewPhrase(PHRASE);
  const g = await vault.openPhraseForApproval('Approve');
  check('no strong biometrics: gate falls back without any system prompt', g.kind === 'fallback' && shim.take().length === 0);
  const st = await vault.status();
  check('no strong biometrics: status standard / no-strong-biometrics, not offerable', st.reason === 'no-strong-biometrics' && !st.canProtectNow && !st.biometricsAvailable);
  shim.canBio = true; // the user enrolled a fingerprint
  const g2 = await vault.openPhraseForApproval('Approve');
  check('biometrics enrolled later: the next approval migrates', g2.kind === 'authenticated' && (await vault.phraseLocation()) === 'protected');
}

{
  const shim = makeShim();
  const vault = createKeyVault(shim, { policy: 'opt-in' });
  await vault.saveNewPhrase(PHRASE);
  const g = await vault.openPhraseForApproval('Approve');
  const auto = await vault.upgrade({ automatic: true });
  check('policy opt-in: no automatic migration at approvals or after create', g.kind === 'fallback' && auto.outcome === 'policy-off' && (await vault.phraseLocation()) === 'standard');
  const manual = await vault.upgrade();
  check('policy opt-in: the Settings button migrates', manual.outcome === 'protected');
  const off = createKeyVault(shim, { policy: 'off' });
  check('policy off: an existing protected phrase stays readable', (await off.readPhrase('x')) === PHRASE);
  const shim2 = makeShim();
  const off2 = createKeyVault(shim2, { policy: 'off' });
  await off2.saveNewPhrase(PHRASE);
  check('policy off: upgrade refused', (await off2.upgrade()).outcome === 'policy-off' && (await off2.status()).reason === 'policy-off');
}

{
  const shim = makeShim();
  const vault = createKeyVault(shim, { policy: 'automatic' });
  await vault.saveNewPhrase(PHRASE);
  const r1 = await vault.upgrade({ automatic: true });
  check('automatic upgrade after create → protected', r1.outcome === 'protected');
  const shim2 = makeShim();
  const v2 = createKeyVault(shim2, { policy: 'automatic' });
  await v2.saveNewPhrase(PHRASE);
  shim2.responses.push('cancel');
  const r2 = await v2.upgrade({ automatic: true });
  const r3 = await v2.upgrade({ automatic: true });
  check('automatic upgrade cancelled → not retried in this session', r2.outcome === 'cancelled' && r3.outcome === 'skipped');
  check('…wallet still works from standard storage', (await readable(v2)) === PHRASE);
}

// ---------------------------------------------------------------------------
console.log('check-storage: corrupt meta, wipe');
{
  const shim = makeShim();
  const vault = createKeyVault(shim);
  await vault.saveNewPhrase(PHRASE);
  await vault.upgrade();
  shim.items.get(`default|${VAULT_META_KEY}`).value = '{not json';
  check('corrupt meta, no standard copy → treated as PROTECTED (never "no wallet")', (await vault.phraseLocation()) === 'protected');
  check('corrupt meta: the protected phrase still opens', (await readable(vault)) === PHRASE);
  const shim2 = makeShim();
  const v2 = createKeyVault(shim2);
  await v2.saveNewPhrase(PHRASE);
  shim2.items.get(`default|${VAULT_META_KEY}`).value = '[]';
  check('corrupt meta with a standard copy → standard', (await v2.phraseLocation()) === 'standard' && (await readable(v2)) === PHRASE);
  const shim3 = makeShim();
  const v3 = createKeyVault(shim3);
  shim3.rules.push({ op: 'set', key: VAULT_META_KEY, error: 'disk full' });
  const e = await rejects(() => v3.saveNewPhrase(OTHER));
  check('saveNewPhrase meta failure surfaces as an error (create/import shows it)', e instanceof Error && /disk full/.test(e.message));
  check('…and the newly written standard copy is what reads back', (await readable(v3)) === OTHER);
}
{
  const shim = makeShim();
  const vault = createKeyVault(shim);
  await vault.saveNewPhrase(PHRASE);
  shim.rules.push({ op: 'delete', key: MNEMONIC_KEY, error: 'busy' });
  await vault.upgrade();
  await vault.removePhrase();
  check('wipe removes protected copy, standard copy and meta', !shim.hasProtectedPhrase() && !shim.hasStandardPhrase() && !shim.has(VAULT_META_KEY));
  check('wipe → no wallet', (await vault.phraseLocation()) === 'none');
  const shim2 = makeShim();
  const v2 = createKeyVault(shim2);
  await v2.saveNewPhrase(PHRASE);
  await v2.upgrade();
  shim2.rules.push({ op: 'delete', key: PROTECTED_MNEMONIC_KEY, error: 'busy' });
  const e = await rejects(() => v2.removePhrase());
  check('wipe failure is reported, and the wallet is not half-forgotten', e instanceof Error && (await v2.phraseLocation()) === 'protected' && (await readable(v2)) === PHRASE);
}

console.log('check-storage: a new wallet never silently replaces a readable one');
{
  const shim = makeShim();
  const vault = createKeyVault(shim);
  await vault.saveNewPhrase(PHRASE);
  const e = await rejects(() => vault.saveNewPhrase(OTHER));
  check('standard: a DIFFERENT valid phrase is refused (launch-error onboarding cannot overwrite)', e?.message === OTHER_WALLET_STORED_MESSAGE);
  check('standard: the old phrase is untouched', (await readable(vault)) === PHRASE);
  await vault.saveNewPhrase(PHRASE);
  check('standard: the same phrase again is accepted', (await readable(vault)) === PHRASE);
  shim.items.get(`default|${MNEMONIC_KEY}`).value = 'not a mnemonic';
  await vault.saveNewPhrase(OTHER);
  check('standard: an invalid leftover is replaced', (await readable(vault)) === OTHER);
}
{
  const shim = makeShim();
  const vault = createKeyVault(shim);
  await vault.saveNewPhrase(PHRASE);
  await vault.upgrade();
  shim.take();
  const e = await rejects(() => vault.saveNewPhrase(OTHER));
  const prompts = shim.take();
  check('protected: a different phrase is refused after one check prompt', e?.message === OTHER_WALLET_STORED_MESSAGE && prompts.length === 1 && prompts[0] === 'Check the wallet already stored on this phone');
  check('protected: still protected and readable', (await vault.phraseLocation()) === 'protected' && (await readable(vault)) === PHRASE);
  shim.responses.push('cancel');
  const c = await rejects(() => vault.saveNewPhrase(OTHER));
  check('protected: cancelling the check changes nothing', /Nothing was changed/.test(c?.message ?? '') && (await readable(vault)) === PHRASE);
  await vault.saveNewPhrase(PHRASE);
  check('protected: re-importing the same phrase is accepted (back to standard, then re-protected by the caller)', (await vault.phraseLocation()) === 'standard' && (await readable(vault)) === PHRASE);
  await vault.upgrade();
  shim.epoch += 1;
  await vault.saveNewPhrase(OTHER);
  check('protected but invalidated: replaced (nothing readable to lose)', (await readable(vault)) === OTHER && !shim.hasProtectedPhrase());
}

// ---------------------------------------------------------------------------
console.log('check-storage: public account cache');
{
  const shim = makeShim();
  const vault = createKeyVault(shim);
  const entries = [
    { chainId: 'eip155:1', address: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94', path: "m/44'/60'/0'/0/0" },
    { chainId: 'bip122:000000000019d6689c085ae165831e93', address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', path: "m/84'/0'/0'/0/0" },
  ];
  await vault.savePublicAccount(0, entries);
  const back = await vault.loadPublicAccount(0);
  check('cache round trip', JSON.stringify(back) === JSON.stringify(entries));
  check('cache entries are standard (no prompt to launch)', shim.take().length === 0 && !shim.items.get(`default|shiba-wallet.public-account.v1.0`).auth);
  check('cache: missing index → null', (await vault.loadPublicAccount(1)) === null);
  shim.items.get(`default|shiba-wallet.public-account.v1.0`).value = JSON.stringify({ v: 1, index: 3, chains: entries });
  check('cache: an entry stored under another index is ignored', (await vault.loadPublicAccount(0)) === null);
  shim.items.get(`default|shiba-wallet.public-account.v1.0`).value = '{{';
  check('cache: corrupt JSON → null (re-derived)', (await vault.loadPublicAccount(0)) === null);
  const bad = await rejects(() => vault.savePublicAccount(0, [{ chainId: 'eip155:1', address: '0x12\n', path: 'm/0' }]));
  check('cache: invalid address text refused', bad instanceof Error);
  const badPath = await rejects(() => vault.savePublicAccount(0, [{ chainId: 'eip155:1', address: '0xabc', path: '../x' }]));
  check('cache: invalid path refused', badPath instanceof Error);
  const badIndex = await rejects(() => vault.savePublicAccount(-1, entries));
  check('cache: negative index refused', badIndex instanceof Error);
  await vault.savePublicAccount(2, entries);
  await vault.deletePublicAccounts([0, 1, 2]);
  check('cache: delete', (await vault.loadPublicAccount(2)) === null);
  check('cache entries never contain key material fields', !/priv|seed|mnemonic/i.test(JSON.stringify(entries)));
}

// ---------------------------------------------------------------------------
console.log('check-storage: session-key vault');
{
  const ID = '11155111.0x9858effd232b4033e47d90003d41ec34ecaeda94.d0b4b7b7';
  const KEY = '0x' + '11'.repeat(32);
  const shim = makeShim();
  const vault = createKeyVault(shim);
  await vault.saveNewPhrase(PHRASE);
  await vault.sessionKeys.save(ID, KEY);
  check('standard phrase → session key in standard storage, no prompt', shim.has(`shiba-wallet.session-key.v1.${ID}`) && shim.take().length === 0);
  check('standard load', (await vault.sessionKeys.load(ID)) === KEY);
  await vault.upgrade();
  shim.take();
  const ID2 = ID.replace('d0b4b7b7', 'aaaaaaaa');
  await vault.sessionKeys.save(ID2, KEY);
  check('protected phrase → new session key protected (Android: one write prompt)', shim.has(`shiba-wallet.session-key.v2.${ID2}`, PROTECTED_KEYCHAIN_SERVICE) && shim.take().length === 1);
  check('protected session key load prompts once', (await vault.sessionKeys.load(ID2)) === KEY && shim.take().length === 1);
  check('older standard session key still loads (no prompt)', (await vault.sessionKeys.load(ID)) === KEY && shim.take().length === 0);
  const st = await vault.status();
  check('status: session keys protected', st.sessionKeys === 'protected');
  await vault.sessionKeys.remove(ID2);
  await vault.sessionKeys.remove(ID);
  check('remove deletes both classes', (await vault.sessionKeys.load(ID2)) === null && (await vault.sessionKeys.load(ID)) === null);
  shim.responses.push('cancel');
  const e = await rejects(() => vault.sessionKeys.save(ID2, KEY));
  check('session save: a cancelled prompt aborts (the install does not go ahead)', e instanceof Error && /cancelled/i.test(e.message) && (await vault.sessionKeys.load(ID2)) === null);
  shim.rules.push({ op: 'set', key: `shiba-wallet.session-key.v2.${ID2}`, error: 'KeyStoreException' });
  await vault.sessionKeys.save(ID2, KEY);
  check('session save: a platform refusal falls back to standard storage', shim.has(`shiba-wallet.session-key.v1.${ID2}`) && (await vault.sessionKeys.load(ID2)) === KEY);
  const badId = await rejects(() => vault.sessionKeys.save('../x', KEY));
  check('session save: invalid id refused', badId instanceof Error);
  const badKey = await rejects(() => vault.sessionKeys.save(ID, '0x12'));
  check('session save: non-32-byte key refused', badKey instanceof Error);
  shim.epoch += 1;
  check('after an invalidation the standard-fallback copy of that key still loads', (await vault.sessionKeys.load(ID2)) === KEY);
  await vault.sessionKeys.remove(ID2);
  const ID3 = ID.replace('d0b4b7b7', 'bbbbbbbb');
  await vault.sessionKeys.save(ID3, KEY);
  shim.epoch += 1;
  check('an invalidated protected session key reads as missing (sessions.ts reports it)', (await vault.sessionKeys.load(ID3)) === null);
}

// ---------------------------------------------------------------------------
console.log('check-storage: concurrency (Android allows one prompt at a time)');
{
  const shim = makeShim();
  const vault = createKeyVault(shim);
  await vault.saveNewPhrase(PHRASE);
  await vault.upgrade();
  let open = 0;
  let maxOpen = 0;
  const orig = shim.prompt;
  shim.prompt = async (t) => {
    open += 1;
    maxOpen = Math.max(maxOpen, open);
    await new Promise((r) => setTimeout(r, 5));
    open -= 1;
    return orig(t);
  };
  const results = await Promise.all([vault.readPhrase('a'), vault.readPhrase('b'), vault.sessionKeys.load('1.0x' + '00'.repeat(20) + '.00000000')]);
  check('concurrent reads are serialized (never two prompts at once)', maxOpen === 1 && results[0] === PHRASE && results[1] === PHRASE);
}

// ---------------------------------------------------------------------------
console.log('check-storage: source rules');
{
  const storageSrc = readFileSync(new URL('../src/wallet/storage.ts', import.meta.url), 'utf8');
  const ctxSrc = readFileSync(new URL('../src/wallet/WalletContext.tsx', import.meta.url), 'utf8');
  const bioSrc = readFileSync(new URL('../src/wallet/biometric.ts', import.meta.url), 'utf8');
  check('storage.ts imports expo-secure-store as a TYPE only (Node-loadable; native module injected)', /import type \* as ExpoSecureStore from 'expo-secure-store'/.test(storageSrc) && !/^import \* as SecureStore/m.test(storageSrc));
  check('WalletContext binds the native module once', (ctxSrc.match(/bindSecureStore\(/g) ?? []).length === 1);
  check('WalletContext reads the phrase only through readPhrase (no loadMnemonic left)', !/loadMnemonic|saveMnemonic/.test(ctxSrc) && /readPhrase\(PROMPTS\.signFallback\)/.test(ctxSrc));
  check('WalletContext calls no expo-secure-store function directly', !/SecureStore\.(get|set|delete)Item/.test(ctxSrc));
  check('requireLocalAuth asks the vault first', /openPhraseForApproval\(promptMessage\)/.test(bioSrc));
  check('requireLocalAuth keeps the OS passcode fallback for its own prompt', /disableDeviceFallback: false/.test(bioSrc));
  check('activate stores standard first, then attempts protection', ctxSrc.indexOf('await saveNewPhrase(mnemonic)') < ctxSrc.indexOf('await upgradePhraseProtectionIfAutomatic()'));
  check('the held phrase is dropped when the app leaves the foreground', /AppState\.addEventListener[\s\S]{0,120}dropPhraseTicket\(\)/.test(ctxSrc));
  check('no console logging in storage.ts', !/console\.\w+\(/.test(storageSrc));
}

console.log(`\ncheck-storage: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
