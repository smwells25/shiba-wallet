import { secp256k1 } from '@noble/curves/secp256k1.js';
import { concatBytes } from '@noble/hashes/utils.js';
import {
  publicKeyToEvmAddress,
  toChecksumAddress,
  type DerivedAccount,
} from '@shiba-wallet/core';
import { encodeFunctionCall, encodeSequence, selector as abiSelector, type AbiValue } from './abi.js';
import { keccak, toBytes, toHex, toWord } from './encoding.js';
import { typedDataDigest, type TypedDataTypes } from './eip712.js';
import { KERNEL_EIP712_NAME, KERNEL_V3_3, encodeKernelExecute } from './kernel-account.js';
import type { JsonRpcTransport } from './rpc.js';
import {
  toEthSignedMessageHash,
  withEthereumV,
  type Call,
  type SmartAccountSpec,
} from './smart-account.js';
import { ENTRYPOINT_V07 } from './userop.js';

/**
 * Session keys for Kernel v3.3 through Kernel's PERMISSION validation type
 * (one signer module + N policy modules), built on ZeroDev's deployed
 * permission plugins. A session key is a fresh secp256k1 key that may sign
 * UserOperations for an already-deployed Kernel account, but only within the
 * limits that the account itself enforces on-chain (allowed calls, value
 * caps, a validity window, optionally a gas budget and a rate limit). The
 * seed-derived owner stays the root validator (ADR D1); a grant is an
 * additive, revocable delegation.
 *
 * Every layout below was taken from primary sources fetched 2026-10-01:
 *
 *  [K] github.com/zerodevapp/kernel, tag v3.3, commit
 *      cd697c7e21715d015e0643af22310a99aa17433b:
 *      src/core/ValidationManager.sol (_installValidation, _installPermission,
 *      _enableMode, _enableValidationWithSig, _enableDigest, _verifyEnableSig,
 *      _configureSelector, _checkUserOpPolicy, _uninstallPermission,
 *      _verifySignature), src/Kernel.sol (validateUserOp, installValidations,
 *      grantAccess, uninstallValidation), src/utils/ValidationTypeLib.sol
 *      (encodeAsNonceKey, decodeNonce, permissionToIdentifier,
 *      encodePolicyData), src/types/{Constants,Structs,Types}.sol.
 *  [S] github.com/zerodevapp/sdk commit
 *      cd7c05b53b6ae6bede7dfefe9e59fbddfadf0c0a: plugins/permission
 *      (toPermissionValidator.ts, toInitConfig.ts, policies/*, signers/*,
 *      constants.ts), packages/core accounts/kernel/utils/plugins/ep0_7
 *      (getEncodedPluginsData.ts, getPluginsEnableTypedData.ts) and
 *      accounts/utils/toKernelPluginManager.ts (getNonceKey). The published
 *      npm packages @zerodev/permissions 5.6.3 / @zerodev/sdk 5.5.10 with
 *      viem 2.57.2 were used (scratchpad only) as the independent reference
 *      encoder; tests pin their outputs byte for byte.
 *  [P] Deployed plugin sources. The plugin repository
 *      github.com/zerodevapp/kernel-7579-plugins no longer carries the
 *      deployed policies on its default branch (commit 332deed6, 2026-04-21,
 *      is a rewrite), so each deployed contract was tied to source as follows:
 *        - ECDSASigner, CallPolicy v0.0.4, GasPolicy, RateLimitPolicy,
 *          SudoPolicy: Sourcify "full match" (creation and runtime) on chain 1,
 *          sources read from sourcify.dev/server/v2/contract/1/{address}.
 *        - TimestampPolicy: not verified on Sourcify or Etherscan; its runtime
 *          bytecode was reproduced byte for byte by compiling
 *          kernel-7579-plugins commit d4855f5
 *          policies/timestamp/src/TimestampPolicy.sol (unchanged since 6e4db07,
 *          2024-04-09) against kernel commit 49842d56 (the submodule it pins)
 *          with solc 0.8.24, via-IR, optimizer runs 200, evmVersion paris,
 *          no CBOR metadata (the settings Sourcify records for its siblings).
 *      The runtime code at every address below is identical on Ethereum
 *      mainnet and Sepolia (eth_getCode compared 2026-10-01 against
 *      ethereum.publicnode.com and ethereum-sepolia-rpc.publicnode.com).
 *
 * AUDIT STATUS (as published, not inferred): ZeroDev's docs state "All ZeroDev
 * contracts and plugins are audited unless otherwise noted" and link to
 * github.com/zerodevapp/kernel/tree/dev/audits, which returned 404 on
 * 2026-10-01. The reports in the kernel repository history (commit
 * da0cf196 / main b592236) do NOT list these policies or ECDSASigner in
 * scope: ChainLight's Kernel v3.0 report covers the core (including the
 * permission machinery inside Kernel), "kalos_v3_plugins.pdf" is titled
 * "ZeroDev Kernel V3 Factory Security Assessment" with scope FactoryStaker
 * and KernelFactory only, and the v3.1 incremental audit covers the WebAuthn
 * and weighted validators, the SpendingLimit hook and the Kernel 3.0 -> 3.x
 * diff. Treat the plugins below as UNAUDITED for mainnet purposes until a
 * report naming them is found. Licensing: the plugin repository's LICENSE is
 * MIT (since 2024-05-06), but the verified SudoPolicy source carries
 * "SPDX-License-Identifier: UNLICENSED"; the other verified sources carry no
 * SPDX line.
 */

/**
 * Deployed ZeroDev permission modules (identical addresses and runtime code
 * on Ethereum mainnet and Sepolia). Addresses from [S]
 * plugins/permission/constants.ts; code confirmed on-chain 2026-10-01; see
 * [P] for how each was tied to source.
 *
 * CallPolicy v0.0.4 is pinned (not v0.0.5) because it is the version
 * ZeroDev's own call-policy documentation uses
 * (docs.zerodev.app/smart-accounts/permissions/policies/call) and its source
 * is verified; v0.0.5 (0x85770b90…EaDd2, adds SLICE_EQUAL) has code on both
 * chains but no verified source anywhere we could find.
 */
export const KERNEL_PERMISSION_MODULES = {
  /** ECDSASigner: one secp256k1 signer per (permission id, account). */
  ecdsaSigner: '0x6A6F069E2a08c2468e7724Ab3250CdBFBA14D4FF',
  /** CallPolicy v0.0.4: (callType, target, selector) allowlist with value caps and parameter rules. */
  callPolicy: '0x9a52283276A0ec8740DF50bF01B28A80D880eaf2',
  /** TimestampPolicy: validAfter / validUntil returned as ERC-4337 validation data. */
  timestampPolicy: '0xB9f8f524bE6EcD8C945b1b87f9ae5C192FdCE20F',
  /** GasPolicy: total gas budget in wei across all operations. */
  gasPolicy: '0xaeFC5AbC67FfD258abD0A3E54f65E70326F84b23',
  /** RateLimitPolicy: N operations, each at least `interval` seconds after the previous slot. */
  rateLimitPolicy: '0xf63d4139B25c836334edD76641356c6b74C86873',
  /** SudoPolicy: allows everything. Never used by SessionKeyGrant; exposed for completeness. */
  sudoPolicy: '0x67b436caD8a6D025DF6C82C5BB43fbF11fC5B9B7',
} as const;

export type KernelPermissionModules = { -readonly [K in keyof typeof KERNEL_PERMISSION_MODULES]: string };

/** Kernel validation modes and the permission validation type [K Constants.sol]. */
export const KERNEL_VALIDATION_MODE_DEFAULT = 0x00;
export const KERNEL_VALIDATION_MODE_ENABLE = 0x01;
export const KERNEL_VALIDATION_TYPE_PERMISSION = 0x02;

/**
 * keccak256("Enable(bytes21 validationId,uint32 nonce,address hook,bytes
 * validatorData,bytes hookData,bytes selectorData)") — ENABLE_TYPE_HASH in
 * [K Constants.sol]; the type string is [S getPluginsEnableTypedData.ts] and
 * the tests recompute the hash.
 */
export const KERNEL_ENABLE_TYPE_HASH = '0xb17ab1224aca0d4255ef8161acaf2ac121b8faa32a4b2258c912cc5f8308c505';

