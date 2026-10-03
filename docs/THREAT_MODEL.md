# Threat Model

**Status:** First edition, written for phase 9 item 2 (hardening and release readiness).
**Date of the evidence:** 2026-10-02, repository at commit `860e552` ("Record the approved phase 9 plan"). At the time of writing the working tree also held uncommitted phase 9 item 1 changes (`packages/chains-evm/src/smart-account.ts`, `app/src/wallet/aa.ts`, `app/src/wallet/recovery.ts` and their tests); this document does not rely on them except where it says so.
**Audiences:** (1) leadership deciding whether, and in which form, the wallet may hold real funds on mainnet; (2) an external security reviewer who needs to know what is claimed, where the proof is, and what is still open.
**Related documents:** `AGENTS.md` (the project record; every finding below traces to it), `docs/ARCHITECTURE.md` (design and ADRs D1–D8), `docs/AA_STACK.md`, `docs/AA_FRAMEWORKS.md` (conditions C1–C3 in section 17.2, thin evidence in section 20), `docs/SESSION_KEYS.md`, `docs/DEVICE_BUILDS.md`.

## How to read this document

Every claim in this document is meant to trace to one of four kinds of source: the project record in `AGENTS.md`, another document in `docs/`, the code (cited by file path), or an external source that one of those cites. Where a claim could not be checked, the text says "unverified" and names the way to verify it. Section 8 lists the places where the design documents and the code disagree, because a reviewer reading `docs/ARCHITECTURE.md` alone would come away with a stronger picture of key protection than the code delivers today.

Likelihood and impact use a three-step scale:

| Rating | Likelihood means | Impact means |
|---|---|---|
| Low | Needs an unusual attacker position or a chain of unlikely events | Inconvenience, privacy loss of public data, or a refused operation |
| Medium | Plausible for a motivated attacker or a common user mistake | Loss of some funds, exposure of linkable private data, or a stuck account |
| High | Expected to happen to some users at mainnet scale | Loss of all funds controlled by the affected key or account |

Severity in the findings register (section 6) combines the two and adds one level, Critical, for an issue that would cause loss of funds for many users without any user mistake. No Critical finding is open today.

## Summary for leadership

The wallet is a non-custodial, React Native (Expo SDK 57) app over a pure-TypeScript engine. On testnets it has proven a wide feature set end to end, including real broadcasts on Sepolia, Bitcoin testnet3 and Solana devnet, a live WalletConnect session with Uniswap, ERC-4337 smart accounts (SimpleAccount and Kernel v3.3), an in-app EIP-7702 upgrade and revocation, and engine-level live proofs of session keys and guardian recovery.

Three conclusions matter for a mainnet decision.

1. **Plain-account features are the realistic first mainnet candidates, but not yet.** EOA sends, tokens, NFTs, swaps and WalletConnect run on code paths that are tested offline and proven on Sepolia. Before real funds, the key-storage design must be reconciled with what the code does (section 8, finding N-01: the recovery phrase is not bound to biometric authentication at the storage layer; the biometric prompt is an app-level gate), and the phone-only checks must run on a real device build (Secure Enclave or StrongBox behaviour, Face ID, release-build behaviour). Dogecoin has never broadcast a transaction.
2. **Smart-account features must stay testnet-only.** Kernel v3.3 and every module the wallet installs on it (session-key permissions, guardian recovery, WebAuthn passkeys, and the 7702 delegate changes) have no published audit for the deployed versions, no confirmed bug bounty, and no stated support horizon (conditions C1–C3 from `docs/AA_FRAMEWORKS.md`). The project also found, and proved live on Sepolia, that ZeroDev's guardian validator lets a single guardian satisfy a two-of-two threshold by repeating its signature, and that guardians can sign messages as the account immediately.
3. **The remaining large risk is the user being shown something misleading.** The wallet decodes, simulates and previews before signing, refuses dApp-requested EIP-7702 authorizations, and warns on look-alike addresses. It does not verify which website a WalletConnect dApp really is, it does not decode token-permit signatures specifically, and its simulation comes from the same RPC provider as everything else it shows.

The top ten risks in ranked order are in section 4.13.

---

## 1. Scope and assumptions

### 1.1 What exists today

The product is a non-custodial mobile wallet. Keys are generated and used only on the user's phone (ARCHITECTURE invariant 1). A single BIP-39 recovery phrase derives every key (ADR D1). The code is organised as five engine packages (`packages/core`, `packages/chains-evm`, `packages/chains-utxo`, `packages/chains-solana`, `packages/prices`) and the Expo app in `app/`, which consumes the packages through `file:` dependencies.

Chains in the app (per `AGENTS.md` and `app/src/config/`):

| Chain | Networks in the app | Highest level of proof |
|---|---|---|
| Ethereum | Mainnet (default) and Sepolia (developer "test mode") | Real Sepolia broadcasts, including WalletConnect swaps on Uniswap; no mainnet transaction has been broadcast by the app |
| Bitcoin | Mainnet in the app; testnet3 in the smoke scripts | Engine-built P2WPKH transaction accepted on testnet3 (phase 2 task 8) |
| Solana | Mainnet in the app; devnet in the smoke scripts | Engine-built transfer finalized on devnet (phase 2 task 8) |
| Dogecoin | Mainnet, only through a user-configured Blockbook endpoint | Reads verified live; **no broadcast ever executed** ("Known untested remainder") |

Features in the app, with their proof level:

| Feature | Proof level (source: `AGENTS.md`) |
|---|---|
| Onboarding (create with a two-word backup quiz, import), multi-account (ADR D8) | Emulator-proven |
| Native sends on four chains, ERC-20 sends, NFT sends (ERC-721/1155) | Offline suites; ETH and token sends via WalletConnect proven on Sepolia; no live NFT send |
| Swaps through the 0x API | Offline only; no 0x API key exists, so no live quote has run |
| WalletConnect v2 (Reown WalletKit), global request sheet | Proven live with Uniswap on Sepolia, including decline paths |
| Simulation preview (`eth_simulateV1`), `eth_call` pre-flight gate, risk warnings, approvals manager | Preview matched on-chain results to the wei on two live swaps |
| Contacts with look-alike warnings | Emulator-proven |
| ERC-4337 smart accounts: SimpleAccount and Kernel v3.3, batching, ERC-5792 | In-app Kernel send through a bundler proven on Sepolia; ERC-5792 offline only |
| ERC-7677 paymaster sponsorship | Offline only; no paymaster endpoint has been configured |
| EIP-7702 "Upgrade this account" and revoke | Proven in the app on Sepolia |
| Session keys (Kernel permissions), ERC-7715 over WalletConnect | Engine install/use/reject/revoke proven on Sepolia; app path offline only |
| Guardians and social recovery, owner change | Engine cycle proven on Sepolia; app path offline only; the in-app owner change is currently refused by the bundler (finding F-36) |
| Passkey signer (Kernel WebAuthn validator v0.0.3) | Engine simulation only; the app gates it behind a development build and an unconfigured relying-party domain |
| Fiat prices (CoinGecko), history, NFT gallery | Offline suites and live read-only probes |
| Auto-lock, biometric gate, balance hiding, screenshot blocking on seed screens | Emulator-proven, including the full lock and fingerprint cycle |

### 1.2 Assumptions

- The user's phone runs an operating system that has not been rooted or jailbroken, and the OS keychain or keystore behaves as documented. This is an assumption, not a verified property of this app: no physical device build has run yet (`docs/DEVICE_BUILDS.md`).
- The audited `@scure` and `@noble` libraries are correct. The project validates its use of them against official test vectors and independent implementations (ethers, bitcoinjs-lib, @solana/web3.js, viem and others, per `AGENTS.md`), but does not re-audit the libraries.
- The canonical EntryPoint v0.7 contract (`0x0000000071727De22E5E9d8BAf0edAc6f37da032`, `docs/AA_STACK.md`) behaves as its source code says.
- Every network service is untrusted (ARCHITECTURE section 1). The wallet may rely on a service for availability, never for the safety of a signature.
- The user reads the confirmation screen. Several mitigations below only work if the user reads what is shown; the wallet cannot protect a user who approves an accurately described malicious request (ARCHITECTURE 5.3, residual risk).

### 1.3 Out of scope

