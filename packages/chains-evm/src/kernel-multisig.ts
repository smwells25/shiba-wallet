import { concatBytes } from '@noble/hashes/utils.js';
import { toChecksumAddress, type DerivedAccount } from '@shiba-wallet/core';
import { encodeFunctionCall, encodeSequence } from './abi.js';
import { keccak, toBytes, toHex, toWord } from './encoding.js';
import {
  KERNEL_V3_3,
  encodeKernelExecute,
  kernelProxyInitCodeHash,
  kernelValidatorId,
} from './kernel-account.js';
import {
  KERNEL_RECOVERY_MODULES,
  MAX_GUARDIAN_DELAY_SECONDS,
  callDataAndNonceHash,
  encodeGuardianSignature,
  guardianApprovalDigest,
  guardianSignatureExposure,
  guardianStubSignature,
  recoverSignerAddress,
  signGuardianApproval,
  signGuardianUserOpHash,
  sortGuardiansDescending,
  type KernelGuardianSet,
} from './kernel-recovery.js';
import type { JsonRpcTransport } from './rpc.js';
import type {
  Call,
  SmartAccountSpec,
  UserOpSigningContext,
} from './smart-account.js';
import { ENTRYPOINT_V07, computeCreate2Address, getUserOpHash } from './userop.js';

/**
 * Multi-signature (k-of-n) Kernel v3.3 accounts (feature 24), built on
 * ZeroDev's deployed WeightedECDSAValidator installed as the account's ROOT
 * validator, so EVERY operation needs a combined signer weight of at least
 * the threshold.
 *
 * WHAT THIS MODULE IS, AND IS NOT. The analysis in docs/MULTISIG.md shows
 * that the deployed validator enforces an honest k-of-n for USER OPERATIONS
 * (transactions): its validateUserOp marks each recovered signer's vote and
 * skips a signer that has already voted, so a coalition cannot reach the
 * threshold by repeating one signer. It does NOT enforce an honest k-of-n
 * for ERC-1271 MESSAGE signatures: its isValidSignatureWithSender adds a
 * signer's weight and checks the threshold BEFORE it checks the
 * strictly-descending signer order, so the final signature may repeat an
 * earlier signer. The consequence, proved in docs/MULTISIG.md, is that for
 * ANY threshold of 2 or more there is NO choice of weights that makes the
 * message check as strong as the operation check: a coalition passes the
 * message check when weight(C) + max_weight(C) >= threshold, which is always
 * reachable with one fewer signer than the operation check needs (a single
 * signer alone when its weight is at least half the threshold).
 *
 * Therefore this module builds a TRANSACTION-ONLY multisig. The spec it
 * returns deliberately does NOT implement signErc1271, so the wallet never
 * presents a multi-signature account as able to sign a login, an order or a
 * token permit: the account's on-chain isValidSignature would accept a
 * weaker set than the multisig intends, and offering it would misstate the
 * account's security. The app must disclose that a multisig account cannot
 * be used for message signing (see MULTISIG_ERC1271_REFUSAL).
 *
 * Sources (all read 2026-10-09 from the clones recorded in kernel-account.ts
 * and kernel-recovery.ts):
 *  [K] github.com/zerodevapp/kernel tag v3.3 (commit cd697c7e):
 *      src/validator/WeightedECDSAValidator.sol (validateUserOp lines
 *      189-259, the one-shot delay-0 path; isValidSignatureWithSender lines
 *      280-304; onInstall lines 85-95), src/Kernel.sol (initialize lines
 *      105-133 and changeRootValidator lines 135-155 accept any
 *      VALIDATION_TYPE_VALIDATOR as the root; validateUserOp lines 229-280),
 *      src/core/ValidationManager.sol (_validateUserOp lines 292-343,
 *      VALIDATION_TYPE_ROOT routes to the root validator with nonce key 0).
 *  [S] github.com/zerodevapp/sdk commit cd7c05b5:
 *      plugins/weighted-ecdsa/toWeightedECDSAValidatorPlugin.ts — the
 *      reference encoder for the install data (getEnableData, lines 149-165)
 *      and the operation signature (signUserOperation, lines 173-235: the
 *      first n-1 signers sign the EIP-712 Approve(callDataAndNonceHash), the
 *      last signs the EIP-191 userOpHash). The SDK's own tests install this
 *      validator as a SECONDARY ("regular") plugin
 *      (packages/test/v0.7/utils/weightedEcdsa.ts lines 49-57), not as the
 *      root; using it as the root is this wallet's construction and is the
 *      reason the bundler-acceptance question below must be settled live.
 *
 * Deployment binding: the WeightedECDSAValidator at
 * 0xeD89244160CfE273800B58b1B534031699dFeEEE is a Sourcify full match on
 * chain 1 and a runtime match on chain 11155111, and its verified source is
 * byte-identical to [K] src/validator/WeightedECDSAValidator.sol at v3.3
 * (checked 2026-10-09). It is the SAME contract the guardian recovery module
 * uses (KERNEL_RECOVERY_MODULES.weightedEcdsaValidator), which is why a
 * weighted-root account cannot ALSO install the guardian recovery of
 * kernel-recovery.ts: both would need the same validation id
 * (0x01 || validator) and Kernel keys a validation by the validator address
 * (see docs/MULTISIG.md, "Recovery and the other modules").
 *
 * UNSTAKED VALIDATOR / BUNDLER ACCEPTANCE. The validator is not staked in
 * the EntryPoint (getDepositInfo reports deposit 0, staked false on both
 * mainnet and Sepolia, checked 2026-10-09). Its validateUserOp writes to
 * storage keyed by the account as a second or third mapping key, not the
 * first, so ERC-7562 does not treat those slots as "associated with the
 * sender"; a strict bundler may reject a weighted-root operation at
 * validation. This cannot be decided from source. scripts/testnet/
 * multisig-smoke.mjs settles it on Sepolia against a real bundler; until a
 * live run confirms acceptance, treat bundler acceptance as UNVERIFIED and
 * expect that self-bundling (EntryPoint.handleOps from an EOA) may be
 * required.
 *
 * AUDIT STATUS: the deployed WeightedECDSAValidator is UNAUDITED in its
 * shipped v3 form (see the audit note in kernel-recovery.ts). A multisig
 * built on it carries the same unaudited-module condition as the other
 * smart-account features; it stays test-networks-only until the mainnet
 * conditions C1-C3 in docs/AA_FRAMEWORKS.md are met.
 */

