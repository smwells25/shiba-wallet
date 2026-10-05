// ENS names in the Send recipient field (phase 14 item 2, feature 74).
// Offline by default (fake JSON-RPC answers only); `--live` adds read-only
// lookups through the app's keyless default RPCs on Ethereum mainnet and
// Sepolia (no keys, nothing signed or sent).
//
// Covers the app glue in src/wallet/ens-names.ts over the engine's
// Universal Resolver lookup (packages/chains-evm/src/ens.ts, which has its
// own vitest suite): the registry chosen per active network (mainnet ENS,
// ENS on Sepolia, refused on Base Sepolia), the supported-name rule and its
// sentences, every refusal (offchain / CCIP-Read, unregistered, no address,
// resolver errors), the Review-time re-check, that the app transport keeps
// the revert data the engine needs, source checks on the Send screen, and
// mutation checks.
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-names.mjs [--live]

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AbiCoder, Interface, dnsEncode, namehash } from 'ethers';
import { ENS_UNIVERSAL_RESOLVER } from '@shiba-wallet/chains-evm';
import {
  describeNameError,
  ensPrivacyNote,
  ensRegistryFor,
  looksLikeName,
  lookUpRecipientName,
  nameChangedSentence,
  nameProblemSentence,
  recheckRecipientName,
  resolvedNameLine,
} from '../src/wallet/ens-names.ts';
import { simulationTransport } from '../src/wallet/simulation.ts';
import { EVM_BASE_SEPOLIA, EVM_MAINNET, EVM_SEPOLIA } from '../src/config/evm-chain.ts';

const LIVE = process.argv.includes('--live');
const json = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));
let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!ok && detail !== undefined) console.log(`      ${detail}`);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (rel) => readFileSync(join(HERE, '..', 'src', rel), 'utf8');
const MUTANT_DIR = join(HERE, `.mutants-names-${process.pid}`);
let mutants = 0;
process.on('exit', () => rmSync(MUTANT_DIR, { recursive: true, force: true }));
async function importMutant(relPath, source) {
  const originalDir = dirname(join(HERE, '..', relPath));
  const rewritten = source.replace(/(from\s+)'(\.{1,2}\/[^']+)'/g, (_m, kw, spec) => `${kw}'${pathToFileURL(resolvePath(originalDir, spec)).href}'`);
  mkdirSync(MUTANT_DIR, { recursive: true });
  mutants += 1;
  const file = join(MUTANT_DIR, `m${mutants}-${relPath.split('/').pop()}`);
  writeFileSync(file, rewritten);
  return import(pathToFileURL(file).href);
}

const ur = new Interface([
  'function resolve(bytes name, bytes data) view returns (bytes result, address resolver)',
  'function addr(bytes32 node) view returns (address)',
  'error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData)',
  'error ResolverNotFound(bytes name)',
  'error ResolverError(bytes errorData)',
]);
const coder = AbiCoder.defaultAbiCoder();
const NICK = '0xb8c2C29ee19D8307cb7255e1Cd9CbDE883A267d5';
const OTHER = '0x2222222222222222222222222222222222222222';
const RESOLVER = '0x4976fb03C32e5B8cfe2b6cCB31c09Ba78EBaBa41';

/** A fake JSON-RPC node behind a fake fetch, used through the app's own simulationTransport. */
function fakeEndpoint(chainId, answer) {
  const calls = [];
  const fetchFn = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.method);
    const reply = (obj, status = 200) => ({ ok: status < 400, status, json: async () => ({ jsonrpc: '2.0', id: body.id, ...obj }) });
    if (body.method === 'eth_chainId') return reply({ result: '0x' + chainId.toString(16) });
    if (body.method === 'eth_call') {
      const [call] = body.params;
      if (call.to !== ENS_UNIVERSAL_RESOLVER) return reply({ error: { code: -32000, message: 'wrong contract' } });
      const a = answer(call.data);
      if (a.result !== undefined) return reply({ result: a.result });
      if (a.revert !== undefined) return reply({ error: { code: 3, message: 'execution reverted', data: a.revert } });
      if (a.httpStatus !== undefined) return { ok: false, status: a.httpStatus, json: async () => { throw new SyntaxError('no json'); } };
    }
    return reply({ error: { code: -32601, message: 'method not found' } });
  };
  return { transport: simulationTransport('https://fake.example/rpc', fetchFn), calls };
}
const okAnswer = (address) => ({ result: ur.encodeFunctionResult('resolve', [coder.encode(['address'], [address]), RESOLVER]) });

