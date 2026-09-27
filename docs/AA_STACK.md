# Account Abstraction Stack Selection (Phase 2, Task 3)

This document records what the wallet pins, what it deliberately keeps
configurable, and what remains to be verified during testnet integration.
It extends ADRs D4–D6 in ARCHITECTURE.md section 7.

## EntryPoint: pinned to v0.7

The wallet targets EntryPoint v0.7 at
`0x0000000071727De22E5E9d8BAf0edAc6f37da032`. This address is stated in the
eth-infinitism/account-abstraction v0.7.0 release notes and is canonical
across supported networks. The engine already treats the EntryPoint address
and hashing scheme as explicit parameters, so this is a default, not a
limit.

Newer EntryPoints exist (v0.8, March 2025, adds EIP-7702 support and
EIP-712-style hashing; v0.9, November 2025 per the release listing). The
release notes describe v0.9 as ABI-compatible with v0.8 and v0.7. We stay
on v0.7 for launch because bundler and paymaster support is broadest there;
adding a v0.8 hashing strategy is an additive change in
`packages/chains-evm` (a second `getUserOpHash` implementation selected by
EntryPoint version) and should be scheduled when EIP-7702 flows (Tier 2,
feature 23) are built, since that is what v0.8 enables.

## Account implementation

- **Testnet phase (now):** SimpleAccount v0.7, the canonical sample
  account. Our `createSimpleAccountSpec` already matches its verified
  behavior (EIP-191 owner signatures, `execute`/`executeBatch`,
  `createAccount(owner, salt)` factory). It is the fastest path to a real
  end-to-end UserOperation on a testnet and carries no vendor dependency.
- **Production target:** an audited ERC-7579 modular account, per ADR D6,
  because session keys, spending policies, passkey validators, and social
  recovery (Tier 2's differentiators) are modules in that model. Candidates
  to evaluate at selection time include Safe with the 7579 adapter,
  ZeroDev's Kernel, and Biconomy's Nexus; the selection criteria are:
  audit history and bounty program, module ecosystem maturity, ERC-7579
  compliance completeness, deployment coverage on our launch chains, and
  license. None of these facts are pinned here — they change quickly and
  must be verified against the vendors' current documentation and audit
  reports when the evaluation is done.
- The `SmartAccountSpec` interface is the seam: shipping a different
  account implementation is a new spec object, not an engine change.

## Factory addresses: configuration, verified at integration

The v0.7.0 release notes publish no canonical SimpleAccountFactory
address, so factory addresses are treated as per-chain configuration that
MUST be verified before use. An unverified address that Doge recalled from
memory failed verification against public sources and was therefore not
recorded anywhere — this is deliberate; a wrong factory address silently
produces wrong counterfactual addresses.

Verification procedure when pinning a factory on a chain:

1. `eth_getCode` on the address must return non-empty code.
2. Call `accountImplementation()` on the factory and `entryPoint()` on the
   returned implementation; the latter must equal the pinned EntryPoint.
3. Deploy one account on a testnet through the full wallet flow and
   confirm the on-chain address equals the factory's `getAddress` answer
   the engine used.

For the testnet smoke test, deploying our own SimpleAccountFactory from
the audited v0.7.0 sources is acceptable and removes any dependency on
third-party deployments.

## Bundler and paymaster vendors

The engine is vendor-neutral by construction (injected JSON-RPC
transports; ERC-7677 for paymasters; opaque vendor context). Vendors are
therefore an operations decision, not an architecture decision. Candidates
to evaluate include Pimlico, Alchemy, and Biconomy; criteria: EntryPoint
v0.7 support, ERC-7677 `pm_getPaymasterStubData`/`pm_getPaymasterData`
support, coverage of our launch chains, redundancy (we want two configured
per chain, primary plus fallback), rate limits and pricing, and testnet
availability. The testnet smoke test should run against at least one real
bundler to validate our RPC serialization against a production
implementation.

## What this unblocks

- Task 8 (testnet smoke test): needs a Sepolia (or Base Sepolia) bundler
  endpoint and either a verified public SimpleAccountFactory v0.7
  deployment or our own deployment of it.
- The app's EVM send flow can ship EOA sends immediately (EIP-1559 support
  landed in phase 2) and add the smart-account path once a bundler
  endpoint is configured.