/** The deployed weighted validator, the same contract the recovery module uses. */
export const KERNEL_MULTISIG_VALIDATOR: string = KERNEL_RECOVERY_MODULES.weightedEcdsaValidator;

/** Hard bound on the number of signers (the validator walks the whole list on-chain). */
export const MULTISIG_MAX_SIGNERS = 32;
/** uint24 bound from the validator's weight and totalWeight fields [K struct WeightedECDSAValidatorStorage]. */
const MULTISIG_MAX_WEIGHT = 0xffffff;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const SIGNER_LIST_END = '0xffffffffffffffffffffffffffffffffffffffff';

/**
 * Shown verbatim by the app wherever a multisig account might otherwise be
 * offered for message signing. Explains the deployed-contract weakness.
 */
export const MULTISIG_ERC1271_REFUSAL =
  'A multi-signature account cannot sign messages, logins or token permits in this wallet. The signer ' +
  'module it is built on checks the signature threshold before it checks the signer order, so one signer ' +
  "could satisfy the account's message check by repeating a signature. Message signing is therefore not " +
  'offered for multi-signature accounts; use a regular account for logins and permits.';

export interface MultisigSigner {
  address: string;
  /** uint24, at least 1. */
  weight: number;
}

export interface MultisigConfig {
  signers: MultisigSigner[];
  /** uint24: combined weight an operation must reach. At least 1, at most the total weight. */
  threshold: number;
  /**
   * uint48 seconds between an on-chain approval and an operation becoming
   * valid. 0 (the default, and what a plain multisig uses) means the k
   * signatures ride in one operation. A value above 0 turns the account into
   * a timelocked multisig whose two-step approve/execute flow is the same as
   * the guardian delay path; there is no separate owner, so only the signer
   * set itself can veto. The uint48 wrap described in kernel-recovery.ts
   * applies identically, which is why the bound is MAX_GUARDIAN_DELAY_SECONDS.
   */
  delaySeconds?: number;
}

