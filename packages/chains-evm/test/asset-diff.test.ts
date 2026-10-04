import { describe, expect, it } from 'vitest';
import { AbiCoder, concat, getAddress, id, zeroPadValue } from 'ethers';
import {
  APPROVAL_EVENT_TOPIC,
  DEPOSIT_EVENT_TOPIC,
  WITHDRAWAL_EVENT_TOPIC,
  WRAPPED_NATIVE_TOKENS,
  APPROVAL_FOR_ALL_EVENT_TOPIC,
  MAX_UINT256,
  NATIVE_TRANSFER_PSEUDO_ADDRESS,
  SimulationUnsupportedError,
  TRANSFER_BATCH_EVENT_TOPIC,
  TRANSFER_EVENT_TOPIC,
  TRANSFER_SINGLE_EVENT_TOPIC,
  isMethodNotFoundError,
  parseSimulationResult,
  simulateAssetChanges,
  verifySimulationSupport,
} from '../src/asset-diff.js';
import type { JsonRpcTransport } from '../src/rpc.js';

/**
 * Fixtures follow the eth_simulateV1 result schema in ethereum/execution-apis
 * (src/schemas/execute.yaml: EthSimulateBlockResultSingleSuccess, CallResults)
 * and the shapes observed live on 2026-09-28 (geth-based publicnode + Alchemy):
 * success calls carry logs[]; a reverted call carries status "0x0",
 * returnData "0x" and the revert payload in error.data.
 */

const coder = AbiCoder.defaultAbiCoder();
const ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const OTHER = '0x1111111111111111111111111111111111111111';
const SPENDER = '0x2222222222222222222222222222222222222222';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const NFT = '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D';

const topicOf = (address: string): string => zeroPadValue(address, 32).toLowerCase();
const word = (value: bigint): string => coder.encode(['uint256'], [value]);

function log(address: string, topics: string[], data = '0x') {
  return { address: address.toLowerCase(), topics, data, logIndex: '0x0', blockNumber: '0x1' };
}

function okCall(logs: unknown[], gasUsed = '0x5208') {
  return { returnData: '0x', logs, gasUsed, maxUsedGas: gasUsed, status: '0x1' };
}

function block(calls: unknown[]) {
  return [{ number: '0x1', baseFeePerGas: '0x0', calls }];
}

function fakeTransport(respond: (method: string, params: unknown[]) => unknown): {
  transport: JsonRpcTransport;
  calls: { method: string; params: unknown[] }[];
} {
  const calls: { method: string; params: unknown[] }[] = [];
  return {
    calls,
    transport: async (method, params) => {
      calls.push({ method, params });
      return respond(method, params);
    },
  };
}

describe('event topics', () => {
  it('are keccak256 of the canonical signatures (pinned against ethers id())', () => {
    expect(TRANSFER_EVENT_TOPIC).toBe(id('Transfer(address,address,uint256)'));
    expect(APPROVAL_EVENT_TOPIC).toBe(id('Approval(address,address,uint256)'));
    expect(APPROVAL_FOR_ALL_EVENT_TOPIC).toBe(id('ApprovalForAll(address,address,bool)'));
    expect(TRANSFER_SINGLE_EVENT_TOPIC).toBe(
      id('TransferSingle(address,address,address,uint256,uint256)'),
    );
    expect(TRANSFER_BATCH_EVENT_TOPIC).toBe(
      id('TransferBatch(address,address,address,uint256[],uint256[])'),
    );
  });

  it('matches the Transfer and Approval topics observed on live nodes', () => {
    // Seen in live eth_simulateV1 responses for USDC transfer/approve.
    expect(TRANSFER_EVENT_TOPIC).toBe(
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
    );
    expect(APPROVAL_EVENT_TOPIC).toBe(
      '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925',
    );
  });
});

