import AsyncStorage from '@react-native-async-storage/async-storage';
import type { DerivedAccount } from '@shiba-wallet/core';
import { toChecksumAddress } from '@shiba-wallet/core';
import {
  BundlerClient,
  ENTRYPOINT_V07,
  KERNEL_V3_3,
  NodeClient,
  SmartAccountClient,
  KERNEL_V3_3_7702_DELEGATE,
  createKernel7702AccountSpec,
  createKernelAccountSpec,
  createSimpleAccountSpec,
  decodeUint256,
  kernelRecoveredAccountSpec,
  encodeErc20BalanceOf,
  encodeErc20Transfer,
  encodeFunctionCall,
  httpTransport,
  readDelegationStatus,
  signHashForSmartAccount,
  toBytes,
  toHex,
  verifyKernelDeployment,
  withDepositTopUpHeadroom,
  type Call,
  type JsonRpcTransport,
  type SignedEip7702Authorization,
  type SmartAccountSignature,
  type SmartAccountSpec,
  type UserOperation,
} from '@shiba-wallet/chains-evm';
// Explicit .ts extensions: this module is imported by scripts/check-aa.mjs
// under Node's type stripping, which resolves relative specifiers literally.
import { EVM_CHAIN_ID, validateRecipient } from './send.ts';
import type { KeyValueStore } from './tokens.ts';
import { assertSecureEndpointUrl } from '../config/endpoint-url.ts';
import { assertWalletDelegate, invalidateAccountDelegation } from './delegation.ts';
import {
  FeatureNotAllowedError,
  assertFeatureAllowed,
  eip155Caip2,
  isFeatureAllowed,
  type FeatureId,
} from '../config/readiness.ts';

/**
 * ERC-4337 smart-account glue for the app (experimental, off by default):
 * per-chain bundler/factory configuration with mandatory save-time
 * verification, SmartAccountClient construction, the AA send quote, and
 * defensive receipt inspection. This module plugs into the SMART-ACCOUNT
 * SEAM documented in ./send.ts; the EOA path there is untouched.
 *
 * Configuration lives in AsyncStorage (bundler URLs and factory addresses
 * are public configuration, not secrets — same reasoning as
 * config/networks.ts and ./tokens.ts). Every function takes an injectable
 * KeyValueStore and transport factory so scripts/check-aa.mjs can exercise
 * the exact app code under Node with in-memory fakes.
 *
 * Gas is paid by the smart account from its own balance unless a verified
 * ERC-7677 paymaster is configured (phase 5), in which case
 * SmartAccountClient runs the stub/final paymaster flow.
 *
 * ACCOUNT TYPES (phase 7 item 1). Each EVM chain's configuration names one
 * smart-account implementation:
 *  - 'simple': the eth-infinitism SimpleAccount v0.7.0 sample behind a
 *    SimpleAccountFactory (verified with the docs/AA_STACK.md procedure).
 *    It has no isValidSignature, so it cannot sign messages for dApps.
 *  - 'kernel-v3.3': ZeroDev Kernel v3.3 (ERC-7579) with the ECDSA validator
 *    as root validator, deployed through the pinned KERNEL_V3_3 addresses
 *    from @shiba-wallet/chains-evm (identical on mainnet and Sepolia per the
 *    engine's source notes), verified with verifyKernelDeployment. It
 *    implements ERC-1271, so it can sign messages (ERC-6492-wrapped while
 *    the account is not deployed yet).
 * For both types the owner is the ACTIVE account's seed-derived EOA (ADR
 * D1) and the CREATE2 salt is the account index (ADR D8). Everything after
 * createAaClient — quoting, sending, receipts — is type-agnostic: it goes
 * through the spec the bundle carries.
 *  - 'kernel-7702' (phase 8 item 1): the EOA ITSELF becomes the smart
 *    account at the same address, delegated with EIP-7702 to the pinned
 *    Kernel v3.3 implementation (engine createKernel7702AccountSpec). It
 *    has no factory. Unlike the two types above it is not a per-chain
 *    choice: delegation belongs to one EOA, so it is recorded per OWNER
 *    ADDRESS (eip7702Owners) by the "Upgrade this account" flow, and only
 *    for those owners does createAaClientFromConfig build it. Every other
 *    account keeps the chain's type. A chain-wide setting would let another
 *    account's next smart-account send sign an authorization its user never
 *    asked for, which ADR D6 forbids. Revoking removes the owner, so the
 *    effective type returns to the chain's type (the previous one).
 *  - A RECOVERED Kernel v3.3 account (phase 8 item 4): a deployed Kernel
 *    account whose root owner was changed to one of this wallet's EOAs by a
 *    guardian recovery. Its address is not the CREATE2 result of that owner
 *    (the salt commits to the ORIGINAL owner; engine kernel-recovery.ts), so
 *    it cannot be derived from the seed. Like the 7702 type it is recorded
 *    PER OWNER (recoveredAccounts), written only by ./recovery.ts after the
 *    engine's verifyKernelAccountForOwner passed, and createAaClientFromConfig
 *    then builds the engine's kernelRecoveredAccountSpec (which re-reads the
 *    on-chain owner before it returns the address). The bundle's
 *    accountType stays 'kernel-v3.3' (same encoding and signatures) and
 *    `recovered` carries the address so screens can label it.
 *
 * KNOWN BUNDLER LIMITATION (AGENTS.md phase 7, live Sepolia probes
 * 2026-10-01): Alchemy's bundler rejected Kernel v3.3 DEPLOYMENT
 * operations on both deployment paths under ERC-7562 rules (meta factory:
 * "account uses banned opcode: CREATE2"; direct factory: unstaked-factory
 * storage access) while accepting operations from already-deployed Kernel
 * accounts. The app has no self-bundling path on purpose: such an error is
 * shown to the user verbatim (describeAaError), and the first operation of
 * a Kernel account needs a bundler that accepts Kernel deployments.
 */

const AA_CONFIG_KEY = 'shiba-wallet.aa-config.v1';

/** Builds a JSON-RPC transport for a URL; injectable for offline tests. */
export type TransportFactory = (url: string) => JsonRpcTransport;

/** The factory-deployed smart-account implementations configurable per chain. */
export type AaFactoryAccountType = 'simple' | 'kernel-v3.3';

/**
 * Every smart-account type a bundle can carry: the per-chain factory types,
 * plus 'kernel-7702' for an owner upgraded through the EIP-7702 flow.
 */
export type AaAccountType = AaFactoryAccountType | 'kernel-7702';

/** The per-chain choices offered in Settings (kernel-7702 is per account, not here). */
export const AA_ACCOUNT_TYPES: readonly AaFactoryAccountType[] = ['simple', 'kernel-v3.3'];

/** Plain names for the account types (Settings, confirm screens, WC sheet). */
export function aaAccountTypeLabel(type: AaAccountType): string {
  if (type === 'kernel-7702') return 'Kernel v3.3 via EIP-7702 (your own address)';
  return type === 'kernel-v3.3' ? 'Kernel v3.3 (ERC-7579)' : 'SimpleAccount (v0.7 sample)';
}

/** True when the account type can sign messages for dApps (ERC-1271). */
export function aaAccountTypeSignsMessages(type: AaAccountType): boolean {
  return type === 'kernel-v3.3' || type === 'kernel-7702';
}

/**
 * The pinned Kernel v3.3 deployment the Settings editor pre-fills, taken
 * from the engine's KERNEL_V3_3 constants (the same addresses on Ethereum
 * mainnet and Sepolia; see packages/chains-evm/src/kernel-account.ts for
 * their sources and the read-only on-chain confirmation). Saving still runs
 * verifyKernelDeployment against the configured RPC endpoint.
 */
export const KERNEL_PREFILL = {
  factory: KERNEL_V3_3.factory,
  metaFactory: KERNEL_V3_3.metaFactory,
  implementation: KERNEL_V3_3.implementation,
  ecdsaValidator: KERNEL_V3_3.ecdsaValidator,
  accountId: KERNEL_V3_3.accountId,
} as const;

/**
 * Plain-language note about the observed bundler behavior (Settings and the
 * Kernel deployment error). Kept as one constant so every surface says the
 * same thing.
 */
export const KERNEL_BUNDLER_NOTE =
  "Alchemy's bundler currently rejects Kernel DEPLOYMENT operations (ERC-7562 " +
  'rules on CREATE2 use and unstaked factories) while accepting operations from ' +
  'Kernel accounts that are already deployed. With that bundler, the first ' +
  'operation of a new Kernel account (the one that deploys it) may fail until a ' +
  'bundler that accepts Kernel deployments is configured. The bundler’s error ' +
  'is shown exactly as it was returned.';

/**
 * Persisted AA configuration for one chain. A non-null bundlerUrl/factory
 * implies the corresponding verification passed at save time — the setters
 * below refuse to persist anything that fails verification, so "configured"
 * and "verified" are the same state by construction.
 */
export interface AaChainConfig {
  bundlerUrl: string | null;
  /** ISO timestamp of the successful eth_supportedEntryPoints check. */
  bundlerVerifiedAt: string | null;
  /**
   * Which implementation `factory` deploys. Configurations saved before
   * account types existed have no stored type and read as 'simple'.
   */
  accountType: AaFactoryAccountType;
  /**
   * EIP-55 checksummed factory: the SimpleAccountFactory ('simple') or the
   * KernelFactory, i.e. the CREATE2 deployer ('kernel-v3.3').
   */
  factory: string | null;
  /**
   * The account implementation behind the verified factory:
   * accountImplementation() for 'simple', factory.implementation() for
   * 'kernel-v3.3'.
   */
  factoryImplementation: string | null;
  /** Kernel only: the staked meta factory (FactoryStaker) used as op factory. */
  kernelMetaFactory: string | null;
  /** Kernel only: the ECDSA validator module installed as root validator. */
  kernelValidator: string | null;
  /** Kernel only: accountId() reported by the implementation at save time. */
  kernelAccountId: string | null;
  /** ISO timestamp of the successful on-chain factory verification. */
  factoryVerifiedAt: string | null;
  /** ERC-7677 paymaster endpoint; null means the account pays its gas. */
  paymasterUrl: string | null;
  /** Opaque vendor context as a JSON string ('' stored as null). */
  paymasterContext: string | null;
  /** ISO timestamp of the successful pm_getPaymasterStubData probe. */
  paymasterVerifiedAt: string | null;
  /**
   * Owner EOAs (EIP-55, as derived) whose smart-account sends on this chain
   * use 'kernel-7702' — written only by the "Upgrade this account" flow
   * (setAccountEip7702). Independent of the factory fields above, which
   * stay as they were and apply again when an owner is removed.
   */
  eip7702Owners: string[];
  /**
   * Recovered Kernel v3.3 accounts (phase 8 item 4), one per owner EOA:
   * smart-account sends by `owner` on this chain use `account` through the
   * engine's kernelRecoveredAccountSpec. Written only by ./recovery.ts
   * (setRecoveredAccount) after an on-chain ownership check. Configurations
   * saved before this field existed read as an empty list.
   */
  recoveredAccounts: RecoveredAccountLink[];
  /**
   * The CAIP-2 id this configuration was read for. Set by getAaConfig and
   * by every function here that returns a configuration; never read from
   * storage. isAaConfigured uses it for the mainnet readiness gate
   * (config/readiness.ts), and a configuration without it (null, e.g. one
   * built by hand) counts as gated.
   */
  chain: string | null;
}

