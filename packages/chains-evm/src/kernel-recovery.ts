import { secp256k1 } from '@noble/curves/secp256k1.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { toChecksumAddress, type DerivedAccount } from '@shiba-wallet/core';
import { encodeFunctionCall, encodeSequence, selector as abiSelector } from './abi.js';
import { keccak, toBytes, toHex, toWord } from './encoding.js';
import { typedDataDigest, type TypedDataTypes } from './eip712.js';
import {
  KERNEL_V3_3,
  createKernelAccountSpec,
  encodeKernelExecute,
  kernelValidatorId,
  predictKernelAddress,
} from './kernel-account.js';
import type { JsonRpcTransport } from './rpc.js';
import {
  toEthSignedMessageHash,
  withEthereumV,
  type Call,
  type SmartAccountSignatureContext,
  type SmartAccountSpec,
} from './smart-account.js';
import { ENTRYPOINT_V07 } from './userop.js';

/**
 * Social recovery (guardians) for Kernel v3.3 accounts whose root validator
 * is the ECDSA validator owned by the seed-derived EOA.
 *
 * MECHANISM (the one ZeroDev ships for Kernel v3 on EntryPoint v0.7):
 *  - Guardians live in ZeroDev's WeightedECDSAValidator, installed on the
 *    account as a SECONDARY validator (validation id 0x01 || validator). The
 *    root validator is untouched, so the seed-derived owner keeps full
 *    control until a recovery actually happens (ADR D1 holds until then).
 *  - That validator is granted access to exactly ONE selector,
 *    doRecovery(address,bytes). The selector is routed by Kernel's selector
 *    manager to ZeroDev's RecoveryAction contract with CALLTYPE_DELEGATECALL
 *    and the "only EntryPoint" hook, so it can only run as the callData of a
 *    UserOperation.
 *  - RecoveryAction.doRecovery(validator, data) runs IN THE ACCOUNT'S CONTEXT
 *    (delegatecall) and calls validator.onUninstall("") then
 *    validator.onInstall(data). With validator = the ECDSA validator and
 *    data = the 20-byte new owner, this replaces the root owner. The ECDSA
 *    validator has no other owner setter: owner changes only through
 *    onInstall [K src/validator/ECDSAValidator.sol].
 *
 * Sources (all fetched or read 2026-10-01):
 *  [K]  github.com/zerodevapp/kernel tag v3.3, commit
 *       cd697c7e21715d015e0643af22310a99aa17433b:
 *       src/validator/WeightedECDSAValidator.sol, src/validator/ECDSAValidator.sol,
 *       src/Kernel.sol (installModule, uninstallModule, uninstallValidation,
 *       grantAccess, fallback, validateUserOp), src/core/ValidationManager.sol
 *       (_installValidation, _validateUserOp, _verifySignature),
 *       src/core/SelectorManager.sol (_installSelector, _clearSelectorData),
 *       src/core/HookManager.sol (_installHook), src/types/Constants.sol,
 *       src/utils/ValidationTypeLib.sol (encodeAsNonceKey, decodeNonce).
 *  [S]  github.com/zerodevapp/sdk commit cd7c05b53b6ae6bede7dfefe9e59fbddfadf0c0a:
 *       plugins/weighted-ecdsa (toWeightedECDSAValidatorPlugin.ts, constants.ts
 *       getRecoveryAction / kernelVersionRangeToValidator),
 *       plugins/weighted-r1-k1/constants.ts (getRecoveryFallbackActionInstallModuleData),
 *       packages/core/accounts/kernel/utils/plugins/ep0_7/getValidatorPluginInstallModuleData.ts,
 *       packages/core/accounts/kernel/createKernelMigrationAccount.ts (fallback
 *       uninstall encoding), packages/test/v0.7/recoveryKernelAccount.test.ts.
 *       Published npm packages used as the reference encoder (scratchpad only):
 *       @zerodev/weighted-ecdsa-validator 5.4.4, @zerodev/weighted-validator
 *       5.5.1, @zerodev/sdk 5.5.10, viem 2.57.2.
 *  [P]  github.com/zerodevapp/kernel-7579-plugins commit ca4a820
 *       (2024-04-17) actions/recovery/src/RecoveryAction.sol; the same
 *       two-line body is restored at e2b0794 (2026-08-05) src/actions/RecoveryAction.sol.
 *  [D]  docs.zerodev.app/advanced/account-recovery/sdk-recovery (recovery
 *       executor address and doRecovery usage; "After you update the account
 *       owner, the account address can no longer by computed from the new
 *       owner").
 *
 * Deployment binding (read-only checks, Sepolia and Ethereum mainnet):
 *  - WeightedECDSAValidator 0xeD89244160CfE273800B58b1B534031699dFeEEE:
 *    Sourcify full match (creation + runtime) on chain 1 and runtime match on
 *    chain 11155111; the verified source file is byte-identical to [K]
 *    src/validator/WeightedECDSAValidator.sol at v3.3 (solc 0.8.24, runs 200,
 *    paris). eip712Domain() returns ("WeightedECDSAValidator", "0.0.3") on
 *    both chains. Its runtime code differs between the chains only because
 *    solady's EIP712 caches the chain id and domain separator as immutables.
 *  - RecoveryAction 0xe884C2868CC82c16177eC73a93f7D9E6F3A5DC6E: not verified
 *    on Sourcify; identical runtime code on both chains (keccak
 *    0xfcfe9c1a…cf89, 513 bytes). Its executable bytecode was reproduced byte
 *    for byte by compiling [P] ca4a820 RecoveryAction.sol with solc 0.8.24,
 *    optimizer runs 200, evmVersion paris; only the trailing CBOR metadata
 *    hash differs (source paths), so behaviour is tied to that source.
 *
 * AUDIT STATUS (as published): Kalos audited "Recovery Plugin and Weighted
 * ECDSA" twice (v1.0 2023-12-12 at kernel 90fa72ed, patched f9461f1a; v2.0
 * 2024-02-06 at eaaac83a, patched 9bc9cc62) — the KERNEL v2 versions
 * (IKernelValidator; that RecoveryAction only called enable()). The Kernel
 * v3 port in [K] v3.3 differs (ERC-7579 interface, renew list fix, proposal
 * status handling, ERC-1271 return values) and the v3 RecoveryAction calls
 * onUninstall + onInstall; neither delta appears in a published report. The
 * "v_3_1_incremental_audit" covers a DIFFERENT contract, the plugins
 * repository's WeightedValidator.sol (commit 91f8fcb, ECDSA + WebAuthn
 * guardians). Treat the deployed v3 weighted validator and RecoveryAction as
 * UNAUDITED in their shipped form.
 *
 * TRUST MODEL (from the source; every point below was exercised with
 * eth_simulateV1 against the deployed contracts, and the no-delay path,
 * the ERC-1271 probes and the owner rotation also live on Sepolia, by
 * scripts/testnet/recovery-smoke.mjs):
 *  - Guardians whose combined weight reaches the threshold can replace the
 *    root owner with ANY key. With delay 0 this happens in one UserOperation
 *    and the owner cannot intervene. With delay > 0 the guardians must first
 *    approve on-chain (approve / approveWithSig, the latter callable by
 *    anyone holding the signatures); the operation then becomes valid only
 *    after the delay, and during the delay the ACCOUNT ITSELF (a root-signed
 *    operation calling validator.veto(hash)) can reject the proposal.
 *  - doRecovery accepts ANY validator address and data, so the same
 *    guardians can also re-configure the weighted validator (replace
 *    themselves) through it.
 *  - ERC-1271: Kernel's isValidSignature accepts signatures from ANY
 *    installed validator and does not consult the selector allowlist
 *    [K _verifySignature], so once the guardian validator is installed the
 *    guardians can sign messages AS THE ACCOUNT (Permit2 permits, off-chain
 *    orders, logins) immediately, with no delay and no veto. Worse, the
 *    deployed isValidSignatureWithSender adds a signer's weight and checks
 *    the threshold BEFORE it checks the strictly-descending signer order, so
 *    the final signature may repeat an earlier signer: a coalition C passes
 *    when weight(C) + max weight in C >= threshold, not weight(C) >=
 *    threshold. See guardianSignatureExposure. This is a property of the
 *    deployed contracts that no wallet-side encoding can remove; the app must
 *    disclose it.
 *  - Applies to proxy-deployed Kernel accounts only. An EIP-7702-delegated
 *    EOA keeps its own key as the ultimate authority (it can always
 *    re-delegate), so guardians cannot protect it; prepareGuardianInstall
 *    refuses such accounts.
 */

/** Deployed recovery modules (identical addresses on Ethereum mainnet and Sepolia). */
export const KERNEL_RECOVERY_MODULES = {
  /** WeightedECDSAValidator ("0.0.3"), [S] kernelVersionRangeToValidator "0.3.0 - 0.3.3". */
  weightedEcdsaValidator: '0xeD89244160CfE273800B58b1B534031699dFeEEE',
  /** RecoveryAction for EntryPoint v0.7, [S] RECOVERY_ACTION_ADDRESS_V07 and [D]. */
  recoveryAction: '0xe884C2868CC82c16177eC73a93f7D9E6F3A5DC6E',
} as const;

export type KernelRecoveryModules = { -readonly [K in keyof typeof KERNEL_RECOVERY_MODULES]: string };

/** EIP-712 domain name and version of the weighted validator [K _domainNameAndVersion]. */
export const WEIGHTED_ECDSA_VALIDATOR_NAME = 'WeightedECDSAValidator';
export const WEIGHTED_ECDSA_VALIDATOR_VERSION = '0.0.3';

/** keccak256("Approve(bytes32 callDataAndNonceHash)") [K approveWithSig / validateUserOp]; tests recompute it. */
export const WEIGHTED_ECDSA_APPROVE_TYPE_HASH = '0x067fee5d1749b3f616375b51aab37cde80fb2cfe2f38b20d4a277ec1cbc21acd';

/** doRecovery(address,bytes) selector, 0xac39fd0f (also the dispatcher constant in the deployed RecoveryAction). */
export const KERNEL_RECOVERY_SELECTOR = toHex(abiSelector('doRecovery(address,bytes)'));

