// Phase 28 item 2: the Bitcoin slot on SIGNET (Settings → Developer → "Use
// Bitcoin signet"), OFFLINE. The signet network entry and its id against
// core's key provider and the sources' genesis prefix; the preference (off by
// default, only an explicit true); the slot mapping (off = exactly the old
// mapping, Dogecoin never moved); the signet address (coin type 1, an
// independent BIP-32 derivation, not the mainnet address re-encoded); the
// public-cache entry and the row the screens see (left out while unknown, never
// the mainnet address on signet); signing (the signet key only for a signet
// quote, the signer check refusing the other network's address); recipient
// validation (a mainnet address refused on signet and the reverse); signet
// never valued (no price id, no profit-and-loss button even for a slot still
// labelled mainnet); the Ordinals warning mainnet-only and the note on Bitcoin
// mainnet's form about the Ethereum banner (pass p27-emu2 finding 9); notes
// and the CSV keyed by the signet id; the screens' wiring (source pins); the
// strings. Ends with mutants written from scratch copies, each caught.
// No network request is made (the global fetch throws if anything tries).
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-btc-signet.mjs

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bech32 } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { bitcoinKeyProvider, bitcoinSignetKeyProvider, hash160 } from '@shiba-wallet/core';
import { BITCOIN_SIGNET } from '@shiba-wallet/chains-utxo';
import * as DEFAULTS from '../src/config/defaults.ts';
import * as PREFS from '../src/config/prefs.ts';
import * as NETWORKS from '../src/config/networks.ts';
import * as SIG from '../src/wallet/bitcoin-signet.ts';
import * as ACCOUNTS from '../src/wallet/accounts.ts';
import * as CHAINS from '../src/wallet/chains.ts';
import * as SEND from '../src/wallet/send.ts';
import * as PRICES from '../src/wallet/prices.ts';
import * as PNL from '../src/wallet/pnl.ts';
import * as PORTFOLIO from '../src/wallet/portfolio.ts';
import * as NOTES from '../src/wallet/notes.ts';
import * as HISTORY from '../src/wallet/history.ts';
import * as SOLACT from '../src/wallet/solana-activity.ts';
import * as INSIGHTS from '../src/wallet/insights.ts';
import * as CONTACTS from '../src/wallet/contacts.ts';
import { en } from '../src/i18n/en.ts';
import { es } from '../src/i18n/es.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
// The preferences' store key (wallet/store-keys.ts STORE_KEYS.prefs; config/prefs.ts keeps it private).
const { STORE_KEYS } = await import('../src/wallet/store-keys.ts');
const PREFS_STORE_KEY = STORE_KEYS.prefs.name;
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
const read = (rel) => readFileSync(join(HERE, '..', rel), 'utf8');

// No request may leave this suite.
let fetchCalls = 0;
globalThis.fetch = async () => {
  fetchCalls += 1;
  throw new Error('check-btc-signet makes no network request');
};

const BTC = 'bip122:000000000019d6689c085ae165831e93';
const DOGE = 'bip122:1a91e3dace36e2be3bf030a65679fe82';
const SOL = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const SIGNET = 'bip122:00000008819873e925422c1ff0f99f7c';
// bitcoin/bitcoin src/kernel/chainparams.cpp SigNetParams (line 539, read 2026-11-16).
const SIGNET_GENESIS = '00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6';

function memoryStore() {
  const map = new Map();
  return {
    map,
    getItem: async (k) => (map.has(k) ? map.get(k) : null),
    setItem: async (k, v) => {
      map.set(k, v);
    },
    removeItem: async (k) => {
      map.delete(k);
    },
  };
}

// ---------------------------------------------------------------------------
console.log('check-btc-signet: the signet network entry and its id');
// ---------------------------------------------------------------------------
check('the signet CAIP-2 id is the first 32 characters of signet\'s genesis block hash (the bip122 rule)',
  SIGNET === `bip122:${SIGNET_GENESIS.slice(0, 32)}`);
check('one id everywhere: config/defaults.ts, core\'s bitcoinSignetKeyProvider, wallet/accounts.ts and wallet/send.ts',
  DEFAULTS.BITCOIN_SIGNET_CAIP2 === SIGNET && bitcoinSignetKeyProvider.chainId === SIGNET &&
    read('src/wallet/accounts.ts').includes(`const BITCOIN_SIGNET_CAIP2 = '${SIGNET}';`) &&
    read('src/wallet/send.ts').includes(`const BITCOIN_SIGNET_CHAIN_ID = '${SIGNET}';`));
check('the Bitcoin slot id is one id too (defaults.ts BITCOIN_MAINNET_SLOT, send.ts BITCOIN_CHAIN_ID, pnl.ts PNL_BITCOIN_SLOT, the mainnet entry)',
  DEFAULTS.BITCOIN_MAINNET_SLOT === BTC && SEND.BITCOIN_CHAIN_ID === BTC && PNL.PNL_BITCOIN_SLOT === BTC &&
    DEFAULTS.DEFAULT_NETWORKS[1].chainId === BTC);
