import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  MAX_GUARDIAN_APPROVAL_SCAN_BLOCKS,
  encodeVetoCall,
  guardianDelayWraps,
  guardianSignatureExposure,
  guardianUninstallCalls,
  scanGuardianApprovals,
  type Call,
  type FoundGuardianApproval,
  type JsonRpcTransport,
  type KernelGuardian,
  type KernelGuardianSet,
  type KernelGuardianState,
} from '@shiba-wallet/chains-evm';
// Explicit .ts extensions: scripts/check-inheritance.mjs loads this module
// under Node's type stripping, which resolves relative specifiers literally.
import { eip155Caip2, isFeatureAllowed, isTestNetwork } from '../config/readiness.ts';
import type { AaClientBundle } from './aa.ts';
import {
  addWatchedProposal,
  buildGuardianSet,
  formatDuration,
  getRecoveryRecord,
  prepareGuardianInstallQuote,
  quoteRootOperation,
  readProposalView,
  type GuardianDraft,
  type GuardianOperationQuote,
  type ProposalView,
  type RecoveryRecordEntry,
} from './recovery.ts';
import type { KeyValueStore } from './tokens.ts';

/**
 * Inheritance switch (feature 48), phase 14 item 4 — a TEST-NETWORK
 * DEMONSTRATION built on the guardian machinery (recovery.ts and the
 * engine's kernel-recovery.ts). It is deliberately not offered with real
 * funds, because the deployed modules cannot provide an inheritance switch
 * whose risks a user can reasonably accept. Every fact below is from
 * WeightedECDSAValidator.sol and Kernel.sol at kernel tag v3.3 (commit
 * cd697c7e21715d015e0643af22310a99aa17433b), and each behaviour was
 * exercised with eth_simulateV1 against the deployed Sepolia contracts by
 * scripts/testnet/inheritance-smoke.mjs (scenario ids S1–S8 below):
 *
 *  - An heir is a guardian of the weighted validator with a long delay. The
 *    delay is ONE value per account (weightedStorage[kernel].delay, uint48
 *    seconds), copied into a proposal's validAfter at the moment its
 *    approvals reach the threshold (approve / approveWithSig, lines 152 and
 *    176). Changing the delay later does not move approvals already made.
 *  - The heir starts the clock, not the owner's silence: a takeover is a
 *    proposal the heir approves on-chain whenever they choose; after the
 *    delay the heir submits it (S1). The owner can veto it at any time
 *    before it executes, even after the delay has passed (S2, S3).
 *  - The heir can sign AS THE ACCOUNT through ERC-1271 from the moment the
 *    set is installed, with no delay and no veto: Kernel's isValidSignature
 *    accepts any installed validator (ValidationManager._verifySignature),
 *    and the weighted validator checks only the heirs' weight
 *    (isValidSignatureWithSender, lines 280–304). Proven: the heir signed a
 *    USDC permit for the account and pulled its USDC on day one (S1); the
 *    same holds for any token the account approved to Permit2, whose
 *    SignatureVerification.verify calls ERC-1271 for contract owners
 *    (Uniswap/permit2 cc56ad0f, src/libraries/SignatureVerification.sol).
 *  - The validator emits no event for approvals (lines 58–59 are its only
 *    events) and keys proposals by a hash of (account, callData, full
 *    nonce), so the owner cannot list takeover attempts. This module finds
 *    them only (1) when a request is shared with the wallet, and (2) by
 *    scanning blocks for TOP-LEVEL approve / approveWithSig transactions to
 *    the validator (the engine's scanGuardianApprovals). Approvals made from
 *    inside another contract are not found.
 *  - There is no proof of life. renew() keeps approved proposals (S4);
 *    removing the set pauses them and re-installing the same heir REVIVES
 *    them (S5) — a veto while the set is removed prevents that (S5b);
 *    bumping a nonce lane voids only proposals on that lane, and an heir can
 *    pick any of 255 × 65,536 lanes (S6); Kernel's invalidateNonce disables
 *    the heir but also this wallet's own 0x01-envelope signatures (S7).
 *  - One guardian set per account: an account holds guardians OR heirs.
 *  - A delay near 2^48 seconds wraps to the past (S8); delays here are at
 *    most 365 days and checked with the engine's guardianDelayWraps.
 *
 * Free of React Native imports apart from the AsyncStorage default (as in
 * recovery.ts), so the check script runs this exact code under Node.
 */

