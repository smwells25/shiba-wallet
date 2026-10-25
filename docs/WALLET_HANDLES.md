# Wallet handles (ENS names) and attestations

Phase 23 item 6 — feature 75 (a wallet handle) and feature 77 (attestations,
research only). Written 2026-10-25 by the engineer who built the engine half.
Every fact below names its source: a document at a pinned commit, a contract
read on Ethereum Sepolia, or a simulation. Nothing was sent to any network;
every on-chain step below was either a read (`eth_call`, `eth_getCode`,
`eth_getStorageAt`, `eth_getLogs`) or an `eth_simulateV1` simulation.

## 1. Summary and decisions

**What was found.** Registration on Ethereum Sepolia no longer goes through
the classic ENSv1 `ETHRegistrarController`. ENS's own deployments page says
Sepolia "runs the ENSv2 contracts" and that the ENSv1 contracts "still exist
on Sepolia but are no longer in use" (section 3). The ENSv2 registrar keeps
the commit-and-wait-then-register pattern, but it is paid in an **ERC-20
token, not ETH** — on Sepolia it accepts Circle's test USDC, which the
wallet already tracks. Records live on a **per-account resolver** the user
deploys through ENS's factory, and the primary name (the reverse record) is
still set through the **ENSv1** reverse registrar. All of this was checked
against the deployed contracts and then proven end to end in simulation:
the name resolves to the address, the address resolves back to the name,
exactly the quoted USDC leaves the account, and no allowance is left.

**What was built (engine only, no app files).**
`packages/chains-evm/src/ens-register.ts` (quote, owner resolver, the
two-step plan, the sub-name plan, the primary-name read),
`packages/chains-evm/test/ens-register.test.ts` (31 tests against captured
Sepolia answers), and `scripts/testnet/ens-register-smoke.mjs` (a dry run
that passed every check on 2026-10-25, and a live mode for the CTO).

**What it costs on Sepolia (2026-10-25).** A five-or-more-character name for
the minimum 28 days: **0.613701 USDC** (613,701 base units), the same figure
the registrar's own `NameRegistered` events show for other people's
registrations that day. Gas for the whole first registration from a regular
account, in simulation: **2,454,956** (resolver deployment 1,133,999; USDC
approval 137,757; commit 127,458; register 682,685; reverse record
373,057).

**Decisions for the Chairperson.**

1. **Which name the CTO registers live** (the name is permanent for its
   term and public). The live step is in section 9.
2. **Accept that the Sepolia deployment is a test deployment that has been
   redeployed before** (section 3.4): a name registered today may not
   survive a future Sepolia redeploy by ENS. Nothing the wallet can do
   prevents that.
3. **Payment token.** The wallet offers only Circle's Sepolia USDC. ENS's
   documentation points developers at its free-mint `MockUSDC` instead,
   which the wallet's Tokens screen already flags as a look-alike "USDC"
   (phase 18). Keep USDC-only (recommended) or also offer MockUSDC.
