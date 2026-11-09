import { keccak_256 } from '@noble/hashes/sha3.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { toChecksumAddress } from '@shiba-wallet/core';
import { encodeFunctionCall, selector } from './abi.js';
import { toBytes, toHex } from './encoding.js';
import type { JsonRpcTransport } from './rpc.js';
import type { Call } from './smart-account.js';

/**
 * Lending on a test network (feature 61, phase 26 item 2; research in
 * docs/LENDING_VAULTS.md): supplying Circle's USDC to Aave v3's Arbitrum
 * Sepolia market and withdrawing it again. SUPPLY AND WITHDRAW ONLY — no
 * borrowing, repaying or collateral switches are built here, and none may
 * be added without a design of their own. Every amount is an exact bigint in
 * the token's base units; nothing here signs or sends: the app reshapes the
 * calls built here through its existing send paths, as it does for staking
 * (staking.ts).
 *
 * SOURCES (all read 2026-11-09 UTC):
 *  - [B] bgd-labs/aave-address-book commit
 *    d4c2848eeffed475372b81f1a4d510ad1710e253, src/AaveV3ArbitrumSepolia.sol
 *    (sha256 d2354e7f…7ce7): POOL_ADDRESSES_PROVIDER line 9, POOL line 12,
 *    ORACLE line 19, ACL_ADMIN line 22, AAVE_PROTOCOL_DATA_PROVIDER line 30,
 *    POOL_IMPL line 33, DEFAULT_A_TOKEN_IMPL line 49, USDC_UNDERLYING line
 *    79, USDC_DECIMALS line 81, USDC_A_TOKEN line 84.
 *  - [P] the DEPLOYED Arbitrum Sepolia L2Pool implementation
 *    0x82405D1a189bd6cE4667809C35B37fBE136A4c5B, Sourcify "match" (solc
 *    0.8.19), POOL_REVISION 3 (Pool.sol line 42). The verified sources:
 *    interfaces/IPool.sol — event Supply line 46, event Withdraw line 61,
 *    ReserveUsedAsCollateralEnabled line 131 and Disabled line 138,
 *    supply() line 248, the "type(uint256).max … withdraw the whole aToken
 *    balance" rule line 281, withdraw() line 287,
 *    getReserveNormalizedIncome line 561, ADDRESSES_PROVIDER line 628;
 *    protocol/libraries/logic/ValidationLogic.sol — validateSupply line 66
 *    (amount ≠ 0, active, not paused, not frozen, and the supply cap:
 *    (aToken.scaledTotalSupply() + accruedToTreasury).rayMul(next liquidity
 *    index) + amount ≤ supplyCap × 10^decimals) and validateWithdraw line 96
 *    (amount ≠ 0, amount ≤ the user's balance, active, not paused — a FROZEN
 *    reserve still allows withdrawals); logic/SupplyLogic.sol executeWithdraw
 *    line 106, lines 124–126 (max uint means "the whole balance") and line
 *    139 (the aToken burn pays the underlying out of the aToken contract, so
 *    what can be withdrawn at once is USDC.balanceOf(aToken));
 *    helpers/Errors.sol — numeric error strings, '26' line 35, '27' 36, '28'
 *    37, '29' 38, '32' 41, '51' 59; math/WadRayMath.sol rayMul lines 65–74
 *    (half-up, RAY = 1e27 line 17).
 *  - [D] the deployed AaveProtocolDataProvider
 *    0x12373B5085e3b42D42C1D4ABF3B3Cf4Df0E0Fa01, Sourcify "match":
 *    misc/AaveProtocolDataProvider.sol getReserveConfigurationData line 77,
 *    getReserveCaps line 115 (whole tokens), getPaused line 122,
 *    getReserveData line 152, getReserveTokensAddresses line 252.
 *  - [A] the deployed AToken implementation
 *    0xc0Bac16A64FbAa7EE6483bD12a759e28cD13dcBe, Sourcify "match":
 *    AToken.sol balanceOf line 128, UNDERLYING_ASSET_ADDRESS line 151;
 *    IncentivizedERC20.sol decimals line 91.
 *  - [O] aave-dao/aave-v3-origin commit
 *    8305565ae342f1773c42cd2e4593f175fe5968a0 (the commit
 *    docs/LENDING_VAULTS.md pins): src/contracts/interfaces/IPool.sol
 *    supply line 204, withdraw line 243 (max uint comment line 237), events
 *    lines 21 and 36 — the same signatures and event shapes as [P]. Its
 *    Errors.sol uses CUSTOM ERRORS instead of numeric strings
 *    (InvalidAmount() line 31, ReserveInactive() 32, ReserveFrozen() 33,
 *    ReservePaused() 34, NotEnoughAvailableUserBalance() 36,
 *    SupplyCapExceeded() 48); the deployed revision 3 reverts with the
 *    numeric strings, and describeAaveError maps both forms.
 *
 * ON-CHAIN CHECKS (2026-11-09; sepolia-rollup.arbitrum.io block 327,687,885
 * and arbitrum-sepolia-rpc.publicnode.com block 327,687,895, the same on
 * both): code at every pinned address; the Pool proxy's ERC-1967
 * implementation = [B] POOL_IMPL and the aToken proxy's = [B]
 * DEFAULT_A_TOKEN_IMPL; provider.getPool() = the Pool, provider
 * .getPoolDataProvider() = the data provider, Pool.ADDRESSES_PROVIDER() =
 * the provider; the USDC reserve's aToken = [B] USDC_A_TOKEN ("aArbSepUSDC",
 * 6 decimals, UNDERLYING_ASSET_ADDRESS = Circle's USDC); active, not frozen,
 * not paused; supply cap 10,500,000 USDC. The test fixture
 * test/fixtures/lending-arbitrum-sepolia-2026-11-09.json holds the reads.
 *
 * THE SUPPLY-CAP FIGURE is an estimate as of the block read: the Pool counts
 * the aToken supply plus the treasury's accrued share at the liquidity index
 * of the block that includes the transaction, after accruing interest, so
 * the real figure can be slightly higher than the one read here. The
 * eth_call pre-flight of the send path stays the final check.
 */

