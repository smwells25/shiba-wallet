import { keccak_256 } from '@noble/hashes/sha3.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import type { DerivedAccount } from '@shiba-wallet/core';
import { getUserOpHash, type UserOperation } from './userop.js';
import type { SignedEip7702Authorization } from './eip7702.js';
import {
  BundlerClient,
  PaymasterClient,
  type JsonRpcTransport,
} from './rpc.js';

/**
 * Smart-account orchestration: turns "user wants to do X" into a signed
 * UserOperation delivered to a bundler.
 *
 * Account implementations differ (SimpleAccount, Safe, Kernel, Biconomy...)
 * in how they encode calls, compute their counterfactual address, and expect
 * signatures, so those parts are supplied as a SmartAccountSpec. The client
 * owns only the implementation-independent pipeline, which for ERC-4337
 * v0.7 with an ERC-7677 paymaster is:
 *
 *   resolve sender & deployment → encode calls → fill fees & nonce
 *   → paymaster stub → bundler gas estimation → final paymaster data
 *   → sign userOpHash → submit
 */

export interface Call {
  to: string;
  value: bigint;
  data: Uint8Array;
}

export interface SmartAccountSpec {
  /**
   * Counterfactual (CREATE2) address for this owner; stable pre-deployment.
   * Async because implementations may resolve it via a factory view call.
   */
  getAddress(owner: DerivedAccount): Promise<string>;
  /** Factory address + calldata that deploy the account, for undeployed senders. */
  getFactoryArgs(owner: DerivedAccount): Promise<{ factory: string; factoryData: Uint8Array }>;
  /** Encodes one or more calls into the account's execute/executeBatch calldata. */
  encodeCalls(calls: Call[]): Uint8Array;
  /**
   * Signs the userOpHash the way the account's validation expects (raw hash,
   * EIP-191 wrapped, EIP-1271 envelope...). Given the owner so it can use
   * owner.sign.
   *
   * May return the signature directly or a Promise of it: SmartAccountClient
   * awaits the result, so signers that need a user interaction (a passkey
   * prompt, a hardware device) can sign here instead of at the transport.
   * SmartAccountClient also passes `context`, the exact operation the hash
   * was computed from, so a spec can check what it is about to sign; specs
   * that do not need it may ignore the argument.
   */
  signUserOpHash(
    owner: DerivedAccount,
    userOpHash: Uint8Array,
    context?: UserOpSigningContext,
  ): Uint8Array | Promise<Uint8Array>;
  /**
   * Placeholder signature of the correct length for gas estimation; bundlers
   * simulate validation, so it must parse without reverting on length.
   */
  stubSignature(): Uint8Array;
  /**
   * Optional: the ERC-1271 signature bytes this account's isValidSignature
   * accepts for `hash` once deployed (framework envelope, validator prefix,
   * defensive rehashing and all). `hash` is what the verifier passes to
   * isValidSignature, e.g. an EIP-191 message hash or an EIP-712 digest.
   * Absent when the account implementation has no ERC-1271 support (the
   * eth-infinitism SimpleAccount v0.7.0 sample has no isValidSignature).
   * For an undeployed account, wrap the result with ERC-6492 (see
   * signHashForSmartAccount in ./account-signatures.ts).
   */
  signErc1271?(owner: DerivedAccount, hash: Uint8Array, context: SmartAccountSignatureContext): Uint8Array;
  /**
   * Optional, EIP-7702 accounts only (the sender IS the owner EOA, delegated
   * to the account implementation). When present, the account has no
   * factory: SmartAccountClient never calls getFactoryArgs, and instead
   * attaches whatever this returns as the operation's `eip7702Auth` tuple —
   * a signed authorization while the EOA is not yet delegated, undefined
   * once eth_getCode already shows the expected delegation indicator
   * (ERC-7769: a tuple is needed only to CHANGE the delegation).
   */
  getEip7702Authorization?(owner: DerivedAccount): Promise<SignedEip7702Authorization | undefined>;
  /**
   * Optional: the uint192 EntryPoint nonce key this account's operations
   * use. Kernel, for example, routes an operation to a non-root validator
   * (a session-key permission, a passkey) through the high bits of the
   * nonce. When present, SmartAccountClient reads
   * EntryPoint.getNonce(sender, key) instead of key 0 and refuses a result
   * whose key part differs. Absent means key 0, the previous behaviour.
   */
  getNonceKey?(owner: DerivedAccount): bigint;
}

