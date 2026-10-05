import { describe, expect, it } from 'vitest';
import { AbiCoder, Interface, dnsEncode, ensNormalize, id, namehash as ethersNamehash } from 'ethers';
import {
  ENS_ERROR_SELECTORS,
  ENS_UNIVERSAL_RESOLVER,
  EnsResolutionError,
  classifyEnsRevert,
  decodeEnsAddrResult,
  decodeUniversalResolveResult,
  dnsEncodeName,
  encodeEnsAddrCall,
  encodeUniversalResolve,
  labelhash,
  namehash,
  normalizeEnsNameAscii,
  resolveEnsAddress,
  reverifyEnsResolution,
} from '../src/ens.js';
import { toBytes, toHex } from '../src/encoding.js';
import type { JsonRpcTransport } from '../src/rpc.js';

const ur = new Interface([
  'function resolve(bytes name, bytes data) view returns (bytes result, address resolver)',
  'function addr(bytes32 node) view returns (address)',
  'error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData)',
  'error ResolverNotFound(bytes name)',
  'error ResolverNotContract(bytes name, address resolver)',
  'error UnsupportedResolverProfile(bytes4 selector)',
  'error ResolverError(bytes errorData)',
  'error HttpError(uint16 status, string message)',
]);
const coder = AbiCoder.defaultAbiCoder();

const NICK = '0xb8c2C29ee19D8307cb7255e1Cd9CbDE883A267d5';
const RESOLVER = '0x4976fb03C32e5B8cfe2b6cCB31c09Ba78EBaBa41';

describe('namehash and labelhash (EIP-137)', () => {
  // The three vectors printed in EIP-137 ("namehash('') = 0x00…", etc.).
  it('matches the EIP-137 test vectors', () => {
    expect(toHex(namehash(''))).toBe('0x' + '00'.repeat(32));
    expect(toHex(namehash('eth'))).toBe(
      '0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae',
    );
    expect(toHex(namehash('foo.eth'))).toBe(
      '0xde9b09fd7c5f901e23a3f19fecc54828e9c848539801e86591bd9801b019f84f',
    );
  });

  // The worked example in the ENS docs (src/pages/resolution/names.mdx).
  it('matches the ENS docs worked example for ens.eth and the reverse node', () => {
    expect(toHex(labelhash('eth'))).toBe(
      '0x4f5b812789fc606be1b3b16908db13fc7a9adf7ca72641f84d75b47069d3d7f0',
    );
    expect(toHex(labelhash('ens'))).toBe(
      '0x5cee339e13375638553bdf5a6e36ba80fb9f6a4f0783680884d92b558aa471da',
    );
    expect(toHex(namehash('ens.eth'))).toBe(
      '0x4e34d3a81dc3a20f71bbdf2160492ddaa17ee7e5523757d47153379c13cb46df',
    );
    expect(toHex(namehash('481f50a5bdccc0bc4322c4dca04301433ded50f0.addr.reverse'))).toBe(
      '0x58354ffdde6ac279f3a058aafbeeb14059bcb323a248fb338ee41f95fa544c86',
    );
  });

  it('equals ethers namehash on assorted names', () => {
    for (const name of ['nick.eth', 'vitalik.eth', 'a.b.c.d.eth', 'my-name.xyz', 'x1.box', '0.eth']) {
      expect(toHex(namehash(name))).toBe(ethersNamehash(name));
    }
  });

  it('refuses an empty label', () => {
    expect(() => namehash('a..eth')).toThrow(/empty label/);
    expect(() => namehash('.eth')).toThrow(/empty label/);
  });
});

describe('DNS encoding', () => {
  it('matches the ENS docs examples and ethers dnsEncode', () => {
    expect(toHex(dnsEncodeName('my.name.eth'))).toBe('0x026d79046e616d650365746800');
    expect(toHex(dnsEncodeName('name.eth'))).toBe('0x046e616d650365746800');
    for (const name of ['nick.eth', 'a.b.c.eth', 'ur.integration-tests.eth']) {
      expect(toHex(dnsEncodeName(name))).toBe(dnsEncode(name));
    }
    expect(toHex(dnsEncodeName(''))).toBe('0x00');
  });

  it('refuses empty and over-long labels', () => {
    expect(() => dnsEncodeName('a..eth')).toThrow(/empty label/);
    expect(() => dnsEncodeName(`${'a'.repeat(256)}.eth`)).toThrow(/255/);
    expect(toHex(dnsEncodeName(`${'a'.repeat(255)}.eth`)).slice(0, 4)).toBe('0xff');
  });
});

