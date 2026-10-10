# Findings about third-party contracts: the evidence record

## About this document

**Purpose.** This document gathers, in one place, every finding this project
has recorded about smart contracts and services it does not own, so that the
Lead Chairperson can check each one against its evidence before deciding
whether, how and to whom to make a responsible disclosure. It is written so
that a careful engineer at the vendor (ZeroDev / Offchain Labs, and Circle or
Pimlico for the related observations) could follow and reproduce each item
without access to this project's keys.

**Date and basis.** Prepared on 2026-10-10 (UTC) at repository commit
`40602dc`. The record it draws on is `AGENTS.md`, `docs/HISTORY.md` (phases
7 to 12), `docs/THREAT_MODEL.md` (findings register, section 6),
`docs/MULTISIG.md`, `docs/SESSION_KEYS.md`, `docs/AA_FRAMEWORKS.md`,
`docs/SCHEDULED_PAYMENTS.md`, the engine sources under
`packages/chains-evm/src/` and the scripts under `scripts/testnet/`. Where
this document re-checked a fact on 2026-10-10 with a read-only call or by
re-running a read-only simulation, it says so and gives the result; nothing
was broadcast, no funds were spent and no project secret was used.

**What this document is not.**

- It is **not a disclosure.** Nobody outside the project has been contacted.
  Whether to disclose, to whom and in what form is the Chairperson's
  decision (`AGENTS.md`, standing rules).
- It is **not a severity verdict.** The "severity" column of
  `docs/THREAT_MODEL.md` describes the risk to this wallet, not a rating of
  the vendor's contract. Each section below describes impact in plain words
  and states what would make the finding wrong; it does not score it.
- It is **not an audit.** It covers only what the project ran into while
  building the wallet. Absence of a finding here says nothing about the rest
  of any contract.
- It does **not upgrade any status.** Where the record overstates its own
  evidence, this document records the weaker status and says why
  (section 9).

## How each finding is classified

Every finding carries exactly one of these statuses, taken from the record
and never raised:

- **Proven live.** Observed on a public test network against the deployed
  contracts. Two kinds occur, and each section says which: (1) a mined
  transaction, whose hash, chain and block are given; (2) a read-only
  `eth_call` against the real on-chain state of a real account at the time,
  which leaves no trace on chain and can only be repeated while that state
  exists.
- **Simulated.** Executed with `eth_simulateV1` (or `eth_call` of
  `EntryPoint.handleOps`) against the real deployed contracts on Sepolia,
  with state and block-time overrides where needed (for example a token
  balance or a time after a delay). Nothing is broadcast. The script and the
  flag that reproduce it are named.
- **Reasoned from source.** Read from the verified source of the deployed
  contract (or from a pinned repository commit), but not executed.

A re-check made for this document is marked **Re-confirmed 2026-10-10** with
what was run and what it returned.

## How to reproduce: shared setup

All reproductions below need no secret, no funds and no bundler account,
except where a section says otherwise.

1. Node.js v24.21.0 (any recent Node should work), then from the repository
   root: `npm ci` and `npm run build`. The scripts import the built engine
   from `packages/*/dist/`.
2. The scripts default to the keyless public Sepolia endpoint
   `https://ethereum-sepolia-rpc.publicnode.com`; set `NODE_URL` to use
   another. The endpoint must serve `eth_simulateV1`.
