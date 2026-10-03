import { keccak_256 } from '@noble/hashes/sha3.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { toChecksumAddress } from '@shiba-wallet/core';
import { parseSimulationResult } from './asset-diff.js';
import type { AssetChange } from './asset-diff.js';
import { recoverEip7702Authority } from './eip7702.js';
import { toBytes, toHex } from './encoding.js';
import { KERNEL_V3_3, KERNEL_V3_3_7702_DELEGATE } from './kernel-account.js';
import { KERNEL_PERMISSION_MODULES } from './kernel-permissions.js';
import { KERNEL_RECOVERY_MODULES } from './kernel-recovery.js';
import { KERNEL_WEBAUTHN_VALIDATOR } from './kernel-webauthn.js';
import type { JsonRpcTransport } from './rpc.js';
import { decodeRevertReason } from './simulate.js';
import { ENTRYPOINT_V07 } from './userop.js';

/**
 * Human-readable activity (phase 11 item 4): turns one mined EVM
 * transaction into a structured description and a plain-English sentence,
 * built ONLY from on-chain facts — the transaction (eth_getTransactionByHash)
 * and its receipt (eth_getTransactionReceipt). Nothing is inferred from
 * prices, names a contract reports about itself, or heuristics: when a fact
 * is not visible in those two objects, the description says so instead of
 * filling the gap.
 *
 * What is decoded, and from where:
 *
 *  - The top-level call, matched by its 4-byte selector (selectors are
 *    computed below with keccak256 over the canonical signatures):
 *    ERC-20 transfer/approve/transferFrom (EIP-20), ERC-721
 *    safeTransferFrom with and without data (EIP-721), ERC-1155
 *    safeTransferFrom/safeBatchTransferFrom (EIP-1155), setApprovalForAll
 *    (EIP-721/EIP-1155), Permit2 approve and both permit overloads
 *    (Uniswap/permit2 src/interfaces/IAllowanceTransfer.sol, main at
 *    cc56ad0f, fetched 2026-10-03), Uniswap Universal Router
 *    execute(bytes,bytes[],uint256) and execute(bytes,bytes[]) with their
 *    command bytes, ERC-4337 EntryPoint v0.7 handleOps
 *    (eth-infinitism/account-abstraction v0.7.0
 *    contracts/interfaces/IEntryPoint.sol and PackedUserOperation.sol), and
 *    the EIP-7702 authorization list of a type-0x04 transaction.
 *
 *  - Universal Router command names: Uniswap/universal-router
 *    contracts/libraries/Commands.sol. Two branches differ: `dev` (the
 *    branch the Uniswap deployments page links for "Universal Router
 *    2.1.2") masks the command type with 0x3f and leaves 0x07 a
 *    placeholder; `main` (543e1a19, fetched 2026-10-03) masks with 0x7f,
 *    names 0x07 PAY_PORTION_FULL_PRECISION and reserves 0x40.. for third
 *    parties. Only names that both branches agree on are decoded with
 *    certainty; 0x07 is named after `main` (on `dev` it reverts, so a
 *    successful transaction carrying it must be running `main`'s code), and
 *    any byte with 0x40 set is reported as an unknown command rather than
 *    guessed. The 0x80 bit is FLAG_ALLOW_REVERT on both branches.
 *    V4_SWAP inputs carry v4 actions (Uniswap/v4-periphery
 *    src/libraries/Actions.sol, main at 9969eec4); TAKE / TAKE_ALL /
 *    TAKE_PORTION parameters and the MSG_SENDER (address(1)) /
 *    ADDRESS_THIS (address(2)) recipient constants are from V4Router.sol,
 *    BaseActionsRouter.sol, CalldataDecoder.sol and ActionConstants.sol at
 *    the same commit; UNWRAP_WETH's (recipient, amountMin) input and the
 *    router's map(recipient) are from Dispatcher.sol on `dev`.
 *
 *  - Wallet-relevant token movements and approvals come from the receipt's
 *    logs through the SAME decoder the balance-change preview uses
 *    (./asset-diff.ts parseSimulationResult: ERC-20/721/1155 Transfer,
 *    TransferSingle/Batch, Approval, ApprovalForAll). The receipt's logs are
 *    handed to it as one successful "call" — the decoder only looks at
 *    each log's address, topics and data, which have the same shape in a
 *    receipt as in an eth_simulateV1 result.
 *
 *  - ETH value: the transaction's own `value`. ETH that moves INSIDE a
 *    call (a router paying out ETH, a smart account sending ETH) emits no
 *    log and is not in the receipt. It is reported only where the calldata
 *    proves it together with success: an ERC-4337 operation whose
 *    UserOperationEvent says success and whose callData is the account's
 *    own non-"try" execute (Kernel v3.3 ERC-7579 execute, SimpleAccount
 *    execute/executeBatch) — those revert as a whole if any call fails, so
 *    every listed call happened. A Universal Router swap that instructs the
 *    router to pay native ETH to the caller (v4 TAKE*, or UNWRAP_WETH) is
 *    described as "for ETH" WITHOUT an amount, because the amount is not in
 *    the receipt.
 *
 *  - Labels for contracts come from the small pinned table KNOWN_CONTRACTS
 *    below, each entry with its source. Everything else is shown by
 *    address. Events that only mean something when a specific contract
 *    emits them (UserOperationEvent, AccountDeployed, Permit2 Approval and
 *    Permit) are accepted ONLY from the pinned EntryPoint / Permit2
 *    addresses, so a look-alike event from another contract is ignored.
 *
 * Trust model (same as the preview): token Transfer events are emitted by
 * the token contracts themselves, so a hostile contract can emit events for
 * movements that never happened. Sentences therefore name tokens by the
 * caller-supplied metadata (tracked list, else the pinned table, else the
 * on-chain symbol marked "untracked token 0x…"), never by a symbol alone.
 */

// ---------------------------------------------------------------------------
// Selectors and topics
// ---------------------------------------------------------------------------

function keccakHex(signature: string): string {
  return toHex(keccak_256(utf8ToBytes(signature)));
}

function selectorHex(signature: string): string {
  return keccakHex(signature).slice(0, 10);
}

/** Canonical signatures of every top-level call the decoder recognizes. */
export const ACTIVITY_SIGNATURES = {
  erc20Transfer: 'transfer(address,uint256)',
  approve: 'approve(address,uint256)',
  transferFrom: 'transferFrom(address,address,uint256)',
  erc721SafeTransferFrom: 'safeTransferFrom(address,address,uint256)',
  erc721SafeTransferFromWithData: 'safeTransferFrom(address,address,uint256,bytes)',
  erc1155SafeTransferFrom: 'safeTransferFrom(address,address,uint256,uint256,bytes)',
  erc1155SafeBatchTransferFrom: 'safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)',
  setApprovalForAll: 'setApprovalForAll(address,bool)',
  permit2Approve: 'approve(address,address,uint160,uint48)',
  permit2PermitSingle: 'permit(address,((address,uint160,uint48,uint48),address,uint256),bytes)',
  permit2PermitBatch: 'permit(address,((address,uint160,uint48,uint48)[],address,uint256),bytes)',
  universalRouterExecuteWithDeadline: 'execute(bytes,bytes[],uint256)',
  universalRouterExecute: 'execute(bytes,bytes[])',
  handleOps:
    'handleOps((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes)[],address)',
  kernelExecute: 'execute(bytes32,bytes)',
  simpleAccountExecute: 'execute(address,uint256,bytes)',
  simpleAccountExecuteBatch: 'executeBatch(address[],uint256[],bytes[])',
} as const;

const SEL = Object.fromEntries(
  Object.entries(ACTIVITY_SIGNATURES).map(([k, v]) => [k, selectorHex(v)]),
) as { [K in keyof typeof ACTIVITY_SIGNATURES]: string };

/** Selectors (0x + 8 hex) of ACTIVITY_SIGNATURES, for tests and callers. */
export const ACTIVITY_SELECTORS: Readonly<typeof SEL> = SEL;

/** EntryPoint v0.7 UserOperationEvent (IEntryPoint.sol v0.7.0). */
export const USER_OPERATION_EVENT_TOPIC = keccakHex(
  'UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)',
);
/** EntryPoint v0.7 AccountDeployed(bytes32 indexed, address indexed, address factory, address paymaster). */
export const ACCOUNT_DEPLOYED_TOPIC = keccakHex('AccountDeployed(bytes32,address,address,address)');
/** EntryPoint v0.7 UserOperationRevertReason(bytes32 indexed, address indexed, uint256 nonce, bytes revertReason). */
export const USER_OPERATION_REVERT_REASON_TOPIC = keccakHex(
  'UserOperationRevertReason(bytes32,address,uint256,bytes)',
);
/** Permit2 Approval(address indexed owner, address indexed token, address indexed spender, uint160 amount, uint48 expiration). */
export const PERMIT2_APPROVAL_TOPIC = keccakHex('Approval(address,address,address,uint160,uint48)');
/** Permit2 Permit(address indexed owner, address indexed token, address indexed spender, uint160 amount, uint48 expiration, uint48 nonce). */
export const PERMIT2_PERMIT_TOPIC = keccakHex('Permit(address,address,address,uint160,uint48,uint48)');

