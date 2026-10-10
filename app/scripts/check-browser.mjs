// The in-app browser (feature 79; the allowlisted-sites slice of
// docs/DAPP_BROWSER.md section 5), entirely OFFLINE: nothing is loaded, no
// web view runs, no network request leaves the process and nothing is
// broadcast. Covers section 5.3 in full:
//
//  - origin parsing: user-info, ports, case, trailing dots, punycode and
//    non-ASCII hosts, backslashes and control characters, and the B1
//    prefix cases, which react-native-webview's own matcher (rebuilt here
//    from its source with the same escape-string-regexp 4.0.0) accepts and
//    the wallet refuses; every accepted input agrees with WHATWG URL.origin;
//  - the frame rule: a message is acted on only when its reported origin
//    equals the allowlisted top-level origin; anything else is dropped
//    unanswered;
//  - eth_accounts is [] and signing gives 4100 before a connection;
//  - the method table and every WalletConnect error code's translation;
//  - the bridge client driven through the REAL WcController with a fake
//    page that runs the REAL injected provider script in a separate
//    JavaScript context: proposal approval, SIWE with a matching and a
//    mismatching domain (the risk-switch gate), a transaction with an
//    authorization list (ADR D6), an account switch (4100), a mode change
//    (declined, chainChanged emitted), the lock hold, disconnect, page
//    withdrawal and reload;
//  - the read proxy's refusals, eth_getLogs bounds and rate limit;
//  - navigation: non-https schemes refused without Linking, off-list
//    destinations only offered after a confirmation, the first URL checked
//    before load, the library's Linking branch unreachable;
//  - source checks: no browser file imports key storage or names signWith;
//    mutation checks for the origin comparison and the frame rule;
//  - the four findings of the live pass (2026-10-10): a disconnect from the
//    browser bar's Connection panel and a network change while the page
//    stays mounted both reach the OPEN page (accountsChanged [] /
//    chainChanged), with a mutant whose disconnect does not; the lock hold
//    at the bridge (nothing that needs an approval is answered while
//    locked; reads still are); the page hidden with display: 'none' under
//    the lock without unmounting; the "Connected apps" notice drawn below
//    the bar on the Apps page; the "Connected apps" title and the Settings
//    blurb naming the real buttons.
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-browser.mjs

import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { ethers } from 'ethers';
import { Siwe } from 'ox';
import { evmKeyProvider, mnemonicToSeed } from '@shiba-wallet/core';
import {
  BROWSER_CONNECTIONS_KEY,
  BROWSER_SITES,
  NAV_REFUSAL_SCHEME,
  NAV_REFUSAL_USERINFO,
  decideNavigation,
  externalLinkMessage,
  isAllowlistedOrigin,
  loadBrowserConnections,
  parseWebOrigin,
  sameOrigin,
  siteForUrl,
} from '../src/wallet/browser-sites.ts';
import {
  BROWSER_PROPOSAL_METHODS,
  BROWSER_READ_METHODS,
  BrowserBridgeClient,
  CompositeWcClient,
  EIP1193_ERRORS,
  LIMIT_EXCEEDED,
  MAX_WAITING_PER_ORIGIN,
  NOT_CONNECTED_MESSAGE,
  NO_ACCOUNT_MESSAGE,
  OriginRateLimiter,
  READ_RATE_LIMITS,
  READ_UNAVAILABLE_MESSAGE,
  WC_TO_EIP1193,
  acceptsFrameMessage,
  browserBarConnection,
  browserTopicFor,
  checkGetLogsFilter,
  checkReadParams,
  classifyBrowserMethod,
  createEndpointReadRpc,
  isBrowserTopic,
  parseBridgeMessage,
  stripBrowserFields,
  translateWcError,
} from '../src/wallet/browser-bridge.ts';
import {
  BROWSER_BRIDGE_CHANNEL,
  EIP6963_RDNS,
  buildProviderScript,
  deliverToPageScript,
  uuidV4FromBytes,
} from '../src/wallet/browser-provider-script.ts';
import {
  EIP7702_WC_REFUSAL,
  WC_ERRORS,
  WC_SMART_ACCOUNT_METHODS,
  WC_SUPPORTED_METHODS,
  approveProposal,
  decideProposal,
  describeBrowserIdentity,
  disconnectWcSession,
  identityApprovalAllowed,
  respondApproved,
  signDigest,
  siweOriginFor,
  smartAccountMethodsFor,
} from '../src/wallet/walletconnect.ts';
import { WcController } from '../src/wallet/wc-controller.ts';
import { FEATURE_READINESS, featureReadiness, readinessGate, readinessRefusal } from '../src/config/readiness.ts';
import { WATCH_ONLY_ALLOWED_ROUTES, watchOnlyRouteRefusal } from '../src/wallet/watch-only.ts';
import { memoryStore } from './fakes-kernel.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');
const require = createRequire(import.meta.url);

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail !== undefined ? ` — ${detail}` : ''}`);
  }
}
/** Lets queued promise chains and timers run. */
async function settle(rounds = 5) {
  for (let i = 0; i < rounds; i += 1) await new Promise((r) => setTimeout(r, 0));
}

// A deliberately broken copy of an app module for a mutation check: written
// to a scratch directory with its relative imports rewritten to absolute file
// URLs of the real modules, so only the mutated file differs. Removed on
// exit. The original file is only ever READ.
const MUTANT_DIR = join(HERE, `.mutants-browser-${process.pid}`);
let mutants = 0;
process.on('exit', () => rmSync(MUTANT_DIR, { recursive: true, force: true }));
async function importMutant(relPath, from, to) {
  const original = readFileSync(join(SRC, relPath), 'utf8');
  if (!original.includes(from)) throw new Error(`mutation anchor not found in ${relPath}: ${from}`);
  const source = original.replace(from, to);
  const originalDir = dirname(join(SRC, relPath));
  const rewritten = source.replace(/(from\s+)'(\.{1,2}\/[^']+)'/g, (_m, kw, spec) => `${kw}'${pathToFileURL(resolvePath(originalDir, spec)).href}'`);
  mkdirSync(MUTANT_DIR, { recursive: true });
  mutants += 1;
  const file = join(MUTANT_DIR, `m${mutants}-${relPath.split('/').pop()}`);
  writeFileSync(file, rewritten);
  return import(pathToFileURL(file).href);
}

// Disposable accounts from the public BIP-39 test mnemonic.
const seed = mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const ACCOUNT_0 = evmKeyProvider.deriveAccount(seed, 0, 0);
const ACCOUNT_1 = evmKeyProvider.deriveAccount(seed, 0, 1);
const SEPOLIA = 'eip155:11155111';
const BASE_SEPOLIA = 'eip155:84532';
const MAINNET = 'eip155:1';
const UNISWAP = 'https://app.uniswap.org';
const ENS = 'https://app.ens.dev';

// ---------------------------------------------------------------------------
console.log('check-browser: the allowlist');
// ---------------------------------------------------------------------------
check('the allowlist holds Uniswap and the ENS Sepolia app, nothing else', BROWSER_SITES.map((s) => s.origin).join() === `${UNISWAP},${ENS}`);
for (const s of BROWSER_SITES) {
  const p = parseWebOrigin(s.origin);
  check(`${s.origin}: exact https origin (no path, port or user-info) with a reason`,
    p !== null && p.scheme === 'https' && p.origin === s.origin && !p.hadUserinfo && s.reason.length > 20 && s.name.length > 0);
  check(`${s.origin}: the first URL is allowed before load`, decideNavigation(`${s.origin}/`, { isTopFrame: true }).kind === 'allow');
}
check('no listed site is an NFT marketplace (section 4.2)', BROWSER_SITES.every((s) => !/nft|opensea|blur|magic ?eden/i.test(`${s.name} ${s.description}`)));

// ---------------------------------------------------------------------------
console.log('check-browser: origin parsing (B1)');
// ---------------------------------------------------------------------------
// react-native-webview 13.16.1 src/WebViewShared.tsx, rebuilt verbatim: the
// matcher the library would use for an originWhitelist entry.
const escapeStringRegexp = require('escape-string-regexp');
const libExtractOrigin = (url) => {
  const result = /^[A-Za-z][A-Za-z0-9+\-.]+:(\/\/)?[^/]*/.exec(url);
  return result === null ? '' : result[0];
};
const libPasses = (entries, url) => ['about:blank', ...entries]
  .map((e) => `^${escapeStringRegexp(e).replace(/\\\*/g, '.*')}`)
  .some((x) => new RegExp(x).test(libExtractOrigin(url)));
check('escape-string-regexp is 4.0.0, as the design ran it', require('escape-string-regexp/package.json').version === '4.0.0');
check('the library source still builds the unanchored expression (B1 is real in the installed copy)',
  readFileSync(join(HERE, '..', 'node_modules', 'react-native-webview', 'src', 'WebViewShared.tsx'), 'utf8')
    .includes("`^${escapeStringRegexp(originWhitelist).replace(/\\\\\\*/g, '.*')}`"));

const PREFIX_ATTACKS = [
  'https://app.uniswap.org.attacker.example',
  'https://app.uniswap.org.attacker.example/swap',
  'https://app.uniswap.org@evil.example',
  'https://app.uniswap.org:443@evil.example/',
  'https://app.uniswap.orgx.example',
];
for (const url of PREFIX_ATTACKS) {
  check(`B1: the library's matcher ADMITS ${url}`, libPasses([UNISWAP], url));
  check(`B1: the wallet refuses ${url}`, siteForUrl(url) === null && decideNavigation(url, { isTopFrame: true }).kind !== 'allow');
}
const userinfo = parseWebOrigin('https://app.uniswap.org@evil.example/');
check('user-info: the real host is the one after "@" and the flag is set', userinfo?.host === 'evil.example' && userinfo.hadUserinfo === true);
check('user-info on the listed host itself is still refused', siteForUrl('https://user:pass@app.uniswap.org/') === null && decideNavigation('https://user@app.uniswap.org/').kind === 'refuse');

