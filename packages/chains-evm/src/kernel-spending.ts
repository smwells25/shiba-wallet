import { concatBytes } from '@noble/hashes/utils.js';
import { toChecksumAddress } from '@shiba-wallet/core';
import { encodeFunctionCall, encodeSequence, selector as abiSelector, type AbiValue } from './abi.js';
import { keccak, toBytes, toHex, toWord } from './encoding.js';
import { KERNEL_V3_3, kernelValidatorId } from './kernel-account.js';
import { KERNEL_MODULE_TYPE_VALIDATOR, readKernelOwner } from './kernel-recovery.js';
import type { AssetChange } from './asset-diff.js';
import type { JsonRpcTransport } from './rpc.js';
import type { Call } from './smart-account.js';

/**
 * Spending limits for Kernel v3.3 accounts (phase 11, item 1, engine half).
 *
 * SUMMARY OF THE RESEARCH (details below; every claim is tied to a source):
 *  - No deployed, audited module enforces an account-level spending limit
 *    that covers ALL operations of a Kernel v3.3 account, and the account
 *    design makes the preferred policy ("a per-token cap per window for
 *    every operation, including the root owner's, changeable only by the
 *    root owner after a delay") impossible to enforce on-chain with the
 *    seed-derived ECDSA root validator, for three independent reasons:
 *     1. Kernel v3.3 has no global hook. A hook is a field of a validation
 *        config, an executor config or a fallback-selector config;
 *        installModule(4, hook, data) only calls hook.onInstall(data) and
 *        attaches the hook to nothing ("kernel does not support independent
 *        hook install") [K Kernel.sol installModule].
 *     2. The root ECDSA validator is also a type-4 hook, so Kernel's
 *        onlyEntryPointOrSelfOrRoot lets the owner EOA call execute,
 *        installModule, uninstallModule, changeRootValidator … DIRECTLY in a
 *        normal transaction; that path runs only ECDSAValidator.preCheck
 *        (msgSender == owner) and never the validation's hook [K Kernel.sol
 *        onlyEntryPointOrSelfOrRoot; K ECDSAValidator.sol preCheck]. Any hook
 *        on the root validation therefore binds only the owner's
 *        UserOperations, never the owner.
 *     3. The owner can remove a root hook at once: uninstallModule(4, hook, …)
 *        resets the root validation's hook to "none" ("remove hook on root
 *        validator to prevent kernel from being locked") [K Kernel.sol
 *        uninstallModule]. Neither Kernel nor any module found adds a delay.
 *  - The only spending-limit HOOK ZeroDev ships, SpendingLimit
 *    (0xb6D6…D70E, @zerodev/hooks SPENDING_LIMIT_HOOK_V07), is INCOMPATIBLE
 *    with Kernel v3.1–v3.3: it implements the Kernel v3.0 hook interface
 *    postCheck(bytes,bool,bytes) (0xaacbd72a), while Kernel v3.1+ calls
 *    postCheck(bytes) (0x173bf7da) [K v3.0 vs v3.1/v3.3
 *    src/interfaces/IERC7579Modules.sol and src/core/HookManager.sol]. The
 *    deployed contract has no fallback, so on a Kernel v3.3 account every
 *    UserOperation of a validation carrying this hook reverts in the account
 *    after execution (proven against the real Sepolia contracts by
 *    scripts/testnet/spending-limit-smoke.mjs). Installed on the ROOT
 *    validation it would make the account unusable through UserOperations
 *    until the owner EOA removes it with a direct transaction.
 *  - Its rule is also not the preferred one: a LIFETIME allowance per token
 *    that only decreases (no window, no refill), measured as the account's
 *    balance decrease across one execution; no setter (changing limits means
 *    uninstall + reinstall) [P SpendingLimit.sol].
 *  - Session-scoped caps are a different thing: ZeroDev's CallPolicy caps
 *    EACH CALL (a batch of N calls spends N caps in one operation, because
 *    the batch branch checks every execution against the same per-call
 *    entry [P2 CallPolicy.sol checkUserOpPolicy]); RateLimitPolicy counts
 *    operations; neither is a cumulative amount limit. Rhinestone's Smart
 *    Sessions has cumulative per-session ERC20SpendingLimitPolicy and
 *    ValueLimitPolicy, but only inside its own SmartSession validator (core
 *    licensed AGPL-3.0-only), session-scoped, lifetime (no window).
 *
 * WHAT THIS MODULE PROVIDES:
 *  A. The ZeroDev SpendingLimit hook, pinned and FENCED: encodings byte-
 *     identical to @zerodev/hooks 5.3.4 toSpendingLimitHook, readers, a local
 *     mirror of its rule, and an interface check. prepareRootSpendingLimitInstall
 *     refuses every hook that does not implement the Kernel v3.1+ postCheck,
 *     which today includes the only deployed one; the encoders exist so the
 *     smoke can prove the incompatibility on-chain and so a future
 *     v3.1-compatible deployment can be adopted by passing its address
 *     (after its own audit and binding work).
 *  B. A CLIENT-SIDE spending policy (per-token cap per rolling window, native
 *     ETH and ERC-20): evaluateSpendingPolicy lets the app warn and refuse
 *     before signing. It is enforced only by this wallet's software; anyone
 *     holding the recovery phrase (or a session key / passkey used outside
 *     this app) is not bound by it, and the UI must say so.
 *
 * Sources (read 2026-10-03):
 *  [K]  github.com/zerodevapp/kernel tag v3.3, commit
 *       cd697c7e21715d015e0643af22310a99aa17433b: src/Kernel.sol
 *       (onlyEntryPointOrSelfOrRoot, validateUserOp, executeUserOp,
 *       installModule, uninstallModule), src/core/HookManager.sol,
 *       src/core/ValidationManager.sol (_installValidation, validationConfig),
 *       src/validator/ECDSAValidator.sol (preCheck, isModuleType; the DEPLOYED
 *       validator's onInstall additionally reverts AlreadyInitialized(address)
 *       — Sourcify full match, chain 1, 0x845ADb2C711129d4f3966735eD98a9F09fC4cE57),
 *       src/types/Constants.sol, src/types/Structs.sol
 *       (InstallValidatorDataFormat), src/utils/ModuleLib.sol. Tag v3.0
 *       (88de17e) for the three-argument postCheck; v3.1 (03f7f5c) and v3.2
 *       (cfedcb9) for the one-argument form.
 *  [P]  github.com/zerodevapp/kernel-7579-plugins
 *       hooks/spendlingLimits/src/SpendingLimit.sol (directory name sic),
 *       introduced c26ed2e (2024-05-17), last changed d9aaeaa (2024-06-11,
 *       "use continue instead of return"), removed from the repository in
 *       335a67c ("removed hooks and actions", 2025-11-04 author date).
 *  [P2] same repository, commit d4855f5: policies/call-policy/src/CallPolicy.sol,
 *       policies/ratelimit/src/RateLimitPolicy.sol.
 *  [S]  @zerodev/hooks 5.3.4 (npm, MIT): constants.ts SPENDING_LIMIT_HOOK_V07,
 *       toSpendingLimitHook.ts getEnableData (0xaa flag || abi.encode(bytes[])
 *       of token || allowance). 5.2.0–5.2.1 pointed at an earlier deployment
 *       0xC7Bc…b269 with the same three-argument postCheck.
 *  [A]  zerodevapp/kernel audits/v_3_1_incremental_audit.pdf (Felix Kim,
 *       2024-05-27 .. 2024-06-09): "Hooks … Spending Limit, File Location:
 *       SpendingLimit.sol, Commit Hash: 9dc7fcd, Description: It manages and
 *       enforces spending allowances for specific tokens, controlling how
 *       much a user can transact." Findings on it (both "minor", status
 *       "found v.1.0"): "No Duplicate Address Verification in
 *       WeightedValidator and SpendingLimit" and "postCheck Function Limited
 *       to Checking a Single Token's Balance".
 *  [E]  sepolia.etherscan.io/address/0xb6D6B30C9E1A28E8044F4cCB48A63A423Ee3D70E
 *       "Source Code Verified (Exact Match)", contract SpendingLimit, solc
 *       v0.8.24, optimizer 200 runs, paris, license none; creator
 *       0x4337012e…Ef038. The verified SpendingLimit.sol is byte-identical to
 *       [P] at d9aaeaa (NOT the audited 9dc7fcd: the deployed code contains
 *       the post-audit fix for the single-token finding), and the verified
 *       kernel interface it was compiled against declares
 *       postCheck(bytes,bool,bytes). Ethereum mainnet: not verified on
 *       Etherscan or Sourcify; created through the deterministic deployer
 *       0x4e59b448…956c; runtime code identical to Sepolia (2,963 bytes,
 *       keccak 0x0c60c158…a90c), so the Sepolia verification binds it.
 *
 * Kernel hook semantics relevant to callers [K]:
 *  - validateUserOp stores the validation's hook for the operation. When the
 *    hook is a real contract (not address(1) = "none"), the operation's
 *    callData MUST start with executeUserOp's selector (else OnlyExecuteUserOp)
 *    and the allowed-selector check reads callData[4:8].
 *  - executeUserOp calls hook.preCheck(EntryPoint, msg.value, callData[4:]),
 *    delegatecalls itself with callData[4:], then hook.postCheck(context).
 *  - Root-validation operations use the root validation's hook too, so a
 *    hook there binds the owner's UserOperations (but see reason 2 above).
 *  - _installHook calls hook.onInstall(hookData[1:]) when the hook is not yet
 *    initialized for the account, or when hookData[0] == 0xff.
 *  - ERC-1271 signatures (isValidSignature) never consult hooks.
 */

