# Token-bound accounts (feature 45, ERC-6551)

**Status:** Research only, written for phase 25 item 5 (`AGENTS.md`, "Phase 25 plan") against repository commit `215f3e0`. Nothing here is built and no transaction was sent. Every on-chain fact is a read-only `eth_chainId`, `eth_blockNumber`, `eth_getCode` or `eth_call` (some `eth_call`s with a code override or a block-time override, which change nothing on chain) made between 04:05 and 04:08 UTC on 2026-11-09 (the evening of 2026-11-08, US Eastern) through the keyless endpoints in section 2. Section 10 lists what could not be verified.

## 1. Summary

1. **The ERC-6551 registry is deployed, byte for byte as the ERC specifies, on all six networks the wallet uses** (Ethereum mainnet, Ethereum Sepolia, Base Sepolia, Arbitrum Sepolia, OP Sepolia, Hoodi), read on two RPCs each. Its 571-byte runtime code hashes to `0xda1d5b06…6735`, which equals the runtime embedded in the deployment transaction printed in the ERC itself. Sourcify holds it as an exact match on mainnet, Ethereum Sepolia and Arbitrum Sepolia and as a match on Base Sepolia; it has no record for OP Sepolia or Hoodi, where the code is identical. ERC-6551 is still in **Review**, not Final.
2. **Tokenbound's account contracts (the most widely documented implementation) are also deployed on all six networks,** although Tokenbound's own deployments page lists none of the wallet's test networks. The deployed implementation's verified source equals the `v0.3.1` release tag of `tokenbound/contracts` file for file, not the repository's current head. Its ERC-4337 support targets EntryPoint **v0.6**, which this wallet does not use.
3. **What owns a token-bound account is whoever the token contract's `ownerOf(tokenId)` names.** Both the ERC's example and Tokenbound's implementation call the ERC-721 function `ownerOf`; a token contract without it gives the zero address, so nobody controls the account. A plain ERC-1155 token has no `ownerOf`, and the ERC calls fungible and semi-fungible use "outside the scope of the proposal".
4. **The ENSv2 `.eth` registry is an exception: it is ERC-1155 but implements `ownerOf`.** A read-only simulation of a Tokenbound account bound to each of the wallet's two names (`qzv7hk2wmt.eth`, held by Account 1, and `xk9fdq4rvz.eth`, held by Account 1's Kernel smart account) returned the right holder as `owner()` and accepted that holder, and nobody else, as a signer. So the wallet's names could own token-bound accounts.
5. **Doing so would be unsafe for anything of value.** The registry's `ownerOf` returns the zero address once the name expires (both expire on 2026-11-24) and once the token is "regenerated", which ENSv2 does on every role grant or revocation and which permanently changes the token id. An account bound to the old id would then have no owner, for good. Tokenbound's implementation also guards against ownership cycles only for ERC-721, not ERC-1155.
6. **A Kernel v3.3 smart account cannot be a token-bound account's implementation** (it lacks the required interface), but the wallet's Kernel can be the *holder* that controls one, by calling its `execute` function directly.
7. **Recommendation: NO-GO for building now.** An honest demonstration needs an ERC-721 token the wallet holds with no expiry (it holds none) or an explicit decision to use a test name with nothing of value in its account. A read-only "this NFT's account" line could come later.

## 2. Sources

