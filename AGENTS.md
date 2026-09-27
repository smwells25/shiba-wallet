# Project State — Mobile AA Wallet ("Shiba Wallet", working title)

This file is the persistent state for all agents working on this project.
Read it fully before doing any work. Update it after every completed task.

## Project objective

A non-custodial mobile cryptocurrency wallet whose defining feature is
**Account Abstraction (ERC-4337 / EIP-7702)** on EVM chains, with first-class
support for Bitcoin, Solana, Dogecoin, and an extensible adapter system
capable of supporting thousands of other assets.

Non-negotiable requirements (from the Lead Chairperson):

1. **Non-custodial.** Keys are generated, stored, and used only on the user's
   device. No server ever sees key material. Fundamental; never compromise.
2. **Recovery and backup are required.** Implemented as a hierarchical
   deterministic (HD) wallet: a single BIP-39 seed phrase derives a BIP-32
   master key; each asset uses hardened derivation paths (BIP-44 / SLIP-44).
3. **Account Abstraction is the key differentiator.** Smart accounts,
   gas sponsorship (paymasters), batched transactions, session keys, social
   recovery on-chain, passkey signers.
4. **Maximum flexibility.** No architectural lock-in; every feature must be
   addable later without rewrites. Chain support is pluggable (adapter
   pattern). Staking is optional but valuable where it intersects AA.
5. Deliverable for the Chairperson: a complete feature-universe analysis so
   leadership can choose where to invest.
6. **Token and NFT support is required** (added by the Chairperson
   2026-09-27): ERC-20 fungible tokens (e.g. USDC) and NFTs (ERC-721,
   ERC-1155), designed so ANY fungible or non-fungible asset class can be
   supported later (SPL tokens, Token-2022, Ordinals/Runes, ...). Assets are
   identified by CAIP-19 ids in core so token support is chain-agnostic.

## Toolchain

- Node.js: v24.21.0 via nvm (Chairperson's directive: keep Node current).
  Shell default may still resolve to v14, so always prefix PATH:
  `export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"`
- Language: TypeScript. Monorepo with npm workspaces.
- Crypto primitives: `@scure/bip32`, `@scure/bip39`, `@noble/curves`,
  `@noble/hashes` (audited, dependency-free). Never hand-roll primitives.
- Tests: vitest, validated against official BIP-32/39/44 test vectors.
- Mobile shell: React Native (planned; core library is UI-agnostic on purpose).

## Repository layout (planned / in progress)

```
docs/                      Plain-English documents for leadership & engineers
  FEATURE_UNIVERSE.md      Complete feature landscape for the Chairperson
  ARCHITECTURE.md          System architecture and AA design
  DECISIONS.md             Architecture Decision Records
packages/
  core/                    @shiba-wallet/core — keyring, HD derivation,
                           chain-adapter interfaces, asset registry
  chains-evm/              EVM adapter incl. ERC-4337 smart accounts
  chains-bitcoin/          Bitcoin + Dogecoin (shared UTXO base)
  chains-solana/           Solana adapter
app/                       React Native app (later phase)
```

## Status

- [x] Repo initialized (git, main branch)
- [x] Toolchain verified (Node 24.21.0 via nvm)
- [x] docs/FEATURE_UNIVERSE.md — landed and CTO-reviewed (99 features, 12
      categories, tiered strategy; all cited standards verified real)
- [x] Asset/token layer in core (CAIP-19 parse/format, AssetRegistry with
      JSON persistence; ERC-20/721/1155 + SPL representable)
- [x] docs/ARCHITECTURE.md — landed and CTO-reviewed (fixed Solana account
      indexing: third segment increments per Phantom's documented
      m/44'/501'/{index}'/0' convention; ADRs D1–D7 live in its section 7,
      which supersedes the planned separate DECISIONS.md)
- [x] packages/core keyring (BIP-39/32/44 + SLIP-0010 ed25519, hardened paths)
- [x] Chain adapter interface + ChainRegistry (CAIP-2 keyed)
- [x] Core key providers: EVM, Bitcoin (BIP-84), Dogecoin, Solana — offline
      key/address half; network adapters still to come below
- [x] EVM ERC-4337 adapter (@shiba-wallet/chains-evm): EntryPoint v0.7
      UserOperation packing + userOpHash (verified vs account-abstraction
      v0.7.0 sources, cross-checked vs ethers AbiCoder), CREATE2
      counterfactual addresses (vs ethers.getCreate2Address), vendor-neutral
      BundlerClient + ERC-7677 PaymasterClient over injected transports,
      SmartAccountClient orchestration (stub → estimate → final paymaster →
      sign → send), SimpleAccount spec (EIP-191 owner sigs, execute /
      executeBatch ABI byte-identical to ethers), minimal ABI encoder.
      25 tests
- [x] Feature Universe published as a shareable page for the Chairperson:
      https://claude.ai/artifact/JEfyMuPcMJ8YW5x3ZKitsw (private until
      shared; regenerate from docs/FEATURE_UNIVERSE.md if it changes).
      Doc fix applied: features 10–11 assigned to Tier 2, Tier 2 list
      corrected from "85–87" to "85, 87" (86 is Tier 3)
