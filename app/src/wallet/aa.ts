import AsyncStorage from '@react-native-async-storage/async-storage';
import type { DerivedAccount } from '@shiba-wallet/core';
import { toChecksumAddress } from '@shiba-wallet/core';
import {
  BundlerClient,
  ENTRYPOINT_V07,
  KERNEL_V3_3,
  NodeClient,
  SmartAccountClient,
  createKernelAccountSpec,
  createSimpleAccountSpec,
  decodeUint256,
  encodeErc20BalanceOf,
  encodeErc20Transfer,
  encodeFunctionCall,
  httpTransport,
  signHashForSmartAccount,
  toBytes,
  toHex,
  verifyKernelDeployment,
  type Call,
  type JsonRpcTransport,
  type SmartAccountSignature,
  type SmartAccountSpec,
  type UserOperation,
} from '@shiba-wallet/chains-evm';
// Explicit .ts extensions: this module is imported by scripts/check-aa.mjs
// under Node's type stripping, which resolves relative specifiers literally.
import { EVM_CHAIN_ID, validateRecipient } from './send.ts';
import type { KeyValueStore } from './tokens.ts';

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

/** The smart-account implementations the app can configure per chain. */
export type AaAccountType = 'simple' | 'kernel-v3.3';

export const AA_ACCOUNT_TYPES: readonly AaAccountType[] = ['simple', 'kernel-v3.3'];

/** Plain names for the account types (Settings, confirm screens, WC sheet). */
export function aaAccountTypeLabel(type: AaAccountType): string {
  return type === 'kernel-v3.3' ? 'Kernel v3.3 (ERC-7579)' : 'SimpleAccount (v0.7 sample)';
}

/** True when the account type can sign messages for dApps (ERC-1271). */
export function aaAccountTypeSignsMessages(type: AaAccountType): boolean {
  return type === 'kernel-v3.3';
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
  accountType: AaAccountType;
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
};

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

function normalizeEntry(entry: Partial<AaChainConfig> | undefined): AaChainConfig {
  const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
  const bundlerUrl = str(entry?.bundlerUrl);
  const factory = str(entry?.factory);
  const paymasterUrl = str(entry?.paymasterUrl);
  const accountType: AaAccountType =
    factory !== null && entry?.accountType === 'kernel-v3.3' ? 'kernel-v3.3' : 'simple';
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
  };
}

/** The stored AA configuration for one chain (empty defaults when unset). */
export async function getAaConfig(
  chainId: string,
  store: KeyValueStore = AsyncStorage,
): Promise<AaChainConfig> {
  const map = await loadConfigMap(store);
  return normalizeEntry(map[chainId]) ?? { ...EMPTY_CONFIG };
}

/**
 * True when both endpoints are configured (and therefore verified). A
 * Kernel configuration additionally needs its validator on record (always
 * written together with the factory by setAaKernelFactory).
 */
export function isAaConfigured(config: AaChainConfig): boolean {
  if (config.bundlerUrl === null || config.factory === null) return false;
  if (config.accountType === 'kernel-v3.3') return config.kernelValidator !== null;
  return true;
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
    const rest = (url.pathname !== '/' && url.pathname !== '' ? '/…' : '') + (url.search ? '?…' : '');
    return `${url.protocol}//${url.host}${rest}`;
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
  try {
    const result = await bundler('rundler_maxPriorityFeePerGas', []);
    if (typeof result !== 'string' || !/^0x[0-9a-fA-F]+$/.test(result)) return null;
    return BigInt(result);
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

const URL_PATTERN = /^https?:\/\/.+/;

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
  const store = options.store ?? AsyncStorage;
  const transportFor = options.transportFor ?? httpTransport;
  const trimmed = url.trim().replace(/\/+$/, '');
  if (!URL_PATTERN.test(trimmed)) {
    throw new Error('Bundler endpoint must be an http(s):// URL');
  }
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
  const store = options.store ?? AsyncStorage;
  const transportFor = options.transportFor ?? httpTransport;
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
  const store = options.store ?? AsyncStorage;
  const transportFor = options.transportFor ?? httpTransport;
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
  const store = options.store ?? AsyncStorage;
  const transportFor = options.transportFor ?? httpTransport;
  const trimmed = url.trim().replace(/\/+$/, '');
  if (!URL_PATTERN.test(trimmed)) {
    throw new Error('Paymaster endpoint must be an http(s):// URL');
  }
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
  /** The configured factory (SimpleAccountFactory or KernelFactory). */
  factory: string;
  /** Wallet account index = CREATE2 salt. */
  accountIndex: number;
}

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
}): AaClientBundle {
  const transportFor = options.transportFor ?? httpTransport;
  const node = transportFor(options.nodeUrl);
  const bundler = transportFor(options.bundlerUrl);
  const chainId = options.chainId ?? BigInt(EVM_CHAIN_ID.split(':')[1]!);
  const accountIndex = options.accountIndex ?? 0;
  if (!Number.isSafeInteger(accountIndex) || accountIndex < 0) {
    throw new Error(`Invalid account index ${String(options.accountIndex)}.`);
  }
  const accountType = options.accountType ?? 'simple';
  const spec =
    accountType === 'kernel-v3.3'
      ? createKernelAccountSpec({
          node,
          index: BigInt(accountIndex),
          factory: options.factory,
          implementation: options.kernel?.implementation ?? KERNEL_PREFILL.implementation,
          metaFactory:
            options.kernel?.metaFactory === undefined
              ? KERNEL_PREFILL.metaFactory
              : options.kernel.metaFactory,
          ecdsaValidator: options.kernel?.ecdsaValidator ?? KERNEL_PREFILL.ecdsaValidator,
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
    transportFor?: TransportFactory;
  },
): AaClientBundle {
  if (!isAaConfigured(config) || !config.bundlerUrl || !config.factory) {
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
  const [senderBalance, deployed, nonce, suggestedFees, tokenBalance, priorityFloor] =
    await Promise.all([
      nodeClient.getBalance(sender),
      bundle.client.isDeployed(owner),
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

  const factoryArgs = deployed ? undefined : await bundle.spec.getFactoryArgs(owner);
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
  };
  const gas = await new BundlerClient(bundle.bundler, ENTRYPOINT_V07).estimateUserOperationGas(op);

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
  };
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
  const sender = await bundle.client.getAddress(owner);
  if (sender.toLowerCase() !== quote.sender.toLowerCase()) {
    throw new Error(
      `This signer's smart account is ${sender}, but the operation was prepared for ` +
        `${quote.sender}. Nothing was signed; review the send again.`,
    );
  }
  const { userOpHash } = await bundle.client.sendCalls(owner, quote.calls, {
    maxFeePerGas: quote.maxFeePerGas,
    maxPriorityFeePerGas: quote.maxPriorityFeePerGas,
  });
  return { userOpHash };
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
