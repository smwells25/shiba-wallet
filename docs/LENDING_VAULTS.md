# Lending and yield vaults on the test networks (features 61 and 62)

**Status:** Research only, written 2026-11-08 against repository HEAD `215f3e0` for phase 25 item 4 (`AGENTS.md`, "Phase 25 plan"). Nothing here is built, and no transaction was sent: every on-chain figure is a read-only `eth_call`, `eth_getCode`, `eth_getStorageAt` or `eth_simulateV1` made on 2026-11-08 through two keyless public endpoints per network — Ethereum Sepolia `ethereum-sepolia-rpc.publicnode.com` and `0xrpc.io/sep` (blocks 12,094,979 to 12,095,009), Base Sepolia `base-sepolia-rpc.publicnode.com` and `sepolia.base.org` (blocks 56,373,639 to 56,375,108), Arbitrum Sepolia `arbitrum-sepolia-rpc.publicnode.com` and `sepolia-rollup.arbitrum.io/rpc` (blocks 327,442,980 to 327,444,007), OP Sepolia `optimism-sepolia-rpc.publicnode.com` and `sepolia.optimism.io` (blocks 51,197,044 to 51,197,046), Hoodi `ethereum-hoodi-rpc.publicnode.com` and `rpc.hoodi.ethpandaops.io`. Unless a row says otherwise, the two endpoints of a network gave the same answer. Every document was fetched the same day from the source named beside each claim. Section 9 lists what could not be verified. **Update 2026-11-09:** the engine and script half of the recommended slice (section 7.1) is now built, and a supply and withdrawal of 0.1 USDC was sent live on Arbitrum Sepolia by script; section 10 records what was built and the live run. Sections 1 to 9 are left as written on 2026-11-08.

This file is plain technical prose for leadership and for the engineers who would build a slice; it follows the model of `docs/STAKING.md`. The persona and compression rules do not apply to it.

## 1. Summary and recommendation

1. **Aave v3 has a market on all four EVM test networks the wallet supports, and on two of them its USDC reserve is Circle's USDC — the token the wallet already tracks and holds.** On Arbitrum Sepolia the reserve is `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` and on OP Sepolia `0x5fd84259d66Cd46123540766Be93DFE6D43130D7`, the same addresses as the wallet's known-token table (`app/src/wallet/tokens.ts`, lines 350 and 363). On Ethereum Sepolia and Base Sepolia Aave's "USDC" is Aave's own mintable test token (`TestnetERC20`), not Circle's. Hoodi has no lending market in any primary source read.
2. **Supplying USDC to Aave v3 on Ethereum Sepolia does not work today.** The reserve's supply cap is 2,000,000,000 USDC and its supply has grown by interest to about 4.75 billion, so every new supply reverts with Aave's error `51` (`SUPPLY_CAP_EXCEEDED`); this was reproduced in simulation on both endpoints. The Sepolia market also runs the oldest code (pool revision 1, from the deprecated `aave/aave-v3-core` repository). Its WETH reserve has no cap and works.
3. **On Arbitrum Sepolia a supply and a withdrawal of Circle's USDC simulate cleanly from the wallet's own accounts**, the regular Account 1 (which holds 1 USDC there) and the Kernel smart account (0.745441 USDC), at 217,287 gas for `supply` and about 177,800 for `withdraw`. The reserve is active, not frozen and not paused, has 855,824 USDC of liquidity, and its cap (10,500,000) is about half used.
4. **Every call a lending slice needs has only fixed-size arguments, so Kernel's CallPolicy can pin all of them.** Aave's `supply(asset, amount, onBehalfOf, referralCode)` and `withdraw(asset, amount, to)` and ERC-4626's `deposit(assets, receiver)` and `redeem(shares, receiver, owner)` are all static; a session key restricted to "supply up to X USDC on behalf of this account" and "withdraw USDC to this account" was checked against the wallet's own CallPolicy mirror (`assertCallsAllowed`), which refused another recipient, another spender, a larger amount, `borrow` and an aToken transfer. Lending is therefore a better fit for session keys than swaps were (`docs/SCHEDULED_PAYMENTS.md` section 4.2).
5. **ERC-4626 vaults exist only on Ethereum Sepolia and Base Sepolia, and every one found wraps an Aave position in Aave's own test tokens.** On Base Sepolia, Aave's `StataTokenV2` wrappers (for example `waBasSepUSDC`) accept deposits; on Ethereum Sepolia the older `StaticATokenLM` wrappers accept WETH but refuse USDC, USDT and DAI because the underlying reserves are over their caps. No ERC-4626 vault for Circle's USDC was found on any test network. Morpho documents deployments on Ethereum Sepolia and Base Sepolia, but its markets and vaults there could not be enumerated keylessly.
6. **Compound v3 still has a working Circle-USDC market on Ethereum Sepolia, but Compound removed it from its repository in June 2026** and its utilisation is above 100 per cent. It simulates cleanly and is the only lending market found for Circle's USDC on Ethereum Sepolia; it is recorded as a fallback, not a recommendation.

**Recommendation.** Do not build "supply USDC to Aave v3 on Sepolia": it is a **no-go** while the cap is exceeded, and it would not use Circle's USDC anyway. If anything is built, build **"Supply USDC to Aave v3 on Arbitrum Sepolia" (supply and withdraw only, no borrowing)** through the existing send machinery, modelled on the staking slice (section 7): one exact `approve` plus `supply` from the regular account, one batch from the smart account, `withdraw` back to the same account, the reserve's live state read before every confirm, Aave's own pinned addresses described on the risk card, a readiness row (test networks only, enforced). It is a **go** for a test-network demonstration with the residuals of section 7.4 stated on screen. OP Sepolia is the same market software and could follow once an account holds USDC there. An ERC-4626 slice is a **no-go for now**: the only vaults found hold tokens the wallet does not otherwise use, obtainable only from Aave's faucet. Borrowing, sponsored supply and a health-factor reminder are designed in section 6 and should wait.

## 2. Sources