/** Maps a multisig config onto the guardian-set shape the shared encoders use. */
function asGuardianSet(config: MultisigConfig): KernelGuardianSet {
  return {
    guardians: config.signers.map((s) => ({ address: s.address, weight: s.weight })),
    threshold: config.threshold,
    delaySeconds: config.delaySeconds ?? 0,
  };
}

/**
 * Local, network-free validation of a multisig signer set. Throws on the
 * first problem. The rules match the deployed validator (duplicate signers,
 * zero or list-end address, weight 0, threshold above the total weight) plus
 * the wallet policy already used for guardian sets (at most
 * MULTISIG_MAX_SIGNERS, the uint24 and delay bounds). A threshold of 1 is
 * allowed but is not a multisig (any single signer could act); the app
 * should steer users to a threshold of 2 or more.
 */
export function validateMultisigConfig(config: MultisigConfig): void {
  if (!config || !Array.isArray(config.signers) || config.signers.length === 0) {
    throw new Error('A multisig needs at least one signer');
  }
  if (config.signers.length > MULTISIG_MAX_SIGNERS) {
    throw new Error(`At most ${MULTISIG_MAX_SIGNERS} signers are supported`);
  }
  const seen = new Set<string>();
  let total = 0;
  config.signers.forEach((s, i) => {
    const where = `signers[${i}]`;
    if (typeof s?.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(s.address)) {
      throw new Error(`${where}.address is not a 20-byte hex address`);
    }
    const lower = s.address.toLowerCase();
    if (lower === ZERO_ADDRESS) throw new Error(`${where} is the zero address (the validator refuses it)`);
    if (lower === SIGNER_LIST_END) throw new Error(`${where} is 0xff…ff, the validator's list-end marker`);
    if (seen.has(lower)) throw new Error(`${where} duplicates an earlier signer (the validator refuses it)`);
    seen.add(lower);
    if (!Number.isInteger(s.weight) || s.weight < 1 || s.weight > MULTISIG_MAX_WEIGHT) {
      throw new Error(`${where}.weight must be an integer from 1 to ${MULTISIG_MAX_WEIGHT}`);
    }
    total += s.weight;
  });
  if (total > MULTISIG_MAX_WEIGHT) {
    throw new Error(`Total signer weight ${total} exceeds the validator's uint24 limit`);
  }
  if (!Number.isInteger(config.threshold) || config.threshold < 1) {
    throw new Error('threshold must be a positive integer');
  }
  if (config.threshold > total) {
    throw new Error(`threshold ${config.threshold} exceeds the total signer weight ${total}; no operation could ever pass`);
  }
  const delay = config.delaySeconds ?? 0;
  if (!Number.isInteger(delay) || delay < 0) throw new Error('delaySeconds must be a non-negative integer');
  if (delay > MAX_GUARDIAN_DELAY_SECONDS) {
    throw new Error(
      `delaySeconds must be at most ${MAX_GUARDIAN_DELAY_SECONDS}: the validator computes the waiting time as ` +
        'uint48(block.timestamp + delay), and a longer delay could wrap to a time in the past.',
    );
  }
}

export interface MultisigExposure {
  /** Fewest distinct signers an OPERATION needs (the honest k-of-n). */
  operationMinimumSigners: number;
  /**
   * Fewest distinct signers that can produce an ERC-1271 MESSAGE signature
   * the account accepts, under the deployed threshold-before-order check.
   * Always at most operationMinimumSigners, and strictly fewer for any
   * threshold of 2 or more.
   */
  messageMinimumSigners: number;
  /** True when one signer alone can produce an accepted message signature. */
  singleSignerCanSignMessages: boolean;
  /** True when message signing needs fewer signers than an operation does. */
  messageWeakerThanOperation: boolean;
}

/**
 * How many signers a multisig config really needs for an operation versus
 * for a message, under the deployed validator. Reuses the guardian exposure
 * calculator (identical maths) and relabels its fields for the multisig
 * vocabulary. For a transaction-only multisig the message figures explain
 * exactly why message signing is refused.
 */