/** ERC-7579 module type id of a hook [K src/types/Constants.sol MODULE_TYPE_HOOK]; validators are 1 (KERNEL_MODULE_TYPE_VALIDATOR). */
export const KERNEL_MODULE_TYPE_HOOK = 4;

/** Kernel's "no hook required" marker stored in a validation config [K Constants.sol HOOK_MODULE_INSTALLED]. */
export const KERNEL_HOOK_NONE = '0x0000000000000000000000000000000000000001';

/** The ZeroDev SpendingLimit hook as deployed (same address and code on Ethereum mainnet and Sepolia). */
export const ZERODEV_SPENDING_LIMIT_HOOK = {
  /** [S] SPENDING_LIMIT_HOOK_V07 (@zerodev/hooks 5.2.2 – 5.3.4). */
  address: '0xb6D6B30C9E1A28E8044F4cCB48A63A423Ee3D70E',
  /** keccak256 of the runtime code read from both chains (2,963 bytes). */
  runtimeCodeKeccak: '0x0c60c1587d963f0ceb2ef101a4f0c42a968a543c806c7bf097b5e1f785a0a90c',
  runtimeCodeLength: 2963,
  /** [P] commit whose SpendingLimit.sol equals the Etherscan-verified source [E]. */
  sourceCommit: 'd9aaeaaf4421aa0656cff3ce0577ca64efd4d2f4',
  /** [A] commit named in the v3.1 incremental audit (differs from the deployed source by one line). */
  auditedCommit: '9dc7fcd1c47cb2032b5e1efa5e2fb44f4cdc0a63',
} as const;