/** ERC-7579 module type ids [K src/types/Constants.sol]. */
export const KERNEL_MODULE_TYPE_VALIDATOR = 1;
export const KERNEL_MODULE_TYPE_FALLBACK = 3;

/** CALLTYPE_DELEGATECALL [K Constants.sol]: the selector runs RecoveryAction in the account's context. */
const CALLTYPE_DELEGATECALL = 0xff;
/** HOOK_ONLY_ENTRYPOINT [K Constants.sol]: what a zero hook becomes for a selector [K _installSelector]. */
const HOOK_ONLY_ENTRYPOINT = '0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF';
/** End marker of the weighted validator's guardian list (address(type(uint160).max)) [K onInstall]. */
const GUARDIAN_LIST_END = '0xffffffffffffffffffffffffffffffffffffffff';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const MAX_UINT24 = 0xffffff;
const MAX_UINT48 = 2 ** 48 - 1;
/** Hard bound on guardian-list traversal so a malicious RPC cannot loop us forever (wallet policy). */
const MAX_GUARDIANS = 32;

/**
 * ZeroDev SDK dummy ECDSA signature [S packages/core/constants.ts]: recoverable
 * for any digest (solady's recover reverts on garbage), recovering to an
 * address that is not a guardian. The SDK's weighted plugin uses it as the
 * last signature of its gas-estimation stub.
 */
const DUMMY_ECDSA_SIGNATURE =
  '0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c';

const APPROVE_TYPES: TypedDataTypes = { Approve: [{ name: 'callDataAndNonceHash', type: 'bytes32' }] };

// ---------------------------------------------------------------------------
// Guardian sets
// ---------------------------------------------------------------------------

export interface KernelGuardian {
  address: string;
  /** uint24, at least 1. */
  weight: number;
}

export interface KernelGuardianSet {
  guardians: KernelGuardian[];
  /** uint24: combined weight needed. At least 1 and at most the total weight. */
  threshold: number;
  /**
   * uint48 seconds between on-chain approval and the recovery becoming valid.
   * 0 = guardians can recover in a single operation and the owner cannot
   * veto. > 0 = two-step flow (approve, wait, execute) with an owner veto.
   */
  delaySeconds: number;
}

export interface GuardianSetContext {
  /** The Kernel account being protected. */
  account?: string | undefined;
  /** Its current root owner (the ECDSA validator's stored owner). */
  owner?: string | undefined;
}

/**
 * Local, network-free validation. Throws on the first problem. Rules the
 * contract also enforces say so; the rest are wallet policy, with the reason.
 */
export function validateGuardianSet(set: KernelGuardianSet, context: GuardianSetContext = {}): void {
  if (!set || !Array.isArray(set.guardians) || set.guardians.length === 0) {
    throw new Error('A guardian set needs at least one guardian');
  }
  if (set.guardians.length > MAX_GUARDIANS) {
    // Wallet policy: getApproval and onUninstall walk the whole list on-chain.
    throw new Error(`At most ${MAX_GUARDIANS} guardians are supported`);
  }
  const seen = new Set<string>();
  let total = 0;
  set.guardians.forEach((g, i) => {
    const where = `guardians[${i}]`;
    requireAddress(g?.address, `${where}.address`);
    const lower = g.address.toLowerCase();
    if (lower === ZERO_ADDRESS) throw new Error(`${where} is the zero address (the contract refuses it)`);
    if (lower === GUARDIAN_LIST_END) {
      throw new Error(`${where} is 0xff…ff, the contract's list end marker`);
    }
    if (seen.has(lower)) {
      // The contract also refuses ("Guardian already enabled").
      throw new Error(`${where} duplicates an earlier guardian`);
    }
    seen.add(lower);
    if (context.account !== undefined && sameAddress(g.address, context.account)) {
      // The contract also refuses ("Guardian cannot be self"). An account that
      // approves its own recovery means whoever already controls it — the
      // lost or stolen owner key — would count toward the threshold.
      throw new Error(`${where} is the account itself; an account cannot guard its own recovery`);
    }
    if (context.owner !== undefined && sameAddress(g.address, context.owner)) {
      // Wallet policy: recovery exists for the case where the owner key is
      // lost or stolen. If that key also held guardian weight, a thief would
      // hold a share of the vote to take the account (and a lost key would
      // make the threshold harder to reach).
      throw new Error(`${where} is the account's current owner; the owner cannot also be a guardian`);
    }
    if (!Number.isInteger(g.weight) || g.weight < 1 || g.weight > MAX_UINT24) {
      // The contract refuses weight 0 ("Weight cannot be 0"); uint24 bound from the ABI.
      throw new Error(`${where}.weight must be an integer from 1 to ${MAX_UINT24}`);
    }
    total += g.weight;
  });
  if (total > MAX_UINT24) {
    // totalWeight is a uint24; Solidity 0.8 checked arithmetic would revert.
    throw new Error(`Total guardian weight ${total} exceeds the contract's uint24 limit`);
  }
  if (!Number.isInteger(set.threshold) || set.threshold < 1) {
    // The contract accepts threshold 0 at install time and then refuses every
    // operation ("Kernel not enabled"), i.e. a silently dead guardian set.
    throw new Error('threshold must be a positive integer (0 would disable recovery)');
  }
  if (set.threshold > total) {
    // onInstall refuses ("Threshold too high"); renew() does NOT check, so this
    // check is the only protection on that path.
    throw new Error(`threshold ${set.threshold} exceeds the total guardian weight ${total}; recovery would be impossible`);
  }
  if (!Number.isInteger(set.delaySeconds) || set.delaySeconds < 0 || set.delaySeconds > MAX_UINT48) {
    throw new Error('delaySeconds must be an integer between 0 and 2^48 - 1');
  }
}

/** Guardians in strictly DESCENDING address order, as onInstall/renew require ("Guardians not sorted"). */
export function sortGuardiansDescending(guardians: KernelGuardian[]): KernelGuardian[] {
  return [...guardians].sort((a, b) => {
    const x = BigInt(a.address);
    const y = BigInt(b.address);
    return x > y ? -1 : x < y ? 1 : 0;
  });
}

/**
 * The weighted validator's install data [K onInstall]: abi.encode(address[]
 * guardians, uint24[] weights, uint24 threshold, uint48 delay), guardians in
 * descending order — the same bytes as the SDK's getEnableData [S].
 */
export function encodeGuardianSetData(set: KernelGuardianSet, context: GuardianSetContext = {}): Uint8Array {
  validateGuardianSet(set, context);
  const sorted = sortGuardiansDescending(set.guardians);
  return encodeSequence([
    { kind: 'array', items: sorted.map((g) => ({ kind: 'address' as const, value: g.address })) },
    { kind: 'array', items: sorted.map((g) => ({ kind: 'uint256' as const, value: BigInt(g.weight) })) },
    { kind: 'uint256', value: BigInt(set.threshold) },
    { kind: 'uint256', value: BigInt(set.delaySeconds) },
  ]);
}

export interface GuardianSignatureExposure {
  /** Fewest guardians whose combined weight reaches the threshold (the intended rule). */
  recoveryMinimumGuardians: number;
  /**
   * Fewest guardians who can produce an ERC-1271 signature the account
   * accepts, under the deployed evaluation order (weight(C) + max(C) >=
   * threshold). Never more than recoveryMinimumGuardians.
   */
  signatureMinimumGuardians: number;
  /** True when one guardian alone can sign messages as the account. */
  singleGuardianCanSign: boolean;
  /** True when signing needs fewer guardians than recovery does. */
  weakerThanThreshold: boolean;
}

/**
 * What the guardians can do through ERC-1271 once installed (see the module
 * comment). For a fixed coalition size k, the k heaviest guardians maximise
 * both weight(C) and weight(C) + max(C), so scanning k = 1, 2, ... over the
 * weights sorted heaviest first finds both minima exactly.
 */
export function guardianSignatureExposure(set: KernelGuardianSet): GuardianSignatureExposure {
  validateGuardianSet(set);
  const weights = set.guardians.map((g) => g.weight).sort((a, b) => b - a);
  let recoveryMinimumGuardians = weights.length;
  let signatureMinimumGuardians = weights.length;
  let sum = 0;
  let recoveryFound = false;
  let signatureFound = false;
  for (let k = 1; k <= weights.length; k++) {
    sum += weights[k - 1]!;
    // The k heaviest maximise both weight(C) and weight(C) + max(C).
    if (!signatureFound && sum + weights[0]! >= set.threshold) {
      signatureMinimumGuardians = k;
      signatureFound = true;
    }
    if (!recoveryFound && sum >= set.threshold) {
      recoveryMinimumGuardians = k;
      recoveryFound = true;
    }
  }
  return {
    recoveryMinimumGuardians,
    signatureMinimumGuardians,
    singleGuardianCanSign: signatureMinimumGuardians === 1,
    weakerThanThreshold: signatureMinimumGuardians < recoveryMinimumGuardians,
  };
}

// ---------------------------------------------------------------------------
// Install / uninstall / renew (root-signed operations)
// ---------------------------------------------------------------------------

/** Kernel validation id of the guardian validator: 0x01 || validator. */
export function guardianValidationId(modules: KernelRecoveryModules = KERNEL_RECOVERY_MODULES): Uint8Array {
  return kernelValidatorId(modules.weightedEcdsaValidator);
}

/**
 * installModule(1, weightedValidator, initData) with initData = hook (20
 * zero bytes: "installed, no hook") || abi.encode(bytes validatorData, bytes
 * hookData, bytes selectorData) [K Kernel.installModule reads the
 * InstallValidatorDataFormat at offset 20]. selectorData = the 4-byte
 * doRecovery selector, which installModule turns into
 * grantAccess(vId, doRecovery, true) — the guardians' ONLY allowed selector.
 * Same bytes as the SDK's getValidatorPluginInstallModuleData with
 * action.selector = doRecovery [S]. Kernel picks the validation nonce itself.
 */
export function encodeGuardianValidatorInstall(
  guardianSetData: Uint8Array,
  modules: KernelRecoveryModules = KERNEL_RECOVERY_MODULES,
): Uint8Array {
  return encodeFunctionCall('installModule(uint256,address,bytes)', [
    { kind: 'uint256', value: BigInt(KERNEL_MODULE_TYPE_VALIDATOR) },
    { kind: 'address', value: modules.weightedEcdsaValidator },
    {
      kind: 'bytes',
      value: concatBytes(
        new Uint8Array(20),
        encodeSequence([
          { kind: 'bytes', value: guardianSetData },
          { kind: 'bytes', value: new Uint8Array(0) },
          { kind: 'bytes', value: toBytes(KERNEL_RECOVERY_SELECTOR) },
        ]),
      ),
    },
  ]);
}