export function multisigExposure(config: MultisigConfig): MultisigExposure {
  validateMultisigConfig(config);
  const e = guardianSignatureExposure(asGuardianSet(config));
  return {
    operationMinimumSigners: e.recoveryMinimumGuardians,
    messageMinimumSigners: e.signatureMinimumGuardians,
    singleSignerCanSignMessages: e.singleGuardianCanSign,
    messageWeakerThanOperation: e.weakerThanThreshold,
  };
}

/**
 * The validator's install data [K onInstall]: abi.encode(address[] signers,
 * uint24[] weights, uint24 threshold, uint48 delay) with signers in strictly
 * descending address order — the same bytes as the SDK's getEnableData [S].
 */
export function encodeMultisigValidatorData(config: MultisigConfig): Uint8Array {
  validateMultisigConfig(config);
  const sorted = sortGuardiansDescending(config.signers.map((s) => ({ address: s.address, weight: s.weight })));
  return encodeSequence([
    { kind: 'array', items: sorted.map((s) => ({ kind: 'address' as const, value: s.address })) },
    { kind: 'array', items: sorted.map((s) => ({ kind: 'uint256' as const, value: BigInt(s.weight) })) },
    { kind: 'uint256', value: BigInt(config.threshold) },
    { kind: 'uint256', value: BigInt(config.delaySeconds ?? 0) },
  ]);
}

export interface MultisigDeploymentOptions {
  index?: bigint | undefined;
  factory?: string | undefined;
  implementation?: string | undefined;
  metaFactory?: string | null | undefined;
  weightedValidator?: string | undefined;
}

/**
 * initialize(...) calldata that deploys a Kernel v3.3 account whose ROOT
 * validator is the weighted validator [K Kernel.initialize]. rootValidator =
 * 0x01 || validator (VALIDATION_TYPE_VALIDATOR), hook = address(0) ("no
 * hook"), validatorData = the signer set, hookData empty, initConfig empty.
 * No selector grant is needed: the root validator may call execute directly.
 */
export function encodeKernelMultisigInitialize(config: MultisigConfig, weightedValidator: string = KERNEL_MULTISIG_VALIDATOR): Uint8Array {
  return encodeFunctionCall('initialize(bytes21,address,bytes,bytes,bytes[])', [
    { kind: 'fixedBytes', value: kernelValidatorId(weightedValidator) },
    { kind: 'address', value: ZERO_ADDRESS },
    { kind: 'bytes', value: encodeMultisigValidatorData(config) },
    { kind: 'bytes', value: new Uint8Array(0) },
    { kind: 'array', items: [] },
  ]);
}

/**
 * The counterfactual (CREATE2) address of a weighted-root multisig account,
 * mirroring KernelFactory.getAddress: salt = keccak256(initData ||
 * bytes32(index)), init code = solady's ERC-1967 proxy of the implementation.
 * The address is a pure function of the signer set, the threshold, the delay
 * and the index: changing any of them changes the address.
 */
export function predictKernelMultisigAddress(config: MultisigConfig, options: MultisigDeploymentOptions = {}): string {
  const initData = encodeKernelMultisigInitialize(config, options.weightedValidator ?? KERNEL_MULTISIG_VALIDATOR);
  const salt = keccak(concatBytes(initData, toWord(options.index ?? 0n)));
  return computeCreate2Address(
    options.factory ?? KERNEL_V3_3.factory,
    salt,
    kernelProxyInitCodeHash(options.implementation ?? KERNEL_V3_3.implementation),
  );
}

/**
 * Meta-factory call that deploys the multisig account, the same shape the
 * ZeroDev SDK uses: FactoryStaker.deployWithFactory(factory, initData,
 * bytes32(index)) [K src/factory/FactoryStaker.sol]. Pass metaFactory = null
 * to call the KernelFactory directly (KernelFactory.createAccount(initData,
 * bytes32(index))); both produce the same address.
 */