// ---------------------------------------------------------------------------
// Plain-language copy (one source for every surface; pinned by the check script)
// ---------------------------------------------------------------------------

export const INHERITANCE_TITLE = 'Inheritance (demonstration)';

/** The first thing the Inheritance screen, its form, its confirm screen and its status card say. */
export const INHERITANCE_RISK_STATEMENT =
  'Read this first: your heir can sign messages AS THIS ACCOUNT from the moment you add them — not after ' +
  'the delay. Those signatures can move your tokens: with one signature the heir can give itself an ' +
  'allowance on this account’s USDC (USDC’s permit accepts the account’s signatures) or move any token ' +
  'you have approved to Permit2, and then take it. They also work for sign-in requests and off-chain ' +
  'orders. The delay and your veto protect only the change of owner, never these signatures. Add as heir ' +
  'only someone you would trust with everything in this account today.';

/** How the switch works and where it falls short, in order. */
export const INHERITANCE_HOW_IT_WORKS: readonly string[] = [
  'Your heir does not wait for your silence: the heir starts the clock by approving a takeover on-chain, ' +
    'whenever they choose. When the delay has passed, the heir can make any key the owner of this account ' +
    'unless you veto that takeover first. You can veto it at any time before it executes, even after the ' +
    'delay has passed.',
  'The guardian contract does not announce approvals. This wallet finds takeover attempts in two ways ' +
    'only: requests shared with it, and a scan of blocks for approval transactions sent directly to the ' +
    'guardian contract. An approval sent through another contract, or in blocks this wallet has not ' +
    'scanned yet, is not found.',
  'There is no “I am still here” button, because nothing the account can do cancels a takeover it does ' +
    'not know about: changing the heir list keeps earlier approvals, and removing the heirs only pauses ' +
    'them — adding the same heir again revives them. Only a veto of a specific takeover stops it.',
  'An account has one guardian set: it holds either guardians or heirs, not both.',
];

/** What an honest production inheritance switch would need (shown on the screen and in the report). */
export const INHERITANCE_PRODUCTION_NEEDS =
  'A production inheritance switch would need modules that do not exist in audited, deployed form for ' +
  'this account today: an heir validator that refuses every message signature (so the heir has no power ' +
  'before the takeover), approvals that emit events (so the owner’s wallet can always see a takeover ' +
  'coming), and a claim that expires whenever the owner uses the account (a real proof of life).';

export const INHERITANCE_ACK_TEXT =
  'I understand that my heir can sign as this account from today, including token permits, and that a ' +
  'takeover I do not see in time cannot be stopped.';

export const INHERITANCE_ACK_REQUIRED = 'Turn on the acknowledgement above to continue. Nothing was signed.';

export const INHERITANCE_TESTNET_ONLY =
  'Inheritance is a test-network demonstration only: the deployed modules let an heir sign as the account ' +
  'immediately and give the owner no reliable way to see a takeover coming, so it is not offered with real ' +
  'funds. Nothing was signed.';

export const INHERITANCE_GUARDIANS_CONFLICT =
  'This account already has guardians. The guardian contract holds one set per account, so heirs cannot be ' +
  'added next to them. Remove the guardians on the Guardians screen first if you want heirs instead.';

export const INHERITANCE_REMOVE_NOTE =
  'Removing the heirs also vetoes every takeover this wallet knows about that is still pending, in the ' +
  'same operation. A takeover this wallet has not found stays approved: if you ever add the same heir ' +
  'again, it comes back to life.';

/** Shown on the Guardians screen when the account's set is an heir set. */
export const HEIRS_ON_GUARDIANS_NOTE =
  'These are heirs, set up on the Inheritance (demonstration) screen. Manage them there.';

/** Shown on the heir's side (Recover / Approve a recovery) when opened for an inheritance takeover. */
export const HEIR_SIDE_NOTE =
  'Inheritance (demonstration): you are the heir. The takeover uses the guardian recovery steps: start the ' +
  'request from the account that should become the new owner, approve it with your heir address, wait ' +
  'out the delay, then submit it with your heir address. The current owner can veto it until it executes.';

export const HEIR_NEW_OWNER_NOTE =
  'The new owner must be an account other than your heir address: the wallet refuses a guardian or heir as ' +
  'the new owner.';

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** Wallet policy: a small set (the contract allows 32; a will names few people). */
export const MAX_HEIRS = 5;