check('the entry: Esplora, 8 decimals, "test BTC", the two documented keyless endpoints in order, a test-funds note',
  DEFAULTS.BITCOIN_SIGNET_NETWORK.kind === 'esplora' && DEFAULTS.BITCOIN_SIGNET_NETWORK.decimals === 8 &&
    DEFAULTS.BITCOIN_SIGNET_NETWORK.symbol === 'test BTC' && DEFAULTS.BITCOIN_SIGNET_NETWORK.label === 'Bitcoin signet' &&
    DEFAULTS.BITCOIN_SIGNET_NETWORK.defaultUrls.join() === 'https://mempool.space/signet/api,https://blockstream.info/signet/api' &&
    DEFAULTS.BITCOIN_SIGNET_NETWORK.defaultUrl === 'https://mempool.space/signet/api' &&
    /not real funds/.test(DEFAULTS.BITCOIN_SIGNET_NETWORK.note ?? '') &&
    DEFAULTS.networkDefaultFor(SIGNET) === DEFAULTS.BITCOIN_SIGNET_NETWORK);
check('signet is not a launch chain: DEFAULT_NETWORKS and CHAINS keep four entries, none of them signet',
  DEFAULTS.DEFAULT_NETWORKS.length === 4 && !DEFAULTS.DEFAULT_NETWORKS.some((n) => n.chainId === SIGNET) &&
    CHAINS.CHAINS.length === 4 && !CHAINS.CHAINS.some((c) => c.provider.chainId === SIGNET));
check('signing finds signet\'s key provider by its id (chains.ts chainByCaip2), and mainnet\'s is unchanged',
  CHAINS.chainByCaip2(SIGNET)?.provider === bitcoinSignetKeyProvider && CHAINS.chainByCaip2(BTC)?.provider === bitcoinKeyProvider);

// ---------------------------------------------------------------------------
console.log('check-btc-signet: the preference and the slot mapping');
// ---------------------------------------------------------------------------
{
  check('default off', PREFS.DEFAULT_PREFS.bitcoinSignet === false);
  const store = memoryStore();
  const fresh = await PREFS.loadPrefs(store);
  await store.setItem(PREFS_STORE_KEY, JSON.stringify({ bitcoinSignet: true }));
  const explicitTrue = await PREFS.loadPrefs(store);
  await store.setItem(PREFS_STORE_KEY, JSON.stringify({ bitcoinSignet: 'true' }));
  const odd = await PREFS.loadPrefs(store);
  await store.setItem(PREFS_STORE_KEY, JSON.stringify({ bitcoinSignet: 1 }));
  const odd2 = await PREFS.loadPrefs(store);
  const saved = await PREFS.savePrefs({ bitcoinSignet: true }, store);
  const reread = await PREFS.loadPrefs(store);
  check('only an explicit stored true reads as on ("true" and 1 read as off); saved true reads back true; other preferences untouched',
    fresh.bitcoinSignet === false && explicitTrue.bitcoinSignet === true && odd.bitcoinSignet === false && odd2.bitcoinSignet === false &&
      saved.bitcoinSignet === true && reread.bitcoinSignet === true && reread.solanaDevnet === false && reread.testNetwork === null);
}
{
  const selections = [null, false, true, 'eip155:11155111', 'eip155:84532'];
  const same = selections.every((sel) =>
    [false, true].every((devnet) =>
      JSON.stringify(DEFAULTS.resolveActiveNetworks(sel, devnet, false)) === JSON.stringify(DEFAULTS.resolveActiveNetworks(sel, devnet))));
  check('switch off: the mapping is exactly the old one for every EVM choice and either Solana choice', same);
  const on = DEFAULTS.resolveActiveNetworks('eip155:11155111', true, true);
  const off = DEFAULTS.resolveActiveNetworks('eip155:11155111', true, false);
  const at = (mode, slot) => mode.find((e) => e.slot === slot).network;
  check('switch on: only the Bitcoin slot moves, to signet; Dogecoin, the EVM slot and the Solana slot are untouched',
    at(on, BTC) === DEFAULTS.BITCOIN_SIGNET_NETWORK && at(off, BTC).chainId === BTC &&
      at(on, DOGE) === at(off, DOGE) && at(on, 'eip155:1') === at(off, 'eip155:1') && at(on, SOL) === at(off, SOL) &&
      on.map((e) => e.slot).join() === off.map((e) => e.slot).join());
}
{
  // getEndpoint with overrides (an override is never probed): the slot resolves to signet's network with the switch on.
  const store = memoryStore();
  await NETWORKS.setEndpointOverride(SIGNET, 'https://signet.example.invalid/api', { store });
  await NETWORKS.setEndpointOverride(BTC, 'https://mainnet.example.invalid/api', { store });
  const offEp = await NETWORKS.getEndpoint(BTC, { store });
  await PREFS.savePrefs({ bitcoinSignet: true }, store);
  const onEp = await NETWORKS.getEndpoint(BTC, { store });
  const bySignetId = await NETWORKS.getEndpoint(SIGNET, { store });
  check('getEndpoint(Bitcoin slot): mainnet and its own override with the switch off; signet and signet\'s own override with it on (the two override slots never mix)',
    offEp?.network.chainId === BTC && offEp?.url === 'https://mainnet.example.invalid/api' &&
      onEp?.network.chainId === SIGNET && onEp?.url === 'https://signet.example.invalid/api' && bySignetId?.network.chainId === SIGNET);
}

