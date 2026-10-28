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
//     (the active one unless an app PIN's duress PIN opened the second
//     wallet); every key name equals the string the app stored before the
//     seam (no migration); a second profile (Stage 2's decoy wallet,
//     exercised by check-duress) moves only per-wallet and secret keys.
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

import ts from 'typescript';

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
// file (signature → count). EMPTY since phase 21: recovery.ts,
// config/prefs.ts and config/networks.ts read and write through the seam
// (their keys declared in store-keys.ts with their scopes: the recovery
// records and progress 'wallet', the preferences and the endpoint
// overrides 'device'), and the five screens and WalletConnectContext.tsx
// that only pass the default store along import the seam's re-export. The
// one remaining exception is WalletContext.tsx's value import of
// expo-secure-store (it binds the native module once and calls nothing),
// which the scan does not count as a finding and a check below pins.
// ---------------------------------------------------------------------------
export const ALLOW_LIST = {};

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
  check('the allow-list is empty: no file outside store-keys.ts touches a store directly', Object.keys(ALLOW_LIST).length === 0);
  check('send.ts (left alone this wave) has no raw storage access at all', Object.keys(scanSource(tree['src/wallet/send.ts'])).length === 0, JSON.stringify(scanSource(tree['src/wallet/send.ts'])));
  check('the last migrated keys keep their scopes: recovery records and progress per wallet, preferences and endpoint overrides per device',
    seam.storeKeyScope('shiba-wallet.recovery-records.v1') === 'wallet' && seam.storeKeyScope('shiba-wallet.recovery-progress.v1') === 'wallet' &&
      seam.storeKeyScope('shiba-wallet.prefs.v1') === 'device' && seam.storeKeyScope('shiba-wallet.rpc-endpoints.v1') === 'device');
  check('recovery.ts, prefs.ts and networks.ts name their keys through STORE_KEYS and import the seam, not the package',
    tree['src/wallet/recovery.ts'].includes('STORE_KEYS.recoveryRecords.name') && tree['src/wallet/recovery.ts'].includes('STORE_KEYS.recoveryProgress.name') &&
      tree['src/config/prefs.ts'].includes('STORE_KEYS.prefs.name') && tree['src/config/networks.ts'].includes('STORE_KEYS.rpcEndpoints.name') &&
      ['src/wallet/recovery.ts', 'src/config/prefs.ts', 'src/config/networks.ts'].every((f) => /from '\.\.?\/(?:wallet\/)?store-keys\.ts';/.test(tree[f])));
  check('the five screens and WalletConnectContext.tsx take the default store from the seam\'s re-export',
    ['src/screens/GuardiansScreen.tsx', 'src/screens/InheritanceScreen.tsx', 'src/screens/OwnerRotationScreen.tsx', 'src/screens/PasskeyScreen.tsx', 'src/screens/SessionsScreen.tsx']
      .every((f) => tree[f].includes("import { AsyncStorage } from '../wallet/store-keys';")) &&
      tree['src/wallet/WalletConnectContext.tsx'].includes("import { AsyncStorage } from './store-keys';"));
  const seamSrc = tree[SEAM_FILE];
  check('store-keys.ts imports expo-secure-store as a TYPE only (Node-loadable; the native module is injected)',
    /import type \* as ExpoSecureStore from 'expo-secure-store'/.test(seamSrc) && !/^import (?!type)[^\n]*'expo-secure-store'/m.test(seamSrc));
  check('the only value import of expo-secure-store is WalletContext.tsx, which binds the native module once (no call)',
    Object.entries(tree).filter(([, t]) => /^import (?!type)[^\n]*from 'expo-secure-store'/m.test(t)).map(([f]) => f).join(',') === 'src/wallet/WalletContext.tsx' &&
      (tree['src/wallet/WalletContext.tsx'].match(/bindSecureStore\(nativeSecureStoreBackend\(SecureStore\)\)/g) ?? []).length === 1);
  // Pass p22b: the language could not be saved and the inbox listed nothing
  // on the device; both were the users of lazyAppStore(), which loaded
  // AsyncStorage through a dynamic import (an asynchronous Metro chunk).
  // No file in src — the seam included — may load the package that way.
  const dynamicImports = (t) => (stripComments(t).match(/import\(\s*['"]@react-native-async-storage\/async-storage['"]\s*\)/g) ?? []).length;
  const withDynamic = Object.entries(tree).filter(([, t]) => dynamicImports(t) > 0).map(([f]) => f);
  check(`no dynamic import() of @react-native-async-storage/async-storage anywhere in src, store-keys.ts included (${Object.keys(tree).length} files)`,
    withDynamic.length === 0, withDynamic.join(', '));
  const lazyBody = seamSrc.slice(seamSrc.indexOf('export function lazyAppStore'), seamSrc.indexOf('\n}\n', seamSrc.indexOf('export function lazyAppStore')));
  check('lazyAppStore() calls the seam\'s own static AsyncStorage binding (no chunk, no require)',
    lazyBody.includes('getItem: async (k) => AsyncStorage.getItem(k)') && lazyBody.includes('setItem: async (k, v) => AsyncStorage.setItem(k, v)') && !/import\(|require\(/.test(stripComments(lazyBody)));
  {
    const OLD_LAZY =
      "export function lazyAppStore(): KeyValueStore {\n  let storePromise: Promise<KeyValueStore> | null = null;\n  const store = (): Promise<KeyValueStore> => {\n" +
      "    if (!storePromise) storePromise = import('@react-native-async-storage/async-storage').then((m) => m.default);\n    return storePromise;\n  };\n" +
      '  return {\n    getItem: async (k) => (await store()).getItem(k),\n    setItem: async (k, v) => (await store()).setItem(k, v),\n  };\n}';
    const start = seamSrc.indexOf('export function lazyAppStore');
    const end = seamSrc.indexOf('\n}\n', start) + 2;
    const mutant = seamSrc.slice(0, start) + OLD_LAZY + seamSrc.slice(end);
    check('…mutant caught (p22b): the old lazyAppStore with its dynamic import', dynamicImports(mutant) === 1 && dynamicImports(seamSrc) === 0);
  }
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
  const rec = tree['src/wallet/recovery.ts'];
  const recAnchor = 'await writeStoreItem(store, RECOVERY_PROGRESS_KEY, ';
  check('mutant anchor present in recovery.ts', rec.includes(recAnchor));
  const m5 = caught(rec.replace(recAnchor, 'await store.setItem(RECOVERY_PROGRESS_KEY, '), 'src/wallet/recovery.ts');
  check('mutant caught: recovery.ts writes its progress with store.setItem again (bypassing the seam)', m5.violations.some((v) => v.startsWith('src/wallet/recovery.ts: call .setItem(')), JSON.stringify(m5));
  const m5b = caught(tree['src/config/prefs.ts'].replace('const PREFS_KEY = STORE_KEYS.prefs.name;', "const PREFS_KEY = 'shiba-wallet.prefs.v1';"), 'src/config/prefs.ts');
  check('mutant caught: prefs.ts declares its key as a literal again', m5b.violations.some((v) => v.includes("key 'shiba-wallet.prefs.v1'")), JSON.stringify(m5b));
  const m5c = caught(tree['src/screens/SessionsScreen.tsx'].replace("import { AsyncStorage } from '../wallet/store-keys';", "import AsyncStorage from '@react-native-async-storage/async-storage';"), 'src/screens/SessionsScreen.tsx');
  check('mutant caught: a screen imports the AsyncStorage package again', m5c.violations.some((v) => v.includes('import @react-native-async-storage')), JSON.stringify(m5c));
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
  // Stage 2 (the app PIN, wallet/pin.ts) added one key, the app-lock record;
  // phase 21 added the Bridge screen's transfer list (wallet/bridge.ts);
  // phase 22 item 5 the notifications inbox (wallet/inbox.ts); phase 22
  // item 6 the device-wide language choice (i18n/language-store.ts); phase 23
  // item 6 the wallet handle's prepared registrations (wallet/handle.ts). The
  // 39 names the app used before the seam are unchanged.
  check('the registry declares exactly the 39 key names the app used before the seam, plus the app-lock record, the bridge transfers, the inbox, the language and the prepared handles (44)',
    Object.keys(reg).length === 44 && Object.keys(ORIGINAL_NAMES).length === 39 &&
      reg.inbox?.name === 'shiba-wallet.inbox.v1' && reg.inbox.scope === 'wallet' && reg.inbox.backing === 'async-storage' &&
      reg.language?.name === 'shiba-wallet.language.v1' && reg.language.scope === 'device' && reg.language.backing === 'async-storage' &&
      Object.entries(ORIGINAL_NAMES).every(([role, name]) => reg[role]?.name === name) &&
      reg.appLock?.name === 'shiba-wallet.app-lock.v1' && reg.appLock.scope === 'secret' && reg.appLock.backing === 'secure-store' &&
      reg.bridgeTransfers?.name === 'shiba-wallet.bridge-transfers.v1' && reg.bridgeTransfers.scope === 'wallet' && reg.bridgeTransfers.backing === 'async-storage' &&
      reg.handlePending?.name === 'shiba-wallet.handle-pending.v1' && reg.handlePending.scope === 'wallet' && reg.handlePending.backing === 'async-storage');
  check('names are unique', new Set(Object.values(reg).map((d) => d.name)).size === 44);
  const scopes = { wallet: 0, device: 0, secret: 0 };
  for (const d of Object.values(reg)) scopes[d.scope] += 1;
  check('scopes: 24 wallet, 10 device, 10 secret', scopes.wallet === 24 && scopes.device === 10 && scopes.secret === 10, JSON.stringify(scopes));
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
  check('recovery.ts (migrated) uses the same names the registry declares', mods.recovery.RECOVERY_RECORDS_KEY === reg.recoveryRecords.name && mods.recovery.RECOVERY_PROGRESS_KEY === reg.recoveryProgress.name);
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
  // Stage 2: the active profile exists (memory only) and starts as the
  // primary one; setActiveStoreProfile is its only setter and refuses a
  // malformed prefix (check-duress exercises the switch itself).
  check('Stage 2: the active profile starts as the primary one, and its one setter refuses a malformed prefix',
    seam.activeStoreProfile() === seam.PRIMARY_STORE_PROFILE &&
      Object.keys(seam).filter((k) => /^set/.test(k) && typeof seam[k] === 'function').join(',') === 'setActiveStoreProfile' &&
      (() => { try { seam.setActiveStoreProfile({ id: 'x', keyPrefix: 'Bad.Prefix' }); return false; } catch { return seam.activeStoreProfile() === seam.PRIMARY_STORE_PROFILE; } })());

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

// ---------------------------------------------------------------------------
console.log('check-storage-seam: the last migrated modules, per profile (phase 21)');
// ---------------------------------------------------------------------------
{
  const { savePrefs, loadPrefs } = await import('../src/config/prefs.ts');
  const { setEndpointOverride, resetEndpoint } = await import('../src/config/networks.ts');
  const { resetRecoveryRecords, removeRecoveryProgress, loadRecoveryRecords } = await import('../src/wallet/recovery.ts');
  const mem = new Map();
  const keys = [];
  const raw = {
    getItem: async (k) => { keys.push(k); return mem.has(k) ? mem.get(k) : null; },
    setItem: async (k, v) => { keys.push(k); mem.set(k, v); },
  };
  const decoy = seam.profileBoundStore(raw, { id: 'second', keyPrefix: 'w2' });
  await savePrefs({ hideAmounts: true }, decoy);
  check('prefs.ts through the seam: a second wallet reads and writes the SAME device key (shiba-wallet.prefs.v1), unprefixed',
    keys.includes('shiba-wallet.prefs.v1') && mem.has('shiba-wallet.prefs.v1') && !keys.some((k) => k.includes('prefs') && k.includes('profile-')) &&
      (await loadPrefs(raw)).hideAmounts === true);
  keys.length = 0;
  // The override setter and reset only read and write the store (no endpoint
  // is resolved or probed, so the offline guard sees no request; getEndpoint
  // without an override would probe the default endpoints).
  await setEndpointOverride('eip155:1', 'https://rpc.example/mainnet', { store: decoy });
  const savedFromDecoy = JSON.parse(mem.get('shiba-wallet.rpc-endpoints.v1') ?? '{}')['eip155:1'];
  const resetFromPrimary = await resetEndpoint('eip155:1', { store: raw });
  check('networks.ts through the seam: an override saved from a second wallet lands on the shared device key, and the first wallet sees and resets it',
    savedFromDecoy === 'https://rpc.example/mainnet' && resetFromPrimary === true &&
      keys.every((k) => !k.includes('rpc-endpoints') || k === 'shiba-wallet.rpc-endpoints.v1') && keys.includes('shiba-wallet.rpc-endpoints.v1'));
  keys.length = 0;
  await resetRecoveryRecords(decoy);
  await removeRecoveryProgress('eip155:11155111', '0x' + '22'.repeat(20), decoy);
  await loadRecoveryRecords(decoy);
  check('recovery.ts through the seam: a second wallet\'s records are its own (profile-prefixed); the first wallet\'s keys are never touched',
    mem.has('shiba-wallet.profile-w2.recovery-records.v1') && !mem.has('shiba-wallet.recovery-records.v1') && !mem.has('shiba-wallet.recovery-progress.v1') &&
      keys.every((k) => !k.startsWith('shiba-wallet.recovery-')));
  keys.length = 0;
  await resetRecoveryRecords(raw);
  check('…and the primary wallet keeps the original names (no migration)', mem.has('shiba-wallet.recovery-records.v1') && keys.includes('shiba-wallet.recovery-records.v1'));
}

// ---------------------------------------------------------------------------
console.log('check-storage-seam: the wipe clears every wallet-scoped key (pass p23-build finding 1)');
// ---------------------------------------------------------------------------
// Pass p23-build: "Wipe wallet" without an app PIN left the contacts on the
// phone, because neither wipe list in WalletContext.tsx reset them although
// store-keys.ts declares them per wallet. This section maps EVERY key
// declared with scope 'wallet' to the way the wipe clears it, so a key added
// later without a wipe entry fails here.
//
// WIPE_RESETS: the chain of functions that clears a key. The first is called
// by BOTH wipe paths (the plain wipe, and the app-PIN wipe's resetRecords,
// which ./duress.ts wipeBothWallets runs for each wallet before its sweep);
// each calls the next; the last, in the named module, calls writeStoreItem or
// removeStoreItem and names the module's own constant for the key
// (`const X = STORE_KEYS.<id>.name`).
export const WIPE_RESETS = {
  accounts: { module: 'src/wallet/accounts.ts', chain: ['resetAccounts', 'saveAccounts'] },
  contacts: { module: 'src/wallet/contacts.ts', chain: ['resetContacts'] },
  tokens: { module: 'src/wallet/tokens.ts', chain: ['resetTrackedTokens'] },
  tokensPerChain: { module: 'src/wallet/tokens.ts', chain: ['resetTrackedTokens'] },
  txNotes: { module: 'src/wallet/notes.ts', chain: ['wipeTransactionNotes'] },
  sessions: { module: 'src/wallet/sessions.ts', chain: ['forgetAllSessions', 'resetSessions'] },
  multisig: { module: 'src/wallet/multisig.ts', chain: ['resetMultisigRecords'] },
  recoveryRecords: { module: 'src/wallet/recovery.ts', chain: ['wipeRecoveryData', 'resetRecoveryRecords'] },
  recoveryProgress: { module: 'src/wallet/recovery.ts', chain: ['wipeRecoveryData'] },
  inheritance: { module: 'src/wallet/inheritance.ts', chain: ['resetTakeoverScanStates'] },
  passkeys: { module: 'src/wallet/passkeys.ts', chain: ['resetPasskeys'] },
  spendingPolicies: { module: 'src/wallet/spending-policy.ts', chain: ['resetSpendingLimits'] },
  spendingHistory: { module: 'src/wallet/spending-policy.ts', chain: ['resetSpendingLimits'] },
  pendingTx: { module: 'src/wallet/pending-transactions.ts', chain: ['resetPendingRegistry'] },
  browserConnections: { module: 'src/wallet/browser-sites.ts', chain: ['forgetBrowserConnections'] },
  priceAlerts: { module: 'src/wallet/price-alerts.ts', chain: ['resetPriceAlerts'] },
  bridgeTransfers: { module: 'src/wallet/bridge.ts', chain: ['resetBridgeTransfers'] },
  inbox: { module: 'src/wallet/inbox.ts', chain: ['wipeInbox'] },
  handlePending: { module: 'src/wallet/handle.ts', chain: ['resetPendingHandles'] },
};
// WIPE_NOT_RESET: the exact list of wallet-scoped keys the wipe lists do NOT
// reset by name, each with the reason and a source fact checked below. With
// an app PIN, wipeBothWallets' sweep (walletRecordsToRemove) removes every
// one of these too, since it keeps only device-scoped keys.
export const WIPE_NOT_RESET = {
  aaConfig: {
    how: 'partly cleared',
    reason: 'Mixed record (store-keys.ts): its per-wallet fields are cleared on both paths, the recovered-account links by wipeRecoveryData (clearAllRecoveredAccounts) and the EIP-7702 upgrade marks by clearAllEip7702Owners; its bundler, factory and paymaster fields are device settings shared by every wallet (aa.ts AA_ENDPOINT_FIELDS) and are kept by the wipe without an app PIN (the app-PIN sweep removes the whole record, as WIPE_WITH_PIN_NOTE says).',
  },
  notifications: {
    how: 'cleared indirectly',
    reason: 'Reminder bookkeeping: NotificationScheduler.tsx, on the status "no-wallet" the wipe sets, turns reminders off and runs cleanupIfOff, which cancels what was scheduled and writes the empty state (notifications.ts) when anything was recorded.',
  },
  wcSmartBindings: {
    how: 'kept',
    reason: 'Mirrors WalletConnect SDK sessions, which live in the SDK\'s own storage (wc@2 keys) that the wipe does not reach (THREAT_MODEL F-28, open); removing the binding alone would leave a surviving smart-account session without it.',
  },
  wcCalls: {
    how: 'kept',
    reason: 'ERC-5792 call records of those same WalletConnect sessions (7-day TTL), kept with them for the reason above (F-28).',
  },
  wcUsed: {
    how: 'kept',
    reason: 'The launch marker of the WalletConnect SDK (a boolean, no wallet data); it must agree with the SDK\'s own session storage, which the wipe does not reach (F-28).',
  },
};

function parseTs(rel, text) {
  return ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}
function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}
/** Names of every function called by a plain identifier inside `node`. */
function calledNames(node) {
  const names = new Set();
  walk(node, (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) names.add(n.expression.text);
  });
  return names;
}
/** Every identifier used inside `node`. */
function identifiersIn(node) {
  const names = new Set();
  walk(node, (n) => {
    if (ts.isIdentifier(n)) names.add(n.text);
  });
  return names;
}
/** The two wipe lists of WalletContext.tsx: the calls of resetRecords and of the plain path. */
export function wipeLists(walletContextText) {
  const sf = parseTs('src/wallet/WalletContext.tsx', walletContextText);
  let wipeBody = null;
  walk(sf, (n) => {
    if (wipeBody || !ts.isVariableDeclaration(n) || !ts.isIdentifier(n.name) || n.name.text !== 'wipe') return;
    const init = n.initializer;
    if (init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'useCallback') {
      const fn = init.arguments[0];
      if (fn && ts.isArrowFunction(fn) && ts.isBlock(fn.body)) wipeBody = fn.body;
    }
  });
  if (!wipeBody) return null;
  const pinIf = wipeBody.statements.find((st) => ts.isIfStatement(st) && st.expression.getText(sf) === 'appPinPresence.get()');
  if (!pinIf) return null;
  let resetRecords = null;
  walk(pinIf, (n) => {
    if (!resetRecords && ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'resetRecords' && n.initializer && ts.isArrowFunction(n.initializer)) {
      resetRecords = n.initializer;
    }
  });
  const pinCalls = resetRecords ? calledNames(resetRecords) : new Set();
  const plainCalls = new Set();
  for (const st of wipeBody.statements) if (st !== pinIf) for (const name of calledNames(st)) plainCalls.add(name);
  const sweepRunsResetRecords = /wipeBothWallets\(\{[\s\S]*?\bresetRecords,[\s\S]*?\}\);/.test(pinIf.getText(sf));
  return { pinCalls, plainCalls, sweepRunsResetRecords };
}
function functionNamed(sf, name) {
  let found = null;
  walk(sf, (n) => {
    if (!found && ts.isFunctionDeclaration(n) && n.name?.text === name && n.body) found = n;
  });
  return found;
}
/** The module's own constant for a declared key: `const X = STORE_KEYS.<id>.name`. */
function keyConstantOf(sf, id) {
  let found = null;
  walk(sf, (n) => {
    if (found || !ts.isVariableDeclaration(n) || !ts.isIdentifier(n.name) || !n.initializer) return;
    const init = n.initializer;
    if (ts.isPropertyAccessExpression(init) && init.name.text === 'name' && ts.isPropertyAccessExpression(init.expression) &&
      init.expression.name.text === id && ts.isIdentifier(init.expression.expression) && init.expression.expression.text === 'STORE_KEYS') {
      found = n.name.text;
    }
  });
  return found;
}
/**
 * Every problem of the wipe's coverage: `walletIds` are the STORE_KEYS ids of
 * scope 'wallet', `files` the sources by path (relative to app/).
 */
export function wipeCoverageProblems(walletIds, files, resets = WIPE_RESETS, notReset = WIPE_NOT_RESET) {
  const problems = [];
  const lists = wipeLists(files['src/wallet/WalletContext.tsx']);
  if (!lists) return ['WalletContext.tsx: the wipe callback, its app-PIN branch or resetRecords was not found'];
  if (!lists.sweepRunsResetRecords) problems.push('WalletContext.tsx: the app-PIN wipe does not pass resetRecords to wipeBothWallets');
  for (const id of walletIds) {
    const inResets = Object.prototype.hasOwnProperty.call(resets, id);
    const inNot = Object.prototype.hasOwnProperty.call(notReset, id);
    if (!inResets && !inNot) problems.push(`${id}: a wallet-scoped key the wipe does not clear (no reset in WalletContext.tsx, no reasoned entry)`);
    if (inResets && inNot) problems.push(`${id}: listed both as reset and as not reset`);
  }
  for (const id of [...Object.keys(resets), ...Object.keys(notReset)]) {
    if (!walletIds.includes(id)) problems.push(`${id}: listed here but not a wallet-scoped key in store-keys.ts (stale entry)`);
  }
  for (const [id, entry] of Object.entries(notReset)) {
    if (typeof entry.reason !== 'string' || entry.reason.length < 40) problems.push(`${id}: not reset by name, without a reason`);
  }
  const parsed = {};
  const sfOf = (rel) => (parsed[rel] ??= files[rel] === undefined ? null : parseTs(rel, files[rel]));
  for (const [id, { module, chain }] of Object.entries(resets)) {
    const first = chain[0];
    if (!lists.plainCalls.has(first)) problems.push(`${id}: ${first} is not called by the wipe without an app PIN`);
    if (!lists.pinCalls.has(first)) problems.push(`${id}: ${first} is not called by resetRecords (the wipe with an app PIN)`);
    const sf = sfOf(module);
    if (!sf) {
      problems.push(`${id}: ${module} not found`);
      continue;
    }
    const constant = keyConstantOf(sf, id);
    if (!constant) problems.push(`${id}: ${module} has no constant equal to STORE_KEYS.${id}.name`);
    for (let i = 0; i < chain.length; i += 1) {
      const fn = functionNamed(sf, chain[i]);
      if (!fn) {
        problems.push(`${id}: ${module} has no function ${chain[i]}`);
        break;
      }
      if (i < chain.length - 1) {
        if (!calledNames(fn.body).has(chain[i + 1])) problems.push(`${id}: ${chain[i]} does not call ${chain[i + 1]}`);
      } else {
        const calls = calledNames(fn.body);
        if (!calls.has('writeStoreItem') && !calls.has('removeStoreItem')) problems.push(`${id}: ${chain[i]} neither writes nor removes a key through the seam`);
        if (constant && !identifiersIn(fn.body).has(constant)) problems.push(`${id}: ${chain[i]} does not name ${constant}`);
      }
    }
  }
  return problems;
}

{
  const walletIds = Object.entries(seam.STORE_KEYS).filter(([, d]) => d.scope === 'wallet').map(([id]) => id);
  const problems = wipeCoverageProblems(walletIds, tree);
  check(`every wallet-scoped key (${walletIds.length}) is reset by both wipe paths, or listed with its reason (${Object.keys(WIPE_RESETS).length} reset, ${Object.keys(WIPE_NOT_RESET).length} not reset by name)`,
    problems.length === 0, problems.join('; '));
  check('…the lists cover exactly the declared wallet-scoped keys',
    JSON.stringify([...Object.keys(WIPE_RESETS), ...Object.keys(WIPE_NOT_RESET)].sort()) === JSON.stringify([...walletIds].sort()));
  const lists = wipeLists(tree['src/wallet/WalletContext.tsx']);
  check('…contacts, tracked tokens and the takeover-scan bookkeeping are reset on both paths (pass p23-build finding 1)',
    ['resetContacts', 'resetTrackedTokens', 'resetTakeoverScanStates'].every((f) => lists.plainCalls.has(f) && lists.pinCalls.has(f)));
  // The source facts behind the entries that are not reset by name.
  const rec = parseTs('src/wallet/recovery.ts', tree['src/wallet/recovery.ts']);
  check('aaConfig: wipeRecoveryData (called on both paths) clears the recovered-account links through clearAllRecoveredAccounts',
    calledNames(functionNamed(rec, 'wipeRecoveryData').body).has('clearAllRecoveredAccounts') && lists.plainCalls.has('wipeRecoveryData') && lists.pinCalls.has('wipeRecoveryData'));
  const aaSf = parseTs('src/wallet/aa.ts', tree['src/wallet/aa.ts']);
  const eip7702Cleared = (walletContextText, aaSource) => {
    const l = wipeLists(walletContextText);
    const fn = functionNamed(aaSource, 'clearAllEip7702Owners');
    return !!l && !!fn && l.plainCalls.has('clearAllEip7702Owners') && l.pinCalls.has('clearAllEip7702Owners') &&
      calledNames(fn.body).has('saveConfigMap') && /delete map\[key\]!\.eip7702Owners;/.test(fn.body.getText(aaSource));
  };
  check('aaConfig: clearAllEip7702Owners (called on both paths) deletes every chain\'s EIP-7702 upgrade marks and saves the record (pass p23-build finding 1)',
    eip7702Cleared(tree['src/wallet/WalletContext.tsx'], aaSf));
  const eipPlainLine = '    await clearAllEip7702Owners(AsyncStorage).catch(() => undefined);\n';
  check('mutant anchor present (the plain wipe clears the EIP-7702 marks)', tree['src/wallet/WalletContext.tsx'].includes(eipPlainLine));
  check('mutant caught: the EIP-7702 marks no longer cleared by the plain wipe',
    !eip7702Cleared(tree['src/wallet/WalletContext.tsx'].replace(eipPlainLine, ''), aaSf));
  const sched = tree['src/components/NotificationScheduler.tsx'];
  const notif = tree['src/wallet/notifications.ts'];
  check('notifications: the scheduler runs cleanupIfOff on "no-wallet", which writes the empty state through writeState (NOTIFICATIONS_STORE_KEY)',
    /status === 'no-wallet'\)\) void appNotifications\(\)\.cleanupIfOff\(\)/.test(sched) &&
      /cleanupIfOff: \(\) =>[\s\S]{0,400}await writeState\(deps\.store, emptyState\(\)\)/.test(notif) &&
      /async function writeState\(store: KeyValueStore, state: StoreState\): Promise<void> \{[\s\S]{0,200}NOTIFICATIONS_STORE_KEY/.test(notif));
  check('the WalletConnect keys kept by the plain wipe are the three that mirror the SDK\'s sessions',
    JSON.stringify(Object.entries(WIPE_NOT_RESET).filter(([, e]) => e.how === 'kept').map(([id]) => id).sort()) === JSON.stringify(['wcCalls', 'wcSmartBindings', 'wcUsed']));
  check('with an app PIN, the sweep removes every non-device key of every profile (walletRecordsToRemove skips only device scope)',
    /if \(storeKeyScope\(parsed\.key\) === 'device'\) continue;/.test(tree['src/wallet/duress.ts']));

  // Mutants, each must be caught.
  const wc = tree['src/wallet/WalletContext.tsx'];
  const plainLine = '    await resetContacts(AsyncStorage).catch(() => undefined);\n';
  const pinLine = '        await resetContacts(store).catch(() => undefined);\n';
  check('mutant anchors present (both contacts resets)', wc.includes(plainLine) && wc.includes(pinLine));
  const mPlain = wipeCoverageProblems(walletIds, { ...tree, 'src/wallet/WalletContext.tsx': wc.replace(plainLine, '') });
  check('mutant caught: the contacts reset removed from the plain wipe (the p23-build bug)', mPlain.some((p) => p.startsWith('contacts: resetContacts is not called by the wipe without')), mPlain.join('; '));
  const mPin = wipeCoverageProblems(walletIds, { ...tree, 'src/wallet/WalletContext.tsx': wc.replace(pinLine, '') });
  check('mutant caught: the contacts reset removed from resetRecords (the app-PIN wipe)', mPin.some((p) => p.startsWith('contacts: resetContacts is not called by resetRecords')), mPin.join('; '));
  const mNew = wipeCoverageProblems([...walletIds, 'futureRecord'], tree);
  check('mutant caught: a new wallet-scoped key with no wipe entry', mNew.some((p) => p.startsWith('futureRecord: a wallet-scoped key the wipe does not clear')), mNew.join('; '));
  const mStale = wipeCoverageProblems(walletIds.filter((id) => id !== 'inbox'), tree);
  check('mutant caught: a stale entry (a key no longer declared per wallet)', mStale.some((p) => p.startsWith('inbox: listed here but not')), mStale.join('; '));
  const contactsSrc = tree['src/wallet/contacts.ts'];
  const writeAnchor = 'await writeStoreItem(store, CONTACTS_KEY, JSON.stringify({ version: STORE_VERSION, networks: {} }));';
  check('mutant anchor present (resetContacts writes the empty store)', contactsSrc.includes(writeAnchor));
  const mBody = wipeCoverageProblems(walletIds, { ...tree, 'src/wallet/contacts.ts': contactsSrc.replace(writeAnchor, 'void store;') });
  check('mutant caught: resetContacts no longer writes its key', mBody.some((p) => p.startsWith('contacts: resetContacts neither writes nor removes')), mBody.join('; '));
  const mChain = wipeCoverageProblems(walletIds, tree, { ...WIPE_RESETS, sessions: { module: 'src/wallet/sessions.ts', chain: ['forgetAllSessions', 'resetPasskeys'] } });
  check('mutant caught: a chain link that is not called', mChain.some((p) => p.startsWith('sessions: forgetAllSessions does not call resetPasskeys')), mChain.join('; '));
  const mReason = wipeCoverageProblems(walletIds, tree, WIPE_RESETS, { ...WIPE_NOT_RESET, wcUsed: { how: 'kept', reason: '' } });
  check('mutant caught: an entry not reset by name without its reason', mReason.some((p) => p.startsWith('wcUsed: not reset by name, without a reason')), mReason.join('; '));
}

// The three resets added for finding 1, behaviour through the seam.
{
  const { resetTrackedTokens, MAINNET_TOKENS_KEY } = await import('../src/wallet/tokens.ts');
  const { resetContacts } = await import('../src/wallet/contacts.ts');
  const { resetTakeoverScanStates, INHERITANCE_STORE_KEY } = await import('../src/wallet/inheritance.ts');
  const mem = new Map([
    [MAINNET_TOKENS_KEY, '[]'],
    [`${MAINNET_TOKENS_KEY}.eip155:11155111`, '[]'],
    [`${MAINNET_TOKENS_KEY}.eip155:99999`, '[]'],
    ['shiba-wallet.profile-w2.tokens.v1', '[]'],
    ['shiba-wallet.profile-w2.tokens.v1.eip155:11155111', '[]'],
    ['shiba-wallet.contacts.v1', '{"version":1,"networks":{"eip155:1":[]}}'],
    [INHERITANCE_STORE_KEY, '{"version":1,"entries":{"x":{}}}'],
  ]);
  const store = {
    getItem: async (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: async (k, v) => { mem.set(k, v); },
    removeItem: async (k) => { mem.delete(k); },
    getAllKeys: async () => [...mem.keys()],
  };
  const removed = await resetTrackedTokens(store);
  check('resetTrackedTokens: removes the primary wallet\'s mainnet list, a built-in network\'s and one of a network no longer registered; the second wallet\'s lists stay',
    removed === 3 && !mem.has(MAINNET_TOKENS_KEY) && !mem.has(`${MAINNET_TOKENS_KEY}.eip155:11155111`) && !mem.has(`${MAINNET_TOKENS_KEY}.eip155:99999`) &&
      mem.has('shiba-wallet.profile-w2.tokens.v1') && mem.has('shiba-wallet.profile-w2.tokens.v1.eip155:11155111'), String(removed));
  const decoy = seam.profileBoundStore(store, { id: 'second', keyPrefix: 'w2' });
  const removedDecoy = await resetTrackedTokens(decoy);
  check('…through a store bound to the second wallet (no listing): that wallet\'s lists of the known networks go',
    removedDecoy === 2 && !mem.has('shiba-wallet.profile-w2.tokens.v1') && !mem.has('shiba-wallet.profile-w2.tokens.v1.eip155:11155111'), String(removedDecoy));
  let refused = false;
  try {
    await resetTrackedTokens({ getItem: store.getItem, setItem: store.setItem });
  } catch {
    refused = true;
  }
  check('…refuses a store that cannot delete keys (an empty list would hide the defaults)', refused);
  await resetContacts(store);
  await resetTakeoverScanStates(store);
  check('resetContacts and resetTakeoverScanStates leave empty documents',
    mem.get('shiba-wallet.contacts.v1') === '{"version":1,"networks":{}}' && mem.get(INHERITANCE_STORE_KEY) === '{"version":1,"entries":{}}');
  // clearAllEip7702Owners: the marks go, the endpoint fields of the same record stay.
  const { clearAllEip7702Owners } = await import('../src/wallet/aa.ts');
  const AA_KEY = seam.STORE_KEYS.aaConfig.name;
  mem.set(AA_KEY, JSON.stringify({
    'eip155:11155111': { bundlerUrl: 'https://bundler.example/rpc', eip7702Owners: ['0x772eAA1d3BEf14C0BD5cee980b90dB3FC680F44F'] },
    'eip155:84532': { bundlerUrl: 'https://bundler.example/base' },
  }));
  await clearAllEip7702Owners(store);
  const aaAfter = JSON.parse(mem.get(AA_KEY));
  check('clearAllEip7702Owners: every chain\'s EIP-7702 marks are deleted, the bundler fields stay byte for byte',
    aaAfter['eip155:11155111'].eip7702Owners === undefined && aaAfter['eip155:11155111'].bundlerUrl === 'https://bundler.example/rpc' &&
      aaAfter['eip155:84532'].bundlerUrl === 'https://bundler.example/base', mem.get(AA_KEY));
}

// The wipe dialog names what it deletes and keeps (finding 1), exactly.
{
  const { en } = await import('../src/i18n/en.ts');
  const { es } = await import('../src/i18n/es.ts');
  check('the wipe dialog\'s records sentence, exactly',
    en['settings.wipe.records'] ===
      "Your contacts, tracked tokens (each network's list returns to its defaults), transaction notes, account names, watched addresses, multi-signature account records, spending limits, price alerts, in-app browser connections, the pending-transaction and bridge-transfer lists, the inbox, any unfinished name registration and the record of which accounts were upgraded with EIP-7702 are deleted from this device too (an upgrade stays on-chain, and after a restore the Upgrade screen offers to use it again). A records backup made first (Settings → Records backup) can bring back the contacts, tracked tokens, notes, smart-account recovery records, multi-signature account records, spending limits, price alerts and bridge transfers. Settings that belong to this phone are kept: preferences, the language, network endpoints and indexers, the smart-account bundler, factory and paymaster settings, networks you added and API keys. WalletConnect connections are kept too — disconnect them first (Settings → WalletConnect → Connected apps) if you no longer want them." &&
      typeof es['settings.wipe.records'] === 'string' && es['settings.wipe.records'].length > 100);
  check('…shown in the dialog after the body and before the app-lock note',
    tree['src/screens/SettingsScreen.tsx'].includes("t('settings.wipe.body') +\n        // Pass p23-build finding 1: name the other records the wipe deletes\n        // (contacts were kept before the fix) and what it keeps.\n        ` ${t('settings.wipe.records')}` +\n        (appPinOn ? ` ${localize(wipeWithLockNote(settingsLockKind))}` : ''),"));
}

console.log(`\ncheck-storage-seam: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
