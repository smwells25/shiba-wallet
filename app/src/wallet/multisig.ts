import AsyncStorage from '@react-native-async-storage/async-storage';
// keccak256 for approval ids: @noble/hashes, an audited dependency the app
// already uses directly in delegation.ts and walletconnect.ts.
import { keccak_256 } from '@noble/hashes/sha3.js';
import type { DerivedAccount } from '@shiba-wallet/core';
import { toChecksumAddress } from '@shiba-wallet/core';
import {
  ENTRYPOINT_V07,
  KERNEL_MULTISIG_VALIDATOR,
  KERNEL_RECOVERY_MODULES,
  KERNEL_V3_3,
  MULTISIG_ERC1271_REFUSAL,
  NodeClient,
  approveMultisigRequest,
  buildMultisigSigningRequest,
  encodeFunctionCall,
  encodeKernelExecute,
  guardianApprovalTypedData,
  kernelValidatorId,
  multisigExposure,
  parseMultisigApproval,
  parseMultisigSigningRequest,
  predictKernelMultisigAddress,
  recoverSignerAddress,
  toBytes,
  toHex,
  validateMultisigConfig,
  verifyKernelDeployment,
  verifyMultisigApproval,
  type Call,
  type JsonRpcTransport,
  type MultisigApproval,
  type MultisigConfig,
  type MultisigSigningRequest,
} from '@shiba-wallet/chains-evm';
// Explicit .ts extensions: this module is imported by scripts/check-multisig.mjs
// under Node's type stripping, which resolves relative specifiers literally.
import type { KeyValueStore } from './tokens.ts';
import { EVM_CHAIN_ID, validateRecipient } from './send.ts';
import { formatUnits } from './balances.ts';
import {
  MAX_MULTISIG_SLOT,
  defaultMultisigName,
  isMultisigAccountId,
  multisigAccountId,
} from './account-ids.ts';
import { sanitizeAccountName } from './accounts.ts';
import { QR_MAX_BYTES, extractFirstJsonObject, utf8Length } from './recovery.ts';
import {
  MULTISIG_CONFIG_BUNDLE_REFUSAL,
  checkAaQuoteBeforeApproval,
  createMultisigAaClient,
  prepareAaCalls,
  sendAa,
  type AaClientBundle,
  type AaSendQuote,
  type TransportFactory,
} from './aa.ts';
import { assertFeatureAllowed, eip155Caip2 } from '../config/readiness.ts';
import { evmProfileByCaip2 } from '../config/evm-chain.ts';

/**
 * Multi-signature accounts in the app (feature 24, phase 17 item 1), built
 * exactly per docs/MULTISIG.md section 11 on the engine groundwork of phase
 * 15 item 2 (packages/chains-evm/src/kernel-multisig.ts). Pure functions,
 * the multisig store and the screen copy, kept free of React Native so
 * scripts/check-multisig.mjs runs this exact file under Node.
 *
 * WHAT A MULTISIG IS HERE. A Kernel v3.3 account whose ROOT validator is
 * ZeroDev's deployed WeightedECDSAValidator (0xeD89…eEEE), so every
 * operation needs signer weight of at least the threshold. The signer set is
 * this wallet's ACTIVE recovery-phrase account plus 1 to 9 co-signer
 * addresses with weights. It is a TRANSACTION-ONLY multisig:
 *  - The deployed validator's ERC-1271 path checks the threshold before the
 *    signer order, so a message can be signed by fewer signers than an
 *    operation needs (docs/MULTISIG.md section 4 proves no weights fix it).
 *    The engine spec has no signErc1271; aa.ts signHashAsSmartAccount and
 *    createAaClientFromConfig refuse a multisig; nothing offers it to
 *    WalletConnect or the in-app browser.
 *  - Co-signers sign Approve(keccak(sender, callData, nonce)): the calls and
 *    the nonce, NOT the gas limits, fees, paymaster or validity window,
 *    which only the submitter's final signature covers (docs/MULTISIG.md
 *    section 5).
 *
 * DEPLOYED FRESH, NEVER CONVERTED. A multisig is always a new counterfactual
 * account. Converting an existing Kernel account with changeRootValidator
 * leaves its old single-key validator installed and usable through its own
 * nonce lane (engine multisigChangeRootValidatorCall's warning), i.e. a
 * backdoor around the co-signers. The first operation of the account carries
 * its deployment (factory + initialize with the signer set) through the
 * ordinary SmartAccountClient / sendAa path.
 *
 * CREATE2 INDEX (the "salt"; a decision, documented here and on screen). The
 * account address is a pure function of the signer set, the threshold, the
 * delay (always 0 here) and a CREATE2 index (engine
 * predictKernelMultisigAddress: salt = keccak256(initData || bytes32(index))).
 * The wallet uses index 0 unless this phone already holds a multisig with
 * the same signers and threshold on the same network, in which case it takes
 * the lowest unused index (chooseMultisigIndex). Index 0 means anyone who
 * knows the signer set and threshold can recompute the address without the
 * record; the index is in the exported record for the other cases. The
 * order in which signers are entered does not matter (the install data sorts
 * them), and the same set on another network gives the same address.
 *
 * ACCOUNT IDS. Each multisig has an id in the multi-signature range of
 * ./account-ids.ts (0xD0000000 + slot), refused by every derivation, salt,
 * vault and signing helper, so no code path can ever derive or sign with a
 * "key" for it. The store keeps a high-water mark so slots are never reused.
 *
 * STORAGE. Records are public data (addresses, weights, the index, the
 * deployment facts and the operation history with request and approval
 * ids); there is no secret anywhere in a record. Co-signer approvals of an
 * operation still being collected are kept so the user can come back later;
 * they are signatures over a public digest and become public on-chain
 * anyway when the operation is submitted.
 *
 * TEST NETWORKS ONLY. Every entry point that starts something (create,
 * import, build a request, approve as a co-signer, submit) calls
 * assertFeatureAllowed('multisig', chain) before any request (readiness row
 * 'multisig', docs/THREAT_MODEL.md F-62 / T-70 and C1).
 */

// ---------------------------------------------------------------------------
// Screen copy (pinned by scripts/check-multisig.mjs)
// ---------------------------------------------------------------------------

export const MULTISIG_TITLE = 'Multi-signature accounts';

/** The Settings section's sentence above its "Multi-signature accounts" button (for the CTO's Settings link). */
export const MULTISIG_SETTINGS_BLURB =
  'Accounts that need several signers for every operation: this wallet’s account plus co-signers on other phones. ' +
  'Transactions only: a multi-signature account never signs messages, logins or token permits. Test networks only; ' +
  'the signer module has no published audit.';

/** Why a multisig is deployed fresh (shown on the create form and the overview). */
export const MULTISIG_FRESH_DEPLOY_NOTE =
  'A multi-signature account is always a new account, deployed fresh with its signer set. This wallet never ' +
  'converts an existing account: Kernel keeps the old single-key validator installed when the root signer ' +
  'changes, so a converted account would still obey one key, a backdoor around the co-signers.';

/** What co-signers approve, and what they do not. */
export const MULTISIG_FEES_LINE =
  'Co-signers approve the calls and the nonce, not the network fee or paymaster, which the submitter sets.';

/** The audit status, shown on every multisig screen. */
export const MULTISIG_UNAUDITED_NOTE =
  'The weighted signer module and the Kernel v3.3 account it runs on have no published audit for their deployed ' +
  'versions, so this wallet offers multi-signature accounts on test networks only.';

/** Re-exported: the engine's plain reason a multisig never signs messages. */
export { MULTISIG_ERC1271_REFUSAL, MULTISIG_CONFIG_BUNDLE_REFUSAL };

/** How the account's first operation deploys it. */
export const MULTISIG_DEPLOY_NOTE =
  'Not deployed yet. The first operation deploys the account; it needs the co-signers’ approvals like every ' +
  'operation, and the account pays the network fee from its own balance, so fund the address first.';

/** Shown under a bundler error on a deploying operation. */
export const MULTISIG_FUND_AND_RETRY =
  'If the bundler refused because of the prefund or the fee, send a little more test ETH to the multisig ' +
  'address and try again. The approvals stay valid as long as no other operation used this nonce.';

/** Refusal when the active account is not a recovery-phrase account. */
export const MULTISIG_PHRASE_SIGNER_ONLY =
  'A multi-signature account is created with this wallet’s active recovery-phrase account as one of its signers. ' +
  'Switch to an account from your recovery phrase first (imported keys and watch-only addresses cannot be the ' +
  'wallet’s signer).';

/** App policy: at least two signers for every operation. */
export const MULTISIG_SINGLE_SIGNER_REFUSAL =
  'With these weights and this threshold one signer alone could send operations, which is not a multi-signature ' +
  'account. Raise the threshold or lower the heaviest weight so every operation needs at least two signers.';

/** Refusal when the wallet's own signer's approval is pasted on the submitting side. */
export const MULTISIG_SUBMITTER_APPROVAL_REFUSAL =
  'This approval is from this wallet’s own signer, which submits the operation and signs it last. The signer ' +
  'module counts each signer once, so it cannot also be a co-signer approval.';

/** The exposure line: operations versus messages (multisigExposure). */
export function multisigExposureLine(config: MultisigConfig): string {
  const e = multisigExposure(config);
  const equal = config.signers.every((s) => s.weight === config.signers[0]!.weight);
  const ops = e.operationMinimumSigners;
  const msgs = e.messageMinimumSigners;
  const lead = equal
    ? `Any ${ops} co-signer${ops === 1 ? '' : 's'} together can send an operation`
    : `Co-signers whose weights add up to ${config.threshold} (at least ${ops} of them) can send an operation`;
  return (
    `${lead}; for messages the deployed validator needs only ${msgs}, so this account must never be used to ` +
    'sign logins, orders or token permits — the wallet refuses that.'
  );
}

/** The features a multisig is refused, each with its plain reason. */
export type MultisigRefusedFeature =
  | 'guardians'
  | 'inheritance'
  | 'passkeys'
  | 'session-keys'
  | 'eip7702'
  | 'owner-rotation'
  | 'walletconnect'
  | 'browser'
  | 'message-signing';

