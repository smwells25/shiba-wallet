/**
 * Runtime polyfills. This module MUST be the first import of the app entry
 * point (index.ts), before anything that transitively loads
 * @shiba-wallet/core.
 *
 * Why: the engine's crypto stack (@noble/hashes, used by @scure/bip39 for
 * mnemonic generation) sources randomness exclusively from
 * `globalThis.crypto.getRandomValues` and throws
 * "crypto.getRandomValues must be defined" if it is absent — see
 * node_modules/@noble/hashes/utils.js (randomBytes). React Native's Hermes
 * runtime does not provide WebCrypto, and the `expo` package's winter
 * runtime does not install `crypto.getRandomValues` either (verified by
 * inspecting node_modules/expo/build for this SDK). expo-crypto exports a
 * synchronous, native-backed `getRandomValues(typedArray)` with the exact
 * WebCrypto shape (fills the array in place and returns it — see
 * node_modules/expo-crypto/build/Crypto.js), so we install it as the global
 * implementation when one is missing.
 *
 * The guard means that on platforms that already provide WebCrypto (web, or
 * a future runtime that ships it natively) the built-in implementation wins.
 */
import { getRandomValues } from 'expo-crypto';

// The runtime may or may not have a (partial) `crypto` global, and the DOM
// type for it is stricter than what we need, so this works on a loosely
// typed view of globalThis.
interface MinimalCrypto {
  getRandomValues?: (array: ArrayBufferView) => ArrayBufferView;
}

const g = globalThis as { crypto?: MinimalCrypto };

if (typeof g.crypto !== 'object' || g.crypto === null) {
  g.crypto = {};
}
if (typeof g.crypto.getRandomValues !== 'function') {
  g.crypto.getRandomValues = (array: ArrayBufferView) =>
    // expo-crypto accepts integer TypedArrays, which is all the wallet
    // engine ever passes (Uint8Array).
    getRandomValues(array as Uint8Array);
}
