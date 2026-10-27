import { describe, expect, it } from 'vitest';
import { Interface, concat, getAddress, id, toBeHex, zeroPadValue } from 'ethers';
import {
  CCTP_DEPOSIT_FOR_BURN_EVENT_SIGNATURE,
  CCTP_DEPOSIT_FOR_BURN_TOPIC,
  CCTP_MESSAGE_RECEIVED_EVENT_SIGNATURE,
  CCTP_MESSAGE_RECEIVED_TOPIC,
  CCTP_MESSAGE_SENT_EVENT_SIGNATURE,
  CCTP_MESSAGE_SENT_TOPIC,
  CCTP_MINT_AND_WITHDRAW_EVENT_SIGNATURE,
  CCTP_MINT_AND_WITHDRAW_TOPIC,
  CCTP_V2_TESTNET,
  CCTP_V2_TESTNET_MEASURED,
  CCTP_V2_TESTNET_USDC,
  CCTP_USED_NONCES_SELECTOR,
  CCTP_USED_NONCES_SIGNATURE,
  decodeUsedNonces,
  encodeUsedNonces,
  type BridgeBlockReader,
  cctpAttestedMatchesSent,
  cctpTimeEstimate,
  createCctpV2Provider,
  decodeCctpBurnMessage,
  encodeDepositForBurn,
  findCctpBurn,
  type BridgeEventLogReader,
  type BridgeLog,
  type BridgeReceiptLogReader,
  type BridgeTransfer,
  type CctpDepositForBurnParams,
} from '../src/index.js';
import { toHex } from '../src/encoding.js';

/**
 * Phase 23 item 4 (the app half's engine follow-ups): the measured time on
 * the CCTP quote, the encoder's Standard-only rule, and tracking from the
 * chains' own events. The fixtures are synthesised from the live leg of
 * 2026-10-25 (docs/BRIDGING.md section 17, leg 1: Base Sepolia → Arbitrum
 * Sepolia, 1 USDC, the dev EOA as sender and recipient, nonce
 * 0x4ebf0adf…fc79, executed finality 2000, fee 0, expiration block 0,
 * burn block 50,079,573, mint transaction 0x425891cf…6ddb). The
 * attestation bytes are a stand-in of the live length (130 bytes): the
 * adapter does not verify signatures (MessageTransmitterV2 does, on-chain).
 */

const BASE = 84532;
const ARB = 421614;
const SEPOLIA = 11155111;
const OP = 11155420;
const ME = '0x16DA2CAeaDa26516F919C6872F6C38AB378CaC5C';
const OTHER = getAddress('0x69f0000000000000000000000000000000007e8a');
const TM = CCTP_V2_TESTNET.tokenMessengerV2;
const MT = CCTP_V2_TESTNET.messageTransmitterV2;
const AMOUNT = 1_000_000n;
const NONCE = '0x4ebf0adf94bbd5a7a92f1bbbd05cba6b5d7641f4c71cda1afe15f1aa24e3fc79';
const BURN_TX = '0x847e641f6f038bf78f22881ff2186e0b453f18f24eb543556e8fda1db84e67a7';
const MINT_TX = '0x425891cf15b9bb3df0bb52f1972bcc0b8cfc767db0a104ece758c20db9d96ddb';
const BURN_BLOCK = 50_079_573n;
const ATTESTATION = '0x' + '11'.repeat(130);

const ev = new Interface([
  'event MessageSent(bytes message)',
  'event MessageReceived(address indexed caller, uint32 sourceDomain, bytes32 indexed nonce, bytes32 sender, uint32 indexed finalityThresholdExecuted, bytes messageBody)',
  'event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)',
  'event MintAndWithdraw(address indexed mintRecipient, uint256 amount, address indexed mintToken, uint256 feeCollected)',
  'function receiveMessage(bytes message, bytes attestation)',
]);

const u32 = (n: number) => toBeHex(n, 4);
const w = (v: bigint | string) => (typeof v === 'bigint' ? toBeHex(v, 32) : zeroPadValue(v, 32));

