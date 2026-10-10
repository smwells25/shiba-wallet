import AsyncStorage from '@react-native-async-storage/async-storage';
// Explicit .ts extensions: scripts/check-custom-networks.mjs (and, through
// config/prefs.ts, every suite that loads the preferences) imports this
// module under Node's type stripping, which resolves relative specifiers
// literally.
import {
  EVM_PROFILES,
  KNOWN_PUBLIC_TEST_CHAIN_IDS,
  isKnownPublicTestChainId,
  setCustomEvmProfiles,
  type EvmChainProfile,
} from '../config/evm-chain.ts';
import { assertSecureEndpointUrl } from '../config/endpoint-url.ts';
import { FRESHNESS_BOUND_SECONDS, assessHeadFreshness, type FetchLike } from '../config/endpoint-probe.ts';
import { sanitizeDisplayName } from './names.ts';

/**
 * Custom EVM networks (feature 33, phase 17 item 3; requirement 4, no
 * lock-in): the user adds an EVM network by chain id, one RPC URL, the
 * native coin's symbol and decimals, and optionally a block explorer and a
 * "this is a test network" tick. The network then becomes an EvmChainProfile
 * at runtime (config/evm-chain.ts, "Custom networks"), so every screen and
 * module that reads the active profile serves it unchanged.
 *
 * VERIFY BEFORE SAVE (the discipline every endpoint in this wallet follows):
 *  1. the RPC URL passes the shared https rule (config/endpoint-url.ts);
 *  2. eth_chainId through it must equal the typed chain id (refused with
 *     both numbers otherwise);
 *  3. the newest block (eth_getBlockByNumber "latest") must be readable and
 *     no older than the freshness bound every EVM endpoint is held to
 *     (config/endpoint-probe.ts FRESHNESS_BOUND_SECONDS, 600 s; refused with
 *     the block's age otherwise) — finding F-66's rule, here a hard
 *     requirement because the network is new to the wallet;
 *  4. the block time is MEASURED from the head block and the block 100
 *     below it (used by the risk module's new-contract window,
 *     wallet/risk.ts newContractThresholdBlocks); when it cannot be measured
 *     the network is still saved and has no new-contract check, the rule for
 *     every chain the wallet has no figure for.
 * The native coin's symbol has no on-chain source (EVM chains do not publish
 * one), so it is the user's word and Settings says so.
 *
 * WHAT A CUSTOM NETWORK IS NOT GIVEN (config/evm-chain.ts customNetworkNote):
 * no Kernel or SimpleAccount pre-fill (kernelV33Verified false, aaPrefill
 * null), no swaps, no layer-2 fee model (l1DataFee and l1CostInGas false;
 * on a rollup quotes may be refused or underestimate the fee), no prices
 * (wallet/prices.ts prices only listed main networks), no ENS, no token
 * defaults.
 *
 * READINESS: a custom network is a MAIN network for the switchboard
 * (config/readiness.ts) unless the user ticked "This is a test network" AND
 * its chain id is on KNOWN_PUBLIC_TEST_CHAIN_IDS; an unlisted id with the
 * tick is refused here with a sentence, and the list is re-checked on every
 * read (config/evm-chain.ts isCustomTestNetwork), so a user can never mark
 * mainnet funds "test" by mistake.
 *
 * STORE: shiba-wallet.custom-networks.v1 in AsyncStorage (public
 * configuration, no secrets — like the endpoint overrides). Strict parse:
 * any record this module would not have written makes the whole store
 * READ-ONLY (the readable networks stay usable; every write is refused with
 * CUSTOM_NETWORKS_READ_ONLY_MESSAGE until the explicit Reset). At most
 * MAX_CUSTOM_NETWORKS. Every function takes an injectable store so
 * scripts/check-custom-networks.mjs runs the exact logic under Node.
 *
 * REMOVAL deletes the network and the data this wallet keeps for ITS chain
 * id only (see removeCustomNetwork for the list, and the stores it
 * deliberately keeps); if the network is active, the choice returns to
 * Ethereum mainnet first.
 */

/** The AsyncStorage key of the custom-network list. */
export const CUSTOM_NETWORKS_KEY = 'shiba-wallet.custom-networks.v1';
const STORE_VERSION = 1;

/** At most this many custom networks (a judgement: enough for a developer's networks, bounded storage and UI). */
export const MAX_CUSTOM_NETWORKS = 10;

/** Network names: 1 to 32 code points after the shared display-name sanitizer. */
export const MAX_NETWORK_NAME_LENGTH = 32;

/**
 * The largest chain id accepted: 2^53 − 1, the largest integer a JavaScript
 * number holds exactly, so the id is the same whether a module reads it as
 * a number or a BigInt. (EIP-2294 bounds chain ids far higher, but no chain
 * in the ethereum-lists registry comes near this.)
 */
export const MAX_CUSTOM_CHAIN_ID = 9_007_199_254_740_991n;

/** The only native-coin decimals accepted: every EVM amount, fee and Max in the app assumes 18. */
export const CUSTOM_NATIVE_DECIMALS = 18;

/** Blocks between the two timestamps of the block-time measurement. */
export const BLOCK_TIME_SAMPLE_BLOCKS = 100;

/** Per-request timeout of the verification reads. */
export const VERIFY_TIMEOUT_MS = 8_000;

/** Words that make a name sound like a test network; refused for a network treated as a main network. */
const TEST_NETWORK_WORDS = ['test', 'sepolia', 'holesky', 'hoodi', 'goerli', 'devnet', 'amoy'];

