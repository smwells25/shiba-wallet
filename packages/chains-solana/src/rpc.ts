import { base64 } from '@scure/base';

/**
 * Vendor-neutral Solana JSON-RPC plumbing. The wallet injects a transport
 * (usually fetch against a user-configurable URL); nothing in this package
 * hardcodes an RPC provider. Vendors are configuration, not code (ADR D5).
 *
 * The transport shape is deliberately identical to the one in
 * @shiba-wallet/chains-evm, but defined locally so the packages stay
 * independent of each other.
 *
 * Method names, parameter shapes, and result shapes below were verified
 * against the official RPC reference at https://solana.com/docs/rpc
 * (getLatestBlockhash, getBalance, sendTransaction, getSignatureStatuses
 * pages, fetched 2026-09-27). Each method cites its page inline.
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

/** Solana commitment levels, weakest to strongest. */
export type Commitment = 'processed' | 'confirmed' | 'finalized';

/** Rank used to compare commitment levels when polling for confirmation. */
const COMMITMENT_RANK: Record<Commitment, number> = {
  processed: 0,
  confirmed: 1,
  finalized: 2,
};

export interface LatestBlockhash {
  /** Base58-encoded blockhash to embed in a message. */
  blockhash: string;
  /** Last block height at which this blockhash remains valid. */
  lastValidBlockHeight: bigint;
}

/**
 * One entry from getSignatureStatuses. Per the reference, `confirmations`
 * is null once the transaction is "rooted and finalized by a supermajority
 * of stake", `err` is null on success, and `confirmationStatus` is one of
 * processed | confirmed | finalized.
 */
export interface SignatureStatus {
  slot: number;
  confirmations: number | null;
  err: unknown;
  confirmationStatus: Commitment | null;
}

export interface ConfirmOptions {
  /** Commitment level to wait for. Defaults to 'confirmed'. */
  commitment?: Commitment;
  /** Delay between polls in milliseconds. Defaults to 1000. */
  pollIntervalMs?: number;
  /** Give up after this long. Defaults to 60000 ms. */
  timeoutMs?: number;
  /** Injectable sleep, so tests can run without real delays. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Solana JSON-RPC client over an injected transport. */
export class SolanaRpcClient {
  constructor(private transport: JsonRpcTransport) {}

  /**
   * getLatestBlockhash. Reference (solana.com/docs/rpc/http/getlatestblockhash):
   * params are one optional config object ({ commitment?, minContextSlot? });
   * the result nests { context, value: { blockhash, lastValidBlockHeight } }.
   */
  async getLatestBlockhash(commitment?: Commitment): Promise<LatestBlockhash> {
    const params: unknown[] = commitment ? [{ commitment }] : [];
    const result = (await this.transport('getLatestBlockhash', params)) as {
      value: { blockhash: string; lastValidBlockHeight: number };
    };
    return {
      blockhash: result.value.blockhash,
      lastValidBlockHeight: BigInt(result.value.lastValidBlockHeight),
    };
  }

  /**
   * getBalance. Reference (solana.com/docs/rpc/http/getbalance): params are
   * the base58 pubkey string plus an optional config object; the result is
   * { context, value } with value the lamport balance as a u64.
   */
  async getBalance(address: string, commitment?: Commitment): Promise<bigint> {
    const params: unknown[] = commitment ? [address, { commitment }] : [address];
    const result = (await this.transport('getBalance', params)) as { value: number };
    return BigInt(result.value);
  }

  /**
   * sendTransaction. Reference (solana.com/docs/rpc/http/sendtransaction):
   * params are the fully signed transaction as an encoded string plus a
   * config object; base64 is the recommended encoding but the default is
   * base58, so { encoding: 'base64' } must be passed explicitly. Returns
   * the first signature in the transaction as a base58 string.
   */
  async sendTransaction(
    wireBytes: Uint8Array,
    options: { skipPreflight?: boolean; preflightCommitment?: Commitment } = {},
  ): Promise<string> {
    return (await this.transport('sendTransaction', [
      base64.encode(wireBytes),
      { encoding: 'base64', ...options },
    ])) as string;
  }

  /**
   * getSignatureStatuses. Reference
   * (solana.com/docs/rpc/http/getsignaturestatuses): params are an array of
   * base58 signature strings (max 256) plus an optional
   * { searchTransactionHistory } config; the result value is an array of
   * status objects or nulls, index-aligned with the input.
   */
  async getSignatureStatuses(
    signatures: string[],
    searchTransactionHistory = false,
  ): Promise<Array<SignatureStatus | null>> {
    const params: unknown[] = searchTransactionHistory
      ? [signatures, { searchTransactionHistory: true }]
      : [signatures];
    const result = (await this.transport('getSignatureStatuses', params)) as {
      value: Array<SignatureStatus | null>;
    };
    return result.value;
  }

  /**
   * Polls getSignatureStatuses until the transaction reaches the requested
   * commitment level, in the spirit of web3.js confirmTransaction. Throws
   * if the transaction failed on-chain (non-null err) or if the timeout
   * elapses first. A null confirmations count means finalized, so it
   * satisfies every commitment level.
   */
  async confirmTransaction(
    signature: string,
    options: ConfirmOptions = {},
  ): Promise<SignatureStatus> {
    const {
      commitment = 'confirmed',
      pollIntervalMs = 1000,
      timeoutMs = 60_000,
      sleep = defaultSleep,
    } = options;
    const targetRank = COMMITMENT_RANK[commitment];
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const [status] = await this.getSignatureStatuses([signature]);
      if (status) {
        if (status.err !== null && status.err !== undefined) {
          throw new Error(`transaction ${signature} failed: ${JSON.stringify(status.err)}`);
        }
        const reached =
          status.confirmations === null ||
          (status.confirmationStatus !== null &&
            COMMITMENT_RANK[status.confirmationStatus] >= targetRank);
        if (reached) return status;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `timed out after ${timeoutMs}ms waiting for ${commitment} on ${signature}`,
        );
      }
      await sleep(pollIntervalMs);
    }
  }
}
