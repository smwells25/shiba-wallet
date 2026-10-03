// Threat-model finding N-07: decoded summaries of EIP-712 requests on the
// WalletConnect approval sheet (src/wallet/typed-data-summary.ts), entirely
// OFFLINE. Every fixture is a real-shaped eth_signTypedData_v4 payload: it
// goes through the app's own parseTypedDataV4 (walletconnect.ts) first, and
// its digest is checked against ethers' TypedDataEncoder, so the summaries
// are tested on exactly what the wallet would sign — and the check proves
// that summarising leaves the digest path unchanged.
//
// Schemas (sources cited in typed-data-summary.ts): EIP-2612 Permit, DAI
// permit (makerdao/dss dai.sol), Uniswap Permit2 PermitSingle /
// PermitBatch / PermitTransferFrom / PermitBatchTransferFrom /
// PermitWitnessTransferFrom (Uniswap/permit2 PermitHash.sol), the Permit2
// domain rule (canonical 0x000000000022D473030F116dDEE9F6B43aC78BA3), and
// the generic fallback. Also: Unlimited exactly at max uint256 / uint160,
// far-future expiry warnings, tracked-token decimals with the CAIP-2 rule,
// Hide amounts, owner mismatch, look-alike schemas, unreadable values, and
// the spender code-class warnings.
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-typed-data.mjs

import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { parseTypedDataV4 } from '../src/wallet/walletconnect.ts';
import {
  FAR_FUTURE_SECONDS,
  MAX_UINT160,
  MAX_UINT256,
  MAX_UINT48,
  PERMIT2_ADDRESS,
  formatUtc,
  spenderRiskWarnings,
  summarizeTypedData,
} from '../src/wallet/typed-data-summary.ts';

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

const SIGNER = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'; // standard test mnemonic, account 0
const OTHER = '0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F';
const ROUTER = '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD';
const NOW = 1_790_000_000; // fixed clock (2026-09-21)
const TRACKED = [
  { assetId: { chainId: 'eip155:1', namespace: 'erc20', reference: USDC }, symbol: 'USDC', decimals: 6 },
  { assetId: { chainId: 'eip155:1', namespace: 'erc20', reference: DAI }, symbol: 'DAI', decimals: 18 },
];
const opts = (over = {}) => ({ signer: SIGNER, nowSec: NOW, chainCaip2: 'eip155:1', trackedTokens: TRACKED, hidden: false, ...over });

const DOMAIN_FIELD_TYPES = { name: 'string', version: 'string', chainId: 'uint256', verifyingContract: 'address', salt: 'bytes32' };
const json = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

/**
 * Builds the v4 JSON a dApp would send, parses it with the APP's parser,
 * and checks the digest against ethers. Returns the parsed typed data.
 */
function fixture(name, domain, types, primaryType, message, chain = 'eip155:1') {
  const EIP712Domain = ['name', 'version', 'chainId', 'verifyingContract', 'salt']
    .filter((k) => domain[k] !== undefined)
    .map((k) => ({ name: k, type: DOMAIN_FIELD_TYPES[k] }));
  const payload = json({ types: { EIP712Domain, ...types }, primaryType, domain, message });
  const parsed = parseTypedDataV4(payload, chain);
  const expected = ethers.TypedDataEncoder.hash(domain, types, message);
  check(`${name}: app digest equals ethers TypedDataEncoder`, ethers.hexlify(parsed.digest) === expected);
  return parsed;
}

function digestUnchangedBy(name, parsed, options) {
  const before = ethers.hexlify(parsed.digest);
  const msgBefore = json(parsed.message);
  summarizeTypedData(parsed, options);
  check(`${name}: summarising changes neither the digest nor the message`, ethers.hexlify(parsed.digest) === before && json(parsed.message) === msgBefore);
}

const row = (s, label) => s.rows.find((r) => r.label === label)?.value;