// ---------------------------------------------------------------------------
console.log('check-btc-signet: the signet address (coin type 1)');
// ---------------------------------------------------------------------------
const SEED = new Uint8Array(64).map((_, i) => (i * 37 + 11) & 0xff);
const ref = (account) => {
  const node = HDKey.fromMasterSeed(SEED).derive(`m/84'/1'/${account}'/0/0`);
  return bech32.encode('tb', [0, ...bech32.toWords(hash160(node.publicKey))]);
};
const s0 = SIG.deriveSignetAddress(SEED, 0);
const s3 = SIG.deriveSignetAddress(SEED, 3);
check('account 0 and account 3: m/84\'/1\'/N\'/0/0 (the Bitcoin account mapping with coin type 1), equal to an independent @scure/bip32 derivation encoded with HRP tb',
  s0.path === "m/84'/1'/0'/0/0" && s3.path === "m/84'/1'/3'/0/0" && s0.address === ref(0) && s3.address === ref(3) && s0.address.startsWith('tb1q'));
const main0 = ACCOUNTS.deriveForAccount(bitcoinKeyProvider, SEED, 0).address;
const program = (a) => Buffer.from(bech32.fromWords(bech32.decode(a).words.slice(1))).toString('hex');
check('not the mainnet address re-encoded: a different key (the mainnet address\'s program differs)', program(main0) !== program(s0.address));
check('derivationArgsFor gives signet Bitcoin\'s account mapping (account N, address index 0)',
  JSON.stringify(ACCOUNTS.derivationArgsFor(SIGNET, 5)) === JSON.stringify({ account: 5, addressIndex: 0 }));
{
  const ok = ACCOUNTS.deriveSignerFor(bitcoinSignetKeyProvider, SEED, 0, s0.address);
  let refusedMain = false;
  try {
    ACCOUNTS.deriveSignerFor(bitcoinSignetKeyProvider, SEED, 0, main0);
  } catch (e) {
    refusedMain = e.message === ACCOUNTS.ACCOUNT_CHANGED_MESSAGE;
  }
  let refusedSignetOnMain = false;
  try {
    ACCOUNTS.deriveSignerFor(bitcoinKeyProvider, SEED, 0, s0.address);
  } catch (e) {
    refusedSignetOnMain = e.message === ACCOUNTS.ACCOUNT_CHANGED_MESSAGE;
  }
  check('the signer check: the signet key signs only for the signet address; a mainnet quote cannot be signed with it, nor a signet quote with the mainnet key',
    ok.address === s0.address && refusedMain && refusedSignetOnMain);
  check('the sign chain: signet only for a Bitcoin-slot quote whose endpoint is signet\'s; every other case the route\'s id',
    SIG.utxoSignChainFor(BTC, SIGNET) === SIGNET && SIG.utxoSignChainFor(BTC, BTC) === BTC && SIG.utxoSignChainFor(BTC, undefined) === BTC &&
      SIG.utxoSignChainFor(DOGE, SIGNET) === DOGE);
}

// ---------------------------------------------------------------------------
console.log('check-btc-signet: the public cache and the row the screens see');
// ---------------------------------------------------------------------------
{
  const entry = SIG.signetCacheEntry(s0);
  check('the cache entry is the signet id, address and path, and reads back', entry.chainId === SIGNET &&
    JSON.stringify(SIG.signetAddressFromCache([{ chainId: BTC, address: main0, path: "m/84'/0'/0'/0/0" }, entry])) === JSON.stringify(s0));
  check('a missing or malformed signet entry reads as unknown (a bc1 address, a coin-type-0 path, no entry, null)',
    SIG.signetAddressFromCache([{ chainId: SIGNET, address: main0, path: s0.path }]) === null &&
      SIG.signetAddressFromCache([{ chainId: SIGNET, address: s0.address, path: "m/84'/0'/0'/0/0" }]) === null &&
      SIG.signetAddressFromCache([{ chainId: BTC, address: main0, path: "m/84'/0'/0'/0/0" }]) === null && SIG.signetAddressFromCache(null) === null);
  const rows = [
    { chainId: 'eip155:1', name: 'Ethereum', symbol: 'ETH', accent: '#1', address: '0x0000000000000000000000000000000000000001', path: "m/44'/60'/0'/0/0" },
    { chainId: BTC, name: 'Bitcoin', symbol: 'BTC', accent: '#2', address: main0, path: "m/84'/0'/0'/0/0" },
    { chainId: DOGE, name: 'Dogecoin', symbol: 'DOGE', accent: '#3', address: 'D', path: "m/44'/3'/0'/0/0" },
  ];
  const off = SIG.withBitcoinSignetRow(rows, false, s0);
  check('switch off: the same rows (the same array), never pending', off.rows === rows && off.pending === false);
  const on = SIG.withBitcoinSignetRow(rows, true, s0);
  const btcOn = on.rows.find((r) => r.chainId === BTC);
  check('switch on, address known: the Bitcoin row keeps its slot id and carries the signet address, path, "Bitcoin signet" and "test BTC"; every other row identical',
    btcOn.address === s0.address && btcOn.path === s0.path && btcOn.name === 'Bitcoin signet' && btcOn.symbol === 'test BTC' &&
      on.rows[0] === rows[0] && on.rows[2] === rows[2] && on.pending === false);
  const pending = SIG.withBitcoinSignetRow(rows, true, undefined);
  check('switch on, address unknown: the Bitcoin row is left out (the mainnet address is never shown or queried on signet) and pending is true',
    pending.pending === true && !pending.rows.some((r) => r.chainId === BTC) && !pending.rows.some((r) => r.address === main0) && pending.rows.length === 2);
  const imported = [rows[0]];
  const imp = SIG.withBitcoinSignetRow(imported, true, undefined);
  check('an account with no Bitcoin row (imported, watch-only, multisig) is unchanged and never pending', imp.rows === imported && imp.pending === false);
  check('the badge keeps three letters ("test BTC" → "BTC"); other symbols unchanged',
    SIG.badgeSymbol('test BTC') === 'BTC' && SIG.badgeSymbol('BTC') === 'BTC' && SIG.badgeSymbol('SOL') === 'SOL');
  // Portfolio's non-active accounts, from the cache.
  const cached = [rows[0], rows[1], rows[2], SIG.signetCacheEntry(s0)];
  const oldMapping = Object.fromEntries(cached.slice(0, 3).filter((c) => c.chainId !== 'eip155:1').map((c) => [c.chainId, c.address]));
  check('Portfolio, switch off: exactly the old mapping from the cache (the signet entry never appears under its own id)',
    JSON.stringify(SIG.cachedSlotAddresses(cached, { bitcoinSignet: false, evmSlot: 'eip155:1' })) === JSON.stringify(oldMapping));
  check('Portfolio, switch on: the Bitcoin slot carries the cached signet address; without one it is left out, never the mainnet address',
    SIG.cachedSlotAddresses(cached, { bitcoinSignet: true, evmSlot: 'eip155:1' })[BTC] === s0.address &&
      !(BTC in SIG.cachedSlotAddresses(cached.slice(0, 3), { bitcoinSignet: true, evmSlot: 'eip155:1' })) &&
      SIG.cachedSlotAddresses(cached.slice(0, 3), { bitcoinSignet: true, evmSlot: 'eip155:1' })[DOGE] === 'D' &&
      SIG.cachedSlotAddresses(null, { bitcoinSignet: true, evmSlot: 'eip155:1' }) === null);
}