| Source | Pinned at | Used for |
|---|---|---|
| `bgd-labs/aave-address-book` | commit `d4c2848eeffed475372b81f1a4d510ad1710e253` (2026-11-08) | `src/AaveV3Sepolia.sol`, `AaveV3BaseSepolia.sol`, `AaveV3BaseSepoliaLido.sol`, `AaveV3ArbitrumSepolia.sol`, `AaveV3OptimismSepolia.sol`, `MiscBaseSepolia.sol` (Aave's generated address book; each constant carries an explorer link) |
| `aave-dao/aave-v3-origin` | commit `8305565ae342f1773c42cd2e4593f175fe5968a0` | `LICENSE` (Business Source License 1.1, "Licensed Work: Aave v3.7", change date "The earlier of: 2027-03-06 …", change licence MIT), `audits/` |
| `aave/aave-v3-core` | commit `782f51917056a53a2c228701058a6c3fb233684a` | `README.md` ("This repository is DEPRECATED and no longer maintained"), `LICENSE.md`, `audits/` |
| `compound-finance/comet` | `main` at `f766f51583c23acc33b2a7824654ef2029a96804`; commit `db72b0ca39118098846605479d156ce9b1736cf3` (2026-06-11) and its parent `d5a30b0a` | the Sepolia deployment files (`deployments/sepolia/usdc/roots.json`, `…/weth/roots.json`) as they stood before db72b0c, whose message lists "Drop `Sepolia` and `Fuji` testnet deployments"; `LICENSE` |
| `ethereum/ERCs` | commit `cf8bff877b00d56cec0c60007a25bae0937d0d03` | `ERCS/erc-4626.md` (status Final) |
| Morpho documentation | https://docs.morpho.org/get-started/resources/addresses/, fetched 2026-11-08 | Morpho's Ethereum Sepolia and Base Sepolia addresses |
| Morpho API | `https://blue-api.morpho.org/graphql`, query `chains`, 2026-11-08 | which chains Morpho's API indexes (no test network) |
| Sourcify | `sourcify.dev/server/v2/contract/{chain}/{address}`, read 2026-11-08 | verification status, contract names, compilers, licence headers of the verified sources |

Selectors below were computed as `keccak256(signature)[0:4]` with ethers 6.17.0 (the version installed in this repository) from signatures copied out of the verified sources. "Gas used" figures are `eth_simulateV1` per-call `gasUsed` values, which include the transaction's intrinsic cost (the simulated Circle USDC `approve` on Sepolia gave 137,757, the same figure as the live approval in this project's CCTP leg recorded in `AGENTS.md`).

## 3. Lending markets on the wallet's test networks (feature 61)

### 3.1 Aave v3

Aave publishes its deployments as the generated Solidity library `aave-address-book`. For the wallet's networks it has `AaveV3Sepolia`, `AaveV3BaseSepolia`, `AaveV3BaseSepoliaLido` (a second Base Sepolia market), `AaveV3ArbitrumSepolia` and `AaveV3OptimismSepolia`; there is no Hoodi file. Every address below was read from those files, then checked on both endpoints of its network: code present, `PoolAddressesProvider.getPool()` equal to the book's `POOL`, `Pool.ADDRESSES_PROVIDER()` equal to the book's provider, and the ERC-1967 implementation slot of the pool proxy equal to the book's `POOL_IMPL` (where the book lists one).

| Network | PoolAddressesProvider | Pool (proxy) | Pool revision and implementation | Market id (`getMarketId`) | Sourcify (provider / pool proxy / implementation) |
|---|---|---|---|---|---|
| Ethereum Sepolia | `0x012bAC54348C0E635dCAc9D5FB99f06F24136C9A` | `0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951` | 1; `Pool` `0x0562453c3DAFBB5e625483af58f4E6D668c44e19` (solc 0.8.10, `@aave/core-v3`) | "Ethereum Aave Market" | exact_match / exact_match / match |
| Base Sepolia | `0xE4C23309117Aa30342BFaae6c95c6478e0A4Ad00` | `0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27` | 10; `L2PoolInstance` `0xe9fb54369e85b9714f9d86366d918c5c7c87783a` | "Aave V3 Base Testnet Market" | none / none / match |
| Base Sepolia (Lido) | `0x6f7E694fe5250Ce638fFE95524760422E6e41997` | `0x423b16E67D9b7ea095Bc443F1Cb9621c54A3db1D` | 10 | "Aave V3 Base Lido Testnet Market" | not queried |
| Arbitrum Sepolia | `0xB25a5D144626a0D488e52AE717A051a2E9997076` | `0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff` | 3; `L2Pool` `0x82405D1a189bd6cE4667809C35B37fBE136A4c5B` (solc 0.8.19) | "Aave V3 Arbitrum Sepolia Testnet Market" | match / match / match |
| OP Sepolia | `0x36616cf17557639614c1cdDb356b1B83fc0B2132` | `0xb50201558B00496A145fE76f7424749556E326D8` | 3; `L2Pool` `0xB1532b76D054c9F9E61b25c4d91f69B4133E4671` (solc 0.8.19) | "Aave V3 Optimism Sepolia Testnet Market" | match / match / match |

The data providers (`AaveProtocolDataProvider`) and oracles (`AaveOracle`) are verified on Sourcify on every network except that Base Sepolia's provider and pool proxy are not. The Arbitrum and OP Sepolia markets have identical provider code (6,840 bytes, keccak prefix `0xc820c000a4f1`) and identical admin contracts (section 5.1), which suggests one deployment process; that is an observation, not a documented fact.

**Reserves, read from `Pool.getReservesList()` and the data provider** (all reserves active, not frozen, not paused at read time):

| Network | Reserve | Underlying | Collateral / borrowing | Supply cap / supplied | Liquidity (underlying held by the aToken) |
|---|---|---|---|---|---|
| Ethereum Sepolia | USDC (Aave test token, 6 decimals) | `0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8` | yes / yes | 2,000,000,000 / about 4,748,402,706 — **over the cap** | 29,614 |
| Ethereum Sepolia | WETH (Aave test WETH) | `0xC558DBdd856501FCd9aaF1E62eae57A9F0629a3c` | yes / no | none / about 11,818 | about 11,818 |
| Ethereum Sepolia | also DAI, LINK, WBTC, USDT, AAVE, EURS, GHO | Aave test tokens | | DAI and USDT also over their 2,000,000,000 caps | |
| Base Sepolia | USDC (Aave test token) | `0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f` | yes / yes | none / about 47,306,042 | 40,198,193 |
| Base Sepolia | also USDT, WBTC, WETH (`0x4200…0006`), cbETH, LINK | | | | |
| Base Sepolia (Lido) | USDC, USDT, DAI, WETH, cbETH | own test tokens (its "USDC" has 18 decimals) | | almost empty (0.052 WETH supplied) | |
| Arbitrum Sepolia | **USDC (Circle)** | `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` | yes (LTV 77%, liquidation threshold 80%) / yes | 10,500,000 / about 5,538,927 | **855,824** |
| Arbitrum Sepolia | WETH | `0x1dF462e2712496373A347f8ad10802a5E95f053D` | yes / yes | 10,350 / about 4,814 | about 10.4 |
| OP Sepolia | **USDC (Circle)** | `0x5fd84259d66Cd46123540766Be93DFE6D43130D7` | yes (77% / 80%) / yes | 10,500,000 / about 1,838,798 | **651,120** |
| OP Sepolia | WETH | `0x4200000000000000000000000000000000000006` | yes / yes | 10,350 / about 355 | about 6.4 |

Two oddities, both read on both endpoints: on Ethereum Sepolia the DAI, USDC and USDT reserves report more total debt than supply (for USDC 5.24 billion of debt against 4.75 billion supplied), and on Arbitrum Sepolia the WETH reserve does too (5,882 against 4,814). How a reserve's debt can exceed its supply was not investigated; it is most likely years of test-network interest at high utilisation, inferred and not traced. It matters only for how much can be withdrawn at once, which is bounded by the liquidity column.

