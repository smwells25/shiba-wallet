import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  BundlerClient,
  ECDSA_OWNER_REGISTERED_TOPIC,
  ENTRYPOINT_V07,
  KERNEL_RECOVERY_MODULES,
  KERNEL_V3_3,
  NodeClient,
  SmartAccountClient,
  assembleGuardianApprovals,
  createRecoveryMetadata,
  currentOwnerOf,
  encodeApproveWithSig,
  encodeFunctionCall,
  encodeGuardianSetData,
  encodeGuardianValidatorInstall,
  encodeVetoCall,
  findKernelAccountsByOwner,
  guardianApprovalTypedData,
  guardianInstallCalls,
  guardianRenewCall,
  guardianSignatureExposure,
  guardianUninstallCalls,
  kernelGuardianRecoverySpec,
  ownerRotationCalls,
  parseGuardianRecoveryRequest,
  parseRecoveryMetadata,
  predictKernelAddress,
  prepareGuardianInstall,
  prepareGuardianRecovery,
  readGuardianState,
  readKernelOwner,
  readRecoveryProposal,
  recordGuardians,
  recordOwnerChange,
  recoveryCall,
  serializeRecoveryMetadata,
  signEip1559,
  signGuardianApproval,
  toBytes,
  toHex,
  validateGuardianSet,
  verifyGuardianApproval,
  verifyKernelAccountForOwner,
  verifyRecoveryMetadataOnChain,
  type Call,
  type GuardianRecoveryRequest,
  type GuardianSignatureExposure,
  type JsonRpcTransport,
  type KernelAccountOwnershipCheck,
  type KernelGuardian,
  type KernelGuardianRecord,
  type KernelGuardianSet,
  type KernelGuardianState,
  type KernelOwnerRecord,
  type KernelOwnerState,
  type KernelRecoveryMetadata,
  type KernelRecoveryModules,
  type RecoveryProposalState,
  type UserOperation,
} from '@shiba-wallet/chains-evm';
import { toChecksumAddress, type DerivedAccount } from '@shiba-wallet/core';
// Explicit .ts extensions: this module is imported by scripts/check-recovery.mjs
// under Node's type stripping, which resolves relative specifiers literally.
import { assertFeatureAllowed, eip155Caip2 } from '../config/readiness.ts';
import {
  AA_DEPOSIT_TOPUP_VERIFICATION_GAS,
  applyPriorityFeeFloor,
  bundlerPriorityFeeFloor,
  clearAllRecoveredAccounts,
  eip155ChainIdOf,
  isEip7702Owner,
  moveRecoveredAccountLink,
  prepareAaCalls,
  recoveredAccountFor,
  resolveAaSender,
  setRecoveredAccount,
  summarizeAaReceipt,
  ROTATION_TARGET_HAS_OTHER_ACCOUNT,
  type AaChainConfig,
  type AaClientBundle,
  type AaReceiptSummary,
  type AaSendQuote,
  type AaSentEvent,
} from './aa.ts';
import { sanitizeDisplayName } from './names.ts';
import { EVM_CHAIN_ID, validateRecipient } from './send.ts';
import type { KeyValueStore } from './tokens.ts';

/**
 * Guardians and social recovery for the app (phase 8 item 4, app half), on
 * the engine's packages/chains-evm/src/kernel-recovery.ts. That module's
 * header lists every source (Kernel v3.3 cd697c7e WeightedECDSAValidator /
 * ECDSAValidator / Kernel, ZeroDev SDK cd7c05b5, kernel-7579-plugins
 * ca4a820 RecoveryAction) and AGENTS.md (phase 8, item 4 engine half)
 * records the live Sepolia proof (install → guardian recovery → rotation
 * back and removal) and six findings this module turns into product rules:
 *
 *  (1) Guardians whose weight reaches the threshold can set the owner to ANY
 *      key, and can also replace the guardian list through doRecovery.
 *  (2) Guardians can sign messages AS THE ACCOUNT immediately: Kernel's
 *      isValidSignature accepts any installed validator and ignores the
 *      selector allowlist, so Permit2 permits, orders and logins need no
 *      delay and no veto. The setup copy says so (GUARDIANS_TRUST_LINES).
 *  (3) A single guardian can satisfy a 2-of-2: the deployed validator checks
 *      the threshold BEFORE the signer order (WeightedECDSAValidator.sol
 *      isValidSignatureWithSender at cd697c7e, lines 290–302), so the last
 *      signature may repeat an earlier signer. describeGuardianExposure
 *      computes the true minimum from the engine's guardianSignatureExposure
 *      and the warning is MANDATORY on every setup and status surface.
 *  (4) ZeroDev's documentation example registers a single guardian with the
 *      ECDSA validator; on an account whose root is that validator this would
 *      OVERWRITE THE OWNER (same validation id). The app installs guardians
 *      only through the engine's guardianInstallCalls (the separate
 *      WeightedECDSAValidator) with the pinned modules, and
 *      assertGuardianModulesSafe refuses a module set whose guardian
 *      validator is the root validator.
 *  (5) Recovery cannot protect an EIP-7702-upgraded EOA (its own key can
 *      always re-delegate): such accounts are refused with the engine's text.
 *  (6) @zerodev/weighted-ecdsa-validator 5.4.4 maps the validator to Kernel
 *      "0.3.0 || 0.3.1" while the repository says 0.3.0–0.3.3; part of the
 *      audit note.
 *
 * WHAT THIS MODULE STORES (AsyncStorage; all public, no key material):
 *  - RECOVERY RECORDS (RECOVERY_RECORDS_KEY): per chain + account, the
 *    engine's KernelRecoveryMetadata (canonical JSON from
 *    serializeRecoveryMetadata, re-parsed with parseRecoveryMetadata — which
 *    re-checks the CREATE2 lineage — on every read), when it was last
 *    exported off-device, and the proposals the owner asked to watch. After
 *    an owner change the account address cannot be derived from any seed
 *    (the CREATE2 salt commits to the ORIGINAL owner), so this record is what
 *    lets a restored wallet find and verify the account (ADR D1 caveat).
 *  - RECOVERIES IN PROGRESS (RECOVERY_PROGRESS_KEY): on a new wallet, the
 *    request guardians sign, the approvals collected so far and the
 *    approveWithSig transaction, so a recovery that waits out a delay
 *    survives app restarts and account switches.
 *  - Attached recovered accounts live in the AA configuration
 *    (aa.ts setRecoveredAccount), written only here, only after the engine's
 *    verifyKernelAccountForOwner passed.
 *
 * WHO SIGNS WHAT. The owner key (WalletContext.signWith, after the
 * biometric gate) signs only root operations: install, renew and remove the
 * guardians, and veto. A guardian's key signs only the EIP-712 Approve
 * digest of a request this wallet re-derived from its fields
 * (signRecoveryApproval) and, when it submits, the recovery UserOperation
 * through the engine's kernelGuardianRecoverySpec. Nothing here is reachable
 * from WalletConnect (walletconnect.ts refuses guardian-module requests).
 *
 * THE FINAL RECOVERY OPERATION NEEDS A GUARDIAN. WeightedECDSAValidator
 * validateUserOp (cd697c7e, lines 203–252) accepts the doRecovery operation
 * only when its last 65-byte signature is a guardian's EIP-191 signature
 * over the userOpHash (no paymaster), on both paths: with delay 0 the
 * approvals ride in front of it; with a delay the proposal must first be
 * approved on-chain (approveWithSig — anyone may send it, here the new
 * wallet's own address pays) and the operation is valid only after the
 * delay. The new wallet therefore cannot submit that operation itself: a
 * guardian submits it from their wallet ("Approve a recovery" → Submit),
 * with the account paying the gas from its own balance. The source also
 * lets an approved proposal execute with NO signature when a paymaster is
 * attached (lines 253–255); that path is not used (unverified live, engine
 * note).
 *
 * Free of React Native imports (explicit .ts extensions on relative imports)
 * so scripts/check-recovery.mjs runs this exact code under Node.
 */

export const RECOVERY_RECORDS_KEY = 'shiba-wallet.recovery-records.v1';
export const RECOVERY_PROGRESS_KEY = 'shiba-wallet.recovery-progress.v1';
const STORE_VERSION = 1;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH32 = /^0x[0-9a-fA-F]{64}$/;
const SIGNATURE65 = /^0x[0-9a-fA-F]{130}$/;
const BIP32_PATH = /^m(\/[0-9]+'?)+$/;

/** Maximum watched proposals per account (wallet policy; each is read on screen open). */
export const MAX_WATCHED_PROPOSALS = 20;
/** Guardian labels are display names, sanitized like contact names. */
export const MAX_GUARDIAN_LABEL_LENGTH = 40;

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function checksum(address: string): string {
  return toChecksumAddress(toBytes(address.toLowerCase()));
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// Plain-language copy (one source for every screen)
// ---------------------------------------------------------------------------

/** Never call a guardian setup "safe": it is a trade-off. */
export const GUARDIANS_TRADE_OFF =
  'Guardians are a trade-off, not a safety guarantee. They let people you choose replace the key ' +
  'that controls this account if you lose your recovery phrase — which also means that, together, ' +
  'they could take the account without you.';

/**
 * Findings (1) and (2) in plain words; shown on the setup form, the confirm
 * screen and the status screen.
 */
export const GUARDIANS_TRUST_LINES: readonly string[] = [
  'Enough guardians together can make ANY key the owner of this account. They can also replace the ' +
    'guardian list itself as part of a recovery.',
  'Guardians can sign messages AS THIS ACCOUNT from the moment they are installed — token permits ' +
    '(for example Permit2), off-chain orders and sign-in requests — with no delay and no veto, because ' +
    'the account accepts message signatures from every installed module. The delay below protects ' +
    'only the change of owner.',
  'Choose guardians who would never collude, keep their keys apart from yours, and never add the key ' +
    'that controls this account (the wallet refuses it).',
];

export const GUARDIANS_AUDIT_NOTE =
  'The guardian modules (ZeroDev WeightedECDSAValidator 0.0.3 and RecoveryAction for Kernel v3) have ' +
  'no published audit of the deployed versions: the published Kalos reports cover the Kernel v2 ' +
  'plugins, and the v3.1 incremental audit covers a different contract. ZeroDev’s own npm package ' +
  'lists the validator for Kernel 0.3.0–0.3.1, while its repository says 0.3.0–0.3.3. Engine notes: ' +
  'packages/chains-evm kernel-recovery.ts.';

/** The mainnet condition (AGENTS.md: mainnet funds on Kernel wait on C1–C3). */
export const GUARDIANS_MAINNET_CONDITION =
  'Mainnet: real funds. The project has not cleared Kernel for mainnet funds yet (conditions C1–C3: ' +
  'an audit of the shipped version, bug-bounty coverage, a support horizon), and these guardian ' +
  'modules are unaudited. Use guardians on mainnet only if you accept that.';

export const GUARDIANS_MAINNET_ACK =
  'I understand the guardian modules are unaudited and that mainnet use is at my own risk.';

/** The delay exists so the owner can veto; 0 removes that chance. */
export const NO_VETO_ACK_TEXT =
  'No delay means enough guardians can replace your key in a single operation, and you cannot veto ' +
  'it. I understand there will be no veto.';

export const NO_VETO_ACK_REQUIRED =
  'A delay of 0 removes your veto. Turn on the “no veto” acknowledgement to use it, or pick a delay.';

export const GUARDIAN_SIMPLE_REFUSAL =
  'Guardians need a Kernel v3.3 account: this network’s smart-account type is SimpleAccount, which ' +
  'has no module system. Choose Kernel v3.3 in Settings → Account Abstraction.';

/**
 * The engine's own refusal text for an EIP-7702-delegated EOA
 * (kernel-recovery.ts prepareGuardianInstall); scripts/check-recovery.mjs
 * pins this constant to the engine's thrown message.
 */
export const GUARDIAN_7702_REFUSAL =
  'This address is an EIP-7702-delegated EOA: its own key can always re-delegate, so guardians cannot protect it';

export const GUARDIAN_UNDEPLOYED_REFUSAL =
  'Your Kernel smart account is not deployed yet. Guardians are installed into the account’s code, ' +
  'so send one smart-account transaction first (it deploys the account), then add guardians.';

export const GUARDIAN_NOT_OWNER_REFUSAL =
  'This wallet’s account is not the current owner of that Kernel account, so it cannot change its ' +
  'guardians.';

/** Finding (4): never let the guardian module be the owner's validator. */
export const GUARDIAN_ROOT_VALIDATOR_HAZARD =
  'Refused: the guardian module would be the account’s owner (root) validator. Registering a ' +
  'guardian with the owner’s ECDSA validator — the pattern in ZeroDev’s documentation example — ' +
  'would overwrite the owner with the guardian, because both use the same validation id. Guardians ' +
  'are installed only in the separate WeightedECDSAValidator.';

/**
 * How the owner learns about a proposal. The deployed validator emits no
 * event for approve / approveWithSig (only GuardianAdded / GuardianRemoved;
 * WeightedECDSAValidator.sol at cd697c7e lines 58–59), so the wallet cannot
 * discover proposals by itself.
 */
export const PROPOSAL_DISCOVERY_NOTE =
  'The guardian contract does not announce approvals on-chain, so this wallet cannot find recovery ' +
  'proposals by itself. Ask your guardians to tell you whenever someone asks them to approve a ' +
  'recovery, and add the request (or its proposal id) here: the wallet then shows its status, the ' +
  'time left before it can execute, and a Veto button.';

export const RECOVERY_RECORD_NOTE =
  'This record contains no secrets. It lists the account address, how it was created, every owner it ' +
  'has had and its guardians. Once an owner has changed, the address cannot be computed from any ' +
  'recovery phrase, so keep this record somewhere other than this phone (a file in your cloud ' +
  'storage, a printout of the QR code, or with your guardians).';

export const RECOVERED_NOT_DERIVABLE_NOTE =
  'Recovered account: the wallet cannot compute its address from your recovery phrase, so keep its ' +
  'recovery record backed up — a wallet restored from your phrase needs the record (or the address) ' +
  'to find it again.';

/** Shown to a guardian before they sign anything. */
export const APPROVER_WARNING =
  'Approving hands control of this account to the new owner shown below. Only approve if the account ' +
  'holder asked you in person or on a channel you trust, and you have checked the new owner address ' +
  'with them character by character. Never approve a request you did not expect.';

export const NEW_WALLET_PAYS_NOTE =
  'Anyone may send the guardians’ approvals to the guardian contract; the wallet sends them from this ' +
  'account’s own address, so this account pays the network fee in ETH (it needs a little ETH first). ' +
  'No key of the recovered account is involved.';

export const GUARDIAN_SUBMITS_NOTE =
  'The final recovery operation must be signed by one of the guardians (the guardian contract accepts ' +
  'it only with a guardian’s signature), so a guardian submits it from their wallet: “Approve a ' +
  'recovery” → scan the request → Submit. The account pays that operation’s gas from its own balance.';

// ---------------------------------------------------------------------------
// Recovery record store
// ---------------------------------------------------------------------------

export interface WatchedProposal {
  /** callDataAndNonceHash, lowercase 0x + 64 hex. */
  hash: string;
  /** Proposed new owner when known (from a pasted request). */
  newOwner: string | null;
  addedAt: number;
}

export interface RecoveryRecordEntry {
  metadata: KernelRecoveryMetadata;
  /** Date.now() of the last off-device export of THIS version of the record, else null. */
  exportedAt: number | null;
  watched: WatchedProposal[];
  updatedAt: number;
}

export interface RecoveryRecordLoad {
  entries: RecoveryRecordEntry[];
  /** True when some stored entries could not be read (they are not shown). */
  corrupt: boolean;
  /** True when the whole store is unreadable; writes are refused until reset. */
  unreadable: boolean;
}

/** Store key: one record per chain + account. */
export function recordKey(chain: string, account: string): string {
  return `${chain}|${account.toLowerCase()}`;
}

type RawRead = { state: 'empty' } | { state: 'ok'; entries: Record<string, unknown> } | { state: 'unreadable' };

async function readRawMap(store: KeyValueStore, key: string): Promise<RawRead> {
  let text: string | null;
  try {
    text = await store.getItem(key);
  } catch {
    return { state: 'unreadable' };
  }
  if (text === null) return { state: 'empty' };
  try {
    const parsed = JSON.parse(text) as { version?: unknown; entries?: unknown } | null;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      parsed.version !== STORE_VERSION ||
      typeof parsed.entries !== 'object' ||
      parsed.entries === null ||
      Array.isArray(parsed.entries)
    ) {
      return { state: 'unreadable' };
    }
    return { state: 'ok', entries: parsed.entries as Record<string, unknown> };
  } catch {
    return { state: 'unreadable' };
  }
}

function reviveWatched(value: unknown): WatchedProposal[] {
  if (!Array.isArray(value)) return [];
  const out: WatchedProposal[] = [];
  for (const w of value as unknown[]) {
    if (typeof w !== 'object' || w === null) continue;
    const v = w as Record<string, unknown>;
    if (typeof v.hash !== 'string' || !HASH32.test(v.hash)) continue;
    if (v.newOwner !== null && (typeof v.newOwner !== 'string' || !ADDRESS.test(v.newOwner))) continue;
    if (typeof v.addedAt !== 'number' || !Number.isFinite(v.addedAt)) continue;
    if (out.some((x) => x.hash === v.hash!.toString().toLowerCase())) continue;
    out.push({ hash: v.hash.toLowerCase(), newOwner: (v.newOwner as string | null) ?? null, addedAt: v.addedAt });
  }
  return out.slice(0, MAX_WATCHED_PROPOSALS);
}

function reviveEntry(value: unknown): RecoveryRecordEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  try {
    if (typeof v.metadata !== 'string') return null;
    // Strict engine parse: re-checks the CREATE2 lineage and every invariant.
    const metadata = parseRecoveryMetadata(v.metadata);
    const exportedAt = typeof v.exportedAt === 'number' && Number.isFinite(v.exportedAt) ? v.exportedAt : null;
    const updatedAt = typeof v.updatedAt === 'number' && Number.isFinite(v.updatedAt) ? v.updatedAt : 0;
    return { metadata, exportedAt, watched: reviveWatched(v.watched), updatedAt };
  } catch {
    return null;
  }
}