- The security of the blockchains themselves, their consensus and their fee markets.
- The internal security of third-party contracts the user chooses to interact with through dApps (Uniswap's router, token contracts and so on), beyond what the simulation preview reveals.
- A fully compromised operating system on which the user keeps approving operations. ARCHITECTURE 5.1 states plainly that no software wallet can defend this case; this document only notes where the design narrows it.
- Physical attacks on the secure element or TEE hardware.
- Store distribution security (code-signing infrastructure at Apple, Google and Expo), except where the project's own configuration affects it.
- Features that do not exist yet: in-app browser, push notifications, fiat on-ramp, staking, hardware wallets, MPC, cloud backup. Where `docs/ARCHITECTURE.md` describes such features, they are design intent only.
- A legal review. The licensing question about (L)GPL and AGPL modules is recorded as an open item for counsel (finding F-39), not analysed here.

---

## 2. Assets to protect, ranked

| Rank | Asset | Where it lives | Why it matters |
|---|---|---|---|
| 1 | **Recovery phrase (BIP-39 mnemonic)** | `expo-secure-store` under `shiba-wallet.mnemonic.v1` with `WHEN_UNLOCKED_THIS_DEVICE_ONLY` (`app/src/wallet/storage.ts`); transiently in JavaScript memory when loaded | It derives every key on every chain, including every smart-account owner and every EIP-7702-upgraded EOA (ADR D1). Its loss to an attacker is total loss for all seed-derived accounts. |
| 2 | **Derived private keys** | Never stored; re-derived per signing operation in `WalletContext.signWith` (`app/src/wallet/WalletContext.tsx`) and held in a signing closure until the operation finishes | Each key controls one account on one chain family. EVM accounts share a non-hardened parent, so one leaked EVM key plus the EVM parent extended public key would expose every EVM account (ADR D8, "shared EVM subtree"); the app never exports an extended public key. |
| 3 | **Funds in smart accounts and upgraded EOAs**, including counterfactual (undeployed) addresses | On-chain; addresses computed locally (ADR D4) | A counterfactual address can receive funds before its contract exists. Correct local address computation is what makes those funds recoverable. After an owner rotation the address can no longer be computed from any seed (finding F-37). |
| 4 | **Session keys** | `expo-secure-store` via `sessionKeyVault` (`app/src/wallet/storage.ts`), one entry per chain, account and permission id; public grant data in AsyncStorage | A session key can spend within its on-chain grant until expiry, without any further user interaction. For ERC-7715 grants the dApp, not the wallet, holds the session key (`app/src/wallet/sessions.ts`). |
| 5 | **Passkey credentials** | Private key inside the platform authenticator; only public data in AsyncStorage `shiba-wallet.passkeys.v1` (`app/src/wallet/passkeys.ts`) | A passkey installed on a Kernel account can spend from it and, because Kernel lets it make self-calls, could replace the root owner if the app's client-side guard were bypassed (finding F-19). |
| 6 | **Guardian keys** (held by other people) | Outside this wallet, except when this wallet acts as a guardian for someone else | Enough guardian weight can replace the account owner and can sign messages as the account immediately (finding F-20). |
| 7 | **Recovery metadata** | AsyncStorage `shiba-wallet.recovery-records.v1` and `.recovery-progress.v1`; exported as QR, text or a `.json` file (`app/src/wallet/recovery.ts`, `app/src/components/RecordFileActions.tsx`) | Secret-free, but after an owner rotation it is the only reliable way to find the account again. It also reveals guardian addresses and the labels the user gave them. |
| 8 | **WalletConnect sessions and smart-account bindings** | Reown WalletKit's own persistence; bindings in AsyncStorage `shiba-wallet.wc-smart-bindings.v1` | A live session lets a dApp queue signing requests at any time. Bindings decide which account a request may act for. |
| 9 | **Third-party service credentials the user pastes** (bundler, paymaster, history and NFT indexer URLs with embedded keys, 0x key, Blockbook key, CoinGecko Demo key) | AsyncStorage (`aa.ts`, `indexer.ts`, `nfts.ts`, `swap.ts`, `blockbook.ts`, `prices.ts`) | Not key material, but their theft costs the user money or quota with the vendor and can deanonymise them to that vendor. |
| 10 | **User privacy**: the link between the user's addresses, their IP address, their contacts and their balances | Spread across AsyncStorage and every network request | Every service the wallet contacts sees the device IP and some of the user's addresses (section 4.8). |

---

## 3. Trust boundaries and data flows

### 3.1 Diagram

```
+---------------------------------------------------------------------------------+
| PHONE (trusted only while the OS is intact and the device is unlocked)          |
|                                                                                 |
|  +------------------------------+      +-------------------------------------+  |
|  | OS secure storage            |      | Platform authenticator              |  |
|  | expo-secure-store            |      | (passkeys; private key never        |  |
|  | WHEN_UNLOCKED_THIS_DEVICE_   |      |  exposed to the app)                |  |
|  | ONLY: mnemonic, session keys |      +-----------------+-------------------+  |
|  +--------------+---------------+                        | assertions           |
|                 | string on read                         v                      |
|  +--------------v-----------------------------------------------------------+   |
|  | JS RUNTIME (Hermes), one realm for app code AND every npm dependency     |   |
|  |  WalletContext.signWith: load phrase -> seed -> key -> sign -> zero seed |   |
|  |  biometric gate (requireLocalAuth) runs here, BEFORE signWith           |   |
|  |  engine packages (@noble/@scure), WalletKit + its dependency tree       |   |
|  +--------------+-------------------------------------+--------------------+    |
|                 | public data only                     | signed tx / userOp     |
|  +--------------v---------------+                      | public queries          |
|  | AsyncStorage (unencrypted    |                      |                         |
|  | app storage): accounts,      |                      |                         |
|  | contacts, prefs, endpoint    |                      |                         |
|  | URLs + API keys, recovery    |                      |                         |
|  | records, grants, bindings    |                      |                         |
|  +------------------------------+                      |                         |
+========================================================|=========================+
                     TRUST BOUNDARY (network: all untrusted)                       
+--------------------------------------------------------v-------------------------+
|  Chain RPC nodes (publicnode, pocket, 0xrpc, 1rpc, blockstream, mempool.space,   |
|     Solana endpoints, or user overrides) -- balances, nonces, fees, eth_call,    |
|     eth_simulateV1, broadcast                                                    |
|  ERC-4337 bundlers / ERC-7677 paymasters (user-configured: Alchemy, ZeroDev)     |
|  WalletConnect relay (Reown) -- encrypted dApp messages, sees IP and timing      |
|  dApps (behind the relay) -- self-described name and URL, unverified            |
|  Indexers: Alchemy transfers + NFT APIs, Blockbook (user-configured)             |
|  CoinGecko (prices, keyless or Demo key)   0x API (swap quotes, user key)        |
|  IPFS gateway https://ipfs.io/ipfs/ and arbitrary http(s) NFT image hosts        |
+----------------------------------------------------------------------------------+

Developer-only paths (absent from a store build, but present in every test so far):
  Metro dev server --(JS bundle over the LAN)--> Expo Go or development build
  LogBox overlay, dev menu, CI=1 mode; .dev-wallet/ (git-ignored dev seed + keys)
```

### 3.2 Device secure storage

The mnemonic is written with `SecureStore.setItemAsync(MNEMONIC_KEY, mnemonic, { keychainAccessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY })` (`app/src/wallet/storage.ts`). The module comment describes this as "the iOS Keychain on iOS and the Android Keystore-encrypted SharedPreferences on Android". Session private keys use the same storage class. No other key material is stored.

What is known:

- The accessibility class means the item is meant to be readable only while the device is unlocked and is not migrated to a new device by OS backups (comment in `storage.ts`, consistent with ARCHITECTURE 2.4).
- The app never passes a `requireAuthentication` option to `expo-secure-store` (a search of `app/src` finds none). The stored phrase is therefore **not** bound to a biometric or passcode event at the storage layer; any code running in the app process while the device is unlocked can read it. The biometric prompt is a separate, app-level check (section 3.3). This differs from the design in ARCHITECTURE 2.4 and D7 (see section 8).

What is not known:

- Whether the Android key that wraps the stored values is StrongBox-backed or TEE-backed, and whether iOS stores the item with any Secure Enclave involvement, has **not been verified on real hardware**. `AGENTS.md` lists "real Secure Enclave/StrongBox" as phone-only and unverified, and `docs/DEVICE_BUILDS.md` lists it among the checks for the first device build.
- The emulator runs proved persistence across restarts and the absence of screenshots on the seed screens; they say nothing about hardware backing.

### 3.3 The JavaScript runtime

All app code, the engine, React Native and every npm dependency (including the WalletConnect WalletKit tree, which raised the Android bundle from 884 to 1,709 modules when it was added, per `AGENTS.md` phase 3 candidate 5) run in one Hermes JavaScript realm. There is no process or realm isolation between the signing code and the dependencies.

Signing flow (`WalletContext.signWith`):

1. A screen first calls `requireLocalAuth` (`app/src/wallet/biometric.ts`). This shows the OS biometric prompt with the OS passcode as fallback (`disableDeviceFallback: false`). If the device has no biometric hardware or no enrolment, the function returns `{ ok: true, gated: false }` and the action proceeds without a prompt, by documented design.
2. `signWith` loads the mnemonic from secure storage, computes the 64-byte seed, derives the active account's key through `deriveSignerFor`, refuses unless that key controls exactly the address the operation was quoted for, runs the signing callback, and zeroes the seed in a `finally` block.

Memory facts from the code: the seed buffer is zeroed after every use. The mnemonic is a JavaScript string (returned by `expo-secure-store` and passed to `mnemonicToSeed`), which cannot be zeroed. The derived private key is captured by a signing closure in `packages/core/src/chains/*.ts` and is not explicitly zeroed; it becomes unreachable when the closure is dropped and is left to the garbage collector. ARCHITECTURE 5.5 already accepts the garbage-collector copy risk; the string and closure cases go beyond what that section describes (section 8).

The gate is enforced by convention at each call site, not inside `signWith`. Every current `signWith` call site in `app/src/screens/*` and `app/src/wallet/WalletConnectContext.tsx` was checked for this document and is preceded by a `requireLocalAuth` call in the same flow; the passkey path is the documented exception, where the platform passkey prompt is the user-verification step (`AGENTS.md` phase 8 item 3, app half). A future call site that forgets the gate would sign without a prompt, so a reviewer should treat "every `signWith` is gated" as a property to re-check on each change.

### 3.4 AsyncStorage (unencrypted app storage)

AsyncStorage holds only data the project classifies as public, but "public" here means "not key material", not "harmless". The keys found in `app/src` are:

| Key | Content | Sensitivity |
|---|---|---|
| `shiba-wallet.accounts.v1` | Account names, hidden flags, active index | Low |
| `shiba-wallet.prefs.v1` | Test mode, hide amounts, auto-lock threshold, fiat toggle | Low; an attacker who can write it could turn auto-lock off |
| `shiba-wallet.contacts.v1` | Named addresses per network | Privacy (social graph) |
| `shiba-wallet.tokens.v1` | Tracked tokens | Low |
| `shiba-wallet.rpc-endpoints.v1` | User RPC overrides | Privacy; may embed provider keys |
| `shiba-wallet.aa-config.v1` | Bundler, factory, paymaster URL and context, 7702 owners, recovered-account links | Credentials (URLs embed API keys); integrity matters (verify-before-save) |
| `shiba-wallet.evm-indexer.v1`, `shiba-wallet.nft-indexer.v1` | Indexer URLs | Credentials (embedded keys) |
| `shiba-wallet.swap-config.v1`, `shiba-wallet.blockbook.v1`, `shiba-wallet.price-config.v1` | 0x key, Blockbook URL and key, CoinGecko Demo key | Credentials |
| `shiba-wallet.wc-config.v1`, `.wc-used.v1`, `.wc-smart-bindings.v1`, `.wc-calls.v1` | WalletConnect project id, startup marker, smart-account bindings, ERC-5792 call ids | Integrity of bindings matters |
| `shiba-wallet.sessions.v1` | Session grants (session key address, permission id, label, status) | Privacy; integrity |
| `shiba-wallet.passkeys.v1` | Passkey public key, credential id, rpId, validator | Privacy |
| `shiba-wallet.recovery-records.v1`, `.recovery-progress.v1` | Recovery metadata, guardians and labels, recoveries in progress | Privacy; availability (loss can strand a rotated account) |

Two open questions follow. First, `app/app.json` does not set `android.allowBackup`, and whether an Expo build includes AsyncStorage in Android's automatic backup by default is **unverified**; confirm by inspecting the generated `AndroidManifest.xml` after `npx expo prebuild` and decide deliberately (finding N-08). Second, the endpoint setters accept `http://` as well as `https://` (`URL_PATTERN` in `aa.ts`, `indexer.ts`, `blockbook.ts`, `nfts.ts`, and the check in `config/networks.ts`), so a user can save an endpoint whose key and queries travel in clear text.

### 3.5 Network services

| Service | What it sees | What it could do if malicious | Verification the wallet performs |
|---|---|---|---|
| Chain RPC (defaults in `app/src/config/defaults.ts` and `evm-chain.ts`, or user overrides) | Device IP, every address queried, every transaction broadcast | Lie about balances, nonces, fees, simulation and pre-flight results; censor; correlate addresses | Chain identity on every probe and save (`eth_chainId`, Esplora genesis hash, Solana genesis hash in `config/endpoint-probe.ts`); a wrong-chain endpoint is never used, even as a last resort |
| Bundler (user-configured) | IP, smart-account address, every UserOperation | Refuse, delay, mis-estimate gas, report false receipts | `eth_supportedEntryPoints` must include v0.7 before saving (`aa.ts verifyAaBundler`); the userOpHash binds every field, chain id and EntryPoint (ARCHITECTURE 3.2) |
| Paymaster (user-configured, ERC-7677) | IP, each sponsored operation | Decline, or return paymaster data that fails at execution | Verify-before-save with a `pm_getPaymasterStubData` probe; paymaster fields are covered by the user's signature |
| WalletConnect relay (Reown) | IP, timing, encrypted message envelopes | Drop or delay messages | End-to-end encryption by the WalletConnect protocol (not independently verified here); the wallet answers every request explicitly |
| dApps over WalletConnect | The approved address and chain | Request deceptive signatures and transactions; impersonate another dApp's name | Section 4.3 |
| Alchemy transfers and NFT APIs, Blockbook | IP, the user's address, query history | Hide or invent history and NFTs | Verify-before-save (chain id plus a probe for the transfers indexer; block-hash or timestamp match for the NFT indexer; a live UTXO read for Blockbook); NFT ownership re-checked on-chain before a send |
| CoinGecko | IP and which assets are priced | Wrong fiat values | Fiat is secondary text only, never used in signing; can be turned off ("Show fiat values") |
| 0x API | IP, the user's address as taker, the trade | Bad quotes, malicious calldata | The quoted transaction goes through the normal confirm with simulation, preview and risk warnings; approvals are for the exact sell amount only |
| IPFS gateway `https://ipfs.io/ipfs/` and NFT image hosts | IP and which CIDs or URLs are fetched | Track holders; serve hostile images | 4 MiB cap, type checked from bytes, SVG never rendered, spam collections not fetched (`app/src/wallet/nfts.ts`) |

### 3.6 Build variants

| Variant | Status | Security-relevant differences |
|---|---|---|
| Expo Go + Metro dev server | Every emulator validation so far | JavaScript is served over the network from Metro; LogBox and the dev menu are active; Face ID does not work; passkeys are unavailable |
| Development build (EAS `development` profile in `app/eas.json`) | Configured, never built | Needed for Face ID, passkeys and the real camera; still uses Metro |
| Store build (EAS `production` profile) | Configured, never built | The only variant without a dev server. Bundle identifiers are not set in `app/app.json` (input needed per `AGENTS.md` phase 9 item 3) |

No security property has yet been observed on a store build. Every dev-only behaviour listed in section 4.11 is expected to be absent in release builds, but that is **unverified** until the first release build runs (`docs/DEVICE_BUILDS.md`).

---

## 4. Threat enumeration

Each threat has an id (T-xx), a likelihood and impact rating, the current mitigation with the evidence that proves it, and the residual risk. Ids in parentheses such as F-20 or N-01 point to the findings register in section 6.

### 4.1 Device compromise (malware, root or jailbreak, screenshots)

| Id | Threat | L / I | Current mitigation and evidence | Residual risk |
|---|---|---|---|---|
| T-01 | Malware or an injected library running inside the app process reads the mnemonic | Low / High | Mnemonic only in `expo-secure-store` (`storage.ts`); never logged (no `console.*` calls in `app/src`, checked for this document); never sent over the network | The phrase is readable by any code in the process while the device is unlocked, because no `requireAuthentication` flag is used (N-01). The architecture's envelope encryption with a biometric-bound key is not implemented. **Open.** |
| T-02 | Root or jailbreak lets another app read the app's storage | Low / High | Keychain or Keystore encryption of secure-store items (platform property, unverified on device) | No root or jailbreak detection exists. AsyncStorage is unencrypted, so contacts, endpoint keys and recovery records are readable on a rooted device. Accepted for now; decide before mainnet. |
| T-03 | Screenshots or screen recording of the recovery phrase | Medium / High | `usePreventScreenCapture` on `BackupScreen.tsx` and `preventScreenCaptureAsync('seed-reveal')` on the Settings reveal (`SettingsScreen.tsx`); **proven on the emulator** (adb screencap returned an empty file while the phrase was visible and worked again afterwards, `AGENTS.md` third emulator pass) | The Import screen, where the user types the phrase, has no capture block (`ImportScreen.tsx`; N-04). iOS behaviour of `expo-screen-capture` is described in the code as best-effort and is unverified on a device. |
| T-04 | Keyboard or clipboard leaks the phrase | Medium / High | The seed reveal deliberately has no copy button, with the reason stated in the UI (`SettingsScreen.tsx` around line 1033); the import field sets `autoCorrect={false}` and `autoComplete="off"` | Whether third-party Android keyboards still learn the typed words is unverified. Address copy on Receive is allowed, with a clipboard note. |
| T-05 | The OS app-switcher snapshot shows balances and addresses | Medium / Low | Hide amounts masks balances when the user turns it on | No privacy cover is shown when the app goes to the background; the lock overlay appears only on return after the threshold (`LockGate.tsx`; N-05). |
| T-06 | Overlay or accessibility malware tricks the user into approving | Low / High | Approvals show full addresses, decoded previews and an OS biometric prompt | ARCHITECTURE 5.1 accepts that a compromised OS defeats any software wallet. On-chain policies (session limits, guardian delays) are the only defence that survives this, and those modules are unaudited (section 4.6). |

### 4.2 Lost or stolen device

| Id | Threat | L / I | Current mitigation and evidence | Residual risk |
|---|---|---|---|---|
| T-07 | Thief with a locked phone | Medium / Low | `WHEN_UNLOCKED_THIS_DEVICE_ONLY`; OS passcode rate limiting (platform property) | Depends on the OS passcode strength and on hardware behaviour that is unverified on device. |
| T-08 | Thief with an unlocked phone and the app open | Medium / High | Every send, signature, seed reveal, WalletConnect approval and smart-account change calls `requireLocalAuth` first (all call sites listed in section 3.3); auto-lock overlay with OS biometric unlock; **proven on the emulator**, including a WalletConnect request held behind the lock and released only after the fingerprint (`AGENTS.md` phase 6 lock hold) | Auto-lock is off by default (`DEFAULT_PREFS.autoLockMs: null` in `config/prefs.ts`). On a phone with no enrolled biometrics, `requireLocalAuth` proceeds without any prompt and auto-lock is hidden (documented matrix in `biometric.ts`), so the OS lock screen is the only protection. Native alerts and other screens' QR-scanner modals can draw above the lock overlay (F-27). |
| T-09 | Thief who knows or shoulder-surfed the OS passcode | Medium / High | The OS falls back to the passcode after failed biometric attempts (`disableDeviceFallback: false`) | **Recorded decision: there is no app PIN** (`app/src/wallet/lock.ts`). The rationale is that a JavaScript PIN pad would be weaker than the OS credential. The consequence is that the device passcode unlocks every wallet action. Leadership should accept this explicitly for mainnet. |
| T-10 | User loses the phone and has the recovery phrase | Medium / Medium | Restore from the phrase recovers every seed-derived account; counterfactual and factory-deployed smart accounts are recomputed (ADR D1, D4) | No automatic account discovery: the user must re-add accounts in order (ADR D8). Rotated, recovered and guardian-protected accounts need the recovery record (section 4.9). Session keys and passkeys do not come back (section 4.9). |

### 4.3 Phishing dApps over WalletConnect

| Id | Threat | L / I | Current mitigation and evidence | Residual risk |
|---|---|---|---|---|
| T-11 | A dApp impersonates a known brand | High / High | Approval sheets show the dApp name, URL and requested chains and methods | The name and URL are **self-reported by the dApp** (`walletconnect.ts` labels proposer metadata "display only, unverified"); no use of WalletConnect's Verify API was found in `app/src` (N-06). |
| T-12 | Deceptive transaction (drainer, malicious approval) | High / High | Each `eth_sendTransaction` is re-quoted on the wallet's own RPC, the dApp's gas, fee and nonce are ignored, an `eth_call` pre-flight blocks the approval unless the user flips an explicit override, an `eth_simulateV1` balance-change preview shows what leaves and arrives, untracked tokens are labelled with their contract and sanitized symbols, unlimited and collection-wide approvals render as warnings, and `RiskWarnings` (first interaction, new contract, delegated EOA, no-code recipient with calldata) appears on every EVM confirm including the WalletConnect sheet (`WcApprovalSheet.tsx`, commit `be0656e`). **Proven live:** two Uniswap swaps where the preview matched the receipt to the wei | A malicious contract can emit fake events, so the preview can be gamed (documented in `simulation.ts` and `AGENTS.md` phase 6 item 1). Free RPCs refuse old `eth_getCode`, so contract age is often unknown and no "new contract" warning is raised (F-12). A user who approves an accurately described malicious transaction loses the funds (ARCHITECTURE 5.3). |
| T-13 | Deceptive typed-data signature (Permit, Permit2, orders) | High / High | `parseTypedDataV4` refuses a foreign domain chain id, unknown domain fields and non-canonical domain types; the sheet shows the domain and the full message JSON with a generic warning that typed data can authorise actions later (`walletconnect.ts`, `WcApprovalSheet.tsx`) | There is no specific decoding of Permit or Permit2 messages and no spender or amount summary (N-07). Permit2-style allowances are also invisible to the approvals manager (`AGENTS.md` phase 7 item 5). This is the most likely route to a mainnet drain. |
| T-14 | dApp asks the wallet to sign an EIP-7702 authorization | Medium / High | **ADR D6 enforced in code:** `eth_sendTransaction` with `authorizationList` or `authorization_list` (even empty) or type `0x4` is declined with `EIP7702_WC_REFUSAL`; any ERC-5792 capability whose name or fields mention authorization, 7702 or delegation is refused with 5700 even when optional; any method name mentioning authorization or 7702 gets 5101; smart-account connections pass no owner, so the tuple path is unreachable (`walletconnect.ts`, `delegation.ts assertWalletDelegate`; tested in `check-7702.mjs`) | Low. The rationale is strong: BundleBear labels 2.34 million live delegations as pointing at "Crime" contracts (`docs/AA_FRAMEWORKS.md`, recorded in `AGENTS.md`). |
| T-15 | dApp abuses ERC-5792 batching | Medium / High | Offered only on smart-account sessions; strict parsing of version, chain id, `from`, calls and capabilities; more than 16 calls refused; every call listed on the confirm and simulated as the smart-account sender (`AGENTS.md` phase 7 items 1–3) | Batches are simulated call by call, not atomically (documented limit). Not exercised live with a dApp. |
| T-16 | dApp obtains an over-broad session key through ERC-7715 | Medium / High | Offered only on Kernel smart-account sessions; the request goes through the same grant review as an in-app grant, which shows every allowed call, the per-call value cap ("per call, not a total") and an expiry; the engine refuses wildcard targets, open-ended expiries and any self-call with calldata or value (`kernel-permissions.ts validateSessionKeyGrant`); `native-token-allowance` is refused because the policy caps per call, not cumulatively | The dApp holds the session key. A grant that allows `approve` or `setApprovalForAll` creates approvals that outlive the session (warned on screen). The permission policies are unaudited (F-14). No dApp has used this live. |
| T-17 | Request served by the wrong account or the wrong network | Medium / High | Sessions are bound to the approved address; requests are declined with 5103 after an account switch and 5100 in the other test or mainnet mode; `signWith` refuses unless the active key controls exactly the bound address; **proven live** with Uniswap (wrong account, paused session) | Sessions survive a wallet wipe (F-28); requests naming the old address are refused, but the session list still shows them. |
| T-18 | Look-alike address (address poisoning) | High / High | Contacts match exactly only (EVM full 20 bytes, UTXO decoded output script, Solana base58); a non-matching address sharing the first four and last four characters with a contact produces a "looks similar … but is DIFFERENT" warning and never a label; saving a look-alike needs "Save anyway"; first-interaction checks trust a Transfer log only if the wallet actually sent the transaction (`contacts.ts`, `contract-risk.ts`); **proven on the emulator** | The warning covers only the 4+4 heuristic. Poisoning that matches more or fewer characters, or targets an address that is not a contact, relies on the user reading the full address. Dogecoin has no look-alike test vector. |

### 4.4 Malicious or compromised RPC provider

| Id | Threat | L / I | Current mitigation and evidence | Residual risk |
|---|---|---|---|---|
| T-19 | RPC answers for a different chain (replay or confusion) | Low / High | Chain identity checked on every endpoint save and default probe; `eth_chainId` re-checked before AA signing and 7702 tuple signing; the userOpHash and EIP-155/1559 signatures bind the chain id | Low. |
| T-20 | RPC substitutes a smart-account address | Low / High | Counterfactual Kernel addresses are computed locally with CREATE2 and the spec refuses any factory answer that disagrees (`kernel-account.ts predictKernelAddress`, `docs/AA_STACK.md`); receive addresses are always derived locally (ARCHITECTURE 5.4) | Low. |
| T-21 | RPC lies about simulation, pre-flight, fees or balances | Medium / High | The fee is shown on every confirm screen before signing | The `eth_call` gate, the `eth_simulateV1` preview, risk facts and balances all come from the same endpoint the quote used (`simulation.ts`). No second-provider cross-check and no fee clamp were found in `send.ts`, `aa.ts` or the engine's `eoa-tx.ts` and `rpc.ts`, although ARCHITECTURE 5.4 describes both (N-10). A malicious RPC can therefore make a harmful transaction look harmless. |
| T-22 | RPC redirects a pinned contract (wrong factory, validator or module) | Low / High | Verify-before-save for factories (`verifyKernelDeployment`: code at all four addresses, implementation, EntryPoint, accountId, meta-factory approval, validator module type); the WebAuthn validator's runtime code hash is checked before use (`kernel-webauthn.ts verifyWebAuthnValidatorDeployment`); all pinned addresses verified read-only on Sepolia and mainnet (`docs/AA_STACK.md`, `AGENTS.md` phase 7–8) | These checks read through the same RPC, so a fully malicious RPC could fake them; the pinned constants themselves come from cited sources, which limits the damage to refusing or misreporting. |
| T-23 | Dead or refusing default endpoints | High / Medium | Ordered keyless fallbacks per chain with probing (`config/endpoint-probe.ts`; commits `482a6c3`, `05d58e9`); honest notes when log depth is limited (commit `90d3f94`) | Only Home switches endpoints mid-session; other screens move after a failure report or relaunch (phase 9 item 5 will extend this). |

### 4.5 Malicious bundler or paymaster

| Id | Threat | L / I | Current mitigation and evidence | Residual risk |
|---|---|---|---|---|
| T-24 | Bundler alters a UserOperation | Low / High | The signature covers the userOpHash, which binds every field, the chain id and the EntryPoint (ARCHITECTURE 3.2); the client re-verifies that the signer's smart account is the quoted sender (`aa.ts sendAa`) | Low. |
| T-25 | Bundler censors, delays or rejects | Medium / Medium | Bundler rejection text is shown verbatim; per-chain bundler choice is runtime configuration | Alchemy's bundler rejects Kernel deployments on both factory paths and SimpleAccount deployments (F-10); ZeroDev accepts them (proven live). The in-app owner change is currently refused by ZeroDev after a passed estimate (F-36). Users cannot self-bundle. |
| T-26 | Bundler mis-estimates gas or under-reports fees | Medium / Low | Priority-fee floor learned from the bundler (`bundlerPriorityFeeFloor`), fee shown before signing | A wrong owner signature passes estimation and fails only at submission (F-22), so estimation is not a correctness check. |
| T-27 | Bundler saved for the wrong chain | Low / Low | The userOpHash binds the chain id, so an operation signed for one chain cannot validate on another | `verifyAaBundler` checks only `eth_supportedEntryPoints`, not the bundler's chain id (N-09). The consequence is a failed operation or misleading estimates, not theft. |
| T-28 | Paymaster declines after the user approved, or sponsors with conditions | Medium / Low | The sponsored quote states that the paymaster may still decline; paymaster data is covered by the signature | No live paymaster has been exercised. |
| T-29 | Bundler or RPC exposes API keys stored in URLs | Medium / Low | URLs are masked to scheme and host in Settings (`aa.ts maskUrlForDisplay`, F-09 resolved) | Keys sit in AsyncStorage (N-08) and plain `http://` endpoints are accepted. |

### 4.6 Smart-account and module risks

This group is the reason smart-account features must stay on testnets. Each item is recorded in `AGENTS.md` phases 7 and 8 and `docs/AA_FRAMEWORKS.md`.

| Id | Threat | L / I | Current mitigation and evidence | Residual risk |
|---|---|---|---|---|
| T-30 | A bug in Kernel v3.3 itself | Low / High | Kernel v3.3 pinned at tag `v3.3` (commit `cd697c7e`), addresses verified on-chain, local CREATE2 cross-check, encodings and signatures byte-compared with the ZeroDev SDK and viem (`AGENTS.md` phases 7 and 8) | **No published audit for v3.2 or v3.3, or for the 7702 changes; no bug bounty found; no v3 support horizon; ZeroDev acquired by Offchain Labs in August 2025** (C1–C3, `docs/AA_FRAMEWORKS.md` 17.2). Unmet. |
| T-31 | Guardians replace the owner or act as the account | Medium / High | Guardian setup only for deployed Kernel accounts; default 48-hour delay so the owner can veto; a mandatory exposure warning computed by `guardianSignatureExposure` on the form, confirm and status card; mainnet Review blocked until the user acknowledges the unaudited modules and unmet C1–C3 (`recovery.ts`, `GuardiansScreen.tsx`) | Proven on Sepolia: **a single guardian's signature repeated twice satisfies a two-of-two threshold**, because the deployed weighted validator checks the threshold before signer order; enough guardian weight can also replace the guardian list; guardians can sign ERC-1271 messages as the account immediately, with no delay and no veto (F-20). No wallet-side encoding can fix the repeated-signer issue. Responsible disclosure awaits a decision (F-20). |
| T-32 | ZeroDev's single-guardian docs example overwrites the owner | Low / High | Installs only through the engine's `guardianInstallCalls` with the pinned weighted validator; `assertGuardianModulesSafe` refuses a guardian module equal to the owner's root validator; the first install call is byte-checked | Reasoned from source, not executed (F-20 item 4). |
| T-33 | Stolen passkey evicts the recovery phrase | Low / High | The engine's passkey spec refuses calls to the account itself and, since commit `8d6c357`, refuses calldata its own `encodeCalls` did not produce; the user is told the guard is in the app, not on-chain (`PASSKEY_SELF_CALL_RISK` in `passkeys.ts`) | Kernel's `execute` permits self-calls that pass `onlyEntryPointOrSelfOrRoot`, and a simulation proved a passkey-signed self-call is accepted, so anyone who can drive the passkey outside this app could call `changeRootValidator` (F-19). An on-chain fix needs a self-call-blocking hook; no audited deployed one was found. |
| T-34 | Old WebAuthn validators accept replayed assertions | Low / High | The engine pins only WebAuthnValidator v0.0.3 `0x7ab16Ff354AcB328452F1D445b3Ddee9a91e9e69` and checks its runtime code hash | v0.0.1 and v0.0.2 accept any old assertion for any operation when `responseTypeLocation` is the maximum value (found from source; no public advisory found; F-17). v0.0.3 itself is unaudited (F-18). |
| T-35 | Session key exceeds intended scope | Low / High | On-chain CallPolicy, TimestampPolicy and optional GasPolicy and RateLimitPolicy; mandatory expiry; signer flag `0x0002` so a session key can never produce an ERC-1271 signature for the account; self-calls with calldata or value refused (security-critical rule in `kernel-permissions.ts`); out-of-grant calls refused locally before any network request or key read (`sessions.ts`); explicit root-signed install only (enable mode unused) | Policies unaudited (F-14); `SudoPolicy` source carries an SPDX "UNLICENSED" header (F-15); a null selector also matches calldata beginning with `0x00000000`; GasPolicy, RateLimitPolicy and parameter rules not run live; the default-mode session operation through the app's explicit install has not run live. |
| T-36 | EIP-7702 upgrade misused or replaced | Low / High | Tuples signed only from the upgrade flow, only for the pinned Kernel v3.3 delegate or the zero address, only on the active chain, only after the biometric gate; the 7702 type is recorded per owner, not chain-wide; a foreign delegate is refused ("revoke first"); revocation always available as a self-paid type-4 transaction; **upgrade and revoke proven live in the app** | On EntryPoint v0.7 the userOpHash does not commit to the delegate, which is why the spec signs only for the pinned address and never sets `allowRedelegation` (`kernel-account.ts`, `aa.ts`; F-24). The EOA key always retains full control and can re-delegate, so guardians cannot protect an upgraded EOA (refused in the app). Kernel's 7702 changes are unaudited (F-25). |
| T-37 | Counterfactual account takeover before deployment | Low / High | The Kernel address commits to the owner through the CREATE2 salt and init code, and the spec refuses any factory answer that differs from the local prediction | The Nexus undeployed-account takeover (`docs/AA_FRAMEWORKS.md` 8.6) shows this class is real. No equivalent issue is known for Kernel v3.3; that is the absence of a finding, not an audit result. |
| T-38 | A delayed guardian proposal executes without a signature when a paymaster is attached | Low / High | The app never uses the paymaster path for recovery | Per source reading only; not verified (F-23). |

### 4.7 Supply chain

| Id | Threat | L / I | Current mitigation and evidence | Residual risk |
|---|---|---|---|---|
| T-39 | Compromised cryptographic primitive | Low / High | All primitives from `@scure/bip32`, `@scure/bip39`, `@noble/curves`, `@noble/hashes` (engine `package.json` files); every path validated against official vectors or an independent implementation (`AGENTS.md` phase 1 onward) | Low. |
| T-40 | Malicious update to any npm dependency in the app | Medium / High | Lockfiles are committed (`package-lock.json`, `app/package-lock.json`); CI uses `npm ci` (`.github/workflows/ci.yml`) | Every dependency runs in the same JavaScript realm as the signing code (section 3.3). `package.json` files use caret ranges, so a lockfile regeneration can pull new versions; ARCHITECTURE 5.5's exact-pinning rule is not followed (N-11). No dependency audit or secret scan runs in CI yet (phase 9 item 4). WalletKit pulls a large tree (1,709-module bundle when added). |
| T-41 | Wrong contract pinned | Low / High | Every pinned address (EntryPoint, Kernel factory, meta factory, implementation, ECDSA validator, permission modules, weighted validator, RecoveryAction, WebAuthn validator, Daimo verifier) cited to tagged sources and verified on-chain on Sepolia and mainnet; TimestampPolicy and RecoveryAction reproduced by compilation because no explorer had verified source (`AGENTS.md` phase 8) | The mainnet WebAuthn validator is bound by code-hash equality with Sepolia only (Sourcify partial match on Sepolia). |
| T-42 | Native module risk (passkeys, camera, secure store) | Low / Medium | Libraries chosen with recorded reasons; `react-native-passkeys` loaded lazily and only when the native module exists (`passkey-native.ts`) | `npx expo install --check` wants `expo` 57.0.26 and `expo-camera` 57.0.6 (F-45). |

### 4.8 Privacy leaks

| Id | Leak | Who learns what | Current mitigation | Residual |
|---|---|---|---|---|
| T-43 | Default RPC providers | IP plus every address on every chain at every balance refresh | User overrides allowed | All four chains' addresses are queried from one device and IP, so providers can link them. |
| T-44 | WalletConnect relay | IP and timing of dApp activity | Protocol-level encryption | Unavoidable while WalletConnect is used. |
| T-45 | CoinGecko | IP and which assets are priced | "Show fiat values" toggle with a disclosure; when off, no request is made; the Demo key is sent only to `api.coingecko.com` (`prices.ts guardedCoinGeckoFetch`) | On by default. |
| T-46 | IPFS gateway and NFT hosts | IP and which NFTs the user holds | Spam collections never fetched; SVG never rendered | `ipfs.io` is hard-coded; plain `http://` image hosts are fetched; a production release should let the user choose a gateway (`AGENTS.md` phase 7 item 4). |
| T-47 | Indexers, Blockbook, 0x, bundlers, paymasters | IP and the user's addresses, plus API-key identity | All optional and user-configured; URLs masked on screen | The vendor account ties the user's identity to their addresses. |
| T-48 | Settings screen exposing keys | Anyone looking at the screen | `maskUrlForDisplay` shows scheme and host only (F-09 resolved) | Keys still in AsyncStorage (N-08). |
| T-49 | Recovery records and exports | Whoever receives the record | Records contain no secrets; export is an explicit user action; the temporary `.json` file is deleted 60 seconds after the share sheet closes (`RecordFileActions.tsx`) | Records name guardians and their labels, and link old and new owners. |

Store privacy disclosures must list these flows (phase 9 item 3).

### 4.9 Recovery and backup

| Id | Threat | L / I | Current mitigation and evidence | Residual risk |
|---|---|---|---|---|
| T-50 | User loses the recovery phrase | High / High | Two-word backup quiz at onboarding; seed reveal behind the biometric gate; for Kernel accounts, guardian recovery | Plain EOAs, Bitcoin, Solana and Dogecoin cannot be recovered without the phrase (ARCHITECTURE 3.4). Guardian recovery carries the risks in T-31. |
| T-51 | Rotated or recovered account cannot be found again | Medium / High | Secret-free recovery metadata written before every guardian change and on each Kernel account's first operation; export as QR, text or `.json`; re-attach only after `verifyKernelAccountForOwner`; an OwnerRegistered log scan as fallback (`recovery.ts`, ADR D1 caveat F-37) | If the record is lost and the free RPC's log depth is too short, the account can be hard to find. The log-scan range is limited by free endpoints (F-08). |
| T-52 | Session grants outlive a wipe or restore | Medium / Medium | `SESSIONS_WIPE_WARNING`; wipe deletes session keys and the list; the Sessions screen recommends revoking unrecognised grants | Grants stay active on-chain until expiry or revocation; after a restore the wallet does not list them. |
| T-53 | Passkeys outlive a wipe | Low / Medium | Settings says an installed passkey stays installed on-chain | The user must remove it with the owner key and delete it in the OS password manager. Whether the platform syncs the passkey to other devices or a cloud account is **unverified** (the code comment says the key never leaves the authenticator); if it does, the passkey's protection becomes that of the cloud account. |
| T-54 | Accounts beyond Account 1 missed on restore | Medium / Low | Indices are sequential, so re-adding in order restores them | No automatic discovery; BIP-44's "no new account before history" rule is not enforced (ADR D8). |
| T-55 | No BIP-39 passphrase option | Medium / Medium | The core supports a passphrase (`packages/core/src/keyring/mnemonic.ts`) | The app never passes one (`WalletContext.tsx` calls `mnemonicToSeed(mnemonic)`), so the extra protection ARCHITECTURE 5.2 relies on is not available (N-02). |

### 4.10 Secrets in the public repository

| Id | Threat | L / I | Current mitigation and evidence | Residual risk |
|---|---|---|---|---|
| T-56 | API keys or the dev seed committed | Medium / Medium | `.dev-wallet/` (holding `mnemonic.txt` and `env` with the Alchemy, NOWNodes and ZeroDev values) is git-ignored and file-mode 600; keys are read only from that file by the testnet scripts; output masks endpoints. For this document the full git history was searched for Alchemy key URLs, ZeroDev project-id URLs and `NOWNODES_KEY=` assignments, with zero matches; the only mnemonic found in history is the public BIP-39 test phrase used in tests | No automated pre-commit secret scan yet (phase 9 item 4). The shipped WalletConnect project id is a client-side identifier by design, not a secret. |
| T-57 | Dev wallet treated as more than testnet funds | Low / Low | Scripts label it "DEV-ONLY wallet … testnet funds only" (`scripts/testnet/setup.mjs`) | The dev seed sits in plain text on one laptop; it must never receive mainnet funds. |

### 4.11 Developer-environment risks

| Id | Threat | L / I | Mitigation and evidence | Residual risk |
|---|---|---|---|---|
| T-58 | Metro serves in-progress or tampered JavaScript to a test device | Low / Medium | Metro runs from an isolated git worktree of HEAD so agent edits are never served (`AGENTS.md` phase 8 live validation) | Dev builds trust whatever Metro serves on the LAN; never put a funded mainnet wallet on a dev build. |
| T-59 | Metro lazy bundling breaks module loading | Medium / Low | `EXPO_NO_METRO_LAZY=1` workaround | Reproduction against a release bundle is still a follow-up (F-31). |
| T-60 | LogBox toasts intercept taps over approval buttons | Medium / Medium | Dev only; observed sitting exactly over "Approve & send" (`AGENTS.md` WalletConnect retest) | Absence in release builds unverified. An unexplained WalletConnect core log at pino level 50 was never read in full (F-34). |
| T-61 | CI=1 disables Metro's file watching | Low / Low | Run Metro without `CI=1` | Dev-only. |

### 4.12 Denial of service and availability

| Id | Threat | L / I | Mitigation and evidence | Residual risk |
|---|---|---|---|---|
| T-62 | Default RPC down or refusing | High / Medium | Ordered fallbacks; honest "older than block N" notes | Worst case about 16 seconds before an error with all Sepolia candidates hanging (commit `05d58e9`). |
| T-63 | Free RPC log depth too short | High / Low | Token history stops at the answered depth and says so | The approvals manager sees about 30 hours on the default mainnet endpoint (F-08). |
| T-64 | Bundler strictness blocks deployment or operations | Medium / Medium | Bundler choice per chain; ZeroDev proven for deployments | Pimlico untested; owner change currently refused (F-36). |
| T-65 | Vendor deprecations | Medium / Low | Alchemy's simulation API deprecation avoided by building on `eth_simulateV1` | `rundler_maxPriorityFeePerGas` may be deprecated (unverified; F-35). |
| T-66 | Slow account creation | Medium / Low | None yet | Adding an account took about 15 seconds on the emulator (PBKDF2 in JavaScript); measure on a real phone (F-06). |

### 4.13 Top ten risks, ranked

1. **Key storage is weaker than the design** (N-01). The phrase is not bound to biometric authentication at the storage layer; the biometric prompt is an app-level gate, and phones without enrolled biometrics have no wallet-level gate at all.
2. **Unaudited smart-account stack** (C1–C3; F-14, F-18, F-21, F-25). No published audit covers Kernel v3.3, its 7702 changes, the permission policies, the recovery modules or WebAuthn v0.0.3.
3. **Guardian validator weaknesses** (F-20). Repeated signers satisfy thresholds (proven live), and guardians can sign as the account immediately.
4. **Phishing through typed-data signatures** (T-13, N-07). Permit and Permit2 messages are shown as raw JSON with a generic warning.
5. **Unverified dApp identity** (T-11, N-06). The dApp name and URL on every sheet are self-reported.
6. **Single-provider truth** (T-21, N-10). Simulation, pre-flight, balances and risk facts all come from one RPC, with no cross-check.
7. **Passkey self-call caveat** (F-19). The guard that stops a passkey from replacing the owner exists only in this app.
8. **Supply chain in one JavaScript realm** (T-40). Every dependency can reach the signing path, and version ranges are not exact.
9. **Unverified phone-only behaviour** (sections 3.2 and 3.6). Hardware backing, Face ID, release-build behaviour and Android backup of AsyncStorage have not been checked on a real device.
10. **Recovery and lifecycle gaps** (T-51 to T-55). After an owner rotation the account cannot be derived from the seed, grants survive a wipe, there is no account discovery and no BIP-39 passphrase.

---

## 5. Mainnet-readiness checklist

Status values: **Met** (evidence exists and was reviewed), **Unmet** (known not done), **Unverified** (cannot be decided from the evidence in the repository).

### 5.1 Conditions on the smart-account stack (from `docs/AA_FRAMEWORKS.md` 17.2)

| Id | Condition | Status | Evidence location |
|---|---|---|---|
| C1 | Audit coverage for the exact Kernel version shipped (v3.3), its EIP-7702 changes, and every module the wallet installs: permission policies and ECDSASigner, WeightedECDSAValidator v3 port and RecoveryAction, WebAuthnValidator v0.0.3 | Unmet | `docs/AA_FRAMEWORKS.md` 8.3 and 17.2; `AGENTS.md` phase 8 items 2–4 (each "unaudited" finding) |
| C2 | Written answer on bug-bounty coverage for Kernel (ZeroDev or Offchain Labs) | Unmet | `docs/AA_FRAMEWORKS.md` 8.5 and 17.2 |
| C3 | Support horizon for v3 and a v3-to-v4 migration statement | Unmet | `docs/AA_FRAMEWORKS.md` 17.2 |

### 5.2 The wallet's own conditions

| Id | Condition | Status | Evidence location |
|---|---|---|---|
| W1 | Reconcile key storage with ARCHITECTURE 2.4 and D7: either bind the stored phrase to user authentication (for example `requireAuthentication` or an envelope key), or amend the design and accept the app-level gate explicitly | Unmet | `app/src/wallet/storage.ts`; section 8 of this document |
| W2 | Development build on a real iPhone and a real Android phone; Face ID and fingerprint prompts on seed reveal, send and unlock; passcode fallback | Unmet | `docs/DEVICE_BUILDS.md` |
| W3 | Secure Enclave or StrongBox behaviour of `expo-secure-store` confirmed on device | Unverified | `docs/DEVICE_BUILDS.md`; `AGENTS.md` "Remaining live checks are phone-only" |
| W4 | Store build confirms absence of LogBox, the dev menu and Metro; screenshot blocking works in release | Unverified | `docs/DEVICE_BUILDS.md` |
| W5 | App identifiers, store listing and privacy disclosures (RPC providers, WalletConnect relay, CoinGecko, IPFS gateway, indexers) | Unmet (input needed: Expo account, bundle id and package name) | `AGENTS.md` phase 9 item 3 |
| W6 | One real Dogecoin mainnet broadcast (about 1 DOGE in fees) before Dogecoin sending ships | Unmet | `AGENTS.md` "Known untested remainder" |
| W7 | Live 0x quote and swap before swaps ship on mainnet | Unmet (no 0x key) | `AGENTS.md` phase 5 item 1 |
| W8 | Live paymaster sponsorship before sponsorship ships | Unmet (no endpoint) | `AGENTS.md` phase 5 item 2 |
| W9 | Per-feature mainnet gating switchboard: Kernel accounts, guardians, session keys, passkeys and 7702 upgrades testnet-only until C1–C3 clear | Unmet | `AGENTS.md` phase 9 item 6 |
| W10 | CI runs engine tests, all offline app suites, lint, typecheck, the bundle export, a dependency audit and a secret scan | Partly met: CI runs engine tests, typecheck, `test-units.mjs` and the Android export; the other 22 suites, lint, audit and secret scan are not in CI | `.github/workflows/ci.yml`; `AGENTS.md` phase 9 item 4 |
| W11 | Typed-data permit and Permit2 decoding with spender, amount and expiry | Unmet | N-07 |
| W12 | dApp identity signal (for example WalletConnect Verify) or an explicit decision that none is shown | Unmet | N-06 |
| W13 | Decision on a second-provider cross-check or an explicit acceptance of single-provider simulation | Unmet | N-10 |
| W14 | Decision on the guardian-validator disclosure to ZeroDev and Offchain Labs | Unmet (awaiting the Chairperson) | `AGENTS.md` "Phase 8 complete" |
| W15 | In-app owner change works end to end (both directions) | Unmet (under investigation) | `AGENTS.md` phase 9 item 1; F-36 |
| W16 | Counsel's answer on (L)GPL and AGPL contract use and the UNLICENSED SudoPolicy header | Unmet | `AGENTS.md` phase 7 frameworks findings; F-15, F-39 |
| W17 | Lock overlay covers native alerts and modals; sessions cleared or flagged on wipe | Unmet | F-27, F-28 |
| W18 | Android backup policy for AsyncStorage decided and configured | Unverified | N-08 |
| W19 | Screenshot blocking on the Import screen; app-switcher privacy cover | Unmet | N-04, N-05 |
| W20 | Dependency versions in sync with the Expo SDK (`npx expo install --check` clean) | Unmet | F-45 |

Leadership reading: no item in 5.1 is met, so every smart-account feature stays testnet-only. For plain-account features, W1 to W6, W10 to W13 and W17 to W20 are the gating set.

---

## 6. Open findings register

Owner abbreviations: **Chair** = the Chairperson (decision or input), **CTO** = the project's lead engineer and agent coordinator, **Vendor** = a third party. Status: **Open**, **Mitigated** (risk reduced in the wallet, root cause outside it), **Accepted** (consciously kept), **Fixed**, **Info** (recorded fact).

### 6.1 Findings recorded in `AGENTS.md`

| Id | Finding | Severity | Status | Owner | Source |
|---|---|---|---|---|---|
| F-01 | Backup screen allowed screenshots | High | Fixed (commit `32bfd9e`, proven on emulator) | CTO | Emulator validation, finding #3 |
| F-02 | Settings Tokens copy stale | Low | Fixed | CTO | Emulator validation, continued |
| F-03 | Sepolia Ethereum row showed "no endpoint" | Low | Fixed | CTO | Same |
| F-04 | LockGate checked biometric availability only at mount | Medium | Fixed | CTO | Third emulator pass, finding #4 |
| F-05 | CoinGecko answers HTTP 200 for a made-up Demo key; the check cannot prove a key genuine | Low | Accepted (UI says "Checked", not "verified") | CTO | Phase 6 item 2 app half |
| F-06 | Adding an account took about 15 s on the emulator | Low | Open (measure on device) | CTO | Phase 6 emulator validation |
| F-07 | Default mainnet RPC hostname failed TLS | Medium | Fixed (fallback list, `482a6c3`) | CTO | Phase 7 infra finding |
| F-08 | Free endpoint refuses `eth_getLogs` older than about 10,000 blocks | Medium | Mitigated (`90d3f94`); approvals manager limited to about 30 hours on that endpoint | CTO | Phase 7 item 5; burn-down |
| F-09 | Settings rendered full bundler and indexer URLs with API keys | Medium | Fixed (masking) | CTO | Phase 7 live validation |
| F-10 | Alchemy's bundler rejects Kernel deployments (both factory paths, ERC-7562) and SimpleAccount deployments (AA13) | Medium | Mitigated (ZeroDev proven); Pimlico untested | CTO / Vendor | Phase 2 task 8; phase 7 direct-factory probe |
| F-11 | Kernel v3.3 has no ERC-7739; SimpleAccount v0.7.0 has no ERC-1271 | Info | Accepted (SimpleAccount sessions warned and refused for signing) | CTO | Phase 7 items 3 and 5 |
| F-12 | Free endpoints answer historical `eth_getCode` only to latest-64 blocks | Low | Accepted (contract age treated as unknown, no warning raised) | CTO | Phase 7 items 3 and 5 |
| F-13 | The public test address is 7702-delegated on mainnet | Info | Info | — | Phase 7 items 3 and 5 |
| F-14 | No published audit covers the Kernel permission policies or ECDSASigner | High (for mainnet) | Open (C1) | Chair / Vendor | Phase 8 item 2 finding (a) |
| F-15 | Plugins repo is MIT, but the verified SudoPolicy source says SPDX UNLICENSED | Low | Open (counsel) | Chair | Phase 8 item 2 finding (b) |
| F-16 | ERC-7715 responses require an ERC-7710 delegation manager, which Kernel lacks | Low | Accepted (wallet-specific permission type, stated to dApps) | CTO | Phase 8 item 2 finding (c) |
| F-17 | WebAuthnValidator v0.0.1 and v0.0.2 accept replayed assertions | High (for users of those versions elsewhere) | Mitigated in this wallet (v0.0.3 pinned); disclosure status unknown | Chair / Vendor | Phase 8 item 3 security finding |
| F-18 | WebAuthnValidator v0.0.3 has no audit; the v3.1 audit covered the unpatched code with no WebAuthn findings | High (for mainnet) | Open (C1) | Chair / Vendor | Phase 8 item 3 |
| F-19 | Passkey self-call caveat: a passkey can make self-calls on Kernel, so only the app stops it from replacing the owner | High (where passkeys are used) | Open (needs an audited self-call-blocking hook) | CTO | Phase 8 item 3 |
| F-20 | Guardian validator: (1) enough weight replaces owner and guardian list; (2) guardians sign as the account immediately; (3) a repeated signer satisfies the threshold, proven live; (4) ZeroDev's single-guardian docs example would overwrite the owner (reasoned); (5) recovery cannot protect a 7702-upgraded EOA; (6) the SDK maps the validator to Kernel 0.3.0–0.3.1 only | High | Mitigated in the app (warnings, refusals, default delay); root cause open; **disclosure awaits the Chairperson's decision** | Chair / Vendor | Phase 8 item 4 findings |
| F-21 | The v3 guardian modules (weighted validator port and RecoveryAction) appear in no published audit | High (for mainnet) | Open (C1) | Chair / Vendor | Phase 8 item 4 |
| F-22 | A wrong owner signature passes bundler gas estimation; rejection appears only at submission | Low | Accepted (lesson recorded) | CTO | Phase 8 item 4 |
| F-23 | With a paymaster attached, an approved delayed recovery proposal executes with no signature (per source) | Medium | Mitigated (paymaster path unused); unverified | CTO | Phase 8 item 4 |
| F-24 | On EntryPoint v0.7 the userOpHash does not commit to the 7702 delegate | Medium | Mitigated (pinned delegate; `allowRedelegation` never set) | CTO | Phase 8 item 1 engine half |
| F-25 | Kernel v3.3's 7702 changes are unaudited | High (for mainnet) | Open (C1) | Chair / Vendor | Phase 8 item 1 |
| F-26 | ZeroDev's 7702 quickstart passes a version constant as a contract address | Info | Info | Vendor | Phase 8 item 1 |
| F-27 | Native alerts and other screens' QR-scanner modals can draw above the lock overlay | Medium | Open | CTO | Phase 6 item 5 |
| F-28 | WalletConnect sessions survive a wallet wipe | Medium | Open (requests naming the old address are refused) | CTO | Phase 6 item 5 |
| F-29 | Other-mode chain switches are declined with 5100, not MetaMask's non-standard 4902 | Info | Accepted | CTO | Phase 6 item 5 |
| F-30 | ERC-5792's own example uses chain id `0x01` against its normative rule; such dApps are refused | Info | Accepted | CTO | Phase 7 items 1–3 |
| F-31 | Metro lazy bundling caused "Requiring unknown module" at the WalletConnect chunk boundary | Medium | Open (dev workaround; reproduce on a release bundle) | CTO | Live WalletConnect pairing |
| F-32 | First Expo Go launch raced Expo Go's self-update | Info | Emulator only | — | Emulator validation |
| F-33 | LogBox overlays intercept taps in dev builds | Low | Accepted (dev only; release absence unverified) | CTO | Grand finale; retest |
| F-34 | A WalletConnect core log at pino level 50 was never read in full | Low | Open (unexplained) | CTO | Phase 7 live validation; retest |
| F-35 | `rundler_maxPriorityFeePerGas` may be deprecated (search summary only) | Low | Unverified; helper degrades gracefully | CTO | Phase 7 live validation |
| F-36 | In-app owner change refused by ZeroDev with -32502 "Simulation ran out of gas for entity: account" after a passed estimate; owner unchanged on-chain | Medium | **Open, under investigation** (phase 9 item 1). An uncommitted working-tree change hypothesises verification gas for the EntryPoint deposit top-up; not yet recorded or proven | CTO | Phase 9 plan item 1 |
| F-37 | ADR D1 caveat: after an owner rotation the account address cannot be derived from any seed | Medium | Mitigated (recovery metadata, `.json` export, log scan) | CTO | AA_FRAMEWORKS finding (b); phase 8 item 4 |
| F-38 | BundleBear labels 2.34 million live 7702 delegations as "Crime" | Info | Supports D6 | — | AA_FRAMEWORKS finding (c) |
| F-39 | Open legal question on (L)GPL and AGPL contract use by a closed-source app | Medium | Open (counsel) | Chair | AA_FRAMEWORKS finding (d) |
| F-40 | Kernel's default branch is an unreleased, unaudited v4 on EntryPoint v0.9; ZeroDev acquired | Medium | Open (C3) | Chair / Vendor | AA_FRAMEWORKS 1 and 17 |
| F-41 | Dogecoin broadcast never executed | Medium | Open (W6) | Chair | Known untested remainder |
| F-42 | No account discovery on import; BIP-44 gap rule not enforced | Low | Accepted (ADR D8) | CTO | ADR D8 |
| F-43 | EVM accounts share a non-hardened parent | Low | Accepted while no xpub export exists (ADR D8) | CTO | ADR D8 |
| F-44 | Eight leftover eslint-disable comments; `Buffer` no-undef in scripts | Low | Open (phase 9 item 5) | CTO | ESLint burn-down |
| F-45 | `npx expo install --check` wants expo 57.0.26 and expo-camera 57.0.6 | Low | Open | CTO | Phase 8 item 3 app half |
| F-46 | A narrow pre-existing ref clobber window in WalletContext and WalletConnectContext, described only in a builder's report | Low | Open; details not in the repository, not reviewed here | CTO | ESLint burn-down |
| F-47 | IPFS gateway `ipfs.io` sees IP and CIDs; no user choice | Low | Open | CTO | Phase 7 item 4 |
| F-48 | Alchemy's simulation API deprecated 2026-09-30 | Info | Avoided (`eth_simulateV1`) | — | Phase 6 item 1 re-scope |
| F-49 | Session-key caveats: a null selector also matches `0x00000000…` calldata; `invalidateNonce` must not be used as "revoke all"; an unused enable signature cannot be cancelled | Low | Accepted (documented; enable mode unused in the app) | CTO | Phase 8 item 2 |
| F-50 | ERC-721 `approve` shares the ERC-20 selector, so the calldata fallback can over-warn | Info | Accepted | CTO | Phase 7 item 5 |
| F-51 | `NEW_CONTRACT_THRESHOLD_BLOCKS` = 50,400 is a judgement, not a standard | Info | Product choice to review | Chair | Phase 7 item 5 app half |

### 6.2 New observations from this review

These came from reading the code for this document. None was previously recorded in `AGENTS.md`.

| Id | Observation | Severity | Status | Owner | Evidence |
|---|---|---|---|---|---|
| N-01 | The mnemonic is stored without `requireAuthentication`; biometric protection is an app-level prompt before `signWith`, not a key-release condition. Devices without enrolled biometrics get no wallet-level prompt | High (for mainnet) | Open (W1) | CTO / Chair | `app/src/wallet/storage.ts`; `biometric.ts` matrix; no `requireAuthentication` in `app/src` |
| N-02 | No BIP-39 passphrase option in the app, although the core supports one | Medium | Open | Chair (product decision) | `WalletContext.tsx`; `packages/core/src/keyring/mnemonic.ts` |
| N-03 | The mnemonic is handled as a JavaScript string and derived private keys are not explicitly zeroed; only the seed buffer is | Low | Open (document or move the hot path to native code, per ARCHITECTURE 5.5) | CTO | `WalletContext.tsx`; `packages/core/src/chains/*.ts` |
| N-04 | The Import screen, where the phrase is typed, has no screen-capture block | Medium | Open | CTO | `app/src/screens/ImportScreen.tsx` |
| N-05 | No privacy cover for the OS app-switcher snapshot | Low | Open | CTO | Only `LockGate.tsx` and `lock.ts` handle `AppState` |
| N-06 | dApp name and URL are self-reported; no WalletConnect Verify usage | High | Open (W12) | CTO | `walletconnect.ts` ("display only, unverified") |
| N-07 | No specific decoding or warning for Permit and Permit2 typed data | High | Open (W11) | CTO | `WcApprovalSheet.tsx` generic warning |
| N-08 | Third-party API keys live in AsyncStorage; `android.allowBackup` is not set in `app.json`; endpoint setters accept `http://` | Medium | Open (W18) | CTO | `app/app.json`; URL patterns in `aa.ts`, `indexer.ts`, `blockbook.ts`, `nfts.ts`, `config/networks.ts` |
| N-09 | Bundler save does not check the bundler's chain id | Low | Open | CTO | `aa.ts verifyAaBundler` |
| N-10 | Simulation, pre-flight, balances and risk facts come from one provider; no cross-check or fee clamp found | Medium | Open (W13) | CTO / Chair | `simulation.ts`, `send.ts`, `aa.ts`, `chains-evm/src/eoa-tx.ts`, `rpc.ts` |
| N-11 | Caret version ranges in `package.json` files, against ARCHITECTURE 5.5's exact-pinning rule (lockfiles are committed) | Low | Open | CTO | `app/package.json`, `packages/*/package.json` |

---

## 7. Review guidance: reproducing the verification

### 7.1 Toolchain

Use Node.js v24.21.0 through nvm. The shell default on the development machine may resolve to an older Node, so prefix the path as `AGENTS.md` instructs:

```sh
export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
```

### 7.2 Engine (offline, no keys)

```sh
npm ci
npm run build
npm test
```

Last recorded count: 595 engine tests across five packages, 359 of them in `chains-evm` (`AGENTS.md`, awaited-signUserOpHash entry, commit `8d6c357`). Uncommitted phase 9 item 1 work adds tests to `packages/chains-evm/test/smart-account.test.ts`. The cryptographic tests compare against official vectors and independent implementations; the comparison libraries (ethers, bitcoinjs-lib, @solana/web3.js and others) are development dependencies, while viem and the ZeroDev SDK were installed only in a scratchpad when the byte comparisons were made (`AGENTS.md` phases 7 and 8), so those particular cross-checks are pinned as literals in the tests rather than re-run against the libraries.

### 7.3 App (offline suites)

From `app/`:

```sh
npm ci
npx tsc --noEmit
npx expo lint
node scripts/<suite>.mjs        # one command per suite below
npx expo export --platform android
```

Last recorded counts for the 23 offline suites (each from the most recent `AGENTS.md` entry that names it):

| Suite | Checks | Suite | Checks |
|---|---|---|---|
| `test-units.mjs` | 45 | `check-simulation.mjs` | 49 |
| `check-aa.mjs` | 74 | `check-prices.mjs` | 110 |
| `check-aa-kernel.mjs` | 74 | `check-contacts.mjs` | 110 |
| `check-wc.mjs` | 197 | `check-accounts.mjs` | 111 |
| `check-wc-5792.mjs` | 89 | `check-nfts.mjs` | 120 |
| `check-token-send.mjs` | 37 | `check-rpc-fallback.mjs` | 85 (98 with `--live`) |
| `check-swap.mjs` | 89 | `check-approvals.mjs` | 99 |
| `check-devmode.mjs` | 71 | `check-7702.mjs` | 111 |
| `check-qr.mjs` | 31 | `check-sessions.mjs` | 99 |
| `check-tokens.mjs` | 28 (has a live step) | `check-passkeys.mjs` | 125 |
| `check-doge.mjs` | 83 (11 live checks need the NOWNodes key) | `check-recovery.mjs` | 209 |
| `check-token-history.mjs` | 48 (plus `--live`) | | |

These counts were not re-run for this document. The uncommitted phase 9 item 1 work changes `check-aa.mjs` and `check-recovery.mjs`. `check-balances.mjs`, `check-history.mjs` and `check-indexer.mjs` are live, developer-run scripts (the indexer one needs an Alchemy key).

Security-relevant suites to read first: `check-wc.mjs` and `check-wc-5792.mjs` (request parsing, refusals, D6), `check-7702.mjs` (every D6 refusal is a test), `check-sessions.mjs` (out-of-grant refusal with zero network calls and no key read), `check-recovery.mjs` (guardian refusals, exposure numbers, tampered-file refusal), `check-passkeys.mjs` (strict decoding, rpId hash, the pinned validator code hash), `check-contacts.mjs` (exact matching and look-alike warnings), and `check-accounts.mjs` (account 0 byte-identical to the original derivation).

### 7.4 Testnet scripts (`scripts/testnet/`)

All live scripts spend Sepolia (or Bitcoin testnet and Solana devnet) test funds from the git-ignored dev wallet created by `setup.mjs` in `.dev-wallet/mnemonic.txt`. Keys come from `.dev-wallet/env`. No script touches mainnet funds.

| Script | What it proves | Needs |
|---|---|---|
| `smoke.mjs` | EOA broadcasts on Sepolia, Bitcoin test networks, Solana devnet; armed Dogecoin testnet leg | Dev wallet funded; `NOWNODES_KEY` for Dogecoin |
| `aa-smoke.mjs` | SimpleAccount deployment and an operation | `NODE_URL`, `BUNDLER_URL`, `FACTORY` |
| `kernel-smoke.mjs` | Kernel deployment and a batch; `KERNEL_SMOKE_DRY_RUN=1` simulates read-only with the public test mnemonic | Bundler URL for the live leg (ZeroDev accepts deployments) |
| `eip7702-smoke.mjs` | 7702 delegation in a UserOperation and revocation; `EIP7702_SMOKE_DRY_RUN=1` | ZeroDev project id; optionally an Alchemy key for the probe |
| `session-key-smoke.mjs` | Install, use, rejection and revocation of a session key; `SESSION_SMOKE_DRY_RUN=1` | ZeroDev project id for the live leg |
| `recovery-smoke.mjs` | Guardian install, recovery and rotate-back; `RECOVERY_SMOKE_DRY_RUN=1` (29 checks, including delay and veto) | ZeroDev project id for the live leg |
| `passkey-smoke.mjs` | Passkey install, use and uninstall by simulation; `PASSKEY_SMOKE_DRY_RUN=1` | `NODE_URL` only |
| `signature-check.mjs` | ERC-1271 and ERC-6492 signatures of a counterfactual Kernel account, read-only | `NODE_URL` |
| `kernel-deploy-for-owner.mjs`, `kernel-rotate-owner.mjs`, `guardian-approve.mjs`, `fund.mjs` | Helpers used in the emulator runs | Dev wallet; ZeroDev for rotation |

To check a claimed on-chain result independently, take the transaction hash recorded in `AGENTS.md` and read its receipt from any Sepolia RPC (`eth_getTransactionReceipt`); for 7702 runs also read `eth_getCode` of the EOA, which must be `0xef0100` followed by the Kernel implementation address while delegated and `0x` after revocation.

### 7.5 What a reviewer cannot reproduce without inputs

- Anything on a physical phone (no development build exists; needs an Expo account and bundle identifiers).
- Passkeys (needs a development build and a relying-party domain the Chairperson controls).
- Live swaps (0x key), live sponsorship (paymaster endpoint), Dogecoin broadcast (test or mainnet DOGE), live NFT history and gallery (Alchemy NFT API key).
- WalletConnect flows (a dApp session; the emulator procedure is in `AGENTS.md`, including the ADBKeyboard method for pasting pairing URIs).

### 7.6 Suggested focus for an external reviewer

1. `WalletContext.signWith` and every call site: confirm each is preceded by user authentication, and that no other path loads the mnemonic (`storage.ts` is the only importer of the mnemonic functions).
2. `walletconnect.ts` request parsing and the D6 refusals; `WcApprovalSheet.tsx` rendering of typed data.
3. `kernel-permissions.ts validateSessionKeyGrant` (the self-call rule) and `kernel-webauthn.ts` (the self-call refusal and the assertion checks).
4. `kernel-recovery.ts` and `recovery.ts` (guardian refusals, exposure model, record parsing).
5. `kernel-account.ts` (CREATE2 cross-check, 7702 tuple rules).
6. `delegation.ts` and `eip7702.ts` (tuple nonce, chain id, delegate pinning).
7. `simulation.ts`, `risk.ts`, `contract-risk.ts` (what the user is shown, and what a malicious RPC could change).

---

## 8. Places where the documents and the code disagree

This section exists so that no reader is misled by an older design text. Each item states what the document says, what the code does, and what to do.

1. **Hardware-gated key storage.** ARCHITECTURE 2.4, 5.1 and ADR D7 describe envelope encryption with a Secure Enclave or Keystore key that requires biometric presence, so that "the seed blob is undecryptable without a hardware-verified biometric event". The code stores the phrase directly in `expo-secure-store` with `WHEN_UNLOCKED_THIS_DEVICE_ONLY` and no `requireAuthentication`, and gates actions with an app-level `requireLocalAuth` prompt (`storage.ts`, `biometric.ts`). Either implement the design or amend ARCHITECTURE to match (W1, N-01).
2. **Wallet-level passcode.** ARCHITECTURE 2.4 says the app "additionally supports a wallet-level passcode". The recorded decision in `lock.ts` is that there is no app PIN. ARCHITECTURE should be amended.
3. **BIP-39 passphrase.** ARCHITECTURE 2.1 and 5.2 describe an optional passphrase for generation and import. The core supports it; the app does not offer it (N-02).
4. **Memory hygiene.** ARCHITECTURE 5.5 says secrets never live in JavaScript strings and every secret buffer is zeroed. The mnemonic is a string and derived keys are not zeroed; the seed is (N-03).
5. **Provider cross-checks and fee clamps.** ARCHITECTURE 5.4 describes verification against a second provider and fee sanity bounds. Neither was found (N-10).
6. **Permit warnings and origin binding.** ARCHITECTURE 5.3 promises explicit warnings for permit signatures and display of the requesting origin. The sheet shows a generic warning and a self-reported origin (N-06, N-07).
7. **Exact version pinning.** ARCHITECTURE 5.5 requires exact versions; the `package.json` files use caret ranges, with committed lockfiles (N-11).
8. **Audited modules.** ARCHITECTURE 3.5 and D6 say only audited, allowlisted modules are installed. The allowlist exists (pinned addresses), but none of the installed modules has a published audit for the deployed version (C1).
9. **Account discovery.** ARCHITECTURE 2.2 says import follows the BIP-44 gap-limit discovery convention; ADR D8 in the same file says there is no discovery. D8 matches the code.
10. **`docs/DECISIONS.md`.** ARCHITECTURE's header and section 7 call it the canonical ADR file; it does not exist, and `AGENTS.md` records that section 7 superseded it.
11. **Risk warnings placement.** `AGENTS.md` (phase 7 items 1–3 app halves) still says `RiskWarnings` must be placed in SendScreen, SwapScreen and WcApprovalSheet; the code has it on all three (commit `be0656e`), and the phase 7 completion entry is consistent with the code.
12. **Owner-change root cause.** `AGENTS.md` records the -32502 refusal as coming from ZeroDev. The uncommitted fix attributes the gas shortfall to Rundler's estimation behaviour. Which upstream ZeroDev routes through was recorded as unverified in phase 8 item 1, so this is an open question rather than a contradiction; it should be settled in the item 1 record.

---

## 9. What this document could not substantiate

- Whether `expo-secure-store` items are StrongBox-, TEE- or Secure-Enclave-backed on real phones.
- Whether platform passkeys created through `react-native-passkeys` are synchronised to other devices or a cloud account.
- Whether Expo's default Android configuration includes AsyncStorage in automatic backups.
- Whether `expo-screen-capture` blocks screenshots and recordings on iOS in a release build.
- Whether third-party Android keyboards store words typed into the import field.
- Whether release builds are free of LogBox, the dev menu and the Metro dependency.
- Whether the GitHub Actions workflow is currently passing (not checked from this machine).
- The details of builder reports that are referenced in `AGENTS.md` but are not in the repository (emulator checklists, the ref clobber window in F-46).
- WalletConnect's end-to-end encryption properties as implemented by the installed WalletKit version (relied on, not reviewed).

---

## Appendix A. Glossary

- **Bundler:** a service that collects ERC-4337 UserOperations and submits them to the EntryPoint contract.
- **Counterfactual address:** the address a smart account will have once deployed, computable in advance with CREATE2.
- **EIP-7702 authorization (tuple):** a signature by an EOA that sets its code to point at a delegate contract.
- **ERC-1271 / ERC-6492:** how contracts validate signatures, and how that works before the contract is deployed.
- **ERC-5792:** the wallet call API dApps use to request atomic batches.
- **ERC-7715:** a draft standard for dApps to request scoped execution permissions (session keys).
- **Guardian:** another key holder who can approve an owner change on a Kernel account.
- **Kernel v3.3:** ZeroDev's ERC-7579 modular smart account, the wallet's production candidate.
- **Paymaster:** a contract and service that pays gas for a UserOperation.
- **Session key:** a separate key allowed to act for a smart account within on-chain limits.
