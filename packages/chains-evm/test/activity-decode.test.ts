import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AbiCoder, Interface, getAddress, id, toBeHex, zeroPadValue } from 'ethers';
import {
  ACCOUNT_DEPLOYED_TOPIC,
  ACTIVITY_SELECTORS,
  ACTIVITY_SIGNATURES,
  PERMIT2_APPROVAL_TOPIC,
  PERMIT2_PERMIT_TOPIC,
  USER_OPERATION_EVENT_TOPIC,
  USER_OPERATION_REVERT_REASON_TOPIC,
  activitySentence,
  activityTokenContracts,
  decodeActivity,
  describeTransaction,
  formatExactUnits,
  knownContract,
} from '../src/activity-decode.js';
import type { ActivityDescription, ActivitySentenceContext } from '../src/activity-decode.js';
import { TRANSFER_EVENT_TOPIC } from '../src/asset-diff.js';
import { toHex } from '../src/encoding.js';
import { encodeKernelExecute } from '../src/kernel-account.js';
import type { JsonRpcTransport } from '../src/rpc.js';
import { ENTRYPOINT_V07 } from '../src/userop.js';

/**
 * Fixtures: the real Sepolia transactions recorded in AGENTS.md, fetched
 * once, read-only, on 2026-10-03 from https://ethereum-sepolia-rpc.publicnode.com
 * (eth_getTransactionByHash + eth_getTransactionReceipt, stored verbatim):
 *  - 0x5ab4c38b… and 0x3c55113b…: Uniswap USDC → ETH swaps (phase 6);
 *  - 0x5396a493…: Uniswap USDC → EURC swap (2026-10-02 retest);
 *  - 0xa41da70a…: the unlimited USDC approval to Permit2 (phase 5);
 *  - 0xe1892154…: the first in-app Kernel smart-account send (handleOps);
 *  - 0xbd14fbeb…: the in-app EIP-7702 upgrade bundle (type 4 + handleOps);
 *  - 0x1287e768…: the in-app EIP-7702 revoke (self-sent type 4).
 * tokens.json holds the raw symbol()/decimals() answers for Sepolia USDC
 * and EURC from the same endpoint and day.
 */

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, 'fixtures', 'activity-sepolia');
const SEPOLIA = 11155111n;
const coder = AbiCoder.defaultAbiCoder();

function fixture(prefix: string): { transaction: Record<string, unknown>; receipt: Record<string, unknown> } {
  const file = readdirSync(FIXTURES).find((f) => f.startsWith(prefix));
  if (!file) throw new Error(`no fixture ${prefix}`);
  return JSON.parse(readFileSync(join(FIXTURES, file), 'utf8'));
}

const ACCOUNT_1 = getAddress('0x772eaa1d3bef14c0bd5cee980b90db3fc680f44f');
const ACCOUNT_2 = getAddress('0xb6997390e1e3cde9bf035af75830ae00c29781fe');
const KERNEL_OF_ACCOUNT_1 = getAddress('0xd31c2c54f21684ee2026a6c41e391130bdeed8fa');
const BURN = getAddress('0x000000000000000000000000000000000000dead');
const USDC = getAddress('0x1c7d4b196cb0c7b01d743fbc6116a902379c7238');
const EURC = getAddress('0x08210f9170f89ab7658f0b5e3ff39b0e03c594d4');
const PERMIT2 = getAddress('0x000000000022d473030f116ddee9f6b43ac78ba3');
const ROUTER = getAddress('0x7e4f6c5e954da5c61b3423d81e2277431ac043f3');
const OTHER = '0x1111111111111111111111111111111111111111';
const STRANGER = '0x2222222222222222222222222222222222222222';

function tokensFromFixture(): ActivitySentenceContext['tokens'] {
  const raw = JSON.parse(readFileSync(join(FIXTURES, 'tokens.json'), 'utf8')) as {
    tokens: Record<string, Record<string, string>>;
  };
  const out: ActivitySentenceContext['tokens'] = {};
  for (const [address, calls] of Object.entries(raw.tokens)) {
    const [symbol] = coder.decode(['string'], calls['symbol()']!);
    out[address] = { symbol: symbol as string, decimals: Number(BigInt(calls['decimals()']!)), tracked: false };
  }
  return out;
}