describe('simulateAssetChanges request', () => {
  it('sends the specified payload: one block, traceTransfers, input field, latest', async () => {
    const { transport, calls } = fakeTransport(() => block([okCall([])]));
    await simulateAssetChanges(
      transport,
      [{ from: ME, to: USDC, value: 5n, data: new Uint8Array([0xa9, 0x05, 0x9c, 0xbb]) }],
      ME,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('eth_simulateV1');
    expect(calls[0]!.params).toEqual([
      {
        blockStateCalls: [{ calls: [{ from: ME, to: USDC, value: '0x5', input: '0xa9059cbb' }] }],
        traceTransfers: true,
      },
      'latest',
    ]);
    // validation stays at its default (false): the key is not sent at all.
    expect('validation' in (calls[0]!.params[0] as object)).toBe(false);
  });

  it('omits input for empty calldata and honours a custom block tag', async () => {
    const { transport, calls } = fakeTransport(() => block([okCall([])]));
    await simulateAssetChanges(transport, [{ from: ME, to: OTHER, value: 0n, data: new Uint8Array() }], ME, {
      blockTag: '0x10',
    });
    const payload = calls[0]!.params[0] as { blockStateCalls: { calls: Record<string, string>[] }[] };
    expect(payload.blockStateCalls[0]!.calls[0]).toEqual({ from: ME, to: OTHER, value: '0x0' });
    expect(calls[0]!.params[1]).toBe('0x10');
  });
});

describe('decoding', () => {
  it('native ETH pseudo-Transfer from 0xeeee… with exact wei (no float)', async () => {
    const wei = 123456789012345678901234567n; // > 2^53, must survive exactly
    const { transport } = fakeTransport(() =>
      block([
        okCall([
          log(NATIVE_TRANSFER_PSEUDO_ADDRESS, [TRANSFER_EVENT_TOPIC, topicOf(ME), topicOf(OTHER)], word(wei)),
        ]),
      ]),
    );
    const result = await simulateAssetChanges(transport, [{ from: ME, to: OTHER, value: wei }], ME);
    expect(result.ok).toBe(true);
    expect(result.skippedLogs).toBe(0);
    expect(result.changes).toEqual([
      { type: 'native', callIndex: 0, direction: 'out', from: getAddress(ME), to: getAddress(OTHER), amount: wei },
    ]);
  });

  it('ERC-20 Transfer (3 topics, 32-byte data) in and out, token checksummed', () => {
    const result = parseSimulationResult(
      block([
        okCall([
          log(USDC, [TRANSFER_EVENT_TOPIC, topicOf(ME), topicOf(OTHER)], word(1_000_000n)),
          log(USDC, [TRANSFER_EVENT_TOPIC, topicOf(OTHER), topicOf(ME)], word(3_412_180_000n)),
        ]),
      ]),
      1,
      ME,
    );
    expect(result.changes).toEqual([
      { type: 'erc20', callIndex: 0, direction: 'out', token: USDC, from: ME, to: getAddress(OTHER), amount: 1_000_000n },
      { type: 'erc20', callIndex: 0, direction: 'in', token: USDC, from: getAddress(OTHER), to: ME, amount: 3_412_180_000n },
    ]);
  });

  it('ERC-721 Transfer (4 topics, tokenId in topic3, empty data) is told apart from ERC-20', () => {
    const result = parseSimulationResult(
      block([okCall([log(NFT, [TRANSFER_EVENT_TOPIC, topicOf(ME), topicOf(OTHER), word(1234n)])])]),
      1,
      ME,
    );
    expect(result.changes).toEqual([
      { type: 'erc721', callIndex: 0, direction: 'out', token: NFT, from: ME, to: getAddress(OTHER), tokenId: 1234n },
    ]);
  });

  it('self-transfers are direction self; unrelated transfers are dropped', () => {
    const result = parseSimulationResult(
      block([
        okCall([
          log(USDC, [TRANSFER_EVENT_TOPIC, topicOf(ME), topicOf(ME)], word(7n)),
          log(USDC, [TRANSFER_EVENT_TOPIC, topicOf(OTHER), topicOf(SPENDER)], word(9n)),
        ]),
      ]),
      1,
      ME,
    );
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({ type: 'erc20', direction: 'self', amount: 7n });
    expect(result.skippedLogs).toBe(0);
  });

  it('ERC-20 Approval: max uint256 is flagged unlimited; a finite amount is not', () => {
    const result = parseSimulationResult(
      block([
        okCall([
          log(USDC, [APPROVAL_EVENT_TOPIC, topicOf(ME), topicOf(SPENDER)], word(MAX_UINT256)),
          log(USDC, [APPROVAL_EVENT_TOPIC, topicOf(ME), topicOf(SPENDER)], word(5n)),
          // Someone else's approval is not the wallet's business.
          log(USDC, [APPROVAL_EVENT_TOPIC, topicOf(OTHER), topicOf(ME)], word(MAX_UINT256)),
        ]),
      ]),
      1,
      ME,
    );
    expect(result.changes).toEqual([
      { type: 'erc20-approval', callIndex: 0, token: USDC, owner: ME, spender: getAddress(SPENDER), amount: MAX_UINT256, unlimited: true },
      { type: 'erc20-approval', callIndex: 0, token: USDC, owner: ME, spender: getAddress(SPENDER), amount: 5n, unlimited: false },
    ]);
    expect(MAX_UINT256).toBe(2n ** 256n - 1n);
  });

  it('ERC-721 single-token Approval (4 topics)', () => {
    const result = parseSimulationResult(
      block([okCall([log(NFT, [APPROVAL_EVENT_TOPIC, topicOf(ME), topicOf(SPENDER), word(42n)])])]),
      1,
      ME,
    );
    expect(result.changes).toEqual([
      { type: 'erc721-approval', callIndex: 0, token: NFT, owner: ME, approved: getAddress(SPENDER), tokenId: 42n },
    ]);
  });

  it('ApprovalForAll grant and revoke; a non-bool data word is skipped', () => {
    const result = parseSimulationResult(
      block([
        okCall([
          log(NFT, [APPROVAL_FOR_ALL_EVENT_TOPIC, topicOf(ME), topicOf(SPENDER)], word(1n)),
          log(NFT, [APPROVAL_FOR_ALL_EVENT_TOPIC, topicOf(ME), topicOf(SPENDER)], word(0n)),
          log(NFT, [APPROVAL_FOR_ALL_EVENT_TOPIC, topicOf(ME), topicOf(SPENDER)], word(2n)),
        ]),
      ]),
      1,
      ME,
    );
    expect(result.changes).toEqual([
      { type: 'approval-for-all', callIndex: 0, token: NFT, owner: ME, operator: getAddress(SPENDER), approved: true },
      { type: 'approval-for-all', callIndex: 0, token: NFT, owner: ME, operator: getAddress(SPENDER), approved: false },
    ]);
    expect(result.skippedLogs).toBe(1);
  });

  it('ERC-1155 TransferSingle and TransferBatch (ABI arrays built by ethers)', () => {
    const single = coder.encode(['uint256', 'uint256'], [7n, 5n]);
    const batch = coder.encode(['uint256[]', 'uint256[]'], [[1n, 2n, 3n], [10n, 20n, 2n ** 200n]]);
    const result = parseSimulationResult(
      block([
        okCall([
          log(NFT, [TRANSFER_SINGLE_EVENT_TOPIC, topicOf(SPENDER), topicOf(OTHER), topicOf(ME)], single),
          log(NFT, [TRANSFER_BATCH_EVENT_TOPIC, topicOf(SPENDER), topicOf(ME), topicOf(OTHER)], batch),
        ]),
      ]),
      1,
      ME,
    );
    expect(result.changes.map((c) => c.type)).toEqual(['erc1155', 'erc1155', 'erc1155', 'erc1155']);
    expect(result.changes[0]).toEqual({
      type: 'erc1155',
      callIndex: 0,
      direction: 'in',
      token: NFT,
      operator: getAddress(SPENDER),
      from: getAddress(OTHER),
      to: ME,
      tokenId: 7n,
      amount: 5n,
    });
    expect(result.changes.slice(1).map((c) => (c.type === 'erc1155' ? [c.direction, c.tokenId, c.amount] : null))).toEqual([
      ['out', 1n, 10n],
      ['out', 2n, 20n],
      ['out', 3n, 2n ** 200n],
    ]);
  });

  it('skips malformed and foreign-shaped logs without crashing or misattributing', () => {
    const badBatch = concat([
      word(64n), // ids offset
      word(160n), // values offset
      word(2n), // ids length 2
      word(1n),
      word(2n),
      word(3n), // values length 3 (mismatch)
      word(1n),
      word(1n),
      word(1n),
    ]);
    const dirtyTopic = '0x' + 'ff'.repeat(12) + ME.slice(2).toLowerCase(); // non-zero padding
    const result = parseSimulationResult(
      block([
        okCall([
          'not a log',
          { address: 'zz', topics: [], data: '0x' },
          log(USDC, [TRANSFER_EVENT_TOPIC, topicOf(ME), topicOf(OTHER)], '0x1234'), // short data
          log(USDC, [TRANSFER_EVENT_TOPIC], concat([topicOf(ME), topicOf(OTHER), word(1n)])), // CryptoKitties-style unindexed
          log(USDC, [TRANSFER_EVENT_TOPIC, dirtyTopic, topicOf(OTHER)], word(1n)),
          log(NATIVE_TRANSFER_PSEUDO_ADDRESS, [TRANSFER_EVENT_TOPIC, topicOf(ME), topicOf(OTHER), word(1n)]),
          log(NFT, [TRANSFER_BATCH_EVENT_TOPIC, topicOf(ME), topicOf(ME), topicOf(OTHER)], badBatch),
          log(NFT, [TRANSFER_SINGLE_EVENT_TOPIC, topicOf(ME), topicOf(ME), topicOf(OTHER)], word(1n)),
          log(USDC, [id('Swap(address,uint256)'), topicOf(ME)], word(1n)), // unknown event: ignored
          log(USDC, [], '0x'), // anonymous event: ignored
          log(USDC, [TRANSFER_EVENT_TOPIC, topicOf(ME), topicOf(OTHER)], word(99n)), // the one valid log
        ]),
      ]),
      1,
      ME,
    );
    expect(result.changes).toEqual([
      { type: 'erc20', callIndex: 0, direction: 'out', token: USDC, from: ME, to: getAddress(OTHER), amount: 99n },
    ]);
    expect(result.skippedLogs).toBe(8);
  });
});

describe('call outcomes', () => {
  it('reverted call: reason decoded from error.data (geth shape), logs discarded', async () => {
    const revert = concat(['0x08c379a0', coder.encode(['string'], ['ERC20: transfer amount exceeds balance'])]);
    const { transport } = fakeTransport(() =>
      block([
        {
          returnData: '0x',
          logs: [log(USDC, [TRANSFER_EVENT_TOPIC, topicOf(ME), topicOf(OTHER)], word(1n))],
          gasUsed: '0x8da9',
          status: '0x0',
          error: { code: 3, message: 'execution reverted: ERC20: transfer amount exceeds balance', data: revert },
        },
      ]),
    );
    const result = await simulateAssetChanges(transport, [{ from: ME, to: USDC }], ME);
    expect(result.ok).toBe(false);
    expect(result.calls).toEqual([
      { ok: false, gasUsed: 0x8da9n, revertReason: 'reverted: ERC20: transfer amount exceeds balance' },
    ]);
    expect(result.changes).toEqual([]);
  });

  it('reverted call: reason from returnData (spec shape), else error.message, else a default', () => {
    const panic = concat(['0x4e487b71', coder.encode(['uint256'], [0x11n])]);
    const result = parseSimulationResult(
      block([
        { returnData: panic, gasUsed: '0x1', status: '0x0', error: { code: 3, message: 'execution reverted' } },
        { returnData: '0x', gasUsed: '0x1', status: '0x0', error: { code: -32015, message: 'vm execution error: out of gas' } },
        { returnData: '0x', gasUsed: '0x1', status: '0x0' },
        okCall([]),
      ]),
      4,
      ME,
    );
    expect(result.calls.map((c) => c.revertReason)).toEqual([
      'panic: arithmetic overflow or underflow',
      'vm execution error: out of gas',
      'reverted without a reason',
      undefined,
    ]);
    expect(result.calls[3]).toEqual({ ok: true, gasUsed: 0x5208n });
    expect(result.ok).toBe(false);
  });

  it('attributes changes to the right call index across several calls', () => {
    const result = parseSimulationResult(
      block([
        okCall([log(USDC, [APPROVAL_EVENT_TOPIC, topicOf(ME), topicOf(SPENDER)], word(10n))]),
        okCall([log(USDC, [TRANSFER_EVENT_TOPIC, topicOf(ME), topicOf(SPENDER)], word(10n))]),
      ]),
      2,
      ME,
    );
    expect(result.changes.map((c) => [c.type, c.callIndex])).toEqual([
      ['erc20-approval', 0],
      ['erc20', 1],
    ]);
  });
});

describe('malformed responses and errors', () => {
  const cases: [string, unknown][] = [
    ['null', null],
    ['object instead of array', { calls: [] }],
    ['empty array', []],
    ['block without calls', [{ number: '0x1' }]],
    ['wrong call count', block([okCall([]), okCall([])])],
    ['call without status', block([{ returnData: '0x', logs: [] }])],
    ['status 0x2', block([{ ...okCall([]), status: '0x2' }])],
    ['success without logs', block([{ returnData: '0x', gasUsed: '0x1', status: '0x1' }])],
  ];
  for (const [name, response] of cases) {
    it(`rejects ${name} as malformed-response`, async () => {
      const { transport } = fakeTransport(() => response);
      const error = await simulateAssetChanges(transport, [{ from: ME, to: OTHER }], ME).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SimulationUnsupportedError);
      expect((error as SimulationUnsupportedError).reason).toBe('malformed-response');
    });
  }

  it('maps method-not-found errors to SimulationUnsupportedError', async () => {
    const shapes: unknown[] = [
      Object.assign(new Error('Method not found'), { code: -32601 }),
      new Error('RPC error -32601: Method not found (eth_simulateV1)'),
      new Error('RPC error -32600: Unsupported method: eth_simulateV1 on ETH_MAINNET (eth_simulateV1)'),
      new Error('the method eth_simulateV1 does not exist/is not available'),
    ];
    for (const shape of shapes) {
      const transport: JsonRpcTransport = async () => {
        throw shape;
      };
      const error = await simulateAssetChanges(transport, [{ from: ME, to: OTHER }], ME).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SimulationUnsupportedError);
      expect((error as SimulationUnsupportedError).reason).toBe('method-not-found');
      expect((error as Error).message).toBe('This RPC endpoint does not support eth_simulateV1.');
    }
  });

  it('passes every other error through unchanged (e.g. -38014 insufficient funds)', async () => {
    const original = new Error('RPC error -38014: insufficient funds for gas * price + value: have 0 want 1 (eth_simulateV1)');
    const transport: JsonRpcTransport = async () => {
      throw original;
    };
    await expect(simulateAssetChanges(transport, [{ from: ME, to: OTHER }], ME)).rejects.toBe(original);
    expect(isMethodNotFoundError(original)).toBe(false);
    expect(isMethodNotFoundError(new Error('RPC HTTP error 429 for eth_simulateV1'))).toBe(false);
  });

  it('refuses empty call lists and non-address wallets before any request', async () => {
    const { transport, calls } = fakeTransport(() => block([]));
    await expect(simulateAssetChanges(transport, [], ME)).rejects.toThrow(/no calls/);
    await expect(simulateAssetChanges(transport, [{ from: ME, to: OTHER }], 'me')).rejects.toThrow(/Not an address/);
    expect(calls).toHaveLength(0);
  });
});