/**
 * installModule(3, recoveryAction, initData) with initData = doRecovery
 * selector (4) || hook (20 zero bytes, which Kernel stores as
 * HOOK_ONLY_ENTRYPOINT) || abi.encode(bytes selectorData = 0xff
 * (CALLTYPE_DELEGATECALL), bytes hookData = empty) [K installModule at
 * offset 24, _installSelector]. Same bytes as the SDK's
 * getRecoveryFallbackActionInstallModuleData for EntryPoint v0.7 [S].
 */
export function encodeRecoveryActionInstall(modules: KernelRecoveryModules = KERNEL_RECOVERY_MODULES): Uint8Array {
  return encodeFunctionCall('installModule(uint256,address,bytes)', [
    { kind: 'uint256', value: BigInt(KERNEL_MODULE_TYPE_FALLBACK) },
    { kind: 'address', value: modules.recoveryAction },
    {
      kind: 'bytes',
      value: concatBytes(
        toBytes(KERNEL_RECOVERY_SELECTOR),
        new Uint8Array(20),
        encodeSequence([
          { kind: 'bytes', value: new Uint8Array([CALLTYPE_DELEGATECALL]) },
          { kind: 'bytes', value: new Uint8Array(0) },
        ]),
      ),
    },
  ]);
}

/**
 * The two self-calls a ROOT-signed operation executes to set up guardians
 * (self-calls pass Kernel's onlyEntryPointOrSelfOrRoot). Validates the set
 * against the account and its current owner first.
 */
export function guardianInstallCalls(
  account: string,
  set: KernelGuardianSet,
  options: { owner: string; modules?: KernelRecoveryModules },
): Call[] {
  requireAddress(account, 'account');
  requireAddress(options.owner, 'owner');
  const modules = options.modules ?? KERNEL_RECOVERY_MODULES;
  const data = encodeGuardianSetData(set, { account, owner: options.owner });
  return [
    { to: account, value: 0n, data: encodeGuardianValidatorInstall(data, modules) },
    { to: account, value: 0n, data: encodeRecoveryActionInstall(modules) },
  ];
}

/**
 * Root-signed removal of the guardians: uninstallValidation(vId, "", "")
 * (Kernel clears the validation and calls the validator's onUninstall, which
 * deletes the guardian list), grantAccess(vId, doRecovery, false), and
 * uninstallModule(3, recoveryAction, doRecovery selector) to clear the
 * selector route [K Kernel.sol; the fallback deInitData shape is the SDK's,
 * createKernelMigrationAccount.ts]. Leaves no recovery state behind.
 */
export function guardianUninstallCalls(account: string, modules: KernelRecoveryModules = KERNEL_RECOVERY_MODULES): Call[] {
  requireAddress(account, 'account');
  const vId = guardianValidationId(modules);
  return [
    {
      to: account,
      value: 0n,
      data: encodeFunctionCall('uninstallValidation(bytes21,bytes,bytes)', [
        { kind: 'fixedBytes', value: vId },
        { kind: 'bytes', value: new Uint8Array(0) },
        { kind: 'bytes', value: new Uint8Array(0) },
      ]),
    },
    {
      to: account,
      value: 0n,
      data: encodeFunctionCall('grantAccess(bytes21,bytes4,bool)', [
        { kind: 'fixedBytes', value: vId },
        { kind: 'fixedBytes', value: toBytes(KERNEL_RECOVERY_SELECTOR) },
        { kind: 'uint256', value: 0n },
      ]),
    },
    {
      to: account,
      value: 0n,
      data: encodeFunctionCall('uninstallModule(uint256,address,bytes)', [
        { kind: 'uint256', value: BigInt(KERNEL_MODULE_TYPE_FALLBACK) },
        { kind: 'address', value: modules.recoveryAction },
        { kind: 'bytes', value: toBytes(KERNEL_RECOVERY_SELECTOR) },
      ]),
    },
  ];
}

/**
 * Root-signed replacement of the guardian set: a call FROM the account TO
 * the validator, renew(guardians, weights, threshold, delay) [K renew; S
 * getUpdateConfigCall]. renew() itself does not check the threshold against
 * the new total weight, so the local validation here is the only guard.
 */
export function guardianRenewCall(
  set: KernelGuardianSet,
  options: { account: string; owner: string; modules?: KernelRecoveryModules },
): Call {
  const modules = options.modules ?? KERNEL_RECOVERY_MODULES;
  validateGuardianSet(set, { account: options.account, owner: options.owner });
  const sorted = sortGuardiansDescending(set.guardians);
  return {
    to: modules.weightedEcdsaValidator,
    value: 0n,
    data: encodeFunctionCall('renew(address[],uint24[],uint24,uint48)', [
      { kind: 'array', items: sorted.map((g) => ({ kind: 'address' as const, value: g.address })) },
      { kind: 'array', items: sorted.map((g) => ({ kind: 'uint256' as const, value: BigInt(g.weight) })) },
      { kind: 'uint256', value: BigInt(set.threshold) },
      { kind: 'uint256', value: BigInt(set.delaySeconds) },
    ]),
  };
}

/**
 * Owner-initiated rotation (the owner still holds the key): the same two
 * validator calls RecoveryAction makes, executed as plain calls from the
 * account in one atomic batch — ECDSAValidator.onUninstall("") then
 * onInstall(bytes20 newOwner). A root operation cannot call doRecovery
 * through execute(): the selector's hook only admits the EntryPoint as
 * caller [K fallback, HOOK_ONLY_ENTRYPOINT].
 */
export function ownerRotationCalls(
  newOwner: string,
  options: { account: string; ecdsaValidator?: string | undefined; guardians?: KernelGuardian[] | undefined },
): Call[] {
  checkNewOwner(newOwner, options.account, options.guardians);
  const ecdsaValidator = options.ecdsaValidator ?? KERNEL_V3_3.ecdsaValidator;
  return [
    {
      to: ecdsaValidator,
      value: 0n,
      data: encodeFunctionCall('onUninstall(bytes)', [{ kind: 'bytes', value: new Uint8Array(0) }]),
    },
    {
      to: ecdsaValidator,
      value: 0n,
      data: encodeFunctionCall('onInstall(bytes)', [{ kind: 'bytes', value: toBytes(newOwner) }]),
    },
  ];
}

// ---------------------------------------------------------------------------
// The guardian-signed recovery operation
// ---------------------------------------------------------------------------

/**
 * UserOperation callData of a recovery: doRecovery(ecdsaValidator, bytes20
 * newOwner) — the call shape of [D] and [S recoveryKernelAccount.test.ts].
 * Refuses the zero address (the account could never sign again: no key
 * recovers to address(0)), the account itself (a contract cannot produce
 * the ECDSA signature the validator checks), and any guardian (the new owner
 * would hold guardian weight over its own replacement).
 */
export function encodeRecoveryCallData(
  newOwner: string,
  options: { account?: string | undefined; ecdsaValidator?: string | undefined; guardians?: KernelGuardian[] | undefined } = {},
): Uint8Array {
  checkNewOwner(newOwner, options.account, options.guardians);
  return encodeFunctionCall('doRecovery(address,bytes)', [
    { kind: 'address', value: options.ecdsaValidator ?? KERNEL_V3_3.ecdsaValidator },
    { kind: 'bytes', value: toBytes(newOwner) },
  ]);
}

/**
 * EntryPoint nonce key that routes an operation to the guardian validator
 * [K ValidatorLib.encodeAsNonceKey/decodeNonce]: mode 0x00 (default) || type
 * 0x01 (validator) || validator address (20) || parallel key (2). Same as the
 * SDK plugin manager's getNonceKey for an already-installed regular validator.
 */
export function guardianNonceKey(
  modules: KernelRecoveryModules = KERNEL_RECOVERY_MODULES,
  parallelKey = 0,
): bigint {
  if (!Number.isInteger(parallelKey) || parallelKey < 0 || parallelKey > 0xffff) {
    throw new Error('parallelKey must be a uint16');
  }
  const key = new Uint8Array(24);
  key[0] = 0x00;
  key.set(guardianValidationId(modules), 1);
  key[22] = parallelKey >> 8;
  key[23] = parallelKey & 0xff;
  return BigInt(toHex(key));
}

/** keccak256(abi.encode(sender, callData, nonce)) — the proposal id [K validateUserOp]. */
export function callDataAndNonceHash(sender: string, callData: Uint8Array, nonce: bigint): Uint8Array {
  return keccak(
    encodeSequence([
      { kind: 'address', value: sender },
      { kind: 'bytes', value: callData },
      { kind: 'uint256', value: nonce },
    ]),
  );
}

/** The EIP-712 request a guardian approves (for display and for hardware signers). */
export function guardianApprovalTypedData(
  chainId: bigint,
  proposalHash: Uint8Array | string,
  modules: KernelRecoveryModules = KERNEL_RECOVERY_MODULES,
) {
  const hash = typeof proposalHash === 'string' ? toBytes(proposalHash) : proposalHash;
  if (hash.length !== 32) throw new Error('callDataAndNonceHash must be 32 bytes');
  return {
    domain: {
      name: WEIGHTED_ECDSA_VALIDATOR_NAME,
      version: WEIGHTED_ECDSA_VALIDATOR_VERSION,
      chainId,
      verifyingContract: modules.weightedEcdsaValidator,
    },
    types: APPROVE_TYPES,
    primaryType: 'Approve' as const,
    message: { callDataAndNonceHash: toHex(hash) },
  };
}

/**
 * Digest a guardian signs to approve a proposal: solady EIP712
 * _hashTypedData(keccak256(abi.encode(APPROVE_TYPE_HASH, hash))) under the
 * validator's own domain ("WeightedECDSAValidator", "0.0.3", chain id,
 * verifyingContract = the validator) [K]. Recovered RAW (no EIP-191).
 */