/** Permit2's "unlimited" amount: IAllowanceTransfer.sol "Setting amount to type(uint160).max sets an unlimited approval". */
export const PERMIT2_MAX_AMOUNT = (1n << 160n) - 1n;
/** type(uint256).max, the conventional unlimited ERC-20 allowance. */
const MAX_UINT256 = (1n << 256n) - 1n;

// ---------------------------------------------------------------------------
// Pinned contract labels
// ---------------------------------------------------------------------------

export type KnownContractKind = 'token' | 'router' | 'entrypoint' | 'permit2' | 'kernel' | 'uniswap';

export interface KnownContract {
  /** Display name. */
  name: string;
  kind: KnownContractKind;
  /** Token symbol, for kind 'token' (identity is the pinned address, not the contract's own answer). */
  symbol?: string;
  /** Protocol name used in "on Uniswap", for routers. */
  protocol?: string;
  /** Where the address was verified. */
  source: string;
}

const UNISWAP_DEPLOYMENTS =
  'developers.uniswap.org/docs/protocols/v4/deployments, "Sepolia: 11155111" table (fetched 2026-10-03)';
const KERNEL_SOURCE =
  'kernel v3.3 README / ZeroDev SDK constants; on-chain checks on mainnet and Sepolia (./kernel-account.ts and module files)';

/**
 * Chain ids on which the Kernel v3.3 and EntryPoint v0.7 addresses were
 * verified on-chain by this project (./kernel-account.ts: mainnet and
 * Sepolia). Other chains get no Kernel label even if the address matches.
 */
const KERNEL_VERIFIED_CHAINS = [1n, 11155111n];

function entries(chainIds: bigint[], address: string, label: KnownContract): [string, KnownContract][] {
  return chainIds.map((c) => [`${c}:${address.toLowerCase()}`, label]);
}

const KNOWN: Map<string, KnownContract> = new Map([
  // Tokens.
  ...entries([1n], '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', {
    name: 'USDC',
    kind: 'token',
    symbol: 'USDC',
    source: "Circle's contract-addresses page + Etherscan + live symbol()/decimals() (AGENTS.md phase 3 task 2)",
  }),
  ...entries([11155111n], '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', {
    name: 'USDC',
    kind: 'token',
    symbol: 'USDC',
    source: "Circle's USDC contract-addresses page, Ethereum Sepolia (AGENTS.md phase 5 grand finale)",
  }),
  ...entries([11155111n], '0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4', {
    name: 'EURC',
    kind: 'token',
    symbol: 'EURC',
    source: "Circle's EURC contract-addresses page, Ethereum Sepolia (AGENTS.md 2026-10-02 retest)",
  }),
  // Uniswap (Sepolia only; mainnet router addresses were not verified here).
  ...entries([11155111n], '0x7E4f6c5e954Da5c61B3423D81E2277431Ac043f3', {
    name: 'Uniswap Universal Router',
    kind: 'router',
    protocol: 'Uniswap',
    source: `${UNISWAP_DEPLOYMENTS}: "Universal Router 2.1.2"`,
  }),
  ...entries([11155111n], '0x7dfd4f31be6814d2906bde155c3e1b146eac1468', {
    name: 'Uniswap Universal Router',
    kind: 'router',
    protocol: 'Uniswap',
    source: `${UNISWAP_DEPLOYMENTS}: "Universal Router 2.1.1"`,
  }),
  ...entries([11155111n], '0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b', {
    name: 'Uniswap Universal Router',
    kind: 'router',
    protocol: 'Uniswap',
    source: `${UNISWAP_DEPLOYMENTS}: "Universal Router"`,
  }),
  ...entries([11155111n], '0xE03A1074c86CFeDd5C142C4F04F1a1536e203543', {
    name: 'Uniswap v4 PoolManager',
    kind: 'uniswap',
    source: `${UNISWAP_DEPLOYMENTS}: "PoolManager"`,
  }),
  // Permit2: one CREATE2 address on every chain the deployments page lists
  // (Sepolia, Base Sepolia shown there); mainnet per the Permit2 README.
  ...entries([1n, 11155111n, 84532n], '0x000000000022D473030F116dDEE9F6B43aC78BA3', {
    name: 'Permit2',
    kind: 'permit2',
    source: `${UNISWAP_DEPLOYMENTS}; github.com/Uniswap/permit2 README`,
  }),
  // ERC-4337 and Kernel v3.3 (mainnet and Sepolia, verified on-chain).
  ...entries(KERNEL_VERIFIED_CHAINS, ENTRYPOINT_V07, {
    name: 'ERC-4337 EntryPoint v0.7',
    kind: 'entrypoint',
    source: 'eth-infinitism/account-abstraction v0.7.0 deployment; ./userop.ts ENTRYPOINT_V07',
  }),
  ...entries(KERNEL_VERIFIED_CHAINS, KERNEL_V3_3.metaFactory, {
    name: 'Kernel v3.3 meta factory',
    kind: 'kernel',
    source: KERNEL_SOURCE,
  }),
  ...entries(KERNEL_VERIFIED_CHAINS, KERNEL_V3_3.factory, {
    name: 'Kernel v3.3 factory',
    kind: 'kernel',
    source: KERNEL_SOURCE,
  }),
  ...entries(KERNEL_VERIFIED_CHAINS, KERNEL_V3_3.implementation, {
    name: 'Kernel v3.3',
    kind: 'kernel',
    source: KERNEL_SOURCE,
  }),
  ...entries(KERNEL_VERIFIED_CHAINS, KERNEL_V3_3.ecdsaValidator, {
    name: 'Kernel ECDSA validator',
    kind: 'kernel',
    source: KERNEL_SOURCE,
  }),
  ...entries(KERNEL_VERIFIED_CHAINS, KERNEL_RECOVERY_MODULES.weightedEcdsaValidator, {
    name: 'Kernel guardian validator (WeightedECDSAValidator)',
    kind: 'kernel',
    source: KERNEL_SOURCE,
  }),
  ...entries(KERNEL_VERIFIED_CHAINS, KERNEL_RECOVERY_MODULES.recoveryAction, {
    name: 'Kernel recovery action',
    kind: 'kernel',
    source: KERNEL_SOURCE,
  }),
  ...entries(KERNEL_VERIFIED_CHAINS, KERNEL_WEBAUTHN_VALIDATOR.address, {
    name: 'Kernel passkey validator',
    kind: 'kernel',
    source: KERNEL_SOURCE,
  }),
  ...entries(KERNEL_VERIFIED_CHAINS, KERNEL_PERMISSION_MODULES.ecdsaSigner, {
    name: 'Kernel session-key signer',
    kind: 'kernel',
    source: KERNEL_SOURCE,
  }),
]);

/** The pinned label for `address` on `chainId`, or null. */
export function knownContract(chainId: bigint, address: string | null | undefined): KnownContract | null {
  if (!address) return null;
  return KNOWN.get(`${chainId}:${address.toLowerCase()}`) ?? null;
}

// ---------------------------------------------------------------------------
// Strict ABI reading
// ---------------------------------------------------------------------------

class DecodeError extends Error {}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const HEX_RE = /^0x[0-9a-fA-F]*$/;

function checksum(address: string): string {
  return toChecksumAddress(toBytes(address));
}

function wordAt(data: Uint8Array, offset: number): bigint {
  if (offset < 0 || offset + 32 > data.length) throw new DecodeError('word out of range');
  let v = 0n;
  for (let i = 0; i < 32; i++) v = (v << 8n) | BigInt(data[offset + i]!);
  return v;
}

function smallInt(value: bigint, what: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new DecodeError(`${what} too large`);
  return Number(value);
}

function addressAt(data: Uint8Array, offset: number): string {
  const v = wordAt(data, offset);
  if (v >> 160n !== 0n) throw new DecodeError('address word has dirty high bytes');
  return checksum('0x' + v.toString(16).padStart(40, '0'));
}

/** A dynamic `bytes` whose head word is at headOffset, offsets relative to base. */
function bytesAt(data: Uint8Array, headOffset: number, base: number): Uint8Array {
  const start = base + smallInt(wordAt(data, headOffset), 'offset');
  const length = smallInt(wordAt(data, start), 'length');
  if (start + 32 + length > data.length) throw new DecodeError('bytes out of range');
  return data.slice(start + 32, start + 32 + length);
}

/** Start offsets of the elements of a dynamic array of dynamic items. */
function dynamicArrayItems(data: Uint8Array, headOffset: number, base: number): number[] {
  const start = base + smallInt(wordAt(data, headOffset), 'offset');
  const length = smallInt(wordAt(data, start), 'length');
  if (length > 1024) throw new DecodeError('array too long');
  const itemsBase = start + 32;
  const items: number[] = [];
  for (let i = 0; i < length; i++) {
    items.push(itemsBase + smallInt(wordAt(data, itemsBase + i * 32), 'item offset'));
  }
  return items;
}

/** Elements of a dynamic array of static words. */
function wordArray(data: Uint8Array, headOffset: number, base: number): bigint[] {
  const start = base + smallInt(wordAt(data, headOffset), 'offset');
  const length = smallInt(wordAt(data, start), 'length');
  if (length > 4096) throw new DecodeError('array too long');
  const words: bigint[] = [];
  for (let i = 0; i < length; i++) words.push(wordAt(data, start + 32 + i * 32));
  return words;
}