/** The earlier deployment used by @zerodev/hooks 5.2.0 – 5.2.1 (same three-argument postCheck; also incompatible). */
export const ZERODEV_SPENDING_LIMIT_HOOK_LEGACY = '0xC7Bc7C9e4B0Ff4DbF023E9391aAFE0886602b269';

/** The hook's token value for native ETH (it reads msg.sender.balance when token == address(0)) [P]. */
export const SPENDING_LIMIT_NATIVE_TOKEN = '0x0000000000000000000000000000000000000000';

/** Hook flag byte the SDK prepends to the onInstall data [S getEnableData; K _installHook reads hookData[1:]]. */
export const SPENDING_LIMIT_SDK_HOOK_FLAG = 0xaa;

/** postCheck as Kernel v3.1 – v3.3 call it [K v3.3 HookManager._doPostHook]. */
export const HOOK_POSTCHECK_KERNEL_V3_1 = toHex(abiSelector('postCheck(bytes)'));
/** postCheck as Kernel v3.0 called it (and as the deployed ZeroDev SpendingLimit implements it) [K v3.0; E]. */
export const HOOK_POSTCHECK_KERNEL_V3_0 = toHex(abiSelector('postCheck(bytes,bool,bytes)'));
/** IAccountExecute.executeUserOp(PackedUserOperation,bytes32), required as the callData prefix when a validation has a hook [K]. */
export const KERNEL_EXECUTE_USER_OP_SELECTOR = toHex(
  abiSelector('executeUserOp((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes),bytes32)'),
);

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const MAX_UINT256 = (1n << 256n) - 1n;
/** Practical bound on list sizes: the hook loops over every entry in preCheck and postCheck of every operation. */
export const MAX_SPENDING_LIMIT_ENTRIES = 8;

// ---------------------------------------------------------------------------
// Part A — the ZeroDev SpendingLimit hook
// ---------------------------------------------------------------------------

/** One hook entry: token (zero address = native ETH) and its remaining allowance in base units. */
export interface SpendingLimit {
  token: string;
  allowance: bigint;
}

export interface SpendingLimitValidationOptions {
  /** The smart account; refused as a token. */
  account?: string;
  /**
   * When given, every ERC-20 token must be in this list (the app passes its
   * tracked-token contracts for the active chain); native ETH is always known.
   */
  knownTokens?: string[];
}

/**
 * Refuses nonsense before anything is encoded: an empty list, more than
 * MAX_SPENDING_LIMIT_ENTRIES entries, malformed addresses, the account itself
 * as a token, tokens outside `knownTokens`, duplicate tokens (the hook does not
 * check — audit finding [A] — and would then deduct one balance decrease
 * twice), and allowances that are zero or not a uint256. A zero allowance is
 * refused because it is not a limit but a freeze that the hook would enforce
 * only on balance decreases measured during execution.
 */
export function validateSpendingLimits(limits: SpendingLimit[], options: SpendingLimitValidationOptions = {}): void {
  if (!Array.isArray(limits) || limits.length === 0) throw new Error('At least one spending limit is required');
  if (limits.length > MAX_SPENDING_LIMIT_ENTRIES) {
    throw new Error(`At most ${MAX_SPENDING_LIMIT_ENTRIES} spending limits are supported`);
  }
  const known = options.knownTokens?.map((t) => {
    requireAddress(t, 'knownTokens entry');
    return t.toLowerCase();
  });
  const seen = new Set<string>();
  limits.forEach((limit, i) => {
    const where = `limits[${i}]`;
    requireAddress(limit.token, `${where}.token`);
    const token = limit.token.toLowerCase();
    if (options.account !== undefined && sameAddress(token, options.account)) {
      throw new Error(`${where}.token is the account itself`);
    }
    if (token !== SPENDING_LIMIT_NATIVE_TOKEN && known && !known.includes(token)) {
      throw new Error(`${where}.token ${limit.token} is not a known token`);
    }
    if (seen.has(token)) throw new Error(`${where}.token ${limit.token} appears twice`);
    seen.add(token);
    if (typeof limit.allowance !== 'bigint' || limit.allowance <= 0n || limit.allowance > MAX_UINT256) {
      throw new Error(`${where}.allowance must be a positive uint256 bigint`);
    }
  });
}