/**
 * Which features are refused for a multisig, and why. Two kinds:
 *  - COLLISION (guardians, inheritance): impossible on a weighted root. The
 *    guardian recovery is built on the SAME WeightedECDSAValidator, and
 *    Kernel keys a validation by the module's address (validation id
 *    0x01 || validator), so the root signer set and a guardian set would be
 *    one validation id and one storage slot (docs/MULTISIG.md section 6).
 *  - NOT OFFERED (passkeys, session keys): docs/MULTISIG.md section 6 reasons
 *    they would install alongside (different validation ids) but this was
 *    never exercised, and each would let ONE key or passkey act for the
 *    account without the co-signers.
 *  - NOT APPLICABLE (EIP-7702, owner change): a multisig has no owner key.
 *  - REFUSED BY DESIGN (WalletConnect, the browser, message signing):
 *    MULTISIG_ERC1271_REFUSAL.
 */
export function multisigFeatureRefusal(feature: MultisigRefusedFeature): string {
  switch (feature) {
    case 'guardians':
      return (
        'Guardians are not available for a multi-signature account: its root signer module is the same contract ' +
        'guardian recovery uses, and the account keys a module by its address, so the signer set and a guardian ' +
        'set would collide on one validation id and one storage slot.'
      );
    case 'inheritance':
      return (
        'Inheritance is not available for a multi-signature account: it is built on the guardian module, which ' +
        'is the same contract as the account’s root signer module, so the two would collide.'
      );
    case 'passkeys':
      return (
        'A passkey signer is not offered for a multi-signature account: it would let one passkey act for the ' +
        'account without the co-signers, and adding one to a multisig root has never been tested.'
      );
    case 'session-keys':
      return (
        'Session keys are not offered for a multi-signature account: a session key would let one key act for the ' +
        'account without the co-signers, and adding one to a multisig root has never been tested.'
      );
    case 'eip7702':
      return (
        'An EIP-7702 upgrade is not applicable: it upgrades a regular account’s own address, and a ' +
        'multi-signature account is already a deployed smart account with no single owner key.'
      );
    case 'owner-rotation':
      return 'A multi-signature account has no single owner key to change; its signer set is fixed when it is deployed.';
    case 'walletconnect':
      return (
        'A multi-signature account is never offered to apps over WalletConnect: apps ask for message signatures, ' +
        'which it cannot give honestly. ' + MULTISIG_ERC1271_REFUSAL
      );
    case 'browser':
      return (
        'A multi-signature account is never connected to sites in the in-app browser: sites ask for message ' +
        'signatures, which it cannot give honestly. ' + MULTISIG_ERC1271_REFUSAL
      );
    case 'message-signing':
      return MULTISIG_ERC1271_REFUSAL;
  }
}

// ---------------------------------------------------------------------------
// Signer set: the create form's rules
// ---------------------------------------------------------------------------

/** Co-signers besides this wallet's own signer (the engine allows 32 signers; the form keeps it small). */
export const MAX_MULTISIG_COSIGNERS = 9;
/** Largest weight the form accepts (a judgement for a readable form; the module allows up to 2^24 - 1). */
export const MAX_MULTISIG_FORM_WEIGHT = 100;

export interface MultisigCosignerDraft {
  address: string;
  weight: string;
}

export interface MultisigDraft {
  /** This wallet's signer: the active recovery-phrase account's EVM address. */
  localSigner: string;
  localWeight: string;
  cosigners: MultisigCosignerDraft[];
  threshold: string;
}

/** An account of this wallet, public data only (for the "this phone holds two keys" warning). */
export interface OwnAccount {
  name: string;
  address: string;
  /** Only recovery-phrase accounts can be a multisig's local signer. */
  kind: 'phrase' | 'imported';
}

export type MultisigConfigCheck =
  | { ok: true; config: MultisigConfig; warnings: string[] }
  | { ok: false; error: string };

function parseWeight(raw: string, where: string): number | string {
  const t = raw.trim();
  if (!/^[0-9]{1,4}$/.test(t)) return `${where}: the weight must be a whole number from 1 to ${MAX_MULTISIG_FORM_WEIGHT}.`;
  const n = Number(t);
  if (n < 1 || n > MAX_MULTISIG_FORM_WEIGHT) {
    return `${where}: the weight must be a whole number from 1 to ${MAX_MULTISIG_FORM_WEIGHT}.`;
  }
  return n;
}

/**
 * Builds and checks the signer set from the create form. Every address goes
 * through the send flow's validateRecipient (EIP-55: a wrong checksum is
 * refused); the engine's validateMultisigConfig then applies the module's
 * rules; the app adds its own policy that every operation needs at least
 * two signers (MULTISIG_SINGLE_SIGNER_REFUSAL). A co-signer that is another
 * account of this wallet is allowed but warned about.
 */