export function multisigFactoryArgs(config: MultisigConfig, options: MultisigDeploymentOptions = {}): {
  factory: string;
  factoryData: Uint8Array;
} {
  const initData = encodeKernelMultisigInitialize(config, options.weightedValidator ?? KERNEL_MULTISIG_VALIDATOR);
  const kernelFactory = options.factory ?? KERNEL_V3_3.factory;
  const salt = toWord(options.index ?? 0n);
  const metaFactory = options.metaFactory === undefined ? KERNEL_V3_3.metaFactory : options.metaFactory;
  if (metaFactory === null) {
    return {
      factory: kernelFactory,
      factoryData: encodeFunctionCall('createAccount(bytes,bytes32)', [
        { kind: 'bytes', value: initData },
        { kind: 'fixedBytes', value: salt },
      ]),
    };
  }
  return {
    factory: metaFactory,
    factoryData: encodeFunctionCall('deployWithFactory(address,bytes,bytes32)', [
      { kind: 'address', value: kernelFactory },
      { kind: 'bytes', value: initData },
      { kind: 'fixedBytes', value: salt },
    ]),
  };
}

/**
 * changeRootValidator calldata that CONVERTS an existing Kernel account to a
 * multisig root [K Kernel.changeRootValidator]. The caller must be the
 * current root authority (the operation is signed by whatever validator is
 * root today). WARNING, documented in docs/MULTISIG.md: changeRootValidator
 * does NOT remove the previous root validator; it only stops being the root.
 * The old single-key validator stays installed and can still authorize
 * operations through its own nonce lane (VALIDATION_TYPE_VALIDATOR), so it is
 * a full backdoor until it is uninstalled with uninstallValidation in the
 * SAME batch. This helper returns only the changeRootValidator call; the
 * caller is responsible for also uninstalling the old root. Because getting
 * that wrong leaves a single-key backdoor on a "multisig" account, the
 * wallet's own flows deploy a fresh multisig account instead of converting.
 */
export function multisigChangeRootValidatorCall(
  account: string,
  config: MultisigConfig,
  weightedValidator: string = KERNEL_MULTISIG_VALIDATOR,
): Call {
  return {
    to: account,
    value: 0n,
    data: encodeFunctionCall('changeRootValidator(bytes21,address,bytes,bytes)', [
      { kind: 'fixedBytes', value: kernelValidatorId(weightedValidator) },
      { kind: 'address', value: ZERO_ADDRESS },
      { kind: 'bytes', value: encodeMultisigValidatorData(config) },
      { kind: 'bytes', value: new Uint8Array(0) },
    ]),
  };
}

// ---------------------------------------------------------------------------
// Off-device co-signer flow (a signing request and signature imports)
// ---------------------------------------------------------------------------

/**
 * Everything a co-signer needs to approve ONE multisig operation, JSON-safe
 * so it can be handed to the other signers (QR code, link, file). The
 * co-signers sign the EIP-712 Approve(callDataAndNonceHash); the submitter
 * signs the final EIP-191 userOpHash.
 *
 * WHAT A CO-SIGNER APPROVES, AND WHAT IT DOES NOT COVER. The Approve digest
 * commits to keccak256(sender, callData, nonce) only. It does NOT cover the
 * gas limits, the gas fees, the paymaster, or any validAfter/validUntil. A
 * co-signer therefore approves WHAT the account will do (the calls and the
 * nonce) but not what the operation will cost; the submitter alone chooses
 * the fees, gas and paymaster of the final operation. This is a property of
 * the deployed validator (its Approve type hashes only the
 * callDataAndNonceHash) and is recorded in docs/MULTISIG.md.
 */
export interface MultisigSigningRequest {
  version: 1;
  /** CAIP-2 numeric chain id as a decimal string. */
  chainId: string;
  /** The multisig account (EIP-712 verifyingContract is the validator, not this). */
  account: string;
  /** The weighted validator address. */
  weightedValidator: string;
  /** execute(...) calldata, lowercase 0x hex. */
  callData: string;
  /** The EntryPoint nonce as a decimal string. */
  nonce: string;
  /** keccak256(abi.encode(sender, callData, nonce)), lowercase 0x + 64 hex. */
  callDataAndNonceHash: string;
  /** The EIP-712 Approve digest a co-signer signs, lowercase 0x + 64 hex. */
  approvalDigest: string;
}

/** A single co-signer's approval, JSON-safe. */
export interface MultisigApproval {
  signer: string;
  /** 65-byte r||s||v signature over the request's approvalDigest, lowercase 0x hex. */
  signature: string;
}