/** onInstall data: abi.encode(bytes[]) where each element is token (20 bytes) || allowance (32 bytes) [P onInstall]. */
export function encodeSpendingLimitHookInitData(limits: SpendingLimit[]): Uint8Array {
  validateSpendingLimits(limits);
  const entries: AbiValue[] = limits.map((l) => ({
    kind: 'bytes',
    value: concatBytes(toBytes(l.token), toWord(l.allowance)),
  }));
  return encodeSequence([{ kind: 'array', items: entries }]);
}

/** Kernel hookData for the hook: flag byte || init data; byte-identical to @zerodev/hooks getEnableData [S]. */
export function encodeSpendingLimitHookData(limits: SpendingLimit[], flag = SPENDING_LIMIT_SDK_HOOK_FLAG): Uint8Array {
  if (!Number.isInteger(flag) || flag < 0 || flag > 0xff) throw new Error('flag must be one byte');
  return concatBytes(new Uint8Array([flag]), encodeSpendingLimitHookInitData(limits));
}

export interface RootHookInstallOptions {
  hook?: string;
  ecdsaValidator?: string;
}

/**
 * installModule(1, ecdsaValidator, hook || abi.encode(validatorData = owner,
 * hookData, selectorData = 0x)): installs the ROOT ECDSA validator again with
 * the hook in its validation config [K installModule,
 * InstallValidatorDataFormat, _installValidation]. The DEPLOYED ECDSA
 * validator (0x845A…cE57, Sourcify full match on chain 1) reverts
 * AlreadyInitialized(account) when the account already has an owner — unlike
 * the v3.3 repository file — so this call only works after the stored owner
 * was cleared in the same batch; use rootSpendingLimitInstallCalls. The
 * re-install writes `owner` as the new owner, so `owner` MUST be the current
 * owner — a different address here hands the account to that address.
 * prepareRootSpendingLimitInstall reads and checks it.
 */
export function encodeRootSpendingLimitInstall(
  owner: string,
  limits: SpendingLimit[],
  options: RootHookInstallOptions = {},
): Uint8Array {
  requireAddress(owner, 'owner');
  if (sameAddress(owner, ZERO_ADDRESS)) throw new Error('owner must not be the zero address');
  const hook = options.hook ?? ZERODEV_SPENDING_LIMIT_HOOK.address;
  const validator = options.ecdsaValidator ?? KERNEL_V3_3.ecdsaValidator;
  requireAddress(hook, 'hook');
  requireAddress(validator, 'ecdsaValidator');
  const initData = concatBytes(
    toBytes(hook),
    encodeSequence([
      { kind: 'bytes', value: toBytes(owner) },
      { kind: 'bytes', value: encodeSpendingLimitHookData(limits) },
      { kind: 'bytes', value: new Uint8Array(0) },
    ]),
  );
  return encodeFunctionCall('installModule(uint256,address,bytes)', [
    { kind: 'uint256', value: BigInt(KERNEL_MODULE_TYPE_VALIDATOR) },
    { kind: 'address', value: validator },
    { kind: 'bytes', value: initData },
  ]);
}

/**
 * The root install as one atomic batch for a ROOT-signed operation (or the
 * owner EOA's direct execute): ecdsaValidator.onUninstall("") called by the
 * account (clears the stored owner, as the recovery module does), then
 * account.installModule(1, ecdsaValidator, hook || …) restoring the same owner
 * with the hook attached. If either call fails the batch reverts and the
 * owner is unchanged.
 */
export function rootSpendingLimitInstallCalls(
  account: string,
  owner: string,
  limits: SpendingLimit[],
  options: RootHookInstallOptions = {},
): Call[] {
  requireAddress(account, 'account');
  validateSpendingLimits(limits, { account });
  if (sameAddress(owner, account)) throw new Error('owner must not be the account itself');
  const validator = options.ecdsaValidator ?? KERNEL_V3_3.ecdsaValidator;
  requireAddress(validator, 'ecdsaValidator');
  return [
    { to: validator, value: 0n, data: encodeFunctionCall('onUninstall(bytes)', [{ kind: 'bytes', value: new Uint8Array(0) }]) },
    { to: account, value: 0n, data: encodeRootSpendingLimitInstall(owner, limits, options) },
  ];
}

/**
 * uninstallModule(4, hook, 0x): clears the hook from the ROOT validation
 * (sets it to "none") and calls hook.onUninstall, which deletes the stored
 * limits [K uninstallModule; P onUninstall]. With the deployed ZeroDev hook on
 * Kernel v3.3 this can NOT run as a UserOperation (the hooked operation would
 * revert in postCheck); the owner EOA must send it directly: a transaction
 * to the account with data = this calldata, which Kernel accepts from the
 * root owner [K onlyEntryPointOrSelfOrRoot].
 */
export function encodeSpendingLimitHookRemoval(hook: string = ZERODEV_SPENDING_LIMIT_HOOK.address): Uint8Array {
  requireAddress(hook, 'hook');
  return encodeFunctionCall('uninstallModule(uint256,address,bytes)', [
    { kind: 'uint256', value: BigInt(KERNEL_MODULE_TYPE_HOOK) },
    { kind: 'address', value: hook },
    { kind: 'bytes', value: new Uint8Array(0) },
  ]);
}

