// Exercises multi-account support (phase 6 item 3) fully offline:
//  - the account store in src/wallet/accounts.ts (add, rename, hide, show,
//    index never reused, corrupt / tampered storage), against an in-memory
//    KeyValueStore standing in for AsyncStorage;
//  - the ONE derivation mapping (derivationArgsFor) for all four chains,
//    cross-checked against independent implementations: ethers
//    HDNodeWallet (its own BIP-32) for EVM, and for Bitcoin/Dogecoin the
//    ethers-derived public key encoded by bitcoinjs-lib; ed25519-hd-key
//    (its own SLIP-0010) + @solana/web3.js Keypair for Solana;
//  - the account-0 invariant (byte-identical to the pre-multi-account
//    (0, 0) derivation, plus pinned literals);
//  - the signing half of WalletContext.signWith (deriveSignerFor): the
//    active account's key signs, signatures recover to its address, and a
//    signer/address mismatch refuses before signing;
//  - the ERC-4337 counterfactual per account (salt = account index), with
//    account 0 identical to the pre-change spec construction;
//  - WalletConnect session-address binding in WcController.
//
// Every key comes from the standard BIP-39 test mnemonic ("abandon ...
// about", public knowledge). Nothing touches the network.
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-accounts.mjs

import {
  bitcoinKeyProvider,
  dogecoinKeyProvider,
  evmKeyProvider,
  mnemonicToSeed,
  solanaKeyProvider,
} from '@shiba-wallet/core';
import { createSimpleAccountSpec, toHex } from '@shiba-wallet/chains-evm';
import { ethers } from 'ethers';
import * as bitcoin from 'bitcoinjs-lib';
import { derivePath as ed25519DerivePath } from 'ed25519-hd-key';
import { Keypair, PublicKey } from '@solana/web3.js';
import { createPublicKey, verify as nodeVerify } from 'node:crypto';
import {
  ACCOUNT_CHANGED_MESSAGE,
  BIP32_HARDENED_OFFSET,
  MAX_ACCOUNTS,
  accountLabel,
  addAccount,
  defaultAccountsState,
  deriveChainAccounts,
  deriveForAccount,
  deriveSignerFor,
  derivationArgsFor,
  hideAccount,
  loadAccounts,
  renameAccount,
  resetAccounts,
  sameAccountAddress,
  sanitizeAccountName,
  setActiveAccount,
  unhideAccount,
  visibleAccounts,
} from '../src/wallet/accounts.ts';
import { createAaClient } from '../src/wallet/aa.ts';
import {
  WC_ERRORS,
  accountMismatchMessage,
  sessionAccountNote,
  sessionAddressesOf,
  summarizeSessions,
} from '../src/wallet/walletconnect.ts';
import { WcController } from '../src/wallet/wc-controller.ts';

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

async function checkRejects(name, fn, messagePart) {
  try {
    const value = await fn();
    check(name, false, `expected an error, got ${JSON.stringify(value)}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    check(name, message.includes(messagePart), `error was: ${message}`);
  }
}

function checkThrows(name, fn, messagePart) {
  try {
    const value = fn();
    check(name, false, `expected an error, got ${JSON.stringify(value)}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    check(name, message.includes(messagePart), `error was: ${message}`);
  }
}

const ACCOUNTS_KEY = 'shiba-wallet.accounts.v1';

function memoryStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    async getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async setItem(key, value) {
      map.set(key, value);
    },
  };
}

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seed = mnemonicToSeed(TEST_MNEMONIC);

const EVM = evmKeyProvider.chainId;
const BTC = bitcoinKeyProvider.chainId;
const DOGE = dogecoinKeyProvider.chainId;
const SOL = solanaKeyProvider.chainId;

// ------------------------------------------------------------- store

