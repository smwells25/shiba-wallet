// Proof of address ownership (phase 11 item 3, feature 85), entirely OFFLINE:
// the challenge screen (what may and may not be signed), EOA proofs verified
// independently with ethers.verifyMessage, and Kernel smart-account proofs
// verified with the engine's verifiers against the fake Kernel node — the
// ERC-6492 path through a fake eth_simulateV1 while the account is not
// deployed, and plain ERC-1271 isValidSignature once it is (the pattern of
// check-wc-5792.mjs, sharing fakes-kernel.mjs). Nothing touches a network.
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-proof.mjs

import { readFileSync } from 'node:fs';
import { evmKeyProvider, mnemonicToSeed } from '@shiba-wallet/core';
import { KERNEL_V3_3, toBytes, verifyContractSignature, verifyErc6492Signature } from '@shiba-wallet/chains-evm';
import { ethers } from 'ethers';
import {
  PROOF_MAX_CHARS,
  formatProofText,
  makeEoaProof,
  makeSmartAccountProof,
  normalizeTypedSite,
  proofVerifyNote,
  screenProofChallenge,
  suggestedChallenge,
} from '../src/wallet/proof.ts';
import { createAaClientFromConfig } from '../src/wallet/aa.ts';
import { KERNEL_ACCOUNT_0, OWNER_0, TEST_MNEMONIC, fakeBundler, fakeKernelNode } from './fakes-kernel.mjs';

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

const seed = mnemonicToSeed(TEST_MNEMONIC);
const owner = evmKeyProvider.deriveAccount(seed, 0, 0);
const SMART = KERNEL_ACCOUNT_0;
const NETWORK = { caip2: 'eip155:1', chainId: '1', name: 'Ethereum' };
const screen = (text, opts = {}) => screenProofChallenge(text, { signer: OWNER_0, ...opts });
const siwe = (domain, address = OWNER_0) =>
  `${domain} wants you to sign in with your Ethereum account:\n${address}\n\nProve it\n\n` +
  `URI: https://${domain}/verify\nVersion: 1\nChain ID: 1\nNonce: abcdef123456\nIssued At: 2026-10-03T12:00:00Z`;

