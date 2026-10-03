# Feature Universe: The Complete Map of Possible Features

**Audience:** Lead Chairperson and executive board
**Purpose:** An exhaustive map of every feature this wallet could plausibly build, organized into themed categories so that leadership can compare investment opportunities on a common footing. Each feature carries a short description, the user value, its relationship to Account Abstraction, a rough build-complexity rating, and its prerequisites. A prioritization section closes the document.
**Status:** Strategy input. Nothing here is committed; everything here is possible.

---

## 1. Hard Constraints (Read First)

Three constraints bound every feature in this document. They are not preferences; they are the product's identity.

1. **Strictly non-custodial.** The user, and only the user, ever holds the keys that control funds. No employee, server, or partner of ours can move a user's assets. Any feature on the market that normally requires custody (for example, most crypto debit cards or interest accounts) is either out of scope or must be redesigned so that keys never leave the user's control. Every feature below has been checked against this constraint, and where a redesign is needed it is stated explicitly.

2. **Single seed phrase recovery is mandatory.** Every asset on every chain must be recoverable from one BIP-39 seed phrase (the industry-standard list of 12 or 24 English words that encodes a master secret). Keys for each asset are derived from that seed using BIP-32 hardened derivation (a one-way mathematical procedure that generates unlimited child keys from one parent, such that a compromise of a child never exposes the parent) with per-asset paths following BIP-44 and the SLIP-44 coin-type registry. Advanced signing schemes (passkeys, MPC, guardians) may be *added on top of* this foundation, but no feature may ever replace it or create funds that the seed phrase cannot recover.

3. **The architecture must never lock out future features.** Chain support is delivered through a chain-adapter plugin system; smart-account logic is delivered through modular account standards (ERC-6900 / ERC-7579, described below). Decisions that would foreclose a category in this document — for example, a key-storage design that could not later support passkey signers — are architectural defects even if the immediate feature works.

**A one-paragraph primer on the differentiator.** Account Abstraction (AA) is the umbrella term for making a blockchain account programmable. On Ethereum and compatible chains, ordinary accounts (called EOAs, "externally owned accounts") can only do one thing: sign a transaction with one fixed private key and pay the fee themselves in the chain's native coin. **ERC-4337** is the standard that enables *smart accounts* — accounts that are programs, so rules like "a third party pays my fees," "these two actions happen together or not at all," "this app may spend up to $20 without asking me again," and "my family can recover this account if I lose my phone" become account features rather than impossibilities. **EIP-7702**, activated on Ethereum in 2025, lets an ordinary EOA temporarily or persistently adopt smart-account code, bringing these powers to the account type everyone already has. Our thesis is that AA is not one feature; it is a multiplier that upgrades half the features in this document. Each entry's "AA relationship" line makes that multiplier visible.

Throughout, complexity ratings are **Low** (weeks, one team), **Medium** (a quarter, one team plus integration work), and **High** (multiple quarters, dedicated team, security review, or significant protocol/infrastructure work). They estimate build-and-harden cost, not ongoing operations.

---

## 2. Core Wallet & Key Management

This category is the non-negotiable foundation. None of it differentiates us; all of it must be excellent, because a wallet that loses keys or signs the wrong thing has no second chance.

**1. Seed generation and first-run onboarding (BIP-39).**
Generate a cryptographically random seed phrase on-device, never transmitting it anywhere, and walk a first-time user through understanding and recording it. This is the moment users decide whether the product feels trustworthy. *AA relationship:* the seed is the root authority even for smart accounts — every AA signer we ever add derives its legitimacy from, or is recoverable by, this seed, per Constraint 2. *Complexity:* Low (the cryptography is standard; the UX care is the work). *Prerequisites:* none — this is the root of the dependency tree.

**2. Seed and wallet import.**
Restore from an existing BIP-39 phrase, including phrases created by other wallets (MetaMask, Trust Wallet, Phantom), with automatic discovery of previously used accounts across chains. Switching cost is the main barrier to adoption; import quality directly sets our acquisition ceiling. *AA relationship:* imported EOAs are prime candidates for EIP-7702 upgrade prompts ("your existing address can now do more"). *Complexity:* Medium (account-discovery scanning across many chains and derivation paths is fiddly). *Prerequisites:* 1, 3.

**3. HD derivation engine (BIP-32, BIP-44, SLIP-44, SLIP-0010).**
The shared library that derives per-chain keys from the master seed: secp256k1 keys for Bitcoin, Dogecoin, and EVM chains, and ed25519 keys (via SLIP-0010) for Solana, each at its registered SLIP-44 coin type (Bitcoin 0, Dogecoin 3, Ethereum 60, Solana 501). Users never see this, but every other feature stands on it. *AA relationship:* smart accounts are deployed and controlled by derived keys, so the counterfactual address of a user's smart account is itself recoverable from the seed. *Complexity:* Medium (well-specified, but zero-defect territory demanding audits and cross-implementation test vectors). *Prerequisites:* 1.

**4. Multi-account management.**
Multiple accounts under one seed (via the BIP-44 account index), with names, colors, and per-account privacy — a "savings" account, a "spending" account, a "degen" account. Users compartmentalize risk this way, and power users demand it. *AA relationship:* accounts can mix types — an EOA here, a smart account there — and AA policies (feature 19) can differ per account, making compartmentalization meaningful rather than cosmetic. *Complexity:* Low. *Prerequisites:* 3.

**5. Secure on-device key storage (Secure Enclave / StrongBox).**
Store key material encrypted at rest, gated by the phone's hardware security module, with keys never entering application memory unencrypted longer than needed. This is the difference between "phone stolen" and "funds stolen." *AA relationship:* the same hardware can hold a device-bound passkey (feature 21) that serves as a smart-account signer, which is the bridge from "seed in a drawer" security to "face unlock" convenience. *Complexity:* Medium (platform APIs differ between iOS and Android; jailbreak/root detection and key attestation add depth). *Prerequisites:* 1.

**6. Per-chain transaction construction and signing.**
Build, sign, and broadcast valid transactions for each supported chain: UTXO selection for Bitcoin and Dogecoin, EVM transaction types, Solana's message format. Delivered as part of each chain adapter (feature 28) so new chains slot in without touching the core. *AA relationship:* on EVM chains, the adapter produces ERC-4337 "user operations" (the AA transaction format) as readily as legacy transactions — AA is a first-class output, not a bolt-on. *Complexity:* High in aggregate (each chain is Medium; correctness is existential). *Prerequisites:* 3, 5, 28.

**7. Message and typed-data signing (EIP-191, EIP-712, BIP-322).**
Sign off-chain messages — login challenges, DEX orders, governance votes — with EIP-712 structured data rendered as readable fields rather than an opaque hex blob, plus BIP-322 message signing for Bitcoin. Required by essentially every dApp; rendering it *legibly* is a top anti-phishing defense. *AA relationship:* smart accounts verify signatures via ERC-1271 (the standard letting a contract say "yes, this signature is mine"), which we must implement for smart-account users to log in anywhere. *Complexity:* Medium. *Prerequisites:* 5, 6.

**8. Fee management (EIP-1559, RBF/CPFP, priority fees).**
Estimate fees accurately per chain, offer speed tiers, and support acceleration and cancellation: EIP-1559 fee markets on EVM chains, replace-by-fee and child-pays-for-parent on Bitcoin, priority fees on Solana. Stuck and overpriced transactions are a leading source of support pain and distrust. *AA relationship:* AA is the endgame here — with paymasters (features 15–16), most users should stop seeing gas at all, and fee management becomes our infrastructure concern rather than the user's problem. *Complexity:* Medium. *Prerequisites:* 6.

**9. Receive experience: addresses, QR codes, and payment URIs (EIP-681, BIP-21).**
Show and share addresses with QR codes and standard payment URIs that can encode amount and asset. Receiving is half of all wallet activity and must be effortless and mistake-proof. *AA relationship:* a counterfactual smart account (feature 14) has a receivable address before it is deployed, so AA users can receive funds from day zero at no cost. *Complexity:* Low. *Prerequisites:* 4.

**10. Watch-only accounts.**
Add any public address — your hardware wallet, your DAO treasury, a whale you follow — and see its balances and activity with no keys present. Low-risk engagement for the curious and a genuine tool for anyone with cold storage. *AA relationship:* neutral, though watching well-known smart accounts (e.g., a Safe multisig treasury) exercises the same account-reading machinery. *Complexity:* Low. *Prerequisites:* 28, 84 (portfolio engine).

**11. Hardware wallet pairing (Ledger, and peers, via Bluetooth/NFC/QR).**
Use the mobile app as the interface while a hardware device holds the keys and confirms signatures. Serious holders will not use us without it; it also pairs naturally with watch-only. *AA relationship:* strong and underexploited — a hardware key can be one signer among several on a smart account (e.g., "hardware key required above $10,000, passkey suffices below"), a policy no EOA can express. *Complexity:* High (per-vendor transports and app protocols, physical-world debugging). *Prerequisites:* 5, 6.

**12. Single private-key import.**
Import a raw private key (for example, one exported from another tool) as a non-HD account, clearly labeled as outside seed-phrase recovery. Table stakes for migrating power users. *AA relationship:* such keys are ideal candidates for EIP-7702 upgrade or for rotation into a smart account whose recovery *is* seed-covered — a story we should actively market as "bring your risky key here and make it safe." *Complexity:* Low. *Prerequisites:* 4, 5. *Constraint note:* the UI must be honest that this one account is exempt from Constraint 2, since we cannot retrofit a foreign key into the HD tree.

---

## 3. Account Abstraction Superpowers

This is the differentiator category. Everything here is impossible or painful for a classic EOA wallet, and everything here compounds: session keys enable subscriptions, paymasters enable gasless onboarding, passkeys enable seedless *daily* UX (with the seed remaining the recovery root), and modularity ensures we can keep adding powers we have not imagined yet.

**13. ERC-4337 smart accounts.**
Deploy and operate smart-contract accounts as the wallet's flagship account type on EVM chains, built on an audited, modular account implementation rather than bespoke code. This is the platform on which features 14–27 stand. *AA relationship:* it *is* AA. *Complexity:* High (contract selection and audit posture, user-operation plumbing, signing flows, indexing). *Prerequisites:* 3, 5, 6, 27.

**14. Counterfactual deployment.**
A smart account's address is computable before any contract is deployed, so users get a funded, receivable address instantly and pay the one-time deployment cost only on first send — or never, if a paymaster sponsors it. Removes the single biggest historical objection to smart accounts ("I have to pay to create an account?"). *AA relationship:* unique to AA; EOAs never needed deployment, and this makes smart accounts match that. *Complexity:* Low–Medium (mostly correctness in address prediction and first-send flows). *Prerequisites:* 13.