const ACCEPTED_SAME = [
  'https://app.uniswap.org', 'https://app.uniswap.org/', 'https://app.uniswap.org/#/swap?chain=sepolia',
  'HTTPS://APP.UNISWAP.ORG/x', 'https://App.Uniswap.Org', 'https://app.uniswap.org:443/', 'https://app.uniswap.org:0443',
  'https://app.uniswap.org?x=1', 'https://app.uniswap.org:/',
];
for (const url of ACCEPTED_SAME) {
  check(`same origin as the listed site: ${url}`, siteForUrl(url)?.origin === UNISWAP && parseWebOrigin(url)?.origin === new URL(url).origin);
}
const OTHER_ORIGINS = [
  ['a non-default port', 'https://app.uniswap.org:8443/'],
  ['a trailing dot', 'https://app.uniswap.org./'],
  ['http', 'http://app.uniswap.org/'],
  ['a sibling subdomain', 'https://uniswap.org/'],
  ['a deeper subdomain', 'https://x.app.uniswap.org/'],
  ['a punycode look-alike', 'https://xn--pp-uniswap-ufb.org/'],
];
for (const [what, url] of OTHER_ORIGINS) {
  const p = parseWebOrigin(url);
  check(`a different origin is not listed: ${what}`, p !== null && siteForUrl(url) === null && p.origin === new URL(url).origin, p?.origin);
}
const REFUSED_PARSE = [
  ['a backslash (WHATWG reads it as "/")', 'https://app.uniswap.org\\@evil.example/'],
  ['a newline (WHATWG strips it)', 'https://app.uni\nswap.org/'],
  ['a tab', 'https://app.\tuniswap.org/'],
  ['a space', 'https://app.uniswap.org /'],
  ['a percent-encoded dot (WHATWG decodes it)', 'https://app%2euniswap.org/'],
  ['a non-ASCII look-alike letter (Cyrillic a)', 'https://аpp.uniswap.org/'],
  ['an IPv6 literal', 'https://[::1]/'],
  ['no host', 'https:///path'],
  ['no "//"', 'https:app.uniswap.org'],
  ['a port above 65535', 'https://app.uniswap.org:65536/'],
  ['a leading dot', 'https://.app.uniswap.org/'],
  ['an empty label', 'https://app..uniswap.org/'],
  ['not a string', 42],
  ['DEL', 'https://app.uniswap.org\u007f/'],
];
for (const [what, url] of REFUSED_PARSE) {
  check(`unparseable for the wallet: ${what}`, parseWebOrigin(url) === null && siteForUrl(url) === null);
}
// Generated agreement with WHATWG: whatever the wallet accepts maps to the
// origin URL() gives.
{
  const schemes = ['https', 'HTTPS', 'http', 'wss'];
  const hosts = ['app.uniswap.org', 'APP.uniswap.org', 'a.b.c', 'xn--80ak6aa92e.com', 'localhost', '127.0.0.1', 'app.uniswap.org.', 'x-y.example'];
  const users = ['', 'u@', 'u:p@', 'app.uniswap.org@'];
  const ports = ['', ':', ':443', ':80', ':8443', ':00443', ':65535'];
  const tails = ['', '/', '/a/b', '?q=1', '#frag', '/@x'];
  let agree = 0;
  let total = 0;
  const disagreements = [];
  for (const s of schemes) for (const u of users) for (const h of hosts) for (const p of ports) for (const t of tails) {
    const url = `${s}://${u}${h}${p}${t}`;
    const ours = parseWebOrigin(url);
    if (!ours) continue;
    total += 1;
    if (ours.origin === new URL(url).origin) agree += 1;
    else disagreements.push(url);
  }
  check(`every accepted generated URL agrees with WHATWG URL.origin (${total} URLs)`, total > 1000 && agree === total, disagreements.slice(0, 3).join(' | '));
}
check('sameOrigin compares parsed origins only', sameOrigin('https://app.uniswap.org/a', 'HTTPS://APP.UNISWAP.ORG:443/b') && !sameOrigin('https://app.uniswap.org', 'https://app.uniswap.org.') && !sameOrigin('x', 'x'));

// ---------------------------------------------------------------------------
console.log('check-browser: navigation decisions (B6) and the first load');
// ---------------------------------------------------------------------------
const NAV_REFUSED = ['intent://scan/#Intent;scheme=zxing;end', 'mailto:a@b.example', 'javascript:alert(1)', 'http://app.uniswap.org/',
  'data:text/html,<p>x</p>', 'about:blank', 'file:///etc/hosts', 'wc:abc@2?relay-protocol=irn', 'tel:123', 'blob:https://app.uniswap.org/x'];
for (const url of NAV_REFUSED) {
  const d = decideNavigation(url, { isTopFrame: true });
  check(`top-frame navigation refused (never handed to another app): ${url.slice(0, 40)}`, d.kind === 'refuse', JSON.stringify(d));
}
check('a non-https scheme is refused with the scheme sentence', decideNavigation('intent://x').kind === 'refuse' && decideNavigation('intent://x').reason === NAV_REFUSAL_SCHEME);
check('a user-info https URL is refused (not even offered outside)', decideNavigation('https://app.uniswap.org@evil.example/').reason === NAV_REFUSAL_USERINFO);
{
  const d = decideNavigation('https://docs.uniswap.org/contracts', { isTopFrame: true });
  check('an off-list https page is NOT loaded; it is only offered outside after a confirmation', d.kind === 'external' && d.host === 'docs.uniswap.org' && d.url === 'https://docs.uniswap.org/contracts');
  check('the confirmation names the host and the full URL', externalLinkMessage(d.host, d.url).includes('docs.uniswap.org') && externalLinkMessage(d.host, d.url).endsWith(d.url));
}
check('Android reports no isTopFrame: judged as top frame (off-list → not loaded)', decideNavigation('https://widget.example/').kind === 'external');
check('iOS subframes: https and blank documents load (their messages are dropped by the frame rule)',
  decideNavigation('https://widget.example/', { isTopFrame: false }).kind === 'allow' && decideNavigation('about:blank', { isTopFrame: false }).kind === 'allow' &&
  decideNavigation('about:srcdoc', { isTopFrame: false }).kind === 'allow');
check('iOS subframes: non-https schemes are still refused', decideNavigation('intent://x', { isTopFrame: false }).kind === 'refuse' && decideNavigation('http://x.example/', { isTopFrame: false }).kind === 'refuse');
check('B6 unreachable: the library matcher with ["*"] passes every URL tested, so its Linking branch never runs',
  [...NAV_REFUSED, ...PREFIX_ATTACKS, 'https://docs.uniswap.org/', '', 'weird'].every((u) => libPasses(['*'], u)));
check('…while its default ["http://*","https://*"] would hand intent:, mailto: and tel: links to Linking',
  ['intent://x', 'mailto:a@b.example', 'tel:1'].every((u) => !libPasses(['http://*', 'https://*'], u)));
