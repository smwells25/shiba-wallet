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

Verified working: `npx expo export --platform android` bundles successfully,
and the produced Hermes bundle contains the engine code (checked by searching
the bundle for engine-only strings).

Since the live-balances work, the other engine packages
(`@shiba-wallet/chains-evm`, `chains-utxo`, `chains-solana`) are also `file:`
dependencies. They declare `"@shiba-wallet/core": "0.1.0"`, which is not on
the npm registry, so `app/package.json` carries an `overrides` entry:

```json
"overrides": { "@shiba-wallet/core": "file:../packages/core" }
```

npm applies the override to the chain packages' core dependency, resolving it
to the local workspace package instead of the registry (the override spec
matches the app's own direct `file:` dependency exactly, which npm requires
when a package is both overridden and a direct dependency). No Metro changes
were needed beyond the existing `watchFolders`/`nodeModulesPaths` setup:
all three packages symlink into `app/node_modules/@shiba-wallet/` and their
`@noble/*`/`@scure/*` deps resolve from the workspace-hoisted root
`node_modules` that Metro already searches.

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
  `ChainKeyProvider`s from the stored seed, plus each chain's live native
  balance (per-row spinner, tap-to-retry error state, pull-to-refresh; one
  chain failing never blanks the others). Balances are fetched through the
  engine's injected transports (`src/wallet/balances.ts`) against the
  endpoints configured in `src/config/` — verified public defaults, user
  overrides in AsyncStorage (endpoints are public configuration, not
  secrets, so they deliberately do not go through secure storage). Dogecoin
  has no verified public Esplora-compatible API, so its default is
  "unavailable" until the user configures an endpoint. Tap a chain to
  receive. `scripts/check-balances.mjs` exercises the balance module
  against the default endpoints from Node (read-only, standard test
  mnemonic).
- **Send** — per-chain send flow (entered from a Home row's Send link or the
  Receive screen) in three phases inside one screen. Form: recipient input
  validated live through engine code (EVM: EIP-55 via core's
  `toChecksumAddress` — all-lowercase/all-uppercase accepted and normalized,
  bad mixed-case checksums rejected; BTC/DOGE: chains-utxo's
  `addressToScriptPubKey` with the exact network parameters, so validation
  can never diverge from the script that gets signed; SOL: base58 decode to
  32 bytes), amount entry converted exactly with `parseUnits` (pure bigint,
  no floating point; see `scripts/test-units.mjs`), and a Max button that
  accounts for fees (EVM: balance − gasLimit·maxFeePerGas; BTC: sweep fee
  computed with the engine's size arithmetic and verified by iterating
  `buildTransfer`; SOL: balance − fee). Confirm: recipient/amount/fee/total,
  a "«chain» Mainnet — real funds" badge, and for EVM an `eth_call`
  pre-flight simulation whose decoded revert reason blocks the send unless
  the user flips an explicit "Send anyway" override; the final send is
  gated by local authentication (see below) and then signs and broadcasts
  through the engine (EVM: EIP-1559 EOA path via `signEip1559` +
  `eth_sendRawTransaction`, or — when the experimental smart-account
  toggle is on — the ERC-4337 path in `src/wallet/aa.ts` through the
  marked seam in `src/wallet/send.ts` (see "Account Abstraction" below);
  BTC/DOGE: `signAndBroadcast`; SOL: `signTransaction` +
  `sendTransaction` with a fresh blockhash at send time). Success: txid /
  signature with a block-explorer link (etherscan.io, blockstream.info,
  solscan.io; Dogecoin shows the txid without a link because no explorer
  has been verified for it). Fee sources: EVM `NodeClient.suggestFees` +
  `eth_estimateGas`; BTC/DOGE Esplora `GET /fee-estimates` (documented in
  the Esplora HTTP API as an object of confirmation-target → sat/vB,
  3-block target preferred); SOL `getFeeForMessage` (official RPC
  reference; base64 message in, lamports out, null → flagged fallback of
  5000 lamports per signature). Dogecoin with no configured endpoint still
  validates addresses but shows "sending unavailable — no configured
  endpoint". Engine errors (coin selection, dust, insufficient funds) are
  translated to plain language with the exact engine message kept as
  detail.
- **Activity** — per-chain transaction history (entered from a Home row's
  Activity link), newest first. The engine's chain packages supply the
  `HistoryProvider`s (Esplora for Bitcoin/Dogecoin, the standard RPC
  signature listing with bounded per-entry enrichment for Solana);
  `src/wallet/history.ts` is the thin glue that resolves the right provider
  from the configured endpoint, and `src/wallet/useHistory.ts` applies the
  same per-chain loading/error/retry discipline as `useBalances`. Each row
  shows direction (received / sent / self, visually distinct), the amount in
  coin units via the exact-bigint `formatUnits` (an em-dash when the
  provider supplied no amount, which happens for Solana entries beyond the
  enrichment bound), the fee where known, confirmed vs pending status, a
  failed flag (Solana), and a relative-or-absolute time. Older pages load
  through the provider's opaque `nextCursor` (infinite scroll plus an
  explicit Load more button); tapping a row opens the same verified block
  explorers the send flow links to. Ethereum shows an honest "unavailable"
  state: a plain JSON-RPC endpoint cannot list transactions by address, so
  EVM history waits on an indexer-backed provider (the glue is keyed on the
  network kind so that provider can slot in without touching the screen).
  Dogecoin is likewise unavailable until an endpoint is configured.
  `scripts/check-history.mjs` exercises the glue live against mainnet
  endpoints, including a two-page pagination proof (read-only, standard
  test mnemonic).