| Source | Pinned at / fetched | Used for |
|---|---|---|
| ERC-6551 text, `ethereum/ERCs` `ERCS/erc-6551.md` | repository head `79159dc6392463ce514278c47bec2a38c4735d62` (committed 2026-11-09T02:28:02Z; the file's own last-change commit was not read because the clone was shallow); file SHA-256 `315055a2cc230ddb30fa93bac6dc053cac0d961c2b10ad694593740278355815`, equal to the raw file at that commit | The specification, the registry address and runtime, the example account |
| ERC-6551 reference repository `erc6551/reference` (the `tokenbound/reference` URL resolves to the same commit) | `da16a63fb53db6375175a9dca22f1e19e652a193` (2023-10-24) | `src/ERC6551Registry.sol`, interfaces, test mocks |
| `tokenbound/contracts` | head `bce75f985558fad3d06ee1b86f224f0cfb783631` (2024-03-11) and tag `v0.3.1` (`2bd70ff3fb5f1c0e562425b4d5312f619d9f2720`) | `AccountV3.sol`, `AccountProxy.sol`, `AccountGuardian.sol`, `AccountV3Upgradable.sol`, `script/DeployAccountV3.s.sol` |
| Tokenbound deployments page `https://docs.tokenbound.org/contracts/deployments` | fetched 2026-11-09 | The published addresses and network list |
| `ensdomains/contracts-v2` | `07e55a056f5b6a9c90119f501bdd05714e67dddd` (the commit the wallet's ENS engine pins, `packages/chains-evm/src/ens-register.ts` 70) | `contracts/src/registry/PermissionedRegistry.sol`, `contracts/src/erc1155/ERC1155Singleton.sol`, `contracts/src/registry/interfaces/IPermissionedRegistry.sol` |
| Sourcify v2 API `https://sourcify.dev/server/v2/contract/<chainId>/<address>` | read 2026-11-09 04:05 | Verification status, compiler, verified sources |
| RPC endpoints (from `app/src/config/evm-chain.ts` 171–172, 290–293, 419–421, 555–557, 685–687, 825–827, plus `0xrpc.io/eth` for mainnet) | read 2026-11-09 04:05–04:08 | `ethereum-rpc.publicnode.com` and `0xrpc.io/eth` (mainnet, head 26,374,824); `ethereum-sepolia-rpc.publicnode.com` and `eth-sepolia-testnet.api.pocket.network` (head 12,095,024); `base-sepolia-rpc.publicnode.com` and `sepolia.base.org` (head 56,376,222); `arbitrum-sepolia-rpc.publicnode.com` and `sepolia-rollup.arbitrum.io/rpc` (head 327,444,862); `optimism-sepolia-rpc.publicnode.com` and `sepolia.optimism.io` (head 51,197,287); `ethereum-hoodi-rpc.publicnode.com` and `rpc.hoodi.ethpandaops.io` (head 3,979,177) |
| This repository at `215f3e0` and `AGENTS.md` (pass p23-handle) | — | The wallet's names, accounts and Kernel details |

Every read was made on both RPCs of its network and the two answers agreed in every case.

## 3. What ERC-6551 specifies

- **A singleton registry.** "The registry is permissionless, immutable, and has no owner." It "MUST be deployed at address `0x000000006551c19487814612e58FE06813775758` using Nick's Factory (`0x4e59b44847b379578588920cA78FbF26c0B4956C`)" with a fixed salt (`erc-6551.md` 58). It has two functions: `createAccount(implementation, salt, chainId, tokenContract, tokenId)` and the view `account(…)` with the same arguments.
- **Each account is a minimal proxy with the token's identity appended.** The registry deploys an ERC-1167 proxy to the chosen implementation followed by four 32-byte words: salt, chain id, token contract and token id. The address is a CREATE2 address of those five inputs, so an account can receive assets before it exists ("counterfactual accounts"). Anyone may create the account for any token.
- **Many accounts per token are allowed** ("Account Ambiguity"): a different implementation or salt gives a different account for the same token.
- **The account interface** (ERC-165 id `0x6faff5f1`, line 158): `receive()`, `token()` (constant), `state()` and `isValidSigner(signer, context)`, which "MUST return the bytes4 magic value 0x523e3260 if the given signer is valid" (195), with the rule that "By default, the holder of the non-fungible token the account is bound to MUST be considered a valid signer." Accounts must also implement ERC-165 and ERC-1271, and "MUST implement an execution interface"; the optional standard one is `execute(to, value, data, operation)` (id `0x51945447`, 222).
- **How "the holder" is found is left to the implementation.** The ERC's example account uses `IERC721(tokenContract).ownerOf(tokenId)` and returns the zero address when the chain id differs (`erc-6551.md` 417–422).
- **Token types.** The registry does not check for ERC-721, which "allows the system described in this proposal to be used with semi-fungible or fungible tokens, although these use cases are outside the scope of the proposal" (311).
- **Security considerations** (597–632): a seller can empty the account just before the token is sold ("Fraud Prevention"), and "All assets held in a token bound account may be rendered inaccessible if an ownership cycle is created", for example when a token is sent to its own account; preventing deeper cycles is "outside the scope of this proposal".

## 4. Deployments on the wallet's networks

### 4.1 The registry

| Network | Code at `0x000000006551c19487814612e58FE06813775758` | Sourcify |
|---|---|---|
| Ethereum mainnet (1) | 571 bytes, hash `0xda1d5b06e579f9e42e59b00fbc22939896ecb38dc8830d40de0a2508fecd6735` | exact_match (verified 2024-08-08) |
| Ethereum Sepolia (11155111) | identical | exact_match (2024-09-18) |
| Base Sepolia (84532) | identical | match (2026-07-18) |
| Arbitrum Sepolia (421614) | identical | exact_match (2026-07-14) |
| OP Sepolia (11155420) | identical | no record |
| Hoodi (560048) | identical | no record |

The expected runtime was taken from the deployment data printed in the ERC (the 571 bytes after the constructor prologue) and hashed independently; it equals the code on every network. Nick's factory holds its 69-byte code on all six. Sourcify names the mainnet contract `src/ERC6551Registry.sol:ERC6551Registry`, compiler 0.8.17.

### 4.2 Tokenbound's account contracts

Tokenbound's deployments page lists the registry, an account proxy `0x55266d75D1a14E4572138116aF39863Ed6596E7F` ("Use this address as the `implementation` parameter when calling `createAccount` on the registry") and an account implementation `0x41C8f39463A868d3A88af00cd0fe7102F30E44eC` (to pass to `initialize` on a new account). It lists 14 networks, none of them Ethereum Sepolia, Base Sepolia, Arbitrum Sepolia, OP Sepolia or Hoodi. On chain they exist anyway:

| Contract | Code on all six networks | Sourcify |
|---|---|---|
| AccountProxy `0x55266d75…6E7F` | 902 bytes, hash `0x7f2b4bea…afdb0`, identical everywhere | exact_match on mainnet and Arbitrum Sepolia; no record elsewhere |
| AccountV3Upgradable `0x41C8f394…44eC` | 14,924 bytes, hash `0xdf5eeb80…f85b`, identical everywhere | exact_match on mainnet and Arbitrum Sepolia; no record elsewhere |

Identical bytes include the constructor's immutable values, so the same constructor arguments were used everywhere (an inference from the equal hashes). Comparing the 20 `src/` files of the mainnet verified source with the repository: all 20 equal the `v0.3.1` tag; three (`AccountV3.sol`, `abstract/ERC4337Account.sol`, `lib/LibSandbox.sol`) differ from the repository's current head. Anything below about the account is read from `v0.3.1`.

What the deployed contracts depend on, read on Ethereum Sepolia and mainnet:

- `entryPoint()` returns `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789`, EntryPoint v0.6 (the address in `script/DeployAccountV3.s.sol` 19). The wallet's bundler path is EntryPoint v0.7 only (`ENTRYPOINT_V07`, `packages/chains-evm/src/userop.ts`).
- The proxy's code carries two 20-byte constants: the implementation and `0x2fe5ccb0d7ea195feb87987d3573f9fcce2b5d57`, which by the constructor (`AccountProxy.sol`, `guardian` and `initialImplementation` immutables) is the guardian; that mapping is inferred from the source, not decoded. The guardian's `owner()` is `0x781b6A527482828bB04F33563797d4b696ddF328` (the `tokenboundSafe` of the deploy script, line 18), which holds 171 bytes of code; that it is a Safe is not verified.
- **What the guardian controls:** which implementations a new account may be initialised with besides the initial one (`AccountProxy.initialize`), which implementations an existing account may upgrade to (the owner must also approve: `AccountV3Upgradable._authorizeUpgrade` 15–18), and which executors may act for an account whose token lives on *another* chain (`AccountV3._isValidExecutor` 231–240). It cannot by itself move assets out of an account whose token is on the same chain, by the code read.

## 5. What owns an account, and the wallet's name tokens

### 5.1 Tokenbound's ownership rule

`AccountV3._tokenOwner` (`v0.3.1`, 343–357) returns the zero address if the token's chain id is not the current chain or the token contract has no code, and otherwise `try IERC721(tokenContract).ownerOf(tokenId)`, returning the zero address if that call fails. `_isValidSigner` (159–178) accepts the token's owner, the *root* owner (it walks up while the owner is itself a token-bound account, 323–336), or an address the root owner granted permission. `_isValidExecutor` (225–254) additionally accepts EntryPoint v0.6.

So a token contract without an ERC-721-style `ownerOf(uint256)` leaves the account with no valid signer: assets sent to it are stuck. A standard ERC-1155 contract (balances per holder, no single owner) is in that position, which is why the ERC treats fungible and semi-fungible tokens as out of scope.

### 5.2 The ENSv2 registry has `ownerOf`

The wallet's names live in ENSv2's `.eth` registry on Ethereum Sepolia, `0xD4eBcbBdF463C9c45784603Db0dDD499BC44A8B4` (`ens-register.ts` 76). Read on 2026-11-09:

- `supportsInterface(0x80ac58cd)` (ERC-721) is false; `supportsInterface(0xd9b67a26)` (ERC-1155) is true.
- It nevertheless has `ownerOf(uint256)`: `ERC1155Singleton.ownerOf` (`ERC1155Singleton.sol` 120) keeps one owner per id, and `PermissionedRegistry.ownerOf` (`PermissionedRegistry.sol` 379–389) returns that owner "unless `tokenId != _constructTokenId(tokenId, entry) || _isExpired(entry.expiry)`", in which case it returns the zero address.
- `getTokenId(labelhash)` gives each name's current token id (the labelhash with version bits; for both names the id differs from the bare labelhash, and `ownerOf(labelhash)` is the zero address). `ownerOf(tokenId)` returns `0x772eAA1d…F44F` (Account 1) for `qzv7hk2wmt` and `0xD31c2C54…D8FA` (Account 1's Kernel smart account) for `xk9fdq4rvz`, matching `AGENTS.md` pass p23-handle. `getState` gives status REGISTERED with expiries 1795492140 (2026-11-24 03:49:00 UTC) and 1795493244 (2026-11-24 04:07:24 UTC).

**Simulated, not deployed:** with `eth_call` and a code override, an ERC-1167 proxy to Tokenbound's implementation `0x41C8f394…44eC` with the footer (salt 0, chain 11155111, the ENS registry, each name's token id) was placed at an unused address. For both names, on both Sepolia RPCs: `owner()` returned the name's holder; `isValidSigner(holder, 0x)` returned `0x523e3260`; `isValidSigner(0x…dEaD, 0x)` returned `0x00000000`; `supportsInterface(0x6faff5f1)` was true. With a block-time override equal to each name's expiry, `owner()` returned the zero address. A real Tokenbound account delegates to the same implementation through `AccountProxy` after `initialize`; that the proxy path behaves the same for these view functions is an inference.