console.log('check-accounts: account store');
{
  const store = memoryStore();
  let state = await loadAccounts(store);
  check('empty storage → default list', JSON.stringify(state) === JSON.stringify(defaultAccountsState()));
  check('default is [Account 1 = index 0], active 0, next 1',
    state.accounts.length === 1 && state.accounts[0].index === 0 && state.accounts[0].name === 'Account 1' &&
      state.activeIndex === 0 && state.nextIndex === 1);

  let r = await addAccount(null, store);
  check('add → index 1 named "Account 2"', r.account.index === 1 && r.account.name === 'Account 2');
  check('add does not switch', r.state.activeIndex === 0);
  r = await addAccount('  Savings‮  ', store);
  check('add with a name → index 2, sanitized (bidi override stripped, trimmed)', r.account.index === 2 && r.account.name === 'Savings');
  await checkRejects('add with an over-long name is refused', () => addAccount('x'.repeat(33), store), 'at most 32');
  state = await loadAccounts(store);
  check('refused add persisted nothing (nextIndex still 3)', state.nextIndex === 3 && state.accounts.length === 3);
  check('whitespace-only name falls back to the default', (await addAccount('   ', store)).account.name === 'Account 4');

  state = await renameAccount(1, 'Trading​ desk', store);
  check('rename sanitizes (zero-width space stripped)', state.accounts.find((a) => a.index === 1).name === 'Trading desk');
  await checkRejects('rename to empty is refused', () => renameAccount(1, ' ​ ', store), 'Enter a name for this account');
  await checkRejects('rename of an unknown index is refused', () => renameAccount(99, 'X', store), 'no account with index 99');
  check('sanitizeAccountName shares the contacts rules', sanitizeAccountName('a\u0000b').ok && sanitizeAccountName('a\u0000b').name === 'ab');

  await checkRejects('account 0 cannot be hidden', () => hideAccount(0, store), 'cannot be hidden');
  await setActiveAccount(2, store);
  await checkRejects('the active account cannot be hidden', () => hideAccount(2, store), 'active account');
  await setActiveAccount(0, store);
  state = await hideAccount(2, store);
  check('hide keeps the entry and its index', state.accounts.some((a) => a.index === 2 && a.hidden));
  check('hidden account is not listed as visible', !visibleAccounts(state).some((a) => a.index === 2));
  await checkRejects('a hidden account cannot be made active', () => setActiveAccount(2, store), 'hidden');
  r = await addAccount(null, store);
  check('INDEX NEVER REUSED: add after hide takes index 4, not 2', r.account.index === 4);
  state = await unhideAccount(2, store);
  check('show again restores the same index and name', state.accounts.some((a) => a.index === 2 && !a.hidden && a.name === 'Savings'));
  await checkRejects('switching to an unknown index is refused', () => setActiveAccount(42, store), 'no account with index 42');
  state = await setActiveAccount(4, store);
  check('active index persists', (await loadAccounts(store)).activeIndex === 4);

  // Round-trip: stored JSON is versioned.
  const stored = JSON.parse(store.map.get(ACCOUNTS_KEY));
  check('stored under a versioned key with version 1', stored.version === 1 && Array.isArray(stored.accounts));

  state = await resetAccounts(store);
  check('reset restores the default list', JSON.stringify(state) === JSON.stringify(defaultAccountsState()) &&
    JSON.stringify(await loadAccounts(store)) === JSON.stringify(defaultAccountsState()));
}

