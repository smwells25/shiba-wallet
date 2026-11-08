// Phase 24 item 1, the app half of the Solana token layer (feature 43):
// pins the Solana tracked-token lists, the Solana devnet network entry and
// preference, the Track prompt, the Home rows, the readiness gate
// 'spl-tokens', the send's confirm rows and its one-prompt path — all
// OFFLINE, through the exact modules the app runs (wallet/spl-tokens.ts,
// wallet/tokens.ts, config/defaults.ts, config/prefs.ts) and a fake Solana
// RPC that answers from the recorded devnet fixture
// packages/chains-solana/test/fixtures/devnet-token-accounts-2026-11-07.json
// (Circle's devnet USDC mint and Paxos's devnet PYUSD mint, real bytes read on
// 2026-11-07) plus token accounts and mints this script builds from the
// documented layouts. Every refusal sentence is compared byte for byte with
// the engine's own constants. Nothing touches a network.
//
// Run from the app directory:
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-spl-tokens.mjs
//
// The keys derive from the standard BIP-39 test mnemonic ("abandon ...
// about"), which is public knowledge.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { base58, base64 } from '@scure/base';
import { formatAssetId, mnemonicToSeed, solanaKeyProvider } from '@shiba-wallet/core';
import {
  KNOWN_SOLANA_TOKENS,
  SOLANA_DEVNET_CAIP2 as ENGINE_DEVNET,
  SOLANA_MAINNET_CAIP2,
  SPL_QUOTE_SENTENCES,
  SPL_SENTENCES,
  SolanaRpcClient,
  compileMessage,
  findAssociatedTokenAddress,
  lookAlikeSentence,
  parseMint,
  signTransaction,
  tokenProgramId,
} from '@shiba-wallet/chains-solana';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPL_PATH = resolve(HERE, '../src/wallet/spl-tokens.ts');
const SPL = await import(pathToFileURL(SPL_PATH).href);
const TOKENS = await import('../src/wallet/tokens.ts');
const DEFAULTS = await import('../src/config/defaults.ts');
const PREFS = await import('../src/config/prefs.ts');
const PRICES = await import('../src/wallet/prices.ts');
const HISTORY = await import('../src/wallet/history.ts');
const READINESS = await import('../src/config/readiness.ts');
const { STORE_KEYS } = await import('../src/wallet/store-keys.ts');

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
async function rejection(fn) {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}

// ---------------------------------------------------------------------------
// Fixtures: the recorded devnet mints and the test keys
// ---------------------------------------------------------------------------
const FIXTURE = JSON.parse(
  readFileSync(resolve(HERE, '../../packages/chains-solana/test/fixtures/devnet-token-accounts-2026-11-07.json'), 'utf8'),
);
const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const PYUSD = 'CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM';
const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const seed = mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const ALICE = solanaKeyProvider.deriveAccount(seed, 0, 0);
const BOB = solanaKeyProvider.deriveAccount(seed, 1, 0);
// A wallet address (on the curve) that holds a token account AT that address: a keypair token account.
const CAROL = solanaKeyProvider.deriveAccount(seed, 2, 0);

