// Sign-In with Ethereum (EIP-4361) parser and summary, entirely OFFLINE
// (phase 11 item 3). Source: EIP-4361, status Final, ethereum/ERCs
// ERCS/erc-4361.md at commit faa49e076526bade48318f0d6e04d9a73f82c131.
//
// Covered: the EIP's three example messages; messages built by an
// independent implementation (ox 0.9.3 Siwe.createMessage, the builder viem
// re-exports) with fields cross-checked against ox's own parseMessage; every
// optional field; RFC 3339 edge cases; a malformed-message matrix — each one
// rejected by the parser AND still signable as a plain personal_sign
// message with the unchanged EIP-191 digest (ethers.hashMessage); the
// sheet-classification of payloads that only imitate the format or are not
// printable; and every warning on the summary card.
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-siwe.mjs

import { ethers } from 'ethers';
import { Siwe } from 'ox';
import { toHex } from '@shiba-wallet/chains-evm';
import {
  SIWE_INFO_NOTE,
  SIWE_MARKER,
  SIWE_MAX_RESOURCES,
  SIWE_SMART_ACCOUNT_NOTE,
  checkSiweOrigin,
  classifySiweBytes,
  describeSiweMessage,
  formatUtcMs,
  isRfc3986Uri,
  malformedSiweWarnings,
  parseAuthority,
  parseOriginUrl,
  parseRfc3339,
  parseSiweMessage,
  relativeTime,
} from '../src/wallet/siwe.ts';
import { decodeMessageForDisplay, parseWcRequest } from '../src/wallet/walletconnect.ts';

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const EIP_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const WALLET = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'; // standard test mnemonic, account 0
const RESOURCES = '\nResources:\n- ipfs://bafybeiemxf5abjwjbikoz4mc3a3dla6ual3jsgpdr4cjr3oz3evfyavhwq/\n- https://example.com/my-web2-claim.json';
const eipBody = (origin) =>
  `${origin} wants you to sign in with your Ethereum account:\n${EIP_ADDRESS}\n\n` +
  'I accept the ExampleOrg Terms of Service: https://example.com/tos\n\n' +
  'URI: https://example.com/login\nVersion: 1\nChain ID: 1\nNonce: 32891756\nIssued At: 2021-09-30T16:25:24Z' +
  RESOURCES;

// The three examples, verbatim from the EIP's "Examples" section.
const EIP_IMPLICIT = eipBody('example.com');
const EIP_PORT = eipBody('example.com:3388');
const EIP_SCHEME = eipBody('https://example.com');

console.log('check-siwe: the EIP-4361 example messages');
{
  const r = parseSiweMessage(EIP_IMPLICIT);
  check('implicit-scheme example parses', r.ok, r.error);
  const m = r.message;
  check('  scheme absent, domain/host', m.scheme === null && m.domain === 'example.com' && m.host === 'example.com' && m.port === null && m.userinfo === null);
  check('  address verbatim and EIP-55', m.address === EIP_ADDRESS && m.addressChecksummed && m.address === ethers.getAddress(EIP_ADDRESS));
  check('  statement', m.statement === 'I accept the ExampleOrg Terms of Service: https://example.com/tos');
  check('  uri / version / chain / nonce', m.uri === 'https://example.com/login' && m.version === '1' && m.chainId === 1n && m.nonce === '32891756');
  check('  issued-at = 2021-09-30T16:25:24Z (epoch 1633019124)', m.issuedAt.raw === '2021-09-30T16:25:24Z' && m.issuedAt.ms === 1633019124000);
  check('  resources in order', m.resources.length === 2 && m.resources[0].startsWith('ipfs://bafy') && m.resources[1] === 'https://example.com/my-web2-claim.json');
  check('  no optional times / request id', m.expirationTime === null && m.notBefore === null && m.requestId === null);
  const p = parseSiweMessage(EIP_PORT);
  check('explicit-port example parses (domain example.com:3388)', p.ok && p.message.host === 'example.com' && p.message.port === '3388' && p.message.domain === 'example.com:3388');
  const s = parseSiweMessage(EIP_SCHEME);
  check('explicit-scheme example parses (scheme https)', s.ok && s.message.scheme === 'https' && s.message.host === 'example.com');
}