// ---------------------------------------------------------------------------
console.log('\n# registry per network');
{
  const m = ensRegistryFor(EVM_MAINNET);
  check('mainnet → mainnet ENS (chain 1)', m.ok && m.chainId === 1n && m.label === 'ENS on Ethereum mainnet');
  const s = ensRegistryFor(EVM_SEPOLIA);
  check('Ethereum Sepolia → ENS on Sepolia, said to be separate from mainnet names',
    s.ok && s.chainId === 11155111n && s.label === 'ENS on Ethereum Sepolia (test-network names, separate from mainnet names)');
  const b = ensRegistryFor(EVM_BASE_SEPOLIA);
  check('Base Sepolia → refused with the plain reason',
    !b.ok && b.reason === 'ENS names are not looked up on Base Sepolia. ENS lives on Ethereum, and a name’s address for another network is a separate record that this wallet does not read yet. Paste the address instead.', json(b));
}

console.log('\n# what counts as a name');
for (const [text, expected] of [
  ['nick.eth', true],
  ['  Nick.ETH ', true],
  ['sub.domain.box', true],
  ['0x1234.eth', false], // hexadecimal input always stays on the address path
  ['0xb8c2C29ee19D8307cb7255e1Cd9CbDE883A267d5', false],
  ['nick', false],
  ['', false],
]) {
  check(`looksLikeName(${JSON.stringify(text)}) = ${expected}`, looksLikeName(text) === expected);
}
check('sentence: not-ascii-subset', nameProblemSentence('not-ascii-subset') === 'Only names made of the letters a–z, digits 0–9, hyphens and dots are supported yet (no accents, other scripts, emoji, "_" or "$"). Paste the address instead.');
check('sentence: single-label', nameProblemSentence('single-label') === 'A name needs at least one dot, for example name.eth.');
check('sentence: empty-label', nameProblemSentence('empty-label') === 'This name has an empty part (two dots together, or a dot at the start or end).');
check('sentence: label-extension', /hyphen as both the third and fourth character/.test(nameProblemSentence('label-extension')));
check('privacy note names the endpoint host only', ensPrivacyNote('https://ethereum.publicnode.com/some/key') === 'Names are looked up through your network endpoint (ethereum.publicnode.com), which sees the name you looked up.');