/** Wallet policy: the longest delay offered. */
export const MAX_INHERITANCE_DELAY_SECONDS = 365 * 86_400;

/**
 * Latest approval time the delay must survive without wrapping (unix
 * seconds, 2200-01-01T00:00:00Z): an heir may approve decades after setup.
 */
export const INHERITANCE_WRAP_HORIZON = 7_258_118_400;

export const INHERITANCE_DELAY_PRESETS: readonly { label: string; seconds: number }[] = [
  { label: '10 minutes (test networks, demonstration)', seconds: 600 },
  { label: '30 days', seconds: 30 * 86_400 },
  { label: '90 days', seconds: 90 * 86_400 },
  { label: '180 days', seconds: 180 * 86_400 },
  { label: '365 days', seconds: 365 * 86_400 },
];

export const DEFAULT_INHERITANCE_DELAY_SECONDS = 600;

/** Refuses outside a test network, before any request. */
export function assertInheritanceAllowed(caip2: string): void {
  // Both rules: the test-network check and the readiness switchboard row
  // (config/readiness.ts 'inheritance', testnet-only and enforced); the
  // refusal keeps the demonstration sentence.
  if (!isTestNetwork(caip2) || !isFeatureAllowed('inheritance', caip2)) throw new Error(INHERITANCE_TESTNET_ONLY);
}

/**
 * Validates an inheritance delay: one of the presets, positive (0 would
 * remove the veto), at most 365 days, and never wrapping at 2^48 for
 * approvals up to INHERITANCE_WRAP_HORIZON (engine guardianDelayWraps).
 */
export function validateInheritanceDelay(delaySeconds: number): string | null {
  if (!INHERITANCE_DELAY_PRESETS.some((p) => p.seconds === delaySeconds)) return 'Choose one of the delays offered.';
  if (delaySeconds <= 0 || delaySeconds > MAX_INHERITANCE_DELAY_SECONDS) return 'Choose one of the delays offered.';
  if (guardianDelayWraps(delaySeconds, INHERITANCE_WRAP_HORIZON)) return 'This delay is too long for the contract.';
  return null;
}

/**
 * The heir set from the form: 1 to MAX_HEIRS heirs, address syntax and
 * labels through recovery.ts buildGuardianSet (engine-validated addresses),
 * a preset delay (never 0). The engine's validateGuardianSet runs on review.
 */
export function buildHeirSet(args: {
  drafts: readonly GuardianDraft[];
  threshold: string;
  delaySeconds: number;
}): { set: KernelGuardianSet; labels: Record<string, string> } {
  if (args.drafts.length === 0) throw new Error('Name at least one heir.');
  if (args.drafts.length > MAX_HEIRS) throw new Error(`At most ${MAX_HEIRS} heirs.`);
  const delayProblem = validateInheritanceDelay(args.delaySeconds);
  if (delayProblem) throw new Error(delayProblem);
  // Address syntax, weights and labels: the guardian form's rules (engine-validated addresses).
  return buildGuardianSet({
    drafts: args.drafts,
    threshold: args.threshold,
    delaySeconds: args.delaySeconds,
    noVetoAcknowledged: false,
    role: 'heir',
  });
}

/** How many heir rows have an address typed in (blank rows do not count). */
export function heirCount(drafts: readonly GuardianDraft[]): number {
  return drafts.filter((d) => d.address.trim() !== '').length;
}

/**
 * Whether the inheritance form's Review button is enabled: the
 * acknowledgement is on AND at least one heir has an address. With no heir
 * the button stays disabled even with the acknowledgement on (finding 4 of
 * the phase 14 emulator pass).
 */
export function canReviewHeirs(args: { drafts: readonly GuardianDraft[]; acknowledged: boolean }): boolean {
  return args.acknowledged && heirCount(args.drafts) > 0;
}

/** True when the record labels the account's set as heirs. */
export function isHeirRecord(entry: RecoveryRecordEntry | null): boolean {
  return entry?.metadata.guardians?.role === 'heirs';
}

/**
 * Null when heirs may be set up or managed here; otherwise why not. Any
 * guardian state on-chain (even partial) that the record does not label as
 * heirs counts as guardians, so the two flows never overwrite each other.
 */
