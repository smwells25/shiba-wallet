import AsyncStorage from '@react-native-async-storage/async-storage';
import { buildApprovedNamespaces, getSdkError } from '@walletconnect/utils';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import type { DerivedAccount } from '@shiba-wallet/core';
import {
  toBytes,
  toHex,
  typedDataDigest,
  withEthereumV,
  type TypedDataDomain,
  type TypedDataField,
  type TypedDataTypes,
} from '@shiba-wallet/chains-evm';
// Explicit .ts extensions: this module is imported by scripts/check-wc.mjs
// under Node's type stripping, which resolves relative specifiers literally.
import { EVM_CHAIN_ID, validateRecipient } from './send.ts';
import type { KeyValueStore } from './tokens.ts';

/**
 * WalletConnect v2 glue (Tier 1 feature 78): lets external dApps connect to
 * this wallet, request signatures, and submit transactions — Ethereum
 * mainnet (eip155:1) only in this pass.
 *
 * SDK choice (verified 2026-09-27): WalletConnect-the-company rebranded to
 * Reown, and the wallet-side SDK is @reown/walletkit (v1.6.0, published
 * 2026-09-14). The legacy @walletconnect/web3wallet package is deprecated
 * on npm with the notice "Web3Wallet is now Reown WalletKit. Please follow
 * the upgrade guide at docs.reown.com/walletkit/upgrade/from-web3wallet-web".
 * Install and usage requirements were taken from the official docs:
 *   https://docs.walletconnect.com/wallets/react-native/installation.md
 *   https://docs.walletconnect.com/wallets/react-native/usage.md
 * which require @walletconnect/react-native-compat to be imported "before
 * any @reown/* dependencies" (it polyfills TextEncoder/TextDecoder, URL,
 * Buffer, atob/btoa, and installs netinfo/application globals). This module
 * therefore loads the compat shim and the SDK through dynamic import(), in
 * that order, inside initWalletConnect() — nothing WalletKit-related is
 * evaluated at app startup, and the pure helpers below stay importable
 * under plain Node for scripts/check-wc.mjs.
 *
 * Everything decision-shaped (namespace construction, request parsing and
 * routing, digests, response shapes) is a pure function taking plain data,
 * exercised offline by scripts/check-wc.mjs against a fake client; the SDK
 * only transports.
 *
 * SECURITY: nothing in this module signs anything by itself. Every signing
 * function takes a DerivedAccount that only WalletContext.signWith can
 * produce, and the Connections screen calls it strictly after the user has
 * seen the request and passed the biometric gate. There is no auto-sign
 * path, by construction.
 */

// ---------------------------------------------------------------------------
// Project id configuration (Settings), same store pattern as ./aa.ts
// ---------------------------------------------------------------------------

const WC_CONFIG_KEY = 'shiba-wallet.wc-config.v1';

/**
 * The relay project id is public client configuration (it identifies the
 * app to the WalletConnect relay, it is not a secret), so it lives in
 * AsyncStorage like RPC endpoints — never in the secure store. The user
 * creates one for free at https://dashboard.reown.com; this app ships with
 * none and the whole feature stays off until one is saved.
 */
export async function getWcProjectId(store: KeyValueStore = AsyncStorage): Promise<string | null> {
  try {
    const raw = await store.getItem(WC_CONFIG_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const id = (parsed as { projectId?: unknown }).projectId;
      return typeof id === 'string' && id !== '' ? id : null;
    }
    return null;
  } catch {
    // Corrupt JSON or unavailable storage: behave as unconfigured.
    return null;
  }
}

/**
 * Saves the project id. Observed Reown project ids are 32-character hex
 * strings, but that format is not documented as a contract, so validation
 * only refuses obviously wrong input (whitespace, URLs, empty).
 */
export async function setWcProjectId(
  projectId: string,
  store: KeyValueStore = AsyncStorage,
): Promise<string> {
  const trimmed = projectId.trim();
  if (!/^[0-9a-zA-Z_-]{8,128}$/.test(trimmed)) {
    throw new Error(
      'A project id is a short token (letters and digits, no spaces or URLs). ' +
        'Copy it from your project page at dashboard.reown.com.',
    );
  }
  await store.setItem(WC_CONFIG_KEY, JSON.stringify({ projectId: trimmed }));
  return trimmed;
}