// ---------------------------------------------------------------------------
console.log('check-btc-signet: recipients, the UTXO network and links');
// ---------------------------------------------------------------------------
{
  const v1 = SEND.validateRecipient(SIGNET, s0.address);
  const v2 = SEND.validateRecipient(SIGNET, main0);
  const v3 = SEND.validateRecipient(BTC, s0.address);
  check('a signet (tb1) address is accepted on signet; a mainnet (bc1) address is refused there naming "Bitcoin signet"; a tb1 address is refused on mainnet',
    v1.ok === true && v2.ok === false && /^Bitcoin signet: segwit address/.test(v2.error) && v3.ok === false && /^Bitcoin: segwit address/.test(v3.error));
  check('the UTXO network follows the endpoint: signet\'s parameters (the engine\'s BITCOIN_SIGNET) only on signet\'s endpoint',
    SIG.utxoNetworkForEndpoint(SIGNET, { name: 'x' }) === BITCOIN_SIGNET && SIG.utxoNetworkForEndpoint(BTC, BITCOIN_SIGNET) === BITCOIN_SIGNET &&
      SIG.utxoNetworkForEndpoint(BTC, { name: 'main' }).name === 'main' && BITCOIN_SIGNET.bech32Hrp === 'tb');
  check('no explorer link for a signet transaction (none verified); mainnet\'s blockstream.info link unchanged',
    HISTORY.explorerTxUrl(SIGNET, 'ab') === null && HISTORY.explorerTxUrl(BTC, 'ab') === 'https://blockstream.info/tx/ab');
  const sendSrc = read('src/wallet/send.ts');
  check('sendUtxo builds its link from the chain id it is given (the sign chain), so a signet send gets no mainnet link',
    sendSrc.includes("chainId === BITCOIN_CHAIN_ID ? `https://blockstream.info/tx/${txid}` : null;"));
}

// ---------------------------------------------------------------------------
console.log('check-btc-signet: signet is never valued');
// ---------------------------------------------------------------------------
{
  check('no price id for the Bitcoin slot served by signet; mainnet\'s unchanged',
    PRICES.nativePriceAssetId(BTC, SIGNET) === null && PRICES.nativePriceAssetId(BTC, BTC) !== null);
  const on = PRICES.nativePriceIds(false, false, true);
  const off = PRICES.nativePriceIds(false, false, false);
  check('Home\'s price ids: the Bitcoin position is null with the switch on and BTC\'s id with it off; the others identical',
    on[1] === null && off[1] !== null && on[0] === off[0] && on[2] === off[2] && on[3] === off[3] &&
      JSON.stringify(off) === JSON.stringify(PRICES.nativePriceIds(false, false)));
  const EVM = { caip2: 'eip155:1', label: 'Ethereum', displaySymbol: 'ETH', testnet: false };
  const slotsOn = PORTFOLIO.portfolioSlotsFor(DEFAULTS.resolveActiveNetworks(null, false, true), EVM);
  const btcSlot = slotsOn.find((x) => x.slot === BTC);
  check('Portfolio\'s Bitcoin slot on signet: "Bitcoin signet", "test BTC", a test network',
    btcSlot.networkChainId === SIGNET && btcSlot.label === 'Bitcoin signet' && btcSlot.symbol === 'test BTC' && btcSlot.testnet === true);
  const ALL = ['eip155:1', BTC, DOGE, SOL];
  const offer = PNL.pnlNativeOffer(slotsOn, { solanaDevnet: false, bitcoinSignet: true, accountSlots: ALL });
  // A Bitcoin slot still labelled as MAINNET while the switch is on (the F-94 shape): withheld anyway, with the sentence.
  const oldShape = PORTFOLIO.portfolioSlotsFor(DEFAULTS.resolveActiveNetworks(null, false, false), EVM);
  const guard = PNL.pnlNativeOffer(oldShape, { solanaDevnet: false, bitcoinSignet: true, accountSlots: ALL });
  const plain = PNL.pnlNativeOffer(oldShape, { solanaDevnet: false, bitcoinSignet: false, accountSlots: ALL });
  check('profit and loss never offers BTC while signet is on (even for a slot still labelled mainnet) and says why; off, BTC is offered as before',
    !offer.slots.some((x) => x.slot === BTC) && offer.bitcoinSignetNote === true &&
      !guard.slots.some((x) => x.slot === BTC) && guard.bitcoinSignetNote === true &&
      plain.slots.some((x) => x.slot === BTC) && plain.bitcoinSignetNote === false &&
      JSON.stringify(PNL.pnlNativeOffer(oldShape, { solanaDevnet: false, accountSlots: ALL })) === JSON.stringify(plain));
}

