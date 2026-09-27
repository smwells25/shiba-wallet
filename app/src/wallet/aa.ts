import AsyncStorage from '@react-native-async-storage/async-storage';
import type { DerivedAccount } from '@shiba-wallet/core';
import { toChecksumAddress } from '@shiba-wallet/core';
import {
  BundlerClient,
  ENTRYPOINT_V07,
  NodeClient,
  SmartAccountClient,
  createSimpleAccountSpec,
  encodeFunctionCall,
  httpTransport,
  toBytes,
  type JsonRpcTransport,
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
 * No paymaster is configured in this pass: the smart account pays its own
 * gas from its own balance. ERC-7677 sponsorship is a later, additive step
 * (SmartAccountClient already supports it via config.paymaster).
 */

const AA_CONFIG_KEY = 'shiba-wallet.aa-config.v1';

/** Builds a JSON-RPC transport for a URL; injectable for offline tests. */
export type TransportFactory = (url: string) => JsonRpcTransport;

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
  /** EIP-55 checksummed SimpleAccountFactory address. */
  factory: string | null;
  /** accountImplementation() behind the verified factory (display only). */
  factoryImplementation: string | null;
  /** ISO timestamp of the successful on-chain factory verification. */
  factoryVerifiedAt: string | null;
}

const EMPTY_CONFIG: AaChainConfig = {
  bundlerUrl: null,
  bundlerVerifiedAt: null,
  factory: null,
  factoryImplementation: null,
  factoryVerifiedAt: null,
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
  return {
    bundlerUrl,
    bundlerVerifiedAt: bundlerUrl ? str(entry?.bundlerVerifiedAt) : null,
    factory,
    factoryImplementation: factory ? str(entry?.factoryImplementation) : null,
    factoryVerifiedAt: factory ? str(entry?.factoryVerifiedAt) : null,
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

/** True when both endpoints are configured (and therefore verified). */
export function isAaConfigured(config: AaChainConfig): boolean {
  return config.bundlerUrl !== null && config.factory !== null;
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
  map[chainId] = {
    ...map[chainId],
    factory: validated.normalized,
    factoryImplementation: verification.implementation,
    factoryVerifiedAt: new Date().toISOString(),
  };
  await saveConfigMap(map, store);
  return verification;
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
    delete map[chainId]!.factory;
    delete map[chainId]!.factoryImplementation;
    delete map[chainId]!.factoryVerifiedAt;
    await saveConfigMap(map, store);
  }
}

// ---------------------------------------------------------------------------
// Client construction and the AA send path
// ---------------------------------------------------------------------------

export interface AaClientBundle {
  client: SmartAccountClient;
  spec: SmartAccountSpec;
  node: JsonRpcTransport;
  bundler: JsonRpcTransport;
  chainId: bigint;
}

/**
 * Builds the SmartAccountClient stack for one chain from verified
 * configuration. No paymaster: the account pays its own gas (an ERC-7677
 * paymaster is an additive config field on SmartAccountClient later).
 */
export function createAaClient(options: {
  nodeUrl: string;
  bundlerUrl: string;
  factory: string;
  chainId?: bigint;
  transportFor?: TransportFactory;
}): AaClientBundle {
  const transportFor = options.transportFor ?? httpTransport;
  const node = transportFor(options.nodeUrl);
  const bundler = transportFor(options.bundlerUrl);
  const chainId = options.chainId ?? BigInt(EVM_CHAIN_ID.split(':')[1]!);
  const spec = createSimpleAccountSpec({ factory: options.factory, node });
  const client = new SmartAccountClient({
    chainId,
    entryPoint: ENTRYPOINT_V07,
    bundler,
    node,
    spec,
  });
  return { client, spec, node, bundler, chainId };
}

/**
 * A DerivedAccount stand-in carrying only the owner's public address, for
 * quote-time work (counterfactual address, nonce, gas estimation with the
 * spec's stub signature). It cannot sign, so no key material is ever
 * resident while the user reads the confirm screen; the real signer is
 * re-derived through WalletContext.signWith only for the final send.
 */
function addressOnlyOwner(address: string): DerivedAccount {
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

export interface AaSendQuote {
  kind: 'aa';
  to: string;
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
}

/**
 * Builds the AA send quote: verifies the node endpoint's chain id, resolves
 * the counterfactual sender via the spec's getAddress, reads its balance
 * and deployment state, and prices the operation with the bundler's
 * eth_estimateUserOperationGas over a stub-signed UserOperation shaped
 * exactly like the one SmartAccountClient.sendCalls will submit.
 */
export async function prepareAaSend(
  bundle: AaClientBundle,
  ownerAddress: string,
  to: string,
  amount: bigint,
): Promise<AaSendQuote> {
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
  const [senderBalance, deployed, nonce, fees] = await Promise.all([
    nodeClient.getBalance(sender),
    bundle.client.isDeployed(owner),
    bundle.client.getNonce(owner),
    nodeClient.suggestFees(),
  ]);

  const factoryArgs = deployed ? undefined : await bundle.spec.getFactoryArgs(owner);
  const op: UserOperation = {
    sender,
    nonce,
    ...(factoryArgs
      ? { factory: factoryArgs.factory, factoryData: factoryArgs.factoryData }
      : {}),
    callData: bundle.spec.encodeCalls([{ to, value: amount, data: new Uint8Array(0) }]),
    callGasLimit: 0n,
    verificationGasLimit: 0n,
    preVerificationGas: 0n,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    signature: bundle.spec.stubSignature(),
  };
  const gas = await new BundlerClient(bundle.bundler, ENTRYPOINT_V07).estimateUserOperationGas(op);

  const gasTotal = gas.callGasLimit + gas.verificationGasLimit + gas.preVerificationGas;
  const fee = gasTotal * fees.maxFeePerGas;
  if (amount + fee > senderBalance) {
    throw new Error(
      `Insufficient funds: the smart account pays its own gas (no paymaster), and sending ` +
        `${amount} wei plus a worst-case fee of ${fee} wei exceeds its balance of ` +
        `${senderBalance} wei. Fund the smart account address, not the owner address.`,
    );
  }

  return {
    kind: 'aa',
    to,
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
  };
}

/**
 * Signs and submits the quoted transfer as a UserOperation through
 * SmartAccountClient.sendCalls (stub → estimate → sign → send; the client
 * re-runs its own estimation so the submitted gas limits are fresh).
 * Returns the bundler-issued userOpHash — inclusion is asynchronous; poll
 * with waitForAaReceipt.
 */
export async function sendAa(
  bundle: AaClientBundle,
  owner: DerivedAccount,
  quote: AaSendQuote,
): Promise<{ userOpHash: string }> {
  const { userOpHash } = await bundle.client.sendCalls(
    owner,
    [{ to: quote.to, value: quote.amount, data: new Uint8Array(0) }],
    { maxFeePerGas: quote.maxFeePerGas, maxPriorityFeePerGas: quote.maxPriorityFeePerGas },
  );
  return { userOpHash };
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