console.log('check-siwe: messages from an independent builder (ox 0.9.3 Siwe.createMessage)');
{
  const base = {
    address: EIP_ADDRESS,
    chainId: 11155111,
    domain: 'app.example.org',
    nonce: 'k7Qx92pLmZ',
    uri: 'https://app.example.org/login?next=%2Fhome',
    version: '1',
    issuedAt: new Date('2026-10-03T12:00:00.123Z'),
  };
  const minimal = Siwe.createMessage(base);
  const r1 = parseSiweMessage(minimal);
  check('no statement (two empty lines, as the ABNF and ox both produce)', r1.ok && r1.message.statement === null, r1.error);
  check('  fractional seconds parsed (…:00.123Z)', r1.ok && r1.message.issuedAt.ms === Date.parse('2026-10-03T12:00:00.123Z'));
  const full = Siwe.createMessage({
    ...base,
    scheme: 'https',
    statement: "Sign in to use the app. It's free!",
    expirationTime: new Date('2026-10-03T12:10:00Z'),
    notBefore: new Date('2026-10-03T11:59:00Z'),
    requestId: 'req-42:abc@x',
    resources: ['https://app.example.org/terms', 'ipfs://bafybeiemxf5abjwjbikoz4mc3a3dla6ual3jsgpdr4cjr3oz3evfyavhwq/'],
  });
  const r2 = parseSiweMessage(full);
  check('every optional field parses', r2.ok, r2.error);
  const oxParsed = Siwe.parseMessage(full);
  check('  fields equal ox parseMessage (address, chain, domain, nonce, uri, statement, scheme, requestId)',
    r2.ok &&
      oxParsed.address === r2.message.address &&
      BigInt(oxParsed.chainId) === r2.message.chainId &&
      oxParsed.domain === r2.message.domain &&
      oxParsed.nonce === r2.message.nonce &&
      oxParsed.uri === r2.message.uri &&
      oxParsed.statement === r2.message.statement &&
      oxParsed.scheme === r2.message.scheme &&
      oxParsed.requestId === r2.message.requestId);
  check('  times equal ox parseMessage', r2.ok && oxParsed.expirationTime.getTime() === r2.message.expirationTime.ms && oxParsed.notBefore.getTime() === r2.message.notBefore.ms && oxParsed.issuedAt.getTime() === r2.message.issuedAt.ms);
  check('  resources equal ox parseMessage', r2.ok && JSON.stringify(oxParsed.resources) === JSON.stringify(r2.message.resources));
  check('  ox validateMessage agrees the message is valid at 12:05', Siwe.validateMessage({ address: EIP_ADDRESS, domain: 'app.example.org', message: oxParsed, nonce: 'k7Qx92pLmZ', time: new Date('2026-10-03T12:05:00Z') }));
  const lower = Siwe.createMessage({ ...base, domain: 'localhost:8080', uri: 'http://localhost:8080/' });
  check('localhost with port parses', parseSiweMessage(lower).ok && parseSiweMessage(lower).message.port === '8080');
}

