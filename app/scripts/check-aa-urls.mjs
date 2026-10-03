// Load-time https rule for the smart-account settings (phase 10 item 5),
// entirely OFFLINE. Since commit dd14e69 every setter in src/wallet/aa.ts
// refuses a plain http:// bundler or paymaster URL before saving, but URLs
// saved before that change were not re-checked on read. This suite pins the
// read side: getAaConfig applies the same rule (src/config/endpoint-url.ts
// assertSecureEndpointUrl) to the stored bundler and paymaster URLs, treats
// a failing value as "not configured", reports the reason for Settings'
// status line, never builds a transport for it, and leaves the stored value
// in place until the user clears it (the other setters write back the raw
// stored entry, so they must not drop it either).
//
// Kept in its own file rather than check-aa.mjs so it can change
// independently of that suite. Run from the app directory:
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-aa-urls.mjs

import {
  clearAaBundlerUrl,
  clearAaPaymaster,
  createAaClientFromConfig,
  getAaConfig,
  hasCompleteAaSettings,
  isAaConfigured,
  setAccountEip7702,
} from '../src/wallet/aa.ts';
import { EVM_SEPOLIA } from '../src/config/evm-chain.ts';
import { INSECURE_ENDPOINT_MESSAGE } from '../src/config/endpoint-url.ts';

const AA_CHAIN = EVM_SEPOLIA.caip2;
const AA_KEY = 'shiba-wallet.aa-config.v1';
// The SimpleAccountFactory-compatible factory verified on Sepolia in phase 2
// (AGENTS.md, task 8). Only stored here; nothing reads the chain.
const FACTORY = '0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985';
const IMPLEMENTATION = '0x68641De71cFEa5a5d0D29712449Ee254bb1400C2';
// The standard test mnemonic's first EVM address (public knowledge).
const OWNER = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';

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

function memoryStore(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: async (k) => (k in data ? data[k] : null),
    setItem: async (k, v) => {
      data[k] = v;
    },
  };
}

function legacyEntry(overrides = {}) {
  return {
    bundlerUrl: 'http://bundler.example/rpc?apikey=KEY',
    bundlerVerifiedAt: '2026-09-30T00:00:00.000Z',
    accountType: 'simple',
    factory: FACTORY,
    factoryImplementation: IMPLEMENTATION,
    factoryVerifiedAt: '2026-09-30T00:00:00.000Z',
    paymasterUrl: 'http://paymaster.example',
    paymasterContext: '{"policyId":"p"}',
    paymasterVerifiedAt: '2026-09-30T00:00:00.000Z',
    ...overrides,
  };
}

// Any transport construction is recorded; none may target an ignored URL.
const transports = [];
const transportFor = (url) => {
  transports.push(url);
  return async () => {
    throw new Error('no network in this check');
  };
};

