import { keccak_256 } from '@noble/hashes/sha3.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { toChecksumAddress } from '@shiba-wallet/core';
import { bigintToHex, toBytes, toHex } from './encoding.js';
import { isEip7708TransferLogAddress } from './asset-diff.js';
import type { JsonRpcTransport } from './rpc.js';

/**
 * ERC-20 transfer history via eth_getLogs — the only address history a
 * plain JSON-RPC endpoint can serve (native-coin history needs an indexer
 * or explorer API, which stays a configurable later addition). The
 * Transfer(address,address,uint256) event indexes both parties, so two
 * topic-filtered queries (as sender, as recipient) cover an address. Since
 * EIP-7708 the protocol also emits Transfer-shaped logs for ETH from the
 * system address 0xff…fe; they are left out here (not a token).
 *
 * Public endpoints cap eth_getLogs block ranges, so callers page by
 * explicit block windows; the app walks backwards window by window.
 * Live-probed limits on ethereum-rpc.publicnode.com (2026-09-27): the
 * filter must name a contract address (wallet-wide queries across all
 * tokens are refused with -32701), and a 10,000-block window per token
 * succeeds while 50,000 is rejected. Treat ~10k as the free-tier window;
 * paid endpoints can go wider.
 */

/** keccak256("Transfer(address,address,uint256)"), computed, not pasted. */
export const TRANSFER_TOPIC = toHex(
  keccak_256(utf8ToBytes('Transfer(address,address,uint256)')),
);

export interface Erc20Transfer {
  txHash: string;
  blockNumber: bigint;
  logIndex: number;
  /** Token contract, checksummed. */
  token: string;
  from: string;
  to: string;
  value: bigint;
}

export interface Erc20TransferQuery {
  /** The wallet address whose transfers to fetch. */
  address: string;
  /** Restrict to one token contract; omit for all tokens. */
  token?: string;
  fromBlock: bigint;
  toBlock: bigint;
}

interface RawLog {
  transactionHash: string;
  blockNumber: string;
  logIndex: string;
  address: string;
  topics: string[];
  data: string;
}

/** Left-pads an address into a 32-byte topic value. */
export function addressTopic(address: string): string {
  const bytes = toBytes(address);
  if (bytes.length !== 20) throw new Error(`Not a 20-byte address: ${address}`);
  return '0x' + '00'.repeat(12) + toHex(bytes).slice(2);
}

function topicToAddress(topic: string): string {
  const bytes = toBytes(topic);
  if (bytes.length !== 32) throw new Error(`Not a 32-byte topic: ${topic}`);
  return toChecksumAddress(bytes.slice(12));
}

export async function getErc20Transfers(
  transport: JsonRpcTransport,
  query: Erc20TransferQuery,
): Promise<Erc20Transfer[]> {
  const me = addressTopic(query.address);
  const base = {
    fromBlock: bigintToHex(query.fromBlock),
    toBlock: bigintToHex(query.toBlock),
    ...(query.token ? { address: query.token } : {}),
  };
  const [sent, received] = await Promise.all([
    transport('eth_getLogs', [{ ...base, topics: [TRANSFER_TOPIC, me] }]),
    transport('eth_getLogs', [{ ...base, topics: [TRANSFER_TOPIC, null, me] }]),
  ]);

  const seen = new Set<string>();
  const transfers: Erc20Transfer[] = [];
  for (const log of [...(sent as RawLog[]), ...(received as RawLog[])]) {
    // A self-transfer appears in both result sets; dedupe by tx+logIndex.
    const key = `${log.transactionHash}:${log.logIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Some non-compliant contracts emit Transfer with missing indexed
    // fields; skip anything that does not match the canonical shape.
    if (log.topics.length !== 3) continue;
    // EIP-7708 (active on Sepolia since 2026-10-06, see asset-diff.ts): the
    // protocol logs every ETH transfer with this same Transfer topic and
    // shape from the system address 0xff…fe. That is an ETH movement, not
    // an ERC-20 token, so a query without a token filter must not list it
    // as "token 0xff…fe". (A query filtered to a token contract never
    // returns it: eth_getLogs matches the emitting address.)
    if (isEip7708TransferLogAddress(log.address)) continue;
    transfers.push({
      txHash: log.transactionHash,
      blockNumber: BigInt(log.blockNumber),
      logIndex: Number(log.logIndex),
      token: toChecksumAddress(toBytes(log.address)),
      from: topicToAddress(log.topics[1]!),
      to: topicToAddress(log.topics[2]!),
      value: log.data === '0x' ? 0n : BigInt(log.data),
    });
  }
  // Newest first, stable within a block by log index.
  transfers.sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? b.logIndex - a.logIndex
      : a.blockNumber > b.blockNumber
        ? -1
        : 1,
  );
  return transfers;
}
