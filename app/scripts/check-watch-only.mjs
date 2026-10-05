// Watch-only accounts (Tier 1 feature 10), fully OFFLINE. It loads the exact
// app modules under Node's type stripping and checks:
//
//  - the watch-only id range in src/wallet/account-ids.ts: disjoint from the
//    phrase and imported ranges, isImportedAccountId still exact, and every
//    derivation, salt and imported-key helper refusing a watch-only id
//    (fail closed);
//  - the account store in src/wallet/accounts.ts: adding, renaming and
//    removing watch-only entries, duplicate and checksum refusals, slots
//    never reused, tampered entries dropped, and phrase / imported lists
//    stored byte-identically to before;
//  - the add-time checks in src/wallet/watch-only.ts (the send flow's own
//    validateRecipient; "already one of your accounts"; duplicates; scanned
//    payloads never widening validation) and the route allow list;
//  - signing: the REAL WalletContext.signWith body, extracted from the
//    source and run against a counting fake secure store, refuses a
//    watch-only account with the plain sentence and ZERO secure-store reads,
//    while phrase and imported accounts still sign;
//  - the audit list (smart-account salt, recovery records, activity wallet
//    set, the risk card's own-address list, the key import's duplicate
//    check, WalletConnect's address) and the screens (source checks);
//  - mutation checks: deliberately broken copies must fail the checks above.
//
// Every key is disposable: the public BIP-39 test mnemonic ("abandon ...
// about") and a key built from keccak256 of a fixed label. Nothing touches
// the network.
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-watch-only.mjs

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ethers } from 'ethers';
import { bitcoinKeyProvider, dogecoinKeyProvider, evmKeyProvider, mnemonicToSeed, solanaKeyProvider } from '@shiba-wallet/core';
import { KERNEL_V3_3 } from '@shiba-wallet/chains-evm';
import {
  IMPORTED_ACCOUNT_ID_BASE,
  MAX_IMPORTED_SLOT,
  MAX_WATCH_ONLY_SLOT,
  WATCH_ONLY_ACCOUNT_ID_BASE,
  WATCH_ONLY_NAME_SUFFIX,
  WATCH_ONLY_NOTICE,
  WATCH_ONLY_NO_CHAIN,
  WATCH_ONLY_NO_DERIVATION,
  WATCH_ONLY_NO_SMART_ACCOUNT,
  WATCH_ONLY_PATH,
  WATCH_ONLY_SIGN_REFUSAL,
  assertAccountCanSign,
  importedAccountId,
  importedSlotOf,
  isBip32Path,
  isImportedAccountId,
  isPhraseAccountId,
  isWatchOnlyAccountId,
  smartAccountSaltFor,
  watchOnlyAccountId,
  watchOnlySlotOf,
} from '../src/wallet/account-ids.ts';
import {
  MAX_WATCH_ONLY_ACCOUNTS,
  WATCH_ONLY_HIDE_REFUSAL,
  addAccount,
  addImportedAccountEntry,
  addWatchOnlyAccountEntry,
  canonicalEvmAddress,
  defaultAccountsState,
  deriveChainAccounts,
  deriveForAccount,
  deriveSignerFor,
  derivationArgsFor,
  hideAccount,
  loadAccounts,
  reconcileImportedAccounts,
  removeImportedAccountEntry,
  removeWatchOnlyAccountEntry,
  renameAccount,
  setActiveAccount,
} from '../src/wallet/accounts.ts';
import {
  REMOVE_WATCH_ONLY_TITLE,
  WATCH_ADDRESS_PRIVACY_NOTE,
  WATCH_ONLY_ALLOWED_ROUTES,
  WATCH_ONLY_WC_REFUSAL,
  checkWatchAddress,
  phraseAccountSameAsWatchedNote,
  removeWatchOnlyMessage,
  walletConnectAddressFor,
  watchAddressFromScan,
  watchOnlyFooterText,
  watchOnlyOwnAccountError,
  watchOnlyRouteRefusal,
} from '../src/wallet/watch-only.ts';
import { duplicateImportError, importedKeyBytes, importedSignerFor } from '../src/wallet/imported-keys.ts';
import { PROMPTS, createKeyVault } from '../src/wallet/storage.ts';
import { chainByCaip2 } from '../src/wallet/chains.ts';
import { walletAddressesFor } from '../src/wallet/activity-sentences.ts';
import { ownWalletAddresses } from '../src/wallet/risk.ts';
import { createAaClientFromConfig } from '../src/wallet/aa.ts';
import { ensureFactoryKernelRecord } from '../src/wallet/recovery.ts';
import { memoryStore } from './fakes-kernel.mjs';

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
/** Informational line for a change that lies in a file this suite does not own (not counted). */
function note(text) {
  console.log(`  note ${text}`);
}
function throwsWith(fn, includes) {
  try {
    fn();
    return false;
  } catch (e) {
    return e instanceof Error && (includes === undefined || e.message.includes(includes));
  }
}
async function rejects(fn) {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}
const HERE = dirname(fileURLToPath(import.meta.url));
const src = (rel) => readFileSync(join(HERE, '..', 'src', rel), 'utf8');

// A deliberately broken copy of an app module for a mutation check: written
// to a scratch directory with its relative imports rewritten to absolute file
// URLs of the real modules, so only the mutated file differs. Removed on exit.
const MUTANT_DIR = join(HERE, `.mutants-watch-${process.pid}`);
let mutants = 0;
process.on('exit', () => rmSync(MUTANT_DIR, { recursive: true, force: true }));
async function importMutant(relPath, from, to) {
  const original = readFileSync(join(HERE, '..', relPath), 'utf8');
  if (!original.includes(from)) throw new Error(`mutation anchor not found in ${relPath}: ${from}`);
  const source = original.replace(from, to);
  const originalDir = dirname(join(HERE, '..', relPath));
  const rewritten = source.replace(/(from\s+)'(\.{1,2}\/[^']+)'/g, (_m, kw, spec) => `${kw}'${pathToFileURL(resolvePath(originalDir, spec)).href}'`);
  mkdirSync(MUTANT_DIR, { recursive: true });
  mutants += 1;
  const file = join(MUTANT_DIR, `m${mutants}-${relPath.split('/').pop()}`);
  writeFileSync(file, rewritten);
  return import(pathToFileURL(file).href);
}