const u64 = (v) => {
  const b = new Uint8Array(8);
  let x = BigInt(v);
  for (let i = 0; i < 8; i++) {
    b[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return b;
};
const u32 = (v) => Uint8Array.of(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
const u16 = (v) => Uint8Array.of(v & 0xff, (v >> 8) & 0xff);
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const key = (s) => base58.decode(s);
const coption = (k) => (k ? concat(u32(1), key(k)) : concat(u32(0), new Uint8Array(32)));
/** A mint (token-2022 state.rs Mint, 82 bytes) with optional Token-2022 extensions after offset 165. */
function mintBytes({ decimals = 6, initialized = true, freeze = null, extensions = null }) {
  const base = concat(coption(ALICE.address), u64(1_000_000_000n), Uint8Array.of(decimals, initialized ? 1 : 0), coption(freeze));
  if (!extensions) return base;
  const tlv = concat(...extensions.map((e) => concat(u16(e.type), u16(e.data.length), e.data)));
  return concat(base, new Uint8Array(165 - 82), Uint8Array.of(1), tlv);
}
/** A classic 165-byte token account (state.rs Account). */
function tokenAccountBytes({ mint, owner, amount, state = 1 }) {
  return concat(key(mint), key(owner), u64(amount), coption(null), Uint8Array.of(state), concat(u32(0), u64(0)), u64(0), coption(null));
}
const ata = (owner, mint, program) =>
  base58.encode(findAssociatedTokenAddress({ owner: key(owner), mint: key(mint), tokenProgramId: tokenProgramId(program) }).address);

// Synthetic mints, one per refused class (Token-2022 extension numbers from
// the engine's TOKEN_EXTENSION_NAMES: NonTransferable 9, TransferHook 14,
// Pausable 26, InterestBearingConfig 10; 99 is a number the engine does not know).
/** A synthetic 32-byte address: every byte `n`. */
const synth = (n) => base58.encode(new Uint8Array(32).fill(n));
const HOOK_PROGRAM = BOB.address; // any non-zero 32 bytes: a hook program that is set
const SYNTH = {
  nonTransferable: { addr: synth(11), ext: [{ type: 9, data: new Uint8Array(0) }] },
  hook: { addr: synth(12), ext: [{ type: 14, data: concat(key(ALICE.address), key(HOOK_PROGRAM)) }] },
  paused: { addr: synth(13), ext: [{ type: 26, data: concat(key(ALICE.address), Uint8Array.of(1)) }] },
  adjusted: { addr: synth(14), ext: [{ type: 10, data: new Uint8Array(52) }] },
  unknown: { addr: synth(15), ext: [{ type: 99, data: new Uint8Array(0) }] },
};
for (const s of Object.values(SYNTH)) {
  if (base58.decode(s.addr).length !== 32) throw new Error(`synthetic mint address is not 32 bytes: ${s.addr}`);
}
const UNINIT = synth(16);

/** The fake chain: accounts by address, owner balances, request log. */
function fakeChain({ aliceUsdc = 5_000_000n, extraAccounts = {}, lamports = 1_000_000_000n } = {}) {
  const accounts = new Map();
  for (const [addr, acc] of Object.entries(FIXTURE.accounts)) {
    accounts.set(addr, { owner: acc.owner, data: base64.decode(acc.dataBase64), lamports: BigInt(acc.lamports) });
  }
  for (const s of Object.values(SYNTH)) accounts.set(s.addr, { owner: TOKEN_2022, data: mintBytes({ extensions: s.ext }), lamports: 1n });
  accounts.set(UNINIT, { owner: SPL_TOKEN_PROGRAM, data: mintBytes({ initialized: false }), lamports: 1n });
  if (aliceUsdc !== null) {
    accounts.set(ata(ALICE.address, USDC, 'spl-token'), {
      owner: SPL_TOKEN_PROGRAM,
      data: tokenAccountBytes({ mint: USDC, owner: ALICE.address, amount: aliceUsdc }),
      lamports: 2_039_280n,
    });
  }
  for (const s of Object.values(SYNTH)) {
    accounts.set(ata(ALICE.address, s.addr, 'token-2022'), { owner: TOKEN_2022, data: tokenAccountBytes({ mint: s.addr, owner: ALICE.address, amount: 9n }), lamports: 1n });
  }
  for (const [addr, acc] of Object.entries(extraAccounts)) accounts.set(addr, acc);
  const log = [];
  const sent = [];
  const transport = async (method, params) => {
    log.push(method);
    switch (method) {
      case 'getAccountInfo': {
        const acc = accounts.get(params[0]);
        return { context: { slot: 1 }, value: acc ? { data: [base64.encode(acc.data), 'base64'], executable: false, lamports: Number(acc.lamports), owner: acc.owner } : null };
      }
      case 'getTokenAccountsByOwner': {
        const [owner, { programId }] = params;
        const value = [...accounts.entries()]
          .filter(([, a]) => a.owner === programId && a.data.length >= 165 && base58.encode(a.data.slice(32, 64)) === owner)
          .map(([pubkey, a]) => ({ pubkey, account: { data: [base64.encode(a.data), 'base64'], executable: false, lamports: Number(a.lamports), owner: a.owner } }));
        return { context: { slot: 1 }, value };
      }
      case 'getEpochInfo':
        return { epoch: 1203, absoluteSlot: 1, blockHeight: 1, slotIndex: 0, slotsInEpoch: 432000 };
      // A fake answer: the rent-exempt minimum for a 165-byte account as the
      // documented formula gives it ((128 + 165) × 3,480 × 2); the check
      // only needs the figure to flow through to the confirm unchanged.
      case 'getMinimumBalanceForRentExemption':
        return (128 + params[0]) * 3480 * 2;
      case 'getBalance':
        return { context: { slot: 1 }, value: Number(lamports) };
      case 'getLatestBlockhash':
        return { context: { slot: 1 }, value: { blockhash: FAKE_BLOCKHASH, lastValidBlockHeight: 100 } };
      case 'sendTransaction': {
        const wire = base64.decode(params[0]);
        sent.push(wire);
        return base58.encode(wire.slice(1, 65));
      }
      case 'getSignatureStatuses':
        return { context: { slot: 2 }, value: [{ slot: 2, confirmations: null, err: null, confirmationStatus: 'finalized' }] };
      default:
        throw new Error(`fake RPC: unexpected method ${method}`);
    }
  };
  return { client: new SolanaRpcClient(transport), log, sent, accounts };
}
const FAKE_BLOCKHASH = base58.encode(new Uint8Array(32).fill(7));

/** An in-memory store (the KeyValueStore shape) that can list and delete keys. */
function memoryStore({ removable = true } = {}) {
  const map = new Map();
  const store = {
    map,
    getItem: async (k) => (map.has(k) ? map.get(k) : null),
    setItem: async (k, v) => {
      map.set(k, v);
    },
  };
  if (removable) {
    store.removeItem = async (k) => {
      map.delete(k);
    };
  }
  return store;
}

// ---------------------------------------------------------------------------
console.log('check-spl-tokens: the Solana devnet network and preference');
// ---------------------------------------------------------------------------
check('config/defaults.ts SOLANA_DEVNET_CAIP2 equals the engine’s and readiness’s test-network id',
  DEFAULTS.SOLANA_DEVNET_CAIP2 === ENGINE_DEVNET && ENGINE_DEVNET === DEVNET && READINESS.SOLANA_TEST_NETWORK_CHAINS.join() === DEVNET);
check('the devnet entry: Solana JSON-RPC, 9 decimals, "test SOL", the two documented keyless endpoints in order',
  DEFAULTS.SOLANA_DEVNET_NETWORK.kind === 'solana-jsonrpc' && DEFAULTS.SOLANA_DEVNET_NETWORK.decimals === 9 &&
    DEFAULTS.SOLANA_DEVNET_NETWORK.symbol === 'test SOL' &&
    DEFAULTS.SOLANA_DEVNET_NETWORK.defaultUrls.join() === 'https://api.devnet.solana.com,https://solana-devnet.api.onfinality.io/public' &&
    DEFAULTS.networkDefaultFor(DEVNET) === DEFAULTS.SOLANA_DEVNET_NETWORK);
{
  const slotOf = (mode) => mode.find((e) => e.slot === SOLANA_MAINNET_CAIP2).network.chainId;
  check('resolveActiveNetworks: the Solana slot is mainnet by default and devnet only with solanaDevnet true; every other slot unchanged',
    slotOf(DEFAULTS.resolveActiveNetworks(null)) === SOLANA_MAINNET_CAIP2 &&
      slotOf(DEFAULTS.resolveActiveNetworks(null, true)) === DEVNET &&
      slotOf(DEFAULTS.resolveActiveNetworks('eip155:11155111', true)) === DEVNET &&
      DEFAULTS.resolveActiveNetworks('eip155:11155111', true).filter((e) => e.slot !== SOLANA_MAINNET_CAIP2)
        .every((e, i) => e.network === DEFAULTS.resolveActiveNetworks('eip155:11155111').filter((x) => x.slot !== SOLANA_MAINNET_CAIP2)[i].network));
  const solPriceIndex = DEFAULTS.resolveActiveNetworks(null).findIndex((e) => e.slot === SOLANA_MAINNET_CAIP2);
  check('no price is requested for devnet SOL (the mainnet SOL id stays when devnet is off)',
    PRICES.nativePriceIds(false, true)[solPriceIndex] === null && PRICES.nativePriceIds(false)[solPriceIndex] !== null);
}
{
  const store = memoryStore();
  const fresh = await PREFS.loadPrefs(store);
  await store.setItem(STORE_KEYS.prefs.name, JSON.stringify({ solanaDevnet: 'yes' }));
  const odd = await PREFS.loadPrefs(store);
  const saved = await PREFS.savePrefs({ solanaDevnet: true }, store);
  const reread = await PREFS.loadPrefs(store);
  check('preferences: solanaDevnet defaults to false, only an explicit stored true reads as on, and it round-trips',
    fresh.solanaDevnet === false && PREFS.DEFAULT_PREFS.solanaDevnet === false && odd.solanaDevnet === false &&
      saved.solanaDevnet === true && reread.solanaDevnet === true && reread.testNetwork === null);
}
{
  const activity = readFileSync(resolve(HERE, '../src/screens/ActivityScreen.tsx'), 'utf8');
  check('explorer links: a Solana devnet transaction gets none (no verified devnet explorer), mainnet keeps solscan; Activity and its export build links for the devnet id on devnet',
    HISTORY.explorerTxUrl(DEVNET, 'sig') === null && HISTORY.explorerTxUrl(SOLANA_MAINNET_CAIP2, 'sig') === 'https://solscan.io/tx/sig' &&
      // The devnet test is one named condition since the p24-solana fix slice (it also sets the header).
      activity.includes('const solanaDevnetSlot = chainId === SOLANA_CHAIN_ID && solanaDevnet;') &&
      activity.includes('const explorerChainId = solanaDevnetSlot ? SOLANA_DEVNET_CAIP2 : chainId;') &&
      activity.includes('chainId={explorerChainId}') && activity.includes('explorerTxUrl(explorerChainId, id, evmChain.explorerTxBase)'));
  const sendSrc = readFileSync(resolve(HERE, '../src/wallet/send.ts'), 'utf8');
  const sendScreen = readFileSync(resolve(HERE, '../src/screens/SendScreen.tsx'), 'utf8');
  check('the SOL send’s success link: solscan only when the network that sent is Solana mainnet',
    sendSrc.includes('explorerUrl: networkChainId === SOLANA_CHAIN_ID ? `https://solscan.io/tx/${signature}` : null,') &&
      sendScreen.includes("if (quote.kind === 'sol') return sendSol(sendUrl, signer, quote, endpoint?.network.chainId);"));
}

// ---------------------------------------------------------------------------
console.log('check-spl-tokens: the stored lists per network');
// ---------------------------------------------------------------------------
{
  const store = memoryStore();
  const devnet = await TOKENS.listSolanaTokens(DEVNET, store);
  const mainnet = await TOKENS.listSolanaTokens(SOLANA_MAINNET_CAIP2, store);
  check('defaults: Circle’s devnet USDC on devnet (6 decimals, CAIP-19 "token" namespace), Circle’s USDC on mainnet, nothing else (PYUSD known, not default)',
    devnet.length === 1 && formatAssetId(devnet[0].assetId) === `${DEVNET}/token:${USDC}` && devnet[0].decimals === 6 && devnet[0].symbol === 'USDC' &&
      mainnet.length === 1 && mainnet[0].assetId.reference === KNOWN_SOLANA_TOKENS.find((t) => t.caip2 === SOLANA_MAINNET_CAIP2).mint &&
      store.map.size === 0);
  const pyusd = SPL.trackedAssetFor({ caip2: DEVNET, mint: PYUSD, decimals: 6 }, 'PYUSD', 'PayPal USD');
  await TOKENS.addSolanaToken(pyusd, store);
  const keys = [...store.map.keys()];
  check('a tracked token is stored under shiba-wallet.tokens.v1.<devnet CAIP-2> only (the declared tokensPerChain family)',
    keys.length === 1 && keys[0] === `shiba-wallet.tokens.v1.${DEVNET}` && TOKENS.tokenStoreKey(DEVNET) === keys[0]);
  const after = await TOKENS.listSolanaTokens(DEVNET, store);
  check('…the devnet list is the defaults plus the token, in order; the mainnet list is untouched; the EVM lists never show it',
    after.map((t) => t.symbol).join() === 'USDC,PYUSD' && (await TOKENS.listSolanaTokens(SOLANA_MAINNET_CAIP2, store)).length === 1 &&
      (await TOKENS.listTokens('eip155:11155111', store)).every((t) => t.assetId.namespace === 'erc20'));
  check('a duplicate mint is refused', (await rejection(() => TOKENS.addSolanaToken(pyusd, store)))?.message.startsWith('This token is already in your list'));
  check('another chain and the ERC-20 namespace are refused',
    /only be tracked on Solana mainnet or Solana devnet/.test((await rejection(() => TOKENS.addSolanaToken({ ...pyusd, assetId: { ...pyusd.assetId, chainId: 'eip155:1' } }, store)))?.message ?? '') &&
      /Only fungible Solana tokens/.test((await rejection(() => TOKENS.addSolanaToken({ ...pyusd, assetId: { ...pyusd.assetId, namespace: 'erc20' } }, store)))?.message ?? ''));
  check('removing the default USDC sticks (a present list is the user’s, verbatim)',
    (await TOKENS.removeSolanaToken(`${DEVNET}/token:${USDC}`, store)) === true &&
      (await TOKENS.listSolanaTokens(DEVNET, store)).map((t) => t.symbol).join() === 'PYUSD');
  const wipeStore = memoryStore();
  await wipeStore.setItem(`shiba-wallet.tokens.v1.${DEVNET}`, '[]');
  await wipeStore.setItem(`shiba-wallet.tokens.v1.${SOLANA_MAINNET_CAIP2}`, '[]');
  await TOKENS.resetTrackedTokens(wipeStore); // this store cannot list its keys
  check('the wipe removes both Solana lists even from a store that cannot list its keys', wipeStore.map.size === 0);
}

// ---------------------------------------------------------------------------
console.log('check-spl-tokens: reading a mint and the Track prompt');
// ---------------------------------------------------------------------------
{
  const chain = fakeChain();
  const usdc = await SPL.previewMint(chain.client, DEVNET, ` ${USDC} `, []);
  const usdcMint = parseMint(base64.decode(FIXTURE.accounts[USDC].dataBase64), 'spl-token');
  check('devnet USDC: classic SPL Token, 6 decimals from the mint, plain, its symbol from the known-token table (no on-chain record names it)',
    usdc.profile.program === 'spl-token' && usdc.decimals === 6 && usdc.sendRefusal === null && usdc.symbol === 'USDC' &&
      usdc.symbolSource === 'known' && usdc.lookAlike === null && usdc.profile.metadataNote === 'No on-chain name or symbol was found for this mint.');
  const prompt = SPL.trackPrompt(usdc, 'USDC');
  check('the Track prompt names the full mint and the network, exact text',
    prompt.title === 'Track USDC?' && prompt.confirm === 'Track USDC' &&
      prompt.message === `Mint ${USDC} on Solana devnet. Anyone can create a token with any name and symbol; track it only if this is the mint you expect.`);
  const pyusd = await SPL.previewMint(chain.client, DEVNET, PYUSD, []);
  check('devnet PYUSD: Token-2022, its name and symbol from its own metadata extension, fee-charging (sendable, with notes)',
    pyusd.profile.program === 'token-2022' && pyusd.symbol === 'PYUSD' && pyusd.name === 'PayPal USD' && pyusd.symbolSource === 'metadata' &&
      pyusd.profile.classification.transferClass === 'fee-charging' && pyusd.sendRefusal === null &&
      pyusd.profile.classification.notes.includes(SPL_SENTENCES.confidential));
  const fake = SPL.lookAlikeFor(DEVNET, SYNTH.unknown.addr, 'usdc', []);
  check('look-alike: another mint calling itself USDC on devnet gets the engine’s sentence, and the prompt warns with it',
    fake === lookAlikeSentence('usdc', USDC) &&
      SPL.trackPrompt({ mint: SYNTH.unknown.addr, caip2: DEVNET, lookAlike: fake, sendRefusal: null }, 'usdc').message ===
        `Mint ${SYNTH.unknown.addr} on Solana devnet. Warning: ${fake} Anyone can create a token with any name and symbol; track it only if this is the mint you expect.`);
  const tracked = [SPL.trackedAssetFor({ caip2: DEVNET, mint: SYNTH.unknown.addr, decimals: 6 }, 'ABC', 'ABC')];
  check('look-alike against a tracked token too; the same symbol on mainnet is not a look-alike of a devnet token',
    SPL.lookAlikeFor(DEVNET, SYNTH.hook.addr, 'ABC', tracked) === lookAlikeSentence('ABC', SYNTH.unknown.addr) &&
      SPL.lookAlikeFor(SOLANA_MAINNET_CAIP2, SYNTH.hook.addr, 'ABC', tracked) === null);
  const hook = await SPL.previewMint(chain.client, DEVNET, SYNTH.hook.addr, []);
  check('a hook-bearing mint can be tracked; its preview and Track prompt carry the engine’s refusal sentence verbatim',
    hook.sendRefusal === SPL_SENTENCES.hook(HOOK_PROGRAM) &&
      SPL.trackPrompt(hook, 'HOOK').message.includes(` This token can be tracked and shown, but this wallet will not send it: ${SPL_SENTENCES.hook(HOOK_PROGRAM)}`));
  for (const [name, sentence] of [
    ['nonTransferable', SPL_SENTENCES.nonTransferable],
    ['paused', SPL_SENTENCES.paused],
    ['adjusted', SPL_SENTENCES.displayAdjusted('InterestBearingConfig')],
    ['unknown', SPL_SENTENCES.unknownExtension('99')],
  ]) {
    const p = await SPL.previewMint(chain.client, DEVNET, SYNTH[name].addr, []);
    check(`a ${name} mint can be tracked and carries the engine sentence verbatim`, p.sendRefusal === sentence, p.sendRefusal);
  }
  check('an uninitialized mint is not trackable: the engine’s notAMint sentence',
    (await rejection(() => SPL.previewMint(chain.client, DEVNET, UNINIT, [])))?.message === SPL_SENTENCES.notAMint);
  check('text that is not a 32-byte base58 address is refused before any request',
    (await rejection(() => SPL.previewMint(fakeChain().client, DEVNET, '0xabc', [])))?.message === SPL.SPL_MINT_ADDRESS_INVALID);
  check('an address with no account: the engine’s mintMissing sentence',
    (await rejection(() => SPL.previewMint(chain.client, DEVNET, BOB.address, [])))?.message === SPL_QUOTE_SENTENCES.mintMissing);
  const tokensScreen = readFileSync(resolve(HERE, '../src/screens/SolanaTokensScreen.tsx'), 'utf8');
  const addCalls = tokensScreen.match(/addSolanaToken\(/g) ?? [];
  const confirmIdx = tokensScreen.indexOf('Alert.alert(prompt.title, prompt.message, [');
  check('the Solana tokens screen tracks only from the Track confirmation (trackPrompt’s title, message and button), once',
    addCalls.length === 1 && confirmIdx > 0 && tokensScreen.indexOf('addSolanaToken(trackedAssetFor(preview, symbol, name))') > confirmIdx &&
      tokensScreen.includes('const prompt = trackPrompt(preview, symbol);') && tokensScreen.includes('text: prompt.confirm,'));
  const tracked2 = SPL.trackedAssetFor(pyusd, 'PYUSD', '');
  check('the tracked asset: CAIP-19 token namespace, the mint’s decimals, a missing name becomes the symbol',
    formatAssetId(tracked2.assetId) === `${DEVNET}/token:${PYUSD}` && tracked2.decimals === 6 && tracked2.name === 'PYUSD');
}

// ---------------------------------------------------------------------------
console.log('check-spl-tokens: Home rows');
// ---------------------------------------------------------------------------
{
  // An extra, non-associated USDC account of Alice's (a keypair account).
  const extra = CAROL.address;
  const chain = fakeChain({
    extraAccounts: { [extra]: { owner: SPL_TOKEN_PROGRAM, data: tokenAccountBytes({ mint: USDC, owner: ALICE.address, amount: 250_000n }), lamports: 1n } },
  });
  const usdcToken = (await TOKENS.listSolanaTokens(DEVNET, memoryStore()))[0];
  const hookToken = SPL.trackedAssetFor({ caip2: DEVNET, mint: SYNTH.hook.addr, decimals: 6 }, 'HOOK', 'Hook');
  const oddToken = SPL.trackedAssetFor({ caip2: DEVNET, mint: SYNTH.paused.addr, decimals: 9 }, 'PAUSE', 'Paused');
  const { rows, skipped } = await SPL.loadSplTokenRows(chain.client, ALICE.address, [usdcToken, hookToken, oddToken], DEVNET);
  const u = rows[formatAssetId(usdcToken.assetId)];
  check('the row balance is the associated account’s; another account of the mint is counted separately',
    u.status === 'ok' && u.associated === 5_000_000n && u.outside === 250_000n && u.outsideAccounts === 1 && u.sendRefusal === null &&
      u.decimals === 6 && !u.decimalsChanged && u.networkChainId === DEVNET && skipped === 0);
  check('…the outside line, exact', SPL.splOutsideLine('0.25', 'USDC', 1) ===
    'Also 0.25 USDC held outside the associated account (1 other token account), not sendable from here.');
  const h = rows[formatAssetId(hookToken.assetId)];
  check('a hook-bearing row: the engine’s refusal and the "Cannot be sent" line, exact',
    h.status === 'ok' && h.sendRefusal === SPL_SENTENCES.hook(HOOK_PROGRAM) && h.associated === 9n &&
      SPL.splCannotSendLine(h.sendRefusal) === `Cannot be sent from this wallet: ${SPL_SENTENCES.hook(HOOK_PROGRAM)}`);
  const o = rows[formatAssetId(oddToken.assetId)];
  check('a mint whose decimals differ from the stored ones is flagged (the display uses the mint’s)',
    o.status === 'ok' && o.decimalsChanged && o.decimals === 6 &&
      SPL.splDecimalsChangedLine(9, 6) === 'The mint now reports 6 decimals, not the 9 recorded when this token was tracked. The balance uses the mint’s figure; a send is refused until you remove the token and track it again.');
  const homeSrc = readFileSync(resolve(HERE, '../src/screens/HomeScreen.tsx'), 'utf8');
  check('Home: the outside amount is masked by Hide amounts, rows carry no fiat, Send only where the gate allows',
    homeSrc.includes('splOutsideLine(maskAmount(formatBalanceDisplay(state.outside, state.decimals), hidden)') &&
      homeSrc.includes('<BalanceCell state={balanceState} onRetry={onRetry} hidden={hidden} fiat={null} />') &&
      homeSrc.includes("{...(refusal === null ? { onSend: () => navigation.navigate('SolanaTokenSend', { assetId: id }) } : {})}"));
}

// ---------------------------------------------------------------------------
console.log('check-spl-tokens: the readiness gate (test networks only, enforced)');
// ---------------------------------------------------------------------------
{
  const chain = fakeChain();
  const usdcMainnet = (await TOKENS.listSolanaTokens(SOLANA_MAINNET_CAIP2, memoryStore()))[0];
  const e = await rejection(() =>
    SPL.quoteSplSend(chain.client, { caip2: SOLANA_MAINNET_CAIP2, url: 'https://x', owner: ALICE.address, recipient: BOB.address, token: usdcMainnet, amountText: '1' }));
  check('on Solana mainnet the quote is refused with the readiness reason and the devnet hint, before any request',
    e?.name === 'SplSendNotAllowedError' && e.message === `${READINESS.readinessReason('spl-tokens')} ${SPL.SPL_DEVNET_HINT}` && chain.log.length === 0);
  check('the refusal sentence: Settings → Developer → Solana devnet', SPL.SPL_DEVNET_HINT === 'Turn on Solana devnet in Settings → Developer to send Solana tokens.');
  let auths = 0;
  let signs = 0;
  const e2 = await rejection(() =>
    SPL.runSplSend(
      { requireAuth: async () => (auths++, { ok: true }), signWith: async () => (signs++, 'x'), client: chain.client, second: null },
      { caip2: SOLANA_MAINNET_CAIP2, owner: ALICE.address, recipient: BOB.address, symbol: 'USDC', url: 'https://x', quote: {} }));
  check('…and a send on mainnet is refused before the device check and before signWith', e2?.name === 'SplSendNotAllowedError' && auths === 0 && signs === 0 && chain.log.length === 0);
  check('splSendGate: null on devnet, the refusal on mainnet and on an EVM chain',
    SPL.splSendGate(DEVNET) === null && SPL.splSendGate(SOLANA_MAINNET_CAIP2) === SPL.splSendRefusalText() && SPL.splSendGate('eip155:1') !== null);
}

// ---------------------------------------------------------------------------
console.log('check-spl-tokens: refusals surface the engine’s sentences byte for byte, before any prompt');
// ---------------------------------------------------------------------------
const usdcDevnet = (await TOKENS.listSolanaTokens(DEVNET, memoryStore()))[0];
const quoteOn = (chain, over = {}) =>
  SPL.quoteSplSend(chain.client, { caip2: DEVNET, url: 'https://devnet.example', owner: ALICE.address, recipient: BOB.address, token: usdcDevnet, amountText: '1.5', ...over });
{
  for (const [name, sentence] of [
    ['nonTransferable', SPL_SENTENCES.nonTransferable],
    ['hook', SPL_SENTENCES.hook(HOOK_PROGRAM)],
    ['paused', SPL_SENTENCES.paused],
    ['adjusted', SPL_SENTENCES.displayAdjusted('InterestBearingConfig')],
    ['unknown', SPL_SENTENCES.unknownExtension('99')],
  ]) {
    const token = SPL.trackedAssetFor({ caip2: DEVNET, mint: SYNTH[name].addr, decimals: 6 }, 'X', 'X');
    const e = await rejection(() => quoteOn(fakeChain(), { token, amountText: '0.000001' }));
    check(`quote refused for the ${name} class with the engine’s sentence`, e?.name === 'SplTokenRefusal' && e.message === sentence, e?.message);
  }
  const cases = [
    ['zero amount', { amountText: '0' }, SPL_QUOTE_SENTENCES.zeroAmount],
    ['too much', { amountText: '6' }, SPL_QUOTE_SENTENCES.insufficient('5', '6', 'this token')],
    ['to yourself', { recipient: ALICE.address }, SPL_QUOTE_SENTENCES.selfSend],
    ['to an off-curve address (an associated token account)', { recipient: ata(ALICE.address, USDC, 'spl-token') }, SPL_QUOTE_SENTENCES.offCurve],
    ['a bad recipient', { recipient: 'not-base58-0OIl' }, SPL_QUOTE_SENTENCES.badRecipient],
    ['decimals changed', { token: { ...usdcDevnet, decimals: 9 } }, SPL_QUOTE_SENTENCES.decimalsChanged(9, 6)],
  ];
  for (const [label, over, sentence] of cases) {
    const e = await rejection(() => quoteOn(fakeChain(), over));
    check(`quote refused (${label}) with the engine’s sentence`, e?.message === sentence, e?.message);
  }
  const tokenAccountAsWallet = await rejection(() =>
    quoteOn(fakeChain({ extraAccounts: { [CAROL.address]: { owner: SPL_TOKEN_PROGRAM, data: tokenAccountBytes({ mint: USDC, owner: BOB.address, amount: 1n }), lamports: 1n } } }), { recipient: CAROL.address }));
  check('quote refused (a recipient that is itself a token account) with the engine’s sentence', tokenAccountAsWallet?.message === SPL_QUOTE_SENTENCES.recipientIsTokenAccount, tokenAccountAsWallet?.message);
  const poor = await rejection(() => quoteOn(fakeChain({ lamports: 1000n })));
  check('quote refused when SOL cannot cover the fee and the new account’s rent', poor?.message === SPL_QUOTE_SENTENCES.notEnoughSol('2044280', '1000'), poor?.message);
  const noSource = await rejection(() => quoteOn(fakeChain({ aliceUsdc: null })));
  check('quote refused when the associated account does not exist', noSource?.message === SPL_QUOTE_SENTENCES.noSourceAccount('this token'), noSource?.message);
  // The engine's wording (phase 24 follow-up): "holds no <SYMBOL>" for a
  // named token; a mint with no readable symbol keeps "none of this token",
  // because "holds no this token" would not read as English.
  check('the no-source sentence, exact: "holds no PYUSD" for a named token, "holds none of this token" without a symbol',
    SPL_QUOTE_SENTENCES.noSourceAccount('PYUSD') === 'This account holds no PYUSD in its associated token account, so there is nothing to send.' &&
      noSource?.message === 'This account holds none of this token in its associated token account, so there is nothing to send.',
    noSource?.message);
  const badAmount = await rejection(() => quoteOn(fakeChain(), { amountText: '1.0000001' }));
  check('an amount with more decimals than the token has: the parser’s own sentence', badAmount?.message === 'Too many decimal places: this asset supports at most 6, got 7');
}

// ---------------------------------------------------------------------------
console.log('check-spl-tokens: the confirm rows and the one-prompt send');
// ---------------------------------------------------------------------------
{
  const chain = fakeChain();
  const q = await quoteOn(chain);
  const usdcMint = parseMint(base64.decode(FIXTURE.accounts[USDC].dataBase64), 'spl-token');
  const rows = SPL.splConfirmRows(q, 'test SOL').map((r) => `${r.label}: ${r.value}`);
  const expectedRows = [
    `From: ${ALICE.address}`,
    `To: ${BOB.address}`,
    'Amount: 1.5 USDC',
    'Network fee (paid in SOL): 5000 lamports (0.000005 test SOL)',
    'Rent for the recipient’s new token account (paid by you): 2039280 lamports (0.00203928 test SOL)',
    'Total SOL leaving your account: 2044280 lamports (0.00204428 test SOL)',
    `Mint: ${USDC}`,
    'Token program: SPL Token',
    `Your token account: ${ata(ALICE.address, USDC, 'spl-token')}`,
    `Recipient’s token account: ${ata(BOB.address, USDC, 'spl-token')} (created by this transaction)`,
  ];
  check('confirm rows from the recorded devnet USDC mint, exact and in order', JSON.stringify(rows) === JSON.stringify(expectedRows), JSON.stringify(rows));
  check('the quote’s notes are the engine’s, verbatim (the freeze authority, the new account’s rent)',
    JSON.stringify(q.quote.notes) === JSON.stringify([
      SPL_SENTENCES.freezeAuthority(usdcMint.freezeAuthority),
      'The recipient does not hold this token yet, so this transaction also creates their token account; you pay its rent of 2039280 lamports, which stays in that account.',
    ]));
  check('the device prompt is titled like the SOL send', SPL.splApprovalPromptTitle(q) === 'Approve sending 1.5 USDC');

  let auths = [];
  let signCalls = [];
  const signWith = async (chainId, expectAddress, fn) => {
    signCalls.push([chainId, expectAddress]);
    // The one place a phrase is read in the app (WalletContext.signWith);
    // here the test key stands in for it.
    return fn(ALICE);
  };
  const second = fakeChain();
  const outcome = await SPL.runSplSend(
    { requireAuth: async (title) => (auths.push(title), { ok: true }), signWith, client: chain.client, second: { url: 'https://second.example', client: second.client }, sleep: async () => {} },
    q,
  );
  check('one device check titled "Approve sending 1.5 USDC", then exactly one signWith for the Solana slot and the quoted owner',
    JSON.stringify(auths) === JSON.stringify(['Approve sending 1.5 USDC']) &&
      JSON.stringify(signCalls) === JSON.stringify([[SOLANA_MAINNET_CAIP2, ALICE.address]]));
  const expectedWire = signTransaction(
    compileMessage({ feePayer: ALICE.publicKey, recentBlockhash: FAKE_BLOCKHASH, instructions: q.quote.instructions }),
    [{ publicKey: ALICE.publicKey, sign: (b) => ALICE.sign(b) }],
  ).wireBytes;
  check('exactly one transaction was sent: the quote’s instructions, signed by the owner, byte for byte',
    chain.sent.length === 1 && base64.encode(chain.sent[0]) === base64.encode(expectedWire) && outcome.signature === base58.encode(expectedWire.slice(1, 65)));
  check('the result is confirmed on the sending endpoint and read again on the second one',
    outcome.primary.status === 'confirmed' && outcome.second?.status === 'seen' && outcome.second.confirmationStatus === 'finalized' &&
      second.log.join() === 'getSignatureStatuses');
  check('…the outcome lines, exact',
    JSON.stringify(SPL.splOutcomeLines(outcome, (u) => new URL(u).host)) ===
      JSON.stringify(['The sending endpoint reports the transaction confirmed.', 'Read again on second.example: the transaction is there (finalized).']));
  auths = [];
  signCalls = [];
  const c2 = fakeChain();
  const q2 = await quoteOn(c2);
  const before = c2.log.length;
  const cancelled = await rejection(() =>
    SPL.runSplSend({ requireAuth: async (t) => (auths.push(t), { ok: false, message: 'Authentication cancelled.' }), signWith, client: c2.client, second: null }, q2));
  check('a cancelled device check: nothing signed, nothing sent, no request',
    cancelled?.name === 'SplSendCancelledError' && signCalls.length === 0 && c2.sent.length === 0 && c2.log.length === before);
  check('secondReadUrl: the first default that did not send, else null',
    SPL.secondReadUrl('https://a', ['https://a', 'https://b']) === 'https://b' && SPL.secondReadUrl('https://a', ['https://a']) === null &&
      SPL.secondReadUrl('https://custom', ['https://a', 'https://b']) === 'https://a');
  const src = readFileSync(SPL_PATH, 'utf8');
  check('spl-tokens.ts reads no phrase itself: no storage, vault, biometric or WalletContext import; signing only through the injected signWith',
    !/from '\.\/(storage|WalletContext|biometric|store-keys)/.test(src) && !/readPhrase|openPhraseForApproval|SecureStore/.test(src) &&
      (src.match(/deps\.signWith\(/g) ?? []).length === 1 && (src.match(/deps\.requireAuth\(/g) ?? []).length === 1);
  const screen = readFileSync(resolve(HERE, '../src/screens/SolanaTokenSendScreen.tsx'), 'utf8');
  check('the send screen: one runSplSend with requireLocalAuth and signWith, no direct signing',
    (screen.match(/runSplSend\(/g) ?? []).length === 1 && screen.includes('requireAuth: (title) => requireLocalAuth(title)') &&
      !/signTransaction|sendTransaction/.test(screen));
}

// ---------------------------------------------------------------------------
console.log('check-spl-tokens: the fixes of pass p24-solana (transfer fee, Send at 0, the devnet banner and screens)');
// ---------------------------------------------------------------------------
{
  const chain = fakeChain();
  const pyusd = await SPL.previewMint(chain.client, DEVNET, PYUSD, []);
  const fee = pyusd.profile.classification.transferFee;
  check('devnet PYUSD (the recorded mint): the engine decodes a TransferFeeConfig of 0 basis points and a 0 maximum, and the preview carries it',
    fee !== null && pyusd.transferFee === fee && fee.newerTransferFee.basisPoints === 0 && fee.newerTransferFee.maximumFee === 0n &&
      fee.olderTransferFee.basisPoints === 0 && fee.olderTransferFee.maximumFee === 0n);
  check('…the read-back line says 0 as 0, with the maximum in PYUSD (exact)',
    SPL.splTransferFeeLine(fee, pyusd.decimals, 'PYUSD') === 'Transfer fee: 0 basis points (0 PYUSD max) — shown again on every send.');
  check('…and the Track prompt carries it before the closing sentence (exact)',
    SPL.trackPrompt(pyusd, 'PYUSD').message ===
      `Mint ${PYUSD} on Solana devnet. Transfer fee: 0 basis points (0 PYUSD max) — shown again on every send. Anyone can create a token with any name and symbol; track it only if this is the mint you expect.`);
  const usdc = await SPL.previewMint(chain.client, DEVNET, USDC, []);
  check('a mint with no TransferFeeConfig (devnet USDC): no fee line, the prompt unchanged',
    usdc.transferFee === null && !SPL.trackPrompt(usdc, 'USDC').message.includes('Transfer fee'));
  const two = {
    transferFeeConfigAuthority: null, withdrawWithheldAuthority: null, withheldAmount: 0n,
    olderTransferFee: { epoch: 0n, maximumFee: 1_000_000n, basisPoints: 50 },
    newerTransferFee: { epoch: 700n, maximumFee: 2_500_000n, basisPoints: 125 },
  };
  check('two different rates: both named, with the epoch the newer one starts (exact)',
    SPL.splTransferFeeLine(two, 6, 'ABC') === 'Transfer fee: 50 basis points (1 ABC max) before epoch 700, then 125 basis points (2.5 ABC max) — shown again on every send.');
  check('no symbol yet (typed by the user later): the maximum in units, no symbol',
    SPL.splTransferFeeLine(fee, 6, null) === 'Transfer fee: 0 basis points (0 max) — shown again on every send.');
  const screen = readFileSync(resolve(HERE, '../src/screens/SolanaTokensScreen.tsx'), 'utf8');
  check('the Solana tokens screen shows the fee line in the read-back', screen.includes('{splTransferFeeLine(preview.transferFee, preview.decimals, preview.symbol)}'));

  const ok = (associated, extra = {}) => ({ status: 'ok', associated, outside: 0n, outsideAccounts: 0, decimals: 6, sendRefusal: null, decimalsChanged: false, networkChainId: DEVNET, ...extra });
  check('Send link: shown for a positive associated balance where a send is offered; hidden at exactly 0, without a send, on a refusal, a decimals change, an error or no row yet',
    SPL.splSendLinkShown(ok(1n), true) && !SPL.splSendLinkShown(ok(0n), true) && !SPL.splSendLinkShown(ok(5n), false) &&
      !SPL.splSendLinkShown(ok(5n, { sendRefusal: 'no' }), true) && !SPL.splSendLinkShown(ok(5n, { decimalsChanged: true }), true) &&
      !SPL.splSendLinkShown({ status: 'error', message: 'x' }, true) && !SPL.splSendLinkShown(undefined, true));
  check('…a balance held only outside the associated account does not show it (a send never uses those)',
    !SPL.splSendLinkShown(ok(0n, { outside: 250_000n, outsideAccounts: 1 }), true));
  const homeSrc = readFileSync(resolve(HERE, '../src/screens/HomeScreen.tsx'), 'utf8');
  check('Home: the row asks splSendLinkShown; "Manage Solana tokens" has a hint like its neighbours',
    homeSrc.includes('const sendable = splSendLinkShown(state, onSend !== undefined);') &&
      homeSrc.includes('accessibilityHint="Opens the list of tracked Solana tokens"'));

  check('the Solana devnet banner: only on the Solana slot and only with the switch on, whatever the Ethereum choice',
    SPL.solanaDevnetBannerShown(SOLANA_MAINNET_CAIP2, true) && !SPL.solanaDevnetBannerShown(SOLANA_MAINNET_CAIP2, false) &&
      !SPL.solanaDevnetBannerShown('eip155:1', true) && !SPL.solanaDevnetBannerShown('eip155:11155111', true) &&
      !SPL.solanaDevnetBannerShown(undefined, true));
  const banner = readFileSync(resolve(HERE, '../src/components/SolanaDevnetBanner.tsx'), 'utf8');
  check('the banner component: the rule above, the table text, the TESTNET theme colours (no hard-coded colour)',
    banner.includes('if (!solanaDevnetBannerShown(chainId, solanaDevnet)) return null;') && banner.includes('{solanaDevnetBannerText()}') &&
      banner.includes('backgroundColor: theme.testnetFill') && banner.includes('color: theme.onTestnetFill') && !/#[0-9a-f]{3,6}\b|'white'/i.test(banner));
  const count = (rel, needle) => (readFileSync(resolve(HERE, rel), 'utf8').split(needle).length - 1);
  check('…drawn on Manage Solana tokens (1), every view of the Solana token send (4), Solana Activity (its header), Receive (1) and the SOL send (form, confirm, success)',
    count('../src/screens/SolanaTokensScreen.tsx', '<SolanaDevnetBanner chainId={SOLANA_SLOT_CHAIN_ID} />') === 1 &&
      count('../src/screens/SolanaTokenSendScreen.tsx', '<SolanaDevnetBanner chainId={SOLANA_CHAIN_ID} />') === 4 &&
      count('../src/screens/ActivityScreen.tsx', '<SolanaDevnetBanner chainId={chainId} />') === 1 &&
      count('../src/screens/ReceiveScreen.tsx', '<SolanaDevnetBanner chainId={route.params.chainId} />') === 1 &&
      count('../src/screens/SendScreen.tsx', '<SolanaDevnetBanner chainId={route.params.chainId} />') === 3);
  const activity = readFileSync(resolve(HERE, '../src/screens/ActivityScreen.tsx'), 'utf8');
  check('Solana Activity on devnet: the devnet network entry (its label "Solana devnet", its "test SOL") and the TESTNET line, not "Mainnet"',
    activity.includes('const network = networkDefaultFor(solanaDevnetSlot ? SOLANA_DEVNET_CAIP2 : chainId);') &&
      activity.includes('const testnet = (isEvmSlot && evmChain.testnet) || solanaDevnetSlot;') &&
      DEFAULTS.networkDefaultFor(DEFAULTS.SOLANA_DEVNET_CAIP2).label === 'Solana devnet' && DEFAULTS.networkDefaultFor(DEFAULTS.SOLANA_DEVNET_CAIP2).symbol === 'test SOL');
  const send = readFileSync(resolve(HERE, '../src/screens/SendScreen.tsx'), 'utf8');
  check('the SOL send on devnet reads TESTNET too (its network line said "Solana devnet · Mainnet")',
    send.includes('const testnet = (isEvmKind && evmChain.testnet) || network?.chainId === SOLANA_DEVNET_CAIP2;'));
}

// ---------------------------------------------------------------------------
console.log('check-spl-tokens: the fixes of pass p24-recheck (Send at 0 on Manage Solana tokens, Receive and the SOL send on devnet, the fee line)');
// ---------------------------------------------------------------------------
{
  const read = (rel) => readFileSync(resolve(HERE, rel), 'utf8');
  // Finding 3: Manage Solana tokens offered Send for USDC at a 0 balance while Home hid it.
  const tokensScreen = read('../src/screens/SolanaTokensScreen.tsx');
  const gate = "{splSendLinkShown(\n                  balances.network === network ? balances.rows[formatAssetId(token.assetId)] : undefined,\n                  sendRefusal === null,\n                ) ? (";
  const tokensSendOk = (src) =>
    src.includes(gate) && !src.includes('{sendRefusal === null ? (') &&
    src.includes('const balances = useSplTokens(solanaOwner, solanaDevnet);') &&
    src.includes("const solanaOwner = noKey ? undefined : accounts.find((a) => a.chainId === SOLANA_SLOT_CHAIN_ID)?.address;") &&
    src.includes('const noKey = activeAccount?.watchOnly === true || activeAccount?.multisig === true;') &&
    (src.match(/navigation\.navigate\('SolanaTokenSend'/g) ?? []).length === 1;
  check('Manage Solana tokens: Send follows Home’s rule (splSendLinkShown on the row read like Home’s, for the network listed), so it is hidden at a 0 balance',
    tokensSendOk(tokensScreen));
  check('…the rule it relies on: at a 0 associated balance, before a read, and for a row of another network (undefined) Send is not offered',
    !SPL.splSendLinkShown({ status: 'ok', associated: 0n, outside: 0n, outsideAccounts: 0, decimals: 6, sendRefusal: null, decimalsChanged: false, networkChainId: DEVNET }, true) &&
      !SPL.splSendLinkShown(undefined, true));
  check('…mutant caught: Send gated by the readiness alone again (the p24-recheck finding)',
    !tokensSendOk(tokensScreen.replace(gate, '{sendRefusal === null ? (')));
  check('…mutant caught: rows of another network used for this list',
    !tokensSendOk(tokensScreen.replace('balances.network === network ? balances.rows[formatAssetId(token.assetId)] : undefined', 'balances.rows[formatAssetId(token.assetId)]')));

  // Finding 4: Receive SOL's network line read "Solana" on devnet.
  const receive = read('../src/screens/ReceiveScreen.tsx');
  const receiveLines = [
    'const solanaDevnetSlot = route.params.chainId === SOLANA_CHAIN_ID && solanaDevnet;',
    "const networkName = account ? (isEvmSlot ? evmChain.label : solanaDevnetSlot ? SOLANA_DEVNET_NETWORK.label : account.name) : '';",
    "const coinSymbol = account ? (isEvmSlot ? evmChain.displaySymbol : solanaDevnetSlot ? SOLANA_DEVNET_NETWORK.symbol : account.symbol) : '';",
    '<Text style={[styles.chainName, { color: theme.text }]}>{networkName}</Text>',
  ];
  check('Receive on Solana devnet: the network line and the coin come from the devnet network entry ("Solana devnet", "test SOL"), as Activity’s',
    receiveLines.every((l) => receive.includes(l)) && DEFAULTS.SOLANA_DEVNET_NETWORK.label === 'Solana devnet' && DEFAULTS.SOLANA_DEVNET_NETWORK.symbol === 'test SOL');
  check('…mutant caught: the key provider’s "Solana" restored',
    !receiveLines.every((l) => receive.replace('solanaDevnetSlot ? SOLANA_DEVNET_NETWORK.label : account.name', 'account.name').includes(l)));

  // Finding 5: the SOL send form said "Amount (SOL)" on devnet.
  const send = read('../src/screens/SendScreen.tsx');
  const sendLines = [
    'const solanaDevnetSend = endpoint?.network.chainId === SOLANA_DEVNET_CAIP2;',
    'const symbol = token ? token.symbol : isEvmKind ? evmChain.displaySymbol : solanaDevnetSend ? SOLANA_DEVNET_NETWORK.symbol : account.symbol;',
    "? t('home.token.send', { symbol: solanaDevnetSend ? SOLANA_DEVNET_NETWORK.symbol : account.symbol })",
    ": t('send.field.amount', { symbol }),",
  ];
  check('the SOL send on devnet: the amount label, every confirm row, the prompt and the title use "test SOL" (the devnet network entry), read from the network the endpoint serves',
    sendLines.every((l) => send.includes(l)) &&
      (send.match(/value=\{`\$\{exact\(quote\.(amount|fee|total|balance), decimals\)\} \$\{symbol\}`\}/g) ?? []).length >= 4 &&
      send.includes('sendApprovalPromptTitle(quote, symbol, decimals)'));
  check('…mutant caught: the provider’s "SOL" restored in the amount symbol',
    !sendLines.every((l) => send.replace('solanaDevnetSend ? SOLANA_DEVNET_NETWORK.symbol : account.symbol;', 'account.symbol;').includes(l)));

  // Finding 6: the fee line said "(test SOL on devnet)" under mainnet rows; two forms now (exact texts in check-i18n).
  const home = read('../src/screens/HomeScreen.tsx');
  check('Home: the Solana token-fee line takes the devnet form only for a devnet list',
    home.includes("{t(network === SOLANA_DEVNET_ROW_CAIP2 ? 'home.solanaTokens.feeDevnet' : 'home.solanaTokens.fee')}"));
}

// ---------------------------------------------------------------------------
console.log('check-spl-tokens: mutants of wallet/spl-tokens.ts are caught');
// ---------------------------------------------------------------------------
const SOURCE = readFileSync(SPL_PATH, 'utf8');
const MUTANT_DIR = join(HERE, `.mutants-spl-tokens-${process.pid}`);
process.on('exit', () => rmSync(MUTANT_DIR, { recursive: true, force: true }));
let mutants = 0;
async function mutant(from, to) {
  if (!SOURCE.includes(from)) throw new Error(`mutation anchor not found: ${from}`);
  const originalDir = dirname(SPL_PATH);
  const rewritten = SOURCE.replace(from, to).replace(/(from\s+)'(\.{1,2}\/[^']+)'/g, (_m, kw, spec) => `${kw}'${pathToFileURL(resolve(originalDir, spec)).href}'`);
  mkdirSync(MUTANT_DIR, { recursive: true });
  mutants += 1;
  const file = join(MUTANT_DIR, `m${mutants}-spl-tokens.ts`);
  writeFileSync(file, rewritten);
  return import(pathToFileURL(file).href);
}
let caught = 0;
{
  // M1: the readiness gate removed from the quote → mainnet reaches the RPC.
  const M = await mutant("  assertSplSendAllowed(params.caip2);\n  if (params.token", '  if (params.token');
  const chain = fakeChain();
  const usdcMainnet = (await TOKENS.listSolanaTokens(SOLANA_MAINNET_CAIP2, memoryStore()))[0];
  await rejection(() => M.quoteSplSend(chain.client, { caip2: SOLANA_MAINNET_CAIP2, url: 'x', owner: ALICE.address, recipient: BOB.address, token: usdcMainnet, amountText: '1' }));
  const ok = chain.log.length > 0;
  caught += ok ? 1 : 0;
  check('mutant caught: the quote without its readiness gate makes requests on mainnet', ok);
}
{
  // M2: the stored decimals not passed → a changed mint is quoted silently.
  const M = await mutant('    expectedDecimals: params.token.decimals,\n', '');
  const q = await M.quoteSplSend(fakeChain().client, { caip2: DEVNET, url: 'x', owner: ALICE.address, recipient: BOB.address, token: { ...usdcDevnet, decimals: 9 }, amountText: '0.001' }).catch((e) => e);
  const ok = !(q instanceof Error);
  caught += ok ? 1 : 0;
  check('mutant caught: without expectedDecimals the decimals-changed refusal disappears', ok);
}
{
  // M3: no device check before signing.
  const M = await mutant("  const auth = await deps.requireAuth(splApprovalPromptTitle(q));\n  if (!auth.ok) throw new SplSendCancelledError(auth.message);\n", '');
  const c = fakeChain();
  const q = await quoteOn(c);
  let signs = 0;
  await M.runSplSend({ requireAuth: async () => ({ ok: false, message: 'no' }), signWith: async (_c, _a, fn) => (signs++, fn(ALICE)), client: c.client, second: null, sleep: async () => {} }, q).catch(() => undefined);
  const ok = signs === 1 && c.sent.length === 1;
  caught += ok ? 1 : 0;
  check('mutant caught: a send with no device check would sign and broadcast after a cancelled prompt', ok);
}
{
  // M4: the uninitialized mint becomes trackable.
  const M = await mutant("  if (profile.classification.transferClass === 'not-a-mint') {", "  if (false) {");
  const r = await M.previewMint(fakeChain().client, DEVNET, UNINIT, []).catch((e) => e);
  const ok = !(r instanceof Error);
  caught += ok ? 1 : 0;
  check('mutant caught: an uninitialized mint would be offered for tracking', ok);
}
{
  // M5: a non-associated account counted as sendable.
  const M = await mutant('        if (entry.isAssociated) associated += entry.account.amount;', '        if (true) associated += entry.account.amount;');
  const extra = CAROL.address;
  const chain = fakeChain({ extraAccounts: { [extra]: { owner: SPL_TOKEN_PROGRAM, data: tokenAccountBytes({ mint: USDC, owner: ALICE.address, amount: 250_000n }), lamports: 1n } } });
  const { rows } = await M.loadSplTokenRows(chain.client, ALICE.address, [usdcDevnet], DEVNET);
  const ok = rows[formatAssetId(usdcDevnet.assetId)].associated !== 5_000_000n;
  caught += ok ? 1 : 0;
  check('mutant caught: a balance outside the associated account counted as the sendable one', ok);
}
{
  // M6: the look-alike references drop the known tokens.
  const M = await mutant('    ...KNOWN_SOLANA_TOKENS.filter((t) => t.caip2 === caip2).map((t) => ({ caip2: t.caip2, mint: t.mint, symbol: t.symbol })),\n', '');
  const ok = M.lookAlikeFor(DEVNET, SYNTH.unknown.addr, 'USDC', []) === null;
  caught += ok ? 1 : 0;
  check('mutant caught: a fake "USDC" would not be flagged without the known-token references', ok);
}
{
  // M7: the refusal sentence paraphrased instead of the engine's own text.
  const M = await mutant('    sendRefusal: profile.classification.refusal,\n    lookAlike', "    sendRefusal: profile.classification.refusal ? 'This token cannot be sent.' : null,\n    lookAlike");
  const p = await M.previewMint(fakeChain().client, DEVNET, SYNTH.paused.addr, []);
  const ok = p.sendRefusal !== SPL_SENTENCES.paused;
  caught += ok ? 1 : 0;
  check('mutant caught: a paraphrased refusal differs from the engine’s sentence', ok);
}
{
  // M8: the rent row dropped from the confirm.
  const M = await mutant('  if (quote.createsDestination) {\n    rows.push', '  if (false) {\n    rows.push');
  const q = await quoteOn(fakeChain());
  const ok = !M.splConfirmRows(q, 'test SOL').some((r) => r.label.startsWith('Rent'));
  caught += ok ? 1 : 0;
  check('mutant caught: a confirm without the rent row when the recipient’s account is created', ok);
}
{
  // M9 (pass p24-solana finding 5): the transfer-fee line dropped from the Track prompt.
  const M = await mutant(" ${splTransferFeeLine(preview.transferFee, preview.decimals, symbol)}` : '') +", " ` : '') +");
  const p = await M.previewMint(fakeChain().client, DEVNET, PYUSD, []);
  const ok = !M.trackPrompt(p, 'PYUSD').message.includes('Transfer fee: 0 basis points');
  caught += ok ? 1 : 0;
  check('mutant caught: a Track prompt for a fee-charging mint that does not mention its fee', ok);
}
{
  // M10 (finding 7): the Send link offered at a 0 associated balance again.
  const M = await mutant('    state.associated > 0n\n', '    state.associated >= 0n\n');
  const ok = M.splSendLinkShown({ status: 'ok', associated: 0n, outside: 0n, outsideAccounts: 0, decimals: 6, sendRefusal: null, decimalsChanged: false, networkChainId: DEVNET }, true);
  caught += ok ? 1 : 0;
  check('mutant caught: "Send" offered with nothing in the associated account', ok);
}
{
  // M11 (finding 2): the banner shown whatever the switch.
  const M = await mutant('  return solanaDevnet === true && slotChainId === SOLANA_SLOT_CHAIN_ID;', '  return slotChainId === SOLANA_SLOT_CHAIN_ID;');
  const ok = M.solanaDevnetBannerShown(SOLANA_MAINNET_CAIP2, false);
  caught += ok ? 1 : 0;
  check('mutant caught: a devnet banner on Solana mainnet', ok);
}
check(`at least six mutants, all caught (${caught} of ${mutants})`, mutants >= 6 && caught === mutants);

console.log(`\ncheck-spl-tokens: ${passed} passed, ${failed} failed (${mutants} mutants)`);
process.exit(failed === 0 ? 0 : 1);
