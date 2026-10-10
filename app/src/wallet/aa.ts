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
  PERMIT_DEADLINE_MAX,
  TokenGasChargeAboveLimitError,
  createCirclePaymasterTransport,
  createErc7677TokenPaymasterTransport,
  createKernel7702AccountSpec,
  createKernelAccountSpec,
  createSimpleAccountSpec,
  decodeUint256,
  kernelRecoveredAccountSpec,
  encodeErc20BalanceOf,
  encodeErc20Transfer,
  encodeFunctionCall,
  erc7677TokenApproveCall,
  httpTransport,
  readDelegationStatus,
  requiredPrefund,
  signHashForSmartAccount,
  toBytes,
  toHex,
  verifyKernelDeployment,
  withDepositTopUpHeadroom,
  type Call,
  type JsonRpcTransport,
  type PermitRequest,
  type SignedEip7702Authorization,
  type SmartAccountSignature,
  type SmartAccountSpec,
  type UserOperation,
} from '@shiba-wallet/chains-evm';
// Explicit .ts extensions: this module is imported by scripts/check-aa.mjs
// under Node's type stripping, which resolves relative specifiers literally.
import { EVM_CHAIN_ID, validateRecipient } from './send.ts';
import { formatUnits } from './balances.ts';
import type { KeyValueStore } from './tokens.ts';
import { smartAccountSaltFor } from './account-ids.ts';
import { assertSecureEndpointUrl } from '../config/endpoint-url.ts';
import { assertWalletDelegate, invalidateAccountDelegation } from './delegation.ts';
import {
  FeatureNotAllowedError,
  assertFeatureAllowed,
  eip155Caip2,
  isFeatureAllowed,
  type FeatureId,
} from '../config/readiness.ts';
import { evmProfileByCaip2 } from '../config/evm-chain.ts';
import { PREVIEW_AA_NOTE } from './simulation.ts';
import { suggestFeesRetryingOnce } from './fee-read.ts';

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
 * mainnet, Sepolia and Base Sepolia; see packages/chains-evm/src/
 * kernel-account.ts for their sources and the read-only on-chain
 * confirmation, and config/evm-chain.ts EVM_BASE_SEPOLIA for the Base
 * Sepolia checks of 2026-10-03). Saving still runs verifyKernelDeployment
 * against the configured RPC endpoint.
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
   * The chain id (decimal) the bundler reported through eth_chainId when it
   * was saved (verifyAaBundlerChain). Null for a bundler saved before that
   * check existed (phase 11 item 5): Settings then does not claim it ran.
   */
  bundlerChainIdVerified: string | null;
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
   * Non-null when a bundler URL is stored but fails the https rule on read
   * (../config/endpoint-url.ts): the reason, for Settings' status line. The
   * stored URL is then NOT used (`bundlerUrl` reads as null, so the chain
   * counts as not configured) and stays stored until the user clears it.
   */
  bundlerUrlIgnoredReason: string | null;
  /** The same for the paymaster URL (`paymasterUrl` then reads as null). */
  paymasterUrlIgnoredReason: string | null;
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
  bundlerChainIdVerified: null,
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
  bundlerUrlIgnoredReason: null,
  paymasterUrlIgnoredReason: null,
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
  notifyAaConfigChanged();
}

export type AaConfigChangedListener = () => void;

const configChangedListeners = new Set<AaConfigChangedListener>();

/**
 * Subscribes to writes of the smart-account configuration. Every setter and
 * clear function in this module persists through saveConfigMap, which calls
 * the listeners after the write succeeded (a refused save writes nothing
 * and notifies nobody). Used by the Home eligibility hooks so the Sessions,
 * Guardians and Passkey links appear or disappear without a relaunch.
 * Returns the unsubscribe function.
 */
export function addAaConfigChangedListener(listener: AaConfigChangedListener): () => void {
  configChangedListeners.add(listener);
  return () => {
    configChangedListeners.delete(listener);
  };
}

/** Best-effort fan-out: a failing listener never affects the saved configuration. */
function notifyAaConfigChanged(): void {
  for (const listener of [...configChangedListeners]) {
    try {
      listener();
    } catch {
      // Listeners only refresh displays; the configuration is already saved.
    }
  }
}

/**
 * Applies the https rule to a stored endpoint URL. Values saved before the
 * rule existed (dev/emulator installs only) may be plain http://; those are
 * reported as ignored rather than used or silently deleted. The setters
 * below write back the RAW stored entry (`...map[chainId]`), never this
 * normalized view, so an ignored URL stays stored until a Clear.
 */
function checkStoredUrl(stored: string | null): { url: string | null; ignoredReason: string | null } {
  if (stored === null) return { url: null, ignoredReason: null };
  try {
    assertSecureEndpointUrl(stored);
    return { url: stored, ignoredReason: null };
  } catch (e) {
    return { url: null, ignoredReason: e instanceof Error ? e.message : String(e) };
  }
}

function normalizeEntry(entry: Partial<AaChainConfig> | undefined, chain: string): AaChainConfig {
  const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
  const bundler = checkStoredUrl(str(entry?.bundlerUrl));
  const bundlerUrl = bundler.url;
  const factory = str(entry?.factory);
  const paymaster = checkStoredUrl(str(entry?.paymasterUrl));
  const paymasterUrl = paymaster.url;
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
    bundlerChainIdVerified:
      bundlerUrl && typeof entry?.bundlerChainIdVerified === 'string' && /^[0-9]+$/.test(entry.bundlerChainIdVerified)
        ? entry.bundlerChainIdVerified
        : null,
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
    bundlerUrlIgnoredReason: bundler.ignoredReason,
    paymasterUrlIgnoredReason: paymaster.ignoredReason,
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
  return (await bundlerFeeFloor(bundler))?.maxPriorityFeePerGas ?? null;
}

/**
 * The lowest fees a bundler will accept for a UserOperation right now, as
 * far as the bundler says (best effort; null when it serves neither method
 * below). `maxFeePerGas` is null when the bundler's method states no
 * maxFeePerGas minimum.
 */
export interface BundlerFeeFloor {
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint | null;
  /**
   * The LOWEST price the bundler currently advertises, when it says (the
   * Pimlico-style `slow` tier). Quotes are priced over the fields above
   * (the standard tier, plus AA_FEE_FLOOR_HEADROOM_PERCENT); the send-time
   * check compares the quoted fees with this one (feeFloorShortfall). Absent
   * for Rundler's single answer and when the tier is missing or malformed,
   * in which case the check falls back to the fields above.
   */
  lowest?: { maxPriorityFeePerGas: bigint; maxFeePerGas: bigint | null };
}

/**
 * Reads the bundler's fee floor: Rundler's rundler_maxPriorityFeePerGas
 * first (a priority fee only), else the Pimlico-style
 * pimlico_getUserOperationGasPrice standard tier (both fees). Why both fees
 * matter for the second: Alto, Pimlico's bundler, refuses an operation
 * whose maxFeePerGas OR maxPriorityFeePerGas is below the lowest of its
 * recently observed gas prices, with the messages "maxFeePerGas must be at
 * least … - use pimlico_getUserOperationGasPrice to get the current gas
 * price" and "maxPriorityFeePerGas must be at least …" (pimlicolabs/alto,
 * src/rpc/rpcHandler.ts lines 255-274 and src/handlers/gasPriceManager.ts
 * getLowestValidGasPrices, main at 96529592, read 2026-10-04). ZeroDev's
 * Sepolia bundler refused a revoke on 2026-10-04 with exactly the second
 * message, so it behaves like Alto here (which bundler software ZeroDev
 * runs is not documented).
 *
 * What the tiers are, and why the send-time check uses the lowest one
 * (pimlicolabs/alto at 96529592, read 2026-10-04): the method returns the
 * bundler's LATEST observed gas price scaled by its configured slow /
 * standard / fast multipliers (src/rpc/methods/
 * pimlico_getUserOperationGasPrice.ts), while the refusal above compares
 * the operation with the MINIMUM of the prices it observed during the last
 * gas-price-expiry seconds (src/handlers/gasPriceManager.ts
 * getLowestValidGasPrices over a min/max queue, src/utils/minMaxQueue;
 * src/cli/config/options.ts: default expiry 20 s, default multipliers
 * 100,100,100). So the standard tier is a point estimate at or above what
 * the bundler accepts, and it is noisy: read-only probes of ZeroDev's
 * Sepolia endpoint on 2026-10-04 saw its standard-tier priority fee change
 * with almost every block, between about 0.061 and 0.117 gwei (+90 % from
 * one block to the next at worst), with the slow, standard and fast tiers
 * always in the ratio 1 : 1.05 : 1.10. Under Alto's rule the minimum over
 * the window is at most the latest raw price, and the slow tier equals
 * that raw price when its multiplier is 100 (ZeroDev's multipliers are not
 * published; the 1 : 1.05 : 1.10 ratio fits 100,105,110, but that is an
 * inference). Hence: quotes are priced over the STANDARD tier plus
 * headroom, and the send-time check refuses only when the bundler's LOWEST
 * advertised price is above the quoted fee. A bundler that still refuses
 * at submission is caught by isBundlerFeeFloorRefusal and gets the same
 * wording.
 */
export async function bundlerFeeFloor(bundler: JsonRpcTransport): Promise<BundlerFeeFloor | null> {
  const rundler = await rundlerPriorityFee(bundler);
  if (rundler !== null) return { maxPriorityFeePerGas: rundler, maxFeePerGas: null };
  return pimlicoFeeFloor(bundler);
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
 * endpoints reference, read 2026-10-01). Quotes are priced over the
 * standard tier; the slow tier, when well formed and not above the
 * standard one, becomes `lowest` (bundlerFeeFloor explains why the
 * send-time check uses it). A standard tier without a valid
 * maxPriorityFeePerGas yields null, and a missing or malformed
 * maxFeePerGas only leaves that half unknown.
 */