- [x] Bitcoin/Dogecoin network adapter — packages/chains-utxo
      (@shiba-wallet/chains-utxo): raw tx build/sign offline-pure (P2WPKH
      BIP-143 for Bitcoin, legacy P2PKH sighash for Dogecoin, DER low-S
      SIGHASH_ALL), greedy largest-first coin selection with sat/vB fees and
      dust handling (546/294 sat, verified from Bitcoin Core policy.cpp),
      address decode/encode (bech32 v0 + base58check; taproot rejected
      clearly), injected Esplora-style transport (getUtxos/broadcastTx).
      40 tests: signed txs byte-identical to bitcoinjs-lib for both chains;
      Dogecoin prefixes 0x1e/0x16/0x9e verified from chainparams.cpp
- [x] Solana network adapter (@shiba-wallet/chains-solana): legacy message
      compile/serialize (compact-u16, header, account ordering), System
      Program transfer, ed25519 signing, vendor-neutral RPC client
      (getLatestBlockhash/getBalance/sendTransaction/getSignatureStatuses
      polling); 27 tests, message bytes and signatures byte-identical to
      @solana/web3.js 1.99.0
- [x] Test suite w/ official vectors (SLIP-0010 both vectors, BIP-84
      addresses; EVM cross-checked vs ethers.js, Solana vs ed25519-hd-key;
      Dogecoin version byte 0x1e verified from dogecoin/dogecoin
      chainparams.cpp) — 22 tests passing
- [x] React Native app shell — app/ (Expo SDK 57, TypeScript, React
      Navigation native stack). Deliberately NOT a workspace member:
      consumes @shiba-wallet/core via a file: dependency (npm symlink) plus
      metro.config.js watchFolders/nodeModulesPaths (see app/README.md).
      Screens: onboarding (generate mnemonic via core + backup warning +
      2-word quiz, or import with validation), Home (account-0 addresses for
      ETH/BTC/DOGE/SOL derived through core providers), Receive (full
      address + copy), Settings (gated seed reveal, double-confirm wipe).
      Mnemonic lives only in expo-secure-store
      (WHEN_UNLOCKED_THIS_DEVICE_ONLY); crypto.getRandomValues polyfilled
      from expo-crypto in app/src/polyfills.ts (first import). Verified:
      tsc --noEmit clean; npx expo export --platform android bundles
      884 modules with engine code confirmed inside the Hermes bundle
