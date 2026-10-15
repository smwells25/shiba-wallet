// Phase 4 items 5 + 6 checks, entirely OFFLINE: the auto-lock state
// machine (src/wallet/lock.ts), the preference store and privacy mask
// (src/config/prefs.ts), the active-EVM-chain profiles and their pinned
// Sepolia constants (src/config/evm-chain.ts, src/config/defaults.ts),
// active-chain switching through the real prepareEvmSend/sendEvm
// machinery against a fake JSON-RPC node behind global fetch (a Sepolia
// quote passes with chain id 11155111 and refuses 1, and vice versa in
// mainnet mode), explorer-link overrides, the WalletConnect namespace /
// request-routing parameterization, and the AA prefill verify-before-save
// under the Sepolia store key. No network request leaves the process,
// nothing is broadcast.
//
// Like check-aa.mjs, it imports the actual TypeScript modules the app
// runs via Node's native type stripping. Run from the app directory:
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-devmode.mjs
//
// The signing key used by the sendEvm leg derives from the standard
// BIP-39 test mnemonic ("abandon ... about"), public knowledge.

import { evmKeyProvider, mnemonicToSeed, toChecksumAddress } from '@shiba-wallet/core';
import { ENTRYPOINT_V07, encodeFunctionCall, toBytes, toHex } from '@shiba-wallet/chains-evm';
import { INITIAL_LOCK_STATE, reduceLock } from '../src/wallet/lock.ts';
import { contrastRatio, darkTheme, lightTheme, relativeLuminance } from '../src/theme-palette.ts';
import {
  AUTO_LOCK_CHOICES,
  DEFAULT_PREFS,
  loadPrefs,
  maskAmount,
  savePrefs,
} from '../src/config/prefs.ts';
import {
  EVM_ARBITRUM_SEPOLIA,
  EVM_BASE_SEPOLIA,
  EVM_HOODI,
  EVM_MAINNET,
  EVM_OP_SEPOLIA,
  l1CostInGasNote,
  multisigNetworkVerified,
  EVM_PROFILES,
  EVM_SEPOLIA,
  EVM_TEST_PROFILES,
  evmProfileByCaip2,
  evmProfileFor,
  isTestProfileId,
} from '../src/config/evm-chain.ts';
import {
  BASE_SEPOLIA_NETWORK,
  DEFAULT_NETWORKS,
  TEST_EVM_NETWORKS,
  SEPOLIA_NETWORK,
  networkDefaultFor,
  resolveActiveNetworks,
} from '../src/config/defaults.ts';
import { EVM_CHAIN_ID, maxEvmSend, prepareEvmSend, sendEvm } from '../src/wallet/send.ts';
import { explorerTxUrl } from '../src/wallet/history.ts';
import {
  WcRequestRejection,
  WC_ERRORS,
  buildWalletNamespaces,
  describeChain,
  describeProposal,
  modeMismatchMessage,
  parseTypedDataV4,
  parseWcRequest,
} from '../src/wallet/walletconnect.ts';
import { getAaConfig, setAaFactory } from '../src/wallet/aa.ts';
import { getIndexerConfig, setIndexerUrl } from '../src/wallet/indexer.ts';
import { getNftIndexerConfig } from '../src/wallet/nfts.ts';
import { CONTACT_NETWORK_IDS, addContact, listContacts, validateContactAddress } from '../src/wallet/contacts.ts';
import {
  INSECURE_ENDPOINT_MESSAGE,
  LOOPBACK_HOSTS,
  assertSecureEndpointUrl,
} from '../src/config/endpoint-url.ts';
import {
  getAllEndpoints,
  getEndpoint,
  resetEndpoint,
  setEndpointOverride,
} from '../src/config/networks.ts';

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