/** One recovered account attached to one of the wallet's owner EOAs. */
export interface RecoveredAccountLink {
  /** The wallet's owner EOA (EIP-55). */
  owner: string;
  /** The recovered Kernel account (EIP-55); not derivable from the seed. */
  account: string;
  /** ISO timestamp of the attachment. */
  attachedAt: string;
}

const EMPTY_CONFIG: AaChainConfig = {
  bundlerUrl: null,
  bundlerVerifiedAt: null,
  accountType: 'simple',
  factory: null,
  factoryImplementation: null,
  kernelMetaFactory: null,
  kernelValidator: null,
  kernelAccountId: null,
  factoryVerifiedAt: null,
  paymasterUrl: null,
  paymasterContext: null,
  paymasterVerifiedAt: null,
  eip7702Owners: [],
  recoveredAccounts: [],
  chain: null,
};

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

function normalizeRecoveredLinks(value: unknown): RecoveredAccountLink[] {
  if (!Array.isArray(value)) return [];
  const out: RecoveredAccountLink[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.owner !== 'string' || !ADDRESS_PATTERN.test(e.owner)) continue;
    if (typeof e.account !== 'string' || !ADDRESS_PATTERN.test(e.account)) continue;
    // One link per owner; a later duplicate is dropped.
    if (out.some((l) => l.owner.toLowerCase() === (e.owner as string).toLowerCase())) continue;
    out.push({
      owner: toChecksumAddress(toBytes(e.owner.toLowerCase())),
      account: toChecksumAddress(toBytes(e.account.toLowerCase())),
      attachedAt: typeof e.attachedAt === 'string' ? e.attachedAt : '',
    });
  }
  return out;
}

type ConfigMap = Record<string, Partial<AaChainConfig>>;

async function loadConfigMap(store: KeyValueStore): Promise<ConfigMap> {
  try {
    const raw = await store.getItem(AA_CONFIG_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as ConfigMap;
    }
    return {};
  } catch {
    // Corrupt JSON or unavailable storage: behave as unconfigured rather
    // than break Settings or the send flow (same discipline as networks.ts).
    return {};
  }
}

async function saveConfigMap(map: ConfigMap, store: KeyValueStore): Promise<void> {
  await store.setItem(AA_CONFIG_KEY, JSON.stringify(map));
}

function normalizeEntry(entry: Partial<AaChainConfig> | undefined, chain: string): AaChainConfig {
  const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
  const bundlerUrl = str(entry?.bundlerUrl);
  const factory = str(entry?.factory);
  const paymasterUrl = str(entry?.paymasterUrl);
  const accountType: AaFactoryAccountType =
    factory !== null && entry?.accountType === 'kernel-v3.3' ? 'kernel-v3.3' : 'simple';
  const owners = Array.isArray(entry?.eip7702Owners)
    ? (entry.eip7702Owners as unknown[]).filter(
        (a): a is string => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a),
      )
    : [];
  const kernel = accountType === 'kernel-v3.3';
  return {
    bundlerUrl,
    bundlerVerifiedAt: bundlerUrl ? str(entry?.bundlerVerifiedAt) : null,
    accountType,
    factory,
    factoryImplementation: factory ? str(entry?.factoryImplementation) : null,
    kernelMetaFactory: kernel ? str(entry?.kernelMetaFactory) : null,
    kernelValidator: kernel ? str(entry?.kernelValidator) : null,
    kernelAccountId: kernel ? str(entry?.kernelAccountId) : null,
    factoryVerifiedAt: factory ? str(entry?.factoryVerifiedAt) : null,
    paymasterUrl,
    paymasterContext: paymasterUrl ? str(entry?.paymasterContext) : null,
    paymasterVerifiedAt: paymasterUrl ? str(entry?.paymasterVerifiedAt) : null,
    eip7702Owners: owners,
    recoveredAccounts: normalizeRecoveredLinks(entry?.recoveredAccounts),
    chain,
  };
}

/** The stored AA configuration for one chain (empty defaults when unset). */
export async function getAaConfig(
  chainId: string,
  store: KeyValueStore = AsyncStorage,
): Promise<AaChainConfig> {
  const map = await loadConfigMap(store);
  return normalizeEntry(map[chainId], chainId) ?? { ...EMPTY_CONFIG, chain: chainId };
}

/** True when `owner` was upgraded (EIP-7702) for smart-account sends on this chain. */
export function isEip7702Owner(config: AaChainConfig, owner: string | null | undefined): boolean {
  if (!owner) return false;
  const lower = owner.toLowerCase();
  return config.eip7702Owners.some((a) => a.toLowerCase() === lower);
}

/**
 * The account type a smart-account send by `owner` uses on this chain:
 * 'kernel-7702' for an upgraded owner, else the chain's factory type.
 */
export function effectiveAaAccountType(
  config: AaChainConfig,
  owner?: string | null,
): AaAccountType {
  if (isEip7702Owner(config, owner)) return 'kernel-7702';
  if (recoveredAccountFor(config, owner)) return 'kernel-v3.3';
  return config.accountType;
}

/**
 * The recovered Kernel account attached to `owner` on this chain (phase 8
 * item 4), or null. Tolerates configurations without the field.
 */
export function recoveredAccountFor(config: AaChainConfig, owner: string | null | undefined): string | null {
  if (!owner) return null;
  const lower = owner.toLowerCase();
  return (config.recoveredAccounts ?? []).find((l) => l.owner.toLowerCase() === lower)?.account ?? null;
}

/**
 * True when the account type is allowed on the configuration's network by
 * the mainnet readiness table (config/readiness.ts) AND both endpoints are
 * configured (and therefore verified). A
 * Kernel configuration additionally needs its validator on record (always
 * written together with the factory by setAaKernelFactory). For an owner
 * upgraded with EIP-7702, or one with an attached recovered account, only
 * the bundler is needed (there is no factory involved).
 */
export function isAaConfigured(config: AaChainConfig, owner?: string | null): boolean {
  // Mainnet readiness (phase 9 item 6): on a network where this account
  // type is not allowed, the smart account reads as unavailable, so the
  // send, swap and WalletConnect screens (and the eligibility hooks behind
  // the Home links) hide their smart-account options without any change of
  // their own.
  if (aaReadinessBlock(config.chain, effectiveAaAccountType(config, owner)) !== null) return false;
  return hasCompleteAaSettings(config, owner);
}

/**
 * The settings half of isAaConfigured, WITHOUT the readiness gate. Used by
 * createAaClientFromConfig, so a configuration stored before the gate
 * existed can still build a client for the undo paths (revoking a session
 * key, removing a passkey or guardians, vetoing), which are never gated.
 * Every path that starts a gated feature checks readiness itself.
 */
export function hasCompleteAaSettings(config: AaChainConfig, owner?: string | null): boolean {
  if (isEip7702Owner(config, owner)) return config.bundlerUrl !== null;
  if (recoveredAccountFor(config, owner)) return config.bundlerUrl !== null;
  if (config.bundlerUrl === null || config.factory === null) return false;
  if (config.accountType === 'kernel-v3.3') return config.kernelValidator !== null;
  return true;
}

/** The readiness features (config/readiness.ts) a smart-account type relies on. */
export function aaTypeFeatures(type: AaAccountType): FeatureId[] {
  if (type === 'simple') return ['simple-account'];
  if (type === 'kernel-7702') return ['kernel-smart-account', 'eip7702-upgrade'];
  return ['kernel-smart-account'];
}

/**
 * The first readiness feature that keeps `type` from being used on `chain`,
 * or null when it is allowed there. A null chain (a configuration that did
 * not come from getAaConfig) is treated as gated.
 */
export function aaReadinessBlock(chain: string | null, type: AaAccountType): FeatureId | null {
  for (const feature of aaTypeFeatures(type)) {
    if (chain === null || !isFeatureAllowed(feature, chain)) return feature;
  }
  return null;
}

/**
 * Throws the readiness refusal when no smart-account type at all may be
 * used on `chain` (the bundler setting serves every type).
 */
function assertAnyAaTypeAllowed(chain: string): void {
  if (!isFeatureAllowed('kernel-smart-account', chain) && !isFeatureAllowed('simple-account', chain)) {
    throw new FeatureNotAllowedError('kernel-smart-account');
  }
}

/** Numeric EIP-155 chain id of a CAIP-2 'eip155:<n>' id; throws otherwise. */
export function eip155ChainIdOf(caip2: string): bigint {
  const match = /^eip155:([1-9][0-9]*)$/.exec(caip2);
  if (!match) throw new Error(`Not an EVM chain id: ${caip2}`);
  return BigInt(match[1]!);
}

// ---------------------------------------------------------------------------
// Verification (the exact checks from scripts/testnet/aa-smoke.mjs and
// docs/AA_STACK.md, steps 1–2 of the factory procedure)
// ---------------------------------------------------------------------------

function wordToAddress(word: unknown): string {
  if (typeof word !== 'string') throw new Error(`expected 32-byte word, got ${String(word)}`);
  const bytes = toBytes(word);
  if (bytes.length !== 32) throw new Error(`expected 32-byte word, got ${word}`);
  return toChecksumAddress(bytes.slice(12));
}

async function ethCall(node: JsonRpcTransport, to: string, data: Uint8Array): Promise<unknown> {
  return node('eth_call', [
    { to, data: '0x' + [...data].map((b) => b.toString(16).padStart(2, '0')).join('') },
    'latest',
  ]);
}

export interface FactoryVerification {
  /** Checksummed accountImplementation() address (has code, EP verified). */
  implementation: string;
}

/**
 * On-chain SimpleAccountFactory verification, byte-for-byte the checks in
 * scripts/testnet/aa-smoke.mjs verifyFactory():
 *   1. eth_getCode on the factory must return non-empty code;
 *   2. accountImplementation() must return an address that has code;
 *   3. entryPoint() on that implementation must equal ENTRYPOINT_V07.
 * Throws with a specific message on the first failing check.
 */