describe('verifySimulationSupport', () => {
  it('supported when a well-formed result comes back', async () => {
    const { transport, calls } = fakeTransport(() => block([okCall([])]));
    await expect(verifySimulationSupport(transport)).resolves.toEqual({ supported: true });
    expect(calls[0]!.method).toBe('eth_simulateV1');
  });

  it('unsupported on method-not-found or a malformed response', async () => {
    const notFound: JsonRpcTransport = async () => {
      throw Object.assign(new Error('Method not found'), { code: -32601 });
    };
    await expect(verifySimulationSupport(notFound)).resolves.toEqual({
      supported: false,
      reason: 'This RPC endpoint does not support eth_simulateV1.',
    });
    const { transport } = fakeTransport(() => ({ hello: 'world' }));
    const verdict = await verifySimulationSupport(transport);
    expect(verdict.supported).toBe(false);
  });

  it('surfaces other failures instead of guessing', async () => {
    const down: JsonRpcTransport = async () => {
      throw new Error('fetch failed');
    };
    await expect(verifySimulationSupport(down)).rejects.toThrow('fetch failed');
  });
});

describe('wrapped ether (WETH9 Deposit / Withdrawal, finding F5)', () => {
  const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
  const SEPOLIA_WETH = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14';
  const OP_WETH = '0x4200000000000000000000000000000000000006';
  const ZERO = '0x0000000000000000000000000000000000000000';
  const wad = 100000000000000000n; // 0.1 ETH
  const ethOut = (to: string, amount = wad) =>
    log(NATIVE_TRANSFER_PSEUDO_ADDRESS, [TRANSFER_EVENT_TOPIC, topicOf(ME), topicOf(to)], word(amount));
  const ethIn = (from: string, amount = wad) =>
    log(NATIVE_TRANSFER_PSEUDO_ADDRESS, [TRANSFER_EVENT_TOPIC, topicOf(from), topicOf(ME)], word(amount));
  const deposit = (emitter: string, dst: string, amount = wad) =>
    log(emitter, [DEPOSIT_EVENT_TOPIC, topicOf(dst)], word(amount));
  const withdrawal = (emitter: string, src: string, amount = wad) =>
    log(emitter, [WITHDRAWAL_EVENT_TOPIC, topicOf(src)], word(amount));

  it('topics are keccak256 of the WETH9 declarations (pinned against ethers id())', () => {
    // WETH9.sol (gnosis/canonical-weth 0dd1ea3e): event Deposit(address indexed dst, uint wad);
    // event Withdrawal(address indexed src, uint wad).
    expect(DEPOSIT_EVENT_TOPIC).toBe(id('Deposit(address,uint256)'));
    expect(WITHDRAWAL_EVENT_TOPIC).toBe(id('Withdrawal(address,uint256)'));
    expect(DEPOSIT_EVENT_TOPIC).toBe('0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c');
    expect(WITHDRAWAL_EVENT_TOPIC).toBe('0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65');
  });

  it('pins mainnet, Sepolia and OP-stack WETH (lowercase)', () => {
    expect(WRAPPED_NATIVE_TOKENS).toEqual([WETH, SEPOLIA_WETH, OP_WETH].map((a) => a.toLowerCase()));
  });

  it('a wrap shows the ether out AND the WETH in (was: ether out only)', () => {
    const result = parseSimulationResult(block([okCall([ethOut(WETH), deposit(WETH, ME)])]), 1, ME);
    expect(result.skippedLogs).toBe(0);
    expect(result.changes).toEqual([
      { type: 'native', callIndex: 0, direction: 'out', from: getAddress(ME), to: WETH, amount: wad },
      {
        type: 'erc20',
        callIndex: 0,
        direction: 'in',
        token: WETH,
        from: ZERO,
        to: getAddress(ME),
        amount: wad,
        wrap: 'deposit',
      },
    ]);
  });

  it('an unwrap shows the WETH out and the ether in', () => {
    const result = parseSimulationResult(block([okCall([ethIn(OP_WETH), withdrawal(OP_WETH, ME)])]), 1, ME);
    expect(result.changes).toEqual([
      { type: 'native', callIndex: 0, direction: 'in', from: OP_WETH, to: getAddress(ME), amount: wad },
      {
        type: 'erc20',
        callIndex: 0,
        direction: 'out',
        token: OP_WETH,
        from: getAddress(ME),
        to: ZERO,
        amount: wad,
        wrap: 'withdrawal',
      },
    ]);
  });

  it('is not decoded without the matching ether movement (amount, direction or another call)', () => {
    const differentAmount = parseSimulationResult(block([okCall([ethOut(WETH, wad - 1n), deposit(WETH, ME)])]), 1, ME);
    expect(differentAmount.changes.filter((c) => c.type === 'erc20')).toEqual([]);
    const wrongDirection = parseSimulationResult(block([okCall([ethIn(WETH), deposit(WETH, ME)])]), 1, ME);
    expect(wrongDirection.changes.filter((c) => c.type === 'erc20')).toEqual([]);
    const otherCall = parseSimulationResult(block([okCall([ethOut(WETH)]), okCall([deposit(WETH, ME)])]), 2, ME);
    expect(otherCall.changes.filter((c) => c.type === 'erc20')).toEqual([]);
    // A receipt (activity-decode.ts) has no pseudo-events: nothing changes there.
    const receiptLike = parseSimulationResult(block([okCall([deposit(WETH, ME)])]), 1, ME);
    expect(receiptLike.changes).toEqual([]);
    expect(receiptLike.skippedLogs).toBe(0);
  });

  it('one ether movement backs one event only', () => {
    const result = parseSimulationResult(block([okCall([ethOut(WETH), deposit(WETH, ME), deposit(WETH, ME)])]), 1, ME);
    expect(result.changes.filter((c) => c.type === 'erc20')).toHaveLength(1);
  });

  it('a contract outside the pinned list is ignored even with the same shape (e.g. a multisig Deposit)', () => {
    const MULTISIG = '0x3333333333333333333333333333333333333333';
    const result = parseSimulationResult(block([okCall([ethOut(MULTISIG), deposit(MULTISIG, ME)])]), 1, ME);
    expect(result.changes).toEqual([
      { type: 'native', callIndex: 0, direction: 'out', from: getAddress(ME), to: MULTISIG, amount: wad },
    ]);
    expect(result.skippedLogs).toBe(0);
    // ...unless the caller lists it, and an empty list turns the decoding off.
    const listed = parseSimulationResult(block([okCall([ethOut(MULTISIG), deposit(MULTISIG, ME)])]), 1, ME, {
      wrappedNativeTokens: [MULTISIG],
    });
    expect(listed.changes.some((c) => c.type === 'erc20' && c.wrap === 'deposit')).toBe(true);
    const off = parseSimulationResult(block([okCall([ethOut(WETH), deposit(WETH, ME)])]), 1, ME, { wrappedNativeTokens: [] });
    expect(off.changes.some((c) => c.type === 'erc20')).toBe(false);
  });

  it('a deposit for someone else is ignored', () => {
    const result = parseSimulationResult(block([okCall([ethOut(WETH), deposit(WETH, OTHER)])]), 1, ME);
    expect(result.changes.filter((c) => c.type === 'erc20')).toEqual([]);
  });

  it('a wrapper that also emits a mint / burn Transfer is counted once', () => {
    const mint = log(WETH, [TRANSFER_EVENT_TOPIC, topicOf(ZERO), topicOf(ME)], word(wad));
    const minted = parseSimulationResult(block([okCall([ethOut(WETH), mint, deposit(WETH, ME)])]), 1, ME);
    expect(minted.changes.filter((c) => c.type === 'erc20')).toEqual([
      { type: 'erc20', callIndex: 0, direction: 'in', token: WETH, from: ZERO, to: getAddress(ME), amount: wad },
    ]);
    const burn = log(WETH, [TRANSFER_EVENT_TOPIC, topicOf(ME), topicOf(ZERO)], word(wad));
    const burned = parseSimulationResult(block([okCall([burn, ethIn(WETH), withdrawal(WETH, ME)])]), 1, ME);
    expect(burned.changes.filter((c) => c.type === 'erc20')).toHaveLength(1);
    expect(burned.changes.find((c) => c.type === 'erc20')).not.toHaveProperty('wrap');
  });

  it('non-standard shapes from a pinned wrapper are skipped and counted, never guessed', () => {
    const extraTopic = log(WETH, [DEPOSIT_EVENT_TOPIC, topicOf(ME), topicOf(OTHER)], word(wad));
    const shortData = log(WETH, [DEPOSIT_EVENT_TOPIC, topicOf(ME)], '0x01');
    const badAddress = log(WETH, [WITHDRAWAL_EVENT_TOPIC, '0x' + 'f'.repeat(64)], word(wad));
    const result = parseSimulationResult(block([okCall([ethOut(WETH), extraTopic, shortData, badAddress])]), 1, ME);
    expect(result.skippedLogs).toBe(3);
    expect(result.changes.filter((c) => c.type === 'erc20')).toEqual([]);
  });

  it('a reverted wrap shows nothing', () => {
    const result = parseSimulationResult(
      block([{ status: '0x0', returnData: '0x', gasUsed: '0x5208', logs: [ethOut(WETH), deposit(WETH, ME)] }]),
      1,
      ME,
    );
    expect(result.changes).toEqual([]);
  });

  it('simulateAssetChanges passes the option through', async () => {
    const { transport } = fakeTransport(() => block([okCall([ethOut(WETH), deposit(WETH, ME)])]));
    const def = await simulateAssetChanges(transport, [{ from: ME, to: WETH, value: wad }], ME);
    expect(def.changes.some((c) => c.type === 'erc20' && c.wrap === 'deposit')).toBe(true);
    const off = await simulateAssetChanges(transport, [{ from: ME, to: WETH, value: wad }], ME, { wrappedNativeTokens: [] });
    expect(off.changes.some((c) => c.type === 'erc20')).toBe(false);
  });
});