describe('normalizeEnsNameAscii (the supported ASCII subset of ENSIP-15)', () => {
  it('accepts the subset and agrees with ethers ensNormalize on every accepted input', () => {
    const accepted = [
      'nick.eth',
      'Nick.ETH',
      '  vitalik.eth  ',
      'ur.integration-tests.eth',
      'a-b.eth',
      '---a.eth', // ENSIP-15's own valid example "---a"
      'ab-c.eth', // ENSIP-15's own valid example "ab-c"
      '-lead.eth',
      'trail-.eth',
      '0x.eth',
      '123.eth',
      'sub.domain.example.com',
    ];
    for (const input of accepted) {
      const check = normalizeEnsNameAscii(input);
      expect(check.ok, input).toBe(true);
      if (check.ok) expect(check.name).toBe(ensNormalize(input.trim()));
    }
  });

  it('agrees with ethers on random inputs over the accepted alphabet', () => {
    // A deterministic xorshift generator, so a failure is reproducible.
    let seed = 0x12345678;
    const next = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return seed >>> 0;
    };
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789--';
    let compared = 0;
    for (let i = 0; i < 3000; i++) {
      // Two to four labels of one to eight characters; occasionally an
      // empty label, so the refusal paths are exercised too.
      const labels: string[] = [];
      const count = 2 + (next() % 3);
      for (let k = 0; k < count; k++) {
        const length = next() % 9;
        let label = '';
        for (let j = 0; j < length; j++) label += alphabet[next() % alphabet.length];
        labels.push(label);
      }
      const s = labels.join('.');
      const ours = normalizeEnsNameAscii(s);
      let theirs: string | null;
      try {
        theirs = ensNormalize(s);
      } catch {
        theirs = null;
      }
      if (ours.ok) {
        // Whenever we accept, ENSIP-15 must accept and produce the same name.
        expect(theirs, s).toBe(ours.name);
        compared++;
      } else if (ours.problem === 'label-extension') {
        // ENSIP-15 refuses these too ("must not match /^..--/").
        expect(theirs, s).toBeNull();
      }
    }
    expect(compared).toBeGreaterThan(500);
  });

  it('refuses what it does not support, with a reason', () => {
    const cases: Array<[string, string]> = [
      ['', 'empty'],
      ['   ', 'empty'],
      ['nick', 'single-label'],
      ['eth', 'single-label'],
      ['a..eth', 'empty-label'],
      ['.eth', 'empty-label'],
      ['nick.eth.', 'empty-label'],
      ['xn--abc.eth', 'label-extension'],
      ['ab--c.eth', 'label-extension'],
      ['----.eth', 'label-extension'],
      ['ni ck.eth', 'not-ascii-subset'],
      ['nick_.eth', 'not-ascii-subset'],
      ['_nick.eth', 'not-ascii-subset'],
      ['$nick.eth', 'not-ascii-subset'],
      ['nıck.eth', 'not-ascii-subset'], // dotless i
      ['nick。eth', 'not-ascii-subset'], // ideographic full stop
      ['раураl.eth', 'not-ascii-subset'], // Cyrillic look-alike
      ['🚴.eth', 'not-ascii-subset'],
      ['nick​.eth', 'not-ascii-subset'], // zero-width space
      [`${'a'.repeat(252)}.eth`, 'too-long'],
    ];
    for (const [input, problem] of cases) {
      const check = normalizeEnsNameAscii(input);
      expect(check.ok, input).toBe(false);
      if (!check.ok) expect(check.problem, input).toBe(problem);
    }
  });
});