// ---------------------------------------------------------------------------
console.log('check-btc-signet: the Ordinals warning and the mainnet send note');
// ---------------------------------------------------------------------------
check('the Ordinals / Runes warning stays Bitcoin MAINNET only: none on signet',
  SEND.bitcoinAssetsWarningShown(BTC, SIGNET) === false && SEND.bitcoinAssetsWarningShown(BTC, BTC) === true &&
    SEND.bitcoinAssetsWarningShown(DOGE, DOGE) === false);
check('the note about the Ethereum banner: only on Bitcoin mainnet\'s form while the Ethereum test banner is up; never on signet, Dogecoin or Solana',
  SIG.bitcoinMainnetSendNoteShown(BTC, BTC, true) === true && SIG.bitcoinMainnetSendNoteShown(BTC, BTC, false) === false &&
    SIG.bitcoinMainnetSendNoteShown(BTC, SIGNET, true) === false && SIG.bitcoinMainnetSendNoteShown(DOGE, DOGE, true) === false &&
    SIG.bitcoinMainnetSendNoteShown(SOL, SOL, true) === false && SIG.bitcoinMainnetSendNoteShown(BTC, undefined, true) === false);
check('the banner: only on the Bitcoin slot with the switch on',
  SIG.bitcoinSignetBannerShown(BTC, true) && !SIG.bitcoinSignetBannerShown(BTC, false) && !SIG.bitcoinSignetBannerShown(DOGE, true) &&
    !SIG.bitcoinSignetBannerShown(undefined, true));

// ---------------------------------------------------------------------------
console.log('check-btc-signet: notes and the CSV are keyed by the signet id');
// ---------------------------------------------------------------------------
{
  const slot = (bitcoinSignet) => SOLACT.activitySlotNetwork(BTC, { evmSlot: false, evmCaip2: 'eip155:1', solanaDevnet: false, bitcoinSignet });
  check('the Bitcoin slot\'s Activity network: signet\'s id with the switch on; mainnet\'s with it off or absent; Dogecoin and Solana untouched',
    slot(true) === SIGNET && slot(false) === BTC &&
      SOLACT.activitySlotNetwork(BTC, { evmSlot: false, evmCaip2: 'eip155:1', solanaDevnet: false }) === BTC &&
      SOLACT.activitySlotNetwork(DOGE, { evmSlot: false, evmCaip2: 'eip155:1', solanaDevnet: false, bitcoinSignet: true }) === DOGE &&
      SOLACT.activitySlotNetwork(SOL, { evmSlot: false, evmCaip2: 'eip155:1', solanaDevnet: false, bitcoinSignet: true }) === SOL);
  const TXID = 'ab'.repeat(32);
  const store = memoryStore();
  // The Send screen saves a note under endpoint.network.chainId (signet's id on signet).
  await NOTES.saveNote(SIGNET, { txid: TXID }, 'p28 signet note', { store });
  const index = NOTES.indexNotes((await NOTES.loadNotes(store)).notes);
  check('a note saved on signet shows on the signet Activity row and not on mainnet\'s', NOTES.normalizeTxId(SIGNET, TXID) === TXID &&
    NOTES.findNote(index, slot(true), TXID, [])?.text === 'p28 signet note' && NOTES.findNote(index, slot(false), TXID, []) === null);
  const fileName = NOTES.activityExportFileName(slot(true), s0.address, new Date('2026-11-16T12:00:00Z'));
  check('the CSV file name carries the signet id', fileName.startsWith('shiba-activity_bip122-00000008819873e925422c1ff0f99f7c_tb1q') && fileName.endsWith('_2026-11-16.csv'), fileName);
}

