import { describe, expect, it } from 'vitest';
import { AbiCoder, getAddress, zeroPadValue } from 'ethers';
import {
  EIP7702_DELEGATION_LENGTH,
  EIP7702_DELEGATION_PREFIX,
  classifyRecipient,
  findCodeDeploymentBlock,
  isFirstInteraction,
  parseDelegationIndicator,
  riskSignals,
} from '../src/contract-risk.js';
import type { DeploymentSearchResult, FirstInteractionResult } from '../src/contract-risk.js';
import { MAX_UINT256 } from '../src/asset-diff.js';
import { TRANSFER_TOPIC } from '../src/erc20-logs.js';
import type { JsonRpcTransport } from '../src/rpc.js';

const coder = AbiCoder.defaultAbiCoder();
const ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const TARGET = '0x1111111111111111111111111111111111111111';
const DELEGATE = '0x63c0c19a282a1b52b07dd5a65b58948a07dae32b';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F';

const topicOf = (address: string): string => zeroPadValue(address, 32).toLowerCase();
const word = (value: bigint): string => coder.encode(['uint256'], [value]);
const hash = (n: number): string => '0x' + n.toString(16).padStart(64, '0');

function recordingTransport(respond: (method: string, params: unknown[]) => unknown) {
  const calls: { method: string; params: unknown[] }[] = [];
  const transport: JsonRpcTransport = async (method, params) => {
    calls.push({ method, params });
    return respond(method, params);
  };
  return { transport, calls };
}

describe('EIP-7702 delegation indicator', () => {
  const indicator = '0xef0100' + DELEGATE.slice(2).toLowerCase();

  it('pins the designator constants to the EIP text (0xef0100 || address, 23 bytes)', () => {
    expect(EIP7702_DELEGATION_PREFIX).toBe('0xef0100');
    expect(EIP7702_DELEGATION_LENGTH).toBe(23);
    expect((indicator.length - 2) / 2).toBe(23);
  });

  it('parses the delegate address, checksummed', () => {
    expect(parseDelegationIndicator(indicator)).toBe(getAddress(DELEGATE));
    expect(parseDelegationIndicator(indicator.toUpperCase().replace('0X', '0x'))).toBe(
      getAddress(DELEGATE),
    );
  });

  it('rejects wrong lengths and prefixes', () => {
    expect(parseDelegationIndicator(indicator + '00')).toBeNull(); // 24 bytes
    expect(parseDelegationIndicator(indicator.slice(0, -2))).toBeNull(); // 22 bytes
    expect(parseDelegationIndicator('0xef0000' + DELEGATE.slice(2))).toBeNull();
    expect(parseDelegationIndicator('0x600100' + DELEGATE.slice(2))).toBeNull();
    expect(parseDelegationIndicator('0x')).toBeNull();
  });

  it('classifies eoa / contract / delegated-eoa from eth_getCode', async () => {
    const codes: Record<string, string> = {
      [TARGET.toLowerCase()]: '0x',
      [USDC.toLowerCase()]: '0x6080604052',
      [ME.toLowerCase()]: indicator,
    };
    const { transport, calls } = recordingTransport((_m, params) => codes[(params[0] as string).toLowerCase()]);
    expect(await classifyRecipient(transport, TARGET)).toEqual({ kind: 'eoa' });
    expect(await classifyRecipient(transport, USDC)).toEqual({ kind: 'contract', codeSize: 5 });
    expect(await classifyRecipient(transport, ME)).toEqual({
      kind: 'delegated-eoa',
      delegate: getAddress(DELEGATE),
    });
    expect(calls[0]).toEqual({ method: 'eth_getCode', params: [TARGET, 'latest'] });
  });

  it('refuses malformed eth_getCode results', async () => {
    const { transport } = recordingTransport(() => 'not hex');
    await expect(classifyRecipient(transport, TARGET)).rejects.toThrow(/malformed/);
    await expect(classifyRecipient(transport, '0x123')).rejects.toThrow(/address/);
  });
});