/** Whole-balance withdrawal marker: withdraw(asset, type(uint256).max, to) [P IPool.sol line 281, SupplyLogic.sol lines 124–126]. */
export const AAVE_WITHDRAW_ALL = (1n << 256n) - 1n;
/** Aave's ray (1e27) [P WadRayMath.sol line 17]. */
export const AAVE_RAY = 10n ** 27n;
const UINT256_MAX = AAVE_WITHDRAW_ALL;

/** One lending reserve the wallet offers, pinned per CAIP-2 chain id. */
export interface LendingDeployment {
  /** CAIP-2 id of the chain. */
  chain: string;
  /** The network's display name, for sentences. */
  networkName: string;
  protocol: 'aave-v3';
  /** The market id the provider reports (getMarketId). */
  marketId: string;
  addressesProvider: string;
  /** The Pool (an upgradeable proxy). */
  pool: string;
  /** The implementation the wallet's checks were made against; a different one is refused. */
  poolImplementation: string;
  /** Pool.POOL_REVISION() of that implementation. */
  poolRevision: bigint;
  dataProvider: string;
  oracle: string;
  /** The underlying asset: Circle's USDC. */
  asset: { address: string; symbol: string; decimals: number };
  /** The reserve's aToken (the position token). */
  aToken: { address: string; symbol: string; decimals: number };
  /** Where the addresses come from. */
  source: string;
}

/**
 * The lending reserves the wallet knows, keyed by CAIP-2 id. One today; OP
 * Sepolia uses the same market software (docs/LENDING_VAULTS.md section 3.1)
 * and can follow once tested. Mainnet is deliberately absent: lending is a
 * test-network feature in this build.
 */