/** Removes the stored project id (disables WalletConnect). */
export async function clearWcProjectId(store: KeyValueStore = AsyncStorage): Promise<void> {
  await store.setItem(WC_CONFIG_KEY, JSON.stringify({}));
}

// ---------------------------------------------------------------------------
// What this wallet supports (this pass)
// ---------------------------------------------------------------------------

export const WC_SUPPORTED_CHAINS = [EVM_CHAIN_ID]; // eip155:1 only
export const WC_SUPPORTED_METHODS = [
  'personal_sign',
  'eth_signTypedData_v4',
  'eth_sendTransaction',
];
export const WC_SUPPORTED_EVENTS = ['accountsChanged', 'chainChanged'];

/**
 * WalletConnect SDK error payloads (from @walletconnect/utils getSdkError,
 * the codes the WC ecosystem expects — its equivalent of EIP-1193's 4001):
 * USER_REJECTED 5000, UNSUPPORTED_CHAINS 5100, UNSUPPORTED_METHODS 5101,
 * USER_DISCONNECTED 6000 (values confirmed against the installed package).
 */
export const WC_ERRORS = {
  userRejected: getSdkError('USER_REJECTED'),
  unsupportedChains: getSdkError('UNSUPPORTED_CHAINS'),
  unsupportedMethods: getSdkError('UNSUPPORTED_METHODS'),
  userDisconnected: getSdkError('USER_DISCONNECTED'),
} as const;

// ---------------------------------------------------------------------------
// Session proposals: namespace construction + display summary
// ---------------------------------------------------------------------------

/**
 * Builds the approved namespaces for a session proposal from the wallet's
 * single EOA account, via the SDK's own buildApprovedNamespaces (the
 * documented approval path). THROWS when the proposal requires chains,
 * methods or namespaces this wallet does not support — the caller must
 * catch and reject the session with WC_ERRORS.unsupportedChains.
 */
export function buildWalletNamespaces(
  proposalParams: unknown,
  ethAddress: string,
): Record<string, unknown> {
  // buildApprovedNamespaces's parameter type is the sign-client proposal
  // struct; the runtime event delivers exactly that shape, so the cast only
  // bridges the type worlds, not the data.
  return buildApprovedNamespaces({
    proposal: proposalParams as Parameters<typeof buildApprovedNamespaces>[0]['proposal'],
    supportedNamespaces: {
      eip155: {
        chains: WC_SUPPORTED_CHAINS,
        methods: WC_SUPPORTED_METHODS,
        events: WC_SUPPORTED_EVENTS,
        accounts: WC_SUPPORTED_CHAINS.map((chain) => `${chain}:${ethAddress}`),
      },
    },
  }) as unknown as Record<string, unknown>;
}

export interface WcProposalSummary {
  id: number;
  /** dApp metadata, straight from the proposer (display only, unverified). */
  name: string;
  url: string;
  description: string;
  /** Chains the dApp requires / would like, CAIP-2 ids. */
  requiredChains: string[];
  optionalChains: string[];
  /** All eip155 methods the dApp asked for. */
  methods: string[];
  /** Required chains this wallet cannot serve (approval will fail). */
  unsupportedRequired: string[];
}