// ---------------------------------------------------------------------------
console.log('check-typed-data: EIP-2612 permit');
const PERMIT_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};
const USDC_DOMAIN = { name: 'USD Coin', version: '2', chainId: 1, verifyingContract: USDC };
{
  const p = fixture('USDC permit 1.5 USDC', USDC_DOMAIN, PERMIT_TYPES, 'Permit', {
    owner: SIGNER,
    spender: ROUTER,
    value: 1_500_000n,
    nonce: 3n,
    deadline: BigInt(NOW + 3600),
  });
  digestUnchangedBy('USDC permit', p, opts());
  const s = summarizeTypedData(p, opts());
  check('kind erc2612-permit', s.kind === 'erc2612-permit' && s.title === 'Token approval (EIP-2612 permit)');
  check('token = verifyingContract, in full', row(s, 'Token') === USDC);
  check('owner and spender in full (checksummed)', row(s, 'Owner') === SIGNER && row(s, 'Spender') === ROUTER);
  check('amount in the tracked token’s decimals', row(s, 'Amount') === '1.5 USDC', row(s, 'Amount'));
  check('deadline absolute + relative', row(s, 'Signature usable until') === `${formatUtc(BigInt(NOW + 3600))} (in 1 h)`, row(s, 'Signature usable until'));
  check('nonce shown', row(s, 'Nonce') === '3');
  check('spenders = [router]', JSON.stringify(s.spenders) === JSON.stringify([ROUTER]));
  check('no warnings for a bounded, near-term permit', s.warnings.length === 0, JSON.stringify(s.warnings));
  check('explanation says the approval persists after submission', /stays until it is used up or revoked/.test(s.explanation));
  const hidden = summarizeTypedData(p, opts({ hidden: true }));
  check('Hide amounts masks a finite amount', row(hidden, 'Amount') === '•••• USDC');
}
{
  const p = fixture('USDC permit unlimited, never expires', USDC_DOMAIN, PERMIT_TYPES, 'Permit', {
    owner: SIGNER,
    spender: ROUTER,
    value: MAX_UINT256,
    nonce: 0n,
    deadline: MAX_UINT256,
  });
  const s = summarizeTypedData(p, opts({ hidden: true }));
  check('max uint256 → "Unlimited", emphasised, never masked', row(s, 'Amount') === 'Unlimited' && s.rows.find((r) => r.label === 'Amount').emphasis === true);
  check('unlimited warning names the token and the spender', s.warnings.some((w) => /^UNLIMITED: this lets 0x3fC9…7FAD take ALL of your USDC/.test(w)), JSON.stringify(s.warnings));
  check('max deadline → "never"', /^never/.test(row(s, 'Signature usable until')));
  check('never-expiring permit warned', s.warnings.some((w) => /never expires/.test(w)));
  const almost = fixture('USDC permit max-1', USDC_DOMAIN, PERMIT_TYPES, 'Permit', { owner: SIGNER, spender: ROUTER, value: MAX_UINT256 - 1n, nonce: 0n, deadline: BigInt(NOW + 60) });
  const sa = summarizeTypedData(almost, opts());
  check('max uint256 − 1 is NOT labelled Unlimited (exact rule)', row(sa, 'Amount') !== 'Unlimited' && !sa.warnings.some((w) => /UNLIMITED/.test(w)));
}
{
  const far = fixture('permit 31 days', USDC_DOMAIN, PERMIT_TYPES, 'Permit', { owner: SIGNER, spender: ROUTER, value: 1n, nonce: 0n, deadline: BigInt(NOW + FAR_FUTURE_SECONDS + 86_400) });
  const s = summarizeTypedData(far, opts());
  check('deadline > 30 days → warning', s.warnings.some((w) => /more than 30 days/.test(w)));
  const near = fixture('permit 29 days', USDC_DOMAIN, PERMIT_TYPES, 'Permit', { owner: SIGNER, spender: ROUTER, value: 1n, nonce: 0n, deadline: BigInt(NOW + FAR_FUTURE_SECONDS - 86_400) });
  check('deadline < 30 days → no expiry warning', summarizeTypedData(near, opts()).warnings.length === 0);
  const past = fixture('permit expired', USDC_DOMAIN, PERMIT_TYPES, 'Permit', { owner: SIGNER, spender: ROUTER, value: 1n, nonce: 0n, deadline: BigInt(NOW - 10) });
  check('past deadline shown as already passed', /already passed/.test(row(summarizeTypedData(past, opts()), 'Signature usable until')));
}
{
  const UNTRACKED = '0x1111111111111111111111111111111111111111';
  const p = fixture('untracked token permit', { name: 'Shady', version: '1', chainId: 1, verifyingContract: UNTRACKED }, PERMIT_TYPES, 'Permit', { owner: SIGNER, spender: ROUTER, value: 123456789n, nonce: 0n, deadline: BigInt(NOW + 60) });
  const s = summarizeTypedData(p, opts());
  check('untracked token → raw base units, labelled as such', row(s, 'Amount') === '123456789 base units (raw — this token is not tracked, so its decimals are unknown)', row(s, 'Amount'));
  const ps = fixture('Sepolia permit on the MAINNET USDC address', { ...USDC_DOMAIN, chainId: 11155111 }, PERMIT_TYPES, 'Permit', { owner: SIGNER, spender: ROUTER, value: 1_500_000n, nonce: 0n, deadline: BigInt(NOW + 60) }, 'eip155:11155111');
  const ss = summarizeTypedData(ps, opts({ chainCaip2: 'eip155:11155111' }));
  check('CAIP-2 rule: a mainnet tracked entry never labels a Sepolia contract', /^1500000 base units/.test(row(ss, 'Amount')), row(ss, 'Amount'));
}
{
  const p = fixture('permit for another owner', USDC_DOMAIN, PERMIT_TYPES, 'Permit', { owner: OTHER, spender: ROUTER, value: 1n, nonce: 0n, deadline: BigInt(NOW + 60) });
  const s = summarizeTypedData(p, opts());
  check('owner ≠ signing account → warning', s.warnings.some((w) => w.includes(OTHER) && /not the signing account|but the signing account/.test(w)), JSON.stringify(s.warnings));
}
{
  // A look-alike Permit with an extra field is not the EIP-2612 schema.
  const types = { Permit: [...PERMIT_TYPES.Permit, { name: 'extra', type: 'uint256' }] };
  const p = fixture('look-alike Permit (extra field)', USDC_DOMAIN, types, 'Permit', { owner: SIGNER, spender: ROUTER, value: MAX_UINT256, nonce: 0n, deadline: 1n, extra: 5n });
  const s = summarizeTypedData(p, opts());
  check('look-alike schema → generic list (never mislabelled)', s.kind === 'generic' && s.rows.some((r) => r.label === 'extra' && r.value === '5'));
  const reordered = { Permit: [PERMIT_TYPES.Permit[1], PERMIT_TYPES.Permit[0], ...PERMIT_TYPES.Permit.slice(2)] };
  const p2 = fixture('Permit with reordered fields', USDC_DOMAIN, reordered, 'Permit', { owner: SIGNER, spender: ROUTER, value: 1n, nonce: 0n, deadline: 1n });
  check('reordered fields → generic (order is part of the digest)', summarizeTypedData(p2, opts()).kind === 'generic');
}
{
  // Unreadable values in a known schema: never throws, falls back.
  const td = { domain: USDC_DOMAIN, types: PERMIT_TYPES, primaryType: 'Permit', message: { owner: 'nope', spender: ROUTER, value: 'abc', nonce: 0, deadline: 0 } };
  let s;
  try {
    s = summarizeTypedData(td, opts());
  } catch (e) {
    s = e;
  }
  check('unreadable values → generic summary, no exception', s?.kind === 'generic');
}

