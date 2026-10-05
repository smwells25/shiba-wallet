// Home screen behaviour fixed after the in-app Base Sepolia run of phase 12
// (AGENTS.md, phase 12 item 1 second half, findings 2, 3, 4, 6 and 7).
//
// OFFLINE: fakes only. It imports the exact app modules through Node's type
// stripping and pins:
//
//  - finding 7: every EOA broadcast path reports through
//    send.ts addSendAcceptedListener only after the node accepted the
//    transaction; home-refresh.ts marks Home's balances stale once per
//    accepted send and reloads them now and once more later on focus;
//  - finding 2: the three eligibility hooks re-check when the AA
//    configuration changes, an operation is accepted, or Home asks (focus
//    and pull-to-refresh) — checked in the hook and screen sources, since
//    the hooks themselves need React;
//  - finding 3: a dust balance keeps its "< 0.000001" form, Hide amounts
//    still masks it, and its fiat value is computed from the exact amount;
//  - finding 4: the Swap link is hidden where swaps are not offered (Base
//    Sepolia); since phase 13 item 1 the token section shows the active
//    network's own tracked list on every profile (the old test-mode note
//    that hid tokens is gone);
//  - finding 6: displayed dates use the device's local calendar day.
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-home.mjs
//
// The signing key derives from the standard BIP-39 test mnemonic
// ("abandon ... about"), which is public knowledge.

import { readFileSync } from 'node:fs';
import { evmKeyProvider, mnemonicToSeed } from '@shiba-wallet/core';
import { addSendAcceptedListener, notifySendAccepted, sendEvm } from '../src/wallet/send.ts';
import { FOLLOW_UP_RELOAD_MS, createSendRefreshTracker, reloadNowAndLater } from '../src/wallet/home-refresh.ts';
import { formatBalanceDisplay, spokenAmount } from '../src/wallet/balances.ts';
import { maskAmount } from '../src/config/prefs.ts';
import { formatFiat } from '../src/wallet/prices.ts';
import * as evmChainModule from '../src/config/evm-chain.ts';
import { EVM_BASE_SEPOLIA, EVM_MAINNET, EVM_SEPOLIA } from '../src/config/evm-chain.ts';
import { localDateLabel } from '../src/config/dates.ts';
import { protectionDate } from '../src/wallet/phrase-protection-copy.ts';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// Finding 7: reload balances after a send
// ---------------------------------------------------------------------------

console.log('balances reload after a send (finding 7):');

{
  // A tracker over two fake sources.
  const listeners = [new Set(), new Set()];
  const sources = listeners.map((set) => (fn) => {
    set.add(fn);
    return () => set.delete(fn);
  });
  const tracker = createSendRefreshTracker(sources);
  check('not stale before anything happened', tracker.takeStale() === false);
  const stop = tracker.start();
  check('start subscribes to every source', listeners[0].size === 1 && listeners[1].size === 1);
  for (const fn of listeners[1]) fn();
  check('an accepted send marks the balances stale', tracker.takeStale() === true);
  check('takeStale clears the mark (one reload per send)', tracker.takeStale() === false);
  for (const fn of listeners[0]) fn();
  for (const fn of listeners[0]) fn();
  check('several sends before the next focus need one reload', tracker.takeStale() === true && tracker.takeStale() === false);
  stop();
  check('stop unsubscribes from every source', listeners[0].size === 0 && listeners[1].size === 0);
}

{
  // reloadNowAndLater with fake timers.
  const timers = [];
  const calls = [];
  const cancel = reloadNowAndLater(
    () => calls.push('now'),
    () => calls.push('later'),
    FOLLOW_UP_RELOAD_MS,
    {
      set: (fn, ms) => {
        timers.push({ fn, ms, cleared: false });
        return timers.length - 1;
      },
      clear: (handle) => {
        timers[handle].cleared = true;
      },
    },
  );
  check('the first reload runs at once', calls.join(',') === 'now');
  check(`one follow-up reload is scheduled ${FOLLOW_UP_RELOAD_MS} ms later`, timers.length === 1 && timers[0].ms === FOLLOW_UP_RELOAD_MS);
  timers[0].fn();
  check('the follow-up runs the later reload', calls.join(',') === 'now,later');
  cancel();
  check('cancel clears the follow-up timer (Home lost focus)', timers[0].cleared === true);
  const same = [];
  reloadNowAndLater(() => same.push(1), undefined, 5, { set: (fn) => fn(), clear: () => undefined });
  check('later defaults to the same reload', same.length === 2);
}