The counterfactual addresses the registry computes for implementation = the Tokenbound proxy and salt 0 are `0x8A31585712B27AAe4FF0e12382e18D8B7952d0B2` (`qzv7hk2wmt.eth`) and `0x9b1Ef5B8770aCF62BfEC8Af472E4fC9bD241144E` (`xk9fdq4rvz.eth`); neither holds code.

### 5.3 Why the wallet should not bind anything of value to a name token

- **Expiry.** On 2026-11-24 both names expire and the account loses its owner. After a renewal the same token id returns an owner again only if the version is unchanged (by the `ownerOf` rule above); after the name is released and registered again the version changes (`PermissionedRegistry.sol` 488–493).
- **Regeneration.** Every role grant or revocation on a name burns its token and mints a new one with a new id (`_onRolesGranted`/`_onRolesRevoked` → `_regenerate`, 549–590: "Bump `tokenVersionId` via burn+mint"). The version counter only increases, so an account bound to the old id has the zero address as owner permanently, and whatever it holds is stuck. Who can grant roles on the wallet's names, and when the wallet's own flows would trigger it, was not traced.
- **Ownership cycle.** Tokenbound `v0.3.1` refuses an ERC-721 token arriving at its own account (`onERC721Received` 109–118, `OwnershipCycle`) but its `onERC1155Received` (129–137) has no such check, so sending a name token to its own account would be accepted and lock both.
- **Transfers.** Moving a name token is governed by ENSv2's own rules (a holder needs a transfer-admin role; "safe" transfers are refused until the registry is emancipated, 528–545; `isEmancipated()` read true on the `.eth` registry). Moving the token moves control of any account bound to it. That is phase 25 item 1's subject and is not analysed here.