/** The removal as a self-call (for a root UserOperation, valid only for a hook whose postCheck Kernel can call). */
export function spendingLimitHookRemovalCall(account: string, hook: string = ZERODEV_SPENDING_LIMIT_HOOK.address): Call {
  requireAddress(account, 'account');
  return { to: account, value: 0n, data: encodeSpendingLimitHookRemoval(hook) };
}

/**
 * Replacing limits: the hook has no setter and onInstall reverts "already
 * initialized" [P], so an update is removal followed by a fresh root
 * re-install (rootSpendingLimitInstallCalls). Send these from the OWNER EOA as one direct transaction
 * {to: account, data: encodeKernelExecute(calls)}; inside a hooked
 * UserOperation the postCheck would compare the new list against the old
 * pre-balances.
 */
export function spendingLimitUpdateCalls(
  account: string,
  owner: string,
  limits: SpendingLimit[],
  options: RootHookInstallOptions = {},
): Call[] {
  validateSpendingLimits(limits, { account });
  const hook = options.hook ?? ZERODEV_SPENDING_LIMIT_HOOK.address;
  return [spendingLimitHookRemovalCall(account, hook), ...rootSpendingLimitInstallCalls(account, owner, limits, options)];
}

/** callData for a validation that carries a hook: executeUserOp selector || inner call (e.g. execute(...)) [K validateUserOp, S encodeExecuteCall]. */
export function kernelHookedCallData(innerCallData: Uint8Array): Uint8Array {
  if (innerCallData.length < 4) throw new Error('inner callData must start with a selector');
  return concatBytes(toBytes(KERNEL_EXECUTE_USER_OP_SELECTOR), innerCallData);
}

export interface HookInterfaceAssessment {
  hook: string;
  hasCode: boolean;
  codeKeccak: string;
  /** The code equals the pinned ZeroDev SpendingLimit deployment. */
  isZeroDevSpendingLimit: boolean;
  /** A PUSH4 of postCheck(bytes) appears in the code (Solidity dispatcher heuristic). */
  implementsKernelV31PostCheck: boolean;
  /** A PUSH4 of postCheck(bytes,bool,bytes) appears in the code. */
  implementsKernelV30PostCheck: boolean;
  /** Usable as a Kernel v3.1 – v3.3 hook. Always false for the pinned ZeroDev deployment (source-verified [E]). */
  compatibleWithKernelV3_3: boolean;
}

/**
 * Checks whether a hook can be called by Kernel v3.1+ at all. For the pinned
 * ZeroDev deployment the answer comes from its verified source [E]; for any
 * other contract it is a bytecode heuristic (Solidity dispatchers compare the
 * selector with PUSH4), good enough to refuse but NOT a proof of
 * compatibility — a new hook needs its own source binding and audit.
 */
export async function assessHookInterface(node: JsonRpcTransport, hook: string): Promise<HookInterfaceAssessment> {
  requireAddress(hook, 'hook');
  const code = toBytes((await node('eth_getCode', [hook, 'latest'])) as string);
  const codeKeccak = toHex(keccak(code));
  const isZeroDev = codeKeccak === ZERODEV_SPENDING_LIMIT_HOOK.runtimeCodeKeccak;
  const v31 = containsPush4(code, HOOK_POSTCHECK_KERNEL_V3_1);
  const v30 = containsPush4(code, HOOK_POSTCHECK_KERNEL_V3_0);
  return {
    hook: checksum(hook),
    hasCode: code.length > 0,
    codeKeccak,
    isZeroDevSpendingLimit: isZeroDev,
    implementsKernelV31PostCheck: v31,
    implementsKernelV30PostCheck: v30,
    compatibleWithKernelV3_3: code.length > 0 && !isZeroDev && v31,
  };
}

export class SpendingLimitHookIncompatibleError extends Error {
  constructor(public readonly assessment: HookInterfaceAssessment) {
    super(
      assessment.isZeroDevSpendingLimit
        ? `The ZeroDev SpendingLimit hook ${assessment.hook} implements the Kernel v3.0 postCheck(bytes,bool,bytes) ` +
            `(${HOOK_POSTCHECK_KERNEL_V3_0}) but Kernel v3.3 calls postCheck(bytes) (${HOOK_POSTCHECK_KERNEL_V3_1}); ` +
            'every operation through it would revert. Refused.'
        : !assessment.hasCode
          ? `No contract at ${assessment.hook}. Refused.`
          : `${assessment.hook} does not implement postCheck(bytes) (${HOOK_POSTCHECK_KERNEL_V3_1}), which Kernel v3.3 calls. Refused.`,
    );
    this.name = 'SpendingLimitHookIncompatibleError';
  }
}

export interface SpendingLimitHookState {
  hook: string;
  /** listLength(account) > 0. */
  initialized: boolean;
  /** Remaining allowance per entry, in the hook's list order. */
  limits: SpendingLimit[];
  rootValidator: string;
  /** validationConfig(rootValidator).hook; KERNEL_HOOK_NONE when none. */
  rootHook: string;
  /** The hook is attached to the root validation (it binds the owner's UserOperations — never the owner's direct calls). */
  attachedToRoot: boolean;
}