/** Defensive read of a proposal event for the approval UI. */
export function describeProposal(proposal: { id: number; params: unknown }): WcProposalSummary {
  const params = (proposal.params ?? {}) as {
    proposer?: { metadata?: { name?: unknown; url?: unknown; description?: unknown } };
    requiredNamespaces?: Record<string, { chains?: unknown; methods?: unknown }>;
    optionalNamespaces?: Record<string, { chains?: unknown; methods?: unknown }>;
  };
  const meta = params.proposer?.metadata ?? {};
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

  const collect = (
    namespaces: Record<string, { chains?: unknown; methods?: unknown }> | undefined,
  ): { chains: string[]; methods: string[] } => {
    const chains: string[] = [];
    const methods: string[] = [];
    for (const [key, ns] of Object.entries(namespaces ?? {})) {
      // CAIP-2 ids appear either in ns.chains or as a qualified key
      // ("eip155:1"); a bare key ("eip155") alone carries no chain id.
      chains.push(...strings(ns?.chains));
      if (key.includes(':')) chains.push(key);
      methods.push(...strings(ns?.methods));
    }
    return { chains: [...new Set(chains)], methods: [...new Set(methods)] };
  };

  const required = collect(params.requiredNamespaces);
  const optional = collect(params.optionalNamespaces);
  return {
    id: proposal.id,
    name: str(meta.name) || 'Unknown dApp',
    url: str(meta.url),
    description: str(meta.description),
    requiredChains: required.chains,
    optionalChains: optional.chains,
    methods: [...new Set([...required.methods, ...optional.methods])],
    unsupportedRequired: required.chains.filter((c) => !WC_SUPPORTED_CHAINS.includes(c)),
  };
}

// ---------------------------------------------------------------------------
// EIP-191 (personal_sign) digest
// ---------------------------------------------------------------------------

/**
 * The digest personal_sign commits to, per EIP-191 version 0x45
 * (https://eips.ethereum.org/EIPS/eip-191):
 *   keccak256("\x19Ethereum Signed Message:\n" || len(message) || message)
 * where len is the byte length in decimal ASCII. The engine's
 * toEthSignedMessageHash covers only the 32-byte-digest special case (its
 * ERC-4337 use), so the general length-prefixed form lives here;
 * scripts/check-wc.mjs asserts byte-identity with ethers.hashMessage and,
 * for 32-byte messages, with the engine helper.
 */
export function personalMessageDigest(message: Uint8Array): Uint8Array {
  const prefix = `\u0019Ethereum Signed Message:\n${message.length}`;
  return keccak_256(concatBytes(utf8ToBytes(prefix), message));
}

/** True for 0x-prefixed, even-length hex of at least one byte. */
function isHexData(value: string): boolean {
  return /^0x(?:[0-9a-fA-F]{2})+$/.test(value);
}