export function buildMultisigConfig(draft: MultisigDraft, ownAccounts: readonly OwnAccount[] = []): MultisigConfigCheck {
  const local = validateRecipient(EVM_CHAIN_ID, draft.localSigner);
  if (!local.ok) return { ok: false, error: `This wallet’s signer: ${local.error}` };
  if (draft.cosigners.length < 1) return { ok: false, error: 'Add at least one co-signer.' };
  if (draft.cosigners.length > MAX_MULTISIG_COSIGNERS) {
    return { ok: false, error: `At most ${MAX_MULTISIG_COSIGNERS} co-signers can be added here.` };
  }
  const localWeight = parseWeight(draft.localWeight, 'This wallet’s signer');
  if (typeof localWeight === 'string') return { ok: false, error: localWeight };
  const signers = [{ address: local.normalized, weight: localWeight }];
  const warnings: string[] = [];
  const seen = new Set([local.normalized.toLowerCase()]);
  for (let i = 0; i < draft.cosigners.length; i++) {
    const where = `Co-signer ${i + 1}`;
    const c = draft.cosigners[i]!;
    if (c.address.trim() === '') return { ok: false, error: `${where}: enter the co-signer’s Ethereum address.` };
    const v = validateRecipient(EVM_CHAIN_ID, c.address);
    if (!v.ok) return { ok: false, error: `${where}: ${v.error}` };
    const lower = v.normalized.toLowerCase();
    if (lower === local.normalized.toLowerCase()) {
      return { ok: false, error: `${where} is this wallet’s own signer; a signer can appear only once.` };
    }
    if (seen.has(lower)) return { ok: false, error: `${where} repeats an earlier co-signer; a signer can appear only once.` };
    seen.add(lower);
    const w = parseWeight(c.weight, where);
    if (typeof w === 'string') return { ok: false, error: w };
    signers.push({ address: v.normalized, weight: w });
    const own = ownAccounts.find((a) => a.address.toLowerCase() === lower);
    if (own) {
      warnings.push(
        `${where} is ${own.name}, another account of this wallet: this phone would hold two of the keys, so losing ` +
          'or compromising it affects both.',
      );
    }
  }
  const t = draft.threshold.trim();
  if (!/^[0-9]{1,5}$/.test(t) || Number(t) < 1) return { ok: false, error: 'The threshold must be a whole number of at least 1.' };
  const config: MultisigConfig = { signers, threshold: Number(t), delaySeconds: 0 };
  try {
    validateMultisigConfig(config);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (multisigExposure(config).operationMinimumSigners < 2) return { ok: false, error: MULTISIG_SINGLE_SIGNER_REFUSAL };
  return { ok: true, config, warnings };
}

/** "2-of-3" for equal weights, "weight 3 of 4, 3 signers" otherwise. */
export function multisigShapeLabel(config: Pick<MultisigConfig, 'signers' | 'threshold'>): string {
  const w0 = config.signers[0]?.weight;
  if (w0 !== undefined && config.signers.every((s) => s.weight === w0)) {
    // Equal weights: the threshold in signers is ceil(threshold / weight).
    return `${Math.ceil(config.threshold / w0)}-of-${config.signers.length}`;
  }
  const total = config.signers.reduce((s, x) => s + x.weight, 0);
  return `weight ${config.threshold} of ${total}, ${config.signers.length} signers`;
}

/** "Multisig 1 (2-of-3)": how every screen names a multisig. */
export function multisigDisplayName(record: Pick<MultisigRecord, 'name' | 'signers' | 'threshold'>): string {
  return `${record.name} (${multisigShapeLabel(record)})`;
}

// ---------------------------------------------------------------------------
// Deployment facts and the counterfactual address
// ---------------------------------------------------------------------------

/** The deployment addresses every multisig of this wallet uses (the engine's pinned values). */
export interface MultisigDeployment {
  factory: string;
  implementation: string;
  metaFactory: string | null;
  weightedValidator: string;
}

export const MULTISIG_DEPLOYMENT: MultisigDeployment = {
  factory: KERNEL_V3_3.factory,
  implementation: KERNEL_V3_3.implementation,
  metaFactory: KERNEL_V3_3.metaFactory,
  weightedValidator: KERNEL_MULTISIG_VALIDATOR,
};

function sameAddress(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a.toLowerCase() === b.toLowerCase();
}

function isPinnedDeployment(d: MultisigDeployment): boolean {
  return (
    sameAddress(d.factory, MULTISIG_DEPLOYMENT.factory) &&
    sameAddress(d.implementation, MULTISIG_DEPLOYMENT.implementation) &&
    (d.metaFactory === null ? MULTISIG_DEPLOYMENT.metaFactory === null : sameAddress(d.metaFactory, MULTISIG_DEPLOYMENT.metaFactory)) &&
    sameAddress(d.weightedValidator, MULTISIG_DEPLOYMENT.weightedValidator)
  );
}

/** The counterfactual address of a signer set at an index (engine predictKernelMultisigAddress). */
export function multisigAddressFor(config: MultisigConfig, index: bigint, deployment: MultisigDeployment = MULTISIG_DEPLOYMENT): string {
  return predictKernelMultisigAddress(config, {
    index,
    factory: deployment.factory,
    implementation: deployment.implementation,
    metaFactory: deployment.metaFactory,
    weightedValidator: deployment.weightedValidator,
  });
}

/** Most indices chooseMultisigIndex tries before giving up (a phone never holds that many copies of one set). */
const MAX_INDEX_TRIES = 64;

/**
 * The CREATE2 index for a new multisig (see the file comment): 0, unless a
 * record on this phone already has the resulting address on the same
 * network, then the lowest index whose address is not taken here.
 */
export function chooseMultisigIndex(config: MultisigConfig, chain: string, records: readonly MultisigRecord[]): bigint {
  const taken = new Set(records.filter((r) => r.chain === chain).map((r) => r.address.toLowerCase()));
  for (let i = 0n; i < BigInt(MAX_INDEX_TRIES); i++) {
    if (!taken.has(multisigAddressFor(config, i).toLowerCase())) return i;
  }
  throw new Error('This phone already holds too many multisig accounts with this exact signer set on this network.');
}

// ---------------------------------------------------------------------------
// Records (AsyncStorage, secret-free)
// ---------------------------------------------------------------------------

const MULTISIG_STORE_KEY = 'shiba-wallet.multisig.v1';
const STORE_VERSION = 1;
/** Upper bound on multisig accounts listed at once. */
export const MAX_MULTISIG_ACCOUNTS = 20;
/** Operations kept per account (oldest finished ones are dropped first). */
export const MAX_MULTISIG_HISTORY = 50;

export type MultisigOperationStatus = 'collecting' | 'submitted' | 'succeeded' | 'failed' | 'abandoned';

export interface MultisigCallJson {
  to: string;
  /** Wei, decimal string. */
  value: string;
  /** Lowercase 0x hex. */
  data: string;
}

/** One operation of a multisig: its signing request, approvals and outcome. */
export interface MultisigOperationRecord {
  /** The request id: callDataAndNonceHash (what every approval is bound to). */
  requestId: string;
  nonce: string;
  createdAt: number;
  /** Plain description made by this wallet from the calls (never from a payload). */
  summary: string;
  request: MultisigSigningRequest;
  calls: MultisigCallJson[];
  /** Co-signer approvals collected so far (signatures over the public digest; no secrets). */
  approvals: MultisigApproval[];
  /** keccak256 of each approval signature, kept after the signatures are dropped. */
  approvalIds: { signer: string; approvalId: string }[];
  status: MultisigOperationStatus;
  /** True when this operation carried the account's deployment. */
  deploys: boolean;
  userOpHash?: string;
  txHash?: string;
}

export interface MultisigRecord {
  /** Account id in the multi-signature range (local to this phone; not exported). */
  id: number;
  name: string;
  /** CAIP-2 network of the record. */
  chain: string;
  /** EIP-55 multisig account address. */
  address: string;
  signers: { address: string; weight: number }[];
  threshold: number;
  delaySeconds: 0;
  /** CREATE2 index, decimal string. */
  index: string;
  deployment: MultisigDeployment;
  /** This wallet's signer (a recovery-phrase account's EVM address; one of `signers`). */
  localSigner: string;
  origin: 'created' | 'imported';
  createdAt: number;
  /** What the wallet last saw on-chain. */
  deployed: { deployed: boolean; userOpHash?: string; txHash?: string };
  operations: MultisigOperationRecord[];
}

interface StoreState {
  records: MultisigRecord[];
  nextSlot: number;
}

export function multisigConfigOf(record: Pick<MultisigRecord, 'signers' | 'threshold'>): MultisigConfig {
  return { signers: record.signers.map((s) => ({ ...s })), threshold: record.threshold, delaySeconds: 0 };
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX = /^0x[0-9a-f]*$/;
const HASH = /^0x[0-9a-f]{64}$/;

function checksum(address: string): string {
  return toChecksumAddress(toBytes(address.toLowerCase()));
}

function reviveCall(v: unknown): MultisigCallJson | null {
  if (typeof v !== 'object' || v === null) return null;
  const c = v as Record<string, unknown>;
  if (typeof c.to !== 'string' || !ADDRESS.test(c.to)) return null;
  if (typeof c.value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(c.value)) return null;
  if (typeof c.data !== 'string' || !HEX.test(c.data) || c.data.length % 2 !== 0) return null;
  return { to: checksum(c.to), value: c.value, data: c.data };
}

function callsOf(json: readonly MultisigCallJson[]): Call[] {
  return json.map((c) => ({ to: c.to, value: BigInt(c.value), data: toBytes(c.data) }));
}

function callsJson(calls: readonly Call[]): MultisigCallJson[] {
  return calls.map((c) => ({ to: checksum(c.to), value: c.value.toString(), data: toHex(c.data).toLowerCase() }));
}

function reviveOperation(v: unknown, record: Pick<MultisigRecord, 'address' | 'chain'>): MultisigOperationRecord | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  try {
    const request = parseMultisigSigningRequest(o.request);
    if (!sameAddress(request.account, record.address) || eip155Caip2(BigInt(request.chainId)) !== record.chain) return null;
    if (!Array.isArray(o.calls)) return null;
    const calls = o.calls.map(reviveCall);
    if (calls.some((c) => c === null)) return null;
    if (toHex(encodeKernelExecute(callsOf(calls as MultisigCallJson[]))).toLowerCase() !== request.callData) return null;
    const approvals = Array.isArray(o.approvals) ? o.approvals.map((a) => parseMultisigApproval(a)) : [];
    const approvalIds = Array.isArray(o.approvalIds)
      ? o.approvalIds.filter(
          (a): a is { signer: string; approvalId: string } =>
            typeof a === 'object' && a !== null && typeof (a as { signer?: unknown }).signer === 'string' &&
            ADDRESS.test((a as { signer: string }).signer) && typeof (a as { approvalId?: unknown }).approvalId === 'string' &&
            HASH.test((a as { approvalId: string }).approvalId),
        )
      : [];
    const statuses: MultisigOperationStatus[] = ['collecting', 'submitted', 'succeeded', 'failed', 'abandoned'];
    if (!statuses.includes(o.status as MultisigOperationStatus)) return null;
    return {
      requestId: request.callDataAndNonceHash,
      nonce: request.nonce,
      createdAt: typeof o.createdAt === 'number' && Number.isFinite(o.createdAt) ? o.createdAt : 0,
      summary: typeof o.summary === 'string' ? o.summary.slice(0, 500) : '',
      request,
      calls: calls as MultisigCallJson[],
      approvals,
      approvalIds,
      status: o.status as MultisigOperationStatus,
      deploys: o.deploys === true,
      ...(typeof o.userOpHash === 'string' && HASH.test(o.userOpHash) ? { userOpHash: o.userOpHash } : {}),
      ...(typeof o.txHash === 'string' && HASH.test(o.txHash) ? { txHash: o.txHash } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Rebuilds a record from stored data, or null. The address is RECOMPUTED
 * from the signer set, threshold, index and deployment facts and must equal
 * the stored one, so a tampered record can never make the wallet show or
 * use an address the signer set does not produce.
 */
function reviveRecord(v: unknown): MultisigRecord | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  try {
    if (typeof r.id !== 'number' || !isMultisigAccountId(r.id)) return null;
    if (typeof r.chain !== 'string' || !/^eip155:[1-9][0-9]*$/.test(r.chain)) return null;
    if (typeof r.address !== 'string' || !ADDRESS.test(r.address)) return null;
    if (!Array.isArray(r.signers)) return null;
    const signers = r.signers.map((s) => {
      const x = s as { address?: unknown; weight?: unknown };
      if (typeof x.address !== 'string' || !ADDRESS.test(x.address) || typeof x.weight !== 'number') throw new Error('bad signer');
      return { address: checksum(x.address), weight: x.weight };
    });
    if (typeof r.threshold !== 'number') return null;
    const config: MultisigConfig = { signers, threshold: r.threshold, delaySeconds: 0 };
    validateMultisigConfig(config);
    if (r.delaySeconds !== 0) return null;
    if (typeof r.index !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(r.index)) return null;
    const d = r.deployment as Record<string, unknown> | undefined;
    if (!d || typeof d.factory !== 'string' || typeof d.implementation !== 'string' || typeof d.weightedValidator !== 'string') return null;
    if (d.metaFactory !== null && typeof d.metaFactory !== 'string') return null;
    const deployment: MultisigDeployment = {
      factory: d.factory,
      implementation: d.implementation,
      metaFactory: d.metaFactory as string | null,
      weightedValidator: d.weightedValidator,
    };
    if (!isPinnedDeployment(deployment)) return null;
    const address = multisigAddressFor(config, BigInt(r.index), deployment);
    if (address.toLowerCase() !== r.address.toLowerCase()) return null;
    if (typeof r.localSigner !== 'string' || !signers.some((s) => sameAddress(s.address, r.localSigner as string))) return null;
    const name = typeof r.name === 'string' ? sanitizeAccountName(r.name) : null;
    const dep = (r.deployed ?? {}) as Record<string, unknown>;
    const record: MultisigRecord = {
      id: r.id,
      name: name && name.ok ? name.name : defaultMultisigName(r.id - multisigAccountId(0)),
      chain: r.chain,
      address,
      signers,
      threshold: r.threshold,
      delaySeconds: 0,
      index: r.index,
      deployment,
      localSigner: checksum(r.localSigner),
      origin: r.origin === 'imported' ? 'imported' : 'created',
      createdAt: typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) ? r.createdAt : 0,
      deployed: {
        deployed: dep.deployed === true,
        ...(typeof dep.userOpHash === 'string' && HASH.test(dep.userOpHash) ? { userOpHash: dep.userOpHash } : {}),
        ...(typeof dep.txHash === 'string' && HASH.test(dep.txHash) ? { txHash: dep.txHash } : {}),
      },
      operations: [],
    };
    const ops = Array.isArray(r.operations) ? r.operations : [];
    record.operations = ops.map((o) => reviveOperation(o, record)).filter((o): o is MultisigOperationRecord => o !== null);
    return record;
  } catch {
    return null;
  }
}

/** Thrown by every write when the stored list exists but cannot be read (nothing is overwritten). */
export const MULTISIG_STORE_DAMAGED =
  'The list of multi-signature accounts on this phone could not be read, so nothing was changed. The accounts ' +
  'themselves are on-chain; import their records again if the list stays unreadable.';

async function readStore(store: KeyValueStore): Promise<{ state: StoreState; damaged: boolean }> {
  let raw: string | null;
  try {
    raw = await store.getItem(MULTISIG_STORE_KEY);
  } catch {
    return { state: { records: [], nextSlot: 0 }, damaged: true };
  }
  if (raw === null) return { state: { records: [], nextSlot: 0 }, damaged: false };
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; records?: unknown; nextSlot?: unknown };
    if (parsed.version !== STORE_VERSION || !Array.isArray(parsed.records)) throw new Error('shape');
    const records: MultisigRecord[] = [];
    const ids = new Set<number>();
    for (const v of parsed.records) {
      const rec = reviveRecord(v);
      if (!rec || ids.has(rec.id)) continue;
      ids.add(rec.id);
      records.push(rec);
    }
    const maxSlot = records.reduce((m, r) => Math.max(m, r.id - multisigAccountId(0) + 1), 0);
    const storedNext =
      typeof parsed.nextSlot === 'number' && Number.isSafeInteger(parsed.nextSlot) && parsed.nextSlot >= 0
        ? Math.min(parsed.nextSlot, MAX_MULTISIG_SLOT + 1)
        : 0;
    return { state: { records, nextSlot: Math.max(storedNext, maxSlot) }, damaged: false };
  } catch {
    return { state: { records: [], nextSlot: 0 }, damaged: true };
  }
}

async function writeStore(state: StoreState, store: KeyValueStore): Promise<void> {
  await store.setItem(MULTISIG_STORE_KEY, JSON.stringify({ version: STORE_VERSION, nextSlot: state.nextSlot, records: state.records }));
}

async function mutate<T>(store: KeyValueStore, fn: (state: StoreState) => T): Promise<T> {
  const { state, damaged } = await readStore(store);
  if (damaged) throw new Error(MULTISIG_STORE_DAMAGED);
  const out = fn(state);
  await writeStore(state, store);
  return out;
}

/** Every multisig record (optionally of one network). Never throws: an unreadable list reads as empty. */
export async function listMultisigRecords(chain?: string, store: KeyValueStore = AsyncStorage): Promise<MultisigRecord[]> {
  const { state } = await readStore(store);
  return chain ? state.records.filter((r) => r.chain === chain) : state.records;
}

/** One record by account id, or null. */
export async function getMultisigRecord(id: number, store: KeyValueStore = AsyncStorage): Promise<MultisigRecord | null> {
  const { state } = await readStore(store);
  return state.records.find((r) => r.id === id) ?? null;
}

/** For accounts.ts reconcileMultisigAccounts (WalletContext; see the CTO note in the phase 17 report). */
export async function multisigListEntries(store: KeyValueStore = AsyncStorage): Promise<{ id: number; address: string; name: string }[] | null> {
  const { state, damaged } = await readStore(store);
  if (damaged) return null;
  return state.records.map((r) => ({ id: r.id, address: r.address, name: r.name }));
}

/** Removes every record (wallet wipe). Nothing on-chain changes. */
export async function resetMultisigRecords(store: KeyValueStore = AsyncStorage): Promise<void> {
  await store.setItem(MULTISIG_STORE_KEY, JSON.stringify({ version: STORE_VERSION, nextSlot: 0, records: [] }));
}

function duplicateRecordError(existing: MultisigRecord): string {
  return `This multisig is already in this wallet as ${multisigDisplayName(existing)} (${existing.address}).`;
}

/**
 * Network checks before a multisig is created or imported, all read-only:
 * the node answers the expected chain id, the weighted signer module has
 * code there, and the pinned Kernel v3.3 deployment verifies (engine
 * verifyKernelDeployment). Returns a list of problems (empty = fine).
 */
export async function checkMultisigNetwork(node: JsonRpcTransport, chain: string): Promise<string[]> {
  assertFeatureAllowed('multisig', chain);
  const problems: string[] = [];
  const expected = BigInt(chain.split(':')[1]!);
  const actual = await new NodeClient(node).chainId();
  if (actual !== expected) {
    return [`The network endpoint answers chain id ${actual}, not ${expected}. Check the RPC endpoint in Settings.`];
  }
  const code = (await node('eth_getCode', [MULTISIG_DEPLOYMENT.weightedValidator, 'latest'])) as string;
  if (typeof code !== 'string' || code === '0x' || code === '0x0') {
    problems.push(`The weighted signer module ${MULTISIG_DEPLOYMENT.weightedValidator} has no code on this network.`);
  }
  try {
    // Throws with a specific message on the first failed check.
    await verifyKernelDeployment(node, {
      factory: MULTISIG_DEPLOYMENT.factory,
      implementation: MULTISIG_DEPLOYMENT.implementation,
      metaFactory: MULTISIG_DEPLOYMENT.metaFactory,
    });
  } catch (e) {
    problems.push(`The Kernel v3.3 deployment did not verify on this network: ${e instanceof Error ? e.message : String(e)}`);
  }
  return problems;
}

/**
 * Creates the record of a NEW multisig (nothing is sent; the first
 * operation deploys it). Refused outside the test networks, for a
 * localSigner that is not one of the signers, and for an address already
 * held on this network.
 */
export async function createMultisigRecord(
  params: { chain: string; config: MultisigConfig; localSigner: string; name?: string | null; now?: number },
  store: KeyValueStore = AsyncStorage,
): Promise<MultisigRecord> {
  assertFeatureAllowed('multisig', params.chain);
  assertFeatureAllowed('kernel-smart-account', params.chain);
  validateMultisigConfig(params.config);
  if ((params.config.delaySeconds ?? 0) !== 0) throw new Error('This wallet creates multisig accounts without a delay.');
  if (multisigExposure(params.config).operationMinimumSigners < 2) throw new Error(MULTISIG_SINGLE_SIGNER_REFUSAL);
  if (!params.config.signers.some((s) => sameAddress(s.address, params.localSigner))) {
    throw new Error('This wallet’s signer must be one of the multisig’s signers.');
  }
  return mutate(store, (state) => {
    if (state.records.length >= MAX_MULTISIG_ACCOUNTS) {
      throw new Error(`This wallet already holds the maximum of ${MAX_MULTISIG_ACCOUNTS} multi-signature accounts.`);
    }
    if (state.nextSlot > MAX_MULTISIG_SLOT) throw new Error('No multisig slot is left in this wallet.');
    const index = chooseMultisigIndex(params.config, params.chain, state.records);
    const address = multisigAddressFor(params.config, index);
    const slot = state.nextSlot;
    let name = defaultMultisigName(slot);
    if (params.name && params.name.trim() !== '') {
      const v = sanitizeAccountName(params.name);
      if (!v.ok) throw new Error(v.error);
      name = v.name;
    }
    const record: MultisigRecord = {
      id: multisigAccountId(slot),
      name,
      chain: params.chain,
      address,
      signers: params.config.signers.map((s) => ({ address: checksum(s.address), weight: s.weight })),
      threshold: params.config.threshold,
      delaySeconds: 0,
      index: index.toString(),
      deployment: { ...MULTISIG_DEPLOYMENT },
      localSigner: checksum(params.localSigner),
      origin: 'created',
      createdAt: params.now ?? Date.now(),
      deployed: { deployed: false },
      operations: [],
    };
    state.records.push(record);
    state.nextSlot = slot + 1;
    return record;
  });
}

/** Removes a record from this phone. Nothing secret exists for it and nothing on-chain changes. */
export async function removeMultisigRecord(id: number, store: KeyValueStore = AsyncStorage): Promise<void> {
  await mutate(store, (state) => {
    const i = state.records.findIndex((r) => r.id === id);
    if (i < 0) throw new Error('This multisig is not in this wallet.');
    state.records.splice(i, 1);
  });
}

export async function renameMultisigRecord(id: number, rawName: string, store: KeyValueStore = AsyncStorage): Promise<MultisigRecord> {
  const v = sanitizeAccountName(rawName);
  if (!v.ok) throw new Error(v.error);
  return mutate(store, (state) => {
    const r = state.records.find((x) => x.id === id);
    if (!r) throw new Error('This multisig is not in this wallet.');
    r.name = v.name;
    return r;
  });
}

export const REMOVE_MULTISIG_TITLE = 'Remove this multisig from this wallet?';

export function removeMultisigMessage(record: MultisigRecord): string {
  return (
    `${multisigDisplayName(record)} (${record.address}) is removed from this phone, with its operation history. ` +
    'Nothing secret is deleted and nothing on-chain changes: the account and its funds stay where they are, ' +
    'controlled by its signers. Keep its exported record if you want to add it again later.'
  );
}

// ---------------------------------------------------------------------------
// Export / import of the account record (co-signers on other phones)
// ---------------------------------------------------------------------------

export const MULTISIG_ACCOUNT_PAYLOAD = 'shiba-wallet/multisig-account';
export const MULTISIG_REQUEST_PAYLOAD = 'shiba-wallet/multisig-signing-request';
export const MULTISIG_APPROVAL_PAYLOAD = 'shiba-wallet/multisig-approval';

/** The account facts exchanged with co-signers (no local id, name or history). */
export interface MultisigAccountFacts {
  chainId: string;
  account: string;
  signers: { address: string; weight: number }[];
  threshold: number;
  delaySeconds: 0;
  index: string;
  factory: string;
  implementation: string;
  metaFactory: string | null;
  weightedValidator: string;
}

function accountFacts(record: MultisigRecord): MultisigAccountFacts {
  return {
    chainId: record.chain.split(':')[1]!,
    account: record.address,
    signers: record.signers.map((s) => ({ ...s })),
    threshold: record.threshold,
    delaySeconds: 0,
    index: record.index,
    factory: record.deployment.factory,
    implementation: record.deployment.implementation,
    metaFactory: record.deployment.metaFactory,
    weightedValidator: record.deployment.weightedValidator,
  };
}

/**
 * Strictly checks untrusted account facts: the signer set passes the
 * engine's rules and the app's two-signer policy, the deployment addresses
 * are exactly the engine's pinned ones, and the account address is the
 * counterfactual address those facts produce. Returns the parsed facts.
 */
export function parseMultisigAccountFacts(value: unknown): { facts: MultisigAccountFacts; config: MultisigConfig; chain: string } {
  if (typeof value !== 'object' || value === null) throw new Error('The multisig account details are missing.');
  const v = value as Record<string, unknown>;
  if (typeof v.chainId !== 'string' || !/^[1-9][0-9]{0,18}$/.test(v.chainId)) throw new Error('The multisig record has no valid chain id.');
  if (typeof v.account !== 'string' || !ADDRESS.test(v.account)) throw new Error('The multisig record has no valid account address.');
  if (!Array.isArray(v.signers) || v.signers.length === 0) throw new Error('The multisig record lists no signers.');
  const signers = v.signers.map((s, i) => {
    const x = s as { address?: unknown; weight?: unknown };
    if (typeof x.address !== 'string' || !ADDRESS.test(x.address)) throw new Error(`Signer ${i + 1} is not an address.`);
    if (typeof x.weight !== 'number' || !Number.isInteger(x.weight)) throw new Error(`Signer ${i + 1} has no whole-number weight.`);
    return { address: checksum(x.address), weight: x.weight };
  });
  if (typeof v.threshold !== 'number' || !Number.isInteger(v.threshold)) throw new Error('The multisig record has no valid threshold.');
  if (v.delaySeconds !== 0) throw new Error('This wallet supports multisig accounts without a delay only.');
  if (typeof v.index !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(v.index)) throw new Error('The multisig record has no valid index.');
  const deployment: MultisigDeployment = {
    factory: String(v.factory ?? ''),
    implementation: String(v.implementation ?? ''),
    metaFactory: v.metaFactory === null ? null : String(v.metaFactory ?? ''),
    weightedValidator: String(v.weightedValidator ?? ''),
  };
  if (!isPinnedDeployment(deployment)) {
    throw new Error('This multisig uses deployment addresses this wallet does not use (factory, implementation or signer module).');
  }
  const config: MultisigConfig = { signers, threshold: v.threshold, delaySeconds: 0 };
  validateMultisigConfig(config);
  if (multisigExposure(config).operationMinimumSigners < 2) throw new Error(MULTISIG_SINGLE_SIGNER_REFUSAL);
  const predicted = multisigAddressFor(config, BigInt(v.index), deployment);
  if (predicted.toLowerCase() !== v.account.toLowerCase()) {
    throw new Error(`The account address ${v.account} is not the address of this signer set (${predicted}). Nothing was added.`);
  }
  const chain = `eip155:${v.chainId}`;
  return {
    facts: {
      chainId: v.chainId,
      account: predicted,
      signers,
      threshold: v.threshold,
      delaySeconds: 0,
      index: v.index,
      ...deployment,
    },
    config,
    chain,
  };
}

export interface MultisigAccountExport {
  json: string;
  qrValue: string | null;
  shareText: string;
}

/** The account record for co-signers on other phones: JSON, QR payload and share text. */
export function exportMultisigAccount(record: MultisigRecord): MultisigAccountExport {
  const json = JSON.stringify({ type: MULTISIG_ACCOUNT_PAYLOAD, version: 1, ...accountFacts(record) });
  const network = evmProfileByCaip2(record.chain)?.label ?? record.chain;
  return {
    json,
    qrValue: utf8Length(json) <= QR_MAX_BYTES ? json : null,
    shareText:
      'Shiba Wallet multi-signature account (contains no secrets)\n' +
      `Account: ${record.address}\nNetwork: ${network}\nSigners: ${multisigShapeLabel(record)}\n` +
      'A co-signer adds it in Shiba Wallet: Multisig → Add a multisig from a record, then pastes everything below.\n\n' +
      json,
  };
}

/** Reads an account record from pasted, scanned or file text. */
export function parseMultisigAccountImport(text: string): { facts: MultisigAccountFacts; config: MultisigConfig; chain: string } {
  const json = extractFirstJsonObject(text);
  if (json === null) throw new Error('No multisig record found in the text.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('The multisig record is not valid JSON.');
  }
  const v = parsed as { type?: unknown; version?: unknown };
  if (v?.type === MULTISIG_REQUEST_PAYLOAD) throw new Error('This is a signing request, not an account record. Open it under “Approve a request”.');
  if (v?.type === MULTISIG_APPROVAL_PAYLOAD) throw new Error('This is a co-signer’s approval, not an account record.');
  if (v?.type !== MULTISIG_ACCOUNT_PAYLOAD) throw new Error('This is not a Shiba Wallet multisig record.');
  if (v.version !== 1) throw new Error('Unsupported multisig record version.');
  return parseMultisigAccountFacts(parsed);
}

/**
 * Adds a multisig from another phone's record. This wallet must hold one of
 * its signers as a recovery-phrase account (that account becomes the local
 * signer); the network must allow multisigs; the address must not already
 * be held here on that network.
 */
export async function importMultisigRecord(
  parsed: { facts: MultisigAccountFacts; config: MultisigConfig; chain: string },
  ownAccounts: readonly OwnAccount[],
  store: KeyValueStore = AsyncStorage,
  now: number = Date.now(),
): Promise<MultisigRecord> {
  assertFeatureAllowed('multisig', parsed.chain);
  assertFeatureAllowed('kernel-smart-account', parsed.chain);
  const local = ownAccounts.find(
    (a) => a.kind === 'phrase' && parsed.config.signers.some((s) => sameAddress(s.address, a.address)),
  );
  if (!local) {
    throw new Error(
      'None of this wallet’s recovery-phrase accounts is a signer of this multisig, so it cannot approve or submit for ' +
        'it. Add the account that is a signer first, or watch the address instead (Settings → Accounts).',
    );
  }
  return mutate(store, (state) => {
    const existing = state.records.find((r) => r.chain === parsed.chain && sameAddress(r.address, parsed.facts.account));
    if (existing) throw new Error(duplicateRecordError(existing));
    if (state.records.length >= MAX_MULTISIG_ACCOUNTS) {
      throw new Error(`This wallet already holds the maximum of ${MAX_MULTISIG_ACCOUNTS} multi-signature accounts.`);
    }
    if (state.nextSlot > MAX_MULTISIG_SLOT) throw new Error('No multisig slot is left in this wallet.');
    const slot = state.nextSlot;
    const record: MultisigRecord = {
      id: multisigAccountId(slot),
      name: defaultMultisigName(slot),
      chain: parsed.chain,
      address: parsed.facts.account,
      signers: parsed.config.signers.map((s) => ({ ...s })),
      threshold: parsed.config.threshold,
      delaySeconds: 0,
      index: parsed.facts.index,
      deployment: {
        factory: parsed.facts.factory,
        implementation: parsed.facts.implementation,
        metaFactory: parsed.facts.metaFactory,
        weightedValidator: parsed.facts.weightedValidator,
      },
      localSigner: checksum(local.address),
      origin: 'imported',
      createdAt: now,
      deployed: { deployed: false },
      operations: [],
    };
    state.records.push(record);
    state.nextSlot = slot + 1;
    return record;
  });
}

// ---------------------------------------------------------------------------
// Reading the account on-chain
// ---------------------------------------------------------------------------

async function ethCallBytes(node: JsonRpcTransport, to: string, data: Uint8Array): Promise<Uint8Array> {
  const result = (await node('eth_call', [{ to, data: toHex(data) }, 'latest'])) as string;
  if (typeof result !== 'string' || !/^0x[0-9a-fA-F]*$/.test(result)) throw new Error('eth_call returned no data');
  return toBytes(result);
}

function wordAt(bytes: Uint8Array, i: number): bigint {
  let v = 0n;
  for (const b of bytes.slice(i * 32, i * 32 + 32)) v = (v << 8n) | BigInt(b);
  return v;
}

function addressAt(bytes: Uint8Array, i: number): string {
  return toChecksumAddress(bytes.slice(i * 32 + 12, i * 32 + 32));
}

const SIGNER_LIST_END = '0xffffffffffffffffffffffffffffffffffffffff';

export interface MultisigChainState {
  deployed: boolean;
  /** Present when deployed: problems found comparing the chain with the record (empty = matches). */
  problems: string[];
}

/**
 * What the chain says about a multisig: whether it is deployed, and when it
 * is, whether its root validator is the weighted module (Kernel
 * rootValidator()) and the module's stored signer set for the account
 * (weightedStorage(account) and the guardian(signer, account) list, the
 * reads of engine readGuardianState) equal the record's.
 */
export async function readMultisigOnChain(node: JsonRpcTransport, record: MultisigRecord): Promise<MultisigChainState> {
  const code = (await node('eth_getCode', [record.address, 'latest'])) as string;
  const deployed = typeof code === 'string' && code !== '0x' && code !== '0x0';
  if (!deployed) return { deployed: false, problems: [] };
  const problems: string[] = [];
  const root = await ethCallBytes(node, record.address, encodeFunctionCall('rootValidator()', []));
  const expectedRoot = toHex(kernelValidatorId(record.deployment.weightedValidator)).toLowerCase();
  if (root.length !== 32 || toHex(root.slice(0, 21)).toLowerCase() !== expectedRoot) {
    problems.push('Its root validator is not the weighted signer module.');
    return { deployed, problems };
  }
  const storage = await ethCallBytes(
    node,
    record.deployment.weightedValidator,
    encodeFunctionCall('weightedStorage(address)', [{ kind: 'address', value: record.address }]),
  );
  if (storage.length !== 128) {
    problems.push('The signer module returned an unexpected answer.');
    return { deployed, problems };
  }
  const threshold = Number(wordAt(storage, 1));
  const delay = Number(wordAt(storage, 2));
  const onChain: { address: string; weight: number }[] = [];
  let current = addressAt(storage, 3);
  for (let i = 0; current.toLowerCase() !== SIGNER_LIST_END; i++) {
    if (i > record.signers.length) {
      problems.push('The signer module lists more signers than the record.');
      return { deployed, problems };
    }
    const g = await ethCallBytes(
      node,
      record.deployment.weightedValidator,
      encodeFunctionCall('guardian(address,address)', [
        { kind: 'address', value: current },
        { kind: 'address', value: record.address },
      ]),
    );
    if (g.length !== 64) {
      problems.push('The signer module returned an unexpected answer.');
      return { deployed, problems };
    }
    onChain.push({ address: current, weight: Number(wordAt(g, 0)) });
    current = addressAt(g, 1);
  }
  const same =
    onChain.length === record.signers.length &&
    onChain.every((s) => record.signers.some((r) => sameAddress(r.address, s.address) && r.weight === s.weight));
  if (!same) problems.push('Its signers or weights on-chain differ from this wallet’s record.');
  if (threshold !== record.threshold) problems.push(`Its threshold on-chain is ${threshold}, not ${record.threshold}.`);
  if (delay !== 0) problems.push('It has a delay on-chain, which this wallet does not support.');
  return { deployed, problems };
}

/** Records that the account is deployed (after a successful deploying operation or an on-chain read). */
export async function markMultisigDeployed(
  id: number,
  facts: { userOpHash?: string; txHash?: string },
  store: KeyValueStore = AsyncStorage,
): Promise<void> {
  await mutate(store, (state) => {
    const r = state.records.find((x) => x.id === id);
    if (!r) return;
    r.deployed = {
      deployed: true,
      ...(facts.userOpHash ? { userOpHash: facts.userOpHash } : r.deployed.userOpHash ? { userOpHash: r.deployed.userOpHash } : {}),
      ...(facts.txHash ? { txHash: facts.txHash } : r.deployed.txHash ? { txHash: r.deployed.txHash } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// Describing calls (both sides show the calls in full)
// ---------------------------------------------------------------------------

/** A token the describer knows (the active network's tracked tokens). */
export interface KnownToken {
  contract: string;
  symbol: string;
  decimals: number;
}

const TRANSFER_SELECTOR = '0xa9059cbb';

/**
 * A plain sentence for one call, made by THIS wallet from the call itself
 * (never from text inside a request): a native transfer, an ERC-20
 * transfer(address,uint256) on a known or unknown token, or a contract call
 * with its selector. The screens also show the raw to, value and data.
 */
export function describeMultisigCall(call: Call, nativeSymbol: string, tokens: readonly KnownToken[] = []): string {
  const data = toHex(call.data).toLowerCase();
  // All 18 decimals and the wei figure: a tiny value must never read as "0".
  const valueText = `${formatUnits(call.value, 18, 18)} ${nativeSymbol} (${call.value.toString()} wei)`;
  if (data === '0x') return `Send ${valueText} to ${checksum(call.to)}.`;
  if (data.startsWith(TRANSFER_SELECTOR) && data.length === 2 + 8 + 128 && call.value === 0n) {
    const recipient = checksum('0x' + data.slice(10 + 24, 10 + 64));
    const amount = BigInt('0x' + data.slice(10 + 64));
    const token = tokens.find((t) => sameAddress(t.contract, call.to));
    return token
      ? `Transfer ${formatUnits(amount, token.decimals, token.decimals)} ${token.symbol} (${amount} base units) to ${recipient}, through the token contract ${checksum(call.to)}.`
      : `Transfer ${amount} base units of the token at ${checksum(call.to)} (not a token this wallet tracks on this network) to ${recipient}.`;
  }
  return (
    `Call the contract ${checksum(call.to)} with ${valueText} and ${(data.length - 2) / 2} bytes of data ` +
    `(function selector ${data.slice(0, 10)}).`
  );
}

// ---------------------------------------------------------------------------
// The submitting side: build a request, collect approvals, submit
// ---------------------------------------------------------------------------

async function readEntryPointNonce(node: JsonRpcTransport, account: string): Promise<bigint> {
  // EntryPoint.getNonce(sender, key 0): the weighted validator is the ROOT,
  // so the account uses nonce key 0 (engine buildMultisigSigningRequest).
  const out = await ethCallBytes(
    node,
    ENTRYPOINT_V07,
    encodeFunctionCall('getNonce(address,uint192)', [
      { kind: 'address', value: account },
      { kind: 'uint256', value: 0n },
    ]),
  );
  if (out.length !== 32) throw new Error('EntryPoint.getNonce returned an unexpected answer.');
  return wordAt(out, 0);
}

/**
 * Builds the signing request for `calls` from the multisig at its current
 * nonce and stores it as the account's operation being collected (an
 * earlier one still collecting is marked abandoned: only one operation at a
 * time can use a nonce). No key is read and nothing is sent. A deployed
 * account must match its record on-chain.
 */
export async function prepareMultisigRequest(
  params: { record: MultisigRecord; calls: Call[]; node: JsonRpcTransport; nativeSymbol: string; tokens?: readonly KnownToken[]; now?: number },
  store: KeyValueStore = AsyncStorage,
): Promise<MultisigOperationRecord> {
  const { record, calls, node } = params;
  assertFeatureAllowed('multisig', record.chain);
  if (calls.length === 0) throw new Error('Nothing to send: the operation has no calls.');
  const expected = BigInt(record.chain.split(':')[1]!);
  const actual = await new NodeClient(node).chainId();
  if (actual !== expected) throw new Error(`The network endpoint answers chain id ${actual}, not ${expected}. Check the RPC endpoint in Settings.`);
  const chainState = await readMultisigOnChain(node, record);
  if (chainState.problems.length > 0) {
    throw new Error(`The account on-chain does not match this wallet’s record: ${chainState.problems.join(' ')} Nothing was prepared.`);
  }
  const nonce = await readEntryPointNonce(node, record.address);
  const request = buildMultisigSigningRequest({
    chainId: expected,
    account: record.address,
    calls,
    nonce,
    weightedValidator: record.deployment.weightedValidator,
  });
  const op: MultisigOperationRecord = {
    requestId: request.callDataAndNonceHash,
    nonce: request.nonce,
    createdAt: params.now ?? Date.now(),
    summary: calls.map((c) => describeMultisigCall(c, params.nativeSymbol, params.tokens ?? [])).join(' '),
    request,
    calls: callsJson(calls),
    approvals: [],
    approvalIds: [],
    status: 'collecting',
    deploys: !chainState.deployed,
  };
  await mutate(store, (state) => {
    const r = state.records.find((x) => x.id === record.id);
    if (!r) throw new Error('This multisig is not in this wallet any more.');
    for (const o of r.operations) if (o.status === 'collecting') o.status = 'abandoned';
    r.operations.unshift(op);
    trimHistory(r);
    if (chainState.deployed) r.deployed = { ...r.deployed, deployed: true };
  });
  return op;
}

function trimHistory(r: MultisigRecord): void {
  while (r.operations.length > MAX_MULTISIG_HISTORY) {
    const i = r.operations.map((o) => o.status).lastIndexOf('abandoned');
    r.operations.splice(i >= 0 ? i : r.operations.length - 1, 1);
  }
}

/** The calls of an operation record. */
export function multisigOperationCalls(op: Pick<MultisigOperationRecord, 'calls'>): Call[] {
  return callsOf(op.calls);
}

/** The signing request as a payload for co-signers (QR / file / copy). */
export function encodeMultisigRequestPayload(record: MultisigRecord, op: MultisigOperationRecord): string {
  return JSON.stringify({
    type: MULTISIG_REQUEST_PAYLOAD,
    version: 1,
    request: op.request,
    account: accountFacts(record),
    calls: op.calls,
  });
}

/** Share text for co-signers: what is asked, the payload, and the typed data for other wallets. */
export function multisigRequestShareText(record: MultisigRecord, op: MultisigOperationRecord): string {
  const t = guardianApprovalTypedData(BigInt(op.request.chainId), op.request.callDataAndNonceHash, {
    weightedEcdsaValidator: op.request.weightedValidator,
    recoveryAction: KERNEL_RECOVERY_MODULES.recoveryAction,
  });
  const typed = JSON.stringify({
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
    domain: { name: t.domain.name, version: t.domain.version, chainId: Number(t.domain.chainId), verifyingContract: t.domain.verifyingContract },
    message: t.message,
  });
  return (
    'MULTISIG SIGNING REQUEST — Shiba Wallet\n' +
    `Account: ${record.address}\nNetwork: ${evmProfileByCaip2(record.chain)?.label ?? record.chain}\n` +
    `Nonce: ${op.nonce}\nRequest id: ${op.requestId}\n${op.summary}\n\n` +
    `${MULTISIG_FEES_LINE} Check the calls with the requester before you approve.\n\n` +
    'Shiba Wallet: Multisig → Approve a request (as a co-signer), then paste everything below.\n\n' +
    encodeMultisigRequestPayload(record, op) +
    '\n\nOther wallets: sign this EIP-712 typed data (eth_signTypedData_v4) with the co-signer address and send ' +
    'back the signature:\n' +
    typed
  );
}

/** A co-signer's approval as a payload for the submitting phone. */
export function encodeMultisigApprovalPayload(request: MultisigSigningRequest, approval: MultisigApproval): string {
  const a = parseMultisigApproval(approval);
  return JSON.stringify({
    type: MULTISIG_APPROVAL_PAYLOAD,
    version: 1,
    chainId: request.chainId,
    account: request.account,
    requestId: request.callDataAndNonceHash,
    signer: a.signer,
    signature: a.signature,
  });
}

/** keccak256 of an approval signature: the approval id kept in the history. */
export function multisigApprovalId(signature: string): string {
  return toHex(keccakBytes(toBytes(signature)));
}

function keccakBytes(data: Uint8Array): Uint8Array {
  return keccak_256(data);
}

/**
 * Reads one approval for `op` from pasted, scanned or file text: this
 * wallet's approval payload (its chain, account and request id must match
 * the operation), the engine's bare {signer, signature} JSON, or a bare
 * 65-byte signature from another wallet (its signer is recovered from the
 * request's digest). Then verifyMultisigApproval recovers the signer from
 * the request's approval digest and checks it against the signer set.
 * Refuses the wallet's own signer (it submits) and a signer already added.
 * Returns the operation with the approval added (nothing is stored here).
 */
export function addMultisigApproval(
  record: MultisigRecord,
  op: MultisigOperationRecord,
  text: string,
): { op: MultisigOperationRecord; added: { address: string; weight: number } } {
  if (op.status !== 'collecting') throw new Error('This operation is no longer collecting approvals.');
  const trimmed = text.trim();
  let approval: MultisigApproval;
  if (/^0x[0-9a-fA-F]{130}$/.test(trimmed)) {
    const signature = trimmed.toLowerCase();
    const signer = recoverSignerAddress(toBytes(op.request.approvalDigest), toBytes(signature));
    approval = { signer, signature };
  } else {
    const json = extractFirstJsonObject(trimmed);
    if (json === null) throw new Error('No approval found in the text.');
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error('The approval is not valid JSON.');
    }
    const v = parsed as Record<string, unknown>;
    if (v?.type === MULTISIG_REQUEST_PAYLOAD) throw new Error('This is a signing request, not an approval.');
    if (v?.type === MULTISIG_ACCOUNT_PAYLOAD) throw new Error('This is an account record, not an approval.');
    if (v?.type === MULTISIG_APPROVAL_PAYLOAD) {
      if (v.version !== 1) throw new Error('Unsupported approval version.');
      if (v.chainId !== op.request.chainId) throw new Error('This approval is for another network.');
      if (typeof v.account !== 'string' || !sameAddress(v.account, op.request.account)) throw new Error('This approval is for another account.');
      if (typeof v.requestId !== 'string' || v.requestId.toLowerCase() !== op.requestId.toLowerCase()) {
        throw new Error('This approval is for another request (a different call or nonce).');
      }
    }
    approval = parseMultisigApproval({ signer: v.signer, signature: typeof v.signature === 'string' ? v.signature.toLowerCase() : v.signature });
  }
  const added = verifyMultisigApproval(op.request, approval, multisigConfigOf(record));
  if (sameAddress(added.address, record.localSigner)) throw new Error(MULTISIG_SUBMITTER_APPROVAL_REFUSAL);
  if (op.approvals.some((a) => sameAddress(a.signer, added.address))) {
    throw new Error(`An approval from ${added.address} was already added.`);
  }
  const normalized = { signer: checksum(added.address), signature: approval.signature };
  return {
    op: {
      ...op,
      approvals: [...op.approvals, normalized],
      approvalIds: [...op.approvalIds, { signer: normalized.signer, approvalId: multisigApprovalId(normalized.signature) }],
    },
    added,
  };
}

/** Persists the collected approvals of an operation. */
export async function saveMultisigOperation(id: number, op: MultisigOperationRecord, store: KeyValueStore = AsyncStorage): Promise<void> {
  await mutate(store, (state) => {
    const r = state.records.find((x) => x.id === id);
    if (!r) throw new Error('This multisig is not in this wallet any more.');
    const i = r.operations.findIndex((o) => o.requestId === op.requestId);
    if (i < 0) r.operations.unshift(op);
    else r.operations[i] = op;
  });
}

export interface MultisigWeightProgress {
  /** Approvals' weight plus this wallet's signer's weight. */
  weight: number;
  threshold: number;
  localWeight: number;
  approvers: { address: string; weight: number }[];
  ready: boolean;
}

/** The weight bar's figures: the collected approvals plus this wallet's own (submitting) signer. */
export function multisigWeightProgress(record: MultisigRecord, op: Pick<MultisigOperationRecord, 'approvals'>): MultisigWeightProgress {
  const local = record.signers.find((s) => sameAddress(s.address, record.localSigner));
  const localWeight = local?.weight ?? 0;
  const approvers = op.approvals
    .map((a) => record.signers.find((s) => sameAddress(s.address, a.signer)))
    .filter((s): s is { address: string; weight: number } => s !== undefined);
  const weight = localWeight + approvers.reduce((sum, s) => sum + s.weight, 0);
  return { weight, threshold: record.threshold, localWeight, approvers, ready: weight >= record.threshold };
}

export function multisigThresholdNotReached(weight: number, threshold: number): string {
  return (
    `The approvals plus this wallet’s signer reach weight ${weight}, below the threshold ${threshold}. Collect more ` +
    'co-signer approvals first. Nothing was signed.'
  );
}

/**
 * Quotes the operation for submission: re-checks the threshold locally
 * (the spec checks again when it signs), builds the multisig bundle with
 * this wallet's signer as the submitter and the collected approvals, and
 * runs the ordinary smart-account quote (prepareAaCalls: funding checks,
 * fee floor + headroom, bundler estimate with the approvals in the stub
 * signature). The quoted calls and sender must be exactly the request's.
 */
export async function prepareMultisigSubmission(params: {
  record: MultisigRecord;
  op: MultisigOperationRecord;
  nodeUrl: string;
  bundlerUrl: string;
  transportFor?: TransportFactory;
  estimateRetries?: { attempts: number; delayMs: number };
}): Promise<{ bundle: AaClientBundle; quote: AaSendQuote }> {
  const { record, op } = params;
  assertFeatureAllowed('multisig', record.chain);
  if (op.status !== 'collecting') throw new Error('This operation was already submitted or replaced. Nothing was signed.');
  const progress = multisigWeightProgress(record, op);
  if (!progress.ready) throw new Error(multisigThresholdNotReached(progress.weight, progress.threshold));
  const bundle = createMultisigAaClient({
    nodeUrl: params.nodeUrl,
    bundlerUrl: params.bundlerUrl,
    chainId: BigInt(record.chain.split(':')[1]!),
    accountId: record.id,
    account: record.address,
    config: multisigConfigOf(record),
    index: BigInt(record.index),
    submitter: record.localSigner,
    approvals: op.approvals,
    kernel: record.deployment,
    ...(params.transportFor ? { transportFor: params.transportFor } : {}),
    ...(params.estimateRetries ? { estimateRetries: params.estimateRetries } : {}),
  });
  const quote = await prepareAaCalls(bundle, record.localSigner, multisigOperationCalls(op));
  if (!sameAddress(quote.sender, record.address)) {
    throw new Error(`The quote is for ${quote.sender}, not this multisig ${record.address}. Nothing was signed.`);
  }
  if (toHex(bundle.spec.encodeCalls(quote.calls)).toLowerCase() !== op.request.callData) {
    throw new Error('The quoted calls differ from the ones the co-signers approved. Nothing was signed.');
  }
  return { bundle, quote };
}

/** What the screen's device check and signWith look like (injected so the check script can watch the order). */
export type RequireAuth = (prompt: string) => Promise<{ ok: true } | { ok: false; message: string }>;
export type SignWith = <T>(chainId: string, expectAddress: string, fn: (account: DerivedAccount) => Promise<T>) => Promise<T>;

/** Thrown when the device check is cancelled; nothing was signed. */
export class MultisigAuthCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MultisigAuthCancelledError';
  }
}

/**
 * Submits a quoted multisig operation in the order every smart-account
 * confirm uses: the network checks of the quote first
 * (checkAaQuoteBeforeApproval: already used, fee floor), then the device
 * check (requireAuth), and only then signWith with this wallet's signer as
 * the expected address — the key exists only inside signWith — and sendAa,
 * whose spec re-verifies every approval against the final operation.
 * Marks the operation submitted with its userOpHash.
 */
export async function submitMultisigWithGate(params: {
  record: MultisigRecord;
  op: MultisigOperationRecord;
  bundle: AaClientBundle;
  quote: AaSendQuote;
  requireAuth: RequireAuth;
  signWith: SignWith;
  store?: KeyValueStore;
}): Promise<{ userOpHash: string }> {
  const { record, op, bundle, quote } = params;
  assertFeatureAllowed('multisig', record.chain);
  await checkAaQuoteBeforeApproval(bundle.bundler, quote);
  const auth = await params.requireAuth(
    `Approve submitting this multisig operation (${multisigWeightProgress(record, op).weight} of weight ${record.threshold})`,
  );
  if (!auth.ok) throw new MultisigAuthCancelledError(auth.message);
  const { userOpHash } = await params.signWith(EVM_CHAIN_ID, record.localSigner, (signer) => sendAa(bundle, signer, quote));
  await mutate(params.store ?? AsyncStorage, (state) => {
    const r = state.records.find((x) => x.id === record.id);
    const o = r?.operations.find((x) => x.requestId === op.requestId);
    if (o) {
      o.status = 'submitted';
      o.userOpHash = userOpHash;
      o.deploys = quote.deployed === false;
    }
  });
  return { userOpHash };
}

/**
 * Records an operation's outcome from its receipt; a successful deploying
 * operation also marks the account deployed. The collected signatures are
 * dropped once the operation is final (their ids stay in the history).
 */
export async function recordMultisigOutcome(
  id: number,
  requestId: string,
  outcome: { success: boolean | null; txHash: string | null },
  store: KeyValueStore = AsyncStorage,
): Promise<void> {
  await mutate(store, (state) => {
    const r = state.records.find((x) => x.id === id);
    const o = r?.operations.find((x) => x.requestId === requestId);
    if (!r || !o) return;
    if (outcome.success === null) return;
    o.status = outcome.success ? 'succeeded' : 'failed';
    if (outcome.txHash) o.txHash = outcome.txHash;
    o.approvals = [];
    if (outcome.success && o.deploys) {
      r.deployed = {
        deployed: true,
        ...(o.userOpHash ? { userOpHash: o.userOpHash } : {}),
        ...(outcome.txHash ? { txHash: outcome.txHash } : {}),
      };
    }
  });
}

// ---------------------------------------------------------------------------
// The mirror: this wallet as a co-signer of someone else's request
// ---------------------------------------------------------------------------

export interface ParsedMultisigRequest {
  request: MultisigSigningRequest;
  facts: MultisigAccountFacts;
  config: MultisigConfig;
  chain: string;
  calls: Call[];
}

/**
 * Reads a signing request from pasted, scanned or file text and verifies
 * everything it can locally: the engine re-derives the request's hashes
 * (parseMultisigSigningRequest), the account facts produce exactly the
 * request's account address with the pinned deployment and validator, and
 * the listed calls re-encode to exactly the request's callData — so the
 * calls a co-signer is shown are the calls the signature commits to.
 */
export function parseMultisigRequestPayload(text: string): ParsedMultisigRequest {
  const json = extractFirstJsonObject(text);
  if (json === null) throw new Error('No multisig signing request found in the text.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('The signing request is not valid JSON.');
  }
  const v = parsed as Record<string, unknown>;
  if (v?.type === MULTISIG_APPROVAL_PAYLOAD) throw new Error('This is a co-signer’s approval, not a signing request. Add it on the submitting phone.');
  if (v?.type === MULTISIG_ACCOUNT_PAYLOAD) throw new Error('This is an account record, not a signing request.');
  if (v?.type !== MULTISIG_REQUEST_PAYLOAD) throw new Error('This is not a Shiba Wallet multisig signing request.');
  if (v.version !== 1) throw new Error('Unsupported signing request version.');
  const request = parseMultisigSigningRequest(v.request);
  const { facts, config, chain } = parseMultisigAccountFacts(v.account);
  if (facts.chainId !== request.chainId) throw new Error('The request and its account are on different networks.');
  if (!sameAddress(facts.account, request.account)) throw new Error('The request is for a different account than its account details.');
  if (!sameAddress(facts.weightedValidator, request.weightedValidator)) throw new Error('The request names a different signer module than its account.');
  if (!Array.isArray(v.calls) || v.calls.length === 0) throw new Error('The request lists no calls.');
  const callJson = v.calls.map(reviveCall);
  if (callJson.some((c) => c === null)) throw new Error('A call in the request is malformed.');
  const calls = callsOf(callJson as MultisigCallJson[]);
  if (toHex(encodeKernelExecute(calls)).toLowerCase() !== request.callData) {
    throw new Error('The listed calls do not match the request’s call data. Nothing can be approved.');
  }
  return { request, facts, config, chain, calls };
}

export interface MultisigCosignReview extends ParsedMultisigRequest {
  /** This wallet's signer (the active account) and its weight. */
  signer: { address: string; weight: number };
  networkLabel: string;
  /** Plain sentences for each call, made by this wallet from the calls. */
  described: string[];
  exposureLine: string;
  /** The record on this phone for the same account, if any. */
  knownRecord: MultisigRecord | null;
  warnings: string[];
}

/**
 * Prepares the co-signer review of a request for the ACTIVE account. Refuses
 * a request for another network than the active one, a network where
 * multisigs are not allowed, and an active account that is not a signer
 * (naming the account of this wallet that is, if any). Never reads a key.
 */
export function reviewMultisigRequestAsCosigner(
  text: string,
  ctx: {
    activeChain: string;
    activeAddress: string | null;
    ownAccounts: readonly OwnAccount[];
    records: readonly MultisigRecord[];
    nativeSymbol: string;
    tokens?: readonly KnownToken[];
  },
): MultisigCosignReview {
  const parsed = parseMultisigRequestPayload(text);
  const network = evmProfileByCaip2(parsed.chain)?.label ?? parsed.chain;
  if (parsed.chain !== ctx.activeChain) {
    const active = evmProfileByCaip2(ctx.activeChain)?.label ?? ctx.activeChain;
    throw new Error(`This request is for ${network}, but the active network is ${active}. Switch networks first (Settings → Developer).`);
  }
  assertFeatureAllowed('multisig', parsed.chain);
  const signerEntry = ctx.activeAddress ? parsed.config.signers.find((s) => sameAddress(s.address, ctx.activeAddress)) : undefined;
  if (!signerEntry) {
    const other = ctx.ownAccounts.find((a) => parsed.config.signers.some((s) => sameAddress(s.address, a.address)));
    throw new Error(
      other
        ? `The active account is not a signer of this multisig, but ${other.name} (${other.address}) is. Switch to it on Home first.`
        : 'None of this wallet’s accounts is a signer of this multisig, so there is nothing to approve here.',
    );
  }
  const knownRecord = ctx.records.find((r) => r.chain === parsed.chain && sameAddress(r.address, parsed.request.account)) ?? null;
  const warnings: string[] = [];
  if (knownRecord) {
    const same =
      knownRecord.threshold === parsed.config.threshold &&
      knownRecord.signers.length === parsed.config.signers.length &&
      knownRecord.signers.every((s) => parsed.config.signers.some((p) => sameAddress(p.address, s.address) && p.weight === s.weight));
    if (!same) warnings.push('The signer set in this request differs from this wallet’s record of the account.');
  } else {
    warnings.push('This account is not in this wallet. Its address was checked against the signer set in the request.');
  }
  return {
    ...parsed,
    signer: { address: checksum(signerEntry.address), weight: signerEntry.weight },
    networkLabel: network,
    described: parsed.calls.map((c) => describeMultisigCall(c, ctx.nativeSymbol, ctx.tokens ?? [])),
    exposureLine: multisigExposureLine(parsed.config),
    knownRecord,
    warnings,
  };
}

/** The approval signature for a reviewed request, made with the signer signWith hands in. */
export function approveMultisigAsCosigner(review: MultisigCosignReview, signer: DerivedAccount): { approval: MultisigApproval; payload: string } {
  if (!sameAddress(signer.address, review.signer.address)) {
    throw new Error(`This approval must come from ${review.signer.address}; refusing ${signer.address}. Nothing was signed.`);
  }
  const approval = approveMultisigRequest(review.request, signer);
  // Self-check: the signature recovers to this signer and is valid for the set.
  const verified = verifyMultisigApproval(review.request, approval, review.config);
  if (!sameAddress(verified.address, review.signer.address)) throw new Error('The approval did not verify. Nothing was shared.');
  return { approval, payload: encodeMultisigApprovalPayload(review.request, approval) };
}

/**
 * The co-signer approval in the order the guardian side uses: the device
 * check first (requireAuth), then signWith with the active account as the
 * expected address — the key exists only inside signWith. A cancelled check
 * signs nothing.
 */
export async function cosignWithGate(params: {
  review: MultisigCosignReview;
  requireAuth: RequireAuth;
  signWith: SignWith;
}): Promise<{ approval: MultisigApproval; payload: string }> {
  assertFeatureAllowed('multisig', params.review.chain);
  const auth = await params.requireAuth('Approve this multisig operation as a co-signer');
  if (!auth.ok) throw new MultisigAuthCancelledError(auth.message);
  return params.signWith(EVM_CHAIN_ID, params.review.signer.address, async (signer) => approveMultisigAsCosigner(params.review, signer));
}

/** The approval payload's QR value, or null when it would not fit one code. */
export function multisigQrValue(payload: string): string | null {
  return utf8Length(payload) <= QR_MAX_BYTES ? payload : null;
}

// ---------------------------------------------------------------------------
// Files (export through the share sheet, import through the document picker)
// ---------------------------------------------------------------------------

/** Sub-directory of the app's cache directory that holds multisig export files while they are shared. */
export const MULTISIG_EXPORT_DIRECTORY = 'multisig-export';
/** Largest multisig file the import accepts (records and requests are a few kilobytes). */
export const MULTISIG_FILE_MAX_BYTES = 64 * 1024;

const FILE_CHAIN_LABELS: Readonly<Record<string, string>> = {
  'eip155:1': 'ethereum',
  'eip155:11155111': 'sepolia',
  'eip155:84532': 'base-sepolia',
  'eip155:421614': 'arbitrum-sepolia',
};

export const MULTISIG_FILE_NAME_PATTERN =
  /^shiba-multisig-(account|request|approval)_[a-z0-9-]+_0x[0-9a-fA-F]{4}-[0-9a-fA-F]{4}_[0-9]{4}-[0-9]{2}-[0-9]{2}\.json$/;

/**
 * "shiba-multisig-request_sepolia_0xD927-8c57_2026-10-10.json": kind,
 * network, the account's short form and the UTC date, the same rule as the
 * recovery-record files (recovery.ts recordExportFileName).
 */
export function multisigExportFileName(
  kind: 'account' | 'request' | 'approval',
  chain: string,
  account: string,
  date: Date = new Date(),
): string {
  const label = FILE_CHAIN_LABELS[chain] ?? chain.replace(':', '-');
  const a = checksum(account);
  const name = `shiba-multisig-${kind}_${label}_${a.slice(0, 6)}-${a.slice(-4)}_${date.toISOString().slice(0, 10)}.json`;
  if (!MULTISIG_FILE_NAME_PATTERN.test(name)) throw new Error(`Unexpected export file name ${name}`);
  return name;
}

/**
 * Checks a picked file before its text goes to the strict parsers: a .json
 * name or the application/json type, at most MULTISIG_FILE_MAX_BYTES, and
 * exactly one JSON object (an optional byte-order mark and surrounding
 * whitespace allowed). Returns the text.
 */
export function multisigFileText(
  text: string,
  info: { name?: string | null; size?: number | null; mimeType?: string | null } = {},
): string {
  const named = typeof info.name === 'string' && info.name.toLowerCase().endsWith('.json');
  const typed = typeof info.mimeType === 'string' && info.mimeType.toLowerCase().split(';')[0]!.trim() === 'application/json';
  if (!named && !typed) throw new Error('Choose a .json file exported by Shiba Wallet.');
  if ((typeof info.size === 'number' && info.size > MULTISIG_FILE_MAX_BYTES) || utf8Length(text) > MULTISIG_FILE_MAX_BYTES) {
    throw new Error(`This file is larger than ${MULTISIG_FILE_MAX_BYTES / 1024} KiB, so it is not a multisig file.`);
  }
  const body = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).trim();
  if (body === '' || extractFirstJsonObject(body) !== body) {
    throw new Error('This file must contain exactly one JSON object and nothing else.');
  }
  return body;
}