/** Every stored record. Never throws. */
export async function loadRecoveryRecords(store: KeyValueStore = AsyncStorage): Promise<RecoveryRecordLoad> {
  const read = await readRawMap(store, RECOVERY_RECORDS_KEY);
  if (read.state === 'empty') return { entries: [], corrupt: false, unreadable: false };
  if (read.state === 'unreadable') return { entries: [], corrupt: true, unreadable: true };
  const entries: RecoveryRecordEntry[] = [];
  let dropped = 0;
  for (const [key, value] of Object.entries(read.entries)) {
    const entry = reviveEntry(value);
    if (!entry || key !== recordKey(entry.metadata.chainId, entry.metadata.account)) {
      dropped += 1;
      continue;
    }
    entries.push(entry);
  }
  entries.sort((a, b) => a.updatedAt - b.updatedAt);
  return { entries, corrupt: dropped > 0, unreadable: false };
}

/** The record of one account on one chain, or null. */
export async function getRecoveryRecord(
  chain: string,
  account: string,
  store: KeyValueStore = AsyncStorage,
): Promise<RecoveryRecordEntry | null> {
  const { entries } = await loadRecoveryRecords(store);
  return entries.find((e) => e.metadata.chainId === chain && same(e.metadata.account, account)) ?? null;
}

const UNREADABLE_RECORDS =
  'The saved recovery records could not be read, so nothing was changed. Export what you can from a ' +
  'backup, then use “Reset recovery records” in Settings → Guardians (on-chain state is not affected).';

async function writeRecordEntry(entry: RecoveryRecordEntry | null, key: string, store: KeyValueStore): Promise<void> {
  const read = await readRawMap(store, RECOVERY_RECORDS_KEY);
  if (read.state === 'unreadable') throw new Error(UNREADABLE_RECORDS);
  const entries = read.state === 'ok' ? { ...read.entries } : {};
  if (entry) {
    entries[key] = {
      metadata: serializeRecoveryMetadata(entry.metadata),
      exportedAt: entry.exportedAt,
      watched: entry.watched,
      updatedAt: entry.updatedAt,
    };
  } else {
    delete entries[key];
  }
  await store.setItem(RECOVERY_RECORDS_KEY, JSON.stringify({ version: STORE_VERSION, entries }));
}

/**
 * Saves (creates or replaces) an account's record. The metadata is
 * round-tripped through the engine's strict parser first. When the record's
 * content changes, the previous export no longer covers it, so exportedAt
 * is cleared and the UI asks for a fresh backup.
 */
export async function saveRecoveryMetadata(
  meta: KernelRecoveryMetadata,
  store: KeyValueStore = AsyncStorage,
  options: { now?: number } = {},
): Promise<RecoveryRecordEntry> {
  const metadata = parseRecoveryMetadata(serializeRecoveryMetadata(meta));
  const existing = await getRecoveryRecord(metadata.chainId, metadata.account, store);
  const unchanged = existing !== null && serializeRecoveryMetadata(existing.metadata) === serializeRecoveryMetadata(metadata);
  const entry: RecoveryRecordEntry = {
    metadata,
    exportedAt: unchanged ? existing!.exportedAt : null,
    watched: existing?.watched ?? [],
    updatedAt: options.now ?? Date.now(),
  };
  await writeRecordEntry(entry, recordKey(metadata.chainId, metadata.account), store);
  return entry;
}

/** Marks the record's current version as exported off-device. */
export async function markRecordExported(
  chain: string,
  account: string,
  store: KeyValueStore = AsyncStorage,
  now: number = Date.now(),
): Promise<RecoveryRecordEntry> {
  const existing = await getRecoveryRecord(chain, account, store);
  if (!existing) throw new Error('There is no recovery record for this account.');
  const entry = { ...existing, exportedAt: now };
  await writeRecordEntry(entry, recordKey(chain, account), store);
  return entry;
}

/** Clears an unreadable record store (after an explicit confirmation on screen). */
export async function resetRecoveryRecords(store: KeyValueStore = AsyncStorage): Promise<void> {
  await store.setItem(RECOVERY_RECORDS_KEY, JSON.stringify({ version: STORE_VERSION, entries: {} }));
}

/**
 * Wipe support: deletes every recovery record, every recovery in progress
 * and every recovered-account attachment from THIS DEVICE. Nothing on-chain
 * changes (no transaction is sent): guardians stay installed and recovered
 * accounts keep their owners. The Settings wipe offers the record export
 * first (exportAllRecordsText).
 */
export async function wipeRecoveryData(
  store: KeyValueStore = AsyncStorage,
  aaStore: KeyValueStore = store,
): Promise<{ recordsRemoved: number }> {
  const { entries } = await loadRecoveryRecords(store);
  await resetRecoveryRecords(store);
  await store.setItem(RECOVERY_PROGRESS_KEY, JSON.stringify({ version: STORE_VERSION, entries: {} }));
  await clearAllRecoveredAccounts(aaStore);
  return { recordsRemoved: entries.length };
}

// ---------------------------------------------------------------------------
// Export / import (off-device backup)
// ---------------------------------------------------------------------------

/**
 * Largest QR payload the screens render, in UTF-8 bytes. A version-40 QR
 * code at error-correction level L holds 2,953 bytes in byte mode (the
 * capacity table of the `qrcode` 1.5.4 encoder react-native-qrcode-svg uses;
 * scripts/check-recovery.mjs round-trips a payload of this size through the
 * independent jsqr decoder). A small margin is kept.
 */
export const QR_MAX_BYTES = 2900;

/** UTF-8 length of a string without depending on TextEncoder. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

export interface RecordExport {
  /** Canonical JSON (serializeRecoveryMetadata) — what parseRecordText reads back. */
  json: string;
  /** The QR payload (the JSON itself), or null when it is too large for one code. */
  qrValue: string | null;
  bytes: number;
  /** Text for the share sheet: a short header, then the JSON. */
  shareText: string;
}

export function recordExport(meta: KernelRecoveryMetadata): RecordExport {
  const json = serializeRecoveryMetadata(parseRecoveryMetadata(serializeRecoveryMetadata(meta)));
  const bytes = utf8Length(json);
  return {
    json,
    qrValue: bytes <= QR_MAX_BYTES ? json : null,
    bytes,
    shareText:
      'Shiba Wallet recovery record (contains no secrets)\n' +
      `Account: ${meta.account}\nNetwork: ${meta.chainId}\n` +
      'Keep this somewhere other than your phone. A wallet restored from another recovery phrase ' +
      'needs it to find and verify this account.\n\n' +
      json,
  };
}

/** All records as one share text (Settings wipe offer). Null when there are none. */
export function exportAllRecordsText(entries: readonly RecoveryRecordEntry[]): string | null {
  if (entries.length === 0) return null;
  return entries.map((e) => recordExport(e.metadata).shareText).join('\n\n-----\n\n');
}

/**
 * Reads a record from pasted or scanned text: the JSON object itself, or a
 * share text that contains it (the first "{" to the last "}"). The engine's
 * strict parser re-checks the CREATE2 lineage and every field; its error is
 * returned verbatim.
 */
export function parseRecordText(text: string): KernelRecoveryMetadata {
  const json = extractFirstJsonObject(text);
  if (json === null) throw new Error('No recovery record found in the text.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('The recovery record is not valid JSON.');
  }
  return parseRecoveryMetadata(parsed);
}


// ---------------------------------------------------------------------------
// Record files (.json) — the screens write and read them with expo-file-system,
// expo-sharing and expo-document-picker (components/RecordFileActions.tsx);
// the naming and parsing rules live here so scripts/check-recovery.mjs runs
// them under Node.
// ---------------------------------------------------------------------------

/** MIME type of an exported record file and the only type the import picker offers. */
export const RECORD_FILE_MIME_TYPE = 'application/json';
/** iOS Uniform Type Identifier for JSON (Apple's public.json). */
export const RECORD_FILE_UTI = 'public.json';
/**
 * Largest record file the import accepts, in bytes. A record with the
 * maximum guardian list and a long owner history is a few kilobytes; the
 * cap only stops the app from reading an unrelated large file into memory.
 */
export const RECORD_FILE_MAX_BYTES = 64 * 1024;
/** Sub-directory of the app's cache directory that holds export files while they are shared. */
export const RECORD_EXPORT_DIRECTORY = 'recovery-record-export';

/** Readable network names for file names; other chains use their CAIP-2 id with ":" replaced. */
const RECORD_FILE_CHAIN_LABELS: Readonly<Record<string, string>> = {
  'eip155:1': 'ethereum',
  'eip155:11155111': 'sepolia',
};

/**
 * The export file name rule: product, network, the account's short form
 * (first 4 and last 4 hex characters of the checksummed address) and the UTC
 * date, e.g. "shiba-recovery-record_sepolia_0xD31c-D8FA_2026-10-02.json".
 * Only [A-Za-z0-9._-] are used, so every file system and share target
 * accepts it.
 */
export const RECORD_FILE_NAME_PATTERN =
  /^shiba-recovery-record_[a-z0-9-]+_0x[0-9a-fA-F]{4}-[0-9a-fA-F]{4}_[0-9]{4}-[0-9]{2}-[0-9]{2}\.json$/;

export function recordExportFileName(meta: KernelRecoveryMetadata, date: Date = new Date()): string {
  const chain = RECORD_FILE_CHAIN_LABELS[meta.chainId] ?? meta.chainId.replace(':', '-');
  const account = checksum(meta.account);
  const name = `shiba-recovery-record_${chain}_${account.slice(0, 6)}-${account.slice(-4)}_${date.toISOString().slice(0, 10)}.json`;
  if (!RECORD_FILE_NAME_PATTERN.test(name)) throw new Error(`Unexpected export file name ${name}`);
  return name;
}

/**
 * The exact text written into an export file: the canonical JSON of the
 * engine's serializeRecoveryMetadata (via recordExport, which round-trips it
 * through the strict parser first). No header and no trailing newline, so
 * the file is the record and nothing else.
 */
export function recordFileContents(meta: KernelRecoveryMetadata): string {
  return recordExport(meta).json;
}

/**
 * Checks a picked file before its text enters the EXISTING import path
 * (parseRecordText → the engine's strict parseRecoveryMetadata, which
 * re-checks the CREATE2 lineage and every field). A file must look like a
 * JSON file (".json" name or the application/json type), be at most
 * RECORD_FILE_MAX_BYTES, and contain exactly one JSON object (an optional
 * UTF-8 byte-order mark and surrounding whitespace are allowed) — a share
 * text with a header, or two records in one file, is refused here rather
 * than guessed at. Returns the text to import and the parsed record.
 */
export function parseRecordFile(
  text: string,
  info: { name?: string | null; size?: number | null; mimeType?: string | null } = {},
): { text: string; metadata: KernelRecoveryMetadata } {
  const named = typeof info.name === 'string' && info.name.toLowerCase().endsWith('.json');
  const typed = typeof info.mimeType === 'string' && info.mimeType.toLowerCase().split(';')[0]!.trim() === RECORD_FILE_MIME_TYPE;
  if (!named && !typed) throw new Error('Choose a recovery record file: a .json file exported by Shiba Wallet.');
  if ((typeof info.size === 'number' && info.size > RECORD_FILE_MAX_BYTES) || utf8Length(text) > RECORD_FILE_MAX_BYTES) {
    throw new Error(`This file is larger than ${RECORD_FILE_MAX_BYTES / 1024} KiB, so it is not a recovery record.`);
  }
  const body = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).trim();
  if (body === '' || extractFirstJsonObject(body) !== body) {
    throw new Error('This file is not a recovery record: it must contain exactly one JSON record and nothing else.');
  }
  return { text: body, metadata: parseRecordText(body) };
}


/**
 * The first complete JSON object in a pasted or scanned text (a share text
 * carries a header and, for requests, a second JSON block for other
 * wallets). Braces inside JSON strings are skipped. Null when none.
 */
export function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Starting a record (first deployment / first use of a Kernel account)
// ---------------------------------------------------------------------------

/**
 * Creates the record for a FACTORY-deployed Kernel v3.3 account owned by
 * one of this wallet's EOAs, unless one exists. The engine's
 * createRecoveryMetadata refuses an address that is not the CREATE2 result
 * of (owner, index, factory, implementation, validator), so a wrong address
 * can never be recorded. Returns created = false when a record existed.
 */
export async function ensureFactoryKernelRecord(args: {
  chain: string;
  account: string;
  accountIndex: number;
  owner: string;
  ownerPath: string | null;
  factory: string;
  implementation: string;
  ecdsaValidator: string;
  store?: KeyValueStore;
  now?: number;
}): Promise<{ created: boolean; entry: RecoveryRecordEntry }> {
  const store = args.store ?? AsyncStorage;
  const existing = await getRecoveryRecord(args.chain, args.account, store);
  if (existing) return { created: false, entry: existing };
  const recordedAt = Math.floor((args.now ?? Date.now()) / 1000);
  const meta = createRecoveryMetadata({
    chainId: eip155ChainIdOf(args.chain),
    account: args.account,
    index: BigInt(args.accountIndex),
    originalOwner: args.owner,
    originalOwnerPath: args.ownerPath && BIP32_PATH.test(args.ownerPath) ? args.ownerPath : null,
    factory: args.factory,
    implementation: args.implementation,
    ecdsaValidator: args.ecdsaValidator,
    recordedAt,
  });
  return { created: true, entry: await saveRecoveryMetadata(meta, store, args.now !== undefined ? { now: args.now } : {}) };
}

/**
 * The aa.ts send listener that starts a Kernel account's record on its first
 * accepted operation (the deployment op, or the first use of an account
 * deployed elsewhere). Only factory Kernel v3.3 bundles qualify: a 7702
 * upgrade has no CREATE2 lineage (and guardians cannot protect it), a
 * recovered account already has its record, SimpleAccount has no guardians.
 * Failures are swallowed (aa.ts notifies best-effort); the Guardians screen
 * creates the record explicitly and surfaces any error.
 */
export function recoveryRecordListener(store: KeyValueStore = AsyncStorage): (event: AaSentEvent) => Promise<void> {
  return async (event) => {
    const { bundle } = event;
    if (bundle.accountType !== 'kernel-v3.3' || bundle.recovered || bundle.eip7702 || !bundle.kernel) return;
    await ensureFactoryKernelRecord({
      chain: `eip155:${bundle.chainId.toString()}`,
      account: event.quote.sender,
      accountIndex: bundle.accountIndex,
      owner: event.owner.address,
      ownerPath: event.owner.path,
      factory: bundle.factory,
      implementation: bundle.kernel.implementation,
      ecdsaValidator: bundle.kernel.ecdsaValidator,
      store,
    });
  };
}

/**
 * Rebuilds a record for a recovered account from its original owner when no
 * backup exists: the CREATE2 lineage is checked by the engine for the given
 * index, or for indices 0–49 when the index is unknown (wallets that use
 * the account number as the salt, as this one does).
 */