async function checkRejects(name, promiseFn, messagePattern) {
  try {
    const value = await promiseFn();
    check(name, false, `expected a rejection, got ${JSON.stringify(value)}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    check(name, messagePattern.test(message), `error was: ${message}`);
  }
}

function memoryStore() {
  const mem = new Map();
  return {
    getItem: async (key) => (mem.has(key) ? mem.get(key) : null),
    setItem: async (key, value) => {
      mem.set(key, value);
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Lock state machine (src/wallet/lock.ts)
// ---------------------------------------------------------------------------

console.log('lock state machine:');

const MIN = 60_000;
const at = (type, status, now) => ({ type, status, now });

{
  // backgrounded -> threshold reached -> locked
  let s = INITIAL_LOCK_STATE;
  s = reduceLock(s, at('app-state', 'background', 1_000), MIN);
  check('background records the away-moment', s.backgroundedAt === 1_000 && !s.locked);
  s = reduceLock(s, at('app-state', 'active', 1_000 + MIN), MIN);
  check('active at exactly the threshold locks', s.locked === true);
  check('active clears the away-moment', s.backgroundedAt === null);
  s = reduceLock(s, { type: 'unlock' }, MIN);
  check('unlock clears the lock', s.locked === false && s.backgroundedAt === null);
}
{
  // under the threshold -> not locked
  let s = INITIAL_LOCK_STATE;
  s = reduceLock(s, at('app-state', 'background', 5_000), MIN);
  s = reduceLock(s, at('app-state', 'active', 5_000 + MIN - 1), MIN);
  check('active just under the threshold does not lock', s.locked === false);
  check('under-threshold return still clears the timer', s.backgroundedAt === null);
}
{
  // iOS 'inactive' counts as going away; flapping keeps the EARLIEST moment
  let s = INITIAL_LOCK_STATE;
  s = reduceLock(s, at('app-state', 'inactive', 10_000), MIN);
  check("'inactive' starts the away-timer", s.backgroundedAt === 10_000);
  s = reduceLock(s, at('app-state', 'background', 40_000), MIN);
  check('later background keeps the earliest away-moment', s.backgroundedAt === 10_000);
  s = reduceLock(s, at('app-state', 'active', 10_000 + MIN), MIN);
  check('lock measures from the earliest away-moment', s.locked === true);
}
{
  // threshold off -> never locks
  let s = INITIAL_LOCK_STATE;
  s = reduceLock(s, at('app-state', 'background', 0), null);
  s = reduceLock(s, at('app-state', 'active', 10 * MIN), null);
  check('auto-lock off never locks', s.locked === false && s.backgroundedAt === null);
}
{
  // locked stays locked across further app-state churn until unlock
  let s = { locked: true, backgroundedAt: null };
  s = reduceLock(s, at('app-state', 'background', 100), MIN);
  s = reduceLock(s, at('app-state', 'active', 200), MIN);
  check('a short round-trip while locked stays locked', s.locked === true);
}
{
  // backwards clock never locks
  let s = INITIAL_LOCK_STATE;
  s = reduceLock(s, at('app-state', 'background', 1_000_000), MIN);
  s = reduceLock(s, at('app-state', 'active', 0), MIN);
  check('a backwards clock does not lock', s.locked === false);
}

// ---------------------------------------------------------------------------
// 1b. Lock on launch (F-77(b); docs/DURESS_WALLET.md 5.2 Stage 0)
// ---------------------------------------------------------------------------
// With auto-lock on the wallet STARTS locked; with it off it starts unlocked.
// The component's render is simulated with the same pure functions LockGate
// calls while rendering (reconcileLockGate, then lockGateView on the result),
// over every order in which the three launch inputs can arrive, and the
// source pins below hold LockGate to exactly that use. Mutants of lock.ts are
// written to a temporary directory and must each fail.
{
  const lockMod = await import('../src/wallet/lock.ts');
  const { readFileSync: readLockFs, writeFileSync: writeLockFs, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const lockSource = readLockFs(new globalThis.URL('../src/wallet/lock.ts', import.meta.url), 'utf8');
  const mutantDir = mkdtempSync(joinPath(tmpdir(), 'shiba-lock-mutants-'));
  let mutantCount = 0;
  const lockMutant = async (from, to) => {
    if (!lockSource.includes(from)) throw new Error(`lock.ts mutation anchor missing: ${from}`);
    mutantCount += 1;
    const file = joinPath(mutantDir, `lock-${mutantCount}.ts`);
    writeLockFs(file, lockSource.replace(from, to));
    return import(pathToFileURL(file).href);
  };

  console.log('\nlock on launch:');
  const LAUNCH_HINT = "Auto-lock is on, so the wallet starts locked. Your keys never left the device's secure storage.";
  const BACKGROUND_HINT = "The app locked itself after being in the background. Your keys never left the device's secure storage.";
  const base = { walletStatus: 'loading', prefsReady: false, autoLockMs: null, available: null };

  // Every order of the three asynchronous arrivals at launch: the wallet's
  // status ('ready'), the stored preferences (with the stored threshold) and
  // the device's biometric answer. Returns the view of every render.
  const ARRIVALS = ['wallet', 'prefs', 'device'];
  const permutations = (xs) => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest])));
  const launch = (mod, { stored, device = true, wallet = 'ready' }, order) => {
    let inputs = { ...base };
    let gate = mod.INITIAL_LOCK_GATE_STATE;
    const frames = [];
    const render = () => {
      gate = mod.reconcileLockGate(gate, inputs);
      frames.push({ inputs: { ...inputs }, view: mod.lockGateView(gate, inputs), gate });
    };
    render();
    for (const step of order) {
      if (step === 'wallet') inputs = { ...inputs, walletStatus: wallet };
      if (step === 'prefs') inputs = { ...inputs, prefsReady: true, autoLockMs: stored };
      if (step === 'device') inputs = { ...inputs, available: device };
      render();
    }
    return { frames, gate, inputs, final: frames[frames.length - 1].view };
  };
  const everyOrder = (mod, opts) => permutations(ARRIVALS).map((order) => ({ order, ...launch(mod, opts, order) }));

  // The properties every correct gate has; mutants must break at least one.
  const lockOnLaunchHolds = (mod) => {
    const on = everyOrder(mod, { stored: 60_000 });
    const neverScreensOn = on.every((r) => r.frames.every((f) => f.inputs.walletStatus !== 'ready' || f.view !== 'screens'));
    const endsLocked = on.every((r) => r.final === 'lock' && r.gate.startedLocked === true);
    // The first render that knows both the wallet and the stored choice is
    // the lock screen, whether or not the device has answered yet.
    const firstKnownIsLock = on.every((r) => {
      const f = r.frames.find((x) => x.inputs.walletStatus === 'ready' && x.inputs.prefsReady);
      return f?.view === 'lock';
    });
    const five = everyOrder(mod, { stored: 300_000 }).every((r) => r.final === 'lock');
    return { neverScreensOn, endsLocked, firstKnownIsLock, five };
  };
  const unlockedWhenOffHolds = (mod) => {
    const off = everyOrder(mod, { stored: null });
    const endsScreens = off.every((r) => r.final === 'screens');
    const neverLock = off.every((r) => r.frames.every((f) => f.view !== 'lock'));
    // Off: the screens show as soon as wallet and preferences are known,
    // without waiting for the device's answer.
    const noWaitForDevice = off.every((r) => {
      const f = r.frames.find((x) => x.inputs.walletStatus === 'ready' && x.inputs.prefsReady);
      return f?.view === 'screens';
    });
    return { endsScreens, neverLock, noWaitForDevice };
  };
  const all = (o) => Object.values(o).every(Boolean);

  {
    const d = lockMod.launchLockDecision;
    check('decision: still loading → pending', d({ ...base }) === 'pending');
    check('decision: no wallet (onboarding) → unlocked, whatever the stored choice',
      d({ ...base, walletStatus: 'no-wallet' }) === 'unlocked' && d({ ...base, walletStatus: 'no-wallet', prefsReady: true, autoLockMs: 60_000 }) === 'unlocked');
    check('decision: wallet loaded but preferences not read yet → pending (never a guess)', d({ ...base, walletStatus: 'ready' }) === 'pending');
    check('decision: auto-lock off → unlocked', d({ ...base, walletStatus: 'ready', prefsReady: true, autoLockMs: null, available: true }) === 'unlocked');
    check('decision: auto-lock 1 min / 5 min → locked, whatever the device has answered so far',
      [60_000, 300_000].every((ms) => [null, true, false].every((available) => d({ ...base, walletStatus: 'ready', prefsReady: true, autoLockMs: ms, available }) === 'locked')));
    const armed = lockMod.lockGateArmed;
    check('armed: fails closed while the device has not answered; disarmed when it says no biometrics',
      armed({ ...base, walletStatus: 'ready', prefsReady: true, autoLockMs: 60_000, available: null }) === true &&
        armed({ ...base, walletStatus: 'ready', prefsReady: true, autoLockMs: 60_000, available: false }) === false &&
        armed({ ...base, walletStatus: 'ready', prefsReady: true, autoLockMs: null, available: true }) === false &&
        armed({ ...base, walletStatus: 'no-wallet', prefsReady: true, autoLockMs: 60_000, available: true }) === false);
    check('INITIAL_LOCK_STATE (auto-lock off, and after a disarm) is still unlocked', INITIAL_LOCK_STATE.locked === false && INITIAL_LOCK_STATE.backgroundedAt === null);
  }

  {
    const onProps = lockOnLaunchHolds(lockMod);
    check('auto-lock on: no render shows the screens once the wallet is loaded, in all 6 arrival orders', onProps.neverScreensOn);
    check('auto-lock on: every launch ends on the lock screen with the launch sentence', onProps.endsLocked);
    check('auto-lock on: the first render that knows the wallet and the stored choice IS the lock screen (even before the device answers)', onProps.firstKnownIsLock);
    check('auto-lock 5 min: also starts locked (any duration)', onProps.five);
    const first = launch(lockMod, { stored: 60_000 }, []);
    // Everything known at the very first render (the fastest launch).
    let g = lockMod.reconcileLockGate(lockMod.INITIAL_LOCK_GATE_STATE, { walletStatus: 'ready', prefsReady: true, autoLockMs: 60_000, available: null });
    check('auto-lock on: with every input known at mount, the FIRST render is the lock screen',
      lockMod.lockGateView(g, { walletStatus: 'ready', prefsReady: true, autoLockMs: 60_000, available: null }) === 'lock' && g.lock.locked === true && first.frames[0].view === 'screens');
    const offProps = unlockedWhenOffHolds(lockMod);
    check('auto-lock off: every launch ends on the screens, unlocked, in all 6 arrival orders', offProps.endsScreens);
    check('auto-lock off: the lock screen never appears at launch', offProps.neverLock);
    check('auto-lock off: the screens show as soon as wallet and preferences are known (no wait for the device)', offProps.noWaitForDevice);
    check('while the stored choice is unknown, a loaded wallet sits under the neutral cover (not the screens, not the lock)',
      launch(lockMod, { stored: null }, ['wallet']).final === 'cover' && launch(lockMod, { stored: 60_000 }, ['wallet', 'device']).final === 'cover');
    check('no biometrics on the device: the gate stays inert (unlocked), as before',
      everyOrder(lockMod, { stored: 60_000, device: false }).every((r) => r.final === 'screens' && r.gate.lock.locked === false));
    const onboarding = launch(lockMod, { stored: 60_000, wallet: 'no-wallet' }, ['wallet', 'prefs', 'device']);
    let created = { ...onboarding.inputs, walletStatus: 'ready' };
    const afterCreate = lockMod.reconcileLockGate(onboarding.gate, created);
    check('onboarding is never covered, and a wallet created in this session is not locked at once (the user is present)',
      onboarding.frames.every((f) => f.view === 'screens') && lockMod.lockGateView(afterCreate, created) === 'screens');

    // After the launch lock: AppState events and the unlock.
    const on = launch(lockMod, { stored: 60_000 }, ['prefs', 'device', 'wallet']);
    g = on.gate;
    const inp = on.inputs;
    g = lockMod.applyLockGateEvent(g, at('app-state', 'active', 1_000), 60_000);
    g = lockMod.applyLockGateEvent(g, at('app-state', 'background', 2_000), 60_000);
    g = lockMod.applyLockGateEvent(g, at('app-state', 'active', 2_500), 60_000);
    check('the launch lock survives AppState changes (only the unlock lifts it)', lockMod.lockGateView(g, inp) === 'lock');
    check('the lock screen sentence at launch is the launch sentence', lockMod.lockScreenHint(g.startedLocked) === LAUNCH_HINT);
    g = lockMod.applyLockGateEvent(g, { type: 'unlock' }, 60_000);
    check('unlock → the screens, the launch flag cleared', lockMod.lockGateView(g, inp) === 'screens' && g.startedLocked === false && g.launched === true);
    check('…and reconciling again does not re-lock (the launch decision is taken once)', lockMod.reconcileLockGate(g, inp) === g);
    g = lockMod.applyLockGateEvent(g, at('app-state', 'background', 10_000), 60_000);
    g = lockMod.applyLockGateEvent(g, at('app-state', 'active', 70_000), 60_000);
    check('a later background lock still works, with the background sentence (unchanged)',
      lockMod.lockGateView(g, inp) === 'lock' && lockMod.lockScreenHint(g.startedLocked) === BACKGROUND_HINT);
    const disarmed = lockMod.reconcileLockGate(on.gate, { ...inp, available: false });
    check('a launch lock lifts if the device turns out unable to prompt (inert gate, as before)',
      lockMod.lockGateView(disarmed, { ...inp, available: false }) === 'screens' && disarmed.lock.locked === false);
    check('reconcile returns the same object when nothing changes (safe to call while rendering)',
      lockMod.reconcileLockGate(on.gate, inp) === on.gate);
  }

  // The unlock: one device check, no approval-target override.
  {
    const calls = [];
    const fake = (outcome) => async (...args) => {
      calls.push(args);
      return outcome;
    };
    const ok = await lockMod.attemptUnlock(fake({ ok: true, gated: true }));
    check('unlock: exactly ONE device check, titled "Unlock Shiba Wallet", with no target argument',
      ok.unlocked === true && calls.length === 1 && calls[0].length === 1 && calls[0][0] === 'Unlock Shiba Wallet' && lockMod.UNLOCK_PROMPT === 'Unlock Shiba Wallet', JSON.stringify(calls));
    const cancelled = await lockMod.attemptUnlock(fake({ ok: false, message: 'Authentication cancelled.' }));
    check('unlock: a cancel keeps the lock and shows the device check\'s message', cancelled.unlocked === false && cancelled.message === 'Authentication cancelled.');
    const ungated = await lockMod.attemptUnlock(fake({ ok: true, gated: false }));
    check('unlock: a pass without a prompt (biometrics vanished) still lifts the lock (unchanged)', ungated.unlocked === true);

    // With the real key vault behind it: the target WalletContext set for
    // the active account decides what the check opens. A watch-only or
    // multisig account (target none) opens NOTHING; a phrase account reads
    // the secure store (the comparison is meaningful).
    const { createKeyVault } = await import('../src/wallet/storage.ts');
    const { approvalTargetFor } = await import('../src/wallet/account-ids.ts');
    const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const countingBackend = () => {
      const items = new Map();
      const counts = { get: 0 };
      const key = (k, o) => `${o?.keychainService ?? 'default'}|${k}`;
      return {
        counts,
        whenUnlockedThisDeviceOnly: 5,
        async getItemAsync(k, o) { counts.get += 1; return items.has(key(k, o)) ? items.get(key(k, o)) : null; },
        async setItemAsync(k, v, o) { items.set(key(k, o), v); },
        async deleteItemAsync(k, o) { items.delete(key(k, o)); },
        canUseBiometricAuthentication: () => false,
      };
    };
    const unlockReads = async (mod, accountId) => {
      const backend = countingBackend();
      const vault = createKeyVault(backend, { policy: 'off' });
      await vault.saveNewPhrase(TEST_MNEMONIC);
      vault.setApprovalTarget(approvalTargetFor(accountId));
      backend.counts.get = 0;
      let deviceChecks = 0;
      // The first step of requireLocalAuth (wallet/biometric.ts): the vault
      // gate with the caller's arguments passed through unchanged.
      const auth = async (prompt, ...rest) => {
        deviceChecks += 1;
        await vault.openPhraseForApproval(prompt, ...rest);
        return { ok: true, gated: true };
      };
      const result = await mod.attemptUnlock(auth);
      return { unlocked: result.unlocked, reads: backend.counts.get, deviceChecks };
    };
    const WATCH = 0xc0000000;
    const MULTISIG = 0xd0000000;
    const w = await unlockReads(lockMod, WATCH);
    const m = await unlockReads(lockMod, MULTISIG);
    const p = await unlockReads(lockMod, 0);
    check('unlock while a watch-only account is active: ZERO secure-store reads (the phrase is not opened)', w.unlocked && w.reads === 0 && w.deviceChecks === 1, JSON.stringify(w));
    check('unlock while a multisig is active: ZERO secure-store reads', m.unlocked && m.reads === 0 && m.deviceChecks === 1, JSON.stringify(m));
    check('…while a phrase account\'s unlock reads the secure store (unchanged)', p.unlocked && p.reads >= 1 && p.deviceChecks === 1, JSON.stringify(p));

    const phraseOverride = await lockMutant('  const outcome = await auth(UNLOCK_PROMPT);', "  const outcome = await (auth as any)(UNLOCK_PROMPT, { kind: 'phrase' });");
    const mw = await unlockReads(phraseOverride, WATCH);
    check('mutant caught: an unlock that forces the phrase target opens the phrase for a watch-only account', mw.reads >= 1, JSON.stringify(mw));
    const twice = await lockMutant('  const outcome = await auth(UNLOCK_PROMPT);', '  await auth(UNLOCK_PROMPT);\n  const outcome = await auth(UNLOCK_PROMPT);');
    const tw = await unlockReads(twice, 0);
    check('mutant caught: an unlock that asks the device twice', tw.deviceChecks === 2);
  }

  // Mutants of the launch rule.
  {
    const DECISION = "  return inputs.autoLockMs !== null ? 'locked' : 'unlocked';";
    const startsUnlocked = await lockMutant(DECISION, "  return 'unlocked';");
    check('mutant caught: starting UNLOCKED with auto-lock on (the old behaviour)', !all(lockOnLaunchHolds(startsUnlocked)), JSON.stringify(lockOnLaunchHolds(startsUnlocked)));
    const alwaysLockedSrc = lockSource
      .replace(DECISION, "  return 'locked';")
      .replace('inputs.walletStatus === \'ready\' && inputs.autoLockMs !== null && inputs.available !== false', "inputs.walletStatus === 'ready' && inputs.available !== false");
    check('mutation anchors present (always-locked mutant)', alwaysLockedSrc !== lockSource && (alwaysLockedSrc.match(/return 'locked';/g) ?? []).length === 1);
    mutantCount += 1;
    const alwaysFile = joinPath(mutantDir, `lock-${mutantCount}.ts`);
    writeLockFs(alwaysFile, alwaysLockedSrc);
    const alwaysLocked = await import(pathToFileURL(alwaysFile).href);
    check('mutant caught: starting LOCKED with auto-lock off (lock whatever the setting)', !all(unlockedWhenOffHolds(alwaysLocked)), JSON.stringify(unlockedWhenOffHolds(alwaysLocked)));
    const stuckCover = await lockMutant(DECISION, "  return inputs.autoLockMs !== null ? 'locked' : 'pending';");
    check('mutant caught: a launch with auto-lock off that stays covered', !all(unlockedWhenOffHolds(stuckCover)));
    const noPrefsWait = await lockMutant("  if (!inputs.prefsReady) return 'pending';\n", '');
    check('mutant caught: deciding before the stored choice is read (the wallet-before-preferences race shows Home)',
      !all(lockOnLaunchHolds(noPrefsWait)), JSON.stringify(lockOnLaunchHolds(noPrefsWait)));
    const noCover = await lockMutant("  if (!state.launched) return inputs.walletStatus === 'ready' ? 'cover' : 'screens';", "  if (!state.launched) return 'screens';");
    check('mutant caught: no cover while the decision is pending (a frame of the screens)', !all(lockOnLaunchHolds(noCover)));
    const needsDevice = await lockMutant('inputs.available !== false;', 'inputs.available === true;');
    check('mutant caught: waiting for the device\'s answer before showing the lock (fails open meanwhile)', !all(lockOnLaunchHolds(needsDevice)));
    const sticky = await lockMutant('    return { launched: true, lock, startedLocked: false };', '    return { ...state, lock: LAUNCH_LOCKED_STATE };');
    const sg = sticky.applyLockGateEvent(launch(sticky, { stored: 60_000 }, ['wallet', 'prefs', 'device']).gate, { type: 'unlock' }, 60_000);
    check('mutant caught: an unlock that does not lift the launch lock', sticky.lockGateView(sg, { walletStatus: 'ready', prefsReady: true, autoLockMs: 60_000, available: true }) === 'lock');
  }
  rmSync(mutantDir, { recursive: true, force: true });

  // LockGate must apply exactly those functions, while rendering.
  {
    const gateSrc = readLockFs(new globalThis.URL('../src/components/LockGate.tsx', import.meta.url), 'utf8');
    const renderPin = (src) => {
      const reconcileAt = src.indexOf('  const reconciled = reconcileLockGate(gate, inputs);\n  if (reconciled !== gate) setGate(reconciled);\n');
      const firstEffectAfter = src.indexOf('useEffect(', reconcileAt);
      const lastEffectBefore = src.lastIndexOf('useEffect(', reconcileAt);
      const closeBefore = src.lastIndexOf('}, [autoLockMs]);', reconcileAt);
      return reconcileAt > 0 && firstEffectAfter > reconcileAt && closeBefore > lastEffectBefore &&
        src.includes('const inputs: LockGateInputs = { walletStatus: status, prefsReady, autoLockMs, available };') &&
        src.includes('const { autoLockMs, ready: prefsReady } = usePrefs();') &&
        src.includes('useState<boolean | null>(null);') &&
        src.includes('const view = lockGateView(reconciled, inputs);') &&
        src.includes("const locked = view !== 'screens';") &&
        src.includes('const lockValue = React.useMemo(() => ({ locked }), [locked]);') &&
        /\{locked \? \(\s*view === 'lock' \? \(\s*<View[^>]*>\s*<Text[^>]*>Shiba Wallet is locked<\/Text>\s*<Text[^>]*>\s*\{lockScreenHint\(reconciled\.startedLocked\)\}/.test(src) &&
        src.includes('applyLockGateEvent(prev, { type: \'app-state\', status: nextStatus, now: Date.now() }, autoLockMs)') &&
        src.includes("applyLockGateEvent(prev, { type: 'unlock' }, autoLockMs)") &&
        src.includes('const outcome = await attemptUnlock(requireLocalAuth);') &&
        !/requireLocalAuth\(/.test(src) &&
        !src.includes('INITIAL_LOCK_STATE');
    };
    check('LockGate: decides while rendering (not in an effect), from the wallet status, the stored preferences and the device answer', renderPin(gateSrc));
    const oldRule = gateSrc.replace("const locked = view !== 'screens';", 'const locked = armed && reconciled.lock.locked;');
    check('mutant caught: the old "locked = armed && lock.locked" rule (no cover, no hold before the decision)', oldRule !== gateSrc && !renderPin(oldRule));
    const inEffect = gateSrc.replace('  const reconciled = reconcileLockGate(gate, inputs);\n  if (reconciled !== gate) setGate(reconciled);\n',
      '  const reconciled = gate;\n  useEffect(() => {\n    setGate((g) => reconcileLockGate(g, inputs));\n  });\n');
    check('mutant caught: deciding in an effect (one committed frame of the screens first)', inEffect !== gateSrc && !renderPin(inEffect));
    const directPrompt = gateSrc.replace('const outcome = await attemptUnlock(requireLocalAuth);', "const outcome = await attemptUnlock((p) => requireLocalAuth(p, { kind: 'phrase' }));");
    check('mutant caught: the lock screen overriding the approval target', directPrompt !== gateSrc && !renderPin(directPrompt));
    const settingsSrc = readLockFs(new globalThis.URL('../src/screens/SettingsScreen.tsx', import.meta.url), 'utf8');
    check('Settings: the auto-lock hint says the wallet also starts locked while auto-lock is on',
      /While auto-lock is on,\s+the wallet also starts locked every time\s+it is opened afresh\s+\(after it was closed, swiped away or stopped\s+by the system\)\./.test(settingsSrc));
    // Pass p20b finding 1: the hint promised "your device passcode as the
    // system fallback", but while the approval target (the recovery phrase,
    // or the active imported key) is in biometric-protected storage the
    // unlock prompt is that item's own system prompt, which has no passcode
    // fallback (biometric.ts requireLocalAuth returns as soon as
    // openPhraseForApproval reports 'authenticated'); only the ordinary
    // prompt (standard storage, watch-only, multisig) offers the passcode.
    const autoLockHint = (src) => {
      const m = /<Text[^>]*>\s*(When the app has been in the background at least this long[\s\S]*?)<\/Text>/.exec(src);
      return m ? m[1].replace(/&apos;/g, "'").replace(/\s+/g, ' ').trim() : '';
    };
    const lockHintTrue = (src) => {
      const hint = autoLockHint(src);
      return hint.includes("locks behind the same biometric prompt as sending. While your recovery phrase (or the active account's imported key) is protected by biometrics, that prompt accepts only biometrics; otherwise your device passcode is offered as a fallback.") &&
        !hint.includes('system fallback');
    };
    check('Settings: the auto-lock hint says the passcode fallback exists only when the active secret is not biometric-protected', lockHintTrue(settingsSrc));
    const biometricSrc = readLockFs(new globalThis.URL('../src/wallet/biometric.ts', import.meta.url), 'utf8');
    check('…which is what requireLocalAuth does: an opened protected secret ends the gate before the ordinary prompt',
      /const vault = await openPhraseForApproval\(promptMessage, target\);\s+if \(vault\.kind === 'authenticated'\) return \{ ok: true, gated: true \};/.test(biometricSrc) &&
        biometricSrc.indexOf("vault.kind === 'authenticated'") < biometricSrc.indexOf('disableDeviceFallback: false'));
    const oldHint = settingsSrc.replace(/locks behind the same biometric prompt as sending\.[\s\S]*?offered as a fallback\./,
      'locks behind the same biometric prompt as sending (with your\n              device passcode as the system fallback).');
    check('mutant caught: the old "device passcode as the system fallback" hint', oldHint !== settingsSrc && !lockHintTrue(oldHint));
    // Phase 21 item 4: the control's title covers both a return from the
    // background and a fresh start (its hint above says both); the old
    // title named only the background case (retitled in 651ee5d).
    const autoLockTitleOk = (src) =>
      /<Text style=\{\[styles\.toggleLabel, \{ color: theme\.text \}\]\}>\s*Auto-lock\s*<\/Text>\s*<View style=\{styles\.endpointButtons\}>\s*\{AUTO_LOCK_CHOICES\.map/.test(src) &&
      !src.includes('Auto-lock after returning from background');
    check('Settings: the auto-lock control is titled "Auto-lock" (not "…after returning from background")', autoLockTitleOk(settingsSrc));
    const oldTitle = settingsSrc.replace(/(<Text style=\{\[styles\.toggleLabel, \{ color: theme\.text \}\]\}>\s*)Auto-lock(\s*<\/Text>\s*<View style=\{styles\.endpointButtons\}>)/, '$1Auto-lock after returning from background$2');
    check('mutant caught: the old background-only title', oldTitle !== settingsSrc && !autoLockTitleOk(oldTitle));
  }
}

// ---------------------------------------------------------------------------
// 2. Preference store + privacy mask (src/config/prefs.ts)
// ---------------------------------------------------------------------------

console.log('preferences:');

{
  const store = memoryStore();
  const initial = await loadPrefs(store);
  check(
    'empty store yields the defaults',
    JSON.stringify(initial) === JSON.stringify(DEFAULT_PREFS),
  );
  const saved = await savePrefs({ sepolia: true, hideAmounts: true, autoLockMs: 60_000 }, store);
  check('savePrefs returns the merged state', saved.sepolia && saved.hideAmounts && saved.autoLockMs === 60_000);
  const reloaded = await loadPrefs(store);
  check('round-trip persists all three prefs', reloaded.sepolia && reloaded.hideAmounts && reloaded.autoLockMs === 60_000);
  const patched = await savePrefs({ sepolia: false }, store);
  check('partial patch keeps the other prefs', !patched.sepolia && patched.hideAmounts && patched.autoLockMs === 60_000);
}
{
  const store = memoryStore();
  await store.setItem('shiba-wallet.prefs.v1', '{not json');
  const prefs = await loadPrefs(store);
  check('corrupt JSON falls back to defaults', JSON.stringify(prefs) === JSON.stringify(DEFAULT_PREFS));
}
{
  const store = memoryStore();
  await store.setItem(
    'shiba-wallet.prefs.v1',
    JSON.stringify({ sepolia: 'yes', hideAmounts: 1, autoLockMs: 12_345 }),
  );
  const prefs = await loadPrefs(store);
  check('wrong-typed fields are sanitized to defaults', !prefs.sepolia && !prefs.hideAmounts);
  check('an autoLockMs outside the choices is rejected', prefs.autoLockMs === null);
}
check('auto-lock choices are off / 1 min / 5 min', JSON.stringify(AUTO_LOCK_CHOICES.map((c) => c.ms)) === JSON.stringify([null, 60_000, 300_000]));
check("maskAmount hides as ••••", maskAmount('1.2345', true) === '••••');
check('maskAmount passes through when visible', maskAmount('1.2345', false) === '1.2345');

// ---------------------------------------------------------------------------
// 3. Active-chain profiles and pinned Sepolia constants
// ---------------------------------------------------------------------------

console.log('evm chain profiles:');

check('evmProfileFor(false) is mainnet', evmProfileFor(false) === EVM_MAINNET);
check('evmProfileFor(true) is Sepolia', evmProfileFor(true) === EVM_SEPOLIA);
check('mainnet caip2 / chain id', EVM_MAINNET.caip2 === 'eip155:1' && EVM_MAINNET.chainIdDecimal === '1');
check('mainnet caip2 equals send.ts EVM_CHAIN_ID', EVM_MAINNET.caip2 === EVM_CHAIN_ID);
check(
  'sepolia caip2 / chain id 11155111',
  EVM_SEPOLIA.caip2 === 'eip155:11155111' && EVM_SEPOLIA.chainIdDecimal === '11155111',
);
check('sepolia is flagged testnet, mainnet is not', EVM_SEPOLIA.testnet && !EVM_MAINNET.testnet);
check("sepolia amounts are labeled 'test ETH'", EVM_SEPOLIA.displaySymbol === 'test ETH');
check(
  'sepolia RPC is the verified publicnode endpoint',
  EVM_SEPOLIA.defaultRpcUrl === 'https://ethereum-sepolia-rpc.publicnode.com',
);
check(
  'mainnet default RPC matches DEFAULT_NETWORKS (no drift)',
  EVM_MAINNET.defaultRpcUrl === DEFAULT_NETWORKS.find((n) => n.chainId === 'eip155:1').defaultUrl,
);
check(
  'mainnet default RPC candidate list matches DEFAULT_NETWORKS (no drift)',
  EVM_MAINNET.defaultRpcUrls === DEFAULT_NETWORKS.find((n) => n.chainId === 'eip155:1').defaultUrls,
);
check('mainnet explorer base', EVM_MAINNET.explorerTxBase === 'https://etherscan.io/tx/');
check('sepolia explorer base', EVM_SEPOLIA.explorerTxBase === 'https://sepolia.etherscan.io/tx/');

// AA prefill: pinned values, checksummed exactly as the engine computes.
const prefill = EVM_SEPOLIA.aaPrefill;
const checksum = (addr) => toChecksumAddress(toBytes(addr.toLowerCase()));
check('mainnet has no AA prefill', EVM_MAINNET.aaPrefill === null);
check(
  'sepolia AA prefill factory equals the pinned verified address',
  prefill.factory === '0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985',
);
check('prefill factory is valid EIP-55', checksum(prefill.factory) === prefill.factory);
check(
  'sepolia AA prefill implementation equals the pinned verified address',
  prefill.implementation.toLowerCase() === '0x68641de71cfea5a5d0d29712449ee254bb1400c2',
);
check('prefill implementation is valid EIP-55', checksum(prefill.implementation) === prefill.implementation);
check("prefill entry point equals the engine's ENTRYPOINT_V07", prefill.entryPoint === ENTRYPOINT_V07);

// Slot resolution (the pure half of config/networks.ts).
{
  const mainnet = resolveActiveNetworks(false);
  const sepolia = resolveActiveNetworks(true);
  check('mainnet mode: EVM slot serves eip155:1', mainnet.find((e) => e.slot === 'eip155:1').network.chainId === 'eip155:1');
  const evmSlot = sepolia.find((e) => e.slot === 'eip155:1');
  check('sepolia mode: EVM slot serves eip155:11155111', evmSlot.network.chainId === 'eip155:11155111');
  check('sepolia slot id stays eip155:1 (accounts/routes unchanged)', evmSlot.slot === 'eip155:1');
  check('sepolia network default URL follows the profile', evmSlot.network.defaultUrl === EVM_SEPOLIA.defaultRpcUrl);
  check('sepolia network candidate list follows the profile', evmSlot.network.defaultUrls === EVM_SEPOLIA.defaultRpcUrls);
  check('SEPOLIA_NETWORK is derived from the profile', SEPOLIA_NETWORK.chainId === EVM_SEPOLIA.caip2 && SEPOLIA_NETWORK.symbol === EVM_SEPOLIA.displaySymbol);
  const untouched = ['bip122:000000000019d6689c085ae165831e93', 'bip122:1a91e3dace36e2be3bf030a65679fe82', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'];
  check(
    'non-EVM slots are identical in both modes',
    untouched.every(
      (id) =>
        mainnet.find((e) => e.slot === id).network === sepolia.find((e) => e.slot === id).network,
    ),
  );
}

// ---------------------------------------------------------------------------
// 4. Active-chain switching through the real send machinery (fake node)
// ---------------------------------------------------------------------------

console.log('send-flow chain switching (fake JSON-RPC node):');

const GWEI = 1000000000n;
const FROM = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const TO = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359';
const URL = 'http://offline.fake/rpc';

let scenario = { chainId: '0x1' };
let lastRawTx = null;
let oracleCalls = 0;

function rpcResult(method, params) {
  switch (method) {
    case 'eth_chainId':
      return scenario.chainId;
    case 'eth_getBalance':
      return '0x' + (10n ** 18n).toString(16); // 1 ETH
    case 'eth_getTransactionCount':
      return '0x5';
    case 'eth_getBlockByNumber':
      return { baseFeePerGas: '0x' + GWEI.toString(16) };
    case 'eth_maxPriorityFeePerGas':
      return '0x' + GWEI.toString(16);
    case 'eth_estimateGas':
      return '0x5208'; // 21000
    case 'eth_call':
      // The OP-stack GasPriceOracle predeploy (send.ts asks it on Base
      // Sepolia only): getL1Fee(bytes) 0x49948e0e → 1000 wei,
      // getOperatorFee(uint256) 0x275aedd2 → 0. scripts/check-base.mjs
      // covers the fee math in depth.
      if (params[0].to?.toLowerCase() === '0x420000000000000000000000000000000000000f') {
        oracleCalls += 1;
        return '0x' + (params[0].data.startsWith('0x49948e0e') ? 1000n : 0n).toString(16).padStart(64, '0');
      }
      return '0x';
    case 'eth_sendRawTransaction':
      lastRawTx = params[0];
      return '0x' + 'ab'.repeat(32);
    default:
      throw { code: -32601, message: `unexpected method ${method}` };
  }
}

globalThis.fetch = async (_url, init) => {
  const { method, params, id } = JSON.parse(init.body);
  let body;
  try {
    body = { jsonrpc: '2.0', id, result: rpcResult(method, params) };
  } catch (e) {
    body = { jsonrpc: '2.0', id, error: { code: e.code ?? -32000, message: e.message } };
  }
  return { ok: true, json: async () => body };
};

// Sepolia node (0xaa36a7 = 11155111)
scenario = { chainId: '0xaa36a7' };
const sepoliaQuote = await prepareEvmSend(URL, FROM, TO, 1000n, undefined, EVM_SEPOLIA.caip2);
check('sepolia-mode quote accepts a Sepolia node', sepoliaQuote.chainId === 11155111n);
await checkRejects(
  'mainnet-mode (default) quote refuses a Sepolia node',
  () => prepareEvmSend(URL, FROM, TO, 1000n),
  /chain id 11155111, expected 1/,
);

// Mainnet node (0x1)
scenario = { chainId: '0x1' };
const mainnetQuote = await prepareEvmSend(URL, FROM, TO, 1000n);
check('mainnet-mode quote accepts a mainnet node', mainnetQuote.chainId === 1n);
await checkRejects(
  'sepolia-mode quote refuses a mainnet node',
  () => prepareEvmSend(URL, FROM, TO, 1000n, undefined, EVM_SEPOLIA.caip2),
  /chain id 1, expected 11155111/,
);

// sendEvm explorer link follows the active profile.
const seed = mnemonicToSeed(
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
);
const signer = evmKeyProvider.deriveAccount(seed, 0, 0);
seed.fill(0);

scenario = { chainId: '0xaa36a7' };
{
  const sent = await sendEvm(URL, signer, sepoliaQuote, EVM_SEPOLIA.explorerTxBase);
  check(
    'sendEvm links to sepolia.etherscan.io in test mode',
    sent.explorerUrl === `https://sepolia.etherscan.io/tx/${sent.txid}`,
  );
  check('sendEvm broadcast a raw transaction', typeof lastRawTx === 'string' && lastRawTx.startsWith('0x02'));
}
scenario = { chainId: '0x1' };
{
  const sent = await sendEvm(URL, signer, mainnetQuote);
  check(
    'sendEvm default keeps the etherscan.io link',
    sent.explorerUrl === `https://etherscan.io/tx/${sent.txid}`,
  );
}

// Explorer helper override (Activity screen path).
const TXID = '0x' + 'cd'.repeat(32);
check('explorerTxUrl default stays etherscan.io', explorerTxUrl('eip155:1', TXID) === `https://etherscan.io/tx/${TXID}`);
check(
  'explorerTxUrl override goes to sepolia.etherscan.io',
  explorerTxUrl('eip155:1', TXID, EVM_SEPOLIA.explorerTxBase) === `https://sepolia.etherscan.io/tx/${TXID}`,
);
check('explorerTxUrl null override yields no link', explorerTxUrl('eip155:1', TXID, null) === null);
check(
  'explorerTxUrl leaves Bitcoin untouched',
  explorerTxUrl('bip122:000000000019d6689c085ae165831e93', TXID, EVM_SEPOLIA.explorerTxBase) ===
    `https://blockstream.info/tx/${TXID}`,
);

// ---------------------------------------------------------------------------
// 5. WalletConnect parameterization (namespace + routing follow the mode)
// ---------------------------------------------------------------------------

console.log('walletconnect chain parameterization:');

const WALLET = signer.address;

function signEvent(chainId, message = '0x68656c6c6f') {
  return {
    id: 1,
    topic: 'topic',
    params: { chainId, request: { method: 'personal_sign', params: [message, WALLET] } },
  };
}

{
  const parsed = parseWcRequest(signEvent('eip155:11155111'), WALLET, EVM_SEPOLIA.caip2);
  check('sepolia-mode accepts an eip155:11155111 request', parsed.kind === 'personal_sign');
}
{
  let error = null;
  try {
    parseWcRequest(signEvent('eip155:11155111'), WALLET);
  } catch (e) {
    error = e;
  }
  check(
    'mainnet-mode declines an eip155:11155111 request with UNSUPPORTED_CHAINS',
    error instanceof WcRequestRejection && error.code === WC_ERRORS.unsupportedChains.code,
  );
}
{
  let error = null;
  try {
    parseWcRequest(signEvent('eip155:1'), WALLET, EVM_SEPOLIA.caip2);
  } catch (e) {
    error = e;
  }
  check(
    'sepolia-mode declines an eip155:1 request with UNSUPPORTED_CHAINS',
    error instanceof WcRequestRejection && error.code === WC_ERRORS.unsupportedChains.code,
  );
}

{
  // Namespace construction against the real @walletconnect/utils builder.
  const proposalParams = {
    id: 7,
    requiredNamespaces: {
      eip155: {
        chains: ['eip155:11155111'],
        methods: ['personal_sign', 'eth_sendTransaction'],
        events: ['accountsChanged', 'chainChanged'],
      },
    },
    optionalNamespaces: {},
  };
  const namespaces = buildWalletNamespaces(proposalParams, WALLET, [EVM_SEPOLIA.caip2]);
  const accounts = namespaces.eip155?.accounts ?? [];
  check(
    'approved namespace carries eip155:11155111 accounts',
    JSON.stringify(accounts) === JSON.stringify([`eip155:11155111:${WALLET}`]),
  );
  let mainnetBuildFailed = false;
  try {
    buildWalletNamespaces(proposalParams, WALLET); // mainnet-only wallet
  } catch {
    mainnetBuildFailed = true;
  }
  check('mainnet-mode cannot approve a sepolia-only proposal', mainnetBuildFailed);

  const summary = describeProposal({ id: 7, params: proposalParams }, [EVM_SEPOLIA.caip2]);
  check('describeProposal (sepolia mode) finds nothing unsupported', summary.unsupportedRequired.length === 0);
  const summaryMainnet = describeProposal({ id: 7, params: proposalParams });
  check(
    'describeProposal (mainnet mode) flags eip155:11155111 as unsupported',
    JSON.stringify(summaryMainnet.unsupportedRequired) === JSON.stringify(['eip155:11155111']),
  );
}

{
  // Typed-data domain chain policy follows the active chain.
  const typedData = JSON.stringify({
    types: { Mail: [{ name: 'contents', type: 'string' }] },
    primaryType: 'Mail',
    domain: { name: 'App', chainId: 11155111 },
    message: { contents: 'hi' },
  });
  const parsed = parseTypedDataV4(typedData, EVM_SEPOLIA.caip2);
  check('typed data for chain 11155111 signs in sepolia mode', parsed.digest.length === 32 && parsed.domain.chainId === 11155111n);
  let refused = false;
  try {
    parseTypedDataV4(typedData);
  } catch {
    refused = true;
  }
  check('typed data for chain 11155111 is refused in mainnet mode', refused);
}

// ---------------------------------------------------------------------------
// 6. AA prefill: verify-before-save under the Sepolia key, no mode mixing
// ---------------------------------------------------------------------------

console.log('aa prefill (sepolia key, verified before save):');

{
  const store = memoryStore();
  const impl = prefill.implementation;
  const sel = (signature) => toHex(encodeFunctionCall(signature, []));
  const pad32 = (address) => '0x' + '0'.repeat(24) + address.slice(2).toLowerCase();
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();

  // Fake Sepolia node transport implementing exactly the verifyAaFactory
  // reads (eth_getCode + accountImplementation() + entryPoint()).
  const fakeNode = async (method, params) => {
    if (method === 'eth_getCode') {
      const [address] = params;
      if (same(address, prefill.factory)) return '0x6001';
      if (same(address, impl)) return '0x6002';
      return '0x';
    }
    if (method === 'eth_call') {
      const [{ to, data }] = params;
      if (same(to, prefill.factory) && data === sel('accountImplementation()')) return pad32(impl);
      if (same(to, impl) && data === sel('entryPoint()')) return pad32(ENTRYPOINT_V07);
      throw new Error(`unexpected eth_call to ${to} data ${data}`);
    }
    throw new Error(`unexpected method ${method}`);
  };

  const verification = await setAaFactory(
    EVM_SEPOLIA.caip2,
    prefill.factory,
    'https://offline.fake/sepolia',
    { store, transportFor: () => fakeNode },
  );
  check(
    'saving the prefill re-runs verification and reports the pinned implementation',
    verification.implementation === impl,
  );
  const sepoliaConfig = await getAaConfig(EVM_SEPOLIA.caip2, store);
  check('factory persisted under the sepolia key', sepoliaConfig.factory === prefill.factory);
  check('implementation recorded from the chain, not asserted', sepoliaConfig.factoryImplementation === impl);
  const mainnetConfig = await getAaConfig('eip155:1', store);
  check('mainnet AA config stays untouched (no mode mixing)', mainnetConfig.factory === null && mainnetConfig.bundlerUrl === null);
}

// ---------------------------------------------------------------------------
// Endpoint URL rule (src/config/endpoint-url.ts): https:// only, plain
// http:// only for loopback development hosts; the RPC override setter
// applies it before storing anything.
// ---------------------------------------------------------------------------
console.log('\nendpoint URL rule (https only, loopback http for development):');
{
  check(
    'refusal sentence is the documented one',
    INSECURE_ENDPOINT_MESSAGE ===
      'Endpoints must use https:// (plain http:// is accepted only for localhost or 10.0.2.2 during development).',
  );
  check(
    'loopback list is exactly localhost, 127.0.0.1, ::1, 10.0.2.2',
    JSON.stringify(LOOPBACK_HOSTS) === JSON.stringify(['localhost', '127.0.0.1', '::1', '10.0.2.2']),
  );
  const accepted = [
    [' https://rpc.example/v2/KEY/ ', 'https://rpc.example/v2/KEY'],
    ['HTTPS://rpc.example', 'https://rpc.example'],
    ['https://rpc.example:8443/path?x=1', 'https://rpc.example:8443/path?x=1'],
    ['http://localhost:8545', 'http://localhost:8545'],
    ['http://LOCALHOST:8545/', 'http://LOCALHOST:8545'],
    ['http://127.0.0.1:8545', 'http://127.0.0.1:8545'],
    ['http://[::1]:8545', 'http://[::1]:8545'],
    ['http://10.0.2.2:8545', 'http://10.0.2.2:8545'],
    ['http://user:pass@localhost:8545', 'http://user:pass@localhost:8545'],
  ];
  for (const [input, expected] of accepted) {
    let got;
    try {
      got = assertSecureEndpointUrl(input);
    } catch (e) {
      got = `threw: ${e.message}`;
    }
    check(`accepted: ${JSON.stringify(input)}`, got === expected, String(got));
  }
  const refusedHttp = [
    'http://rpc.example',
    'http://192.168.1.20:8545',
    'http://10.0.2.3:8545',
    'http://127.0.0.2:8545',
    'http://localhost.example.com',
    'http://localhost@rpc.example',
    'http://[::2]:8545',
    'ftp://rpc.example',
    'ws://localhost:8545',
    'rpc.example',
    'not-a-url',
    '',
  ];
  for (const input of refusedHttp) {
    let message = null;
    try {
      assertSecureEndpointUrl(input);
    } catch (e) {
      message = e.message;
    }
    check(`refused with the https sentence: ${JSON.stringify(input)}`, message === INSECURE_ENDPOINT_MESSAGE, String(message));
  }
  const refusedMalformed = ['https://', 'https:///path', 'https://rpc.example:99999', 'https://rpc .example', 'https://[::1'];
  for (const input of refusedMalformed) {
    let message = null;
    try {
      assertSecureEndpointUrl(input);
    } catch (e) {
      message = e.message;
    }
    check(
      `malformed https URL refused with its own message: ${JSON.stringify(input)}`,
      message !== null && message !== INSECURE_ENDPOINT_MESSAGE,
      String(message),
    );
  }

  // setEndpointOverride (config/networks.ts) stores nothing for an http URL.
  const store = memoryStore();
  let message = null;
  try {
    await setEndpointOverride('eip155:1', 'http://rpc.example', { store });
  } catch (e) {
    message = e.message;
  }
  check('RPC override: plain http:// refused with the https sentence', message === INSECURE_ENDPOINT_MESSAGE, String(message));
  check('RPC override: nothing stored after the refusal', (await store.getItem('shiba-wallet.rpc-endpoints.v1')) === null);
  await setEndpointOverride('eip155:1', 'https://rpc.example/', { store });
  await setEndpointOverride('bip122:000000000019d6689c085ae165831e93', 'http://10.0.2.2:3002/api', { store });
  const stored = JSON.parse((await store.getItem('shiba-wallet.rpc-endpoints.v1')) ?? '{}');
  check(
    'RPC override: https saved normalized, loopback http (10.0.2.2) saved',
    stored['eip155:1'] === 'https://rpc.example' &&
      stored['bip122:000000000019d6689c085ae165831e93'] === 'http://10.0.2.2:3002/api',
    JSON.stringify(stored),
  );
}

// ---------------------------------------------------------------------------
// Load-time https rule for RPC overrides (phase 10 item 5): an override
// stored before setEndpointOverride refused plain http:// is NOT used — the
// chain resolves to its verified defaults as if no override existed — the
// reason is reported on the endpoint for Settings, the stored value stays
// until "Reset to default", and nothing is ever requested from it.
// ---------------------------------------------------------------------------
console.log('\n== RPC override load-time https rule ==');
{
  const realFetch = globalThis.fetch;
  const seen = [];
  // Answers the default-candidate probe (eth_chainId 0x1, Esplora genesis,
  // Solana genesis) for any URL, recording every request.
  globalThis.fetch = async (url, init) => {
    seen.push(String(url));
    const body = init?.body ? JSON.parse(init.body) : null;
    const result = body?.method === 'eth_chainId' ? '0x1' : body?.method === 'getGenesisHash' ? '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' : null;
    if (body) return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result }), text: async () => '' };
    return { ok: true, status: 200, json: async () => ({}), text: async () => '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f' };
  };
  try {
    const store = memoryStore();
    const legacy = JSON.stringify({ 'eip155:1': 'http://rpc.example' });
    await store.setItem('shiba-wallet.rpc-endpoints.v1', legacy);
    const mainnetDefaults = DEFAULT_NETWORKS.find((n) => n.chainId === 'eip155:1').defaultUrls;
    const ep = await getEndpoint('eip155:1', { store });
    check(
      'stored plain http:// override is not used: the chain resolves to a verified default',
      ep?.isOverride === false && mainnetDefaults.includes(ep?.url),
      JSON.stringify({ url: ep?.url, isOverride: ep?.isOverride }),
    );
    check('the refusal reason reaches the endpoint for Settings', ep?.ignoredReason === INSECURE_ENDPOINT_MESSAGE, String(ep?.ignoredReason));
    check('nothing was requested from the ignored URL', !seen.some((u) => u.startsWith('http://rpc.example')), seen.join(', '));
    check('the stored value is left in storage', (await store.getItem('shiba-wallet.rpc-endpoints.v1')) === legacy);
    const all = await getAllEndpoints({ store });
    check(
      'getAllEndpoints: only the affected chain carries the reason',
      all.filter((e) => e.ignoredReason !== undefined).map((e) => e.network.chainId).join(',') === 'eip155:1',
    );
    await resetEndpoint('eip155:1', { store });
    const reset = await getEndpoint('eip155:1', { store });
    check('Reset to default removes the ignored value and its reason', reset?.ignoredReason === undefined && JSON.parse((await store.getItem('shiba-wallet.rpc-endpoints.v1')) ?? '{}')['eip155:1'] === undefined);

    await store.setItem('shiba-wallet.rpc-endpoints.v1', JSON.stringify({ 'eip155:1': 'http://10.0.2.2:8545', 'bip122:000000000019d6689c085ae165831e93': 'https://esplora.example/api/' }));
    const loop = await getEndpoint('eip155:1', { store });
    check('stored loopback http://10.0.2.2 override is still used', loop?.isOverride === true && loop?.url === 'http://10.0.2.2:8545' && loop?.ignoredReason === undefined);
    const btc = await getEndpoint('bip122:000000000019d6689c085ae165831e93', { store });
    check('stored https override is used exactly as stored', btc?.isOverride === true && btc?.url === 'https://esplora.example/api/' && btc?.ignoredReason === undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ---------------------------------------------------------------------------
// Phase 10 item 3: the second test profile (Base Sepolia, eip155:84532), the
// Developer test-network choice and its migration from the old boolean, and
// mode isolation between the two test networks across every per-chain store
// (endpoints, send chain-id checks, WalletConnect, AA, indexer, contacts).
// ---------------------------------------------------------------------------
console.log('\n== Base Sepolia profile and the test-network choice ==');
{
  const B = EVM_BASE_SEPOLIA;
  check('Base Sepolia: CAIP-2 eip155:84532, chain id 84532', B.caip2 === 'eip155:84532' && B.chainIdDecimal === '84532');
  check('Base Sepolia: label, testnet flag, test ETH', B.label === 'Base Sepolia' && B.testnet === true && B.displaySymbol === 'test ETH');
  check('Base Sepolia: explorer sepolia.basescan.org/tx/', B.explorerTxBase === 'https://sepolia.basescan.org/tx/');
  check(
    'Base Sepolia: the three verified keyless RPC candidates, publicnode first',
    JSON.stringify(B.defaultRpcUrls) === JSON.stringify([
      'https://base-sepolia-rpc.publicnode.com',
      'https://sepolia.base.org',
      'https://base-sepolia-testnet.api.pocket.network',
    ]) && B.defaultRpcUrl === B.defaultRpcUrls[0],
  );
  check('Base Sepolia: the transaction-submission-only sequencer URL is not a candidate', !B.defaultRpcUrls.some((u) => u.includes('sequencer')));
  check('Base Sepolia: no SimpleAccount pre-fill (not verified there); Kernel v3.3 verified', B.aaPrefill === null && B.kernelV33Verified === true);
  check('Base Sepolia: flagged as paying an L1 data fee (OP-stack); Ethereum profiles are not', B.l1DataFee === true && !EVM_SEPOLIA.l1DataFee && !EVM_MAINNET.l1DataFee);
  check('Base Sepolia: banner and mode wording name Base Sepolia', B.bannerText?.includes('Base Sepolia') && B.modeLabel === 'Base Sepolia test mode');
  check('mainnet has no banner; Sepolia keeps its wording', EVM_MAINNET.bannerText === null && EVM_SEPOLIA.modeLabel === 'Sepolia test mode');
  check('test profiles listed Sepolia, Base Sepolia, Arbitrum Sepolia, Hoodi, OP Sepolia', EVM_TEST_PROFILES.map((p) => p.caip2).join() === 'eip155:11155111,eip155:84532,eip155:421614,eip155:560048,eip155:11155420');
  check('EVM_PROFILES = mainnet + test profiles', EVM_PROFILES.length === 1 + EVM_TEST_PROFILES.length && EVM_PROFILES[0] === EVM_MAINNET);
  check('evmProfileFor(Base Sepolia id) / (Sepolia id) / null', evmProfileFor('eip155:84532') === B && evmProfileFor('eip155:11155111') === EVM_SEPOLIA && evmProfileFor(null) === EVM_MAINNET);
  check('evmProfileFor: an unknown id stays on a test network (Sepolia), never mainnet', evmProfileFor('eip155:999') === EVM_SEPOLIA);
  check('evmProfileByCaip2 finds all three and nothing else', evmProfileByCaip2('eip155:84532') === B && evmProfileByCaip2('eip155:1') === EVM_MAINNET && evmProfileByCaip2('eip155:8453') === undefined);
  check('isTestProfileId', isTestProfileId('eip155:84532') && isTestProfileId('eip155:11155111') && !isTestProfileId('eip155:1') && !isTestProfileId(null));

  // Network entries.
  check('BASE_SEPOLIA_NETWORK is derived from the profile', BASE_SEPOLIA_NETWORK.chainId === B.caip2 && BASE_SEPOLIA_NETWORK.defaultUrls === B.defaultRpcUrls && BASE_SEPOLIA_NETWORK.symbol === B.displaySymbol && BASE_SEPOLIA_NETWORK.kind === 'evm-jsonrpc' && BASE_SEPOLIA_NETWORK.decimals === 18);
  check('networkDefaultFor knows both test networks', networkDefaultFor('eip155:84532') === BASE_SEPOLIA_NETWORK && networkDefaultFor('eip155:11155111') === SEPOLIA_NETWORK);
  const baseMode = resolveActiveNetworks('eip155:84532');
  const mainnetMode = resolveActiveNetworks(null);
  const evmSlot = baseMode.find((e) => e.slot === 'eip155:1');
  check('Base Sepolia mode: the EVM slot (id stays eip155:1) serves eip155:84532', evmSlot.network === BASE_SEPOLIA_NETWORK);
  check('Base Sepolia mode: Bitcoin, Dogecoin (Blockbook) and Solana are unchanged', baseMode.filter((e) => e.slot !== 'eip155:1').every((e) => e.network === mainnetMode.find((m) => m.slot === e.slot).network));
  check('resolveActiveNetworks(true) is still Sepolia (legacy callers)', resolveActiveNetworks(true).find((e) => e.slot === 'eip155:1').network === SEPOLIA_NETWORK);
}

console.log('\n== preference migration: the old boolean and the new choice ==');
{
  check('default: mainnet (testNetwork null, sepolia false)', DEFAULT_PREFS.testNetwork === null && DEFAULT_PREFS.sepolia === false);
  const legacy = async (raw) => {
    const store = memoryStore();
    await store.setItem('shiba-wallet.prefs.v1', JSON.stringify(raw));
    return loadPrefs(store);
  };
  let p = await legacy({ sepolia: true, hideAmounts: true, autoLockMs: null, showFiat: true });
  check('old install with sepolia:true and no testNetwork reads as Sepolia', p.testNetwork === 'eip155:11155111' && p.sepolia === true && p.hideAmounts === true);
  p = await legacy({ sepolia: false });
  check('old install with sepolia:false reads as mainnet', p.testNetwork === null && p.sepolia === false);
  p = await legacy({ testNetwork: 'eip155:84532', sepolia: true });
  check('stored Base Sepolia choice reads back', p.testNetwork === 'eip155:84532' && p.sepolia === true);
  p = await legacy({ testNetwork: 'eip155:84532', sepolia: false });
  check('the choice wins over a contradicting boolean (sepolia re-derived)', p.testNetwork === 'eip155:84532' && p.sepolia === true);
  p = await legacy({ testNetwork: null, sepolia: true });
  check('an explicit null choice means mainnet', p.testNetwork === null && p.sepolia === false);
  p = await legacy({ testNetwork: 'eip155:999', sepolia: true });
  check('an unknown stored id with sepolia:true stays in test mode (Sepolia)', p.testNetwork === 'eip155:11155111' && p.sepolia === true);
  p = await legacy({ testNetwork: 'eip155:1' });
  check('a stored mainnet id is not a test network: mainnet', p.testNetwork === null && p.sepolia === false);

  const store = memoryStore();
  let s = await savePrefs({ testNetwork: 'eip155:84532' }, store);
  check('choosing Base Sepolia sets the flag', s.testNetwork === 'eip155:84532' && s.sepolia === true);
  check('…and persists both fields', JSON.parse(await store.getItem('shiba-wallet.prefs.v1')).testNetwork === 'eip155:84532');
  s = await savePrefs({ sepolia: true }, store);
  check('the old setter (sepolia:true) keeps the chosen Base Sepolia', s.testNetwork === 'eip155:84532');
  s = await savePrefs({ sepolia: false }, store);
  check('the old setter (sepolia:false) returns to mainnet', s.testNetwork === null && s.sepolia === false);
  s = await savePrefs({ sepolia: true }, store);
  check('the old setter (sepolia:true) from mainnet picks Sepolia', s.testNetwork === 'eip155:11155111');
  s = await savePrefs({ testNetwork: 'eip155:84532', sepolia: false }, store);
  check('a patch with both fields: the choice wins', s.testNetwork === 'eip155:84532' && s.sepolia === true);
  s = await savePrefs({ testNetwork: null }, store);
  check('choosing Off returns to mainnet', s.testNetwork === null && s.sepolia === false);
  s = await savePrefs({ hideAmounts: false }, store);
  check('an unrelated patch keeps the choice', s.testNetwork === null);
}

console.log('\n== endpoints follow the choice; overrides never cross test networks ==');
{
  const prior = globalThis.fetch;
  const requested = [];
  // Every URL containing "base" answers as Base Sepolia, everything else as
  // Ethereum Sepolia; nothing leaves the process.
  globalThis.fetch = async (url, init) => {
    requested.push(String(url));
    const body = JSON.parse(init.body);
    const result = body.method === 'eth_chainId' ? (String(url).includes('base') ? '0x14a34' : '0xaa36a7') : null;
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result }), text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) };
  };
  try {
    const store = memoryStore();
    await savePrefs({ testNetwork: 'eip155:84532' }, store);
    const ep = await getEndpoint('eip155:1', { store });
    check('Base Sepolia mode: the Ethereum slot resolves to eip155:84532', ep?.forChainId === 'eip155:1' && ep?.network.chainId === 'eip155:84532');
    check('…through the first default candidate (chain id verified)', ep?.url === 'https://base-sepolia-rpc.publicnode.com' && ep?.isOverride === false && ep?.defaultChoice?.healthy === true);
    check('…and asking for eip155:84532 directly works too', (await getEndpoint('eip155:84532', { store }))?.network.chainId === 'eip155:84532');
    check('…while Ethereum Sepolia is NOT reachable in Base Sepolia mode', (await getEndpoint('eip155:11155111', { store })) === undefined);

    await setEndpointOverride('eip155:11155111', 'https://sepolia-override.example', { store });
    const noLeak = await getEndpoint('eip155:1', { store });
    check('a Sepolia override does not apply in Base Sepolia mode', noLeak?.isOverride === false && noLeak?.url === 'https://base-sepolia-rpc.publicnode.com');
    await setEndpointOverride('eip155:84532', 'https://base-override.example', { store });
    const own = await getEndpoint('eip155:1', { store });
    check('a Base Sepolia override applies in Base Sepolia mode', own?.isOverride === true && own?.url === 'https://base-override.example');
    await savePrefs({ testNetwork: 'eip155:11155111' }, store);
    const sep = await getEndpoint('eip155:1', { store });
    check('switching to Sepolia uses the Sepolia override, not the Base one', sep?.network.chainId === 'eip155:11155111' && sep?.url === 'https://sepolia-override.example');
    await savePrefs({ testNetwork: null }, store);
    const main = await getEndpoint('eip155:1', { store });
    check('Off: mainnet ignores both test overrides', main?.network.chainId === 'eip155:1' && main?.isOverride === false);
    const all = await getAllEndpoints({ store });
    check('getAllEndpoints in mainnet mode lists no test network', !all.some((e) => e.network.testnet || e.network.chainId === 'eip155:84532' || e.network.chainId === 'eip155:11155111'));
    check('no request reached an override URL while it was not active', !requested.some((u) => u.includes('override.example')));
  } finally {
    globalThis.fetch = prior;
  }
}