/** MessageV2 ‖ BurnMessageV2 (the technical guide's layout), with the fields Circle fills in as given. */
function burnMessage(over: Partial<{ nonce: string; finality: number; recipient: string; amount: bigint; maxFee: bigint; feeExecuted: bigint; expiration: bigint; src: number; dst: number; token: string }> = {}) {
  const o = { nonce: '0x' + '00'.repeat(32), finality: 0, recipient: ME, amount: AMOUNT, maxFee: 0n, feeExecuted: 0n, expiration: 0n, src: 6, dst: 3, token: CCTP_V2_TESTNET_USDC[BASE]!, ...over };
  const header = concat([u32(1), u32(o.src), u32(o.dst), o.nonce, w(TM), w(TM), w(0n), u32(2000), u32(o.finality)]);
  const body = concat([u32(1), w(o.token), w(o.recipient), w(o.amount), w(ME), w(o.maxFee), w(o.feeExecuted), w(o.expiration)]);
  return concat([header, body]).toLowerCase();
}
const SENT = burnMessage();
const ATTESTED = burnMessage({ nonce: NONCE, finality: 2000 });

function log(address: string, name: string, args: unknown[], extra: Partial<BridgeLog> = {}): BridgeLog {
  const e = ev.encodeEventLog(name, args);
  return { address, topics: e.topics, data: e.data, ...extra };
}
const sentLog = (message = SENT) => log(MT, 'MessageSent', [message], { blockNumber: '0x' + BURN_BLOCK.toString(16), transactionHash: BURN_TX });
const depositLog = (recipient = ME, amount = AMOUNT) =>
  log(TM, 'DepositForBurn', [CCTP_V2_TESTNET_USDC[BASE], amount, ME, w(recipient), 3, w(TM), w(0n), 0n, 2000, '0x']);
const receivedLog = (over: Partial<{ nonce: string; src: number }> = {}) =>
  log(MT, 'MessageReceived', [ME, over.src ?? 6, over.nonce ?? NONCE, w(TM), 2000, '0x' + ATTESTED.slice(2 + 148 * 2)], { transactionHash: MINT_TX });
const mintLog = (amount = AMOUNT, fee = 0n, tx = MINT_TX) => log(TM, 'MintAndWithdraw', [ME, amount, CCTP_V2_TESTNET_USDC[ARB], fee], { transactionHash: tx });

function harness() {
  const state = {
    receipt: null as Awaited<ReturnType<BridgeReceiptLogReader>>,
    dest: [] as BridgeLog[],
    attestation: { status: 'pending' } as { status: 'pending' } | { status: 'complete'; message: string; attestation: string },
    fetches: 0,
    destQueries: [] as unknown[],
  };
  const readSourceReceipt: BridgeReceiptLogReader = async () => state.receipt;
  const readDestinationLogs: BridgeEventLogReader = async (q) => {
    state.destQueries.push(q);
    return state.dest.filter(
      (l) =>
        l.address.toLowerCase() === q.address.toLowerCase() &&
        q.topics.every((t, i) => t === null || (typeof t === 'string' && l.topics[i]?.toLowerCase() === t.toLowerCase())),
    );
  };
  const provider = createCctpV2Provider({
    readSourceReceipt,
    readDestinationLogs,
    fetchAttestation: async () => {
      state.fetches += 1;
      return state.attestation;
    },
  });
  const route = provider.supportedRoutes().find((r) => r.sourceChainId === BASE && r.destinationChainId === ARB)!;
  const transfer: BridgeTransfer = { providerId: 'cctp-v2', route, sourceTxHash: BURN_TX, amountIn: AMOUNT, recipient: ME };
  return { state, provider, transfer };
}

describe('CCTP V2: the encoder builds Standard Transfers only', () => {
  const params: CctpDepositForBurnParams = {
    amount: AMOUNT,
    destinationDomain: 3,
    mintRecipient: ME,
    burnToken: CCTP_V2_TESTNET_USDC[BASE]!,
    destinationCaller: '0x0000000000000000000000000000000000000000',
    maxFee: 0n,
    minFinalityThreshold: 2000,
  };
  it('refuses finality 1000 (Fast) at the encoder, naming it, and still refuses 1500', () => {
    expect(() => encodeDepositForBurn({ ...params, minFinalityThreshold: 1000, maxFee: 1n })).toThrow(
      'The finality threshold must be 2000 (a Standard Transfer): this wallet never builds a Fast Transfer (finality 1000).',
    );
    expect(() => encodeDepositForBurn({ ...params, minFinalityThreshold: 1500 })).toThrow('The finality threshold must be 2000 (a Standard Transfer).');
    expect(encodeDepositForBurn(params).length).toBe(228);
  });
});

