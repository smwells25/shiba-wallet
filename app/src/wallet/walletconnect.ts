import AsyncStorage from '@react-native-async-storage/async-storage';
import { buildApprovedNamespaces, getSdkError, normalizeNamespaces } from '@walletconnect/utils';
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
import { EVM_MAINNET, EVM_SEPOLIA } from '../config/evm-chain.ts';

/**
 * WalletConnect v2 glue (Tier 1 feature 78): lets external dApps connect to
 * this wallet, request signatures, and submit transactions — on the ACTIVE
 * EVM chain only (Ethereum mainnet, or Sepolia while test mode is on; see
 * config/evm-chain.ts). Requests are handled app-wide by
 * WalletConnectContext, not only while the Connections screen is open.
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
 * produce, and the app-level approval sheet (WalletConnectContext +
 * components/WcApprovalSheet) calls it strictly after the user has seen
 * the request and passed the biometric gate. There is no auto-sign path,
 * by construction.
 *
 * SDK behavior this module relies on (read from the installed sources,
 * @walletconnect/utils 2.25.0 and @walletconnect/sign-client 2.25.0 via
 * their shipped source maps, dist/index.js.map → src/*.ts):
 *  - utils src/namespaces.ts buildApprovedNamespaces: the wallet's
 *    supportedNamespaces become the candidate session; the proposal's
 *    requiredNamespaces must CONFORM to it (utils src/validators.ts
 *    isConformingNamespaces: every required namespace key present, every
 *    required chain present, every required method and event present, via
 *    misc.ts hasOverlap which is really a subset test); optional chains
 *    are intersected with supported chains; namespaces left with no chain
 *    or account are deleted, so an all-unsupported optional-only proposal
 *    yields {} rather than an error.
 *  - sign-client src/controllers/engine.ts connect(): requiredNamespaces
 *    are deprecated and the SDK moves them into optionalNamespaces before
 *    sending, so modern dApps (e.g. Uniswap) arrive with required = {} and
 *    every chain in optional. approve() rejects an empty namespaces object
 *    (validators.ts isValidNamespaces → isValidObject requires keys).
 *  - sign-client engine isValidRequest(): a session_request whose chainId
 *    or method is not in the session's approved namespaces is answered
 *    with an error by the SDK itself and never reaches this app. So a
 *    method must be approved in the session for the app to see it.
 */

// ---------------------------------------------------------------------------
// Project id configuration (Settings), same store pattern as ./aa.ts
// ---------------------------------------------------------------------------

const WC_CONFIG_KEY = 'shiba-wallet.wc-config.v1';

/**
 * The relay project id is public client configuration (it identifies the
 * app to the WalletConnect relay, it is not a secret — every dApp ships
 * one in its frontend bundle), so it lives in AsyncStorage like RPC
 * endpoints — never in the secure store. The default below is the
 * project the Chairperson created at dashboard.reown.com for this app;
 * a value saved in Settings overrides it, and clearing the field
 * restores it.
 */
export const DEFAULT_WC_PROJECT_ID = 'a6d5afbd869df1713ca48fa14fb3fcf8';

export async function getWcProjectId(store: KeyValueStore = AsyncStorage): Promise<string | null> {
  try {
    const raw = await store.getItem(WC_CONFIG_KEY);
    if (!raw) return DEFAULT_WC_PROJECT_ID;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const id = (parsed as { projectId?: unknown }).projectId;
      return typeof id === 'string' && id !== '' ? id : DEFAULT_WC_PROJECT_ID;
    }
    return DEFAULT_WC_PROJECT_ID;
  } catch {
    // Corrupt JSON or unavailable storage: behave as default-configured.
    return DEFAULT_WC_PROJECT_ID;
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
// Launch-time start decision (global request listener, phase 6 item 5)
// ---------------------------------------------------------------------------

/**
 * "WalletConnect is in use on this device" marker. The SDK persists its
 * sessions in its own storage, but the key layout there is internal to
 * @walletconnect/core, so instead of peeking at it the app records its own
 * marker: set when a pairing is attempted or the SDK reports at least one
 * session, cleared when the SDK reports none. When set (and a project id
 * exists) the SDK starts at app launch so requests surface on any screen;
 * otherwise it stays lazy and starts when the Connections screen opens.
 *
 * A session created before this marker existed is picked up the first
 * time the Connections screen opens (that starts the SDK, which reports
 * the session and sets the marker for later launches).
 */
const WC_USED_KEY = 'shiba-wallet.wc-used.v1';

export async function getWcUsed(store: KeyValueStore = AsyncStorage): Promise<boolean> {
  try {
    const raw = await store.getItem(WC_USED_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as unknown;
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { used?: unknown }).used === true
    );
  } catch {
    return false;
  }
}