export async function verifyAaFactory(
  node: JsonRpcTransport,
  factory: string,
): Promise<FactoryVerification> {
  const factoryCode = (await node('eth_getCode', [factory, 'latest'])) as string;
  if (!factoryCode || factoryCode === '0x') {
    throw new Error(`Factory ${factory} has no code on this chain`);
  }
  const implWord = await ethCall(node, factory, encodeFunctionCall('accountImplementation()', []));
  const implementation = wordToAddress(implWord);
  const implCode = (await node('eth_getCode', [implementation, 'latest'])) as string;
  if (!implCode || implCode === '0x') {
    throw new Error(`accountImplementation() ${implementation} has no code`);
  }
  const entryPointWord = await ethCall(node, implementation, encodeFunctionCall('entryPoint()', []));
  const entryPoint = wordToAddress(entryPointWord);
  if (entryPoint.toLowerCase() !== ENTRYPOINT_V07.toLowerCase()) {
    throw new Error(
      `Implementation's entryPoint() is ${entryPoint}, expected v0.7 ${ENTRYPOINT_V07}`,
    );
  }
  return { implementation };
}

/**
 * Bundler verification: eth_supportedEntryPoints must include EntryPoint
 * v0.7 (same refusal as scripts/testnet/aa-smoke.mjs). Returns the list the
 * bundler reported.
 */
/**
 * Display form of a stored endpoint URL. Bundler, paymaster and indexer
 * URLs usually embed the user's API key in the path or query, so Settings
 * shows only the scheme and host plus an elision for anything after it;
 * the stored value is untouched. Non-URL values (addresses, JSON) are
 * returned verbatim.
 */
export function maskUrlForDisplay(value: string): string {
  if (!/^https?:\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    const hasPath = url.pathname !== '/' && url.pathname !== '';
    const rest = hasPath ? '/…' : url.search ? '/?…' : '';
    return `${url.protocol}//${url.host}${rest}${hasPath && url.search ? '?…' : ''}`;
  } catch {
    const match = /^(https?:\/\/[^/?#]+)/i.exec(value);
    return match ? `${match[1]}/…` : 'https://…';
  }
}

/**
 * Asks the bundler for the lowest priority fee it will accept. Bundlers
 * enforce their own floors independently of the chain's fee market: on
 * 2026-10-01 Sepolia's node suggested 0.001 gwei and Alchemy's bundler
 * refused the operation with "maxPriorityFeePerGas is 1000000 but must be
 * at least 100000000". Alchemy documents rundler_maxPriorityFeePerGas as
 * returning "a fee per gas that is an estimate of how much users should set
 * as a priority fee in userOperations for Rundler endpoints"
 * (alchemy.com docs, Bundler API reference, read 2026-10-01). The method is
 * vendor-named, so it is tried best-effort: a bundler that does not serve
 * it, or answers with anything but a hex quantity, yields null and the
 * node's suggestion stands.
 */
export async function bundlerPriorityFeeFloor(bundler: JsonRpcTransport): Promise<bigint | null> {
  const rundler = await rundlerPriorityFee(bundler);
  if (rundler !== null) return rundler;
  return pimlicoPriorityFee(bundler);
}

function isHexQuantity(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value);
}

async function rundlerPriorityFee(bundler: JsonRpcTransport): Promise<bigint | null> {
  try {
    const result = await bundler('rundler_maxPriorityFeePerGas', []);
    return isHexQuantity(result) ? BigInt(result) : null;
  } catch {
    return null;
  }
}

/**
 * Pimlico-compatible bundlers (ZeroDev's RPC serves this method too, as a
 * 2026-10-01 probe showed) document pimlico_getUserOperationGasPrice as
 * returning "the gas prices that must be used for the user operation you
 * are bundling with Pimlico bundlers", with slow / standard / fast tiers
 * of hex maxFeePerGas and maxPriorityFeePerGas (docs.pimlico.io, Bundler
 * endpoints reference, read 2026-10-01). The standard tier's priority fee
 * is used as the floor.
 */
async function pimlicoPriorityFee(bundler: JsonRpcTransport): Promise<bigint | null> {
  try {
    const result = (await bundler('pimlico_getUserOperationGasPrice', [])) as
      | { standard?: { maxPriorityFeePerGas?: unknown } }
      | null
      | undefined;
    const value = result?.standard?.maxPriorityFeePerGas;
    return isHexQuantity(value) ? BigInt(value) : null;
  } catch {
    return null;
  }
}

/**
 * Raises the fee pair to the bundler's priority-fee floor when the node's
 * suggestion sits below it, keeping the base-fee allowance intact.
 */
export function applyPriorityFeeFloor(
  fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
  floor: bigint | null,
): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } {
  if (floor === null || floor <= fees.maxPriorityFeePerGas) return fees;
  return {
    maxFeePerGas: fees.maxFeePerGas + (floor - fees.maxPriorityFeePerGas),
    maxPriorityFeePerGas: floor,
  };
}

export async function verifyAaBundler(bundler: JsonRpcTransport): Promise<string[]> {
  const supported = await new BundlerClient(bundler, ENTRYPOINT_V07).supportedEntryPoints();
  const ok =
    Array.isArray(supported) &&
    supported.some(
      (a) => typeof a === 'string' && a.toLowerCase() === ENTRYPOINT_V07.toLowerCase(),
    );
  if (!ok) {
    throw new Error(
      `Bundler does not support EntryPoint v0.7 (${ENTRYPOINT_V07}). ` +
        `eth_supportedEntryPoints returned: ${JSON.stringify(supported)}`,
    );
  }
  return supported;
}

// ---------------------------------------------------------------------------
// Setters: verify first, refuse to persist on any failure
// ---------------------------------------------------------------------------

/**
 * Saves a bundler URL for one chain after a successful
 * eth_supportedEntryPoints check against that URL. Throws (persisting
 * nothing) when the URL is malformed, unreachable, or lacks v0.7 support.
 * Returns the bundler's supported entry points for display.
 */
export async function setAaBundlerUrl(
  chainId: string,
  url: string,
  options: { store?: KeyValueStore; transportFor?: TransportFactory } = {},
): Promise<string[]> {
  // Mainnet readiness: refused before any request, persisting nothing.
  assertAnyAaTypeAllowed(chainId);
  const store = options.store ?? AsyncStorage;
  const transportFor = options.transportFor ?? httpTransport;
  // https:// only (loopback http:// allowed for development); checked
  // before any request, so a refused URL persists nothing.
  const trimmed = assertSecureEndpointUrl(url);
  const supported = await verifyAaBundler(transportFor(trimmed));
  const map = await loadConfigMap(store);
  map[chainId] = {
    ...map[chainId],
    bundlerUrl: trimmed,
    bundlerVerifiedAt: new Date().toISOString(),
  };
  await saveConfigMap(map, store);
  return supported;
}

/**
 * Saves a SimpleAccountFactory address for one chain after validating it
 * (EIP-55 through the same engine path the send screen uses) and running
 * the full on-chain verification procedure against the given node RPC.
 * Throws (persisting nothing) when any check fails.
 */
export async function setAaFactory(
  chainId: string,
  factoryRaw: string,
  nodeUrl: string,
  options: { store?: KeyValueStore; transportFor?: TransportFactory } = {},
): Promise<FactoryVerification> {
  // Mainnet readiness: refused before any request, persisting nothing.
  assertFeatureAllowed('simple-account', chainId);
  const store = options.store ?? AsyncStorage;
  const transportFor = options.transportFor ?? httpTransport;
  // The node URL is the app's configured RPC endpoint: checked for https
  // before any request, then passed on unchanged.
  assertSecureEndpointUrl(nodeUrl);
  const validated = validateRecipient(EVM_CHAIN_ID, factoryRaw);
  if (!validated.ok) throw new Error(validated.error);
  const verification = await verifyAaFactory(transportFor(nodeUrl), validated.normalized);
  const map = await loadConfigMap(store);
  const entry: Partial<AaChainConfig> = {
    ...map[chainId],
    accountType: 'simple',
    factory: validated.normalized,
    factoryImplementation: verification.implementation,
    factoryVerifiedAt: new Date().toISOString(),
  };
  // A SimpleAccountFactory replaces any Kernel configuration wholesale.
  delete entry.kernelMetaFactory;
  delete entry.kernelValidator;
  delete entry.kernelAccountId;
  map[chainId] = entry;
  await saveConfigMap(map, store);
  return verification;
}

/**
 * Saves a Kernel v3.3 configuration for one chain after validating the
 * KernelFactory address (EIP-55, the send screen's validation) and running
 * the engine's verifyKernelDeployment against the given node RPC:
 *   0. the node's eth_chainId equals the chain being configured;
 *   1. KernelFactory, implementation, ECDSA validator and meta factory all
 *      have code;
 *   2. factory.implementation() equals the pinned KERNEL_V3_3 implementation;
 *   3. implementation.entrypoint() equals EntryPoint v0.7;
 *   4. implementation.accountId() equals "kernel.advanced.v0.3.3";
 *   5. metaFactory.approved(factory) is true;
 *   6. the validator reports isModuleType(1).
 * The meta factory, implementation and validator are the engine's pinned
 * KERNEL_V3_3 values; only the factory is user-editable (pre-filled with
 * KERNEL_V3_3.factory), and a factory that does not match the pinned
 * implementation fails check 2. Throws, persisting nothing, on any failure.
 */
export async function setAaKernelFactory(
  chainId: string,
  factoryRaw: string,
  nodeUrl: string,
  options: { store?: KeyValueStore; transportFor?: TransportFactory } = {},
): Promise<{ implementation: string; accountId: string }> {
  // Mainnet readiness: refused before any request, persisting nothing.
  assertFeatureAllowed('kernel-smart-account', chainId);
  const store = options.store ?? AsyncStorage;
  const transportFor = options.transportFor ?? httpTransport;
  // Same https check on the node URL as setAaFactory, before any request.
  assertSecureEndpointUrl(nodeUrl);
  const validated = validateRecipient(EVM_CHAIN_ID, factoryRaw);
  if (!validated.ok) throw new Error(validated.error);
  const expectedChainId = eip155ChainIdOf(chainId);
  const node = transportFor(nodeUrl);
  const reported = await new NodeClient(node).chainId();
  if (reported !== expectedChainId) {
    throw new Error(
      `The RPC endpoint is chain id ${reported}, expected ${expectedChainId}; the Kernel ` +
        'deployment is verified through it, so check the endpoint first.',
    );
  }
  const check = await verifyKernelDeployment(node, {
    factory: validated.normalized,
    implementation: KERNEL_PREFILL.implementation,
    metaFactory: KERNEL_PREFILL.metaFactory,
    ecdsaValidator: KERNEL_PREFILL.ecdsaValidator,
    entryPoint: ENTRYPOINT_V07,
    expectedAccountId: KERNEL_PREFILL.accountId,
  });
  const map = await loadConfigMap(store);
  map[chainId] = {
    ...map[chainId],
    accountType: 'kernel-v3.3',
    factory: validated.normalized,
    factoryImplementation: toChecksumAddress(toBytes(check.implementation)),
    factoryVerifiedAt: new Date().toISOString(),
    kernelMetaFactory: KERNEL_PREFILL.metaFactory,
    kernelValidator: KERNEL_PREFILL.ecdsaValidator,
    kernelAccountId: check.accountId,
  };
  await saveConfigMap(map, store);
  return { implementation: check.implementation, accountId: check.accountId };
}