describe('CCTP V2: the measured time on the quote', () => {
  it('carries the 2026-10-25 measurements on the two measured routes and none elsewhere, never as a range', async () => {
    expect(CCTP_V2_TESTNET_MEASURED.seconds).toEqual({ '84532->421614': 996, '11155111->84532': 1058 });
    const baseArb = cctpTimeEstimate(BASE, ARB);
    expect(baseArb.measured).toEqual({ seconds: 996, date: '2026-10-25', description: 'Measured once on 2026-10-25, from the burn block to the mint block.' });
    expect(cctpTimeEstimate(SEPOLIA, BASE).measured?.seconds).toBe(1058);
    const arbSep = cctpTimeEstimate(ARB, SEPOLIA);
    expect(arbSep.measured).toBeUndefined();
    expect(arbSep.source).toContain('This route was not measured.');
    expect(baseArb.source).toContain('This route took 996 s that once.');
    expect(baseArb.source).toContain('Not a promise');
    for (const t of [baseArb, arbSep, cctpTimeEstimate(OP, ARB)]) {
      expect(t.minSeconds).toBe(15 * 60);
      expect(t.maxSeconds).toBe(19 * 60);
    }
    const provider = createCctpV2Provider();
    const route = provider.supportedRoutes().find((r) => r.sourceChainId === BASE && r.destinationChainId === ARB)!;
    const q = await provider.quote({ route, amount: AMOUNT, sender: ME, recipient: ME });
    expect(q.time).toEqual(baseArb);
  });
});

describe('CCTP V2: events and the message layout', () => {
  it('pins the event topics to keccak of the signatures (ethers agrees)', () => {
    expect(CCTP_MESSAGE_SENT_TOPIC).toBe(id(CCTP_MESSAGE_SENT_EVENT_SIGNATURE));
    expect(CCTP_MESSAGE_SENT_TOPIC).toBe(ev.getEvent('MessageSent')!.topicHash);
    expect(CCTP_MESSAGE_RECEIVED_TOPIC).toBe(ev.getEvent('MessageReceived')!.topicHash);
    expect(CCTP_DEPOSIT_FOR_BURN_TOPIC).toBe(ev.getEvent('DepositForBurn')!.topicHash);
    expect(CCTP_MINT_AND_WITHDRAW_TOPIC).toBe(ev.getEvent('MintAndWithdraw')!.topicHash);
    expect(id(CCTP_MESSAGE_RECEIVED_EVENT_SIGNATURE)).toBe(CCTP_MESSAGE_RECEIVED_TOPIC);
    expect(id(CCTP_DEPOSIT_FOR_BURN_EVENT_SIGNATURE)).toBe(CCTP_DEPOSIT_FOR_BURN_TOPIC);
    expect(id(CCTP_MINT_AND_WITHDRAW_EVENT_SIGNATURE)).toBe(CCTP_MINT_AND_WITHDRAW_TOPIC);
  });
  it('decodes the 376-byte burn message of the live leg', () => {
    expect((SENT.length - 2) / 2).toBe(376);
    const d = decodeCctpBurnMessage(ATTESTED);
    expect(d).toMatchObject({ version: 1, sourceDomain: 6, destinationDomain: 3, nonce: NONCE, minFinalityThreshold: 2000, finalityThresholdExecuted: 2000 });
    expect(d.body).toMatchObject({ version: 1, amount: AMOUNT, maxFee: 0n, feeExecuted: 0n, expirationBlock: 0n, hookData: '0x' });
    expect(d.body.mintRecipient).toBe(w(ME).toLowerCase());
    expect(() => decodeCctpBurnMessage('0x' + '00'.repeat(375))).toThrow('376');
    expect(cctpAttestedMatchesSent(SENT, ATTESTED)).toBe(true);
    expect(cctpAttestedMatchesSent(SENT, burnMessage({ nonce: NONCE, finality: 2000, recipient: OTHER }))).toBe(false);
    expect(cctpAttestedMatchesSent(SENT, burnMessage({ nonce: NONCE, finality: 2000, expiration: 123n }))).toBe(true);
  });
  it('finds exactly this transfer’s burn in a receipt, and nothing else', () => {
    const want = { sourceChainId: BASE, destinationChainId: ARB, amount: AMOUNT, recipient: ME };
    const found = findCctpBurn([sentLog(), depositLog()], want);
    expect(found?.message).toBe(SENT);
    expect(found?.block).toBe(BURN_BLOCK);
    expect(findCctpBurn([sentLog(), depositLog()], { ...want, recipient: OTHER })).toBeNull();
    expect(findCctpBurn([sentLog(), depositLog()], { ...want, amount: AMOUNT + 1n })).toBeNull();
    expect(findCctpBurn([sentLog(), depositLog()], { ...want, destinationChainId: SEPOLIA })).toBeNull();
    expect(findCctpBurn([sentLog(), sentLog(), depositLog()], want)).toBeNull();
    expect(findCctpBurn([sentLog()], want)).toBeNull();
    expect(findCctpBurn([sentLog(burnMessage({ maxFee: 1n })), depositLog()], want)).toBeNull();
    expect(findCctpBurn([sentLog(), depositLog(OTHER)], want)).toBeNull();
    expect(findCctpBurn([{ ...sentLog(), address: OTHER }, depositLog()], want)).toBeNull();
  });
});