export function guardianApprovalDigest(
  chainId: bigint,
  proposalHash: Uint8Array | string,
  modules: KernelRecoveryModules = KERNEL_RECOVERY_MODULES,
): Uint8Array {
  const t = guardianApprovalTypedData(chainId, proposalHash, modules);
  return typedDataDigest(t.domain, t.types, t.primaryType, t.message);
}

/** A guardian's 65-byte approval signature (r || s || v, v = 27/28). */
export function signGuardianApproval(guardian: DerivedAccount, digest: Uint8Array): Uint8Array {
  if (digest.length !== 32) throw new Error('Approval digest must be 32 bytes');
  return withEthereumV(guardian.sign(digest));
}

/** The submitting guardian's signature over the userOpHash, EIP-191 form [K: ECDSA.toEthSignedMessageHash(userOpHash)]. */
export function signGuardianUserOpHash(guardian: DerivedAccount, userOpHash: Uint8Array): Uint8Array {
  if (userOpHash.length !== 32) throw new Error('userOpHash must be 32 bytes');
  return withEthereumV(guardian.sign(toEthSignedMessageHash(userOpHash)));
}

/** Recovers the signer of a 65-byte r || s || v (v = 27/28) signature over a raw 32-byte digest. */
export function recoverSignerAddress(digest: Uint8Array, signature: Uint8Array): string {
  if (digest.length !== 32) throw new Error('digest must be 32 bytes');
  if (signature.length !== 65) throw new Error(`signature must be 65 bytes, got ${signature.length}`);
  const v = signature[64]!;
  if (v !== 27 && v !== 28) throw new Error(`signature v must be 27 or 28, got ${v}`);
  const recovered = new Uint8Array(65);
  recovered[0] = v - 27;
  recovered.set(signature.subarray(0, 64), 1);
  const point = secp256k1.Signature.fromBytes(recovered, 'recovered').recoverPublicKey(digest);
  return toChecksumAddress(keccak(point.toBytes(false).subarray(1)).slice(12));
}

/**
 * Full operation signature for the immediate (delay 0) path [K validateUserOp,
 * "Ongoing && !passed" branch]: N approval signatures over the EIP-712
 * Approve digest, then ONE final signature by a guardian over the EIP-191
 * userOpHash. The contract counts each distinct signer once; the final
 * signer must be a guardian. For an already approved proposal (delay > 0
 * path) pass no approvals: the signature is just the final 65 bytes.
 */
export function encodeGuardianSignature(approvals: Uint8Array[], finalSignature: Uint8Array): Uint8Array {
  for (const a of approvals) if (a.length !== 65) throw new Error('Each approval signature must be 65 bytes');
  if (finalSignature.length !== 65) throw new Error('The final signature must be 65 bytes');
  return concatBytes(...approvals, finalSignature);
}

/** Gas-estimation stub: the real approvals followed by a recoverable dummy (as the SDK does). */
export function guardianStubSignature(approvals: Uint8Array[]): Uint8Array {
  return encodeGuardianSignature(approvals, toBytes(DUMMY_ECDSA_SIGNATURE));
}

/**
 * Everything guardians need to approve one recovery, JSON-safe so it can be
 * handed to them (QR code, link, file). Bound to chain, account, new owner and
 * the exact guardian-lane nonce: if any operation consumes that nonce first,
 * the approvals are void and must be collected again.
 */
export interface GuardianRecoveryRequest {
  version: 1;
  /** Decimal chain id. */
  chainId: string;
  account: string;
  newOwner: string;
  /** The root ECDSA validator whose owner is replaced. */
  ecdsaValidator: string;
  weightedEcdsaValidator: string;
  recoveryAction: string;
  /** Full EntryPoint nonce (key << 64 | sequence), decimal. */
  nonce: string;
  callData: string;
  callDataAndNonceHash: string;
  /** EIP-712 digest each approving guardian signs. */
  approvalDigest: string;
}

/** Builds a request offline from known values (prepareGuardianRecovery reads them from the chain). */
export function buildGuardianRecoveryRequest(params: {
  chainId: bigint;
  account: string;
  newOwner: string;
  nonce: bigint;
  ecdsaValidator?: string | undefined;
  modules?: KernelRecoveryModules | undefined;
  guardians?: KernelGuardian[] | undefined;
}): GuardianRecoveryRequest {
  requireAddress(params.account, 'account');
  if (params.chainId <= 0n) throw new Error('chainId must be positive');
  const modules = params.modules ?? KERNEL_RECOVERY_MODULES;
  const ecdsaValidator = params.ecdsaValidator ?? KERNEL_V3_3.ecdsaValidator;
  const callData = encodeRecoveryCallData(params.newOwner, {
    account: params.account,
    ecdsaValidator,
    guardians: params.guardians,
  });
  // uint192 key = mode (1 byte) || type (1 byte) || validator (20) || parallel key (2).
  const key = params.nonce >> 64n;
  if (key >> 184n !== 0n || ((key >> 176n) & 0xffn) !== 0x01n) {
    throw new Error('nonce does not carry a default-mode, validator-type Kernel nonce key');
  }
  const validatorInKey = toChecksumAddress(toBytes('0x' + ((key >> 16n) & ((1n << 160n) - 1n)).toString(16).padStart(40, '0')));
  if (!sameAddress(validatorInKey, modules.weightedEcdsaValidator)) {
    throw new Error(`nonce key routes to ${validatorInKey}, not the guardian validator`);
  }
  const hash = callDataAndNonceHash(params.account, callData, params.nonce);
  return {
    version: 1,
    chainId: params.chainId.toString(10),
    account: toChecksumAddress(toBytes(params.account)),
    newOwner: toChecksumAddress(toBytes(params.newOwner)),
    ecdsaValidator,
    weightedEcdsaValidator: modules.weightedEcdsaValidator,
    recoveryAction: modules.recoveryAction,
    nonce: params.nonce.toString(10),
    callData: toHex(callData),
    callDataAndNonceHash: toHex(hash),
    approvalDigest: toHex(guardianApprovalDigest(params.chainId, hash, modules)),
  };
}

/** Re-derives every field of a request (never trust a request handed over by someone else). */
export function parseGuardianRecoveryRequest(value: unknown): GuardianRecoveryRequest {
  const v = value as Partial<GuardianRecoveryRequest> | null;
  if (!v || typeof v !== 'object' || v.version !== 1) throw new Error('Not a version-1 guardian recovery request');
  const decimal = (s: unknown, what: string): bigint => {
    if (typeof s !== 'string' || !/^(0|[1-9][0-9]*)$/.test(s)) throw new Error(`${what} must be a decimal string`);
    return BigInt(s);
  };
  for (const k of ['account', 'newOwner', 'ecdsaValidator', 'weightedEcdsaValidator', 'recoveryAction'] as const) {
    requireAddress(v[k], k);
  }
  const rebuilt = buildGuardianRecoveryRequest({
    chainId: decimal(v.chainId, 'chainId'),
    account: v.account!,
    newOwner: v.newOwner!,
    nonce: decimal(v.nonce, 'nonce'),
    ecdsaValidator: v.ecdsaValidator!,
    modules: { weightedEcdsaValidator: v.weightedEcdsaValidator!, recoveryAction: v.recoveryAction! },
  });
  for (const k of ['callData', 'callDataAndNonceHash', 'approvalDigest'] as const) {
    if (typeof v[k] !== 'string' || v[k]!.toLowerCase() !== rebuilt[k].toLowerCase()) {
      throw new Error(`${k} does not match the request's own fields`);
    }
  }
  return rebuilt;
}

/** Checks one approval against the request and the on-chain guardian set; returns the guardian. */
export function verifyGuardianApproval(
  request: GuardianRecoveryRequest,
  signature: Uint8Array,
  set: KernelGuardianSet,
): KernelGuardian {
  const signer = recoverSignerAddress(toBytes(request.approvalDigest), signature);
  const guardian = set.guardians.find((g) => sameAddress(g.address, signer));
  if (!guardian) throw new Error(`Approval was signed by ${signer}, who is not a guardian of ${request.account}`);
  return { address: toChecksumAddress(toBytes(guardian.address)), weight: guardian.weight };
}

/**
 * Orders and checks the collected approvals for the immediate path: drops
 * the submitter's own approval (its final signature counts for it), refuses
 * non-guardians and duplicates, sorts by signer address descending (the
 * SDK's order; the contract does not require an order here), and refuses
 * unless approvers + submitter reach the threshold. Refuses when the set has
 * a delay: then the proposal must be approved on-chain first
 * (encodeApproveWithSig) and the operation carries no approvals.
 */
export function assembleGuardianApprovals(
  request: GuardianRecoveryRequest,
  set: KernelGuardianSet,
  approvals: Uint8Array[],
  submitter: string,
): { approvals: Uint8Array[]; weight: number } {
  if (set.delaySeconds !== 0) {
    throw new Error('This guardian set has a delay: approve on-chain with approveWithSig, wait, then submit without approvals');
  }
  const submitterGuardian = set.guardians.find((g) => sameAddress(g.address, submitter));
  if (!submitterGuardian) throw new Error(`Submitter ${submitter} is not a guardian`);
  const bySigner = new Map<string, { address: string; signature: Uint8Array; weight: number }>();
  for (const signature of approvals) {
    const g = verifyGuardianApproval(request, signature, set);
    const key = g.address.toLowerCase();
    if (bySigner.has(key)) throw new Error(`Two approvals from ${g.address}`);
    if (sameAddress(g.address, submitter)) continue;
    bySigner.set(key, { address: g.address, signature, weight: g.weight });
  }
  const ordered = [...bySigner.values()].sort((a, b) => {
    const x = BigInt(a.address);
    const y = BigInt(b.address);
    return x > y ? -1 : x < y ? 1 : 0;
  });
  const weight = ordered.reduce((s, a) => s + a.weight, 0) + submitterGuardian.weight;
  if (weight < set.threshold) {
    throw new Error(`Approvals carry weight ${weight}, below the threshold ${set.threshold}`);
  }
  return { approvals: ordered.map((a) => a.signature), weight };
}

/** The recovery as a Call, for SmartAccountClient.sendCalls with kernelGuardianRecoverySpec. */
export function recoveryCall(request: GuardianRecoveryRequest): Call {
  return { to: request.account, value: 0n, data: toBytes(request.callData) };
}

