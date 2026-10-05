// Single private-key import (Tier 1 feature 12; ADR D9 in
// docs/ARCHITECTURE.md), fully OFFLINE. It loads the exact app modules
// under Node's type stripping and checks:
//
//  - validation of pasted / typed / scanned text with the engine's own
//    range check and address derivation, cross-checked against ethers;
//  - duplicate refusals (a listed recovery-phrase account, an earlier import);
//  - the imported-key vault in src/wallet/storage.ts against a FAKE
//    expo-secure-store that models expo-secure-store 57.0.4 (the same model
//    as check-storage.mjs: Android prompts on protected writes and reads,
//    iOS only on reads, a biometric change invalidates protected items, a
//    cancel is an error containing "cancel"): standard and protected saves,
//    the migration when the phrase is protected (with failures injected at
//    every step), interrupted moves, invalidation, the approval gate's
//    single prompt, removal, wipe, damaged records, launch without a prompt;
//  - the account store's imported entries and the fail-closed id range
//    (derivationArgsFor refuses every imported id);
//  - signing selection: the imported signer, its EVM-only and
//    expected-address refusals, and a full EOA send signed by an imported
//    key and decoded by ethers;
//  - a Kernel v3.3 smart-account operation owned by an imported key
//    (salt 0), and every feature that refuses an imported owner;
//  - the screens' honesty and input-hygiene rules (source checks);
//  - mutation checks: deliberately broken copies of storage.ts must fail
//    the checks above.
//
// Every key is disposable and built at runtime: the public BIP-39 test
// mnemonic ("abandon ... about") and keccak256 of fixed labels. Nothing
// touches the network.
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-key-import.mjs

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ethers } from 'ethers';
import { bitcoinKeyProvider, evmKeyProvider, mnemonicToSeed, solanaKeyProvider } from '@shiba-wallet/core';
import { ENTRYPOINT_V07, KERNEL_V3_3, getUserOpHash, predictKernelAddress } from '@shiba-wallet/chains-evm';
import {
  IMPORTED_KEYS_DAMAGED_MESSAGE,
  IMPORTED_KEYS_META_KEY,
  IMPORTED_KEY_MISSING_MESSAGE,
  IMPORTED_KEY_PREFIX,
  IMPORTED_KEY_UNREADABLE_MESSAGE,
  MAX_IMPORTED_KEYS,
  MNEMONIC_KEY,
  PROMPTS,
  PROTECTED_IMPORTED_KEY_PREFIX,
  PROTECTED_KEYCHAIN_SERVICE,
  PROTECTED_MNEMONIC_KEY,
  PUBLIC_ACCOUNT_KEY_PREFIX,
  createKeyVault,
  parseImportedKeysMeta,
} from '../src/wallet/storage.ts';
import {
  PROTECT_CONFIRM_MESSAGE,
  describeProtectionStatus,
  describeUpgradeOutcome,
  importedKeysProtectionNote,
  importedKeysSubject,
  protectConfirmMessage,
} from '../src/wallet/phrase-protection-copy.ts';
import {
  ACCOUNT_CHANGED_MESSAGE,
  IMPORTED_HIDE_REFUSAL,
  MAX_ACCOUNTS,
  addAccount,
  addImportedAccountEntry,
  derivationArgsFor,
  deriveChainAccounts,
  deriveForAccount,
  hideAccount,
  loadAccounts,
  reconcileImportedAccounts,
  removeImportedAccountEntry,
  setActiveAccount,
} from '../src/wallet/accounts.ts';
import {
  IMPORTED_ACCOUNT_ID_BASE,
  IMPORTED_KEY_EVM_ONLY,
  IMPORTED_KEY_NOT_BACKED_UP,
  IMPORTED_KEY_NO_CHAIN,
  IMPORTED_KEY_PATH,
  IMPORTED_NAME_SUFFIX,
  importedAccountId,
  importedSlotOf,
  isBip32Path,
  isImportedAccountId,
  smartAccountSaltFor,
} from '../src/wallet/account-ids.ts';
import {
  KEY_ADDRESS_INSTEAD_ERROR,
  KEY_EMPTY_ERROR,
  KEY_LOOKS_LIKE_PHRASE_ERROR,
  KEY_NOT_HEX_ERROR,
  KEY_OUT_OF_RANGE_ERROR,
  KEY_ZERO_ERROR,
  PHRASE_ACCOUNT_WAS_IMPORTED_TITLE,
  accountsBackupHint,
  duplicateImportError,
  importedKeyBytes,
  importedRemovalStrandedSentence,
  phraseAccountSameAsImportedNote,
  removeImportedMessage,
  importedSignerFor,
  keyLengthError,
  parsePrivateKeyInput,
} from '../src/wallet/imported-keys.ts';
import { createAaClientFromConfig, prepareAaSend, readOwnerSmartAccountHoldings, resolveAaSender, sendAa } from '../src/wallet/aa.ts';
import {
  GUARDIAN_IMPORTED_REFUSAL,
  OWNER_ROTATION_IMPORTED_NOT_OFFERED,
  OWNER_ROTATION_IMPORTED_REFUSAL,
  OWNER_ROTATION_IMPORTED_TARGET,
  RECOVERY_IMPORTED_OWNER_REFUSAL,
  attachRecoveredAccount,
  checkOwnerRotationTarget,
  draftRecoveryProgress,
  ensureFactoryKernelRecord,
  evmAccountPath,
  recoveryRecordListener,
  resolveGuardianAccount,
  resolveOwnerRotationAccount,
} from '../src/wallet/recovery.ts';
import { walletAddressesFor } from '../src/wallet/activity-sentences.ts';
import { ownWalletAddresses } from '../src/wallet/risk.ts';
import { WC_KERNEL_SMART_ACCOUNT_METHODS, loadSmartBindings, saveSmartBinding } from '../src/wallet/walletconnect.ts';
import { sendEvm } from '../src/wallet/send.ts';
import { featureReadiness } from '../src/config/readiness.ts';
import { USEROP_HASH, decodeKernelExecute, fakeBundler, fakeKernelNode, fromRpcOp, memoryStore } from './fakes-kernel.mjs';

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
async function rejects(fn) {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}
async function checkRejects(name, fn, includes) {
  const e = await rejects(fn);
  check(name, e instanceof Error && (includes === undefined || e.message.includes(includes)), e ? e.message : 'no error');
}
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const HERE = dirname(fileURLToPath(import.meta.url));
const src = (rel) => readFileSync(join(HERE, '..', 'src', rel), 'utf8');

// A deliberately broken copy of an app module for a mutation check: written
// to a scratch directory with its relative imports rewritten to absolute file
// URLs of the real modules, so only the mutated file differs. Removed on exit.
const APP_MUTANT_DIR = join(HERE, `.mutants-app-${process.pid}`);
let appMutants = 0;
process.on('exit', () => rmSync(APP_MUTANT_DIR, { recursive: true, force: true }));
async function importAppMutant(relPath, source) {
  const originalDir = dirname(join(HERE, '..', relPath));
  const rewritten = source.replace(/(from\s+)'(\.{1,2}\/[^']+)'/g, (_m, kw, spec) => `${kw}'${pathToFileURL(resolvePath(originalDir, spec)).href}'`);
  mkdirSync(APP_MUTANT_DIR, { recursive: true });
  appMutants += 1;
  const file = join(APP_MUTANT_DIR, `m${appMutants}-${relPath.split('/').pop()}`);
  writeFileSync(file, rewritten);
  return import(pathToFileURL(file).href);
}

// ---------------------------------------------------------------------------
// Disposable keys, built at runtime
// ---------------------------------------------------------------------------
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PHRASE = TEST_MNEMONIC;
const label = (text) => ethers.keccak256(ethers.toUtf8Bytes(`shiba-wallet check-key-import ${text}`));
const KEY_A = label('disposable key A');
const KEY_B = label('disposable key B');
const KEY_C = label('disposable key C');
const ADDR_A = new ethers.Wallet(KEY_A).address;
const ADDR_B = new ethers.Wallet(KEY_B).address;
const ADDR_C = new ethers.Wallet(KEY_C).address;
const PHRASE_ACCOUNT_0 = ethers.HDNodeWallet.fromPhrase(TEST_MNEMONIC);
const N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
const hex32 = (v) => '0x' + v.toString(16).padStart(64, '0');

// ---------------------------------------------------------------------------
// Fake expo-secure-store (the check-storage.mjs model)
// ---------------------------------------------------------------------------
const ANDROID_CANCEL = 'Could not Authenticate the user: User canceled the authentication. Cancel';
const IOS_CANCEL = 'User canceled the operation.';
const IOS_EXPO_GO =
  'You must set `NSFaceIDUsageDescription` in your Info.plist file to use the `requireAuthentication` option';

