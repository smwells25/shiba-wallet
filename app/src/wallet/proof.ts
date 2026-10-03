// Proof of address ownership (phase 11 item 3, feature 85): sign a challenge
// the user holds — typed or pasted — with the active account, and produce a
// proof anyone can check. RN-free so scripts/check-proof.mjs exercises the
// exact code the screen (screens/ProveOwnershipScreen.tsx) runs; relative
// imports carry explicit .ts extensions for Node's type stripping.
//
// Two signers:
//  - the account's own address (EOA): EIP-191 personal_sign over the exact
//    UTF-8 bytes of the challenge, verified by recovering the signer;
//  - the account's Kernel smart account: the ERC-1271 envelope over the
//    same EIP-191 hash, wrapped per ERC-6492 while the account is not
//    deployed — produced by aa.ts signHashAsSmartAccount (the engine's
//    signHashForSmartAccount behind the same bound-account check the
//    WalletConnect path uses).
//
// Anti-phishing screen (screenProofChallenge): the proof screen is for
// challenges the user holds, never for dApp-supplied requests. It refuses
// anything that parses as an EIP-712 request, a transaction, an EIP-7702
// authorization, 0x-hex data, or a Sign-In with Ethereum message for a site
// the user did not type. An EIP-191 signature cannot double as a
// transaction, EIP-712 or EIP-7702 signature (each hashes a different
// prefix), so these refusals protect the user from being talked into
// "proving" something they do not understand — they are not what keeps
// keys safe.

import type { DerivedAccount } from '@shiba-wallet/core';
import { toHex } from '@shiba-wallet/chains-evm';
import { personalMessageDigest, signDigest } from './walletconnect.ts';
import { signHashAsSmartAccount, type AaClientBundle } from './aa.ts';
import { SIWE_MARKER, parseAuthority, parseSiweMessage } from './siwe.ts';

/** Wallet policy: a challenge is short text; 2,000 characters is generous. */
export const PROOF_MAX_CHARS = 2000;

export type ChallengeScreenResult =
  | { ok: true; text: string; bytes: Uint8Array; siweSite: string | null }
  | { ok: false; reason: string };

// Bidi controls (LRM/RLM, ALM, embeddings/overrides, isolates) and
// zero-width characters: they can hide or reorder what the user reads.
const INVISIBLE_RE = /[؜​-‏‪-‮⁠-⁩﻿]/;
// C0 controls except TAB and LF, DEL, C1 controls.
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const TX_KEYS = ['to', 'data', 'input', 'value', 'gas', 'gasLimit', 'gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas', 'nonce'];

type JsonVerdict = 'typed-data' | 'transaction' | 'authorization' | null;

