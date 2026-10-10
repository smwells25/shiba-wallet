# Staking on a test network (features 57 to 60)

**Status:** Research only, written 2026-10-10 against repository HEAD `38402ed` for phase 17 item 5 (`AGENTS.md`, "Phase 17 plan"). Nothing here is built and no funds were moved. Every on-chain figure is a read-only `eth_call`, `eth_getCode`, `eth_getLogs` or `eth_simulateV1` made on 2026-10-10 through the keyless public endpoints `https://ethereum-sepolia-rpc.publicnode.com` and `https://ethereum-hoodi-rpc.publicnode.com` (plus the Base Sepolia and Arbitrum Sepolia PublicNode endpoints for absence checks), at Sepolia blocks 11,884,826 to 11,884,864 and Hoodi blocks 3,789,530 to 3,789,571 unless stated otherwise. External documents were fetched the same day from the source cited beside each claim. Facts about this repository cite the file they come from. Section 9 lists what could not be verified.

This file is plain technical prose for leadership and for the engineers who would build a slice. The persona and compression rules do not apply to it.

## 1. Summary and recommendation

1. **Native staking (feature 57) cannot be demonstrated on any network the wallet supports.** An Ethereum validator needs at least 32 ETH to activate and an always-online validator client holding a BLS signing key; a phone cannot be that client. What a mobile non-custodial wallet *can* own is the validator's **withdrawal address**: since the Pectra upgrade, that address can trigger exits and partial withdrawals (EIP-7002) and switch the validator to compounding credentials (EIP-7251) with an ordinary transaction. A smart account can be that address. But Ethereum Sepolia's validator set is permissioned (its deposit contract requires a `BEPOLIA` token), Base Sepolia and Arbitrum Sepolia have no beacon chain, and Hoodi, the permissionless test network, is not a profile in this wallet.
2. **Liquid staking (feature 58) has exactly one usable deployment on a network the wallet already supports: Lido on Ethereum Sepolia, and only for staking.** Its stETH and wstETH contracts exist and staking works (simulated today), but Lido's own documentation calls the deployment "fully deprecated"; its withdrawal queue is paused and has never taken a request; and its accounting oracle last processed a report for 2 July 2025, so test stETH no longer earns anything. No liquid-staking deployment was found on Base Sepolia or Arbitrum Sepolia. **Hoodi** has fully working Lido (stake, daily rebases, withdrawal requests finalised, the last report today) and Rocket Pool (rETH, deposits open, burn for ETH available), but the wallet has no Hoodi profile, and Kernel v3.3's factory, its implementation and the CallPolicy module are not deployed there.
3. **The AA angle is real for features 17 and 59 and mostly not real for feature 60.** Staking calls are unusually safe to delegate: Lido's `submit`, wstETH's ETH shortcut, Rocket Pool's `deposit`, Lido's `claimWithdrawal` and rETH's `burn` all pay out only to `msg.sender`, so a session key pinned to them by Kernel's CallPolicy can at worst convert the account's ETH into its own stETH. Sponsored staking (59) needs only a paymaster policy keyed on the staking contract and selector, which the wallet's existing ERC-7677 path could use once a gas policy exists (still an outstanding input). "Gas paid from yield" (60) is, with deployed contracts, nothing more than a token paymaster that accepts stETH or wstETH: Circle's paymaster accepts only USDC; Pimlico's documents stETH and wstETH on main networks only and reports no such token on Sepolia or Hoodi; and no deployed policy can restrict a keeper to the *yield* rather than the principal.
4. **stETH is a rebasing token, and that breaks two assumptions in the wallet.** Balances change daily without any `Transfer` event, and a transfer moves 1 or 2 wei less than requested while the `Transfer` event reports the requested amount. Measured today: three simulated stETH transfers on Hoodi each delivered exactly 1 wei less than the event said, and a 0.01 ETH stake minted 0.009999999999999999 stETH on both networks. The balance display (which reads `balanceOf`) stays correct; the preview, which decodes `Transfer` events, overstates by up to 2 wei.

**Recommendation.** Build, if anything, **"Stake test ETH with Lido on Ethereum Sepolia"** as a stake-only demonstration through the existing send machinery (section 6): one call `submit(address(0))` with value, the regular account and the smart account, the balance preview showing the stETH minted, Lido's own risk statement, and plain statements that this deployment pays no rewards and cannot be unstaked here (the paused queue is read live). Test networks only, enforced by a readiness row. It needs no new profile, contract or engine change. Treat a **Hoodi profile** as a separate, larger decision (section 8): it is the only way to show rewards, the withdrawal queue and Rocket Pool, and initially it would be regular-account only. Do not build feature 60 beyond a design, and build feature 59 only once a sponsorship policy exists.

## 2. Sources