4. **Sub-name shape for the smart account** (section 6): a registered
   sub-name (a token of its own, about 1.6 million more gas) or a
   record-only sub-name (one record, but not a token and dependent on the
   parent's resolver). Recommended: record-only for the test networks.
5. **Attestations (feature 77): build nothing now** (section 11). The
   decision is whether a read-only "attestations about this address" view
   from a named list of attesters is wanted later, and which attesters.

Open questions are collected in section 12.

## 2. What a wallet handle can honestly be

A "handle" here is an ENS `.eth` name that (a) resolves to the wallet's
address — anyone typing the name into a wallet that resolves ENS on the same
network gets that address — and (b) is the address's **primary name**, so
wallets that show names for addresses show it.

What it is not:

- **Not a username the wallet controls or can recover.** The name is a
  token held by the account that registered it. It is lost if that account
  is lost; the recovery phrase restores it only because it restores the
  account.
- **Not on every network.** It is registered on Ethereum Sepolia and
  resolves through the Universal Resolver at `0xeEeE…EeEe` there. The
  wallet's existing name lookup (phase 14, `ens.ts`) already reads that
  resolver on Ethereum mainnet and Sepolia only.
- **Not private.** The name, its owner, its resolver, its records and the
  payment are public on-chain forever. Registering a handle publicly links
  a chosen word to the address and to every transaction it ever made.
- **Not permanent.** It has a term (minimum 28 days on Sepolia); after
  expiry plus a 28-day grace period anyone can register it.
- **Off-chain names are still refused.** Names that need CCIP-Read
  (EIP-3668), including every `*.base.eth`, stay refused as phase 14
  decided; this work does not change that.

**Mainnet.** ENS's deployments page says the ENSv2 contracts are deployed on
mainnet "ahead of the ENSv2 launch. Until the launch completes, resolution
and registrations on Mainnet continue through the ENSv1 contracts". The
module built here is for the ENSv2 Sepolia deployment only and refuses any
other chain. A mainnet handle today would need a separate ENSv1 path (ETH
payment, different contracts and record model), or waiting for the ENSv2
mainnet launch. Mainnet prices were not read on-chain; the ENSv2 pricing
the docs publish is $640 / $160 / $8 per year for 3 / 4 / 5+ characters,
with multi-year discounts (`src/pages/ensv2/eth-registrar.mdx`). Any mainnet
handle stays behind the mainnet conditions C1–C3 (docs/MAINNET_READINESS.md).

## 3. The Sepolia deployment

### 3.1 Which contracts, and why not the classic controller

ENS documentation, `github.com/ensdomains/docs` at `eb408b38`
(2026-10-24), `src/pages/learn/deployments.mdx`, read 2026-10-25:

> Sepolia runs the ENSv2 contracts: the Universal Resolver and the ENS apps
> for Sepolia resolve through this deployment.

> These ENSv1 contracts still exist on Sepolia but are no longer in use:
> the Universal Resolver and the ENS apps for Sepolia are linked against
> the ENSv2 deployment above.

The docs build pins the ENSv2 Sepolia address list to
`ensdomains/contracts-v2` at `07e55a05` ("merge commit of contracts-v2 PR
#460, deployment of 2026-10-01"; `scripts/ensv2-deployments.ts`), file
`contracts/docs/addresses/sepolia.md` ("Deployed at:
2026-10-01T07:55:02.016Z"). The classic ENSv1 `ETHRegistrarController`
(`0xfb3cE5D0…f968`, `ensdomains/ens-contracts` at `ebe0b848`,
`deployments/sepolia/ETHRegistrarController.json`) still has code but is
not what the Sepolia Universal Resolver reads for new `.eth` names.

### 3.2 The contracts the wallet uses

Every address was read on 2026-10-25 on two endpoints
(`ethereum-sepolia-rpc.publicnode.com`, Geth 1.17.9, and `sepolia.drpc.org`)
at block 11,991,368 and later: identical code on both. Sourcify status is
from `sourcify.dev/server/v2/contract/11155111/<address>` the same day
("exact_match" = full match; "match" = partial, the source verified but the
metadata hash differs).

| Contract | Address | Code | Sourcify |
| --- | --- | --- | --- |
| ETHRegistrar | `0xf633e7FC17e2bbE0D0965D18ec1821dcB754a3d3` | 8,037 B | match |
| ETHRegistry (.eth PermissionedRegistry) | `0xD4eBcbBdF463C9c45784603Db0dDD499BC44A8B4` | 16,000 B | exact_match |
| RootRegistry | `0xB458D6a3a77919449d03e7A6903C26827c1eC43f` | 16,000 B | exact_match |
| StandardRentPriceOracle | `0x8196665D4ca7488B6474a9EC8E7d2719FB42263A` | 8,355 B | match |
| VerifiableFactory | `0xDa70306C98E97eCe36F997a21368e53298572991` | 1,524 B | exact_match |
| its proxyLogic() | `0xC41576B4B809B99CF0fF2e5B41b4F147cd9b6BDd` | 1,357 B | (not queried) |
| PermissionedResolver implementation | `0x115eb53F0c60696633855F90b138178Fb40b2b2C` | 15,608 B | match |
| UserRegistry implementation | `0x9BD8a88719068D09ecee662f36C0E3856708366a` | 18,982 B | exact_match |
| Universal Resolver proxy | `0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe` | 2,491 B | exact_match |
| ManagedUniversalResolverProxy | `0x6d80F2172CFdEc5730fE683860C33d26fC42e6F1` | 2,612 B | exact_match |
| UniversalResolverV2 | `0x24E1D8e068620B647CA097f961A61055f4f42D72` | 18,792 B | match |
| ENSV1Resolver (reverse mirror) | `0x322B7581cA210a69c6D0e0D7c88a7688D2789Cb0` | 11,102 B | match |
| ENSv1 ReverseRegistrar | `0xA0a1AbcDAe1a2a4A2EF8e9113Ff0e02DD81DC0C6` | 3,382 B | exact_match |
| ENSv1 PublicResolver (its default resolver) | `0xE99638b40E4Fff0129D56f03b55b6bbC4BBE49b5` | 14,512 B | exact_match |
| Circle USDC (payment token) | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` | 1,798 B | (not queried) |

The ENSv1 addresses come from `ensdomains/ens-contracts` at `ebe0b848`
(the `staging` branch the docs call the source of truth),
`deployments/sepolia/ReverseRegistrar.json` and `PublicResolver.json`.

### 3.3 The identity reads (the chain agrees with the documents)

All read 2026-10-25 and re-checked by every run of the smoke script:

- The Universal Resolver proxy's ERC-1967 implementation slot holds
  `0x6d80…e6F1`, whose slot holds `0x24E1…2D72` (`implementation()` agrees).
- `UniversalResolverV2.ROOT_REGISTRY()` = `0xB458…C43f`;
  `root.getSubregistry("eth")` = the ETHRegistry above;
  `root.getResolver("reverse")` = the ENSV1Resolver above.
- `ETHRegistry.hasRootRoles(REGISTRAR | RENEW, ETHRegistrar)` = true; the
  registrar's `ETH_REGISTRY()` and `rentPriceOracle()` are the pinned
  contracts and it supports interface `0xc1401b80` (IETHRegistrar).
- The registrar is in use: `NameRegistered` events on 2026-10-25 at blocks
  11,991,006, 11,991,045 and 11,991,195 (for example tx
  `0xc4ae42827491a111ae0e8cea3c8bfc903412e81b9596b23aee01c28ac3815e7a`),
  each paid in Circle's USDC, base 613,701 for 2,419,200 seconds.
- `VerifiableFactory.proxyLogic()` = `0xC415…6BDd`; the factory's own
  `predictProxyAddress` equals the engine's computation (captured in the
  tests).
- The v1 ReverseRegistrar's `defaultResolver()` is the v1 PublicResolver
  above, it owns `addr.reverse` in the v1 registry, and it lists the ENSv2
  `ReverseRegistrarAdapter` as a controller.
- The oracle: `isPaymentToken(USDC)` = true with ratio (1, 1,000,000);
  MockUSDC `0x240b…14aa` true (1, 1,000,000); MockDAI `0xF6fa…572b` true
  (1,000,000, 1); `0x16f9…aA8e` false.

### 3.4 Things the record must not hide

- **The verified registrar source is not byte-identical to the pinned
  commit.** The registrar's own files (`ETHRegistrar.sol`,
  `AbstractETHRegistrar.sol`, `IETHRegistrar.sol`) are identical to
  `07e55a05`; five interface or library files differ
  (`IEnhancedAccessControl.sol`, `IPermissionedRegistry.sol`,
  `IStandardRegistry.sol`, `ITokenizedRegistry.sol`, `RegistryRolesLib.sol`).
  The differences read are interface reshuffles and the removal of the
  `UNEMANCIPATED_ROLE_BITMAP` constant; the role bit values the registrar
  grants are unchanged. Inference: the registrar was compiled from a
  slightly older tree than the registry. The ETHRegistry, oracle,
  PermissionedResolver and UserRegistry sources match `07e55a05` file for
  file.
- **Contradictory addresses in ENS's own repository.** At the same commit,
  `contracts/script/deploy-constants.ts` names `SEPOLIA_MOCK_USDC =
  0x16f9…aA8e` as "accepted by the live rent price oracle", but the oracle
  answers false for it and true for `0x240b…14aa` (the address list's
  MockUSDC). The chain was trusted, not the comment.
- **Redeploys.** The same constants file says "Archived deployment
  namespaces carry their own MockUSDC instances that the live oracle
  rejects"; the address list itself is titled a "redeploy". Sepolia's ENSv2
  has been redeployed before, and ENS does not promise that names
  registered on one deployment survive the next.
- **Who controls it on Sepolia.** The registrar's `owner()` and
  `BENEFICIARY()` are `0x84D3…39D3`, which has no code (a single key); the
  owner can replace the price oracle (`setRentPriceOracle`). The Universal
  Resolver proxy's `admin()` is `0x6942…556F` and the managed proxy's
  `admin()` is `0xffFf…8f80`; neither has code. Either admin can upgrade
  what every Sepolia name resolves to (`UpgradableUniversalResolverProxy.sol`
  `upgradeTo`, `onlyAdmin`). Mainnet governance was not read.
- **Audits.** The `contracts-v2` repository has branches named
  `audit-results`, `audit-results-2` and `audit-results-19102026`
  (`git ls-remote`, 2026-10-25); their contents and the commits any audit
  covered were **not** read.

## 4. The registration flow and its waits

From `contracts-v2` at `07e55a05`, `contracts/src/registrar/ETHRegistrar.sol`
and the docs' `src/pages/ensv2/eth-registrar.mdx`:

1. **Commit.** `commit(bytes32)` records
   `makeCommitment(label, owner, secret, subregistry, resolver, duration,
   referrer)` = `keccak256(abi.encode(...))` of those seven values (lines
   204–221) with the block's timestamp. A fresh 32-byte random secret makes
   the commitment reveal nothing about the name.
2. **Wait.** `register` succeeds only when `commitTime + 60 ≤
   block.timestamp < commitTime + 86,400` (lines 230–242;
   `MIN_COMMITMENT_AGE` = 60 and `MAX_COMMITMENT_AGE` = 86,400 read
   on-chain). Too early reverts `CommitmentTooNew(bytes32,uint64,uint64)`
   (`0x6be614e3`), too late or unknown reverts `CommitmentTooOld`
   (`0x0cb9df3f`). The wait is real: a block must be produced at least 60
   seconds after the commit's block.
3. **Register.** `register(label, owner, secret, subregistry, resolver,
   duration, paymentToken, referrer)` re-derives the commitment, consumes it,
   checks availability and `duration ≥ MIN_REGISTER_DURATION` (2,419,200 s =
   28 days), prices the name, pulls `base + premium` of the payment token
   from **msg.sender** with `safeTransferFrom` to the beneficiary (line 150),
   and mints the name to `owner` with a fixed role set (set subregistry, set
   resolver and their admins, transfer admin). It sets the resolver but
   writes **no records**; it takes **no ETH**.

**Name rules.** The oracle prices labels of three or more characters
(`getBaseRates()` reads `[0, 0, 640/yr, 160/yr, 8/yr]` in 1e-12 USD per
second; a zero rate reverts `NotValid(string)`). The registrar does not
normalise: the oracle's `isValid` "Does not check if normalized"
(`StandardRentPriceOracle.sol` 272–277) and `register` accepts any 1–255-byte
label (`LabelStore.setLabel` → `NameCoder.assertLabelSize`). The wallet
therefore runs every label through its own conservative normaliser from
phase 14 (ASCII a–z, 0–9 and hyphen; no `--` in positions 3–4; proven equal
to ethers' `ensNormalize`) and refuses anything else, so it never pays for a
name a normalising client could not resolve.

**Price.** `StandardRentPriceOracle.getRegisterPrice` (lines 297–316):
base = rate(length) × duration, discounted for long terms (points at 2, 3 and
6 years: 7/8, 11/16, 9/16 of the price); a premium for names that expired
less than 21 days after their grace period, starting near $100 million and
halving daily (`LibHalving`); converted to the token with
`Math.mulDiv(…, Ceil)`. The engine mirrors this in exact bigint arithmetic
and reproduces 76 captured oracle answers exactly, including premiums at
ten points of the decay curve and both a 6-decimal and an 18-decimal token.
The quote refuses any name with a premium (its price falls by the minute;
an exact approval cannot follow it), so the approval always equals what
`register` pulls.

## 5. Records and the primary name

**Per-account resolver.** ENS's docs
(`src/pages/ensv2/permissioned-resolver.mdx`): "In ENSv2, each account gets
its own resolver instance, deployed as a UUPS-upgradeable proxy." It is
deployed with `VerifiableFactory.deployProxy(implementation, salt, data)`
(`ensdomains/verifiable-factory` at `c1090aec`, `src/VerifiableFactory.sol`
32–46): CREATE2 with `outerSalt = keccak256(abi.encode(msg.sender, salt))`,
so only the owner can create it at its address. The docs' salt convention
is `keccak256(abi.encode(keccak256("OwnedResolver"), owner, 0))`
(`verifiable-factory.mdx`); following it lets other ENS tools find the same
resolver. `initialize(grants, calls)` grants the owner every role and runs
`setAddress(dnsName, 60, owner)` during initialisation, so the record is in
place before the name exists — harmless, because the name points at the
resolver only once `register` succeeds. If the owner's resolver already
exists, the wallet first proves it is the factory's PermissionedResolver
proxy (`verifyContract` returns the pinned implementation) and that the
owner holds `ROLE_SET_ADDRESS` (`hasRootRoles(1, owner)`), then uses
`setAddress` directly.

**Primary name.** `src/pages/ensv2/reverse-resolution.mdx`: "At launch,
the reverse namespace (addr.reverse, default.reverse) stays on v1
infrastructure … Users update their reverse record via the v1
ReverseRegistrar". The wallet calls the v1 ReverseRegistrar's
`setName(string)`, which names **msg.sender**. The Universal Resolver's
`reverse(address, 60)` then returns the name — and, per
`tutorial-app-developers.mdx`, "during reverse resolution it forward-resolves
the returned name and reverts with ReverseAddressMismatch if the addresses
differ", so a name returned is already proven to point back. An address with
no primary name answers `("", 0x0, the ENSV1Resolver)` (read live).

**What other wallets show.** Any client that resolves ENS on Sepolia through
the Universal Resolver sees the name → address and address → name mappings
the simulation produced. The docs say libraries need an "ENSv2-ready
version"; which versions of which wallets that is was **not** verified (an
open question). The wallet's own `resolveEnsAddress` (phase 14) reads the
same proxy and decodes the same `(bytes, address)` answer shape; a live
check on 2026-10-25 still resolves `nick.eth` (an ENSv1 name, through the
ENSV1Resolver mirror) to `0xb8c2…67d5`.

## 6. A sub-name for the smart account

Design: the regular account owns `<label>.eth`; the smart account gets
`smart.<label>.eth`, owned by the same regular account and pointing at the
smart account's address. Both shapes below were simulated after a
registration on 2026-10-25 and resolved through the Universal Resolver to
the target (the dev Kernel account `0xc995…C5AC`, which has code on
Sepolia):

- **Registered** (four calls from the owner; gas 903,322 + 139,588 +
  271,654 + 273,164): the owner's own `UserRegistry` for the parent, deployed
  through the factory with the docs' `keccak256("UserRegistry", namehash,
  0)` salt; `ETHRegistry.setSubregistry(labelhash, registry)` (the registrant
  holds `ROLE_SET_SUBREGISTRY`); `UserRegistry.register("smart", owner, 0,
  resolver, 0, parentExpiry)`; and the address record. The sub-name is then
  an ERC-1155 token of its own that lives as long as the parent.
- **Record-only** (one call; 273,164 gas): only `setAddress` for
  `smart.<label>.eth` on the owner's resolver. `LibResolution.findResolver`
  keeps the nearest resolver it found (the parent's), and the
  PermissionedResolver supports `IExtendedResolver` (`0x9061b923`, read
  live), so it answers for the sub-name. It is not a token, has no owner of
  its own, and follows the parent's resolver if that ever changes.

**The smart account's own primary name** must be set by the smart account
itself (a UserOperation calling the v1 ReverseRegistrar's `setName`),
because `setName` names msg.sender. Simulated from the Kernel's address, it
works and `reverse(kernel, 60)` returns the sub-name in both shapes.
Also simulated: registering a name with a deployed Kernel account as the
owner succeeds (its ERC-1155 receiver hook accepts the token).

## 7. The engine module (for the app half)

`packages/chains-evm/src/ens-register.ts`, exported from the package index:

- `checkEnsHandleLabel(input)` — "alice" or "alice.eth" → the label, or the
  refusal (`too-short`, `not-second-level`, `not-eth`, `label-extension`,
  `not-ascii-subset`, `too-long`, `empty`).
- `quoteEnsRegistration(transport, {label, owner, duration})` — one block:
  chain id 11155111, the registrar's configuration equal to the values the
  wallet was written against, availability, the registrar's price, the
  engine's mirror of it, premium refused. Returns the exact USDC total.
- `readEnsOwnedResolver(transport, owner)` — the conventional resolver
  address and whether it exists (and is usable).
- `newEnsCommitSecret()` and `planEnsRegistration({quote, resolver, secret,
  setReverse})` — two steps of `{to, value, data}` calls: **prepare**
  (resolver + record, exact approval, commit) and **register** (register +
  primary name). A regular account sends each call as its own transaction
  (`prepareEvmSend` takes one call); a smart account sends each step as one
  batch (`prepareAaCalls`). Every call must come from the owner itself.
- `checkEnsRegisterReady(transport, plan)` — the commitment on-chain and
  inside its window, the name still available; `ensRegisterWindow` /
  `ensRegisterTiming` for the screen's countdown.
- `planEnsSubname({...})` — either sub-name shape, plus the target's own
  `setName` call.
- `readEnsPrimaryName(transport, address, chainId)` — `none` / `ok` /
  `unsupported` (outside the ASCII subset; not displayed) / `offchain`.
- Prices: `ensRegisterPrice`, `ensLibHalving`, `ensApplyDiscount`; reverts:
  `classifyEnsRegisterRevert`.

What the app half must add (not built): a readiness row (test networks only);
storing the plan between the two steps — the **secret must be kept until
register and never shown or shared** (anyone who learns it and the
commitment before register can front-run the name; afterwards it is
worthless), so it belongs in the wallet-scoped store, not a log; the
two-step screen with the honest wait ("at least a minute; up to a day");
`setName` only from the account being named; the record-only sub-name by
default; the Home / Receive display through `readEnsPrimaryName`.

## 8. Dry run results (2026-10-25)

`ENS_SENDER=0x16DA…C5C node scripts/testnet/ens-register-smoke.mjs` —
ALL CHECKS PASSED, nothing signed or sent:

- every pinned address has code on both endpoints; every identity read in
  section 3.3 holds; the registrar's configuration matches;
- quote for a fresh label: 0.613701 USDC, premium 0, the registrar's figure
  equal to the engine's mirror; the dev EOA holds 20.4 USDC;
- the resolver address equals the factory's `predictProxyAddress`; the
  commitment equals the registrar's `makeCommitment`;
- **the wait is handled with simulated block times**: `eth_simulateV1`
  accepts `blockOverrides.time` per simulated block on PublicNode, so the
  prepare calls run in a block at time T and the register calls in a second
  block. At T + 59 `register` reverts `CommitmentTooNew`; at T + 60 it
  succeeds, the registrar pulls exactly 613,701 USDC base units from the
  sender to its beneficiary, `setName` succeeds, `resolve(name, addr)`
  returns the sender through the new resolver, `reverse(sender, 60)`
  returns the name, and the USDC allowance is 0;
- negatives: an uncommitted secret reverts `CommitmentTooOld`; an approval
  one unit short reverts ("ERC20: transfer amount exceeds allowance");
  registering the same commitment twice, the second reverts;
- both sub-name shapes resolve to the dev Kernel account, and the Kernel's
  own `setName` makes `reverse(kernel, 60)` return the sub-name.

## 9. The live step proposed for the CTO

Prerequisites (read 2026-10-25): the dev EOA holds 20.4 USDC and about
0.0408 test ETH on Sepolia; it has no resolver yet.

```
ENS_LIVE=1 ENS_LABEL=<the chosen label> ENS_LIVE_SUBNAME=record-only \
  node scripts/testnet/ens-register-smoke.mjs
```

It runs the full dry run first and stops on any failure. Then, from the dev
EOA: (1) the resolver deployment with the address record, (2) the exact
USDC approval, (3) the commit — each simulated first, each receipt read on
two endpoints; it waits until a block is at least 60 s after the commit,
re-checks readiness and simulates; (4) `register`, (5) `setName`; verifies
forward and reverse resolution on both endpoints and through the engine's
`readEnsPrimaryName`; (6) the record-only sub-name `smart.<label>.eth` →
the dev Kernel account. Caps: fee ≤ 1 USDC (`ENS_MAX_FEE_USDC`), duration
28 days (`ENS_DURATION_SECONDS`), all gas together ≤ 0.02 ETH. The run
record (with the secret until register is mined) is the git-ignored
`scripts/testnet/runs/ens-register-run.json`; `ENS_RESUME=1` continues after
an interruption between commit and register. Expected spend: 0.613701 USDC
and about 2.7 million gas (at the base fee Sepolia shows today, a small
fraction of the cap). The Kernel's own primary name is not part of this step
(it needs a UserOperation; the app half or a later script).

## 10. Gas and cost notes

The resolver deployment (1.13 million gas) and the reverse record (373,057)
are dominated by new storage after Glamsterdam (EIP-8037), as phase 15
recorded for every new slot on Sepolia. A second name for the same account
skips the deployment (a `setAddress` of about 273,000 gas instead). A smart
account pays these through the bundler at its usual headroom price.

## 11. Attestations (feature 77) — research

### 11.1 The deployment

Ethereum Attestation Service, `github.com/ethereum-attestation-service/eas-contracts`
at `e6e97028` (2026-07-17), `README.md` "Sepolia": EAS
`0xC2679fBD37d54388Ce493F1DB75320D236e1815e` and SchemaRegistry
`0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0` (version 0.26), EIP712Proxy
`0x9C9d17bEE150E4eCDf3b99baFA62c08Cb30E82BC` and Indexer
`0xaEF4103A04090071165F78D45D83A0C0782c2B2a` (version 1.2.0). Licence: MIT
(README "License").

Read 2026-10-25 on PublicNode and dRPC: code at all four (19,971 / 1,976 /
10,263 / 4,298 bytes, identical on both); Sourcify "match" for all four;
`EAS.getSchemaRegistry()` = the SchemaRegistry; the proxy's `version()` =
"1.2.0", `getName()` = "EIP712Proxy", `getEAS()` = the EAS contract; the
Indexer's `getEAS()` = the EAS contract. The EAS contract (Sourcify source,
`contracts/EAS.sol`, solc 0.8.18) declares `VERSION = "0.26"` and has no
owner and no upgrade function: once deployed, nobody can change it. In use:
150 `Attested` events in the 10,000 blocks before block 11,991,462, the
latest at block 11,990,933.

### 11.2 What an attestation is

From the verified source's interface (`IEAS.sol`, the function list of
`EAS.sol`; the function bodies were not audited for this record): `attest`
takes an `AttestationRequest` whose data carries recipient, expiration
time, revocable flag, reference UID, schema-specific data and value;
`revoke`, delegated variants (`attestByDelegation`, `revokeByDelegation`),
batch variants, and `timestamp` / `revokeOffchain` functions for off-chain
attestations exist; schemas are registered in the SchemaRegistry (README:
"allows anyone to register a schema … and then make attestations following
their schema"). The contract does not judge truth: an attestation means exactly as much as the reader's trust in **who
attested**. All on-chain attestation data is public and permanent.

### 11.3 Candidate uses for this wallet, and the honest view

- **Ownership of a handle.** Redundant: the ENS registry itself is the
  on-chain proof that the address holds the name, and the Universal
  Resolver's reverse check proves the pairing. An attestation would add a
  second, weaker copy.
- **A guardian relationship.** Harmful to privacy: guardian addresses are
  already in the account's module storage, but an attestation would publish
  an indexed, labelled "X is a guardian of Y" record for anyone to search.
  Guardian recovery does not need it.
- **A merchant's receipt.** Plausible but not the wallet's to make: the
  merchant would attest that a payment was received; the wallet could only
  display it, and only from merchants the user chooses to trust. It also
  publishes the commercial relationship.
- **Reading attestations about the user's address** (for example identity
  or "verified human" attesters on main networks). The only use with clear
  value, but it needs a choice of attesters to trust (an input), an indexer
  or the on-chain Indexer, and a privacy note; and the well-known attesters
  operate on main networks, which keeps it behind C1–C3.

### 11.4 Recommendation

Build nothing for feature 77 now. If wanted later: a read-only "attestations
about this address" view limited to a named list of attesters the
Chairperson approves, on test networks first, never writing attestations
for the user. **Decision for the Chairperson:** whether that view is wanted
and from which attesters.

## 12. Open questions

1. Which label the CTO registers live, and for how long (the minimum is 28
   days).
2. Is the risk that a Sepolia ENSv2 redeploy drops the name acceptable?
3. USDC-only payment, or also ENS's MockUSDC (a token the wallet flags as a
   look-alike)?
4. Registered or record-only sub-name for the smart account?
5. Which ENSv2-ready library versions other wallets need to show these
   names — not verified; ENS's readiness page lists them
   (`src/pages/web/ensv2-readiness.mdx`), not read for this record.
6. Should the app also set the smart account's own primary name (a
   UserOperation), or leave the sub-name forward-only?
7. Mainnet: build an ENSv1 path now, or wait for the ENSv2 mainnet launch?
   Mainnet prices and governance were not read.
8. Which ENSv2 audits exist and which commits they cover (branches exist;
   contents not read).
9. Feature 77: is a read-only attestation view wanted, and from which
   attesters?

## 13. Sources

- ENS documentation, `github.com/ensdomains/docs` at
  `eb408b3871627eb54d103fb194f16929075eadc5` (2026-10-24), read 2026-10-25:
  `src/pages/learn/deployments.mdx`, `src/pages/ensv2/eth-registrar.mdx`,
  `src/pages/ensv2/tutorial-app-developers.mdx`,
  `src/pages/ensv2/permissioned-resolver.mdx`,
  `src/pages/ensv2/verifiable-factory.mdx`,
  `src/pages/ensv2/reverse-resolution.mdx`, `scripts/ensv2-deployments.ts`.
- ENSv2 contracts, `github.com/ensdomains/contracts-v2` at
  `07e55a056f5b6a9c90119f501bdd05714e67dddd` (2026-10-02, "Sepolia v2
  redeploy (2026-10-01) and fixes from the live run (#460)"):
  `contracts/docs/addresses/sepolia.md`,
  `contracts/src/registrar/ETHRegistrar.sol`, `AbstractETHRegistrar.sol`,
  `StandardRentPriceOracle.sol`, `libraries/LibHalving.sol`,
  `interfaces/IETHRegistrar.sol`, `IETHRenewer.sol`, `IRentPriceOracle.sol`;
  `contracts/src/registry/PermissionedRegistry.sol`, `UserRegistry.sol`;
  `contracts/src/resolver/PermissionedResolver.sol`, `PublicResolverV2.sol`;
  `contracts/src/universalResolver/libraries/LibResolution.sol`,
  `UpgradableUniversalResolverProxy.sol`, `AbstractNormalizedUniversalResolver.sol`;
  `contracts/src/utils/LibLabel.sol`, `LabelStore.sol`;
  `contracts/deploy/03_ETHRegistrar.ts`, `01_StandardRentPriceOracle.ts`,
  `00_MockTokens.ts`, `testnet/00_setup_oracle.ts`;
  `contracts/script/deploy-constants.ts`.
- `github.com/ensdomains/verifiable-factory` at
  `c1090aec465ab30d494c96bd7d2a147b4f0b0173` (2026-09-23):
  `src/VerifiableFactory.sol`, `src/CloneProxyBytecode.sol`.
- `github.com/ensdomains/ens-contracts` at
  `ebe0b84852134c6236727defc0704471215c23c0` (staging, 2026-10-23):
  `deployments/sepolia/*.json`.
- `github.com/ethereum-attestation-service/eas-contracts` at
  `e6e970286ff18bbdfc5d8eff2742c5ece46040e4` (2026-07-17): `README.md`.
- Sourcify, `sourcify.dev/server/v2/contract/11155111/<address>`, queried
  2026-10-25 (status and, for the registrar, oracle, registries and
  resolver implementation, the verified sources compared file by file with
  `07e55a05`).
- On-chain reads and simulations: Ethereum Sepolia through
  `ethereum-sepolia-rpc.publicnode.com`, `sepolia.drpc.org` and
  `eth-sepolia-testnet.api.pocket.network`, 2026-10-25, blocks 11,991,368
  to 11,991,465.