const SCREEN = readFileSync(join(SRC, 'screens', 'BrowserScreen.tsx'), 'utf8');
check('the screen passes originWhitelist={[\'*\']}', SCREEN.includes("originWhitelist={['*']}"));
check('the screen checks the first URL with decideNavigation before rendering the WebView',
  /const firstDecision = useMemo\(\(\) => decideNavigation\(`\$\{site\.origin\}\/`, \{ isTopFrame: true \}\)/.test(SCREEN) &&
    SCREEN.indexOf("firstDecision.kind !== 'allow' ?") < SCREEN.indexOf('<WebView\n'));
check('Linking.openURL appears exactly once, inside the confirmation\'s "Open in browser" button',
  (SCREEN.match(/Linking\.openURL/g) ?? []).length === 1 &&
    /text: 'Open in browser',[\s\S]{0,400}Linking\.openURL\(url\)/.test(SCREEN));
check('onShouldStartLoadWithRequest answers synchronously from decideNavigation (Android allows the load after 250 ms)',
  /const onShouldStart = useCallback\(\s*\(request: ShouldStartLoadRequest\): boolean => \{[\s\S]{0,200}decideNavigation\(request\.url, \{ isTopFrame: request\.isTopFrame \}\)/.test(SCREEN));
check('the screen keeps setSupportMultipleWindows true and handles onOpenWindow (B8)', SCREEN.includes('setSupportMultipleWindows\n') && SCREEN.includes('onOpenWindow={onOpenWindow}') && !/setSupportMultipleWindows=\{false\}/.test(SCREEN));
check('incognito, https-only content, no file access, no geolocation, iOS capture denied, no debugging',
  ['incognito\n', 'mixedContentMode="never"', 'allowFileAccess={false}', 'allowUniversalAccessFromFileURLs={false}', 'geolocationEnabled={false}', 'mediaCapturePermissionGrantType="deny"', 'webviewDebuggingEnabled={false}'].every((p) => SCREEN.includes(p)));
check('no iOS download handler is given (no onFileDownload prop)', !/onFileDownload=/.test(SCREEN));
check('the screen re-injects the provider when a load ends (B4)', /webView\.current\?\.injectJavaScript\(script\)/.test(SCREEN));
check('the screen states the camera, download-cookie, file-picker and storage residuals (B5, B7)', /camera without asking/.test(SCREEN) && /cookies with the download/.test(SCREEN) && /file or photo picker/.test(SCREEN) && /local storage\) stays between visits/.test(SCREEN));

// ---------------------------------------------------------------------------
console.log('check-browser: the frame rule (B2, B3)');
// ---------------------------------------------------------------------------
check('a message from the top page (full URL, as Android\'s fallback reports) is accepted', acceptsFrameMessage('https://app.uniswap.org/#/swap', UNISWAP));
check('a message reported by origin (WEB_MESSAGE_LISTENER / iOS) is accepted', acceptsFrameMessage('https://app.uniswap.org', UNISWAP));
check('a cross-origin iframe\'s message is dropped', !acceptsFrameMessage('https://widget.example', UNISWAP));
check('a same-site but different-origin frame is dropped', !acceptsFrameMessage('https://x.app.uniswap.org', UNISWAP) && !acceptsFrameMessage('https://app.uniswap.org:8443', UNISWAP));
check('another allowlisted origin is dropped while it is not the top page', !acceptsFrameMessage(ENS, UNISWAP));
check('an opaque origin ("null", sandboxed frames) is dropped', !acceptsFrameMessage('null', UNISWAP));
check('http and user-info reports are dropped', !acceptsFrameMessage('http://app.uniswap.org', UNISWAP) && !acceptsFrameMessage('https://u@app.uniswap.org', UNISWAP));
check('no top origin (a navigation to an off-list page) → everything dropped', !acceptsFrameMessage(UNISWAP, null));
check('a top origin that is not on the allowlist → everything dropped, even from itself', !acceptsFrameMessage('https://evil.example', 'https://evil.example'));

// ---------------------------------------------------------------------------
console.log('check-browser: messages');
// ---------------------------------------------------------------------------
const NONCE = 'a'.repeat(32);
const msg = (o) => JSON.stringify({ channel: BROWSER_BRIDGE_CHANNEL, nonce: NONCE, ...o });
check('a well-formed request parses', parseBridgeMessage(msg({ type: 'request', id: 1, method: 'eth_chainId' }), NONCE)?.type === 'request');
check('another nonce (another load) is dropped', parseBridgeMessage(msg({ type: 'request', id: 1, method: 'eth_chainId' }), 'b'.repeat(32)) === null);
check('another channel is dropped', parseBridgeMessage(JSON.stringify({ channel: 'x', nonce: NONCE, type: 'request', id: 1, method: 'eth_chainId' }), NONCE) === null);
check('ids must be positive integers', [0, -1, 1.5, '1', 2 ** 60].every((id) => parseBridgeMessage(msg({ type: 'request', id, method: 'eth_chainId' }), NONCE) === null));
check('methods must be short identifiers', ['', 'eth chainId', 'a'.repeat(101), 'x;y'].every((method) => parseBridgeMessage(msg({ type: 'request', id: 1, method }), NONCE) === null));
check('params must be absent, an array or an object', parseBridgeMessage(msg({ type: 'request', id: 1, method: 'x', params: 'str' }), NONCE) === null && parseBridgeMessage(msg({ type: 'request', id: 1, method: 'x', params: [] }), NONCE) !== null);
check('non-JSON, non-strings and oversized messages are dropped', parseBridgeMessage('{', NONCE) === null && parseBridgeMessage({}, NONCE) === null && parseBridgeMessage('x'.repeat(600 * 1024), NONCE) === null);
check('hello carries the shim\'s chain id (validated) and the bridge heuristic', JSON.stringify(parseBridgeMessage(msg({ type: 'hello', hasListener: true, chainId: '0xAA36A7' }), NONCE)) === JSON.stringify({ type: 'hello', hasListener: true, chainId: '0xaa36a7' }) && parseBridgeMessage(msg({ type: 'hello', chainId: 'nope' }), NONCE).chainId === null);

// ---------------------------------------------------------------------------
console.log('check-browser: the method table and error translation');
// ---------------------------------------------------------------------------
const route = (m) => classifyBrowserMethod(m).kind;
check('eth_chainId and net_version are answered locally', route('eth_chainId') === 'chain-id' && route('net_version') === 'net-version');
check('eth_accounts is local; eth_requestAccounts is a connection request', route('eth_accounts') === 'accounts' && route('eth_requestAccounts') === 'connect');
check('signing, switch and ERC-5792 methods go to the queue',
  ['personal_sign', 'eth_signTypedData_v4', 'eth_sendTransaction', 'wallet_switchEthereumChain', 'wallet_sendCalls', 'wallet_getCapabilities', 'wallet_getCallsStatus'].every((m) => route(m) === 'queue'));
check('ERC-7715 is NOT requested in a browser proposal', BROWSER_PROPOSAL_METHODS.every((m) => !/ExecutionPermission/.test(m)));
check('the listed reads are proxied', BROWSER_READ_METHODS.every((m) => route(m) === 'read') && BROWSER_READ_METHODS.includes('eth_getLogs') && BROWSER_READ_METHODS.length === 14);
for (const m of ['wallet_addEthereumChain', 'eth_sign', 'eth_signTypedData', 'eth_signTypedData_v3', 'eth_signTransaction', 'eth_sendRawTransaction',
  'wallet_requestPermissions', 'wallet_connect', 'wallet_requestExecutionPermissions', 'wallet_getSupportedExecutionPermissions', 'eth_subscribe']) {
  check(`${m} is refused by name`, route(m) === 'refused');
}
check('unknown methods are unknown (4200 below)', route('eth_getStorageAt') === 'unknown' && route('foo_bar') === 'unknown');
check('methods naming an authorization, 7702 or a delegation hit the D6 refusal first',
  ['wallet_signAuthorization', 'eth_signEip7702Authorization', 'wallet_delegate', 'personal_signAuthorisation'].every((m) => route(m) === 'eip7702'));
// WalletConnect codes, read from the installed @walletconnect/utils.
check('WalletConnect codes are the documented ones', WC_ERRORS.userRejected.code === 5000 && WC_ERRORS.unsupportedChains.code === 5100 &&
  WC_ERRORS.unsupportedMethods.code === 5101 && WC_ERRORS.unsupportedEvents.code === 5102 && WC_ERRORS.unsupportedAccounts.code === 5103 &&
  WC_ERRORS.unsupportedNamespaceKey.code === 5104 && WC_ERRORS.userDisconnected.code === 6000);
for (const [from, to] of [[5000, 4001], [5100, 4901], [5101, 4200], [5103, 4100], [5102, 4200], [5104, 4200], [6000, 4100]]) {
  check(`WalletConnect ${from} → EIP-1193 ${to}`, translateWcError({ code: from, message: 'm' }).code === to && WC_TO_EIP1193[from] === to);
}
check('every WC_ERRORS code is translated', Object.values(WC_ERRORS).every((e) => WC_TO_EIP1193[e.code] !== undefined));
check('ERC-5792, EIP-1193 and JSON-RPC codes pass through', [5700, 5720, 5730, 4001, 4100, -32602, -32603].every((c) => translateWcError({ code: c, message: 'm' }).code === c));
check('the message passes through (capped) and data is kept', translateWcError({ code: 5000, message: 'x'.repeat(5000), data: '0x01' }).message.length === 2000 && translateWcError({ code: 5000, message: 'm', data: '0x01' }).data === '0x01');

// ---------------------------------------------------------------------------
console.log('check-browser: read proxy validation and bounds');
// ---------------------------------------------------------------------------
check('eth_blockNumber takes no params', checkReadParams('eth_blockNumber', []).ok && !checkReadParams('eth_blockNumber', [1]).ok);
check('eth_getBalance needs an address and a block', checkReadParams('eth_getBalance', [ACCOUNT_0.address, 'latest']).ok && !checkReadParams('eth_getBalance', ['0x12', 'latest']).ok);
check('eth_call forwards a call object and a block; state overrides are not forwarded',
  checkReadParams('eth_call', [{ to: ACCOUNT_0.address, data: '0x' }, 'latest']).ok && !checkReadParams('eth_call', [{ to: ACCOUNT_0.address }, 'latest', {}]).ok);
check('eth_call / eth_estimateGas carrying an authorization list are refused with the D6 sentence', checkReadParams('eth_estimateGas', [{ authorizationList: [] }]).reason?.includes(EIP7702_WC_REFUSAL));
check('params must be an array and not too large', !checkReadParams('eth_call', {}).ok && !checkReadParams('eth_call', [{ data: '0x' + 'ab'.repeat(70_000) }]).ok);
check('eth_getLogs: no range at all = the latest block only (accepted)', checkGetLogsFilter({ address: ACCOUNT_0.address }) === null && checkGetLogsFilter({ fromBlock: 'latest', toBlock: 'latest' }) === null);
check('eth_getLogs: an open range is refused', checkGetLogsFilter({ fromBlock: '0x0' }) !== null && checkGetLogsFilter({ fromBlock: 'earliest', toBlock: 'latest' }) !== null);
check('eth_getLogs: exactly 1,000 blocks accepted, 1,001 refused', checkGetLogsFilter({ fromBlock: '0x1', toBlock: '0x3e8' }) === null && checkGetLogsFilter({ fromBlock: '0x1', toBlock: '0x3e9' }) !== null);
check('eth_getLogs: a reversed range is refused', checkGetLogsFilter({ fromBlock: '0x10', toBlock: '0x1' }) !== null);
check('eth_getLogs: a block hash is accepted alone, refused with a range', checkGetLogsFilter({ blockHash: '0x' + '1'.repeat(64) }) === null && checkGetLogsFilter({ blockHash: '0x' + '1'.repeat(64), fromBlock: '0x1' }) !== null);
check('eth_getLogs: at most 20 addresses and 4 topic positions', checkGetLogsFilter({ address: Array(21).fill(ACCOUNT_0.address) }) !== null &&
  checkGetLogsFilter({ topics: [null, null, null, null, null] }) !== null && checkGetLogsFilter({ topics: [['0x' + '2'.repeat(64)], null] }) === null);
check('eth_getLogs: unknown filter fields are refused', checkGetLogsFilter({ limit: 5 }) !== null);
check('eth_feeHistory: bounded block count', checkReadParams('eth_feeHistory', ['0x4', 'latest', [25, 75]]).ok && !checkReadParams('eth_feeHistory', [5000, 'latest', []]).ok);
{
  let t = 1_000_000;
  const limiter = new OriginRateLimiter(READ_RATE_LIMITS, () => t);
  const slots = [];
  for (let i = 0; i < READ_RATE_LIMITS.inFlight; i += 1) slots.push(limiter.acquire(UNISWAP));
  check('in flight: 4 reads at once, the 5th refused', slots.every((s) => s.ok) && !limiter.acquire(UNISWAP).ok);
  for (const s of slots) s.release();
  let ok = 4;
  for (let i = 0; i < 20; i += 1) {
    const s = limiter.acquire(UNISWAP);
    if (s.ok) { ok += 1; s.release(); }
  }
  check('per second: at most 10 in one second', ok === READ_RATE_LIMITS.perSecond);
  check('limits are per origin', limiter.acquire(ENS).ok);
  let minute = ok;
  for (let sec = 1; sec < 60; sec += 1) {
    t += 1000;
    for (let i = 0; i < 10; i += 1) {
      const s = limiter.acquire(UNISWAP);
      if (s.ok) { minute += 1; s.release(); }
    }
  }
  check('per minute: at most 120 in any 60 seconds', minute === READ_RATE_LIMITS.perMinute, String(minute));
  t += 60_001;
  check('…and the window slides', limiter.acquire(UNISWAP).ok);
}
{
  const calls = [];
  const answers = { eth_chainId: '0xaa36a7', eth_blockNumber: '0x10' };
  const fetchFn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push([url, body.method]);
    if (url.includes('down')) throw new TypeError('fetch failed');
    if (body.method === 'eth_call') return { ok: true, json: async () => ({ jsonrpc: '2.0', id: body.id, error: { code: 3, message: 'execution reverted', data: '0x08c379a0' } }) };
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: body.id, result: answers[body.method] }) };
  };
  let url = 'https://node.example/v2/SECRETKEY';
  const rpc = createEndpointReadRpc({ run: (op) => op(url), fetchFn, chainIdHex: () => '0xaa36a7' });
  const first = await rpc('eth_blockNumber', []);
  check('the endpoint read checks eth_chainId once, then forwards', first.result === '0x10' && calls.map((c) => c[1]).join() === 'eth_chainId,eth_blockNumber');
  await rpc('eth_blockNumber', []);
  check('…and does not re-check the same endpoint', calls.filter((c) => c[1] === 'eth_chainId').length === 1);
  const revert = await rpc('eth_call', [{}]);
  check('a JSON-RPC error reaches the page with code, message and hex data only', revert.error?.code === 3 && revert.error.data === '0x08c379a0');
  const wrongChain = createEndpointReadRpc({ run: (op) => op(url), fetchFn, chainIdHex: () => '0x14a34' });
  const refused = await wrongChain('eth_blockNumber', []);
  check('an endpoint serving another chain gets no reads (4901)', refused.error?.code === EIP1193_ERRORS.chainDisconnected && !calls.slice(-1)[0][1].includes('blockNumber'));
  url = 'https://down.example/v2/SECRETKEY';
  const down = await rpc('eth_blockNumber', []);
  check('a transport failure becomes a generic sentence (no URL or key reaches the page)', down.error?.message === READ_UNAVAILABLE_MESSAGE && !JSON.stringify(down).includes('SECRET'));
}