**What the wallet already holds there** (read 2026-11-08): Account 1 (`0x772eAA1d3BEf14C0BD5cee980b90dB3FC680F44F`) holds 1,000,000 base units (1 USDC) of Circle's USDC on Arbitrum Sepolia and the Kernel smart account `0xD31c2C54F21684eE2026a6C41e391130BdEeD8FA` holds 745,441 (0.745441 USDC); both hold none on OP Sepolia. The dev EOA (`0x16DA2CAeaDa26516F919C6872F6C38AB378CaC5C`) holds 18.786299 of Circle's USDC on Ethereum Sepolia, which no Aave reserve accepts.

**Aave's faucet.** The Sepolia book lists `FAUCET` `0xC959483DBa39aa9E78757139af0e9a2EDEb3f42D` (Sourcify exact_match, `@aave/periphery-v3/contracts/mocks/testnet-helpers/Faucet.sol`, BUSL-1.1). Its source mints any Aave test token to any address, up to `MAX_MINT_AMOUNT = 10000` whole tokens per call, when `_permissioned` is false (lines 14, 19–53); `isPermissioned()` read `false`. `MiscBaseSepolia.sol` lists a Base Sepolia faucet `0xD9145b5F45Ad4519c7ACcD6E0A4A82e83bB8A6Dc`, which minted 10 test USDC in simulation. Aave's Sepolia test WETH is not mintable through the faucet (it reverted "Error: not mintable") but accepted a plain `deposit()` of test ETH in simulation, like WETH9. The book lists no faucet for Arbitrum or OP Sepolia, where the USDC is Circle's.

### 3.2 Compound v3 (Comet)

At `comet` commit `d5a30b0a` (the parent of db72b0c) the repository's `deployments/sepolia` held two markets: cUSDCv3 `0xAec1F48e02Cfb822Be958B68C7957156EB3F0b6e` and cWETHv3 `0x2943ac1216979aD8dB76D9147F64E61adc126e96`. Commit db72b0c (2026-06-11) removed both, its message listing "Drop `Sepolia` and `Fuji` testnet deployments"; `main` has no test-network folder. At that parent commit there was no folder for Base, Arbitrum or OP Sepolia.

On-chain the cUSDCv3 proxy still answers (Sourcify exact_match as `TransparentUpgradeableProxy`; its implementation `0xE3E0106227181958aBfbA960C13d0Fe52c733265` is not on Sourcify): `baseToken()` is Circle's Sepolia USDC `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`, supply and withdraw are not paused, total supply 2,409,652 USDC against total borrow 2,421,050 (utilisation 1.0046, that is above 100 per cent), and it holds 29,643 USDC of liquidity. Its governor is a `SimpleTimelock` (Sourcify exact_match) and its pause guardian `0x008a4C5448ac1Df676d6F39A0C6F13b21b189389` is a Safe 1.3.0 with a threshold of 4 of 7 owners. In simulation the dev EOA supplied 1 USDC (balance afterwards 999,999 — one base unit lost to rounding) and withdrew 0.5 USDC (section 4.4). Because Compound itself has dropped the deployment, nothing promises it will keep working.

### 3.3 Morpho

Morpho's address page lists, besides its main networks, **Base Sepolia** (Morpho `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb`, Adaptive Curve IRM `0x46415998764C29aB2a25CbeA6254146D50D22687`, Chainlink Oracle V2 factory `0x2DC205F24BCb6B311E5cdf0745B0741648Aebd3d`, VaultV2Factory `0xE3a2CEbca662d99D0F279aF13a6bb8c9825D2ea0`) and **Sepolia** (Morpho `0xd011EE229E7459ba1ddd22631eF7bF528d424A14`, IRM `0x8C5dDCD3F601c91D1BF51c8ec26066010ACAbA7c`, oracle factory `0xa6c843fc53aAf6EF1d173C4710B26419667bF6CD`, VaultV2Factory `0xb3fE2D5f8Af90f194B01db546397058Fcebb85D1`). Both Morpho contracts have 15,623 bytes of code, are Sourcify exact matches, and have an owner with no code (Sepolia `0x50d0dE2207989017398e33919A3ed6558eBc6644`, Base Sepolia `0x937Ce2d6c488b361825D2DB5e8A70e26d48afEd5`). The vault factories have code but are not on Sourcify. Morpho Blue holds isolated markets created by anyone, and Morpho's public API lists only main networks (its `chains` query returned 15 chain ids, none a test network), so **which markets and vaults exist on the test networks, and whether any uses Circle's USDC, was not established**; it would need a scan of `CreateMarket` events from each deployment block. The main-network Morpho address has no code on Arbitrum Sepolia, OP Sepolia or Hoodi.

### 3.4 Hoodi and other protocols