describe('Universal Resolver calldata and decoding', () => {
  it('encodes resolve(dns, addr(node)) byte-identically to ethers', () => {
    const name = 'nick.eth';
    const inner = ur.encodeFunctionData('addr', [ethersNamehash(name)]);
    expect(toHex(encodeEnsAddrCall(namehash(name)))).toBe(inner);
    expect(toHex(encodeUniversalResolve(dnsEncodeName(name), encodeEnsAddrCall(namehash(name))))).toBe(
      ur.encodeFunctionData('resolve', [dnsEncode(name), inner]),
    );
  });

  it('decodes a resolve() answer produced by ethers', () => {
    const result = coder.encode(['address'], [NICK]);
    const ret = ur.encodeFunctionResult('resolve', [result, RESOLVER]);
    const decoded = decodeUniversalResolveResult(toBytes(ret));
    expect(toHex(decoded.result)).toBe(result);
    expect(decoded.resolver).toBe(RESOLVER);
    expect(decodeEnsAddrResult(decoded.result)).toBe(NICK);
  });

  it('returns null for the zero address and refuses malformed answers', () => {
    expect(decodeEnsAddrResult(new Uint8Array(32))).toBeNull();
    expect(() => decodeEnsAddrResult(new Uint8Array(0))).toThrow(/0 bytes/);
    const dirty = new Uint8Array(32);
    dirty[0] = 1;
    dirty[31] = 1;
    expect(() => decodeEnsAddrResult(dirty)).toThrow(/malformed/);
    const good = toBytes(ur.encodeFunctionResult('resolve', [coder.encode(['address'], [NICK]), RESOLVER]));
    // Trailing garbage, a wrong offset and a dirty resolver word are all refused.
    expect(() => decodeUniversalResolveResult(new Uint8Array([...good, 1]))).toThrow();
    const badOffset = good.slice();
    badOffset[31] = 0x60;
    expect(() => decodeUniversalResolveResult(badOffset)).toThrow(/offset/);
    const badResolver = good.slice();
    badResolver[32] = 1;
    expect(() => decodeUniversalResolveResult(badResolver)).toThrow(/resolver/);
    // A 2-byte result is padded with 30 zero bytes; a non-zero pad byte is refused.
    const short = toBytes(ur.encodeFunctionResult('resolve', ['0x1234', RESOLVER]));
    expect(toHex(decodeUniversalResolveResult(short).result)).toBe('0x1234');
    const badPadding = short.slice();
    badPadding[short.length - 1] = 1;
    expect(() => decodeUniversalResolveResult(badPadding)).toThrow(/padding/);
  });

  it('pins every error selector against ethers', () => {
    expect(ENS_ERROR_SELECTORS.offchainLookup).toBe(
      id('OffchainLookup(address,string[],bytes,bytes4,bytes)').slice(0, 10),
    );
    expect(ENS_ERROR_SELECTORS.offchainLookup).toBe('0x556f1830');
    expect(ENS_ERROR_SELECTORS.resolverNotFound).toBe(ur.getError('ResolverNotFound')!.selector);
    expect(ENS_ERROR_SELECTORS.resolverNotFound).toBe('0x77209fe8');
    expect(ENS_ERROR_SELECTORS.resolverNotContract).toBe(ur.getError('ResolverNotContract')!.selector);
    expect(ENS_ERROR_SELECTORS.unsupportedResolverProfile).toBe(
      ur.getError('UnsupportedResolverProfile')!.selector,
    );
    expect(ENS_ERROR_SELECTORS.resolverError).toBe(ur.getError('ResolverError')!.selector);
    expect(ENS_ERROR_SELECTORS.httpError).toBe(ur.getError('HttpError')!.selector);
    expect(classifyEnsRevert('0x556F1830abcd')).toBe('offchain-lookup');
    expect(classifyEnsRevert('0xdeadbeef')).toBe('unknown');
  });
});

/** A fake node: eth_chainId plus one scripted eth_call answer or revert. */
function fakeNode(
  chainId: bigint,
  answer: (data: string) => { result: string } | { revert: string } | { fail: Error },
): JsonRpcTransport & { calls: Array<{ method: string; params: unknown[] }> } {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const t = (async (method: string, params: unknown[]) => {
    calls.push({ method, params });
    if (method === 'eth_chainId') return '0x' + chainId.toString(16);
    if (method === 'eth_call') {
      const call = params[0] as { to: string; data: string };
      expect(call.to).toBe(ENS_UNIVERSAL_RESOLVER);
      const a = answer(call.data);
      if ('result' in a) return a.result;
      if ('fail' in a) throw a.fail;
      const e = new Error('RPC error 3: execution reverted') as Error & { data: string };
      e.data = a.revert;
      throw e;
    }
    throw new Error(`unexpected ${method}`);
  }) as JsonRpcTransport & { calls: Array<{ method: string; params: unknown[] }> };
  t.calls = calls;
  return t;
}

function okAnswer(address: string) {
  return { result: ur.encodeFunctionResult('resolve', [coder.encode(['address'], [address]), RESOLVER]) };
}

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'resolved';
  } catch (e) {
    return e instanceof EnsResolutionError ? e.reason : `other: ${(e as Error).message}`;
  }
}