/**
 * Builds the signing request for a set of calls at a known nonce. The
 * weighted validator is the root, so the EntryPoint nonce key is 0 and the
 * nonce here is the plain sequence number the account is at.
 */
export function buildMultisigSigningRequest(params: {
  chainId: bigint;
  account: string;
  calls: Call[];
  nonce: bigint;
  weightedValidator?: string;
}): MultisigSigningRequest {
  const weightedValidator = params.weightedValidator ?? KERNEL_MULTISIG_VALIDATOR;
  const callData = encodeKernelExecute(params.calls);
  const hash = callDataAndNonceHash(params.account, callData, params.nonce);
  const modules = { weightedEcdsaValidator: weightedValidator, recoveryAction: KERNEL_RECOVERY_MODULES.recoveryAction };
  return {
    version: 1,
    chainId: params.chainId.toString(),
    account: toChecksumAddress(toBytes(params.account)),
    weightedValidator: toChecksumAddress(toBytes(weightedValidator)),
    callData: toHex(callData),
    nonce: params.nonce.toString(),
    callDataAndNonceHash: toHex(hash),
    approvalDigest: toHex(guardianApprovalDigest(params.chainId, hash, modules)),
  };
}

/** Strictly parses an untrusted signing request, re-deriving every hash it can. */
export function parseMultisigSigningRequest(value: unknown): MultisigSigningRequest {
  if (typeof value !== 'object' || value === null) throw new Error('A multisig signing request must be an object');
  const r = value as Record<string, unknown>;
  if (r.version !== 1) throw new Error('Unsupported multisig signing request version');
  const str = (k: string): string => {
    if (typeof r[k] !== 'string' || (r[k] as string).length === 0) throw new Error(`Request field ${k} is missing`);
    return r[k] as string;
  };
  const account = str('account');
  const weightedValidator = str('weightedValidator');
  const callData = str('callData');
  for (const k of ['callData', 'callDataAndNonceHash', 'approvalDigest'] as const) {
    if (!/^0x[0-9a-f]*$/.test(str(k))) throw new Error(`Request field ${k} is not lowercase hex`);
  }
  if (!/^0x[0-9a-f]{40}$/.test(account.toLowerCase())) throw new Error('Request account is not an address');
  const chainId = BigInt(str('chainId'));
  const nonce = BigInt(str('nonce'));
  const recomputed = callDataAndNonceHash(account, toBytes(callData), nonce);
  if (toHex(recomputed).toLowerCase() !== str('callDataAndNonceHash').toLowerCase()) {
    throw new Error('Request callDataAndNonceHash does not match its sender, callData and nonce');
  }
  const modules = { weightedEcdsaValidator: weightedValidator, recoveryAction: KERNEL_RECOVERY_MODULES.recoveryAction };
  const digest = guardianApprovalDigest(chainId, recomputed, modules);
  if (toHex(digest).toLowerCase() !== str('approvalDigest').toLowerCase()) {
    throw new Error('Request approvalDigest does not match the validator domain and callDataAndNonceHash');
  }
  return {
    version: 1,
    chainId: chainId.toString(),
    account: toChecksumAddress(toBytes(account)),
    weightedValidator: toChecksumAddress(toBytes(weightedValidator)),
    callData,
    nonce: nonce.toString(),
    callDataAndNonceHash: str('callDataAndNonceHash'),
    approvalDigest: str('approvalDigest'),
  };
}

/** The approval a co-signer returns for a request. */
export function approveMultisigRequest(request: MultisigSigningRequest, signer: DerivedAccount): MultisigApproval {
  const sig = signGuardianApproval(signer, toBytes(request.approvalDigest));
  return { signer: toChecksumAddress(toBytes(signer.address)), signature: toHex(sig) };
}

/** Strictly parses an untrusted approval. */
export function parseMultisigApproval(value: unknown): MultisigApproval {
  if (typeof value !== 'object' || value === null) throw new Error('A multisig approval must be an object');
  const a = value as Record<string, unknown>;
  if (typeof a.signer !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(a.signer)) throw new Error('Approval signer is not an address');
  if (typeof a.signature !== 'string' || !/^0x[0-9a-f]{130}$/.test(a.signature)) {
    throw new Error('Approval signature is not 65 bytes of lowercase hex');
  }
  return { signer: toChecksumAddress(toBytes(a.signer)), signature: a.signature };
}