## 6. How a token-bound account relates to the wallet's Kernel accounts

- **A Kernel v3.3 cannot be the implementation.** An ERC-6551 account must be the registry's ERC-1167 proxy and its implementation must provide `token()`, `state()`, `isValidSigner` and ERC-165. The verified sources Sourcify holds for the Kernel implementation the wallet pins on Sepolia (`0xd6CEDDe84be40893d153Be9d467CD6aD37875b28`, `src/Kernel.sol:Kernel`) contain none of `function token(`, `function state(`, `function isValidSigner(` or `function supportsInterface(` (a text search of all its source files). A Kernel is created by its own factory and initialised with a root validator, which is a different construction.
- **A Kernel can be the holder that controls one.** The wallet's Kernel holds `xk9fdq4rvz.eth`, and the simulation accepted it as a valid signer of that name's account. Driving the account would mean the Kernel calling the account's `execute(to, value, data, 0)` inside an ordinary v0.7 UserOperation; `execute` checks `msg.sender` (`ERC6551Executor.sol` 31–42 at `v0.3.1`), and the Kernel would be the sender. The account's own ERC-4337 entry (EntryPoint v0.6) would not be used. This is reasoned from the code; nothing was simulated beyond the view calls.
- **Signatures.** The account's ERC-1271 check asks its owner; for a Kernel owner that means Kernel's own `isValidSignature`, which expects the wallet's Kernel signature wrapper (`packages/chains-evm/src/kernel-account.ts` 205–232). Whether a signature the wallet produces today would pass through a Tokenbound account to the Kernel was not tested.
- **What the wallet would show as owner.** Never a stored owner: "Controlled by whoever holds <name/token> — currently Account 1 (0x772e…F44F)", read from the token contract each time, with the expiry stated for a name token, the zero-address case said plainly ("No one can use this account: its token has expired or changed"), and the implementation named (Tokenbound `v0.3.1`, its guardian's powers in section 4.2).

## 7. What a demonstration would need

The wallet holds no ERC-721 token that the record names (`AGENTS.md`; this was not re-checked against an indexer). Options:

1. **A test ERC-721 the wallet mints.** It needs a contract: either one the project writes and deploys (the repository has no Solidity toolchain, as recorded for phase 21) or an existing public mint contract on Sepolia, whose verified source would have to be read and pinned first. No such contract was read for this document, so none is recommended. Minting would cost Sepolia test ETH; creating the account through the registry and initialising it through the Tokenbound proxy are two more calls (or one batched smart-account operation).
2. **A test name token, deliberately.** Bind an account to `qzv7hk2wmt.eth` with nothing of value in it, to show `owner()` changing at expiry. This would demonstrate the fragility in section 5.3 rather than a use case, and it expires on 2026-11-24.

Either way the honest scope is a read-only display first (the counterfactual address and its current owner), then at most a single `execute` from the holder, on Ethereum Sepolia only, behind a test-networks-only readiness row.

## 8. Go / no-go

**NO-GO for building a token-bound account feature now.** The standard is still in Review; the only implementation read has an upgrade and cross-chain trust point (its guardian) and an ERC-4337 path the wallet does not use; the wallet holds no ERC-721; and its ERC-1155 name tokens, though they work as owners, would strand anything bound to them at expiry or on a role change.

**Possible later, small and read-only:** on an NFT's detail screen, show "This NFT's token-bound account (ERC-6551, Tokenbound implementation)" with the counterfactual address and its balance, computed with the registry's `account(…)` view, plus the owner sentence of section 6 and, for an ENSv2 name, the expiry warning. Sending from such an account would be a separate decision.

## 9. Questions for the Chairperson

1. Whether to mint a test ERC-721 for a demonstration, and from which contract (it would need to be read and pinned first).
2. Whether Tokenbound's guardian (an upgrade and cross-chain trust point held by an address the wallet does not control) is acceptable for any account the wallet would create, or whether only accounts with a non-upgradable implementation should be offered.
3. Whether ENSv2 name tokens should ever be offered as token-bound account owners, given section 5.3.

## 10. Could not verify

- The `erc-6551.md` file's last-change commit (the clone was shallow; the repository head is pinned instead).
- That the guardian address read from the proxy's code is the guardian (inferred from the constructor), and what the guardian's owner contract is (171 bytes of code; a Safe is assumed by its name in the deploy script, not checked).
- That a real `AccountProxy`-based account answers exactly as the direct-implementation simulation did.
- Any state-changing behaviour: account creation, `initialize`, `execute` from an EOA or from the Kernel, ERC-1271 through the account to a Kernel; none was simulated.
- Who can grant or revoke roles on the wallet's ENSv2 names, and whether any wallet flow (for example adding a sub-name) regenerates a name token.
- Audits of Tokenbound `v0.3.1`: the repository's `audits` folder holds one file, "Tokenbound - Zellic Audit Report.pdf"; it was not read, so which commit it covers and what it found are unknown.
- Whether any account already exists for the wallet's names under another implementation or salt (only the Tokenbound proxy with salt 0 was computed).
- Whether the wallet holds any ERC-721 on any network (taken from the record, not an indexer).