export function inheritanceConflict(state: KernelGuardianState, entry: RecoveryRecordEntry | null): string | null {
  const configured = state.validatorInitialized || state.validationInstalled || state.recoveryRouted || state.recoveryAllowed;
  if (configured && !isHeirRecord(entry)) return INHERITANCE_GUARDIANS_CONFLICT;
  return null;
}

/** The exposure warning in heir words (engine guardianSignatureExposure, same numbers as for guardians). */
export function describeHeirExposure(set: KernelGuardianSet, labelFor?: (address: string) => string | null): string {
  const exposure = guardianSignatureExposure(set);
  const name = (g: KernelGuardian) => {
    const label = labelFor?.(g.address) ?? null;
    return label ? `${label} (${g.address})` : g.address;
  };
  if (set.guardians.length === 1) {
    return `Your heir ${name(set.guardians[0]!)} alone can sign messages as this account from the moment this set is installed.`;
  }
  const solo = set.guardians.filter((g) => 2 * g.weight >= set.threshold);
  if (exposure.singleGuardianCanSign) {
    return (
      'ONE heir alone can sign messages as this account from the moment this set is installed — any heir ' +
      `holding at least half the threshold weight: here ${solo.map(name).join(', ')}. The deployed contract lets ` +
      'the last signature repeat an earlier signer, so the heaviest heir counts twice.'
    );
  }
  return (
    `${exposure.signatureMinimumGuardians} heirs together can sign messages as this account from the moment this ` +
    `set is installed; the takeover itself needs ${exposure.recoveryMinimumGuardians}.`
  );
}

// ---------------------------------------------------------------------------
// Root-signed operations (owner): install heirs, remove heirs (+ vetoes)
// ---------------------------------------------------------------------------

/**
 * Quotes installing the heir set as ONE root-signed operation through the
 * guardian install path (recovery.ts prepareGuardianInstallQuote: engine
 * validation, finding-4 guard, byte-checked install calls, bundler
 * estimate), refused before any request outside a test network or without
 * the acknowledgement. The quote carries role 'heirs', so the recovery
 * record describes the set as heirs.
 */
export async function prepareHeirInstallQuote(
  bundle: AaClientBundle,
  ownerAddress: string,
  account: string,
  set: KernelGuardianSet,
  labels: Record<string, string>,
  options: { acknowledged: boolean; state: KernelGuardianState; entry: RecoveryRecordEntry | null },
): Promise<GuardianOperationQuote> {
  assertInheritanceAllowed(eip155Caip2(bundle.chainId));
  if (!options.acknowledged) throw new Error(INHERITANCE_ACK_REQUIRED);
  const conflict = inheritanceConflict(options.state, options.entry);
  if (conflict) throw new Error(conflict);
  if (set.guardians.length === 0 || set.guardians.length > MAX_HEIRS) throw new Error(`Name 1 to ${MAX_HEIRS} heirs.`);
  const delayProblem = validateInheritanceDelay(set.delaySeconds);
  if (delayProblem) throw new Error(delayProblem);
  const op = await prepareGuardianInstallQuote(bundle, ownerAddress, account, set, labels);
  return { ...op, role: 'heirs' };
}

/** The calls of "Remove heirs": the engine's three uninstall calls, then veto(hash) per pending takeover. */
export function heirRemovalCalls(account: string, vetoHashes: readonly string[]): Call[] {
  const unique = [...new Set(vetoHashes.map((h) => h.toLowerCase()))];
  return [...guardianUninstallCalls(account), ...unique.map((h) => encodeVetoCall(h))];
}

/**
 * Quotes removing the heirs AND vetoing every known pending takeover
 * (ongoing with approvals, or approved) in one root operation: a removal
 * alone only pauses an approval, and re-adding the same heir would revive it
 * (smoke S5). Not gated to test networks: removal must always be possible.
 */
export async function prepareHeirRemoveQuote(
  bundle: AaClientBundle,
  ownerAddress: string,
  account: string,
  pending: readonly ProposalView[],
): Promise<GuardianOperationQuote & { vetoed: string[] }> {
  const vetoed = pending.filter((p) => p.canVeto).map((p) => p.hash.toLowerCase());
  const calls = heirRemovalCalls(account, vetoed);
  const quote = await quoteRootOperation(bundle, ownerAddress, account, calls);
  return { kind: 'remove', account, owner: ownerAddress, calls, quote, set: null, labels: {}, proposalHash: null, vetoed };
}