/**
 * What SmartAccountClient hands to signUserOpHash besides the hash: the
 * complete operation (with the estimation stub still in its signature
 * field, which the userOpHash does not cover) and the EntryPoint and chain
 * id the hash was computed for. A spec can recompute the hash from it and
 * refuse to sign anything it did not expect.
 */
export interface UserOpSigningContext {
  userOp: UserOperation;
  entryPoint: string;
  chainId: bigint;
}

/** Facts an account's ERC-1271 signing needs beyond the owner key. */
export interface SmartAccountSignatureContext {
  /** Chain the signature is for (accounts bind it into their rehash). */
  chainId: bigint;
  /** The smart account's own address (its EIP-712 verifyingContract). */
  account: string;
}

export interface SmartAccountClientConfig {
  chainId: bigint;
  entryPoint: string;
  /** Bundler RPC transport (eth_sendUserOperation namespace). */
  bundler: JsonRpcTransport;
  /** Node RPC transport, used for nonce and deployment checks. */
  node: JsonRpcTransport;
  /** Optional ERC-7677 paymaster; absent means the account pays its own gas. */
  paymaster?: { transport: JsonRpcTransport; context?: unknown };
  spec: SmartAccountSpec;
  /**
   * Percentage padding applied on top of the bundler's gas estimates
   * (100 = use estimates as returned). Bundler estimates are observed to
   * be too tight in the wild for first-time deployments (send-time
   * simulation fails AA13 OOG even though estimation succeeded), so
   * production callers typically pad verification gas. Unused gas is not
   * charged under ERC-4337 beyond the 10 percent unused-gas penalty
   * introduced in EntryPoint v0.7.
   */
  gasPaddingPct?: {
    verification?: number;
    call?: number;
    preVerification?: number;
  };
  /**
   * Extra verificationGasLimit added ONLY when the operation has no
   * paymaster and the sender's EntryPoint deposit is below the
   * operation's required prefund, i.e. when the account itself must send
   * missingAccountFunds to the EntryPoint during validation (EntryPoint
   * v0.7 _validateAccountPrepayment passes a non-zero missingAccountFunds
   * exactly when balanceOf(sender) < requiredPrefund). Absent or 0n means
   * no adjustment (the previous behaviour).
   *
   * Why: Rundler (Alchemy's bundler) estimates verification gas with the
   * operation's gas fees zeroed (VerificationGasEstimationHelper
   * _setFeesFields sets gasFees to 0 when there is no paymaster), so the
   * deposit top-up never runs during estimation and is not in the
   * estimate; when the real fees require a top-up at submission, its
   * validation tracer reports "Simulation ran out of gas for entity:
   * account" (-32502). Measured on Sepolia on 2026-10-02 for Kernel v3.3:
   * the same operation was refused at verificationGasLimit 91,249 and
   * 113,373 (Rundler's own estimate) and accepted at 125,000, 150,000 and
   * 190,000 while a top-up was needed, and accepted at 91,249 when the
   * deposit already covered the prefund. Verification gas is not subject
   * to EntryPoint v0.7's 10 percent unused-gas penalty (that applies to
   * callGasLimit + paymasterPostOpGasLimit), so the headroom only raises
   * the worst-case prefund, not the fee actually charged. Bundlers also
   * enforce a minimum verification-gas efficiency (Rundler: used / limit
   * >= 0.4), so the headroom must stay modest.
   */
  depositTopUpVerificationGas?: bigint;
}

/**
 * EntryPoint v0.7 _getRequiredPrefund: (verificationGasLimit + callGasLimit
 * + paymasterVerificationGasLimit + paymasterPostOpGasLimit +
 * preVerificationGas) * maxFeePerGas.
 */
