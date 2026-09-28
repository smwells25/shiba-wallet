# System Architecture

**Status:** Draft for engineering review
**Audience:** Engineers building and maintaining the wallet. No prior context is assumed.
**Related documents:** `docs/DECISIONS.md` (canonical Architecture Decision Records), `docs/FEATURE_UNIVERSE.md` (feature landscape for leadership), `AGENTS.md` (project state).

This document describes the architecture of a non-custodial mobile cryptocurrency wallet whose defining feature is Account Abstraction (ERC-4337 and EIP-7702) on EVM chains, with first-class support for Bitcoin, Solana, and Dogecoin, and an adapter system designed to scale to thousands of assets.

Two invariants govern every design choice in this document:

1. **Non-custodial invariant.** All key material is generated, stored, and used exclusively on the user's device. No server, no vendor, and no component outside the device ever receives a seed, a private key, or anything from which one can be derived.
2. **Flexibility invariant.** Every capability must be addable, replaceable, or removable without rewriting the core. Chains, signers, account implementations, and infrastructure providers are all pluggable behind stable interfaces.

---

## 1. System overview

The system is organized in four layers. Each layer depends only on the layer directly below it, and every cross-layer dependency is an interface, not a concrete implementation.

```
┌─────────────────────────────────────────────────────────────────────┐
│  Mobile app shell (React Native)                                    │
│  UI, navigation, biometric prompts, QR scanning, deep links,        │
│  WalletConnect session UI, push notifications                       │
│  Platform bridges: iOS Keychain / Secure Enclave,                   │
│                    Android Keystore / StrongBox                     │
├─────────────────────────────────────────────────────────────────────┤
│  Wallet engine (@shiba-wallet/core — pure TypeScript, UI-agnostic)  │
│  ┌──────────┐ ┌───────────────┐ ┌───────────────┐ ┌──────────────┐  │
│  │ Keyring  │ │ Asset registry│ │ Tx pipeline   │ │ AA engine    │  │
│  │ BIP-39/  │ │ CAIP-2/19 ids │ │ build → sign  │ │ UserOps,     │  │
│  │ 32/44    │ │ SLIP-44 map   │ │ → broadcast   │ │ paymasters,  │  │
│  │ SLIP-0010│ │               │ │               │ │ session keys │  │
│  └──────────┘ └───────────────┘ └───────────────┘ └──────────────┘  │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │ ChainAdapter registry (keyed by CAIP-2 chain id / SLIP-44)     │ │
│  └────────────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────────┤
│  Chain adapters (one package per chain family)                      │
│  ┌───────────────────┐ ┌───────────────────┐ ┌───────────────────┐  │
│  │ chains-evm        │ │ chains-bitcoin    │ │ chains-solana     │  │
│  │ EVM txs +         │ │ UTXO base class:  │ │ ed25519,          │  │
│  │ ERC-4337 smart    │ │ Bitcoin, Dogecoin │ │ SPL tokens        │  │
│  │ accounts, 7702    │ │ (and future forks)│ │                   │  │
│  └───────────────────┘ └───────────────────┘ └───────────────────┘  │
├─────────────────────────────────────────────────────────────────────┤
│  Networks and external infrastructure (untrusted)                   │
│  Chain RPC nodes · ERC-4337 bundlers · Paymaster services ·         │
│  Block explorers / indexers · Price feeds                           │
└─────────────────────────────────────────────────────────────────────┘
```

Layer responsibilities:

- **Mobile app shell (React Native).** Presentation and platform integration only. It renders state provided by the wallet engine, collects user intent, and owns the two things that genuinely require native code: secure storage (Keychain/Keystore) and biometric gating. It contains no cryptography and no chain logic. Because the engine is pure TypeScript (decision D2), the same engine can later back a browser extension or a CLI without modification.
- **Wallet engine (`@shiba-wallet/core`).** The brain. It owns the keyring (mnemonic handling and HD derivation), the asset registry, the transaction pipeline, the Account Abstraction engine, and the `ChainAdapter` registry. It has no React, no React Native, and no Node-specific dependencies; its only external code is the audited `@scure`/`@noble` cryptography suite.
- **Chain adapters.** One package per chain family, each implementing the `ChainAdapter` interface (section 4). Bitcoin and Dogecoin share a UTXO base class. The EVM adapter additionally implements the smart-account extension used by the AA engine.
- **Networks.** Everything past the device boundary. All of it is treated as untrusted: RPC nodes, bundlers, paymasters, and indexers can lie, censor, or go offline, and the design must degrade safely when they do (section 5).

The trust boundary sits between the adapter layer and the network layer. Everything above the boundary runs on-device and may handle secrets under the keyring's rules; everything below it sees only public data and signed artifacts.

---

## 2. Key management

### 2.1 One seed, everything (decision D1)

The wallet is a hierarchical deterministic (HD) wallet. A single BIP-39 mnemonic is the root of every asset the wallet will ever hold — including the owner key of every ERC-4337 smart account (section 3). The user backs up one phrase; that phrase recovers Bitcoin, Ethereum EOAs, Ethereum smart accounts, Solana, Dogecoin, and any chain added in the future.

The derivation chain is:

```
BIP-39 mnemonic (12 or 24 words)
        │  + optional BIP-39 passphrase
        ▼  PBKDF2-HMAC-SHA512 (per BIP-39)
64-byte seed
        │
        ▼  HMAC-SHA512("Bitcoin seed") per BIP-32   (secp256k1 chains)
        ▼  HMAC-SHA512("ed25519 seed") per SLIP-0010 (ed25519 chains)
Master extended private key
        │
        ▼  BIP-44 / SLIP-44 paths (hardened at the account level)
Per-asset, per-account private keys
```

**Generation.** New mnemonics use `@scure/bip39` with entropy from the platform CSPRNG (`crypto.getRandomValues`, backed by the OS). Default is 12 words (128 bits of entropy); 24 words is offered for users who want it. The engine never implements its own entropy source or wordlist handling.

**Import.** Imported mnemonics are validated (wordlist membership and checksum) before acceptance. An optional BIP-39 passphrase ("25th word") is supported for both generation and import; the UI must make clear that a passphrase-derived wallet is unrecoverable without the passphrase.

**Libraries.** All derivation uses `@scure/bip32`, `@scure/bip39`, `@noble/curves`, and `@noble/hashes` — audited, dependency-free, and validated in our test suite against the official BIP-32/BIP-39 test vectors. Hand-rolled primitives are prohibited (section 5.4).