console.log('check-siwe: RFC 3339 and RFC 3986 details');
{
  check('offset +02:00 converts to UTC', parseRfc3339('2026-10-03T14:00:00+02:00')?.ms === Date.parse('2026-10-03T12:00:00Z'));
  check('offset -05:30 converts to UTC', parseRfc3339('2026-10-03T06:30:00-05:30')?.ms === Date.parse('2026-10-03T12:00:00Z'));
  check('lower-case t and z accepted (RFC 3339 5.6 note)', parseRfc3339('2026-10-03t12:00:00z')?.ms === Date.parse('2026-10-03T12:00:00Z'));
  check('leap day 2024-02-29 valid', parseRfc3339('2024-02-29T00:00:00Z') !== null);
  check('2023-02-29 rejected', parseRfc3339('2023-02-29T00:00:00Z') === null);
  check('1900-02-29 rejected (century rule), 2000-02-29 valid', parseRfc3339('1900-02-29T00:00:00Z') === null && parseRfc3339('2000-02-29T00:00:00Z') !== null);
  check('month 13 / hour 24 / minute 60 rejected', [
    '2026-13-01T00:00:00Z', '2026-10-01T24:00:00Z', '2026-10-01T00:60:00Z',
  ].every((t) => parseRfc3339(t) === null));
  check('leap second :60 accepted', parseRfc3339('2016-12-31T23:59:60Z') !== null);
  check('missing offset / space separator / short year rejected', ['2026-10-03T12:00:00', '2026-10-03 12:00:00Z', '26-10-03T12:00:00Z'].every((t) => parseRfc3339(t) === null));
  check('offset +24:00 rejected', parseRfc3339('2026-10-03T12:00:00+24:00') === null);
  check('authority: userinfo, host, port', JSON.stringify(parseAuthority('user:pw@Example.COM:8443')) === JSON.stringify({ userinfo: 'user:pw', host: 'example.com', port: '8443' }));
  check('authority: IPv6 literal with port', parseAuthority('[::1]:3000')?.host === '[::1]' && parseAuthority('[::1]:3000')?.port === '3000');
  check('authority: two @ rejected, space rejected, empty host rejected', parseAuthority('a@b@c.com') === null && parseAuthority('exa mple.com') === null && parseAuthority(':443') === null);
  check('authority: non-digit port rejected', parseAuthority('example.com:44a') === null);
  check('URI: needs a scheme; spaces and double # rejected', isRfc3986Uri('https://a.b/c?d=e#f') && isRfc3986Uri('urn:uuid:123') && !isRfc3986Uri('/login') && !isRfc3986Uri('https://a.b/c d') && !isRfc3986Uri('https://a/#x#y'));
  check('origin URL parsed without URL()', JSON.stringify(parseOriginUrl('https://App.Uniswap.org/swap?x=1')) === JSON.stringify({ scheme: 'https', host: 'app.uniswap.org', port: null }));
  check('formatUtcMs is deterministic', formatUtcMs(1633019124000) === '2021-09-30 16:25:24 UTC');
  const now = Date.parse('2026-10-03T12:00:00Z');
  check('relative times', relativeTime(now + 5 * 60_000, now) === 'in 5 min' && relativeTime(now - 3 * 3_600_000, now) === '3 h ago' && relativeTime(now + 10_000, now) === 'just now' && relativeTime(now - 4 * 86_400_000, now) === '4 days ago' && relativeTime(Date.parse('2021-09-30T16:25:24Z'), now) === 'about 5 years ago');
}