console.log('\n== send-flow chain-id checks between the two test networks ==');
{
  scenario = { chainId: '0x14a34' };
  oracleCalls = 0;
  const baseQuote = await prepareEvmSend(URL, FROM, TO, 1000n, undefined, EVM_BASE_SEPOLIA.caip2);
  check('Base Sepolia-mode quote accepts a Base Sepolia node', baseQuote.chainId === 84532n);
  check(
    'Base Sepolia-mode quote asks the GasPriceOracle and adds the L1 data fee reserve (1000 + 50%)',
    oracleCalls === 2 && baseQuote.opStack?.l1DataFee === 1500n && baseQuote.fee === 21000n * 3n * GWEI + 1500n,
  );
  scenario = { chainId: '0xaa36a7' };
  oracleCalls = 0;
  const sepNoOracle = await prepareEvmSend(URL, FROM, TO, 1000n, undefined, EVM_SEPOLIA.caip2);
  check('Sepolia-mode quote makes no oracle call and has no L1 data fee', oracleCalls === 0 && sepNoOracle.opStack === undefined && sepNoOracle.fee === 21000n * 3n * GWEI);
  scenario = { chainId: '0x14a34' };
  await checkRejects('Sepolia-mode quote refuses a Base Sepolia node', () => prepareEvmSend(URL, FROM, TO, 1000n, undefined, EVM_SEPOLIA.caip2), /chain id 84532, expected 11155111/);
  await checkRejects('mainnet-mode quote refuses a Base Sepolia node', () => prepareEvmSend(URL, FROM, TO, 1000n), /chain id 84532, expected 1\b/);
  scenario = { chainId: '0xaa36a7' };
  await checkRejects('Base Sepolia-mode quote refuses a Sepolia node', () => prepareEvmSend(URL, FROM, TO, 1000n, undefined, EVM_BASE_SEPOLIA.caip2), /chain id 11155111, expected 84532/);
  scenario = { chainId: '0x14a34' };
  const sent = await sendEvm(URL, signer, baseQuote, EVM_BASE_SEPOLIA.explorerTxBase);
  check('sendEvm on Base Sepolia links to sepolia.basescan.org', sent.explorerUrl === `https://sepolia.basescan.org/tx/${sent.txid}`);
  check('explorerTxUrl override goes to sepolia.basescan.org', explorerTxUrl('eip155:1', TXID, EVM_BASE_SEPOLIA.explorerTxBase) === `https://sepolia.basescan.org/tx/${TXID}`);
  scenario = { chainId: '0x1' };
}