async function pimlicoFeeFloor(bundler: JsonRpcTransport): Promise<BundlerFeeFloor | null> {
  type Tier = { maxPriorityFeePerGas?: unknown; maxFeePerGas?: unknown };
  try {
    const result = (await bundler('pimlico_getUserOperationGasPrice', [])) as
      | { slow?: Tier; standard?: Tier }
      | null
      | undefined;
    const priority = result?.standard?.maxPriorityFeePerGas;
    if (!isHexQuantity(priority)) return null;
    const maxFee = result?.standard?.maxFeePerGas;
    const floor: BundlerFeeFloor = {
      maxPriorityFeePerGas: BigInt(priority),
      maxFeePerGas: isHexQuantity(maxFee) ? BigInt(maxFee) : null,
    };
    // A "lowest" price above the standard one would not be the lowest: such
    // a slow tier is ignored rather than trusted, and so is a slow
    // maxFeePerGas above the standard one (the standard value is kept).
    const slowPriority = result?.slow?.maxPriorityFeePerGas;
    if (isHexQuantity(slowPriority) && BigInt(slowPriority) <= floor.maxPriorityFeePerGas) {
      const slowMax = result?.slow?.maxFeePerGas;
      const lowestMax = isHexQuantity(slowMax) ? BigInt(slowMax) : null;
      floor.lowest = {
        maxPriorityFeePerGas: BigInt(slowPriority),
        maxFeePerGas:
          lowestMax !== null && floor.maxFeePerGas !== null && lowestMax <= floor.maxFeePerGas
            ? lowestMax
            : floor.maxFeePerGas,
      };
    }
    return floor;
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

/**
 * Headroom (percent) that smart-account QUOTES add on top of the bundler's
 * fee floor (its standard-tier price, see bundlerFeeFloor). A judgement
 * call, not a standard. The wallet never raises a fee after the user
 * approved the quote, so the quote itself carries room for the price to
 * move; the headroom is part of the displayed worst-case fee, and nothing
 * above that displayed worst case is ever signed (signedFeeGuard). The fee
 * actually charged is lower: the EntryPoint charges gas used × min(
 * maxFeePerGas, base fee + maxPriorityFeePerGas), so the headroom costs at
 * most 100 % of the (small) priority fee per unit of gas, and nothing when
 * the node's own suggestion is already above twice the floor.
 *
 * Why 100 % (the CTO's decision of 2026-10-04, recorded in AGENTS.md under
 * the phase 13 fee-floor fixes): read-only probes of ZeroDev's Sepolia
 * bundler that day saw its standard-tier priority fee move by up to +90.7 %
 * within 10 s, and the two live refusals of the private-key run were rises
 * of +40.0 % and +26.3 % within about 20 s. Measured over about ten minutes
 * of samples, 25 % headroom still bounced about 13 % of 20-second-old
 * quotes, 50 % about 8-12 %, and 100 % about 0-5 %, at roughly +5-10 % of
 * the actual cost on Sepolia (the priority fee was 5-10 % of the effective
 * price there).
 *
 * The rule this gives, with the send-time check in feeFloorShortfall
 * (which compares against the bundler's LOWEST tier, never above the
 * standard one): a rise of the standard-tier price of up to 100 % between
 * the quote and the send never refuses. A larger rise can still refuse;
 * those refusals happen BEFORE the device check
 * (checkAaQuoteBeforeApproval) and lead to a fresh quote.
 */
export const AA_FEE_FLOOR_HEADROOM_PERCENT = 100n;

/** `value` plus AA_FEE_FLOOR_HEADROOM_PERCENT, rounded up (exact bigint). */
export function withFeeFloorHeadroom(value: bigint): bigint {
  return (value * (100n + AA_FEE_FLOOR_HEADROOM_PERCENT) + 99n) / 100n;
}

/**
 * The fees a smart-account quote uses: the node's suggestion, raised where
 * it sits below the bundler's floor PLUS AA_FEE_FLOOR_HEADROOM_PERCENT
 * (priority fee first, keeping the base-fee allowance like
 * applyPriorityFeeFloor; then maxFeePerGas when the bundler states a
 * minimum for it). A null floor, or a suggestion already above floor +
 * headroom, returns `fees` unchanged. The floor here is always the
 * standard tier (`floor.lowest` is for the send-time check only).
 */
export function quoteFeesOverFloor(
  fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
  floor: BundlerFeeFloor | null,
): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } {
  if (floor === null) return fees;
  let { maxFeePerGas, maxPriorityFeePerGas } = fees;
  const priority = withFeeFloorHeadroom(floor.maxPriorityFeePerGas);
  if (priority > maxPriorityFeePerGas) {
    maxFeePerGas += priority - maxPriorityFeePerGas;
    maxPriorityFeePerGas = priority;
  }
  if (floor.maxFeePerGas !== null) {
    const maxFee = withFeeFloorHeadroom(floor.maxFeePerGas);
    if (maxFee > maxFeePerGas) maxFeePerGas = maxFee;
  }
  if (maxFeePerGas === fees.maxFeePerGas && maxPriorityFeePerGas === fees.maxPriorityFeePerGas) return fees;
  return { maxFeePerGas, maxPriorityFeePerGas };
}

/** Title when the bundler's minimum fee rose above the reviewed fees (reason 'floor'). */
export const AA_FEE_ROSE_TITLE = 'The network fee rose. Please review again.';

/** Title when the bundler's fresh gas estimate makes the worst case larger than the reviewed one (reason 'gas'). */
export const AA_GAS_GREW_TITLE = 'The gas estimate grew. Please review again.';

/** Title for the other "review again" refusals (a quote already submitted, fees that changed). */
export const AA_REVIEW_AGAIN_TITLE = 'Please review the operation again.';

/** The closing sentence of every AaFeeRoseError message. */
export const AA_FEE_ROSE_NEXT_STEP =
  'Nothing was signed or sent. Review the operation again: the new quote shows the higher fee, and the ' +
  'wallet never signs more than the worst-case fee you approved.';

/**
 * How the wallet treats a bundler gas estimate with an impossible (zero)
 * limit: the engine (BundlerClient.estimateUserOperationGasChecked and
 * SmartAccountClient's estimateRetries) refuses it and asks again, up to
 * `attempts` times `delayMs` apart, before throwing
 * ImpossibleGasEstimateError. Observed 2026-10-09 on ZeroDev's Arbitrum
 * Sepolia endpoint: verificationGasLimit and paymasterVerificationGasLimit
 * 0x0 in about 27 of 35 answers, in bursts of tens of seconds; signed, such
 * an operation reverts in the EntryPoint. A person is waiting on the Review
 * or Approve button, so the retry is short (at most about 6 s of waiting
 * plus four round trips, against the testnet scripts' 24 attempts 5 s
 * apart): it rides out a brief burst, and otherwise the refusal tells the
 * user to try again. The same values as the engine's default
 * (DEFAULT_ESTIMATE_RETRIES), passed explicitly so this file states them.
 */
export const AA_ESTIMATE_RETRIES: { attempts: number; delayMs: number } = { attempts: 4, delayMs: 2_000 };

/** Title describeAaError shows for an impossible gas estimate. */
export const AA_IMPOSSIBLE_ESTIMATE_TITLE = 'The bundler’s gas estimate was impossible.';

/** The plain sentence describeAaError shows for an impossible gas estimate (before the technical line). */
export const AA_IMPOSSIBLE_ESTIMATE_SENTENCE =
  'The bundler answered with an impossible gas estimate (zero gas). This happens in bursts on some ' +
  'networks; wait a few seconds and review again. The operation was not signed or sent.';

/**
 * True for the engine's ImpossibleGasEstimateError. Matched by name because
 * the class is not exported from the engine package's entry point; the
 * engine sets this name on the class itself (packages/chains-evm/src/rpc.ts).
 */
export function isImpossibleGasEstimateError(error: unknown): error is Error & { problems: string[]; attempts: number } {
  return error instanceof Error && error.name === 'ImpossibleGasEstimateError';
}

/**
 * Why an operation must be reviewed again:
 *  - 'floor': the bundler's minimum fee rose above the quoted fees
 *    (feeFloorShortfall), before the device check or at send time;
 *  - 'gas': the bundler's fresh gas estimate at send time makes the
 *    worst-case fee larger than the displayed one (signedFeeGuard);
 *  - 'fees-changed': the operation about to be signed does not carry the
 *    quoted fees (an internal invariant; signedFeeGuard);
 *  - 'used': the quote was already submitted once (claimQuoteForSubmission).
 */
export type AaFeeRoseReason = 'floor' | 'gas' | 'fees-changed' | 'used';

/**
 * Thrown BEFORE anything is signed when the operation can no longer go out
 * at or below the worst-case fee the user reviewed. `reason` decides the
 * title (describeAaError). The screens drop the quote and ask for a new
 * review.
 */
export class AaFeeRoseError extends Error {
  reason: AaFeeRoseReason;
  // No TS parameter properties: Node's strip-only type stripping rejects them.
  constructor(message: string, reason: AaFeeRoseReason = 'floor') {
    super(message);
    this.name = 'AaFeeRoseError';
    this.reason = reason;
  }
}

/** The title describeAaError shows for an AaFeeRoseError. */
export function aaFeeRoseTitle(error: AaFeeRoseError): string {
  if (error.reason === 'floor') return AA_FEE_ROSE_TITLE;
  if (error.reason === 'gas') return AA_GAS_GREW_TITLE;
  return AA_REVIEW_AGAIN_TITLE;
}

function gwei(wei: bigint): string {
  const whole = wei / 1_000_000_000n;
  const frac = (wei % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/**
 * The reason the quoted fees fall below what the bundler accepts now, or
 * null when they meet it (or the floor is unknown). Compared with the
 * bundler's LOWEST advertised price (`floor.lowest`, the slow tier) when it
 * has one, else with the standard tier; bundlerFeeFloor explains why the
 * standard tier is not the bundler's minimum. Exact comparison, no
 * tolerance.
 */
export function feeFloorShortfall(
  quoted: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
  floor: BundlerFeeFloor | null,
): string | null {
  if (floor === null) return null;
  const min = floor.lowest ?? floor;
  if (min.maxPriorityFeePerGas > quoted.maxPriorityFeePerGas) {
    return (
      `The bundler's minimum fee rose: it now asks for a priority fee of at least ${min.maxPriorityFeePerGas} wei ` +
      `(${gwei(min.maxPriorityFeePerGas)} gwei) per gas, above the ${quoted.maxPriorityFeePerGas} wei ` +
      `(${gwei(quoted.maxPriorityFeePerGas)} gwei) this operation was reviewed with.`
    );
  }
  if (min.maxFeePerGas !== null && min.maxFeePerGas > quoted.maxFeePerGas) {
    return (
      `The bundler's minimum fee rose: it now asks for a maximum fee of at least ${min.maxFeePerGas} wei ` +
      `(${gwei(min.maxFeePerGas)} gwei) per gas, above the ${quoted.maxFeePerGas} wei ` +
      `(${gwei(quoted.maxFeePerGas)} gwei) this operation was reviewed with.`
    );
  }
  return null;
}

/**
 * Fee-floor check, before anything is signed: re-reads the bundler's floor
 * and throws AaFeeRoseError (reason 'floor') when the quoted fees no longer
 * meet it. The quoted fees are never raised here, so the signed fee per
 * gas is always the reviewed one. An unreadable floor passes (best effort,
 * as at quote time); the bundler's own refusal then arrives as an error
 * and the screens re-quote. Used twice per operation: before the device
 * check (checkAaQuoteBeforeApproval) and again at send time, as the last
 * line of defence for a floor that moved while the prompt was up.
 */
export async function assertQuoteFeesMeetBundlerFloor(
  bundler: JsonRpcTransport,
  quoted: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
): Promise<void> {
  const shortfall = feeFloorShortfall(quoted, await bundlerFeeFloor(bundler));
  if (shortfall) throw new AaFeeRoseError(`${shortfall} ${AA_FEE_ROSE_NEXT_STEP}`, 'floor');
}

/**
 * The SmartAccountClient.sendCalls beforeSign check for a reviewed quote:
 * the operation about to be signed must carry exactly the quoted fees, and
 * when the account pays its own gas (no paymaster on the operation) its
 * worst-case cost — EntryPoint v0.7's required prefund, the engine's
 * requiredPrefund — must not exceed the fee the confirm screen showed
 * (`displayedFee`). The client re-estimates the gas limits when it sends,
 * so a bundler estimate that grew since the quote would otherwise be signed
 * silently. Paymaster operations are not checked here: a sponsored
 * operation costs the account nothing, and a USDC-fee operation is capped
 * by the permit (maxTokenCharge, enforced by the engine's transport and
 * assertTokenGasPermit).
 */
export function signedFeeGuard(
  quoted: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
  displayedFee: bigint,
): (op: UserOperation) => void {
  return (op) => {
    if (op.maxFeePerGas !== quoted.maxFeePerGas || op.maxPriorityFeePerGas !== quoted.maxPriorityFeePerGas) {
      throw new AaFeeRoseError(
        `The operation's fees differ from the reviewed ones. ${AA_FEE_ROSE_NEXT_STEP}`,
        'fees-changed',
      );
    }
    if (op.paymaster) return;
    const worstCase = requiredPrefund(op);
    if (worstCase > displayedFee) {
      throw new AaFeeRoseError(
        `The gas estimate grew: the bundler's fresh gas estimate makes the worst-case fee ${worstCase} wei, ` +
          `above the ${displayedFee} wei you reviewed. ${AA_FEE_ROSE_NEXT_STEP}`,
        'gas',
      );
    }
  };
}

/**
 * True for a bundler's own fee-floor refusal (the wallet's send-time check
 * can miss a floor that moves during the few seconds of signing, or one
 * the floor methods did not report): Alto's "maxPriorityFeePerGas must be
 * at least" / "maxFeePerGas must be at least" (src/rpc/rpcHandler.ts, see
 * bundlerFeeFloor) and Rundler's "maxPriorityFeePerGas is X but must be at
 * least Y" (the 2026-10-01 Alchemy refusal recorded in AGENTS.md).
 */
export function isBundlerFeeFloorRefusal(message: string): boolean {
  return /max(?:Priority)?FeePerGas (?:must be at least|is \d+ but must be at least)/i.test(message);
}

/** Plain chain name for messages ("Base Sepolia (chain id 84532)"). */
function chainNameForMessage(chainId: bigint): string {
  const profile = evmProfileByCaip2(`eip155:${chainId}`);
  return profile ? `${profile.label} (chain id ${chainId})` : `chain id ${chainId}`;
}

/**
 * Bundler chain check: the bundler's eth_chainId must equal the chain the
 * URL is being saved for. ERC-7769 ("JSON-RPC API for ERC-4337", Draft;
 * ethereum/ERCs ERCS/erc-7769.md at commit 365b4c02, section "RPC methods
 * (eth namespace)", heading "eth_chainId": "Returns EIP-155 Chain ID.")
 * defines this method for bundlers, and ZeroDev's bundler answered it for
 * both test networks on 2026-10-03 (0xaa36a7 for Ethereum Sepolia, 0x14a34
 * for Base Sepolia). Without this check a bundler URL for one chain could
 * be saved under another chain's key; that would fail safe (the
 * UserOperation signature commits to the chain id, so nothing could be
 * executed on the wrong chain), but every send would then fail with a
 * confusing bundler error instead of a clear refusal at save time.
 *
 * A bundler that does not answer eth_chainId with a hex quantity is
 * refused too: the wallet cannot confirm which chain it serves.
 */
export async function verifyAaBundlerChain(
  bundler: JsonRpcTransport,
  expectedChainId: bigint,
): Promise<void> {
  let result: unknown;
  try {
    result = await bundler('eth_chainId', []);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      'The bundler did not answer eth_chainId, so the wallet cannot confirm which ' +
        `network it serves. Nothing was saved. (${detail})`,
    );
  }
  if (!isHexQuantity(result)) {
    throw new Error(
      'The bundler answered eth_chainId with something that is not a chain id ' +
        `(${JSON.stringify(result)}), so the wallet cannot confirm which network it ` +
        'serves. Nothing was saved.',
    );
  }
  const reported = BigInt(result);
  if (reported !== expectedChainId) {
    throw new Error(
      `This bundler serves ${chainNameForMessage(reported)}, but you are saving it for ` +
        `${chainNameForMessage(expectedChainId)}. Nothing was saved. Paste the bundler URL ` +
        `for ${evmProfileByCaip2(`eip155:${expectedChainId}`)?.label ?? `chain id ${expectedChainId}`} ` +
        '(bundler URLs are per network; for example a ZeroDev URL ends in ' +
        `/chain/${expectedChainId}).`,
    );
  }
}

/**
 * Bundler verification: eth_supportedEntryPoints must include EntryPoint
 * v0.7 (same refusal as scripts/testnet/aa-smoke.mjs). Returns the list the
 * bundler reported.
 */
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
 * Saves a bundler URL for one chain after two checks against that URL: its
 * eth_chainId must equal the chain being configured (verifyAaBundlerChain)
 * and eth_supportedEntryPoints must include v0.7. Throws (persisting
 * nothing) when the URL is malformed, unreachable, serves another chain, or
 * lacks v0.7 support. Returns the bundler's supported entry points for
 * display.
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
  const bundler = transportFor(trimmed);
  const expectedChainId = eip155ChainIdOf(chainId);
  await verifyAaBundlerChain(bundler, expectedChainId);
  const supported = await verifyAaBundler(bundler);
  const map = await loadConfigMap(store);
  map[chainId] = {
    ...map[chainId],
    bundlerUrl: trimmed,
    bundlerVerifiedAt: new Date().toISOString(),
    // verifyAaBundlerChain returned, so the bundler reported exactly this id.
    bundlerChainIdVerified: expectedChainId.toString(),
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
    delete map[chainId]!.bundlerChainIdVerified;
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
 *
 * Method-not-found is recognised by code or by text, because ZeroDev's
 * project RPC answers an unknown method with HTTP 400 and the bare body
 * {"error":"Unsupported method: <name>. See available methods at"} (no
 * JSON-RPC code; observed live 2026-10-02).
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
    if (/-32601|method not found|unsupported method/i.test(message)) {
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
 * JSON-RPC over fetch for the paymaster save-time probe. The engine's
 * httpTransport throws "RPC HTTP error <status>" on any non-2xx answer and
 * drops the body, but paymasters put their policy refusals in exactly such
 * answers. ZeroDev's project RPC (observed live 2026-10-02 on Sepolia,
 * scripts/testnet/paymaster-probe.mjs) answers pm_getPaymasterStubData for
 * a project without a gas policy with HTTP 400 and the bare body
 * {"error":"userOp did not match any gas sponsoring policies or (no ERC20
 * gas token data present)"} — a string, not a JSON-RPC error object. With
 * httpTransport that refusal surfaced as "Paymaster endpoint unreachable or
 * not JSON-RPC", which was wrong: the endpoint is reachable and serves the
 * method. This transport keeps the server's words:
 *   - {"error": {code, message}} (any HTTP status) -> "RPC error <code>: <message> (<method>)"
 *   - {"error": "<text>"}        (any HTTP status) -> "RPC error (no code): <text> (<method>)"
 *   - any other non-2xx answer                     -> "RPC HTTP error <status> for <method>"
 * so verifyAaPaymaster can tell a policy refusal (accepted: the endpoint
 * speaks ERC-7677) from method-not-found or an unreachable endpoint.
 * `fetchFn` is resolved at call time so offline checks can replace
 * globalThis.fetch.
 */
export function paymasterProbeTransport(url: string, fetchFn?: typeof fetch): JsonRpcTransport {
  let id = 0;
  return async (method, params) => {
    const doFetch = fetchFn ?? globalThis.fetch;
    const response = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    const error = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
    if (typeof error === 'string') {
      throw new Error(`RPC error (no code): ${error} (${method})`);
    }
    if (error && typeof error === 'object') {
      const { code, message } = error as { code?: unknown; message?: unknown };
      throw new Error(
        `RPC error ${typeof code === 'number' ? code : '(no code)'}: ${
          typeof message === 'string' ? message : 'unknown error'
        } (${method})`,
      );
    }
    if (!response.ok) throw new Error(`RPC HTTP error ${response.status} for ${method}`);
    if (!body || typeof body !== 'object' || !('result' in body)) {
      throw new Error(`RPC response without a result for ${method}`);
    }
    return (body as { result: unknown }).result;
  };
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
  // Body-preserving transport: see paymasterProbeTransport for why the
  // engine's httpTransport cannot be used for this probe.
  const transportFor = options.transportFor ?? ((u: string) => paymasterProbeTransport(u));
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
  /**
   * Wallet account id. For an account from the phrase it is also the
   * CREATE2 salt; for an imported key's account the salt is 0
   * (account-ids.ts smartAccountSaltFor). Unused by 'kernel-7702'.
   */
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
  /**
   * The impossible-estimate retry policy this bundle's client and quotes
   * use (AA_ESTIMATE_RETRIES unless createAaClient was given another, which
   * only the check scripts do, to avoid real waits).
   */
  estimateRetries?: { attempts: number; delayMs: number };
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
 *
 * An imported key's account (ADR D9) uses salt 0 with the imported key's
 * address as owner: unique because the owner is, recomputable by whoever
 * holds the key from the key, the factory and index 0, and NOT recoverable
 * from the recovery phrase.
 */
export function createAaClient(options: {
  nodeUrl: string;
  bundlerUrl: string;
  factory: string;
  chainId?: bigint;
  /** Wallet account id; the CREATE2 salt is smartAccountSaltFor(id). Defaults to 0. */
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
  /** Impossible-estimate retries; defaults to AA_ESTIMATE_RETRIES (check scripts pass a no-wait policy). */
  estimateRetries?: { attempts: number; delayMs: number };
}): AaClientBundle {
  if (options.accountType === 'kernel-7702') return createKernel7702Bundle(options);
  const estimateRetries = options.estimateRetries ?? AA_ESTIMATE_RETRIES;
  const transportFor = options.transportFor ?? httpTransport;
  const node = transportFor(options.nodeUrl);
  const bundler = transportFor(options.bundlerUrl);
  const chainId = options.chainId ?? BigInt(EVM_CHAIN_ID.split(':')[1]!);
  const accountIndex = options.accountIndex ?? 0;
  if (!Number.isSafeInteger(accountIndex) || accountIndex < 0) {
    throw new Error(`Invalid account index ${String(options.accountIndex)}.`);
  }
  // The CREATE2 salt: the derivation index for an account from the phrase,
  // 0 for an imported key's account (account-ids.ts smartAccountSaltFor;
  // ADR D9). Throws for an id in neither range.
  const salt = smartAccountSaltFor(accountIndex);
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
            index: BigInt(salt),
            factory: options.factory,
            implementation: kernelAddresses.implementation,
            metaFactory: kernelAddresses.metaFactory,
            ecdsaValidator: kernelAddresses.ecdsaValidator,
          })
      : createSimpleAccountSpec({
          factory: options.factory,
          node,
          salt: BigInt(salt),
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
  // The paymaster transport keeps the server's own words on non-2xx answers
  // (a ZeroDev policy refusal is an HTTP 400 with a bare {"error": text}
  // body), so a refusal during a send shows the policy text rather than
  // "RPC HTTP error 400". An injected factory (tests) is used as given.
  const paymasterFactory: TransportFactory = transportFor === httpTransport ? paymasterProbeTransport : transportFor;
  const paymasterTransport = options.paymaster ? paymasterFactory(options.paymaster.url) : undefined;
  const client = new SmartAccountClient({
    chainId,
    entryPoint: ENTRYPOINT_V07,
    bundler,
    node,
    spec,
    depositTopUpVerificationGas: AA_DEPOSIT_TOPUP_VERIFICATION_GAS,
    estimateRetries,
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
    estimateRetries,
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
  estimateRetries?: { attempts: number; delayMs: number };
}): AaClientBundle {
  const transportFor = options.transportFor ?? httpTransport;
  const node = transportFor(options.nodeUrl);
  const bundler = transportFor(options.bundlerUrl);
  const chainId = options.chainId ?? BigInt(EVM_CHAIN_ID.split(':')[1]!);
  const estimateRetries = options.estimateRetries ?? AA_ESTIMATE_RETRIES;
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
  // The paymaster transport keeps the server's own words on non-2xx answers
  // (a ZeroDev policy refusal is an HTTP 400 with a bare {"error": text}
  // body), so a refusal during a send shows the policy text rather than
  // "RPC HTTP error 400". An injected factory (tests) is used as given.
  const paymasterFactory: TransportFactory = transportFor === httpTransport ? paymasterProbeTransport : transportFor;
  const paymasterTransport = options.paymaster ? paymasterFactory(options.paymaster.url) : undefined;
  const client = new SmartAccountClient({
    chainId,
    entryPoint: ENTRYPOINT_V07,
    bundler,
    node,
    spec,
    depositTopUpVerificationGas: AA_DEPOSIT_TOPUP_VERIFICATION_GAS,
    estimateRetries,
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
    estimateRetries,
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
   * The smart account's EntryPoint deposit as read for this quote (self-paid
   * operations only; absent when sponsored or when the read failed, which
   * the funding checks count as zero). The EntryPoint takes the fee from
   * the deposit first (aaFeeFromBalance), so screens use it to explain why
   * a fee above the balance is still payable.
   */
  deposit?: bigint;
  /**
   * Present only when the amount came from the smart-account Max button
   * (prepareAaCalls option fromMax) and the re-quoted worst-case fee no
   * longer fitted beside it, so the quote lowered the amount (see
   * AA_MAX_TRIM_ROUNDS). `requested` is the amount the form held; `amount`
   * and `calls` above are what will be signed. Absent in every other case.
   */
  maxAdjustment?: { requested: bigint };
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
  /**
   * Present only when the network fee is paid in USDC through a token
   * paymaster (./token-gas.ts). `fee` is 0n (no ETH is charged for gas) and
   * the worst case is `tokenGas.maxTokenCharge`. Circle's paymaster (phase
   * 13 item 2): the quote is made WITHOUT a bundler estimate (its estimation
   * stub needs a permit signed by the account, i.e. the owner key, which is
   * never loaded at quote time), so the gas fields above are 0n. An
   * ERC-7677 paymaster (tokenGas.source 'erc7677', phase 14 item 3): the
   * stub needs no signature, so the quote carries the bundler's padded
   * estimate in the gas fields above, and `calls[0]` is the exact approval.
   */
  tokenGas?: AaTokenGas;
}

/**
 * The USDC-fee part of a smart-account quote (./token-gas.ts builds it).
 * maxTokenCharge is the worst case the confirm screen shows; sendAa passes it
 * to the engine's paymaster transport as maxTokenCharge and refuses to sign
 * any permit above it, so the final charge can never exceed what the user
 * saw (packages/chains-evm/src/token-paymaster.ts: the prefund pulled in
 * validation is the most the operation can cost; postOp only refunds).
 */
export interface AaTokenGas {
  /** Circle's paymaster (CIRCLE_TOKEN_PAYMASTER_V07.testnetAddress on Base Sepolia). */
  paymaster: string;
  /** The fee token; equals the paymaster's on-chain token(). */
  token: string;
  symbol: string;
  /** tokenDecimals() of the paymaster. */
  decimals: number;
  /** The worst-case charge in token base units (the permit's exact value cap). */
  maxTokenCharge: bigint;
  /** The EntryPoint prefund in wei the worst case converts (maxCost). */
  requiredPrefundWei: bigint;
  /** additionalGasCharge * maxFeePerGas + requiredPrefundWei. */
  worstCaseWei: bigint;
  /** fetchPrice(): base units of the token per 1e18 wei, from the paymaster's oracle. */
  nativeTokenPrice: bigint;
  /** feeSpread() in basis points, read from the paymaster. */
  feeSpreadBips: bigint;
  /** additionalGasCharge() of the paymaster (gas). */
  additionalGasCharge: bigint;
  /** oracle() of the paymaster. */
  oracle: string;
  /** The smart account's fee-token balance as read for the quote. */
  tokenBalance: bigint;
  /** verification + call + preVerification gas assumed for the worst case. */
  estimationGasCeiling: bigint;
  /** paymasterVerificationGasLimit assumed for the worst case (and the stub). */
  paymasterVerificationGasLimit: bigint;
  /** paymasterPostOpGasLimit used for the worst case and the operation. */
  paymasterPostOpGasLimit: bigint;
  /**
   * Absent: Circle's permissionless on-chain paymaster (the fields above
   * mean what they say). 'erc7677': a PERMISSIONED token paymaster reached
   * over ERC-7677 on the configured bundler endpoint (Pimlico's ERC-20
   * paymaster on Ethereum Sepolia; packages/chains-evm/src/
   * erc7677-token-paymaster.ts). For that source the Circle-only fields
   * carry: nativeTokenPrice = the exchange rate Pimlico's stub answer
   * offered (same unit: token base units per 1e18 wei); feeSpreadBips = 0n
   * (there is no on-chain spread; the markup is inside the rate);
   * additionalGasCharge = the stub's postOpGas; oracle = '' (no on-chain
   * oracle); estimationGasCeiling = verification + call + preVerification
   * gas of the padded bundler estimate; and `erc7677` below holds the rest.
   */
  source?: 'erc7677';
  erc7677?: AaErc7677TokenGas;
}

/**
 * The ERC-7677 token-paymaster part of a USDC-fee quote (./token-gas.ts
 * builds it). maxTokenCharge (above) is BOTH the displayed worst case and the
 * exact amount the operation's first call approves; the engine transport
 * refuses final paymaster data whose bound exceeds it, and the token
 * contract refuses any transferFrom above the approval.
 */
export interface AaErc7677TokenGas {
  /** The vendor that sets the rate and signs each operation ("Pimlico"). */
  vendor: string;
  /** The bound over the padded estimate at the stub's terms, before the headroom. */
  boundAtQuote: bigint;
  /** Headroom (percent) added to boundAtQuote to give maxTokenCharge. */
  headroomPercent: bigint;
  /** Fixed postOp gas the paymaster charges for (from its signed data). */
  postOpGas: bigint;
  /** Constant fee in token base units (0n unless the paymaster data carries one). */
  constantFee: bigint;
  /** Where the paymaster sends the charge (its treasury, from the signed data). */
  treasury: string;
  /** Whether the paymaster is staked in the EntryPoint on this chain. */
  staked: boolean;
  /** The approval the paymaster already had before this operation (replaced by it). */
  allowanceBefore: bigint;
}

/**
 * Gas assumed for verification + call + preVerification when the USDC worst
 * case is computed before the biometric gate. It is the engine's own
 * default for the stub permit (createCirclePaymasterTransport,
 * packages/chains-evm/src/token-paymaster.ts line 699), passed explicitly so
 * the figure on the confirm screen and the stub permit signed at send time
 * are the same number.
 */
export const TOKEN_GAS_ESTIMATION_CEILING = 1_500_000n;

/**
 * Padding on the bundler's estimate for USDC-fee operations: the values of
 * the live Base Sepolia proof (scripts/testnet/token-gas-smoke.mjs line 604,
 * userOpHash 0x49f93a11…f7f6 accepted by ZeroDev's bundler on 2026-10-04),
 * kept identical so the app runs the configuration that was proven.
 */
export const TOKEN_GAS_PADDING_PCT = { verification: 110, call: 130, preVerification: 105 } as const;

/** Refusal when a USDC-fee quote reaches an account type it was never offered for. */
export const TOKEN_GAS_ACCOUNT_REFUSAL =
  'Paying the network fee in USDC needs a Kernel v3.3 smart account at its own address that pays its own ' +
  'gas (no sponsoring paymaster). Nothing was signed; review the send again.';

/** Convenience alias: a quote for any list of calls. */
export type AaCallsQuote = AaSendQuote;

// ---------------------------------------------------------------------------
// Funding, quote-failure wording, approval prompt and bundler-host notes
// (phase 11 item 2 follow-ups: bugs A, B and C of the in-app Kernel
// deployment run on 2026-10-03)
// ---------------------------------------------------------------------------

/** Alert/form title for a smart account that cannot pay for the operation. */
export const AA_FUNDING_TITLE = 'Your smart account needs funds first.';

/**
 * Title for any failure while a quote is being prepared (review step). Nothing
 * has been signed or sent at that point, so "could not be sent" would be
 * wrong.
 */
export const QUOTE_FAILED_TITLE = 'The quote could not be prepared.';

/** The generic title describeSendError (./send.ts) uses for unrecognized errors. */
const GENERIC_SEND_FAILURE_TITLE = 'The transaction could not be sent.';

/**
 * Re-titles a described error for the quote (review) step: the generic
 * "could not be sent" title becomes QUOTE_FAILED_TITLE; specific titles
 * (insufficient funds, unreachable endpoint, …) are kept, and the detail (and
 * any technical line) is never changed.
 */
export function retitleQuoteFailure<D extends { title: string; detail: string }>(described: D): D {
  return described.title === GENERIC_SEND_FAILURE_TITLE ? { ...described, title: QUOTE_FAILED_TITLE } : described;
}

/**
 * Title for a refusal where the smart account holds funds — enough to pay
 * for some send — but not for THIS amount (plus the network fee when the
 * account pays it in the same currency). AA_FUNDING_TITLE stays for an
 * account that could not pay for any send at all (empty, or unable to cover
 * even the fee).
 */
export function aaAmountShortfallTitle(symbol: string, withFee: boolean): string {
  return withFee
    ? `Not enough ${symbol} for this amount plus the network fee.`
    : `Not enough ${symbol} for this amount.`;
}

/** The chain's display currency ("ETH", "test ETH") for funding titles. */
function nativeSymbolFor(chainId: bigint): string {
  return evmProfileByCaip2(`eip155:${chainId}`)?.displaySymbol ?? 'ETH';
}

/**
 * Thrown when the smart account cannot pay for an operation (the wallet's
 * own check, or a bundler AA21 "didn't pay prefund" answer). `sender` is the
 * smart account that needs the funds; `title` is what describeAaError shows
 * (AA_FUNDING_TITLE unless the refusal is an amount shortfall, see
 * aaAmountShortfallTitle).
 */
export class AaFundingError extends Error {
  sender: string;
  title: string;
  // No TS parameter properties: Node's strip-only type stripping rejects them.
  constructor(sender: string, message: string, title: string = AA_FUNDING_TITLE) {
    super(message);
    this.sender = sender;
    this.title = title;
    this.name = 'AaFundingError';
  }
}

/**
 * True for the EntryPoint's AA21 failure code ("didn't pay prefund"): the
 * account's balance plus its EntryPoint deposit cannot cover the operation's
 * prefund (account-abstraction v0.7.0 EntryPoint._validateAccountPrepayment).
 */
export function isPrefundError(message: string): boolean {
  return /\bAA21\b/.test(message);
}

/**
 * The plain-language funding message. It always names the smart account's
 * full address, because that address (not the owner's) is the one to fund,
 * and a new account's address appears nowhere else until it is used. Amounts
 * are exact wei. `fee` null means the fee is not known yet (the check ran
 * before the bundler estimate).
 *
 * `deployed` decides the last sentence: only an account that is not deployed
 * yet is told that it can be funded before deployment (the rehearsal of
 * 2026-10-03 showed that sentence for a deployed account, finding 8); null
 * (unknown) omits it. `deposit` is the account's EntryPoint deposit when it
 * was read: the EntryPoint v0.7 takes the prefund from the deposit first and
 * asks the account only for the rest (_validateAccountPrepayment), so a
 * non-zero deposit is named as part of what pays the fee.
 */
export function aaFundingMessage(p: {
  sender: string;
  amount: bigint;
  fee: bigint | null;
  balance: bigint;
  sponsored: boolean;
  deployed?: boolean | null;
  deposit?: bigint | null;
}): string {
  const fund =
    `Fund the smart account address ${p.sender} (not the owner address), then review again.` +
    (p.deployed === false
      ? ' A smart account can receive funds before it is deployed; the first send deploys it.'
      : '');
  if (p.sponsored) {
    return (
      `Insufficient funds: sending ${p.amount} wei exceeds the balance of ${p.balance} wei held by ` +
      `the smart account ${p.sender} (gas is sponsored, but the amount is not). ${fund}`
    );
  }
  const deposit = p.deposit ?? 0n;
  if (p.amount === 0n) {
    // An operation that sends no native currency (a set-up such as a session
    // or subscription install, a token send): saying "sending 0 wei plus its
    // network fee" (the 2026-10-09 rehearsal) names an amount nobody chose.
    const fee = p.fee === null ? 'this operation’s network fee' : `this operation’s worst-case fee of ${p.fee} wei`;
    const heldZero =
      deposit > 0n
        ? `the balance of ${p.balance} wei held by the smart account ${p.sender} plus its EntryPoint deposit ` +
          `of ${deposit} wei`
        : `the balance of ${p.balance} wei held by the smart account ${p.sender}`;
    return `Insufficient funds: the smart account pays its own gas (no paymaster), and ${fee} exceeds ${heldZero}. ${fund}`;
  }
  const feePart = p.fee === null ? 'its network fee' : `a worst-case fee of ${p.fee} wei`;
  const held =
    deposit > 0n
      ? `the balance of ${p.balance} wei held by the smart account ${p.sender} plus its EntryPoint ` +
        `deposit of ${deposit} wei (the deposit can pay only the fee, not the amount)`
      : `the balance of ${p.balance} wei held by the smart account ${p.sender}`;
  return (
    'Insufficient funds: the smart account pays its own gas (no paymaster), and sending ' +
    `${p.amount} wei plus ${feePart} exceeds ${held}. ${fund}`
  );
}

/**
 * The funding message for an AA21 ("didn't pay prefund") refusal of the
 * bundler's ESTIMATE of an operation that sends no native currency (a
 * set-up: a session, subscription, recurring-payment, guardian or passkey
 * install; finding 2 of the 2026-10-09 recurring-payments rehearsal, where
 * the old text read "sending 0 wei plus its network fee exceeds the
 * balance…" and named nothing to fund). AA21 means the EntryPoint's
 * validation could not collect the operation's worst-case fee (its
 * prefund) from the account's deposit plus balance (account-abstraction
 * v0.7.0, EntryPoint._validateAccountPrepayment); the bundler computes
 * that prefund from gas limits it never returned, so no exact figure
 * exists to show. The caller appends the bundler's own text as technical
 * detail.
 */
export function aaEstimateFundingMessage(p: {
  sender: string;
  balance: bigint;
  deposit?: bigint | null;
  deployed?: boolean | null;
}): string {
  const deposit = p.deposit ?? 0n;
  const holds =
    deposit > 0n
      ? `It holds ${p.balance} wei plus an EntryPoint deposit of ${deposit} wei`
      : `It holds ${p.balance} wei`;
  return (
    `The bundler refused to estimate this operation because the smart account ${p.sender} cannot pay ` +
    `the operation's network fee. ${holds}, and the network fee must be available up front, before ` +
    'the operation runs. The exact fee is not known, because the bundler refused the estimate itself. ' +
    `Fund the smart account address ${p.sender} (not the owner address), then review again.` +
    (p.deployed === false
      ? ' A smart account can receive funds before it is deployed; the first operation deploys it.'
      : '')
  );
}

/**
 * True when a self-paid operation is affordable: the EntryPoint v0.7 takes
 * the prefund (the worst-case fee) from the account's deposit first and the
 * account pays only the missing part from its balance during validation
 * (EntryPoint._validateAccountPrepayment); the amount itself always comes
 * from the balance. `deposit` null (not read) counts as zero.
 */
export function aaCanPaySelf(p: { amount: bigint; fee: bigint; balance: bigint; deposit: bigint | null }): boolean {
  return p.amount + aaFeeFromBalance(p.fee, p.deposit) <= p.balance;
}

/**
 * The part of a self-paid operation's worst-case fee that the account's
 * BALANCE must supply: the EntryPoint v0.7 takes the prefund from the
 * deposit first and asks the account for the rest during validation
 * (EntryPoint._validateAccountPrepayment). `deposit` null (not read) counts
 * as zero. The single rule aaCanPaySelf and the subscription review use.
 */
export function aaFeeFromBalance(fee: bigint, deposit: bigint | null | undefined): bigint {
  const d = deposit ?? 0n;
  return fee > d ? fee - d : 0n;
}

/** Row label for a smart account's EntryPoint deposit on a confirm screen. */
export const AA_DEPOSIT_ROW_LABEL = 'EntryPoint deposit (pays fees first)';

/**
 * What the deposit is, under its row. EntryPoint v0.7 (account-abstraction
 * v0.7.0, core/EntryPoint.sol): during validation the account is asked
 * only for requiredPrefund minus its deposit (_validateAccountPrepayment),
 * the prefund is then taken from the deposit, and after execution the
 * unused part of the prefund is credited back to the DEPOSIT
 * (_postExecution, `_incrementDeposit(refundAddress, refund)` with the
 * sender as refundAddress when there is no paymaster), not to the account's
 * balance. The wallet offers no withdrawal (EntryPoint.withdrawTo would
 * need an operation of its own), so the deposit is used up by later fees.
 */
export const AA_DEPOSIT_NOTE =
  'The EntryPoint holds this deposit for the smart account and takes network fees from it first. It ' +
  'cannot be sent as an amount (Max leaves it out), and this wallet does not offer a way to withdraw it; ' +
  'later operations use it for their fees.';

/** The plain sentence when the smart account has no EntryPoint deposit (or it could not be read). */
export const AA_SELF_PAID_FEE_SENTENCE = 'The smart account pays its own gas from its own balance.';

/**
 * Who pays a self-paid smart-account fee, for the confirm screen (finding 7
 * of the 2026-10-04 private-key run: "The smart account pays its own gas
 * from its own balance." was shown although the deposit paid). The rules
 * are EntryPoint v0.7's, as in AA_DEPOSIT_NOTE: a deposit at or above the
 * worst-case fee pays all of it; a smaller one pays first and the balance
 * tops it up by the rest of the worst case, whose unused part then stays in
 * the deposit. `format` renders a wei amount with its unit.
 */
export function aaSelfPaidFeeSentence(
  p: { fee: bigint; deposit?: bigint | null },
  format: (wei: bigint) => string,
): string {
  const deposit = p.deposit ?? 0n;
  if (deposit <= 0n) return AA_SELF_PAID_FEE_SENTENCE;
  if (deposit >= p.fee) {
    return (
      `The smart account's EntryPoint deposit (${format(deposit)}) covers this whole worst-case fee, so ` +
      'nothing for gas comes from its balance; the deposit is reduced by what the operation actually uses.'
    );
  }
  return (
    `The fee comes first from the smart account's EntryPoint deposit (${format(deposit)}); its balance tops ` +
    `the deposit up by the rest of the worst case, up to ${format(p.fee - deposit)}. What the operation ` +
    'does not use stays in the deposit for later fees; it does not return to the balance.'
  );
}

/**
 * Upper bound on re-pricing rounds when a smart-account Max amount is
 * lowered at quote time (the EOA path's MAX_TRIM_ROUNDS in ./send.ts, same
 * reason): the amount is part of the calldata the bundler prices
 * (preVerificationGas charges zero and non-zero calldata bytes
 * differently), so after lowering it the operation is estimated again.
 * After the bound the ordinary funding refusal applies.
 */
export const AA_MAX_TRIM_ROUNDS = 3;

/**
 * The confirm screen's sentence for a smart-account Max amount that the
 * quote lowered. `format` renders wei in the chain's display units.
 */
export function aaMaxAdjustmentSentence(
  quote: Pick<AaSendQuote, 'amount' | 'maxAdjustment'>,
  format: (value: bigint) => string,
): string | null {
  if (!quote.maxAdjustment) return null;
  return (
    `The amount was lowered from ${format(quote.maxAdjustment.requested)} to ${format(quote.amount)} ` +
    'because the network fee rose after you tapped Max. The amount plus the worst-case fee now fits the ' +
    "smart account's balance; its EntryPoint deposit, if any, is left as a reserve for the fee."
  );
}

/** Neutral confirm-screen sentence for a Kernel deployment through any non-Alchemy bundler. */
export const KERNEL_DEPLOYMENT_NEUTRAL_NOTE = 'Deployment goes through the configured bundler.';

/**
 * True when the configured bundler is an Alchemy endpoint (host g.alchemy.com
 * or a subdomain of it, e.g. eth-sepolia.g.alchemy.com). The host is taken
 * from maskUrlForDisplay's output, never from the full URL, so the API key
 * in the path or query is never inspected or passed along.
 */
export function isAlchemyBundlerUrl(bundlerUrl: string | null | undefined): boolean {
  if (!bundlerUrl) return false;
  const match = /^https?:\/\/([^/?#]+)/i.exec(maskUrlForDisplay(bundlerUrl));
  if (!match) return false;
  const host = match[1]!.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  return host === 'g.alchemy.com' || host.endsWith('.g.alchemy.com');
}

/**
 * Settings sentence for a Kernel account on a chain with no bundler saved
 * yet: the neutral sentence would claim a "configured bundler" that does
 * not exist (Base Sepolia finding 5).
 */
export const KERNEL_DEPLOYMENT_NO_BUNDLER_NOTE =
  'No bundler is configured yet; once one is saved, the first smart-account send deploys the account through it.';

/**
 * The note for an operation that deploys a Kernel account (Send confirm and
 * the Settings AA section): the Alchemy limitation (KERNEL_BUNDLER_NOTE)
 * only when the configured bundler is Alchemy's, the no-bundler sentence
 * when none is saved, otherwise the neutral sentence.
 */
export function kernelDeploymentNote(bundlerUrl: string | null | undefined): string {
  if (!bundlerUrl) return KERNEL_DEPLOYMENT_NO_BUNDLER_NOTE;
  return isAlchemyBundlerUrl(bundlerUrl) ? KERNEL_BUNDLER_NOTE : KERNEL_DEPLOYMENT_NEUTRAL_NOTE;
}

/**
 * The Settings status line for a saved bundler. It names the chain id the
 * bundler reported through eth_chainId when the save ran that check
 * (verifyAaBundlerChain, which runs first), and says that the check did not
 * run for a bundler saved before it existed, instead of implying it did.
 * `checked` is the already formatted local date (config/dates.ts).
 */
export function bundlerVerifiedLine(
  config: Pick<AaChainConfig, 'bundlerChainIdVerified'>,
  chainLabel: string,
  checked: string,
): string {
  if (config.bundlerChainIdVerified) {
    return (
      `Verified ✓ — the bundler reported chain id ${config.bundlerChainIdVerified} (${chainLabel}) and ` +
      `eth_supportedEntryPoints includes EntryPoint v0.7 (checked ${checked})`
    );
  }
  return (
    `Verified ✓ — eth_supportedEntryPoints includes EntryPoint v0.7 (checked ${checked}). ` +
    'Saved before the chain-id check existed: save it again to confirm which network it serves.'
  );
}

/**
 * The biometric prompt title for a smart-account send, naming the amount
 * and asset like the regular-address path ("Approve sending 0.0001 test
 * ETH") plus where it comes from. `amountWithSymbol` is the QUOTED amount
 * (the one that will be signed) followed by the asset symbol; the Send
 * screen builds it through sendApprovalPromptTitle, never from the form.
 */
export function aaSendApprovalPrompt(
  quote: Pick<AaSendQuote, 'eip7702' | 'recovered'>,
  amountWithSymbol: string,
): string {
  const from = quote.eip7702
    ? 'your upgraded account'
    : quote.recovered
      ? 'your recovered smart account'
      : 'your smart account';
  return `Approve sending ${amountWithSymbol} from ${from}`;
}

/**
 * Full-precision display of a base-unit amount: every digit, trailing zeros
 * dropped, never rounded. The Send screen's confirm "Amount" rows and its
 * biometric prompt both use this, so the two always show the same figure.
 */
export function exactAmountText(amount: bigint, decimals: number): string {
  return formatUnits(amount, decimals, decimals);
}

/**
 * The fields of a Send quote that the biometric prompt title is built from.
 * The shapes are structural so this module needs no import of the regular,
 * token or NFT send modules; the real quote objects satisfy them.
 */
export type SendApprovalQuote =
  | Pick<AaSendQuote, 'kind' | 'amount' | 'token' | 'eip7702' | 'recovered'>
  | { kind: 'erc20'; amount: bigint; symbol: string; decimals: number }
  | { kind: 'evm' | 'sol' | 'utxo'; amount: bigint };

/**
 * The biometric prompt title for a Send of a coin or a fungible token,
 * built from the QUOTE, which is exactly what will be signed. It must never
 * come from the amount field's text: when the quote lowered a Max amount
 * (maxAdjustment on a regular-address or smart-account quote), the form
 * still holds the higher figure, and the prompt must name the lowered one.
 *
 * `symbol` and `decimals` describe the native asset (or, for the regular
 * Bitcoin, Dogecoin and Solana paths, the account's coin). A quote that
 * carries its own token fields (an ERC-20 quote, or a smart-account quote
 * with `token`) uses those, as the confirm screen does. The amount text is
 * exactAmountText, the same as the confirm's "Amount" row. For an amount
 * typed in canonical form ("0.0001", "2", "1.5") the title is the same
 * string as the earlier title built from the typed text; a typed form with
 * trailing zeros ("1.50") is now shown as the confirm shows it ("1.5").
 *
 * NFT sends keep their own title (the item's name, and a count for
 * ERC-1155), built on the Send screen from the quote.
 */
export function sendApprovalPromptTitle(
  quote: SendApprovalQuote,
  symbol: string,
  decimals: number,
): string {
  if (quote.kind === 'aa') {
    const amountWithSymbol = quote.token
      ? `${exactAmountText(quote.token.amount, quote.token.decimals)} ${quote.token.symbol}`
      : `${exactAmountText(quote.amount, decimals)} ${symbol}`;
    return aaSendApprovalPrompt(quote, amountWithSymbol);
  }
  if (quote.kind === 'erc20') {
    return `Approve sending ${exactAmountText(quote.amount, quote.decimals)} ${quote.symbol}`;
  }
  return `Approve sending ${exactAmountText(quote.amount, decimals)} ${symbol}`;
}

/**
 * How the Send form names the paymaster that takes the USDC fee. These are
 * the same phrases tokenGasConfirmLines (token-gas.ts) returns as
 * `throughPhrase` for each source, so the form and the confirm agree.
 */
export function tokenGasThroughPhrase(
  source: { kind: 'circle' } | { kind: 'erc7677'; vendor: string },
): string {
  return source.kind === 'erc7677' ? `${source.vendor}\u2019s paymaster` : 'Circle\u2019s paymaster';
}

/**
 * The fee sentence in the Send form's token box ("Sending USDC … from your
 * smart account."). It follows the fee mode the form will quote: with the
 * USDC-fee choice switched on (`feeToken` given), the fee is paid in that
 * token through the paymaster; otherwise in the native asset, as before.
 */
export function sendFormTokenFeeSentence(p: {
  nativeSymbol: string;
  tokenSymbol: string;
  feeToken: { symbol: string; throughPhrase: string } | null;
}): string {
  if (!p.feeToken) return `The network fee is paid in ${p.nativeSymbol}, not in ${p.tokenSymbol}.`;
  return (
    `The network fee is paid in ${p.feeToken.symbol} through ${p.feeToken.throughPhrase}, ` +
    `not in ${p.nativeSymbol}; Review shows the most it can cost.`
  );
}

// ---------------------------------------------------------------------------
// Smart-account address for display (Send form, Receive)
// ---------------------------------------------------------------------------

/** The smart-account address of one owner on one chain, for display. */
export interface SmartAccountAddressInfo {
  /** EIP-55 address (counterfactual until deployed). */
  address: string;
  /** True when eth_getCode at the address is non-empty. */
  deployed: boolean;
  accountType: AaAccountType;
  /** True for a recovered Kernel account attached to the owner. */
  recovered: boolean;
}

/** Deployment state line under a displayed smart-account address. */
export const SMART_ACCOUNT_NOT_DEPLOYED_NOTE = 'Not deployed yet — the first send deploys it.';
export const SMART_ACCOUNT_DEPLOYED_NOTE = 'Deployed.';

export function smartAccountDeploymentNote(deployed: boolean): string {
  return deployed ? SMART_ACCOUNT_DEPLOYED_NOTE : SMART_ACCOUNT_NOT_DEPLOYED_NOTE;
}

/** Row label for a displayed smart-account address. */
export function smartAccountAddressLabel(info: Pick<SmartAccountAddressInfo, 'accountType' | 'recovered'>): string {
  if (info.recovered) return 'Recovered smart account (Kernel v3.3)';
  if (info.accountType === 'kernel-v3.3') return 'Smart account (Kernel v3.3)';
  if (info.accountType === 'simple') return 'Smart account (SimpleAccount)';
  return 'Smart account';
}

/**
 * Send form: true when the smart-account toggle is offered (isAaConfigured)
 * and the smart account has an address of its own. An EIP-7702 upgraded
 * owner sends from its own address, so there is nothing extra to show.
 */
export function showsSmartAccountAddressOnSend(config: AaChainConfig, owner: string | null | undefined): boolean {
  return Boolean(owner) && isAaConfigured(config, owner) && !isEip7702Owner(config, owner);
}

/**
 * Receive: true only when the chain's smart-account configuration is
 * complete (and allowed on this network) and the owner's account type is a
 * factory-deployed Kernel v3.3. Not for SimpleAccount, not for an EIP-7702
 * upgrade (same address as the EOA), and not for a recovered account (the
 * Receive screen already names that one with its own note).
 */
export function showsSmartAccountOnReceive(config: AaChainConfig, owner: string | null | undefined): boolean {
  return (
    Boolean(owner) &&
    isAaConfigured(config, owner) &&
    !isEip7702Owner(config, owner) &&
    recoveredAccountFor(config, owner) === null &&
    config.accountType === 'kernel-v3.3'
  );
}

const smartAccountAddressCache = new Map<string, SmartAccountAddressInfo>();

/** Forgets cached display info for `address` (all owners/chains), or everything. */
export function forgetSmartAccountAddress(address?: string): void {
  if (address === undefined) {
    smartAccountAddressCache.clear();
    return;
  }
  const lower = address.toLowerCase();
  for (const [key, info] of smartAccountAddressCache) {
    if (info.address.toLowerCase() === lower) smartAccountAddressCache.delete(key);
  }
}

/**
 * Reads the owner's smart-account address and deployment state for display.
 * Read-only and node-only: eth_chainId (must equal `chainId`), the spec's
 * getAddress (for Kernel, the factory's answer checked against the local
 * CREATE2 prediction), then eth_getCode. No bundler call, no key. Cached per
 * chain + account index + owner + configured factory/type for the session;
 * the entry is dropped when an operation from that address is accepted
 * (sendAa), so "not deployed yet" updates after the deploying send. Returns
 * null for an EIP-7702 upgraded owner (same address as the EOA).
 */
export async function loadSmartAccountAddress(
  config: AaChainConfig,
  options: {
    nodeUrl: string;
    chainId: bigint;
    accountIndex: number;
    ownerAddress: string;
    transportFor?: TransportFactory;
    /** Bypass the cache. */
    force?: boolean;
  },
): Promise<SmartAccountAddressInfo | null> {
  if (isEip7702Owner(config, options.ownerAddress)) return null;
  const recovered = recoveredAccountFor(config, options.ownerAddress);
  const key = [
    config.chain ?? '',
    options.chainId.toString(),
    String(options.accountIndex),
    options.ownerAddress.toLowerCase(),
    config.accountType,
    (config.factory ?? '').toLowerCase(),
    (recovered ?? '').toLowerCase(),
  ].join('|');
  if (!options.force) {
    const cached = smartAccountAddressCache.get(key);
    if (cached) return cached;
  }
  const bundle = createAaClientFromConfig(config, {
    nodeUrl: options.nodeUrl,
    chainId: options.chainId,
    accountIndex: options.accountIndex,
    ownerAddress: options.ownerAddress,
    ...(options.transportFor ? { transportFor: options.transportFor } : {}),
  });
  const endpointChain = await new NodeClient(bundle.node).chainId();
  if (endpointChain !== options.chainId) {
    throw new Error(
      `Endpoint is chain id ${endpointChain}, expected ${options.chainId}. Check the RPC endpoint in Settings.`,
    );
  }
  const address = toChecksumAddress(
    toBytes((await resolveAaSender(bundle, options.ownerAddress)).toLowerCase()),
  );
  const code = await bundle.node('eth_getCode', [address, 'latest']);
  const deployed = typeof code === 'string' && !/^0x0*$/i.test(code);
  const info: SmartAccountAddressInfo = {
    address,
    deployed,
    accountType: bundle.accountType,
    recovered: recovered !== null,
  };
  smartAccountAddressCache.set(key, info);
  return info;
}

/**
 * What an owner key controls besides its own address on one network, for
 * the "remove this imported key" dialog (finding 5 of the 2026-10-04
 * private-key run: the dialog said "Funds on-chain are not moved" without
 * naming the smart account and its EntryPoint deposit, which the key alone
 * controls):
 *  - 'none': the network has no complete smart-account settings for this
 *    owner, so the wallet never built a smart account for it here;
 *  - 'smart-account': the owner's factory smart account (Kernel or
 *    SimpleAccount), its deployment state, balance and EntryPoint deposit;
 *  - 'eip7702': the owner's own address is upgraded with EIP-7702 here; its
 *    EntryPoint deposit (the address's own balance is the account's);
 *  - 'unknown': settings exist but a read failed (best effort; the caller
 *    says so instead of blocking).
 */
export type OwnerSmartAccountHoldings =
  | { kind: 'none' }
  | {
      kind: 'smart-account';
      network: string;
      symbol: string;
      address: string;
      deployed: boolean;
      balance: bigint;
      deposit: bigint;
    }
  | { kind: 'eip7702'; network: string; symbol: string; address: string; deposit: bigint }
  | { kind: 'unknown'; network: string };

/**
 * Reads OwnerSmartAccountHoldings for `ownerAddress` on the network
 * `config` belongs to. Read-only and node-only (eth_chainId, the spec's
 * getAddress, eth_getCode, eth_getBalance and the EntryPoint's balanceOf);
 * no bundler call and no key. Never throws: any failure is 'unknown'.
 */
export async function readOwnerSmartAccountHoldings(
  config: AaChainConfig,
  options: {
    nodeUrl: string;
    chainId: bigint;
    accountIndex: number;
    ownerAddress: string;
    transportFor?: TransportFactory;
  },
): Promise<OwnerSmartAccountHoldings> {
  const network = evmProfileByCaip2(`eip155:${options.chainId}`)?.label ?? `chain id ${options.chainId}`;
  const symbol = nativeSymbolFor(options.chainId);
  try {
    if (!hasCompleteAaSettings(config, options.ownerAddress)) return { kind: 'none' };
    const bundle = createAaClientFromConfig(config, {
      nodeUrl: options.nodeUrl,
      chainId: options.chainId,
      accountIndex: options.accountIndex,
      ownerAddress: options.ownerAddress,
      ...(options.transportFor ? { transportFor: options.transportFor } : {}),
    });
    const node = new NodeClient(bundle.node);
    if ((await node.chainId()) !== options.chainId) return { kind: 'unknown', network };
    if (isEip7702Owner(config, options.ownerAddress)) {
      const deposit = await bundle.client.getEntryPointDeposit(options.ownerAddress);
      return { kind: 'eip7702', network, symbol, address: options.ownerAddress, deposit };
    }
    const address = toChecksumAddress(toBytes((await resolveAaSender(bundle, options.ownerAddress)).toLowerCase()));
    const [code, balance, deposit] = await Promise.all([
      bundle.node('eth_getCode', [address, 'latest']),
      node.getBalance(address),
      bundle.client.getEntryPointDeposit(address),
    ]);
    const deployed = typeof code === 'string' && !/^0x0*$/i.test(code);
    return { kind: 'smart-account', network, symbol, address, deployed, balance, deposit };
  } catch {
    return { kind: 'unknown', network };
  }
}

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
  options: {
    tokenSpend?: AaTokenSpend;
    displayTo?: string;
    token?: AaTokenTransfer;
    /**
     * True when the amount of a plain native transfer is exactly what the
     * smart-account Max button produced (SendScreen compares the amount text
     * with the last Max result). See the Max section below.
     */
    fromMax?: boolean;
  } = {},
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
  // Node reads only: the bundler is not contacted until the wallet's own
  // funding check below has passed.
  // The EntryPoint deposit is one eth_call (balanceOf on the EntryPoint);
  // it is read for self-paid operations only, because it can pay the fee
  // (see aaCanPaySelf). A failed read counts as no deposit, which is the
  // stricter side and what the wallet assumed before it was read here.
  const [senderBalance, deployed, nonce, suggestedFees, tokenBalance, deposit] = await Promise.all([
    nodeClient.getBalance(sender),
    eip7702 ? Promise.resolve(!eip7702.upgrade) : bundle.client.isDeployed(owner),
    bundle.client.getNonce(owner),
    suggestFeesRetryingOnce(nodeClient),
    options.tokenSpend
      ? fetchTokenBalanceVia(bundle.node, options.tokenSpend.contract, sender)
      : Promise.resolve(null),
    bundle.sponsored ? Promise.resolve(null) : bundle.client.getEntryPointDeposit(sender).catch(() => null),
  ]);

  if (options.tokenSpend && tokenBalance !== null && options.tokenSpend.amount > tokenBalance) {
    throw new Error(
      `Sending ${options.tokenSpend.amount} base units of ${options.tokenSpend.symbol} exceeds ` +
        `the token balance of ${tokenBalance} base units held by the smart account ${sender}. ` +
        'Smart-account sends spend the smart account’s tokens, not the owner address’s.',
    );
  }

  const requested = calls.reduce((sum, c) => sum + c.value, 0n);
  let amount = requested;
  // Smart-account Max (mirrors prepareEvmSend's fromMax in ./send.ts): Max
  // subtracts one fee snapshot (maxAaSend), Review quotes again with fresh
  // fees and a fresh bundler estimate, and a small rise would otherwise make
  // the wallet refuse its own Max. Only a self-paid plain native transfer (one
  // call, no calldata) whose amount came from Max is ever lowered; typed
  // amounts, contract calls, batches and sponsored operations are not.
  //
  // DEPOSIT RULE FOR MAX (a decision): a Max amount must fit beside the FULL
  // worst-case fee, i.e. amount + fee <= balance, ignoring the EntryPoint
  // deposit. SmartAccountClient.sendCalls re-estimates the gas limits when it
  // signs, so the signed fee can be a little above the quoted one; the
  // account pays (fee - deposit) from its balance during validation, before
  // the transfer runs, so the unused deposit is what absorbs such a rise
  // instead of the transfer failing on-chain with the fee already charged.
  // aaCanPaySelf (typed amounts) still lets the deposit pay the fee.
  const trimMax =
    options.fromMax === true && !bundle.sponsored && calls.length === 1 && calls[0]!.data.length === 0;
  // Funding pre-check, BEFORE any bundler call. A new smart account starts
  // with a zero balance, and the bundler's estimate of an operation the
  // account cannot pay for fails with a raw "AA21 didn't pay prefund"
  // error that names neither the account nor the remedy. This check is
  // strictly weaker than the worst-case check after the estimate (which
  // adds the gas cost): self-paid, the account must hold MORE than the
  // amount, because any non-zero fee on top would exceed the balance —
  // unless the EntryPoint deposit is non-zero, which may pay the whole fee,
  // so then it must hold at least the amount; sponsored, it must hold at
  // least the amount. So it never refuses an operation the full check would
  // accept.
  // A Max amount may be lowered below, so for it the pre-check asks only
  // whether the account can pay for a zero-value operation at all.
  const checkAmount = trimMax ? 0n : amount;
  const cannotPay = bundle.sponsored
    ? checkAmount > senderBalance
    : (deposit ?? 0n) > 0n
      ? checkAmount > senderBalance
      : suggestedFees.maxFeePerGas > 0n && checkAmount >= senderBalance;
  // The "can be funded before it is deployed" sentence belongs to factory
  // accounts that are not deployed yet; an EIP-7702 account is the owner's own
  // address, so the sentence is left out there (deployed: null).
  const fundingFacts = () => ({
    sender,
    amount,
    balance: senderBalance,
    sponsored: bundle.sponsored,
    deployed: eip7702 ? null : deployed,
    deposit,
  });
  if (cannotPay) {
    // The title says what is short. An account that could pay for SOME send
    // (it holds a balance, or — self-paid — an EntryPoint deposit that can
    // pay a fee; a sponsored account always can) is short only for this
    // amount; an account with nothing keeps AA_FUNDING_TITLE. A zero amount
    // (token sends, the Max probe) is refused here only when the account
    // has nothing at all.
    const canPaySomeSend = bundle.sponsored || senderBalance > 0n || (deposit ?? 0n) > 0n;
    throw new AaFundingError(
      sender,
      aaFundingMessage({ ...fundingFacts(), fee: null }),
      checkAmount > 0n && canPaySomeSend
        ? aaAmountShortfallTitle(nativeSymbolFor(bundle.chainId), !bundle.sponsored)
        : AA_FUNDING_TITLE,
    );
  }

  // The bundler's floor plus AA_FEE_FLOOR_HEADROOM_PERCENT: sendAa never
  // raises these fees after the review, so a modest rise of the floor
  // between this quote and the send must already fit.
  const fees = quoteFeesOverFloor(suggestedFees, await bundlerFeeFloor(bundle.bundler));

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
  // Prices one candidate call list: the bundler estimate (the AA path's
  // pre-flight gate) plus the deposit top-up headroom, and the worst-case fee.
  const price = async (candidate: Call[]) => {
    const op: UserOperation = {
      sender,
      nonce,
      ...(factoryArgs
        ? { factory: factoryArgs.factory, factoryData: factoryArgs.factoryData }
        : {}),
      callData: bundle.spec.encodeCalls(candidate),
      callGasLimit: 0n,
      verificationGasLimit: 0n,
      preVerificationGas: 0n,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      signature: bundle.spec.stubSignature(),
      ...(stubAuth ? { eip7702Auth: stubAuth } : {}),
    };
    let estimated: Awaited<ReturnType<BundlerClient['estimateUserOperationGas']>>;
    try {
      // Checked: an estimate with an impossible (zero) limit is asked for
      // again and, if it stays impossible, refused here, so it never
      // reaches a confirm screen (ImpossibleGasEstimateError →
      // describeAaError).
      estimated = await new BundlerClient(bundle.bundler, ENTRYPOINT_V07).estimateUserOperationGasChecked(
        op,
        bundle.estimateRetries ?? AA_ESTIMATE_RETRIES,
      );
    } catch (e) {
      // The pre-check above cannot see the gas, so an account holding a
      // little more than the amount can still fail the bundler's simulation
      // with AA21. Say what it means and which address to fund, keeping the
      // bundler's words.
      const raw = e instanceof Error ? e.message : String(e);
      if (isPrefundError(raw)) {
        // A candidate that sends no native currency (a set-up) gets the
        // estimate-specific wording: there is no amount to name, and the
        // fee is unknown because the estimate itself was refused.
        const sendsNothing = candidate.every((c) => c.value === 0n);
        throw new AaFundingError(
          sender,
          (sendsNothing
            ? aaEstimateFundingMessage({ sender, balance: senderBalance, deposit, deployed: eip7702 ? null : deployed })
            : aaFundingMessage({ ...fundingFacts(), fee: null })) + `\n\nThe bundler's message: ${raw}`,
        );
      }
      throw e;
    }
    // Mirror the bundle client's deposit top-up headroom so the confirm
    // screen's worst-case fee and the balance check use the limit that will
    // actually be signed (sendCalls re-estimates and applies the same rule,
    // and, like here, keeps the plain estimate when the deposit read fails).
    // Clients built without the headroom (none configured) are mirrored as
    // such: the plain estimate. The deposit was read once above, with the
    // other node reads, and also counts in the funding checks.
    const headroom = bundle.client.depositTopUpVerificationGas;
    const gas = deposit === null || headroom === 0n
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
    // OP-stack chains (Base Sepolia): NO separate layer 1 data fee is added
    // here, unlike the EOA quotes in send.ts. The bundler's EOA sends the
    // handleOps transaction and pays its L1 data fee; the account repays the
    // bundler through preVerificationGas, which bundlers price to include it
    // (Pimlico's permissionless.js FAQ, docs.pimlico.io/references/
    // permissionless/faqs, read 2026-10-03: "The preVerificationGas accounts
    // for: Gas overhead that can't be calculated onchain; L1 data costs when
    // operating on L2 networks"). ERC-4337 itself (Final, section "Estimating
    // preVerificationGas") leaves the method open ("depends on non-permanent
    // network properties such as operation and data gas pricing"), and the
    // EntryPoint's prefund is gas limits × maxFeePerGas, so the figure below
    // is already the account's worst case. ZeroDev does not document its
    // formula. A read-only comparison on 2026-10-03 (the same counterfactual
    // Kernel deployment op estimated by ZeroDev on both test networks, with a
    // balance state override) gave preVerificationGas 51,428 on Ethereum
    // Sepolia and 56,811 on Base Sepolia — about 5,400 gas more on Base, more
    // than the GasPriceOracle's L1 fee for the op's bytes expressed in gas
    // at its maxFeePerGas (about 1,000 gas). That is consistent with the L1
    // data cost being priced in, not a proof of ZeroDev's formula.
    const gasTotal = gas.callGasLimit + gas.verificationGasLimit + gas.preVerificationGas;
    const worstCaseGasCost = gasTotal * fees.maxFeePerGas;
    // With a paymaster the sponsor pays the gas: the account only needs to
    // cover the amount itself. Self-paid keeps the full worst-case check.
    return { estimated, gas, fee: bundle.sponsored ? 0n : worstCaseGasCost };
  };

  // The single call of a Max transfer with another value.
  const withValue = (value: bigint): Call[] => [{ ...calls[0]!, value }];
  let currentCalls = calls;
  if (trimMax && amount >= senderBalance) {
    // The balance no longer exceeds the Max figure (it fell, or the Max was
    // computed while a paymaster sponsored the gas). A transfer of more than
    // the account can pay is not a safe thing to ask the bundler to
    // simulate, so price a zero-value transfer first, as maxAaSend does.
    const probe = await price(withValue(0n));
    const room = senderBalance > probe.fee ? senderBalance - probe.fee : 0n;
    if (room <= 0n) {
      throw new AaFundingError(sender, aaFundingMessage({ ...fundingFacts(), fee: probe.fee }));
    }
    amount = room;
    currentCalls = withValue(amount);
  }
  let priced = await price(currentCalls);
  if (trimMax) {
    for (let round = 0; round < AA_MAX_TRIM_ROUNDS && amount + priced.fee > senderBalance; round++) {
      const lowered = senderBalance - priced.fee;
      if (lowered <= 0n) break;
      amount = lowered;
      currentCalls = withValue(amount);
      priced = await price(currentCalls);
    }
  }
  const { estimated, gas, fee } = priced;
  const affordable = bundle.sponsored
    ? amount <= senderBalance
    : aaCanPaySelf({ amount, fee, balance: senderBalance, deposit });
  if (!affordable) {
    // Self-paid: if the balance (with the deposit) covers the fee alone, the
    // account is short only for the amount plus the fee; if it cannot cover
    // even the fee, no send would go through and AA_FUNDING_TITLE stays.
    // Sponsored: the fee is not the account's, so only the amount is short.
    const feeAloneFits = bundle.sponsored || aaFeeFromBalance(fee, deposit) <= senderBalance;
    throw new AaFundingError(
      sender,
      aaFundingMessage({ ...fundingFacts(), fee: bundle.sponsored ? null : fee }),
      amount > 0n && feeAloneFits
        ? aaAmountShortfallTitle(nativeSymbolFor(bundle.chainId), !bundle.sponsored)
        : AA_FUNDING_TITLE,
    );
  }

  return {
    kind: 'aa',
    calls: currentCalls,
    to: options.displayTo ?? currentCalls[0]!.to,
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
    ...(deposit !== null ? { deposit } : {}),
    ...(amount !== requested ? { maxAdjustment: { requested } } : {}),
  };
}

/**
 * The calls the user asked for in a smart-account quote, without the one
 * call the wallet itself inserts: an ERC-7677 USDC-fee quote (tokenGas.source
 * 'erc7677', ./token-gas.ts) starts with approve(paymaster, maxTokenCharge)
 * on the fee token, which the confirm screen already explains in its grant
 * box. Only that exact first call is dropped (same token contract, value 0,
 * byte-identical calldata, and at least one call after it); any other
 * approve, including one the user asked for, stays in the list. Every other
 * quote is returned unchanged.
 */
export function aaUserCalls(quote: Pick<AaSendQuote, 'calls' | 'tokenGas'>): readonly Call[] {
  const tg = quote.tokenGas;
  if (!tg || tg.source !== 'erc7677' || quote.calls.length < 2) return quote.calls;
  const inserted = erc7677TokenApproveCall(tg.token, tg.paymaster, tg.maxTokenCharge);
  const first = quote.calls[0]!;
  const sameData =
    first.data.length === inserted.data.length && first.data.every((byte, i) => byte === inserted.data[i]);
  const isInserted = first.to.toLowerCase() === inserted.to.toLowerCase() && first.value === 0n && sameData;
  return isInserted ? quote.calls.slice(1) : quote.calls;
}

/**
 * What the Send confirm's risk card checks for a smart-account quote
 * (finding 1 of the 2026-10-04 emulator run): the first USER call's target
 * and calldata (aaUserCalls: the paymaster approval an ERC-7677 USDC-fee
 * quote inserts is skipped, so the card equals the ETH-fee card for the
 * same send), and, for a token send, the token's RECIPIENT as the
 * counterparty — exactly as the regular-account token path passes it — so
 * the card describes the person or contract receiving the tokens (and the
 * wallet's own accounts as its own), not the token contract.
 */
export function aaRiskWarningTarget(
  quote: Pick<AaSendQuote, 'calls' | 'token' | 'tokenGas'>,
): { to: string; data: Uint8Array; counterparty?: string } {
  const first = aaUserCalls(quote)[0]!;
  return quote.token
    ? { to: first.to, data: first.data, counterparty: quote.token.recipient }
    : { to: first.to, data: first.data };
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
  options: { fromMax?: boolean } = {},
): Promise<AaSendQuote> {
  return prepareAaCalls(
    bundle,
    ownerAddress,
    [{ to, value: amount, data: new Uint8Array(0) }],
    options.fromMax === true ? { fromMax: true } : {},
  );
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
 * The ERC-20 a smart-account token send names, as the screens pass it.
 * `chainCaip2` is the token's own CAIP-2 chain (its CAIP-19 id's chain,
 * tokens.ts): when present, the quote and Max refuse a token from another
 * chain before any request, because tokens are tracked per chain since phase
 * 13 item 1 and the same contract address can mean something else (or
 * nothing) elsewhere. Optional so older callers keep working unchanged.
 */
export interface AaErc20Target {
  contract: string;
  recipient: string;
  symbol: string;
  decimals: number;
  chainCaip2?: string;
}

/**
 * Refuses a token whose CAIP-2 chain is not the bundle's chain (no request
 * is made first). A token without `chainCaip2` is not checked.
 */
export function assertAaTokenChain(bundle: Pick<AaClientBundle, 'chainId'>, token: { symbol: string; chainCaip2?: string }): void {
  if (token.chainCaip2 === undefined) return;
  const expected = eip155Caip2(bundle.chainId);
  if (token.chainCaip2 !== expected) {
    throw new Error(
      `${token.symbol} belongs to ${token.chainCaip2}, but this smart account is on ${expected}. ` +
        'Nothing was quoted; switch to the token\u2019s network to send it.',
    );
  }
}

/**
 * Smart-account ERC-20 send quote: one transfer call, token balance checked
 * against the SMART ACCOUNT, gas (in ETH) checked against the smart
 * account's ETH balance unless sponsored. A token from another chain
 * (`chainCaip2`) is refused before any request.
 */
export async function prepareAaErc20Send(
  bundle: AaClientBundle,
  ownerAddress: string,
  token: AaErc20Target & { amount: bigint },
): Promise<AaSendQuote> {
  assertAaTokenChain(bundle, token);
  // The quote's `token` carries exactly the display fields (never the
  // chain id), so quotes stay key-for-key what they were before.
  const display: AaTokenTransfer = {
    contract: token.contract,
    recipient: token.recipient,
    amount: token.amount,
    symbol: token.symbol,
    decimals: token.decimals,
  };
  return prepareAaCalls(
    bundle,
    ownerAddress,
    aaErc20TransferCalls(token.contract, token.recipient, token.amount),
    {
      tokenSpend: { contract: token.contract, amount: token.amount, symbol: token.symbol },
      displayTo: token.recipient,
      token: display,
    },
  );
}

/**
 * Smart-account token Max: the smart account's full token balance (gas is
 * paid in ETH). Refuses — through the quote's own insufficient-funds error
 * — when the smart account's ETH cannot cover the worst-case fee for
 * sending that balance. Returns 0n for an empty token balance. A token from
 * another chain (`chainCaip2`) is refused before any request.
 */
export async function maxAaErc20Send(
  bundle: AaClientBundle,
  ownerAddress: string,
  token: AaErc20Target,
): Promise<bigint> {
  assertAaTokenChain(bundle, token);
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
 * recipient (gas for a simple native transfer depends on the amount only
 * through a few calldata bytes; prepareAaCalls with fromMax re-prices the
 * exact amount at Review). Returns 0n when fees exceed the balance. The
 * EntryPoint deposit is deliberately NOT added: it stays as the reserve
 * that absorbs a fee rise at signing time (see the deposit rule for Max in
 * prepareAaCalls).
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

/**
 * Calls `onChange` whenever something that decides smart-account
 * eligibility may have changed: the configuration was written (a bundler,
 * factory, account type, EIP-7702 upgrade or recovered-account link was
 * saved or cleared) or a smart-account operation was accepted by the
 * bundler (which may deploy the account once it is included). Returns one
 * function that removes both subscriptions. useAaStateRevision wraps it
 * for React; it is separate so scripts/check-aa.mjs can exercise it.
 */
export function subscribeAaStateChanges(onChange: () => void): () => void {
  const offConfig = addAaConfigChangedListener(onChange);
  const offSent = addAaSentListener(() => onChange());
  return () => {
    offConfig();
    offSent();
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
 * Refuses (TokenGasChargeAboveLimitError) any USDC permit the paymaster
 * transport asks for that is not exactly the grant the confirm screen
 * described: owner = the smart account, spender = the quoted paymaster,
 * token = the quoted fee token on this chain, deadline = type(uint256).max
 * (the only deadline the paymaster passes), value at most the displayed
 * worst case. Returns nothing; throws on the first mismatch. Exported for
 * scripts/check-token-gas.mjs.
 */
export function assertTokenGasPermit(
  permit: PermitRequest,
  expected: { account: string; tokenGas: AaTokenGas; chainId: bigint },
): void {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const m = permit.message;
  if (
    !same(m.owner, expected.account) ||
    !same(m.spender, expected.tokenGas.paymaster) ||
    !same(permit.domain.verifyingContract, expected.tokenGas.token) ||
    BigInt(permit.domain.chainId) !== expected.chainId ||
    m.deadline !== PERMIT_DEADLINE_MAX
  ) {
    throw new Error(
      'The USDC permit the paymaster asked for does not match the reviewed send (owner, paymaster, token, ' +
        'network or deadline differ). Nothing was signed; review the send again.',
    );
  }
  if (m.value > expected.tokenGas.maxTokenCharge) {
    throw new TokenGasChargeAboveLimitError(m.value, expected.tokenGas.maxTokenCharge);
  }
}

/**
 * The SmartAccountClient for one USDC-fee send: the bundle's own spec, node
 * and bundler, plus the engine's local ERC-7677 transport for Circle's
 * paymaster in permit mode. It is built inside sendAa, after the biometric
 * gate, because the permit is signed AS THE ACCOUNT (the spec's ERC-1271
 * envelope over the permit digest) with the owner key that only exists
 * there. maxTokenCharge = the displayed worst case: the engine refuses final
 * paymaster data above it (TokenGasChargeAboveLimitError), and
 * assertTokenGasPermit refuses to sign any permit above it, the estimation
 * stub included.
 */
function tokenGasClient(
  bundle: AaClientBundle,
  owner: DerivedAccount,
  sender: string,
  tokenGas: AaTokenGas,
): SmartAccountClient {
  const signErc1271 = bundle.spec.signErc1271;
  if (!signErc1271) throw new Error(TOKEN_GAS_ACCOUNT_REFUSAL);
  const transport = createCirclePaymasterTransport({
    node: bundle.node,
    chainId: bundle.chainId,
    account: sender,
    paymaster: tokenGas.paymaster,
    token: tokenGas.token,
    entryPoint: ENTRYPOINT_V07,
    mode: 'permit',
    estimationGasCeiling: tokenGas.estimationGasCeiling,
    verificationGasLimit: tokenGas.paymasterVerificationGasLimit,
    postOpGasLimit: tokenGas.paymasterPostOpGasLimit,
    maxTokenCharge: tokenGas.maxTokenCharge,
    signPermit: (digest, permit) => {
      assertTokenGasPermit(permit, { account: sender, tokenGas, chainId: bundle.chainId });
      return signErc1271.call(bundle.spec, owner, digest, { chainId: bundle.chainId, account: sender });
    },
  });
  return new SmartAccountClient({
    chainId: bundle.chainId,
    entryPoint: ENTRYPOINT_V07,
    bundler: bundle.bundler,
    node: bundle.node,
    spec: bundle.spec,
    paymaster: { transport },
    gasPaddingPct: { ...TOKEN_GAS_PADDING_PCT },
    estimateRetries: bundle.estimateRetries ?? AA_ESTIMATE_RETRIES,
  });
}

/**
 * The approval an ERC-7677 USDC-fee quote must carry as its FIRST call:
 * approve(paymaster, maxTokenCharge) on the fee token, exactly. sendAa
 * checks the quote against it before anything is signed, so the amount the
 * confirm screen showed is the amount the token contract will let the
 * paymaster take. Exported for scripts/check-token-gas.mjs.
 */
export function assertErc7677ApprovalCall(quote: Pick<AaSendQuote, 'calls' | 'tokenGas'>): void {
  const tg = quote.tokenGas;
  if (!tg || tg.source !== 'erc7677') throw new Error('Not an ERC-7677 USDC-fee quote.');
  const expected = erc7677TokenApproveCall(tg.token, tg.paymaster, tg.maxTokenCharge);
  const first = quote.calls[0];
  const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
  if (
    !first ||
    first.to.toLowerCase() !== expected.to.toLowerCase() ||
    first.value !== 0n ||
    !sameBytes(first.data, expected.data)
  ) {
    throw new Error(
      `The operation does not start by approving exactly ${tg.maxTokenCharge} base units of ${tg.symbol} for the ` +
        'paymaster, as the confirm screen showed. Nothing was signed; review the send again.',
    );
  }
}

/**
 * The SmartAccountClient for one ERC-7677 USDC-fee send (phase 14 item 3):
 * the bundle's spec, node and bundler, plus the engine's
 * createErc7677TokenPaymasterTransport forwarding pm_getPaymasterStubData /
 * pm_getPaymasterData to the SAME bundler endpoint with the context
 * { token }. maxTokenCharge = the displayed worst case = the approval in the
 * operation's first call: the transport refuses final paymaster data whose
 * bound is above it (TokenGasChargeAboveLimitError) before the owner signs.
 * No key is needed for the paymaster: the owner signs only the operation.
 */
function erc7677TokenGasClient(bundle: AaClientBundle, sender: string, quote: AaSendQuote): SmartAccountClient {
  const tokenGas = quote.tokenGas!;
  assertErc7677ApprovalCall(quote);
  const transport = createErc7677TokenPaymasterTransport({
    upstream: bundle.bundler,
    chainId: bundle.chainId,
    account: sender,
    token: tokenGas.token,
    paymaster: tokenGas.paymaster,
    entryPoint: ENTRYPOINT_V07,
    maxTokenCharge: tokenGas.maxTokenCharge,
  });
  return new SmartAccountClient({
    chainId: bundle.chainId,
    entryPoint: ENTRYPOINT_V07,
    bundler: bundle.bundler,
    node: bundle.node,
    spec: bundle.spec,
    paymaster: { transport },
    gasPaddingPct: { ...TOKEN_GAS_PADDING_PCT },
    estimateRetries: bundle.estimateRetries ?? AA_ESTIMATE_RETRIES,
  });
}

/**
 * Quotes that already went to the network through sendAa, sendPasskeyCalls
 * or submitGuardianRecovery (whatever the outcome; refusals decided locally
 * before any request leave the quote usable). A quote's fees and gas figures are one moment's answer;
 * after a refusal (for example a bundler fee floor that rose) the same
 * Approve button must not send the same numbers again, so a second attempt
 * with the same quote object is refused and the screen re-quotes.
 */
const submittedQuotes = new WeakSet<object>();

/** Refusal for a quote that was already submitted once. */
export const AA_QUOTE_ALREADY_USED =
  'This operation was already submitted once with these fees. Nothing was signed; review it again so it is ' +
  'priced afresh.';

/**
 * Marks `quote` as submitted, refusing (before anything is signed) a quote
 * that was submitted before. Exported for the passkey path (./passkeys.ts),
 * the guardian recovery submit (./recovery.ts) and scripts/check-aa.mjs.
 */
export function claimQuoteForSubmission(quote: object): void {
  if (submittedQuotes.has(quote)) throw new AaFeeRoseError(AA_QUOTE_ALREADY_USED, 'used');
  submittedQuotes.add(quote);
}

/**
 * The purely network checks of sendAa's fee rules, run by the screens
 * BEFORE the device check (the 2026-10-04 emulator run: two sends were
 * refused with "The network fee rose" only after the user had passed the
 * biometric prompt). Refuses, with an AaFeeRoseError and nothing signed or
 * claimed, a quote that was already submitted once ('used', a local check)
 * and quoted fees below the bundler's current floor ('floor',
 * assertQuoteFeesMeetBundlerFloor). The quote stays usable when this
 * passes; sendAa (and the passkey and guardian submits) still run the same
 * floor check again at send time as the last line of defence, and the
 * gas-estimate check (signedFeeGuard) can only run there, because the
 * client re-estimates the operation while it signs.
 *
 * `quote` needs only the quoted fees; `bundler` is the transport the quote
 * was priced against (AaClientBundle.bundler, or the guardian submit's).
 */
export async function checkAaQuoteBeforeApproval(
  bundler: JsonRpcTransport,
  quote: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
): Promise<void> {
  if (submittedQuotes.has(quote)) throw new AaFeeRoseError(AA_QUOTE_ALREADY_USED, 'used');
  await assertQuoteFeesMeetBundlerFloor(bundler, {
    maxFeePerGas: quote.maxFeePerGas,
    maxPriorityFeePerGas: quote.maxPriorityFeePerGas,
  });
}

/**
 * Signs and submits the quoted calls as one UserOperation through
 * SmartAccountClient.sendCalls (stub → estimate → sign → send; the client
 * re-runs its own estimation so the submitted gas limits are fresh).
 * Refuses before signing when the signer's smart account is not the quoted
 * sender (e.g. the configuration changed after the quote). Returns the
 * bundler-issued userOpHash — inclusion is asynchronous; poll with
 * waitForAaReceipt.
 *
 * Fees (the 2026-10-04 refusal after the biometric prompt): the operation
 * is signed with exactly the quoted fees, never raised. Before signing,
 * the bundler's floor is read again (assertQuoteFeesMeetBundlerFloor) and,
 * once the client has re-estimated the gas, the worst case is checked
 * against the displayed fee (signedFeeGuard); either refusal is an
 * AaFeeRoseError and nothing is signed. The quote's fees already carry
 * AA_FEE_FLOOR_HEADROOM_PERCENT over the floor, so a modest drift passes.
 * A quote can be submitted once (claimQuoteForSubmission).
 */
export async function sendAa(
  bundle: AaClientBundle,
  owner: DerivedAccount,
  quote: AaSendQuote,
): Promise<{ userOpHash: string }> {
  if (quote.passkey) {
    throw new Error('This operation was prepared for the passkey signer. Nothing was signed; review it again.');
  }
  // USDC fee (phase 13 item 2): only for the account type it is offered for,
  // and only where the readiness switchboard allows it (test networks).
  if (quote.tokenGas) {
    assertFeatureAllowed('token-gas', eip155Caip2(bundle.chainId));
    if (
      bundle.accountType !== 'kernel-v3.3' ||
      bundle.eip7702 ||
      bundle.sponsored ||
      !bundle.spec.signErc1271 ||
      quote.eip7702
    ) {
      throw new Error(TOKEN_GAS_ACCOUNT_REFUSAL);
    }
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
  // From here on the quote goes to the network: it is used up whatever
  // happens (the local refusals above leave it usable).
  claimQuoteForSubmission(quote);
  const fees = { maxFeePerGas: quote.maxFeePerGas, maxPriorityFeePerGas: quote.maxPriorityFeePerGas };
  await assertQuoteFeesMeetBundlerFloor(bundle.bundler, fees);
  // D6: the authorization tuple may be signed only for a quote whose
  // confirm screen announced the upgrade; the wrapped spec refuses it
  // otherwise. The gate is closed again whatever happens.
  if (bundle.eip7702) bundle.eip7702.gate.allowAuthorization = quote.eip7702?.upgrade === true;
  try {
    const client = quote.tokenGas
      ? quote.tokenGas.source === 'erc7677'
        ? erc7677TokenGasClient(bundle, sender, quote)
        : tokenGasClient(bundle, owner, sender, quote.tokenGas)
      : bundle.client;
    const { userOpHash } = await client.sendCalls(owner, quote.calls, fees, {
      beforeSign: signedFeeGuard(fees, quote.sponsored ? 0n : quote.fee),
    });
    // The deploying operation changes "not deployed yet": re-read next time.
    forgetSmartAccountAddress(sender);
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
 * Footnotes for a smart-account operation whose network fee is paid in a
 * token through Circle's paymaster (quote.tokenGas, ./token-gas.ts). The
 * simulated calls do not include that charge (the paymaster takes it in
 * the same UserOperation), and no ETH pays for gas, so the plain notes'
 * "gas the smart account pays through the EntryPoint" would be wrong.
 */
export function previewTokenGasNote(symbol: string, paymasterName = 'Circle’s paymaster'): string {
  return (
    'Simulated as a direct call from your smart account. The network fee is paid in ' +
    `${symbol} through ${paymasterName} and is shown above; it is not part of this list.`
  );
}

export function previewTokenGasBatchNote(symbol: string, paymasterName = 'Circle’s paymaster'): string {
  return (
    'Simulated as direct calls from your smart account, one after another in a single ' +
    'simulated block (eth_simulateV1). The smart account executes them as one atomic ' +
    'operation: if any call fails, none of them take effect. The network fee is paid in ' +
    `${symbol} through ${paymasterName} and is shown above; it is not part of this list.`
  );
}

/**
 * The footnote for an ERC-7677 USDC-fee operation: its first call is the
 * approval for the paymaster (it appears in the list as an approval), and
 * the fee itself is taken after the calls run, so it is not in the list.
 */
export function previewErc7677TokenGasNote(symbol: string, vendor: string): string {
  return (
    'Simulated as direct calls from your smart account, one after another in a single ' +
    'simulated block (eth_simulateV1). The smart account executes them as one atomic ' +
    `operation: if any call fails, none of them take effect. The first call approves ${vendor}’s ` +
    `paymaster for the most the network fee can cost; the fee itself is taken in ${symbol} after ` +
    'the calls run, is shown above, and is not part of this list.'
  );
}

/**
 * The balance-change preview's footnote for a smart-account quote: the
 * token-fee wording when the quote pays its fee in a token, else the plain
 * single-call or batch note.
 */
export function aaPreviewNote(quote: Pick<AaSendQuote, 'calls' | 'tokenGas'>): string {
  const batch = quote.calls.length > 1;
  if (quote.tokenGas?.source === 'erc7677') {
    return previewErc7677TokenGasNote(quote.tokenGas.symbol, quote.tokenGas.erc7677?.vendor ?? 'the token');
  }
  if (quote.tokenGas) {
    return batch ? previewTokenGasBatchNote(quote.tokenGas.symbol) : previewTokenGasNote(quote.tokenGas.symbol);
  }
  return batch ? PREVIEW_AA_BATCH_NOTE : PREVIEW_AA_NOTE;
}

/**
 * Plain-language error for the AA path, keeping the bundler's message
 * verbatim as the detail. A smart account that cannot pay (the wallet's
 * own check, or a bundler AA21 "didn't pay prefund") gets the funding title
 * and a message naming the address to fund. A rejected Kernel deployment
 * gets a title that says so and the known-limitation note (no
 * self-bundling fallback) — the Alchemy note only when `bundlerUrl` is an
 * Alchemy endpoint (omitted: the note is kept, as before).
 */
export function describeAaError(
  error: unknown,
  context: {
    accountType: AaAccountType;
    deployed: boolean | null;
    /** The smart account (quote sender), used to name it in an AA21 message. */
    sender?: string | null;
    /** The configured bundler URL; only its masked host is inspected. */
    bundlerUrl?: string | null;
  },
): { title: string; detail: string } | null {
  const detail = error instanceof Error ? error.message : String(error);
  if (error instanceof AaFundingError) return { title: error.title, detail };
  if (error instanceof AaFeeRoseError) return { title: aaFeeRoseTitle(error), detail };
  if (isImpossibleGasEstimateError(error)) {
    return { title: AA_IMPOSSIBLE_ESTIMATE_TITLE, detail: `${AA_IMPOSSIBLE_ESTIMATE_SENTENCE}\n\nTechnical detail: ${detail}` };
  }
  if (isBundlerFeeFloorRefusal(detail)) {
    return {
      title: AA_FEE_ROSE_TITLE,
      detail:
        'The bundler refused the operation because its minimum fee rose after you reviewed it, so ' +
        'nothing was sent. Review it again: the new quote shows the higher fee.' +
        `\n\nThe bundler's message: ${detail}`,
    };
  }
  if (isPrefundError(detail)) {
    const sender = context.sender ?? null;
    return {
      title: AA_FUNDING_TITLE,
      detail: sender
        ? `The smart account ${sender} cannot pay for this operation's gas (its balance and ` +
          `EntryPoint deposit are too small). Fund the smart account address ${sender} (not the ` +
          `owner address), then try again.\n\nThe bundler's message: ${detail}`
        : 'The smart account cannot pay for this operation\'s gas (its balance and EntryPoint ' +
          'deposit are too small). Fund the smart account address shown on the Send screen (not ' +
          `the owner address), then try again.\n\nThe bundler's message: ${detail}`,
    };
  }
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
      detail:
        context.bundlerUrl === undefined || isAlchemyBundlerUrl(context.bundlerUrl)
          ? `${detail}\n\n${KERNEL_BUNDLER_NOTE}`
          : `${detail}\n\nThe configured bundler refused the operation that deploys the account; ` +
            'its error is shown exactly as it was returned. A bundler that accepts Kernel ' +
            'deployments is needed for the first operation.',
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