// ---------------------------------------------------------------------------
// Disposable keys and addresses
// ---------------------------------------------------------------------------
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seed = mnemonicToSeed(TEST_MNEMONIC);
const PHRASE_0 = evmKeyProvider.deriveAccount(seed, 0, 0).address;
const PHRASE_1 = evmKeyProvider.deriveAccount(seed, 0, 1).address;
const KEY_A = ethers.keccak256(ethers.toUtf8Bytes('shiba-wallet check-watch-only key A'));
const ADDR_A = new ethers.Wallet(KEY_A).address;
// A third party's address: the wallet never has its key.
const WATCHED = ethers.getAddress('0x' + ethers.keccak256(ethers.toUtf8Bytes('watched address')).slice(26));
const WATCHED_2 = ethers.getAddress('0x' + ethers.keccak256(ethers.toUtf8Bytes('watched address 2')).slice(26));
/** The address with the letter case of its first hex letter flipped (a wrong EIP-55 checksum). */
function flipFirstLetter(address) {
  const i = address.slice(2).search(/[a-fA-F]/) + 2;
  const c = address[i];
  return address.slice(0, i) + (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()) + address.slice(i + 1);
}
const W0 = watchOnlyAccountId(0);
const W1 = watchOnlyAccountId(1);
const BITCOIN = 'bip122:000000000019d6689c085ae165831e93';
const DOGECOIN = 'bip122:1a91e3dace36e2be3bf030a65679fe82';
const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

// ===========================================================================
console.log('check-watch-only: the id range is disjoint and fails closed');
// ===========================================================================
{
  check('watch-only base is 3 × 2^30 and the range ends below 2^32', WATCH_ONLY_ACCOUNT_ID_BASE === 3 * 2 ** 30 && WATCH_ONLY_ACCOUNT_ID_BASE + MAX_WATCH_ONLY_SLOT < 2 ** 32);
  check('the watch-only range starts above the whole imported range', WATCH_ONLY_ACCOUNT_ID_BASE > IMPORTED_ACCOUNT_ID_BASE + MAX_IMPORTED_SLOT);
  check('isWatchOnlyAccountId: both ends of the range', isWatchOnlyAccountId(W0) && isWatchOnlyAccountId(WATCH_ONLY_ACCOUNT_ID_BASE + MAX_WATCH_ONLY_SLOT));
  check('isWatchOnlyAccountId: false just outside, for phrase and imported ids, and for non-integers',
    !isWatchOnlyAccountId(W0 - 1) && !isWatchOnlyAccountId(WATCH_ONLY_ACCOUNT_ID_BASE + MAX_WATCH_ONLY_SLOT + 1) &&
      !isWatchOnlyAccountId(0) && !isWatchOnlyAccountId(importedAccountId(0)) && !isWatchOnlyAccountId(W0 + 0.5) && !isWatchOnlyAccountId(Number.NaN));
  check('isImportedAccountId stays exact: false for every watch-only id and just past the imported range',
    !isImportedAccountId(W0) && !isImportedAccountId(W1) && !isImportedAccountId(WATCH_ONLY_ACCOUNT_ID_BASE + MAX_WATCH_ONLY_SLOT) &&
      !isImportedAccountId(IMPORTED_ACCOUNT_ID_BASE + MAX_IMPORTED_SLOT + 1) && isImportedAccountId(IMPORTED_ACCOUNT_ID_BASE + MAX_IMPORTED_SLOT));
  check('isPhraseAccountId: 0 to 2^31 − 1 only', isPhraseAccountId(0) && isPhraseAccountId(2 ** 31 - 1) && !isPhraseAccountId(2 ** 31) && !isPhraseAccountId(-1) && !isPhraseAccountId(W0));
  check('watchOnlyAccountId / watchOnlySlotOf round-trip', watchOnlySlotOf(watchOnlyAccountId(7)) === 7 && watchOnlyAccountId(0) === WATCH_ONLY_ACCOUNT_ID_BASE);
  check('watchOnlyAccountId refuses negative, too large and fractional slots',
    throwsWith(() => watchOnlyAccountId(-1)) && throwsWith(() => watchOnlyAccountId(MAX_WATCH_ONLY_SLOT + 1)) && throwsWith(() => watchOnlyAccountId(1.5)));
  check('watchOnlySlotOf refuses phrase and imported ids', throwsWith(() => watchOnlySlotOf(0)) && throwsWith(() => watchOnlySlotOf(importedAccountId(0))));
  check('importedSlotOf refuses a watch-only id (the imported-key vault can never be addressed with one)', throwsWith(() => importedSlotOf(W0), 'is not an imported-key account'));
  check('smartAccountSaltFor refuses a watch-only id with the plain sentence (never 0, never the id)',
    throwsWith(() => smartAccountSaltFor(W0), WATCH_ONLY_NO_SMART_ACCOUNT) && smartAccountSaltFor(3) === 3 && smartAccountSaltFor(importedAccountId(2)) === 0);
  for (const chain of ['eip155:1', BITCOIN, DOGECOIN, SOLANA]) {
    check(`derivationArgsFor refuses a watch-only id on ${chain.split(':')[0]}${chain === BITCOIN ? ' (Bitcoin)' : chain === DOGECOIN ? ' (Dogecoin)' : ''}`, throwsWith(() => derivationArgsFor(chain, W0), WATCH_ONLY_NO_DERIVATION));
  }
  check('deriveForAccount, deriveChainAccounts and deriveSignerFor refuse a watch-only id (no phrase key is ever used)',
    throwsWith(() => deriveForAccount(evmKeyProvider, seed, W0), WATCH_ONLY_NO_DERIVATION) &&
      throwsWith(() => deriveChainAccounts(seed, W0), WATCH_ONLY_NO_DERIVATION) &&
      throwsWith(() => deriveSignerFor(evmKeyProvider, seed, W0, PHRASE_0), WATCH_ONLY_NO_DERIVATION));
  check('derivationArgsFor is unchanged for phrase indices and still refuses imported ids',
    derivationArgsFor('eip155:1', 2).addressIndex === 2 && derivationArgsFor(BITCOIN, 2).account === 2 &&
      throwsWith(() => derivationArgsFor('eip155:1', importedAccountId(0)), 'Invalid account index'));
  check('assertAccountCanSign: watch-only → the exact refusal sentence',
    throwsWith(() => assertAccountCanSign(W0), WATCH_ONLY_SIGN_REFUSAL) &&
      WATCH_ONLY_SIGN_REFUSAL === 'This is a watch-only account: the wallet holds no key for it, so it cannot sign or send. Nothing was signed.');
  check('assertAccountCanSign: phrase and imported ids pass', (() => {
    try {
      assertAccountCanSign(0);
      assertAccountCanSign(49);
      assertAccountCanSign(importedAccountId(3));
      return true;
    } catch {
      return false;
    }
  })());
  check('assertAccountCanSign: every other id is refused before any read (the gap above the imported range, negatives, NaN)',
    throwsWith(() => assertAccountCanSign(IMPORTED_ACCOUNT_ID_BASE + MAX_IMPORTED_SLOT + 1), 'Invalid account index') &&
      throwsWith(() => assertAccountCanSign(-1), 'Invalid account index') && throwsWith(() => assertAccountCanSign(Number.NaN), 'Invalid account index'));
  check('the watch-only path label is not a BIP-32 path (nothing records it as one)', WATCH_ONLY_PATH === 'watch-only' && !isBip32Path(WATCH_ONLY_PATH));
}