console.log('check-siwe: malformed messages are rejected — and still signable as plain messages');
{
  const ok = EIP_IMPLICIT;
  const lowerAddr = ok.replace(EIP_ADDRESS, EIP_ADDRESS.toLowerCase());
  const lowerParsed = parseSiweMessage(lowerAddr);
  check('all-lowercase address parses with addressChecksummed = false', lowerParsed.ok && lowerParsed.message.addressChecksummed === false);
  const badChecksum = '0xc02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'; // the EIP's address with ONE letter's case flipped
  const cases = [
    ['CRLF line breaks', ok.replace(/\n/g, '\r\n')],
    ['trailing line break', ok + '\n'],
    ['trailing line break without resources', ok.replace(RESOURCES, '') + '\n'],
    ['header phrase in a different case', ok.replace('wants you to sign in', 'Wants you to sign in')],
    ['header without the colon', ok.replace('Ethereum account:', 'Ethereum account')],
    ['wrong EIP-55 checksum (mixed case)', ok.replace(EIP_ADDRESS, badChecksum)],
    ['address too short', ok.replace(EIP_ADDRESS, EIP_ADDRESS.slice(0, -2))],
    ['no empty line after the address', ok.replace(`${EIP_ADDRESS}\n\n`, `${EIP_ADDRESS}\n`)],
    ['statement over two lines', ok.replace('Terms of Service:', 'Terms of\nService:')],
    ['non-ASCII statement', ok.replace('I accept', 'I accépt')],
    ['statement with a double quote', ok.replace('I accept', 'I "accept"')],
    ['statement without the empty line before URI', ok.replace('tos\n\nURI:', 'tos\nURI:')],
    ['only one empty line when there is no statement', ok.replace('\n\nI accept the ExampleOrg Terms of Service: https://example.com/tos\n\n', '\n\n')],
    ['missing URI', ok.replace('URI: https://example.com/login\n', '')],
    ['relative URI', ok.replace('URI: https://example.com/login', 'URI: /login')],
    ['version 2', ok.replace('Version: 1', 'Version: 2')],
    ['chain id with a letter', ok.replace('Chain ID: 1', 'Chain ID: 1a')],
    ['nonce of 7 characters', ok.replace('Nonce: 32891756', 'Nonce: 3289175')],
    ['nonce with punctuation', ok.replace('Nonce: 32891756', 'Nonce: 3289-1756')],
    ['fields out of order (Nonce before Chain ID)', ok.replace('Chain ID: 1\nNonce: 32891756', 'Nonce: 32891756\nChain ID: 1')],
    ['impossible date', ok.replace('2021-09-30T16:25:24Z', '2021-02-30T16:25:24Z')],
    ['Issued At without offset', ok.replace('2021-09-30T16:25:24Z', '2021-09-30T16:25:24')],
    ['resource without "- "', ok.replace('\n- https://example.com/my-web2-claim.json', '\nhttps://example.com/my-web2-claim.json')],
    ['resource that is not a URI', ok.replace('- https://example.com/my-web2-claim.json', '- my web2 claim')],
    ['unknown extra field', ok.replace('Issued At: 2021-09-30T16:25:24Z', 'Issued At: 2021-09-30T16:25:24Z\nColor: blue')],
    ['request id with a space', ok.replace(RESOURCES, '\nRequest ID: a b')],
    ['site with a space', ok.replace('example.com wants', 'exa mple.com wants')],
    ['bad scheme', ok.replace('example.com wants', '1http://example.com wants')],
    ['too long (over 16 KiB)', ok.replace('Resources:', 'Request ID: ' + 'a'.repeat(17_000) + '\nResources:')],
    ['more than 64 resources', ok + '\n- https://x.example/r'.repeat(SIWE_MAX_RESOURCES)],
  ];
  const expectReason = {
    'trailing line break': 'extra line break',
    'trailing line break without resources': 'extra line break',
    'wrong EIP-55 checksum (mixed case)': 'EIP-55 checksum',
    'CRLF line breaks': 'carriage-return',
  };
  for (const [name, text] of cases) {
    const r = parseSiweMessage(text);
    const event = { id: 1, topic: 'T', params: { chainId: 'eip155:1', request: { method: 'personal_sign', params: [toHex(new TextEncoder().encode(text)), WALLET] } } };
    let signable = false;
    try {
      const parsed = parseWcRequest(event, WALLET, 'eip155:1');
      signable = parsed.kind === 'personal_sign' && toHex(parsed.digest) === ethers.hashMessage(new TextEncoder().encode(text));
    } catch {
      signable = false;
    }
    check(`${name}: rejected ("${r.ok ? 'PARSED' : r.error}") and still signable (digest = ethers.hashMessage)`, !r.ok && signable);
    if (expectReason[name]) check(`  … for the right reason`, !r.ok && r.error.includes(expectReason[name]), r.error);
  }
}

console.log('check-siwe: classifying personal_sign payloads for the sheet');
{
  const bytes = (t) => new TextEncoder().encode(t);
  const cls = (t) => classifySiweBytes(bytes(t), decodeMessageForDisplay(bytes(t)));
  check('plain message → none', cls('Hello, sign me').kind === 'none');
  check('conforming message → siwe', cls(EIP_IMPLICIT).kind === 'siwe');
  const imitation = cls(`evil.example ${SIWE_MARKER}! Click to continue.`);
  check('imitation containing the phrase → malformed (the EIP\'s SHOULD-warn case)', imitation.kind === 'malformed' && imitation.printable);
  check('phrase matched case-insensitively', cls('Example.com WANTS YOU TO SIGN IN WITH YOUR ETHEREUM ACCOUNT').kind === 'malformed');
  const ctrl = cls(EIP_IMPLICIT.replace('Nonce', '\u0007Nonce'));
  check('control character inside a sign-in → malformed, not printable', ctrl.kind === 'malformed' && !ctrl.printable);
  const invalidUtf8 = new Uint8Array([...bytes(`a.example ${SIWE_MARKER}:\n`), 0xff, 0xfe]);
  const bad = classifySiweBytes(invalidUtf8, decodeMessageForDisplay(invalidUtf8));
  check('invalid UTF-8 with the phrase → malformed, not printable', bad.kind === 'malformed' && !bad.printable);
  const w = malformedSiweWarnings('x', false);
  check('malformed warnings: format warning + not-printable warning', w.length === 2 && w[0].includes('does not follow the Sign-In with Ethereum format (x)') && /not printable text/.test(w[1]));
  check('printable malformed: one warning only', malformedSiweWarnings('x', true).length === 1);
}