| Source | Pinned at | Used for |
|---|---|---|
| `lidofinance/docs` | commit `140c583d8dc64c9dd842fede3e53c499d44b7796` | `docs/deployed-contracts/sepolia.md`, `hoodi.md`, `holesky.md`; `docs/guides/lido-tokens-integration-guide.md` |
| `lidofinance/core` | tag `v4.0.1` = commit `2da0f48f1a2a103a394dcf8760810fe9165697fb` (the version `hoodi.md` names) | `contracts/0.4.24/Lido.sol`, `StETH.sol`, `contracts/0.6.12/WstETH.sol`, `contracts/0.8.9/WithdrawalQueue.sol`, `contracts/tooling/sepolia/SepoliaDepositAdapter.sol` |
| Sourcify | read 2026-10-10 | Verified sources of the Sepolia Lido implementation, Sepolia and Hoodi wstETH, Hoodi rETH and deposit pool, the deposit contract |
| `rocket-pool/smartnode` | commit `8c1dad70a62ff8d36b64da85e664b10d8b91cf46` | `shared/services/rocketpool/assets/install/networks-default.yml` (official network addresses) |
| `rocket-pool/rocketpool` | commit `fef41a4f7cf99d7d66313c0ba04deb8ba2dabf88` | `contracts/contract/token/RocketTokenRETH.sol`, `contracts/contract/deposit/RocketDepositPool.sol` |
| `ethereum/EIPs` | commit `af3a7802c8ea516f717c6013e27d0f529046f007` | EIP-7002, EIP-7251, EIP-4895 (all Final) |
| `ethereum/consensus-specs` | commit `9a8fdd0703d6ccc18e2c6c52eb08576cace262eb` | `specs/electra/beacon-chain.md` |
| `eth-clients/sepolia` | commit `237ad0dcfa4b93921fbfb178b2317b52d3c3e767` | `README.md`, `metadata/config.yaml` |
| `eth-clients/hoodi` | commit `ef8998901c1350f41a0bcc0a2a8d4baad973abcf` | `README.md`, `metadata/config.yaml` |
| Lido help centre | https://help.lido.fi/en/articles/5230603-what-is-lido, fetched 2026-10-10 | Lido's risk statement (section 6) |
| Pimlico | https://docs.pimlico.io/references/paymaster/erc20-paymaster/supported-tokens, fetched 2026-10-10; `pimlico_getSupportedTokens` on `https://public.pimlico.io/v2/<chain>/rpc` | Token paymaster coverage (section 5) |
| StakeWise | https://docs.stakewise.io/contracts/networks/, fetched 2026-10-10 | Which networks StakeWise V3 is deployed on |

Function selectors below were computed as `keccak256(signature)[0:4]` with ethers 6.17.0 (the version installed in this repository) from signatures copied out of the cited sources.

## 3. Native staking (feature 57)

### 3.1 What a validator needs

- **The deposit.** The deposit contract (`0x00000000219ab540356cBB839Cbe05303d7705Fa` on mainnet and Hoodi; Sourcify exact match on chain 1, match on chain 560048) accepts `deposit(bytes pubkey, bytes withdrawal_credentials, bytes signature, bytes32 deposit_data_root)` and requires a 48-byte BLS public key, 32-byte withdrawal credentials, a 96-byte signature, `msg.value >= 1 ether` in whole gwei, and a matching `deposit_data_root`. It does not check the BLS signature; the consensus layer does.
- **Activation.** The Electra specification sets `MIN_ACTIVATION_BALANCE` to 32 ETH and `MAX_EFFECTIVE_BALANCE_ELECTRA` to 2,048 ETH (`specs/electra/beacon-chain.md`, constants table). `get_max_effective_balance` returns 2,048 ETH only for a validator with compounding (`0x02`) credentials and 32 ETH otherwise.
- **Operation.** After activation the validator must attest and propose with its BLS key every epoch. This needs a consensus client and a validator client online around the clock. A phone app that is suspended in the background cannot do this, and putting the validator's signing key into the wallet would make the wallet a hot validator, which is a different product.

### 3.2 Withdrawal credentials and the Pectra requests

Withdrawal credentials are the address that owns the stake. A `0x01` credential is an execution-layer address in bytes 12 to 31; EIP-7251 adds `COMPOUNDING_WITHDRAWAL_PREFIX = 0x02` with the same layout. The consensus specification's `has_execution_withdrawal_credential` accepts both.