console.log('\n== WalletConnect follows the Base Sepolia profile ==');
{
  const BASE = EVM_BASE_SEPOLIA.caip2;
  check('Base Sepolia mode accepts an eip155:84532 request', parseWcRequest(signEvent(BASE), WALLET, BASE).kind === 'personal_sign');
  const declined = (event, active) => {
    try {
      parseWcRequest(event, WALLET, active);
      return false;
    } catch (e) {
      return e instanceof WcRequestRejection && e.code === WC_ERRORS.unsupportedChains.code;
    }
  };
  check('Sepolia mode declines an eip155:84532 request (UNSUPPORTED_CHAINS)', declined(signEvent(BASE), EVM_SEPOLIA.caip2));
  check('Base Sepolia mode declines an eip155:11155111 request', declined(signEvent('eip155:11155111'), BASE));
  check('Base Sepolia mode declines an eip155:1 request', declined(signEvent('eip155:1'), BASE));
  const proposal = {
    id: 9,
    requiredNamespaces: {},
    optionalNamespaces: { eip155: { chains: ['eip155:1', 'eip155:11155111', BASE, 'eip155:8453'], methods: ['personal_sign'], events: ['chainChanged'] } },
  };
  const ns = buildWalletNamespaces(proposal, WALLET, [BASE]);
  check('approved namespace carries ONLY eip155:84532 accounts in Base Sepolia mode', JSON.stringify(ns.eip155?.accounts) === JSON.stringify([`${BASE}:${WALLET}`]) && JSON.stringify(ns.eip155?.chains) === JSON.stringify([BASE]));
  check('describeChain names Base Sepolia; Sepolia wording unchanged', describeChain(BASE) === 'Base Sepolia (test network)' && describeChain('eip155:11155111') === 'Ethereum Sepolia (test network)' && describeChain('eip155:8453') === 'eip155:8453');
  check(
    'mode-mismatch sentence for a Base Sepolia dApp in Sepolia mode',
    modeMismatchMessage(BASE, 'eip155:11155111', 'connect') ===
      'This dApp asked for Base Sepolia (test network); the wallet is in Sepolia test mode. Turn on Base Sepolia test mode in Settings → Developer to connect.',
  );
  check(
    'mode-mismatch sentence for a Sepolia dApp is unchanged',
    modeMismatchMessage('eip155:11155111', 'eip155:1', 'connect') ===
      'This dApp asked for Ethereum Sepolia (test network); the wallet is in mainnet mode. Turn on Sepolia test mode in Settings → Developer to connect.',
  );
  const typed = JSON.stringify({ types: { Mail: [{ name: 'contents', type: 'string' }] }, primaryType: 'Mail', domain: { name: 'App', chainId: 84532 }, message: { contents: 'hi' } });
  check('typed data for chain 84532 signs in Base Sepolia mode', parseTypedDataV4(typed, BASE).domain.chainId === 84532n);
  let refused = false;
  try {
    parseTypedDataV4(typed, EVM_SEPOLIA.caip2);
  } catch {
    refused = true;
  }
  check('typed data for chain 84532 is refused in Sepolia mode', refused);
}