export function requiredPrefund(op: UserOperation): bigint {
  return (
    (op.verificationGasLimit +
      op.callGasLimit +
      (op.paymasterVerificationGasLimit ?? 0n) +
      (op.paymasterPostOpGasLimit ?? 0n) +
      op.preVerificationGas) *
    op.maxFeePerGas
  );
}

/**
 * True when validating `op` makes the account send a non-zero
 * missingAccountFunds to the EntryPoint: no paymaster, and the sender's
 * deposit is below the required prefund (EntryPoint v0.7
 * _validateAccountPrepayment computes `bal > requiredPrefund ? 0 :
 * requiredPrefund - bal`, which is non-zero exactly when bal <
 * requiredPrefund; Kernel v3.3 calls the EntryPoint only `if
 * missingAccountFunds`).
 */
export function needsDepositTopUp(op: UserOperation, deposit: bigint): boolean {
  if (op.paymaster) return false;
  return deposit < requiredPrefund(op);
}

/**
 * The verificationGasLimit to submit: `op`'s own, plus `headroom` when the
 * operation will top up the EntryPoint deposit during validation (see
 * SmartAccountClientConfig.depositTopUpVerificationGas). Pure, so quotes
 * and the client agree on the same number.
 */
export function withDepositTopUpHeadroom(op: UserOperation, deposit: bigint, headroom: bigint): bigint {
  if (headroom <= 0n || !needsDepositTopUp(op, deposit)) return op.verificationGasLimit;
  return op.verificationGasLimit + headroom;
}

/** getNonce(address,uint192) selector on the EntryPoint (nonce manager). */
const GET_NONCE_SELECTOR = keccak_256(utf8ToBytes('getNonce(address,uint192)')).slice(0, 4);
/** balanceOf(address) selector on the EntryPoint (StakeManager deposit). */
const BALANCE_OF_SELECTOR = keccak_256(utf8ToBytes('balanceOf(address)')).slice(0, 4);

export class SmartAccountClient {
  private bundlerClient: BundlerClient;
  private paymasterClient?: PaymasterClient;

  constructor(private config: SmartAccountClientConfig) {
    this.bundlerClient = new BundlerClient(config.bundler, config.entryPoint);
    if (config.paymaster) {
      this.paymasterClient = new PaymasterClient(
        config.paymaster.transport,
        config.entryPoint,
      );
    }
  }

  getAddress(owner: DerivedAccount): Promise<string> {
    return this.config.spec.getAddress(owner);
  }

  /** True once the account contract exists on chain. */
  async isDeployed(owner: DerivedAccount): Promise<boolean> {
    const code = (await this.config.node('eth_getCode', [
      await this.getAddress(owner),
      'latest',
    ])) as string;
    return code !== undefined && code !== '0x' && code !== '0x0';
  }

  /**
   * Reads the account's ERC-4337 nonce from the EntryPoint, for the spec's
   * nonce key (getNonceKey) or key 0 when the spec has none.
   */
  async getNonce(owner: DerivedAccount): Promise<bigint> {
    const sender = await this.getAddress(owner);
    const key = this.config.spec.getNonceKey ? this.config.spec.getNonceKey(owner) : 0n;
    if (key < 0n || key >= 1n << 192n) throw new Error('Nonce key must be a uint192');
    const data = new Uint8Array(4 + 32 + 32);
    data.set(GET_NONCE_SELECTOR, 0);
    // address argument, left-padded to a 32-byte word
    const addressBytes = hexToBytesStrict(sender);
    data.set(addressBytes, 4 + 12);
    // uint192 key argument, left-padded to a 32-byte word (all zero for key 0)
    for (let i = 0, k = key; k > 0n; i++, k >>= 8n) data[4 + 32 + 31 - i] = Number(k & 0xffn);
    const result = (await this.config.node('eth_call', [
      { to: this.config.entryPoint, data: bytesToHexStrict(data) },
      'latest',
    ])) as string;
    const nonce = BigInt(result);
    // The EntryPoint returns sequence | (key << 64). A node that answers for
    // a different key would make the operation validate against the wrong
    // validator (or not at all), so a keyed read is checked.
    if (key !== 0n && nonce >> 64n !== key) {
      throw new Error('EntryPoint.getNonce returned a nonce for a different key');
    }
    return nonce;
  }

