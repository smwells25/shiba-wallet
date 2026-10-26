import { bigintToHex, toBytes, toHex } from './encoding.js';
import type { UserOperation } from './userop.js';
import { toRpcEip7702Auth, type RpcEip7702Auth } from './eip7702.js';

/**
 * Vendor-neutral JSON-RPC plumbing. The wallet injects a transport (usually
 * fetch against a user-configurable URL); nothing in this package hardcodes
 * a bundler, paymaster, or node provider. Vendors are configuration, not
 * code (ADR D5).
 */

export type JsonRpcTransport = (method: string, params: unknown[]) => Promise<unknown>;

/**
 * The JSON-RPC methods that hand a signed transaction or UserOperation to
 * the network. Only these are bounded in time by httpTransport (every other
 * request, the reads included, keeps no time limit, exactly as before).
 */
export const BROADCAST_METHODS: readonly string[] = ['eth_sendRawTransaction', 'eth_sendUserOperation'];

/**
 * How long httpTransport waits for the answer to a broadcast (a
 * BROADCAST_METHODS request) before giving up on it: 60 seconds. A
 * JUDGEMENT, not a protocol value or a measurement: long enough that a
 * slow but healthy endpoint answers, short enough that a user is not left
 * waiting on a spinner indefinitely (the platform fetch the app uses has no
 * time limit of its own; in phase 21 pass p21e a refusal arrived about 2
 * minutes after the prompt, most of it inferred, not measured, to be the
 * wallet's own key derivation before the request). Giving up does NOT mean the broadcast failed: the
 * request may already have reached the endpoint, so the caller must treat
 * the outcome as unknown (BroadcastTimeoutError).
 */
export const BROADCAST_TIMEOUT_MS = 60_000;

/**
 * A broadcast (eth_sendRawTransaction or eth_sendUserOperation) that got no
 * answer within the time limit. The outcome is UNKNOWN: the endpoint may
 * have received and forwarded it. Never retry it elsewhere automatically
 * (that would broadcast it a second time) and never report it as not sent.
 * The message avoids the words an endpoint-failure classifier looks for.
 */
export class BroadcastTimeoutError extends Error {
  readonly method: string;
  readonly timeoutMs: number;
  constructor(method: string, timeoutMs: number) {
    super(
      `No answer to ${method} within ${Math.round(timeoutMs / 1000)} seconds, so whether it was accepted is unknown.`,
    );
    this.name = 'BroadcastTimeoutError';
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

/** True for a BroadcastTimeoutError (by name, so it survives module copies). */
export function isBroadcastTimeoutError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    (error as { name?: unknown }).name === 'BroadcastTimeoutError'
  );
}

/**
 * Why a broadcast's answer never arrived intact (BroadcastUnansweredError):
 *  - 'server-error': the endpoint answered with an HTTP 5xx status. The
 *    node (or a proxy in front of it) may have received and forwarded the
 *    transaction before the error, so this is NOT a refusal;
 *  - 'connection': the request failed below JSON-RPC (the platform fetch
 *    rejected: a dropped connection, a reset, a DNS failure after the
 *    request may have been written) or the answer's body could not be read
 *    or parsed as JSON. Nothing says the endpoint did not receive it.
 */
export type BroadcastUnansweredReason = 'server-error' | 'connection';

/**
 * A broadcast (BROADCAST_METHODS) whose answer never arrived intact: an
 * HTTP 5xx status, or a failure before a JSON-RPC answer was parsed (phase
 * 23, the bounded-broadcast follow-ups). Like BroadcastTimeoutError the
 * outcome is UNKNOWN: never retry it elsewhere automatically and never
 * report it as not sent. A parsed JSON-RPC error (the node answered:
 * "transaction underpriced", "nonce too low", AA2x…) and an HTTP 4xx stay
 * ordinary errors, i.e. definite refusals, exactly as before. `causeText`
 * keeps the raw cause (the HTTP status line or the platform's message); the
 * message carries it too, inside one sentence that never starts with the
 * platform's text (an anchored "fetch failed" classifier never matches it).
 */