export const LENDING_DEPLOYMENTS: Readonly<Record<string, LendingDeployment>> = {
  'eip155:421614': {
    chain: 'eip155:421614',
    networkName: 'Arbitrum Sepolia',
    protocol: 'aave-v3',
    marketId: 'Aave V3 Arbitrum Sepolia Testnet Market',
    addressesProvider: '0xB25a5D144626a0D488e52AE717A051a2E9997076',
    pool: '0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff',
    poolImplementation: '0x82405D1a189bd6cE4667809C35B37fBE136A4c5B',
    poolRevision: 3n,
    dataProvider: '0x12373B5085e3b42D42C1D4ABF3B3Cf4Df0E0Fa01',
    oracle: '0xEf95A6B9e88Bd509Fd67BA741cf2b263DaC65c00',
    asset: { address: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', symbol: 'USDC', decimals: 6 },
    aToken: { address: '0x460b97BD498E1157530AEb3086301d5225b91216', symbol: 'aArbSepUSDC', decimals: 6 },
    source: 'bgd-labs/aave-address-book d4c2848e src/AaveV3ArbitrumSepolia.sol lines 9, 12, 19, 30, 33, 79, 81, 84',
  },
};

export function lendingDeploymentFor(caip2: string): LendingDeployment | null {
  return LENDING_DEPLOYMENTS[caip2] ?? null;
}

// ---------------------------------------------------------------------------
// Signatures, selectors and event topics
// ---------------------------------------------------------------------------

/** Canonical signatures of every call the wallet builds or reads. */
export const LENDING_SIGNATURES = {
  /** [P IPool.sol line 248; O line 204]. */
  supply: 'supply(address,uint256,address,uint16)',
  /** [P IPool.sol line 287; O line 243]. */
  withdraw: 'withdraw(address,uint256,address)',
  /** The ERC-20 approve before a supply. */
  approve: 'approve(address,uint256)',
} as const;

/** 4-byte selectors of LENDING_SIGNATURES (pinned against ethers in the tests). */
export const LENDING_SELECTORS: Readonly<Record<keyof typeof LENDING_SIGNATURES, string>> = Object.fromEntries(
  Object.entries(LENDING_SIGNATURES).map(([k, sig]) => [k, toHex(selector(sig))]),
) as Record<keyof typeof LENDING_SIGNATURES, string>;

const topic = (signature: string) => toHex(keccak_256(utf8ToBytes(signature)));

/** Event topics the receipt decoder recognises [P IPool.sol lines 46, 61, 131, 138]. */
export const LENDING_EVENT_TOPICS = {
  supply: topic('Supply(address,address,address,uint256,uint16)'),
  withdraw: topic('Withdraw(address,address,address,uint256)'),
  collateralEnabled: topic('ReserveUsedAsCollateralEnabled(address,address)'),
  collateralDisabled: topic('ReserveUsedAsCollateralDisabled(address,address)'),
} as const;

// ---------------------------------------------------------------------------
// Encoders and call builders
// ---------------------------------------------------------------------------

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function requireAddress(value: string, what: string): void {
  if (typeof value !== 'string' || !ADDRESS_RE.test(value)) throw new Error(`${what} is not an Ethereum address.`);
}

/** supply(asset, amount, onBehalfOf, referralCode); the referral code is a uint16 (encoded in one word). */
export function encodeAaveSupply(asset: string, amount: bigint, onBehalfOf: string, referralCode = 0n): Uint8Array {
  if (referralCode < 0n || referralCode > 0xffffn) throw new Error('The referral code must fit 16 bits.');
  return encodeFunctionCall(LENDING_SIGNATURES.supply, [
    { kind: 'address', value: asset },
    { kind: 'uint256', value: amount },
    { kind: 'address', value: onBehalfOf },
    { kind: 'uint256', value: referralCode },
  ]);
}

/** withdraw(asset, amount, to); AAVE_WITHDRAW_ALL withdraws the whole aToken balance. */
export function encodeAaveWithdraw(asset: string, amount: bigint, to: string): Uint8Array {
  return encodeFunctionCall(LENDING_SIGNATURES.withdraw, [
    { kind: 'address', value: asset },
    { kind: 'uint256', value: amount },
    { kind: 'address', value: to },
  ]);
}

function encodeApprove(spender: string, amount: bigint): Uint8Array {
  return encodeFunctionCall(LENDING_SIGNATURES.approve, [
    { kind: 'address', value: spender },
    { kind: 'uint256', value: amount },
  ]);
}

/** approve(Pool, exactly amount) on the reserve's asset; refuses 0 and an unlimited approval. */
export function lendingApproveCall(deployment: LendingDeployment, amount: bigint): Call {
  if (amount <= 0n) throw new Error('An approval for a supply must be greater than zero.');
  if (amount === UINT256_MAX) throw new Error('This wallet never approves an unlimited amount.');
  return { to: deployment.asset.address, value: 0n, data: encodeApprove(deployment.pool, amount) };
}

/** supply(asset, amount, account, 0): the supply is always credited to the sending account itself. */
export function lendingSupplyCall(deployment: LendingDeployment, amount: bigint, account: string): Call {
  requireAddress(account, 'The account');
  if (amount <= 0n || amount === UINT256_MAX) throw new Error('A supply amount must be greater than zero and not the maximum.');
  return { to: deployment.pool, value: 0n, data: encodeAaveSupply(deployment.asset.address, amount, account, 0n) };
}

/** withdraw(asset, amount or everything, account): always paid to the sending account itself. */
export function lendingWithdrawCall(deployment: LendingDeployment, amount: bigint | 'all', account: string): Call {
  requireAddress(account, 'The account');
  const value = amount === 'all' ? AAVE_WITHDRAW_ALL : amount;
  if (value <= 0n) throw new Error('A withdrawal amount must be greater than zero.');
  return { to: deployment.pool, value: 0n, data: encodeAaveWithdraw(deployment.asset.address, value, account) };
}

// ---------------------------------------------------------------------------
// Decoders (strict)
// ---------------------------------------------------------------------------

function hexBody(result: unknown): string {
  if (typeof result !== 'string' || !/^0x[0-9a-fA-F]*$/.test(result) || result.length % 2 !== 0) {
    throw new Error('The node returned a malformed eth_call result.');
  }
  return result.slice(2).toLowerCase();
}

function words(result: unknown, count: number): bigint[] {
  const body = hexBody(result);
  if (body.length !== count * 64) throw new Error(`Expected ${count} 32-byte words in an eth_call result, got ${body.length / 64}.`);
  const out: bigint[] = [];
  for (let i = 0; i < count; i++) out.push(BigInt('0x' + body.slice(i * 64, i * 64 + 64)));
  return out;
}

function asAddress(word: bigint): string {
  if (word >> 160n !== 0n) throw new Error('Expected an address word.');
  return toChecksumAddress(toBytes('0x' + word.toString(16).padStart(40, '0')));
}

function asBool(word: bigint): boolean {
  if (word > 1n) throw new Error('Expected a boolean word.');
  return word === 1n;
}

function decodeString(result: unknown): string {
  const body = hexBody(result);
  if (body.length < 128) throw new Error('Short string in an eth_call result.');
  const offset = Number(BigInt('0x' + body.slice(0, 64)));
  if (offset !== 32) throw new Error('Unexpected string offset in an eth_call result.');
  const length = Number(BigInt('0x' + body.slice(64, 128)));
  if (length > 256 || body.length < 128 + length * 2) throw new Error('Malformed string in an eth_call result.');
  return new TextDecoder().decode(toBytes('0x' + body.slice(128, 128 + length * 2)));
}

/** Half-up ray multiplication, exactly as WadRayMath.rayMul [P lines 65–74]. */
export function aaveRayMul(a: bigint, b: bigint): bigint {
  return (a * b + AAVE_RAY / 2n) / AAVE_RAY;
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

/** Thrown when what the chain reports does not match what the wallet pinned. */
export class LendingStateError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(problems.join(' '));
    this.name = 'LendingStateError';
    this.problems = problems;
  }
}

const ERC1967_IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

/** Everything the wallet reads about the reserve before a confirm, at one block. */
export interface ReserveState {
  chain: string;
  /** The block every read was made at. */
  block: bigint;
  active: boolean;
  frozen: boolean;
  paused: boolean;
  decimals: number;
  /** Supply cap in whole tokens as configured; 0 means no cap. */
  supplyCap: bigint;
  /** The cap in base units (supplyCap × 10^decimals), or null when there is no cap. */
  supplyCapBaseUnits: bigint | null;
  /** aToken totalSupply at the block [D getReserveData]. */
  totalAToken: bigint;
  /** The treasury's accrued share, scaled [D getReserveData]. */
  accruedToTreasuryScaled: bigint;
  /** Pool.getReserveNormalizedIncome(asset) at the block, in ray. */
  normalizedIncome: bigint;
  /** What the Pool counts against the cap at this block: totalAToken + accruedToTreasury × index. */
  suppliedForCap: bigint;
  /** USDC.balanceOf(aToken): what can be withdrawn at once [P SupplyLogic.sol line 139]. */
  availableLiquidity: bigint;
  aToken: string;
  aTokenDecimals: number;
  usageAsCollateralEnabled: boolean;
  borrowingEnabled: boolean;
  /** The supply rate, in ray per year [D getReserveData liquidityRate]. */
  liquidityRateRay: bigint;
}

