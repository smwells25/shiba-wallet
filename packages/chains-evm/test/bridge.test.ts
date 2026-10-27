import { describe, expect, it } from 'vitest';
import { AbiCoder, Interface, getAddress, hexlify, id, zeroPadValue } from 'ethers';
import {
  assertCallsAllowed,
  BridgeRegistry,
  BridgeRegistryError,
  CCTP_DEPOSIT_FOR_BURN_SELECTOR,
  CCTP_DEPOSIT_FOR_BURN_SIGNATURE,
  CCTP_RECEIVE_MESSAGE_SELECTOR,
  CCTP_V2_TESTNET,
  CCTP_V2_TESTNET_DOMAINS,
  CCTP_V2_TESTNET_USDC,
  chainIdForLayerZeroEid,
  createBridgeRegistry,
  createCctpV2Provider,
  createLayerZeroOftProvider,
  decodeOftMessagingFee,
  decodeOftQuoteOftHead,
  depositForBurnPins,
  encodeDepositForBurn,
  encodeOftQuoteOft,
  encodeOftQuoteSend,
  encodeOftSend,
  encodeReceiveMessage,
  exactApprovalCall,
  LAYERZERO_V2_TESTNET,
  layerZeroEidFor,
  layerZeroScanState,
  OFT_QUOTE_OFT_SELECTOR,
  OFT_QUOTE_OFT_SIGNATURE,
  OFT_QUOTE_SEND_SELECTOR,
  OFT_QUOTE_SEND_SIGNATURE,
  OFT_SEND_LAYOUT,
  OFT_SEND_SELECTOR,
  OFT_SEND_SIGNATURE,
  oftSendPins,
  oftSendStandingPins,
  STARGATE_V2_TESTNET_NATIVE_POOLS,
  type BridgeCall,
  type BridgePin,
  type BridgeProvider,
  type BridgeRoute,
  type CctpDepositForBurnParams,
  type OftDeployment,
  type OftSendParam,
  type SessionKeyGrant,
} from '../src/index.js';
import { toHex } from '../src/encoding.js';
import { httpTransport } from '../src/rpc.js';
import { solidityPacked } from 'ethers';
import {
  decodeOftReceivedLog,
  decodeOftSentLog,
  decodePacketSentLog,
  decodeUnreceivedTokenCachedLog,
  encodeStargateRetryReceiveToken,
  findLayerZeroSend,
  OFT_RECEIVED_EVENT_SIGNATURE,
  OFT_RECEIVED_TOPIC,
  OFT_SENT_EVENT_SIGNATURE,
  OFT_SENT_TOPIC,
  oftTimeEstimate,
  PACKET_SENT_EVENT_SIGNATURE,
  PACKET_SENT_TOPIC,
  STARGATE_RETRY_RECEIVE_TOKEN_SELECTOR,
  STARGATE_RETRY_RECEIVE_TOKEN_SIGNATURE,
  STARGATE_TESTNET_NATIVE_LIVE_NOTES,
  UNRECEIVED_TOKEN_CACHED_EVENT_SIGNATURE,
  UNRECEIVED_TOKEN_CACHED_TOPIC,
  type BridgeEventLogReader,
  type BridgeLog,
  type BridgeReceiptLogReader,
  type BridgeTransfer,
  type BridgeBlockReader,
  BRIDGE_BLOCK_SEARCH_MAX_PROBES,
  BRIDGE_SEARCH_BOUND_SECONDS,
  BRIDGE_SEARCH_START_MARGIN_SECONDS,
  BRIDGE_SEARCH_WINDOW_BLOCKS,
  findBlockAtOrBefore,
  isPrunedHistoryError,
  planDestinationSearch,
  prunedEarliestAvailable,
  PRUNED_HISTORY_ERROR_CODE,
  searchPlannedLogs,
  searchRangeText,
  searchSpanText,
  searchTimeText,
} from '../src/index.js';

const SEPOLIA = 11155111;
const BASE_SEPOLIA = 84532;
const ARB_SEPOLIA = 421614;
const OP_SEPOLIA = 11155420;
const ME = '0x16DA2CAeaDa26516F919C6872F6C38AB378CaC5C';
const OTHER = getAddress('0x69f0000000000000000000000000000000007e8a');

const coder = AbiCoder.defaultAbiCoder();
const SP = 'tuple(uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd)';
const oftIface = new Interface([
  `function send(${SP} p, tuple(uint256 nativeFee, uint256 lzTokenFee) fee, address refundAddress) payable`,
  `function quoteSend(${SP} p, bool payInLzToken) view returns (tuple(uint256,uint256))`,
  `function quoteOFT(${SP} p) view returns (tuple(uint256,uint256), tuple(int256,string)[], tuple(uint256,uint256))`,
]);
const cctpIface = new Interface([
  'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)',
  'function receiveMessage(bytes message, bytes attestation)',
  'function approve(address spender, uint256 amount)',
]);

/** Every pin of a call reads the word it names from the call's own calldata. */
function expectPinsMatch(data: Uint8Array, pins: BridgePin[]): void {
  for (const pin of pins) {
    const word = BigInt(toHex(data.slice(4 + pin.rule.offset, 4 + pin.rule.offset + 32)));
    const param = BigInt(pin.rule.params[0]!);
    if (pin.rule.condition === 'equal') expect(word, pin.field).toBe(param);
    else if (pin.rule.condition === 'lessThanOrEqual') expect(word <= param, pin.field).toBe(true);
    else if (pin.rule.condition === 'greaterThanOrEqual') expect(word >= param, pin.field).toBe(true);
    else throw new Error(`unexpected condition ${pin.rule.condition}`);
  }
}

/** A grant holding exactly the call's pins, as a session key would carry them. */
function grantFor(call: BridgeCall, pins: BridgePin[] = call.pins, valueLimit = call.valueLimit): SessionKeyGrant {
  return {
    sessionKey: '0x000000000000000000000000000000000000dEaD',
    validAfter: 0,
    validUntil: 4_000_000_000,
    calls: [{ target: call.to, selector: call.selector, valueLimit, rules: pins.map((p) => p.rule) }],
  };
}

function fakeProvider(id: string, routes: Partial<BridgeRoute>[] = []): BridgeProvider {
  const usdc = { kind: 'erc20' as const, address: CCTP_V2_TESTNET_USDC[SEPOLIA]!, symbol: 'USDC', decimals: 6 };
  return {
    id,
    label: `Fake ${id}`,
    trust: { verification: 'v', control: 'c', refundRule: 'r' },
    supportedRoutes: () =>
      routes.map((r) => ({
        providerId: id,
        sourceChainId: SEPOLIA,
        destinationChainId: BASE_SEPOLIA,
        sourceAsset: usdc,
        destinationAsset: usdc,
        ...r,
      })),
    quote: async () => {
      throw new Error('not used');
    },
    track: async () => ({ state: 'unknown', detail: '' }),
  };
}

