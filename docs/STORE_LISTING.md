# Store Listing Drafts (App Store and Google Play)

Status: draft, written 2026-10-02 for phase 9 item 3. Nothing here has
been entered into App Store Connect or Play Console, because neither
account exists yet. Every store-policy statement below was checked on the
date shown against the page cited; policies change, so re-read each page
on the day of submission. Privacy answers are derived from
`docs/PRIVACY.md` and must be kept in step with it.

Companion documents: `docs/RELEASE.md` (build and submission procedure),
`docs/PRIVACY.md` (the user-facing privacy notice), `docs/THREAT_MODEL.md`
section 5 (mainnet readiness; W5 is the condition this document serves).

---

## 1. Inputs the Chairperson must provide

| Input | Why it is needed | Where it goes |
|---|---|---|
| Publisher legal name (organization) | Apple guideline 3.1.5(i) allows wallet apps only from developers "enrolled as an organization" (section 2.1). Shown as the seller/developer on both stores | Apple Developer Program enrollment; Play Console developer account |
| Final app name | "Shiba Wallet" is a working title; see the trademark note in section 3.1 | App Store Connect, Play Console, `app/app.json` `expo.name` |
| Privacy policy URL | Required by both stores (section 2.3) | Both consoles, and an in-app link (not built yet) |
| Support URL and contact details | App Store Connect requires a support URL that "must lead to actual contact information (legal address, email address, telephone number)" | App Store Connect; Play Console contact details |
| Distribution countries | Google Play's crypto-wallet country rules (section 2.2) and Apple 3.1.5(iii) for the swap feature depend on where the app is offered | Both consoles |
| Decision on in-app swaps at launch | Swaps route trades through the 0x API; whether that makes the app an "exchange" under either store's rules is a legal question (section 2.4) | Feature flag / readiness table, listing text |
| Export-compliance answer (encryption) | App Store Connect asks every submission; see `docs/RELEASE.md` section 6 | App Store Connect, optionally `ios.config.usesNonExemptEncryption` in `app/app.json` |
| Screenshots and a feature graphic | Not drafted here; they must show only features that work on the network shown (section 3.6) | Both consoles |

---

## 2. Store policies that apply to a crypto wallet

### 2.1 Apple App Store Review Guidelines

Source: https://developer.apple.com/app-store/review/guidelines/ (page
"Last Updated: June 8, 2026", fetched 2026-10-02).

- **3.1.5(i) Wallets** (verbatim): "Apps may facilitate virtual currency
  storage, provided they are offered by developers enrolled as an
  organization." This is the clause that governs Shiba Wallet. It means the
  Apple Developer Program account must be an organization account, not an
  individual one. (The phase 9 brief cited 3.1.5(iii); on the current page
  (iii) is the exchanges clause, which matters for swaps, below.)
- **3.1.5(iii) Exchanges** (verbatim): "Apps may facilitate transactions or
  transmissions of cryptocurrency on an approved exchange, provided they
  are offered only in countries or regions where the app has appropriate
  licensing and permissions to provide a cryptocurrency exchange." Whether
  an in-app swap through a third-party aggregator (0x) falls under this
  clause is for counsel; until answered, consider leaving swaps out of the
  first release or limiting countries.
- **3.1.5(v)** (verbatim): "Cryptocurrency apps may not offer currency for
  completing tasks, such as downloading other apps, encouraging other users
  to download, posting to social networks, etc." The app offers nothing of
  the kind.
- **2.3.7**: app names "must be limited to 30 characters"; metadata must
  not contain "trademarked terms, popular app names, pricing information,
  or other irrelevant phrases"; subtitles must not "reference other apps,
  or make unverifiable product claims".
- **5.1.1(i) Privacy Policies** (verbatim): "All apps must include a link
  to their privacy policy in the App Store Connect metadata field and
  within the app in an easily accessible manner." The in-app link does not
  exist yet (app-code follow-up). The policy must also "Explain its data
  retention/deletion policies and describe how a user can revoke consent
  and/or request deletion of the user's data"; `docs/PRIVACY.md` section 4
  covers this.
