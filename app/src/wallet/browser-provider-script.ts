/**
 * The provider the in-app browser injects into an allowlisted page
 * (feature 79; docs/DAPP_BROWSER.md sections 2.3, 2.4 and 3.1).
 *
 * WHAT IT IS. A small EIP-1193 provider (request, on, removeListener and the
 * connect / disconnect / chainChanged / accountsChanged events; EIP-1193,
 * Final, ethereum/EIPs EIPS/eip-1193.md at af3a7802) that is also announced
 * through EIP-6963 (eip6963:announceProvider with a frozen { info, provider }
 * detail, answering eip6963:requestProvider; EIPS/eip-6963.md at af3a7802).
 * Every request is posted to the wallet through the web view's message
 * bridge (window.ReactNativeWebView.postMessage, which react-native-webview
 * 13.16.1 installs on both platforms) and answered by the wallet calling
 * window.__shibaWalletProvider.receive(...) through injectJavaScript.
 *
 * WHAT IT IS NOT. A security boundary. EIP-1193: "all its properties can be
 * read or overwritten. Therefore, it is best to treat the Provider object as
 * though it is controlled by an adversary". The page and this script share
 * one JavaScript world, so the script holds NOTHING secret: the nonce and
 * request ids only help an honest page match answers to its own requests
 * (and let the wallet ignore messages left over from another load); they
 * authenticate nothing. Every decision is made on the wallet side, from the
 * origin the web engine reports for each message (browser-bridge.ts), and
 * every consequential action goes through the wallet's own approval sheet
 * and the device check.
 *
 * INJECTED MORE THAN ONCE ON PURPOSE (finding B4). On Android the library
 * injects "before content" with evaluateJavascript from onPageStarted,
 * which its own reference calls "not 100% reliable", so the screen injects
 * the same script again when the page finishes loading. A second run in
 * the same document finds the installed provider and only announces it
 * again (EIP-6963) and sets window.ethereum if nothing else has; it never
 * creates a second provider.
 *
 * window.ethereum is set only when no other provider is there, and the
 * provider never claims to be another wallet (no isMetaMask flag).
 */

/** The bridge channel name every message carries. */
export const BROWSER_BRIDGE_CHANNEL = 'shiba-wallet-provider';

/** Name shown by dApps' wallet pickers (EIP-6963 info.name). */
export const EIP6963_NAME = 'Shiba Wallet';

/**
 * EIP-6963 says the rdns "MUST be a valid RFC-1034 Domain Name" and that its
 * DNS part "SHOULD BE an active domain controlled by the Provider". The
 * project has no domain yet (the same open input as the passkey relying
 * party), so this is the reverse of the placeholder the WalletConnect
 * metadata already uses (shiba-wallet.example, under RFC 2606's reserved
 * .example). It must be replaced before any release.
 */
export const EIP6963_RDNS = 'example.shiba-wallet';

/**
 * EIP-6963: "The `icon` string MUST be a data URI as defined in RFC-2397".
 * A plain square SVG (no script; dApps are told to render it with <img>).
 */
export const EIP6963_ICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 96 96'>" +
      "<rect width='96' height='96' rx='20' fill='#E8862A'/>" +
      "<text x='48' y='64' font-size='52' font-family='sans-serif' font-weight='700' text-anchor='middle' fill='#FFFFFF'>S</text>" +
      '</svg>',
  );

export interface ProviderScriptOptions {
  /** 32 lower-case hex characters, new for each web view (see the file comment). */
  nonce: string;
  /** EIP-6963 info.uuid: a UUIDv4, new for each web view. */
  uuid: string;
  /** The active chain as eth_chainId reports it ("0xaa36a7"). */
  chainIdHex: string;
}

