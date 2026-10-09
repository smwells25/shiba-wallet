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

/** Builds a fetch-based transport. Kept tiny so tests can inject fakes. */
export function httpTransport(
  url: string,
  fetchFn: typeof fetch = fetch,
): JsonRpcTransport {
  let id = 0;
  return async (method, params) => {
    const response = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
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