- **Withdrawals arrive without code execution.** EIP-4895: withdrawals "create unconditional balance increases to the specified recipients", and the balance change "MUST not fail". A contract at the withdrawal address therefore receives rewards and exit proceeds without running any code.
- **EIP-7002 (execution-layer exits).** The predeploy `0x00000961Ef480Eb55e80D19ad83579A64c007002` takes exactly 56 bytes of calldata (the 48-byte public key and a big-endian `uint64` amount in gwei; the Electra specification's `FULL_EXIT_REQUEST_AMOUNT = Gwei(0)` makes amount 0 a full exit) and a fee in `msg.value`. The EIP states: "the address that calls the system contract must match the 0x01 withdrawal credential recorded in the beacon state", and the specification's `process_withdrawal_request` compares `withdrawal_credentials[12:]` with the request's `source_address` for both `0x01` and `0x02`. Calling with empty calldata returns the current fee. Read today on Sepolia and Hoodi: code present (504 bytes), fee 1 wei. The EIP also warns that "Overpaid fees are not returned to the caller" and that "Using an EOA to request withdrawals will always result in overpayment of fees".
- **EIP-7251 (consolidation and the switch to compounding).** The predeploy `0x0000BBdDc7CE488642fb579F8B00f3a590007251` takes a source and a target public key. `is_valid_switch_to_compounding_request` requires source equal to target, `withdrawal_credentials[12:] == source_address`, `0x01` credentials, an active validator and no exit in progress. Read today on Sepolia and Hoodi: code present (414 bytes), fee 1 wei.
- On **Base Sepolia and Arbitrum Sepolia** neither predeploy nor any deposit contract has code (checked today).

### 3.3 Can a smart account be the withdrawal address?

Yes, from the sources above: the credential is any 20-byte address, rewards arrive as unconditional balance increases, and exits and the compounding switch are ordinary calls whose `msg.sender` must be that address, which a Kernel account produces when it executes a call. This was reasoned from the specifications and not exercised. Four cautions apply:

1. **The address is permanent in practice.** No mechanism for changing an execution-layer withdrawal address once set was found in the cited specifications (the only change they describe is `0x01` to `0x02`, which keeps the address). A counterfactual (not yet deployed) Kernel address is a valid credential, but if the Kernel factory is missing on that chain the account can never be deployed there and nothing can ever trigger an exit from it; rewards would still accrue but could not be moved. On Hoodi today the Kernel v3.3 factory and implementation have no code (section 8). A wallet must refuse to put an undeployable address into deposit data.
2. **D1 alignment.** A Kernel account whose owner derives from the seed is recoverable from the seed, so pointing withdrawal credentials at it keeps requirement 2. Pointing them at a smart account owned by an imported key (D9) or governed by guardians or heirs inherits those modules' weaknesses (`docs/MULTISIG.md`, the inheritance record in `AGENTS.md`).
3. **Fees.** The EIP-7002 fee rises exponentially with demand. A UserOperation cannot read the fee and pay exactly in one step with the wallet's current call encoding; it would pay a quoted fee with a margin, and any overpayment is lost.
4. **Session keys cannot sensibly pin these calls.** The predeploys take raw calldata with no function selector, so CallPolicy (which keys calls on the first four bytes) would see the first four bytes of the validator's public key as the "selector". Owner-signed operations are unaffected.

### 3.4 What a mobile wallet can and cannot do for native staking

| Can do | Cannot do |
|---|---|
| Hold the withdrawal address (EOA or smart account) and show what arrives there | Run the validator or hold its BLS key |
| Submit a deposit transaction built from deposit data produced elsewhere (for example by a staking-deposit tool), after checking locally that the withdrawal credentials equal one of its own addresses and that `deposit_data_root` matches | Verify the BLS signature in the deposit data (the deposit contract does not either; a bad signature loses the deposit's activation) |
| Trigger a full exit or a partial withdrawal (EIP-7002), and switch to `0x02` (EIP-7251), from the withdrawal address | Guarantee the EIP-7002 fee in advance |
| Delegate SOL on Solana (row 57 names Solana first): on devnet today `getStakeMinimumDelegation` returned 1,000,000,000 lamports (1 SOL) and `getVoteAccounts` listed 18 current validators (`https://api.devnet.solana.com`, read 2026-10-10) | Show Solana staking in the app today: a search of `app/src` for "devnet" found nothing, so the app appears to have no Solana test profile (not investigated further; out of scope here) |

### 3.5 The test networks

- **Ethereum Sepolia: permissioned.** `eth-clients/sepolia` issue 12 is titled "Requests to join Sepolia permissioned validator set" (open). The deposit contract named in `metadata/config.yaml`, `0x7f02C3E3c98b133055B8B348B2Ac625669Ed295D`, is also an ERC-20: read today, `name()` "Sepolia deposit contract token", `symbol()` "BEPOLIA". Lido's `SepoliaDepositAdapter.sol` explains: "Sepolia contract require specific Bepolia token to be used for depositing. It burns this token after depositing" and "It returns the ETH to the sender after depositing." A wallet user cannot stake natively on Sepolia.
- **Hoodi: permissionless.** The `eth-clients/hoodi` README lists "Flavor: Permissionless (Proof-of-Stake), _to replace Holešky_", chain id 560048, the deposit contract above, and "LTS: Dec/2027, EOL: Dec/2028". A native stake there still needs 32 test ETH and a running validator.
- **Base Sepolia, Arbitrum Sepolia:** layer-2 networks with no validators of their own; native ETH staking does not exist there.

### 3.6 Pooled alternatives to a full validator

Pooled node-operator programmes (Lido's community staking module and stVaults, both listed in `hoodi.md`; Rocket Pool node operation) still require running a validator node and posting a bond, so they share the "phone cannot be the node" limit. Their bond sizes and rules were not researched. For a wallet user without a node, the pooled alternative is liquid staking (section 4).

## 4. Liquid staking (feature 58)

### 4.1 Deployments on test networks

| Protocol | Network | Contract | Address | Official source | On-chain check (2026-10-10) |
|---|---|---|---|---|---|
| Lido | Ethereum Sepolia | stETH (Lido proxy) | `0x3e3FE7dBc6B4C189E7128855dD526361c49b40Af` | `lidofinance/docs` `sepolia.md` | 1,007-byte proxy; `symbol()` "stETH", `name()` "Liquid staked Ether 2.0", 18 decimals; implementation `0x3e7e93bA66d26608c2Ffe1630F445D8D29aC6C92` (Sourcify exact match, `contracts/0.4.24/Lido.sol`); `getContractVersion()` 2 |
| Lido | Ethereum Sepolia | wstETH | `0xB82381A3fBD3FaFA77B3a7bE693342618240067b` | same | `symbol()` "wstETH"; `stETH()` = the address above; Sourcify exact match |
| Lido | Ethereum Sepolia | Withdrawal queue (ERC-721) | `0x1583C7b3f4C3B008720E6BcE5726336b0aB25fdd` | same | `symbol()` "unstETH"; `isPaused()` **true**; `getLastRequestId()` **0** |
| Lido | Hoodi | stETH (Lido proxy) | `0x3508A952176b3c15387C97BE809eaffB1982176a` | `lidofinance/docs` `hoodi.md` | `symbol()` "stETH", 18 decimals; implementation `0xB9A2Fb8336f3775d790b3FdD6151e3F193AA7352` (equals `hoodi.md`; not on Sourcify); `getContractVersion()` 4 |
| Lido | Hoodi | wstETH | `0x7E99eE3C66636DE415D2d7C880938F2f40f94De4` | same | `symbol()` "wstETH"; Sourcify exact match |
| Lido | Hoodi | Withdrawal queue (ERC-721) | `0xfe56573178f1bcdf53F01A6E9977670dcBBD9186` | same | `symbol()` "unstETH"; `isPaused()` false; last request 5,320, last finalised 5,320 |
| Rocket Pool | Hoodi | RocketStorage | `0x594Fb75D3dc2DFa0150Ad03F99F97817747dd4E1` | `rocket-pool/smartnode` `networks-default.yml` ("Hoodi Testnet", chain 560048) | code present; `getDeployedStatus()` true |
| Rocket Pool | Hoodi | rETH | `0x7322c24752f79c05FFD1E2a6FCB97020C1C264F1` | same (`reth:`) | equals RocketStorage's `contract.address` / `rocketTokenRETH` entry; `symbol()` "rETH", `name()` "Rocket Pool ETH"; Sourcify match |
| Rocket Pool | Hoodi | Deposit pool | `0x425E6f83e27f1676AD78BC39dA79C2C7b33d3Fd8` | resolved from RocketStorage `rocketDepositPool` | `version()` 4; Sourcify match (`RocketDepositPool.sol`, solc 0.8.30) |

**Not found:** Lido's Sepolia page lists bridged wstETH only on OP Sepolia, Scroll Sepolia, Mode, BSC testnet, Zircuit and Soneium Minato, and its Hoodi page lists none on Base Sepolia or Arbitrum Sepolia. Rocket Pool's network file lists mainnet, Hoodi, a devnet and "Platåberget Testnet", not Sepolia. StakeWise's documentation says V3 is "deployed across 3 supported networks: Mainnet, Gnosis, and Hoodi"; its Hoodi addresses were not read on-chain. Holešky deployments are marked "fully deprecated" by Lido. Other protocols (ether.fi, Stader, Frax, Swell and others) were not researched.

### 4.2 Lido on Ethereum Sepolia: what works today

- Lido's page opens: "The **Sepolia** deployment is now fully **deprecated**. Please use the **Hoodi** deployment instead", and adds that "There will be no comprehensive Lido testnet environment available for Sepolia due to the network's restricted and permission-based validator set".
- **Staking works.** `isStakingPaused()` false, `getCurrentStakeLimit()` 150,000 ETH. A simulated `submit(address(0))` with 0.01 ETH succeeded (gas used 208,421) and minted 9,636,531,002,706,151 shares, shown as 9,999,999,999,999,999 stETH (1 wei below the ETH sent). The latest `Submitted` event in a 300,000-block scan was at block 11,879,208 (2026-10-09 18:41 UTC), so people still stake there.
- **No rewards.** The accounting oracle's `getLastProcessingRefSlot()` is 7,977,087; with the genesis time 1,655,733,600 and 12-second slots that its own HashConsensus contract reports (`getChainConfig()` = 32, 12, 1655733600), that slot is 2025-07-02 12:17:24 UTC. Of 4,715.88 ETH pooled, 4,619.88 is still buffered (not sent to validators). stETH balances therefore do not grow.
- **No unstaking through Lido.** The withdrawal queue is paused and has never created a request. wstETH ↔ stETH wrapping still works (it is a fixed-rate conversion inside the token contracts).

### 4.3 Lido on Hoodi

Fully operational on the reads above: staking open (current stake limit 3,000 ETH), 2,334,056.55 ETH pooled, `stEthPerToken()` 1.032672040857986356, the oracle's last processing reference slot 4,118,367 = 2026-10-10 12:03:24 UTC (Hoodi genesis 1,742,213,400 from its HashConsensus and the README), a frame of 225 epochs (24 hours), and every one of 5,320 withdrawal requests finalised. A simulated 0.01 ETH `submit` minted 9,683,616,486,500,001 shares, again shown as 9,999,999,999,999,999 stETH (gas used 94,167; the difference from Sepolia's figure was not investigated).

### 4.4 Rocket Pool on Hoodi

Deposits enabled; minimum deposit 0.01 ETH; deposit fee 0.0005 ETH per ETH (0.05%); maximum deposit pool size 18,000 ETH with 15.39 ETH currently in it; `getExchangeRate()` 1.036779331850524078 ETH per rETH; total collateral available for burns 917.55 ETH; the network balances were last updated at block 3,789,184 (2026-10-10 13:11:24 UTC). A simulated `deposit()` with 0.01 ETH succeeded and minted 0.009640431375266856 rETH, which equals 0.01 × (1 − 0.0005) / 1.036779… to the displayed precision.

### 4.5 The calls

| Action | Contract | Function (selector) | Pays out to | Source |
|---|---|---|---|---|
| Stake ETH, receive stETH | Lido (stETH) | `submit(address _referral)` payable (`0xa1903eab`); also the fallback with empty calldata | `msg.sender` (`_mintShares(msg.sender, …)` in `_submit`); `msg.value` must be non-zero ("ZERO_DEPOSIT") and within the stake limit | `Lido.sol` v4.0.1 lines 497–510, 1253–1266; the Sepolia implementation's verified source has the same `submit` and `_submit` |
| Stake ETH, receive wstETH, one call | wstETH | plain ETH transfer (`receive()`) | `msg.sender` | `WstETH.sol` lines 80–83: "Shortcut to stake ETH and auto-wrap returned stETH" |
| Wrap / unwrap | wstETH | `wrap(uint256)` (`0xea598cb0`, needs a stETH approval) / `unwrap(uint256)` (`0xde0e9a3e`) | `msg.sender` | `WstETH.sol` lines 53–75 |
| Request unstake | Withdrawal queue | `requestWithdrawals(uint256[] _amounts, address _owner)` (`0xd6681042`), `requestWithdrawalsWstETH(uint256[],address)` (`0x19aa6257`), or the `…WithPermit` variants | an ERC-721 request minted to `_owner` (`msg.sender` if zero); needs a prior stETH approval | `WithdrawalQueue.sol` lines 119–175 |
| Claim | Withdrawal queue | `claimWithdrawal(uint256)` (`0xf8444436`); `claimWithdrawals(uint256[],uint256[])` (`0xe3afe0a3`); `claimWithdrawalsTo(…, address)` (`0x5e7eead9`) | `msg.sender`, except `claimWithdrawalsTo` | `WithdrawalQueue.sol` lines 244–290 |
| Stake ETH, receive rETH | Rocket Pool deposit pool | `deposit()` payable (`0xd0e30db0`) | `msg.sender` (`rocketTokenRETH.mint(depositNet, msg.sender)`) | `RocketDepositPool.sol` lines 114–156 |
| Redeem rETH for ETH | rETH | `burn(uint256)` (`0x42966c68`) | `msg.sender` | `RocketTokenRETH.sol` lines 105–123 |

Two protocol details matter for a wallet:

- Rocket Pool's `deposit()` carries `onlyThisLatestContract`, which requires `address(this)` to equal RocketStorage's current `rocketDepositPool` entry ("Invalid or outdated contract", `RocketDepositPool.sol` lines 59–63), so after an upgrade the old deposit pool refuses deposits. A wallet must resolve it from RocketStorage at quote time, not hard-code it.
- `deposit()` has the same selector as WETH's `deposit()`. The wallet's WETH decoding is pinned to the wrapped-native contracts it lists (`AGENTS.md`, phase 13 item 4 (7)), so it should not misread a Rocket Pool deposit; this was not tested.

### 4.6 Unstaking mechanics

- **Lido.** The integration guide: requests are a FIFO queue "finalized with oracle reports as soon as ether to fulfill the request is available"; each request is "at least **100 wei** (in stETH) and at most **1000 stETH**" (the contract constants `MIN_STETH_WITHDRAWAL_AMOUNT = 100` and `MAX_STETH_WITHDRAWAL_AMOUNT = 1000 * 1e18` agree, read on both networks); "Once requested, withdrawal cannot be canceled"; the request NFT is transferable and its holder claims; the claimable amount cannot exceed the stETH/ETH rate at request time and can be lower after large losses. The waiting time depends on validator exits and was not measured. On Hoodi every request was already finalised at read time; on Sepolia the queue is paused.
- **Rocket Pool.** No queue: `burn` pays immediately from the rETH contract's balance plus the deposit pool's excess, and reverts with "Insufficient ETH balance for exchange" beyond that (917.55 ETH available on Hoodi today). Rocket Pool also blocks every transfer **and burn** of rETH from an address for `network.reth.deposit.delay` blocks after its last deposit (`_beforeTokenTransfer`, lines 157–172): read today on Hoodi, **5,760 blocks**, about 19 hours 12 minutes at 12-second slots. A new staker cannot send, swap or redeem rETH for that long.

### 4.7 Can a session key's calls be pinned?

The wallet's session keys use Kernel's CallPolicy v0.0.4 (`0x9a52283276A0ec8740DF50bF01B28A80D880eaf2`), which allows (target, selector) pairs with an ETH value cap and rules on 32-byte argument words at fixed offsets, and keys a call with empty calldata as selector `0x00000000` (`packages/chains-evm/src/kernel-permissions.ts`). From the sources in section 4.5, and not tested live:

- **Stake calls pin cleanly.** (stETH, `0xa1903eab`, value ≤ cap) or (stETH, empty calldata, value ≤ cap); (wstETH, empty calldata, value ≤ cap); (current Rocket Pool deposit pool, `0xd0e30db0`, value ≤ cap). None of them takes a recipient, so the output always lands in the account itself. A stolen key could only convert ETH into the account's own stETH, wstETH or rETH, within the caps and the fee budget.
- **Claims and burns pin cleanly**: `claimWithdrawal(uint256)` and `burn(uint256)` pay `msg.sender`; `claimWithdrawalsTo` must not be allowed.
- **A withdrawal request needs care.** `requestWithdrawals(uint256[],address)` has a dynamic array, which `docs/SCHEDULED_PAYMENTS.md` section 4.2 treats as unpinnable because the caller writes the offset. For a one-element array this appears pinnable by also pinning the offset word (word 0 equal to `0x40`) and the length word (word 2 equal to 1), plus the owner (word 1 equal to the account or zero) and the amount (word 3 at most the cap). This is reasoned from the ABI encoding rules only. It refines, but has not been tested against, the earlier rule, and the approval to the queue would also have to be a pinned call.
- **Anything routed through an aggregator, a router or a DEX cannot be pinned** (`docs/SCHEDULED_PAYMENTS.md` section 4.2). That excludes "unstake by selling stETH or rETH" from any session key.
- The batching weakness of `docs/SCHEDULED_PAYMENTS.md` section 2 applies unchanged: a key can batch several capped calls into one operation, and a GasPolicy fee budget is mandatory.
- On Hoodi none of this is available: CallPolicy has no code there.

## 5. The AA angle (features 59 and 60)

### 5.1 Sponsored staking (feature 59)

A sponsor pays the gas through a paymaster; the wallet already requests sponsorship through ERC-7677 (`AGENTS.md`, phase 5). What a sponsorship policy would need:

- **Scope:** sponsor only operations whose calls are exactly the pinned staking calls of section 4.7 on the chain's known addresses, with the sender's own address as the only recipient. Whether a vendor's policy engine can express "target and selector only" and a minimum value was not verified for any vendor.
- **A minimum stake.** Lido accepts any non-zero amount ("ZERO_DEPOSIT" is the only lower bound), so without a floor a sponsor pays gas for 1-wei stakes; Rocket Pool's own minimum is 0.01 ETH (read on Hoodi).
- **Rate limits per account,** because the gas is the sponsor's cost.
- **Inputs:** the ZeroDev gas policy (still outstanding per `AGENTS.md`, phase 14 status) or another vendor's key. Lido's documentation describes a rewards-share programme for integrators (`docs/integrations/wallets.md`); whether any protocol funds testnet sponsorship was not researched.

### 5.2 "Gas paid from staking yield" (feature 60)

- **Circle's paymaster** reads one immutable token per deployment, `token()`; this repository records it as USDC on Base Sepolia and Arbitrum Sepolia (`packages/chains-evm/src/token-paymaster.ts`, `CIRCLE_TOKEN_PAYMASTER_V07.tokens`). It cannot take stETH. It has no code on Hoodi (read today).
- **Pimlico's paymaster** is token-agnostic on-chain (the token is a field of Pimlico's signed paymaster data, `packages/chains-evm/src/erc7677-token-paymaster.ts`), so support is Pimlico's service decision. Its supported-token page lists stETH on Ethereum and Optimism and wstETH on Ethereum, Optimism, Base and Arbitrum, all main networks, and for Sepolia only USDC (two addresses), EURC, EURe, PIM and USD₮. Asked today through the keyless public endpoint, `pimlico_getSupportedTokens` returned USDC, PIM, EURe and USD₮ for Sepolia and an empty list for Hoodi. **No paymaster accepts a liquid-staking token on any test network found.**
- **What would be needed on a test network:** a token paymaster that accepts **wstETH** (not stETH; see 5.3) and prices it from `wstETH.stEthPerToken()` with the "1 stETH = 1 ETH" convention the Lido guide describes for money markets, deployed by someone and staked at the EntryPoint. No audited contract of that shape was identified, and deploying one would put this project in the paymaster business.
- **"Only the yield" cannot be enforced with deployed modules.** The yield is the difference between the current value and what was staked. For stETH that principal exists nowhere on-chain; for wstETH the yield is a change in the rate, not in the balance. CallPolicy compares calldata words with fixed values and never reads a balance or a rate (`docs/SCHEDULED_PAYMENTS.md` section 2), so a keeper allowed to move stETH or wstETH to a gas budget could move principal too. The app could track the principal and stop itself, but the account would not enforce it. Feature 60 as described in `docs/FEATURE_UNIVERSE.md` ("a scoped session key lets the keeper skim only accrued yield") is therefore not achievable honestly with the deployed modules; "pay gas in wstETH through a token paymaster" is, on main networks only, and it spends principal and yield alike.

### 5.3 Risks the wallet must handle

- **Rebasing balances.** The Lido guide: stETH balances "get recalculated daily when the Lido oracle reports", the rebase "can be positive or negative", and stETH "does not emit `Transfer()` on rebase". The wallet reads token balances with `balanceOf` (`packages/chains-evm/src/erc20.ts`), so Home is right whenever it reads. Anything that derives a balance by summing `Transfer` events, or caches a balance and compares it later, will drift. Spending limits and approvals denominated in stETH drift against the rate. Rocket Pool's rETH and Lido's wstETH do not rebase; their value per token changes instead.
- **The 1–2 wei corner case and the preview.** The Lido guide: "the actually transferred amount is 1-2 wei less than expected", and `StETH._transfer` emits `Transfer` with the *requested* amount (`StETH.sol` lines 428–432, 562–565). Measured today by simulation on Hoodi: requested 3,333,333,333,333,333, event 3,333,333,333,333,333, recipient received 3,333,333,333,333,332; the same 1-wei shortfall for 1,234,567,890,123,457 and 7,777,777,777,777,777. The balance-change preview (`packages/chains-evm/src/asset-diff.ts`) decodes `Transfer` events, so for stETH it can overstate what arrives by up to 2 wei. For a stake, the mint event reports the true minted value (`getPooledEthByShares`), which was 1 wei below the ETH sent in both simulations. A "Max" send of stETH leaves 1–2 wei behind; Lido recommends `transferShares` for exact moves.
- **Prices.** Test-network tokens are never priced (`app/src/wallet/prices.ts`, `tokenPriceAssetId`). On a main network the fiat value of stETH should follow the protocol rate rather than a market price for display consistency with Lido's own guidance, and the screen must still say that the market price can be lower (Lido's "stETH price risk", section 6). Not designed further here.
- **The risk card** would call the staking contract "a contract" and may add a contract-age line, as it did for token contracts before phase 13's fix. A slice should give known staking contracts their own one-line description, keyed on pinned (chain, address) pairs, the way `tokenTransferTarget` treats tracked tokens.