export async function setWcUsed(used: boolean, store: KeyValueStore = AsyncStorage): Promise<void> {
  await store.setItem(WC_USED_KEY, JSON.stringify({ used }));
}

/**
 * Start the SDK at launch only when it can have work to do: a project id
 * is configured AND WalletConnect has been used (a session persists or a
 * pairing was attempted). Every other launch leaves the SDK unevaluated.
 */
export function shouldStartWalletConnectAtLaunch(
  projectId: string | null | undefined,
  used: boolean,
): boolean {
  return typeof projectId === 'string' && projectId !== '' && used;
}

// ---------------------------------------------------------------------------
// What this wallet supports (this pass)
// ---------------------------------------------------------------------------

/**
 * The default supported chain set (Ethereum mainnet). While the Settings
 * Sepolia test mode is on, the app-level WalletConnect provider passes
 * the active chain ('eip155:11155111') into the functions below
 * instead — the wallet then builds eip155:11155111 namespaces and declines
 * eip155:1 requests, so a session approved in one mode can never be
 * served in the other (phase 4, item 6). Defaults keep the historical
 * mainnet behavior for existing callers and scripts/check-wc.mjs.
 */
export const WC_SUPPORTED_CHAINS = [EVM_CHAIN_ID]; // eip155:1 by default

/** The methods that need the user's approval (and a signature). */
export const WC_SIGNING_METHODS = [
  'personal_sign',
  'eth_signTypedData_v4',
  'eth_sendTransaction',
];

/**
 * Everything the wallet offers in a session. wallet_switchEthereumChain is
 * offered so the dApp's switch requests reach the app (the SDK drops
 * methods outside the session — see the module header) and get an honest
 * answer: null when the requested chain is already the active one,
 * UNSUPPORTED_CHAINS with a plain-language reason otherwise. It never
 * changes the wallet's mode and never signs anything (decideSwitchChain).
 * buildApprovedNamespaces only approves methods the dApp itself asked for,
 * so dApps that did not request it never see it.
 */
export const WC_SUPPORTED_METHODS = [...WC_SIGNING_METHODS, 'wallet_switchEthereumChain'];
export const WC_SUPPORTED_EVENTS = ['accountsChanged', 'chainChanged'];

/**
 * WalletConnect SDK error payloads (from @walletconnect/utils getSdkError,
 * the codes the WC ecosystem expects — its equivalent of EIP-1193's 4001).
 * Values read from the installed utils src/errors.ts SDK_ERRORS table:
 * USER_REJECTED 5000, UNSUPPORTED_CHAINS 5100, UNSUPPORTED_METHODS 5101,
 * UNSUPPORTED_EVENTS 5102, UNSUPPORTED_NAMESPACE_KEY 5104,
 * USER_DISCONNECTED 6000.
 */
export const WC_ERRORS = {
  userRejected: getSdkError('USER_REJECTED'),
  unsupportedChains: getSdkError('UNSUPPORTED_CHAINS'),
  unsupportedMethods: getSdkError('UNSUPPORTED_METHODS'),
  unsupportedEvents: getSdkError('UNSUPPORTED_EVENTS'),
  unsupportedNamespaceKey: getSdkError('UNSUPPORTED_NAMESPACE_KEY'),
  userDisconnected: getSdkError('USER_DISCONNECTED'),
} as const;

// ---------------------------------------------------------------------------
// Plain-language chain / mode wording (the active-chain rule)
// ---------------------------------------------------------------------------

/** Human name for a CAIP-2 chain id; unknown chains show their id. */
export function describeChain(caip2: string): string {
  if (caip2 === EVM_MAINNET.caip2) return 'Ethereum mainnet';
  if (caip2 === EVM_SEPOLIA.caip2) return 'Ethereum Sepolia (test network)';
  return caip2;
}