// ---------------------------------------------------------------------------
console.log('check-browser: readiness and watch-only gating');
// ---------------------------------------------------------------------------
{
  const f = featureReadiness('dapp-browser');
  check('readiness row dapp-browser: test networks only, enforced', f.status === 'testnet-only' && f.enforced === true && FEATURE_READINESS.filter((x) => x.id === 'dapp-browser').length === 1);
  check('readinessGate refuses mainnet and clears every test network', readinessGate('dapp-browser', MAINNET) !== null && readinessGate('dapp-browser', SEPOLIA) === null && readinessGate('dapp-browser', BASE_SEPOLIA) === null && readinessGate('dapp-browser', 'eip155:421614') === null);
  check('the screen renders the readiness card before anything else', /const gate = readinessGate\('dapp-browser', evmChain\.caip2\);[\s\S]{0,700}if \(gate\) \{/.test(SCREEN));
  check('the Apps route is NOT on the watch-only allow list, and its refusal names the feature', !WATCH_ONLY_ALLOWED_ROUTES.includes('Apps') && watchOnlyRouteRefusal('Apps')?.startsWith('The in-app browser (Apps)'));
  const app = readFileSync(join(HERE, '..', 'App.tsx'), 'utf8');
  check('App.tsx registers the Apps route inside the gated main stack', /<Stack\.Screen name="Apps" component=\{BrowserScreen\}/.test(app) && app.indexOf('name="Apps"') > app.indexOf('screenLayout={watchOnlyScreenLayout}'));
}

// ---------------------------------------------------------------------------
console.log('check-browser: the injected provider (a fake page in its own JavaScript context)');
// ---------------------------------------------------------------------------
check('the uuid is a version-4 UUID', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuidV4FromBytes(new Uint8Array(16).fill(255))));
check('malformed script options are refused, not spliced into JavaScript', [
  { nonce: "x'+alert(1)+'", uuid: uuidV4FromBytes(new Uint8Array(16)), chainIdHex: '0x1' },
  { nonce: NONCE, uuid: 'nope', chainIdHex: '0x1' },
  { nonce: NONCE, uuid: uuidV4FromBytes(new Uint8Array(16)), chainIdHex: '1;alert(1)' },
].every((o) => { try { buildProviderScript(o); return false; } catch { return true; } }));

/** A fake page: a separate JavaScript context with the library's bridge object. */
function fakePage({ origin, nonce, chainIdHex, reportAs = 'url', browser }) {
  const posted = [];
  const target = new EventTarget();
  const announced = [];
  const win = {
    ReactNativeWebView: { postMessage: (data) => { posted.push(data); void browser?.handleMessage(reportAs === 'url' ? `${origin}/#/swap` : origin, data); } },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
    CustomEvent,
    Event,
  };
  win.window = win;
  target.addEventListener('eip6963:announceProvider', (e) => announced.push(e.detail));
  vm.createContext(win);
  const script = buildProviderScript({ nonce, uuid: uuidV4FromBytes(new Uint8Array(16).fill(7)), chainIdHex });
  const events = [];
  return {
    win, posted, announced, events, script,
    inject: () => vm.runInContext(script, win),
    deliver: (payload) => vm.runInContext(deliverToPageScript(payload), win),
    request: (method, params) => win.ethereum.request(params === undefined ? { method } : { method, params }),
    listen: () => ['accountsChanged', 'chainChanged'].forEach((name) => win.ethereum.on(name, (v) => events.push([name, v]))),
  };
}

// ---------------------------------------------------------------------------
console.log('check-browser: the bridge through the real WcController');
// ---------------------------------------------------------------------------
const store = memoryStore();
const ctx = { address: ACCOUNT_0.address, activeChain: SEPOLIA };
let clock = 2_000_000;
const reads = [];
let readImpl = async (method) => ({ result: method === 'eth_blockNumber' ? '0x99' : null });
const browser = new BrowserBridgeClient({
  getContext: () => ({ ...ctx }),
  readRpc: async (method, params) => { reads.push([method, params]); return readImpl(method, params); },
  store,
  now: () => clock,
});
const composite = new CompositeWcClient(browser);
const labelFor = (a) => (a.toLowerCase() === ACCOUNT_0.address.toLowerCase() ? 'Account 1' : a.toLowerCase() === ACCOUNT_1.address.toLowerCase() ? 'Account 2' : null);
const controller = new WcController(composite, () => ({ address: ctx.address, activeChain: ctx.activeChain, labelFor }), {});
controller.attach();

const page = fakePage({ origin: UNISWAP, nonce: NONCE, chainIdHex: '0xaa36a7', browser });
browser.attachPage({ origin: UNISWAP, nonce: NONCE, deliver: page.deliver, onHello: (h) => (page.hello = h) });
page.inject();
await settle();
check('the provider is installed as window.ethereum and announced once (EIP-6963)', typeof page.win.ethereum?.request === 'function' && page.announced.length === 1);
const detail = page.announced[0];
check('the EIP-6963 detail and info are frozen, rdns is the placeholder, icon is a data URI',
  Object.isFrozen(detail) && Object.isFrozen(detail.info) && detail.info.rdns === EIP6963_RDNS && detail.info.icon.startsWith('data:image/svg+xml,') && detail.info.name === 'Shiba Wallet');
check('the shim said hello with its chain', page.posted.length === 1 && JSON.parse(page.posted[0]).type === 'hello' && JSON.parse(page.posted[0]).chainId === '0xaa36a7' && page.hello?.hasListener === false);
page.listen();
page.inject();
await settle();
check('B4: a second injection creates no second provider; it announces again', page.announced.length === 2 && page.announced[1].provider === detail.provider && page.posted.length === 1);
page.win.dispatchEvent(new Event('eip6963:requestProvider'));
check('eip6963:requestProvider is answered', page.announced.length === 3);
check('the shim carries no key material or address (only nonce, uuid, chain, name, icon)', !/0x[0-9a-fA-F]{40}/.test(page.script) && !/mnemonic|private|secret/i.test(page.script));

check('eth_chainId is the active chain, answered locally', (await page.request('eth_chainId')) === '0xaa36a7');
check('net_version is the decimal chain id', (await page.request('net_version')) === '11155111');
check('eth_accounts is [] before connection', JSON.stringify(await page.request('eth_accounts')) === '[]');
const rejection = async (p) => { try { await p; return null; } catch (e) { return e; } };
{
  const e = await rejection(page.request('personal_sign', ['0x68656c6c6f', ACCOUNT_0.address]));
  check('signing before connection is refused with 4100', e?.code === 4100 && e.message === NOT_CONNECTED_MESSAGE && controller.queue.length === 0);
  const t = await rejection(page.request('eth_sendTransaction', [{ to: ACCOUNT_1.address }]));
  check('a transaction before connection is refused with 4100', t?.code === 4100);
}
{
  const e = await rejection(page.request('wallet_addEthereumChain', [{ chainId: '0x1' }]));
  check('wallet_addEthereumChain → 4200', e?.code === 4200 && /does not add networks/.test(e.message));
  const u = await rejection(page.request('eth_getStorageAt', [ACCOUNT_0.address, '0x0', 'latest']));
  check('an unlisted method → 4200 and no read', u?.code === 4200 && reads.length === 0);
  const a = await rejection(page.request('wallet_signAuthorization', [{}]));
  check('a method naming an authorization → WalletConnect\'s D6 sentence, 4200', a?.code === 4200 && a.message === EIP7702_WC_REFUSAL);
  const x = await rejection(page.request('wallet_requestExecutionPermissions', [{}]));
  check('ERC-7715 → 4200', x?.code === 4200);
}

// A frame other than the top page: nothing happens, nothing is answered.
{
  const before = controller.queue.length;
  const deliveredBefore = page.posted.length;
  let answered = false;
  const spy = browser.page.deliver;
  browser.page.deliver = (p) => { answered = true; spy(p); };
  await browser.handleMessage('https://widget.example', msg({ type: 'request', id: 900, method: 'eth_requestAccounts' }));
  await browser.handleMessage('https://app.uniswap.org.attacker.example', msg({ type: 'request', id: 901, method: 'eth_requestAccounts' }));
  await browser.handleMessage(UNISWAP, msg({ type: 'request', id: 902, method: 'eth_requestAccounts', nonce: 'c'.repeat(32) }).replace(NONCE, 'c'.repeat(32)));
  await settle();
  browser.page.deliver = spy;
  check('iframe, look-alike and wrong-nonce messages are dropped unanswered (nothing queued)', !answered && controller.queue.length === before && page.posted.length === deliveredBefore);
}

// Connection: a proposal on the queue, approved through approveProposal.
const connectPromise = page.request('eth_requestAccounts');
await settle();
{
  const item = controller.queue[0];
  check('eth_requestAccounts queues ONE proposal on the shared controller', controller.queue.length === 1 && item?.type === 'proposal' && item.event.id < 0);
  check('the proposal is named by the origin\'s host, with the origin as its URL', item.summary.name === 'app.uniswap.org' && item.summary.url === UNISWAP);
  check('its identity is the browser\'s first-hand origin, never "Verified by WalletConnect"',
    item.identity.status === 'browser' && item.identity.origin === UNISWAP && !item.identity.message.includes('WalletConnect') && item.identity.requiresAcknowledgement === false);
  check('a second eth_requestAccounts joins the same proposal', (page.request('eth_requestAccounts').then((r) => (page.joined = r)), true));
  await settle();
  check('…(still one proposal)', controller.queue.filter((i) => i.type === 'proposal').length === 1);
  const decision = decideProposal(item.event.params, ACCOUNT_0.address, SEPOLIA, WC_SUPPORTED_METHODS);
  check('the EOA connection approves the signing methods and the switch, no ERC-5792', decision.ok && JSON.stringify(decision.namespaces.eip155.methods) === JSON.stringify(WC_SUPPORTED_METHODS));
  const smart = decideProposal(item.event.params, ACCOUNT_1.address, SEPOLIA, smartAccountMethodsFor('kernel-v3.3'));
  check('a Kernel connection would add ERC-5792 but still no ERC-7715', smart.ok && WC_SMART_ACCOUNT_METHODS.every((m) => smart.namespaces.eip155.methods.includes(m)) && !smart.namespaces.eip155.methods.some((m) => /ExecutionPermission/.test(m)));
  check('the controller holds it while locked', (controller.setLocked(true), controller.getSnapshot().head === null && controller.begin(item.key) === null));
  controller.setLocked(false);
  const claimed = controller.begin(item.key);
  const outcome = await approveProposal(composite, item.event, ACCOUNT_0.address, SEPOLIA, WC_SUPPORTED_METHODS);
  controller.refreshSessions();
  controller.complete(item.key);
  check('approveProposal through the composite client approves it', claimed !== null && outcome.approved === true);
}
check('the page receives [address] for both waiting requests', JSON.stringify(await connectPromise) === JSON.stringify([ACCOUNT_0.address]));
await settle();
check('…the joined request too', JSON.stringify(page.joined) === JSON.stringify([ACCOUNT_0.address]));
check('accountsChanged was emitted to the page', page.events.some(([n, v]) => n === 'accountsChanged' && v[0] === ACCOUNT_0.address));
check('eth_accounts now returns the bound address', JSON.stringify(await page.request('eth_accounts')) === JSON.stringify([ACCOUNT_0.address]));
const TOPIC = browserTopicFor(UNISWAP);
{
  const session = controller.sessions.find((s) => s.topic === TOPIC);
  check('Connections lists it as browser:<origin> with the host as name', session?.name === 'app.uniswap.org' && session.url === UNISWAP && session.addresses[0] === ACCOUNT_0.address && isBrowserTopic(session.topic));
  const stored = await loadBrowserConnections(store);
  check('the record is stored (public data only)', stored.length === 1 && stored[0].origin === UNISWAP && stored[0].owner === ACCOUNT_0.address && !/[0-9a-f]{64}/i.test(store._map.get(BROWSER_CONNECTIONS_KEY)));
  check('a repeated eth_requestAccounts is answered without a prompt', JSON.stringify(await page.request('eth_requestAccounts')) === JSON.stringify([ACCOUNT_0.address]) && controller.queue.length === 0);
}