function makeShim({ platform = 'android', canBio = true, expoGo = false } = {}) {
  const items = new Map();
  const shim = {
    platform,
    canBio,
    expoGo,
    epoch: 0,
    prompts: [],
    responses: [],
    rules: [],
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
    },
    async getItemAsync(key, opts) {
      const r = shim.rule('get', key);
      if (r?.error) throw new Error(r.error);
      const rec = items.get(shim.id(key, opts));
      if (!rec) return null;
      if (rec.auth) {
        if (rec.epoch < shim.epoch) return null;
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
      items.set(id, { value: r?.corrupt ? `${value}00` : value, auth: !!opts?.requireAuthentication, epoch: shim.epoch });
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
    std(slot) {
      return shim.has(IMPORTED_KEY_PREFIX + slot);
    },
    prot(slot) {
      return shim.has(PROTECTED_IMPORTED_KEY_PREFIX + slot, PROTECTED_KEYCHAIN_SERVICE);
    },
    meta() {
      return items.get(`default|${IMPORTED_KEYS_META_KEY}`)?.value ?? null;
    },
    take() {
      const p = shim.prompts;
      shim.prompts = [];
      return p;
    },
  };
  return shim;
}

/** A vault with the phrase stored (standard) and, optionally, protected. */
async function freshVault({ platform = 'android', protect = false, canBio = true, expoGo = false, policy } = {}) {
  const shim = makeShim({ platform, canBio, expoGo });
  const vault = createKeyVault(shim, policy ? { policy } : {});
  await vault.saveNewPhrase(PHRASE);
  if (protect) await vault.upgrade();
  shim.take();
  return { shim, vault };
}
const canon = (k) => k.toLowerCase();

// ===========================================================================
console.log('check-key-import: validation with engine code, cross-checked against ethers');
// ===========================================================================
{
  for (const [name, input, expectHex] of [
    ['label key A with 0x', KEY_A, canon(KEY_A)],
    ['label key A without 0x', KEY_A.slice(2), canon(KEY_A)],
    ['upper-case hex and 0X prefix', '0X' + KEY_B.slice(2).toUpperCase(), canon(KEY_B)],
    ['surrounding whitespace and newline from a paste', `  \n${KEY_C}\n `, canon(KEY_C)],
    ['the smallest key, 1', hex32(1n), hex32(1n)],
    ['the largest key, n - 1', hex32(N - 1n), hex32(N - 1n)],
    ['the phrase account 0 key (ethers HDNodeWallet)', PHRASE_ACCOUNT_0.privateKey, canon(PHRASE_ACCOUNT_0.privateKey)],
  ]) {
    const r = parsePrivateKeyInput(input);
    const ref = r.ok ? new ethers.Wallet(r.hex).address : null;
    check(`accepted: ${name}; canonical hex and address equal ethers.Wallet`, r.ok && r.hex === expectHex && r.address === ref, JSON.stringify(r.ok ? r.address : r.error));
  }
  const refusals = [
    ['empty', '', KEY_EMPTY_ERROR],
    ['spaces only', '   ', KEY_EMPTY_ERROR],
    ['zero', hex32(0n), KEY_ZERO_ERROR],
    ['n (the curve order)', hex32(N), KEY_OUT_OF_RANGE_ERROR],
    ['n + 1', hex32(N + 1n), KEY_OUT_OF_RANGE_ERROR],
    ['2^256 - 1', '0x' + 'f'.repeat(64), KEY_OUT_OF_RANGE_ERROR],
    ['63 characters', KEY_A.slice(0, 65), keyLengthError(63)],
    ['65 characters', KEY_A + 'a', keyLengthError(65)],
    ['0x alone', '0x', keyLengthError(0)],
    ['non-hex character', KEY_A.slice(0, 65) + 'g', KEY_NOT_HEX_ERROR],
    ['an Ethereum address', ADDR_A, KEY_ADDRESS_INSTEAD_ERROR],
    ['a recovery phrase', TEST_MNEMONIC, KEY_LOOKS_LIKE_PHRASE_ERROR],
    ['inner whitespace', KEY_A.slice(0, 30) + ' ' + KEY_A.slice(30), KEY_NOT_HEX_ERROR],
  ];
  for (const [name, input, error] of refusals) {
    const r = parsePrivateKeyInput(input);
    check(`refused: ${name}`, !r.ok && r.error === error, JSON.stringify(r));
  }
  // ethers agrees on the range boundaries (an independent implementation).
  check('ethers also refuses 0 and n, and accepts n - 1 (boundary agreement)',
    (() => { try { new ethers.Wallet(hex32(0n)); return false; } catch { return true; } })() &&
      (() => { try { new ethers.Wallet(hex32(N)); return false; } catch { return true; } })() &&
      new ethers.Wallet(hex32(N - 1n)).address === parsePrivateKeyInput(hex32(N - 1n)).address);
  check('the length error states the count in a full sentence', keyLengthError(63).endsWith('This one has 63.'));
}

// ===========================================================================
console.log('check-key-import: duplicates are refused with a plain sentence');
// ===========================================================================
{
  const accounts = [
    { name: 'Account 1', imported: false, evmAddress: PHRASE_ACCOUNT_0.address },
    { name: 'Account 2', imported: false, evmAddress: null },
    { name: `Imported 1${IMPORTED_NAME_SUFFIX}`, imported: true, evmAddress: ADDR_A },
  ];
  const phraseDup = duplicateImportError(PHRASE_ACCOUNT_0.address.toLowerCase(), accounts);
  check('a key of a listed phrase account: "already comes from your recovery phrase … already in this wallet"',
    phraseDup === `This key belongs to Account 1 (${PHRASE_ACCOUNT_0.address}), which already comes from your recovery phrase. It is already in this wallet, so it was not imported.`, phraseDup);
  const importDup = duplicateImportError(ADDR_A, accounts);
  check('an earlier import: "already imported as Imported 1 (imported key)"',
    importDup === `This key is already imported as Imported 1 (imported key) (${ADDR_A}). It was not imported again.`, importDup);
  check('a new key is accepted', duplicateImportError(ADDR_B, accounts) === null);
}

// ===========================================================================
console.log('check-key-import: vault — standard storage (phrase not protected)');
// ===========================================================================
{
  const { shim, vault } = await freshVault();
  const r = await vault.importedKeys.save(canon(KEY_A), ADDR_A.toLowerCase());
  check('saved in slot 0, standard, address computed by the vault (EIP-55)', r.info.slot === 0 && r.info.location === 'standard' && r.info.address === ADDR_A && r.protectionDetail === null);
  check('standard entry written, no protected entry, no prompt', shim.std(0) && !shim.prot(0) && shim.take().length === 0);
  const meta = shim.meta();
  check('the public record holds the address and NO key material', meta.includes(ADDR_A) && !meta.toLowerCase().includes(canon(KEY_A).slice(2)));
  check('the record parses strictly', parseImportedKeysMeta(meta)?.keys?.length === 1);
  check('reading it needs no prompt and returns the key', (await vault.importedKeys.read(0, 'x')) === canon(KEY_A) && shim.take().length === 0);
  check('list() needs no prompt (launch draws imported accounts without one)', (await vault.importedKeys.list()).keys[0].address === ADDR_A && shim.take().length === 0);
  check('no public-account cache entry was written for it', ![...shim.items.keys()].some((k) => k.includes(PUBLIC_ACCOUNT_KEY_PREFIX)));
  check('the phrase entry is untouched', shim.has(MNEMONIC_KEY));
  await checkRejects('a key whose address differs from the one shown is refused', () => vault.importedKeys.save(canon(KEY_B), ADDR_A), 'does not match the address');
  await checkRejects('the same key again is refused', () => vault.importedKeys.save(canon(KEY_A), ADDR_A), 'already imported');
  await checkRejects('non-canonical hex is refused by the vault (it stores only 0x + lowercase)', () => vault.importedKeys.save(KEY_B.toUpperCase().replace('0X', '0x'), ADDR_B));
  await checkRejects('zero is refused by the vault too', () => vault.importedKeys.save(hex32(0n), '0x' + '00'.repeat(20)));
  const st = await vault.status();
  check('status: 1 imported key, standard', st.importedKeys.total === 1 && st.importedKeys.standard === 1 && !st.importedKeys.damaged);
  const view = describeProtectionStatus(st);
  check('Settings note: the key is in standard storage too and moves with the phrase',
    view.importedNote === 'Your imported private key is in standard secure storage too; protecting the phrase moves it too. The recovery phrase does not back up imported keys.', view.importedNote);
  check('protect confirm message names the imported key and the backup gap (singular wording for one key)',
    protectConfirmMessage(st).startsWith(PROTECT_CONFIRM_MESSAGE) && /Your imported private key in standard storage moves too \(it asks/.test(protectConfirmMessage(st)) && /recovery phrase cannot restore it: keep a copy of the private key\./.test(protectConfirmMessage(st)), protectConfirmMessage(st));
  // Cap.
  const cap = await freshVault();
  for (let i = 0; i < MAX_IMPORTED_KEYS; i++) {
    const k = label(`cap ${i}`);
    await cap.vault.importedKeys.save(canon(k), new ethers.Wallet(k).address);
  }
  const k11 = label('cap 11');
  await checkRejects(`more than ${MAX_IMPORTED_KEYS} imported keys are refused`, () => cap.vault.importedKeys.save(canon(k11), new ethers.Wallet(k11).address), `maximum of ${MAX_IMPORTED_KEYS}`);
}

// ===========================================================================
console.log('check-key-import: vault — a new key follows the PROTECTED phrase');
// ===========================================================================
{
  const { shim, vault } = await freshVault({ protect: true });
  const r = await vault.importedKeys.save(canon(KEY_A), ADDR_A);
  check('Android: protected write + read-back, two prompts', r.info.location === 'protected' && JSON.stringify(shim.take()) === JSON.stringify([PROMPTS.importedKeyWrite, PROMPTS.importedKeyCheck]));
  check('protected entry only, under the protected service', shim.prot(0) && !shim.std(0));
  check('reading it prompts once', (await vault.importedKeys.read(0, PROMPTS.importedKeySign)) === canon(KEY_A) && JSON.stringify(shim.take()) === JSON.stringify([PROMPTS.importedKeySign]));
  check('list() still needs no prompt', (await vault.importedKeys.list()).keys.length === 1 && shim.take().length === 0);
  const st = await vault.status();
  check('status: protected, nothing left to move', st.importedKeys.protected === 1 && st.importedKeys.standard === 0 && st.canProtectNow === false);
  check('Settings note: protected too (finding 8: reads naturally for one key)', describeProtectionStatus(st).importedNote === 'Your imported private key is protected by biometrics too. The recovery phrase does not back up imported keys.', describeProtectionStatus(st).importedNote);

  const ios = await freshVault({ platform: 'ios', protect: true });
  await ios.vault.importedKeys.save(canon(KEY_A), ADDR_A);
  check('iOS: creation does not prompt, the read-back does (one prompt)', JSON.stringify(ios.shim.take()) === JSON.stringify([PROMPTS.importedKeyCheck]) && ios.shim.prot(0));

  const c = await freshVault({ protect: true });
  c.shim.responses.push('cancel');
  await checkRejects('a cancelled protection prompt cancels the import', () => c.vault.importedKeys.save(canon(KEY_A), ADDR_A), 'Authentication cancelled. The key was not imported.');
  check('…nothing is stored, the slot is not reused later', !c.shim.prot(0) && !c.shim.std(0) && (await c.vault.importedKeys.list()).keys.length === 0 && parseImportedKeysMeta(c.shim.meta()).nextSlot === 1);
  const again = await c.vault.importedKeys.save(canon(KEY_A), ADDR_A);
  check('…a later import takes slot 1', again.info.slot === 1);

  const c2 = await freshVault({ protect: true });
  c2.shim.responses.push('ok', 'cancel');
  await checkRejects('a cancelled read-back also cancels the import', () => c2.vault.importedKeys.save(canon(KEY_A), ADDR_A), 'not imported');
  check('…and leaves no protected copy behind', !c2.shim.prot(0) && !c2.shim.std(0));

  for (const [name, rule] of [
    ['the platform refuses the protected write', { op: 'set', key: PROTECTED_IMPORTED_KEY_PREFIX + '0', error: 'KeyStoreException: refused' }],
    ['the read-back throws', { op: 'get', key: PROTECTED_IMPORTED_KEY_PREFIX + '0', error: 'Keystore read failed' }],
    ['the read-back differs (corrupt write)', { op: 'set', key: PROTECTED_IMPORTED_KEY_PREFIX + '0', corrupt: true }],
  ]) {
    const f = await freshVault({ protect: true });
    f.shim.rules.push(rule);
    const res = await f.vault.importedKeys.save(canon(KEY_A), ADDR_A);
    check(`${name}: falls back to standard storage with the platform's words`, res.info.location === 'standard' && typeof res.protectionDetail === 'string' && res.protectionDetail.length > 0 && f.shim.std(0) && !f.shim.prot(0), JSON.stringify(res));
    check(`${name}: the key stays readable`, (await f.vault.importedKeys.read(0, 'x')) === canon(KEY_A));
  }
  const goIos = await freshVault({ platform: 'ios', protect: false });
  // Expo Go on iOS: the phrase could never be protected, so a key is standard without trying.
  await goIos.vault.importedKeys.save(canon(KEY_A), ADDR_A);
  check('Expo Go on iOS (phrase standard): the key is standard and nothing prompts', goIos.shim.std(0) && goIos.shim.take().length === 0);
  const noBio = await freshVault({ protect: true });
  noBio.shim.canBio = false;
  const nb = await noBio.vault.importedKeys.save(canon(KEY_A), ADDR_A);
  check('phrase protected but biometrics now unavailable: standard, with an explanation', nb.info.location === 'standard' && /cannot hold biometric-protected items/.test(nb.protectionDetail ?? ''));
}

// ===========================================================================
console.log('check-key-import: vault — protecting the phrase later moves the imported keys');
// ===========================================================================
{
  const { shim, vault } = await freshVault();
  await vault.importedKeys.save(canon(KEY_A), ADDR_A);
  await vault.importedKeys.save(canon(KEY_B), ADDR_B);
  shim.take();
  const res = await vault.upgrade();
  const prompts = shim.take();
  check('one explicit upgrade: phrase protected and both keys moved', res.outcome === 'protected' && res.importedKeys?.moved === 2 && res.importedKeys?.remaining === 0, JSON.stringify(res));
  check('Android prompts: phrase write + check, then write + check per key (6)', prompts.length === 6 && prompts.filter((p) => p === PROMPTS.importedKeyWrite).length === 2, JSON.stringify(prompts));
  check('standard copies deleted only after the protected copies were confirmed', !shim.std(0) && !shim.std(1) && shim.prot(0) && shim.prot(1));
  check('records say protected', (await vault.importedKeys.list()).keys.every((k) => k.location === 'protected' && k.protectedSince !== null));
  check('both keys read back correctly', (await vault.importedKeys.read(0, 'x')) === canon(KEY_A) && (await vault.importedKeys.read(1, 'x')) === canon(KEY_B));
  check('outcome alert mentions the moved keys', describeUpgradeOutcome(res).message.includes('2 imported private keys also moved into biometric protection.'));

  // Cancelled at the second key: the first is protected, the second stays standard; Settings says so.
  const p = await freshVault();
  await p.vault.importedKeys.save(canon(KEY_A), ADDR_A);
  await p.vault.importedKeys.save(canon(KEY_B), ADDR_B);
  p.shim.take();
  p.shim.responses.push('ok', 'ok', 'ok', 'ok', 'cancel');
  const partial = await p.vault.upgrade();
  check('cancelled at the second key: phrase + first key protected, one remaining', partial.outcome === 'protected' && partial.importedKeys?.moved === 1 && partial.importedKeys?.remaining === 1 && partial.importedKeys?.cancelled === true, JSON.stringify(partial));
  check('the second key is still standard and readable', p.shim.std(1) && !p.shim.prot(1) && (await p.vault.importedKeys.read(1, 'x')) === canon(KEY_B));
  const st = await p.vault.status();
  check('status: phrase protected, 1 key still standard, the button is offered again', st.phrase === 'protected' && st.importedKeys.standard === 1 && st.canProtectNow === true);
  const view = describeProtectionStatus(st);
  check('Settings says precisely what remains unprotected',
    view.showProtectButton === true && view.importedNote === 'One of your imported private keys is still in standard secure storage, readable by code inside the app while the phone is unlocked. Protect with biometrics moves it too. The recovery phrase does not back up imported keys.', view.importedNote);
  check('the outcome alert says how many remain and why', describeUpgradeOutcome(partial).message.includes('1 imported private key is still in standard secure storage because the prompt was cancelled'));
  const rest = await p.vault.upgrade();
  check('pressing Protect again moves the remaining key (no phrase prompt needed)', rest.outcome === 'already-protected' && rest.importedKeys?.moved === 1 && rest.importedKeys?.remaining === 0);
  check('…titled "Imported keys protected"', describeUpgradeOutcome(rest).title === 'Imported keys protected');

  // Failure injected at every step of one key's move: the key stays readable.
  for (const [name, rule] of [
    ['protected write refused', { op: 'set', key: PROTECTED_IMPORTED_KEY_PREFIX + '0', error: 'refused' }],
    ['read-back throws', { op: 'get', key: PROTECTED_IMPORTED_KEY_PREFIX + '0', error: 'read failed' }],
    ['read-back differs', { op: 'set', key: PROTECTED_IMPORTED_KEY_PREFIX + '0', corrupt: true }],
    ['record update fails', { op: 'set', key: IMPORTED_KEYS_META_KEY, error: 'meta write failed' }],
  ]) {
    const f = await freshVault({ protect: true });
    await f.vault.importedKeys.save(canon(KEY_A), ADDR_A);
    // It was protected at save; force it standard to exercise the move.
    const m = parseImportedKeysMeta(f.shim.meta());
    m.keys[0].location = 'standard';
    m.keys[0].protectedSince = null;
    f.shim.items.set(`default|${IMPORTED_KEYS_META_KEY}`, { value: JSON.stringify(m), auth: false, epoch: 0 });
    f.shim.items.delete(`${PROTECTED_KEYCHAIN_SERVICE}|${PROTECTED_IMPORTED_KEY_PREFIX}0`);
    f.shim.items.set(`default|${IMPORTED_KEY_PREFIX}0`, { value: canon(KEY_A), auth: false, epoch: 0 });
    f.shim.take();
    f.shim.rules.push(rule);
    const out = await f.vault.upgrade();
    check(`move fails at "${name}": reported, nothing lost`, out.importedKeys?.moved === 0 && out.importedKeys?.remaining === 1 && f.shim.std(0) && !f.shim.prot(0) && (await f.vault.importedKeys.read(0, 'x')) === canon(KEY_A), JSON.stringify(out.importedKeys));
  }

  // The automatic phrase move at an approval does not move imported keys.
  const auto = await freshVault({ policy: 'automatic' });
  await auto.vault.importedKeys.save(canon(KEY_A), ADDR_A);
  const gate = await auto.vault.openPhraseForApproval('Approve');
  const autoSt = await auto.vault.status();
  check('policy automatic: the approval moves the phrase but leaves the imported key (no surprise prompts)', gate.kind === 'authenticated' && autoSt.phrase === 'protected' && autoSt.importedKeys.standard === 1 && auto.shim.std(0));

  // Interrupted move: a standard copy left next to the protected one is removed on the next protected read.
  const i = await freshVault({ protect: true });
  await i.vault.importedKeys.save(canon(KEY_A), ADDR_A);
  i.shim.items.set(`default|${IMPORTED_KEY_PREFIX}0`, { value: canon(KEY_A), auth: false, epoch: 0 });
  await i.vault.importedKeys.read(0, 'x');
  check('an identical leftover standard copy is deleted after a protected read', !i.shim.std(0) && i.shim.prot(0));
  const d = await freshVault({ protect: true });
  await d.vault.importedKeys.save(canon(KEY_A), ADDR_A);
  d.shim.items.set(`default|${IMPORTED_KEY_PREFIX}0`, { value: canon(KEY_B), auth: false, epoch: 0 });
  await d.vault.importedKeys.read(0, 'x');
  check('a DIFFERENT leftover standard copy is never deleted', d.shim.std(0));
}

// ===========================================================================
console.log('check-key-import: vault — invalidation, damage, removal and wipe');
// ===========================================================================
{
  const { shim, vault } = await freshVault({ protect: true });
  await vault.importedKeys.save(canon(KEY_A), ADDR_A);
  shim.epoch += 1; // a fingerprint was added
  const e = await rejects(() => vault.importedKeys.read(0, 'x'));
  check('after a biometric change the key is unreadable, with the plain message', e?.name === 'ImportedKeyAccessError' && e.reason === 'unreadable' && e.message === IMPORTED_KEY_UNREADABLE_MESSAGE);
  check('…the message says the recovery phrase cannot restore it', /Your recovery phrase cannot restore this account/.test(IMPORTED_KEY_UNREADABLE_MESSAGE));
  const st = await vault.status();
  check('…status counts it as unreadable and the record is kept (never deleted silently)', st.importedKeys.unreadable === 1 && (await vault.importedKeys.list()).keys.length === 1);
  check('…Settings names it', /Your imported private key can no longer be opened on this phone after a biometric change; your recovery phrase cannot restore it, only a copy you kept yourself can\./.test(importedKeysProtectionNote(st) ?? ''), importedKeysProtectionNote(st));

  const m = await freshVault();
  await m.vault.importedKeys.save(canon(KEY_A), ADDR_A);
  m.shim.items.delete(`default|${IMPORTED_KEY_PREFIX}0`);
  const missing = await rejects(() => m.vault.importedKeys.read(0, 'x'));
  check('a record whose key entry is gone reads as missing (plain message)', missing?.reason === 'missing' && missing.message === IMPORTED_KEY_MISSING_MESSAGE);

  const dmg = await freshVault();
  await dmg.vault.importedKeys.save(canon(KEY_A), ADDR_A);
  dmg.shim.items.set(`default|${IMPORTED_KEYS_META_KEY}`, { value: '{not json', auth: false, epoch: 0 });
  const listed = await dmg.vault.importedKeys.list();
  check('a damaged record lists as damaged, never as "no keys"', listed.damaged === true && listed.keys.length === 0);
  await checkRejects('a damaged record refuses a new import', () => dmg.vault.importedKeys.save(canon(KEY_B), ADDR_B), IMPORTED_KEYS_DAMAGED_MESSAGE);
  await checkRejects('a damaged record refuses a removal', () => dmg.vault.importedKeys.remove(0), IMPORTED_KEYS_DAMAGED_MESSAGE);
  check('…and the existing key entry was not touched', dmg.shim.std(0));
  check('status reports the damage', (await dmg.vault.status()).importedKeys.damaged === true && /could not be read/.test(importedKeysProtectionNote(await dmg.vault.status()) ?? ''));
  await dmg.vault.importedKeys.removeAll();
  check('wipe with a damaged record still sweeps the key entries and the record', !dmg.shim.std(0) && dmg.shim.meta() === null);

  const r = await freshVault({ protect: true });
  await r.vault.importedKeys.save(canon(KEY_A), ADDR_A);
  await r.vault.importedKeys.save(canon(KEY_B), ADDR_B);
  r.shim.take();
  await r.vault.importedKeys.remove(0);
  check('remove: both copies and the record entry are deleted, without a prompt', !r.shim.prot(0) && !r.shim.std(0) && (await r.vault.importedKeys.list()).keys.map((k) => k.slot).join() === '1' && r.shim.take().length === 0);
  check('…the other key is untouched', (await r.vault.importedKeys.read(1, 'x')) === canon(KEY_B));
  const next = await r.vault.importedKeys.save(canon(KEY_A), ADDR_A);
  check('…slots are never reused (re-import takes slot 2)', next.info.slot === 2);
  await r.vault.importedKeys.removeAll();
  check('wipe deletes every imported key and the record; the phrase is a separate step', !r.shim.prot(1) && !r.shim.prot(2) && r.shim.meta() === null && r.shim.has(PROTECTED_MNEMONIC_KEY, PROTECTED_KEYCHAIN_SERVICE));
}

// ===========================================================================
console.log('check-key-import: the approval gate opens the active account\'s secret (one prompt)');
// ===========================================================================
{
  const { shim, vault } = await freshVault({ protect: true });
  await vault.importedKeys.save(canon(KEY_A), ADDR_A);
  shim.take();
  vault.setApprovalTarget({ kind: 'imported', slot: 0 });
  const gate = await vault.openPhraseForApproval('Approve sending 1 test ETH');
  check('imported target, protected key: one system prompt, authenticated', gate.kind === 'authenticated' && JSON.stringify(shim.take()) === JSON.stringify(['Approve sending 1 test ETH']));
  check('the signing read uses the held key without a second prompt', (await vault.importedKeys.read(0, PROMPTS.importedKeySign)) === canon(KEY_A) && shim.take().length === 0);
  check('the hold is single use (the next read prompts)', (await vault.importedKeys.read(0, 'again')) === canon(KEY_A) && shim.take().length === 1);
  await vault.openPhraseForApproval('Approve');
  shim.take();
  check('a held imported key is never handed to a phrase read', (await vault.readPhrase('Phrase')) === PHRASE && JSON.stringify(shim.take()) === JSON.stringify(['Phrase']));
  check('…and that read consumed the hold (the key prompts again)', (await vault.importedKeys.read(0, 'k')) === canon(KEY_A) && shim.take().length === 1);
  await vault.openPhraseForApproval('Approve');
  vault.setApprovalTarget({ kind: 'phrase' });
  shim.take();
  check('switching the target drops a held key', (await vault.importedKeys.read(0, 'k')) === canon(KEY_A) && shim.take().length === 1);
  const explicit = await vault.openPhraseForApproval('Reveal recovery phrase', { kind: 'phrase' });
  check('an explicit phrase target opens the phrase (Settings reveal while an imported account is active)', explicit.kind === 'authenticated' && (await vault.readPhrase('x')) === PHRASE);
  vault.setApprovalTarget({ kind: 'imported', slot: 0 });
  shim.responses.push('cancel');
  check('a cancelled prompt cancels the approval', (await vault.openPhraseForApproval('Approve')).kind === 'cancelled');
  const std = await freshVault();
  await std.vault.importedKeys.save(canon(KEY_A), ADDR_A);
  std.vault.setApprovalTarget({ kind: 'imported', slot: 0 });
  check('a standard imported key falls back to the app-level prompt (no system prompt)', (await std.vault.openPhraseForApproval('Approve')).kind === 'fallback' && std.shim.take().length === 0);
  std.vault.setApprovalTarget({ kind: 'imported', slot: 7 });
  check('a missing key falls back too (the signing call then explains)', (await std.vault.openPhraseForApproval('Approve')).kind === 'fallback');

  // Phase 14 integration: a watch-only account's target opens NOTHING (no
  // secure-store read, no system prompt), so the caller's ordinary device
  // prompt is the check; the phrase and imported targets are unchanged.
  {
    const w = await freshVault({ protect: true });
    let gets = 0;
    const realGet = w.shim.getItemAsync.bind(w.shim);
    w.shim.getItemAsync = async (key, opts) => { gets += 1; return realGet(key, opts); };
    await w.vault.openPhraseForApproval('Approve');
    w.shim.take();
    w.vault.setApprovalTarget({ kind: 'none' });
    gets = 0;
    const none = await w.vault.openPhraseForApproval('Unlock Shiba Wallet');
    check('watch-only target: fallback with no prompt and ZERO secure-store reads', none.kind === 'fallback' && none.detail === null && w.shim.take().length === 0 && gets === 0, `${none.kind} ${gets}`);
    check('…and the phrase held for the previous target was dropped (the next phrase read prompts)', (await w.vault.readPhrase('Phrase')) === PHRASE && w.shim.take().length === 1);
    const explicitPhrase = await w.vault.openPhraseForApproval('Reveal recovery phrase', { kind: 'phrase' });
    check('an explicit phrase target still opens the phrase while a watch-only account is active', explicitPhrase.kind === 'authenticated' && JSON.stringify(w.shim.take()) === JSON.stringify(['Reveal recovery phrase']));
    w.vault.setApprovalTarget({ kind: 'phrase' });
    check('back on a phrase account: one system prompt, authenticated (unchanged)', (await w.vault.openPhraseForApproval('Approve')).kind === 'authenticated' && w.shim.take().length === 1);
    // Mutation: without the 'none' early return the gate would open the phrase.
    const storageSrc = readFileSync(new URL('../src/wallet/storage.ts', import.meta.url), 'utf8');
    const anchor = "        if (gateTarget.kind === 'none') return { kind: 'fallback', detail: null };\n";
    check('mutation anchor present (watch-only target)', storageSrc.includes(anchor));
    const mutant = await importAppMutant('src/wallet/storage.ts', storageSrc.replace(anchor, ''));
    const mShim = makeShim({ platform: 'android' });
    const mVault = mutant.createKeyVault(mShim, {});
    await mVault.saveNewPhrase(PHRASE);
    await mVault.upgrade();
    mShim.take();
    mVault.setApprovalTarget({ kind: 'none' });
    const mGate = await mVault.openPhraseForApproval('Unlock Shiba Wallet');
    check('M-none caught: without the early return a watch-only target opens the protected phrase (system prompt)',
      mGate.kind === 'authenticated' && mShim.take().length === 1, mGate.kind);
  }
}

// ===========================================================================
console.log('check-key-import: account store and the fail-closed id range');
// ===========================================================================
{
  const store = memoryStore();
  const { account } = await addImportedAccountEntry(0, null, store);
  check('imported entry: id 2^31 + slot, "Imported 1", flagged, never hidden', account.index === IMPORTED_ACCOUNT_ID_BASE && account.name === 'Imported 1' && account.imported === true && account.hidden === false);
  const added = await addAccount(null, store);
  check('adding a phrase account still takes derivation index 1 (imported ids never move nextIndex)', added.account.index === 1 && !('imported' in added.account));
  const raw = JSON.parse(store._map.get('shiba-wallet.accounts.v1'));
  check('phrase entries keep their exact serialized shape (no new field)', JSON.stringify(raw.accounts.find((a) => a.index === 1)) === JSON.stringify({ index: 1, name: 'Account 2', hidden: false }));
  await checkRejects('an imported account cannot be hidden', () => hideAccount(IMPORTED_ACCOUNT_ID_BASE, store), IMPORTED_HIDE_REFUSAL);
  await setActiveAccount(IMPORTED_ACCOUNT_ID_BASE, store);
  check('an imported account can be the active account (and survives a reload)', (await loadAccounts(store)).activeIndex === IMPORTED_ACCOUNT_ID_BASE);
  await checkRejects('the active imported account cannot be removed', () => removeImportedAccountEntry(IMPORTED_ACCOUNT_ID_BASE, store), 'Switch to another account first');
  await setActiveAccount(0, store);
  await checkRejects('only imported accounts are removed this way', () => removeImportedAccountEntry(1, store), 'Only an imported account');
  const afterRemove = await removeImportedAccountEntry(IMPORTED_ACCOUNT_ID_BASE, store);
  check('removal drops the entry', !afterRemove.accounts.some((a) => a.index === IMPORTED_ACCOUNT_ID_BASE));

  const tampered = memoryStore();
  await tampered.setItem('shiba-wallet.accounts.v1', JSON.stringify({
    version: 1,
    accounts: [
      { index: 0, name: 'Account 1', hidden: false },
      { index: IMPORTED_ACCOUNT_ID_BASE + 3, name: 'Imported 4', hidden: true, imported: true },
      { index: IMPORTED_ACCOUNT_ID_BASE + 5, name: 'No flag', hidden: false },
      { index: 7, name: 'Fake import', hidden: false, imported: true },
    ],
    activeIndex: IMPORTED_ACCOUNT_ID_BASE + 3,
    nextIndex: 1,
  }));
  const t = await loadAccounts(tampered);
  check('stored imported entry kept, forced visible, active kept', t.accounts.some((a) => a.index === IMPORTED_ACCOUNT_ID_BASE + 3 && a.imported && !a.hidden) && t.activeIndex === IMPORTED_ACCOUNT_ID_BASE + 3);
  check('an id in the imported range WITHOUT the flag is dropped', !t.accounts.some((a) => a.index === IMPORTED_ACCOUNT_ID_BASE + 5));
  check('a flag on a derivation index is dropped (never treated as imported)', !t.accounts.some((a) => a.index === 7));
  check('nextIndex comes from the phrase accounts only', t.nextIndex === 1);

  const base = { accounts: [{ index: 0, name: 'Account 1', hidden: false }, { index: IMPORTED_ACCOUNT_ID_BASE + 1, name: 'Old', hidden: false, imported: true }], activeIndex: IMPORTED_ACCOUNT_ID_BASE + 1, nextIndex: 1 };
  const rec = reconcileImportedAccounts(base, [0]);
  check('reconcile: a vault key without an entry is listed; an entry without a key is dropped; active falls back to Account 1',
    rec.changed && rec.state.accounts.some((a) => a.index === IMPORTED_ACCOUNT_ID_BASE && a.name === 'Imported 1') && !rec.state.accounts.some((a) => a.index === IMPORTED_ACCOUNT_ID_BASE + 1) && rec.state.activeIndex === 0);
  check('reconcile with an unreadable vault record changes nothing', reconcileImportedAccounts(base, null).changed === false);

  for (const chainId of ['eip155:1', 'eip155:11155111', 'bip122:000000000019d6689c085ae165831e93', 'bip122:1a91e3dace36e2be3bf030a65679fe82', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp']) {
    const e = await rejects(() => derivationArgsFor(chainId, IMPORTED_ACCOUNT_ID_BASE));
    check(`derivationArgsFor refuses an imported id on ${chainId.split(':')[0]}${chainId.includes('1a91') ? ' (Dogecoin)' : ''} (fail closed)`, e instanceof Error && /Invalid account index/.test(e.message));
  }
  const seed = mnemonicToSeed(TEST_MNEMONIC);
  const e2 = await rejects(() => deriveForAccount(evmKeyProvider, seed, importedAccountId(2)));
  check('deriveForAccount never derives a phrase key for an imported id', e2 instanceof Error);
  check('Account 1 (index 0) still derives exactly m/44\'/60\'/0\'/0/0 = 0x9858…Da94 (unchanged)', deriveChainAccounts(seed, 0)[0].address === PHRASE_ACCOUNT_0.address && deriveChainAccounts(seed, 0)[0].path === "m/44'/60'/0'/0/0");
  seed.fill(0);
  check('smartAccountSaltFor: phrase index N → N, imported → 0', smartAccountSaltFor(0) === 0 && smartAccountSaltFor(5) === 5 && smartAccountSaltFor(importedAccountId(3)) === 0);
  check('smartAccountSaltFor refuses an id in neither range', (() => { try { smartAccountSaltFor(-1); return false; } catch { return true; } })() && (() => { try { smartAccountSaltFor(IMPORTED_ACCOUNT_ID_BASE + 0x100000); return false; } catch { return true; } })());
  check('isImportedAccountId / importedSlotOf round-trip', isImportedAccountId(importedAccountId(9)) && importedSlotOf(importedAccountId(9)) === 9 && !isImportedAccountId(0) && !isImportedAccountId(MAX_ACCOUNTS));
  check('IMPORTED_KEY_PATH is not a BIP-32 path (every path recorder skips it)', !isBip32Path(IMPORTED_KEY_PATH) && isBip32Path("m/44'/60'/0'/0/3"));
}

// ===========================================================================
console.log('check-key-import: signing selection (the signWith half) and refusals');
// ===========================================================================
{
  const { vault } = await freshVault({ protect: true });
  await vault.importedKeys.save(canon(KEY_A), ADDR_A);
  const hex = await vault.importedKeys.read(0, PROMPTS.importedKeySign);
  const bytes = importedKeyBytes(hex);
  const signer = importedSignerFor(evmKeyProvider, bytes, ADDR_A.toLowerCase());
  check('the imported signer controls the imported address, path is the non-BIP-32 marker', signer.address === ADDR_A && signer.path === IMPORTED_KEY_PATH && signer.chainId === 'eip155:1');
  const digest = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes('digest')));
  const sig = signer.sign(digest);
  check('its signature recovers to the imported address (ethers)', ethers.recoverAddress(digest, ethers.Signature.from({ r: ethers.hexlify(sig.slice(0, 32)), s: ethers.hexlify(sig.slice(32, 64)), v: sig[64] + 27 })) === ADDR_A);
  check('a non-EVM chain is refused before any key is used', (() => { try { importedSignerFor(bitcoinKeyProvider, bytes, ADDR_A); return false; } catch (e) { return e.message === IMPORTED_KEY_EVM_ONLY; } })() &&
    (() => { try { importedSignerFor(solanaKeyProvider, bytes, ADDR_A); return false; } catch (e) { return e.message === IMPORTED_KEY_EVM_ONLY; } })());
  check('a different prepared address is refused (account changed), nothing signed', (() => { try { importedSignerFor(evmKeyProvider, bytes, ADDR_B); return false; } catch (e) { return e.message === ACCOUNT_CHANGED_MESSAGE; } })());
  bytes.fill(0);
  check('importedKeyBytes refuses anything but the vault\'s canonical form', (() => { try { importedKeyBytes(KEY_A.toUpperCase()); return false; } catch { return true; } })());

  const ctx = src('wallet/WalletContext.tsx');
  const sw = ctx.slice(ctx.indexOf('const signWith = useCallback('), ctx.indexOf('const wipe = useCallback('));
  check('signWith: the imported branch reads ONLY through the vault and the engine signer, and zeroes the key bytes',
    /if \(isImportedAccountId\(index\)\)/.test(sw) && /importedKeyVault\.read\(importedSlotOf\(index\), PROMPTS\.importedKeySign\)/.test(sw) &&
      /importedSignerFor\(chain\.provider, keyBytes, expectAddress\)/.test(sw) && /finally \{\s*keyBytes\.fill\(0\);/.test(sw));
  check('signWith: a non-EVM chain is refused before the imported key is read', sw.indexOf('throw new Error(IMPORTED_KEY_EVM_ONLY)') < sw.indexOf('importedKeyVault.read('));
  check('signWith: phrase accounts still go through readPhrase(PROMPTS.signFallback) and deriveSignerFor', /readPhrase\(PROMPTS\.signFallback\)/.test(sw) && /deriveSignerFor\(chain\.provider, seed, index, expectAddress\)/.test(sw));
  check('the approval target follows the active account (commitAccounts; nothing for a watch-only account)',
    /setApprovalTarget\(\s*isImportedAccountId\(active\)\s*\? \{ kind: 'imported', slot: importedSlotOf\(active\) \}\s*: isWatchOnlyAccountId\(active\)\s*\? \{ kind: 'none' \}\s*: \{ kind: 'phrase' \},?\s*\)/.test(ctx));
  const wipe = ctx.slice(ctx.indexOf('const wipe = useCallback('));
  check('wipe deletes imported keys FIRST, before the phrase', wipe.indexOf('await importedKeyVault.removeAll()') >= 0 && wipe.indexOf('await importedKeyVault.removeAll()') < wipe.indexOf('await deleteMnemonic()'));
  check('launch derives only phrase indices (imported ids never reach derivePublic)', /derivePublic\(mnemonic, derivedIndices\(state\)\)/.test(ctx) && /for \(const index of derivedIndices\(state\)\)/.test(ctx));
  check('import validates with the engine, refuses duplicates, then stores through the vault', /parsePrivateKeyInput\(input\)/.test(ctx) && /duplicateImportError\(parsed\.address, existing\)/.test(ctx) && /importedKeyVault\.save\(parsed\.hex, parsed\.address\)/.test(ctx));
  check('removing an imported account deletes the key before the entry', ctx.indexOf('await importedKeyVault.remove(slot);') < ctx.indexOf('removeImportedAccountEntry(index)'));
}

// ===========================================================================
console.log('check-key-import: a full EOA send signed by an imported key (decoded by ethers)');
// ===========================================================================
{
  const { vault } = await freshVault();
  await vault.importedKeys.save(canon(KEY_B), ADDR_B);
  const hex = await vault.importedKeys.read(0, PROMPTS.importedKeySign);
  const bytes = importedKeyBytes(hex);
  const signer = importedSignerFor(evmKeyProvider, bytes, ADDR_B);
  const quote = {
    kind: 'evm',
    to: PHRASE_ACCOUNT_0.address,
    amount: 12345n,
    balance: 10n ** 18n,
    nonce: 4n,
    chainId: 11155111n,
    gasLimit: 21000n,
    maxFeePerGas: 3_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    fee: 63_000_000_000_000n,
    total: 63_000_000_012_345n,
    simulation: { ok: true },
  };
  let raw = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const { id, method, params } = JSON.parse(init.body);
    if (method !== 'eth_sendRawTransaction') throw new Error(`unexpected ${method}`);
    raw = params[0];
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id, result: ethers.keccak256(raw) }) };
  };
  try {
    const result = await sendEvm('https://offline.fake/rpc', signer, quote, null);
    const tx = ethers.Transaction.from(raw);
    check('broadcast raw tx decodes (ethers): sender = the imported address', tx.from === ADDR_B, tx.from);
    check('…to, value, nonce, chain id, gas and fees are the quote\'s', same(tx.to, PHRASE_ACCOUNT_0.address) && tx.value === 12345n && tx.nonce === 4 && tx.chainId === 11155111n && tx.gasLimit === 21000n && tx.maxFeePerGas === 3_000_000_000n && tx.type === 2);
    check('…and the txid is the keccak of the signed bytes', result.txid === ethers.keccak256(raw));
  } finally {
    globalThis.fetch = realFetch;
    bytes.fill(0);
  }
}

