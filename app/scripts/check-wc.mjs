// Exercises the app's WalletConnect glue (src/wallet/walletconnect.ts)
// entirely OFFLINE: a FAKED WalletKit client object records every
// approve/reject/respond call, and a faked global fetch answers the
// JSON-RPC requests that the eth_sendTransaction path makes through the
// real prepareEvmSend/sendEvm machinery. No relay connection is opened,
// no network request leaves the process, nothing is broadcast.
//
// Covered: project-id store round-trip and validation, namespace
// construction (against the real @walletconnect/utils
// buildApprovedNamespaces), proposal approval/rejection including the
// unsupported-chain reject path, session request routing for
// personal_sign / eth_signTypedData_v4 / eth_sendTransaction plus every
// decline case, EIP-191 digest correctness against BOTH the engine's
// toEthSignedMessageHash (32-byte case) and ethers.hashMessage (general
// case), EIP-712 digests and signatures verified with
// ethers.TypedDataEncoder/verifyTypedData, signature recovery with
// ethers.verifyMessage, the full eth_sendTransaction pipeline (parse ->
// prepareEvmSend quote with calldata -> sendEvm) with the broadcast raw
// transaction decoded by ethers.Transaction.from and checked field by
// field, and the JSON-RPC response shapes.
//
// Like check-aa.mjs, it imports the actual TypeScript modules the app runs
// via Node's native type stripping. Run from the app directory:
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-wc.mjs
//
// The signing key derives from the standard BIP-39 test mnemonic
// ("abandon ... about"), whose addresses are public knowledge.

import { evmKeyProvider, mnemonicToSeed } from '@shiba-wallet/core';
import { toEthSignedMessageHash, toHex } from '@shiba-wallet/chains-evm';
import {
  ethers,
} from 'ethers';
import {
  WC_ERRORS,
  WC_SIGNING_METHODS,
  WC_SUPPORTED_CHAINS,
  WC_SUPPORTED_METHODS,
  WcRequestRejection,
  approveProposal,
  buildWalletNamespaces,
  clearWcProjectId,
  decodeMessageForDisplay,
  describeProposal,
  disconnectWcSession,
  DEFAULT_WC_PROJECT_ID,
  getWcProjectId,
  parseTypedDataV4,
  parseWcRequest,
  personalMessageDigest,
  rejectProposal,
  respondApproved,
  respondRejected,
  setWcProjectId,
  signDigest,
  summarizeSessions,
  validatePairingUri,
  wcError,
  wcResult,
  decideProposal,
  decideSwitchChain,
  declineProposal,
  describeChain,
  getWcUsed,
  modeMismatchMessage,
  sessionChainsOf,
  sessionModeNote,
  setWcUsed,
  shouldStartWalletConnectAtLaunch,
  IDENTITY_RISK_SWITCH_LABEL,
  describeVerifyContext,
  identityApprovalAllowed,
  WC_REQUOTED_NOTE,
  quoteWcTransaction,
  requoteWcTransactionIfMoved,
} from '../src/wallet/walletconnect.ts';
import { forgetDefaultEndpointChoices } from '../src/config/networks.ts';
import { DEFAULT_NETWORKS } from '../src/config/defaults.ts';
import { WcController } from '../src/wallet/wc-controller.ts';
import { EVM_MAINNET, EVM_SEPOLIA } from '../src/config/evm-chain.ts';
import { prepareEvmSend, sendEvm } from '../src/wallet/send.ts';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

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

// --------------------------------------------------------------- fixtures

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seed = mnemonicToSeed(TEST_MNEMONIC);
const account = evmKeyProvider.deriveAccount(seed, 0, 0);
const ADDRESS = account.address;

function memoryStore() {
  const map = new Map();
  return {
    getItem: async (k) => (map.has(k) ? map.get(k) : null),
    setItem: async (k, v) => void map.set(k, v),
    _map: map,
  };
}

/** FAKE WalletKit client: records calls, returns canned sessions. */
function fakeClient() {
  const calls = { approve: [], reject: [], respond: [], disconnect: [], pair: [] };
  return {
    calls,
    pair: async (args) => void calls.pair.push(args),
    approveSession: async (args) => {
      calls.approve.push(args);
      return { topic: 'topic-1' };
    },
    rejectSession: async (args) => void calls.reject.push(args),
    respondSessionRequest: async (args) => void calls.respond.push(args),
    disconnectSession: async (args) => void calls.disconnect.push(args),
    getActiveSessions: () => ({}),
    on: () => {},
    off: () => {},
  };
}

// A realistic session proposal params struct (sign-client shape).
function proposalParams(requiredChains, optionalChains = []) {
  const ns = (chains) => ({
    chains,
    methods: ['personal_sign', 'eth_sendTransaction', 'eth_signTypedData_v4'],
    events: ['accountsChanged', 'chainChanged'],
  });
  return {
    id: 42,
    proposer: {
      publicKey: 'aa'.repeat(32),
      metadata: {
        name: 'Fake dApp',
        description: 'Offline test dApp',
        url: 'https://dapp.example',
        icons: [],
      },
    },
    requiredNamespaces: requiredChains.length ? { eip155: ns(requiredChains) } : {},
    optionalNamespaces: optionalChains.length ? { eip155: ns(optionalChains) } : {},
    relays: [{ protocol: 'irn' }],
  };
}

// ------------------------------------------------------------------ run

console.log('check-wc: project id store');
{
  const store = memoryStore();
  check('unset id reads as the shipped default', (await getWcProjectId(store)) === DEFAULT_WC_PROJECT_ID);
  const saved = await setWcProjectId('  0123456789abcdef0123456789abcdef  ', store);
  check('save trims', saved === '0123456789abcdef0123456789abcdef');
  check('round-trip', (await getWcProjectId(store)) === saved);
  await checkRejects('URL rejected', () => setWcProjectId('https://reown.com/x', store), 'project id');
  await checkRejects('whitespace rejected', () => setWcProjectId('abc def', store), 'project id');
  await checkRejects('too short rejected', () => setWcProjectId('abc', store), 'project id');
  await clearWcProjectId(store);
  check('clear restores the shipped default', (await getWcProjectId(store)) === DEFAULT_WC_PROJECT_ID);
  store._map.set('shiba-wallet.wc-config.v1', '{not json');
  check('corrupt JSON falls back to the shipped default', (await getWcProjectId(store)) === DEFAULT_WC_PROJECT_ID);
}

console.log('check-wc: namespaces + proposals');
{
  const ns = buildWalletNamespaces(proposalParams(['eip155:1']), ADDRESS);
  check('eip155 namespace built', typeof ns.eip155 === 'object');
  check(
    'account is CAIP-10 on eip155:1',
    JSON.stringify(ns.eip155.accounts) === JSON.stringify([`eip155:1:${ADDRESS}`]),
    JSON.stringify(ns.eip155.accounts),
  );
  check(
    'approved methods are exactly the signing set the dApp asked for',
    WC_SIGNING_METHODS.every((m) => ns.eip155.methods.includes(m)) &&
      ns.eip155.methods.length === WC_SIGNING_METHODS.length,
    JSON.stringify(ns.eip155.methods),
  );
  await checkRejects(
    'required unsupported chain throws (buildApprovedNamespaces)',
    async () => buildWalletNamespaces(proposalParams(['eip155:137']), ADDRESS),
    'chains',
  );

  const client = fakeClient();
  const ok = await approveProposal(client, { id: 42, params: proposalParams(['eip155:1']) }, ADDRESS);
  check('approveProposal approves supported proposal', ok.approved === true);
  check('approveSession got the id', client.calls.approve[0]?.id === 42);
  check(
    'approveSession namespaces carry the account',
    client.calls.approve[0]?.namespaces?.eip155?.accounts?.[0] === `eip155:1:${ADDRESS}`,
  );

  const client2 = fakeClient();
  const bad = await approveProposal(
    client2,
    { id: 7, params: proposalParams(['eip155:137']) },
    ADDRESS,
  );
  check('unsupported proposal reports approved:false', bad.approved === false);
  check(
    'unsupported proposal rejected with UNSUPPORTED_CHAINS (5100)',
    client2.calls.reject[0]?.id === 7 && client2.calls.reject[0]?.reason?.code === 5100,
    JSON.stringify(client2.calls.reject),
  );

  const client3 = fakeClient();
  await rejectProposal(client3, 9);
  check(
    'rejectProposal sends USER_REJECTED (5000)',
    client3.calls.reject[0]?.id === 9 && client3.calls.reject[0]?.reason?.code === 5000,
  );

  const summary = describeProposal({ id: 42, params: proposalParams(['eip155:1'], ['eip155:10']) });
  check('describeProposal reads metadata', summary.name === 'Fake dApp' && summary.url === 'https://dapp.example');
  check(
    'describeProposal splits required/optional chains',
    summary.requiredChains.includes('eip155:1') && summary.optionalChains.includes('eip155:10'),
  );
  check('describeProposal flags nothing for eip155:1', summary.unsupportedRequired.length === 0);
  const summary2 = describeProposal({ id: 1, params: proposalParams(['eip155:137']) });
  check(
    'describeProposal flags unsupported required chain',
    summary2.unsupportedRequired.includes('eip155:137'),
  );
}