// ---------------------------------------------------------------------------
console.log('check-typed-data: DAI-style permit');
const DAI_TYPES = {
  Permit: [
    { name: 'holder', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'expiry', type: 'uint256' },
    { name: 'allowed', type: 'bool' },
  ],
};
const DAI_DOMAIN = { name: 'Dai Stablecoin', version: '1', chainId: 1, verifyingContract: DAI };
{
  const p = fixture('DAI permit allowed, expiry 0', DAI_DOMAIN, DAI_TYPES, 'Permit', { holder: SIGNER, spender: ROUTER, nonce: 7n, expiry: 0n, allowed: true });
  digestUnchangedBy('DAI permit', p, opts());
  const s = summarizeTypedData(p, opts({ hidden: true }));
  check('kind dai-permit, approval title', s.kind === 'dai-permit' && s.title === 'Token approval (DAI-style permit)');
  check('allowed=true → Unlimited (dai.sol: allowed ? uint(-1) : 0), never masked', row(s, 'Amount') === 'Unlimited');
  check('expiry 0 → never (dai.sol: expiry == 0 || now <= expiry)', row(s, 'Signature usable until') === 'never (expiry 0)');
  check('unlimited + never-expires warnings', s.warnings.some((w) => /^UNLIMITED/.test(w) && /DAI/.test(w)) && s.warnings.some((w) => /never expires/.test(w)));
  check('holder + spender', row(s, 'Holder') === SIGNER && row(s, 'Spender') === ROUTER && JSON.stringify(s.spenders) === JSON.stringify([ROUTER]));
  const r = fixture('DAI permit revoke', DAI_DOMAIN, DAI_TYPES, 'Permit', { holder: SIGNER, spender: ROUTER, nonce: 8n, expiry: BigInt(NOW + 60), allowed: false });
  const sr = summarizeTypedData(r, opts());
  check('allowed=false → revoke title and text, no unlimited warning', sr.title === 'Approval removal (DAI-style permit)' && /REVOKES/.test(row(sr, 'Amount')) && !sr.warnings.some((w) => /UNLIMITED/.test(w)));
}