const ENABLE_TYPES: TypedDataTypes = {
  Enable: [
    { name: 'validationId', type: 'bytes21' },
    { name: 'nonce', type: 'uint32' },
    { name: 'hook', type: 'address' },
    { name: 'validatorData', type: 'bytes' },
    { name: 'hookData', type: 'bytes' },
    { name: 'selectorData', type: 'bytes' },
  ],
};

/** execute(bytes32,bytes): the only selector a session permission is granted. */
export const KERNEL_EXECUTE_SELECTOR = toHex(abiSelector('execute(bytes32,bytes)'));

/**
 * PassFlag bits [K Constants.sol]: SKIP_USEROP = 0x0001, SKIP_SIGNATURE =
 * 0x0002. On the SIGNER entry the flag becomes the permission's flag:
 * _validateUserOp reverts when SKIP_USEROP is set and _verifySignature
 * (ERC-1271) reverts when SKIP_SIGNATURE is set. Session grants built here
 * ALWAYS set SKIP_SIGNATURE, so a session key can never produce an ERC-1271
 * signature for the account (otherwise it could sign, for example, an
 * off-chain token permit that no call policy would ever see). The ZeroDev
 * SDK's default is 0x0000 (both allowed); this is a deliberate divergence.
 */
export const KERNEL_PASS_FLAG_ALL = 0x0000;
export const KERNEL_PASS_FLAG_SKIP_USEROP = 0x0001;
export const KERNEL_PASS_FLAG_SKIP_SIGNATURE = 0x0002;

/** Prefix byte that separates the (empty) policy signatures from the signer's signature [K _checkUserOpPolicy]. */
export const KERNEL_PERMISSION_SIGNER_PREFIX = 0xff;

/**
 * ZeroDev SDK DUMMY_ECDSA_SIG [S packages/core/constants.ts], the same stub
 * the root Kernel spec uses: recoverable for any digest (solady's recover
 * reverts on garbage), recovering to an address that is not the signer.
 */
const DUMMY_ECDSA_SIGNATURE =
  '0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