console.log('\n# lookups through fakes');
{
  const node = fakeEndpoint(1n, (data) => {
    const expected = ur.encodeFunctionData('resolve', [dnsEncode('nick.eth'), ur.encodeFunctionData('addr', [namehash('nick.eth')])]);
    return data === expected ? okAnswer(NICK) : { revert: '0xdeadbeef' };
  });
  const r = await lookUpRecipientName(node.transport, '  Nick.ETH ', EVM_MAINNET);
  check('Nick.ETH is normalized to nick.eth and resolved through the Universal Resolver',
    r.kind === 'resolved' && r.resolution.name === 'nick.eth' && r.resolution.address === NICK && r.registryLabel === 'ENS on Ethereum mainnet', json(r));
  check('…after checking eth_chainId first', node.calls.join(',') === 'eth_chainId,eth_call');
  check('resolved line shows name → full address and that the address is what is used',
    resolvedNameLine(r.resolution, r.registryLabel) === `nick.eth → ${NICK} (resolved by ENS on Ethereum mainnet). The address, not the name, is what will be used.`);
}
{
  const offchain = ur.encodeErrorResult('OffchainLookup', [ENS_UNIVERSAL_RESOLVER, ['https://ccip-v3.ens.xyz', 'x-batch-gateway:true'], '0xa780bab6', '0x12345678', '0x']);
  const node = fakeEndpoint(1n, () => ({ revert: offchain }));
  const r = await lookUpRecipientName(node.transport, 'jesse.base.eth', EVM_MAINNET);
  check('offchain (CCIP-Read) name → refused with the plain reason, and the gateway is never contacted',
    r.kind === 'refused' && r.message === 'jesse.base.eth is stored off-chain: looking it up needs a request to a server chosen by the name’s resolver (CCIP-Read). This wallet does not make those requests, so the name cannot be used here. Paste the address instead.' && node.calls.every((m) => m === 'eth_chainId' || m === 'eth_call'), json(r));
}
{
  const node = fakeEndpoint(1n, () => ({ revert: ur.encodeErrorResult('ResolverNotFound', [dnsEncode('nope-zz9.eth')]) }));
  const r = await lookUpRecipientName(node.transport, 'nope-zz9.eth', EVM_MAINNET);
  check('unregistered name → "is not registered with ENS on Ethereum mainnet"',
    r.kind === 'refused' && r.message === 'nope-zz9.eth is not registered with ENS on Ethereum mainnet (it has no resolver). Check the spelling, or paste the address.', json(r));
}
{
  const node = fakeEndpoint(11155111n, () => okAnswer('0x' + '00'.repeat(20)));
  const r = await lookUpRecipientName(node.transport, 'ens.eth', EVM_SEPOLIA);
  check('zero address on Sepolia → "has no Ethereum address set", naming the Sepolia registry',
    r.kind === 'refused' && r.message === 'ens.eth exists in ENS on Ethereum Sepolia (test-network names, separate from mainnet names) but has no Ethereum address set. Paste the address instead.', json(r));
}
{
  const node = fakeEndpoint(1n, () => ({ revert: ur.encodeErrorResult('ResolverError', ['0x']) }));
  const r = await lookUpRecipientName(node.transport, 'broken.eth', EVM_MAINNET);
  check('resolver error → refused', r.kind === 'refused' && /its resolver returned an error/.test(r.message));
}
{
  const node = fakeEndpoint(84532n, () => okAnswer(NICK));
  const r = await lookUpRecipientName(node.transport, 'nick.eth', EVM_BASE_SEPOLIA);
  check('Base Sepolia → refused before any request', r.kind === 'refused' && /not looked up on Base Sepolia/.test(r.message) && node.calls.length === 0);
}
{
  const node = fakeEndpoint(11155111n, () => okAnswer(NICK));
  const r = await lookUpRecipientName(node.transport, 'nick.eth', EVM_MAINNET);
  check('an endpoint serving the wrong chain → refused, no eth_call', r.kind === 'refused' && /answered for a different network/.test(r.message) && node.calls.join(',') === 'eth_chainId');
}
for (const name of ['nıck.eth', 'pаypal.eth', 'xn--abc.eth', 'nick_.eth', 'nick', 'a..eth']) {
  const node = fakeEndpoint(1n, () => okAnswer(NICK));
  const r = await lookUpRecipientName(node.transport, name, EVM_MAINNET);
  check(`unsupported name ${JSON.stringify(name)} → refused with no request`, r.kind === 'refused' && node.calls.length === 0, json(r));
}
{
  const node = fakeEndpoint(1n, () => ({ httpStatus: 503 }));
  let threw = null;
  try {
    await lookUpRecipientName(node.transport, 'nick.eth', EVM_MAINNET);
  } catch (e) {
    threw = e;
  }
  check('a transport failure (HTTP 503) is rethrown for the failover rule, not turned into an answer', threw !== null && /RPC HTTP error 503/.test(threw.message));
  check('…and its sentence is about the connection', describeNameError(threw, 'nick.eth', '') === 'The name nick.eth could not be looked up right now. Check your connection and try again, or paste the address.');
}

console.log('\n# Review-time re-check');
{
  const shown = { name: 'nick.eth', address: NICK, chainId: 1n };
  const same = await recheckRecipientName(fakeEndpoint(1n, () => okAnswer(NICK.toLowerCase())).transport, shown, 'ENS on Ethereum mainnet');
  check('same address → same', same.kind === 'same');
  const moved = await recheckRecipientName(fakeEndpoint(1n, () => okAnswer(OTHER)).transport, shown, 'ENS on Ethereum mainnet');
  check('changed address → stops the review with the pinned sentence and carries the new address',
    moved.kind === 'changed' && moved.resolution.address === OTHER && moved.message === nameChangedSentence('nick.eth') &&
    moved.message === 'The name nick.eth now points to a different address than the one shown. Check the new address below, then tap Review again.');
  const gone = await recheckRecipientName(fakeEndpoint(1n, () => ({ revert: ur.encodeErrorResult('ResolverNotFound', ['0x00']) })).transport, shown, 'ENS on Ethereum mainnet');
  check('name stopped resolving → refused (the old address is never reused)', gone.kind === 'refused' && /not registered/.test(gone.message));
}

console.log('\n# Send screen (source checks)');
const send = src('screens/SendScreen.tsx');
check('names are looked up only on the EVM slot and through the endpoint failover rule',
  send.includes('route.params.chainId === EVM_CHAIN_ID && looksLikeName(recipient)') &&
  send.includes('withEndpoint(EVM_CHAIN_ID, (ep) => lookUpRecipientName(simulationTransport(ep.url), input, evmChain))'));