- [x] Send flow in the app (phase 2, task 2) + biometric gating (task 7):
      app/src/wallet/send.ts (pure engine glue: recipient validation via
      engine code — EIP-55 through core toChecksumAddress, UTXO through
      addressToScriptPubKey, SOL base58→32 bytes; fee quotes — EVM
      suggestFees+estimateGas with endpoint chain-id verification, BTC/DOGE
      Esplora GET /fee-estimates verified against the Esplora API docs, SOL
      getFeeForMessage verified against solana.com/docs/rpc with a flagged
      5000-lamports-per-signature fallback; max-amount helpers; EOA
      sign+broadcast with a marked SmartAccountClient seam), parseUnits in
      balances.ts (exact bigint, tested in app/scripts/test-units.mjs — 45
      cases incl. EIP-55 vectors and taproot rejection), SendScreen
      (form→confirm→success in one screen, "Mainnet — real funds" badge,
      eth_call pre-flight blocks the EVM send unless explicitly overridden,
      dust + insufficient-funds errors in plain language, explorer links
      etherscan.io/blockstream.info/solscan.io, DOGE validates but shows
      "sending unavailable" without an endpoint), expo-local-authentication
      gating both the Settings seed reveal and the final send confirm (only
      when hardware+enrollment exist; disableDeviceFallback:false so the OS
      passcode fallback works; matrix in app/src/wallet/biometric.ts).
      Verified: tsc --noEmit clean; expo export --platform android bundles
      with the new strings confirmed inside the Hermes bytecode. No real
      transaction was broadcast.

## Key decisions (ADRs D1–D7 live in docs/ARCHITECTURE.md section 7)

- D1: Single BIP-39 mnemonic is the root of all assets, including the ERC-4337
  smart-account owner key. Smart accounts are counterfactual contracts whose
  owner EOA key derives from the seed, so one seed phrase recovers everything.
- D2: Core library is pure TypeScript, no React/native deps, so the same code
  serves mobile, extension, or CLI later (flexibility requirement).
- D3: Chain support via a `ChainAdapter` interface + registry keyed by
  SLIP-44 coin type / CAIP-2 chain id, so thousands of chains can register
  without touching core.

## Known blockers

- None currently. Network access for npm assumed; verify on first install.

## Phase 1 complete (2026-09-27)

Engine (4 packages, 120 tests, every cryptographic path validated against
official vectors or an independent implementation), leadership docs
(FEATURE_UNIVERSE.md published as a shareable page for the Chairperson:
https://claude.ai/artifact/JEfyMuPcMJ8YW5x3ZKitsw, plus ARCHITECTURE.md
with ADRs D1–D7), offline end-to-end demo (examples/demo.mjs, run with
`node examples/demo.mjs` after `npm run build`), and the Expo app shell.

## Phase 2 progress

- [x] SPL token transfers in chains-solana (phase 2 task 5): PDA derivation
      (sha256(seeds || bump || programId || "ProgramDerivedAddress"), bump
      255 down to 1, off-curve check via noble ed25519 — algorithm verified
      against web3.js 1.99.0 createProgramAddressSync/findProgramAddressSync
      source), ATA derivation ([owner, tokenProgram, mint] under
      ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL, seed order verified from
      solana-program/associated-token-account interface sources),
      TransferChecked (tag 12 + u64 LE amount + u8 decimals, account order
      from solana-program/token instruction.rs), idempotent create-ATA
      (discriminant 1), buildSplTransfer composer with optional recipient
      ATA creation. 17 new tests (44 total in the package): ATA addresses
      equal spl-token getAssociatedTokenAddressSync incl. an off-curve PDA
      owner; full transfer transactions byte-identical (message bytes,
      signatures, wire) to web3.js + @solana/spl-token 0.4.15, with and
      without the create-ATA instruction

## Phase 2 scorecard (2026-09-27)

- [x] Task 1 — live native balances on Home (see checked entry above).
      The remaining ERC-20 balance-display slice landed in phase 3 task 2
      (see Phase 3 progress).
- [x] Task 2 — send flow for all four chains (app/src/wallet/send.ts,
      SendScreen with form/confirm/success, per-chain validation through
      engine code, exact bigint parseUnits, fee quotes verified against
      Esplora and Solana RPC docs, EVM pre-flight simulation with decoded
      revert reasons, max buttons, mainnet warning badge). EVM sends take
      the EOA path; the SmartAccountClient seam in send.ts is marked and
      waits on a bundler endpoint (task 3 vendor config).
