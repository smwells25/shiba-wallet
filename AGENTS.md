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
   pattern). Features like staking are valuable where it intersects AA.
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
- [x] Task 6 — eth_call pre-flight with revert decoding (Error(string),
      Panic codes, custom errors) in chains-evm, used by the app's send
      flow; full asset-diff simulation completed in phase 6 item 1
      (eth_simulateV1, see Phase 6 progress).
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
      * Solana devnet: PASSED 2026-09-27 after the Chairperson funded
        5.5 SOL — engine-built System transfer broadcast and FINALIZED,
        signature W4h7QK37Sv3JNK2frBfdh21Uw4asyRqdifKSANBLa8C1dFX4H3iS
        LA8RiNP5E4vuXc7abZ36xNNjciE9srNrmfb; the network-returned
        signature matched the locally computed txid. (Smoke-script bug
        fixed on the way: SolanaRpcClient.sendTransaction takes wire
        bytes, not the base64 string.) Sepolia and Bitcoin testnet3 legs
        re-ran and passed again in the same run.
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
      * Dogecoin: infrastructure UNBLOCKED 2026-09-27 — the Chairperson's
        NOWNodes key (git-ignored .dev-wallet/env, NOWNODES_KEY) works
        against dogebook.nownodes.io and dogebook-testnet.nownodes.io
        through the engine's blockbookTransport (live getUtxos verified
        on both). smoke.mjs gained a Dogecoin-testnet leg that runs
        whenever testnet DOGE lands on the dev address printed by
        setup.mjs; the app can use the same transport once an endpoint
        + key UI slice is added.

## Known untested remainder (recorded 2026-09-27, accepted by the Chairperson)

- RESOLVED 2026-10-03 (see the Dogecoin mainnet demonstration record
  at the end of this file): one real MAINNET self-send was broadcast and
  confirmed. Original entry kept for history:
- Dogecoin testnet BROADCAST has never been executed: every public
  testnet-DOGE faucet tried was dead (faucet.doge.toys returns
  "transfer error"; faucet.triangleplatform.com reports the service
  suspended). Mitigations that bound the residual risk: the Dogecoin
  signing path (legacy P2PKH sighash, version byte 0x71 testnet / 0x1e
  mainnet) is byte-identical to bitcoinjs-lib in the chains-utxo test
  suite; the Bitcoin path sharing the same code was broadcast-proven on
  testnet3 twice; and the NOWNodes Blockbook read path (getUtxos) was
  verified live on both Dogecoin mainnet and testnet. The armed
  smoke-leg in scripts/testnet/smoke.mjs runs automatically if tDOGE
  ever arrives at the dev address. Before any MAINNET Dogecoin send
  ships to users, do one real broadcast (worst case: a tiny mainnet
  self-send costing ~1 DOGE in fees).
- ERC-4337 deployment ops through Alchemy's bundler specifically: the
  bundler rejects deployment ops for the verified Sepolia factory with
  AA13 although the EntryPoint accepts them (self-bundling covered it).
  Retest with other bundlers/factories during vendor selection.
- Live WalletConnect pairing (needs a phone running the app; project id
  is shipped as default).
- FaceID prompt behavior (needs a development build; Expo Go cannot).

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
   providers + app Activity screen; see Phase 3 progress). The remaining
   EVM slice landed in phase 4 task 1 (indexer-backed provider wired to
   the evm-jsonrpc seam; see Phase 4 progress).

## Phase 4 plan (approved to start 2026-09-27): the daily-driver phase

Goal: close the gaps between "engine proven on-chain" and "a wallet a
person can actually live in", using only resources already in hand.

1. ~~EVM transaction history via a configurable indexer endpoint~~ —
   DONE 2026-09-27 (see Phase 4 progress).
2. Blockbook history provider in chains-utxo (Blockbook's address-txs
   API), so Dogecoin gets Activity parity the moment an endpoint is
   configured — and Bitcoin users can choose Blockbook backends too.
3. ~~ERC-20 token sending in the app~~ — DONE 2026-09-27 (see Phase 4
   progress). Tokens are no longer display-only.
4. ~~QR support: show a QR on Receive and scan QR codes for WalletConnect
   pairing and send-recipient entry~~ — DONE 2026-09-27 (see Phase 4
   progress).
5. ~~App-lock polish~~ — DONE 2026-09-27 (see Phase 4 progress).
6. ~~Sepolia testnet mode behind a developer toggle~~ — DONE 2026-09-27
   (see Phase 4 progress).
7. Swap groundwork (engine only this phase): a vendor-neutral
   SwapQuoteProvider interface with one adapter compiled against a real
   aggregator's documented API but exercised via fakes until a key
   exists; no UI commitment yet.

## Phase 4 progress

- [x] Task 1 — EVM transaction history via a configurable indexer
      endpoint. API shapes verified BEFORE coding against
      www.alchemy.com/docs/reference/alchemy-getassettransfers (+ the
      transfers-api-quickstart page: pageKey has a 10-minute TTL and is
      omitted when exhausted) and confirmed with one live read-only probe
      (uniqueId observed as "<hash>:log:<n>" / "<hash>:internal:<n>",
      pageKey a UUID, rawContract.value exact hex). Engine:
      packages/chains-evm/src/indexer-history.ts — indexerHistoryProvider
      implements core's HistoryProvider over any injected JsonRpcTransport
      serving alchemy_getAssetTransfers (vendor-named method, vendor-
      neutral construction); two queries per page (fromAddress=me,
      toAddress=me, all five categories, withMetadata for timestamps,
      excludeZeroValue:false), merged newest-first, self-transfers deduped
      by uniqueId; opaque cursor JSON-encodes the two directions' pageKeys
      (an exhausted direction is never re-queried). PRECISION: amounts
      come ONLY from rawContract.value (exact hex wei) — the API's `value`
      is a float (live probe returned 4e-18) and is never used; no
      rawContract.value → no amount, never an approximation. Token
      categories (erc20/721/1155) map to amount-less entries carrying the
      API's asset symbol; failed-tx detection is NOT available from this
      API (documented — reverted txs simply never appear). Core
      HistoryEntry gained two additive optional fields: uid (one EVM tx
      can yield several entries — e.g. external + internal legs — so list
      keys/dedupe use uid, explorer links keep id) and assetSymbol.
      verifyTransfersEndpoint exported for save-time checks. App:
      src/wallet/indexer.ts (AsyncStorage config, aa.ts verify-before-save
      pattern: eth_chainId must match the chain AND a maxCount-0x1
      transfers probe must return a well-formed response, else nothing
      persists; the URL usually embeds the user's API key — on-device
      runtime config only, never committed), Settings gained an "Ethereum
      history indexer" section, history.ts's evm-jsonrpc seam now takes
      the indexer URL (honest unavailable note, now pointing at Settings,
      when unconfigured), useHistory re-reads the config each reload and
      dedupes by uid, ActivityScreen keys rows by uid and shows the token
      symbol with an em-dash amount for token entries. Verified: 13 new
      engine tests (68 total in chains-evm, all suites 186 green),
      engine tsc clean; app tsc --noEmit clean; expo export bundles;
      app/scripts/check-indexer.mjs 19/19 — offline store discipline plus
      LIVE two-page pagination for the standard test address
      0x9858...da94 through the app glue (49 + 50 entries classified,
      0 uid overlap; endpoint masked, key only in git-ignored
      .dev-wallet/env).

- [x] Task 3 — ERC-20 token sending (Ethereum mainnet, EOA path). New
      module app/src/wallet/send-erc20.ts (own module, not send.ts, so the
      import graph stays a DAG: it needs erc20.ts's fetchErc20Balance and
      erc20.ts already imports from send.ts): prepareErc20Send (endpoint
      chain-id check, token-balance check, ETH-balance-covers-fee check
      with a plain-language error, eth_estimateGas on the engine's
      encodeErc20Transfer calldata with a documented 100k fallback when
      estimation itself reverts, simulateCall pre-flight), maxErc20Send
      (max = full token balance since gas is paid in ETH; refuses when the
      ETH balance cannot cover the worst-case fee), sendErc20 (reshapes
      into an EvmSendQuote — value 0, to = token contract, data = transfer
      calldata — and delegates to the existing sendEvm, so there is no
      second signing path). ERC-20 return-value quirk handled honestly and
      documented in erc20TransferReturnedFalse: a zero-word return from
      the simulation means transfer() returned false (the tx would mine,
      charge gas, move nothing) and blocks behind the same override switch
      as a revert; USDT-style empty return data ("0x") is normal and never
      treated as failure. SendScreen token mode (route param tokenId,
      CAIP-19 id resolved against the tracked-token store): identical EVM
      recipient validation, amounts parsed with the token's on-chain
      decimals, fee displayed in ETH alongside the token amount, confirm
      shows token amount + symbol / recipient / token contract / ETH fee /
      both balances, mainnet badge and biometric gate unchanged, success
      shows txid + etherscan link. Smart-account toggle hidden in token
      mode with a note (AA token sends — batched approve+transfer — are a
      later slice). Home token rows and the Tokens screen both link into
      token mode; describeSendError gained token-aware branches so an ETH
      fee shortfall is never titled with the token's symbol. Verified:
      app/scripts/check-token-send.mjs 37/37, fully offline via a fake
      JSON-RPC node behind global fetch (calldata equals hand-built ABI
      bytes, fee-in-wei vs amount-in-token-units math, zero-word blocking
      vs empty-return passing, max + insufficient-ETH refusal, offline
      sign+broadcast asserting the raw tx targets the contract and carries
      the calldata); tsc --noEmit clean; expo export --platform android
      bundles with the new strings confirmed in the Hermes bytecode. No
      real transaction was broadcast.

- [x] Task 4 — QR support (render + scan), verified to work in Expo Go
      SDK 57 BEFORE coding: react-native-svg 15.15.4 and expo-camera are
      both bundled in the Expo Go client (expo/expo repo,
      apps/expo-go/package.json, sdk-57 branch — same check as the WC
      deps), and expo-camera 57.0.5's API (CameraView,
      useCameraPermissions, barcodeScannerSettings {barcodeTypes:['qr']},
      onBarcodeScanned → BarcodeScanningResult.data) was confirmed against
      both docs.expo.dev/versions/v57.0.0/sdk/camera and the installed
      package's own .d.ts; the deprecated expo-barcode-scanner is not
      used. Receive renders the plain address (no invented URI — the
      screen never built payment URIs) via react-native-qrcode-svg 6.3.26
      (pure JS over react-native-svg, encoder = qrcode 1.5.4) on a white
      quiet-zone card that stays white in dark mode. Scanning: shared
      full-screen modal app/src/components/QrScanner.tsx (permission
      requested only on open with a plain-language rationale; denial →
      calm note, paste always works; once-per-open delivery guard).
      SendScreen recipient row gained Scan in both native and token modes:
      payloads go through app/src/wallet/scan.ts extractScannedAddress —
      strips ONLY the active chain's scheme (ethereum: per EIP-681 incl.
      pay-/@chain_id//function, verified at eips.ethereum.org/EIPS/eip-681;
      bitcoin:/dogecoin: per BIP-21; solana: per Solana Pay; address cut
      at '?'), everything else passes through untouched so the existing
      engine-backed validation rejects it — scanning can never widen
      validation. ConnectionsScreen gained Scan QR code feeding the exact
      pasting path (validatePairingUri → pair via one shared pairWith).
      app.json: expo-camera plugin with a plain NSCameraUsageDescription
      rationale (dev builds; Expo Go uses its own manifest permission).
      Verified: app/scripts/check-qr.mjs 31/31 offline — the exact
      encoder call the screen uses (QRCode.create ecl 'M', per
      react-native-qrcode-svg/src/genMatrix.js) round-tripped through the
      independent jsqr decoder (devDependency, script-only) for all four
      chains' derived addresses + a wc: URI, a corruption check, a
      scan.ts↔send.ts chain-id drift pin, and 23 parsing edge cases;
      tsc --noEmit clean; expo export --platform android bundles with the
      new strings confirmed in the Hermes bytecode. Live camera scanning
      cannot be exercised headless — on-device checklist is in the task
      report (scan each chain's QR, a URI-wrapped QR, a wrong-chain QR
      must show the normal validation error, WC pairing scan, permission
      deny/re-allow flow).

- [x] Task 2 — Blockbook history provider in chains-utxo
      (blockbookHistoryProvider over GET /api/v2/address details=txs with
      page/pageSize pagination, string values, isAddress filtering, same
      in/out/self rules as the Esplora provider), live-verified against
      Dogecoin mainnet through a keyed Blockbook instance. Committed in
      09e1ec0.

- [x] Task 7 — swap groundwork (engine only): vendor-neutral
      SwapQuoteProvider + 0x Swap API v2 allowance-holder adapter
      (documented headers/params/response cited from docs.0x.org, exact
      bigint amounts, no-liquidity distinguished from errors, API key
      strictly injected). Fakes-only until a key exists. Committed in
      cdd7ee2.