export class BroadcastUnansweredError extends Error {
  readonly method: string;
  readonly reason: BroadcastUnansweredReason;
  /** The HTTP status for 'server-error'; null otherwise. */
  readonly status: number | null;
  readonly causeText: string;
  constructor(method: string, reason: BroadcastUnansweredReason, causeText: string, status: number | null = null) {
    // One sentence (screens that clean a technical line keep only the first
    // one), never starting with the platform's text, the cause inside it.
    super(
      `No usable answer to ${method} (${
        reason === 'server-error' ? 'the endpoint answered with a server error' : 'the connection failed'
      }; cause: ${causeText}), so whether it was accepted is unknown.`,
    );
    this.name = 'BroadcastUnansweredError';
    this.method = method;
    this.reason = reason;
    this.status = status;
    this.causeText = causeText;
  }
}

/** True for a BroadcastUnansweredError (by name, so it survives module copies). */
export function isBroadcastUnansweredError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    (error as { name?: unknown }).name === 'BroadcastUnansweredError'
  );
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.name && error.name !== 'Error' ? `${error.name}: ${error.message}` : error.message;
  return String(error);
}

/**
 * Builds a fetch-based transport. Kept tiny so tests can inject fakes.
 *
 * Broadcasts (BROADCAST_METHODS) are bounded by `broadcastTimeoutMs`
 * (default BROADCAST_TIMEOUT_MS): after that the request is aborted (when
 * the platform has AbortController) and the call rejects with a
 * BroadcastTimeoutError. Every other method is sent exactly as before: no
 * signal, no timer.
 *
 * A broadcast whose answer never arrives intact — the platform fetch
 * rejects (a dropped connection), the endpoint answers HTTP 5xx, or the
 * body cannot be read or parsed — rejects with BroadcastUnansweredError (the
 * outcome is open, as for the timeout). An HTTP 4xx and a parsed JSON-RPC
 * error stay plain errors with the same messages as before. Every other
 * method keeps exactly its old error behaviour.
 */