No Aave, Compound or Morpho deployment for Hoodi appears in the sources above; the Morpho main-network address and the Aave Sepolia provider address have no code on Hoodi (Aave's addresses are not deterministic across chains, so the second check proves little). Kernel's CallPolicy also has no code on Hoodi (read today), as `docs/STAKING.md` found for the Kernel stack. Other lending protocols (Spark, Euler, Fluid, Silo and others) were not researched.

## 4. What a deposit, withdrawal, supply and borrow need

### 4.1 The calls

From the verified sources of the Arbitrum Sepolia `L2Pool` (`IPool.sol` lines 248, 287, 304, 324, 399, 477) and the ERC-4626 text:

| Action | Call | Selector | Arguments (all fixed-size) |
|---|---|---|---|
| allow the pool to take USDC | `approve(address spender, uint256 amount)` on USDC | `0x095ea7b3` | spender = the Pool, amount = exactly the supply |
| supply | `supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)` | `0x617ba037` | offsets 0, 32, 64, 96 |
| withdraw | `withdraw(address asset, uint256 amount, address to)` | `0x69328dec` | offsets 0, 32, 64; `amount = type(uint256).max` withdraws everything |
| borrow | `borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)` | `0xa415bcad` | mode 2 = variable |
| repay | `repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf)` | `0x573ade81` | |
| collateral switch | `setUserUseReserveAsCollateral(address asset, bool useAsCollateral)` | `0x5a3b74b9` | |
| health | `getUserAccountData(address user)` (view) | | returns collateral, debt, available borrows (in the oracle's base currency, 8 decimals), liquidation threshold, LTV and the health factor (18 decimals) |
| ERC-4626 deposit | `deposit(uint256 assets, address receiver)` | `0x6e553f65` | |
| ERC-4626 redeem / withdraw | `redeem(uint256 shares, address receiver, address owner)` / `withdraw(uint256 assets, address receiver, address owner)` | `0xba087652` / `0xb460af94` | |
| Compound v3 | `supply(address asset, uint256 amount)` / `withdraw(address asset, uint256 amount)`; `supplyTo` / `withdrawTo(address dst, address asset, uint256 amount)` | `0xf2b9fdb8` / `0xf3fef3a3`; `0x4232cd63` / `0xc3b35a7e` | |

On the layer-2 networks the pool is an `L2Pool`, which adds compact `supply(bytes32)`-style entry points (`L2Pool.sol` lines 25–109 on Arbitrum Sepolia); the ordinary functions above remain and were the ones simulated. The wallet should use only the ordinary ones, because their arguments are readable and pinnable.

Aave's `onBehalfOf` (supply, borrow, repay) and `to` (withdraw) are free arguments: a supply credited to another address and a withdrawal sent to another address both succeeded in simulation (section 4.4). A slice must therefore always set them to the sending account itself and check that on the confirm, just as the DCA slice fixes the swap recipient (`packages/chains-evm/src/kernel-dca.ts`).

Supplying an asset for the first time switches it on as collateral: the simulated first supply emitted `ReserveUsedAsCollateralEnabled(address,address)` (topic `0x00058a56`), and `getUserAccountData` then reported the deposit as collateral with an unlimited health factor because there was no debt. With supply only, collateral status changes nothing; with borrowing it is what liquidation acts on.

### 4.2 From the regular account

Two transactions, in the shape the staking slice already uses for wrapping stETH (`AGENTS.md`, phase 18 pass): first an `approve` of exactly the amount (the approval falls back to 0 when `supply` pulls it — read as `allowance` 0 in the simulation), then `supply` with `onBehalfOf` = the account. Withdrawal is one transaction. Both go through `prepareEvmSend` (`app/src/wallet/send.ts` line 918), so the endpoint's chain check, the fee quote, the balance check and the `eth_call` pre-flight are the existing ones.

**The balance-change preview.** The simulated supply emitted, in order: Circle USDC `Transfer` of 500,000 from Account 1 to the aToken `0x460b97BD498E1157530AEb3086301d5225b91216`, and aToken `Transfer` of 500,000 from the zero address to Account 1, plus Aave's own `ReserveDataUpdated`, `Mint`, `ReserveUsedAsCollateralEnabled` and `Supply` events. The withdrawal emitted the reverse (aToken burned from Account 1, USDC from the aToken to Account 1). The wallet's preview (`packages/chains-evm/src/asset-diff.ts`) decodes `Transfer` events, so it would show "−0.5 USDC" and "+0.5 aArbSepUSDC" (the aToken's symbol was not read; the line would carry the contract address until the aToken is a known token). **aTokens are rebasing**: their balance grows with interest without a `Transfer` event, which is the same caveat the wallet already shows for stETH (`docs/STAKING.md` section 5.3). In the simulation the aToken balance right after supplying 500,000 was exactly 500,000; the one- or two-unit rounding that stETH shows was not observed but was not tested at other amounts.

### 4.3 From the smart account

One operation through `prepareAaCalls` (`app/src/wallet/aa.ts` line 3450) carrying `[approve(Pool, amount), supply(USDC, amount, account, 0)]`, so the approval and the supply are all or nothing and nothing stays approved. Simulated with the Kernel account as `msg.sender` on Arbitrum Sepolia, `approve`, `supply` and a partial `withdraw` of 250,000 all succeeded (the operation overhead of a real UserOperation was not simulated). On Arbitrum Sepolia the fee could be paid in USDC through Circle's paymaster, which the wallet already uses there (`AGENTS.md`, phase 15 item 0), with the existing caveat that Circle's fee is taken before the operation runs. ZeroDev's Arbitrum estimates sometimes come back with zero gas limits; the wallet's zero-estimate guard already handles that (phase 15).

The risk card today would call the Pool "a contract" with a contract-age line. As for Lido and Circle's TokenMessengerV2 (`app/src/wallet/risk.ts`, `pinnedStakingContracts`, `pinnedBridgeContracts`), a slice should pin the Pool and the USDC aToken per chain from the address book and describe them in one line, and accept the Pool as a pinned spender of an exact `approve`.

### 4.4 Gas, measured by simulation

| Network | Call | Gas used | Note |
|---|---|---|---|
| Arbitrum Sepolia | Circle USDC `approve` | 55,437 | Account 1 |
| Arbitrum Sepolia | `supply` 0.5 USDC | 217,287 | first position for the account; the same for the Kernel as sender |
| Arbitrum Sepolia | `withdraw` all | 177,769 | to the account |
| Arbitrum Sepolia | `withdraw` part | 177,345 | from the Kernel |
| Arbitrum Sepolia | `borrow` 0.7 USDC against 1 USDC | 259,256 | then `getUserAccountData` gave a health factor of 1.1429; a further 0.1 USDC borrow reverted `36` (`COLLATERAL_CANNOT_COVER_NEW_BORROW`) |
| Ethereum Sepolia (after Glamsterdam) | Aave test-WETH `approve` | 128,073 | dev EOA |
| Ethereum Sepolia | `supply` 0.001 WETH | 394,392 | first position for the address |
| Ethereum Sepolia | `withdraw` all | 186,836 | |
| Ethereum Sepolia | `WrappedTokenGatewayV3.depositETH` (`0x387d…89F7D`) | 406,422 | supplies test ETH directly |
| Ethereum Sepolia | ERC-4626 `deposit` into static aWETH | 333,915 | |
| Ethereum Sepolia | ERC-4626 `redeem` | 233,674 | returned 999,999,999,999,999 for 0.001 deposited — one wei short |
| Ethereum Sepolia | Circle USDC `approve` to Comet / Comet `supply` / `withdraw` | 137,757 / 217,357 / 102,766 | dev EOA |
| Ethereum Sepolia | Aave test-USDC `supply` | reverted `51` | `SUPPLY_CAP_EXCEEDED` |
| Base Sepolia | ERC-4626 `deposit` into `waBasSepUSDC` | 225,721 | after a faucet mint |

The Ethereum Sepolia figures are about 1.8 times the Arbitrum ones for the same calls, consistent with the state-creation pricing that arrived with Glamsterdam (EIP-8037, `AGENTS.md` phase 15) — an inference from the ratio; no opcode trace was taken. Error codes are from the verified `Errors.sol` of both pool implementations (lines 35–59: `26 INVALID_AMOUNT`, `29 RESERVE_PAUSED`, `32 NOT_ENOUGH_AVAILABLE_USER_BALANCE`, `35 HEALTH_FACTOR_LOWER_THAN_LIQUIDATION_THRESHOLD`, `36 COLLATERAL_CANNOT_COVER_NEW_BORROW`, `51 SUPPLY_CAP_EXCEEDED`).

## 5. Trust: who can pause, upgrade, change prices or liquidate

### 5.1 Aave v3 on the test networks

- **Upgrades and configuration.** The `PoolAddressesProvider` owner can replace the Pool and configurator implementations, the oracle, the ACL manager and admin (`PoolAddressesProvider.sol`, Arbitrum Sepolia source, lines 47–152, every setter `onlyOwner`). The ACL manager's pool admin can list and configure reserves; the emergency admin can pause the whole pool (`PoolConfigurator.sol` line 422, `setPoolPause … onlyEmergencyAdmin`) and the emergency or pool admin can pause a reserve (line 227); risk or pool admins can freeze a reserve (line 208) and change caps.
- **Who holds those roles.** On Ethereum Sepolia the provider owner and ACL admin is `0xfA0e305E0f46AB04f00ae6b5f4560d61a2183E00`, an address with no code, and it is both pool admin and emergency admin. On Base Sepolia it is `0x956DE559DFc27678FD69d4f49f485196b50BDD0F`, also with no code and holding both roles. On Arbitrum and OP Sepolia the owner and admin is an Aave `Executor` contract (`0xC08C599C22bfD4a729E33e1Ed9b49456Abad0005` and `0x1dF462e2712496373A347f8ad10802a5E95f053D`, Sourcify exact matches, `src/contracts/payloads/Executor.sol`) which is pool admin but not emergency admin, and **both Executors are owned by the same code-less address `0x956D…DD0F`** that administers Base Sepolia. So on every test network one key controls the market; this is a test-network arrangement, not Aave's main-network governance, which was not read.
- **Prices.** The `AaveOracle` reads one source per asset. On Arbitrum Sepolia, OP Sepolia and Base Sepolia the USDC sources have identical 9,571-byte code (keccak prefix `0xbd6f524cdc42`), verified on Sourcify as Chainlink's `EACAggregatorProxy` on Arbitrum Sepolia (the other two are not on Sourcify; their `description()` reads "USDC / USD"): USDC/USD 0.99976051 on Arbitrum Sepolia, last updated 52,140 seconds (about 14.5 hours) before the read; 0.99977969 on OP Sepolia, 42 seconds; Base Sepolia 67,778 seconds. On Ethereum Sepolia the sources are 162-byte contracts whose `latestRoundData` reverts and whose `latestAnswer` returns a fixed-looking 1.00000000 for USDC and 4,000 for WETH; they are not on Sourcify, so their nature was not established. Whether Aave's oracle rejects a stale feed was not checked in source.
- **Liquidation.** Anyone can liquidate a borrower whose health factor is below 1. With supply only and no debt the health factor is unlimited and nothing can be liquidated.
- **Withdrawal can be blocked.** A pause, or the reserve's liquidity running out, stops withdrawals; on Arbitrum Sepolia only 855,824 USDC of 5.54 million supplied was in the pool at read time.

### 5.2 ERC-4626 wrappers

`StataTokenV2` (Base Sepolia implementation `0x208747c806b13022db31622c0c9bd3979532a8d6`, Sourcify match, BUSL-1.1) can be paused by whoever the market's ACL manager calls emergency admin (`StataTokenV2.sol` lines 40, 57, 80–81). It sits behind an ERC-1967 proxy (the implementation slot read above); the proxy's admin was not read. The legacy `StaticATokenLM` on Ethereum Sepolia (implementation `0xe88fb4eaf67ea87bb458e24c94bef0eb02b5f449`, Sourcify exact_match, header MIT) has an overloaded `deposit` with an Aave referral and a `redeem` with a `withdrawFromAave` flag (lines 105, 436), so a slice must use the four-argument standard forms only.

### 5.3 Audits and licences

- **Audits.** `aave-dao/aave-v3-origin/audits/` lists reports from OpenZeppelin, Trail of Bits, PeckShield, Certora, ABDK, SigmaPrime (2021–2023, v3.0 to v3.0.2), Certora, MixBytes and a Cantina contest (v3.1, 2024), several firms for v3.2 to v3.6 (2024–2025) and two for the stata token (Certora 2024-09-11, MixBytes 2024-12-05). The files were listed, not read; **which commit each covers, and whether the bytecode deployed on the test networks was built from a covered commit, was not checked.** The Sepolia market runs the `aave-v3-core` code (solc 0.8.10), whose README now says the repository is deprecated.
- **Licences, from the verified source headers.** Sepolia pool sources: BUSL-1.1. Arbitrum and OP Sepolia pool sources: MIT. Base Sepolia (revision 10) pool and stata sources: BUSL-1.1. The current `aave-v3-origin` licence is BUSL-1.1 with an additional use grant and an MIT change date "The earlier of: 2027-03-06 …". Aave's faucet source is BUSL-1.1. Compound III is BUSL-1.1 (`comet/LICENSE`). The wallet would only call these contracts, not copy their code; whether calling a BUSL-licensed contract raises any question is for counsel, as already noted for other components.

### 5.4 ERC-4626 itself

ERC-4626 is Final (`ERCS/erc-4626.md`, line 7). Its security section warns that "Fully permissionless use cases could fall prey to malicious implementations which only conform to the interface but not the specification" and that an integrator offering vaults directly to an externally owned account "should consider adding an additional function call … with the means to accommodate slippage loss … since they have no other means to revert the transaction if the exact output amount is not achieved" (lines 587–590); it says `totalAssets`, `convertToShares` and `convertToAssets` are estimates for display (lines 592–593) and that the preview functions "are manipulable" (line 595). For the wallet that means: only pinned, known vaults; the preview from `previewDeposit` / `previewRedeem` and a simulation, not `convertTo*`; and, for a smart account, the minimum-out check can be done inside the batch, which an externally owned account cannot do.

## 6. Where lending meets account abstraction

### 6.1 A session key that can only supply and withdraw to the account

Kernel's CallPolicy v0.0.4 (`0x9a52283276A0ec8740DF50bF01B28A80D880eaf2`) has identical code on Ethereum, Base, Arbitrum and OP Sepolia (6,539 bytes, keccak prefix `0x99fc4b02bdbb`, read today) and none on Hoodi. Its rules compare a 32-byte argument word with a fixed value (`packages/chains-evm/src/kernel-permissions.ts` lines 183–184: `EQUAL`, `GREATER_THAN`, `LESS_THAN`, `GREATER_THAN_OR_EQUAL`, `LESS_THAN_OR_EQUAL`, `NOT_EQUAL`, `ONE_OF`). A grant was written for the Kernel on Arbitrum Sepolia with three entries — USDC `approve` with spender `EQUAL` the Pool and amount `LESS_THAN_OR_EQUAL` 1 USDC; Pool `supply` with asset `EQUAL` USDC, amount `LESS_THAN_OR_EQUAL` 1 USDC, `onBehalfOf` `EQUAL` the Kernel and referral `EQUAL` 0; Pool `withdraw` with asset `EQUAL` USDC and `to` `EQUAL` the Kernel — and passed through the engine's own `validateSessionKeyGrant`, `kernelPermissionFromGrant` (2 policies) and `assertCallsAllowed` (the engine's mirror of CallPolicy, not the contract). The mirror allowed the approve, the supply and a withdrawal of everything to the Kernel, and refused a supply on behalf of another address, a withdrawal to another address, a supply of 2 USDC, an approval to another spender, `borrow` (not granted) and a transfer of the aToken (not granted). It also **allowed a batch of three in-rule supplies**, the batching residual of `docs/SCHEDULED_PAYMENTS.md` section 2: the amount cap is per call, so a fee budget (GasPolicy) and a rate limit remain necessary. With `to` and `onBehalfOf` pinned, a stolen key could at worst move the account's USDC into its own Aave position and back, plus fees; it could not send funds away. `borrow` must never be granted: even with `onBehalfOf` pinned to the account, a key could borrow up to the limit and leave the position near liquidation. None of this was tested on-chain.

This makes "keep idle USDC supplied, withdraw when a payment is due" a plausible future automation, like the recurring payment, still pushed by the user's own phone.

### 6.2 Sponsored supply

A sponsor's paymaster policy would scope sponsorship to exactly the calls of section 6.1 on the pinned Pool and USDC, with the sender's own address as `onBehalfOf` and `to`, a minimum amount and a per-account rate limit. The wallet's sponsorship path is ERC-7677 and still lacks a gas policy (an outstanding input, `AGENTS.md`); whether any vendor's policy engine can match arguments rather than only the target and selector was not checked. On Arbitrum Sepolia the alternative already works: Circle's paymaster takes the fee in USDC.

### 6.3 Health-factor monitoring as a local reminder

`getUserAccountData(account)` returns the health factor as an 18-decimal number (1.1429 in the borrowing simulation; unlimited without debt). The wallet's local reminders (`app/src/wallet/notifications.ts`, development build only) could check it on start, on each foreground and on the reminder schedule, and post a security-channel notification when it falls below a threshold the user chooses, with the same rules as the takeover alert: nothing about amounts in the notification text, no background network beyond what the reminder infrastructure already does, and no automatic action. Because a reminder fires only when the operating system lets the app run, it must be described as a reminder, never as protection against liquidation. It is only meaningful once borrowing exists, which this document does not recommend now.

## 7. The smallest honest slice

### 7.1 "Supply USDC to Aave v3 on Arbitrum Sepolia" (supply and withdraw only)

- **Where:** Arbitrum Sepolia first; OP Sepolia uses the same code and could be added by table entry once tested with USDC there. A readiness row (for example `lending`, test networks only, enforced). Ethereum Sepolia shows "Aave's Sepolia USDC reserve is over its supply cap, so new supplies are refused" after reading the cap live; Base Sepolia and Hoodi show "not available on this network".
- **Pinned facts per chain:** the PoolAddressesProvider, the Pool, the data provider, Circle's USDC as the reserve and its aToken, all from the address book commit of section 2, re-read at every quote: `getPool()` equals the pinned Pool, `getReserveTokensAddresses(USDC).aToken` equals the pinned aToken, and the reserve is active, not frozen and not paused.
- **Before the confirm:** read the supply cap and the current supply, and refuse plainly when the amount would exceed the cap; for withdrawal, read the account's aToken balance and the pool's liquidity and refuse a withdrawal larger than the liquidity with that reason.
- **Calls:** regular account — exact `approve` then `supply(USDC, amount, account, 0)`; `withdraw(USDC, amount or max, account)`. Smart account — the same as one batch through `prepareAaCalls`. The checks before signing require `onBehalfOf` and `to` to be the sending account.
- **The confirm:** the balance preview (−USDC, +aToken), a known-protocol risk line naming the pinned Pool, the existing rebasing note adapted for aTokens ("the balance grows with interest; the preview can be off by a unit or two"), and plain lines: "This is Aave's Arbitrum Sepolia test market. One key controls it and can pause or change it; Circle's test USDC has no value." and "Supplied USDC is switched on as collateral automatically; this wallet does not offer borrowing."
- **Tokens:** the USDC aToken as a known Arbitrum Sepolia token with a rebasing flag, shown on Home under the account.
- **Not in the slice:** borrowing, repaying, collateral switches, the faucet, ERC-4626 vaults, Compound, Morpho, sponsored supply, session keys, reminders, fiat values, any main network.
- **Funding:** Account 1 holds 1 USDC and the Kernel 0.745441 USDC on Arbitrum Sepolia, enough for a demonstration; the dev EOA holds 38 USDC there (read 2026-11-08 on both endpoints) for a script leg.

### 7.2 What the emulator could show

A supply from Account 1 (two prompts), the aToken row appearing on Home, a withdrawal (one prompt), the same from the Kernel in one operation with the fee in test ETH or USDC, the refusal on Ethereum Sepolia with the live cap, the pinned risk line, and the readiness card on mainnet. It could not show interest worth anything, liquidation, or a main network.

### 7.3 An ERC-4626 slice, and why not yet

The ERC-4626 surface is attractive because one interface covers many vaults, but every vault found on the test networks holds Aave's own test tokens (Base Sepolia `waBasSepUSDC` `0xf430cb6E2b85f99222fBFA6dFEa18Ff60FA6B32a` over test USDC `0xba50…4D5f`; `waBasSepWETH`, `waBasSepUSDT` and three more from the factory `0x4Afb5ADe7Bd7a670B61f303ab0C740eE8350918f`; Ethereum Sepolia static aTokens for eight reserves from the legacy factory `0xd210dFB43B694430B8d31762B5199e30c31266C8`, of which those for DAI, USDC and USDT report `maxDeposit` 0 because their reserves are over cap). A demonstration would first have the user mint test tokens from Aave's faucet, a token the wallet uses nowhere else. Reads on both endpoints: `waBasSepUSDC` `asset()` = the test USDC, `aToken()` = `0x10F1A9D1…0ACC`, `totalAssets` 2,445,484 USDC, `convertToAssets(1 share)` = 1.244878 USDC, not paused, `maxDeposit` unlimited; a simulated faucet mint, exact approval and `deposit` of 1 USDC returned 803,291 shares, equal to `maxRedeem` afterwards. Build this only after the Aave slice, as "the same position, as a vault share".

### 7.4 Residuals the slice must state

- One test-network key controls each Aave test market and can pause it, change caps or replace the code; the main-network governance is different and was not read.
- The withdrawable amount is limited by the pool's liquidity, which was 15 per cent of the supply on Arbitrum Sepolia.
- aToken balances grow without `Transfer` events; anything that sums events or caches balances drifts, as with stETH.
- The batching residual for any future session key (section 6.1).
- Whether Aave's audited commits match the bytecode on these test networks is unknown.
- The address book is maintained by BGD Labs for Aave; the wallet would pin a commit and re-read the chain, not trust later edits blindly.

## 8. Ranked conclusions

1. **Aave v3 on Arbitrum Sepolia, Circle's USDC, supply and withdraw only — go** for a test-network demonstration (section 7.1).
2. **Aave v3 on OP Sepolia — go after (1)**, same code and same admin pattern; needs USDC on an account there.
3. **Compound v3 cUSDCv3 on Ethereum Sepolia — possible but not recommended**: works in simulation with Circle's USDC, but the deployment has been dropped by Compound and runs above 100 per cent utilisation.
4. **ERC-4626 vaults (Aave stata tokens on Base Sepolia) — no-go for now** (section 7.3).
5. **Aave v3 on Ethereum Sepolia with USDC — no-go** while the reserve is over its cap; and it is not Circle's USDC.
6. **Morpho on Ethereum and Base Sepolia — not assessed**: markets and vaults unknown.
7. **Hoodi — nothing to build on.**
8. **Borrowing, sponsored supply, health-factor reminders — design only** (section 6), to revisit after (1).

## 9. What could not be verified

- No transaction was sent for this research (since 2026-11-09 one supply and one withdrawal have been sent on Arbitrum Sepolia by script; see section 10). Every supply, withdrawal, borrow and vault figure in sections 3 to 8 is an `eth_simulateV1` result against the latest block, with the account as `msg.sender`; no UserOperation, bundler estimate or paymaster was simulated, and the wallet's preview and risk card were not rendered.
- The CallPolicy pinning of section 6.1 was checked against the engine's mirror only, not installed or exercised on-chain.
- Which commits Aave's and Compound's audits cover, and whether the test-network bytecode corresponds to an audited commit. The Base Sepolia provider and pool proxy, the stata token proxies, the stata factory proxy, Comet's implementation, Morpho's vault factories and the Ethereum Sepolia price sources are not on Sourcify.
- Aave's main-network governance and admin keys; the identity behind the code-less test-network admins.
- How the Ethereum Sepolia and Arbitrum Sepolia reserves came to report more debt than supply.
- Whether the Aave oracle refuses stale prices (the Arbitrum Sepolia USDC feed was 14.5 hours old) and what the 162-byte Ethereum Sepolia price sources are.
- The aToken symbols and the rebasing rounding of aTokens at amounts other than 500,000 base units.
- Morpho's test-network markets and vaults, and whether any uses Circle's USDC.
- Other lending protocols (Spark, Euler, Fluid, Silo and others) and other ERC-4626 vaults not linked from the Aave address book.
- The cause of the higher gas on Ethereum Sepolia (inferred from Glamsterdam's pricing, not traced).
- Whether any vendor's sponsorship policy can match call arguments; whether calling BUSL-licensed contracts raises any licensing question.

## 10. What was built, and the live run (2026-11-09, phase 26 item 2)

This section records the engine and script half of the slice recommended in section 7.1: supplying Circle's USDC to Aave v3's Arbitrum Sepolia market and withdrawing it, with no borrowing. The app half (a Lend screen) is not built yet.

### 10.1 Sources

The addresses are pinned from `bgd-labs/aave-address-book` at commit `d4c2848eeffed475372b81f1a4d510ad1710e253`, file `src/AaveV3ArbitrumSepolia.sol` (SHA-256 `d2354e7f8f99b1264ddbcc0fe237f8c0abb7a13fe3e4ba4cad917673e0a07ce7`): the PoolAddressesProvider (line 9), the Pool (line 12), the oracle (line 19), the data provider (line 30), the Pool implementation (line 33), the default aToken implementation (line 49), Circle's USDC as the reserve (line 79, 6 decimals at line 81) and its aToken (line 84).

The behaviour is read from the code the wallet actually calls: the Sourcify-verified source of the deployed `L2Pool` implementation `0x82405D1a189bd6cE4667809C35B37fBE136A4c5B` (Sourcify "match", solc 0.8.19, `POOL_REVISION` 3). In it, `IPool.sol` declares `supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)` at line 248 and `withdraw(address asset, uint256 amount, address to)` at line 287, with line 281 stating that `type(uint256).max` withdraws the whole aToken balance; the `Supply` and `Withdraw` events are at lines 46 and 61. `ValidationLogic.validateSupply` (line 66) refuses a zero amount, an inactive, paused or frozen reserve and a supply that would take the reserve over its cap, and `validateWithdraw` (line 96) refuses a zero amount, more than the account's balance, and an inactive or paused reserve — **a frozen reserve still allows withdrawals**. `SupplyLogic.executeWithdraw` (line 106) replaces the maximum value by the whole balance (lines 124 to 126) and pays the underlying out of the aToken contract (line 139), so what can be withdrawn at once is the aToken contract's USDC balance. The deployed `Errors.sol` uses numeric strings (`26` invalid amount, `27` inactive, `28` frozen, `29` paused, `32` more than the balance, `51` supply cap exceeded). The deployed data provider `0x12373B5085e3b42D42C1D4ABF3B3Cf4Df0E0Fa01` (Sourcify "match") supplies `getReserveConfigurationData` (line 77), `getReserveCaps` (line 115, whole tokens), `getPaused` (line 122), `getReserveData` (line 152) and `getReserveTokensAddresses` (line 252).

`aave-dao/aave-v3-origin` at commit `8305565ae342f1773c42cd2e4593f175fe5968a0`, the commit section 2 pins, has the same `supply` and `withdraw` signatures (`IPool.sol` lines 204 and 243) and event shapes (lines 21 and 36). Its `Errors.sol`, however, uses custom errors (`InvalidAmount()`, `ReserveInactive()`, `ReserveFrozen()`, `ReservePaused()`, `NotEnoughAvailableUserBalance()`, `SupplyCapExceeded()`) instead of the numeric strings the deployed revision 3 reverts with. The engine recognises both forms, so the sentences survive an upgrade of the test market to newer code.

### 10.2 On-chain checks

Read on 2026-11-09 through `sepolia-rollup.arbitrum.io` (block 327,687,885) and `arbitrum-sepolia-rpc.publicnode.com` (block 327,687,895), with the same answers from both: every pinned address has code; the Pool proxy's ERC-1967 implementation is the pinned `L2Pool`, and the aToken proxy's is the book's default aToken implementation; the provider names the pinned Pool, data provider and oracle and reports the market id "Aave V3 Arbitrum Sepolia Testnet Market"; the Pool and the data provider name the provider back; the Pool reports revision 3. The USDC reserve's aToken is `0x460b97BD498E1157530AEb3086301d5225b91216` ("aArbSepUSDC", "Aave Arbitrum Sepolia USDC", 6 decimals, underlying Circle's USDC); the reserve is active, not frozen and not paused, with a supply cap of 10,500,000 USDC, about 5.54 million supplied, a supply rate of about 4.3 per cent a year and 855,827.58 USDC of liquidity. Sourcify reports "match" for the provider, the Pool proxy, the `L2Pool` implementation, the data provider, the oracle, the aToken proxy and its implementation, and "exact_match" for Circle's USDC proxy. The provider's owner is `0xC08C599C22bfD4a729E33e1Ed9b49456Abad0005` (the book's `ACL_ADMIN`). For the record: `0x1dF462e2712496373A347f8ad10802a5E95f053D`, which section 5.1 names as the OP Sepolia market's owner, is Arbitrum Sepolia's WETH reserve (symbol "WETH") on that chain and the OP Sepolia provider's owner on OP Sepolia — one address, two different contracts on two chains.

### 10.3 The engine module

`packages/chains-evm/src/lending.ts` (exported through `index.ts`) holds:

- `LENDING_DEPLOYMENTS`, a table keyed by CAIP-2 chain id with one entry today (`eip155:421614`), so OP Sepolia can follow by table entry once tested; `lendingDeploymentFor`.
- `readReserveState(node, deployment, { blockTag })`, which reads everything at one block and first checks every pinned fact (code at the five addresses, the Pool implementation, the provider's Pool and data provider, the Pool's provider, the revision, the aToken, the aToken's underlying, and that the configured, asset and aToken decimals agree), throwing `LendingStateError` with plain sentences on any mismatch; then the active, frozen and paused flags, the cap, the aToken supply, the treasury's accrued share, the income index, the amount the Pool counts against the cap and the available liquidity, all as exact integers.
- `readLendingPosition(node, deployment, account)` — the aToken balance (the position) and the account's USDC.
- The encoders `encodeAaveSupply` and `encodeAaveWithdraw` and the call builders `lendingApproveCall` (exact amount; zero and the maximum are refused), `lendingSupplyCall` (the supply is always credited to the sending account) and `lendingWithdrawCall` (always paid to the sending account; `'all'` uses the maximum value).
- `quoteLendingSupply` and `quoteLendingWithdraw`, which return the calls or the refusals of `LENDING_REFUSALS`: an inactive or paused reserve, a frozen reserve (supply only), zero, more than the account holds, a supply over the cap (naming the room left), a withdrawal above the position or above the pool's liquidity, and any beneficiary or recipient other than the account itself.
- `checkLendingCalls(calls, deployment, account)`, the check before signing: only `[approve]`, `[supply]`, `[approve, supply]` with the same amount, or `[withdraw]`, every argument word compared.
- `describeAaveError`, which turns Aave's numeric codes, the newer custom errors and a node's "execution reverted: 51" text into sentences, and `decodeLendingReceipt` for the `Supply`, `Withdraw` and collateral events of the pinned Pool.

The cap figure is an estimate as of the block read: the Pool counts the supply at the index of the block that includes the transaction, after accruing interest and the treasury's share, so it can be slightly higher; the send path's `eth_call` pre-flight remains the final check. `packages/chains-evm/test/lending.test.ts` (38 tests) compares every encoder, selector (`supply` `0x617ba037`, `withdraw` `0x69328dec`, `approve` `0x095ea7b3`) and event topic with ethers, replays the reads from a recording at one block (`test/fixtures/lending-arbitrum-sepolia-2026-11-09.json`, which also holds the live receipts' logs), and exercises every refusal and every inconsistency.

### 10.4 The dry run

`scripts/testnet/lending-smoke.mjs` without `LENDING_LIVE` checks the reserve with the engine on both endpoints, quotes a 0.1 USDC supply, and simulates it with `eth_simulateV1` against the real Pool from the dev EOA: the approval (55,437 gas), the supply (217,287 gas) and the withdrawal of everything (186,993 gas) succeed; right after the supply the aToken balance is exactly 100,000 base units and the allowance is back to zero; the withdrawal returns 100,000 and leaves no aToken. The refusals: a supply above the balance is refused by the engine and reverts in USDC ("ERC20: transfer amount exceeds balance"); a supply credited to another address and a withdrawal paid to another address are refused by the engine and by `checkLendingCalls`, and the simulation shows that **Aave itself accepts both** (the other address received the aTokens, or the USDC) — which is why the engine fixes the beneficiary and the recipient; a withdrawal above the position reverts with Aave's `32`. The reserve's configuration word lives in the Pool's storage at `keccak256(abi.encode(USDC, 52))` (the Pool's inherited `VersionedInitializable` takes slots 0 to 51); its decimals, active flag and cap decode to the same values the data provider reports. With that word overridden in simulation and `eth_call` only, the engine's own reader reported a frozen reserve and the quote refused the supply while still quoting a withdrawal, and the Pool reverted a new supply with `28` while allowing the withdrawal; a paused reserve was refused by the quote and the Pool reverted the withdrawal with `29`; a cap of 1 USDC was refused by the quote and the Pool reverted the supply with `51`.

### 10.5 The live run

`LENDING_LIVE=1` sent three transactions from the dev EOA `0x16DA2CAeaDa26516F919C6872F6C38AB378CaC5C` on 2026-11-09, each the engine's own call re-checked by `checkLendingCalls`; every receipt was read on `arbitrum-sepolia-rpc.publicnode.com`, `sepolia-rollup.arbitrum.io` and `arb-sepolia-testnet.api.pocket.network` with identical answers (status `0x1`, block, block hash, gas used and log count):

| Step | Transaction | Block | Gas used (limit) | Effective price | Fee (wei) |
|---|---|---|---|---|---|
| approve exactly 0.1 USDC to the Pool | `0x19de7989c9d1a4169c939331ac6db65c9607acb75c8f91f31986990e7a612bcb` | 327,690,086 | 55,437 (67,488) | 20,000,000 | 1,108,740,000,000 |
| supply 0.1 USDC on behalf of the dev EOA | `0xd79ad98a149ed7ea143bc8fa18bb8148565652cda03c6cc4c79582652257d3e1` | 327,690,102 | 217,287 (275,673) | 20,026,000 | 4,351,389,462,000 |
| withdraw everything to the dev EOA | `0x412bb48307c1eaff4c74cdbbb15b5fb2c4674e82b7cde8e5f12fe84d6b4148a9` | 327,690,168 | 186,993 (236,607) | 20,000,000 | 3,739,860,000,000 |

The layer-1 part of the gas (`gasUsedForL1`) was 0 in all three receipts. After the approval the allowance was exactly 100,000; the supply emitted `Supply` (reserve USDC, user and beneficiary the dev EOA, amount 100,000, referral 0) and `ReserveUsedAsCollateralEnabled`, moved USDC from 38,000,000 to 37,900,000 and the aToken from 0 to 100,000, and left the allowance at 0. At block 327,690,163, 61 blocks later, the position was still exactly 100,000 base units. The withdrawal emitted `Withdraw` (amount 100,000, paid to the dev EOA) and `ReserveUsedAsCollateralDisabled`, moved USDC back to 38,000,000 and the aToken to 0. **What came back was exactly the 0.1 USDC supplied, with no interest**: at about 4.3 per cent a year, 0.1 USDC earns about 0.0026 of a base unit (one base unit is 0.000001 USDC) in the 19 seconds between the supply block (23:00:12 UTC) and the withdrawal block (23:00:31 UTC), so the rounded balance did not move. Every ETH change at block − 1 and block equals gas used times the effective price exactly; over the run the dev EOA went from 21,880,961,341,470,001 to 21,871,761,352,008,001 wei (−9,199,989,462,000, the three fees), and its USDC is unchanged at 38. The worst-case fees of the run (gas limit times the maximum fee) totalled 23,256,190,272,000 wei, within the script's cap of 0.002 ETH.

### 10.6 Still not verified

- A supply or withdrawal from the smart account (one batch through a bundler), and anything in the app: the confirm screen, the preview, the risk card and the readiness row are the app half.
- The interest accrual itself, and any aToken rounding at other amounts: the live position stayed at exactly 100,000 for the 19 seconds it was held.
- What the test market's administrators do later. The engine refuses outright when a pinned fact changes (a replaced Pool implementation, another revision, another aToken); a configuration change such as a lower cap, a freeze or a pause is not an inconsistency and shows up instead as the matching refusal of the quote.
- OP Sepolia, which needs its own table entry and checks.