console.log('check-proof: the challenge screen');
{
  check('the derived owner is the standard test address', owner.address === OWNER_0);
  const accepted = [
    ['a plain challenge', 'Verification code 829-114 for support ticket 5521'],
    ['a multi-line statement', 'I control this address.\nDate: 2026-10-03'],
    ['the suggested challenge', suggestedChallenge(OWNER_0, new Date('2026-10-03T12:34:56Z'))],
    ['harmless JSON', '{"challenge":"k2j3h4","service":"example"}'],
    ['a bare hex nonce (no 0x)', 'a3f9c2'.repeat(11)],
    ['text with emoji and accents', 'Café proof ✅ 👍'],
    ['text that starts with a bracket but is not JSON', '[ticket 42] please sign'],
    ['exactly the length limit', 'x'.repeat(PROOF_MAX_CHARS)],
  ];
  for (const [name, text] of accepted) {
    const r = screen(text);
    check(`accepted: ${name}`, r.ok && r.text === text && r.siweSite === null, r.reason);
  }
  check('suggested challenge names the address and time', suggestedChallenge(OWNER_0, new Date('2026-10-03T12:34:56Z')) === `I control the address ${OWNER_0}. Signed on 2026-10-03 12:34 UTC.`);
  const typed = {
    types: { EIP712Domain: [{ name: 'name', type: 'string' }], Permit: [{ name: 'spender', type: 'address' }] },
    primaryType: 'Permit',
    domain: { name: 'Permit2' },
    message: { spender: OWNER_0 },
  };
  const refused = [
    ['empty', '   ', /Type or paste/],
    ['too long', 'x'.repeat(PROOF_MAX_CHARS + 1), /longer than 2000/],
    ['a control character', 'code\u0007123', /control characters/],
    ['a NUL byte', 'code\u0000123', /control characters/],
    ['a right-to-left override', 'pay ‮evil', /invisible characters/],
    ['a zero-width space', 'pro​of', /invisible characters/],
    ['a lone surrogate', 'bad \uD800 text', /control characters/],
    ['0x hex data (a transaction, hash or tuple)', '0x02f86c0180843b9aca00', /hex data/],
    ['a 32-byte 0x hash', '0x' + 'ab'.repeat(32), /hex data/],
    ['EIP-712 typed data (JSON)', JSON.stringify(typed), /EIP-712/],
    ['EIP-712 in eth_signTypedData params form', JSON.stringify([OWNER_0, JSON.stringify(typed)]), /EIP-712/],
    ['text naming EIP712Domain', 'please sign {EIP712Domain ...}', /EIP-712/],
    ['a transaction object', JSON.stringify({ to: OWNER_0, value: '0x1', data: '0x', gas: '0x5208' }), /transaction/],
    ['an EIP-7702 authorization tuple', JSON.stringify({ chainId: 1, address: OWNER_0, nonce: 0 }), /EIP-7702/],
    ['a transaction with an authorizationList', JSON.stringify({ to: OWNER_0, authorizationList: [] }), /EIP-7702/],
    ['a signed tuple', JSON.stringify({ address: OWNER_0, yParity: 0, r: '0x1', s: '0x2' }), /EIP-7702/],
    ['a website sign-in without a typed site', siwe('app.example'), /sign-in message for app\.example/],
    ['a website sign-in for a different typed site', siwe('app.example'), /type its domain/, { typedSite: 'other.example' }],
    ['a sign-in disguised with a user-name part', siwe('app.example@evil.example'), /sign-in message for evil\.example/, { typedSite: 'evil.example' }],
    ['a sign-in naming another account', siwe('app.example', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'), /names the account 0xC02a/, { typedSite: 'app.example' }],
    ['a malformed sign-in', 'evil.example wants you to sign in with your Ethereum account: click', /does not follow the Sign-In with Ethereum format/],
  ];
  for (const [name, text, reason, opts] of refused) {
    const r = screen(text, opts ?? {});
    check(`refused: ${name}`, !r.ok && reason.test(r.reason), r.ok ? 'ACCEPTED' : r.reason);
  }
  const typedOk = screen(siwe('app.example'), { typedSite: 'https://App.Example/login' });
  check('a sign-in for the site the user typed (URL pasted, any case) is allowed', typedOk.ok && typedOk.siweSite === 'app.example');
  const portOk = screen(siwe('app.example:8443'), { typedSite: 'app.example:8443' });
  check('  … including an explicit port, which must match too', portOk.ok && !screen(siwe('app.example:8443'), { typedSite: 'app.example' }).ok);
  check('normalizeTypedSite', normalizeTypedSite('https://Example.COM/x?y') === 'example.com' && normalizeTypedSite(' example.com:3388 ') === 'example.com:3388' && normalizeTypedSite('user@example.com') === null && normalizeTypedSite('') === null);
  const smartSigner = screenProofChallenge(siwe('app.example', SMART), { signer: SMART, typedSite: 'app.example' });
  check('a sign-in naming the smart account is allowed when proving the smart account', smartSigner.ok);
}

console.log('check-proof: EOA proofs (EIP-191), verified independently with ethers');
{
  const texts = ['Verification code 829-114', 'Line one\nLine two', 'Café proof ✅ 👍'];
  for (const text of texts) {
    const screened = screen(text);
    const proof = makeEoaProof(owner, screened, NETWORK, new Date('2026-10-03T12:00:00Z'));
    check(`"${text.replace('\n', '\\n')}": ethers.verifyMessage recovers the address`, ethers.verifyMessage(text, proof.signature) === OWNER_0);
    check('  messageHash = ethers.hashMessage, kind eoa, 65-byte signature, v 27/28', proof.messageHash === ethers.hashMessage(text) && proof.kind === 'eoa' && toBytes(proof.signature).length === 65 && [27, 28].includes(toBytes(proof.signature)[64]));
  }
  const proof = makeEoaProof(owner, screen('Verification code 829-114'), NETWORK, new Date('2026-10-03T12:00:00Z'));
  check('a changed message no longer verifies', ethers.verifyMessage('Verification code 829-115', proof.signature) !== OWNER_0);
  const text = formatProofText(proof);
  check('shareable text: message, address, network, signature, hash and how to verify', text.includes('Verification code 829-114') && text.includes(OWNER_0) && text.includes('Ethereum (chain ID 1)') && text.includes(proof.signature) && text.includes(proof.messageHash) && text.includes('EIP-191 personal_sign (externally owned account)') && text.includes(proofVerifyNote(proof)));
  check('EOA verify note: EIP-191 hash + recover', /EIP-191 personal-message hash/.test(proofVerifyNote(proof)) && /recover the signer/.test(proofVerifyNote(proof)));
  check('createdAt recorded (informational)', proof.createdAt === '2026-10-03T12:00:00.000Z');
}

console.log('check-proof: smart-account proofs (ERC-1271 / ERC-6492) through the engine verifiers');
const kernelConfig = {
  chain: 'eip155:1',
  bundlerUrl: 'https://bundler.example',
  bundlerVerifiedAt: 'x',
  accountType: 'kernel-v3.3',
  factory: KERNEL_V3_3.factory,
  factoryImplementation: KERNEL_V3_3.implementation,
  kernelMetaFactory: KERNEL_V3_3.metaFactory,
  kernelValidator: KERNEL_V3_3.ecdsaValidator,
  kernelAccountId: KERNEL_V3_3.accountId,
  factoryVerifiedAt: 'x',
  paymasterUrl: null,
  paymasterContext: null,
  paymasterVerifiedAt: null,
};
const bundleWith = (node, config = kernelConfig) =>
  createAaClientFromConfig(config, {
    nodeUrl: 'https://node.example',
    chainId: 1n,
    accountIndex: 0,
    transportFor: (u) => (u === 'https://node.example' ? node : fakeBundler()),
  });
{
  // Undeployed: ERC-6492 envelope, validated through a fake eth_simulateV1.
  const node = fakeKernelNode();
  const bundle = bundleWith(node);
  const challenge = screenProofChallenge('Smart account proof 7781', { signer: SMART });
  const proof = await makeSmartAccountProof(bundle, owner, challenge, SMART, NETWORK);
  check('undeployed: proof is for the smart account, kind smart-account, ERC-6492 wrapped', proof.address === SMART && proof.kind === 'smart-account' && proof.erc6492 === true && proof.deployed === false && proof.accountType === 'kernel-v3.3');
  const sig = toBytes(proof.signature);
  check('  signature ends with the ERC-6492 magic suffix', ethers.hexlify(sig.slice(-32)) === '0x' + '6492'.repeat(16));
  const verdict = await verifyErc6492Signature(node, SMART, toBytes(ethers.hashMessage('Smart account proof 7781')), sig);
  check('  verifyErc6492Signature (engine, fake eth_simulateV1) → valid via the counterfactual path', verdict.valid && verdict.path === 'erc6492-counterfactual', JSON.stringify(verdict));
  const wrong = await verifyErc6492Signature(node, SMART, toBytes(ethers.hashMessage('Smart account proof 7782')), sig);
  check('  a different message → invalid', !wrong.valid);
  const plain = await verifyContractSignature(node, SMART, toBytes(ethers.hashMessage('Smart account proof 7781')), sig);
  check('  plain ERC-1271 cannot check it before deployment (no code) — why the note says ERC-6492', !plain.valid && plain.reason === 'no-code');
  check('  verify note names the ERC-6492 universal validator and the network', /ERC-6492 universal signature validator/.test(proofVerifyNote(proof)) && /Ethereum \(chain ID 1\)/.test(proofVerifyNote(proof)) && /0x1626ba7e/.test(proofVerifyNote(proof)));
  check('  shareable text labels the ERC-6492 wrapping', formatProofText(proof).includes('ERC-1271 smart-account signature, ERC-6492-wrapped (account not yet deployed)'));
  check('  not a plain owner signature (ethers.verifyMessage does not yield the owner)', (() => {
    try {
      return ethers.verifyMessage('Smart account proof 7781', proof.signature) !== OWNER_0;
    } catch {
      return true;
    }
  })());
}
{
  // Deployed: plain ERC-1271 envelope, validated by isValidSignature.
  const node = fakeKernelNode({ deployedAccounts: new Set([SMART]), owners: { [SMART.toLowerCase()]: OWNER_0 } });
  const bundle = bundleWith(node);
  const challenge = screenProofChallenge('Deployed proof 31', { signer: SMART });
  const proof = await makeSmartAccountProof(bundle, owner, challenge, SMART, NETWORK);
  check('deployed: not wrapped, deployed = true', proof.erc6492 === false && proof.deployed === true);
  const verdict = await verifyContractSignature(node, SMART, toBytes(ethers.hashMessage('Deployed proof 31')), toBytes(proof.signature));
  check('  verifyContractSignature (engine ERC-1271 isValidSignature) → valid', verdict.valid, JSON.stringify(verdict));
  const universal = await verifyErc6492Signature(node, SMART, toBytes(ethers.hashMessage('Deployed proof 31')), toBytes(proof.signature));
  check('  an ERC-6492-aware verifier accepts it too', universal.valid);
  const bad = await verifyContractSignature(node, SMART, toBytes(ethers.hashMessage('Deployed proof 32')), toBytes(proof.signature));
  check('  a different message → rejected', !bad.valid);
  check('  verify note: isValidSignature on the address', /call isValidSignature\(hash, signature\) \(ERC-1271\) on the address/.test(proofVerifyNote(proof)));
}
{
  // Refusals.
  const node = fakeKernelNode();
  const challenge = screenProofChallenge('x proof', { signer: SMART });
  let refusedOther = null;
  try {
    await makeSmartAccountProof(bundleWith(node), owner, challenge, '0x' + '11'.repeat(20), NETWORK);
  } catch (e) {
    refusedOther = e.message;
  }
  check('a smart account other than the owner\'s → refused, nothing signed', refusedOther !== null && /Nothing was signed/.test(refusedOther), refusedOther);
  let refusedSimple = null;
  try {
    await makeSmartAccountProof(bundleWith(node, { ...kernelConfig, accountType: 'simple', factory: '0x' + '22'.repeat(20) }), owner, challenge, SMART, NETWORK);
  } catch (e) {
    refusedSimple = e.message;
  }
  check('SimpleAccount (no ERC-1271) → refused', refusedSimple !== null && /no ERC-1271 support/.test(refusedSimple), refusedSimple);
}

console.log('check-proof: screen wiring (source checks; the screen is React Native)');
{
  const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const screenSrc = src('../src/screens/ProveOwnershipScreen.tsx');
  const iScreen = screenSrc.indexOf('screenProofChallenge(challenge');
  const iAuth = screenSrc.indexOf("requireLocalAuth('Sign an ownership proof')");
  const iSign = screenSrc.indexOf('signWith(EVM_CHAIN_ID, eoa');
  check('screen: challenge screened, then the biometric gate, then signWith', iScreen > 0 && iAuth > iScreen && iSign > iAuth);
  check('screen: signs only via signWith(expectAddress = the active EOA) — no other key path', !/mnemonic|revealMnemonic|deriveAccount/.test(screenSrc));
  check('screen: smart-account proofs via makeSmartAccountProof (signHashAsSmartAccount)', /makeSmartAccountProof\(bundle, owner, screened, smart\.address, network\)/.test(screenSrc));
  check('route registered (navigation.ts + App.tsx)', /ProveOwnership: undefined;/.test(src('../src/navigation.ts')) && /<Stack\.Screen name="ProveOwnership" component=\{ProveOwnershipScreen\}/.test(src('../App.tsx')));
  // Phase 14 integration: not offered for a watch-only account (no key).
  check('linked from Receive (EVM only, never for a watch-only account) and Settings', /account\.chainId === EVM_CHAIN_ID && !watchOnly \? \(\s*<Button\s*title="Prove you own this address"/.test(src('../src/screens/ReceiveScreen.tsx')) && /navigate\('ProveOwnership'\)/.test(src('../src/screens/SettingsScreen.tsx')));
}

seed.fill(0);
console.log('');
console.log(`check-proof: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