check('validation sees the RESOLVED address, never the name',
  /if \(nameKey\) \{\s*return nameResolvedAddress \? validateRecipient\(route\.params\.chainId, nameResolvedAddress\) : null;\s*\}/.test(send));
check('the name is never written into the recipient field as an address', !/setRecipient\([^)]*(resolution|nameResolvedAddress|nameView)/.test(send));
check('Review requires a shown, resolved address and re-checks it before quoting',
  send.includes("if (!nameView || nameView.status !== 'resolved' || !nameRegistry.ok) {") &&
  send.includes('recheckRecipientName(') && send.indexOf('recheckRecipientName(') < send.indexOf('const recipientAddress = validation.normalized;'));
check('every confirm variant shows the name line next to the recipient (4)', (send.match(/\{renderNameNote\(quote\.to\)\}/g) ?? []).length === 4);
check('the privacy sentence is shown with lookups', send.includes('privacyNote={nameRegistry.ok ? ensPrivacyNote(nameState?.url ?? url) : null}'));
check('typing an address never waits for a lookup (debounced effect keyed on names only)', send.includes('}, 450);') && send.includes('const nameKey ='));

console.log('\n# mutation checks');
{
  const ens = src('wallet/ens-names.ts');
  const m1 = await importMutant('src/wallet/ens-names.ts', ens.replace("if (profile.chainIdDecimal === '11155111') {", "if (profile.chainIdDecimal === '11155111' || profile.chainIdDecimal === '84532') {"));
  check('M1 caught: a Base Sepolia lookup through the Sepolia registry fails the registry check', m1.ensRegistryFor(EVM_BASE_SEPOLIA).ok === true && ensRegistryFor(EVM_BASE_SEPOLIA).ok === false);
  const m2 = await importMutant('src/wallet/ens-names.ts', ens.replace("if (changed) return { kind: 'changed'", "if (false) return { kind: 'changed'"));
  const r2 = await m2.recheckRecipientName(fakeEndpoint(1n, () => okAnswer(OTHER)).transport, { name: 'nick.eth', address: NICK, chainId: 1n }, 'x');
  check('M2 caught: a re-check that ignores a changed address answers "same"', r2.kind === 'same');
  const m3 = await importMutant('src/wallet/ens-names.ts', ens.replace("return t.includes('.') && !/^0x/i.test(t);", "return t.includes('.');"));
  check('M3 caught: hexadecimal input would be treated as a name', m3.looksLikeName('0x1234.eth') === true && looksLikeName('0x1234.eth') === false);
}

if (LIVE) {
  console.log('\n# live (read-only, keyless default RPCs)');
  async function liveLookup(profile, name) {
    for (const url of profile.defaultRpcUrls) {
      try {
        return { url, r: await lookUpRecipientName(simulationTransport(url), name, profile) };
      } catch {
        // The next default candidate, like the app's failover rule.
      }
    }
    return { url: null, r: null };
  }
  const host = (u) => (u ? new URL(u).host : 'none');
  for (const [profile, name, expect] of [
    [EVM_MAINNET, 'nick.eth', NICK],
    [EVM_MAINNET, 'vitalik.eth', '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'],
    // The ENS docs' test case: through the Universal Resolver this name
    // resolves to 0x2222…; without it, to 0x1111….
    [EVM_MAINNET, 'ur.integration-tests.eth', OTHER],
    [EVM_SEPOLIA, 'nick.eth', NICK],
  ]) {
    const { url, r } = await liveLookup(profile, name);
    check(`LIVE ${profile.label}: ${name} → ${expect} (via ${host(url)})`, r?.kind === 'resolved' && r.resolution.address === expect, json(r));
  }
  const off = await liveLookup(EVM_MAINNET, 'jesse.base.eth');
  check(`LIVE mainnet: jesse.base.eth (offchain) → refused as CCIP-Read (via ${host(off.url)})`, off.r?.kind === 'refused' && /off-chain/.test(off.r.message), json(off.r));
  const none = await liveLookup(EVM_MAINNET, 'shiba-wallet-no-such-name-zz9.eth');
  check(`LIVE mainnet: an unregistered name → not registered (via ${host(none.url)})`, none.r?.kind === 'refused' && /not registered/.test(none.r.message), json(none.r));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