// ===========================================================================
console.log('check-key-import: a Kernel v3.3 smart account owned by an imported key (salt 0)');
// ===========================================================================
const NODE_URL = 'https://node.fake';
const BUNDLER_URL = 'https://bundler.fake';
const kernelConfig = {
  chain: 'eip155:11155111',
  bundlerUrl: BUNDLER_URL,
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
const IMPORTED_ID = importedAccountId(0);
function kernelBundle(accountIndex, { node = fakeKernelNode({ chainIdHex: '0xaa36a7' }), bundler = fakeBundler() } = {}) {
  return {
    bundle: createAaClientFromConfig(kernelConfig, {
      nodeUrl: NODE_URL,
      chainId: 11155111n,
      accountIndex,
      transportFor: (url) => (url === NODE_URL ? node : bundler),
    }),
    node,
    bundler,
  };
}
const KERNEL_IMPORTED = predictKernelAddress(ADDR_A, { index: 0n });
{
  const { bundle, bundler } = kernelBundle(IMPORTED_ID);
  const sender = await resolveAaSender(bundle, ADDR_A);
  check('counterfactual = Kernel(owner = imported address, salt 0) (engine CREATE2, factory answer agrees)', sender === KERNEL_IMPORTED, sender);
  const { bundle: b1 } = kernelBundle(1);
  const seed = mnemonicToSeed(TEST_MNEMONIC);
  const owner1 = evmKeyProvider.deriveAccount(seed, 0, 1);
  seed.fill(0);
  check('a phrase account keeps salt = its index (account 2 → salt 1, unchanged)', (await resolveAaSender(b1, owner1.address)) === predictKernelAddress(owner1.address, { index: 1n }));

  const { vault } = await freshVault();
  await vault.importedKeys.save(canon(KEY_A), ADDR_A);
  const bytes = importedKeyBytes(await vault.importedKeys.read(0, PROMPTS.importedKeySign));
  const signer = importedSignerFor(evmKeyProvider, bytes, ADDR_A);
  const RECIPIENT = ethers.getAddress('0x' + 'aa'.repeat(20));
  const quote = await prepareAaSend(bundle, ADDR_A, RECIPIENT, 777n);
  check('quote sender is the imported key\'s Kernel account, will deploy', quote.sender === KERNEL_IMPORTED && quote.deployed === false);
  const { userOpHash } = await sendAa(bundle, signer, quote);
  const op = bundler.lastOp;
  check('sendAa returns the bundler userOpHash', userOpHash === USEROP_HASH);
  const deploy = new ethers.Interface(['function deployWithFactory(address factory, bytes createData, bytes32 salt)']).decodeFunctionData('deployWithFactory', op.factoryData);
  check('deployment: KernelFactory, salt 0, owner = the imported address (ethers decode)', same(deploy[0], KERNEL_V3_3.factory) && BigInt(deploy[2]) === 0n && deploy[1].toLowerCase().includes(ADDR_A.slice(2).toLowerCase()));
  const exec = decodeKernelExecute(op.callData);
  check('callData: the native transfer (ethers decode)', exec.calls.length === 1 && same(exec.calls[0].to, RECIPIENT) && exec.calls[0].value === 777n);
  const hash = getUserOpHash(fromRpcOp(op), ENTRYPOINT_V07, 11155111n);
  check('the op signature recovers to the IMPORTED key (ethers verifyMessage)', ethers.verifyMessage(hash, op.signature) === ADDR_A);
  bytes.fill(0);

  // The wallet's own-address lists include the imported account and its smart account.
  const facts = { accountType: 'kernel-v3.3', factory: KERNEL_V3_3.factory, factoryImplementation: KERNEL_V3_3.implementation, kernelValidator: KERNEL_V3_3.ecdsaValidator };
  check('activity decoding knows the imported smart account (walletAddressesFor, salt 0)', walletAddressesFor(ADDR_A, IMPORTED_ID, facts).includes(KERNEL_IMPORTED));
  const own = ownWalletAddresses([{ index: IMPORTED_ID, name: `Imported 1${IMPORTED_NAME_SUFFIX}`, evmAddress: ADDR_A }], facts);
  check('risk / contacts own-address list labels both as the imported account', own.length === 2 && own[0].label === 'Imported 1 (imported key)' && own[1].address === KERNEL_IMPORTED && own[1].label === 'Imported 1 (imported key)’s smart account');

  // WalletConnect smart-account bindings accept the imported id.
  const wcStore = memoryStore();
  await saveSmartBinding({ chain: 'eip155:11155111', address: KERNEL_IMPORTED, owner: ADDR_A, accountIndex: IMPORTED_ID, accountType: 'kernel-v3.3', factory: KERNEL_V3_3.factory }, wcStore);
  const bindings = await loadSmartBindings(wcStore);
  check('a WalletConnect smart-account binding for an imported owner round-trips', bindings.length === 1 && bindings[0].accountIndex === IMPORTED_ID);
  check('WalletConnect offers no method that could hand the wallet a key', WC_KERNEL_SMART_ACCOUNT_METHODS.every((m) => !/import|private|key|mnemonic/i.test(m)));
  for (const f of ['wallet/walletconnect.ts', 'wallet/wc-controller.ts', 'wallet/WalletConnectContext.tsx']) {
    check(`${f} never touches the import path`, !/importPrivateKey|importedKeyVault|parsePrivateKeyInput/.test(src(f)));
  }
}

// ===========================================================================
console.log('check-key-import: features that refuse an imported owner (before any request)');
// ===========================================================================
{
  const { bundle, node } = kernelBundle(IMPORTED_ID);
  const before = node.calls.length;
  const g = await resolveGuardianAccount(bundle, ADDR_A);
  check('guardians: refused with the plain sentence, no node request', g.ok === false && g.reason === GUARDIAN_IMPORTED_REFUSAL && node.calls.length === before);
  const r = await resolveOwnerRotationAccount(bundle, ADDR_A);
  check('owner change from an imported owner: refused', r.ok === false && r.reason === OWNER_ROTATION_IMPORTED_REFUSAL);
  check('owner change TO an imported account: refused', checkOwnerRotationTarget({
    account: null,
    currentOwner: PHRASE_ACCOUNT_0.address,
    newOwner: ADDR_A,
    walletOwners: [{ index: IMPORTED_ID, name: 'Imported 1', address: ADDR_A, path: IMPORTED_KEY_PATH }],
    guardians: null,
    config: kernelConfig,
  }) === OWNER_ROTATION_IMPORTED_TARGET);
  check('evmAccountPath never invents a path for an imported id', (() => { try { evmAccountPath(IMPORTED_ID); return false; } catch { return true; } })() && evmAccountPath(3) === "m/44'/60'/0'/0/3");
  check('guardian recovery onto an imported account: refused', (() => { try { draftRecoveryProgress('eip155:11155111', IMPORTED_ID, ADDR_A); return false; } catch (e) { return e.message === RECOVERY_IMPORTED_OWNER_REFUSAL; } })());
  const attachNode = fakeKernelNode({ chainIdHex: '0xaa36a7' });
  await checkRejects('attaching a recovered account to an imported owner: refused before any request',
    () => attachRecoveredAccount({ node: attachNode, chain: 'eip155:11155111', account: KERNEL_IMPORTED, owner: ADDR_A, ownerPath: IMPORTED_KEY_PATH, metadata: null, store: memoryStore() }),
    RECOVERY_IMPORTED_OWNER_REFUSAL);
  check('…no node request was made', attachNode.calls.length === 0);
  const recStore = memoryStore();
  await checkRejects('no recovery record is started for an imported owner', () => ensureFactoryKernelRecord({
    chain: 'eip155:11155111', account: KERNEL_IMPORTED, accountIndex: IMPORTED_ID, owner: ADDR_A, ownerPath: null,
    factory: KERNEL_V3_3.factory, implementation: KERNEL_V3_3.implementation, ecdsaValidator: KERNEL_V3_3.ecdsaValidator, store: recStore,
  }), GUARDIAN_IMPORTED_REFUSAL);
  await recoveryRecordListener(recStore)({ bundle, owner: { address: ADDR_A, path: IMPORTED_KEY_PATH }, quote: { sender: KERNEL_IMPORTED }, userOpHash: USEROP_HASH });
  check('the automatic record listener skips an imported owner (nothing stored)', recStore._map.size === 0);
  const recSrc = src('wallet/recovery.ts');
  check('record restore offers only phrase accounts as owners', /const owned = ownedAccounts\.filter\(\(a\) => !isImportedAccountId\(a\.index\) && isBip32Path\(a\.path\)\)/.test(recSrc));
  check('Change owner lists only phrase accounts as targets', /\.filter\(\(a\) => a\.evmAddress && !a\.imported\)/.test(src('screens/OwnerRotationScreen.tsx')));
  check('Recover screen refuses an imported new owner and filters imported owners', /if \(activeAccount\?\.imported\) throw new Error\(RECOVERY_IMPORTED_OWNER_REFUSAL\)/.test(src('screens/RecoverAccountScreen.tsx')) && /a\.evmAddress && !a\.imported/.test(src('screens/RecoverAccountScreen.tsx')));
}

// ===========================================================================
console.log('check-key-import: findings 2–8 of the 2026-10-04 private-key run');
// ===========================================================================
{
  // Finding 5: the removal dialog names what else the key controls on the
  // network in use: its smart account and EntryPoint deposit (best effort).
  const cfg = { ...kernelConfig, eip7702Owners: [], recoveredAccounts: [] };
  const fmt = (wei) => `${ethers.formatEther(wei)} test ETH`;
  const read = (config, node, bundlerCalls = []) =>
    readOwnerSmartAccountHoldings(config, {
      nodeUrl: NODE_URL,
      chainId: 11155111n,
      accountIndex: IMPORTED_ID,
      ownerAddress: ADDR_A,
      transportFor: (url) => (url === NODE_URL ? node : async (m) => { bundlerCalls.push(m); throw new Error('no bundler call expected'); }),
    });
  const EP_KEY = (holder) => `${ENTRYPOINT_V07.toLowerCase()}|${holder.toLowerCase()}`;
  {
    const node = fakeKernelNode({ chainIdHex: '0xaa36a7', balance: 0n });
    const bundlerCalls = [];
    const h = await read(cfg, node, bundlerCalls);
    check('an undeployed, empty smart account (salt 0) is read without any bundler request',
      h.kind === 'smart-account' && h.address === KERNEL_IMPORTED && h.deployed === false && h.balance === 0n && h.deposit === 0n && bundlerCalls.length === 0, JSON.stringify(h, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
    check('…and the dialog says nothing about it (nothing would be stranded)', importedRemovalStrandedSentence(h, fmt) === null);
  }
  {
    const node = fakeKernelNode({
      chainIdHex: '0xaa36a7',
      deployedAccounts: new Set([KERNEL_IMPORTED]),
      balance: 2_500_000_000_000_000n,
      tokenBalances: { [EP_KEY(KERNEL_IMPORTED)]: 500_000_000_000_000n },
    });
    const h = await read(cfg, node);
    const sentence = importedRemovalStrandedSentence(h, fmt);
    check('a deployed smart account with a balance and a deposit is named in full',
      sentence === `This key also controls the smart account ${KERNEL_IMPORTED} on Ethereum Sepolia, which holds 0.0025 test ETH and an EntryPoint deposit of 0.0005 test ETH. Only this key can move them, so they, and any tokens or NFTs that smart account holds, would be stranded too. Other networks were not checked.`, sentence ?? '');
    const msg = removeImportedMessage('Imported 1 (imported key)', ADDR_A, sentence);
    check('the first removal dialog keeps its sentences byte-identical and appends the stranded sentence',
      msg === `This deletes the private key of Imported 1 (imported key) (${ADDR_A}) from this phone. Your recovery phrase cannot bring it back: unless you kept the private key yourself, this account and everything it holds will be lost for good. Funds on-chain are not moved. ${sentence}`);
    check('…and without one it is exactly the old text', removeImportedMessage('X', ADDR_A) === `This deletes the private key of X (${ADDR_A}) from this phone. Your recovery phrase cannot bring it back: unless you kept the private key yourself, this account and everything it holds will be lost for good. Funds on-chain are not moved.`);
  }
  {
    const node = fakeKernelNode({ chainIdHex: '0xaa36a7' });
    const h = await read({ ...cfg, bundlerUrl: null }, node);
    check('no smart-account settings on this network: kind none, no node request, no sentence', h.kind === 'none' && node.calls.length === 0 && importedRemovalStrandedSentence(h, fmt) === null);
  }
  {
    const h = await read(cfg, fakeKernelNode({ chainIdHex: '0x1' }));
    check('a node on another chain: kind unknown (never blocks), and the dialog says it could not be checked',
      h.kind === 'unknown' && importedRemovalStrandedSentence(h, fmt) === 'This key may also control a smart account on Ethereum Sepolia; it could not be checked just now. Anything that smart account holds, and its EntryPoint deposit, would be stranded too.');
    const broken = await read(cfg, async () => { throw new Error('offline'); });
    check('a failing node: kind unknown, no throw', broken.kind === 'unknown');
  }
  {
    const node = fakeKernelNode({ chainIdHex: '0xaa36a7', tokenBalances: { [EP_KEY(ADDR_A)]: 300_000_000_000_000n } });
    const h = await read({ ...cfg, eip7702Owners: [ADDR_A] }, node);
    check('an EIP-7702 upgraded key: its own address\'s EntryPoint deposit is named',
      h.kind === 'eip7702' && h.deposit === 300_000_000_000_000n && importedRemovalStrandedSentence(h, fmt) === 'This account is upgraded (EIP-7702) on Ethereum Sepolia, and the EntryPoint holds a deposit of 0.0003 test ETH for it, which only this key can use; it would be stranded too. Other networks were not checked.');
  }

  // Finding 4: deleting the only copy needs the device check, after both
  // dialogs and before the deletion; a cancel deletes nothing.
  const acc = src('components/AccountsSection.tsx');
  const removeBody = acc.slice(acc.indexOf('const onRemoveImported'), acc.indexOf('const onRevealImported'));
  const removeOrder = (body) => {
    const confirm = body.indexOf('REMOVE_IMPORTED_CONFIRM_TITLE');
    const gate = body.indexOf('requireLocalAuth(PROMPTS.importedKeyRemove, {');
    const refusal = body.indexOf("if (!auth.ok) {\n                    Alert.alert('Not removed', `${auth.message} Nothing was deleted.`);\n                    return;\n                  }");
    const del = body.indexOf('removeImportedAccount(account.index)');
    return confirm >= 0 && gate > confirm && refusal > gate && del > refusal;
  };
  check('Remove: both dialogs, then requireLocalAuth for THAT key, then the deletion; a cancel returns with "Nothing was deleted."',
    removeOrder(removeBody) && /kind: 'imported',\s*slot: importedSlotOf\(account\.index\)/.test(removeBody));
  check('…the opened key is dropped right after the deletion', /await removeImportedAccount\(account\.index\);\s*\} finally \{\s*dropPhraseTicket\(\);/.test(removeBody));
  check('…with its own prompt title', PROMPTS.importedKeyRemove === 'Approve deleting the imported private key');
  check('M7 caught: a Remove without the device check fails the order check',
    !removeOrder(removeBody.replace('requireLocalAuth(PROMPTS.importedKeyRemove, {', 'Promise.resolve({ ok: true }) && ({')));

  // Finding 3: no "Change owner…" for an imported key's account.
  const guardians = src('screens/GuardiansScreen.tsx');
  const guardiansOk = (text) => {
    const importedBranch = text.indexOf('{owner && activeAccount?.imported ? (');
    const ownerBranch = text.indexOf(') : owner ? (', importedBranch);
    return importedBranch >= 0 && ownerBranch > importedBranch &&
      text.slice(importedBranch, ownerBranch).includes('{OWNER_ROTATION_IMPORTED_NOT_OFFERED}') &&
      !text.slice(importedBranch, ownerBranch).includes('Change owner…') &&
      text.slice(ownerBranch).includes('<Button title="Change owner…"');
  };
  check('Guardians: an imported account gets the not-offered sentence and no Change owner button', guardiansOk(guardians));
  check('the refusal text is unchanged (not-offered sentence + "Nothing was signed.")',
    OWNER_ROTATION_IMPORTED_REFUSAL === 'Changing the owner is not offered for a smart account owned by an imported private key in this version. Nothing was signed.' &&
      OWNER_ROTATION_IMPORTED_REFUSAL === `${OWNER_ROTATION_IMPORTED_NOT_OFFERED} Nothing was signed.`);

  // Finding 6: Home — the token fee sentence and the recover link.
  const home = src('screens/HomeScreen.tsx');
  check('Home footer: the corrected token-fee sentence, not "pay their network fee in ETH"',
    /tokens have their own Send link\. \{tokenSendFeeSentence\(evmChain\.caip2\)\}/.test(home) && !/network fee in ETH/.test(home));
  check('Home: "Lost a recovery phrase? Recover an account with guardians" is not offered from an imported account',
    /\{activeAccount\?\.imported \? null : \(\s*<Pressable[\s\S]{0,600}Lost a recovery phrase\? Recover an account with guardians/.test(home));

  // Finding 8: wording that reads naturally for one key.
  check('importedKeysSubject: one key, all of several, one of several, some of several',
    importedKeysSubject(1, 1) === 'Your imported private key' && importedKeysSubject(3, 3) === 'Your 3 imported private keys' &&
      importedKeysSubject(1, 3) === 'One of your imported private keys' && importedKeysSubject(2, 3) === '2 of your 3 imported private keys');

  // The known gap, closed from the other side: a phrase account added later
  // whose address equals an imported key's is flagged.
  const listed = [
    { name: 'Account 1', imported: false, evmAddress: PHRASE_ACCOUNT_0.address },
    { name: 'Imported 1 (imported key)', imported: true, evmAddress: ADDR_A.toLowerCase() },
  ];
  const note = phraseAccountSameAsImportedNote({ name: 'Account 3', imported: false, evmAddress: ADDR_A }, listed);
  check('a new phrase account with an imported key\'s address is flagged (case-insensitive), with the smart-account caveat',
    note === `Account 3 comes from your recovery phrase and has the same Ethereum address (${ADDR_A}) as Imported 1 (imported key). That imported key is this phrase account's key, so your recovery phrase does back it up. You can use Account 3 instead and remove the imported copy in Settings → Accounts. Before removing it, move anything its smart account holds: the phrase account’s smart account has a different address.`, note ?? '');
  check('…not for a different address, an imported "new" account, or a match with a phrase account only',
    phraseAccountSameAsImportedNote({ name: 'Account 3', imported: false, evmAddress: ADDR_B }, listed) === null &&
      phraseAccountSameAsImportedNote({ name: 'X', imported: true, evmAddress: ADDR_A }, listed) === null &&
      phraseAccountSameAsImportedNote({ name: 'Account 3', imported: false, evmAddress: PHRASE_ACCOUNT_0.address }, listed) === null);
  check('both add paths show it (Settings → Accounts and the switcher)',
    /phraseAccountSameAsImportedNote\(out\.created, accountList\)/.test(acc) && /PHRASE_ACCOUNT_WAS_IMPORTED_TITLE/.test(acc) &&
      /phraseAccountSameAsImportedNote\(created, accountList\)/.test(src('components/AccountSwitcher.tsx')) && PHRASE_ACCOUNT_WAS_IMPORTED_TITLE === 'This key was already imported');
  const ikSource = src('wallet/imported-keys.ts');
  const mutant = await importAppMutant('src/wallet/imported-keys.ts', ikSource.replace('accounts.find((a) => a.imported && a.evmAddress?.toLowerCase() === lower)', 'accounts.find((a) => a.evmAddress?.toLowerCase() === lower)'));
  check('M8 caught: without the imported-only match a phrase account is "flagged" against itself',
    mutant.phraseAccountSameAsImportedNote({ name: 'Account 3', imported: false, evmAddress: PHRASE_ACCOUNT_0.address }, listed) !== null);

  // More mutation checks, one per remaining fix.
  const depositOnly = { kind: 'smart-account', network: 'Ethereum Sepolia', address: KERNEL_IMPORTED, deployed: false, balance: 0n, deposit: 1n };
  check('an undeployed smart account holding only a deposit is still named', importedRemovalStrandedSentence(depositOnly, fmt) !== null);
  const m9 = await importAppMutant('src/wallet/imported-keys.ts', ikSource.replace('holdings.balance <= 0n && holdings.deposit <= 0n) return null;', 'holdings.balance <= 0n) return null;'));
  check('M9 caught: a removal sentence that ignores the deposit stays silent about it', m9.importedRemovalStrandedSentence(depositOnly, fmt) === null);
  const ppcSource = src('wallet/phrase-protection-copy.ts');
  const m10 = await importAppMutant('src/wallet/phrase-protection-copy.ts', ppcSource.replace("count === 1 ? 'Your imported private key' :", 'count === 1 ? `Your ${count} imported private key` :'));
  check('M10 caught: the old "Your 1 imported private key" wording fails the singular check', m10.importedKeysSubject(1, 1) !== 'Your imported private key');
  const guardianMutant = guardians.replace('{owner && activeAccount?.imported ? (', '{false ? (');
  check('M11 caught: a Guardians screen that offers Change owner to an imported account fails the check', !guardiansOk(guardianMutant));
  const homeMutant = home.replace('{activeAccount?.imported ? null : (', '{(');
  check('M12 caught: a Home screen that always shows the recover link fails the check',
    !/\{activeAccount\?\.imported \? null : \(\s*<Pressable[\s\S]{0,600}Lost a recovery phrase\? Recover an account with guardians/.test(homeMutant));
  const accMutant = acc.replace('{accountsBackupHint(importedCount > 0)}', 'Every account comes from your one recovery phrase, so the phrase backs up all of them.');
  check('M13 caught: the old Settings opening sentence fails the shared-sentence check',
    !/\{accountsBackupHint\(importedCount > 0\)\}/.test(accMutant) && /Every account comes from your one recovery phrase, so the phrase backs/.test(accMutant));
}

// ===========================================================================
console.log('check-key-import: honesty and input hygiene in the screens (source checks)');
// ===========================================================================
{
  check('the shared sentence', IMPORTED_KEY_NOT_BACKED_UP === 'This account comes from an imported private key. Your recovery phrase does NOT back it up: if this phone is lost or the wallet is removed, the account and its funds are lost unless you kept the private key yourself.');
  check('the not-available sentence', IMPORTED_KEY_NO_CHAIN === 'Not available for an imported key. An imported Ethereum private key has an Ethereum address only; use an account from your recovery phrase for this network.');
  const ctx = src('wallet/WalletContext.tsx');
  check('every imported account\'s shown name ends in "(imported key)"', IMPORTED_NAME_SUFFIX === ' (imported key)' && /name: a\.imported \? `\$\{a\.name\}\$\{IMPORTED_NAME_SUFFIX\}` : a\.name/.test(ctx));
  check('ImportedKeyNotice renders IMPORTED_KEY_NOT_BACKED_UP', /<WarningBox>\{IMPORTED_KEY_NOT_BACKED_UP\}<\/WarningBox>/.test(src('components.tsx')));
  const notice = (f, min = 1) => (src(f).match(/<ImportedKeyNotice\b/g) ?? []).length >= min;
  check('notice on Home (under the switcher)', notice('screens/HomeScreen.tsx') && /<ImportedKeyNotice show=\{activeAccount\?\.imported === true\} \/>/.test(src('screens/HomeScreen.tsx')));
  check('Home shows Bitcoin, Dogecoin and Solana as not available for an imported key', /IMPORTED_KEY_NO_CHAIN/.test(src('screens/HomeScreen.tsx')) && /activeAccount\?\.imported \?/.test(src('screens/HomeScreen.tsx')));
  check('notice on Receive, with the no-derivation-path label', notice('screens/ReceiveScreen.tsx') && /Imported private key — no derivation path, not part of your recovery phrase/.test(src('screens/ReceiveScreen.tsx')));
  check('notice under every Send "From account" / owner row (4)', notice('screens/SendScreen.tsx', 4));
  check('notice on the swap confirms (3)', notice('screens/SwapScreen.tsx', 3));
  check('notice on the approvals revoke confirm', notice('screens/ApprovalsScreen.tsx'));
  check('notice on the sessions, passkey and upgrade owner rows', notice('screens/SessionsScreen.tsx') && notice('screens/PasskeyScreen.tsx') && notice('screens/UpgradeAccountScreen.tsx'));
  check('notice on the WalletConnect sheet, fed by the active account', notice('components/WcApprovalSheet.tsx') && /importedKey=\{activeAccount\?\.imported === true\}/.test(src('wallet/WalletConnectContext.tsx')));
  check('notice on the import screen and the private-key reveal', notice('screens/ImportKeyScreen.tsx') && notice('components/ImportedKeyReveal.tsx'));
  const acc = src('components/AccountsSection.tsx');
  // Finding 2 of the 2026-10-04 private-key run: Settings → Accounts opened
  // with "Every account comes from your one recovery phrase" and appended the
  // exception; both lists now use one helper whose sentence is true as one
  // statement.
  check('Settings → Accounts labels imported rows', /NOT backed up by your recovery phrase/.test(acc));
  check('the shared backup sentence: true as one statement when imported accounts exist',
    accountsBackupHint(true) === 'Every account except the imported ones comes from your one recovery phrase. Imported accounts are NOT backed up by the phrase: keep their private keys yourself.' &&
      accountsBackupHint(false) === 'Every account comes from your one recovery phrase — backing up the phrase backs up all of them.');
  check('Settings → Accounts and the switcher both use it; the old opening sentence is gone from Settings',
    /\{accountsBackupHint\(importedCount > 0\)\}/.test(acc) && /\{accountsBackupHint\(anyImported\)\}/.test(src('components/AccountSwitcher.tsx')) &&
      !/Every account comes from your one recovery phrase, so the phrase backs/.test(acc) && !/Imported accounts are the exception/.test(acc));
  const settings = src('screens/SettingsScreen.tsx');
  check('Backup section names the imported accounts the phrase does NOT back up', /It does NOT back up your imported accounts/.test(settings));
  check('the phrase reveal says it does not restore imported accounts, and its gate opens the PHRASE', /They do not restore your imported accounts/.test(settings) && /requireLocalAuth\('Reveal recovery phrase', \{ kind: 'phrase' \}\)/.test(settings));
  check('wipe confirmation names the imported keys it deletes', /This also deletes the private keys of your imported accounts/.test(settings));
  check('the onboarding backup screen says imported keys are not covered', /They do not back up private keys you import later/.test(src('screens/BackupScreen.tsx')));
  // Show private key: same confirmation, gate and screenshot block as the phrase.
  const revealIdx = acc.indexOf('const onRevealImported');
  const revealBody = acc.slice(revealIdx, acc.indexOf('const renderRow'));
  check('Show private key: confirmation, then requireLocalAuth for THAT key, then the read', /REVEAL_IMPORTED_TITLE/.test(revealBody) && revealBody.indexOf("requireLocalAuth(PROMPTS.importedKeyReveal, {") < revealBody.indexOf('revealImportedKey(account.index)') && /kind: 'imported'/.test(revealBody));
  check('the reveal view blocks screenshots while open and empties a pending clipboard copy when closed', /preventScreenCaptureAsync\(CAPTURE_KEY\)/.test(src('components/ImportedKeyReveal.tsx')) && /keyClipboard\.clearNow\(\)/.test(src('components/ImportedKeyReveal.tsx')));
  const removeBody = acc.slice(acc.indexOf('const onRemoveImported'), acc.indexOf('const onRevealImported'));
  check('Remove: two confirmations that state the consequence come before the deletion', /removeImportedMessage\(/.test(removeBody) && /REMOVE_IMPORTED_CONFIRM_TITLE/.test(removeBody) && removeBody.indexOf('REMOVE_IMPORTED_CONFIRM_TITLE') < removeBody.indexOf('removeImportedAccount(account.index)'));
  const imp = src('screens/ImportKeyScreen.tsx');
  check('key field: password field, no autocorrect, autocomplete, autofill or spell-check',
    /secureTextEntry\n/.test(imp) && /autoCorrect=\{false\}/.test(imp) && /autoComplete="off"/.test(imp) && /importantForAutofill="no"/.test(imp) && /spellCheck=\{false\}/.test(imp) && /textContentType="none"/.test(imp));
  check('screenshots are blocked while the field holds text', /if \(!hasText\) return undefined;\s*preventScreenCaptureAsync\(CAPTURE_KEY\)/.test(imp));
  check('the key is cleared from state right after saving, and the clipboard warning is shown', /await importPrivateKey\(input, [^\n]*\);\s*\/\/[^\n]*\n\s*setInput\(''\);/.test(imp) && /IMPORT_KEY_CLIPBOARD_WARNING/.test(imp) && /Clipboard\.setStringAsync\(''\)/.test(imp));
  check('a scanned QR goes through the same validation (it only fills the field)', /onScanned=\{\(data\) => \{\s*setScanning\(false\);\s*setInput\(data\.trim\(\)\);/.test(imp) && /parsePrivateKeyInput\(input\)/.test(imp));
  check('the full address is shown before saving', /This key controls the Ethereum address/.test(imp) && /\{parsed\.address\}/.test(imp));
  for (const f of ['wallet/imported-keys.ts', 'wallet/account-ids.ts', 'screens/ImportKeyScreen.tsx', 'components/ImportedKeyReveal.tsx']) {
    check(`${f}: no console logging, no AsyncStorage`, !/console\.\w+\(/.test(src(f)) && !/AsyncStorage/.test(src(f)));
  }
  const storageSrc = src('wallet/storage.ts');
  check('only storage.ts names the imported-key secure-store entries', ['wallet/WalletContext.tsx', 'wallet/accounts.ts', 'wallet/imported-keys.ts', 'screens/ImportKeyScreen.tsx'].every((f) => !src(f).includes('shiba-wallet.imported-key')) && storageSrc.includes("'shiba-wallet.imported-key.v1.'"));
  check('the account list in AsyncStorage holds no address or key for imported accounts', !/evmAddress|privateKey/.test(src('wallet/accounts.ts').slice(src('wallet/accounts.ts').indexOf('export async function addImportedAccountEntry'), src('wallet/accounts.ts').indexOf('export async function removeImportedAccountEntry'))));
  const ready = featureReadiness('imported-key');
  check('readiness: advisory row citing T-67', ready.status === 'blocked' && ready.enforced === false && ready.evidence.includes('T-67'));
}

// ===========================================================================
console.log('check-key-import: mutation checks (broken copies of storage.ts must be caught)');
// ===========================================================================
{
  const storagePath = join(HERE, '..', 'src', 'wallet', 'storage.ts');
  const idsPath = join(HERE, '..', 'src', 'wallet', 'account-ids.ts');
  const original = readFileSync(storagePath, 'utf8');
  const dir = join(HERE, `.mutants-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'account-ids.ts'), readFileSync(idsPath, 'utf8'));
  let n = 0;
  const load = async (from, to) => {
    if (!original.includes(from)) throw new Error(`mutation anchor not found: ${from}`);
    n += 1;
    const file = join(dir, `storage-m${n}.ts`);
    writeFileSync(file, original.replace(from, to));
    return import(file);
  };
  try {
    // M1: the protected save skips the read-back comparison.
    {
      const m = await load('if (readBack !== value) {', 'if (false) {');
      const shim = makeShim();
      const v = m.createKeyVault(shim);
      await v.saveNewPhrase(PHRASE);
      await v.upgrade();
      shim.rules.push({ op: 'set', key: PROTECTED_IMPORTED_KEY_PREFIX + '0', corrupt: true });
      const res = await v.importedKeys.save(canon(KEY_A), ADDR_A);
      check('M1 caught: without the read-back compare a corrupt protected copy is kept (the real vault falls back to standard)', res.info.location === 'protected');
    }
    // M2: the held secret is handed to any target.
    {
      const m = await load('if (!t || now() > t.expiresAt || t.target !== target) return null;', 'if (!t || now() > t.expiresAt) return null;');
      const shim = makeShim();
      const v = m.createKeyVault(shim);
      await v.saveNewPhrase(PHRASE);
      await v.upgrade();
      await v.importedKeys.save(canon(KEY_A), ADDR_A);
      v.setApprovalTarget({ kind: 'imported', slot: 0 });
      await v.openPhraseForApproval('Approve');
      check('M2 caught: without the target check a phrase read receives the imported key', (await v.readPhrase('x')) === canon(KEY_A));
    }
    // M3: the duplicate-address refusal is removed.
    {
      const m = await load("throw new Error('This key is already imported.');", 'void 0;');
      const shim = makeShim();
      const v = m.createKeyVault(shim);
      await v.saveNewPhrase(PHRASE);
      await v.importedKeys.save(canon(KEY_A), ADDR_A);
      const e = await rejects(() => v.importedKeys.save(canon(KEY_A), ADDR_A));
      check('M3 caught: without the duplicate check the same key is stored twice (the strict record then refuses itself)', e === null || !/already imported/.test(e.message));
    }
    // M4: wipe forgets the record.
    {
      const m = await load('await backend.deleteItemAsync(IMPORTED_KEYS_META_KEY, STANDARD);', 'void 0;');
      const shim = makeShim();
      const v = m.createKeyVault(shim);
      await v.saveNewPhrase(PHRASE);
      await v.importedKeys.save(canon(KEY_A), ADDR_A);
      await v.importedKeys.removeAll();
      check('M4 caught: a wipe that keeps the record leaves the address behind', shim.meta() !== null);
    }
    // M5: the migration deletes the standard copy BEFORE the protected copy is confirmed.
    {
      const m = await load(
        'const failure = await writeProtectedImported(record.slot, value);',
        'await backend.deleteItemAsync(standardImportedKey(record.slot), STANDARD);\n      const failure = await writeProtectedImported(record.slot, value);',
      );
      const shim = makeShim();
      const v = m.createKeyVault(shim);
      await v.saveNewPhrase(PHRASE);
      await v.importedKeys.save(canon(KEY_A), ADDR_A);
      shim.rules.push({ op: 'set', key: PROTECTED_IMPORTED_KEY_PREFIX + '0', error: 'refused' });
      await v.upgrade();
      const e = await rejects(() => v.importedKeys.read(0, 'x'));
      check('M5 caught: delete-before-verify loses the key when the protected write fails (the real vault keeps it)', e !== null && e.reason === 'missing');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\ncheck-key-import: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
