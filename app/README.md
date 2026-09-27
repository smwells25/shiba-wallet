# Shiba Wallet — mobile app shell

An Expo (React Native + TypeScript) shell around the wallet engine that lives
in `packages/*`. This phase delivers onboarding, address display, receive, and
settings — no transaction sending yet.

## How the app is wired to the workspace packages

The repository root `package.json` declares npm workspaces for `packages/*`
only. This app directory is deliberately **not** a workspace member, so the
engine is consumed the way any external app would consume it:

1. **`file:` dependency.** `app/package.json` depends on
   `"@shiba-wallet/core": "file:../packages/core"`. npm installs this as a
   symlink (`app/node_modules/@shiba-wallet/core -> ../../packages/core`), and
   installs core's published dependencies (`@noble/*`, `@scure/*`) into
   `app/node_modules` as usual. This resolved correctly and is the chosen
   mechanism.
2. **Metro configuration** (`metro.config.js`). Metro resolves the symlink to
   its real path, which is outside the app directory, so the config adds:
   - `watchFolders: [<repo root>]` so Metro watches and serves files under
     `packages/` and the root `node_modules`;
   - `resolver.nodeModulesPaths: [app/node_modules, <repo root>/node_modules]`
     so imports made *from inside* `packages/core` (which resolve against the
     workspace-hoisted root `node_modules`) are found.

Verified working: `npx expo export --platform android` bundles 884 modules,
and the produced Hermes bundle contains the engine code (checked by searching
the bundle for engine-only strings). The other engine packages
(`@shiba-wallet/chains-evm`, `chains-utxo`, `chains-solana`) are not needed by
this phase (the shell only derives keys and addresses, which is core's job);
when transaction flows land they should be added the same way. Note that they
depend on `@shiba-wallet/core@0.1.0`, which is not on the npm registry, so
when adding them either keep npm's link semantics happy with an `overrides`
entry pointing at `file:../packages/core` or map them through
`resolver.extraNodeModules` in `metro.config.js` instead of `file:` deps.

After changing engine source, rebuild it (`npm run build` at the repo root)
— the app consumes `packages/core/dist`, not `src`.

## Screens

All navigation uses React Navigation's native stack (chosen over Expo Router
because the app has a small, fixed set of screens gated by wallet state, which
is simpler to express as two conditional `Stack.Screen` groups than as a file
based route tree). Wallet state lives in `src/wallet/WalletContext.tsx`.

- **Welcome** — create a new wallet or import an existing one.
- **Backup** — shows the freshly generated 12-word BIP-39 mnemonic (via
  core's `createMnemonic`) with a serious backup warning. The mnemonic is held
  only in memory at this point.
- **ConfirmBackup** — quiz: pick the correct word for two random positions
  (decoys drawn from the BIP-39 English wordlist). Only after passing is the
  mnemonic persisted to secure storage.
- **Import** — paste a 12–24 word mnemonic; word-count and checksum
  validation via core's `isValidMnemonic` with specific error messages.
- **Home** — the four launch chains (Ethereum, Bitcoin, Dogecoin, Solana)
  with the account-0 address of each, derived through core's
  `ChainKeyProvider`s from the stored seed. Tap a chain to receive.
- **Receive** — full-size, selectable, monospace address with a copy button
  (expo-clipboard) and a wrong-network warning. No QR in this phase: the
  common QR libraries need react-native-svg and the copy button covers the
  shell's needs; revisit when a design pass happens.
- **Settings** — reveal the seed phrase behind a confirmation gate, and wipe
  the wallet behind a double confirmation.

## Seed storage (non-custodial invariant)

The mnemonic is stored **only** in `expo-secure-store` (iOS Keychain /
Android Keystore-backed), with `WHEN_UNLOCKED_THIS_DEVICE_ONLY` so it never
migrates via OS backups — recovery on a new device goes through the user's
written backup, by design. It is never written to AsyncStorage, never logged,
and never sent over the network. All reads and writes go through
`src/wallet/storage.ts`, which documents the invariant; do not touch key
material anywhere else. Screens keep only derived public data (addresses,
paths) in React state; the 64-byte seed is zeroed immediately after address
derivation.

## Crypto polyfill

`@noble/hashes` (used by `@scure/bip39` for mnemonic entropy) requires
`globalThis.crypto.getRandomValues` and throws if it is missing (see
`randomBytes` in `node_modules/@noble/hashes/utils.js`). Hermes does not
provide WebCrypto, and the `expo` package's winter runtime does not install
`getRandomValues` (verified by inspecting `node_modules/expo/build` for SDK
57). The fix is `src/polyfills.ts`: it installs `expo-crypto`'s synchronous,
native-backed `getRandomValues` (which has the exact WebCrypto shape — see
`node_modules/expo-crypto/build/Crypto.js`) onto `globalThis.crypto` when the
runtime lacks one. `index.ts` imports it **before** anything that loads the
engine; keep it the first import. Apart from randomness, the noble/scure v2
stack is pure JS and bundles under Metro without further shims (confirmed by
the successful export above).

`react-native-get-random-values` was considered and not used: expo-crypto is
already an Expo SDK module, ships the needed function, and avoids a second
native dependency.

## Commands

```bash
export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"  # repo convention

npm install          # once
npm run typecheck    # tsc --noEmit
npx expo start       # dev server
npx expo export --platform android   # prove the bundle builds
```