/** Removes the stored bundler URL for one chain. */
export async function clearAaBundlerUrl(
  chainId: string,
  store: KeyValueStore = AsyncStorage,
): Promise<void> {
  const map = await loadConfigMap(store);
  if (map[chainId]) {
    delete map[chainId]!.bundlerUrl;
    delete map[chainId]!.bundlerVerifiedAt;
    await saveConfigMap(map, store);
  }
}

/** Removes the stored factory (and its verification record) for one chain. */
export async function clearAaFactory(
  chainId: string,
  store: KeyValueStore = AsyncStorage,
): Promise<void> {
  const map = await loadConfigMap(store);
  if (map[chainId]) {
    delete map[chainId]!.accountType;
    delete map[chainId]!.factory;
    delete map[chainId]!.factoryImplementation;
    delete map[chainId]!.factoryVerifiedAt;
    delete map[chainId]!.kernelMetaFactory;
    delete map[chainId]!.kernelValidator;
    delete map[chainId]!.kernelAccountId;
    await saveConfigMap(map, store);
  }
}

/**
 * Records (enabled) or removes (disabled) an owner EOA as upgraded with
 * EIP-7702 for smart-account sends on one chain. Called only by the
 * "Upgrade this account" flow: "Upgrade with the next smart-account send",
 * a confirmed "Upgrade now" transaction, a revocation, or cancelling a
 * pending upgrade. Signs nothing. Removing the owner restores the chain's
 * factory type for that account (the fields were never touched).
 */
export async function setAccountEip7702(
  chainId: string,
  owner: string,
  enabled: boolean,
  store: KeyValueStore = AsyncStorage,
): Promise<AaChainConfig> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(owner)) throw new Error(`Not an EVM address: ${owner}`);
  eip155ChainIdOf(chainId);
  // Mainnet readiness: recording an upgrade is refused where the upgrade is
  // not allowed; removing one (cancel or revoke) always works.
  if (enabled) assertFeatureAllowed('eip7702-upgrade', chainId);
  const map = await loadConfigMap(store);
  if (enabled && recoveredAccountFor(normalizeEntry(map[chainId], chainId), owner)) {
    // One smart account per owner and chain: an owner that controls a
    // recovered Kernel account keeps using it.
    throw new Error(RECOVERED_7702_CONFLICT);
  }
  const current = normalizeEntry(map[chainId], chainId).eip7702Owners.filter(
    (a) => a.toLowerCase() !== owner.toLowerCase(),
  );
  map[chainId] = {
    ...map[chainId],
    eip7702Owners: enabled ? [...current, toChecksumAddress(toBytes(owner.toLowerCase()))] : current,
  };
  await saveConfigMap(map, store);
  return normalizeEntry(map[chainId], chainId);
}

/** Refusal when one owner would get both a 7702 upgrade and a recovered account. */
export const RECOVERED_7702_CONFLICT =
  'This account already controls a recovered Kernel account on this network, and smart-account ' +
  'sends from it use that account. An account can use one smart account per network: use another ' +
  'account for the EIP-7702 upgrade, or for the recovered account.';

/**
 * Attaches (account = an address) or detaches (account = null) the
 * recovered Kernel account of one owner EOA on one chain. Signs nothing and
 * reads nothing: it MUST be called only by ./recovery.ts after the engine's
 * verifyKernelAccountForOwner confirmed on-chain that `owner` is the
 * account's current root owner (the "Use this recovered account" rule).
 * Refuses an owner that is upgraded with EIP-7702 on this chain.
 */
export async function setRecoveredAccount(
  chainId: string,
  owner: string,
  account: string | null,
  store: KeyValueStore = AsyncStorage,
): Promise<AaChainConfig> {
  if (!ADDRESS_PATTERN.test(owner)) throw new Error(`Not an EVM address: ${owner}`);
  if (account !== null && !ADDRESS_PATTERN.test(account)) throw new Error(`Not an EVM address: ${account}`);
  eip155ChainIdOf(chainId);
  const map = await loadConfigMap(store);
  const entry = normalizeEntry(map[chainId], chainId);
  if (account !== null && isEip7702Owner(entry, owner)) throw new Error(RECOVERED_7702_CONFLICT);
  const others = entry.recoveredAccounts.filter((l) => l.owner.toLowerCase() !== owner.toLowerCase());
  map[chainId] = {
    ...map[chainId],
    recoveredAccounts:
      account === null
        ? others
        : [
            ...others,
            {
              owner: toChecksumAddress(toBytes(owner.toLowerCase())),
              account: toChecksumAddress(toBytes(account.toLowerCase())),
              attachedAt: new Date().toISOString(),
            },
          ],
  };
  await saveConfigMap(map, store);
  return normalizeEntry(map[chainId], chainId);
}

/**
 * Refusal when the new owner of an owner rotation already has a different
 * recovered Kernel account attached on this chain (one smart account per
 * owner and chain).
 */
export const ROTATION_TARGET_HAS_OTHER_ACCOUNT =
  'That account already uses another recovered Kernel account on this network, and an account can ' +
  'use one smart account per network. Choose another account as the new owner, or detach the other ' +
  'recovered account first.';

/**
 * Moves a Kernel account's attachment after an owner rotation (phase 8
 * follow-up: the in-app "Change owner" flow), in ONE storage write:
 *  - the previous owner's link is removed when it pointed at `account`
 *    (its key no longer signs for it);
 *  - when `attach` is true, `to` gets the link (the address is not the
 *    CREATE2 result of `to`); when false, `to` derives the address from the
 *    seed by itself, so a link of `to` to this same account is removed.
 * Signs nothing and reads nothing: it MUST be called only by ./recovery.ts
 * after the engine's verifyKernelAccountForOwner confirmed on-chain that
 * `to` is the account's current root owner. Refuses (writing nothing) to
 * attach to an owner upgraded with EIP-7702 on this chain, or to one that
 * already has a different recovered account attached.
 */
export async function moveRecoveredAccountLink(
  chainId: string,
  args: { account: string; from: string; to: string; attach: boolean },
  store: KeyValueStore = AsyncStorage,
): Promise<AaChainConfig> {
  for (const a of [args.account, args.from, args.to]) {
    if (!ADDRESS_PATTERN.test(a)) throw new Error(`Not an EVM address: ${a}`);
  }
  eip155ChainIdOf(chainId);
  const map = await loadConfigMap(store);
  const entry = normalizeEntry(map[chainId], chainId);
  const lower = (a: string) => a.toLowerCase();
  const existingTo = recoveredAccountFor(entry, args.to);
  if (args.attach) {
    if (isEip7702Owner(entry, args.to)) throw new Error(RECOVERED_7702_CONFLICT);
    if (existingTo !== null && lower(existingTo) !== lower(args.account)) throw new Error(ROTATION_TARGET_HAS_OTHER_ACCOUNT);
  }
  const kept = entry.recoveredAccounts.filter((l) => {
    const pointsHere = lower(l.account) === lower(args.account);
    if (pointsHere && lower(l.owner) === lower(args.from)) return false;
    if (lower(l.owner) === lower(args.to) && pointsHere) return false;
    return true;
  });
  map[chainId] = {
    ...map[chainId],
    recoveredAccounts: args.attach
      ? [
          ...kept,
          {
            owner: toChecksumAddress(toBytes(lower(args.to))),
            account: toChecksumAddress(toBytes(lower(args.account))),
            attachedAt: new Date().toISOString(),
          },
        ]
      : kept,
  };
  await saveConfigMap(map, store);
  return normalizeEntry(map[chainId], chainId);
}

/** Wipe support: detaches every recovered account on every chain. */
export async function clearAllRecoveredAccounts(store: KeyValueStore = AsyncStorage): Promise<void> {
  const map = await loadConfigMap(store);
  let changed = false;
  for (const key of Object.keys(map)) {
    if (map[key]?.recoveredAccounts !== undefined) {
      delete map[key]!.recoveredAccounts;
      changed = true;
    }
  }
  if (changed) await saveConfigMap(map, store);
}

// ---------------------------------------------------------------------------
// Client construction and the AA send path
// ---------------------------------------------------------------------------

/**
 * Probes an ERC-7677 paymaster endpoint with a well-formed
 * pm_getPaymasterStubData request for a dummy operation. ACCEPTED: a
 * JSON-RPC result, or a STRUCTURED JSON-RPC error other than
 * method-not-found — real paymasters commonly reject a dummy op with a
 * policy error, which still proves the endpoint speaks the 7677
 * namespace. REJECTED: transport failures, non-JSON, or -32601
 * (method not found: not a paymaster endpoint).
 */
export async function verifyAaPaymaster(
  paymaster: JsonRpcTransport,
  chainId: bigint,
  context: unknown,
): Promise<void> {
  const dummyOp = {
    sender: '0x' + '11'.repeat(20),
    nonce: '0x0',
    callData: '0x',
    callGasLimit: '0x0',
    verificationGasLimit: '0x0',
    preVerificationGas: '0x0',
    maxFeePerGas: '0x0',
    maxPriorityFeePerGas: '0x0',
    signature: '0x' + '00'.repeat(65),
  };
  try {
    await paymaster('pm_getPaymasterStubData', [
      dummyOp,
      ENTRYPOINT_V07,
      '0x' + chainId.toString(16),
      context ?? null,
    ]);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/-32601|method not found/i.test(message)) {
      throw new Error(
        'The endpoint answered but does not serve pm_getPaymasterStubData — not an ERC-7677 paymaster.',
      );
    }
    if (/^RPC error /.test(message)) {
      // Structured JSON-RPC error (e.g. a policy rejection of the dummy
      // op): the endpoint speaks the namespace. Accept.
      return;
    }
    throw new Error(`Paymaster endpoint unreachable or not JSON-RPC: ${message}`);
  }
}