{
  // The real signal: sendEvm notifies only after the node accepted.
  let accepted = 0;
  const stop = addSendAcceptedListener(() => {
    accepted += 1;
  });
  const seed = mnemonicToSeed(
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  );
  const signer = evmKeyProvider.deriveAccount(seed, 0, 0);
  seed.fill(0);
  const quote = {
    kind: 'evm',
    to: '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
    amount: 1n,
    balance: 10n ** 18n,
    nonce: 0n,
    chainId: 84532n,
    gasLimit: 21000n,
    maxFeePerGas: 3_000_000n,
    maxPriorityFeePerGas: 1_000_000n,
    fee: 63_000_000_000n,
    total: 63_000_000_001n,
    simulation: { ok: true },
  };
  let refuse = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const { id, method } = JSON.parse(init.body);
    if (method !== 'eth_sendRawTransaction') throw new Error(`unexpected ${method}`);
    const body = refuse
      ? { jsonrpc: '2.0', id, error: { code: -32000, message: 'insufficient funds for gas * price + value' } }
      : { jsonrpc: '2.0', id, result: '0x' + 'ab'.repeat(32) };
    return { ok: true, json: async () => body };
  };
  await sendEvm('https://offline.fake/rpc', signer, quote, null);
  check('sendEvm reports an accepted transaction', accepted === 1, String(accepted));
  refuse = true;
  await sendEvm('https://offline.fake/rpc', signer, quote, null).catch(() => undefined);
  check('sendEvm reports nothing when the node refused', accepted === 1, String(accepted));
  globalThis.fetch = realFetch;
  notifySendAccepted();
  check('notifySendAccepted reaches subscribers', accepted === 2);
  const throwing = addSendAcceptedListener(() => {
    throw new Error('listener bug');
  });
  let threw = false;
  try {
    notifySendAccepted();
  } catch {
    threw = true;
  }
  check('a failing listener never breaks the send path', !threw && accepted === 3);
  throwing();
  stop();
  notifySendAccepted();
  check('unsubscribed listeners are not called', accepted === 3);

  const sendSource = source('../src/wallet/send.ts');
  const after = (fn, marker) => {
    const start = sendSource.indexOf(`export async function ${fn}(`);
    const body = sendSource.slice(start, sendSource.indexOf('\n}\n', start));
    return body.indexOf(marker) !== -1 && body.indexOf('notifySendAccepted();') > body.indexOf(marker);
  };
  check('sendEvm notifies after eth_sendRawTransaction', after('sendEvm', 'sendRawTransaction('));
  check('sendUtxo notifies after the broadcast', after('sendUtxo', 'signAndBroadcast('));
  check('sendSol notifies after sendTransaction', after('sendSol', 'sendTransaction('));
  check(
    'the set-code (EIP-7702) and approveWithSig transactions notify too',
    source('../src/wallet/delegation.ts').includes('invalidateAccountDelegation(quote.from);\n  notifySendAccepted();') &&
      source('../src/wallet/recovery.ts').includes('const txid = await client.sendRawTransaction(signed.rawHex);\n  notifySendAccepted();'),
  );
}

{
  const home = source('../src/screens/HomeScreen.tsx');
  check(
    'Home tracks accepted EOA sends and smart-account operations',
    home.includes('createSendRefreshTracker([addSendAcceptedListener, addAaSentListener])'),
  );
  check(
    'Home reloads only on focus when a send was accepted, then once more later',
    home.includes('if (!sendTracker.current.takeStale()) return undefined;') && home.includes('return reloadNowAndLater('),
  );
  check(
    'the reload goes through the per-row fetch (each row keeps its own retry state)',
    home.includes('for (const account of accounts) void refreshOne(account.chainId);'),
  );
}