- [x] Tasks 5 + 6 — app lock and Sepolia developer mode. Item 5:
      app/src/wallet/lock.ts (pure auto-lock state machine: background/
      inactive flap-proof away-timer, lock-on-return iff threshold
      reached, null threshold = off, backwards-clock clamped; documented
      DELIBERATE NO-PIN DECISION — unlock is requireLocalAuth whose OS
      passcode fallback is strictly stronger than any homemade JS PIN
      pad; devices without biometrics hide the setting with a note),
      LockGate overlay component (no navigation reset — screen state
      survives), balance-privacy toggle masking amounts on Home/tokens/
      Activity with a quick eye icon, clipboard notes where addresses
      are copied. Item 6: app/src/config/evm-chain.ts is the ONE config
      source for the active EVM chain (mainnet default; Sepolia profile
      behind Settings → Developer): numeric chain id for send.ts/
      indexer.ts/aa.ts endpoint verification, default RPC, explorer
      base, WalletConnect namespace chain, TESTNET banner, and the
      pinned live-verified ERC-4337 defaults (EntryPoint v0.7 +
      factory 0x91E6...8985/impl 0x6864...00C2 from the on-chain smoke;
      bundler URLs stay runtime config — they embed keys). Modes never
      mix: every per-chain store is keyed by the active profile's CAIP-2
      id, and chain-id verification refuses mismatched endpoints.
      Prefs (dev mode, privacy, auto-lock threshold) in
      app/src/config/prefs.ts + PrefsContext, AsyncStorage, injectable
      store. Verified: scripts/check-devmode.mjs 69/69 (lock
      transitions, masking, active-chain switching incl. fake-node
      chain-id refusals both directions, AA prefill pinned equal to the
      engine's ENTRYPOINT_V07); full regression suite all green
      (test-units 45, check-aa 39, check-wc 83, check-token-send 37,
      check-qr 31, check-tokens 27); tsc --noEmit clean; expo export
      bundles. Session note: this task's agent was twice interrupted by
      session rate limits; the CTO ran the final verification pass and
      wrote this entry from the delivered code.

Sequencing: 1+2 first (history completes the read side), then 3+4
(write side + capture), then 5+6, with 7 riding alongside as engine
work. Live-fire retests (Dogecoin broadcast, WC pairing, FaceID) happen
opportunistically as inputs appear.

## Phase 4 complete (2026-09-27)

All seven items landed. Remaining live verification is on-device only
(cameras, FaceID, WalletConnect relay pairing, Sepolia dev-mode walk-
through) and is listed in the task reports plus the known untested
remainder above.

## Emulator validation (2026-09-27, autonomous — no physical phone)

Environment built from scratch on the Intel Mac: Temurin JDK 21, Android
cmdline-tools (mac-15641748), platform-tools, emulator, android-34
google_apis x86_64 image, AVD "shiba" (Pixel 7 profile, virtualscene
back camera, swiftshader GPU). The app runs in Expo Go SDK 57 served by
the local Metro dev server; the session drove it entirely through adb
input taps and screencap screenshots (the agent can see every screen).
The emulator's virtual-scene camera poster (Toren1BD.posters + a PNG
generated by the app's own QR encoder) provides a scannable QR without
any physical camera.

PASSED, with screenshots reviewed at every step:
- Welcome screen renders (non-custodial pitch, both CTAs).
- Create-wallet onboarding: 12-word backup screen with the full-sentence
  warning; 2-word confirmation quiz answered correctly; landed on Home.
- Home: all four chains with freshly derived addresses, LIVE balances
  from the real default RPCs (ETH/BTC/SOL 0, live-fetched), USDC token
  row, Manage tokens link, Dogecoin honest "no endpoint" state.
- Balance privacy toggle: amounts masked to bullets, link flips to
  "Show amounts".
- Send ETH screen: Mainnet label, Scan button, fee-transparency note.
- Camera permission flow: in-app rationale screen -> OS dialog (Expo
  Go's own manifest string, as documented) -> camera opens.
- END-TO-END QR SCAN: the virtual-scene poster QR (encoding the
  standard test address 0x9858...da94) was detected by CameraView,
  passed through extractScannedAddress and EIP-55 validation, and
  filled the recipient field. The scanner modal closed itself (once-
  per-open guard held).

FINDING (follow-up filed): the recovery-phrase Backup screen allowed a
screenshot — expo-screen-capture prevention is not wired. Add
preventScreenCaptureAsync (and FLAG_SECURE in dev builds) around the
seed-display and seed-reveal screens in a future slice.

Known first-launch quirk, documented: on the very first Expo Go launch
the bundle raced Expo Go's own self-update and crashed with a spurious
"[runtime not ready] EventEmitter" error; a clean reload fixed it and
it did not recur. Emulator-side only; not app code.

Still emulator-pending (next session can continue with the same AVD):
wrong-chain QR rejection (swap the poster), Receive-screen QR display,
Activity screens, fingerprint enrollment + auto-lock + biometric-gated
send, Sepolia dev-mode walkthrough, WalletConnect live pairing (needs a
dApp URI). Physical-phone-only remainder: real Secure Enclave/StrongBox
behavior, real camera optics, iOS FaceID, store builds.

## Emulator validation, continued (same session)

Additional PASSES with screenshots reviewed:
- Receive ETH: QR + full address + derivation path + copy/send buttons;
  the on-screen QR was decoded from the screenshot with the independent
  jsqr decoder and matched the displayed address exactly.
- Activity: Bitcoin queried live Esplora and showed the correct empty
  state for a fresh address; Ethereum showed the honest
  indexer-required explanation.
- Settings: recovery-phrase button present; Hide-amounts toggle state
  synced from the Home eye tap; the auto-lock section correctly hides
  itself on an unenrolled device with the documented no-PIN rationale;
  endpoint, indexer, and AA sections render their full explanations
  with correct not-set/incomplete statuses; the shipped WalletConnect
  project id shows as saved.
- Sepolia test mode toggle: TESTNET banner appears, mainnet-token rows
  hide with an explanatory note, mode isolation visible.

NEW FINDINGS from this pass (to fix in the next slice):
1. Settings "Tokens" blurb still says token sending is not supported —
   stale copy; token sending shipped in phase 4 item 3.
2. In Sepolia test mode the Ethereum row shows "no endpoint" — check
   whether the Sepolia profile's default RPC is threaded into the
   balance fetch (config/evm-chain.ts documents a default; the
   per-chain override store for eip155:11155111 starts empty).
3. (Recorded earlier) Seed backup screen permits screenshots.

Emulator remains available: AVD "shiba"; remaining items are fingerprint
enrollment -> auto-lock -> biometric-gated send, wrong-chain QR poster
swap, and WalletConnect live pairing.

## Emulator validation, third pass: findings fixed and biometric cycle proven

All three earlier findings were FIXED and re-verified live on the
emulator (commit 32bfd9e): Sepolia balances now fetch through the slot
match (Home shows a live Sepolia balance under the TESTNET banner),
Settings' token copy is current, and the seed screens block screenshots
(adb screencap returns an empty file while the phrase is visible on the
Backup screen or the Settings reveal, and works again after leaving —
FLAG_SECURE proven both directions).

FINDING #4, found and FIXED in the same pass: LockGate checked
localAuthAvailable only at mount, so biometric enrollment performed
while the JS session was alive (device Settings in another task) left
auto-lock permanently inert until an app restart. The availability
check is now keyed to the auto-lock setting so re-arming re-checks it.

BIOMETRIC CYCLE, fully proven on the emulator (device PIN via adb
locksettings, fingerprint enrolled through the real Android enrollment
UI driven blind via uiautomator dumps — the enrollment screens are
FLAG_SECURE — with simulated adb emu finger touches):
- Pre-enrollment, the app correctly hid auto-lock with the no-PIN note.
- Post-enrollment, the Auto-lock section appeared (Off / 1 min / 5 min)
  and 1 min was selected; the choice persisted across an app restart.
- After 70 seconds in the background, resuming showed the full-screen
  "Shiba Wallet is locked" overlay with the designed copy.
- Tapping Unlock raised the OS BiometricPrompt (proven by screencap
  returning empty while it was up), and a simulated fingerprint
  dismissed it straight back to the intact Home screen — screen state
  preserved, exactly as designed. The send/seed biometric gates use the
  same requireLocalAuth path just exercised.

Also implicitly proven: wallet + preferences fully persist across app
restarts (SecureStore + AsyncStorage), and the Settings endpoint row
switches to "Ethereum Sepolia" in test mode.

WRONG-CHAIN QR REJECTION, proven: the virtual-scene poster was swapped
to a Bitcoin-address QR and the emulator restarted (AVD data persisted:
the device PIN, fingerprint, wallet, and Sepolia mode all survived; the
camera permission did not need re-granting). Scanning the Bitcoin QR on
the Ethereum send screen filled the field verbatim and the standard
validation error appeared ("An Ethereum address is 0x followed by
exactly 40 hex characters.") — nothing auto-corrected, per the
scanning-never-widens-validation design. The same frame also validated
the Sepolia send-screen labeling ("Ethereum Sepolia · TESTNET", amounts
in test ETH).

Remaining on emulator: WalletConnect live pairing only (needs a dApp
wc: URI). Phone-only: real Secure Enclave/StrongBox, real camera
optics, iOS FaceID, store builds.

## Live WalletConnect pairing: PROVEN (2026-09-27, emulator)

The last emulator checklist item is complete. With a real pairing URI
from app.uniswap.org (provided by the Chairperson), the wallet paired
over the real WalletConnect relay and established a session:

- The Connections screen's paste path accepted the URI and Uniswap's
  session proposal arrived and rendered (dApp name, URL, description,
  requested chains/methods).
- Approve connection produced a settled session listed under Active
  connections: Uniswap - https://app.uniswap.org - eip155:11155111 -
  3 methods - Disconnect. Sepolia test mode governed the namespace
  exactly as designed.

Debugging trail that made it work (all fixes committed or documented):
- Metro lazy bundling produced "Requiring unknown module" errors at the
  WC lazy-chunk boundary (module-id misalignment with the main bundle,
  aggravated by exports-map fallback resolution in the WC dependency
  tree). WORKAROUND for dev sessions: run Metro with EXPO_NO_METRO_LAZY=1
  (single 2168-module bundle; no chunk boundaries). Follow-up for a
  future slice: reproduce against a plain release bundle (lazy bundling
  is a dev-server behavior) and consider eager-importing the WC stack.
- Three pairing URIs expired during cold boots and debugging; URIs live
  ~4-5 minutes, so the flow must be warm before requesting one.
- adb `input text` drops characters under load on this emulator; the
  reliable path for long strings is the ADBKeyboard IME (installed on
  the AVD) driven by `am broadcast -a ADB_INPUT_TEXT --es msg '...'`,
  proven byte-perfect with ?, &, =, @ intact. The Google IME was
  restored after the test.
- The Android keyguard on this AVD stopped accepting synthetic PIN
  input after heavy uptime; the device credential was cleared with
  `adb shell locksettings clear` (this also removed the fingerprint, so
  the pairing approval exercised the documented no-enrollment
  pass-through branch of the biometric gate rather than a prompt).

EVERY emulator-checklist item is now validated. Remaining live checks
are phone-only: real Secure Enclave/StrongBox, real camera optics, iOS
FaceID, store builds, plus dApp-side request handling (personal_sign /
typed data / transaction) which can now be exercised any time from the
established session.

## GRAND FINALE: a real Uniswap swap driven through the wallet (2026-09-27)

With the live WalletConnect session established, the Chairperson
triggered a sepUSDC -> sepETH swap on app.uniswap.org. The wallet
handled all three resulting requests end to end on the emulator:

1. eth_sendTransaction (ERC-20 approval to Sepolia USDC
   0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238): decoded, re-quoted
   against the live Sepolia RPC, "Pre-flight simulation passed
   (eth_call)", approved, engine-signed and broadcast. CONFIRMED
   status 0x1, block 11797811, 55,725 gas
   (0xa41da70aab0b1b84106a18ab1db3252e6d6ee8bf1a6833f7a804a6359e36b39c).
2. eth_signTypedData_v4 (Permit2 PermitSingle, canonical verifying
   contract 0x000000000022d473030f116ddee9f6b43ac78ba3): domain and
   message rendered, signed via the engine's EIP-712 typedDataDigest,
   signature returned over the relay — and later validated INSIDE the
   swap's eth_call simulation.
3. eth_sendTransaction (2,938-byte calldata to Uniswap's Sepolia
   router 0x7E4f6c5e954Da5c61B3423D81E2277431Ac043f3): simulation
   passed, approved, signed, broadcast. CONFIRMED status 0x1, block
   11797821, 295,540 gas, 8 event logs
   (0x2ce82c8f668edd00f4cd52875d9dfb5cdc5101d21ae9e29bba9e2128bd77f576).

Every leg of Tier 1 feature 78 (WalletConnect) is now live-proven
against a production dApp: pairing, session settlement, typed-data
signing, and dApp transactions with simulation gating — on the Sepolia
namespace under test mode, with test funds only. One dev-UX note:
React Native's LogBox overlay intercepted taps during the flow
(dev-mode only; absent from release builds); its warnings were
dismissed via its own Dismiss control.

## Phase 5 plan (approved 2026-09-27): the money phase

Goal: revenue and differentiation on the proven foundation. Sequenced
to avoid app-file collisions between parallel agents.

1. ~~Swap UI (Tier 1 feature 34, the revenue engine) on the engine's
   SwapQuoteProvider/0x seam~~ — DONE 2026-09-28 (see Phase 5 progress).
   Fakes-verified end to end; live quotes activate whenever a free 0x
   key is pasted in Settings → Swaps.
2. ~~ERC-7677 paymaster sponsorship + AA Max~~ — DONE 2026-09-28 (CTO).
   AaChainConfig gained paymasterUrl/context/verifiedAt with
   verify-before-save (a pm_getPaymasterStubData probe that accepts a
   result or a structured policy error but refuses method-not-found,
   unreachable endpoints, and invalid context JSON — all persisting
   nothing); createAaClient threads the paymaster into
   SmartAccountClient; sponsored quotes charge the user zero fee with an
   amount-only balance check and an honest may-still-decline note;
   Settings AA section gained the paymaster URL + context fields; the
   AA path's Max button now works (full balance under sponsorship, else
   balance minus a zero-value probe's worst-case fee). check-aa.mjs
   57/57 incl. the stub-then-final 7677 pipeline order; full app
   regression suite and bundle green. Live sponsorship activates when
   any real paymaster endpoint (e.g. an Alchemy Gas Manager policy) is
   pasted into Settings.
3. ~~Dogecoin completion in-app: Blockbook endpoint + API key
   configuration (runtime only), wiring balances, send, and Activity for
   DOGE through the engine's blockbookTransport/blockbookHistoryProvider~~
   — DONE 2026-09-28 (see Phase 5 progress). No live DOGE broadcast was
   made; the known-untested Dogecoin-broadcast remainder stands.
4. ~~Token-transfer history in Activity~~ — DONE 2026-09-28 (CTO).
   Core HistoryEntry gained additive assetAmount/assetDecimals; the
   indexer provider now fills them for erc20 entries from
   rawContract.value/decimal (exact base units); a new tracked-token
   logs fallback (app/src/wallet/token-history.ts over the engine's
   getErc20Transfers, 9k-block windows, bounded 8-window lookback,
   cursor paging) serves EVM Activity when no indexer is configured,
   labeled with an explicit partial-history note; confirmed
   timestamp-less log entries render "block N" instead of pending; the
   Activity renderer prefers exact token amounts in the token's own
   decimals. check-token-history.mjs 17/17; chains-evm 72 tests; tsc,
   related scripts, and expo export green.
5. ERC-7579 modular-account evaluation (Tier 2 moat groundwork): a
   plain-English docs/SESSION_KEYS.md comparing candidate 7579
   implementations for session keys and spending policies per AA_STACK
   criteria, with verified sources, plus the SmartAccountSpec-level
   interface sketch. Research + design only; no vendor lock.
6. EAS development-build readiness: eas.json + docs so a physical-device
   build (Secure Enclave/FaceID validation, store pipeline) is one
   command once an Expo account is provided.

Wave 1: item 1 (agent, app) + item 5 (CTO, docs/engine) in parallel.
Wave 2 after wave 1 lands: items 2+4 (CTO app slices) and item 3
(agent, app). Item 6 rides along as config-only.

## Phase 5 progress

- [x] Item 1 — Swap UI (Tier 1 feature 34) on the engine's
      SwapQuoteProvider/0x seam (2026-09-28). New app/src/wallet/swap.ts
      (RN-free glue like aa.ts): 0x API-key store in AsyncStorage under
      shiba-wallet.swap-config.v1 with the verify-before-save discipline —
      saving runs ONE live allowance-holder quote through the engine's
      zeroExSwapProvider for a canonical pair (chain 1, 0.001 ETH via the
      native sentinel into the verified USDC address, taker = the wallet
      address, minimal params); HTTP 401/403 refuses with a key-rejected
      message, any other failure refuses with a retryable message, and an
      honest no-liquidity answer still verifies (auth passed). The native
      sentinel 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE and the
      no-approval-for-native rule were verified 2026-09-28 from
      docs.0x.org/evm/0x-swap-api/additional-topics/
      handling-native-tokens.md. Also in swap.ts: fetchSwapQuote (chain id
      always the ACTIVE profile's, never hardcoded), describeSwapFailure
      for the SwapQuoteResult union, isQuoteStale (60 s horizon),
      validateSlippageBps (1–1000 bps), impliedRate (exact bigint,
      truncating), estimateSwapFee (0x gas × our suggestFees max fee),
      fetchErc20Allowance/checkAllowance (engine encodeFunctionCall +
      decodeUint256, spender = the quote's transaction.to),
      prepareApproveSend (engine encodeErc20Approve for EXACTLY the sell
      amount — deliberately never unlimited, and the UI says so),
      waitForAllowance (poll until the approve takes effect; the swap's
      eth_call pre-flight needs mined state), and prepareSwapSend, which
      reshapes the quoted {to, data, value} through the EXISTING
      prepareEvmSend — no second signing or broadcast path exists.
      SwapScreen (route Swap, entered from a Swap link on the Home EVM
      row): off with a plain explanation until a key is saved; sell/buy
      pickers over ETH + tracked tokens filtered to the ACTIVE chain (in
      Sepolia test mode that yields none and the screen says why — note
      recorded from the docs check: 0x's published supported-chain list at
      docs.0x.org/docs/introduction/supported-chains.md covers mainnets
      only and does NOT list Sepolia 11155111, contrary to the task
      brief's assumption; nothing hardcodes mainnet, so test-mode quotes
      go out with 11155111 and any error renders honestly); exact
      parseUnits amounts with balance display and pre-quote refusal;
      slippage 0.5% default / 1% / custom bps; quote review shows
      buyAmount, minBuyAmount labeled as the guaranteed minimum (enforced
      by the transaction itself), the implied rate, and the 0x gas
      estimate alongside our own worst-case fee; no-liquidity and error
      results rendered per the union. Execute reuses the send confirm
      idioms end to end: mainnet/TESTNET badge, eth_call simulation gate
      with the explicit override switch, biometric gate, success screen
      with txid + active-profile explorer link. ERC-20 sells with a short
      allowance get a two-step UX (Step 1 of 2 approve for the exact
      amount with its own confirm/simulate/biometric pass, then a
      post-approval re-quote and Step 2 of 2 swap confirm); quotes older
      than 60 s at any execute point are refreshed and the user is told to
      review the new numbers — stale calldata is never signed. Settings
      gained a "Swaps" section (AaField pattern) documenting that the key
      is stored on-device only and sent only to api.0x.org. Verified:
      app/scripts/check-swap.mjs 89/89, fully offline (fake 0x endpoint
      per the documented shapes incl. >2^53 exact-bigint amounts, fake
      JSON-RPC node; approve and swap raw transactions decoded field by
      field with ethers: exact-amount approve calldata, 0x calldata
      verbatim to the 0x to-address, value carried, taker signature);
      regressions all green — test-units 45/45, check-aa 39/39, check-wc
      83/83, check-token-send 37/37, check-qr 31/31, check-tokens 27/27,
      check-devmode 69/69; tsc --noEmit clean; expo export --platform
      android bundles (6.3MB Hermes) with the new strings confirmed in
      the bytecode. No key exists in the repo (.dev-wallet/env has no
      ZEROX_KEY); live quotes light up as soon as a free key from
      dashboard.0x.org is saved in Settings → Swaps. No packages/*
      changes; send.ts unchanged.

- [x] Item 3 — Dogecoin completion in-app via user-configured Blockbook
      (2026-09-28): balances, sending and Activity all work for DOGE the
      moment a Blockbook endpoint is saved in Settings; every state stays
      honestly "unavailable" until then. Endpoint model: NetworkKind
      gained 'blockbook' (app/src/config/defaults.ts; Dogecoin's kind,
      default URL still null), resolved not from the plain URL-override
      map but from a new config store app/src/wallet/blockbook.ts (base
      URL + OPTIONAL API key in AsyncStorage under
      shiba-wallet.blockbook.v1, keyed by CAIP-2; the key is sent only to
      the configured host as the api-key request header —
      BLOCKBOOK_API_KEY_HEADER constant, the header NOWNodes uses — and
      setEndpointOverride now refuses blockbook chains loudly).
      Verify-before-save (aa.ts discipline): saving runs a live GET
      /api/v2/utxo/{the wallet's own DOGE address} — the exact request the
      engine transport makes — and refuses to persist unless it answers
      2xx with a JSON array, so configured == verified by construction;
      Settings' Network endpoints section renders a dedicated Dogecoin
      BlockbookRow (URL + key fields, Verify & save, verified-✓ status
      with date, Clear). NetworkEndpoint gained an optional headers field
      that networks.ts populates from the stored key and that balances
      (fetchNativeBalance 'blockbook' case → blockbookTransport UTXO sum,
      same retry/row discipline), history (historySourceFor 'blockbook'
      case → blockbookHistoryProvider, numeric page cursors) and the send
      flow all pass through. Sending: prepareUtxoSend / maxUtxoSend /
      sendUtxo in app/src/wallet/send.ts take UtxoBackendOptions
      ({ backend: 'esplora'|'blockbook', headers, fetchFn }; Bitcoin's
      Esplora path is byte-for-byte the default) and SendScreen selects
      the backend from the endpoint kind. Fees come from Blockbook's GET
      /api/v2/estimatefee/{blocks}: the task brief cited docs/api.md
      v0.4.0, but that file documents only the legacy v1 route, so the
      shape was verified from the Blockbook v0.4.0 SOURCES instead
      (server/public.go apiEstimateFee routed at api/v2/estimatefee/,
      response {"result":"<decimal string>"} via AmountToDecimalString
      over the backend estimatesmartfee feerate, which Bitcoin/Dogecoin
      Core document as coin/kvB) — i.e. COIN PER KILOBYTE as an exact
      decimal string — and confirmed live (Dogecoin mainnet, 2026-09-28:
      /api/v2/estimatefee/6 → 0.01002934). Conversion is exact bigint:
      sat/kB = parseUnits(result, 8), sat/vB = ceil(sat_per_kB / 1000)
      (Dogecoin is pre-segwit, vsize == size), floored at 1000 sat/vB
      (0.01 DOGE/kB — the smoke.mjs norm; the 6-block target is used
      because the live 2-block estimate spikes ~50x). No explorer link is
      invented for DOGE anywhere (send success and Activity rows stay
      text-only, as before). Verified: app/scripts/check-doge.mjs 83/83 —
      offline: store discipline incl. corrupt storage, all seven
      verify-reject cases persist nothing, 12 fee-conversion cases pinning
      the math above, full quote→sign→broadcast against a fake Blockbook
      with the raw transaction independently decoded by bitcoinjs-lib
      (outputs/change/fee/outpoints field by field, txid cross-check),
      max-send total == balance, balance retry + history classification
      and 2-page cursor pagination through the exact app glue; LIVE
      (read-only, NOWNODES_KEY from git-ignored .dev-wallet/env, endpoint
      masked in output): save-time verification passed against the real
      host (and a wrong-key save was refused, persisting nothing), the
      standard test mnemonic's DOGE address balance (0 DOGE) and 13
      history entries fetched through the app glue, 2-page pagination at
      pageSize 5 with zero overlap, live fee estimate 1003 sat/vB.
      NO broadcast was made (the Dogecoin-broadcast remainder in "Known
      untested remainder" stands). Regressions all green: test-units
      45/45, check-aa 39/39, check-wc 83/83, check-token-send 37/37,
      check-qr 31/31, check-tokens 27/27, check-devmode 69/69, check-swap
      89/89, plus check-balances/check-history/check-indexer live runs;
      tsc --noEmit clean; expo export --platform android bundles (6.3MB
      Hermes) with the new strings confirmed in the bytecode (the
      Settings-note string is UTF-16-stored because it contains "→", so
      ASCII grep misses it; a UTF-16LE search finds it). No packages/*,
      scripts/testnet/, aa.ts, swap.ts, walletconnect.ts or indexer.ts
      changes.

## Phase 5 complete (2026-09-28)

All six items landed: the Swap screen on the 0x seam (live quotes one
free API key away), ERC-7677 paymaster sponsorship + AA Max, Dogecoin
completed in-app via configurable Blockbook, tracked-token history in
Activity (indexer-enriched and logs-fallback), the Kernel-v3-first
session-keys evaluation, and EAS device-build readiness. App
verification stands at 538 offline script checks across ten suites;
the engine at 187 tests.

## Phase 6 plan (approved 2026-09-28): the depth phase

1. Full asset-diff simulation (completes phase-2 task 6): an engine
   provider over Alchemy's simulation namespace (verify the exact
   method — alchemy_simulateAssetChanges — and response shapes from
   docs first), configured like the history indexer (runtime URL, never
   committed), surfaced on the EVM send/swap/WC confirm screens as
   plain-language balance changes ("You send 0.1 ETH; you receive
   ~3,412 USDC") alongside the existing eth_call gate, degrading
   honestly when unconfigured.
2. Prices + fiat display (Tier 1 features 44/89): a vendor-neutral
   PriceProvider interface in a new @shiba-wallet/prices package with a
   keyless CoinGecko adapter (verify current API docs + rate limits),
   cached and rate-limit-respecting; app shows fiat values on Home rows
   and confirm screens (secondary text, exact crypto stays primary),
   fully respecting Hide amounts and degrading silently when
   unavailable.
3. Multi-account (Tier 1 feature 4): BIP-44 account-index switching in
   the app (core derivation already supports the account parameter);
   account list + add/rename in Settings, active account threaded
   through balances/send/receive/activity/WC/AA; per-account AA
   counterfactuals derive from each account's owner key (D1 holds per
   account).
4. Contacts (Tier 1 feature 73): per-chain named addresses,
   engine-validated at save; send screens gain a contact picker and
   show the name when a typed/scanned address matches; scanning an
   unknown address offers save-as-contact; groundwork against address
   poisoning (exact-match display only, no fuzzy matching ever).
5. WalletConnect polish: a global session-request listener so approvals
   surface as an overlay anywhere in the app (not only on the
   Connections screen), and multi-chain namespaces offering both
   mainnet and Sepolia scoped to the active-chain rule.
6. Standing items as inputs appear: Dogecoin mainnet broadcast, live 0x
   quotes, live paymaster sponsorship, EAS device build.

Item 1 re-scoped 2026-09-28 (CTO decision, before any code was written):
the pre-coding docs check found that Alchemy's Transaction Simulation
APIs, including alchemy_simulateAssetChanges, "will be deprecated on
September 30th 2026" (notice on www.alchemy.com/docs/reference/simulation
and the method page; no replacement named), and the method already fails
on Sepolia with an internal error. Item 1 is therefore built on the
standard eth_simulateV1 (ethereum/execution-apis src/eth/execute.yaml;
the traceTransfers option "Adds ETH transfers as ERC20 transfer events to
the logs" emitted from 0xeeee...eeee per src/schemas/execute.yaml),
decoding ERC-20/721/1155 Transfer and Approval events in the engine.
Read-only probes showed eth_simulateV1 answering on the app's default
publicnode RPCs (mainnet and Sepolia) and on Alchemy, so no vendor key
or extra endpoint setting is required. This also removes a vendor
lock-in from the design.

Wave 1: item 1 (agent) + item 2's ENGINE package only (agent, no app
files). Wave 2: item 2's app wiring + items 3–5 sequenced by file
overlap. Subagents run on Opus per the Chairperson's credit directive.

## Phase 6 progress

- [x] Item 2, engine half — new package packages/prices
      (@shiba-wallet/prices, zero runtime dependencies, 115 tests).
      PriceProvider interface over plain CAIP-19 string ids; a result
      separates priced assets, failed lookups (rate-limited / http /
      network / malformed) and unpriceable assets (absent, never a zero
      price). Exact math: fiatValue(amount, decimals, price) is pure
      bigint, rounds half away from zero once, never prints -0.00, and
      flags belowPrecision so the UI can show "< $0.01". A small strict
      JSON parser keeps vendor number literals verbatim (Map-based
      objects, prototype-safe), so vendor digits never pass through a
      float before the decimal math. CoinGecko adapter verified
      2026-09-28 against docs.coingecko.com (demo/reference
      authentication, endpoint-overview, simple-price, simple-token-price;
      docs/errors-and-rate-limits): base https://api.coingecko.com/api/v3
      serves Demo and keyless calls; the optional Demo key goes only in
      the x-cg-demo-api-key header; /simple/price and
      /simple/token_price/{platform} with include_last_updated_at and
      precision=full (without it prices are rounded to ~5 significant
      digits, observed live). Live keyless probes confirmed the coin ids
      ethereum/bitcoin/dogecoin/solana and USDC by contract, and observed
      two undocumented keyless limits: ONE contract per token_price
      request (HTTP 400, error 10012) and a 429 after ~6 requests/minute
      from one IP. Native ids match core's CAIP-2 ids (checked by the
      CTO against packages/core chains/utxo.ts and chains/solana.ts);
      testnet assets are deliberately unpriced. cachedPriceProvider adds
      TTL caching (including "cannot price" answers), in-flight dedupe,
      stale-on-error within maxStaleMs (flagged stale), and 429 backoff
      (Retry-After if sent, else 60 s doubling to 10 min). Unverified:
      the Demo-key path (no key available) and Retry-After on CoinGecko
      429s (never observed). App wiring is wave 2: one shared cached
      instance (120 s TTL keyless), fiat as secondary text on Home and
      confirm screens, masked under Hide amounts, silent when missing,
      optional Demo key in Settings with verify-before-save.

- [x] Item 1 — asset-diff simulation on the standard eth_simulateV1
      (completes phase-2 task 6). Engine:
      packages/chains-evm/src/asset-diff.ts — simulateAssetChanges sends
      [{ blockStateCalls: [{ calls }], traceTransfers: true }, "latest"]
      (calldata in the spec's `input` field; validation left at its
      default false, i.e. eth_call semantics), per ethereum/execution-apis
      src/eth/execute.yaml + src/schemas/execute.yaml. Every event topic0
      is computed with @noble keccak256 from the canonical signature
      (tests pin each against ethers id()); signatures and indexed fields
      verified from the ERC-20/721/1155 texts in ethereum/ERCs. Decodes
      the ETH pseudo-Transfer from 0xeeee…eeee, ERC-20 Transfer (3
      topics, 32-byte data) vs ERC-721 Transfer (4 topics, empty data),
      ERC-20 Approval (unlimited iff max uint256), ERC-721 Approval,
      ApprovalForAll (strict ABI bool), ERC-1155 TransferSingle/Batch
      (bounds-checked arrays). Only wallet-relevant changes are kept;
      amounts are exact bigints from event words; logs of reverted calls
      are discarded; known topics with non-standard shapes are skipped
      and counted, never guessed. Method-not-found (-32601 or "Unsupported
      method") and malformed top-level shapes raise
      SimulationUnsupportedError; verifySimulationSupport exported.
      App: app/src/wallet/simulation.ts (Node-loadable glue; its
      transport keeps JSON-RPC error bodies on non-2xx because Alchemy
      answers "Unsupported method" with HTTP 400) and
      app/src/components/BalanceChangePreview.tsx, a "Balance changes
      (preview)" card on the native, ERC-20 and smart-account send
      confirms, the swap approve and swap confirms, and the WalletConnect
      eth_sendTransaction approval. It simulates against the SAME
      endpoint the quote used — no new setting (publicnode, 1rpc, drpc
      and Alchemy serve the method; cloudflare-eth answers -32601 and
      gets the honest "does not support eth_simulateV1" note). Token
      metadata: tracked-token store first (matched on contract AND CAIP-2
      id, so mainnet labels never leak onto Sepolia contracts), else
      eth_call metadata (capped at 12 contracts); unreadable decimals show
      raw base units labeled as such; untracked tokens are always marked
      "(untracked token 0x…)" and on-chain symbols are sanitized
      (control/bidi characters stripped) as anti-spoofing. Unlimited and
      collection-wide approvals render in the warning style; Hide amounts
      masks every amount. The eth_call revert gate is untouched — the
      screen diffs are additive apart from carrying `from` in the WC
      quote state — and the card never blocks or unblocks a send.
      Limits, documented in code: a malicious contract can emit fake
      events (mitigated by emitter-address labeling and the untracked
      marker); batched AA calls would be simulated sequentially, not
      atomically; approvals >= 2^128 below max are shown as "effectively
      unlimited" (a local threshold, not a standard). Verified: 30 new
      engine tests (chains-evm 102; engine total 335 across five
      packages); app/scripts/check-simulation.mjs 49/49 offline; app
      regressions green (test-units 45, check-aa 57, check-wc 83,
      check-token-send 37, check-swap 89, check-devmode 69, check-qr 31,
      check-tokens 27, check-doge 83, check-token-history 17); tsc clean;
      expo export bundles with the new strings in the bytecode. Live
      read-only probes through the app glue: mainnet ETH send, USDC
      transfer, UNLIMITED USDC approval warning, and a revert reason on
      publicnode; on Sepolia the deployed smart account 0xB837…0fa2 as
      sender. Nothing was signed or broadcast. Not yet eyeballed on the
      emulator (dark-mode styling pending).

- [x] Item 2, app half — fiat prices (commit e5caba6). The app consumes
      @shiba-wallet/prices via a file: dependency (metro needed no
      change). app/src/wallet/prices.ts: one shared
      cachedPriceProvider(coinGeckoPriceProvider) (120 s TTL, 30 min max
      stale), rebuilt when the key changes; native CAIP-19 ids built
      with core's formatAssetId and each key provider's coin type,
      tokens use their tracked-store ids verbatim; an asset is priced
      only when it sits on a MAINNET network that is also the active
      one (Sepolia-mode assets always get null, on top of the engine's
      own testnet exclusion); guardedCoinGeckoFetch refuses to send the
      x-cg-demo-api-key header anywhere but api.coingecko.com. New
      "Show fiat values" preference (default on) with a plain disclosure
      in Settings → Prices that CoinGecko sees the device IP and the
      priced assets; when off, fetchPrices returns before any storage or
      network access, and the hook waits for stored prefs so a stored
      "off" is never overridden by the default. Display: "≈ $1,234.56"
      secondary text on Home native + token rows, native/ERC-20/AA send
      confirms (amount, fee, total; no fee line when sponsored), and the
      swap review (sell, estimated receive, guaranteed minimum); "<
      $0.01" for tiny values; nothing for missing prices or zero
      balances; "price from N min ago" for stale or vendor-old quotes;
      Hide amounts masks every fiat value as "≈ ••••". Optional Demo key
      with a live check before saving. FINDING: CoinGecko answered HTTP
      200 with a normal price for a made-up Demo key, and the Demo API
      has no key-status endpoint, so the check proves the request works
      rather than that the key is genuine; the UI says "Checked ✓ — a
      live price request with this key succeeded", not "verified".
      Verified: app/scripts/check-prices.mjs 110/110 offline (the suite
      caught deliberately broken Sepolia and masking guards); one live
      keyless probe priced all five assets; the committed tree was
      re-verified by the CTO in an isolated git worktree (tsc clean,
      check-prices 110, check-wc 83, check-simulation 49, check-swap 89,
      check-token-send 37, check-devmode 69, check-aa 57, test-units 45);
      expo export bundles (6.4MB Hermes). Not yet eyeballed on the
      emulator (row layout, dark mode); the genuine-Demo-key path is
      untested (no key available).

- [x] Item 5 — WalletConnect polish (commit cdb3fe9). Requests and
      proposals surface on ANY screen: app/src/wallet/wc-controller.ts
      (React-free queue: arrival order, duplicate-id suppression, no
      visible or claimable item while locked, begin/release/complete/
      decline, staleChainError re-check at approve time, notices),
      app/src/wallet/WalletConnectContext.tsx (provider mounted once
      inside LockGate; every approval = eth_call gate check for
      transactions, requireLocalAuth, re-claim, active-chain re-check,
      keys only via signWith), app/src/components/WcApprovalSheet.tsx
      (the approval UIs moved verbatim from ConnectionsScreen, rendered
      as an in-tree overlay rather than an RN Modal so LockGate's lock
      screen always covers it; Android back is swallowed while it is up).
      LockGate exposes useAppLock(). ConnectionsScreen is now pairing +
      session list (+ "Paused" notes) + notices. This also fixes an
      old-design bug: the SDK delivers each request once per process
      and waits for an answer, so a request arriving while Connections
      was closed was lost and blocked later ones until restart.
      Namespaces under the active-chain rule (SDK semantics verified in
      @walletconnect/utils 2.25.0 namespaces.ts/validators.ts,
      sign-client 2.25.0 engine.ts, walletkit 1.6.0): only the active
      profile's chain is ever approved (the SDK's buildApprovedNamespaces
      result is re-checked so every account equals active:address);
      a required, or optional-only, other-mode chain is declined with
      5100 and a plain sentence pointing at Settings → Developer
      (optional-only matters: the SDK moves requiredNamespaces into
      optionalNamespaces, and Uniswap sends everything optional);
      unsupported chains 5100, non-eip155 required 5104, unsupported
      methods/events 5101/5102. wallet_switchEthereumChain (EIP-3326,
      returns null) is answered automatically, never signs and never
      changes the mode: null for the active chain on a session that has
      it, 5100 otherwise; malformed params -32602. Sessions from the other
      mode are paused (requests declined 5100), not deleted. Startup: the
      SDK initializes at launch only when a project id exists AND a
      "used" marker (shiba-wallet.wc-used.v1) is set; otherwise lazily
      when Connections opens; compat-shim-first import order preserved;
      a child-process check proves Node scripts never load @reown/*.
      CTO review fix: when a transaction broadcasts but the relay reply
      fails, the user is told "Transaction sent, dApp not notified" with
      the txid and the item is completed (no false send-failure alert;
      a retry could not double-spend anyway because the nonce is pinned
      in the quote and signatures are deterministic). Verified:
      check-wc.mjs 197/197 (was 83); committed tree re-verified by the
      CTO in an isolated worktree (tsc clean, all twelve app suites
      green; check-doge's 11 live checks run only where the git-ignored
      .dev-wallet/env exists — 83/83 in the main tree); expo export
      bundles. Known gaps filed: native Alerts and other screens'
      QrScanner Modals can draw above the lock overlay; sessions survive
      a wallet wipe (requests naming the old address are refused);
      other-mode switch declines use 5100 rather than MetaMask's
      non-standard 4902. Emulator checklist (11 steps) pending: global
      sheet on Home, lock hold, relaunch-with-session, paused sessions,
      switch-chain, dApp-side disconnect, back button.

- [x] Item 4 — Contacts (Tier 1 feature 73). app/src/wallet/contacts.ts
      (Node-loadable store, AsyncStorage key shiba-wallet.contacts.v1, one
      list per network id; the EVM list follows the active mode, so
      Sepolia contacts never show in mainnet mode). Every save passes the
      send flow's validateRecipient; EVM stored EIP-55, uppercase bech32
      stored lowercase. EXACT matching only: EVM case-insensitive on the
      full 20 bytes, Bitcoin/Dogecoin on the decoded output script byte
      for byte, Solana on the base58 string. Anti-poisoning: a recipient
      that matches shows the contact name AND the full address; a
      non-matching address sharing the first 4 and last 4 characters with
      a contact triggers a warning ("looks similar to your contact X but
      is DIFFERENT") — prefix/suffix comparison is used only to warn,
      never to label; saving a look-alike as a new contact requires an
      explicit "Save anyway" and the send screen never offers it. Names:
      1–40 code points with control, bidi mark/override/isolate, and
      zero-width characters stripped (ZWJ kept for emoji); duplicate
      addresses and duplicate names per network are refused. Damaged
      entries are hidden with a flag; unreadable storage refuses writes
      until an explicit Reset contacts. UI: app/src/components/Contacts.tsx
      (recipient notice, picker modal, inline Save as contact) and
      app/src/screens/ContactsScreen.tsx (per-network list, add with
      Scan, rename, delete with confirmation), linked from Settings; the
      Send screen (native + token) gained a Contacts button beside Scan,
      the notice/warning on the form and all confirm screens, and Save as
      contact after scans and on success screens. The subagent's App.tsx
      route edit was blocked by the permission system; the CTO added the
      route itself. Verified: check-contacts.mjs 110/110 offline; full app
      regression green (check-wc 197, check-prices 110, check-simulation
      49, check-swap 89, check-token-send 37, check-devmode 69, check-aa
      57, check-qr 31, check-tokens 27, check-doge 83, check-token-history
      17, test-units 45); tsc clean; expo export bundles with the Contacts
      screen strings in the bytecode. Not yet exercised on the emulator
      (picker modal, three-button recipient row on narrow screens).
      Dogecoin has no look-alike test vector (building one needs a ~58^4
      checksum search); it shares the tested string comparison.

- [x] Item 3 — Multi-account (Tier 1 feature 4). One mapping function,
      derivationArgsFor in app/src/wallet/accounts.ts, used by every
      caller: user-facing Account N = EVM m/44'/60'/0'/0/N (MetaMask
      eth-hd-keyring convention), Solana m/44'/501'/N'/0' (Phantom),
      Bitcoin m/84'/0'/N'/0/0 and Dogecoin m/44'/3'/N'/0/0 (BIP-44 account
      level). Account 0 is byte-identical to the previous derivation on
      all four chains (address, path, public key), pinned as literals.
      Vectors for the standard test mnemonic were cross-checked against
      ethers HDNodeWallet (EVM accounts 1–2 re-derived by the CTO:
      0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0,
      0xb6716976A3ebe8D39aCEB04372f22Ff8e6802D7A), bitcoinjs-lib 6.1.8
      (Bitcoin, Dogecoin with pubKeyHash 0x1e) and ed25519-hd-key 2.0.0 +
      @solana/web3.js 1.99.0 (Solana). Account store: versioned
      AsyncStorage list of {index, name} plus the active index; indices
      are never reused (hide, not delete; Account 1 and the active account
      cannot be hidden); cap of 50. Security: signWith(chainId,
      expectAddress, fn) derives the ACTIVE account's key and refuses
      unless it controls exactly the address the operation was prepared
      for; the navigator is keyed on the active account, so a switch
      returns to Home and no screen keeps an old account's quote.
      WalletConnect: requests are bound to the session's approved
      address and declined with UNSUPPORTED_ACCOUNTS 5103 ("This
      connection belongs to Account 1 (…)") after a switch — this also
      closes a pre-existing gap where an eth_sendTransaction without a
      `from` field would have been signed by whichever account was active;
      approval re-checks the account (staleAccountError). AA: the owner is
      the active account's EOA and the salt is the account index (per
      ARCHITECTURE 3.1/D4); account 0 keeps salt 0 and its counterfactual
      address byte-identical. UI: Home account switcher, Settings →
      Accounts (add, rename, hide, show hidden, use), "From account" /
      "Signing account" on every confirm and the WC sheet, Receive shows
      the account name, backup and seed-reveal copy says one phrase backs
      up all accounts. docs/ARCHITECTURE.md gained ADR D8. Verified:
      check-accounts.mjs 111/111 offline; all fourteen app suites green,
      tsc clean, expo export bundles (6.5MB) with the new strings, all
      re-run by the CTO. No packages/* changes.
      DECIDED 2026-09-28: the Chairperson chose the BIP-44 standard
      account level for Bitcoin and Dogecoin (the mapping below is final;
      ADR D8 updated). Original decision record (verified 2026-09-28 at
      help.phantom.com "What derivation paths does Phantom support?"):
      Phantom's default Bitcoin SegWit path is m/84'/0'/0'/0/{index}
      (account number in the address segment, "all chains share the same
      index"), whereas this wallet uses the BIP-44 account level
      m/84'/0'/N'/0/0, which Bitcoin-native account wallets use. Account
      1 is identical either way; Bitcoin accounts 2+ do not round-trip
      with Phantom under the current mapping. EVM and Solana match
      Phantom's defaults exactly. The mapping is one function and no
      user has funded accounts 2+, so it can still change cheaply —
      but it must be settled before release. Also recorded in D8: no
      account discovery on import (re-add accounts in order to recover
      them), and BIP-44's "no new account before the previous one has
      history" rule is not enforced (would need network lookups).

## Phase 6 emulator validation (2026-09-28, AVD "shiba", Expo Go, Sepolia mode)

Fresh Metro (EXPO_NO_METRO_LAZY=1, cleared cache, 2194 modules) serving
the phase-6 tree. PASSED, with screenshots reviewed at every step:

- Account-0 invariant on a REAL wallet: after the multi-account change
  the emulator wallet's Account 1 is 0x772eAA1d…C680F44F, and Sepolia
  reports that exact address as the sender of the earlier live Uniswap
  approval (tx 0xa41da70a…). Existing users see no address change.
- Home: "Account 1 · 0x772e…F44F" switcher, one-phrase-backs-up-every-
  account copy, live Sepolia balance, no fiat in test mode (by design).
- Balance-change preview LIVE: the Sepolia send confirm showed "You send
  0.00001 test ETH" from eth_simulateV1 on the default keyless
  publicnode RPC, with the "From account" block, and the unchanged
  "Pre-flight simulation passed (eth_call)" gate directly below. Nothing
  was sent.
- Multi-account: Add account created Account 2 with distinct addresses
  on all four chains and switched Home to it; switching back restored
  Account 1 intact. UX FINDING: adding took ~15 s on this software-GPU
  emulator (seed stretching in JS); measure on a real phone and consider
  a native PBKDF2 or a cached seed-in-session design if it is slow there.
- Contacts: the picker is scoped to "Ethereum Sepolia contacts"; a
  contact "Burn" = 0x…dEaD saved with its full address; typing the
  look-alike 0x00…0fdead produced "This address looks similar to your
  contact “Burn” but is DIFFERENT. Check every character." (no label);
  typing the exact address in lowercase produced "SAVED CONTACT Burn"
  with the full checksummed address.
- WalletConnect: the Uniswap session from the phase-5 live test survived
  all phase-6 changes and is listed as bound to "Account 1
  (0x772e…F44F)"; the copy says requests appear on any screen.

GLOBAL REQUEST SHEET + PREVIEW, PROVEN LIVE (same day): with the
wallet sitting on Home, the Chairperson triggered a sepUSDC -> sepETH
swap on app.uniswap.org. The WalletConnect transaction sheet surfaced
over Home (not the Connections screen) showing Sending account
"Account 1 (0x772e…F44F)", the Sepolia router 0x7E4f…043f3, fee, the
balance-change preview ("You send 1 USDC (untracked token
0x1c7D…7238)", "You receive 0.000041219674256619 test ETH") and
"Pre-flight simulation passed (eth_call)". Approved and broadcast:
tx 0x5ab4c38b409b0665a909aad2259d3a15e89c639258dec579a8be5ff9d0221714,
block 0xb415da (11801050), status 0x1, sender 0x772e…f44f. The preview
matched reality exactly on both legs: the receipt's USDC Transfer log
moved 0xf4240 = 1,000,000 base units (1 USDC) from the wallet, and the
ETH received, reconstructed as balance(after) − balance(before) + gas
fee = 41,219,674,256,619 wei, equals the previewed amount to the wei.

WALLETCONNECT DECLINE PATHS, PROVEN LIVE with Uniswap (same day):
- Fresh pairing under the phase-6 namespace logic: Uniswap proposed 25
  eip155 chains (incl. mainnet and Sepolia) and 21 methods; the sheet
  showed "Will connect on Ethereum Sepolia (test network)", "Will
  connect account Account 1 (0x772e…F44F)", and listed the other 24
  chains as offered but not included. The settled session is
  eip155:11155111 with 4 methods (now incl. wallet_switchEthereumChain;
  the phase-5 session had 3 and was disconnected for this retest).
- Network switching: Uniswap never sent wallet_switchEthereumChain for
  chains outside the approved namespace (toggling its testnet mode and
  picking Unichain Sepolia both produced a dApp-side "not supported"
  with no request reaching the wallet). The dApp pre-filters by session
  namespace, so the wallet's own switch-decline path stays covered by
  check-wc only.
- Wrong account: with Account 2 active, a Uniswap swap was declined
  automatically with no approval sheet, notice: "Declined
  eth_sendTransaction from Uniswap: This connection belongs to Account 1
  (0x772e…F44F), but Account 2 (0xb699…81fE) is active…".
- Paused session: with Account 1 active but the wallet in mainnet mode,
  a Uniswap swap was declined automatically, notice: "…This dApp asked
  for Ethereum Sepolia (test network); the wallet is in mainnet mode.
  Turn on Sepolia test mode in Settings → Developer to use this
  connection." Uniswap renders both declines as a generic "Swap failed
  — try adjusting slippage" (dApp-side wording, outside our control).
The wallet was returned to Account 1 in Sepolia test mode afterwards.

LOCK HOLD, PROVEN LIVE (same day): a fingerprint was re-enrolled on the
AVD (locksettings set-pin 1234, the android.settings.FINGERPRINT_ENROLL
flow driven through uiautomator, `adb emu finger touch 1` for the
sensor); the Auto-lock section then appeared and 1 min was re-armed
(Off then 1 min, which triggers LockGate's availability re-check). With
the wallet backgrounded, the Chairperson confirmed a Uniswap swap. After
163 s the wallet was resumed: ONLY the "Shiba Wallet is locked" screen
showed, with no approval sheet visible or actionable. Unlock raised the
OS BiometricPrompt (screencap empty, FLAG_SECURE), and after the
simulated fingerprint the queued approval sheet appeared intact on
Home. Approving raised the per-approval biometric gate (screencap empty
again) before signing; broadcast tx
0x3c55113b646015e7b394a2b3df7377b8abcd3c926dd5472ac8ec3a99c13d8437,
block 0xb41801, status 0x1, sender Account 1. The AVD now has device
PIN 1234 and one enrolled fingerprint again.

Still pending (needs a dApp that can send plain message-signing
requests): two queued requests surfacing in arrival order, and a live
wallet-side switch-chain decline (Uniswap pre-filters switches). Fiat display could
not be eyeballed here: test mode prices nothing and the mainnet
balances are zero (covered offline by check-prices 110/110).

## Phase 7 plan (approved 2026-10-01): the AA-native phase

Scope confirmed with the Chairperson after a standards survey (ERC-4337
built and live-proven; ERC-7677 built; ERC-7579, ERC-5792, EIP-7702,
ERC-1271/6492/7739 and ERC-7715 designed or unmentioned; see the
2026-10-01 conversation record below).

1. ERC-7579 modular smart accounts (Tier 1 feature 22): a second
   SmartAccountSpec beside SimpleAccount, Kernel v3 first per
   docs/SESSION_KEYS.md, factory addresses per-chain config with the
   AA_STACK on-chain verification procedure, proven on Sepolia with
   test ETH. Unlocks session keys and passkeys later.
2. Batching (feature 17): smart-account token sends as one atomic
   approve+transfer, and ERC-5792 wallet_sendCalls /
   wallet_getCapabilities / wallet_getCallsStatus over WalletConnect
   (Uniswap already requests them at pairing).
3. Smart-account signatures: ERC-1271 validation, ERC-6492 for
   counterfactual (undeployed) accounts, ERC-7739 replay-safe typed-data
   wrapping, and WalletConnect sessions that bind the smart-account
   address, so a 4337 user can use SIWE logins and sign orders. Without
   this, a smart-account user cannot log in to dApps — a cliff, not
   polish.
4. NFT gallery and send (Chairperson requirement 6; features 40–41):
   ERC-721/1155 ownership via a runtime-configured indexer (history
   indexer pattern), metadata rendering, sends through the existing
   confirm flow and balance-change preview.
5. Risk warnings (feature 50) and approvals-manager groundwork (51):
   unverified-contract and first-interaction warnings, token-approval
   listing.
6. Standing items as inputs appear: Dogecoin mainnet broadcast, live
   0x quotes, live paymaster sponsorship, EAS device build.

Also requested by the Chairperson (2026-10-01): docs/AA_FRAMEWORKS.md,
a multi-dimensional comparison of smart-account frameworks
(authentication, authorization, recovery, security and maturity, age,
adoption and value secured, audits, formal verification, bug bounties,
development activity, adopting wallets, vendor lock-in, upgradability
risk, licensing and commercial constraints). It must land BEFORE item 1
commits to Kernel, so the choice is evidence-based.

EIP-7702 is queued as the phase 8 headline. CORRECTION (2026-10-01,
from docs/AA_FRAMEWORKS.md): the assumption that 7702 needs the
EntryPoint v0.8 upgrade is not supported by vendor documentation —
Kernel v3.3, Nexus and Alchemy MAv2 all document 7702 delegation on
EntryPoint v0.7, and Kernel v3.3 is a released 7702 delegate. How the
authorization is submitted under v0.7 is still unverified and must be
checked on Sepolia before phase 8 is scoped.

Wave 1 (parallel, disjoint files): the frameworks doc (agent, docs/
only), item 1's ENGINE half (agent, packages/chains-evm + scripts/testnet
only, no app files), item 4 (agent, app/ only). Wave 2: item 1's app
wiring, then items 2, 3 and 5 sequenced by file overlap. Subagents run on
Opus per the Chairperson's credit directive.

## Phase 7 progress

- [x] Item 1, engine half — Kernel v3.3 (ERC-7579) SmartAccountSpec
      (commit 07d5ba7). packages/chains-evm/src/kernel-account.ts:
      createKernelAccountSpec with the ECDSA validator as root validator
      and the seed-derived EOA as owner (D1 holds); KERNEL_V3_3 constants
      (meta factory 0xd703aaE79538628d27099B8c4f621bE4CCd142d5, factory
      0x2577507b78c2008Ff367261CB6285d44ba5eF2E9, kernel
      0xd6CEDDe84be40893d153Be9d467CD6aD37875b28, ECDSA validator
      0x845ADb2C711129d4f3966735eD98a9F09fC4cE57) from the kernel README
      at tag v3.3 (commit cd697c7e, 2025-04-03 — the latest v3.x; main is
      now Kernel v4 targeting EntryPoint v0.9, deliberately NOT used),
      cross-checked against the ZeroDev SDK constants; verifyKernelDeployment
      (the AA_STACK on-chain check for Kernel); predictKernelAddress (local
      CREATE2 that the spec enforces against the factory's answer, so a
      dishonest RPC cannot redirect funds). Confirmed read-only on Sepolia
      and mainnet: code at all four addresses, factory.implementation(),
      entrypoint() == v0.7, accountId() == kernel.advanced.v0.3.3,
      metaFactory approved and staked (0.1 ETH / 86400 s), validator
      isModuleType(1). Counterfactual address for the standard test owner
      (index 0: 0xB67b8b7cCA718EAC64d2b59ba568585A9FC69a42) equals the
      factory's getAddress, EntryPoint.getSenderAddress and ethers
      CREATE2; proxy init-code hash equals the SDK's published value.
      Validator routing via the nonce key (key 0 = root validator);
      signature is a bare 65-byte EIP-191 ECDSA signature; the
      gas-estimation stub uses the SDK's dummy signature because solady's
      recover reverts on garbage. abi.ts gained fixedBytes and tuple
      (additive). 20 new tests (chains-evm 136; engine 372 across five
      packages); the CTO re-verified the Kernel-only commit in an isolated
      worktree. scripts/testnet/kernel-smoke.mjs: dry run
      (KERNEL_SMOKE_DRY_RUN=1) builds, signs (public test mnemonic) and
      runs a deployment + ERC-7579 batch op through EntryPoint.handleOps
      on Sepolia with a balance override — validation passed, execution
      success=true, and a flipped signature byte reverts; the LIVE leg
      (fund, deploy via the staked meta factory, two ops through the
      bundler, SELF_BUNDLE_ON_REJECT fallback) has NOT been run yet —
      command in docs/AA_STACK.md "Kernel v3". Unverified: whether
      Alchemy's bundler accepts Kernel deployment ops through the meta
      factory. FACT FIX: docs/SESSION_KEYS.md claimed ERC-7579 reached
      final status in 2024; eips.ethereum.org lists it as Draft (created
      2023-12-14), corrected with the consequence that the adapter stays
      pinned to a release, not "the standard".

- [x] Item 4 — NFT gallery and send, ERC-721 + ERC-1155 (commit
      b1750f3; Chairperson requirement 6). Engine:
      packages/chains-evm/src/nft-indexer.ts (vendor-neutral
      NftOwnershipProvider + Alchemy NFT API v3 adapter over an injected
      fetch; shapes verified at www.alchemy.com/docs/reference/
      nft-api-endpoints/.../get-nf-ts-for-owner-v-3: GET
      /nft/v3/{apiKey}/getNFTsForOwner with owner/withMetadata/pageSize
      (max 100)/pageKey; ownedNfts[] with contract{address,name,symbol,
      tokenType,isSpam}, tokenId (decimal string), tokenType, image{...},
      raw{tokenUri,metadata}, balance; validAt{blockNumber,blockHash,
      blockTimestamp}; pageKey null when done), exact bigint token ids
      and 1155 balances, verifyNftOwnershipEndpoint; erc721.ts /
      erc1155.ts (safeTransferFrom 3-arg and 5-arg, ownerOf, balanceOf,
      the 1155 {id} substitution rule; selectors computed with keccak
      from the ERC texts and pinned against ethers). Core gained
      nonFungibleAssetId / nonFungibleTokenId (uint256 range-checked).
      App: app/src/wallet/nfts.ts (NFT indexer config with
      verify-before-save — the REST indexer has no chain id, so saving
      checks its validAt block against the active chain's RPC by hash
      when present, else by exact timestamp; a /v2/ node URL is refused
      with a pointer to /nft/v3/; per-account+chain cache; grouping;
      URI and image rules), NftsScreen + NftDetailScreen (linked from
      the Home Ethereum row; honest unavailable state until configured),
      Settings "NFT indexer" section, SendScreen NFT mode via
      app/src/wallet/send-nft.ts (ownership re-checked on-chain at
      quote time, calldata through the EXISTING sendEvm — no second
      signing path; recipient validation, contacts notice/look-alike
      warning, eth_call gate, BalanceChangePreview "You send NFT #…",
      biometric gate all reused unchanged; 1155 amount bounded by the
      holding; AA toggle hidden in NFT mode). Privacy/safety rules:
      ipfs:// via https://ipfs.io/ipfs/ (the gateway sees the device IP
      and requested CIDs — a production release should let the user
      choose a gateway); data: URIs decoded locally; http(s) passed
      through; ar://, javascript: and relative paths refused; images
      fetched by the app with a 4 MiB cap and type-checked from their
      bytes, shown as data: URIs; SVG NEVER rendered (scripts) —
      placeholder instead; spam-flagged collections hidden behind a
      toggle and never loaded from their original hosts (unique image
      links can leak a holder's IP); metadata text capped at 512 KiB and
      sanitized. Docs quirks recorded: the docs never state that one key
      serves both /v2/ and /nft/v3/, so Settings has a separate NFT URL
      field; validAt.blockHash is null on mainnet but present on Sepolia;
      isSpam arrives as a JSON boolean; spam ERC-721 entries reported
      with balances 2–41 whose ownerOf names another owner are skipped
      and counted, not guessed. Verified: 14 engine tests; app/scripts/
      check-nfts.mjs 120/120 offline (ids > 2^53, 1155 balances > 2^64,
      all config reject cases persist nothing, SVG refusal, calldata ==
      ethers, offline sign+broadcast decoded field by field for 721 on
      mainnet and 1155 on Sepolia); all fourteen other app suites green;
      tsc clean; expo export bundles (6.6MB Hermes) with the new strings.
      Live read-only probes (key masked): vitalik.eth over two pages
      incl. 2 ids > 2^53; the standard test address holds 9 NFTs on
      Sepolia; a mainnet NFT URL saved in Sepolia mode is refused. Not
      verified: on-device rendering (grid, detail, dark mode; GIF/WebP
      on Android), a live NFT send (no test NFT yet), smart-account NFT
      sends (later slice with batching).

INFRA FINDING (2026-10-01): https://ethereum-rpc.publicnode.com — the
app's DEFAULT mainnet RPC — fails the TLS handshake ("shutdown while in
init") while https://ethereum.publicnode.com on the same Cloudflare IPs
answers normally, i.e. a provider-side problem with the documented
hostname, not a local one; publicnode's own page still documents
ethereum-rpc.publicnode.com as canonical. The default was left as
documented. Follow-up filed: give every chain an ordered fallback list
of default RPCs so one dead hostname never blanks the Home screen.
check-tokens.mjs's live step fails for the same reason until the host
recovers (27/27 when pointed at another mainnet RPC).

- [x] docs/AA_FRAMEWORKS.md — the Chairperson's smart-account framework
      comparison (about 10,700 words, 116 numbered references, all
      fetched 2026-09-30/10-01; five parallel research agents under a
      verbatim-quote sourcing rule, headline claims spot-checked by the
      lead against primary sources; the CTO re-verified the Kernel
      license — LICENSE.txt at tag v3.3 and the SPDX MIT header in
      Kernel.sol — and the ZeroDev acquisition — zerodev.app's own
      announcement, 2025-08-13). Frameworks: SimpleAccount, Safe (+
      Safe4337Module + Safe7579), Kernel v3, Nexus, Alchemy MAv2,
      Coinbase Smart Wallet, Etherspot; twelve dimensions plus added
      ones. RECOMMENDATION: keep Kernel v3 on EntryPoint v0.7 as the
      first ERC-7579 account (v0.7 match, MIT contracts and permission
      plugins, released 7702 delegate on v0.7, third-party bundlers and
      7677 paymasters documented, an independent permissionless.js
      implementation to byte-test against, the largest native-7579
      adoption on BundleBear); Sepolia work may proceed now, MAINNET
      FUNDS WAIT ON three conditions — C1 an audit covering the exact
      shipped version (published audits cover v3.0, the factory, and a
      v3.1 increment; none found for v3.2/v3.3 or the 7702 change), C2
      confirmation of bug-bounty coverage (none found), C3 a v3 support
      horizon and v3→v4 migration statement (the repo's default branch
      is an unreleased, unaudited Kernel v4 on EntryPoint v0.9; ZeroDev
      was acquired by Offchain Labs in August 2025). Second source:
      Nexus (stronger security process; ranked second because
      development moved to a hosted product, a July 2026 undeployed-
      account takeover fix, and AGPL beta Smart Sessions). Later option:
      Safe (strongest core, $1M bounty, formal verification; but Safe7579
      is outside the bounty, no v2.0.0 audit found, and Safe cannot be a
      7702 target). Not default: Alchemy MAv2 (ERC-6900, conflicts with
      D6), Coinbase Smart Wallet (EntryPoint v0.6, not modular),
      Etherspot (thin audits, its 7702 path delegates to Kernel).
      FINDINGS FOR THE CHAIRPERSON: (a) 7702 may not need EntryPoint
      v0.8 (plan corrected above); (b) ADR D1 caveat — once social
      recovery or a signer swap replaces the seed-derived owner, the
      account address can no longer be recomputed from the seed, so the
      wallet must persist each account's address and owner changes as
      recovery metadata; (c) BundleBear labels 2.34M live 7702
      delegations as pointing at "Crime" contracts, supporting D6's rule
      that the wallet never signs dApp-requested authorizations; (d) an
      open question for counsel on (L)GPL/AGPL contract use by a
      closed-source app (Safe LGPL, MAv2 GPL, Smart Sessions and
      Rhinestone modules AGPL). Thin evidence (section 20): value
      secured (only Safe publishes a figure, and its two figures
      conflict), first-mainnet dates, adoption methodology, Kernel
      v3.3 audit/bounty, Safe7579 v2 audit, the claimed July 2026 Nexus
      Pashov report, formal verification outside Safe/Coinbase, React
      Native statements for Biconomy/Alchemy SDKs, module portability
      across 7579 implementations. Section 18's corrections to
      SESSION_KEYS.md (Draft status, the Pimlico-not-OpenZeppelin
      attribution, Nexus adoption) and to this file's 7702 assumption
      were applied by the CTO the same day.

- [x] Item 1 LIVE on Sepolia (2026-10-01, CTO run, dev wallet, test ETH
      only): KERNEL SMOKE PASSED. Kernel v3.3 account
      0xc995E49acA5C888F4FF1E50E8467E9fFc31CC5AC (index 0, owner = the
      dev seed EOA 0x16DA2CAeaDa26516F919C6872F6C38AB378CaC5C) deployed
      at the engine-predicted address; funded by tx 0x25ead6e4…86b1.
      Op 1 (deployment + ERC-7579 batch): Alchemy's bundler REJECTED the
      meta-factory deployment op with -32502 "account uses banned opcode:
      CREATE2" (the same class of bundler strictness seen with the
      SimpleAccount factory in phase 2), so the script self-bundled it
      via EntryPoint.handleOps — tx 0xbd739aed…9179e, status 0x1,
      UserOperationEvent success=true, userOpHash 0xb2ea250a…cfc753.
      Post-deployment checks: rootValidator() = the ECDSA validator and
      the validator's stored owner = the dev EOA (D1 holds on-chain).
      Op 2 (deployed path, single execution) was ACCEPTED by Alchemy's
      bundler: userOpHash 0xb2310097…259c0c, receipt success=true, tx
      0x6538b6fc…9cdd9e. Follow-up probe launched the same day: the
      direct-factory deployment path (KERNEL_DIRECT_FACTORY=1,
      KERNEL_INDEX=1) to learn whether the bundler accepts Kernel
      deployments at all without self-bundling — users cannot
      self-bundle, so a bundler-acceptable deployment path (or a
      different bundler vendor) is a production requirement to settle
      during vendor selection.

- [x] Direct-factory probe (same day): KERNEL SMOKE PASSED again for
      index 1 (0x959E8dF4f03033134A791f887209B75aeb13D95a; funding tx
      0x090033cb…22e0; self-bundled deployment tx 0x59fa02d3…7583f; op
      2 ACCEPTED by the bundler, userOpHash 0xe8c4dc02…65cb0c). But
      Alchemy's bundler rejected the deployment op on BOTH Kernel paths,
      for two different ERC-7562 reasons (rules quoted from
      eips.ethereum.org/EIPS/eip-7562, 2026-10-01):
      * meta-factory path: -32502 "account uses banned opcode: CREATE2".
        OP-031: "CREATE2 is allowed exactly once in the deployment frame
        and must deploy code for the sender address"; EREP-060/061: a
        staked factory may use CREATE2 itself, and may employ a utility
        contract only for CREATE. Kernel's staked meta factory delegates
        the CREATE2 to the inner KernelFactory (a utility contract under
        this reading), which rundler rejects.
      * direct-factory path: -32502 "Sender storage at (address:
        0x845a…ce57 [the ECDSA validator] slot …) accessed during
        deployment. Factory (or None) must be staked". STO-021/022:
        access to the account's associated storage in a non-entity
        contract during deployment is allowed only if the account
        already exists or the factory is staked — the direct
        KernelFactory is unstaked (only the meta factory is).
      CONSEQUENCE: with Alchemy's bundler, Kernel v3.3 accounts can be
      USED once deployed (op 2 accepted both times) but cannot be
      DEPLOYED through it; users cannot self-bundle. Bundler vendor
      selection must therefore test deployment acceptance explicitly.
      Candidates to test: ZeroDev's own bundler and Pimlico (both need
      an API key — INPUT NEEDED from the Chairperson, free tiers exist),
      or deploying our own staked factory that performs the CREATE2
      itself. The same strictness hit the SimpleAccount factory in
      phase 2 (AA13), so this is a property of the vendor, not of
      Kernel alone. Nothing on mainnet was touched.

- [x] INFRA FINDING RESOLVED (commit 482a6c3): ordered keyless default
      RPC fallbacks per chain, all live-verified 2026-10-01 and cited to
      provider pages — Ethereum: ethereum-rpc.publicnode.com (documented
      canonical, currently down, kept first so it recovers automatically)
      then ethereum.publicnode.com; Sepolia:
      ethereum-sepolia-rpc.publicnode.com (no second documented keyless
      endpoint found); Bitcoin: blockstream.info/api then
      mempool.space/api; Solana: api.mainnet.solana.com (now named first
      on solana.com's clusters page), api.mainnet-beta.solana.com,
      solana.publicnode.com; Dogecoin unchanged (not set).
      app/src/config/endpoint-probe.ts probes candidates in order with a
      4 s timeout and a chain-identity check per CAIP-2 namespace
      (eth_chainId; Esplora /block-height/0 genesis hash; Solana
      getGenesisHash), caches the choice in memory only, re-probes after
      reportEndpointFailure, never returns a wrong-chain endpoint even as
      a last resort, and never probes around a user override; Settings
      shows "default (2 of 2: ethereum.publicnode.com)" plus a note when
      the primary is unreachable. Rejected candidates recorded in the
      file comments (key-required: ankr, drpc free plan; down:
      rpc.sepolia.org, eth.llamarpc.com, solana-rpc.publicnode.com,
      1rpc.io/sol; undocumented: ethereum-sepolia.publicnode.com).
      Flags: ethereum.publicnode.com and solana.publicnode.com are
      PublicNode page hostnames observed to accept JSON-RPC, not
      documented RPC URLs (each probe still verifies chain identity);
      mempool.space answers GET /fee-estimates in the right shape but
      documents only /api/v1/fees/recommended; only Home balances switch
      endpoints mid-session (other screens pick the healthy default at
      lookup time and move after the next failure report, the 10 s
      all-down window, or relaunch). Verified: check-rpc-fallback.mjs
      67/67 offline (71 with --live); all 16 app suites green incl.
      check-tokens 28/28 through the fallback; tsc clean; expo export
      bundles.

- [x] Items 3 and 5, engine halves (commit 8e56463; chains-evm 209
      tests, engine 445). Item 3 — packages/chains-evm/src/erc1271.ts
      (isValidSignature call, strict bytes4 decode, verifyContractSignature
      with valid / no-code / rejected / reverted / malformed-return
      outcomes), erc6492.ts (wrap/detect/strict unwrap; verification in
      the ERC's order — envelope → simulated deploy + isValidSignature
      via eth_simulateV1, deployed → ERC-1271 then a prepare retry, no
      code → ecrecover; plus verifyWithDeploylessValidator for
      caller-supplied bytecode so no third-party compiled bytecode is
      pinned), erc7739.ts (TypedDataSign implicit/explicit and
      PersonalSign builders returning the exact EIP-712 request so the UI
      can show what is signed; a TypeScript port of the reference
      verifier; detectErc7739Support; ERC-5267 readEip712Domain),
      account-signatures.ts (signHashForSmartAccount: the account's
      ERC-1271 envelope plus the ERC-6492 wrapper when undeployed;
      REFUSES accounts without ERC-1271 so a raw owner signature is never
      presented as the account's). SmartAccountSpec gained optional
      signErc1271; Kernel implements it (envelope 0x01 || ECDSA validator
      || 65-byte signature over Kernel's EIP-712 "Kernel(bytes32 hash)"
      wrapper under the account's own domain — name "Kernel", version
      "0.3.3", chain id, proxy address — same as the ZeroDev SDK).
      Sources: ERC-1271/6492 (Final) and ERC-7739 (DRAFT) texts at pinned
      ethereum/ERCs commits, Kernel v3.3 sources, solady at Kernel's pin,
      ZeroDev SDK, account-abstraction v0.7.0; selectors/magic values/
      typehashes recomputed with keccak and pinned against ethers; digests,
      wrapped signatures and 6492 envelopes byte-identical to viem 2.57.2
      (installed in the scratchpad only). FINDINGS: Kernel v3.3 does NOT
      implement ERC-7739 (no TypedDataSign/PersonalSign anywhere; its own
      wrapper blocks cross-account/chain replay but shows the owner only
      a hash); SimpleAccount v0.7.0 has NO isValidSignature at all (its
      spec leaves signErc1271 undefined). Live read-only check
      (scripts/testnet/signature-check.mjs, Sepolia, public test
      mnemonic, re-run by the CTO: ALL CHECKS PASSED): the counterfactual
      Kernel account's 768-byte 6492-wrapped message signature validates
      through our flow AND through ox 0.9.3's deployless validator
      bytecode independently; wrong message, chain-id-1 binding and a
      flipped byte are rejected; the 7739 probe against Kernel reverts;
      isValidSignature on the deployed SimpleAccount reverts. Unverified:
      ERC-7739 against a real 7739 account (none found deployed); explicit
      mode only against our port (viem orders the type string main-type-
      first, which our port would reject for non-alphabetically-first
      main types). App wiring (item 3 app half): use signHashForSmartAccount
      for personal_sign / eth_signTypedData_v4 when the WC session is bound
      to the smart account, and always show the ORIGINAL request before
      the owner key signs, because Kernel's wrapper exposes only a hash.
      Item 5 — approvals.ts (getErc20Approvals: latest Approval per
      spender by block/logIndex, revocations kept distinct from
      never-seen, skipped/scanned counts; getErc20Allowance + 
      withCurrentAllowances re-read live state per record — OpenZeppelin
      v5 transferFrom and USDT lower allowances WITHOUT an Approval event,
      so logs are history, not state; encodeErc20Revoke = approve(spender,
      0); USDT's approve requires zeroing first, cited from its verified
      source; getOperatorApprovals / isApprovedForAll / encodeSetApprovalForAll;
      Permit2-style allowances are invisible to token logs — design
      note), contract-risk.ts (classifyRecipient eoa / contract /
      delegated-eoa with the EIP-7702 0xef0100||address 23-byte indicator
      verified from the Final EIP; isFirstInteraction trusts a Transfer
      log ONLY if non-zero AND eth_getTransactionByHash shows from == me,
      because anyone can emit a fake Transfer naming the wallet — the
      address-poisoning mechanism — capped by maxTxLookups; plain ETH
      transfers are invisible to logs so known:false means unknown;
      findCodeDeploymentBlock binary search, ~28 calls over 24M blocks;
      riskSignals aggregator: unlimited-approval, operator-approval,
      first-interaction-unknown, new-contract, delegated-eoa,
      no-code-recipient-with-calldata, severity warning/notice, no
      scores). Live probe (ethereum.publicnode.com): free endpoints
      answer historical eth_getCode only to latest-64 (older → -32602
      "Archive requests require a personal token"), so the app must treat
      age as unknown and raise no signal on failure; the standard public
      test address 0x9858…Da94 is EIP-7702-delegated on mainnet
      (0xef0100 8a67b5020ee254ef48e3b6a04927f39baf7e408a).

- [x] Item 5, app half (commit; the Settings "Token approvals" link is
      in SettingsScreen.tsx and lands with the next commit because that
      file was mid-edit by the AA builder). app/src/wallet/approvals.ts:
      tracked ERC-20s by exact CAIP-2 match plus NFT collections from the
      gallery cache (spam skipped and counted); 9,000-block windows newest
      first, 4 contracts in parallel, 8 windows per step, a window counts
      only if every query succeeded, the first endpoint refusal stops the
      scan and is recorded verbatim; LIVE re-read (withCurrentAllowances /
      isApprovedForAll) decides active vs could-not-confirm vs revoked —
      logs never do; "Unlimited" only at exactly MAX_UINT256 (never
      masked by Hide amounts; finite values are); Tether zero-first note
      on mainnet USDT; revoke = approve(spender,0) / setApprovalForAll(op,
      false) through prepareEvmSend + sendEvm (no second signing path),
      with the erc20TransferReturnedFalse gate. ApprovalsScreen (route
      Approvals; Home Ethereum row + Settings link): explainer, searched
      range, refusal WarningBox, active / could-not-confirm / collapsed
      revoked lists, spender = exact-match contact name WITH full address
      or address + contract/EOA/delegated-EOA tag, revoke confirm with
      network badge, From account, fee, BalanceChangePreview, eth_call
      gate + override, biometric gate, txid + explorer. app/src/wallet/
      risk.ts + components/RiskWarnings.tsx: gatherRiskFacts never throws
      (classifyRecipient, bounded contract age, first interaction on
      counterparty ?? to, approvals from preview changes with a top-level
      approve/setApprovalForAll calldata fallback); computeRiskLines pure;
      one-line drop-in `<RiskWarnings url wallet to data [counterparty]
      [assetChanges] />` NOT yet placed in SendScreen/SwapScreen/
      WcApprovalSheet (CTO follow-up after the AA builder lands). PRODUCT
      CHOICE to review: NEW_CONTRACT_THRESHOLD_BLOCKS = 50,400 (7 days at
      the ethereum.org 12 s slot; measured 12.05 s mainnet / 12.07 s
      Sepolia) — a judgement, not a standard. Verified: check-approvals.mjs
      99/99 offline (revoke calldata == ethers; offline revoke
      sign+broadcast decoded for ERC-20 and operator revokes; 7702 tag;
      evidence rules; archive-refused → no new-contract line); all 16
      other suites green; tsc clean on these files; expo export bundles.
      Live read-only probe: a real USDC approver's 3 approvals were all
      spent to 0 and correctly listed as revoked/used up. NEW INFRA
      FINDING: ethereum.publicnode.com refuses eth_getLogs with fromBlock
      more than ~10,000 blocks behind head (-32602 "Archive requests
      require a personal token"; Sepolia served 50,000), so on the
      default mainnet endpoint the approvals manager sees ~30 hours and
      says so — and token-history.ts's 8-window fallback will error on
      page 2+ there. Follow-up: cap the fallback lookback to the
      endpoint's answered depth and surface it honestly. Known limits
      stated on screen: Permit2-style allowances, untracked tokens,
      collections beyond the first NFT page, older than the searched
      range; ERC-721 approve(address,uint256) shares the ERC-20 selector,
      so the calldata fallback can over-warn on an NFT approve with
      tokenId = max (the preview's changes avoid this when passed).

- [x] Items 1–3, app halves (commit 9b0b568; ESLint config in 474f5dd
      with a 44-error / 7-warning baseline to burn down). aa.ts: account
      type 'simple' | 'kernel-v3.3' per EVM chain (older configs read as
      simple); setAaKernelFactory = eth_chainId check + the engine's
      verifyKernelDeployment against the pinned KERNEL_V3_3 (same
      addresses on mainnet and Sepolia, pre-filled); createAaClient builds
      the chosen spec, salt = account index, owner = active EOA for both
      types; prepareAaCalls (any call list, checks the smart account's
      token balance), prepareAaErc20Send / maxAaErc20Send (one transfer
      call — a transfer from the smart account needs no approve); sendAa
      refuses before signing if the signer's smart account is not the
      quoted sender; describeAaError keeps the bundler's rejection text
      verbatim; DRIVE-BY FIX: setAaPaymaster verified against mainnet's
      chain id even when saving a Sepolia paymaster. swap.ts: aaSwapCalls
      = [approve(spender = quote transaction.to, EXACT sell amount),
      swap] for ERC-20 sells, [swap] for native; prepareAaSwap quotes the
      batch; SwapScreen "Swap from smart account" toggle makes the smart
      account the 0x taker and sends ONE UserOperation, listing every
      call on confirm. SendScreen token mode gained the smart-account
      toggle (NFT mode still not); the AA confirm shows the account type,
      smart-account balances, the Kernel bundler note, a batch-aware
      preview (BalanceChangePreview gained an additive `batch` prop that
      simulates as the smart-account sender) and "Bundler gas estimate
      passed". Settings AA section: type selector, Kernel pre-fill with
      verified status, saving one type replaces the other with a warning.
      WalletConnect: proposals offer "connect as EOA or smart account"
      (warning before connecting that SimpleAccount cannot sign); bindings
      keyed by chain + smart-account address, written BEFORE
      approveSession; smart-account sessions sign personal_sign /
      eth_signTypedData_v4 via signHashAsSmartAccount (ERC-1271 envelope,
      ERC-6492 when undeployed) with the ORIGINAL content shown and a
      validator note; eth_sendTransaction rides sendCalls with one call
      and answers the bundle tx hash after inclusion (120 s), else -32603
      naming the userOpHash (no ERC defines this); requests served only
      while the binding's owner is the active account, unknown session
      address fails closed (5103). ERC-5792 per EIP-5792 (Final,
      ethereum/EIPs commit 5b0c8dce, 2025-10-07), offered only on
      smart-account sessions: wallet_getCapabilities → {activeChainHex:
      {atomic: {status: "supported"}}} ({} on EOA sessions, 4100 for an
      address not in the session); wallet_sendCalls — version "2.0.0",
      chainId hex without leading zeros (-32602 otherwise; non-active
      chain 5710), from must equal the bound smart account (4100),
      atomicRequired boolean, calls[{to,data,value}] (missing `to`
      -32602, wallet policy), non-optional capabilities 5700, >16 calls
      5740 (policy), duplicate app ids 5720, result {id} once the bundler
      accepts (generated id = 32 random bytes || userOpHash);
      wallet_getCallsStatus → {version,id,chainId,status 100/200/500,
      atomic:true,receipts?} (unknown id 5730; receipts omitted rather
      than guessed; receipt gasUsed is the bundle tx's gas — a judgement
      call). Quirk recorded: the ERC's own example writes chainId "0x01"
      against its normative no-leading-zeros rule; the rule is followed,
      so such a dApp is refused. Verified offline: check-aa-kernel.mjs
      74/74 (all Kernel save refusals persist nothing; sender
      0xB67b…9a42 for the standard owner at index 0; full Kernel
      stub→estimate→sign→send with the signature recovered by ethers;
      token-send and swap batches decoded by ethers), check-wc-5792.mjs
      89/89 (parse/refuse/response shapes; 1271/6492 signatures validated
      by the engine verifier against a fake eth_simulateV1 whose Kernel
      emulation recovers the owner; SimpleAccount refusal; declines);
      all 19 app suites green (re-run by the CTO); tsc clean; expo export
      bundles (6.8MB) with the new strings. NOT verified: anything live
      (Sepolia run pending, steps recorded in the builder's report:
      Kernel config save, the rejection path on an undeployed account,
      the deployed path with the dev seed's 0xc995…C5AC, a smart-account
      Uniswap session with 5792 or eth_sendTransaction, 1271/6492 signing
      checked with scripts/testnet/signature-check.mjs, declines);
      whether Uniswap uses 5792 or accepts 1271/6492; whether a 0x quote
      accepts an undeployed taker; on Sepolia the in-app smart-account
      token send and swap cannot be exercised (tokens are mainnet-only,
      0x lists no Sepolia) — batching there is testable only via
      wallet_sendCalls. RiskWarnings was placed in SendScreen, SwapScreen and
      WcApprovalSheet in commit be0656e (noted 2026-10-02 by the threat
      model review; this entry previously said it was still pending).

## Phase 7 live validation (2026-10-01, emulator, Sepolia)

FIRST IN-APP SMART-ACCOUNT SEND, PROVEN LIVE. Setup: Settings → Account
Abstraction → Ethereum Sepolia: the Alchemy Sepolia bundler URL passed
"Verified ✓ — eth_supportedEntryPoints includes EntryPoint v0.7", the
account type Kernel v3.3 was selected, and the pre-filled KernelFactory
passed "Verified ✓ — factory, implementation 0xd6CE…5b28, meta factory
and ECDSA validator have code; entrypoint() is v0.7; accountId() is
kernel.advanced.v0.3.3; the meta factory approves the factory". Because
Alchemy's bundler rejects Kernel deployment ops, the emulator wallet's
Kernel account for Account 1 (owner 0x772e…F44F, index 0) was deployed
from the dev EOA with the new scripts/testnet/kernel-deploy-for-owner.mjs
(KernelFactory.createAccount is permissionless; the owner's key is not
involved): account 0xD31c2C54F21684eE2026a6C41e391130BdEeD8FA, deployment
tx 0x003e2271…e4f2, rootValidator() == the ECDSA validator, funded
0.003 test ETH (tx 0x5d61035c…f9c5; a 21,000-gas transfer to a deployed
Kernel account FAILS because its receive path runs code — the helper
estimates gas). In the app, Send ETH with "Send from smart account" ON
showed a confirm with "EXPERIMENTAL · ERC-4337 smart account · Kernel
v3.3", OWNER ACCOUNT (SIGNS) Account 1, FROM SMART ACCOUNT 0xD31c…D8FA,
balance 0.003, "Already deployed", a bundler gas estimate, the saved
contact "Burn" notice, and the balance-change preview "You send 0.0001
test ETH" simulated as the smart-account sender.
BUG FOUND AND FIXED LIVE: the first attempt was refused by the bundler —
"RPC error -32000: precheck failed: maxPriorityFeePerGas is 1000000 but
must be at least 100000000 (eth_sendUserOperation)" — shown verbatim in
the app. Sepolia's node suggests 0.001 gwei; the bundler's documented
rundler_maxPriorityFeePerGas answered 0x5f5e100 = 0.1 gwei (live
probe). aa.ts now asks the bundler for its floor best-effort
(bundlerPriorityFeeFloor; method-not-found or a malformed answer → null)
and applyPriorityFeeFloor raises the pair; check-aa.mjs 65/65 (8 new
checks). NOTE: the search summary for Alchemy's docs mentioned the method
as deprecated on 2026-09-30, but the fetched page showed no such notice —
unverified; if it disappears, the helper degrades to the node suggestion
and the bundler's verbatim error remains the fallback signal. Retry with
the fix: max fee rose from 2.523 to 2.713 gwei on the confirm, the send
passed the biometric gate, the success screen showed the userOpHash
0x855de289bcc12e7ae159d038a8f61aad8e7ce4d091e6df65363772024e33f43b,
"Bundling… waiting for the UserOperation receipt", then "Included
on-chain — succeeded." with bundle tx
0xe18921543ac17a0e7e9167bb6a3f07755dd5d80eb9ae281a5aa92b09fc066e9a;
independently confirmed on Sepolia: block 0xb46f2e, status 0x1, to =
EntryPoint v0.7, one UserOperationEvent with sender 0xD31c…D8FA.
PRODUCT FINDING: the Settings AA section renders the full bundler URL,
API key included, in plain text; it should show the host only (the
history-indexer row has the same exposure). Filed as a follow-up.
EMULATOR NOTES: React Native LogBox toasts ("Cannot connect to Expo
CLI" when Metro runs with CI=1, plus a WalletConnect core log at pino
level 50 whose text had rolled out of logcat before it was read)
intercept taps near the bottom of the screen in dev builds; Metro must
run WITHOUT CI=1 for file edits to be served (CI mode disables watch).
Not yet exercised live: the rejection path for an undeployed smart
account in the app, smart-account WalletConnect sessions (5792 /
1271-6492 signing) and the decline paths — the first needs only the
emulator (Account 2's Kernel account is undeployed), the rest need a
dApp session.

- [x] PRODUCT FINDING RESOLVED (same day): Settings rows that show a
      stored URL (bundler, paymaster, history indexer, NFT indexer) now
      render maskUrlForDisplay(value) — scheme and host only, with "/…"
      or "?…" for anything after — so an embedded API key is never on
      screen; the stored value and the editor are unchanged. check-aa.mjs
      71/71 (6 new masking checks); tsc clean.

## Phase 7 complete (2026-10-01)

All five build items landed and are pushed: Kernel v3.3 (ERC-7579) as a
selectable smart-account type (engine spec + app), batching with ERC-5792
over WalletConnect, smart-account signatures (ERC-1271/6492/7739 engine
+ smart-account-bound sessions), the NFT gallery and send (Chairperson
requirement 6), and risk warnings plus the approvals manager; plus the
framework comparison (docs/AA_FRAMEWORKS.md), the RPC fallback list, the
Expo ESLint baseline, and the live-found fixes (bundler priority-fee
floor, Settings URL masking). Engine: 445 tests across five packages.
App: 19 offline suites, 1,531 checks (test-units 45, check-aa 71,
check-aa-kernel 74, check-wc 197, check-wc-5792 89, check-token-send
37, check-swap 89, check-devmode 71, check-qr 31, check-tokens 28,
check-doge 83, check-token-history 17, check-simulation 49,
check-prices 110, check-contacts 110, check-accounts 111, check-nfts
120, check-rpc-fallback 67, check-approvals 99). Live on Sepolia: two
Kernel accounts deployed and operated from the smoke harness, and the
first in-app smart-account send through Alchemy's bundler, included
on-chain.

Open items carried forward:
- Bundler vendor selection must require Kernel DEPLOYMENT acceptance
  (Alchemy rejects both Kernel factory paths under ERC-7562); needs a
  ZeroDev or Pimlico key from the Chairperson to test.
- Mainnet readiness conditions C1–C3 for Kernel (audit of the shipped
  version, bounty coverage, v3 support horizon) from AA_FRAMEWORKS.md.
- Live smart-account WalletConnect sessions (5792, 1271/6492 signing)
  and the undeployed-account rejection path in the app; live NFT send
  (needs a test NFT); counsel review of (L)GPL/AGPL module use.
- Follow-ups: cap the no-indexer token-history lookback to the
  endpoint's answered depth; a Sepolia RPC fallback; ESLint burn-down
  (44 errors); emulator pass over the NFT, approvals and risk screens.
- Phase 8 headline: EIP-7702 (verify the v0.7 authorization path on
  Sepolia first), then session keys and passkeys on the Kernel base.

## Phase 8 plan (approved 2026-10-01): the programmable-account phase

Inputs received the same day: a ZeroDev project id (stored ONLY in the
git-ignored .dev-wallet/env as ZERODEV_PROJECT_ID — never commit it;
URL format https://rpc.zerodev.app/api/v3/{projectId}/chain/{chainId}
per docs.zerodev.app/meta-infra/rpcs, which also documents a
?provider= selector with ULTRA_RELAY / ALCHEMY / GELATO / PIMLICO and
says the RPCs "support all standard methods defined in the ERC-4337
spec"; read-only probe: Sepolia answers eth_chainId 0xaa36a7,
eth_supportedEntryPoints includes v0.7, rundler_maxPriorityFeePerGas
is NOT served (-32601) while pimlico_getUserOperationGasPrice IS).

1. EIP-7702 for the plain EOA (Tier 2 feature 23; the "acquisition
   weapon"): verify from ZeroDev's documentation and on Sepolia how a
   7702 delegation to Kernel v3.3 is authorized under EntryPoint v0.7
   (the frameworks doc found 7702 on v0.7 documented but the submission
   path unverified); engine support for the EIP-7702 authorization
   (type-4 transaction and/or the UserOperation field the bundler
   expects); app "Upgrade this account" flow that turns Account N's EOA
   into a Kernel account AT THE SAME ADDRESS with a plain explanation, a
   visible delegation status, and a revocation path (delegate to the
   zero address). D6 stands: the wallet never signs a dApp-requested
   authorization; BundleBear's 2.34M "Crime" delegations are the
   reason.
2. Session keys (Tier 2 feature 18) on Kernel's permission plugins
   (signer + policies: call, gas, timestamp, rate limit) per
   docs/SESSION_KEYS.md: engine install/revoke of a scoped session
   validator, app UI to grant a dApp a bounded session (contract,
   spending cap, expiry), and ERC-7715 wallet_grantPermissions over
   WalletConnect as the dApp-facing entry point. Pin to the ZeroDev
   permissions release and audit status; MIT.
3. Passkey signer (feature 21): Kernel's WebAuthn validator in the
   engine (P-256 signature envelope, verified against the validator
   source) and the app flow behind a development build (passkeys need
   native modules; Expo Go cannot) — engine + design first, device test
   when the EAS build exists.
4. Social recovery / guardians (feature 20): Kernel recovery module
   evaluation and engine support, plus the recovery metadata the
   frameworks doc requires once an owner can change (persist each
   account's address and owner history; D1 caveat).
5. Bundler vendor selection: record ZeroDev's deployment-acceptance
   result from the smoke; generalize the app's fee-floor helper to the
   methods each vendor serves (rundler_maxPriorityFeePerGas,
   pimlico_getUserOperationGasPrice); per-chain bundler choice stays
   runtime config.
6. Follow-ups and standing items: cap the no-indexer token-history
   lookback to the endpoint's answered log depth; a Sepolia RPC
   fallback; ESLint burn-down; emulator pass over the NFT, approvals and
   risk screens; live smart-account WalletConnect sessions; Dogecoin
   mainnet broadcast; live 0x quotes; live paymaster; EAS build;
   counsel on (L)GPL/AGPL modules.

Wave 1: item 1 (engine + Sepolia verification, agent) and item 2's
engine half (agent) in parallel; item 5's fee-helper generalization
(CTO). Wave 2: app flows for 1 and 2, then 3 and 4. Subagents on Opus.

## Phase 8 progress

- [x] Item 5, first result — ZeroDev bundler DEPLOYMENT ACCEPTANCE,
      PROVEN LIVE (2026-10-01): kernel-smoke.mjs against
      https://rpc.zerodev.app/api/v3/{project}/chain/11155111 (default
      provider), KERNEL_INDEX=2, KERNEL_FUND_ETH=0.004, NO self-bundle
      fallback: the deployment op through Kernel's staked meta factory was
      ACCEPTED by eth_sendUserOperation (userOpHash 0x2e5d4ca7…0777f),
      account 0x1D723b78e1D0D84Fd0531e2686285fb1B6414106 deployed at the
      engine-predicted address (funding tx 0xf9aa021d…93f6), and op 2 on
      the deployed path was accepted as well (0x3ea04337…cf6847). Same
      engine bytes that Alchemy rejects under its ERC-7562 reading. The
      ZeroDev endpoint's supported EntryPoints include v0.6, v0.7 and the
      two 0x4337… addresses. Consequence: Kernel deployments require a
      bundler that accepts them (ZeroDev proven; Pimlico untested);
      Alchemy remains usable for already-deployed accounts. The app's
      per-chain bundler URL is runtime config, so a user pastes the
      ZeroDev URL (it embeds the project id, which the Settings row now
      masks). Fee note: ZeroDev does not serve rundler_maxPriorityFeePerGas
      (-32601) but does serve pimlico_getUserOperationGasPrice, so the
      app's floor helper must learn that method (item 5 follow-up).

- [x] Item 1, engine half — EIP-7702 to Kernel v3.3 (commit 68d7383;
      17 new tests, chains-evm 226, engine 462). The three questions,
      answered from sources: (1) EIP-7702 (Final, ethereum/EIPs
      eip-7702.md at bbc3f958): tx type 0x04; tuple [chain_id, address,
      nonce, y_parity, r, s] signed over keccak(0x05 || rlp([chain_id,
      address, nonce])), low-s; code becomes 0xef0100 || address; a
      self-sponsored tx needs tuple nonce = tx nonce + 1; delegating to
      the zero address clears the code; 25,000 gas per tuple. (2) Kernel
      v3.3 as delegate (tag v3.3, cd697c7e): the delegate IS the
      implementation 0xd6CEDDe84be40893d153Be9d467CD6aD37875b28 (the
      SDK's KERNEL_7702_DELEGATION_ADDRESS); NO initialization is needed
      or possible (initialize() reverts AlreadyInitialized when the code
      starts with 0xef0100); VALIDATION_TYPE_7702 = 0x00 and a
      never-initialized delegated EOA has an all-zero root validator, so
      Kernel accepts ops whose EIP-191 signature over the userOpHash
      recovers to the EOA itself; ERC-1271 signatures are 0x00 || raw
      ECDSA over the Kernel(bytes32 hash) wrapper with the EOA as the
      verifying contract; ZeroDev's quickstart has a doc bug (passes the
      version constant KERNEL_V3_3 as contractAddress). (3) EntryPoint
      v0.7 contains no 7702 code (v0.7.0 at 7af70c89): a delegated EOA
      is just a sender with code, so BOTH a self-sent type-0x04 tx and a
      UserOperation carrying eip7702Auth {chainId, address, nonce,
      yParity, r, s} (per ERC-4337's 7702 section / ERC-7769 Draft,
      Alchemy's eth_sendUserOperation schema and viem 2.57.2) work on
      v0.7; only the 0x7702 initCode marker, senderCreator
      initEip7702Sender and the EIP-712 userOpHash need v0.8 (v0.8.0 at
      4cbc0607, Eip7702Support.sol). CAVEAT: on v0.7 the userOpHash does
      not commit to the delegate, so the spec signs tuples only for the
      pinned Kernel address and refuses to replace a foreign delegation
      unless allowRedelegation is set. Engine: src/eip7702.ts
      (tuple sign/verify — refuses chain id 0 and nonces ≥ 2^64−1,
      low-s check, recovery; type-0x04 build/sign — refuses an empty
      list or missing `to`; revokeDelegationAuthorization,
      selfSponsoredAuthorizationNonce, setCodeIntrinsicGas,
      toRpcEip7702Auth, readDelegationStatus), createKernel7702AccountSpec
      + KERNEL_V3_3_7702_DELEGATE, optional
      SmartAccountSpec.getEip7702Authorization (the client then uses no
      factory and attaches the tuple), UserOperation.eip7702Auth sent on
      the wire. Tests pin the digest against ethers hashAuthorization,
      (yParity, r, s) against Wallet.authorizeSync, and type-4 bytes
      against ethers signTransaction. LIVE ON SEPOLIA (dev seed index 7,
      test EOA 0xFDF5b9520E15306980F660f6CC5DB90570B92F14, funded
      0.0015): a UserOperation carrying the tuple was accepted by
      ZeroDev's bundler (userOpHash 0x24543f93…7471; local v0.7 hash
      matched the bundler's), bundle tx 0x5504de27…4e03 is type 0x4 to
      EntryPoint v0.7 with our tuple in its authorization list, block
      11826010, status 0x1, UserOperationEvent sender = the EOA,
      success; while delegated eth_getCode = 0xef0100d6ce…5b28,
      entrypoint() = v0.7, isValidSignature = 0x1626ba7e, a third-party
      initialize() reverts; revoked by a self type-4 tx (zero-address
      tuple, nonce 2) 0xb56e13b9…cab2, block 11826011, 36,800 gas;
      eth_getCode = 0x afterwards (re-confirmed by the CTO, along with
      the bundle tx type 0x4 / status 0x1); leftover swept back
      (0xcecb1940…bbca). Alchemy accepted eip7702Auth for ESTIMATION
      only (nothing sent there). Unverified: sending the op to Alchemy;
      a live self-sponsored delegation tx (built and ethers-checked, not
      broadcast — the same builder did the live revocation); which
      upstream ZeroDev routed through; behaviour after re-delegation; no
      audit of Kernel v3.3's 7702 changes (C1). Smoke:
      scripts/testnet/eip7702-smoke.mjs (EIP7702_SMOKE_DRY_RUN=1, or
      BUNDLER_URL=ZeroDev + PROBE_BUNDLER_URL=Alchemy live; URLs
      redacted). App design note recorded in the builder's report:
      "Your address stays the same…", status from readDelegationStatus
      (plain / upgraded / delegated elsewhere → warning + revoke),
      revocation always available as a self type-4 tx (~37k gas, needs
      ETH, cannot be sponsored), D6 enforced (tuples only from this
      flow, pinned delegate, single chain, after the biometric gate).
      FUNDS: the dev EOA 0x16DA…C5C is down to ~0.002 Sepolia ETH and
      needs a top-up before further live runs.

- [x] Item 2, engine half — session keys on Kernel v3.3 permission
      plugins (commit; 48 new tests, chains-evm 274, engine 510).
      packages/chains-evm/src/kernel-permissions.ts: SessionKeyGrant
      (allowed calls: target, selector | null, per-call value cap,
      parameter rules; validAfter; MANDATORY validUntil; optional
      gasBudgetWei and rateLimit; serialize/parse), validateSessionKeyGrant
      refuses empty call lists, wildcard (zero-address) targets, duplicate
      target/selector pairs, rules without a selector, multi-param rules
      other than oneOf, expired / open-ended / out-of-uint48 windows, and
      — SECURITY-CRITICAL — any self-call with calldata or value, because
      a self-call passes Kernel's onlyEntryPointOrSelfOrRoot and could
      install a sudo permission or upgrade the account. Mapping: policies
      [call, timestamp, gas?, rateLimit?] + ECDSASigner with flag 0x0002
      SKIP_SIGNATURE (deliberately not the SDK default 0x0000) so a session
      key can never produce an ERC-1271 signature for the account.
      computePermissionId, permissionValidationId, sessionNonceKey
      (default/enable mode, parallel key), encodePermissionInstall
      (enable-mode EIP-712 "Enable" digest + typed data for the root owner,
      and explicit root-signed installValidations + grantAccess calls),
      signPermissionEnable, encodeEnableModeSignature, signWithSessionKey
      (0xff || EIP-191 signature), sessionStubSignature,
      encodePermissionRevoke (uninstallValidation with policyCount+1 empty
      deinit entries), readKernelPermissionState, readSessionSigner,
      prepareKernelPermissionInstall (validates offline first; refuses
      permission ids already used — policies keep a "Deprecated" status),
      kernelSessionSpec (a SmartAccountSpec that signs ONLY with the
      session key, refuses the owner key and undeployed accounts, checks
      calls against the grant locally before signing; routeNode rewrites
      only the client's getNonce(account, 0) to the permission nonce key —
      a cleaner optional nonce-key hook on SmartAccountSpec is a follow-up
      for smart-account.ts), createSessionKeyAccount /
      generateSessionPrivateKey (noble), grantToErc7715Request /
      grantFromErc7715Request. Sources: Kernel v3.3 (cd697c7e)
      ValidationManager.sol / Kernel.sol / ValidationTypeLib.sol /
      Constants.sol (ENABLE_TYPE_HASH recomputed from the type string);
      ZeroDev SDK cd7c05b5 plugins/permission; deployed module addresses
      from the SDK constants, identical code on Sepolia and mainnet:
      ECDSASigner 0x6A6F069E2a08c2468e7724Ab3250CdBFBA14D4FF, CallPolicy
      v0.0.4 0x9a52283276A0ec8740DF50bF01B28A80D880eaf2 (v0.0.5 has code
      but no verified source — not used), TimestampPolicy
      0xB9f8f524bE6EcD8C945b1b87f9ae5C192FdCE20F, GasPolicy
      0xaeFC5AbC67FfD258abD0A3E54f65E70326F84b23, RateLimitPolicy
      0xf63d4139B25c836334edD76641356c6b74C86873, SudoPolicy
      0x67b436caD8a6D025DF6C82C5BB43fbF11fC5B9B7. Source binding: the
      current kernel-7579-plugins master (332deed6) is a 2026 rewrite that
      no longer contains the deployed policies; ECDSASigner, CallPolicy,
      GasPolicy, RateLimitPolicy and SudoPolicy are Sourcify full matches
      on chain 1; TimestampPolicy is verified nowhere and was reproduced
      byte for byte by compiling plugins commit d4855f5 against kernel
      49842d56 with solc 0.8.24 (via-IR, runs 200, paris, no CBOR).
      Tests byte-compare against @zerodev/permissions 5.6.3 + @zerodev/sdk
      5.5.10 + viem 2.57.2 (scratchpad-only installs): permission id,
      validation id, validatorData, enable digest, install/grantAccess/
      uninstall calldata, both nonce keys, userOpHash, session signature,
      stub and enable envelope — all identical. LIVE ON SEPOLIA (account
      index 2, ZeroDev bundler): a fresh session key 0x059942bb…01df with
      permission id 0xd0b4b7b7 (grant: 0-wei empty self-call + ≤1 wei to
      the owner, 600 s) installed AND used in one enable-mode op (bundle
      tx 0xab442884…d686f, block 11826061, status 0x1 — re-confirmed by
      the CTO); on-chain state showed hook, ECDSASigner with flag 0x0002,
      policies [call, timestamp]; disallowed calls rejected at estimation
      (InvalidCallData for a different target, CallViolatesValueRule for
      2 wei) after the engine's local refusal; root-signed revocation
      (tx 0x1c8fcf04…240e0, block 11826063, status 0x1 — re-confirmed)
      cleared hook/signer/policies; afterwards the session key is rejected
      (AA23) and replaying the enable signature fails EnableNotApproved.
      Smoke: scripts/testnet/session-key-smoke.mjs (SESSION_SMOKE_DRY_RUN=1
      ran six eth_simulateV1 stages and passed; CTO re-ran the dry run).
      FINDINGS FOR THE CHAIRPERSON: (a) no published audit covers the
      permission policies or ECDSASigner — ZeroDev's audits link 404s, the
      "kalos_v3_plugins.pdf" is the factory assessment, and the v3.1
      incremental covers WebAuthn/weighted validators and the
      SpendingLimit hook — so the plugins count as UNAUDITED for mainnet
      (adds to C1); (b) the plugins repo LICENSE is MIT but the verified
      SudoPolicy source carries SPDX UNLICENSED; (c) ERC-7715 (Draft,
      ERCs 2adc3783) now names the method wallet_requestExecutionPermissions
      and its response REQUIRES an ERC-7710 delegationManager, which
      Kernel's permission validator is not — so only the request shape
      can be mapped, a compliant response cannot be produced, and the
      wallet uses its own permission type shiba-wallet:contract-calls
      (native-token-allowance refused: CallPolicy caps per call, not
      cumulatively). Caveats: GasPolicy, RateLimitPolicy, parameter rules
      and paymaster interplay encoded and SDK-pinned but not run live;
      enable-mode acceptance by Alchemy/Pimlico untested; a null selector
      also matches calldata starting with 0x00000000 (documented); do NOT
      use invalidateNonce as "revoke all" — it would break the wallet's
      ERC-1271 envelope; an unused enable signature cannot be cancelled
      before its validUntil. App design note recorded: generate session
      keys on-device into SecureStore, prefer explicit root-signed install
      when the wallet itself uses the session, show every allowed call in
      plain language with the expiry behind the biometric gate, persist
      grants per account+chain with on-chain status and a Revoke button,
      warn that grants do not survive a seed restore; 7715 over
      WalletConnect: wallet_getSupportedExecutionPermissions returns only
      the wallet type with the expiry rule, requests go through the same
      grant screen, unsupported types get an ERC-1193 error, and the
      7710 limitation is stated openly.

- [x] Item 1, app half — "Upgrade this account" (commit de71517;
      check-7702.mjs 111/111; all 20 app suites green; tsc clean; expo
      export bundles 6.9MB with the new strings). app/src/wallet/
      delegation.ts (readAccountDelegation → plain / kernel-v3.3 / other
      (with delegate) / contract, eth_chainId-checked, cached per
      chain+address, invalidated after an upgrade op, a revoke or a
      tuple-carrying op; prepareSetCodeTx / sendSetCodeTx / waitForSetCode
      for the self-sponsored type-0x04 tx to self with tuple nonce = tx
      nonce + 1 and gas setCodeIntrinsicGas(1) + 40,000 = 86,000, via
      NodeClient, deliberately with NO eth_call gate — explained on
      screen). DESIGN DEVIATION (accepted by the CTO): the kernel-7702
      type is recorded PER OWNER ADDRESS (eip7702Owners in the chain's AA
      config), not chain-wide, because a chain-wide setting would make
      another account's next smart-account send sign a tuple its user
      never asked for (D6); effectiveAaAccountType(config, owner) returns
      kernel-7702 only for upgraded owners; revoking removes the owner and
      that account reverts to the chain's previous type. Quoting uses a
      stub tuple (viem 2.57.2's dummy r/s/yParity) so no key is loaded at
      quote time; the real tuple is signed inside sendAa after the
      biometric gate, only on the first op, and only for a quote that
      announced the upgrade (a revoke between quote and send, or a direct
      client.sendCalls, is refused); a foreign delegate is refused at
      quote time ("revoke first"). UpgradeAccountScreen (Home Ethereum
      row "Upgrade" / "Upgraded ✓", Settings link): explanation, chain,
      delegate in full, the 21,000-gas receive caveat, live status, and
      the actions "Upgrade with the next smart-account send" (default
      when a verified bundler exists; cancellable while pending),
      "Upgrade now with a transaction", "Use this upgraded account" (for
      an address already delegated on-chain, e.g. after a restore), and
      "Revoke upgrade" (confirm with badge, fee, nonces, warning;
      biometric; txid + receipt poll; status re-read). "Account N ·
      upgraded (Kernel v3.3)" labels on Send From rows, the WC sheet,
      Receive and Home; a foreign delegate gets a Home warning. The
      delegated-eoa risk signal is suppressed only for the wallet's own
      addresses on the pinned delegate. D6 ENFORCEMENT (each refusal
      tested): tuples are signed only in delegation.ts sendSetCodeTx and
      the gated kernel-7702 path, for the pinned delegate or zero, on the
      active chain, after requireLocalAuth; WalletConnect
      eth_sendTransaction with authorizationList / authorization_list
      (even empty) or type 0x4 → declined 5000 with EIP7702_WC_REFUSAL
      (fields per execution-apis GenericTransaction, submit.yaml /
      transaction.yaml at d24f58b5); wallet_sendCalls capabilities whose
      name or fields mention authorization / 7702 / delegation → 5700
      even if optional (covers ERC-7902's eip7702Auth, Draft, ERCs
      8b4d4631); any method name mentioning authorization or 7702 (e.g.
      wallet_signAuthorization) → 5101; WalletConnect smart-account
      connections pass no owner, so a dApp can never reach the tuple
      path; personal_sign / typed data cannot yield a tuple signature
      (different digest prefixes). Swap's smart-account toggle also uses
      the 7702 path for upgraded accounts. NOT verified live (emulator
      checklist in the builder's report, 9 steps): ZeroDev accepting the
      viem-style stub tuple at estimation (highest risk; the error would
      show verbatim with an "Upgrade now" hint), the 21k receive caveat on
      a 7702 address, the 40k execution buffer, dApps that try ERC-1271
      before ECDSA on an upgraded EOA. Mainnet gated on C1.

- [x] Item 2, app half — session keys in the app (commit eafc3a0;
      check-sessions.mjs 99/99; all 21 app suites green, 1,711 checks;
      tsc clean; expo export bundles 7.0MB). Keys: generated on-device
      (engine generateSessionPrivateKey), stored ONLY via storage.ts
      sessionKeyVault in expo-secure-store WHEN_UNLOCKED_THIS_DEVICE_ONLY
      (same class as the mnemonic), one entry per
      chain.account.permissionId (key pattern constrained by
      expo-secure-store 57.0.4's typings); AsyncStorage
      (shiba-wallet.sessions.v1) holds only public data (grant with the
      session ADDRESS, permission id, policy count, label, createdAt,
      install mode, userOpHashes); corrupt list → empty + flag, writes
      refused until "Reset session list"; key and record saved before
      the install is submitted so a bundler refusal leaves a "failed"
      record whose on-chain status governs forgetting. Use: sendSessionCalls
      runs the engine's assertCallsAllowed FIRST (an out-of-grant call is
      refused with zero RPC calls and no key read), loads the key (must
      derive to the grant's address), builds a separate SmartAccountClient
      with kernelSessionSpec + spec.routeNode(node); signWith / the owner
      key / the mnemonic are never on this path (a test asserts the source
      has no such import); the session op's nonce carries the permission
      key and its 0xff||65-byte signature recovers to the session address.
      Install and revoke are owner-signed through the normal AA confirm
      (bundler estimate gate, biometric, signWith(owner), sendAa); install
      uses only the engine's explicit installCalls — enable mode is NOT
      used and the caveat is shown; prepareSessionInstall refuses a quote
      that would also carry an EIP-7702 upgrade (D6). Revoke →
      permissionRevokeCall; key deleted from the vault as soon as the
      bundler accepts, record "revoking" → "revoked" after receipt and
      on-chain re-read. Status via readKernelPermissionState /
      readSessionSigner: active (+expired flag) / revoked / not-installed
      / unknown. Eligibility: deployed Kernel v3.3 account, or an EOA
      whose 7702 delegation to the wallet's delegate is active on-chain;
      SimpleAccount, undeployed, or pending upgrade → refused in plain
      words. GrantReview shows every allowed call in plain language
      (full target + contact name, function via the engine's selector(),
      per-call cap "per call, not a total"; approve / setApprovalForAll
      warn that the approval outlives the session); engine refusals shown
      verbatim with no network calls. SessionsScreen (Home link, Settings
      section): wipe/restore warning, "revoke everything you no longer
      recognise", and on mainnet the no-published-audit note; wipe
      deletes session keys and the list. ERC-7715 (ERCs 2adc3783, still
      latest): offered only on Kernel smart-account connections
      (smartAccountMethodsFor; EOA/SimpleAccount → 5101);
      wallet_getSupportedExecutionPermissions → only
      shiba-wallet:contract-calls {chainIds:[active], ruleTypes:['expiry']}
      (the ERC's type says ruleTypes, its example says rulesTypes — the
      type definition is followed); wallet_requestExecutionPermissions →
      grantFromErc7715Request → the same GrantReview with the dApp name,
      narrowing only when isAdjustmentAllowed, multi-grant requests
      refused, "Only dApps that understand Kernel session keys can use
      this" stated on the sheet, install through the same explicit path,
      the dApp holds the key (the ERC's `to`), answer only after inclusion
      and read-back: [PermissionResponse] with context = the Kernel
      validation id, dependencies [], a shiba-wallet:kernelPermission
      object, and NO delegationManager (Kernel is not an ERC-7710
      manager; a made-up address would misroute dApp transactions).
      Error codes (judgement where EIP-1193 is silent): decline 4001,
      foreign from 4100, unsupported type/rule (incl.
      native-token-allowance, missing expiry) 4200, wrong chain 4901,
      malformed / engine-refused -32602, install not confirmed in time
      -32603 naming the userOpHash. wallet_revokeExecutionPermission and
      wallet_getGrantedExecutionPermissions are not offered. NOT verified
      live (highest risk first): the explicit root-signed install path
      and a successful default-mode session op (the engine's live proof
      used enable mode; default mode was exercised only in estimation
      rejections); sessions on a 7702-delegated EOA; any dApp using the
      wallet's 7715 type; the GasPolicy budget; the engine signing
      function's key copy cannot be zeroed (only the app's buffers are).
      Emulator checklist (9 steps) in the builder's report.

## Phase 8 live validation (2026-10-01, emulator, Sepolia)

FIRST IN-APP EIP-7702 UPGRADE, PROVEN LIVE. Setup: the Sepolia bundler
was switched in Settings to ZeroDev (URL embeds the project id; the
Settings row masks it after the reload) and reads "ready · Kernel
v3.3"; the emulator's Account 2 EOA 0xb6997390e1E3CDE9BF035Af75830Ae00C29781fE
was funded 0.0015 test ETH from the dev EOA (tx 0x8f30910c…6f30,
scripts/testnet/fund.mjs). Emulator hygiene learned: Metro now runs from
an ISOLATED git worktree of HEAD (scratchpad/wt-app, node_modules and
engine dist symlinked, a worktree-only metro.config.js override adding
the real checkout to watchFolders/nodeModulesPaths), so in-progress
agent edits can never be served to the device; the Expo floating dev
button overlaps the Home "Switch" control (tap its left edge); LogBox
toasts and the Expo dev menu intercept taps near the bottom and top
right. Flow: Home → Upgrade showed the designed explanation, the
delegate in full, the 21,000-gas receive caveat and "Regular account
(no code)"; "Upgrade with the next smart-account send" → CONTINUE →
"Cancel pending upgrade" appeared. Send ETH with the smart-account
toggle: the confirm read "EXPERIMENTAL · ERC-4337 smart account ·
Kernel v3.3 via EIP-7702 (your own address)", OWNER ACCOUNT (SIGNS)
Account 2, FROM (YOUR OWN ADDRESS) = the same EOA, balance 0.0015,
"This send also upgrades your account (EIP-7702 delegation to Kernel
v3.3)…" with the delegate 0xd6CE…5b28 in full, the preview "You send
0.0001 test ETH", and "Bundler gas estimate passed" — i.e. ZeroDev
ACCEPTED the viem-style stub tuple at estimation (the highest-risk
unknown, now resolved). After the biometric gate: userOpHash
0x621fb8fe841ddffe2f9fa551bf759c6fc319a1a89313d228e963795e751fd96e,
"Bundling…", then "Included on-chain — succeeded." with bundle tx
0xbd14fbeb79ed95b2b43876b5d56cb1521ed5c0d6092704cc647706053da4a7ec.
Independently confirmed: the bundle tx is type 0x4, block 0xb4748b,
status 0x1, its authorizationList names the Kernel delegate, the
UserOperationEvent sender is Account 2's EOA, and eth_getCode(Account
2) = 0xef0100d6cedde84be40893d153be9d467cd6ad37875b28. Home then showed
"Account 2 · upgraded (Kernel v3.3) on Ethereum Sepolia" and the row
link "Upgraded ✓".

REVOKE, PROVEN LIVE (same session): Upgrade → "Upgraded to Kernel v3.3"
→ Revoke upgrade. The confirm showed "New code at your address: None —
the delegation is removed (zero address)", "EIP-7702 set-code (type
0x04) to yourself, 0 test ETH", "Transaction nonce 1; authorization
nonce 2 (transaction nonce + 1, because you send it yourself); chain id
11155111", worst case 86,000 gas (46,000 intrinsic incl. 25,000 for the
authorization + 40,000 for the call), the no-pre-flight explanation and
the balance. After the biometric gate: tx
0x1287e768f04b039934090660f74616dd8fff2c2e6b36da2eb667369f83c9594f,
then "Included — status: Regular account (no code)". Independently
confirmed: "blockNumber":"0xb4749a" "gasUsed":"0x8fc0" "status":"0x1" "type":"0x4" ; the transaction's authorizationList carries the
zero-address tuple; eth_getCode(Account 2) = 0x. This was the FIRST live
self-sponsored type-0x04 transaction built by the app (the engine smoke
had only broadcast one for its revocation). The in-app 7702 cycle —
upgrade via a bundled UserOperation, status display, revoke via a
self-paid set-code transaction — is now fully proven on Sepolia.

- [x] Item 3, engine half — passkey (WebAuthn / P-256) signer on Kernel
      v3.3 (commit 6efcf5f; 26 new tests, chains-evm 300, engine 536).
      packages/chains-evm/src/kernel-webauthn.ts, pinned to
      WebAuthnValidator v0.0.3 ("V0_0_3_PATCHED")
      0x7ab16Ff354AcB328452F1D445b3Ddee9a91e9e69 (SDK cd7c05b5
      plugins/passkey/index.ts for Kernel 0.3.0–0.3.3; identical 4,739-byte
      runtime code on Sepolia and mainnet, keccak 0x726d987a…9c9eea, which
      the engine verifies before use; isModuleType(1) true on both;
      Sourcify PARTIAL match on Sepolia only (solc 0.8.30), mainnet bound
      by code-hash equality; logic equals kernel-7579-plugins e418592b).
      SECURITY FINDING (from source, no public advisory found):
      validators v0.0.1 (0xD990…Aa06) and v0.0.2 (0xbA45…90Fd) return the
      raw P-256 result and skip the flag/type/challenge checks when
      responseTypeLocation == uint256.max, so ANY old assertion from the
      passkey would validate ANY operation; v0.0.3 returns false on that
      path (Sepolia simulation: "dummyReplay" → AA24). The engine never
      supports the older versions. AUDIT: the v3.1 incremental audit
      (kernel/audits/v_3_1_incremental_audit.pdf, 2024-05-27..06-09) had
      WebAuthnValidator.sol at ae10aa0f — the UNPATCHED code — in scope
      with no WebAuthn findings; Kalos' "WebAuthn/P256 Plugin" report
      (2024-02-22) covers the Kernel v2 P256Validator; no audit of v0.0.3
      found → unaudited for mainnet (adds to C1). P-256 path:
      usePrecompiled=true calls 0x100, else Daimo's P256Verifier
      0xc2b78104907F722DABAc4C69f826a522B2754De4 (same code both chains);
      RIP-7212 (Final) defines 0x100 at 3,450 gas; on Ethereum L1 it is
      EIP-7951 (Final, 6,900 gas) shipped in Fusaka per EIP-7607 (Sepolia
      2025-10-14, mainnet 2025-12-03) — VERIFIED on-chain on both chains
      (valid signature → 0x…01, corrupted → 0x; eth_estimateGas ≈30.8k);
      ERC-7562 OP-062 allows the precompile during validation; the SDK's
      network list marks 1 and 11155111 supported; detectP256Precompile
      probes 0x100 per chain. Envelope (validator source; byte-pinned
      against @zerodev/passkey-validator 5.6.0, @zerodev/webauthn-key
      5.5.0, viem 2.57.2 in the scratchpad): abi.encode(bytes
      authenticatorData, string clientDataJSON, uint256
      responseTypeLocation(=1), uint256 r, uint256 s, bool usePrecompiled);
      challenge = the RAW userOpHash base64url without padding at FIXED
      offset 23 (clientDataJSON must begin exactly
      {"type":"webauthn.get","challenge":"); signed message =
      sha256(authData || sha256(clientDataJSON)); UP and UV required; BS
      only with BE; s > n/2 rejected (engine normalizes low-s); origin,
      rpIdHash and the counter are NOT checked on-chain. Install data =
      abi.encode((x,y), bytes32 authenticatorIdHash); onInstall reverts
      AlreadyInitialized → one passkey per account per validator contract;
      nonce key 0x00|0x01|validator|uint16 (= the SDK's). D1-PRESERVING
      DESIGN (accepted): the passkey is an ADDITIONAL regular validator —
      root stays the seed's ECDSA validator, address unchanged — installed
      by a root-signed self-call installModule(1, validator, address(0) ||
      abi.encode(validatorData, 0x, execute selector)) which grants
      `execute` atomically (the layout Kernel's own tests use; pinned
      against ethers; Kernel computes the validation nonce itself so the
      install can ride in the deployment op); uninstall =
      uninstallValidation(vId, 0x, 0x) + grantAccess(vId, execute, false)
      — NOT uninstallModule, which never calls onUninstall and would make
      a reinstall revert. D1 CAVEAT: `execute` allows self-calls, which
      pass onlyEntryPointOrSelfOrRoot, so a stolen passkey could call
      changeRootValidator and evict the seed (the simulation proved a
      passkey-signed self-call is accepted); the engine's spec refuses
      passkey calls to the account itself but that guard is CLIENT-SIDE
      ONLY; the seed can always remove the passkey (uninstallValidation)
      or invalidateNonce (which breaks the wallet's 0x01-prefixed ERC-1271
      envelope); an on-chain guarantee needs a self-call-blocking hook
      installed with the passkey — no audited deployed one was found
      (open item). API: p256PublicKeyFromSpki / FromSec1 (on-curve
      checked), webAuthnAuthenticatorIdHash, encodeWebAuthnValidatorData,
      checkWebAuthnAssertion (every on-chain check replicated, fails
      closed), encodeWebAuthnSignatureFromAssertion, normalizeP256LowS,
      webAuthnStubSignature(usePrecompiled) (the SDK hard-codes false,
      costing ~315–330k more gas per op — could trip bundler efficiency
      floors), webAuthnNonceKey, encodePasskeyInstall / passkeyInstallCall,
      passkeyUninstallCalls, readPasskeyValidatorState,
      verifyWebAuthnValidatorDeployment, detectP256Precompile,
      signErc1271WithPasskey (0x01||validator||envelope over Kernel's
      EIP-712 wrapper), kernelPasskeySpec + passkeySignerAccount —
      signUserOpHash is synchronous in SmartAccountSpec, so the spec
      returns a placeholder and spec.routeBundler(bundler) signs at
      eth_sendUserOperation (recomputes the userOpHash from the exact op,
      refuses mismatches, wrong sender/nonce key, a factory or a 7702
      field, verifies the assertion locally, then substitutes the real
      signature; refuses any other request still carrying the
      placeholder); spec.routeNode routes the nonce key;
      spec.signer.sign() always throws so the seed can never sign through
      this path. FOLLOW-UP: let SmartAccountClient await signUserOpHash
      (two-line backward-compatible change in smart-account.ts) to remove
      the placeholder and transport routing. SEPOLIA: simulation only
      (install + use + uninstall is three ops, beyond the one-op budget)
      against the real EntryPoint v0.7, Kernel v3.3, validator, 0x100 and
      Daimo, for the public test mnemonic (deploy + install in one op)
      and for dev account index 2: ACCEPTED install, passkey op via the
      precompile, isValidSignature 0x1626ba7e (501-byte passkey ERC-1271
      signature), passkey op via Daimo, the self-call, uninstall;
      REJECTED wrong challenge (AA24), dummy-location replay (AA24),
      passkey op after uninstall (AA23). Gas (index 2 run): passkey op
      actualGasUsed 289,040 via the precompile vs 604,792 via Daimo
      (handleOps tx 208,880 vs 524,632; one verification 30.8k vs
      ~368–377k) — Daimo costs 314–332k more per op. APP CONTRACT:
      assert(challenge: 32 bytes) → { authenticatorData, clientDataJSON
      (exact signed UTF-8), signature (DER), credentialId? }; the native
      layer must run a WebAuthn assertion with the raw challenge bytes,
      allowCredentials = the registered id, userVerification "required",
      the app's rpId, ES256 only; registration must supply the public key
      as SPKI DER (Android getPublicKey()) or SEC1 — the engine does not
      parse COSE, so iOS needs a COSE→SEC1 step; the app calls
      detectP256Precompile per chain, uses signErc1271WithPasskey for dApp
      signatures (signHashForSmartAccount has no synchronous signErc1271
      here), plans for one passkey per account, and needs a development
      build (not Expo Go). UNVERIFIED: no audit of v0.0.3; mainnet
      bytecode not reproduced by compilation; bundler acceptance of
      passkey ops (precompile during validation, stub-based estimation)
      on ZeroDev/Alchemy untested live; clientDataJSON field order on the
      iOS/Android native APIs (type first, challenge at offset 23) — the
      engine fails closed before submission; a real clientDataJSON longer
      than the 244-byte stub needs gas padding. Also committed:
      scripts/testnet/fund.mjs (dev-EOA top-up helper with estimated gas).

- [x] Item 4, engine half — social recovery with guardians on Kernel
      v3.3 (commit ac3be34; 52 new tests, chains-evm 352, engine 588).
      MECHANISM (ZeroDev's own Kernel v3 recovery, sources: kernel v3.3
      cd697c7e WeightedECDSAValidator / ECDSAValidator / Kernel /
      ValidationManager / SelectorManager / HookManager / Constants; SDK
      cd7c05b5 weighted-ecdsa + weighted-r1-k1 plugins,
      getValidatorPluginInstallModuleData, test/v0.7/
      recoveryKernelAccount.test.ts; kernel-7579-plugins ca4a820
      actions/recovery/src/RecoveryAction.sol; docs.zerodev.app/advanced/
      account-recovery/sdk-recovery): guardians live in
      WeightedECDSAValidator 0xeD89244160CfE273800B58b1B534031699dFeEEE
      installed as a SECONDARY validator (installModule(1, …)) whose only
      allowed selector is doRecovery(address,bytes) 0xac39fd0f, routed to
      RecoveryAction 0xe884C2868CC82c16177eC73a93f7D9E6F3A5DC6E
      (installModule(3, …); runs in the account's context, callable only
      from the EntryPoint); doRecovery(ECDSA validator, bytes20 newOwner)
      = onUninstall("") then onInstall(newOwner) — ECDSAValidator has no
      other setter. Guardians sign EIP-712 Approve(bytes32
      callDataAndNonceHash) under ("WeightedECDSAValidator","0.0.3",
      chain, validator), recovered raw (no EIP-191); proposal id =
      keccak256(abi.encode(sender, callData, nonce)); op signature =
      approvals || one guardian's EIP-191 signature over the userOpHash;
      own nonce lane 0x00||0x01||validator||parallelKey. Delay > 0:
      guardians first approveWithSig on-chain (anyone may submit), the op
      is valid only after the delay (AA22 before), and ONLY the account
      (root-signed veto(hash)) can reject during it; delay 0 = no veto.
      On-chain binding: the weighted validator is a Sourcify full match
      on chain 1 and a runtime match on Sepolia, source byte-identical to
      the v3.3 file, eip712Domain = ("WeightedECDSAValidator","0.0.3");
      RecoveryAction is verified nowhere but identical on both chains and
      reproduced from ca4a820 (solc 0.8.24, runs 200, paris; metadata hash
      differs). AUDITS: Kalos "Recovery Plugin and Weighted ECDSA" v1.0
      (2023-12-12) and v2.0 (2024-02-06) cover KERNEL V2 code (kernel
      90fa72ed / eaaac83a); the v3 port and the v3 RecoveryAction appear
      in no published report; the v3.1 incremental audit's "Weighted
      Validator" is a DIFFERENT contract (plugins WeightedValidator.sol at
      91f8fcb) → the deployed v3 modules are UNAUDITED (adds to C1).
      FINDINGS FOR THE CHAIRPERSON (trust model): (1) enough guardian
      weight can set the owner to any key, and doRecovery accepts any
      validator, so guardians can also replace the guardian list; (2)
      guardians can sign messages AS THE ACCOUNT immediately — Kernel's
      isValidSignature accepts any installed validator and ignores the
      selector allowlist — so Permit2 permits, orders and logins need no
      delay and no veto; (3) A SINGLE GUARDIAN CAN SATISFY A 2-OF-2: the
      deployed weighted validator checks the threshold BEFORE signer
      order, so the last signature may repeat an earlier signer — a group
      passes if its weight plus its heaviest member's weight reaches the
      threshold, equal-weight k-of-n is effectively (k−1)-of-n, and any
      guardian holding at least half the threshold can sign alone; PROVEN
      LIVE ("one guardian's signature repeated twice" → VALID on the real
      account); no wallet-side encoding can fix it, so
      guardianSignatureExposure(set) computes the true minimum for the UI;
      (4) following ZeroDev's docs example (a single guardian registered
      with the ECDSA validator) on an account whose root is that same
      validator would OVERWRITE THE OWNER with the guardian (same
      validation id) — reasoned from source, not executed; (5) recovery
      cannot protect an EIP-7702-upgraded EOA (its own key can always
      re-delegate) — prepareGuardianInstall refuses such accounts; (6)
      @zerodev/weighted-ecdsa-validator 5.4.4 maps the validator to Kernel
      "0.3.0 || 0.3.1" while the repo says 0.3.0–0.3.3. ENGINE
      (kernel-recovery.ts): guardian-set validation and sorted encoding,
      install / removal (uninstallValidation, revoke access,
      uninstallModule(3)) / renew calls; refusals — threshold 0 or above
      total weight (renew has no on-chain check, so this is its only
      guard), duplicate guardians (case-insensitive), the account itself
      or the current owner as guardian (a lost or stolen key must not hold
      a vote), the zero address or the 0xff…ff list-end marker, weights
      outside 1..2^24−1, total weight above uint24, delay above uint48, a
      new owner that is zero / the account / a guardian; JSON-safe
      recovery request with every field re-derived on parse; approval
      assembly drops the submitter's own approval and rejects outsiders,
      duplicates, short weight and the immediate path when a delay is set;
      kernelGuardianRecoverySpec (refuses if the guardian nonce moved after
      approvals); approveWithSig / veto / proposal reads;
      ownerRotationCalls; readKernelOwner / readGuardianState;
      kernelRecoveredAccountSpec (uses a stored address only after the
      on-chain owner matches the signing key); findKernelAccountsByOwner
      over OwnerRegistered logs filtered by verifyKernelAccountForOwner
      (implementation slot, ECDSA root, owner match) because anyone can
      forge those events. RECOVERY METADATA (the ADR D1 answer): after a
      rotation the address cannot be derived from any seed (the CREATE2
      salt commits to the ORIGINAL owner), so each account keeps a
      secret-free record — version, CAIP-2, account, type kernel-v3.3,
      deployment facts (factory, implementation, ECDSA validator, index,
      original owner), owner history oldest-first (owner, source:
      deployment / guardian-recovery / owner-rotation, tx and/or
      userOpHash, block, BIP-32 path when this seed derives it, recorded
      at), guardians with labels, threshold, delay and install tx;
      createRecoveryMetadata refuses an address that is not the CREATE2
      result of the original owner + index; serialize/parse use canonical
      JSON and re-check every invariant; verifyRecoveryMetadataOnChain
      reports mismatches. Re-attach after restore: the backed-up record
      (verified on-chain), else an OwnerRegistered scan (free-RPC log
      limits apply), else a pasted address — always only after
      verifyKernelAccountForOwner (the 7702 "Use this upgraded account"
      pattern). Tests byte-identical to the SDK for set encoding, both
      installModule calls, renew, doRecovery calldata, nonce key, proposal
      hash, approval digest, the full signature and the estimation stub;
      removal / veto / approveWithSig calldata vs viem; ethers recovers
      every guardian signature; threshold and refusal matrix; exposure
      model; end-to-end SmartAccountClient run; metadata round trip. LIVE
      ON SEPOLIA (account index 2, ZeroDev bundler, two fresh guardians
      1+1, threshold 2): install (userOp 0x53705b9c…6045, tx
      0x3101b858…05c1, block 11826469) → guardian recovery to the dev
      seed's index 9 0xc687f25121C46e6Fd2892fFda0425D1A775e6166 (userOp
      0x8ac47b12…08da, tx 0xd49ee8af…e302, block 11826470) → the new
      owner rotates back and removes the guardians (userOp
      0xdf436c25…f048, tx 0x99e107fc…0272, block 11826471); all status
      0x1 with UserOperationEvent success; OwnerRegistered emitted for the
      new owner then the dev EOA again; the old owner refused (AA24 in
      simulation; bundler -32507 AA24 at submission); afterwards the
      original owner simulates as accepted and a guardian op fails
      InvalidValidator; end state verified by the CTO with the engine's
      readers. An earlier attempt ran the same three ops before stopping
      on a bad negative test; its cleanup (signed by the index-9 key)
      restored the account (txs 0x8cad5d90…, 0xeaa6afcc…, 0xebcdc301…),
      paid from the account's EntryPoint deposit. LESSON: a wrong owner
      signature PASSES bundler gas estimation (the validator returns a
      failure code instead of reverting), so the rejection shows only at
      submission. Dry run (RECOVERY_SMOKE_DRY_RUN=1, 29 checks) also
      proves the delay (AA22 before, accepted after) and the owner's
      veto. Funds: the dev EOA spent a 0.001 top-up (now ~0.0017); the
      account went 0.00225 → 0.00159. UNVERIFIED: finding (4); delay and
      veto only in simulation; with a paymaster attached an approved
      delayed proposal executes with NO signature (per source); Alchemy /
      Pimlico acceptance; weights other than 1/1 live. APP DESIGN NOTE:
      setup only for deployed Kernel accounts (not 7702), delay picker
      defaulting > 0 (e.g. 48 h so the owner can veto), a MANDATORY
      plain-language exposure warning from guardianSignatureExposure ("N
      guardians together — or one, if a guardian holds at least half the
      threshold weight — can sign messages as this account immediately,
      with no delay and no veto"), the no-published-audit note, metadata
      written before submission with an off-device backup prompt; status
      screen (readGuardianState, Remove, Renew); recovery flow on a new
      device (new owner key from the new seed, prepareGuardianRecovery
      request shared by QR/file, approvals checked with
      verifyGuardianApproval, submit as a guardian or show approveWithSig
      progress + countdown, then kernelRecoveredAccountSpec and append to
      the owner history); owner's veto screen behind the biometric gate;
      restore screen "Use this recovered account" via record / log scan /
      pasted address, attaching only after verifyKernelAccountForOwner.

- [x] Item 4, app half — guardians and social recovery (commit ad5ed20;
      check-recovery.mjs 145/145; all 22 app suites green, 1,856 checks;
      tsc clean; expo export bundles 7.4MB). app/src/wallet/recovery.ts:
      the engine's secret-free RecoveryMetadata per account+chain in
      AsyncStorage, re-parsed strictly on every read, created on a Kernel
      account's first accepted op (via an aa.ts addAaSentListener hook,
      public data only), when the Guardians screen opens, or rebuilt from
      the original owner; written BEFORE any guardian change and restored
      if the bundler refuses; exported as QR (ECL L; a 2,900-byte record
      round-trips offline, larger falls back to text) / share text / copy;
      verified with verifyRecoveryMetadataOnChain; imported on restore and
      attached only after verifyKernelAccountForOwner. GuardiansScreen
      (Settings + Home link when eligible): eligible = a deployed Kernel
      v3.3 account this wallet owns (factory or recovered); SimpleAccount,
      7702 upgrades (the engine's exact text, pinned), undeployed and
      foreign owners refused; contact picker with exact-match display;
      weights; threshold; delay default 48 h (0 only behind a "no veto"
      acknowledgement; test networks also offer 10 min); install / renew /
      remove / veto all through the normal confirm (bundler estimate,
      biometric, signWith(owner), sendAa); backup prompt after install or
      renew; status card from readGuardianState with a record-vs-chain
      check and "update from chain". EXPOSURE WARNING mandatory on the
      form, confirm and status card, number from guardianSignatureExposure
      (a 2-of-2 reads "ONE guardian alone…" naming the guardians; a 3-of-5
      says 2; a sentence explains the repeated-signer problem), plus
      findings (1) and (2) stated in plain words; setups are never called
      "safe"; no-audit note; on mainnet Review is blocked until the user
      acknowledges the unaudited modules and unmet C1–C3. DOCS-EXAMPLE
      HAZARD (finding 4) closed: installs only through the engine's
      guardianInstallCalls with the pinned WeightedECDSAValidator;
      assertGuardianModulesSafe refuses any setup whose guardian module is
      the owner's root validator; the first install call is byte-checked;
      guardian-side requests naming any validator other than the pinned
      ECDSA owner validator are refused. RECOVERY FLOW (lost phrase, new
      wallet): "use a fresh account" adds "Recovered account"; enter the
      account address / record / original owner; on-chain check (every
      verifyKernelAccountForOwner problem except owner mismatch blocks;
      guardians must be active); prepareGuardianRecovery → request as QR +
      text (incl. the EIP-712 typed data for guardians on other wallets);
      approvals pasted/scanned and checked with verifyGuardianApproval with
      a weight bar; with a delay, approveWithSig txs sent from the new
      account's own address (the new wallet pays — explained), then a
      countdown; once the chain shows the new owner, "Use this recovered
      account" attaches after the owner check and appends the
      guardian-recovery entry (tx found via the OwnerRegistered log or
      pasted); the account is labelled everywhere "not found from your
      recovery phrase alone"; the same screen scans recent blocks for
      accounts this wallet already owns. GUARDIAN SIDE ("Approve a
      recovery"): request re-derived; account, new owner, current owner
      and proposal id shown in full; plain warning; confirm dialog +
      biometric; approval out as QR/text or straight into a recovery in
      progress on the same device; a guardian can submit the final op (the
      account pays). WalletConnect refuses typed data under the guardian
      validator's domain and any transaction / wallet_sendCalls targeting
      the guardian modules or carrying the doRecovery selector. aa.ts:
      per-owner recoveredAccounts link (set only by setRecoveredAccount;
      createAaClientFromConfig then builds kernelRecoveredAccountSpec; an
      owner cannot have both a 7702 upgrade and a recovered link);
      aaSenderLabel; wipe clears recovery data after an "Export your
      recovery records first?" prompt. DEVIATIONS (source-grounded): (1) a
      GUARDIAN must submit the final recovery op — WeightedECDSAValidator
      (cd697c7e, lines 203–252) needs a guardian's EIP-191 signature over
      the userOpHash on both paths without a paymaster, so the new wallet
      sends only approveWithSig and the paymaster path (no signature) is
      deliberately unused; (2) the validator emits no approval events, so
      the owner's veto works from a watch list (paste/scan a request or
      proposal id → live countdown; guardians must tell the owner); (3)
      after a veto the same new owner gets a new proposal id by moving to
      the next guardian-lane parallel key (up to 16) — supported by the
      engine's key layout but a non-zero lane has never run live. New
      helpers: scripts/testnet/guardian-approve.mjs (dev-seed guardian
      addresses; signs an approval for a pasted request after checking the
      on-chain set) and kernel-rotate-owner.mjs (rotate the owner back and
      optionally remove guardians). NOT verified live: everything in the
      app (bundler acceptance, the 10-min delay, veto, lane-1 recovery,
      OwnerRegistered lookup ranges); WC smart-account sessions never use
      the recovered account (they bind the owner's factory address);
      record export is share text, not a .json file (needs expo-sharing /
      expo-file-system); no owner-rotation screen (script only).
      Emulator checklist (8 steps, uses the dev seed's index-2 account
      and guardian keys at indices 5 and 6) in the builder's report.

- [x] Item 3, app half — passkey signer, gated behind a development
      build (commit 4a6c8ef; check-passkeys.mjs 121/121; all 23 app
      suites green, 1,977 checks; tsc clean; expo export bundles 7.5MB;
      Expo Go startup unaffected — the native module is reached only
      through a lazy require after requireOptionalNativeModule returns
      non-null, confirmed in the unminified export). Library:
      react-native-passkeys 0.4.2 (Expo module, peer expo >=53, MIT;
      github.com/peterferguson/react-native-passkeys) — Expo has no
      first-party passkey module (llms.txt); rejected: react-native-passkey
      3.6.2 (bare RN), expo-passkey 0.3.15 (better-auth peers),
      expo-passkeys 0.1.11 (peer expo ^52, stale). API facts from the
      installed source: create()/get() take and return WebAuthn-JSON with
      base64url binary fields; both platforms return attestationObject;
      QUIRK: the typings say publicKey is SPKI, true on Android
      (Credential Manager) but iOS (ios/PublicKey.swift) returns the raw
      64-byte x||y — so the app takes the key from attestationObject →
      authData → COSE_Key → SEC1 (ES256 only; RFC 9052 §7, RFC 9053
      §7.1.1, WebAuthn L3 §§6.1/6.5.1/6.5.1.1) and only cross-checks
      publicKey (91-byte SPKI, 65-byte SEC1 or 64-byte raw must match).
      Requirements: iOS 15 / Android API ≥ 28, compileSdk ≥ 34 — already
      met by SDK 57 (iOS 16.4, compileSdk 36); needs a development build.
      rpId: app.json ios.associatedDomains =
      ["webcredentials:passkey-domain-not-configured.invalid"] (a reserved
      .invalid placeholder, NOT an invented domain), mirrored as
      PASSKEY_RP_ID in app/src/config/passkey.ts (the check script fails
      if they disagree); passkeyGate refuses the placeholder, reserved
      names and Expo Go, and every entry point says "Passkeys need a
      development build with a configured rpId…". INPUT NEEDED from the
      Chairperson before device testing: a domain they control, hosting
      the iOS AASA file (webcredentials → <TeamID>.<bundleId>) and Android
      assetlinks.json (handle_all_urls + get_login_creds); app.json still
      lacks ios.bundleIdentifier / android.package. Note: Expo's v57
      app-config page documents associatedDomains in the applinks: form;
      the webcredentials: form comes from the library README (Apple's own
      doc not fetched). Files: app/src/wallet/passkeys.ts (gate; strict
      base64url, minimal CBOR, authData and COSE→SEC1; registration and
      assertion decoding with rpIdHash checked both ways and clientDataJSON
      as exact UTF-8; makePasskeyAssert implementing the engine's assert
      contract; PUBLIC-ONLY credential records in AsyncStorage
      shiba-wallet.passkeys.v1 — the private key lives in the platform
      authenticator; eligibility = a deployed Kernel v3.3 account with an
      ECDSA root owned by this wallet; install / remove / forget /
      reconcile; createPasskeyBundle, preparePasskeyCalls, sendPasskeyCalls
      on the engine's routeNode/routeBundler path with NO signWith;
      signHashWithPasskey for ERC-1271), passkey-native.ts (the only, lazy
      importer), usePasskeyInfo.ts, PasskeyScreen.tsx (Settings section,
      Home "Passkey / Passkey ✓" link: additional-signer explanation,
      no-audit note, the self-call caveat as a risk statement, one passkey
      per account; Add = native registration → passkeyInstallCall through
      the normal owner-signed confirm; Test = a 0-value call to the owner
      EOA signed by the passkey (a literal self-send is impossible — the
      engine refuses passkey calls to the account); Remove =
      passkeyUninstallCalls through the normal confirm, also works without
      a record or the native module), a "Sign with passkey" toggle on
      Kernel smart-account sends (no separate app biometric gate there —
      the passkey prompt IS user verification; WalletConnect keeps its
      gate), an optional passkey signer for personal_sign / typed data on
      Kernel smart-account sessions (owner key stays default), fixtures/
      webauthn-validator-v0.0.3.runtime.hex (public runtime code, keccak
      checked in-script against the pin), docs/DEVICE_BUILDS.md Passkeys
      section with the rpId setup and device checklist. Passkey ops: no
      paymaster, padding 110% verification / 115% preVerification (the
      validator runs the full P-256 check even for the stub; a real
      clientDataJSON may be longer). Engine follow-up proposed (not
      needed now): signUserOpHash may return a Promise and sendCalls
      awaits it (two lines in smart-account.ts; wrappers may need a type
      widening). NOT verified: anything on a device (iOS/Android
      clientDataJSON order — the engine fails closed; real clientDataJSON
      length vs padding; bundler acceptance of passkey ops via the
      precompile; the iOS raw-key path; Credential Manager; whether
      Android needs an asset_statements manifest entry — not added;
      excludeCredentials); WebAuthnValidator v0.0.3 unaudited (C1). Also
      flagged: npx expo install --check wants expo 57.0.26 and expo-camera
      57.0.6 (pre-existing, unchanged).

## Phase 8 complete (2026-10-02)

All six items landed: EIP-7702 (engine + app, upgrade and revoke proven
live in the app), session keys (engine + app, live engine proof),
passkeys (engine + app, simulation proof; device test pending a
development build and an rpId domain), guardians / social recovery
(engine + app, live engine proof), the bundler-floor generalization and
the ZeroDev deployment-acceptance proof, plus the live validations.
Engine: 588 tests across five packages. App: 23 offline suites, 1,977
checks. Live on Sepolia this phase: Kernel deployment through ZeroDev,
EIP-7702 delegation in a UserOperation and revocation (engine and
in-app), an enable-mode session key install/use/reject/revoke cycle,
and a guardian install/recover/rotate-back cycle.

Findings for the Chairperson gathered this phase (all recorded above):
the ZeroDev weighted guardian validator lets a repeated signer satisfy
the threshold (proven live) and lets guardians sign as the account
immediately; the older WebAuthn validators v0.0.1/v0.0.2 accept replayed
assertions; the permission, recovery and v0.0.3 WebAuthn modules have no
published audit; ERC-7715 responses cannot be produced compliantly
without an ERC-7710 delegation manager; following ZeroDev's single-
guardian docs example could overwrite the owner. Mainnet remains gated
on C1–C3. A responsible disclosure of the guardian-validator findings to
ZeroDev / Offchain Labs is recommended and awaits the Chairperson's
decision.

Carried forward: emulator runs of the session, guardian and (dev-build)
passkey flows; the dApp-side 7715 and smart-account WalletConnect
sessions; the awaited-signUserOpHash engine refactor; the follow-ups
listed under the phase 7 completion (log-depth cap, Sepolia RPC fallback,
ESLint burn-down 44 → 18 remaining in touched files, record export as a
.json file, an owner-rotation screen); standing items (Dogecoin mainnet
broadcast, live 0x quotes, live paymaster, EAS build, counsel review).

## Live WalletConnect retest after the environment restart (2026-10-02, emulator, Sepolia)

The host session restarted, which took down the emulator, Metro and the
scratchpad worktree. Everything was rebuilt and the full dApp cycle was
run again from a fresh pairing, with the Chairperson driving Uniswap:

- Fresh pairing: Uniswap proposed 24 eip155 chains and 21 methods; the
  sheet offered "Connect as regular account (EOA) / smart account (Kernel
  v3.3)"; the EOA was kept. The session settled as eip155:11155111,
  4 methods, bound to Account 1 (0x772e…F44F), after the biometric gate.
  The pre-restart Uniswap session was no longer listed on the Connections
  screen after the cold boot ("No dApps are connected"); whether the
  dApp side dropped it or the SDK's persisted session failed to reload
  was answered the same day: with the new session live, Expo Go was
  force-stopped and relaunched and the Uniswap session was still listed,
  so WalletKit persistence across an app process restart works; the
  earlier loss was on the dApp side (Uniswap replaces its wallet session
  when a new pairing is made).
- USDC -> EURC swap, sheet surfaced on Home: to = the Sepolia Universal
  Router 0x7E4f6c5e954Da5c61B3423D81E2277431Ac043f3 (same as the phase-6
  swaps), calldata selector 0x3593564c = execute(bytes,bytes[],uint256)
  (recomputed with keccak before approving), 1306 bytes, 0 ETH, max fee
  0.000384 test ETH; preview "You send 1 USDC (untracked token
  0x1c7D…7238)" and "You receive 0.991829 EURC (untracked token
  0x0821…94D4)"; "Pre-flight simulation passed (eth_call)". The EURC
  contract was checked against Circle's EURC contract-addresses page
  before approval: Ethereum Sepolia EURC is
  0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4, matching the preview's
  prefix and suffix. No approval or Permit2 typed-data request preceded
  the swap this time (the earlier Permit2 allowance was still valid).
- Result: tx 0x5396a4935274947f7be7ead1804aabd3a47082bc06c193d30073fd01b54e5fe2,
  block 11829583, status 0x1, 166,330 gas, 3 logs. Receipt Transfer
  logs: USDC 1,000,000 base units out of the wallet and EURC 991,829
  base units into the wallet, i.e. the preview matched reality exactly
  on both legs again.

Emulator lessons from the restart (dev-only, not app code):
- After a cold boot the AVD shows "PIN is required after device
  restarts" and credential-encrypted storage stays locked, so Expo Go
  cannot even be resolved by the package manager ("unable to resolve
  Intent"). `adb shell locksettings verify --old 1234` unlocks the user
  (dumpsys user then reports RUNNING_UNLOCKED); the keyguard bouncer then
  accepts digits tapped on the keypad only after `adb emu finger touch 1`
  has opened it (typed `input text` was ignored).
- Metro died when the background task that had started it was stopped;
  start it with `nohup … & disown` from the worktree. With CI=1 it logs
  a "Cannot connect to Expo CLI" LogBox warning on the device.
- LogBox toasts sit exactly over the approval sheet's "Approve & send"
  button; tapping one opens LogBox (Dismiss closes it). The WalletConnect
  core log at pino level 50 (time 1790951061342, context "core…") could
  again not be read in full before it rotated out; it did not affect the
  flow. The Google keyboard pops up over the sheet after pasting a URI
  and must be hidden before scrolling the sheet.

## Phase 8 burn-down (approved 2026-10-02, running before phase 9)

Approved sequence: burn down the carried-forward follow-ups first, then
scope phase 9 (hardening and release readiness). Wave 1 ran four agents
on disjoint files; the ESLint burn-down runs after them because it
touches files everywhere.

- [x] Token-history log-depth cap (commit 90d3f94). The no-indexer
      tracked-token history (app/src/wallet/token-history.ts) now stops
      paging when the endpoint refuses an older eth_getLogs window,
      reports the deepest block it actually answered, and the Activity
      screen says "History older than block N is not available from the
      current endpoint" with the endpoint's refusal text quoted verbatim
      and a pointer to the history indexer setting. Live on
      ethereum.publicnode.com (read-only, 2026-10-02): windows 8,999 and
      9,999 blocks behind the head are served; 10,100 and 17,999 are
      refused with HTTP 403 and JSON-RPC error -32602 "Archive requests
      require a personal token…", so the app sees exactly one 9,000-block
      window there. Two further bugs fixed on the way: the engine
      httpTransport threw "RPC HTTP error 403" before reading the body
      (the app-side tokenLogsTransport keeps the JSON-RPC error on
      non-2xx responses; the engine transport is unchanged), and Load
      more dropped the partial-history note after page 1. No retry and
      no window halving (a halved window would still be refused; the
      refusal depends on distance from the head). A failed window is
      discarded whole so the "older than block N" sentence stays exact;
      any error ends paging and pull-to-refresh starts over. Verified:
      check-token-history.mjs 48/48 offline (was 17) plus a --live pass;
      all app suites green; tsc clean; expo export bundles. Not
      eyeballed on the emulator (endpoint-text line, dark mode).
- [x] Awaited signUserOpHash (commit 8d6c357). SmartAccountSpec.
      signUserOpHash may return a Promise and receives
      UserOpSigningContext {userOp, entryPoint, chainId}; SmartAccountClient
      awaits it after estimation and the final paymaster data. The
      passkey spec (kernel-webauthn.ts) signs inside that call: before
      any prompt it refuses a bare hash, a foreign EntryPoint or chain id,
      a wrong sender or nonce key, a factory, an eip7702Auth field, a hash
      that does not equal getUserOpHash(op), and — new — calldata the
      spec's own encodeCalls did not produce (so a hand-built self-call
      cannot bypass the self-call refusal). routeBundler, the passkey
      routeNode, submittedSignature, PASSKEY_PENDING_SIGNATURE_PREFIX and
      userOperationFromRpc are removed; the estimation stub is unchanged.
      New optional SmartAccountSpec.getNonceKey(owner): the client reads
      EntryPoint.getNonce(sender, key) directly (refuses keys >= 2^192 and
      answers whose key bits differ); the session-key spec adopts it and
      keeps routeNode as a compatibility pass-through (sessions.ts still
      calls it). The guardian recovery spec deliberately stays on
      routeNode because that path also enforces the exact
      guardian-approved nonce — moving it needs an extra exact-nonce
      check (follow-up). App: passkeys.ts uses plain transports; the
      authenticator prompt runs inside the spec. Verified: engine 595
      tests (chains-evm 359, was 352; total was 588); check-passkeys
      125/125 (was 121); check-aa-kernel 74, check-sessions 99, check-aa
      74, check-7702 111, check-recovery 145; tsc clean; expo export
      bundles; passkey-smoke dry run passed (it signs ops itself, so it
      only proves the exports). Still nothing live for passkeys.
- [x] Sepolia default RPC fallbacks (commit 05d58e9; the list lives in
      app/src/config/evm-chain.ts, not defaults.ts). Order: 
      ethereum-sepolia-rpc.publicnode.com (primary, unchanged), then
      https://eth-sepolia-testnet.api.pocket.network (api.pocket.network:
      "No API key required", URL listed on the page; eth_simulateV1
      supported), https://0xrpc.io/sep (0xrpc.io lists it; states a
      10–20 calls/s limit; simulateV1 supported; third because its log
      records outages), https://public.1rpc.io/sepolia
      (docs.1rpc.io/using-the-web3-api/networks lists it; simulateV1
      intermittent — 429s and "not available on this plan" relayed from
      Nodies — so last; whether its 200/day quota applies to public
      endpoints is unverified). All three re-probed by the CTO (chain id
      0xaa36a7). Rejected with reasons in the file comment: tenderly
      (documented, but every TLS handshake failed from this machine —
      retry later), nodies (no simulateV1 on its plan, URL not visible
      text), drpc/ankr/ZAN/Sentio (key or plan), Tatum (5 req/min, blog
      only), thirdweb and ethpandaops (no provider page naming them as
      public), rpc.sepolia.org / rpc2.sepolia.org and the chainlist and
      eth-clients README entries (dead). Worst case with every candidate
      hanging is now about 16 s before a visible error. Verified:
      check-rpc-fallback.mjs 85/85 offline (was 67), 98/98 with --live;
      check-devmode 71/71 (primary pin holds); tsc clean; expo export
      bundles with the URLs in the bytecode.
- [x] Recovery UX (commit ebcb704): record export as a .json file and
      an in-app owner-change flow. New deps via expo install, all bundled
      in Expo Go SDK 57 (verified in expo/expo sdk-57
      apps/expo-go/package.json, the v57 docs pages and the installed
      Expo Go APK's module list): expo-file-system ~57.0.7 (new
      File/Paths API), expo-sharing ~57.0.22 (its auto-added app.json
      plugin entry was reverted — it only matters for receiving shares),
      expo-document-picker ~57.0.3. app/src/components/RecordFileActions.tsx
      is the only importer of the native modules: export writes the
      engine's canonical JSON to Paths.cache/recovery-record-export/
      shiba-recovery-record_<chain>_<0xABCD-WXYZ>_<date>.json and opens
      the share sheet (mimeType application/json, UTI public.json); the
      file is deleted 60 s after the sheet closes (judgement call: on
      Android shareAsync resolves on the chooser result and an uploader
      may still be reading), immediately on failure, and on the next
      export; import picks application/json, reads the text, deletes the
      picker's cache copy, and parseRecordFile (recovery.ts) requires a
      .json name or JSON type, caps 64 KiB, allows a BOM, requires exactly
      one JSON object, then runs the EXISTING strict parser path. Owner
      change (OwnerRotationScreen, route OwnerRotation; entry points:
      GuardiansScreen "Owner key" section, RecoverAccountScreen attached
      phase): target = the seed-derived EVM EOA of any of this wallet's
      accounts (hidden included); refusals (each tested): undeployed,
      SimpleAccount, EIP-7702 upgrade, foreign owner, same owner, not one
      of this wallet's accounts, a guardian, a 7702-upgraded target, a
      target already linked to another account, no record, record owner
      differing from chain, "remove guardians" with none installed; calls
      re-checked against the engine's ownerRotationCalls (+
      guardianUninstallCalls) before signing; normal AA confirm (both
      owners in full, "old key stops working at once", fee, bundler
      estimate, biometric, signWith(current owner), sendAa). The record
      entry (source owner-rotation, userOpHash, BIP-32 path) is appended
      after the bundler accepts; finalizeOwnerRotation re-reads the owner
      on-chain, requires verifyKernelAccountForOwner, fills tx hash and
      block (receipt, else the OwnerRegistered log), and moves the
      recoveredAccounts link in one storage write (aa.ts
      moveRecoveredAccountLink; a link is skipped when the new owner's own
      factory index derives the same address, e.g. rotating back); a
      revert or Forget restores the previous record; interrupted changes
      show as "Unfinished owner changes" with Check and finish / Forget.
      Verified: check-recovery.mjs 209/209 (was 145: 19 file checks incl.
      byte-identical round trip and tampered-file refusal, 46 rotation
      checks incl. calldata vs ethers encoding of onUninstall/onInstall
      and the recovered owner signature); all 23 suites green at HEAD;
      tsc clean; expo export bundles 7.6MB with the new strings and the
      ExpoSharing/ExpoDocumentPicker/FileSystemFile module names. NOT
      verified: anything on a device (share targets reading after the
      sheet closes, iOS UTI/filter behaviour, Android file managers
      reporting .json as application/json, Expo Go startup with the
      statically imported modules — the CTO reloads the emulator next),
      a live in-app owner change (the same calls ran live via
      kernel-rotate-owner.mjs). Emulator checklist (8 steps) in the
      builder's report; "Change owner" links on Home/Receive were out of
      the agent's file scope.
- [x] ESLint burn-down (commit 5a3b2ed): npx expo lint went from 51
      problems (44 errors, 7 warnings) to 0. Per rule: 28
      react/no-unescaped-entities (entities substituted in place, every
      decoded JSX string byte-identical — checked by extracting the
      decoded JSXText from HEAD and the working tree), 10
      react-hooks/set-state-in-effect and 6 react-hooks/refs (React
      Compiler rules in eslint-plugin-react-hooks 7.1.1 — synchronous
      "reset then load" state resets moved from effects into render with
      the adjust-state-on-prop-change pattern keyed on exactly the old
      effect deps, in SwapScreen, SendScreen contacts, ApprovalsScreen,
      NftsScreen, LockGate (reset to INITIAL_LOCK_STATE only when
      disarmed, same condition; the overlay rule is unchanged),
      BalanceChangePreview, RiskWarnings, NftImage, WcApprovalSheet (new
      pure initialTxQuote), usePrices (idsRef replaced by a useMemo on
      idsKey); refs read in render (SwapScreen preparedFrom) paired with
      display state, the signing path untouched; refs written during
      render in WalletContext / WalletConnectContext moved to a
      no-deps useLayoutEffect, which keeps the old per-render semantics
      including a narrow pre-existing clobber window noted in the
      builder's report), 1 exhaustive-deps (SettingsScreen reloadEndpoints:
      `sepolia` moved from the callback deps to the effect as an explicit
      trigger), 3 unused vars removed, 2 array-type nits. One new
      single-line disable with a reason (ApprovalsScreen load(): the rule
      ignores await boundaries). Behavioural note: screens that used to
      show one stale frame between render and effect no longer do. Eight
      older exhaustive-deps disables remain (some without the `--
      reason` form; WcApprovalSheet.tsx:477 has none) — follow-up. Plain
      `npx eslint .` still reports Buffer no-undef in scripts/*.mjs, which
      expo lint does not cover — follow-up. Verified: lint 0/0, tsc clean,
      all 23 suites with unchanged counts, expo export bundles with seven
      apostrophe/quote strings found byte-identical in the Hermes
      bytecode; the CTO re-ran lint and tsc before committing. EMULATOR
      PASS at 5a3b2ed (Expo Go, Sepolia mode, Metro in watch mode from
      the isolated worktree): Home renders with live balance and every
      row link; Guardians shows the new "Owner key" section; the Change
      owner screen lists Account 2 as the only target and its confirm
      shows both owners in full, the derivation path, the two-call
      operation and a passed bundler estimate; the Send ETH confirm shows
      the SAVED CONTACT "Burn" notice, fee math and the eth_simulateV1
      preview (nothing sent); the auto-lock cycle (HOME, 75 s, resume)
      showed "Shiba Wallet is locked" and the fingerprint unlock returned
      to Home — i.e. the LockGate, BalanceChangePreview and contacts hook
      changes behave as before. Expo Go started normally with the three
      new native modules imported statically.
- Dropped: WalletKit session persistence (proven to work, see the
  retest record above).

## Phase 9 plan (approved 2026-10-02): hardening and release readiness

Goal: a feature-complete testnet wallet that can pass a store review and
a security review without surprises. Items, in order:

1. Close the in-app owner-change bundler refusal (ZeroDev -32502
   "Simulation ran out of gas for entity: account" at submission after a
   passed estimate; owner unchanged on-chain): root cause, fix, live
   re-run on the emulator in both directions.
2. Threat model document (docs/THREAT_MODEL.md): assets, trust
   boundaries, key storage per platform, every caveat collected so far
   (passkey self-call, guardian exposure, D6, unaudited modules, RPC /
   gateway / relay privacy), each with its mitigation or an explicit
   open item; mapped to a mainnet-readiness checklist merging C1–C3 with
   the wallet's own conditions.
3. Release engineering: verify eas.json profiles, app.json identifiers,
   store listings and privacy disclosures (CoinGecko sees the IP, the
   IPFS gateway, the WalletConnect relay, RPC providers), screenshot
   prevention in release builds. INPUT NEEDED: an Expo account and the
   bundle id / package name.
4. CI and test hardening: one `npm test` running engine vitest, all app
   suites offline, lint, tsc and the bundle export, wired to GitHub
   Actions on the public repo; dependency audit; a pre-commit secret scan.
5. Resilience and UX polish: mid-session endpoint failover on every
   screen (only Home switches today), offline states, accessibility
   labels, dark-mode pass over the newer screens, the eight leftover
   eslint-disable comments.
6. Mainnet gating switchboard: per-feature readiness flags with honest
   in-app copy (Kernel accounts, guardians, session keys and passkeys
   testnet-only until C1–C3 clear; EOA sends, tokens, NFTs, swaps and
   WalletConnect are mainnet candidates); the one real Dogecoin broadcast
   if approved (about 1 DOGE in fees).
7. Standing inputs as they appear: 0x key, paymaster policy, counsel on
   (L)GPL/AGPL modules, the ZeroDev disclosure decision.

Waves: 1 + 2 + 4 first (no inputs, disjoint files), then 5 + 6, with 3
whenever the Expo account and identifiers arrive. Subagents on Opus.

## Phase 9 progress

- [x] Item 1 — owner-change bundler refusal: ROOT CAUSE FOUND AND FIXED
      (commit 37d3b89; engine 602 tests, check-recovery 216, check-passkeys
      126, check-aa 74). Not specific to the owner change and not an
      app-vs-script difference: Rundler (Alchemy's bundler; the error text
      is Rundler's) estimates verificationGasLimit with the operation's
      fees set to zero (rundler v0.7
      crates/contracts/contracts/v0_7/src/VerificationGasEstimationHelper.sol,
      _setFeesFields), so the account's EntryPoint deposit top-up
      (missingAccountFunds) never runs in estimation; at real fees
      EntryPoint v0.7 _validateAccountPrepayment requires the top-up
      whenever the deposit is below the prefund, the extra gas is not in
      the limit, and the tracer reports -32502 "Simulation ran out of gas
      for entity: account". Measured live on Sepolia with the dev seed's
      index-2 Kernel account: refused at Alchemy's own estimate (113,373)
      and at 91,249 when a top-up was needed, accepted at 125,000 / 150,000
      / 190,000, refused at 200,000+ with "-32602 Verification gas limit
      efficiency too low. Required: 0.4" (about 77.6k used), and accepted
      at 91,249 when the deposit already covered the prefund; a plain
      0-value call failed the same way. The app and script ops were
      field-identical apart from the script's padding. FIX: opt-in
      SmartAccountClientConfig.depositTopUpVerificationGas — when there is
      no paymaster and balanceOf(sender) on the EntryPoint is below the
      required prefund, the headroom is added to the signed
      verificationGasLimit after gasPaddingPct (unreadable deposit → plain
      estimate); new engine exports requiredPrefund, needsDepositTopUp,
      withDepositTopUpHeadroom, client.getEntryPointDeposit. App:
      AA_DEPOSIT_TOPUP_VERIFICATION_GAS = 40,000 (a measured judgement:
      ZeroDev's estimate becomes 131,249 and Alchemy's 153,373, above the
      highest refused value and below the efficiency floor) on every
      client (aa.ts both clients, recovery.ts, sessions.ts, passkeys.ts);
      AaSendQuote carries depositTopUpHeadroom so the confirm fee and the
      balance check equal the signed op, and the passkey quote pads the
      plain estimate before adding it back. Fixed app path proven live
      through Alchemy directly: rotation idx0→idx9 (no top-up needed) tx
      0x30c4a28c…11a9 block 11832342, rotation back idx9→idx0 WITH a
      top-up at 153,373 ACCEPTED, tx 0xb5499272…8a00f block 11832343,
      Deposited emitted during validation; final owner read back =
      0x16DA…C5C, no guardians. Funds: the account spent about 0.0016
      test ETH over 14 diagnostic ops; the dev EOA sent it 0.0006 and now
      holds about 0.0011 (top-up needed before further live runs).
      UNVERIFIED: the exact threshold (between 113,373 and 125,000); which
      bundler the emulator actually had saved (the error text and fee
      match Alchemy's Rundler, not ZeroDev's Alto-style answers); Pimlico /
      UltraRelay with the headroom; deployment ops with a zero deposit.
      EMULATOR RE-RUN, PROVEN LIVE both directions (2026-10-02, Expo Go,
      Sepolia, fresh Metro bundle of 37d3b89): Account 1 → Account 2 for
      the Kernel account 0xD31c…D8FA — the confirm's bundler estimate
      now carried the headroom (max fee 0.000494 test ETH versus 0.000383
      before the fix), biometric gate, "Owner change sent to the bundler",
      userOpHash 0x888511f7aee083b050198ac719f56cc5f58d0094699fa996021949906f412c73,
      then "Included — the owner is now Account 2 (checked on-chain)";
      the CTO read the owner back independently as Account 2
      (0xb699…81fE). "Switch to Account 2" worked; from Account 2 the
      Guardians screen showed the account under its new owner and the
      rotate-back to Account 1 (userOpHash
      0x3ff73fcfb249d14faaf04e357881fa0040410c43be8587b96fa748f99dd93711)
      was included, with "Switch to Account 1" returning the wallet to its
      starting state; final owner read back by the CTO: 0x772eAA1d3BEf14C0BD5cee980b90dB3FC680F44F. The
      "Back up the recovery record" prompt appeared after each change.
      Emulator lesson: while agents rebuild packages/*/dist, Metro in
      watch mode can serve a half-built engine (Home lost its account
      label and the Guardians screen its Owner-key section, logcat showed
      "Error: undefined"); a Metro restart with --clear fixed it —
      restart Metro after any engine rebuild.
- [x] Item 2 — docs/THREAT_MODEL.md (first edition, evidence at 860e552;
      about 9–10k words of prose): leadership summary with three
      conclusions (plain-account features are the first mainnet
      candidates but not yet; smart-account features stay testnet-only;
      the remaining large risk is showing the user something misleading),
      ten ranked assets, trust-boundary diagram and an AsyncStorage key
      inventory, a network-services table, 66 threats T-01..T-66 with
      mitigation evidence and residual risk, a mainnet checklist merging
      C1–C3 with W1–W20, a findings register (F-01..F-51 from this file
      plus N-01..N-11 new from the code), review guidance, a list of
      twelve doc-vs-code discrepancies, and what could not be
      substantiated. NEW FINDINGS N-01..N-11 for the Chairperson, headline
      ones: N-01 the phrase is stored in expo-secure-store WITHOUT
      requireAuthentication, so the biometric prompt is an app-level gate
      only and phones without enrolled biometrics get no prompt (contrary
      to ARCHITECTURE 2.4/5.1/D7's envelope-encryption description); N-06
      the dApp name/URL on the WalletConnect sheet is self-reported (no
      Verify API); N-07 Permit/Permit2 typed data is shown as raw JSON
      without a spender/amount summary; N-10 one RPC is the only source of
      truth for simulation, the eth_call gate, balances and risk facts
      (ARCHITECTURE 5.4 describes cross-checks and fee clamps that do not
      exist). Other discrepancies: no wallet passcode (recorded decision),
      BIP-39 passphrase supported by core but never passed by the app,
      secrets are JS strings and derived keys are not zeroed, caret
      ranges rather than exact pins, docs/DECISIONS.md cited but absent,
      ARCHITECTURE 2.2 vs D8 on import discovery. Could not substantiate:
      hardware backing of secure-store on real phones, passkey cloud sync,
      Expo's default android.allowBackup, iOS screen-capture blocking in
      release builds, release builds being free of LogBox/dev menu.
      Cross-references added to ARCHITECTURE.md, DEVICE_BUILDS.md and
      AA_FRAMEWORKS.md. The git history was searched for key-bearing URLs:
      none (only the public test mnemonic).
- [x] Item 4 — CI and test hardening (commit 1e37343). Root `npm test`
      = scripts/ci/run.mjs (plain Node, no dependencies, imports nothing
      from the code under test): engine build + vitest across the five
      packages, every app/scripts/*.mjs classified in scripts/ci/suites.mjs
      (the runner refuses to start if a script is unclassified), expo lint
      with --max-warnings 0, app tsc, and an Android expo export as a
      bundle smoke; it parses each script's own summary line (three
      formats exist) and fails on any failed count, a missing summary, a
      non-zero exit, a timeout (process group killed) or — in offline
      mode — any network attempt. Offline mode preloads
      scripts/ci/offline-guard.mjs via NODE_OPTIONS=--import into every
      child: blocks fetch and net.Socket connects to anything but
      loopback and makes .dev-wallet/ look absent, so check-doge and
      check-indexer run their offline sections (72 / 11) and the
      live-only suites (check-tokens, check-balances, check-history) are
      skipped; `npm run test:live` runs everything with keys. Measured:
      32 steps, 602 engine tests, 2,074 app checks across 23 suites, about
      80 s warm (100 s from a fresh clone; bundle 22–35 s). Options after
      `--`: --mode, --only, --skip-bundle, --verbose, --logs-dir; env
      SHIBA_CI_SKIP_BUNDLE, SHIBA_CI_TIMEOUT_SCALE. Workflow
      .github/workflows/ci.yml (replaces the old two-job file that ran
      only test-units): one job, Node 24, npm cache keyed on both
      lockfiles, `npm ci --ignore-scripts` at root and in app (npm 11
      recreates the file: symlinks before the engine build, so no
      workaround), the secret scan over HEAD, then `npm test`; logs
      uploaded only on failure; no secrets; contents: read;
      persist-credentials false; SHA-pinned actions (checkout v7.0.1,
      setup-node v7.0.0, upload-artifact v7.0.1); 30-min timeout;
      cancel-in-progress; repository variable SHIBA_CI_SKIP_BUNDLE=1
      turns the bundle step off. Validated with @action-validator/cli
      0.6.0. Pre-commit secret scan: scripts/githooks/pre-commit →
      secret-scan.mjs (Node 14+): Alchemy /v2/ and /nft/v3/ keys (20+
      chars — the real key is 26, not 32), ZeroDev UUIDs in
      rpc.zerodev.app URLs or ZERODEV_PROJECT_ID=, NOWNodes values, 12+
      consecutive BIP-39 words in any case (checksum-decoded with
      node:crypto; the all-repeated-byte test vectors are allowed), 0x +
      64 hex within 40 chars of key/priv/secret (32+ leading zeros =
      storage slots ignored), and every literal .dev-wallet value from the
      checkout and the main checkout via git-common-dir; findings print
      only the first 4 characters and the length; a missing node or
      wordlist refuses the commit. Allow list: REOWN_PROJECT_ID (name and
      value; equals DEFAULT_WC_PROJECT_ID in walletconnect.ts) and two
      disposable test keys already public in history (SESSION_PRIVATE_KEY
      in kernel-permissions.test.ts, the synthetic P-256 SDK.secret in
      kernel-webauthn.test.ts). HEAD scan clean (280 files); the hook was
      proven to refuse staged fakes (13 findings), a force-staged
      .dev-wallet/env and a real commit, on Node 24 and 14. Enabled on the
      CTO's checkout with `git config core.hooksPath scripts/githooks`
      (`npm run hooks:install`); the commit 1e37343 itself passed through
      it. docs/CONTRIBUTING.md and README document the commands. npm
      audit: root 11 findings (8 moderate, 3 high) all in test-only
      cross-check tools (@solana/web3.js 1.99 chain: bigint-buffer, jayson,
      stream-json, uuid; vitest), app 14 (9 moderate, 5 high) all in the
      Expo CLI/config tooling chain (node-forge, uuid via xcode); the only
      offered fixes are breaking (web3.js 3, vitest 5, expo 44), so none
      applied. FINDING: check-tokens runs an unconditional live eth_call
      section after its offline checks, so its offline checks are not in
      CI — move the live section behind --live (follow-up). First GitHub
      Actions runs on the public repo: 12b311c and 1e37343 both completed
      with conclusion success (github.com/smwells25/shiba-wallet/actions,
      runs 37081746661 and 37082671263).
- [x] Item 6 — mainnet readiness switchboard (commit 68b6292;
      check-readiness.mjs 115 new checks; check-aa 81, check-aa-kernel 76,
      check-7702 118, check-sessions 102, check-passkeys 129,
      check-recovery 231; re-verified by the CTO in an isolated worktree
      incl. the offline app runner ALL GREEN, tsc and lint clean).
      app/src/config/readiness.ts: one table, feature → status
      ('mainnet-ok' | 'testnet-only' | 'blocked') → plain reason →
      THREAT_MODEL.md evidence ids; helpers isFeatureAllowed,
      readinessReason, readinessRefusal, assertFeatureAllowed
      (FeatureNotAllowedError), readinessGate, isTestNetwork (only
      eip155:11155111 counts; unknown chains are mainnet); NO developer
      override by design. Statuses: NO feature is mainnet-ok today —
      every one cites an unmet C/W item (check-readiness parses the
      threat model and would fail if a feature claimed mainnet-ok with an
      unmet item). Enforced (testnet-only): simple-account,
      kernel-smart-account, eip7702-upgrade, session-keys, passkeys,
      guardians, owner-rotation, paymaster. Advisory only ("blocked",
      shown in Settings but still running on mainnet — a Chairperson
      decision): eoa-send (W1–W4, W13, W17–W20, N-01), tokens (+N-10), nft
      (+F-47), swap (W7), walletconnect (W11, W12, N-06, N-07),
      dogecoin-send (W6/F-41; enforcing it needs one line in send.ts or
      SendScreen, outside the agent's scope — follow-up once the plain
      rows are decided). Gates fire before any network request: aa.ts
      isAaConfigured is false where the owner's account type is not
      allowed (AaChainConfig gained `chain`; a config without it counts
      as gated), which hides the Send/Swap smart-account toggles, the
      session/passkey/recovery eligibility hooks and WalletConnect's
      smart-account offer (all read through loadAaBundle) without editing
      those files; hasCompleteAaSettings keeps the undo paths working;
      setAaBundlerUrl / setAaFactory / setAaKernelFactory / setAaPaymaster
      / setAccountEip7702(true) refuse and persist nothing; sendAa refuses
      a quote carrying a 7702 upgrade; delegation.ts prepareSetCodeTx
      refuses upgrades and sendSetCodeTx accepts only zero-address
      tuples; sessions.ts (prepare/install/sendSessionCalls before the
      vault read), passkeys.ts (prepare/install/prepare calls/send/
      signHash), recovery.ts (guardian install/renew quotes and submits,
      recovery start, approveWithSig, review/sign/submit, attach, owner
      rotation quote/submit) all refuse with the reason. Undo paths are
      deliberately open: revoke/cancel upgrade, revoke/forget session,
      remove/forget passkey, remove guardians, veto, finish an owner
      change already sent, clear settings. Screens: the seven feature
      screens show a "test networks only" card with the reason and the
      Settings → Developer hint and disable their start buttons; Settings
      gained a "Mainnet readiness" section (status chip, reason,
      enforced-or-advisory, evidence ids) and a gating note in the AA
      section whose editors lock on gated chains (Clear still works).
      Notes: the card component is duplicated per screen (could move to
      components.tsx); THREAT_MODEL.md W10 and W15 are now met by items 4
      and 1 and the document should be updated; sendAa in general is not
      gated (screens never reach it on mainnet; full gating would need
      check-wc-5792 changes). Not eyeballed on a device.
- [x] Item 5 — resilience and UX polish (commit e2bc5bb; new
      check-failover.mjs 70 checks incl. mutation tests; check-tokens 23
      offline / 28 with --live; the CTO's isolated-worktree run of the
      offline runner: 2,319 app checks across 26 suites, lint and tsc
      clean, ALL GREEN; the agent's run also bundled 7.3MB with the new
      strings). ONE failover rule: runWithEndpointFailover in
      app/src/config/endpoint-probe.ts — on a transport-level failure of a
      DEFAULT endpoint (isEndpointFailure: fetch TypeErrors, aborts,
      timeouts, SyntaxError, HTTP 401/403/404/408/425/429/5xx, JSON-RPC
      -32005 / rate-limit text; NOT HTTP 400, reverts, insufficient funds,
      archive-depth refusals or app-level errors) it reports the failure,
      re-resolves the chain and repeats the operation ONCE on the new
      candidate only if it is a different URL that passed the identity
      probe, is not an override and is on the same network; never a third
      attempt; overrides are never reported, re-resolved or probed around.
      networks.ts: callWithFailover / withEndpoint (resolve at call time,
      return the endpoint that answered, NoEndpointError when none) and
      forgetDefaultEndpointChoices on reconnect; networks.ts now uses .ts
      import extensions so Node loads it. Used by: useBalances
      (loadNativeBalance; the hook takes activeEvmChainId so a mode flip
      reloads all four rows — a deliberate trade-off that removed a lint
      disable), useHistory (loadHistoryPage: Esplora, Solana and the
      logs fallback; the indexer path is never failed over), every EOA
      quote and Max in SendScreen (native, ERC-20, NFT, UTXO, Solana),
      Swap (sell balance, fee estimate, allowance+prepare as one wrapped
      call, allowance polls follow the healthy endpoint via
      waitForAllowance's URL function + onPollError), Approvals (scan,
      live re-read, Search older, revoke quote), useDelegation (its url is
      the endpoint that answered). QUOTE PINNING: send.ts
      quoteEndpointChange + QUOTE_ENDPOINT_CHANGED_TITLE ("Please review
      again"); Send, Swap (approve / swap / smart-account swap) and the
      approvals revoke re-resolve just before the biometric gate and
      refuse with a host-only sentence ("Nothing was signed or sent…") if
      the endpoint moved, returning to the form; sends always go out
      through the quoted URL; the balance-change preview and risk facts
      use the quote's URL by design (THREAT_MODEL T-21) — the preview
      reports transport failures as a calm "unreachable" note
      (simulation.ts onEndpointFailure / unreachable /
      PREVIEW_UNREACHABLE_NOTE) and the pin check then forces a re-quote;
      AA quotes are pinned to the endpoint resolved at quote time (bundler
      vs node errors are indistinguishable); NFT/history indexers are
      user configuration and never failed over. connectivity.ts: useOffline
      / OfflineNotice (@react-native-community/netinfo 12.0.1,
      useNetInfoInstance with reachabilityShouldRun off so no probe to
      clients3.google.com; reads isConnected only; informs, never blocks)
      and describeNetworkError; send.ts describeSendError gained a
      transport-failure branch ("Could not reach the network endpoint.
      Check your connection.") after all existing branches. Screens: calm
      error + muted detail + Retry/Try again on Activity (Load more keeps
      the list), NFTs (a failed Load more no longer replaces the gallery),
      NftDetail, Tokens, Approvals, Connections (Try again calls
      ensureStarted), Swap (sell balance "could not be loaded right now");
      offline notice on Home/Send/Swap/Tokens/Approvals/Activity/NFTs/
      Connections; accessibility roles/labels/hints/live regions on Home,
      Send, Swap, Receive, QrScanner (spinner while permission loads),
      Contacts, ContactsScreen, Activity rows (read as one sentence),
      NFT tiles; RefreshControl tint colours added where missing; no
      hard-coded light colours found in the owned files (Receive's white
      QR card and the orange TESTNET badge are intentional). ESLint
      disables: HomeScreen:230, NftDetailScreen:76 and useDelegation:83
      removed by fixing the code; BalanceChangePreview, RiskWarnings and
      NftImage converted to the reasoned form (true reasons: callers
      pass inline objects keyed by a serialized key); WcApprovalSheet's
      two left for the security slice. Strings asserted by scripts were
      kept verbatim. FOLLOW-UPS outside the agent's files:
      useTokenBalances.ts (Home token rows) has no failover yet (about
      three lines with withEndpoint); WalletConnect transaction quotes are
      neither failed over nor pinned; UpgradeAccountScreen should pin its
      quote's URL like Send; components.tsx Button lacks
      accessibilityState; Home chain cards nest Pressables (VoiceOver
      grouping to check on a device). Nothing eyeballed on a device
      (offline notice placement, TalkBack/VoiceOver, NetInfo accuracy on
      real phones).
- [x] Security quick wins from the threat model (commit 3194031; new
      check-storage.mjs 260 and check-typed-data.mjs 106, check-wc 224;
      offline runner green; GitHub Actions run for 3194031 success incl.
      the bundle export — the CTO's worktree export step fails only
      because Metro cannot resolve the worktree's symlinked node_modules,
      an environment artefact). N-01 — biometric-protected phrase storage
      (app/src/wallet/storage.ts, now Node-loadable with an injected
      secure-store backend bound once by WalletContext): expo-secure-store
      57.0.4 facts from its sources — Android requireAuthentication = an
      AES-256-GCM Keystore key with setUserAuthenticationRequired(true),
      every read and write shows a BiometricPrompt with a CryptoObject,
      BIOMETRIC_STRONG only, no PIN fallback (negative button is Cancel),
      an invalidated key makes reads return null; iOS = SecAccessControl
      .biometryCurrentSet (reads and updates prompt, creation does not;
      NSFaceIDUsageDescription is required — the expo-secure-store plugin
      already writes a default one for dev/store builds, Expo Go on iOS
      lacks it). INVALIDATION RULE: adding/removing a fingerprint or face
      or turning off the screen lock (Android), adding/removing a finger
      or re-enrolling Face ID (iOS) permanently invalidates the entry and
      the user must restore from the written backup. Entries: standard
      shiba-wallet.mnemonic.v1 (unchanged), protected
      shiba-wallet.mnemonic.v2 under keychain service
      shiba-wallet.protected, meta shiba-wallet.vault-meta.v1 (a protected
      item's existence cannot be checked without a prompt; corrupt meta
      with no standard copy counts as protected, never as "no wallet"),
      public account cache shiba-wallet.public-account.v1.N (addresses and
      paths only, so launch needs no prompt). A new wallet never silently
      replaces a readable different one. Migration: locate standard copy →
      eligibility (strong biometrics) → write protected → read back and
      compare (mismatch/cancel/null → delete protected, stop) → set meta →
      delete standard (if that fails, the next protected read deletes the
      standard copy only if identical); an unreadable protected copy with a
      standard copy present falls back; every outcome recorded with the
      platform's verbatim error. POLICY DECISION (CTO 2026-10-02, pending
      the Chairperson): PHRASE_PROTECTION_POLICY = 'opt-in' (the agent had
      built 'automatic'); the move is a Settings button that states the
      invalidation trade-off; 'automatic' and 'off' remain one constant
      away and are tested. Session keys: new keys follow the phrase's
      protection; existing keys stay until revoked/expired. One prompt per
      operation: biometric.ts requireLocalAuth first opens the protected
      phrase (that system prompt is the verification) and holds it for one
      use / at most 30 s / dropped on background (not on iOS "inactive",
      which its own Face ID prompt triggers); other cases use the existing
      expo-local-authentication prompt with passcode fallback; no call
      sites changed. Honest limits: protected approvals are biometric-only
      (lockout → signing waits; the lock screen still unlocks by passcode);
      two prompts for a session test op, a session install on Android, and
      the Android migration (write + read-back); phones without strong
      biometrics stay standard with no gate; the phrase remains a JS string
      (N-03); THREAT_MODEL.md's key inventory needs the new entries
      (follow-up). storageProtection() status shape and
      upgradePhraseProtection() are consumed by the Settings section
      (separate commit). N-07 — app/src/wallet/typed-data-summary.ts, a
      card above the raw JSON on the WalletConnect sheet (raw JSON and the
      generic warning kept; the summary never declines; digest and domain
      policy unchanged): EIP-2612 Permit (token = verifyingContract),
      DAI-style permit (allowed = unlimited, expiry 0 = never), Uniswap
      Permit2 PermitSingle/PermitBatch/PermitTransferFrom/
      PermitBatchTransferFrom and Witness variants (Uniswap/permit2
      cc56ad0f; canonical 0x000000000022D473030F116dDEE9F6B43aC78BA3 from
      Permit2Lib.sol, same 9,152-byte code on mainnet and Sepolia; a
      Permit2-shaped message under another domain/contract gets a "likely
      phishing" warning), generic fallback listing type, domain, contract
      and every field (addresses checksummed in full, bytes truncated,
      control/bidi characters stripped); schemas recognised only when the
      request's own types match the canonical definitions field for field;
      amounts in the tracked token's decimals (CAIP-2 rule) else raw base
      units labelled; "Unlimited" only at exactly max uint256 / max uint160
      (Permit2), never masked; absolute UTC + relative expiries (Permit2
      expiration 0 = "only in the block where it is used"); warnings for
      unlimited, > 30 days or never, owner ≠ signer, spender without code
      or with a 7702 delegation (classifyRecipient on the active endpoint;
      lookup failure raises nothing); spenders through
      RecipientContactNotice. N-06 — WalletKit 1.6.0 passes sign-client
      2.25.0's Verify.Context through unchanged (starts UNKNOWN with origin
      = metadata.url; a Verify answer sets the attested origin and isScam;
      VALID iff origins match): walletconnect.ts describeVerifyContext +
      identityApprovalAllowed, every wc-controller item carries
      `identity`; the sheet shows "Verified by WalletConnect: origin
      matches", "UNVERIFIED — …", "MISMATCH — the request claims X but
      came from Y: likely phishing" or "Flagged as a scam by
      WalletConnect…" (scam wins even when origins match); for scam or
      mismatch every approve button (connect, sign ×2, send, smart send,
      grant) is disabled until "I understand the risk — let me approve
      anyway" is on, re-checked in WalletConnectContext; nothing is
      auto-declined. docs/ARCHITECTURE.md 2.4, 5.1, 5.3 (items 2 and 4) and
      D7 rewritten to match the code. UNVERIFIED: requireAuthentication
      inside Expo Go on Android (expected to work), everything on iOS
      (invalidated reads, Face ID disabled for the app, Expo Go's refusal
      text), hardware enforcement on the emulator (software Keystore),
      whether Verify returns VALID/isScam over the live relay in RN,
      whether 30 s always covers approval-to-signing (else one extra
      prompt). Emulator checklist (8 steps) in the builder's report.
- [x] Settings "Recovery phrase protection" section (commit d037fd9;
      check-settings-protection.mjs 50 checks; GitHub Actions run for
      d037fd9 success): status copy per storage state (protected since a
      date, unreadable → PHRASE_UNREADABLE_MESSAGE, standard by reason:
      no-strong-biometrics / not-attempted / cancelled / platform-refused /
      verify-failed / reverted / policy-off), the "Protect with
      biometrics" button only when canProtectNow, a confirm dialog that
      states the invalidation trade-off before upgradePhraseProtection(),
      outcome alerts, status re-read on focus / after the button / after a
      reveal, and the reveal flow shows the protection status instead of
      "No recovery phrase found" when revealMnemonic() returns null. Copy
      lives in app/src/wallet/phrase-protection-copy.ts so the check
      script pins every string and runs the real vault against an
      in-memory store. EMULATOR, PROVEN LIVE in Expo Go (AVD with PIN +
      fingerprint, Metro from the worktree at d037fd9): the existing
      wallet opened normally on the new vault code; Settings showed both
      new sections ("Recovery phrase protection" with the not-attempted
      copy and the button; "Mainnet readiness" with "Sending from your
      regular account — Not yet cleared" and its reason); tapping Protect
      showed the confirm dialog, then the two Android system prompts
      "Protect your recovery phrase with biometrics" and "Confirm your
      protected recovery phrase" (simulated fingerprint each), then the
      alert "Recovery phrase protected" and the status "protected by
      biometrics (since 2026-10-03)" — so expo-secure-store's
      requireAuthentication works inside Expo Go on Android (previously
      unverified). Afterwards Show recovery phrase raised exactly ONE
      system prompt ("Reveal recovery phrase") and the 12 words rendered
      with no further prompt (the CTO's check filtered the UI dump so the
      words were never printed), and a force-stop relaunch reached Home
      (Account 1) with NO prompt, i.e. the public account cache works.
      The emulator wallet's phrase is now in protected storage: adding or
      removing the AVD's fingerprint will make it unreadable (the written
      phrase for that wallet is not recorded anywhere; it is a test
      wallet). A Sepolia send confirm then raised exactly ONE system
      prompt, titled "Approve sending 0.00001 test ETH" (the
      protected-phrase prompt doubles as the approval), and cancelling it
      showed "Not sent — Authentication cancelled." with nothing
      broadcast. Not yet eyeballed: the unreadable state and the
      section's dark-mode layout.
- [x] Resilience follow-ups (commit e51a33e; check-failover 115, check-wc
      232; offline runner ALL GREEN in the CTO's worktree): Home token rows
      resolve the endpoint at call time and fail over once
      (useTokenBalances loadTokenBalance); the set-code quote carries its
      URL and sendSetCodeTx refuses any other, UpgradeAccountScreen quotes
      through withEndpoint and re-resolves before the biometric gate
      (refusal with QUOTE_ENDPOINT_CHANGED_TITLE, back to the overview);
      WalletConnect eth_sendTransaction quotes go through the failover
      rule (walletconnect.ts quoteWcTransaction) and at approval a moved
      endpoint re-quotes automatically with WC_REQUOTED_NOTE ("The network
      endpoint changed; the fee was re-quoted."), re-running the eth_call
      gate, preview and risk warnings on the new URL, with a second pin
      check after the biometric prompt that returns the request to the
      sheet rather than declining; AA quotes stay pinned as before;
      components.tsx Button exposes accessibilityState (disabled,
      selected) plus optional accessibilityLabel/Hint, and Swap's chips
      pass selected. Mutation-tested (four deliberate breaks each failed
      the new checks). Not on a device: the re-quote note/busy state, the
      Upgrade refusal alert, TalkBack/VoiceOver reading of chip state; a
      failed re-quote offers only Reject (matches existing behaviour).
- [x] THREAT_MODEL.md second edition (evidence at 02f6154): new
      secure-store inventory and per-platform behaviour, the opt-in policy
      and migration machine, invalidation rule; threat rows T-01/02/08/09/
      11/13/21/23/25/26/30/16/28/40/50/56/58/62/64 updated; checklist W1
      partially met (opt-in), W9 met (68b6292), W10 met (1e37343 + green
      runs; caveat: npm audit ran once by hand, not in CI), W11/W12 partly
      met (3194031; not exercised with a live dApp/relay), W15 met
      (37d3b89); findings F-36 fixed, F-44 mostly fixed, N-01 implemented
      as opt-in (still open while W1 is partial), N-06/N-07 mitigated
      (unverified live), N-10 still open (failover is availability, not a
      second-source cross-check); new F-52..F-57 (check-tokens in CI,
      npm audit, switchboard residuals, failover gaps, protected-storage
      limits, half-built engine via Metro); section 7.2 names npm test /
      test:live / the secret scan / hooks:install / CI as the reproduction
      entry points with current counts; section 8 items 1, 2, 6 resolved,
      new 13 (ARCHITECTURE said "automatic") and 14 (CONTRIBUTING said
      check-tokens is "live") — both fixed by the CTO in the same commit.
      check-readiness (which parses the document) still 115/115.
- [x] Item 3, the part that needs no account (commits 2d04238, 6345dd8
      and the dev-client commit below). app/eas.json: cli.version >=
      19.1.0, appVersionSource remote, a base profile pinning Node 24.21.0
      (EAS sdk-57 images default to Node 22.23.x), profiles development
      (dev client, internal, Android APK, iOS device), development-simulator
      (iOS simulator), preview (internal, APK), production (store,
      autoIncrement, Android app bundle; submit to the Play internal track
      as a draft); validated offline with @expo/eas-json 24.9.0 (eas
      config/build need a login). app.json: android.allowBackup false
      (Expo's default is true per @expo/config-plugins 57.0.9; the
      secure-store plugin's backup rules already limit the backup to
      shared preferences minus SecureStore, so AsyncStorage's RKStorage
      database was probably excluded already — W18 still needs a bmgr
      device test), blockedPermissions RECORD_AUDIO / READ_MEDIA_IMAGES
      (requested by expo-screen-capture's manifest; Play restricts it and
      the app never uses the screenshot listener) / READ_EXTERNAL_STORAGE
      / WRITE_EXTERNAL_STORAGE (DETECT_SCREEN_CAPTURE deliberately kept),
      expo-camera microphonePermission false + recordAudioAndroid false,
      one plain Face ID sentence through the expo-secure-store and
      expo-local-authentication plugins (resulting iOS usage strings:
      camera and Face ID only); identifiers/owner left unset.
      docs/RELEASE.md (prerequisites, eas-cli commands per profile, the
      device checklist, pre-release checklist, versioning, rollback via
      update channels — expo-updates NOT installed; adopting it is a
      security decision: code signing needs the EAS Production/Enterprise
      plans and Apple 2.5.2 applies), docs/STORE_LISTING.md (listing
      draft, policy citations, data-safety / privacy-nutrition drafts for
      counsel), docs/PRIVACY.md (what leaves the device and to whom,
      on-device inventory, controls), DEVICE_BUILDS.md (expo-screen-capture
      57.0.3 behaves the same in release builds: Android FLAG_SECURE incl.
      the recents preview; iOS screenshots via a secure-text-field layer
      — a UIKit rendering property, not an Apple API — recordings/
      mirroring via a black overlay only during capture; the app switcher
      is NOT covered because enableAppSwitcherProtectionAsync is never
      called (N-05); nothing on iOS observed). expo-doctor: 20/21 (the
      known patch drift expo 57.0.25 vs ~57.0.26, expo-camera 57.0.5 vs
      ~57.0.6 — unchanged). FINDINGS FOR THE CHAIRPERSON: (1) Apple
      guideline 3.1.5(i) allows wallet apps only from developers enrolled
      as an organization (the brief's (iii) is the exchanges clause,
      relevant to the 0x swap — counsel); (2) Google Play states
      non-custodial wallets are out of scope of its crypto policy (answer
      16329703); how the Financial Features declaration expresses that is
      unverified; (3) the WalletConnect SDK sent telemetry by default
      (@walletconnect/core 2.25.0 posts an init event with client id, user
      agent and project id to pulse.walletconnect.org) — FIXED in 6345dd8
      with telemetryEnabled: false, pinned by check-wc (233); (4) two build
      blockers FIXED in the next commit: expo-dev-client installed
      (development profiles need it) and the app/package.json hook
      eas-build-post-install = "cd .. && npm ci --ignore-scripts && npm run
      build" because packages/*/dist are git-ignored (whether the EAS
      upload includes the monorepo root is unverified); (5) app changes
      still needed: an in-app privacy-policy link (Apple 5.1.1(i)) and
      refusing http:// endpoints (for a clean encrypted-in-transit answer).
      PLACEHOLDERS the Chairperson must fill: Expo account (+ owner), iOS
      bundle identifier, Android package name, Apple organization
      enrollment + Team ID + App Store Connect app id, Google Play
      organization account + app + service-account key, the passkey rpId
      domain, privacy-policy and support URLs, publisher legal name and
      contact, counsel's encryption-export answer (usesNonExemptEncryption
      unset), the final app name after a trademark check on "Shiba",
      distribution countries and whether swaps ship at launch, a real
      WalletConnect metadata URL (replacing shiba-wallet.example),
      screenshots/artwork, whether to install expo-splash-screen
      (splash-icon.png is unused in SDK 57 without it), supportsTablet.
      UNVERIFIED: any EAS build or submission, a real build's merged
      manifest, removing SYSTEM_ALERT_WINDOW (from Expo's template), phased
      release behaviour, iOS backup of ordinary app data, a network capture
      of a release build.
- [x] https-only endpoints (commit dd14e69; offline runner ALL GREEN in
      the CTO's worktree): app/src/config/endpoint-url.ts
      assertSecureEndpointUrl (regex parse, not `new URL`, because RN's
      URL has been incomplete) returns the trimmed, trailing-slash-free,
      scheme-lowercased URL or throws INSECURE_ENDPOINT_MESSAGE
      "Endpoints must use https:// (plain http:// is accepted only for
      localhost or 10.0.2.2 during development)."; loopback = exactly
      localhost / 127.0.0.1 / [::1] / 10.0.2.2, host read after the last
      "@" (http://localhost@rpc.example is refused; 192.168.x.x, 10.0.2.3,
      127.0.0.2, localhost.example.com, [::2] refused); malformed https
      (no host, bad port, spaces/control characters) get their own
      messages. Called before any network verification in
      setEndpointOverride (networks.ts, which gained an injectable store),
      setBlockbookEndpoint, setIndexerUrl, setNftIndexerUrl (+ its rpcUrl),
      setAaBundlerUrl, setAaPaymaster, and the node URL in setAaFactory /
      setAaKernelFactory (after the readiness check); swap.ts and
      prices.ts take keys for fixed https bases (asserted); WalletConnect
      pairing URIs untouched. Settings shows the sentence once in each of
      the four endpoint sections. GAP: only setters are guarded; URLs
      saved before this change are not re-checked on read (nothing is
      released, so only dev/emulator installs could hold one) — a
      load-time filter is a small follow-up. Suites: check-devmode 102
      (was 71), check-aa 90 (81), check-doge 79 offline (72),
      check-indexer 15 offline (11), check-nfts 124 (120), check-swap 91
      (89), check-rpc-fallback 87 (85; every default candidate passes the
      helper).
- [ ] Stray "W ReactNativeJS: Error: undefined" at launch (Expo Go,
      emulator): ruled out by code reading — no console.* calls in
      app/src, App.tsx, index.ts or packages/*/src; RN 0.86.3 prints an
      undefined unhandled rejection as an E line "Uncaught (in promise…)";
      the console polyfill prints Error objects as "[Error: …]", so a W
      line reading exactly "Error: undefined" must be console.warn of
      that string (an Error("undefined") stringified) or native Android
      logging under the ReactNativeJS tag; WalletConnect's logger forwards
      at error level. Shortlist: a line of a multi-line warning (the
      preceding logcat line is the clue), a dependency stringifying an
      Error("undefined"), Expo Go's own native code. A clean relaunch with
      `adb logcat -c` then `adb logcat -d -v long` captured 4,881 lines and
      only ONE ReactNativeJS entry (the "Running main" line): the warning
      did not recur, so it is intermittent (earlier it appeared once per
      launch during long sessions with WalletConnect sessions live). Not
      blocking; next time it shows, read the logcat line BEFORE it (the
      agent's first hypothesis) or temporarily wrap console.warn in
      index.ts to print the caller's stack.

## Phase 9 status (2026-10-02, end of the autonomous run)

Landed and pushed, CI green on every push: item 1 (deposit-headroom fix,
proven live in-app both directions), item 2 (threat model, second
edition), item 4 (CI, offline runner, pre-commit secret scan), item 5
(resilience, offline notice, accessibility, lint-disable cleanup, plus
the four follow-ups), item 6 (readiness switchboard; smart-account
features enforced testnet-only, plain features advisory pending the
Chairperson), the three threat-model quick wins (opt-in
biometric-protected storage proven live in Expo Go, Permit/Permit2
summaries, WalletConnect identity verification), the Settings
protection section, the WalletConnect telemetry switch-off, https-only
endpoints, and item 3's input-free part (EAS profiles, store-ready
app.json, release/store/privacy documents, expo-dev-client, the EAS
engine-build hook). Engine: 602 tests. App: 29 offline suites, 2,875
checks, lint 0, tsc clean, bundle 7.4MB.

Waiting on inputs (item 3 remainder, item 7): Expo account + owner, iOS
bundle identifier, Android package name, Apple organization enrollment
(Team ID, App Store Connect app id), Google Play organization account +
service-account key, the passkey rpId domain, privacy-policy and support
URLs, publisher legal name and contact, counsel on encryption export /
(L)GPL-AGPL modules / the 3.1.5 exchange clause for swaps, the final
app name after a trademark check, distribution countries, whether swaps
ship at launch, a real WalletConnect metadata URL, screenshots/artwork,
expo-splash-screen and supportsTablet decisions, the ZeroDev disclosure
decision, a 0x key, a paymaster policy, about 1 DOGE for the mainnet
broadcast.

DECIDED by the Chairperson (2026-10-02): (a) PHRASE_PROTECTION_POLICY
stays 'opt-in' — users must not be forced into biometrics; (b) the
plain-feature readiness rows (EOA send, tokens, NFTs, swap,
WalletConnect, Dogecoin send) stay ADVISORY: all of those features are
required, and the wallet's purpose is to show they can work inside an
account-abstraction wallet, so they keep working on mainnet with the
Settings copy stating what is not yet cleared. Dogecoin needs only a
prototype-level demonstration, not extensive testing: the one real
broadcast (a tiny self-send, about 1 DOGE in fees) remains the way to
show it works end to end and runs automatically from
scripts/testnet/smoke.mjs as soon as DOGE lands on the dev address
printed by scripts/testnet/setup.mjs.

Open follow-ups (no inputs needed): in-app privacy-policy link once a URL
exists; load-time filtering of previously saved http endpoints;
enforcing dogecoin-send if the plain rows are enforced; the guardian
recovery spec's exact-nonce move to getNonceKey; moving the
test-networks-only card into components.tsx; WarningBox accessibility
role; THREAT_MODEL rows F-44/F-55/T-23 after e51a33e; the intermittent
"Error: undefined" warning; device-only validations (W2–W4, W18–W19,
FaceID, StrongBox, TalkBack/VoiceOver, iOS protected-storage behaviour)
once a development build exists.
- [x] Dogecoin mainnet demonstration script (commit f84f6e8;
      scripts/testnet/doge-mainnet-demo.mjs; documented in
      THREAT_MODEL.md 7.5 as the one script allowed to touch mainnet
      funds, bounded to a few DOGE, and in the README's scripts/testnet
      row). Dev wallet mainnet address DEQ788Pe98Z97Le6feBa2P49JL7ETGSMNf
      (m/44'/3'/0'/0/0 via core dogecoinKeyProvider; the script refuses
      if the derivation differs). DRY RUN by default: the app's own
      prepareUtxoSend (backend blockbook over dogebook.nownodes.io, api-key
      header never printed) quotes a 1 DOGE self-send, chains-utxo signs
      it (signed twice, bytes asserted identical so the dry-run txid is
      the broadcast txid), bitcoinjs-lib 6.1.8 decodes it independently
      (25 checks: txid, size, version 2 / locktime 0, outpoint, scriptSig
      <sig> <pubkey> with hash160 == address, SIGHASH_ALL low-S verified
      over bitcoinjs's own sighash, outputs re-encoded with version 0x1e
      to the dev address only, inputs − outputs == fee). Rails: GET /api
      must report coin "Dogecoin", chain "main", in sync; block-index/0
      must equal the CAIP-2 genesis 1a91e3dace36e2be3bf030a65679fe82;
      fee <= 2 DOGE and <= 5% of the amount; change >= 0.01 DOGE; every
      input and output bound to the dev address; broadcast only with
      DOGE_MAINNET_BROADCAST=1 plus the exact txid typed on stdin, through
      the app's sendUtxo → engine signAndBroadcast → blockbookTransport
      (POST /api/v2/sendtx/ per Blockbook docs/api.md and master
      openapi.yaml — unverified live until a broadcast), then polls
      /api/v2/tx/{txid} every 15 s for up to 20 minutes. Live dry run
      2026-10-02: host runs Blockbook 0.6.0 over Dogecoin Core 1.14.9,
      estimatefee/6 = 0.01002525, balance 0 → printed the funding
      instruction. Offline --fake-utxos (10 DOGE): txid 4c1232fc…41f0,
      225 bytes, fee 0.00226678 DOGE at 1003 sat/vB quoted, change
      8.99773322, all 25 decode checks passed. Command once ~5 DOGE
      arrive: `npm run build && node scripts/testnet/doge-mainnet-demo.mjs`
      (review), then `DOGE_MAINNET_BROADCAST=1 node
      scripts/testnet/doge-mainnet-demo.mjs`. FINDING (engine bug,
      fix in progress): chains-utxo applies Bitcoin Core's dust (546 base
      units for P2PKH) to Dogecoin, but Dogecoin Core 1.14.9 (policy.h /
      policy.cpp / dogecoin-fees.cpp at v1.14.9) has a hard dust limit of
      0.001 DOGE (non-standard below it) and a soft limit of 0.01 DOGE
      (each output below it adds 0.01 DOGE to the required fee), so the
      app's Dogecoin send could create change between 546 and 1,000,000
      base units that nodes reject or surcharge — reasoned from source,
      not yet observed live.
- [x] Dogecoin dust policy fix (commit above; chains-utxo tests 48 →
      70, engine 624; check-doge 92 offline; re-verified by the CTO in
      the isolated worktree incl. check-token-send 37 and tsc). Verified
      from dogecoin/dogecoin v1.14.9: amount.h COIN = 100000000;
      policy.h:23 RECOMMENDED_MIN_TX_FEE = COIN / 100; policy.h:70
      DEFAULT_DUST_LIMIT = RECOMMENDED_MIN_TX_FEE (soft, 0.01 DOGE =
      1,000,000 koinu, "evaluated when considering whether a transaction
      output is required to pay additional fee"); policy.h:81
      DEFAULT_HARD_DUST_LIMIT = DEFAULT_DUST_LIMIT / 10 (0.001 DOGE,
      "will not be accepted to the mempool and thus not relayed");
      policy.cpp:109 IsStandardTx rejects outputs IsDust(hard) with
      reason "dust"; transaction.h:169 IsDust is strict (<);
      dogecoin-fees.cpp:97 GetDogecoinDustFee adds the soft limit per
      output below it, applied on relay from peers (validation.cpp:799
      with fLimitFree true; DEFAULT_LIMITFREERELAY = 0 → "rate limited
      free transaction"), while local sendrawtransaction uses fLimitFree
      false — so an underpaying tx can enter the first node's mempool and
      then fail to propagate. Limits are global defaults (init.cpp), same
      on testnet. Fee floor: validation.h:59 DEFAULT_MIN_RELAY_TX_FEE =
      RECOMMENDED_MIN_TX_FEE / 10 = 0.001 DOGE/kB (the app's 1000 sat/vB
      floor equals DEFAULT_BLOCK_MIN_TX_FEE, the miners' inclusion
      minimum, policy.h:32 / miner.cpp:103 — unchanged and correct;
      send.ts already describes the relay minimum as 0.001). Engine:
      packages/chains-utxo/src/dust.ts (DustPolicy {legacy, p2wpkh};
      DUST_P2PKH 546 / DUST_P2WPKH 294 unchanged as BITCOIN_CORE_DUST_POLICY;
      DOGECOIN_SOFT_DUST_LIMIT 1,000,000n, DOGECOIN_HARD_DUST_LIMIT
      100,000n, DOGECOIN_CORE_DUST_POLICY using the soft limit for every
      script type; the engine never creates an output below it so no
      surcharge logic is needed); UtxoNetwork.dustPolicy (absent =
      Bitcoin Core); coinselect dustThreshold(script, policy) backward
      compatible; buildTransfer refuses a recipient output below the
      chain's threshold on every chain ("Amount is below the Dogecoin
      dust limit: the smallest output this wallet will create is 0.01
      (1000000 base units)…") and folds sub-threshold change into the
      fee as before (strict <: exactly 0.01 is kept). App send.ts:
      prepareUtxoSend's recipient pre-check passes network.dustPolicy
      (it used Bitcoin's 546 for Dogecoin before) and maxUtxoSend
      re-throws the engine's dust error when the remainder would be
      sub-limit; describeSendError unchanged. Tests: dust-policy.test.ts
      (recipient refusals at 999,999 / 100,000 / 546 / 1 koinu, exactly
      1,000,000 accepted, testnet same; change kept at the limit, folded
      one below and in the old 546–999,999 gap; a 300-build sweep with
      no sub-limit output and value conserved; a folded-change signed tx
      decoded by bitcoinjs; four Bitcoin raw signed txs pinned byte for
      byte against the f84f6e8 engine; a network without dustPolicy
      behaves like BITCOIN). Not adopted: Dogecoin Core's wallet
      heuristic of change >= discard + 2× minTxFee (~0.03 DOGE), a wallet
      preference not relay policy. UNVERIFIED until the demonstration
      broadcast: live relay behaviour, NOWNodes' backend/peer
      -dustlimit/-harddustlimit/-minrelaytxfee settings.
- [x] DOGECOIN MAINNET BROADCAST, PROVEN LIVE (2026-10-03). The
      Chairperson funded the dev wallet's mainnet address
      DEQ788Pe98Z97Le6feBa2P49JL7ETGSMNf with 10.69 DOGE. Dry run
      (doge-mainnet-demo.mjs): host Blockbook over Dogecoin Core,
      chain/genesis checks passed, quote at 1003 sat/vB (estimatefee/6
      with the 1000 floor), engine-built 1 DOGE self-send, 226 bytes, fee
      0.00226678 DOGE, change 9.68773322 DOGE, all 25 bitcoinjs decode
      checks passed. Broadcast with DOGE_MAINNET_BROADCAST=1 and the txid
      confirmed on stdin: accepted by Blockbook's POST /api/v2/sendtx/
      (route now verified live), seen in the mempool at 03:14:09Z,
      confirmed 1 at 03:16:47Z in block 6399309 (hash
      d842c822b43996fbf089a0210be84cbb4207118a6c9c82622e51c7b047327d69);
      the CTO re-read the transaction independently from the Blockbook
      host: outputs 100000000 and 968773322 koinu, fees 226678, size
      226. txid 2f05331b4e731e153636bdf92965882a79d2412eb3a5e3639e0380145465a6fd. This closes the
      "Known untested remainder" Dogecoin item (W6 met, F-41 fixed; the
      readiness row for dogecoin-send now cites only the shared
      regular-account conditions W1/W2). The dev wallet keeps about 10.69
      DOGE at that address for future demonstrations.

## Phase 10 plan (approved 2026-10-03): show the AA features working in the app

The engine has proven session keys, guardians, passkeys and EIP-7702
live, but several flows have only run through scripts, not the app's
own screens. For a prototype whose purpose is to demonstrate AA, that
gap matters more than remaining polish.

1. Session keys and guardians, live in-app on the emulator: grant,
   use and revoke a session from the Sessions screen; set up guardians
   with the dev seed's guardian keys (indices 5 and 6), run a recovery
   to another of the wallet's accounts and a veto through the app's
   screens, rotate back with Change owner.
2. Gas sponsorship, live: probe whether the ZeroDev project serves an
   ERC-7677 paymaster for Sepolia; if so, a sponsored send in the app;
   if not, it becomes an input (a sponsorship policy).
3. A second EVM chain profile (Base Sepolia) with AA included: verify
   the Kernel addresses there, bundler via the existing project, the
   readiness switchboard treating it as a test network.
4. Leadership deliverable refresh: a status matrix over the 99 features
   in FEATURE_UNIVERSE.md (proven live / built / designed / not
   started), the shareable artifact page regenerated, and a
   plain-English docs/DEMO.md walkthrough for presenting each AA
   feature on the emulator in order.
5. Hardening leftovers from phase 9: load-time filtering of old http
   endpoints, the guardian recovery spec's nonce hook, the shared
   test-networks card, the threat-model rows touched by the last
   commits.
6. Device build track alongside, whenever the Expo account and
   identifiers arrive: FaceID, StrongBox, passkeys, TalkBack.

Waves: 1 + 2 + 4 first (disjoint, no inputs), then 3 and 5. Subagents
on Opus. The emulator is driven by ONE agent at a time.

## Phase 10 progress
- [x] Item 4 — leadership deliverable refresh (commit 2915130).
      docs/FEATURE_UNIVERSE.md section 15 "Implementation status
      (2026-10-03)": four statuses (Proven live / Built, verified offline
      / Designed / Not started) with the evidence entry for each of the
      99 features (saying in-app vs app code from a script vs engine),
      summary by tier — Proven live 31 (T1 25, T2 6), Built 14 (9/5),
      Designed 2 (1/1), Not started 52 (5/32/15) — and what separates
      built from proven live (inputs, a real-phone build, in-app runs of
      engine-proven flows). Conventions: emulator-only features count as
      proven live when exercised on the emulator; dates follow this file
      (US Eastern) except block-timestamp dates marked UTC. Phase 10 items
      1 and 2 were not counted. docs/DEMO.md: presenter's walkthrough
      (three up-front warnings, preparation, nine steps in order, rough
      edges, what the demo cannot show) quoting screen copy from the
      code. WARNING recorded there and here: the emulator wallet's phrase
      is in biometric-protected storage and is NOT written down anywhere
      — never wipe the AVD "shiba" or add/remove its fingerprint, or
      Account 1 (owner of Kernel account 0xD31c…D8FA and the Uniswap
      session) is lost; the onboarding step of the demo runs on a second
      disposable emulator. Shareable page regenerated: the Chairperson's
      artifact https://claude.ai/artifact/JEfyMuPcMJ8YW5x3ZKitsw is now
      version 2 ("Status update 3 Oct 2026"): every feature card carries
      a status chip and a dated status line with the evidence, a new
      "Implementation status" section with tiles, the tier table and the
      status definitions, a Status filter group, and header stats
      (31 proven live, 14 built). Built by a scratchpad script
      (build-fu.py) that parses section 15 and injects it into the saved
      page, so it can be regenerated from the markdown again.
- [x] Item 2 — paymaster probe (scripts/testnet/paymaster-probe.mjs; app
      fix pending commit with the hardening slice because both touched
      aa.ts): the ZeroDev Sepolia RPC serves ERC-7677
      pm_getPaymasterStubData / pm_getPaymasterData (and ZeroDev's own
      zd_sponsorUserOperation; pm_sponsorUserOperation is unsupported),
      but every sponsorship call answers HTTP 400 with the bare JSON
      body {"error": "userOp did not match any gas sponsoring policies or
      (no ERC20 gas token data present)"} because the project has no gas
      policy (docs: setup-project and sponsor-gas/evm say a Gas Policy
      must be set in the dashboard — "Sponsor all transactions" or a
      rate-limited policy; UltraRelay's documented network list does not
      include Ethereum Sepolia, yet ?provider=ULTRA_RELAY answers with gas
      limits and NO paymaster fields, which is not a valid 7677 answer;
      GELATO fails TLS on ZeroDev's side; ALCHEMY/PIMLICO give the same
      policy refusal). No sponsored op was sent; the live guard refused
      correctly; account 0x1D72…4106 unchanged (0.00055 ETH + 0.00033
      deposit). INPUT NEEDED: a gas policy for the project's Sepolia
      network on dashboard.zerodev.app, then `PAYMASTER_LIVE=1 node
      scripts/testnet/paymaster-probe.mjs` (checks the account's balance
      and deposit do not move, the UserOperationEvent's paymaster and the
      paymaster's deposit). Alternative: Alchemy Gas Manager (ERC-7677
      with context {"policyId"}; Sepolia supported) — also needs a policy
      created on its dashboard. APP BUG FOUND AND FIXED: setAaPaymaster
      refused the ZeroDev URL as "unreachable" because the engine's
      httpTransport drops the body on non-2xx; aa.ts gained
      paymasterProbeTransport (keeps {"error": text} bodies as "RPC error
      (no code): <text>", error objects as "RPC error <code>: <message>")
      as the default for the save-time check, and verifyAaPaymaster treats
      "unsupported method" text as method-not-found; check-aa 99 (+9).
      Follow-up: createAaClient's send-time paymaster transport still
      uses httpTransport, so a policy refusal during a send shows the
      HTTP status, not the policy text.
- [x] Item 5 — hardening leftovers (commit below; engine 627 tests,
      chains-evm 369; app 30 suites; offline runner ALL GREEN; the
      paymaster app fix from item 2 and its send-time follow-up are in the
      same commit because they share aa.ts). (1) Stored http endpoints are
      ignored on read: every reader (networks.ts getEndpoint /
      getAllEndpoints with an injectable store, getBlockbookConfig,
      getIndexerConfig, getNftIndexerConfig with ignoredUrlReason,
      getAaConfig with bundlerUrlIgnoredReason / paymasterUrlIgnoredReason;
      the AA node URL is never stored, it comes from networks.ts) runs
      assertSecureEndpointUrl and treats a failing value as not configured
      without deleting it; Settings shows "A saved URL is not used:
      <reason>" per section (AaField ignoredReason prop) and Clear / Reset
      to default appear for ignored values; the other aa.ts setters write
      back the raw entry so an ignored URL survives unrelated saves.
      DECISION TO NOTE: an ignored http RPC override falls back to the
      public default endpoints (what "not configured" means for an
      override) rather than leaving the chain without an endpoint. Tests:
      check-devmode 110 (+8), check-doge +10, check-indexer +7, check-nfts
      131 (+7), new check-aa-urls.mjs 21 (offline in suites.mjs). (2) The
      guardian recovery spec (kernel-recovery.ts) gained getNonceKey (the
      guardian lane) and signUserOpHash now refuses a nonce that differs
      from the approved one ("…the approvals are void — collect new
      ones"), a missing context, a wrong EntryPoint / chain / sender, or a
      hash that is not getUserOpHash(op); routeNode stays as a
      pass-through that also checks the exact nonce on keyed reads so the
      early refusal before estimation is kept (recovery.ts unchanged);
      three new vitest cases, byte-pinned tests unchanged (55/55),
      check-recovery 231. (3) TestNetworksOnlyCard moved into
      app/src/components.tsx replacing eight copies across the seven
      screens (style parity checked by comparing style values, not on
      screen); WarningBox keeps no accessibility role (the RN docs define
      "alert" only as "important text" with no platform behaviour to
      cite). (4) THREAT_MODEL.md: header row-update line; T-23 and F-55
      ("Mostly fixed", open: nested Pressables on Home chain cards);
      F-44's true count is six eslint-disable-next-line comments, two
      without reasons in WcApprovalSheet.tsx (lines 414 and 562,
      exhaustive-deps) — still open; T-29 / N-08 / section 3.4 updated for
      the https rule and the read-time filter; allowBackup false noted
      (bmgr test still W18). Send-time follow-up from item 2 applied by the
      CTO: createAaClient / the 7702 client build their paymaster
      transport with paymasterProbeTransport unless a factory is injected,
      so a policy refusal during a send shows the policy text. Not
      eyeballed on the emulator: the Settings warning lines, the card
      swap, the ignored-URL states.
- [x] Item 1 — SESSION KEYS AND GUARDIANS, PROVEN LIVE IN-APP
      (2026-10-03, emulator, Expo Go, Sepolia, Kernel account 0xD31c…D8FA
      owned by Account 1; Metro --clear at 028b558; nonce 3 → 9; every
      hash checked on-chain by the agent). SESSION KEYS: Sessions →
      grant (allowed call: owner EOA 0x772e…F44F, no function, cap 0;
      expiry 10 min) — review showed the per-call-cap note, the expiry
      "enforced on-chain by the account", "A session key can never sign
      messages or logins for your account (ERC-1271 is switched off for
      it)", session key 0xb5d6Ed3A6C1baE5E0bd7F751A5d7F6169DbeC74C,
      permission id 0x2daf71ee, "Install operation: 2 calls to your own
      account (installValidations, grantAccess)", bundler estimate passed;
      install userOp 0x8fca341a…b4f6, tx 0xb62e5573…b47d, block 11837098
      (readKernelPermissionState: installed, ECDSASigner flag 2, policies
      [CallPolicy, TimestampPolicy]); "Test this session" signed by the
      SESSION key only (nonce key 0x02‖2daf71ee, 66-byte 0xff signature
      recovering to the session address, no owner prompt): userOp
      0x8a4d92e8…a7d01, tx 0xb1d7b2c8…ea62, block 11837121, "Included
      on-chain — succeeded"; Revoke (owner, uninstallValidation): userOp
      0x06f9bb74…46e8d, tx 0x6270f7c0…8422, block 11837135, state cleared
      (executeAllowed stays true — harmless with no validator); Forget →
      "None on this device". GUARDIANS: setup with dev-seed indices 5
      (0x69F0EC265702D0891b0AEF8e79ddDC3277ef7E8a) and 6
      (0xCCB4A33b8918ccd1a5C349E46EAc53229788b107), 1/1, threshold 2,
      delay 10 min (test networks); the exposure warning rendered ("ONE
      guardian alone can sign messages as this account immediately…") and
      the unaudited-module note; install (2 installModule calls): userOp
      0x1112154e…acba6, tx 0x3c311673…b666, block 11837168,
      readGuardianState active/2/600 s. Recovery request #1 from Account
      2 (proposal 0xb5c98984…550c, lane 0), both approvals signed with
      guardian-approve.mjs and pasted (weight bar 1→2 of 2),
      approveWithSig sent by Account 2: tx 0xe6fccaf5…e3bf, block
      11837206, "Approved on-chain… can execute in 9 min"; VETO by
      Account 1 (paste id → "APPROVED by guardians: it can execute in 7
      min… Veto it now"): userOp 0x40dd663c…c5d1d, tx 0x05672d39…86ae,
      block 11837220, proposal rejected, Account 2's screen "The current
      owner VETOED this recovery". Recovery #2 (proposal 0x896a23e4…9a4f,
      GUARDIAN LANE 1 — first live non-zero lane): approveWithSig tx
      0xf6e203d9…b2c0, block 11837243; countdown "9 min → 4 min → Ready";
      the final op was submitted by guardian 5 from a scratch script
      copying the app's prepareGuardianSubmission / submitGuardianRecovery
      (the guardian keys are not in the emulator wallet): userOp
      0xe7417f16…221b, tx 0x4129e51f…ab8f, block 11837294, owner =
      Account 2; app: "Recovered: this wallet's account is now the owner"
      → "Use this recovered account" → attached; Change owner back to
      Account 1 (signed by Account 2): userOp 0xff80c2ab…02a1, tx
      0x2150a265…b2ef, block 11837307; Remove guardians (3 calls): userOp
      0xc5cd6bfa…cbb6, tx 0xf23e3bcc…cc4e, block 11837317. Observation:
      ZeroDev's gas ESTIMATE accepted the guardian op ~9.5 min before
      validAfter (validAfter travels in validation data) — not submitted
      early. Top-up: Account 1's EOA sent 0.004 test ETH to the smart
      account in-app (tx 0x33c1a535…2a7c; the dev EOA holds only 0.00108).
      Final state: owner Account 1, no guardians, no permission, balance
      0.00399 + deposit 0.000356. Funds: smart account 0.00202 over 8
      ops, Account 1 EOA 0.004028, Account 2 EOA 0.000249, dev EOA 0.
      PROMPT COUNTS with protected storage: session grant 3 (approve,
      protect the new session key, sign with the phrase), session test 2
      (approve, use the session key), everything else 1. BUGS FOUND (fix
      agent dispatched): (1) the session grant left the Sessions screen
      for Home between the 2nd and 3rd prompt, so the userOpHash and
      success screen never showed although the op was sent (logcat:
      "WalletConnect Core is already initialized… Init() was called 2
      times" at that instant; suspected root-navigator or provider
      remount); (2) the recovery record rebuilt on the recovering side
      (from the original owner) has no guardians and replaced Account 1's
      record, so both sides showed "guardians are configured on-chain but
      not in the record" until removal; (3) the guardian install success
      text says the record "does not match the chain yet" while the
      status card says "Matches the chain ✓" (timing). COPY: the delay
      picker sits above the text that says "The delay below"; the audit
      note leaks "Engine notes: packages/chains-evm kernel-recovery.ts";
      "Current owner (not this wallet)" shown when it is this wallet's
      account; guardian labels show as "Guardian" on the recovering
      side; the session review's "only a plain transfer with empty
      calldata" overstates a null selector (it also matches calldata
      starting with 0x00000000); the shared request text points to
      "Settings → Guardians → Approve a recovery" (path unverified).
      Minor: Google-keyboard stray text in the paste field; Home briefly
      omits Guardians/Passkey links after a fresh bundle (async
      eligibility). Screenshots in the scratchpad p10/ folder.