## 6. The smallest honest slice

**"Stake test ETH with Lido on Ethereum Sepolia" (stake-only demonstration).**

- **Where:** Ethereum Sepolia only; a readiness row (for example `liquid-staking`, test networks only, enforced). Base Sepolia and Arbitrum Sepolia show "not available on this network".
- **The call:** `{ to: 0x3e3FE7dB…49b40Af, value: amount, data: submit(address(0)) }`. Regular account: through `prepareEvmSend(url, from, to, value, data, caip2)` in `app/src/wallet/send.ts`, exactly as `prepareSwapSend` reuses it, so the chain-id check, gas pricing, balance check and `eth_call` pre-flight are the existing ones. Smart account: one call through `prepareAaCalls` in `app/src/wallet/aa.ts`, with the existing fee-floor and signed-fee guards. Optionally a second choice, "receive wstETH", as a plain ETH transfer to wstETH `0xB82381A3…240067b` (one call, no approval). No engine change and no new dependency.
- **Before the confirm:** read `isStakingPaused()` and `getCurrentStakeLimit()` and refuse plainly when staking is paused or the amount is above the limit.
- **The confirm:** the existing balance preview shows "−0.001 test ETH, +0.000999999999999999 stETH" (the stETH line labelled by contract address); a note that stETH is often 1–2 wei below the ETH sent because of share rounding; and the known-protocol risk line of section 5.3.
- **Protocol risk statement** (Lido help centre, quoted verbatim from the fetch of 2026-10-10; re-check before shipping copy): "There is an inherent risk that Lido Protocol could contain a smart contract vulnerability or bug." / "ETH validators risk staking penalties, with up to 100% of staked funds at risk if validators fail." / "Users risk an exchange price of stTokens which is lower than inherent value due to withdrawal restrictions on Lido, making arbitrage and risk-free market-making impossible."
- **Honesty lines specific to Sepolia:** "Lido calls its Sepolia deployment deprecated. Test stETH here does not earn rewards: Lido's oracle has not reported since July 2025." and, when the user asks to unstake, after reading `isPaused()` live: "Unstaking through Lido is paused on Sepolia. On Ethereum mainnet, unstaking is a request that waits in Lido's queue before the ETH can be claimed."
- **Tokens:** stETH and wstETH as known Sepolia tokens with a rebasing flag on stETH (the per-network token lists from phase 13 item 1). stETH sends are either left out of the slice or carry the 1–2 wei note on the confirm and on Max.
- **Not in the slice:** unstaking, Rocket Pool, session keys, sponsorship, gas from yield, fiat values, mainnet.
- **Cost:** a small screen, the known-token entries, the readiness row, the risk-card line and copy checks. It reuses every safety gate the send paths already have.