function bytesArray(data: Uint8Array, headOffset: number, base: number): Uint8Array[] {
  const start = base + smallInt(wordAt(data, headOffset), 'offset');
  const length = smallInt(wordAt(data, start), 'length');
  if (length > 1024) throw new DecodeError('array too long');
  const itemsBase = start + 32;
  const out: Uint8Array[] = [];
  for (let i = 0; i < length; i++) out.push(bytesAt(data, itemsBase + i * 32, itemsBase));
  return out;
}

// ---------------------------------------------------------------------------
// Universal Router commands and v4 actions
// ---------------------------------------------------------------------------

/** Command names, Commands.sol (see the module comment for the branch rule). */
export const UNIVERSAL_ROUTER_COMMANDS: Readonly<Record<number, string>> = {
  0x00: 'V3_SWAP_EXACT_IN',
  0x01: 'V3_SWAP_EXACT_OUT',
  0x02: 'PERMIT2_TRANSFER_FROM',
  0x03: 'PERMIT2_PERMIT_BATCH',
  0x04: 'SWEEP',
  0x05: 'TRANSFER',
  0x06: 'PAY_PORTION',
  0x07: 'PAY_PORTION_FULL_PRECISION',
  0x08: 'V2_SWAP_EXACT_IN',
  0x09: 'V2_SWAP_EXACT_OUT',
  0x0a: 'PERMIT2_PERMIT',
  0x0b: 'WRAP_ETH',
  0x0c: 'UNWRAP_WETH',
  0x0d: 'PERMIT2_TRANSFER_FROM_BATCH',
  0x0e: 'BALANCE_CHECK_ERC20',
  0x10: 'V4_SWAP',
  0x11: 'V3_POSITION_MANAGER_PERMIT',
  0x12: 'V3_POSITION_MANAGER_CALL',
  0x13: 'V4_INITIALIZE_POOL',
  0x14: 'V4_POSITION_MANAGER_CALL',
  0x21: 'EXECUTE_SUB_PLAN',
};

const SWAP_COMMANDS = new Set([0x00, 0x01, 0x08, 0x09, 0x10]);

/** v4-periphery Actions.sol names (main at 9969eec4). */
export const V4_ACTIONS: Readonly<Record<number, string>> = {
  0x00: 'INCREASE_LIQUIDITY',
  0x01: 'DECREASE_LIQUIDITY',
  0x02: 'MINT_POSITION',
  0x03: 'BURN_POSITION',
  0x04: 'INCREASE_LIQUIDITY_FROM_DELTAS',
  0x05: 'MINT_POSITION_FROM_DELTAS',
  0x06: 'SWAP_EXACT_IN_SINGLE',
  0x07: 'SWAP_EXACT_IN',
  0x08: 'SWAP_EXACT_OUT_SINGLE',
  0x09: 'SWAP_EXACT_OUT',
  0x0a: 'DONATE',
  0x0b: 'SETTLE',
  0x0c: 'SETTLE_ALL',
  0x0d: 'SETTLE_PAIR',
  0x0e: 'TAKE',
  0x0f: 'TAKE_ALL',
  0x10: 'TAKE_PORTION',
  0x11: 'TAKE_PAIR',
  0x12: 'CLOSE_CURRENCY',
  0x13: 'CLEAR_OR_TAKE',
  0x14: 'SWEEP',
  0x15: 'WRAP',
  0x16: 'UNWRAP',
  0x17: 'MINT_6909',
  0x18: 'BURN_6909',
  0x19: 'UNWIND_WITH_FALLBACK',
};

/** ActionConstants.MSG_SENDER / ADDRESS_THIS. */
const MSG_SENDER_SENTINEL = 1n;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface UniversalRouterCommand {
  /** The raw command byte. */
  byte: number;
  /** Command type (byte & 0x3f); null when bit 0x40 is set (see module comment). */
  type: number | null;
  /** Name from Commands.sol, or "UNKNOWN_0x.." */
  name: string;
  /** FLAG_ALLOW_REVERT (0x80): this command may fail without failing the transaction. */
  allowRevert: boolean;
  /** For V4_SWAP: the v4 action names, in order (null if the input did not decode). */
  v4Actions?: string[] | null;
}

function commandName(byte: number): { type: number | null; name: string } {
  if (byte & 0x40) return { type: null, name: `UNKNOWN_0x${byte.toString(16).padStart(2, '0')}` };
  const type = byte & 0x3f;
  return {
    type,
    name: UNIVERSAL_ROUTER_COMMANDS[type] ?? `UNKNOWN_0x${type.toString(16).padStart(2, '0')}`,
  };
}

/**
 * True when `recipient` (a raw router recipient word) maps to `caller`
 * under the router's map(): MSG_SENDER means the caller, anything else is
 * itself.
 */
function mapsToCaller(recipient: bigint, caller: string): boolean {
  if (recipient === MSG_SENDER_SENTINEL) return true;
  return '0x' + recipient.toString(16).padStart(40, '0') === caller.toLowerCase();
}

/**
 * Decodes one V4_SWAP input — abi.encode(bytes actions, bytes[] params) —
 * and reports whether a TAKE / TAKE_ALL / TAKE_PORTION pays native ETH
 * (currency address(0)) to the caller.
 */
function decodeV4Swap(input: Uint8Array, caller: string): { actions: string[]; nativeToCaller: boolean } {
  const actions = bytesAt(input, 0, 0);
  const params = bytesArray(input, 32, 0);
  if (params.length !== actions.length) throw new DecodeError('actions/params length mismatch');
  let nativeToCaller = false;
  const names: string[] = [];
  actions.forEach((code, i) => {
    names.push(V4_ACTIONS[code] ?? `UNKNOWN_0x${code.toString(16).padStart(2, '0')}`);
    const p = params[i]!;
    if (code === 0x0f) {
      // TAKE_ALL (currency, minAmount) → always to msgSender().
      if (wordAt(p, 0) === 0n) nativeToCaller = true;
    } else if (code === 0x0e || code === 0x10) {
      // TAKE / TAKE_PORTION (currency, recipient, amount|bips).
      if (wordAt(p, 0) === 0n && mapsToCaller(wordAt(p, 32), caller)) nativeToCaller = true;
    }
  });
  return { actions: names, nativeToCaller };
}

function decodeUniversalRouter(
  args: Uint8Array,
  withDeadline: boolean,
  caller: string,
): { commands: UniversalRouterCommand[]; deadline: bigint | null; nativeToCaller: boolean } {
  const commandBytes = bytesAt(args, 0, 0);
  const inputs = bytesArray(args, 32, 0);
  if (inputs.length !== commandBytes.length) throw new DecodeError('commands/inputs length mismatch');
  const deadline = withDeadline ? wordAt(args, 64) : null;
  let nativeToCaller = false;
  const commands: UniversalRouterCommand[] = Array.from(commandBytes, (byte, i) => {
    const { type, name } = commandName(byte);
    const allowRevert = (byte & 0x80) !== 0;
    const command: UniversalRouterCommand = { byte, type, name, allowRevert };
    if (type === 0x10) {
      try {
        const v4 = decodeV4Swap(inputs[i]!, caller);
        command.v4Actions = v4.actions;
        // A command that may revert silently proves nothing.
        if (!allowRevert && v4.nativeToCaller) nativeToCaller = true;
      } catch {
        command.v4Actions = null;
      }
    } else if (type === 0x0c && !allowRevert) {
      // UNWRAP_WETH (recipient, amountMin): the router unwraps its WETH and pays ETH to recipient.
      try {
        if (mapsToCaller(wordAt(inputs[i]!, 0), caller)) nativeToCaller = true;
      } catch {
        // Undecodable input: no claim.
      }
    }
    return command;
  });
  return { commands, deadline, nativeToCaller };
}

// ---------------------------------------------------------------------------
// Call decoding
// ---------------------------------------------------------------------------

/** What a call (top-level, or one call inside a smart-account operation) does, from its calldata. */
export type DecodedCall =
  | { kind: 'deployment' }
  | { kind: 'native-transfer'; to: string; value: bigint }
  | { kind: 'erc20-transfer'; token: string; to: string; amount: bigint }
  /** approve(address,uint256): ERC-20 allowance or ERC-721 single-token approval (same selector). */
  | { kind: 'approve'; token: string; spender: string; amount: bigint }
  | { kind: 'transfer-from'; token: string; from: string; to: string; amountOrId: bigint }
  | { kind: 'set-approval-for-all'; collection: string; operator: string; approved: boolean }
  | { kind: 'erc721-safe-transfer'; collection: string; from: string; to: string; tokenId: bigint }
  | { kind: 'erc1155-safe-transfer'; collection: string; from: string; to: string; id: bigint; amount: bigint }
  | { kind: 'erc1155-safe-batch-transfer'; collection: string; from: string; to: string; ids: bigint[]; amounts: bigint[] }
  | { kind: 'permit2-approve'; permit2: string; token: string; spender: string; amount: bigint; expiration: bigint }
  | { kind: 'permit2-permit'; permit2: string; owner: string; spender: string; tokens: string[] }
  | {
      kind: 'universal-router';
      router: string;
      commands: UniversalRouterCommand[];
      deadline: bigint | null;
      /** The router was told to pay native ETH to the caller (amount not in the receipt). */
      nativeToCaller: boolean;
    }
  | { kind: 'handle-ops'; entryPoint: string; opCount: number }
  | { kind: 'contract-call'; to: string; selector: string | null; value: bigint };

