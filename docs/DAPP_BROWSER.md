# In-app dApp browser: design (feature 79)

**Status:** Design only, written 2026-10-09 against repository HEAD `aa5a4a4` for phase 15 item 3 (`AGENTS.md`, "Phase 15 plan"). Nothing here is built. Every external fact was fetched on 2026-10-09 from the source cited beside it (section 8); facts about this repository cite the file they come from. Anything that could not be checked is listed in section 7.

## Summary for leadership

1. **A browser is feasible on Expo SDK 57 and can reuse the wallet's single approval path.** Expo pins `react-native-webview` 13.16.1 for SDK 57 and ships it inside Expo Go. The WalletConnect request queue (`app/src/wallet/wc-controller.ts`) talks to its SDK only through a small structural interface (`WcClient` in `walletconnect.ts`), so a browser bridge can present each website as a synthetic session and feed its requests into the same queue, sheet, `eth_call` gate, balance preview, risk card and biometric prompt. No second signing path is needed.
2. **The browser's real advantage is first-hand origin.** Over WalletConnect the wallet learns where a request came from only through WalletConnect's Verify service, which its own documentation says "is not designed to be bulletproof". Inside the wallet's WebView the web engine reports which page sent each message. That makes the Sign-In with Ethereum domain check exact and removes the self-reported dApp name. It does not make a website honest, and it does not stop a compromised script inside a genuine website.
3. **The library has defaults that are unsafe for a wallet, verified in its source.** Its origin allow-list is a prefix match (`https://app.uniswap.org` also admits `https://app.uniswap.org.attacker.example`); on Android its message bridge is exposed to every frame of every origin and drops the "main frame" flag; on Android a web page gets the camera without any prompt when the app already holds the camera permission, which this wallet does; Android injection at page start is documented as "not 100% reliable"; and links the allow-list rejects are handed to the operating system. Each has a workaround, but several need native changes that Expo Go cannot carry.
4. **Recommendation.** Keep WalletConnect as the primary dApp path. If the Chairperson wants a browser in the prototype, build only the allowlisted-sites slice of section 5, on test networks, enforced by the readiness switchboard. Mainnet use would need a development build with the native fixes and a device test. An open, type-any-URL browser should not be built in this phase.

## 1. What a dApp browser is, and what it must not weaken

### 1.1 The two user journeys

A dApp browser is a web view inside the wallet that loads a decentralized application's website and injects a JavaScript provider so the site can ask for accounts, signatures and transactions. `docs/FEATURE_UNIVERSE.md` describes feature 79 as "a built-in web view with the wallet injected as the provider (per the EIP-1193 provider standard and EIP-6963 multi-wallet discovery), plus a curated discovery page of vetted dApps" (Tier 2, "Medium–High").

| | WalletConnect (built; proven live with Uniswap) | In-app browser |
|---|---|---|
| Where the dApp runs | Another browser, often another device | The wallet's own WebView |
| How it connects | A `wc:` pairing URI; messages through the WalletConnect relay | `window.ethereum` or an EIP-6963 provider; a local native bridge |
| What the wallet knows about the requester | Self-reported name and URL, plus Verify's verdict | The origin of the sending page, from the web engine |
| Network exposure | The relay sees IP and timing | Every site and its third-party scripts see the device |

Wallets ship browsers for the single-phone case: WalletConnect on one phone means switching between a browser and the wallet for every request. Feature 79's text adds that inside the wallet's own browser "batching, sponsorship, and session-key prompts appear natively".

### 1.2 What the threat model requires

`docs/THREAT_MODEL.md` names "the user being shown something misleading" as the remaining large risk. A browser must keep every existing control on the same code path:

- **Identity (T-11, N-06):** each proposal and request carries a `WcDappIdentity`; a mismatch or scam needs the "I understand the risk" switch, re-checked in `WalletConnectContext.tsx` before signing.
- **The sheet's gates (T-12, T-13):** re-quoting on the wallet's RPC with the dApp's gas, fee and nonce ignored; the `eth_call` pre-flight; the `eth_simulateV1` preview; Permit and Permit2 summaries; the risk card.
- **ADR D6 (T-14):** EIP-7702 authorization lists, type `0x4` and authorization-flavoured capabilities or methods are refused in `parseWcRequest`.
- **Account and chain binding (T-17):** a session serves only the account and chain it was approved with.
- **The lock hold (T-08):** while locked, nothing renders or can be claimed (`WcController.setLocked`).
- **Readiness:** `app/src/config/readiness.ts` lists WalletConnect as advisory `blocked` pending live exercise of Verify and the permit summaries; smart-account features are enforced test-network-only.

