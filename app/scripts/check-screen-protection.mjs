// App-wide screen protection (phase 17 item 0), entirely OFFLINE: the
// preference (src/config/prefs.ts), the state machine in
// src/wallet/screen-protection.ts driven through a fake of
// expo-screen-capture that reproduces the installed library's key handling
// (app/node_modules/expo-screen-capture/src/ScreenCapture.ts lines 37-72)
// over a fake native window flag, the coexistence with the keys the secret
// screens use, error handling, the pinned Settings copy, and the wiring in
// App.tsx and SettingsScreen.tsx (source checks).
//
// Run from the app directory:
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-screen-protection.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_PREFS, loadPrefs, savePrefs } from '../src/config/prefs.ts';
import {
  APP_WIDE_CAPTURE_KEY,
  IOS_APP_SWITCHER_BLUR,
  SCREEN_PROTECTION_ALWAYS_NOTE,
  SCREEN_PROTECTION_PLATFORM_NOTE,
  SCREEN_PROTECTION_SWITCH_LABEL,
  SCREEN_PROTECTION_TITLE,
  createScreenProtection,
  describeNativeError,
  describeScreenProtectionStatus,
} from '../src/wallet/screen-protection.ts';

let passed = 0;
let failed = 0;
function check(name, ok) {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}`);
  }
}

const appDir = new URL('..', import.meta.url).pathname;
const read = (rel) => readFileSync(join(appDir, rel), 'utf8');

function memoryStore() {
  const map = new Map();
  return {
    map,
    async getItem(k) {
      return map.has(k) ? map.get(k) : null;
    },
    async setItem(k, v) {
      map.set(k, v);
    },
  };
}

/**
 * A fake of expo-screen-capture: the JS wrapper's key handling copied from
 * the installed src/ScreenCapture.ts (a Set of active keys; prevent calls the
 * native prevent only for a key not yet held and forgets the key again when
 * the native call throws; allow forgets the key and calls the native allow
 * only when no key is left), over a fake native layer whose window flag is
 * a boolean. `platform` 'ios' adds the app-switcher cover functions.
 */
function fakeLibrary({ platform = 'android', failPrevent = 0, failCover = 0, failAllow = 0, delayMs = 0 } = {}) {
  const activeTags = new Set();
  const lib = {
    flag: false,
    cover: false,
    nativeLog: [],
    calls: [],
    inFlight: 0,
    maxInFlight: 0,
    failPrevent,
    failCover,
    failAllow,
  };
  const tick = () => (delayMs ? new Promise((r) => setTimeout(r, delayMs)) : Promise.resolve());
  async function nativePrevent() {
    lib.nativeLog.push('native-prevent');
    if (lib.failPrevent > 0) {
      lib.failPrevent--;
      throw new Error("Screenshots cannot be prevented because the app has no key window yet.\n  Retry after the app's first window is visible");
    }
    lib.flag = true;
  }
  async function nativeAllow() {
    lib.nativeLog.push('native-allow');
    if (lib.failAllow > 0) {
      lib.failAllow--;
      throw new Error('Current activity is no longer available');
    }
    lib.flag = false;
  }
  lib.preventScreenCaptureAsync = async (key = 'default') => {
    if (!activeTags.has(key)) {
      activeTags.add(key);
      try {
        await nativePrevent();
      } catch (error) {
        activeTags.delete(key);
        throw error;
      }
    }
  };
  lib.allowScreenCaptureAsync = async (key = 'default') => {
    activeTags.delete(key);
    if (activeTags.size === 0) {
      await nativeAllow();
    }
  };
  lib.activeTags = activeTags;
  // The injected native layer, as loadScreenCaptureNative() builds it.
  const wrap = (name, fn) => async (...args) => {
    lib.calls.push(args.length ? `${name}:${args[0]}` : name);
    lib.inFlight++;
    lib.maxInFlight = Math.max(lib.maxInFlight, lib.inFlight);
    try {
      await tick();
      return await fn(...args);
    } finally {
      lib.inFlight--;
    }
  };
  lib.native = {
    prevent: wrap('prevent', lib.preventScreenCaptureAsync),
    allow: wrap('allow', lib.allowScreenCaptureAsync),
  };
  if (platform === 'ios') {
    lib.native.enableAppSwitcherCover = wrap('cover-on', async () => {
      if (lib.failCover > 0) {
        lib.failCover--;
        throw new Error('cover failed');
      }
      lib.cover = true;
    });
    lib.native.disableAppSwitcherCover = wrap('cover-off', async () => {
      lib.cover = false;
    });
  }
  return lib;
}

function controllerFor(lib) {
  return createScreenProtection(async () => lib.native);
}

// ---------------------------------------------------------------------------
// 1. The installed library, read from source (the facts the design rests on)
// ---------------------------------------------------------------------------

console.log('installed expo-screen-capture source:');
{
  const pkg = JSON.parse(read('node_modules/expo-screen-capture/package.json'));
  check('the installed version is 57.0.4', pkg.version === '57.0.4');
  const js = read('node_modules/expo-screen-capture/src/ScreenCapture.ts');
  check('active keys are a module-level Set', /const activeTags: Set<string> = new Set\(\);/.test(js));
  check(
    'prevent calls the native prevent only for a key not yet held, and forgets the key when it throws',
    /if \(!activeTags\.has\(key\)\) \{\s*activeTags\.add\(key\);\s*try \{\s*await ExpoScreenCapture\.preventScreenCapture\(\);\s*\} catch \(error\) \{\s*activeTags\.delete\(key\);\s*throw error;/.test(js),
  );
  check(
    'allow calls the native allow only when no key is left',
    /activeTags\.delete\(key\);\s*if \(activeTags\.size === 0\) \{\s*await ExpoScreenCapture\.allowScreenCapture\(\);/.test(js),
  );
  check(
    "usePreventScreenCapture() without a key uses 'default' (BackupScreen's key)",
    /export function usePreventScreenCapture\(key: string = 'default'\)/.test(js),
  );
  check(
    'enableAppSwitcherProtectionAsync takes a blur intensity and is documented iOS-only',
    /export async function enableAppSwitcherProtectionAsync\(blurIntensity: number = 0\.5\)/.test(js) &&
      /@platform ios\s*\*\s*\*\/\s*export async function enableAppSwitcherProtectionAsync/.test(js),
  );
  const kt = read('node_modules/expo-screen-capture/android/src/main/java/expo/modules/screencapture/ScreenCaptureModule.kt');
  check(
    'Android prevent adds FLAG_SECURE and allow clears it on the current activity window',
    /AsyncFunction<Unit>\("preventScreenCapture"\) \{\s*currentActivity\.window\.addFlags\(WindowManager\.LayoutParams\.FLAG_SECURE\)/.test(kt) &&
      /AsyncFunction<Unit>\("allowScreenCapture"\) \{\s*currentActivity\.window\.clearFlags\(WindowManager\.LayoutParams\.FLAG_SECURE\)/.test(kt),
  );
  check('the Android module has no app-switcher functions', !/AppSwitcher/.test(kt));
  const swift = read('node_modules/expo-screen-capture/ios/ScreenCaptureModule.swift');
  check(
    'the iOS module defines the app-switcher cover functions',
    /AsyncFunction\("enableAppSwitcherProtection"\)/.test(swift) && /AsyncFunction\("disableAppSwitcherProtection"\)/.test(swift),
  );
  const rnModal = read('node_modules/react-native/ReactAndroid/src/main/java/com/facebook/react/views/modal/ReactModalHostView.kt');
  check(
    "React Native's Android Modal copies FLAG_SECURE from the activity when its dialog is created",
    /val flagSecureSet = isFlagSecureSet\(currentActivity\)\s*if \(flagSecureSet\) \{\s*window\.setFlags\(\s*WindowManager\.LayoutParams\.FLAG_SECURE,/.test(rnModal),
  );
}

// ---------------------------------------------------------------------------
// 2. The preference
// ---------------------------------------------------------------------------

console.log('preference:');
{
  check('on by default', DEFAULT_PREFS.screenProtection === true);
  const empty = memoryStore();
  check('an empty store reads as on', (await loadPrefs(empty)).screenProtection === true);
  const legacy = memoryStore();
  await legacy.setItem('shiba-wallet.prefs.v1', JSON.stringify({ sepolia: false, hideAmounts: true, autoLockMs: null, showFiat: false }));
  const legacyPrefs = await loadPrefs(legacy);
  check('stored preferences from before this setting read as on', legacyPrefs.screenProtection === true && legacyPrefs.hideAmounts === true);
  const odd = memoryStore();
  await odd.setItem('shiba-wallet.prefs.v1', JSON.stringify({ screenProtection: 'no' }));
  check('a non-boolean stored value reads as on', (await loadPrefs(odd)).screenProtection === true);
  const corrupt = memoryStore();
  await corrupt.setItem('shiba-wallet.prefs.v1', '{not json');
  check('corrupt storage reads as on', (await loadPrefs(corrupt)).screenProtection === true);
  const store = memoryStore();
  const saved = await savePrefs({ screenProtection: false }, store);
  check('turning it off is stored', saved.screenProtection === false && (await loadPrefs(store)).screenProtection === false);
  const other = await savePrefs({ hideAmounts: true }, store);
  check('another preference change keeps it off', other.screenProtection === false);
  const back = await savePrefs({ screenProtection: true }, store);
  check('turning it back on is stored', back.screenProtection === true && (await loadPrefs(store)).screenProtection === true);
}

// ---------------------------------------------------------------------------
// 3. The state machine
// ---------------------------------------------------------------------------

console.log('state machine:');
{
  // Launch with the default (on): the first update arrives before the
  // preference is loaded, the second once it is.
  const lib = fakeLibrary();
  const c = controllerFor(lib);
  check('status starts idle', c.status().state === 'idle');
  await c.update({ prefsLoaded: false, enabled: false });
  check('before the preference is loaded the app is protected (protected first)', lib.flag === true && lib.calls.join(',') === `prevent:${APP_WIDE_CAPTURE_KEY}`);
  await c.update({ prefsLoaded: true, enabled: true });
  check('a stored "on" adds no further native call', lib.calls.join(',') === `prevent:${APP_WIDE_CAPTURE_KEY}` && lib.nativeLog.join(',') === 'native-prevent');
  check('status is on', c.status().state === 'on');
  await c.update({ prefsLoaded: true, enabled: true });
  check('a repeated update changes nothing', lib.calls.length === 1);
}
{
  // Launch with a stored "off": protect first, then release.
  const lib = fakeLibrary();
  const c = controllerFor(lib);
  await c.update({ prefsLoaded: false, enabled: true });
  await c.update({ prefsLoaded: true, enabled: false });
  check(
    'a stored "off" is honoured once loaded: prevent first, then allow with the app-wide key',
    lib.calls.join(',') === `prevent:${APP_WIDE_CAPTURE_KEY},allow:${APP_WIDE_CAPTURE_KEY}` && lib.flag === false,
  );
  check('status is off', c.status().state === 'off');
}
{
  // Turning off and on from Settings.
  const lib = fakeLibrary();
  const c = controllerFor(lib);
  await c.update({ prefsLoaded: false, enabled: true });
  await c.update({ prefsLoaded: true, enabled: true });
  lib.calls.length = 0;
  await c.update({ prefsLoaded: true, enabled: false });
  check('turning off calls allow with the app-wide key only', lib.calls.join(',') === `allow:${APP_WIDE_CAPTURE_KEY}`);
  check('turning off releases the flag when nothing else holds it', lib.flag === false);
  lib.calls.length = 0;
  await c.update({ prefsLoaded: true, enabled: true });
  check('turning on again calls prevent with the app-wide key', lib.calls.join(',') === `prevent:${APP_WIDE_CAPTURE_KEY}` && lib.flag === true);
}
{
  // Coexistence with the secret screens' keys, through the library's own
  // key handling. Keys from the app: 'default' (BackupScreen,
  // usePreventScreenCapture()), 'seed-reveal' (Settings), 'subscription-key'
  // (Sessions), and the private-key screens' CAPTURE_KEY.
  const secretKeys = ['default', 'seed-reveal', 'subscription-key', 'import-private-key', 'imported-key-reveal'];
  for (const key of secretKeys) {
    const lib = fakeLibrary();
    const c = controllerFor(lib);
    await c.update({ prefsLoaded: false, enabled: true });
    await c.update({ prefsLoaded: true, enabled: true });
    await lib.preventScreenCaptureAsync(key);
    await lib.allowScreenCaptureAsync(key);
    check(`a secret screen's release ('${key}') leaves the app-wide protection on`, lib.flag === true);
  }
  {
    const lib = fakeLibrary();
    const c = controllerFor(lib);
    await c.update({ prefsLoaded: false, enabled: true });
    await c.update({ prefsLoaded: true, enabled: true });
    await lib.preventScreenCaptureAsync('seed-reveal');
    await c.update({ prefsLoaded: true, enabled: false });
    check('turning off while the phrase is shown keeps the phrase screen protected', lib.flag === true);
    await lib.allowScreenCaptureAsync('seed-reveal');
    check('closing the phrase afterwards releases the flag', lib.flag === false);
  }
  {
    const lib = fakeLibrary();
    const c = controllerFor(lib);
    await c.update({ prefsLoaded: false, enabled: true });
    await c.update({ prefsLoaded: true, enabled: false });
    await lib.preventScreenCaptureAsync();
    check('with the setting off, the Backup screen is still protected', lib.flag === true);
    await c.update({ prefsLoaded: true, enabled: true });
    await lib.allowScreenCaptureAsync();
    check('turning on while Backup is open, then leaving Backup, keeps the app protected', lib.flag === true);
  }
}
{
  // iOS: the app-switcher cover follows the setting; Android never calls it.
  const ios = fakeLibrary({ platform: 'ios' });
  const c = controllerFor(ios);
  await c.update({ prefsLoaded: false, enabled: true });
  check('iOS: on = prevent, then the app-switcher cover', ios.calls.join(',') === `prevent:${APP_WIDE_CAPTURE_KEY},cover-on` && ios.cover && ios.flag);
  await c.update({ prefsLoaded: true, enabled: false });
  check('iOS: off = allow, then the cover removed', ios.calls.slice(2).join(',') === `allow:${APP_WIDE_CAPTURE_KEY},cover-off` && !ios.cover && !ios.flag);
  const android = fakeLibrary();
  const c2 = controllerFor(android);
  await c2.update({ prefsLoaded: false, enabled: true });
  await c2.update({ prefsLoaded: true, enabled: false });
  check('Android: no app-switcher call in either direction', !android.calls.some((x) => x.startsWith('cover')));
  check('the iOS blur is the maximum', IOS_APP_SWITCHER_BLUR === 1.0);
}
{
  // Native failures are a status line, never a throw; retried on foreground.
  const lib = fakeLibrary({ failPrevent: 1 });
  const c = controllerFor(lib);
  let threw = false;
  try {
    await c.update({ prefsLoaded: false, enabled: true });
  } catch {
    threw = true;
  }
  const st = c.status();
  check('a native failure does not throw', threw === false);
  check('a native failure becomes a failed status with the reason on one line',
    st.state === 'failed' && st.wanted === 'on' && st.detail === "Screenshots cannot be prevented because the app has no key window yet. Retry after the app's first window is visible");
  check('the library forgot the key after the failure', !lib.activeTags.has(APP_WIDE_CAPTURE_KEY) && lib.flag === false);
  await c.update({ prefsLoaded: true, enabled: true });
  check('the same direction is not retried by a repeated update', lib.nativeLog.filter((x) => x === 'native-prevent').length === 1);
  await c.retryIfFailed();
  check('retryIfFailed applies it', lib.flag === true && c.status().state === 'on');
  await c.retryIfFailed();
  check('retryIfFailed after success makes no call', lib.nativeLog.filter((x) => x === 'native-prevent').length === 2);
}
{
  const c = createScreenProtection(async () => {
    throw new Error("Cannot find native module 'ExpoScreenCapture'");
  });
  await c.update({ prefsLoaded: false, enabled: true });
  const st = c.status();
  check('a missing native module becomes a failed status', st.state === 'failed' && /ExpoScreenCapture/.test(st.detail));
}
{
  // iOS partial failure: screenshot block applied, cover failed; the retry
  // does not prevent twice natively (the key is held) and adds the cover.
  const lib = fakeLibrary({ platform: 'ios', failCover: 1 });
  const c = controllerFor(lib);
  await c.update({ prefsLoaded: false, enabled: true });
  check('iOS: a cover failure is reported', c.status().state === 'failed' && lib.flag === true && !lib.cover);
  await c.retryIfFailed();
  check('iOS: the retry adds the cover without a second native prevent',
    lib.cover && lib.flag && lib.nativeLog.filter((x) => x === 'native-prevent').length === 1 && c.status().state === 'on');
}
{
  // A failed release reports "could not be turned off" and turning on again
  // clears the failure.
  const lib = fakeLibrary({ failAllow: 1 });
  const c = controllerFor(lib);
  await c.update({ prefsLoaded: false, enabled: true });
  await c.update({ prefsLoaded: true, enabled: false });
  const st = c.status();
  check('a failed release is reported as such', st.state === 'failed' && st.wanted === 'off');
  await c.update({ prefsLoaded: true, enabled: true });
  check('turning on after a failed release re-applies', lib.flag === true && c.status().state === 'on');
}
{
  // Rapid toggles: native calls never overlap and the last wish wins.
  const lib = fakeLibrary({ delayMs: 5 });
  const c = controllerFor(lib);
  const seen = [];
  const unsubscribe = c.subscribe(() => seen.push(c.status().state));
  await Promise.all([
    c.update({ prefsLoaded: false, enabled: true }),
    c.update({ prefsLoaded: true, enabled: false }),
    c.update({ prefsLoaded: true, enabled: true }),
    c.update({ prefsLoaded: true, enabled: false }),
  ]);
  check('native calls are serialised', lib.maxInFlight === 1);
  check('the last wish wins (off)', lib.flag === false && c.status().state === 'off');
  check('the controller only ever used the app-wide key', lib.calls.every((x) => x.endsWith(`:${APP_WIDE_CAPTURE_KEY}`)));
  check('subscribers were told about each change', seen.length >= 2 && seen[seen.length - 1] === 'off');
  unsubscribe();
  const before = seen.length;
  await c.update({ prefsLoaded: true, enabled: true });
  check('an unsubscribed listener hears nothing', seen.length === before);
}
{
  check('a long native message is shortened', describeNativeError(new Error('x'.repeat(500))).length === 200);
  check('an empty native message gets a plain placeholder', describeNativeError(new Error('  ')) === 'no reason was given');
}

