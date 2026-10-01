import { describe, expect, it } from 'vitest';
import { AbiCoder, Interface, getAddress, id, zeroPadValue } from 'ethers';
import {
  ERC20_ALLOWANCE_SIGNATURE,
  IS_APPROVED_FOR_ALL_SELECTOR,
  SET_APPROVAL_FOR_ALL_SELECTOR,
  blockWindows,
  encodeErc20Allowance,
  encodeErc20Revoke,
  encodeIsApprovedForAll,
  encodeSetApprovalForAll,
  getErc20Allowance,
  getErc20Approvals,
  getOperatorApprovals,
  isApprovedForAll,
  validateLog,
  withCurrentAllowances,
} from '../src/approvals.js';
import { APPROVAL_EVENT_TOPIC, APPROVAL_FOR_ALL_EVENT_TOPIC, MAX_UINT256 } from '../src/asset-diff.js';
import { toHex } from '../src/encoding.js';
import type { JsonRpcTransport } from '../src/rpc.js';

const coder = AbiCoder.defaultAbiCoder();
const OWNER = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const SPENDER_A = '0x1111111111111111111111111111111111111111';
const SPENDER_B = '0x2222222222222222222222222222222222222222';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const NFT = '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D';

const erc20Iface = new Interface([
  'function approve(address spender, uint256 value) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);
const nftIface = new Interface([
  'function setApprovalForAll(address operator, bool approved)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
]);

const topicOf = (address: string): string => zeroPadValue(address, 32).toLowerCase();
const word = (value: bigint): string => coder.encode(['uint256'], [value]);
const hash = (n: number): string => '0x' + n.toString(16).padStart(64, '0');

function approvalLog(
  spender: string,
  value: bigint,
  block: number,
  logIndex: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    transactionHash: hash(block * 1000 + logIndex),
    blockNumber: '0x' + block.toString(16),
    logIndex: '0x' + logIndex.toString(16),
    address: USDC.toLowerCase(),
    topics: [APPROVAL_EVENT_TOPIC, topicOf(OWNER), topicOf(spender)],
    data: word(value),
    removed: false,
    ...overrides,
  };
}

function operatorLog(operator: string, approved: boolean | bigint, block: number, logIndex: number) {
  const flag = typeof approved === 'bigint' ? approved : approved ? 1n : 0n;
  return {
    transactionHash: hash(block * 1000 + logIndex),
    blockNumber: '0x' + block.toString(16),
    logIndex: '0x' + logIndex.toString(16),
    address: NFT.toLowerCase(),
    topics: [APPROVAL_FOR_ALL_EVENT_TOPIC, topicOf(OWNER), topicOf(operator)],
    data: word(flag),
  };
}

function recordingTransport(respond: (method: string, params: unknown[]) => unknown) {
  const calls: { method: string; params: unknown[] }[] = [];
  const transport: JsonRpcTransport = async (method, params) => {
    calls.push({ method, params });
    return respond(method, params);
  };
  return { transport, calls };
}

describe('approvals: selectors and calldata (pinned against ethers)', () => {
  it('uses the ERC-20 / ERC-721 event topics', () => {
    expect(APPROVAL_EVENT_TOPIC).toBe(id('Approval(address,address,uint256)'));
    expect(APPROVAL_FOR_ALL_EVENT_TOPIC).toBe(id('ApprovalForAll(address,address,bool)'));
  });

  it('computes setApprovalForAll / isApprovedForAll selectors', () => {
    expect(toHex(SET_APPROVAL_FOR_ALL_SELECTOR)).toBe(nftIface.getFunction('setApprovalForAll')!.selector);
    expect(toHex(IS_APPROVED_FOR_ALL_SELECTOR)).toBe(nftIface.getFunction('isApprovedForAll')!.selector);
    expect(toHex(SET_APPROVAL_FOR_ALL_SELECTOR)).toBe(id('setApprovalForAll(address,bool)').slice(0, 10));
  });

  it('encodes setApprovalForAll for both bool values byte-identically to ethers', () => {
    expect(toHex(encodeSetApprovalForAll(SPENDER_A, false))).toBe(
      nftIface.encodeFunctionData('setApprovalForAll', [SPENDER_A, false]),
    );
    expect(toHex(encodeSetApprovalForAll(SPENDER_A, true))).toBe(
      nftIface.encodeFunctionData('setApprovalForAll', [SPENDER_A, true]),
    );
    expect(toHex(encodeIsApprovedForAll(OWNER, SPENDER_A))).toBe(
      nftIface.encodeFunctionData('isApprovedForAll', [OWNER, SPENDER_A]),
    );
  });

  it('revoke is approve(spender, 0) and allowance matches ethers', () => {
    expect(toHex(encodeErc20Revoke(SPENDER_A))).toBe(
      erc20Iface.encodeFunctionData('approve', [SPENDER_A, 0n]),
    );
    expect(ERC20_ALLOWANCE_SIGNATURE).toBe('allowance(address,address)');
    expect(toHex(encodeErc20Allowance(OWNER, SPENDER_A))).toBe(
      erc20Iface.encodeFunctionData('allowance', [OWNER, SPENDER_A]),
    );
  });
});

describe('blockWindows', () => {
  it('splits an inclusive range into inclusive windows', () => {
    expect(blockWindows(100n, 124n, 10n)).toEqual([
      [100n, 109n],
      [110n, 119n],
      [120n, 124n],
    ]);
    expect(blockWindows(5n, 5n, 10n)).toEqual([[5n, 5n]]);
    expect(blockWindows(0n, 9n)).toEqual([[0n, 9n]]);
  });

  it('rejects inverted ranges and non-positive windows', () => {
    expect(() => blockWindows(10n, 9n)).toThrow(/Invalid block range/);
    expect(() => blockWindows(0n, 9n, 0n)).toThrow(/positive/);
  });
});

describe('validateLog', () => {
  it('accepts a well-formed log and lowercases fields', () => {
    const log = validateLog(approvalLog(SPENDER_A, 5n, 10, 2));
    expect(log).toMatchObject({ blockNumber: 10n, logIndex: 2, address: USDC.toLowerCase() });
  });

  it('rejects reorged-out and malformed entries', () => {
    expect(validateLog(approvalLog(SPENDER_A, 5n, 10, 2, { removed: true }))).toBeNull();
    expect(validateLog(approvalLog(SPENDER_A, 5n, 10, 2, { transactionHash: '0xabc' }))).toBeNull();
    expect(validateLog(approvalLog(SPENDER_A, 5n, 10, 2, { blockNumber: null }))).toBeNull();
    expect(validateLog(approvalLog(SPENDER_A, 5n, 10, 2, { data: '0x123' }))).toBeNull();
    expect(validateLog(approvalLog(SPENDER_A, 5n, 10, 2, { topics: ['0x12'] }))).toBeNull();
    expect(validateLog(null)).toBeNull();
    expect(validateLog('log')).toBeNull();
  });
});

describe('getErc20Approvals', () => {
  it('filters by token + owner topic, windows sequentially, and keeps the latest per spender', async () => {
    const { transport, calls } = recordingTransport((_method, params) => {
      const filter = params[0] as { fromBlock: string };
      if (filter.fromBlock === '0x64') {
        // Window 100..109: two approvals for A in the same block, B once.
        return [
          approvalLog(SPENDER_A, 50n, 105, 7),
          approvalLog(SPENDER_A, 10n, 105, 3), // earlier logIndex in the same block: loses
          approvalLog(SPENDER_B, MAX_UINT256, 101, 0),
        ];
      }
      // Window 110..119: A revoked later.
      return [approvalLog(SPENDER_A, 0n, 112, 1)];
    });

    const result = await getErc20Approvals(transport, {
      owner: OWNER,
      token: USDC,
      fromBlock: 100n,
      toBlock: 119n,
      windowBlocks: 10n,
    });

    expect(calls.map((c) => c.method)).toEqual(['eth_getLogs', 'eth_getLogs']);
    expect(calls[0]!.params[0]).toEqual({
      address: USDC.toLowerCase(),
      topics: [APPROVAL_EVENT_TOPIC, topicOf(OWNER)],
      fromBlock: '0x64',
      toBlock: '0x6d',
    });
    expect(calls[1]!.params[0]).toMatchObject({ fromBlock: '0x6e', toBlock: '0x77' });

    expect(result.logsScanned).toBe(4);
    expect(result.skippedLogs).toBe(0);
    // Newest first; A's latest is the revoke in block 112.
    expect(result.approvals).toEqual([
      {
        txHash: hash(112001),
        blockNumber: 112n,
        logIndex: 1,
        token: USDC,
        owner: OWNER,
        spender: getAddress(SPENDER_A),
        value: 0n,
        unlimited: false,
      },
      expect.objectContaining({ spender: getAddress(SPENDER_B), value: MAX_UINT256, unlimited: true }),
    ]);
  });

  it('within a block, the higher logIndex wins regardless of response order', async () => {
    const { transport } = recordingTransport(() => [
      approvalLog(SPENDER_A, 99n, 50, 9),
      approvalLog(SPENDER_A, 1n, 50, 2),
    ]);
    const result = await getErc20Approvals(transport, {
      owner: OWNER,
      token: USDC,
      fromBlock: 0n,
      toBlock: 60n,
    });
    expect(result.approvals).toHaveLength(1);
    expect(result.approvals[0]).toMatchObject({ value: 99n, logIndex: 9 });
  });

  it('flags unlimited only for exactly type(uint256).max', async () => {
    const { transport } = recordingTransport(() => [
      approvalLog(SPENDER_A, MAX_UINT256 - 1n, 1, 0),
      approvalLog(SPENDER_B, MAX_UINT256, 1, 1),
    ]);
    const result = await getErc20Approvals(transport, {
      owner: OWNER,
      token: USDC,
      fromBlock: 0n,
      toBlock: 1n,
    });
    const bySpender = Object.fromEntries(result.approvals.map((a) => [a.spender, a.unlimited]));
    expect(bySpender).toEqual({ [getAddress(SPENDER_A)]: false, [getAddress(SPENDER_B)]: true });
  });

  it('skips and counts malformed, foreign, ERC-721-shaped and reorged logs', async () => {
    const good = approvalLog(SPENDER_A, 7n, 20, 0);
    const { transport } = recordingTransport(() => [
      good,
      approvalLog(SPENDER_B, 1n, 21, 0, { removed: true }),
      approvalLog(SPENDER_B, 1n, 21, 1, { address: NFT.toLowerCase() }), // different emitter
      approvalLog(SPENDER_B, 1n, 21, 2, {
        topics: [APPROVAL_EVENT_TOPIC, topicOf(SPENDER_A), topicOf(SPENDER_B)], // different owner
      }),
      approvalLog(SPENDER_B, 1n, 21, 3, {
        topics: [APPROVAL_EVENT_TOPIC, topicOf(OWNER), topicOf(SPENDER_B), word(5n)], // ERC-721 shape
        data: '0x',
      }),
      approvalLog(SPENDER_B, 1n, 21, 4, { data: word(1n) + '00'.repeat(32) }), // two words
      approvalLog(SPENDER_B, 1n, 21, 5, {
        topics: [APPROVAL_EVENT_TOPIC, topicOf(OWNER), '0x' + 'ff'.repeat(32)], // not an address topic
      }),
      { nonsense: true },
    ]);
    const result = await getErc20Approvals(transport, {
      owner: OWNER,
      token: USDC,
      fromBlock: 0n,
      toBlock: 30n,
    });
    expect(result.logsScanned).toBe(8);
    expect(result.skippedLogs).toBe(7);
    expect(result.approvals).toHaveLength(1);
    expect(result.approvals[0]).toMatchObject({ spender: getAddress(SPENDER_A), value: 7n });
  });

  it('rejects bad addresses and non-array node results', async () => {
    const { transport } = recordingTransport(() => ({ not: 'an array' }));
    await expect(
      getErc20Approvals(transport, { owner: 'nope', token: USDC, fromBlock: 0n, toBlock: 1n }),
    ).rejects.toThrow(/owner/);
    await expect(
      getErc20Approvals(transport, { owner: OWNER, token: USDC, fromBlock: 0n, toBlock: 1n }),
    ).rejects.toThrow(/non-array/);
  });
});

describe('getErc20Allowance / withCurrentAllowances', () => {
  it('reads allowance(owner, spender) via eth_call at latest', async () => {
    const { transport, calls } = recordingTransport(() => word(123_456_789n));
    expect(await getErc20Allowance(transport, USDC, OWNER, SPENDER_A)).toBe(123_456_789n);
    expect(calls[0]).toEqual({
      method: 'eth_call',
      params: [{ to: USDC, data: erc20Iface.encodeFunctionData('allowance', [OWNER, SPENDER_A]) }, 'latest'],
    });
  });

  it('throws on a non-word result instead of guessing', async () => {
    const { transport } = recordingTransport(() => '0x');
    await expect(getErc20Allowance(transport, USDC, OWNER, SPENDER_A)).rejects.toThrow(
      /returned 0 bytes/,
    );
  });

  it('attaches the on-chain value per record and reports per-record failures', async () => {
    const records = [
      {
        txHash: hash(1),
        blockNumber: 1n,
        logIndex: 0,
        token: USDC,
        owner: OWNER,
        spender: SPENDER_A,
        value: MAX_UINT256,
        unlimited: true,
      },
      {
        txHash: hash(2),
        blockNumber: 2n,
        logIndex: 0,
        token: USDC,
        owner: OWNER,
        spender: SPENDER_B,
        value: 50n,
        unlimited: false,
      },
    ];
    const { transport } = recordingTransport((_m, params) => {
      const data = (params[0] as { data: string }).data;
      // Spender A was spent down silently (no Approval event); B's read fails.
      if (data === erc20Iface.encodeFunctionData('allowance', [OWNER, SPENDER_A])) return word(40n);
      throw new Error('RPC HTTP error 429 for eth_call');
    });
    const out = await withCurrentAllowances(transport, records);
    expect(out[0]!.current).toEqual({ ok: true, allowance: 40n, unlimited: false });
    expect(out[0]!.value).toBe(MAX_UINT256); // logged value kept, never overwritten
    expect(out[1]!.current).toEqual({ ok: false, error: 'RPC HTTP error 429 for eth_call' });
  });
});

describe('operator approvals', () => {
  it('keeps the latest ApprovalForAll per operator, newest first', async () => {
    const { transport, calls } = recordingTransport(() => [
      operatorLog(SPENDER_A, true, 10, 0),
      operatorLog(SPENDER_A, false, 12, 4), // revoked later
      operatorLog(SPENDER_B, true, 11, 1),
    ]);
    const result = await getOperatorApprovals(transport, {
      owner: OWNER,
      collection: NFT,
      fromBlock: 0n,
      toBlock: 20n,
    });
    expect(calls[0]!.params[0]).toMatchObject({
      address: NFT.toLowerCase(),
      topics: [APPROVAL_FOR_ALL_EVENT_TOPIC, topicOf(OWNER)],
    });
    expect(result.skippedLogs).toBe(0);
    expect(result.approvals.map((a) => [a.operator, a.approved, a.blockNumber])).toEqual([
      [getAddress(SPENDER_A), false, 12n],
      [getAddress(SPENDER_B), true, 11n],
    ]);
    expect(result.approvals[0]!.collection).toBe(NFT);
  });

  it('skips non-boolean data words and wrong shapes', async () => {
    const { transport } = recordingTransport(() => [
      operatorLog(SPENDER_A, 2n, 10, 0), // not an ABI bool
      { ...operatorLog(SPENDER_B, true, 10, 1), data: '0x' },
      { ...operatorLog(SPENDER_B, true, 10, 2), topics: [APPROVAL_FOR_ALL_EVENT_TOPIC, topicOf(OWNER)] },
      operatorLog(SPENDER_B, true, 10, 3),
    ]);
    const result = await getOperatorApprovals(transport, {
      owner: OWNER,
      collection: NFT,
      fromBlock: 0n,
      toBlock: 20n,
    });
    expect(result.skippedLogs).toBe(3);
    expect(result.approvals).toHaveLength(1);
    expect(result.approvals[0]).toMatchObject({ operator: getAddress(SPENDER_B), approved: true });
  });

  it('reads isApprovedForAll strictly', async () => {
    const answers = [word(1n), word(0n), word(2n), '0x'];
    const { transport, calls } = recordingTransport(() => answers.shift());
    expect(await isApprovedForAll(transport, NFT, OWNER, SPENDER_A)).toBe(true);
    expect(calls[0]!.params[0]).toEqual({
      to: NFT,
      data: nftIface.encodeFunctionData('isApprovedForAll', [OWNER, SPENDER_A]),
    });
    expect(await isApprovedForAll(transport, NFT, OWNER, SPENDER_A)).toBe(false);
    await expect(isApprovedForAll(transport, NFT, OWNER, SPENDER_A)).rejects.toThrow(/non-boolean/);
    await expect(isApprovedForAll(transport, NFT, OWNER, SPENDER_A)).rejects.toThrow(/32-byte/);
  });
});