/**
 * Saves the paymaster endpoint (and optional vendor context JSON) for one
 * chain after the probe above. Throws, persisting nothing, on any failure
 * — including context that is not valid JSON.
 */
export async function setAaPaymaster(
  chainId: string,
  url: string,
  contextJson: string,
  options: { store?: KeyValueStore; transportFor?: TransportFactory } = {},
): Promise<void> {
  // Mainnet readiness: refused before any request, persisting nothing.
  assertFeatureAllowed('paymaster', chainId);
  const store = options.store ?? AsyncStorage;
  const transportFor = options.transportFor ?? httpTransport;
  const trimmed = assertSecureEndpointUrl(url);
  const contextTrimmed = contextJson.trim();
  let context: unknown = null;
  if (contextTrimmed !== '') {
    try {
      context = JSON.parse(contextTrimmed);
    } catch {
      throw new Error('Paymaster context must be valid JSON (or left empty).');
    }
  }
  // The chain being configured (previously this always sent mainnet's id,
  // even when saving a Sepolia paymaster).
  const numericChainId = eip155ChainIdOf(chainId);
  await verifyAaPaymaster(transportFor(trimmed), numericChainId, context);
  const map = await loadConfigMap(store);
  map[chainId] = {
    ...map[chainId],
    paymasterUrl: trimmed,
    paymasterContext: contextTrimmed === '' ? null : contextTrimmed,
    paymasterVerifiedAt: new Date().toISOString(),
  };
  await saveConfigMap(map, store);
}

/**
 * Extra verificationGasLimit for a self-paid smart-account operation whose
 * account must top up its EntryPoint deposit during validation (the
 * engine's SmartAccountClientConfig.depositTopUpVerificationGas; applied
 * only when the deposit is below the operation's required prefund).
 *
 * Found live on 2026-10-02: the in-app "Change owner" on the emulator was
 * refused by Alchemy's bundler with -32502 "Simulation ran out of gas for
 * entity: account" although eth_estimateUserOperationGas had passed.
 * Rundler (Alchemy's bundler) estimates verification gas with the fees
 * zeroed, so the account's deposit top-up is not in its estimate; when the
 * real fees require a top-up, its send-time simulation flags the account.
 * Measured on Sepolia with a Kernel v3.3 account (the failure is not
 * specific to owner changes — a plain 0-value call failed the same way):
 * refused at 91,249 (the ZeroDev/Pimlico estimate) and 113,373 (Alchemy's
 * own estimate) while a top-up was needed; accepted at 125,000, 150,000 and
 * 190,000 with a top-up, and at 91,249 without one. 40,000 lifts both
 * estimates past the highest refused value with margin (131,249 /
 * 153,373) while staying under Rundler's verification-gas efficiency floor
 * (used / limit >= 0.4; the measured use with a top-up was about 77,600
 * gas). It is a measured judgement for Kernel v3.3 on these bundlers, not a
 * standard value. Unused verification gas is not charged (EntryPoint
 * v0.7's 10 percent penalty covers only call and postOp gas), so it raises
 * only the worst-case prefund the account must hold.
 */
export const AA_DEPOSIT_TOPUP_VERIFICATION_GAS = 40_000n;

/** Removes the paymaster configuration; sends go back to self-paid gas. */
export async function clearAaPaymaster(
  chainId: string,
  store: KeyValueStore = AsyncStorage,
): Promise<void> {
  const map = await loadConfigMap(store);
  if (map[chainId]) {
    delete map[chainId]!.paymasterUrl;
    delete map[chainId]!.paymasterContext;
    delete map[chainId]!.paymasterVerifiedAt;
    await saveConfigMap(map, store);
  }
}

export interface AaClientBundle {
  client: SmartAccountClient;
  spec: SmartAccountSpec;
  node: JsonRpcTransport;
  bundler: JsonRpcTransport;
  chainId: bigint;
  /** True when an ERC-7677 paymaster is configured on this bundle. */
  sponsored: boolean;
  /** The implementation this bundle's spec builds operations for. */
  accountType: AaAccountType;
  /**
   * The configured factory (SimpleAccountFactory or KernelFactory). For
   * 'kernel-7702' there is no factory: this is the delegate address.
   */
  factory: string;
  /** Wallet account index = CREATE2 salt (unused by 'kernel-7702'). */
  accountIndex: number;
  /**
   * 'kernel-7702' only. `gate.allowAuthorization` is the D6 switch: the
   * spec refuses to sign an authorization tuple unless sendAa opened it for
   * a quote that announced the upgrade on the confirm screen.
   */
  eip7702?: { delegate: string; gate: { allowAuthorization: boolean } };
  /**
   * Kernel bundles: the deployment addresses the spec was built with (used
   * to start the account's recovery record, ./recovery.ts).
   */
  kernel?: AaKernelAddresses;
  /**
   * Set for a recovered Kernel account (phase 8 item 4): the attached
   * address, which is not derivable from the owner's seed. The spec is the
   * engine's kernelRecoveredAccountSpec.
   */
  recovered?: { account: string };
}

/**
 * Dummy authorization signature used ONLY for gas estimation of an
 * operation that will carry a tuple, so no key is needed at quote time (the
 * real tuple is signed after the biometric gate). The values are viem
 * 2.57.2's, account-abstraction/actions/bundler/prepareUserOperation.ts
 * (r = 0xffff…f000…0, s = 0x7aaa…a, yParity 1), which the ZeroDev SDK goes
 * through for its estimates. s is below secp256k1n/2.
 */
export const EIP7702_STUB_R = '0xfffffffffffffffffffffffffffffff000000000000000000000000000000000';
export const EIP7702_STUB_S = '0x7aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

export function stubEip7702Authorization(
  chainId: bigint,
  delegate: string,
  nonce: bigint,
): SignedEip7702Authorization {
  return {
    chainId,
    address: delegate,
    nonce,
    yParity: 1,
    r: toBytes(EIP7702_STUB_R),
    s: toBytes(EIP7702_STUB_S),
  };
}

/** Refusal when an authorization would be signed outside an announced upgrade (D6). */
export const EIP7702_UNANNOUNCED_REFUSAL =
  'EIP-7702 policy: signing this operation would also upgrade the account, but the upgrade was ' +
  'not shown when it was reviewed. Nothing was signed; review it again.';

/** Kernel-specific deployment addresses (all verified at save time). */
export interface AaKernelAddresses {
  metaFactory: string | null;
  implementation: string;
  ecdsaValidator: string;
}

/**
 * Builds the SmartAccountClient stack for one chain from verified
 * configuration.
 *
 * CREATE2 salt = the wallet account index (docs/ARCHITECTURE.md section
 * 3.1 and ADR D8): account N's smart account is
 * factory.getAddress(owner = account N's EOA, salt = N). Account 0 uses
 * salt 0 — exactly the SimpleAccount spec's default that every version of
 * this app used before multiple accounts existed — so its counterfactual
 * address is unchanged. Omitting accountIndex means account 0. For Kernel
 * the same index becomes the bytes32 salt (the ZeroDev SDK convention the
 * engine follows), and the engine's spec refuses any factory answer that
 * differs from its local CREATE2 prediction.
 */
export function createAaClient(options: {
  nodeUrl: string;
  bundlerUrl: string;
  factory: string;
  chainId?: bigint;
  /** Wallet account index; also the CREATE2 salt. Defaults to 0. */
  accountIndex?: number;
  transportFor?: TransportFactory;
  /** Verified ERC-7677 paymaster configuration, when sponsorship is on. */
  paymaster?: { url: string; contextJson: string | null };
  /** Defaults to 'simple' (the historical behavior). */
  accountType?: AaAccountType;
  /** Kernel deployment addresses; defaults to the pinned KERNEL_V3_3 values. */
  kernel?: Partial<AaKernelAddresses>;
  /**
   * A recovered Kernel v3.3 account attached to the owner (accountType must
   * be 'kernel-v3.3'): the spec becomes the engine's
   * kernelRecoveredAccountSpec for this address.
   */
  recoveredAccount?: string;
}): AaClientBundle {
  if (options.accountType === 'kernel-7702') return createKernel7702Bundle(options);
  const transportFor = options.transportFor ?? httpTransport;
  const node = transportFor(options.nodeUrl);
  const bundler = transportFor(options.bundlerUrl);
  const chainId = options.chainId ?? BigInt(EVM_CHAIN_ID.split(':')[1]!);
  const accountIndex = options.accountIndex ?? 0;
  if (!Number.isSafeInteger(accountIndex) || accountIndex < 0) {
    throw new Error(`Invalid account index ${String(options.accountIndex)}.`);
  }
  const accountType = options.accountType ?? 'simple';
  if (options.recoveredAccount !== undefined && accountType !== 'kernel-v3.3') {
    throw new Error('A recovered account is a Kernel v3.3 account.');
  }
  const kernelAddresses: AaKernelAddresses = {
    metaFactory:
      options.kernel?.metaFactory === undefined ? KERNEL_PREFILL.metaFactory : options.kernel.metaFactory,
    implementation: options.kernel?.implementation ?? KERNEL_PREFILL.implementation,
    ecdsaValidator: options.kernel?.ecdsaValidator ?? KERNEL_PREFILL.ecdsaValidator,
  };
  const spec =
    accountType === 'kernel-v3.3'
      ? options.recoveredAccount !== undefined
        ? // The engine's spec returns the stored address only after reading
          // the ECDSA validator's owner and checking it is the signing key.
          kernelRecoveredAccountSpec({
            node,
            account: options.recoveredAccount,
            ecdsaValidator: kernelAddresses.ecdsaValidator,
          })
        : createKernelAccountSpec({
            node,
            index: BigInt(accountIndex),
            factory: options.factory,
            implementation: kernelAddresses.implementation,
            metaFactory: kernelAddresses.metaFactory,
            ecdsaValidator: kernelAddresses.ecdsaValidator,
          })
      : createSimpleAccountSpec({
          factory: options.factory,
          node,
          salt: BigInt(accountIndex),
        });
  // Context was validated as JSON at save time; a parse failure here
  // degrades to null rather than blocking sends.
  let paymasterContext: unknown = null;
  if (options.paymaster?.contextJson) {
    try {
      paymasterContext = JSON.parse(options.paymaster.contextJson);
    } catch {
      paymasterContext = null;
    }
  }
  const paymasterTransport = options.paymaster ? transportFor(options.paymaster.url) : undefined;
  const client = new SmartAccountClient({
    chainId,
    entryPoint: ENTRYPOINT_V07,
    bundler,
    node,
    spec,
    depositTopUpVerificationGas: AA_DEPOSIT_TOPUP_VERIFICATION_GAS,
    ...(paymasterTransport
      ? { paymaster: { transport: paymasterTransport, context: paymasterContext } }
      : {}),
  });
  return {
    client,
    spec,
    node,
    bundler,
    chainId,
    sponsored: paymasterTransport !== undefined,
    accountType,
    factory: options.factory,
    accountIndex,
    ...(accountType === 'kernel-v3.3' ? { kernel: kernelAddresses } : {}),
    ...(options.recoveredAccount !== undefined
      ? { recovered: { account: toChecksumAddress(toBytes(options.recoveredAccount.toLowerCase())) } }
      : {}),
  };
}