console.log('check-wc: EIP-191 digest (vs engine helper and ethers)');
{
  // General case: ethers.hashMessage implements the same EIP-191 0x45
  // construction; byte-identity here proves the length-prefixed digest.
  for (const msg of ['hello world', '', 'wow much sign', 'ünïcødé 🐕']) {
    const bytes = new TextEncoder().encode(msg);
    const ours = toHex(personalMessageDigest(bytes));
    const theirs = ethers.hashMessage(msg);
    check(`digest matches ethers.hashMessage(${JSON.stringify(msg)})`, ours === theirs, `${ours} vs ${theirs}`);
  }
  // 32-byte special case: must equal the engine's toEthSignedMessageHash.
  const digest32 = new Uint8Array(32).fill(7);
  check(
    '32-byte message digest equals engine toEthSignedMessageHash',
    toHex(personalMessageDigest(digest32)) === toHex(toEthSignedMessageHash(digest32)),
  );
  // Signature recovery: sign like the app does, verify like a dApp does.
  const message = 'Shiba Wallet WalletConnect test vector';
  const sig = signDigest(account, personalMessageDigest(new TextEncoder().encode(message)));
  check(
    'ethers.verifyMessage recovers the wallet address',
    ethers.verifyMessage(message, sig).toLowerCase() === ADDRESS.toLowerCase(),
    ethers.verifyMessage(message, sig),
  );
}

console.log('check-wc: request routing — personal_sign');
{
  const msgHex = toHex(new TextEncoder().encode('hello dApp'));
  const event = (params, method = 'personal_sign', chainId = 'eip155:1') => ({
    id: 1,
    topic: 't',
    params: { request: { method, params }, chainId },
  });

  const parsed = parseWcRequest(event([msgHex, ADDRESS]), ADDRESS);
  check('routes to personal_sign', parsed.kind === 'personal_sign');
  check('hex message decoded to bytes', parsed.messageText === 'hello dApp');
  check(
    'digest matches ethers for the routed message',
    toHex(parsed.digest) === ethers.hashMessage('hello dApp'),
  );

  const swapped = parseWcRequest(event([ADDRESS, 'plain text message']), ADDRESS);
  check(
    'swapped [address, message] order handled',
    swapped.kind === 'personal_sign' && swapped.messageText === 'plain text message',
  );

  await checkRejects(
    'wrong signer refused',
    async () => parseWcRequest(event([msgHex, '0x' + '11'.repeat(20)]), ADDRESS),
    'not this wallet',
  );
  try {
    parseWcRequest(event([msgHex, ADDRESS], 'personal_sign', 'eip155:137'), ADDRESS);
    check('wrong chain refused', false);
  } catch (e) {
    check('wrong chain refused with 5100', e instanceof WcRequestRejection && e.code === 5100, e.message);
  }
  try {
    parseWcRequest(event(['0xdead', ADDRESS], 'eth_sign'), ADDRESS);
    check('unsupported method refused', false);
  } catch (e) {
    check(
      'unsupported method refused with 5101',
      e instanceof WcRequestRejection && e.code === 5101,
      e.message,
    );
  }
  check(
    'non-printable bytes display as null (hex fallback)',
    decodeMessageForDisplay(new Uint8Array([0x00, 0x01, 0xff])) === null,
  );
}