/** EntryPoint v0.7 NonceManager.getNonce [account-abstraction v0.7.0 NonceManager.sol]. */
const GET_NONCE_SIGNATURE = 'getNonce(address,uint192)';
const MAX_UINT48 = (1n << 48n) - 1n;
const MAX_UINT64 = (1n << 64n) - 1n;
const MAX_UINT128 = (1n << 128n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;

// ---------------------------------------------------------------------------
// Vendor-neutral grant
// ---------------------------------------------------------------------------

/**
 * Parameter conditions of CallPolicy v0.0.4 [P CallPolicy.sol enum
 * ParamCondition, in order]: EQUAL 0, GREATER_THAN 1, LESS_THAN 2,
 * GREATER_THAN_OR_EQUAL 3, LESS_THAN_OR_EQUAL 4, NOT_EQUAL 5, ONE_OF 6.
 * Comparisons are on the raw 32-byte word (unsigned).
 */
export type SessionParamCondition =
  | 'equal'
  | 'greaterThan'
  | 'lessThan'
  | 'greaterThanOrEqual'
  | 'lessThanOrEqual'
  | 'notEqual'
  | 'oneOf';

const PARAM_CONDITION_CODES: Record<SessionParamCondition, number> = {
  equal: 0,
  greaterThan: 1,
  lessThan: 2,
  greaterThanOrEqual: 3,
  lessThanOrEqual: 4,
  notEqual: 5,
  oneOf: 6,
};

export interface SessionParamRule {
  condition: SessionParamCondition;
  /**
   * Byte offset of the 32-byte argument word, counted from the first byte
   * AFTER the 4-byte selector (CallPolicy reads data[4 + offset : 4 + offset
   * + 32]); argument i of a static-argument function is at 32 * i.
   */
  offset: number;
  /** 32-byte words (0x + 64 hex). Exactly one, except 'oneOf' (one or more). */
  params: string[];
}

export interface SessionAllowedCall {
  /** Exact call target. The zero address (a CallPolicy wildcard) is refused. */
  target: string;
  /**
   * 4-byte function selector, or null for a call with EMPTY calldata (a
   * plain value transfer). CallPolicy keys a call with empty calldata as
   * selector 0x00000000; note that calldata that merely STARTS with four zero
   * bytes matches the same entry, so prefer null-selector entries for EOAs.
   */
  selector: string | null;
  /** Maximum msg.value per call, in wei (0 = no value). A per-call cap, not a cumulative allowance. */
  valueLimit: bigint;
  /** Optional argument constraints; refused when selector is null. */
  rules?: SessionParamRule[];
}

/**
 * A delegated, on-chain-enforced session: vendor-neutral and serializable
 * (see serializeSessionKeyGrant). Mapped to Kernel's permission install data
 * by kernelPermissionFromGrant.
 */
export interface SessionKeyGrant {
  /** The session signer's address (a fresh device- or dApp-held key, never the seed). */
  sessionKey: string;
  /** The only calls the session may make. Must not be empty. */
  calls: SessionAllowedCall[];
  /** Unix seconds before which the session is invalid (0 = immediately). */
  validAfter: number;
  /** Unix seconds after which the session is invalid. Mandatory: no open-ended sessions. */
  validUntil: number;
  /**
   * Optional total gas budget in wei across all of the session's operations.
   * GasPolicy charges (preVerificationGas + verificationGasLimit +
   * callGasLimit) * maxFeePerGas per operation, i.e. the worst case before
   * paymaster gas, and refuses an operation that would exceed the remainder.
   */
  gasBudgetWei?: bigint;
  /**
   * Optional rate limit: at most `count` operations, each valid no earlier
   * than `intervalSeconds` after the previous slot (RateLimitPolicy returns
   * validAfter = startAt, then advances startAt by the interval).
   */
  rateLimit?: { count: number; intervalSeconds: number; startAt?: number };
}

/** JSON-safe form of a SessionKeyGrant (bigints as decimal strings). */
export interface SerializedSessionKeyGrant {
  version: 1;
  sessionKey: string;
  calls: Array<{ target: string; selector: string | null; valueLimit: string; rules?: SessionParamRule[] }>;
  validAfter: number;
  validUntil: number;
  gasBudgetWei?: string;
  rateLimit?: { count: number; intervalSeconds: number; startAt?: number };
}

export function serializeSessionKeyGrant(grant: SessionKeyGrant): SerializedSessionKeyGrant {
  return {
    version: 1,
    sessionKey: grant.sessionKey,
    calls: grant.calls.map((c) => ({
      target: c.target,
      selector: c.selector,
      valueLimit: c.valueLimit.toString(10),
      ...(c.rules && c.rules.length > 0
        ? { rules: c.rules.map((r) => ({ condition: r.condition, offset: r.offset, params: [...r.params] })) }
        : {}),
    })),
    validAfter: grant.validAfter,
    validUntil: grant.validUntil,
    ...(grant.gasBudgetWei !== undefined ? { gasBudgetWei: grant.gasBudgetWei.toString(10) } : {}),
    ...(grant.rateLimit ? { rateLimit: { ...grant.rateLimit } } : {}),
  };
}

export function parseSessionKeyGrant(value: unknown): SessionKeyGrant {
  const v = value as Partial<SerializedSessionKeyGrant> | null;
  if (!v || typeof v !== 'object' || v.version !== 1) throw new Error('Not a version-1 serialized session grant');
  if (!Array.isArray(v.calls)) throw new Error('Serialized session grant has no calls array');
  const decimal = (s: unknown, what: string): bigint => {
    if (typeof s !== 'string' || !/^(0|[1-9][0-9]*)$/.test(s)) throw new Error(`${what} must be a decimal string`);
    return BigInt(s);
  };
  const grant: SessionKeyGrant = {
    sessionKey: String(v.sessionKey),
    calls: v.calls.map((c, i) => ({
      target: String(c.target),
      selector: c.selector === null ? null : String(c.selector),
      valueLimit: decimal(c.valueLimit, `calls[${i}].valueLimit`),
      ...(c.rules ? { rules: c.rules.map((r) => ({ ...r, params: [...r.params] })) } : {}),
    })),
    validAfter: Number(v.validAfter),
    validUntil: Number(v.validUntil),
    ...(v.gasBudgetWei !== undefined ? { gasBudgetWei: decimal(v.gasBudgetWei, 'gasBudgetWei') } : {}),
    ...(v.rateLimit ? { rateLimit: { ...v.rateLimit } } : {}),
  };
  validateSessionKeyGrant(grant, { now: null });
  return grant;
}

export interface GrantValidationOptions {
  /** The Kernel account the grant is for; enables the self-call rule. */
  account?: string | undefined;
  /**
   * Current unix time in seconds for the expiry check; defaults to the local
   * clock. null skips the time check (used when parsing stored grants).
   */
  now?: number | null | undefined;
}

/**
 * Local, network-free validation. Throws on the first problem. Rules beyond
 * what the contracts would enforce are wallet policy and say so.
 */
export function validateSessionKeyGrant(grant: SessionKeyGrant, options: GrantValidationOptions = {}): void {
  requireAddress(grant.sessionKey, 'sessionKey');
  if (sameAddress(grant.sessionKey, ZERO_ADDRESS)) throw new Error('sessionKey must not be the zero address');
  if (options.account !== undefined && sameAddress(grant.sessionKey, options.account)) {
    throw new Error('sessionKey must not be the account itself');
  }
  if (!Array.isArray(grant.calls) || grant.calls.length === 0) {
    // Wallet policy: CallPolicy would accept an empty list (and then refuse
    // every call), but an empty grant is always a caller mistake.
    throw new Error('A session grant must allow at least one call');
  }
  const seen = new Set<string>();
  grant.calls.forEach((call, i) => {
    const where = `calls[${i}]`;
    requireAddress(call.target, `${where}.target`);
    if (sameAddress(call.target, ZERO_ADDRESS)) {
      // CallPolicy treats a zero-address target as "any target" for that selector.
      throw new Error(`${where}.target is the zero address, which CallPolicy treats as a wildcard; refused`);
    }
    if (call.selector !== null && !/^0x[0-9a-fA-F]{8}$/.test(call.selector)) {
      throw new Error(`${where}.selector must be null or a 4-byte hex selector`);
    }
    if (typeof call.valueLimit !== 'bigint' || call.valueLimit < 0n || call.valueLimit > MAX_UINT256) {
      throw new Error(`${where}.valueLimit must be a uint256 bigint`);
    }
    const key = `${call.target.toLowerCase()}:${(call.selector ?? '0x00000000').toLowerCase()}`;
    if (seen.has(key)) {
      // CallPolicy.onInstall reverts with "duplicate permissionHash".
      throw new Error(`${where} duplicates an earlier (target, selector) pair; CallPolicy would revert`);
    }
    seen.add(key);
    if (options.account !== undefined && sameAddress(call.target, options.account)) {
      // Wallet policy, security critical: a self-call runs with msg.sender ==
      // the account, which passes Kernel's onlyEntryPointOrSelfOrRoot, so a
      // session allowed to call the account with a selector could install a
      // sudo permission or upgrade the account.
      if (call.selector !== null || call.valueLimit !== 0n || (call.rules && call.rules.length > 0)) {
        throw new Error(`${where}: a session may call the account itself only with empty calldata and zero value`);
      }
    }
    for (const [j, rule] of (call.rules ?? []).entries()) {
      const rw = `${where}.rules[${j}]`;
      if (call.selector === null) throw new Error(`${rw}: parameter rules need a selector (no calldata to check)`);
      if (!(rule.condition in PARAM_CONDITION_CODES)) throw new Error(`${rw}.condition is not supported`);
      if (!Number.isSafeInteger(rule.offset) || rule.offset < 0 || BigInt(rule.offset) > MAX_UINT64) {
        throw new Error(`${rw}.offset must be a non-negative integer`);
      }
      if (!Array.isArray(rule.params) || rule.params.length === 0) throw new Error(`${rw}.params must not be empty`);
      if (rule.condition !== 'oneOf' && rule.params.length !== 1) {
        // CallPolicy.onInstall: "only OneOf condition can have multiple params".
        throw new Error(`${rw}: only 'oneOf' may carry more than one param`);
      }
      for (const p of rule.params) {
        if (!/^0x[0-9a-fA-F]{64}$/.test(p)) throw new Error(`${rw}.params entries must be 32-byte hex words`);
      }
    }
  });
  const isUint48 = (n: number) => Number.isSafeInteger(n) && n >= 0 && BigInt(n) <= MAX_UINT48;
  if (!isUint48(grant.validAfter)) throw new Error('validAfter must be a uint48 unix time');
  if (!isUint48(grant.validUntil) || grant.validUntil === 0) {
    // validUntil 0 means "no expiry" to ERC-4337; open-ended sessions are refused.
    throw new Error('validUntil must be a non-zero uint48 unix time');
  }
  if (grant.validUntil <= grant.validAfter) throw new Error('validUntil must be after validAfter');
  const now = options.now === undefined ? Math.floor(Date.now() / 1000) : options.now;
  if (now !== null && grant.validUntil <= now) {
    throw new Error(`Session window already expired (validUntil ${grant.validUntil} <= now ${now})`);
  }
  if (grant.gasBudgetWei !== undefined) {
    if (typeof grant.gasBudgetWei !== 'bigint' || grant.gasBudgetWei <= 0n || grant.gasBudgetWei > MAX_UINT128) {
      throw new Error('gasBudgetWei must be a positive uint128 bigint');
    }
  }
  if (grant.rateLimit) {
    const { count, intervalSeconds, startAt = 0 } = grant.rateLimit;
    if (!isUint48(count) || count === 0) throw new Error('rateLimit.count must be a positive uint48');
    if (!isUint48(intervalSeconds)) throw new Error('rateLimit.intervalSeconds must be a uint48');
    if (!isUint48(startAt)) throw new Error('rateLimit.startAt must be a uint48');
  }
}

/**
 * Checks a call list against a grant locally, before anything is signed or
 * sent (the contracts enforce the same rules; this gives the user a clear
 * message instead of a bundler revert). Mirrors CallPolicy's lookup:
 * (target, selector-or-0x00000000), value <= valueLimit, then each rule.
 */
export function assertCallsAllowed(grant: SessionKeyGrant, calls: Call[], now: number = Math.floor(Date.now() / 1000)): void {
  if (calls.length === 0) throw new Error('At least one call is required');
  if (now < grant.validAfter) throw new Error(`Session not valid until ${grant.validAfter}`);
  if (now >= grant.validUntil) throw new Error(`Session expired at ${grant.validUntil}`);
  calls.forEach((call, i) => {
    if (call.data.length > 0 && call.data.length < 4) {
      throw new Error(`calls[${i}]: calldata shorter than a selector is refused`);
    }
    const sel = call.data.length === 0 ? '0x00000000' : toHex(call.data.slice(0, 4));
    const entry = grant.calls.find(
      (c) => sameAddress(c.target, call.to) && (c.selector ?? '0x00000000').toLowerCase() === sel,
    );
    if (!entry) throw new Error(`calls[${i}]: ${call.to} with selector ${sel} is not allowed by this session`);
    if (call.value > entry.valueLimit) {
      throw new Error(`calls[${i}]: value ${call.value} exceeds the session's cap of ${entry.valueLimit} wei`);
    }
    for (const [j, rule] of (entry.rules ?? []).entries()) {
      const start = 4 + rule.offset;
      if (call.data.length < start + 32) throw new Error(`calls[${i}]: calldata too short for rule ${j}`);
      const word = BigInt(toHex(call.data.slice(start, start + 32)));
      const p = rule.params.map((x) => BigInt(x));
      const ok =
        rule.condition === 'equal' ? word === p[0]
        : rule.condition === 'greaterThan' ? word > p[0]!
        : rule.condition === 'lessThan' ? word < p[0]!
        : rule.condition === 'greaterThanOrEqual' ? word >= p[0]!
        : rule.condition === 'lessThanOrEqual' ? word <= p[0]!
        : rule.condition === 'notEqual' ? word !== p[0]
        : p.includes(word);
      if (!ok) throw new Error(`calls[${i}]: argument at offset ${rule.offset} violates rule ${j} (${rule.condition})`);
    }
  });
}

// ---------------------------------------------------------------------------
// Mapping to Kernel's permission install data
// ---------------------------------------------------------------------------

/** One entry of Kernel's permission data: flag (2) || module (20) || module init data. */
export interface KernelPermissionModuleEntry {
  flag: number;
  module: string;
  data: Uint8Array;
}

export interface KernelPermission {
  /** Policies in installation order (the order also feeds the permission id). */
  policies: KernelPermissionModuleEntry[];
  /** The signer entry; its flag becomes the permission's PassFlag. */
  signer: KernelPermissionModuleEntry;
}

/**
 * CallPolicy v0.0.4 init data [P CallPolicy.sol _parsePermission /
 * _policyOninstall; S callPolicyUtils.ts encodePermissionData]:
 * abi.encode(Permission[]) with Permission(bytes1 callType, address target,
 * bytes4 selector, uint256 valueLimit, ParamRule[] rules) and
 * ParamRule(uint8 condition, uint64 offset, bytes32[] params). callType is
 * always 0x00 (CALL); delegatecall permissions are never produced.
 */
export function encodeCallPolicyData(calls: SessionAllowedCall[]): Uint8Array {
  const permissions: AbiValue = {
    kind: 'array',
    items: calls.map((c) => ({
      kind: 'tuple' as const,
      items: [
        { kind: 'fixedBytes' as const, value: new Uint8Array([0x00]) },
        { kind: 'address' as const, value: c.target },
        { kind: 'fixedBytes' as const, value: toBytes(c.selector ?? '0x00000000') },
        { kind: 'uint256' as const, value: c.valueLimit },
        {
          kind: 'array' as const,
          items: (c.rules ?? []).map((r) => ({
            kind: 'tuple' as const,
            items: [
              { kind: 'uint256' as const, value: BigInt(PARAM_CONDITION_CODES[r.condition]) },
              { kind: 'uint256' as const, value: BigInt(r.offset) },
              {
                kind: 'array' as const,
                items: r.params.map((p) => ({ kind: 'fixedBytes' as const, value: toBytes(p) })),
              },
            ],
          })),
        },
      ],
    })),
  };
  return encodeSequence([permissions]);
}

/** TimestampPolicy init data: abi.encode(uint48 validAfter, uint48 validUntil) [P TimestampPolicy.sol]. */
export function encodeTimestampPolicyData(validAfter: number, validUntil: number): Uint8Array {
  return encodeSequence([
    { kind: 'uint256', value: BigInt(validAfter) },
    { kind: 'uint256', value: BigInt(validUntil) },
  ]);
}

/** GasPolicy init data: abi.encode(uint128 allowed, bool enforcePaymaster, address allowedPaymaster) [P GasPolicy.sol]. */
export function encodeGasPolicyData(allowedWei: bigint, allowedPaymaster: string | null = null): Uint8Array {
  return encodeSequence([
    { kind: 'uint256', value: allowedWei },
    { kind: 'uint256', value: allowedPaymaster ? 1n : 0n },
    { kind: 'address', value: allowedPaymaster ?? ZERO_ADDRESS },
  ]);
}

/** RateLimitPolicy init data: packed uint48 interval || uint48 count || uint48 startAt [P RateLimitPolicy.sol]. */
export function encodeRateLimitPolicyData(intervalSeconds: number, count: number, startAt = 0): Uint8Array {
  const out = new Uint8Array(18);
  [intervalSeconds, count, startAt].forEach((n, i) => out.set(toWord(BigInt(n)).slice(26), i * 6));
  return out;
}

/**
 * Maps a grant onto Kernel permission data: policies [call, timestamp,
 * gas?, rateLimit?] (all with flag 0x0000) and the ECDSA signer entry with
 * flag SKIP_SIGNATURE (UserOperations only; see KERNEL_PASS_FLAG_SKIP_SIGNATURE).
 * ECDSASigner init data is the 20-byte signer address [P ECDSASigner.sol
 * _signerOninstall reads _data[0:20]].
 */
export function kernelPermissionFromGrant(
  grant: SessionKeyGrant,
  modules: KernelPermissionModules = KERNEL_PERMISSION_MODULES,
): KernelPermission {
  const policies: KernelPermissionModuleEntry[] = [
    { flag: KERNEL_PASS_FLAG_ALL, module: modules.callPolicy, data: encodeCallPolicyData(grant.calls) },
    {
      flag: KERNEL_PASS_FLAG_ALL,
      module: modules.timestampPolicy,
      data: encodeTimestampPolicyData(grant.validAfter, grant.validUntil),
    },
  ];
  if (grant.gasBudgetWei !== undefined) {
    policies.push({ flag: KERNEL_PASS_FLAG_ALL, module: modules.gasPolicy, data: encodeGasPolicyData(grant.gasBudgetWei) });
  }
  if (grant.rateLimit) {
    policies.push({
      flag: KERNEL_PASS_FLAG_ALL,
      module: modules.rateLimitPolicy,
      data: encodeRateLimitPolicyData(grant.rateLimit.intervalSeconds, grant.rateLimit.count, grant.rateLimit.startAt ?? 0),
    });
  }
  return {
    policies,
    signer: {
      flag: KERNEL_PASS_FLAG_SKIP_SIGNATURE,
      module: modules.ecdsaSigner,
      data: toBytes(grant.sessionKey),
    },
  };
}

function encodeModuleEntry(entry: KernelPermissionModuleEntry): Uint8Array {
  if (!Number.isInteger(entry.flag) || entry.flag < 0 || entry.flag > 0xffff) throw new Error('flag must be a uint16');
  return concatBytes(new Uint8Array([entry.flag >> 8, entry.flag & 0xff]), toBytes(entry.module), entry.data);
}

/**
 * The permission's validatorData (the SDK's getEnableData): abi.encode(bytes[])
 * of the policy entries followed by the signer entry [K _installPermission
 * reads PermissionEnableDataFormat{bytes[] data}; the last element is the
 * signer; at most 254 entries].
 */
export function encodePermissionValidatorData(permission: KernelPermission): Uint8Array {
  const entries = [...permission.policies, permission.signer];
  if (entries.length > 254) throw new Error('Kernel allows at most 253 policies per permission');
  return encodeSequence([
    { kind: 'array', items: entries.map((e) => ({ kind: 'bytes' as const, value: encodeModuleEntry(e) })) },
  ]);
}

/**
 * Permission id, computed exactly as the ZeroDev SDK does
 * [S toPermissionValidator.ts getPermissionId]: the first 4 bytes of
 * keccak256(abi.encode(bytes[] [abi.encode(bytes[] policyEntries),
 * flag (2 bytes), abi.encode(bytes signerModule || signerData)])). Kernel
 * itself does not derive ids: any bytes4 the installer chooses is accepted
 * [K _installValidation], so this choice is for tool parity. The session
 * key's address is part of the preimage, so a fresh session key yields a
 * fresh id (re-using an id after revocation fails, because the policies
 * keep a Deprecated status for it).
 */
export function computePermissionId(permission: KernelPermission): Uint8Array {
  const policyId = encodeSequence([
    {
      kind: 'array',
      items: permission.policies.map((p) => ({ kind: 'bytes' as const, value: encodeModuleEntry(p) })),
    },
  ]);
  const flag = new Uint8Array([permission.signer.flag >> 8, permission.signer.flag & 0xff]);
  const signerId = encodeSequence([
    { kind: 'bytes', value: concatBytes(toBytes(permission.signer.module), permission.signer.data) },
  ]);
  const preimage = encodeSequence([
    {
      kind: 'array',
      items: [policyId, flag, signerId].map((b) => ({ kind: 'bytes' as const, value: b })),
    },
  ]);
  return keccak(preimage).slice(0, 4);
}

/** Kernel ValidationId (bytes21) for a permission: 0x02 || permissionId || 16 zero bytes [K permissionToIdentifier]. */
export function permissionValidationId(permissionId: Uint8Array | string): Uint8Array {
  const pid = asPermissionId(permissionId);
  const out = new Uint8Array(21);
  out[0] = KERNEL_VALIDATION_TYPE_PERMISSION;
  out.set(pid, 1);
  return out;
}

/**
 * The uint192 EntryPoint nonce key that routes a UserOperation to a
 * permission [K ValidatorLib.encodeAsNonceKey; S toKernelPluginManager.ts
 * getNonceKey]: mode (1 byte) || type 0x02 (1 byte) || permissionId padded
 * right to 20 bytes || parallel key (2 bytes). Mode 'enable' (0x01) makes
 * Kernel install the permission from the signature's enable payload first.
 */
export function sessionNonceKey(
  permissionId: Uint8Array | string,
  options: { mode?: 'default' | 'enable'; parallelKey?: number } = {},
): bigint {
  const parallelKey = options.parallelKey ?? 0;
  if (!Number.isInteger(parallelKey) || parallelKey < 0 || parallelKey > 0xffff) {
    throw new Error('parallelKey must be a uint16');
  }
  const key = new Uint8Array(24);
  key[0] = options.mode === 'enable' ? KERNEL_VALIDATION_MODE_ENABLE : KERNEL_VALIDATION_MODE_DEFAULT;
  key[1] = KERNEL_VALIDATION_TYPE_PERMISSION;
  key.set(asPermissionId(permissionId), 2);
  key[22] = parallelKey >> 8;
  key[23] = parallelKey & 0xff;
  return BigInt(toHex(key));
}

/**
 * The validation-config nonce Kernel will assign [K _enableDigest and
 * _installValidation]: currentNonce + 1 if this validation id's stored
 * nonce equals currentNonce, else currentNonce.
 */
export function nextValidationNonce(currentNonce: number, validationNonce: number): number {
  return validationNonce === currentNonce ? currentNonce + 1 : currentNonce;
}

export interface KernelPermissionInstallContext {
  chainId: bigint;
  /** The deployed Kernel account (EIP-712 verifyingContract). */
  account: string;
  /** account.currentNonce() [K]. */
  currentNonce: number;
  /** account.validationConfig(validationId).nonce, 0 when never installed. */
  validationNonce: number;
  /** Unix seconds for the local expiry check (defaults to the clock). */
  now?: number;
  /** Kernel EIP-712 version; defaults to "0.3.3". */
  kernelVersion?: string;
  modules?: KernelPermissionModules;
}

export interface KernelPermissionInstall {
  permissionId: Uint8Array;
  validationId: Uint8Array;
  /** Number of policies (uninstall needs policyCount + 1 deinit entries). */
  policyCount: number;
  permission: KernelPermission;
  /** abi.encode(bytes[]) policy and signer entries. */
  validatorData: Uint8Array;
  /** Enable-mode payload the ROOT owner signs (EIP-712 "Enable" under the account's Kernel domain). */
  enable: {
    nonce: number;
    hook: string;
    hookData: Uint8Array;
    /** 4 bytes: execute(bytes32,bytes). Kernel grants access to exactly this selector. */
    selectorData: Uint8Array;
    /** The EIP-712 request, for display; `digest` is what the owner signs. */
    typedData: {
      domain: { name: string; version: string; chainId: bigint; verifyingContract: string };
      types: TypedDataTypes;
      primaryType: 'Enable';
      message: Record<string, unknown>;
    };
    digest: Uint8Array;
  };
  /**
   * Alternative to enable mode: calls for a ROOT-signed operation that
   * installs the permission explicitly (self-calls through execute, which
   * pass Kernel's onlyEntryPointOrSelfOrRoot):
   * installValidations([vId], [(nonce, address(0))], [validatorData], [0x])
   * and grantAccess(vId, execute selector, true).
   */
  installCalls: Call[];
}

/**
 * Builds everything needed to install a session permission: the permission
 * id, the enable-mode payload the root owner signs, and the explicit-install
 * calls. Pure: validates the grant locally (including the expiry window)
 * before anything else and performs no network access; read currentNonce
 * and validationNonce with readKernelPermissionState first.
 *
 * selectorData is the 4-byte execute selector. Kernel accepts exactly 4
 * bytes as "grant access without installing a selector module"
 * [K _configureSelector]; the ZeroDev SDK instead sends a 44+-byte form that
 * also writes a delegatecall selector config with target address(0) — a
 * deliberate divergence that leaves no stray selector state.
 */
export function encodePermissionInstall(
  grant: SessionKeyGrant,
  context: KernelPermissionInstallContext,
): KernelPermissionInstall {
  validateSessionKeyGrant(grant, { account: context.account, now: context.now });
  requireUint32(context.currentNonce, 'currentNonce');
  requireUint32(context.validationNonce, 'validationNonce');
  const permission = kernelPermissionFromGrant(grant, context.modules);
  const permissionId = computePermissionId(permission);
  const validationId = permissionValidationId(permissionId);
  const validatorData = encodePermissionValidatorData(permission);
  const nonce = nextValidationNonce(context.currentNonce, context.validationNonce);
  const hookData = new Uint8Array(0);
  const selectorData = toBytes(KERNEL_EXECUTE_SELECTOR);
  const domain = {
    name: KERNEL_EIP712_NAME,
    version: context.kernelVersion ?? KERNEL_V3_3.version,
    chainId: context.chainId,
    verifyingContract: context.account,
  };
  const message = {
    validationId: toHex(validationId),
    nonce: BigInt(nonce),
    hook: ZERO_ADDRESS,
    validatorData: toHex(validatorData),
    hookData: toHex(hookData),
    selectorData: toHex(selectorData),
  };
  const digest = typedDataDigest(domain, ENABLE_TYPES, 'Enable', message);

  const installCalls: Call[] = [
    {
      to: context.account,
      value: 0n,
      data: encodeFunctionCall('installValidations(bytes21[],(uint32,address)[],bytes[],bytes[])', [
        { kind: 'array', items: [{ kind: 'fixedBytes', value: validationId }] },
        {
          kind: 'array',
          items: [
            {
              kind: 'tuple',
              items: [
                { kind: 'uint256', value: BigInt(nonce) },
                { kind: 'address', value: ZERO_ADDRESS },
              ],
            },
          ],
        },
        { kind: 'array', items: [{ kind: 'bytes', value: validatorData }] },
        { kind: 'array', items: [{ kind: 'bytes', value: hookData }] },
      ]),
    },
    {
      to: context.account,
      value: 0n,
      data: encodeFunctionCall('grantAccess(bytes21,bytes4,bool)', [
        { kind: 'fixedBytes', value: validationId },
        { kind: 'fixedBytes', value: selectorData },
        { kind: 'uint256', value: 1n },
      ]),
    },
  ];

  return {
    permissionId,
    validationId,
    policyCount: permission.policies.length,
    permission,
    validatorData,
    enable: {
      nonce,
      hook: ZERO_ADDRESS,
      hookData,
      selectorData,
      typedData: { domain, types: ENABLE_TYPES, primaryType: 'Enable', message },
      digest,
    },
    installCalls,
  };
}

/**
 * The root owner's signature over the enable digest. Kernel verifies it with
 * the root validator's isValidSignatureWithSender [K _verifyEnableSig];
 * Kernel's ECDSA validator accepts the raw digest [K ECDSAValidator.sol],
 * which is also what the SDK signs (signTypedData).
 */
export function signPermissionEnable(owner: DerivedAccount, digest: Uint8Array): Uint8Array {
  if (digest.length !== 32) throw new Error('Enable digest must be 32 bytes');
  return withEthereumV(owner.sign(digest));
}

/**
 * Enable-mode UserOperation signature [K _enableMode: hook = packedData[0:20],
 * then a UserOpSigEnableDataFormat calldata struct at offset 20; S
 * getEncodedPluginsData.ts]: hook (20 bytes) || abi.encode(bytes
 * validatorData, bytes hookData, bytes selectorData, bytes enableSig, bytes
 * userOpSig).
 */
export function encodeEnableModeSignature(parts: {
  hook?: string | undefined;
  validatorData: Uint8Array;
  hookData?: Uint8Array | undefined;
  selectorData?: Uint8Array | undefined;
  enableSignature: Uint8Array;
  userOpSignature: Uint8Array;
}): Uint8Array {
  return concatBytes(
    toBytes(parts.hook ?? ZERO_ADDRESS),
    encodeSequence([
      { kind: 'bytes', value: parts.validatorData },
      { kind: 'bytes', value: parts.hookData ?? new Uint8Array(0) },
      { kind: 'bytes', value: parts.selectorData ?? toBytes(KERNEL_EXECUTE_SELECTOR) },
      { kind: 'bytes', value: parts.enableSignature },
      { kind: 'bytes', value: parts.userOpSignature },
    ]),
  );
}

/**
 * The permission-path UserOperation signature, signed by the SESSION key and
 * never the owner [K _checkUserOpPolicy: per-policy signature segments
 * (none here, because none of the pinned policies reads one), then 0xff,
 * then the signer's signature; P ECDSASigner.checkUserOpSignature accepts
 * the raw userOpHash or its EIP-191 form]. Signs the EIP-191 form with
 * v = 27/28, as the SDK does (signMessage({ raw: userOpHash })).
 */
export function signWithSessionKey(sessionKey: DerivedAccount, userOpHash: Uint8Array): Uint8Array {
  if (userOpHash.length !== 32) throw new Error('userOpHash must be 32 bytes');
  return concatBytes(
    new Uint8Array([KERNEL_PERMISSION_SIGNER_PREFIX]),
    withEthereumV(sessionKey.sign(toEthSignedMessageHash(userOpHash))),
  );
}

/** Gas-estimation stub for the permission path: 0xff || recoverable dummy signature. */
export function sessionStubSignature(): Uint8Array {
  return concatBytes(new Uint8Array([KERNEL_PERMISSION_SIGNER_PREFIX]), toBytes(DUMMY_ECDSA_SIGNATURE));
}

/**
 * uninstallValidation(vId, deinitData, hookDeinitData) calldata [K
 * Kernel.sol]. For a permission, deinitData is abi.encode(bytes[]) with
 * exactly policyCount + 1 entries (else PermissionDataLengthMismatch) [K
 * _uninstallPermission]; the pinned modules ignore their entry, so all are
 * empty. Kernel clears the validation's hook (later operations revert
 * InvalidValidator), removes the policy list and signer, and calls each
 * module's onUninstall through ExcessivelySafeCall (failures there do not
 * revert). Must be executed by the root validator, e.g. as a self-call in a
 * root-signed operation (see permissionRevokeCall).
 */
export function encodePermissionRevoke(permissionId: Uint8Array | string, policyCount: number): Uint8Array {
  if (!Number.isInteger(policyCount) || policyCount < 0 || policyCount > 253) {
    throw new Error('policyCount must be an integer between 0 and 253');
  }
  return encodeFunctionCall('uninstallValidation(bytes21,bytes,bytes)', [
    { kind: 'fixedBytes', value: permissionValidationId(permissionId) },
    {
      kind: 'bytes',
      value: encodeSequence([
        {
          kind: 'array',
          items: Array.from({ length: policyCount + 1 }, () => ({ kind: 'bytes' as const, value: new Uint8Array(0) })),
        },
      ]),
    },
    { kind: 'bytes', value: new Uint8Array(0) },
  ]);
}

/** A self-call that revokes the permission, for a root-signed SmartAccountClient.sendCalls. */
export function permissionRevokeCall(account: string, permissionId: Uint8Array | string, policyCount: number): Call {
  return { to: account, value: 0n, data: encodePermissionRevoke(permissionId, policyCount) };
}

// ---------------------------------------------------------------------------
// On-chain reads
// ---------------------------------------------------------------------------

export interface KernelPermissionState {
  currentNonce: number;
  /** validationConfig(vId).nonce. */
  validationNonce: number;
  /** validationConfig(vId).hook: address(0) = not installed, address(1) = installed without hook. */
  hook: string;
  /** permissionConfig(pId).signer: address(0) when no signer is installed. */
  signer: string;
  /** permissionConfig(pId).permissionFlag. */
  permissionFlag: number;
  /** permissionConfig(pId).policyData, each as (flag, policy address). */
  policies: Array<{ flag: number; policy: string }>;
  /** isAllowedSelector(vId, execute selector). */
  executeAllowed: boolean;
  /** True when the permission is usable for UserOperations (hook set, signer set, execute allowed). */
  installed: boolean;
}

/** Reads a permission's Kernel state with read-only eth_calls [K ValidationManager getters]. */
export async function readKernelPermissionState(
  node: JsonRpcTransport,
  account: string,
  permissionId: Uint8Array | string,
): Promise<KernelPermissionState> {
  const pid = asPermissionId(permissionId);
  const vId = permissionValidationId(pid);
  const call = async (data: Uint8Array): Promise<Uint8Array> =>
    toBytes((await node('eth_call', [{ to: account, data: toHex(data) }, 'latest'])) as string);

  const nonceWord = await call(encodeFunctionCall('currentNonce()', []));
  if (nonceWord.length !== 32) throw new Error('currentNonce() did not return one word; is this a Kernel v3 account?');
  const configWords = await call(encodeFunctionCall('validationConfig(bytes21)', [{ kind: 'fixedBytes', value: vId }]));
  if (configWords.length !== 64) throw new Error('validationConfig() returned an unexpected shape');
  const permissionWords = await call(encodeFunctionCall('permissionConfig(bytes4)', [{ kind: 'fixedBytes', value: pid }]));
  const allowedWord = await call(
    encodeFunctionCall('isAllowedSelector(bytes21,bytes4)', [
      { kind: 'fixedBytes', value: vId },
      { kind: 'fixedBytes', value: toBytes(KERNEL_EXECUTE_SELECTOR) },
    ]),
  );

  const word = (bytes: Uint8Array, offset: number): bigint => {
    if (offset + 32 > bytes.length) throw new Error('Return data too short');
    return BigInt(toHex(bytes.slice(offset, offset + 32)));
  };
  const addressAt = (bytes: Uint8Array, offset: number): string =>
    toChecksumAddress(bytes.slice(offset + 12, offset + 32));

  // permissionConfig returns one dynamic struct (bytes2, address, bytes22[]):
  // word 0 = offset of the struct; inside it, flag, signer, then the offset
  // (relative to the struct) of the bytes22[] array.
  const structStart = Number(word(permissionWords, 0));
  const flagWord = permissionWords.slice(structStart, structStart + 32);
  const permissionFlag = (flagWord[0]! << 8) | flagWord[1]!;
  const signer = addressAt(permissionWords, structStart + 32);
  const arrayStart = structStart + Number(word(permissionWords, structStart + 64));
  const length = Number(word(permissionWords, arrayStart));
  const policies: Array<{ flag: number; policy: string }> = [];
  for (let i = 0; i < length; i++) {
    const item = permissionWords.slice(arrayStart + 32 + i * 32, arrayStart + 64 + i * 32);
    if (item.length !== 32) throw new Error('permissionConfig() policy list truncated');
    // bytes22 left-aligned: flag (2 bytes) || policy address (20 bytes).
    policies.push({ flag: (item[0]! << 8) | item[1]!, policy: toChecksumAddress(item.slice(2, 22)) });
  }

  const hook = addressAt(configWords, 32);
  const executeAllowed = word(allowedWord, 0) === 1n;
  return {
    currentNonce: Number(word(nonceWord, 0)),
    validationNonce: Number(word(configWords, 0)),
    hook,
    signer,
    permissionFlag,
    policies,
    executeAllowed,
    installed: !sameAddress(hook, ZERO_ADDRESS) && !sameAddress(signer, ZERO_ADDRESS) && executeAllowed,
  };
}

/** ECDSASigner.signer(bytes32 id, address wallet): the session key stored for a permission [P ECDSASigner.sol]. */
export async function readSessionSigner(
  node: JsonRpcTransport,
  account: string,
  permissionId: Uint8Array | string,
  ecdsaSigner: string = KERNEL_PERMISSION_MODULES.ecdsaSigner,
): Promise<string> {
  const id = new Uint8Array(32);
  id.set(asPermissionId(permissionId), 0);
  const data = encodeFunctionCall('signer(bytes32,address)', [
    { kind: 'fixedBytes', value: id },
    { kind: 'address', value: account },
  ]);
  const out = toBytes((await node('eth_call', [{ to: ecdsaSigner, data: toHex(data) }, 'latest'])) as string);
  if (out.length !== 32) throw new Error('ECDSASigner.signer returned an unexpected shape');
  return toChecksumAddress(out.slice(12));
}

/**
 * Validates the grant locally FIRST (an expired window, an empty call list
 * or a wildcard target is refused before any network request), then reads
 * the account's Kernel state and refuses ids that are not fresh: Kernel
 * would overwrite an installed permission's policy list, and the pinned
 * policies refuse to re-install an id they have seen (their status stays
 * Deprecated after an uninstall), so a reused id could only fail. Returns
 * the install payload for the current on-chain nonces.
 */
export async function prepareKernelPermissionInstall(
  node: JsonRpcTransport,
  grant: SessionKeyGrant,
  context: Omit<KernelPermissionInstallContext, 'currentNonce' | 'validationNonce'>,
): Promise<KernelPermissionInstall> {
  validateSessionKeyGrant(grant, { account: context.account, now: context.now });
  const modules = context.modules ?? KERNEL_PERMISSION_MODULES;
  const permission = kernelPermissionFromGrant(grant, modules);
  const permissionId = computePermissionId(permission);
  const state = await readKernelPermissionState(node, context.account, permissionId);
  if (!sameAddress(state.hook, ZERO_ADDRESS) || !sameAddress(state.signer, ZERO_ADDRESS)) {
    throw new Error(`Permission ${toHex(permissionId)} is already installed on ${context.account}`);
  }
  const id = new Uint8Array(32);
  id.set(permissionId, 0);
  for (const policy of permission.policies) {
    const status = toBytes(
      (await node('eth_call', [
        {
          to: policy.module,
          data: toHex(
            encodeFunctionCall('status(bytes32,address)', [
              { kind: 'fixedBytes', value: id },
              { kind: 'address', value: context.account },
            ]),
          ),
        },
        'latest',
      ])) as string,
    );
    if (status.length !== 32) throw new Error(`Policy ${policy.module} status() returned an unexpected shape`);
    if (BigInt(toHex(status)) !== 0n) {
      throw new Error(
        `Policy ${policy.module} has already seen permission id ${toHex(permissionId)} for this account; use a fresh session key`,
      );
    }
  }
  const existingSigner = await readSessionSigner(node, context.account, permissionId, modules.ecdsaSigner);
  if (!sameAddress(existingSigner, ZERO_ADDRESS)) {
    throw new Error(`ECDSASigner already holds a signer for permission ${toHex(permissionId)}`);
  }
  return encodePermissionInstall(grant, {
    ...context,
    currentNonce: state.currentNonce,
    validationNonce: state.validationNonce,
  });
}

// ---------------------------------------------------------------------------
// Session spec
// ---------------------------------------------------------------------------

export interface KernelSessionSpecConfig {
  /** The DEPLOYED Kernel account the session acts for. */
  account: string;
  /** The session signer's address; the spec refuses to be driven by any other key. */
  sessionKey: string;
  permissionId: Uint8Array | string;
  /**
   * When present, the session's first operation installs the permission in
   * enable mode (nonce mode 0x01) using the root owner's enable signature.
   * Create a new spec WITHOUT `enable` once that operation is included.
   */
  enable?: {
    validatorData: Uint8Array;
    enableSignature: Uint8Array;
    hookData?: Uint8Array;
    selectorData?: Uint8Array;
  };
  /** When present, every call list is checked locally against it before encoding. */
  grant?: SessionKeyGrant;
  /** Parallel nonce lane (uint16). Defaults to 0. */
  parallelKey?: number;
  entryPoint?: string;
  /** Clock override for the local grant check (unix seconds). */
  now?: () => number;
}

export interface KernelSessionSpec extends SmartAccountSpec {
  permissionId: Uint8Array;
  nonceKey: bigint;
  /**
   * The session's nonce key (SmartAccountSpec.getNonceKey), so
   * SmartAccountClient reads EntryPoint.getNonce(account, nonceKey) directly
   * and checks the key part of the answer.
   */
  getNonceKey(): bigint;
  /**
   * Compatibility wrapper, no longer needed with SmartAccountClient (which
   * now uses getNonceKey). It rewrites an EntryPoint getNonce(account, 0)
   * read into a read for this session's nonce key (the returned value is
   * key << 64 | sequence, i.e. the full nonce) and passes every other request
   * through untouched, so it remains correct for callers that wrap this spec
   * in an object without forwarding getNonceKey.
   */
  routeNode(node: JsonRpcTransport): JsonRpcTransport;
}

/**
 * A SmartAccountSpec that signs with the SESSION key through Kernel's
 * permission path, so SmartAccountClient.sendCalls works unchanged:
 *   new SmartAccountClient({ ..., spec, node })
 *   client.sendCalls(sessionKeyAccount, calls, fees)
 * The client takes the session's nonce key from getNonceKey.
 * The "owner" passed to the client must be the session key's
 * DerivedAccount (see createSessionKeyAccount); anything else is refused, so
 * the seed-derived owner can never sign through this spec. The account must
 * already be deployed (getFactoryArgs throws).
 */
export function kernelSessionSpec(config: KernelSessionSpecConfig): KernelSessionSpec {
  requireAddress(config.account, 'account');
  requireAddress(config.sessionKey, 'sessionKey');
  const permissionId = asPermissionId(config.permissionId);
  const nonceKey = sessionNonceKey(permissionId, {
    mode: config.enable ? 'enable' : 'default',
    parallelKey: config.parallelKey ?? 0,
  });
  const entryPoint = config.entryPoint ?? ENTRYPOINT_V07;
  if (config.grant) validateSessionKeyGrant(config.grant, { account: config.account, now: null });

  const requireSessionKey = (signer: DerivedAccount): void => {
    if (!sameAddress(signer.address, config.sessionKey)) {
      throw new Error(
        `This session spec signs only with session key ${config.sessionKey}; refusing ${signer.address}`,
      );
    }
  };
  const wrap = (userOpSignature: Uint8Array): Uint8Array =>
    config.enable
      ? encodeEnableModeSignature({
          validatorData: config.enable.validatorData,
          hookData: config.enable.hookData,
          selectorData: config.enable.selectorData,
          enableSignature: config.enable.enableSignature,
          userOpSignature,
        })
      : userOpSignature;

  return {
    permissionId,
    nonceKey,

    getNonceKey(): bigint {
      return nonceKey;
    },

    async getAddress(signer: DerivedAccount): Promise<string> {
      requireSessionKey(signer);
      return config.account;
    },

    async getFactoryArgs(): Promise<{ factory: string; factoryData: Uint8Array }> {
      throw new Error(`Kernel account ${config.account} is not deployed; session keys need a deployed account`);
    },

    encodeCalls(calls: Call[]): Uint8Array {
      if (config.grant) {
        assertCallsAllowed(config.grant, calls, config.now ? config.now() : Math.floor(Date.now() / 1000));
      }
      return encodeKernelExecute(calls);
    },

    signUserOpHash(signer: DerivedAccount, userOpHash: Uint8Array): Uint8Array {
      requireSessionKey(signer);
      return wrap(signWithSessionKey(signer, userOpHash));
    },

    stubSignature(): Uint8Array {
      // In enable mode the REAL enable signature must be present even in the
      // estimation stub: Kernel reverts EnableNotApproved otherwise.
      return wrap(sessionStubSignature());
    },

    routeNode(node: JsonRpcTransport): JsonRpcTransport {
      // Exactly the request SmartAccountClient.getNonce sends: key 0 for this account.
      const keyZeroRead = toHex(
        encodeFunctionCall(GET_NONCE_SIGNATURE, [
          { kind: 'address', value: config.account },
          { kind: 'uint256', value: 0n },
        ]),
      );
      const routed = toHex(
        encodeFunctionCall(GET_NONCE_SIGNATURE, [
          { kind: 'address', value: config.account },
          { kind: 'uint256', value: nonceKey },
        ]),
      );
      return async (method, params) => {
        if (method === 'eth_call') {
          const tx = params[0] as { to?: string; data?: string } | undefined;
          if (
            tx?.to &&
            sameAddress(tx.to, entryPoint) &&
            typeof tx.data === 'string' &&
            tx.data.toLowerCase() === keyZeroRead
          ) {
            const result = (await node(method, [{ ...tx, data: routed }, ...params.slice(1)])) as string;
            const full = BigInt(result);
            if (full >> 64n !== nonceKey) {
              throw new Error('EntryPoint.getNonce returned a nonce for a different key');
            }
            return result;
          }
        }
        return node(method, params);
      };
    },
  };
}

/**
 * A DerivedAccount for a raw session private key (32 bytes), signing like
 * the core EVM provider (noble secp256k1, r || s || recid). The key never
 * leaves the returned closure; persist it only in the platform's secure
 * storage.
 */
export function createSessionKeyAccount(privateKey: Uint8Array, chainId = 'eip155:1'): DerivedAccount {
  if (privateKey.length !== 32 || !secp256k1.utils.isValidSecretKey(privateKey)) {
    throw new Error('Session private key must be a valid 32-byte secp256k1 secret key');
  }
  const key = privateKey.slice();
  return {
    chainId,
    path: 'session-key',
    publicKey: secp256k1.getPublicKey(key, true),
    address: publicKeyToEvmAddress(key),
    sign: (digest: Uint8Array) => {
      const sig = secp256k1.sign(digest, key, { prehash: false, format: 'recovered' });
      const out = new Uint8Array(65);
      out.set(sig.subarray(1), 0);
      out[64] = sig[0]!;
      return out;
    },
  };
}

/** A fresh random session private key (noble's CSPRNG-backed randomSecretKey). */
export function generateSessionPrivateKey(): Uint8Array {
  return secp256k1.utils.randomSecretKey();
}

// ---------------------------------------------------------------------------
// ERC-7715 mapping
// ---------------------------------------------------------------------------

/**
 * ERC-7715 ("Request Permissions from Wallets", status DRAFT) at
 * ethereum/ERCs commit 2adc3783667334a371eab433fecbe9953dc848e2
 * (2026-01-16, ERCS/erc-7715.md). That revision renamed the method to
 * wallet_requestExecutionPermissions (earlier drafts, e.g. e1d58b0a, used
 * wallet_grantPermissions with signer/permissions/policies objects) and
 * defines:
 *   PermissionRequest = { chainId: Hex; from?: Address; to: Address;
 *     permission: { type: string; isAdjustmentAllowed: boolean; data };
 *     rules?: { type: string; data }[] }
 * with one rule type, "expiry" ({ timestamp }), and no normative permission
 * types (the "native-token-allowance" in its examples is illustrative).
 * `to` is "the DApp session account associated with the permission"; here
 * that is the session key.
 *
 * Limits of the mapping, stated plainly:
 *  - The ERC's RESPONSE requires an ERC-7710 delegationManager and context
 *    redeemed via redeemDelegations(). Kernel's permission validator is not
 *    an ERC-7710 delegation manager: the session key instead signs
 *    UserOperations for the Kernel account. So only the REQUEST shape is
 *    mapped; no compliant response can be produced from this design.
 *  - No ERC defines a contract-call permission type, so this wallet uses
 *    the wallet-defined type below. A dApp must opt in to it.
 *  - "native-token-allowance" (a cumulative allowance) is refused: the
 *    pinned CallPolicy caps value per call, not in total.
 */
export const ERC7715_CALLS_PERMISSION_TYPE = 'shiba-wallet:contract-calls';

export interface Erc7715PermissionRequest {
  chainId: string;
  from?: string;
  to: string;
  permission: { type: string; isAdjustmentAllowed: boolean; data: Record<string, unknown> };
  rules?: Array<{ type: string; data: Record<string, unknown> }>;
}

interface Erc7715CallsData {
  calls: Array<{ target: string; selector: string | null; valueLimit: string; rules?: SessionParamRule[] }>;
  validAfter?: number;
  gasBudget?: string;
  rateLimit?: { count: number; intervalSeconds: number; startAt?: number };
}

/** SessionKeyGrant -> ERC-7715 PermissionRequest (wallet-defined permission type, expiry rule). */
export function grantToErc7715Request(
  grant: SessionKeyGrant,
  options: { chainId: bigint; account?: string; isAdjustmentAllowed?: boolean },
): Erc7715PermissionRequest {
  validateSessionKeyGrant(grant, { account: options.account, now: null });
  const data: Erc7715CallsData = {
    calls: grant.calls.map((c) => ({
      target: c.target,
      selector: c.selector,
      valueLimit: '0x' + c.valueLimit.toString(16),
      ...(c.rules && c.rules.length > 0 ? { rules: c.rules.map((r) => ({ ...r, params: [...r.params] })) } : {}),
    })),
    ...(grant.validAfter !== 0 ? { validAfter: grant.validAfter } : {}),
    ...(grant.gasBudgetWei !== undefined ? { gasBudget: '0x' + grant.gasBudgetWei.toString(16) } : {}),
    ...(grant.rateLimit ? { rateLimit: { ...grant.rateLimit } } : {}),
  };
  return {
    chainId: '0x' + options.chainId.toString(16),
    ...(options.account ? { from: options.account } : {}),
    to: grant.sessionKey,
    permission: {
      type: ERC7715_CALLS_PERMISSION_TYPE,
      isAdjustmentAllowed: options.isAdjustmentAllowed ?? false,
      data: data as unknown as Record<string, unknown>,
    },
    rules: [{ type: 'expiry', data: { timestamp: grant.validUntil } }],
  };
}

export class Erc7715RequestError extends Error {
  constructor(
    message: string,
    /** 'unsupported' = a type/rule this wallet cannot enforce; 'invalid' = malformed request. */
    readonly reason: 'unsupported' | 'invalid',
  ) {
    super(message);
    this.name = 'Erc7715RequestError';
  }
}

/**
 * ERC-7715 PermissionRequest -> SessionKeyGrant, refusing anything this
 * wallet cannot enforce on-chain. The caller still shows the result to the
 * user; `isAdjustmentAllowed` is returned so the UI knows whether it may
 * narrow the grant (if false, grant exactly or decline).
 */
export function grantFromErc7715Request(
  request: Erc7715PermissionRequest,
  options: { chainId: bigint; account: string; now?: number },
): { grant: SessionKeyGrant; isAdjustmentAllowed: boolean } {
  const invalid = (m: string) => new Erc7715RequestError(m, 'invalid');
  if (!request || typeof request !== 'object') throw invalid('Request must be an object');
  if (typeof request.chainId !== 'string' || !/^0x[0-9a-fA-F]+$/.test(request.chainId)) {
    throw invalid('chainId must be a hex string');
  }
  if (BigInt(request.chainId) !== options.chainId) {
    throw invalid(`chainId ${request.chainId} is not the active chain 0x${options.chainId.toString(16)}`);
  }
  if (request.from !== undefined && !sameAddress(String(request.from), options.account)) {
    throw invalid('from is not the account being asked');
  }
  if (typeof request.to !== 'string' || !isAddress(request.to)) throw invalid('to must be the session key address');
  const permission = request.permission;
  if (!permission || typeof permission !== 'object' || typeof permission.type !== 'string') {
    throw invalid('permission.type is missing');
  }
  if (permission.type === 'native-token-allowance') {
    throw new Erc7715RequestError(
      'native-token-allowance is a cumulative allowance; the pinned Kernel call policy only caps value per call, so it cannot be enforced',
      'unsupported',
    );
  }
  if (permission.type !== ERC7715_CALLS_PERMISSION_TYPE) {
    throw new Erc7715RequestError(`Permission type "${permission.type}" is not supported`, 'unsupported');
  }
  let validUntil: number | undefined;
  for (const rule of request.rules ?? []) {
    if (rule?.type !== 'expiry') throw new Erc7715RequestError(`Rule type "${rule?.type}" is not supported`, 'unsupported');
    if (validUntil !== undefined) throw invalid('Only one expiry rule is allowed');
    const ts = (rule.data as { timestamp?: unknown })?.timestamp;
    if (typeof ts !== 'number' || !Number.isSafeInteger(ts)) throw invalid('expiry.timestamp must be an integer');
    validUntil = ts;
  }
  if (validUntil === undefined) {
    throw new Erc7715RequestError('An expiry rule is required; open-ended sessions are refused', 'unsupported');
  }
  const data = permission.data as unknown as Erc7715CallsData;
  if (!data || !Array.isArray(data.calls)) throw invalid('permission.data.calls must be an array');
  const hexAmount = (s: unknown, what: string): bigint => {
    if (typeof s !== 'string' || !/^0x[0-9a-fA-F]+$/.test(s)) throw invalid(`${what} must be a hex quantity`);
    return BigInt(s);
  };
  const grant: SessionKeyGrant = {
    sessionKey: request.to,
    calls: data.calls.map((c, i) => ({
      target: String(c?.target),
      selector: c?.selector === null || c?.selector === undefined ? null : String(c.selector),
      valueLimit: hexAmount(c?.valueLimit, `calls[${i}].valueLimit`),
      ...(c?.rules ? { rules: c.rules.map((r) => ({ ...r, params: [...r.params] })) } : {}),
    })),
    validAfter: data.validAfter ?? 0,
    validUntil,
    ...(data.gasBudget !== undefined ? { gasBudgetWei: hexAmount(data.gasBudget, 'gasBudget') } : {}),
    ...(data.rateLimit ? { rateLimit: { ...data.rateLimit } } : {}),
  };
  try {
    validateSessionKeyGrant(grant, { account: options.account, now: options.now });
  } catch (error) {
    throw invalid((error as Error).message);
  }
  return { grant, isAdjustmentAllowed: permission.isAdjustmentAllowed === true };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function asPermissionId(permissionId: Uint8Array | string): Uint8Array {
  const bytes = typeof permissionId === 'string' ? toBytes(permissionId) : permissionId;
  if (bytes.length !== 4) throw new Error(`A Kernel permission id is 4 bytes, got ${bytes.length}`);
  return bytes;
}

function isAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function requireAddress(value: unknown, what: string): void {
  if (typeof value !== 'string' || !isAddress(value)) throw new Error(`${what} must be a 20-byte hex address`);
}

function requireUint32(value: number, what: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error(`${what} must be a uint32`);
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