export function httpTransport(
  url: string,
  fetchFn: typeof fetch = fetch,
  options: { broadcastTimeoutMs?: number } = {},
): JsonRpcTransport {
  let id = 0;
  // The exchange every method other than a broadcast uses, byte for byte as
  // before (the endpoint failover rules read its errors).
  const exchange = async (method: string, params: unknown[], signal?: AbortSignal): Promise<unknown> => {
    const response = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      throw new Error(`RPC HTTP error ${response.status} for ${method}`);
    }
    const body = (await response.json()) as {
      result?: unknown;
      error?: { code: number; message: string };
    };
    if (body.error) {
      throw new Error(`RPC error ${body.error.code}: ${body.error.message} (${method})`);
    }
    return body.result;
  };
  // A broadcast's exchange: the same request, but everything that happens
  // BEFORE a JSON-RPC answer is parsed leaves the outcome open
  // (BroadcastUnansweredError): the platform fetch rejecting, an HTTP 5xx
  // status, a body that cannot be read or parsed. An HTTP 4xx and a parsed
  // JSON-RPC error are thrown exactly as `exchange` throws them.
  const broadcastExchange = async (method: string, params: unknown[], signal?: AbortSignal): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw new BroadcastUnansweredError(method, 'connection', errorText(error));
    }
    if (!response.ok) {
      if (response.status >= 500 && response.status <= 599) {
        throw new BroadcastUnansweredError(method, 'server-error', `RPC HTTP error ${response.status} for ${method}`, response.status);
      }
      throw new Error(`RPC HTTP error ${response.status} for ${method}`);
    }
    let body: { result?: unknown; error?: { code: number; message: string } };
    try {
      body = (await response.json()) as typeof body;
    } catch (error) {
      throw new BroadcastUnansweredError(method, 'connection', `the answer could not be read: ${errorText(error)}`);
    }
    if (body === null || typeof body !== 'object') {
      throw new BroadcastUnansweredError(method, 'connection', 'the answer was not a JSON-RPC object');
    }
    if (body.error) {
      throw new Error(`RPC error ${body.error.code}: ${body.error.message} (${method})`);
    }
    return body.result;
  };
  const timeoutMs = options.broadcastTimeoutMs ?? BROADCAST_TIMEOUT_MS;
  return async (method, params) => {
    if (!BROADCAST_METHODS.includes(method)) return exchange(method, params);
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Rejected BEFORE the abort, so the race settles with this error
        // whatever the platform fetch does when it is aborted.
        reject(new BroadcastTimeoutError(method, timeoutMs));
        controller?.abort();
      }, timeoutMs);
    });
    const attempt = broadcastExchange(method, params, controller?.signal);
    // The losing promise's rejection (an abort after the deadline) is not
    // an unhandled rejection.
    attempt.catch(() => undefined);
    try {
      return await Promise.race([attempt, deadline]);
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Wire form of a v0.7 UserOperation, as bundler RPCs expect it. */
export interface RpcUserOperation {
  sender: string;
  nonce: string;
  factory?: string;
  factoryData?: string;
  callData: string;
  callGasLimit: string;
  verificationGasLimit: string;
  preVerificationGas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  paymaster?: string;
  paymasterVerificationGasLimit?: string;
  paymasterPostOpGasLimit?: string;
  paymasterData?: string;
  signature: string;
  /** EIP-7702 authorization tuple, when the operation carries one (see ./eip7702.ts). */
  eip7702Auth?: RpcEip7702Auth;
}

export function toRpcUserOperation(op: UserOperation): RpcUserOperation {
  return {
    ...(op.eip7702Auth ? { eip7702Auth: toRpcEip7702Auth(op.eip7702Auth) } : {}),
    sender: op.sender,
    nonce: bigintToHex(op.nonce),
    ...(op.factory ? { factory: op.factory } : {}),
    ...(op.factoryData ? { factoryData: toHex(op.factoryData) } : {}),
    callData: toHex(op.callData),
    callGasLimit: bigintToHex(op.callGasLimit),
    verificationGasLimit: bigintToHex(op.verificationGasLimit),
    preVerificationGas: bigintToHex(op.preVerificationGas),
    maxFeePerGas: bigintToHex(op.maxFeePerGas),
    maxPriorityFeePerGas: bigintToHex(op.maxPriorityFeePerGas),
    ...(op.paymaster ? { paymaster: op.paymaster } : {}),
    ...(op.paymasterVerificationGasLimit !== undefined
      ? { paymasterVerificationGasLimit: bigintToHex(op.paymasterVerificationGasLimit) }
      : {}),
    ...(op.paymasterPostOpGasLimit !== undefined
      ? { paymasterPostOpGasLimit: bigintToHex(op.paymasterPostOpGasLimit) }
      : {}),
    ...(op.paymasterData ? { paymasterData: toHex(op.paymasterData) } : {}),
    signature: toHex(op.signature),
  };
}

export interface GasEstimate {
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  paymasterVerificationGasLimit?: bigint;
}

// ---------------------------------------------------------------------------
// Impossible gas limits
// ---------------------------------------------------------------------------

/**
 * The gas limits a UserOperation is about to carry, as checked by
 * gasLimitProblems. `paymasterVerificationGasLimit` is the value that would
 * be signed (undefined packs as 0 in paymasterAndData, see
 * packPaymasterAndData in ./userop.ts).
 */
export interface GasLimitFields {
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  paymasterVerificationGasLimit?: bigint | undefined;
  paymasterPostOpGasLimit?: bigint | undefined;
}

/**
 * The reasons a set of gas limits cannot belong to any operation that
 * EntryPoint v0.7 would execute and an ERC-4337 bundler would accept; empty
 * means none was found. Only zero values are judged here: whether a
 * non-zero limit is high enough is the bundler's and the EntryPoint's
 * business, and a limit that is too low still fails safely at estimation.
 *
 * Why each zero is impossible (sources: eth-infinitism/account-abstraction
 * v0.7.0 contracts/core/EntryPoint.sol, and ERC-4337 as published in
 * ethereum/ERCs at commit f4df3d05, both read 2026-10-09):
 *
 *  - verificationGasLimit: _validateAccountPrepayment calls
 *    `IAccount(sender).validateUserOp{gas: verificationGasLimit}`, and for a
 *    first operation _createSenderIfNeeded runs the factory with
 *    `createSender{gas: verificationGasLimit}`. Every account validation
 *    executes code (at least the signature check), so with 0 gas it reverts.
 *  - callGasLimit: the EntryPoint itself makes the execution call only when
 *    callData is non-empty (innerHandleOp: `if (callData.length > 0)`), so
 *    0 would be harmless on-chain for empty callData. It is refused anyway,
 *    whatever the callData: ERC-4337's bundler sanity checks require "The
 *    callGasLimit is at least the cost of a CALL with non-zero value", so a
 *    bundler cannot accept an operation it estimated at 0, and the
 *    SmartAccountClient never builds empty callData (every spec's
 *    encodeCalls returns an execute call).
 *  - preVerificationGas: ERC-4337 ("Estimating preVerificationGas") requires
 *    it to cover at least the operation's calldata cost (EIP-2028) and the
 *    bundle transaction's base cost share, and the sanity checks require it
 *    to pay for the calldata of the serialized operation plus
 *    PRE_VERIFICATION_OVERHEAD_GAS. An operation's calldata is never empty,
 *    so 0 is never a real estimate. (The EntryPoint does not enforce a
 *    minimum; the bundler would refuse it at submission instead.)
 *  - paymasterVerificationGasLimit, only when the operation names a
 *    paymaster: _validatePaymasterPrepayment calls
 *    `IPaymaster(paymaster).validatePaymasterUserOp{gas: pmVerificationGasLimit}`,
 *    which cannot run with 0 gas.
 *  - paymasterPostOpGasLimit is NOT checked: _postExecution calls postOp only
 *    `if (context.length > 0)`, so a paymaster whose validation returns an
 *    empty context legitimately uses 0.
 */
export function gasLimitProblems(fields: GasLimitFields, hasPaymaster: boolean): string[] {
  const problems: string[] = [];
  if (fields.verificationGasLimit === 0n) {
    problems.push('verificationGasLimit is 0, but the account\'s validation (and any deployment) runs with exactly that much gas');
  }
  if (fields.callGasLimit === 0n) {
    problems.push('callGasLimit is 0, below the cost of the execution call');
  }
  if (fields.preVerificationGas === 0n) {
    problems.push('preVerificationGas is 0, but it must at least pay for the operation\'s calldata');
  }
  if (hasPaymaster && (fields.paymasterVerificationGasLimit ?? 0n) === 0n) {
    problems.push(
      'paymasterVerificationGasLimit is 0 although the operation names a paymaster, whose validation runs with exactly that much gas',
    );
  }
  return problems;
}

/**
 * The problems with a bundler's eth_estimateUserOperationGas answer for
 * `op`. The paymaster verification limit judged is the estimate's when it
 * gives one, else the one the operation already carries (from the paymaster
 * stub), because that is the value the client would keep and sign.
 */
export function gasEstimateProblems(estimate: GasEstimate, op: UserOperation): string[] {
  return gasLimitProblems(
    {
      callGasLimit: estimate.callGasLimit,
      verificationGasLimit: estimate.verificationGasLimit,
      preVerificationGas: estimate.preVerificationGas,
      paymasterVerificationGasLimit: estimate.paymasterVerificationGasLimit ?? op.paymasterVerificationGasLimit,
    },
    Boolean(op.paymaster),
  );
}

/**
 * Thrown when gas limits that no operation can execute with would otherwise
 * be signed: a bundler estimate with a zero limit (observed 2026-10-09 on
 * ZeroDev's Arbitrum Sepolia endpoint: verificationGasLimit and
 * paymasterVerificationGasLimit 0x0 in bursts), or paymaster data that
 * would carry a zero paymasterVerificationGasLimit. Thrown before the
 * operation is signed, so the UserOperation was neither signed nor
 * submitted. `fields` are the raw limits that were refused (the last
 * attempt's when the estimate was retried); `attempts` is how many
 * estimates were asked for.
 */
export class ImpossibleGasEstimateError extends Error {
  readonly problems: string[];
  readonly fields: GasLimitFields;
  readonly attempts: number;
  readonly source: 'estimate' | 'paymaster' | 'operation';
  // No TypeScript parameter properties: Node's type stripping rejects them
  // in the app's check scripts.
  constructor(
    problems: string[],
    fields: GasLimitFields,
    options: { attempts?: number; source?: 'estimate' | 'paymaster' | 'operation' } = {},
  ) {
    const attempts = options.attempts ?? 1;
    const source = options.source ?? 'estimate';
    const what =
      source === 'estimate'
        ? attempts > 1
          ? `The bundler answered an impossible gas estimate on all ${attempts} attempts`
          : 'The bundler answered an impossible gas estimate'
        : source === 'paymaster'
          ? 'The paymaster data would carry an impossible gas limit'
          : 'The operation would carry an impossible gas limit';
    super(`${what} (${problems.join('; ')}). The operation was not signed or submitted.`);
    this.name = 'ImpossibleGasEstimateError';
    this.problems = problems;
    this.fields = fields;
    this.attempts = attempts;
    this.source = source;
  }
}

/** How often an impossible estimate is asked for again, and how long to wait between asks. */
export interface EstimateRetryPolicy {
  /** Total estimates asked for, including the first (at least 1). */
  attempts: number;
  /** Wait between two attempts, in milliseconds (none after the last). */
  delayMs: number;
}

/**
 * The default for SmartAccountClient and
 * BundlerClient.estimateUserOperationGasChecked: 4 attempts 2 s apart, so a
 * person waiting on a Review or Approve button waits at most about 6 s plus
 * four round trips before being told to try again. The testnet scripts use
 * 24 attempts 5 s apart because nobody is waiting on them. The bursts
 * observed on 2026-10-09 lasted tens of seconds, so this short retry rides
 * out a brief burst only; its main job is the refusal, not the recovery.
 */
export const DEFAULT_ESTIMATE_RETRIES: EstimateRetryPolicy = { attempts: 4, delayMs: 2_000 };

/** ERC-4337 bundler RPC client (eth_* userOperation namespace). */
export class BundlerClient {
  constructor(
    private transport: JsonRpcTransport,
    private entryPoint: string,
  ) {}

  async supportedEntryPoints(): Promise<string[]> {
    return (await this.transport('eth_supportedEntryPoints', [])) as string[];
  }

  async estimateUserOperationGas(op: UserOperation): Promise<GasEstimate> {
    const result = (await this.transport('eth_estimateUserOperationGas', [
      toRpcUserOperation(op),
      this.entryPoint,
    ])) as Record<string, string>;
    return {
      callGasLimit: BigInt(result.callGasLimit ?? '0x0'),
      verificationGasLimit: BigInt(result.verificationGasLimit ?? '0x0'),
      preVerificationGas: BigInt(result.preVerificationGas ?? '0x0'),
      ...(result.paymasterVerificationGasLimit !== undefined
        ? { paymasterVerificationGasLimit: BigInt(result.paymasterVerificationGasLimit) }
        : {}),
    };
  }

  /**
   * estimateUserOperationGas, refusing an answer with impossible limits
   * (gasEstimateProblems) and asking again up to `retries.attempts` times,
   * `retries.delayMs` apart. Throws ImpossibleGasEstimateError, carrying the
   * last answer, when every attempt was impossible. Errors from the bundler
   * itself (a revert, an HTTP failure) are thrown at once, not retried.
   */
  async estimateUserOperationGasChecked(
    op: UserOperation,
    retries: EstimateRetryPolicy = DEFAULT_ESTIMATE_RETRIES,
  ): Promise<GasEstimate> {
    const attempts = Math.max(1, Math.floor(retries.attempts));
    for (let attempt = 1; ; attempt++) {
      const estimate = await this.estimateUserOperationGas(op);
      const problems = gasEstimateProblems(estimate, op);
      if (problems.length === 0) return estimate;
      if (attempt >= attempts) {
        throw new ImpossibleGasEstimateError(
          problems,
          {
            ...estimate,
            ...(estimate.paymasterVerificationGasLimit === undefined && op.paymasterVerificationGasLimit !== undefined
              ? { paymasterVerificationGasLimit: op.paymasterVerificationGasLimit }
              : {}),
          },
          { attempts, source: 'estimate' },
        );
      }
      if (retries.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, retries.delayMs));
    }
  }

  /** Submits the signed operation; resolves to the userOpHash. */
  async sendUserOperation(op: UserOperation): Promise<string> {
    return (await this.transport('eth_sendUserOperation', [
      toRpcUserOperation(op),
      this.entryPoint,
    ])) as string;
  }

  async getUserOperationReceipt(userOpHash: string): Promise<unknown | null> {
    return this.transport('eth_getUserOperationReceipt', [userOpHash]);
  }
}