describe('resolveEnsAddress', () => {
  it('resolves through the Universal Resolver with the exact calldata', async () => {
    const node = fakeNode(1n, (data) => {
      expect(data).toBe(
        ur.encodeFunctionData('resolve', [
          dnsEncode('nick.eth'),
          ur.encodeFunctionData('addr', [ethersNamehash('nick.eth')]),
        ]),
      );
      return okAnswer(NICK);
    });
    const r = await resolveEnsAddress(node, 'nick.eth', 1n);
    expect(r).toEqual({
      name: 'nick.eth',
      node: ethersNamehash('nick.eth'),
      address: NICK,
      resolver: RESOLVER,
      universalResolver: ENS_UNIVERSAL_RESOLVER,
      chainId: 1n,
    });
    expect(node.calls.map((c) => c.method)).toEqual(['eth_chainId', 'eth_call']);
  });

  it('refuses each failure with its own reason', async () => {
    const offchain = ur.encodeErrorResult('OffchainLookup', [
      ENS_UNIVERSAL_RESOLVER,
      ['https://ccip-v3.ens.xyz'],
      '0x1234',
      '0x12345678',
      '0x',
    ]);
    const notFound = ur.encodeErrorResult('ResolverNotFound', [dnsEncode('x.eth')]);
    const resolverErr = ur.encodeErrorResult('ResolverError', ['0x']);
    expect(await reason(resolveEnsAddress(fakeNode(1n, () => ({ revert: offchain })), 'jesse.base.eth', 1n))).toBe('offchain');
    expect(await reason(resolveEnsAddress(fakeNode(1n, () => ({ revert: notFound })), 'x.eth', 1n))).toBe('no-resolver');
    expect(await reason(resolveEnsAddress(fakeNode(1n, () => ({ revert: resolverErr })), 'x.eth', 1n))).toBe('resolver-error');
    expect(await reason(resolveEnsAddress(fakeNode(1n, () => ({ revert: '0xdeadbeef' })), 'x.eth', 1n))).toBe('resolver-error');
    expect(await reason(resolveEnsAddress(fakeNode(1n, () => okAnswer('0x' + '00'.repeat(20))), 'x.eth', 1n))).toBe('no-address');
    expect(
      await reason(
        resolveEnsAddress(
          fakeNode(1n, () => ({ result: ur.encodeFunctionResult('resolve', [coder.encode(['address'], [NICK]), '0x' + '00'.repeat(20)]) })),
          'x.eth',
          1n,
        ),
      ),
    ).toBe('no-resolver');
    expect(await reason(resolveEnsAddress(fakeNode(1n, () => ({ result: '0x' })), 'x.eth', 1n))).toBe('malformed');
    expect(await reason(resolveEnsAddress(fakeNode(1n, () => ({ result: '0x1234' })), 'x.eth', 1n))).toBe('malformed');
    // Chain checks happen before any eth_call.
    const wrong = fakeNode(11155111n, () => okAnswer(NICK));
    expect(await reason(resolveEnsAddress(wrong, 'nick.eth', 1n))).toBe('wrong-chain');
    expect(wrong.calls.map((c) => c.method)).toEqual(['eth_chainId']);
    const base = fakeNode(84532n, () => okAnswer(NICK));
    expect(await reason(resolveEnsAddress(base, 'nick.eth', 84532n))).toBe('unsupported-chain');
    expect(base.calls).toEqual([]);
    // Unnormalized or unsupported names never reach the network.
    const strict = fakeNode(1n, () => okAnswer(NICK));
    expect(await reason(resolveEnsAddress(strict, 'Nick.eth', 1n))).toBe('invalid-name');
    expect(await reason(resolveEnsAddress(strict, 'nıck.eth', 1n))).toBe('invalid-name');
    expect(strict.calls).toEqual([]);
  });

  it('rethrows transport failures unchanged (so endpoint failover can see them)', async () => {
    const fail = new TypeError('Network request failed');
    expect(await reason(resolveEnsAddress(fakeNode(1n, () => ({ fail })), 'nick.eth', 1n))).toBe(
      'other: Network request failed',
    );
    // A revert whose data the transport dropped is not guessed at either.
    const noData = new Error('RPC error 3: execution reverted');
    expect(await reason(resolveEnsAddress(fakeNode(1n, () => ({ fail: noData })), 'nick.eth', 1n))).toBe(
      'other: RPC error 3: execution reverted',
    );
  });

  it('reverification reports a changed address', async () => {
    const shown = await resolveEnsAddress(fakeNode(1n, () => okAnswer(NICK)), 'nick.eth', 1n);
    const same = await reverifyEnsResolution(fakeNode(1n, () => okAnswer(NICK.toLowerCase())), shown);
    expect(same.changed).toBe(false);
    const other = '0x2222222222222222222222222222222222222222';
    const moved = await reverifyEnsResolution(fakeNode(1n, () => okAnswer(other)), shown);
    expect(moved.changed).toBe(true);
    expect(moved.current.address).toBe(other);
    expect(await reason(reverifyEnsResolution(fakeNode(1n, () => okAnswer('0x' + '00'.repeat(20))), shown))).toBe(
      'no-address',
    );
  });
});