### 1.3 What first-hand origin buys, and what it does not

Verify's documentation defines VALID as "The domain linked to this request has been verified as this application's domain", based on a domain "verified in our domain registry", and says Verify "is not designed to be bulletproof but to make the impersonation attack harder" [S8]. A browser needs no registry: the web engine tells the native side which origin posted each message (section 2.2 shows where that report is unreliable).

It buys three things. The sheet can name the dApp by the **host of the reported origin**, never by a page title the page controls. The ERC-4361 check becomes exact: the origin "SHOULD be read from a trusted data source such as the browser window", and a wallet "MUST reject the request" when the message's host and the origin differ outside a developer mode [S7]; today `siweOriginFor` falls back to the self-reported metadata URL when Verify is silent. And no relay or project id is involved.

It does not prove a site honest (a phishing site has a perfectly valid origin of its own), it does not help against a compromised script inside a genuine site (its requests carry the genuine origin), and it does not survive the frame-attribution defaults in section 3.3 (B2, B3).

## 2. Mechanics on Expo SDK 57

### 2.1 The WebView component

Expo's SDK 57 module list pins `"react-native-webview": "13.16.1"` [S1]; the Expo Go client's `package.json` on the `sdk-57` branch lists the same version [S2]; Expo's SDK 57 page says "Included in Expo Go" and gives `npx expo install react-native-webview` [S3]. `app/package.json` has no such dependency today. Because the native code ships in Expo Go, a JavaScript-only browser can run on the emulator like the rest of the app; any native change (section 3.3) needs a development build, which needs the Expo account that is still an open input.

### 2.2 How the library injects scripts and passes messages

Read from the npm package `react-native-webview-13.16.1.tgz` and its `v13.16.1` reference documentation [S4]:

| Concern | Android | iOS |
|---|---|---|
| Page to native | With `WEB_MESSAGE_LISTENER`: `addWebMessageListener(webView, "ReactNativeWebView", Set.of("*"), …)`, forwarding `sourceOrigin` but not `isMainFrame`. Without it: `addJavascriptInterface`, reporting `mWebView.getUrl()` (the top page) for every message | `WKScriptMessageHandler` named `ReactNativeWebView`; reports `message.frameInfo.request.URL` (the sender's frame); `isMainFrame` not forwarded |
| Script before content | `evaluateJavascript` from `onPageStarted`; the reference warns "On Android, this may work, but it is not 100% reliable". `addDocumentStartJavaScript` is never used | `WKUserScript` at document start, main frame only by default |
| Native to page | A `MessageEvent` dispatched on the page | `window.dispatchEvent(new MessageEvent('message', …))` |

The androidx documentation on the wildcard the library uses: "If a wildcard `"*"` is provided, it will inject the JavaScript object to all frames … When using a wildcard, the app must treat received messages as untrustworthy and validate any data carefully" [S5]. Android's guidance on bridges adds that the interface object goes "into every frame of the WebView, including iframes" and that "there is no mechanism for the application to verify the origin of the calling frame" [S6]. Apple documents that `add(_:name:)` defines the handler "in the page's main content world" and that `WKScriptMessage.frameInfo` is "The frame that sent the message" [S9]. So on Android's modern path and on iOS the native side learns the **sending frame's** origin; on Android's fallback it learns only the **top page's** URL.

### 2.3 The provider surface

Statuses from `ethereum/EIPs` master `af3a7802` and `ethereum/ERCs` master `f4df3d05` [S7].

| Method | Standard, status | Design answer |
|---|---|---|
| `eth_requestAccounts` | EIP-1102, Stagnant | A connection proposal in the existing queue; resolves with `[address]` only after approval and the biometric gate |
| `eth_accounts` | EIP-1193, Final | `[]` until this origin is connected, then the bound address; never prompts |
| `eth_chainId` | EIP-1193 | The active profile's chain, answered locally |
| `personal_sign`, `eth_signTypedData_v4`, `eth_sendTransaction` | Wallet conventions | Exactly as over WalletConnect: SIWE card, typed-data policy and permit summaries, re-quote, gate, preview, risk card, D6 |
| `wallet_switchEthereumChain` | EIP-3326, Stagnant | Existing `decideSwitchChain`: `null` for the active chain, refusal otherwise; never changes mode |
| `wallet_addEthereumChain` | EIP-3085, Stagnant | Refused (4200); see MetaMask Mobile's advisory on user-added networks [S10] |
| `wallet_getCapabilities`, `wallet_sendCalls`, `wallet_getCallsStatus` | EIP-5792, Final | Smart-account connections only, as today |
| ERC-7715 methods | ERC-7715, Draft | Kernel connections only, as today; not in the first slice |
| `wallet_connect` | ERC-7846, Draft ("a new wallet connection JSON-RPC method focused on extensibility", using ERC-5792's capabilities) | Not offered until it leaves Draft |
| `wallet_requestPermissions` | EIP-2255, Final | Optional later; maps onto the per-origin record |
| `eth_sign`, `eth_signTypedData` v1/v3, `eth_signTransaction`, `eth_sendRawTransaction` | Legacy or raw | Refused (4200), consistent with `WC_SIGNING_METHODS` |
| Read-only calls (`eth_call`, `eth_estimateGas`, `eth_getBalance`, `eth_blockNumber`, receipts, transactions, nonce, code, blocks, fee history, bounded `eth_getLogs`) | EIP-1193 | Proxied to the active endpoint through the existing failover rule, with a per-origin rate limit; anything else refused |

EIP-1193's error table fixes what the page sees: 4001 user rejected, 4100 unauthorized, 4200 unsupported method, 4900 disconnected, 4901 chain disconnected [S7]. The queue answers with WalletConnect codes (5000, 5100, 5101, 5103 per `WC_ERRORS`), so the bridge translates 5000 → 4001, 5100 → 4901, 5101 → 4200, 5103 → 4100; ERC-5792 and ERC-7715 codes pass through.

Proxying reads is new surface: the wallet's RPC provider would see the dApp's reads tied to the user's IP, and the free endpoints' limits would be shared (T-62, T-63). EIP-1193's security section asks that "The Wallet and/or Client rate-limit requests from the Provider" and "validate all data sent from the Provider" [S7].

### 2.4 EIP-6963 discovery

The wallet dispatches `eip6963:announceProvider` with `{ info, provider }` and answers `eip6963:requestProvider` [S7]. `info` needs a UUIDv4, a name, an icon that "MUST be a data URI", and an `rdns` whose DNS part "SHOULD BE an active domain controlled by the Provider". The project has no domain yet (the same open input as the passkey relying-party domain), so the slice would use a placeholder and say so. The standard recommends `Object.freeze` on the announced detail, while noting "difficulties … around web compatibility where pages need to monkey patch the object".

### 2.5 Origin binding and per-origin permissions

- **Origin** is the scheme, host and port of the top-level document, computed by the wallet's own parser.
- A connection is recorded per origin (origin, bound address, chain, time), public data only, beside the existing `shiba-wallet.wc-*` AsyncStorage keys. Before connection, `eth_accounts` is `[]` and signing methods return 4100.
- A message is accepted only if its reported origin **equals** the current top-level origin and that origin is allowlisted; other frames are dropped unanswered. ERC-4361 binds a request from "a cross-origin iframe" to "the origin of the iframe, rather than the origin of the parent" [S7]; serving only the top frame is the simplest safe policy.
- Navigating to another origin declines anything queued from the old one. Disconnect, an account switch (the existing 5103 refusal) and a wallet wipe remove or invalidate records; the wipe also clears the WebView's storage, so the browser does not repeat F-28 (WalletConnect sessions survive a wipe).

### 2.6 Chain policy

The active-chain rule carries over unchanged: connections are approved only on the active profile's chain, `wallet_switchEthereumChain` never switches the wallet, and requests that arrive after a mode change are declined with the existing note. EIP-3326 warns that "If the active chain switches without the user's awareness, a dapp could induce the user to take actions for unintended chains" [S7]. On a mode change the provider emits `chainChanged`, as EIP-1193 requires.

### 2.7 One approval path

`WcController` listens for `session_proposal`, `session_request`, `session_delete` and the expiry events, and reads sessions with `getActiveSessions()`, all on a `WcClient`. A **browser bridge client** implements the same interface:

- `eth_requestAccounts` from origin O becomes a `session_proposal` asking only for the active chain and the browser's methods; the existing `decideProposal` (on `@walletconnect/utils` `buildApprovedNamespaces`, pure JavaScript) builds the namespaces, and the bridge's `approveSession` stores the record and resolves the page's promise.
- Each connected origin appears in `getActiveSessions()` as a synthetic session keyed `browser:<origin>`, with the host as `peer.metadata.name`, the origin as `peer.metadata.url`, and CAIP-10 accounts. `summarizeSessions`, `sessionAddressesOf` and `sessionChainsOf` work unchanged, and Connections lists browser connections beside WalletConnect ones.
- Signing requests become `session_request` events; `respondSessionRequest` settles the page's promise with translated codes.

Three changes to existing files follow, none to signing code. First, `WalletConnectContext.tsx` creates the controller only after WalletKit starts, and WalletKit starts lazily; a composite client routing by topic prefix lets one controller serve both sources from the moment the browser opens. A second controller would mean a second queue and two sheets that could appear together, which is the outcome to avoid. Second, `describeVerifyContext` would label a first-hand origin "Verified by WalletConnect", which would be false; an additive `describeBrowserIdentity(origin)` and a matching branch in `siweOriginFor` and the sheet's `IdentityBanner` are needed. Third, the bridge translates error codes.

## 3. Security

### 3.1 The injected provider is not a security boundary

EIP-1193: "all its properties can be read or overwritten. Therefore, it is best to treat the Provider object as though it is controlled by an adversary" [S7]. The page and the injected shim share one JavaScript world, so the design puts nothing secret in the page and makes the native side the only place decisions are made. The native side acts only on a request it parsed from a bridge message whose origin it checked, and every consequential action goes through the native sheet and the biometric gate. A page that tampers with its own provider only misleads itself; a hostile script in the page can already send anything the page can. Answers to the page are plain `MessageEvent`s the page could also forge (section 2.2); since answers carry no authority, that is acceptable. Request ids and a per-load nonce help an honest page match answers but authenticate nothing; authentication comes only from the platform's origin report, where it is reliable.

### 3.2 Phishing

- **Origin display.** The bar shows scheme and host from the wallet's parser; userinfo (`https://app.uniswap.org@evil.example`) is shown as the real host. The same parser drives the allowlist (B1).
- **Address-bar spoofing** is a known attack on wallet browsers. AlphaWallet's Android issue #2672 (2022-06-22) describes a page that never finished loading so the bar kept a legitimate domain over attacker content, and notes that updating the bar on page-finished events has the same weakness [S11]. The design resets the bar when a navigation starts and refuses every request until the new origin commits; approvals use the message's origin, never the bar.
- **Look-alike domains.** Chromium's IDN policy describes homograph attacks and per-browser punycode rules [S12]. An exact ASCII allowlist sidesteps this; an open browser would need its own IDN policy.
- **TLS.** `https:` only (the app already refuses `http:` endpoints); Android `mixedContentMode` stays at its default, "`never` … WebView will not allow a secure origin to load content from an insecure origin" [S4]; any certificate error stops the load.
- **Safe Browsing.** Android WebViews "verify URLs using Google Safe Browsing", on by default [S13]; iOS `fraudulentWebsiteWarningEnabled` defaults to true [S4]. Both stay on as a backstop.
- **SIWE.** With first-hand origin, ERC-4361's must-reject on host mismatch could become an outright refusal. The first slice keeps today's behaviour (gate behind the risk switch) and leaves the change to the Chairperson.

### 3.3 Library findings the design must work around

| # | Finding (13.16.1 source) | Consequence | Mitigation |
|---|---|---|---|
| B1 | `originWhitelist` is a prefix match: `^` + escaped entry, `*` → `.*`, no end anchor (`WebViewShared.tsx`). Running that code with its `escape-string-regexp` 4.0.0 accepted `https://app.uniswap.org.attacker.example` and `https://app.uniswap.org@evil.example` for the entry `https://app.uniswap.org` | The library's allowlist cannot be the security allowlist | `originWhitelist={['https://*']}` and every decision in `onShouldStartLoadWithRequest` by exact origin. That callback "On Android, is not called on the first load" [S4], so check the first URL before loading |
| B2 | Android bridge on all frames (`Set.of("*")`); `isMainFrame` dropped | An ad or widget iframe can post under its own origin | Accept only messages whose origin equals the top origin; in a development build, pass `isMainFrame` and restrict the listener to allowlisted origins |
| B3 | Android fallback reports `getUrl()` for every frame | An iframe's message is attributed to the top page, defeating B2's check | Development build: refuse to start without `WEB_MESSAGE_LISTENER`. Expo Go: only a heuristic (the androidx object exposes `onmessage` and `addEventListener` [S5]; the fallback object does not) |
| B4 | Android "before content" injection is `evaluateJavascript` at page start | `window.ethereum` may appear after the dApp has looked for it | Rely on EIP-6963 and re-announce on load; development build: `addDocumentStartJavaScript`, which runs "before any of the page's JavaScript code" [S5] |
| B5 | `RNCWebChromeClient.onPermissionRequest` grants `RESOURCE_VIDEO_CAPTURE` at once when the app holds `CAMERA`; no JavaScript hook | The wallet holds the camera permission for QR scanning, so a page could open the camera silently. In a development or store build the microphone is blocked by `blockedPermissions` in `app.json`; in Expo Go, Expo Go's own permissions apply instead | Not fixable from JavaScript on Android (`mediaCapturePermissionGrantType` is iOS-only [S4]); a development build must deny capture natively. In Expo Go it is a stated residual |
| B6 | Navigations failing the allowlist go to `Linking.openURL` | A page can launch other apps or schemes | With B1's setting this branch is never reached; the wallet's handler refuses non-`https:` schemes and opens external links only after a confirmation showing the destination |
| B7 | Android `setDownloadListener` hands downloads to DownloadManager with the site's cookies | Unwanted files; cookie forwarding | Development build: remove the listener. iOS `onFileDownload` is opt-in and is not provided |
| B8 | `setSupportMultipleWindows` must stay `true`: `false` "can expose the application to this vulnerability allowing a malicious iframe to escape into the top layer DOM" [S4] (CVE-2020-6506, GHSA-36j3-xxf7-4pqg, mitigated from 11.0.0 [S10]) | — | Keep the default; handle `onOpenWindow` with the allowlist |

### 3.4 Permissions, files, navigation and leaks

- **Geolocation** is off by default on Android (`geolocationEnabled` false), and `app.json` requests no location permission. **File access** props default to false [S4]; the Android file chooser can offer camera capture (`getPhotoIntent`), which a development build should remove. **Clipboard:** pages can write with ordinary web APIs; read behaviour was not checked.
- **New windows:** `javaScriptCanOpenWindowsAutomatically` defaults to false [S4]; iOS loads a new-window request in the same view when no `onOpenWindow` handler exists, so the design supplies one.
- **App-bound domains (iOS 14+):** WebKit restricts "JavaScript injection, custom style sheets, cookie manipulation, and message handler use" to up to 10 domains in `WKAppBoundDomains` [S14]; the library exposes `limitsNavigationsToAppBoundDomains`. A strong platform-enforced allowlist for a development build; unavailable in Expo Go, whose Info.plist is Expo's.
- **Debugging** stays off: `webviewDebuggingEnabled` defaults to false [S4], as does Apple's `isInspectable` [S9].
- **Leaks:** every site and script sees the device's IP and user agent, and the connected address once connected; the RPC provider sees proxied reads; Android Safe Browsing contacts Google. A 2026 study of 85 Chrome wallet extensions found that "many wallets inject their provider interfaces into cross-origin iframes", enabling passive tracking, and that some "continue to expose previously revoked addresses" [S15]; the top-frame rule, the empty pre-connection `eth_accounts` and real revocation address both. The `incognito` prop "Does not store any data within the lifetime of the WebView" [S4] and is the right default here.

### 3.5 What a mobile WebView does not provide

A desktop extension keeps its privileged code in a separate extension context; EIP-1193 asks that "The Provider and Wallet programs are isolated from each other" [S7]. In a mobile app the bridge, the shim and the page share the page's JavaScript world. WebKit's `WKContentWorld` can "separate your app's web environment from the environment of individual webpages" [S9], but the library does not use it, and a provider the page must call has to be reachable from the page anyway. There is no browser-vendor permission UI; every prompt is the wallet's own. For scale: WalletRadar found 116 vulnerabilities in 70 of 96 browser-based wallets [S16]. Those are extensions; no primary study of mobile in-app dApp browsers was found.

### 3.6 Known attack classes

| Attack class | Primary source | Control in this design |
|---|---|---|
| Address-bar spoofing in a wallet browser | AlphaWallet #2672 [S11] | Bar reset on navigation; requests refused until commit; origin from the message |
| Cross-origin iframe escaping into the top document | CVE-2020-6506 [S10] | `setSupportMultipleWindows` stays `true` |
| Untrusted frames calling a JavaScript bridge | Android bridge guidance [S6]; androidx [S5] | Top-frame exact-origin acceptance; native restriction in a development build |
| Bridge loading untrusted URLs | Google Play Device and Network Abuse [S17] | https only; allowlist; no URLs from intents |
| Signing for an unintended chain via a dApp-added network | MetaMask Mobile GHSA-996m-jhjg-3chr [S10] | No `wallet_addEthereumChain`; fixed profiles; active-chain rule |
| Provider in third-party iframes used for tracking | Wang et al. [S15] | Top frame only; empty `eth_accounts` before connection |
| Drainers and deceptive signatures | `THREAT_MODEL.md` T-12, T-13 | The unchanged sheet, simulation and permit summaries |

## 4. Product decisions for the Chairperson

### 4.1 Is a browser worth its attack surface?

| Option | Users get | New attack surface | Effort |
|---|---|---|---|
| A. WalletConnect only (today) | Any dApp from any browser; proven live | None | None |
| B. Allowlisted browser (section 5) | A short list of vetted dApps inside the wallet | Moderate, bounded by a fixed list of origins | One slice; native patches later |
| C. Open browser | Any URL | Large: phishing, IDN, downloads, tracking, every B-finding at full exposure | Several slices plus a development build |

The prototype exists to demonstrate account abstraction, and feature 79's justification is that a browser is "the showroom for AA". Option B delivers that showroom for the dApps that matter in a demonstration without taking on option C's phishing problem. Option A stays the default and the only mainnet path until section 5.5 is met.

### 4.2 What the app stores say

**Apple App Review Guidelines** ("Last Updated: June 8, 2026") [S18]: 2.5.6, "Apps that browse the web must use the appropriate WebKit framework and WebKit JavaScript", is met because the library uses `WKWebView`. Guideline 4.7 allows "HTML5 and JavaScript mini apps", subject to 4.7.2, "Your app may not extend or expose native platform APIs or technologies to the software without prior permission from Apple", and 4.7.3, "Your app may not share data or privacy permissions to any individual software … without explicit user consent in each instance". Whether a list of dApps counts as "mini apps", and whether an injected wallet provider "exposes native platform APIs", could not be settled from the text; if 4.7 applies, 4.7.4 (an index with universal links) and 4.7.5 (age restriction) add work, and finding B5 runs against 4.7.3. Guideline 3.1.1 lets apps "browse NFT collections owned by others" only without "calls to action that direct customers to purchasing mechanisms other than in-app purchase" outside the United States storefront, so NFT marketplaces should stay off the allowlist. A swap dApp in the browser joins the 3.1.5(iii) exchange question already open for counsel.

**Google Play** [S17]: the Device and Network Abuse policy lists as a violation "a webview with added JavaScript Interface that loads untrusted web content (for example, http:// URL) or unverified URLs obtained from untrusted sources (for example, URLs obtained with untrusted Intents)", while its code-download rule "does not apply to … JavaScript in a webview or browser". An https-only allowlisted browser that never takes URLs from intents stays clear of the first clause; an open browser on the fallback bridge (B3) would be closer to it. The crypto policy page still says "Non-custodial wallets are out of scope".

Neither store's primary text addresses dApp browsers in wallet apps specifically.

### 4.3 Decisions requested

1. Option A, B or C (recommendation: B on test networks, A everywhere else).
2. The allowlist and its owner. Uniswap, already exercised over WalletConnect on Sepolia, is the natural first entry.
3. A readiness row `dapp-browser`, **enforced** test-networks-only rather than advisory, because B2–B7 are unfixed in Expo Go.
4. Whether a SIWE host mismatch in the browser is refused outright (section 3.2).
5. A domain for the EIP-6963 `rdns` (shared with the passkey domain input).

## 5. The smallest safe slice

### 5.1 Scope

**In:** an "Apps" screen with a fixed allowlist and no URL input; a WebView limited to those exact origins; the provider shim with EIP-1193 and EIP-6963; the methods of section 2.3 except ERC-7715, EIP-2255 and ERC-7846; a rate-limited read proxy; connections and requests through the existing queue and sheet; per-origin records on the Connections screen; `incognito`; https only; test networks only.

**Out:** URL entry, user bookmarks, downloads, file upload, ERC-7715 grants, `wallet_connect`, mainnet. External links open in the system browser only after a confirmation.

### 5.2 Files

| File | Change |
|---|---|
| `app/src/wallet/browser-bridge.ts` | New, React-free: message validation, exact origin rules, method table, error translation, read proxy and rate limit, the `WcClient` for `browser:` sessions |
| `app/src/wallet/browser-provider-script.ts` | New: the injected shim as a string (EIP-1193, events, EIP-6963 announce, request ids; no secrets) |
| `app/src/wallet/browser-sites.ts` | New: allowlist of exact https origins and the per-origin store |
| `app/src/screens/BrowserScreen.tsx` | New: site list, WebView with the settings of section 3, origin bar, navigation handling |
| `app/src/wallet/walletconnect.ts` | Additive: `describeBrowserIdentity`; `siweOriginFor` browser branch |
| `app/src/wallet/wc-controller.ts` | Minimal: use the identity a browser event carries |
| `app/src/wallet/WalletConnectContext.tsx` | Composite client; controller available without WalletKit |
| `app/src/components/WcApprovalSheet.tsx`, `app/src/screens/ConnectionsScreen.tsx` | Browser wording and labelled, revocable connections |
| `app/src/config/readiness.ts` | Row `dapp-browser`, test networks only, enforced |
| `app/App.tsx`, `HomeScreen.tsx`, `SettingsScreen.tsx` | Route and links; the route stays outside the watch-only allow list in `watch-only.ts` |
| `app/package.json` | `npx expo install react-native-webview` (13.16.1) |
| `app/scripts/check-browser.mjs`, `scripts/ci/suites.mjs` | New offline suite, registered |
| `docs/THREAT_MODEL.md`, `docs/FEATURE_UNIVERSE.md`, `docs/DEMO.md`, `AGENTS.md` | Updated by the CTO |

### 5.3 Tests (offline, `check-browser.mjs`)

- Origin parsing: userinfo, ports, case, trailing dots, punycode, and the B1 prefix cases rejected; exact matches accepted.
- A message from any origin other than the top origin is dropped unanswered.
- `eth_accounts` is `[]` before connection; signing before connection gives 4100.
- Every method maps to its documented route or code; unknown methods and `wallet_addEthereumChain` give 4200; every WalletConnect code translates.
- The bridge client driven through the real `WcController` with a fake page: proposal approval; SIWE with a matching and a mismatching domain (gate set); a transaction with an authorization list (D6 refusal); an account switch (4100); a mode change (declined, `chainChanged` emitted); the lock hold.
- The read proxy refuses unlisted methods, enforces the rate limit and bounds `eth_getLogs`.
- Navigation: non-https schemes refused without calling `Linking`; off-list destinations refused or confirmed; the first URL checked before load.
- A source check that the browser files never import `signWith` or key storage; mutation checks for the origin comparison and the frame rule.

### 5.4 What must be proven on a device

| Check | Expo Go (emulator) | Development build |
|---|---|---|
| Connect, sign, send and SIWE through the sheet on Sepolia | Yes | Yes |
| Which Android bridge path is active (B3) | Heuristic; record the WebView version | Native check, refuse on fallback |
| A cross-origin iframe's message is dropped | Yes, with a test page on an allowlisted test origin (none exists yet) | Yes, plus native `isMainFrame` |
| A page's camera request (B5) | Expected to be granted silently; recorded as a residual | Must be denied |
| Provider present before the dApp's scripts (B4) | Measured | With document-start injection |
| Bar behaviour on a page that never finishes loading | Yes | Yes |
| Lock hold with a browser request queued | Yes | Yes |
| iOS app-bound domains | Not possible | Yes (Expo account and an iOS device) |

### 5.5 Before any mainnet use

1. A development build with native fixes for B2–B5 and B7, proven on physical Android and iOS devices.
2. The WalletConnect row's open conditions (W11, W12) met, since the browser reuses the same sheet.
3. An allowlist owner and review process.
4. The store questions of section 4.2 answered by counsel.

## 6. Alternatives considered

- **System browser plus WalletConnect deep links.** WebKit notes that Safari View Controller "protects user data from" the hosting app because it runs outside its process [S14]; for the same reason no provider can be injected. This keeps option A's security and only shortens pairing; worth doing independently.
- **A separate browser-only approval UI.** Rejected: it would duplicate the gate, simulation, risk card and D6 refusals, and any divergence would be a vulnerability.
- **Catching `wc:` links inside the browser** and handing them to the existing pairing code. Useful for WalletConnect-only dApps but brings back self-reported identity; possible later.

## 7. What could not be verified

- Whether the emulator image and current phones support `WEB_MESSAGE_LISTENER` (B3), and from which WebView version.
- Whether iframes can call the iOS message handler. Apple's page says the handler is defined "in the page's main content world" and does not say "main frame only"; the library's wrapper script is main-frame-only, but the handler itself was not tested.
- Whether a cross-origin iframe on an allowlisted page can reach the camera through B5 (it depends on the page's Permissions Policy). B5 is from source and was not run. On the emulator Expo Go was granted the camera permission during the phase 4 QR tests (`docs/HISTORY.md`, emulator validation), so the residual is expected there.
- Clipboard read behaviour inside the WebView; the exact user-agent strings; the exact data Safe Browsing sends to Google.
- How Apple applies guideline 4.7 to a wallet's dApp list and whether an injected provider counts under 4.7.2. Neither store has text specific to dApp browsers.
- A primary study or advisory on mobile in-app dApp browsers as a class. A third-party report naming several wallets' browsers as vulnerable to address-bar spoofing appeared in search results but answered HTTP 403, so it is not relied on.
- The androidx documentation was read at the head of `androidx-main`, not at the `androidx.webkit` version the library resolves at build time (`webkitVersion`).
- Whether refusing a SIWE mismatch outright would break any allowlisted dApp's login.

## 8. Sources (all read 2026-10-09)

- **S1** `https://raw.githubusercontent.com/expo/expo/sdk-57/packages/expo/bundledNativeModules.json`: `"react-native-webview": "13.16.1"`.
- **S2** `https://raw.githubusercontent.com/expo/expo/sdk-57/apps/expo-go/package.json`: `"react-native-webview": "13.16.1"`.
- **S3** `https://docs.expo.dev/versions/v57.0.0/sdk/webview/`: "Included in Expo Go".
- **S4** `react-native-webview` 13.16.1 from npm (`android/src/main/java/com/reactnativecommunity/webview/`, `apple/RNCWebViewImpl.m`, `src/WebViewShared.tsx`) and `https://raw.githubusercontent.com/react-native-webview/react-native-webview/v13.16.1/docs/Reference.md`; `escape-string-regexp` 4.0.0 from npm for the B1 test. Quotes as given in the text.
- **S5** `https://raw.githubusercontent.com/androidx/androidx/androidx-main/webkit/webkit/src/main/java/androidx/webkit/WebViewCompat.java` (`addWebMessageListener`, `addDocumentStartJavaScript`).
- **S6** `https://developer.android.com/privacy-and-security/risks/insecure-webview-native-bridges`.
- **S7** `https://raw.githubusercontent.com/ethereum/EIPs/master/EIPS/eip-{1193,6963,3326,3085,2255,1102,5792}.md` (master `af3a7802`); `https://raw.githubusercontent.com/ethereum/ERCs/master/ERCS/erc-{4361,7715,7846}.md` (master `f4df3d05`).
- **S8** `https://docs.walletconnect.com/wallets/web/verify.md`.
- **S9** Apple WebKit documentation via `https://developer.apple.com/tutorials/data/documentation/webkit/`: `wkusercontentcontroller/add(_:name:)`, `wkscriptmessage/frameinfo`, `wkcontentworld`, `wkwebview/isinspectable`.
- **S10** GitHub advisories GHSA-36j3-xxf7-4pqg (`react-native-webview`, CVE-2020-6506: "allows cross-origin iframes to execute arbitrary JavaScript in the top-level document") and GHSA-996m-jhjg-3chr (MetaMask Mobile: a custom network without a chain id "can induce the user to sign transactions for unintended chains").
- **S11** `https://github.com/AlphaWallet/alpha-wallet-android/issues/2672`.
- **S12** `https://chromium.googlesource.com/chromium/src/+/main/docs/idn.md`.
- **S13** `https://developer.android.com/develop/ui/views/layout/webapps/managing-webview`.
- **S14** `https://webkit.org/blog/10882/app-bound-domains/` (2020-06-26).
- **S15** Wang et al., "The Masks We (Think We) Wear", arXiv 2607.06141, `https://arxiv.org/abs/2607.06141`.
- **S16** Xia et al., "WalletRadar", arXiv 2405.04332, `https://arxiv.org/abs/2405.04332`.
- **S17** `https://support.google.com/googleplay/android-developer/answer/9888379` (Device and Network Abuse); `https://support.google.com/googleplay/android-developer/answer/16329703` (cryptocurrency policy).
- **S18** `https://developer.apple.com/app-store/review/guidelines/`.