### 2.2 Derivation paths per asset

Paths follow BIP-44 structure `m / purpose' / coin_type' / account' / change / address_index`, with SLIP-44 registered coin types. The concrete defaults:

| Asset | Path | Curve | Notes |
|---|---|---|---|
| Bitcoin (native SegWit, default) | `m/84'/0'/0'/0/x` | secp256k1 | BIP-84, P2WPKH `bc1q…` addresses |
| Bitcoin (legacy, import compatibility) | `m/44'/0'/0'/0/x` | secp256k1 | BIP-44, P2PKH addresses |
| Ethereum / all EVM chains | `m/44'/60'/0'/0/x` | secp256k1 | One key namespace for every EVM chain; the CAIP-2 chain id, not the path, distinguishes networks |
| Solana | `m/44'/501'/x'/0'` | ed25519 | SLIP-0010; all segments hardened (see below). Account 0 gives `m/44'/501'/0'/0'`, matching the dominant ecosystem convention |
| Dogecoin | `m/44'/3'/0'/0/x` | secp256k1 | BIP-44, P2PKH addresses |

Notes on the table:

- Bitcoin defaults to BIP-84 native SegWit for lower fees; the BIP-44 legacy path is retained so imported wallets created elsewhere are discoverable. Account discovery on import follows the BIP-44 gap-limit convention (scan addresses, stop after 20 consecutive unused).
- EVM chains deliberately share the coin type 60 key namespace. Deriving per-chain keys for EVM networks would break the ecosystem-wide expectation that one address works across all EVM chains, and would break counterfactual smart-account address portability (section 3.1).
- Solana uses ed25519, which BIP-32 does not support. Derivation follows SLIP-0010, under which ed25519 supports **only hardened** derivation — hence every path segment carries `'`. Additional Solana accounts increment the third segment, the BIP-44 account field (`m/44'/501'/0'/0'`, `m/44'/501'/1'/0'`, …), matching Phantom's documented convention (`m/44'/501'/{index}'/0'`) so imports round-trip cleanly.
- Each `ChainAdapter` declares its own default path template and curve (section 4), so the keyring stays generic: it derives what an adapter asks for and applies no chain-specific logic itself.
- Multiple user-facing accounts ("Account 1", "Account 2", …) map onto these templates as recorded in ADR D8 (section 7): EVM increments the address index, Solana, Bitcoin and Dogecoin increment the hardened account level.

### 2.3 Hardened vs. non-hardened derivation, and why it matters

BIP-32 defines two child-derivation modes:

- **Non-hardened** (index < 2³¹): the child public key can be computed from the parent *extended public key* alone. This enables watch-only wallets — an xpub can generate the whole address sequence without any private material. The cost is a known weakness: anyone who obtains the parent extended public key **and any one non-hardened child private key** can reconstruct the parent private key (the chain code in the xpub lets them reverse the derivation arithmetic), and from it every sibling key.
- **Hardened** (index ≥ 2³¹, written with `'`): derivation mixes in the parent *private* key, so child keys cannot be derived from the xpub, and the reconstruction attack above is impossible across a hardened boundary.

Our policy, per requirement 2 and BIP-44 itself: **`purpose`, `coin_type`, and `account` are always hardened; only `change` and `address_index` may be non-hardened** (and on ed25519 chains even those are hardened, as SLIP-0010 requires).

Why hardened account-level derivation protects sibling assets: suppose a single Ethereum private key leaks — say through a compromised dApp interaction — and an attacker also obtains an extended public key the wallet exported for watch-only or balance-indexing purposes. If the tree were non-hardened all the way up, that pair could be walked back up to the master key and then down into the Bitcoin, Solana, and Dogecoin branches: one leaked key would drain every asset. With hardening at `coin_type'` and `account'`, the reconstruction stops at the hardened boundary. The blast radius of a leaked key is at most the non-hardened subtree it belongs to — one account of one asset — never the siblings and never the master. Each asset, and each account within an asset, lives in its own cryptographic compartment.

Practical corollary: the wallet may only ever export extended public keys from **below** the hardened account level (e.g. the xpub at `m/84'/0'/0'`), and any such export must be treated as privacy-sensitive (it reveals all addresses in that account) even though it is not, by itself, key material.

### 2.4 Secure storage on mobile

The mnemonic and seed exist in exactly two places: encrypted at rest in platform secure storage, and transiently in memory during derivation or signing (memory rules in section 5.5). The invariant, restated because it is the product: **the seed never leaves the device.** There is no cloud sync of key material, no server-side backup, and no telemetry that could carry it. Anything that would transmit the seed off-device is a design violation, not a configuration option.

**iOS.** The encrypted seed is stored in the Keychain with accessibility class `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` — the item never migrates to a new device via backup or transfer, and is unavailable while the device is locked. The Secure Enclave cannot store our seed directly (it manages only its own P-256 keys and never releases private material), so we use envelope encryption: a P-256 key generated inside the Secure Enclave wraps the symmetric key (AES-256-GCM) that encrypts the seed. The Secure Enclave key is created with an access-control flag requiring user presence (`biometryCurrentSet`), so every unwrap demands Face ID / Touch ID, and enrolling a new biometric invalidates the key.

**Android.** The same envelope pattern with the Android Keystore: a hardware-backed AES key encrypts the seed blob. Where the device offers StrongBox (a discrete secure element), the key is created with StrongBox backing; otherwise it falls back to the TEE-backed Keystore. The key is configured to require user authentication (BiometricPrompt, with device-credential fallback per product policy) and with `setInvalidatedByBiometricEnrollment(true)` so new biometric enrollments invalidate it.

**Biometric gating policy.** Biometrics gate the *decryption key*, not merely the UI — a bypassed lock screen or hidden view does not expose the seed, because the seed blob is undecryptable without a hardware-verified biometric event. Signing operations that need a derived key trigger the same gate. The app additionally supports a wallet-level passcode as defense in depth on devices without biometrics.

**Backup.** Backup is the BIP-39 phrase itself, shown once at onboarding (and on explicit re-reveal behind a fresh biometric prompt) for the user to record offline. Screenshots are blocked on the reveal screens (`FLAG_SECURE` on Android; screen-capture detection on iOS). Any future encrypted-cloud-backup feature must encrypt with a key derived from a user secret on-device, so the ciphertext alone is useless to the storage provider — but no such feature exists in the current design.

---

## 3. Account Abstraction design

