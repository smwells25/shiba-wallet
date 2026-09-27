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
} from '../src/wallet/walletconnect.ts';
import { prepareEvmSend, sendEvm } from '../src/wallet/send.ts';

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
    'approved methods are exactly the supported set',
    WC_SUPPORTED_METHODS.every((m) => ns.eip155.methods.includes(m)),
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

seed.fill(0);

console.log('');
console.log(`check-wc: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
