# Session Keys and the ERC-7579 Account Evaluation (Phase 5, Item 5)

This document is the Tier-2 moat groundwork promised in AA_STACK.md: an
evaluation of ERC-7579 modular accounts as the vehicle for session keys
and spending policies (Feature Universe items 18–19), and the interface
this wallet would expose them through. Research and design only; no
vendor is locked in, and every factual claim below carries its source.
Facts were gathered 2026-09-27 and change quickly; re-verify at
implementation time.

## Why ERC-7579 is the vehicle

Session keys and spending policies must be enforced BY THE ACCOUNT
ON-CHAIN, or they are marketing rather than security (Feature Universe
item 19: "a policy enforced by the account contract cannot be bypassed
even by malware that steals the daily-use key"). SimpleAccount — our
live-proven testnet baseline — validates a single owner signature and
nothing else, so it cannot express "this key may only call this
contract, under this cap, until Friday." ERC-7579 defines the minimal
standard interface for accounts whose validation and execution behavior
is extended by installable modules (validators, executors, hooks),
reached final status on the EIP track in 2024, and is the module
portability layer: modules written against it run on any compliant
account (sources: eco.com's ERC-7579 explainer; docs.safe.global
ERC-7579 overview).

## Candidate accounts (facts per Pimlico's account comparison,
docs.pimlico.io/guides/how-to/accounts/comparison, fetched 2026-09-27)

| Account | ERC-7579 | Adoption (accounts created, trailing 6 months) | Audits |
|---|---|---|---|
| Kernel v3 (ZeroDev) | yes | ~133k v3 (plus ~771k v2) | ChainLight, Kalos |
| Nexus (Biconomy) | yes | (not listed) | Cyfrin, Spearbit |
| Safe + Safe7579 adapter (Rhinestone) | yes | ~34k Safe | Safe: "secures over $100B+ in assets"; adapter exposes Rhinestone's audited module set |
| LightAccount (Alchemy) | no | ~7.3M | QuantStamp |
| SimpleAccount (reference) | no | ~1.5M | OpenZeppelin ("not a production-ready smart account") |

Session-key mechanics, verified against ZeroDev's permissions
documentation (docs.zerodev.app/sdk/permissions/intro): Kernel's model
is composable — "Permission = 1 signer + N policies + 1 action" — with
signers covering ECDSA, "WebAuthn (passkeys)" and multisig, and six
built-in policies (sudo, call, gas, signature, rate limit, timestamp).
That maps one-to-one onto our target features: session keys (a
delegated signer + call policy + timestamp policy), spending limits
(gas/call policies with parameter constraints), and passkey signers.
Rhinestone's module registry serves the same needs for Safe7579 and
Nexus (session key validators, spending limit executors, social
recovery — ethereum.org's Safe7579 listing and eco.com's Rhinestone
overview; the registry listed session-key validators and spending-limit
executors as of Q1 2026).

## Recommendation

1. **Primary implementation candidate: Kernel v3.** Best combination of
   ERC-7579 compliance, real adoption at v3, two named audits, and the
   most mature session-key ("permissions") developer surface. Its
   policy vocabulary covers items 18 and 19 without custom Solidity.
2. **Second source: Nexus.** Same standard, different vendor and
   auditors (Cyfrin, Spearbit) — a credible fallback that keeps us
   honest on portability, since 7579 modules are the compatibility
   layer, not the account brand.
3. **Treasury-grade option later: Safe + Safe7579.** Safe's asset base
   is the trust argument for high-value accounts (multi-sig product,
   Feature Universe item 24); heavier, and the adapter adds a layer, so
   not the default consumer account.
4. **SimpleAccount remains the testnet baseline** and proof rig; it is
   explicitly not production-ready per its own audit framing.

Selection gates before any code lands (same discipline as
AA_STACK.md): pin exact contract versions and audit reports, verify
factory + implementation on-chain via the existing procedure, and
byte-test our UserOperation signing against the account's validation
path on a testnet.

## What changes in our stack (and what deliberately does not)

- The engine seam holds: a Kernel account is a new `SmartAccountSpec`
  (its own factory args, `encodeCalls` for 7579 execution encoding, and
  its signature envelope) — SmartAccountClient, bundler/paymaster
  clients, gas padding, and the app's AA plumbing are unchanged.
  This is exactly the flexibility ADR D6 bought.
- Recovery invariant D1 holds: the seed-derived key stays the root
  validator; session keys are additive, revocable delegations. Backup
  copy in the app needs one honest addition: session grants do not
  survive on a restored device unless re-created (they are on-chain
  state, so funds safety is unaffected).
- New engine surface to design when implementation starts:

```ts
/** A delegated, on-chain-enforced permission for one session key. */
interface SessionGrant {
  /** The delegated signer (a fresh device-held key, never the seed). */
  sessionKey: DerivedAccount;
  /** Contract + selector allowlist, per Kernel call-policy semantics. */
  calls: Array<{ target: string; selectors?: string[] }>;
  /** Hard caps enforced by policy modules. */
  limits?: { valueWeiPerPeriod?: bigint; periodSeconds?: number };
  validUntil: number;
}

interface SessionCapableSpec extends SmartAccountSpec {
  encodeInstallSession(grant: SessionGrant): Call[];
  encodeRevokeSession(sessionKey: string): Call[];
  signWithSession(grant: SessionGrant, userOpHash: Uint8Array): Uint8Array;
}
```

## Out of scope here

Live integration, SDK dependency choices, and paymaster interplay for
sponsored session transactions — all follow once phase-5 wave 2 lands
and this evaluation's gates are run against current deployments.