type Tag = string;

async function ethCall(node: JsonRpcTransport, to: string, data: Uint8Array, tag: Tag): Promise<string> {
  const result = await node('eth_call', [{ to, data: toHex(data) }, tag]);
  if (typeof result !== 'string') throw new Error('The node returned no eth_call result.');
  return result;
}

const view = (node: JsonRpcTransport, to: string, signature: string, tag: Tag) =>
  ethCall(node, to, encodeFunctionCall(signature, []), tag);
const viewAddressArg = (node: JsonRpcTransport, to: string, signature: string, arg: string, tag: Tag) =>
  ethCall(node, to, encodeFunctionCall(signature, [{ kind: 'address', value: arg }]), tag);

async function hasCode(node: JsonRpcTransport, address: string, tag: Tag): Promise<boolean> {
  const code = await node('eth_getCode', [address, tag]);
  return typeof code === 'string' && !/^0x0*$/i.test(code);
}

async function resolveTag(node: JsonRpcTransport, blockTag?: bigint): Promise<{ tag: Tag; block: bigint }> {
  if (blockTag !== undefined) return { tag: '0x' + blockTag.toString(16), block: blockTag };
  const head = await node('eth_blockNumber', []);
  if (typeof head !== 'string' || !/^0x[0-9a-fA-F]+$/.test(head)) throw new Error('The node returned a malformed block number.');
  return { tag: head.toLowerCase(), block: BigInt(head) };
}

/**
 * Reads the reserve's state at one block (the latest unless a block is
 * given) and checks every pinned fact first: code at the provider, the Pool,
 * the data provider, the asset and the aToken; the Pool proxy's
 * implementation is the one the wallet was checked against; the provider
 * names the pinned Pool and data provider and the Pool names the provider;
 * the data provider names the pinned aToken, whose underlying is the asset;
 * the configured decimals, the asset's and the aToken's agree. Any mismatch
 * throws LendingStateError with plain sentences; nothing is quoted then.
 */
export async function readReserveState(
  node: JsonRpcTransport,
  deployment: LendingDeployment,
  options: { blockTag?: bigint } = {},
): Promise<ReserveState> {
  const { tag, block } = await resolveTag(node, options.blockTag);
  const d = deployment;
  const where = d.networkName;
  const codes = await Promise.all([
    hasCode(node, d.addressesProvider, tag),
    hasCode(node, d.pool, tag),
    hasCode(node, d.dataProvider, tag),
    hasCode(node, d.asset.address, tag),
    hasCode(node, d.aToken.address, tag),
  ]);
  const names = ["Aave's PoolAddressesProvider", "Aave's Pool", "Aave's data provider", `the ${d.asset.symbol} token`, `Aave's ${d.aToken.symbol} token`];
  const addrs = [d.addressesProvider, d.pool, d.dataProvider, d.asset.address, d.aToken.address];
  const missing = codes.flatMap((ok, i) => (ok ? [] : [`No contract code at ${names[i]} (${addrs[i]}) on ${where}.`]));
  if (missing.length > 0) throw new LendingStateError(missing);

  const slot = await node('eth_getStorageAt', [d.pool, ERC1967_IMPLEMENTATION_SLOT, tag]);
  const [providerPool, providerData, poolProvider, poolRevision, tokens, config, caps, paused, data, income, underlying, aDecimals, assetDecimals, liquidity] =
    await Promise.all([
      view(node, d.addressesProvider, 'getPool()', tag),
      view(node, d.addressesProvider, 'getPoolDataProvider()', tag),
      view(node, d.pool, 'ADDRESSES_PROVIDER()', tag),
      view(node, d.pool, 'POOL_REVISION()', tag),
      viewAddressArg(node, d.dataProvider, 'getReserveTokensAddresses(address)', d.asset.address, tag),
      viewAddressArg(node, d.dataProvider, 'getReserveConfigurationData(address)', d.asset.address, tag),
      viewAddressArg(node, d.dataProvider, 'getReserveCaps(address)', d.asset.address, tag),
      viewAddressArg(node, d.dataProvider, 'getPaused(address)', d.asset.address, tag),
      viewAddressArg(node, d.dataProvider, 'getReserveData(address)', d.asset.address, tag),
      viewAddressArg(node, d.pool, 'getReserveNormalizedIncome(address)', d.asset.address, tag),
      view(node, d.aToken.address, 'UNDERLYING_ASSET_ADDRESS()', tag),
      view(node, d.aToken.address, 'decimals()', tag),
      view(node, d.asset.address, 'decimals()', tag),
      viewAddressArg(node, d.asset.address, 'balanceOf(address)', d.aToken.address, tag),
    ]);

  const problems: string[] = [];
  const implementation = asAddress(words(slot, 1)[0]!);
  if (!same(implementation, d.poolImplementation)) {
    problems.push(`Aave's Pool on ${where} now runs the implementation ${implementation}, not the ${d.poolImplementation} this wallet was checked against.`);
  }
  const revision = words(poolRevision, 1)[0]!;
  if (revision !== d.poolRevision) problems.push(`Aave's Pool on ${where} reports revision ${revision}, not ${d.poolRevision}.`);
  const pPool = asAddress(words(providerPool, 1)[0]!);
  if (!same(pPool, d.pool)) problems.push(`Aave's PoolAddressesProvider on ${where} names the Pool ${pPool}, not the pinned ${d.pool}.`);
  const pData = asAddress(words(providerData, 1)[0]!);
  if (!same(pData, d.dataProvider)) problems.push(`Aave's PoolAddressesProvider on ${where} names the data provider ${pData}, not the pinned ${d.dataProvider}.`);
  const back = asAddress(words(poolProvider, 1)[0]!);
  if (!same(back, d.addressesProvider)) problems.push(`Aave's Pool on ${where} names the provider ${back}, not the pinned ${d.addressesProvider}.`);
  const [aTokenWord] = words(tokens, 3);
  const aToken = asAddress(aTokenWord!);
  if (!same(aToken, d.aToken.address)) problems.push(`Aave's ${d.asset.symbol} reserve on ${where} uses the aToken ${aToken}, not the pinned ${d.aToken.address}.`);
  const under = asAddress(words(underlying, 1)[0]!);
  if (!same(under, d.asset.address)) problems.push(`The aToken ${d.aToken.address} holds ${under}, not ${d.asset.symbol} ${d.asset.address}.`);
  const cfg = words(config, 10);
  const decimals = cfg[0]!;
  const aDec = words(aDecimals, 1)[0]!;
  const assetDec = words(assetDecimals, 1)[0]!;
  if (decimals !== BigInt(d.asset.decimals) || assetDec !== BigInt(d.asset.decimals) || aDec !== BigInt(d.aToken.decimals)) {
    problems.push(`The decimals disagree: the reserve is configured with ${decimals}, ${d.asset.symbol} reports ${assetDec} and the aToken ${aDec}; this wallet expects ${d.asset.decimals}.`);
  }
  if (problems.length > 0) throw new LendingStateError(problems);

  const [, supplyCap] = words(caps, 2);
  const reserve = words(data, 12);
  const normalizedIncome = words(income, 1)[0]!;
  if (normalizedIncome < AAVE_RAY) throw new LendingStateError([`Aave's Pool on ${where} reports an income index below one, which cannot be.`]);
  const totalAToken = reserve[2]!;
  const accruedToTreasuryScaled = reserve[1]!;
  const cap = supplyCap!;
  return {
    chain: d.chain,
    block,
    usageAsCollateralEnabled: asBool(cfg[5]!),
    borrowingEnabled: asBool(cfg[6]!),
    active: asBool(cfg[8]!),
    frozen: asBool(cfg[9]!),
    paused: asBool(words(paused, 1)[0]!),
    decimals: Number(decimals),
    supplyCap: cap,
    supplyCapBaseUnits: cap === 0n ? null : cap * 10n ** decimals,
    totalAToken,
    accruedToTreasuryScaled,
    normalizedIncome,
    suppliedForCap: totalAToken + aaveRayMul(accruedToTreasuryScaled, normalizedIncome),
    availableLiquidity: words(liquidity, 1)[0]!,
    aToken,
    aTokenDecimals: Number(aDec),
    liquidityRateRay: reserve[5]!,
  };
}