**Hoodi alternative (larger).** The same slice on Hoodi could show the whole lifecycle: stake, daily rebases, a withdrawal request (approve + request, atomic in a smart account but regular-account only at first), finalisation and claim, plus Rocket Pool deposit and burn after the 5,760-block delay. It needs the profile work of section 8 first.

## 7. What the test networks lack, and what the emulator could show

- **No real economics anywhere.** Test ETH has no price, so APRs, fiat values and the market discount of stETH cannot be shown. On Sepolia even the protocol rate is frozen. On Hoodi the rate moves, but its size says nothing about mainnet.
- **No native staking demo** on any supported network (section 3.5).
- **Funding.** The slice needs only about 0.001 Sepolia ETH per stake; the dev EOA held about 0.031 Sepolia ETH at the last recorded figure (`AGENTS.md`, phase 14 wave 1). Hoodi needs Hoodi ETH, which no project wallet holds as far as recorded; Hoodi faucets were not checked.
- **What the emulator could show (Sepolia slice):** the stake from Account 1's regular account with one prompt, the preview line with the 1-wei-short stETH amount, the stETH row appearing on Home with the exact balance, the same stake from the Kernel smart account with one prompt, the ETH-to-wstETH shortcut, the "deprecated, no rewards" and "unstaking paused" sentences, and the refusals on Base Sepolia and Arbitrum Sepolia. It could not show rewards accruing, an unstake, or anything on mainnet.