- **5.1.1 Account Sign-In**: "If your app doesn't include significant
  account-based features, let people use it without a login." The app has
  no login, so there is no demo account to supply; the review notes in
  section 3.7 explain how a reviewer can exercise the app.
- **2.1(a) App Completeness**: submissions must be "final versions with all
  necessary metadata and fully functional URLs" and "tested on-device for
  bugs and stability". Placeholder URLs in the app (the WalletConnect
  metadata URL `https://shiba-wallet.example`, the passkey placeholder
  domain) must be resolved or the features hidden before submission.
- **2.5.2** (verbatim, first sentence): "Apps should be self-contained in
  their bundles, and may not read or write data outside the designated
  container area, nor may they download, install, or execute code which
  introduces or changes features or functionality of the app, including
  other apps." Relevant if over-the-air updates are ever adopted
  (`docs/RELEASE.md` section 8).

### 2.2 Google Play

Sources (fetched 2026-10-02):
"Blockchain-based Content" policy,
https://support.google.com/googleplay/android-developer/answer/13607354 ;
"Understanding Google Play's Cryptocurrency Exchanges and Software Wallets
Policy", https://support.google.com/googleplay/android-developer/answer/16329703 .

- **Policy text** (verbatim): "The purchase, holding, or exchange of
  cryptocurrencies should be conducted through certified services in
  regulated jurisdictions." Developers must comply with the regulations of
  each targeted country and "avoid publishing your app where your products
  and services are prohibited".
- **Non-custodial wallets** (verbatim note on the second page):
  "Non-custodial wallets are out of scope of the Cryptocurrency Exchanges
  and Software Wallets policy." Shiba Wallet is non-custodial (keys only on
  the device, no server; `docs/PRIVACY.md`). The country table on that page
  (licensing such as FinCEN registration in the United States, FCA
  registration in the United Kingdom, MiCA authorisation in the EU)
  therefore should not apply to the wallet itself. **Unverified:** how the
  Play Console "Financial features" declaration lets a non-custodial wallet
  say so; check the form's options when the account exists, and keep the
  in-app swap question (section 2.4) in view, because the same page lists
  separate requirements for "Cryptocurrency Exchanges".
- **Process** (verbatim): "Under App Content, declare that your app is a
  cryptocurrency exchange and/or software wallet in the Financial Features
  Declaration."
- **Tokenized digital assets** (verbatim): "If your app sells or enables
  users to earn Tokenized Digital Assets, you must declare this via the
  Financial features declaration form". The app neither sells nor rewards
  tokens or NFTs; it only displays and sends assets the user already
  holds. Restate this in the declaration if asked.
- **Cryptomining** (verbatim): "We don't allow apps that mine
  cryptocurrency on devices." The app does not mine.
