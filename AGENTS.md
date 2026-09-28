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

Still pending (needs further dApp-triggered requests): the lock hold, queued
requests, the paused-session and switch-chain declines, and the
wrong-account decline after switching to Account 2. Fiat display could
not be eyeballed here: test mode prices nothing and the mainnet
balances are zero (covered offline by check-prices 110/110).