Account Abstraction is the product differentiator: smart contract accounts on EVM chains, with gas sponsorship, batching, session keys, and on-chain recovery. The design goal is that AA feels native while never compromising the two invariants — in particular, the single seed phrase must recover smart accounts exactly as it recovers plain keys.

### 3.1 Counterfactual smart accounts from the seed (decision D4)

An ERC-4337 smart account is a contract, and contracts are not derived from seeds. The bridge is deterministic deployment:

1. The **owner EOA key** derives from the seed at the standard Ethereum path (`m/44'/60'/0'/0/x`). This key is never used as a transaction sender for the smart account; it is the account's *signer/owner*.
2. A fixed, audited **account factory contract** deploys account instances via `CREATE2`. Under `CREATE2`, the deployed address is a pure function of `(factory address, salt, init code hash)` — it does not depend on who sends the deployment or when.
3. The **salt** is deterministic: the wallet uses the account index (0, 1, 2, …). The init code embeds the owner EOA address.

Therefore the smart account address is a pure function of *(seed, derivation index, factory address, account implementation)*. The wallet can compute it — and display it, and receive funds at it — before the contract exists on-chain. This is a **counterfactual** account. The contract is deployed lazily: the first UserOperation from the account carries the factory call (the `factory`/`factoryData` fields of the UserOperation), and the EntryPoint deploys the account and executes the operation in one atomic step. Gas for that deployment can itself be sponsored by a paymaster, so a brand-new user can transact with zero ETH.

**Recovery consequence (this is the crux):** a user who restores from their seed phrase on a new device re-derives the same owner EOA, and the wallet recomputes the same `CREATE2` inputs, producing the same smart account address — whether or not the account was ever deployed. One seed phrase recovers plain EOAs *and* smart accounts, satisfying decision D1 with no extra backup artifact. The wallet persists (and can rediscover from public chain data) the tuple `(factory, implementation, salt)` per account; these are public parameters, not secrets, so storing them in ordinary app storage or re-deriving them from the wallet's known defaults is safe.

Because the same factory can be deployed at the same address on every EVM chain (factories are themselves deployed via deterministic-deployment proxies), the user gets the **same smart account address on every EVM chain**, matching the cross-chain address expectation users have from EOAs.

**Version pinning caveat:** the counterfactual address is only stable if the factory address and init code hash are stable. Upgrading to a new account implementation or factory changes the computed address for *not-yet-deployed* accounts. The wallet therefore records which `(factory, implementation)` pair each account was created under, and recovery must check known historical pairs when rediscovering accounts. New account versions apply to newly created accounts; existing accounts upgrade through their own upgrade mechanism (section 3.5), never by silently recomputing addresses.

### 3.2 UserOperation lifecycle

ERC-4337 moves the transaction lifecycle off the protocol's native transaction pool and into an account-level object called a **UserOperation**, executed through a singleton **EntryPoint** contract. The flow through our stack:

```
User intent (e.g. "send 50 USDC", or a batch)
   │
   ▼ 1. BUILD  (wallet engine / EVM adapter)
UserOperation draft:
  sender            = smart account address (counterfactual or deployed)
  nonce             = read from EntryPoint (2D nonce: key ‖ sequence)
  factory/factoryData = present only if account not yet deployed
  callData          = account.execute(target, value, data) or executeBatch(...)
  gas fields        = callGasLimit, verificationGasLimit, preVerificationGas,
                      maxFeePerGas, maxPriorityFeePerGas
   │
   ▼ 2. ESTIMATE & SPONSOR
  eth_estimateUserOperationGas → gas limits (bundler RPC)
  optional paymaster flow (section 3.3) → paymaster fields
   │
   ▼ 3. SIGN  (keyring, on-device, biometric-gated)
  signature over the userOpHash (which binds the EntryPoint address
  and chain id, preventing cross-chain/cross-EntryPoint replay)
   │
   ▼ 4. SUBMIT
  eth_sendUserOperation → bundler
   │        bundler validates, includes op in a bundle,
   │        submits bundle as a real tx to EntryPoint.handleOps()
   ▼
  EntryPoint: deploys account if needed → validates signature via
  account.validateUserOp() → validates/charges paymaster → executes callData
   │
   ▼ 5. TRACK
  eth_getUserOperationReceipt / eth_getUserOperationByHash (bundler RPC),
  plus normal log monitoring once the containing tx lands
```

Design rules the engine enforces:

- **Simulation before signature.** Every UserOperation is simulated (gas estimation plus a dry-run of the call) and the decoded effects are shown to the user before the signing prompt. Signing is the last step, never the first.
- **The signature binds everything.** The `userOpHash` covers all fields including paymaster data, the chain id, and the EntryPoint address, so a bundler or paymaster cannot mutate a signed operation.
- **EntryPoint is pinned.** The wallet targets a specific audited EntryPoint version per chain (v0.7-era interface as the baseline; the field layout above follows it). EntryPoint upgrades are a deliberate, reviewed migration — new versions change the UserOperation encoding and must never be adopted implicitly. Version differences are absorbed inside the EVM adapter so the engine-level model stays stable.

### 3.3 Paymasters: sponsored and ERC-20 gas

A **paymaster** is a contract that pays gas on behalf of the account, enabling two headline features:

- **Sponsored transactions.** A dApp, the wallet vendor, or a promotion covers gas. Flow: after building the draft op, the engine calls a paymaster service's API, which returns the paymaster address and `paymasterData` (typically containing a signature from the sponsor authorizing this specific op, with an expiry). The user signs the complete op; the EntryPoint debits the paymaster's stake instead of the account.
- **ERC-20 gas.** The user pays gas in USDC or another token. The paymaster fronts the native gas and the account reimburses it in tokens during execution (via a pre-approved allowance or a permit bundled into the same op — batching makes the approve+pay atomic). The engine must display the effective token price of gas, sourced from the paymaster's quote, and enforce a user-visible maximum.

Rules: a paymaster only ever *adds fields to* an op; it never sees or influences key material, and a paymaster failure (service down, quote expired, sponsorship refused) degrades gracefully to self-paid gas with a clear UI state. Paymaster contracts hold no user funds in our design; the ERC-20 flow debits per-operation.

### 3.4 Session keys, batching, social recovery

**Batching.** The account's `executeBatch` turns multi-step flows (approve → swap; pay-gas-in-token → transfer) into one atomic UserOperation: one signature, one confirmation, no stranded intermediate state. The engine models a transaction as a list of calls from day one, so batching is the default shape, not a special case.

