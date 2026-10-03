# Shiba Wallet Privacy Notice (draft)

Status: draft for review, written 2026-10-02 against the code at commit
`619afc2` plus the `app/app.json` changes made with this document. It is
not yet the published privacy policy. Before it can be published, the
Chairperson must supply the publisher's legal name, a contact address and
the public URL where the policy will live (see "Placeholders" at the end),
and counsel should review it. Both app stores require a privacy policy
URL, and Apple also requires a link to it inside the app
(`docs/STORE_LISTING.md`, section 4); the app does not have that link yet.

Shiba Wallet is a non-custodial wallet. That phrase has a concrete meaning
here: the recovery phrase and every private key are created on your phone,
stay on your phone, and are never sent to us or to anyone else. We do not
run a server for the wallet. We do not have user accounts, analytics or
advertising, and we cannot see your balances, your addresses or your
transactions.

A wallet still has to talk to the internet to show balances and send
transactions. This notice lists every service the app contacts, what that
service can learn, and how you can change or turn off each one.

---

## 1. The short version

- **Your keys never leave your phone.** The recovery phrase is stored in
  the phone's secure storage (the iOS Keychain or the Android Keystore
  system) and is never transmitted.
- **We collect nothing.** There is no Shiba Wallet server, no account, no
  analytics, no crash reporting and no advertising in the app.
- **Third parties do see some things.** To read balances and send
  transactions, the app asks public blockchain services, and those
  services see your phone's IP address and the addresses you ask about.
  Blockchain transactions are public by design: anyone can read them on
  the chain itself.
- **You can change most of these services** in Settings, and you can turn
  off fiat prices entirely.

---

## 2. What leaves your phone, and who receives it

Every service below is operated by a third party, not by us. Each one can
see the IP address of your phone (or of your VPN, if you use one) and the
time of each request, in addition to what is listed.

### 2.1 Blockchain network providers (on by default)

To show balances and history, estimate fees, check a transaction before
you sign it, and broadcast it after you approve it, the app sends requests
to public network endpoints. By default it uses these keyless public
services, trying them in order and moving to the next one if one does not
answer:

| Network | Default providers (in order) |
|---|---|
| Ethereum | `ethereum-rpc.publicnode.com`, then `ethereum.publicnode.com` (PublicNode) |
| Ethereum Sepolia (test mode only) | `ethereum-sepolia-rpc.publicnode.com`, `eth-sepolia-testnet.api.pocket.network`, `0xrpc.io`, `public.1rpc.io` |
| Bitcoin | `blockstream.info`, then `mempool.space` |
| Solana | `api.mainnet.solana.com`, `api.mainnet-beta.solana.com`, `solana.publicnode.com` |
| Dogecoin | None. Dogecoin works only after you enter a Blockbook server in Settings |

What these providers receive: every address of yours that the app looks
up (all of your accounts on all four networks, each time balances are
refreshed), the transactions you broadcast, and the transactions the app
asks them to simulate before you approve. Because one phone asks about all
of its addresses from one IP address, a provider can link your Ethereum,
Bitcoin and Solana addresses to each other.

You can replace any default with a provider you choose in **Settings →
Network endpoints**. The app then sends these requests only to your
provider for that network.

### 2.2 WalletConnect (only when you use it)

WalletConnect is how the wallet talks to websites and apps ("dApps"). The
app uses the WalletConnect software development kit published by Reown,
the company that operates the WalletConnect network. The SDK starts when
you open **Connections**; while you have an active connection (or have
just tried to pair), it also starts when the app launches, so dApp
requests can reach you on any screen.

- **The relay** (`relay.walletconnect.org`) carries messages between the
  wallet and the dApp. The messages are end-to-end encrypted by the
  WalletConnect protocol, so the relay sees your IP address, timing and
  the size of messages, but not their content. (We rely on the protocol's
  published design for this; we have not independently audited it.)
- **The dApp** you connect to learns the address and network you approve
  for that connection, and everything you choose to sign or send.
- **The Verify service** (`verify.walletconnect.org`): when a dApp sends a
  request, the SDK may ask this service whether the request really came
  from the website it claims, so the app can warn you about impersonation.
  The service sees your IP address and an identifier for that request.