**15. Gas sponsorship via verifying paymasters.**
A paymaster is an on-chain contract that pays a transaction's gas fee on the user's behalf under rules set by whoever funds it. We (or partner apps) sponsor gas for chosen actions: a user's first five transactions, any transaction into a partner protocol, promotional campaigns. The "you must buy ETH before you can do anything" wall is the worst moment in crypto onboarding, and this deletes it. *AA relationship:* uniquely possible with ERC-4337 (and with EIP-7702-upgraded EOAs); classic EOAs cannot have fees paid by a third party without awkward relayer schemes (the older ERC-2771 pattern required every target app's cooperation). *Complexity:* Medium (contracts are standard; the sponsorship-policy service, anti-abuse controls, and budget management are the real work). *Prerequisites:* 13, 27. *Constraint note:* sponsoring gas never touches user keys — fully non-custodial.

**16. Pay gas in any token (token paymasters).**
Users pay fees in USDC, the token they are sending, or any asset they actually hold, with the paymaster converting behind the scenes. "I have $500 of tokens but can't move them because I have no ETH" is one of the most common and most absurd user injuries in crypto. *AA relationship:* uniquely possible with AA. *Complexity:* Medium. *Prerequisites:* 13, 15, 44 (price feeds).

**17. Transaction batching (and ERC-5792 `wallet_sendCalls`).**
Execute several actions as one atomic unit — approve-and-swap in one tap, claim-and-restake, pay five people at once — exposed to dApps through the ERC-5792 request standard. Halves the taps, halves the fees, and eliminates the dangerous stranded state where an approval succeeded but the action that needed it failed. *AA relationship:* native to smart accounts and to EIP-7702 accounts; impossible atomically for classic EOAs. *Complexity:* Medium. *Prerequisites:* 13 (or 23), 49 (simulation, so users can preview the whole batch).

**18. Session keys.**
Grant an app or an in-wallet flow a temporary, scoped key: "this game may move only this token, at most 10 per day, until Friday, and nothing else." Approve once, then enjoy zero-popup interaction within the fence. This converts the sign-every-action treadmill into consent that behaves like a mobile app permission. *AA relationship:* uniquely possible with AA — an EOA's one key is all-or-nothing, so lending it to an app means lending everything. The emerging ERC-7715 permission-request standard is the dApp-facing interface to track. *Complexity:* High (policy engine, revocation UX, and security review; this is a headline feature and must be right). *Prerequisites:* 13, 22.

**19. Spending limits and programmable policies.**
Account-level rules enforced by the account itself on-chain: daily spend caps, allowlisted destinations, time locks on large withdrawals, "require my second device above $1,000." Banks trained users to expect card controls; crypto wallets have never been able to offer them. This is our clearest "safer than every EOA wallet, provably" claim. *AA relationship:* uniquely possible with AA; a policy enforced by the account contract cannot be bypassed even by malware that steals the daily-use key. *Complexity:* High. *Prerequisites:* 13, 22.

**20. Social recovery via guardians.**
The user designates guardians — family members' wallets, their own second device, a hardware key in a safe — who can *together*, after a waiting period, rotate the account's signing key if it is lost. No guardian, and no quorum below the threshold, can spend funds. Argent proved users love this. Fear of self-custody is the top reason mainstream users stay on exchanges; this is the answer. *AA relationship:* uniquely possible with AA — an EOA's key is unrotatable, so its loss is final. *Complexity:* High (contracts are known art; the human choreography — inviting guardians, recovery ceremonies, delay-period alerts — is the hard part). *Prerequisites:* 13, 22, 73 (contacts). *Constraint note:* coexists with, never replaces, seed recovery (Constraint 2); the seed remains a recovery path of last resort.

**21. Passkey and biometric signers (WebAuthn, secp256r1, RIP-7212).**
The phone's passkey — the same Face ID / fingerprint credential users already trust for banking apps — acts as a smart-account signer, verified on-chain via the secp256r1 curve (cheap on chains that adopted the RIP-7212 precompile, an optimization many L2s have shipped). Daily crypto use becomes "look at your phone," with the seed phrase demoted to a break-glass recovery artifact rather than a daily hazard. *AA relationship:* uniquely possible with AA — EOAs can only be controlled by a secp256k1 key, which passkeys cannot produce. *Complexity:* High (platform passkey APIs, on-chain verification across chains with and without the precompile, signer-lifecycle UX). *Prerequisites:* 5, 13, 22.

**22. Modular, upgradable accounts (ERC-6900 / ERC-7579).**
Build on the modular smart-account standards, under which an account is a core plus installable modules (validators like passkeys, executors like session keys, hooks like spend limits) that can be added, removed, and upgraded by the user. This is Constraint 3 rendered in solidity: users who join for gasless transactions can later install inheritance, policies, or signing schemes that do not exist yet — without migrating accounts. *AA relationship:* it is the architecture of AA; it also protects us from betting on the wrong module vendor, since the standards are cross-vendor. *Complexity:* High. *Prerequisites:* 13.

**23. EIP-7702 for existing EOAs.**
Let a user's *existing* address adopt smart-account code, gaining batching, sponsorship, session keys, and passkey signing without changing addresses or moving funds. Every MetaMask user's address becomes upgradeable in place — this is our conquest weapon, because "keep your address, gain superpowers" is the lowest-friction switching pitch in the industry. *AA relationship:* it is the second pillar of AA, extending features 15–19 and 21 to imported EOAs. *Complexity:* Medium–High (the delegation flow, security messaging, and per-chain availability differences; note that under 7702 the original private key remains authoritative, so key-loss recovery is weaker than a native smart account — the UI must say so honestly). *Prerequisites:* 2, 13, 22.

**24. Multi-signature accounts (m-of-n).**
Accounts requiring multiple approvals — 2-of-3 across the user's phone, laptop, and hardware key, or a small business requiring two officers. Safe built a multibillion-dollar niche on this on desktop; a genuinely good *mobile* multisig is rare. *AA relationship:* in a modular smart account this is just a validator configuration, not a separate product — a fact that itself demonstrates the platform's leverage. *Complexity:* Medium (given 22; the coordination UX for gathering co-signatures is the work). *Prerequisites:* 13, 22, 87 (push notifications).

**25. Automated and scheduled transactions.**
Standing instructions executed without the user present: send rent on the 1st, dollar-cost-average every Friday, auto-claim rewards. Executed by a keeper service that holds only a narrowly scoped session key — it can perform the scheduled action and nothing else, and the user can revoke it at any time. *AA relationship:* uniquely possible with AA in non-custodial form; every existing "recurring buy" in crypto is custodial, so this is a category we can own (see Constraint 1). *Complexity:* High (reliable keeper infrastructure with strict scope enforcement). *Prerequisites:* 18, 19.

**26. Parallel operations (2D nonces).**
ERC-4337 accounts support multiple independent transaction queues, so a stuck or pending action does not block unrelated ones — the "one stuck transaction jams everything behind it" failure familiar to every EOA user disappears. *AA relationship:* uniquely possible with AA. *Complexity:* Low (protocol support exists; the work is queue-aware UX). *Prerequisites:* 13.

**27. Bundler and AA infrastructure strategy.**
User operations reach the chain through *bundlers* (specialized relayers defined by ERC-4337). Decide build-versus-buy, integrate redundant providers behind our own abstraction layer, and monitor inclusion quality. Invisible when working; product-breaking when not. *AA relationship:* it is the load-bearing wall under every AA feature. *Complexity:* Medium to buy with redundancy, High to build. *Prerequisites:* none (but blocks 13, 15).

---

## 4. Multi-chain & Interoperability

**28. Chain-adapter plugin architecture.**
The internal framework where each chain is a self-contained adapter implementing a standard interface — derivation, addresses, balances, transaction building, broadcasting, history — with chains and assets identified by the CAIP standards (CAIP-2 for chains, CAIP-10 for accounts), which give every chain a canonical identifier so the core never hardcodes chain assumptions. This is how "extensible to thousands of assets" becomes an engineering routine instead of a rewrite, and it is Constraint 3 for the multi-chain half of the product. *AA relationship:* the EVM adapter treats ERC-4337 user operations as a native transaction type; non-EVM adapters remain unaffected, keeping AA complexity contained. *Complexity:* High (framework design quality here compounds for years). *Prerequisites:* 3.

**29. EVM networks and Layer 2s.**
Ethereum mainnet plus the major L2s (Arbitrum, Optimism, Base, Polygon, and peers) — L2s are where fees are low, AA infrastructure is most mature, and most new consumer activity lives. *AA relationship:* strongest on L2s: cheap gas makes sponsorship budgets go far, and several L2s ship the RIP-7212 precompile that makes passkey signing cheap. *Complexity:* Medium (one adapter, many configurations; per-chain quirks in fees and AA support). *Prerequisites:* 28.

**30. Bitcoin support (SegWit and Taproot; BIP-84/BIP-86 derivation).**
Full Bitcoin send/receive with modern address types and sound UTXO management. Bitcoin is half of crypto's market value and disproportionately what first-time users own. *AA relationship:* none on-chain (Bitcoin has no AA), but AA-side features can reference Bitcoin holdings in portfolio-wide policies, and swaps (34) bridge users between the worlds. *Complexity:* Medium. *Prerequisites:* 28.

**31. Solana support.**
SPL tokens, priority fees, and Solana's high-throughput consumer ecosystem, where much of retail activity (payments, NFTs, memecoins) now happens; Phantom's growth is the proof of demand. *AA relationship:* Solana has different native primitives (e.g., its fee-payer model allows a form of gas sponsorship, and durable nonces enable offline signing); our UX promises like "gasless" should be delivered per-chain through whatever native mechanism exists, keeping the *experience* consistent even where ERC-4337 does not apply. *Complexity:* Medium–High. *Prerequisites:* 28.

**32. Dogecoin support.**
Send/receive for Dogecoin (a Bitcoin-derived UTXO chain, SLIP-44 coin type 3). Modest engineering, meaningful audience: Dogecoin holders are numerous, underserved by quality wallets, and vocal. *AA relationship:* none on-chain; same portfolio-level integration as Bitcoin. *Complexity:* Low–Medium (reuses most of the Bitcoin adapter). *Prerequisites:* 28, 30.