- [x] Task 3 — AA stack selection recorded in docs/AA_STACK.md (EntryPoint
      v0.7 pinned; SimpleAccount for testnet, ERC-7579 modular account as
      production target; factory addresses are per-chain config with a
      mandatory on-chain verification procedure; bundler/paymaster vendor
      criteria set). Vendor endpoints themselves are still unconfigured.
- [x] Task 4 — EIP-1559 EOA transactions in chains-evm (RLP encoder,
      type-2 signing byte-identical with ethers.js, NodeClient with fee
      suggestion/nonce/broadcast). 46 tests in chains-evm.
- [x] Task 5 — SPL token transfers in chains-solana (see checked entry
      above). 44 tests in chains-solana.
- [~] Task 6 — first slice done: eth_call pre-flight with revert decoding
      (Error(string), Panic codes, custom errors) in chains-evm, used by
      the app's send flow. Full asset-diff simulation remains.
- [x] Task 7 — biometric gating (expo-local-authentication) on the seed
      reveal and send confirmation, passcode fallback enabled; matrix in
      app/src/wallet/biometric.ts. Note: FaceID needs a dev build, not
      Expo Go.
- [x] Task 8 — testnet smoke test RAN 2026-09-27 with real broadcasts,
      engine-built transactions only:
      * Sepolia: CONFIRMED on-chain, tx 0x45eb0026adcc1ec6ccad6e469c4023
        cd8e321d5f217b43542dfcbd6f0a9a5295, block 11794658, status 0x1
        (EIP-1559 self-send, 21000 gas).
      * Bitcoin testnet3: accepted by the network, txid 1469f4cc214fcc52
        66fb68070a920e33bfd7d07b66128088af5a9ba420cf4424 (P2WPKH
        self-send, 282 sat fee @ 2 sat/vB; chained off the unconfirmed
        faucet UTXO). The Chairperson's faucet used testnet3, so the
        harness now checks every Bitcoin test network (BTC_ESPLORAS in
        scripts/testnet/config.mjs) and spends where the coins are.
      * Solana devnet: still unfunded — the RPC airdrop faucet 429s from
        this IP; re-run smoke.mjs after funding via faucet.solana.com or
        the solana CLI from another machine.
      * ERC-4337 leg: PASSED 2026-09-27 with the Chairperson's Alchemy
        key (stored ONLY in git-ignored .dev-wallet/env — never commit
        it; the same endpoint serves node + bundler methods, verified by
        probe). SimpleAccountFactory-compatible factory
        0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985 passed the AA_STACK
        on-chain verification (impl 0x68641de71cfea5a5d0d29712449ee254
        bb1400c2, entryPoint() == v0.7). Smart account deployed at the
        engine-predicted counterfactual address
        0xB8370410CCFc0c8A6069a60ccFBeb6D2e2130fa2 via a SELF-BUNDLED
        handleOps EIP-1559 tx from the dev EOA (tx 0x0e6d94bd80ecfa25b4
        b8a5042572e20eea9499dd3f8a2829a96cc0893fa96921, block 11795645,
        status 0x1) after Alchemy's off-chain simulation rejected the
        deployment op with AA13 even though EntryPoint.handleOps
        accepted it in eth_call (documented rundler strictness; ERC-4337
        permits self-bundling). Post-deployment UserOperation THROUGH
        Alchemy's bundler succeeded: userOpHash 0x4191228b0a53eabed473
        06ff4b671cd13d65ade12268969409203b4664d7f8a8, receipt
        success=true. Bundler quirks now handled: priority-fee floor
        (>= 0.1 gwei regardless of chain fees) and a verification-gas
        efficiency guard (used/limit >= 0.4, so padding must stay
        modest); SmartAccountClient gained an optional gasPaddingPct
        config. Recovery invariant D1 proven on a live network.
      * Dogecoin: blocked on infrastructure (no public Esplora API).

