// Duress wallet, Stage 1 (docs/DURESS_WALLET.md section 5.2): the single
// storage seam. Every "shiba-wallet." storage key is declared, with its
// scope, in src/wallet/store-keys.ts, and every read, write, delete and
// listing of such a key goes through that module's functions. This suite
// proves it two ways:
//
//  1. A source scan over app/src (and App.tsx) that fails on any
//     "shiba-wallet." string literal, any import of the AsyncStorage
//     package, any AsyncStorage.* or SecureStore.* call, any getItem /
//     setItem / removeItem / getAllKeys / multi* call and any
//     getItemAsync / setItemAsync / deleteItemAsync call outside
//     store-keys.ts — except the entries of ALLOW_LIST below, which must
//     match what is in those files exactly (a stale or a missing entry
//     fails too).
//  2. Behavioural pins: each wrapper reaches the same underlying key with
//     the same value and the same error behaviour as the direct call it
//     replaced; the scope function is the identity for the primary profile
//     (the only one in use); every key name equals the string the app
//     stored before the seam (no migration); a second profile, which
//     nothing uses yet, would move only per-wallet and secret keys.
//
// Mutants: a caller bypassing the seam, a new key literal, a new package
// import, a stale allow-list entry and a scope function that is not the
// identity are each caught.
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-storage-seam.mjs
//
// No device, no network.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as seam from '../src/wallet/store-keys.ts';

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

const HERE = fileURLToPath(new URL('.', import.meta.url));
const APP = join(HERE, '..');
const SEAM_FILE = 'src/wallet/store-keys.ts';

// ---------------------------------------------------------------------------
// The allow-list: raw accesses that remain outside the seam, by file. Each
// value is the exact multiset of findings the scan must report for that
// file (signature → count). They move into the seam in the next slice:
//
//  - src/wallet/recovery.ts and src/wallet/send.ts are being edited by
//    another slice this wave and were deliberately left alone. send.ts has
//    no raw access (it only names AsyncStorage in a comment), so it has no
//    entry; recovery.ts keeps its two key literals and six store calls.
//  - src/config/prefs.ts and src/config/networks.ts (the preferences and
//    the endpoint overrides, both 'device' scope) are outside the files
//    this slice may edit.
//  - Five screens and WalletConnectContext.tsx import the AsyncStorage
//    package only to pass it on as the store argument (no key, no call);
//    they are outside the files this slice may edit and should import the
//    seam's re-export instead.
// ---------------------------------------------------------------------------
export const ALLOW_LIST = {
  'src/wallet/recovery.ts': {
    'import @react-native-async-storage/async-storage': 1,
    "key 'shiba-wallet.recovery-records.v1'": 1,
    "key 'shiba-wallet.recovery-progress.v1'": 1,
    'call .getItem(': 1,
    'call .setItem(': 5,
  },
  'src/config/prefs.ts': {
    'import @react-native-async-storage/async-storage': 1,
    "key 'shiba-wallet.prefs.v1'": 1,
    'call .getItem(': 1,
    'call .setItem(': 1,
  },
  'src/config/networks.ts': {
    'import @react-native-async-storage/async-storage': 1,
    "key 'shiba-wallet.rpc-endpoints.v1'": 1,
    'call .getItem(': 1,
    'call .setItem(': 1,
  },
  'src/screens/GuardiansScreen.tsx': { 'import @react-native-async-storage/async-storage': 1 },
  'src/screens/InheritanceScreen.tsx': { 'import @react-native-async-storage/async-storage': 1 },
  'src/screens/OwnerRotationScreen.tsx': { 'import @react-native-async-storage/async-storage': 1 },
  'src/screens/PasskeyScreen.tsx': { 'import @react-native-async-storage/async-storage': 1 },
  'src/screens/SessionsScreen.tsx': { 'import @react-native-async-storage/async-storage': 1 },
  'src/wallet/WalletConnectContext.tsx': { 'import @react-native-async-storage/async-storage': 1 },
};

// ---------------------------------------------------------------------------
// The scanner
// ---------------------------------------------------------------------------

