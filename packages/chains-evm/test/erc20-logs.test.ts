import { describe, expect, it } from 'vitest';
import { id } from 'ethers';
import {
  TRANSFER_TOPIC,
  addressTopic,
  getErc20Transfers,
} from '../src/erc20-logs.js';
import type { JsonRpcTransport } from '../src/rpc.js';

const ME = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const TOKEN = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

function log(overrides: Partial<Record<string, unknown>>) {
  return {
    transactionHash: '0xhash1',
    blockNumber: '0x64',
    logIndex: '0x0',
    address: TOKEN,
    topics: [TRANSFER_TOPIC, addressTopic(ME), addressTopic(OTHER)],
    data: '0xf4240', // 1,000,000
    ...overrides,
  };
}

describe('ERC-20 transfer logs', () => {
  it('computes the canonical Transfer topic (vs ethers.id)', () => {
    expect(TRANSFER_TOPIC).toBe(id('Transfer(address,address,uint256)'));
  });

  it('queries both directions with padded address topics and decodes', async () => {
    const calls: unknown[][] = [];
    const transport: JsonRpcTransport = async (method, params) => {
      expect(method).toBe('eth_getLogs');
      calls.push(params);
      const filter = (params as [Record<string, unknown>])[0];
      const topics = filter.topics as (string | null)[];
      if (topics[1] === addressTopic(ME)) return [log({})]; // sent
      return [
        log({
          transactionHash: '0xhash2',
          blockNumber: '0x65',
          topics: [TRANSFER_TOPIC, addressTopic(OTHER), addressTopic(ME)],
          data: '0x1e8480',
        }),
      ];
    };

    const transfers = await getErc20Transfers(transport, {
      address: ME,
      token: TOKEN,
      fromBlock: 90n,
      toBlock: 110n,
    });

    expect(calls.length).toBe(2);
    const sentFilter = calls[0]![0] as Record<string, unknown>;
    expect(sentFilter.fromBlock).toBe('0x5a');
    expect(sentFilter.toBlock).toBe('0x6e');
    expect(sentFilter.address).toBe(TOKEN);

    // Newest first: the incoming transfer is in a later block.
    expect(transfers.map((t) => t.txHash)).toEqual(['0xhash2', '0xhash1']);
    expect(transfers[1]).toMatchObject({
      from: '0x1111111111111111111111111111111111111111',
      to: '0x2222222222222222222222222222222222222222',
      value: 1_000_000n,
      blockNumber: 100n,
    });
  });

  it('dedupes self-transfers and skips non-standard logs', async () => {
    const selfLog = log({
      topics: [TRANSFER_TOPIC, addressTopic(ME), addressTopic(ME)],
    });
    const malformed = log({
      transactionHash: '0xweird',
      topics: [TRANSFER_TOPIC], // unindexed parameters: skip
    });
    const transport: JsonRpcTransport = async () => [selfLog, malformed];
    const transfers = await getErc20Transfers(transport, {
      address: ME,
      fromBlock: 0n,
      toBlock: 1n,
    });
    expect(transfers.length).toBe(1);
    expect(transfers[0]!.to).toBe(transfers[0]!.from);
  });

  it('treats empty data as zero-value transfers', async () => {
    const transport: JsonRpcTransport = async (_m, params) => {
      const topics = (params as [Record<string, (string | null)[]>])[0].topics!;
      return topics[1] === addressTopic(ME) ? [log({ data: '0x' })] : [];
    };
    const transfers = await getErc20Transfers(transport, {
      address: ME,
      fromBlock: 0n,
      toBlock: 1n,
    });
    expect(transfers[0]!.value).toBe(0n);
  });

  it('leaves out EIP-7708 protocol ETH-transfer logs (0xff…fe, same topic and shape) in an unfiltered query', async () => {
    const SYSTEM = '0xfffffffffffffffffffffffffffffffffffffffe';
    const transport: JsonRpcTransport = async (_method, params) => {
      const topics = (params as [Record<string, unknown>])[0]!.topics as (string | null)[];
      if (topics[1] === addressTopic(ME)) {
        return [log({ address: SYSTEM, transactionHash: '0xeth' }), log({ transactionHash: '0xtoken', logIndex: '0x1' })];
      }
      return [];
    };
    const transfers = await getErc20Transfers(transport, { address: ME, fromBlock: 1n, toBlock: 200n });
    expect(transfers.map((t) => t.txHash)).toEqual(['0xtoken']);
    expect(transfers.every((t) => t.token.toLowerCase() !== SYSTEM)).toBe(true);
  });
});
