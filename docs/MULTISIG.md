# Multi-signature accounts (feature 24)

This document is the analysis and the build decision for multi-signature
("k-of-n signers must approve an operation") smart accounts, phase 15 item 2.
It was written for the Chairperson and for the engineers who will wire the
feature into the app. Every factual claim about a contract is taken from the
contract's own source, cited by file and line, and every behavioural claim
was exercised against the real deployed contracts on Sepolia (read-only
`eth_simulateV1`, or a live transaction whose hash is given in section 9).
The persona and compression rules do not apply to this file: it is plain,
full-sentence technical prose for a reader who was not present for the work.

## 1. Summary and recommendation

A multi-signature account can be built on ZeroDev's deployed
`WeightedECDSAValidator` installed as the **root** validator of a Kernel v3.3
account, and the engine groundwork for that is included in this phase
(`packages/chains-evm/src/kernel-multisig.ts`). It is honest and correct for
**transactions**: an operation requires a genuine k-of-n, and the engine, the
simulations and a live Sepolia operation all confirm that fewer signatures,
or the same signer counted twice, are refused.

It is **not** a correct k-of-n for **message signing** (ERC-1271), and this
cannot be fixed by any choice of weights. Section 4 proves that for every
threshold of two or more there is no weight assignment that makes the
message check as strong as the operation check, and section 9 shows a single
signer satisfying a 2-of-3 message check live. Because a wallet that presents
a multisig account as able to sign logins, orders or token permits would be
misstating the account's security, the engine spec deliberately omits
ERC-1271 signing for multisig accounts, and the app must tell the user that a
multisig account cannot be used for message signing.

**What was built:** a transaction-only k-of-n multisig spec on the deployed,
Sourcify-verified `WeightedECDSAValidator`, with signer-set validation, an
exposure calculator, the off-device co-signer request and approval format
with a strict parser, deployment and conversion encoders, and a smoke script
that proved the behaviour on Sepolia. **What was declined:** ERC-1271 message
signing for multisig accounts (impossible to do honestly on this module), and
any claim that the deployed module is a general-purpose multisig suitable for
dApp logins.

**Recommendation for a message-capable multisig later:** the cleanest path
is a module where every co-signer signs the full user operation and duplicate
signers are rejected, so the same k-of-n protects both operations and
messages. Section 7 compares the candidates. The Safe Smart Account with the
Safe4337Module is the strongest for correctness (every co-signer commits to
the whole operation, duplicate owners are rejected, the audited commit equals
the release, EntryPoint v0.7), but it is not an ERC-7579/Kernel account and
cannot be an EIP-7702 target. Rhinestone's `OwnableValidator` is an ERC-7579
validator that deduplicates signers and has each signer sign the full
userOpHash, so it would fix both problems on a Kernel account, but its
licence is AGPL-3.0 by its own header and the deployed bytecode is a
post-audit revision. ZeroDev's separate `WeightedValidator` v0.0.2 fixes the
ERC-1271 duplicate-counting but still has co-signers approve only the call
data and nonce, and no audit of the deployed v0.0.2 bytecode was found. None
of these is adopted in this phase; the engine groundwork uses the one module
whose source this project has fully verified.

## 2. How a weighted-root multisig works

Kernel v3.3 lets any validator module be the account's root validator.
`Kernel.initialize` and `Kernel.changeRootValidator` accept a validation id
of type `VALIDATION_TYPE_VALIDATOR` (`src/Kernel.sol` lines 119-122 and
145-148, kernel tag v3.3 commit `cd697c7e`), and the ECDSA validator the
wallet uses today is installed exactly this way. Installing ZeroDev's
`WeightedECDSAValidator` (`0xeD89244160CfE273800B58b1B534031699dFeEEE`) as the
root instead makes every operation subject to that validator's k-of-n check.