const TOKENS = tokensFromFixture();
const ctx = (over: Partial<ActivitySentenceContext> = {}): ActivitySentenceContext => ({
  nativeSymbol: 'ETH',
  tokens: TOKENS,
  nameFor: (a) => (a.toLowerCase() === BURN.toLowerCase() ? 'Burn' : null),
  ...over,
});

function describeFixture(prefix: string, wallet: string[] = [ACCOUNT_1]): ActivityDescription {
  const f = fixture(prefix);
  return describeTransaction(f.transaction, f.receipt, { wallet, chainId: SEPOLIA });
}

describe('selectors and topics', () => {
  it('match ethers id() over the canonical signatures', () => {
    for (const [key, signature] of Object.entries(ACTIVITY_SIGNATURES)) {
      expect(ACTIVITY_SELECTORS[key as keyof typeof ACTIVITY_SELECTORS]).toBe(id(signature).slice(0, 10));
    }
    expect(ACTIVITY_SELECTORS.universalRouterExecuteWithDeadline).toBe('0x3593564c');
    expect(ACTIVITY_SELECTORS.handleOps).toBe('0x765e827f');
    expect(ACTIVITY_SELECTORS.approve).toBe('0x095ea7b3');
    expect(ACTIVITY_SELECTORS.kernelExecute).toBe('0xe9ae5c53');
    expect(USER_OPERATION_EVENT_TOPIC).toBe(id('UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)'));
    expect(USER_OPERATION_EVENT_TOPIC).toBe('0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f');
    expect(ACCOUNT_DEPLOYED_TOPIC).toBe(id('AccountDeployed(bytes32,address,address,address)'));
    expect(USER_OPERATION_REVERT_REASON_TOPIC).toBe(id('UserOperationRevertReason(bytes32,address,uint256,bytes)'));
    expect(PERMIT2_APPROVAL_TOPIC).toBe(id('Approval(address,address,address,uint160,uint48)'));
    expect(PERMIT2_PERMIT_TOPIC).toBe(id('Permit(address,address,address,uint160,uint48,uint48)'));
  });

  it('pins only the documented labels', () => {
    expect(knownContract(SEPOLIA, ROUTER.toLowerCase())?.protocol).toBe('Uniswap');
    expect(knownContract(SEPOLIA, PERMIT2)?.name).toBe('Permit2');
    expect(knownContract(SEPOLIA, ENTRYPOINT_V07)?.kind).toBe('entrypoint');
    expect(knownContract(SEPOLIA, USDC)?.symbol).toBe('USDC');
    expect(knownContract(1n, USDC)).toBeNull(); // the Sepolia token address means nothing on mainnet
    expect(knownContract(1n, ROUTER)).toBeNull(); // mainnet routers were not verified
    expect(knownContract(84532n, ENTRYPOINT_V07)).toBeNull(); // Kernel/EntryPoint labels only where verified
    expect(knownContract(SEPOLIA, OTHER)).toBeNull();
  });

  it('formats exact amounts without rounding', () => {
    expect(formatExactUnits(1_000_000n, 6)).toBe('1');
    expect(formatExactUnits(991_829n, 6)).toBe('0.991829');
    expect(formatExactUnits(41_219_674_256_619n, 18)).toBe('0.000041219674256619');
    expect(formatExactUnits(1_234_567_000_000n, 6)).toBe('1,234,567');
    expect(formatExactUnits(0n, 18)).toBe('0');
  });
});