// ---------------------------------------------------------------------------
console.log('check-btc-signet: the risk overview and the strings');
// ---------------------------------------------------------------------------
{
  const ctx = { evm: { caip2: 'eip155:1', label: 'Ethereum', testnet: false }, solanaDevnet: false };
  const on = INSIGHTS.networkSection({ ...ctx, bitcoinSignet: true });
  const off = INSIGHTS.networkSection(ctx);
  check('the risk overview\'s network section adds the signet line with the switch on, and is unchanged without it',
    on.lines.some((l) => l.text === en['insights.network.btcSignet']) && JSON.stringify(off) === JSON.stringify(INSIGHTS.networkSection({ ...ctx, bitcoinSignet: false })) &&
      !off.lines.some((l) => l.text === en['insights.network.btcSignet']));
  const IDS = ['settings.btcSignet.label', 'settings.btcSignet.offNote', 'settings.btcSignet.onNote', 'banner.btcSignet', 'home.btcSignet.cardLine',
    'home.btcSignet.pending', 'home.btcSignet.derive', 'home.btcSignet.deriveFailed', 'receive.btcSignet.pending', 'send.btc.mainnetNote',
    'pnl.btcSignet', 'insights.network.btcSignet'];
  const ph = (x) => (x.match(/\{[a-z]+\}/gi) ?? []).sort().join(',');
  check('the twelve ids exist with a Spanish draft keeping the placeholders', IDS.every((id) => typeof en[id] === 'string' && typeof es[id] === 'string' && es[id] !== en[id] && ph(es[id]) === ph(en[id])));
  check('the texts that carry a claim, English exact',
    en['banner.btcSignet'] === 'TESTNET — Bitcoin signet is on. Amounts are test BTC, not real funds.' &&
      en['pnl.btcSignet'] === 'Profit and loss for BTC is not offered while Bitcoin signet is on: signet BTC has no price.' &&
      en['send.btc.mainnetNote'] === 'This send is on Bitcoin mainnet, with real funds. The TESTNET banner at the bottom of the screen is about the Ethereum network chosen in Settings → Developer, not about this send.' &&
      en['settings.btcSignet.onNote'].includes("m/84'/1'/N'/0/0") && en['home.btcSignet.pending'].includes('Nothing is signed.'));
  check('the device prompt title stays English and names what it is for', SIG.BITCOIN_SIGNET_DERIVE_PROMPT === 'Work out your Bitcoin signet addresses');
}

// ---------------------------------------------------------------------------
console.log('check-btc-signet: the screens\' wiring (source)');
// ---------------------------------------------------------------------------
const settings = read('src/screens/SettingsScreen.tsx');
const home = read('src/screens/HomeScreen.tsx');
const receive = read('src/screens/ReceiveScreen.tsx');
const sendScreen = read('src/screens/SendScreen.tsx');
const activity = read('src/screens/ActivityScreen.tsx');
const wallet = read('src/wallet/WalletContext.tsx');
const portfolioScreen = read('src/screens/PortfolioScreen.tsx');
const views = read('src/screens/PortfolioViews.tsx');
const wiredSend = (src) =>
  src.includes('const recipientChainId = bitcoinSignetNetworkFor(route.params.chainId, bitcoinSignet)?.chainId ?? route.params.chainId;') &&
  // A typed address is validated for the slot's network; an ENS name resolves
  // only on the EVM slot (check-names pins that branch), so its address keeps
  // the route's id, which is never the Bitcoin slot there.
  src.includes('validateRecipient(recipientChainId, recipient)') &&
  src.includes('validateRecipient(route.params.chainId, nameResolvedAddress)') &&
  !src.includes('validateRecipient(route.params.chainId, recipient)') &&
  src.includes("const signChainId = quote.kind === 'utxo' ? utxoSignChainFor(route.params.chainId, endpoint?.network.chainId) : route.params.chainId;") &&
  src.includes('const sent = await signWith(signChainId, quotedFrom, async (signer) => {') &&
  src.includes('return sendUtxo(sendUrl, signChainId, signer, quote, utxoOptions);') &&
  src.includes('prepareUtxoSend(ep.url, utxoNetworkFor(ep), account.address, recipientAddress, amount, utxoOptionsFor(ep)),') &&
  src.includes('maxUtxoSend(ep.url, utxoNetworkFor(ep), account.address, normalized, utxoOptionsFor(ep)),') &&
  src.includes('|| network?.chainId === BITCOIN_SIGNET_CAIP2;') &&
  (src.match(/<BitcoinSignetBanner chainId=\{route\.params\.chainId\} \/>/g) ?? []).length === 3 &&
  src.includes('{bitcoinMainnetSendNoteShown(route.params.chainId, network?.chainId, sepolia) ? (') &&
  src.includes('const contactsNetworkId = endpoint && endpoint.network.chainId !== BITCOIN_SIGNET_CAIP2 ? endpoint.network.chainId : null;') &&
  // Contacts are not stored for signet (validateContactAddress refuses its id), so none are offered there.
  !CONTACTS.CONTACT_NETWORK_IDS.includes(SIGNET);
check('Send: the recipient validated for the slot\'s network, the UTXO network from the endpoint, the signet key only for a signet quote, the banner on the form, confirm and success, the mainnet note, no contacts offered on signet', wiredSend(sendScreen));
check('…mutant caught: Send validating against the route\'s mainnet id again',
  !wiredSend(sendScreen.replace('validateRecipient(recipientChainId, recipient)', 'validateRecipient(route.params.chainId, recipient)')));