/** One stored custom network, exactly as written. */
export interface CustomNetworkRecord {
  /** Decimal chain id, no leading zeros, 1..MAX_CUSTOM_CHAIN_ID. */
  chainId: string;
  /** Sanitized display name. */
  name: string;
  /** Normalized RPC URL (config/endpoint-url.ts). */
  rpcUrl: string;
  /** The native coin's symbol as typed (1–10 ASCII letters or digits). */
  nativeSymbol: string;
  /** Always CUSTOM_NATIVE_DECIMALS. */
  nativeDecimals: number;
  /** https explorer base without a trailing slash, or null. */
  explorerUrl: string | null;
  /** The user's "This is a test network" tick (stored only for allow-listed ids). */
  testnet: boolean;
  /** Measured milliseconds per block, or null when not measured. */
  blockTimeMs: number | null;
  /** ISO time the network was verified and saved. */
  addedAt: string;
}

/** What the Settings form hands in. */
export interface CustomNetworkInput {
  name: string;
  chainId: string;
  rpcUrl: string;
  nativeSymbol: string;
  nativeDecimals: string;
  explorerUrl?: string;
  testnet: boolean;
}

/** The store as AsyncStorage provides it; removeItem is used where present. */
export interface CustomNetworkStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem?(key: string): Promise<void>;
}

export interface CustomNetworkBook {
  /** The readable networks, in the order they were added. */
  networks: CustomNetworkRecord[];
  /** True when the store held something this module would not have written; writes are refused. */
  readOnly: boolean;
}

// ---------------------------------------------------------------------------
// Sentences (exported so the check script pins them)
// ---------------------------------------------------------------------------

export const CUSTOM_NETWORKS_READ_ONLY_MESSAGE =
  'The saved custom networks could not be read, so nothing was changed. Use “Reset custom networks” in ' +
  'Settings → Developer to start a fresh list.';

export const CHAIN_ID_FORMAT_MESSAGE =
  `Enter the chain id as a whole number from 1 to ${MAX_CUSTOM_CHAIN_ID.toString()} (digits only, no leading zeros).`;

export const NATIVE_SYMBOL_MESSAGE = 'Enter the coin’s symbol as 1 to 10 letters or digits (for example ETH or POL).';

export const DECIMALS_FORMAT_MESSAGE = 'Enter the coin’s decimals as a whole number (18 for almost every EVM network).';

export const EXPLORER_URL_MESSAGE =
  'The block explorer address must start with https:// and contain only a host name and an optional path — no ' +
  'query, fragment or user name (for example https://sepolia.etherscan.io).';

export const MAX_CUSTOM_NETWORKS_MESSAGE =
  `This phone already keeps ${MAX_CUSTOM_NETWORKS} custom networks, the most the wallet stores. Remove one first. ` +
  'Nothing was saved.';

/** Shown under the symbol field: there is no on-chain source for it. */
export const NATIVE_SYMBOL_NOTE =
  'The coin’s symbol is your word: EVM networks do not publish their coin’s symbol on-chain, so the wallet cannot ' +
  'check it and shows it exactly as you type it.';

/** Shown under the test-network switch. */
export const TEST_NETWORK_TICK_NOTE =
  'Only the well-known public test networks can be marked as test networks: ' +
  `${knownTestNetworkList()}. Any other network is treated as a main network whose funds may be real, so the ` +
  'smart-account features stay switched off on it and the other features carry the same “not yet cleared” ' +
  'status as on Ethereum mainnet.';

function knownTestNetworkList(): string {
  return KNOWN_PUBLIC_TEST_CHAIN_IDS.map((t) => `${t.name} (${t.chainId})`).join(', ');
}

/** "Ethereum mainnet" / "Ethereum Sepolia": how a built-in profile is named in refusals. */
function builtInName(p: EvmChainProfile): string {
  return p.testnet ? p.label : `${p.label} mainnet`;
}

export function builtInChainMessage(chainId: string, p: EvmChainProfile): string {
  return (
    `Chain id ${chainId} is already built in as ${builtInName(p)}; choose it in the network list above instead. ` +
    'Nothing was saved.'
  );
}

export function duplicateChainMessage(chainId: string, existingName: string): string {
  return `Chain id ${chainId} is already added as “${existingName}”. Nothing was saved.`;
}

export function unlistedTestNetworkMessage(chainId: string): string {
  return (
    `Chain id ${chainId} is not on this wallet’s list of well-known public test networks ` +
    `(${knownTestNetworkList()}), so it cannot be added as a test network: the wallet would then treat its funds ` +
    'as worthless and allow features that are switched off where funds are real. Untick “This is a test network” ' +
    'to add it as a main network. Nothing was saved.'
  );
}

export function builtInNameMessage(name: string): string {
  return `“${name}” is the name of a built-in network. Choose another name so the two can never be confused. Nothing was saved.`;
}

export function duplicateNameMessage(existingName: string): string {
  return (
    `You already have a network named “${existingName}”. Choose another name so the two can never be confused. ` +
    'Nothing was saved.'
  );
}

export function testLikeNameMessage(word: string): string {
  return (
    `A network the wallet treats as a main network cannot have a name that sounds like a test network (“${word}”), ` +
    'because its funds may be real. If it is one of the well-known public test networks, tick “This is a test ' +
    'network”. Nothing was saved.'
  );
}

export function decimalsMessage(decimals: number): string {
  return (
    `This wallet handles a network’s own coin with ${CUSTOM_NATIVE_DECIMALS} decimals only (every amount, fee and ` +
    `Max on the Ethereum screens assumes ${CUSTOM_NATIVE_DECIMALS}), so a coin with ${decimals} decimals cannot be ` +
    'added. Nothing was saved.'
  );
}