// ---------------------------------------------------------------------------
// 4. Copy (pinned)
// ---------------------------------------------------------------------------

console.log('copy:');
{
  check('section title', SCREEN_PROTECTION_TITLE === 'Privacy');
  check('switch label', SCREEN_PROTECTION_SWITCH_LABEL === 'Hide in the app switcher and block screenshots');
  check(
    'platform note',
    SCREEN_PROTECTION_PLATFORM_NOTE ===
      'On Android this also blocks screenshots and screen recording of every screen in this wallet, including your Receive QR; copy the address instead. On iOS, screenshots come out blank and the app switcher shows a cover.',
  );
  check(
    'always-protected note',
    SCREEN_PROTECTION_ALWAYS_NOTE ===
      'The screens that show or take in your recovery phrase or a private key are always protected, whatever this setting.',
  );
  check('status: applying', describeScreenProtectionStatus({ state: 'applying' }) === 'Turning screen protection on…');
  check('status: on', describeScreenProtectionStatus({ state: 'on' }) === 'Screen protection is on.');
  check('status: releasing', describeScreenProtectionStatus({ state: 'releasing' }) === 'Turning screen protection off…');
  check('status: off', describeScreenProtectionStatus({ state: 'off' }) === 'Screen protection is off.');
  check(
    'status: failed to turn on',
    describeScreenProtectionStatus({ state: 'failed', wanted: 'on', detail: 'D' }) ===
      "Screen protection could not be turned on on this device, so screenshots, recordings or the app switcher may show this wallet's screens. It is tried again each time the app returns to the foreground. Technical detail: D",
  );
  check(
    'status: failed to turn off',
    describeScreenProtectionStatus({ state: 'failed', wanted: 'off', detail: 'D' }) ===
      'Screen protection could not be turned off on this device; screens may stay protected. It is tried again each time the app returns to the foreground. Technical detail: D',
  );
}

