/**
 * @walletconnect/react-native-compat ships no type declarations (it is a
 * side-effect-only polyfill module: TextEncoder/TextDecoder, URL, Buffer,
 * atob/btoa, plus netinfo/application globals). It is imported exactly once,
 * dynamically, in src/wallet/walletconnect.ts before the WalletKit SDK, per
 * the React Native usage docs
 * (https://docs.walletconnect.com/wallets/react-native/usage.md).
 */
declare module '@walletconnect/react-native-compat';