export function chainIdMismatchMessage(reported: string, typed: string): string {
  return (
    `This RPC endpoint serves chain id ${reported}, but you entered chain id ${typed}. Nothing was saved. Check ` +
    'the chain id or the RPC URL.'
  );
}

export function chainIdUnreadableMessage(detail: string): string {
  return (
    'The RPC endpoint did not answer eth_chainId with a chain id, so the wallet cannot confirm which network it ' +
    `serves. Nothing was saved. (${detail})`
  );
}

export function headUnreadableMessage(detail: string): string {
  return (
    'The RPC endpoint did not return its newest block, so the wallet cannot check that the network is running ' +
    `and up to date. Nothing was saved. (${detail})`
  );
}

/** "45 seconds" / "12 minutes" / "3 hours" / "2 days" (rounded down; plain wording for refusals). */
export function describeAge(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (s < 120) return unit(s, 'second');
  if (s < 2 * 3600) return unit(Math.floor(s / 60), 'minute');
  if (s < 2 * 86_400) return unit(Math.floor(s / 3600), 'hour');
  return unit(Math.floor(s / 86_400), 'day');
}

export function staleHeadMessage(blockNumber: bigint, ageSeconds: number, boundSeconds: number): string {
  return (
    `The newest block this endpoint reports (block ${blockNumber.toString()}) is ${describeAge(ageSeconds)} old, ` +
    `more than the ${describeAge(boundSeconds)} allowed, so the network looks stopped or the endpoint is behind. ` +
    'Nothing was saved. Try another RPC endpoint, or check this phone’s clock.'
  );
}

/** The plain line for the measured block time (Settings row). */
export function blockTimeLine(blockTimeMs: number | null): string {
  if (blockTimeMs === null) {
    return (
      'Block time: not measured, so the warning about recently created contracts is not shown on this network ' +
      '(the rule for every network the wallet has no figure for).'
    );
  }
  return (
    `Block time: about ${(blockTimeMs / 1000).toString()} s per block, measured over ${BLOCK_TIME_SAMPLE_BLOCKS} ` +
    'blocks when the network was added; the warning about contracts younger than 7 days counts blocks at that rate.'
  );
}

// ---------------------------------------------------------------------------
// Validation (no network access)
// ---------------------------------------------------------------------------

/** The decimal chain id, or null when it is not 1..MAX_CUSTOM_CHAIN_ID written plainly. */
export function parseCustomChainId(raw: string): string | null {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!/^[1-9][0-9]{0,15}$/.test(text)) return null;
  return BigInt(text) <= MAX_CUSTOM_CHAIN_ID ? text : null;
}

/** The normalized https explorer base (no trailing slash), or throws EXPLORER_URL_MESSAGE. */
export function normalizeExplorerUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!/^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/[A-Za-z0-9._~!$&'()*+,;=:%-]+)*$/i.test(trimmed)) {
    throw new Error(EXPLORER_URL_MESSAGE);
  }
  // The shared rule as well (host present, valid port, no control characters).
  assertSecureEndpointUrl(trimmed);
  return `https://${trimmed.slice('https://'.length)}`;
}

function sameText(a: string, b: string): boolean {
  return a.toLocaleLowerCase() === b.toLocaleLowerCase();
}

/**
 * Checks a form entry against the rules and the networks already saved,
 * WITHOUT any network request, and returns the normalized fields. Throws an
 * Error carrying the refusal sentence. Checked in this order: chain id
 * format, built-in collision, custom collision, the test-network tick, the
 * name, the symbol, the decimals, the RPC URL, the explorer, the count.
 */
export function validateCustomNetworkInput(
  input: CustomNetworkInput,
  existing: readonly CustomNetworkRecord[],
): Omit<CustomNetworkRecord, 'blockTimeMs' | 'addedAt'> {
  const chainId = parseCustomChainId(input.chainId);
  if (chainId === null) throw new Error(CHAIN_ID_FORMAT_MESSAGE);
  const caip2 = `eip155:${chainId}`;
  const builtIn = EVM_PROFILES.find((p) => p.caip2 === caip2);
  if (builtIn) throw new Error(builtInChainMessage(chainId, builtIn));
  const duplicate = existing.find((n) => n.chainId === chainId);
  if (duplicate) throw new Error(duplicateChainMessage(chainId, duplicate.name));
  const testnet = input.testnet === true;
  if (testnet && !isKnownPublicTestChainId(chainId)) throw new Error(unlistedTestNetworkMessage(chainId));

  const name = sanitizeDisplayName(input.name ?? '', MAX_NETWORK_NAME_LENGTH, 'network');
  if (!name.ok) throw new Error(name.error);
  if (EVM_PROFILES.some((p) => sameText(p.label, name.name) || sameText(builtInName(p), name.name))) {
    throw new Error(builtInNameMessage(name.name));
  }
  const nameClash = existing.find((n) => sameText(n.name, name.name));
  if (nameClash) throw new Error(duplicateNameMessage(nameClash.name));
  if (!testnet) {
    const word = TEST_NETWORK_WORDS.find((w) => name.name.toLowerCase().includes(w));
    if (word) throw new Error(testLikeNameMessage(word));
  }

  const symbol = (input.nativeSymbol ?? '').trim();
  if (!/^[A-Za-z0-9]{1,10}$/.test(symbol)) throw new Error(NATIVE_SYMBOL_MESSAGE);

  const decimalsText = String(input.nativeDecimals ?? '').trim();
  if (!/^[0-9]{1,3}$/.test(decimalsText)) throw new Error(DECIMALS_FORMAT_MESSAGE);
  const decimals = Number(decimalsText);
  if (decimals !== CUSTOM_NATIVE_DECIMALS) throw new Error(decimalsMessage(decimals));

  const rpcUrl = assertSecureEndpointUrl(input.rpcUrl ?? '');

  const explorerRaw = (input.explorerUrl ?? '').trim();
  const explorerUrl = explorerRaw === '' ? null : normalizeExplorerUrl(explorerRaw);

  if (existing.length >= MAX_CUSTOM_NETWORKS) throw new Error(MAX_CUSTOM_NETWORKS_MESSAGE);

  return { chainId, name: name.name, rpcUrl, nativeSymbol: symbol, nativeDecimals: CUSTOM_NATIVE_DECIMALS, explorerUrl, testnet };
}