- **SDK telemetry** (`pulse.walletconnect.org`): the WalletConnect SDK
  sends Reown a startup event containing a random client identifier
  generated by the SDK, the SDK version, the app's WalletConnect project
  id and the app's metadata. The SDK can also report events about
  connection attempts and failures. This is built into the SDK, not
  something we added, and we do not receive this data. We read this
  behaviour from the SDK's source code (WalletConnect Core 2.25.0); see
  "Open items" below.

The app ships with our WalletConnect project id. You can replace it with
your own in **Settings → WalletConnect**.

### 2.3 Prices (on by default, can be turned off)

To show approximate values in US dollars, the app asks CoinGecko
(`api.coingecko.com`) for the prices of the assets you hold. CoinGecko
sees your IP address and which assets are being priced. It does not
receive your addresses or balances.

Turn this off with **Settings → Prices → Show fiat values**. When it is
off, the app makes no request to CoinGecko at all. Assets on test
networks are never priced. If you add an optional CoinGecko key in Settings, the app
sends it only to `api.coingecko.com`.

### 2.4 NFT images and data (only if you set up the NFT gallery)

The NFT gallery is off until you enter an NFT indexer address in
Settings. Once it is on:

- The **NFT indexer you chose** (for example an Alchemy NFT API address)
  receives your address and returns the NFTs it holds.
- **NFT images** are downloaded by the app from wherever the NFT says its
  image lives. For images stored on IPFS, the app uses the public gateway
  `ipfs.io`; for other images, it contacts the image's own web server
  directly. Those servers see your IP address and which images you load.
  An NFT sent to you unsolicited with a unique image address is a known
  way for a stranger to learn a holder's IP address. To limit this, the
  app does not load images for collections the indexer flags as spam, and
  it never displays SVG images.

### 2.5 Services you configure yourself (all optional)

These are off until you enter an address, and in most cases an API key
from a provider you choose, in Settings. Each one sees your IP address,
the addresses it is asked about and the API key, which ties your requests
to your account with that provider.

| Service | What it is used for | What it receives |
|---|---|---|
| Ethereum history indexer | The Activity list for Ethereum | Your address |
| Dogecoin Blockbook server | Dogecoin balances, history and sending | Your Dogecoin address and the transactions you send |
| Swap quotes (0x, `api.0x.org`) | The Swap screen | Your address as the trader, the tokens and the amount |
| ERC-4337 bundler | Smart-account transactions (test networks only today) | Your smart-account address and every operation you send through it |
| Paymaster | Gas sponsorship for smart accounts (test networks only today) | Each operation it is asked to sponsor |

Settings shows these addresses with only the host name visible, so an API
key embedded in an address is not displayed on screen.

### 2.6 Things that happen only when you tap them

- **Block explorer links** (`etherscan.io`, `blockstream.info`,
  `solscan.io`) open in your web browser when you tap a transaction. The
  explorer and your browser then see the transaction you opened.
- **Sharing** a recovery record, an address or a QR code uses the phone's
  share sheet; whatever you share goes where you send it.
- **Copying** an address puts it on the phone's clipboard, where other
  apps may be able to read it. The recovery phrase screen has no copy
  button for this reason.

### 2.7 Passkeys (development builds only, not yet in a released app)

If you add a passkey as a second signer for a smart account, the passkey
is created and held by your phone's own password manager (iCloud Keychain
or your Google account's password manager). Whether those services copy
the passkey to your other devices or your cloud account is decided by the
platform and your settings, not by Shiba Wallet; we have not verified it.

---

## 3. What is stored on your phone

Nothing in this section is sent anywhere by the app.

### 3.1 In secure storage (encrypted by the operating system)

| Item | Notes |
|---|---|
| Your recovery phrase | Stored so that it can only be read while the phone is unlocked and is never copied to a new phone by the operating system's backup or migration. If you turn on biometric protection (section 5), reading it also requires your fingerprint or face |
| Session keys | Only if you grant a dApp a session on a smart account (test networks only today). They follow the same protection as the phrase |
| A small status record and your public addresses | So the app can start without asking for your fingerprint or face. These contain no secrets |

### 3.2 In ordinary app storage (not encrypted by the app)

The following are kept in the app's own storage area. Other apps cannot
read it on a normal phone, but it is not encrypted by Shiba Wallet, so
someone with full control of an unlocked or rooted phone could read it.

- Account names and which account is active
- Preferences: test mode, hide amounts, auto-lock time, fiat values on or
  off
- Contacts you save (names and addresses)
- Tokens you track
- Network, indexer, bundler, paymaster, Blockbook, swap and price
  addresses and API keys you enter in Settings