console.log('check-wc: request routing — eth_signTypedData_v4 (vs ethers)');
{
  // The EIP-712 specification's own Mail example, pinned to chainId 1.
  const domain = {
    name: 'Ether Mail',
    version: '1',
    chainId: 1,
    verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC',
  };
  const types = {
    Person: [
      { name: 'name', type: 'string' },
      { name: 'wallet', type: 'address' },
    ],
    Mail: [
      { name: 'from', type: 'Person' },
      { name: 'to', type: 'Person' },
      { name: 'contents', type: 'string' },
    ],
  };
  const message = {
    from: { name: 'Cow', wallet: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826' },
    to: { name: 'Bob', wallet: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB' },
    contents: 'Hello, Bob!',
  };
  const fullTypes = {
    EIP712Domain: [
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ],
    ...types,
  };
  const json = JSON.stringify({ types: fullTypes, primaryType: 'Mail', domain, message });

  const td = parseTypedDataV4(json);
  const expectedDigest = ethers.TypedDataEncoder.hash(domain, types, message);
  check('typed-data digest matches ethers.TypedDataEncoder.hash', toHex(td.digest) === expectedDigest, toHex(td.digest));

  const sig = signDigest(account, td.digest);
  check(
    'ethers.verifyTypedData recovers the wallet address',
    ethers.verifyTypedData(domain, types, message, sig).toLowerCase() === ADDRESS.toLowerCase(),
  );

  const event = {
    id: 2,
    topic: 't',
    params: { request: { method: 'eth_signTypedData_v4', params: [ADDRESS, json] }, chainId: 'eip155:1' },
  };
  const routed = parseWcRequest(event, ADDRESS);
  check('routes to typed_data', routed.kind === 'typed_data');
  check('routed digest identical', toHex(routed.typedData.digest) === expectedDigest);

  // Decline cases (documented in parseTypedDataV4).
  await checkRejects(
    'foreign-chain domain declined',
    async () => parseTypedDataV4(JSON.stringify({ types: fullTypes, primaryType: 'Mail', domain: { ...domain, chainId: 137 }, message })),
    'only signs',
  );
  await checkRejects(
    'unknown domain field declined',
    async () => parseTypedDataV4(JSON.stringify({ types: fullTypes, primaryType: 'Mail', domain: { ...domain, weird: 1 }, message })),
    'domain field',
  );
  await checkRejects(
    'mis-declared EIP712Domain order declined',
    async () =>
      parseTypedDataV4(
        JSON.stringify({
          types: {
            ...fullTypes,
            EIP712Domain: [...fullTypes.EIP712Domain].reverse(),
          },
          primaryType: 'Mail',
          domain,
          message,
        }),
      ),
    'canonical',
  );
  await checkRejects(
    'bare EIP712Domain primaryType declined',
    async () => parseTypedDataV4(JSON.stringify({ types: fullTypes, primaryType: 'EIP712Domain', domain, message: {} })),
    'bare EIP712Domain',
  );
  await checkRejects('malformed JSON declined', async () => parseTypedDataV4('{nope'), 'not valid JSON');
  // Absent chainId is legitimate (off-chain domains) and must pass.
  const noChain = parseTypedDataV4(
    JSON.stringify({
      types: { EIP712Domain: [{ name: 'name', type: 'string' }], ...types },
      primaryType: 'Mail',
      domain: { name: 'snapshot-style' },
      message,
    }),
  );
  check(
    'chainId-less domain allowed and matches ethers',
    toHex(noChain.digest) === ethers.TypedDataEncoder.hash({ name: 'snapshot-style' }, types, message),
  );
}

console.log('check-wc: request routing — eth_sendTransaction mapping');
{
  const to = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'; // checksummed
  const calldata = '0xa9059cbb' + '00'.repeat(64);
  const event = (tx) => ({
    id: 3,
    topic: 't',
    params: { request: { method: 'eth_sendTransaction', params: [tx] }, chainId: 'eip155:1' },
  });

  const parsed = parseWcRequest(
    event({ from: ADDRESS.toLowerCase(), to: to.toLowerCase(), value: '0x2386f26fc10000', data: calldata, gas: '0x5208', gasPrice: '0x1' }),
    ADDRESS,
  );
  check('routes to transaction', parsed.kind === 'transaction');
  check('recipient normalized to EIP-55', parsed.tx.to === to, parsed.tx.to);
  check('value parsed as wei bigint', parsed.tx.valueWei === 10000000000000000n);
  check('calldata parsed to bytes', toHex(parsed.tx.data) === calldata);

  const viaInput = parseWcRequest(event({ to, input: calldata }), ADDRESS);
  check('geth-style input alias accepted', toHex(viaInput.tx.data) === calldata);
  check('missing value defaults to 0', viaInput.tx.valueWei === 0n);

  await checkRejects(
    'foreign from refused',
    async () => parseWcRequest(event({ from: '0x' + '22'.repeat(20), to }), ADDRESS),
    'not this wallet',
  );
  await checkRejects(
    'contract deployment (no to) declined',
    async () => parseWcRequest(event({ data: calldata }), ADDRESS),
    'deployment',
  );
  await checkRejects(
    'bad checksum recipient refused',
    async () => parseWcRequest(event({ to: to.slice(0, -1) + (to.endsWith('8') ? '9' : '8') }), ADDRESS),
    'checksum',
  );
  await checkRejects(
    'garbage value refused',
    async () => parseWcRequest(event({ to, value: '0xzz' }), ADDRESS),
    'unreadable value',
  );
}

console.log('check-wc: eth_sendTransaction end-to-end (fake fetch, real machinery)');
{
  // Fake JSON-RPC node behind global fetch: prepareEvmSend and sendEvm run
  // their REAL code paths (chain-id verification, fee suggestion, gas
  // estimation with calldata, eth_call simulation, EIP-1559 signing,
  // eth_sendRawTransaction) without any network.
  const to = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
  const calldata = '0xa9059cbb' + '11'.repeat(32) + '22'.repeat(32);
  let broadcastRaw = null;
  let estimateSawData = null;
  let callSawData = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const { id, method, params } = JSON.parse(init.body);
    const reply = (result) => ({
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id, result }),
    });
    switch (method) {
      case 'eth_chainId':
        return reply('0x1');
      case 'eth_getBalance':
        return reply('0x' + (10n ** 18n).toString(16)); // 1 ETH
      case 'eth_getTransactionCount':
        return reply('0x5');
      case 'eth_getBlockByNumber':
        return reply({ baseFeePerGas: '0x3b9aca00' }); // 1 gwei
      case 'eth_maxPriorityFeePerGas':
        return reply('0x3b9aca00'); // 1 gwei
      case 'eth_estimateGas':
        estimateSawData = params[0]?.data ?? null;
        return reply('0xc350'); // 50000
      case 'eth_call':
        callSawData = params[0]?.data ?? null;
        return reply('0x'); // success, empty return
      case 'eth_sendRawTransaction': {
        broadcastRaw = params[0];
        return reply('0x' + '42'.repeat(32));
      }
      default:
        throw new Error(`fake node: unexpected method ${method}`);
    }
  };
  try {
    const quote = await prepareEvmSend(
      'http://fake.invalid',
      ADDRESS,
      to,
      12345n,
      new Uint8Array(Buffer.from(calldata.slice(2), 'hex')),
    );
    check('quote carries the calldata', toHex(quote.data) === calldata);
    check('estimateGas received the calldata', estimateSawData === calldata);
    check('simulation (eth_call) received the calldata', callSawData === calldata);
    check('simulation passed', quote.simulation.ok === true);
    check('fee is gasLimit×maxFee', quote.fee === 50000n * (2n * 1000000000n + 1000000000n));

    const result = await sendEvm('http://fake.invalid', account, quote);
    check('sendEvm returns the node txid', result.txid === '0x' + '42'.repeat(32));
    check('a raw transaction was broadcast', typeof broadcastRaw === 'string');

    // Decode what would have hit the chain and verify field by field.
    const decoded = ethers.Transaction.from(broadcastRaw);
    check('raw tx type 2', decoded.type === 2);
    check('raw tx chainId 1', decoded.chainId === 1n);
    check('raw tx nonce from node', decoded.nonce === 5);
    check('raw tx to', decoded.to === to);
    check('raw tx value', decoded.value === 12345n);
    check('raw tx data is the dApp calldata', decoded.data === calldata);
    check('raw tx gasLimit', decoded.gasLimit === 50000n);
    check(
      'raw tx signed by the wallet account',
      decoded.from.toLowerCase() === ADDRESS.toLowerCase(),
      decoded.from,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log('check-wc: eth_sendTransaction quote through the endpoint resolver (failover + pinning)');
{
  // The approval sheet no longer calls prepareEvmSend with a URL it looked
  // up itself: quoteWcTransaction resolves the active EVM endpoint, fails
  // over once on a transport failure of a default endpoint, and names the
  // endpoint that answered. (The failover and re-quote-on-move paths are
  // covered in depth by check-failover.mjs; this pins the WalletConnect
  // shape: calldata, sender, endpoint, and the unchanged-endpoint answer.)
  const [primaryUrl, fallbackUrl] = DEFAULT_NETWORKS.find((n) => n.chainId === 'eip155:1').defaultUrls;
  const to = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
  const calldata = '0xa9059cbb' + '33'.repeat(64);
  const seen = [];
  let primaryAlive = true;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const { id, method, params } = JSON.parse(init.body);
    seen.push({ url, method, data: params?.[0]?.data ?? null });
    // The primary answers its first identity probe, then dies for good (its
    // re-probe after the failure report fails too).
    if (url === primaryUrl && (!primaryAlive || method !== 'eth_chainId')) {
      primaryAlive = false;
      throw new TypeError('fetch failed (simulated)');
    }
    if (url !== primaryUrl && url !== fallbackUrl) throw new TypeError(`fetch failed (no fake for ${url})`);
    const result = {
      eth_chainId: '0x1',
      eth_getBalance: '0x' + (10n ** 18n).toString(16),
      eth_getTransactionCount: '0x4',
      eth_getBlockByNumber: { baseFeePerGas: '0x3b9aca00' },
      eth_maxPriorityFeePerGas: '0x3b9aca00',
      eth_estimateGas: '0xc350',
      eth_call: '0x',
    }[method];
    if (result === undefined) throw new Error(`fake node: unexpected method ${method}`);
    const text = JSON.stringify({ jsonrpc: '2.0', id, result });
    return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text };
  };
  try {
    forgetDefaultEndpointChoices();
    const tx = { to, valueWei: 777n, data: new Uint8Array(Buffer.from(calldata.slice(2), 'hex')) };
    const quoted = await quoteWcTransaction(tx, ADDRESS, 'eip155:1');
    check('dApp tx quote: answered by the healthy endpoint after the default failed', quoted.url === fallbackUrl, quoted.url);
    check('dApp tx quote: sender is the session account', quoted.from === ADDRESS);
    check('dApp tx quote: carries the dApp calldata, recipient and value', toHex(quoted.quote.data) === calldata && quoted.quote.to === to && quoted.quote.amount === 777n);
    check(
      'dApp tx quote: estimateGas and the eth_call gate saw the calldata on the answering endpoint',
      seen.some((c) => c.url === fallbackUrl && c.method === 'eth_estimateGas' && c.data === calldata) &&
        seen.some((c) => c.url === fallbackUrl && c.method === 'eth_call' && c.data === calldata),
    );
    check('dApp tx quote: dApp gas/fee/nonce fields are still ignored (nonce from the node)', quoted.quote.nonce === 4n);
    const again = await requoteWcTransactionIfMoved(quoted, tx, 'eip155:1');
    check('approval with an unchanged endpoint: no re-quote', again.moved === false);
    check('re-quote note text', WC_REQUOTED_NOTE === 'The network endpoint changed; the fee was re-quoted.');
    await checkRejects(
      'dApp tx quote: a wrong active chain is still refused by the endpoint check',
      () => quoteWcTransaction(tx, ADDRESS, 'eip155:11155111'),
      'chain',
    );
  } finally {
    globalThis.fetch = realFetch;
    forgetDefaultEndpointChoices();
  }
}