/** The wallet mode a chain belongs to, or null for chains no mode serves. */
function modeName(caip2: string): string | null {
  if (caip2 === EVM_MAINNET.caip2) return 'mainnet mode';
  if (caip2 === EVM_SEPOLIA.caip2) return 'Sepolia test mode';
  return null;
}

/**
 * The sentence shown (and sent to the dApp) when something asks for the
 * chain of the OTHER wallet mode, e.g. "This dApp asked for Ethereum
 * mainnet; the wallet is in Sepolia test mode. Switch modes in Settings →
 * Developer to connect."
 */
export function modeMismatchMessage(
  requestedChain: string,
  activeChain: string,
  purpose: 'connect' | 'use this connection',
): string {
  const active = modeName(activeChain) ?? activeChain;
  const how =
    requestedChain === EVM_SEPOLIA.caip2
      ? `Turn on Sepolia test mode in Settings → Developer to ${purpose}.`
      : `Switch modes in Settings → Developer to ${purpose}.`;
  return `This dApp asked for ${describeChain(requestedChain)}; the wallet is in ${active}. ${how}`;
}

/** True when `chain` is the chain of the other (inactive) wallet mode. */
function isOtherModeChain(chain: string, activeChain: string): boolean {
  return chain !== activeChain && modeName(chain) !== null;
}

/**
 * The sentence for a chain this wallet serves in neither mode, or the
 * mode-mismatch sentence when the chain belongs to the other mode.
 */
