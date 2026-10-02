import { requireOptionalNativeModule } from 'expo';
import { PASSKEY_RP_ID } from '../config/passkey';
import { passkeyGate, type PasskeyGate, type PasskeyNative } from './passkeys';

/**
 * The ONLY place that loads the native passkey module, react-native-passkeys
 * 0.4.2 (an Expo module; README: github.com/peterferguson/react-native-passkeys,
 * "npx expo install react-native-passkeys"; native module name
 * "ReactNativePasskeys" per its expo-module.config.json and
 * src/ReactNativePasskeysModule.ts).
 *
 * Expo Go does not contain that native module, and the package's JS entry
 * calls requireNativeModule("ReactNativePasskeys") when it is first
 * evaluated, which throws where the module is missing. So, like the
 * WalletConnect SDK (./walletconnect.ts initWalletConnect), the package is
 * loaded only through a dynamic import() and only after
 * requireOptionalNativeModule (expo, documented at
 * docs.expo.dev/versions/v57.0.0/sdk/expo "requireOptionalNativeModule":
 * returns null when the module cannot be found) confirmed the module is in
 * this binary. Nothing passkey-related is evaluated at app startup.
 */

const NATIVE_MODULE_NAME = 'ReactNativePasskeys';

let cached: Promise<{ gate: PasskeyGate; native: PasskeyNative | null }> | null = null;

function nativeModulePresent(): boolean {
  try {
    return requireOptionalNativeModule(NATIVE_MODULE_NAME) !== null;
  } catch {
    return false;
  }
}

/**
 * The passkey gate for this app binary plus, when it is open, the native
 * layer adapted to PasskeyNative. Cached for the app session (the binary and
 * the configured rpId cannot change while it runs).
 */
export function loadPasskeyNative(): Promise<{ gate: PasskeyGate; native: PasskeyNative | null }> {
  if (cached) return cached;
  cached = (async () => {
    const present = nativeModulePresent();
    const preGate = passkeyGate({ rpId: PASSKEY_RP_ID, nativePresent: present, platformSupported: null });
    if (!preGate.ok) return { gate: preGate, native: null };
    const mod = await import('react-native-passkeys');
    let supported: boolean;
    try {
      supported = mod.isSupported();
    } catch {
      supported = false;
    }
    const gate = passkeyGate({ rpId: PASSKEY_RP_ID, nativePresent: true, platformSupported: supported });
    if (!gate.ok) return { gate, native: null };
    const native: PasskeyNative = {
      // The request objects are the WebAuthn JSON shapes the library's
      // create()/get() accept (build/index.d.ts); the casts bridge our
      // narrower request types to the library's DOM-derived option types.
      create: (request) => mod.create(request as unknown as Parameters<typeof mod.create>[0]),
      get: (request) => mod.get(request as unknown as Parameters<typeof mod.get>[0]),
    };
    return { gate, native };
  })();
  cached.catch(() => {
    cached = null;
  });
  return cached;
}

/** Synchronous best-effort gate for rendering (no import; platform support unknown until loaded). */
export function passkeyGateNow(): PasskeyGate {
  return passkeyGate({ rpId: PASSKEY_RP_ID, nativePresent: nativeModulePresent(), platformSupported: null });
}