describe('findCodeDeploymentBlock (binary search)', () => {
  function chainWithDeployment(deployedAt: bigint, latest: bigint) {
    return recordingTransport((method, params) => {
      if (method === 'eth_blockNumber') return '0x' + latest.toString(16);
      if (method === 'eth_getCode') {
        const block = BigInt(params[1] as string);
        return block >= deployedAt ? '0x6001' : '0x';
      }
      throw new Error(`unexpected ${method}`);
    });
  }

  it('finds the exact first block with code within log2 bounds', async () => {
    const latest = 24_000_000n;
    for (const deployedAt of [1n, 2n, 12_345_678n, 23_999_999n, latest]) {
      const { transport, calls } = chainWithDeployment(deployedAt, latest);
      const result = await findCodeDeploymentBlock(transport, USDC);
      expect(result).toEqual({
        firstBlockWithCode: deployedAt,
        atOrBefore: false,
        ageBlocks: latest - deployedAt,
        rpcCalls: calls.length,
      });
      // 1 eth_blockNumber + 2 end probes + ceil(log2(24e6)) = 25 at most.
      expect(calls.length).toBeLessThanOrEqual(1 + 2 + 25);
    }
  });

  it('reports atOrBefore when code exists at fromBlock', async () => {
    const { transport } = chainWithDeployment(5n, 100n);
    expect(await findCodeDeploymentBlock(transport, USDC, { fromBlock: 10n, toBlock: 100n })).toEqual({
      firstBlockWithCode: 10n,
      atOrBefore: true,
      ageBlocks: 90n,
      rpcCalls: 2,
    });
  });

  it('returns null when there is no code at toBlock and queries hex block numbers', async () => {
    const { transport, calls } = chainWithDeployment(500n, 100n);
    expect(await findCodeDeploymentBlock(transport, USDC, { toBlock: 100n })).toBeNull();
    expect(calls).toEqual([{ method: 'eth_getCode', params: [USDC, '0x64'] }]);
  });

  it('propagates node errors (e.g. pruned historical state) unchanged', async () => {
    const { transport } = recordingTransport((method, params) => {
      if (params[1] === '0x64') return '0x60';
      throw new Error('RPC error -32000: historical state unavailable (eth_getCode)');
    });
    await expect(findCodeDeploymentBlock(transport, USDC, { toBlock: 100n })).rejects.toThrow(
      /historical state/,
    );
  });

  it('rejects inverted ranges', async () => {
    const { transport } = chainWithDeployment(5n, 100n);
    await expect(
      findCodeDeploymentBlock(transport, USDC, { fromBlock: 50n, toBlock: 10n }),
    ).rejects.toThrow(/Invalid block range/);
  });
});