**Session keys.** A session key is a scoped, ephemeral signer installed on the smart account as a validation module: the user authorizes, with one biometric-gated signature, a policy such as "this key may call this game contract, spending at most X per day, until this expiry." The session key itself is a fresh key generated on-device (not seed-derived — it is disposable by design, and must not be recoverable after revocation), stored under the same hardware-backed encryption, and used to sign subsequent ops without user interaction. Scope enforcement happens **on-chain in the validation module**, not merely in wallet UI, so a leaked session key is bounded by its policy. Revocation is an on-chain module call; keys also expire automatically.

**Social recovery.** Because the account is a contract, recovery can be programmable: the user designates guardians (other wallets, hardware keys, institutional co-signers, or a second device), and a recovery module allows a guardian quorum to rotate the account's owner key after a mandatory time delay, during which the current owner can veto. This complements, not replaces, the seed phrase: the seed remains the universal backup (D1); social recovery covers the case where the seed itself is lost, for the smart-account portion of the portfolio. UTXO and Solana assets have no equivalent on-chain mechanism, and the UI must never imply otherwise.

### 3.5 Modular accounts: ERC-7579

Rather than a monolithic account contract, the wallet targets **ERC-7579** (minimal modular smart accounts), which standardizes how accounts install and execute **modules** of four kinds: validators (signature/policy checks — the owner-key validator, session-key validators, passkey/WebAuthn validators), executors (contracts that may initiate actions from the account, e.g. automated strategies), hooks (pre/post-execution checks like spending limits), and fallback handlers. The payoffs:

- Session keys, social recovery, spending limits, and passkey signing are *modules we install*, not features we fork the account contract to obtain.
- Modules are portable across ERC-7579-compliant account implementations, so we are not locked into one account vendor (flexibility invariant). The engine treats "account implementation" as a pluggable choice behind a `SmartAccountProvider` interface in the EVM adapter.
- Account upgrades become module installs/uninstalls (each requiring an owner-signed, user-confirmed operation) instead of proxy-implementation swaps in the common case.

Module trust policy: only modules from an allowlist shipped with the wallet (audited implementations) can be installed through our UI; installing an arbitrary module address is a developer-mode action with explicit warnings, because a malicious validator module is equivalent to key theft for that account.

### 3.6 EIP-7702: AA for plain EOAs

EIP-7702 (live on Ethereum mainnet since the Pectra upgrade) lets an **EOA** attach a signed authorization to have code — a delegate contract — execute at its address. This is the AA path for users and chains where a separate smart-account address is undesirable:

- The user's existing seed-derived EOA (`m/44'/60'/0'/0/x`) *becomes* smart: same address, same history, now with batching, sponsorship, and session keys, by delegating to an audited ERC-7579-compatible delegate contract.
- ERC-4337 EntryPoint versions with 7702 support treat such delegated EOAs as valid senders, so one UserOperation pipeline (section 3.2) serves both real smart accounts and 7702-delegated EOAs; the difference is confined to the sender-preparation step in the EVM adapter.

The engine therefore models "account" as one of three EVM account kinds behind a common interface: plain EOA (legacy signing only), 7702-delegated EOA, and ERC-4337 smart account. Which kinds are available per chain is a chain-capability flag in the adapter, because 7702 and 4337 infrastructure roll out unevenly across EVM chains. The 7702 authorization signature is a distinct, clearly explained user action: it is powerful (it points the account's code at a contract) and the wallet only ever signs authorizations for its own allowlisted delegate contracts.

### 3.7 External infrastructure: what AA requires off-device, and how it stays pluggable (decision D5)

Be explicit about dependencies, because AA — unlike plain transactions — does not work with a bare chain RPC alone:

| Function | Infrastructure | Required? | Failure mode |
|---|---|---|---|
| Submit UserOperations | **Bundler RPC** (`eth_sendUserOperation`, `eth_estimateUserOperationGas`, `eth_getUserOperationReceipt`, …) | Yes, for any 4337 flow | No smart-account ops; wallet falls back to EOA/7702 direct transactions where possible |
| Sponsored / ERC-20 gas | **Paymaster service** (off-chain API + on-chain paymaster contract) | Only for sponsorship features | Ops proceed self-paid; feature-flagged off |
| Balances, token lists, history | Indexer / explorer APIs | For UX quality (chain RPC alone is insufficient for history) | Degraded history view; balances still available via RPC |
| Everything | Chain RPC nodes | Yes | Chain is offline in the wallet |

Vendor neutrality is enforced structurally, not aspirationally:

- The engine defines `BundlerClient` and `PaymasterClient` interfaces whose surface is exactly the standardized ERC-4337 RPC methods plus a minimal quote/sponsor call. Vendor SDKs are never imported into core or adapters; a vendor is a *configuration entry* (URL + optional API key), not a code dependency.
- Multiple providers per chain are configured with ordered failover, and the user (or a future enterprise deployment) can override endpoints entirely, including self-hosted bundlers.
- Nothing any provider returns is trusted blindly: gas quotes are sanity-checked against chain data, paymaster data is covered by the user's signature, and receipts are verified against the chain once the bundle lands (see section 5.3 on compromised RPC).

The same neutrality applies on-chain: factory, account implementation, and modules are audited public contracts chosen by us, deployable by anyone, with no vendor-proprietary contract in the critical path.

---

## 4. Chain adapter interface (decision D3)

Every chain is a module implementing one interface. Core knows the interface; it never knows a chain.

### 4.1 The `ChainAdapter` contract

The shape (illustrative TypeScript; the source of truth is `packages/core`):

```ts
interface ChainAdapter {
  /** Identity */
  readonly caip2: string;            // e.g. "eip155:1", "bip122:000000000019d6689c085ae165831e93",
                                     //      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
  readonly slip44: number;           // 0 (BTC), 3 (DOGE), 60 (ETH), 501 (SOL)
  readonly curve: 'secp256k1' | 'ed25519';
  readonly defaultDerivationPath: (accountIndex: number) => string;

  /** Keys & addresses (pure; no I/O) */
  deriveAddress(publicKey: Uint8Array, opts?: AddressOptions): string;
  validateAddress(address: string): boolean;