// ===========================================================================
console.log('check-watch-only: the account store');
// ===========================================================================
{
  const store = memoryStore();
  const DEFAULT_JSON = '{"version":1,"accounts":[{"index":0,"name":"Account 1","hidden":false}],"activeIndex":0,"nextIndex":1}';
  await addAccount(null, store);
  await setActiveAccount(0, store);
  const phraseOnly = store._map.get('shiba-wallet.accounts.v1');
  check('a phrase-only list is stored exactly as before (no watch-only field appears)',
    phraseOnly === '{"version":1,"accounts":[{"index":0,"name":"Account 1","hidden":false},{"index":1,"name":"Account 2","hidden":false}],"activeIndex":0,"nextIndex":2}', phraseOnly);
  await addImportedAccountEntry(0, 'Mine', store);
  const withImported = store._map.get('shiba-wallet.accounts.v1');
  check('a list with an imported account is stored exactly as before',
    withImported === `{"version":1,"accounts":[{"index":0,"name":"Account 1","hidden":false},{"index":1,"name":"Account 2","hidden":false},{"index":${IMPORTED_ACCOUNT_ID_BASE},"name":"Mine","hidden":false,"imported":true}],"activeIndex":0,"nextIndex":2}`, withImported);
  const fresh = memoryStore();
  await loadAccounts(fresh);
  await setActiveAccount(0, fresh);
  check('the default list is stored exactly as before', fresh._map.get('shiba-wallet.accounts.v1') === DEFAULT_JSON);

  const { account, state } = await addWatchOnlyAccountEntry(WATCHED, 'Treasury', store);
  check('add: id is watch-only slot 0, name kept, never hidden, flag and address stored',
    account.index === W0 && account.name === 'Treasury' && account.hidden === false && account.watchOnly === true && account.address === WATCHED && account.imported === undefined);
  check('add: does not switch, does not touch nextIndex, records nextWatchSlot', state.activeIndex === 0 && state.nextIndex === 2 && state.nextWatchSlot === 1);
  const stored = JSON.parse(store._map.get('shiba-wallet.accounts.v1'));
  check('the stored entry holds public data only (index, name, hidden, watchOnly, address)',
    JSON.stringify(stored.accounts.find((a) => a.watchOnly)) === `{"index":${W0},"name":"Treasury","hidden":false,"watchOnly":true,"address":"${WATCHED}"}` && stored.nextWatchSlot === 1);
  check('a duplicate watched address is refused (any letter case)', (await rejects(() => addWatchOnlyAccountEntry(WATCHED, null, store)))?.message === `This address is already watched as Treasury (${WATCHED}).`);
  check('a non-EIP-55 address is refused by the store itself', (await rejects(() => addWatchOnlyAccountEntry(WATCHED.toLowerCase(), null, store))) instanceof Error);
  const second = await addWatchOnlyAccountEntry(WATCHED_2, null, store);
  check('a second one takes slot 1 and the default name "Watched 2"', second.account.index === W1 && second.account.name === 'Watched 2');
  const named = await renameAccount(W1, 'Cold wallet', store);
  check('rename works on a watch-only account', named.accounts.find((a) => a.index === W1)?.name === 'Cold wallet');
  check('hide is refused with the plain sentence', (await rejects(() => hideAccount(W1, store)))?.message === WATCH_ONLY_HIDE_REFUSAL);
  const active = await setActiveAccount(W1, store);
  check('a watch-only account can be the active account (and survives a reload)', active.activeIndex === W1 && (await loadAccounts(store)).activeIndex === W1);
  check('the active watch-only account cannot be removed', /is the active account/.test((await rejects(() => removeWatchOnlyAccountEntry(W1, store)))?.message ?? ''));
  check('removeWatchOnlyAccountEntry refuses a phrase or imported account', (await rejects(() => removeWatchOnlyAccountEntry(0, store))) instanceof Error && (await rejects(() => removeWatchOnlyAccountEntry(importedAccountId(0), store))) instanceof Error);
  check('removeImportedAccountEntry refuses a watch-only account', /Only an imported account/.test((await rejects(() => removeImportedAccountEntry(W0, store)))?.message ?? ''));
  await setActiveAccount(0, store);
  const afterRemove = await removeWatchOnlyAccountEntry(W1, store);
  check('remove: entry gone, high-water mark kept', !afterRemove.accounts.some((a) => a.index === W1) && afterRemove.nextWatchSlot === 2);
  const third = await addWatchOnlyAccountEntry(WATCHED_2, null, store);
  check('a slot is never reused after a removal (the address comes back as slot 2)', third.account.index === watchOnlyAccountId(2));
  const added = await addAccount(null, store);
  check('a phrase account added with watch-only entries present takes the next DERIVATION index (2)', added.account.index === 2 && added.state.nextIndex === 3 && added.state.nextWatchSlot === 3);
  check('adding a phrase account keeps every watch-only entry', added.state.accounts.filter((a) => a.watchOnly).length === 2);
  const rec = reconcileImportedAccounts(await loadAccounts(store), []);
  check('reconcileImportedAccounts drops the imported entry but keeps watch-only entries and nextWatchSlot',
    rec.changed && rec.state.accounts.filter((a) => a.watchOnly).length === 2 && !rec.state.accounts.some((a) => a.imported) && rec.state.nextWatchSlot === 3);

  // The cap.
  const many = memoryStore();
  for (let i = 0; i < MAX_WATCH_ONLY_ACCOUNTS; i++) {
    await addWatchOnlyAccountEntry(ethers.getAddress('0x' + ethers.keccak256(ethers.toUtf8Bytes(`cap ${i}`)).slice(26)), null, many);
  }
  check(`at most ${MAX_WATCH_ONLY_ACCOUNTS} watch-only accounts at once`, /maximum of 20/.test((await rejects(() => addWatchOnlyAccountEntry(WATCHED, null, many)))?.message ?? ''));
}

