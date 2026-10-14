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
    // Phase 18 item 3: the same for a multisig account (noKey).
    home.includes('const toolsOwner = noKey ? null : evmAccount?.address;') &&
      home.includes('const toolsIndex = noKey ? null : (activeAccount?.index ?? null);') &&
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

// ---------------------------------------------------------------------------
console.log('check-home: the Multisig link only where the multisig contracts are known (custom networks)');
// ---------------------------------------------------------------------------
{
  const home = source('../src/screens/HomeScreen.tsx');
  check('Home: the Multisig link needs a test network AND multisigNetworkVerified(evmChain)',
    home.includes("evmChain.testnet && multisigNetworkVerified(evmChain)\n            ? cardLink('multisig', 'Multisig', () => navigation.navigate('Multisig'), 'Opens the multi-signature accounts')") &&
      /import \{[^}]*\bmultisigNetworkVerified\b[^}]*\} from '\.\.\/config\/evm-chain';/.test(home));
  const { multisigNetworkVerified, recordMultisigNetworkCheck, setCustomEvmProfiles, MULTISIG_UNVERIFIED_NETWORK_NOTE } = evmChainModule;
  check('the note (exact)', MULTISIG_UNVERIFIED_NETWORK_NOTE ===
    "Multi-signature accounts need the Kernel v3.3 contracts and ZeroDev's weighted signer module on this network; the wallet has not verified them here.");
  check('built-in profiles (Kernel v3.3 verified) are offered', [EVM_SEPOLIA, EVM_BASE_SEPOLIA].every((p) => multisigNetworkVerified(p)));
  // A network the user added (Holesky; Hoodi became a built-in profile in phase 18 item 1).
  const hoodi = { ...EVM_SEPOLIA, caip2: 'eip155:17000', chainIdDecimal: '17000', label: 'Holesky', kernelV33Verified: false,
    custom: { rpcUrl: 'https://rpc.holesky.example', nativeSymbol: 'ETH', explorerBase: null, blockTimeMs: null, testnetRequested: true } };
  setCustomEvmProfiles([hoodi]);
  check('a network the user added is NOT offered before a check passed', multisigNetworkVerified(hoodi) === false);
  recordMultisigNetworkCheck(hoodi.caip2, ['The weighted signer module 0x… has no code on this network.']);
  check('…nor after a failed check', multisigNetworkVerified(hoodi) === false);
  recordMultisigNetworkCheck(hoodi.caip2, []);
  check('…and IS offered after a passed check (this session)', multisigNetworkVerified(hoodi) === true);
  recordMultisigNetworkCheck(hoodi.caip2, ['problem']);
  check('a later failed check withdraws it', multisigNetworkVerified(hoodi) === false);
  recordMultisigNetworkCheck(hoodi.caip2, []);
  setCustomEvmProfiles([]);
  check('removing (or changing) the custom networks forgets a passed check', multisigNetworkVerified(hoodi) === false);
  recordMultisigNetworkCheck(EVM_SEPOLIA.caip2, ['problem']);
  check('a failed check never withdraws a built-in verified profile (the profile flag decides there)', multisigNetworkVerified(EVM_SEPOLIA) === true);
  recordMultisigNetworkCheck(EVM_SEPOLIA.caip2, []);
}