function isAddressShaped(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

/**
 * Best-effort UTF-8 decode for display. Returns null when the bytes are not
 * valid UTF-8 or contain non-printable control characters — the UI then
 * shows the hex instead of mojibake. Display only; signing always uses the
 * exact bytes.
 */
export function decodeMessageForDisplay(message: Uint8Array): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(message);
    for (const ch of text) {
      const code = ch.codePointAt(0)!;
      if (code === 0x7f || (code < 0x20 && ch !== '\n' && ch !== '\r' && ch !== '\t')) {
        return null;
      }
    }
    return text;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// EIP-712 (eth_signTypedData_v4) parsing on top of the engine's hashing
// ---------------------------------------------------------------------------

export interface WcTypedData {
  domain: TypedDataDomain;
  types: TypedDataTypes;
  primaryType: string;
  message: Record<string, unknown>;
  /** The 32-byte digest the wallet signs (engine typedDataDigest). */
  digest: Uint8Array;
  /** Parsed JSON for the approval screen's pretty display. */
  raw: unknown;
}

/** Spec order of EIP712Domain fields (EIP-712), with their exact types. */
const DOMAIN_FIELD_TYPES: Record<string, string> = {
  name: 'string',
  version: 'string',
  chainId: 'uint256',
  verifyingContract: 'address',
  salt: 'bytes32',
};
const DOMAIN_FIELD_ORDER = ['name', 'version', 'chainId', 'verifyingContract', 'salt'];

/**
 * Parses and validates an eth_signTypedData_v4 payload (the JSON string the
 * dApp sends) and computes the signing digest through the engine's EIP-712
 * implementation (chains-evm eip712.ts, byte-identical with ethers
 * TypedDataEncoder in the engine's own tests). Throws with a plain-language
 * reason whenever signing would be unsafe or ambiguous:
 *
 *  - domain.chainId present but not 1: this wallet only serves eip155:1 in
 *    this pass, and silently signing another chain's domain is how replayed
 *    permits happen. (Absent chainId is allowed — e.g. Snapshot-style
 *    off-chain domains legitimately omit it.)
 *  - domain keys outside the five EIP-712 fields, or a declared
 *    types.EIP712Domain whose fields differ (names, order or types) from
 *    the spec's canonical sequence for the present fields: the engine
 *    builds the domain separator in canonical order from the value object,
 *    so any divergence means the digest we compute could differ from what
 *    the dApp verifies against. Refusing is the only honest move.
 */
export function parseTypedDataV4(json: string): WcTypedData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Typed-data payload is not valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Typed-data payload must be a JSON object.');
  }
  const td = parsed as {
    types?: unknown;
    primaryType?: unknown;
    domain?: unknown;
    message?: unknown;
  };
  if (typeof td.types !== 'object' || td.types === null) {
    throw new Error('Typed data is missing its "types" object.');
  }
  if (typeof td.primaryType !== 'string' || td.primaryType === '') {
    throw new Error('Typed data is missing its "primaryType".');
  }
  if (td.primaryType === 'EIP712Domain') {
    throw new Error('Refusing to sign a bare EIP712Domain (no message content).');
  }
  if (typeof td.domain !== 'object' || td.domain === null) {
    throw new Error('Typed data is missing its "domain" object.');
  }
  if (typeof td.message !== 'object' || td.message === null) {
    throw new Error('Typed data is missing its "message" object.');
  }

  const domainIn = td.domain as Record<string, unknown>;
  for (const key of Object.keys(domainIn)) {
    if (!(key in DOMAIN_FIELD_TYPES)) {
      throw new Error(
        `Unsupported EIP-712 domain field "${key}" — signing could produce a ` +
          'digest the dApp does not expect, so the request is declined.',
      );
    }
  }

  // chainId arrives as number, decimal string, or 0x hex depending on the
  // dApp's library; normalize to bigint for the engine.
  let chainId: bigint | undefined;
  if (domainIn.chainId !== undefined && domainIn.chainId !== null) {
    try {
      chainId = BigInt(domainIn.chainId as string | number | bigint);
    } catch {
      throw new Error(`Unreadable domain chainId: ${String(domainIn.chainId)}`);
    }
    const expected = BigInt(EVM_CHAIN_ID.split(':')[1]!);
    if (chainId !== expected) {
      throw new Error(
        `This typed data is for chain id ${chainId}, but this wallet only signs ` +
          `for Ethereum mainnet (chain id ${expected}) over WalletConnect in this pass.`,
      );
    }
  }

  const presentDomainFields = DOMAIN_FIELD_ORDER.filter((k) => domainIn[k] !== undefined);

  // If the dApp declared EIP712Domain explicitly, it must match what the
  // engine will hash — same fields, same order, same types.
  const declaredDomain = (td.types as Record<string, unknown>).EIP712Domain;
  if (declaredDomain !== undefined) {
    const declared = (Array.isArray(declaredDomain) ? declaredDomain : []) as TypedDataField[];
    const declaredSig = declared.map((f) => `${f?.type} ${f?.name}`).join(',');
    const canonicalSig = presentDomainFields
      .map((k) => `${DOMAIN_FIELD_TYPES[k]} ${k}`)
      .join(',');
    if (declaredSig !== canonicalSig) {
      throw new Error(
        `The dApp's EIP712Domain declaration (${declaredSig || 'empty'}) does not match ` +
          `the canonical form for its domain values (${canonicalSig}); refusing to sign ` +
          'an ambiguous domain.',
      );
    }
  }

  const domain: TypedDataDomain = {
    ...(typeof domainIn.name === 'string' ? { name: domainIn.name } : {}),
    ...(typeof domainIn.version === 'string' ? { version: domainIn.version } : {}),
    ...(chainId !== undefined ? { chainId } : {}),
    ...(typeof domainIn.verifyingContract === 'string'
      ? { verifyingContract: domainIn.verifyingContract }
      : {}),
    ...(typeof domainIn.salt === 'string' ? { salt: domainIn.salt } : {}),
  };

  const types = td.types as TypedDataTypes;
  const message = td.message as Record<string, unknown>;
  const digest = typedDataDigest(domain, types, td.primaryType, message);
  return { domain, types, primaryType: td.primaryType, message, digest, raw: parsed };
}