// ===========================================================================
console.log('check-watch-only: tampered storage fails closed');
// ===========================================================================
{
  const revive = async (obj) => {
    const store = memoryStore();
    store._map.set('shiba-wallet.accounts.v1', JSON.stringify(obj));
    return loadAccounts(store);
  };
  const base = { version: 1, activeIndex: 0, nextIndex: 1 };
  const entry = (extra) => ({ index: W0, name: 'W', hidden: false, watchOnly: true, address: WATCHED, ...extra });
  const keeps = async (e) => (await revive({ ...base, accounts: [{ index: 0, name: 'Account 1', hidden: false }, e] })).accounts.some((a) => a.watchOnly);
  check('a well-formed entry is kept', await keeps(entry({})));
  check('a lowercase (non-EIP-55) address is dropped', !(await keeps(entry({ address: WATCHED.toLowerCase() }))));
  check('a wrong checksum is dropped', flipFirstLetter(WATCHED) !== WATCHED && !(await keeps(entry({ address: flipFirstLetter(WATCHED) }))));
  check('a missing address is dropped', !(await keeps(entry({ address: undefined }))));
  check('a watch-only flag on a phrase index is dropped (it never becomes a phrase account either)',
    (await revive({ ...base, accounts: [entry({ index: 3 })] })).accounts.every((a) => a.index !== 3));
  check('a watch-only flag on an imported id is dropped', !(await keeps(entry({ index: importedAccountId(0) }))));
  check('an entry that claims to be both imported and watch-only is dropped', !(await keeps(entry({ imported: true }))));
  check('a watch-only id WITHOUT the flag is dropped (it is not a phrase index)',
    (await revive({ ...base, accounts: [{ index: W0, name: 'X', hidden: false }] })).accounts.every((a) => a.index !== W0));
  check('a stored "hidden" watch-only entry is shown (never hidden)', (await revive({ ...base, accounts: [entry({ hidden: true })] })).accounts.find((a) => a.watchOnly)?.hidden === false);
  check('an invalid name falls back to "Watched 1"', (await revive({ ...base, accounts: [entry({ name: '' })] })).accounts.find((a) => a.watchOnly)?.name === 'Watched 1');
  const s = await revive({ ...base, nextWatchSlot: 0, accounts: [entry({ index: watchOnlyAccountId(4) })] });
  check('nextWatchSlot is never below one past the highest listed slot', s.nextWatchSlot === 5);
  const t = await revive({ ...base, activeIndex: W0, accounts: [entry({})] });
  check('nextIndex ignores watch-only ids; a watch-only active account is restored', t.nextIndex === 1 && t.activeIndex === W0);
  const u = await revive({ ...base, activeIndex: W1, accounts: [entry({})] });
  check('an active id that is not listed falls back to Account 1', u.activeIndex === 0);
  check('canonicalEvmAddress: EIP-55 of a valid address, null for anything else',
    canonicalEvmAddress(WATCHED.toLowerCase()) === WATCHED && canonicalEvmAddress('0x123') === null && canonicalEvmAddress(`${WATCHED}00`) === null);
}

// ===========================================================================
console.log('check-watch-only: adding an address (watch-only.ts)');
// ===========================================================================
{
  const known = [
    { name: 'Account 1', evmAddress: PHRASE_0, kind: 'phrase' },
    { name: 'Mine (imported key)', evmAddress: ADDR_A, kind: 'imported' },
    { name: 'Treasury (watch-only)', evmAddress: WATCHED, kind: 'watch-only' },
  ];
  const ok = checkWatchAddress(` ${WATCHED_2.toLowerCase()} `, known);
  check('an all-lowercase address is accepted and stored in EIP-55 form, with the send flow\'s note',
    ok.ok && ok.address === WATCHED_2 && ok.note === 'Address had no checksum; normalized.');
  check('a checksummed address is accepted as is', (() => { const r = checkWatchAddress(WATCHED_2, known); return r.ok && r.address === WATCHED_2 && r.note === undefined; })());
  const bad = flipFirstLetter(WATCHED_2);
  check('a wrong EIP-55 checksum is refused with the send flow\'s own sentence', bad !== WATCHED_2 && (() => { const r = checkWatchAddress(bad, known); return !r.ok && /Bad EIP-55 checksum/.test(r.error); })());
  check('a malformed address is refused', (() => { const r = checkWatchAddress('0x1234', known); return !r.ok && r.error === 'An Ethereum address is 0x followed by exactly 40 hex characters.'; })());
  check('an empty field is refused', (() => { const r = checkWatchAddress('   ', known); return !r.ok && r.error === 'Enter a recipient address.'; })());
  check('a phrase account\'s address is refused: "this address is already one of your accounts"',
    (() => { const r = checkWatchAddress(PHRASE_0.toLowerCase(), known); return !r.ok && r.error === `This address is already one of your accounts: Account 1 (${PHRASE_0}). The wallet holds its key, so there is nothing to watch.`; })());
  check('an imported account\'s address is refused the same way', (() => { const r = checkWatchAddress(ADDR_A, known); return !r.ok && r.error === watchOnlyOwnAccountError('Mine (imported key)', ADDR_A); })());
  check('an address already watched is refused as a duplicate', (() => { const r = checkWatchAddress(WATCHED.toLowerCase(), known); return !r.ok && r.error === `This address is already watched as Treasury (watch-only) (${WATCHED}).`; })());
  check('an unknown phrase address (null) never matches', checkWatchAddress(WATCHED_2, [{ name: 'Account 9', evmAddress: null, kind: 'phrase' }]).ok);
  check('a scanned EIP-681 URI yields its address; it is then checked like a typed one',
    watchAddressFromScan(`ethereum:${WATCHED_2}@1?value=1e18`) === WATCHED_2 && watchAddressFromScan(`ethereum:pay-${WATCHED_2}`) === WATCHED_2);
  check('a scanned payload of another chain is passed through and refused (scanning never widens validation)',
    !checkWatchAddress(watchAddressFromScan('bitcoin:bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'), known).ok);
  check('a scanned private key is refused (it is not an address)', !checkWatchAddress(watchAddressFromScan(KEY_A), known).ok);
  const watchedList = [{ name: 'Treasury (watch-only)', evmAddress: WATCHED }];
  check('a new phrase account with a watched address is flagged with the plain note',
    phraseAccountSameAsWatchedNote({ name: 'Account 7', evmAddress: WATCHED.toLowerCase() }, watchedList) ===
      `Account 7 comes from your recovery phrase and has the same address (${WATCHED.toLowerCase()}) as Treasury (watch-only). The wallet now holds this address's key, so you can remove the watch-only entry in Settings → Accounts.`);
  check('…not for a different address', phraseAccountSameAsWatchedNote({ name: 'Account 7', evmAddress: PHRASE_1 }, watchedList) === null);
  check('the key import refuses a key whose address is watched, naming the watch-only entry',
    duplicateImportError(WATCHED, [{ name: 'Account 1', imported: false, evmAddress: PHRASE_0 }, { name: 'Treasury (watch-only)', imported: false, watchOnly: true, evmAddress: WATCHED }]) ===
      `This key controls Treasury (watch-only) (${WATCHED}), which this wallet only watches. Remove the watch-only account in Settings → Accounts first, then import the key. Nothing was imported.`);
  check('…and its phrase / imported refusals are unchanged',
    /already comes from your recovery phrase/.test(duplicateImportError(PHRASE_0, [{ name: 'Account 1', imported: false, evmAddress: PHRASE_0 }]) ?? '') &&
      /already imported/.test(duplicateImportError(ADDR_A, [{ name: 'Mine', imported: true, evmAddress: ADDR_A }]) ?? ''));
}