  /** Transactions */
  buildTransaction(intent: TransferIntent | ContractIntent, ctx: ChainContext): Promise<UnsignedTx>;
  estimateFee(tx: UnsignedTx, ctx: ChainContext): Promise<FeeEstimate>;   // fee tiers + total in native units
  signTransaction(tx: UnsignedTx, signer: Signer): Promise<SignedTx>;     // signer callback; adapter never sees raw keys
  broadcast(tx: SignedTx, ctx: ChainContext): Promise<TxId>;

  /** State */
  getBalance(address: string, asset: Caip19AssetId, ctx: ChainContext): Promise<Balance>;
  getHistory(address: string, ctx: ChainContext, cursor?: Cursor): Promise<Page<TxSummary>>;
  getTransactionStatus(txId: TxId, ctx: ChainContext): Promise<TxStatus>;

  /** Capabilities — what this chain supports, so UI/engine adapt without chain-specific code */
  readonly capabilities: ChainCapabilities;  // { smartAccounts?, eip7702?, tokens?, staking?, memo?, feeBumping?, … }
}
```

Design rules baked into the interface:

- **Signing is inverted.** Adapters receive a `Signer` — an opaque callback the keyring controls — and hand it a digest or signing payload. Private keys are never passed into adapter code. This keeps the secret-handling surface confined to the keyring (section 5.5) and means a future MPC or hardware signer slots in without adapter changes (section 6).
- **Network access is injected.** `ChainContext` carries the RPC transport(s) for that chain. Adapters own protocol logic (how to encode a Bitcoin transaction), never endpoint configuration (which node to call). This is what makes RPC failover, user-supplied nodes, and test mocking uniform across all chains.
- **Capabilities, not instanceof.** The engine and UI branch on declared capability flags. `chains-evm` declares `smartAccounts` and `eip7702` and additionally implements the `SmartAccountProvider` extension interface consumed by the AA engine; UTXO chains simply do not, and no core code special-cases "if EVM".
- **Shared bases are an implementation detail.** Bitcoin and Dogecoin extend a common UTXO base class (coin selection, PSBT-style building, fee-rate estimation) differing only in network parameters (address version bytes, coin type 3 vs 0, fee norms). The registry, and core, see two independent adapters.

### 4.2 The registry and CAIP identifiers

The registry maps identifiers to adapter instances:

- **CAIP-2** identifies a *chain*: `eip155:1` (Ethereum mainnet), `eip155:8453` (Base), `bip122:…` (Bitcoin genesis-hash namespace), `solana:…`. This is the registry's primary key, and it is what WalletConnect and dApp sessions speak natively.
- **CAIP-19** identifies an *asset* on a chain: `eip155:1/erc20:0xA0b8…` (USDC on Ethereum), `eip155:1/slip44:60` (native ETH). The asset registry keys balances, token metadata, and price lookups by CAIP-19, which is what lets "thousands of assets" remain unambiguous across chains — the same ERC-20 symbol on two chains is two distinct CAIP-19 ids, and asset support on an EVM chain is *data* (a registry entry), not code.
- **SLIP-44** coin types drive derivation only. Note the deliberate asymmetry: hundreds of EVM chains share SLIP-44 coin type 60 (one key namespace) while having distinct CAIP-2 ids (many networks).

Adding chain number 3,001 without touching core: implement `ChainAdapter` in a new package (or reuse the EVM or UTXO base with new parameters — for most chains this is configuration plus a test suite), register it under its CAIP-2 id at startup, add its assets as CAIP-19 registry data. Core, the keyring, the transaction pipeline, and the app shell are untouched; the UI picks up the new chain from the registry and its capability flags. For the long tail of EVM networks specifically, "adding a chain" collapses to a pure data entry: chain id, RPC endpoints, native-currency metadata, and capability flags on the existing `chains-evm` adapter.

---

## 5. Security model and threat analysis

Assets at stake are irreversibly transferable; the security model is stated in terms of concrete attacker positions. For each: what the attacker gets, and what stops them.

### 5.1 Attacker with the phone

**Stolen, locked device.** The seed blob is encrypted under a hardware-backed key (Secure Enclave / StrongBox or TEE Keystore) that requires user authentication to use and is non-exportable. File-system extraction yields ciphertext. Brute-forcing the device passcode is the OS's problem (hardware-rate-limited), not a wallet-specific weakness. **Cannot:** obtain the seed, sign anything. **Can:** see whatever the OS leaks on the lock screen — so wallet push notifications must never contain balances or addresses.

**Stolen, unlocked device (snatched while in use).** The wallet does not extend the OS session's trust to key operations: every signing and every seed reveal demands a *fresh* biometric or wallet-passcode event, because the decryption key is gated at the hardware level (section 2.4), not by an app-level "is unlocked" flag. **Cannot:** send funds or read the seed without passing biometrics. **Can:** view balances and history in an open session — a privacy loss, bounded by an app-level auto-lock timeout.

**Malware on the device / compromised OS.** Honest limit: a fully compromised OS on which the user keeps authorizing operations defeats any software wallet — the attacker sees what the user sees and can wait for legitimate biometric events. Mitigations reduce, not eliminate: hardware-gated keys mean malware cannot bulk-exfiltrate the seed without a biometric event; short key lifetimes in memory (5.5) shrink the scraping window; on-chain session-key scopes and (future) spending-limit hook modules bound what any single authorized operation can move. Users holding large balances should be steered toward smart-account policies (delays, guardians, limits) precisely because those survive device compromise.

### 5.2 Attacker with the backup (seed phrase)

**Can:** everything, eventually — the phrase *is* the wallet for every seed-derived asset on every chain (that is what D1 means). They re-derive all keys, including smart-account owner keys, and recompute counterfactual addresses.
**Cannot, immediately:** drain a smart account protected by a recovery-delay or spending-limit module without tripping the delay — the legitimate user's window to veto with their guardians. This asymmetry is a genuine AA advantage and a reason to promote policy modules for large holdings.
**Mitigations:** the optional BIP-39 passphrase (a phrase-plus-passphrase attacker model requires both factors); UI treatment of the phrase as radioactive (one-time reveal, no clipboard, no screenshots, never in any export or log). The wallet must be honest in UX: for plain EOAs and UTXO/Solana assets, phrase compromise is total compromise.

### 5.3 Malicious dApp

Position: a WalletConnect- or in-app-browser-connected dApp that can *request* things. The wallet's job is to make every request inert until a human approves an accurate description of it.

**Cannot:** touch keys, sign anything silently, or bypass the per-operation approval. Session keys look like an exception but are not: their scope is enforced on-chain by the validator module, so even a dApp that obtained a session key it shouldn't have is bounded by the signed policy.
**Can attempt:** deceptive requests. The defenses, in order of importance:

1. **Simulation and decoding before every signature** (section 3.2): the confirmation screen shows decoded effects — recipient, amounts, token approvals with their true allowance (flagging unlimited approvals), and for smart accounts the full decoded batch — not raw calldata or an opaque hash.
2. **Typed-data discipline:** EIP-712 payloads are rendered field-by-field; signing raw untyped hashes for dApps is refused. Known-dangerous patterns (e.g. token `permit` signatures granting broad allowances) get explicit warnings.
3. **7702 authorizations and module installs are wallet-internal operations only** — never grantable to a dApp request, because each is equivalent to handing over the account (sections 3.5, 3.6).
4. **Origin binding:** every approval screen displays the requesting origin; per-origin permissions and revocation lists are user-inspectable.

Residual risk: a user who approves an accurately-described malicious transaction loses those funds. The wallet's obligation is that the description be accurate and legible; it cannot approve on the user's behalf, in either direction.

### 5.4 Compromised RPC / bundler / paymaster

Position: the attacker controls network infrastructure the wallet talks to. This is why the network layer is drawn below the trust boundary.

**Cannot:** steal keys (never transmitted); alter a signed transaction or UserOperation (any mutation invalidates the signature — the userOpHash binds all fields including paymaster data, chain id, and EntryPoint).
**Can:** lie about state (fake balances, fake fee levels, fake "confirmed" status), censor (drop transactions), and observe (link the user's addresses to their IP — a real privacy loss).
**Mitigations:**

- **Cross-checking:** balance and receipt data for material operations are verified against a second, independently configured provider; discrepancies surface to the user rather than being silently resolved.
- **Fee sanity bounds:** fee suggestions from any provider are clamped against protocol-derived data (e.g. recent base fees) so a malicious node cannot induce a 100× overpayment.
- **Censorship degrades loudly:** a submitted-but-never-included operation is surfaced with a resubmit-elsewhere path (failover providers, user-supplied endpoints), never shown as vaguely "pending" forever.
- **Address-integrity rule:** receive addresses and counterfactual smart-account addresses are always computed locally from local keys and local CREATE2 inputs — **never fetched from any network service** — so no RPC can substitute an attacker address at the moment of receiving.

### 5.5 Supply chain and memory hygiene

**Supply-chain policy.** All cryptography comes from the audited, zero-dependency `@noble`/`@scure` suite (`@scure/bip32`, `@scure/bip39`, `@noble/curves`, `@noble/hashes`). Hand-rolled primitives are prohibited absolutely — including "just a quick keccak" in a test. Beyond crypto: exact-version pinning with a committed lockfile and `npm ci` only; new dependencies and version bumps in key-adjacent packages require review of the diff, not just the changelog; the dependency count in `packages/core` is kept near zero on principle, because every core dependency is inside the secret-handling trust boundary. CI verifies published-package integrity against the lockfile.

**Memory hygiene.** Secrets in a garbage-collected runtime need explicit discipline, applied honestly:

- Secrets live only in `Uint8Array` buffers, never in JavaScript strings (strings are immutable, get interned/copied, and cannot be zeroed). The mnemonic is converted to bytes at the earliest moment and the UI layer treats the displayed words as a one-time render.
- Every secret buffer is zeroed (`fill(0)`) in a `finally` block the moment its use ends. The keyring's public API is structured so raw key bytes never escape it: adapters get a `Signer` callback (section 4.1), and derivation happens inside the keyring per-operation rather than keeping unlocked keys resident.
- Decrypted seed lifetime is one operation: unlock (biometric) → derive → sign → zero. There is no "unlocked wallet" state in which the seed sits decrypted in memory between operations.
- Stated limitation, not glossed over: JavaScript engines may copy buffers during GC compaction, and `fill(0)` cannot reach those copies; this is a known residual risk of the platform. It is mitigated by the short lifetimes above and by hardware gating (the persistent form of the seed is always ciphertext), and it is one motivation for keeping the option open to move the keyring's hot path into native code or an MPC scheme later (section 6) without touching the architecture around it.
- Logging/telemetry policy: no secret, address-cluster, or seed-adjacent value is ever loggable; log calls in key paths are lint-blocked.

---

## 6. Flexibility mechanisms

Requirement 4 is "no architectural lock-in." The concrete mechanisms, most of which have appeared above, collected in one place:

**Interface seams (the plugin boundaries).** Each seam is an interface in core with implementations registered at startup; swapping or adding an implementation touches no consumer:

| Seam | Interface | What can change behind it |
|---|---|---|
| Chains | `ChainAdapter` + registry | Any new chain, L2, or fork; thousands of EVM networks as pure data entries |
| Signing | `Signer` (keyring-controlled callback) | Seed-derived keys today; MPC/TSS shares, hardware wallets, passkey-backed signers later — adapters and engine unchanged |
| Smart accounts | `SmartAccountProvider` (EVM adapter extension) | Account implementation/factory vendors; ERC-7579 keeps modules portable across them |
| AA infrastructure | `BundlerClient`, `PaymasterClient` | Any vendor or self-hosted instance; standardized 4337 RPC surface, config-only switching |
| Network transport | `ChainContext` RPC injection | Provider failover, user-supplied nodes, proxies, mocks in tests |
| Account features | ERC-7579 modules (on-chain) | Session keys, recovery, spending limits, future policy types — installed, not forked |
| App features | Engine-level service modules | Swaps, staking, fiat on-ramp as packages depending on core, never the reverse |

**Feature flags.** A typed, engine-level flag service gates every feature that depends on external infrastructure (paymaster sponsorship, per-chain 7702 availability, swaps) or is in rollout. Flags default to safe/off, are evaluated locally (a remote flag service may *disable* features as a kill switch but never enable a code path that shipped dark and unreviewed), and every AA capability degrades cleanly when its flag is off — sponsorship off means self-paid gas, not a broken send flow.

**Worked examples.**

- *Staking later:* a `@shiba-wallet/staking` package consumes `ChainAdapter` capabilities (`staking` flag) and the transaction pipeline; per-chain staking specifics live in the respective adapters. Where staking intersects AA (e.g. batched delegate+stake, sponsored staking as an acquisition funnel, an executor module auto-compounding under an on-chain policy), those are a module install and a service package — zero core changes.
- *Swaps later:* a swap service package turns quotes from pluggable aggregator clients into ordinary `ContractIntent`s; on smart accounts, approve+swap is one batched UserOperation. The engine already models multi-call transactions, so nothing new is needed in core.
- *MPC later:* implement `Signer` backed by a threshold-signature scheme (device share + remote or second-device share). The keyring gains a second key-provenance type alongside seed-derived keys; adapters, AA engine, and UI are untouched because none of them ever saw raw keys (section 4.1). Note the product decision this would entail: pure-MPC keys are not BIP-39-recoverable, so MPC would ship as an *additional* account type, never a silent replacement for the seed-rooted model — D1 remains the default.

**The dependency rule that makes it hold:** dependencies point inward only. Feature packages depend on core; core depends on nothing but audited crypto. Adapters depend on core interfaces; core never imports an adapter. The app shell depends on the engine; the engine has no idea the app exists. Any proposed change that would reverse one of these arrows is, by definition, an architecture change requiring an ADR — that review gate is itself the lock-in defense.

---

## 7. Architecture Decision Records

Canonical ADRs live in `docs/DECISIONS.md`; this section restates them in full for self-containedness. Format: context, decision, consequences.

### D1 — Single BIP-39 seed roots all assets, including ERC-4337 owner keys

- **Context:** Non-custodial recovery (requirement 2) must cover every asset, and Account Abstraction (requirement 3) introduces accounts that are contracts, not keys. Multiple backup artifacts multiply user error and support burden.
- **Decision:** One BIP-39 mnemonic derives, via BIP-32/BIP-44/SLIP-0010 hardened paths, every key for every chain — including the owner EOA of each ERC-4337 smart account. Smart accounts are counterfactual `CREATE2` contracts whose addresses are recomputable from the seed-derived owner plus public parameters, so the single phrase recovers them too.
- **Consequences:** One phrase to back up and one to protect: seed compromise is total compromise (mitigated by the optional BIP-39 passphrase and by on-chain policy modules for smart accounts). Session keys and any future MPC keys are deliberately outside the seed tree and must be documented as such. Recovery must include smart-account rediscovery logic (known factory/implementation pairs).

### D2 — Core wallet engine is pure, UI-agnostic TypeScript

- **Context:** The first deliverable is a React Native app, but leadership requires maximum flexibility (requirement 4), including future form factors (browser extension, CLI, desktop) and testability without a device.
- **Decision:** `@shiba-wallet/core` contains no React, React Native, or platform-native dependencies. Platform concerns (secure storage, biometrics) are injected behind interfaces implemented by the app shell.
- **Consequences:** The engine runs and is fully testable in Node/CI; the same core can back any future client. Cost: platform capabilities must always be modeled as injected interfaces, and the app shell carries the native bridge code. GC-runtime memory-hygiene limits (section 5.5) are accepted, with a keyring-native-code escape hatch preserved.

### D3 — Chain support via `ChainAdapter` interface + registry keyed by SLIP-44 / CAIP-2

- **Context:** Requirement to support four launch chains and extend to thousands of assets without core rewrites.
- **Decision:** Every chain implements the `ChainAdapter` interface (derivation parameters, address handling, tx build/sign/broadcast, balance/history, fee estimation, capability flags) and registers under its CAIP-2 chain id; SLIP-44 coin types drive key derivation; assets are identified by CAIP-19.
- **Consequences:** New chains are packages (or, for EVM networks, data entries) registered at startup; core never changes. Chain-family code sharing (UTXO base, EVM base) is an adapter-internal concern. The interface is a stability contract: changing it is an ADR-level event.

### D4 — Smart accounts are counterfactual CREATE2 contracts with deterministic, index-based salts (new)

- **Context:** D1 requires seed-phrase recovery of smart accounts; users expect a receivable address before funding gas; users expect the same address across EVM chains.
- **Decision:** Smart account addresses derive as `CREATE2(factory, salt = accountIndex, initCode(ownerEOA))`, with the owner EOA at the standard `m/44'/60'/0'/0/x` path. Deployment is lazy, via the first UserOperation's factory fields. The wallet pins audited `(factory, implementation)` pairs per account version, uses cross-chain-deterministic factory deployments for address parity across EVM chains, and checks historical pairs during recovery.
- **Consequences:** Full recovery from the phrase alone; receive-before-deploy works; same address on every EVM chain. Cost: factory/implementation upgrades change addresses for not-yet-deployed accounts, so account-version bookkeeping is mandatory and address computation must never be delegated to a network service.