// ---------------------------------------------------------------------------
console.log('check-home: a multi-signature account as the active account (phase 18 item 3)');
// ---------------------------------------------------------------------------
// Source checks (the screen needs React): the links for a multisig are only
// Activity, Receive (the address), Multisig (its operations), Tokens, NFTs
// and Approvals (read-only); its EVM card shows the balance and the
// EntryPoint deposit; the other networks say why they are not available.
function homeMultisigProblems(home) {
  const problems = [];
  const need = (what, ok) => {
    if (!ok) problems.push(what);
  };
  need('multisig from the active account', home.includes('const multisig = activeAccount?.multisig === true;'));
  need('noKey covers multisig', home.includes('const noKey = watchOnly || multisig;'));
  need('no Send link (chain card)', /\{noKey\s*\?\s*null\s*:\s*cardLink\('send'/.test(home));
  need('no Send link (token rows)', /\.\.\.\(noKey\s*\?\s*\{\}\s*:\s*\{ onSend:/.test(home));
  need('no Swap link', home.includes('isEvm && evmChain.swapsOffered && !noKey'));
  need('no Upgrade link', /\{isEvm && !noKey\s*\?\s*cardLink\(\s*'upgrade'/.test(home));
  need('no account tools (Sessions, Guardians, Inheritance, Apps, Staking, Passkey)', home.includes('const tools = isEvm && !noKey'));
  need('the tool checks get no owner or index', home.includes('const toolsOwner = noKey ? null') && home.includes('const toolsIndex = noKey ? null'));
  need('no delegation read', home.includes('useAccountDelegation(noKey ? undefined'));
  need('the Multisig operations link',
    home.includes("{isEvm && multisig\n            ? cardLink('multisig-operations', 'Multisig', () => navigation.navigate('Multisig'), 'Opens this multisig’s operations')"));
  need('Activity, NFTs and Approvals stay linked', /cardLink\('activity'/.test(home) && /isEvm \? cardLink\('nfts'/.test(home) && /cardLink\('approvals', 'Approvals'/.test(home));
  need('the EntryPoint deposit read with the Multisig screen\'s reader', home.includes('readMultisigFunds(httpTransport(endpoint.url), multisigAddress)'));
  need('the deposit row', home.includes("{MULTISIG_DEPOSIT_ROW_LABEL}:{' '}") && home.includes('maskAmount(formatBalanceDisplay(shownDeposit.deposit, 18), hideAmounts)'));
  need('the notice under the switcher', home.includes('{multisig ? <WarningBox>{MULTISIG_ACCOUNT_NOTICE}</WarningBox> : null}'));
  need('the other-network note', home.includes('{multisigNetworkNote ? <WarningBox>{multisigNetworkNote}</WarningBox> : null}') && home.includes('multisigInfo.chain !== evmChain.caip2'));
  need('Bitcoin, Dogecoin and Solana not available', home.includes('<UnavailableChains accounts={accounts} sentence={MULTISIG_NO_CHAIN} />'));
  need('no guardian-recovery link', /\{noKey \? null : \(\s*<>\s*\{activeAccount\?\.imported \? null : \(/.test(home));
  need('the multisig footer', home.includes('{multisigFooterText(activeAccount.name)}'));
  return problems;
}
{
  const home = source('../src/screens/HomeScreen.tsx');
  const problems = homeMultisigProblems(home);
  check('Home for a multisig: read-only links + Multisig, balance and deposit, notices, no signing links', problems.length === 0, problems.join('; '));
  for (const [name, from, to] of [
    ['M-h1 Send offered from a multisig (noKey without multisig)', 'const noKey = watchOnly || multisig;', 'const noKey = watchOnly;'],
    ['M-h2 the Multisig operations link dropped', "cardLink('multisig-operations',", "cardLink('multisig-gone',"],
    ['M-h3 the deposit row dropped', "{MULTISIG_DEPOSIT_ROW_LABEL}:{' '}", ''],
    ['M-h4 the notice dropped', '{multisig ? <WarningBox>{MULTISIG_ACCOUNT_NOTICE}</WarningBox> : null}', ''],
  ]) {
    check(`mutation anchor present (${name})`, home.includes(from));
    check(`${name}: caught`, homeMultisigProblems(home.replace(from, to)).length > 0);
  }
  const {
    MULTISIG_ACCOUNT_NOTICE,
    MULTISIG_RECEIVE_NOTE,
    MULTISIG_SWITCHER_LINE,
    multisigFooterText,
    multisigOtherNetworkNote,
  } = await import('../src/wallet/watch-only.ts');
  const { MULTISIG_NO_CHAIN } = await import('../src/wallet/account-ids.ts');
  check('the notice (exact)', MULTISIG_ACCOUNT_NOTICE ===
    'Multi-signature account: no single key in this wallet can send from it. Its operations are signing requests that its co-signers approve on the Multisig screen. It cannot sign messages or connect to apps.');
  check('the Receive sentence (exact)', MULTISIG_RECEIVE_NOTE ===
    'This is the multi-signature account’s own address. Anyone can send to it, but every operation that moves anything out of it needs its co-signers’ approvals, built on the Multisig screen.');
  check('the switcher line (exact)', MULTISIG_SWITCHER_LINE === 'Multisig — operations need co-signers; Ethereum networks only');
  check('the not-available sentence (exact)', MULTISIG_NO_CHAIN ===
    'Not available for a multi-signature account. A multisig is an Ethereum smart account; it has no address on this network.');
  check('the other-network note (exact)', multisigOtherNetworkNote('Multisig 2 (2-of-3)', 'Ethereum Sepolia', 'Base Sepolia') ===
    'Multisig 2 (2-of-3) is recorded on Ethereum Sepolia, and the Multisig screen builds its operations only there. The active network here is Base Sepolia; send to this address only on Ethereum Sepolia.');
  check('the footer (exact start)', multisigFooterText('Multisig 2 (2-of-3)').startsWith(
    'Multisig 2 (2-of-3) is a multi-signature account: its operations are built on the Multisig screen and need its co-signers’ approvals.'));
}

// Phase 18 emulator finding 5: Hoodi's Home offered "Lost a recovery phrase?
// Recover an account with guardians" although Hoodi has no Kernel v3.3 stack
// (no guardian modules, no RecoveryAction). The footer link now follows the
// profile's kernelV33Verified.
console.log('check-home: the guardian-recovery footer only where Kernel v3.3 is verified');
{
  const home = source('../src/screens/HomeScreen.tsx');
  const GATE = '{!evmChain.kernelV33Verified ? null : (';
  // The footer link's block: the kernelV33Verified gate wraps the existing
  // watch-only / multisig (noKey) and imported-key gates, which stay as they
  // were, then the link text.
  const footerGated = (src) => {
    const at = src.indexOf('Lost a recovery phrase? Recover an account with guardians');
    const gate = src.lastIndexOf(GATE, at);
    return at > 0 && gate > 0 &&
      /^\{!evmChain\.kernelV33Verified \? null : \(\s*<>\s*\{noKey \? null : \(\s*<>\s*\{activeAccount\?\.imported \? null : \(\s*<Pressable/.test(src.slice(gate, at));
  };
  check('the footer link sits inside the kernelV33Verified gate, around the noKey and imported-key gates', footerGated(home));
  check('mutation: the footer without the kernelV33Verified gate is caught',
    !footerGated(home.replace(GATE, '{false ? null : (')));
  check('the link text appears once (no second, ungated copy)',
    home.split('Lost a recovery phrase? Recover an account with guardians').length === 2);
  const { EVM_PROFILES } = evmChainModule;
  const shown = EVM_PROFILES.filter((p) => p.kernelV33Verified).map((p) => p.label).join(', ');
  const hidden = EVM_PROFILES.filter((p) => !p.kernelV33Verified).map((p) => p.label).join(', ');
  check('the footer shows on Ethereum, Ethereum Sepolia, Base Sepolia, Arbitrum Sepolia and OP Sepolia; hidden on Hoodi',
    shown === 'Ethereum, Ethereum Sepolia, Base Sepolia, Arbitrum Sepolia, OP Sepolia' && hidden === 'Hoodi', `${shown} | ${hidden}`);
}

// Phase 18 item 3 emulator finding 6: the staking token rows were titled by
// the token NAME ("Liquid staked Ether 2.0", cut off) and the badges cut the
// symbol to four characters ("stET", "wstE").
console.log('Home token rows: symbol as the title, the name below, the whole symbol in the badge:');
{
  const { tokenRowSubtitle, knownStakingTokensForChain, knownTokensForChain } = await import('../src/wallet/tokens.ts');
  const steth = knownStakingTokensForChain('eip155:11155111').find((t) => t.symbol === 'stETH');
  check('subtitle: the name and ERC-20 when the name differs from the symbol (exact)',
    tokenRowSubtitle(steth) === 'Liquid staked Ether 2.0 · ERC-20' && tokenRowSubtitle({ symbol: 'USDC', name: 'USD Coin' }) === 'USD Coin · ERC-20');
  check('subtitle: just "ERC-20" when the name is the symbol again (Sepolia USDC and EURC) or empty',
    knownTokensForChain('eip155:11155111').every((t) => tokenRowSubtitle(t) === 'ERC-20') && tokenRowSubtitle({ symbol: 'X', name: '' }) === 'ERC-20');
  const home = source('../src/screens/HomeScreen.tsx');
  const row = home.slice(home.indexOf('function TokenRow('), home.indexOf('function UnavailableChains('));
  const rowProblems = (src) => [
    /<Text style=\{\[styles\.tokenName, \{ color: theme\.text \}\]\} numberOfLines=\{1\}>\s*\{token\.symbol\}\s*<\/Text>/.test(src) || 'the title is the symbol',
    // Two lines since the 2026-10-11 re-check (finding 8: the wstETH name was cut off).
    /<Text style=\{\[styles\.tokenKind, \{ color: theme\.textMuted \}\]\} numberOfLines=\{2\}>\s*\{tokenRowSubtitle\(token\)\}/.test(src) || 'the name on the second line, up to two lines',
    /<Text style=\{\[styles\.tokenBadgeText, \{ color: theme\.textMuted \}\]\} numberOfLines=\{1\}>\s*\{token\.symbol\}\s*<\/Text>/.test(src) || 'the whole symbol in the badge',
    !src.includes('token.symbol.slice(0, 4)') || 'no four-character cut',
    !/\{token\.name\}/.test(src) || 'the name is not the title',
  ].filter((x) => x !== true);
  check('TokenRow: symbol title, name subtitle, the whole symbol in the badge (source)', rowProblems(row).length === 0, rowProblems(row).join('; '));
  check('…mutant: the old four-character badge is caught', rowProblems(row.replace(/\{token\.symbol\}(\s*<\/Text>\s*<\/View>\s*<View style=\{styles\.cardBody\})/, '{token.symbol.slice(0, 4)}$1')).length > 0);
  check('…mutant: the old one-line subtitle is caught',
    rowProblems(row.replace(/(styles\.tokenKind, \{ color: theme\.textMuted \}\]\} )numberOfLines=\{2\}/, '$1numberOfLines={1}')).length > 0);
  check('…mutant: the old name title is caught', rowProblems(row.replace(/(styles\.tokenName[^>]*>\s*)\{token\.symbol\}/, '$1{token.name}')).length > 0);
  const badge = home.slice(home.indexOf('  tokenBadge: {'), home.indexOf('  tokenBadgeText: {'));
  check('the badge is a pill from 36 to 72 px wide with side padding, 36 px high (fits "wstETH")',
    /minWidth: 36,/.test(badge) && /maxWidth: 72,/.test(badge) && /height: 36,/.test(badge) && /paddingHorizontal: 5,/.test(badge) && !/\bwidth: 36,/.test(badge.replace('minWidth', 'min')));
}

// Pass p20c (TalkBack, 2026-10-14) findings 3, 4 and 13.
console.log('Home: one spoken element per token row, the Hide amounts switch, links spoken as shown (pass p20c):');
{
  const { tokenRowSpokenLabel, spokenLinkText } = await import('../src/a11y.ts');
  const home = source('../src/screens/HomeScreen.tsx');
  const row = home.slice(home.indexOf('function TokenRow('), home.indexOf('function UnavailableChains('));
  // (3) The label: symbol, second line, balance — the same order on every row.
  check('finding 3: a token row is spoken symbol → second line → balance (exact)',
    tokenRowSpokenLabel({ symbol: 'wstETH', subtitle: 'Wrapped liquid staked Ether 2.0 · ERC-20', balance: 'Balance 0.000564 wstETH' }) ===
      'wstETH, Wrapped liquid staked Ether 2.0, ERC-20. Balance 0.000564 wstETH' &&
      tokenRowSpokenLabel({ symbol: 'USDC', subtitle: 'ERC-20', balance: 'Balance hidden' }) === 'USDC, ERC-20. Balance hidden');
  const rowOk = (src) =>
    /<View\s+style=\{\[styles\.tokenRow, [^\]]*\]\}\s+accessible\s+accessibilityLabel=\{tokenRowSpokenLabel\(\{/.test(src) &&
    src.includes('balance: balanceSpokenText(state, hidden, fiat),') &&
    src.includes("const hideChildren = { importantForAccessibility: 'no-hide-descendants' as const, accessibilityElementsHidden: true };") &&
    src.includes('<View style={[styles.tokenBadge, { borderColor: theme.border }]} {...hideChildren}>') &&
    src.includes('<View style={styles.cardBody} {...hideChildren}>') &&
    /<View \{\.\.\.hideChildren\}>\s*<BalanceCell /.test(src) &&
    src.includes("accessibilityActions: [{ name: 'activate', label: retry ? 'Retry' : `Send ${token.symbol}` }],") &&
    src.includes("if (e.nativeEvent.actionName === 'activate') action();");
  check('…the row is ONE accessible element: badge, text and balance hidden from screen readers, Send (or Retry) its action (source)', rowOk(row));
  check('…mutant caught: the badge spoken again as its own item',
    !rowOk(row.replace('<View style={[styles.tokenBadge, { borderColor: theme.border }]} {...hideChildren}>', '<View style={[styles.tokenBadge, { borderColor: theme.border }]}>')));
  check('…BalanceCell and the row share one balance sentence (balanceSpokenText), the ok case unchanged ("Balance 0.5 ETH, about $1,234.56")',
    home.includes('accessibilityLabel={balanceSpokenText(state, hidden, fiat)}') &&
      home.includes('return `Balance ${spokenAmount(state.display)} ${state.symbol}${spokenFiat}${spokenStale}`;') &&
      home.includes("if (hidden) return 'Balance hidden';"));
  // (4) Hide amounts: a switch with its state.
  const toggleOk = (src) =>
    /accessibilityRole="switch"\s+accessibilityLabel="Hide amounts"\s+accessibilityState=\{\{ checked: hideAmounts \}\}/.test(src) &&
    !src.includes("accessibilityLabel={hideAmounts ? 'Show amounts' : 'Hide amounts'}");
  check('finding 4: the Hide amounts toggle is a switch named "Hide amounts" with checked = hideAmounts (source)', toggleOk(home));
  check('…mutant caught: the old plain button', !toggleOk(home.replace(/accessibilityRole="switch"\s+accessibilityLabel="Hide amounts"\s+accessibilityState=\{\{ checked: hideAmounts \}\}/, "accessibilityRole=\"button\"\n                accessibilityLabel={hideAmounts ? 'Show amounts' : 'Hide amounts'}")));
  // (13) Links: the spoken name is the visible text.
  check('finding 13: spokenLinkText drops only the decorative arrow and check mark (exact)',
    spokenLinkText('Send ↗') === 'Send' && spokenLinkText('Passkey ✓') === 'Passkey' && spokenLinkText('Upgraded ✓') === 'Upgraded' &&
      spokenLinkText('Inheritance (demonstration)') === 'Inheritance (demonstration)');
  const calls = [...home.matchAll(/cardLink\(\s*'([^']+)',\s*('[^']*'|[^,]+\?[^,]+),/g)].map((m) => [m[1], m[2]]);
  const linksOk = (src) =>
    src.includes('const cardLink = (key: string, text: string, onPress: () => void, hint?: string) => (') &&
    src.includes('accessibilityLabel={spokenLinkText(text)}') &&
    src.includes("cardLink('inheritance', 'Inheritance (demonstration)', () => navigation.navigate('Inheritance'))");
  check('…every Home link is spoken as its visible text: cardLink takes the text once and speaks spokenLinkText(text); Inheritance reads "Inheritance (demonstration)" (source)',
    linksOk(home) && calls.length >= 14, `${calls.length} calls`);
  check('…mutant caught: the old Inheritance link spoken "Inheritance"',
    !linksOk(home.replace("cardLink('inheritance', 'Inheritance (demonstration)',", "cardLink('inheritance', 'Inheritance', 'Inheritance (demonstration)',")));
}

console.log(`\ncheck-home: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