function unsupportedChainMessage(
  chains: string[],
  activeChain: string,
  purpose: 'connect' | 'use this connection',
): string {
  const otherMode = chains.find((c) => isOtherModeChain(c, activeChain));
  if (otherMode && chains.every((c) => c === otherMode)) {
    return modeMismatchMessage(otherMode, activeChain, purpose);
  }
  const unknown = chains.filter((c) => c !== activeChain);
  return (
    `This dApp requires ${unknown.map(describeChain).join(', ')}, which this wallet does ` +
    'not support over WalletConnect. It connects on Ethereum mainnet, or on Sepolia ' +
    `while test mode is on (currently: ${describeChain(activeChain)}).`
  );
}

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
  supportedChains: string[] = WC_SUPPORTED_CHAINS,
): Record<string, unknown> {
  // buildApprovedNamespaces's parameter type is the sign-client proposal
  // struct; the runtime event delivers exactly that shape, so the cast only
  // bridges the type worlds, not the data.
  return buildApprovedNamespaces({
    proposal: proposalParams as Parameters<typeof buildApprovedNamespaces>[0]['proposal'],
    supportedNamespaces: {
      eip155: {
        chains: supportedChains,
        methods: WC_SUPPORTED_METHODS,
        events: WC_SUPPORTED_EVENTS,
        accounts: supportedChains.map((chain) => `${chain}:${ethAddress}`),
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
export function describeProposal(
  proposal: { id: number; params: unknown },
  supportedChains: string[] = WC_SUPPORTED_CHAINS,
): WcProposalSummary {
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
    unsupportedRequired: required.chains.filter((c) => !supportedChains.includes(c)),
  };
}

/**
 * The wallet's answer to a session proposal under the active-chain rule:
 * the wallet only ever approves the ACTIVE EVM chain (eip155:1, or
 * eip155:11155111 while Sepolia test mode is on), never both.
 *
 *  - Required chains must all be the active chain. A required chain of the
 *    other mode → UNSUPPORTED_CHAINS (5100) with the mode-switch sentence;
 *    any other required chain → UNSUPPORTED_CHAINS with the unsupported
 *    sentence.
 *  - Required non-eip155 namespaces → UNSUPPORTED_NAMESPACE_KEY (5104);
 *    required methods / events beyond WC_SUPPORTED_* →
 *    UNSUPPORTED_METHODS (5101) / UNSUPPORTED_EVENTS (5102).
 *  - Optional chains (where modern dApps put everything, see the header)
 *    are intersected with the active chain; the others are reported in
 *    `droppedChains` so the approval sheet can say what was left out.
 *  - If nothing the dApp offered is the active chain, the proposal is
 *    declined up front (the SDK builder would return {} and approve()
 *    would throw) — with the mode-switch sentence when the dApp offered
 *    the other mode's chain.
 *  - A proposal with no namespaces at all gets the active chain (the
 *    builder's documented "return all supported namespaces" branch).
 *
 * The final namespaces still come from the SDK's buildApprovedNamespaces
 * (the documented approval path), then are re-checked: every approved
 * account must be `${activeChain}:${ethAddress}` and every key 'eip155'.
 */
export type ProposalDecision =
  | {
      ok: true;
      namespaces: Record<string, unknown>;
      /** Chains the dApp offered that this session will NOT include. */
      droppedChains: string[];
    }
  | {
      ok: false;
      /** SDK error for rejectSession (code + message). */
      error: { code: number; message: string };
      /** Plain-language explanation for the approval sheet. */
      reason: string;
    };

export function decideProposal(
  proposalParams: unknown,
  ethAddress: string,
  activeChain: string = EVM_CHAIN_ID,
): ProposalDecision {
  const params = (proposalParams ?? {}) as {
    requiredNamespaces?: Parameters<typeof normalizeNamespaces>[0];
    optionalNamespaces?: Parameters<typeof normalizeNamespaces>[0];
  };
  const reject = (
    error: { code: number; message: string },
    reason: string,
  ): ProposalDecision => ({ ok: false, error: { code: error.code, message: reason }, reason });

  let required: ReturnType<typeof normalizeNamespaces>;
  let optional: ReturnType<typeof normalizeNamespaces>;
  try {
    required = normalizeNamespaces(params.requiredNamespaces ?? {});
    optional = normalizeNamespaces(params.optionalNamespaces ?? {});
  } catch {
    return reject(WC_ERRORS.unsupportedChains, 'The connection request is malformed.');
  }
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

  const foreignRequired = Object.keys(required).filter((k) => k !== 'eip155');
  if (foreignRequired.length > 0) {
    return reject(
      WC_ERRORS.unsupportedNamespaceKey,
      `This dApp requires ${foreignRequired.join(', ')} accounts, which this wallet does not ` +
        'offer over WalletConnect (Ethereum only for now).',
    );
  }

  const requiredChains = list(required.eip155?.chains);
  const badRequired = requiredChains.filter((c) => c !== activeChain);
  if (badRequired.length > 0) {
    return reject(
      WC_ERRORS.unsupportedChains,
      unsupportedChainMessage(badRequired, activeChain, 'connect'),
    );
  }
  const badMethods = list(required.eip155?.methods).filter(
    (m) => !WC_SUPPORTED_METHODS.includes(m),
  );
  if (badMethods.length > 0) {
    return reject(
      WC_ERRORS.unsupportedMethods,
      `This dApp requires ${badMethods.join(', ')}, which this wallet does not support ` +
        `(supported: ${WC_SUPPORTED_METHODS.join(', ')}).`,
    );
  }
  const badEvents = list(required.eip155?.events).filter(
    (e) => !WC_SUPPORTED_EVENTS.includes(e),
  );
  if (badEvents.length > 0) {
    return reject(
      WC_ERRORS.unsupportedEvents,
      `This dApp requires the ${badEvents.join(', ')} event(s), which this wallet does not emit.`,
    );
  }

  const optionalChains = list(optional.eip155?.chains);
  const offered = [...new Set([...requiredChains, ...optionalChains])];
  const anyNamespaces = Object.keys(required).length > 0 || Object.keys(optional).length > 0;
  if (anyNamespaces && !offered.includes(activeChain)) {
    if (offered.length === 0) {
      return reject(
        WC_ERRORS.unsupportedChains,
        'This dApp did not ask for any Ethereum chain, so there is nothing this wallet can ' +
          'connect over WalletConnect.',
      );
    }
    return reject(WC_ERRORS.unsupportedChains, unsupportedChainMessage(offered, activeChain, 'connect'));
  }

  let namespaces: Record<string, unknown>;
  try {
    namespaces = buildWalletNamespaces(proposalParams, ethAddress, [activeChain]);
  } catch (e) {
    return reject(
      WC_ERRORS.unsupportedChains,
      e instanceof Error
        ? `The connection could not be built: ${e.message}`
        : 'The dApp requires chains or methods this wallet does not support.',
    );
  }

  // Defense in depth: the approved session may only ever expose the active
  // chain's account, whatever the builder returned.
  const expectedAccount = `${activeChain}:${ethAddress}`;
  const keys = Object.keys(namespaces);
  const accounts = keys.flatMap((k) =>
    list((namespaces[k] as { accounts?: unknown } | undefined)?.accounts),
  );
  if (
    keys.length === 0 ||
    keys.some((k) => k !== 'eip155') ||
    accounts.length === 0 ||
    accounts.some((a) => a !== expectedAccount)
  ) {
    return reject(
      WC_ERRORS.unsupportedChains,
      unsupportedChainMessage(offered.length ? offered : [activeChain], activeChain, 'connect'),
    );
  }
  return { ok: true, namespaces, droppedChains: offered.filter((c) => c !== activeChain) };
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
 *  - domain.chainId present but not the ACTIVE chain's id (`expectedChain`,
 *    CAIP-2, default eip155:1 — 'eip155:11155111' while Sepolia test mode
 *    is on): silently signing another chain's domain is how replayed
 *    permits happen. (Absent chainId is allowed — e.g. Snapshot-style
 *    off-chain domains legitimately omit it.)
 *  - domain keys outside the five EIP-712 fields, or a declared
 *    types.EIP712Domain whose fields differ (names, order or types) from
 *    the spec's canonical sequence for the present fields: the engine
 *    builds the domain separator in canonical order from the value object,
 *    so any divergence means the digest we compute could differ from what
 *    the dApp verifies against. Refusing is the only honest move.
 */
export function parseTypedDataV4(
  json: string,
  expectedChain: string = EVM_CHAIN_ID,
): WcTypedData {
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
    const expected = BigInt(expectedChain.split(':')[1]!);
    if (chainId !== expected) {
      throw new Error(
        `This typed data is for chain id ${chainId}, but this wallet only signs ` +
          `for the active chain (${expectedChain}) over WalletConnect.`,
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
 *
 * `activeChain` is the ACTIVE EVM chain's CAIP-2 id (config/evm-chain.ts):
 * requests for any other chain — including eip155:1 while Sepolia test
 * mode is on, and eip155:11155111 while it is off — are declined with
 * UNSUPPORTED_CHAINS, so the two modes never serve each other's sessions.
 */
export function parseWcRequest(
  event: WcRequestEvent,
  walletAddress: string,
  activeChain: string = EVM_CHAIN_ID,
): ParsedWcRequest {
  const chainId = event.params?.chainId;
  if (chainId !== activeChain) {
    // Typically a session approved in the other wallet mode (sessions
    // persist across mode switches; they are paused, not deleted).
    throw new WcRequestRejection(
      WC_ERRORS.unsupportedChains.code,
      typeof chainId === 'string'
        ? unsupportedChainMessage([chainId], activeChain, 'use this connection')
        : 'The request did not name a chain.',
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
      return { kind: 'typed_data', typedData: parseTypedDataV4(json, activeChain) };
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
// wallet_switchEthereumChain (answered without UI; never signs, never
// changes the wallet's mode)
// ---------------------------------------------------------------------------

/**
 * Decides a wallet_switchEthereumChain request. Semantics per EIP-3326
 * (https://eips.ethereum.org/EIPS/eip-3326, checked 2026-09-28): params
 * [{ chainId }] with chainId the integer id as a hex string "per the
 * eth_chainId method"; the method "MUST return null if the request was
 * successful, and an error otherwise". EIP-3326 defines no error codes
 * (4902 is a MetaMask provider convention, not part of the EIP), so
 * declines use the WalletConnect SDK's UNSUPPORTED_CHAINS (5100).
 *
 * Under the active-chain rule the wallet never switches modes on a dApp's
 * say-so (that is a deliberate user action in Settings → Developer):
 *  - target == active chain AND the session includes it → answer null
 *    (already there; nothing changes);
 *  - target == active chain but this session was approved for the other
 *    mode → decline; the dApp must reconnect in the current mode;
 *  - target is the other mode's chain → decline with the mode sentence;
 *  - anything else → decline as unsupported.
 */
export type SwitchChainDecision =
  | { kind: 'answer'; result: null }
  | { kind: 'decline'; error: { code: number; message: string } };

export function decideSwitchChain(
  event: WcRequestEvent,
  activeChain: string,
  sessionChains: string[],
): SwitchChainDecision {
  const decline = (code: number, message: string): SwitchChainDecision => ({
    kind: 'decline',
    error: { code, message },
  });
  const params = event.params?.request?.params;
  const first = Array.isArray(params) ? (params[0] as { chainId?: unknown } | undefined) : undefined;
  const raw = first && typeof first === 'object' ? first.chainId : undefined;
  if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]+$/.test(raw)) {
    return decline(-32602, 'wallet_switchEthereumChain: expected [{ chainId: "0x…" }].');
  }
  const target = `eip155:${BigInt(raw).toString(10)}`;
  if (target === activeChain) {
    if (sessionChains.includes(activeChain)) return { kind: 'answer', result: null };
    return decline(
      WC_ERRORS.unsupportedChains.code,
      `This connection was approved for ${sessionChains.map(describeChain).join(', ') || 'another chain'}. ` +
        `To use ${describeChain(activeChain)}, disconnect and reconnect from the dApp.`,
    );
  }
  return decline(
    WC_ERRORS.unsupportedChains.code,
    unsupportedChainMessage([target], activeChain, 'use this connection'),
  );
}

/** CAIP-2 chains a session's approved namespaces expose (from its accounts). */
export function sessionChainsOf(session: unknown): string[] {
  const s = (session ?? {}) as { namespaces?: Record<string, { accounts?: unknown }> };
  const chains = new Set<string>();
  for (const ns of Object.values(s.namespaces ?? {})) {
    if (!Array.isArray(ns?.accounts)) continue;
    for (const account of ns.accounts) {
      if (typeof account !== 'string') continue;
      const parts = account.split(':');
      if (parts.length === 3) chains.add(`${parts[0]}:${parts[1]}`);
    }
  }
  return [...chains];
}

/**
 * Plain-language note for a session approved in the OTHER wallet mode
 * (sessions survive a mode switch; they are paused, not deleted), or null
 * when the session includes the active chain.
 */
export function sessionModeNote(sessionChains: string[], activeChain: string): string | null {
  if (sessionChains.length === 0 || sessionChains.includes(activeChain)) return null;
  const names = sessionChains.map(describeChain).join(', ');
  return (
    `Approved for ${names}. Paused while the wallet is in ${modeName(activeChain) ?? activeChain}: ` +
    'its requests are declined until you switch modes back in Settings → Developer.'
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
  /**
   * Signature / transaction hash, or null (wallet_switchEthereumChain's
   * success value). The SDK accepts null: sign-client respond() validates
   * via utils validators.ts isValidResponse, which only requires that
   * result or error is not undefined.
   */
  result?: string | null;
  error?: { code: number; message: string };
}

export function wcResult(id: number, result: string | null): WcResponse {
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
 * Approves a proposal with this wallet's account on the ACTIVE chain, or —
 * when the proposal cannot be served under the active-chain rule (see
 * decideProposal) — rejects it with the matching SDK error and reports the
 * plain-language reason. The decision is recomputed here, at approval
 * time, so a mode switch between arrival and approval is honored.
 */
export async function approveProposal(
  client: WcClient,
  proposal: { id: number; params: unknown },
  ethAddress: string,
  activeChain: string = EVM_CHAIN_ID,
): Promise<{ approved: true } | { approved: false; reason: string }> {
  const decision = decideProposal(proposal.params, ethAddress, activeChain);
  if (!decision.ok) {
    await client.rejectSession({ id: proposal.id, reason: decision.error });
    return { approved: false, reason: decision.reason };
  }
  await client.approveSession({ id: proposal.id, namespaces: decision.namespaces });
  return { approved: true };
}

/** Rejects a proposal as a user decision (USER_REJECTED). */
export async function rejectProposal(client: WcClient, proposalId: number): Promise<void> {
  await client.rejectSession({ id: proposalId, reason: WC_ERRORS.userRejected });
}

/**
 * Declines a proposal from the approval sheet: with the specific SDK error
 * when the wallet cannot serve it (the sheet showed that reason), else as
 * a plain user rejection.
 */
export async function declineProposal(
  client: WcClient,
  proposal: { id: number; params: unknown },
  ethAddress: string,
  activeChain: string = EVM_CHAIN_ID,
): Promise<void> {
  const decision = decideProposal(proposal.params, ethAddress, activeChain);
  await client.rejectSession({
    id: proposal.id,
    reason: decision.ok ? WC_ERRORS.userRejected : decision.error,
  });
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

/**
 * Responds with a successful result (signature hex, transaction hash, or
 * null for wallet_switchEthereumChain).
 */
export async function respondApproved(
  client: WcClient,
  topic: string,
  requestId: number,
  result: string | null,
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