function classifyJson(value: unknown, depth = 0): JsonVerdict {
  if (depth > 4 || value === null) return null;
  if (typeof value === 'string') {
    const t = value.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      try {
        return classifyJson(JSON.parse(t), depth + 1);
      } catch {
        return null;
      }
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      const verdict = classifyJson(v, depth + 1);
      if (verdict) return verdict;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if ('types' in obj || 'primaryType' in obj || ('domain' in obj && 'message' in obj)) return 'typed-data';
  if (
    'authorizationList' in obj ||
    'authorization_list' in obj ||
    ('chainId' in obj && 'address' in obj && 'nonce' in obj) ||
    ('yParity' in obj && 'r' in obj && 's' in obj && 'address' in obj)
  ) {
    return 'authorization';
  }
  const txHits = keys.filter((k) => TX_KEYS.includes(k));
  if (('to' in obj || 'data' in obj || 'input' in obj) && txHits.length >= 2) return 'transaction';
  for (const v of Object.values(obj)) {
    const verdict = classifyJson(v, depth + 1);
    if (verdict) return verdict;
  }
  return null;
}

/**
 * The domain the user typed in the "Site" field, normalized to
 * host[:port] (lowercase); a pasted URL is reduced to its authority.
 */
export function normalizeTypedSite(input: string): string | null {
  let t = input.trim();
  if (!t) return null;
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(t);
  if (scheme) t = t.slice(scheme[0].length);
  t = t.split(/[/?#]/)[0];
  const authority = parseAuthority(t);
  if (!authority || authority.userinfo !== null) return null;
  return authority.port ? `${authority.host}:${authority.port}` : authority.host;
}

/**
 * Decides whether a challenge may be signed on the proof screen. `signer`
 * is the address that will sign (EOA or smart account); `typedSite` is
 * what the user typed in the optional "Site" field.
 */
export function screenProofChallenge(
  input: string,
  opts: { signer: string; typedSite?: string },
): ChallengeScreenResult {
  const refuse = (reason: string): ChallengeScreenResult => ({ ok: false, reason });
  const text = input;
  if (!text.trim()) return refuse('Type or paste the challenge first.');
  if (text.length > PROOF_MAX_CHARS) {
    return refuse(`The challenge is longer than ${PROOF_MAX_CHARS} characters. Ownership challenges are short text.`);
  }
  if (CONTROL_RE.test(text) || LONE_SURROGATE_RE.test(text)) {
    return refuse('The challenge contains control characters. Only plain, readable text can be signed here.');
  }
  if (INVISIBLE_RE.test(text)) {
    return refuse(
      'The challenge contains invisible characters (zero-width or text-direction marks) that can hide ' +
        'what you are really signing. Retype it, or ask for a plain-text challenge.',
    );
  }
  const trimmed = text.trim();
  if (/^0x[0-9a-fA-F]*$/.test(trimmed)) {
    return refuse(
      'This is hex data, not readable text. It could be a transaction, a hash or an EIP-7702 ' +
        'authorization. This screen signs readable challenges only.',
    );
  }
  if (/EIP712Domain/.test(text) || /"primaryType"\s*:/.test(text)) {
    return refuse(
      'This looks like an EIP-712 typed-data request. Those can authorize token permits and orders, ' +
        'so they are never signed here — a dApp that needs one asks through WalletConnect.',
    );
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed: unknown = undefined;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Not JSON: ordinary text that starts with a bracket.
    }
    const verdict = parsed === undefined ? null : classifyJson(parsed);
    if (verdict === 'typed-data') {
      return refuse(
        'This looks like an EIP-712 typed-data request. Those can authorize token permits and orders, ' +
          'so they are never signed here — a dApp that needs one asks through WalletConnect.',
      );
    }
    if (verdict === 'transaction') {
      return refuse('This looks like a transaction. Transactions are sent from the Send screen, never signed here.');
    }
    if (verdict === 'authorization') {
      return refuse(
        'This looks like an EIP-7702 authorization, which hands control of your address to a contract. ' +
          'The wallet only creates those itself, on the Upgrade screen.',
      );
    }
  }
  let siweSite: string | null = null;
  if (text.toLowerCase().includes(SIWE_MARKER.toLowerCase())) {
    const siwe = parseSiweMessage(text);
    if (!siwe.ok) {
      return refuse(
        `This looks like a website sign-in message but does not follow the Sign-In with Ethereum format ` +
          `(${siwe.error}). Website sign-ins go through WalletConnect, where the wallet can check which ` +
          'site is asking.',
      );
    }
    const site = siwe.message.port ? `${siwe.message.host}:${siwe.message.port}` : siwe.message.host;
    const typed = opts.typedSite ? normalizeTypedSite(opts.typedSite) : null;
    if (siwe.message.userinfo !== null || typed === null || typed !== site) {
      return refuse(
        `This is a sign-in message for ${site}. Website sign-ins come from the site itself through ` +
          'WalletConnect, which checks the site for you; someone who sends you a sign-in to paste here ' +
          `could be trying to log in to ${site} as you. If you opened ${site} yourself and it showed you ` +
          'this message, type its domain in the Site field to confirm.',
      );
    }
    if (siwe.message.address.toLowerCase() !== opts.signer.toLowerCase()) {
      return refuse(
        `This sign-in names the account ${siwe.message.address}, not the address you are proving ` +
          `(${opts.signer}).`,
      );
    }
    siweSite = site;
  }
  return { ok: true, text, bytes: new TextEncoder().encode(text), siweSite };
}

export interface OwnershipProof {
  kind: 'eoa' | 'smart-account';
  /** The address the proof is for (EOA or smart account). */
  address: string;
  /** The exact signed text. */
  message: string;
  /** EIP-191 personal-message hash of the message (0x hex). */
  messageHash: string;
  /** 0x hex signature. */
  signature: string;
  /** Network the proof is bound to (matters for smart accounts). */
  network: { caip2: string; chainId: string; name: string };
  /** Smart accounts only. */
  deployed?: boolean;
  erc6492?: boolean;
  accountType?: string;
  /** ISO time the proof was made (informational; not signed). */
  createdAt: string;
}

/** EOA proof: EIP-191 personal_sign of the exact challenge bytes. */
export function makeEoaProof(
  signer: DerivedAccount,
  challenge: Extract<ChallengeScreenResult, { ok: true }>,
  network: OwnershipProof['network'],
  now: Date = new Date(),
): OwnershipProof {
  const digest = personalMessageDigest(challenge.bytes);
  return {
    kind: 'eoa',
    address: signer.address,
    message: challenge.text,
    messageHash: toHex(digest),
    signature: signDigest(signer, digest),
    network,
    createdAt: now.toISOString(),
  };
}

/**
 * Smart-account proof: the account's ERC-1271 signature over the EIP-191
 * hash, ERC-6492-wrapped while undeployed. signHashAsSmartAccount refuses
 * unless `owner`'s smart account is exactly `expectedAccount`, and refuses
 * implementations without ERC-1271 (SimpleAccount).
 */
export async function makeSmartAccountProof(
  bundle: AaClientBundle,
  owner: DerivedAccount,
  challenge: Extract<ChallengeScreenResult, { ok: true }>,
  expectedAccount: string,
  network: OwnershipProof['network'],
  now: Date = new Date(),
): Promise<OwnershipProof> {
  const digest = personalMessageDigest(challenge.bytes);
  const signed = await signHashAsSmartAccount(bundle, owner, digest, expectedAccount);
  return {
    kind: 'smart-account',
    address: signed.account,
    message: challenge.text,
    messageHash: toHex(digest),
    signature: toHex(signed.signature),
    network,
    deployed: signed.deployed,
    erc6492: signed.erc6492,
    accountType: bundle.accountType,
    createdAt: now.toISOString(),
  };
}

/** Plain-language "how to verify" for the proof's signer type. */
export function proofVerifyNote(proof: OwnershipProof): string {
  if (proof.kind === 'eoa') {
    return (
      'How to verify: take the message exactly as shown (every character, including line breaks), ' +
      'compute its EIP-191 personal-message hash, and recover the signer from the signature ' +
      '(ecrecover). The recovered address must equal the address above. Most Ethereum libraries ' +
      'do this in one "verify message" call.'
    );
  }
  const base =
    `How to verify: this address is a smart account on ${proof.network.name} (chain ID ` +
    `${proof.network.chainId}), so the signature is checked by the account contract, not by ` +
    'recovering a key. Compute the EIP-191 personal-message hash of the message exactly as shown';
  if (proof.erc6492) {
    return (
      `${base}. The account was not deployed when this was signed, so the signature is ERC-6492-wrapped: ` +
      'verify it with an ERC-6492 universal signature validator on that network, which simulates the ' +
      'deployment and then calls isValidSignature(hash, signature) (ERC-1271). A valid proof returns ' +
      '0x1626ba7e.'
    );
  }
  return (
    `${base}, then call isValidSignature(hash, signature) (ERC-1271) on the address on that network. ` +
    'A valid proof returns 0x1626ba7e. ERC-6492-aware verifiers accept it too.'
  );
}

/** The shareable text of a proof. */
export function formatProofText(proof: OwnershipProof): string {
  const signerLine =
    proof.kind === 'eoa'
      ? 'Signature type: EIP-191 personal_sign (externally owned account)'
      : `Signature type: ERC-1271 smart-account signature${proof.erc6492 ? ', ERC-6492-wrapped (account not yet deployed)' : ''}`;
  return [
    'Proof of address ownership',
    `Address: ${proof.address}`,
    `Network: ${proof.network.name} (chain ID ${proof.network.chainId})`,
    signerLine,
    '',
    'Message (signed exactly as below):',
    proof.message,
    '',
    `Message hash (EIP-191): ${proof.messageHash}`,
    `Signature: ${proof.signature}`,
    '',
    proofVerifyNote(proof),
  ].join('\n');
}

/** A starter challenge the user can edit: the address and the time, nothing else. */
export function suggestedChallenge(address: string, now: Date = new Date()): string {
  return `I control the address ${address}. Signed on ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC.`;
}