console.log('\n== per-chain stores keyed by CAIP-2: AA, history indexer, contacts ==');
{
  const BASE = EVM_BASE_SEPOLIA.caip2;
  const store = memoryStore();
  // A SimpleAccount save under the Sepolia key leaves Base Sepolia empty.
  const sel = (signature) => toHex(encodeFunctionCall(signature, []));
  const pad32 = (address) => '0x' + '0'.repeat(24) + address.slice(2).toLowerCase();
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  const fakeSimpleNode = (chainIdHex) => async (method, params) => {
    if (method === 'eth_chainId') return chainIdHex;
    if (method === 'eth_getCode') return same(params[0], prefill.factory) || same(params[0], prefill.implementation) ? '0x6001' : '0x';
    if (method === 'eth_call') {
      const [{ to, data }] = params;
      if (same(to, prefill.factory) && data === sel('accountImplementation()')) return pad32(prefill.implementation);
      if (same(to, prefill.implementation) && data === sel('entryPoint()')) return pad32(ENTRYPOINT_V07);
    }
    throw new Error(`unexpected ${method}`);
  };
  await setAaFactory(EVM_SEPOLIA.caip2, prefill.factory, 'https://offline.fake/sepolia', { store, transportFor: () => fakeSimpleNode('0xaa36a7') });
  const baseAa = await getAaConfig(BASE, store);
  check('AA: a Sepolia save leaves the Base Sepolia config empty', baseAa.chain === BASE && baseAa.factory === null && baseAa.bundlerUrl === null && baseAa.factoryVerifiedAt === null);

  // History indexer: verify-before-save checks eth_chainId against the key.
  const indexerStore = memoryStore();
  await checkRejects(
    'indexer: a Sepolia endpoint is refused for the Base Sepolia key',
    () => setIndexerUrl(BASE, 'https://indexer.example', WALLET, { store: indexerStore, transportFor: () => async (m) => (m === 'eth_chainId' ? '0xaa36a7' : null) }),
    /chain id 11155111, expected 84532/,
  );
  await checkRejects(
    'indexer: a Base Sepolia endpoint is refused for the Sepolia key',
    () => setIndexerUrl(EVM_SEPOLIA.caip2, 'https://indexer.example', WALLET, { store: indexerStore, transportFor: () => async (m) => (m === 'eth_chainId' ? '0x14a34' : null) }),
    /chain id 84532, expected 11155111/,
  );
  check('indexer: nothing persisted by the refusals', (await getIndexerConfig(BASE, indexerStore)).url === null && (await getIndexerConfig(EVM_SEPOLIA.caip2, indexerStore)).url === null);
  check('NFT indexer: Base Sepolia starts unconfigured', (await getNftIndexerConfig(BASE, memoryStore())).url === null);

  // Contacts: Base Sepolia is a contact network of its own.
  const contactStore = memoryStore();
  check('contacts: eip155:84532 is a contact network', CONTACT_NETWORK_IDS.includes(BASE));
  check('contacts: EVM addresses validate on Base Sepolia (EIP-55 stored)', validateContactAddress(BASE, '0x000000000000000000000000000000000000dead').ok === true);
  await addContact(BASE, 'Burn', '0x000000000000000000000000000000000000dEaD', { store: contactStore });
  check('contacts: saved under Base Sepolia only', (await listContacts(BASE, contactStore)).length === 1 && (await listContacts(EVM_SEPOLIA.caip2, contactStore)).length === 0 && (await listContacts('eip155:1', contactStore)).length === 0);
  check('contacts: Base mainnet (8453) is still not a contact network', validateContactAddress('eip155:8453', '0x000000000000000000000000000000000000dead').ok === false);

  // Blockbook (Dogecoin) is not affected and still refuses plain overrides.
  await checkRejects('Blockbook chains still refuse a plain RPC override', () => setEndpointOverride('bip122:1a91e3dace36e2be3bf030a65679fe82', 'https://doge.example', { store: memoryStore() }), /Blockbook/);
}

// D1 (phase 11 item 6): text on filled controls meets WCAG 2.2 SC 1.4.3
// "Contrast (Minimum)", 4.5:1 for normal-size text (button labels are 16 px
// semibold, not large text), computed from the exact theme values.
console.log('theme contrast (D1):');
{
  check('luminance helper: white = 1, black = 0', relativeLuminance('#ffffff') === 1 && relativeLuminance('#000000') === 0);
  check('ratio helper: black on white = 21:1', Math.abs(contrastRatio('#000000', '#ffffff') - 21) < 1e-9);
  const before = contrastRatio('#ffffff', '#f0942f');
  check('the finding reproduced: white on the old dark-mode primary was about 2.3:1', before > 2.2 && before < 2.4, before.toFixed(2));
  const pairs = [
    ['dark primary button label (onAccent on accent)', darkTheme.onAccent, darkTheme.accent],
    ['dark selected chip / type button (same primary fill)', darkTheme.onAccent, darkTheme.accent],
    ['dark destructive button label (onDanger on danger)', darkTheme.onDanger, darkTheme.danger],
    ['dark "test networks only" chip and TESTNET badge', darkTheme.onTestnetFill, darkTheme.testnetFill],
    ['dark secondary button label (accent on background)', darkTheme.accent, darkTheme.background],
    ['dark secondary button label (accent on card)', darkTheme.accent, darkTheme.card],
  ];
  for (const [name, fg, bg] of pairs) {
    const ratio = contrastRatio(fg, bg);
    check(`${name} >= 4.5:1`, ratio >= 4.5, `${fg} on ${bg}: ${ratio.toFixed(2)}:1`);
  }
  check('dark accent kept (only the text on it changed)', darkTheme.accent === '#f0942f');
  check('dark palette kept as phase 11 left it (TESTNET fill and danger unchanged)',
    darkTheme.testnetFill === '#e07800' && darkTheme.danger === '#ef5350' && darkTheme.onTestnetFill === '#101216');
}

// Phase 12 item 4: light mode to WCAG 2.2 SC 1.4.3 as well. White text
// stays on the fills; the two oranges are darkened (hue kept, HSL lightness
// lowered) so that both white text ON them and orange text on the light
// background and cards reach 4.5:1.
console.log('theme contrast (light mode, phase 12 item 4):');
{
  const hue = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b);
    const d = max - Math.min(r, g, b);
    if (d === 0) return 0;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  };
  const oldAccent = contrastRatio('#ffffff', '#d97a1a');
  const oldTestnet = contrastRatio('#ffffff', '#e07800');
  check('the finding reproduced: white on the old light accent #d97a1a was about 3.1:1', oldAccent > 3.0 && oldAccent < 3.2, oldAccent.toFixed(2));
  check('the finding reproduced: white on the old TESTNET orange #e07800 was about 3.1:1', oldTestnet > 3.0 && oldTestnet < 3.1, oldTestnet.toFixed(2));
  const pairs = [
    ['light primary button / selected chip label (onAccent on accent)', lightTheme.onAccent, lightTheme.accent],
    ['light accent text on background (links, secondary buttons)', lightTheme.accent, lightTheme.background],
    ['light accent text on card (links inside cards)', lightTheme.accent, lightTheme.card],
    ['light TESTNET badge (onTestnetFill on testnetFill)', lightTheme.onTestnetFill, lightTheme.testnetFill],
    ['light TESTNET orange text on background (network lines)', lightTheme.testnetFill, lightTheme.background],
    ['light TESTNET orange text on card', lightTheme.testnetFill, lightTheme.card],
    ['light destructive button label (onDanger on danger)', lightTheme.onDanger, lightTheme.danger],
    ['light Mainnet badge (danger on dangerSurface)', lightTheme.danger, lightTheme.dangerSurface],
    ['light warning text on warningSurface', lightTheme.warningText, lightTheme.warningSurface],
    ['light muted text on background', lightTheme.textMuted, lightTheme.background],
    ['light success text on background', lightTheme.success, lightTheme.background],
  ];
  for (const [name, fg, bg] of pairs) {
    const ratio = contrastRatio(fg, bg);
    check(`${name} >= 4.5:1`, ratio >= 4.5, `${fg} on ${bg}: ${ratio.toFixed(2)}:1`);
  }
  check('light oranges keep their hue (accent ~30°, TESTNET ~32°, within 1°)',
    Math.abs(hue(lightTheme.accent) - hue('#d97a1a')) < 1 && Math.abs(hue(lightTheme.testnetFill) - hue('#e07800')) < 1,
    `${hue(lightTheme.accent).toFixed(1)}° / ${hue(lightTheme.testnetFill).toFixed(1)}°`);
  check('light oranges are darker than before (relative luminance lower)',
    relativeLuminance(lightTheme.accent) < relativeLuminance('#d97a1a') && relativeLuminance(lightTheme.testnetFill) < relativeLuminance('#e07800'));
  check('light fills still carry white text', lightTheme.onAccent === '#ffffff' && lightTheme.onTestnetFill === '#ffffff' && lightTheme.onDanger === '#ffffff');
}