## 8. What adding a Hoodi profile would cost

From `app/src/config/evm-chain.ts` (`EvmChainProfile`) and the phase 14 Arbitrum Sepolia record in `AGENTS.md`, a new profile means:

- **Endpoints:** `https://ethereum-hoodi-rpc.publicnode.com` and `https://rpc.hoodi.ethpandaops.io` both answered `eth_chainId` 0x88bb0 (560048) today, and the PublicNode endpoint served `eth_simulateV1`, so the balance preview would work there; documentation for both, `eth_getLogs` window limits and send support were not checked. Explorer: `hoodi.etherscan.io` appears in Lido's and Rocket Pool's own files; the transaction-page path was not checked.
- **Account abstraction:** EntryPoint v0.7 is deployed (16,035 bytes), as are the Kernel meta factory `0xd703…42d5` and the ECDSA validator `0x845A…cE57`, but the **KernelFactory `0x2577…F2E9`, the Kernel v3.3 implementation `0xd6CE…5b28` and CallPolicy `0x9a52…eaf2` have no code**. `verifyKernelDeployment` would fail, so the profile would start with `aaPrefill: null` and `kernelV33Verified: false`: regular accounts only. The deterministic CREATE2 deployer `0x4e59…956C` has code on Hoodi and Kernel's `script/DeployKernel.s.sol` (tag v3.3, commit `cd697c7e`) deploys with `new Kernel{salt: 0}` and `new KernelFactory{salt: 0}`, so deploying the same contracts at the same addresses may be possible for anyone; that was not verified, and the meta factory's approval of a factory is a separate step whose permissions were not checked.
- **Bundler and paymasters:** Pimlico's keyless public endpoint lists EntryPoint v0.7 for chain 560048; whether ZeroDev serves Hoodi was not checked (it needs the project key). Pimlico's paymaster contract has code on Hoodi but no supported tokens; Circle's paymaster has no code there.
- **Names:** the ENS Universal Resolver `0xeEeE…EeEe` has no code on Hoodi, so names would be refused as on Base Sepolia.
- **The usual per-profile entries:** readiness rows, known tokens (none identified for Hoodi beyond the staking tokens), the risk block time (12 s), the NFT explorer, the recovery-file label, WalletConnect strings, and a scheduled upgrade: Glamsterdam activates on Hoodi at 2026-10-26 17:42:48 UTC (`eth-clients/hoodi` README), which changes how ETH transfers appear in simulations (EIP-7708); `asset-diff.ts` already handles both forms, as Sepolia shows.
- **Lifetime:** Hoodi's README gives "LTS: Dec/2027, EOL: Dec/2028".

