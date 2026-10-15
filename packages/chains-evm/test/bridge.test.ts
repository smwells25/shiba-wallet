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