/**
 * Verifies that an approval was produced by one of the configured signers
 * for THIS request. Recovers the signer from the request's approvalDigest
 * and checks it against the config, returning the signer and its weight.
 * Throws if the recovered address is not a configured signer or does not
 * match the claimed one.
 */
export function verifyMultisigApproval(
  request: MultisigSigningRequest,
  approval: MultisigApproval,
  config: MultisigConfig,
): { address: string; weight: number } {
  validateMultisigConfig(config);
  const parsed = parseMultisigApproval(approval);
  const recovered = recoverSignerAddress(toBytes(request.approvalDigest), toBytes(parsed.signature));
  if (recovered.toLowerCase() !== parsed.signer.toLowerCase()) {
    throw new Error(`Approval signature recovers to ${recovered}, not the claimed signer ${parsed.signer}`);
  }
  const match = config.signers.find((s) => s.address.toLowerCase() === recovered.toLowerCase());
  if (!match) throw new Error(`${recovered} is not a signer of this multisig`);
  return { address: match.address, weight: match.weight };
}

// ---------------------------------------------------------------------------
// The account spec
// ---------------------------------------------------------------------------

export interface KernelMultisigSpecConfig {
  node: JsonRpcTransport;
  /** The signer set and threshold. */
  config: MultisigConfig;
  /**
   * The local signer that submits the operation. It signs the final
   * userOpHash and must be one of the configured signers; it must NOT also be
   * among `approvals`, because the validator counts each signer once.
   */
  submitter: string;
  /** Co-signer approvals over the operation's Approve digest, collected off-device. */
  approvals: MultisigApproval[];
  index?: bigint;
  factory?: string;
  implementation?: string;
  metaFactory?: string | null;
  weightedValidator?: string;
  entryPoint?: string;
}

/**
 * A SmartAccountSpec for a transaction-only k-of-n multisig, so
 * SmartAccountClient.sendCalls works unchanged:
 *   client.sendCalls(submitterSigner, calls, fees)
 * The co-signer approvals are collected beforehand (over the exact calls and
 * nonce) and passed in `approvals`. At signing time the spec re-verifies
 * every approval against the final operation, refuses if the submitter is
 * not a configured signer or is also among the approvals, and refuses if the
 * combined weight is below the threshold, so it never signs an operation
 * that would fail on-chain for a reason it could see locally.
 *
 * The spec deliberately omits signErc1271 (see MULTISIG_ERC1271_REFUSAL): a
 * multisig account does not sign messages in this wallet.
 */