// ---------------------------------------------------------------------------
console.log('check-typed-data: Uniswap Permit2');
const PERMIT2_DOMAIN = { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2_ADDRESS };
const PERMIT_DETAILS = [
  { name: 'token', type: 'address' },
  { name: 'amount', type: 'uint160' },
  { name: 'expiration', type: 'uint48' },
  { name: 'nonce', type: 'uint48' },
];
const SINGLE_TYPES = {
  PermitSingle: [
    { name: 'details', type: 'PermitDetails' },
    { name: 'spender', type: 'address' },
    { name: 'sigDeadline', type: 'uint256' },
  ],
  PermitDetails: PERMIT_DETAILS,
};
check('canonical Permit2 address constant (Uniswap/permit2 Permit2Lib.sol)', PERMIT2_ADDRESS === '0x000000000022D473030F116dDEE9F6B43aC78BA3' && ethers.getAddress(PERMIT2_ADDRESS) === PERMIT2_ADDRESS);
{
  const p = fixture('PermitSingle unlimited, 40-day allowance', PERMIT2_DOMAIN, SINGLE_TYPES, 'PermitSingle', {
    details: { token: USDC, amount: MAX_UINT160, expiration: BigInt(NOW + 40 * 86_400), nonce: 0n },
    spender: ROUTER,
    sigDeadline: BigInt(NOW + 1800),
  });
  digestUnchangedBy('PermitSingle', p, opts());
  const s = summarizeTypedData(p, opts({ hidden: true }));
  check('kind permit2-allowance / PermitSingle', s.kind === 'permit2-allowance' && /PermitSingle/.test(s.title));
  check('max uint160 → Unlimited (IAllowanceTransfer: type(uint160).max is unlimited), never masked', row(s, 'Amount') === 'Unlimited');
  check('token in full', row(s, 'Token') === USDC);
  check('allowance expiry absolute', row(s, 'Allowance expires').startsWith(formatUtc(BigInt(NOW + 40 * 86_400))));
  check('sigDeadline shown', row(s, 'Signature usable until').startsWith(formatUtc(BigInt(NOW + 1800))));
  check('unlimited warning + long-allowance warning', s.warnings.some((w) => /^UNLIMITED/.test(w) && /USDC/.test(w)) && s.warnings.some((w) => /allowance lasts more than 30 days/.test(w)));
  check('canonical domain → no impostor warning', !s.warnings.some((w) => /phishing/.test(w)));
  check('explanation names Permit2', /through Permit2 \(0x0000…8BA3\)/.test(s.explanation), s.explanation);
  const bounded = fixture('PermitSingle 25 USDC, expiration 0', PERMIT2_DOMAIN, SINGLE_TYPES, 'PermitSingle', {
    details: { token: USDC, amount: 25_000_000n, expiration: 0n, nonce: 4n },
    spender: ROUTER,
    sigDeadline: BigInt(NOW + 1800),
  });
  const sb = summarizeTypedData(bounded, opts());
  check('bounded amount in USDC decimals', row(sb, 'Amount') === '25 USDC', row(sb, 'Amount'));
  check('expiration 0 → only in the block where it is used (Allowance.sol)', row(sb, 'Allowance expires') === 'only in the block where it is used (expiration 0)');
  check('bounded, short permit → no warnings', sb.warnings.length === 0, JSON.stringify(sb.warnings));
  const max160m1 = fixture('PermitSingle uint160 max − 1', PERMIT2_DOMAIN, SINGLE_TYPES, 'PermitSingle', {
    details: { token: USDC, amount: MAX_UINT160 - 1n, expiration: MAX_UINT48, nonce: 0n },
    spender: ROUTER,
    sigDeadline: BigInt(NOW + 1800),
  });
  const sm = summarizeTypedData(max160m1, opts());
  check('uint160 max − 1 is not Unlimited', row(sm, 'Amount') !== 'Unlimited');
  check('expiration at uint48 max is far future (year ~8.9 million) → "never"', /^never/.test(row(sm, 'Allowance expires')) && sm.warnings.some((w) => /allowance lasts more than 30 days \(or never ends\)/.test(w)));
}
{
  // Impostor: Permit2 shape, wrong verifying contract.
  const FAKE = ethers.getAddress('0x000000000022d473030f116ddee9f6b43ac78ba4');
  const p = fixture('Permit2-shaped impostor', { name: 'Permit2', chainId: 1, verifyingContract: FAKE }, SINGLE_TYPES, 'PermitSingle', {
    details: { token: USDC, amount: 1n, expiration: 0n, nonce: 0n },
    spender: ROUTER,
    sigDeadline: BigInt(NOW + 60),
  });
  const s = summarizeTypedData(p, opts());
  check('wrong verifying contract → still summarised, with the phishing warning naming both addresses', s.kind === 'permit2-allowance' && s.warnings.some((w) => w.includes(FAKE) && w.includes(PERMIT2_ADDRESS) && /likely phishing/.test(w)), JSON.stringify(s.warnings));
  const p2 = fixture('Permit2-shaped, wrong name', { name: 'Permit3', chainId: 1, verifyingContract: PERMIT2_ADDRESS }, SINGLE_TYPES, 'PermitSingle', {
    details: { token: USDC, amount: 1n, expiration: 0n, nonce: 0n },
    spender: ROUTER,
    sigDeadline: BigInt(NOW + 60),
  });
  check('wrong domain name → phishing warning', summarizeTypedData(p2, opts()).warnings.some((w) => /"Permit3"/.test(w)));
  const lower = fixture('Permit2 lowercase address', { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2_ADDRESS.toLowerCase() }, SINGLE_TYPES, 'PermitSingle', {
    details: { token: USDC, amount: 1n, expiration: 0n, nonce: 0n },
    spender: ROUTER,
    sigDeadline: BigInt(NOW + 60),
  });
  check('lowercase canonical address (as Uniswap sends it) → no warning', !summarizeTypedData(lower, opts()).warnings.some((w) => /phishing/.test(w)));
  const sepolia = fixture('Permit2 on Sepolia', { name: 'Permit2', chainId: 11155111, verifyingContract: PERMIT2_ADDRESS }, SINGLE_TYPES, 'PermitSingle', {
    details: { token: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', amount: 1_000_000n, expiration: BigInt(NOW + 86_400), nonce: 0n },
    spender: '0x7E4f6c5e954Da5c61B3423D81E2277431Ac043f3',
    sigDeadline: BigInt(NOW + 1800),
  }, 'eip155:11155111');
  const ss = summarizeTypedData(sepolia, opts({ chainCaip2: 'eip155:11155111' }));
  check('Permit2 on Sepolia (same canonical address) → recognised, no impostor warning, raw units for the untracked token', ss.kind === 'permit2-allowance' && !ss.warnings.some((w) => /phishing/.test(w)) && /^1000000 base units/.test(row(ss, 'Amount')));
}
{
  const BATCH_TYPES = {
    PermitBatch: [
      { name: 'details', type: 'PermitDetails[]' },
      { name: 'spender', type: 'address' },
      { name: 'sigDeadline', type: 'uint256' },
    ],
    PermitDetails: PERMIT_DETAILS,
  };
  const p = fixture('PermitBatch two tokens', PERMIT2_DOMAIN, BATCH_TYPES, 'PermitBatch', {
    details: [
      { token: USDC, amount: 10_000_000n, expiration: BigInt(NOW + 86_400), nonce: 0n },
      { token: DAI, amount: MAX_UINT160, expiration: BigInt(NOW + 86_400), nonce: 1n },
    ],
    spender: ROUTER,
    sigDeadline: BigInt(NOW + 1800),
  });
  digestUnchangedBy('PermitBatch', p, opts());
  const s = summarizeTypedData(p, opts());
  check('PermitBatch: numbered rows per token', row(s, 'Token 1') === USDC && row(s, 'Amount 1') === '10 USDC' && row(s, 'Token 2') === DAI && row(s, 'Amount 2') === 'Unlimited');
  check('PermitBatch: one unlimited warning, for DAI only', s.warnings.filter((w) => /^UNLIMITED/.test(w)).length === 1 && s.warnings.some((w) => /ALL of your DAI/.test(w)));
}
const TOKEN_PERMISSIONS = [
  { name: 'token', type: 'address' },
  { name: 'amount', type: 'uint256' },
];
{
  const types = {
    PermitTransferFrom: [
      { name: 'permitted', type: 'TokenPermissions' },
      { name: 'spender', type: 'address' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
    TokenPermissions: TOKEN_PERMISSIONS,
  };
  const p = fixture('PermitTransferFrom', PERMIT2_DOMAIN, types, 'PermitTransferFrom', {
    permitted: { token: USDC, amount: 2_000_000n },
    spender: ROUTER,
    nonce: 99n,
    deadline: BigInt(NOW + 600),
  });
  digestUnchangedBy('PermitTransferFrom', p, opts());
  const s = summarizeTypedData(p, opts());
  check('PermitTransferFrom: one-time transfer summary', s.kind === 'permit2-transfer' && /One-time token transfer/.test(s.title) && row(s, 'Up to') === '2 USDC' && row(s, 'Nonce') === '99');
  const unl = fixture('PermitTransferFrom max', PERMIT2_DOMAIN, types, 'PermitTransferFrom', { permitted: { token: USDC, amount: MAX_UINT256 }, spender: ROUTER, nonce: 1n, deadline: MAX_UINT256 });
  const su = summarizeTypedData(unl, opts());
  check('PermitTransferFrom max uint256 → Unlimited + never warnings', row(su, 'Up to') === 'Unlimited' && su.warnings.some((w) => /^UNLIMITED/.test(w)) && su.warnings.some((w) => /never expires/.test(w)));
}
{
  const types = {
    PermitBatchTransferFrom: [
      { name: 'permitted', type: 'TokenPermissions[]' },
      { name: 'spender', type: 'address' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
    TokenPermissions: TOKEN_PERMISSIONS,
  };
  const p = fixture('PermitBatchTransferFrom', PERMIT2_DOMAIN, types, 'PermitBatchTransferFrom', {
    permitted: [
      { token: USDC, amount: 1_000_000n },
      { token: DAI, amount: 5n * 10n ** 18n },
    ],
    spender: ROUTER,
    nonce: 1n,
    deadline: BigInt(NOW + 600),
  });
  const s = summarizeTypedData(p, opts());
  check('PermitBatchTransferFrom: both tokens with decimals', s.kind === 'permit2-transfer' && row(s, 'Up to 1') === '1 USDC' && row(s, 'Up to 2') === '5 DAI');
}
{
  const types = {
    PermitWitnessTransferFrom: [
      { name: 'permitted', type: 'TokenPermissions' },
      { name: 'spender', type: 'address' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'witness', type: 'Order' },
    ],
    Order: [
      { name: 'swapper', type: 'address' },
      { name: 'minOut', type: 'uint256' },
    ],
    TokenPermissions: TOKEN_PERMISSIONS,
  };
  const p = fixture('PermitWitnessTransferFrom (UniswapX-style order)', PERMIT2_DOMAIN, types, 'PermitWitnessTransferFrom', {
    permitted: { token: USDC, amount: 3_000_000n },
    spender: ROUTER,
    nonce: 5n,
    deadline: BigInt(NOW + 600),
    witness: { swapper: SIGNER, minOut: 1n },
  });
  const s = summarizeTypedData(p, opts());
  check('witness variant: summarised with the attached order named', s.kind === 'permit2-transfer' && row(s, 'Attached order') === 'witness (Order) — see the full message below' && row(s, 'Up to') === '3 USDC');
}

// ---------------------------------------------------------------------------
console.log('check-typed-data: generic fallback');
{
  const types = {
    Mail: [
      { name: 'from', type: 'Person' },
      { name: 'to', type: 'Person[]' },
      { name: 'contents', type: 'string' },
      { name: 'blob', type: 'bytes' },
      { name: 'ok', type: 'bool' },
    ],
    Person: [
      { name: 'name', type: 'string' },
      { name: 'wallet', type: 'address' },
    ],
  };
  const domain = { name: 'Ether Mail', version: '1', chainId: 1, verifyingContract: '0xcccccccccccccccccccccccccccccccccccccccc' };
  const p = fixture('EIP-712 example Mail (generic)', domain, types, 'Mail', {
    from: { name: 'Cow', wallet: '0xcd2a3d9f938e13cd947ec05abc7fe734df8dd826' },
    to: [{ name: 'Bob', wallet: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }],
    contents: 'Hello,‮ Bob!',
    blob: '0x' + 'ab'.repeat(100),
    ok: true,
  });
  digestUnchangedBy('generic', p, opts());
  const s = summarizeTypedData(p, opts());
  check('generic: kind/title', s.kind === 'generic' && s.title === 'Typed data: Mail');
  check('generic: primaryType, domain and verifying contract (checksummed, in full)', row(s, 'Message type') === 'Mail' && row(s, 'Domain') === 'Ether Mail' && row(s, 'Verifying contract') === ethers.getAddress(domain.verifyingContract));
  check('generic: nested struct fields with dotted labels, addresses in full', row(s, 'from.wallet') === ethers.getAddress('0xcd2a3d9f938e13cd947ec05abc7fe734df8dd826') && row(s, 'from.name') === 'Cow');
  check('generic: array items indexed', row(s, 'to[0].name') === 'Bob');
  check('generic: control / bidi characters neutralised in strings', row(s, 'contents') === 'Hello,  Bob!');
  check('generic: long bytes truncated with their length (raw JSON below keeps all)', /… \(100 bytes\)$/.test(row(s, 'blob')));
  check('generic: no spenders, no invented warnings', s.spenders.length === 0 && s.warnings.length === 0);
  const noVc = fixture('generic without verifying contract', { name: 'Snapshot', version: '0.1.4' }, { Vote: [{ name: 'choice', type: 'uint32' }] }, 'Vote', { choice: 1 });
  check('generic: no verifying contract → "none"', row(summarizeTypedData(noVc, opts()), 'Verifying contract') === 'none');
}

// ---------------------------------------------------------------------------
console.log('check-typed-data: spender code-class warnings');
{
  const eoa = spenderRiskWarnings([ROUTER], { [ROUTER.toLowerCase()]: { kind: 'eoa' } });
  check('EOA spender (no code) → drainer-pattern warning with the full address', eoa.length === 1 && eoa[0].includes(ROUTER) && /no contract code/.test(eoa[0]));
  const del = spenderRiskWarnings([ROUTER], { [ROUTER.toLowerCase()]: { kind: 'delegated-eoa', delegate: OTHER } });
  check('delegated EOA spender → warning naming the delegate', del.length === 1 && del[0].includes(OTHER) && /EIP-7702/.test(del[0]));
  check('contract spender → no warning', spenderRiskWarnings([ROUTER], { [ROUTER.toLowerCase()]: { kind: 'contract', codeSize: 100 } }).length === 0);
  check('failed lookup → no warning (unknown is never a warning)', spenderRiskWarnings([ROUTER], { [ROUTER.toLowerCase()]: null }).length === 0 && spenderRiskWarnings([ROUTER], {}).length === 0);
}

// ---------------------------------------------------------------------------
console.log('check-typed-data: wiring (sources)');
{
  const sheet = readFileSync(new URL('../src/components/WcApprovalSheet.tsx', import.meta.url), 'utf8');
  const wc = readFileSync(new URL('../src/wallet/walletconnect.ts', import.meta.url), 'utf8');
  const summarySrc = readFileSync(new URL('../src/wallet/typed-data-summary.ts', import.meta.url), 'utf8');
  const i = sheet.indexOf('<TypedDataSummaryCard');
  const j = sheet.indexOf('{JSON.stringify(typedData.message, null, 2)}');
  check('sheet: summary card sits ABOVE the raw message, which is kept', i > 0 && j > i);
  check('sheet: the existing generic typed-data warning is kept', /Typed-data signatures can authorize on-chain actions later/.test(sheet));
  check('sheet: spenders shown with the contacts exact-match notice', /<RecipientContactNotice[\s\S]{0,80}match=\{matchRecipient\(evmChain\.caip2, spender, contacts\)\}/.test(sheet));
  check('sheet: spender classes come from the engine classifyRecipient', /await classifyRecipient\(transport, spender\)/.test(sheet));
  check('summary never declines: typed-data-summary has no rejection/error-code path', !/WcRequestRejection|respondRejected|decline/i.test(summarySrc.replace(/never declined for that reason/g, '')));
  check('parseTypedDataV4 still owns the digest (summary imports no hashing)', !/import[^;]*(typedDataDigest|keccak)/.test(summarySrc) && /const digest = typedDataDigest\(domain, types, td\.primaryType, message\);/.test(wc));
  {
    // The digest path itself still refuses a foreign domain chain id (unchanged policy).
    let msg = '';
    try {
      parseTypedDataV4(json({ types: { EIP712Domain: [{ name: 'chainId', type: 'uint256' }], M: [{ name: 'x', type: 'uint256' }] }, primaryType: 'M', domain: { chainId: 10 }, message: { x: 1 } }), 'eip155:1');
    } catch (e) {
      msg = e.message;
    }
    check('domain policy unchanged: foreign chain id still refused by parseTypedDataV4', /chain id 10/.test(msg));
  }
}

console.log(`\ncheck-typed-data: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
