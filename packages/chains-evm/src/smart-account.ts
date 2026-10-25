import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { toChecksumAddress, type DerivedAccount } from '@shiba-wallet/core';
import { getUserOpHash, type UserOperation } from './userop.js';
import type { SignedEip7702Authorization } from './eip7702.js';
import {
  BundlerClient,
  DEFAULT_ESTIMATE_RETRIES,
  ImpossibleGasEstimateError,
  PaymasterClient,
  gasLimitProblems,
  type EstimateRetryPolicy,
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
  /**
   * How sendCalls treats a bundler estimate with an impossible (zero) gas
   * limit (see gasLimitProblems in ./rpc.ts): it is refused and asked for
   * again up to `attempts` times, `delayMs` apart, then
   * ImpossibleGasEstimateError is thrown before the operation is signed
   * (a paymaster transport may already have signed its estimation stub, as
   * Circle's permit stub does). Absent means DEFAULT_ESTIMATE_RETRIES (4
   * attempts, 2 s apart). Valid
   * estimates are used exactly as before, whatever this is set to.
   */
  estimateRetries?: EstimateRetryPolicy;
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
   *
   * `options.beforeSign`, when given, is called with the complete operation
   * (final gas limits, fees and paymaster data) after estimation and before
   * the spec signs it. Throwing from it stops the send before any signature
   * over the userOpHash is made; callers use it to refuse an operation whose
   * re-estimated worst-case cost exceeds what the user reviewed. Omitting it
   * keeps the previous behaviour exactly.
   */
  async sendCalls(
    owner: DerivedAccount,
    calls: Call[],
    fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
    options: { beforeSign?: (op: UserOperation) => void | Promise<void> } = {},
  ): Promise<{ userOpHash: string; userOp: UserOperation }> {
    const spec = this.config.spec;
    let op = await this.buildUnsignedOperation(owner, calls, fees, options.beforeSign);

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

  /**
   * Everything sendCalls does before the owner signs, in the same order
   * and with the same requests (moved here unchanged in phase 23 so the
   * external-signer path below runs exactly the same pipeline): sender and
   * deployment, nonce, the paymaster stub, the checked bundler estimate
   * and padding, the deposit top-up headroom, the final paymaster data,
   * the final impossible-limit check and `beforeSign`. Returns the
   * operation with the estimation stub still in its signature field.
   */
  private async buildUnsignedOperation(
    owner: DerivedAccount,
    calls: Call[],
    fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
    beforeSign: ((op: UserOperation) => void | Promise<void>) | undefined,
  ): Promise<UserOperation> {
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

    // An estimate with an impossible (zero) limit is refused and asked for
    // again before anything is padded or signed (gasLimitProblems).
    const gas = await this.bundlerClient.estimateUserOperationGasChecked(
      op,
      this.config.estimateRetries ?? DEFAULT_ESTIMATE_RETRIES,
    );
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

    // Last check on the limits that will be signed: padding below 100
    // percent or paymaster data with a zero verification limit could still
    // produce an operation that cannot execute. Refused before beforeSign
    // and before the spec signs anything.
    const finalProblems = gasLimitProblems(op, Boolean(op.paymaster));
    if (finalProblems.length > 0) {
      throw new ImpossibleGasEstimateError(
        finalProblems,
        {
          callGasLimit: op.callGasLimit,
          verificationGasLimit: op.verificationGasLimit,
          preVerificationGas: op.preVerificationGas,
          ...(op.paymasterVerificationGasLimit !== undefined
            ? { paymasterVerificationGasLimit: op.paymasterVerificationGasLimit }
            : {}),
          ...(op.paymasterPostOpGasLimit !== undefined ? { paymasterPostOpGasLimit: op.paymasterPostOpGasLimit } : {}),
        },
        { source: 'operation' },
      );
    }

    if (beforeSign) await beforeSign(op);
    return op;
  }

  /**
   * The first half of cold signing for a smart account (phase 23 item 5):
   * builds the operation for `ownerAddress` exactly as sendCalls would up to
   * the moment the owner signs — the same requests in the same order
   * (buildUnsignedOperation: deployment check, nonce, paymaster stub, the
   * checked bundler estimate and padding, the deposit top-up headroom, the
   * final paymaster data, the final impossible-limit check and
   * `options.beforeSign`) — and returns it with its userOpHash and the
   * digest the off-line owner key must sign under `options.scheme`. No key
   * is held or read here: the owner is an address only (addressOnlyOwner),
   * whose sign() throws, so a spec that tried to sign during preparation
   * fails loudly instead of signing.
   *
   * Refused before any request (EXTERNAL_SIGNER_7702_REFUSAL, decision D6):
   * an EIP-7702 spec, whose operations may carry an authorization tuple the
   * wallet never asks an off-line signer for.
   *
   * The returned fees are FINAL: the owner's signature covers them through
   * the userOpHash (gasFees is one of the hashed fields, see ./userop.ts), so
   * no later step can reprice the operation without a new signature.
   */
  async prepareUserOperationForExternalSigner(
    ownerAddress: string,
    calls: Call[],
    fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
    options: { scheme: ExternalSigningScheme; beforeSign?: (op: UserOperation) => void | Promise<void> },
  ): Promise<PreparedExternalUserOperation> {
    const spec = this.config.spec;
    if (spec.getEip7702Authorization) throw new Error(EXTERNAL_SIGNER_7702_REFUSAL);
    const owner = addressOnlyOwner(ownerAddress, this.config.chainId);
    const op = await this.buildUnsignedOperation(owner, calls, fees, options.beforeSign);
    if (op.eip7702Auth) throw new Error(EXTERNAL_SIGNER_7702_REFUSAL);
    const userOpHash = getUserOpHash(op, this.config.entryPoint, this.config.chainId);
    const signingDigest = options.scheme.digest(userOpHash);
    if (signingDigest.length !== 32) throw new Error('An external signing scheme must produce a 32-byte digest');
    return {
      ownerAddress: owner.address,
      scheme: options.scheme,
      entryPoint: this.config.entryPoint,
      chainId: this.config.chainId,
      nonceKey: spec.getNonceKey ? spec.getNonceKey(owner) : 0n,
      userOp: op,
      userOpHash,
      signingDigest,
    };
  }

  /**
   * The second half: submits a prepared operation with a signature made
   * elsewhere. In this order, and nothing is sent unless every step passes:
   *
   *  1. Local checks, before ANY request: the prepared operation is for this
   *     client's EntryPoint and chain and carries no EIP-7702 tuple (D6);
   *     its userOpHash and signing digest are RECOMPUTED from its fields
   *     (the stored ones must agree, else it was altered); the signature is
   *     well formed with a low s (recoverExternalSigner) and recovers to the
   *     prepared owner over the recomputed digest. A signature over any
   *     other operation — another nonce, other calls, other fees — recovers
   *     to some other address and is refused here.
   *  2. Read-only checks against the chain: the spec still derives the same
   *     sender for the owner, the EntryPoint nonce is still the signed one
   *     (an operation sent meanwhile consumed it), and the account's
   *     deployment state still matches the operation (a deploying operation
   *     for an account that now exists would fail with AA10).
   *  3. `options.beforeSign` runs on the rebuilt operation (with the spec's
   *     estimation stub in its signature field, exactly what it saw when the
   *     operation was prepared), so the caller can apply its fee rules —
   *     for the app, the bundler-floor check. THE SIGNED FEES CANNOT BE
   *     REPRICED: if the bundler's floor moved above them, the only honest
   *     outcome is that this hook throws and the caller prepares a fresh
   *     request for a fresh signature.
   *  4. The signature is encoded with the scheme and the operation goes to
   *     eth_sendUserOperation.
   *
   * The spec never signs on this path (spec.signUserOpHash is not called)
   * and no key is read: the signature is the only secret-derived input.
   */
  async submitPreparedUserOperation(
    prepared: PreparedExternalUserOperation,
    signature: ExternalSignature,
    options: { beforeSign?: (op: UserOperation) => void | Promise<void> } = {},
  ): Promise<{ userOpHash: string; userOp: UserOperation }> {
    const spec = this.config.spec;
    if (spec.getEip7702Authorization || prepared.userOp.eip7702Auth) throw new Error(EXTERNAL_SIGNER_7702_REFUSAL);
    if (prepared.chainId !== this.config.chainId) {
      throw new ExternalSignatureError(
        `This operation was prepared for chain ${prepared.chainId}, not ${this.config.chainId}. Nothing was sent.`,
      );
    }
    if (prepared.entryPoint.toLowerCase() !== this.config.entryPoint.toLowerCase()) {
      throw new ExternalSignatureError(
        `This operation was prepared for EntryPoint ${prepared.entryPoint}, not ${this.config.entryPoint}. Nothing was sent.`,
      );
    }
    const owner = addressOnlyOwner(prepared.ownerAddress, this.config.chainId);
    // Rebuilt field by field from the prepared record (never a caller's
    // operation object), with the estimation stub as at preparation.
    const op = rebuildPreparedOperation(prepared.userOp, spec.stubSignature());
    const hash = getUserOpHash(op, this.config.entryPoint, this.config.chainId);
    if (!equalBytes(hash, prepared.userOpHash)) {
      throw new ExternalSignatureError(EXTERNAL_PREPARED_ALTERED);
    }
    const digest = prepared.scheme.digest(hash);
    if (!equalBytes(digest, prepared.signingDigest)) {
      throw new ExternalSignatureError(EXTERNAL_PREPARED_ALTERED);
    }
    let recovered: string;
    try {
      recovered = recoverExternalSigner(digest, signature);
    } catch (e) {
      throw new ExternalSignatureError(
        `The signature could not be read (${e instanceof Error ? e.message : String(e)}). Nothing was sent.`,
      );
    }
    if (recovered.toLowerCase() !== owner.address.toLowerCase()) {
      throw new ExternalSignatureError(
        `The signature recovers to ${recovered}, not to the owner ${owner.address}, over this operation. Nothing was sent.`,
      );
    }

    // Read-only checks against the chain.
    const sender = await spec.getAddress(owner);
    if (sender.toLowerCase() !== op.sender.toLowerCase()) {
      throw new ExternalSignatureError(
        `The owner's smart account is ${sender}, but the operation is from ${op.sender}. Nothing was sent.`,
      );
    }
    const nonce = await this.getNonce(owner);
    if (nonce !== op.nonce) {
      throw new ExternalSignatureError(
        `The account's EntryPoint nonce is now ${nonce}, but this operation was signed for nonce ${op.nonce}: ` +
          'another operation used it first. Nothing was sent; prepare a new request.',
      );
    }
    const deployed = await this.isDeployed(owner);
    if (deployed === Boolean(op.factory)) {
      throw new ExternalSignatureError(
        deployed
          ? 'The account was deployed after this operation was prepared, and the operation would deploy it again. Nothing was sent; prepare a new request.'
          : 'This operation expects a deployed account, but the account has no code. Nothing was sent.',
      );
    }

    if (options.beforeSign) await options.beforeSign(op);

    const signed: UserOperation = { ...op, signature: prepared.scheme.encodeSignature(signature) };
    const userOpHash = await this.bundlerClient.sendUserOperation(signed);
    return { userOpHash, userOp: signed };
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

// ---------------------------------------------------------------------------
// Cold signing for a smart account (phase 23 item 5)
// ---------------------------------------------------------------------------

/** A recoverable secp256k1 signature made by an off-line key. */
export interface ExternalSignature {
  /** The recovery bit, 0 or 1. */
  yParity: 0 | 1;
  /** 32 bytes, big-endian. */
  r: Uint8Array;
  /** 32 bytes, big-endian, at most secp256k1n / 2. */
  s: Uint8Array;
}

/**
 * How an account's validation expects the owner to sign a userOpHash, in
 * two pure functions an off-line signer and the on-line half can both run:
 * the 32-byte digest the key signs, and the UserOperation.signature bytes
 * built from the resulting (yParity, r, s). A scheme must reproduce the
 * spec's own signUserOpHash byte for byte (the Kernel v3.3 ECDSA-root
 * scheme in ./cold-userop.ts is pinned against createKernelAccountSpec in
 * test/cold-userop.test.ts).
 */
export interface ExternalSigningScheme {
  /** Stable identifier, written into cold-signing requests. */
  id: string;
  digest(userOpHash: Uint8Array): Uint8Array;
  encodeSignature(signature: ExternalSignature): Uint8Array;
}

/** What prepareUserOperationForExternalSigner returns and submitPreparedUserOperation takes. */
export interface PreparedExternalUserOperation {
  /** EIP-55. */
  ownerAddress: string;
  scheme: ExternalSigningScheme;
  entryPoint: string;
  chainId: bigint;
  /** The uint192 nonce key the operation's nonce was read for (0 = Kernel root). */
  nonceKey: bigint;
  /** The operation exactly as it will be submitted, with the estimation stub as its signature. */
  userOp: UserOperation;
  /** EntryPoint v0.7 getUserOpHash of userOp. */
  userOpHash: Uint8Array;
  /** scheme.digest(userOpHash): what the off-line owner key signs. */
  signingDigest: Uint8Array;
}

/** Thrown for every refusal of submitPreparedUserOperation; the message is a plain sentence. */
export class ExternalSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExternalSignatureError';
  }
}

export const EXTERNAL_SIGNER_7702_REFUSAL =
  'Operations for an EIP-7702 account are never prepared for an off-line signer: such an operation may carry an ' +
  'authorization that changes what the address runs, and the wallet never asks an off-line signer for one. ' +
  'Nothing was prepared or sent.';

export const EXTERNAL_PREPARED_ALTERED =
  'The stored operation does not match its own userOpHash or signing digest, so it was altered after it was ' +
  'prepared. Nothing was sent.';

const SECP256K1_N = secp256k1.Point.Fn.ORDER;
const SECP256K1_HALF_N = SECP256K1_N >> 1n;

/**
 * The address whose key made `signature` over the 32-byte `digest`
 * (EIP-55). Refuses a yParity other than 0 / 1, r or s that are not 32
 * bytes, r outside 1..n-1, and s that is zero or above n/2 (only low-s
 * signatures are accepted, as every RFC 6979 signer here produces; the
 * Kernel validator would also accept the high-s twin through solady's
 * ECDSA.recover, but the wallet does not need malleable forms).
 */
export function recoverExternalSigner(digest: Uint8Array, signature: ExternalSignature): string {
  if (!(digest instanceof Uint8Array) || digest.length !== 32) throw new Error('the digest must be 32 bytes');
  if (signature.yParity !== 0 && signature.yParity !== 1) throw new Error('yParity must be 0 or 1');
  if (!(signature.r instanceof Uint8Array) || signature.r.length !== 32) throw new Error('r must be 32 bytes');
  if (!(signature.s instanceof Uint8Array) || signature.s.length !== 32) throw new Error('s must be 32 bytes');
  const r = BigInt(bytesToHexStrict(signature.r));
  const s = BigInt(bytesToHexStrict(signature.s));
  if (r === 0n || r >= SECP256K1_N) throw new Error('r is outside the secp256k1 range');
  if (s === 0n || s > SECP256K1_HALF_N) throw new Error('s is zero or above secp256k1n/2');
  const recovered = new Uint8Array(65);
  recovered[0] = signature.yParity;
  recovered.set(signature.r, 1);
  recovered.set(signature.s, 33);
  const point = secp256k1.Signature.fromBytes(recovered, 'recovered').recoverPublicKey(digest);
  return toChecksumAddress(keccak_256(point.toBytes(false).subarray(1)).slice(12));
}

/**
 * A DerivedAccount that is an ADDRESS ONLY: what the on-line half of cold
 * signing holds for the owner. Specs need the owner for getAddress /
 * getFactoryArgs / getNonceKey, which read only `address`; sign() throws,
 * so nothing on the external-signer path can sign by accident.
 */
export function addressOnlyOwner(address: string, chainId: bigint): DerivedAccount {
  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error('The owner must be a 0x-prefixed 20-byte address');
  }
  return {
    chainId: `eip155:${chainId}`,
    path: '',
    publicKey: new Uint8Array(0),
    address: toChecksumAddress(hexToBytesStrict(address.toLowerCase())),
    sign(): Uint8Array {
      throw new Error('This owner key is not on this device: the operation must be signed by the off-line signer');
    },
  };
}

/** A field-by-field copy of `op` with `signature`; optional fields kept only when present. */
function rebuildPreparedOperation(op: UserOperation, signature: Uint8Array): UserOperation {
  return {
    sender: op.sender,
    nonce: op.nonce,
    ...(op.factory !== undefined ? { factory: op.factory } : {}),
    ...(op.factoryData !== undefined ? { factoryData: op.factoryData.slice() } : {}),
    callData: op.callData.slice(),
    callGasLimit: op.callGasLimit,
    verificationGasLimit: op.verificationGasLimit,
    preVerificationGas: op.preVerificationGas,
    maxFeePerGas: op.maxFeePerGas,
    maxPriorityFeePerGas: op.maxPriorityFeePerGas,
    ...(op.paymaster !== undefined ? { paymaster: op.paymaster } : {}),
    ...(op.paymasterVerificationGasLimit !== undefined
      ? { paymasterVerificationGasLimit: op.paymasterVerificationGasLimit }
      : {}),
    ...(op.paymasterPostOpGasLimit !== undefined ? { paymasterPostOpGasLimit: op.paymasterPostOpGasLimit } : {}),
    ...(op.paymasterData !== undefined ? { paymasterData: op.paymasterData.slice() } : {}),
    signature,
  };
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
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