export function rebuildRecoveryRecord(args: {
  chainId: bigint;
  account: string;
  originalOwner: string;
  index?: number;
  recordedAt: number;
}): KernelRecoveryMetadata {
  const tryIndex = (index: number): KernelRecoveryMetadata | null => {
    const predicted = predictKernelAddress(args.originalOwner, { index: BigInt(index) });
    if (!same(predicted, args.account)) return null;
    return createRecoveryMetadata({
      chainId: args.chainId,
      account: args.account,
      index: BigInt(index),
      originalOwner: args.originalOwner,
      recordedAt: args.recordedAt,
    });
  };
  if (args.index !== undefined) {
    const meta = tryIndex(args.index);
    if (!meta) {
      throw new Error(`${args.account} is not the Kernel v3.3 account of ${args.originalOwner} at index ${args.index}.`);
    }
    return meta;
  }
  for (let i = 0; i < 50; i++) {
    const meta = tryIndex(i);
    if (meta) return meta;
  }
  throw new Error(
    `${args.account} is not the Kernel v3.3 account of ${args.originalOwner} at any index from 0 to 49.`,
  );
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

export type GuardianAccountResolution =
  | {
      ok: true;
      /** The Kernel account the guardians protect. */
      account: string;
      /** 'factory' = derivable from the seed; 'recovered' = attached after a recovery. */
      kind: 'factory' | 'recovered';
      owner: string;
      state: KernelGuardianState;
    }
  | { ok: false; reason: string };

/**
 * Whether guardians can be set up (or are set up) for the active account's
 * smart account: a DEPLOYED, proxy-deployed Kernel v3.3 account whose root
 * validator is the ECDSA validator and whose owner is `ownerAddress`.
 * Refuses, in plain words: SimpleAccount, an EIP-7702 upgrade (the engine's
 * text), an undeployed account, another owner. Read-only.
 */
export async function resolveGuardianAccount(
  bundle: AaClientBundle,
  ownerAddress: string,
): Promise<GuardianAccountResolution> {
  const reported = await new NodeClient(bundle.node).chainId();
  if (reported !== bundle.chainId) {
    return {
      ok: false,
      reason: `The RPC endpoint is chain id ${reported}, expected ${bundle.chainId}. Check the endpoint in Settings.`,
    };
  }
  if (bundle.accountType === 'simple') return { ok: false, reason: GUARDIAN_SIMPLE_REFUSAL };
  if (bundle.accountType === 'kernel-7702') return { ok: false, reason: GUARDIAN_7702_REFUSAL };
  let account: string;
  try {
    account = await resolveAaSender(bundle, ownerAddress);
  } catch (e) {
    return { ok: false, reason: message(e) };
  }
  const code = (await bundle.node('eth_getCode', [account, 'latest'])) as string;
  if (!code || code === '0x' || code === '0x0') return { ok: false, reason: GUARDIAN_UNDEPLOYED_REFUSAL };
  if (code.toLowerCase().startsWith('0xef0100')) return { ok: false, reason: GUARDIAN_7702_REFUSAL };
  let owner: KernelOwnerState;
  try {
    owner = await readKernelOwner(bundle.node, account, bundle.kernel?.ecdsaValidator);
  } catch (e) {
    return { ok: false, reason: message(e) };
  }
  if (!owner.ecdsaRoot) {
    return { ok: false, reason: `The account’s root validator is ${owner.rootValidator}, not the ECDSA validator.` };
  }
  if (!same(owner.owner, ownerAddress)) return { ok: false, reason: GUARDIAN_NOT_OWNER_REFUSAL };
  const state = await readGuardianState(bundle.node, account);
  return { ok: true, account, kind: bundle.recovered ? 'recovered' : 'factory', owner: owner.owner, state };
}

// ---------------------------------------------------------------------------
// The guardian set form
// ---------------------------------------------------------------------------

export interface GuardianDraft {
  /** As typed, scanned or picked from contacts. */
  address: string;
  /** Optional display label (stored in the recovery record). */
  label: string;
  /** Integer weight as typed. */
  weight: string;
}

/** Delay choices. 48 hours is the default; 0 is offered only with the no-veto acknowledgement. */
export const DELAY_PRESETS: readonly { label: string; seconds: number }[] = [
  { label: '24 hours', seconds: 86_400 },
  { label: '48 hours (default)', seconds: 172_800 },
  { label: '7 days', seconds: 604_800 },
  { label: 'No delay (no veto)', seconds: 0 },
];

export const DEFAULT_GUARDIAN_DELAY_SECONDS = 172_800;

/**
 * Test networks only: a 10-minute delay so the approve → wait → execute and
 * veto paths can be exercised end to end on Sepolia (never offered on
 * mainnet).
 */
export const TESTNET_DELAY_PRESET = { label: '10 minutes (test networks only)', seconds: 600 } as const;

/** The delay choices for the active network. */
export function delayPresetsFor(testnet: boolean): readonly { label: string; seconds: number }[] {
  return testnet ? [TESTNET_DELAY_PRESET, ...DELAY_PRESETS] : DELAY_PRESETS;
}

export const EMPTY_GUARDIAN_DRAFT: GuardianDraft = { address: '', label: '', weight: '1' };

/**
 * Builds the set from the form. Input errors (address syntax, numbers,
 * labels, the no-veto acknowledgement) get plain messages here; the rules on
 * the set itself are the engine's (validateGuardianSetForAccount, shown
 * verbatim).
 */
export function buildGuardianSet(args: {
  drafts: readonly GuardianDraft[];
  threshold: string;
  delaySeconds: number;
  noVetoAcknowledged: boolean;
}): { set: KernelGuardianSet; labels: Record<string, string> } {
  if (args.delaySeconds === 0 && !args.noVetoAcknowledged) throw new Error(NO_VETO_ACK_REQUIRED);
  if (!Number.isSafeInteger(args.delaySeconds) || args.delaySeconds < 0) {
    throw new Error('Choose a delay.');
  }
  const labels: Record<string, string> = {};
  const guardians: KernelGuardian[] = args.drafts.map((draft, i) => {
    const where = `Guardian ${i + 1}`;
    const address = validateRecipient(EVM_CHAIN_ID, draft.address);
    if (!address.ok) throw new Error(`${where}: ${address.error}`);
    const weightText = draft.weight.trim();
    if (!/^[0-9]+$/.test(weightText)) throw new Error(`${where}: the weight is a whole number (1 or more).`);
    const weight = Number(weightText);
    if (draft.label.trim() !== '') {
      const label = sanitizeDisplayName(draft.label, MAX_GUARDIAN_LABEL_LENGTH, 'guardian');
      if (!label.ok) throw new Error(`${where}: ${label.error}`);
      labels[address.normalized.toLowerCase()] = label.name;
    }
    return { address: address.normalized, weight };
  });
  const thresholdText = args.threshold.trim();
  if (!/^[0-9]+$/.test(thresholdText)) throw new Error('The threshold is a whole number (1 or more).');
  return { set: { guardians, threshold: Number(thresholdText), delaySeconds: args.delaySeconds }, labels };
}

/**
 * The engine's validateGuardianSet against the account and its current
 * owner. Returns null when acceptable, else the engine's refusal verbatim.
 */
export function validateGuardianSetForAccount(
  set: KernelGuardianSet,
  context: { account: string; owner: string },
): string | null {
  try {
    validateGuardianSet(set, context);
    return null;
  } catch (e) {
    return message(e);
  }
}

/** The record form of a set (pinned modules; labels attached; sorted by the engine on parse). */
export function guardianRecordFrom(
  set: KernelGuardianSet,
  labels: Record<string, string>,
  installTxHash: string | null,
  modules: KernelRecoveryModules = KERNEL_RECOVERY_MODULES,
): KernelGuardianRecord {
  return {
    weightedEcdsaValidator: modules.weightedEcdsaValidator,
    recoveryAction: modules.recoveryAction,
    guardians: set.guardians.map((g) => ({
      address: checksum(g.address),
      weight: g.weight,
      ...(labels[g.address.toLowerCase()] !== undefined ? { label: labels[g.address.toLowerCase()]! } : {}),
    })),
    threshold: set.threshold,
    delaySeconds: set.delaySeconds,
    installTxHash,
  };
}

/** Durations up to 72 hours in hours and minutes ("48 h", "1 h 5 min"), longer ones in days ("7 d", "3 d 4 h"). */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 s';
  const s = Math.floor(seconds);
  if (s > 72 * 3_600) {
    const d = Math.floor(s / 86_400);
    const h = Math.floor((s % 86_400) / 3_600);
    return h > 0 ? `${d} d ${h} h` : `${d} d`;
  }
  const h = Math.floor(s / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  if (h > 0) return m > 0 ? `${h} h ${m} min` : `${h} h`;
  if (m > 0) return `${m} min`;
  return `${s} s`;
}

export interface GuardianExposureText {
  exposure: GuardianSignatureExposure;
  /** The mandatory warning (design note wording, with the computed number). */
  signing: string;
  /** Guardians who can sign messages alone (weight at least half the threshold). */
  soloSigners: KernelGuardian[];
  /** Extra sentence when signing needs fewer guardians than recovery. */
  weaker: string | null;
  /** What recovery itself needs, and the delay / veto. */
  recovery: string;
}

/**
 * The MANDATORY exposure warning, from the engine's guardianSignatureExposure
 * (finding 3). Wording per the engine's app design note: "N guardians
 * together — or one, if a guardian holds at least half the threshold weight
 * — can sign messages as this account immediately, with no delay and no
 * veto".
 */
export function describeGuardianExposure(
  set: KernelGuardianSet,
  labelFor?: (address: string) => string | null,
): GuardianExposureText {
  const exposure = guardianSignatureExposure(set);
  const n = exposure.signatureMinimumGuardians;
  const r = exposure.recoveryMinimumGuardians;
  const total = set.guardians.reduce((sum, g) => sum + g.weight, 0);
  const soloSigners = set.guardians.filter((g) => 2 * g.weight >= set.threshold);
  const name = (g: KernelGuardian) => {
    const label = labelFor?.(g.address) ?? null;
    return label ? `${label} (${g.address})` : g.address;
  };
  const signing =
    n === 1
      ? 'ONE guardian alone can sign messages as this account immediately, with no delay and no veto: ' +
        `any guardian holding at least half the threshold weight can — here ${soloSigners.map(name).join(', ')}.`
      : `${n} guardians together — or one, if a guardian holds at least half the threshold weight — can ` +
        'sign messages as this account immediately, with no delay and no veto.';
  const weaker = exposure.weakerThanThreshold
    ? `That is fewer than the ${r} guardian${r === 1 ? '' : 's'} your threshold needs for a recovery: the ` +
      'deployed guardian contract lets the last signature repeat an earlier signer, so the heaviest ' +
      'member of a group counts twice. No wallet setting can change this.'
    : null;
  const recovery =
    `Replacing your key needs ${r} guardian${r === 1 ? '' : 's'} (threshold ${set.threshold} of total ` +
    `weight ${total}). ` +
    (set.delaySeconds > 0
      ? `They approve on-chain first; the change can execute ${formatDuration(set.delaySeconds)} later, ` +
        'and until it executes you can veto it from this wallet.'
      : 'With no delay this happens in one operation and you cannot veto it.');
  return { exposure, signing, soloSigners, weaker, recovery };
}

// ---------------------------------------------------------------------------
// Root-signed operations: install, renew, remove, veto
// ---------------------------------------------------------------------------

export type GuardianOperationKind = 'install' | 'renew' | 'remove' | 'veto';

export interface GuardianOperationQuote {
  kind: GuardianOperationKind;
  account: string;
  owner: string;
  /** The exact calls the operation executes (engine-built). */
  calls: Call[];
  quote: AaSendQuote;
  /** install / renew: the new set and its labels. */
  set: KernelGuardianSet | null;
  labels: Record<string, string>;
  /** veto: the proposal id. */
  proposalHash: string | null;
}

export function sameCalls(a: readonly Call[], b: readonly Call[]): boolean {
  return (
    a.length === b.length &&
    a.every((c, i) => same(c.to, b[i]!.to) && c.value === b[i]!.value && toHex(c.data) === toHex(b[i]!.data))
  );
}

/**
 * Finding (4) guard: the guardian validator must never be the account's
 * root (owner) validator, and the guardian install must be exactly the
 * engine's WeightedECDSAValidator install for this set.
 */
export function assertGuardianModulesSafe(
  modules: KernelRecoveryModules,
  rootEcdsaValidator: string = KERNEL_V3_3.ecdsaValidator,
): void {
  if (same(modules.weightedEcdsaValidator, rootEcdsaValidator) || same(modules.recoveryAction, rootEcdsaValidator)) {
    throw new Error(GUARDIAN_ROOT_VALIDATOR_HAZARD);
  }
}

async function quoteRootOperation(
  bundle: AaClientBundle,
  ownerAddress: string,
  account: string,
  calls: Call[],
): Promise<AaSendQuote> {
  const quote = await prepareAaCalls(bundle, ownerAddress, calls, { displayTo: account });
  if (!same(quote.sender, account)) {
    throw new Error(`The configured smart account is ${quote.sender}, not ${account}. Nothing was signed.`);
  }
  if (quote.eip7702?.upgrade) throw new Error(GUARDIAN_7702_REFUSAL);
  if (!quote.deployed) throw new Error(GUARDIAN_UNDEPLOYED_REFUSAL);
  return quote;
}

/**
 * Quotes the guardian install as ONE root-signed operation. Order: the set
 * is validated locally (engine text verbatim, no network request), the
 * modules are checked against finding (4), then the engine's
 * prepareGuardianInstall reads the live account (deployed, not a 7702 EOA,
 * ECDSA root, no guardians yet) and returns the two installModule calls,
 * which must equal guardianInstallCalls for the same set; the bundler
 * estimate (prepareAaCalls) is the pre-flight gate.
 */
export async function prepareGuardianInstallQuote(
  bundle: AaClientBundle,
  ownerAddress: string,
  account: string,
  set: KernelGuardianSet,
  labels: Record<string, string>,
): Promise<GuardianOperationQuote> {
  // Mainnet readiness (config/readiness.ts): refused before any request
  // where guardians are not allowed.
  assertFeatureAllowed('guardians', eip155Caip2(bundle.chainId));
  validateGuardianSet(set, { account, owner: ownerAddress });
  assertGuardianModulesSafe(KERNEL_RECOVERY_MODULES, bundle.kernel?.ecdsaValidator);
  const reported = await new NodeClient(bundle.node).chainId();
  if (reported !== bundle.chainId) {
    throw new Error(`Endpoint is chain id ${reported}, expected ${bundle.chainId}. Check the RPC endpoint in Settings.`);
  }
  const prepared = await prepareGuardianInstall(bundle.node, { account, set });
  if (!same(prepared.owner, ownerAddress)) throw new Error(GUARDIAN_NOT_OWNER_REFUSAL);
  const expected = guardianInstallCalls(account, set, { owner: ownerAddress });
  if (!sameCalls(prepared.calls, expected)) {
    throw new Error('The guardian install does not match the expected module calls. Nothing was signed.');
  }
  // Belt and braces for finding (4): the first call installs the WEIGHTED
  // validator with this set's data, never the owner's ECDSA validator.
  const installData = encodeGuardianValidatorInstall(encodeGuardianSetData(set, { account, owner: ownerAddress }));
  if (toHex(prepared.calls[0]!.data) !== toHex(installData)) throw new Error(GUARDIAN_ROOT_VALIDATOR_HAZARD);
  const quote = await quoteRootOperation(bundle, ownerAddress, account, prepared.calls);
  return { kind: 'install', account, owner: ownerAddress, calls: prepared.calls, quote, set, labels, proposalHash: null };
}

/**
 * Quotes a replacement of the guardian set (renew). renew() does not check
 * the threshold against the new total weight on-chain, so the engine's
 * local validation is the only guard (it runs first, verbatim).
 */
export async function prepareGuardianRenewQuote(
  bundle: AaClientBundle,
  ownerAddress: string,
  account: string,
  set: KernelGuardianSet,
  labels: Record<string, string>,
): Promise<GuardianOperationQuote> {
  // Mainnet readiness (config/readiness.ts): refused before any request
  // where guardians are not allowed.
  assertFeatureAllowed('guardians', eip155Caip2(bundle.chainId));
  const call = guardianRenewCall(set, { account, owner: ownerAddress });
  const state = await readGuardianState(bundle.node, account);
  if (!state.validatorInitialized) {
    throw new Error('No guardians are configured for this account; set them up instead of changing them.');
  }
  const quote = await quoteRootOperation(bundle, ownerAddress, account, [call]);
  return { kind: 'renew', account, owner: ownerAddress, calls: [call], quote, set, labels, proposalHash: null };
}

/** Quotes the removal of the guardians (the engine's three uninstall calls). */
export async function prepareGuardianRemoveQuote(
  bundle: AaClientBundle,
  ownerAddress: string,
  account: string,
): Promise<GuardianOperationQuote> {
  const calls = guardianUninstallCalls(account);
  const quote = await quoteRootOperation(bundle, ownerAddress, account, calls);
  return { kind: 'remove', account, owner: ownerAddress, calls, quote, set: null, labels: {}, proposalHash: null };
}

/**
 * Quotes the owner's veto of one proposal: a root-signed call from the
 * account to the validator (the contract keys the proposal by msg.sender, so
 * only the account itself can veto). Refused unless the proposal is ongoing
 * or approved.
 */
export async function prepareVetoQuote(
  bundle: AaClientBundle,
  ownerAddress: string,
  account: string,
  proposalHash: string,
): Promise<GuardianOperationQuote> {
  if (!HASH32.test(proposalHash)) throw new Error('A proposal id is 0x followed by 64 hex characters.');
  const proposal = await readRecoveryProposal(bundle.node, account, proposalHash);
  if (proposal.status !== 'ongoing' && proposal.status !== 'approved') {
    throw new Error(`This proposal is ${proposal.status}; there is nothing to veto.`);
  }
  const calls = [encodeVetoCall(proposalHash)];
  const quote = await quoteRootOperation(bundle, ownerAddress, account, calls);
  return {
    kind: 'veto',
    account,
    owner: ownerAddress,
    calls,
    quote,
    set: null,
    labels: {},
    proposalHash: proposalHash.toLowerCase(),
  };
}

/**
 * Submits a quoted guardian operation (owner-signed through `submit`; in
 * the app: biometric gate → signWith(owner) → sendAa). The quoted calls must
 * be exactly the operation's. For install / renew / remove the account's
 * recovery record is updated BEFORE submission (so a crash after
 * submission never leaves on-chain guardians the record does not mention);
 * if the bundler refuses, the previous record is restored. The receipt and
 * the on-chain read-back (finalizeGuardianOperation) settle the rest.
 */
export async function submitGuardianOperation(args: {
  operation: GuardianOperationQuote;
  chain: string;
  store: KeyValueStore;
  submit: (quote: AaSendQuote) => Promise<{ userOpHash: string }>;
}): Promise<{ userOpHash: string; entry: RecoveryRecordEntry | null }> {
  const op = args.operation;
  // Mainnet readiness: setting up or changing guardians is refused where
  // guardians are not allowed; removing them and vetoing never are.
  if (op.kind === 'install' || op.kind === 'renew') assertFeatureAllowed('guardians', args.chain);
  if (!sameCalls(op.quote.calls, op.calls)) {
    throw new Error('The quoted operation is not the guardian operation it claims to be. Nothing was signed.');
  }
  let previous: RecoveryRecordEntry | null = null;
  let next: RecoveryRecordEntry | null = null;
  if (op.kind !== 'veto') {
    previous = await getRecoveryRecord(args.chain, op.account, args.store);
    if (!previous) {
      throw new Error(
        'This account has no recovery record on this device, so nothing was signed. A recovered account needs its ' +
          'record first: Recover an account with guardians → paste its address and its original owner (or its record).',
      );
    }
    const guardians = op.kind === 'remove' ? null : guardianRecordFrom(op.set!, op.labels, null);
    next = await saveRecoveryMetadata(recordGuardians(previous.metadata, guardians), args.store);
  }
  try {
    const { userOpHash } = await args.submit(op.quote);
    return { userOpHash, entry: next };
  } catch (e) {
    if (previous) await saveRecoveryMetadata(previous.metadata, args.store).catch(() => undefined);
    throw e;
  }
}

/**
 * Waits for the operation's receipt, re-reads the guardian state and, when
 * the chain matches the record, writes the bundle transaction hash as the
 * guardians' install transaction. Returns whether the record matches.
 */
export async function finalizeGuardianOperation(args: {
  bundle: Pick<AaClientBundle, 'client' | 'node'>;
  userOpHash: string;
  chain: string;
  account: string;
  kind: GuardianOperationKind;
  store: KeyValueStore;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<{ receipt: AaReceiptSummary; state: KernelGuardianState; matches: boolean }> {
  const raw = await args.bundle.client.waitForReceipt(args.userOpHash, {
    timeoutMs: args.timeoutMs ?? 120_000,
    pollMs: args.pollMs ?? 3_000,
  });
  const receipt = summarizeAaReceipt(raw);
  const state = await readGuardianState(args.bundle.node, args.account);
  const entry = await getRecoveryRecord(args.chain, args.account, args.store);
  let matches = false;
  if (entry) {
    const g = entry.metadata.guardians;
    if (g === null) {
      matches = !state.validatorInitialized && !state.validationInstalled;
    } else if (state.active && state.set) {
      matches = sameSet(state.set, g);
      if (matches && receipt.success === true && receipt.txHash && (args.kind === 'install' || args.kind === 'renew')) {
        await saveRecoveryMetadata(recordGuardians(entry.metadata, { ...g, installTxHash: receipt.txHash }), args.store);
      }
    }
  }
  return { receipt, state, matches };
}

function sameSet(a: KernelGuardianSet, b: { guardians: KernelGuardian[]; threshold: number; delaySeconds: number }): boolean {
  if (a.threshold !== b.threshold || a.delaySeconds !== b.delaySeconds || a.guardians.length !== b.guardians.length) {
    return false;
  }
  return a.guardians.every((g) => b.guardians.some((h) => same(g.address, h.address) && g.weight === h.weight));
}

/**
 * Reconciles the record's guardians with the chain (after a refused,
 * reverted or interrupted operation): the on-chain set replaces the
 * record's, keeping labels for addresses that stay; no guardians on-chain
 * clears it.
 */
export async function syncRecordGuardiansFromChain(
  node: JsonRpcTransport,
  chain: string,
  account: string,
  store: KeyValueStore = AsyncStorage,
): Promise<RecoveryRecordEntry> {
  const entry = await getRecoveryRecord(chain, account, store);
  if (!entry) throw new Error('This account has no recovery record.');
  const state = await readGuardianState(node, account);
  const old = entry.metadata.guardians;
  let guardians: KernelGuardianRecord | null = null;
  if (state.active && state.set) {
    const labels: Record<string, string> = {};
    for (const g of old?.guardians ?? []) if (g.label) labels[g.address.toLowerCase()] = g.label;
    const keepTx = old !== null && sameSet(state.set, old) ? old.installTxHash : null;
    guardians = guardianRecordFrom(state.set, labels, keepTx);
  }
  return saveRecoveryMetadata(recordGuardians(entry.metadata, guardians), store);
}

export interface GuardianStatus {
  state: KernelGuardianState;
  owner: KernelOwnerState;
  /** verifyRecoveryMetadataOnChain for the stored record (null without a record). */
  recordCheck: { ok: boolean; problems: string[] } | null;
}

/** Everything the status screen reads from the chain. */
export async function readGuardianStatus(
  node: JsonRpcTransport,
  account: string,
  entry: RecoveryRecordEntry | null,
): Promise<GuardianStatus> {
  const [state, owner] = await Promise.all([readGuardianState(node, account), readKernelOwner(node, account)]);
  const recordCheck = entry ? await verifyRecoveryMetadataOnChain(node, entry.metadata) : null;
  return { state, owner, recordCheck };
}

// ---------------------------------------------------------------------------
// Watched proposals and the veto list
// ---------------------------------------------------------------------------

/**
 * Adds a proposal to an account's watch list from pasted or scanned text:
 * a recovery request (this wallet's payload or the engine's request JSON —
 * re-derived by the engine, and it must be for this account and chain) or a
 * bare proposal id (0x + 64 hex).
 */
export async function addWatchedProposal(
  chain: string,
  account: string,
  input: string,
  store: KeyValueStore = AsyncStorage,
  now: number = Date.now(),
): Promise<RecoveryRecordEntry> {
  const entry = await getRecoveryRecord(chain, account, store);
  if (!entry) throw new Error('This account has no recovery record yet.');
  const text = input.trim();
  let hash: string;
  let newOwner: string | null = null;
  if (HASH32.test(text)) {
    hash = text.toLowerCase();
  } else {
    const { request } = parseRecoveryRequestPayload(text);
    if (!same(request.account, account)) {
      throw new Error(`This request is for ${request.account}, not this account (${account}).`);
    }
    if (`eip155:${request.chainId}` !== chain) {
      throw new Error(`This request is for chain ${request.chainId}, not the active network.`);
    }
    hash = request.callDataAndNonceHash.toLowerCase();
    newOwner = request.newOwner;
  }
  if (entry.watched.some((w) => w.hash === hash)) return entry;
  if (entry.watched.length >= MAX_WATCHED_PROPOSALS) {
    throw new Error(`At most ${MAX_WATCHED_PROPOSALS} proposals can be watched; remove one first.`);
  }
  const next = { ...entry, watched: [...entry.watched, { hash, newOwner, addedAt: now }] };
  await writeRecordEntry(next, recordKey(chain, account), store);
  return next;
}

export async function removeWatchedProposal(
  chain: string,
  account: string,
  hash: string,
  store: KeyValueStore = AsyncStorage,
): Promise<RecoveryRecordEntry> {
  const entry = await getRecoveryRecord(chain, account, store);
  if (!entry) throw new Error('This account has no recovery record.');
  const next = { ...entry, watched: entry.watched.filter((w) => w.hash !== hash.toLowerCase()) };
  await writeRecordEntry(next, recordKey(chain, account), store);
  return next;
}

export interface ProposalView {
  hash: string;
  newOwner: string | null;
  state: RecoveryProposalState | null;
  error: string | null;
  /** Seconds until an approved proposal may execute (0 when it already may), else null. */
  secondsUntilValid: number | null;
  canVeto: boolean;
  text: string;
}

/** Plain status of one proposal; `now` in unix seconds. */
export function proposalStatusText(state: RecoveryProposalState, threshold: number | null, now: number): string {
  const weight = threshold !== null ? `approved weight ${state.approvedWeight} of ${threshold}` : `approved weight ${state.approvedWeight}`;
  switch (state.status) {
    case 'ongoing':
      return `Pending: not approved on-chain yet (${weight}). You can veto it.`;
    case 'approved':
      return state.validAfter > now
        ? `APPROVED by guardians: it can execute in ${formatDuration(state.validAfter - now)} ` +
            `(unix ${state.validAfter}). Veto it now if you did not ask for it.`
        : 'APPROVED and the delay has passed: a guardian can execute it at any moment. Veto it now if you ' +
            'did not ask for it.';
    case 'rejected':
      return 'Vetoed: this proposal can never execute.';
    case 'executed':
      return 'Executed (or consumed): this proposal is finished. Check the account’s owner.';
  }
}

export async function readProposalView(
  node: JsonRpcTransport,
  account: string,
  watched: WatchedProposal,
  threshold: number | null,
  now: number = Math.floor(Date.now() / 1000),
): Promise<ProposalView> {
  try {
    const state = await readRecoveryProposal(node, account, watched.hash);
    return {
      hash: watched.hash,
      newOwner: watched.newOwner,
      state,
      error: null,
      secondsUntilValid: state.status === 'approved' ? Math.max(0, state.validAfter - now) : null,
      canVeto: state.status === 'ongoing' || state.status === 'approved',
      text: proposalStatusText(state, threshold, now),
    };
  } catch (e) {
    return {
      hash: watched.hash,
      newOwner: watched.newOwner,
      state: null,
      error: message(e),
      secondsUntilValid: null,
      canVeto: false,
      text: `Status unknown: ${message(e)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Payloads exchanged with guardians (QR codes and shareable text)
// ---------------------------------------------------------------------------

export const RECOVERY_REQUEST_PAYLOAD = 'shiba-wallet/guardian-recovery-request';
export const GUARDIAN_APPROVAL_PAYLOAD = 'shiba-wallet/guardian-approval';

/**
 * A recovery request for guardians, optionally with approvals collected so
 * far (a guardian who submits the final operation needs them on the
 * no-delay path). Every request field is re-derived by the engine on parse;
 * approvals are checked against the ON-CHAIN guardian set by whoever reads
 * them.
 */
export function encodeRecoveryRequestPayload(request: GuardianRecoveryRequest, approvals: readonly string[] = []): string {
  const parsed = parseGuardianRecoveryRequest(request);
  for (const a of approvals) if (!SIGNATURE65.test(a)) throw new Error('An approval is 65 bytes of hex.');
  return JSON.stringify({ type: RECOVERY_REQUEST_PAYLOAD, version: 1, request: parsed, approvals: [...approvals] });
}

/**
 * Reads a request from pasted or scanned text: this wallet's payload, or the
 * engine's bare GuardianRecoveryRequest JSON. parseGuardianRecoveryRequest
 * re-derives callData, the proposal id and the approval digest from the
 * fields and refuses any mismatch (never trust a request handed over by
 * someone else).
 */
export function parseRecoveryRequestPayload(text: string): { request: GuardianRecoveryRequest; approvals: Uint8Array[] } {
  const json = extractFirstJsonObject(text);
  if (json === null) throw new Error('No recovery request found in the text.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('The recovery request is not valid JSON.');
  }
  const v = parsed as { type?: unknown; version?: unknown; request?: unknown; approvals?: unknown };
  if (v && typeof v === 'object' && v.type === RECOVERY_REQUEST_PAYLOAD) {
    if (v.version !== 1) throw new Error('Unsupported recovery request version.');
    const request = parseGuardianRecoveryRequest(v.request);
    const approvals: Uint8Array[] = [];
    if (v.approvals !== undefined) {
      if (!Array.isArray(v.approvals)) throw new Error('approvals must be a list.');
      for (const a of v.approvals) {
        if (typeof a !== 'string' || !SIGNATURE65.test(a)) throw new Error('Each approval is 65 bytes of hex.');
        approvals.push(toBytes(a));
      }
    }
    return { request, approvals };
  }
  if (v && typeof v === 'object' && v.type === GUARDIAN_APPROVAL_PAYLOAD) {
    throw new Error('This is a guardian’s approval, not a recovery request. Add it on the recovering device.');
  }
  return { request: parseGuardianRecoveryRequest(parsed), approvals: [] };
}

/**
 * The EIP-712 typed data of the approval in eth_signTypedData_v4 JSON form,
 * for guardians who use another wallet (the engine's
 * guardianApprovalTypedData plus the EIP712Domain type list).
 */
export function approvalTypedDataJson(request: GuardianRecoveryRequest): string {
  const t = guardianApprovalTypedData(BigInt(request.chainId), request.callDataAndNonceHash, {
    weightedEcdsaValidator: request.weightedEcdsaValidator,
    recoveryAction: request.recoveryAction,
  });
  return JSON.stringify({
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      Approve: [{ name: 'callDataAndNonceHash', type: 'bytes32' }],
    },
    primaryType: t.primaryType,
    domain: {
      name: t.domain.name,
      version: t.domain.version,
      chainId: Number(t.domain.chainId),
      verifyingContract: t.domain.verifyingContract,
    },
    message: t.message,
  });
}

/** Share text for guardians: what is asked, the payload, and the typed data for other wallets. */
export function recoveryRequestShareText(request: GuardianRecoveryRequest, approvals: readonly string[] = []): string {
  return (
    'RECOVERY REQUEST — Shiba Wallet guardians\n' +
    `Account: ${request.account}\nProposed NEW OWNER: ${request.newOwner}\n` +
    `Chain id: ${request.chainId}\nProposal id: ${request.callDataAndNonceHash}\n\n` +
    'Approving hands control of this account to the new owner. Confirm with the account holder in ' +
    'person or on a channel you trust before you approve.\n\n' +
    'Shiba Wallet: Settings → Guardians → Approve a recovery, then paste everything below.\n\n' +
    encodeRecoveryRequestPayload(request, approvals) +
    '\n\nOther wallets: sign this EIP-712 typed data (eth_signTypedData_v4) with the guardian address ' +
    'and send back the signature:\n' +
    approvalTypedDataJson(request)
  );
}

/** A guardian's approval for the recovering device. */
export function encodeGuardianApprovalPayload(
  request: GuardianRecoveryRequest,
  guardian: string,
  signature: Uint8Array,
): string {
  if (signature.length !== 65) throw new Error('An approval signature is 65 bytes.');
  return JSON.stringify({
    type: GUARDIAN_APPROVAL_PAYLOAD,
    version: 1,
    chainId: request.chainId,
    account: request.account,
    callDataAndNonceHash: request.callDataAndNonceHash,
    guardian: checksum(guardian),
    signature: toHex(signature),
  });
}

/**
 * Reads an approval for `request` from pasted or scanned text: this
 * wallet's approval payload (which must name the same chain, account and
 * proposal) or a bare 65-byte signature from another wallet. The signer is
 * established only by verifyGuardianApproval against the guardian set.
 */
export function parseGuardianApprovalInput(text: string, request: GuardianRecoveryRequest): { signature: Uint8Array; claimedGuardian: string | null } {
  const trimmed = text.trim();
  if (SIGNATURE65.test(trimmed)) return { signature: toBytes(trimmed), claimedGuardian: null };
  const json = extractFirstJsonObject(trimmed);
  if (json === null) {
    throw new Error('Paste a guardian’s approval (from Shiba Wallet) or a 65-byte signature (0x + 130 hex characters).');
  }
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(json) as Record<string, unknown>;
  } catch {
    throw new Error('The approval is not valid JSON.');
  }
  if (v.type === RECOVERY_REQUEST_PAYLOAD) {
    throw new Error('This is the recovery request itself; a guardian turns it into an approval in their wallet.');
  }
  if (v.type !== GUARDIAN_APPROVAL_PAYLOAD || v.version !== 1) throw new Error('Not a guardian approval.');
  if (v.chainId !== request.chainId || typeof v.account !== 'string' || !same(v.account, request.account)) {
    throw new Error('This approval is for another account or network.');
  }
  if (typeof v.callDataAndNonceHash !== 'string' || !same(v.callDataAndNonceHash, request.callDataAndNonceHash)) {
    throw new Error('This approval is for a different proposal (an older request?). Ask for a new one.');
  }
  if (typeof v.signature !== 'string' || !SIGNATURE65.test(v.signature)) throw new Error('The approval signature is malformed.');
  const claimed = typeof v.guardian === 'string' && ADDRESS.test(v.guardian) ? v.guardian : null;
  return { signature: toBytes(v.signature), claimedGuardian: claimed };
}

// ---------------------------------------------------------------------------
// Recovering an account on a new wallet
// ---------------------------------------------------------------------------

export interface RecoveryProgress {
  chain: string;
  /** The account index of THIS wallet whose EOA becomes the new owner. */
  ownerIndex: number;
  newOwner: string;
  /** Null while only a draft exists (fresh account created, nothing checked yet). */
  account: string | null;
  request: GuardianRecoveryRequest | null;
  /** The on-chain guardian set when the request was built. */
  set: KernelGuardianSet | null;
  /** Verified approval signatures (hex), one per guardian. */
  approvals: string[];
  /** The approveWithSig transaction sent by this wallet (delay > 0). */
  approveTxHash: string | null;
  /** The account's recovery record, when imported or rebuilt. */
  metadata: KernelRecoveryMetadata | null;
  createdAt: number;
  updatedAt: number;
}

export function progressKey(chain: string, newOwner: string): string {
  return `${chain}|${newOwner.toLowerCase()}`;
}

function reviveProgress(value: unknown): RecoveryProgress | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  try {
    if (typeof v.chain !== 'string') return null;
    eip155ChainIdOf(v.chain);
    if (typeof v.ownerIndex !== 'number' || !Number.isSafeInteger(v.ownerIndex) || v.ownerIndex < 0) return null;
    if (typeof v.newOwner !== 'string' || !ADDRESS.test(v.newOwner)) return null;
    if (v.account !== null && (typeof v.account !== 'string' || !ADDRESS.test(v.account))) return null;
    const request = v.request === null ? null : parseGuardianRecoveryRequest(v.request);
    let set: KernelGuardianSet | null = null;
    if (v.set !== null) {
      const s = v.set as KernelGuardianSet;
      validateGuardianSet(s);
      set = { guardians: s.guardians.map((g) => ({ address: g.address, weight: g.weight })), threshold: s.threshold, delaySeconds: s.delaySeconds };
    }
    if (!Array.isArray(v.approvals) || v.approvals.some((a) => typeof a !== 'string' || !SIGNATURE65.test(a))) return null;
    if (v.approveTxHash !== null && (typeof v.approveTxHash !== 'string' || !HASH32.test(v.approveTxHash))) return null;
    const metadata = v.metadata === null ? null : parseRecoveryMetadata(v.metadata);
    if (request && (!v.account || !same(request.account, v.account as string) || !same(request.newOwner, v.newOwner))) {
      return null;
    }
    if ((request === null) !== (set === null)) return null;
    return {
      chain: v.chain,
      ownerIndex: v.ownerIndex,
      newOwner: checksum(v.newOwner),
      account: (v.account as string | null) ? checksum(v.account as string) : null,
      request,
      set,
      approvals: (v.approvals as string[]).map((a) => a.toLowerCase()),
      approveTxHash: (v.approveTxHash as string | null) ?? null,
      metadata,
      createdAt: typeof v.createdAt === 'number' ? v.createdAt : 0,
      updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : 0,
    };
  } catch {
    return null;
  }
}

/** Every recovery in progress on this device. Never throws. */
export async function loadRecoveryProgressList(store: KeyValueStore = AsyncStorage): Promise<RecoveryProgress[]> {
  const read = await readRawMap(store, RECOVERY_PROGRESS_KEY);
  if (read.state !== 'ok') return [];
  const out: RecoveryProgress[] = [];
  for (const [key, value] of Object.entries(read.entries)) {
    const p = reviveProgress(value);
    if (p && key === progressKey(p.chain, p.newOwner)) out.push(p);
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

/** The recovery in progress whose new owner is `newOwner` on `chain`, or null. */
export async function getRecoveryProgress(
  chain: string,
  newOwner: string,
  store: KeyValueStore = AsyncStorage,
): Promise<RecoveryProgress | null> {
  return (await loadRecoveryProgressList(store)).find((p) => p.chain === chain && same(p.newOwner, newOwner)) ?? null;
}

export async function saveRecoveryProgress(progress: RecoveryProgress, store: KeyValueStore = AsyncStorage): Promise<RecoveryProgress> {
  const read = await readRawMap(store, RECOVERY_PROGRESS_KEY);
  if (read.state === 'unreadable') {
    throw new Error('The saved recoveries in progress could not be read. Nothing was changed.');
  }
  const entries = read.state === 'ok' ? { ...read.entries } : {};
  const next: RecoveryProgress = { ...progress, updatedAt: Date.now() };
  entries[progressKey(progress.chain, progress.newOwner)] = {
    ...next,
    metadata: next.metadata ? serializeRecoveryMetadata(next.metadata) : null,
  };
  await store.setItem(RECOVERY_PROGRESS_KEY, JSON.stringify({ version: STORE_VERSION, entries }));
  return next;
}

/** Forgets a recovery in progress on this device. Nothing on-chain changes. */
export async function removeRecoveryProgress(chain: string, newOwner: string, store: KeyValueStore = AsyncStorage): Promise<void> {
  const read = await readRawMap(store, RECOVERY_PROGRESS_KEY);
  if (read.state !== 'ok') return;
  const entries = { ...read.entries };
  delete entries[progressKey(chain, newOwner)];
  await store.setItem(RECOVERY_PROGRESS_KEY, JSON.stringify({ version: STORE_VERSION, entries }));
}

/** A draft: the fresh account that will become the new owner, nothing checked yet. */
export function draftRecoveryProgress(chain: string, ownerIndex: number, newOwner: string, now: number = Date.now()): RecoveryProgress {
  if (!ADDRESS.test(newOwner)) throw new Error(`Not an EVM address: ${newOwner}`);
  return {
    chain,
    ownerIndex,
    newOwner: checksum(newOwner),
    account: null,
    request: null,
    set: null,
    approvals: [],
    approveTxHash: null,
    metadata: null,
    createdAt: now,
    updatedAt: now,
  };
}

export type RecoveryCandidate =
  | {
      kind: 'recoverable';
      account: string;
      currentOwner: string;
      request: GuardianRecoveryRequest;
      set: KernelGuardianSet;
      check: KernelAccountOwnershipCheck;
    }
  /** The new owner already owns it: no recovery needed — attach it instead. */
  | { kind: 'already-owner'; account: string; check: KernelAccountOwnershipCheck };

/**
 * Checks a lost account on-chain and builds the request guardians sign.
 * verifyKernelAccountForOwner cannot pass yet (the owner is not ours), so
 * it is run for the NEW owner and every problem except the owner mismatch
 * refuses: no code, a 7702 EOA, a foreign implementation, a non-ECDSA root.
 * Then the engine's prepareGuardianRecovery (chain id, ACTIVE guardians via
 * readGuardianState, ECDSA root, new owner ≠ current owner and not a
 * guardian, the guardian-lane nonce) builds the request.
 */
export async function prepareRecoveryStart(
  node: JsonRpcTransport,
  args: { chainId: bigint; account: string; newOwner: string; metadata?: KernelRecoveryMetadata | null },
): Promise<RecoveryCandidate> {
  // Mainnet readiness (config/readiness.ts): refused before any request
  // where guardians are not allowed.
  assertFeatureAllowed('guardians', eip155Caip2(args.chainId));
  const validated = validateRecipient(EVM_CHAIN_ID, args.account);
  if (!validated.ok) throw new Error(validated.error);
  const account = validated.normalized;
  if (args.metadata) {
    if (!same(args.metadata.account, account)) throw new Error('The recovery record is for a different account.');
    if (args.metadata.chainId !== `eip155:${args.chainId}`) {
      throw new Error(`The recovery record is for ${args.metadata.chainId}, not the active network.`);
    }
  }
  const check = await verifyKernelAccountForOwner(node, account, args.newOwner);
  if (check.ok) return { kind: 'already-owner', account: check.account, check };
  const blocking = check.problems.filter((p) => !p.startsWith('owner is '));
  if (blocking.length > 0) {
    throw new Error(`This is not a recoverable Kernel v3.3 account: ${blocking.join('; ')}.`);
  }
  // A proposal is keccak256(sender, callData, nonce): after a veto the same
  // new owner on the same lane would reproduce the REJECTED proposal id
  // forever. The guardian nonce key ends in a 16-bit parallel key (engine
  // guardianNonceKey: mode || type || validator || parallel key, per Kernel
  // ValidatorLib; the engine's recovery spec accepts any parallel key), so
  // the first lane whose proposal for this new owner is still open (ongoing
  // or approved) is used. A non-zero parallel key has NOT been exercised
  // live yet (the engine's Sepolia run used lane 0).
  for (let parallelKey = 0; parallelKey < MAX_PARALLEL_KEYS; parallelKey++) {
    const { request, set, currentOwner } = await prepareGuardianRecovery(node, {
      chainId: args.chainId,
      account,
      newOwner: args.newOwner,
      parallelKey,
    });
    const proposal = await readRecoveryProposal(node, account, request.callDataAndNonceHash);
    if (proposal.status === 'ongoing' || proposal.status === 'approved') {
      return { kind: 'recoverable', account: check.account, currentOwner, request, set, check };
    }
  }
  throw new Error(
    `Every recovery proposal for this new owner on the first ${MAX_PARALLEL_KEYS} guardian lanes was vetoed or ` +
      'consumed. Use another account of this wallet as the new owner.',
  );
}

/** Guardian-lane parallel keys tried for a fresh proposal (wallet policy). */
export const MAX_PARALLEL_KEYS = 16;

/**
 * Adds one approval (pasted or scanned) to a recovery in progress after
 * verifyGuardianApproval recovered its signer and found it in the set the
 * request was built against. A second approval from the same guardian is
 * ignored (added = false).
 */
export function addApprovalToProgress(
  progress: RecoveryProgress,
  input: string,
): { progress: RecoveryProgress; guardian: KernelGuardian; added: boolean } {
  if (!progress.request || !progress.set) throw new Error('Create the recovery request first.');
  const { signature, claimedGuardian } = parseGuardianApprovalInput(input, progress.request);
  const guardian = verifyGuardianApproval(progress.request, signature, progress.set);
  if (claimedGuardian && !same(claimedGuardian, guardian.address)) {
    throw new Error(`The approval claims to be from ${claimedGuardian} but was signed by ${guardian.address}.`);
  }
  const existing = progress.approvals.some((a) => {
    try {
      return same(verifyGuardianApproval(progress.request!, toBytes(a), progress.set!).address, guardian.address);
    } catch {
      return false;
    }
  });
  if (existing) return { progress, guardian, added: false };
  return { progress: { ...progress, approvals: [...progress.approvals, toHex(signature).toLowerCase()] }, guardian, added: true };
}

export interface ApprovalProgress {
  weight: number;
  threshold: number;
  approvers: KernelGuardian[];
  /** Delay > 0: enough weight for approveWithSig to mark the proposal Approved. */
  enoughForOnChainApproval: boolean;
  /**
   * Delay 0: guardians who could submit the final operation now (their own
   * weight counts once, with the approvals in front of it).
   */
  possibleSubmitters: KernelGuardian[];
}

export function recoveryApprovalProgress(progress: RecoveryProgress): ApprovalProgress {
  if (!progress.request || !progress.set) throw new Error('Create the recovery request first.');
  const approvers: KernelGuardian[] = [];
  for (const a of progress.approvals) {
    try {
      const g = verifyGuardianApproval(progress.request, toBytes(a), progress.set);
      if (!approvers.some((x) => same(x.address, g.address))) approvers.push(g);
    } catch {
      // Stored approvals were verified when added; skip anything unreadable.
    }
  }
  const weight = approvers.reduce((s, g) => s + g.weight, 0);
  const t = progress.set.threshold;
  const possibleSubmitters =
    progress.set.delaySeconds === 0
      ? progress.set.guardians.filter((g) => {
          const approved = approvers.some((x) => same(x.address, g.address));
          return (approved ? weight : weight + g.weight) >= t;
        })
      : [];
  return { weight, threshold: t, approvers, enoughForOnChainApproval: weight >= t, possibleSubmitters };
}

export type RecoveryStage =
  /** Collecting approvals (delay > 0: not yet enough weight; delay 0: no guardian can submit yet). */
  | { kind: 'collecting' }
  /** Delay > 0: enough approvals; send approveWithSig. */
  | { kind: 'ready-to-approve' }
  /** Delay > 0: approved on-chain, waiting out the delay. */
  | { kind: 'waiting'; validAfter: number; secondsLeft: number }
  /** A guardian can submit the final operation now. */
  | { kind: 'ready-to-submit' }
  /** The new owner owns the account: attach it. */
  | { kind: 'recovered' }
  /** The owner vetoed the proposal. */
  | { kind: 'vetoed' }
  /** The guardian nonce moved: these approvals are void. */
  | { kind: 'stale'; reason: string }
  /** The proposal was consumed but the owner did not change. */
  | { kind: 'executed-other'; owner: string };

/** The uint192 EntryPoint nonce key a request's operation uses (guardian lane + parallel key). */
function laneKeyOf(request: GuardianRecoveryRequest): bigint {
  return BigInt(request.nonce) >> 64n;
}

/** The full EntryPoint nonce (key << 64 | sequence) of the request's lane right now. */
async function readGuardianLaneNonce(
  node: JsonRpcTransport,
  account: string,
  key: bigint,
  entryPoint = ENTRYPOINT_V07,
): Promise<bigint> {
  const result = (await node('eth_call', [
    {
      to: entryPoint,
      data: toHex(
        encodeFunctionCall('getNonce(address,uint192)', [
          { kind: 'address', value: account },
          { kind: 'uint256', value: key },
        ]),
      ),
    },
    'latest',
  ])) as string;
  return BigInt(result);
}

/** Where a recovery in progress stands, from the chain (owner, proposal, guardian nonce). */
export async function readRecoveryStage(
  node: JsonRpcTransport,
  progress: RecoveryProgress,
  now: number = Math.floor(Date.now() / 1000),
): Promise<{ stage: RecoveryStage; owner: KernelOwnerState; proposal: RecoveryProposalState | null }> {
  if (!progress.request || !progress.set || !progress.account) throw new Error('Create the recovery request first.');
  const request = progress.request;
  const owner = await readKernelOwner(node, progress.account);
  if (same(owner.owner, progress.newOwner)) return { stage: { kind: 'recovered' }, owner, proposal: null };
  const proposal = await readRecoveryProposal(node, progress.account, request.callDataAndNonceHash);
  if (proposal.status === 'rejected') return { stage: { kind: 'vetoed' }, owner, proposal };
  if (proposal.status === 'executed') return { stage: { kind: 'executed-other', owner: owner.owner }, owner, proposal };
  const nonce = await readGuardianLaneNonce(node, progress.account, laneKeyOf(request));
  if (nonce !== BigInt(request.nonce)) {
    return {
      stage: {
        kind: 'stale',
        reason: `The guardian nonce is now ${nonce}, not the ${request.nonce} the approvals cover; collect new ones.`,
      },
      owner,
      proposal,
    };
  }
  const p = recoveryApprovalProgress(progress);
  if (progress.set.delaySeconds === 0) {
    return { stage: p.possibleSubmitters.length > 0 ? { kind: 'ready-to-submit' } : { kind: 'collecting' }, owner, proposal };
  }
  if (proposal.status === 'approved') {
    return proposal.validAfter > now
      ? { stage: { kind: 'waiting', validAfter: proposal.validAfter, secondsLeft: proposal.validAfter - now }, owner, proposal }
      : { stage: { kind: 'ready-to-submit' }, owner, proposal };
  }
  return { stage: p.enoughForOnChainApproval ? { kind: 'ready-to-approve' } : { kind: 'collecting' }, owner, proposal };
}

export interface ApproveWithSigQuote {
  kind: 'approve-with-sig';
  /** This wallet's new owner EOA: it sends (and pays for) the transaction. */
  from: string;
  /** The weighted validator. */
  to: string;
  data: Uint8Array;
  chainId: bigint;
  nonce: bigint;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  fee: bigint;
  balance: bigint;
  approvals: number;
  weight: number;
}

/**
 * Quotes the approveWithSig transaction for a delay > 0 recovery: a plain
 * EIP-1559 transaction FROM the new owner's EOA (anyone may send it; this
 * wallet's address pays) to the validator with every collected approval.
 * Refused for delay 0 (the approvals travel inside the final operation),
 * when the weight is below the threshold (the proposal would stay pending),
 * or when the proposal is not ongoing. eth_estimateGas simulates it, so a
 * contract refusal ("Already voted", "Proposal not ongoing") appears here
 * verbatim and nothing is signed.
 */
export async function prepareApproveWithSig(
  node: JsonRpcTransport,
  args: { progress: RecoveryProgress; from: string },
): Promise<ApproveWithSigQuote> {
  const { progress } = args;
  // Mainnet readiness (config/readiness.ts): refused before any request
  // where guardians are not allowed.
  assertFeatureAllowed('guardians', progress.chain);
  if (!progress.request || !progress.set || !progress.account) throw new Error('Create the recovery request first.');
  if (!same(args.from, progress.newOwner)) {
    throw new Error('Send the approvals from the account that becomes the new owner. Switch to it first.');
  }
  if (progress.set.delaySeconds === 0) {
    throw new Error('This guardian set has no delay: the approvals travel inside the final recovery operation.');
  }
  const p = recoveryApprovalProgress(progress);
  if (!p.enoughForOnChainApproval) {
    throw new Error(`The approvals carry weight ${p.weight}, below the threshold ${p.threshold}. Collect more first.`);
  }
  const client = new NodeClient(node);
  const chainId = await client.chainId();
  if (chainId !== BigInt(progress.request.chainId)) {
    throw new Error(`Endpoint is chain id ${chainId}, expected ${progress.request.chainId}.`);
  }
  const proposal = await readRecoveryProposal(node, progress.account, progress.request.callDataAndNonceHash);
  if (proposal.status !== 'ongoing') throw new Error(`The proposal is already ${proposal.status}; nothing to send.`);
  const call = encodeApproveWithSig(progress.request, progress.approvals.map((a) => toBytes(a)));
  const [estimate, fees, nonce, balance] = await Promise.all([
    client.estimateGas({ from: args.from, to: call.to, value: 0n, data: toHex(call.data) }),
    client.suggestFees(),
    client.getTransactionCount(args.from),
    client.getBalance(args.from),
  ]);
  // 20 % headroom over the estimate; unused gas is not charged.
  const gasLimit = (estimate * 120n) / 100n;
  const fee = gasLimit * fees.maxFeePerGas;
  if (fee > balance) {
    throw new Error(
      `Not enough ETH for the network fee: the worst case is ${fee} wei and this account holds ${balance} wei. ` +
        'Send a little ETH to this account first.',
    );
  }
  return {
    kind: 'approve-with-sig',
    from: checksum(args.from),
    to: call.to,
    data: call.data,
    chainId,
    nonce,
    gasLimit,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    fee,
    balance,
    approvals: progress.approvals.length,
    weight: p.weight,
  };
}

/** Signs (with the new owner's EOA, after the biometric gate) and broadcasts approveWithSig. */
export async function sendApproveWithSig(
  node: JsonRpcTransport,
  signer: DerivedAccount,
  quote: ApproveWithSigQuote,
): Promise<string> {
  assertFeatureAllowed('guardians', eip155Caip2(quote.chainId));
  if (!same(signer.address, quote.from)) {
    throw new Error(`This signer is ${signer.address}, but the transaction was prepared for ${quote.from}. Nothing was signed.`);
  }
  const client = new NodeClient(node);
  if ((await client.chainId()) !== quote.chainId) throw new Error('The endpoint changed chains. Nothing was signed.');
  const signed = signEip1559(
    {
      chainId: quote.chainId,
      nonce: quote.nonce,
      maxPriorityFeePerGas: quote.maxPriorityFeePerGas,
      maxFeePerGas: quote.maxFeePerGas,
      gasLimit: quote.gasLimit,
      to: quote.to,
      value: 0n,
      data: quote.data,
    },
    signer,
  );
  return client.sendRawTransaction(signed.rawHex);
}

/** Polls for a transaction receipt; true when it succeeded. Throws on timeout. */
export async function waitForTransaction(
  node: JsonRpcTransport,
  txHash: string,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<{ success: boolean; blockNumber: string | null }> {
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  const pollMs = options.pollMs ?? 4_000;
  for (;;) {
    const receipt = (await node('eth_getTransactionReceipt', [txHash])) as { status?: string; blockNumber?: string } | null;
    if (receipt) {
      return {
        success: receipt.status === '0x1',
        blockNumber: typeof receipt.blockNumber === 'string' ? BigInt(receipt.blockNumber).toString(10) : null,
      };
    }
    if (Date.now() + pollMs > deadline) throw new Error(`Timed out waiting for transaction ${txHash}`);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

// ---------------------------------------------------------------------------
// Guardian side: review, approve, submit
// ---------------------------------------------------------------------------

export const REQUEST_NOT_ROOT_REFUSAL =
  'This request would not replace the account’s owner key: the validator it names is not the ' +
  'account’s root (owner) validator. Refusing it.';

/**
 * A request is acted on only when it names the pinned guardian modules and
 * the pinned ECDSA owner validator. doRecovery accepts ANY validator and
 * data (engine finding 1), so a request naming another validator could
 * reconfigure something else entirely while looking like a recovery.
 */
export function assertSupportedRequest(request: GuardianRecoveryRequest): void {
  if (
    !same(request.weightedEcdsaValidator, KERNEL_RECOVERY_MODULES.weightedEcdsaValidator) ||
    !same(request.recoveryAction, KERNEL_RECOVERY_MODULES.recoveryAction)
  ) {
    throw new Error('This request names guardian modules other than the ones this wallet supports; refusing it.');
  }
  if (!same(request.ecdsaValidator, KERNEL_V3_3.ecdsaValidator)) throw new Error(REQUEST_NOT_ROOT_REFUSAL);
}

export interface GuardianRequestReview {
  request: GuardianRecoveryRequest;
  /** Approvals carried by the request that verified against the on-chain set. */
  approvals: { guardian: KernelGuardian; signature: Uint8Array }[];
  /** Carried approvals that did not verify (never used). */
  invalidApprovals: string[];
  set: KernelGuardianSet;
  currentOwner: string;
  /** This wallet's guardian entry, or null when the active account is not a guardian. */
  guardian: KernelGuardian | null;
  proposal: RecoveryProposalState;
  /** False when the guardian nonce moved since the request was made (approvals void). */
  nonceMatches: boolean;
}

/**
 * The guardian's review of a request: the request is re-derived by the
 * engine, its chain must be the active one (and the endpoint's), the
 * account's guardian set and owner are read from the chain, every carried
 * approval is verified against that set, and the active account's place in
 * the set is looked up. Read-only; signs nothing.
 */
export async function reviewRecoveryRequest(
  node: JsonRpcTransport,
  args: { text: string; activeChainId: bigint; guardianAddress: string },
): Promise<GuardianRequestReview> {
  // Mainnet readiness (config/readiness.ts): refused before any request
  // where guardians are not allowed.
  assertFeatureAllowed('guardians', eip155Caip2(args.activeChainId));
  const { request, approvals } = parseRecoveryRequestPayload(args.text);
  if (BigInt(request.chainId) !== args.activeChainId) {
    throw new Error(`This request is for chain ${request.chainId}; the wallet is on chain ${args.activeChainId}. Switch networks first.`);
  }
  const reported = await new NodeClient(node).chainId();
  if (reported !== args.activeChainId) throw new Error(`The RPC endpoint is chain id ${reported}, expected ${args.activeChainId}.`);
  assertSupportedRequest(request);
  const modules = { weightedEcdsaValidator: request.weightedEcdsaValidator, recoveryAction: request.recoveryAction };
  const state = await readGuardianState(node, request.account, modules);
  if (!state.active || !state.set) throw new Error(`${request.account} has no active guardian recovery.`);
  const owner = await readKernelOwner(node, request.account, request.ecdsaValidator);
  if (!owner.ecdsaRoot) throw new Error(REQUEST_NOT_ROOT_REFUSAL);
  const verified: { guardian: KernelGuardian; signature: Uint8Array }[] = [];
  const invalid: string[] = [];
  for (const sig of approvals) {
    try {
      const g = verifyGuardianApproval(request, sig, state.set);
      if (!verified.some((x) => same(x.guardian.address, g.address))) verified.push({ guardian: g, signature: sig });
    } catch (e) {
      invalid.push(message(e));
    }
  }
  const guardian = state.set.guardians.find((g) => same(g.address, args.guardianAddress)) ?? null;
  const proposal = await readRecoveryProposal(node, request.account, request.callDataAndNonceHash, modules);
  const nonce = await readGuardianLaneNonce(node, request.account, laneKeyOf(request));
  return {
    request,
    approvals: verified,
    invalidApprovals: invalid,
    set: state.set,
    currentOwner: owner.owner,
    guardian: guardian ? { address: checksum(guardian.address), weight: guardian.weight } : null,
    proposal,
    nonceMatches: nonce === BigInt(request.nonce),
  };
}

/**
 * Signs the request's EIP-712 Approve digest with the guardian's EOA (call
 * only after the biometric gate, with the signer from signWith). The digest
 * is the one the ENGINE re-derived from the request's fields; the signer
 * must be in the on-chain set the review read; the signature is verified
 * again before it leaves this function.
 */
export function signRecoveryApproval(
  signer: DerivedAccount,
  review: GuardianRequestReview,
): { signature: Uint8Array; payload: string } {
  // Mainnet readiness: a guardian approval is never signed where guardians are not allowed.
  assertFeatureAllowed('guardians', eip155Caip2(BigInt(review.request.chainId)));
  if (!review.guardian || !same(review.guardian.address, signer.address)) {
    throw new Error(`${signer.address} is not a guardian of ${review.request.account}. Nothing was signed.`);
  }
  if (!review.nonceMatches) throw new Error('This request is out of date (the guardian nonce moved). Nothing was signed.');
  if (review.proposal.status !== 'ongoing') {
    throw new Error(`This proposal is already ${review.proposal.status}; nothing to approve.`);
  }
  const signature = signGuardianApproval(signer, toBytes(review.request.approvalDigest));
  const check = verifyGuardianApproval(review.request, signature, review.set);
  if (!same(check.address, signer.address)) throw new Error('The approval did not verify. Nothing was shared.');
  return { signature, payload: encodeGuardianApprovalPayload(review.request, signer.address, signature) };
}

export interface GuardianSubmissionQuote {
  request: GuardianRecoveryRequest;
  /** Approvals in the operation signature (delay 0), engine-ordered; [] for an approved proposal. */
  approvals: Uint8Array[];
  submitter: string;
  set: KernelGuardianSet;
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** Worst case, paid by the ACCOUNT being recovered (no paymaster). */
  fee: bigint;
  accountBalance: bigint;
}

/**
 * Quotes the final recovery operation, submitted by a guardian (the
 * contract requires a guardian's signature over the userOpHash):
 *  - delay 0: the engine's assembleGuardianApprovals orders the carried
 *    approvals, drops the submitter's own, and refuses unless approvers +
 *    submitter reach the threshold (its text verbatim);
 *  - delay > 0: the proposal must be approved on-chain and its delay over.
 * The guardian nonce must still be the request's. The bundler estimate over
 * the engine spec's stub signature is the pre-flight gate (a wrong signature
 * would still pass estimation — engine lesson — so the real check is the
 * bundler's validation at submission). No paymaster: the account pays.
 */
export async function prepareGuardianSubmission(args: {
  node: JsonRpcTransport;
  bundler: JsonRpcTransport;
  chainId: bigint;
  request: GuardianRecoveryRequest;
  approvals: Uint8Array[];
  submitter: string;
  now?: number;
}): Promise<GuardianSubmissionQuote> {
  // Mainnet readiness (config/readiness.ts): refused before any request
  // where guardians are not allowed.
  assertFeatureAllowed('guardians', eip155Caip2(args.chainId));
  const request = parseGuardianRecoveryRequest(args.request);
  assertSupportedRequest(request);
  const client = new NodeClient(args.node);
  const reported = await client.chainId();
  if (reported !== args.chainId || BigInt(request.chainId) !== args.chainId) {
    throw new Error(`Chain mismatch: endpoint ${reported}, request ${request.chainId}, wallet ${args.chainId}.`);
  }
  const state = await readGuardianState(args.node, request.account);
  if (!state.active || !state.set) throw new Error(`${request.account} has no active guardian recovery.`);
  const set = state.set;
  if (!set.guardians.some((g) => same(g.address, args.submitter))) {
    throw new Error(`${args.submitter} is not a guardian of ${request.account}; only a guardian can submit the recovery.`);
  }
  const owner = await readKernelOwner(args.node, request.account, request.ecdsaValidator);
  if (!owner.ecdsaRoot) throw new Error(REQUEST_NOT_ROOT_REFUSAL);
  if (same(owner.owner, request.newOwner)) throw new Error('The new owner already owns the account; the recovery is done.');
  const nonce = await readGuardianLaneNonce(args.node, request.account, laneKeyOf(request));
  if (nonce !== BigInt(request.nonce)) {
    throw new Error(`The guardian nonce is now ${nonce}, not the approved ${request.nonce}; the approvals are void.`);
  }
  let approvals: Uint8Array[];
  if (set.delaySeconds === 0) {
    approvals = assembleGuardianApprovals(request, set, args.approvals, args.submitter).approvals;
  } else {
    const proposal = await readRecoveryProposal(args.node, request.account, request.callDataAndNonceHash);
    const now = args.now ?? Math.floor(Date.now() / 1000);
    if (proposal.status !== 'approved') {
      throw new Error(
        proposal.status === 'ongoing'
          ? 'The guardians’ approvals are not on-chain yet: the recovering wallet sends them first (approveWithSig).'
          : `The proposal is ${proposal.status}; it cannot execute.`,
      );
    }
    if (proposal.validAfter > now) {
      throw new Error(`The delay is not over: the recovery can execute in ${formatDuration(proposal.validAfter - now)}.`);
    }
    approvals = [];
  }
  const spec = kernelGuardianRecoverySpec({ request, approvals, submitter: args.submitter });
  const [suggested, floor, accountBalance] = await Promise.all([
    client.suggestFees(),
    bundlerPriorityFeeFloor(args.bundler),
    client.getBalance(request.account),
  ]);
  const fees = applyPriorityFeeFloor(suggested, floor);
  const op: UserOperation = {
    sender: request.account,
    nonce: BigInt(request.nonce),
    callData: spec.encodeCalls([recoveryCall(request)]),
    callGasLimit: 0n,
    verificationGasLimit: 0n,
    preVerificationGas: 0n,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    signature: spec.stubSignature(),
  };
  const gas = await new BundlerClient(args.bundler, ENTRYPOINT_V07).estimateUserOperationGas(op);
  const fee = (gas.callGasLimit + gas.verificationGasLimit + gas.preVerificationGas) * fees.maxFeePerGas;
  if (fee > accountBalance) {
    throw new Error(
      `The account pays its own gas and holds ${accountBalance} wei, below the worst-case fee of ${fee} wei. ` +
        'Send a little ETH to the account first (anyone can).',
    );
  }
  return {
    request,
    approvals,
    submitter: checksum(args.submitter),
    set,
    callGasLimit: gas.callGasLimit,
    verificationGasLimit: gas.verificationGasLimit,
    preVerificationGas: gas.preVerificationGas,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    fee,
    accountBalance,
  };
}

/**
 * Signs (with the guardian's EOA from signWith, after the biometric gate)
 * and submits the recovery through SmartAccountClient with the engine's
 * kernelGuardianRecoverySpec — the path the engine proved live on Sepolia.
 * The spec refuses any other signer and any change of the guardian nonce.
 */
export async function submitGuardianRecovery(args: {
  quote: GuardianSubmissionQuote;
  node: JsonRpcTransport;
  bundler: JsonRpcTransport;
  chainId: bigint;
  signer: DerivedAccount;
}): Promise<{ userOpHash: string; client: SmartAccountClient }> {
  assertFeatureAllowed('guardians', eip155Caip2(args.chainId));
  if (!same(args.signer.address, args.quote.submitter)) {
    throw new Error(`This recovery was prepared for guardian ${args.quote.submitter}. Nothing was signed.`);
  }
  const spec = kernelGuardianRecoverySpec({
    request: args.quote.request,
    approvals: args.quote.approvals,
    submitter: args.quote.submitter,
  });
  const client = new SmartAccountClient({
    chainId: args.chainId,
    entryPoint: ENTRYPOINT_V07,
    bundler: args.bundler,
    node: spec.routeNode(args.node),
    spec,
    // Same deposit top-up headroom as every other self-paid smart-account
    // operation (aa.ts AA_DEPOSIT_TOPUP_VERIFICATION_GAS explains why).
    depositTopUpVerificationGas: AA_DEPOSIT_TOPUP_VERIFICATION_GAS,
  });
  const { userOpHash } = await client.sendCalls(args.signer, [recoveryCall(args.quote.request)], {
    maxFeePerGas: args.quote.maxFeePerGas,
    maxPriorityFeePerGas: args.quote.maxPriorityFeePerGas,
  });
  return { userOpHash, client };
}

// ---------------------------------------------------------------------------
// After the recovery: attach the account, extend its history
// ---------------------------------------------------------------------------

function topicFor(address: string): string {
  return '0x' + '0'.repeat(24) + address.slice(2).toLowerCase();
}

/**
 * Finds the transaction that made `newOwner` the owner: the ECDSA
 * validator's OwnerRegistered(kernel, owner) log within the last
 * `lookbackBlocks` blocks (free endpoints cap log ranges; the engine notes
 * ~10,000 blocks on publicnode). Null when not found in range.
 */
export async function findRecoveryTransaction(
  node: JsonRpcTransport,
  account: string,
  newOwner: string,
  options: { lookbackBlocks?: number; ecdsaValidator?: string } = {},
): Promise<{ txHash: string; blockNumber: string } | null> {
  const latest = BigInt((await node('eth_blockNumber', [])) as string);
  const lookback = BigInt(options.lookbackBlocks ?? 9_000);
  const from = latest > lookback ? latest - lookback : 0n;
  const logs = (await node('eth_getLogs', [
    {
      address: options.ecdsaValidator ?? KERNEL_V3_3.ecdsaValidator,
      fromBlock: '0x' + from.toString(16),
      toBlock: '0x' + latest.toString(16),
      topics: [ECDSA_OWNER_REGISTERED_TOPIC, topicFor(account), topicFor(newOwner)],
    },
  ])) as { transactionHash?: string; blockNumber?: string }[] | null;
  const last = (logs ?? []).filter((l) => typeof l.transactionHash === 'string' && HASH32.test(l.transactionHash)).pop();
  if (!last) return null;
  return {
    txHash: last.transactionHash!.toLowerCase(),
    blockNumber: typeof last.blockNumber === 'string' ? BigInt(last.blockNumber).toString(10) : '0',
  };
}

/**
 * "Use this recovered account": attaches `account` to the wallet's owner
 * EOA on `chain` ONLY after the engine's verifyKernelAccountForOwner passed
 * (Kernel proxy for the pinned implementation, ECDSA root, stored owner =
 * `owner`); anything less throws and attaches nothing. Then, when a record
 * is known, appends the owner change (guardian recovery, with the tx and/or
 * userOpHash) and saves it. historyUpdated is false when no record exists
 * or no transaction reference was available.
 */
export async function attachRecoveredAccount(args: {
  node: JsonRpcTransport;
  chain: string;
  account: string;
  owner: string;
  ownerPath: string | null;
  metadata: KernelRecoveryMetadata | null;
  change?: { txHash: string | null; userOpHash: string | null; blockNumber: string | null; source?: 'guardian-recovery' | 'owner-rotation' } | null;
  store?: KeyValueStore;
  aaStore?: KeyValueStore;
  now?: number;
}): Promise<{ check: KernelAccountOwnershipCheck; entry: RecoveryRecordEntry | null; historyUpdated: boolean }> {
  // Mainnet readiness: a recovered account is attached only where the
  // feature that produced it is allowed, before any request.
  assertFeatureAllowed(args.change?.source === 'owner-rotation' ? 'owner-rotation' : 'guardians', args.chain);
  const store = args.store ?? AsyncStorage;
  const reported = await new NodeClient(args.node).chainId();
  if (`eip155:${reported}` !== args.chain) throw new Error(`The RPC endpoint is chain ${reported}, not ${args.chain}. Nothing was attached.`);
  const check = await verifyKernelAccountForOwner(args.node, args.account, args.owner);
  if (!check.ok) {
    throw new Error(`Not attached: ${check.problems.join('; ')}.`);
  }
  await setRecoveredAccount(args.chain, args.owner, check.account, args.aaStore ?? store);
  if (!args.metadata) return { check, entry: null, historyUpdated: false };
  let meta = args.metadata;
  let historyUpdated = false;
  if (!same(currentOwnerOf(meta), args.owner)) {
    const change = args.change ?? null;
    if (change && (change.txHash || change.userOpHash)) {
      meta = recordOwnerChange(meta, {
        owner: checksum(args.owner),
        source: change.source ?? 'guardian-recovery',
        txHash: change.txHash,
        userOpHash: change.userOpHash,
        blockNumber: change.blockNumber,
        derivationPath: args.ownerPath && BIP32_PATH.test(args.ownerPath) ? args.ownerPath : null,
        recordedAt: Math.floor((args.now ?? Date.now()) / 1000),
      });
      historyUpdated = true;
    }
  } else {
    historyUpdated = true;
  }
  const entry = historyUpdated ? await saveRecoveryMetadata(meta, store) : await saveRecoveryMetadata(args.metadata, store);
  return { check, entry, historyUpdated };
}

/** Detaches a recovered account from an owner (local only; nothing on-chain changes). */
export async function detachRecoveredAccount(chain: string, owner: string, aaStore: KeyValueStore = AsyncStorage): Promise<void> {
  await setRecoveredAccount(chain, owner, null, aaStore);
}

export interface RecordImportReview {
  metadata: KernelRecoveryMetadata;
  verification: { ok: boolean; problems: string[] };
  /** The account's owner right now, read from the chain. */
  onChainOwner: string | null;
  /** The wallet account (index, EOA, path) that owns it now, if any. */
  ownerAccount: { index: number; address: string; path: string } | null;
  /**
   * True when the owning account would not find the address by itself (the
   * address is not the CREATE2 result of that EOA at that account's index),
   * so it must be attached.
   */
  needsAttach: boolean;
}

/**
 * Restore path: reads a backed-up record, verifies it against the chain
 * (verifyRecoveryMetadataOnChain — every mismatch listed), reads the
 * current owner and matches it against this wallet's accounts. Read-only;
 * applyRecordImport saves and attaches after the user confirms.
 */
export async function reviewRecordImport(
  node: JsonRpcTransport,
  text: string,
  ownedAccounts: readonly { index: number; address: string; path: string }[],
): Promise<RecordImportReview> {
  const metadata = parseRecordText(text);
  const verification = await verifyRecoveryMetadataOnChain(node, metadata);
  let onChainOwner: string | null = null;
  try {
    onChainOwner = (await readKernelOwner(node, metadata.account, metadata.deployment.ecdsaValidator)).owner;
  } catch {
    onChainOwner = null;
  }
  const ownerAccount = onChainOwner ? (ownedAccounts.find((a) => same(a.address, onChainOwner!)) ?? null) : null;
  let needsAttach = false;
  if (ownerAccount) {
    const predicted = predictKernelAddress(ownerAccount.address, {
      index: BigInt(ownerAccount.index),
      factory: metadata.deployment.factory,
      implementation: metadata.deployment.implementation,
      ecdsaValidator: metadata.deployment.ecdsaValidator,
    });
    needsAttach = !same(predicted, metadata.account);
  }
  return { metadata, verification, onChainOwner, ownerAccount, needsAttach };
}

/**
 * Saves an imported record and, when one of this wallet's accounts owns the
 * account but would not derive it, attaches it — through
 * attachRecoveredAccount, i.e. only after verifyKernelAccountForOwner.
 */
export async function applyRecordImport(args: {
  node: JsonRpcTransport;
  review: RecordImportReview;
  store?: KeyValueStore;
  aaStore?: KeyValueStore;
}): Promise<{ entry: RecoveryRecordEntry; attached: boolean }> {
  const store = args.store ?? AsyncStorage;
  const { review } = args;
  if (review.needsAttach && review.ownerAccount) {
    const result = await attachRecoveredAccount({
      node: args.node,
      chain: review.metadata.chainId,
      account: review.metadata.account,
      owner: review.ownerAccount.address,
      ownerPath: review.ownerAccount.path,
      metadata: review.metadata,
      change: null,
      store,
      ...(args.aaStore ? { aaStore: args.aaStore } : {}),
    });
    return { entry: result.entry!, attached: true };
  }
  return { entry: await saveRecoveryMetadata(review.metadata, store), attached: false };
}

/**
 * Restore without a record: the engine's findKernelAccountsByOwner over the
 * last `lookbackBlocks` blocks (OwnerRegistered logs naming `owner`, each
 * candidate verified with verifyKernelAccountForOwner because anyone can
 * emit such logs).
 */
export async function searchOwnedKernelAccounts(
  node: JsonRpcTransport,
  owner: string,
  lookbackBlocks = 9_000,
): Promise<{ verified: string[]; rejected: KernelAccountOwnershipCheck[] }> {
  const latest = BigInt((await node('eth_blockNumber', [])) as string);
  const lookback = BigInt(lookbackBlocks);
  return findKernelAccountsByOwner(node, owner, { fromBlock: latest > lookback ? latest - lookback : 0n, toBlock: latest });
}


// ---------------------------------------------------------------------------
// Owner rotation ("Change owner"): the owner hands the account to another of
// this wallet's keys
// ---------------------------------------------------------------------------
//
// The script-only flow of scripts/testnet/kernel-rotate-owner.mjs, in the
// app. The CURRENT owner (the active account, through signWith after the
// biometric gate) signs one root operation from the account that runs the
// engine's ownerRotationCalls — ECDSAValidator.onUninstall("") then
// onInstall(bytes20 newOwner), the same two calls RecoveryAction makes, proven
// live on Sepolia by the engine's recovery smoke — optionally followed by the
// engine's guardianUninstallCalls (the script's REMOVE_GUARDIANS option).
//
// The new owner is ALWAYS the EVM key of one of this wallet's own accounts
// (m/44'/60'/0'/0/N): handing the account to a key the wallet does not hold
// would lose it, and the point of the flow (typically after a guardian
// recovery) is to make the account usable from an account of this seed.
//
// Recording: the owner change cannot be written before submission (the engine
// requires a transaction or UserOperation hash on every owner change), so it is
// written the moment the bundler accepts the operation, with the userOpHash
// and no transaction hash; that "pending" tail is completed (transaction hash,
// block) or undone once the chain answers (finalizeOwnerRotation, which is
// idempotent and is also offered for rotations interrupted by an app restart:
// listPendingOwnerRotations). The aa.ts attachment moves only after the
// engine's verifyKernelAccountForOwner confirmed the new owner on-chain.

/** One of this wallet's accounts as an owner candidate (EVM key m/44'/60'/0'/0/index). */
export interface WalletOwnerAccount {
  index: number;
  name: string;
  address: string;
  /** BIP-32 path of the EVM key, recorded in the owner history. */
  path: string;
}

/**
 * BIP-32 path of an account's EVM key: m/44'/60'/0'/0/N (accounts.ts
 * derivationArgsFor maps EVM account N to account 0, address index N, the
 * MetaMask convention; ADR D8). check-recovery.mjs pins it to the core
 * evmKeyProvider's own path.
 */
export function evmAccountPath(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error(`Invalid account index ${String(index)}.`);
  return `m/44'/60'/0'/0/${index}`;
}

export const OWNER_ROTATION_EXPLANATION: readonly string[] = [
  'This changes the key that signs for this smart account (its owner). The account keeps the same ' +
    'address, balance, tokens and history; only the key that controls it changes.',
  'The new owner can only be one of this wallet’s own accounts, so this wallet keeps control. After the ' +
    'change, switch to that account to use the smart account.',
  'Guardians stay exactly as they are unless you also choose to remove them below.',
];

export const OWNER_ROTATION_OLD_KEY_WARNING =
  'The current owner key stops working for this account immediately: once the change is included, ' +
  'operations signed by it are refused. Nobody can undo this except the new owner (by changing the ' +
  'owner again) or enough guardians (by a recovery).';

export const OWNER_ROTATION_SIMPLE_REFUSAL =
  'Changing the owner needs a Kernel v3.3 account: this network’s smart-account type is SimpleAccount, ' +
  'which has no owner validator to change.';

export const OWNER_ROTATION_7702_REFUSAL =
  'This account is an EIP-7702-upgraded address: its key is the address itself and cannot be replaced. ' +
  'Only a Kernel smart account (a separate contract address) can change its owner.';

export const OWNER_ROTATION_UNDEPLOYED_REFUSAL =
  'Your Kernel smart account is not deployed yet, so it has no owner on-chain to change. Send one ' +
  'smart-account transaction first (it deploys the account).';

export const OWNER_ROTATION_NOT_OWNER_REFUSAL =
  'This wallet’s active account is not the current owner of that Kernel account, so it cannot change ' +
  'its owner. Switch to the account that owns it.';

export const OWNER_ROTATION_SAME_OWNER =
  'That account is already the owner. Choose a different account as the new owner.';

export const OWNER_ROTATION_FOREIGN_TARGET =
  'Only one of this wallet’s own accounts can become the new owner: the wallet must hold the new key, ' +
  'or the smart account would be lost. Nothing was signed.';

export const OWNER_ROTATION_GUARDIAN_TARGET =
  'That account is one of this account’s guardians. A guardian cannot also be the owner (it would hold ' +
  'a vote over its own replacement). Remove it from the guardians first, or choose another account.';

export const OWNER_ROTATION_7702_TARGET =
  'That account is upgraded with EIP-7702 on this network, so its smart-account sends use its own ' +
  'address and could not use this account. Choose another account, or revoke its upgrade first.';

export const OWNER_ROTATION_NO_RECORD =
  'This account has no recovery record on this device, so nothing was signed: after the change the ' +
  'address can no longer be found from the new owner’s key alone, and the record is what keeps it ' +
  'findable. A recovered account needs its record first (Recover an account with guardians → paste its ' +
  'record, or its address and original owner).';

export const OWNER_ROTATION_RECORD_STALE =
  'The recovery record on this device does not list the current on-chain owner as the latest owner, so ' +
  'the owner history would be wrong. Update the record (import a current backup) first. Nothing was signed.';

export const OWNER_ROTATION_NO_GUARDIANS =
  'There are no guardians installed on this account, so there is nothing to remove.';

/**
 * Local refusals for a chosen new owner (no network requests): it must be
 * one of this wallet's accounts, differ from the current owner, not be a
 * guardian, not be an EIP-7702-upgraded owner on this chain, and not already
 * use a different recovered account (aa.ts keeps one smart account per owner
 * and chain). Null when acceptable.
 */
export function checkOwnerRotationTarget(args: {
  /** Null before the account is known: the account-specific checks are skipped. */
  account: string | null;
  currentOwner: string;
  newOwner: string;
  walletOwners: readonly WalletOwnerAccount[];
  guardians: readonly KernelGuardian[] | null;
  config: AaChainConfig;
}): string | null {
  if (!ADDRESS.test(args.newOwner)) return `Not an EVM address: ${args.newOwner}`;
  if (!args.walletOwners.some((w) => same(w.address, args.newOwner))) return OWNER_ROTATION_FOREIGN_TARGET;
  if (same(args.newOwner, args.currentOwner)) return OWNER_ROTATION_SAME_OWNER;
  if (args.account !== null && same(args.newOwner, args.account)) return OWNER_ROTATION_FOREIGN_TARGET;
  if ((args.guardians ?? []).some((g) => same(g.address, args.newOwner))) return OWNER_ROTATION_GUARDIAN_TARGET;
  if (isEip7702Owner(args.config, args.newOwner)) return OWNER_ROTATION_7702_TARGET;
  const linked = recoveredAccountFor(args.config, args.newOwner);
  if (linked !== null && (args.account === null || !same(linked, args.account))) return ROTATION_TARGET_HAS_OTHER_ACCOUNT;
  return null;
}

/**
 * Whether the new owner needs an aa.ts attachment to use the account: false
 * only when the chain's configured Kernel factory would derive exactly this
 * address for the new owner at its own account index (for example when the
 * owner is rotated back to the account's original owner), true otherwise.
 * Also returns the new owner's OWN factory smart-account address, which the
 * attachment hides from smart-account sends while it is in place.
 */
export function ownerRotationAttachment(args: {
  account: string;
  newOwner: WalletOwnerAccount;
  metadata: KernelRecoveryMetadata;
  config: AaChainConfig;
}): { attach: boolean; newOwnerOwnSmartAccount: string | null } {
  const d = args.metadata.deployment;
  const kernelFactory = args.config.accountType === 'kernel-v3.3' && args.config.factory !== null ? args.config.factory : null;
  if (kernelFactory === null) return { attach: true, newOwnerOwnSmartAccount: null };
  const own = predictKernelAddress(args.newOwner.address, {
    index: BigInt(args.newOwner.index),
    factory: kernelFactory,
    implementation: d.implementation,
    ecdsaValidator: d.ecdsaValidator,
  });
  if (same(own, args.account)) return { attach: false, newOwnerOwnSmartAccount: null };
  return { attach: true, newOwnerOwnSmartAccount: own };
}

export type OwnerRotationResolution =
  | { ok: true; account: string; kind: 'factory' | 'recovered'; owner: string; state: KernelGuardianState }
  | { ok: false; reason: string };

/**
 * Eligibility for "Change owner": the same on-chain checks as the Guardians
 * screen (resolveGuardianAccount: chain id, a deployed Kernel v3.3 proxy with
 * the ECDSA root validator, owned by `ownerAddress`; refuses SimpleAccount,
 * EIP-7702 upgrades, undeployed and foreign-owned accounts), with the refusal
 * texts worded for an owner change. Read-only.
 */
export async function resolveOwnerRotationAccount(
  bundle: AaClientBundle,
  ownerAddress: string,
): Promise<OwnerRotationResolution> {
  const r = await resolveGuardianAccount(bundle, ownerAddress);
  if (r.ok) return r;
  const translated: Record<string, string> = {
    [GUARDIAN_SIMPLE_REFUSAL]: OWNER_ROTATION_SIMPLE_REFUSAL,
    [GUARDIAN_7702_REFUSAL]: OWNER_ROTATION_7702_REFUSAL,
    [GUARDIAN_UNDEPLOYED_REFUSAL]: OWNER_ROTATION_UNDEPLOYED_REFUSAL,
    [GUARDIAN_NOT_OWNER_REFUSAL]: OWNER_ROTATION_NOT_OWNER_REFUSAL,
  };
  return { ok: false, reason: translated[r.reason] ?? r.reason };
}

export interface OwnerRotationQuote {
  account: string;
  kind: 'factory' | 'recovered';
  /** The current owner EOA (the active account): it signs. */
  currentOwner: string;
  newOwner: WalletOwnerAccount;
  removeGuardians: boolean;
  /** The guardian set on-chain when quoted (null when none). */
  guardians: KernelGuardianSet | null;
  /** The exact calls (engine ownerRotationCalls, then guardianUninstallCalls when removing). */
  calls: Call[];
  quote: AaSendQuote;
  /** True when the new owner needs an aa.ts attachment to use the account. */
  attach: boolean;
  /** The new owner's own factory smart account, hidden from its sends while attached. */
  newOwnerOwnSmartAccount: string | null;
}

/**
 * Quotes the owner change as ONE root-signed operation. Order: local target
 * checks (no network request), then the on-chain eligibility, the recovery
 * record (started for a factory account like the Guardians screen does;
 * required for a recovered one; its latest owner must be the on-chain owner),
 * the on-chain guardian check, the engine's ownerRotationCalls (which refuses
 * the zero address, the account itself and guardians again), the optional
 * guardian removal, and finally the bundler estimate (prepareAaCalls) as the
 * pre-flight gate. Signs nothing.
 */
export async function prepareOwnerRotationQuote(
  bundle: AaClientBundle,
  args: {
    ownerAddress: string;
    /** The active account's index and EVM path (to start a factory account's record). */
    ownerIndex: number;
    ownerPath: string | null;
    newOwner: WalletOwnerAccount;
    walletOwners: readonly WalletOwnerAccount[];
    removeGuardians: boolean;
    chain: string;
    config: AaChainConfig;
    store?: KeyValueStore;
  },
): Promise<OwnerRotationQuote> {
  // Mainnet readiness (config/readiness.ts): refused before any request
  // where owner changes are not allowed.
  assertFeatureAllowed('owner-rotation', args.chain);
  assertFeatureAllowed('owner-rotation', eip155Caip2(bundle.chainId));
  const store = args.store ?? AsyncStorage;
  if (!args.walletOwners.some((w) => same(w.address, args.newOwner.address))) throw new Error(OWNER_ROTATION_FOREIGN_TARGET);
  if (same(args.newOwner.address, args.ownerAddress)) throw new Error(OWNER_ROTATION_SAME_OWNER);
  const early = checkOwnerRotationTarget({
    account: null,
    currentOwner: args.ownerAddress,
    newOwner: args.newOwner.address,
    walletOwners: args.walletOwners,
    guardians: null,
    config: args.config,
  });
  // The account is not known yet: only the account-independent refusals
  // apply here (a link to another account is re-checked below).
  if (early !== null && early !== ROTATION_TARGET_HAS_OTHER_ACCOUNT) throw new Error(early);
  const resolution = await resolveOwnerRotationAccount(bundle, args.ownerAddress);
  if (!resolution.ok) throw new Error(resolution.reason);
  const { account, state } = resolution;
  let entry: RecoveryRecordEntry | null;
  if (resolution.kind === 'factory') {
    if (!bundle.kernel) throw new Error('The Kernel configuration is incomplete. Check Settings → Account Abstraction.');
    entry = (
      await ensureFactoryKernelRecord({
        chain: args.chain,
        account,
        accountIndex: args.ownerIndex,
        owner: args.ownerAddress,
        ownerPath: args.ownerPath,
        factory: bundle.factory,
        implementation: bundle.kernel.implementation,
        ecdsaValidator: bundle.kernel.ecdsaValidator,
        store,
      })
    ).entry;
  } else {
    entry = await getRecoveryRecord(args.chain, account, store);
  }
  if (!entry) throw new Error(OWNER_ROTATION_NO_RECORD);
  if (!same(currentOwnerOf(entry.metadata), resolution.owner)) throw new Error(OWNER_ROTATION_RECORD_STALE);
  const refusal = checkOwnerRotationTarget({
    account,
    currentOwner: resolution.owner,
    newOwner: args.newOwner.address,
    walletOwners: args.walletOwners,
    guardians: state.set?.guardians ?? null,
    config: args.config,
  });
  if (refusal !== null) throw new Error(refusal);
  const calls: Call[] = [
    ...ownerRotationCalls(args.newOwner.address, {
      account,
      ecdsaValidator: entry.metadata.deployment.ecdsaValidator,
      guardians: state.set?.guardians,
    }),
  ];
  const guardiansPresent = state.validationInstalled || state.validatorInitialized || state.recoveryRouted;
  if (args.removeGuardians) {
    if (!guardiansPresent) throw new Error(OWNER_ROTATION_NO_GUARDIANS);
    calls.push(...guardianUninstallCalls(account));
  }
  const { attach, newOwnerOwnSmartAccount } = ownerRotationAttachment({
    account,
    newOwner: args.newOwner,
    metadata: entry.metadata,
    config: args.config,
  });
  const quote = await quoteRootOperation(bundle, args.ownerAddress, account, calls);
  return {
    account,
    kind: resolution.kind,
    currentOwner: checksum(resolution.owner),
    newOwner: { ...args.newOwner, address: checksum(args.newOwner.address) },
    removeGuardians: args.removeGuardians,
    guardians: state.set,
    calls,
    quote,
    attach,
    newOwnerOwnSmartAccount,
  };
}

/** The record with the owner change appended (and the guardians cleared when they are removed too). */
function recordWithRotation(
  meta: KernelRecoveryMetadata,
  rotation: Pick<OwnerRotationQuote, 'newOwner' | 'removeGuardians'>,
  hashes: { txHash: string | null; userOpHash: string | null; blockNumber: string | null },
  recordedAt: number,
): KernelRecoveryMetadata {
  const base = rotation.removeGuardians ? recordGuardians(meta, null) : meta;
  return recordOwnerChange(base, {
    owner: checksum(rotation.newOwner.address),
    source: 'owner-rotation',
    txHash: hashes.txHash,
    userOpHash: hashes.userOpHash,
    blockNumber: hashes.blockNumber,
    derivationPath: BIP32_PATH.test(rotation.newOwner.path) ? rotation.newOwner.path : null,
    recordedAt,
  });
}

/**
 * Submits a quoted owner change (owner-signed through `submit`; in the app:
 * biometric gate → signWith(current owner) → sendAa). The quoted calls must
 * be exactly the rotation's and the record's latest owner must still be the
 * current owner, else nothing is signed. When the bundler accepts, the record
 * immediately gets the owner change with the userOpHash (no transaction hash
 * yet: the pending tail finalizeOwnerRotation completes or undoes). A failure
 * to save the record after acceptance is returned, not thrown, because the
 * operation is already on its way.
 */
export async function submitOwnerRotation(args: {
  rotation: OwnerRotationQuote;
  chain: string;
  store?: KeyValueStore;
  submit: (quote: AaSendQuote) => Promise<{ userOpHash: string }>;
  now?: number;
}): Promise<{ userOpHash: string; previous: KernelRecoveryMetadata; entry: RecoveryRecordEntry | null; recordError: string | null }> {
  // Mainnet readiness: checked again before anything is stored or signed.
  assertFeatureAllowed('owner-rotation', args.chain);
  const store = args.store ?? AsyncStorage;
  const r = args.rotation;
  if (!sameCalls(r.quote.calls, r.calls)) {
    throw new Error('The quoted operation is not the owner change it claims to be. Nothing was signed.');
  }
  const previousEntry = await getRecoveryRecord(args.chain, r.account, store);
  if (!previousEntry) throw new Error(OWNER_ROTATION_NO_RECORD);
  if (!same(currentOwnerOf(previousEntry.metadata), r.currentOwner)) throw new Error(OWNER_ROTATION_RECORD_STALE);
  const expected = [
    ...ownerRotationCalls(r.newOwner.address, {
      account: r.account,
      ecdsaValidator: previousEntry.metadata.deployment.ecdsaValidator,
      guardians: r.guardians?.guardians,
    }),
    ...(r.removeGuardians ? guardianUninstallCalls(r.account) : []),
  ];
  if (!sameCalls(r.calls, expected)) {
    throw new Error('The owner change does not match the engine’s owner-rotation calls. Nothing was signed.');
  }
  const { userOpHash } = await args.submit(r.quote);
  try {
    const next = recordWithRotation(
      previousEntry.metadata,
      r,
      { txHash: null, userOpHash: userOpHash.toLowerCase(), blockNumber: null },
      Math.floor((args.now ?? Date.now()) / 1000),
    );
    return { userOpHash, previous: previousEntry.metadata, entry: await saveRecoveryMetadata(next, store), recordError: null };
  } catch (e) {
    return { userOpHash, previous: previousEntry.metadata, entry: null, recordError: message(e) };
  }
}

export type OwnerRotationOutcome =
  /** The new owner owns the account on-chain; the attachment and the record are updated. */
  | { state: 'done'; txHash: string | null; blockNumber: string | null; recordCheck: { ok: boolean; problems: string[] } }
  /** The previous owner still owns it and the operation is not known to have failed. */
  | { state: 'pending' }
  /** The operation reverted, or the pending change was abandoned: the record is restored. */
  | { state: 'failed'; detail: string }
  /** The account is owned by neither: nothing was changed locally. */
  | { state: 'other-owner'; owner: string }
  /** The new owner owns it, but the engine's ownership check failed: nothing was attached. */
  | { state: 'unverified'; problems: string[] };

/**
 * Settles an owner change from the chain; safe to call any number of times.
 *  - New owner on-chain: verifyKernelAccountForOwner must pass; then the
 *    aa.ts attachment moves (aa.ts moveRecoveredAccountLink: the previous
 *    owner's link to this account is removed; the new owner is attached
 *    unless its own factory derivation yields the address) and the record's
 *    pending tail gets the transaction hash and block (from the receipt, else
 *    the ECDSA validator's OwnerRegistered log in recent blocks). A record
 *    whose save failed earlier gets the change appended now.
 *  - Previous owner on-chain and the receipt says the operation failed (or
 *    `abandon` is set): the pending tail is undone — the saved previous
 *    record when given, else the tail is dropped and the guardians are re-read
 *    from the chain.
 *  - Previous owner on-chain otherwise: still pending.
 */
export async function finalizeOwnerRotation(args: {
  node: JsonRpcTransport;
  chain: string;
  account: string;
  previousOwner: string;
  newOwner: WalletOwnerAccount;
  removeGuardians: boolean;
  userOpHash: string | null;
  receipt?: AaReceiptSummary | null;
  previous?: KernelRecoveryMetadata | null;
  config: AaChainConfig;
  abandon?: boolean;
  store?: KeyValueStore;
  aaStore?: KeyValueStore;
  now?: number;
}): Promise<OwnerRotationOutcome> {
  const store = args.store ?? AsyncStorage;
  const aaStore = args.aaStore ?? store;
  const reported = await new NodeClient(args.node).chainId();
  if (`eip155:${reported}` !== args.chain) throw new Error(`The RPC endpoint is chain ${reported}, not ${args.chain}. Nothing was changed.`);
  const entry = await getRecoveryRecord(args.chain, args.account, store);
  const ecdsaValidator = entry?.metadata.deployment.ecdsaValidator ?? KERNEL_V3_3.ecdsaValidator;
  const onChain = await readKernelOwner(args.node, args.account, ecdsaValidator);
  const tail = entry ? entry.metadata.owners[entry.metadata.owners.length - 1]! : null;
  const isPendingTail = (t: KernelOwnerRecord | null): boolean =>
    t !== null &&
    t.source === 'owner-rotation' &&
    t.txHash === null &&
    same(t.owner, args.newOwner.address) &&
    (args.userOpHash === null || t.userOpHash === null || t.userOpHash === args.userOpHash.toLowerCase());

  if (same(onChain.owner, args.newOwner.address)) {
    const check = await verifyKernelAccountForOwner(args.node, args.account, args.newOwner.address, {
      ...(entry ? { implementation: entry.metadata.deployment.implementation } : {}),
      ecdsaValidator,
    });
    if (!check.ok) return { state: 'unverified', problems: check.problems };
    if (args.abandon) throw new Error('The owner change is already included on-chain; it cannot be abandoned.');
    let txHash = args.receipt?.txHash ? args.receipt.txHash.toLowerCase() : null;
    let blockNumber: string | null = null;
    if (txHash) {
      const r = (await args.node('eth_getTransactionReceipt', [txHash]).catch(() => null)) as { blockNumber?: string } | null;
      if (r && typeof r.blockNumber === 'string') blockNumber = BigInt(r.blockNumber).toString(10);
    } else {
      const found = await findRecoveryTransaction(args.node, args.account, args.newOwner.address, { ecdsaValidator }).catch(() => null);
      if (found) {
        txHash = found.txHash;
        blockNumber = found.blockNumber;
      }
    }
    if (entry) {
      const meta = entry.metadata;
      if (isPendingTail(tail)) {
        if (txHash) {
          const owners = [...meta.owners.slice(0, -1), { ...tail!, txHash, blockNumber }];
          await saveRecoveryMetadata({ ...meta, owners }, store);
        }
      } else if (!same(currentOwnerOf(meta), args.newOwner.address) && (txHash || args.userOpHash)) {
        await saveRecoveryMetadata(
          recordWithRotation(
            meta,
            { newOwner: args.newOwner, removeGuardians: args.removeGuardians },
            { txHash, userOpHash: args.userOpHash ? args.userOpHash.toLowerCase() : null, blockNumber },
            Math.floor((args.now ?? Date.now()) / 1000),
          ),
          store,
        );
      }
    }
    const saved = await getRecoveryRecord(args.chain, args.account, store);
    const { attach } = saved
      ? ownerRotationAttachment({ account: args.account, newOwner: args.newOwner, metadata: saved.metadata, config: args.config })
      : { attach: true };
    await moveRecoveredAccountLink(args.chain, { account: args.account, from: args.previousOwner, to: args.newOwner.address, attach }, aaStore);
    const recordCheck = saved ? await verifyRecoveryMetadataOnChain(args.node, saved.metadata) : { ok: false, problems: ['no recovery record on this device'] };
    return { state: 'done', txHash, blockNumber, recordCheck };
  }

  if (same(onChain.owner, args.previousOwner)) {
    const failed = args.receipt?.success === false;
    if (!failed && !args.abandon) return { state: 'pending' };
    if (entry && isPendingTail(tail)) {
      if (args.previous && same(currentOwnerOf(args.previous), args.previousOwner)) {
        await saveRecoveryMetadata(args.previous, store);
      } else {
        // Without the saved previous record, drop the pending owner entry and
        // re-read the guardians from the chain (the pending change may have
        // cleared them in the record).
        await saveRecoveryMetadata({ ...entry.metadata, owners: entry.metadata.owners.slice(0, -1) }, store);
        await syncRecordGuardiansFromChain(args.node, args.chain, args.account, store);
      }
    }
    return {
      state: 'failed',
      detail: failed
        ? 'The operation was included but reverted: the owner did not change. The recovery record was restored.'
        : 'The pending owner change was forgotten on this device. The owner did not change.',
    };
  }
  return { state: 'other-owner', owner: onChain.owner };
}

/**
 * Waits for the rotation's receipt (bundler eth_getUserOperationReceipt via
 * the bundle's client), then settles it with finalizeOwnerRotation. A timeout
 * settles from the chain alone (usually "pending").
 */
export async function waitAndFinalizeOwnerRotation(args: {
  bundle: Pick<AaClientBundle, 'client' | 'node'>;
  rotation: OwnerRotationQuote;
  userOpHash: string;
  chain: string;
  previous: KernelRecoveryMetadata | null;
  config: AaChainConfig;
  store?: KeyValueStore;
  aaStore?: KeyValueStore;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<{ receipt: AaReceiptSummary | null; outcome: OwnerRotationOutcome }> {
  let receipt: AaReceiptSummary | null = null;
  try {
    const raw = await args.bundle.client.waitForReceipt(args.userOpHash, {
      timeoutMs: args.timeoutMs ?? 120_000,
      pollMs: args.pollMs ?? 3_000,
    });
    receipt = summarizeAaReceipt(raw);
  } catch {
    receipt = null;
  }
  const outcome = await finalizeOwnerRotation({
    node: args.bundle.node,
    chain: args.chain,
    account: args.rotation.account,
    previousOwner: args.rotation.currentOwner,
    newOwner: args.rotation.newOwner,
    removeGuardians: args.rotation.removeGuardians,
    userOpHash: args.userOpHash,
    receipt,
    previous: args.previous,
    config: args.config,
    ...(args.store ? { store: args.store } : {}),
    ...(args.aaStore ? { aaStore: args.aaStore } : {}),
  });
  return { receipt, outcome };
}

export interface PendingOwnerRotation {
  chain: string;
  account: string;
  previousOwner: string;
  newOwner: WalletOwnerAccount;
  userOpHash: string | null;
}

/**
 * Owner changes this device recorded but never settled (the app was closed
 * before the receipt arrived): records on `chain` whose latest owner entry is
 * an 'owner-rotation' without a transaction hash, naming one of this wallet's
 * accounts. The Change-owner screen settles them with finalizeOwnerRotation.
 */
export async function listPendingOwnerRotations(
  chain: string,
  walletOwners: readonly WalletOwnerAccount[],
  store: KeyValueStore = AsyncStorage,
): Promise<PendingOwnerRotation[]> {
  const { entries } = await loadRecoveryRecords(store);
  const out: PendingOwnerRotation[] = [];
  for (const e of entries) {
    if (e.metadata.chainId !== chain) continue;
    const owners = e.metadata.owners;
    const tail = owners[owners.length - 1]!;
    if (owners.length < 2 || tail.source !== 'owner-rotation' || tail.txHash !== null) continue;
    const newOwner = walletOwners.find((w) => same(w.address, tail.owner));
    if (!newOwner) continue;
    out.push({
      chain,
      account: e.metadata.account,
      previousOwner: owners[owners.length - 2]!.owner,
      newOwner,
      userOpHash: tail.userOpHash,
    });
  }
  return out;
}