// ---------------------------------------------------------------------------
// The runtime profile
// ---------------------------------------------------------------------------

/**
 * The EvmChainProfile of a stored custom network. The test-network flag is
 * the user's tick AND the allow-list, re-checked here; everything the
 * wallet has not verified for this chain is off (no AA pre-fill, no swaps,
 * no layer-2 fee model). The explorer base is used only for the
 * Etherscan-family /tx/ path (explorerTxBase; '' when none was given, which
 * every explorer-link builder treats as "no link").
 */
export function customNetworkProfile(r: CustomNetworkRecord): EvmChainProfile {
  const testnet = r.testnet && isKnownPublicTestChainId(r.chainId);
  return {
    caip2: `eip155:${r.chainId}`,
    chainIdDecimal: r.chainId,
    label: r.name,
    testnet,
    modeLabel: testnet ? `${r.name} test mode` : `${r.name} mode (a network you added)`,
    bannerText: testnet
      ? `TESTNET — ${r.name} test mode is on (a network you added). Amounts are test ${r.nativeSymbol}, not real funds.`
      : null,
    displaySymbol: testnet ? `test ${r.nativeSymbol}` : r.nativeSymbol,
    defaultRpcUrls: [r.rpcUrl],
    defaultRpcUrl: r.rpcUrl,
    explorerTxBase: r.explorerUrl ? `${r.explorerUrl}/tx/` : '',
    aaPrefill: null,
    kernelV33Verified: false,
    l1DataFee: false,
    swapsOffered: false,
    l1CostInGas: false,
    custom: {
      rpcUrl: r.rpcUrl,
      nativeSymbol: r.nativeSymbol,
      explorerBase: r.explorerUrl,
      blockTimeMs: r.blockTimeMs,
      testnetRequested: r.testnet,
    },
  };
}

/** The explorer page of an address on a custom network (Etherscan-family path, assumed), or null. */
export function customExplorerAddressUrl(r: Pick<CustomNetworkRecord, 'explorerUrl'>, address: string): string | null {
  return r.explorerUrl ? `${r.explorerUrl}/address/${address}` : null;
}

// ---------------------------------------------------------------------------
// The store: strict parse, read-only when damaged
// ---------------------------------------------------------------------------

const RECORD_FIELDS = [
  'chainId',
  'name',
  'rpcUrl',
  'nativeSymbol',
  'nativeDecimals',
  'explorerUrl',
  'testnet',
  'blockTimeMs',
  'addedAt',
] as const;

/** Re-validates one stored record; null when this module would not have written it. */
function reviveRecord(value: unknown, earlier: readonly CustomNetworkRecord[]): CustomNetworkRecord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== RECORD_FIELDS.length || !RECORD_FIELDS.every((f) => keys.includes(f))) return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.chainId !== 'string' ||
    typeof v.name !== 'string' ||
    typeof v.rpcUrl !== 'string' ||
    typeof v.nativeSymbol !== 'string' ||
    typeof v.nativeDecimals !== 'number' ||
    !(v.explorerUrl === null || typeof v.explorerUrl === 'string') ||
    typeof v.testnet !== 'boolean' ||
    !(v.blockTimeMs === null || (typeof v.blockTimeMs === 'number' && Number.isSafeInteger(v.blockTimeMs) && v.blockTimeMs > 0)) ||
    typeof v.addedAt !== 'string' ||
    Number.isNaN(Date.parse(v.addedAt))
  ) {
    return null;
  }
  let normalized: Omit<CustomNetworkRecord, 'blockTimeMs' | 'addedAt'>;
  try {
    normalized = validateCustomNetworkInput(
      {
        name: v.name,
        chainId: v.chainId,
        rpcUrl: v.rpcUrl,
        nativeSymbol: v.nativeSymbol,
        nativeDecimals: String(v.nativeDecimals),
        explorerUrl: v.explorerUrl ?? '',
        testnet: v.testnet,
      },
      earlier,
    );
  } catch {
    return null;
  }
  // Stored exactly in the normalized form, or not trusted.
  if (
    normalized.chainId !== v.chainId ||
    normalized.name !== v.name ||
    normalized.rpcUrl !== v.rpcUrl ||
    normalized.nativeSymbol !== v.nativeSymbol ||
    normalized.explorerUrl !== v.explorerUrl
  ) {
    return null;
  }
  return { ...normalized, blockTimeMs: v.blockTimeMs as number | null, addedAt: v.addedAt };
}

type ReadResult =
  | { state: 'empty' }
  | { state: 'ok'; networks: CustomNetworkRecord[]; dropped: number }
  | { state: 'unreadable' }
  | { state: 'storage-error' };

