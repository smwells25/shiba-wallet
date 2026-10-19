/**
 * Deep links into the wallet's own screens (phase 22 item 5, feature 80).
 *
 * WHICH LINKS ARRIVE. The app has no custom URL scheme of its own today:
 * app/app.json sets no `scheme`, and Expo's Android config plugin adds an
 * intent filter only for the schemes listed there (@expo/config-plugins
 * build/android/Scheme.js setScheme, lines 40-45: with none, nothing is
 * added). The development build's manifest therefore carries only the
 * development client's own `exp+shiba-wallet` scheme
 * (expo-dev-client plugin/build/getDefaultScheme.js:25, `exp+${scheme}`),
 * which this module leaves alone. So:
 *  - `shibawallet://…` is the scheme this module reads; links in that form
 *    reach the app only once app.json carries `"scheme": "shibawallet"` and
 *    the app is rebuilt (a native configuration change, outside this module);
 *  - in Expo Go, a link to the running project has the form
 *    `exp://<host>/--/<path>` (Expo Go's own scheme, path after "/--/"; the
 *    SDK 57 Linking documentation, docs.expo.dev/versions/v57.0.0/sdk/linking,
 *    fetched 2026-10-19: "exp://128.0.0.1:8081/--/path"), and is read the
 *    same way; a plain project URL (`exp://<host>`, no "/--/") opens no
 *    screen and is ignored silently (whether Expo Go's getInitialURL returns
 *    it at an ordinary launch is not verified on a device).
 *
 * THE LINKS (an allow list; anything else is ignored with
 * DEEP_LINK_UNKNOWN_SENTENCE):
 *   shibawallet://                  Home      (also …://home)
 *   shibawallet://activity          Activity  (?chain=ethereum|bitcoin|dogecoin|solana; default ethereum)
 *   shibawallet://inbox             Inbox
 *   shibawallet://price-alerts      PriceAlerts
 *   shibawallet://sessions          Sessions
 *   shibawallet://receive           Receive   (?chain=… as for activity)
 *   shibawallet://send?uri=<payment request, percent-encoded>
 *       Send, pre-filled ONLY through the existing payment-request parser
 *       (./payment-request.ts parsePaymentRequest + describeParsedRequest),
 *       exactly as a scanned request pre-fills it: the same validation and
 *       refusals, never a network switch, never an untracked token. The
 *       link itself can carry nothing else: one `uri` parameter, no other.
 * A link names a screen and, for Send, a payment request that only fills
 * EDITABLE fields; there is no parameter for calldata, an EIP-7702
 * authorization, a signature request or anything the wallet would sign
 * (D6), and the payment-request parser refuses any contract function other
 * than an ERC-20 transfer and any key it does not define.
 *
 * RULES the app's handler (App.tsx DeepLinkHandler) keeps, decided here:
 *  - a link never signs, never prompts and makes no network request by
 *    itself: parsing reads only the tracked-token list (AsyncStorage) for a
 *    payment request; the screen it opens behaves as when opened from Home;
 *  - every gate applies: a link that arrives while the wallet is loading,
 *    locked or behind the PIN pad waits (deepLinkGate) and is acted on only
 *    after the unlock; the watch-only and multisig route gates and the
 *    readiness checks of the opened screen run as for any navigation;
 *  - the launch link is taken ONCE per process (createDeepLinkSource), so
 *    the navigator's remount on an account switch never replays it;
 *  - nothing here reads the secure store, the key vault or a signer.
 *
 * Node-loadable (scripts/check-inbox.mjs): React Native's Linking is reached
 * only through a lazy require in appDeepLinks().
 */
// Explicit .ts extensions: loaded by the check scripts under Node's type stripping.
import type { FungibleAsset } from '@shiba-wallet/core';
import type { EvmChainProfile } from '../config/evm-chain.ts';
import { SCHEME_BY_CHAIN } from './scan.ts';
import {
  describeParsedRequest,
  familyForSlot,
  parsePaymentRequest,
  type PaymentFamily,
  type SendRequestPrefill,
} from './payment-request.ts';

