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

  it('a caller-pinned staking token: "(pinned staking token)" when untracked, plain when tracked, unchanged without the flag', () => {
    // Lido's stETH on Ethereum Sepolia, pinned by the app from Lido's deployment list.
    const stEth = '0x3e3fe7dbc6b4c189e7128855dd526361c49b40af';
    const tx = syntheticTx({ to: stEth, input: erc20.encodeFunctionData('transfer', [BURN, 10n ** 15n]) });
    const d = describe1(tx, syntheticReceipt([transferLog(stEth, ACCOUNT_1, BURN, 10n ** 15n)]));
    expect(
      activitySentence(d, ctx({ tokens: { [stEth]: { symbol: 'stETH', decimals: 18, tracked: false, pinned: true } } })),
    ).toBe('Sent 0.001 stETH (pinned staking token) to Burn');
    expect(
      activitySentence(d, ctx({ tokens: { [stEth]: { symbol: 'stETH', decimals: 18, tracked: true, pinned: true } } })),
    ).toBe('Sent 0.001 stETH to Burn');
    expect(activitySentence(d, ctx({ tokens: { [stEth]: { symbol: 'stETH', decimals: 18, tracked: false } } }))).toBe(
      'Sent 0.001 stETH (untracked token 0x3e3F…40Af) to Burn',
    );
    // pinned: false behaves exactly like an absent flag.
    expect(
      activitySentence(d, ctx({ tokens: { [stEth]: { symbol: 'stETH', decimals: 18, tracked: false, pinned: false } } })),
    ).toBe('Sent 0.001 stETH (untracked token 0x3e3F…40Af) to Burn');
    // A pinned flag with no readable symbol falls through to the raw label.
    expect(
      activitySentence(d, ctx({ tokens: { [stEth]: { symbol: null, decimals: 18, tracked: false, pinned: true } } })),
    ).toBe('Sent 0.001 token 0x3e3F…40Af to Burn');
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

// ---------------------------------------------------------------------------
// EIP-7708 (Sepolia since 2026-10-06): receipts carry the protocol's
// ETH-transfer logs from 0xff…fe. They must never become a token movement,
// and Activity must read exactly as before the fork.
// ---------------------------------------------------------------------------

describe('EIP-7708 ETH-transfer logs in receipts', () => {
  const SYSTEM = '0xfffffffffffffffffffffffffffffffffffffffe';
  const DEV_EOA = getAddress('0x16da2caeada26516f919c6872f6c38ab378cac5c');
  const SEPOLIA_WETH = '0xfff9976782d46cc05630d1f6ebab18b2324d6b14';
  const ethLog = (from: string, to: string, amount: bigint) => ({
    address: SYSTEM,
    topics: [TRANSFER_EVENT_TOPIC, topicOf(from), topicOf(to)],
    data: word(amount),
  });

  it('the live funding receipt (0x0293…, block 11880421): no token row, ETH from the transaction value', () => {
    const f = fixture('0x0293');
    expect((f.receipt.logs as { address: string }[])[0]!.address).toBe(SYSTEM);
    const received = describeFixture('0x0293', [KERNEL_OF_ACCOUNT_1]);
    expect(received.movements).toEqual([]);
    expect(received.skippedLogs).toBe(0);
    expect(activityTokenContracts(received)).toEqual([]);
    expect(received.call).toEqual({ kind: 'native-transfer', to: KERNEL_OF_ACCOUNT_1, value: 10_000_000_000_000_000n });
    expect(activitySentence(received, ctx())).toBe('Received 0.01 ETH from 0x16DA…aC5C');
    const sent = describeFixture('0x0293', [DEV_EOA]);
    expect(sent.movements).toEqual([]);
    expect(activitySentence(sent, ctx())).toBe('Sent 0.01 ETH to 0xD31c…D8FA');
  });

  it('a plain send reads the same with or without the protocol log', () => {
    const tx = syntheticTx({ value: '0x2386f26fc10000' });
    const before = describe1(tx, syntheticReceipt([]));
    const after = describe1(tx, syntheticReceipt([ethLog(ACCOUNT_1, OTHER, 10_000_000_000_000_000n)]));
    expect(after.movements).toEqual([]);
    expect(activitySentence(after, ctx())).toBe(activitySentence(before, ctx()));
    expect(activitySentence(after, ctx())).toBe('Sent 0.01 ETH to 0x1111…1111');
  });

  it('a WETH deposit receipt is unchanged by the fork (wrap decoding stays off for receipts)', () => {
    const deposit = { address: SEPOLIA_WETH, topics: [id('Deposit(address,uint256)'), topicOf(ACCOUNT_1)], data: word(5n) };
    const tx = syntheticTx({ to: SEPOLIA_WETH, value: '0x5', input: '0xd0e30db0' });
    const before = describe1(tx, syntheticReceipt([deposit]));
    const after = describe1(tx, syntheticReceipt([ethLog(ACCOUNT_1, SEPOLIA_WETH, 5n), deposit]));
    expect(after.movements).toEqual(before.movements);
    expect(activitySentence(after, ctx())).toBe(activitySentence(before, ctx()));
  });
});

// ---------------------------------------------------------------------------
// ActivitySentenceContext.describeCall: the app's own wording for calls it
// recognises (phase 18 item 3 emulator finding 4: a stake read "Called
// 0x3e3F…40Af with 0.0002 test ETH: received … stETH").
// ---------------------------------------------------------------------------

describe('describeCall (wording supplied by the caller)', () => {
  const STETH_LIKE = OTHER;
  const SUBMIT = '0xa1903eab';
  const submitInput = SUBMIT + '00'.repeat(32);
  const stethMeta = { [STETH_LIKE.toLowerCase()]: { symbol: 'stETH', decimals: 18, tracked: true } };
  const mint = transferLog(STETH_LIKE, '0x0000000000000000000000000000000000000000', ACCOUNT_1, 199_999_999_999_999n);
  const staking: NonNullable<ActivitySentenceContext['describeCall']> = (call, format) =>
    call.to.toLowerCase() === STETH_LIKE.toLowerCase() && call.selector === SUBMIT && call.value > 0n
      ? `staked ${format.native(call.value)} with Lido (stETH contract 0x1111…1111)`
      : call.to.toLowerCase() === STETH_LIKE.toLowerCase() && call.selector === null && call.value > 0n
        ? `staked ${format.native(call.value)} with Lido and wrapped it into wstETH`
        : null;

  it('without the option, and with an option that answers null or an unlisted verb, every sentence is unchanged', () => {
    const prefixes = ['0x5396', '0x5ab4', '0x3c55', '0xa41d', '0xe189', '0xbd14', '0x1287', '0x0293'];
    const synthetic = [
      describe1(syntheticTx({ value: '0x2386f26fc10000' }), syntheticReceipt([])),
      describe1(syntheticTx({ input: submitInput, value: '0xb5e620f48000' }), syntheticReceipt([mint])),
      describe1(syntheticTx({ input: submitInput, value: '0xb5e620f48000' }), syntheticReceipt([], '0x0')),
    ];
    const all = [...prefixes.map((p) => describeFixture(p, [ACCOUNT_1, KERNEL_OF_ACCOUNT_1])), ...synthetic];
    for (const d of all) {
      const plain = activitySentence(d, ctx({ tokens: { ...TOKENS, ...stethMeta } }));
      expect(activitySentence(d, ctx({ tokens: { ...TOKENS, ...stethMeta }, describeCall: () => null }))).toBe(plain);
      expect(activitySentence(d, ctx({ tokens: { ...TOKENS, ...stethMeta }, describeCall: () => 'frobbed the contract' }))).toBe(plain);
    }
    expect(activitySentence(synthetic[1]!, ctx({ tokens: stethMeta }))).toBe('Called 0x1111…1111 with 0.0002 ETH: received 0.000199999999999999 stETH');
  });

  it('a recognised contract call uses the phrase, followed by what the logs show', () => {
    const d = describe1(syntheticTx({ input: submitInput, value: '0xb5e620f48000' }), syntheticReceipt([mint]));
    expect(d.call.kind).toBe('contract-call');
    expect(activitySentence(d, ctx({ tokens: stethMeta, describeCall: staking }))).toBe(
      'Staked 0.0002 ETH with Lido (stETH contract 0x1111…1111): received 0.000199999999999999 stETH',
    );
    // Hide amounts reaches the phrase through format.native.
    expect(activitySentence(d, ctx({ tokens: stethMeta, describeCall: staking, maskAmount: () => '••••' }))).toBe(
      'Staked •••• ETH with Lido (stETH contract 0x1111…1111): received •••• stETH',
    );
  });

  it('a plain value transfer can be described too (the logs follow), and a phrase-less answer keeps "Sent …"', () => {
    const wstethMint = transferLog(STETH_LIKE, '0x0000000000000000000000000000000000000000', ACCOUNT_1, 481_826_550_135_307n);
    const d = describe1(syntheticTx({ value: '0x1c6bf52634000' }), syntheticReceipt([wstethMint]));
    expect(d.call.kind).toBe('native-transfer');
    const meta = { [STETH_LIKE.toLowerCase()]: { symbol: 'wstETH', decimals: 18, tracked: true } };
    expect(activitySentence(d, ctx({ tokens: meta, describeCall: staking }))).toBe(
      'Staked 0.0005 ETH with Lido and wrapped it into wstETH: received 0.000481826550135307 wstETH',
    );
    expect(activitySentence(d, ctx({ tokens: meta }))).toBe('Sent 0.0005 ETH to 0x1111…1111');
  });

  it('a failed call says "tried to stake" in the present tense', () => {
    const d = describe1(syntheticTx({ input: submitInput, value: '0xb5e620f48000' }), syntheticReceipt([], '0x0'));
    expect(activitySentence(d, ctx({ describeCall: staking }))).toBe(
      'Failed: tried to stake 0.0002 ETH with Lido (stETH contract 0x1111…1111); only the network fee was paid',
    );
    const present = { staked: 'stake', wrapped: 'wrap', unwrapped: 'unwrap', requested: 'request', claimed: 'claim', burned: 'burn', bridged: 'bridge' };
    for (const [past, base] of Object.entries(present)) {
      expect(activitySentence(d, ctx({ describeCall: () => `${past} something` }))).toBe(
        `Failed: tried to ${base} something; only the network fee was paid`,
      );
    }
  });

  it('is consulted only for plain transfers and calls the decoder has no wording for', () => {
    const seen: (string | null)[] = [];
    const spy: NonNullable<ActivitySentenceContext['describeCall']> = (call) => {
      seen.push(call.selector);
      return null;
    };
    const transfer = describe1(syntheticTx({ to: USDC, input: erc20.encodeFunctionData('transfer', [BURN, 5_000_000n]) }), syntheticReceipt([]));
    const approve = describe1(syntheticTx({ to: USDC, input: erc20.encodeFunctionData('approve', [ROUTER, 7_000_000n]) }), syntheticReceipt([]));
    activitySentence(transfer, ctx({ describeCall: spy }));
    activitySentence(approve, ctx({ describeCall: spy }));
    expect(seen).toEqual([]);
    activitySentence(describe1(syntheticTx({ input: submitInput, value: '0x1' }), syntheticReceipt([])), ctx({ describeCall: spy }));
    activitySentence(describe1(syntheticTx({ value: '0x1' }), syntheticReceipt([])), ctx({ describeCall: spy }));
    expect(seen).toEqual([SUBMIT, null]);
  });

  it('applies to the calls inside a smart-account operation', () => {
    const calls = [{ to: STETH_LIKE, value: 5n * 10n ** 14n, data: Uint8Array.from(Buffer.from(submitInput.slice(2), 'hex')) }];
    const callData = toHex(encodeKernelExecute(calls));
    const sender = KERNEL_OF_ACCOUNT_1;
    const op = [sender, 7n, '0x', callData, '0x' + '00'.repeat(32), 0n, '0x' + '00'.repeat(32), '0x', '0x'];
    const input = entryPoint.encodeFunctionData('handleOps', [[op], OTHER]);
    const event = {
      address: ENTRYPOINT_V07,
      topics: [USER_OPERATION_EVENT_TOPIC, '0x' + '77'.repeat(32), topicOf(sender), topicOf('0x0000000000000000000000000000000000000000')],
      data: coder.encode(['uint256', 'bool', 'uint256', 'uint256'], [7n, true, 1234n, 99n]),
    };
    const smartMint = transferLog(STETH_LIKE, '0x0000000000000000000000000000000000000000', sender, 499_999_999_999_999n);
    const d = describe1(syntheticTx({ from: STRANGER, to: ENTRYPOINT_V07, input }), syntheticReceipt([smartMint, event]), [ACCOUNT_1, sender]);
    expect(activitySentence(d, ctx({ tokens: stethMeta, describeCall: staking }))).toBe(
      'Smart-account operation: staked 0.0005 ETH with Lido (stETH contract 0x1111…1111): received 0.000499999999999999 stETH',
    );
  });

  it('lists its verbs', async () => {
    const { ACTIVITY_CALL_VERBS } = await import('../src/activity-decode.js');
    expect(ACTIVITY_CALL_VERBS).toEqual(expect.arrayContaining(['staked', 'wrapped', 'unwrapped', 'requested', 'claimed', 'burned', 'bridged', 'sent', 'called']));
  });
});

describe('recipientSideFailures (someone else\'s reverted transaction)', () => {
  // The REAL reverted transfer of the emulator pass of 2026-10-11 (finding
  // 2): the dev EOA 0x16DA…aC5C sent 0.003 test ETH with a 21,000 gas limit
  // to Account 1's Kernel account; the receipt (status 0x0, gasUsed 21,000,
  // no logs) was read on 1rpc.io/sepolia and the transaction on
  // ethereum-sepolia-rpc.publicnode.com on 2026-10-11.
  const REVERTED = '0x8b7463c4';
  const DEV_EOA = getAddress('0x16da2caeada26516f919c6872f6c38ab378cac5c');
  const wallet = [ACCOUNT_1, KERNEL_OF_ACCOUNT_1];
  const self = { selfAddresses: wallet, selfNames: [{ address: KERNEL_OF_ACCOUNT_1.toLowerCase(), name: 'your smart account' }] };

  it('the fixture is a reverted incoming transfer the wallet did not send', () => {
    const d = describeFixture(REVERTED, wallet);
    expect(d.status).toBe('failed');
    expect(d.fromWallet).toBe(false);
    expect(d.from.toLowerCase()).toBe(DEV_EOA.toLowerCase());
    expect(d.to?.toLowerCase()).toBe(KERNEL_OF_ACCOUNT_1.toLowerCase());
    expect(d.value).toBe(3_000_000_000_000_000n);
  });

  it('without the option the old wording stays (byte for byte)', () => {
    const d = describeFixture(REVERTED, wallet);
    expect(activitySentence(d, ctx({ nativeSymbol: 'test ETH', ...self }))).toBe(
      'Failed: tried to send 0.003 test ETH to your smart account',
    );
  });

  it('with it the sender is named and nothing is said to be received', () => {
    const d = describeFixture(REVERTED, wallet);
    const on = { nativeSymbol: 'test ETH', recipientSideFailures: true };
    expect(activitySentence(d, ctx({ ...on, ...self }))).toBe(
      'Failed: an incoming transaction from 0x16DA…aC5C to your smart account (0.003 test ETH) was reverted, so nothing was received',
    );
    // Hide amounts masks the value; a contact names the sender.
    expect(activitySentence(d, ctx({ ...on, ...self, maskAmount: () => '••••' }))).toBe(
      'Failed: an incoming transaction from 0x16DA…aC5C to your smart account (•••• test ETH) was reverted, so nothing was received',
    );
    expect(activitySentence(d, ctx({ ...on, ...self, nameFor: (a) => (a.toLowerCase() === DEV_EOA.toLowerCase() ? 'Dev' : null) }))).toBe(
      'Failed: an incoming transaction from Dev to your smart account (0.003 test ETH) was reverted, so nothing was received',
    );
    // Without selfNames the viewing account's own address is "this account".
    expect(activitySentence(d, ctx({ ...on, selfAddresses: wallet }))).toBe(
      'Failed: an incoming transaction from 0x16DA…aC5C to this account (0.003 test ETH) was reverted, so nothing was received',
    );
    // Seen from another account of the wallet, the recipient is named by its label.
    expect(
      activitySentence(d, ctx({ ...on, selfAddresses: [ACCOUNT_1], nameFor: (a) => (a.toLowerCase() === KERNEL_OF_ACCOUNT_1.toLowerCase() ? 'Account 1’s smart account' : null) })),
    ).toBe(
      'Failed: an incoming transaction from 0x16DA…aC5C to Account 1’s smart account (0.003 test ETH) was reverted, so nothing was received',
    );
  });

  it('a zero-value incoming failure has no amount; a failure that does not reach the wallet names both parties', () => {
    const zero = describe1(syntheticTx({ from: STRANGER, to: ACCOUNT_1, value: '0x0' }), syntheticReceipt([], '0x0'), [ACCOUNT_1]);
    expect(activitySentence(zero, ctx({ recipientSideFailures: true }))).toBe(
      'Failed: an incoming transaction from 0x2222…2222 to this account was reverted, so nothing was received',
    );
    const elsewhere = describe1(
      syntheticTx({ from: STRANGER, to: USDC, input: erc20.encodeFunctionData('transfer', [ACCOUNT_1, 5_000_000n]) }),
      syntheticReceipt([], '0x0'),
      [ACCOUNT_1],
    );
    expect(activitySentence(elsewhere, ctx({ recipientSideFailures: true }))).toBe(
      'Failed: a transaction from 0x2222…2222 to USDC was reverted, so nothing in it happened',
    );
  });

  it("the viewing account's own failed transaction keeps the old wording", () => {
    const tx = syntheticTx({ to: USDC, input: erc20.encodeFunctionData('transfer', [BURN, 5_000_000n]) });
    const d = describe1(tx, syntheticReceipt([], '0x0'));
    expect(activitySentence(d, ctx({ recipientSideFailures: true }))).toBe(
      'Failed: tried to send 5 USDC to Burn; only the network fee was paid',
    );
  });
});

describe('selfAddresses (whose Activity this is)', () => {
  // The wallet's other own addresses (another account's smart account, a
  // multisig) stay in the wallet set so their operations and movements are
  // decoded, but only the viewing account reads "yourself"; the others are
  // named through nameFor.
  const MULTISIG = getAddress('0x944caa404e389b18b2fe251e969edd7a220d0d38');
  const names: Record<string, string> = {
    [MULTISIG.toLowerCase()]: 'Multisig 2 (2-of-3)',
    [KERNEL_OF_ACCOUNT_1.toLowerCase()]: 'Account 1’s smart account',
    [ACCOUNT_1.toLowerCase()]: 'Account 1',
    [BURN.toLowerCase()]: 'Burn',
  };
  const named = (over: Partial<ActivitySentenceContext> = {}) =>
    ctx({ nameFor: (a) => names[a.toLowerCase()] ?? null, ...over });

  it('without the option nothing changes; with it every wallet address that is not self is named', () => {
    const toMultisig = describe1(syntheticTx({ to: MULTISIG, value: '0x2386f26fc10000' }), syntheticReceipt([]), [ACCOUNT_1, MULTISIG]);
    expect(activitySentence(toMultisig, named())).toBe('Sent 0.01 ETH to yourself');
    expect(activitySentence(toMultisig, named({ selfAddresses: [ACCOUNT_1] }))).toBe('Sent 0.01 ETH to Multisig 2 (2-of-3)');
    // A self address that is not in the wallet set never reads "yourself".
    expect(activitySentence(toMultisig, named({ selfAddresses: [ACCOUNT_1, STRANGER] }))).toBe('Sent 0.01 ETH to Multisig 2 (2-of-3)');
    // From the multisig's side the same transfer is received from Account 1.
    expect(activitySentence(describe1(syntheticTx({ to: MULTISIG, value: '0x2386f26fc10000' }), syntheticReceipt([]), [MULTISIG]), named({ selfAddresses: [MULTISIG] }))).toBe(
      'Received 0.01 ETH from Account 1',
    );
  });

  it('selfNames names a "yourself" address only where it is the other party', () => {
    // Account 1 sends to its own Kernel account (the live 0x341db91c… case shape).
    const toKernel = describe1(syntheticTx({ to: KERNEL_OF_ACCOUNT_1, value: '0x5543df729c000' }), syntheticReceipt([]), [ACCOUNT_1, KERNEL_OF_ACCOUNT_1]);
    const self = { selfAddresses: [ACCOUNT_1, KERNEL_OF_ACCOUNT_1] };
    expect(activitySentence(toKernel, named(self))).toBe('Sent 0.0015 ETH to yourself');
    const selfNames = [{ address: KERNEL_OF_ACCOUNT_1.toLowerCase(), name: 'your smart account' }];
    expect(activitySentence(toKernel, named({ ...self, selfNames }))).toBe('Sent 0.0015 ETH to your smart account');
    // The smart account's own operation still reads "Smart-account operation", and Burn is still Burn.
    expect(activitySentence(describeFixture('0xe189', [ACCOUNT_1, KERNEL_OF_ACCOUNT_1]), named({ ...self, selfNames }))).toBe(
      'Smart-account operation: sent 0.0001 ETH to Burn',
    );
    // A name for an address that is not "yourself" changes nothing.
    expect(activitySentence(toKernel, named({ selfAddresses: [ACCOUNT_1], selfNames }))).toBe('Sent 0.0015 ETH to Account 1’s smart account');
  });

  it("another own account's smart-account operation is named as its sender", () => {
    // The pinned handleOps fixture: Account 1's Kernel account sends 0.0001 ETH to Burn.
    const d = describeFixture('0xe189', [MULTISIG, KERNEL_OF_ACCOUNT_1]);
    expect(activitySentence(d, named())).toBe('Smart-account operation: sent 0.0001 ETH to Burn');
    expect(activitySentence(d, named({ selfAddresses: [MULTISIG] }))).toBe(
      'Smart-account operation by Account 1’s smart account: sent 0.0001 ETH to Burn',
    );
    // The account's own smart account is still "Smart-account operation".
    expect(activitySentence(describeFixture('0xe189', [ACCOUNT_1, KERNEL_OF_ACCOUNT_1]), named({ selfAddresses: [ACCOUNT_1, KERNEL_OF_ACCOUNT_1] }))).toBe(
      'Smart-account operation: sent 0.0001 ETH to Burn',
    );
    // Without a name the short address is used.
    expect(activitySentence(d, ctx({ nameFor: () => null, selfAddresses: [MULTISIG] }))).toBe(
      'Smart-account operation by 0xD31c…D8FA: sent 0.0001 ETH to 0x0000…dEaD',
    );
  });

  it("what another own address received in someone else's transaction starts with its name", () => {
    const d = describe1(
      syntheticTx({ from: STRANGER, to: USDC, input: erc20.encodeFunctionData('transfer', [MULTISIG, 2_500_000n]) }),
      syntheticReceipt([transferLog(USDC, STRANGER, MULTISIG, 2_500_000n)]),
      [ACCOUNT_1, MULTISIG],
    );
    expect(activitySentence(d, named())).toBe('Received 2.5 USDC from 0x2222…2222');
    expect(activitySentence(d, named({ selfAddresses: [ACCOUNT_1] }))).toBe('Multisig 2 (2-of-3) received 2.5 USDC from 0x2222…2222');
    const eth = describe1(syntheticTx({ from: STRANGER, to: MULTISIG, value: '0x1' }), syntheticReceipt([]), [ACCOUNT_1, MULTISIG]);
    expect(activitySentence(eth, named({ selfAddresses: [ACCOUNT_1] }))).toBe('Multisig 2 (2-of-3) received 0.000000000000000001 ETH from 0x2222…2222');
  });
});
