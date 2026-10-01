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

## Kernel v3 (ERC-7579 modular account), engine support

Phase 7 item 1 adds `createKernelAccountSpec` in
`packages/chains-evm/src/kernel-account.ts`: a second `SmartAccountSpec`
beside SimpleAccount for ZeroDev Kernel v3.3 with the ECDSA validator
installed as the root validator and the seed-derived EOA as its owner, so
the seed phrase still recovers the account (D1).

**Release pinned:** zerodevapp/kernel tag `v3.3`, commit
`cd697c7e21715d015e0643af22310a99aa17433b` (2025-04-03), the latest v3.x
tag. The repository's default branch is now Kernel v4, which targets
EntryPoint v0.9; it is a different product and is not what the engine
implements. Kernel v3.3 targets EntryPoint v0.7: its
`script/DeployKernel.s.sol` constructs the implementation with
`0x0000000071727De22E5E9d8BAf0edAc6f37da032`, and the deployed
implementation's `entrypoint()` returns that address.

**Addresses** (identical on Ethereum mainnet and Sepolia):

| Contract | Address | Source |
|---|---|---|
| Meta factory (FactoryStaker) | `0xd703aaE79538628d27099B8c4f621bE4CCd142d5` | kernel README "Addresses" v3.3; ZeroDev SDK `KernelVersionToAddressesMap["0.3.3"]` |
| KernelFactory | `0x2577507b78c2008Ff367261CB6285d44ba5eF2E9` | same |
| Kernel implementation | `0xd6CEDDe84be40893d153Be9d467CD6aD37875b28` | same |
| ECDSA validator | `0x845ADb2C711129d4f3966735eD98a9F09fC4cE57` | ZeroDev SDK `plugins/ecdsa/constants.ts` (">=0.3.1"); kernel README v3.1 table (the v3.2 and v3.3 tables do not repeat it) |

The ZeroDev SDK references are github.com/zerodevapp/sdk at commit
`cd7c05b53b6ae6bede7dfefe9e59fbddfadf0c0a`. docs.zerodev.app does not
publish an address table; it points to the kernel repository.

**On-chain verification, performed 2026-10-01** (read-only `eth_getCode`
and `eth_call` against `https://ethereum-sepolia-rpc.publicnode.com` and
`https://ethereum.publicnode.com`), with the same results on both chains:

1. All four addresses have code. The factory, meta factory and validator
   bytecode hashes are identical across the two chains; the
   implementation's differs, as expected, because its EIP-712 domain
   cache (chain id and address) is stored in immutables.
2. `factory.implementation()` returns the implementation above.
3. `implementation.entrypoint()` returns EntryPoint v0.7;
   `accountId()` returns `kernel.advanced.v0.3.3`; `eip712Domain()`
   returns name `Kernel`, version `0.3.3`.
4. `metaFactory.approved(factory)` is `true`, and the EntryPoint reports
   the meta factory as staked (0.1 ETH, 86400 s unstake delay).
5. `validator.isModuleType(1)` (validator) is `true`.
6. For the standard test mnemonic's owner `0x9858...Da94`, the factory's
   `getAddress` returns `0xB67b8b7cCA718EAC64d2b59ba568585A9FC69a42`
   (index 0) on both chains, equal to the engine's local CREATE2
   prediction and to `ethers.getCreate2Address`; EntryPoint
   `getSenderAddress` returns the same address for both the meta-factory
   and the direct-factory init code.
7. An engine-built, engine-signed deployment UserOperation (single and
   batch calls, both factory paths) simulated through
   `EntryPoint.handleOps` with a balance state override passed
   validation and emitted `UserOperationEvent` with `success = true`; a
   copy with one signature byte flipped reverted.

Steps 1 to 5 are automated as `verifyKernelDeployment(node, ...)` in the
engine; it is the Kernel counterpart of the factory procedure above and
must pass before any Kernel configuration is used on a new chain. The
spec's `getAddress` also refuses any factory answer that disagrees with
its local CREATE2 prediction, so a misconfigured or dishonest RPC cannot
make the wallet display an address the seed does not control.

**Encoding facts the spec relies on** (all cited in the module header):
`initialize(bytes21 rootValidator, address hook, bytes validatorData,
bytes hookData, bytes[] initConfig)` with root validator id
`0x01 || validator`, hook `address(0)`, validator data = the 20-byte
owner; salt = the account index as a big-endian `bytes32`; ERC-7579
`execute(bytes32 mode, bytes executionCalldata)` with callType `0x00`
(single, `abi.encodePacked(target, value, data)`) or `0x01` (batch,
`abi.encode(Execution[])`); validator selection through the nonce key
(key 0 = default mode, root validator), so the signature is a bare
65-byte ECDSA signature over the EIP-191 form of the userOpHash.

**Live smoke:** `scripts/testnet/kernel-smoke.mjs` deploys a Kernel
account on Sepolia through a real bundler and sends a second operation
from the deployed account; `KERNEL_SMOKE_DRY_RUN=1` runs the same build,
sign and EntryPoint simulation read-only with the public test mnemonic.
See the script header for the exact commands.

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