/** The URL scheme this module reads (to be declared as app.json `scheme`). */
export const APP_LINK_SCHEME = 'shibawallet';
/** Longest link read; a payment request alone may be 2,048 characters (payment-request.ts). */
export const MAX_DEEP_LINK_LENGTH = 8192;

export const DEEP_LINK_UNKNOWN_SENTENCE = 'This link does not open anything in Shiba Wallet.';
export const DEEP_LINK_NO_WALLET_SENTENCE = 'There is no wallet on this phone yet, so this link was not opened.';
/** The first line of the Send form's "Payment request" box when the request came from a link. */
export const DEEP_LINK_PAY_LINE =
  'This payment request was opened from a link outside the wallet. Anyone can make such a link; nothing is sent until you review and approve it.';

const FAMILY_NAME: Record<PaymentFamily, string> = {
  evm: 'Ethereum',
  bitcoin: 'Bitcoin',
  dogecoin: 'Dogecoin',
  solana: 'Solana',
};

/** "This payment link was not opened. <the parser's refusal>" */
export function deepLinkPayRefusal(message: string): string {
  return `This payment link was not opened. ${message}`;
}

/** The active account has no address on the requested network family (an imported key, a watched address, a multisig). */
export function deepLinkNoAccountSentence(family: PaymentFamily): string {
  return `This payment link is for ${FAMILY_NAME[family]}, which the active account cannot send from. Nothing was filled in.`;
}

/** The screens a link may open directly (an allow list). */
export type DeepLinkRoute = 'Home' | 'Activity' | 'Inbox' | 'PriceAlerts' | 'Sessions' | 'Receive';

export type ParsedDeepLink =
  /** Not a link for this wallet to act on (none, the development client's own scheme, Expo Go's plain project URL). */
  | { kind: 'ignore' }
  /** Addressed to the wallet but opens nothing: answered with DEEP_LINK_UNKNOWN_SENTENCE. */
  | { kind: 'unknown' }
  | { kind: 'open'; route: DeepLinkRoute; chainId?: string }
  | { kind: 'pay'; uri: string; slotChainId: string; family: PaymentFamily };

/** Route names in a link → screens; a link path must match one exactly. */
const PATHS: Record<string, DeepLinkRoute | 'Send'> = {
  '': 'Home',
  home: 'Home',
  activity: 'Activity',
  inbox: 'Inbox',
  'price-alerts': 'PriceAlerts',
  sessions: 'Sessions',
  receive: 'Receive',
  send: 'Send',
};

/** The Send / Receive / Activity slot (route chainId) for each payment scheme, from scan.ts. */
function slotForScheme(scheme: string): string | null {
  for (const [chainId, s] of Object.entries(SCHEME_BY_CHAIN)) if (s === scheme) return chainId;
  return null;
}

/**
 * Reads a link. Pure: no store, no network, no key. Every field it does not
 * know makes the whole link unknown (refused rather than half-read).
 */