- **Receive** — full-size, selectable, monospace address with a copy button
  (expo-clipboard) and a wrong-network warning. No QR in this phase: the
  common QR libraries need react-native-svg and the copy button covers the
  shell's needs; revisit when a design pass happens.
- **Settings** — per-chain RPC endpoint configuration (edit with validation,
  reset to default), the Account Abstraction section (below), an entry
  point to the Tokens screen, reveal the seed phrase behind a confirmation
  gate, and wipe the wallet behind a double confirmation.
- **Tokens** — ERC-20 token management (Ethereum mainnet only in this
  phase). The tracked list is persisted in AsyncStorage as the JSON of
  core's `AssetRegistry` (CAIP-19 asset ids); it ships with exactly one
  default, USDC, whose contract address was verified against Circle's
  documentation, Etherscan, and the chain itself (see the comment on
  `USDC_MAINNET` in `src/wallet/erc20.ts`). Adding a token takes a contract
  address (EIP-55-validated through the same engine path as the send
  screen), reads `symbol()`/`name()`/`decimals()` from the contract via
  `eth_call` (calldata and uint256 decoding from `@shiba-wallet/chains-evm`;
  the ABI `string` return type is decoded by a small app-side decoder in
  `src/wallet/erc20.ts` that refuses to guess at legacy bytes32 metadata and
  falls back to manual symbol/name entry instead — decimals always come
  from the chain), and requires explicit confirmation before the token is
  added. Duplicate CAIP-19 ids are rejected; any token, including USDC, can
  be removed, and removals persist. Tracked token balances appear on Home
  beneath the Ethereum row (`balanceOf` through the same transport, same
  per-row loading/error/retry discipline, included in pull-to-refresh).
  Tokens are balance-display only in this phase: there is deliberately no
  token send UI, and the footer/labels say so. `scripts/check-tokens.mjs`
  exercises the store, the string decoder's edge cases, and the live
  metadata/balance reads from Node.

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

## Local authentication (biometric gating)

Two actions are gated by `expo-local-authentication` through
`src/wallet/biometric.ts`: the Settings seed-phrase reveal and the final
send confirmation. The gate runs `authenticateAsync` only when
`hasHardwareAsync()` and `isEnrolledAsync()` are both true; a device
without a scanner, or with one but nothing enrolled, proceeds without a
prompt — the gate is defense in depth on top of the OS device lock and the
secure store's own access control, not the primary protection.
`disableDeviceFallback` is `false`, so per the SDK 57 documentation the
system falls back to the device passcode after several failed biometric
attempts instead of locking the user out. The mnemonic continues to live
only in expo-secure-store (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`); the gate
changes when it is read, never where it lives. Note that iOS FaceID does
not work in Expo Go — a development build is needed to exercise the prompt
there.

## Account Abstraction (experimental, off by default)

`src/wallet/aa.ts` implements the ERC-4337 smart-account send path behind
an explicit per-send toggle. Nothing about the regular EOA flow changes
while the toggle is off or the chain is unconfigured.

- **Configuration** lives in the Settings section "Account Abstraction
  (experimental)": a bundler URL and a SimpleAccountFactory address per
  EVM chain, both empty by default, persisted in AsyncStorage (public
  configuration, not secrets — same policy as RPC endpoints). Saving is
  verification-gated and refuses to persist anything that fails, so a
  stored value is always a verified one. The factory checks are exactly
  the procedure in `docs/AA_STACK.md` as implemented by
  `scripts/testnet/aa-smoke.mjs`: the factory must have code, its
  `accountImplementation()` must have code, and that implementation's
  `entryPoint()` must equal the pinned EntryPoint v0.7 — all read through
  the configured node RPC. The bundler check requires
  `eth_supportedEntryPoints` to include EntryPoint v0.7.
- **Send flow**: when both endpoints are configured for the chain, the
  Send screen offers a "Send from smart account" toggle (default off).
  With it on, the confirm screen shows the counterfactual smart-account
  address (resolved through the factory's `getAddress` view), that
  account's own balance (it pays the amount and its own gas — there is no
  paymaster in this pass), and whether the send will deploy the account.
  The fee is the bundler's `eth_estimateUserOperationGas` estimate at the
  node's suggested EIP-1559 fees, shown as a worst case. The biometric
  gate applies as usual; the operation goes through
  `SmartAccountClient.sendCalls` (chains-evm), and the success screen
  shows the userOpHash while polling `eth_getUserOperationReceipt`
  ("Bundling…"). The receipt shape is bundler-dependent, so it is
  inspected defensively: an explorer link appears only when a real
  transaction hash is found in the receipt, never a fabricated one.
- Quoting never touches key material: the counterfactual address, nonce,
  and gas estimate are computed with an address-only owner stand-in and
  the account spec's stub signature; the real owner key is re-derived via
  `WalletContext.signWith` only for the final send.
- `scripts/check-aa.mjs` exercises all of this offline with fake
  transports (config round-trip, every verification reject case, the full
  stub → estimate → sign → send pipeline, receipt-shape handling).

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

node scripts/test-units.mjs      # parseUnits + recipient-validation edge cases (offline)
node scripts/check-balances.mjs  # balance module against default endpoints (read-only)
node scripts/check-tokens.mjs    # token store + ABI string decoder + live ERC-20 reads (read-only)
node scripts/check-history.mjs   # history glue + live pagination proof (read-only)
node scripts/check-aa.mjs        # ERC-4337 glue end-to-end with fake transports (offline)
```