That validator is the same contract the wallet already uses for guardian
social recovery (`packages/chains-evm/src/kernel-recovery.ts`). It is a
Sourcify full match on Ethereum mainnet and a runtime match on Sepolia, and
its verified source is byte-identical to
`src/validator/WeightedECDSAValidator.sol` at v3.3 (checked 2026-10-09). The
install data is `abi.encode(address[] signers, uint24[] weights, uint24
threshold, uint48 delay)` with the signers in strictly descending address
order (`onInstall`, lines 85-95), which is the same bytes the ZeroDev SDK's
`getEnableData` produces; the engine's `encodeMultisigValidatorData` is
byte-pinned against that SDK vector in the tests.

For a single operation the validator's one-shot path
(`validateUserOp`, the `Ongoing && !passed` branch, lines 203-245) expects
the signature to be a concatenation of 65-byte ECDSA signatures: the first
`n-1` are over the EIP-712 `Approve(bytes32 callDataAndNonceHash)` digest and
the last is over the EIP-191 form of the userOpHash, where
`callDataAndNonceHash = keccak256(abi.encode(sender, callData, nonce))`. Each
recovered signer's weight is added once, and the operation passes when the
accumulated weight reaches the threshold.

## 3. Determination (a): operations are a correct k-of-n; the repeated-signer trick does not work here

The deployed `validateUserOp` marks each recovered signer's vote and skips a
signer that has already voted:

- In the `n-1` loop (lines 214-230) it recovers the signer, then
  `if (vote.status != VoteStatus.NA) { continue; }` before adding weight.
- For the final signature (lines 232-240) it checks
  `if (vote.status == VoteStatus.NA)` before adding weight.

So a coalition cannot reach the threshold by repeating one signer: the second
appearance of a signer adds nothing. This is the behaviour a multisig needs.

Simulated against the real EntryPoint v0.7, Kernel v3.3 and the validator on
Sepolia, for an undeployed 2-of-3 account (equal weights, threshold 2):

- An operation signed by **two distinct signers** is accepted
  (`UserOperationEvent success = true`).
- An operation signed by **one signer only** is refused
  (`FailedOp("AA24 signature error")`).
- An operation where the **same signer is used as both an approver and the
  final signer** is refused (`FailedOp("AA24 signature error")`), confirming
  the vote de-duplication.

These three results are the dry run of
`scripts/testnet/multisig-smoke.mjs`, and the two-distinct-signer case was
also proven in a live transaction (section 9).

## 4. Determination (b): message signing (ERC-1271) is broken, and no weights fix it

The validator's ERC-1271 entry point checks the threshold **before** it
checks the signer order (`isValidSignatureWithSender`, lines 292-303):

```
for (uint256 i = 0; i < sigCount; i++) {
    address signer = ECDSA.recover(hash, data[i * 65:(i + 1) * 65]);
    totalWeight += guardian[signer][msg.sender].weight;
    if (totalWeight >= strg.threshold) {
        return ERC1271_MAGICVALUE;      // threshold checked first
    }
    if (signer >= prevSigner) {
        return ERC1271_INVALID;         // order (and so duplicate) checked second
    }
    prevSigner = signer;
}
```

An attacker can therefore append one duplicate of the heaviest signer as the
last signature: its weight is added and the threshold test returns the magic
value before the order test would reject the duplicate. A coalition `C`
passes the message check when `weight(C) + max_weight(C) >= threshold`,
whereas an operation needs `weight(C) >= threshold`.

**Impossibility proof.** Sort the signer weights descending as
`w1 >= w2 >= ... >= wn` with threshold `T`. For an operation, the fewest
signers is the smallest `k` with `w1 + ... + wk >= T`. For a message, the
fewest distinct signers is the smallest `j` with
`(w1 + ... + wj) + w1 >= T` (the `j` heaviest plus one duplicate of the
heaviest). Suppose a weight assignment made the two equal at some `k >= 2`.
Then we would need both `w1 + ... + w_{k-1} < T` (so `k-1` signers are not
enough for a message, using the heaviest duplicate) and
`T <= w1 + ... + wk` (so `k` are enough for an operation). The first
inequality, written for the message bound at `j = k-1`, is
`(w1 + ... + w_{k-1}) + w1 < T`, which combined with `T <= w1 + ... + wk`
gives `(w1 + ... + w_{k-1}) + w1 < w1 + ... + w_{k-1} + wk`, i.e. `w1 < wk`.
But the weights are sorted descending, so `w1 >= wk`, a contradiction.
Therefore for every threshold `k >= 2` the message check needs at least one
fewer distinct signer than the operation check. With equal weights a k-of-n
is effectively a `(k-1)`-of-n for messages, and a single signer whose weight
is at least `ceil(T/2)` can sign a message alone.