/** The account's position and wallet balance of the asset, at one block. */
export interface LendingPosition {
  account: string;
  block: bigint;
  /** aToken balance: the supplied amount plus the interest earned so far [A balanceOf]. */
  supplied: bigint;
  /** The asset (USDC) in the account itself. */
  walletBalance: bigint;
}

export async function readLendingPosition(
  node: JsonRpcTransport,
  deployment: LendingDeployment,
  account: string,
  options: { blockTag?: bigint } = {},
): Promise<LendingPosition> {
  requireAddress(account, 'The account');
  const { tag, block } = await resolveTag(node, options.blockTag);
  const [a, w] = await Promise.all([
    viewAddressArg(node, deployment.aToken.address, 'balanceOf(address)', account, tag),
    viewAddressArg(node, deployment.asset.address, 'balanceOf(address)', account, tag),
  ]);
  return { account, block, supplied: words(a, 1)[0]!, walletBalance: words(w, 1)[0]! };
}

// ---------------------------------------------------------------------------
// Quotes and their refusals
// ---------------------------------------------------------------------------

/** Exact base units as a decimal string ("0.1", "855827.583202"). */
export function formatLendingUnits(units: bigint, decimals: number): string {
  const neg = units < 0n;
  const s = (neg ? -units : units).toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

/** The sentences the quotes refuse with; each is shown as it is. */
export const LENDING_REFUSALS = {
  notOffered: (network: string) => `Lending is offered only on Arbitrum Sepolia in this version: no Aave market is pinned for ${network}.`,
  wrongState: 'The reserve state was read for another network than the one quoted. Read it again before quoting.',
  inactive: (symbol: string, network: string) =>
    `Aave's ${symbol} reserve on ${network} is not active, so it accepts no supply or withdrawal right now. Nothing was signed.`,
  frozen: (symbol: string, network: string) =>
    `Aave's ${symbol} reserve on ${network} is frozen: it accepts no new supply, although supplied ${symbol} can still be withdrawn. Nothing was signed.`,
  paused: (symbol: string, network: string) =>
    `Aave's ${symbol} reserve on ${network} is paused, so it accepts no supply or withdrawal until it is unpaused. Nothing was signed.`,
  zero: 'Enter an amount greater than zero.',
  aboveBalance: (balance: string, amount: string, symbol: string) =>
    `This account holds ${balance} ${symbol}, less than the ${amount} ${symbol} to supply. Nothing was signed.`,
  cap: (symbol: string, network: string, cap: string, supplied: string, room: string) =>
    `Aave's ${symbol} reserve on ${network} would go over its supply cap of ${cap} ${symbol}: about ${supplied} ${symbol} is supplied already, so at most ${room} ${symbol} more can be supplied now. Nothing was signed.`,
  supplyRecipient: (recipient: string) =>
    `This wallet supplies only on behalf of the sending account itself; a supply credited to another address (${recipient}) is refused. Nothing was signed.`,
  withdrawRecipient: (recipient: string) =>
    `This wallet withdraws only to the sending account itself; a withdrawal paid to another address (${recipient}) is refused. Nothing was signed.`,
  noPosition: (symbol: string, network: string) => `This account has no ${symbol} supplied to Aave on ${network}, so there is nothing to withdraw.`,
  abovePosition: (position: string, amount: string, symbol: string, aSymbol: string) =>
    `This account has ${position} ${symbol} supplied to Aave (its ${aSymbol} balance), less than the ${amount} ${symbol} to withdraw. Nothing was signed.`,
  aboveLiquidity: (symbol: string, network: string, liquidity: string, amount: string) =>
    `Aave's ${symbol} pool on ${network} holds only ${liquidity} ${symbol} that can be withdrawn right now (the rest is lent out), less than the ${amount} ${symbol} asked. Withdraw less, or try again later. Nothing was signed.`,
} as const;

/** A quote: calls to send in order, or the reasons nothing can be sent. */
export interface LendingQuote {
  action: 'supply' | 'withdraw';
  chain: string;
  account: string;
  /** The amount in base units; for "withdraw everything" the position read now (interest may add a little by inclusion). */
  amount: bigint;
  /** True when the withdrawal uses type(uint256).max ("everything"). */
  all: boolean;
  /** Supply: [exact approve, supply]; withdraw: [withdraw]. Empty when refused. */
  calls: Call[];
  refusals: string[];
  /** The block the state was read at. */
  block: bigint;
}

function sharedRefusals(d: LendingDeployment, state: ReserveState): string[] {
  const out: string[] = [];
  if (state.chain !== d.chain) out.push(LENDING_REFUSALS.wrongState);
  if (!state.active) out.push(LENDING_REFUSALS.inactive(d.asset.symbol, d.networkName));
  if (state.paused) out.push(LENDING_REFUSALS.paused(d.asset.symbol, d.networkName));
  return out;
}

/**
 * Quotes a supply of `amount` from `account`: an exact approve of the Pool
 * then supply(asset, amount, account, 0). Refuses an inactive, frozen or
 * paused reserve, 0, more than the account holds, an amount that would take
 * the reserve over its cap, and any recipient other than the account itself.
 */
export function quoteLendingSupply(args: {
  deployment: LendingDeployment;
  state: ReserveState;
  account: string;
  amount: bigint;
  /** The account's asset balance (readLendingPosition's walletBalance). */
  walletBalance: bigint;
  /** Who the supply would be credited to; only the account itself is accepted. */
  onBehalfOf?: string;
}): LendingQuote {
  const { deployment: d, state, account, amount } = args;
  requireAddress(account, 'The account');
  const fmt = (u: bigint) => formatLendingUnits(u, d.asset.decimals);
  const refusals = sharedRefusals(d, state);
  if (args.onBehalfOf !== undefined && !same(args.onBehalfOf, account)) refusals.push(LENDING_REFUSALS.supplyRecipient(args.onBehalfOf));
  if (state.frozen) refusals.push(LENDING_REFUSALS.frozen(d.asset.symbol, d.networkName));
  if (amount <= 0n) refusals.push(LENDING_REFUSALS.zero);
  else {
    if (amount > args.walletBalance) refusals.push(LENDING_REFUSALS.aboveBalance(fmt(args.walletBalance), fmt(amount), d.asset.symbol));
    if (state.supplyCapBaseUnits !== null && state.suppliedForCap + amount > state.supplyCapBaseUnits) {
      const room = state.supplyCapBaseUnits > state.suppliedForCap ? state.supplyCapBaseUnits - state.suppliedForCap : 0n;
      refusals.push(LENDING_REFUSALS.cap(d.asset.symbol, d.networkName, state.supplyCap.toString(), fmt(state.suppliedForCap), fmt(room)));
    }
  }
  const calls = refusals.length > 0 ? [] : [lendingApproveCall(d, amount), lendingSupplyCall(d, amount, account)];
  return { action: 'supply', chain: d.chain, account, amount, all: false, calls, refusals, block: state.block };
}

/**
 * Quotes a withdrawal to `account`: withdraw(asset, amount, account), or
 * withdraw(asset, max, account) for "everything". Refuses an inactive or
 * paused reserve (a frozen one still allows withdrawals), 0, more than the
 * position, more than the pool's liquidity, and any recipient other than the
 * account itself.
 */
export function quoteLendingWithdraw(args: {
  deployment: LendingDeployment;
  state: ReserveState;
  account: string;
  amount: bigint | 'all';
  /** The account's aToken balance (readLendingPosition's supplied). */
  supplied: bigint;
  /** Who would be paid; only the account itself is accepted. */
  to?: string;
}): LendingQuote {
  const { deployment: d, state, account } = args;
  requireAddress(account, 'The account');
  const fmt = (u: bigint) => formatLendingUnits(u, d.asset.decimals);
  const refusals = sharedRefusals(d, state);
  if (args.to !== undefined && !same(args.to, account)) refusals.push(LENDING_REFUSALS.withdrawRecipient(args.to));
  const all = args.amount === 'all';
  const amount = all ? args.supplied : (args.amount as bigint);
  if (all && args.supplied === 0n) refusals.push(LENDING_REFUSALS.noPosition(d.asset.symbol, d.networkName));
  else if (amount <= 0n) refusals.push(LENDING_REFUSALS.zero);
  else {
    if (amount > args.supplied) {
      refusals.push(
        args.supplied === 0n
          ? LENDING_REFUSALS.noPosition(d.asset.symbol, d.networkName)
          : LENDING_REFUSALS.abovePosition(fmt(args.supplied), fmt(amount), d.asset.symbol, d.aToken.symbol),
      );
    }
    if (amount > state.availableLiquidity) refusals.push(LENDING_REFUSALS.aboveLiquidity(d.asset.symbol, d.networkName, fmt(state.availableLiquidity), fmt(amount)));
  }
  const calls = refusals.length > 0 ? [] : [lendingWithdrawCall(d, all ? 'all' : amount, account)];
  return { action: 'withdraw', chain: d.chain, account, amount, all, calls, refusals, block: state.block };
}

// ---------------------------------------------------------------------------
// The check before signing
// ---------------------------------------------------------------------------

function wordsOf(data: Uint8Array, count: number): bigint[] | null {
  if (data.length !== 4 + count * 32) return null;
  const out: bigint[] = [];
  for (let i = 0; i < count; i++) out.push(BigInt(toHex(data.slice(4 + i * 32, 36 + i * 32))));
  return out;
}

const selectorOf = (data: Uint8Array) => toHex(data.slice(0, 4));
const addrWord = (w: bigint, address: string) => w === BigInt(address);

/**
 * Re-reads calls before they are signed and returns plain problems (empty =
 * acceptable). Accepted shapes, and only these: [approve], [supply],
 * [approve, supply] with the same amount (a smart-account batch), or
 * [withdraw]. Every word is compared: the approve goes to the asset, names
 * the Pool and a non-zero, non-maximum amount; the supply goes to the Pool
 * for the asset, credited to `account`, referral 0; the withdrawal goes to
 * the Pool for the asset and pays `account`; no call carries value.
 */
export function checkLendingCalls(calls: readonly Call[], deployment: LendingDeployment, account: string): string[] {
  const d = deployment;
  requireAddress(account, 'The account');
  const problems: string[] = [];
  if (calls.length < 1 || calls.length > 2) return ['A lending operation carries one call, or an approval and a supply.'];
  const kinds: string[] = [];
  const amounts: bigint[] = [];
  calls.forEach((c, i) => {
    const n = i + 1;
    if (c.value !== 0n) problems.push(`Call ${n} carries a value; lending calls never do.`);
    const sel = c.data.length >= 4 ? selectorOf(c.data) : '';
    if (sel === LENDING_SELECTORS.approve) {
      const w = wordsOf(c.data, 2);
      kinds.push('approve');
      if (!same(c.to, d.asset.address)) problems.push(`Call ${n} approves on ${c.to}, not on ${d.asset.symbol} ${d.asset.address}.`);
      if (!w) problems.push(`Call ${n} is not a well-formed approve.`);
      else {
        if (!addrWord(w[0]!, d.pool)) problems.push(`Call ${n} approves a spender other than Aave's Pool.`);
        if (w[1]! === 0n || w[1]! === UINT256_MAX) problems.push(`Call ${n} approves 0 or an unlimited amount.`);
        amounts.push(w[1]!);
      }
    } else if (sel === LENDING_SELECTORS.supply) {
      const w = wordsOf(c.data, 4);
      kinds.push('supply');
      if (!same(c.to, d.pool)) problems.push(`Call ${n} supplies to ${c.to}, not to Aave's Pool.`);
      if (!w) problems.push(`Call ${n} is not a well-formed supply.`);
      else {
        if (!addrWord(w[0]!, d.asset.address)) problems.push(`Call ${n} supplies another asset than ${d.asset.symbol}.`);
        if (w[1]! === 0n || w[1]! === UINT256_MAX) problems.push(`Call ${n} supplies 0 or the maximum amount.`);
        if (!addrWord(w[2]!, account)) problems.push(LENDING_REFUSALS.supplyRecipient('0x' + w[2]!.toString(16).padStart(40, '0')));
        if (w[3]! !== 0n) problems.push(`Call ${n} carries a referral code; this wallet sends 0.`);
        amounts.push(w[1]!);
      }
    } else if (sel === LENDING_SELECTORS.withdraw) {
      const w = wordsOf(c.data, 3);
      kinds.push('withdraw');
      if (!same(c.to, d.pool)) problems.push(`Call ${n} withdraws from ${c.to}, not from Aave's Pool.`);
      if (!w) problems.push(`Call ${n} is not a well-formed withdraw.`);
      else {
        if (!addrWord(w[0]!, d.asset.address)) problems.push(`Call ${n} withdraws another asset than ${d.asset.symbol}.`);
        if (w[1]! === 0n) problems.push(`Call ${n} withdraws 0.`);
        if (!addrWord(w[2]!, account)) problems.push(LENDING_REFUSALS.withdrawRecipient('0x' + w[2]!.toString(16).padStart(40, '0')));
      }
    } else {
      kinds.push('other');
      problems.push(`Call ${n} is not an approve, a supply or a withdrawal.`);
    }
  });
  const shape = kinds.join(',');
  if (!['approve', 'supply', 'approve,supply', 'withdraw'].includes(shape)) problems.push(`The calls (${shape}) are not a shape this wallet builds.`);
  if (shape === 'approve,supply' && amounts.length === 2 && amounts[0] !== amounts[1]) problems.push('The approval and the supply are for different amounts.');
  return problems;
}

// ---------------------------------------------------------------------------
// Aave's errors
// ---------------------------------------------------------------------------

/** The Aave errors a supply or withdrawal can meet, keyed by the deployed numeric code [P Errors.sol]. */
export const AAVE_ERROR_SENTENCES: Readonly<Record<string, string>> = {
  '26': "Aave refused the amount: it must be greater than zero (Aave's error 26).",
  '27': "Aave refused: the reserve is not active (Aave's error 27).",
  '28': "Aave refused: the reserve is frozen and accepts no new supply (Aave's error 28).",
  '29': "Aave refused: the reserve is paused (Aave's error 29).",
  '32': "Aave refused: the withdrawal is larger than this account's supplied balance (Aave's error 32).",
  '51': "Aave refused: the supply would take the reserve over its supply cap (Aave's error 51).",
};

/** The same refusals as custom errors in aave-v3-origin [O Errors.sol], mapped to the numeric codes. */
export const AAVE_CUSTOM_ERRORS: Readonly<Record<string, string>> = Object.fromEntries(
  (
    [
      ['InvalidAmount()', '26'],
      ['ReserveInactive()', '27'],
      ['ReserveFrozen()', '28'],
      ['ReservePaused()', '29'],
      ['NotEnoughAvailableUserBalance()', '32'],
      ['SupplyCapExceeded()', '51'],
    ] as const
  ).map(([sig, code]) => [toHex(selector(sig)), code]),
);

const ERROR_STRING_SELECTOR = '0x08c379a0';

/**
 * Turns an Aave revert into a plain sentence, or null when it is not one of
 * the errors above. Accepts revert data (Error(string) carrying the numeric
 * code, or an aave-v3-origin custom-error selector) or a node's message text
 * such as "execution reverted: 51".
 */
export function describeAaveError(input: string): string | null {
  if (typeof input !== 'string') return null;
  let code: string | null = null;
  const text = input.trim();
  if (/^0x[0-9a-fA-F]*$/.test(text)) {
    const lower = text.toLowerCase();
    if (lower.startsWith(ERROR_STRING_SELECTOR) && lower.length >= 10 + 128) {
      try {
        const body = lower.slice(10);
        const length = Number(BigInt('0x' + body.slice(64, 128)));
        if (length <= 4) code = new TextDecoder().decode(toBytes('0x' + body.slice(128, 128 + length * 2)));
      } catch {
        code = null;
      }
    } else if (lower.length === 10) {
      code = AAVE_CUSTOM_ERRORS[lower] ?? null;
    }
  } else {
    // A node's text, e.g. "RPC error 3: execution reverted: 51 (eth_call)".
    const m = /reverted:?\s*'?(\d{1,2})'?(?![0-9A-Za-z])/.exec(text);
    if (m) code = m[1]!;
  }
  if (code === null || !/^\d{1,2}$/.test(code)) return null;
  return AAVE_ERROR_SENTENCES[code] ?? `Aave refused the call with its error ${code}.`;
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

export interface ReceiptLog {
  address: string;
  topics: readonly string[];
  data: string;
}

export interface LendingSupplyEvent {
  reserve: string;
  user: string;
  onBehalfOf: string;
  amount: bigint;
  referralCode: bigint;
}

export interface LendingWithdrawEvent {
  reserve: string;
  user: string;
  to: string;
  amount: bigint;
}

export interface LendingReceipt {
  supplies: LendingSupplyEvent[];
  withdrawals: LendingWithdrawEvent[];
  collateralEnabled: { reserve: string; user: string }[];
  collateralDisabled: { reserve: string; user: string }[];
}

function topicAddress(t: string): string {
  if (!/^0x0{24}[0-9a-fA-F]{40}$/.test(t)) throw new Error('A lending event carries a malformed address topic.');
  return toChecksumAddress(toBytes('0x' + t.slice(26)));
}

/**
 * Decodes the Pool's Supply, Withdraw and collateral events from a receipt's
 * logs [P IPool.sol lines 46, 61, 131, 138]. Only logs emitted by the pinned
 * Pool are read; a recognised event with the wrong shape throws.
 */
export function decodeLendingReceipt(logs: readonly ReceiptLog[], deployment: LendingDeployment): LendingReceipt {
  const out: LendingReceipt = { supplies: [], withdrawals: [], collateralEnabled: [], collateralDisabled: [] };
  for (const log of logs) {
    if (!same(log.address, deployment.pool)) continue;
    const t0 = (log.topics[0] ?? '').toLowerCase();
    if (t0 === LENDING_EVENT_TOPICS.supply) {
      if (log.topics.length !== 4) throw new Error('A Supply event has the wrong number of topics.');
      const [user, amount] = words(log.data, 2);
      const referral = BigInt(log.topics[3]!);
      if (referral > 0xffffn) throw new Error('A Supply event carries a malformed referral code.');
      out.supplies.push({ reserve: topicAddress(log.topics[1]!), user: asAddress(user!), onBehalfOf: topicAddress(log.topics[2]!), amount: amount!, referralCode: referral });
    } else if (t0 === LENDING_EVENT_TOPICS.withdraw) {
      if (log.topics.length !== 4) throw new Error('A Withdraw event has the wrong number of topics.');
      const [amount] = words(log.data, 1);
      out.withdrawals.push({ reserve: topicAddress(log.topics[1]!), user: topicAddress(log.topics[2]!), to: topicAddress(log.topics[3]!), amount: amount! });
    } else if (t0 === LENDING_EVENT_TOPICS.collateralEnabled || t0 === LENDING_EVENT_TOPICS.collateralDisabled) {
      if (log.topics.length !== 3 || hexBody(log.data).length !== 0) throw new Error('A collateral event has the wrong shape.');
      const entry = { reserve: topicAddress(log.topics[1]!), user: topicAddress(log.topics[2]!) };
      (t0 === LENDING_EVENT_TOPICS.collateralEnabled ? out.collateralEnabled : out.collateralDisabled).push(entry);
    }
  }
  return out;
}