export function parseDeepLink(url: unknown): ParsedDeepLink {
  if (typeof url !== 'string' || url === '') return { kind: 'ignore' };
  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(url);
  if (!schemeMatch) return { kind: 'unknown' };
  const scheme = schemeMatch[1]!.toLowerCase();
  // The development client's own scheme (its launcher URLs): left alone.
  if (scheme.startsWith('exp+')) return { kind: 'ignore' };
  if (url.length > MAX_DEEP_LINK_LENGTH) return { kind: 'unknown' };
  // No whitespace, control characters or fragment anywhere.
  if (/[\s\u0000-\u001F\u007F#]/.test(url)) return { kind: 'unknown' };
  let rest = url.slice(schemeMatch[0].length);
  if (scheme === 'exp' || scheme === 'exps') {
    // Expo Go: exp://<host>[/--/<path>]. Without "/--/" it is the project's
    // own URL (an ordinary launch), not a link to a screen.
    if (!rest.startsWith('//')) return { kind: 'unknown' };
    const marker = rest.indexOf('/--/');
    if (marker === -1) return { kind: 'ignore' };
    rest = rest.slice(marker + 4);
  } else if (scheme === APP_LINK_SCHEME) {
    rest = rest.replace(/^\/+/, '');
  } else {
    return { kind: 'unknown' };
  }
  const q = rest.indexOf('?');
  const path = (q === -1 ? rest : rest.slice(0, q)).replace(/\/+$/, '');
  const query = q === -1 ? null : rest.slice(q + 1);
  if (!Object.prototype.hasOwnProperty.call(PATHS, path)) return { kind: 'unknown' };
  const route = PATHS[path]!;

  const params = new Map<string, string>();
  if (query !== null && query !== '') {
    for (const part of query.split('&')) {
      const eq = part.indexOf('=');
      if (eq <= 0) return { kind: 'unknown' };
      const key = part.slice(0, eq);
      if (params.has(key)) return { kind: 'unknown' };
      let value: string;
      try {
        value = decodeURIComponent(part.slice(eq + 1));
      } catch {
        return { kind: 'unknown' };
      }
      params.set(key, value);
    }
  }

  if (route === 'Send') {
    const uri = params.get('uri');
    if (params.size !== 1 || uri === undefined) return { kind: 'unknown' };
    const m = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(uri.trim());
    const slot = m ? slotForScheme(m[1]!.toLowerCase()) : null;
    const family = slot ? familyForSlot(slot) : null;
    if (!slot || !family) return { kind: 'unknown' };
    return { kind: 'pay', uri, slotChainId: slot, family };
  }
  if (route === 'Activity' || route === 'Receive') {
    for (const key of params.keys()) if (key !== 'chain') return { kind: 'unknown' };
    const chain = params.get('chain') ?? 'ethereum';
    const slot = slotForScheme(chain);
    if (!slot) return { kind: 'unknown' };
    return { kind: 'open', route, chainId: slot };
  }
  if (params.size > 0) return { kind: 'unknown' };
  return { kind: 'open', route };
}

/** What the handler does with a link. */
export type DeepLinkAction =
  | { kind: 'none' }
  | { kind: 'notice'; text: string }
  /** Back to Home (popTo, never a second Home on the stack). */
  | { kind: 'home' }
  | { kind: 'navigate'; route: Exclude<DeepLinkRoute, 'Home'>; params?: { chainId: string } }
  /** A NEW Send screen (push), pre-filled with editable values. */
  | { kind: 'send'; params: { chainId: string; tokenId?: string; request: SendRequestPrefill } };

export interface PayLinkContext {
  /** The ACTIVE EVM profile (the network is never switched). */
  evmProfile: Pick<EvmChainProfile, 'caip2' | 'chainIdDecimal' | 'label' | 'displaySymbol'>;
  /** The tracked tokens of a network (tokens.ts listTokens: storage only). */
  trackedTokens: (caip2: string) => Promise<readonly FungibleAsset[]>;
  /** The native coin and network name of the active account's address on a non-EVM slot, or null when it has none. */
  nativeFor: (slotChainId: string) => { symbol: string; networkLabel: string } | null;
  /** Whether the active account has an EVM address (not, e.g., while none is derived yet). */
  hasEvmAccount: boolean;
}

/**
 * The action for a parsed link. A payment link goes through
 * parsePaymentRequest with the same context the Send screen gives it (its
 * slot, the active EVM profile, the active network's tracked tokens) and
 * becomes the same `request` prefill the Send screen builds when a scanned
 * request switches its mode (SendScreen handlePaymentPayload), with
 * DEEP_LINK_PAY_LINE first.
 */
export async function planDeepLink(link: ParsedDeepLink, ctx: PayLinkContext): Promise<DeepLinkAction> {
  switch (link.kind) {
    case 'ignore':
      return { kind: 'none' };
    case 'unknown':
      return { kind: 'notice', text: DEEP_LINK_UNKNOWN_SENTENCE };
    case 'open':
      if (link.route === 'Home') return { kind: 'home' };
      return link.chainId !== undefined
        ? { kind: 'navigate', route: link.route, params: { chainId: link.chainId } }
        : { kind: 'navigate', route: link.route };
    case 'pay': {
      const isEvm = link.family === 'evm';
      const native = isEvm
        ? ctx.hasEvmAccount
          ? { symbol: ctx.evmProfile.displaySymbol, networkLabel: ctx.evmProfile.label }
          : null
        : ctx.nativeFor(link.slotChainId);
      if (!native) return { kind: 'notice', text: deepLinkNoAccountSentence(link.family) };
      const tracked = isEvm ? await ctx.trackedTokens(ctx.evmProfile.caip2).catch(() => []) : [];
      const parsed = parsePaymentRequest(link.uri, {
        slotChainId: link.slotChainId,
        evmProfile: ctx.evmProfile,
        trackedTokens: [...tracked],
      });
      if (parsed.kind === 'not-a-request') return { kind: 'notice', text: DEEP_LINK_UNKNOWN_SENTENCE };
      if (parsed.kind === 'refused') return { kind: 'notice', text: deepLinkPayRefusal(parsed.message) };
      const lines = [DEEP_LINK_PAY_LINE, ...describeParsedRequest(parsed, { nativeSymbol: native.symbol, networkLabel: native.networkLabel })];
      return {
        kind: 'send',
        params: {
          chainId: link.slotChainId,
          ...(parsed.token ? { tokenId: parsed.token.assetId } : {}),
          request: { recipient: parsed.recipient, amountText: parsed.amountText, lines },
        },
      };
    }
  }
}

/**
 * When the handler may act on a waiting link: never while the wallet is
 * loading (the PIN pad holds the wallet there) or locked, nor before the
 * navigator is ready; with no wallet the link is answered with a notice.
 */
export function deepLinkGate(args: { status: 'loading' | 'no-wallet' | 'ready'; locked: boolean; navReady: boolean }): 'wait' | 'act' | 'no-wallet' {
  if (args.status === 'loading' || args.locked || !args.navReady) return 'wait';
  if (args.status === 'no-wallet') return 'no-wallet';
  return 'act';
}

// ---------------------------------------------------------------------------
// The source of links (the launch link once, then every link while running)
// ---------------------------------------------------------------------------

export interface DeepLinkSource {
  /** Starts listening (idempotent). Called once, as early as the app renders. */
  start(): void;
  /** The waiting link, removed from the source (one link is acted on once). */
  take(): string | null;
  /** The waiting link, left in place. */
  peek(): string | null;
  subscribe(listener: () => void): () => void;
}

/**
 * The single place links enter. The launch link (getInitialURL) is read
 * once per process — the navigator is remounted on every account switch
 * and must never see it again — and a link arriving later replaces a link
 * still waiting (the newest wins). Links are held, not acted on: the
 * handler takes one only when deepLinkGate says 'act'.
 */
export function createDeepLinkSource(deps: {
  getInitialURL: () => Promise<string | null>;
  addListener: (listener: (url: string) => void) => { remove(): void };
}): DeepLinkSource {
  let started = false;
  let waiting: string | null = null;
  let laterArrived = false;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const l of [...listeners]) {
      try {
        l();
      } catch {
        // A listener never affects the source.
      }
    }
  };
  return {
    start() {
      if (started) return;
      started = true;
      try {
        deps.addListener((url) => {
          laterArrived = true;
          waiting = url;
          notify();
        });
      } catch {
        // No link events in this environment.
      }
      deps.getInitialURL().then(
        (url) => {
          // A link that arrived meanwhile is newer than the launch link.
          if (url && !laterArrived) {
            waiting = url;
            notify();
          }
        },
        () => undefined,
      );
    },
    take() {
      const url = waiting;
      waiting = null;
      return url;
    },
    peek: () => waiting,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

let appSource: DeepLinkSource | null = null;

/** The app's link source, on React Native's Linking (react-native 0.86.3 Libraries/Linking/Linking.js: getInitialURL, addEventListener('url')). */
export function appDeepLinks(): DeepLinkSource {
  if (!appSource) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy, so this module loads under Node
    const { Linking } = require('react-native') as typeof import('react-native');
    appSource = createDeepLinkSource({
      getInitialURL: () => Linking.getInitialURL(),
      addListener: (listener) => Linking.addEventListener('url', ({ url }) => listener(url)),
    });
  }
  return appSource;
}