async function readStore(store: CustomNetworkStore): Promise<ReadResult> {
  let text: string | null;
  try {
    text = await store.getItem(CUSTOM_NETWORKS_KEY);
  } catch {
    return { state: 'storage-error' };
  }
  if (text === null) return { state: 'empty' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { state: 'unreadable' };
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    (parsed as { version?: unknown }).version !== STORE_VERSION ||
    !Array.isArray((parsed as { networks?: unknown }).networks)
  ) {
    return { state: 'unreadable' };
  }
  const networks: CustomNetworkRecord[] = [];
  let dropped = 0;
  for (const entry of (parsed as { networks: unknown[] }).networks) {
    // Each record is checked against the ones before it, so a duplicate
    // chain id or name and anything past MAX_CUSTOM_NETWORKS is dropped.
    const record = reviveRecord(entry, networks);
    if (record) networks.push(record);
    else dropped += 1;
  }
  return { state: 'ok', networks, dropped };
}

/** Loads the custom networks. Never throws. */
export async function loadCustomNetworks(store: CustomNetworkStore = AsyncStorage): Promise<CustomNetworkBook> {
  const read = await readStore(store);
  if (read.state === 'empty') return { networks: [], readOnly: false };
  if (read.state === 'unreadable' || read.state === 'storage-error') return { networks: [], readOnly: true };
  return { networks: read.networks, readOnly: read.dropped > 0 };
}

async function writeStore(store: CustomNetworkStore, networks: readonly CustomNetworkRecord[]): Promise<void> {
  await store.setItem(
    CUSTOM_NETWORKS_KEY,
    JSON.stringify({
      version: STORE_VERSION,
      networks: networks.map((n) => ({
        chainId: n.chainId,
        name: n.name,
        rpcUrl: n.rpcUrl,
        nativeSymbol: n.nativeSymbol,
        nativeDecimals: n.nativeDecimals,
        explorerUrl: n.explorerUrl,
        testnet: n.testnet,
        blockTimeMs: n.blockTimeMs,
        addedAt: n.addedAt,
      })),
    }),
  );
}

// ---------------------------------------------------------------------------
// The registry: hydration (the single read path) and updates after writes
// ---------------------------------------------------------------------------

let hydratedFrom: object | null = null;
let hydratingFor: object | null = null;
let hydrating: Promise<void> | null = null;
let registryReadOnly = false;

function applyRegistry(networks: readonly CustomNetworkRecord[]): void {
  setCustomEvmProfiles(networks.map(customNetworkProfile));
}

/**
 * Makes sure the custom-network profiles in config/evm-chain.ts were loaded
 * from `store`. Reads the store ONCE per store object (the app has one,
 * AsyncStorage); afterwards this module keeps the registry in step with
 * every write it makes. A storage failure is not remembered, so the next
 * call tries again. Never throws. config/prefs.ts loadPrefs awaits this
 * before it reads the network choice: that is the single read path.
 */
export function ensureCustomNetworksLoaded(store: CustomNetworkStore = AsyncStorage): Promise<void> {
  if (hydratedFrom === store) return Promise.resolve();
  if (hydrating && hydratingFor === store) return hydrating;
  hydratingFor = store;
  const run = (async () => {
    const read = await readStore(store);
    if (hydratingFor !== store) return; // another store took over meanwhile (check scripts only)
    if (read.state === 'storage-error') {
      // Nothing is cached: the next call reads again.
      applyRegistry([]);
      registryReadOnly = true;
      return;
    }
    const networks = read.state === 'ok' ? read.networks : [];
    try {
      applyRegistry(networks);
    } catch {
      applyRegistry([]);
    }
    registryReadOnly = read.state === 'unreadable' || (read.state === 'ok' && read.dropped > 0);
    hydratedFrom = store;
  })().catch(() => undefined);
  const pending: Promise<void> = run.finally(() => {
    if (hydrating === pending) hydrating = null;
  });
  hydrating = pending;
  return pending;
}

/** True when the store last loaded was damaged (Settings shows the Reset). */
export function customNetworksReadOnly(): boolean {
  return registryReadOnly;
}

/** Re-reads `store` into the registry after this module wrote it. */
async function refreshRegistry(store: CustomNetworkStore): Promise<CustomNetworkBook> {
  const book = await loadCustomNetworks(store);
  applyRegistry(book.networks);
  registryReadOnly = book.readOnly;
  hydratedFrom = store;
  hydratingFor = store;
  return book;
}

// One write queue per store: an add and a removal never interleave.
const queues = new WeakMap<object, Promise<unknown>>();
function serialized<T>(store: CustomNetworkStore, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(store) ?? Promise.resolve();
  const run = previous.then(task, task);
  queues.set(
    store,
    run.catch(() => undefined),
  );
  return run;
}

// ---------------------------------------------------------------------------
// Verification (network reads through the user's RPC URL)
// ---------------------------------------------------------------------------

export interface CustomNetworkVerification {
  /** The head block number when verified. */
  headNumber: bigint;
  /** How old the head block was by the device clock, in seconds. */
  headAgeSeconds: number;
  /** Measured milliseconds per block, or null. */
  blockTimeMs: number | null;
  /** Why the block time is null (for the Settings note), or null when measured. */
  blockTimeUnavailable: string | null;
}

export interface VerifyOptions {
  fetchFn?: FetchLike;
  /** Device clock in milliseconds; injectable for tests. */
  now?: () => number;
  timeoutMs?: number;
}