// ---------------------------------------------------------------------------
// Session request parsing / routing
// ---------------------------------------------------------------------------

/** The shape WalletKit delivers on 'session_request' (defensively typed). */
export interface WcRequestEvent {
  id: number;
  topic: string;
  params: {
    request: { method: string; params: unknown };
    chainId: string;
  };
}

/**
 * A request that must be answered with an error instead of UI. The code and
 * message go verbatim into the JSON-RPC error response.
 */
export class WcRequestRejection extends Error {
  /** JSON-RPC / WalletConnect SDK error code for the response. */
  code: number;

  // No TS parameter properties: this module runs under Node's strip-only
  // type stripping in scripts/check-wc.mjs, which rejects them.
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
    this.name = 'WcRequestRejection';
  }
}

export type ParsedWcRequest =
  | {
      kind: 'personal_sign';
      messageBytes: Uint8Array;
      messageHex: string;
      /** UTF-8 text when printable, else null (UI shows hex). */
      messageText: string | null;
      digest: Uint8Array;
    }
  | { kind: 'typed_data'; typedData: WcTypedData }
  | { kind: 'transaction'; tx: WcTxParams };

export interface WcTxParams {
  /** EIP-55 normalized recipient (contract or EOA). */
  to: string;
  valueWei: bigint;
  data: Uint8Array;
}

function requireArrayParams(params: unknown, method: string): unknown[] {
  if (!Array.isArray(params) || params.length === 0) {
    throw new WcRequestRejection(-32602, `${method}: expected a non-empty params array.`);
  }
  return params;
}

/**
 * Routes one session_request into a typed, validated shape, or throws
 * WcRequestRejection with the error the dApp should receive. The
 * walletAddress is the wallet's single EOA account; any request naming a
 * different signer is refused (a session only ever exposed this account).
 */
