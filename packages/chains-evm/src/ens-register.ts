import { concatBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { toChecksumAddress } from '@shiba-wallet/core';
import { encodeFunctionCall, encodeSequence, selector, type AbiValue } from './abi.js';
import { keccak, toBytes, toHex } from './encoding.js';
import { ENS_UNIVERSAL_RESOLVER, classifyEnsRevert, dnsEncodeName, namehash, normalizeEnsNameAscii, revertDataOf } from './ens.js';
import type { JsonRpcTransport } from './rpc.js';
import type { Call } from './smart-account.js';

/**
 * Registering a .eth name ("a wallet handle") on Ethereum Sepolia through
 * the ENSv2 contracts, plus the records that make the name point at the
 * wallet and the reverse record that makes the address show the name
 * (phase 23 item 6, feature 75). The research record, with every source and
 * the read-only checks behind the facts below, is docs/WALLET_HANDLES.md.
 *
 * WHICH CONTRACTS. Sepolia does NOT use the classic ENSv1
 * ETHRegistrarController for registration any more. ENS's documentation
 * (github.com/ensdomains/docs at eb408b38, src/pages/learn/deployments.mdx,
 * read 2026-10-25): "Sepolia runs the ENSv2 contracts: the Universal
 * Resolver and the ENS apps for Sepolia resolve through this deployment",
 * and of the ENSv1 contracts: "These ENSv1 contracts still exist on Sepolia
 * but are no longer in use". The ENSv2 address list the docs pin is
 * ensdomains/contracts-v2 at 07e55a05 (contracts/docs/addresses/sepolia.md,
 * "Deployed at: 2026-10-01T07:55:02.016Z"). Read on 2026-10-25 on two
 * endpoints (PublicNode and dRPC, block 11991368): the Universal Resolver
 * proxy 0xeEeE…EeEe → ManagedUniversalResolverProxy 0x6d80…e6F1 →
 * UniversalResolverV2 0x24E1…2D72 (ERC-1967 slots and implementation()),
 * whose ROOT_REGISTRY() is 0xB458…C43f, whose getSubregistry("eth") is the
 * ETHRegistry below, whose root roles REGISTRAR|RENEW are held by the
 * ETHRegistrar below; that registrar emitted NameRegistered events the
 * same day (e.g. block 11991195). Every contract below has a Sourcify
 * match or exact match EXCEPT the VerifiableFactory's proxyLogic()
 * (0xC415…6BDd), which has no Sourcify record (scripts/audit/verify-pins.mjs
 * re-reads them all, 2026-10-26); see docs/WALLET_HANDLES.md section 3.
 *
 * THE FLOW (contracts-v2 at 07e55a05, src/registrar/ETHRegistrar.sol, and
 * the docs' src/pages/ensv2/eth-registrar.mdx):
 *  1. commit(makeCommitment(label, owner, secret, subregistry, resolver,
 *     duration, referrer)) — the hash is keccak256(abi.encode(...)) of those
 *     seven values (ETHRegistrar.sol 219–220);
 *  2. wait at least MIN_COMMITMENT_AGE (60 s on Sepolia) and less than
 *     MAX_COMMITMENT_AGE (86,400 s) — register() reverts CommitmentTooNew /
 *     CommitmentTooOld outside that window (230–242);
 *  3. register(label, owner, secret, subregistry, resolver, duration,
 *     paymentToken, referrer): the registrar pulls base + premium of an
 *     ERC-20 with safeTransferFrom from msg.sender (150) — ENSv2 takes NO
 *     ETH; on Sepolia Circle's test USDC is an accepted payment token.
 * register() sets the name's resolver but writes no records. In ENSv2 the
 * standard resolver is a per-account PermissionedResolver proxy deployed
 * through the VerifiableFactory (docs src/pages/ensv2/permissioned-resolver.mdx
 * and verifiable-factory.mdx); its initialize(grants, calls) can set the
 * first address record in the same transaction. The primary name
 * (reverse record) stays on the ENSv1 infrastructure at launch (docs
 * src/pages/ensv2/reverse-resolution.mdx: "Users update their reverse
 * record via the v1 ReverseRegistrar"), so it is set with the v1
 * ReverseRegistrar's setName(string), which names msg.sender.
 *
 * Every call this module builds must be SENT BY THE OWNER ADDRESS ITSELF
 * (the regular account, or a smart account through a UserOperation): the
 * factory derives the resolver's address from msg.sender, the registrar
 * charges msg.sender, and setName names msg.sender. The calls have the
 * {to, value, data} shape that prepareEvmSend (one call per transaction)
 * and prepareAaCalls (a batch) take; nothing here signs or sends.
 */

// ---------------------------------------------------------------------------
// Pinned deployment (Ethereum Sepolia)
// ---------------------------------------------------------------------------

/** The ENSv2 Sepolia contracts this module uses, from contracts-v2 at 07e55a05 and checked on-chain on 2026-10-25. */
export const ENS_V2_SEPOLIA = {
  chainId: 11155111n,
  /** ETHRegistrar (commit-reveal, ERC-20 payment). Sourcify: match. */
  ethRegistrar: '0xf633e7FC17e2bbE0D0965D18ec1821dcB754a3d3',
  /** The .eth PermissionedRegistry (ERC-1155 names). Sourcify: exact_match. */
  ethRegistry: '0xD4eBcbBdF463C9c45784603Db0dDD499BC44A8B4',
  /** The ENSv2 root registry (UniversalResolverV2.ROOT_REGISTRY()). Sourcify: exact_match. */
  rootRegistry: '0xB458D6a3a77919449d03e7A6903C26827c1eC43f',
  /** StandardRentPriceOracle (the registrar's rentPriceOracle()). Sourcify: match. */
  rentPriceOracle: '0x8196665D4ca7488B6474a9EC8E7d2719FB42263A',
  /** VerifiableFactory (ensdomains/verifiable-factory). Sourcify: exact_match. */
  verifiableFactory: '0xDa70306C98E97eCe36F997a21368e53298572991',
  /** The factory's proxyLogic() (read on-chain); the CREATE2 init code embeds it. */
  verifiableProxyLogic: '0xC41576B4B809B99CF0fF2e5B41b4F147cd9b6BDd',
  /** PermissionedResolver implementation the per-account resolver proxies point at. Sourcify: match. */
  permissionedResolverImpl: '0x115eb53F0c60696633855F90b138178Fb40b2b2C',
  /** UserRegistry implementation (per-name subname registries). Sourcify: exact_match. */
  userRegistryImpl: '0x9BD8a88719068D09ecee662f36C0E3856708366a',
  /** ENSv1 ReverseRegistrar (owner of addr.reverse in the v1 registry). Sourcify: exact_match. */
  v1ReverseRegistrar: '0xA0a1AbcDAe1a2a4A2EF8e9113Ff0e02DD81DC0C6',
  /** ENSv1 PublicResolver: the v1 ReverseRegistrar's defaultResolver(). Sourcify: exact_match. */
  v1DefaultResolver: '0xE99638b40E4Fff0129D56f03b55b6bbC4BBE49b5',
  /** ENSV1Resolver: the v2 root's resolver for "reverse", mirroring v1 reverse records. Sourcify: match. */
  reverseMirrorResolver: '0x322B7581cA210a69c6D0e0D7c88a7688D2789Cb0',
} as const;

/** A payment token this wallet offers for a registration fee. */
export interface EnsPaymentToken {
  address: string;
  symbol: string;
  decimals: number;
}

/**
 * The only payment token this wallet offers: Circle's Sepolia USDC, which
 * the wallet already tracks. The oracle also accepts ENS's free-mint
 * MockUSDC 0x240b…14aa (the docs' suggested token, but one the wallet's
 * Tokens screen already flags as a look-alike "USDC") and MockDAI; neither
 * is offered. isPaymentToken / getPaymentTokenRatio for Circle's USDC read
 * true / (1, 1000000) on 2026-10-25 (contracts-v2 deploy/testnet/00_setup_oracle.ts
 * adds it on Sepolia).
 */
export const ENS_V2_SEPOLIA_USDC: EnsPaymentToken = {
  address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  symbol: 'USDC',
  decimals: 6,
};

/**
 * The registrar's limits as read on-chain on 2026-10-25 (the deployment
 * constants of contracts-v2 script/deploy-constants.ts: MIN_COMMITMENT_AGE
 * 60, MAX_COMMITMENT_AGE one day, MIN_REGISTER_DURATION and GRACE_PERIOD_V2
 * 28 days). readEnsRegistrarConfig re-reads them; a quote refuses when the
 * chain disagrees with these values, because the wallet's copy (the wait
 * shown to the user) would then be wrong.
 */
export const ENS_V2_SEPOLIA_REGISTRAR_LIMITS = {
  minCommitmentAge: 60n,
  maxCommitmentAge: 86_400n,
  minRegisterDuration: 2_419_200n,
  gracePeriod: 2_419_200n,
} as const;

/** One year as the deployment scripts count it (365 days). */
export const ENS_SECONDS_PER_YEAR = 31_536_000n;

/**
 * The shortest label the deployed oracle prices: getBaseRates() reads
 * [0, 0, 640/yr, 160/yr, 8/yr] in 1e-12 USD per second, and a zero rate
 * makes the oracle revert NotValid(label) (StandardRentPriceOracle.sol
 * 359–372, 398–407), so labels of one or two characters cannot be
 * registered.
 */
export const ENS_V2_MIN_LABEL_LENGTH = 3;

/**
 * Every role (and every admin role) of the Enhanced Access Control role
 * scheme — the bitmap the ENS docs' example grants the owner of a new
 * resolver or subname registry (verifiable-factory.mdx "ALL_ROLES";
 * contracts-v2 script/deploy-constants.ts FLAGS.ALL).
 */
export const ENS_EAC_ALL_ROLES = BigInt('0x' + '1'.repeat(64));

/** PermissionedResolverLib.ROLE_SET_ADDRESS (1 << 0). */
export const ENS_RESOLVER_ROLE_SET_ADDRESS = 1n;

/** The ENSIP-1 / ENSIP-9 coin type of an Ethereum address record. */
export const ENS_REGISTER_COIN_TYPE_ETH = 60n;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ZERO_32 = new Uint8Array(32);
const UINT64_MAX = (1n << 64n) - 1n;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type EnsRegisterErrorReason =
  /** The label is not a registrable second-level .eth label in the supported ASCII subset. */
  | 'invalid-label'
  /** The endpoint is not Ethereum Sepolia, or not the chain the caller expected. */
  | 'wrong-chain'
  /** The name is registered, reserved or in its grace period. */
  | 'unavailable'
  /** The name expired recently and still carries the temporary premium (not offered). */
  | 'premium'
  /** The duration is below the minimum or does not fit a uint64. */
  | 'duration'
  /** The payment token is not the one this wallet offers, or the oracle refuses it. */
  | 'payment-token'
  /** The wallet's own price calculation disagrees with the registrar's quote. */
  | 'price-mismatch'
  /** The deployed contracts do not match what this module was written against. */
  | 'deployment-mismatch'
  /** The owner or target address is malformed or zero. */
  | 'invalid-address'
  /** The commit-reveal secret is malformed or all zeros. */
  | 'invalid-secret'
  /** The owner's resolver exists but is not the expected proxy or the owner cannot set records on it. */
  | 'resolver'
  /** The commitment is unknown, too new or too old for register(). */
  | 'commitment'
  /** A node answer did not have the expected shape. */
  | 'malformed';

export class EnsRegisterError extends Error {
  readonly reason: EnsRegisterErrorReason;
  constructor(reason: EnsRegisterErrorReason, message: string) {
    super(message);
    this.name = 'EnsRegisterError';
    this.reason = reason;
  }
}

/**
 * Custom errors of the deployed contracts, by signature. The tests pin each
 * selector against ethers and against the "Error selector" comments in
 * contracts-v2 at 07e55a05 (IETHRegistrar.sol, IETHRenewer.sol,
 * IRentPriceOracle.sol, CommonErrors.sol, IStandardRegistry.sol,
 * IEnhancedAccessControl.sol).
 */
export const ENS_REGISTER_ERROR_SIGNATURES = {
  commitmentTooNew: 'CommitmentTooNew(bytes32,uint64,uint64)',
  commitmentTooOld: 'CommitmentTooOld(bytes32,uint64,uint64)',
  unexpiredCommitmentExists: 'UnexpiredCommitmentExists(bytes32)',
  nameNotAvailable: 'NameNotAvailable(string)',
  durationTooShort: 'DurationTooShort(uint64,uint64)',
  notValid: 'NotValid(string)',
  paymentTokenNotSupported: 'PaymentTokenNotSupported(address)',
  invalidOwner: 'InvalidOwner()',
  labelAlreadyRegistered: 'LabelAlreadyRegistered(string)',
  labelExpired: 'LabelExpired(uint256)',
  eacUnauthorizedAccountRoles: 'EACUnauthorizedAccountRoles(uint256,uint256,address)',
} as const;

export type EnsRegisterRevertKind = keyof typeof ENS_REGISTER_ERROR_SIGNATURES | 'unknown';

export const ENS_REGISTER_ERROR_SELECTORS: Record<keyof typeof ENS_REGISTER_ERROR_SIGNATURES, string> =
  Object.fromEntries(
    Object.entries(ENS_REGISTER_ERROR_SIGNATURES).map(([k, sig]) => [k, toHex(selector(sig))]),
  ) as Record<keyof typeof ENS_REGISTER_ERROR_SIGNATURES, string>;

/** Classifies revert data from the registrar, oracle, registries or resolver by its selector. */
export function classifyEnsRegisterRevert(revertData: string): EnsRegisterRevertKind {
  const sel = revertData.slice(0, 10).toLowerCase();
  for (const [kind, s] of Object.entries(ENS_REGISTER_ERROR_SELECTORS)) {
    if (s === sel) return kind as EnsRegisterRevertKind;
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export type EnsHandleLabelCheck =
  | { ok: true; label: string; name: string }
  | { ok: false; problem: 'not-ascii-subset' | 'empty' | 'label-extension' | 'too-long' | 'too-short' | 'not-eth' | 'not-second-level' };

/**
 * Validates a handle the user typed: "alice" or "alice.eth" (any case,
 * surrounding whitespace trimmed). The label goes through the wallet's own
 * conservative normaliser (ens.ts normalizeEnsNameAscii — ASCII a–z, 0–9 and
 * hyphen, no "--" in positions 3–4), must be a single label directly under
 * .eth, and must have at least ENS_V2_MIN_LABEL_LENGTH characters.
 *
 * Why the wallet normalises when the registrar does not: the oracle's own
 * validity check "Does not check if normalized" (StandardRentPriceOracle.sol
 * 272–277) and register() accepts any 1–255-byte label (LabelStore.setLabel →
 * NameCoder.assertLabelSize), so a label that is not normalised could be
 * paid for and then never resolve in a client that normalises its input.
 */
export function checkEnsHandleLabel(input: string): EnsHandleLabelCheck {
  const trimmed = input.trim();
  if (trimmed === '') return { ok: false, problem: 'empty' };
  const lower = trimmed.toLowerCase();
  const withTld = lower.endsWith('.eth') ? lower : `${lower}.eth`;
  if (lower.includes('.') && !lower.endsWith('.eth')) return { ok: false, problem: 'not-eth' };
  const check = normalizeEnsNameAscii(withTld);
  if (!check.ok) {
    if (check.problem === 'empty-label' || check.problem === 'single-label') return { ok: false, problem: 'not-second-level' };
    if (check.problem === 'label-extension') return { ok: false, problem: 'label-extension' };
    if (check.problem === 'too-long') return { ok: false, problem: 'too-long' };
    if (check.problem === 'empty') return { ok: false, problem: 'empty' };
    return { ok: false, problem: 'not-ascii-subset' };
  }
  const labels = check.name.split('.');
  if (labels.length !== 2 || labels[1] !== 'eth') return { ok: false, problem: 'not-second-level' };
  const label = labels[0]!;
  if (label.length < ENS_V2_MIN_LABEL_LENGTH) return { ok: false, problem: 'too-short' };
  // A label is at most 255 bytes (NameCoder.assertLabelSize); the whole name
  // is already capped at ENS_MAX_NAME_BYTES = 255 by the normaliser.
  return { ok: true, label, name: check.name };
}

function requireLabel(label: string): string {
  const check = checkEnsHandleLabel(label);
  if (!check.ok || check.label !== label) {
    throw new EnsRegisterError('invalid-label', `"${label}" is not a registrable .eth label (${check.ok ? 'not normalized' : check.problem})`);
  }
  return label;
}

/** A sub-label for a sub-name ("smart" in smart.alice.eth): the same ASCII subset, any length ≥ 1. */
export function checkEnsSubLabel(input: string): { ok: true; label: string } | { ok: false; problem: string } {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === '' || trimmed.includes('.')) return { ok: false, problem: 'not-a-single-label' };
  const check = normalizeEnsNameAscii(`${trimmed}.eth`);
  if (!check.ok) return { ok: false, problem: check.problem };
  return { ok: true, label: trimmed };
}

function requireAddress(address: string, what: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new EnsRegisterError('invalid-address', `${what} is not an address`);
  if (/^0x0{40}$/.test(address)) throw new EnsRegisterError('invalid-address', `${what} is the zero address`);
  return toChecksumAddress(toBytes(address));
}

function requireUint64(value: bigint, what: string): bigint {
  if (value < 0n || value > UINT64_MAX) throw new EnsRegisterError('duration', `${what} does not fit a uint64`);
  return value;
}

// ---------------------------------------------------------------------------
// Commitment and calldata
// ---------------------------------------------------------------------------

/** The seven values a commitment binds (IETHRegistrar.makeCommitment). */
export interface EnsCommitmentParams {
  label: string;
  owner: string;
  /** 32 random bytes; never all zeros. */
  secret: Uint8Array;
  /** Child registry for the name, or the zero address (this wallet always passes zero). */
  subregistry: string;
  resolver: string;
  /** Registration duration in seconds (uint64). */
  duration: bigint;
  /** Referrer, 32 bytes (this wallet always passes zero). */
  referrer: Uint8Array;
}

/** 32 random bytes from the platform's secure generator, for a commitment's secret. */
export function newEnsCommitSecret(random: (n: number) => Uint8Array = randomBytes): Uint8Array {
  const secret = random(32);
  checkSecret(secret);
  return secret;
}

function checkSecret(secret: Uint8Array): void {
  if (secret.length !== 32) throw new EnsRegisterError('invalid-secret', 'The commitment secret must be 32 bytes');
  if (secret.every((b) => b === 0)) throw new EnsRegisterError('invalid-secret', 'The commitment secret must not be all zeros');
}

function commitmentValues(p: EnsCommitmentParams): AbiValue[] {
  if (p.referrer.length !== 32) throw new EnsRegisterError('malformed', 'The referrer must be 32 bytes');
  return [
    { kind: 'bytes', value: utf8ToBytes(p.label) }, // a Solidity string encodes like bytes
    { kind: 'address', value: p.owner },
    { kind: 'fixedBytes', value: p.secret },
    { kind: 'address', value: p.subregistry },
    { kind: 'address', value: p.resolver },
    { kind: 'uint256', value: requireUint64(p.duration, 'The duration') }, // uint64 occupies a full word
    { kind: 'fixedBytes', value: p.referrer },
  ];
}

/**
 * keccak256(abi.encode(label, owner, secret, subregistry, resolver,
 * duration, referrer)) — ETHRegistrar.makeCommitment (pure). Equal to the
 * contract's own answer for the fixtures in the tests.
 */
export function ensRegistrationCommitment(p: EnsCommitmentParams): Uint8Array {
  requireLabel(p.label);
  requireAddress(p.owner, 'The owner');
  checkSecret(p.secret);
  return keccak(encodeSequence(commitmentValues(p)));
}

/** ETHRegistrar.commit(bytes32). */
export function encodeEnsCommit(commitment: Uint8Array): Uint8Array {
  if (commitment.length !== 32) throw new EnsRegisterError('malformed', 'A commitment is 32 bytes');
  return encodeFunctionCall('commit(bytes32)', [{ kind: 'fixedBytes', value: commitment }]);
}

/** ETHRegistrar.register(string,address,bytes32,address,address,uint64,address,bytes32). */
export function encodeEnsRegister(p: EnsCommitmentParams, paymentToken: string): Uint8Array {
  const v = commitmentValues(p);
  return encodeFunctionCall('register(string,address,bytes32,address,address,uint64,address,bytes32)', [
    v[0]!, v[1]!, v[2]!, v[3]!, v[4]!, v[5]!,
    { kind: 'address', value: paymentToken },
    v[6]!,
  ]);
}

/** ETHRegistrar.makeCommitment(…) — for checking the local hash against the contract. */
export function encodeEnsMakeCommitment(p: EnsCommitmentParams): Uint8Array {
  return encodeFunctionCall('makeCommitment(string,address,bytes32,address,address,uint64,bytes32)', commitmentValues(p));
}

export function encodeEnsIsAvailable(label: string): Uint8Array {
  return encodeFunctionCall('isAvailable(string)', [{ kind: 'bytes', value: utf8ToBytes(label) }]);
}

export function encodeEnsGetRegisterPrice(label: string, duration: bigint, paymentToken: string): Uint8Array {
  return encodeFunctionCall('getRegisterPrice(string,uint64,address)', [
    { kind: 'bytes', value: utf8ToBytes(label) },
    { kind: 'uint256', value: requireUint64(duration, 'The duration') },
    { kind: 'address', value: paymentToken },
  ]);
}

export function encodeEnsCommitmentAt(commitment: Uint8Array): Uint8Array {
  return encodeFunctionCall('commitmentAt(bytes32)', [{ kind: 'fixedBytes', value: commitment }]);
}

/** ERC-20 approve(spender, amount) for exactly the quoted fee (never unlimited). */
export function encodeEnsExactApprove(spender: string, amount: bigint): Uint8Array {
  if (amount <= 0n) throw new EnsRegisterError('malformed', 'An approval must be for a positive amount');
  if (amount >= (1n << 255n)) throw new EnsRegisterError('malformed', 'Refusing an effectively unlimited approval');
  return encodeFunctionCall('approve(address,uint256)', [
    { kind: 'address', value: spender },
    { kind: 'uint256', value: amount },
  ]);
}

/**
 * PermissionedResolver.setAddress(bytes name, uint256 coinType, bytes
 * addressBytes) — the name DNS-encoded (setters take names, not
 * namehashes: permissioned-resolver.mdx "Setters take the DNS-encoded
 * name"), coin type 60, the 20 address bytes.
 */
export function encodeEnsSetEthAddress(name: string, address: string): Uint8Array {
  requireAddress(address, 'The record address');
  return encodeFunctionCall('setAddress(bytes,uint256,bytes)', [
    { kind: 'bytes', value: dnsEncodeName(name) },
    { kind: 'uint256', value: ENS_REGISTER_COIN_TYPE_ETH },
    { kind: 'bytes', value: toBytes(address) },
  ]);
}

/** A Grant {address account; uint256 roleBitmap} (IEACGrantInitializable). */
function grant(account: string, roleBitmap: bigint): AbiValue {
  return { kind: 'tuple', items: [{ kind: 'address', value: account }, { kind: 'uint256', value: roleBitmap }] };
}

/** PermissionedResolver.initialize((address,uint256)[] grants, bytes[] calls). */
export function encodeEnsResolverInitialize(owner: string, initialCalls: Uint8Array[]): Uint8Array {
  return encodeFunctionCall('initialize((address,uint256)[],bytes[])', [
    { kind: 'array', items: [grant(owner, ENS_EAC_ALL_ROLES)] },
    { kind: 'array', items: initialCalls.map((c) => ({ kind: 'bytes', value: c }) as AbiValue) },
  ]);
}

/** UserRegistry.initialize((address,uint256)[] grants). */
export function encodeEnsUserRegistryInitialize(owner: string): Uint8Array {
  return encodeFunctionCall('initialize((address,uint256)[])', [
    { kind: 'array', items: [grant(owner, ENS_EAC_ALL_ROLES)] },
  ]);
}

/** VerifiableFactory.deployProxy(address implementation, uint256 salt, bytes data). */
export function encodeVerifiableDeployProxy(implementation: string, salt: bigint, data: Uint8Array): Uint8Array {
  return encodeFunctionCall('deployProxy(address,uint256,bytes)', [
    { kind: 'address', value: implementation },
    { kind: 'uint256', value: salt },
    { kind: 'bytes', value: data },
  ]);
}

/** PermissionedRegistry.setSubregistry(uint256 anyId, address registry); anyId may be the labelhash. */
export function encodeEnsSetSubregistry(label: string, registry: string): Uint8Array {
  return encodeFunctionCall('setSubregistry(uint256,address)', [
    { kind: 'uint256', value: BigInt(toHex(keccak(utf8ToBytes(label)))) },
    { kind: 'address', value: registry },
  ]);
}

/** PermissionedRegistry.register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry). */
export function encodeEnsRegistryRegister(label: string, owner: string, resolver: string, roleBitmap: bigint, expiry: bigint): Uint8Array {
  return encodeFunctionCall('register(string,address,address,address,uint256,uint64)', [
    { kind: 'bytes', value: utf8ToBytes(label) },
    { kind: 'address', value: owner },
    { kind: 'address', value: ZERO_ADDRESS },
    { kind: 'address', value: resolver },
    { kind: 'uint256', value: roleBitmap },
    { kind: 'uint256', value: requireUint64(expiry, 'The expiry') },
  ]);
}

/** ENSv1 ReverseRegistrar.setName(string): sets the primary name of msg.sender. */
export function encodeEnsV1ReverseSetName(name: string): Uint8Array {
  return encodeFunctionCall('setName(string)', [{ kind: 'bytes', value: utf8ToBytes(name) }]);
}

// ---------------------------------------------------------------------------
// Deterministic addresses (VerifiableFactory)
// ---------------------------------------------------------------------------

/**
 * The salt the ENS docs give for an account's own resolver:
 * keccak256(abi.encode(keccak256("OwnedResolver"), owner, version))
 * (verifiable-factory.mdx "Salt scheme: keccak256("OwnedResolver", owner,
 * version)", version 0). A convention, not a rule the contracts enforce;
 * following it lets other ENS tools find the same resolver.
 */
export function ensOwnedResolverSalt(owner: string, version = 0n): bigint {
  return BigInt(toHex(keccak(encodeSequence([
    { kind: 'fixedBytes', value: keccak(utf8ToBytes('OwnedResolver')) },
    { kind: 'address', value: requireAddress(owner, 'The owner') },
    { kind: 'uint256', value: version },
  ]))));
}

/** keccak256(abi.encode(keccak256("UserRegistry"), namehash(name), version)) (verifiable-factory.mdx). */
export function ensUserRegistrySalt(name: string, version = 0n): bigint {
  return BigInt(toHex(keccak(encodeSequence([
    { kind: 'fixedBytes', value: keccak(utf8ToBytes('UserRegistry')) },
    { kind: 'fixedBytes', value: namehash(name) },
    { kind: 'uint256', value: version },
  ]))));
}

/**
 * The address VerifiableFactory.deployProxy will use when called by
 * `deployer` with `salt`: CREATE2 from the factory with
 * outerSalt = keccak256(abi.encode(deployer, salt)) and the 0x57-byte init
 * code of CloneProxyBytecode.creationCode(proxyLogic, outerSalt)
 * (ensdomains/verifiable-factory at c1090aec, src/VerifiableFactory.sol
 * 32–46, 80–86; src/CloneProxyBytecode.sol). The tests compare it with the
 * factory's own predictProxyAddress answer.
 */
export function predictVerifiableProxyAddress(
  deployer: string,
  salt: bigint,
  factory: string = ENS_V2_SEPOLIA.verifiableFactory,
  proxyLogic: string = ENS_V2_SEPOLIA.verifiableProxyLogic,
): string {
  const outerSalt = keccak(encodeSequence([
    { kind: 'address', value: requireAddress(deployer, 'The deployer') },
    { kind: 'uint256', value: salt },
  ]));
  const initCode = concatBytes(
    toBytes('0x3d604d80600a3d3981f3363d3d373d3d3d363d73'),
    toBytes(proxyLogic),
    toBytes('0x5af43d82803e903d91602b57fd5bf3'),
    outerSalt,
  );
  if (initCode.length !== 0x57) throw new Error('unexpected proxy init code length');
  const digest = keccak(concatBytes(new Uint8Array([0xff]), toBytes(factory), outerSalt, keccak(initCode)));
  return toChecksumAddress(digest.slice(12));
}

// ---------------------------------------------------------------------------
// Prices (a mirror of StandardRentPriceOracle, exact bigint)
// ---------------------------------------------------------------------------

/** The oracle's pricing parameters, as read by readEnsPricing. */
export interface EnsRentPricing {
  /** Per-second base rates in 1e-12 USD; index i prices labels of i+1 codepoints. */
  baseRatePerCp: bigint[];
  /** Ordered discount points. */
  discountPoints: { duration: bigint; numer: bigint }[];
  discountDenominator: bigint;
  premiumPriceInitial: bigint;
  premiumHalvingPeriod: bigint;
  premiumPeriod: bigint;
}

/** A payment token's exchange ratio (getPaymentTokenRatio); denom 0 means not accepted. */
export interface EnsPaymentRatio {
  numer: bigint;
  denom: bigint;
}

// LibHalving constants: 0.5^(2^k / 65536) * 1e18 (contracts-v2 at 07e55a05,
// src/registrar/libraries/LibHalving.sol 20–35).
const HALVING_BITS = [
  999989423469314432n, 999978847050491904n, 999957694548431104n, 999915390886613504n,
  999830788931929088n, 999661606496243712n, 999323327502650752n, 998647112890970240n,
  997296056085470080n, 994599423483633152n, 989228013193975424n, 978572062087700096n,
  957603280698573696n, 917004043204671232n, 840896415253714560n, 707106781186547584n,
] as const;
const E18 = 10n ** 18n;

/** LibHalving.halving: initial / 2^(elapsed / half), in the contract's fixed point. */
export function ensLibHalving(initial: bigint, half: bigint, elapsed: bigint): bigint {
  if (initial === 0n || half === 0n) return 0n;
  if (elapsed === 0n) return initial;
  const x = (elapsed * E18) / half;
  const i = x / E18;
  const f = x - i * E18;
  let value = initial >> i;
  const fraction = (f << 16n) / E18;
  for (let bit = 0; bit < 16; bit++) {
    if ((fraction & (1n << BigInt(bit))) !== 0n) value = (value * HALVING_BITS[bit]!) / E18;
  }
  return value;
}

/** Unicode codepoints of an ASCII label (StringUtils.strlen equals the byte length for ASCII). */
function codepoints(label: string): number {
  for (let i = 0; i < label.length; i++) {
    if (label.charCodeAt(i) > 0x7f) throw new EnsRegisterError('invalid-label', 'Only ASCII labels are priced by this mirror');
  }
  return label.length;
}

/** StandardRentPriceOracle.applyDiscount. */
export function ensApplyDiscount(pricing: EnsRentPricing, value: bigint, duration: bigint): bigint {
  let numer = 0n;
  for (const p of pricing.discountPoints) {
    if (duration < p.duration) break;
    numer = p.numer;
  }
  return numer === 0n ? value : (value * numer) / pricing.discountDenominator;
}

/** StandardRentPriceOracle.getBasePrice: standard units, or 0 when the label is not valid. */
export function ensBasePrice(pricing: EnsRentPricing, label: string, duration: bigint): bigint {
  const n = utf8ToBytes(label).length;
  if (n === 0 || n > 255) return 0n;
  let i = codepoints(label);
  if (i > pricing.baseRatePerCp.length) i = pricing.baseRatePerCp.length;
  return ensApplyDiscount(pricing, pricing.baseRatePerCp[i - 1]! * duration, duration);
}

/** StandardRentPriceOracle.getPremiumPriceAfter: the decaying premium `available` seconds after the grace period. */
export function ensPremiumAfter(pricing: EnsRentPricing, available: bigint): bigint {
  if (available >= pricing.premiumPeriod) return 0n;
  const offset = ensLibHalving(pricing.premiumPriceInitial, pricing.premiumHalvingPeriod, pricing.premiumPeriod);
  return ensLibHalving(pricing.premiumPriceInitial, pricing.premiumHalvingPeriod, available) - offset;
}

/** StandardRentPriceOracle._toAmount: Math.mulDiv(value, numer, denom, Ceil), or value when numer == denom. */
export function ensToTokenAmount(value: bigint, ratio: EnsPaymentRatio): bigint {
  if (ratio.denom === 0n) throw new EnsRegisterError('payment-token', 'The payment token is not accepted');
  if (ratio.numer === ratio.denom) return value;
  const product = value * ratio.numer;
  return (product + ratio.denom - 1n) / ratio.denom;
}

/**
 * StandardRentPriceOracle.getRegisterPrice(label, available, duration,
 * token), step for step (StandardRentPriceOracle.sol 297–316): the premium
 * is converted on its own and the base is the converted total minus it, so
 * the two parts always add up to the converted total.
 */
export function ensRegisterPrice(
  pricing: EnsRentPricing,
  label: string,
  available: bigint,
  duration: bigint,
  ratio: EnsPaymentRatio,
): { base: bigint; premium: bigint } {
  let base = ensBasePrice(pricing, label, duration);
  if (base === 0n) throw new EnsRegisterError('invalid-label', `The oracle does not price "${label}"`);
  if (ratio.denom === 0n) throw new EnsRegisterError('payment-token', 'The payment token is not accepted');
  let premium = ensPremiumAfter(pricing, available);
  if (premium > 0n) {
    base += premium;
    premium = ensToTokenAmount(premium, ratio);
  }
  base = ensToTokenAmount(base, ratio) - premium;
  return { base, premium };
}

/**
 * ETHRegistrar._availablePeriod: how long a name has been available, which
 * the oracle turns into the premium (0 while in the grace period; the
 * current time for a name never registered, i.e. expiry 0).
 */
export function ensAvailablePeriod(expiry: bigint, now: bigint, gracePeriod: bigint): bigint {
  if (expiry === 0n) return now;
  const end = expiry + gracePeriod;
  return now > end ? now - end : 0n;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function word(bytes: Uint8Array, index: number): bigint {
  const start = index * 32;
  if (start + 32 > bytes.length) throw new EnsRegisterError('malformed', 'Truncated ABI answer');
  return BigInt(toHex(bytes.slice(start, start + 32)));
}

function hexResult(raw: unknown): Uint8Array {
  if (typeof raw !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(raw)) throw new EnsRegisterError('malformed', 'eth_call returned a non-hex result');
  if (raw === '0x') throw new EnsRegisterError('deployment-mismatch', 'eth_call returned nothing (no contract at the pinned address?)');
  return toBytes(raw);
}

function asAddress(value: bigint): string {
  if (value >> 160n !== 0n) throw new EnsRegisterError('malformed', 'Malformed address word');
  return toChecksumAddress(toBytes('0x' + value.toString(16).padStart(40, '0')));
}

function asBool(value: bigint): boolean {
  if (value > 1n) throw new EnsRegisterError('malformed', 'Malformed bool word');
  return value === 1n;
}

/** Reads a dynamic uint256[] / (uint64,uint128)[] answer: offset 0x20, length, then fixed-size items. */
function readArray(bytes: Uint8Array, itemWords: number): bigint[][] {
  if (word(bytes, 0) !== 32n) throw new EnsRegisterError('malformed', 'Unexpected array offset');
  const length = Number(word(bytes, 1));
  if (bytes.length !== 64 + length * itemWords * 32) throw new EnsRegisterError('malformed', 'Unexpected array length');
  const out: bigint[][] = [];
  for (let i = 0; i < length; i++) {
    const item: bigint[] = [];
    for (let w = 0; w < itemWords; w++) item.push(word(bytes, 2 + i * itemWords + w));
    out.push(item);
  }
  return out;
}

/** An eth_call that classifies contract reverts (revert data present) and rethrows transport failures. */
async function ensCall(
  transport: JsonRpcTransport,
  to: string,
  data: Uint8Array,
  block: string,
): Promise<{ ok: true; result: Uint8Array } | { ok: false; kind: EnsRegisterRevertKind; revert: string }> {
  try {
    return { ok: true, result: hexResult(await transport('eth_call', [{ to, data: toHex(data) }, block])) };
  } catch (error) {
    const revert = revertDataOf(error);
    if (revert === undefined) throw error;
    return { ok: false, kind: classifyEnsRegisterRevert(revert), revert };
  }
}

async function ensView(transport: JsonRpcTransport, to: string, signature: string, args: AbiValue[], block: string): Promise<Uint8Array> {
  const r = await ensCall(transport, to, encodeFunctionCall(signature, args), block);
  if (!r.ok) throw new EnsRegisterError('deployment-mismatch', `${signature} reverted (${r.kind})`);
  return r.result;
}

/** Checks the endpoint serves Ethereum Sepolia; returns the block it pinned all later reads to. */
async function sepoliaBlock(transport: JsonRpcTransport): Promise<{ blockTag: string; blockNumber: bigint; timestamp: bigint }> {
  const chainId = BigInt((await transport('eth_chainId', [])) as string);
  if (chainId !== ENS_V2_SEPOLIA.chainId) {
    throw new EnsRegisterError('wrong-chain', `ENS handles are registered only on Ethereum Sepolia (chain 11155111); the endpoint serves chain ${chainId.toString()}`);
  }
  const block = (await transport('eth_getBlockByNumber', ['latest', false])) as { number?: unknown; timestamp?: unknown } | null;
  if (!block || typeof block.number !== 'string' || typeof block.timestamp !== 'string') {
    throw new EnsRegisterError('malformed', 'The endpoint returned no latest block');
  }
  return { blockTag: block.number, blockNumber: BigInt(block.number), timestamp: BigInt(block.timestamp) };
}

/** The registrar's configuration as read on-chain. */
export interface EnsRegistrarConfig {
  rentPriceOracle: string;
  ethRegistry: string;
  minCommitmentAge: bigint;
  maxCommitmentAge: bigint;
  minRegisterDuration: bigint;
  gracePeriod: bigint;
}

async function readRegistrarConfigAt(transport: JsonRpcTransport, block: string): Promise<EnsRegistrarConfig> {
  const r = ENS_V2_SEPOLIA.ethRegistrar;
  const one = async (sig: string) => word(await ensView(transport, r, sig, [], block), 0);
  const config: EnsRegistrarConfig = {
    rentPriceOracle: asAddress(await one('rentPriceOracle()')),
    ethRegistry: asAddress(await one('ETH_REGISTRY()')),
    minCommitmentAge: await one('MIN_COMMITMENT_AGE()'),
    maxCommitmentAge: await one('MAX_COMMITMENT_AGE()'),
    minRegisterDuration: await one('MIN_REGISTER_DURATION()'),
    gracePeriod: await one('GRACE_PERIOD()'),
  };
  const L = ENS_V2_SEPOLIA_REGISTRAR_LIMITS;
  const problems: string[] = [];
  if (config.rentPriceOracle !== ENS_V2_SEPOLIA.rentPriceOracle) problems.push(`rentPriceOracle() is ${config.rentPriceOracle}`);
  if (config.ethRegistry !== ENS_V2_SEPOLIA.ethRegistry) problems.push(`ETH_REGISTRY() is ${config.ethRegistry}`);
  if (config.minCommitmentAge !== L.minCommitmentAge) problems.push(`MIN_COMMITMENT_AGE() is ${config.minCommitmentAge}`);
  if (config.maxCommitmentAge !== L.maxCommitmentAge) problems.push(`MAX_COMMITMENT_AGE() is ${config.maxCommitmentAge}`);
  if (config.minRegisterDuration !== L.minRegisterDuration) problems.push(`MIN_REGISTER_DURATION() is ${config.minRegisterDuration}`);
  if (config.gracePeriod !== L.gracePeriod) problems.push(`GRACE_PERIOD() is ${config.gracePeriod}`);
  if (problems.length > 0) {
    throw new EnsRegisterError('deployment-mismatch', `The Sepolia ETHRegistrar no longer matches what this wallet was written against: ${problems.join('; ')}`);
  }
  return config;
}

/** Reads and checks the registrar's configuration (oracle, registry, commitment ages, minimum duration, grace period). */
export async function readEnsRegistrarConfig(transport: JsonRpcTransport): Promise<EnsRegistrarConfig> {
  const { blockTag } = await sepoliaBlock(transport);
  return readRegistrarConfigAt(transport, blockTag);
}

async function readPricingAt(transport: JsonRpcTransport, block: string): Promise<EnsRentPricing> {
  const o = ENS_V2_SEPOLIA.rentPriceOracle;
  const rates = readArray(await ensView(transport, o, 'getBaseRates()', [], block), 1).map((x) => x[0]!);
  const points = readArray(await ensView(transport, o, 'getDiscountPoints()', [], block), 2).map((x) => ({ duration: x[0]!, numer: x[1]! }));
  const one = async (sig: string) => word(await ensView(transport, o, sig, [], block), 0);
  const pricing: EnsRentPricing = {
    baseRatePerCp: rates,
    discountPoints: points,
    discountDenominator: await one('DISCOUNT_DENOMINATOR()'),
    premiumPriceInitial: await one('PREMIUM_PRICE_INITIAL()'),
    premiumHalvingPeriod: await one('PREMIUM_HALVING_PERIOD()'),
    premiumPeriod: await one('PREMIUM_PERIOD()'),
  };
  if (pricing.baseRatePerCp.length === 0) throw new EnsRegisterError('deployment-mismatch', 'The oracle has no base rates');
  const firstPriced = pricing.baseRatePerCp.findIndex((r) => r > 0n) + 1;
  if (firstPriced !== ENS_V2_MIN_LABEL_LENGTH) {
    throw new EnsRegisterError('deployment-mismatch', `The oracle now prices labels from ${firstPriced} characters, not ${ENS_V2_MIN_LABEL_LENGTH}`);
  }
  return pricing;
}

/** Reads the oracle's pricing parameters. */
export async function readEnsPricing(transport: JsonRpcTransport): Promise<EnsRentPricing> {
  const { blockTag } = await sepoliaBlock(transport);
  return readPricingAt(transport, blockTag);
}

/** IPermissionedRegistry.State (getState): status 0 AVAILABLE, 1 RESERVED, 2 REGISTERED. */
export interface EnsNameState {
  status: 0 | 1 | 2;
  expiry: bigint;
  latestOwner: string;
  tokenId: bigint;
  resource: bigint;
}

async function readStateAt(transport: JsonRpcTransport, registry: string, label: string, block: string): Promise<EnsNameState> {
  const id = BigInt(toHex(keccak(utf8ToBytes(label)))); // LibLabel.id
  const r = await ensView(transport, registry, 'getState(uint256)', [{ kind: 'uint256', value: id }], block);
  if (r.length !== 160) throw new EnsRegisterError('malformed', 'getState returned an unexpected size');
  const status = word(r, 0);
  if (status > 2n) throw new EnsRegisterError('malformed', 'getState returned an unknown status');
  return {
    status: Number(status) as 0 | 1 | 2,
    expiry: word(r, 1),
    latestOwner: asAddress(word(r, 2)),
    tokenId: word(r, 3),
    resource: word(r, 4),
  };
}

/** The .eth registry's state for a label (ETHRegistry.getState(labelId)). */
export async function readEnsNameState(transport: JsonRpcTransport, label: string): Promise<EnsNameState & { blockTimestamp: bigint }> {
  requireLabel(label);
  const { blockTag, timestamp } = await sepoliaBlock(transport);
  return { ...(await readStateAt(transport, ENS_V2_SEPOLIA.ethRegistry, label, blockTag)), blockTimestamp: timestamp };
}

/** A registration quote, every figure read at one block. */
export interface EnsRegistrationQuote {
  label: string;
  name: string;
  node: string;
  owner: string;
  duration: bigint;
  paymentToken: EnsPaymentToken;
  /** Base fee in the payment token's base units (the registrar's own figure, equal to the wallet's mirror). */
  base: bigint;
  /** Always 0: names in the premium window are refused. */
  premium: bigint;
  /** base + premium: the exact amount the approval allows and register() pulls. */
  total: bigint;
  /** The new expiry if registered at quoteTimestamp (block.timestamp + duration). */
  expiryIfRegisteredNow: bigint;
  blockNumber: bigint;
  quoteTimestamp: bigint;
  config: EnsRegistrarConfig;
}

/**
 * Quotes a registration: checks the chain and the deployment, the label,
 * the duration, availability (isAvailable), reads the registrar's price
 * (getRegisterPrice) and recomputes it with the oracle's own parameters and
 * the name's registry state; any disagreement refuses. A name still in its
 * premium window is refused (its price falls by the minute and starts near
 * 100 million US dollars — eth-registrar.mdx "Expiry Premium").
 */
export async function quoteEnsRegistration(
  transport: JsonRpcTransport,
  input: { label: string; owner: string; duration: bigint; paymentToken?: EnsPaymentToken },
): Promise<EnsRegistrationQuote> {
  const label = requireLabel(input.label);
  const owner = requireAddress(input.owner, 'The owner');
  const token = input.paymentToken ?? ENS_V2_SEPOLIA_USDC;
  if (token.address.toLowerCase() !== ENS_V2_SEPOLIA_USDC.address.toLowerCase()) {
    throw new EnsRegisterError('payment-token', `This wallet pays ENS registrations only in Circle's Sepolia USDC (${ENS_V2_SEPOLIA_USDC.address})`);
  }
  const duration = requireUint64(input.duration, 'The duration');
  const { blockTag, blockNumber, timestamp } = await sepoliaBlock(transport);
  const config = await readRegistrarConfigAt(transport, blockTag);
  if (duration < config.minRegisterDuration) {
    throw new EnsRegisterError('duration', `The shortest registration is ${config.minRegisterDuration.toString()} seconds (28 days)`);
  }
  const reg = ENS_V2_SEPOLIA.ethRegistrar;
  const avail = await ensCall(transport, reg, encodeEnsIsAvailable(label), blockTag);
  if (!avail.ok) throw new EnsRegisterError('deployment-mismatch', `isAvailable reverted (${avail.kind})`);
  if (!asBool(word(avail.result, 0))) throw new EnsRegisterError('unavailable', `${label}.eth is not available`);
  const price = await ensCall(transport, reg, encodeEnsGetRegisterPrice(label, duration, token.address), blockTag);
  if (!price.ok) {
    if (price.kind === 'paymentTokenNotSupported') throw new EnsRegisterError('payment-token', 'The registrar no longer accepts this payment token');
    if (price.kind === 'notValid') throw new EnsRegisterError('invalid-label', `The registrar does not accept "${label}"`);
    if (price.kind === 'durationTooShort') throw new EnsRegisterError('duration', 'The duration is below the registrar minimum');
    if (price.kind === 'nameNotAvailable') throw new EnsRegisterError('unavailable', `${label}.eth is not available`);
    throw new EnsRegisterError('deployment-mismatch', `getRegisterPrice reverted (${price.kind})`);
  }
  if (price.result.length !== 64) throw new EnsRegisterError('malformed', 'getRegisterPrice returned an unexpected size');
  const base = word(price.result, 0);
  const premium = word(price.result, 1);
  if (premium !== 0n) {
    throw new EnsRegisterError('premium', `${label}.eth expired recently and still carries a temporary premium; this wallet does not offer it`);
  }
  // The mirror: the oracle's parameters, the token ratio and the name's state at the same block.
  const pricing = await readPricingAt(transport, blockTag);
  const ratioRaw = await ensView(transport, ENS_V2_SEPOLIA.rentPriceOracle, 'getPaymentTokenRatio(address)', [{ kind: 'address', value: token.address }], blockTag);
  const ratio = { numer: word(ratioRaw, 0), denom: word(ratioRaw, 1) };
  const state = await readStateAt(transport, ENS_V2_SEPOLIA.ethRegistry, label, blockTag);
  const mirror = ensRegisterPrice(pricing, label, ensAvailablePeriod(state.expiry, timestamp, config.gracePeriod), duration, ratio);
  if (mirror.base !== base || mirror.premium !== premium) {
    throw new EnsRegisterError('price-mismatch', `The registrar quoted ${base.toString()} + ${premium.toString()} but the wallet computed ${mirror.base.toString()} + ${mirror.premium.toString()}`);
  }
  const name = `${label}.eth`;
  return {
    label,
    name,
    node: toHex(namehash(name)),
    owner,
    duration,
    paymentToken: token,
    base,
    premium,
    total: base + premium,
    expiryIfRegisteredNow: timestamp + duration,
    blockNumber,
    quoteTimestamp: timestamp,
    config,
  };
}

/** The owner's own resolver: where it is (or will be) and whether it can be used. */
export interface EnsOwnedResolverState {
  address: string;
  salt: bigint;
  deployed: boolean;
}

/**
 * Finds the owner's PermissionedResolver at the conventional factory
 * address. When code exists there, it must verify through the factory
 * (verifyContract returns the implementation, which must be the pinned
 * PermissionedResolver implementation) and the owner must hold
 * ROLE_SET_ADDRESS on it (hasRootRoles); otherwise the wallet refuses rather
 * than write records nobody it controls can change.
 */
export async function readEnsOwnedResolver(transport: JsonRpcTransport, owner: string): Promise<EnsOwnedResolverState> {
  const who = requireAddress(owner, 'The owner');
  const { blockTag } = await sepoliaBlock(transport);
  const salt = ensOwnedResolverSalt(who);
  const address = predictVerifiableProxyAddress(who, salt);
  const code = await transport('eth_getCode', [address, blockTag]);
  if (typeof code !== 'string') throw new EnsRegisterError('malformed', 'eth_getCode returned a non-string');
  if (code === '0x') return { address, salt, deployed: false };
  const impl = await ensCall(transport, ENS_V2_SEPOLIA.verifiableFactory, encodeFunctionCall('verifyContract(address)', [{ kind: 'address', value: address }]), blockTag);
  if (!impl.ok || asAddress(word(impl.result, 0)) !== ENS_V2_SEPOLIA.permissionedResolverImpl) {
    throw new EnsRegisterError('resolver', `The resolver at ${address} does not verify as a PermissionedResolver proxy from ENS's factory`);
  }
  const role = await ensCall(transport, address, encodeFunctionCall('hasRootRoles(uint256,address)', [
    { kind: 'uint256', value: ENS_RESOLVER_ROLE_SET_ADDRESS },
    { kind: 'address', value: who },
  ]), blockTag);
  if (!role.ok || !asBool(word(role.result, 0))) {
    throw new EnsRegisterError('resolver', `The owner cannot set address records on its resolver ${address}`);
  }
  return { address, salt, deployed: true };
}

/** ETHRegistrar.commitmentAt: the timestamp a commitment was recorded, or 0. */
export async function readEnsCommitmentAt(transport: JsonRpcTransport, commitment: Uint8Array): Promise<bigint> {
  const { blockTag } = await sepoliaBlock(transport);
  return word(await ensView(transport, ENS_V2_SEPOLIA.ethRegistrar, 'commitmentAt(bytes32)', [{ kind: 'fixedBytes', value: commitment }], blockTag), 0);
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

/** When register() may be sent for a commitment recorded at `commitTime`. */
export interface EnsRegisterWindow {
  /** The first block timestamp at which register() succeeds (commitTime + MIN_COMMITMENT_AGE). */
  notBefore: bigint;
  /** register() must be included in a block with timestamp strictly below this (commitTime + MAX_COMMITMENT_AGE). */
  expiresAt: bigint;
}

/** ETHRegistrar._consumeCommitment's window (ETHRegistrar.sol 230–242). */
export function ensRegisterWindow(commitTime: bigint, limits: { minCommitmentAge: bigint; maxCommitmentAge: bigint } = ENS_V2_SEPOLIA_REGISTRAR_LIMITS): EnsRegisterWindow {
  if (commitTime <= 0n) throw new EnsRegisterError('commitment', 'The commitment has not been recorded');
  return { notBefore: commitTime + limits.minCommitmentAge, expiresAt: commitTime + limits.maxCommitmentAge };
}

/** Whether register() would pass the commitment check at block timestamp `now`. */
export function ensRegisterTiming(window: EnsRegisterWindow, now: bigint): 'too-new' | 'ready' | 'expired' {
  if (now < window.notBefore) return 'too-new';
  if (now >= window.expiresAt) return 'expired';
  return 'ready';
}

/** One step of a plan: calls the owner sends (one transaction each from a regular account, or one batch from a smart account). */
export interface EnsPlanStep {
  kind: 'prepare' | 'register' | 'subname';
  calls: Call[];
  /** One line per call, for the confirm screen. */
  describe: string[];
}

/** A two-step registration plan; everything needed to finish it later is in here (the secret too — keep it private until register). */
export interface EnsRegistrationPlan {
  name: string;
  label: string;
  node: string;
  owner: string;
  resolver: string;
  deploysResolver: boolean;
  duration: bigint;
  paymentToken: EnsPaymentToken;
  total: bigint;
  /** 0x-hex of the 32-byte secret: revealing it before register() lets anyone with the commitment front-run the name. */
  secret: string;
  commitment: string;
  setsReverse: boolean;
  prepare: EnsPlanStep;
  register: EnsPlanStep;
}

/**
 * Builds the registration as two steps for the owner to send:
 *
 *  prepare: the owner's resolver with the name's ETH address record (deployed
 *           through the factory with the record set in initialize(), or —
 *           if the owner already has one — a setAddress on it), the exact
 *           approval of the payment token, and commit(commitment);
 *  register (only once ensRegisterTiming says "ready"): register(…) and,
 *           when asked, the v1 ReverseRegistrar's setName(name) so the
 *           address shows the name in other wallets.
 *
 * The record and the approval go in the first step so the second can be
 * sent the moment the wait ends; the approval equals the quote exactly
 * (names with a premium are refused at the quote, and the base for a given
 * label and duration does not change, so register() pulls exactly that and
 * no allowance is left behind). The resolver record for a name the owner
 * does not hold yet is harmless: it is the owner's own resolver, and the
 * name points at it only once register() succeeds.
 */
export function planEnsRegistration(input: {
  quote: EnsRegistrationQuote;
  resolver: EnsOwnedResolverState;
  secret: Uint8Array;
  setReverse: boolean;
}): EnsRegistrationPlan {
  const { quote, resolver } = input;
  checkSecret(input.secret);
  const owner = requireAddress(quote.owner, 'The owner');
  const expectedResolver = predictVerifiableProxyAddress(owner, ensOwnedResolverSalt(owner));
  if (resolver.address !== expectedResolver) {
    throw new EnsRegisterError('resolver', `The resolver ${resolver.address} is not the owner's conventional resolver ${expectedResolver}`);
  }
  if (quote.total <= 0n) throw new EnsRegisterError('malformed', 'The quote has no fee');
  const params: EnsCommitmentParams = {
    label: quote.label,
    owner,
    secret: input.secret,
    subregistry: ZERO_ADDRESS,
    resolver: resolver.address,
    duration: quote.duration,
    referrer: ZERO_32,
  };
  const commitment = ensRegistrationCommitment(params);
  const setAddr = encodeEnsSetEthAddress(quote.name, owner);
  const recordCall: Call = resolver.deployed
    ? { to: resolver.address, value: 0n, data: setAddr }
    : {
        to: ENS_V2_SEPOLIA.verifiableFactory,
        value: 0n,
        data: encodeVerifiableDeployProxy(ENS_V2_SEPOLIA.permissionedResolverImpl, resolver.salt, encodeEnsResolverInitialize(owner, [setAddr])),
      };
  const prepare: EnsPlanStep = {
    kind: 'prepare',
    calls: [
      recordCall,
      { to: quote.paymentToken.address, value: 0n, data: encodeEnsExactApprove(ENS_V2_SEPOLIA.ethRegistrar, quote.total) },
      { to: ENS_V2_SEPOLIA.ethRegistrar, value: 0n, data: encodeEnsCommit(commitment) },
    ],
    describe: [
      resolver.deployed
        ? `Set ${quote.name}'s Ethereum address to ${owner} on your ENS resolver ${resolver.address}`
        : `Create your ENS resolver ${resolver.address} (ENS's factory) with ${quote.name} pointing to ${owner}`,
      `Approve exactly ${quote.total.toString()} base units of ${quote.paymentToken.symbol} for the ENS registrar`,
      `Commit to registering ${quote.name} (reveals nothing about the name)`,
    ],
  };
  const register: EnsPlanStep = {
    kind: 'register',
    calls: [
      { to: ENS_V2_SEPOLIA.ethRegistrar, value: 0n, data: encodeEnsRegister(params, quote.paymentToken.address) },
      ...(input.setReverse ? [{ to: ENS_V2_SEPOLIA.v1ReverseRegistrar, value: 0n, data: encodeEnsV1ReverseSetName(quote.name) }] : []),
    ],
    describe: [
      `Register ${quote.name} to ${owner} for ${quote.duration.toString()} seconds, paying ${quote.total.toString()} base units of ${quote.paymentToken.symbol}`,
      ...(input.setReverse ? [`Make ${quote.name} the name shown for ${owner} (ENS reverse record)`] : []),
    ],
  };
  return {
    name: quote.name,
    label: quote.label,
    node: quote.node,
    owner,
    resolver: resolver.address,
    deploysResolver: !resolver.deployed,
    duration: quote.duration,
    paymentToken: quote.paymentToken,
    total: quote.total,
    secret: toHex(input.secret),
    commitment: toHex(commitment),
    setsReverse: input.setReverse,
    prepare,
    register,
  };
}

/**
 * Checks, just before register() is sent, that the commitment is on-chain
 * and inside its window at the latest block, and that the name is still
 * available. Returns the window; throws EnsRegisterError('commitment' |
 * 'unavailable') otherwise. A simulation of the exact calls should follow.
 */
export async function checkEnsRegisterReady(transport: JsonRpcTransport, plan: EnsRegistrationPlan): Promise<EnsRegisterWindow & { now: bigint }> {
  const { blockTag, timestamp } = await sepoliaBlock(transport);
  const at = word(await ensView(transport, ENS_V2_SEPOLIA.ethRegistrar, 'commitmentAt(bytes32)', [{ kind: 'fixedBytes', value: toBytes(plan.commitment) }], blockTag), 0);
  if (at === 0n) throw new EnsRegisterError('commitment', 'The commitment is not on-chain yet');
  const window = ensRegisterWindow(at);
  const timing = ensRegisterTiming(window, timestamp);
  if (timing === 'too-new') throw new EnsRegisterError('commitment', `The commitment is too new: register() works from block time ${window.notBefore.toString()}`);
  if (timing === 'expired') throw new EnsRegisterError('commitment', 'The commitment is older than a day; commit again');
  const avail = await ensCall(transport, ENS_V2_SEPOLIA.ethRegistrar, encodeEnsIsAvailable(plan.label), blockTag);
  if (!avail.ok || !asBool(word(avail.result, 0))) throw new EnsRegisterError('unavailable', `${plan.name} is no longer available`);
  return { ...window, now: timestamp };
}

/** A sub-name plan (e.g. smart.alice.eth → the smart account). */
export interface EnsSubnamePlan {
  name: string;
  parent: string;
  target: string;
  mode: 'registered' | 'record-only';
  userRegistry: string | null;
  step: EnsPlanStep;
  /** The call the TARGET account must send itself for its reverse record (null when not asked). */
  targetReverseCall: Call | null;
}

/**
 * A sub-name under a name the owner holds, pointing at `target` (the
 * owner's smart account). Two shapes, both proven in eth_simulateV1 on
 * 2026-10-25 (docs/WALLET_HANDLES.md section 6):
 *
 *  'registered': the owner's own UserRegistry for the parent (deployed
 *     through the factory with the docs' "UserRegistry" salt, unless already
 *     the parent's subregistry), set as the parent's subregistry
 *     (ETHRegistry.setSubregistry — the registrant holds
 *     ROLE_SET_SUBREGISTRY), the sub-label registered to the owner with the
 *     owner's resolver and the parent's expiry, and the address record. The
 *     sub-name is then an ERC-1155 token of its own (about 1.6 million gas
 *     more than the record alone on Sepolia today).
 *  'record-only': only the address record on the owner's resolver. The
 *     Universal Resolver walks to the nearest resolver it found (the
 *     parent's) and that resolver answers for the sub-name
 *     (LibResolution.findResolver; PermissionedResolver supports
 *     IExtendedResolver), so the sub-name resolves but is not a token, has
 *     no owner of its own and follows the parent's resolver if that changes.
 *
 * Every call in `step` is sent by the owner. The optional reverse record
 * must be sent by the target itself (setName names msg.sender).
 */
export function planEnsSubname(input: {
  parentLabel: string;
  subLabel: string;
  owner: string;
  target: string;
  resolver: EnsOwnedResolverState;
  mode: 'registered' | 'record-only';
  /** For 'registered': the parent's expiry (getState) — the sub-name lives as long as the parent. */
  parentExpiry?: bigint;
  /** For 'registered': the parent's current subregistry (getSubregistry), or the zero address. */
  parentSubregistry?: string;
  /** For 'registered': whether the owner's UserRegistry for the parent is already deployed. */
  userRegistryDeployed?: boolean;
  targetReverse: boolean;
}): EnsSubnamePlan {
  const parentLabel = requireLabel(input.parentLabel);
  const sub = checkEnsSubLabel(input.subLabel);
  if (!sub.ok) throw new EnsRegisterError('invalid-label', `"${input.subLabel}" is not a valid sub-label (${sub.problem})`);
  const owner = requireAddress(input.owner, 'The owner');
  const target = requireAddress(input.target, 'The target');
  if (!input.resolver.deployed) throw new EnsRegisterError('resolver', 'The owner has no ENS resolver yet; register the parent name first');
  const parent = `${parentLabel}.eth`;
  const name = `${sub.label}.${parent}`;
  const record: Call = { to: input.resolver.address, value: 0n, data: encodeEnsSetEthAddress(name, target) };
  const calls: Call[] = [];
  const describe: string[] = [];
  let userRegistry: string | null = null;
  if (input.mode === 'registered') {
    if (input.parentExpiry === undefined || input.parentSubregistry === undefined || input.userRegistryDeployed === undefined) {
      throw new EnsRegisterError('malformed', 'A registered sub-name needs the parent expiry, its subregistry and whether the owner registry exists');
    }
    const salt = ensUserRegistrySalt(parent);
    userRegistry = predictVerifiableProxyAddress(owner, salt);
    const current = input.parentSubregistry.toLowerCase();
    if (current !== ZERO_ADDRESS && current !== userRegistry.toLowerCase()) {
      throw new EnsRegisterError('resolver', `${parent} already has another subregistry (${input.parentSubregistry}); the wallet does not replace it`);
    }
    if (!input.userRegistryDeployed) {
      calls.push({ to: ENS_V2_SEPOLIA.verifiableFactory, value: 0n, data: encodeVerifiableDeployProxy(ENS_V2_SEPOLIA.userRegistryImpl, salt, encodeEnsUserRegistryInitialize(owner)) });
      describe.push(`Create your sub-name registry for ${parent} at ${userRegistry} (ENS's factory)`);
    }
    if (current === ZERO_ADDRESS) {
      calls.push({ to: ENS_V2_SEPOLIA.ethRegistry, value: 0n, data: encodeEnsSetSubregistry(parentLabel, userRegistry) });
      describe.push(`Use that registry for names under ${parent}`);
    }
    // roleBitmap 0: the owner already holds every root role on its own registry.
    calls.push({ to: userRegistry, value: 0n, data: encodeEnsRegistryRegister(sub.label, owner, input.resolver.address, 0n, requireUint64(input.parentExpiry, 'The parent expiry')) });
    describe.push(`Register ${name} to ${owner} until the parent's expiry`);
  }
  calls.push(record);
  describe.push(`Point ${name} to ${target}`);
  return {
    name,
    parent,
    target,
    mode: input.mode,
    userRegistry,
    step: { kind: 'subname', calls, describe },
    targetReverseCall: input.targetReverse ? { to: ENS_V2_SEPOLIA.v1ReverseRegistrar, value: 0n, data: encodeEnsV1ReverseSetName(name) } : null,
  };
}

// ---------------------------------------------------------------------------
// Reverse resolution (the name other wallets show for an address)
// ---------------------------------------------------------------------------

/** Universal Resolver reverse(bytes lookupAddress, uint256 coinType). */
export function encodeEnsReverse(address: string, coinType: bigint = ENS_REGISTER_COIN_TYPE_ETH): Uint8Array {
  return encodeFunctionCall('reverse(bytes,uint256)', [
    { kind: 'bytes', value: toBytes(requireAddress(address, 'The address')) },
    { kind: 'uint256', value: coinType },
  ]);
}

/**
 * Strict decoder for reverse()'s `(string primary, address resolver,
 * address reverseResolver)`: offset 0x60, two clean address words, the
 * string's length within bounds, zero padding and no trailing bytes.
 */
export function decodeEnsReverseResult(bytes: Uint8Array): { name: string; resolver: string; reverseResolver: string } {
  if (bytes.length < 128 || word(bytes, 0) !== 96n) throw new EnsRegisterError('malformed', 'reverse() returned an unexpected head');
  const resolver = asAddress(word(bytes, 1));
  const reverseResolver = asAddress(word(bytes, 2));
  const length = word(bytes, 3);
  if (length > BigInt(bytes.length)) throw new EnsRegisterError('malformed', 'reverse() string length out of range');
  const len = Number(length);
  const padded = Math.ceil(len / 32) * 32;
  if (128 + padded !== bytes.length || bytes.slice(128 + len).some((b) => b !== 0)) {
    throw new EnsRegisterError('malformed', 'reverse() returned trailing or non-zero padding bytes');
  }
  const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(128, 128 + len));
  return { name, resolver, reverseResolver };
}

/** The primary name of an address, as the Universal Resolver reports it. */
export type EnsPrimaryName =
  /** No primary name is set (reverse() answered an empty name). */
  | { status: 'none' }
  /** A name in the wallet's ASCII subset; the Universal Resolver already checked it resolves back to the address. */
  | { status: 'ok'; name: string; resolver: string }
  /** A name the wallet does not display (outside its normalised ASCII subset). */
  | { status: 'unsupported'; name: string }
  /** The name resolves off-chain (EIP-3668), which this wallet does not follow. */
  | { status: 'offchain' };

/**
 * Reads the primary name of `address` on Ethereum Sepolia or mainnet
 * through the Universal Resolver's reverse(address, 60). ENS's docs
 * (src/pages/ensv2/tutorial-app-developers.mdx, "Primary Names"): "In ENSv2
 * the Universal Resolver enforces this onchain: during reverse resolution it
 * forward-resolves the returned name and reverts with
 * ReverseAddressMismatch if the addresses differ" — so a name returned here
 * already resolves to the address. Read live on 2026-10-25: an address with
 * no primary name answers ("", 0x0, the ENSV1Resolver mirror). Other
 * reverts are rethrown as EnsRegisterError('malformed') with the selector;
 * transport failures are rethrown unchanged.
 */
export async function readEnsPrimaryName(transport: JsonRpcTransport, address: string, expectedChainId: bigint): Promise<EnsPrimaryName> {
  if (expectedChainId !== 1n && expectedChainId !== 11155111n) {
    throw new EnsRegisterError('wrong-chain', `Primary names are read only on Ethereum mainnet and Sepolia, not chain ${expectedChainId.toString()}`);
  }
  const reported = BigInt((await transport('eth_chainId', [])) as string);
  if (reported !== expectedChainId) throw new EnsRegisterError('wrong-chain', `The endpoint serves chain ${reported.toString()}, not ${expectedChainId.toString()}`);
  const data = encodeEnsReverse(address);
  let raw: unknown;
  try {
    raw = await transport('eth_call', [{ to: ENS_UNIVERSAL_RESOLVER, data: toHex(data) }, 'latest']);
  } catch (error) {
    const revert = revertDataOf(error);
    if (revert === undefined) throw error;
    if (classifyEnsRevert(revert) === 'offchain-lookup') return { status: 'offchain' };
    throw new EnsRegisterError('malformed', `reverse() reverted with ${revert.slice(0, 10)}`);
  }
  const decoded = decodeEnsReverseResult(hexResult(raw));
  if (decoded.name === '') return { status: 'none' };
  const check = normalizeEnsNameAscii(decoded.name);
  if (!check.ok || check.name !== decoded.name) return { status: 'unsupported', name: decoded.name };
  return { status: 'ok', name: decoded.name, resolver: decoded.resolver };
}
