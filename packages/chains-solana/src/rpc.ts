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

/** An account as getAccountInfo answers it, with the data decoded to bytes. */
export interface RawAccount {
  /** The account's own address (base58). */
  address: string;
  /** The program that owns the account (base58). */
  owner: string;
  lamports: bigint;
  executable: boolean;
  data: Uint8Array;
}

interface RawAccountValue {
  data: [string, string];
  executable: boolean;
  lamports: number;
  owner: string;
}

function decodeRawAccount(address: string, value: RawAccountValue): RawAccount {
  if (!Array.isArray(value.data) || value.data[1] !== 'base64') {
    throw new Error(`account ${address} was not returned in base64 encoding`);
  }
  return {
    address,
    owner: value.owner,
    lamports: BigInt(value.lamports),
    executable: value.executable,
    data: base64.decode(value.data[0]),
  };
}

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
  /**
   * getTokenAccountsByOwner with jsonParsed encoding. Reference
   * (solana.com/docs/rpc/http/gettokenaccountsbyowner): positional params
   * are the owner pubkey, a filter object ({ mint } or { programId }),
   * and a config object; under jsonParsed each entry carries
   * account.data.parsed.info.mint and .tokenAmount.amount (a base-10
   * string, since raw amounts overflow doubles) plus .decimals.
   */
  async getTokenBalances(
    owner: string,
    filter: { mint: string } | { programId: string },
    commitment?: Commitment,
  ): Promise<Array<{ mint: string; amount: bigint; decimals: number }>> {
    const config: Record<string, unknown> = { encoding: 'jsonParsed' };
    if (commitment) config.commitment = commitment;
    const result = (await this.transport('getTokenAccountsByOwner', [
      owner,
      filter,
      config,
    ])) as {
      value: Array<{
        account: {
          data: {
            parsed: {
              info: { mint: string; tokenAmount: { amount: string; decimals: number } };
            };
          };
        };
      }>;
    };
    return result.value.map((entry) => {
      const info = entry.account.data.parsed.info;
      return {
        mint: info.mint,
        amount: BigInt(info.tokenAmount.amount),
        decimals: info.tokenAmount.decimals,
      };
    });
  }

  /**
   * getAccountInfo with base64 encoding. Reference
   * (solana.com/docs/rpc/http/getaccountinfo; source
   * solana-foundation/solana-com apps/docs/content/docs/en/rpc/http/getaccountinfo.mdx
   * at 31f66e08, read 2026-11-07): params are the base58 pubkey and a config
   * object ({ commitment?, encoding }); the result is { context, value }
   * with value null for an account that does not exist, else { data:
   * [base64, "base64"], executable, lamports, owner, space, rentEpoch }.
   * The raw bytes are returned so the wallet parses them itself instead of
   * trusting a node's jsonParsed rendering.
   */
  async getAccountInfoBase64(
    address: string,
    commitment?: Commitment,
  ): Promise<RawAccount | null> {
    const config: Record<string, unknown> = { encoding: 'base64' };
    if (commitment) config.commitment = commitment;
    const result = (await this.transport('getAccountInfo', [address, config])) as {
      value: RawAccountValue | null;
    };
    return result.value === null ? null : decodeRawAccount(address, result.value);
  }

  /**
   * getTokenAccountsByOwner with base64 encoding, for one token program.
   * Reference (solana.com/docs/rpc/http/gettokenaccountsbyowner; source
   * gettokenaccountsbyowner.mdx at 31f66e08, read 2026-11-07): the filter
   * is { programId } or { mint }; the encoding may be base58, base64,
   * base64+zstd, binary or jsonParsed; each entry is { pubkey, account }
   * with account shaped as in getAccountInfo.
   */
  async getTokenAccountsByOwnerBase64(
    owner: string,
    programId: string,
    commitment?: Commitment,
  ): Promise<RawAccount[]> {
    const config: Record<string, unknown> = { encoding: 'base64' };
    if (commitment) config.commitment = commitment;
    const result = (await this.transport('getTokenAccountsByOwner', [
      owner,
      { programId },
      config,
    ])) as { value: Array<{ pubkey: string; account: RawAccountValue }> };
    return result.value.map((entry) => decodeRawAccount(entry.pubkey, entry.account));
  }

  /**
   * getEpochInfo. Reference (solana.com/docs/rpc/http/getepochinfo; source
   * getepochinfo.mdx at 31f66e08, read 2026-11-07): params are an optional
   * config object; the result carries absoluteSlot, blockHeight, epoch,
   * slotIndex, slotsInEpoch and transactionCount. A Token-2022 transfer fee
   * depends on the current epoch.
   */
  async getEpoch(commitment?: Commitment): Promise<bigint> {
    const params: unknown[] = commitment ? [{ commitment }] : [];
    const result = (await this.transport('getEpochInfo', params)) as { epoch: number };
    if (!Number.isSafeInteger(result.epoch) || result.epoch < 0) {
      throw new Error('getEpochInfo answered without a valid epoch');
    }
    return BigInt(result.epoch);
  }

  /**
   * getMinimumBalanceForRentExemption. Reference
   * (solana.com/docs/rpc/http/getminimumbalanceforrentexemption; source
   * getminimumbalanceforrentexemption.mdx at 31f66e08, read 2026-11-07):
   * params are the account's data length (usize) and an optional config;
   * the result is the lamports needed.
   */
  async getMinimumBalanceForRentExemption(dataLength: number): Promise<bigint> {
    if (!Number.isSafeInteger(dataLength) || dataLength < 0) {
      throw new Error('data length must be a non-negative integer');
    }
    const result = (await this.transport('getMinimumBalanceForRentExemption', [dataLength])) as number;
    if (!Number.isSafeInteger(result) || result < 0) {
      throw new Error('getMinimumBalanceForRentExemption answered without a valid amount');
    }
    return BigInt(result);
  }

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