export function parseWcRequest(event: WcRequestEvent, walletAddress: string): ParsedWcRequest {
  const chainId = event.params?.chainId;
  if (chainId !== EVM_CHAIN_ID) {
    throw new WcRequestRejection(
      WC_ERRORS.unsupportedChains.code,
      `This wallet only serves ${EVM_CHAIN_ID} over WalletConnect (request was for ${chainId}).`,
    );
  }
  const method = event.params?.request?.method;
  const params = event.params?.request?.params;
  const wallet = walletAddress.toLowerCase();

  const requireOurAddress = (candidate: unknown, role: string): void => {
    if (typeof candidate !== 'string' || candidate.toLowerCase() !== wallet) {
      throw new WcRequestRejection(
        -32602,
        `${method}: the ${role} (${String(candidate)}) is not this wallet's account.`,
      );
    }
  };

  if (method === 'personal_sign') {
    // Convention (WalletConnect usage docs / MetaMask): params are
    // [message, address]. Some dApps send [address, message]; since one of
    // the two must be the session account, detect the address positionally
    // and treat the other entry as the message.
    const p = requireArrayParams(params, method);
    if (p.length < 2 || typeof p[0] !== 'string' || typeof p[1] !== 'string') {
      throw new WcRequestRejection(-32602, 'personal_sign: expected [message, address].');
    }
    let messageRaw: string;
    let addressRaw: string;
    if (isAddressShaped(p[0]) && p[0].toLowerCase() === wallet && !isAddressShaped(p[1])) {
      [addressRaw, messageRaw] = [p[0], p[1]];
    } else {
      [messageRaw, addressRaw] = [p[0], p[1]];
    }
    requireOurAddress(addressRaw, 'signing address');
    // Messages normally arrive 0x-hex encoded; a bare string is treated as
    // UTF-8 text (both are common in the wild). Signing uses these exact
    // bytes; the hex/text split is only about transport encoding.
    const messageBytes = isHexData(messageRaw) ? toBytes(messageRaw) : utf8ToBytes(messageRaw);
    return {
      kind: 'personal_sign',
      messageBytes,
      messageHex: toHex(messageBytes),
      messageText: decodeMessageForDisplay(messageBytes),
      digest: personalMessageDigest(messageBytes),
    };
  }

  if (method === 'eth_signTypedData_v4') {
    // Params per the v4 spec: [address, typedDataJson].
    const p = requireArrayParams(params, method);
    if (p.length < 2 || typeof p[0] !== 'string') {
      throw new WcRequestRejection(-32602, 'eth_signTypedData_v4: expected [address, typedData].');
    }
    requireOurAddress(p[0], 'signing address');
    const json = typeof p[1] === 'string' ? p[1] : JSON.stringify(p[1]);
    try {
      return { kind: 'typed_data', typedData: parseTypedDataV4(json) };
    } catch (e) {
      throw new WcRequestRejection(
        WC_ERRORS.userRejected.code,
        e instanceof Error ? e.message : 'Unreadable typed data.',
      );
    }
  }

  if (method === 'eth_sendTransaction') {
    const p = requireArrayParams(params, method);
    const tx = p[0];
    if (typeof tx !== 'object' || tx === null) {
      throw new WcRequestRejection(-32602, 'eth_sendTransaction: expected a transaction object.');
    }
    const t = tx as Record<string, unknown>;
    if (t.from !== undefined) requireOurAddress(t.from, 'sender');
    if (typeof t.to !== 'string') {
      // No `to` means contract deployment; this wallet does not deploy
      // contracts from a dApp request in this pass.
      throw new WcRequestRejection(
        WC_ERRORS.userRejected.code,
        'eth_sendTransaction without "to" (contract deployment) is not supported.',
      );
    }
    const validated = validateRecipient(EVM_CHAIN_ID, t.to);
    if (!validated.ok) {
      throw new WcRequestRejection(-32602, `eth_sendTransaction: ${validated.error}`);
    }
    let valueWei = 0n;
    if (t.value !== undefined && t.value !== null && t.value !== '' && t.value !== '0x') {
      try {
        valueWei = BigInt(t.value as string | number);
      } catch {
        throw new WcRequestRejection(-32602, `eth_sendTransaction: unreadable value ${String(t.value)}.`);
      }
      if (valueWei < 0n) {
        throw new WcRequestRejection(-32602, 'eth_sendTransaction: negative value.');
      }
    }
    // Both `data` (standard) and `input` (geth alias) appear in the wild.
    const dataRaw = (t.data ?? t.input) as unknown;
    let data: Uint8Array = new Uint8Array(0);
    if (typeof dataRaw === 'string' && dataRaw !== '' && dataRaw !== '0x') {
      if (!isHexData(dataRaw)) {
        throw new WcRequestRejection(-32602, 'eth_sendTransaction: data is not valid hex.');
      }
      data = toBytes(dataRaw);
    }
    // dApp-supplied gas/gasPrice/maxFeePerGas/nonce are deliberately
    // ignored: the app re-quotes through its own machinery (endpoint
    // chain-id verification, estimateGas, simulation) so the user always
    // confirms fees this wallet computed, not fees a dApp asserted.
    return { kind: 'transaction', tx: { to: validated.normalized, valueWei, data } };
  }

  throw new WcRequestRejection(
    WC_ERRORS.unsupportedMethods.code,
    `Method ${String(method)} is not supported by this wallet over WalletConnect ` +
      `(supported: ${WC_SUPPORTED_METHODS.join(', ')}).`,
  );
}

// ---------------------------------------------------------------------------
// Signing (called only after user approval + biometric gate)
// ---------------------------------------------------------------------------

/**
 * 65-byte r||s||v Ethereum signature over a 32-byte digest: the core
 * account signs (r||s||recid) and withEthereumV maps recid to 27/28, the
 * form ecrecover-based verifiers (and dApps) expect. Returned as 0x hex —
 * the JSON-RPC result payload for both sign methods.
 */
export function signDigest(account: DerivedAccount, digest: Uint8Array): string {
  return toHex(withEthereumV(account.sign(digest)));
}