// ---------------------------------------------------------------------------
// Finding 2: account-tool links re-check
// ---------------------------------------------------------------------------

console.log('account-tool eligibility re-checks (finding 2):');

for (const [file, name] of [
  ['../src/wallet/useSessionEligibility.ts', 'useSessionEligibility'],
  ['../src/wallet/useRecoveryInfo.ts', 'useRecoveryInfo'],
  ['../src/wallet/usePasskeyInfo.ts', 'usePasskeyInfo'],
]) {
  const text = source(file);
  check(
    `${name} re-runs on AA state changes and on the caller's refresh key`,
    text.includes('const revision = useAaStateRevision();') &&
      text.includes('evmChain.chainIdDecimal, revision, refreshKey]);') &&
      text.includes('accountIndex: number | null, refreshKey = 0)'),
  );
  check(`${name} still gates on isAaConfigured (readiness unchanged)`, text.includes('isAaConfigured(config, owner)'));
  check(
    `${name} keys its answer by chain, owner and index only (the old answer stays while re-checking)`,
    text.includes("const key = `${evmChain.caip2}|${owner ?? ''}|${accountIndex ?? ''}`;"),
  );
}
{
  const revision = source('../src/wallet/useAaStateRevision.ts');
  check('useAaStateRevision subscribes through subscribeAaStateChanges', revision.includes('subscribeAaStateChanges(() => setRevision('));
  const home = source('../src/screens/HomeScreen.tsx');
  check(
    'Home passes its refresh counter to all three hooks',
    // Feature 10: the owner and index are null for a watch-only account (no
    // smart-account checks for an address the wallet cannot sign for), and
    // otherwise exactly the active account's address and index as before.
    home.includes('const toolsOwner = watchOnly ? null : evmAccount?.address;') &&
      home.includes('const toolsIndex = watchOnly ? null : (activeAccount?.index ?? null);') &&
      home.includes('useSessionEligibility(toolsOwner, toolsIndex, toolsRefresh)') &&
      home.includes('useRecoveryInfo(toolsOwner, toolsIndex, toolsRefresh)') &&
      home.includes('usePasskeyInfo(toolsOwner, toolsIndex, toolsRefresh)'),
  );
  check(
    'the counter grows on focus (after the first) and on pull-to-refresh',
    home.includes('if (focusedBefore.current) setToolsRefresh((value) => value + 1);') &&
      /onRefresh=\{\(\) => \{[^}]*setToolsRefresh\(\(value\) => value \+ 1\);/s.test(home),
  );
  const aa = source('../src/wallet/aa.ts');
  const save = aa.slice(aa.indexOf('async function saveConfigMap('), aa.indexOf('export type AaConfigChangedListener'));
  check(
    'every AA config write notifies after it succeeded (one write path)',
    save.indexOf('await store.setItem(AA_CONFIG_KEY') !== -1 &&
      save.indexOf('notifyAaConfigChanged();') > save.indexOf('await store.setItem(AA_CONFIG_KEY') &&
      !/store\.setItem\(AA_CONFIG_KEY/.test(aa.replace(save, '')),
  );
}

// ---------------------------------------------------------------------------
// Finding 3: dust balances
// ---------------------------------------------------------------------------

console.log('dust balances (finding 3):');

{
  const DUST = 107_672_250_846n;
  const display = formatBalanceDisplay(DUST, 18);
  check('Home shows the live dust as "< 0.000001", not "0"', display === '< 0.000001', display);
  check('Hide amounts still masks it', maskAmount(display, true) === '••••');
  check('the screen reader hears "less than 0.000001"', spokenAmount(display) === 'less than 0.000001');
  const quote = { assetId: 'x', currency: 'usd', price: '2500', provider: 'coingecko', updatedAtMs: 0, fetchedAtMs: 0 };
  const fiat = formatFiat(quote, DUST, 18, { hidden: false, nowMs: 0 });
  check('fiat is computed from the exact amount ("< $0.01"), not from the display text', fiat?.text === '< $0.01', JSON.stringify(fiat));
  check('Hide amounts masks the fiat line too', formatFiat(quote, DUST, 18, { hidden: true, nowMs: 0 })?.text === '≈ ••••');
  check(
    'Home native and token rows use formatBalanceDisplay',
    source('../src/wallet/useBalances.ts').includes('display: formatBalanceDisplay(load.amount, used.network.decimals),') &&
      source('../src/wallet/useTokenBalances.ts').includes('display: formatBalanceDisplay(load.amount, token.decimals),'),
  );
  check('Home speaks the balance through spokenAmount', source('../src/screens/HomeScreen.tsx').includes('`Balance ${spokenAmount(state.display)} '));
}

// ---------------------------------------------------------------------------
// Finding 4: profile-specific copy and the Swap link
// ---------------------------------------------------------------------------

console.log('test-network copy and the Swap link (finding 4):');

check('the hide-tokens note is gone (tokens are per chain since phase 13 item 1)', !('testModeTokenNote' in evmChainModule));
check('swaps offered on mainnet (kept)', EVM_MAINNET.swapsOffered === true);
check('swaps offered on Ethereum Sepolia (unchanged since phase 5)', EVM_SEPOLIA.swapsOffered === true);
check('swaps NOT offered on Base Sepolia (0x lists no Base Sepolia)', EVM_BASE_SEPOLIA.swapsOffered === false);
{
  const home = source('../src/screens/HomeScreen.tsx');
  check('Home gates the Swap link on the active profile', home.includes('isEvm && evmChain.swapsOffered'));
  check(
    'Home lists the ACTIVE chain\'s tokens on every profile (no testnet gate)',
    home.includes('useTokenBalances(\n    evmAccount?.address,\n    evmChain.caip2,\n  )') &&
      !home.includes('showTokens') &&
      !home.includes('tracked tokens are mainnet assets'),
  );
  check('Home prices tokens only through tokenPriceAssetId (test tokens stay unpriced)', home.includes('...tokens.map((t) => tokenPriceAssetId(t, evmChain.caip2)),'));
}

// ---------------------------------------------------------------------------
// Finding 6: local dates
// ---------------------------------------------------------------------------

console.log('displayed dates are the local day (finding 6):');

{
  const savedTz = process.env.TZ;
  // 01:12 UTC on 4 October is still 3 October in New York (UTC−4).
  const LATE_EVENING_EASTERN = '2026-10-04T01:12:00.000Z';
  process.env.TZ = 'America/New_York';
  check('New York: a check at 21:12 local reads 2026-10-03', localDateLabel(LATE_EVENING_EASTERN) === '2026-10-03', localDateLabel(LATE_EVENING_EASTERN));
  check('New York: milliseconds work the same way', localDateLabel(Date.parse(LATE_EVENING_EASTERN)) === '2026-10-03');
  check('New York: protectionDate follows the same rule', protectionDate(Date.parse(LATE_EVENING_EASTERN)) === '2026-10-03');
  process.env.TZ = 'UTC';
  check('UTC: the same instant reads 2026-10-04', localDateLabel(LATE_EVENING_EASTERN) === '2026-10-04');
  process.env.TZ = 'Asia/Tokyo';
  check('Tokyo (UTC+9): 20:00 UTC on 3 October reads 2026-10-04', localDateLabel('2026-10-03T20:00:00.000Z') === '2026-10-04');
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
  check('missing value → "unknown date"', localDateLabel(null) === 'unknown date' && localDateLabel(undefined) === 'unknown date' && localDateLabel('') === 'unknown date');
  check('unparseable value → "unknown date"', localDateLabel('not a date') === 'unknown date' && protectionDate(Number.NaN) === 'unknown date');
  check('the format stays YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(localDateLabel('2026-01-05T12:00:00.000Z')));
  const settings = source('../src/screens/SettingsScreen.tsx');
  check(
    'Settings shows no UTC day slices any more',
    !settings.includes('.slice(0, 10)') && (settings.match(/localDateLabel\(/g) ?? []).length >= 6,
  );
  check('Guardians backup date uses the local day', source('../src/screens/GuardiansScreen.tsx').includes('Backed up off-device ${localDateLabel(entry.exportedAt)}.'));
}

console.log(`\ncheck-home: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