- WalletConnect connection records. The WalletConnect SDK stores its own
  connection data here as well, including the encryption keys for your
  active connections
- Smart-account settings, session-key records (public parts only), passkey
  public keys, and recovery records for smart accounts with guardians

### 3.3 Backups

On Android, the app turns off the operating system's automatic app-data
backup (`allowBackup` is set to false). Android's documentation notes
that on some phones a direct phone-to-phone transfer may still copy app
data; even then, the secure-storage items are excluded by the secure
storage library's own backup rules, and our reading of Android's rules is
that the app's other data is excluded as well. On iOS, the recovery phrase
is stored with an option under which it is never restored onto a new
device from a backup.
iOS backup of the app's other data is decided by your iPhone's backup
settings and has not been verified for this app.

The practical consequence: **when you move to a new phone, restore the
wallet from your written recovery phrase.** Settings such as contacts,
endpoint addresses and API keys do not come with you. If you use guardians
on a smart account, export its recovery record (Guardians screen) and keep
it somewhere safe, because the account may not be findable from the
phrase alone after an owner change.

---

## 4. What we never collect

- No name, email address, phone number or account of any kind
- No analytics, usage tracking, crash reporting or advertising SDKs (the
  app's dependency list contains none; the WalletConnect SDK's own
  telemetry is described in section 2.2)
- No location, contacts, photos or microphone access. The camera is used
  only to scan QR codes; no picture is saved
- No recovery phrase or private key, ever

Because we hold no data about you, there is nothing for us to delete or
export on request. To remove everything from your phone, use **Settings →
Wipe wallet from this device** or uninstall the app. Data that third-party services keep
about your requests (section 2) is governed by their own privacy
policies; contact them directly. Transactions you broadcast are recorded
on public blockchains permanently and cannot be deleted by anyone.

---

## 5. Biometric protection: the trade-off

You can choose **Settings → Recovery phrase protection → Protect with
biometrics**. After that, your phone's operating system requires a
fingerprint or face match every time the app reads the recovery phrase,
including for every approval.

The protection is stronger, and it has a real cost: if you add or remove a
fingerprint or face, re-enrol Face ID, or turn off the screen lock, the
operating system permanently locks the protected copy, and the only way
back into the wallet is your written recovery phrase. The app explains
this before you switch it on, and it is off unless you choose it.

Without this option, the app still asks for your fingerprint or face
(with your phone's passcode as a fallback) before showing the phrase or
approving a transaction, provided a fingerprint or face is enrolled on
the phone; on a phone without one, there is no prompt. Either way, the
phrase itself is stored without the extra binding.

The fingerprint or face check is performed by the operating system. The
app never sees or stores biometric data.

---

## 6. Your controls

| Control | Where | Effect |
|---|---|---|
| Show fiat values | Settings → Prices | Off: no requests to CoinGecko |
| Hide amounts | Home (eye icon) or Settings | Masks balances on screen. It does not change any network request |
| Network endpoints | Settings → Network endpoints | Replace any default provider with your own |
| WalletConnect project id | Settings → WalletConnect | Use your own Reown project id |
| Disconnect dApps | Connections | Ends a WalletConnect session |
| Optional services | Settings (indexers, Blockbook, bundler, paymaster, swaps) | Off until you enter them; Clear removes them |
| Recovery phrase protection | Settings | Opt in to biometric-bound storage (section 5) |
| Auto-lock | Settings | Locks the app after it has been in the background |
| Wipe wallet from this device | Settings | Deletes the phrase, keys and app data from this phone |

---

## 7. Changes and contact

We will update this notice when the app's behaviour changes, and the
version in the app store listing will always match the released app.

Contact: **[PLACEHOLDER: publisher legal name, postal address and privacy
contact email]**.

---

## Open items (for the project, not for publication)

These must be settled before this draft is published:

1. **WalletConnect telemetry.** `@walletconnect/core` 2.25.0 (installed in
   `app/node_modules`) constructs its event client with
   `telemetryEnabled` defaulting to `true` (`class Se extends We
   {constructor(t,s,i=!0)`), and `@reown/walletkit` 1.6.0 calls
   `eventClient.init()` after initialising the sign client, which posts an
   `INIT` event (client id, user agent, app domain) to
   `https://pulse.walletconnect.org/batch?projectId=…` unless the code
   detects a test run. Further events are stored and sent only when
   telemetry is enabled. `app/src/wallet/walletconnect.ts` creates the core
   with `new Core({ projectId })`, so telemetry is on. Passing
   `telemetryEnabled: false` would stop the batched events but, on our
   reading of the source, not the `INIT` event. Decide whether to pass
   `telemetryEnabled: false` (an app-code change outside this document's
   scope) and confirm the result with a network capture. This was read
   from minified source; it has not been observed on the wire.
2. **No network capture yet.** The statements in section 2 come from the
   code. A capture of a release build's traffic (for example through a
   proxy on a test phone) is the way to confirm that nothing else is
   contacted, including by Expo or React Native libraries.