export interface KernelGuardianRecoverySpecConfig {
  request: GuardianRecoveryRequest;
  /** Ordered approval signatures (assembleGuardianApprovals), or [] for an on-chain-approved proposal. */
  approvals: Uint8Array[];
  /** The guardian that signs the final userOpHash signature (and is the client's "owner"). */
  submitter: string;
  entryPoint?: string;
}

export interface KernelGuardianRecoverySpec extends SmartAccountSpec {
  nonceKey: bigint;
  /**
   * Node wrapper for SmartAccountClient: its EntryPoint getNonce(account, 0)
   * read is answered from the guardian nonce key, and REFUSES unless the
   * result is exactly the nonce the guardians approved.
   */
  routeNode(node: JsonRpcTransport): JsonRpcTransport;
}

/**
 * SmartAccountSpec for the guardian-signed recovery operation, so
 * SmartAccountClient.sendCalls works unchanged:
 *   client = new SmartAccountClient({ ..., spec, node: spec.routeNode(node) })
 *   client.sendCalls(submitterGuardian, [recoveryCall(request)], fees)
 * The op's callData is doRecovery(...) itself (not execute): Kernel's
 * fallback routes it. Only the request's exact call is accepted.
 */
export function kernelGuardianRecoverySpec(config: KernelGuardianRecoverySpecConfig): KernelGuardianRecoverySpec {
  const request = parseGuardianRecoveryRequest(config.request);
  requireAddress(config.submitter, 'submitter');
  const modules = { weightedEcdsaValidator: request.weightedEcdsaValidator, recoveryAction: request.recoveryAction };
  const nonce = BigInt(request.nonce);
  const nonceKey = nonce >> 64n;
  if (nonceKey !== guardianNonceKey(modules, Number(nonceKey & 0xffffn))) {
    throw new Error('Request nonce is not on the guardian validator lane');
  }
  const entryPoint = config.entryPoint ?? ENTRYPOINT_V07;
  const approvals = config.approvals.map((a) => a.slice());
  const requireSubmitter = (signer: DerivedAccount): void => {
    if (!sameAddress(signer.address, config.submitter)) {
      throw new Error(`This recovery is submitted by guardian ${config.submitter}; refusing ${signer.address}`);
    }
  };
  return {
    nonceKey,
    async getAddress(signer: DerivedAccount): Promise<string> {
      requireSubmitter(signer);
      return request.account;
    },
    async getFactoryArgs(): Promise<{ factory: string; factoryData: Uint8Array }> {
      throw new Error(`Kernel account ${request.account} is not deployed; recovery needs a deployed account`);
    },
    encodeCalls(calls: Call[]): Uint8Array {
      const call = calls.length === 1 ? calls[0]! : null;
      if (!call || !sameAddress(call.to, request.account) || call.value !== 0n || toHex(call.data).toLowerCase() !== request.callData.toLowerCase()) {
        throw new Error('A guardian recovery operation carries exactly the approved doRecovery call and nothing else');
      }
      return toBytes(request.callData);
    },
    signUserOpHash(signer: DerivedAccount, userOpHash: Uint8Array): Uint8Array {
      requireSubmitter(signer);
      return encodeGuardianSignature(approvals, signGuardianUserOpHash(signer, userOpHash));
    },
    stubSignature(): Uint8Array {
      return guardianStubSignature(approvals);
    },
    routeNode(node: JsonRpcTransport): JsonRpcTransport {
      const keyZeroRead = toHex(
        encodeFunctionCall('getNonce(address,uint192)', [
          { kind: 'address', value: request.account },
          { kind: 'uint256', value: 0n },
        ]),
      );
      const routed = toHex(
        encodeFunctionCall('getNonce(address,uint192)', [
          { kind: 'address', value: request.account },
          { kind: 'uint256', value: nonceKey },
        ]),
      );
      return async (method, params) => {
        if (method === 'eth_call') {
          const tx = params[0] as { to?: string; data?: string } | undefined;
          if (tx?.to && sameAddress(tx.to, entryPoint) && typeof tx.data === 'string' && tx.data.toLowerCase() === keyZeroRead) {
            const result = (await node(method, [{ ...tx, data: routed }, ...params.slice(1)])) as string;
            if (BigInt(result) !== nonce) {
              throw new Error(
                `The guardian nonce is now ${BigInt(result)}, not the approved ${nonce}; the approvals are void — collect new ones`,
              );
            }
            return result;
          }
        }
        return node(method, params);
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Delay path: on-chain approval and veto
// ---------------------------------------------------------------------------

/**
 * Calldata for WeightedECDSAValidator.approveWithSig(hash, account, sigs)
 * [K]: anyone may send it as a plain transaction with the guardians'
 * Approve signatures concatenated. Once the approved weight reaches the
 * threshold the proposal becomes Approved with validAfter = now + delay.
 * Every signature must be from a distinct signer that has not voted yet
 * (the contract reverts "Already voted").
 */
export function encodeApproveWithSig(request: GuardianRecoveryRequest, signatures: Uint8Array[]): Call {
  if (signatures.length === 0) throw new Error('At least one approval signature is required');
  return {
    to: request.weightedEcdsaValidator,
    value: 0n,
    data: encodeFunctionCall('approveWithSig(bytes32,address,bytes)', [
      { kind: 'fixedBytes', value: toBytes(request.callDataAndNonceHash) },
      { kind: 'address', value: request.account },
      { kind: 'bytes', value: concatBytes(...signatures.map((s) => {
        if (s.length !== 65) throw new Error('Each approval signature must be 65 bytes');
        return s;
      })) },
    ]),
  };
}

/**
 * The owner's veto [K veto]: a call FROM the account to the validator
 * marking the proposal Rejected. Only the account itself can veto (the
 * contract keys the proposal by msg.sender), i.e. a root-signed operation.
 * Effective for an Ongoing or Approved proposal before it executes.
 */
export function encodeVetoCall(proposalHash: Uint8Array | string, modules: KernelRecoveryModules = KERNEL_RECOVERY_MODULES): Call {
  const hash = typeof proposalHash === 'string' ? toBytes(proposalHash) : proposalHash;
  if (hash.length !== 32) throw new Error('callDataAndNonceHash must be 32 bytes');
  return {
    to: modules.weightedEcdsaValidator,
    value: 0n,
    data: encodeFunctionCall('veto(bytes32)', [{ kind: 'fixedBytes', value: hash }]),
  };
}

export type RecoveryProposalStatus = 'ongoing' | 'approved' | 'rejected' | 'executed';

export interface RecoveryProposalState {
  status: RecoveryProposalStatus;
  /** Unix seconds from which an approved proposal may execute (0 if never approved). */
  validAfter: number;
  /** getApproval(account, hash): approved weight and whether it passes (false once rejected). */
  approvedWeight: number;
  passed: boolean;
}

/** Reads proposalStatus and getApproval for one proposal [K]. */
export async function readRecoveryProposal(
  node: JsonRpcTransport,
  account: string,
  proposalHash: Uint8Array | string,
  modules: KernelRecoveryModules = KERNEL_RECOVERY_MODULES,
): Promise<RecoveryProposalState> {
  const hash = typeof proposalHash === 'string' ? toBytes(proposalHash) : proposalHash;
  const statusWords = await ethCall(
    node,
    modules.weightedEcdsaValidator,
    encodeFunctionCall('proposalStatus(bytes32,address)', [
      { kind: 'fixedBytes', value: hash },
      { kind: 'address', value: account },
    ]),
  );
  const approvalWords = await ethCall(
    node,
    modules.weightedEcdsaValidator,
    encodeFunctionCall('getApproval(address,bytes32)', [
      { kind: 'address', value: account },
      { kind: 'fixedBytes', value: hash },
    ]),
  );
  if (statusWords.length !== 64 || approvalWords.length !== 64) throw new Error('Unexpected proposal read shape');
  const statuses: RecoveryProposalStatus[] = ['ongoing', 'approved', 'rejected', 'executed'];
  const statusIndex = Number(word(statusWords, 0));
  const status = statuses[statusIndex];
  if (!status) throw new Error(`Unknown proposal status ${statusIndex}`);
  return {
    status,
    validAfter: Number(word(statusWords, 1)),
    approvedWeight: Number(word(approvalWords, 0)),
    passed: word(approvalWords, 1) === 1n,
  };
}

// ---------------------------------------------------------------------------
// On-chain reads
// ---------------------------------------------------------------------------

export interface KernelOwnerState {
  /** rootValidator() as 21-byte hex. */
  rootValidator: string;
  /** True when the root validator is the configured ECDSA validator. */
  ecdsaRoot: boolean;
  /** ECDSAValidator.ecdsaValidatorStorage(account).owner (zero if none). */
  owner: string;
}

/** Reads the account's root validator and the ECDSA validator's stored owner [K]. */
export async function readKernelOwner(
  node: JsonRpcTransport,
  account: string,
  ecdsaValidator: string = KERNEL_V3_3.ecdsaValidator,
): Promise<KernelOwnerState> {
  const root = await ethCall(node, account, encodeFunctionCall('rootValidator()', []));
  if (root.length !== 32) throw new Error('rootValidator() did not return one word; is this a Kernel v3 account?');
  const rootValidator = toHex(root.slice(0, 21));
  const ownerWord = await ethCall(
    node,
    ecdsaValidator,
    encodeFunctionCall('ecdsaValidatorStorage(address)', [{ kind: 'address', value: account }]),
  );
  if (ownerWord.length !== 32) throw new Error('ecdsaValidatorStorage() returned an unexpected shape');
  return {
    rootValidator,
    ecdsaRoot: rootValidator.toLowerCase() === toHex(kernelValidatorId(ecdsaValidator)).toLowerCase(),
    owner: toChecksumAddress(ownerWord.slice(12)),
  };
}

export interface KernelGuardianState {
  /** Kernel validationConfig(vId).hook is set (validation installed). */
  validationInstalled: boolean;
  /** isAllowedSelector(vId, doRecovery). */
  recoveryAllowed: boolean;
  /** selectorConfig(doRecovery) routes to RecoveryAction by delegatecall with the EntryPoint-only hook. */
  recoveryRouted: boolean;
  /** The validator holds a guardian list for this account (isInitialized). */
  validatorInitialized: boolean;
  /** The configured set, guardians sorted descending; null when none. */
  set: KernelGuardianSet | null;
  /** True when the account can actually be recovered by its guardians. */
  active: boolean;
}

/** Reads the guardian configuration of an account from Kernel and the weighted validator [K]. */
export async function readGuardianState(
  node: JsonRpcTransport,
  account: string,
  modules: KernelRecoveryModules = KERNEL_RECOVERY_MODULES,
): Promise<KernelGuardianState> {
  const vId = guardianValidationId(modules);
  const config = await ethCall(node, account, encodeFunctionCall('validationConfig(bytes21)', [{ kind: 'fixedBytes', value: vId }]));
  if (config.length !== 64) throw new Error('validationConfig() returned an unexpected shape');
  const validationInstalled = !sameAddress(addressAt(config, 1), ZERO_ADDRESS);
  const allowed = await ethCall(
    node,
    account,
    encodeFunctionCall('isAllowedSelector(bytes21,bytes4)', [
      { kind: 'fixedBytes', value: vId },
      { kind: 'fixedBytes', value: toBytes(KERNEL_RECOVERY_SELECTOR) },
    ]),
  );
  const selectorWords = await ethCall(
    node,
    account,
    encodeFunctionCall('selectorConfig(bytes4)', [{ kind: 'fixedBytes', value: toBytes(KERNEL_RECOVERY_SELECTOR) }]),
  );
  if (selectorWords.length !== 96) throw new Error('selectorConfig() returned an unexpected shape');
  const recoveryRouted =
    sameAddress(addressAt(selectorWords, 0), HOOK_ONLY_ENTRYPOINT) &&
    sameAddress(addressAt(selectorWords, 1), modules.recoveryAction) &&
    selectorWords[64] === CALLTYPE_DELEGATECALL;

  const storage = await ethCall(
    node,
    modules.weightedEcdsaValidator,
    encodeFunctionCall('weightedStorage(address)', [{ kind: 'address', value: account }]),
  );
  if (storage.length !== 128) throw new Error('weightedStorage() returned an unexpected shape');
  const totalWeight = Number(word(storage, 0));
  const threshold = Number(word(storage, 1));
  const delaySeconds = Number(word(storage, 2));
  const validatorInitialized = totalWeight !== 0;
  let set: KernelGuardianSet | null = null;
  if (validatorInitialized) {
    const guardians: KernelGuardian[] = [];
    let current = addressAt(storage, 3);
    for (let i = 0; !sameAddress(current, GUARDIAN_LIST_END); i++) {
      if (i >= MAX_GUARDIANS) throw new Error('Guardian list longer than supported; refusing to continue');
      const g = await ethCall(
        node,
        modules.weightedEcdsaValidator,
        encodeFunctionCall('guardian(address,address)', [
          { kind: 'address', value: current },
          { kind: 'address', value: account },
        ]),
      );
      if (g.length !== 64) throw new Error('guardian() returned an unexpected shape');
      const weight = Number(word(g, 0));
      if (weight === 0) throw new Error(`Guardian list is broken at ${current}`);
      guardians.push({ address: current, weight });
      current = addressAt(g, 1);
    }
    const sum = guardians.reduce((s, g) => s + g.weight, 0);
    if (sum !== totalWeight) throw new Error(`Guardian weights sum to ${sum}, but totalWeight is ${totalWeight}`);
    set = { guardians: sortGuardiansDescending(guardians), threshold, delaySeconds };
  }
  const recoveryAllowed = word(allowed, 0) === 1n;
  return {
    validationInstalled,
    recoveryAllowed,
    recoveryRouted,
    validatorInitialized,
    set,
    active: validationInstalled && recoveryAllowed && recoveryRouted && validatorInitialized && threshold > 0,
  };
}

/**
 * Validates and builds the guardian install calls against the LIVE account:
 * deployed, a proxy-deployed Kernel (not an EIP-7702-delegated EOA), the
 * ECDSA validator is root, the set is validated against the on-chain owner,
 * and the weighted validator does not already hold a list for this account
 * (onInstall would revert AlreadyInitialized).
 */
export async function prepareGuardianInstall(
  node: JsonRpcTransport,
  params: { account: string; set: KernelGuardianSet; modules?: KernelRecoveryModules; ecdsaValidator?: string },
): Promise<{ calls: Call[]; owner: string }> {
  const modules = params.modules ?? KERNEL_RECOVERY_MODULES;
  validateGuardianSet(params.set, { account: params.account });
  const code = (await node('eth_getCode', [params.account, 'latest'])) as string;
  if (!code || code === '0x' || code === '0x0') throw new Error(`${params.account} is not deployed; deploy the account before adding guardians`);
  if (code.toLowerCase().startsWith('0xef0100')) {
    throw new Error(
      'This address is an EIP-7702-delegated EOA: its own key can always re-delegate, so guardians cannot protect it',
    );
  }
  const owner = await readKernelOwner(node, params.account, params.ecdsaValidator);
  if (!owner.ecdsaRoot) throw new Error(`The root validator is ${owner.rootValidator}, not the ECDSA validator`);
  if (sameAddress(owner.owner, ZERO_ADDRESS)) throw new Error('The ECDSA validator holds no owner for this account');
  const state = await readGuardianState(node, params.account, modules);
  if (state.validatorInitialized) {
    throw new Error('Guardians are already configured for this account; remove them first or use guardianRenewCall');
  }
  return { calls: guardianInstallCalls(params.account, params.set, { owner: owner.owner, modules }), owner: owner.owner };
}

/**
 * Reads everything a recovery needs and builds the request guardians sign:
 * chain id check, active guardian configuration, the current owner (the new
 * owner must differ and must not be a guardian), and the guardian-lane nonce.
 */
export async function prepareGuardianRecovery(
  node: JsonRpcTransport,
  params: {
    chainId: bigint;
    account: string;
    newOwner: string;
    modules?: KernelRecoveryModules;
    ecdsaValidator?: string;
    parallelKey?: number;
    entryPoint?: string;
  },
): Promise<{ request: GuardianRecoveryRequest; set: KernelGuardianSet; currentOwner: string }> {
  const modules = params.modules ?? KERNEL_RECOVERY_MODULES;
  const ecdsaValidator = params.ecdsaValidator ?? KERNEL_V3_3.ecdsaValidator;
  const chainId = BigInt((await node('eth_chainId', [])) as string);
  if (chainId !== params.chainId) throw new Error(`Node chain id ${chainId} is not ${params.chainId}`);
  const state = await readGuardianState(node, params.account, modules);
  if (!state.active || !state.set) throw new Error(`${params.account} has no active guardian recovery`);
  const owner = await readKernelOwner(node, params.account, ecdsaValidator);
  if (!owner.ecdsaRoot) throw new Error('The root validator is not the ECDSA validator; doRecovery would not change the owner');
  if (sameAddress(owner.owner, params.newOwner)) throw new Error('The new owner is already the owner');
  const key = guardianNonceKey(modules, params.parallelKey ?? 0);
  const nonceBytes = await ethCall(
    node,
    params.entryPoint ?? ENTRYPOINT_V07,
    encodeFunctionCall('getNonce(address,uint192)', [
      { kind: 'address', value: params.account },
      { kind: 'uint256', value: key },
    ]),
  );
  const nonce = word(nonceBytes, 0);
  if (nonce >> 64n !== key) throw new Error('EntryPoint.getNonce returned a nonce for a different key');
  const request = buildGuardianRecoveryRequest({
    chainId,
    account: params.account,
    newOwner: params.newOwner,
    nonce,
    ecdsaValidator,
    modules,
    guardians: state.set.guardians,
  });
  return { request, set: state.set, currentOwner: owner.owner };
}

// ---------------------------------------------------------------------------
// Using an account whose owner changed (ADR D1 caveat)
// ---------------------------------------------------------------------------

/**
 * SmartAccountSpec for a DEPLOYED Kernel v3.3 account at a KNOWN address
 * whose root owner may no longer be the address's original (CREATE2) owner —
 * after a guardian recovery or an owner rotation the address cannot be
 * recomputed from the signing key [D]. getAddress returns the persisted
 * address only after reading the ECDSA validator's stored owner and checking
 * it is the signing key, so a wrong key fails before anything is signed.
 * Encoding and signatures are exactly the root Kernel spec's.
 */
export function kernelRecoveredAccountSpec(config: {
  node: JsonRpcTransport;
  account: string;
  ecdsaValidator?: string;
}): SmartAccountSpec {
  requireAddress(config.account, 'account');
  const ecdsaValidator = config.ecdsaValidator ?? KERNEL_V3_3.ecdsaValidator;
  const base = createKernelAccountSpec({ node: config.node, ecdsaValidator });
  const verified = new Set<string>();
  const account = toChecksumAddress(toBytes(config.account));
  return {
    async getAddress(owner: DerivedAccount): Promise<string> {
      if (verified.has(owner.address.toLowerCase())) return account;
      const state = await readKernelOwner(config.node, account, ecdsaValidator);
      if (!state.ecdsaRoot) throw new Error(`${account}'s root validator is not the ECDSA validator`);
      if (!sameAddress(state.owner, owner.address)) {
        throw new Error(`${account} is owned by ${state.owner}, not ${owner.address}`);
      }
      verified.add(owner.address.toLowerCase());
      return account;
    },
    async getFactoryArgs(): Promise<{ factory: string; factoryData: Uint8Array }> {
      throw new Error(`${account} must already be deployed`);
    },
    encodeCalls: (calls: Call[]) => encodeKernelExecute(calls),
    signUserOpHash: (owner: DerivedAccount, hash: Uint8Array) => base.signUserOpHash(owner, hash),
    stubSignature: () => base.stubSignature(),
    signErc1271: (owner: DerivedAccount, hash: Uint8Array, context: SmartAccountSignatureContext) =>
      base.signErc1271!(owner, hash, context),
  };
}

/** OwnerRegistered(address indexed kernel, address indexed owner) [K ECDSAValidator.sol]. */
export const ECDSA_OWNER_REGISTERED_TOPIC = toHex(keccak(utf8ToBytes('OwnerRegistered(address,address)')));

/** ERC-1967 implementation slot [K Constants.sol ERC1967_IMPLEMENTATION_SLOT]. */
const ERC1967_IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

export interface KernelAccountOwnershipCheck {
  account: string;
  ok: boolean;
  /** Why the candidate was rejected (empty when ok). */
  problems: string[];
}

/**
 * Re-attachment check for "Use this recovered account": the address holds
 * a Kernel proxy for the pinned implementation (ERC-1967 slot), its root
 * validator is the ECDSA validator, and the stored owner is `owner`. Never
 * attach an address on less: anyone can deploy a contract or emit events
 * that name the wallet's key.
 */
export async function verifyKernelAccountForOwner(
  node: JsonRpcTransport,
  account: string,
  owner: string,
  options: { implementation?: string; ecdsaValidator?: string } = {},
): Promise<KernelAccountOwnershipCheck> {
  const problems: string[] = [];
  const implementation = options.implementation ?? KERNEL_V3_3.implementation;
  const code = (await node('eth_getCode', [account, 'latest'])) as string;
  if (!code || code === '0x' || code === '0x0') {
    return { account, ok: false, problems: ['no code at this address'] };
  }
  if (code.toLowerCase().startsWith('0xef0100')) {
    return { account, ok: false, problems: ['EIP-7702-delegated EOA, not a proxy-deployed Kernel account'] };
  }
  const slot = toBytes((await node('eth_getStorageAt', [account, ERC1967_IMPLEMENTATION_SLOT, 'latest'])) as string);
  const impl = toChecksumAddress(toWord(slot).slice(12));
  if (!sameAddress(impl, implementation)) problems.push(`implementation is ${impl}, expected ${implementation}`);
  try {
    const state = await readKernelOwner(node, account, options.ecdsaValidator);
    if (!state.ecdsaRoot) problems.push(`root validator is ${state.rootValidator}, not the ECDSA validator`);
    if (!sameAddress(state.owner, owner)) problems.push(`owner is ${state.owner}, not ${owner}`);
  } catch (error) {
    problems.push((error as Error).message);
  }
  return { account: toChecksumAddress(toBytes(account)), ok: problems.length === 0, problems };
}

/**
 * Discovery for a restored wallet that lost its recovery metadata: finds
 * ECDSA-validator OwnerRegistered logs naming `owner` in [fromBlock,
 * toBlock] and returns only candidates that pass verifyKernelAccountForOwner
 * (events are trivially forgeable by any contract). Free RPC endpoints cap
 * the log range (the project measured ~10,000 blocks on
 * ethereum.publicnode.com), so callers page through ranges or use an indexer.
 */
export async function findKernelAccountsByOwner(
  node: JsonRpcTransport,
  owner: string,
  range: { fromBlock: bigint; toBlock: bigint },
  options: { implementation?: string; ecdsaValidator?: string } = {},
): Promise<{ verified: string[]; rejected: KernelAccountOwnershipCheck[] }> {
  requireAddress(owner, 'owner');
  const ecdsaValidator = options.ecdsaValidator ?? KERNEL_V3_3.ecdsaValidator;
  const logs = (await node('eth_getLogs', [
    {
      address: ecdsaValidator,
      fromBlock: '0x' + range.fromBlock.toString(16),
      toBlock: '0x' + range.toBlock.toString(16),
      topics: [ECDSA_OWNER_REGISTERED_TOPIC, null, toHex(toWord(toBytes(owner)))],
    },
  ])) as Array<{ topics?: string[] }>;
  const candidates = new Set<string>();
  for (const log of logs ?? []) {
    const t = log.topics?.[1];
    if (typeof t === 'string' && /^0x[0-9a-fA-F]{64}$/.test(t)) {
      candidates.add(toChecksumAddress(toBytes(t).slice(12)));
    }
  }
  const verified: string[] = [];
  const rejected: KernelAccountOwnershipCheck[] = [];
  for (const account of candidates) {
    const check = await verifyKernelAccountForOwner(node, account, owner, options);
    if (check.ok) verified.push(check.account);
    else rejected.push(check);
  }
  return { verified, rejected };
}

// ---------------------------------------------------------------------------
// Recovery metadata (what the wallet must persist and back up)
// ---------------------------------------------------------------------------

export type KernelOwnerChangeSource = 'deployment' | 'guardian-recovery' | 'owner-rotation';

export interface KernelOwnerRecord {
  owner: string;
  source: KernelOwnerChangeSource;
  /** Transaction that made this the owner (null for 'deployment' if unknown). */
  txHash: string | null;
  /** UserOperation that made this the owner, when it was one. */
  userOpHash: string | null;
  /** Decimal block number of txHash, when known. */
  blockNumber: string | null;
  /**
   * BIP-32 path of the owner key when this wallet's seed derives it (e.g.
   * "m/44'/60'/0'/0/9"); null for keys from another seed or device.
   */
  derivationPath: string | null;
  /** Unix seconds when the wallet recorded the change. */
  recordedAt: number;
}

export interface KernelGuardianRecord {
  weightedEcdsaValidator: string;
  recoveryAction: string;
  guardians: Array<KernelGuardian & { label?: string }>;
  threshold: number;
  delaySeconds: number;
  installTxHash: string | null;
}

/**
 * Per-account recovery metadata. Once an owner changes, the account address
 * is NOT derivable from any seed (the CREATE2 salt commits to the ORIGINAL
 * owner), so this record — not the seed — is what lets a restored wallet
 * find and use the account. It must be persisted on-device and backed up
 * off-device (and is useful to guardians too). It contains no secrets.
 */
export interface KernelRecoveryMetadata {
  version: 1;
  /** CAIP-2, e.g. "eip155:11155111". */
  chainId: string;
  account: string;
  accountType: 'kernel-v3.3';
  /** How the address was created: lets anyone re-check the address from the original owner. */
  deployment: {
    factory: string;
    implementation: string;
    ecdsaValidator: string;
    /** Decimal CREATE2 index (salt). */
    index: string;
    originalOwner: string;
  };
  /** Oldest first; the last entry is the current owner. The first is the deployment owner. */
  owners: KernelOwnerRecord[];
  guardians: KernelGuardianRecord | null;
}

/**
 * Starts a record for an account and checks its lineage: the address must
 * equal the CREATE2 prediction from the original owner and index, so a
 * mistyped or substituted address is refused at creation time.
 */
export function createRecoveryMetadata(params: {
  chainId: bigint;
  account: string;
  index: bigint;
  originalOwner: string;
  originalOwnerPath?: string | null;
  deploymentTxHash?: string | null;
  factory?: string;
  implementation?: string;
  ecdsaValidator?: string;
  recordedAt: number;
}): KernelRecoveryMetadata {
  const factory = params.factory ?? KERNEL_V3_3.factory;
  const implementation = params.implementation ?? KERNEL_V3_3.implementation;
  const ecdsaValidator = params.ecdsaValidator ?? KERNEL_V3_3.ecdsaValidator;
  requireAddress(params.account, 'account');
  requireAddress(params.originalOwner, 'originalOwner');
  if (params.index < 0n) throw new Error('index must be non-negative');
  const predicted = predictKernelAddress(params.originalOwner, { index: params.index, factory, implementation, ecdsaValidator });
  if (!sameAddress(predicted, params.account)) {
    throw new Error(`${params.account} is not the Kernel v3.3 address of ${params.originalOwner} at index ${params.index} (${predicted})`);
  }
  const meta: KernelRecoveryMetadata = {
    version: 1,
    chainId: `eip155:${params.chainId.toString(10)}`,
    account: predicted,
    accountType: 'kernel-v3.3',
    deployment: {
      factory,
      implementation,
      ecdsaValidator,
      index: params.index.toString(10),
      originalOwner: toChecksumAddress(toBytes(params.originalOwner)),
    },
    owners: [
      {
        owner: toChecksumAddress(toBytes(params.originalOwner)),
        source: 'deployment',
        txHash: params.deploymentTxHash ?? null,
        userOpHash: null,
        blockNumber: null,
        derivationPath: params.originalOwnerPath ?? null,
        recordedAt: params.recordedAt,
      },
    ],
    guardians: null,
  };
  return parseRecoveryMetadata(serializeRecoveryMetadata(meta));
}

/** Appends an owner change (returns a new record; the input is not modified). */
export function recordOwnerChange(meta: KernelRecoveryMetadata, change: Omit<KernelOwnerRecord, 'source'> & { source: Exclude<KernelOwnerChangeSource, 'deployment'> }): KernelRecoveryMetadata {
  const current = currentOwnerOf(meta);
  if (sameAddress(current, change.owner)) throw new Error('The new owner equals the current owner');
  if (!change.txHash && !change.userOpHash) throw new Error('An owner change must reference its transaction or UserOperation');
  return parseRecoveryMetadata(serializeRecoveryMetadata({ ...meta, owners: [...meta.owners, { ...change }] }));
}

/** Sets or clears the guardian record (returns a new record). */
export function recordGuardians(meta: KernelRecoveryMetadata, guardians: KernelGuardianRecord | null): KernelRecoveryMetadata {
  return parseRecoveryMetadata(serializeRecoveryMetadata({ ...meta, guardians }));
}

export function currentOwnerOf(meta: KernelRecoveryMetadata): string {
  return meta.owners[meta.owners.length - 1]!.owner;
}

/** Canonical JSON text (stable key order, addresses checksummed) for storage and backup. */
export function serializeRecoveryMetadata(meta: KernelRecoveryMetadata): string {
  const ownerRecord = (o: KernelOwnerRecord) => ({
    owner: o.owner,
    source: o.source,
    txHash: o.txHash,
    userOpHash: o.userOpHash,
    blockNumber: o.blockNumber,
    derivationPath: o.derivationPath,
    recordedAt: o.recordedAt,
  });
  return JSON.stringify({
    version: meta.version,
    chainId: meta.chainId,
    account: meta.account,
    accountType: meta.accountType,
    deployment: {
      factory: meta.deployment.factory,
      implementation: meta.deployment.implementation,
      ecdsaValidator: meta.deployment.ecdsaValidator,
      index: meta.deployment.index,
      originalOwner: meta.deployment.originalOwner,
    },
    owners: meta.owners.map(ownerRecord),
    guardians: meta.guardians
      ? {
          weightedEcdsaValidator: meta.guardians.weightedEcdsaValidator,
          recoveryAction: meta.guardians.recoveryAction,
          guardians: meta.guardians.guardians.map((g) => ({
            address: g.address,
            weight: g.weight,
            ...(g.label !== undefined ? { label: g.label } : {}),
          })),
          threshold: meta.guardians.threshold,
          delaySeconds: meta.guardians.delaySeconds,
          installTxHash: meta.guardians.installTxHash,
        }
      : null,
  });
}

/** Strict parse (string or object). Re-checks the CREATE2 lineage and every invariant. */
export function parseRecoveryMetadata(input: unknown): KernelRecoveryMetadata {
  const v = (typeof input === 'string' ? JSON.parse(input) : input) as Partial<KernelRecoveryMetadata> | null;
  if (!v || typeof v !== 'object' || v.version !== 1) throw new Error('Not version-1 Kernel recovery metadata');
  if (v.accountType !== 'kernel-v3.3') throw new Error('accountType must be "kernel-v3.3"');
  if (typeof v.chainId !== 'string' || !/^eip155:[1-9][0-9]*$/.test(v.chainId)) throw new Error('chainId must be CAIP-2 eip155:<id>');
  requireAddress(v.account, 'account');
  const d = v.deployment;
  if (!d || typeof d !== 'object') throw new Error('deployment is missing');
  for (const k of ['factory', 'implementation', 'ecdsaValidator', 'originalOwner'] as const) requireAddress(d[k], `deployment.${k}`);
  if (typeof d.index !== 'string' || !/^(0|[1-9][0-9]*)$/.test(d.index)) throw new Error('deployment.index must be a decimal string');
  const predicted = predictKernelAddress(d.originalOwner, {
    index: BigInt(d.index),
    factory: d.factory,
    implementation: d.implementation,
    ecdsaValidator: d.ecdsaValidator,
  });
  if (!sameAddress(predicted, v.account!)) throw new Error('account does not match the deployment (original owner + index)');
  if (!Array.isArray(v.owners) || v.owners.length === 0) throw new Error('owners must list at least the deployment owner');
  const owners: KernelOwnerRecord[] = v.owners.map((o, i) => {
    const where = `owners[${i}]`;
    if (!o || typeof o !== 'object') throw new Error(`${where} is not an object`);
    requireAddress(o.owner, `${where}.owner`);
    if (sameAddress(o.owner, ZERO_ADDRESS)) throw new Error(`${where}.owner is the zero address`);
    if (sameAddress(o.owner, v.account!)) throw new Error(`${where}.owner is the account itself`);
    const sources: KernelOwnerChangeSource[] = ['deployment', 'guardian-recovery', 'owner-rotation'];
    if (!sources.includes(o.source as KernelOwnerChangeSource)) throw new Error(`${where}.source is invalid`);
    if ((i === 0) !== (o.source === 'deployment')) throw new Error(`${where}: only the first entry is the deployment owner`);
    const hash32 = (h: unknown, what: string): string | null => {
      if (h === null || h === undefined) return null;
      if (typeof h !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(h)) throw new Error(`${where}.${what} must be a 32-byte hex hash or null`);
      return h.toLowerCase();
    };
    const txHash = hash32(o.txHash, 'txHash');
    const userOpHash = hash32(o.userOpHash, 'userOpHash');
    if (i > 0 && !txHash && !userOpHash) throw new Error(`${where} must reference its transaction or UserOperation`);
    if (o.blockNumber !== null && o.blockNumber !== undefined && (typeof o.blockNumber !== 'string' || !/^(0|[1-9][0-9]*)$/.test(o.blockNumber))) {
      throw new Error(`${where}.blockNumber must be a decimal string or null`);
    }
    if (o.derivationPath !== null && o.derivationPath !== undefined && (typeof o.derivationPath !== 'string' || !/^m(\/[0-9]+'?)+$/.test(o.derivationPath))) {
      throw new Error(`${where}.derivationPath must be a BIP-32 path or null`);
    }
    if (!Number.isSafeInteger(o.recordedAt) || (o.recordedAt as number) < 0) throw new Error(`${where}.recordedAt must be unix seconds`);
    if (i > 0 && sameAddress(o.owner, v.owners![i - 1]!.owner)) throw new Error(`${where} repeats the previous owner`);
    return {
      owner: toChecksumAddress(toBytes(o.owner)),
      source: o.source as KernelOwnerChangeSource,
      txHash,
      userOpHash,
      blockNumber: o.blockNumber ?? null,
      derivationPath: o.derivationPath ?? null,
      recordedAt: o.recordedAt as number,
    };
  });
  if (!sameAddress(owners[0]!.owner, d.originalOwner)) throw new Error('owners[0] must be the deployment owner');
  let guardians: KernelGuardianRecord | null = null;
  if (v.guardians !== null && v.guardians !== undefined) {
    const g = v.guardians;
    requireAddress(g.weightedEcdsaValidator, 'guardians.weightedEcdsaValidator');
    requireAddress(g.recoveryAction, 'guardians.recoveryAction');
    if (!Array.isArray(g.guardians)) throw new Error('guardians.guardians must be an array');
    const set: KernelGuardianSet = {
      guardians: g.guardians.map((x) => ({ address: String(x?.address), weight: x?.weight as number })),
      threshold: g.threshold as number,
      delaySeconds: g.delaySeconds as number,
    };
    validateGuardianSet(set, { account: v.account, owner: owners[owners.length - 1]!.owner });
    if (g.installTxHash !== null && (typeof g.installTxHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(g.installTxHash))) {
      throw new Error('guardians.installTxHash must be a 32-byte hex hash or null');
    }
    guardians = {
      weightedEcdsaValidator: toChecksumAddress(toBytes(g.weightedEcdsaValidator)),
      recoveryAction: toChecksumAddress(toBytes(g.recoveryAction)),
      guardians: sortGuardiansDescending(
        g.guardians.map((x) => ({
          address: toChecksumAddress(toBytes(String(x.address))),
          weight: x.weight,
          ...(typeof x.label === 'string' ? { label: x.label } : {}),
        })),
      ),
      threshold: g.threshold as number,
      delaySeconds: g.delaySeconds as number,
      installTxHash: g.installTxHash ? g.installTxHash.toLowerCase() : null,
    };
  }
  return {
    version: 1,
    chainId: v.chainId,
    account: toChecksumAddress(toBytes(v.account!)),
    accountType: 'kernel-v3.3',
    deployment: {
      factory: toChecksumAddress(toBytes(d.factory)),
      implementation: toChecksumAddress(toBytes(d.implementation)),
      ecdsaValidator: toChecksumAddress(toBytes(d.ecdsaValidator)),
      index: d.index,
      originalOwner: toChecksumAddress(toBytes(d.originalOwner)),
    },
    owners,
    guardians,
  };
}

/**
 * Compares a record with the chain: chain id, deployed proxy for the
 * recorded implementation, ECDSA root, current owner = the record's last
 * owner, and the guardian set (or its absence). Returns every mismatch.
 */
export async function verifyRecoveryMetadataOnChain(
  node: JsonRpcTransport,
  meta: KernelRecoveryMetadata,
): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = [];
  const chainId = BigInt((await node('eth_chainId', [])) as string);
  if (`eip155:${chainId}` !== meta.chainId) {
    return { ok: false, problems: [`node is on eip155:${chainId}, record is for ${meta.chainId}`] };
  }
  const ownership = await verifyKernelAccountForOwner(node, meta.account, currentOwnerOf(meta), {
    implementation: meta.deployment.implementation,
    ecdsaValidator: meta.deployment.ecdsaValidator,
  });
  problems.push(...ownership.problems);
  const modules = meta.guardians
    ? { weightedEcdsaValidator: meta.guardians.weightedEcdsaValidator, recoveryAction: meta.guardians.recoveryAction }
    : KERNEL_RECOVERY_MODULES;
  if (ownership.problems[0] !== 'no code at this address') {
    const state = await readGuardianState(node, meta.account, modules);
    if (meta.guardians) {
      if (!state.active || !state.set) problems.push('record lists guardians, but none are active on-chain');
      else if (!sameGuardianSet(state.set, meta.guardians)) problems.push('on-chain guardian set differs from the record');
    } else if (state.validatorInitialized || state.validationInstalled) {
      problems.push('guardians are configured on-chain but not in the record');
    }
  }
  return { ok: problems.length === 0, problems };
}

function sameGuardianSet(a: KernelGuardianSet, b: KernelGuardianSet): boolean {
  if (a.threshold !== b.threshold || a.delaySeconds !== b.delaySeconds || a.guardians.length !== b.guardians.length) return false;
  const x = sortGuardiansDescending(a.guardians);
  const y = sortGuardiansDescending(b.guardians);
  return x.every((g, i) => sameAddress(g.address, y[i]!.address) && g.weight === y[i]!.weight);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function checkNewOwner(newOwner: string, account: string | undefined, guardians: KernelGuardian[] | undefined): void {
  requireAddress(newOwner, 'newOwner');
  if (sameAddress(newOwner, ZERO_ADDRESS)) {
    throw new Error('The new owner must not be the zero address: no key can sign for it, so the account would be locked');
  }
  if (account !== undefined && sameAddress(newOwner, account)) {
    throw new Error('The new owner must not be the account itself: a contract cannot produce the owner ECDSA signature');
  }
  if (guardians?.some((g) => sameAddress(g.address, newOwner))) {
    throw new Error('The new owner must not be one of the guardians: it would hold weight over its own replacement');
  }
}

async function ethCall(node: JsonRpcTransport, to: string, data: Uint8Array): Promise<Uint8Array> {
  return toBytes((await node('eth_call', [{ to, data: toHex(data) }, 'latest'])) as string);
}

function word(bytes: Uint8Array, index: number): bigint {
  const start = index * 32;
  if (start + 32 > bytes.length) throw new Error('Return data too short');
  return BigInt(toHex(bytes.slice(start, start + 32)));
}

function addressAt(bytes: Uint8Array, index: number): string {
  const start = index * 32;
  if (start + 32 > bytes.length) throw new Error('Return data too short');
  return toChecksumAddress(bytes.slice(start + 12, start + 32));
}

function requireAddress(value: unknown, what: string): asserts value is string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${what} must be a 20-byte hex address`);
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