describe('CCTP V2: tracking from the chains’ own events', () => {
  it('needs both log readers or neither', () => {
    expect(() => createCctpV2Provider({ readSourceReceipt: async () => null })).toThrow('both log readers');
  });

  it('walks no receipt → reverted → burned (waiting) → attested (the mint call) → delivered', async () => {
    const { state, provider, transfer } = harness();
    let st = await provider.track(transfer);
    expect(st.state).toBe('unknown');
    expect(st.detail).toBe('The burn transaction has no receipt yet; it may still be pending.');

    state.receipt = { status: 'reverted', logs: [] };
    st = await provider.track(transfer);
    expect(st.state).toBe('failed');
    expect(st.onChain?.status).toBe('source-reverted');

    state.receipt = { status: 'success', logs: [sentLog(), depositLog()] };
    st = await provider.track(transfer);
    expect(st.state).toBe('in-flight');
    expect(st.onChain).toMatchObject({ status: 'in-flight', guid: null, sourceBlock: BURN_BLOCK });
    expect(st.detail).toBe(
      `The USDC was burned on the sending network (block ${BURN_BLOCK}). Waiting for Circle's attestation, which comes after the sending network's hard finality.`,
    );
    expect(st.destinationCalls).toBeUndefined();
    expect(state.destQueries).toHaveLength(0);

    state.attestation = { status: 'complete', message: ATTESTED, attestation: ATTESTATION };
    st = await provider.track(transfer);
    expect(st.state).toBe('awaiting-destination-action');
    expect(st.onChain).toMatchObject({ status: 'attested', guid: NONCE, destinationTx: null, sourceBlock: BURN_BLOCK });
    expect(st.attestation).toEqual({ message: ATTESTED, attestation: ATTESTATION, nonce: NONCE, expirationBlock: 0n });
    expect(st.destinationCalls).toHaveLength(1);
    const mint = st.destinationCalls![0]!;
    expect(mint.to).toBe(MT);
    expect(mint.value).toBe(0n);
    expect(toHex(mint.data)).toBe(ev.encodeFunctionData('receiveMessage', [ATTESTED, ATTESTATION]));
    expect(state.destQueries[0]).toEqual({ chainId: ARB, address: MT, topics: [CCTP_MESSAGE_RECEIVED_TOPIC, null, NONCE] });

    state.dest = [receivedLog(), mintLog()];
    st = await provider.track(transfer);
    expect(st.state).toBe('delivered');
    expect(st.destinationTxHash).toBe(MINT_TX);
    expect(st.onChain).toMatchObject({ status: 'delivered', guid: NONCE, destinationTx: MINT_TX, amountReceived: AMOUNT });
    expect(st.detail).toBe(
      `Delivered: the receiving network shows MessageReceived for this transfer's message (nonce ${NONCE}) and MintAndWithdraw of ${AMOUNT} base units of USDC to ${ME} in transaction ${MINT_TX}.`,
    );
  });

  it('continues from a stored attestation without asking Circle, and re-checks it', async () => {
    const { state, provider, transfer } = harness();
    state.receipt = { status: 'success', logs: [sentLog(), depositLog()] };
    const st = await provider.track({ ...transfer, attested: { message: ATTESTED, attestation: ATTESTATION } });
    expect(st.state).toBe('awaiting-destination-action');
    expect(state.fetches).toBe(0);
    const tampered = await provider.track({ ...transfer, attested: { message: burnMessage({ nonce: NONCE, finality: 2000, recipient: OTHER }), attestation: ATTESTATION } });
    expect(tampered.state).toBe('unknown');
    expect(tampered.destinationCalls).toBeUndefined();
    expect(tampered.detail).toMatch(/^The attestation stored on this phone does not match the burn/);
    expect(state.fetches).toBe(0);
  });

  it('refuses an attestation that does not fit the burn (another recipient, no nonce, a fee, a broken signature length)', async () => {
    const { state, provider, transfer } = harness();
    state.receipt = { status: 'success', logs: [sentLog(), depositLog()] };
    for (const bad of [
      { message: burnMessage({ nonce: NONCE, finality: 2000, recipient: OTHER }), attestation: ATTESTATION },
      { message: burnMessage({ finality: 2000 }), attestation: ATTESTATION },
      { message: burnMessage({ nonce: NONCE, finality: 2000, feeExecuted: 1n }), attestation: ATTESTATION },
      { message: burnMessage({ nonce: NONCE, finality: 1000 }), attestation: ATTESTATION },
      { message: ATTESTED, attestation: '0x' + '11'.repeat(129) },
    ]) {
      state.attestation = { status: 'complete', ...bad };
      const st = await provider.track(transfer);
      expect(st.state).toBe('unknown');
      expect(st.destinationCalls).toBeUndefined();
      expect(st.detail).toMatch(/^The attestation Circle's API returned does not match the burn/);
    }
  });

  it('does not call it delivered on events that do not match (another source, a different amount, a mint in another transaction)', async () => {
    const { state, provider, transfer } = harness();
    state.receipt = { status: 'success', logs: [sentLog(), depositLog()] };
    state.attestation = { status: 'complete', message: ATTESTED, attestation: ATTESTATION };
    state.dest = [receivedLog({ src: 0 }), mintLog()];
    expect((await provider.track(transfer)).state).toBe('unknown');
    state.dest = [receivedLog(), mintLog(AMOUNT - 1n)];
    expect((await provider.track(transfer)).state).toBe('unknown');
    state.dest = [receivedLog(), mintLog(AMOUNT, 0n, '0x' + '99'.repeat(32))];
    expect((await provider.track(transfer)).state).toBe('unknown');
    state.dest = [receivedLog({ nonce: '0x' + '42'.repeat(32) }), mintLog()];
    expect((await provider.track(transfer)).state).toBe('awaiting-destination-action');
  });

  it('a burn not matching the transfer is not followed', async () => {
    const { state, provider, transfer } = harness();
    state.receipt = { status: 'success', logs: [sentLog(), depositLog()] };
    const st = await provider.track({ ...transfer, recipient: OTHER });
    expect(st.state).toBe('unknown');
    expect(st.detail).toMatch(/does not carry exactly one CCTP burn matching this transfer/);
  });
});


/**
 * Pass p23-cctp-recheck (2026-10-26): an attested CCTP transfer older than
 * the app's old 108,000-block search (12 windows of 9,000; six hours on
 * Base Sepolia's 0.2-second blocks) could never be minted from the wallet.
 * Now MessageTransmitterV2.usedNonces on the receiving chain decides whether
 * the mint happened, and the log search (planned from the burn's time, to
 * the head or a week later) only supplies the receiving transaction.
 */
describe('CCTP V2: usedNonces decides the mint; the search starts from the burn’s time', () => {
  // The live leg's burn block on Base Sepolia (2026-10-25 14:16:23 UTC) and
  // mint block on Arbitrum Sepolia (14:32:59 UTC); the chains below run at
  // 0.2 s (Base) and 0.25 s (Arbitrum) per block around those blocks.
  const BURN_TS = 1_792_937_783n;
  const MINT_BLOCK = 322_726_898n;
  const MINT_TS = 1_792_938_779n;
  const baseTs = (n: bigint) => BURN_TS - (BURN_BLOCK - n) / 5n;
  const arbTs = (n: bigint) => MINT_TS - (MINT_BLOCK - n) / 4n;
  const blockAt = (ts: (n: bigint) => bigint, target: bigint, head: bigint) => {
    let lo = 0n;
    let hi = head;
    while (lo < hi) {
      const mid = (lo + hi + 1n) >> 1n;
      if (ts(mid) <= target) lo = mid;
      else hi = mid - 1n;
    }
    return lo;
  };

  function harness2(o: { arbHead: bigint; used: bigint | null; sloppy?: boolean; arbPrunedBelow?: bigint }) {
    const base = harness();
    const state = { ...base.state, used: o.used, arbHead: o.arbHead, contractCalls: [] as { chainId: number; to: string; data: string }[], blockReads: 0 };
    const readBlock: BridgeBlockReader = async ({ chainId, block }) => {
      state.blockReads += 1;
      const head = chainId === ARB ? state.arbHead : BURN_BLOCK + 1_000_000n;
      const n = block === 'latest' ? head : block;
      if (n > head) throw new Error('beyond the head');
      if (chainId === ARB && o.arbPrunedBelow !== undefined && n < o.arbPrunedBelow) throw new Error(`pruned history unavailable: requested ${n}`);
      return { number: n, timestamp: chainId === ARB ? arbTs(n) : baseTs(n) };
    };
    const readDestinationLogs: BridgeEventLogReader = async (q) => {
      state.destQueries.push(q);
      return state.dest.filter(
        (l) =>
          l.address.toLowerCase() === q.address.toLowerCase() &&
          (q.fromBlock === undefined || BigInt(l.blockNumber ?? '0x0') >= q.fromBlock) &&
          (q.toBlock === undefined || BigInt(l.blockNumber ?? '0x0') <= q.toBlock) &&
          (o.sloppy ? q.topics.slice(0, 1) : q.topics).every((t, i) => t === null || (typeof t === 'string' && l.topics[i]?.toLowerCase() === t.toLowerCase())),
      );
    };
    const provider = createCctpV2Provider({
      readSourceReceipt: async () => state.receipt,
      readDestinationLogs,
      fetchAttestation: async () => {
        state.fetches += 1;
        return state.attestation;
      },
      readContract: async (req) => {
        state.contractCalls.push(req);
        if (state.used === null) throw new Error('no usedNonces answer');
        return '0x' + state.used.toString(16).padStart(64, '0');
      },
      readBlock,
    });
    state.receipt = { status: 'success', logs: [sentLog(), depositLog()] };
    state.attestation = { status: 'complete', message: ATTESTED, attestation: ATTESTATION };
    return { state, provider, transfer: base.transfer };
  }
  const at = (n: bigint) => ({ blockNumber: '0x' + n.toString(16) });
  const receivedAt = (n: bigint, over: Partial<{ nonce: string; src: number }> = {}) => ({ ...receivedLog(over), ...at(n) });
  const mintAt = (n: bigint, amount = AMOUNT, recipient = ME) => {
    const l = log(TM, 'MintAndWithdraw', [recipient, amount, CCTP_V2_TESTNET_USDC[ARB], 0n], { transactionHash: MINT_TX });
    return { ...l, ...at(n) };
  };

  it('pins usedNonces: the selector, the calldata (ethers agrees) and the answer (0, 1, anything else refused)', () => {
    const mtIface = new Interface(['function usedNonces(bytes32) view returns (uint256)']);
    expect(id(CCTP_USED_NONCES_SIGNATURE).slice(0, 10)).toBe(CCTP_USED_NONCES_SELECTOR);
    expect(toHex(encodeUsedNonces(NONCE))).toBe(mtIface.encodeFunctionData('usedNonces', [NONCE]));
    expect(decodeUsedNonces('0x' + '00'.repeat(32))).toBe(false);
    expect(decodeUsedNonces('0x' + '00'.repeat(31) + '01')).toBe(true);
    expect(() => decodeUsedNonces('0x' + '00'.repeat(31) + '02')).toThrow('neither 0 nor NONCE_USED');
    expect(() => decodeUsedNonces('0x')).toThrow('one 32-byte word');
    expect(() => encodeUsedNonces('0x1234')).toThrow('32 bytes');
  });

  it('usedNonces 0: the mint is offered and no log is searched, whatever the receiving chain’s logs hold', async () => {
    const { state, provider, transfer } = harness2({ arbHead: MINT_BLOCK + 600_000n, used: 0n });
    // Even a matching delivery in the logs does not override the chain's own record.
    state.dest = [receivedAt(MINT_BLOCK), mintAt(MINT_BLOCK)];
    const st = await provider.track(transfer);
    expect(st.state).toBe('awaiting-destination-action');
    expect(st.onChain).toMatchObject({ status: 'attested', guid: NONCE, destinationTx: null, nonceUsed: false });
    expect(st.destinationCalls).toHaveLength(1);
    expect(toHex(st.destinationCalls![0]!.data)).toBe(ev.encodeFunctionData('receiveMessage', [ATTESTED, ATTESTATION]));
    expect(state.destQueries).toHaveLength(0);
    expect(state.contractCalls).toEqual([{ chainId: ARB, to: MT, data: toHex(encodeUsedNonces(NONCE)) }]);
  });

  it('the stranded case: an attested transfer whose receiving head is 600,000 blocks past the burn (older than the old 108,000-block cap) still gets its mint', async () => {
    const { provider, transfer, state } = harness2({ arbHead: MINT_BLOCK + 600_000n, used: 0n });
    const st = await provider.track({ ...transfer, attested: { message: ATTESTED, attestation: ATTESTATION } });
    expect(st.state).toBe('awaiting-destination-action');
    expect(st.destinationCalls).toHaveLength(1);
    expect(st.detail).not.toMatch(/too long ago/);
    expect(state.fetches).toBe(0);
  });

  it('usedNonces 1 with the logs found: delivered with the receiving transaction, searched from the block at the burn’s time less 10 minutes', async () => {
    const { state, provider, transfer } = harness2({ arbHead: MINT_BLOCK + 600_000n, used: 1n });
    state.dest = [receivedAt(MINT_BLOCK), mintAt(MINT_BLOCK)];
    const st = await provider.track(transfer);
    expect(st.state).toBe('delivered');
    expect(st.destinationTxHash).toBe(MINT_TX);
    expect(st.onChain).toMatchObject({ status: 'delivered', destinationTx: MINT_TX, amountReceived: AMOUNT, nonceUsed: true });
    const start = blockAt(arbTs, BURN_TS - 600n, MINT_BLOCK + 600_000n);
    expect(st.onChain!.search).toMatchObject({ fromBlock: start, fromTimestamp: arbTs(start), bounded: false, toBlock: MINT_BLOCK + 600_000n });
    const first = state.destQueries[0]!;
    expect(first).toMatchObject({ chainId: ARB, address: MT, topics: [CCTP_MESSAGE_RECEIVED_TOPIC, null, NONCE], fromBlock: start, toBlock: start + 8_999n });
    // The search stopped at the window holding MessageReceived, and MintAndWithdraw was asked in that block only.
    const last = state.destQueries[state.destQueries.length - 1]!;
    expect(last).toMatchObject({ address: TM, fromBlock: MINT_BLOCK, toBlock: MINT_BLOCK });
    const windows = state.destQueries.filter((q) => q.address === MT);
    expect(windows[windows.length - 1]!.toBlock! >= MINT_BLOCK && windows[windows.length - 1]!.fromBlock! <= MINT_BLOCK).toBe(true);
    for (let i = 1; i < windows.length; i++) expect(windows[i]!.fromBlock).toBe(windows[i - 1]!.toBlock! + 1n);
  });

  it('usedNonces 1 with no log found: delivered, the receiving transaction stated as not found in the blocks searched', async () => {
    const { state, provider, transfer } = harness2({ arbHead: MINT_BLOCK + 20_000n, used: 1n });
    const st = await provider.track(transfer);
    const search = st.onChain!.search!;
    expect(st.state).toBe('delivered');
    expect(st.destinationTxHash).toBeUndefined();
    expect(st.onChain).toMatchObject({ status: 'delivered', destinationTx: null, amountReceived: null, nonceUsed: true });
    expect(st.detail).toBe(
      `Delivered: Circle's MessageTransmitterV2 on the receiving network records this transfer's message (nonce ${NONCE}) as used, which happens only when a receiveMessage carrying it succeeds, so the USDC was minted to ${ME}. The receiving transaction was not found in the blocks this wallet searched (blocks ${search.fromBlock} to ${search.toBlock}, from 2026-10-25 14:06 UTC to 2026-10-25 15:56 UTC).`,
    );
    expect(state.destQueries.every((q) => q.fromBlock !== undefined && q.toBlock !== undefined && q.toBlock - q.fromBlock < 9_000n)).toBe(true);
  });

  it('usedNonces 1, the search bounded at a week after the burn: delivered, and the sentence says the search ends there', async () => {
    // 9 days of Arbitrum blocks past the mint block.
    const { provider, transfer } = harness2({ arbHead: MINT_BLOCK + 9n * 86_400n * 4n, used: 1n });
    const st = await provider.track(transfer);
    const search = st.onChain!.search!;
    expect(search.bounded).toBe(true);
    expect(search.toTimestamp - search.fromTimestamp).toBe(7n * 86_400n);
    expect(st.state).toBe('delivered');
    expect(st.detail).toMatch(/; it searches only the 168 hours after the burn\)\.$/);
    expect(st.detail).not.toMatch(/too long ago/);
  });

  it('the delivered rule still refuses a mint to another recipient or of another amount (usedNonces 1)', async () => {
    for (const mint of [mintAt(MINT_BLOCK, AMOUNT, OTHER), mintAt(MINT_BLOCK, AMOUNT - 1n)]) {
      const { state, provider, transfer } = harness2({ arbHead: MINT_BLOCK + 1_000n, used: 1n });
      state.dest = [receivedAt(MINT_BLOCK), mint];
      const st = await provider.track(transfer);
      expect(st.state).toBe('unknown');
      expect(st.destinationCalls).toBeUndefined();
      expect(st.detail).toMatch(/do not match this transfer/);
    }
    const { state, provider, transfer } = harness2({ arbHead: MINT_BLOCK + 1_000n, used: 1n });
    state.dest = [receivedAt(MINT_BLOCK, { src: 0 }), mintAt(MINT_BLOCK)];
    expect((await provider.track(transfer)).state).toBe('unknown');
    // A node that ignores the topic filters hands back a mint to someone else in the same transaction: still not this delivery.
    const sloppy = harness2({ arbHead: MINT_BLOCK + 1_000n, used: 1n, sloppy: true });
    sloppy.state.dest = [receivedAt(MINT_BLOCK), mintAt(MINT_BLOCK, AMOUNT, OTHER)];
    const st = await sloppy.provider.track(sloppy.transfer);
    expect(st.state).toBe('unknown');
    expect(st.destinationTxHash).toBeUndefined();
  });

  it('a usedNonces answer that is neither 0 nor 1, or no answer at all, stops the pass (nothing is decided)', async () => {
    const odd = harness2({ arbHead: MINT_BLOCK + 1_000n, used: 2n });
    await expect(odd.provider.track(odd.transfer)).rejects.toThrow('neither 0 nor NONCE_USED');
    const noAnswer = harness2({ arbHead: MINT_BLOCK + 1_000n, used: null });
    await expect(noAnswer.provider.track(noAnswer.transfer)).rejects.toThrow('no usedNonces answer');
  });

  it('without a contract reader the logs decide as before, over the search planned from the burn’s time', async () => {
    const readBlock: BridgeBlockReader = async ({ chainId, block }) => {
      const head = chainId === ARB ? MINT_BLOCK + 200_000n : BURN_BLOCK + 1_000n;
      const n = block === 'latest' ? head : block;
      return { number: n, timestamp: chainId === ARB ? arbTs(n) : baseTs(n) };
    };
    const asked: Parameters<BridgeEventLogReader>[0][] = [];
    const provider = createCctpV2Provider({
      readSourceReceipt: async () => ({ status: 'success', logs: [sentLog(), depositLog()] }),
      readDestinationLogs: async (q) => {
        asked.push(q);
        return [];
      },
      fetchAttestation: async () => ({ status: 'complete', message: ATTESTED, attestation: ATTESTATION }),
      readBlock,
    });
    const route = provider.supportedRoutes().find((r) => r.sourceChainId === BASE && r.destinationChainId === ARB)!;
    const st = await provider.track({ providerId: 'cctp-v2', route, sourceTxHash: BURN_TX, amountIn: AMOUNT, recipient: ME });
    expect(st.state).toBe('awaiting-destination-action');
    expect(st.onChain!.nonceUsed).toBeUndefined();
    expect(asked.length).toBeGreaterThan(12); // more than the old 12-window cap: 200,000 blocks past the burn
    expect(asked.every((q) => q.fromBlock !== undefined)).toBe(true);
  });

  it('usedNonces 1 and a receiving node that cannot serve the search (pruned): still delivered, the transaction not looked up; usedNonces 0 never searches', async () => {
    const pruned = harness2({ arbHead: MINT_BLOCK + 600_000n, used: 1n, arbPrunedBelow: MINT_BLOCK + 500_000n });
    const st = await pruned.provider.track(pruned.transfer);
    expect(st.state).toBe('delivered');
    expect(st.onChain).toMatchObject({ status: 'delivered', destinationTx: null, nonceUsed: true });
    expect(st.detail).toMatch(/The receiving transaction was not looked up: the receiving network's endpoint did not serve the search just now\.$/);
    const unused = harness2({ arbHead: MINT_BLOCK + 600_000n, used: 0n, arbPrunedBelow: MINT_BLOCK + 500_000n });
    expect((await unused.provider.track(unused.transfer)).state).toBe('awaiting-destination-action');
  });
});
