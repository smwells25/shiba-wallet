import { bigintToHex, toBytes, toHex } from './encoding.js';
import type { UserOperation } from './userop.js';

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
}

export function toRpcUserOperation(op: UserOperation): RpcUserOperation {
  return {
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