// ---------------------------------------------------------------------------
// Checking for takeover attempts
// ---------------------------------------------------------------------------

export const INHERITANCE_STORE_KEY = 'shiba-wallet.inheritance.v1';
const STORE_VERSION = 1;

/**
 * Blocks one check reads (each is a full block with every transaction).
 * Wallet policy, sized for a phone on a free endpoint: 60 blocks is about 12
 * minutes on Ethereum Sepolia, 2 minutes on Base Sepolia and only about 15
 * seconds on Arbitrum Sepolia (0.25 s blocks, risk.ts), where a check
 * therefore covers little time and the coverage sentence says how many
 * blocks are still unscanned. The engine caps a single scan at
 * MAX_GUARDIAN_APPROVAL_SCAN_BLOCKS.
 */
export const INHERITANCE_SCAN_BLOCKS_PER_CHECK = 60;

/** Kept found approvals per account (newest kept). */
const MAX_FOUND = 50;

export interface FoundApprovalRecord {
  proposalHash: string;
  txHash: string;
  /** Decimal block number. */
  blockNumber: string;
  from: string;
  approvers: (string | null)[];
}

export interface TakeoverScanState {
  /** Decimal first block the scan covers (the heir set's install block when known). */
  startBlock: string;
  /** Decimal last block scanned, or null before the first scan. */
  scannedThrough: string | null;
  /** True when startBlock is the install block (complete coverage is possible). */
  startsAtInstall: boolean;
  lastCheckedAt: number | null;
  found: FoundApprovalRecord[];
}

function scanKey(chain: string, account: string): string {
  return `${chain}|${account.toLowerCase()}`;
}

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const HASH32 = /^0x[0-9a-f]{64}$/;

function reviveScanState(value: unknown): TakeoverScanState | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.startBlock !== 'string' || !DECIMAL.test(v.startBlock)) return null;
  if (v.scannedThrough !== null && (typeof v.scannedThrough !== 'string' || !DECIMAL.test(v.scannedThrough))) return null;
  if (typeof v.startsAtInstall !== 'boolean') return null;
  if (v.lastCheckedAt !== null && (typeof v.lastCheckedAt !== 'number' || !Number.isFinite(v.lastCheckedAt))) return null;
  const found: FoundApprovalRecord[] = [];
  for (const f of Array.isArray(v.found) ? (v.found as unknown[]) : []) {
    if (typeof f !== 'object' || f === null) continue;
    const r = f as Record<string, unknown>;
    if (typeof r.proposalHash !== 'string' || !HASH32.test(r.proposalHash)) continue;
    if (typeof r.txHash !== 'string' || !HASH32.test(r.txHash)) continue;
    if (typeof r.blockNumber !== 'string' || !DECIMAL.test(r.blockNumber)) continue;
    if (typeof r.from !== 'string') continue;
    if (!Array.isArray(r.approvers)) continue;
    found.push({
      proposalHash: r.proposalHash,
      txHash: r.txHash,
      blockNumber: r.blockNumber,
      from: r.from,
      approvers: (r.approvers as unknown[]).map((a) => (typeof a === 'string' ? a : null)),
    });
  }
  return {
    startBlock: v.startBlock,
    scannedThrough: (v.scannedThrough as string | null) ?? null,
    startsAtInstall: v.startsAtInstall,
    lastCheckedAt: (v.lastCheckedAt as number | null) ?? null,
    found: found.slice(-MAX_FOUND),
  };
}

async function readScanMap(store: KeyValueStore): Promise<Record<string, unknown>> {
  const text = await store.getItem(INHERITANCE_STORE_KEY);
  if (text === null) return {};
  try {
    const parsed = JSON.parse(text) as { version?: unknown; entries?: unknown };
    if (parsed?.version === STORE_VERSION && parsed.entries && typeof parsed.entries === 'object' && !Array.isArray(parsed.entries)) {
      return parsed.entries as Record<string, unknown>;
    }
  } catch {
    // An unreadable scan state only loses coverage bookkeeping; the next check starts again.
  }
  return {};
}

export async function getTakeoverScanState(
  chain: string,
  account: string,
  store: KeyValueStore = AsyncStorage,
): Promise<TakeoverScanState | null> {
  return reviveScanState((await readScanMap(store))[scanKey(chain, account)]);
}