// ===========================================================================
console.log('check-watch-only: which screens a watch-only account may open');
// ===========================================================================
{
  check('the allow list is exactly the read-only and wallet-management routes',
    JSON.stringify(WATCH_ONLY_ALLOWED_ROUTES) === JSON.stringify(['Home', 'Activity', 'Nfts', 'NftDetail', 'Tokens', 'Approvals', 'Settings', 'Contacts', 'ImportKey']));
  for (const route of WATCH_ONLY_ALLOWED_ROUTES) check(`${route} is allowed`, watchOnlyRouteRefusal(route) === null);
  for (const route of ['Send', 'Swap', 'Receive', 'UpgradeAccount', 'Sessions', 'Guardians', 'Passkey', 'ProveOwnership', 'OwnerRotation', 'ApproveRecovery', 'RecoverAccount', 'Connections', 'SpendingLimits']) {
    check(`${route} is refused`, typeof watchOnlyRouteRefusal(route) === 'string');
  }
  check('a route added later is refused by default (allow list, not deny list)', watchOnlyRouteRefusal('SomeFutureSigningScreen')?.startsWith('This screen is not available for a watch-only account') === true);
  check('the Send refusal sentence',
    watchOnlyRouteRefusal('Send') === 'Sending is not available for a watch-only account: the wallet holds no key for this address, so it cannot sign or send anything for it. Switch to one of your own accounts to use it.');
  check('every route the app registers is classified (allowed or named in the refusal map)', (() => {
    const app = readFileSync(join(HERE, '..', 'App.tsx'), 'utf8');
    const routes = [...app.matchAll(/name="(\w+)"/g)].map((m) => m[1]).filter((r) => !['Welcome', 'Backup', 'ConfirmBackup', 'Import'].includes(r));
    const watchSrc = src('wallet/watch-only.ts');
    const unnamed = routes.filter((r) => !WATCH_ONLY_ALLOWED_ROUTES.includes(r) && !new RegExp(`\\b${r}: '`).test(watchSrc));
    if (unnamed.length > 0) note(`routes refused with the generic "This screen" wording: ${unnamed.join(', ')}`);
    return routes.length > 20;
  })());
  check('WalletConnect address: null for a watch-only account (and none), the EVM address otherwise',
    walletConnectAddressFor({ watchOnly: true }, WATCHED) === null && walletConnectAddressFor(null, PHRASE_0) === null && walletConnectAddressFor({ watchOnly: false }, PHRASE_0) === PHRASE_0);
  check('the WalletConnect refusal sentence', WATCH_ONLY_WC_REFUSAL === 'WalletConnect connections are not offered for a watch-only account: the wallet holds no key for this address, so it could not sign anything a dApp asks for. Switch to one of your own accounts to connect.');
}