3. Every dry run signs with the published BIP-39 test vector (the all-zero
   entropy phrase), whose Kernel accounts are undeployed on Sepolia; the
   simulation deploys them inside the simulated block. No project key file
   is read in dry-run mode (each script's header documents its flags).
4. Do not set `ZERODEV_PROJECT_ID`, `BUNDLER_URL` or any `*_LIVE=1`
   variable; that keeps every script in its read-only mode.
5. Sepolia activated the Glamsterdam fork on 2026-10-06 13:53:36 UTC
   (`docs/THREAT_MODEL.md` F-65). Gas figures printed today differ from
   those in the record (Kernel permission installs cost three to four times
   more), but every dry run below still passed on 2026-10-10.
6. The public endpoint sometimes answers `null` for an old receipt that
   exists. On 2026-10-10 three receipts below came back `null` from
   publicnode and were read from `https://1rpc.io/sepolia` instead, and a
   fourth appeared only on a second attempt. If a
   receipt is missing, try a second endpoint before concluding anything.

Pinned sources referred to throughout:

| Name | Repository and commit |
|---|---|
| Kernel v3.3 | `github.com/zerodevapp/kernel`, tag `v3.3`, commit `cd697c7e21715d015e0643af22310a99aa17433b` |
| Kernel v3.0 / v3.1 / v3.2 | same repository, tags `v3.0` (`88de17e`), `v3.1` (`03f7f5c`), `v3.2` (`cfedcb9`) |
| ZeroDev plugins | `github.com/zerodevapp/kernel-7579-plugins`: `ae10aa0f` (WebAuthn, unpatched), `d4855f5` (CallPolicy, RateLimitPolicy), `d9aaeaa` (SpendingLimit as deployed), `9dc7fcd` (SpendingLimit as audited), `ca4a820` (RecoveryAction) |
| ZeroDev SDK | `github.com/zerodevapp/sdk`, commit `cd7c05b5` |
| EntryPoint v0.7 | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` (all chains) |

## Summary

| Item | One-line claim | Status in the record | Re-checked 2026-10-10 |
|---|---|---|---|
| [A](#a-the-weighted-validators-erc-1271-check-counts-a-repeated-signer) | The weighted validator's message-signature check counts a repeated signer, so fewer signers than the threshold can sign messages | Proven live (guardians, read-only `eth_call`); simulated (multisig); proof reasoned | Simulations re-run and passed; source binding re-confirmed |
| [B](#b-guardians-and-heirs-can-sign-as-the-account-at-once) | Guardians and heirs can sign messages as the account from the moment they are added, which can move tokens through permits | Proven live (read-only `eth_call`); token movement simulated | Simulation re-run and passed |
| [C](#c-webauthnvalidator-v001-and-v002-accept-replayed-assertions) | Passkey validators v0.0.1 and v0.0.2 accept any old assertion for any operation | Reasoned from source; the v0.0.3 contrast simulated | Verified source re-read; contrast re-run and passed |
| [D](#d-zerodevs-single-guardian-docs-example-and-the-owner) | Following ZeroDev's single-guardian docs example would overwrite the owner | Reasoned from source only | **Contradicted** by the deployed contract (read-only call) |
| [E](#e-the-spendinglimit-hook-reverts-on-kernel-v31-to-v33) | ZeroDev's SpendingLimit hook implements the Kernel v3.0 hook interface and reverts every hooked operation on Kernel v3.1 to v3.3 | Simulated | Simulation re-run and passed; bytecode re-read |
| [F](#f-the-uint48-delay-wrap-makes-a-takeover-valid-at-once) | A very large guardian delay wraps around and makes a takeover valid immediately | Simulated | Simulation re-run and passed |
| [G](#g-callpolicy-cannot-restrict-batch-execution) | CallPolicy cannot stop a session key from batching several capped transfers into one operation | Simulated | Simulation re-run and passed; source binding re-confirmed |
| [8](#8-related-observations-not-zerodev-contract-findings) | Circle, Pimlico, bundler and audit-coverage observations | Mixed | Several values re-read |

## Contents

- [A. The weighted validator's ERC-1271 check counts a repeated signer](#a-the-weighted-validators-erc-1271-check-counts-a-repeated-signer)
- [B. Guardians and heirs can sign as the account at once](#b-guardians-and-heirs-can-sign-as-the-account-at-once)
- [C. WebAuthnValidator v0.0.1 and v0.0.2 accept replayed assertions](#c-webauthnvalidator-v001-and-v002-accept-replayed-assertions)
- [D. ZeroDev's single-guardian docs example and the owner](#d-zerodevs-single-guardian-docs-example-and-the-owner)
- [E. The SpendingLimit hook reverts on Kernel v3.1 to v3.3](#e-the-spendinglimit-hook-reverts-on-kernel-v31-to-v33)
- [F. The uint48 delay wrap makes a takeover valid at once](#f-the-uint48-delay-wrap-makes-a-takeover-valid-at-once)
- [G. CallPolicy cannot restrict batch execution](#g-callpolicy-cannot-restrict-batch-execution)
- [8. Related observations (not ZeroDev contract findings)](#8-related-observations-not-zerodev-contract-findings)
- [9. Where the record is thin or contradicts itself](#9-where-the-record-is-thin-or-contradicts-itself)
- [10. Re-confirmation log, 2026-10-10](#10-re-confirmation-log-2026-10-10)

---

## A. The weighted validator's ERC-1271 check counts a repeated signer

**1. Claim.** In ZeroDev's deployed `WeightedECDSAValidator`, the
message-signature (ERC-1271) path adds each signer's weight and tests the
threshold *before* it tests that signers are in strictly descending order,
so a signature list whose last entry repeats an earlier signer passes; a set
of distinct signers C therefore passes a message check whenever
weight(C) + (largest weight in C) reaches the threshold, which means one
guardian of an equal-weight 2-of-2 can sign messages alone, and for every
threshold of 2 or more no choice of weights makes the message check as
strong as the operation check.

Scope: this concerns message signatures only. The same contract's
operation path (`validateUserOp`) skips a signer that has already voted, so
**operations are a correct k-of-n** (simulated and proven live in phase 15;
see "how established").

**2. Affected artefact.**

- Contract `WeightedECDSAValidator`, EIP-712 domain
  ("WeightedECDSAValidator", "0.0.3"), at
  `0xeD89244160CfE273800B58b1B534031699dFeEEE` on Ethereum mainnet and
  Sepolia. Sourcify full match on chain 1, runtime match
  on Sepolia; runtime code 9,678 bytes, whose hash differs per chain only
  because solady's `EIP712` caches the chain id as an immutable
  (`kernel-recovery.ts`, deployment binding).
- Source: Kernel tag `v3.3`, `src/validator/WeightedECDSAValidator.sol`.
  The ERC-1271 function `isValidSignatureWithSender` is lines 280-304; the
  loop is lines 292-302:

  ```solidity
  for (uint256 i = 0; i < sigCount; i++) {
      address signer = ECDSA.recover(hash, data[i * 65:(i + 1) * 65]);
      totalWeight += guardian[signer][msg.sender].weight;
      if (totalWeight >= strg.threshold) {
          return ERC1271_MAGICVALUE;      // threshold tested first (lines 295-297)
      }
      if (signer >= prevSigner) {
          return ERC1271_INVALID;         // order tested second (lines 298-300)
      }
      prevSigner = signer;
  }
  ```

  The operation path de-duplicates instead: lines 221-224
  (`if (vote.status != VoteStatus.NA) { continue; }`) and 233-240.
- How a dApp reaches it: Kernel v3.3 `isValidSignature`
  (`src/Kernel.sol` lines 282-284) calls
  `ValidationManager._verifySignature` (`src/core/ValidationManager.sol`
  lines 424-457), which forwards to the validator named in the signature's
  first 21 bytes (`0x01` followed by the validator address) at lines
  442-444.
- SDK: ZeroDev SDK `cd7c05b5`, `plugins/weighted-ecdsa/constants.ts` lines
  34-40, maps this address to Kernel "0.3.0 - 0.3.3". (The record notes that
  the published npm package `@zerodev/weighted-ecdsa-validator` 5.4.4 maps it
  to "0.3.0 || 0.3.1" only; `docs/THREAT_MODEL.md` F-20 item 6.)

**3. How it was established.**

- *Guardian set, phase 8 (2026-10-01 or 02): proven live, as a read-only
  `eth_call`.* `scripts/testnet/recovery-smoke.mjs` (live leg, step [2])
  installed two fresh guardians (weight 1 each, threshold 2, no delay) on
  the project's deployed Kernel account
  `0x1D723b78e1D0D84Fd0531e2686285fb1B6414106`, then called the account's
  `isValidSignature` with four probes; "one guardian's signature repeated
  twice" returned `0x1626ba7e` (valid) and "one guardian alone" did not.
  The three transactions around the probe (full hashes recovered from the
  chain on 2026-10-10; the record gives them shortened):

  | Step | Block | Transaction | UserOperation hash |
  |---|---|---|---|
  | Guardian install | 11826469 | `0x3101b85857ff1a88f0fd95ecc9f9eaf49b6585f96a81d68d226d08aaa3fe05c1` | `0x53705b9c6757110da730c9f6c590d41b085a23340e03f3a8128f14e07e6f6045` |
  | Guardian recovery to `0xc687f25121C46e6Fd2892fFda0425D1A775e6166` | 11826470 | `0xd49ee8af8f1f2987f6ab5673f0e88bf74ed7574765eb115cf63b7e01a5e0e302` | `0x8ac47b121c7c04fd06fadbe613b8b52e2836fa7eadcfd8f29ae6f7b1e5fa08da` |
  | Rotate back and remove guardians | 11826471 | `0x99e107fc566abb2929c916e43377cef8ca2b1c7b9919cbcd229bee6e48a80272` | `0xdf436c256a848fb525c846c4cbb3acbb8cb11ce778eaffd591fabc205a7af048` |

  The `eth_call` itself is not on chain. The guardian keys were generated in
  memory for that run and discarded, and the guardians were removed in block
  11826471, so the live observation cannot be repeated; it rests on the
  script output recorded in `docs/HISTORY.md` (phase 8, item 4).
- *Guardian set: simulated.* The same four probes run in the dry run of
  `recovery-smoke.mjs` (part A). **Re-confirmed 2026-10-10.**
- *Multisig root, phase 15 (2026-10-09): simulated.*
  `scripts/testnet/multisig-smoke.mjs` dry run, step [D2]: for a 2-of-3
  account whose root validator is this contract, one signer's signature
  duplicated makes `isValidSignature` return `0x1626ba7e`, the same
  signature once returns `0xffffffff`. **Re-confirmed 2026-10-10** (account
  `0xFb635CE9bc32F81e2DEdCc00DE0badfA14c90679` in the simulation). The
  record describes this result as proven live on the deployed multisig
  account; the script's live leg contains no ERC-1271 step, so this
  document records it as simulated (section 9, item 1).
- *Operations are a correct k-of-n: simulated and proven live.* The same dry
  run shows two distinct signers accepted and one signer, or one signer used
  twice, refused with `AA24 signature error`. Live on Sepolia, the 2-of-3
  account `0xd927ac18Cd58D4E6DdfD8D97D0B3e78c64f28c57` (root validator read
  back as `0x01ed89244160cfe273800b58b1b534031699dfeeee` on 2026-10-10) ran a
  self-bundled deployment and operation in transaction
  `0xb28a55de36be77d7d43c3220c43580523715ebbcea46d4f0078c6ced0a01b6c4`
  (block 11879418) and an operation through ZeroDev's bundler in
  transaction
  `0x716bb33a2b1c8fa76a1cf55228fad6a5fd22e8079e164324ffd5244b5a37e508`
  (block 11879423), both with two distinct signers.
- *Impossibility proof: reasoned.* `docs/MULTISIG.md` section 4. In short:
  sort weights w1 >= w2 >= ... and let k >= 2 be the fewest signers an
  operation needs, so w1 + ... + wk >= T. Then the k-1 heaviest signers plus
  a repeat of the heaviest weigh (w1 + ... + w(k-1)) + w1 >=
  (w1 + ... + w(k-1)) + wk >= T, so a message always needs at least one
  fewer distinct signer. The engine test file
  `packages/chains-evm/test/kernel-multisig.test.ts` asserts this for every
  equal-weight k-of-n with 2 <= k <= n <= 10.

**4. Evidence a reviewer can check.**

1. Read lines 280-304 of the source above and compare them with lines
   214-240.
2. Bind the source to the deployment: fetch
   `https://sourcify.dev/server/v2/contract/1/0xeD89244160CfE273800B58b1B534031699dFeEEE?fields=sources`
   and compare `src/validator/WeightedECDSAValidator.sol` with the file at
   tag `v3.3`. Expected: identical (13,657 characters on 2026-10-10).
3. Run `RECOVERY_SMOKE_DRY_RUN=1 node scripts/testnet/recovery-smoke.mjs`.
   Expected lines in part [A]:
   `PASS ERC-1271 one guardian alone: invalid (0xffffffff)` and
   `PASS ERC-1271 one guardian's signature repeated twice: VALID (0x1626ba7e)`,
   ending with `DRY RUN PASSED`.
4. Run `node scripts/testnet/multisig-smoke.mjs` (dry run is the default).
   Expected:
   `PASS (4a) one signer, signature DUPLICATED, satisfies 2-of-3 isValidSignature: 0x1 0x1626ba7e`,
   `PASS (4b) one signer, single signature, is rejected by isValidSignature: 0x1 0xffffffff`,
   and `ALL CHECKS PASSED`.
5. Optionally read the receipts in the tables above: each has status `0x1`
   and a `UserOperationEvent` (topic
   `UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)`)
   whose sender is the account and whose success field is 1.

**5. Impact.** For any Kernel v3.x account with this validator installed,
either as guardians (ZeroDev's recovery plugin) or as the root of a
multisig, fewer keys than the configured threshold can produce a signature
the account accepts as its own: an equal-weight k-of-n accepts k-1 signers,
and any signer holding at least half the threshold signs alone. Anything
that trusts the account's ERC-1271 answer (token permits, Permit2, off-chain
orders, sign-in messages) is exposed to that smaller group. Transactions
through the account itself are not affected. Combined with item B, a single
guardian of a 2-of-2 could sign a token permit for the account immediately;
that combination follows from the two results but was not run as one
scenario. The number of deployed accounts using this validator is unknown.

**6. What would refute it, and stated uncertainty.**

- The finding is wrong if the deployed bytecode does not behave like the
  verified source: the simulations above would then return `0xffffffff` for
  the duplicated signature. They returned `0x1626ba7e` on 2026-10-10.
- It is wrong for an account that routes ERC-1271 elsewhere (Kernel v3.3
  routes by the signature's prefix, so a dApp cannot be forced through this
  validator, but an attacker supplying the signature chooses the prefix).
- Uncertainty: ZeroDev's separate `WeightedValidator` v0.0.2 checks the order
  before counting (`docs/MULTISIG.md` section 8), which suggests the vendor
  may already know this pattern; the record found no public advisory for
  `0xeD89…eEEE` and does not say how widely it searched.

**7. The wallet's mitigation today.** The engine computes the true minimum
signer counts (`guardianSignatureExposure`, `multisigExposure`) and the app
shows a mandatory exposure warning on the guardian form, confirmation and
status card; the multisig engine spec has no ERC-1271 signing at all
(`MULTISIG_ERC1271_REFUSAL`), and nothing multisig is in the app. Guardians
are test-networks-only, enforced by the readiness row `guardians`. None of
this changes how the deployed contract answers.

---

## B. Guardians and heirs can sign as the account at once

**1. Claim.** Once the `WeightedECDSAValidator` is installed on a Kernel
v3.3 account as a non-root validator whose only allowed function is
`doRecovery`, its guardians (or "heirs" in an inheritance set-up) can
produce ERC-1271 signatures that the account accepts as its own immediately,
outside the configured delay and outside the owner's veto, and such a
signature can authorise an EIP-2612 permit that moves the account's tokens.

**2. Affected artefact.**

- Kernel v3.3 `src/core/ValidationManager.sol` `_verifySignature`, lines
  424-457: for a validator-type validation it calls
  `validator.isValidSignatureWithSender` (lines 442-444) with **no check of
  the selector allow-list**, which Kernel applies only to UserOperations
  (`src/Kernel.sol` lines 261 and 266). Permission-type validations have an
  opt-out flag (`SKIP_SIGNATURE`, lines 445-451); validator-type
  validations have none.
- `WeightedECDSAValidator` `isValidSignatureWithSender`, lines 280-304:
  no reference to the delay, to proposals or to the veto.
- Detection: the validator declares only `GuardianAdded` and
  `GuardianRemoved` events (lines 58-59); `approve` and `approveWithSig`
  (lines 141-178) emit nothing, and a proposal is keyed by
  `keccak256(abi.encode(sender, callData, nonce))` (line 195), where the
  heir chooses the new owner and the nonce lane.
- Address `0xeD89244160CfE273800B58b1B534031699dFeEEE`; RecoveryAction
  `0xe884C2868CC82c16177eC73a93f7D9E6F3A5DC6E`; Sepolia USDC (Circle)
  `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`, whose
  `permit(address,address,uint256,uint256,bytes)` verifies a contract owner
  through ERC-1271 (the record cites `circlefin/stablecoin-evm`
  `contracts/v2/EIP2612.sol`).

**3. How it was established.**

- *Reasoned from source* (phase 8, finding 2) for the selector allow-list
  being ignored on the signature path.
- *Proven live as read-only `eth_call`s* (phase 14, 2026-10-05):
  `scripts/testnet/inheritance-smoke.mjs` live leg on the deployed account
  `0x1D723b78e1D0D84Fd0531e2686285fb1B6414106`, heir
  `0x69F0EC265702D0891b0AEF8e79ddDC3277ef7E8a` (weight 1, threshold 1,
  delay 600 s). Step L2, right after the install and before any approval:
  the heir's ERC-1271 signature returned `0x1626ba7e`, and a USDC permit the
  heir signed for the account passed `eth_call` (it was never sent). The
  surrounding transactions (all status `0x1`; re-read 2026-10-10):

  | Step | Block | Transaction |
  |---|---|---|
  | L1 owner installs the heir set | 11845766 | `0x573fd4e454c7e9ae03b5e0463d00050bbef9f7da441983159cee4a1629d10ac5` |
  | L3 heir approves proposal P1 (`approveWithSig`) | 11845768 | `0x7328822b839e74d765e1c2d0e5a18b8fd40681c5ad1c5bd635f1d07e9becbe52` |
  | L5 owner vetoes P1 | 11845769 | `0xe9fce6cd9d421b3cc3874db57a15cf2ce9567ef0e986ebb5f2cced023a8d9766` |
  | L6 heir approves proposal P2 | 11845771 | `0x87c97071b810608628e2e017df5cbca94e6df81621e9bfd3c006b66298ab352c` |
  | L7 takeover after the delay | 11845819 | `0x051a49258192a938b530de08d894823fe772399e3ef849bc50605683c18b9e04` |
  | L8 owner rotated back, heir set removed | 11845821 | `0x4925475f1817ff06b4d69b0c1731525dc90e430cbf23821368cf3bcc7e1acc7c` |

  The full hashes come from the run record the script wrote to
  `scripts/testnet/runs/` (git-ignored, local only); the record in
  `AGENTS.md` gives them shortened. The L2 `eth_call` results are in that run
  record only; like item A, they cannot be repeated now (the heir set was
  removed in block 11845821).
- *Simulated:* the dry run of `inheritance-smoke.mjs`, scenario S1: the
  heir signs as the account, uses the signature in USDC `permit` to grant
  itself 1,000 USDC (balance set by a state override), and pulls it with
  `transferFrom` on day one; the takeover itself stays refused until the
  delay ends. **Re-confirmed 2026-10-10.**
- *Detection gap: simulated and partly live.* S5 (remove and re-install of
  the same heir revives an old approval), S6 (bumping one nonce lane voids
  only that lane; an approval on a lane the owner cannot guess still
  executes) and S7 (Kernel `invalidateNonce` disables the heir but also the
  wallet's own `0x01`-prefixed ERC-1271 signatures) are simulated; the live
  L4 step found P1 only by scanning the validator's calldata in
  top-level transactions (internal calls are invisible to that scan).

**4. Evidence a reviewer can check.**

1. Read `_verifySignature` (lines 424-457) and compare its validator branch
   with the selector checks in `Kernel.validateUserOp` (lines 259-268).
2. Run `node scripts/testnet/inheritance-smoke.mjs` (dry run is the
   default). Expected lines in [S1]:
   `PASS the heir signs AS THE ACCOUNT through ERC-1271 immediately: isValidSignature returned 0x1626ba7e`,
   `PASS USDC permit(owner = the account, spender = the heir) with the heir’s ERC-1271 signature: status 0x1`,
   `PASS the heir pulls the account’s USDC with transferFrom on day one: transferFrom status 0x1; ...`,
   then `PASS takeover with no on-chain approval (delay > 0 forbids the immediate path): refused (FailedOp("AA24 signature error"))`,
   and the final `DRY RUN PASSED (58 checks)`.
3. Run `RECOVERY_SMOKE_DRY_RUN=1 node scripts/testnet/recovery-smoke.mjs`:
   `PASS ERC-1271 both guardians (descending): VALID (0x1626ba7e)` shows the
   same for a guardian set.
4. Read the receipts in the table: L1 and L5 to L8 are UserOperations of the
   account (sender `0x1d72…4106`, success 1); L3 and L6 are plain
   transactions to the validator.

**5. Impact.** Anyone who installs guardians or heirs through this validator
expecting them to be able to "only recover, after a delay the owner can
veto" in fact gives them, from the first block, the power to sign as the
account wherever ERC-1271 is accepted. For tokens with ERC-1271-aware
permits (Circle's USDC shown here; Permit2 verifies contract signers the
same way, according to its source, not run) that is the power to move funds
with no delay and no veto. With item A, fewer guardians than the threshold
suffice. In an inheritance ("dead man's switch") design the heir is
effectively a co-owner of such tokens from day one, and the owner cannot
enumerate pending takeovers from events, cannot prove liveness on chain
(renew keeps approvals; remove and re-install revives them), and can stop
the heir only by vetoing proposals it knows about or by disabling all
non-root validators.

**6. What would refute it, and stated uncertainty.**

- The vendor may consider this intended ("every installed validator is a
  signer of the account"). If ZeroDev's documentation says so for the
  recovery plugin, the finding becomes a documentation and product-design
  issue rather than a contract defect; the record does not say whether the
  documentation addresses it.
- It would be wrong if Kernel consulted the allow-list or a per-validation
  flag on the ERC-1271 path; the pinned source does not.
- The token movement was simulated only (no transfer was made on chain); the
  Permit2 statement is reasoned from source only.

**7. The wallet's mitigation today.** Guardians and the inheritance
demonstration are test-networks-only (readiness rows `guardians` and
`inheritance`, enforced). The exposure warning names the signing power; the
inheritance screen shows the risk statement first and needs an
acknowledgement before Review; the app checks for takeover attempts when the
screen gains focus (top-level calldata only) and Remove also vetoes every
known pending takeover; the WalletConnect sheet refuses typed data under the
guardian validator's EIP-712 domain. None of this limits what the guardians
can sign elsewhere.

---

## C. WebAuthnValidator v0.0.1 and v0.0.2 accept replayed assertions

**1. Claim.** In ZeroDev's passkey validators v0.0.1 and v0.0.2, a
signature whose `responseTypeLocation` field is `type(uint256).max` skips the
authenticator-flag, response-type and challenge checks and returns only the
P-256 check over the authenticator data and client data supplied with it,
so any earlier valid assertion from the same passkey, re-labelled this way,
validates any UserOperation and any ERC-1271 check for an account using
that passkey; v0.0.3 returns `false` on that path.

**2. Affected artefact.**

- v0.0.1 at `0xD990393C670dCcE8b4d8F858FB98c9912dBFAa06` and v0.0.2 at
  `0xbA45a2BFb8De3D24cA9D7F1B551E14dFF5d690Fd` (full addresses from the
  ZeroDev SDK `cd7c05b5`, `plugins/passkey/index.ts` lines 35-36, which maps
  both, and v0.0.3, to Kernel "0.3.0 || 0.3.1 || 0.3.2 || 0.3.3"; the record
  gives them shortened). Runtime code is identical on Ethereum mainnet and
  Sepolia: v0.0.1 3,494 bytes, v0.0.2 3,472 bytes (read 2026-10-10).
- Verified source (Sourcify, chain 1 for both, also chain 11155111 for
  v0.0.2), `src/WebAuthn.sol` lines 156-157:

  ```solidity
  if (responseTypeLocation == type(uint256).max) {
      return P256.verifySignature(messageHash, r, s, x, y, false);
  }
  ```

  Both `validateUserOp` and `isValidSignatureWithSender` in
  `src/WebAuthnValidator.sol` go through the same `_verifySignature`, which
  decodes `responseTypeLocation` from the signature
  (`abi.decode(signature, (bytes, string, uint256, uint256, uint256, bool))`,
  line 118 in v0.0.1, line 119 in v0.0.2).
- The same branch is in `kernel-7579-plugins` commit `ae10aa0f`,
  `validators/webauthn/src/WebAuthn.sol` lines 157-159, which is the commit
  the "v3.1 incremental audit" names for "WebAuthn Validator" (no WebAuthn
  finding reported).
- The patched v0.0.3 at `0x7ab16Ff354AcB328452F1D445b3Ddee9a91e9e69`
  (4,739 bytes, code hash
  `0x726d987ac55574f77f5184326631c5c51142f94c16c9b9281b751f97519c9eea` on
  both chains, re-read 2026-10-10) returns `false` on that path.
- The SDK names the versions `V0_0_1_UNPATCHED`, `V0_0_2_UNPATCHED` and
  `V0_0_3_PATCHED` (`plugins/passkey/toPasskeyValidator.ts` lines 123-126).

**3. How it was established.**

- For v0.0.1 and v0.0.2: **reasoned from source** (phase 8, item 3). No
  simulation or live test against these two deployments exists in the
  record.
- For v0.0.3: **simulated.** `scripts/testnet/passkey-smoke.mjs`, step
  `dummyReplay`: a valid earlier assertion re-labelled with
  `responseTypeLocation = type(uint256).max` is refused with
  `FailedOp("AA24 signature error")`. **Re-confirmed 2026-10-10.**

**4. Evidence a reviewer can check.**

1. Fetch
   `https://sourcify.dev/server/v2/contract/1/0xD990393C670dCcE8b4d8F858FB98c9912dBFAa06?fields=sources`
   (and the same for `0xbA45a2BFb8De3D24cA9D7F1B551E14dFF5d690Fd`); in
   `src/WebAuthn.sol`, lines 156-157 contain the branch quoted above.
2. `eth_getCode` both addresses on mainnet and Sepolia and compare the
   hashes (identical across the two chains on 2026-10-10).
3. Run `PASSKEY_SMOKE_DRY_RUN=1 node scripts/testnet/passkey-smoke.mjs`.
   Expected: `PASS dummyReplay: rejected (FailedOp("AA24 signature error"))`
   and `PASSKEY SMOKE PASSED`. This shows only the patched behaviour.
4. To test the claim itself (not done by this project): repeat the
   `dummyReplay` step with the validator address replaced by v0.0.1 or
   v0.0.2 and the account's Kernel version set accordingly; the claim
   predicts the replay is accepted.

**5. Impact.** An account whose passkey validator is v0.0.1 or v0.0.2 can be
controlled by anyone holding any one past assertion from that passkey. This
document adds an inference that is not in the record: a passkey-signed
UserOperation carries the authenticator data, client data and signature in
the bundle transaction's calldata, so after the first such operation the
needed assertion is public on chain, and the same passkey's assertions would
work for every account and chain that registered it with these versions.
Who is affected: developers who selected these versions explicitly in the
SDK (they are still listed for Kernel 0.3.0 to 0.3.3). The number of such
accounts is unknown.

**6. What would refute it, and stated uncertainty.**

- It would be wrong if the deployed bytecode differed from the verified
  source (Sourcify reports a full match on chain 1 for both).
- The SDK's own `UNPATCHED` labels suggest ZeroDev already knows. The
  record found no public advisory; a disclosure would then be about an
  advisory and deprecation rather than a new defect.
- Noticed while re-reading for this document, not analysed and not part of
  the record: v0.0.1's `isValidSignatureWithSender` passes its `sender`
  argument to `_verifySignature` (line 103), whereas v0.0.2 uses
  `msg.sender` (line 102).

**7. The wallet's mitigation today.** The engine pins v0.0.3 and verifies
its runtime code hash before use (`kernel-webauthn.ts`
`KERNEL_WEBAUTHN_VALIDATOR`); the older addresses are never used. Passkeys
are test-networks-only (readiness row `passkeys`) and need a development
build. v0.0.3 itself has no published audit (section 8.6).

---

## D. ZeroDev's single-guardian docs example and the owner

**1. Claim (as recorded).** Following ZeroDev's documentation example,
which registers a single guardian with the ECDSA validator, on an account
whose root validator is that same ECDSA validator would overwrite the
account's owner with the guardian, because both use the same validation id.

**This document finds the claim contradicted for the deployed validators;
see items 3 and 6.**

**2. Affected artefact.**

- Documentation page `docs.zerodev.app/advanced/account-recovery/sdk-recovery`
  (fetched again 2026-10-10): "Let's say you want a single key to be your
  guardian" with `signerToEcdsaValidator(...)` as `guardianValidator`, then
  `createKernelAccount(... plugins: { sudo: sudoValidator, regular:
  guardianValidator, action: { address: recoveryExecutorAddress, ... } })`.
- ECDSA validators the SDK uses (`cd7c05b5`, `plugins/ecdsa/constants.ts`):
  `0x845ADb2C711129d4f3966735eD98a9F09fC4cE57` for Kernel ">=0.3.1" and
  `0x8104e3Ad430EA6d354d013A6789fDFc71E671c43` for "0.3.0".
- Kernel v3.3 `ValidationManager._installValidation` (lines 223-257) calls
  `validator.onInstall(validatorData)` (line 249) for a validator
  validation, including in enable mode (`_enableValidationWithSig`, line
  393).
- The tagged source `src/validator/ECDSAValidator.sol` at `v3.3`, lines
  26-30: `onInstall` writes the owner with **no** "already initialized"
  check.

**3. How it was established.** **Reasoned from source only**, never
executed (`docs/HISTORY.md` phase 8, finding 4; `docs/THREAT_MODEL.md` T-32
"Reasoned from source, not executed"). The reasoning used the tagged v3.3
file.

**Re-confirmed 2026-10-10, with the opposite result for the deployed
contracts.** The verified sources of both deployed ECDSA validators
(Sourcify chain 1) contain, at `onInstall` (lines 26-31):

```solidity
if (_isInitialized(msg.sender)) revert AlreadyInitialized(msg.sender);
```

and a read-only `eth_call` on Sepolia of `onInstall` on `0x845A…cE57`,
made from an account that already has an owner there, reverts with
`AlreadyInitialized(address)` (`0x93360fbf`) carrying the account's
address, while the same call from an address without an owner succeeds.
The record already says this in another place: phase 11
(`kernel-spending.ts`, sources note) records that "the DEPLOYED validator's
onInstall additionally reverts AlreadyInitialized(address)", and the
spending-limit simulation clears the owner before re-installing the root
validator for that reason.

**4. Evidence a reviewer can check.**

1. Read the documentation page and the SDK constants above.
2. Fetch
   `https://sourcify.dev/server/v2/contract/1/0x845ADb2C711129d4f3966735eD98a9F09fC4cE57?fields=sources`
   (and the same for `0x8104e3Ad430EA6d354d013A6789fDFc71E671c43`) and read
   `onInstall`.
3. Send this read-only call to a Sepolia endpoint:

   ```json
   {"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"from":"0x1D723b78e1D0D84Fd0531e2686285fb1B6414106","to":"0x845ADb2C711129d4f3966735eD98a9F09fC4cE57","data":"0x6d61fe7000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000014000000000000000000000000000000000000dead000000000000000000000000"},"latest"]}
   ```

   Expected on 2026-10-10: `execution reverted` with data
   `0x93360fbf0000000000000000000000001d723b78e1d0d84fd0531e2686285fb1b6414106`.
   (`0x1D72…4106` is a deployed Kernel account whose owner in that validator
   is `0x16DA2CAeaDa26516F919C6872F6C38AB378CaC5C`; read
   `ecdsaValidatorStorage(address)` to confirm.)

**5. Impact (as the record states it).** An integrator following the docs
would hand the account to the guardian. **On the deployed validators** the
expected outcome is instead that enabling the guardian reverts, so the
operation fails and nothing changes: a broken recipe for accounts whose
sudo validator is the ECDSA validator, not a takeover. The overwrite would
happen only with a validator compiled from the tagged v3.3 file as it
stands.

**6. What would refute it.** The deployed `AlreadyInitialized` check, shown
above, refutes the overwrite for both addresses the SDK uses. The finding
would survive only for a third ECDSA validator deployment without that check
used with Kernel v3, which the record does not identify. Two smaller facts
remain and may still be worth telling the vendor: the documentation recipe
cannot work as written for such accounts, and the tagged v3.3
`ECDSAValidator.sol` does not match the deployed code.

**7. The wallet's mitigation today.** Guardians are installed only through
the engine's `guardianInstallCalls` with the pinned weighted validator;
`assertGuardianModulesSafe` refuses a guardian module equal to the owner's
root validator and the first install call is byte-checked.

**Recommendation for the Chairperson.** Withdraw item D from the disclosure
list as worded, or restate it as "the documentation recipe fails on the
deployed validators, and the tagged source differs from the deployed code".

---

## E. The SpendingLimit hook reverts on Kernel v3.1 to v3.3

**1. Claim.** ZeroDev's `SpendingLimit` hook, which the SDK still offers as
`SPENDING_LIMIT_HOOK_V07`, implements only the Kernel v3.0 hook interface
`postCheck(bytes,bool,bytes)` (selector `0xaacbd72a`), while Kernel v3.1,
v3.2 and v3.3 call `postCheck(bytes)` (selector `0x173bf7da`); the hook has
no fallback, so every UserOperation of a validation carrying the hook
reverts in execution on those Kernel versions, within or over the limit.

**2. Affected artefact.**

- `SpendingLimit` at `0xb6D6B30C9E1A28E8044F4cCB48A63A423Ee3D70E` (same
  address and code on mainnet and Sepolia: 2,963 bytes, code hash
  `0x0c60c1587d963f0ceb2ef101a4f0c42a968a543c806c7bf097b5e1f785a0a90c`,
  re-read 2026-10-10). Sepolia Etherscan "exact match" to
  `kernel-7579-plugins` `hooks/spendlingLimits/src/SpendingLimit.sol` at
  `d9aaeaa` (directory name as spelled in the repository); the file was
  removed from the repository in `335a67c`. The v3.1 incremental audit
  names commit `9dc7fcd`, one line before the deployed code.
- The earlier deployment `0xC7Bc7C9e4B0Ff4DbF023E9391aAFE0886602b269`
  (SDK 5.2.0 to 5.2.1) has the same three-argument interface.
- Kernel interface `src/interfaces/IERC7579Modules.sol`: tag `v3.0` line 93
  declares `postCheck(bytes calldata hookData, bool executionSuccess, bytes
  calldata executionReturn)`; tags `v3.1`, `v3.2` and `v3.3` line 77
  declare `postCheck(bytes calldata hookData)`. Kernel v3.3 calls it at
  `src/core/HookManager.sol` line 25 and `src/Kernel.sol` line 96.
- SDK `cd7c05b5`, `plugins/hooks/constants.ts` lines 1-2, still points at
  `0xb6D6…D70E`.

**3. How it was established.** **Simulated.**
`scripts/testnet/spending-limit-smoke.mjs` (dry run only; there is no live
mode by design) against the real Sepolia contracts: the hook installs on
the root validation and reads back; a hooked operation within the limit and
one over it both end with `UserOperationEvent` success = false and empty
revert data; `preCheck` as Kernel v3.3 calls it succeeds;
`postCheck(bytes)` reverts with no data; the v3.0-style `postCheck` works and
enforces `ExceedsAllowance()`. **Re-confirmed 2026-10-10.** The bytecode of
both hook deployments, read on both chains on 2026-10-10, contains a `PUSH4`
of `0xaacbd72a` and none of `0x173bf7da`.

**4. Evidence a reviewer can check.**

1. Read the two interface declarations at the Kernel tags above.
2. Run `SPENDING_SMOKE_PUBLIC=1 node scripts/testnet/spending-limit-smoke.mjs`
   (the flag keeps it on the public test vector). Expected:
   `postCheck(bytes) 0x173bf7da present: false; postCheck(bytes,bool,bytes) 0xaacbd72a present: true; compatible with Kernel v3.3: false`,
   then `PASS A4 hooked root op WITHIN the limit (1 wei): executionFailed`,
   `PASS A6a Kernel v3.3-style postCheck(bytes) from the account (as v3.3 calls it): revert without data (0x)`,
   `PASS A6c same again: 600 wei more, only 400 left: ExceedsAllowance()`,
   and `DRY RUN PASSED`.
3. `eth_getCode` the hook and search the hex for `63aacbd72a` and
   `63173bf7da`.

**5. Impact.** A developer who follows the SDK and installs this hook on a
Kernel v3.1 to v3.3 account gets an account whose hooked UserOperations all
fail. Installed on the root validation, the account cannot act through
UserOperations until the owner removes the hook with a direct transaction
(the simulation's steps A7 and A8 show the owner can still call the account
directly and remove it). No funds are lost through the hook; the limit it
promises is simply never applied. The simulation also records two design
facts that are not defects: a root-validation hook never binds the owner's
direct transactions, and the owner can remove it at once.

**6. What would refute it, and stated uncertainty.** It would be wrong if
Kernel v3.1 to v3.3 called the three-argument `postCheck` (the tagged
interfaces say they do not) or if the deployed hook had a fallback that
handled `0x173bf7da` (the simulation's A6a shows a revert). Uncertainty: the
hook's source was removed from the repository in `335a67c`, so ZeroDev may
consider it deprecated; the record does not say whether the current
published `@zerodev/hooks` package still exports it (the record lists 5.2.2
to 5.3.4).

**7. The wallet's mitigation today.** The engine refuses the deployed hook
(`assessHookInterface`, `SpendingLimitHookIncompatibleError`) and offers
only a client-side spending policy, labelled as enforced by this app alone.

---

## F. The uint48 delay wrap makes a takeover valid at once

**1. Claim.** When guardian approvals reach the threshold, the
`WeightedECDSAValidator` stores `validAfter = uint48(block.timestamp +
delay)`, which truncates silently, so a configured delay of
2^48 - block.timestamp seconds or more (about 281,473,185,105,796 seconds,
roughly 8.9 million years, at today's timestamps) produces a `validAfter` in
the past and makes the takeover valid immediately.

**2. Affected artefact.** `WeightedECDSAValidator`
`0xeD89244160CfE273800B58b1B534031699dFeEEE`, Kernel tag `v3.3`: line 152
(`approve`) and line 176 (`approveWithSig`); the delay is a `uint48`
(line 21) accepted without bounds by `onInstall` (lines 85-95) and `renew`
(lines 121-139); the stored `validAfter` is returned to the EntryPoint at
line 251 or 255.

**3. How it was established.** **Simulated.**
`scripts/testnet/inheritance-smoke.mjs` dry run, scenario S8: an install
with delay 2^48 - 1 seconds (built around the engine, which refuses it),
then an approval; `validAfter` reads one second before the approval time
and the takeover 12 seconds after the approval is accepted.
**Re-confirmed 2026-10-10** (`validAfter 1791604859`, approval time
`1791604860`). The record also notes the same wrap applies to a timelocked
multisig (`docs/MULTISIG.md` section 7, reasoned).

**4. Evidence a reviewer can check.** Run
`node scripts/testnet/inheritance-smoke.mjs` and look for the [S8] block:
`PASS the engine refuses a delay of 2^48 - 1 s (validateGuardianSet): refused`,
`PASS install with delay 2^48 - 1 s (...): accepted`,
`PASS validAfter wrapped to approval time - 1: ...` and
`PASS takeover 12 seconds after approval: accepted (UserOperationEvent success=true)`.
The arithmetic: with t the approval time, `(t + 2^48 - 1) mod 2^48 = t - 1`.

**5. Impact.** Reaching the wrap needs a delay of millions of years, so it
matters only where a user interface or integration encodes "never" or
"maximum" as a very large number (for example `type(uint48).max`), which is
exactly the setting where the user expects the strongest protection and
gets none. Ordinary delays (hours to years) are unaffected.

**6. What would refute it, and stated uncertainty.** It would be wrong if
the deployed bytecode checked the addition (the verified source is
byte-identical to the tag and does not), and the simulation would then show
a future `validAfter`. Whether any SDK or interface passes such a delay is
not known to the record.

**7. The wallet's mitigation today.** Since the phase 14 integration slice
the engine's `validateGuardianSet` refuses any delay above
`MAX_GUARDIAN_DELAY_SECONDS = 2^32 - 1` (about 136 years), and the app offers
only presets (inheritance at most 365 days); the multisig config applies the
same bound.

---

## G. CallPolicy cannot restrict batch execution

**1. Claim.** ZeroDev's deployed `CallPolicy` v0.0.4 checks each call of an
ERC-7579 batch on its own against the single-call rules, never adds amounts
up and cannot forbid batch mode, so a session key limited to "at most X per
transfer, one operation per period" (a subscription) can take several
periods' worth in one operation, up to the account's whole balance of that
token, and no deployed Kernel v3.3 module closes the gap.

**2. Affected artefact.**

- `CallPolicy` v0.0.4 at `0x9a52283276A0ec8740DF50bF01B28A80D880eaf2`
  (same code on mainnet and Sepolia: 6,539 bytes, re-read 2026-10-10);
  Sourcify full match on chain 1 whose `src/CallPolicy.sol` is
  byte-identical to `kernel-7579-plugins` commit `d4855f5`
  `policies/call-policy/src/CallPolicy.sol` (re-confirmed 2026-10-10).
  `checkUserOpPolicy` is lines 78-117; the batch branch, lines 99-107, calls
  `_checkPermission(..., CALLTYPE_SINGLE, exec[i].target, exec[i].callData,
  exec[i].value)` for each execution.
- `RateLimitPolicy` `0xf63d4139B25c836334edD76641356c6b74C86873` counts
  operations, not calls; `GasPolicy`
  `0xaeFC5AbC67FfD258abD0A3E54f65E70326F84b23` charges the declared
  `maxFeePerGas`, which the key holder chooses, so it does not bound the
  number of calls (`kernel-subscription.ts`, policy facts).
- The only hook that might restrict execution mode does not work on Kernel
  v3.3 (item E).

**3. How it was established.** **Simulated.**
`scripts/testnet/subscription-keeper.mjs dry-run` against the real Sepolia
EntryPoint, Kernel v3.3, policies and USDC (balance by state override): a
5 USDC per 30 days subscription; in period 2 a batch of two 5 USDC
transfers in one operation is accepted (10 USDC under a 5 USDC cap).
**Re-confirmed 2026-10-10.** The same effect with ETH value caps is part
B2 of `spending-limit-smoke.mjs` (three 1-wei calls under a 1-wei cap).
The policies' single-call enforcement is proven live: an ERC-20
subscription pull of exactly 0.1 USDC succeeded in transaction
`0x9fe98beb5a43ecec989b2454f94ccb7048cb8451a1cd327b842081579af8b56b`
(Sepolia block 11843849), and a pull of 100,001 base units was refused at
estimation with `AA23 reverted 0x59d52e40` (`CallViolatesParamRule()`).
The batch itself was never sent live.

**4. Evidence a reviewer can check.**

1. Read lines 78-117 of the `CallPolicy.sol` named above.
2. Run `node scripts/testnet/subscription-keeper.mjs dry-run`. Expected:
   `PASS [t=S+2592000] over-cap pull (5.000001 USDC) in period 2: rejected (... CallViolatesParamRule())`,
   then
   `PASS [t=S+2592001] RESIDUAL: batch of two 5 USDC transfers in ONE operation, period 2: accepted (UserOperationEvent success=true, 3 Transfer log(s))`
   with the merchant's USDC rising by 10,000,000 base units, and the closing
   line about 10 USDC in one period under a 5 USDC cap.
3. Run `SPENDING_SMOKE_PUBLIC=1 node scripts/testnet/spending-limit-smoke.mjs`:
   `PASS B2 session op: BATCH of three 1-wei calls (3 wei total, "cap" 1 wei): success`.

**5. Impact.** Any subscription, allowance or recurring-payment design built
on these policies binds only an honest key holder. A dishonest merchant, or
anyone who obtains the session key, can use one rate-limit slot to take
several periods' worth, bounded only by the account's balance of the token
and by gas. The per-call cap, the recipient rule, the period and the expiry
still hold.

**6. What would refute it, and stated uncertainty.** It would be wrong if
the policy's `Permission` could restrict the call type to single calls (the
struct distinguishes single and batch only from delegatecall) or if a
deployed module rejected batch mode; the record found none. A later
`CallPolicy` v0.0.5 (`0x85770b90…EaDd2` in the record, shortened there) has
code on both chains but no verified source anywhere the record looked, so
whether it changes this is unknown. The vendor may regard per-call checking
as intended.

**7. The wallet's mitigation today.** The engine refuses batches before
signing (`kernelSubscriptionSpec`, `assertSubscriptionPull`), which binds
only this wallet and an honest keeper; every subscription and recurring
payment screen states the batching limit first and advises keeping only
what one is willing to pay in the subscribing account. Session keys,
subscriptions and recurring payments are test-networks-only (readiness row
`session-keys`).

---

## 8. Related observations (not ZeroDev contract findings)

These are recorded facts about other vendors' contracts and services, or
about audit coverage. None was proposed as a disclosure item in the record;
they are listed so the Chairperson can decide whether any belongs in a
message to Circle, Pimlico or ZeroDev.

### 8.1 Circle's paymaster: documented surcharge versus the chain

- **Claim.** Circle's documentation states a 10% surcharge on gas fees on
  Arbitrum and Base "and their testnets", but the testnet paymaster's
  on-chain `feeSpread()` is 0.
- **Artefact.** Proxy `0x31BE08D380A21fc740883c0BC434FcFc88740b58` on Base
  Sepolia (implementation `0x1E42055dECF050828AfE8bA0A374bC5F44CbFC8d`,
  Sourcify exact match, GPL-3.0-or-later) and Arbitrum Sepolia
  (implementation `0xD9d18FD662B5B2F567545C13fd1e902008beD755`); page
  `developers.circle.com/paymaster.md` (fetched 2026-10-04).
- **Status.** Proven live (read-only calls). It is also consistent with the
  live operation on Base Sepolia (bundle transaction
  `0x83f56b31aafd23b92d5c05624c054273267d266331e3cb593b165c1b0d12b4cb`,
  block 47682905), where the prefund the paymaster pulled equalled the
  wallet's quote, which uses the spread read from the contract. **Re-confirmed 2026-10-10:** `feeSpread()` returns 0
  on both networks.
- **Check.** `eth_call` `feeSpread()` (`0x37876f0d`) on the proxy.
- **Refutes it / uncertainty.** The mainnet deployment
  (`0x6C973eBe80dCD8660841D4356bf15c32460271C9`, documented) was never read
  on chain, so the documentation may be right for mainnet.
- **Wallet today.** The confirm screen shows the spread read from the
  contract and notes the documented 10%; the feature is test-networks-only.

### 8.2 Circle's paymaster: static test oracle, no staleness check

- **Claim.** On the test networks the paymaster's price oracle returns a
  fixed price (3,000 USDC per ETH, round 1), and the paymaster's
  `fetchPrice()` ignores the oracle's `updatedAt`, so it has no staleness
  check of its own.
- **Artefact.** Oracle `0x74479c39dDAFb0549ED6c26080c6e5D155300a89` (Base
  Sepolia) and, on Arbitrum Sepolia, the address `oracle()` returned on 2026-10-10,
  `0x66b53fb340deddfb282c23daeea1a0cec59bbf52` (lower case as returned; the
  record shortens it to `0x66B5…bf52`); the implementation's `PriceOracleHelper.sol` per the
  record.
- **Status.** The fixed price: proven live (read-only). The missing
  staleness check: reasoned from source. **Re-confirmed 2026-10-10:**
  `latestRoundData()` returns round 1, answer 300,000,000,000 (3,000 with 8
  decimals), started 1, updated 2, on both networks; `fetchPrice()` returns
  3,000,000,000.
- **Refutes it / uncertainty.** A test oracle is expected on a testnet. The
  staleness point matters only if the mainnet implementation is the same
  code reading a live feed; the mainnet oracle was not read.

### 8.3 No published audit of Circle's or Pimlico's paymaster

- **Claim.** No published audit report was found for Circle's token
  paymaster (Circle states that third-party audits exist) or for Pimlico's
  `SingletonPaymasterV7` (ZeroDev's page links an audited Pimlico repository,
  but that is a different contract, `ERC20PaymasterV07`).
- **Status.** A documentation search (phase 13 item 2, phase 14 item 3);
  no date range or list of places searched is recorded beyond the pages
  cited in `token-paymaster.ts` and `erc7677-token-paymaster.ts`.
- **Also recorded.** Circle's paymaster is GPL-3.0-or-later behind a UUPS
  proxy whose owner can upgrade, pause, change the oracle, the spread and the
  extra gas charge; Pimlico's is MIT, not a proxy, and permissioned (every
  operation carries Pimlico's signature; the rate comes from its API with
  the markup inside it).

### 8.4 Pimlico's paymaster is not staked on Ethereum Sepolia

- **Claim.** Pimlico's ERC-20 paymaster
  `0x777777777777AeC03fd955926DbF81597e66834C` has a large EntryPoint
  deposit on Ethereum Sepolia but no stake, while it is staked on Base
  Sepolia; ZeroDev's bundler nevertheless accepted operations using it on
  Ethereum Sepolia.
- **Status.** Proven live: read-only `getDepositInfo`, plus the accepted
  operations in transactions
  `0xfbf3e5cddba6a066c2ed066891e875c6f13770ed6b30197a1a7db981de2ef481`
  (block 11845782, by script) and
  `0x2bad539409517ca52e0ee60df1d19c973309478541d11c4200cb419c2fa616bb`
  (block 11846591, in the app), both with paymaster `0x7777…834C` in the
  `UserOperationEvent`. **Re-confirmed 2026-10-10:** Ethereum Sepolia
  deposit 138,839,239,218,520,315,280 wei, staked false, stake 0; Base
  Sepolia staked true, stake 5 ETH, unstake delay 1,209,600 s.
- **Check.** `eth_call` the EntryPoint's `getDepositInfo(address)`
  (`0x5287ce12`) with the paymaster address.
- **Why it matters.** The record calls this an "EREP-050 risk with strict
  bundlers" (ERC-7562's rules for unstaked paymasters; the rule text was not
  re-read for this document): a stricter bundler than ZeroDev's could
  refuse these operations. Not a vulnerability.

### 8.5 ZeroDev's Arbitrum Sepolia bundler answered impossible gas estimates

- **Claim.** On Arbitrum Sepolia (chain 421614) on 2026-10-09, ZeroDev's
  `eth_estimateUserOperationGas` answered `verificationGasLimit` and
  `paymasterVerificationGasLimit` of `0x0`, with a constant `callGasLimit`
  of `0xcb36`, in about 27 of 35 samples, in bursts lasting tens of seconds;
  by upstream route, the record says "the Pimlico and Ultra Relay routes 4/4
  zero, the Alchemy route 4/4 real, Gelato TLS failure".
- **Status.** Observed live through the vendor's service; there is no
  transaction, because the first script attempt that signed such an
  estimate was stopped by the script's own EntryPoint preflight
  ("RPC error 3: execution reverted (eth_call)", revert data `0x`) before
  anything reached the bundler. Later in-app operations on Arbitrum Sepolia
  carried non-zero limits.
- **Check.** Needs a ZeroDev project: call `eth_estimateUserOperationGas`
  repeatedly on the chain-421614 endpoint for any Kernel operation and
  look for zero verification limits. The guards that now refuse such answers
  are in `kernel-smoke.mjs`, `token-gas-smoke.mjs` and the engine's
  `gasLimitProblems` (`packages/chains-evm/src/rpc.ts`).
- **Uncertainty.** The sampling script is not in the repository, and the
  record does not say how a route was selected. How a bundler treats a
  submitted zero-gas operation is unverified.

### 8.6 Audit coverage gaps for the modules above

- **"WeightedValidator @ 91f8fcb".** The v3.1 incremental audit (in the
  Kernel repository, `audits/v_3_1_incremental_audit.pdf`, period
  2024-05-27 to 2024-06-09, auditor named as Felix Kim) lists "Weighted
  Validator, File Location: WeightedValidator.sol, Commit Hash: 91f8fcb".
  The record says that commit could not be located in any ZeroDev
  repository (it does not list which repositories were searched). That
  audit also lists a minor "No Duplicate Address Verification in
  WeightedValidator and SpendingLimit", about guardian registration in that
  other contract, not the signature path of item A.
- **The deployed v3 guardian modules.** Kalos audited "Recovery Plugin and
  Weighted ECDSA" for Kernel v2 only (2023-12-12 and 2024-02-06); the v3
  port of `WeightedECDSAValidator` and the v3 `RecoveryAction` appear in no
  published report (F-21).
- **Permission policies and ECDSASigner.** No published report names
  `CallPolicy`, `TimestampPolicy`, `GasPolicy`, `RateLimitPolicy`,
  `SudoPolicy` or `ECDSASigner`; ZeroDev's documentation says "All ZeroDev
  contracts and plugins are audited unless otherwise noted" and linked an
  audits folder that returned 404 on 2026-10-01 (F-14).
- **WebAuthnValidator v0.0.3.** The v3.1 incremental audit covered the
  unpatched commit `ae10aa0f` and reported no WebAuthn finding; no audit of
  the patched v0.0.3 was found (F-18).
- **Kernel itself.** No audit of Kernel v3.2 or v3.3 or of the EIP-7702
  changes, and no bug bounty or security policy for Kernel, was found
  (`docs/AA_FRAMEWORKS.md` sections 8.3 and 8.5). This also means the record
  knows of no published disclosure channel for these contracts.

### 8.7 Other recorded observations about the same modules

Short entries, each from the record, none proposed for disclosure:

- **Threshold 0.** Phase 15 notes that no ZeroDev weighted validator refuses
  a threshold of 0 at install. For `0xeD89…eEEE` specifically, a zero
  threshold fails closed: `validateUserOp` returns failure (lines 198-200),
  `isValidSignatureWithSender` returns invalid (lines 282-284) and
  `approve` / `approveWithSig` revert (lines 143 and 158). `renew` also has
  no "threshold at most total weight" check (lines 121-139), which can lock
  guardians out but not let anyone in. The other weighted validators were
  not examined for this.
- **Paymaster path without a signature (F-23).** Per source (lines 253-256),
  an approved, delay-expired proposal executes with no signature when the
  operation names any paymaster. Reasoned from source, not run; the
  operation's calls are still fixed by the approved proposal.
- **Guardians can rewrite the guardian list (F-20 item 1).** `doRecovery`
  accepts any validator address and data, so enough guardian weight can
  replace the guardians too.
- **Passkey self-calls (F-19).** A passkey granted `execute` can call the
  account itself and so `changeRootValidator`; simulated (`selfCall`
  accepted in `passkey-smoke.mjs`).
- **SudoPolicy licence (F-15).** The verified source says
  `SPDX-License-Identifier: UNLICENSED` while the repository is MIT.
- **ZeroDev's 7702 quickstart (F-26)** passes a version constant where a
  contract address is expected.
- **RateLimitPolicy default.** With the SDK's default `startAt` of 0 every
  slot is already open, so the policy limits only the total count.
- **Sepolia Glamsterdam (F-65)**, context for reproducers rather than a
  vendor finding: since 2026-10-06 plain ETH transfers emit an EIP-7708 log
  from `0xfffffffffffffffffffffffffffffffffffffffe`, which geth and reth
  report differently in `eth_simulateV1`, and Kernel permission installs
  cost three to four times their earlier gas.

---

## 9. Where the record is thin or contradicts itself

The Chairperson asked to confirm each finding. These are the places where
the written record does not support its own wording, or gives too little to
check, with the exact words that prompted each note.

1. **Item A, multisig: "proven live" is not supported.** `AGENTS.md` (phase
   15 item 2) says: "PROVEN LIVE on the deployed 2-of-3: one signer with its
   signature duplicated → 0x1626ba7e, single → rejected".
   `docs/THREAT_MODEL.md` F-62 says: "on the live Sepolia 2-of-3
   `0xd927ac18Cd58D4E6DdfD8D97D0B3e78c64f28c57`, one signer duplicating its
   own signature made `isValidSignature` return `0x1626ba7e`".
   `docs/MULTISIG.md` section 1 says "section 9 shows a single signer
   satisfying a 2-of-3 message check live", but section 9 itself says "The
   ERC-1271 counterexample was proven in the dry run against the deployed
   account". The script (`multisig-smoke.mjs`) has the ERC-1271 check only in
   its dry run, which uses the public test vector's undeployed account
   (`0xFb635CE9…0679` on 2026-10-10), not `0xd927…8c57`; its live leg (L1
   to L4) makes no ERC-1271 call. This document records it as simulated.
   The guardian version of the same weakness (phase 8) was observed live.
2. **Item D is contradicted elsewhere in the record.** Phase 8 says the docs
   example "would OVERWRITE THE OWNER with the guardian (same validation
   id) — reasoned from source, not executed". Phase 11
   (`kernel-spending.ts`) says "the DEPLOYED validator's onInstall
   additionally reverts AlreadyInitialized(address) … unlike the v3.3
   repository file". The second is correct for both deployed ECDSA
   validators (re-confirmed 2026-10-10), which defeats the first.
3. **Item A's scope is worded too broadly in places.** Phase 8 says "A
   SINGLE GUARDIAN CAN SATISFY A 2-OF-2" and `docs/THREAT_MODEL.md` T-31
   says "a single guardian's signature repeated twice satisfies a two-of-two
   threshold", without saying "for message signatures". Phase 15 showed
   that operations de-duplicate signers, so a lone guardian cannot recover
   the account.
4. **The number of disclosure items is inconsistent.** The standing rules in
   `AGENTS.md` say "six findings, listed under the phase 14 status"; the
   phase 15 status says "seven findings"; the phase 13 status says "four
   findings" and the phase 11 status "now three findings". No single list
   of the seven exists in the record; the grouping A to G here follows the
   brief for this document.
5. **The live ERC-1271 observations left no retained evidence.** Phase 8's
   probe results are only in the narrative (no run record was written), and
   phase 14's are in a git-ignored local run record. Both were `eth_call`s
   against state that no longer exists, with keys that were discarded
   (phase 8) or belong to the project's private seed (phase 14). A vendor
   can reproduce them only through the simulations.
6. **Shortened identifiers.** The record shortens the phase 8 transaction
   and UserOperation hashes, the inheritance hashes and the WebAuthn v0.0.1
   and v0.0.2 addresses. The full values in this document were recovered
   on 2026-10-10 from the chain (phase 8), from the local run record
   (phase 14) and from the SDK commit the record cites (WebAuthn); each
   matches the shortened form.
7. **Item C was never executed against the affected contracts.** Only the
   patched contrast was simulated; the record's "Sepolia simulation:
   'dummyReplay' → AA24" refers to v0.0.3.
8. **Item 8.5 is thin.** The sampling that produced "about 27 of 35 samples"
   and the per-route counts is not in the repository, and the record does
   not say how a route was chosen.
9. **A misleading label in a run record.** The git-ignored multisig run
   records label the bundler refusal "(ERC-7562 / unstaked validator)" while
   the recorded error texts are "AA21 didn't pay prefund" and a priority-fee
   floor message. The label is a fixed string in the script;
   `docs/MULTISIG.md` section 9 states the cause correctly.
10. **Searches without a scope.** "No public advisory found" (item C), "no
    published audit found" (8.3, 8.6) and "91f8fcb … in no ZeroDev repo"
    (8.6) do not record where or when the search was made, beyond the cited
    pages.

---

## 10. Re-confirmation log, 2026-10-10

Everything below was read-only, against keyless public endpoints
(`ethereum-sepolia-rpc.publicnode.com`, `ethereum-rpc.publicnode.com`,
`base-sepolia-rpc.publicnode.com`, `arbitrum-sepolia-rpc.publicnode.com`,
`1rpc.io/sepolia` for two receipts), Sourcify's public API, and ZeroDev's
public documentation page. Sepolia's latest block during the checks was
about 11882008.

| What | Result |
|---|---|
| `recovery-smoke.mjs` dry run | Passed, parts A, B, C; repeated-signer probe valid |
| `multisig-smoke.mjs` dry run | All checks passed, (4a) and (4b) as stated |
| `inheritance-smoke.mjs` dry run | Passed, 58 checks, S1 and S8 as stated |
| `passkey-smoke.mjs` dry run | Passed; `dummyReplay` rejected by v0.0.3 |
| `spending-limit-smoke.mjs` dry run (public vector) | Passed; A4, A5, A6a, A6c, B2 as stated |
| `subscription-keeper.mjs dry-run` | Passed; batch residual accepted, 10 USDC under a 5 USDC cap |
| Weighted validator Sourcify source vs tag `v3.3` | Identical |
| `CallPolicy` Sourcify source vs `d4855f5` | Identical |
| Runtime code, mainnet and Sepolia | WebAuthn v0.0.3 hash as pinned; SpendingLimit hash as pinned; RecoveryAction 513 bytes, same hash both chains; CallPolicy, RateLimitPolicy, GasPolicy, ECDSA validator identical across chains |
| SpendingLimit bytecode (both deployments, both chains) | `PUSH4 0xaacbd72a` present, `PUSH4 0x173bf7da` absent |
| WebAuthn v0.0.1 / v0.0.2 Sourcify source | Dummy branch returns the P-256 result (line 156-157) |
| ECDSA validators `0x845A…cE57` and `0x8104…1c43` | Verified `onInstall` reverts `AlreadyInitialized`; Sepolia `eth_call` reverted as expected |
| Multisig `0xd927…8c57` `rootValidator()` | `0x01` followed by `0xeD89…eEEE` |
| Receipts (Sepolia) | Phase 8 guardian run (three), multisig (two), inheritance L1, L3, L5, L6, L7, L8, ERC-20 pull, Pimlico (two): all status `0x1`, UserOperation success where applicable |
| Receipt (Base Sepolia) | `0x83f5…b4cb`, block 47682905, paymaster Circle, success |
| Circle paymaster, Base Sepolia and Arbitrum Sepolia | `feeSpread` 0; `additionalGasCharge` 35,000; `fetchPrice` 3,000,000,000; oracle round 1, updated 2; staked 0.25 ETH, unstake delay 86,400 s |
| Pimlico paymaster deposit info | Ethereum Sepolia unstaked; Base Sepolia staked 5 ETH |