check('…mutant caught: Send signing a UTXO quote with the route\'s id again',
  !wiredSend(sendScreen.replace('const sent = await signWith(signChainId, quotedFrom,', 'const sent = await signWith(route.params.chainId, quotedFrom,')));
const wiredWallet = (src) =>
  src.includes('withBitcoinSignetRow(derived[activeIndex] ?? [], bitcoinSignet, signet[activeIndex])') &&
  src.includes('const accounts = signetView.rows;') &&
  (src.match(/derivePublic\(mnemonic, (derivedIndices\(state\)|missing|\[0\]|indices), (freshSignet|signetFound|added)\);/g) ?? []).length === 5 &&
  src.includes('await savePublicAccount(Number(index), sig ? [...entries, signetCacheEntry(sig)] : entries)') &&
  src.includes('const mnemonic = await readPhrase(BITCOIN_SIGNET_DERIVE_PROMPT);') &&
  (src.match(/setSignet\(\{\}\);/g) ?? []).length === 3 &&
  // hydratePublic still reads the four launch chains only.
  src.includes('for (const { provider, symbol, accent } of CHAINS) {\n    const entry = entries.find((e) => e.chainId === provider.chainId);');
check('WalletContext: the rows through withBitcoinSignetRow, the signet address derived with every derivation that caches, the cache entry written, one prompt to work it out, cleared on every wipe and profile switch', wiredWallet(wallet));
check('…mutant caught: the rows exposed without the signet substitution',
  !wiredWallet(wallet.replace('const accounts = signetView.rows;', 'const accounts = derived[activeIndex] ?? [];')));
check('Settings: the switch with its notes, after the Solana devnet switch',
  settings.includes('onValueChange={(v) => void setBitcoinSignet(v)}') && settings.includes('{bitcoinSignet ? bitcoinSignetText.onNote() : bitcoinSignetText.offNote()}') &&
    settings.indexOf('setBitcoinSignet(v)') > settings.indexOf('setSolanaDevnet(v)'));
check('Home: the reload key, the price ids and the card line follow the switch; the pending card offers the one action; the badge keeps three letters',
  home.includes("`${evmChain.caip2}${solanaDevnet ? '|solana-devnet' : ''}${bitcoinSignet ? '|bitcoin-signet' : ''}`") &&
    home.includes('...nativePriceIds(sepolia, solanaDevnet, bitcoinSignet),') &&
    home.includes('<BitcoinSignetPendingCard onDerive={deriveBitcoinSignetAddresses} />') &&
    home.includes('{badgeSymbol(item.symbol)}</Text>'));
check('Receive and Activity: the banner, the badge, the pending sentence; Activity\'s network, links and notes keyed by signet',
  receive.includes('<BitcoinSignetBanner chainId={route.params.chainId} />') && receive.includes('bitcoinSignetText.receivePending()') &&
    receive.includes('{badgeSymbol(account.symbol)}</Text>') &&
    activity.includes('<BitcoinSignetBanner chainId={chainId} />') &&
    activity.includes('const explorerChainId = solanaDevnetSlot ? SOLANA_DEVNET_CAIP2 : btcSignetSlot ? BITCOIN_SIGNET_CAIP2 : chainId;') &&
    activity.includes('const testnet = (isEvmSlot && evmChain.testnet) || solanaDevnetSlot || btcSignetSlot;') &&
    activity.includes('activitySlotNetwork(chainId, { evmSlot: isEvmSlot, evmCaip2: evmChain.caip2, solanaDevnet, bitcoinSignet })'));
check('Portfolio: slots, non-active accounts and the profit-and-loss offer follow the switch',
  portfolioScreen.includes('portfolioSlotsFor(resolveActiveNetworks(null, solanaDevnet, bitcoinSignet), {') &&
    portfolioScreen.includes('otherAddresses = cachedSlotAddresses(cached, { bitcoinSignet: args.bitcoinSignet, evmSlot: EVM_CHAIN_ID });') &&
    views.includes('pnlNativeOffer(slots, { solanaDevnet, bitcoinSignet, accountSlots: accounts.map((a) => a.chainId) })') &&
    views.includes("{offer.bitcoinSignetNote ? <Text style={[styles.hint, { color: theme.textMuted }]}>{t('pnl.btcSignet')}</Text> : null}"));
check('the readiness switchboard has no signet row (a signet send is the ordinary Bitcoin send of valueless coins)',
  !read('src/config/readiness.ts').includes('signet'));