/** A UUIDv4 string from 16 random bytes (RFC 4122 section 4.4: version 4, variant 10). */
export function uuidV4FromBytes(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new Error('uuidV4FromBytes needs 16 bytes.');
  const b = Uint8Array.from(bytes);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The script for injectedJavaScriptBeforeContentLoaded and for the
 * re-injection on load end. Throws on malformed options rather than
 * splicing them into JavaScript source.
 */
export function buildProviderScript(options: ProviderScriptOptions): string {
  if (!/^[0-9a-f]{32}$/.test(options.nonce)) throw new Error('Provider script: malformed nonce.');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(options.uuid)) {
    throw new Error('Provider script: malformed uuid.');
  }
  if (!/^0x[0-9a-f]{1,16}$/.test(options.chainIdHex)) throw new Error('Provider script: malformed chain id.');
  const config = JSON.stringify({
    channel: BROWSER_BRIDGE_CHANNEL,
    nonce: options.nonce,
    chainId: options.chainIdHex,
    info: { uuid: options.uuid, name: EIP6963_NAME, icon: EIP6963_ICON, rdns: EIP6963_RDNS },
  });
  return `(function () {
  var CONFIG = ${config};
  var existing = window.__shibaWalletProvider;
  if (existing && typeof existing.reannounce === 'function') {
    existing.reannounce();
    return;
  }
  var listeners = {};
  var pending = {};
  var nextId = 1;
  var state = { chainId: CONFIG.chainId, accounts: [] };
  function rpcError(code, message, data) {
    var error = new Error(String(message));
    error.code = code;
    if (data !== undefined) error.data = data;
    return error;
  }
  function emit(name, value) {
    var list = (listeners[name] || []).slice();
    for (var i = 0; i < list.length; i++) {
      try { list[i](value); } catch (e) { /* a listener's error is the page's own */ }
    }
  }
  function post(message) {
    var bridge = window.ReactNativeWebView;
    if (!bridge || typeof bridge.postMessage !== 'function') throw new Error('no bridge');
    message.channel = CONFIG.channel;
    message.nonce = CONFIG.nonce;
    bridge.postMessage(JSON.stringify(message));
  }
  var provider = {
    isShibaWallet: true,
    request: function (args) {
      if (!args || typeof args !== 'object' || typeof args.method !== 'string') {
        return Promise.reject(rpcError(-32600, 'Expected { method, params }.'));
      }
      var params = args.params;
      return new Promise(function (resolve, reject) {
        var id = nextId++;
        pending[id] = { resolve: resolve, reject: reject };
        try {
          post({ type: 'request', id: id, method: args.method, params: params });
        } catch (e) {
          delete pending[id];
          reject(rpcError(4900, 'The wallet is not reachable from this page.'));
        }
      });
    },
    enable: function () { return provider.request({ method: 'eth_requestAccounts' }); },
    isConnected: function () { return true; },
    on: function (name, listener) {
      if (typeof listener === 'function') (listeners[name] = listeners[name] || []).push(listener);
      return provider;
    },
    removeListener: function (name, listener) {
      var list = listeners[name] || [];
      var index = list.indexOf(listener);
      if (index >= 0) list.splice(index, 1);
      return provider;
    }
  };
  provider.off = provider.removeListener;
  provider.addListener = provider.on;
  var detail = Object.freeze({ info: Object.freeze(CONFIG.info), provider: provider });
  function announce() {
    try {
      window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: detail }));
    } catch (e) { /* very old engines: no CustomEvent */ }
  }
  function reannounce() {
    try {
      if (window.ethereum === undefined) window.ethereum = provider;
    } catch (e) { /* the page made window.ethereum read-only */ }
    announce();
  }
  function receive(payload) {
    if (!payload || payload.nonce !== CONFIG.nonce) return;
    if (payload.type === 'response') {
      var entry = pending[payload.id];
      if (!entry) return;
      delete pending[payload.id];
      if (payload.error) entry.reject(rpcError(payload.error.code, payload.error.message, payload.error.data));
      else entry.resolve(payload.result);
      return;
    }
    if (payload.type === 'event') {
      if (payload.name === 'chainChanged') state.chainId = payload.value;
      if (payload.name === 'accountsChanged') state.accounts = payload.value;
      emit(payload.name, payload.value);
    }
  }
  try {
    Object.defineProperty(window, '__shibaWalletProvider', {
      value: Object.freeze({ receive: receive, reannounce: reannounce }),
      writable: false,
      configurable: false,
      enumerable: false
    });
  } catch (e) { /* the page took the name first; it then only misleads itself */ }
  window.addEventListener('eip6963:requestProvider', announce);
  reannounce();
  try {
    var bridge = window.ReactNativeWebView;
    post({ type: 'hello', chainId: state.chainId, hasListener: !!(bridge && typeof bridge.addEventListener === 'function') });
  } catch (e) { /* no bridge yet: the re-injection on load end says hello */ }
  emit('connect', { chainId: state.chainId });
})();
true;`;
}

/** What the wallet hands the page (always through deliverToPageScript). */
export type ShimPayload =
  | { nonce: string; type: 'response'; id: number; result: unknown }
  | { nonce: string; type: 'response'; id: number; error: { code: number; message: string; data?: unknown } }
  | { nonce: string; type: 'event'; name: 'chainChanged' | 'accountsChanged' | 'connect' | 'disconnect'; value: unknown };

/**
 * The JavaScript the wallet runs (injectJavaScript) to hand one payload to
 * the shim. The payload is JSON, so it is inert data; "</script>" style
 * sequences cannot matter because nothing is parsed as HTML. U+2028 and
 * U+2029 are escaped because older JavaScript engines treat them as line
 * terminators inside string literals.
 */
export function deliverToPageScript(payload: ShimPayload): string {
  const json = JSON.stringify(payload).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `(function () { var p = window.__shibaWalletProvider; if (p && typeof p.receive === 'function') p.receive(${json}); })();\ntrue;`;
}