## Phase 3 progress

- [x] Task 2 — ERC-20 balance display + token management (EVM mainnet
      only this pass): app/src/wallet/tokens.ts (tracked list persisted in
      AsyncStorage via core AssetRegistry toJSON/fromJSON, CAIP-19 keyed,
      injectable KeyValueStore so Node exercises the exact store code;
      missing key = default [USDC], present key = user's list verbatim so
      removing USDC sticks), app/src/wallet/erc20.ts (USDC_MAINNET
      0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 verified 2026-09-27 from
      Circle's contract-addresses docs page + Etherscan token page + live
      eth_call symbol()="USDC"/decimals()=6/name()="USD Coin"; metadata
      reads via engine encodeFunctionCall/decodeUint256; app-side ABI
      string decoder with hand-rolled RFC-3629 UTF-8 validation that
      throws on legacy bytes32 metadata instead of mis-decoding),
      TokensScreen (add flow: EIP-55 validation reusing send.ts's
      validateRecipient, auto-fill via eth_call, manual symbol/name
      fallback for bytes32 tokens, decimals always from chain, confirm
      before add, duplicates rejected, everything removable incl. USDC),
      Home token rows under Ethereum (balanceOf via encodeErc20BalanceOf +
      decodeUint256, same per-row retry discipline, in pull-to-refresh,
      reloaded on focus). Tokens are display-only: no token send UI.
      tsconfig gained allowImportingTsExtensions (Node type-stripping
      needs explicit .ts on relative imports in Node-exercised modules).
      Verified: tsc --noEmit clean; expo export --platform android bundles
      (new strings confirmed in Hermes bytecode); scripts/check-tokens.mjs
      27/27 (decoder edge cases, store semantics, live USDC reads).

- [x] Task 6 — Activity screen (app side; engine-side history providers
      landed earlier in commit bbddf42): app/src/wallet/history.ts (thin
      glue keyed on NetworkKind: Bitcoin → esploraHistoryProvider over the
      configured Esplora endpoint, Dogecoin same shape but unavailable
      until an endpoint is configured, Solana → solanaHistoryProvider over
      the configured RPC with enrichLimit 8, Ethereum → explicit honest
      "unavailable: needs an indexer/explorer" state with the branch ready
      for the future log-based provider; also explorerTxUrl reusing the
      send flow's verified explorers, directionLabel, Intl-free
      formatTimestamp; no runtime cross-file imports so Node type-stripping
      loads it directly), app/src/wallet/useHistory.ts (per-chain
      loading/error/retry/unavailable discipline like useBalances,
      generation counter, cursor pagination with in-flight serialization
      and dedupe-by-txid across the Esplora mempool/confirmed page
      boundary), ActivityScreen (newest-first FlatList: direction badge
      in/out/self with distinct color/glyph, exact-bigint formatUnits
      amounts with em-dash for unenriched entries, fee line, pending +
      failed chips, relative/absolute time, infinite scroll plus explicit
      Load more, pull-to-refresh, row tap opens etherscan/blockstream/
      solscan — Dogecoin rows stay inert, no verified explorer), entered
      from an Activity link on every Home chain row; route Activity
      {chainId} in the native stack. Verified: tsc --noEmit clean; expo
      export --platform android bundles (new strings confirmed in the
      Hermes bytecode); scripts/check-history.mjs live against
      blockstream.info/api + api.mainnet-beta.solana.com with the standard
      test mnemonic: 25 BTC entries classified, page 2 fetched via
      nextCursor with 0 overlap, Solana entries incl. correctly-flagged
      failed spam txs.