// ---------------------------------------------------------------------------
console.log('check-btc-signet: mutants from scratch copies');
// ---------------------------------------------------------------------------
const MUTANT_DIR = join(HERE, `.mutants-btc-signet-${process.pid}`);
let mutantCount = 0;
process.on('exit', () => rmSync(MUTANT_DIR, { recursive: true, force: true }));
async function importMutant(from, to, relPath) {
  const original = readFileSync(join(HERE, '..', relPath), 'utf8');
  if (!original.includes(from)) throw new Error(`mutation anchor not found: ${from}`);
  const source = original.replace(from, to);
  const originalDir = dirname(join(HERE, '..', relPath));
  const rewritten = source.replace(/(from\s+)'(\.{1,2}\/[^']+)'/g, (_m, kw, spec) => `${kw}'${pathToFileURL(resolvePath(originalDir, spec)).href}'`);
  mkdirSync(MUTANT_DIR, { recursive: true });
  mutantCount += 1;
  const file = join(MUTANT_DIR, `m${mutantCount}-${relPath.split('/').pop()}`);
  writeFileSync(file, rewritten);
  return import(pathToFileURL(file).href);
}
let caught = 0;
const mutant = (name, ok) => {
  if (ok) caught += 1;
  check(`mutant caught: ${name}`, ok);
};
{
  const rows = [{ chainId: BTC, name: 'Bitcoin', symbol: 'BTC', accent: '', address: main0, path: "m/84'/0'/0'/0/0" }];
  const m1 = await importMutant('  if (!signet) return { rows: rows.filter((_, i) => i !== at), pending: true };', '  if (!signet) return { rows, pending: false };', 'src/wallet/bitcoin-signet.ts');
  const r1 = m1.withBitcoinSignetRow(rows, true, undefined);
  mutant('the mainnet row kept on signet while the signet address is unknown', r1.rows.some((r) => r.address === main0) && !r1.pending);

  const m2 = await importMutant('  const bitcoinWithheld = (s: S) => options.bitcoinSignet === true && s.slot === PNL_BITCOIN_SLOT;', '  const bitcoinWithheld = (_s: S) => false;', 'src/wallet/pnl.ts');
  const EVM = { caip2: 'eip155:1', label: 'Ethereum', displaySymbol: 'ETH', testnet: false };
  const oldShape = PORTFOLIO.portfolioSlotsFor(DEFAULTS.resolveActiveNetworks(null, false, false), EVM);
  mutant('the signet rule removed from profit and loss (a Bitcoin slot still labelled mainnet valued while signet is on)',
    m2.pnlNativeOffer(oldShape, { solanaDevnet: false, bitcoinSignet: true, accountSlots: ['eip155:1', BTC] }).slots.some((x) => x.slot === BTC));

  const m3 = await importMutant('          : n.chainId === BITCOIN_MAINNET_SLOT && bitcoinSignet', '          : n.kind !== \'evm-jsonrpc\' && bitcoinSignet', 'src/config/defaults.ts');
  const r3 = m3.resolveActiveNetworks(null, false, true);
  mutant('the switch moving every non-EVM slot (Dogecoin and Solana served by signet)', r3.find((e) => e.slot === DOGE).network.chainId === SIGNET);

  const m4 = await importMutant('  if (chainId === BITCOIN_SIGNET_CHAIN_ID) return BITCOIN_SIGNET;\n', '', 'src/wallet/send.ts');
  mutant('send.ts without signet\'s recipient parameters (a signet address refused on signet)', m4.validateRecipient(SIGNET, s0.address).ok === false);

  const m5 = await importMutant('  return routeChainId === BITCOIN_CHAIN_ID && endpointChainId === BITCOIN_CHAIN_ID;', '  return routeChainId === BITCOIN_CHAIN_ID;', 'src/wallet/send.ts');
  mutant('the Ordinals warning keyed on the route only (shown on signet)', m5.bitcoinAssetsWarningShown(BTC, SIGNET) === true);

  const m6 = await importMutant('  if (routeChainId === BITCOIN_MAINNET_SLOT && options.bitcoinSignet === true) return BITCOIN_SIGNET_CAIP2;\n', '', 'src/wallet/solana-activity.ts');
  mutant('Activity keying signet notes by the mainnet id', m6.activitySlotNetwork(BTC, { evmSlot: false, evmCaip2: 'eip155:1', solanaDevnet: false, bitcoinSignet: true }) === BTC);

  const m7 = await importMutant('    else delete out[BITCOIN_MAINNET_SLOT];', '', 'src/wallet/bitcoin-signet.ts');
  const cachedNoSignet = [{ chainId: BTC, address: main0, path: "m/84'/0'/0'/0/0" }];
  mutant('Portfolio falling back to the mainnet address on signet', m7.cachedSlotAddresses(cachedNoSignet, { bitcoinSignet: true, evmSlot: 'eip155:1' })[BTC] === main0);

  const m8 = await importMutant('    bitcoinSignet: p.bitcoinSignet === true,', '    bitcoinSignet: Boolean(p.bitcoinSignet),', 'src/config/prefs.ts');
  const store = memoryStore();
  await store.setItem(PREFS_STORE_KEY, JSON.stringify({ bitcoinSignet: 'true' }));
  mutant('the preference reading a stored "true" string as on', (await m8.loadPrefs(store)).bitcoinSignet === true);

  const m9 = await importMutant('  return routeChainId === BITCOIN_MAINNET_SLOT && endpointChainId === BITCOIN_SIGNET_CAIP2 ? BITCOIN_SIGNET_CAIP2 : routeChainId;', '  return routeChainId;', 'src/wallet/bitcoin-signet.ts');
  mutant('a signet quote signed for the mainnet chain', m9.utxoSignChainFor(BTC, SIGNET) === BTC);

  const m10 = await importMutant("  if (chainId === BITCOIN_SIGNET_CAIP2) return BITCOIN_SIGNET_NETWORK;\n", '', 'src/config/defaults.ts');
  mutant('networkDefaultFor not knowing signet (Activity would fall back to nothing)', m10.networkDefaultFor(SIGNET) === undefined);
  check(`all ${mutantCount} mutants caught`, caught === mutantCount);
}

check('no network request was made by this suite', fetchCalls === 0, `${fetchCalls} fetch calls`);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