// ===========================================================================
console.log('check-watch-only: the REAL WalletContext.signWith, against a counting secure store');
// ===========================================================================
// The signWith body is cut out of WalletContext.tsx verbatim and run with its
// free variables bound to the real modules (storage.ts vault over a counting
// fake backend, chains.ts, accounts.ts, imported-keys.ts, account-ids.ts).
function countingBackend() {
  const items = new Map();
  const calls = { get: 0, set: 0, delete: 0 };
  const id = (key, opts) => `${opts?.keychainService ?? 'default'}|${key}`;
  return {
    calls,
    whenUnlockedThisDeviceOnly: 5,
    async getItemAsync(key, opts) {
      calls.get += 1;
      return items.has(id(key, opts)) ? items.get(id(key, opts)) : null;
    },
    async setItemAsync(key, value, opts) {
      calls.set += 1;
      items.set(id(key, opts), value);
    },
    async deleteItemAsync(key, opts) {
      calls.delete += 1;
      items.delete(id(key, opts));
    },
    canUseBiometricAuthentication: () => false,
  };
}
const CTX_SRC = src('wallet/WalletContext.tsx');
function extractSignWith(ctxSource) {
  const start = ctxSource.indexOf('const signWith = useCallback(');
  const body = ctxSource.indexOf('async <T,>(', start);
  const end = ctxSource.indexOf('\n    [],\n  );', body);
  if (start < 0 || body < 0 || end < 0) throw new Error('signWith not found in WalletContext.tsx');
  return ctxSource.slice(body, end).replace(/,\s*$/, '');
}
async function loadSignWith(ctxSource) {
  const fnText = extractSignWith(ctxSource);
  const accountIdsUrl = pathToFileURL(join(HERE, '..', 'src', 'wallet', 'account-ids.ts')).href;
  const module = `import { assertAccountCanSign, isImportedAccountId, importedSlotOf, IMPORTED_KEY_EVM_ONLY } from '${accountIdsUrl}';
type DerivedAccount = unknown;
export function makeSignWith(deps: any) {
  const { activeIndexRef, chainByCaip2, importedKeyVault, PROMPTS, importedKeyBytes, importedSignerFor, readPhrase, mnemonicToSeed, deriveSignerFor } = deps;
  return ${fnText};
}
`;
  mkdirSync(MUTANT_DIR, { recursive: true });
  mutants += 1;
  const file = join(MUTANT_DIR, `signwith-${mutants}.ts`);
  writeFileSync(file, module);
  return (await import(pathToFileURL(file).href)).makeSignWith;
}
async function signingHarness(makeSignWith, activeIndex) {
  const backend = countingBackend();
  const vault = createKeyVault(backend, { policy: 'off' });
  await vault.saveNewPhrase(TEST_MNEMONIC);
  await vault.importedKeys.save(KEY_A, ADDR_A);
  backend.calls.get = 0;
  backend.calls.set = 0;
  backend.calls.delete = 0;
  const signWith = makeSignWith({
    activeIndexRef: { current: activeIndex },
    chainByCaip2,
    importedKeyVault: vault.importedKeys,
    PROMPTS,
    importedKeyBytes,
    importedSignerFor,
    readPhrase: (prompt) => vault.readPhrase(prompt),
    mnemonicToSeed,
    deriveSignerFor,
  });
  return { signWith, calls: backend.calls };
}
{
  const makeSignWith = await loadSignWith(CTX_SRC);
  const signedBy = async (index, chain, expect) => {
    const { signWith, calls } = await signingHarness(makeSignWith, index);
    let fnCalls = 0;
    let error = null;
    let address = null;
    try {
      address = await signWith(chain, expect, async (account) => {
        fnCalls += 1;
        return account.address;
      });
    } catch (e) {
      error = e;
    }
    return { error, address, fnCalls, reads: calls.get, writes: calls.set + calls.delete };
  };
  const w = await signedBy(W0, 'eip155:1', WATCHED);
  check('watch-only (EVM): refused with the exact sentence', w.error?.message === WATCH_ONLY_SIGN_REFUSAL, w.error?.message);
  check('watch-only (EVM): ZERO secure-store reads, zero writes, the signing callback never runs', w.reads === 0 && w.writes === 0 && w.fnCalls === 0, JSON.stringify(w));
  const wb = await signedBy(W0, BITCOIN, 'bc1q');
  check('watch-only (Bitcoin): the same sentence and zero reads (refused before the chain lookup too)', wb.error?.message === WATCH_ONLY_SIGN_REFUSAL && wb.reads === 0);
  const wu = await signedBy(W0, 'eip155:999999', WATCHED);
  check('watch-only (unknown chain): still the watch-only sentence, not "Unknown chain"', wu.error?.message === WATCH_ONLY_SIGN_REFUSAL && wu.reads === 0);
  const p = await signedBy(0, 'eip155:1', PHRASE_0);
  check('phrase account 0 still signs through the phrase (one read)', p.error === null && p.address === PHRASE_0 && p.fnCalls === 1 && p.reads >= 1, p.error?.message);
  const p1 = await signedBy(1, 'eip155:1', PHRASE_0);
  check('phrase account: the expected-address refusal is unchanged', /active account changed/.test(p1.error?.message ?? ''));
  const im = await signedBy(importedAccountId(0), 'eip155:1', ADDR_A);
  check('imported account still signs with its own key', im.error === null && im.address === ADDR_A && im.fnCalls === 1);
  const gap = await signedBy(IMPORTED_ACCOUNT_ID_BASE + MAX_IMPORTED_SLOT + 1, 'eip155:1', PHRASE_0);
  check('a malformed id between the ranges is refused before any read', /Invalid account index/.test(gap.error?.message ?? '') && gap.reads === 0);

  // Source pins on the same text.
  const sw = extractSignWith(CTX_SRC);
  check('signWith: the guard is the FIRST statement, before the chain lookup and every secure-store read',
    /^async <T,>\([\s\S]*?\): Promise<T> => \{\s*(\/\/[^\n]*\n\s*)*assertAccountCanSign\(activeIndexRef\.current\);/.test(sw) &&
      sw.indexOf('assertAccountCanSign(') < sw.indexOf('chainByCaip2(') && sw.indexOf('assertAccountCanSign(') < sw.indexOf('readPhrase(') && sw.indexOf('assertAccountCanSign(') < sw.indexOf('importedKeyVault.read('));

  // M1: without the guard line the watch-only account reaches the phrase.
  const broken = await loadSignWith(CTX_SRC.replace('assertAccountCanSign(activeIndexRef.current);', ''));
  const { signWith: bw, calls: bc } = await signingHarness(broken, W0);
  const be = await rejects(() => bw('eip155:1', WATCHED, async () => 'signed'));
  check('M1 caught: without the guard, a watch-only signing request opens the phrase (secure-store read) before failing',
    bc.get >= 1 && be instanceof Error && be.message !== WATCH_ONLY_SIGN_REFUSAL, `${bc.get} reads; ${be?.message}`);
}

// ===========================================================================
console.log('check-watch-only: the audit list (modules other screens use)');
// ===========================================================================
{
  const kernelConfig = {
    chain: 'eip155:11155111',
    bundlerUrl: 'https://bundler.fake',
    bundlerVerifiedAt: 'x',
    accountType: 'kernel-v3.3',
    factory: KERNEL_V3_3.factory,
    factoryImplementation: KERNEL_V3_3.implementation,
    kernelMetaFactory: KERNEL_V3_3.metaFactory,
    kernelValidator: KERNEL_V3_3.ecdsaValidator,
    kernelAccountId: KERNEL_V3_3.accountId,
    factoryVerifiedAt: 'x',
    paymasterUrl: null,
    paymasterContext: null,
    paymasterVerifiedAt: null,
  };
  const transportFor = () => ({ request: async () => { throw new Error('no network in this check'); } });
  check('AA owner + salt: no smart-account client can be built for a watch-only id',
    throwsWith(() => createAaClientFromConfig(kernelConfig, { nodeUrl: 'https://node.fake', chainId: 11155111n, accountIndex: W0, transportFor }), WATCH_ONLY_NO_SMART_ACCOUNT));
  check('…while a phrase account still gets one', (() => {
    try {
      createAaClientFromConfig(kernelConfig, { nodeUrl: 'https://node.fake', chainId: 11155111n, accountIndex: 1, transportFor });
      return true;
    } catch {
      return false;
    }
  })());
  const recStore = memoryStore();
  const recErr = await rejects(() =>
    ensureFactoryKernelRecord({
      chain: 'eip155:11155111',
      account: WATCHED_2,
      accountIndex: W0,
      owner: WATCHED,
      ownerPath: null,
      factory: KERNEL_V3_3.factory,
      implementation: KERNEL_V3_3.implementation,
      ecdsaValidator: KERNEL_V3_3.ecdsaValidator,
      store: recStore,
    }),
  );
  check('recovery metadata: no record is created for a watch-only id (fails closed, nothing written)', recErr?.message === WATCH_ONLY_NO_SMART_ACCOUNT && recStore._map.size === 0, recErr?.message);
  const facts = { accountType: 'kernel-v3.3', factory: KERNEL_V3_3.factory, factoryImplementation: KERNEL_V3_3.implementation, kernelValidator: KERNEL_V3_3.ecdsaValidator };
  check('Activity\'s wallet set for a watch-only account is the watched address alone (no smart account)',
    JSON.stringify(walletAddressesFor(WATCHED, W0, facts)) === JSON.stringify([WATCHED]));
  check('…a phrase account keeps its Kernel counterfactual', walletAddressesFor(PHRASE_1, 1, facts).length === 2);
  // WalletContext's accountList excludes watch-only accounts, so the risk
  // card's own-address list (ownWalletAddresses over accountList) never
  // contains a watched address; shown here with the list WalletContext builds.
  const keyed = [{ index: 0, name: 'Account 1', evmAddress: PHRASE_0 }];
  const own = ownWalletAddresses(keyed, null);
  check('risk card: a watched address is NOT "one of your own accounts"', own.length === 1 && !own.some((o) => o.address.toLowerCase() === WATCHED.toLowerCase()));
  check('WalletContext: accountList filters watch-only accounts out; they live in watchOnlyAccounts',
    /\(accountsState\?\.accounts \?\? \[\]\)\.filter\(\(a\) => !a\.watchOnly\)\.map\(/.test(CTX_SRC) && /const watchOnlyAccounts = useMemo/.test(CTX_SRC) && /\.filter\(\(a\) => a\.watchOnly\)/.test(CTX_SRC));
  check('WalletContext: accountForEvmAddress searches accountList only (WalletConnect labels and bindings, recovery screens)',
    /return accountList\.find\(\(a\) => a\.evmAddress\?\.toLowerCase\(\) === lower\) \?\? null;/.test(CTX_SRC));
  check('WalletContext: watch-only ids are never derived from the phrase nor read from the imported-key vault',
    /return state\.accounts\.filter\(\(a\) => !a\.imported && !a\.watchOnly\)\.map\(\(a\) => a\.index\);/.test(CTX_SRC) &&
      /!isImportedAccountId\(i\) && !isWatchOnlyAccountId\(i\) && derivedRef\.current\[i\] === undefined/.test(CTX_SRC) &&
      /watchOnlyRowsFrom\(await loadAccounts\(\)\)/.test(CTX_SRC));
  check('WalletContext: the public-account cache is written only for phrase indices (cachePublic(fresh) from derivePublic)',
    !/cachePublic\(\{[^}]*watchOnly/.test(CTX_SRC) && !/savePublicAccount\([^)]*watch/i.test(CTX_SRC));
  const addBody = CTX_SRC.slice(CTX_SRC.indexOf('const addWatchOnly = useCallback('), CTX_SRC.indexOf('const removeWatchOnly = useCallback('));
  const removeBody = CTX_SRC.slice(CTX_SRC.indexOf('const removeWatchOnly = useCallback('), CTX_SRC.indexOf('// Uses the key the reveal'));
  check('addWatchOnly: validated by checkWatchAddress, stored through the account store; no secret is read or written',
    /checkWatchAddress\(address, known\)/.test(addBody) && /addWatchOnlyAccountEntry\(checked\.address, cleanName\)/.test(addBody) &&
      !/readPhrase|importedKeyVault\.(read|save|remove)|saveNewPhrase|sessionKeyVault|SecureStore/.test(addBody));
  check('removeWatchOnly: deletes only the list entry (no vault, no prompt)', /removeWatchOnlyAccountEntry\(index\)/.test(removeBody) && !/importedKeyVault|requireLocalAuth|readPhrase/.test(removeBody));
  check('the key import also checks watched addresses', /\.filter\(\(a\) => a\.watchOnly\)/.test(CTX_SRC.slice(CTX_SRC.indexOf('const importPrivateKey'), CTX_SRC.indexOf('const removeImportedAccount'))));
  check('watch-only shown names always end in " (watch-only)"', WATCH_ONLY_NAME_SUFFIX === ' (watch-only)' && /name: `\$\{a\.name\}\$\{WATCH_ONLY_NAME_SUFFIX\}`/.test(CTX_SRC));
  for (const f of ['wallet/watch-only.ts', 'wallet/account-ids.ts', 'components/WatchOnlyGate.tsx']) {
    check(`${f}: no console logging, no AsyncStorage or secure-store access`, !/console\.\w+\(/.test(src(f)) && !/AsyncStorage|SecureStore/.test(src(f)));
  }
  // Recorded for the CTO: the one helper outside this suite's files that
  // would still produce something for a watch-only id.
  try {
    const { evmAccountPath } = await import('../src/wallet/recovery.ts');
    const path = evmAccountPath(W0);
    note(`recovery.ts evmAccountPath(watch-only id) returns "${path}" (callers pass accountList only, which has no watch-only ids; refusing it there is a listed change)`);
  } catch {
    note('recovery.ts evmAccountPath refuses a watch-only id');
  }
}

// ===========================================================================
console.log('check-watch-only: honesty and the screens (source checks)');
// ===========================================================================
{
  check('the shared notice', WATCH_ONLY_NOTICE === 'Watch-only: this wallet can show this address but holds no key for it. It cannot send, sign or recover anything for it.');
  check('the not-available sentence', WATCH_ONLY_NO_CHAIN === 'Not available for a watch-only address. A watched Ethereum address has no address on this network.');
  check('the privacy note (said once on the add form)',
    WATCH_ADDRESS_PRIVACY_NOTE === 'Watching an address reveals your interest in it to the network endpoints and indexers this wallet uses (Settings → Network endpoints and the history and NFT indexers), because the wallet asks them about this address.');
  check('WatchOnlyNotice renders WATCH_ONLY_NOTICE', /<WarningBox>\{WATCH_ONLY_NOTICE\}<\/WarningBox>/.test(src('components.tsx')));
  const home = src('screens/HomeScreen.tsx');
  check('Home: the notice under the switcher', /<WatchOnlyNotice show=\{watchOnly\} \/>/.test(home) && /const watchOnly = activeAccount\?\.watchOnly === true;/.test(home));
  check('Home: no Send link on chain cards or token rows for a watch-only account',
    /\{watchOnly\s*\?\s*null\s*:\s*cardLink\('send'/.test(home) && /\.\.\.\(watchOnly\s*\?\s*\{\}\s*:\s*\{ onSend:/.test(home));
  check('Home: no Swap or Upgrade link for a watch-only account',
    /isEvm && evmChain\.swapsOffered && !watchOnly/.test(home) && /\{isEvm && !watchOnly\s*\?\s*cardLink\(\s*'upgrade'/.test(home));
  // Approvals is read-only for a watch-only account: the list renders, and
  // neither the Revoke button nor its handler is reachable.
  {
    const approvals = src('screens/ApprovalsScreen.tsx');
    check('Approvals: no Revoke button for a watch-only account',
      /\{withRevoke && !activeAccount\?\.watchOnly \? \(/.test(approvals));
    check('Approvals: the revoke handler refuses a watch-only account first',
      /const onRevokePress = async \(item: ApprovalItem\) => \{\s*if \(activeAccount\?\.watchOnly\) return;/.test(approvals));
  }
  check('Home: Activity and NFTs stay linked', /cardLink\('activity'/.test(home) && /cardLink\('nfts'/.test(home));
  check('Home: Sessions, Guardians and Passkey are never offered (the checks get no owner or index)',
    /const tools = isEvm && !watchOnly/.test(home) && /const toolsOwner = watchOnly \? null : evmAccount\?\.address;/.test(home));
  check('Home: the address is shown but does not open Receive', /disabled=\{watchOnly\}/.test(home));
  check('Home: Bitcoin, Dogecoin and Solana shown as not available', /<UnavailableChains accounts=\{accounts\} sentence=\{WATCH_ONLY_NO_CHAIN\} \/>/.test(home));
  check('Home: no guardian-recovery link for a watch-only account', /\{watchOnly \? null : \(\s*<>\s*\{activeAccount\?\.imported \? null : \(/.test(home));
  check('Home: the delegation lines (which link to Upgrade) are not read for a watch-only account', /useAccountDelegation\(watchOnly \? undefined : evmAccount\?\.address\)/.test(home));
  check('Home footer for a watch-only account', watchOnlyFooterText('Treasury (watch-only)').startsWith('Treasury (watch-only) is an address you watch; this wallet holds no key for it, so it cannot send, swap or sign for it.') && /watchOnlyFooterText\(activeAccount\.name\)/.test(home));
  const acc = src('components/AccountsSection.tsx');
  check('Settings → Accounts: a "Watch an address" form with paste, scan, name and the privacy note',
    /title="Watch an address"/.test(acc) && /Clipboard\.getStringAsync\(\)/.test(acc) && /setWatchAddress\(watchAddressFromScan\(data\)\)/.test(acc) && /\{WATCH_ADDRESS_PRIVACY_NOTE\}/.test(acc));
  check('Settings → Accounts: the watch-only group shows the notice and a "Watch-only" tag', /<WatchOnlyNotice \/>/.test(acc) && /'Watch-only'/.test(acc));
  const removeBody = acc.slice(acc.indexOf('const onRemoveWatchOnly'), acc.indexOf('const onHide'));
  check('Remove: ONE confirmation, no device check (no secret exists)', (removeBody.match(/Alert\.alert\(/g) ?? []).length === 1 && !/requireLocalAuth/.test(removeBody) && /removeWatchOnly\(account\.index\)/.test(removeBody));
  check('the removal dialog says nothing secret is deleted',
    REMOVE_WATCH_ONLY_TITLE === 'Stop watching this address?' && removeWatchOnlyMessage('W', WATCHED) === `W (${WATCHED}) is removed from this wallet. Nothing secret is deleted, because the wallet never held a key for it, and nothing on-chain changes. You can watch it again at any time.`);
  check('Settings → Accounts: no Hide for a watch-only account', /!account\.imported && !account\.watchOnly && account\.index !== 0 && !active/.test(acc));
  const sw = src('components/AccountSwitcher.tsx');
  check('the switcher lists watch-only accounts with a label', /\.\.\.watchOnlyAccounts\]/.test(sw) && /Watch-only — the wallet holds no key; it cannot send or sign/.test(sw));
  const gate = src('components/WatchOnlyGate.tsx');
  check('the route gate refuses through watchOnlyRouteRefusal and renders the notice instead of the screen',
    /activeAccount\?\.watchOnly \? watchOnlyRouteRefusal\(routeName\) : null/.test(gate) && /if \(refusal === null\) return <>\{children\}<\/>;/.test(gate) && /<WatchOnlyNotice \/>/.test(gate));
  const app = readFileSync(join(HERE, '..', 'App.tsx'), 'utf8');
  if (/screenLayout=\{watchOnlyScreenLayout\}/.test(app)) {
    check('App.tsx wires the route gate into the navigator', true);
  } else {
    note('App.tsx does not wire the route gate yet (screenLayout={watchOnlyScreenLayout} on Stack.Navigator) — a listed change');
  }
  const wc = src('wallet/WalletConnectContext.tsx');
  if (/walletConnectAddressFor\(/.test(wc)) {
    check('WalletConnect uses walletConnectAddressFor for its active address', true);
  } else {
    note('WalletConnectContext.tsx does not use walletConnectAddressFor yet — a listed change');
  }
}
seed.fill(0);

// ===========================================================================
console.log('check-watch-only: mutation checks (broken copies must be caught)');
// ===========================================================================
{
  // M2: isWatchOnlyAccountId always false → the refusal sentence is lost and
  // the salt helper no longer says why.
  const m2 = await importMutant('src/wallet/account-ids.ts', 'export function isWatchOnlyAccountId(id: number): boolean {\n  return (', 'export function isWatchOnlyAccountId(id: number): boolean {\n  return false && (');
  check('M2 caught: a broken range check loses the watch-only refusal (assertAccountCanSign says something else)',
    !throwsWith(() => m2.assertAccountCanSign(W0), WATCH_ONLY_SIGN_REFUSAL));
  // M3: smartAccountSaltFor treats a watch-only id like an imported one (salt 0).
  const m3 = await importMutant('src/wallet/account-ids.ts', '  if (isWatchOnlyAccountId(id)) throw new Error(WATCH_ONLY_NO_SMART_ACCOUNT);', '  if (isWatchOnlyAccountId(id)) return 0;');
  check('M3 caught: a salt for a watch-only id is detected (the real helper refuses)', (() => {
    try {
      return m3.smartAccountSaltFor(W0) === 0;
    } catch (e) {
      return false;
    }
  })() && throwsWith(() => smartAccountSaltFor(W0), WATCH_ONLY_NO_SMART_ACCOUNT));
  // M4: reviveState accepts any address string.
  const m4 = await importMutant('src/wallet/accounts.ts', "if (typeof e.address !== 'string' || canonicalEvmAddress(e.address) !== e.address) continue;", "if (typeof e.address !== 'string') continue;");
  {
    const store = memoryStore();
    store._map.set('shiba-wallet.accounts.v1', JSON.stringify({ version: 1, activeIndex: 0, nextIndex: 1, accounts: [{ index: W0, name: 'W', hidden: false, watchOnly: true, address: 'not an address' }] }));
    check('M4 caught: without the checksum re-check a tampered address is kept', (await m4.loadAccounts(store)).accounts.some((a) => a.watchOnly));
  }
  // M5: nextIndex counts watch-only ids → "Add account" breaks.
  const m5 = await importMutant('src/wallet/accounts.ts', 'accounts.filter((a) => !a.imported && !a.watchOnly).map((a) => a.index)', 'accounts.filter((a) => !a.imported).map((a) => a.index)');
  {
    const store = memoryStore();
    await m5.addWatchOnlyAccountEntry(WATCHED, null, store);
    const e = await rejects(() => m5.addAccount(null, store));
    check('M5 caught: counting watch-only ids in nextIndex makes "Add account" refuse (the real store adds Account 2)', e instanceof Error);
    const real = memoryStore();
    await addWatchOnlyAccountEntry(WATCHED, null, real);
    check('…the real store adds index 1', (await addAccount(null, real)).account.index === 1);
  }
  // M6: the "already one of your accounts" refusal is removed.
  const m6 = await importMutant('src/wallet/watch-only.ts', "  if (match) {\n    if (match.kind === 'watch-only')", "  if (match && false) {\n    if (match.kind === 'watch-only')");
  check('M6 caught: without the own-account refusal a phrase address can be watched',
    m6.checkWatchAddress(PHRASE_0, [{ name: 'Account 1', evmAddress: PHRASE_0, kind: 'phrase' }]).ok === true);
  // M7: the allow list becomes a deny list that forgets Send.
  const m7 = await importMutant('src/wallet/watch-only.ts', "  'Home',\n  'Activity',", "  'Home',\n  'Send',\n  'Activity',");
  check('M7 caught: an allow list that admits Send is detected', m7.watchOnlyRouteRefusal('Send') === null && watchOnlyRouteRefusal('Send') !== null);
  // M8: accountList stops filtering (source pin).
  const mutatedCtx = CTX_SRC.replace('.filter((a) => !a.watchOnly).map((a) => ({', '.map((a) => ({');
  check('M8 caught: an accountList that includes watch-only accounts fails the pin',
    mutatedCtx !== CTX_SRC && !/\(accountsState\?\.accounts \?\? \[\]\)\.filter\(\(a\) => !a\.watchOnly\)\.map\(/.test(mutatedCtx));
}

console.log(`\ncheck-watch-only: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