console.log('check-siwe: summary card and warnings');
{
  const now = Date.parse('2026-10-03T12:00:00Z');
  const names = { 1n: 'Ethereum mainnet', 11155111n: 'Ethereum Sepolia (test network)' };
  const ctx = (over = {}) => ({
    origin: { url: 'https://app.example.org', source: 'verify' },
    sessionAddress: WALLET,
    activeChainId: 1n,
    chainName: (id) => names[id] ?? null,
    nowMs: now,
    smartAccount: null,
    ...over,
  });
  const msg = (over = {}) =>
    Siwe.createMessage({
      address: WALLET,
      chainId: 1,
      domain: 'app.example.org',
      nonce: 'abcdefgh12',
      uri: 'https://app.example.org/login',
      version: '1',
      issuedAt: new Date(now - 60_000),
      expirationTime: new Date(now + 10 * 60_000),
      statement: 'Sign in to Example',
      resources: ['https://app.example.org/tos'],
      ...over,
    });
  const describe = (text, c = ctx()) => {
    const r = parseSiweMessage(text);
    if (!r.ok) throw new Error(r.error);
    return describeSiweMessage(r.message, c);
  };

  const clean = describe(msg());
  check('matching domain, account, chain and window → no warnings', clean.warnings.length === 0, JSON.stringify(clean.warnings));
  check('  title "Sign in to app.example.org"', clean.title === 'Sign in to app.example.org');
  const labels = clean.rows.map((r) => r.label).join(',');
  check('  rows: site, account, network, statement, URI, version, nonce, issued, expires', labels === 'Site,Account,Network,Statement,URI,Version,Nonce,Issued,Expires', labels);
  check('  site row says https is assumed when no scheme is written', clean.rows[0].value === 'app.example.org (https assumed — no scheme given)');
  check('  network row names the chain', clean.rows[2].value === 'Ethereum mainnet (chain ID 1)');
  check('  issued/expiry show absolute UTC + relative', clean.rows.find((r) => r.label === 'Issued').value === '2026-10-03 11:59:00 UTC (1 min ago)' && clean.rows.find((r) => r.label === 'Expires').value === '2026-10-03 12:10:00 UTC (in 10 min)');
  check('  resources listed', clean.resources.length === 1 && clean.resources[0] === 'https://app.example.org/tos');
  check('  info note present; no smart-account note on an EOA session', clean.notes.includes(SIWE_INFO_NOTE) && !clean.notes.includes(SIWE_SMART_ACCOUNT_NOTE));
  const noExp = describe(msg({ expirationTime: undefined, notBefore: new Date(now - 1000), requestId: 'r1' }));
  check('  "No expiry set", Not before and Request ID rows when present', noExp.rows.find((r) => r.label === 'Expires').value === 'No expiry set' && noExp.rows.some((r) => r.label === 'Not before') && noExp.rows.some((r) => r.label === 'Request ID'));

  const phish = describe(msg({ domain: 'app.example.org' }), ctx({ origin: { url: 'https://evil.example', source: 'verify' } }));
  check('WARN: domain ≠ Verify-attested origin (names both, cites the EIP)', phish.warnings.length === 1 && /for app\.example\.org, but the request came from evil\.example \(confirmed by WalletConnect\)/.test(phish.warnings[0]) && /EIP-4361, security considerations/.test(phish.warnings[0]));
  const meta = describe(msg(), ctx({ origin: { url: 'https://other.example/app', source: 'metadata' } }));
  check('WARN: domain ≠ session metadata URL (labelled self-reported)', /came from other\.example \(the address the dApp gives for itself\)/.test(meta.warnings[0] ?? ''));
  const metaOk = describe(msg(), ctx({ origin: { url: 'https://app.example.org', source: 'metadata' } }));
  check('metadata match: no warning, but a note that the origin is unconfirmed', metaOk.warnings.length === 0 && metaOk.notes.some((n) => /could not confirm/.test(n)));
  const sub = describe(msg({ domain: 'login.example.org' }), ctx({ origin: { url: 'https://example.org', source: 'verify' } }));
  check('WARN: a different subdomain is a different site', /A different subdomain is a different site/.test(sub.warnings[0] ?? ''));
  const scheme = describe(msg({ scheme: 'http' }));
  check('WARN: scheme mismatch (http in message, https origin)', scheme.warnings.length >= 1 && /names http:\/\/ but the request came from a https:\/\/ page/.test(scheme.warnings[0]));
  const port = describe(msg({ domain: 'app.example.org:8443' }));
  check('WARN: port mismatch (8443 vs default 443)', /port 8443 of app\.example\.org, but the request came from port 443/.test(port.warnings[0] ?? ''));
  const portOk = describe(msg({ domain: 'app.example.org:443' }));
  check('explicit :443 equals the https default → no warning', portOk.warnings.length === 0);
  const none = describe(msg(), ctx({ origin: null }));
  check('WARN: no origin at all', /could not tell which site sent this request/.test(none.warnings[0] ?? ''));
  const userinfoText = msg().replace('app.example.org wants', 'app.example.org@evil.example wants');
  const ui = describe(userinfoText, ctx({ origin: { url: 'https://evil.example', source: 'verify' } }));
  check('WARN: user-name part disguising the real site (host = evil.example, title says so)', ui.title === 'Sign in to evil.example' && ui.warnings.some((w) => /starts with "app\.example\.org@"/.test(w)));
  check('checkSiweOrigin: host comparison is case-insensitive', checkSiweOrigin(parseSiweMessage(msg()).message, 'https://APP.EXAMPLE.ORG').length === 0);

  const otherAccount = describe(msg({ address: EIP_ADDRESS }));
  check('WARN: message account ≠ the session account', otherAccount.warnings.length === 1 && otherAccount.warnings[0].includes(EIP_ADDRESS) && otherAccount.warnings[0].includes(WALLET));
  const chain = describe(msg({ chainId: 11155111 }));
  check('WARN: chain ≠ active chain (names both)', chain.warnings.length === 1 && /Ethereum Sepolia \(test network\) \(chain ID 11155111\), but the wallet is on Ethereum mainnet \(chain ID 1\)/.test(chain.warnings[0]));
  const unknownChain = describe(msg({ chainId: 424242 }));
  check('  unknown chain shown by id', /for chain ID 424242/.test(unknownChain.warnings[0] ?? ''));
  const expired = describe(msg({ expirationTime: new Date(now - 5 * 60_000) }));
  check('WARN: expiration-time in the past', expired.warnings.length === 1 && /expired 5 min ago \(2026-10-03 11:55:00 UTC\)/.test(expired.warnings[0]));
  const early = describe(msg({ notBefore: new Date(now + 2 * 3_600_000) }));
  check('WARN: not-before in the future', early.warnings.length === 1 && /only becomes valid in 2 h/.test(early.warnings[0]));
  const smart = describe(msg({ chainId: 11155111 }), ctx({ smartAccount: { address: WALLET } }));
  check('smart-account session: ERC-1271/6492 note, chain warning mentions the smart-account check', smart.notes.includes(SIWE_SMART_ACCOUNT_NOTE) && /smart-account signature on the chain in the message/.test(smart.warnings[0]));
  const lowerAddr = describe(msg().replace(WALLET, WALLET.toLowerCase()));
  check('lowercase address: no warning (same account), a checksum note', lowerAddr.warnings.length === 0 && lowerAddr.notes.some((n) => /EIP-55/.test(n)));
  // The risk-switch gate (EIP-4361 MUST-reject cases only).
  check('GATE: domain ≠ Verify origin', phish.gate !== null && /requires wallets to refuse this \(EIP-4361, "Verifying the Request Origin"\)/.test(phish.gate));
  check('GATE: domain ≠ metadata URL', meta.gate !== null);
  check('GATE: different subdomain', sub.gate !== null);
  check('GATE: scheme mismatch', scheme.gate !== null && /names http:\/\//.test(scheme.gate));
  check('GATE: port mismatch', port.gate !== null && /port 8443/.test(port.gate));
  check('GATE: userinfo@ domain (even when the host matches the origin)', describe(msg().replace('app.example.org wants', 'x@app.example.org wants')).gate !== null && ui.gate !== null);
  check('no gate: clean, explicit :443, metadata match', clean.gate === null && portOk.gate === null && metaOk.gate === null);
  check('no gate (informational only): no origin, other account, other chain, expired, not yet valid', [none, otherAccount, chain, expired, early, lowerAddr].every((x) => x.gate === null));
  const all = describe(msg({ chainId: 5, address: EIP_ADDRESS, expirationTime: new Date(now - 1000) }), ctx({ origin: { url: 'https://evil.example', source: 'verify' } }));
  check('several problems → several warnings (domain, account, chain, expiry)', all.warnings.length === 4);
}

console.log('');
console.log(`check-siwe: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