console.log('stored plain http:// bundler and paymaster:');
{
  const raw = JSON.stringify({ [AA_CHAIN]: legacyEntry() });
  const store = memoryStore({ [AA_KEY]: raw });
  const config = await getAaConfig(AA_CHAIN, store);
  check('bundler URL reads as not configured', config.bundlerUrl === null && config.bundlerVerifiedAt === null, JSON.stringify(config));
  check('bundler refusal reason is the https sentence', config.bundlerUrlIgnoredReason === INSECURE_ENDPOINT_MESSAGE, String(config.bundlerUrlIgnoredReason));
  check(
    'paymaster URL, its context and date read as not configured',
    config.paymasterUrl === null && config.paymasterContext === null && config.paymasterVerifiedAt === null,
  );
  check('paymaster refusal reason is the https sentence', config.paymasterUrlIgnoredReason === INSECURE_ENDPOINT_MESSAGE);
  check('the factory (not a URL) is unaffected', config.factory === FACTORY && config.factoryImplementation === IMPLEMENTATION);
  check('the chain counts as not configured (isAaConfigured)', isAaConfigured(config) === false);
  check('the settings are incomplete (hasCompleteAaSettings)', hasCompleteAaSettings(config) === false);
  check('the stored value is left in storage', store.data[AA_KEY] === raw);

  let message = null;
  try {
    createAaClientFromConfig(config, { nodeUrl: 'https://node.example', chainId: 11155111n, accountIndex: 0, transportFor });
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  check('no smart-account client can be built from it', message !== null && /incomplete|No bundler/i.test(message), String(message));
  check('no transport was ever created for an ignored URL', !transports.some((u) => u.startsWith('http://')), transports.join(', '));

  // Another setter rewrites the entry from the RAW stored map: the ignored
  // URLs must survive it (only Clear removes them).
  await setAccountEip7702(AA_CHAIN, OWNER, true, store);
  const afterSetter = JSON.parse(store.data[AA_KEY])[AA_CHAIN];
  check(
    'an unrelated setter keeps the ignored URLs in storage',
    afterSetter.bundlerUrl === legacyEntry().bundlerUrl && afterSetter.paymasterUrl === legacyEntry().paymasterUrl,
    JSON.stringify(afterSetter),
  );
  const upgraded = await getAaConfig(AA_CHAIN, store);
  check(
    'an EIP-7702-upgraded owner still has no usable bundler',
    hasCompleteAaSettings(upgraded, OWNER) === false && upgraded.bundlerUrlIgnoredReason === INSECURE_ENDPOINT_MESSAGE,
  );
  await setAccountEip7702(AA_CHAIN, OWNER, false, store);

  await clearAaBundlerUrl(AA_CHAIN, store);
  const noBundler = await getAaConfig(AA_CHAIN, store);
  check('Clear removes the ignored bundler URL and its reason', noBundler.bundlerUrlIgnoredReason === null && JSON.parse(store.data[AA_KEY])[AA_CHAIN].bundlerUrl === undefined);
  check('the paymaster reason remains until its own Clear', noBundler.paymasterUrlIgnoredReason === INSECURE_ENDPOINT_MESSAGE);
  await clearAaPaymaster(AA_CHAIN, store);
  const noPaymaster = await getAaConfig(AA_CHAIN, store);
  check('Clear removes the ignored paymaster URL and its reason', noPaymaster.paymasterUrlIgnoredReason === null && JSON.parse(store.data[AA_KEY])[AA_CHAIN].paymasterUrl === undefined);
}

console.log('stored URLs that pass the rule:');
{
  const httpsBundler = 'https://bundler.example/rpc/';
  const store = memoryStore({
    [AA_KEY]: JSON.stringify({
      [AA_CHAIN]: legacyEntry({ bundlerUrl: httpsBundler, paymasterUrl: 'http://10.0.2.2:4337' }),
    }),
  });
  const config = await getAaConfig(AA_CHAIN, store);
  check('https bundler URL used exactly as stored', config.bundlerUrl === httpsBundler && config.bundlerUrlIgnoredReason === null);
  check('loopback http://10.0.2.2 paymaster still used', config.paymasterUrl === 'http://10.0.2.2:4337' && config.paymasterUrlIgnoredReason === null && config.paymasterContext === '{"policyId":"p"}');
  check('the chain counts as configured', isAaConfigured(config) === true);
}

console.log('look-alike and malformed stored values:');
{
  const store = memoryStore({
    [AA_KEY]: JSON.stringify({
      [AA_CHAIN]: legacyEntry({ bundlerUrl: 'http://localhost@bundler.example', paymasterUrl: 'https://' }),
    }),
  });
  const config = await getAaConfig(AA_CHAIN, store);
  check('http://localhost@host (host after @) is ignored', config.bundlerUrl === null && config.bundlerUrlIgnoredReason === INSECURE_ENDPOINT_MESSAGE);
  check('malformed https URL is ignored with its own message', config.paymasterUrl === null && /incomplete/.test(config.paymasterUrlIgnoredReason ?? ''));
  const empty = await getAaConfig(AA_CHAIN, memoryStore());
  check('an empty store reports no ignored URLs', empty.bundlerUrlIgnoredReason === null && empty.paymasterUrlIgnoredReason === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