The engine's `multisigExposure` computes both minima for any config; the
tests assert the proof for every equal-weight `k`-of-`n` with `2 <= k <= n`
and `n <= 10`, and the smoke script printed, for example, that a 2-of-2
needs 2 signers for an operation but 1 for a message, a 3-of-5 needs 3 versus
2, and a weighted "5 of (3,1,1)" needs 3 versus 1.

**Consequence for the build.** The engine's `createKernelMultisigSpec` does
not implement `signErc1271`, so the wallet never produces a multisig message
signature and never offers a multisig account for a login, an order or a
permit. The exported `MULTISIG_ERC1271_REFUSAL` string is the plain-language
explanation the app shows. Note that the account's on-chain `isValidSignature`
still accepts the weaker set (it is deployed code we do not control); the
mitigation is that the wallet does not present message signing for these
accounts and tells the user why.

## 5. Determination (b continued): what a co-signer actually approves

Even for operations, there is a limitation a user must understand. The
co-signers sign the `Approve(callDataAndNonceHash)` digest, and
`callDataAndNonceHash = keccak256(abi.encode(sender, callData, nonce))`. That
commits to **what** the account will do (the calls and the nonce) but **not**
to the gas limits, the gas fees, the paymaster, or any validity window; only
the final submitter's userOpHash signature covers those. A co-signer
therefore approves the action, while the submitter alone chooses what the
operation costs and who (if anyone) sponsors it. The engine records this in
the `MultisigSigningRequest` documentation and the app must state it on the
approval screen. By contrast, Safe's `SafeOp` and Rhinestone's
`OwnableValidator` have every signer commit to the full operation (section 7).

## 6. Determination (c): recovery and the other modules on a weighted-root account

A weighted-root account **cannot also use the wallet's existing guardian
social recovery**, because that recovery is built on the **same** validator
contract. Kernel keys a validation by the validator address (the validation
id is `0x01 || validator`, `ValidatorLib.validatorToIdentifier`), so the root
weighted validator and a guardian weighted validator would collide on one
validation id and one storage slot. This is the concrete form of the
collision warned about in the phase 8 guardian findings. A weighted-root
account would need a *different* recovery module (for example a second
weighted-validator deployment, or a different recovery design), which the
engine does not currently have.

Session keys and passkeys do **not** collide: a session permission is a
`VALIDATION_TYPE_PERMISSION` validation keyed by a permission id, and the
passkey validator is a different contract at a different address, so each has
its own validation id. They should install on a weighted-root account the
same way they install on an ECDSA-root account, though this was not exercised
live in this phase and is listed as unverified in section 11.

## 7 is about the delay; recovery note ends here.

## 7. Determination (d): a timelocked multisig is possible, with caveats

The validator's `delay` field turns the account into a timelocked multisig:
the signers first approve a proposal on-chain (`approve` or `approveWithSig`,
lines 141-178), the operation becomes valid only after `delay` seconds, and
during the wait the **account itself** can reject the proposal with
`veto(hash)` (lines 180-187). On a weighted-**root** account there is no
separate owner, so a "veto" is itself an operation that must pass the k-of-n;
the signer set vetoes itself, which is weaker than the guardian case where a
distinct owner vetoes. The `uint48` wrap described in
`kernel-recovery.ts` applies identically — `approve`/`approveWithSig` compute
`validAfter = uint48(block.timestamp + delay)` (lines 152 and 176), so a
delay at or above `2^48 - now` seconds wraps to the past and makes a takeover
valid immediately — and the engine's `validateMultisigConfig` refuses any
delay above `MAX_GUARDIAN_DELAY_SECONDS` (`2^32 - 1`, about 136 years) for the
same reason. The engine supports a non-zero delay in the config, but the
wallet's default multisig is `delay = 0` (the k signatures ride in one
operation).