describe('isFirstInteraction', () => {
  function transferLog(token: string, value: bigint, block: number, logIndex: number, txHash: string) {
    return {
      transactionHash: txHash,
      blockNumber: '0x' + block.toString(16),
      logIndex: '0x' + logIndex.toString(16),
      address: token.toLowerCase(),
      topics: [TRANSFER_TOPIC, topicOf(ME), topicOf(TARGET)],
      data: word(value),
    };
  }

  it('confirms a non-zero transfer whose transaction was sent by me', async () => {
    const { transport, calls } = recordingTransport((method, params) => {
      if (method === 'eth_getLogs') return [transferLog(USDC, 5_000_000n, 990, 3, hash(1))];
      if (method === 'eth_getTransactionByHash') {
        expect(params).toEqual([hash(1)]);
        return { hash: hash(1), from: ME.toLowerCase() };
      }
      throw new Error(method);
    });
    const result = await isFirstInteraction(transport, ME, TARGET, {
      lookbackBlocks: 100n,
      toBlock: 1000n,
      tokens: [USDC],
    });
    expect(result).toEqual({
      known: true,
      evidence: 'erc20-transfer',
      match: { txHash: hash(1), blockNumber: 990n, token: USDC, value: 5_000_000n },
      scannedFromBlock: 901n,
      scannedToBlock: 1000n,
      rejectedCandidates: 0,
    });
    expect(calls[0]!.params[0]).toEqual({
      address: USDC.toLowerCase(),
      topics: [TRANSFER_TOPIC, topicOf(ME), topicOf(TARGET)],
      fromBlock: '0x385',
      toBlock: '0x3e8',
    });
  });

  it('rejects zero-value (poisoning) transfers and transfers sent by someone else', async () => {
    const { transport, calls } = recordingTransport((method) => {
      if (method === 'eth_getLogs') {
        return [
          transferLog(USDC, 0n, 999, 0, hash(1)), // zero-value spoof: no lookup made
          transferLog(DAI, 1n, 998, 0, hash(2)), // spoofed by a third party
        ];
      }
      if (method === 'eth_getTransactionByHash') return { from: TARGET };
      throw new Error(method);
    });
    const result = await isFirstInteraction(transport, ME, TARGET, {
      lookbackBlocks: 100n,
      toBlock: 1000n,
      tokens: [USDC, DAI],
    });
    expect(result).toMatchObject({ known: false, evidence: 'none', rejectedCandidates: 2 });
    expect(calls.filter((c) => c.method === 'eth_getTransactionByHash')).toHaveLength(1);
    expect((calls[0]!.params[0] as { address: string[] }).address).toEqual([
      USDC.toLowerCase(),
      DAI.toLowerCase(),
    ]);
  });

  it('walks windows newest-first, stops at the first confirmed match, and caps lookups', async () => {
    const windows: string[] = [];
    const { transport, calls } = recordingTransport((method, params) => {
      if (method === 'eth_blockNumber') return '0x3e8'; // 1000
      if (method === 'eth_getLogs') {
        const filter = params[0] as { fromBlock: string; toBlock: string };
        windows.push(`${BigInt(filter.fromBlock)}-${BigInt(filter.toBlock)}`);
        if (BigInt(filter.toBlock) === 980n) return [transferLog(USDC, 9n, 975, 0, hash(7))];
        return [];
      }
      if (method === 'eth_getTransactionByHash') return { from: ME };
      throw new Error(method);
    });
    const result = await isFirstInteraction(transport, ME, TARGET, {
      lookbackBlocks: 50n,
      windowBlocks: 10n,
    });
    expect(windows).toEqual(['991-1000', '981-990', '971-980']);
    expect(result).toMatchObject({ known: true, scannedFromBlock: 951n, scannedToBlock: 1000n });
    expect(calls[0]!.method).toBe('eth_blockNumber');
  });

  it('counts candidates beyond maxTxLookups as rejected, never as evidence', async () => {
    const { transport, calls } = recordingTransport((method) => {
      if (method === 'eth_getLogs') {
        return [1, 2, 3].map((n) => transferLog(USDC, 1n, 900 + n, 0, hash(n)));
      }
      if (method === 'eth_getTransactionByHash') return null; // e.g. a smart account's bundled tx
      throw new Error(method);
    });
    const result = await isFirstInteraction(transport, ME, TARGET, {
      lookbackBlocks: 1000n,
      toBlock: 1000n,
      maxTxLookups: 2,
    });
    expect(result).toMatchObject({ known: false, evidence: 'none', rejectedCandidates: 3 });
    expect(calls.filter((c) => c.method === 'eth_getTransactionByHash')).toHaveLength(2);
    // Wallet-wide query when no tokens are given; range clamped at block 1.
    expect(calls[0]!.params[0]).not.toHaveProperty('address');
    expect(result.scannedFromBlock).toBe(1n);
  });

  it('ignores malformed and wrong-shape logs', async () => {
    const { transport, calls } = recordingTransport((method) => {
      if (method === 'eth_getLogs') {
        return [
          { junk: true },
          { ...transferLog(USDC, 5n, 10, 0, hash(1)), topics: [TRANSFER_TOPIC, topicOf(ME), topicOf(TARGET), word(1n)], data: '0x' },
          { ...transferLog(USDC, 5n, 10, 1, hash(2)), topics: [TRANSFER_TOPIC, topicOf(TARGET), topicOf(ME)] },
        ];
      }
      throw new Error(method);
    });
    const result = await isFirstInteraction(transport, ME, TARGET, { lookbackBlocks: 10n, toBlock: 10n });
    expect(result).toMatchObject({ known: false, rejectedCandidates: 0 });
    expect(calls.map((c) => c.method)).toEqual(['eth_getLogs']);
  });

  it('validates its options', async () => {
    const { transport } = recordingTransport(() => []);
    await expect(isFirstInteraction(transport, ME, TARGET, { lookbackBlocks: 0n })).rejects.toThrow(
      /lookbackBlocks/,
    );
    await expect(
      isFirstInteraction(transport, ME, TARGET, { lookbackBlocks: 5n, toBlock: 5n, tokens: [] }),
    ).rejects.toThrow(/tokens/);
  });
});