async function rpc(url: string, method: string, params: unknown[], options: VerifyOptions): Promise<unknown> {
  const fetchFn = options.fetchFn ?? (globalThis.fetch as unknown as FetchLike);
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
  const timeoutMs = options.timeoutMs ?? VERIFY_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject(new Error(`no answer within ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    const request = (async () => {
      const response = await fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = JSON.parse(await response.text()) as { result?: unknown; error?: { message?: unknown } };
      if (body.error) {
        const message = typeof body.error.message === 'string' ? body.error.message.slice(0, 160) : 'unknown error';
        throw new Error(`RPC error: ${message}`);
      }
      return body.result;
    })();
    return await Promise.race([request, expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function detailOf(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 200);
}

/** { number, timestamp } of a block object, or throws. */
function blockFacts(block: unknown, what: string): { number: bigint; timestamp: number } {
  const b = block as { number?: unknown; timestamp?: unknown } | null;
  if (!b || typeof b.number !== 'string' || !/^0x[0-9a-fA-F]{1,16}$/.test(b.number)) {
    throw new Error(`${what} has no readable number`);
  }
  if (typeof b.timestamp !== 'string' || !/^0x[0-9a-fA-F]{1,13}$/.test(b.timestamp)) {
    throw new Error(`${what} has no readable timestamp`);
  }
  return { number: BigInt(b.number), timestamp: Number(BigInt(b.timestamp)) };
}

/**
 * Verifies a custom network's RPC URL: chain identity, then the head
 * block's age, then the block time. Throws an Error with the refusal
 * sentence for anything that must stop the save; a block time that cannot
 * be measured is reported, not refused.
 */
export async function verifyCustomNetworkEndpoint(
  rpcUrl: string,
  chainIdDecimal: string,
  options: VerifyOptions = {},
): Promise<CustomNetworkVerification> {
  const url = assertSecureEndpointUrl(rpcUrl);
  const now = options.now ?? (() => Date.now());

  let chainResult: unknown;
  try {
    chainResult = await rpc(url, 'eth_chainId', [], options);
  } catch (e) {
    throw new Error(chainIdUnreadableMessage(detailOf(e)));
  }
  if (typeof chainResult !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(chainResult)) {
    throw new Error(chainIdUnreadableMessage(`answer: ${JSON.stringify(chainResult)?.slice(0, 80) ?? 'none'}`));
  }
  const reported = BigInt(chainResult).toString();
  if (reported !== chainIdDecimal) throw new Error(chainIdMismatchMessage(reported, chainIdDecimal));

  let head: { number: bigint; timestamp: number };
  try {
    head = blockFacts(await rpc(url, 'eth_getBlockByNumber', ['latest', false], options), 'the newest block');
  } catch (e) {
    throw new Error(headUnreadableMessage(detailOf(e)));
  }
  const bound = FRESHNESS_BOUND_SECONDS['evm-jsonrpc'];
  const { stale, ageSeconds } = assessHeadFreshness(head.timestamp, now(), bound);
  if (stale) throw new Error(staleHeadMessage(head.number, ageSeconds, bound));

  const sample = BigInt(BLOCK_TIME_SAMPLE_BLOCKS);
  let blockTimeMs: number | null = null;
  let blockTimeUnavailable: string | null = null;
  if (head.number < sample) {
    blockTimeUnavailable = `the chain has fewer than ${BLOCK_TIME_SAMPLE_BLOCKS} blocks`;
  } else {
    try {
      const older = blockFacts(
        await rpc(url, 'eth_getBlockByNumber', [`0x${(head.number - sample).toString(16)}`, false], options),
        'the older block',
      );
      const span = head.timestamp - older.timestamp;
      if (span > 0) blockTimeMs = Math.round((span * 1000) / BLOCK_TIME_SAMPLE_BLOCKS);
      else blockTimeUnavailable = `the ${BLOCK_TIME_SAMPLE_BLOCKS} blocks carry no time difference`;
    } catch (e) {
      blockTimeUnavailable = detailOf(e);
    }
  }
  return { headNumber: head.number, headAgeSeconds: ageSeconds, blockTimeMs, blockTimeUnavailable };
}

// ---------------------------------------------------------------------------
// Add, remove, reset
// ---------------------------------------------------------------------------

/**
 * Validates, verifies and saves a custom network. Throws (persisting
 * nothing) with the refusal sentence for a read-only store, any rule in
 * validateCustomNetworkInput, or a failed verification. The rules are
 * checked again after the network reads, against the list as it is then.
 */
export async function addCustomNetwork(
  input: CustomNetworkInput,
  options: VerifyOptions & { store?: CustomNetworkStore; clock?: () => Date } = {},
): Promise<{ record: CustomNetworkRecord; verification: CustomNetworkVerification }> {
  const store = options.store ?? AsyncStorage;
  await ensureCustomNetworksLoaded(store);
  const before = await loadCustomNetworks(store);
  if (before.readOnly) throw new Error(CUSTOM_NETWORKS_READ_ONLY_MESSAGE);
  const draft = validateCustomNetworkInput(input, before.networks);
  const verification = await verifyCustomNetworkEndpoint(draft.rpcUrl, draft.chainId, options);
  return serialized(store, async () => {
    const current = await loadCustomNetworks(store);
    if (current.readOnly) throw new Error(CUSTOM_NETWORKS_READ_ONLY_MESSAGE);
    const checked = validateCustomNetworkInput(input, current.networks);
    const record: CustomNetworkRecord = {
      ...checked,
      blockTimeMs: verification.blockTimeMs,
      addedAt: (options.clock ?? (() => new Date()))().toISOString(),
    };
    await writeStore(store, [...current.networks, record]);
    await refreshRegistry(store);
    return { record, verification };
  });
}

/** One kind of per-chain data and how to delete a chain's share of it. */
export interface ChainDataRemover {
  id: string;
  /** Plain name for the confirmation and the report ("tracked tokens"). */
  label: string;
  /** Deletes `chain`'s entries only; returns how many were deleted (0 = none). */
  remove(chain: string, store: CustomNetworkStore): Promise<number>;
}

/**
 * The per-chain data a removal deletes, in order, each through the owning
 * module's own function (loaded on demand, so this module stays light for
 * config/prefs.ts) or, for the browser connections, by filtering their list
 * by chain. Every remover touches ONLY the given chain's entries.
 */
export const CHAIN_DATA_REMOVERS: readonly ChainDataRemover[] = [
  {
    id: 'tokens',
    label: 'tracked tokens',
    async remove(chain, store) {
      const { forgetTokensForChain } = await import('./tokens.ts');
      return (await forgetTokensForChain(chain, store)) ? 1 : 0;
    },
  },
  {
    id: 'endpoint',
    label: 'endpoint override',
    async remove(chain, store) {
      const { resetEndpoint } = await import('../config/networks.ts');
      return (await resetEndpoint(chain, { store })) ? 1 : 0;
    },
  },
  {
    id: 'aa',
    label: 'smart-account settings',
    async remove(chain, store) {
      const { forgetAaConfigForChain } = await import('./aa.ts');
      return (await forgetAaConfigForChain(chain, store)) ? 1 : 0;
    },
  },
  {
    id: 'history-indexer',
    label: 'history indexer',
    async remove(chain, store) {
      const { clearIndexerUrl, getIndexerConfig } = await import('./indexer.ts');
      const config = await getIndexerConfig(chain, store);
      const had = config.url !== null || config.ignoredUrlReason !== null;
      await clearIndexerUrl(chain, store);
      return had ? 1 : 0;
    },
  },
  {
    id: 'nft-indexer',
    label: 'NFT indexer',
    async remove(chain, store) {
      const { clearNftIndexerUrl, getNftIndexerConfig } = await import('./nfts.ts');
      const config = await getNftIndexerConfig(chain, store);
      const had = config.url !== null || config.ignoredUrlReason !== null;
      await clearNftIndexerUrl(chain, store);
      return had ? 1 : 0;
    },
  },
  {
    id: 'contacts',
    label: 'contacts',
    async remove(chain, store) {
      const { forgetContactsForNetwork } = await import('./contacts.ts');
      return forgetContactsForNetwork(chain, store);
    },
  },
  {
    id: 'notes',
    label: 'transaction notes',
    async remove(chain, store) {
      const { NOTES_READ_ONLY_MESSAGE, loadNotes, saveNote } = await import('./notes.ts');
      const book = await loadNotes(store);
      if (book.readOnly) throw new Error(NOTES_READ_ONLY_MESSAGE);
      const mine = book.notes.filter((n) => n.network === chain);
      for (const note of mine) {
        // An empty text removes the note (notes.ts saveNote), through the
        // notes module's own write queue.
        await saveNote(chain, note.txid ? { txid: note.txid } : { userOpHash: note.userOpHash! }, '', { store });
      }
      return mine.length;
    },
  },
  {
    id: 'spending',
    label: 'spending limits',
    async remove(chain, store) {
      const { listSpendingPolicies, listSpendingScopes, removeSpendingPolicy } = await import('./spending-policy.ts');
      const scopes = await listSpendingScopes(store);
      if (scopes.damaged) throw new Error('The saved spending limits could not be read.');
      let count = 0;
      for (const { scope } of scopes.scopes.filter((s) => s.scope.chain === chain)) {
        const { policies } = await listSpendingPolicies(scope, store);
        // Removing a scope's last limit also clears its spending record.
        for (const policy of policies) {
          if (await removeSpendingPolicy(scope, policy.id, { store })) count += 1;
        }
      }
      return count;
    },
  },
  {
    id: 'browser',
    label: 'in-app browser connections',
    async remove(chain, store) {
      const { BROWSER_CONNECTIONS_KEY } = await import('./browser-sites.ts');
      const raw = await store.getItem(BROWSER_CONNECTIONS_KEY);
      if (!raw) return 0;
      const list = JSON.parse(raw) as unknown;
      if (!Array.isArray(list)) throw new Error('The saved browser connections could not be read.');
      // Filtered on the raw list so every other entry is written back as stored.
      const kept = list.filter((e) => !(e && typeof e === 'object' && (e as { chain?: unknown }).chain === chain));
      if (kept.length === list.length) return 0;
      await store.setItem(BROWSER_CONNECTIONS_KEY, JSON.stringify(kept));
      return list.length - kept.length;
    },
  },
  {
    id: 'walletconnect',
    label: 'WalletConnect smart-account records',
    async remove(chain, store) {
      const { forgetWalletConnectChainData } = await import('./walletconnect.ts');
      return forgetWalletConnectChainData(chain, store);
    },
  },
];

/**
 * What a removal deliberately KEEPS (shown in the confirmation): records of
 * things that exist on the chain itself — session keys and subscriptions
 * (their key material is in the secure store and only the Sessions screen
 * deletes it), guardian and inheritance records, passkey details and
 * multi-signature accounts. Deleting them would not undo anything on-chain
 * and would take away the only local record needed to revoke or recover;
 * they reappear if the same chain id is added again.
 */
export const KEPT_ON_REMOVAL_SENTENCE =
  'Kept on this phone: session keys, subscriptions, guardian and inheritance records, passkey details and ' +
  'multi-signature accounts for this chain. They describe things that exist on the network itself, so deleting ' +
  'them would undo nothing there and would remove what you need to revoke or recover them; they come back if you ' +
  'add the same chain id again. Nothing on the network changes.';

/** The confirmation text for removing a custom network. */
export function removalConfirmationText(name: string, chainId: string, active: boolean): string {
  const labels = CHAIN_DATA_REMOVERS.map((r) => r.label);
  return (
    `Remove “${name}” (chain id ${chainId}) from this wallet? This also deletes, for this chain only: ` +
    `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}. ` +
    (active ? 'The wallet switches back to Ethereum mainnet first. ' : '') +
    KEPT_ON_REMOVAL_SENTENCE
  );
}

export interface RemovalReport {
  /** Stores where entries for the chain were deleted, with counts. */
  removed: { id: string; label: string; count: number }[];
  /** Stores that held nothing for the chain. */
  untouched: string[];
  /** Stores whose deletion failed (the network is then kept, so the removal can be repeated). */
  failed: { id: string; label: string; reason: string }[];
  /** True when the network itself was removed from the list. */
  networkRemoved: boolean;
  /** True when the active choice was switched back to Ethereum mainnet. */
  switchedToMainnet: boolean;
}

/**
 * Removes a custom network: (1) if it is the active choice, the choice
 * becomes Ethereum mainnet (config/prefs.ts); (2) each remover deletes the
 * chain's entries in its store; (3) the network is deleted from the list
 * and the registry. When any remover fails, the network stays listed (so
 * nothing is orphaned silently and Remove can be repeated) and the report
 * names the failures. Throws for a read-only list or an unknown network.
 */
export async function removeCustomNetwork(
  caip2: string,
  options: { store?: CustomNetworkStore; removers?: readonly ChainDataRemover[] } = {},
): Promise<RemovalReport> {
  const store = options.store ?? AsyncStorage;
  const removers = options.removers ?? CHAIN_DATA_REMOVERS;
  await ensureCustomNetworksLoaded(store);
  return serialized(store, async () => {
    const book = await loadCustomNetworks(store);
    if (book.readOnly) throw new Error(CUSTOM_NETWORKS_READ_ONLY_MESSAGE);
    const target = book.networks.find((n) => `eip155:${n.chainId}` === caip2);
    if (!target) throw new Error('That network is not in your list of custom networks.');

    const { loadPrefs, savePrefs } = await import('../config/prefs.ts');
    let switchedToMainnet = false;
    if ((await loadPrefs(store)).testNetwork === caip2) {
      await savePrefs({ testNetwork: null }, store);
      switchedToMainnet = true;
    }

    const report: RemovalReport = {
      removed: [],
      untouched: [],
      failed: [],
      networkRemoved: false,
      switchedToMainnet,
    };
    for (const remover of removers) {
      try {
        const count = await remover.remove(caip2, store);
        if (count > 0) report.removed.push({ id: remover.id, label: remover.label, count });
        else report.untouched.push(remover.id);
      } catch (e) {
        report.failed.push({ id: remover.id, label: remover.label, reason: detailOf(e) });
      }
    }
    if (report.failed.length === 0) {
      const latest = await loadCustomNetworks(store);
      if (latest.readOnly) throw new Error(CUSTOM_NETWORKS_READ_ONLY_MESSAGE);
      await writeStore(
        store,
        latest.networks.filter((n) => `eip155:${n.chainId}` !== caip2),
      );
      report.networkRemoved = true;
    }
    await refreshRegistry(store);
    return report;
  });
}

/** The sentence summarizing a removal (Settings alert). */
export function describeRemoval(name: string, report: RemovalReport): string {
  const parts: string[] = [];
  if (report.networkRemoved) parts.push(`“${name}” was removed.`);
  else parts.push(`“${name}” was NOT removed, because some of its data could not be deleted; nothing else changed for it.`);
  if (report.switchedToMainnet) parts.push('The wallet is back on Ethereum mainnet.');
  if (report.removed.length > 0) {
    parts.push(`Deleted for this chain: ${report.removed.map((r) => `${r.label} (${r.count})`).join(', ')}.`);
  } else {
    parts.push('No other data was stored for this chain.');
  }
  if (report.failed.length > 0) {
    parts.push(`Could not delete: ${report.failed.map((f) => `${f.label} (${f.reason})`).join('; ')}. Try Remove again.`);
  }
  return parts.join(' ');
}

/**
 * Replaces a damaged list with an empty one (the explicit way out of the
 * read-only state). Data kept for those chains stays on the phone unused
 * and comes back if the same chain id is added again. If a custom network
 * was the active choice, the choice becomes Ethereum mainnet.
 */
export async function resetCustomNetworks(store: CustomNetworkStore = AsyncStorage): Promise<void> {
  return serialized(store, async () => {
    const { loadPrefs, savePrefs } = await import('../config/prefs.ts');
    // Read the choice while the registry still knows the networks: once it
    // is empty, a stored custom choice would read as the legacy fallback.
    const before = await loadPrefs(store);
    const customChosen = before.testNetwork !== null && !EVM_PROFILES.some((p) => p.caip2 === before.testNetwork);
    await store.setItem(CUSTOM_NETWORKS_KEY, JSON.stringify({ version: STORE_VERSION, networks: [] }));
    await refreshRegistry(store);
    if (customChosen) await savePrefs({ testNetwork: null }, store);
  });
}