// The TESTNET badges and network lines take their colours from the theme
// (no hard-coded orange or white) in the screens this check owns. Swap,
// Sessions and the WalletConnect sheet are tracked separately.
console.log('theme tokens in screens (phase 12 item 4):');
{
  const { readFileSync } = await import('node:fs');
  const files = [
    '../src/screens/PasskeyScreen.tsx',
    '../src/screens/UpgradeAccountScreen.tsx',
    '../src/components/RecoveryViews.tsx',
    '../src/screens/GuardiansScreen.tsx',
    '../src/screens/RecoverAccountScreen.tsx',
    '../src/screens/ApproveRecoveryScreen.tsx',
    '../src/screens/OwnerRotationScreen.tsx',
    '../src/screens/NftsScreen.tsx',
    '../src/screens/ActivityScreen.tsx',
    '../src/screens/ApprovalsScreen.tsx',
  ];
  for (const f of files) {
    const src = readFileSync(new globalThis.URL(f, import.meta.url), 'utf8');
    check(`${f.split('/').pop()}: no hard-coded TESTNET orange`, !/#e07800|#a85a00/i.test(src));
  }
  // Phase 12 rehearsal finding 6: the app-wide TESTNET banner in App.tsx was
  // still white on #e07800 (2.3:1 in dark mode).
  {
    const app = readFileSync(new globalThis.URL('../App.tsx', import.meta.url), 'utf8');
    const banner = app.slice(app.indexOf('function TestnetBanner'), app.indexOf('function Root'));
    check('App.tsx TESTNET banner: no hard-coded orange or white anywhere in the file',
      !/#e07800|#a85a00/i.test(app) && !/'#ffffff'|'#fff'|'white'/i.test(app));
    check('App.tsx TESTNET banner: background theme.testnetFill, text theme.onTestnetFill',
      /backgroundColor: theme\.testnetFill/.test(banner) && /color: theme\.onTestnetFill/.test(banner) && /const theme = useTheme\(\);/.test(banner));
  }
  for (const f of ['../src/screens/PasskeyScreen.tsx', '../src/screens/UpgradeAccountScreen.tsx', '../src/components/RecoveryViews.tsx']) {
    const src = readFileSync(new globalThis.URL(f, import.meta.url), 'utf8');
    check(`${f.split('/').pop()}: TESTNET badge uses testnetFill / onTestnetFill`,
      /backgroundColor: theme\.testnetFill, borderColor: theme\.testnetFill/.test(src) && /color: theme\.onTestnetFill/.test(src));
  }
}


// Phase 14 item 3: the third test profile, Arbitrum Sepolia (eip155:421614),
// an Arbitrum Nitro rollup whose layer-1 cost is folded into gas (not an
// OP-stack chain), and the rule that nothing assumes a number of test
// networks.
console.log('\n== Arbitrum Sepolia profile (third test network) ==');
{
  const A = EVM_ARBITRUM_SEPOLIA;
  check('Arbitrum Sepolia: CAIP-2 eip155:421614, chain id 421614', A.caip2 === 'eip155:421614' && A.chainIdDecimal === '421614');
  check('Arbitrum Sepolia: label, testnet flag, test ETH, Arbiscan', A.label === 'Arbitrum Sepolia' && A.testnet === true && A.displaySymbol === 'test ETH' && A.explorerTxBase === 'https://sepolia.arbiscan.io/tx/');
  check('Arbitrum Sepolia: the three verified keyless RPC candidates, publicnode first',
    A.defaultRpcUrls.join() === 'https://arbitrum-sepolia-rpc.publicnode.com,https://sepolia-rollup.arbitrum.io/rpc,https://arb-sepolia-testnet.api.pocket.network' &&
      A.defaultRpcUrl === A.defaultRpcUrls[0] && A.defaultRpcUrls.every((u) => u.startsWith('https://')));
  check('Arbitrum Sepolia: the send-only sequencer URL is not a candidate', !A.defaultRpcUrls.some((u) => u.includes('sequencer')));
  check('Arbitrum Sepolia: NOT an OP-stack chain (no L1-data-fee oracle path); L1 cost is in the gas', A.l1DataFee === false && A.l1CostInGas === true &&
    !EVM_BASE_SEPOLIA.l1CostInGas && !EVM_SEPOLIA.l1CostInGas && !EVM_MAINNET.l1CostInGas);
  check('Arbitrum Sepolia: Kernel v3.3 verified, no SimpleAccount pre-fill, no swaps', A.kernelV33Verified === true && A.aaPrefill === null && A.swapsOffered === false);
  check('Arbitrum Sepolia: banner and mode wording', A.bannerText === 'TESTNET — Arbitrum Sepolia test mode is on. Amounts are test ETH, not real funds.' && A.modeLabel === 'Arbitrum Sepolia test mode');
  check('Arbitrum Sepolia: listed third; evmProfileFor / evmProfileByCaip2 / isTestProfileId know it; Arbitrum One does not exist here',
    EVM_TEST_PROFILES[2] === A && evmProfileFor('eip155:421614') === A && evmProfileByCaip2('eip155:421614') === A && isTestProfileId('eip155:421614') &&
      evmProfileByCaip2('eip155:42161') === undefined && !isTestProfileId('eip155:42161'));
  const row = networkDefaultFor('eip155:421614');
  check('its network row is derived from the profile (no hand-written list to forget)', row?.chainId === A.caip2 && row.defaultUrls === A.defaultRpcUrls && row.symbol === 'test ETH' && row.kind === 'evm-jsonrpc' &&
    row.note === 'Arbitrum Sepolia test network — balances and sends here are test ETH, not real funds.');
  check('TEST_EVM_NETWORKS follows EVM_TEST_PROFILES one to one; the older rows are unchanged',
    TEST_EVM_NETWORKS.map((n) => n.chainId).join() === EVM_TEST_PROFILES.map((p) => p.caip2).join() && TEST_EVM_NETWORKS[0] === SEPOLIA_NETWORK && TEST_EVM_NETWORKS[1] === BASE_SEPOLIA_NETWORK);
  const arbMode = resolveActiveNetworks('eip155:421614');
  check('Arbitrum Sepolia mode: the EVM slot (eip155:1) serves eip155:421614; other chains unchanged',
    arbMode.find((e) => e.slot === 'eip155:1')?.network === row && arbMode.filter((e) => e.slot !== 'eip155:1').every((e) => e.network === resolveActiveNetworks(null).find((m) => m.slot === e.slot).network));
  const store = memoryStore();
  let p = await savePrefs({ testNetwork: 'eip155:421614' }, store);
  check('choosing Arbitrum Sepolia persists and sets the test flag', p.testNetwork === 'eip155:421614' && p.sepolia === true && JSON.parse(await store.getItem('shiba-wallet.prefs.v1')).testNetwork === 'eip155:421614');
  p = await loadPrefs(store);
  check('…and reads back', p.testNetwork === 'eip155:421614');
  check('the Settings note for Arbitrum says the L1 cost is inside the gas estimate and names the swap limit',
    l1CostInGasNote(A) === 'Arbitrum Sepolia is a layer-2 network that charges for publishing its data on Ethereum as extra gas, not as a separate fee: the network’s own gas estimate already includes it, so the max network fee on the confirm screen covers the whole cost, and Max leaves exactly that. The estimate can move with Ethereum’s fees; if it rises before the transaction is included, the network refuses it and nothing is charged. Swaps are not offered here (0x does not support Arbitrum Sepolia).');

  // The EOA quote and Max on Arbitrum: gas × max fee from eth_estimateGas (which includes the L1 part), no oracle call.
  scenario = { chainId: '0x66eee' };
  oracleCalls = 0;
  const q = await prepareEvmSend(URL, FROM, TO, 1000n, undefined, A.caip2);
  check('Arbitrum Sepolia-mode quote accepts an Arbitrum Sepolia node', q.chainId === 421614n);
  check('…makes NO GasPriceOracle call and adds no L1 data fee: fee = estimated gas × max fee', oracleCalls === 0 && q.opStack === undefined && q.fee === 21000n * 3n * GWEI);
  const max = await maxEvmSend(URL, FROM, TO);
  check('Max (chain from the node) = balance − estimated gas × max fee, no oracle call', max === 10n ** 18n - 21000n * 3n * GWEI && oracleCalls === 0, `${max}`);
  await checkRejects('Arbitrum Sepolia-mode quote refuses a Base Sepolia node', async () => {
    scenario = { chainId: '0x14a34' };
    return prepareEvmSend(URL, FROM, TO, 1000n, undefined, A.caip2);
  }, /chain id 84532, expected 421614/);
  scenario = { chainId: '0x66eee' };
  await checkRejects('Base Sepolia-mode quote refuses an Arbitrum Sepolia node', () => prepareEvmSend(URL, FROM, TO, 1000n, undefined, EVM_BASE_SEPOLIA.caip2), /chain id 421614, expected 84532/);
  const sent = await sendEvm(URL, signer, q, A.explorerTxBase);
  check('sendEvm on Arbitrum Sepolia links to sepolia.arbiscan.io', sent.explorerUrl === `https://sepolia.arbiscan.io/tx/${sent.txid}`);
  scenario = { chainId: '0x1' };

  // WalletConnect names it from the profile table.
  check('WalletConnect: describeChain names Arbitrum Sepolia; requests for it are accepted only in its mode',
    describeChain('eip155:421614') === 'Arbitrum Sepolia (test network)' &&
      parseWcRequest(signEvent('eip155:421614'), WALLET, 'eip155:421614').kind === 'personal_sign' &&
      (() => { try { parseWcRequest(signEvent('eip155:421614'), WALLET, EVM_BASE_SEPOLIA.caip2); return false; } catch (e) { return e instanceof WcRequestRejection; } })());
  check('WalletConnect: mode-mismatch sentence for an Arbitrum Sepolia dApp in mainnet mode',
    modeMismatchMessage('eip155:421614', 'eip155:1', 'connect') ===
      'This dApp asked for Arbitrum Sepolia (test network); the wallet is in mainnet mode. Turn on Arbitrum Sepolia test mode in Settings → Developer to connect.',
    modeMismatchMessage('eip155:421614', 'eip155:1', 'connect'));

  // No source in the owned files assumes how many test networks exist.
  const { readFileSync: readFs } = await import('node:fs');
  const read = (rel) => readFs(new globalThis.URL(rel, import.meta.url), 'utf8');
  const settings = read('../src/screens/SettingsScreen.tsx');
  check('Settings → Developer text is built from the profiles (no hand-written network list)',
    settings.includes('{DEVELOPER_TEST_NETWORK_HINT}') && !settings.includes('Sepolia (chain id 11155111) or Base Sepolia') && !settings.includes('between\n          the two test networks'));
  check('readiness hints are built from the profiles', !read('../src/config/readiness.ts').includes("'Turn on a test network (Ethereum Sepolia or Base Sepolia)"));
}

// Phase 18 item 1: the fourth and fifth test profiles, Hoodi (eip155:560048,
// a layer 1 network with NO Kernel v3.3 deployment) and OP Sepolia
// (eip155:11155420, OP-stack, Kernel verified on-chain), and the testnet
// smoke scripts' offline refusals for the chains where they cannot run.
console.log('\n== Hoodi and OP Sepolia profiles (phase 18) ==');
{
  const H = EVM_HOODI;
  const O = EVM_OP_SEPOLIA;
  check('Hoodi: CAIP-2 eip155:560048, chain id 560048, label, test ETH', H.caip2 === 'eip155:560048' && H.chainIdDecimal === '560048' && H.label === 'Hoodi' && H.testnet === true && H.displaySymbol === 'test ETH');
  check('Hoodi: the verified keyless RPC candidates in order (publicnode, ethPandaOps, 0xRPC)',
    H.defaultRpcUrls.join() === 'https://ethereum-hoodi-rpc.publicnode.com,https://rpc.hoodi.ethpandaops.io,https://0xrpc.io/hoodi' &&
      H.defaultRpcUrl === H.defaultRpcUrls[0] && H.defaultRpcUrls.every((u) => u.startsWith('https://')));
  check('Hoodi: the rejected 1RPC endpoint is not a candidate', !H.defaultRpcUrls.some((u) => u.includes('1rpc.io')));
  check('Hoodi: explorer hoodi.etherscan.io/tx/', H.explorerTxBase === 'https://hoodi.etherscan.io/tx/');
  check('Hoodi: NO Kernel v3.3 (kernelV33Verified false), no SimpleAccount pre-fill, no swaps', H.kernelV33Verified === false && H.aaPrefill === null && H.swapsOffered === false);
  check('Hoodi: a layer 1 network (no L1 data fee, no L1 cost in gas)', H.l1DataFee === false && H.l1CostInGas === false);
  check('Hoodi: banner and mode wording', H.bannerText === 'TESTNET — Hoodi test mode is on. Amounts are test ETH, not real funds.' && H.modeLabel === 'Hoodi test mode');
  check('OP Sepolia: CAIP-2 eip155:11155420, chain id 11155420, label, test ETH', O.caip2 === 'eip155:11155420' && O.chainIdDecimal === '11155420' && O.label === 'OP Sepolia' && O.testnet === true && O.displaySymbol === 'test ETH');
  check('OP Sepolia: the verified keyless RPC candidates in order (publicnode, sepolia.optimism.io, Pocket)',
    O.defaultRpcUrls.join() === 'https://optimism-sepolia-rpc.publicnode.com,https://sepolia.optimism.io,https://op-sepolia-testnet.api.pocket.network' &&
      O.defaultRpcUrl === O.defaultRpcUrls[0]);
  check('OP Sepolia: the rejected dRPC and BlockReq endpoints are not candidates', !O.defaultRpcUrls.some((u) => u.includes('drpc.org') || u.includes('blockreq')));
  check('OP Sepolia: explorer sepolia-optimism.etherscan.io/tx/ (the registry’s EIP-3091 explorer)', O.explorerTxBase === 'https://sepolia-optimism.etherscan.io/tx/');
  check('OP Sepolia: OP-stack (L1 data fee, not L1 cost in gas)', O.l1DataFee === true && O.l1CostInGas === false);
  check('OP Sepolia: Kernel v3.3 verified, no SimpleAccount pre-fill, no swaps', O.kernelV33Verified === true && O.aaPrefill === null && O.swapsOffered === false);
  check('OP Sepolia: banner and mode wording', O.bannerText === 'TESTNET — OP Sepolia test mode is on. Amounts are test ETH, not real funds.' && O.modeLabel === 'OP Sepolia test mode');
  check('both listed after Arbitrum Sepolia (Hoodi fourth, OP Sepolia fifth); evmProfileFor / evmProfileByCaip2 / isTestProfileId know them',
    EVM_TEST_PROFILES[3] === H && EVM_TEST_PROFILES[4] === O &&
      evmProfileFor('eip155:560048') === H && evmProfileFor('eip155:11155420') === O &&
      evmProfileByCaip2('eip155:560048') === H && evmProfileByCaip2('eip155:11155420') === O &&
      isTestProfileId('eip155:560048') && isTestProfileId('eip155:11155420') &&
      evmProfileByCaip2('eip155:10') === undefined && !isTestProfileId('eip155:10') && !isTestProfileId('eip155:17000'));
  for (const P of [H, O]) {
    const row = networkDefaultFor(P.caip2);
    check(`${P.label}: its network row is derived from the profile`, row?.chainId === P.caip2 && row.defaultUrls === P.defaultRpcUrls && row.symbol === 'test ETH' &&
      row.kind === 'evm-jsonrpc' && row.decimals === 18 && row.note === `${P.label} test network — balances and sends here are test ETH, not real funds.`);
    const mode = resolveActiveNetworks(P.caip2);
    check(`${P.label} mode: the EVM slot (eip155:1) serves ${P.caip2}; other chains unchanged`,
      mode.find((e) => e.slot === 'eip155:1')?.network === row && mode.filter((e) => e.slot !== 'eip155:1').every((e) => e.network === resolveActiveNetworks(null).find((m) => m.slot === e.slot).network));
    const store = memoryStore();
    let p = await savePrefs({ testNetwork: P.caip2 }, store);
    check(`choosing ${P.label} persists (prefs.testNetwork accepts it) and sets the test flag`, p.testNetwork === P.caip2 && p.sepolia === true && JSON.parse(await store.getItem('shiba-wallet.prefs.v1')).testNetwork === P.caip2);
    p = await loadPrefs(store);
    check(`…and reads back as ${P.label}`, p.testNetwork === P.caip2 && evmProfileFor(p.testNetwork) === P);
  }
  check('TEST_EVM_NETWORKS still follows EVM_TEST_PROFILES one to one', TEST_EVM_NETWORKS.map((n) => n.chainId).join() === EVM_TEST_PROFILES.map((p) => p.caip2).join());

  // Send flow: Hoodi has no oracle; OP Sepolia asks it (check-base.mjs pins the math).
  scenario = { chainId: '0x88bb0' };
  oracleCalls = 0;
  const hq = await prepareEvmSend(URL, FROM, TO, 1000n, undefined, H.caip2);
  check('Hoodi-mode quote: chain 560048, no oracle call, fee = gas × max fee', hq.chainId === 560048n && oracleCalls === 0 && hq.opStack === undefined && hq.fee === 21000n * 3n * GWEI);
  await checkRejects('Hoodi-mode quote refuses a Sepolia node', async () => {
    scenario = { chainId: '0xaa36a7' };
    return prepareEvmSend(URL, FROM, TO, 1000n, undefined, H.caip2);
  }, /chain id 11155111, expected 560048 \(Hoodi\)/);
  scenario = { chainId: '0xaa37dc' };
  oracleCalls = 0;
  const oq = await prepareEvmSend(URL, FROM, TO, 1000n, undefined, O.caip2);
  check('OP Sepolia-mode quote: chain 11155420, asks the GasPriceOracle, adds the reserve (1000 + 50%)',
    oq.chainId === 11155420n && oracleCalls === 2 && oq.opStack?.l1DataFee === 1500n && oq.fee === 21000n * 3n * GWEI + 1500n);
  await checkRejects('OP Sepolia-mode quote refuses a Base Sepolia node', async () => {
    scenario = { chainId: '0x14a34' };
    return prepareEvmSend(URL, FROM, TO, 1000n, undefined, O.caip2);
  }, /chain id 84532, expected 11155420 \(OP Sepolia\)/);
  scenario = { chainId: '0x1' };

  // WalletConnect names both from the profile table.
  check('WalletConnect: describeChain and the mode-mismatch sentence for both',
    describeChain('eip155:560048') === 'Hoodi (test network)' && describeChain('eip155:11155420') === 'OP Sepolia (test network)' &&
      modeMismatchMessage('eip155:560048', 'eip155:1', 'connect') ===
        'This dApp asked for Hoodi (test network); the wallet is in mainnet mode. Turn on Hoodi test mode in Settings → Developer to connect.' &&
      modeMismatchMessage('eip155:11155420', 'eip155:84532', 'use this connection') ===
        'This dApp asked for OP Sepolia (test network); the wallet is in Base Sepolia test mode. Turn on OP Sepolia test mode in Settings → Developer to use this connection.');
  check('WalletConnect: requests for Hoodi / OP Sepolia are accepted only in their own mode',
    parseWcRequest(signEvent('eip155:560048'), WALLET, 'eip155:560048').kind === 'personal_sign' &&
      parseWcRequest(signEvent('eip155:11155420'), WALLET, 'eip155:11155420').kind === 'personal_sign' &&
      (() => { try { parseWcRequest(signEvent('eip155:11155420'), WALLET, 'eip155:560048'); return false; } catch (e) { return e instanceof WcRequestRejection; } })());

  // The Kernel pre-fill and the multisig link follow kernelV33Verified.
  const { aaKernelPrefillFor, KERNEL_PREFILL } = await import('../src/wallet/aa.ts');
  const { upgradeActionsOffered } = await import('../src/wallet/delegation.ts');
  check('Kernel pre-fill: none on Hoodi, the pinned factory on OP Sepolia', aaKernelPrefillFor('eip155:560048') === null && aaKernelPrefillFor('eip155:11155420') === KERNEL_PREFILL.factory);
  check('Multisig link: hidden on Hoodi (no verified Kernel), offered on OP Sepolia', !multisigNetworkVerified(H) && multisigNetworkVerified(O));
  check('EIP-7702 upgrade: not offered on Hoodi before or after the delegate read finds no code; offered on OP Sepolia',
    !upgradeActionsOffered({ kernelV33Verified: H.kernelV33Verified, delegateDeployed: undefined }) &&
      !upgradeActionsOffered({ kernelV33Verified: H.kernelV33Verified, delegateDeployed: false }) &&
      upgradeActionsOffered({ kernelV33Verified: O.kernelV33Verified, delegateDeployed: undefined }));

  // The testnet smoke scripts refuse Hoodi (and token-gas refuses OP Sepolia) before any network request.
  const { spawnSync } = await import('node:child_process');
  const repo = new globalThis.URL('../../', import.meta.url).pathname;
  const run = (script, env) => spawnSync(process.execPath, [`scripts/testnet/${script}`], {
    cwd: repo, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60_000, // inherits the CI offline guard
  });
  const ks = run('kernel-smoke.mjs', { CHAIN_ID: '560048', KERNEL_SMOKE_DRY_RUN: '1' });
  check('kernel-smoke: CHAIN_ID=560048 (dry run) refuses plainly, exit 2, before any request',
    ks.status === 2 && ks.stderr.trim() ===
      'Kernel v3.3 is not deployed on Hoodi: the KernelFactory 0x2577507b78c2008Ff367261CB6285d44ba5eF2E9 and the Kernel implementation ' +
        '0xd6CEDDe84be40893d153Be9d467CD6aD37875b28 have no code there (read 2026-10-11 UTC; app/src/config/evm-chain.ts EVM_HOODI), so no ' +
        'Kernel account can be deployed and this smoke cannot run on chain 560048. Nothing was read, signed or sent.' && ks.stdout === '',
    `${ks.status} ${ks.stderr}`);
  const tgH = run('token-gas-smoke.mjs', { CHAIN_ID: '560048' });
  const tgO = run('token-gas-smoke.mjs', { CHAIN_ID: '11155420' });
  check('token-gas-smoke: Hoodi and OP Sepolia refused plainly, exit 2, before any request',
    tgH.status === 2 && tgH.stderr.startsWith('Hoodi: Kernel v3.3 is not deployed there') && tgH.stderr.includes('Nothing was read, signed or sent.') &&
      tgO.status === 2 && tgO.stderr.startsWith('OP Sepolia: Circle documents its EntryPoint v0.7 paymaster for Arbitrum Sepolia and Base Sepolia only') &&
      tgO.stderr.includes('Nothing was read, signed or sent.'),
    `${tgH.status} ${tgH.stderr} | ${tgO.status} ${tgO.stderr}`);
  const { readFileSync: readSrc } = await import('node:fs');
  const ksSrc = readSrc(new globalThis.URL('../../scripts/testnet/kernel-smoke.mjs', import.meta.url), 'utf8');
  const fundSrc = readSrc(new globalThis.URL('../../scripts/testnet/fund.mjs', import.meta.url), 'utf8');
  check('kernel-smoke CHAINS: OP Sepolia uses the profile’s first candidate; fund.mjs allows both test chains',
    ksSrc.includes(`'11155420': { name: 'OP Sepolia', rpc: '${O.defaultRpcUrls[0]}' }`) && ksSrc.includes(`rpc: '${H.defaultRpcUrls[0]}'`) &&
      fundSrc.includes('const ALLOWED_TEST_CHAINS = [11155111n, 84532n, 421614n, 560048n, 11155420n];'));
}

// ---------------------------------------------------------------------------
// Phase 14 emulator pass: the lock screen hides the screens from screen
// readers (finding 6), and copy built from the profile table (finding 7).
// ---------------------------------------------------------------------------
{
  const { readFileSync: readFs } = await import('node:fs');
  const read = (rel) => readFs(new globalThis.URL(rel, import.meta.url), 'utf8');
  console.log('\n# lock screen accessibility (LockGate.tsx, source)');
  // The screens must sit inside ONE always-rendered wrapper whose two
  // documented props hide it while locked: importantForAccessibility
  // "no-hide-descendants" (Android) and accessibilityElementsHidden (iOS).
  // Always rendered, so locking never remounts the screens. Since the
  // in-app browser live pass (a full uiautomator dump, which includes views
  // that are not important for accessibility, still listed the browser bar
  // and the web view's nodes under the lock), the wrapper is ALSO
  // display: 'none' while locked: native INVISIBLE on Android, hidden on
  // iOS, so nothing under the lock is reported at all.
  const lockHidesScreens = (src) =>
    /<View\s+style=\{locked \? styles\.hiddenWhileLocked : styles\.fill\}\s+importantForAccessibility=\{locked \? 'no-hide-descendants' : 'auto'\}\s+accessibilityElementsHidden=\{locked\}\s*>\s*\{children\}\s*<\/View>/.test(src) &&
    /hiddenWhileLocked: \{\s*flex: 1,\s*display: 'none',\s*\}/.test(src) &&
    (src.match(/\{children\}/g) ?? []).length === 1 &&
    !/locked \?\s*\(?\s*<View[^>]*>\s*\{children\}/.test(src);
  const lockSrc = read('../src/components/LockGate.tsx');
  check('LockGate: the screens are hidden from accessibility while locked, on Android and iOS, without unmounting', lockHidesScreens(lockSrc));
  const noAndroid = lockSrc.replace("importantForAccessibility={locked ? 'no-hide-descendants' : 'auto'}", '');
  const noIos = lockSrc.replace('accessibilityElementsHidden={locked}', '');
  const remounting = lockSrc.replace(/<View\s+style=\{locked \? styles\.hiddenWhileLocked : styles\.fill\}\s+importantForAccessibility[\s\S]*?\{children\}\s*<\/View>/, "{locked ? <View importantForAccessibility='no-hide-descendants' accessibilityElementsHidden>{children}</View> : children}");
  const noDisplayNone = lockSrc.replace('style={locked ? styles.hiddenWhileLocked : styles.fill}', 'style={styles.fill}');
  check('mutation: dropping the Android prop is caught', noAndroid !== lockSrc && !lockHidesScreens(noAndroid));
  check('mutation: dropping the iOS prop is caught', noIos !== lockSrc && !lockHidesScreens(noIos));
  check('mutation: wrapping only while locked (remounts the screens) is caught', remounting !== lockSrc && !lockHidesScreens(remounting));
  check('mutation: dropping the display: none while locked is caught', noDisplayNone !== lockSrc && !lockHidesScreens(noDisplayNone));
  check('LockGate: the lock overlay itself stays outside the hidden wrapper',
    lockSrc.indexOf('{children}') < lockSrc.indexOf('Shiba Wallet is locked') &&
      /\{children\}\s*<\/View>\s*\{locked \? \(/.test(lockSrc));

  console.log('\n# copy built from the profile table');
  const { testNetworkLabelsOr } = await import('../src/wallet/walletconnect.ts');
  const { EVM_MAINNET: MAIN } = await import('../src/config/evm-chain.ts');
  const settingsSrc = read('../src/screens/SettingsScreen.tsx');
  check('Settings WalletConnect blurb names every profile (built from the table)',
    settingsSrc.includes('(${EVM_MAINNET.label} mainnet, or ${testNetworkLabelsOr()} while test mode is on)') &&
      !settingsSrc.includes('(Ethereum mainnet, or Sepolia while test mode is on)') &&
      `${MAIN.label} mainnet, or ${testNetworkLabelsOr()} while test mode is on` ===
        'Ethereum mainnet, or Ethereum Sepolia, Base Sepolia, Arbitrum Sepolia, Hoodi or OP Sepolia while test mode is on');
  check('Settings Backup text: no "every account in the list above" claim while watch-only addresses or multisigs are listed',
    settingsSrc.includes("{!keylessListed\n              ? 'One recovery phrase backs up ALL of your accounts") &&
      settingsSrc.includes('const keylessListed = watchOnlyAccounts.length > 0 || multisigAccounts.length > 0;') &&
      settingsSrc.includes('that this wallet holds a key for') &&
      settingsSrc.includes('Watch-only addresses have no key in this wallet, so the recovery phrase does not back them up'));
  // Phase 16 browser re-check finding: the Settings button that opens the
  // Connections screen read "Open connections" while the screen is titled
  // "Connected apps"; the label now equals the title.
  const connSrc = read('../src/screens/ConnectionsScreen.tsx');
  const connectedTitle = /export const CONNECTIONS_SCREEN_TITLE = '([^']+)';/.exec(connSrc)?.[1];
  const buttonToConnections = /<Button\s+title="([^"]+)"\s+variant="secondary"\s+onPress=\{\(\) => navigation\.navigate\('Connections'\)\}\s*\/>/.exec(settingsSrc)?.[1];
  check('Settings: the button that opens the Connections screen carries the screen\'s title ("Connected apps")',
    connectedTitle === 'Connected apps' && buttonToConnections === connectedTitle && !settingsSrc.includes('Open connections'),
    `${buttonToConnections} vs ${connectedTitle}`);
  check('Settings Apps blurb names that button by its new label',
    settingsSrc.replace(/\s+/g, ' ').includes('(open it with the &quot;Connected apps&quot; button in the WalletConnect section above, or with &quot;Manage connections&quot; in Apps)'));
  const sendSrc = read('../src/screens/SendScreen.tsx');
  check('Send: the recipient placeholder offers ENS names only where the profile looks them up',
    sendSrc.includes('const namesOffered = route.params.chainId === EVM_CHAIN_ID && nameRegistry.ok;') &&
      sendSrc.includes('placeholder={sendRecipientPlaceholder({ namesOffered, ethereum: Boolean(token || nftMode), symbol: account.symbol })}') &&
      !/'Ethereum address or ENS name'|address or ENS name`/.test(sendSrc));
  const { ensRegistryFor, sendRecipientPlaceholder, SEND_RECIPIENT_NAMES_HINT } = await import('../src/wallet/ens-names.ts');
  // Pass p20c finding 19: "ETH address or ENS name" was cut to "ETH address
  // or ENS ı" at phone width; the placeholder is now short enough for one
  // line beside the Scan and Contacts buttons and the long text is a hint
  // line under the row (and the field's accessibility hint).
  check('Send: the recipient placeholders are short (at most 19 characters) and name ENS only where names are offered (exact)',
    sendRecipientPlaceholder({ namesOffered: true, ethereum: false, symbol: 'ETH' }) === '0x… or ENS name' &&
      sendRecipientPlaceholder({ namesOffered: false, ethereum: true, symbol: 'ETH' }) === 'Ethereum address' &&
      sendRecipientPlaceholder({ namesOffered: false, ethereum: false, symbol: 'ETH' }) === 'ETH address' &&
      ['0x… or ENS name', 'Ethereum address', 'ETH address'].every((t) => t.length <= 19));
  check('Send: the long text is the hint line under the recipient row, shown only where names are offered (exact)',
    SEND_RECIPIENT_NAMES_HINT === 'Enter an Ethereum address (0x…) or an ENS name such as nick.eth.' &&
      /\{namesOffered \? \(\s*<Text style=\{\[styles\.hint, \{ color: theme\.textMuted \}\]\}>\{SEND_RECIPIENT_NAMES_HINT\}<\/Text>\s*\) : null\}/.test(sendSrc) &&
      sendSrc.includes("namesOffered ? SEND_RECIPIENT_NAMES_HINT : undefined,"));
  check('…which is false on Base Sepolia, Arbitrum Sepolia, Hoodi and OP Sepolia (no ENS contracts there), true on mainnet and Sepolia',
    EVM_PROFILES.map((p) => `${p.caip2}=${ensRegistryFor(p).ok}`).join(',') ===
      'eip155:1=true,eip155:11155111=true,eip155:84532=false,eip155:421614=false,eip155:560048=false,eip155:11155420=false');
  const homeSrc = read('../src/screens/HomeScreen.tsx');
  check('Home: the EVM row is titled with the active profile’s label; other rows keep their own names',
    homeSrc.includes('const title = isEvm ? evmChain.label : item.name;') &&
      homeSrc.includes('<Text style={[styles.chainName, { color: theme.text }]}>{title}</Text>') &&
      !homeSrc.includes('{item.name}</Text>'));
}

// Phase 18 emulator finding 7: the Developer hint said the smart-account
// path runs on every test network, Hoodi included (no Kernel v3.3 there).
// The hint is evaluated from SettingsScreen.tsx's own source (the IIFE and
// its listJoin helper) against the real profile table.
console.log('\n# Developer hint: the smart-account clause follows kernelV33Verified');
{
  const { readFileSync: readFs } = await import('node:fs');
  const settingsSrc = readFs(new globalThis.URL('../src/screens/SettingsScreen.tsx', import.meta.url), 'utf8');
  const listJoinTs = /function listJoin\([\s\S]*?\n\}\n/.exec(settingsSrc)?.[0] ?? '';
  const listJoinJs = listJoinTs.replace("items: string[], conjunction: 'and' | 'or'): string", 'items, conjunction)');
  const iife = /const DEVELOPER_TEST_NETWORK_HINT = (\(\(\) => \{[\s\S]*?\n\}\)\(\));/.exec(settingsSrc)?.[1] ?? '';
  check('the hint builder and its helper were found in SettingsScreen.tsx (and the helper is type-free once stripped)',
    listJoinJs !== listJoinTs && iife !== '' && !/:\s*string/.test(listJoinJs));
  const hintFor = (profiles) => new Function('EVM_TEST_PROFILES', `${listJoinJs}\nreturn ${iife};`)(profiles);
  const hint = hintFor(EVM_TEST_PROFILES);
  const clause = /as does the smart-account path on ([^(]+) \(the test networks where the Kernel v3\.3 contracts were verified\)/.exec(hint);
  check('the clause names exactly the Kernel-verified test networks (exact)',
    clause?.[1] === 'Ethereum Sepolia, Base Sepolia, Arbitrum Sepolia and OP Sepolia', clause?.[1] ?? hint);
  check('Hoodi is NOT named in the smart-account clause', clause !== null && !clause[0].includes('Hoodi'));
  check('…while the hint still lists Hoodi among the test networks (chain id 560048)', hint.includes('Hoodi (chain id 560048)'));
  check('the old "WalletConnect and the smart-account path all run against the chosen network" is gone',
    !hint.includes('the smart-account path all run') && hint.includes('balances, sends and WalletConnect run against the chosen network'));
  // Table-driven: a profile table where Hoodi had Kernel v3.3 would name it.
  const flipped = EVM_TEST_PROFILES.map((p) => (p.caip2 === 'eip155:560048' ? { ...p, kernelV33Verified: true } : p));
  const flippedClause = /smart-account path on ([^(]+) \(/.exec(hintFor(flipped))?.[1] ?? '';
  check('mutation: with Hoodi marked Kernel-verified the clause would name it (the clause is built from the table)',
    flippedClause.includes('Hoodi'), flippedClause);
}

// ---------------------------------------------------------------------------
// Pass p20c (TalkBack and dark mode, 2026-10-14): the app-wide patterns.
// Every rule below is a scan over app/src (comments removed) with an empty
// allow-list, plus an in-suite mutant showing the scan catches the old shape.
// ---------------------------------------------------------------------------
console.log('\n# pass p20c: app-wide accessibility and dark-mode patterns');
{
  const { readFileSync: readFs, readdirSync, statSync } = await import('node:fs');
  const root = new globalThis.URL('../src/', import.meta.url).pathname;
  const walk = (d) => readdirSync(d).flatMap((f) => {
    const full = `${d}/${f}`;
    return statSync(full).isDirectory() ? walk(full) : /\.tsx$/.test(f) ? [full] : [];
  });
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
  const files = walk(root.replace(/\/$/, '')).map((f) => ({ f: f.slice(root.length), src: stripComments(readFs(f, 'utf8')) }));
  // The opening tag of every <Name …> element (brace depth aware).
  const tags = (src, name) => {
    const out = [];
    const re = new RegExp(`<${name}\\b`, 'g');
    let m;
    while ((m = re.exec(src))) {
      let i = m.index + name.length + 1;
      let depth = 0;
      for (; i < src.length; i++) {
        const c = src[i];
        if (c === '{') depth++;
        else if (c === '}') depth--;
        else if (c === '>' && depth === 0) break;
      }
      out.push(src.slice(m.index, i + 1));
    }
    return out;
  };

  // (1) Every TextInput is named through components.tsx: useFieldLabels
  // (".input}", which also ties it to its visible label with
  // accessibilityLabelledBy on Android) or fieldA11y (no visible label).
  // A bare accessibilityLabel on a TextInput is refused: TalkBack read the
  // placeholder or value instead of it (finding 1).
  // Pass p20d finding 1: fieldA11y counts only WITH a labelId (a label view
  // to be "labelled by"); a field without a visible label gets a
  // HiddenFieldLabel through useFieldLabels instead.
  const inputProblems = (all) => all.flatMap(({ f, src }) =>
    tags(src, 'TextInput').filter((t) => !/\.input\}|\.\.\.fieldA11y\([^)]*labelId/.test(t) || /\baccessibilityLabel=/.test(t)).map(() => f));
  const inputCount = files.reduce((n, { src }) => n + tags(src, 'TextInput').length, 0);
  check('finding 1: every TextInput in app/src is named through useFieldLabels or fieldA11y, none with a bare accessibilityLabel (allow-list empty)',
    inputProblems(files).length === 0 && inputCount >= 65, `${inputCount} inputs; problems: ${inputProblems(files).join(', ')}`);
  check('…mutant caught: a TextInput named only by its placeholder',
    inputProblems([...files, { f: 'mutant.tsx', src: '<TextInput value={x} placeholder="0.001" />' }]).length === 1);
  check('…mutant caught: a TextInput with the old bare accessibilityLabel',
    inputProblems([...files, { f: 'mutant.tsx', src: '<TextInput value={x} accessibilityLabel="Fee budget" />' }]).length === 1);
  check('…mutant caught (p20d finding 1): a TextInput named by fieldA11y with no label view to point at',
    inputProblems([...files, { f: 'mutant.tsx', src: "<TextInput {...fieldA11y('Alert price')} value={x} />" }]).length === 1);
  // Every fieldA11y call outside components.tsx (where useFieldLabels calls it
  // with its nativeID) names a labelId: on Android a field with a placeholder
  // is named only by the view it is labelled by.
  const fieldA11yProblems = (all) => all.flatMap(({ f, src }) =>
    f === 'components.tsx' ? [] : [...src.matchAll(/\bfieldA11y\(/g)].filter((m) => !/^fieldA11y\([^)]*labelId/.test(src.slice(m.index))).map(() => f));
  check('p20d finding 1: no fieldA11y call in app/src lacks a labelId — every field is labelled by a visible or hidden label view (allow-list empty)',
    fieldA11yProblems(files).length === 0, fieldA11yProblems(files).join(', '));
  check('…mutant caught: a label-less fieldA11y call (the old Price-alerts field)',
    fieldA11yProblems([...files, { f: 'mutant.tsx', src: '{...fieldA11y(`Alert price for ${asset.symbol} in US dollars`)}' }]).length === 1);
  // Every fieldLabel(KEY, …).input has its fieldLabel(KEY, …).label in the
  // same file, so the field is "labelled by" a visible label that exists.
  const pairProblems = (all) => all.flatMap(({ f, src }) => {
    const keys = (suffix) => [...src.matchAll(new RegExp(`fieldLabel\\(\\s*('[^']*'|\`[^\`]*\`),(?:(?!fieldLabel\\()[^])*?\\)\\.${suffix}\\}`, 'g'))].map((m) => m[1]);
    // A HiddenFieldLabel (p20d finding 1) is a label view too.
    const hidden = [...src.matchAll(/<HiddenFieldLabel field=\{fieldLabel\(\s*('[^']*'|`[^`]*`),/g)].map((m) => m[1]);
    const labels = new Set([...keys('label'), ...hidden]);
    return keys('input').filter((k) => !labels.has(k)).map((k) => `${f} ${k}`);
  });
  check('…every fieldLabel(key).input has a fieldLabel(key).label on a visible label in the same file',
    pairProblems(files).length === 0, pairProblems(files).join(', '));
  const comps = files.find((x) => x.f === 'components.tsx').src;
  check('…the helpers: fieldA11y sets accessibilityLabel (+ labelledBy and hint when given); useFieldLabels gives the label a useId nativeID and the input accessibilityLabelledBy to it (source)',
    comps.includes('accessibilityLabel: label,') &&
      comps.includes("...(opts.labelId !== undefined ? { accessibilityLabelledBy: opts.labelId } : {}),") &&
      comps.includes('const base = useId();') && comps.includes('const nativeID = `field-${base}-${key}`;') &&
      comps.includes('input: fieldA11y(label, { labelId: nativeID, ...(hint !== undefined ? { hint } : {}) }),'));
  const pairMutant = files.map((x) => (x.f === 'screens/ImportKeyScreen.tsx' ? { ...x, src: x.src.replace("{...fieldLabel('key', 'Ethereum private key').label} ", '') } : x));
  check('…mutant caught: a labelled field whose visible label lost its nativeID', pairProblems(pairMutant).length === 1);
  const hiddenMutant = files.map((x) => (x.f === 'screens/ConnectionsScreen.tsx' ? { ...x, src: x.src.replace("<HiddenFieldLabel field={fieldLabel('pairing-link', 'WalletConnect pairing link')} />", '') } : x));
  check('…mutant caught (p20d finding 1): a field whose hidden label view was dropped', pairProblems(hiddenMutant).length === 1);

  // Pass p20d finding 1: the hidden label view. It must exist as a native
  // view for Android's nativeID lookup, so it is not display "none", not
  // opacity 0 and not of zero size; hidden by a 1×1 clip and transparent text.
  {
    const { HIDDEN_FIELD_LABEL_STYLE: hiddenStyle } = await import('../src/a11y.ts');
    check('p20d finding 1: HIDDEN_FIELD_LABEL_STYLE is absolute, 1×1, clipped, transparent text, never opacity 0 or display none (exact)',
      JSON.stringify(hiddenStyle) === JSON.stringify({ position: 'absolute', width: 1, height: 1, overflow: 'hidden', color: 'transparent' }));
    // Pass p21a finding 1b: the 1×1 hidden label was an extra TalkBack swipe
    // stop, read after its field or out of order. It is now
    // importantForAccessibility "no" (Android) and accessibilityElementsHidden
    // (iOS); the field still finds it through labelled-by (findView matches
    // the nativeID only — RN 0.86.3 ReactFindViewUtil.kt:47–62).
    const hiddenComponentOk = (src) =>
      /export function HiddenFieldLabel\(\{ field \}: \{ field: FieldLabel \}\) \{\s*return \(\s*<Text \{\.\.\.field\.label\} importantForAccessibility="no" accessibilityElementsHidden style=\{HIDDEN_FIELD_LABEL_STYLE\}>\s*\{field\.text\}\s*<\/Text>/.test(src);
    check('…HiddenFieldLabel spreads the field label (its nativeID), is NOT important for accessibility on Android (not a swipe stop), hidden from VoiceOver, and draws field.text with that style (source)',
      hiddenComponentOk(comps));
    check('…mutant caught (p21a finding 1b): the hidden label with the default importance again (an extra swipe stop)',
      !hiddenComponentOk(comps.replace(' importantForAccessibility="no" accessibilityElementsHidden style={HIDDEN_FIELD_LABEL_STYLE}', ' accessibilityElementsHidden style={HIDDEN_FIELD_LABEL_STYLE}')));
    // The hidden style is drawn ONLY by HiddenFieldLabel, so every hidden
    // label in app/src carries the props above (no hand-rolled copy).
    const styleUsers = files.filter(({ f, src }) => f !== 'a11y.ts' && /HIDDEN_FIELD_LABEL_STYLE\b/.test(src.replace(/^import\b[^;]*HIDDEN_FIELD_LABEL_STYLE[^;]*;/gm, '')));
    check('…HIDDEN_FIELD_LABEL_STYLE is applied only inside HiddenFieldLabel (components.tsx), once',
      styleUsers.length === 1 && styleUsers[0].f === 'components.tsx' &&
        (comps.match(/style=\{HIDDEN_FIELD_LABEL_STYLE\}/g) ?? []).length === 1,
      styleUsers.map((x) => x.f).join(', '));
    check('…mutant caught: a hand-rolled hidden label elsewhere (default importance, a swipe stop)',
      [...files, { f: 'mutant.tsx', src: '<Text nativeID={id} style={HIDDEN_FIELD_LABEL_STYLE}>Name</Text>' }]
        .filter(({ f, src }) => f !== 'a11y.ts' && /HIDDEN_FIELD_LABEL_STYLE\b/.test(src.replace(/^import\b[^;]*HIDDEN_FIELD_LABEL_STYLE[^;]*;/gm, ''))).length === 2);
    // Every <HiddenFieldLabel field={fn(KEY, …)} /> is followed DIRECTLY by
    // the <TextInput> it names, whose first prop spreads fn(KEY, …).input:
    // if a screen reader ever reaches the label, it is next to its field.
    const hiddenOrderProblems = (all) => all.flatMap(({ f, src }) => {
      if (f === 'components.tsx') return [];
      const out = [];
      const re = /<HiddenFieldLabel\s+field=\{(\w+)\(\s*('[^']*'|`[^`]*`),[^]*?\/>/g;
      let m;
      while ((m = re.exec(src))) {
        const rest = src.slice(m.index + m[0].length);
        const next = /^\s*<TextInput\s+\{\.\.\.(\w+)\(\s*('[^']*'|`[^`]*`),/.exec(rest);
        if (!next || next[1] !== m[1] || next[2] !== m[2]) out.push(`${f} ${m[2]}`);
      }
      return out;
    });
    const hiddenCount = files.reduce((n, { f, src }) => n + (f === 'components.tsx' ? 0 : (src.match(/<HiddenFieldLabel\b/g) ?? []).length), 0);
    check('p21a finding 1b: every HiddenFieldLabel call site renders the label IMMEDIATELY before the TextInput it names (same key), none elsewhere (source scan of app/src)',
      hiddenOrderProblems(files).length === 0 && hiddenCount >= 26, `${hiddenCount} call sites; problems: ${hiddenOrderProblems(files).join(', ')}`);
    const orderMutant = files.map((x) => (x.f === 'components/Contacts.tsx'
      ? { ...x, src: x.src.replace("<HiddenFieldLabel field={fieldLabel('contact-name', 'Contact name')} />", '').replace('<Text selectable style={[styles.address, { color: theme.text }]}>', "<HiddenFieldLabel field={fieldLabel('contact-name', 'Contact name')} /><Text selectable style={[styles.address, { color: theme.text }]}>") }
      : x));
    check('…mutant caught: a hidden label moved away from its field (above the address line, as the Contacts dump showed)',
      hiddenOrderProblems(orderMutant).length >= 1);
    check('…mutant caught: a hidden label naming another field than the one after it',
      hiddenOrderProblems([...files, { f: 'mutant.tsx', src: "<HiddenFieldLabel field={fieldLabel('a', 'A')} />\n<TextInput {...fieldLabel('b', 'B').input} />" }]).length === 1);
    const priceSrc = files.find((x) => x.f === 'screens/PriceAlertsScreen.tsx').src;
    check('…the Price-alerts price field has a VISIBLE label it is labelled by: "Alert price for <asset> (US dollars)" (source)',
      priceSrc.includes("const priceField = fieldLabel('price', `Alert price for ${asset.symbol} (US dollars)`);") &&
        priceSrc.includes('<Text {...priceField.label} style={[styles.hint, { color: theme.textMuted }]}>{priceField.text}</Text>') &&
        priceSrc.includes('{...priceField.input}'));
    const grouped = [
      ['screens/GuardiansScreen.tsx', 'fieldLabel(`guardian-${i}-label`, `Guardian ${i + 1} label (optional)`)'],
      ['screens/GuardiansScreen.tsx', 'fieldLabel(`guardian-${i}-weight`, `Guardian ${i + 1} weight`)'],
      ['screens/InheritanceScreen.tsx', 'fieldLabel(`heir-${i}-label`, `Heir ${i + 1} label (optional)`)'],
      ['screens/InheritanceScreen.tsx', 'fieldLabel(`heir-${i}-weight`, `Heir ${i + 1} weight`)'],
      ['screens/MultisigScreen.tsx', 'fieldLabel(`cosigner-${i}-weight`, `Co-signer ${i + 1} weight`)'],
      ['screens/SessionsScreen.tsx', 'fieldLabel(`call-${i}-function`, `Call ${i + 1}: function (optional)`)'],
      ['screens/SessionsScreen.tsx', 'fieldLabel(`call-${i}-cap`, `Call ${i + 1}: most ${symbol} per call`)'],
    ];
    check('…the grouped guardian / heir / co-signer label-and-weight fields and the session-call function and cap fields have visible labels (source)',
      grouped.every(([f, call]) => {
        const src = files.find((x) => x.f === f).src;
        return src.includes(`<Text {...${call}.label} style={[styles.hint, { color: theme.textMuted }]}>{${call}.text}</Text>`) && src.includes(`{...${call}.input}`);
      }));
  }

  // Pass p20d finding 4: a switch row whose visible text is exactly the
  // switch's accessibilityLabel hides that text from screen readers, so the
  // label is spoken once (by the switch, with its state).
  const switchRowProblems = (all) => all.flatMap(({ f, src }) => {
    const out = [];
    for (const sw of tags(src, 'Switch')) {
      const lab = /accessibilityLabel=(\{[^}]*\}|"[^"]*")/.exec(sw)?.[1];
      if (!lab) continue;
      const content = lab.startsWith('"') ? lab.slice(1, -1) : lab;
      const at = src.indexOf(sw);
      const win = src.slice(Math.max(0, at - 500), at + sw.length + 500);
      for (const m of win.matchAll(/<Text\b((?:[^>{]|\{[^}]*\})*)>([^<]*)<\/Text>/g)) {
        if (m[2].trim().replace(/\s+/g, ' ') === content && !(m[1].includes('importantForAccessibility="no"') && m[1].includes('accessibilityElementsHidden'))) out.push(`${f} ${content}`);
      }
    }
    return out;
  });
  const switchLabelCount = files.reduce((n, { src }) => n + tags(src, 'Switch').filter((sw) => {
    const lab = /accessibilityLabel=(\{[^}]*\}|"[^"]*")/.exec(sw)?.[1];
    if (!lab) return false;
    const content = lab.startsWith('"') ? lab.slice(1, -1) : lab;
    const at = src.indexOf(sw);
    return [...src.slice(Math.max(0, at - 500), at + sw.length + 500).matchAll(/<Text\b(?:[^>{]|\{[^}]*\})*>([^<]*)<\/Text>/g)].some((m) => m[1].trim().replace(/\s+/g, ' ') === content);
  }).length, 0);
  check('p20d finding 4: every switch row whose visible text repeats the switch label hides that text from screen readers (allow-list empty)',
    switchRowProblems(files).length === 0 && switchLabelCount >= 12, `${switchLabelCount} rows; problems: ${switchRowProblems(files).join(', ')}`);
  const settingsHidden = '<Text importantForAccessibility="no" accessibilityElementsHidden style={[styles.toggleLabel, { color: theme.text, flexShrink: 1, marginRight: 12 }]}>';
  check('…the Privacy switch row (the one the pass heard twice) is one of them (source)', files.find((x) => x.f === 'screens/SettingsScreen.tsx').src.includes(settingsHidden));
  check('…mutant caught: the Privacy switch label spoken again',
    switchRowProblems(files.map((x) => (x.f === 'screens/SettingsScreen.tsx' ? { ...x, src: x.src.replace(settingsHidden, '<Text style={[styles.toggleLabel, { color: theme.text, flexShrink: 1, marginRight: 12 }]}>') } : x))).length === 1);

  // Pass p20d finding 5: text drawn with textTransform 'uppercase' is spoken
  // from its own case ("0x API key", not "0X API KEY"): every Text using an
  // uppercase-transform style carries an accessibilityLabel (or is hidden).
  const upperProblems = (all) => all.flatMap(({ f, src }) => {
    const sheet = src.slice(src.indexOf('StyleSheet.create('));
    const names = [...sheet.matchAll(/\n {2}(\w+): \{([^}]*)\}/g)].filter((m) => m[2].includes("textTransform: 'uppercase'")).map((m) => m[1]);
    if (names.length === 0) return [];
    return tags(src, 'Text').filter((t) => names.some((n) => new RegExp(`styles\\.${n}\\b`).test(t)) && !/\baccessibilityLabel=/.test(t) && !t.includes('importantForAccessibility="no"')).map(() => f);
  });
  const upperCount = files.reduce((n, { src }) => {
    const sheet = src.slice(src.indexOf('StyleSheet.create('));
    const names = [...sheet.matchAll(/\n {2}(\w+): \{([^}]*)\}/g)].filter((m) => m[2].includes("textTransform: 'uppercase'")).map((m) => m[1]);
    return n + tags(src, 'Text').filter((t) => names.some((nm) => new RegExp(`styles\\.${nm}\\b`).test(t))).length;
  }, 0);
  check('p20d finding 5: every Text drawn in capitals by textTransform carries an accessibilityLabel in its own case (allow-list empty)',
    upperProblems(files).length === 0 && upperCount >= 25, `${upperCount} texts; problems: ${upperProblems(files).join(', ')}`);
  check('…the 0x API key label (and every Account Abstraction field label) is spoken "0x API key", not "0X API KEY" (source)',
    files.find((x) => x.f === 'screens/SettingsScreen.tsx').src.includes("<Text accessibilityLabel={label} {...fieldLabel('aa', label).label} style={[styles.aaFieldLabel, { color: theme.textMuted }]}>{label}</Text>"));
  check('…mutant caught: the AA field label without its spoken label',
    upperProblems(files.map((x) => (x.f === 'screens/SettingsScreen.tsx' ? { ...x, src: x.src.replace("<Text accessibilityLabel={label} {...fieldLabel('aa', label).label}", "<Text {...fieldLabel('aa', label).label}") } : x))).length === 1);

  // (2) Section titles are headings: every Text drawn with a title style
  // carries accessibilityRole="header" (or is hidden because the screen's
  // header bar already says it).
  const TITLE_STYLE = /styles\.(sectionTitle|cardTitle|modalTitle|title|stepTitle|subTitle|heading|successTitle|previewTitle|summaryTitle|smartTitle|noticeTitle|groupTitle|callTitle)\b/;
  const headingProblems = (all) => all.flatMap(({ f, src }) =>
    tags(src, 'Text').filter((t) => TITLE_STYLE.test(t) && !t.includes('accessibilityRole="header"') && !t.includes('importantForAccessibility="no"')).map(() => f));
  const headingCount = files.reduce((n, { src }) => n + tags(src, 'Text').filter((t) => TITLE_STYLE.test(t)).length, 0);
  check('finding 2: every title-styled Text in app/src is a heading (allow-list empty)',
    headingProblems(files).length === 0 && headingCount >= 190, `${headingCount} titles; problems: ${headingProblems(files).join(', ')}`);
  check('…mutant caught: a section title without the heading role',
    headingProblems([...files, { f: 'mutant.tsx', src: '<Text style={[styles.sectionTitle, { color: theme.text }]}>Privacy</Text>' }]).length === 1);
  const named = (f, text) => files.find((x) => x.f === f).src.includes(text);
  check('…the titles the pass named are headings (lock screen, switcher, Apps, Staking, Settings Privacy / Swaps / Developer)',
    named('components/LockGate.tsx', '<Text accessibilityRole="header" style={[styles.title, { color: theme.text }]}>Shiba Wallet is locked</Text>') &&
      named('components/AccountSwitcher.tsx', '<Text accessibilityRole="header" style={[styles.modalTitle, { color: theme.text }]}>Accounts</Text>') &&
      named('screens/BrowserScreen.tsx', '<Text accessibilityRole="header" style={[styles.title, { color: theme.text }]}>Apps on {describeChain(evmChain.caip2)}</Text>') &&
      named('screens/StakingScreen.tsx', '<Text accessibilityRole="header" style={[styles.stepTitle, { color: theme.text }]}>Lido</Text>') &&
      named('screens/StakingScreen.tsx', '<Text accessibilityRole="header" style={[styles.label, { color: theme.textMuted }]}>What to do</Text>') &&
      named('screens/StakingViews.tsx', '<Text accessibilityRole="header" style={[styles.cardTitle, { color: theme.text }]}>Your staking balances</Text>') &&
      named('screens/SettingsScreen.tsx', '<Text accessibilityRole="header" style={[styles.sectionTitle, { color: theme.text }]}>{SCREEN_PROTECTION_TITLE}</Text>') &&
      named('screens/SettingsScreen.tsx', '<Text accessibilityRole="header" style={[styles.sectionTitle, { color: theme.text }]}>Swaps</Text>') &&
      named('screens/SettingsScreen.tsx', '<Text accessibilityRole="header" style={[styles.sectionTitle, { color: theme.text }]}>Developer</Text>'));

  // (14) Every Switch takes its colours from switchColors(theme): the off
  // track is the palette's controlBorder, not the platform default that
  // nearly vanished on the dark background.
  const switchProblems = (all) => all.flatMap(({ f, src }) =>
    tags(src, 'Switch').filter((t) => !t.startsWith('<Switch {...switchColors(theme)}')).map(() => f));
  const switchCount = files.reduce((n, { src }) => n + tags(src, 'Switch').length, 0);
  check('finding 14: every Switch in app/src spreads switchColors(theme) (allow-list empty)',
    switchProblems(files).length === 0 && switchCount >= 25, `${switchCount} switches; problems: ${switchProblems(files).join(', ')}`);
  check('…mutant caught: a Switch with the platform colours', switchProblems([...files, { f: 'mutant.tsx', src: '<Switch value={on} onValueChange={setOn} />' }]).length === 1);
  check('…switchColors: off track controlBorder, on track accent, thumb switchThumb, iOS background controlBorder (source)',
    comps.includes('trackColor: { false: theme.controlBorder, true: theme.accent },') && comps.includes('thumbColor: theme.switchThumb,') &&
      comps.includes('ios_backgroundColor: theme.controlBorder,'));

  // (14, 18) The control token: WCAG 2.2 SC 1.4.11 asks 3:1 for the parts
  // of a control a person must find (a field's outline, a switch's track).
  for (const [name, t] of [['light', lightTheme], ['dark', darkTheme]]) {
    const bg = contrastRatio(t.controlBorder, t.background);
    const card = contrastRatio(t.controlBorder, t.card);
    check(`findings 14 and 18 (${name}): controlBorder ${t.controlBorder} is at least 3:1 against the background and a card`,
      bg >= 3 && card >= 3, `${bg.toFixed(2)}:1 / ${card.toFixed(2)}:1`);
    const old = contrastRatio(t.border, t.background);
    check(`…(${name}) the old border token was far below that (the faint price-field border the pass saw)`, old < 1.5, `${old.toFixed(2)}:1`);
    const thumb = contrastRatio(t.switchThumb, t.controlBorder);
    check(`…(${name}) the white thumb stands out from the off track at 3:1 or more`, thumb >= 3, `${thumb.toFixed(2)}:1`);
  }
  // (18) Every text field's outline uses controlBorder: no TextInput draws
  // theme.border, and every shared input style is built with controlBorder.
  const borderProblems = (all) => all.flatMap(({ f, src }) => [
    ...tags(src, 'TextInput').filter((t) => /borderColor: theme\.border\b/.test(t)).map(() => `${f} (tag)`),
    ...[...src.matchAll(/const (?:input|inputStyle) = \[[^\]]*\]/g)].filter((m) => !m[0].includes('theme.controlBorder')).map(() => `${f} (style)`),
  ]);
  check('finding 18: every text field outline in app/src uses controlBorder (allow-list empty)', borderProblems(files).length === 0, borderProblems(files).join(', '));
  check('…mutant caught: a field drawn with the old faint border',
    borderProblems([...files, { f: 'mutant.tsx', src: 'const inputStyle = [styles.input, { color: theme.text, borderColor: theme.border }];' }]).length === 1);

  // (16) Coin badges: the label colour is chosen per fill by textOnFill.
  const { textOnFill, TEXT_ON_LIGHT_FILL } = await import('../src/theme-palette.ts');
  const { CHAINS } = await import('../src/wallet/chains.ts');
  for (const c of CHAINS) {
    const r = contrastRatio(textOnFill(c.accent), c.accent);
    check(`finding 16: the ${c.symbol} badge label on ${c.accent} is at least 4.5:1 (fixed fill, so in both themes)`, r >= 4.5, `${textOnFill(c.accent)}: ${r.toFixed(2)}:1`);
  }
  const btc = CHAINS.find((c) => c.symbol === 'BTC').accent;
  const doge = CHAINS.find((c) => c.symbol === 'DOGE').accent;
  check('…the finding reproduced: white on BTC and DOGE was 2.30:1 and 2.39:1; both now take the dark label',
    contrastRatio('#ffffff', btc).toFixed(2) === '2.30' && contrastRatio('#ffffff', doge).toFixed(2) === '2.39' &&
      textOnFill(btc) === TEXT_ON_LIGHT_FILL && textOnFill(doge) === TEXT_ON_LIGHT_FILL);
  const homeSrc = files.find((x) => x.f === 'screens/HomeScreen.tsx').src;
  check('…Home draws both badge kinds with textOnFill and the badge style no longer forces white (source)',
    homeSrc.includes('<Text style={[styles.badgeText, { color: textOnFill(item.accent) }]}>{item.symbol}</Text>') &&
      homeSrc.includes('<Text style={[styles.badgeText, { color: textOnFill(c.accent) }]}>{c.symbol}</Text>') &&
      !/badgeText: \{\s*color: '#ffffff'/.test(homeSrc));

  // (20) The Developer chips: one minimum height, the label centred both ways.
  const settings = files.find((x) => x.f === 'screens/SettingsScreen.tsx').src;
  const chip = settings.slice(settings.indexOf('  choiceChip: {'), settings.indexOf('  },', settings.indexOf('  choiceChip: {')));
  check('finding 20: Developer chips keep flexBasis 40% / minWidth 140 and gain minHeight 56 with the label centred vertically (source)',
    chip.includes("flexBasis: '40%',") && chip.includes('minWidth: 140,') && chip.includes('minHeight: 56,') && chip.includes("justifyContent: 'center',"));
  check('…and a wrapped button label is centred horizontally (components.tsx buttonLabel textAlign center)',
    /buttonLabel: \{[^}]*textAlign: 'center',/.test(comps));

  // (11) Settings' Edit buttons name what they edit.
  check('finding 11: the AA-field Edit button is spoken "Edit the <field>", so the 0x key reads "Edit the 0x API key" (source)',
    settings.includes('accessibilityLabel={`Edit the ${label}`}') && settings.includes('label="0x API key"') &&
      settings.includes('accessibilityLabel={`Edit the ${network.label} endpoint`}') &&
      settings.includes('accessibilityLabel={`Edit the ${network.label} Blockbook endpoint`}'));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