describe('riskSignals', () => {
  const unknown: FirstInteractionResult = {
    known: false,
    evidence: 'none',
    scannedFromBlock: 0n,
    scannedToBlock: 10n,
    rejectedCandidates: 0,
  };
  const age = (ageBlocks: bigint, atOrBefore = false): DeploymentSearchResult => ({
    firstBlockWithCode: 1000n - ageBlocks,
    atOrBefore,
    ageBlocks,
    rpcCalls: 20,
  });

  it('returns nothing for empty inputs', () => {
    expect(riskSignals({})).toEqual([]);
  });

  it('flags unlimited ERC-20 approvals and operator grants, not finite or revoking ones', () => {
    const signals = riskSignals({
      assetChanges: [
        { type: 'erc20-approval', callIndex: 0, token: USDC, owner: ME, spender: TARGET, amount: MAX_UINT256, unlimited: true },
        { type: 'erc20-approval', callIndex: 0, token: USDC, owner: ME, spender: DAI, amount: 5n, unlimited: false },
        { type: 'approval-for-all', callIndex: 0, token: DAI, owner: ME, operator: TARGET, approved: true },
        { type: 'approval-for-all', callIndex: 0, token: DAI, owner: ME, operator: USDC, approved: false },
      ],
    });
    expect(signals.map((s) => [s.type, s.severity, s.subject])).toEqual([
      ['unlimited-approval', 'warning', TARGET],
      ['operator-approval', 'warning', TARGET],
    ]);
    expect(signals[0]!.message).toMatch(/ALL of this token/);
  });

  it('flags calldata to a no-code address, but not a plain transfer to an EOA', () => {
    expect(
      riskSignals({ recipient: { address: TARGET, class: { kind: 'eoa' } }, hasCalldata: true }).map((s) => s.type),
    ).toEqual(['no-code-recipient-with-calldata']);
    expect(riskSignals({ recipient: { address: TARGET, class: { kind: 'eoa' } }, hasCalldata: false })).toEqual([]);
  });

  it('notes delegated EOAs with the delegate address', () => {
    const [signal] = riskSignals({
      recipient: { address: TARGET, class: { kind: 'delegated-eoa', delegate: DELEGATE } },
      hasCalldata: true,
    });
    expect(signal).toMatchObject({ type: 'delegated-eoa', severity: 'notice' });
    expect(signal!.message).toContain(DELEGATE);
  });

  it('flags new contracts below the caller threshold only when the age is exact', () => {
    const recipient = { address: USDC, class: { kind: 'contract' as const, codeSize: 100 } };
    expect(riskSignals({ recipient, contractAge: { result: age(10n), thresholdBlocks: 100n } })[0]).toMatchObject({
      type: 'new-contract',
    });
    expect(riskSignals({ recipient, contractAge: { result: age(100n), thresholdBlocks: 100n } })).toEqual([]);
    expect(riskSignals({ recipient, contractAge: { result: age(10n, true), thresholdBlocks: 100n } })).toEqual([]);
  });

  it('turns an unknown first interaction into a hedged notice, never a "never" claim', () => {
    const [signal] = riskSignals({ firstInteraction: unknown });
    expect(signal).toMatchObject({ type: 'first-interaction-unknown', severity: 'notice' });
    expect(signal!.message).toMatch(/may be your first time/);
    expect(signal!.message).toMatch(/ETH transfers cannot be checked/);
    expect(riskSignals({ firstInteraction: { ...unknown, known: true, evidence: 'erc20-transfer' } })).toEqual([]);
  });
});