### D5 — Bundler and paymaster access behind vendor-neutral, standards-shaped interfaces (new)

- **Context:** ERC-4337 requires off-device infrastructure (bundler RPC, paymaster services); the AA vendor market is young and volatile; requirement 4 forbids lock-in; requirement 1 forbids any infrastructure seeing key material.
- **Decision:** Core defines `BundlerClient` and `PaymasterClient` interfaces covering exactly the standardized ERC-4337 RPC methods plus a minimal sponsorship/quote call. Vendors are configuration entries (endpoints), never code dependencies; multiple providers per chain with ordered failover; user-overridable endpoints; all provider responses sanity-checked and covered by the user's signature.
- **Consequences:** Switching or multi-homing AA vendors is a config change; self-hosted bundlers are supported by construction. Cost: we forgo vendor-SDK conveniences and any vendor feature not expressible via the standard surface until it standardizes; we own the failover and verification logic.

### D6 — Target ERC-7579 modular accounts; EIP-7702 as the EOA on-ramp; per-chain account-kind capability flags (new)

- **Context:** AA features (session keys, social recovery, spending limits, passkeys) can be built into a monolithic account contract or composed as standard modules; meanwhile many users and some chains are better served by upgrading EOAs in place (EIP-7702) than by a new smart-account address; 4337/7702 support varies by chain.
- **Decision:** The default account implementation is ERC-7579-compliant, with session keys, recovery, and policy features delivered as allowlisted, audited modules. The EVM adapter models three account kinds behind one interface — plain EOA, 7702-delegated EOA, ERC-4337 smart account — selected per chain via capability flags, all sharing the UserOperation pipeline where applicable. Module installs and 7702 authorizations are wallet-internal, user-confirmed operations, never grantable to dApps.
- **Consequences:** Features arrive as module installs, not account forks; module portability across 7579 accounts prevents account-vendor lock-in; existing EOA users get AA at their existing address. Cost: module allowlist governance becomes a security-critical process (a malicious validator module equals key theft), and the three-kind account model adds state the engine must track per account per chain.