## 8. Determination (e): alternatives, from their own sources

The facts below come from a parallel source review; each was read in the
named repository and version, or checked on-chain. "Read in source" and "read
on chain" are distinguished from inference.

### Safe Smart Account + Safe4337Module v0.3.0

- Licence LGPL-3.0-only (the SPDX header of `Safe.sol`, `OwnerManager.sol`
  and `Safe4337Module.sol`, and the repository `LICENSE`).
- Duplicate signers are rejected outright by a strictly-increasing owner rule
  (`Safe.sol` checkNSignatures, v1.4.1 line 331 / v1.5.0 line 338, error
  `GS026`), and the threshold is required to be between 1 and the owner count
  (`OwnerManager.sol`).
- Every co-signer commits to the whole operation: the `SafeOp` type hash
  (`Safe4337Module.sol` lines 50-53) covers `safe`, `nonce`, `initCode`,
  `callData`, both gas limits, `preVerificationGas`, both fee fields,
  `paymasterAndData`, `validAfter`, `validUntil` and `entryPoint`, and the
  domain binds the chain id. The module's own comment states that all user
  operation fields except the signature are represented.
- ERC-1271 uses the same k-of-n check through the fallback handler, bound to
  the chain id and the Safe address.
- EntryPoint v0.7 (the module's changelog and its `SUPPORTED_ENTRYPOINT()`,
  read on chain at `0x75cf…c226` on Sepolia).
- The v0.3.0 audit (Ackee) covers the exact release commit; the deployed
  Sepolia addresses are in `safe-deployments` / `safe-modules-deployments`
  and all have code.
- No released EIP-7702 support (the 7702 code is only on the main branch,
  unreleased), and the released singletons refuse `owner == address(this)`.

Safe is the strongest choice for a correct multisig that can also sign
messages, but it is not an ERC-7579/Kernel account, so adopting it means a
second account type in the engine (a new `SmartAccountSpec`, a different
ERC-1271 envelope and a different recovery story) rather than a Kernel module.

### Rhinestone OwnableValidator (ERC-7579 validator)

- The deployed bytecode's SPDX header is AGPL-3.0-only (the repository's
  `package.json` says GPL-3.0, a contradiction worth legal review); the
  bundled `CheckNSignatures` library is MIT.