  /**
   * The configured deposit top-up verification headroom (0n when unset), so
   * callers that quote an operation separately can apply the same rule.
   */
  get depositTopUpVerificationGas(): bigint {
    return this.config.depositTopUpVerificationGas ?? 0n;
  }

  /** The sender's EntryPoint deposit (StakeManager balanceOf), in wei. */
  async getEntryPointDeposit(sender: string): Promise<bigint> {
    const data = new Uint8Array(4 + 32);
    data.set(BALANCE_OF_SELECTOR, 0);
    data.set(hexToBytesStrict(sender), 4 + 12);
    const result = (await this.config.node('eth_call', [
      { to: this.config.entryPoint, data: bytesToHexStrict(data) },
      'latest',
    ])) as string;
    return BigInt(result);
  }

  /**
   * Builds, sponsors (if configured), estimates, and signs a UserOperation
   * for the given calls, then submits it. Returns the userOpHash.
   */
  async sendCalls(
    owner: DerivedAccount,
    calls: Call[],
    fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
  ): Promise<{ userOpHash: string; userOp: UserOperation }> {
    const spec = this.config.spec;
    // EIP-7702 senders are EOAs: no factory ever; the delegation (if not yet
    // in place) travels as the op's eip7702Auth tuple instead.
    const eip7702Auth = spec.getEip7702Authorization
      ? await spec.getEip7702Authorization(owner)
      : undefined;
    const deployed = spec.getEip7702Authorization ? true : await this.isDeployed(owner);
    const factoryArgs = deployed ? undefined : await spec.getFactoryArgs(owner);

    let op: UserOperation = {
      sender: await this.getAddress(owner),
      nonce: await this.getNonce(owner),
      ...(factoryArgs
        ? { factory: factoryArgs.factory, factoryData: factoryArgs.factoryData }
        : {}),
      callData: spec.encodeCalls(calls),
      callGasLimit: 0n,
      verificationGasLimit: 0n,
      preVerificationGas: 0n,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      signature: spec.stubSignature(),
      ...(eip7702Auth ? { eip7702Auth } : {}),
    };

    // ERC-7677 two-phase flow: stub data makes gas estimation realistic,
    // final data is requested once gas limits are known.
    if (this.paymasterClient) {
      const stub = await this.paymasterClient.getPaymasterStubData(
        op,
        this.config.chainId,
        this.config.paymaster!.context ?? null,
      );
      op = { ...op, ...paymasterFields(stub) };
    }

    const gas = await this.bundlerClient.estimateUserOperationGas(op);
    const pad = (value: bigint, pct: number | undefined): bigint =>
      pct === undefined || pct === 100 ? value : (value * BigInt(pct)) / 100n;
    const padding = this.config.gasPaddingPct;
    op = {
      ...op,
      callGasLimit: pad(gas.callGasLimit, padding?.call),
      verificationGasLimit: pad(gas.verificationGasLimit, padding?.verification),
      preVerificationGas: pad(gas.preVerificationGas, padding?.preVerification),
      ...(gas.paymasterVerificationGasLimit !== undefined
        ? {
            paymasterVerificationGasLimit: pad(
              gas.paymasterVerificationGasLimit,
              padding?.verification,
            ),
          }
        : {}),
    };

    // Self-paid operations that must top up the EntryPoint deposit during
    // validation get the configured verification headroom (see
    // depositTopUpVerificationGas for the evidence). Decided on the padded
    // limits, before signing, so the signed operation carries it.
    // If the deposit cannot be read, the operation goes out as estimated
    // (the previous behaviour); a bundler refusal then still arrives
    // verbatim as the error.
    const topUpHeadroom = this.config.depositTopUpVerificationGas ?? 0n;
    if (!this.paymasterClient && topUpHeadroom > 0n) {
      const deposit = await this.getEntryPointDeposit(op.sender).catch(() => null);
      if (deposit !== null) {
        op = { ...op, verificationGasLimit: withDepositTopUpHeadroom(op, deposit, topUpHeadroom) };
      }
    }

    if (this.paymasterClient) {
      const finalData = await this.paymasterClient.getPaymasterData(
        op,
        this.config.chainId,
        this.config.paymaster!.context ?? null,
      );
      op = { ...op, ...paymasterFields(finalData) };
    }

    const hash = getUserOpHash(op, this.config.entryPoint, this.config.chainId);
    // Awaited: a spec may sign asynchronously (for example behind a passkey
    // prompt). The context is the exact operation the hash covers.
    const signature = await spec.signUserOpHash(owner, hash, {
      userOp: op,
      entryPoint: this.config.entryPoint,
      chainId: this.config.chainId,
    });
    op = { ...op, signature };

    const userOpHash = await this.bundlerClient.sendUserOperation(op);
    return { userOpHash, userOp: op };
  }