/** Approves the head request like WalletConnectContext's regular-account path does. */
async function approveHeadSignature() {
  const item = controller.queue[0];
  const claimed = controller.begin(item.key);
  const stale = controller.staleChainError(item) ?? controller.staleAccountError(item);
  if (!claimed || stale) return { claimed, stale };
  const digest = item.parsed.kind === 'personal_sign' ? item.parsed.digest : item.parsed.typedData.digest;
  await respondApproved(composite, item.event.topic, item.event.id, signDigest(ACCOUNT_0, digest));
  controller.complete(item.key);
  return { claimed, stale: null };
}

// SIWE: a sign-in for the page's own origin.
{
  const message = Siwe.createMessage({
    address: ACCOUNT_0.address, chainId: 11155111, domain: 'app.uniswap.org', nonce: 'abcdef123456',
    uri: 'https://app.uniswap.org/', version: '1', issuedAt: new Date('2026-10-09T12:00:00Z'), statement: 'Sign in to Uniswap.',
  });
  const hex = ethers.hexlify(ethers.toUtf8Bytes(message));
  const signing = page.request('personal_sign', [hex, ACCOUNT_0.address]);
  await settle();
  const item = controller.queue[0];
  check('a SIWE personal_sign is queued with the browser identity', item?.type === 'request' && item.identity.status === 'browser' && item.event.topic === TOPIC);
  check('SIWE origin comes from the browser (source "browser")', JSON.stringify(siweOriginFor(item.identity)) === JSON.stringify({ url: UNISWAP, source: 'browser' }));
  check('matching domain: no gate, approvable without the risk switch', item.identity.siweGate === undefined && identityApprovalAllowed(item.identity, false));
  await approveHeadSignature();
  const signature = await signing;
  check('the page receives a signature that recovers to the connected account', ethers.verifyMessage(message, signature) === ACCOUNT_0.address);
}
// SIWE: a sign-in for ANOTHER site, asked by this page.
{
  const message = Siwe.createMessage({
    address: ACCOUNT_0.address, chainId: 11155111, domain: 'evil.example', nonce: 'abcdef123456',
    uri: 'https://evil.example/', version: '1', issuedAt: new Date('2026-10-09T12:00:00Z'),
  });
  const signing = page.request('personal_sign', [ethers.hexlify(ethers.toUtf8Bytes(message)), ACCOUNT_0.address]);
  await settle();
  const item = controller.queue[0];
  check('mismatching domain: the SIWE gate is set from the first-hand origin', typeof item.identity.siweGate === 'string' && item.identity.requiresAcknowledgement === true);
  check('…approval needs the risk switch', !identityApprovalAllowed(item.identity, false) && identityApprovalAllowed(item.identity, true));
  await controller.decline(item.key);
  const e = await rejection(signing);
  check('declining answers the page with 4001', e?.code === 4001 && controller.queue.length === 0);
}
// ADR D6: a transaction carrying an authorization list.
{
  for (const tx of [{ to: ACCOUNT_1.address, authorizationList: [] }, { to: ACCOUNT_1.address, type: '0x4' }, { to: ACCOUNT_1.address, authorization_list: [{}] }]) {
    const e = await rejection(page.request('eth_sendTransaction', [tx]));
    await settle();
    check(`a transaction with ${Object.keys(tx)[1]} is refused exactly as over WalletConnect (5000 → 4001, D6 sentence), nothing queued`,
      e?.code === 4001 && e.message === EIP7702_WC_REFUSAL && controller.queue.length === 0);
  }
  const notice = controller.notices[0]?.text ?? '';
  check('the controller recorded the automatic decline as a notice', notice.includes('eth_sendTransaction') && notice.includes('app.uniswap.org'));
}
// A plain transaction reaches the queue as a 'transaction' for the sheet.
{
  const sending = page.request('eth_sendTransaction', [{ from: ACCOUNT_0.address, to: ACCOUNT_1.address, value: '0x1' }]);
  await settle();
  const item = controller.queue[0];
  check('a transaction is queued for the sheet (quote, gates, preview, risk card)', item?.type === 'request' && item.parsed.kind === 'transaction' && item.parsed.tx.valueWei === 1n);
  await controller.decline(item.key);
  check('…and declined with 4001', (await rejection(sending))?.code === 4001);
}
// wallet_switchEthereumChain, answered like WalletConnect's.
{
  const same = page.request('wallet_switchEthereumChain', [{ chainId: '0xaa36a7' }]);
  await settle();
  check('switching to the active chain answers null, never queued', (await same) === null && controller.queue.length === 0);
  const other = await rejection(page.request('wallet_switchEthereumChain', [{ chainId: '0x1' }]));
  check('switching to another chain → 4901, the wallet\'s mode unchanged', other?.code === 4901 && ctx.activeChain === SEPOLIA);
}
// Too many waiting requests from one origin.
{
  const waiting = [];
  for (let i = 0; i < MAX_WAITING_PER_ORIGIN + 1; i += 1) waiting.push(rejection(page.request('personal_sign', ['0x01', ACCOUNT_0.address])));
  await settle();
  const sixth = await waiting[MAX_WAITING_PER_ORIGIN];
  check(`at most ${MAX_WAITING_PER_ORIGIN} requests per origin wait in the queue; the next gets -32005`, controller.queue.length === MAX_WAITING_PER_ORIGIN && sixth?.code === LIMIT_EXCEEDED);
  // The lock hold: everything stays queued and nothing is claimable.
  controller.setLocked(true);
  check('the lock hold: queued, head hidden, nothing claimable', controller.getSnapshot().head === null && controller.begin(controller.queue[0].key) === null && controller.queue.length === MAX_WAITING_PER_ORIGIN);
  controller.setLocked(false);
  check('…and after unlock the first request is the head again', controller.getSnapshot().head?.key === controller.queue[0].key);
  for (const item of [...controller.queue]) await controller.decline(item.key);
  const answers = await Promise.all(waiting.slice(0, MAX_WAITING_PER_ORIGIN));
  check('declines reach every waiting page request (4001)', answers.every((e) => e?.code === 4001));
}
// Read proxy through the bridge.
{
  const n = (await page.request('eth_blockNumber'));
  check('a listed read is proxied to the wallet\'s endpoint', n === '0x99' && reads.at(-1)[0] === 'eth_blockNumber');
  const before = reads.length;
  const bad = await rejection(page.request('eth_getLogs', [{ fromBlock: '0x0', toBlock: 'latest' }]));
  check('an unbounded eth_getLogs is refused before any request (-32602)', bad?.code === -32602 && reads.length === before);
  clock += 5_000;
  const results = [];
  for (let i = 0; i < 12; i += 1) results.push(await rejection(page.request('eth_blockNumber')));
  const limited = results.filter((e) => e?.code === LIMIT_EXCEEDED).length;
  check('the read rate limit applies per origin (10 per second)', limited === 2 && reads.length === before + 10, `${limited}`);
  clock += 2_000;
  const releases = [];
  readImpl = () => new Promise((r) => releases.push(() => r({ result: '0x99' })));
  const concurrent = Array.from({ length: 6 }, () => rejection(page.request('eth_blockNumber')));
  await settle();
  readImpl = async (method) => ({ result: method === 'eth_blockNumber' ? '0x99' : null });
  const inFlight = releases.length;
  releases.forEach((r) => r());
  const settledAll = await Promise.all(concurrent);
  check('at most 4 reads in flight per origin; the 5th and 6th get -32005',
    inFlight === READ_RATE_LIMITS.inFlight && settledAll.filter((e) => e?.code === LIMIT_EXCEEDED).length === 2 && settledAll.filter((e) => e === null).length === 4);
  clock += 2_000;
  readImpl = async () => { throw new Error('boom https://node.example/KEY'); };
  const failed = await rejection(page.request('eth_blockNumber'));
  check('a failed read gives the page a generic -32603 sentence', failed?.code === -32603 && failed.message === READ_UNAVAILABLE_MESSAGE);
  readImpl = async (method) => ({ result: method === 'eth_blockNumber' ? '0x99' : null });
}
// Account switch: the connection belongs to Account 1.
{
  ctx.address = ACCOUNT_1.address;
  browser.notifyContextChanged();
  await settle();
  check('an account switch emits accountsChanged [] to the page', page.events.at(-1)?.[0] === 'accountsChanged' && page.events.at(-1)[1].length === 0);
  check('eth_accounts is [] for another account', JSON.stringify(await page.request('eth_accounts')) === '[]');
  const e = await rejection(page.request('personal_sign', ['0x01', ACCOUNT_1.address]));
  await settle();
  check('a request after an account switch: the controller declines 5103 → 4100, naming the bound account', e?.code === 4100 && e.message.includes('Account 1') && controller.queue.length === 0);
  ctx.address = ACCOUNT_0.address;
  browser.notifyContextChanged();
}
// Mode change: queued before, approved after.
{
  const signing = page.request('personal_sign', ['0x01', ACCOUNT_0.address]);
  await settle();
  const item = controller.queue[0];
  ctx.activeChain = BASE_SEPOLIA;
  browser.notifyContextChanged();
  await settle();
  check('a mode change emits chainChanged with the new chain id', page.events.some(([n, v]) => n === 'chainChanged' && v === '0x14a34'));
  const claimed = controller.begin(item.key);
  const stale = controller.staleChainError(item);
  controller.release(item.key);
  await controller.decline(item.key, stale);
  const e = await rejection(signing);
  check('a request queued before the mode change is declined (5100 → 4901)', claimed !== null && stale !== null && e?.code === 4901);
  check('eth_chainId follows the active chain', (await page.request('eth_chainId')) === '0x14a34');
  check('eth_accounts is [] on a chain the connection was not approved for', JSON.stringify(await page.request('eth_accounts')) === '[]');
  const after = await rejection(page.request('personal_sign', ['0x01', ACCOUNT_0.address]));
  await settle();
  check('a new request names the connection\'s chain, so the controller declines it with the mode sentence (4901)', after?.code === 4901 && /Sepolia/.test(after.message) && controller.queue.length === 0);
  ctx.activeChain = MAINNET;
  const gated = await rejection(page.request('eth_chainId'));
  check('on mainnet every request is refused (4900) with the readiness sentence', gated?.code === 4900 && gated.message === readinessRefusal('dapp-browser'));
  ctx.activeChain = SEPOLIA;
  browser.notifyContextChanged();
}
// Page navigation and reload withdraw what the old document left waiting.
{
  const waiting = rejection(page.request('personal_sign', ['0x02', ACCOUNT_0.address]));
  await settle();
  check('one request waiting', controller.queue.length === 1);
  const page2 = fakePage({ origin: ENS, nonce: NONCE, chainIdHex: '0xaa36a7', browser });
  browser.attachPage({ origin: ENS, nonce: NONCE, deliver: page2.deliver });
  check('attaching another page withdraws it from the queue, with a notice', controller.queue.length === 0 && /was left or closed/.test(controller.notices[0]?.text ?? ''));
  const late = await Promise.race([waiting, new Promise((r) => setTimeout(() => r('pending'), 50))]);
  check('the old page is not answered (it is gone)', late === 'pending');
  page2.inject();
  await settle();
  check('a different allowlisted origin is not connected', JSON.stringify(await page2.request('eth_accounts')) === '[]');
  const deliveries = [];
  const realDeliver = browser.page.deliver;
  browser.page.deliver = (p) => { deliveries.push(p); realDeliver(p); };
  await browser.handleMessage(`${UNISWAP}/`, msg({ type: 'request', id: 77, method: 'eth_chainId' }));
  await browser.handleMessage(ENS, msg({ type: 'request', id: 78, method: 'eth_chainId' }));
  browser.page.deliver = realDeliver;
  check('messages reported from the previous origin are dropped; the new top origin is served', deliveries.length === 1 && deliveries[0].id === 78);
  // Back to Uniswap, then a reload (a new hello) withdraws the old document's requests.
  const page3 = fakePage({ origin: UNISWAP, nonce: NONCE, chainIdHex: '0xaa36a7', browser });
  browser.attachPage({ origin: UNISWAP, nonce: NONCE, deliver: page3.deliver });
  page3.inject();
  await settle();
  void rejection(page3.request('personal_sign', ['0x03', ACCOUNT_0.address]));
  await settle();
  check('a request from the reloaded page is queued', controller.queue.length === 1);
  const reloaded = fakePage({ origin: UNISWAP, nonce: NONCE, chainIdHex: '0xaa36a7', browser });
  browser.page.deliver = reloaded.deliver;
  reloaded.inject();
  await settle();
  check('a reload (new hello) withdraws the previous document\'s requests', controller.queue.length === 0 && /was reloaded/.test(controller.notices[0]?.text ?? ''));
  check('the new document still sees its connection', JSON.stringify(await reloaded.request('eth_accounts')) === JSON.stringify([ACCOUNT_0.address]));
  page.reloaded = reloaded;
}
// Watch-only (no key): no connection is offered.
{
  const current = page.reloaded;
  ctx.address = null;
  const e = await rejection(current.request('eth_requestAccounts'));
  await settle();
  check('a watch-only account: eth_requestAccounts → 4100, no proposal', e?.code === 4100 && e.message === NO_ACCOUNT_MESSAGE && controller.queue.length === 0);
  ctx.address = ACCOUNT_0.address;
}
// Disconnect from the Connections screen.
{
  const current = page.reloaded;
  current.listen();
  const waiting = rejection(current.request('personal_sign', ['0x04', ACCOUNT_0.address]));
  await settle();
  check('one request waiting before disconnect', controller.queue.length === 1);
  await disconnectWcSession(composite, TOPIC);
  controller.refreshSessions();
  const e = await waiting;
  check('disconnect answers the waiting request (6000 → 4100) and the controller drops it', e?.code === 4100 && controller.queue.length === 0);
  check('the connection is gone from the list and from storage', !controller.sessions.some((s) => s.topic === TOPIC) && (await loadBrowserConnections(store)).length === 0);
  check('the page hears accountsChanged [] and eth_accounts is []', current.events.some(([n, v]) => n === 'accountsChanged' && v.length === 0) && JSON.stringify(await current.request('eth_accounts')) === '[]');
}
// Records: an origin removed from the allowlist is never served.
{
  const s = memoryStore();
  await s.setItem(BROWSER_CONNECTIONS_KEY, JSON.stringify([
    { origin: 'https://evil.example', address: ACCOUNT_0.address, owner: ACCOUNT_0.address, chain: SEPOLIA, namespaces: {}, approvedAt: 1 },
    { origin: UNISWAP, address: ACCOUNT_0.address, owner: ACCOUNT_0.address, chain: SEPOLIA, namespaces: {}, approvedAt: 1 },
    { origin: ENS, address: 'nope', owner: ACCOUNT_0.address, chain: SEPOLIA, namespaces: {}, approvedAt: 1 },
  ]));
  const list = await loadBrowserConnections(s);
  check('stored records for unlisted origins or malformed ones are dropped on load', list.length === 1 && list[0].origin === UNISWAP);
  const b = new BrowserBridgeClient({ getContext: () => ({ address: ACCOUNT_0.address, activeChain: SEPOLIA }), readRpc: async () => ({ result: null }), store: s });
  await b.ready;
  check('the wipe path forgets every browser connection', (await b.forgetAll(), b.connections().length === 0 && (await loadBrowserConnections(s)).length === 0));
}