- It deduplicates signers when validating (`signers.sort();
  signers.uniquifySorted();` with the comment "make sure a signer is not
  reused") and refuses a threshold of 0 or above the owner count.
- Every signer signs the EIP-191 form of the **full** userOpHash
  (`validateUserOp` passes `ECDSA.toEthSignedMessageHash(userOpHash)`), so
  all signers commit to the whole operation, and the ERC-1271 path uses the
  same threshold on the raw hash.
- It is an ERC-7579 validator (`isModuleType` reports a validator), so in
  principle it installs on a Kernel v3.3 account as a non-root or root
  validator; no source read names Kernel v3.3 specifically, and the
  installation was not tried in this phase.
- The audited revision (Ackee) is not the deployed bytecode: the deployed
  code is a later revision with an EIP-191 move, a stateless module type and
  a changed `CheckNSignatures` variant, and the module SDK carries two
  different addresses for it.

Rhinestone's validator would fix both the message-signing weakness and the
"co-signers do not cover fees" limitation on a Kernel account. The blockers
are the AGPL licence (a legal question for a closed-source app, already open
for other AGPL modules) and the gap between the audited and deployed code.

### ZeroDev WeightedValidator v0.0.2 (a different ZeroDev module)

- MIT (the Sourcify source header).
- Its ERC-1271 path enforces a strictly-increasing signer index **before**
  counting (so no duplicate counting), which fixes the specific bug the
  `WeightedECDSAValidator` has. Its v0.0.1 predecessor and the
  `MultiChainWeightedValidator` do not have that fix.
- But co-signers still sign only `Approve(callDataAndNonceHash)`; only the
  final signer covers the fees and gas, the same limitation as section 5.
- No `threshold == 0` check was found in any of the three ZeroDev weighted
  validators.
- The incremental audit that is referenced for a "WeightedValidator @ commit
  91f8fcb" points at a source file that could not be located in any ZeroDev
  repository, so there is no audit of the deployed v0.0.2 bytecode that was
  found.

### Coinbase Smart Wallet

- 1-of-N, not a threshold multisig (`grep threshold` finds nothing;
  `_isValidSignature` checks one owner), and it targets EntryPoint v0.6, so
  it does not fit this wallet's v0.7 pin.

## 9. Live evidence (Sepolia)

All runs used the dev wallet's seed on Sepolia; nothing on mainnet. The dev
EOA spent about 0.004 test ETH in total (well under the 0.008 budget), of
which about 0.0017 remains in the deployed multisig account for future
demonstrations.

The 2-of-3 account `0xd927ac18Cd58D4E6DdfD8D97D0B3e78c64f28c57` (dev seed
indices 0, 1 and 2, weight 1 each, threshold 2, index 77) was:

- Funded from the dev EOA (0.006 test ETH).
- Deployed and run through one operation (two distinct signers: index 1
  approved, index 0 submitted). ZeroDev's bundler declined the deployment for
  a prefund/fee reason, never for an ERC-7562 storage or stake reason, so the
  operation was self-bundled through `EntryPoint.handleOps`: transaction
  `0xb28a55de36be77d7d43c3220c43580523715ebbcea46d4f0078c6ced0a01b6c4`, block
  11879418, status `0x1`, with an `AccountDeployed` log and a
  `UserOperationEvent` whose success flag is true and whose sender is the
  account.
- Operated again, this time **through ZeroDev's bundler** once the priority
  fee was set above the bundler's floor: user operation hash
  `0x4b881c4e801ff633600ccac999643986444fdf0fd68c8af491019aef4565cf1a`,
  included in transaction
  `0x716bb33a2b1c8fa76a1cf55228fad6a5fd22e8079e164324ffd5244b5a37e508`, block
  11879423, status `0x1`, `UserOperationEvent` success true. This settles the
  open question: a real bundler accepts a weighted-**root** operation despite
  the validator being unstaked and writing storage keyed by the account as a
  non-first mapping key. The bundler's earlier rejections were all prefund or
  fee-floor errors, not the storage or stake rejections that ERC-7562 would
  have produced.

The account's `rootValidator()` reads `0x01` followed by the weighted
validator address, confirming on chain that the weighted validator is the
root. A one-signer operation was refused by the engine before it reached the
bundler ("the approvals plus the submitter reach weight 1, below the
threshold 2"), and the dry run confirmed the on-chain `AA24` refusal of a
one-signer and a duplicated-signer operation.

The ERC-1271 counterexample was proven in the dry run against the deployed
account: one signer, signing the account's wrapped message digest and
**duplicating** that single signature, makes `isValidSignature` return the
magic value `0x1626ba7e` for a 2-of-3 account, while the same signer's single,
non-duplicated signature is rejected.

## 10. What the engine provides

`packages/chains-evm/src/kernel-multisig.ts`:

- `validateMultisigConfig` — the signer-set rules (duplicate, zero and
  list-end addresses, weight and total-weight bounds, threshold bounds, the
  delay wrap bound), matching the deployed validator plus wallet policy.
- `multisigExposure` — the operation and message signer minima, so the app
  can show the exposure and justify refusing message signing.
- `encodeMultisigValidatorData`, `encodeKernelMultisigInitialize`,
  `predictKernelMultisigAddress`, `multisigFactoryArgs` — deploying a fresh
  multisig account, with the address cross-checked against the factory.
- `multisigChangeRootValidatorCall` — converting an existing account, with a
  prominent warning that the old root validator stays installed as a backdoor
  unless it is uninstalled in the same batch (so the wallet should prefer
  deploying a fresh account).
- `buildMultisigSigningRequest`, `parseMultisigSigningRequest`,
  `approveMultisigRequest`, `parseMultisigApproval`, `verifyMultisigApproval`
  — the off-device co-signer flow, a JSON request and approval format with a
  strict parser that re-derives every hash, mirroring the guardian recovery
  request format.
- `createKernelMultisigSpec` — a `SmartAccountSpec` for a transaction-only
  k-of-n, which re-verifies every co-signer approval against the final
  operation, refuses a submitter that is not a signer or that also appears in
  the approvals, refuses a combined weight below the threshold, and
  deliberately has no `signErc1271`.
- `MULTISIG_ERC1271_REFUSAL` — the plain-language reason message signing is
  not offered.

The test file `packages/chains-evm/test/kernel-multisig.test.ts` has 33 tests
(byte-pinned install data against the ZeroDev SDK, the exposure impossibility
proof, the request and approval round-trips and tamper rejection, and the
full spec pipeline through a fake bundler with signatures recovered by
ethers). The smoke script `scripts/testnet/multisig-smoke.mjs` has the dry run
and the live leg.

## 11. App design note (for a later slice)

- Offer a multisig account as a new account type, created by **deploying a
  fresh account** (not by converting an existing one, to avoid the leftover
  single-key backdoor). Show the signer list and the threshold; steer the
  user to a threshold of at least 2.
- Collect the other signers' approvals off-device with the request and
  approval JSON (a QR code or a file, exactly like guardian recovery), verify
  each with `verifyMultisigApproval`, and submit with the local signer as the
  submitter.
- Show the exposure prominently: a 2-of-2 can be signed for messages by one
  owner, and so on. State that a multisig account **cannot sign messages,
  logins or permits** (`MULTISIG_ERC1271_REFUSAL`), and route logins to a
  regular account.
- State that a co-signer approves the calls and the nonce but not the fees or
  the paymaster, which the submitter chooses.
- Keep it test-networks-only until the mainnet conditions C1-C3 in
  `docs/AA_FRAMEWORKS.md` are met: the weighted validator is unaudited in its
  shipped v3 form.
- A weighted-root account cannot use the existing guardian recovery; do not
  offer both on the same account.

## 12. Findings for the Chairperson and the disclosure list

- The `WeightedECDSAValidator`'s ERC-1271 check tests the threshold before the
  signer order, so a repeated signer satisfies a message check. This is
  already on the disclosure list as the guardian finding; it is restated here
  because it is the reason a weighted-root account cannot be a
  message-signing multisig. A single live counterexample (one signer, 2-of-3)
  is recorded in section 9.
- The deployed weighted validator and the ZeroDev weighted-validator family
  do not refuse a threshold of 0 at install (the engine refuses it in
  `validateMultisigConfig`).
- The incremental-audit reference to a "WeightedValidator @ 91f8fcb" points at
  a source file that is not present in any ZeroDev repository, so the audited
  source of ZeroDev's alternative weighted validator could not be confirmed.
- These add nothing new to spend on; they inform whether and how to disclose
  to ZeroDev / Offchain Labs, which remains the Chairperson's decision.

## 13. What is unverified

- Session keys, passkeys and a non-weighted recovery module on a
  weighted-root account were reasoned from the validation-id rules but not
  exercised live.
- Deployment of a weighted-root account **through a bundler** was not shown
  (ZeroDev declined it for a prefund/fee reason before any storage check, and
  the account was self-bundled); only post-deployment operations through the
  bundler were confirmed. A production multisig would need either a bundler
  that accepts the deployment with a sufficiently funded account or a
  self-bundled first operation.
- The timelocked (`delay > 0`) multisig path was not run live.
- The alternatives in section 7 were read from source and checked on chain
  but none was integrated or run.