  async waitForReceipt(
    userOpHash: string,
    { timeoutMs = 60_000, pollMs = 2_000 }: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<unknown> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const receipt = await this.bundlerClient.getUserOperationReceipt(userOpHash);
      if (receipt) return receipt;
      if (Date.now() + pollMs > deadline) {
        throw new Error(`Timed out waiting for UserOperation ${userOpHash}`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}

function paymasterFields(result: {
  paymaster: string;
  paymasterData: Uint8Array;
  paymasterVerificationGasLimit?: bigint;
  paymasterPostOpGasLimit?: bigint;
}): Partial<UserOperation> {
  return {
    paymaster: result.paymaster,
    paymasterData: result.paymasterData,
    ...(result.paymasterVerificationGasLimit !== undefined
      ? { paymasterVerificationGasLimit: result.paymasterVerificationGasLimit }
      : {}),
    ...(result.paymasterPostOpGasLimit !== undefined
      ? { paymasterPostOpGasLimit: result.paymasterPostOpGasLimit }
      : {}),
  };
}

/**
 * EIP-191 "personal message" wrapping of a 32-byte digest:
 * keccak256("\x19Ethereum Signed Message:\n32" || digest). Several account
 * implementations validate owner signatures over this form; specs can use it
 * from their signUserOpHash.
 */
export function toEthSignedMessageHash(digest: Uint8Array): Uint8Array {
  if (digest.length !== 32) throw new Error('Digest must be 32 bytes');
  return keccak_256(concatBytes(utf8ToBytes('\x19Ethereum Signed Message:\n32'), digest));
}

/**
 * EIP-191 version 0x45 ("personal_sign") prefixing of an arbitrary message:
 * "\x19Ethereum Signed Message:\n" || decimal byte length || message.
 */
export function eip191PrefixedMessage(message: Uint8Array): Uint8Array {
  return concatBytes(
    utf8ToBytes(`\x19Ethereum Signed Message:\n${message.length}`),
    message,
  );
}

/** keccak256 of eip191PrefixedMessage(message): the hash personal_sign signs. */
export function hashEip191Message(message: Uint8Array): Uint8Array {
  return keccak_256(eip191PrefixedMessage(message));
}

/**
 * Converts a core r||s||recid signature (recid 0/1) to the r||s||v form with
 * v = 27 + recid that ecrecover-based validation expects.
 */
export function withEthereumV(signature: Uint8Array): Uint8Array {
  if (signature.length !== 65) throw new Error('Expected a 65-byte recoverable signature');
  const out = signature.slice();
  const recid = out[64]!;
  if (recid === 0 || recid === 1) out[64] = recid + 27;
  else if (recid !== 27 && recid !== 28) throw new Error(`Unexpected recovery byte ${recid}`);
  return out;
}

function hexToBytesStrict(hex: string): Uint8Array {
  if (!hex.startsWith('0x')) throw new Error(`Expected 0x hex: ${hex}`);
  const body = hex.slice(2);
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHexStrict(bytes: Uint8Array): string {
  return '0x' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
