import AsyncStorage from '@react-native-async-storage/async-storage';
import { buildApprovedNamespaces, getSdkError, normalizeNamespaces } from '@walletconnect/utils';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import type { DerivedAccount } from '@shiba-wallet/core';
import {
  ERC7715_CALLS_PERMISSION_TYPE,
  Erc7715RequestError,
  grantFromErc7715Request,
  toBytes,
  toHex,
  typedDataDigest,
  type Erc7715PermissionRequest,
  type SessionKeyGrant,
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
 * ERC-5792 (Wallet Call API) methods this wallet implements, offered ONLY in
 * sessions bound to a smart account (phase 7 item 2): an EOA has no atomic
 * batch, so EOA sessions never advertise them. wallet_showCallsStatus is
 * deliberately not offered (no in-app status screen for dApp batches yet).
 */
export const WC_5792_METHODS = ['wallet_getCapabilities', 'wallet_sendCalls', 'wallet_getCallsStatus'];

/** Everything a smart-account-bound session offers. */
export const WC_SMART_ACCOUNT_METHODS = [...WC_SUPPORTED_METHODS, ...WC_5792_METHODS];

/**
 * ERC-7715 methods this wallet serves (phase 8 item 2; method names from
 * ERC-7715, Draft, ethereum/ERCs ERCS/erc-7715.md at 2adc3783 — see
 * ./sessions.ts for the shapes). Offered ONLY on sessions bound to a Kernel
 * v3.3 smart account, because only Kernel has the permission system the
 * grants are installed into. wallet_revokeExecutionPermission and
 * wallet_getGrantedExecutionPermissions are not offered in this slice
 * (revocation happens in the wallet's Sessions screen).
 */
export const WC_7715_METHODS = ['wallet_getSupportedExecutionPermissions', 'wallet_requestExecutionPermissions'];

/** Everything a session bound to a Kernel v3.3 smart account offers. */
export const WC_KERNEL_SMART_ACCOUNT_METHODS = [...WC_SMART_ACCOUNT_METHODS, ...WC_7715_METHODS];

/** The methods a smart-account connection of this account type offers. */
export function smartAccountMethodsFor(accountType: string): string[] {
  return accountType === 'kernel-v3.3' ? WC_KERNEL_SMART_ACCOUNT_METHODS : WC_SMART_ACCOUNT_METHODS;
}

/**
 * Error codes for the ERC-7715 methods. ERC-7715: "If the request is
 * malformed or the wallet is unable/unwilling to grant permissions, wallet
 * MUST return an error with a code as defined in ERC-1193." EIP-1193
 * (Final, ethereum/EIPs EIPS/eip-1193.md, "Provider Errors") defines 4001
 * User Rejected Request, 4100 Unauthorized, 4200 Unsupported Method, 4900
 * Disconnected and 4901 Chain Disconnected, and nothing for a malformed or
 * unenforceable request. Mapping (a judgement where the table is silent):
 *  - the user declines → 4001;
 *  - `from` is not the connected account → 4100;
 *  - a permission or rule type the wallet cannot enforce → 4200 (the
 *    closest table entry: the wallet does not support what was requested);
 *  - the request names a chain other than the active one → 4901;
 *  - malformed, or refused by the engine's grant rules → -32602 (JSON-RPC
 *    2.0 Invalid params, as for this wallet's other methods), because
 *    EIP-1193's table has no entry for it.
 */
export const ERC7715_ERRORS = {
  userRejected: 4001,
  unauthorized: 4100,
  unsupported: 4200,
  chainDisconnected: 4901,
  invalidParams: -32602,
} as const;

/**
 * WalletConnect SDK error payloads (from @walletconnect/utils getSdkError,
 * the codes the WC ecosystem expects — its equivalent of EIP-1193's 4001).
 * Values read from the installed utils src/errors.ts SDK_ERRORS table:
 * USER_REJECTED 5000, UNSUPPORTED_CHAINS 5100, UNSUPPORTED_METHODS 5101,
 * UNSUPPORTED_EVENTS 5102, UNSUPPORTED_ACCOUNTS 5103,
 * UNSUPPORTED_NAMESPACE_KEY 5104, USER_DISCONNECTED 6000.
 */
export const WC_ERRORS = {
  userRejected: getSdkError('USER_REJECTED'),
  unsupportedChains: getSdkError('UNSUPPORTED_CHAINS'),
  unsupportedMethods: getSdkError('UNSUPPORTED_METHODS'),
  unsupportedEvents: getSdkError('UNSUPPORTED_EVENTS'),
  unsupportedAccounts: getSdkError('UNSUPPORTED_ACCOUNTS'),
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
  methods: readonly string[] = WC_SUPPORTED_METHODS,
): Record<string, unknown> {
  // buildApprovedNamespaces's parameter type is the sign-client proposal
  // struct; the runtime event delivers exactly that shape, so the cast only
  // bridges the type worlds, not the data.
  return buildApprovedNamespaces({
    proposal: proposalParams as Parameters<typeof buildApprovedNamespaces>[0]['proposal'],
    supportedNamespaces: {
      eip155: {
        chains: supportedChains,
        methods: [...methods],
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
  /**
   * The methods this connection would offer: WC_SUPPORTED_METHODS for an
   * EOA connection, WC_SMART_ACCOUNT_METHODS for a smart-account one.
   */
  methods: readonly string[] = WC_SUPPORTED_METHODS,
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
  const badMethods = list(required.eip155?.methods).filter((m) => !methods.includes(m));
  if (badMethods.length > 0) {
    return reject(
      WC_ERRORS.unsupportedMethods,
      `This dApp requires ${badMethods.join(', ')}, which this wallet does not support ` +
        `for this kind of connection (supported: ${methods.join(', ')}).`,
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
    namespaces = buildWalletNamespaces(proposalParams, ethAddress, [activeChain], methods);
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

// ---------------------------------------------------------------------------
// ADR D6: no EIP-7702 authorizations for dApps
// ---------------------------------------------------------------------------

/**
 * EIP-7702 (Final, ethereum/EIPs eip-7702.md at bbc3f958, "Interaction with
 * applications and wallets"): "Applications must not expect that they can
 * suggest the user sign an authorization, and therefore it is the duty of
 * the wallet to not provide an interface to do so. There is no safe way to
 * provide this interface." The wallet signs authorizations only in its own
 * "Upgrade this account" flow (./delegation.ts, ./aa.ts kernel-7702).
 *
 * How a dApp could ask for one over WalletConnect, each refused explicitly:
 *  - eth_sendTransaction with an authorization list: the transaction object
 *    is execution-apis' GenericTransaction (ethereum/execution-apis
 *    src/eth/submit.yaml; src/schemas/transaction.yaml at d24f58b5,
 *    2026-07-24), which has `authorizationList` ("EIP-7702 authorization
 *    list") and `type` (0x4 is EIP-7702's SET_CODE_TX_TYPE). Refused when
 *    `authorizationList` (or the snake_case `authorization_list`) is present
 *    at all, or `type` is 4 in any spelling — even an empty list.
 *  - wallet_sendCalls with ERC-7902's `eip7702Auth` capability (ERC-7902
 *    "Wallet Capabilities for Account Abstraction", Draft, ethereum/ERCs
 *    ERCS/erc-7902.md at 8b4d4631: "requests the Wallet Application to
 *    provide an EIP-7702 authorization tuple"), or any capability whose name
 *    or field names mention an authorization, 7702 or a delegation — refused
 *    even when marked optional (5792 would let an optional one be ignored;
 *    the wallet answers explicitly instead). A call object carrying an
 *    authorization list is refused the same way.
 *  - A dedicated signing method: no standard one exists in the sources
 *    above; any method name mentioning an authorization or 7702 gets this
 *    refusal instead of the generic unsupported-method one.
 * personal_sign and eth_signTypedData_v4 cannot yield a tuple signature:
 * the tuple digest is keccak256(0x05 || rlp([chain_id, address, nonce])),
 * while personal_sign hashes "\x19Ethereum Signed Message:\n…" and EIP-712
 * hashes 0x19 0x01 || …, so their digests differ by construction.
 */
export const EIP7702_WC_REFUSAL =
  'This wallet never signs EIP-7702 authorizations (account delegations) for dApps: a delegation ' +
  'gives the delegate contract full control of the account, and EIP-7702 itself says there is no ' +
  'safe way for a wallet to offer this to applications. Use Upgrade this account in the wallet ' +
  'instead.';

const EIP7702_HINT = /authori[sz]ation|7702|delegat/i;

/** True when a transaction-like object asks for an EIP-7702 set-code transaction. */
export function requestsEip7702Authorization(tx: Record<string, unknown>): boolean {
  if ('authorizationList' in tx && tx.authorizationList !== undefined) return true;
  if ('authorization_list' in tx && tx.authorization_list !== undefined) return true;
  const type = tx.type;
  if (type !== undefined && type !== null) {
    try {
      if (BigInt(type as string | number) === 4n) return true;
    } catch {
      // Unreadable type: not a set-code request (other checks handle it).
    }
  }
  return false;
}

/**
 * A capability asks for an authorization when its name, or a field name
 * inside it (any depth), mentions one. Field VALUES are not scanned, so a
 * URL or note that merely contains such a word is not refused.
 */
function capabilityMentions7702(name: string, value: unknown, depth = 0): boolean {
  if (EIP7702_HINT.test(name)) return true;
  if (depth > 4 || typeof value !== 'object' || value === null) return false;
  return Object.entries(value as Record<string, unknown>).some(([k, v]) =>
    capabilityMentions7702(k, v, depth + 1),
  );
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
  | { kind: 'transaction'; tx: WcTxParams }
  | { kind: 'calls'; batch: WcSendCalls }
  /**
   * ERC-7715 wallet_requestExecutionPermissions (Kernel smart-account
   * sessions only): the dApp's request, the grant the engine mapped it to
   * (grantFromErc7715Request, validated against the bound account), and
   * whether the dApp lets the wallet narrow it.
   */
  | {
      kind: 'permissions';
      request: Erc7715PermissionRequest;
      grant: SessionKeyGrant;
      isAdjustmentAllowed: boolean;
    };

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
 * walletAddress is the account the session is bound to (WcController only
 * calls this after checking that it is also the ACTIVE account); any
 * request naming a different signer is refused (a session only ever
 * exposed this one account).
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
  /**
   * Set when the session is bound to a smart account (walletAddress is
   * then the smart account): enables wallet_sendCalls, and refuses message
   * signing for implementations without ERC-1271 (SimpleAccount).
   */
  options: { smartAccount?: { accountType: string; signsMessages: boolean } } = {},
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

  if (typeof method === 'string' && EIP7702_HINT.test(method)) {
    throw new WcRequestRejection(WC_ERRORS.unsupportedMethods.code, EIP7702_WC_REFUSAL);
  }

  const smart = options.smartAccount;
  if (
    smart &&
    !smart.signsMessages &&
    (method === 'personal_sign' || method === 'eth_signTypedData_v4')
  ) {
    throw new WcRequestRejection(
      WC_ERRORS.unsupportedMethods.code,
      SIMPLE_ACCOUNT_SIGNING_REFUSAL,
    );
  }

  if (method === 'wallet_sendCalls') {
    if (!smart) {
      throw new WcRequestRejection(
        WC_ERRORS.unsupportedMethods.code,
        'wallet_sendCalls is offered only on connections made with a smart account.',
      );
    }
    return { kind: 'calls', batch: parseSendCalls(params, walletAddress, activeChain) };
  }

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
    if (requestsEip7702Authorization(t)) {
      throw new WcRequestRejection(WC_ERRORS.userRejected.code, EIP7702_WC_REFUSAL);
    }
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

  if (method === 'wallet_requestExecutionPermissions') {
    if (!smart || smart.accountType !== 'kernel-v3.3') {
      throw new WcRequestRejection(WC_ERRORS.unsupportedMethods.code, ERC7715_KERNEL_ONLY_REFUSAL);
    }
    return parseExecutionPermissionsRequest(params, walletAddress, activeChain);
  }

  throw new WcRequestRejection(
    WC_ERRORS.unsupportedMethods.code,
    `Method ${String(method)} is not supported by this wallet over WalletConnect ` +
      `(supported: ${(smart ? smartAccountMethodsFor(smart.accountType) : WC_SUPPORTED_METHODS).join(', ')}).`,
  );
}

/**
 * wallet_getSupportedExecutionPermissions (ERC-7715 at 2adc3783, params []):
 * "The wallet SHOULD include an object keyed on supported permission types
 * including `ruleTypes` (`string[]`) that can be applied to the
 * permission", typed Record<"permission-type", { chainIds: `0x${string}`[];
 * ruleTypes: string[] }>. QUIRK: the ERC's own JSON example spells the field
 * "rulesTypes"; the normative type definition ("ruleTypes") is followed.
 * Only the wallet's own type (the engine's ERC7715_CALLS_PERMISSION_TYPE),
 * only the active chain, and only the "expiry" rule (which is mandatory:
 * open-ended sessions are refused). Answered without UI: it reveals nothing
 * and signs nothing. Kernel smart-account sessions only.
 */
export function decideSupportedExecutionPermissions(
  smart: { accountType: string } | null,
  activeChain: string,
): { result: Record<string, unknown> } | { error: { code: number; message: string } } {
  if (!smart || smart.accountType !== 'kernel-v3.3') {
    return { error: { code: WC_ERRORS.unsupportedMethods.code, message: ERC7715_KERNEL_ONLY_REFUSAL } };
  }
  return {
    result: {
      [ERC7715_CALLS_PERMISSION_TYPE]: {
        chainIds: [hexChainIdOf(activeChain)],
        ruleTypes: ['expiry'],
      },
    },
  };
}

/** Why ERC-7715 methods are refused outside Kernel smart-account connections. */
export const ERC7715_KERNEL_ONLY_REFUSAL =
  'Execution permissions (ERC-7715) are offered only on connections made with a Kernel v3.3 smart ' +
  'account: session permissions are installed into that account’s code.';

/**
 * Parses wallet_requestExecutionPermissions params (ERC-7715: an array of
 * PermissionRequest) for a session bound to the Kernel account
 * `walletAddress`. This wallet grants ONE permission per request (wallet
 * policy: every grant gets its own review and its own install). The engine's
 * grantFromErc7715Request does the mapping and runs validateSessionKeyGrant
 * (wildcard targets, self-calls, open-ended or expired windows are refused,
 * with the engine's message). Error codes: ERC7715_ERRORS.
 */
export function parseExecutionPermissionsRequest(
  params: unknown,
  walletAddress: string,
  activeChain: string,
  now: number = Math.floor(Date.now() / 1000),
): Extract<ParsedWcRequest, { kind: 'permissions' }> {
  const method = 'wallet_requestExecutionPermissions';
  if (!Array.isArray(params) || params.length === 0) {
    throw new WcRequestRejection(ERC7715_ERRORS.invalidParams, `${method}: expected [PermissionRequest].`);
  }
  if (params.length > 1) {
    throw new WcRequestRejection(
      ERC7715_ERRORS.invalidParams,
      `${method}: this wallet grants one permission per request (got ${params.length}); send them one at a time.`,
    );
  }
  const raw = params[0];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new WcRequestRejection(ERC7715_ERRORS.invalidParams, `${method}: the permission request must be an object.`);
  }
  const r = raw as Record<string, unknown>;
  const activeId = BigInt(activeChain.split(':')[1]!);
  if (typeof r.chainId === 'string' && /^0x[0-9a-fA-F]+$/.test(r.chainId) && BigInt(r.chainId) !== activeId) {
    throw new WcRequestRejection(
      ERC7715_ERRORS.chainDisconnected,
      `${method}: chain ${r.chainId} is not this connection's chain (${describeChain(activeChain)}).`,
    );
  }
  if (r.from !== undefined && r.from !== null) {
    if (typeof r.from !== 'string' || r.from.toLowerCase() !== walletAddress.toLowerCase()) {
      throw new WcRequestRejection(
        ERC7715_ERRORS.unauthorized,
        `${method}: from (${String(r.from)}) is not the account this connection is bound to.`,
      );
    }
  }
  try {
    const { grant, isAdjustmentAllowed } = grantFromErc7715Request(r as unknown as Erc7715PermissionRequest, {
      chainId: activeId,
      account: walletAddress,
      now,
    });
    return { kind: 'permissions', request: r as unknown as Erc7715PermissionRequest, grant, isAdjustmentAllowed };
  } catch (e) {
    if (e instanceof Erc7715RequestError) {
      throw new WcRequestRejection(
        e.reason === 'unsupported' ? ERC7715_ERRORS.unsupported : ERC7715_ERRORS.invalidParams,
        e.message,
      );
    }
    throw new WcRequestRejection(ERC7715_ERRORS.invalidParams, e instanceof Error ? e.message : String(e));
  }
}

/** Why a SimpleAccount-bound connection never signs messages. */
export const SIMPLE_ACCOUNT_SIGNING_REFUSAL =
  'This connection uses a SimpleAccount smart account, which has no ERC-1271 support, so ' +
  'it cannot sign messages or logins: a signature from its owner key would not be ' +
  "accepted as the smart account's. Reconnect with a Kernel smart account or the regular " +
  'account to sign.';

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
 * The EVM addresses a session's approved namespaces expose (from their
 * CAIP-10 accounts, "eip155:<chain>:<address>"), deduplicated
 * case-insensitively. This wallet approves every session with exactly one
 * address — the account that was active at approval time — so this is the
 * session's BOUND account. Empty when the session is unknown or malformed.
 */
export function sessionAddressesOf(session: unknown): string[] {
  const s = (session ?? {}) as { namespaces?: Record<string, { accounts?: unknown }> };
  const seen = new Map<string, string>();
  for (const ns of Object.values(s.namespaces ?? {})) {
    if (!Array.isArray(ns?.accounts)) continue;
    for (const account of ns.accounts) {
      if (typeof account !== 'string') continue;
      const parts = account.split(':');
      if (parts.length !== 3 || parts[0] !== 'eip155') continue;
      const address = parts[2]!;
      if (!isAddressShaped(address)) continue;
      if (!seen.has(address.toLowerCase())) seen.set(address.toLowerCase(), address);
    }
  }
  return [...seen.values()];
}

/** True when `address` is one of the session's bound addresses. */
export function sessionBindsAddress(sessionAddresses: readonly string[], address: string): boolean {
  const lower = address.toLowerCase();
  return sessionAddresses.some((a) => a.toLowerCase() === lower);
}

/**
 * The sentence shown (and sent to the dApp) when a request arrives for a
 * session bound to an account other than the active one. `labelFor` turns
 * an address into "Account 1 (0x9858…Eda94)" (or null when the address is
 * not one of this wallet's accounts).
 */
export function accountMismatchMessage(
  sessionAddresses: readonly string[],
  activeAddress: string,
  labelFor: (address: string) => string | null = () => null,
): string {
  const bound = sessionAddresses[0];
  if (!bound) {
    return (
      "This connection's account could not be determined, so the request was declined. " +
      'Disconnect and reconnect from the dApp.'
    );
  }
  const boundLabel = labelFor(bound) ?? bound;
  const activeLabel = activeAddress ? (labelFor(activeAddress) ?? activeAddress) : 'another account';
  return (
    `This connection belongs to ${boundLabel}, but ${activeLabel} is active, so the request ` +
    `was declined. Switch back to ${boundLabel} to use this connection, or disconnect and ` +
    'reconnect from the dApp with the active account.'
  );
}

/**
 * Plain-language note for a session bound to an account other than the
 * active one (sessions survive an account switch; they are paused, not
 * deleted), or null when the session belongs to the active account.
 */
export function sessionAccountNote(
  sessionAddresses: readonly string[],
  activeAddress: string | null,
  labelFor: (address: string) => string | null = () => null,
): string | null {
  if (!activeAddress || sessionAddresses.length === 0) return null;
  if (sessionBindsAddress(sessionAddresses, activeAddress)) return null;
  const boundLabel = labelFor(sessionAddresses[0]!) ?? sessionAddresses[0]!;
  return (
    `This connection belongs to ${boundLabel}. Paused while another account is active: ` +
    `its requests are declined until you switch back to ${boundLabel}.`
  );
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
   * Signature / transaction hash, null (wallet_switchEthereumChain's
   * success value), or an ERC-5792 result object. The SDK accepts null:
   * sign-client respond() validates via utils validators.ts
   * isValidResponse, which only requires that result or error is not
   * undefined.
   */
  result?: unknown;
  error?: { code: number; message: string };
}

export function wcResult(id: number, result: unknown): WcResponse {
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
  /** WC_SMART_ACCOUNT_METHODS when ethAddress is a smart account. */
  methods: readonly string[] = WC_SUPPORTED_METHODS,
): Promise<{ approved: true } | { approved: false; reason: string }> {
  const decision = decideProposal(proposal.params, ethAddress, activeChain, methods);
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
  result: unknown,
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
  /** The account address(es) the session is bound to (sessionAddressesOf). */
  addresses: string[];
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
      addresses: sessionAddressesOf(session),
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
// Smart-account-bound sessions (phase 7 item 3)
// ---------------------------------------------------------------------------

/**
 * A session approved with the smart account's address instead of the EOA.
 * The session's CAIP-10 accounts carry only the smart-account address, so
 * the wallet records which owner, account index and implementation that
 * address belongs to. Records are keyed by chain + smart-account address
 * and written BEFORE the session is approved, so a request arriving right
 * after settlement already finds its binding. They are public data (an
 * address this wallet derived and its owner's address), never key
 * material. A missing record fails closed: the session's address does not
 * equal the active EOA, so its requests are declined as belonging to
 * another account.
 */
export interface WcSmartBinding {
  /** CAIP-2 chain the session was approved on. */
  chain: string;
  /** The smart-account address the session exposes. */
  address: string;
  /** The owner EOA (the active account's address at approval time). */
  owner: string;
  /** Wallet account index = CREATE2 salt of the smart account. */
  accountIndex: number;
  /** 'kernel-v3.3' or 'simple' (aa.ts AaAccountType). */
  accountType: string;
  /** Factory the address was derived from (re-checked before signing). */
  factory: string;
}

const WC_SMART_BINDINGS_KEY = 'shiba-wallet.wc-smart-bindings.v1';

export function smartBindingKey(chain: string, address: string): string {
  return `${chain}:${address.toLowerCase()}`;
}

function reviveBinding(value: unknown): WcSmartBinding | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.chain !== 'string' ||
    typeof v.address !== 'string' ||
    !isAddressShaped(v.address) ||
    typeof v.owner !== 'string' ||
    !isAddressShaped(v.owner) ||
    typeof v.accountIndex !== 'number' ||
    !Number.isSafeInteger(v.accountIndex) ||
    v.accountIndex < 0 ||
    (v.accountType !== 'kernel-v3.3' && v.accountType !== 'simple') ||
    typeof v.factory !== 'string' ||
    !isAddressShaped(v.factory)
  ) {
    return null;
  }
  return {
    chain: v.chain,
    address: v.address,
    owner: v.owner,
    accountIndex: v.accountIndex,
    accountType: v.accountType,
    factory: v.factory,
  };
}

/** Every stored smart-account binding (malformed entries are skipped). */
export async function loadSmartBindings(
  store: KeyValueStore = AsyncStorage,
): Promise<WcSmartBinding[]> {
  try {
    const raw = await store.getItem(WC_SMART_BINDINGS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return [];
    return Object.values(parsed as Record<string, unknown>)
      .map(reviveBinding)
      .filter((b): b is WcSmartBinding => b !== null);
  } catch {
    return [];
  }
}

/** Persists one binding (replacing any record for the same chain + address). */
export async function saveSmartBinding(
  binding: WcSmartBinding,
  store: KeyValueStore = AsyncStorage,
): Promise<void> {
  let map: Record<string, unknown> = {};
  try {
    const raw = await store.getItem(WC_SMART_BINDINGS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      map = parsed as Record<string, unknown>;
    }
  } catch {
    map = {};
  }
  map[smartBindingKey(binding.chain, binding.address)] = binding;
  await store.setItem(WC_SMART_BINDINGS_KEY, JSON.stringify(map));
}

/**
 * The sentence for a request on a smart-account session whose OWNER is not
 * the active account.
 */
export function smartAccountMismatchMessage(
  binding: WcSmartBinding,
  activeAddress: string,
  labelFor: (address: string) => string | null = () => null,
): string {
  const ownerLabel = labelFor(binding.owner) ?? binding.owner;
  const activeLabel = activeAddress ? (labelFor(activeAddress) ?? activeAddress) : 'another account';
  return (
    `This connection belongs to the smart account ${binding.address} of ${ownerLabel}, but ` +
    `${activeLabel} is active, so the request was declined. Switch back to ${ownerLabel} to use ` +
    'this connection.'
  );
}

/** "Smart account 0xB67b…9a42 (Kernel v3.3) of Account 1 (0x9858…Da94)". */
export function smartBindingLabel(
  binding: WcSmartBinding,
  labelFor: (address: string) => string | null = () => null,
): string {
  const short = `${binding.address.slice(0, 6)}…${binding.address.slice(-4)}`;
  const type = binding.accountType === 'kernel-v3.3' ? 'Kernel v3.3' : 'SimpleAccount';
  return `Smart account ${short} (${type}) of ${labelFor(binding.owner) ?? binding.owner}`;
}

// ---------------------------------------------------------------------------
// ERC-5792 Wallet Call API (phase 7 item 2)
// ---------------------------------------------------------------------------

/**
 * Source: EIP-5792 "Wallet Call API", status Final, ethereum/EIPs
 * EIPS/eip-5792.md at commit 5b0c8dce4bc67d34082eff7950d44be928641207
 * (2025-10-07; rendered at https://eips.ethereum.org/EIPS/eip-5792, read
 * 2026-10-01). What is implemented, field by field:
 *
 * wallet_sendCalls, params [SendCallsParams]:
 *  - version: string. The ERC defines no version list; its examples use
 *    "2.0.0", the shape implemented here (atomicRequired / atomic status).
 *    Any other value is refused with -32602 rather than guessed at.
 *  - id?: app-provided batch id; "MUST be a unique string up to 4096 bytes
 *    (8194 characters including leading 0x)"; duplicates "MUST" be
 *    rejected with 5720 (checked per sender per app, the ERC's uniqueness
 *    scope).
 *  - from?: if provided the calls MUST come from it; anything but the
 *    session's bound smart account → 4100 Unauthorized.
 *  - chainId: hex, "0x prefix and no leading zeroes"; the error table lists
 *    "leading zeros in chain id" as -32602, so "0x01" is refused (note: the
 *    ERC's own example writes "0x01" — the normative text is followed).
 *    A chain other than the active one → 5710 Unsupported chain id.
 *  - atomicRequired: boolean, required. This wallet always executes the
 *    batch atomically and contiguously (one UserOperation, one account
 *    execute that reverts as a whole), so both values are served.
 *  - calls[]: {to?, data?, value? (hex), capabilities?}. A call without
 *    `to` (contract creation) is refused with -32602 (wallet policy).
 *  - capabilities (top level and per call): a capability not supported and
 *    not marked optional:true → 5700. This wallet supports none, so every
 *    non-optional capability is refused and optional ones are ignored.
 *  - Result: { id } (no capabilities object).
 *  - The wallet "MUST NOT await for any calls to be finalized": the id is
 *    returned once the bundler accepted the UserOperation.
 *
 * wallet_getCapabilities, params [address, chainIds?]: 4100 for an address
 * that is not this session's; result keyed by hex chain id; only the
 * ACTIVE chain is ever included, with { atomic: { status: "supported" } }
 * for smart-account sessions; unsupported chains are omitted (never an
 * error, per the ERC). EOA sessions get {} — the ERC reads an absent
 * atomic capability as "no batching".
 *
 * wallet_getCallsStatus, params [id]: 5730 for an unknown id; result
 * { version, id, chainId, status, atomic: true, receipts? } with status 100
 * (pending), 200 (included, succeeded) or 500 (included, reverted — atomic,
 * so only the gas charge took effect). receipts carry logs, status,
 * blockHash, blockNumber, gasUsed, transactionHash; logs are the
 * UserOperation's own logs (ERC-7769 eth_getUserOperationReceipt `logs`,
 * "not including logs of other UserOperations in the same bundle", as
 * ERC-5792 requires for bundler-submitted batches); the other fields come
 * from the bundle transaction's receipt (`receipt`), and `status` is the
 * UserOperation's success flag. Any malformed field → receipts omitted,
 * never invented.
 */
export const ERC5792_VERSION = '2.0.0';

/** ERC-5792 error codes (its "Error Codes" table). */
export const ERC5792_ERRORS = {
  invalidParams: -32602,
  userRejected: 4001,
  unauthorized: 4100,
  unsupportedCapability: 5700,
  unsupportedChain: 5710,
  duplicateId: 5720,
  unknownBundle: 5730,
  bundleTooLarge: 5740,
} as const;

/**
 * Wallet policy: the most calls one batch may carry (the ERC leaves the
 * limit to the wallet and defines 5740 "Bundle too large"). Every call is
 * listed on the approval sheet, so the list must stay reviewable.
 */
export const MAX_BATCH_CALLS = 16;
const MAX_CALLS_ID_LENGTH = 8194;
const HEX_CHAIN_ID = /^0x[1-9a-fA-F][0-9a-fA-F]*$/;

export interface WcSendCalls {
  version: string;
  /** App-provided id, or null (the wallet generates one). */
  id: string | null;
  /** Normalized `from`, or null when the app left it out. */
  from: string | null;
  atomicRequired: boolean;
  calls: WcTxParams[];
  /** Optional capabilities the app sent that this wallet ignored. */
  ignoredCapabilities: string[];
}

/** "0x1" / "0xaa36a7": the ERC's hex chain id for a CAIP-2 eip155 id. */
export function hexChainIdOf(caip2: string): string {
  return '0x' + BigInt(caip2.split(':')[1]!).toString(16);
}

function parseHexChainId(raw: unknown, method: string): bigint {
  if (typeof raw !== 'string' || !HEX_CHAIN_ID.test(raw)) {
    throw new WcRequestRejection(
      ERC5792_ERRORS.invalidParams,
      `${method}: chainId must be 0x-prefixed hex without leading zeros (got ${String(raw)}).`,
    );
  }
  return BigInt(raw);
}

/** Collects ignored optional capabilities; throws 5700 for required ones. */
function checkCapabilities(value: unknown, where: string, ignored: string[]): void {
  if (value === undefined) return;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WcRequestRejection(ERC5792_ERRORS.invalidParams, `wallet_sendCalls: ${where} capabilities must be an object.`);
  }
  for (const [name, capability] of Object.entries(value as Record<string, unknown>)) {
    if (capabilityMentions7702(name, capability)) {
      // D6, even when marked optional (see EIP7702_WC_REFUSAL).
      throw new WcRequestRejection(ERC5792_ERRORS.unsupportedCapability, EIP7702_WC_REFUSAL);
    }
    const optional =
      typeof capability === 'object' &&
      capability !== null &&
      (capability as { optional?: unknown }).optional === true;
    if (!optional) {
      throw new WcRequestRejection(
        ERC5792_ERRORS.unsupportedCapability,
        `This wallet does not support the "${name}" capability (${where}), and the dApp did ` +
          'not mark it optional.',
      );
    }
    ignored.push(name);
  }
}

/**
 * Parses and validates wallet_sendCalls params per ERC-5792 (see the
 * section comment), for a session bound to `boundAddress` on `activeChain`.
 * Throws WcRequestRejection with the ERC's error code on any refusal.
 */
export function parseSendCalls(
  params: unknown,
  boundAddress: string,
  activeChain: string,
): WcSendCalls {
  const p = requireArrayParams(params, 'wallet_sendCalls');
  const req = p[0];
  if (typeof req !== 'object' || req === null || Array.isArray(req)) {
    throw new WcRequestRejection(ERC5792_ERRORS.invalidParams, 'wallet_sendCalls: expected a params object.');
  }
  const r = req as Record<string, unknown>;
  if (r.version !== ERC5792_VERSION) {
    throw new WcRequestRejection(
      ERC5792_ERRORS.invalidParams,
      `wallet_sendCalls: version ${JSON.stringify(r.version)} is not supported; this wallet ` +
        `implements ERC-5792 version ${ERC5792_VERSION}.`,
    );
  }
  const chainId = parseHexChainId(r.chainId, 'wallet_sendCalls');
  if (chainId !== BigInt(activeChain.split(':')[1]!)) {
    throw new WcRequestRejection(
      ERC5792_ERRORS.unsupportedChain,
      `wallet_sendCalls asked for chain id ${chainId}; this connection serves only the ` +
        `active chain (${describeChain(activeChain)}).`,
    );
  }
  let from: string | null = null;
  if (r.from !== undefined && r.from !== null) {
    if (typeof r.from !== 'string' || !isAddressShaped(r.from) || r.from.toLowerCase() !== boundAddress.toLowerCase()) {
      throw new WcRequestRejection(
        ERC5792_ERRORS.unauthorized,
        `wallet_sendCalls: from (${String(r.from)}) is not the account this connection is bound to.`,
      );
    }
    from = r.from;
  }
  if (typeof r.atomicRequired !== 'boolean') {
    throw new WcRequestRejection(
      ERC5792_ERRORS.invalidParams,
      'wallet_sendCalls: atomicRequired must be true or false.',
    );
  }
  let id: string | null = null;
  if (r.id !== undefined && r.id !== null) {
    if (typeof r.id !== 'string' || r.id.length === 0 || r.id.length > MAX_CALLS_ID_LENGTH) {
      throw new WcRequestRejection(
        ERC5792_ERRORS.invalidParams,
        `wallet_sendCalls: id must be a non-empty string of at most ${MAX_CALLS_ID_LENGTH} characters.`,
      );
    }
    id = r.id;
  }
  const ignored: string[] = [];
  checkCapabilities(r.capabilities, 'request', ignored);
  if (!Array.isArray(r.calls) || r.calls.length === 0) {
    throw new WcRequestRejection(ERC5792_ERRORS.invalidParams, 'wallet_sendCalls: calls must be a non-empty array.');
  }
  if (r.calls.length > MAX_BATCH_CALLS) {
    throw new WcRequestRejection(
      ERC5792_ERRORS.bundleTooLarge,
      `wallet_sendCalls: ${r.calls.length} calls is more than this wallet reviews in one ` +
        `batch (${MAX_BATCH_CALLS}).`,
    );
  }
  const calls: WcTxParams[] = r.calls.map((raw, i) => {
    const where = `call ${i + 1}`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new WcRequestRejection(ERC5792_ERRORS.invalidParams, `wallet_sendCalls: ${where} is not an object.`);
    }
    const c = raw as Record<string, unknown>;
    if (requestsEip7702Authorization(c)) {
      throw new WcRequestRejection(ERC5792_ERRORS.unsupportedCapability, EIP7702_WC_REFUSAL);
    }
    checkCapabilities(c.capabilities, where, ignored);
    if (typeof c.to !== 'string') {
      throw new WcRequestRejection(
        ERC5792_ERRORS.invalidParams,
        `wallet_sendCalls: ${where} has no "to" (contract creation), which this wallet does not support.`,
      );
    }
    const validated = validateRecipient(EVM_CHAIN_ID, c.to);
    if (!validated.ok) {
      throw new WcRequestRejection(ERC5792_ERRORS.invalidParams, `wallet_sendCalls: ${where}: ${validated.error}`);
    }
    let valueWei = 0n;
    if (c.value !== undefined && c.value !== null) {
      if (typeof c.value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(c.value)) {
        throw new WcRequestRejection(
          ERC5792_ERRORS.invalidParams,
          `wallet_sendCalls: ${where} value must be a 0x-prefixed hex string.`,
        );
      }
      valueWei = BigInt(c.value);
    }
    let data: Uint8Array = new Uint8Array(0);
    if (c.data !== undefined && c.data !== null && c.data !== '0x') {
      if (typeof c.data !== 'string' || !isHexData(c.data)) {
        throw new WcRequestRejection(ERC5792_ERRORS.invalidParams, `wallet_sendCalls: ${where} data is not valid hex.`);
      }
      data = toBytes(c.data);
    }
    return { to: validated.normalized, valueWei, data };
  });
  return { version: r.version, id, from, atomicRequired: r.atomicRequired, calls, ignoredCapabilities: ignored };
}

/**
 * The answer to wallet_getCapabilities for a session bound to
 * `boundAddress` (see the section comment). Never touches a key.
 */
export function decideGetCapabilities(
  params: unknown,
  boundAddress: string,
  activeChain: string,
  smartAccount: boolean,
): { result: Record<string, unknown> } | { error: { code: number; message: string } } {
  if (!Array.isArray(params) || params.length === 0 || typeof params[0] !== 'string' || !isAddressShaped(params[0])) {
    return {
      error: { code: ERC5792_ERRORS.invalidParams, message: 'wallet_getCapabilities: expected [address, chainIds?].' },
    };
  }
  if (params[0].toLowerCase() !== boundAddress.toLowerCase()) {
    return {
      error: {
        code: ERC5792_ERRORS.unauthorized,
        message: 'wallet_getCapabilities: that address is not connected in this session.',
      },
    };
  }
  let queried: bigint[] | null = null;
  if (params[1] !== undefined && params[1] !== null) {
    if (!Array.isArray(params[1])) {
      return {
        error: { code: ERC5792_ERRORS.invalidParams, message: 'wallet_getCapabilities: chain ids must be an array.' },
      };
    }
    try {
      queried = params[1].map((c) => parseHexChainId(c, 'wallet_getCapabilities'));
    } catch (e) {
      return { error: { code: ERC5792_ERRORS.invalidParams, message: (e as Error).message } };
    }
  }
  if (!smartAccount) return { result: {} };
  const active = BigInt(activeChain.split(':')[1]!);
  if (queried !== null && !queried.includes(active)) return { result: {} };
  return { result: { [hexChainIdOf(activeChain)]: { atomic: { status: 'supported' } } } };
}

/** One submitted batch, for wallet_getCallsStatus and duplicate-id checks. */
export interface WcCallsRecord {
  id: string;
  userOpHash: string;
  /** CAIP-2 chain the batch was sent on. */
  chain: string;
  /** The smart account that sent it (the session's bound address). */
  from: string;
  /** The requesting dApp's URL (the ERC scopes ids per sender per app). */
  dappUrl: string;
  /** Date.now() at submission. */
  createdAt: number;
}

const WC_CALLS_KEY = 'shiba-wallet.wc-calls.v1';
/**
 * Records are kept 7 days (the ERC asks for status "within 24 hours" at
 * least) and capped, newest kept.
 */
const CALLS_RECORD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CALLS_RECORDS = 200;

function callsRecordKey(from: string, dappUrl: string, id: string): string {
  return `${from.toLowerCase()}|${dappUrl}|${id}`;
}

async function loadCallsMap(store: KeyValueStore): Promise<Record<string, WcCallsRecord>> {
  try {
    const raw = await store.getItem(WC_CALLS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, WcCallsRecord> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const r = v as Partial<WcCallsRecord> | null;
      if (
        r &&
        typeof r.id === 'string' &&
        typeof r.userOpHash === 'string' &&
        typeof r.chain === 'string' &&
        typeof r.from === 'string' &&
        typeof r.dappUrl === 'string' &&
        typeof r.createdAt === 'number'
      ) {
        out[k] = r as WcCallsRecord;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** The record for an id sent by `from` for the app at `dappUrl`, or null. */
export async function findCallsRecord(
  id: string,
  from: string,
  dappUrl: string,
  store: KeyValueStore = AsyncStorage,
  now: number = Date.now(),
): Promise<WcCallsRecord | null> {
  const record = (await loadCallsMap(store))[callsRecordKey(from, dappUrl, id)];
  return record && now - record.createdAt <= CALLS_RECORD_TTL_MS ? record : null;
}

/** Stores a submitted batch (pruning expired and excess records). */
export async function saveCallsRecord(
  record: WcCallsRecord,
  store: KeyValueStore = AsyncStorage,
  now: number = Date.now(),
): Promise<void> {
  const map = await loadCallsMap(store);
  map[callsRecordKey(record.from, record.dappUrl, record.id)] = record;
  const kept = Object.entries(map)
    .filter(([, r]) => now - r.createdAt <= CALLS_RECORD_TTL_MS)
    .sort(([, a], [, b]) => b.createdAt - a.createdAt)
    .slice(0, MAX_CALLS_RECORDS);
  await store.setItem(WC_CALLS_KEY, JSON.stringify(Object.fromEntries(kept)));
}

/**
 * A wallet-generated batch id: 32 random bytes (the ERC requires ids to be
 * unpredictable) followed by the userOpHash, 64 bytes as 0x-hex — the shape
 * of the ERC's own example id.
 */
export function generateCallsId(random32: Uint8Array, userOpHash: string): string {
  if (random32.length !== 32) throw new Error('generateCallsId needs 32 random bytes');
  if (!/^0x[0-9a-fA-F]{64}$/.test(userOpHash)) throw new Error('userOpHash must be 32 bytes of hex');
  return toHex(random32) + userOpHash.slice(2).toLowerCase();
}

const HEX_QUANTITY = /^0x[0-9a-fA-F]+$/;
const HASH32 = /^0x[0-9a-fA-F]{64}$/;

/**
 * Maps a bundler eth_getUserOperationReceipt result (ERC-7769 shape; null =
 * not yet included) into the ERC-5792 GetCallsResult. Throws when a
 * receipt is present but carries no recognizable success flag — the status
 * would otherwise be a guess.
 */
export function callsStatusFromReceipt(record: WcCallsRecord, receipt: unknown): Record<string, unknown> {
  const base = {
    version: ERC5792_VERSION,
    id: record.id,
    chainId: hexChainIdOf(record.chain),
    atomic: true,
  };
  if (receipt === null || receipt === undefined) return { ...base, status: 100 };
  if (typeof receipt !== 'object') throw new Error('The bundler returned an unrecognized receipt.');
  const r = receipt as Record<string, unknown>;
  let success: boolean;
  if (r.success === true || r.success === '0x1') success = true;
  else if (r.success === false || r.success === '0x0') success = false;
  else throw new Error('The bundler receipt has no recognizable success flag.');

  const out: Record<string, unknown> = { ...base, status: success ? 200 : 500 };
  const inner = r.receipt as Record<string, unknown> | undefined;
  const logsRaw = r.logs;
  if (
    inner &&
    typeof inner === 'object' &&
    typeof inner.blockHash === 'string' &&
    HASH32.test(inner.blockHash) &&
    typeof inner.blockNumber === 'string' &&
    HEX_QUANTITY.test(inner.blockNumber) &&
    typeof inner.gasUsed === 'string' &&
    HEX_QUANTITY.test(inner.gasUsed) &&
    typeof inner.transactionHash === 'string' &&
    HASH32.test(inner.transactionHash) &&
    Array.isArray(logsRaw)
  ) {
    const logs: { address: string; data: string; topics: string[] }[] = [];
    let logsOk = true;
    for (const log of logsRaw) {
      const l = log as Record<string, unknown> | null;
      if (
        !l ||
        typeof l.address !== 'string' ||
        !isAddressShaped(l.address) ||
        typeof l.data !== 'string' ||
        !/^0x([0-9a-fA-F]{2})*$/.test(l.data) ||
        !Array.isArray(l.topics) ||
        !l.topics.every((t) => typeof t === 'string' && HASH32.test(t))
      ) {
        logsOk = false;
        break;
      }
      logs.push({ address: l.address, data: l.data, topics: l.topics as string[] });
    }
    if (logsOk) {
      out.receipts = [
        {
          logs,
          status: success ? '0x1' : '0x0',
          blockHash: inner.blockHash,
          blockNumber: inner.blockNumber,
          gasUsed: inner.gasUsed,
          transactionHash: inner.transactionHash,
        },
      ];
    }
  }
  return out;
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