// ---------------------------------------------------------------------------
// JSON-RPC response shapes (respondSessionRequest payloads, per usage docs)
// ---------------------------------------------------------------------------

export interface WcResponse {
  id: number;
  jsonrpc: '2.0';
  result?: string;
  error?: { code: number; message: string };
}

export function wcResult(id: number, result: string): WcResponse {
  return { id, jsonrpc: '2.0', result };
}

export function wcError(id: number, error: { code: number; message: string }): WcResponse {
  return { id, jsonrpc: '2.0', error: { code: error.code, message: error.message } };
}

// ---------------------------------------------------------------------------
// The client surface this app uses (structural, so scripts/check-wc.mjs can
// exercise every flow against a fake; the real IWalletKit satisfies it)
// ---------------------------------------------------------------------------

export interface WcClient {
  pair(args: { uri: string }): Promise<unknown>;
  approveSession(args: {
    id: number;
    namespaces: Record<string, unknown>;
  }): Promise<unknown>;
  rejectSession(args: { id: number; reason: { code: number; message: string } }): Promise<unknown>;
  respondSessionRequest(args: { topic: string; response: WcResponse }): Promise<unknown>;
  disconnectSession(args: {
    topic: string;
    reason: { code: number; message: string };
  }): Promise<unknown>;
  getActiveSessions(): Record<string, unknown>;
  on(event: string, listener: (args: never) => void): unknown;
  off(event: string, listener: (args: never) => void): unknown;
}

/**
 * Approves a proposal with this wallet's account, or — when the proposal
 * demands something unsupported — rejects it properly and reports why.
 */
export async function approveProposal(
  client: WcClient,
  proposal: { id: number; params: unknown },
  ethAddress: string,
): Promise<{ approved: true } | { approved: false; reason: string }> {
  let namespaces: Record<string, unknown>;
  try {
    namespaces = buildWalletNamespaces(proposal.params, ethAddress);
  } catch (e) {
    await client.rejectSession({ id: proposal.id, reason: WC_ERRORS.unsupportedChains });
    return {
      approved: false,
      reason:
        e instanceof Error
          ? e.message
          : 'The dApp requires chains or methods this wallet does not support.',
    };
  }
  await client.approveSession({ id: proposal.id, namespaces });
  return { approved: true };
}

/** Rejects a proposal as a user decision (USER_REJECTED). */
export async function rejectProposal(client: WcClient, proposalId: number): Promise<void> {
  await client.rejectSession({ id: proposalId, reason: WC_ERRORS.userRejected });
}

/** Responds to a request the user declined. */
export async function respondRejected(
  client: WcClient,
  topic: string,
  requestId: number,
  error: { code: number; message: string } = WC_ERRORS.userRejected,
): Promise<void> {
  await client.respondSessionRequest({ topic, response: wcError(requestId, error) });
}

/** Responds with a successful result (signature hex or transaction hash). */
export async function respondApproved(
  client: WcClient,
  topic: string,
  requestId: number,
  result: string,
): Promise<void> {
  await client.respondSessionRequest({ topic, response: wcResult(requestId, result) });
}

/** Disconnects one session at the user's request. */
export async function disconnectWcSession(client: WcClient, topic: string): Promise<void> {
  await client.disconnectSession({ topic, reason: WC_ERRORS.userDisconnected });
}

export interface WcSessionSummary {
  topic: string;
  name: string;
  url: string;
  chains: string[];
  methods: string[];
  /** Unix seconds, or null when the SDK did not report one. */
  expiry: number | null;
}