async function writeScanState(chain: string, account: string, state: TakeoverScanState | null, store: KeyValueStore): Promise<void> {
  const entries = await readScanMap(store);
  if (state) entries[scanKey(chain, account)] = state;
  else delete entries[scanKey(chain, account)];
  await store.setItem(INHERITANCE_STORE_KEY, JSON.stringify({ version: STORE_VERSION, entries }));
}

/**
 * Every takeover approval the "Check for takeover attempts" scan has found
 * and stored, across all accounts and networks (read-only; the scan's own
 * bookkeeping under INHERITANCE_STORE_KEY). Used by the local alerts
 * (notifications.ts) to tell, once per proposal, that a recovery was
 * started. Unreadable entries are skipped, as getTakeoverScanState does.
 */
export async function listFoundTakeoverApprovals(
  store: KeyValueStore = AsyncStorage,
): Promise<{ chain: string; account: string; proposalHash: string }[]> {
  const out: { chain: string; account: string; proposalHash: string }[] = [];
  for (const [key, value] of Object.entries(await readScanMap(store))) {
    const split = key.lastIndexOf('|');
    if (split <= 0) continue;
    const state = reviveScanState(value);
    if (!state) continue;
    for (const f of state.found) out.push({ chain: key.slice(0, split), account: key.slice(split + 1), proposalHash: f.proposalHash });
  }
  return out;
}

/** Forgets the scan bookkeeping (after the heirs are removed; a new set starts its own scan). */
export async function clearTakeoverScanState(chain: string, account: string, store: KeyValueStore = AsyncStorage): Promise<void> {
  await writeScanState(chain, account, null, store);
}

/** The block of the heir set's install transaction, when the record names one and the node returns its receipt. */
async function installBlockOf(node: JsonRpcTransport, entry: RecoveryRecordEntry | null): Promise<bigint | null> {
  const tx = entry?.metadata.guardians?.installTxHash ?? null;
  if (!tx) return null;
  try {
    const receipt = (await node('eth_getTransactionReceipt', [tx])) as { blockNumber?: string } | null;
    return receipt?.blockNumber ? BigInt(receipt.blockNumber) : null;
  } catch {
    return null;
  }
}

export interface TakeoverCheckResult {
  /** Every watched proposal of the account with its live status (found by the scan, or shared). */
  views: ProposalView[];
  /** Approvals the scan found in this check. */
  newlyFound: FoundGuardianApproval[];
  scannedFrom: bigint | null;
  scannedTo: bigint | null;
  startBlock: bigint;
  startsAtInstall: boolean;
  /** Blocks between the last scanned block and the head that are not scanned yet. */
  remainingBlocks: bigint;
  lastCheckedAt: number;
  /** Proposals that need the owner's attention (vetoable). */
  pending: ProposalView[];
  /** Problems adding found proposals to the watch list (shown verbatim). */
  notes: string[];
}

/**
 * "Check for takeover attempts". Reads up to `blocksPerCheck` blocks
 * forward from where the previous check stopped (starting at the heir set's
 * install block when the record names its transaction, else at the blocks
 * just before the first check — and then the coverage sentence says so),
 * adds every approval naming this account to the account's watch list, and
 * reads the live status of every watched proposal. Never claims coverage it
 * does not have: remainingBlocks is what is still unscanned.
 */