- **New personal developer accounts**
  (https://support.google.com/googleplay/android-developer/answer/14151465):
  "Developers with personal accounts created after November 13, 2023, must
  run a closed test for their app with a minimum of 12 testers who have
  been opted in continuously for at least 14 days." An organization account
  avoids this; with Apple requiring an organization anyway, register both
  stores as the same organization.

### 2.3 Privacy policy and data disclosures

- App Store Connect "App information" reference
  (https://developer.apple.com/help/app-store-connect/reference/app-information/app-information):
  Privacy Policy URL is "Required for iOS and macOS apps".
- Apple privacy details (https://developer.apple.com/app-store/app-privacy-details/)
  and Google Play Data safety
  (https://support.google.com/googleplay/android-developer/answer/10787469):
  draft answers in section 4.

### 2.4 Open policy questions for counsel

1. Does in-app swapping through the 0x API make the app an "exchange"
   under Apple 3.1.5(iii) or Google Play's exchange rules, in each target
   country?
2. Does Google Play's non-custodial carve-out cover a wallet that also
   offers swaps, WalletConnect transactions and ERC-4337 smart accounts?
3. The French encryption controls Apple's export-compliance page mentions
   ("Secure Storage" is listed as a controlled category) for distribution
   in France.
4. The name: see section 3.1.

---

## 3. Listing text drafts

Character limits, each from the console help pages fetched 2026-10-02:

| Field | Limit | Source |
|---|---|---|
| App Store name | 2–30 characters | App Store Connect "App information" reference (Name) |
| App Store subtitle | 30 characters | same page (Subtitle) |
| App Store promotional text | 170 characters | App Store Connect "Platform version information" reference |
| App Store description | 4,000 characters, plain text | same page |
| App Store keywords | 100 bytes, each keyword longer than two characters; no other apps' or companies' names; no need to repeat the app or company name | same page |
| Google Play app name | 30 characters | Play Console "Create and set up your app" (answer 9859152) |
| Google Play short description | 80 characters | same page |
| Google Play full description | 4,000 characters | same page |

All drafts below are within these limits (counted when written; recount
after any edit).

### 3.1 Name

**Shiba Wallet** (12 characters). This is the working title. Before it is
used on a store: "Shiba Inu" is also the name of a cryptocurrency token
(SHIB) and its ecosystem, and other wallet apps may use similar names.
Apple 2.3.7 bars trademarked terms in metadata, and Google Play's
impersonation policy applies to names that suggest an affiliation. A
trademark search and counsel's sign-off are needed; this document does
not assume the name is clear.

### 3.2 App Store subtitle (30 max)

`Self-custody crypto wallet` (26 characters)

### 3.3 App Store promotional text (170 max)

`Your keys stay on your phone. Send and receive Bitcoin, Ethereum, Solana and Dogecoin, and see what an Ethereum transaction will do before you sign it.` (151 characters; no "safe" claim, because guideline 2.3.7 bars unverifiable product claims)

### 3.4 Short description for Google Play (80 max)

`Self-custody wallet for Bitcoin, Ethereum, Solana and Dogecoin.` (63 characters)

### 3.5 Full description (App Store and Google Play, 4,000 max)

The description must describe only what the released build does on the
networks it shows. Per `app/src/config/readiness.ts` (phase 9 item 6),
smart-account features are enforced testnet-only today, so the draft
mentions them only as a test-network preview. If the release ships before
any of the advisory "blocked" rows are cleared, the Chairperson decides
whether those features ship at all; edit the text to match.

```
Shiba Wallet is a self-custody wallet. Your recovery phrase and private keys are created on your phone and never leave it. There is no account to create, no sign-up and no server that holds your funds.

ONE RECOVERY PHRASE FOR EVERYTHING
A single 12-word recovery phrase backs up every account on every supported network. Write it down once; you can restore the whole wallet on a new phone from it.

SEND AND RECEIVE
- Bitcoin, Ethereum, Solana and Dogecoin from one wallet (Dogecoin needs a Blockbook server you choose).
- ERC-20 tokens such as USDC on Ethereum, and an NFT gallery for ERC-721 and ERC-1155 (needs an NFT indexer you choose).
- Scan and show QR codes for addresses.
- Multiple accounts, each with its own addresses.

SEE BEFORE YOU SIGN
- Before you approve an Ethereum transaction, the wallet simulates it and shows the balance changes it would cause.
- Warnings for unlimited token approvals, first-time recipients and newly deployed contracts.
- A token approvals manager to review and revoke approvals you gave in the past.
- Permit and Permit2 signature requests are summarised in plain language: who could spend what, and until when.

CONNECT TO DAPPS
Connect to decentralised apps with WalletConnect. Every request names the website and shows whether WalletConnect could verify it, and nothing is signed without your approval.

PROTECTION ON YOUR PHONE
- Fingerprint or Face ID before revealing your phrase or approving a transaction.
- Optional biometric protection for the stored recovery phrase.
- Auto-lock, a hide-amounts switch, and contacts with look-alike address warnings.

YOUR DATA
We do not collect any personal data and there are no analytics or ads. To show balances and send transactions, the app talks to public blockchain services, which see your IP address and the addresses you look up; you can replace them with your own providers in Settings. Prices come from CoinGecko and can be turned off. The privacy policy lists every service the app contacts.

TEST-NETWORK PREVIEW: SMART ACCOUNTS
On the Ethereum Sepolia test network you can try account abstraction features: ERC-4337 smart accounts, upgrading your account with EIP-7702, session keys and guardian recovery. These features are not available on mainnet while their audits and reviews are pending.

IMPORTANT
Shiba Wallet cannot recover your funds if you lose your recovery phrase. Blockchain transactions are final. Nothing in this app is financial advice.
```

### 3.6 Keywords (App Store, 100 bytes max)

`bitcoin,ethereum,solana,dogecoin,crypto,wallet,self-custody,nft,usdc,erc20,multichain,seed phrase` (97 bytes)

Notes: App Store Connect says the app name is already searchable, so
"shiba" is left out. "WalletConnect" is omitted because keyword fields may
not contain other companies' names. Whether "USDC" (a Circle product) counts
as a company or product name under that rule is a judgement for review;
drop it if in doubt.

Screenshots: show mainnet screens only for features that work on mainnet
in the submitted build, and label any Sepolia screenshot as a test
network (the app's own TESTNET banner does this). Apple 2.3.7 also says
metadata "should not include prices"; do not show fiat totals that read as
price claims.

### 3.7 Category, age rating and review notes

- **Category:** Finance on both stores (primary). Secondary (App Store):
  none, or Utilities.
- **Age rating:** answered through each store's questionnaire (App Store
  Connect "Age Rating", required; Google Play's content-rating
  questionnaire). Points to answer carefully, without presuming the
  outcome: the app has no user-to-user communication, no web browser and
  no gambling, but it does display third-party content it does not control
  (NFT images and names, dApp names and icons over WalletConnect, token
  symbols), and it lets users move real money. Many wallet listings carry
  an adult rating for the financial-risk reason; this document does not
  assert which rating the questionnaire will produce.
- **Review notes (App Store "App Review Information"; Play "App access"):**
  explain that there is no login; that the reviewer can create a new
  wallet in the app; that Settings → Developer → Sepolia test mode shows
  the test-network features without real funds; that sending needs a
  funded address (offer a Sepolia address funded by the team, never a
  phrase); and that WalletConnect can be tried by pairing with any public
  dApp.

---

## 4. Privacy answers (draft, derived from `docs/PRIVACY.md`)

These are draft answers for counsel. Both stores define "collection" in
ways that do not map cleanly onto a wallet whose data goes only to
third-party infrastructure the user can choose, so each answer below
states its reasoning.

### 4.1 The definitions that decide the answers

- **Google Play** (Data safety, answer 10787469): "'Collect' means
  transmitting data from your app off a user's device", and it includes
  "user data transmitted off device from your app by libraries and/or
  SDKs used in your app". User data "only processed locally on the user's
  device and not sent off device does not need to be disclosed". Data sent
  with "end-to-end encryption does not need to be disclosed". Transfers
  "based on a specific user-initiated action, where the user reasonably
  expects the data to be shared" are an exception to *sharing*.
- **Apple** (App privacy details): "'Collect' refers to transmitting data
  off the device in a way that allows you and/or your third-party partners
  to access it for a period longer than what is necessary to service the
  transmitted request in real time." "'Third-party partners' refers to
  analytics tools, advertising networks, third-party SDKs, or other
  external vendors whose code you've added to your app."

### 4.2 Data flows to classify (from `docs/PRIVACY.md` section 2)

| Flow | Data | Default? | Who | Draft classification |
|---|---|---|---|---|
| Blockchain RPC / Esplora / Solana RPC | Wallet addresses, signed transactions, simulated transactions, IP | On (core function) | Third-party public providers, user-replaceable | Google: transmitted off device, so conservatively **collected** as "Financial info → Other financial info" (addresses and the holdings they reveal), purpose App functionality, required. Not "shared" in Google's sense if treated as the user-initiated core function; counsel to confirm. Apple: the app sends requests directly to services that are not SDK code added to the app; whether they are "external vendors" whose retention counts is the open question. Conservative answer: Financial Info → Other Financial Info, **not linked** to the user's identity, not used for tracking, purpose App Functionality |
| WalletConnect relay messages | Encrypted dApp messages | Only when used | Reown relay | Google: end-to-end encrypted, so not disclosed. Apple: not readable by Reown, so not collected |
| WalletConnect SDK telemetry | Random client id, SDK version, project id, app metadata; event traces | Only when WalletConnect is used (startup event even if telemetry is disabled, per our reading of the source) | Reown (`pulse.walletconnect.org`) | Google: **collected** by an SDK, "Device or other IDs" (the client id) and possibly "App info and performance → Other app performance data", purpose Analytics. Apple: third-party SDK data, **Identifiers → Device ID** and **Diagnostics → Other Diagnostic Data**, not linked, not tracking. Revisit if the app passes `telemetryEnabled: false` (see `docs/PRIVACY.md` open item 1) |
| WalletConnect Verify | Attestation id per request, IP | When a dApp request arrives | Reown | Same classification as telemetry if counsel considers the id user data; otherwise none |
| dApp connections | Approved address, signed messages, transactions | User-initiated | The dApp the user chose | Google: user-initiated sharing, exempt from the sharing disclosure; Apple: not collected by the app or its partners |
| CoinGecko prices | Which assets are priced, IP | On by default, can be turned off | CoinGecko | No address or balance is sent. The asset list alone is arguably not user data; conservative answer: Google "App activity → Other actions", optional; Apple: Usage Data → Other Usage Data, not linked. Counsel to decide |
| NFT images and IPFS gateway | Image URLs fetched, IP | Only after the user configures an NFT indexer | Image hosts, `ipfs.io` | Requests for public content; no user data in the request beyond the URL. Likely not collection; flag for counsel because a unique image URL can identify a holder |
| User-configured services (indexers, Blockbook, 0x, bundler, paymaster) | Address, API key, operations | Off by default, user-entered | Providers chosen by the user | Same classification as the RPC row, marked optional |
| Camera | Frames for QR scanning | User-initiated | None (processed on device) | Not collected (on-device only) |
| Biometrics | None reach the app | — | Operating system | Not collected |

### 4.3 Draft Google Play Data safety answers

- Does your app collect or share any of the required user data types?
  **Yes** (conservative; RPC requests and the WalletConnect SDK transmit
  data off device).
- Is all of the user data collected by your app encrypted in transit?
  **Yes for every default and built-in endpoint** (all are `https://` or
  `wss://`). Caveat: the Settings screens accept `http://` URLs for
  user-entered endpoints (`docs/THREAT_MODEL.md` section 3.4). Either make
  the setters refuse `http://` before release (app-code follow-up), or
  answer this question with counsel's guidance.
- Do you provide a way for users to request that their data is deleted?
  The developer holds no user data. All data on the phone is removed by
  Settings → Wipe wallet from this device or by uninstalling. Data held by
  third-party providers is under their policies. Answer with counsel; the
  form's options should be checked when the account exists.
- Data types: Financial info → Other financial info (collected, required,
  App functionality); Device or other IDs (collected by the WalletConnect
  SDK, Analytics); optionally App activity → Other actions for prices.
- Shared: none beyond user-initiated dApp actions (exempt).

### 4.4 Draft Apple privacy nutrition label

- **Data Used to Track You:** none.
- **Data Linked to You:** none (the app has no account, name, email or
  other identity to link data to).
- **Data Not Linked to You:** Financial Info → Other Financial Info (App
  Functionality); Identifiers → Device ID and Diagnostics → Other
  Diagnostic Data (WalletConnect SDK, Analytics); optionally Usage Data →
  Other Usage Data (prices).
- The alternative answer, "Data Not Collected", is defensible only if
  counsel agrees that public blockchain providers are not "third-party
  partners" and the WalletConnect telemetry is removed or considered out of
  scope. Do not choose it by default.

### 4.5 iOS privacy manifest

Expo's guide (https://docs.expo.dev/guides/apple-privacy/) says required-
reason API declarations can be added under `ios.privacyManifests` in
`app/app.json`, that Apple does not always parse the manifests inside
static CocoaPods dependencies, and that Apple emails missing reasons after
a TestFlight or App Review submission. Installed packages that ship a
`PrivacyInfo.xcprivacy` (found in `app/node_modules` on 2026-10-02):
`@react-native-async-storage/async-storage`, `expo-application`,
`expo-file-system`, `expo-constants`, and React Native itself. Plan: submit
the first build to TestFlight, then copy any reasons Apple reports into
`ios.privacyManifests`. Nothing was added to `app/app.json` in advance,
because guessing reason codes would be an unverified claim.