/**
 * The 'kernel-7702' bundle: the engine's createKernel7702AccountSpec for the
 * ACTIVE chain id (the engine checks eth_chainId against it before signing
 * a tuple, and refuses chain id 0) and the pinned delegate (the engine's
 * default, KERNEL_V3_3_7702_DELEGATE; redelegation from a foreign delegate
 * stays refused — allowRedelegation is never set). The spec is wrapped so
 * it signs a tuple only while sendAa holds the gate open for a quote that
 * announced the upgrade (D6).
 */
function createKernel7702Bundle(options: {
  nodeUrl: string;
  bundlerUrl: string;
  chainId?: bigint;
  accountIndex?: number;
  transportFor?: TransportFactory;
  paymaster?: { url: string; contextJson: string | null };
}): AaClientBundle {
  const transportFor = options.transportFor ?? httpTransport;
  const node = transportFor(options.nodeUrl);
  const bundler = transportFor(options.bundlerUrl);
  const chainId = options.chainId ?? BigInt(EVM_CHAIN_ID.split(':')[1]!);
  const delegate = KERNEL_V3_3_7702_DELEGATE;
  assertWalletDelegate(delegate);
  const engineSpec = createKernel7702AccountSpec({ node, chainId });
  const gate = { allowAuthorization: false };
  const spec: SmartAccountSpec = {
    ...engineSpec,
    async getEip7702Authorization(owner: DerivedAccount) {
      const status = await readDelegationStatus(node, owner.address);
      if (status.kind === 'none' && !gate.allowAuthorization) {
        throw new Error(EIP7702_UNANNOUNCED_REFUSAL);
      }
      return engineSpec.getEip7702Authorization!(owner);
    },
  };
  let paymasterContext: unknown = null;
  if (options.paymaster?.contextJson) {
    try {
      paymasterContext = JSON.parse(options.paymaster.contextJson);
    } catch {
      paymasterContext = null;
    }
  }
  const paymasterTransport = options.paymaster ? transportFor(options.paymaster.url) : undefined;
  const client = new SmartAccountClient({
    chainId,
    entryPoint: ENTRYPOINT_V07,
    bundler,
    node,
    spec,
    depositTopUpVerificationGas: AA_DEPOSIT_TOPUP_VERIFICATION_GAS,
    ...(paymasterTransport
      ? { paymaster: { transport: paymasterTransport, context: paymasterContext } }
      : {}),
  });
  return {
    client,
    spec,
    node,
    bundler,
    chainId,
    sponsored: paymasterTransport !== undefined,
    accountType: 'kernel-7702',
    factory: delegate,
    accountIndex: options.accountIndex ?? 0,
    eip7702: { delegate, gate },
  };
}

/**
 * createAaClient from a stored (= verified) configuration: the one place the
 * screens and the WalletConnect provider turn AaChainConfig into a bundle,
 * so the account type, Kernel addresses and paymaster are always threaded
 * through identically. Throws when the configuration is incomplete.
 */
export function createAaClientFromConfig(
  config: AaChainConfig,
  options: {
    nodeUrl: string;
    chainId: bigint;
    accountIndex: number;
    /**
     * The owner EOA. When it was upgraded with EIP-7702 on this chain
     * (eip7702Owners), the bundle is 'kernel-7702'; when a recovered Kernel
     * account is attached to it (recoveredAccounts), the bundle uses that
     * account; otherwise, or when omitted, the chain's factory type.
     * WalletConnect smart-account
     * connections omit it on purpose: they never run the 7702 path, so a
     * dApp session can never cause an authorization to be signed (D6).
     */
    ownerAddress?: string;
    transportFor?: TransportFactory;
  },
): AaClientBundle {
  if (isEip7702Owner(config, options.ownerAddress)) {
    if (!config.bundlerUrl) {
      throw new Error('No bundler is configured for this network (Settings → Account Abstraction).');
    }
    return createAaClient({
      nodeUrl: options.nodeUrl,
      bundlerUrl: config.bundlerUrl,
      factory: KERNEL_V3_3_7702_DELEGATE,
      chainId: options.chainId,
      accountIndex: options.accountIndex,
      accountType: 'kernel-7702',
      ...(config.paymasterUrl
        ? { paymaster: { url: config.paymasterUrl, contextJson: config.paymasterContext } }
        : {}),
      ...(options.transportFor ? { transportFor: options.transportFor } : {}),
    });
  }
  const recovered = recoveredAccountFor(config, options.ownerAddress);
  if (recovered) {
    if (!config.bundlerUrl) {
      throw new Error('No bundler is configured for this network (Settings → Account Abstraction).');
    }
    return createAaClient({
      nodeUrl: options.nodeUrl,
      bundlerUrl: config.bundlerUrl,
      factory: config.factory ?? KERNEL_PREFILL.factory,
      chainId: options.chainId,
      accountIndex: options.accountIndex,
      accountType: 'kernel-v3.3',
      recoveredAccount: recovered,
      kernel: {
        metaFactory: KERNEL_PREFILL.metaFactory,
        implementation: KERNEL_PREFILL.implementation,
        ecdsaValidator: KERNEL_PREFILL.ecdsaValidator,
      },
      ...(config.paymasterUrl
        ? { paymaster: { url: config.paymasterUrl, contextJson: config.paymasterContext } }
        : {}),
      ...(options.transportFor ? { transportFor: options.transportFor } : {}),
    });
  }
  if (!hasCompleteAaSettings(config) || !config.bundlerUrl || !config.factory) {
    throw new Error('Smart-account settings are incomplete for this network (Settings → Account Abstraction).');
  }
  return createAaClient({
    nodeUrl: options.nodeUrl,
    bundlerUrl: config.bundlerUrl,
    factory: config.factory,
    chainId: options.chainId,
    accountIndex: options.accountIndex,
    accountType: config.accountType,
    ...(config.accountType === 'kernel-v3.3'
      ? {
          kernel: {
            metaFactory: config.kernelMetaFactory,
            implementation: config.factoryImplementation ?? KERNEL_PREFILL.implementation,
            ecdsaValidator: config.kernelValidator ?? KERNEL_PREFILL.ecdsaValidator,
          },
        }
      : {}),
    ...(config.paymasterUrl
      ? { paymaster: { url: config.paymasterUrl, contextJson: config.paymasterContext } }
      : {}),
    ...(options.transportFor ? { transportFor: options.transportFor } : {}),
  });
}

/**
 * A DerivedAccount stand-in carrying only the owner's public address, for
 * quote-time work (counterfactual address, nonce, gas estimation with the
 * spec's stub signature). It cannot sign, so no key material is ever
 * resident while the user reads the confirm screen; the real signer is
 * re-derived through WalletContext.signWith only for the final send.
 */
export function addressOnlyOwner(address: string): DerivedAccount {
  return {
    chainId: EVM_CHAIN_ID,
    path: '',
    publicKey: new Uint8Array(0),
    address,
    sign: () => {
      throw new Error('Quote-time owner cannot sign; use signWith for the real send.');
    },
  };
}

/** The smart-account address (counterfactual or deployed) for an owner EOA. */
export function resolveAaSender(bundle: AaClientBundle, ownerAddress: string): Promise<string> {
  return bundle.client.getAddress(addressOnlyOwner(ownerAddress));
}

/** ERC-20 balanceOf(owner) through the bundle's node transport. */
export async function fetchTokenBalanceVia(
  node: JsonRpcTransport,
  contract: string,
  owner: string,
): Promise<bigint> {
  const result = (await node('eth_call', [
    { to: contract, data: toHex(encodeErc20BalanceOf(owner)) },
    'latest',
  ])) as string;
  return decodeUint256(result);
}

/** A token the quoted operation spends from the smart account. */
export interface AaTokenSpend {
  contract: string;
  amount: bigint;
  symbol: string;
}

/** Token-send details for display (smart-account ERC-20 sends). */
export interface AaTokenTransfer {
  contract: string;
  /** Final token recipient (the transfer() argument). */
  recipient: string;
  amount: bigint;
  symbol: string;
  decimals: number;
}

export interface AaSendQuote {
  kind: 'aa';
  /**
   * The deposit top-up headroom already included in verificationGasLimit
   * (0 when the account's EntryPoint deposit covers the prefund, when a
   * paymaster sponsors the operation, or when the deposit could not be
   * read). Wrappers that pad the limits again must pad the estimate
   * without this margin and add it back, as the engine does.
   */
  depositTopUpHeadroom?: bigint;
  /**
   * Every call of the operation, in execution order. One call is encoded as
   * the account's single execute; several as one atomic batch (Kernel
   * ERC-7579 batch mode / SimpleAccount executeBatch — either way the whole
   * operation reverts if any call reverts).
   */
  calls: Call[];
  /** Display: the primary target (recipient of a plain send). */
  to: string;
  /** Total native value the calls send out of the smart account. */
  amount: bigint;
  /** Counterfactual (or deployed) smart-account address — the sender. */
  sender: string;
  /** The smart account's own balance; it pays amount + gas itself. */
  senderBalance: bigint;
  /** False means this send deploys the account (factory args included). */
  deployed: boolean;
  /** Bundler gas estimate for the operation. */
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** Worst case: (sum of the three gas limits) × maxFeePerGas. */
  fee: bigint;
  total: bigint;
  /** True when an ERC-7677 paymaster sponsors the gas (user fee = 0). */
  sponsored: boolean;
  accountType: AaAccountType;
  /** Present when the operation spends a token: the smart account's balance. */
  tokenSpend?: AaTokenSpend & { balance: bigint };
  /** Present for a smart-account ERC-20 send. */
  token?: AaTokenTransfer;
  /**
   * 'kernel-7702' only. upgrade = true means the account is still a plain
   * EOA and THIS operation carries the EIP-7702 authorization (the confirm
   * screen must say so); false means it is already delegated to `delegate`.
   */
  eip7702?: { upgrade: boolean; delegate: string };
  /**
   * True when the sender is a RECOVERED Kernel account (phase 8 item 4):
   * its address is not derivable from the owner's seed, and the confirm
   * screens say so.
   */
  recovered?: boolean;
  /**
   * True when the operation is signed by the account's PASSKEY (phase 8
   * item 3, ./passkeys.ts preparePasskeyCalls): the passkey nonce key and
   * stub signature were used for the estimate, and only sendPasskeyCalls may
   * submit it. sendAa (the owner-key path) refuses such a quote.
   */
  passkey?: boolean;
}