/**
 * Plain node RPC client: the calls an EOA send flow needs. Deliberately
 * tiny — anything richer (logs, tracing) belongs to a later phase.
 */
export class NodeClient {
  constructor(private transport: JsonRpcTransport) {}

  async getBalance(address: string): Promise<bigint> {
    return BigInt(
      (await this.transport('eth_getBalance', [address, 'latest'])) as string,
    );
  }

  /** Pending-inclusive nonce, so consecutive sends do not collide. */
  async getTransactionCount(address: string): Promise<bigint> {
    return BigInt(
      (await this.transport('eth_getTransactionCount', [address, 'pending'])) as string,
    );
  }

  async chainId(): Promise<bigint> {
    return BigInt((await this.transport('eth_chainId', [])) as string);
  }

  /**
   * Suggests EIP-1559 fees: the latest block's base fee doubled (headroom
   * for six consecutive full blocks) plus the node's suggested priority fee.
   */
  async suggestFees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const block = (await this.transport('eth_getBlockByNumber', [
      'latest',
      false,
    ])) as { baseFeePerGas?: string };
    if (!block?.baseFeePerGas) {
      throw new Error('Node returned no baseFeePerGas; chain may not support EIP-1559');
    }
    const baseFee = BigInt(block.baseFeePerGas);
    const priority = BigInt(
      (await this.transport('eth_maxPriorityFeePerGas', [])) as string,
    );
    return { maxFeePerGas: baseFee * 2n + priority, maxPriorityFeePerGas: priority };
  }

  async estimateGas(tx: {
    from: string;
    to?: string;
    value?: bigint;
    data?: string;
  }): Promise<bigint> {
    const params: Record<string, string> = { from: tx.from };
    if (tx.to) params.to = tx.to;
    if (tx.value !== undefined) params.value = bigintToHex(tx.value);
    if (tx.data) params.data = tx.data;
    return BigInt((await this.transport('eth_estimateGas', [params])) as string);
  }

  /** Broadcasts raw signed bytes; resolves to the transaction hash. */
  async sendRawTransaction(rawHex: string): Promise<string> {
    return (await this.transport('eth_sendRawTransaction', [rawHex])) as string;
  }
}