/** Reads the hook's stored list for the account and the root validation's hook [P listLength/spendingLimit; K validationConfig]. */
export async function readSpendingLimitHookState(
  node: JsonRpcTransport,
  account: string,
  hook: string = ZERODEV_SPENDING_LIMIT_HOOK.address,
): Promise<SpendingLimitHookState> {
  requireAddress(account, 'account');
  requireAddress(hook, 'hook');
  const lengthWord = await ethCall(node, hook, encodeFunctionCall('listLength(address)', [{ kind: 'address', value: account }]));
  const length = word(lengthWord, 0);
  if (length > BigInt(MAX_SPENDING_LIMIT_ENTRIES * 4)) throw new Error(`Unexpected list length ${length}`);
  const limits: SpendingLimit[] = [];
  for (let i = 0n; i < length; i++) {
    const entry = await ethCall(
      node,
      hook,
      encodeFunctionCall('spendingLimit(uint256,address)', [
        { kind: 'uint256', value: i },
        { kind: 'address', value: account },
      ]),
    );
    if (entry.length !== 64) throw new Error('spendingLimit() returned an unexpected shape');
    limits.push({ token: addressAt(entry, 0), allowance: word(entry, 1) });
  }
  const root = await ethCall(node, account, encodeFunctionCall('rootValidator()', []));
  if (root.length !== 32) throw new Error('rootValidator() did not return one word; is this a Kernel v3 account?');
  const rootValidator = root.slice(0, 21);
  const config = await ethCall(
    node,
    account,
    encodeFunctionCall('validationConfig(bytes21)', [{ kind: 'fixedBytes', value: rootValidator }]),
  );
  if (config.length !== 64) throw new Error('validationConfig() returned an unexpected shape');
  const rootHook = addressAt(config, 1);
  return {
    hook: checksum(hook),
    initialized: length > 0n,
    limits,
    rootValidator: toHex(rootValidator),
    rootHook,
    attachedToRoot: sameAddress(rootHook, hook),
  };
}

/**
 * Confirms every ERC-20 in the list is a contract that answers
 * balanceOf(account) with one word: the hook calls balanceOf in preCheck and
 * postCheck of every hooked operation, so a bad token would make all of them
 * revert.
 */
export async function verifySpendingTokens(node: JsonRpcTransport, account: string, tokens: string[]): Promise<void> {
  for (const token of tokens) {
    requireAddress(token, 'token');
    if (sameAddress(token, SPENDING_LIMIT_NATIVE_TOKEN)) continue;
    const code = (await node('eth_getCode', [token, 'latest'])) as string;
    if (!code || code === '0x') throw new Error(`Token ${token} has no contract code`);
    let result: Uint8Array;
    try {
      result = await ethCall(node, token, encodeFunctionCall('balanceOf(address)', [{ kind: 'address', value: account }]));
    } catch (error) {
      throw new Error(`Token ${token} balanceOf(account) failed: ${(error as Error).message}`);
    }
    if (result.length !== 32) throw new Error(`Token ${token} balanceOf(account) did not return one word`);
  }
}

export interface PreparedRootSpendingLimitInstall {
  /** Batch for a ROOT-signed UserOperation (plain execute: the root validation has no hook yet). */
  calls: Call[];
  limits: SpendingLimit[];
  owner: string;
  hook: string;
  assessment: HookInterfaceAssessment;
}

/**
 * Builds the root install after every check that can be done read-only:
 * limits valid; tokens are contracts answering balanceOf; the account's root
 * is the ECDSA validator and its stored owner equals `owner`; the root
 * validation has no hook yet; the hook holds no stale list for this account
 * (with the SDK flag an initialized hook would silently keep the old list);
 * and the hook implements Kernel v3.1+'s postCheck — which REFUSES the
 * deployed ZeroDev hook (SpendingLimitHookIncompatibleError).
 */
export async function prepareRootSpendingLimitInstall(
  node: JsonRpcTransport,
  params: {
    account: string;
    owner: string;
    limits: SpendingLimit[];
    knownTokens?: string[];
    hook?: string;
    ecdsaValidator?: string;
  },
): Promise<PreparedRootSpendingLimitInstall> {
  const { account, owner, limits } = params;
  requireAddress(account, 'account');
  requireAddress(owner, 'owner');
  const hook = params.hook ?? ZERODEV_SPENDING_LIMIT_HOOK.address;
  const ecdsaValidator = params.ecdsaValidator ?? KERNEL_V3_3.ecdsaValidator;
  validateSpendingLimits(limits, { account, ...(params.knownTokens ? { knownTokens: params.knownTokens } : {}) });
  const assessment = await assessHookInterface(node, hook);
  if (!assessment.compatibleWithKernelV3_3) throw new SpendingLimitHookIncompatibleError(assessment);
  const ownerState = await readKernelOwner(node, account, ecdsaValidator);
  if (!ownerState.ecdsaRoot) throw new Error(`The root validator of ${account} is not the ECDSA validator ${ecdsaValidator}`);
  if (!sameAddress(ownerState.owner, owner)) {
    throw new Error(`The stored owner ${ownerState.owner} is not ${owner}; re-installing with a wrong owner would hand over the account`);
  }
  const state = await readSpendingLimitHookState(node, account, hook);
  if (!sameAddress(state.rootHook, KERNEL_HOOK_NONE)) {
    throw new Error(`The root validation already has hook ${state.rootHook}`);
  }
  if (state.initialized) throw new Error(`The hook already holds a limit list for ${account}; remove it first`);
  await verifySpendingTokens(node, account, limits.map((l) => l.token));
  return {
    calls: rootSpendingLimitInstallCalls(account, owner, limits, { hook, ecdsaValidator }),
    limits: limits.map((l) => ({ token: checksum(l.token), allowance: l.allowance })),
    owner: checksum(owner),
    hook: assessment.hook,
    assessment,
  };
}