## 9. What could not be verified

- The Hoodi Lido implementation `0xB9A2…7352` and the Hoodi withdrawal-queue implementation `0xD0a6…eCD5` are not on Sourcify; their behaviour was taken from tag v4.0.1 (the version Lido's page names) and from the simulations, not from a bytecode match. The Rocket Pool sources are from the repository head, matched on-chain only by `version()` and Sourcify's match of the deployed rETH and deposit pool, not compared line by line with that commit.
- No transaction was sent. Every stake, wrap, deposit and transfer figure is an `eth_simulateV1` result against the latest block. A live run through ZeroDev's bundler, the risk card's real output and the preview's real rendering were not checked.
- The CallPolicy pinning of section 4.7 (in particular the one-element-array rule) was reasoned, not tested.
- The smart-account-as-withdrawal-address analysis in section 3.3 was reasoned from the EIPs and the consensus specification; no deposit, exit or consolidation was performed.
- How long Lido withdrawals take on Hoodi or mainnet; Rocket Pool's risk statement; StakeWise's Hoodi addresses; other liquid-staking protocols; any vendor's ability to express a staking-only sponsorship policy; whether any protocol sponsors testnet gas.
- Whether Pimlico's service would accept stETH or wstETH on a main network through ZeroDev's endpoint (the docs say it is supported; not called).
- Why the simulated `submit` used 208,421 gas on Sepolia and 94,167 on Hoodi.
- Whether the app has a Solana test profile (only a text search was made).