### D7 — All cryptography from audited noble/scure libraries; secrets in zeroed byte buffers with per-operation lifetimes (new)

- **Context:** Requirement 1 makes key handling the highest-consequence code in the system; the JavaScript ecosystem's supply-chain and memory characteristics are known risks.
- **Decision:** All primitives come from `@scure/bip32`, `@scure/bip39`, `@noble/curves`, `@noble/hashes` (audited, zero-dependency); hand-rolled primitives are prohibited; exact lockfile pinning with reviewed bumps for key-adjacent packages; near-zero dependency budget in core. Secrets exist only as `Uint8Array`, zeroed in `finally` blocks, with unlock→derive→sign→zero per-operation lifetimes; raw keys never cross the keyring boundary (adapters receive a `Signer` callback); persistent seed form is always hardware-gated ciphertext (iOS Keychain + Secure Enclave envelope, Android Keystore/StrongBox, biometric-gated).
- **Consequences:** Small, auditable secret-handling surface; MPC/hardware signers can replace the signing backend without architectural change. Cost: GC-copy residual risk is accepted and documented (with a native-keyring escape hatch preserved); vendor SDK conveniences that would violate the dependency budget are refused.

### D8 — Multiple accounts: one index per account, mapped per chain family (new, phase 6)

- **Context:** Tier 1 feature 4 adds multiple accounts ("Account 1", "Account 2", …) under the single seed of D1. Each account needs one address per launch chain, derived from the seed and a small integer account index N (N = 0, 1, 2, …; "Account 1" is N = 0). The mapping is recovery-critical: once users hold funds on account N, changing it would make those funds invisible (though not lost) in the wallet. Two constraints drive it: (1) a user who imports the same phrase into another popular wallet should find the same addresses there, and vice versa; (2) the wallet's existing single-account addresses must not change.
- **Decision:** The mapping lives in exactly one function, `derivationArgsFor(chainId, N)` in `app/src/wallet/accounts.ts`, which every derivation in the app — display addresses and signing keys alike — goes through:

  | Chain | Account N path | `deriveAccount(seed, account, addressIndex)` | Convention |
  |---|---|---|---|
  | EVM (every eip155 chain) | `m/44'/60'/0'/0/N` | `(0, N)` — increments the address index | MetaMask: `eth-hd-keyring` derives `m/44'/60'/0'/0` then `deriveChild(i)` for account i (MetaMask/eth-hd-keyring `index.js`, checked 2026-09-28). Phantom's default ("bip44Change") EVM path is the same `m/44'/60'/0'/0/{index}` (help.phantom.com "What derivation paths does Phantom support?", checked 2026-09-28) |
  | Solana | `m/44'/501'/N'/0'` | `(N, ·)` — increments the hardened account level | Phantom's default Solana path `m/44'/501'/{index}'/0'` (same Phantom page) |
  | Bitcoin | `m/84'/0'/N'/0/0` | `(N, 0)` — increments the hardened account level | BIP-44 account semantics ("This level splits the key space into independent user identities"), BIP-84 path structure |
  | Dogecoin | `m/44'/3'/N'/0/0` | `(N, 0)` — increments the hardened account level | BIP-44 account semantics |

  The EVM row deliberately does not use `account = N`: that would yield the account-level layout `m/44'/60'/N'/0/0`, which a MetaMask import of the same phrase would never discover. N = 0 reproduces exactly the `(0, 0)` arguments the single-account wallet used, on all four chains, so existing users see byte-identical addresses and paths. Unknown chain families throw rather than inherit a default; adding a chain requires an explicit mapping decision here.

  ERC-4337 smart accounts (D4, section 3.1) follow the same index: account N's smart account is `factory.getAddress(owner = account N's EOA at m/44'/60'/0'/0/N, salt = N)`. Account 0 keeps salt 0 — the SimpleAccount spec's default that the app always used — so its counterfactual address is unchanged. Salt = N is not needed for uniqueness (the owner already differs per account); it is kept because D4 specifies the index-based salt and because recovery then needs no per-account salt bookkeeping.

  Account metadata (names, hidden flags, the active index and a never-decreasing next-index counter) is public configuration in AsyncStorage, not key material. Hiding an account never frees its index, so adding an account can never silently re-use a key that was previously in use under another name. WalletConnect sessions are bound to the EVM address they were approved with; while another account is active their requests are declined with a message naming the bound account, and signing (`WalletContext.signWith`) refuses unless the active account's key controls exactly the address an operation was prepared for.