// ---------------------------------------------------------------------------
// 5. Wiring and key uniqueness (source checks)
// ---------------------------------------------------------------------------

console.log('wiring:');
{
  const mod = read('src/wallet/screen-protection.ts');
  const staticImports = mod.match(/^import .*$/gm) ?? [];
  check('screen-protection.ts has no static import (Node-loadable)', staticImports.length === 0);
  check(
    'the native layer is loaded by dynamic import only',
    /await import\('expo-screen-capture'\)/.test(mod) && /await import\('react-native'\)/.test(mod),
  );
  check(
    'the app-switcher functions are injected on iOS only',
    /if \(Platform\.OS === 'ios'\) \{\s*native\.enableAppSwitcherCover = \(\) => capture\.enableAppSwitcherProtectionAsync\(IOS_APP_SWITCHER_BLUR\);/.test(mod),
  );
  check('failed attempts are retried on return to the foreground', /next === 'active'\) void instance\.retryIfFailed\(\)/.test(mod));

  const app = read('App.tsx');
  check(
    'App.tsx mounts ScreenProtection inside PrefsProvider, before WalletProvider',
    /<PrefsProvider>\s*<ScreenProtection \/>\s*<WalletProvider>/.test(app),
  );
  check(
    'ScreenProtection passes the load state and the preference',
    /appScreenProtection\(\)\.update\(\{ prefsLoaded: ready, enabled: screenProtection \}\)/.test(app) &&
      /\[ready, screenProtection\]/.test(app),
  );

  const prefsCtx = read('src/wallet/PrefsContext.tsx');
  check('PrefsContext exposes the preference and its setter',
    /screenProtection: prefs\.screenProtection/.test(prefsCtx) && /setScreenProtection: \(on\) => patch\(\{ screenProtection: on \}\)/.test(prefsCtx));

  const settings = read('src/screens/SettingsScreen.tsx');
  const privacyAt = settings.indexOf('{SCREEN_PROTECTION_TITLE}');
  const securityAt = settings.indexOf('>Privacy & security</Text>');
  const pricesAt = settings.indexOf('>Prices</Text>');
  check('Settings → Privacy sits between "Privacy & security" and "Prices"', securityAt > 0 && privacyAt > securityAt && pricesAt > privacyAt);
  const block = settings.slice(privacyAt, pricesAt);
  check('the switch is bound to the preference and its setter',
    /value=\{screenProtection\}/.test(block) && /onValueChange=\{\(v\) => void setScreenProtection\(v\)\}/.test(block) &&
      /accessibilityLabel=\{SCREEN_PROTECTION_SWITCH_LABEL\}/.test(block));
  check('the block shows both notes and the status line',
    /\{SCREEN_PROTECTION_PLATFORM_NOTE\}/.test(block) && /\{SCREEN_PROTECTION_ALWAYS_NOTE\}/.test(block) &&
      /describeScreenProtectionStatus\(screenProtectionStatus\)/.test(block));

  // Every prevent / allow / hook call in app/src, with its key.
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name)) files.push(p);
    }
  };
  walk(join(appDir, 'src'));
  const uses = [];
  for (const f of [...files, join(appDir, 'App.tsx')]) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/(preventScreenCaptureAsync|allowScreenCaptureAsync|usePreventScreenCapture)\(([^)]*)\)/g)) {
      uses.push({ file: f.slice(appDir.length), fn: m[1], arg: m[2].trim() });
    }
  }
  const outside = uses.filter((u) => !u.file.endsWith('src/wallet/screen-protection.ts'));
  check('other screens make capture calls (the scan sees them)', outside.length >= 9);
  // Resolve the keys the screens use: literals and their CAPTURE_KEY constants.
  const keysOf = (u) => {
    if (u.arg === '') return 'default';
    const lit = /^'([^']*)'$/.exec(u.arg);
    if (lit) return lit[1];
    const src = read(u.file);
    const decl = new RegExp(`const ${u.arg} = '([^']*)'`).exec(src);
    return decl ? decl[1] : `unresolved:${u.arg}`;
  };
  const keys = outside.map(keysOf);
  check('every key the other screens use is resolved', keys.every((k) => !k.startsWith('unresolved:')));
  check('no other screen uses the app-wide key', !keys.includes(APP_WIDE_CAPTURE_KEY));
  check('no other file names APP_WIDE_CAPTURE_KEY in a capture call', outside.every((u) => u.arg !== 'APP_WIDE_CAPTURE_KEY'));
  const own = uses.filter((u) => u.file.endsWith('src/wallet/screen-protection.ts'));
  check('screen-protection.ts calls the library with its injected key only',
    own.every((u) => u.arg === 'key' || u.arg === '') && /prevent: \(key\) => capture\.preventScreenCaptureAsync\(key\)/.test(mod) &&
      /await native\.prevent\(APP_WIDE_CAPTURE_KEY\)/.test(mod) && /await native\.allow\(APP_WIDE_CAPTURE_KEY\)/.test(mod));
  check('the secret screens were left as they were (their keys are unchanged)',
    ['default', 'seed-reveal', 'subscription-key'].every((k) => keys.includes(k)));
}

// ---------------------------------------------------------------------------
// 6. Notes for presenters and device testers
// ---------------------------------------------------------------------------

console.log('docs:');
{
  const demo = readFileSync(join(appDir, '..', 'docs', 'DEMO.md'), 'utf8').replace(/\s+/g, ' ');
  const builds = readFileSync(join(appDir, '..', 'docs', 'DEVICE_BUILDS.md'), 'utf8').replace(/\s+/g, ' ');
  check('DEMO.md says to turn the setting off before screenshots or recordings',
    demo.includes('Hide in the app switcher and block screenshots') && /turn it \*\*off\*\* before/i.test(demo));
  check('DEVICE_BUILDS.md says the same',
    builds.includes('Hide in the app switcher and block screenshots') && /turn it off before/i.test(builds));
}

console.log(`\ncheck-screen-protection: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