/** Convenience alias: a quote for any list of calls. */
export type AaCallsQuote = AaSendQuote;

/**
 * Builds the AA quote for any list of calls: verifies the node endpoint's
 * chain id, resolves the counterfactual sender via the spec's getAddress,
 * reads its native (and, for token spends, token) balance and deployment
 * state, and prices the operation with the bundler's
 * eth_estimateUserOperationGas over a stub-signed UserOperation shaped
 * exactly like the one SmartAccountClient.sendCalls will submit.
 *
 * The bundler estimate is the AA path's pre-flight gate: bundlers simulate
 * the operation (validation and execution) to estimate it, so a call that
 * would revert makes this throw with the bundler's own message, and no
 * confirm screen is shown.
 */
export async function prepareAaCalls(
  bundle: AaClientBundle,
  ownerAddress: string,
  calls: Call[],
  options: { tokenSpend?: AaTokenSpend; displayTo?: string; token?: AaTokenTransfer } = {},
): Promise<AaSendQuote> {
  if (calls.length === 0) throw new Error('Nothing to send: the operation has no calls.');
  const nodeClient = new NodeClient(bundle.node);
  const chainId = await nodeClient.chainId();
  if (chainId !== bundle.chainId) {
    throw new Error(
      `Endpoint is chain id ${chainId}, expected ${bundle.chainId}. ` +
        'Check the RPC endpoint in Settings.',
    );
  }

  const owner = addressOnlyOwner(ownerAddress);
  const sender = await bundle.client.getAddress(owner);
  // EIP-7702 account: "deployed" means delegated to the wallet's Kernel
  // delegate; a plain EOA gets the tuple on this operation (first op only).
  let eip7702: AaSendQuote['eip7702'];
  if (bundle.eip7702) {
    const status = await readDelegationStatus(bundle.node, sender);
    if (status.kind === 'contract') {
      throw new Error(`${sender} holds contract code that is not an EIP-7702 delegation.`);
    }
    if (status.kind === 'delegated' && status.delegate.toLowerCase() !== bundle.eip7702.delegate.toLowerCase()) {
      throw new Error(
        `This account is delegated to ${status.delegate}, not the wallet's Kernel delegate ` +
          `${bundle.eip7702.delegate}. The wallet does not replace another delegation; revoke it ` +
          'first (Upgrade this account → Revoke).',
      );
    }
    eip7702 = { upgrade: status.kind === 'none', delegate: bundle.eip7702.delegate };
  }
  const [senderBalance, deployed, nonce, suggestedFees, tokenBalance, priorityFloor] =
    await Promise.all([
      nodeClient.getBalance(sender),
      eip7702 ? Promise.resolve(!eip7702.upgrade) : bundle.client.isDeployed(owner),
      bundle.client.getNonce(owner),
      nodeClient.suggestFees(),
      options.tokenSpend
        ? fetchTokenBalanceVia(bundle.node, options.tokenSpend.contract, sender)
        : Promise.resolve(null),
      bundlerPriorityFeeFloor(bundle.bundler),
    ]);
  const fees = applyPriorityFeeFloor(suggestedFees, priorityFloor);

  if (options.tokenSpend && tokenBalance !== null && options.tokenSpend.amount > tokenBalance) {
    throw new Error(
      `Sending ${options.tokenSpend.amount} base units of ${options.tokenSpend.symbol} exceeds ` +
        `the token balance of ${tokenBalance} base units held by the smart account ${sender}. ` +
        'Smart-account sends spend the smart account’s tokens, not the owner address’s.',
    );
  }

  const factoryArgs = deployed || eip7702 ? undefined : await bundle.spec.getFactoryArgs(owner);
  // The tuple travels only while the account is still plain. For the
  // estimate it is the dummy-signed stub (viem's values); the authority's
  // nonce is its current one, because the bundler's transaction carries it.
  const stubAuth =
    eip7702?.upgrade === true
      ? stubEip7702Authorization(
          bundle.chainId,
          eip7702.delegate,
          BigInt((await bundle.node('eth_getTransactionCount', [sender, 'pending'])) as string),
        )
      : undefined;
  const op: UserOperation = {
    sender,
    nonce,
    ...(factoryArgs
      ? { factory: factoryArgs.factory, factoryData: factoryArgs.factoryData }
      : {}),
    callData: bundle.spec.encodeCalls(calls),
    callGasLimit: 0n,
    verificationGasLimit: 0n,
    preVerificationGas: 0n,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    signature: bundle.spec.stubSignature(),
    ...(stubAuth ? { eip7702Auth: stubAuth } : {}),
  };
  const estimated = await new BundlerClient(bundle.bundler, ENTRYPOINT_V07).estimateUserOperationGas(op);
  // Mirror the bundle client's deposit top-up headroom so the confirm
  // screen's worst-case fee and the balance check use the limit that will
  // actually be signed (sendCalls re-estimates and applies the same rule,
  // and, like here, keeps the plain estimate when the deposit read fails).
  // Clients built without the headroom (none configured) are mirrored as
  // such: no deposit read, the plain estimate.
  const headroom = bundle.client.depositTopUpVerificationGas;
  const deposit =
    bundle.sponsored || headroom === 0n
      ? null
      : await bundle.client.getEntryPointDeposit(sender).catch(() => null);
  const gas = deposit === null
    ? estimated
    : {
        ...estimated,
        verificationGasLimit: withDepositTopUpHeadroom(
          {
            ...op,
            callGasLimit: estimated.callGasLimit,
            verificationGasLimit: estimated.verificationGasLimit,
            preVerificationGas: estimated.preVerificationGas,
          },
          deposit,
          headroom,
        ),
      };

  const amount = calls.reduce((sum, c) => sum + c.value, 0n);
  const gasTotal = gas.callGasLimit + gas.verificationGasLimit + gas.preVerificationGas;
  const worstCaseGasCost = gasTotal * fees.maxFeePerGas;
  // With a paymaster the sponsor pays the gas: the account only needs to
  // cover the amount itself. Self-paid keeps the full worst-case check.
  const fee = bundle.sponsored ? 0n : worstCaseGasCost;
  if (amount + fee > senderBalance) {
    throw new Error(
      bundle.sponsored
        ? `Insufficient funds: sending ${amount} wei exceeds the smart account's ` +
          `balance of ${senderBalance} wei (gas is sponsored, but the amount is not).`
        : `Insufficient funds: the smart account pays its own gas (no paymaster), and sending ` +
          `${amount} wei plus a worst-case fee of ${fee} wei exceeds its balance of ` +
          `${senderBalance} wei. Fund the smart account address, not the owner address.`,
    );
  }

  return {
    kind: 'aa',
    calls,
    to: options.displayTo ?? calls[0]!.to,
    amount,
    sender,
    senderBalance,
    deployed,
    callGasLimit: gas.callGasLimit,
    verificationGasLimit: gas.verificationGasLimit,
    depositTopUpHeadroom: gas.verificationGasLimit - estimated.verificationGasLimit,
    preVerificationGas: gas.preVerificationGas,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    fee,
    total: amount + fee,
    sponsored: bundle.sponsored,
    accountType: bundle.accountType,
    ...(options.tokenSpend && tokenBalance !== null
      ? { tokenSpend: { ...options.tokenSpend, balance: tokenBalance } }
      : {}),
    ...(options.token ? { token: options.token } : {}),
    ...(eip7702 ? { eip7702 } : {}),
    ...(bundle.recovered ? { recovered: true } : {}),
  };
}

/** The confirm-screen label of the smart-account sender row. */
export function aaSenderLabel(quote: Pick<AaSendQuote, 'eip7702' | 'recovered'>): string {
  if (quote.eip7702) return 'From (your own address)';
  if (quote.recovered) return 'From recovered smart account (not found from your recovery phrase alone)';
  return 'From smart account';
}

/** The AA quote for a plain native transfer (one call, no calldata). */
export async function prepareAaSend(
  bundle: AaClientBundle,
  ownerAddress: string,
  to: string,
  amount: bigint,
): Promise<AaSendQuote> {
  return prepareAaCalls(bundle, ownerAddress, [{ to, value: amount, data: new Uint8Array(0) }]);
}

/**
 * The single call that sends `amount` of an ERC-20 FROM the smart account:
 * transfer(recipient, amount) on the token contract, value 0. A plain
 * transfer needs no approve — the smart account moves its own tokens.
 */
export function aaErc20TransferCalls(contract: string, recipient: string, amount: bigint): Call[] {
  return [{ to: contract, value: 0n, data: encodeErc20Transfer(recipient, amount) }];
}

/**
 * Smart-account ERC-20 send quote: one transfer call, token balance checked
 * against the SMART ACCOUNT, gas (in ETH) checked against the smart
 * account's ETH balance unless sponsored.
 */
export async function prepareAaErc20Send(
  bundle: AaClientBundle,
  ownerAddress: string,
  token: { contract: string; recipient: string; amount: bigint; symbol: string; decimals: number },
): Promise<AaSendQuote> {
  return prepareAaCalls(
    bundle,
    ownerAddress,
    aaErc20TransferCalls(token.contract, token.recipient, token.amount),
    {
      tokenSpend: { contract: token.contract, amount: token.amount, symbol: token.symbol },
      displayTo: token.recipient,
      token,
    },
  );
}

/**
 * Smart-account token Max: the smart account's full token balance (gas is
 * paid in ETH). Refuses — through the quote's own insufficient-funds error
 * — when the smart account's ETH cannot cover the worst-case fee for
 * sending that balance. Returns 0n for an empty token balance.
 */
export async function maxAaErc20Send(
  bundle: AaClientBundle,
  ownerAddress: string,
  token: { contract: string; recipient: string; symbol: string; decimals: number },
): Promise<bigint> {
  const sender = await resolveAaSender(bundle, ownerAddress);
  const balance = await fetchTokenBalanceVia(bundle.node, token.contract, sender);
  if (balance === 0n) return 0n;
  await prepareAaErc20Send(bundle, ownerAddress, { ...token, amount: balance });
  return balance;
}