console.log('check-accounts: corrupt / tampered storage');
{
  const def = JSON.stringify(defaultAccountsState());
  check('corrupt JSON → default', JSON.stringify(await loadAccounts(memoryStore({ [ACCOUNTS_KEY]: '{not json' }))) === def);
  check('wrong version → default', JSON.stringify(await loadAccounts(memoryStore({ [ACCOUNTS_KEY]: JSON.stringify({ version: 2, accounts: [] }) }))) === def);
  check('non-object → default', JSON.stringify(await loadAccounts(memoryStore({ [ACCOUNTS_KEY]: '42' }))) === def);
  const throwing = { getItem: async () => { throw new Error('disk'); }, setItem: async () => {} };
  check('unreadable storage → default (never throws)', JSON.stringify(await loadAccounts(throwing)) === def);

  const tampered = {
    version: 1,
    accounts: [
      { index: 3, name: 'Three', hidden: false },
      { index: 3, name: 'Duplicate three', hidden: false },
      { index: -1, name: 'Negative' },
      { index: 1.5, name: 'Fraction' },
      { index: BIP32_HARDENED_OFFSET, name: 'Too big' },
      { index: 5, name: 'bad‮name', hidden: true },
      'garbage',
      null,
    ],
    activeIndex: 5,
    nextIndex: 2,
  };
  const s = await loadAccounts(memoryStore({ [ACCOUNTS_KEY]: JSON.stringify(tampered) }));
  check('duplicate / negative / fractional / >= 2^31 / garbage entries dropped',
    JSON.stringify(s.accounts.map((a) => a.index)) === JSON.stringify([0, 3, 5]), JSON.stringify(s.accounts));
  check('first duplicate kept', s.accounts.find((a) => a.index === 3).name === 'Three');
  check('missing account 0 re-inserted', s.accounts[0].index === 0 && s.accounts[0].name === 'Account 1' && !s.accounts[0].hidden);
  check('unsanitized stored name replaced by the default (account kept)', s.accounts.find((a) => a.index === 5).name === 'Account 6');
  check('hidden active index falls back to 0', s.activeIndex === 0);
  check('nextIndex never below max index + 1', s.nextIndex === 6);
  const s2 = await loadAccounts(memoryStore({ [ACCOUNTS_KEY]: JSON.stringify({ version: 1, accounts: [{ index: 0, name: 'Main', hidden: true }], activeIndex: 9, nextIndex: 1 }) }));
  check('account 0 can never be stored hidden', s2.accounts[0].hidden === false && s2.accounts[0].name === 'Main');
  check('unknown active index falls back to 0', s2.activeIndex === 0);

  const full = memoryStore();
  for (let i = 1; i < MAX_ACCOUNTS; i += 1) await addAccount(null, full);
  await checkRejects(`the ${MAX_ACCOUNTS}-account cap is enforced`, () => addAccount(null, full), `maximum of ${MAX_ACCOUNTS}`);
}

// ------------------------------------------------------- derivation mapping

console.log('check-accounts: derivation mapping (derivationArgsFor)');
{
  check('EVM account N → (account 0, addressIndex N)', JSON.stringify(derivationArgsFor(EVM, 7)) === JSON.stringify({ account: 0, addressIndex: 7 }));
  check('Sepolia (any eip155) uses the same EVM mapping', JSON.stringify(derivationArgsFor('eip155:11155111', 7)) === JSON.stringify({ account: 0, addressIndex: 7 }));
  for (const [name, id] of [['Bitcoin', BTC], ['Dogecoin', DOGE], ['Solana', SOL]]) {
    check(`${name} account N → (account N, addressIndex 0)`, JSON.stringify(derivationArgsFor(id, 7)) === JSON.stringify({ account: 7, addressIndex: 0 }));
  }
  checkThrows('unknown chain family throws (no silent default)', () => derivationArgsFor('cosmos:cosmoshub-4', 1), 'No account derivation mapping');
  checkThrows('negative index throws', () => derivationArgsFor(EVM, -1), 'Invalid account index');
  checkThrows('index >= 2^31 throws', () => derivationArgsFor(BTC, BIP32_HARDENED_OFFSET), 'Invalid account index');
  checkThrows('fractional index throws', () => derivationArgsFor(SOL, 0.5), 'Invalid account index');

  const expectPaths = (n) => ({
    [EVM]: `m/44'/60'/0'/0/${n}`,
    [BTC]: `m/84'/0'/${n}'/0/0`,
    [DOGE]: `m/44'/3'/${n}'/0/0`,
    [SOL]: `m/44'/501'/${n}'/0'`,
  });
  for (const n of [0, 1, 2]) {
    const set = deriveChainAccounts(seed, n);
    const want = expectPaths(n);
    check(`account ${n}: paths are exactly the ADR D8 table`, set.every((c) => c.path === want[c.chainId]),
      JSON.stringify(set.map((c) => c.path)));
  }
}