**33. Custom network addition.**
Users add any EVM-compatible network by RPC details (with sanity checks against a known-chains registry to prevent malicious configurations). Long-tail chains appear weekly; this keeps us relevant without per-chain releases. *AA relationship:* the wallet should detect whether the added chain supports ERC-4337 infrastructure and degrade gracefully. *Complexity:* Low. *Prerequisites:* 28, 29.

**34. In-wallet swaps (DEX aggregation).**
Trade any asset for any other on the same chain via aggregated decentralized-exchange routing for best price, with clear fee disclosure. Swaps are the single largest revenue line for consumer wallets (MetaMask's swap fee is the proof), and the most-used feature after send/receive. *AA relationship:* dramatically better with AA — approve-and-swap becomes one atomic tap (17), gas can be paid from the asset being sold (16), and a sponsored first swap is a marketing weapon. *Complexity:* Medium (aggregator integration is straightforward; routing quality, slippage protection, and MEV-aware execution are the depth). *Prerequisites:* 6, 17 ideally, 44.

**35. Cross-chain bridging.**
Move assets between chains through vetted bridge providers, presented as a single "move my funds" flow rather than a protocol choice. Users hold assets on the wrong chain constantly; bridges are also historically crypto's biggest hack category, so curation and insurance-grade vetting are the feature. *AA relationship:* batching wraps multi-step bridge flows into fewer approvals; destination-side paymasters solve the classic "arrived on a new chain with no gas token" dead end — a uniquely AA fix to bridging's worst UX failure. *Complexity:* High. *Prerequisites:* 28, 29, 34.

**36. Cross-chain intents and chain abstraction (ERC-7683).**
The user states an outcome — "pay 50 USDC to this address on Base" — and solver networks compete to execute the route from whatever the user holds, wherever they hold it, per the ERC-7683 cross-chain intent standard. The endgame: users stop knowing or caring which chain they are on, and the wallet presents one unified balance. *AA relationship:* smart accounts are the natural intent-signing and settlement vehicle, and the same account address across chains (a smart-account property) makes "one balance" coherent. This is where our AA and multi-chain investments converge into a single defensible experience. *Complexity:* High (frontier territory; standards still maturing). *Prerequisites:* 13, 17, 34, 35.

---

## 5. Asset Coverage

**37. Token discovery and curated token lists.**
Automatically detect and correctly display the user's tokens across chains with vetted metadata (name, logo, decimals), so balances are complete and trustworthy without manual setup. *AA relationship:* neutral; feeds token paymasters (16) with the asset universe. *Complexity:* Medium (indexing infrastructure across many chains). *Prerequisites:* 28, 44.

**38. Custom token addition.**
Manually add any token by contract address for the long tail that lists miss. Table stakes for active traders. *AA relationship:* neutral. *Complexity:* Low. *Prerequisites:* 37.

**39. Spam and scam asset filtering.**
Hide airdropped junk and flag known-malicious tokens and NFTs by default, with a user override. Every active address accumulates scam tokens designed to lure clicks; a clean wallet is a safety feature wearing a tidiness costume. *AA relationship:* neutral. *Complexity:* Medium (ongoing curation, ideally with a reputation-data partner). *Prerequisites:* 37.

**40. NFT gallery (ERC-721, ERC-1155).**
Display NFTs (non-fungible tokens — unique on-chain items such as art, collectibles, game assets, and membership passes) beautifully across chains, with media handling and collection grouping. For a large user cohort, NFTs *are* their crypto identity. *AA relationship:* neutral for display; strong for actions (41). *Complexity:* Medium (media pipelines, metadata reliability). *Prerequisites:* 28, 37.

**41. NFT actions: send, sell, mint.**
Transfer NFTs, list them on marketplaces via integrated flows, and mint from verified drops inside the wallet. *AA relationship:* markedly better with AA — batch-transfer a whole collection in one transaction (17), and sponsored mints (15) let creators pay gas for their collectors, a pattern brands actively seek. *Complexity:* Medium. *Prerequisites:* 40, 17 ideally.

**42. Bitcoin-native assets (Ordinals, Runes).**
Support Bitcoin's inscription-based collectibles and fungible tokens, which require careful UTXO handling so a user never accidentally spends a valuable inscription as ordinary coin. A differentiator among multi-chain wallets, most of which handle these badly or not at all. *AA relationship:* none. *Complexity:* High (UTXO safety is unforgiving). *Prerequisites:* 30.

**43. Solana asset ecosystem (Token-2022, compressed NFTs).**
Support Solana's newer token standard (with its transfer-fee and metadata extensions) and compressed NFTs (a Solana technique that makes NFTs radically cheaper, hence extremely numerous). Required for Solana coverage to be credible rather than nominal. *AA relationship:* none. *Complexity:* Medium. *Prerequisites:* 31.

**44. Price and market data feeds.**
Reliable multi-source pricing for every displayed asset, powering fiat-denominated balances, swap quotes, token-paymaster conversion rates, and alerts. *AA relationship:* token paymasters (16) depend on it directly. *Complexity:* Medium (long-tail coverage and manipulation resistance are the hard parts). *Prerequisites:* none.

**45. Token-bound accounts (ERC-6551).**
Support NFTs that own their own accounts and assets (an ERC-6551 token-bound account makes an NFT into a container — a game character that owns its items, a membership that owns its history). Niche today; optionality for gaming partnerships. *AA relationship:* strong conceptually — these *are* smart accounts owned by NFTs, and our AA stack reads them natively. *Complexity:* Medium. *Prerequisites:* 13, 40.

---

## 6. Security & Recovery

**46. Seed backup UX and verification.**
A backup flow that maximizes the chance the seed is *actually* recoverable years later: quiz-style verification, periodic recovery drills, screenshot blocking during display, and printed steel-backup guidance. Most self-custody losses are backup failures, not hacks. *AA relationship:* AA reduces how often the seed is *needed* (passkeys for daily use, guardians for recovery), which paradoxically makes a rock-solid seed backup more important, not less — it becomes the rarely-touched root of everything. *Complexity:* Low–Medium. *Prerequisites:* 1.

**47. Encrypted cloud backup (user-key-encrypted).**
Optionally store the seed in the user's iCloud/Google Drive, encrypted on-device with a key derived from a user passphrase we never see, so the cloud provider holds ciphertext and we hold nothing. Recovers the "phone in a lake" scenario for users who will never manage paper. *AA relationship:* complements guardians (20) as a recovery lattice. *Complexity:* Medium (the cryptographic design and its audit are the substance). *Prerequisites:* 1, 46. *Constraint note:* non-custodial by construction — we can never decrypt; the UX must make the passphrase's unrecoverability brutally clear.

**48. Inheritance and dead-man switch.**
An AA module through which a designated heir can claim the account after a long inactivity period (say, 12 months), with every check-in resetting the clock and the owner able to cancel at any time. Today, crypto dies with its holder or gets entrusted to lawyers holding plaintext seeds; a non-custodial inheritance product has clear willingness-to-pay and almost no quality competition. *AA relationship:* uniquely possible with AA — an EOA cannot grant conditional future access without handing over the key outright. *Complexity:* High (contract logic is manageable; the legal-adjacent UX and abuse-resistance need care). *Prerequisites:* 13, 20, 22.

**49. Transaction simulation and pre-flight preview.**
Before any signature, execute the transaction against a fork of current chain state and show the outcome in plain language: "You send 1.0 ETH; you receive 3,412 USDC; this contract gains no ongoing permissions." Blind signing is the root cause of most drained wallets; this feature is the single highest-leverage security investment in the document. *AA relationship:* AA makes it more valuable — batches (17) and session grants (18) are exactly the things users most need previewed as net effects. *Complexity:* Medium–High (simulation infrastructure per chain; adversarial edge cases). *Prerequisites:* 6.

**50. Risk warnings and phishing protection.**
Screen destination addresses, contracts, and connected sites against threat intelligence; block known drainers outright; escalate warning severity with risk. Complements simulation (which shows *what happens*) by adding reputation (*who you're dealing with*). *AA relationship:* policy modules (19) can turn warnings into enforcement — "the account refuses transfers to flagged addresses unless a second signer approves," which no EOA wallet can offer. *Complexity:* Medium (feed integration and curation). *Prerequisites:* 49 ideally.

**51. Token approval management and revocation.**
Show every standing permission the user has granted to contracts (ERC-20 allowances, NFT operator approvals), with one-tap and batch revocation. Forgotten unlimited approvals are a leading drain vector; today users resort to third-party sites. *AA relationship:* batch-revoke ten approvals in one sponsored transaction (17 + 15) — a chore becomes a tap; and session keys (18) reduce future need for dangerous unlimited approvals at the source. *Complexity:* Medium. *Prerequisites:* 37, 17 ideally.

**52. App-level security: PIN, biometric lock, auto-lock, privacy screens.**
Local access control — biometric unlock, per-transaction confirmation thresholds, hiding balances in the app switcher, clipboard hygiene for addresses. The everyday armor. *AA relationship:* the biometric that unlocks the app can be the same passkey that signs (21), unifying "unlock" and "authorize" into one mental model. *Complexity:* Low–Medium. *Prerequisites:* 5.

**53. Duress and decoy wallet.**
A secondary PIN opens a plausible decoy wallet with small balances, protecting users under physical coercion ("$5 wrench attack"). Niche but existentially valued by high-net-worth and high-risk users, and cheap reputation insurance. *AA relationship:* time-locked policies (19) are the deeper defense — even a coerced user *cannot* move more than the daily limit, and the attacker can verify that, which removes the incentive to coerce. That framing (duress UX + on-chain limits) is unique to an AA wallet. *Complexity:* Medium. *Prerequisites:* 4, 52, 19 for the full story.

**54. Address-poisoning and misdirection defenses.**
Detect lookalike addresses seeded into the user's history by attackers, require confirmation of full addresses on first send, favor named contacts over raw hex, and verify pasted addresses against the clipboard source. A fast-growing theft vector with cheap, high-yield countermeasures. *AA relationship:* neutral mechanically; allowlist policies (19) provide the hard backstop. *Complexity:* Low. *Prerequisites:* 73.

**55. MPC as an optional future signer.**
Multi-party computation (MPC) splits a key into shares held by different parties — e.g., the user's phone and a co-signing service — such that no single party ever holds the whole key and both must participate to sign. Offered, if ever, strictly as one optional signer *within* a smart account, never as the account's root. *AA relationship:* modularity (22) is what makes MPC an add-on rather than an architecture bet; an MPC share can be one leg of a 2-of-3 alongside a passkey and the seed-derived key. *Complexity:* High. *Prerequisites:* 13, 22. *Constraint note:* deliberately deferred — guardians plus passkeys deliver most of MPC's user value with less operational dependency; Constraint 2 requires the seed-derived signer to always retain recovery power over the account, so MPC can never be the only path to funds.

**56. Audits, open source, and bug bounty.**
Publish core cryptographic and account code, commission recurring third-party audits, and run a public bounty program. Not a feature users tap, but the substrate of every trust claim in this document; for a non-custodial product, verifiability is the brand. *AA relationship:* smart-account and module code is exactly what must be most audited. *Complexity:* Medium (ongoing program, not a one-time task). *Prerequisites:* none.

---

## 7. DeFi & Earning

Earning features drive retention and deposits, and — flagged per the board's interest — this category intersects Account Abstraction unusually richly: AA turns staking from a product we *list* into flows nobody else can ship.

**57. Native staking (Solana and other proof-of-stake chains).**
Delegate stake to validators directly from the wallet, earning protocol yield while assets never leave the user's keys — natively non-custodial. Yield is a top-three retention driver; Phantom's built-in SOL staking is the model. *AA relationship:* on EVM chains, sponsored staking entry (15) and one-tap batched flows (17) apply; see 59–60 for the unique plays. *Complexity:* Medium per chain. *Prerequisites:* 28, 31.

**58. Ethereum liquid staking.**
Stake ETH via established liquid-staking protocols, receiving a liquid receipt token that keeps earning while remaining usable, with transparent disclosure of the protocol risk being taken. Solves the 32-ETH minimum and illiquidity of solo staking. *AA relationship:* the approve-stake sequence collapses to one atomic tap (17); the receipt token can pay gas via a token paymaster (16). *Complexity:* Medium. *Prerequisites:* 29, 34, 49.

**59. Sponsored staking flows.**
Zero-gas paths into staking: we or a staking partner sponsor the gas for stake, claim, and unstake actions (15), so a user's *first* earning experience costs nothing and takes one tap. New-user activation into the stickiest behavior in the product, at a sponsorship cost that partner protocols are often willing to fund themselves. *AA relationship:* uniquely possible with AA; this is precisely the intersection the board asked about. *Complexity:* Low–Medium on top of its prerequisites. *Prerequisites:* 15, 57/58.

**60. Gas paid from staking yield.**
The account's accruing yield funds a token paymaster that pays the user's gas everywhere — the wallet becomes self-fueling: "stake once, never think about gas again." No EOA wallet can ever copy this, and it converts yield from a number on a screen into felt, daily value. A signature marketing asset. *AA relationship:* uniquely possible with AA (16 + 18 + 25 composed); a scoped session key lets the keeper skim only accrued yield into the gas budget, nothing else. *Complexity:* High (a novel composition needing careful economic and security design). *Prerequisites:* 16, 18, 25, 57/58.

**61. Lending and borrowing.**
Supply assets to blue-chip lending protocols to earn, or borrow against holdings without selling, with health-factor monitoring and liquidation alerts. Deepens the "your money works here" story beyond staking. *AA relationship:* automated policies (25) can top up collateral or deleverage automatically when health decays — non-custodial automated liquidation protection, which is uniquely AA and genuinely rare. *Complexity:* High (risk surface demands conservative curation). *Prerequisites:* 34, 44, 49, 87.

**62. Yield vaults and aggregation (ERC-4626).**
Curated yield strategies exposed through the ERC-4626 tokenized-vault standard, presented with honest risk labels rather than APY bait. One integration standard, many strategies. *AA relationship:* batched enter/exit (17) and scheduled auto-compounding (25). *Complexity:* Medium–High (curation liability is the real cost). *Prerequisites:* 34, 44, 61 experience helpful.

**63. Dollar-cost averaging and recurring purchases.**
"Buy $50 of ETH every Friday," executed non-custodially: a scoped session key authorizes only that recurring swap (or on-ramp purchase), revocable anytime. The single most-requested passive-investing feature, and every incumbent implementation is custodial. *AA relationship:* uniquely possible non-custodially with AA (18 + 25); a direct consequence of Constraint 1 becoming an advantage. *Complexity:* Medium on top of prerequisites. *Prerequisites:* 18, 25, 34, 66 for fiat-funded DCA.

**64. Portfolio automation and rebalancing.**
User-defined standing strategies: maintain a 60/40 allocation, take profit above a threshold, stop-loss protection — all enforced by scoped session keys with hard policy fences (19). Brings a private-banking behavior to self-custody. *AA relationship:* uniquely possible non-custodially with AA. *Complexity:* High. *Prerequisites:* 18, 19, 25, 34, 84.

---

## 8. Payments & Real-World Use

**65. Fiat on-ramp.**
Buy crypto with a card, bank transfer, or Apple/Google Pay via integrated providers (MoonPay, Ramp, and peers), with smart routing across providers for best fees and approval odds by region. The front door for every new-to-crypto user. *AA relationship:* purchased funds can land in a counterfactual smart account (14) and the user's first actions ride sponsored gas (15) — fiat card to first on-chain action with zero friction, a flow incumbents cannot match end-to-end. *Complexity:* Medium (integration is easy; provider redundancy and regional coverage are the work). *Prerequisites:* 9, KYC is the provider's, not ours. *Constraint note:* the provider custodies fiat momentarily, never crypto keys — non-custody is preserved.

**66. Fiat off-ramp.**
Sell crypto to a bank account or card through the same provider network. "Can I get my money out?" is the trust question; answering it in-app closes the loop. *AA relationship:* batch swap-and-off-ramp into one action (17). *Complexity:* Medium. *Prerequisites:* 65.

**67. P2P payments and payment requests.**
Send to contacts by name with a chat-like activity thread, and *request* money (a signed payment request the payer taps to fulfill). Payments between people is the oldest killer app hypothesis in crypto; contact-based UX is what makes it feel like Venmo instead of wire-transfer roulette. *AA relationship:* sponsored transfers (15) mean a recipient with an empty new wallet can immediately send onward — solving P2P's cold-start problem — and stablecoin transfers with gas paid in the stablecoin (16) make "send $20, receive $20" literal. *Complexity:* Medium. *Prerequisites:* 73, 15–16 for the magic, 87.

**68. Payment links and QR invoices.**
Shareable links or QR codes encoding recipient, amount, asset, and memo (EIP-681 / BIP-21 based), payable by anyone from any wallet. The lightweight bridge from wallet to commerce, and the substrate for 70. *AA relationship:* a link can carry a sponsorship voucher so the *payer* pays no gas — merchants can eat fees to close sales, uniquely via AA. *Complexity:* Low–Medium. *Prerequisites:* 9, 67.

**69. Subscriptions and recurring payments via session keys.**
Authorize a merchant to pull a fixed amount on a schedule — 10 USDC monthly, capped, revocable in one tap from a subscriptions dashboard. Recurring revenue is the business model of the modern internet, and crypto has never supported it non-custodially; this is arguably the single most commercially novel feature in the document. *AA relationship:* uniquely possible with AA (18 + 19); an EOA cannot grant a bounded pull right at all. *Complexity:* High (merchant-side tooling and standards evangelism, not just wallet code). *Prerequisites:* 18, 19, 70 for merchant adoption.

**70. Merchant acceptance toolkit.**
A lightweight kit — payment links, QR stands, an order-status API or plugin — for small merchants to accept stablecoins straight to their own self-custody wallet, with optional instant conversion via swap. Builds the other side of our payments network; every merchant recruits their customers. *AA relationship:* merchant-sponsored gas (68) and subscriptions (69) are the differentiated pitch versus generic "pay with crypto" buttons. *Complexity:* High (a second product surface with its own users). *Prerequisites:* 68, 34, 66.

**71. Crypto debit card — redesigned non-custodial.**
Conventional crypto cards custody a balance; that is out of scope under Constraint 1. The compliant redesign: a card partner receives *just-in-time* funding, where each authorization triggers a session-key-scoped, capped transfer from the user's account at swipe time, so the user's balance stays in self-custody until the moment of spend. Spending crypto in the physical world is a perennial top request. *AA relationship:* uniquely possible non-custodially with AA — the JIT-funding pattern *is* a session key with a spending policy (18 + 19). *Complexity:* High (card-network partnership, regulatory perimeter, latency engineering). *Prerequisites:* 18, 19, 25; a partner bank/issuer.

**72. Offline, NFC, and tap-to-pay exploration.**
In-person transfer via NFC tap or QR with deferred broadcast, and pre-signed transactions usable in connectivity dead zones (Solana durable nonces are one enabling primitive). Horizon work: real-world payments credibility in emerging markets. *AA relationship:* session-key-signed offline vouchers with on-chain caps are the safe-offline design an EOA cannot bound. *Complexity:* High. *Prerequisites:* 67, 68; platform NFC access varies by OS.

---

## 9. Identity & Social

**73. Address book and contacts.**
Named, verified contacts with per-chain addresses, so users send to "Mom," never to `0x4f3a…`. The quiet foundation under P2P (67), guardians (20), and poisoning defenses (54); wrong-address loss is the most preventable loss category. *AA relationship:* guardians are chosen from contacts; policy allowlists (19) reference them. *Complexity:* Low. *Prerequisites:* none.

**74. Name-service resolution: ENS and peers.**
Resolve and register human-readable names — ENS (Ethereum Name Service, `alice.eth`) and counterparts on other ecosystems (Solana Name Service, Unstoppable Domains) — for sending, receiving, and profile identity. Names are becoming the default way addresses are exchanged socially. *AA relationship:* a name can point at the user's smart account, giving one stable public identity while signers rotate freely beneath it (21, 22) — identity decoupled from key material, an AA-flavored property. *Complexity:* Low–Medium. *Prerequisites:* 29, 73.

**75. Wallet handles and username-based receiving.**
Our own free, human-readable handle for every user (backed by an open standard rather than a proprietary silo), so two users can transact knowing only each other's handle. Removes the address as a concept for in-network payments. *AA relationship:* the handle maps to the smart account, same identity-stability benefit as 74. *Complexity:* Medium. *Prerequisites:* 73, 74.

**76. Sign-In with Ethereum (ERC-4361).**
Authenticate to apps and websites with the wallet via the SIWE standard — crypto's "Log in with Google," minus Google. Positions the wallet as an identity hub beyond money. *AA relationship:* requires our ERC-1271 contract-signature support (7) so smart-account users can log in everywhere; wallets that skip this break AA users' logins, and many do — a quality edge for us. *Complexity:* Low. *Prerequisites:* 7, 78/79.

**77. Attestations and portable reputation.**
Hold and present verifiable credentials — proof-of-humanity, community memberships, KYC-passed attestations issued by third parties — using on-chain attestation infrastructure, disclosed only when the user chooses. Optionality for the future where DeFi and communities gate on reputation. *AA relationship:* attestations attach to the persistent smart account, surviving signer rotation; modules (22) could even gate account features on them. *Complexity:* Medium–High. *Prerequisites:* 13, 76.

---

## 10. Developer & Ecosystem

**78. WalletConnect (v2).**
Connect to desktop and mobile dApps by QR or deep link via the ubiquitous WalletConnect protocol, with clear session management (what is connected, with what permissions, revocable in one tap). Without it, we are a vault; with it, the entire dApp world is our feature list. *AA relationship:* we must correctly represent smart accounts over the protocol (ERC-1271 signatures, ERC-5792 batched-call requests, session-key permission grants) — being the wallet that does AA-over-WalletConnect *right* is a real differentiator, since many dApps' wallet integrations still assume EOAs. *Complexity:* Medium. *Prerequisites:* 6, 7, 13.

**79. In-app dApp browser.**
A built-in web view with the wallet injected as the provider (per the EIP-1193 provider standard and EIP-6963 multi-wallet discovery), plus a curated discovery page of vetted dApps. Mobile-first users need a way to use dApps without a desktop; curation doubles as a safety layer (50). *AA relationship:* inside our own browser we control the whole flow, so batching, sponsorship, and session-key prompts appear natively and at their best — the showroom for AA. *Complexity:* Medium–High (provider correctness plus platform-policy care on iOS). *Prerequisites:* 6, 7, 13, 50.

**80. Deep links and mobile SDK for app developers.**
A URL scheme and a lightweight SDK letting native apps invoke connect/sign/pay flows in our wallet and receive results. This is how we become payments and login infrastructure for other apps rather than a destination only. *AA relationship:* the SDK exposes sponsorship and session-key requests as first-class APIs, letting partner apps build gasless experiences on our rails — an ecosystem lock-in play. *Complexity:* Medium. *Prerequisites:* 78, 68.

**81. Public wallet API and embedded-wallet offering.**
A B2B surface: partners embed our AA account stack (creation, sponsorship, session keys, recovery) in their own products, with keys always on the end-user's device. A second revenue line that monetizes the same core we build anyway, comparable to Coinbase's Smart Wallet SDK positioning. *AA relationship:* the product being sold *is* our AA stack. *Complexity:* High (developer experience, documentation, support are the product). *Prerequisites:* 13–22 mature, 27, 56.

**82. Testnet and developer mode.**
Toggleable test networks, faucet links, raw transaction inspection, and verbose signing detail. Developers are disproportionate word-of-mouth amplifiers, and our own teams need it daily. *AA relationship:* becomes the reference environment for testing 4337/7702 flows — developer goodwill in exactly the community we most need. *Complexity:* Low. *Prerequisites:* 28, 33.

**83. Notifications infrastructure and wallet inbox.**
A permissioned channel through which connected dApps and our own services deliver messages (transaction status, governance votes, liquidation warnings) into an in-wallet inbox, under user control. Re-engagement machinery for us and for the ecosystem. *AA relationship:* operational safety net for AA automation — recovery attempts (20), session-key activity (18), and scheduled executions (25) all *must* notify. *Complexity:* Medium. *Prerequisites:* 87.

---

## 11. Compliance-Optional Features (Never Compromising Non-Custody)

Everything in this category is opt-in, user-controlled, and mechanically incapable of touching keys. The design principle: we sell users tools for *their* obligations; we never acquire obligations over their funds.

**84. Tax reporting and accounting exports.**
Generate cost-basis and capital-gains reports and exports compatible with tax software and accountants, computed from on-chain history client-side or via a privacy-respecting service. Tax season is an annual, universal pain; solving it in-app is retention and a plausible premium feature. *AA relationship:* neutral; must correctly interpret AA artifacts (sponsored gas, batched operations) that generic tax tools misparse — a small data-quality moat. *Complexity:* Medium–High (accounting correctness across chains). *Prerequisites:* 90, 44.

**85. Proof of address ownership and self-attestation.**
One-tap generation of signed messages proving the user controls an address — increasingly requested by exchanges and institutions for withdrawals under travel-rule regimes ("prove this destination is your own wallet"). Keeps our users unblocked as regulation tightens, at zero custody cost. *AA relationship:* smart accounts prove ownership via ERC-1271 (7); we must make that path work where naive tools support only EOA signatures. *Complexity:* Low. *Prerequisites:* 7.

**86. Optional outbound address screening.**
An off-by-default, clearly disclosed toggle that checks destination addresses against public sanctions and known-crime lists before sending, for users and businesses that want or need it. Serves professional users without imposing surveillance on anyone. *AA relationship:* for business accounts, a policy module (19) can make screening binding rather than advisory — opt-in compliance *enforced by the user's own account*, a configuration only AA can express. *Complexity:* Low–Medium (list licensing and freshness). *Prerequisites:* 50 infrastructure.

**87. Transaction notes, receipts, and records.**
Private, locally-encrypted memos on transactions, exportable receipts for business users, and shareable proofs of payment. Mundane and beloved: real-world money use runs on records. *AA relationship:* neutral. *Complexity:* Low. *Prerequisites:* 90.

---

## 12. UX & Accessibility

**88. Guided onboarding and progressive education.**
A first-run experience that gets a novice to a funded, secured account in minutes, deferring advanced concepts until relevant, with contextual explainers throughout ("what is gas?" asked where gas appears). Onboarding completion rate is the top of every funnel we care about. *AA relationship:* AA is what makes a genuinely simple onboarding *honest* — passkey creation (21), counterfactual address (14), sponsored first transaction (15) mean the easy path is also the real product, not a training-wheels facade. *Complexity:* Medium (perpetual iteration). *Prerequisites:* 1, 14, 15, 21 for the flagship flow.

**89. Fiat-first display and jargon abstraction.**
Balances, fees, and quotes primarily in the user's home currency; plain-language verbs ("Send," "Sell," not "Sign UserOperation"); progressive disclosure of raw detail for those who want it. Mainstream users think in dollars, not gwei. *AA relationship:* AA removes the concepts (gas tokens, approvals, nonces) that this feature would otherwise merely paper over — abstraction in the UI backed by abstraction in the account. *Complexity:* Low–Medium. *Prerequisites:* 44.

**90. Human-readable activity history.**
Every past transaction decoded into a sentence — "Swapped 1 ETH for 3,410 USDC on Uniswap" — with counterparty names, status, and fees, across all chains, unified in one feed. Users audit their money by reading history; hex is not reading. *AA relationship:* must decode AA artifacts well (a batch shown as its net effect, sponsored gas shown as $0.00) — incumbent explorers render these poorly, so quality here visibly flatters our own differentiator. *Complexity:* Medium–High (decoding infrastructure across chains). *Prerequisites:* 28, 37, 44.

**91. Localization and regional adaptation.**
Full translation, local currencies and number formats, and region-aware on-ramp routing. Crypto adoption is strongest outside the English-speaking world; localization is market expansion, not polish. *Complexity:* Medium (ongoing). *Prerequisites:* 89.

**92. Accessibility (screen readers, dynamic type, contrast, motor accommodations).**
Full support for platform accessibility APIs across every flow, including the security-critical ones (seed backup, transaction review) where accessibility failures become safety failures. Both an obligation and an underserved market. *AA relationship:* passkey signing (21) is itself an accessibility win over transcribing 24 words. *Complexity:* Medium (discipline more than invention). *Prerequisites:* none.

**93. Push notifications and activity alerts.**
Timely notice of received funds, completed and failed transactions, security events (new device, recovery initiated), and connected-app activity, with granular controls. The heartbeat of engagement and the tripwire of security. *AA relationship:* prerequisite for safe automation — session-key spend (18), scheduled executions (25), and guardian recovery (20) all demand real-time user awareness. *Complexity:* Medium (privacy-preserving delivery — notifying without teaching our servers the user's full financial life — is the design challenge). *Prerequisites:* 28.

**94. Home-screen widgets and watch companion.**
Portfolio-at-a-glance widgets, gas/price tickers, and a watch app for balance checks and payment approvals as a second-factor surface. Ambient presence on the device drives daily habit. *AA relationship:* a watch approval can be a real co-signer on a 2-of-n account (24), turning a gadget feature into a security feature. *Complexity:* Low–Medium. *Prerequisites:* 84 (portfolio engine), 44.

**95. In-app support and self-service diagnostics.**
Contextual help, a stuck-transaction fixer (wrapping feature 8's tools in plain language), connection-health checks, and human support escalation that never asks for secrets — with in-app education that support staff can never legitimately request the seed phrase. For a non-custodial product, support cannot fix custody mistakes, so preventing and self-serving them is the strategy. *Complexity:* Medium. *Prerequisites:* 8, 88.

---

## 13. Analytics & Portfolio

**96. Unified portfolio dashboard.**
One net-worth view across every chain, account, and asset class (tokens, NFTs, staked positions, lending positions), in fiat, with allocation breakdowns. The screen users open most; for many, the wallet's true home page. *AA relationship:* chain abstraction (36) is this dashboard made transactional — the portfolio view is where "one balance across all chains" is first *felt*. *Complexity:* Medium–High (aggregation correctness across DeFi position types). *Prerequisites:* 28, 37, 44.

**97. Performance and profit/loss tracking.**
Historical portfolio value, per-asset cost basis and realized/unrealized P&L, and period returns. Investors manage what they measure; also the data substrate for tax exports (84). *Complexity:* Medium–High (cost-basis accounting shares machinery with 84). *Prerequisites:* 90, 96.

**98. Price alerts and watchlists.**
Alerts on price thresholds and percentage moves for held and watched assets, plus watchlists for assets not yet owned. Cheap, proven engagement mechanics. *AA relationship:* an alert can carry a one-tap *action* ("ETH hit your target — execute your planned swap") that fires through a pre-authorized session key (18): alerts that act, uniquely non-custodially. *Complexity:* Low. *Prerequisites:* 44, 93.

**99. Portfolio insights and risk overview.**
Plain-language analysis of concentration, correlation, yield-at-risk, and standing approvals ("62% of your portfolio is one asset; three contracts hold unlimited allowances"). Turns raw data into judgment, positioning the wallet as an advisor-shaped tool without giving regulated advice. *AA relationship:* insights can link straight to remedies executed as sponsored batches (rebalance via 64, revoke via 51). *Complexity:* Medium. *Prerequisites:* 96, 97, 51.

---

## 14. Prioritization & Strategic Recommendations

### Tiering

**Tier 1 — MVP: the trustworthy AA-native foundation.**
Features: 1–9, 12 (core key management and transactions); 13–17, 26–27 (smart accounts, counterfactual deployment, paymasters both kinds, batching, parallel nonces, bundler strategy); 22 (modularity from day one); 28–32 (adapter architecture and the four launch chain families: EVM/L2s, Bitcoin, Solana, Dogecoin); 37–39, 44 (tokens, spam filtering, prices); 46 (seed backup UX); 49–50, 52 (simulation, risk warnings, app security); 56 (audit/open-source program); 34 (swaps — the revenue engine ships at launch); 65 (on-ramp); 73 (contacts); 78 (WalletConnect); 88–90, 93 (onboarding, fiat-first display, readable history, notifications).
*Rationale:* the MVP must prove the thesis, not merely exist. A launch where a new user installs the app, gets an address instantly (14), buys $50 by card (65), and swaps or sends with zero gas anxiety (15–17) is a demo no incumbent can copy quickly — while simulation (49) and the audit program (56) establish the trust floor a money product needs on day one. Modularity (22) and the adapter framework (28) are in Tier 1 not for visible payoff but because Constraint 3 says retrofitting them later is the one mistake we cannot undo.

**Tier 2 — Differentiation: the features that make switching irreversible.**
Features: 10–11 (watch-only accounts, hardware wallet pairing — the serious-holder pair); 18–21, 23–25 (session keys, policies, guardians, passkeys, multisig, automation — the full AA arsenal); 47–48 (encrypted cloud backup, inheritance); 51, 53–54 (approvals manager, duress, poisoning defenses); 33, 35 (custom networks, bridges); 40–41, 43 (NFTs, Solana asset depth); 57–60 (staking including sponsored flows and gas-from-yield); 63 (non-custodial DCA); 66–69 (off-ramp, P2P, payment links, subscriptions); 74–76 (ENS, handles, SIWE); 79–80, 82–83 (dApp browser, SDK, dev mode, inbox); 85, 87 (ownership proofs, notes/receipts); 91–92, 94–95 (localization, accessibility, widgets, support); 96–98 (portfolio, P&L, alerts).
*Rationale:* Tier 2 converts the Tier 1 platform into moats. Passkeys plus guardians (21 + 20) finally give a mainstream-honest answer to "what if I lose my phone?"; session keys plus policies (18 + 19) unlock the commercially novel trio of subscriptions, DCA, and gas-from-yield (69, 63, 60), each of which is *impossible for both custodial competitors (by business model) and EOA wallets (by physics)*. EIP-7702 (23) is the acquisition weapon aimed at every existing MetaMask address. Sequencing within Tier 2 should follow dependency chains: 18–19 early, because 25, 60, 63–64, 69, 71 all stand on them.

**Tier 3 — Horizon: category creation and second products.**
Features: 36 (cross-chain intents / chain abstraction); 42 (Ordinals/Runes); 45 (token-bound accounts); 55 (MPC signer); 61–62, 64 (lending, vaults, rebalancing); 70–72 (merchant toolkit, non-custodial card, NFC/offline); 77 (attestations); 81 (embedded-wallet B2B); 84 (tax reporting); 86 (optional screening); 99 (insights).
*Rationale:* each is either standards-immature (36, 77), a second product with its own go-to-market (70, 71, 81), dependent on a mature Tier 2 stack (60's full vision, 64), or a monetizable premium layer best built on a large user base (84, 99). Horizon status is a sequencing judgment, not a value judgment — the embedded-wallet API (81) in particular could become a revenue line rivaling the consumer app, and should be re-evaluated the moment the Tier 2 AA stack stabilizes.

### The best strategic opportunities

1. **Gasless, seedless-feeling onboarding (14 + 15 + 21 + 88).** Card-to-first-transaction in minutes with Face ID and no gas token, while remaining fully non-custodial with mandatory seed recovery underneath. This single flow is the market's sharpest unmet demand and our clearest head-to-head win against MetaMask, Trust, and Coinbase Wallet alike.
2. **The non-custodial automation franchise (18 + 19 + 25 → 63, 69, 60, 71).** Subscriptions, DCA, gas-from-yield, and just-in-time card funding form a family no competitor class can follow: custodial apps fail Constraint 1, EOA wallets fail the technology. These are also the features with natural revenue attachment (payment take rates, DCA spread, card interchange).
3. **Recovery as the trust brand (20 + 46 + 47 + 48).** Guardians, drilled seed backup, user-encrypted cloud backup, and inheritance together answer the fear that keeps the majority of crypto owners on exchanges. "The self-custody wallet your family can actually inherit" is a positioning no incumbent owns.
4. **EIP-7702 conquest of existing EOAs (2 + 23).** "Keep your address, gain superpowers" converts the installed base of every incumbent wallet without asking users to move funds — the cheapest acquisition channel available to us.
5. **The AA platform as B2B revenue (80 + 81).** The same sponsorship, session-key, and recovery stack, sold as embedded infrastructure to apps that want wallets without building them. One engineering investment, two businesses.

### Why AA-first is the moat

Every feature above that carries the phrase "uniquely possible with AA" — roughly a quarter of this document, including nearly all of the commercially novel ones — is structurally unavailable to both competitor classes. Custodial products (exchanges, neobank-style apps) can match the *convenience* but never the *self-custody*, which regulation and user sentiment increasingly reward. Non-custodial EOA wallets can match the self-custody but not the capabilities, because an EOA's single fixed key cannot express sponsorship, scoped permission, policy, or recovery. The intersection — programmable-account capability *and* strict self-custody *and* mandatory seed recovery *and* true multi-chain reach — is a quadrant with no established occupant. Incumbents attempting to enter it face migration drag we do not have: their users sit on EOAs, their architectures assume one key, and their revenue depends on flows AA restructures. Our constraints, in other words, are not limitations on the strategy; they are the strategy. The recommendation of this document is to fund Tier 1 as a single integrated bet on that quadrant, sequence Tier 2 along the session-key and recovery dependency chains, and treat the modular-account and chain-adapter architectures as board-level commitments, because they are what keep every unbuilt feature in this universe reachable.

---

*Document ends. Feature count: 99 distinct features across 12 categories.*

---

## 15. Implementation status (2026-10-03)

This section was added after the analysis above and does not change it. It records, for each of the 99 features, how far the prototype has actually got, using only the evidence recorded in `AGENTS.md` (the project's running log of every phase, test run and live validation) and the documents it cites. Nothing here is a plan or an estimate.

### How to read the status column

There are exactly four status values.

- **Proven live** means a real run against a live network or live service is recorded in `AGENTS.md`, with the network and the date. The evidence cell says whether the run went through the app's own screens ("in-app"), through the app's own code driven from a script ("app code, script"), or through the engine alone from a test script ("engine"). These are different levels of proof, and the difference matters: an engine proof shows the cryptography and the contracts work; an in-app proof shows a user could do it.
- **Built, verified offline** means the code exists and is covered by the project's offline test suites (the engine's vitest tests and the app's check scripts), but no live run is recorded.
- **Designed** means only a design document or an engine interface exists.
- **Not started** means nothing has been built or designed beyond the analysis in this document.

Three conventions apply throughout.

1. Where only part of a feature exists, the status describes the part that exists, and the evidence cell names what is missing. A "Proven live" status with the word "partial" therefore does not mean the whole feature as described above is finished.
2. A few features have no network component at all (for example the backup quiz, contacts or the app lock). For these, "Proven live" means the feature was exercised in the running app on the Android emulator, with screenshots reviewed, as recorded in `AGENTS.md`. That is the strongest evidence such a feature can have before a real-phone build exists.
3. Dates are the ones `AGENTS.md` gives. That log mostly uses US Eastern local dates, so a run late in the evening can carry the previous day's date compared with UTC. Where `AGENTS.md` gives no date for a live run, the date below is taken from the Sepolia block timestamp and marked "UTC".

Nothing in this table means "ready for real funds". The mainnet-readiness switchboard (`app/src/config/readiness.ts`) and the checklist in `docs/THREAT_MODEL.md` section 5 still list no feature as cleared for mainnet: every smart-account feature is enforced test-network-only until conditions C1 to C3 (an audit of the shipped Kernel version and modules, bug-bounty coverage, a support horizon) are met, and the plain-account features run on mainnet only as an advisory "not yet cleared" prototype, by the Chairperson's decision of 2026-10-02.

The record used here runs to phase 10 item 1 (session keys and guardians through the app's screens, proven live on 2026-10-03). Live gas sponsorship (phase 10 item 2) waits on a sponsorship policy and is not counted.

### Status of all 99 features

| # | Feature | Tier | Status | Evidence |
|---|---|---|---|---|
| 1 | Seed generation and first-run onboarding | 1 | Proven live | In-app on the Android emulator, 2026-09-27: create-wallet flow, 12-word backup screen with warning, 2-word quiz, Home with live balances from real RPCs (`AGENTS.md` "Emulator validation"). |
| 2 | Seed and wallet import | 1 | Built, verified offline | Import screen with phrase validation (`AGENTS.md` Status, React Native app shell). Not recorded on the emulator. No account discovery on import, by decision (ADR D8 in `docs/ARCHITECTURE.md`; phase 6 item 3). |
| 3 | HD derivation engine | 1 | Proven live | Official BIP-32/39/44 and SLIP-0010 vectors (Status); seed-derived keys signed live broadcasts on Sepolia, Bitcoin testnet3 and Solana devnet on 2026-09-27 (phase 2 task 8) and on Dogecoin mainnet on 2026-10-03 (phase 9, Dogecoin broadcast); multi-account paths cross-checked against ethers, bitcoinjs-lib and ed25519-hd-key (phase 6 item 3). |
| 4 | Multi-account management | 1 | Proven live | In-app on the emulator, 2026-09-28: Account 2 added with distinct addresses on all four chains, switching back and forth (phase 6 emulator validation). Account 2 was then used live on Sepolia for the in-app EIP-7702 upgrade (2026-10-01) and the in-app owner change (2026-10-02). Partial: no colours or per-account privacy settings. |
| 5 | Secure on-device key storage | 1 | Built, verified offline | Phrase in `expo-secure-store`; opt-in biometric-protected storage (`check-storage.mjs`), whose prompts were seen in Expo Go on the Android emulator on 2026-10-02 ("Security quick wins", Settings protection entry). Hardware backing (Secure Enclave, StrongBox) is unverified: the emulator uses a software keystore and no real-phone build exists (THREAT_MODEL W2, W3). |
| 6 | Per-chain transaction construction and signing | 1 | Proven live | Engine-built transactions accepted live: Sepolia EIP-1559 and Bitcoin testnet3 P2WPKH and Solana devnet transfer, all 2026-09-27 (phase 2 task 8, scripts); Dogecoin mainnet self-send 2026-10-03 (app code, script). In-app on Sepolia: WalletConnect transactions 2026-09-27 and 2026-09-28, smart-account send 2026-10-01. Bitcoin, Solana and Dogecoin sends have not been broadcast from the Send screen itself (the app uses their main networks only). |
| 7 | Message and typed-data signing | 1 | Proven live | In-app: an EIP-712 Permit2 signature for Uniswap over WalletConnect, Sepolia, 2026-09-27 ("Grand finale"). Engine: ERC-1271 / ERC-6492 smart-account signatures validated live (read-only) on Sepolia by `signature-check.mjs` (phase 7 items 3 and 5, engine halves). Partial: plain `personal_sign` never exercised with a live dApp; smart-account signing in-app not live; BIP-322 not built. |
| 8 | Fee management | 1 | Proven live | EIP-1559 fee quotes behind the live Sepolia sends (2026-09-27 onward); Blockbook fee estimate behind the Dogecoin mainnet send (2026-10-03); the bundler priority-fee floor fix proven in-app on Sepolia, 2026-10-01 (phase 7 live validation). Partial: no replace-by-fee, child-pays-for-parent, speed tiers or cancellation. |
| 9 | Receive: addresses, QR codes, payment URIs | 1 | Proven live | In-app on the emulator, 2026-09-27: the Receive QR was decoded from a screenshot with an independent decoder and matched the address ("Emulator validation, continued"). Scanning parses EIP-681 / BIP-21 / Solana Pay (phase 4 task 4). Partial: Receive shows the plain address; payment URIs with amounts are not generated. |
| 10 | Watch-only accounts | 2 | Not started | None recorded. |
| 11 | Hardware wallet pairing | 2 | Not started | None recorded. |
| 12 | Single private-key import | 1 | Not started | The import screen accepts recovery phrases only. |
| 13 | ERC-4337 smart accounts | 1 | Proven live | In-app: first smart-account send (Kernel v3.3) through a bundler, included on Sepolia, 2026-10-01 (phase 7 live validation). Engine: SimpleAccount UserOperation through Alchemy, Sepolia, 2026-09-27 (phase 2 task 8); Kernel smoke 2026-10-01 (phase 7 item 1). Testnet-only by the readiness switchboard (C1–C3). |
| 14 | Counterfactual deployment | 1 | Proven live | Engine: SimpleAccount deployed at the predicted address, Sepolia, 2026-09-27 (self-bundled); Kernel v3.3 deployed at the predicted address through ZeroDev's bundler, Sepolia, 2026-10-01 (phase 8 item 5). The app predicts and displays the counterfactual address, but a deployment operation sent from the app has not run live (the emulator wallet's Kernel account was deployed by `kernel-deploy-for-owner.mjs`). |
| 15 | Gas sponsorship (verifying paymasters) | 1 | Built, verified offline | ERC-7677 paymaster support with verify-before-save in Settings (phase 5 item 2; `check-aa.mjs`). No live sponsorship yet (THREAT_MODEL W8; phase 10 item 2 in progress). |
| 16 | Pay gas in any token | 1 | Not started | None recorded beyond the generic ERC-7677 paymaster hook (feature 15). |
| 17 | Transaction batching and ERC-5792 | 1 | Proven live | Engine: a deployment plus ERC-7579 batch operation on Sepolia, 2026-10-01 (phase 7 item 1, Kernel smoke), and the guardian clean-up operation (owner rotation plus guardian removal in one operation), 2026-10-02 UTC (phase 8 item 4). In-app batching (smart-account approve-and-swap) and ERC-5792 `wallet_sendCalls` over WalletConnect are built and verified offline only (`check-aa-kernel.mjs`, `check-wc-5792.mjs`; phase 7 items 1–3, app halves). |
| 18 | Session keys | 2 | Proven live | In-app on Sepolia, 2026-10-03 (phase 10 item 1): a session granted from the Sessions screen (explicit root-signed install, block 11837098), a test operation signed by the session key alone (block 11837121) and the revoke (block 11837135). Engine: install, use, refusal and revoke in enable mode, block 11826061, 2026-10-02 UTC (phase 8 item 2). |
| 19 | Spending limits and programmable policies | 2 | Designed | `docs/SESSION_KEYS.md` and `docs/ARCHITECTURE.md` (ERC-7579 hooks). Session grants carry per-call value caps (feature 18), but no account-level policy exists. |
| 20 | Social recovery via guardians | 2 | Proven live | In-app on Sepolia, 2026-10-03 (phase 10 item 1): guardian setup with the exposure warning (block 11837168), a guardian recovery request from another account with pasted approvals and the delay started on-chain (block 11837206), the owner's veto (block 11837220), a second recovery on guardian lane 1 executed after the delay (block 11837294; the final operation was submitted by a guardian from a script because the guardian keys are not in the emulator wallet), attach, owner change back (block 11837307) and guardian removal (block 11837317). Engine proof: blocks 11826469–11826471, 2026-10-02 UTC (phase 8 item 4). Findings: one guardian can satisfy a 2-of-2; guardians can sign as the account immediately; modules unaudited. |
| 21 | Passkey and biometric signers | 2 | Built, verified offline | Engine and app built (phase 8 item 3; `check-passkeys.mjs`); install, use and removal accepted in simulation against the real Sepolia contracts. Not device-proven: needs a development build and an rpId domain from the Chairperson. WebAuthnValidator v0.0.3 unaudited (C1). |
| 22 | Modular accounts (ERC-7579) | 1 | Proven live | Kernel v3.3 used in-app on Sepolia, 2026-10-01 (phase 7 live validation); modules installed live from scripts: the session permission validator and the guardian validator plus RecoveryAction (phase 8 items 2 and 4, 2026-10-02 UTC). |
| 23 | EIP-7702 for existing EOAs | 2 | Proven live | In-app on Sepolia, 2026-10-01: upgrade carried in a UserOperation through ZeroDev and revocation by a self-paid type-0x04 transaction, both independently confirmed on-chain (phase 8 live validation). Engine: Sepolia block 11826010, 2026-10-02 UTC (phase 8 item 1). Testnet-only (C1–C3). |
| 24 | Multi-signature accounts | 2 | Not started | None recorded (the weighted guardian validator serves recovery only). |
| 25 | Automated and scheduled transactions | 2 | Not started | None recorded. |
| 26 | Parallel operations (2D nonces) | 1 | Built, verified offline | Engine only: nonce-key support (`getNonceKey`, session and guardian lanes; phase 8 burn-down "Awaited signUserOpHash"). Non-zero nonce keys ran live for validator routing in the session-key and guardian scripts, but no user-facing parallel queue exists. |
| 27 | Bundler and AA infrastructure strategy | 1 | Proven live | Vendor-neutral bundler client with per-chain runtime configuration; Alchemy's bundler live on Sepolia 2026-09-27 and in-app 2026-10-01; ZeroDev's bundler accepted Kernel deployments, Sepolia, 2026-10-01 (phase 8 item 5), and carried the in-app EIP-7702 upgrade. Partial: no redundant providers or inclusion monitoring; vendor selection still open. |
| 28 | Chain-adapter plugin architecture | 1 | Proven live | CAIP-2-keyed chain registry and adapters (Status); all four chain families broadcast live through it (features 6 and 32). |
| 29 | EVM networks and Layer 2s | 1 | Proven live | Sepolia sends and smart-account operations from 2026-09-27 onward; Ethereum mainnet reads only (balances, token metadata, simulations), no mainnet transaction. Partial: no Layer 2 profile yet (Base Sepolia is phase 10 item 3). |
| 30 | Bitcoin support | 1 | Proven live | P2WPKH self-send accepted on Bitcoin testnet3, 2026-09-27, by script (phase 2 task 8). Not broadcast from the app (its Bitcoin network is mainnet). Partial: Taproot and BIP-86 are rejected, not supported. |
| 31 | Solana support | 1 | Proven live | System transfer finalized on Solana devnet, 2026-09-27, by script (phase 2 task 8). SPL token transfers are engine-only and verified offline, byte-identical to web3.js (phase 2 task 5); the app has no SPL send. |
| 32 | Dogecoin support | 1 | Proven live | Mainnet self-send confirmed in block 6399309, 2026-10-03, txid `2f05331b…a6fd`, built by the app's own `prepareUtxoSend` / `sendUtxo` code from `doge-mainnet-demo.mjs` (app code, script; THREAT_MODEL W6 met). Not yet broadcast from the Send screen; balances and history through a user-configured Blockbook endpoint were verified live read-only (phase 5 item 3). |
| 33 | Custom network addition | 2 | Not started | Users can override the endpoint of a built-in chain (https only), but cannot add a new network. |
| 34 | In-wallet swaps | 1 | Built, verified offline | Swap screen on the 0x seam (phase 5 item 1; `check-swap.mjs`). No live 0x quote: needs a 0x API key (THREAT_MODEL W7). Swaps through Uniswap over WalletConnect are proven live under feature 78, not here. |
| 35 | Cross-chain bridging | 2 | Not started | None recorded. |
| 36 | Cross-chain intents (ERC-7683) | 3 | Not started | None recorded. |
| 37 | Token discovery and curated lists | 1 | Not started | Tokens are tracked manually (default USDC); no automatic discovery for fungible tokens. NFT discovery through an indexer is under feature 40. |
| 38 | Custom token addition | 1 | Proven live | Add-by-contract with on-chain metadata; live USDC metadata reads through the app's code on Ethereum mainnet, 2026-09-27 (phase 3 task 2, `check-tokens.mjs`), and the USDC row on the emulator's Home the same day. The add screen itself is not recorded on the emulator. |
| 39 | Spam and scam asset filtering | 1 | Built, verified offline | NFT spam flag from the indexer, hidden behind a toggle (phase 7 item 4); untracked-token marker and symbol sanitising in previews (phase 6 item 1). Partial: no token reputation list. |
| 40 | NFT gallery | 2 | Built, verified offline | Gallery and detail screens (phase 7 item 4; `check-nfts.mjs`); the indexer data path ran live read-only on Ethereum mainnet and Sepolia on 2026-10-01, but the screens have not been seen on a device or the emulator. |
| 41 | NFT actions: send, sell, mint | 2 | Built, verified offline | ERC-721 and ERC-1155 send, decoded field by field offline (phase 7 item 4). No live NFT send (needs a test NFT). Partial: sell and mint not started. |
| 42 | Bitcoin-native assets (Ordinals, Runes) | 3 | Not started | None recorded. |
| 43 | Solana asset ecosystem (Token-2022, compressed NFTs) | 2 | Not started | Classic SPL only, engine-only (feature 31). |
| 44 | Price and market data feeds | 1 | Proven live | `@shiba-wallet/prices` with a keyless CoinGecko adapter; a live keyless probe priced all five assets through the app's code, 2026-09-28 (phase 6 item 2). The fiat display has not been eyeballed on the emulator. |
| 45 | Token-bound accounts (ERC-6551) | 3 | Not started | None recorded. |
| 46 | Seed backup UX and verification | 1 | Proven live | In-app on the emulator, 2026-09-27: backup warning, word quiz, and screenshot blocking proven both ways (empty `adb screencap` while the phrase is shown; "Emulator validation, third pass"). Partial: no periodic recovery drills or steel-backup guidance. |
| 47 | Encrypted cloud backup | 2 | Not started | None recorded (the exportable recovery record of feature 20 contains no secrets and is not a phrase backup). |
| 48 | Inheritance and dead-man switch | 2 | Not started | None recorded. |
| 49 | Transaction simulation and preview | 1 | Proven live | In-app on Sepolia, 2026-09-28: the `eth_simulateV1` balance-change preview on a WalletConnect swap matched the receipt to the wei (phase 6 emulator validation); matched again on 2026-10-02 (WalletConnect retest). Mainnet read-only probes (phase 6 item 1). |
| 50 | Risk warnings and phishing protection | 1 | Built, verified offline | Risk checks on every EVM confirm screen (phase 7 item 5; commit `be0656e`; `check-approvals.mjs`); WalletConnect identity verification (phase 9 "Security quick wins"; `check-wc.mjs`). No live dApp has shown a Verify verdict yet (THREAT_MODEL W12). Partial: no threat-intelligence feed. |
| 51 | Token approval management and revocation | 2 | Proven live | Listing only: a live read-only scan through the app's code on Ethereum mainnet listed a real approver's three approvals correctly as used up (phase 7 item 5, app half). Revocation is built and verified offline; no revoke has been broadcast. |
| 52 | App-level security | 1 | Proven live | In-app on the emulator: fingerprint-gated auto-lock with screen state preserved, 2026-09-27 ("third pass"); lock held over a queued WalletConnect request, 2026-09-28; one-prompt send approval with protected storage, 2026-10-02. |
| 53 | Duress and decoy wallet | 2 | Not started | None recorded. |
| 54 | Address-poisoning defences | 2 | Proven live | In-app on the emulator, 2026-09-28: a look-alike of a saved contact produced the "looks similar … but is DIFFERENT" warning, the exact address the contact label (phase 6 emulator validation). |
| 55 | MPC as an optional signer | 3 | Not started | Deliberately deferred in this document. |
| 56 | Audits, open source and bug bounty | 1 | Designed | The repository is public under Apache-2.0 with green CI (phase 9 item 4), and `docs/THREAT_MODEL.md` section 7 gives external reviewers a reproduction guide. No audit has been commissioned and no bounty exists. |
| 57 | Native staking | 2 | Not started | None recorded. |
| 58 | Ethereum liquid staking | 2 | Not started | None recorded. |
| 59 | Sponsored staking flows | 2 | Not started | None recorded. |
| 60 | Gas paid from staking yield | 2 | Not started | None recorded. |
| 61 | Lending and borrowing | 3 | Not started | None recorded. |
| 62 | Yield vaults (ERC-4626) | 3 | Not started | None recorded. |
| 63 | Dollar-cost averaging | 2 | Not started | None recorded. |
| 64 | Portfolio automation and rebalancing | 3 | Not started | None recorded. |
| 65 | Fiat on-ramp | 1 | Not started | None recorded. |
| 66 | Fiat off-ramp | 2 | Not started | None recorded. |
| 67 | P2P payments and requests | 2 | Not started | Contacts exist (feature 73); payment requests do not. |
| 68 | Payment links and QR invoices | 2 | Not started | Payment URIs are parsed when scanned, never generated (feature 9). |
| 69 | Subscriptions via session keys | 2 | Not started | None recorded. |
| 70 | Merchant acceptance toolkit | 3 | Not started | None recorded. |
| 71 | Non-custodial debit card | 3 | Not started | None recorded. |
| 72 | Offline, NFC and tap-to-pay | 3 | Not started | None recorded. |
| 73 | Address book and contacts | 1 | Proven live | In-app on the emulator, 2026-09-28: per-network contacts, picker, exact-match labelling with the full address (phase 6 emulator validation; `check-contacts.mjs`). |
| 74 | Name-service resolution (ENS and peers) | 2 | Not started | None recorded. |
| 75 | Wallet handles | 2 | Not started | None recorded. |
| 76 | Sign-In with Ethereum (ERC-4361) | 2 | Built, verified offline | The signing paths SIWE needs exist: EIP-191 `personal_sign` and smart-account ERC-1271 / ERC-6492 signatures over WalletConnect (`check-wc.mjs`, `check-wc-5792.mjs`; phase 7 item 3). No SIWE-specific message display and no live SIWE login recorded. |
| 77 | Attestations and reputation | 3 | Not started | None recorded. |
| 78 | WalletConnect v2 | 1 | Proven live | In-app with Uniswap on Sepolia: pairing and a full swap (approval, Permit2 signature, swap) on 2026-09-27; the global approval sheet over Home and the decline paths on 2026-09-28; a fresh pairing and swap after a restart on 2026-10-02. Smart-account sessions, ERC-5792 and ERC-7715 over WalletConnect are built and verified offline only. |
| 79 | In-app dApp browser | 2 | Not started | None recorded. |
| 80 | Deep links and mobile SDK | 2 | Not started | None recorded. |
| 81 | Public wallet API / embedded wallet | 3 | Not started | None recorded. |
| 82 | Testnet and developer mode | 2 | Proven live | Sepolia test mode toggle on the emulator, 2026-09-27, and every Sepolia run since (phase 4 items 5 and 6; emulator validation). |
| 83 | Notifications infrastructure and inbox | 2 | Not started | None recorded. |
| 84 | Tax reporting | 3 | Not started | None recorded. |
| 85 | Proof of address ownership | 2 | Not started | No dedicated flow; manual message signing (feature 7) is the only route. |
| 86 | Optional outbound address screening | 3 | Not started | None recorded. |
| 87 | Transaction notes and receipts | 2 | Not started | None recorded. |
| 88 | Guided onboarding and education | 1 | Built, verified offline | Basic version only: the first-run flow of feature 1 plus plain-language explanations on every screen. The guided flow this feature describes (passkey creation, counterfactual address, sponsored first transaction) is not assembled, and no test suite covers onboarding copy. |
| 89 | Fiat-first display and jargon abstraction | 1 | Built, verified offline | Fiat values as secondary text on Home and confirm screens, masked by Hide amounts (phase 6 item 2, app half; `check-prices.mjs`). Not eyeballed: test mode prices nothing and the mainnet balances are zero. Exact crypto stays primary by design. |
| 90 | Human-readable activity history | 1 | Proven live | Bitcoin Activity on the emulator, 2026-09-27; history read live through the app's code for Bitcoin and Solana (phase 3 task 6), Ethereum via an indexer (phase 4 task 1), Dogecoin via Blockbook (phase 5 item 3). Partial: entries show direction, amount and status, not decoded sentences. |
| 91 | Localisation | 2 | Not started | None recorded. |
| 92 | Accessibility | 2 | Built, verified offline | Accessibility roles, labels and hints on the main screens (phase 9 item 5 and follow-ups); lint and typecheck green. No TalkBack or VoiceOver run. |
| 93 | Push notifications and alerts | 1 | Not started | None recorded. |
| 94 | Widgets and watch companion | 2 | Not started | None recorded. |
| 95 | In-app support and diagnostics | 2 | Not started | Calm error states and an offline notice exist (phase 9 item 5), but no support flow or stuck-transaction fixer. |
| 96 | Unified portfolio dashboard | 2 | Not started | Home lists per-chain balances with optional fiat per row; there is no aggregated net-worth view. |
| 97 | Performance and profit/loss tracking | 2 | Not started | None recorded. |
| 98 | Price alerts and watchlists | 2 | Not started | None recorded. |
| 99 | Portfolio insights and risk overview | 3 | Not started | None recorded. |

### Summary by tier

| Status | Tier 1 | Tier 2 | Tier 3 | Total |
|---|---|---|---|---|
| Proven live | 25 | 6 | 0 | 31 |
| Built, verified offline | 9 | 5 | 0 | 14 |
| Designed | 1 | 1 | 0 | 2 |
| Not started | 5 | 32 | 15 | 52 |
| **Total** | **40** | **44** | **15** | **99** |

Of the 31 features proven live, the account-abstraction ones split into two groups. Smart-account sends (13), Kernel modularity (22), the EIP-7702 upgrade and revoke (23), WalletConnect (78) and the balance-change preview (49) have been proven through the app's own screens. Session keys (18) and guardian recovery (20) have now also been proven through the app's screens (phase 10 item 1); counterfactual deployment (14) and on-chain batching (17) remain proven at engine level only.

### What separates "built" from "proven live"

For the features that are built but not yet proven live, the remaining gap is almost never more code. It is one of three things. First, **inputs only the Chairperson can provide**: a 0x API key turns on live swap quotes (34); a paymaster sponsorship policy turns on live gas sponsorship (15, phase 10 item 2); a test NFT allows a live NFT send (41); a passkey rpId domain plus an Expo account and app identifiers allow a development build. Second, **a real-phone development build**, which Expo Go cannot replace: passkeys (21), hardware-backed key storage (5), Face ID, TalkBack and VoiceOver (92) can only be proven on devices. Third, **live runs through the app's screens** of flows whose engine is already proven: session keys and guardians (phase 10 item 1, needing only the emulator and test ETH), plus a live dApp that sends plain message-signing and smart-account requests (7, 76, 78). Separately from all of these, "proven live" on a test network is not the same as cleared for real funds: every smart-account feature stays test-network-only until an audit of the deployed Kernel v3.3 and its modules, bug-bounty coverage and a support horizon exist (conditions C1 to C3), and the plain-account features still wait on the real-phone checks W2 to W4 in `docs/THREAT_MODEL.md` section 5.