/**
 * ERC-7677 paymaster client. Sponsorship (or ERC-20 gas payment) context is
 * an opaque vendor-defined object passed through untouched, so switching
 * paymaster services is a URL + context change only.
 */
export interface PaymasterResult {
  paymaster: string;
  paymasterData: Uint8Array;
  paymasterVerificationGasLimit?: bigint;
  paymasterPostOpGasLimit?: bigint;
}

export class PaymasterClient {
  constructor(
    private transport: JsonRpcTransport,
    private entryPoint: string,
  ) {}

  async getPaymasterStubData(
    op: UserOperation,
    chainId: bigint,
    context: unknown = null,
  ): Promise<PaymasterResult> {
    return this.call('pm_getPaymasterStubData', op, chainId, context);
  }

  async getPaymasterData(
    op: UserOperation,
    chainId: bigint,
    context: unknown = null,
  ): Promise<PaymasterResult> {
    return this.call('pm_getPaymasterData', op, chainId, context);
  }

  private async call(
    method: string,
    op: UserOperation,
    chainId: bigint,
    context: unknown,
  ): Promise<PaymasterResult> {
    const result = (await this.transport(method, [
      toRpcUserOperation(op),
      this.entryPoint,
      bigintToHex(chainId),
      context,
    ])) as Record<string, string>;
    if (!result.paymaster || !result.paymasterData) {
      throw new Error(`${method} returned no paymaster data`);
    }
    return {
      paymaster: result.paymaster,
      paymasterData: toBytes(result.paymasterData),
      ...(result.paymasterVerificationGasLimit !== undefined
        ? { paymasterVerificationGasLimit: BigInt(result.paymasterVerificationGasLimit) }
        : {}),
      ...(result.paymasterPostOpGasLimit !== undefined
        ? { paymasterPostOpGasLimit: BigInt(result.paymasterPostOpGasLimit) }
        : {}),
    };
  }
}