console.log('check-wc: responses, disconnect, pairing URI');
{
  check(
    'wcResult shape',
    JSON.stringify(wcResult(7, '0xabc')) === '{"id":7,"jsonrpc":"2.0","result":"0xabc"}',
  );
  check(
    'wcError shape',
    JSON.stringify(wcError(7, WC_ERRORS.userRejected)) ===
      '{"id":7,"jsonrpc":"2.0","error":{"code":5000,"message":"User rejected."}}',
  );

  const client = fakeClient();
  await respondApproved(client, 'topic-x', 11, '0xsig');
  check(
    'respondApproved sends a result response',
    client.calls.respond[0]?.topic === 'topic-x' &&
      client.calls.respond[0]?.response?.result === '0xsig' &&
      client.calls.respond[0]?.response?.jsonrpc === '2.0',
  );
  await respondRejected(client, 'topic-x', 12);
  check(
    'respondRejected sends USER_REJECTED by default',
    client.calls.respond[1]?.response?.error?.code === 5000,
  );
  await respondRejected(client, 'topic-x', 13, new WcRequestRejection(5101, 'nope'));
  check('respondRejected forwards specific codes', client.calls.respond[2]?.response?.error?.code === 5101);
  await disconnectWcSession(client, 'topic-x');
  check(
    'disconnect uses USER_DISCONNECTED (6000)',
    client.calls.disconnect[0]?.reason?.code === 6000,
  );

  const sessions = summarizeSessions({
    't1': {
      topic: 't1',
      peer: { metadata: { name: 'dApp One', url: 'https://one.example' } },
      namespaces: { eip155: { accounts: [`eip155:1:${ADDRESS}`], methods: ['personal_sign'] } },
      expiry: 1234567890,
    },
    't2': { garbage: true },
  });
  check(
    'summarizeSessions reads well-formed sessions',
    sessions[0].name === 'dApp One' && sessions[0].chains.includes('eip155:1'),
  );
  check('summarizeSessions survives garbage', sessions[1].name === 'Unknown dApp');

  check('wc: v2 URI accepted', validatePairingUri(' wc:abc@2?relay-protocol=irn&symKey=00 ').ok === true);
  check('non-wc URI refused', validatePairingUri('http://x').ok === false);
  check('v1 URI refused', validatePairingUri('wc:abc@1?bridge=x').ok === false);
  check('supported chains constant is eip155:1 only', JSON.stringify(WC_SUPPORTED_CHAINS) === '["eip155:1"]');
}

// ======================================================================
// Phase 6 item 5: active-chain namespace decisions, wallet_switchEthereumChain,
// paused sessions, the app-level request queue (WcController), the lock
// hold, and the launch-time start decision. All offline: the namespace
// decisions run through the REAL @walletconnect/utils buildApprovedNamespaces;
// the queue runs against a fake event-emitting WalletKit client.
// ======================================================================

const M = EVM_MAINNET.caip2; // eip155:1
const S = EVM_SEPOLIA.caip2; // eip155:11155111
const SIGN3 = ['personal_sign', 'eth_sendTransaction', 'eth_signTypedData_v4'];
const EVENTS = ['accountsChanged', 'chainChanged'];

/** Proposal params with explicit namespace objects (sign-client shape). */
function proposalWith(requiredNamespaces, optionalNamespaces) {
  return {
    id: 99,
    proposer: { publicKey: 'bb'.repeat(32), metadata: { name: 'Mode dApp', description: '', url: 'https://mode.example', icons: [] } },
    requiredNamespaces,
    optionalNamespaces,
    relays: [{ protocol: 'irn' }],
  };
}
const eip = (chains, methods = SIGN3, events = EVENTS) => ({ eip155: { chains, methods, events } });
const accountsOf = (ns) => Object.values(ns).flatMap((n) => n.accounts ?? []);