export function createKernelMultisigSpec(specConfig: KernelMultisigSpecConfig): SmartAccountSpec {
  validateMultisigConfig(specConfig.config);
  const config = specConfig.config;
  const weightedValidator = specConfig.weightedValidator ?? KERNEL_MULTISIG_VALIDATOR;
  const entryPoint = specConfig.entryPoint ?? ENTRYPOINT_V07;
  const deployOptions: MultisigDeploymentOptions = {
    index: specConfig.index,
    factory: specConfig.factory,
    implementation: specConfig.implementation,
    metaFactory: specConfig.metaFactory,
    weightedValidator,
  };
  const predicted = predictKernelMultisigAddress(config, deployOptions);
  const submitterMatch = config.signers.find((s) => s.address.toLowerCase() === specConfig.submitter.toLowerCase());
  if (!submitterMatch) throw new Error('The submitter is not one of the multisig signers');
  const approvals = specConfig.approvals.map((a) => parseMultisigApproval(a));

  const requireSubmitter = (signer: DerivedAccount): void => {
    if (signer.address.toLowerCase() !== specConfig.submitter.toLowerCase()) {
      throw new Error(`This multisig operation is submitted by ${specConfig.submitter}; refusing ${signer.address}`);
    }
  };

  return {
    async getAddress(signer: DerivedAccount): Promise<string> {
      requireSubmitter(signer);
      // Cross-check the local CREATE2 prediction against the KernelFactory's
      // own getAddress view, so a dishonest RPC cannot make funds go to a
      // wrong address. getAddress lives on the KernelFactory (the CREATE2
      // deployer), not on the meta factory.
      const kernelFactory = deployOptions.factory ?? KERNEL_V3_3.factory;
      const initData = encodeKernelMultisigInitialize(config, weightedValidator);
      try {
        const result = (await specConfig.node('eth_call', [
          {
            to: kernelFactory,
            data: toHex(
              encodeFunctionCall('getAddress(bytes,bytes32)', [
                { kind: 'bytes', value: initData },
                { kind: 'fixedBytes', value: toWord(specConfig.index ?? 0n) },
              ]),
            ),
          },
          'latest',
        ])) as string;
        const reported = toChecksumAddress(toBytes(result).slice(12));
        if (reported.toLowerCase() !== predicted.toLowerCase()) {
          throw new Error(`Factory getAddress returned ${reported}, not the predicted ${predicted}`);
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes('not the predicted')) throw error;
        // A view-call failure (e.g. a chain without the factory) falls back to
        // the local prediction, which is a pure function of the inputs.
      }
      return predicted;
    },
    async getFactoryArgs(signer: DerivedAccount): Promise<{ factory: string; factoryData: Uint8Array }> {
      requireSubmitter(signer);
      return multisigFactoryArgs(config, deployOptions);
    },
    encodeCalls(calls: Call[]): Uint8Array {
      return encodeKernelExecute(calls);
    },
    signUserOpHash(signer: DerivedAccount, userOpHash: Uint8Array, context?: UserOpSigningContext): Uint8Array {
      requireSubmitter(signer);
      if (!context) throw new Error('A multisig operation is signed only with its operation, to verify the co-signer approvals');
      const op = context.userOp;
      if (context.entryPoint.toLowerCase() !== entryPoint.toLowerCase()) {
        throw new Error(`This multisig is for EntryPoint ${entryPoint}; refusing ${context.entryPoint}`);
      }
      if (op.sender.toLowerCase() !== predicted.toLowerCase()) {
        throw new Error(`This multisig account is ${predicted}; refusing sender ${op.sender}`);
      }
      if (toHex(getUserOpHash(op, context.entryPoint, context.chainId)) !== toHex(userOpHash)) {
        throw new Error('The hash to sign is not the hash of the given operation');
      }
      // Re-derive the Approve digest from the FINAL operation (its sender,
      // callData and nonce) and verify every co-signer approval against it.
      const hash = callDataAndNonceHash(op.sender, op.callData, op.nonce);
      const modules = { weightedEcdsaValidator: weightedValidator, recoveryAction: KERNEL_RECOVERY_MODULES.recoveryAction };
      const digest = guardianApprovalDigest(context.chainId, hash, modules);
      const counted = new Set<string>();
      let weight = 0;
      const sigs: Uint8Array[] = [];
      for (const approval of approvals) {
        const recovered = recoverSignerAddress(digest, toBytes(approval.signature)).toLowerCase();
        const match = config.signers.find((s) => s.address.toLowerCase() === recovered);
        if (!match) {
          throw new Error(`A co-signer approval recovers to ${recovered}, which is not a signer of this operation (stale or wrong approval)`);
        }
        if (recovered === specConfig.submitter.toLowerCase()) {
          throw new Error('The submitter must not also appear in the co-signer approvals; the validator counts each signer once');
        }
        if (counted.has(recovered)) throw new Error(`Duplicate approval from ${recovered}; the validator counts each signer once`);
        counted.add(recovered);
        weight += match.weight;
        sigs.push(toBytes(approval.signature));
      }
      weight += submitterMatch.weight;
      if (weight < config.threshold) {
        throw new Error(
          `The approvals plus the submitter reach weight ${weight}, below the threshold ${config.threshold}; collect more approvals`,
        );
      }
      return encodeGuardianSignature(sigs, signGuardianUserOpHash(signer, userOpHash));
    },
    stubSignature(): Uint8Array {
      return guardianStubSignature(approvals.map((a) => toBytes(a.signature)));
    },
    // Deliberately no signErc1271: see MULTISIG_ERC1271_REFUSAL.
  };
}