describe('real Sepolia transactions', () => {
  it('Uniswap USDC → EURC swap (0x5396…)', () => {
    const d = describeFixture('0x5396');
    expect(d.status).toBe('success');
    expect(d.call.kind).toBe('universal-router');
    if (d.call.kind !== 'universal-router') return;
    expect(d.call.commands.map((c) => c.name)).toEqual(['V4_SWAP']);
    expect(d.call.commands[0]!.v4Actions).toEqual(['SWAP_EXACT_IN', 'SETTLE', 'TAKE']);
    expect(d.call.nativeToCaller).toBe(false);
    expect(d.call.deadline).toBe(1790953011n);
    const amounts = d.movements.map((m) => (m.change.type === 'erc20' ? [m.change.direction, m.change.token, m.change.amount] : null));
    expect(amounts).toEqual([
      ['out', USDC, 1_000_000n],
      ['in', EURC, 991_829n],
    ]);
    expect(d.counterparty).toBe(ROUTER);
    expect(activityTokenContracts(d).sort()).toEqual([EURC.toLowerCase(), USDC.toLowerCase()].sort());
    expect(activitySentence(d, ctx())).toBe('Swapped 1 USDC for 0.991829 EURC on Uniswap');
  });

  it('Uniswap USDC → ETH swaps (0x5ab4…, 0x3c55…): ETH received is named, its amount is not invented', () => {
    for (const prefix of ['0x5ab4', '0x3c55']) {
      const d = describeFixture(prefix);
      expect(d.call.kind === 'universal-router' && d.call.nativeToCaller).toBe(true);
      expect(d.movements).toHaveLength(1);
      expect(activitySentence(d, ctx())).toBe('Swapped 1 USDC for ETH on Uniswap');
      expect(activitySentence(d, ctx({ nativeSymbol: 'test ETH' }))).toBe('Swapped 1 USDC for test ETH on Uniswap');
    }
  });

  it('unlimited USDC approval to Permit2 (0xa41d…)', () => {
    const d = describeFixture('0xa41d');
    expect(d.call).toEqual({ kind: 'approve', token: USDC, spender: PERMIT2, amount: (1n << 256n) - 1n });
    expect(d.movements[0]!.change.type).toBe('erc20-approval');
    expect(activitySentence(d, ctx())).toBe('Approved USDC for Permit2 (unlimited)');
  });

  it('Kernel smart-account send through handleOps (0xe189…)', () => {
    const d = describeFixture('0xe189', [ACCOUNT_1, KERNEL_OF_ACCOUNT_1]);
    expect(d.fromWallet).toBe(false);
    expect(d.call).toEqual({ kind: 'handle-ops', entryPoint: ENTRYPOINT_V07, opCount: 1 });
    expect(d.userOps).toHaveLength(1);
    const op = d.userOps[0]!;
    expect(op.userOpHash).toBe('0x855de289bcc12e7ae159d038a8f61aad8e7ce4d091e6df65363772024e33f43b');
    expect(op.sender).toBe(KERNEL_OF_ACCOUNT_1);
    expect(op.success).toBe(true);
    expect(op.paymaster).toBeNull();
    expect(op.actualGasCost).toBe(0xcbbef59da0e8n);
    expect(op.callsGuaranteed).toBe(true);
    expect(op.calls).toEqual([
      { to: BURN, value: 100_000_000_000_000n, decoded: { kind: 'native-transfer', to: BURN, value: 100_000_000_000_000n } },
    ]);
    expect(d.counterparty).toBe(BURN);
    expect(activitySentence(d, ctx())).toBe('Smart-account operation: sent 0.0001 ETH to Burn');
    // Without the contact the address is shown.
    expect(activitySentence(d, ctx({ nameFor: () => null }))).toBe(
      'Smart-account operation: sent 0.0001 ETH to 0x0000…dEaD',
    );
    // Without the smart account in the wallet set, the bundle is someone else's.
    expect(activitySentence(describeFixture('0xe189', [ACCOUNT_1]), ctx())).toBe(
      'Smart-account bundle with 1 operation from other accounts',
    );
  });

  it('EIP-7702 upgrade bundle (0xbd14…): authorization signed by the wallet, op executed', () => {
    const d = describeFixture('0xbd14', [ACCOUNT_2]);
    expect(d.type).toBe(4);
    expect(d.authorizations).toEqual([
      {
        authority: ACCOUNT_2,
        delegate: '0xd6CEDDe84be40893d153Be9d467CD6aD37875b28',
        nonce: 0n,
        chainId: SEPOLIA,
        target: 'kernel',
        // Sponsored by the bundler: the tuple nonce cannot be checked from the transaction alone.
        effect: 'included',
      },
    ]);
    expect(d.userOps[0]!.userOpHash).toBe('0x621fb8fe841ddffe2f9fa551bf759c6fc319a1a89313d228e963795e751fd96e');
    expect(d.userOps[0]!.sender).toBe(ACCOUNT_2);
    expect(activitySentence(d, ctx())).toBe(
      'Authorized the account upgrade to Kernel v3.3 (EIP-7702); smart-account operation: sent 0.0001 ETH to 0x16DA…aC5C',
    );
  });

  it('EIP-7702 self-sent revoke (0x1287…) is proven applied', () => {
    const d = describeFixture('0x1287', [ACCOUNT_2]);
    expect(d.authorizations).toEqual([
      {
        authority: ACCOUNT_2,
        delegate: '0x0000000000000000000000000000000000000000',
        nonce: 2n,
        chainId: SEPOLIA,
        target: 'revoke',
        effect: 'applied',
      },
    ]);
    expect(activitySentence(d, ctx())).toBe('Revoked the account upgrade (EIP-7702)');
    // Another wallet sees no authorization of its own.
    expect(describeFixture('0x1287', [ACCOUNT_1]).authorizations).toEqual([]);
  });

  it('Hide amounts masks every amount but keeps tokens, names and "unlimited"', () => {
    const mask = { maskAmount: () => '••••' };
    expect(activitySentence(describeFixture('0x5396'), ctx(mask))).toBe('Swapped •••• USDC for •••• EURC on Uniswap');
    expect(activitySentence(describeFixture('0xa41d'), ctx(mask))).toBe('Approved USDC for Permit2 (unlimited)');
    expect(activitySentence(describeFixture('0xe189', [KERNEL_OF_ACCOUNT_1]), ctx(mask))).toBe(
      'Smart-account operation: sent •••• ETH to Burn',
    );
  });

  it('token labels: tracked symbol, pinned symbol, else untracked marker or raw units', () => {
    const d = describeFixture('0x5396');
    // Unknown decimals → raw base units, never guessed decimals.
    expect(activitySentence(d, ctx({ tokens: {} }))).toBe(
      'Swapped 1000000 raw units of USDC for 991829 raw units of EURC on Uniswap',
    );
    // A tracked entry's symbol wins.
    expect(
      activitySentence(d, ctx({ tokens: { ...TOKENS, [USDC.toLowerCase()]: { symbol: 'MyUSDC', decimals: 6, tracked: true } } })),
    ).toBe('Swapped 1 MyUSDC for 0.991829 EURC on Uniswap');
  });

  it('refuses a transaction from another chain and a mismatched receipt', () => {
    const f = fixture('0x5396');
    expect(() => describeTransaction(f.transaction, f.receipt, { wallet: [ACCOUNT_1], chainId: 1n })).toThrow(/chain/);
    const other = fixture('0xa41d');
    expect(() => describeTransaction(f.transaction, other.receipt, { wallet: [ACCOUNT_1], chainId: SEPOLIA })).toThrow(
      /different transaction/,
    );
  });

  it('ignores EntryPoint and Permit2 events emitted by look-alike contracts', () => {
    const f = fixture('0xe189');
    const receipt = structuredClone(f.receipt) as { logs: { address: string }[] };
    for (const log of receipt.logs) log.address = OTHER;
    const d = describeTransaction(f.transaction, receipt, { wallet: [KERNEL_OF_ACCOUNT_1], chainId: SEPOLIA });
    expect(d.userOps).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Synthetic transactions (built with ethers) for the paths no fixture covers
// ---------------------------------------------------------------------------

const word = (v: bigint) => toBeHex(v, 32);
const topicOf = (a: string) => zeroPadValue(a.toLowerCase(), 32);
const HASH = '0x' + 'ab'.repeat(32);

function syntheticTx(over: Record<string, unknown>) {
  return {
    hash: HASH,
    from: ACCOUNT_1.toLowerCase(),
    to: OTHER,
    input: '0x',
    value: '0x0',
    nonce: '0x5',
    type: '0x2',
    chainId: '0xaa36a7',
    blockNumber: '0x10',
    blockHash: '0x' + 'cd'.repeat(32),
    ...over,
  };
}
function syntheticReceipt(logs: unknown[], status = '0x1') {
  return { transactionHash: HASH, blockNumber: '0x10', blockHash: '0x' + 'cd'.repeat(32), status, logs };
}
const describe1 = (tx: unknown, receipt: unknown, wallet = [ACCOUNT_1]) =>
  describeTransaction(tx, receipt, { wallet, chainId: SEPOLIA });

const erc20 = new Interface(['function transfer(address,uint256)', 'function approve(address,uint256)']);
const permit2 = new Interface(['function approve(address,address,uint160,uint48)']);
const router = new Interface(['function execute(bytes,bytes[],uint256)']);
const entryPoint = new Interface([
  'function handleOps((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes)[],address)',
]);

function transferLog(token: string, from: string, to: string, amount: bigint) {
  return { address: token, topics: [TRANSFER_EVENT_TOPIC, topicOf(from), topicOf(to)], data: word(amount) };
}

describe('synthetic paths', () => {
  it('plain ETH send and receive', () => {
    const sent = describe1(syntheticTx({ value: '0x2386f26fc10000' }), syntheticReceipt([]));
    expect(activitySentence(sent, ctx())).toBe('Sent 0.01 ETH to 0x1111…1111');
    const received = describe1(syntheticTx({ from: STRANGER, to: ACCOUNT_1, value: '0x2386f26fc10000' }), syntheticReceipt([]));
    expect(received.counterparty).toBe(STRANGER);
    expect(activitySentence(received, ctx({ nameFor: (a) => (a === STRANGER ? 'Alice' : null) }))).toBe(
      'Received 0.01 ETH from Alice',
    );
    const toSelf = describe1(syntheticTx({ to: ACCOUNT_1, value: '0x1' }), syntheticReceipt([]));
    expect(activitySentence(toSelf, ctx())).toBe('Sent 0.000000000000000001 ETH to yourself');
  });

  it('ERC-20 transfer of an unknown token: untracked marker, logs give the amount', () => {
    const token = '0x3333333333333333333333333333333333333333';
    const tx = syntheticTx({ to: token, input: erc20.encodeFunctionData('transfer', [BURN, 5_000_000n]) });
    const d = describe1(tx, syntheticReceipt([transferLog(token, ACCOUNT_1, BURN, 5_000_000n)]));
    expect(activitySentence(d, ctx({ tokens: { [token]: { symbol: 'FOO', decimals: 6, tracked: false } } }))).toBe(
      'Sent 5 FOO (untracked token 0x3333…3333) to Burn',
    );
    expect(activitySentence(d, ctx({ tokens: {} }))).toBe('Sent 5000000 raw units of token 0x3333…3333 to Burn');
  });

  it('incoming token transfer from someone else names the sender', () => {
    const d = describe1(
      syntheticTx({ from: STRANGER, to: USDC, input: erc20.encodeFunctionData('transfer', [ACCOUNT_1, 2_500_000n]) }),
      syntheticReceipt([transferLog(USDC, STRANGER, ACCOUNT_1, 2_500_000n)]),
    );
    expect(activitySentence(d, ctx())).toBe('Received 2.5 USDC from 0x2222…2222');
  });

  it('failed transaction: calldata only, fee note', () => {
    const tx = syntheticTx({ to: USDC, input: erc20.encodeFunctionData('transfer', [BURN, 5_000_000n]) });
    const d = describe1(tx, syntheticReceipt([], '0x0'));
    expect(d.status).toBe('failed');
    expect(activitySentence(d, ctx())).toBe('Failed: tried to send 5 USDC to Burn; only the network fee was paid');
  });

  it('approval amounts: limited, revoked', () => {
    const limited = describe1(syntheticTx({ to: USDC, input: erc20.encodeFunctionData('approve', [ROUTER, 7_000_000n]) }), syntheticReceipt([]));
    expect(activitySentence(limited, ctx())).toBe('Approved USDC for Uniswap Universal Router (up to 7 USDC)');
    const revoked = describe1(syntheticTx({ to: USDC, input: erc20.encodeFunctionData('approve', [ROUTER, 0n]) }), syntheticReceipt([]));
    expect(activitySentence(revoked, ctx())).toBe('Revoked the USDC approval for Uniswap Universal Router');
  });

  it('Permit2 approve call and Permit2 events, only from the pinned address', () => {
    const max160 = (1n << 160n) - 1n;
    const tx = syntheticTx({ to: PERMIT2, input: permit2.encodeFunctionData('approve', [USDC, ROUTER, max160, 1800000000n]) });
    const approvalLog = (address: string) => ({
      address,
      topics: [PERMIT2_APPROVAL_TOPIC, topicOf(ACCOUNT_1), topicOf(USDC), topicOf(ROUTER)],
      data: coder.encode(['uint160', 'uint48'], [max160, 1800000000n]),
    });
    const d = describe1(tx, syntheticReceipt([approvalLog(PERMIT2)]));
    expect(d.permit2).toHaveLength(1);
    expect(d.permit2[0]!.unlimited).toBe(true);
    expect(activitySentence(d, ctx())).toBe(
      'Set a Permit2 allowance: Uniswap Universal Router may spend USDC (unlimited)',
    );
    // The same call to an unpinned address is just a contract call; a
    // look-alike event from it is ignored.
    const fake = describe1(syntheticTx({ to: OTHER, input: tx.input }), syntheticReceipt([approvalLog(OTHER)]));
    expect(fake.call.kind).toBe('contract-call');
    expect(fake.permit2).toEqual([]);
    expect(activitySentence(fake, ctx())).toBe('Called 0x1111…1111');
  });

  it('Universal Router: allow-revert commands prove nothing; unknown routers are plain calls', () => {
    const v4Input = coder.encode(
      ['bytes', 'bytes[]'],
      ['0x0f', [coder.encode(['address', 'uint256'], ['0x0000000000000000000000000000000000000000', 1n])]],
    );
    const sure = router.encodeFunctionData('execute', ['0x10', [v4Input], 1n]);
    const maybe = router.encodeFunctionData('execute', ['0x90', [v4Input], 1n]);
    const out = transferLog(USDC, ACCOUNT_1, OTHER, 1_000_000n);
    const a = describe1(syntheticTx({ to: ROUTER, input: sure }), syntheticReceipt([out]));
    expect(a.call.kind === 'universal-router' && a.call.nativeToCaller).toBe(true);
    expect(activitySentence(a, ctx())).toBe('Swapped 1 USDC for ETH on Uniswap');
    const b = describe1(syntheticTx({ to: ROUTER, input: maybe }), syntheticReceipt([out]));
    expect(b.call.kind === 'universal-router' && b.call.commands[0]).toMatchObject({ name: 'V4_SWAP', allowRevert: true });
    expect(activitySentence(b, ctx())).toBe('Swapped 1 USDC on Uniswap');
    const unknown = describe1(syntheticTx({ to: OTHER, input: sure }), syntheticReceipt([out]));
    expect(activitySentence(unknown, ctx())).toBe('Called 0x1111…1111: sent 1 USDC');
    // Bit 0x40 is never guessed.
    const odd = describe1(syntheticTx({ to: ROUTER, input: router.encodeFunctionData('execute', ['0x40', ['0x'], 1n]) }), syntheticReceipt([]));
    expect(odd.call.kind === 'universal-router' && odd.call.commands[0]!.name).toBe('UNKNOWN_0x40');
    expect(activitySentence(odd, ctx())).toBe('Used Uniswap Universal Router (UNKNOWN_0x40)');
  });

  function bundle(callData: string, opSuccess: boolean, extraLogs: unknown[] = []) {
    const sender = KERNEL_OF_ACCOUNT_1;
    const op = [sender, 7n, '0x', callData, '0x' + '00'.repeat(32), 0n, '0x' + '00'.repeat(32), '0x', '0x'];
    const input = entryPoint.encodeFunctionData('handleOps', [[op], OTHER]);
    const userOpHash = '0x' + '77'.repeat(32);
    const event = {
      address: ENTRYPOINT_V07,
      topics: [USER_OPERATION_EVENT_TOPIC, userOpHash, topicOf(sender), topicOf('0x0000000000000000000000000000000000000000')],
      data: coder.encode(['uint256', 'bool', 'uint256', 'uint256'], [7n, opSuccess, 1234n, 99n]),
    };
    return describe1(
      syntheticTx({ from: OTHER, to: ENTRYPOINT_V07, input }),
      syntheticReceipt([...extraLogs, event]),
      [ACCOUNT_1, sender],
    );
  }

  it('Kernel batch operation and the failed-operation wording', () => {
    const calls = [
      { to: USDC, value: 0n, data: Uint8Array.from(Buffer.from(erc20.encodeFunctionData('transfer', [BURN, 3_000_000n]).slice(2), 'hex')) },
      { to: OTHER, value: 10n ** 16n, data: new Uint8Array() },
    ];
    const callData = toHex(encodeKernelExecute(calls));
    const ok = bundle(callData, true, [transferLog(USDC, KERNEL_OF_ACCOUNT_1, BURN, 3_000_000n)]);
    expect(ok.userOps[0]!.callsGuaranteed).toBe(true);
    expect(activitySentence(ok, ctx())).toBe(
      'Smart-account operation: sent 3 USDC to Burn, sent 0.01 ETH to 0x1111…1111',
    );
    const reason = {
      address: ENTRYPOINT_V07,
      topics: [USER_OPERATION_REVERT_REASON_TOPIC, '0x' + '77'.repeat(32), topicOf(KERNEL_OF_ACCOUNT_1)],
      data: coder.encode(['uint256', 'bytes'], [7n, new Interface(['function Error(string)']).encodeFunctionData('Error', ['nope'])]),
    };
    const failed = bundle(callData, false, [reason]);
    expect(activitySentence(failed, ctx())).toBe(
      'Smart-account operation failed (reverted: nope): tried to send 3 USDC to Burn, send 0.01 ETH to 0x1111…1111',
    );
    // ERC-7579 "try" exec type: success of the operation does not prove each call.
    const tryMode = toHex(encodeKernelExecute(calls, 0x01));
    expect(activitySentence(bundle(tryMode, true), ctx())).toBe(
      'Smart-account operation (individual calls may have failed): sent 3 USDC to Burn, sent 0.01 ETH to 0x1111…1111',
    );
  });

  it('deployment and the contract address', () => {
    const created = '0x4444444444444444444444444444444444444444';
    const d = describe1(syntheticTx({ to: null, input: '0x6080' }), { ...syntheticReceipt([]), contractAddress: created });
    expect(activitySentence(d, ctx())).toBe('Deployed a contract at 0x4444…4444');
  });
});

describe('decodeActivity over a transport', () => {
  const f = fixture('0x5396');
  const hash = (f.transaction as { hash: string }).hash;
  function transport(tx: unknown, receipt: unknown): JsonRpcTransport {
    return async (method) => (method === 'eth_getTransactionByHash' ? tx : receipt);
  }
  const opts = { wallet: [ACCOUNT_1], chainId: SEPOLIA };

  it('ok, not-found, pending, receipt-unavailable', async () => {
    const ok = await decodeActivity(transport(f.transaction, f.receipt), hash, opts);
    expect(ok.status).toBe('ok');
    expect(await decodeActivity(transport(null, null), hash, opts)).toEqual({ status: 'not-found' });
    expect(await decodeActivity(transport({ ...f.transaction, blockNumber: null }, null), hash, opts)).toEqual({
      status: 'pending',
    });
    // publicnode Sepolia answered null receipts for mined transactions (2026-10-03).
    expect(await decodeActivity(transport(f.transaction, null), hash, opts)).toEqual({ status: 'receipt-unavailable' });
    expect(
      await decodeActivity(transport(f.transaction, { ...f.receipt, blockNumber: '0x1' }), hash, opts),
    ).toEqual({ status: 'receipt-unavailable' });
  });

  it('refuses a malformed hash and a different transaction', async () => {
    await expect(decodeActivity(transport(f.transaction, f.receipt), '0x1234', opts)).rejects.toThrow(/hash/);
    const other = fixture('0xa41d');
    await expect(decodeActivity(transport(other.transaction, f.receipt), hash, opts)).rejects.toThrow(/different/);
  });

  it('checksums every address it reports', () => {
    const d = describeFixture('0x5396');
    expect(d.from).toBe(getAddress(d.from));
    expect(d.to).toBe(ROUTER);
  });
});