console.log('check-accounts: independent cross-checks');
const ethRoot = ethers.HDNodeWallet.fromPhrase(TEST_MNEMONIC, '', 'm');
const vectors = {};
{
  // EVM accounts 0–2 vs ethers HDNodeWallet at m/44'/60'/0'/0/N.
  for (const n of [0, 1, 2]) {
    const ours = deriveForAccount(evmKeyProvider, seed, n).address;
    const theirs = ethRoot.derivePath(`m/44'/60'/0'/0/${n}`).address;
    vectors[`evm${n}`] = ours;
    check(`EVM account ${n} == ethers m/44'/60'/0'/0/${n} (${theirs})`, ours === theirs, ours);
  }
  check('EVM account 1 != ethers m/44\'/60\'/1\'/0/0 (the layout NOT used)',
    deriveForAccount(evmKeyProvider, seed, 1).address !== ethRoot.derivePath("m/44'/60'/1'/0/0").address);

  // Bitcoin accounts 0–1: ethers derives the key (independent BIP-32),
  // bitcoinjs-lib encodes the P2WPKH address (independent bech32 + hash160).
  for (const n of [0, 1]) {
    const pub = Buffer.from(ethers.getBytes(ethRoot.derivePath(`m/84'/0'/${n}'/0/0`).publicKey));
    const theirs = bitcoin.payments.p2wpkh({ pubkey: pub }).address;
    const ours = deriveForAccount(bitcoinKeyProvider, seed, n).address;
    vectors[`btc${n}`] = ours;
    check(`Bitcoin account ${n} == ethers+bitcoinjs m/84'/0'/${n}'/0/0 (${theirs})`, ours === theirs, ours);
  }
  // BIP-84's published test vector (same mnemonic): m/84'/0'/0'/0/0.
  check('Bitcoin account 0 == BIP-84 official vector bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
    vectors.btc0 === 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');

  // Dogecoin accounts 0–1: ethers key, bitcoinjs P2PKH with Dogecoin's
  // pubKeyHash version 0x1e (dogecoin/dogecoin chainparams.cpp).
  const dogeNet = { ...bitcoin.networks.bitcoin, pubKeyHash: 0x1e, scriptHash: 0x16, wif: 0x9e };
  for (const n of [0, 1]) {
    const pub = Buffer.from(ethers.getBytes(ethRoot.derivePath(`m/44'/3'/${n}'/0/0`).publicKey));
    const theirs = bitcoin.payments.p2pkh({ pubkey: pub, network: dogeNet }).address;
    const ours = deriveForAccount(dogecoinKeyProvider, seed, n).address;
    vectors[`doge${n}`] = ours;
    check(`Dogecoin account ${n} == ethers+bitcoinjs m/44'/3'/${n}'/0/0 (${theirs})`, ours === theirs, ours);
  }

  // Solana accounts 0–1: ed25519-hd-key (independent SLIP-0010) + web3.js.
  const seedHex = Buffer.from(seed).toString('hex');
  for (const n of [0, 1]) {
    const { key } = ed25519DerivePath(`m/44'/501'/${n}'/0'`, seedHex);
    const theirs = Keypair.fromSeed(key).publicKey.toBase58();
    const ours = deriveForAccount(solanaKeyProvider, seed, n).address;
    vectors[`sol${n}`] = ours;
    check(`Solana account ${n} == ed25519-hd-key+web3.js m/44'/501'/${n}'/0' (${theirs})`, ours === theirs, ours);
  }
}

console.log('check-accounts: account-0 invariant');
{
  // The pre-multi-account app derived every chain with (account 0, index 0).
  const before = [evmKeyProvider, bitcoinKeyProvider, dogecoinKeyProvider, solanaKeyProvider].map((p) => {
    const a = p.deriveAccount(seed, 0, 0);
    return { chainId: p.chainId, address: a.address, path: a.path, pub: toHex(a.publicKey) };
  });
  const after = deriveChainAccounts(seed, 0);
  for (const b of before) {
    const a = after.find((x) => x.chainId === b.chainId);
    const pubAfter = toHex(deriveForAccount(
      [evmKeyProvider, bitcoinKeyProvider, dogecoinKeyProvider, solanaKeyProvider].find((p) => p.chainId === b.chainId), seed, 0).publicKey);
    check(`${b.chainId}: account 0 address, path and public key byte-identical to (0, 0)`,
      a && a.address === b.address && a.path === b.path && pubAfter === b.pub);
  }
  // Pinned literals (standard test mnemonic), so a mapping change cannot
  // slip through by changing both sides of the comparison above.
  const pinned = {
    [EVM]: ['0x9858EfFD232B4033E47d90003D41EC34EcaEda94', "m/44'/60'/0'/0/0"],
    [BTC]: ['bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', "m/84'/0'/0'/0/0"],
    [DOGE]: ['DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC', "m/44'/3'/0'/0/0"],
    [SOL]: ['HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk', "m/44'/501'/0'/0'"],
  };
  for (const a of after) {
    check(`${a.chainId}: account 0 pinned ${pinned[a.chainId][0]}`, a.address === pinned[a.chainId][0] && a.path === pinned[a.chainId][1]);
  }
  const pinned1 = {
    [EVM]: '0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0',
    [BTC]: 'bc1qku0qh0mc00y8tk0n65x2tqw4trlspak0fnjmfz',
    [DOGE]: 'DEiUcV7xvCRdpQmsW3i8T9EVsb7zeiUQRt',
    [SOL]: 'Hh8QwFUA6MtVu1qAoq12ucvFHNwCcVTV7hpWjeY1Hztb',
  };
  for (const a of deriveChainAccounts(seed, 1)) {
    check(`${a.chainId}: account 1 pinned ${pinned1[a.chainId]}`, a.address === pinned1[a.chainId]);
  }
  check('EVM account 2 pinned 0xb6716976A3ebe8D39aCEB04372f22Ff8e6802D7A',
    deriveChainAccounts(seed, 2).find((a) => a.chainId === EVM).address === '0xb6716976A3ebe8D39aCEB04372f22Ff8e6802D7A');
}

// ------------------------------------------------------------- signing

console.log('check-accounts: signWith-equivalent signing (deriveSignerFor)');
{
  const digest = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes('multi-account signing check')));
  for (const n of [0, 1, 2]) {
    const expected = vectors[`evm${n}`];
    const signer = deriveSignerFor(evmKeyProvider, seed, n, expected);
    const sig = signer.sign(digest); // r || s || recid (65 bytes)
    const recovered = ethers.recoverAddress(digest, {
      r: ethers.hexlify(sig.slice(0, 32)),
      s: ethers.hexlify(sig.slice(32, 64)),
      v: 27 + sig[64],
    });
    check(`EVM active account ${n}: signature recovers to ${expected}`, recovered === expected, recovered);
  }
  check('EVM expected-address match is case-insensitive',
    deriveSignerFor(evmKeyProvider, seed, 1, vectors.evm1.toLowerCase()).address === vectors.evm1);
  checkThrows('active account 1 but prepared for account 0 → refused before signing',
    () => deriveSignerFor(evmKeyProvider, seed, 1, vectors.evm0), ACCOUNT_CHANGED_MESSAGE);
  checkThrows('empty expected address → refused', () => deriveSignerFor(evmKeyProvider, seed, 0, ''), ACCOUNT_CHANGED_MESSAGE);
  checkThrows('Bitcoin: prepared for account 0, active 1 → refused', () => deriveSignerFor(bitcoinKeyProvider, seed, 1, vectors.btc0), ACCOUNT_CHANGED_MESSAGE);
  check('Bitcoin active account 1: signer public key hashes to account 1 address',
    bitcoin.payments.p2wpkh({ pubkey: Buffer.from(deriveSignerFor(bitcoinKeyProvider, seed, 1, vectors.btc1).publicKey) }).address === vectors.btc1);
  const solSigner = deriveSignerFor(solanaKeyProvider, seed, 1, vectors.sol1);
  const msg = new TextEncoder().encode('solana message');
  // Verified with Node's built-in (OpenSSL) Ed25519, independent of noble.
  const solKey = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(new PublicKey(vectors.sol1).toBytes()).toString('base64url') },
    format: 'jwk',
  });
  check('Solana active account 1: signature verifies under account 1 public key (node:crypto Ed25519)',
    nodeVerify(null, Buffer.from(msg), solKey, Buffer.from(solSigner.sign(msg))));
  checkThrows('Solana: prepared for account 1, active 0 → refused', () => deriveSignerFor(solanaKeyProvider, seed, 0, vectors.sol1), ACCOUNT_CHANGED_MESSAGE);
  check('non-EVM comparison is exact', !sameAccountAddress(SOL, vectors.sol1, vectors.sol1.toLowerCase()));
}