describe('bridge registry', () => {
  it('registers, looks up and lists providers in order', () => {
    const registry = new BridgeRegistry();
    const a = fakeProvider('alpha', [{}]);
    const b = fakeProvider('beta-2', [{ sourceChainId: ARB_SEPOLIA, destinationChainId: OP_SEPOLIA }]);
    registry.register(a);
    registry.register(b);
    expect(registry.has('alpha')).toBe(true);
    expect(registry.get('alpha')).toBe(a);
    expect(registry.require('beta-2')).toBe(b);
    expect(registry.get('gamma')).toBeUndefined();
    expect(() => registry.require('gamma')).toThrow(BridgeRegistryError);
    expect(registry.list().map((p) => p.id)).toEqual(['alpha', 'beta-2']);
    expect(registry.routes({ sourceChainId: ARB_SEPOLIA }).map((r) => r.providerId)).toEqual(['beta-2']);
    expect(registry.routes({ destinationChainId: BASE_SEPOLIA }).map((r) => r.providerId)).toEqual(['alpha']);
    expect(registry.routes()).toHaveLength(2);
  });

  it('refuses a duplicate id and leaves the first registration in place', () => {
    const registry = createBridgeRegistry([fakeProvider('alpha')]);
    const again = fakeProvider('alpha');
    expect(() => registry.register(again)).toThrow('already registered');
    expect(registry.get('alpha')).not.toBe(again);
  });

  it('refuses malformed ids, missing trust statements and malformed routes', () => {
    const registry = new BridgeRegistry();
    for (const bad of ['', 'A', 'Upper', 'has space', '-lead', 'x'.repeat(41)]) {
      expect(() => registry.register(fakeProvider(bad))).toThrow('provider id');
    }
    const noTrust = { ...fakeProvider('silent'), trust: { verification: '', control: 'c', refundRule: 'r' } };
    expect(() => registry.register(noTrust)).toThrow('who verifies');
    expect(() => registry.register(fakeProvider('self', [{ destinationChainId: SEPOLIA }]))).toThrow('to itself');
    expect(() => registry.register(fakeProvider('foreign', [{ providerId: 'other' }]))).toThrow('belongs to other');
    expect(() => registry.register(fakeProvider('badchain', [{ sourceChainId: 0 }]))).toThrow('invalid chain id');
    const badToken = fakeProvider('badtoken', [
      { sourceAsset: { kind: 'erc20', address: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238'.replace('c', 'C'), symbol: 'USDC', decimals: 6 } },
    ]);
    expect(() => registry.register(badToken)).toThrow('checksum');
    expect(registry.list()).toHaveLength(0);
  });

  it('holds the two real adapters side by side', () => {
    const registry = createBridgeRegistry([
      createCctpV2Provider(),
      createLayerZeroOftProvider({ deployments: STARGATE_V2_TESTNET_NATIVE_POOLS, readContract: async () => '0x' }),
    ]);
    expect(registry.list().map((p) => p.id)).toEqual(['cctp-v2', 'layerzero-oft']);
    // Sepolia -> OP Sepolia is served by both providers (USDC by CCTP, ETH by Stargate).
    expect(registry.routes({ sourceChainId: SEPOLIA, destinationChainId: OP_SEPOLIA }).map((r) => r.providerId)).toEqual([
      'cctp-v2',
      'layerzero-oft',
    ]);
    // Base Sepolia is CCTP only.
    expect(new Set(registry.routes({ sourceChainId: BASE_SEPOLIA }).map((r) => r.providerId))).toEqual(new Set(['cctp-v2']));
  });
});

describe('CCTP V2 adapter', () => {
  const params: CctpDepositForBurnParams = {
    amount: 1_000_000n,
    destinationDomain: 3,
    mintRecipient: ME,
    burnToken: CCTP_V2_TESTNET_USDC[BASE_SEPOLIA]!,
    destinationCaller: '0x0000000000000000000000000000000000000000',
    maxFee: 0n,
    minFinalityThreshold: 2000,
  };

  it('pins the selectors to keccak of the signatures', () => {
    expect(id(CCTP_DEPOSIT_FOR_BURN_SIGNATURE).slice(0, 10)).toBe(CCTP_DEPOSIT_FOR_BURN_SELECTOR);
    expect(CCTP_DEPOSIT_FOR_BURN_SELECTOR).toBe('0x8e0250ee'); // docs/BRIDGING.md section 2
    expect(id('receiveMessage(bytes,bytes)').slice(0, 10)).toBe(CCTP_RECEIVE_MESSAGE_SELECTOR);
    expect(cctpIface.getFunction('depositForBurn')!.selector).toBe(CCTP_DEPOSIT_FOR_BURN_SELECTOR);
  });

  it('encodes depositForBurn byte for byte like ethers', () => {
    const expected = cctpIface.encodeFunctionData('depositForBurn', [
      params.amount,
      params.destinationDomain,
      zeroPadValue(ME, 32),
      params.burnToken,
      zeroPadValue(params.destinationCaller, 32),
      params.maxFee,
      params.minFinalityThreshold,
    ]);
    const data = encodeDepositForBurn(params);
    expect(toHex(data)).toBe(expected);
    expect(data.length).toBe(4 + 7 * 32);
  });

  it('pins all seven fixed-size arguments at their offsets', () => {
    const pins = depositForBurnPins(params);
    expect(pins.map((p) => [p.field, p.rule.offset, p.rule.condition])).toEqual([
      ['amount', 0, 'equal'],
      ['destinationDomain', 32, 'equal'],
      ['mintRecipient', 64, 'equal'],
      ['burnToken', 96, 'equal'],
      ['destinationCaller', 128, 'equal'],
      ['maxFee', 160, 'equal'],
      ['minFinalityThreshold', 192, 'equal'],
    ]);
    expectPinsMatch(encodeDepositForBurn(params), pins);
  });

  it('refuses what it will not sign', () => {
    expect(() => encodeDepositForBurn({ ...params, amount: 0n })).toThrow('more than zero');
    expect(() => encodeDepositForBurn({ ...params, maxFee: 1_000_000n })).toThrow('less than the amount');
    expect(() => encodeDepositForBurn({ ...params, minFinalityThreshold: 1500 })).toThrow('2000');
    expect(() => encodeDepositForBurn({ ...params, destinationDomain: 5 })).toThrow('not one this wallet has verified');
    expect(() => encodeDepositForBurn({ ...params, mintRecipient: '0x0000000000000000000000000000000000000000' })).toThrow(
      'zero address',
    );
    expect(() => encodeDepositForBurn({ ...params, mintRecipient: ME.replace('DA', 'Da') })).toThrow('checksum');
    expect(() => encodeDepositForBurn({ ...params, amount: -1n })).toThrow('unsigned');
  });

  it('serves the 12 directed routes between the four test networks, USDC only', () => {
    const provider = createCctpV2Provider();
    const routes = provider.supportedRoutes();
    expect(routes).toHaveLength(12);
    for (const r of routes) {
      expect(r.sourceAsset).toMatchObject({ kind: 'erc20', symbol: 'USDC', decimals: 6 });
      expect(r.sourceAsset.kind === 'erc20' && r.sourceAsset.address).toBe(CCTP_V2_TESTNET_USDC[r.sourceChainId]);
      expect(r.sourceChainId).not.toBe(r.destinationChainId);
    }
    expect(Object.keys(CCTP_V2_TESTNET_DOMAINS).map(Number).sort((a, b) => a - b)).toEqual([84532, 421614, 11155111, 11155420]);
    expect(() => createCctpV2Provider({ chainIds: [1] })).toThrow('not a verified CCTP V2 test network');
  });

  it('quotes a Standard Transfer as an exact approval plus a fully pinned burn', async () => {
    const provider = createCctpV2Provider();
    const route = provider.supportedRoutes().find((r) => r.sourceChainId === BASE_SEPOLIA && r.destinationChainId === ARB_SEPOLIA)!;
    const q = await provider.quote({ route, amount: 1_000_000n, sender: ME, recipient: ME });
    expect(q.calls.map((c) => c.purpose)).toEqual(['approve', 'bridge']);
    const [approve, burn] = q.calls as [BridgeCall, BridgeCall];
    expect(approve.to).toBe(CCTP_V2_TESTNET_USDC[BASE_SEPOLIA]);
    expect(toHex(approve.data)).toBe(cctpIface.encodeFunctionData('approve', [CCTP_V2_TESTNET.tokenMessengerV2, 1_000_000n]));
    expect(burn.to).toBe(CCTP_V2_TESTNET.tokenMessengerV2);
    expect(toHex(burn.data)).toBe(toHex(encodeDepositForBurn(params)));
    expect(burn.value).toBe(0n);
    expect(burn.unpinnable).toEqual([]);
    expect(q.approvals).toEqual([
      { chainId: BASE_SEPOLIA, token: CCTP_V2_TESTNET_USDC[BASE_SEPOLIA], spender: CCTP_V2_TESTNET.tokenMessengerV2, amount: 1_000_000n },
    ]);
    expect(q.expectedAmountOut).toBe(1_000_000n);
    expect(q.fees).toHaveLength(1);
    expect(q.fees[0]!.amount).toBe(0n);
    expect(q.destination.kind).toBe('mint-after-attestation');
    expect(q.tracking.needsApiKey).toBe(false);
    for (const call of q.calls) {
      expectPinsMatch(call.data, call.pins);
      expect(() => assertCallsAllowed(grantFor(call), [call], 1)).not.toThrow();
    }
    // The pinned burn refuses a different recipient, exactly as a CallPolicy would.
    const redirected = { ...burn, data: encodeDepositForBurn({ ...params, mintRecipient: OTHER }) };
    expect(() => assertCallsAllowed(grantFor(burn), [redirected], 1)).toThrow('offset 64');
  });

  it('refuses a minimum above the amount and a route it does not serve', async () => {
    const provider = createCctpV2Provider();
    const route = provider.supportedRoutes()[0]!;
    await expect(provider.quote({ route, amount: 5n, sender: ME, recipient: ME, minAmountOut: 6n })).rejects.toThrow('at most the amount');
    await expect(provider.quote({ route: { ...route, destinationChainId: 1 }, amount: 5n, sender: ME, recipient: ME })).rejects.toThrow(
      'does not serve this route',
    );
    await expect(provider.quote({ route, amount: 0n, sender: ME, recipient: ME })).rejects.toThrow('more than zero');
  });

  it('tracks through the injected attestation reader and builds the mint', async () => {
    const route = createCctpV2Provider().supportedRoutes()[0]!;
    const transfer = { providerId: 'cctp-v2', route, sourceTxHash: '0x' + 'ab'.repeat(32), amountIn: 1n, recipient: ME };
    expect((await createCctpV2Provider().track(transfer)).state).toBe('unknown');
    const asked: unknown[] = [];
    let answer: { status: 'pending' } | { status: 'complete'; message: string; attestation: string } = { status: 'pending' };
    const provider = createCctpV2Provider({
      fetchAttestation: async (req) => {
        asked.push(req);
        return answer;
      },
    });
    expect((await provider.track(transfer)).state).toBe('in-flight');
    expect(asked[0]).toEqual({ sourceDomain: CCTP_V2_TESTNET_DOMAINS[route.sourceChainId], sourceTxHash: transfer.sourceTxHash });
    answer = { status: 'complete', message: '0x0102', attestation: '0x' + '11'.repeat(130) };
    const status = await provider.track(transfer);
    expect(status.state).toBe('awaiting-destination-action');
    expect(status.destinationCalls![0]!.to).toBe(CCTP_V2_TESTNET.messageTransmitterV2);
    expect(toHex(status.destinationCalls![0]!.data)).toBe(cctpIface.encodeFunctionData('receiveMessage', ['0x0102', answer.attestation]));
    const minted = createCctpV2Provider({ fetchAttestation: async () => answer, isMinted: async () => true });
    expect((await minted.track(transfer)).state).toBe('delivered');
    expect(() => encodeReceiveMessage('0x', '0x11')).toThrow('both the message and its attestation');
    await expect(provider.track({ ...transfer, sourceTxHash: '0x12' })).rejects.toThrow('32 bytes');
  });
});

describe('exact approvals', () => {
  it('never builds an unlimited or zero approval', () => {
    const token = CCTP_V2_TESTNET_USDC[SEPOLIA]!;
    expect(() => exactApprovalCall(SEPOLIA, token, ME, 0n, 'x')).toThrow('more than zero');
    expect(() => exactApprovalCall(SEPOLIA, token, ME, 2n ** 256n - 1n, 'x')).toThrow('unlimited');
    expect(() => exactApprovalCall(SEPOLIA, token, ME, 2n ** 255n, 'x')).toThrow('unlimited');
    const ok = exactApprovalCall(SEPOLIA, token, ME, 2n ** 255n - 1n, 'x');
    expectPinsMatch(ok.data, ok.pins);
  });
});

describe('LayerZero OFT adapter: encoding', () => {
  const p: OftSendParam = {
    dstEid: 40232,
    to: ME,
    amountLD: 100_000_000_000_000n,
    minAmountLD: 99_000_000_000_000n,
    extraOptions: '0x',
    composeMsg: '0x',
    oftCmd: '0x',
  };
  const fee = { nativeFee: 102_050_140_082_558n, lzTokenFee: 0n };
  const ethersParam = (q: OftSendParam) => [q.dstEid, zeroPadValue(q.to, 32), q.amountLD, q.minAmountLD, q.extraOptions, q.composeMsg, q.oftCmd];

  it('pins the selectors against ethers', () => {
    expect(oftIface.getFunction('send')!.selector).toBe(OFT_SEND_SELECTOR);
    expect(oftIface.getFunction('quoteSend')!.selector).toBe(OFT_QUOTE_SEND_SELECTOR);
    expect(oftIface.getFunction('quoteOFT')!.selector).toBe(OFT_QUOTE_OFT_SELECTOR);
    expect(id(OFT_SEND_SIGNATURE).slice(0, 10)).toBe(OFT_SEND_SELECTOR);
    expect(id(OFT_QUOTE_SEND_SIGNATURE).slice(0, 10)).toBe(OFT_QUOTE_SEND_SELECTOR);
    expect(id(OFT_QUOTE_OFT_SIGNATURE).slice(0, 10)).toBe(OFT_QUOTE_OFT_SELECTOR);
  });

  it('encodes send, quoteSend and quoteOFT byte for byte like ethers (taxi and bus)', () => {
    for (const oftCmd of ['0x', '0x00'] as const) {
      const q = { ...p, oftCmd };
      expect(toHex(encodeOftSend(q, fee, ME))).toBe(oftIface.encodeFunctionData('send', [ethersParam(q), [fee.nativeFee, 0n], ME]));
      expect(toHex(encodeOftQuoteSend(q))).toBe(oftIface.encodeFunctionData('quoteSend', [ethersParam(q), false]));
      expect(toHex(encodeOftQuoteOft(q))).toBe(oftIface.encodeFunctionData('quoteOFT', [ethersParam(q)]));
    }
  });

  it('places every field at the documented offset, and the pins read those words', () => {
    for (const oftCmd of ['0x', '0x00'] as const) {
      const q = { ...p, oftCmd };
      const data = encodeOftSend(q, fee, ME);
      const word = (offset: number) => BigInt(toHex(data.slice(4 + offset, 4 + offset + 32)));
      const L = OFT_SEND_LAYOUT;
      expect(word(L.sendParamPointer)).toBe(0x80n);
      expect(word(L.nativeFee)).toBe(fee.nativeFee);
      expect(word(L.lzTokenFee)).toBe(0n);
      expect(word(L.refundAddress)).toBe(BigInt(ME));
      expect(word(L.dstEid)).toBe(40232n);
      expect(word(L.to)).toBe(BigInt(ME));
      expect(word(L.amountLD)).toBe(q.amountLD);
      expect(word(L.minAmountLD)).toBe(q.minAmountLD);
      expect([word(L.extraOptionsPointer), word(L.composeMsgPointer), word(L.oftCmdPointer)]).toEqual([0xe0n, 0x100n, 0x120n]);
      expect([word(L.extraOptionsLength), word(L.composeMsgLength), word(L.oftCmdLength)]).toEqual([0n, 0n, oftCmd === '0x00' ? 1n : 0n]);
      expect(data.length).toBe(4 + (oftCmd === '0x00' ? 15 : 14) * 32);
      const pins = oftSendPins(q, fee, ME);
      expect(pins).toHaveLength(oftCmd === '0x00' ? 15 : 14);
      expectPinsMatch(data, pins);
      // ethers decodes the same calldata back to the same values.
      const decoded = oftIface.decodeFunctionData('send', data);
      expect(getAddress(hexlify(decoded[0][1]).slice(0, 2) + hexlify(decoded[0][1]).slice(26))).toBe(ME);
      expect(decoded[0][6]).toBe(oftCmd);
    }
  });

  it('lets a CallPolicy hold the recipient, amount and empty bytes fields fixed', () => {
    const data = encodeOftSend(p, fee, ME);
    const call: BridgeCall = {
      purpose: 'bridge',
      chainId: SEPOLIA,
      to: STARGATE_V2_TESTNET_NATIVE_POOLS[0]!.address,
      value: p.amountLD + fee.nativeFee,
      data,
      label: 'x',
      selector: OFT_SEND_SELECTOR,
      pins: oftSendStandingPins(p, 200_000_000_000_000n, ME),
      unpinnable: [],
      valueLimit: p.amountLD + 200_000_000_000_000n,
    };
    expect(call.pins.find((x) => x.rule.offset === OFT_SEND_LAYOUT.nativeFee)!.rule.condition).toBe('lessThanOrEqual');
    expect(() => assertCallsAllowed(grantFor(call), [call], 1)).not.toThrow();
    const toOther = { ...call, data: encodeOftSend({ ...p, to: OTHER }, fee, ME) };
    expect(() => assertCallsAllowed(grantFor(call), [toOther], 1)).toThrow(`offset ${OFT_SEND_LAYOUT.to}`);
    const refundOther = { ...call, data: encodeOftSend(p, fee, OTHER) };
    expect(() => assertCallsAllowed(grantFor(call), [refundOther], 1)).toThrow(`offset ${OFT_SEND_LAYOUT.refundAddress}`);
    // A hand-built call with a composeMsg moves the oftCmd pointer and is refused.
    const withCompose = oftIface.encodeFunctionData('send', [[...ethersParam(p).slice(0, 5), '0x01', '0x'], [fee.nativeFee, 0n], ME]);
    expect(() => assertCallsAllowed(grantFor(call), [{ ...call, data: Uint8Array.from(Buffer.from(withCompose.slice(2), 'hex')) }], 1)).toThrow(
      'violates',
    );
    const tooExpensive = { ...call, data: encodeOftSend(p, { nativeFee: 200_000_000_000_001n, lzTokenFee: 0n }, ME) };
    expect(() => assertCallsAllowed(grantFor(call), [tooExpensive], 1)).toThrow(`offset ${OFT_SEND_LAYOUT.nativeFee}`);
  });

  it('refuses options, compose messages, other commands, lz-token fees and bad amounts', () => {
    expect(() => encodeOftSend({ ...p, extraOptions: '0x0003' as '0x' }, fee, ME)).toThrow('extra options');
    expect(() => encodeOftSend({ ...p, composeMsg: '0x01' as '0x' }, fee, ME)).toThrow('compose message');
    expect(() => encodeOftSend({ ...p, oftCmd: '0x01' as '0x' }, fee, ME)).toThrow('OFT commands');
    expect(() => encodeOftSend(p, { nativeFee: 1n, lzTokenFee: 1n }, ME)).toThrow('lzTokenFee');
    expect(() => encodeOftSend({ ...p, dstEid: 30101 }, fee, ME)).toThrow('not one this wallet has verified');
    expect(() => encodeOftSend({ ...p, minAmountLD: p.amountLD + 1n }, fee, ME)).toThrow('minimum');
    expect(() => encodeOftSend({ ...p, amountLD: 0n, minAmountLD: 0n }, fee, ME)).toThrow('more than zero');
    expect(() => encodeOftSend(p, fee, '0x0000000000000000000000000000000000000000')).toThrow('refund address');
    expect(() => encodeOftSend({ ...p, to: '0x0000000000000000000000000000000000000000' }, fee, ME)).toThrow('zero address');
  });

  it('decodes quoteSend and quoteOFT answers encoded by ethers, and refuses malformed ones', () => {
    const feeAnswer = coder.encode(['tuple(uint256,uint256)'], [[123n, 0n]]);
    expect(decodeOftMessagingFee(feeAnswer)).toEqual({ nativeFee: 123n, lzTokenFee: 0n });
    expect(() => decodeOftMessagingFee(feeAnswer + '00'.repeat(32))).toThrow('exactly two words');
    expect(() => decodeOftMessagingFee('0x1234')).toThrow('whole number');
    const head = oftIface.encodeFunctionResult('quoteOFT', [[1_000_000_000_000n, 171_884_000_000_000_000n], [[-1_000_000_000_000n, 'protocol fee']], [100_000_000_000_000n, 99_000_000_000_000n]]);
    expect(decodeOftQuoteOftHead(head)).toEqual({
      minAmountLD: 1_000_000_000_000n,
      maxAmountLD: 171_884_000_000_000_000n,
      amountSentLD: 100_000_000_000_000n,
      amountReceivedLD: 99_000_000_000_000n,
    });
    const broken = '0x' + head.slice(2, 2 + 128) + '00'.repeat(31) + '20' + head.slice(2 + 192);
    expect(() => decodeOftQuoteOftHead(broken)).toThrow('malformed');
    expect(() => decodeOftQuoteOftHead('0x' + '00'.repeat(64))).toThrow('too short');
  });

  it('maps endpoint ids both ways for the four networks', () => {
    expect([SEPOLIA, BASE_SEPOLIA, ARB_SEPOLIA, OP_SEPOLIA].map(layerZeroEidFor)).toEqual([40161, 40245, 40231, 40232]);
    expect(chainIdForLayerZeroEid(40231)).toBe(ARB_SEPOLIA);
    expect(chainIdForLayerZeroEid(30101)).toBeUndefined();
    expect(() => layerZeroEidFor(1)).toThrow('no verified LayerZero');
    expect(new Set(Object.values(LAYERZERO_V2_TESTNET).map((e) => e.endpoint))).toEqual(new Set(['0x6EDCE65403992e310A62460808c4b910D972f10f']));
  });
});

describe('LayerZero OFT adapter: provider', () => {
  const quoteOftAnswer = (sent: bigint, received: bigint) =>
    oftIface.encodeFunctionResult('quoteOFT', [[1n, 10n ** 21n], [], [sent, received]]);
  const quoteSendAnswer = (nativeFee: bigint) => coder.encode(['tuple(uint256,uint256)'], [[nativeFee, 0n]]);

  function reader(nativeFee = 102_050_140_082_558n, receivedDelta = 0n) {
    const calls: { chainId: number; to: string; data: string }[] = [];
    const read = async (req: { chainId: number; to: string; data: string }) => {
      calls.push(req);
      if (req.data.startsWith(OFT_QUOTE_OFT_SELECTOR)) {
        const decoded = oftIface.decodeFunctionData('quoteOFT', req.data);
        return quoteOftAnswer(decoded[0][2], decoded[0][2] - receivedDelta);
      }
      if (req.data.startsWith(OFT_QUOTE_SEND_SELECTOR)) return quoteSendAnswer(nativeFee);
      throw new Error('unexpected read');
    };
    return { calls, read };
  }

  it('lists the six Stargate ETH routes among Sepolia, Arbitrum Sepolia and OP Sepolia, none to Base Sepolia', () => {
    const provider = createLayerZeroOftProvider({ deployments: STARGATE_V2_TESTNET_NATIVE_POOLS, readContract: reader().read });
    const routes = provider.supportedRoutes();
    expect(routes).toHaveLength(6);
    expect(routes.some((r) => r.sourceChainId === BASE_SEPOLIA || r.destinationChainId === BASE_SEPOLIA)).toBe(false);
    for (const r of routes) expect(r.sourceAsset).toEqual({ kind: 'native', symbol: 'ETH', decimals: 18 });
  });

  it('quotes a native Stargate send: value = amount + fee, every word pinned, verifiers named', async () => {
    const { calls, read } = reader(102_050_140_082_558n, 1_000_000_000_000n);
    const provider = createLayerZeroOftProvider({ deployments: STARGATE_V2_TESTNET_NATIVE_POOLS, readContract: read });
    const route = provider.supportedRoutes().find((r) => r.sourceChainId === SEPOLIA && r.destinationChainId === OP_SEPOLIA)!;
    const q = await provider.quote({ route, amount: 100_000_000_000_000n, sender: ME, recipient: ME });
    expect(calls.map((c) => [c.chainId, c.to, c.data.slice(0, 10)])).toEqual([
      [SEPOLIA, '0x9Cc7e185162Aa5D1425ee924D97a87A0a34A0706', OFT_QUOTE_OFT_SELECTOR],
      [SEPOLIA, '0x9Cc7e185162Aa5D1425ee924D97a87A0a34A0706', OFT_QUOTE_SEND_SELECTOR],
    ]);
    // The minimum written into the send is what quoteOFT said would arrive.
    expect(q.expectedAmountOut).toBe(99_000_000_000_000n);
    expect(q.minAmountOut).toBe(99_000_000_000_000n);
    expect(q.calls).toHaveLength(1); // native: no approval
    const send = q.calls[0]!;
    expect(send.value).toBe(100_000_000_000_000n + 102_050_140_082_558n);
    expect(send.valueLimit).toBe(send.value);
    const decoded = oftIface.decodeFunctionData('send', send.data);
    expect(decoded[0][0]).toBe(40232n);
    expect(decoded[0][3]).toBe(99_000_000_000_000n);
    expect(decoded[1][0]).toBe(102_050_140_082_558n);
    expect(decoded[2]).toBe(ME);
    expectPinsMatch(send.data, send.pins);
    expect(() => assertCallsAllowed(grantFor(send), [send], 1)).not.toThrow();
    expect(q.fees.map((f) => [f.kind, f.amount, f.deductedFromAmount])).toEqual([
      ['messaging', 102_050_140_082_558n, false],
      ['pool', 1_000_000_000_000n, true],
    ]);
    expect(q.notes.join(' ')).toContain('1 required verifier (LayerZero Labs)');
    expect(q.notes.join(' ')).toContain("LayerZero's defaults");
    expect(q.notes.join(' ')).toContain('retryReceiveToken');
    expect(q.notes.join(' ')).toContain('private key is public');
    expect(q.destination.kind).toBe('executor-delivers');
    expect(q.time.minSeconds).toBeNull();
  });

  it('uses the bus command only on Stargate pools when asked', async () => {
    const provider = createLayerZeroOftProvider({
      deployments: STARGATE_V2_TESTNET_NATIVE_POOLS,
      readContract: reader().read,
      stargateBus: true,
    });
    const route = provider.supportedRoutes()[0]!;
    const q = await provider.quote({ route, amount: 100_000_000_000_000n, sender: ME, recipient: ME });
    expect(oftIface.decodeFunctionData('send', q.calls[0]!.data)[0][6]).toBe('0x00');
    expect(q.calls[0]!.pins).toHaveLength(15);
  });

  it('refuses dust, too-low arrivals, lz-token fees, zero fees and amounts outside the limit', async () => {
    const route = (prov: BridgeProvider) => prov.supportedRoutes()[0]!;
    const base = createLayerZeroOftProvider({ deployments: STARGATE_V2_TESTNET_NATIVE_POOLS, readContract: reader().read });
    await expect(base.quote({ route: route(base), amount: 100_000_000_000_001n, sender: ME, recipient: ME })).rejects.toThrow('steps of');
    await expect(
      base.quote({ route: route(base), amount: 100_000_000_000_000n, sender: ME, recipient: ME, minAmountOut: 100_000_000_000_001n }),
    ).rejects.toThrow('below the minimum');
    const lz = createLayerZeroOftProvider({
      deployments: STARGATE_V2_TESTNET_NATIVE_POOLS,
      readContract: async (req) =>
        req.data.startsWith(OFT_QUOTE_SEND_SELECTOR) ? coder.encode(['tuple(uint256,uint256)'], [[1n, 5n]]) : reader().read(req),
    });
    await expect(lz.quote({ route: route(lz), amount: 100_000_000_000_000n, sender: ME, recipient: ME })).rejects.toThrow('LayerZero token');
    const free = createLayerZeroOftProvider({ deployments: STARGATE_V2_TESTNET_NATIVE_POOLS, readContract: reader(0n).read });
    await expect(free.quote({ route: route(free), amount: 100_000_000_000_000n, sender: ME, recipient: ME })).rejects.toThrow('no messaging fee');
    const capped = createLayerZeroOftProvider({
      deployments: STARGATE_V2_TESTNET_NATIVE_POOLS,
      readContract: async (req) => (req.data.startsWith(OFT_QUOTE_OFT_SELECTOR) ? quoteOftAnswer(10n ** 22n, 10n ** 22n) : reader().read(req)),
    });
    await expect(capped.quote({ route: route(capped), amount: 10n ** 22n, sender: ME, recipient: ME })).rejects.toThrow('accepts between');
    await expect(base.quote({ route: { ...route(base), destinationChainId: BASE_SEPOLIA }, amount: 10n ** 14n, sender: ME, recipient: ME })).rejects.toThrow(
      'No configured OFT',
    );
  });

  it('builds an exact approval for an adapter-style ERC-20 OFT and refuses bus mode there', async () => {
    const token = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
    const pathway = STARGATE_V2_TESTNET_NATIVE_POOLS[0]!.pathways[OP_SEPOLIA]!;
    const adapter: OftDeployment = {
      chainId: SEPOLIA,
      address: '0x000000000000000000000000000000000000bEEF',
      kind: 'oft-adapter',
      assetGroup: 'test-group',
      asset: { kind: 'erc20', address: token, symbol: 'TST', decimals: 6 },
      sharedDecimals: 6,
      messagingOApp: '0x000000000000000000000000000000000000bEEF',
      controlNote: 'test',
      pathways: { [OP_SEPOLIA]: pathway },
    };
    const peer: OftDeployment = { ...adapter, chainId: OP_SEPOLIA, kind: 'oft', pathways: { [SEPOLIA]: { ...pathway } } };
    const provider = createLayerZeroOftProvider({ deployments: [adapter, peer], readContract: reader().read });
    const route = provider.supportedRoutes().find((r) => r.sourceChainId === SEPOLIA)!;
    const q = await provider.quote({ route, amount: 1_000_000n, sender: ME, recipient: ME });
    expect(q.calls.map((c) => c.purpose)).toEqual(['approve', 'bridge']);
    expect(toHex(q.calls[0]!.data)).toBe(cctpIface.encodeFunctionData('approve', [adapter.address, 1_000_000n]));
    expect(q.calls[1]!.value).toBe(102_050_140_082_558n); // fee only: the token moves by transferFrom
    expect(q.approvals).toEqual([{ chainId: SEPOLIA, token, spender: adapter.address, amount: 1_000_000n }]);
    const bus = createLayerZeroOftProvider({ deployments: [adapter, peer], readContract: reader().read, stargateBus: true });
    await expect(bus.quote({ route, amount: 1_000_000n, sender: ME, recipient: ME })).rejects.toThrow('only on Stargate');
    // A pure OFT burns from the sender: no approval.
    const back = provider.supportedRoutes().find((r) => r.sourceChainId === OP_SEPOLIA)!;
    expect((await provider.quote({ route: back, amount: 1_000_000n, sender: ME, recipient: ME })).calls.map((c) => c.purpose)).toEqual(['bridge']);
  });

  it('refuses a deployment without on-chain-read verifier facts', () => {
    const d = STARGATE_V2_TESTNET_NATIVE_POOLS[0]!;
    const noDvn: OftDeployment = {
      ...d,
      pathways: { [OP_SEPOLIA]: { ...d.pathways[OP_SEPOLIA]!, requiredDvns: [], optionalDvns: [] } },
    };
    expect(() => createLayerZeroOftProvider({ deployments: [noDvn], readContract: reader().read })).toThrow('will not assume one');
    const noReadAt: OftDeployment = { ...d, pathways: { [OP_SEPOLIA]: { ...d.pathways[OP_SEPOLIA]!, readAt: '' } } };
    expect(() => createLayerZeroOftProvider({ deployments: [noReadAt], readContract: reader().read })).toThrow('where its pathway facts');
    const mainnet: OftDeployment = { ...d, chainId: 1 };
    expect(() => createLayerZeroOftProvider({ deployments: [mainnet], readContract: reader().read })).toThrow('no verified LayerZero');
    const wrongKind: OftDeployment = { ...d, kind: 'oft' };
    expect(() => createLayerZeroOftProvider({ deployments: [wrongKind], readContract: reader().read })).toThrow('ERC-20');
  });

  it('maps LayerZero Scan statuses and tracks through the injected reader', async () => {
    expect(['INFLIGHT', 'CONFIRMING', 'DELIVERED', 'PAYLOAD_STORED', 'BLOCKED', 'FAILED', 'APPLICATION_BURNED', 'WHATEVER'].map(layerZeroScanState)).toEqual([
      'in-flight',
      'in-flight',
      'delivered',
      'awaiting-destination-action',
      'awaiting-destination-action',
      'awaiting-destination-action',
      'failed',
      'unknown',
    ]);
    const route = createLayerZeroOftProvider({ deployments: STARGATE_V2_TESTNET_NATIVE_POOLS, readContract: reader().read }).supportedRoutes()[0]!;
    const transfer = { providerId: 'layerzero-oft', route, sourceTxHash: '0x' + 'cd'.repeat(32), amountIn: 1n, recipient: ME };
    const none = createLayerZeroOftProvider({ deployments: STARGATE_V2_TESTNET_NATIVE_POOLS, readContract: reader().read });
    expect((await none.track(transfer)).state).toBe('unknown');
    const provider = createLayerZeroOftProvider({
      deployments: STARGATE_V2_TESTNET_NATIVE_POOLS,
      readContract: reader().read,
      fetchMessageStatus: async () => ({ status: 'DELIVERED', destinationTxHash: '0x' + 'ef'.repeat(32) }),
    });
    const status = await provider.track(transfer);
    expect(status).toMatchObject({ state: 'delivered', destinationTxHash: '0x' + 'ef'.repeat(32) });
    expect(status.detail).toContain('retryReceiveToken');
  });
});

describe('LayerZero OFT adapter: follow-ups from the live run (docs/BRIDGING.md 15.16)', () => {
  const evIface = new Interface([
    'event OFTSent(bytes32 indexed guid, uint32 dstEid, address indexed fromAddress, uint256 amountSentLD, uint256 amountReceivedLD)',
    'event OFTReceived(bytes32 indexed guid, uint32 srcEid, address indexed toAddress, uint256 amountReceivedLD)',
    'event PacketSent(bytes encodedPayload, bytes options, address sendLibrary)',
    'event UnreceivedTokenCached(bytes32 guid, uint8 index, uint32 srcEid, address receiver, uint256 amountLD, bytes composeMsg)',
    'function retryReceiveToken(bytes32 _guid, uint8 _index, uint32 _srcEid, address _receiver, uint256 _amountLD, bytes _composeMsg)',
  ]);
  // Leg A of the live run: Ethereum Sepolia -> OP Sepolia, 0.0002 ETH, GUID and transactions from section 15.16.
  const GUID_A = '0x4da5481014f25b3326f100cb8d0cdb20979a9e1d9d6708b96347ef993580395c';
  const SOURCE_TX_A = '0xfb041691c102214d1da67f60b23b985a2e99a335fccf23423b8c722937986405';
  const DELIVERY_TX_A = '0xf0760a9ec2ba0e8f1b3a53e46e6e118cd749b66fb2040e6d7d7a04da041827f3';
  const AMOUNT = 200_000_000_000_000n;
  const KERNEL = '0xc995E49acA5C888F4FF1E50E8467E9fFc31CC5AC';
  const pool = (chainId: number) => STARGATE_V2_TESTNET_NATIVE_POOLS.find((d) => d.chainId === chainId)!;
  // Stargate's own option seen in both live packets: type 3, executor lzReceive gas 150,000.
  const STARGATE_OPTIONS = '0x0003010011010000000000000000000000000000000249f0';

  function log(address: string, encoded: { data: string; topics: readonly string[] }, transactionHash?: string): BridgeLog {
    return { address, data: encoded.data, topics: [...encoded.topics], ...(transactionHash ? { transactionHash } : {}) };
  }
  function oftSent(source: number, guid: string, dstEid: number, amount = AMOUNT, from = ME): BridgeLog {
    return log(pool(source).address, evIface.encodeEventLog('OFTSent', [guid, dstEid, from, amount, amount]));
  }
  function packetSent(source: number, destination: number, guid: string, nonce = 196n): BridgeLog {
    const packet = solidityPacked(
      ['uint8', 'uint64', 'uint32', 'bytes32', 'uint32', 'bytes32', 'bytes32', 'bytes'],
      [1, nonce, layerZeroEidFor(source), zeroPadValue(pool(source).messagingOApp, 32), layerZeroEidFor(destination), zeroPadValue(pool(destination).messagingOApp, 32), guid, '0x01'],
    );
    return log(LAYERZERO_V2_TESTNET[source]!.endpoint, evIface.encodeEventLog('PacketSent', [packet, STARGATE_OPTIONS, LAYERZERO_V2_TESTNET[source]!.sendUln302]));
  }
  function oftReceived(destination: number, guid: string, srcEid: number, to = ME, amount = AMOUNT, tx = DELIVERY_TX_A): BridgeLog {
    return log(pool(destination).address, evIface.encodeEventLog('OFTReceived', [guid, srcEid, to, amount]), tx);
  }
  function cached(destination: number, guid: string, srcEid: number, receiver = KERNEL, amount = AMOUNT, compose = '0x'): BridgeLog {
    return log(pool(destination).address, evIface.encodeEventLog('UnreceivedTokenCached', [guid, 0, srcEid, receiver, amount, compose]), '0x' + '77'.repeat(32));
  }
  /** eth_getLogs semantics over a fixed set of logs, recording each request. */
  function destinationReader(logs: BridgeLog[]) {
    const asked: Parameters<BridgeEventLogReader>[0][] = [];
    const read: BridgeEventLogReader = async (req) => {
      asked.push(req);
      return logs.filter(
        (l) =>
          l.address.toLowerCase() === req.address.toLowerCase() &&
          req.topics.every((t, i) => t === null || (Array.isArray(t) ? t.includes(l.topics[i]!) : l.topics[i] === t)),
      );
    };
    return { asked, read };
  }
  const sourceReader =
    (logs: BridgeLog[] | null, status: 'success' | 'reverted' = 'success'): BridgeReceiptLogReader =>
    async () =>
      logs === null ? null : { status, logs };
  const legALogs = () => [
    { address: '0xfffffffffffffffffffffffffffffffffffffffe', topics: [id('Transfer(address,address,uint256)')], data: '0x' }, // ignored
    oftSent(SEPOLIA, GUID_A, 40232),
    packetSent(SEPOLIA, OP_SEPOLIA, GUID_A),
  ];
  function provider(src: BridgeReceiptLogReader, dst: BridgeEventLogReader, scan?: string | null) {
    return createLayerZeroOftProvider({
      deployments: STARGATE_V2_TESTNET_NATIVE_POOLS,
      readContract: async () => '0x',
      readSourceReceipt: src,
      readDestinationLogs: dst,
      ...(scan !== undefined ? { fetchMessageStatus: async () => (scan === null ? null : { status: scan }) } : {}),
    });
  }
  function transferAB(recipient = ME, amountIn = AMOUNT, route?: BridgeRoute): BridgeTransfer {
    const r = route ?? createLayerZeroOftProvider({ deployments: STARGATE_V2_TESTNET_NATIVE_POOLS, readContract: async () => '0x' })
      .supportedRoutes()
      .find((x) => x.sourceChainId === SEPOLIA && x.destinationChainId === OP_SEPOLIA)!;
    return { providerId: 'layerzero-oft', route: r, sourceTxHash: SOURCE_TX_A, amountIn, recipient };
  }

  it('computes the event topics and the retry selector from the cited signatures (ethers and the 15.1 prefixes agree)', () => {
    expect(OFT_SENT_TOPIC).toBe(id(OFT_SENT_EVENT_SIGNATURE));
    expect(OFT_RECEIVED_TOPIC).toBe(id(OFT_RECEIVED_EVENT_SIGNATURE));
    expect(PACKET_SENT_TOPIC).toBe(id(PACKET_SENT_EVENT_SIGNATURE));
    expect(UNRECEIVED_TOKEN_CACHED_TOPIC).toBe(id(UNRECEIVED_TOKEN_CACHED_EVENT_SIGNATURE));
    expect([OFT_SENT_TOPIC, OFT_RECEIVED_TOPIC, PACKET_SENT_TOPIC, UNRECEIVED_TOKEN_CACHED_TOPIC]).toEqual([
      '0x85496b760a4b7f8d66384b9df21b381f5d1b1e79f229a47aaf4c232edc2fe59a',
      '0xefed6d3500546b29533b128a29e3a94d70788727f0507505ac12eaf2e578fd9c',
      '0x1ab700d4ced0c005b164c0f789fd09fcbb0156d4c2041b8a3bfbcd961cd1567f',
      '0x007c17198cd078035dc663f9a0961f84cb6265411d0b4c793f96d432f6af4b55',
    ]);
    expect(evIface.getEvent('OFTSent')!.topicHash).toBe(OFT_SENT_TOPIC);
    expect(evIface.getEvent('UnreceivedTokenCached')!.topicHash).toBe(UNRECEIVED_TOKEN_CACHED_TOPIC);
    expect(id(STARGATE_RETRY_RECEIVE_TOKEN_SIGNATURE).slice(0, 10)).toBe(STARGATE_RETRY_RECEIVE_TOKEN_SELECTOR);
    expect(evIface.getFunction('retryReceiveToken')!.selector).toBe('0xa88835d7');
  });

  it('decodes ethers-encoded OFTSent, PacketSent, OFTReceived and UnreceivedTokenCached logs, and refuses malformed ones', () => {
    const sent = decodeOftSentLog(oftSent(SEPOLIA, GUID_A, 40232));
    expect(sent).toEqual({ emitter: pool(SEPOLIA).address, guid: GUID_A, dstEid: 40232, fromAddress: ME, amountSentLD: AMOUNT, amountReceivedLD: AMOUNT });
    const packet = decodePacketSentLog(packetSent(SEPOLIA, OP_SEPOLIA, GUID_A));
    expect(packet).toEqual({
      emitter: LAYERZERO_V2_TESTNET[SEPOLIA]!.endpoint,
      nonce: 196n,
      srcEid: 40161,
      sender: pool(SEPOLIA).messagingOApp,
      dstEid: 40232,
      receiver: pool(OP_SEPOLIA).messagingOApp,
      guid: GUID_A,
      options: STARGATE_OPTIONS,
      sendLibrary: LAYERZERO_V2_TESTNET[SEPOLIA]!.sendUln302,
    });
    // The options word: type 3, executor (1), 17 bytes, lzReceive (1), gas 150,000.
    expect(BigInt('0x' + packet.options.slice(-32))).toBe(150_000n);
    expect(decodeOftReceivedLog(oftReceived(OP_SEPOLIA, GUID_A, 40161))).toEqual({
      emitter: pool(OP_SEPOLIA).address,
      guid: GUID_A,
      srcEid: 40161,
      toAddress: ME,
      amountReceivedLD: AMOUNT,
    });
    expect(decodeUnreceivedTokenCachedLog(cached(OP_SEPOLIA, GUID_A, 40161))).toEqual({
      emitter: pool(OP_SEPOLIA).address,
      guid: GUID_A,
      index: 0,
      srcEid: 40161,
      receiver: KERNEL,
      amountLD: AMOUNT,
      composeMsg: '0x',
    });
    expect(decodeUnreceivedTokenCachedLog(cached(OP_SEPOLIA, GUID_A, 40161, KERNEL, AMOUNT, '0xabcd')).composeMsg).toBe('0xabcd');
    const s = oftSent(SEPOLIA, GUID_A, 40232);
    expect(() => decodeOftSentLog({ ...s, data: s.data + '00'.repeat(32) })).toThrow('exactly three words');
    expect(() => decodeOftSentLog({ ...s, topics: s.topics.slice(0, 2) })).toThrow('not an OFTSent');
    expect(() => decodeOftReceivedLog(s)).toThrow('not an OFTReceived');
    const badSender = { ...s, topics: [s.topics[0]!, s.topics[1]!, '0x' + 'ff'.repeat(32)] };
    expect(() => decodeOftSentLog(badSender)).toThrow('high 12 bytes');
    const c = cached(OP_SEPOLIA, GUID_A, 40161);
    expect(() => decodeUnreceivedTokenCachedLog({ ...c, data: c.data + '00'.repeat(32) })).toThrow('length does not match');
  });

  it('finds exactly one send for the route in the source receipt, and refuses ambiguous or foreign ones', () => {
    const expectA = {
      oft: pool(SEPOLIA).address,
      endpoint: LAYERZERO_V2_TESTNET[SEPOLIA]!.endpoint,
      srcEid: 40161,
      dstEid: 40232,
      sourceOApp: pool(SEPOLIA).messagingOApp,
      destinationOApp: pool(OP_SEPOLIA).messagingOApp,
    };
    expect(findLayerZeroSend(legALogs(), expectA)).toEqual({
      guid: GUID_A,
      fromAddress: ME,
      amountSentLD: AMOUNT,
      amountReceivedLD: AMOUNT,
      options: STARGATE_OPTIONS,
      nonce: 196n,
    });
    expect(findLayerZeroSend([oftSent(SEPOLIA, GUID_A, 40232)], expectA)).toBeNull(); // no PacketSent
    const otherGuid = '0x' + '12'.repeat(32);
    expect(findLayerZeroSend([oftSent(SEPOLIA, GUID_A, 40232), packetSent(SEPOLIA, OP_SEPOLIA, otherGuid)], expectA)).toBeNull();
    expect(findLayerZeroSend([oftSent(SEPOLIA, GUID_A, 40231), packetSent(SEPOLIA, OP_SEPOLIA, GUID_A)], expectA)).toBeNull(); // other dstEid
    const twice = [...legALogs(), oftSent(SEPOLIA, otherGuid, 40232), packetSent(SEPOLIA, OP_SEPOLIA, otherGuid, 197n)];
    expect(findLayerZeroSend(twice, expectA)).toBeNull();
    const fromElsewhere = { ...oftSent(SEPOLIA, GUID_A, 40232), address: OTHER };
    expect(findLayerZeroSend([fromElsewhere, packetSent(SEPOLIA, OP_SEPOLIA, GUID_A)], expectA)).toBeNull();
  });

  it('track(): delivered only on OFTReceived for the source GUID; Scan is supporting evidence', async () => {
    const dst = destinationReader([oftReceived(OP_SEPOLIA, GUID_A, 40161)]);
    const status = await provider(sourceReader(legALogs()), dst.read, 'DELIVERED').track(transferAB());
    expect(status.state).toBe('delivered');
    expect(status.onChain).toEqual({ status: 'delivered', guid: GUID_A, destinationTx: DELIVERY_TX_A, amountReceived: AMOUNT, apiStatus: 'DELIVERED' });
    expect(status.destinationTxHash).toBe(DELIVERY_TX_A);
    expect(status.detail).toBe(
      `Delivered: the receiving network shows OFTReceived for this transfer's message (GUID ${GUID_A}), 200000000000000 base units to ${ME} in transaction ${DELIVERY_TX_A}. LayerZero Scan agrees (DELIVERED).`,
    );
    expect(dst.asked[0]).toEqual({ chainId: OP_SEPOLIA, address: pool(OP_SEPOLIA).address, topics: [OFT_RECEIVED_TOPIC, GUID_A] });
    // Without Scan the chain alone decides.
    expect((await provider(sourceReader(legALogs()), dst.read).track(transferAB())).onChain!.apiStatus).toBeNull();
  });

  it('track(): Scan saying DELIVERED does not make a transfer delivered, and an OFTReceived for another GUID is ignored', async () => {
    const otherGuid = '0x' + '34'.repeat(32);
    // A reader that ignores the topic filter and returns another message's delivery.
    const sloppy: BridgeEventLogReader = async (req) => (req.topics[0] === OFT_RECEIVED_TOPIC ? [oftReceived(OP_SEPOLIA, otherGuid, 40161)] : []);
    const status = await provider(sourceReader(legALogs()), sloppy, 'DELIVERED').track(transferAB());
    expect(status.state).toBe('in-flight');
    expect(status.onChain).toEqual({ status: 'in-flight', guid: GUID_A, destinationTx: null, amountReceived: null, apiStatus: 'DELIVERED' });
    expect(status.detail).toBe(
      `The message was sent (GUID ${GUID_A}); the receiving network shows no delivery for it yet. LayerZero Scan reports DELIVERED; the wallet goes by the chains' own events.`,
    );
    const inflight = await provider(sourceReader(legALogs()), destinationReader([]).read, 'INFLIGHT').track(transferAB());
    expect(inflight.detail).toContain('LayerZero Scan agrees (INFLIGHT).');
    const blocked = await provider(sourceReader(legALogs()), destinationReader([]).read, 'BLOCKED').track(transferAB());
    expect([blocked.state, blocked.onChain!.status]).toEqual(['unknown', 'in-flight']);
    const notIndexed = await provider(sourceReader(legALogs()), destinationReader([]).read, null).track(transferAB());
    expect(notIndexed.detail).toContain('LayerZero Scan has no record of the message yet.');
  });

  it('track(): UnreceivedTokenCached gives cached-needs-retry with the retryReceiveToken call, and a later OFTReceived wins', async () => {
    const transfer = transferAB(KERNEL);
    const status = await provider(sourceReader(legALogs()), destinationReader([cached(OP_SEPOLIA, GUID_A, 40161)]).read, 'DELIVERED').track(transfer);
    expect(status.state).toBe('awaiting-destination-action');
    expect(status.onChain).toMatchObject({ status: 'cached-needs-retry', guid: GUID_A, amountReceived: null, apiStatus: 'DELIVERED' });
    expect(status.detail).toContain("Stargate could not hand over the ETH with its 2,300-gas transfer (a deployed smart account cannot accept one)");
    expect(status.detail).toContain('Anyone can deliver them by calling retryReceiveToken there, paying the gas on that network; the call below does that. It fails while the pool is paused.');
    const [retry] = status.destinationCalls!;
    expect(retry!.to).toBe(pool(OP_SEPOLIA).address);
    expect(retry!.value).toBe(0n);
    expect(toHex(retry!.data)).toBe(evIface.encodeFunctionData('retryReceiveToken', [GUID_A, 0, 40161, KERNEL, AMOUNT, '0x']));
    // After someone retries, the pool emits OFTReceived for the same GUID: delivered.
    const both = destinationReader([cached(OP_SEPOLIA, GUID_A, 40161), oftReceived(OP_SEPOLIA, GUID_A, 40161, KERNEL)]);
    expect((await provider(sourceReader(legALogs()), both.read).track(transfer)).onChain!.status).toBe('delivered');
    // A cached transfer with a compose message is reported, but no retry is built.
    const compose = await provider(sourceReader(legALogs()), destinationReader([cached(OP_SEPOLIA, GUID_A, 40161, KERNEL, AMOUNT, '0xab')]).read).track(transfer);
    expect(compose.onChain!.status).toBe('cached-needs-retry');
    expect(compose.destinationCalls).toBeUndefined();
    expect(() => encodeStargateRetryReceiveToken(decodeUnreceivedTokenCachedLog(cached(OP_SEPOLIA, GUID_A, 40161, KERNEL, AMOUNT, '0xab')))).toThrow(
      'compose message',
    );
  });

  it('track(): refuses to call mismatched, reverted, missing or ambiguous sends delivered', async () => {
    const t = transferAB();
    const track = (logs: BridgeLog[] | null, dst: BridgeLog[], tr = t, status: 'success' | 'reverted' = 'success') =>
      provider(sourceReader(logs, status), destinationReader(dst).read).track(tr);
    const toOther = await track(legALogs(), [oftReceived(OP_SEPOLIA, GUID_A, 40161, OTHER)]);
    expect([toOther.state, toOther.onChain!.status]).toEqual(['unknown', 'unknown']);
    expect(toOther.detail).toContain('does not match this transfer');
    expect((await track(legALogs(), [oftReceived(OP_SEPOLIA, GUID_A, 40161, ME, AMOUNT - 1n)])).onChain!.status).toBe('unknown');
    expect((await track(legALogs(), [oftReceived(OP_SEPOLIA, GUID_A, 40231)])).onChain!.status).toBe('unknown'); // wrong srcEid
    const reverted = await track(legALogs(), [], t, 'reverted');
    expect([reverted.state, reverted.onChain!.status]).toEqual(['failed', 'source-reverted']);
    expect(reverted.detail).toBe('The sending transaction reverted, so no message was sent and nothing was bridged; only its network fee was spent.');
    expect((await track(null, [])).detail).toBe('The sending transaction has no receipt yet; it may still be pending.');
    expect((await track([oftSent(SEPOLIA, GUID_A, 40232)], [])).onChain).toMatchObject({ status: 'unknown', guid: null });
    const amountOff = await track(legALogs(), [oftReceived(OP_SEPOLIA, GUID_A, 40161)], transferAB(ME, AMOUNT * 2n));
    expect(amountOff.onChain).toMatchObject({ status: 'unknown', guid: GUID_A });
    const wrongCache = await track(legALogs(), [cached(OP_SEPOLIA, GUID_A, 40161, OTHER)], transferAB(KERNEL));
    expect([wrongCache.onChain!.status, wrongCache.destinationCalls]).toEqual(['unknown', undefined]);
    expect(() =>
      createLayerZeroOftProvider({ deployments: STARGATE_V2_TESTNET_NATIVE_POOLS, readContract: async () => '0x', readSourceReceipt: sourceReader([]) }),
    ).toThrow('both log readers');
  });

  it('track(): leg B (OP Sepolia -> Arbitrum Sepolia) reads its own route, endpoint and GUID', async () => {
    const guidB = '0xe3d00cd678da00796ae04e89cd75c3e7a3cb62bd025e5bda502737af2150801c';
    const deliveryB = '0x27fa3f2e339e7e737daab8314fbb7787e640eec6d6b894dd134a27a287b632d8';
    const route = createLayerZeroOftProvider({ deployments: STARGATE_V2_TESTNET_NATIVE_POOLS, readContract: async () => '0x' })
      .supportedRoutes()
      .find((r) => r.sourceChainId === OP_SEPOLIA && r.destinationChainId === ARB_SEPOLIA)!;
    const logs = [oftSent(OP_SEPOLIA, guidB, 40231), packetSent(OP_SEPOLIA, ARB_SEPOLIA, guidB, 588n)];
    const dst = destinationReader([oftReceived(ARB_SEPOLIA, guidB, 40232, ME, AMOUNT, deliveryB)]);
    const status = await provider(sourceReader(logs), dst.read).track({ ...transferAB(ME, AMOUNT, route), sourceTxHash: '0xfa79787a5ff824e6cc5e1aa61e06a97feb5987627f29010cee67dd57ad9fdf02' });
    expect(status.onChain).toEqual({ status: 'delivered', guid: guidB, destinationTx: deliveryB, amountReceived: AMOUNT, apiStatus: null });
    expect(dst.asked[0]!.chainId).toBe(ARB_SEPOLIA);
  });

  // Pass p23-cctp-recheck: the receiving chain is searched from the
  // sending transaction's time (bridge/search.ts) when a block reader is
  // given. Sepolia at 12 s per block, OP Sepolia at 2 s; the send at
  // 2026-10-15 05:28:00 UTC (leg A's day).
  const SEND_BLOCK = 11_917_629n;
  const SEND_TS = 1_792_042_080n;
  const sepTs = (n: bigint) => SEND_TS - (SEND_BLOCK - n) * 12n;
  const OP_AT_SEND = 50_115_500n;
  const opTs = (n: bigint) => SEND_TS - (OP_AT_SEND - n) * 2n;
  function timedReader(opHead: bigint): BridgeBlockReader {
    return async ({ chainId, block }) => {
      const head = chainId === OP_SEPOLIA ? opHead : SEND_BLOCK + 100n;
      const n = block === 'latest' ? head : block;
      if (n > head) throw new Error('beyond the head');
      return { number: n, timestamp: chainId === OP_SEPOLIA ? opTs(n) : sepTs(n) };
    };
  }
  function rangedReader(logs: BridgeLog[]) {
    const asked: Parameters<BridgeEventLogReader>[0][] = [];
    const read: BridgeEventLogReader = async (req) => {
      asked.push(req);
      return logs.filter(
        (l) =>
          l.address.toLowerCase() === req.address.toLowerCase() &&
          (req.fromBlock === undefined || BigInt(l.blockNumber!) >= req.fromBlock) &&
          (req.toBlock === undefined || BigInt(l.blockNumber!) <= req.toBlock) &&
          req.topics.every((t, i) => t === null || l.topics[i] === t),
      );
    };
    return { asked, read };
  }
  const timedProvider = (dst: BridgeEventLogReader, opHead: bigint, scan?: string | null) =>
    createLayerZeroOftProvider({
      deployments: STARGATE_V2_TESTNET_NATIVE_POOLS,
      readContract: async () => '0x',
      readSourceReceipt: async () => ({ status: 'success', logs: legALogs(), blockNumber: SEND_BLOCK }),
      readDestinationLogs: dst,
      readBlock: timedReader(opHead),
      ...(scan !== undefined ? { fetchMessageStatus: async () => (scan === null ? null : { status: scan }) } : {}),
    });
  const atBlock = (l: BridgeLog, n: bigint): BridgeLog => ({ ...l, blockNumber: '0x' + n.toString(16) });

  it('track() with a block reader: searched from the receiving block at the send’s time less 10 minutes, in 9,000-block windows, delivered when found', async () => {
    const delivery = atBlock(oftReceived(OP_SEPOLIA, GUID_A, 40161), OP_AT_SEND + 45n);
    const dst = rangedReader([delivery]);
    const st = await timedProvider(dst.read, OP_AT_SEND + 200_000n, 'DELIVERED').track(transferAB());
    expect(st.state).toBe('delivered');
    expect(st.destinationTxHash).toBe(DELIVERY_TX_A);
    const start = OP_AT_SEND - 300n; // 600 s at 2 s per block
    expect(st.onChain!.search).toMatchObject({ fromBlock: start, toBlock: OP_AT_SEND + 200_000n, fromTimestamp: SEND_TS - 600n, bounded: false });
    expect(dst.asked).toEqual([{ chainId: OP_SEPOLIA, address: pool(OP_SEPOLIA).address, topics: [OFT_RECEIVED_TOPIC, GUID_A], fromBlock: start, toBlock: start + 8_999n }]);
  });

  it('track() with a block reader: a delivery older than the old 108,000-block cap is still found (the search is not capped by a block count)', async () => {
    const late = OP_AT_SEND + 150_000n; // about 3.5 days of 2-second blocks after the send
    const dst = rangedReader([atBlock(oftReceived(OP_SEPOLIA, GUID_A, 40161), late)]);
    const st = await timedProvider(dst.read, OP_AT_SEND + 200_000n).track(transferAB());
    expect(st.state).toBe('delivered');
    expect(dst.asked.length).toBeGreaterThan(12);
  });

  it('track() with a block reader: nothing found within the week the wallet searches → not known, the span and range stated, Scan beside it', async () => {
    const head = OP_AT_SEND + (8n * 86_400n) / 2n; // 8 days of 2-second blocks
    const dst = rangedReader([]);
    const st = await timedProvider(dst.read, head, 'DELIVERED').track(transferAB());
    const search = st.onChain!.search!;
    expect(search.bounded).toBe(true);
    expect(search.toBlock).toBe(OP_AT_SEND - 300n + BRIDGE_SEARCH_BOUND_SECONDS / 2n);
    expect(search.toTimestamp - search.fromTimestamp).toBe(BRIDGE_SEARCH_BOUND_SECONDS);
    expect(st.state).toBe('unknown');
    expect(st.onChain!.status).toBe('unknown');
    expect(st.detail).toBe(
      `The message was sent (GUID ${GUID_A}), but no delivery for it was found in the 168 hours this wallet searched on the receiving network (blocks ${search.fromBlock} to ${search.toBlock}, from 2026-10-15 05:18 UTC to 2026-10-22 05:18 UTC), which is as far as it searches after the sending transaction, so the wallet cannot tell whether it arrived later. LayerZero Scan reports DELIVERED; the wallet goes by the chains' own events.`,
    );
    expect(st.detail).not.toMatch(/too long ago/);
    // Both the delivery and the cache were searched over the whole planned span, never past it.
    expect(dst.asked.every((q) => q.toBlock! <= search.toBlock && q.fromBlock! >= search.fromBlock)).toBe(true);
    expect(dst.asked.filter((q) => q.topics[0] === UNRECEIVED_TOKEN_CACHED_TOPIC).length).toBeGreaterThan(0);
  });

  it('track() with a block reader: a cached transfer deep in the span stops the search at its window', async () => {
    const transfer = transferAB(KERNEL);
    const hit = OP_AT_SEND + 40_000n;
    const dst = rangedReader([atBlock(cached(OP_SEPOLIA, GUID_A, 40161), hit)]);
    const st = await createLayerZeroOftProvider({
      deployments: STARGATE_V2_TESTNET_NATIVE_POOLS,
      readContract: async () => '0x',
      readSourceReceipt: async () => ({ status: 'success', logs: [oftSent(SEPOLIA, GUID_A, 40232, AMOUNT, KERNEL), packetSent(SEPOLIA, OP_SEPOLIA, GUID_A)], blockNumber: SEND_BLOCK }),
      readDestinationLogs: dst.read,
      readBlock: timedReader(OP_AT_SEND + 300_000n),
    }).track(transfer);
    expect(st.onChain!.status).toBe('cached-needs-retry');
    const cachedAsks = dst.asked.filter((q) => q.topics[0] === UNRECEIVED_TOKEN_CACHED_TOPIC);
    expect(cachedAsks[cachedAsks.length - 1]!.toBlock! >= hit).toBe(true);
    expect(cachedAsks[cachedAsks.length - 1]!.toBlock! < OP_AT_SEND + 300_000n).toBe(true);
  });

  describe('quotes', () => {
    const quoteOftAnswer = (sent: bigint, received: bigint) => oftIface.encodeFunctionResult('quoteOFT', [[1n, 10n ** 21n], [], [sent, received]]);
    const read = async (req: { data: string }) => {
      if (req.data.startsWith(OFT_QUOTE_OFT_SELECTOR)) {
        const amount = oftIface.decodeFunctionData('quoteOFT', req.data)[0][2] as bigint;
        return quoteOftAnswer(amount, amount - 1_000_000_000_000n);
      }
      return coder.encode(['tuple(uint256,uint256)'], [[102_050_140_082_558n, 0n]]);
    };
    const routeOf = (from: number, to: number) =>
      createLayerZeroOftProvider({ deployments: STARGATE_V2_TESTNET_NATIVE_POOLS, readContract: read }).supportedRoutes().find((r) => r.sourceChainId === from && r.destinationChainId === to)!;

    it('time: carries the one live measurement per route, never as a promise, with singular and plural confirmations', async () => {
      const p = createLayerZeroOftProvider({ deployments: STARGATE_V2_TESTNET_NATIVE_POOLS, readContract: read });
      const summary =
        'Measured once on the test networks on 2026-10-15: 90 s Sepolia → OP Sepolia, 30 s OP Sepolia → Arbitrum Sepolia (from the sending block to the delivery block, one 0.0002 ETH transfer each).';
      const a = (await p.quote({ route: routeOf(SEPOLIA, OP_SEPOLIA), amount: AMOUNT, sender: ME, recipient: ME })).time;
      expect(a.source).toBe(
        `${summary} This route took 90 s that once. Not a promise: the verifiers wait for 2 source-block confirmations, then the executor delivers, and either can take longer.`,
      );
      expect(a.measured).toEqual({ seconds: 90, date: '2026-10-15', description: 'Measured once on 2026-10-15, from the sending block to the delivery block.' });
      expect([a.minSeconds, a.maxSeconds]).toEqual([null, null]);
      const b = (await p.quote({ route: routeOf(OP_SEPOLIA, ARB_SEPOLIA), amount: AMOUNT, sender: ME, recipient: ME })).time;
      expect(b.source).toBe(
        `${summary} This route took 30 s that once. Not a promise: the verifiers wait for 1 source-block confirmation, then the executor delivers, and either can take longer.`,
      );
      const c = (await p.quote({ route: routeOf(ARB_SEPOLIA, SEPOLIA), amount: AMOUNT, sender: ME, recipient: ME })).time;
      expect(c.source).toContain('This route was not measured. Not a promise: the verifiers wait for 5 source-block confirmations');
      expect(c.measured).toBeUndefined();
      const { measuredDelivery: _dropped, ...unmeasured } = pool(OP_SEPOLIA);
      expect(oftTimeEstimate(unmeasured, ARB_SEPOLIA, 1).source).toBe(
        'Not measured on the test networks. Not a promise: the verifiers wait for 1 source-block confirmation, then the executor delivers.',
      );
    });

    it('fee lines name the native coin as the caller asks, "ETH" by default', async () => {
      const p = createLayerZeroOftProvider({ deployments: STARGATE_V2_TESTNET_NATIVE_POOLS, readContract: read });
      const route = routeOf(SEPOLIA, ARB_SEPOLIA);
      const plain = await p.quote({ route, amount: AMOUNT, sender: ME, recipient: ME });
      expect(plain.fees.map((f) => f.asset.symbol)).toEqual(['ETH', 'ETH']);
      expect(plain.fees[0]!.description).toBe(
        'LayerZero messaging fee (verifiers, executor and destination gas), paid in ETH; any excess is refunded to your address.',
      );
      const test = await p.quote({ route, amount: AMOUNT, sender: ME, recipient: ME, nativeSymbol: 'test ETH' });
      expect(test.fees.map((f) => [f.kind, f.asset.symbol])).toEqual([
        ['messaging', 'test ETH'],
        ['pool', 'test ETH'],
      ]);
      expect(test.fees[0]!.description).toBe(
        'LayerZero messaging fee (verifiers, executor and destination gas), paid in test ETH; any excess is refunded to your address.',
      );
      // The route itself still names the asset as the pool does.
      expect(test.route.sourceAsset.symbol).toBe('ETH');
      await expect(p.quote({ route, amount: AMOUNT, sender: ME, recipient: ME, nativeSymbol: '' })).rejects.toThrow('native coin symbol');
      await expect(p.quote({ route, amount: AMOUNT, sender: ME, recipient: ME, nativeSymbol: 'ETH<script>' })).rejects.toThrow('native coin symbol');
    });

    it('gasEstimate: null without an estimator, the estimator\'s figure with one, null with a note when it fails', async () => {
      const route = routeOf(SEPOLIA, OP_SEPOLIA);
      const none = await createLayerZeroOftProvider({ deployments: STARGATE_V2_TESTNET_NATIVE_POOLS, readContract: read }).quote({ route, amount: AMOUNT, sender: ME, recipient: ME });
      expect(none.gasEstimate).toBeNull();
      const asked: unknown[] = [];
      const p = createLayerZeroOftProvider({
        deployments: STARGATE_V2_TESTNET_NATIVE_POOLS,
        readContract: read,
        estimateGas: async (req) => {
          asked.push(req);
          return 341_035n; // leg A's eth_estimateGas
        },
      });
      const q = await p.quote({ route, amount: AMOUNT, sender: ME, recipient: ME });
      expect(q.gasEstimate).toBe(341_035n);
      expect(asked).toEqual([{ chainId: SEPOLIA, from: ME, to: pool(SEPOLIA).address, value: q.calls[0]!.value, data: toHex(q.calls[0]!.data) }]);
      const failing = createLayerZeroOftProvider({
        deployments: STARGATE_V2_TESTNET_NATIVE_POOLS,
        readContract: read,
        estimateGas: async () => {
          throw new Error('insufficient funds for gas * price + value');
        },
      });
      const f = await failing.quote({ route, amount: AMOUNT, sender: ME, recipient: ME });
      expect(f.gasEstimate).toBeNull();
      expect(f.notes).toContain(
        'The network could not estimate the gas for this send (insufficient funds for gas * price + value); it may fail if sent as quoted.',
      );
      const zero = createLayerZeroOftProvider({ deployments: STARGATE_V2_TESTNET_NATIVE_POOLS, readContract: read, estimateGas: async () => 0n });
      await expect(zero.quote({ route, amount: AMOUNT, sender: ME, recipient: ME })).rejects.toThrow('positive amount of gas');
    });

    it('gasEstimate: not estimated when an approval has to be mined first', async () => {
      const token = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
      const pathway = pool(SEPOLIA).pathways[OP_SEPOLIA]!;
      const adapter: OftDeployment = {
        chainId: SEPOLIA,
        address: '0x000000000000000000000000000000000000bEEF',
        kind: 'oft-adapter',
        assetGroup: 'test-group',
        asset: { kind: 'erc20', address: token, symbol: 'TST', decimals: 6 },
        sharedDecimals: 6,
        messagingOApp: '0x000000000000000000000000000000000000bEEF',
        controlNote: 'test',
        pathways: { [OP_SEPOLIA]: pathway },
      };
      const peer: OftDeployment = { ...adapter, chainId: OP_SEPOLIA, kind: 'oft', pathways: { [SEPOLIA]: { ...pathway } } };
      let called = 0;
      const p = createLayerZeroOftProvider({
        deployments: [adapter, peer],
        readContract: async (req) => (req.data.startsWith(OFT_QUOTE_OFT_SELECTOR) ? quoteOftAnswer(1_000_000n, 1_000_000n) : read(req)),
        estimateGas: async () => {
          called += 1;
          return 1n;
        },
      });
      const route = p.supportedRoutes().find((r) => r.sourceChainId === SEPOLIA)!;
      const q = await p.quote({ route, amount: 1_000_000n, sender: ME, recipient: ME });
      expect([q.gasEstimate, called]).toEqual([null, 0]);
      expect(q.notes).toContain('Gas for the send is not estimated here: the approval must be mined first, or the estimate fails.');
      // A deployment without live notes adds none of the Stargate observations.
      expect(q.notes.some((n) => n.includes('lzReceive gas limit'))).toBe(false);
    });

    it("notes: Stargate's own executor option and the observed pool fee, as observations", async () => {
      const p = createLayerZeroOftProvider({ deployments: STARGATE_V2_TESTNET_NATIVE_POOLS, readContract: read });
      const q = await p.quote({ route: routeOf(SEPOLIA, OP_SEPOLIA), amount: AMOUNT, sender: ME, recipient: ME });
      expect(STARGATE_TESTNET_NATIVE_LIVE_NOTES).toEqual([
        "Stargate attaches its own executor option to every message from these pools: an lzReceive gas limit of 150,000 (option type 3), seen in the packets of both live transfers on 2026-10-15. The wallet's own extraOptions stay empty.",
        "Stargate's pool fee, as the pools quoted it on 2026-10-15: exactly 10^12 wei (0.000001 ETH, one shared-decimal unit) at both 0.0001 and 0.0002 ETH on the routes that charge one, and none on Sepolia → OP Sepolia or OP Sepolia → Arbitrum Sepolia. That looks like a flat one-unit fee at these sizes, but Stargate's fee library was not read, so it is an observation, not a promise; the fee lines above are what the pool quoted just now.",
      ]);
      for (const note of STARGATE_TESTNET_NATIVE_LIVE_NOTES) expect(q.notes).toContain(note);
      // The wallet's own options stay empty in the call it builds.
      expect(oftIface.decodeFunctionData('send', q.calls[0]!.data)[0][4]).toBe('0x');
    });
  });
});


describe('bridge search: the receiving chain searched from the sending transaction’s time (pass p23-cctp-recheck)', () => {
  // An irregular chain: 0.25 s blocks (timestamps repeat four times, as on
  // Arbitrum Sepolia), then 0.2 s (Base Sepolia), then 12 s (Ethereum).
  const T0 = 1_700_000_000n;
  const ts = (n: bigint) =>
    n < 3_000_000n ? T0 + n / 4n : n < 6_000_000n ? T0 + 750_000n + (n - 3_000_000n) / 5n : T0 + 1_350_000n + (n - 6_000_000n) * 12n;
  const HEAD = 6_100_000n;
  function chain(head = HEAD) {
    const asked: bigint[] = [];
    let latest = 0;
    const read: BridgeBlockReader = async ({ chainId, block }) => {
      if (chainId !== 7) throw new Error('another chain');
      if (block === 'latest') {
        latest += 1;
        return { number: head, timestamp: ts(head) };
      }
      if (block > head) throw new Error('beyond the head');
      asked.push(block);
      return { number: block, timestamp: ts(block) };
    };
    return { read, asked, latestReads: () => latest };
  }
  const correct = (r: bigint, target: bigint, head = HEAD) => ts(r) <= target && (r === head || ts(r + 1n) > target);

  it('finds the highest block at or before a time on a chain with irregular block times, in few reads', async () => {
    let seed = 12345n;
    const targets: bigint[] = [ts(0n), ts(1n), ts(2_999_999n), ts(3_000_000n), ts(5_999_999n), ts(6_000_000n), ts(HEAD) - 1n, ts(HEAD) - 13n];
    for (let i = 0; i < 120; i++) {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n;
      targets.push(T0 + (seed % (ts(HEAD) - T0)));
    }
    let worst = 0;
    for (const target of targets) {
      const c = chain();
      const { block, reads } = await findBlockAtOrBefore(c.read, 7, target);
      expect(correct(block.number, target)).toBe(true);
      expect(block.timestamp).toBe(ts(block.number));
      worst = Math.max(worst, reads);
    }
    expect(worst).toBeLessThanOrEqual(BRIDGE_BLOCK_SEARCH_MAX_PROBES);
    // On a steady stretch (well inside the 12 s blocks) a few reads do: interpolation lands next to the answer.
    // (Across a change of block time the interpolation is poor and the bisection steps carry it.)
    for (const n of [6_050_000n, 6_080_000n, 6_099_000n]) {
      const { block, reads } = await findBlockAtOrBefore(chain().read, 7, ts(n) + 5n);
      expect(block.number).toBe(n);
      expect(reads).toBeLessThanOrEqual(8);
    }
    // A time at or after the head gives the head; before the first block, block 0.
    expect((await findBlockAtOrBefore(chain().read, 7, ts(HEAD) + 100n)).block.number).toBe(HEAD);
    expect((await findBlockAtOrBefore(chain().read, 7, T0 - 5n)).block.number).toBe(0n);
  });

  it('never asks for blocks much older than the answer, so a pruned node can serve it (base-sepolia-rpc.publicnode.com refused block 33,554,432 on 2026-10-27)', async () => {
    // A Base Sepolia-like chain (0.2 s blocks) whose node keeps only blocks from 46,500,000, as publicnode answered.
    const B0 = 1_783_000_000n;
    const bts = (n: bigint) => B0 + n / 5n;
    const head = 50_745_664n;
    const asked: bigint[] = [];
    const pruned: BridgeBlockReader = async ({ block }) => {
      const n = block === 'latest' ? head : block;
      if (n < 46_500_000n) throw new Error(`pruned history unavailable: requested ${n}, earliest available 46500000`);
      asked.push(n);
      return { number: n, timestamp: bts(n) };
    };
    for (const back of [1_000n, 300_000n, 3_024_000n]) {
      asked.length = 0;
      const want = head - back;
      const { block, reads } = await findBlockAtOrBefore(pruned, 84532, bts(want));
      expect(block.number).toBe((want / 5n) * 5n + 4n); // five blocks share each second: the last of them
      expect(reads).toBeLessThanOrEqual(12);
      expect(asked.every((n) => n >= want - back / 2n - 1_000n)).toBe(true);
    }
    // Bisecting from block 0 would have asked for block 25,372,832 or older first and failed there.
    await expect(pruned({ chainId: 84532, block: 25_372_832n })).rejects.toThrow('pruned history unavailable');
  });

  // Phase 23 item 8, the hygiene slice: a node that refuses the target's
  // blocks as pruned history (reth's code 4444) bounds the plan at the
  // oldest block it serves, and says so; any other error still throws.
  describe('a node that prunes history below a block', () => {
    const B0 = 1_783_000_000n;
    const bts = (n: bigint) => B0 + n / 5n; // Base Sepolia-like: 0.2 s blocks, five per second
    const HEAD_B = 50_745_664n;
    const EARLIEST = 46_500_000n;
    // The message the engine's httpTransport builds from reth's answer (rpc.ts: "RPC error <code>: <message> (<method>)").
    const rethError = (n: bigint, earliest: bigint) =>
      new Error(`RPC error 4444: pruned history unavailable: requested ${n}, earliest available ${earliest} (eth_getBlockByNumber)`);
    function prunedChain(earliestAt: (reads: number, asked: bigint) => bigint, makeError = rethError) {
      const asked: bigint[] = [];
      let reads = 0;
      const read: BridgeBlockReader = async ({ block }) => {
        reads += 1;
        const n = block === 'latest' ? HEAD_B : block;
        const earliest = earliestAt(reads, n);
        if (n < earliest) throw makeError(n, earliest);
        asked.push(n);
        return { number: n, timestamp: bts(n) };
      };
      return { read, asked };
    }

    it('recognises reth\'s pruned-history answer by its code AND the word "pruned", through the engine\'s own transport', async () => {
      expect(PRUNED_HISTORY_ERROR_CODE).toBe(4444);
      const fetchFn = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ jsonrpc: '2.0', id: 1, error: { code: 4444, message: 'pruned history unavailable: requested 33554432, earliest available 46500000' } }),
      })) as unknown as typeof fetch;
      const e = await httpTransport('https://node.example', fetchFn)('eth_getBlockByNumber', ['0x2000000', false]).catch((x: unknown) => x);
      expect(isPrunedHistoryError(e)).toBe(true);
      expect(prunedEarliestAvailable(e)).toBe(46_500_000n);
      // A coded error object (another transport) with the word, too.
      expect(isPrunedHistoryError(Object.assign(new Error('state at block 5 is pruned'), { code: 4444 }))).toBe(true);
      // Not: the code without the word, the word without the code, another code, a timeout, a non-error.
      expect(isPrunedHistoryError(new Error('RPC error 4444: something else (eth_getBlockByNumber)'))).toBe(false);
      expect(isPrunedHistoryError(new Error('pruned history unavailable: requested 5, earliest available 100'))).toBe(false);
      expect(isPrunedHistoryError(new Error('RPC error -32000: pruned history unavailable (eth_getBlockByNumber)'))).toBe(false);
      expect(isPrunedHistoryError(new Error('RPC error 44440: pruned (eth_getBlockByNumber)'))).toBe(false);
      expect(isPrunedHistoryError(new Error('The operation was aborted due to timeout'))).toBe(false);
      expect(isPrunedHistoryError('RPC error 4444: pruned')).toBe(false);
      expect(prunedEarliestAvailable(new Error('RPC error 4444: pruned'))).toBe(null);
    });

    it('a target in the pruned part: the oldest block the node serves, with prunedBelow set to it', async () => {
      for (const make of [rethError, (n: bigint) => Object.assign(new Error(`history pruned, block ${n}`), { code: 4444 })]) {
        const c = prunedChain(() => EARLIEST, make);
        const r = await findBlockAtOrBefore(c.read, BASE_SEPOLIA, bts(30_000_000n));
        expect(r.block.number).toBe(EARLIEST);
        expect(r.block.timestamp).toBe(bts(EARLIEST));
        expect(r.prunedBelow).toBe(EARLIEST);
        expect(r.reads).toBeLessThanOrEqual(BRIDGE_BLOCK_SEARCH_MAX_PROBES);
        expect(c.asked.every((n) => n >= EARLIEST)).toBe(true);
      }
    });

    it('a target the node still serves, even when a step back lands in the pruned part: the usual answer, no prunedBelow', async () => {
      for (const want of [EARLIEST, EARLIEST + 1n, EARLIEST + 7n, EARLIEST + 40_000n]) {
        const c = prunedChain(() => EARLIEST);
        const target = bts(want);
        const r = await findBlockAtOrBefore(c.read, BASE_SEPOLIA, target);
        expect(bts(r.block.number) <= target && bts(r.block.number + 1n) > target).toBe(true);
        expect(r.prunedBelow).toBeUndefined();
      }
    });

    it('the node prunes further while the search runs: the oldest block it serves at the end, with prunedBelow', async () => {
      const later = EARLIEST + 5_000n;
      let floorNow = EARLIEST;
      const asked: bigint[] = [];
      const read: BridgeBlockReader = async ({ block }) => {
        const n = block === 'latest' ? HEAD_B : block;
        if (n < floorNow) throw rethError(n, floorNow);
        asked.push(n);
        // Once a block at or before the target has been answered (the search
        // is then narrowing between it and a later block), the node prunes up
        // to `later`, past that block.
        if (n <= EARLIEST + 1_000n) floorNow = later;
        return { number: n, timestamp: bts(n) };
      };
      const r = await findBlockAtOrBefore(read, BASE_SEPOLIA, bts(EARLIEST + 1_000n));
      expect(floorNow).toBe(later);
      expect(asked.some((n) => n <= EARLIEST + 1_000n)).toBe(true);
      expect(r.block.number).toBe(later);
      expect(r.prunedBelow).toBe(later);
    });

    it('planDestinationSearch starts at the oldest served block, reports prunedBelow, and caches nothing for it', async () => {
      const cache = new Map();
      const c = prunedChain(() => EARLIEST);
      const plan = await planDestinationSearch(c.read, { chainId: BASE_SEPOLIA, sinceTimestamp: bts(40_000_000n), cache, boundSeconds: 30n * 86_400n });
      expect(plan).toMatchObject({ fromBlock: EARLIEST, fromTimestamp: bts(EARLIEST), toBlock: HEAD_B, bounded: false, prunedBelow: EARLIEST });
      expect(cache.size).toBe(0);
      const c2 = prunedChain(() => EARLIEST);
      const again = await planDestinationSearch(c2.read, { chainId: BASE_SEPOLIA, sinceTimestamp: bts(40_000_000n), cache, boundSeconds: 30n * 86_400n });
      expect(again.prunedBelow).toBe(EARLIEST);
      expect(c2.asked.length).toBeGreaterThan(1);
      // A target the node serves: no prunedBelow on the plan.
      const ok = await planDestinationSearch(prunedChain(() => EARLIEST).read, { chainId: BASE_SEPOLIA, sinceTimestamp: bts(HEAD_B - 100_000n) });
      expect(ok.prunedBelow).toBeUndefined();
      expect('prunedBelow' in ok).toBe(false);
    });

    it('any other error during the search still throws', async () => {
      for (const make of [
        (n: bigint) => new Error(`RPC error 4444: unknown block ${n} (eth_getBlockByNumber)`),
        (n: bigint) => new Error(`pruned history unavailable: requested ${n}, earliest available 46500000`),
        () => new Error('fetch failed: connection reset'),
      ]) {
        const c = prunedChain(() => EARLIEST, make);
        await expect(findBlockAtOrBefore(c.read, BASE_SEPOLIA, bts(30_000_000n))).rejects.toThrow();
      }
    });
  });

  it('with a cache, a later pass for the same time reads nothing but the head', async () => {
    const cache = new Map();
    const a = chain();
    const first = await planDestinationSearch(a.read, { chainId: 7, sinceTimestamp: ts(6_080_000n), cache });
    const b = chain(HEAD + 75n);
    const again = await planDestinationSearch(b.read, { chainId: 7, sinceTimestamp: ts(6_080_000n), cache });
    expect(a.asked.length).toBeGreaterThan(0);
    expect(b.asked).toEqual([]);
    expect(again.fromBlock).toBe(first.fromBlock);
  });

  it('plans from the block 10 minutes before the send to the head, or to a week later when the head is further', async () => {
    expect(BRIDGE_SEARCH_START_MARGIN_SECONDS).toBe(600n);
    expect(BRIDGE_SEARCH_BOUND_SECONDS).toBe(604_800n);
    expect(BRIDGE_SEARCH_WINDOW_BLOCKS).toBe(9_000n);
    const since = ts(6_080_000n); // 20,000 blocks of 12 s before the head: under a week
    const near = await planDestinationSearch(chain().read, { chainId: 7, sinceTimestamp: since });
    expect(correct(near.fromBlock, since - 600n)).toBe(true);
    expect(near).toMatchObject({ toBlock: HEAD, toTimestamp: ts(HEAD), bounded: false });
    // A send two months back on the 0.25 s segment: the head is beyond the week, so the search stops a week after the start.
    const old = ts(1_000_000n);
    const far = await planDestinationSearch(chain().read, { chainId: 7, sinceTimestamp: old });
    expect(correct(far.fromBlock, old - 600n)).toBe(true);
    expect(far.bounded).toBe(true);
    expect(far.toBlock < HEAD && far.toBlock > far.fromBlock).toBe(true);
    // The end block is estimated from the two ends' timestamps, then read: the span stated is the span searched.
    expect(far.toTimestamp).toBe(ts(far.toBlock));
    expect(far.toTimestamp - far.fromTimestamp).toBeGreaterThan(0n);
    expect(searchRangeText(far)).toBe(`blocks ${far.fromBlock} to ${far.toBlock}, from ${searchTimeText(far.fromTimestamp)} to ${searchTimeText(far.toTimestamp)}`);
    await expect(planDestinationSearch(chain().read, { chainId: 7, sinceTimestamp: since, boundSeconds: 0n })).rejects.toThrow('must be positive');
  });

  it('searches the plan forward in 9,000-block windows, stopping at the window where the caller’s test is met', async () => {
    const asked: [bigint, bigint][] = [];
    const hit: BridgeLog = { address: OTHER, topics: ['0x01'], data: '0x', blockNumber: '0x' + (20_500n).toString(16) };
    const read: BridgeEventLogReader = async (q) => {
      asked.push([q.fromBlock!, q.toBlock!]);
      return BigInt(hit.blockNumber!) >= q.fromBlock! && BigInt(hit.blockNumber!) <= q.toBlock! ? [hit] : [];
    };
    const all = await searchPlannedLogs(read, { fromBlock: 1_000n, toBlock: 40_000n }, { chainId: 7, address: OTHER, topics: [] });
    expect(all).toEqual([hit]);
    expect(asked).toEqual([[1_000n, 9_999n], [10_000n, 18_999n], [19_000n, 27_999n], [28_000n, 36_999n], [37_000n, 40_000n]]);
    asked.length = 0;
    await searchPlannedLogs(read, { fromBlock: 1_000n, toBlock: 40_000n }, { chainId: 7, address: OTHER, topics: [] }, (logs) => logs.length > 0);
    expect(asked).toEqual([[1_000n, 9_999n], [10_000n, 18_999n], [19_000n, 27_999n]]);
  });

  it('words a span and a time plainly', () => {
    expect(searchSpanText(604_800n)).toBe('168 hours');
    expect(searchSpanText(90n)).toBe('2 minutes');
    expect(searchSpanText(60n)).toBe('1 minute');
    expect(searchSpanText(7_200n)).toBe('2 hours');
    expect(searchTimeText(1_793_017_431n)).toBe('2026-10-26 12:23 UTC');
  });

  it('refuses a node that answers another block than the one asked for', async () => {
    const liar: BridgeBlockReader = async ({ block }) => ({ number: block === 'latest' ? 1_000n : (block as bigint) + 1n, timestamp: 5n });
    await expect(findBlockAtOrBefore(liar, 7, 1n)).rejects.toThrow('when block');
  });
});