- [x] Candidate 3 — ERC-4337 smart-account send path in the app, behind an
      explicit experimental toggle, OFF by default (EOA path untouched):
      app/src/wallet/aa.ts (per-EVM-chain bundler URL + SimpleAccountFactory
      config in AsyncStorage under shiba-wallet.aa-config.v1, empty by
      default; save REFUSES to persist unless verification passes, so
      configured == verified by construction — factory checks are exactly
      scripts/testnet/aa-smoke.mjs verifyFactory (factory has code,
      accountImplementation() has code, its entryPoint() == ENTRYPOINT_V07)
      run against the configured node RPC, bundler check is
      eth_supportedEntryPoints must include v0.7; also createAaClient
      (SmartAccountClient + createSimpleAccountSpec, no paymaster — the
      smart account pays its own gas), prepareAaSend (chain-id guard,
      counterfactual sender via the spec's getAddress with an address-only
      owner stand-in so no key material is resident at quote time,
      deployment state, smart-account balance, fee from bundler
      eth_estimateUserOperationGas over a stub-signed op, insufficient-funds
      refusal against the SMART ACCOUNT balance), sendAa
      (SmartAccountClient.sendCalls through the send.ts seam; signer
      re-derived via WalletContext.signWith), waitForAaReceipt +
      summarizeAaReceipt (defensive, bundler-dependent shape: nested
      receipt.transactionHash per the ERC-4337 spec shape, flattened
      top-level fallback, hex/bool success, strict 32-byte-hash pattern,
      null — never a fabricated value — otherwise). SettingsScreen gained
      an "Account Abstraction (experimental)" section (per-EVM-chain
      bundler/factory fields, Verify & save with in-progress state,
      "Not saved — verification failed" alerts, verified-✓ status lines
      showing the implementation address and check date, Clear buttons).
      SendScreen shows a "Send from smart account" toggle (default off,
      EXPERIMENTAL tag, plain-language explanation, Max disabled on the AA
      path) only when both endpoints are configured+verified; AA confirm
      screen shows the counterfactual sender, ITS balance, deployed/"will
      deploy with this send", bundler-estimated worst-case fee, no-paymaster
      note; biometric gate unchanged; success screen shows the userOpHash
      with a "Bundling…" receipt poll (120 s), then included/reverted state
      and an etherscan link only when a real transactionHash was found in
      the receipt. send.ts changed only at the marked SMART-ACCOUNT SEAM
      comment. No packages/* changes. Verified offline with FAKE transports
      only (nothing signed or broadcast live): app/scripts/check-aa.mjs
      39/39 (config round-trip incl. corrupt storage, all four factory/
      bundler reject cases persist nothing, counterfactual resolution, full
      stub→estimate→sign→send pipeline yielding the userOpHash with real
      seed-derived signature, receipt-shape matrix); tsc --noEmit clean;
      expo export --platform android bundles (new strings confirmed in the
      Hermes bytecode). Live ERC-4337 smoke remains candidate 1 (needs
      bundler API key + funds).

- [x] Candidate 5 — WalletConnect v2 (Tier 1 feature 78), eip155:1 only
      this pass. SDK reality verified before coding (2026-09-27):
      WalletConnect rebranded to Reown; the current wallet-side SDK is
      @reown/walletkit (1.6.0, published 2026-09-14) and the legacy
      @walletconnect/web3wallet is deprecated on npm ("Web3Wallet is now
      Reown WalletKit"). Installed per the official RN guide
      (docs.walletconnect.com/wallets/react-native/installation.md +
      usage.md — note docs.reown.com now 404s its old walletkit paths):
      @walletconnect/react-native-compat 2.25.0 (must load before any
      @reown/* module; both are dynamically imported in that order inside
      initWalletConnect, so app startup and Node scripts never evaluate
      them), netinfo 12.0.1, react-native-get-random-values,
      fast-text-encoding, expo-application, @walletconnect/jsonrpc-types
      (types), @noble/hashes (now a declared direct dep). Expo Go:
      expected to work — netinfo 12.0.1 and expo-application are bundled
      in the Expo Go SDK 57 client (verified in expo/expo
      apps/expo-go/package.json, sdk-57 branch) and
      react-native-get-random-values installs nothing when
      crypto.getRandomValues exists (source-verified guard; our
      expo-crypto polyfill loads first) — but UNVERIFIED against a live
      relay: that needs a free Reown project id (dashboard.reown.com),
      which the user must create (no service sign-ups) and save in
      Settings → WalletConnect (AsyncStorage, aa.ts store pattern; the
      feature is off with a plain explanation until then).
      app/src/wallet/walletconnect.ts: pure logic (namespaces via the
      SDK's buildApprovedNamespaces from the wallet's EOA, request
      routing with proper getSdkError declines — 5000/5100/5101 — and
      never a timeout, general EIP-191 digest checked against
      ethers.hashMessage AND the engine's toEthSignedMessageHash,
      EIP-712 via the engine's typedDataDigest with strict domain policy:
      foreign domain chainId, unknown domain fields, or a
      non-canonically-declared EIP712Domain type are declined rather than
      ambiguously signed, eth_sendTransaction mapping that requires
      `to` + our `from` and deliberately ignores dApp gas/fee/nonce)
      plus the lazy SDK lifecycle. ConnectionsScreen: paste-URI pairing
      (QR scanning deferred — needs expo-camera; same camera/design pass
      as Receive's QR), active session list with peer metadata +
      disconnect, approval modal for proposals (dApp name/url/chains/
      methods) and requests (decoded message when printable UTF-8, typed
      data with domain + pretty message, transactions in the send-confirm
      presentation: mainnet badge, fee/total, eth_call simulation with
      the block-unless-overridden switch); EVERY approval passes the
      biometric gate, signing keys only via WalletContext.signWith.
      eth_sendTransaction rides prepareEvmSend/sendEvm, which gained an
      optional calldata parameter — the only send.ts change (backward
      compatible; quote carries data through estimateGas, eth_call and
      signEip1559). Settings gained the WalletConnect section; routes:
      Connections in the native stack. No packages/* changes. Verified:
      scripts/check-wc.mjs 83/83 offline (fake WalletKit client + fake
      global fetch; no relay contact; digests byte-identical to ethers,
      signatures recovered by ethers.verifyMessage/verifyTypedData,
      broadcast raw tx decoded via ethers.Transaction.from and checked
      field by field incl. calldata and recovered sender); check-aa.mjs
      39/39 and test-units.mjs 45/45 still green; tsc --noEmit clean;
      expo export --platform android bundles 1709 modules (5.3MB Hermes,
      up from 884 — WalletKit's dependency tree) with the new strings
      confirmed in the bytecode.

## Next recommended tasks (phase 3 candidates)

1. Run the testnet smoke once funds land; then the ERC-4337 smoke against
   a real bundler (needs API key), including counterfactual deployment of
   a SimpleAccount on Sepolia per docs/AA_STACK.md verification steps.
2. ~~ERC-20 balance display + token management UI (AssetRegistry-backed)~~
   — DONE (see Phase 3 progress). Remaining slice: token sending (engine
   transfer calldata exists; needs send-flow UI + simulation).
3. ~~Wire the smart-account send path in the app behind a feature flag~~
   — DONE (see Phase 3 progress, candidate 3). Remaining slices: exercise
   it live against a real bundler (candidate 1), paymaster sponsorship
   (ERC-7677 fields are ready on SmartAccountClient), AA-path Max button.
4. Full simulation (asset diffs) and approval-revocation groundwork.
5. ~~WalletConnect v2 integration (Tier 1 feature 78)~~ — DONE for
   eip155:1 (see Phase 3 progress, candidate 5). Remaining slices: a live
   pairing test (needs a free Reown project id created by the user at
   dashboard.reown.com and saved in Settings), QR scanning (expo-camera,
   the shared camera/design pass), additional chains in the namespaces,
   and a global session-request listener so approvals surface outside the
   Connections screen.
6. ~~Activity/history screen (Tier 1 feature 90)~~ — DONE (engine
   providers + app Activity screen; see Phase 3 progress). Remaining
   slice: EVM history once an indexer-backed provider exists (the app
   glue's evm-jsonrpc branch is the marked seam).