/** Signed balance change of the account for one token over one operation's execution (after − before). */
export interface TokenBalanceDelta {
  token: string;
  delta: bigint;
}

export interface HookCheckEntry {
  token: string;
  remaining: bigint;
  /** Balance decrease the hook would charge (0 when the balance did not decrease). */
  used: bigint;
  remainingAfter: bigint;
  exceeds: boolean;
}

export interface HookCheckResult {
  /** True when the hook's postCheck would revert ExceedsAllowance. */
  exceeds: boolean;
  entries: HookCheckEntry[];
}

/**
 * Local mirror of SpendingLimit.postCheck [P d9aaeaa]: for every listed token,
 * a balance that did not decrease is skipped; otherwise used = decrease, and
 * used > allowance reverts ExceedsAllowance; else the allowance drops by
 * used. Balances are NET over the execution (an incoming transfer of the same
 * token in the same operation offsets an outgoing one) and exclude gas, which
 * EntryPoint charges in validation, before preCheck. Unlisted tokens are
 * ignored, exactly as on-chain.
 */
export function checkSpendingAgainstHook(remaining: SpendingLimit[], deltas: TokenBalanceDelta[]): HookCheckResult {
  const net = new Map<string, bigint>();
  for (const d of deltas) {
    requireAddress(d.token, 'delta token');
    if (typeof d.delta !== 'bigint') throw new Error('delta must be a bigint');
    const key = d.token.toLowerCase();
    net.set(key, (net.get(key) ?? 0n) + d.delta);
  }
  const entries = remaining.map((limit) => {
    const delta = net.get(limit.token.toLowerCase()) ?? 0n;
    const used = delta < 0n ? -delta : 0n;
    const exceeds = used > limit.allowance;
    return {
      token: checksum(limit.token),
      remaining: limit.allowance,
      used,
      remainingAfter: exceeds ? limit.allowance : limit.allowance - used,
      exceeds,
    };
  });
  return { exceeds: entries.some((e) => e.exceeds), entries };
}

/**
 * Converts simulated asset changes (simulateAssetChanges, which reports
 * native transfers via traceTransfers and ERC-20 Transfer events) into net
 * balance deltas for `account`. Only native and ERC-20 changes count; NFTs
 * and approvals do not move a fungible balance. Native ETH maps to
 * SPENDING_LIMIT_NATIVE_TOKEN.
 */
export function balanceDeltasFromAssetChanges(changes: AssetChange[], account: string): TokenBalanceDelta[] {
  requireAddress(account, 'account');
  const out = new Map<string, bigint>();
  for (const change of changes) {
    if (change.type !== 'native' && change.type !== 'erc20') continue;
    const token = change.type === 'native' ? SPENDING_LIMIT_NATIVE_TOKEN : change.token.toLowerCase();
    let delta = 0n;
    if (sameAddress(change.from, account)) delta -= change.amount;
    if (sameAddress(change.to, account)) delta += change.amount;
    out.set(token, (out.get(token) ?? 0n) + delta);
  }
  return [...out.entries()].map(([token, delta]) => ({ token: checksum(token), delta }));
}

// ---------------------------------------------------------------------------
// Part B — client-side spending policy (wallet-enforced only)
// ---------------------------------------------------------------------------

/** A per-token cap per rolling window. Enforced by this wallet's software only. */
export interface SpendingPolicyRule {
  /** ERC-20 contract, or SPENDING_LIMIT_NATIVE_TOKEN for native ETH. */
  token: string;
  /** Maximum outflow within any window of `windowSeconds`, in base units. */
  cap: bigint;
  windowSeconds: number;
}

/** One past outflow from the account, recorded by the wallet after an operation it sent was included. */
export interface SpendingRecord {
  token: string;
  amount: bigint;
  /** Unix seconds (inclusion time, or send time if unknown). */
  at: number;
}

export const SPENDING_POLICY_MIN_WINDOW_SECONDS = 60;
export const SPENDING_POLICY_MAX_WINDOW_SECONDS = 366 * 24 * 60 * 60;