/**
 * The largest amount the smart account can send right now (phase 5's
 * AA Max slice): the full balance under sponsorship, else the balance
 * minus the worst-case fee of a zero-value transfer to the same
 * recipient (gas for a simple native transfer does not depend on the
 * amount). Returns 0n when fees exceed the balance.
 */
export async function maxAaSend(
  bundle: AaClientBundle,
  ownerAddress: string,
  to: string,
): Promise<bigint> {
  const probe = await prepareAaSend(bundle, ownerAddress, to, 0n);
  if (bundle.sponsored) return probe.senderBalance;
  const gasTotal = probe.callGasLimit + probe.verificationGasLimit + probe.preVerificationGas;
  const worstCase = gasTotal * probe.maxFeePerGas;
  return probe.senderBalance > worstCase ? probe.senderBalance - worstCase : 0n;
}

/**
 * What sendAa reports once the bundler accepted an operation. Public data
 * only: the owner's address and BIP-32 path, never the DerivedAccount (whose
 * sign closure captures the private key).
 */
export interface AaSentEvent {
  bundle: AaClientBundle;
  owner: { address: string; path: string };
  quote: AaSendQuote;
  userOpHash: string;
}

export type AaSentListener = (event: AaSentEvent) => void | Promise<void>;

const sentListeners = new Set<AaSentListener>();

/**
 * Subscribes to accepted smart-account operations (every sendAa caller:
 * Send, Swap, Sessions, Guardians, WalletConnect). Used to start a Kernel
 * account's recovery record on its first use (./recovery.ts). Returns the
 * unsubscribe function.
 */
export function addAaSentListener(listener: AaSentListener): () => void {
  sentListeners.add(listener);
  return () => {
    sentListeners.delete(listener);
  };
}

/** Best-effort fan-out: a failing listener never affects the send. */
function notifyAaSent(event: AaSentEvent): void {
  for (const listener of [...sentListeners]) {
    try {
      const result = listener(event);
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch(() => undefined);
      }
    } catch {
      // Listeners are bookkeeping; the operation was already accepted.
    }
  }
}

/**
 * Signs and submits the quoted calls as one UserOperation through
 * SmartAccountClient.sendCalls (stub → estimate → sign → send; the client
 * re-runs its own estimation so the submitted gas limits are fresh).
 * Refuses before signing when the signer's smart account is not the quoted
 * sender (e.g. the configuration changed after the quote). Returns the
 * bundler-issued userOpHash — inclusion is asynchronous; poll with
 * waitForAaReceipt.
 */
export async function sendAa(
  bundle: AaClientBundle,
  owner: DerivedAccount,
  quote: AaSendQuote,
): Promise<{ userOpHash: string }> {
  if (quote.passkey) {
    throw new Error('This operation was prepared for the passkey signer. Nothing was signed; review it again.');
  }
  // Mainnet readiness: an operation that would sign an EIP-7702
  // authorization is refused where the upgrade is not allowed.
  if (quote.eip7702?.upgrade) assertFeatureAllowed('eip7702-upgrade', eip155Caip2(bundle.chainId));
  const sender = await bundle.client.getAddress(owner);
  if (sender.toLowerCase() !== quote.sender.toLowerCase()) {
    throw new Error(
      `This signer's smart account is ${sender}, but the operation was prepared for ` +
        `${quote.sender}. Nothing was signed; review the send again.`,
    );
  }
  if (bundle.eip7702 && !quote.eip7702) {
    throw new Error('This operation was prepared for another account type. Nothing was signed.');
  }
  // D6: the authorization tuple may be signed only for a quote whose
  // confirm screen announced the upgrade; the wrapped spec refuses it
  // otherwise. The gate is closed again whatever happens.
  if (bundle.eip7702) bundle.eip7702.gate.allowAuthorization = quote.eip7702?.upgrade === true;
  try {
    const { userOpHash } = await bundle.client.sendCalls(owner, quote.calls, {
      maxFeePerGas: quote.maxFeePerGas,
      maxPriorityFeePerGas: quote.maxPriorityFeePerGas,
    });
    notifyAaSent({ bundle, owner: { address: owner.address, path: owner.path }, quote, userOpHash });
    return { userOpHash };
  } finally {
    if (bundle.eip7702) {
      bundle.eip7702.gate.allowAuthorization = false;
      if (quote.eip7702?.upgrade) invalidateAccountDelegation(sender);
    }
  }
}

/**
 * Smart-account message signature for a dApp (phase 7 item 3): the
 * account's ERC-1271 envelope over `hash` (for personal_sign the EIP-191
 * message hash, for eth_signTypedData_v4 the EIP-712 digest), wrapped per
 * ERC-6492 while the account is not deployed — via the engine's
 * signHashForSmartAccount. Refuses for implementations without ERC-1271
 * (SimpleAccount) and when the owner's smart account is not
 * `expectedAccount` (the session's bound address). For Kernel the owner key
 * signs Kernel's own "Kernel(bytes32 hash)" EIP-712 wrapper, which shows a
 * hardware or third-party signer only a hash — the app shows the original
 * request before calling this.
 */
export async function signHashAsSmartAccount(
  bundle: AaClientBundle,
  owner: DerivedAccount,
  hash: Uint8Array,
  expectedAccount: string,
): Promise<SmartAccountSignature> {
  if (!bundle.spec.signErc1271) {
    throw new Error(
      `${aaAccountTypeLabel(bundle.accountType)} has no ERC-1271 support, so it cannot sign ` +
        'messages for dApps.',
    );
  }
  const account = await bundle.client.getAddress(owner);
  if (account.toLowerCase() !== expectedAccount.toLowerCase()) {
    throw new Error(
      `This signer's smart account is ${account}, but the connection is bound to ` +
        `${expectedAccount}. Nothing was signed.`,
    );
  }
  return signHashForSmartAccount(bundle.spec, owner, hash, {
    chainId: bundle.chainId,
    node: bundle.node,
  });
}

/**
 * Footnote for balance-change previews of smart-account operations with
 * more than one call. The engine's asset-diff simulation (eth_simulateV1)
 * runs the calls one after another in one simulated block, each seeing the
 * previous call's state; it does not model the account's all-or-nothing
 * execution (packages/chains-evm/src/asset-diff.ts and AGENTS.md phase 6
 * item 1 document this).
 */
export const PREVIEW_AA_BATCH_NOTE =
  'Simulated as direct calls from your smart account, one after another in a single ' +
  'simulated block (eth_simulateV1). The smart account executes them as one atomic ' +
  'operation: if any call fails, none of them take effect. The gas the smart account ' +
  'pays through the EntryPoint is shown separately above and is not part of this list.';

/**
 * Plain-language error for the AA path, keeping the bundler's message
 * verbatim as the detail. A rejected Kernel deployment gets a title that
 * says so and the known-limitation note (no self-bundling fallback).
 */
export function describeAaError(
  error: unknown,
  context: { accountType: AaAccountType; deployed: boolean | null },
): { title: string; detail: string } | null {
  const detail = error instanceof Error ? error.message : String(error);
  if (context.accountType === 'kernel-7702' && context.deployed === false && /^RPC error /.test(detail)) {
    return {
      title: 'The bundler refused the operation that upgrades your account.',
      detail:
        `${detail}\n\nThe bundler's message is shown exactly as returned. Not every bundler ` +
        'accepts EIP-7702 authorizations (ZeroDev’s did on Sepolia, 2026-10-01). You can upgrade ' +
        'with a transaction instead (Upgrade this account → Upgrade now), then send again.',
    };
  }
  if (
    context.accountType === 'kernel-v3.3' &&
    context.deployed !== true &&
    /-32502|banned opcode|CREATE2|must be staked|unstaked|AA1[0-9]/i.test(detail)
  ) {
    return {
      title: 'The bundler refused to deploy your Kernel smart account.',
      detail: `${detail}\n\n${KERNEL_BUNDLER_NOTE}`,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Receipt inspection (bundler-dependent shape; never fabricate)
// ---------------------------------------------------------------------------

export interface AaReceiptSummary {
  /** UserOperation success flag when the bundler reported one, else null. */
  success: boolean | null;
  /** The including transaction's hash when one was found, else null. */
  txHash: string | null;
}

const TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/**
 * Extracts what the UI needs from an eth_getUserOperationReceipt result.
 * The ERC-4337 spec shape nests a full transaction receipt under `receipt`
 * (whose `transactionHash` is the including transaction), with a `success`
 * flag at the top level — but the exact shape is bundler-dependent, so
 * every field is inspected defensively and anything unrecognized yields
 * null rather than a guessed value.
 */
export function summarizeAaReceipt(receipt: unknown): AaReceiptSummary {
  if (typeof receipt !== 'object' || receipt === null) {
    return { success: null, txHash: null };
  }
  const r = receipt as Record<string, unknown>;

  let success: boolean | null = null;
  if (typeof r.success === 'boolean') success = r.success;
  else if (r.success === '0x1') success = true;
  else if (r.success === '0x0') success = false;

  let txHash: string | null = null;
  const inner = r.receipt;
  if (typeof inner === 'object' && inner !== null) {
    const h = (inner as Record<string, unknown>).transactionHash;
    if (typeof h === 'string' && TX_HASH_PATTERN.test(h)) txHash = h;
  }
  if (txHash === null && typeof r.transactionHash === 'string' && TX_HASH_PATTERN.test(r.transactionHash)) {
    // Some bundlers flatten the transaction hash to the top level.
    txHash = r.transactionHash;
  }

  return { success, txHash };
}

/**
 * Polls the bundler for the UserOperation receipt (SmartAccountClient's
 * own waitForReceipt loop) and summarizes it. Throws on timeout — the
 * operation may still land later; the userOpHash remains the lookup key.
 */
export async function waitForAaReceipt(
  bundle: AaClientBundle,
  userOpHash: string,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<{ raw: unknown; summary: AaReceiptSummary }> {
  const raw = await bundle.client.waitForReceipt(userOpHash, options);
  return { raw, summary: summarizeAaReceipt(raw) };
}

/**
 * One eth_getUserOperationReceipt lookup (null while not included) against
 * a bundler URL — the ERC-5792 wallet_getCallsStatus path, which must not
 * block on polling.
 */
export async function fetchUserOpReceipt(
  bundlerUrl: string,
  userOpHash: string,
  transportFor: TransportFactory = httpTransport,
): Promise<unknown> {
  return new BundlerClient(transportFor(bundlerUrl), ENTRYPOINT_V07).getUserOperationReceipt(userOpHash);
}