// ------------------------------------------------------------------ AA

console.log('check-accounts: ERC-4337 counterfactual per account (salt = account index)');
{
  const FACTORY = '0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985';
  const GET_ADDRESS = ethers.id('getAddress(address,uint256)').slice(0, 10);
  const CREATE_ACCOUNT = ethers.id('createAccount(address,uint256)').slice(0, 10);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  // FAKE factory: answers getAddress(owner, salt) with a real CREATE2
  // computation (ethers.getCreate2Address) over a stand-in init-code hash
  // that commits to the owner — the same shape as SimpleAccountFactory,
  // where the owner is inside the proxy's init code and salt is bytes32(salt).
  const calls = [];
  const fakeNode = async (method, params) => {
    if (method !== 'eth_call') throw new Error(`unexpected ${method}`);
    const { to, data } = params[0];
    calls.push(data);
    if (to.toLowerCase() !== FACTORY.toLowerCase() || !data.startsWith(GET_ADDRESS)) throw new Error('unexpected call');
    const [owner, salt] = coder.decode(['address', 'uint256'], '0x' + data.slice(10));
    const address = ethers.getCreate2Address(
      FACTORY,
      ethers.zeroPadValue(ethers.toBeHex(salt), 32),
      ethers.keccak256(coder.encode(['address'], [owner])),
    );
    return ethers.zeroPadValue(address, 32);
  };
  const bundleFor = (accountIndex) =>
    createAaClient({
      nodeUrl: 'https://node.example',
      bundlerUrl: 'https://bundler.example',
      factory: FACTORY,
      transportFor: () => fakeNode,
      ...(accountIndex === undefined ? {} : { accountIndex }),
    });
  const ownerOf = (address) => ({ address });

  // Account 0: before (the pre-change construction — spec with no salt)
  // vs after (createAaClient with and without accountIndex 0).
  const beforeSpec = createSimpleAccountSpec({ factory: FACTORY, node: fakeNode });
  calls.length = 0;
  const before = await beforeSpec.getAddress(ownerOf(vectors.evm0));
  const beforeCall = calls[0];
  calls.length = 0;
  const afterDefault = await bundleFor(undefined).spec.getAddress(ownerOf(vectors.evm0));
  const afterDefaultCall = calls[0];
  calls.length = 0;
  const after0 = await bundleFor(0).spec.getAddress(ownerOf(vectors.evm0));
  const after0Call = calls[0];
  check('account 0: counterfactual unchanged (before == after, accountIndex omitted)', before === afterDefault, `${before} vs ${afterDefault}`);
  check('account 0: counterfactual unchanged (before == after, accountIndex 0)', before === after0, `${before} vs ${after0}`);
  check('account 0: getAddress calldata byte-identical before/after', beforeCall === afterDefaultCall && beforeCall === after0Call);
  const handBuilt = GET_ADDRESS + coder.encode(['address', 'uint256'], [vectors.evm0, 0n]).slice(2);
  check('account 0: calldata == hand-built getAddress(owner0, 0)', after0Call.toLowerCase() === handBuilt.toLowerCase());

  calls.length = 0;
  const b1 = bundleFor(1);
  const sa1 = await b1.spec.getAddress(ownerOf(vectors.evm1));
  const [owner1, salt1] = coder.decode(['address', 'uint256'], '0x' + calls[0].slice(10));
  check('account 1: getAddress carries owner = account 1 EOA and salt = 1', owner1 === vectors.evm1 && salt1 === 1n);
  check('account 1: smart account differs from account 0', sa1 !== after0);
  const fa1 = await b1.spec.getFactoryArgs(ownerOf(vectors.evm1));
  const [fOwner, fSalt] = coder.decode(['address', 'uint256'], '0x' + toHex(fa1.factoryData).slice(10));
  check('account 1: deployment factoryData = createAccount(owner1, 1)',
    toHex(fa1.factoryData).startsWith(CREATE_ACCOUNT) && fOwner === vectors.evm1 && fSalt === 1n && fa1.factory === FACTORY);
  const fa0 = await bundleFor(0).spec.getFactoryArgs(ownerOf(vectors.evm0));
  const fa0Before = await beforeSpec.getFactoryArgs(ownerOf(vectors.evm0));
  check('account 0: deployment factoryData byte-identical before/after', toHex(fa0.factoryData) === toHex(fa0Before.factoryData));
  calls.length = 0;
  await bundleFor(2).spec.getAddress(ownerOf(vectors.evm2));
  check('account 2: salt = 2', coder.decode(['address', 'uint256'], '0x' + calls[0].slice(10))[1] === 2n);
  checkThrows('negative account index refused by createAaClient', () => bundleFor(-1), 'Invalid account index');
}