3. **iOS backup of ordinary app data** (section 3.3) is unverified.
4. **Android phone-to-phone transfer** (section 3.3): the claim that the
   app's ordinary data is excluded rests on Android's documented rule that
   an `<include>` element limits a backup to the files it names
   (developer.android.com/identity/data/autobackup) combined with
   `expo-secure-store`'s `secure_store_data_extraction_rules.xml`, which
   includes only the `sharedpref` domain minus `SecureStore`, while
   AsyncStorage keeps its data in the `RKStorage` SQLite database
   (`ReactDatabaseSupplier.DATABASE_NAME`). Confirm on a device with
   `adb shell bmgr` before relying on it.
5. **In-app privacy policy link.** Apple guideline 5.1.1(i) requires one;
   the app has none yet (app-code follow-up).
6. **Publisher details and URL** (section 7) are inputs from the
   Chairperson.

## Sources (for maintainers)

- Default endpoints: `app/src/config/evm-chain.ts`
  (`MAINNET_RPC_DEFAULTS`, `SEPOLIA_RPC_DEFAULTS`),
  `app/src/config/defaults.ts` (`BITCOIN_ESPLORA_DEFAULTS`,
  `SOLANA_RPC_DEFAULTS`; Dogecoin has no default).
- Prices: `packages/prices/src/coingecko.ts` (base
  `https://api.coingecko.com/api/v3`), `app/src/wallet/prices.ts`
  (`PRICE_CURRENCY = 'usd'`, the key guard), `app/src/config/prefs.ts`
  (`showFiat` default `true`, `hideAmounts` default `false`).
- IPFS and images: `app/src/wallet/nfts.ts` (`IPFS_GATEWAY`, SVG refusal,
  spam handling, in-memory cache).
- Swaps: `packages/chains-evm/src/swap.ts` (`https://api.0x.org`).
- WalletConnect: `app/src/wallet/walletconnect.ts` (`DEFAULT_WC_PROJECT_ID`,
  `initWalletConnect`), `app/src/wallet/WalletConnectContext.tsx` (launch
  start only after first use), `@walletconnect/core` 2.25.0
  `dist/index.js` (relay `wss://relay.walletconnect.org`, Verify
  `https://verify.walletconnect.org`, telemetry
  `https://pulse.walletconnect.org/batch`), `@walletconnect/keyvaluestorage`
  1.1.1 `dist/react-native` (AsyncStorage backend).
- Connectivity: `app/src/wallet/connectivity.ts`
  (`reachabilityShouldRun: () => false`, so NetInfo makes no reachability
  probe).
- Storage inventory: `docs/THREAT_MODEL.md` sections 3.2.1 and 3.4, and
  the `shiba-wallet.*` keys in `app/src`.
- Backups: `app/app.json` (`android.allowBackup: false`),
  docs.expo.dev/versions/v57.0.0/config/app (`allowBackup` "Defaults to
  the Android default, which is `true`"), `@expo/config-plugins` 57.0.9
  `build/android/AllowBackup.js` (`config.android?.allowBackup ?? true`),
  `expo-secure-store` 57.0.4 `plugin/build/withSecureStore.js` and
  `android/src/main/res/xml/*`, docs.expo.dev/versions/v57.0.0/sdk/securestore
  ("Android Auto Backup"; `WHEN_UNLOCKED_THIS_DEVICE_ONLY` "is not migrated
  to a new device when restoring from a backup").
- Biometric protection: `app/src/wallet/storage.ts`,
  `app/src/wallet/phrase-protection-copy.ts`, `docs/THREAT_MODEL.md`
  sections 3.2.2 to 3.2.4.
- Dependencies: `app/package.json` (no analytics or crash-reporting
  packages).