- **Consequences:**
  - *Import round-trips.* EVM accounts round-trip with MetaMask and with Phantom's default EVM path; Solana accounts round-trip with Phantom's default Solana path. Bitcoin does **not** round-trip with Phantom beyond account 1: Phantom's default Bitcoin SegWit path puts its index at the address level (`m/84'/0'/0'/0/{index}`), whereas this wallet uses the BIP-44 account level (`m/84'/0'/N'/0/0`). Account 1 (N = 0) is identical in both. Wallets that follow BIP-44 account semantics for Bitcoin will match; those that increment the address index will not. This is recorded as a known divergence, not an accident.
  - *Shared EVM subtree (documented trade-off).* All EVM accounts are non-hardened siblings under `m/44'/60'/0'/0`, so they are not isolated from each other in the section 2.3 sense: anyone holding the extended public key of `m/44'/60'/0'` (or `…/0'/0`) plus any one EVM account's private key could reconstruct every EVM account's private key. This is acceptable because the wallet never exports extended public keys (section 2.3 allows exports only at or below a hardened account level, and the app has no xpub export at all), and it is the price of MetaMask compatibility. It must be revisited before any EVM xpub export (watch-only, indexer onboarding) is ever added. Solana, Bitcoin and Dogecoin accounts are separated at a hardened level and keep the full compartmentalization of section 2.3.
  - *Recovery.* A restored phrase starts with Account 1 only; the user re-adds accounts in order and gets the same addresses back, because indices are handed out sequentially. There is no automatic account discovery yet. BIP-44 says software "should prevent a creation of an account if a previous account does not have a transaction history"; the wallet does not enforce that rule (it would require network lookups at creation time), so gap-based discovery by other wallets may not find an account created after an unused one. Automatic discovery on import is future work.
  - *Launch cost.* The public addresses of every account are derived at launch (one seed stretch, four derivations per account); the account count is capped at 50 for that reason.

---

*End of document. Corrections and challenges to any section are welcome — file them as issues referencing the ADR numbers above, and record accepted changes in `docs/DECISIONS.md`.*