/** Same refusals as validateSpendingLimits plus window bounds; one rule per (token, window). */
export function validateSpendingPolicy(rules: SpendingPolicyRule[], options: SpendingLimitValidationOptions = {}): void {
  if (!Array.isArray(rules) || rules.length === 0) throw new Error('At least one spending rule is required');
  const known = options.knownTokens?.map((t) => {
    requireAddress(t, 'knownTokens entry');
    return t.toLowerCase();
  });
  const seen = new Set<string>();
  rules.forEach((rule, i) => {
    const where = `rules[${i}]`;
    requireAddress(rule.token, `${where}.token`);
    const token = rule.token.toLowerCase();
    if (options.account !== undefined && sameAddress(token, options.account)) {
      throw new Error(`${where}.token is the account itself`);
    }
    if (token !== SPENDING_LIMIT_NATIVE_TOKEN && known && !known.includes(token)) {
      throw new Error(`${where}.token ${rule.token} is not a known token`);
    }
    if (typeof rule.cap !== 'bigint' || rule.cap <= 0n || rule.cap > MAX_UINT256) {
      throw new Error(`${where}.cap must be a positive uint256 bigint`);
    }
    if (
      !Number.isSafeInteger(rule.windowSeconds) ||
      rule.windowSeconds < SPENDING_POLICY_MIN_WINDOW_SECONDS ||
      rule.windowSeconds > SPENDING_POLICY_MAX_WINDOW_SECONDS
    ) {
      throw new Error(
        `${where}.windowSeconds must be between ${SPENDING_POLICY_MIN_WINDOW_SECONDS} and ${SPENDING_POLICY_MAX_WINDOW_SECONDS}`,
      );
    }
    const key = `${token}:${rule.windowSeconds}`;
    if (seen.has(key)) throw new Error(`${where} duplicates an earlier (token, window) rule`);
    seen.add(key);
  });
}

export interface SpendingPolicyEntry {
  token: string;
  windowSeconds: number;
  cap: bigint;
  /** Outflows recorded inside (now − windowSeconds, now]. */
  spentInWindow: bigint;
  proposed: bigint;
  remainingAfter: bigint;
  exceeds: boolean;
}

export interface SpendingPolicyDecision {
  allowed: boolean;
  /** Always 'client-side': nothing on-chain enforces this policy. */
  enforcement: 'client-side';
  entries: SpendingPolicyEntry[];
}

/**
 * Would `proposed` (outflows, e.g. the negated negative deltas of
 * balanceDeltasFromAssetChanges) break any rule given the recorded history?
 * A record counts for a rule when now − windowSeconds < at ≤ now. Records in
 * the future (clock skew) count as inside the window, the conservative side.
 */
export function evaluateSpendingPolicy(
  rules: SpendingPolicyRule[],
  history: SpendingRecord[],
  proposed: Array<{ token: string; amount: bigint }>,
  now: number = Math.floor(Date.now() / 1000),
): SpendingPolicyDecision {
  validateSpendingPolicy(rules);
  for (const p of proposed) {
    requireAddress(p.token, 'proposed token');
    if (typeof p.amount !== 'bigint' || p.amount < 0n) throw new Error('proposed amounts must be non-negative bigints');
  }
  for (const r of history) {
    requireAddress(r.token, 'history token');
    if (typeof r.amount !== 'bigint' || r.amount < 0n) throw new Error('history amounts must be non-negative bigints');
    if (!Number.isSafeInteger(r.at)) throw new Error('history times must be integers');
  }
  const entries = rules.map((rule) => {
    const token = rule.token.toLowerCase();
    const spentInWindow = history
      .filter((r) => r.token.toLowerCase() === token && r.at > now - rule.windowSeconds)
      .reduce((sum, r) => sum + r.amount, 0n);
    const amount = proposed.filter((p) => p.token.toLowerCase() === token).reduce((sum, p) => sum + p.amount, 0n);
    const total = spentInWindow + amount;
    const exceeds = total > rule.cap;
    return {
      token: checksum(rule.token),
      windowSeconds: rule.windowSeconds,
      cap: rule.cap,
      spentInWindow,
      proposed: amount,
      remainingAfter: exceeds ? 0n : rule.cap - total,
      exceeds,
    };
  });
  return { allowed: !entries.some((e) => e.exceeds), enforcement: 'client-side', entries };
}

/** Outflows (positive amounts) from balance deltas; inflows are dropped. */
export function outflowsFromDeltas(deltas: TokenBalanceDelta[]): Array<{ token: string; amount: bigint }> {
  return deltas.filter((d) => d.delta < 0n).map((d) => ({ token: d.token, amount: -d.delta }));
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** True when code contains PUSH4 (0x63) followed by the selector. */
function containsPush4(code: Uint8Array, selectorHex: string): boolean {
  const sel = toBytes(selectorHex);
  for (let i = 0; i + 4 < code.length; i++) {
    if (code[i] === 0x63 && code[i + 1] === sel[0] && code[i + 2] === sel[1] && code[i + 3] === sel[2] && code[i + 4] === sel[3]) {
      return true;
    }
  }
  return false;
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

function checksum(address: string): string {
  return toChecksumAddress(toBytes(address));
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** The root ECDSA validation id (0x01 || validator), for callers that compare readSpendingLimitHookState.rootValidator. */
export function ecdsaRootValidationId(ecdsaValidator: string = KERNEL_V3_3.ecdsaValidator): string {
  return toHex(kernelValidatorId(ecdsaValidator));
}