function hexToBytes(hex: string): Uint8Array {
  return toBytes(hex);
}

/**
 * Decodes one call from `caller` to `to` with `data` and `value`. Unknown
 * selectors, malformed arguments and contracts the selector would only
 * make sense for when pinned (router, EntryPoint, Permit2) fall back to
 * 'contract-call' — never an error.
 */
export function decodeCall(
  chainId: bigint,
  caller: string,
  to: string | null,
  data: Uint8Array,
  value: bigint,
): DecodedCall {
  if (to === null) return { kind: 'deployment' };
  const target = checksum(to);
  if (data.length === 0) return { kind: 'native-transfer', to: target, value };
  const fallback: DecodedCall = {
    kind: 'contract-call',
    to: target,
    selector: data.length >= 4 ? toHex(data.slice(0, 4)) : null,
    value,
  };
  if (data.length < 4) return fallback;
  const selector = toHex(data.slice(0, 4));
  const args = data.slice(4);
  const known = knownContract(chainId, target);
  try {
    switch (selector) {
      case SEL.erc20Transfer:
        return { kind: 'erc20-transfer', token: target, to: addressAt(args, 0), amount: wordAt(args, 32) };
      case SEL.approve:
        return { kind: 'approve', token: target, spender: addressAt(args, 0), amount: wordAt(args, 32) };
      case SEL.transferFrom:
        return {
          kind: 'transfer-from',
          token: target,
          from: addressAt(args, 0),
          to: addressAt(args, 32),
          amountOrId: wordAt(args, 64),
        };
      case SEL.setApprovalForAll: {
        const flag = wordAt(args, 32);
        if (flag !== 0n && flag !== 1n) throw new DecodeError('not an ABI bool');
        return { kind: 'set-approval-for-all', collection: target, operator: addressAt(args, 0), approved: flag === 1n };
      }
      case SEL.erc721SafeTransferFrom:
      case SEL.erc721SafeTransferFromWithData:
        return {
          kind: 'erc721-safe-transfer',
          collection: target,
          from: addressAt(args, 0),
          to: addressAt(args, 32),
          tokenId: wordAt(args, 64),
        };
      case SEL.erc1155SafeTransferFrom:
        return {
          kind: 'erc1155-safe-transfer',
          collection: target,
          from: addressAt(args, 0),
          to: addressAt(args, 32),
          id: wordAt(args, 64),
          amount: wordAt(args, 96),
        };
      case SEL.erc1155SafeBatchTransferFrom: {
        const ids = wordArray(args, 64, 0);
        const amounts = wordArray(args, 96, 0);
        if (ids.length !== amounts.length) throw new DecodeError('ids/amounts mismatch');
        return {
          kind: 'erc1155-safe-batch-transfer',
          collection: target,
          from: addressAt(args, 0),
          to: addressAt(args, 32),
          ids,
          amounts,
        };
      }
      case SEL.permit2Approve:
        if (known?.kind !== 'permit2') return fallback;
        return {
          kind: 'permit2-approve',
          permit2: target,
          token: addressAt(args, 0),
          spender: addressAt(args, 32),
          amount: wordAt(args, 64),
          expiration: wordAt(args, 96),
        };
      case SEL.permit2PermitSingle:
        if (known?.kind !== 'permit2') return fallback;
        // (owner, ((token, amount, expiration, nonce), spender, sigDeadline), signature):
        // the PermitSingle tuple is static, so it sits inline after owner.
        return {
          kind: 'permit2-permit',
          permit2: target,
          owner: addressAt(args, 0),
          tokens: [addressAt(args, 32)],
          spender: addressAt(args, 32 * 5),
        };
      case SEL.permit2PermitBatch: {
        if (known?.kind !== 'permit2') return fallback;
        // PermitBatch is dynamic: head word 1 is its offset.
        const batch = smallInt(wordAt(args, 32), 'offset');
        const detailsStart = batch + smallInt(wordAt(args, batch), 'offset');
        const count = smallInt(wordAt(args, detailsStart), 'length');
        if (count > 256) throw new DecodeError('too many permit details');
        const tokens: string[] = [];
        for (let i = 0; i < count; i++) tokens.push(addressAt(args, detailsStart + 32 + i * 128));
        return {
          kind: 'permit2-permit',
          permit2: target,
          owner: addressAt(args, 0),
          tokens,
          spender: addressAt(args, batch + 32),
        };
      }
      case SEL.universalRouterExecuteWithDeadline:
      case SEL.universalRouterExecute: {
        if (known?.kind !== 'router') return fallback;
        const decoded = decodeUniversalRouter(
          args,
          selector === SEL.universalRouterExecuteWithDeadline,
          caller,
        );
        return { kind: 'universal-router', router: target, ...decoded };
      }
      case SEL.handleOps: {
        if (known?.kind !== 'entrypoint') return fallback;
        return { kind: 'handle-ops', entryPoint: target, opCount: dynamicArrayItems(args, 0, 0).length };
      }
      default:
        return fallback;
    }
  } catch (error) {
    if (error instanceof DecodeError) return fallback;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Smart-account operations
// ---------------------------------------------------------------------------

/** One call executed by a smart-account operation (from its callData). */
export interface InnerCall {
  to: string;
  value: bigint;
  decoded: DecodedCall;
}

export interface UserOpOutcome {
  userOpHash: string;
  /** The smart account (one of the wallet's addresses). */
  sender: string;
  paymaster: string | null;
  nonce: bigint;
  /** UserOperationEvent.success: the account's execution did not revert. */
  success: boolean;
  /** Wei the account or paymaster paid for the operation. */
  actualGasCost: bigint;
  /** An AccountDeployed event for this operation was emitted (first operation). */
  deployed: boolean;
  /** Decoded UserOperationRevertReason, when the execution reverted with data. */
  revertReason?: string;
  /**
   * The calls the account's callData asked for, decoded from Kernel v3.3
   * execute(bytes32,bytes) or SimpleAccount execute/executeBatch; null when
   * the callData did not decode (or the operation is not in handleOps'
   * input).
   */
  calls: InnerCall[] | null;
  /**
   * True when every listed call is proven to have happened: success AND an
   * execution mode that reverts the whole operation if one call fails
   * (Kernel exec type 0x00, SimpleAccount). False for Kernel "try" mode.
   */
  callsGuaranteed: boolean;
}

/** Decodes a smart account's callData into the calls it executes. Null when unknown. */
function decodeAccountCalls(
  chainId: bigint,
  sender: string,
  callData: Uint8Array,
): { calls: InnerCall[]; guaranteed: boolean } | null {
  if (callData.length < 4) return null;
  const selector = toHex(callData.slice(0, 4));
  const args = callData.slice(4);
  const inner = (to: string, value: bigint, data: Uint8Array): InnerCall => ({
    to: checksum(to),
    value,
    decoded: decodeCall(chainId, sender, to, data, value),
  });
  try {
    if (selector === SEL.kernelExecute) {
      // ERC-7579 mode word: byte 0 call type, byte 1 exec type
      // (Kernel v3.3 src/types/Constants.sol; ./kernel-account.ts).
      const mode = wordAt(args, 0);
      const callType = Number((mode >> 248n) & 0xffn);
      const execType = Number((mode >> 240n) & 0xffn);
      const exec = bytesAt(args, 32, 0);
      const guaranteed = execType === 0x00;
      if (callType === 0x00) {
        // Single: abi.encodePacked(target, value, callData).
        if (exec.length < 52) throw new DecodeError('short single execution');
        const target = toHex(exec.slice(0, 20));
        const value = wordAt(exec, 20);
        return { calls: [inner(target, value, exec.slice(52))], guaranteed };
      }
      if (callType === 0x01) {
        // Batch: abi.encode(Execution[]), Execution = (address, uint256, bytes).
        const items = dynamicArrayItems(exec, 0, 0);
        return {
          calls: items.map((start) =>
            inner(addressAt(exec, start), wordAt(exec, start + 32), bytesAt(exec, start + 64, start)),
          ),
          guaranteed,
        };
      }
      return null; // delegatecall or unknown call type: not described.
    }
    if (selector === SEL.simpleAccountExecute) {
      return {
        calls: [inner(addressAt(args, 0), wordAt(args, 32), bytesAt(args, 64, 0))],
        guaranteed: true,
      };
    }
    if (selector === SEL.simpleAccountExecuteBatch) {
      const dest = wordArray(args, 0, 0);
      const values = wordArray(args, 32, 0);
      const funcs = bytesArray(args, 64, 0);
      if (funcs.length !== dest.length || (values.length !== 0 && values.length !== dest.length)) {
        throw new DecodeError('batch length mismatch');
      }
      return {
        calls: dest.map((d, i) => {
          if (d >> 160n !== 0n) throw new DecodeError('dirty address');
          return inner('0x' + d.toString(16).padStart(40, '0'), values[i] ?? 0n, funcs[i]!);
        }),
        guaranteed: true,
      };
    }
  } catch (error) {
    if (error instanceof DecodeError) return null;
    throw error;
  }
  return null;
}

/** handleOps input → per-operation (sender, nonce, callData), in order. */
function decodeHandleOpsInput(input: Uint8Array): { sender: string; nonce: bigint; callData: Uint8Array }[] {
  const args = input.slice(4);
  return dynamicArrayItems(args, 0, 0).map((start) => ({
    sender: addressAt(args, start),
    nonce: wordAt(args, start + 32),
    callData: bytesAt(args, start + 96, start),
  }));
}

// ---------------------------------------------------------------------------
// Raw RPC shapes
// ---------------------------------------------------------------------------

interface RawLog {
  address: string;
  topics: string[];
  data: string;
}

/** The fields of eth_getTransactionByHash this module reads. */
export interface RawTransaction {
  hash: string;
  from: string;
  to: string | null;
  input: string;
  value: string;
  nonce: string;
  type?: string;
  chainId?: string;
  blockNumber: string | null;
  blockHash?: string | null;
  authorizationList?: {
    chainId: string;
    address: string;
    nonce: string;
    yParity: string;
    r: string;
    s: string;
  }[];
}

/** The fields of eth_getTransactionReceipt this module reads. */
export interface RawReceipt {
  transactionHash: string;
  blockHash?: string;
  blockNumber: string;
  status: string;
  contractAddress?: string | null;
  logs: RawLog[];
}

const QUANTITY_RE = /^0x[0-9a-fA-F]+$/;

function quantity(value: unknown, what: string): bigint {
  if (typeof value !== 'string' || !QUANTITY_RE.test(value)) throw new Error(`Malformed ${what}`);
  return BigInt(value);
}

function checkTransaction(raw: unknown): RawTransaction {
  const tx = raw as Partial<RawTransaction> | null;
  if (!tx || typeof tx !== 'object') throw new Error('Malformed transaction');
  if (typeof tx.hash !== 'string' || !HASH_RE.test(tx.hash)) throw new Error('Malformed transaction hash');
  if (typeof tx.from !== 'string' || !ADDRESS_RE.test(tx.from)) throw new Error('Malformed transaction sender');
  if (tx.to !== null && (typeof tx.to !== 'string' || !ADDRESS_RE.test(tx.to))) {
    throw new Error('Malformed transaction recipient');
  }
  if (typeof tx.input !== 'string' || !HEX_RE.test(tx.input) || tx.input.length % 2 !== 0) {
    throw new Error('Malformed transaction input');
  }
  quantity(tx.value, 'transaction value');
  quantity(tx.nonce, 'transaction nonce');
  return tx as RawTransaction;
}

function checkReceipt(raw: unknown): RawReceipt {
  const r = raw as Partial<RawReceipt> | null;
  if (!r || typeof r !== 'object') throw new Error('Malformed receipt');
  if (typeof r.transactionHash !== 'string' || !HASH_RE.test(r.transactionHash)) {
    throw new Error('Malformed receipt hash');
  }
  const status = quantity(r.status, 'receipt status');
  if (status !== 0n && status !== 1n) throw new Error('Malformed receipt status');
  if (!Array.isArray(r.logs)) throw new Error('Receipt has no logs array');
  return r as RawReceipt;
}

// ---------------------------------------------------------------------------
// Description
// ---------------------------------------------------------------------------

/** A wallet-relevant change from the receipt's logs, and which wallet address it concerns. */
export interface WalletMovement {
  account: string;
  change: AssetChange;
}

/** A Permit2 allowance set for one of the wallet's addresses (from the pinned Permit2's events). */
export interface Permit2Grant {
  via: 'approve' | 'permit';
  owner: string;
  token: string;
  spender: string;
  amount: bigint;
  unlimited: boolean;
  expiration: bigint;
}

/** One EIP-7702 authorization signed by one of the wallet's addresses. */
export interface AuthorizationOutcome {
  authority: string;
  delegate: string;
  nonce: bigint;
  chainId: bigint;
  /** 'revoke' (zero address), 'kernel' (the pinned Kernel v3.3 delegate), or 'other'. */
  target: 'revoke' | 'kernel' | 'other';
  /**
   * 'applied' when the transaction proves the tuple was valid: the
   * authority sent the transaction itself and the tuple nonce is the
   * transaction nonce + 1 (EIP-7702: the sender's nonce is incremented
   * before the list is processed; tuples are processed even if execution
   * later reverts). 'included' otherwise — the tuple is in the
   * transaction, but whether the authority's nonce matched at that moment
   * is not visible in the transaction or receipt.
   */
  effect: 'applied' | 'included';
}

export interface ActivityDescription {
  hash: string;
  chainId: bigint;
  blockNumber: bigint;
  status: 'success' | 'failed';
  /** Transaction type (0, 1, 2, 4 …). */
  type: number;
  from: string;
  to: string | null;
  value: bigint;
  nonce: bigint;
  /** The wallet addresses this description was built for (EIP-55). */
  wallet: string[];
  /** True when one of the wallet addresses sent the transaction. */
  fromWallet: boolean;
  /** The top-level call. */
  call: DecodedCall;
  /** Contract created by a deployment transaction. */
  contractAddress: string | null;
  /** Token movements and approvals involving the wallet, from the logs. */
  movements: WalletMovement[];
  /** Permit2 allowances set for the wallet (pinned Permit2 events only). */
  permit2: Permit2Grant[];
  /** The wallet's ERC-4337 operations in this bundle (pinned EntryPoint events only). */
  userOps: UserOpOutcome[];
  /** Operations in the bundle that belong to other senders. */
  otherUserOps: number;
  /** EIP-7702 authorizations signed by the wallet. */
  authorizations: AuthorizationOutcome[];
  /** The main other party (recipient, spender, router, sender …), or null. */
  counterparty: string | null;
  /** Logs with a known token-event topic but a non-standard shape (never guessed). */
  skippedLogs: number;
}

export interface DescribeOptions {
  /** The wallet's addresses: the EOA, plus its smart accounts if known. */
  wallet: string[];
  /** The chain the transaction is expected on (EIP-155 id). */
  chainId: bigint;
}

function topicAddress(topic: string | undefined): string | null {
  if (!topic || !HASH_RE.test(topic) || !/^0x0{24}/i.test(topic)) return null;
  return checksum('0x' + topic.slice(26));
}

function isRawLog(value: unknown): value is RawLog {
  if (!value || typeof value !== 'object') return false;
  const l = value as Partial<RawLog>;
  return (
    typeof l.address === 'string' &&
    ADDRESS_RE.test(l.address) &&
    Array.isArray(l.topics) &&
    l.topics.every((t) => typeof t === 'string' && HASH_RE.test(t)) &&
    typeof l.data === 'string' &&
    HEX_RE.test(l.data) &&
    l.data.length % 2 === 0
  );
}

function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

function counterpartyOf(call: DecodedCall): string | null {
  switch (call.kind) {
    case 'native-transfer':
    case 'erc20-transfer':
    case 'erc721-safe-transfer':
    case 'erc1155-safe-transfer':
    case 'erc1155-safe-batch-transfer':
    case 'transfer-from':
      return call.to;
    case 'approve':
    case 'permit2-approve':
    case 'permit2-permit':
      return call.spender;
    case 'set-approval-for-all':
      return call.operator;
    case 'universal-router':
      return call.router;
    case 'handle-ops':
      return null;
    case 'contract-call':
      return call.to;
    case 'deployment':
      return null;
  }
}

/**
 * Builds the description from an already-fetched transaction and receipt.
 * Pure (no network); decodeActivity below fetches and calls this.
 */
export function describeTransaction(
  rawTx: unknown,
  rawReceipt: unknown,
  options: DescribeOptions,
): ActivityDescription {
  const tx = checkTransaction(rawTx);
  const receipt = checkReceipt(rawReceipt);
  if (receipt.transactionHash.toLowerCase() !== tx.hash.toLowerCase()) {
    throw new Error('The receipt belongs to a different transaction');
  }
  if (tx.chainId !== undefined && quantity(tx.chainId, 'chain id') !== options.chainId) {
    throw new Error(`The transaction is on chain ${BigInt(tx.chainId)}, not ${options.chainId}`);
  }
  for (const w of options.wallet) if (!ADDRESS_RE.test(w)) throw new Error(`Not an address: ${w}`);
  const wallet = [...new Set(options.wallet.map((w) => checksum(w)))];
  const isWallet = (a: string | null | undefined) => !!a && wallet.some((w) => sameAddress(w, a));

  const chainId = options.chainId;
  const from = checksum(tx.from);
  const to = tx.to === null ? null : checksum(tx.to);
  const value = quantity(tx.value, 'value');
  const nonce = quantity(tx.nonce, 'nonce');
  const input = hexToBytes(tx.input);
  const status: 'success' | 'failed' = quantity(receipt.status, 'status') === 1n ? 'success' : 'failed';
  const call = decodeCall(chainId, from, to, input, value);

  // Wallet-relevant token movements, through the preview's own decoder.
  const logs = receipt.logs;
  const goodLogs = logs.filter(isRawLog);
  let skippedLogs = logs.length - goodLogs.length;
  const movements: WalletMovement[] = [];
  let skippedCounted = false;
  for (const account of wallet) {
    const parsed = parseSimulationResult(
      [{ calls: [{ status: '0x1', logs: goodLogs }] }],
      1,
      account,
    );
    // Skipped (non-standard) logs do not depend on the wallet address; count once.
    if (!skippedCounted) {
      skippedLogs += parsed.skippedLogs;
      skippedCounted = true;
    }
    for (const change of parsed.changes) {
      // A receipt cannot hold traceTransfers pseudo-events; ETH value is read from the transaction.
      if (change.type === 'native') continue;
      movements.push({ account, change });
    }
  }

  // Permit2 allowances (pinned Permit2 only).
  const permit2: Permit2Grant[] = [];
  for (const log of goodLogs) {
    if (knownContract(chainId, log.address)?.kind !== 'permit2') continue;
    const topic0 = log.topics[0]?.toLowerCase();
    if (topic0 !== PERMIT2_APPROVAL_TOPIC && topic0 !== PERMIT2_PERMIT_TOPIC) continue;
    const owner = topicAddress(log.topics[1]);
    const token = topicAddress(log.topics[2]);
    const spender = topicAddress(log.topics[3]);
    const data = hexToBytes(log.data);
    const words = topic0 === PERMIT2_APPROVAL_TOPIC ? 2 : 3;
    if (log.topics.length !== 4 || !owner || !token || !spender || data.length !== words * 32) {
      skippedLogs += 1;
      continue;
    }
    if (!isWallet(owner)) continue;
    const amount = wordAt(data, 0);
    permit2.push({
      via: topic0 === PERMIT2_APPROVAL_TOPIC ? 'approve' : 'permit',
      owner,
      token,
      spender,
      amount,
      unlimited: amount === PERMIT2_MAX_AMOUNT,
      expiration: wordAt(data, 32),
    });
  }

  // ERC-4337 operations (pinned EntryPoint only, and only when it is the call target).
  const userOps: UserOpOutcome[] = [];
  let otherUserOps = 0;
  if (call.kind === 'handle-ops') {
    let opsInput: { sender: string; nonce: bigint; callData: Uint8Array }[] = [];
    try {
      opsInput = decodeHandleOpsInput(input);
    } catch (error) {
      if (!(error instanceof DecodeError)) throw error;
    }
    const fromEntryPoint = goodLogs.filter((l) => sameAddress(l.address, call.entryPoint));
    const deployedHashes = new Set<string>();
    const revertReasons = new Map<string, string>();
    for (const log of fromEntryPoint) {
      const topic0 = log.topics[0]?.toLowerCase();
      if (topic0 === ACCOUNT_DEPLOYED_TOPIC && log.topics[1]) deployedHashes.add(log.topics[1].toLowerCase());
      if (topic0 === USER_OPERATION_REVERT_REASON_TOPIC && log.topics[1]) {
        try {
          const data = hexToBytes(log.data);
          const reason = bytesAt(data, 32, 0);
          revertReasons.set(log.topics[1].toLowerCase(), decodeRevertReason(toHex(reason)));
        } catch {
          // Malformed reason: omitted.
        }
      }
    }
    for (const log of fromEntryPoint) {
      if (log.topics[0]?.toLowerCase() !== USER_OPERATION_EVENT_TOPIC) continue;
      const sender = topicAddress(log.topics[2]);
      const paymaster = topicAddress(log.topics[3]);
      const data = hexToBytes(log.data);
      if (log.topics.length !== 4 || !sender || !paymaster || data.length !== 128) {
        skippedLogs += 1;
        continue;
      }
      if (!isWallet(sender)) {
        otherUserOps += 1;
        continue;
      }
      const successWord = wordAt(data, 32);
      if (successWord !== 0n && successWord !== 1n) {
        skippedLogs += 1;
        continue;
      }
      const opNonce = wordAt(data, 0);
      const userOpHash = log.topics[1]!.toLowerCase();
      const source = opsInput.find((o) => sameAddress(o.sender, sender) && o.nonce === opNonce);
      const decoded = source ? decodeAccountCalls(chainId, sender, source.callData) : null;
      const success = successWord === 1n;
      const reason = revertReasons.get(userOpHash);
      userOps.push({
        userOpHash,
        sender,
        paymaster: paymaster === ZERO_ADDRESS ? null : paymaster,
        nonce: opNonce,
        success,
        actualGasCost: wordAt(data, 64),
        deployed: deployedHashes.has(userOpHash),
        ...(reason !== undefined ? { revertReason: reason } : {}),
        calls: decoded ? decoded.calls : null,
        callsGuaranteed: !!decoded && decoded.guaranteed && success,
      });
    }
  }

  // EIP-7702 authorizations signed by the wallet.
  const authorizations: AuthorizationOutcome[] = [];
  const txType = tx.type !== undefined ? Number(quantity(tx.type, 'type')) : 0;
  if (txType === 4 && Array.isArray(tx.authorizationList)) {
    for (const raw of tx.authorizationList) {
      try {
        const authChain = quantity(raw.chainId, 'authorization chain id');
        if (authChain !== 0n && authChain !== chainId) continue; // invalid here: skipped by the node too
        if (!ADDRESS_RE.test(raw.address)) continue;
        const authNonce = quantity(raw.nonce, 'authorization nonce');
        const yParity = Number(quantity(raw.yParity, 'yParity'));
        if (yParity !== 0 && yParity !== 1) continue;
        const pad = (h: string) => toBytes('0x' + quantity(h, 'signature').toString(16).padStart(64, '0'));
        const authority = recoverEip7702Authority({
          chainId: authChain,
          address: raw.address,
          nonce: authNonce,
          yParity: yParity as 0 | 1,
          r: pad(raw.r),
          s: pad(raw.s),
        });
        if (!isWallet(authority)) continue;
        const delegate = checksum(raw.address);
        authorizations.push({
          authority,
          delegate,
          nonce: authNonce,
          chainId: authChain,
          target: delegate === ZERO_ADDRESS ? 'revoke' : sameAddress(delegate, KERNEL_V3_3_7702_DELEGATE) ? 'kernel' : 'other',
          effect: sameAddress(authority, from) && authNonce === nonce + 1n ? 'applied' : 'included',
        });
      } catch {
        // An invalid tuple (bad signature, high s, malformed field) is skipped by
        // the node as well; it says nothing about the wallet.
      }
    }
  }

  let counterparty = counterpartyOf(call);
  if (call.kind === 'handle-ops') {
    const only = userOps.length === 1 ? userOps[0]!.calls : null;
    counterparty = only && only.length === 1 ? counterpartyOf(only[0]!.decoded) : null;
  }
  if (!isWallet(from) && call.kind !== 'handle-ops') {
    // Someone else's transaction: the other party is its sender.
    counterparty = from;
  }

  return {
    hash: tx.hash.toLowerCase(),
    chainId,
    blockNumber: quantity(receipt.blockNumber, 'block number'),
    status,
    type: txType,
    from,
    to,
    value,
    nonce,
    wallet,
    fromWallet: isWallet(from),
    call,
    contractAddress:
      typeof receipt.contractAddress === 'string' && ADDRESS_RE.test(receipt.contractAddress)
        ? checksum(receipt.contractAddress)
        : null,
    movements,
    permit2,
    userOps,
    otherUserOps,
    authorizations,
    counterparty,
    skippedLogs,
  };
}

export type ActivityDecodeOutcome =
  | { status: 'ok'; description: ActivityDescription }
  /** The endpoint does not know the transaction. */
  | { status: 'not-found' }
  /** Known but not yet in a block. */
  | { status: 'pending' }
  /**
   * Mined, but the endpoint answered the receipt with null (or one that
   * does not match the transaction's block). Observed live on 2026-10-03:
   * ethereum-sepolia-rpc.publicnode.com answered null for a mined
   * transaction's receipt on roughly half of the requests (load-balanced
   * backends). Callers should try again later, not show anything.
   */
  | { status: 'receipt-unavailable' };

/**
 * Fetches a transaction and its receipt and describes it. Transport errors
 * propagate unchanged; a malformed answer throws.
 */
export async function decodeActivity(
  transport: JsonRpcTransport,
  hash: string,
  options: DescribeOptions,
): Promise<ActivityDecodeOutcome> {
  if (!HASH_RE.test(hash)) throw new Error(`Not a transaction hash: ${hash}`);
  const tx = await transport('eth_getTransactionByHash', [hash]);
  if (tx === null || tx === undefined) return { status: 'not-found' };
  const checked = checkTransaction(tx);
  if (checked.hash.toLowerCase() !== hash.toLowerCase()) throw new Error('The endpoint returned a different transaction');
  if (checked.blockNumber === null || checked.blockNumber === undefined) return { status: 'pending' };
  const receipt = await transport('eth_getTransactionReceipt', [hash]);
  if (receipt === null || receipt === undefined) return { status: 'receipt-unavailable' };
  const r = receipt as Partial<RawReceipt>;
  if (
    typeof r.blockNumber !== 'string' ||
    r.blockNumber.toLowerCase() !== checked.blockNumber.toLowerCase() ||
    (typeof r.blockHash === 'string' &&
      typeof checked.blockHash === 'string' &&
      r.blockHash.toLowerCase() !== checked.blockHash.toLowerCase())
  ) {
    return { status: 'receipt-unavailable' };
  }
  return { status: 'ok', description: describeTransaction(tx, receipt, options) };
}

// ---------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------

/** Token display facts, keyed by lowercase contract address (same shape as the preview's TokenMeta). */
export interface ActivityTokenMeta {
  symbol: string | null;
  decimals: number | null;
  tracked: boolean;
}

export interface ActivitySentenceContext {
  /** Native currency label ("ETH", "test ETH"). */
  nativeSymbol: string;
  /** Token metadata by lowercase address (tracked list, else on-chain reads). */
  tokens: Record<string, ActivityTokenMeta>;
  /** Exact-match contact name for an address, or null. */
  nameFor?: (address: string) => string | null;
  /** Masks an amount string (Hide amounts); identity by default. */
  maskAmount?: (text: string) => string;
}

/** Every token contract whose metadata a sentence for `desc` may need (lowercase). */
export function activityTokenContracts(desc: ActivityDescription): string[] {
  const out = new Set<string>();
  const addCall = (c: DecodedCall) => {
    if (c.kind === 'erc20-transfer' || c.kind === 'approve' || c.kind === 'transfer-from') out.add(c.token.toLowerCase());
    if (c.kind === 'permit2-approve') out.add(c.token.toLowerCase());
    if (c.kind === 'permit2-permit') for (const t of c.tokens) out.add(t.toLowerCase());
  };
  addCall(desc.call);
  for (const op of desc.userOps) for (const c of op.calls ?? []) addCall(c.decoded);
  for (const m of desc.movements) {
    if (m.change.type === 'erc20' || m.change.type === 'erc20-approval') out.add(m.change.token.toLowerCase());
  }
  for (const p of desc.permit2) out.add(p.token.toLowerCase());
  return [...out];
}

/** 0x1234…abcd. */
export function shortActivityAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Exact decimal rendering of base units, thousands grouped, trailing zeros trimmed. */
export function formatExactUnits(amount: bigint, decimals: number): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = (abs / base).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = decimals > 0 ? (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '') : '';
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** Effectively-unlimited threshold for non-max allowances (same local rule as the preview). */
const EFFECTIVELY_UNLIMITED = 1n << 128n;

class SentenceWriter {
  constructor(
    private readonly desc: ActivityDescription,
    private readonly ctx: ActivitySentenceContext,
  ) {}

  private mask(text: string): string {
    return this.ctx.maskAmount ? this.ctx.maskAmount(text) : text;
  }

  isWallet(address: string): boolean {
    return this.desc.wallet.some((w) => sameAddress(w, address));
  }

  /** Contact name, else pinned label, else "yourself" / short address. */
  party(address: string): string {
    if (this.isWallet(address)) return 'yourself';
    const contact = this.ctx.nameFor?.(address) ?? null;
    if (contact) return contact;
    const known = knownContract(this.desc.chainId, address);
    if (known) return known.name;
    return shortActivityAddress(address);
  }

  /** Token label: tracked symbol, else pinned symbol, else "SYM (untracked token 0x…)". */
  token(address: string): string {
    const meta = this.ctx.tokens[address.toLowerCase()];
    if (meta?.tracked && meta.symbol) return meta.symbol;
    const known = knownContract(this.desc.chainId, address);
    if (known?.kind === 'token' && known.symbol) return known.symbol;
    const short = shortActivityAddress(address);
    if (meta?.symbol) return `${meta.symbol} (untracked token ${short})`;
    return `token ${short}`;
  }

  tokenAmount(address: string, amount: bigint): string {
    const meta = this.ctx.tokens[address.toLowerCase()];
    if (!meta || meta.decimals === null) {
      return `${this.mask(amount.toString())} raw units of ${this.token(address)}`;
    }
    return `${this.mask(formatExactUnits(amount, meta.decimals))} ${this.token(address)}`;
  }

  native(amount: bigint): string {
    return `${this.mask(formatExactUnits(amount, 18))} ${this.ctx.nativeSymbol}`;
  }

  nft(collection: string, tokenId: bigint): string {
    return `NFT #${tokenId.toString()} (${this.party(collection)})`;
  }

  allowance(token: string, amount: bigint, unlimited: boolean): string {
    if (unlimited) return 'unlimited';
    if (amount >= EFFECTIVELY_UNLIMITED) return `up to ${this.tokenAmount(token, amount)}, effectively unlimited`;
    return `up to ${this.tokenAmount(token, amount)}`;
  }

  /**
   * Past-tense phrase for a decoded call made by `caller`, lowercase,
   * using `movements` (logs) where they are more exact than the calldata.
   */
  callPhrase(call: DecodedCall, caller: string): string {
    switch (call.kind) {
      case 'deployment':
        return this.desc.contractAddress
          ? `deployed a contract at ${shortActivityAddress(this.desc.contractAddress)}`
          : 'deployed a contract';
      case 'native-transfer':
        if (call.value === 0n) return `sent an empty transaction to ${this.party(call.to)}`;
        return `sent ${this.native(call.value)} to ${this.party(call.to)}`;
      case 'erc20-transfer': {
        const logged = this.desc.movements.find(
          (m) =>
            m.change.type === 'erc20' &&
            sameAddress(m.account, caller) &&
            m.change.direction !== 'in' &&
            sameAddress(m.change.token, call.token) &&
            sameAddress(m.change.to, call.to),
        );
        const amount = logged && logged.change.type === 'erc20' ? logged.change.amount : call.amount;
        return `sent ${this.tokenAmount(call.token, amount)} to ${this.party(call.to)}`;
      }
      case 'approve': {
        const nftApproval = this.desc.movements.find(
          (m) => m.change.type === 'erc721-approval' && sameAddress(m.change.token, call.token),
        );
        if (nftApproval && nftApproval.change.type === 'erc721-approval') {
          return sameAddress(nftApproval.change.approved, ZERO_ADDRESS)
            ? `cleared the approval for your ${this.nft(call.token, nftApproval.change.tokenId)}`
            : `approved ${this.party(nftApproval.change.approved)} to transfer your ${this.nft(call.token, nftApproval.change.tokenId)}`;
        }
        const logged = this.desc.movements.find(
          (m) =>
            m.change.type === 'erc20-approval' &&
            sameAddress(m.account, caller) &&
            sameAddress(m.change.token, call.token) &&
            sameAddress(m.change.spender, call.spender),
        );
        const amount = logged && logged.change.type === 'erc20-approval' ? logged.change.amount : call.amount;
        if (amount === 0n) return `revoked the ${this.token(call.token)} approval for ${this.party(call.spender)}`;
        return `approved ${this.token(call.token)} for ${this.party(call.spender)} (${this.allowance(call.token, amount, amount === MAX_UINT256)})`;
      }
      case 'transfer-from':
        return `moved tokens of ${this.party(call.token)} from ${this.party(call.from)} to ${this.party(call.to)}`;
      case 'set-approval-for-all':
        return call.approved
          ? `allowed ${this.party(call.operator)} to transfer ALL your NFTs in ${this.party(call.collection)}`
          : `revoked ${this.party(call.operator)}'s permission to transfer your NFTs in ${this.party(call.collection)}`;
      case 'erc721-safe-transfer':
        return `sent ${this.nft(call.collection, call.tokenId)} to ${this.party(call.to)}`;
      case 'erc1155-safe-transfer':
        return `sent ${this.mask(call.amount.toString())} × ${this.nft(call.collection, call.id)} to ${this.party(call.to)}`;
      case 'erc1155-safe-batch-transfer':
        return `sent ${call.ids.length} kinds of NFTs (${this.party(call.collection)}) to ${this.party(call.to)}`;
      case 'permit2-approve':
        if (call.amount === 0n) {
          return `cleared the Permit2 allowance of ${this.party(call.spender)} for ${this.token(call.token)}`;
        }
        return `set a Permit2 allowance: ${this.party(call.spender)} may spend ${this.token(call.token)} (${this.allowance(call.token, call.amount, call.amount === PERMIT2_MAX_AMOUNT)})`;
      case 'permit2-permit':
        return `submitted a Permit2 signature for ${this.party(call.spender)}`;
      case 'universal-router':
        return this.swapPhrase(call, caller);
      case 'handle-ops':
        return `submitted a bundle of ${call.opCount} smart-account operation${call.opCount === 1 ? '' : 's'}`;
      case 'contract-call': {
        const moved = this.movementPhrase(caller);
        const base = `called ${this.party(call.to)}`;
        const withValue = call.value > 0n ? `${base} with ${this.native(call.value)}` : base;
        return moved ? `${withValue}: ${moved}` : withValue;
      }
    }
  }

  /** "sent A and B" / "received C" from the logs, for `account`. */
  movementPhrase(account: string): string | null {
    const { outs, ins } = this.fungibleTotals(account);
    const parts: string[] = [];
    if (outs.length) parts.push(`sent ${joinList(outs)}`);
    if (ins.length) parts.push(`received ${joinList(ins)}`);
    parts.push(...this.nftPhrases(account));
    return parts.length ? parts.join(', ') : null;
  }

  /** "received NFT #5 (0x…)" / "sent 2 × NFT #7 (0x…)" for `account`, from the logs. */
  nftPhrases(account: string): string[] {
    const parts: string[] = [];
    for (const m of this.desc.movements) {
      if (!sameAddress(m.account, account)) continue;
      const c = m.change;
      if (c.type !== 'erc721' && c.type !== 'erc1155') continue;
      if (c.direction === 'self') continue;
      const verb = c.direction === 'in' ? 'received' : 'sent';
      parts.push(
        c.type === 'erc721'
          ? `${verb} ${this.nft(c.token, c.tokenId)}`
          : `${verb} ${this.mask(c.amount.toString())} × ${this.nft(c.token, c.tokenId)}`,
      );
    }
    return parts;
  }

  /** Summed ERC-20 movements for `account`, per token and direction (self-transfers excluded). */
  fungibleTotals(account: string): { outs: string[]; ins: string[] } {
    const totals = new Map<string, { token: string; out: bigint; in: bigint }>();
    for (const m of this.desc.movements) {
      if (!sameAddress(m.account, account) || m.change.type !== 'erc20') continue;
      if (m.change.direction === 'self') continue;
      const key = m.change.token.toLowerCase();
      const t = totals.get(key) ?? { token: m.change.token, out: 0n, in: 0n };
      if (m.change.direction === 'out') t.out += m.change.amount;
      else t.in += m.change.amount;
      totals.set(key, t);
    }
    const outs: string[] = [];
    const ins: string[] = [];
    for (const t of totals.values()) {
      if (t.out > 0n) outs.push(this.tokenAmount(t.token, t.out));
      if (t.in > 0n) ins.push(this.tokenAmount(t.token, t.in));
    }
    return { outs, ins };
  }

  swapPhrase(call: Extract<DecodedCall, { kind: 'universal-router' }>, caller: string): string {
    const protocol = knownContract(this.desc.chainId, call.router)?.protocol ?? 'the router';
    const swaps = call.commands.some((c) => c.type !== null && SWAP_COMMANDS.has(c.type));
    if (!swaps) {
      return `used ${this.party(call.router)} (${call.commands.map((c) => c.name).join(', ') || 'no commands'})`;
    }
    const { outs, ins } = this.fungibleTotals(caller);
    // ETH sent with the transaction itself (top-level only; a smart account's
    // inner value is part of its call list).
    if (sameAddress(caller, this.desc.from) && this.desc.value > 0n) outs.unshift(this.native(this.desc.value));
    if (call.nativeToCaller) ins.push(this.ctx.nativeSymbol);
    const sold = outs.length ? ` ${joinList(outs)}` : '';
    const bought = ins.length ? ` for ${joinList(ins)}` : '';
    return `swapped${sold}${bought} on ${protocol}`;
  }

  permit2Phrase(grant: Permit2Grant): string {
    return `set a Permit2 allowance: ${this.party(grant.spender)} may spend ${this.token(grant.token)} (${this.allowance(grant.token, grant.amount, grant.unlimited)})`;
  }

  authorizationPhrase(auth: AuthorizationOutcome): string {
    if (auth.effect === 'applied') {
      if (auth.target === 'revoke') return 'revoked the account upgrade (EIP-7702)';
      if (auth.target === 'kernel') return 'upgraded the account to Kernel v3.3 (EIP-7702)';
      return `delegated the account to ${this.party(auth.delegate)} (EIP-7702)`;
    }
    if (auth.target === 'revoke') return 'authorized revoking the account upgrade (EIP-7702)';
    if (auth.target === 'kernel') return 'authorized the account upgrade to Kernel v3.3 (EIP-7702)';
    return `authorized delegating the account to ${this.party(auth.delegate)} (EIP-7702)`;
  }

  userOpPhrase(op: UserOpOutcome): string {
    const deployed = op.deployed ? ' (first operation; deployed the account)' : '';
    const calls = op.calls?.map((c) => this.callPhrase(c.decoded, op.sender)) ?? [];
    if (!op.success) {
      const reason = op.revertReason ? ` (${op.revertReason})` : '';
      const tried = calls.length ? `: tried to ${calls.map(toPresent).join(', ')}` : '';
      return `smart-account operation failed${reason}${deployed}${tried}`;
    }
    if (calls.length && op.callsGuaranteed) return `smart-account operation${deployed}: ${calls.join(', ')}`;
    if (calls.length) return `smart-account operation${deployed} (individual calls may have failed): ${calls.join(', ')}`;
    const moved = this.movementPhrase(op.sender);
    return moved ? `smart-account operation${deployed}: ${moved}` : `smart-account operation${deployed}`;
  }

  sentence(): string {
    const d = this.desc;
    const clauses: string[] = d.authorizations.map((a) => this.authorizationPhrase(a));

    if (d.call.kind === 'handle-ops') {
      if (d.status === 'failed') {
        clauses.push('smart-account bundle failed; nothing in it happened');
      } else if (d.userOps.length) {
        for (const op of d.userOps) clauses.push(this.userOpPhrase(op));
      } else {
        const moved = d.wallet.map((w) => this.movementPhrase(w)).filter((p): p is string => !!p);
        clauses.push(
          moved.length
            ? `${moved.join('; ')} (in another account's smart-account operation)`
            : `smart-account bundle with ${d.otherUserOps} operation${d.otherUserOps === 1 ? '' : 's'} from other accounts`,
        );
      }
      return capitalize(clauses.join('; '));
    }

    if (d.status === 'failed') {
      // Calldata only: a reverted transaction moves nothing and emits no logs.
      const attempt = this.callPhrase(d.call, d.from);
      const fee = d.fromWallet ? '; only the network fee was paid' : '';
      clauses.push(`failed: tried to ${toPresent(attempt)}${fee}`);
      return capitalize(clauses.join('; '));
    }

    if (d.fromWallet) {
      const selfCallOnlyForAuth =
        d.authorizations.length > 0 &&
        d.call.kind === 'native-transfer' &&
        d.call.value === 0n &&
        sameAddress(d.to, d.from);
      if (!selfCallOnlyForAuth) clauses.push(this.callPhrase(d.call, d.from));
      for (const grant of d.permit2) {
        // A permit2-approve call already says this.
        if (d.call.kind !== 'permit2-approve') clauses.push(this.permit2Phrase(grant));
      }
      return capitalize(clauses.join('; '));
    }

    // Someone else's transaction that involves the wallet.
    const received: string[] = [];
    if (d.call.kind === 'native-transfer' && d.to && this.isWallet(d.to) && d.value > 0n) {
      received.push(`received ${this.native(d.value)} from ${this.party(d.from)}`);
    }
    for (const account of d.wallet) {
      const { outs, ins } = this.fungibleTotals(account);
      if (ins.length) {
        const senders = new Set(
          d.movements.flatMap((m) =>
            sameAddress(m.account, account) && m.change.type === 'erc20' && m.change.direction === 'in'
              ? [m.change.from.toLowerCase()]
              : [],
          ),
        );
        const fromParty = senders.size === 1 ? ` from ${this.party([...senders][0]!)}` : '';
        received.push(`received ${joinList(ins)}${fromParty}`);
      }
      if (outs.length) received.push(`sent ${joinList(outs)}`);
      received.push(...this.nftPhrases(account));
    }
    for (const grant of d.permit2) received.push(this.permit2Phrase(grant));
    if (received.length) clauses.push(...received);
    else clauses.push(`transaction by ${this.party(d.from)}${d.to ? ` to ${this.party(d.to)}` : ''}`);
    return capitalize(clauses.join('; '));
  }
}

const PAST_TO_PRESENT: Record<string, string> = {
  sent: 'send',
  approved: 'approve',
  swapped: 'swap',
  called: 'call',
  revoked: 'revoke',
  set: 'set',
  used: 'use',
  deployed: 'deploy',
  moved: 'move',
  allowed: 'allow',
  cleared: 'clear',
  submitted: 'submit',
};

/** Turns the leading past-tense verb of a phrase into its base form ("sent X" → "send X"). */
function toPresent(phrase: string): string {
  return phrase.replace(/^(\w+)/, (verb) => PAST_TO_PRESENT[verb] ?? verb);
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * The plain-English sentence for a description. Rules, in order:
 *  1. EIP-7702 authorizations the wallet signed come first ("Revoked the
 *     account upgrade (EIP-7702)", "Upgraded the account to Kernel v3.3
 *     (EIP-7702)" when the transaction proves the tuple applied, else
 *     "Authorized …").
 *  2. An EntryPoint bundle is described by the wallet's own operations:
 *     "Smart-account operation: sent 0.0001 ETH to Burn"; a failed
 *     operation says so with the decoded revert reason.
 *  3. A failed transaction is described from its calldata only ("Failed:
 *     tried to …"), with "only the network fee was paid" when the wallet
 *     sent it.
 *  4. A transaction the wallet sent is described by its top-level call;
 *     Universal Router swaps read "Swapped A for B on Uniswap" from the
 *     logs (plus "ETH" without an amount when the router was told to pay
 *     ETH to the caller); Permit2 allowances set along the way are added.
 *  5. Anything else that involves the wallet lists what it received or
 *     sent according to the logs, with the sender when there is one.
 * Amounts are exact (no rounding); Hide amounts masks every amount through
 * ctx.maskAmount; NFT ids and the word "unlimited" stay visible.
 */
export function activitySentence(desc: ActivityDescription, ctx: ActivitySentenceContext): string {
  return new SentenceWriter(desc, ctx).sentence();
}