/**
 * Drops comments so that prose may mention keys and APIs. Block comments are
 * removed whole; a line comment is removed when its "//" is not part of a
 * URL ("https://") and sits outside quotes. Deliberately simple: it errs
 * towards keeping text, so a false finding fails loudly rather than a real
 * one slipping through.
 */
function stripComments(text) {
  const noBlocks = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return noBlocks
    .split('\n')
    .map((line) => {
      let quote = null;
      for (let i = 0; i < line.length - 1; i += 1) {
        const c = line[i];
        if (quote) {
          if (c === '\\') i += 1;
          else if (c === quote) quote = null;
        } else if (c === "'" || c === '"' || c === '`') quote = c;
        else if (c === '/' && line[i + 1] === '/' && line[i - 1] !== ':') return line.slice(0, i);
      }
      return line;
    })
    .join('\n');
}

const RULES = [
  { re: /from\s+'@react-native-async-storage\/async-storage'|import\(\s*'@react-native-async-storage\/async-storage'\s*\)|require\(\s*'@react-native-async-storage\/async-storage'\s*\)/g, sig: () => 'import @react-native-async-storage/async-storage' },
  { re: /\bAsyncStorage\.\w+\(/g, sig: (m) => `call ${m[0]}` },
  { re: /\bSecureStore\.\w+\(/g, sig: (m) => `call ${m[0]}` },
  { re: /\b(?:get|set|delete)ItemAsync\(/g, sig: (m) => `call ${m[0]}` },
  { re: /\.(?:getItem|setItem|removeItem|mergeItem|getAllKeys|multiGet|multiSet|multiRemove|multiMerge)\(/g, sig: (m) => `call ${m[0]}` },
  { re: /(['"`])(shiba-wallet\.[^'"`\s]*)\1?/g, sig: (m) => `key '${m[2]}'` },
];

/** Findings of one file's text, as a map signature → count. */
export function scanSource(text) {
  const code = stripComments(text);
  const found = {};
  for (const rule of RULES) {
    for (const m of code.matchAll(rule.re)) {
      const s = rule.sig(m);
      found[s] = (found[s] ?? 0) + 1;
    }
  }
  return found;
}

function listSources(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listSources(full));
    else if (/\.(ts|tsx|js|jsx)$/.test(name)) out.push(full);
  }
  return out;
}

/** Scans a set of files {relPath: text}; returns {violations, allowListProblems}. */
export function evaluate(files, allowList) {
  const violations = [];
  const allowListProblems = [];
  const seen = new Set();
  for (const [rel, text] of Object.entries(files)) {
    if (rel === SEAM_FILE) continue;
    const found = scanSource(text);
    const allowed = allowList[rel];
    if (allowed) {
      seen.add(rel);
      const keys = new Set([...Object.keys(found), ...Object.keys(allowed)]);
      for (const k of keys) {
        if ((found[k] ?? 0) !== (allowed[k] ?? 0)) {
          allowListProblems.push(`${rel}: "${k}" found ${found[k] ?? 0}, allow-listed ${allowed[k] ?? 0}`);
        }
      }
    } else {
      for (const [k, n] of Object.entries(found)) violations.push(`${rel}: ${k} ×${n}`);
    }
  }
  for (const rel of Object.keys(allowList)) {
    if (!seen.has(rel)) allowListProblems.push(`${rel}: allow-listed but not found`);
  }
  return { violations, allowListProblems };
}

function readTree() {
  const files = {};
  for (const full of [...listSources(join(APP, 'src')), join(APP, 'App.tsx')]) {
    files[relative(APP, full).split(sep).join('/')] = readFileSync(full, 'utf8');
  }
  return files;
}

// ---------------------------------------------------------------------------
console.log('check-storage-seam: source scan');
// ---------------------------------------------------------------------------
const tree = readTree();
{
  const { violations, allowListProblems } = evaluate(tree, ALLOW_LIST);
  check(`no raw storage access outside store-keys.ts and the allow-list (${Object.keys(tree).length} files scanned)`, violations.length === 0, violations.join('; '));
  check('the allow-list matches the remaining raw accesses exactly (none stale, none missing)', allowListProblems.length === 0, allowListProblems.join('; '));
  check('the allow-list names only recovery.ts and the files outside this slice (config, five screens, WalletConnectContext)',
    Object.keys(ALLOW_LIST).every((f) => f === 'src/wallet/recovery.ts' || f.startsWith('src/config/') || f.startsWith('src/screens/') || f === 'src/wallet/WalletConnectContext.tsx'));
  check('send.ts (left alone this wave) has no raw storage access at all', Object.keys(scanSource(tree['src/wallet/send.ts'])).length === 0, JSON.stringify(scanSource(tree['src/wallet/send.ts'])));
  check('every key literal left in an allow-listed file is declared in the registry, with the right scope',
    seam.storeKeyScope('shiba-wallet.recovery-records.v1') === 'wallet' && seam.storeKeyScope('shiba-wallet.recovery-progress.v1') === 'wallet' &&
      seam.storeKeyScope('shiba-wallet.prefs.v1') === 'device' && seam.storeKeyScope('shiba-wallet.rpc-endpoints.v1') === 'device');
  const seamSrc = tree[SEAM_FILE];
  check('store-keys.ts imports expo-secure-store as a TYPE only (Node-loadable; the native module is injected)',
    /import type \* as ExpoSecureStore from 'expo-secure-store'/.test(seamSrc) && !/^import (?!type)[^\n]*'expo-secure-store'/m.test(seamSrc));
  check('the only value import of expo-secure-store is WalletContext.tsx, which binds the native module once (no call)',
    Object.entries(tree).filter(([, t]) => /^import (?!type)[^\n]*from 'expo-secure-store'/m.test(t)).map(([f]) => f).join(',') === 'src/wallet/WalletContext.tsx' &&
      (tree['src/wallet/WalletContext.tsx'].match(/bindSecureStore\(nativeSecureStoreBackend\(SecureStore\)\)/g) ?? []).length === 1);
  check('the comment stripper keeps code: a key in a URL-bearing line is still found',
    scanSource("const u = 'https://x.example'; const k = 'shiba-wallet.x.v1'; // note")["key 'shiba-wallet.x.v1'"] === 1);
  check('…and drops prose: keys and calls named in comments are not findings',
    Object.keys(scanSource("/** store.getItem('shiba-wallet.a') */\n// AsyncStorage.setItem('shiba-wallet.b')\nconst x = 1;")).length === 0);
}

// ---------------------------------------------------------------------------
console.log('check-storage-seam: mutants (each must be caught)');
// ---------------------------------------------------------------------------
{
  const caught = (mutated, file) => evaluate({ ...tree, [file]: mutated }, ALLOW_LIST);
  const acc = tree['src/wallet/accounts.ts'];
  const anchor = 'readStoreItem(store, ACCOUNTS_KEY)';
  check('mutant anchor present in accounts.ts', acc.includes(anchor));
  const m1 = caught(acc.replace(anchor, 'store.getItem(ACCOUNTS_KEY)'), 'src/wallet/accounts.ts');
  check('mutant caught: accounts.ts reads its key with store.getItem (bypassing the seam)', m1.violations.some((v) => v.includes('call .getItem(')), JSON.stringify(m1));
  const m2 = caught(acc.replace("STORE_KEYS.accounts.name", "'shiba-wallet.accounts.v1'"), 'src/wallet/accounts.ts');
  check('mutant caught: accounts.ts declares its key as a literal again', m2.violations.some((v) => v.includes("key 'shiba-wallet.accounts.v1'")), JSON.stringify(m2));
  const m3 = caught(acc.replace("from './store-keys.ts';", "from './store-keys.ts';\nimport AsyncStorage2 from '@react-native-async-storage/async-storage';"), 'src/wallet/accounts.ts');
  check('mutant caught: a wallet module imports the AsyncStorage package directly', m3.violations.some((v) => v.includes('import @react-native-async-storage')), JSON.stringify(m3));
  const storage = tree['src/wallet/storage.ts'];
  const sAnchor = 'readSecureItem(backend, MNEMONIC_KEY, STANDARD)';
  check('mutant anchor present in storage.ts', storage.includes(sAnchor));
  const m4 = caught(storage.replace(sAnchor, 'backend.getItemAsync(MNEMONIC_KEY, STANDARD)'), 'src/wallet/storage.ts');
  check('mutant caught: the vault reads the phrase with backend.getItemAsync (bypassing the seam)', m4.violations.some((v) => v.includes('getItemAsync(')), JSON.stringify(m4));
  const m5 = caught(tree['src/wallet/recovery.ts'].replace("'shiba-wallet.recovery-records.v1'", "'shiba-wallet.recovery-records.v1'; const extra = 'shiba-wallet.extra.v1'"), 'src/wallet/recovery.ts');
  check('mutant caught: an allow-listed file gains a new raw key (the allow-list is exact)', m5.allowListProblems.length > 0, JSON.stringify(m5));
  const m6 = evaluate(tree, { ...ALLOW_LIST, 'src/wallet/send.ts': { 'call .getItem(': 1 } });
  check('mutant caught: a stale allow-list entry (send.ts has no raw access)', m6.allowListProblems.some((p) => p.startsWith('src/wallet/send.ts')), JSON.stringify(m6.allowListProblems));
  const m7 = caught("export function f(s) { return s.setItem('k', 'v'); }", 'src/components/NewThing.tsx');
  check('mutant caught: a new component writes to a store directly', m7.violations.some((v) => v.startsWith('src/components/NewThing.tsx')), JSON.stringify(m7));
}

// ---------------------------------------------------------------------------
console.log('check-storage-seam: the registry and the key names (no migration)');
// ---------------------------------------------------------------------------
// Every key name the app stored under before the seam, read from HEAD's
// literals (2026-10-14): the seam must keep each one byte for byte.
const ORIGINAL_NAMES = {
  accounts: 'shiba-wallet.accounts.v1', contacts: 'shiba-wallet.contacts.v1', tokens: 'shiba-wallet.tokens.v1',
  tokensPerChain: 'shiba-wallet.tokens.v1.', txNotes: 'shiba-wallet.tx-notes.v1', sessions: 'shiba-wallet.sessions.v1',
  multisig: 'shiba-wallet.multisig.v1', recoveryRecords: 'shiba-wallet.recovery-records.v1',
  recoveryProgress: 'shiba-wallet.recovery-progress.v1', inheritance: 'shiba-wallet.inheritance.v1',
  passkeys: 'shiba-wallet.passkeys.v1', spendingPolicies: 'shiba-wallet.spending-policies.v1',
  spendingHistory: 'shiba-wallet.spending-history.v1', pendingTx: 'shiba-wallet.pending-tx.v1',
  browserConnections: 'shiba-wallet.browser-connections.v1', wcSmartBindings: 'shiba-wallet.wc-smart-bindings.v1',
  wcCalls: 'shiba-wallet.wc-calls.v1', wcUsed: 'shiba-wallet.wc-used.v1', aaConfig: 'shiba-wallet.aa-config.v1',
  priceAlerts: 'shiba-wallet.price-alerts.v1', notifications: 'shiba-wallet.notifications.v1',
  prefs: 'shiba-wallet.prefs.v1', rpcEndpoints: 'shiba-wallet.rpc-endpoints.v1', customNetworks: 'shiba-wallet.custom-networks.v1',
  wcConfig: 'shiba-wallet.wc-config.v1', priceConfig: 'shiba-wallet.price-config.v1', swapConfig: 'shiba-wallet.swap-config.v1',
  blockbook: 'shiba-wallet.blockbook.v1', evmIndexer: 'shiba-wallet.evm-indexer.v1', nftIndexer: 'shiba-wallet.nft-indexer.v1',
  mnemonic: 'shiba-wallet.mnemonic.v1', protectedMnemonic: 'shiba-wallet.mnemonic.v2', vaultMeta: 'shiba-wallet.vault-meta.v1',
  publicAccount: 'shiba-wallet.public-account.v1.', sessionKey: 'shiba-wallet.session-key.v1.',
  protectedSessionKey: 'shiba-wallet.session-key.v2.', importedKeysMeta: 'shiba-wallet.imported-keys.v1',
  importedKey: 'shiba-wallet.imported-key.v1.', protectedImportedKey: 'shiba-wallet.imported-key.v2.',
};
{
  const reg = seam.STORE_KEYS;
  check('the registry declares exactly the 39 key names the app used before the seam',
    Object.keys(reg).length === 39 && Object.keys(ORIGINAL_NAMES).length === 39 &&
      Object.entries(ORIGINAL_NAMES).every(([role, name]) => reg[role]?.name === name));
  check('names are unique', new Set(Object.values(reg).map((d) => d.name)).size === 39);
  const scopes = { wallet: 0, device: 0, secret: 0 };
  for (const d of Object.values(reg)) scopes[d.scope] += 1;
  check('scopes: 21 wallet, 9 device, 9 secret', scopes.wallet === 21 && scopes.device === 9 && scopes.secret === 9, JSON.stringify(scopes));
  check('every secret key lives in the secure store and every other key in AsyncStorage',
    Object.values(reg).every((d) => (d.scope === 'secret') === (d.backing === 'secure-store')));
  check('the protected keychain service and the notification identifiers keep their names',
    seam.PROTECTED_SECURE_STORE_SERVICE === 'shiba-wallet.protected' &&
      seam.NOTIFICATION_ID_NAMES.root === 'shiba-wallet.' && seam.NOTIFICATION_ID_NAMES.recurring === 'shiba-wallet.recurring.' &&
      seam.NOTIFICATION_ID_NAMES.takeover === 'shiba-wallet.takeover.' && seam.NOTIFICATION_ID_NAMES.priceAlert === 'shiba-wallet.price-alert.');

  // The owning modules' exported constants equal the original names.
  const mods = {
    tokens: await import('../src/wallet/tokens.ts'), notes: await import('../src/wallet/notes.ts'),
    sessions: await import('../src/wallet/sessions.ts'), pending: await import('../src/wallet/pending-transactions.ts'),
    priceAlerts: await import('../src/wallet/price-alerts.ts'), browser: await import('../src/wallet/browser-sites.ts'),
    custom: await import('../src/wallet/custom-networks.ts'), notifications: await import('../src/wallet/notifications.ts'),
    storage: await import('../src/wallet/storage.ts'), recovery: await import('../src/wallet/recovery.ts'),
  };
  const pairs = [
    [mods.tokens.MAINNET_TOKENS_KEY, 'shiba-wallet.tokens.v1'], [mods.tokens.tokenStoreKey('eip155:11155111'), 'shiba-wallet.tokens.v1.eip155:11155111'],
    [mods.notes.TX_NOTES_KEY, 'shiba-wallet.tx-notes.v1'], [mods.sessions.SESSIONS_KEY, 'shiba-wallet.sessions.v1'],
    [mods.pending.PENDING_TX_KEY, 'shiba-wallet.pending-tx.v1'], [mods.priceAlerts.PRICE_ALERTS_KEY, 'shiba-wallet.price-alerts.v1'],
    [mods.browser.BROWSER_CONNECTIONS_KEY, 'shiba-wallet.browser-connections.v1'], [mods.custom.CUSTOM_NETWORKS_KEY, 'shiba-wallet.custom-networks.v1'],
    [mods.notifications.NOTIFICATIONS_STORE_KEY, 'shiba-wallet.notifications.v1'], [mods.notifications.NOTIFICATION_ID_PREFIX, 'shiba-wallet.'],
    [mods.notifications.RECURRING_ID_PREFIX, 'shiba-wallet.recurring.'], [mods.notifications.TAKEOVER_ID_PREFIX, 'shiba-wallet.takeover.'],
    [mods.notifications.PRICE_ALERT_ID_PREFIX, 'shiba-wallet.price-alert.'],
    [mods.storage.MNEMONIC_KEY, 'shiba-wallet.mnemonic.v1'], [mods.storage.PROTECTED_MNEMONIC_KEY, 'shiba-wallet.mnemonic.v2'],
    [mods.storage.PROTECTED_KEYCHAIN_SERVICE, 'shiba-wallet.protected'], [mods.storage.VAULT_META_KEY, 'shiba-wallet.vault-meta.v1'],
    [mods.storage.PUBLIC_ACCOUNT_KEY_PREFIX, 'shiba-wallet.public-account.v1.'], [mods.storage.IMPORTED_KEYS_META_KEY, 'shiba-wallet.imported-keys.v1'],
    [mods.storage.IMPORTED_KEY_PREFIX, 'shiba-wallet.imported-key.v1.'], [mods.storage.PROTECTED_IMPORTED_KEY_PREFIX, 'shiba-wallet.imported-key.v2.'],
    [mods.recovery.RECOVERY_RECORDS_KEY, 'shiba-wallet.recovery-records.v1'], [mods.recovery.RECOVERY_PROGRESS_KEY, 'shiba-wallet.recovery-progress.v1'],
  ];
  const bad = pairs.filter(([a, b]) => a !== b);
  check(`the owning modules export the same key strings as before (${pairs.length} constants)`, bad.length === 0, JSON.stringify(bad));
  check('recovery.ts (still raw) uses the same names the registry declares', mods.recovery.RECOVERY_RECORDS_KEY === reg.recoveryRecords.name && mods.recovery.RECOVERY_PROGRESS_KEY === reg.recoveryProgress.name);
  check('every literal name in the source tree is declared (or is a notification identifier / the keychain service)',
    [...new Set(Object.values(tree).flatMap((t) => [...stripComments(t).matchAll(/'(shiba-wallet\.[A-Za-z0-9.:-]*)'/g)].map((m) => m[1])))]
      .every((k) => Object.values(seam.NOTIFICATION_ID_NAMES).includes(k) || k === seam.PROTECTED_SECURE_STORE_SERVICE || (() => { try { seam.storeKeyDeclaration(k); return true; } catch { return false; } })()));
  check('prefix keys resolve to their family (longest prefix wins; exact before prefix)',
    seam.storeKeyDeclaration('shiba-wallet.tokens.v1').name === 'shiba-wallet.tokens.v1' &&
      seam.storeKeyDeclaration('shiba-wallet.tokens.v1.eip155:84532').name === 'shiba-wallet.tokens.v1.' &&
      seam.storeKeyDeclaration('shiba-wallet.session-key.v2.11155111.0xab.00000000').scope === 'secret' &&
      seam.storeKeyDeclaration('shiba-wallet.imported-key.v1.3').name === 'shiba-wallet.imported-key.v1.' &&
      seam.storeKeyDeclaration('shiba-wallet.imported-keys.v1').name === 'shiba-wallet.imported-keys.v1');
  let undeclared = null;
  try { seam.scopedStoreKey('shiba-wallet.not-a-key.v1'); } catch (e) { undeclared = e; }
  check('an undeclared key is refused (UndeclaredStoreKeyError), never stored under a guess', undeclared instanceof seam.UndeclaredStoreKeyError);
}

// ---------------------------------------------------------------------------
console.log('check-storage-seam: the scope function (identity today)');
// ---------------------------------------------------------------------------
const SAMPLE_KEYS = [
  ...Object.values(seam.STORE_KEYS).filter((d) => d.match === 'exact').map((d) => d.name),
  'shiba-wallet.tokens.v1.eip155:11155111', 'shiba-wallet.public-account.v1.0', 'shiba-wallet.session-key.v1.11155111.0xab.12345678',
  'shiba-wallet.session-key.v2.11155111.0xab.12345678', 'shiba-wallet.imported-key.v1.0', 'shiba-wallet.imported-key.v2.9',
];
/** True when `fn` maps every sample key to itself (the Stage 1 contract). */
function identityHolds(fn) {
  return SAMPLE_KEYS.every((k) => fn(k) === k);
}
{
  check(`scopedStoreKey is the identity for every declared key and family (${SAMPLE_KEYS.length} samples)`, identityHolds((k) => seam.scopedStoreKey(k)));
  check('…also with the primary profile passed explicitly', identityHolds((k) => seam.scopedStoreKey(k, seam.PRIMARY_STORE_PROFILE)));
  check('mutant caught: a scope function that prefixes keys breaks the identity pin', !identityHolds((k) => `${k}.x`));
  check('the primary profile is frozen and has no prefix', Object.isFrozen(seam.PRIMARY_STORE_PROFILE) && seam.PRIMARY_STORE_PROFILE.keyPrefix === null);
  check('the seam offers no way to switch the active profile in Stage 1 (no exported setter)',
    !Object.keys(seam).some((k) => /^set|Profile$/.test(k) && typeof seam[k] === 'function'));

  // The design for Stage 2, exercised as a pure function (nothing uses it).
  const decoy = { id: 'second', keyPrefix: 'd1' };
  const moved = SAMPLE_KEYS.map((k) => [k, seam.scopedStoreKey(k, decoy), seam.storeKeyScope(k)]);
  check('another profile leaves every device key unchanged', moved.filter(([, , s]) => s === 'device').every(([k, m]) => k === m));
  check('…moves every wallet and secret key under shiba-wallet.profile-<prefix>.',
    moved.filter(([, , s]) => s !== 'device').every(([k, m]) => m === `shiba-wallet.profile-d1.${k.slice('shiba-wallet.'.length)}`));
  check('…to names no declared key or family can have (the profiles never read each other)',
    moved.filter(([, , s]) => s !== 'device').every(([, m]) => { try { seam.storeKeyDeclaration(m); return false; } catch { return true; } }));
  check('…and keeps the secure-store key alphabet ([A-Za-z0-9._-]) for secret keys',
    moved.filter(([, , s]) => s === 'secret').every(([, m]) => /^[A-Za-z0-9._-]+$/.test(m)));
  let badPrefix = null;
  try { seam.scopedStoreKey('shiba-wallet.accounts.v1', { id: 'x', keyPrefix: 'Bad.Prefix' }); } catch (e) { badPrefix = e; }
  check('a malformed profile prefix is refused', badPrefix !== null);
}

// ---------------------------------------------------------------------------
console.log('check-storage-seam: the wrappers behave exactly like the direct calls');
// ---------------------------------------------------------------------------
{
  const calls = [];
  const store = {
    map: new Map(),
    getItem(k) { calls.push(['get', k, this === store]); return Promise.resolve(this.map.has(k) ? this.map.get(k) : null); },
    setItem(k, v) { calls.push(['set', k, v, this === store]); this.map.set(k, v); return Promise.resolve(); },
    removeItem(k) { calls.push(['remove', k, this === store]); this.map.delete(k); return Promise.resolve(); },
    getAllKeys() { return Promise.resolve([...this.map.keys(), 'someone-else.key']); },
  };
  const value = JSON.stringify({ version: 1, entries: { 'eip155:1|0xab': [1, 'a"b\\c', null] } });
  let allSame = true;
  for (const key of SAMPLE_KEYS.filter((k) => seam.storeKeyDeclaration(k).backing === 'async-storage')) {
    calls.length = 0;
    await seam.writeStoreItem(store, key, value);
    const got = await seam.readStoreItem(store, key);
    await seam.removeStoreItem(store, key);
    const after = await seam.readStoreItem(store, key);
    allSame &&= calls.length === 4 && calls[0][0] === 'set' && calls[0][1] === key && calls[0][2] === value && calls[0][3] === true &&
      calls[1][1] === key && calls[2][0] === 'remove' && calls[2][1] === key && got === value && after === null;
  }
  check('write / read / remove reach the same raw key with the value byte for byte, called as methods of the store', allSame);
  store.map.set('shiba-wallet.accounts.v1', 'x');
  check('listStoreKeys lists only the app\'s keys', JSON.stringify(await seam.listStoreKeys(store)) === JSON.stringify(['shiba-wallet.accounts.v1']));

  const err = new Error('disk full');
  const rejecting = { getItem: () => Promise.reject(err), setItem: () => Promise.reject(err) };
  const r1 = await seam.readStoreItem(rejecting, 'shiba-wallet.contacts.v1').then(() => null, (e) => e);
  const r2 = await seam.writeStoreItem(rejecting, 'shiba-wallet.contacts.v1', '{}').then(() => null, (e) => e);
  check('a rejecting store rejects through the wrapper with the same error object', r1 === err && r2 === err);
  const throwing = { getItem: () => { throw err; }, setItem: () => { throw err; } };
  let sync = null;
  try { seam.readStoreItem(throwing, 'shiba-wallet.contacts.v1'); } catch (e) { sync = e; }
  check('a store that throws synchronously still throws synchronously (no async wrapper added)', sync === err);
  const p = Promise.resolve('same');
  check('the wrapper returns the store\'s own promise (no extra await or catch)', seam.readStoreItem({ getItem: () => p, setItem: () => p }, 'shiba-wallet.contacts.v1') === p);

  // Secure store.
  const scalls = [];
  const opts = { keychainService: 'shiba-wallet.protected', requireAuthentication: true };
  const backend = {
    getItemAsync(k, o) { scalls.push(['get', k, o, this === backend]); return Promise.resolve('v'); },
    setItemAsync(k, v, o) { scalls.push(['set', k, v, o, this === backend]); return Promise.resolve(); },
    deleteItemAsync(k, o) { scalls.push(['delete', k, o, this === backend]); return Promise.resolve(); },
    canUseBiometricAuthentication: () => true,
    whenUnlockedThisDeviceOnly: 6,
  };
  await seam.readSecureItem(backend, 'shiba-wallet.mnemonic.v2', opts);
  await seam.writeSecureItem(backend, 'shiba-wallet.session-key.v2.1.0xab.00000000', 'secret', opts);
  await seam.deleteSecureItem(backend, 'shiba-wallet.imported-key.v1.0', opts);
  check('secure-store wrappers pass the same key, value and the same options object, as methods of the backend',
    scalls[0][1] === 'shiba-wallet.mnemonic.v2' && scalls[0][2] === opts && scalls[0][3] &&
      scalls[1][1] === 'shiba-wallet.session-key.v2.1.0xab.00000000' && scalls[1][2] === 'secret' && scalls[1][3] === opts && scalls[1][4] &&
      scalls[2][1] === 'shiba-wallet.imported-key.v1.0' && scalls[2][2] === opts && scalls[2][3]);

  // The native adapter (moved from storage.ts, re-exported there unchanged).
  const mod = {
    getItemAsync: (k, o) => Promise.resolve(`g:${k}:${o.keychainService}`),
    setItemAsync: (k, v) => Promise.resolve(`s:${k}:${v}`),
    deleteItemAsync: (k) => Promise.resolve(`d:${k}`),
    canUseBiometricAuthentication: () => false,
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
  };
  const { nativeSecureStoreBackend } = await import('../src/wallet/storage.ts');
  const adapted = nativeSecureStoreBackend(mod);
  check('nativeSecureStoreBackend (storage.ts) still adapts the package exactly as before',
    (await adapted.getItemAsync('k', { keychainService: 's' })) === 'g:k:s' && (await adapted.setItemAsync('k', 'v', {})) === 's:k:v' &&
      (await adapted.deleteItemAsync('k', {})) === 'd:k' && adapted.canUseBiometricAuthentication() === false && adapted.whenUnlockedThisDeviceOnly === 6);
}

// ---------------------------------------------------------------------------
console.log('check-storage-seam: a real store module through the seam');
// ---------------------------------------------------------------------------
{
  const { loadContacts, addContact } = await import('../src/wallet/contacts.ts');
  const keys = [];
  const mem = new Map();
  const store = {
    getItem: async (k) => { keys.push(k); return mem.get(k) ?? null; },
    setItem: async (k, v) => { keys.push(k); mem.set(k, v); },
  };
  await loadContacts('eip155:1', store);
  const added = await addContact('eip155:1', 'Pin', '0x52908400098527886E0F7030069857D2E4169EE7', { store });
  const reloaded = await loadContacts('eip155:1', store);
  check('contacts.ts (migrated) reads and writes only its own original key in a fake store, and the record round-trips',
    keys.length >= 3 && keys.every((k) => k === 'shiba-wallet.contacts.v1') && reloaded.contacts.some((c) => c.name === added.name),
    JSON.stringify(keys));
  const { loadAccounts } = await import('../src/wallet/accounts.ts');
  const akeys = [];
  await loadAccounts({ getItem: async (k) => { akeys.push(k); return null; }, setItem: async (k) => { akeys.push(k); } });
  check('accounts.ts (migrated) reads only its own original key', akeys.length > 0 && akeys.every((k) => k === 'shiba-wallet.accounts.v1'), JSON.stringify(akeys));
}

console.log(`\ncheck-storage-seam: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