export async function checkTakeoverAttempts(args: {
  node: JsonRpcTransport;
  chain: string;
  chainId: bigint;
  account: string;
  threshold: number | null;
  store?: KeyValueStore;
  now?: number;
  blocksPerCheck?: number;
}): Promise<TakeoverCheckResult> {
  const store = args.store ?? AsyncStorage;
  const now = args.now ?? Date.now();
  const perCheck = BigInt(Math.max(1, Math.min(args.blocksPerCheck ?? INHERITANCE_SCAN_BLOCKS_PER_CHECK, MAX_GUARDIAN_APPROVAL_SCAN_BLOCKS)));
  const entry = await getRecoveryRecord(args.chain, args.account, store);
  const head = BigInt((await args.node('eth_blockNumber', [])) as string);
  let state = await getTakeoverScanState(args.chain, args.account, store);
  if (!state) {
    const install = await installBlockOf(args.node, entry);
    const start = install ?? (head >= perCheck ? head - perCheck + 1n : 0n);
    state = { startBlock: start.toString(10), scannedThrough: null, startsAtInstall: install !== null, lastCheckedAt: null, found: [] };
  }
  const from = state.scannedThrough !== null ? BigInt(state.scannedThrough) + 1n : BigInt(state.startBlock);
  let scannedFrom: bigint | null = null;
  let scannedTo: bigint | null = null;
  let newlyFound: FoundGuardianApproval[] = [];
  const notes: string[] = [];
  if (from <= head) {
    const to = from + perCheck - 1n < head ? from + perCheck - 1n : head;
    const scan = await scanGuardianApprovals(args.node, { account: args.account, chainId: args.chainId, fromBlock: from, toBlock: to });
    scannedFrom = from;
    scannedTo = to;
    newlyFound = scan.approvals;
    const known = new Set(state.found.map((f) => f.txHash));
    const added = scan.approvals
      .filter((a) => a.txHash && !known.has(a.txHash))
      .map((a) => ({ proposalHash: a.proposalHash, txHash: a.txHash, blockNumber: a.blockNumber.toString(10), from: a.from, approvers: a.approvers }));
    state = { ...state, scannedThrough: to.toString(10), found: [...state.found, ...added].slice(-MAX_FOUND) };
    for (const a of scan.approvals) {
      try {
        await addWatchedProposal(args.chain, args.account, a.proposalHash, store, now);
      } catch (e) {
        notes.push(`Found takeover ${a.proposalHash} could not be added to the watch list: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  state = { ...state, lastCheckedAt: now };
  await writeScanState(args.chain, args.account, state, store);
  const after = await getRecoveryRecord(args.chain, args.account, store);
  const nowSeconds = Math.floor(now / 1000);
  const views = await Promise.all((after?.watched ?? []).map((w) => readProposalView(args.node, args.account, w, args.threshold, nowSeconds)));
  const through = state.scannedThrough !== null ? BigInt(state.scannedThrough) : BigInt(state.startBlock) - 1n;
  return {
    views,
    newlyFound,
    scannedFrom,
    scannedTo,
    startBlock: BigInt(state.startBlock),
    startsAtInstall: state.startsAtInstall,
    remainingBlocks: head > through ? head - through : 0n,
    lastCheckedAt: now,
    pending: views.filter((v) => v.canVeto && (v.state?.status === 'approved' || (v.state?.approvedWeight ?? 0) > 0)),
    notes,
  };
}

/** The coverage sentence under the status card (never claims more than was read). */
export function takeoverCoverageText(result: Pick<TakeoverCheckResult, 'startBlock' | 'startsAtInstall' | 'remainingBlocks' | 'scannedFrom' | 'scannedTo'>): string {
  const start = result.startsAtInstall
    ? `from block ${result.startBlock} (when the heirs were installed)`
    : `from block ${result.startBlock} (the first check; earlier blocks were not scanned)`;
  const last = result.scannedTo !== null ? ` This check read blocks ${result.scannedFrom}–${result.scannedTo}.` : '';
  const left =
    result.remainingBlocks > 0n
      ? ` ${result.remainingBlocks} newer block${result.remainingBlocks === 1n ? ' is' : 's are'} not scanned yet: check again to continue.`
      : ' Every block up to the latest one has been scanned.';
  return `Scanning ${start}.${last}${left} Only approvals sent directly to the guardian contract are found.`;
}

/** Plain status for one found or shared takeover (recovery.ts wording, with "heir" for "guardians"). */
export function takeoverStatusText(view: ProposalView, nowSeconds: number): string {
  const s = view.state;
  if (!s) return view.text;
  switch (s.status) {
    case 'approved':
      return s.validAfter > nowSeconds
        ? `TAKEOVER APPROVED by your heir: it can execute in ${formatDuration(s.validAfter - nowSeconds)}. Veto it now if you are still here.`
        : 'TAKEOVER APPROVED and the delay has passed: your heir can execute it at any moment. Veto it now if you are still here.';
    case 'ongoing':
      return s.approvedWeight > 0
        ? `Takeover started (approved weight ${s.approvedWeight}), not yet at the threshold. You can veto it.`
        : 'Not approved on-chain. Nothing to do unless an heir approves it.';
    case 'rejected':
      return 'Vetoed: this takeover can never execute.';
    case 'executed':
      return 'Executed: check who owns this account now.';
  }
}