// -------------------------------------------------------- WalletConnect

console.log('check-accounts: WalletConnect session binding');
{
  const M = 'eip155:1';
  const A0 = vectors.evm0;
  const A1 = vectors.evm1;
  const labels = { [A0.toLowerCase()]: accountLabel('Account 1', A0), [A1.toLowerCase()]: accountLabel('Account 2', A1) };
  const labelFor = (address) => labels[address.toLowerCase()] ?? null;

  function fakeKit(sessions) {
    const handlers = new Map();
    const calls = { respond: [], reject: [] };
    return {
      calls,
      sessions,
      approveSession: async () => {},
      rejectSession: async (a) => void calls.reject.push(a),
      respondSessionRequest: async (a) => void calls.respond.push(a),
      disconnectSession: async () => {},
      pair: async () => {},
      getActiveSessions() {
        return this.sessions;
      },
      on(ev, fn) {
        if (!handlers.has(ev)) handlers.set(ev, new Set());
        handlers.get(ev).add(fn);
      },
      off(ev, fn) {
        handlers.get(ev)?.delete(fn);
      },
      async fire(ev, payload) {
        for (const fn of handlers.get(ev) ?? []) await fn(payload);
      },
    };
  }
  const session = (topic, address) => ({
    [topic]: {
      topic,
      peer: { metadata: { name: 'Uniswap', url: 'https://app.example' } },
      namespaces: { eip155: { accounts: [`${M}:${address}`], methods: ['personal_sign', 'eth_sendTransaction'] } },
    },
  });
  const sign = (id, address, topic = 'T0') => ({
    id,
    topic,
    params: { chainId: M, request: { method: 'personal_sign', params: ['0x68656c6c6f', address] } },
  });
  const sendTx = (id, topic = 'T0') => ({
    id,
    topic,
    // No `from`: previously accepted as "the wallet's account", so it
    // must now be bound through the session, not the active account.
    params: { chainId: M, request: { method: 'eth_sendTransaction', params: [{ to: A0, value: '0x1' }] } },
  });

  check('sessionAddressesOf reads the bound address', JSON.stringify(sessionAddressesOf(session('T0', A0).T0)) === JSON.stringify([A0]));
  check('sessionAddressesOf dedupes case-insensitively and ignores junk',
    JSON.stringify(sessionAddressesOf({ namespaces: { eip155: { accounts: [`${M}:${A0}`, `eip155:11155111:${A0.toLowerCase()}`, 'eip155:1:nope', 42] } } })) === JSON.stringify([A0]));
  check('summarizeSessions exposes the bound address', summarizeSessions(session('T0', A0))[0].addresses[0] === A0);

  const kit = fakeKit({ ...session('T0', A0), ...session('T1', A1) });
  const ctx = { address: A0, activeChain: M, labelFor };
  const ctl = new WcController(kit, () => ctx);
  ctl.attach();

  await kit.fire('session_request', sign(1, A0, 'T0'));
  check('bound account active → request queued', ctl.getSnapshot().queue.some((i) => i.key === 'r:1'));
  check('queued request records the bound address', ctl.getSnapshot().queue.find((i) => i.key === 'r:1').address === A0);

  await kit.fire('session_request', sign(2, A1, 'T1'));
  const r2 = kit.calls.respond.find((c) => c.response.id === 2);
  check('session bound to Account 2 while Account 1 active → declined 5103', r2?.response?.error?.code === WC_ERRORS.unsupportedAccounts.code && r2.response.error.code === 5103);
  check('  … message names the bound account ("This connection belongs to Account 2")',
    (r2?.response?.error?.message ?? '').includes('This connection belongs to Account 2 (0x6Fac…b9C0)'), r2?.response?.error?.message);
  check('  … and the notice says so too', (ctl.getSnapshot().notices[0]?.text ?? '').includes('belongs to Account 2'));
  check('  … not queued', !ctl.getSnapshot().queue.some((i) => i.key === 'r:2'));

  // Switch to Account 2 (index 1).
  ctx.address = A1;
  await kit.fire('session_request', sendTx(3, 'T0'));
  const r3 = kit.calls.respond.find((c) => c.response.id === 3);
  check('eth_sendTransaction without `from` on an Account 1 session while Account 2 active → declined 5103 (never signed by Account 2)',
    r3?.response?.error?.code === 5103 && !ctl.getSnapshot().queue.some((i) => i.key === 'r:3'));
  await kit.fire('session_request', sign(4, A1, 'T1'));
  check('Account 2 session served once Account 2 is active', ctl.getSnapshot().queue.some((i) => i.key === 'r:4' && i.address === A1));

  // Stale-account re-check at approval: r:1 arrived under Account 1.
  const head = ctl.begin('r:1');
  const stale = ctl.staleAccountError(head);
  check('switched after arrival → staleAccountError 5103 naming the bound account',
    stale?.code === 5103 && stale.message.includes('belongs to Account 1'), JSON.stringify(stale));
  ctl.release('r:1');
  ctx.address = A0;
  check('switched back → no stale-account error', ctl.staleAccountError(head) === null);
  check('staleAccountError is null for proposals', ctl.staleAccountError({ type: 'proposal' }) === null);

  // Unknown / accountless session → fail closed.
  await kit.fire('session_request', sign(5, A0, 'T-unknown'));
  const r5 = kit.calls.respond.find((c) => c.response.id === 5);
  check('request for a session with no known account → declined', r5?.response?.error?.code === 5103 && r5.response.error.message.includes('could not be determined'));

  check('sessionAccountNote: bound to the active account → null', sessionAccountNote([A0], A0, labelFor) === null);
  check('sessionAccountNote: bound elsewhere → paused note naming it', (sessionAccountNote([A1], A0, labelFor) ?? '').includes('belongs to Account 2'));
  check('accountMismatchMessage falls back to the raw address for unknown accounts',
    accountMismatchMessage(['0x' + '11'.repeat(20)], A0, labelFor).includes('0x' + '11'.repeat(20)));
}

seed.fill(0);

console.log('');
console.log('Verification vectors (standard test mnemonic):');
for (const [k, v] of Object.entries(vectors)) console.log(`  ${k.padEnd(6)} ${v}`);
console.log('');
console.log(`check-accounts: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