// ---------------------------------------------------------------------------
console.log('check-browser: live-pass findings — the open page hears disconnects and network changes');
// ---------------------------------------------------------------------------
/**
 * A fresh page on Uniswap, connected for ACCOUNT_0 on Sepolia through the
 * real controller, with its accountsChanged / chainChanged listeners on.
 */
async function connectedLivePage() {
  const live = fakePage({ origin: UNISWAP, nonce: NONCE, chainIdHex: '0xaa36a7', browser });
  browser.attachPage({ origin: UNISWAP, nonce: NONCE, deliver: live.deliver });
  live.inject();
  await settle();
  live.listen();
  const connecting = live.request('eth_requestAccounts');
  await settle();
  const item = controller.queue[0];
  controller.begin(item.key);
  await approveProposal(composite, item.event, ACCOUNT_0.address, SEPOLIA, WC_SUPPORTED_METHODS);
  controller.refreshSessions();
  controller.complete(item.key);
  await connecting;
  await settle();
  return live;
}
/** What WalletConnectContext.disconnect does with a topic (the Connected apps screen and the bar's panel both call it). */
async function contextDisconnect(topic) {
  try { await disconnectWcSession(composite, topic); } catch { /* the context swallows it too */ }
  controller.refreshSessions();
}
const SCREEN_SRC = SCREEN;
const flat = (text) => text.replace(/\s+/g, ' ');
{
  const live = await connectedLivePage();
  const bar = browserBarConnection(browser, UNISWAP);
  check('the bar panel sees the open page as connected for Account 1 on Sepolia', bar.kind === 'served' && bar.address === ACCOUNT_0.address && bar.chain === SEPOLIA && bar.topic === TOPIC);
  const eventsBefore = live.events.length;
  await contextDisconnect(bar.topic);
  await settle();
  const after = live.events.slice(eventsBefore);
  check('Disconnect from the bar: the OPEN page\'s accountsChanged listener fires with no accounts',
    after.length === 1 && after[0][0] === 'accountsChanged' && Array.isArray(after[0][1]) && after[0][1].length === 0, JSON.stringify(after));
  check('…the page stays attached (still live), eth_accounts is [] and the panel shows "none"',
    browser.page?.nonce === NONCE && JSON.stringify(await live.request('eth_accounts')) === '[]' && browserBarConnection(browser, UNISWAP).kind === 'none');
  check('…and the "Connected apps" notice names the site', controller.notices[0]?.text === 'app.uniswap.org disconnected.');
  check('the bar panel\'s Disconnect calls the context\'s disconnect with the page\'s browser topic, after a confirmation',
    /Alert\.alert\('Disconnect\?', `End the connection with \$\{host\}\?`[\s\S]{0,400}onPress: \(\) => void disconnect\(browserTopicFor\(origin\)\)/.test(SCREEN_SRC) &&
      /onPress=\{\(\) => confirmDisconnect\(topOrigin\)\}/.test(SCREEN_SRC));
  const ctxSrc = readFileSync(join(SRC, 'wallet', 'WalletConnectContext.tsx'), 'utf8');
  check('…and that disconnect is the Connected apps screen\'s path (disconnectWcSession on the composite client, then a refresh)',
    /const disconnect = useCallback\(\s*async \(topic: string\) => \{[\s\S]{0,300}await disconnectWcSession\(composite, topic\);[\s\S]{0,200}controller\.refreshSessions\(\);/.test(ctxSrc));
  check('the bar has a Connection button that opens the panel in place (no navigation)',
    /title="Connection"[\s\S]{0,200}onPress=\{\(\) => setPanelOpen\(\(open\) => !open\)\}/.test(SCREEN_SRC) && /\{panelOpen \? \(/.test(SCREEN_SRC));

  // A network change made in Settings while the page stays mounted below it.
  const live2 = await connectedLivePage();
  const mark = live2.events.length;
  const deliveries = [];
  const realDeliver = browser.page.deliver;
  browser.page.deliver = (p) => { deliveries.push(p); realDeliver(p); };
  ctx.activeChain = BASE_SEPOLIA;
  browser.notifyContextChanged(); // SiteView's effect on evmChain.caip2 (runs while Settings is on top)
  await settle();
  const changed = live2.events.slice(mark);
  check('a mode change while the page is mounted: chainChanged with the new chain, then accountsChanged []',
    changed.length === 2 && changed[0][0] === 'chainChanged' && changed[0][1] === '0x14a34' && changed[1][0] === 'accountsChanged' && changed[1][1].length === 0, JSON.stringify(changed));
  check('…the panel then shows the stored Sepolia connection as not used here', browserBarConnection(browser, UNISWAP).kind === 'elsewhere' && browserBarConnection(browser, UNISWAP).chain === SEPOLIA);
  browser.notifyContextChanged(); // the focus effect on return
  await settle();
  check('…the repeat on return sends nothing more (only differences are sent)', live2.events.length === mark + 2 && deliveries.length === 2);
  check('…and the page reads the new chain', (await live2.request('eth_chainId')) === '0x14a34');
  ctx.activeChain = SEPOLIA;
  browser.notifyContextChanged();
  await settle();
  const back = live2.events.slice(mark + 2);
  check('switching back: chainChanged 0xaa36a7 and the connection is served again',
    back.length === 2 && back[0][1] === '0xaa36a7' && back[1][0] === 'accountsChanged' && back[1][1][0] === ACCOUNT_0.address && browserBarConnection(browser, UNISWAP).kind === 'served');
  browser.page.deliver = realDeliver;
  // Mainnet: the readiness card replaces the page (SiteView unmounts and detaches); nothing reaches it afterwards.
  ctx.activeChain = MAINNET;
  check('mainnet: the screen\'s gate is non-null, so the page is closed (the design\'s decline)', readinessGate('dapp-browser', MAINNET) !== null);
  const beforeMainnet = live2.events.length;
  browser.detachPage();
  browser.notifyContextChanged();
  await settle();
  check('…a detached page receives nothing', live2.events.length === beforeMainnet);
  ctx.activeChain = SEPOLIA;
  check('the screen tells the page on a mode change AND again on focus',
    /useEffect\(\(\) => \{\s*browser\.notifyContextChanged\(\);\s*\}, \[browser, evmChain\.caip2, activeAccount\?\.index\]\);/.test(SCREEN_SRC) &&
      /useFocusEffect\(\s*useCallback\(\(\) => \{[\s\S]{0,400}browser\.notifyContextChanged\(\);\s*\}, \[browser, firstDecision\.kind, blocked, nonce, attach\]\),/.test(SCREEN_SRC));
  check('a page that lost the bridge to another Apps page is attached again and reloaded on focus',
    /if \(firstDecision\.kind === 'allow' && !blocked && top && browser\.page\?\.nonce !== nonce\) \{\s*attach\(top\);\s*webView\.current\?\.reload\(\);/.test(SCREEN_SRC));
  check('the panel offers Settings and the Connected apps list by PUSHING them (the page stays mounted below)',
    SCREEN_SRC.includes("onPress={() => navigation.navigate('Settings')}") && SCREEN_SRC.includes("onPress={() => navigation.navigate('Connections')}"));
  const routerSrc = readFileSync(join(HERE, '..', 'node_modules', '@react-navigation', 'routers', 'src', 'StackRouter.tsx'), 'utf8');
  check('React Navigation 7 navigate() reuses only the CURRENT route unless pop is set (installed StackRouter), so it pushes Settings above Apps',
    /\/\/ If the route matches the current one, then navigate to it\s*if \(action\.payload\.name === currentRoute\.name\) \{\s*route = currentRoute;\s*\} else if \(action\.payload\.pop\) \{/.test(routerSrc));
  const appSrc = readFileSync(join(HERE, '..', 'App.tsx'), 'utf8');
  check('no screen freezing is enabled in the app (inactive screens keep running effects)', !/enableFreeze\(|freezeOnBlur\s*[:=]/.test(appSrc) && !/enableFreeze\(|freezeOnBlur\s*[:=]/.test(SCREEN_SRC) && !/enableFreeze\(/.test(readFileSync(join(HERE, '..', 'index.ts'), 'utf8')));
  check('the panel\'s network sentence says what a switch does to the open page',
    /export function browserNetworkNote\(chainLabel: string\): string \{/.test(SCREEN_SRC) &&
      flat(SCREEN_SRC).includes("'another test network the page is told about the new network, and its connection is not used there until ' + 'it connects on that network. Switching to mainnet closes the page, because Apps works on test networks only.'"));
  await contextDisconnect(TOPIC);
}

// Mutation: the bridge's disconnect no longer tells the page.
{
  const run = async (Client) => {
    const b = new Client({ getContext: () => ({ address: ACCOUNT_0.address, activeChain: SEPOLIA }), readRpc: async () => ({ result: null }) });
    b.records.set(UNISWAP, { origin: UNISWAP, address: ACCOUNT_0.address, owner: ACCOUNT_0.address, chain: SEPOLIA, namespaces: { eip155: { methods: ['personal_sign'] } }, approvedAt: 1 });
    const p = fakePage({ origin: UNISWAP, nonce: NONCE, chainIdHex: '0xaa36a7', browser: b });
    b.attachPage({ origin: UNISWAP, nonce: NONCE, deliver: p.deliver });
    p.inject();
    await settle();
    p.listen();
    await b.disconnectSession({ topic: browserTopicFor(UNISWAP), reason: WC_ERRORS.userDisconnected });
    await settle();
    return p.events.some(([n, v]) => n === 'accountsChanged' && v.length === 0);
  };
  const m = await importMutant('wallet/browser-bridge.ts', "this.emitEvent('session_delete', { id: 0, topic: args.topic });\n    this.notifyContextChanged();", "this.emitEvent('session_delete', { id: 0, topic: args.topic });");
  check('the real bridge: a disconnect reaches the open page', await run(BrowserBridgeClient));
  check('mutant caught: a disconnect that does not reach the page', !(await run(m.BrowserBridgeClient)));
}

// ---------------------------------------------------------------------------
console.log('check-browser: live-pass findings — the lock, the notice, the titles');
// ---------------------------------------------------------------------------
{
  // The lock hold at the bridge: nothing that needs an approval is answered while locked.
  const live = await connectedLivePage();
  const delivered = [];
  const realDeliver = browser.page.deliver;
  browser.page.deliver = (p) => { delivered.push(p); realDeliver(p); };
  controller.setLocked(true);
  const signing = rejection(live.request('personal_sign', ['0x05', ACCOUNT_0.address]));
  await settle(20);
  const signingId = JSON.parse(live.posted.at(-1)).id;
  check('locked: the signing request is queued, the sheet has no head and nothing can claim it',
    controller.queue.length === 1 && controller.getSnapshot().head === null && controller.begin(controller.queue[0].key) === null);
  check('locked: NOTHING is delivered to the page for that request', !delivered.some((p) => p.type === 'response' && p.id === signingId) && delivered.every((p) => p.id !== signingId));
  const readWhileLocked = await live.request('eth_blockNumber');
  check('locked: reads and local methods are still answered (the bridge does not consult the lock; they need no approval)', readWhileLocked === '0x99');
  controller.setLocked(false);
  const head = controller.getSnapshot().head;
  check('unlocked: the same request is the head again', head?.key === controller.queue[0]?.key);
  await controller.decline(head.key, WC_ERRORS.userRejected);
  const e = await signing;
  check('…and only an answer given after the unlock reaches the page (4001)', e?.code === 4001);
  browser.page.deliver = realDeliver;
  await contextDisconnect(TOPIC);

  // The screen under the lock (source): kept mounted, hidden from everything.
  const hidesWhileLocked = (src) =>
    /const \{ locked \} = useAppLock\(\);/.test(src) &&
    /<View style=\{\[locked \? styles\.hiddenWhileLocked : styles\.fill, \{ backgroundColor: theme\.background \}\]\}>/.test(src) &&
    /hiddenWhileLocked: \{ flex: 1, display: 'none' \}/.test(src) &&
    /importantForAccessibility=\{locked \? 'no-hide-descendants' : 'auto'\}\s*accessibilityElementsHidden=\{locked\}\s*style=\{styles\.fill\}/.test(src) &&
    // Kept mounted: the web view is never rendered conditionally on the lock.
    !/locked[^\n]*\n[^\n]*<WebView\n/.test(src) && !/locked[^\n]*<WebView\n/.test(src) && (src.match(/<WebView\n/g) ?? []).length === 1;
  check('BrowserScreen reads the lock state and hides the whole page (display none) while locked, without unmounting the web view', hidesWhileLocked(SCREEN_SRC));
  const noHide = SCREEN_SRC.replace('locked ? styles.hiddenWhileLocked : styles.fill, { backgroundColor', 'styles.fill, { backgroundColor');
  check('mutant caught: the lock hide removed from the page', noHide !== SCREEN_SRC && !hidesWhileLocked(noHide));
  const unmounting = SCREEN_SRC.replace('      ) : (\n        <WebView', '      ) : locked ? null : (\n        <WebView');
  check('mutant caught: unmounting the web view under the lock (it would withdraw the waiting requests)', unmounting !== SCREEN_SRC && !hidesWhileLocked(unmounting));

  // The notice: inline below the bar on the Apps page, floating elsewhere.
  const ctxSrc = readFileSync(join(SRC, 'wallet', 'WalletConnectContext.tsx'), 'utf8');
  const noticeInline = (screen, context) =>
    /useFocusEffect\(useCallback\(\(\) => claimInlineNotices\(\), \[claimInlineNotices\]\)\);/.test(screen) &&
    /<ConnectedAppsNotice text=\{visibleNotice\.text\} onDismiss=\{dismissVisibleNotice\} placement="inline" \/>/.test(screen) &&
    screen.indexOf('placement="inline"') > screen.indexOf('title="Close"') && screen.indexOf('placement="inline"') < screen.indexOf('<WebView\n') &&
    /\{visibleNotice && inlineNoticeClaims === 0 \? \(\s*<ConnectedAppsNotice text=\{visibleNotice\.text\} onDismiss=\{dismissVisibleNotice\} placement="floating" \/>/.test(context);
  check('the notice is drawn below the bar on the focused Apps page and floats only when no screen claims it', noticeInline(SCREEN_SRC, ctxSrc));
  const unclaimed = SCREEN_SRC.replace('useFocusEffect(useCallback(() => claimInlineNotices(), [claimInlineNotices]));', '');
  check('mutant caught: the Apps page no longer claims the notice (it would float over the bar again)', unclaimed !== SCREEN_SRC && !noticeInline(unclaimed, ctxSrc));
  const alwaysFloating = ctxSrc.replace('visibleNotice && inlineNoticeClaims === 0 ?', 'visibleNotice ?');
  check('mutant caught: the floating notice drawn even while claimed', alwaysFloating !== ctxSrc && !noticeInline(SCREEN_SRC, alwaysFloating));
  check('the floating notice keeps its place on every other screen (absolute, top 56)', /notice: \{\s*position: 'absolute',\s*top: 56,/.test(ctxSrc));
  check('the claim is released on blur and unmount, at most once', /return \(\) => \{\s*if \(released\) return;\s*released = true;\s*setInlineNoticeClaims\(\(n\) => Math\.max\(0, n - 1\)\);/.test(ctxSrc));

  // Titles and copy.
  const conn = readFileSync(join(SRC, 'screens', 'ConnectionsScreen.tsx'), 'utf8');
  check('the Connections screen is titled "Connected apps", set before the first paint',
    conn.includes("export const CONNECTIONS_SCREEN_TITLE = 'Connected apps';") && /useLayoutEffect\(\(\) => \{\s*navigation\.setOptions\(\{ title: CONNECTIONS_SCREEN_TITLE \}\);\s*\}, \[navigation\]\);/.test(conn));
  check('its sections keep their own headings: "In-app browser connections" and the WalletConnect ones',
    conn.includes('>In-app browser connections</Text>') && conn.includes('>Connect a dApp with WalletConnect</Text>') &&
      conn.includes('>WalletConnect connections</Text>') && conn.includes('>WalletConnect is off</Text>') && !conn.includes('>Active connections</Text>'));
  const settings = flat(readFileSync(join(SRC, 'screens', 'SettingsScreen.tsx'), 'utf8'));
  check('the Settings Apps blurb names the real buttons and the screen',
    settings.includes('Their connections are listed on the Connected apps screen (the &quot;Open connections&quot; button in the WalletConnect section above, or &quot;Manage connections&quot; in Apps), and a site that is open can be disconnected from the Connection button on its browser bar.') &&
      !settings.includes('listed and disconnected under Open connections'));
  check('…and those buttons exist: Settings "Open connections" → Connections, Apps "Manage connections" → Connections, the bar\'s "Connection"',
    /title="Open connections" variant="secondary" onPress=\{\(\) => navigation\.navigate\('Connections'\)\}/.test(settings) &&
      SCREEN_SRC.includes(`<Button title="Manage connections" variant="secondary" onPress={() => navigation.navigate('Connections')} />`) &&
      SCREEN_SRC.includes('title="Connection"'));
}

// ---------------------------------------------------------------------------
console.log('check-browser: the composite client keeps WalletConnect and the browser apart');
// ---------------------------------------------------------------------------
{
  const listeners = new Map();
  const calls = [];
  const kit = {
    pair: async () => calls.push('pair'),
    approveSession: async (a) => calls.push(['approve', a.id]),
    rejectSession: async (a) => calls.push(['reject', a.id]),
    respondSessionRequest: async (a) => calls.push(['respond', a.topic]),
    disconnectSession: async (a) => calls.push(['disconnect', a.topic]),
    getActiveSessions: () => ({ abc123: { topic: 'abc123', peer: { metadata: { name: 'Remote dApp', url: 'https://remote.example' } }, namespaces: { eip155: { accounts: [`${SEPOLIA}:${ACCOUNT_0.address}`], methods: ['personal_sign'] } } }, 'browser:https://app.uniswap.org': { forged: true } }),
    on: (e, l) => { listeners.set(e, [...(listeners.get(e) ?? []), l]); },
    off: () => undefined,
  };
  const b = new BrowserBridgeClient({ getContext: () => ({ ...ctx }), readRpc: async () => ({ result: null }) });
  const c = new CompositeWcClient(b);
  const ctl = new WcController(c, () => ({ address: ACCOUNT_0.address, activeChain: SEPOLIA }), {});
  ctl.attach();
  check('before WalletKit starts, pairing says so', await rejection(c.pair({ uri: 'wc:x' })) instanceof Error);
  c.setWalletClient(kit);
  check('the controller\'s listeners are attached to WalletKit when it starts (browser-only events are not)', ['session_proposal', 'session_request', 'session_delete', 'session_request_expire', 'proposal_expire'].every((e) => listeners.has(e)) && !listeners.has('browser_requests_withdrawn'));
  const sessions = c.getActiveSessions();
  check('WalletKit cannot inject a browser: topic; its own sessions are merged', sessions.abc123 && !sessions['browser:https://app.uniswap.org']);
  // A WalletKit event that claims a browser origin: the field is stripped.
  ctl.refreshSessions();
  for (const l of listeners.get('session_request')) l({ id: 12345, topic: 'abc123', params: { chainId: SEPOLIA, request: { method: 'personal_sign', params: ['0x01', ACCOUNT_0.address] } }, browserOrigin: UNISWAP });
  await settle();
  const item = ctl.queue.find((i) => i.key === 'r:12345');
  check('a WalletConnect request never borrows the browser identity', item && item.identity.status === 'unverified');
  for (const l of listeners.get('session_request')) l({ id: 12346, topic: 'browser:https://app.uniswap.org', params: { chainId: SEPOLIA, request: { method: 'personal_sign', params: ['0x01', ACCOUNT_0.address] } } });
  await settle();
  check('a WalletKit event naming a browser topic is dropped', !ctl.queue.some((i) => i.key === 'r:12346'));
  check('stripBrowserFields removes only that field', JSON.stringify(stripBrowserFields({ a: 1, browserOrigin: 'x' })) === '{"a":1}');
  await c.respondSessionRequest({ topic: 'abc123', response: { id: 12345, jsonrpc: '2.0', result: '0x' } });
  await c.approveSession({ id: 777, namespaces: {} });
  await c.disconnectSession({ topic: 'abc123', reason: WC_ERRORS.userDisconnected });
  check('WalletConnect topics and ids are routed to WalletKit', JSON.stringify(calls) === JSON.stringify([['respond', 'abc123'], ['approve', 777], ['disconnect', 'abc123']]));
  const direct = { id: 5, topic: 'abc123', browserOrigin: UNISWAP };
  check('the controller ignores browserOrigin on a positive id / non-browser topic', describeBrowserIdentity(UNISWAP).status === 'browser' && (await (async () => {
    const ctl2 = new WcController(kit, () => ({ address: ACCOUNT_0.address, activeChain: SEPOLIA }), {});
    ctl2.onProposal({ ...direct, params: { proposer: { metadata: { name: 'X', url: 'https://x.example' } } } });
    return ctl2.queue[0].identity.status !== 'browser';
  })()));
}

// ---------------------------------------------------------------------------
console.log('check-browser: source checks');
// ---------------------------------------------------------------------------
{
  const ts = require('typescript');
  const files = ['wallet/browser-bridge.ts', 'wallet/browser-sites.ts', 'wallet/browser-provider-script.ts', 'screens/BrowserScreen.tsx'];
  const forbiddenModules = /(^|\/)(storage|imported-keys|sessions|biometric|passkey-native)(\.tsx?)?$|expo-secure-store|expo-local-authentication/;
  const forbiddenNames = new Set(['signWith', 'signDigest', 'sendEvm', 'sendAa', 'readPhrase', 'importedKeyVault', 'sessionKeyVault', 'DerivedAccount', 'requireLocalAuth', 'signHashAsSmartAccount']);
  for (const f of files) {
    const text = readFileSync(join(SRC, f), 'utf8');
    const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, f.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const imports = [];
    const names = new Set();
    const visit = (n) => {
      if (ts.isImportDeclaration(n)) imports.push(n.moduleSpecifier.text);
      if (ts.isIdentifier(n)) names.add(n.text);
      ts.forEachChild(n, visit);
    };
    visit(sf);
    const badImports = imports.filter((m) => forbiddenModules.test(m));
    const badNames = [...names].filter((x) => forbiddenNames.has(x));
    check(`${f}: imports no key storage, biometric or signing module, and names no signer`, badImports.length === 0 && badNames.length === 0, [...badImports, ...badNames].join());
  }
  const bridge = readFileSync(join(SRC, 'wallet', 'browser-bridge.ts'), 'utf8');
  check('the bridge enforces the readiness row itself (assertFeatureAllowed(\'dapp-browser\'))', bridge.includes("assertFeatureAllowed('dapp-browser', ctx.activeChain)"));
  check('the bridge applies the frame rule before parsing anything', /if \(!page \|\| !acceptsFrameMessage\(reportedUrl, page\.origin\)\) return;\s*const message = parseBridgeMessage/.test(bridge));
}

// ---------------------------------------------------------------------------
console.log('check-browser: mutation checks (the origin comparison and the frame rule)');
// ---------------------------------------------------------------------------
{
  const caught = (name, killed) => check(`mutant caught: ${name}`, killed);
  // 1. Prefix comparison instead of exact equality (the library's B1 bug).
  {
    const m = await importMutant('wallet/browser-sites.ts', 'BROWSER_SITES.find((s) => s.origin === origin)', 'BROWSER_SITES.find((s) => origin.startsWith(s.origin))');
    caught('origin compared by prefix', m.siteForUrl('https://app.uniswap.org.attacker.example') !== null);
  }
  // 2. The user-info test dropped from siteForUrl.
  {
    const m = await importMutant('wallet/browser-sites.ts', "if (!parsed || parsed.scheme !== 'https' || parsed.hadUserinfo) return null;", "if (!parsed || parsed.scheme !== 'https') return null;");
    caught('user-info allowed', m.siteForUrl('https://evil@app.uniswap.org/') !== null);
  }
  // 3. Host case not normalised.
  {
    const m = await importMutant('wallet/browser-sites.ts', 'const host = hostPart.toLowerCase();', 'const host = hostPart;');
    caught('host case kept', m.siteForUrl('https://APP.uniswap.org/') === null);
  }
  // 4. Backslash allowed.
  {
    const m = await importMutant('wallet/browser-sites.ts', 'if (code <= 0x20 || code === 0x7f || code === 0x5c) return null;', 'if (code <= 0x20 || code === 0x7f) return null;');
    caught('backslash accepted', m.parseWebOrigin('https://app.uniswap.org\\@evil.example/') !== null);
  }
  // 5. Default port not removed.
  {
    const m = await importMutant('wallet/browser-sites.ts', "if (port === DEFAULT_PORTS[scheme]) port = '';", '');
    caught('default port kept', m.siteForUrl('https://app.uniswap.org:443/') === null);
  }
  // 6. Frame rule: any allowlisted origin instead of the top one.
  {
    const m = await importMutant('wallet/browser-bridge.ts', "return parsed !== null && parsed.scheme === 'https' && !parsed.hadUserinfo && parsed.origin === topOrigin;", "return parsed !== null && parsed.scheme === 'https' && !parsed.hadUserinfo && isAllowlistedOrigin(parsed.origin);");
    caught('frame rule accepts another allowlisted origin', m.acceptsFrameMessage(ENS, UNISWAP));
  }
  // 7. Frame rule: the allowlist check on the top origin dropped.
  {
    const m = await importMutant('wallet/browser-bridge.ts', 'if (!topOrigin || !isAllowlistedOrigin(topOrigin)) return false;', 'if (!topOrigin) return false;');
    caught('frame rule trusts an off-list top page', m.acceptsFrameMessage('https://evil.example', 'https://evil.example'));
  }
  // 8. Frame rule: host suffix instead of origin equality.
  {
    const m = await importMutant('wallet/browser-bridge.ts', 'parsed.origin === topOrigin;', 'topOrigin.endsWith(parsed.host);');
    caught('frame rule by host suffix', m.acceptsFrameMessage('https://uniswap.org', UNISWAP));
  }
  // 9. The bridge no longer applies the frame rule: an iframe's request is answered.
  {
    const m = await importMutant('wallet/browser-bridge.ts', 'if (!page || !acceptsFrameMessage(reportedUrl, page.origin)) return;', 'if (!page) return;');
    const b = new m.BrowserBridgeClient({ getContext: () => ({ address: ACCOUNT_0.address, activeChain: SEPOLIA }), readRpc: async () => ({ result: null }) });
    const delivered = [];
    b.attachPage({ origin: UNISWAP, nonce: NONCE, deliver: (p) => delivered.push(p) });
    await b.handleMessage('https://widget.example', msg({ type: 'request', id: 1, method: 'eth_chainId' }));
    caught('bridge without the frame rule answers an iframe', delivered.length === 1);
    const real = new BrowserBridgeClient({ getContext: () => ({ address: ACCOUNT_0.address, activeChain: SEPOLIA }), readRpc: async () => ({ result: null }) });
    const realDelivered = [];
    real.attachPage({ origin: UNISWAP, nonce: NONCE, deliver: (p) => realDelivered.push(p) });
    await real.handleMessage('https://widget.example', msg({ type: 'request', id: 1, method: 'eth_chainId' }));
    check('…while the real bridge does not', realDelivered.length === 0);
  }
  // 10. The readiness gate removed: mainnet would be served.
  {
    const m = await importMutant('wallet/browser-bridge.ts', "assertFeatureAllowed('dapp-browser', ctx.activeChain);", '');
    const b = new m.BrowserBridgeClient({ getContext: () => ({ address: ACCOUNT_0.address, activeChain: MAINNET }), readRpc: async () => ({ result: null }) });
    const delivered = [];
    b.attachPage({ origin: UNISWAP, nonce: NONCE, deliver: (p) => delivered.push(p) });
    await b.handleMessage(UNISWAP, msg({ type: 'request', id: 1, method: 'eth_chainId' }));
    caught('readiness gate removed', delivered[0]?.result === '0x1');
  }
}

console.log(`\ncheck-browser: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