/** Defensive display mapping of getActiveSessions() for the sessions list. */
export function summarizeSessions(sessions: Record<string, unknown>): WcSessionSummary[] {
  return Object.entries(sessions).map(([topic, session]) => {
    const s = (session ?? {}) as {
      topic?: unknown;
      peer?: { metadata?: { name?: unknown; url?: unknown } };
      namespaces?: Record<string, { accounts?: unknown; methods?: unknown }>;
      expiry?: unknown;
    };
    const chains = new Set<string>();
    const methods = new Set<string>();
    for (const ns of Object.values(s.namespaces ?? {})) {
      if (Array.isArray(ns?.accounts)) {
        for (const account of ns.accounts) {
          if (typeof account === 'string') {
            // CAIP-10: "eip155:1:0x..." — the chain is the first two parts.
            const parts = account.split(':');
            if (parts.length === 3) chains.add(`${parts[0]}:${parts[1]}`);
          }
        }
      }
      if (Array.isArray(ns?.methods)) {
        for (const m of ns.methods) if (typeof m === 'string') methods.add(m);
      }
    }
    return {
      topic: typeof s.topic === 'string' ? s.topic : topic,
      name: typeof s.peer?.metadata?.name === 'string' ? s.peer.metadata.name : 'Unknown dApp',
      url: typeof s.peer?.metadata?.url === 'string' ? s.peer.metadata.url : '',
      chains: [...chains],
      methods: [...methods],
      expiry: typeof s.expiry === 'number' ? s.expiry : null,
    };
  });
}

/** Basic shape check before handing a pairing URI to the SDK. */
export function validatePairingUri(uri: string): { ok: true; uri: string } | { ok: false; error: string } {
  const trimmed = uri.trim();
  if (!trimmed.startsWith('wc:')) {
    return { ok: false, error: 'A WalletConnect pairing URI starts with "wc:".' };
  }
  if (!trimmed.includes('@2')) {
    return {
      ok: false,
      error: 'This looks like a WalletConnect v1 URI; only v2 ("wc:…@2…") is supported.',
    };
  }
  return { ok: true, uri: trimmed };
}

// ---------------------------------------------------------------------------
// SDK lifecycle (app side only; never runs under scripts/check-wc.mjs)
// ---------------------------------------------------------------------------

let cachedInit: { projectId: string; promise: Promise<WcClient> } | null = null;

/**
 * Initializes (once) and returns the WalletKit client. The compat shim and
 * the SDK are dynamically imported here, in the order the RN usage docs
 * require ("@walletconnect/react-native-compat must be imported before any
 * @reown/* dependencies"), so app startup and the Node check script never
 * evaluate them. WalletKit persists pairings/sessions itself through
 * AsyncStorage (via @walletconnect/core), so sessions survive app restarts
 * without this module storing anything beyond the project id.
 *
 * A project id change after a successful init requires an app restart: the
 * relay connection is a singleton by SDK design, and tearing it down
 * mid-flight would orphan live sessions. The Settings screen says so.
 */
export async function initWalletConnect(projectId: string): Promise<WcClient> {
  if (cachedInit && cachedInit.projectId === projectId) return cachedInit.promise;
  if (cachedInit && cachedInit.projectId !== projectId) {
    throw new Error(
      'WalletConnect was already started with a different project id. ' +
        'Restart the app to apply the new one.',
    );
  }
  const promise = (async (): Promise<WcClient> => {
    await import('@walletconnect/react-native-compat');
    const [{ WalletKit }, { Core }] = await Promise.all([
      import('@reown/walletkit'),
      import('@walletconnect/core'),
    ]);
    const core = new Core({ projectId });
    const kit = await WalletKit.init({
      core,
      metadata: {
        name: 'Shiba Wallet',
        description: 'Non-custodial multi-chain wallet with account abstraction',
        // Placeholder until the product has a real site (RFC 2606 reserves
        // .example): dApps display this URL as the wallet's identity.
        url: 'https://shiba-wallet.example',
        icons: [],
        // No `redirect` deep link: app.json defines no URL scheme yet, so
        // dApp-initiated returns (mobile linking) are a later, additive
        // step. Pairing still works by pasting the URI.
      },
    });
    // IWalletKit satisfies WcClient structurally; the cast bridges the
    // SDK's generic event typing to the narrow surface this app consumes.
    return kit as unknown as WcClient;
  })();
  cachedInit = { projectId, promise };
  try {
    return await promise;
  } catch (e) {
    // Failed init (bad project id, no network) must not poison retries.
    cachedInit = null;
    throw e;
  }
}