console.log('check-wc: namespace decisions under the active-chain rule');
{
  const MAINNET_SENTENCE =
    'This dApp asked for Ethereum mainnet; the wallet is in Sepolia test mode. Switch modes in Settings → Developer to connect.';
  const SEPOLIA_SENTENCE =
    'This dApp asked for Ethereum Sepolia (test network); the wallet is in mainnet mode. Turn on Sepolia test mode in Settings → Developer to connect.';
  check('mode sentence (mainnet asked, Sepolia active) is exact', modeMismatchMessage(M, S, 'connect') === MAINNET_SENTENCE);
  check('mode sentence (Sepolia asked, mainnet active) is exact', modeMismatchMessage(S, M, 'connect') === SEPOLIA_SENTENCE);
  check('describeChain names both modes', describeChain(M) === 'Ethereum mainnet' && describeChain(S).startsWith('Ethereum Sepolia'));

  // 1. Required mainnet.
  let d = decideProposal(proposalWith(eip([M]), {}), ADDRESS, M);
  check('required eip155:1 in mainnet mode → approved on eip155:1 only', d.ok && JSON.stringify(accountsOf(d.namespaces)) === JSON.stringify([`${M}:${ADDRESS}`]));
  d = decideProposal(proposalWith(eip([M]), {}), ADDRESS, S);
  check('required eip155:1 in Sepolia mode → declined 5100', !d.ok && d.error.code === 5100);
  check('  … with the exact mode sentence', !d.ok && d.reason === MAINNET_SENTENCE, d.reason);
  check('  … and the SDK error message carries the same sentence', !d.ok && d.error.message === MAINNET_SENTENCE);

  // 2. Required Sepolia.
  d = decideProposal(proposalWith(eip([S]), {}), ADDRESS, M);
  check('required Sepolia in mainnet mode → declined 5100 with turn-on sentence', !d.ok && d.error.code === 5100 && d.reason === SEPOLIA_SENTENCE, d.reason);
  d = decideProposal(proposalWith(eip([S]), {}), ADDRESS, S);
  check('required Sepolia in Sepolia mode → approved on Sepolia only', d.ok && JSON.stringify(accountsOf(d.namespaces)) === JSON.stringify([`${S}:${ADDRESS}`]));

  // 3. Modern dApp: everything optional, both chains offered.
  const both = proposalWith({}, eip([M, S]));
  d = decideProposal(both, ADDRESS, M);
  check('optional [1, Sepolia] in mainnet mode → only eip155:1 approved', d.ok && JSON.stringify(accountsOf(d.namespaces)) === JSON.stringify([`${M}:${ADDRESS}`]), JSON.stringify(d));
  check('  … Sepolia reported as dropped', d.ok && JSON.stringify(d.droppedChains) === JSON.stringify([S]));
  check('  … approved chains list is eip155:1 only', d.ok && JSON.stringify(d.namespaces.eip155.chains) === JSON.stringify([M]));
  d = decideProposal(both, ADDRESS, S);
  check('optional [1, Sepolia] in Sepolia mode → only Sepolia approved', d.ok && JSON.stringify(accountsOf(d.namespaces)) === JSON.stringify([`${S}:${ADDRESS}`]));
  check('  … mainnet reported as dropped', d.ok && JSON.stringify(d.droppedChains) === JSON.stringify([M]));

  // 4./5. Optional only the inactive chain → declined up front (the SDK
  // builder would return {} and approve() would throw).
  d = decideProposal(proposalWith({}, eip([M])), ADDRESS, S);
  check('optional [1] only, Sepolia mode → declined 5100 with mode sentence', !d.ok && d.error.code === 5100 && d.reason === MAINNET_SENTENCE, d.reason);
  d = decideProposal(proposalWith({}, eip([S])), ADDRESS, M);
  check('optional [Sepolia] only, mainnet mode → declined 5100 with turn-on sentence', !d.ok && d.error.code === 5100 && d.reason === SEPOLIA_SENTENCE);
  d = decideProposal(proposalWith({}, eip([M])), ADDRESS, M);
  check('optional [1] only, mainnet mode → approved', d.ok && d.droppedChains.length === 0);

  // 6. Required mainnet + optional Sepolia.
  d = decideProposal(proposalWith(eip([M]), eip([S])), ADDRESS, S);
  check('required 1 + optional Sepolia, Sepolia mode → declined (required wins)', !d.ok && d.error.code === 5100 && d.reason === MAINNET_SENTENCE);
  d = decideProposal(proposalWith(eip([M]), eip([S])), ADDRESS, M);
  check('required 1 + optional Sepolia, mainnet mode → eip155:1 only, Sepolia dropped', d.ok && accountsOf(d.namespaces).length === 1 && d.droppedChains[0] === S);

  // 7./8. Chains neither mode serves.
  d = decideProposal(proposalWith(eip(['eip155:137']), {}), ADDRESS, M);
  check('required Polygon → 5100 unsupported sentence', !d.ok && d.error.code === 5100 && d.reason.includes('eip155:137') && d.reason.includes('does not support'), d.reason);
  d = decideProposal(proposalWith({}, eip(['eip155:137', M])), ADDRESS, M);
  check('optional [Polygon, 1] mainnet mode → eip155:1 only, Polygon dropped', d.ok && accountsOf(d.namespaces).length === 1 && d.droppedChains[0] === 'eip155:137');
  d = decideProposal(proposalWith({}, eip(['eip155:137', M])), ADDRESS, S);
  check('optional [Polygon, 1] Sepolia mode → declined 5100', !d.ok && d.error.code === 5100);

  // 9.–11. Namespace keys, methods, events.
  d = decideProposal(proposalWith({ solana: { chains: ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'], methods: ['solana_signMessage'], events: [] } }, {}), ADDRESS, M);
  check('required solana namespace → UNSUPPORTED_NAMESPACE_KEY 5104', !d.ok && d.error.code === 5104, JSON.stringify(d));
  d = decideProposal(proposalWith(eip([M], [...SIGN3, 'eth_sign']), {}), ADDRESS, M);
  check('required eth_sign → UNSUPPORTED_METHODS 5101', !d.ok && d.error.code === 5101 && d.reason.includes('eth_sign'));
  d = decideProposal(proposalWith(eip([M], SIGN3, ['accountsChanged', 'message']), {}), ADDRESS, M);
  check('required unknown event → UNSUPPORTED_EVENTS 5102', !d.ok && d.error.code === 5102);
  d = decideProposal(proposalWith({}, { solana: { chains: ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'], methods: [], events: [] } }), ADDRESS, M);
  check('optional-only solana → declined 5100 (nothing Ethereum to connect)', !d.ok && d.error.code === 5100);

  // 12. No namespaces at all → the builder's all-supported branch.
  d = decideProposal(proposalWith({}, {}), ADDRESS, S);
  check('empty proposal → active chain only', d.ok && JSON.stringify(accountsOf(d.namespaces)) === JSON.stringify([`${S}:${ADDRESS}`]));

  // 13. Inline CAIP-2 namespace keys ("eip155:1": {...}).
  const inline = proposalWith({ [M]: { methods: SIGN3, events: EVENTS } }, {});
  d = decideProposal(inline, ADDRESS, S);
  check('inline required "eip155:1" key, Sepolia mode → declined with mode sentence', !d.ok && d.reason === MAINNET_SENTENCE);
  d = decideProposal(inline, ADDRESS, M);
  check('inline required "eip155:1" key, mainnet mode → approved', d.ok);

  // 14. wallet_switchEthereumChain only when the dApp asked for it.
  d = decideProposal(proposalWith({}, eip([M], [...SIGN3, 'wallet_switchEthereumChain'])), ADDRESS, M);
  check('switch method approved when requested', d.ok && d.namespaces.eip155.methods.includes('wallet_switchEthereumChain'));
  d = decideProposal(proposalWith({}, eip([M])), ADDRESS, M);
  check('switch method not added when not requested', d.ok && !d.namespaces.eip155.methods.includes('wallet_switchEthereumChain'));
  check('supported set = signing methods + switch', JSON.stringify(WC_SUPPORTED_METHODS) === JSON.stringify([...WC_SIGNING_METHODS, 'wallet_switchEthereumChain']));

  // 15./16. approveProposal / declineProposal wire the right codes.
  const c1 = fakeClient();
  const out = await approveProposal(c1, { id: 5, params: proposalWith({}, eip([M])) }, ADDRESS, S);
  check('approveProposal (Sepolia mode, mainnet-only dApp) → approved:false with mode sentence', out.approved === false && out.reason === MAINNET_SENTENCE);
  check('  … rejectSession sent 5100 with the sentence', c1.calls.reject[0]?.reason?.code === 5100 && c1.calls.reject[0]?.reason?.message === MAINNET_SENTENCE && c1.calls.approve.length === 0);
  const c2 = fakeClient();
  await approveProposal(c2, { id: 6, params: both }, ADDRESS, S);
  check('approveProposal (both offered, Sepolia mode) approves Sepolia account only', JSON.stringify(accountsOf(c2.calls.approve[0]?.namespaces ?? {})) === JSON.stringify([`${S}:${ADDRESS}`]));
  const c3 = fakeClient();
  await declineProposal(c3, { id: 7, params: both }, ADDRESS, M);
  check('declineProposal of a servable proposal → USER_REJECTED 5000', c3.calls.reject[0]?.reason?.code === 5000);
  const c4 = fakeClient();
  await declineProposal(c4, { id: 8, params: proposalWith(eip(['eip155:137']), {}) }, ADDRESS, M);
  check('declineProposal of an unservable proposal → its specific code (5100)', c4.calls.reject[0]?.reason?.code === 5100);
}

console.log('check-wc: wallet_switchEthereumChain');
{
  const sw = (chainIdHex, envelope = M) => ({
    id: 21,
    topic: 't',
    params: { chainId: envelope, request: { method: 'wallet_switchEthereumChain', params: [{ chainId: chainIdHex }] } },
  });
  let r = decideSwitchChain(sw('0x1'), M, [M]);
  check('switch to the active chain (mainnet) → answer null', r.kind === 'answer' && r.result === null);
  r = decideSwitchChain(sw('0xaa36a7', S), S, [S]);
  check('switch to the active chain (Sepolia) → answer null', r.kind === 'answer' && r.result === null);
  r = decideSwitchChain(sw('0xAA36A7', S), S, [S]);
  check('upper-case hex accepted', r.kind === 'answer');
  r = decideSwitchChain(sw('0x1', S), S, [S]);
  check('switch to mainnet while in Sepolia mode → 5100', r.kind === 'decline' && r.error.code === 5100);
  check('  … with the mode sentence', r.kind === 'decline' && r.error.message.startsWith('This dApp asked for Ethereum mainnet; the wallet is in Sepolia test mode.'), r.error?.message);
  r = decideSwitchChain(sw('0xaa36a7'), M, [M]);
  check('switch to Sepolia while in mainnet mode → 5100 turn-on sentence', r.kind === 'decline' && r.error.code === 5100 && r.error.message.includes('Turn on Sepolia test mode'));
  r = decideSwitchChain(sw('0x89'), M, [M]);
  check('switch to Polygon → 5100 unsupported', r.kind === 'decline' && r.error.code === 5100 && r.error.message.includes('eip155:137'));
  r = decideSwitchChain(sw('0xaa36a7', M), S, [M]);
  check('paused mainnet session asks for active Sepolia → declined, reconnect advice', r.kind === 'decline' && r.error.code === 5100 && r.error.message.includes('reconnect'));
  r = decideSwitchChain({ id: 1, topic: 't', params: { chainId: M, request: { method: 'wallet_switchEthereumChain', params: [{ chainId: 1 }] } } }, M, [M]);
  check('non-hex chainId → -32602', r.kind === 'decline' && r.error.code === -32602);
  r = decideSwitchChain({ id: 1, topic: 't', params: { chainId: M, request: { method: 'wallet_switchEthereumChain', params: [] } } }, M, [M]);
  check('missing params → -32602', r.kind === 'decline' && r.error.code === -32602);
  check('wcResult(null) keeps an explicit null result', JSON.stringify(wcResult(4, null)) === '{"id":4,"jsonrpc":"2.0","result":null}');
}

console.log('check-wc: sessions persisted across a mode switch');
{
  const mainnetSession = { namespaces: { eip155: { accounts: [`${M}:${ADDRESS}`], methods: SIGN3 } } };
  check('sessionChainsOf reads CAIP-10 accounts', JSON.stringify(sessionChainsOf(mainnetSession)) === JSON.stringify([M]));
  check('mainnet session in mainnet mode → no pause note', sessionModeNote([M], M) === null);
  const note = sessionModeNote([M], S);
  check('mainnet session in Sepolia mode → paused note', typeof note === 'string' && note.includes('Paused') && note.includes('Settings → Developer'), note);
  check('Sepolia session in mainnet mode → paused note', (sessionModeNote([S], M) ?? '').includes('mainnet mode'));
  const msgHex = toHex(new TextEncoder().encode('hi'));
  try {
    parseWcRequest({ id: 1, topic: 't', params: { chainId: M, request: { method: 'personal_sign', params: [msgHex, ADDRESS] } } }, ADDRESS, S);
    check('request from a paused mainnet session declined', false);
  } catch (e) {
    check('request from a paused mainnet session → 5100', e instanceof WcRequestRejection && e.code === 5100);
    check('  … with "use this connection" mode sentence', e.message === 'This dApp asked for Ethereum mainnet; the wallet is in Sepolia test mode. Switch modes in Settings → Developer to use this connection.', e.message);
  }
}

console.log('check-wc: launch-time start decision');
{
  check('no project id → stay lazy', shouldStartWalletConnectAtLaunch(null, true) === false);
  check('empty project id → stay lazy', shouldStartWalletConnectAtLaunch('', true) === false);
  check('project id, never used → stay lazy', shouldStartWalletConnectAtLaunch('abc12345', false) === false);
  check('project id + used → start at launch', shouldStartWalletConnectAtLaunch('abc12345', true) === true);
  const store = memoryStore();
  check('used marker defaults to false', (await getWcUsed(store)) === false);
  await setWcUsed(true, store);
  check('used marker round-trip true', (await getWcUsed(store)) === true);
  await setWcUsed(false, store);
  check('used marker round-trip false', (await getWcUsed(store)) === false);
  store._map.set('shiba-wallet.wc-used.v1', '{broken');
  check('corrupt marker reads as false (lazy)', (await getWcUsed(store)) === false);

  // Node scripts must never evaluate the SDK: load the two glue modules in
  // a child process with a resolve hook that records every specifier.
  const probe = `
    import { registerHooks } from 'node:module';
    const seen = [];
    registerHooks({ resolve(spec, ctx, next) { seen.push(spec); return next(spec, ctx); } });
    await import('./src/wallet/walletconnect.ts');
    await import('./src/wallet/wc-controller.ts');
    console.log(JSON.stringify(seen.filter((s) => /@reown\\/|react-native-compat|@walletconnect\\/core|@walletconnect\\/sign-client/.test(s))));
  `;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { cwd: process.cwd(), encoding: 'utf8' });
  const lines = (res.stdout || '').trim().split('\n');
  check(
    'importing the glue modules never resolves @reown/*, the compat shim, core or sign-client',
    res.status === 0 && lines[lines.length - 1] === '[]',
    `status ${res.status}; stdout ${res.stdout}; stderr ${(res.stderr || '').slice(0, 300)}`,
  );
}

console.log('check-wc: app-level request queue (WcController, fake WalletKit)');

/** FAKE event-emitting WalletKit client (no relay, no network). */
function fakeKit(sessions = {}) {
  const handlers = new Map();
  const calls = { approve: [], reject: [], respond: [], disconnect: [], pair: [] };
  return {
    calls,
    sessions,
    handlers,
    pair: async (a) => void calls.pair.push(a),
    approveSession: async (a) => void calls.approve.push(a),
    rejectSession: async (a) => void calls.reject.push(a),
    respondSessionRequest: async (a) => void calls.respond.push(a),
    disconnectSession: async (a) => void calls.disconnect.push(a),
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
const session = (topic, chain, name = 'Uniswap') => ({
  [topic]: {
    topic,
    peer: { metadata: { name, url: 'https://app.example' } },
    namespaces: { eip155: { accounts: [`${chain}:${ADDRESS}`], methods: [...SIGN3, 'wallet_switchEthereumChain'] } },
  },
});
const req = (id, method, params, chainId = M, topic = 'T1') => ({
  id,
  topic,
  params: { chainId, request: { method, params } },
});
const signReq = (id, text, chainId = M, topic = 'T1') =>
  req(id, 'personal_sign', [toHex(new TextEncoder().encode(text)), ADDRESS], chainId, topic);
const tick = () => new Promise((r) => setTimeout(r, 0));

{
  // Wiring.
  const kit = fakeKit(session('T1', M));
  const ctx = { address: ADDRESS, activeChain: M };
  const ctl = new WcController(kit, () => ctx);
  const detach = ctl.attach();
  const events = ['session_proposal', 'session_request', 'session_delete', 'session_request_expire', 'proposal_expire'];
  check('attach registers all five SDK listeners', events.every((e) => kit.handlers.get(e)?.size === 1));
  check('attach loads the session list', ctl.getSnapshot().sessions[0]?.name === 'Uniswap');
  const snapA = ctl.getSnapshot();
  check('snapshot identity is stable between changes', ctl.getSnapshot() === snapA);

  // Ordering: proposal, then two requests, arrival order kept.
  await kit.fire('session_proposal', { id: 500, params: proposalWith({}, eip([M])) });
  await kit.fire('session_request', signReq(1, 'first'));
  await kit.fire('session_request', req(2, 'eth_signTypedData_v4', [ADDRESS, JSON.stringify({ types: { EIP712Domain: [{ name: 'name', type: 'string' }], M: [{ name: 'x', type: 'string' }] }, primaryType: 'M', domain: { name: 'd' }, message: { x: 'y' } })]));
  await kit.fire('session_request', signReq(1, 'first')); // at-least-once redelivery
  let snap = ctl.getSnapshot();
  check('snapshot changes after events', snap !== snapA);
  check('queue keeps arrival order (proposal, r1, r2)', JSON.stringify(snap.queue.map((i) => i.key)) === JSON.stringify(['p:500', 'r:1', 'r:2']), JSON.stringify(snap.queue.map((i) => i.key)));
  check('duplicate delivery of the same request id is ignored', snap.queue.length === 3);
  check('head is the oldest item', snap.head?.key === 'p:500');
  check('non-head items cannot be claimed', ctl.begin('r:1') === null && ctl.canAct('r:2') === false);
  check('nothing was answered automatically', kit.calls.respond.length === 0 && kit.calls.reject.length === 0);

  // One at a time: claim the head, others blocked while busy.
  const claimed = ctl.begin('p:500');
  check('head claim succeeds', claimed?.key === 'p:500' && ctl.getSnapshot().busyKey === 'p:500');
  check('a second claim while busy fails', ctl.begin('p:500') === null);
  ctl.release('p:500');
  check('release keeps the item queued', ctl.getSnapshot().queue.length === 3 && ctl.getSnapshot().busyKey === null);
  await ctl.decline('p:500');
  check('declining the proposal sends USER_REJECTED 5000 and advances', kit.calls.reject[0]?.id === 500 && kit.calls.reject[0]?.reason?.code === 5000 && ctl.getSnapshot().head?.key === 'r:1');

  // Approve r1 exactly as the provider does: claim, sign, respond, complete.
  const item = ctl.begin('r:1');
  const sig = signDigest(account, item.parsed.digest);
  await respondApproved(kit, item.event.topic, item.event.id, sig);
  ctl.complete('r:1');
  check('approved signature recovers the wallet address', ethers.verifyMessage('first', kit.calls.respond[0].response.result).toLowerCase() === ADDRESS.toLowerCase());
  check('after r1, head is r2', ctl.getSnapshot().head?.key === 'r:2');
  await ctl.decline('r:2');
  check('declining a request sends USER_REJECTED 5000', kit.calls.respond[1]?.response?.error?.code === 5000 && kit.calls.respond[1]?.response?.id === 2);
  check('queue empty', ctl.getSnapshot().queue.length === 0 && ctl.getSnapshot().head === null);

  detach();
  check('detach removes every listener', events.every((e) => (kit.handlers.get(e)?.size ?? 0) === 0));
}

{
  // Lock hold: requests arriving while locked wait, invisible and inert.
  const kit = fakeKit(session('T1', M));
  const ctx = { address: ADDRESS, activeChain: M };
  const ctl = new WcController(kit, () => ctx, { locked: true });
  ctl.attach();
  await kit.fire('session_request', signReq(10, 'while locked'));
  await kit.fire('session_proposal', { id: 600, params: proposalWith({}, eip([M])) });
  let snap = ctl.getSnapshot();
  check('locked: both items queued', snap.queue.length === 2);
  check('locked: no head (approval UI cannot render)', snap.head === null && snap.locked === true);
  check('locked: head cannot be claimed', ctl.canAct('r:10') === false && ctl.begin('r:10') === null);
  check('locked: decline is refused too', (await ctl.decline('r:10')) === false);
  await tick();
  check('locked: nothing answered, nothing declined on its own', kit.calls.respond.length === 0 && kit.calls.reject.length === 0);
  // Auto-answers that need no user decision still go out while locked.
  await kit.fire('session_request', req(11, 'eth_sign', [ADDRESS, '0xdead']));
  check('locked: unsupported method still declined at once with 5101', kit.calls.respond[0]?.response?.error?.code === 5101 && kit.calls.respond[0]?.response?.id === 11);
  check('locked: that decline is not queued', ctl.getSnapshot().queue.length === 2);
  ctl.setLocked(false);
  snap = ctl.getSnapshot();
  check('unlock: head is the first arrival (the locked-time request)', snap.head?.key === 'r:10' && snap.locked === false);
  check('unlock: head is claimable', ctl.canAct('r:10'));
  ctl.setLocked(true);
  check('re-lock mid-queue hides the head again', ctl.getSnapshot().head === null && ctl.begin('r:10') === null);
}

{
  // Automatic answers + notices.
  const kit = fakeKit({ ...session('T1', M), ...session('T2', M, 'Paused dApp') });
  const ctx = { address: ADDRESS, activeChain: M };
  const ctl = new WcController(kit, () => ctx);
  ctl.attach();
  await kit.fire('session_request', req(30, 'wallet_switchEthereumChain', [{ chainId: '0x1' }]));
  check('switch to active chain answered null without UI', kit.calls.respond[0]?.response?.result === null && kit.calls.respond[0]?.response?.id === 30 && ctl.getSnapshot().queue.length === 0);
  check('  … and adds no notice', ctl.getSnapshot().notices.length === 0);
  await kit.fire('session_request', req(31, 'wallet_switchEthereumChain', [{ chainId: '0xaa36a7' }]));
  check('switch to Sepolia in mainnet mode declined 5100', kit.calls.respond[1]?.response?.error?.code === 5100);
  check('  … with a plain-language notice naming the dApp', (ctl.getSnapshot().notices[0]?.text ?? '').includes('Uniswap') && ctl.getSnapshot().notices[0].text.includes('Turn on Sepolia test mode'));

  // Mode switch: the user flips to Sepolia; the mainnet session is paused.
  ctx.activeChain = S;
  await kit.fire('session_request', signReq(32, 'old mode', M, 'T2'));
  check('request from a mainnet session in Sepolia mode declined 5100', kit.calls.respond[2]?.response?.error?.code === 5100 && ctl.getSnapshot().queue.length === 0);
  check('  … notice carries the mode sentence', (ctl.getSnapshot().notices[0]?.text ?? '').includes('Switch modes in Settings → Developer to use this connection'));
  await kit.fire('session_request', req(33, 'wallet_switchEthereumChain', [{ chainId: '0xaa36a7' }], M, 'T2'));
  check('paused session asking to switch to the active chain → 5100 reconnect', kit.calls.respond[3]?.response?.error?.code === 5100 && kit.calls.respond[3].response.error.message.includes('reconnect'));

  // Stale-chain re-check at approval time.
  ctx.activeChain = M;
  await kit.fire('session_request', signReq(34, 'queued under mainnet'));
  const item = ctl.begin('r:34');
  check('same chain at approval → no stale error', ctl.staleChainError(item) === null);
  ctx.activeChain = S;
  const stale = ctl.staleChainError(item);
  check('mode switched while queued → stale 5100', stale?.code === 5100);
  ctl.release('r:34');
  await ctl.decline('r:34', stale);
  check('stale decline carries 5100 to the dApp', kit.calls.respond[4]?.response?.error?.code === 5100 && kit.calls.respond[4].response.id === 34);

  // No wallet account → -32603 decline.
  ctx.activeChain = M;
  ctx.address = null;
  await kit.fire('session_request', signReq(35, 'no account'));
  check('no wallet account → -32603 decline, not queued', kit.calls.respond[5]?.response?.error?.code === -32603 && ctl.getSnapshot().queue.length === 0);
  ctx.address = ADDRESS;

  // Wrong signer → -32602 decline.
  await kit.fire('session_request', req(36, 'personal_sign', ['0x68', '0x' + '11'.repeat(20)]));
  check('foreign signer → -32602 decline', kit.calls.respond[6]?.response?.error?.code === -32602);
  check('notices are capped', ctl.getSnapshot().notices.length <= 5);
}

{
  // session_delete, expiries: items leave the queue without any response.
  const kit = fakeKit({ ...session('T1', M), ...session('T2', M, 'Other') });
  const ctx = { address: ADDRESS, activeChain: M };
  const ctl = new WcController(kit, () => ctx);
  ctl.attach();
  await kit.fire('session_request', signReq(40, 'a', M, 'T1'));
  await kit.fire('session_request', signReq(41, 'b', M, 'T2'));
  await kit.fire('session_request', signReq(42, 'c', M, 'T1'));
  ctl.begin('r:40');
  delete kit.sessions.T1;
  await kit.fire('session_delete', { id: 1, topic: 'T1' });
  let snap = ctl.getSnapshot();
  check('session_delete drops that session\'s queued requests (incl. the busy one)', JSON.stringify(snap.queue.map((i) => i.key)) === JSON.stringify(['r:41']) && snap.busyKey === null);
  check('session_delete refreshes the session list', snap.sessions.length === 1 && snap.sessions[0].topic === 'T2');
  check('session_delete notice names the dApp', (snap.notices[0]?.text ?? '').includes('Uniswap disconnected'));
  check('session_delete sends no responses (the SDK already failed them)', kit.calls.respond.length === 0);
  await kit.fire('session_request_expire', { id: 41 });
  snap = ctl.getSnapshot();
  check('session_request_expire drops the item without answering', snap.queue.length === 0 && kit.calls.respond.length === 0);
  check('  … and says so', (snap.notices[0]?.text ?? '').includes('expired'));
  await kit.fire('session_proposal', { id: 700, params: proposalWith({}, eip([M])) });
  await kit.fire('proposal_expire', { id: 700 });
  check('proposal_expire drops the proposal without a reject call', ctl.getSnapshot().queue.length === 0 && kit.calls.reject.length === 0);
  await kit.fire('session_request_expire', { id: 999 });
  check('expiry for an unknown id is a no-op', ctl.getSnapshot().queue.length === 0);

  // Unservable proposal declined from the sheet carries its specific code.
  ctx.activeChain = S;
  await kit.fire('session_proposal', { id: 701, params: proposalWith({}, eip([M])) });
  check('proposal summary flags nothing required (all optional) yet decision refuses', ctl.getSnapshot().head?.summary.unsupportedRequired.length === 0);
  await ctl.decline('p:701');
  check('declining an unservable proposal sends 5100 with the mode sentence', kit.calls.reject[0]?.reason?.code === 5100 && kit.calls.reject[0].reason.message.includes('Sepolia test mode'));
}

console.log('check-wc: WalletConnect Verify (verifyContext, threat-model N-06)');
{
  // Shapes per @walletconnect/types 2.25.0 Verify.Context and sign-client
  // 2.25.0 engine.ts getVerifyContext.
  const vc = (validation, origin, isScam) => ({
    verified: { verifyUrl: 'https://verify.walletconnect.org', validation, origin, ...(isScam === undefined ? {} : { isScam }) },
  });
  const valid = describeVerifyContext(vc('VALID', 'https://app.uniswap.org'), 'https://app.uniswap.org');
  check('VALID → verified, no switch, "origin matches" with the origin', valid.status === 'verified' && !valid.requiresAcknowledgement && /Verified by WalletConnect: origin matches \(https:\/\/app\.uniswap\.org\)/.test(valid.message));
  check('VALID says it is not a safety verdict', /not that the dApp is safe/.test(valid.message));
  const unknown = describeVerifyContext(vc('UNKNOWN', 'https://app.uniswap.org'), 'https://app.uniswap.org');
  check('UNKNOWN → unverified, no switch, self-reported origin NOT presented as evidence', unknown.status === 'unverified' && !unknown.requiresAcknowledgement && unknown.origin === '' && /^UNVERIFIED — the dApp’s origin could not be confirmed/.test(unknown.message));
  const missing = describeVerifyContext(undefined, 'https://x.example');
  check('missing verifyContext → unverified', missing.status === 'unverified');
  const garbage = describeVerifyContext({ verified: 'yes' }, 'https://x.example');
  check('malformed verifyContext → unverified (never verified by accident)', garbage.status === 'unverified');
  const odd = describeVerifyContext(vc('MAYBE', 'https://x.example'), 'https://x.example');
  check('unknown validation string → unverified', odd.status === 'unverified');
  const mismatch = describeVerifyContext(vc('INVALID', 'https://evil.example'), 'https://app.uniswap.org');
  check('INVALID → mismatch with the switch', mismatch.status === 'mismatch' && mismatch.requiresAcknowledgement);
  check('INVALID message names claimed and actual hosts', mismatch.message === 'MISMATCH — the request claims app.uniswap.org but came from evil.example: likely phishing.', mismatch.message);
  const scam = describeVerifyContext(vc('VALID', 'https://drainer.example', true), 'https://drainer.example');
  check('isScam wins even when the origin matches', scam.status === 'scam' && scam.requiresAcknowledgement && /^Flagged as a scam by WalletConnect/.test(scam.message));
  const scamUnknown = describeVerifyContext(vc('UNKNOWN', 'https://drainer.example', true), 'https://drainer.example');
  check('isScam with UNKNOWN validation still flagged', scamUnknown.status === 'scam');
  const notScam = describeVerifyContext(vc('VALID', 'https://a.example', false), 'https://a.example');
  check('isScam false → verified', notScam.status === 'verified');
  check('risk gate: scam blocked until acknowledged', !identityApprovalAllowed(scam, false) && identityApprovalAllowed(scam, true));
  check('risk gate: mismatch blocked until acknowledged', !identityApprovalAllowed(mismatch, false) && identityApprovalAllowed(mismatch, true));
  check('risk gate: verified / unverified never blocked', identityApprovalAllowed(valid, false) && identityApprovalAllowed(unknown, false));
  check('risk gate: an item without identity is not blocked (older queue items)', identityApprovalAllowed(undefined, false));
  check('switch label', IDENTITY_RISK_SWITCH_LABEL === 'I understand the risk — let me approve anyway');

  // Through the controller: the identity is attached to queued items.
  const kit = fakeKit(session('T1', M));
  const ctx = { address: ADDRESS, activeChain: M };
  const ctl = new WcController(kit, () => ctx);
  ctl.attach();
  const prop = proposalWith({}, eip([M]));
  prop.proposer = { metadata: { name: 'Uniswap', url: 'https://app.uniswap.org' } };
  await kit.fire('session_proposal', { id: 700, params: prop, verifyContext: vc('INVALID', 'https://evil.example') });
  await kit.fire('session_request', { ...signReq(70, 'hello'), verifyContext: vc('VALID', 'https://app.example') });
  await kit.fire('session_request', { ...signReq(71, 'scam'), verifyContext: vc('VALID', 'https://app.example', true) });
  await kit.fire('session_request', signReq(72, 'no context'));
  const q = ctl.getSnapshot().queue;
  check('proposal item carries identity (claimed URL = proposer metadata)', q[0]?.identity?.status === 'mismatch' && q[0].identity.claimedUrl === 'https://app.uniswap.org' && /claims app\.uniswap\.org but came from evil\.example/.test(q[0].identity.message));
  check('request item carries identity (claimed URL = session peer metadata)', q[1]?.identity?.status === 'verified' && q[1].identity.claimedUrl === 'https://app.example');
  check('scam-flagged request carries the scam identity', q[2]?.identity?.status === 'scam' && q[2].identity.requiresAcknowledgement);
  check('request without verifyContext → unverified', q[3]?.identity?.status === 'unverified');
  check('identity never auto-declines anything (the user decides)', kit.calls.respond.length === 0 && kit.calls.reject.length === 0 && q.length === 4);

  // UI wiring (source checks; the sheet is React Native and cannot run here).
  const sheet = readFileSync(new URL('../src/components/WcApprovalSheet.tsx', import.meta.url), 'utf8');
  const provider = readFileSync(new URL('../src/wallet/WalletConnectContext.tsx', import.meta.url), 'utf8');
  check('sheet renders the identity banner for every item', /<IdentityBanner identity=\{item\.identity\}/.test(sheet));
  check('sheet: the risk switch is the same Switch pattern as the simulation override', /requiresAcknowledgement \? \(\s*<View style=\{styles\.overrideRow\}>\s*<Switch value=\{acknowledged\}/.test(sheet));
  const approveButtons = [
    /disabled=\{smart === undefined \|\| approveLocked\}/,
    /<Button title="Sign" onPress=\{onApprove\} disabled=\{approveLocked\} \/>[\s\S]*<Button title="Sign" onPress=\{onApprove\} disabled=\{approveLocked\} \/>/,
    /disabled=\{approveBlocked \|\| approveLocked\}/,
    /onPress=\{onApprove\} disabled=\{!ready \|\| approveLocked\} \/>\s*<Button title="Reject"/,
    /title="Grant & install" onPress=\{onApprove\} disabled=\{!ready \|\| approveLocked\}/,
  ];
  check('sheet: every approve button (connect, sign ×2, send, smart send, grant) honours the switch', approveButtons.every((r) => r.test(sheet)));
  check('sheet: the switch resets for each new item', /if \(identityKey !== item\.key\) \{\s*setIdentityKey\(item\.key\);\s*setIdentityAck\(false\);/.test(sheet));
  check('provider re-checks the switch before acting (defense in depth)', /if \(!identityApprovalAllowed\(item\.identity, identityAcknowledged\)\) return;/.test(provider));
  check('provider passes the switch state through', /onApprove=\{\(q, o, c, signer, ack\) => void onApprove\(head, q, o, c, signer, ack\)\}/.test(provider));
}


seed.fill(0);

console.log('');
console.log(`check-wc: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
