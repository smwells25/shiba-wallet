# Selling crypto for fiat from a non-custodial wallet (feature 66)

**Status:** Research only, written on 2026-10-19 for phase 22 item 8 (`AGENTS.md`, "Phase 22 plan"). Every provider page, public API answer and on-chain read cited below was fetched between 05:30 and 06:00 UTC on 2026-10-19 unless a different date is given beside it. Nothing is built. No account was created at any provider, no API key was requested or used, no form was submitted and no funds moved. The only HTTP requests were plain reads of public documentation, of public endpoints that need no key, and of test-network contracts through the keyless RPC endpoints the wallet already uses (`ethereum-sepolia-rpc.publicnode.com`, `base-sepolia-rpc.publicnode.com`, `arbitrum-sepolia-rpc.publicnode.com`, `optimism-sepolia-rpc.publicnode.com`, and `base-rpc.publicnode.com` for one mainnet comparison). Section 12 lists what could not be verified.

**This document is not legal advice.** Where it describes licences, the Travel Rule or store policy, it reports what the providers, Apple and Google say about themselves and their rules, quoted where the wording matters. Whether any of it applies to Shiba Wallet, in which countries, and on what terms, is a question for counsel.

This file is plain technical prose for the Chairperson and for the engineers who would build a slice. The persona and compression rules do not apply to it. Its depth and layout follow `docs/BRIDGING.md`.

## 1. Summary

1. **A non-custodial wallet can offer a sale without ever touching fiat.** In every provider's documented flow the user completes the provider's own identity check and payout details on the provider's page, the provider gives a deposit address for that order, and the wallet's only job is an ordinary transfer of the agreed amount to that address. The provider then pays the user's bank account or card. The wallet already builds, previews and risk-checks exactly that transfer.
2. **The one thing the wallet must trust is the deposit address, and it cannot be pinned.** It changes per order (or, for Coinbase, is an address tied to the user's Coinbase account), and no provider read lets the wallet re-read it independently; it arrives through the provider's widget, an SDK event or a redirect. That channel, not the transfer, is the attack surface.
3. **No provider is keyless in the sense CCTP was.** Every provider needs a partner agreement and at least a publishable key. MoonPay (unsigned URL), Ramp Network and Banxa's referral URL can run without a server of the wallet's own; Transak, Coinbase, Alchemy Pay and Onramper (and MoonPay when an address is pre-filled) need a backend holding a secret, which the wallet does not have today (`docs/PRIVACY.md` section 1).
4. **Some sandboxes accept test-network crypto and pay test fiat, but all need a partner account first.** MoonPay's sandbox documents Sepolia ETH, Bitcoin testnet3, Solana devnet and a test payout card. Transak's staging uses its own test token TRNSK (read on-chain today on all four of the wallet's EVM test networks) and test payout cards. Ramp Network's keyless demo API lists Sepolia ETH, a Ramp test token and Circle's Base Sepolia USDC, which the dev EOA holds. Banxa's and Onramper's sandboxes make no on-chain transfers; Coinbase documents none for selling. So a sale can be rehearsed on the emulator only after the Chairperson obtains sandbox credentials from one provider.
5. **Coverage of the wallet's assets differs.** Ramp Network's and Mercuryo's public lists sell ETH and USDC on Ethereum, Base, Arbitrum and Optimism plus BTC, DOGE and SOL (Mercuryo not USDC on Solana). MoonPay does not sell on Optimism; Transak does not list USDC on Optimism. Coinbase requires the seller to hold a Coinbase account.
6. **Smart accounts work, with cautions.** A sale from a Kernel account is an ERC-20 `transfer` or a value call inside a UserOperation. Token sales show the smart account as sender; for native ETH the visible sender is the bundler, and whether providers credit internal transfers, and where they would refund, is undocumented. A session key cannot be pinned to a provider because the destination changes per order. Gas in USDC would help but is test-networks-only today (F-58).
7. **Recommendation:** Ramp Network first, MoonPay second, Transak third, with a rehearsal on test networks before any mainnet decision; Coinbase, Banxa, Mercuryo, Alchemy Pay and the aggregators later or not at all. The reasons are in section 9. The fiat on-ramp hold does not technically block an off-ramp (every provider offers selling as a separate flow), but the same inputs the phase 13 plan named for the on-ramp ("a vendor account and compliance decisions") are needed here, so in practice a pilot waits on the same decision.

## 2. Sources

| Source | Fetched (2026-10-19 UTC unless stated) | Used for |
|---|---|---|
| MoonPay developer documentation (Markdown export) | `https://dev.moonpay.com/widget/off-ramp/overview.md`, `/widget/off-ramp/quickstart.md`, `/widget/off-ramp/architecture.md`, `/widget/off-ramp/customization/parameters.md`, `/widget/off-ramp/customization/url-signing.md`, `/widget/off-ramp/integration-methods/url.md`, `/widget/off-ramp/integration-methods/sdks/react-native.md`, `/widget/off-ramp/integration-methods/sdks/events.md`, `/widget/on-ramp/integration-methods/sdks/event-properties.md`, `/widget/off-ramp/customization/requote-webhooks.md`, `/widget/sandbox-testing.md`, `/widget/supported-currencies.md`, `/widget/faqs.md`, `/api-reference/widget/getselltransaction.md`, `/api-reference/widget/webhooks/sell-transaction-failed.md`, `/platform/guides/kyc-data-requirements.md` | Flow, parameters, signing, sandbox, refunds, timeouts, confirmations |
| MoonPay public API (no key) | `https://api.moonpay.com/v3/currencies` (05:36:54 UTC, 155 entries), `https://api.moonpay.com/v3/countries` (214 entries) | Sell support per asset and network, limits, test-mode flags, countries |
| MoonPay legal pages | `https://www.moonpay.com/legal/pricing_disclosure`, `https://www.moonpay.com/legal/licenses`, `https://support.moonpay.com/en/articles/388469-travel-rule-faq` (dated February 12, 2026); `https://support.moonpay.com/customers/docs/travel-rule-europe-faq` answered **HTTP 404** | Fees, registrations, Travel Rule |
| Transak documentation | `https://docs.transak.com/products/off-ramp.md`, `/guides/sandbox-credentials.md`, `/guides/how-to-create-a-widget-url-and-test-different-scenarios.md`, `/guides/how-to-create-partner-access-token.md`, `/guides/how-to-use-advanced-query-params.md`, `/guides/track-order-status.md`, `/customization/query-parameters.md`, `/integration/mobile/react-native.md` | Flow, keys, staging, payouts |
| Transak public API (no key) | `https://api.transak.com/api/v2/currencies/crypto-currencies` (143 entries), `/api/v2/currencies/fiat-currencies` (26), `/api/v2/countries` (26) | Assets, payout methods and limits |
| Transak legal and support pages | `https://transak.com/compliance`, `https://transak.com/fees-pricing-calculation`, `https://support.transak.com/en/articles/15644338-…-off-ramp-orders` (dated June 25, 2026) | Registrations, fees, refunds |
| Coinbase Developer Platform documentation | `https://docs.cdp.coinbase.com/onramp/offramp/offramp-overview.md`, `/onramp/offramp/offramp-integration-guide.md`, `/onramp/offramp/generating-quotes.md`, `/onramp/offramp/generating-offramp-url.md`, `/onramp/offramp/one-click-sell-url.md`, `/onramp/offramp/configurations.md`, `/onramp/offramp/transaction-status.md`, `/onramp/security-requirements.md`, `/onramp/introduction/welcome.md`, `/onramp/additional-resources/faq.md`, `/onramp/additional-resources/payment-methods.md`, `/onramp/additional-resources/layer-2-networks.md` | Flow, account requirement, keys, payouts |
| Ramp Network documentation | `https://docs.ramp.network/off-ramp`, `/off-ramp-native-flow/general`, `/off-ramp-native-flow/integration`, `/configuration`, `/getting-started`, `/api-keys`, `/webhooks`, `/testing-environment`, `/tips-tricks`, `/rest-api-v3-reference` | Flow, keys, native flow, demo environment |
| Ramp Network public API (no key) | `https://api.rampnetwork.com/api/host-api/v3/offramp/assets` (91 assets), `/v3/payout-methods`; demo: `https://api.demo.rampnetwork.com/api/host-api/v3/offramp/assets` (13 assets), `/v3/assets`, `/v3/payout-methods`, `/v3/currencies` | Assets, payouts, demo coverage |
| Ramp Network legal and support pages | `https://ramp.network/licenses-and-registrations`, `https://support.ramp.network/en/articles/8957-what-are-the-fees-for-selling-crypto-at-ramp` (dated March 19, 2025), `https://support.ramp.network/en/articles/210113-why-did-my-crypto-sell-transaction-fail` (dated May 31, 2025); `https://rampnetwork.com/licenses` and `https://rampnetwork.com/legal` answered **HTTP 404** | Registrations, fees, refunds |
| Banxa documentation | `https://docs.banxa.com/llms-full.txt` (the full export of the Native API and Hosted Checkout documentation), licence list `https://banxa.com/wp-content/uploads/2026/08/BANXA-_-Global-Website-Licenses-as-of-26.08.2026.pdf`; `https://banxa.com/licenses/` answered **HTTP 403** | Flow, keys, sandbox, payouts, registrations |
| Mercuryo | Public API `https://api.mercuryo.io/v1.6/lib/currencies`; `https://mercuryo.io/legal/licenses/` (version 2.0, 1 July 2026). The documentation sites `https://oor-redirect.redoc.ly` and `https://oor-api.redoc.ly` require a Redocly login; `https://developers.mercuryo.io/` serves an unedited documentation template; `https://help.mercuryo.io/` answered **HTTP 403** | Assets, registrations |
| Alchemy Pay documentation | `https://alchemypay.readme.io/llms.txt`, `/docs/testing-notes.md` (updated 2026-10-12), `/docs/off-ramp-custom-parameters.md` (updated 2026-08-21), `/docs/off-ramp-hiding-receiving-address-page.md` (updated 2026-08-21), `/docs/ramp-signature-description.md`, `/docs/fiat-currency-country-payment-method-coverage-plus-fees-and-limits.md`; `/docs/alchemypay-off-ramp.md` answered **HTTP 404** | Flow, signing, sandbox |
| Sardine | `https://docs.sardine.ai/llms.txt` | Product scope (no off-ramp found) |
| Onramper documentation | `https://docs.onramper.com/llms.txt`, `/docs/supported-widget-parameters-offramp.md`, `/docs/offramp-process-flow.md` (updated 2026-02-23), `/docs/testing-overview.md` (updated 2026-07-08), `/docs/signature-v2.md`; `/docs/sell-widget.md` answered **HTTP 404** | Aggregator flow, sandbox, signing |
| Apple App Store Review Guidelines | `https://developer.apple.com/app-store/review/guidelines/` ("Last Updated: October 16, 2026") | 3.1.5, 5.1.1(ix) |
| Google Play policy | `https://support.google.com/googleplay/android-developer/answer/9876821`, `/answer/13607354`, `/answer/16329703` | Financial services and crypto rules |
| Test-network contracts | `eth_getCode`, `symbol()`, `name()`, `decimals()`, `totalSupply()` at Ethereum Sepolia block 11,946,152–11,946,197, Base Sepolia 48,309,990–48,310,259, Arbitrum Sepolia 320,634,329, OP Sepolia 50,292,863, Base mainnet 52,799,730; Sourcify `https://sourcify.dev/server/v2/contract/<chainId>/<address>` | The sandboxes' test tokens |

The MoonPay documentation pages embed a sandbox widget that carries a test publishable key belonging to MoonPay's own documentation account. It is deliberately not reproduced here and must not be used by this project: a test against someone else's account is not a test of an integration the project controls.

## 3. What a non-custodial wallet can honestly offer

### 3.1 The flow every provider documents

The providers describe the same shape. MoonPay's overview lists the widget steps (amount, "Log in to the widget using multi-factor authentication (MFA)", payout method, KYC "if the user is new to MoonPay", confirm) and then: "Partner app sends crypto on behalf of the user. The deposit must reach MoonPay within 48 hours of the sell transaction being created, or the transaction fails with a `Deposit timeout`." Coinbase: "Use the returned `sell_amount`, `asset`, `network`, and `to_address` to create an onchain send transaction in your App." Ramp Network calls the wallet-side step its Native Flow, "Required: when you're integrating in a native mobile app that can execute the crypto transfer". Banxa recommends its non-custodial variant for "Self-custody wallets where the customer controls their private keys."

For Shiba Wallet the honest offer is therefore:

1. The user chooses an asset and amount in the wallet and taps "Sell".
2. The wallet opens the provider's own page. The provider, not the wallet, collects identity, payout details and consent, and quotes a price.
3. The provider hands back a deposit address, an amount and a network for this order.
4. The wallet shows those values and builds an ordinary transfer: a native send, an ERC-20 `transfer`, a Bitcoin or Dogecoin payment, or a Solana transfer. It goes through the existing confirm screen, simulation preview, risk card, spending limits and device check, exactly as any send does today.
5. The provider detects the deposit, converts it and pays the user. The wallet can show the provider's status if the provider offers a way to read it.

The wallet never holds, routes or sees fiat. It sees an amount, an asset and a destination, which it already sees for every send.

### 3.2 What the wallet can pin and what it must take from the provider

For bridging, the wallet pinned contract addresses and checked every argument it signs (`docs/BRIDGING.md` section 4.4). An off-ramp has nothing comparable to pin. The destination is an externally owned deposit address controlled by the provider, chosen per order:

- MoonPay's redirect appends "the transaction ID, base currency code, base currency amount, deposit wallet address and respective tag" to the partner's URL, and its SDK event `onInitiateDeposit` carries `depositWalletAddress` ("The wallet address where the crypto amount needs to be deposited").
- Transak's `TRANSAK_WALLET_REDIRECTION` event carries `walletAddress` ("Destination wallet address").
- Ramp Network's `SEND_CRYPTO` event carries `address` together with the asset and amount.
- Onramper's wallet-initiation redirect forwards `providerWalletAddress` ("Target wallet address (where the crypto needs to be sent)").
- Coinbase returns `to_address` from its Transaction Status API, which needs the wallet's backend key.

The documented sale-status schemas do not let the wallet re-read the address from an independent source. MoonPay's `GET /v3/sell_transactions/{transactionId}` schema lists the status, the deposit hash and the refund address but no deposit address. Ramp Network's `GET /host-api/offramp/sale/{id}?secret=…` example (the secret is the per-sale view token from the widget event) shows the amount and asset but no address. So whoever controls the channel that delivers the address controls where the funds go. That makes the channel the thing to protect (section 7.2), and it means the confirm screen must state plainly that the address came from the provider's page and cannot be checked by the wallet.

What the wallet can still check, and should:

- The network and asset match what the user chose, the address parses for that network, and the amount equals what the provider quoted. A mismatch is a refusal, not a warning.
- Any memo or tag the provider supplies is carried (MoonPay: "If the deposit wallet address tag is included in the parameters, you must include this with the deposit otherwise the transaction will fail"; Onramper: "Failure to do so will result in no payouts").
- The address is not one of the user's own accounts and not a known contract, using the existing risk card.

### 3.3 The account-abstraction angle

**A sale is a transfer.** From a regular account it is a normal transaction; from a Kernel smart account it is a UserOperation whose single call is an ERC-20 `transfer` or a value call. Nothing provider-specific is needed in the engine.

**Token sales are visible; native sales from a smart account may not be.** An ERC-20 `transfer` emits a `Transfer` event whose `from` is the smart account, which is what deposit monitoring normally watches. A native ETH transfer from a smart account is an internal call whose transaction sender is the bundler; whether providers detect internal transfers is not documented anywhere read. Sepolia's Glamsterdam fork adds an EIP-7708 log for every ETH transfer (`AGENTS.md`, "SEPOLIA FORK FINDINGS RESOLVED"), but its mainnet date is not set. A first smart-account slice should sell USDC, not ETH.

**Refunds go to "the sender", which is ambiguous for a smart account.** MoonPay's FAQ: when "the deposit is invalid due to user error such as wrong token, network, or amount, or if the user cancels the transaction before the deposit is confirmed, the funds will automatically be returned to the sender's address"; only a failure "on MoonPay's side" uses the `refundWalletAddress`. Transak's refund defaults to "Refund to source wallet". Coinbase "validates the onchain send transaction to match `from_address`". If a provider reads the sender of a native transfer as the transaction's `from`, a refund could go to the bundler and a validation could fail. This is unverified and is why a smart-account sale needs its own rehearsal and warning.

**A session key cannot be pinned to a provider.** A CallPolicy can fix a transfer's recipient (`docs/SESSION_KEYS.md`), but a per-order deposit address is unknown in advance, and a key allowed to pay "any address the provider names" could pay anyone. Coinbase's `to_address` may be stable per user (late funds "arrive in the users Coinbase account"; "The address remains valid"), which suggests it is the user's own Coinbase deposit address (an inference); pinning it would only automate transfers to the user's exchange account. Automated selling is not offered.

**Gas in USDC** (feature 16) would let a Kernel account on Base or Arbitrum sell its last USDC with no ETH, but that path is enforced test-networks-only because of F-58 (no published audit of Circle's paymaster; mainnet addresses never read on-chain), so it is a later improvement.

**Ownership proofs need a signature some accounts cannot give.** Providers may ask the user to prove control of the sending address (section 6.2). A regular account can sign a message; a Kernel account can produce an ERC-1271 signature, whose acceptance by these providers is undocumented; a multisig in this wallet cannot sign messages by design (`MULTISIG_ERC1271_REFUSAL`, F-62); a watch-only account cannot send. Selling should be offered from the regular account and, after rehearsal, the Kernel account; never from a multisig or watch-only account.

## 4. The providers

Each subsection gives, in the same order: assets and networks for selling; regions; payouts; fees; integration shape and keys; sandbox; identity data; regulatory status as stated; limits; failures and refunds. "Not found" means the documentation fetched did not say; it does not mean the feature is absent.

### 4.1 MoonPay

**Assets.** The public `v3/currencies` list (no key) marks `isSellSupported: true` for `eth` (Ethereum, minimum 0.00825, maximum 8.5), `usdc` (Ethereum USDC `0xa0b8…eb48`, minimum 19.95261, maximum 10,000), `eth_base` and `usdc_base` (Base USDC `0x8335…2913`), `eth_arbitrum` (maximum 1.6) and `usdc_arbitrum` (`0xaf88…5831`), `btc` (minimum 0.00024, maximum 0.6), `doge` (minimum 252.02546, maximum 50,000) and `sol` and `usdc_sol`. It marks **`eth_optimism` and `usdc_optimism` as `isSellSupported: false`**. The developer page adds that "Availability of Sell [is] subject to further geographic restrictions. Check your account for availability."

**Regions.** `v3/countries` lists 214 countries, 101 with `isSellAllowed: true`, including the United States and the United Kingdom; Canada is `isSellAllowed: false`. For US states the API blocks selling only in the US Virgin Islands, while the developer FAQ says "Sell is **unavailable** for residents of Louisiana, Texas, New York and US Virgin Islands" (a gap, section 11). The currencies list also excludes New York for selling ETH and USDC on Base and Arbitrum.

**Payouts.** The `paymentMethod` parameter lists "credit_debit_card, ach_bank_transfer, gbp_bank_transfer, gbp_open_banking_payment, sepa_bank_transfer, paypal, venmo and moonpay_balance". The FAQ names USD, GBP and EUR payouts; the `quoteCurrencyCode` parameter lists 33 fiat codes (another gap).

**Fees.** The pricing disclosure for MoonPay USA LLC says a referred user's "MoonPay fee will be in an amount up to 4.5%, subject to (a) a minimum MoonPay fee of up to $4.50 if your transaction amount is below a minimum threshold", plus a network fee, a spread, and an "Ecosystem Fee … set by each partner". The FAQ says "MoonPay does not charge any integration fees."

**Integration shape and keys.** A hosted page (`sell.moonpay.com`), a web SDK and a React Native SDK that renders through `react-native-webview` (which carries the widget's events, including `onInitiateDeposit`) or "your own in-app browser implementation" (which "will allow you to use native features like Google Pay, social sign-in and popups"). The `apiKey` is publishable. A secret key is needed only to sign the URL, which is "mandatory if you're using the `walletAddress` or `walletAddresses` parameter" and, for selling, when passing `refundWalletAddress`; the signature is an HMAC-SHA256 of the query string generated "server-side". Without pre-filled addresses no signature is needed, so a wallet with no server can open the sale and the user types the refund address in MoonPay's page. Webhooks need a server; the sell-transaction endpoint takes the publishable key.

**Sandbox** in section 5. **Identity data** is collected by MoonPay on its page (its Customer API lists name, date of birth, nationality, address and phone for every customer, with documents by country); the wallet hands over only what it puts in the URL.

**Regulatory status (licences page).** FCA (MoonPay (UK) Limited, FRN 944746); FinCEN (31000301673327) and FINTRAC (M24701825) for MoonPay USA LLC, with state money transmitter licences including a New York Virtual Currency Business Activity licence; AUSTRAC; the Dutch AFM (MoonPay Europe B.V., 41000002); the Jersey FSC. No audit or certification was found on the pages read.

**Limits.** Per asset, above; "Sell limits will vary by region, currency, and level of Know Your Customer (KYC) documents provided."

**Failures and refunds.** The deposit must arrive within 48 hours. Confirmations required before processing include `eth` 12, `eth_arbitrum` 5, `usdc` 11, `btc` 1 and `sol` 1. A price move before the deposit can trigger `sell_transaction_requote_required`, which the user must accept. Refund routing is quoted in section 3.3.

### 4.2 Transak

**Assets.** The public crypto list's `isPayInAllowed` field (not defined on the pages read; its name and its `minAmountForPayIn` / `maxAmountForPayIn` limits suggest it marks selling, an inference) is `true` for ETH on Ethereum, Base, Arbitrum and Optimism, USDC on Ethereum, Base, Arbitrum and Solana, and BTC, DOGE and SOL. **USDC on Optimism is not listed.** Each entry notes "Cryptocurrency availability varies by state", restricting MN, NY and LA.

**Regions, payouts, fees.** The fiat list marks payouts per currency: USD card payout (10–25,000), GBP bank transfer or card, EUR card (40 countries), cards in about 20 other currencies; none for CAD or HKD. The fees page: "Off-Ramp Fees … Debit or Credit card 0.99%", plus third-party fees. The unauthenticated `countries` endpoint returned only 26 entries, evidently not the full coverage list.

**Integration and keys.** Hosted widget, an Expo SDK (`@transak/ui-expo-sdk`, needing `react-native-webview`, `expo-web-browser` and `@react-native-community/netinfo`) and native SDKs. **A backend holding the API secret is required**: "Passing query parameters directly in the hosted widget URL is deprecated. Use the **Create Widget URL API** from your backend", authenticated by a partner token obtained with the key and secret ("Never expose your API secret in client-side code or public repositories"); each URL "is valid for **5 minutes**" and "can be used only **once**". `walletRedirection=true` hands the deposit to the app through `TRANSAK_WALLET_REDIRECTION`. The mobile guide asks for camera, `RECORD_AUDIO`, location and photo-library permissions, several of which the wallet does not hold. The optional `userData` pre-fill (name, email, phone, date of birth, address) should never be sent by the wallet.

**Regulatory status (compliance page).** Transak Limited and Transak USA LLC "are registered as Money Services Businesses (MSBs) under the Financial Crimes Enforcement Network (FinCEN)" (31000300682483), with state money transmitter licences; Transak Limited is FCA-registered; FINTRAC (C100000155); AUSTRAC (100865469). It claims "ISO 27001 and SOC 2 compliance".

**Failures and refunds.** Off-ramp statuses include `EXPIRED` and `REFUNDED`; a June 2026 support article lets users redirect a refund away from the default "Refund to source wallet", processed "within ⏱️ 48 hours".

### 4.3 Ramp Network

**Assets.** The public off-ramp list (no key, 91 assets) has `enabled: true` for `ETH_ETH`, `ETH_USDC` (`0xa0b8…eb48`), `BASE_ETH`, `BASE_USDC` (`0x8335…2913`), `ARBITRUM_ETH`, `ARBITRUM_USDC` (`0xaf88…5831`), `OPTIMISM_ETH`, `OPTIMISM_USDC` (`0x0b2C…Ff85`), `BTC_BTC`, `DOGE_DOGE`, `SOLANA_SOL` and `SOLANA_USDC`, each with limits of €6.68 to €15,139.19 equivalent at the time read. This is the only provider whose public list covers every asset and network the wallet supports.

**Regions and payouts.** The public payout list: `AMERICAN_BANK_TRANSFER` (USD, United States), `SEPA` (EUR, 35 countries), `PIX` (BRL), `SPEI` (MXN) and `CARD` (about 40 currencies, 119 countries). The getting-started page: "Sell with US Bank Transfer … available to all holders of US bank accounts in supported states", and "receive fiat payout directly to Visa in more than 130 countries and to Mastercard in the UK and EEA".

**Fees.** The support article dated March 19, 2025: ACH, RTP, SEPA and SEPA Instant 0.99% (minimum $1.99 or €1.99), SPEI 2.9% (minimum $1), payout to Visa or Mastercard 4.49% (minimum €1.99), plus the network fee paid from the user's wallet and an optional partner fee. It adds that partners "can access customized pricing options".

**Integration shape and keys.** An SDK or a hosted URL with a `hostApiKey` passed in the clear; no URL signing is documented. Off-ramp needs "a valid production API key and that the off-ramping feature was enabled for your key" ("the widget won't work without an active production API key"). The Native Flow sends `SEND_CRYPTO` (asset, amount, address) to the app, which replies with the transaction hash; without the SDK it needs a `webview-mobile` variant and the app must "handle window post-messages on your own". Webhooks are optional and signed with Ramp's published secp256k1 key; the sale-status endpoint needs only the sale id and its per-sale view token. **Ramp is the one provider whose whole sell flow, status included, is documented to work without a server of the wallet's own.**

**Identity data.** Collected by Ramp; `userAddress` "For off-ramp, will be treated as a source address from which the crypto will be sent from", and `userEmailAddress` is optional.

**Regulatory status (as stated on the licences page).** Ramp Swaps Ltd registered with the FCA (firm reference 928783); Ramp Swaps LLC registered with FinCEN as an MSB (31000287566749) with money transmitter licences in Alabama, Alaska, Arizona, Arkansas, Maryland, New Mexico, Ohio, Oregon, North Dakota and Kentucky; Ramp Swaps (Ireland) Limited "regulated by the Central Bank of Ireland" as an "Authorised Crypto Asset Service Provider".

**Failures and refunds.** The support article dated May 31, 2025: "Most crypto refunds are processed within 24 hours", with exceptions for "Unmatched transfers", "Wrong network" and weekends, where "refunds can take up to 10 business days". Sale webhook types are `CREATED`, `RELEASED` and `EXPIRED`.

### 4.4 Coinbase Onramp and Offramp

**Status of "sell".** Offramp is live but "currently available as a **Coinbase-hosted experience**", and "A Coinbase account with linked bank details is required for Offramp and ACH withdrawals. Guest checkout is not supported for fiat withdrawal." For a self-custody user without a Coinbase account it is a referral to open one.

**Assets.** "Both products support all crypto assets and networks available on Coinbase", including Base, Optimism and Arbitrum; per-country sell options need the keyed Options API (not called). The L2 page lists USDC on Ethereum, Base, Polygon, Solana, Optimism and Avalanche (not Arbitrum) and ETH on Ethereum, Base, Polygon, Avalanche, Optimism and Arbitrum. The guide's mention of DOGE among assets whose `from_address` is not validated implies DOGE can be sold.

**Payouts and fees.** "ACH bank transfers (US)", "PayPal (select countries)", "Coinbase balances"; the payment-methods table also marks `CARD` for "Buy, Sell" (a gap, section 11). The quote returns a `coinbase_fee` (the sample shows 1.50 on 100.00); no selling rate is stated.

**Integration and keys.** A backend is mandatory: "You must create a new session token from your backend for each user session. Tokens are single-use and expire after 5 minutes", using a CDP secret key; the token request carries the user's addresses and `clientIp`. Coinbase asks for CORS, user authentication on that backend and a domain allowlist for `redirectUrl` (custom-scheme deep links allowed). The widget "will not function correctly in a WebView"; Chrome Custom Tabs and `SFSafariViewController` are recommended. Quote APIs allow "10 requests per second per app ID"; new integrations "start in trial mode". No selling sandbox is documented.

**Failures.** "Offramp transactions time out 30 mins after users click the 'Cash out now' button." If the price falls below the "Receive at least" amount, "Coinbase will cancel the transaction and deposit the full crypto amount in the user's Coinbase account"; late funds also land there. Regulatory status was not fetched.

### 4.5 Banxa

**Payouts and regions.** The off-ramp overview lists "PayID — AUD (Australia)" and "SEPA bank transfer — EUR (Europe)"; the Native API table adds "ACH bank transfer … USA … Off-ramp only". Off-ramp "must be enabled and configured for your partner account".

**Assets.** Listed only by keyed endpoints; not read.

**Integration shape and keys.** Three paths. A **referral URL** ("There are no server-to-server API calls. No backend is required"; `orderType=sell`, `coinType`, `coinAmount`, `blockchain`, `walletAddress`, `returnUrl`), but with no webhooks and no order lookup. The **Hosted Checkout API**, whose `x-api-key` the React Native SDK takes in app code (`apiKey: 'YOUR_API_KEY'`), so the key would ship inside the app; and the **Native API**, server-to-server with HMAC. Non-custodial selling shows "a deposit address and QR code" and needs "No additional API calls" after order creation.

**Sandbox.** UI only; section 5.

**Regulatory status (licence list "Version: 26 August 2026", non-USA).** Global Internet Ventures Pty Ltd, AUSTRAC Digital Currency Exchange (DCE100618765-001); Richmond Internet Ventures Corporation, FINTRAC MSB (M20577911) and Revenu Québec (15280); EU Internet Ventures B.V., Crypto Asset Service Provider (41000017) with the Dutch AFM; BNXA UK VASP Limited, FCA MLR registration (999863); BNXA Brazil LTDA, no licence currently required. US licences are on a separate page that was not read; `banxa.com/licenses/` answered HTTP 403.

**Fees, limits, refunds.** Not found in the documentation read.

### 4.6 Mercuryo

**Assets.** The public `lib/currencies` list marks `widget_offramp_enabled: true` with no restricted countries for ETH on Ethereum, Base, Arbitrum and Optimism, USDC on Ethereum, Base, Arbitrum and Optimism, BTC, DOGE and SOL; USDC on Solana is `false`.

**Regulatory status (licences page, version 2.0, 1 July 2026).** "Cryptoassets buy and sell services (On and Off Ramps) and custody of cryptoassets are provided by MONEYMAPLE TECH LTD", registered with FINTRAC (MSB M21565803); in the EEA, exchange services "are provided by Criptan Trade, S.L. … a Crypto-Asset Service Provider (CASP) authorised by the Comisión Nacional del Mercado de Valores (CNMV) under MiCA", with Mercuryo's Spanish company providing "the technology platform"; Monetley Ltd is an FCA Electronic Money Institution (900921).

**Everything else** (integration, keys, sandbox, fees, refunds) is behind a documentation login and could not be read. A search engine summary claims a sandbox with "BTC Testnet" and "ETH Sepolia" and credentials from an integration manager, but that text was not read first-hand and is not relied on.

### 4.7 Alchemy Pay

**Integration shape and keys.** "All the parameter sent need to be signature" with an HMAC-SHA256 over the request using the merchant's secret key, and "Merchants must provide **outbound IP** address … before going live", so a backend with a fixed address is required. Orders time out in 48 hours. A "hiding receiving address" mode, where the partner sends the crypto, supports ETH and USDC on Ethereum but not on Base, Arbitrum or Optimism.

**Sandbox.** The testing notes require KYB, a whitelist application and a sandbox account from support; sandbox crypto is USDT on BSC (US$2 limit) and TRX (US$10) and USDC on BSC (US$2). Onramper's testing guide says Alchemy Pay's "Sandbox functions like production; requires real payments to test."

**Coverage, fees, licences.** The coverage page links to an external Notion table that was not read; licences were not read.

### 4.8 Sardine

Sardine's public documentation index lists fraud, identity, KYC/AML and transaction-monitoring products and "protected documentation"; no off-ramp product was found. Onramper lists Sardine among providers with limited sandbox support but not among its off-ramp providers. Sardine is therefore treated as a risk-and-fraud vendor that other providers may use, not as an off-ramp candidate.

### 4.9 Onramper (aggregator)

Onramper's off-ramp table lists AlchemyPay, Banxa, MoonPay, Unlimit Crypto, Koywe, TransFi and Onramp Money; it does not list Transak, Ramp Network, Coinbase or Mercuryo for selling. Its "Wallet Initiation Flow (recommended)" redirects to `offrampCashoutRedirectUrl` with the provider's deposit address and amount. Wallet addresses and other sensitive parameters "must" be signed server-side with an Ed25519 key (Signature V2). Its sandbox guide is blunt: "No Testnet Transactions: Unlike some other platforms, none of the providers support actual testnet blockchain transactions", and providers without a dedicated sandbox may show "their production environment inside the .dev sandbox. Be careful: using real card data here may result in actual charges." An aggregator adds a party that learns every quote request and must itself be trusted to pass on the right deposit address.

## 5. Can a sale be rehearsed on test networks?

| Provider | Test network crypto accepted | Test fiat payout | What is needed first |
|---|---|---|---|
| MoonPay sandbox | Documented: Bitcoin testnet3, Ethereum **Sepolia**, "ERC-20 tokens … Sepolia" (delivered as MoonPay's own `MoonPayToken`), Solana devnet ("Native SOL only"). `v3/currencies` sets `supportsTestMode: true` for btc, eth, sol and usdc, and `false` for doge and for every Base, Arbitrum and Optimism entry | "Test card for off-ramp payouts: Visa Direct payout" | A MoonPay dashboard account and its test publishable key; a US or UK address for the sandbox KYC, which "will not be verified" |
| Transak staging | Its own test token TRNSK on Ethereum Sepolia, Arbitrum Sepolia, OP Sepolia and Base Sepolia (among others): "Buy **TRNSK** via on-ramp, then send **TRNSK** to us to test off-ramping" | Card payout test cards (USD, SGD, GBP); KYC on staging "is always approved"; `+refund` and `+failed` email aliases simulate outcomes | A staging API key **and secret**, used from a backend to create each widget URL |
| Ramp Network demo | The demo API lists off-ramp assets `SEPOLIA ETH`, `SEPOLIA TEST` and `BASE USDC` at `0x036C…CF7e`, plus `ARBITRUM ETH` and `OPTIMISM ETH` on unnamed networks | Payout methods are listed in the demo API; whether a demo sale pays out was not found | An API key ("the widget won't work without an active production API key"; whether the demo needs one is not stated). The testing page itself is stale (it names Rinkeby and Mumbai) |
| Coinbase | None documented for selling (the "Enable Mocked Buy and Send" debug menu is described for the on-ramp) | — | — |
| Banxa sandbox | **None**: "No on-chain transactions. Wallet addresses must be valid mainnet format … Testnet addresses are rejected." | Simulated (test BSB and account number for AUD off-ramp) | Sandbox credentials from onboarding |
| Onramper | **None** ("none of the providers support actual testnet blockchain transactions") | Varies by provider | An API key |
| Alchemy Pay | USDT and USDC on BSC and TRX in small amounts; reported to behave like production | Mock card payments | KYB, whitelist, IP whitelisting |
| Mercuryo | Not verified (documentation behind a login) | Not verified | Credentials from an integration manager (unverified) |

The test tokens were read on-chain today:

| Token | Network and address | Read |
|---|---|---|
| Transak TRNSK | Ethereum Sepolia `0x0c86A754A29714C4Fe9C6F1359fa7099eD174c0b` | 3,579 bytes of code; `symbol()` "TRNSK", `name()` "Transak Test Token", 18 decimals |
| Transak TRNSK | Arbitrum Sepolia `0x0c86A754A29714C4Fe9C6F1359fa7099eD174c0b` | 3,669 bytes; same symbol, name and decimals |
| Transak TRNSK | OP Sepolia `0xD733D48f2a7F57D4559F98ae07f87Dab595E3523` | 7,022 bytes; same symbol, name and decimals |
| Transak TRNSK | Base Sepolia `0xD733D48f2a7F57D4559F98ae07f87Dab595E3523` | 3,579 bytes; same symbol, name and decimals |
| MoonPay MoonPayToken | Ethereum Sepolia `0x699cFE8997d647D03325Ef4bfD039d5bB0984A17` | 3,579 bytes; `symbol()` "MPT", `name()` "MoonPayToken", 18 decimals |
| Ramp demo "TEST" | Ethereum Sepolia `0x16B67fdC637039267d5c624f2c7cfCfcB8b99b75` | 6,091 bytes; `symbol()` **"RMP"**, `name()` **"Ramp Test Token"**, 18 decimals (the demo API calls it "TEST", "Test Token on Sepolia") |
| Ramp demo "BASE USDC" | Base Sepolia `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | Circle's USDC on Base Sepolia (1,798 bytes, "USDC", 6 decimals); the same address has **no code on Base mainnet**, so the demo's "BASE" network is Base Sepolia (an inference from the address) |

None of these five contracts is verified on Sourcify (`match: null` on all five).

**Answer to the central question.** Yes: three providers document or list a sandbox that takes test-network crypto, and two of them (MoonPay, Transak) document a test fiat payout. Ramp's demo is the only one that lists Circle's own test USDC, which the dev EOA holds (36 USDC on Base Sepolia, `AGENTS.md`, "INPUTS RECEIVED (2026-10-11)"). MoonPay's sandbox takes Sepolia ETH, which every emulator account holds. None of this can be exercised without a partner account, so feature 66 **cannot be proven on test networks until the Chairperson obtains sandbox credentials from at least one provider**. With credentials, a rehearsal on the emulator would prove the wallet half end to end: opening the provider, receiving the deposit details, sending through the existing confirm, and reading the provider's status. It would still not prove real payouts, real KYC, real limits or real refunds, which only a mainnet pilot can show.

## 6. Compliance inputs for the Chairperson (not legal advice)

### 6.1 Partner agreements

Every provider requires an agreement before its widget works in production: MoonPay lists "A MoonPay account" as a prerequisite; Ramp needs an off-ramp-enabled production key; Transak issues keys through its partner dashboard; Coinbase integrations "start in trial mode" until onboarding is approved; Banxa enables off-ramp per partner account; Alchemy Pay requires KYB before a sandbox. The agreement fixes fees, permitted countries, data handling and the allocation of liability. Offering several providers, as for bridging, means one agreement each.

### 6.2 The Travel Rule and ownership proofs

The providers, not the wallet, are the regulated parties in the documentation read. MoonPay's Travel Rule FAQ (dated February 12, 2026) says verification of wallet ownership is required "For transactions over the applicable threshold in your region" without stating the threshold on that page; a search engine summary of an older MoonPay page (now HTTP 404) gave EUR 1,000 and a signed-message method, which is consistent with the EU rule for transfers to and from self-hosted addresses but was not read first-hand. Transak's compliance page links to "FCA's Travel Rule Group". No provider page read imposes a Travel Rule obligation on the wallet itself. The practical consequence is the one in section 3.3: the wallet may be asked to sign an ownership message, which must go through the wallet's existing message-review screen (as `personal_sign` and SIWE do today), never blindly, and cannot be offered for a multisig.

### 6.3 App stores

Apple's App Store Review Guidelines (last updated October 16, 2026), 3.1.5(i): "Apps may facilitate virtual currency storage, provided they are offered by developers enrolled as an organization." 3.1.5(iii): "Apps may facilitate transactions or transmissions of cryptocurrency on an approved exchange, provided they are offered only in countries or regions where the app has appropriate licensing and permissions to provide a cryptocurrency exchange." 5.1.1(ix): "Apps that provide services in highly regulated fields (such as banking and financial services, … and crypto exchanges) or that require sensitive user information should be submitted by a legal entity that provides the services, and not by an individual developer." Whether a sell button that opens a licensed provider's page counts as the app "facilitating transactions … on an approved exchange", and whether the provider's licences satisfy "the app has appropriate licensing", cannot be settled from the text; this joins the 3.1.5(iii) question already open for swaps (`docs/STORE_LISTING.md` section 2.1). Coinbase's FAQ offers help to partners "submitting my App for review to the Apple App Store and it uses Coinbase Onramp", which suggests the question is a known one.

Google Play's Financial Services policy: "If your app contains or promotes financial products and services, you must comply with state and local regulations for any region or country that your app targets", and "Any app that contains any financial features must complete the Financial features declaration form within Play Console." Its crypto section: "The purchase, holding, or exchange of cryptocurrencies should be conducted through certified services in regulated jurisdictions." The country-requirements article says "Non-custodial wallets are out of scope of the Cryptocurrency Exchanges and Software Wallets policy", but lists per-country licences for exchanges (for example Canada: "registered with FINTRAC (CANAFE) as a money services business"). Whether adding a sell flow changes the app from a non-custodial wallet into something Google treats as an exchange is for counsel.

### 6.4 What `docs/PRIVACY.md` would have to say

A new section, "Selling crypto through a provider (only when you use it)": who operates the provider opened; that it collects identity documents, payout details and contact data under its own privacy policy; that the wallet passes the asset, network, amount and any pre-filled address; that the provider learns the sending address and can link it to the user's identity; that its page sees the phone's IP address and device data (MoonPay documents "IP matching", binding a signed on-ramp URL to a hash of the customer's IP address; Coinbase's session token carries `clientIp`); whether the page runs inside the wallet or in the system browser; and what any backend would store. "We collect nothing" stays true only if the wallet keeps no server.

### 6.5 Geography

Selling availability differs by country and US state for every provider (sections 4.1 to 4.3), and the lists disagree with the providers' own FAQs in places. The wallet cannot know a user's residence; the providers check it themselves. A pilot should name its target countries, rely on the provider's own refusal, and never claim availability the provider has not confirmed for that user.

## 7. Privacy and trust

### 7.1 Who learns what

The provider learns the user's identity, payout details, IP address and device characteristics, and the sending address and transaction hash, so it can link the user's identity to that address's whole on-chain history. Addresses derived from the same phrase stay unlinkable on-chain unless the user links them, so selling from a dedicated account limits what the provider can connect; the wallet could suggest this without requiring it. The provider never learns the phrase, any key or other accounts' balances. An aggregator also learns every quote request, and a backend (if ever added for Transak or Coinbase) would see the user's address and IP for each session, which is new for this project.

### 7.2 WebView versus the system browser

`docs/DAPP_BROWSER.md` found the `react-native-webview` defaults unsafe for a wallet (B1 to B8). Three findings apply directly to a provider page opened inside the wallet:

- **B5, the camera.** On Android the library grants a page's camera request at once when the app holds `CAMERA`. KYC needs the camera (MoonPay: the web view must be "able to access device local storage and initialize camera"), so the provider's page, and any iframe in it, would get it silently.
- **B2 and B3, message attribution.** Ramp's Native Flow and MoonPay's `onInitiateDeposit` deliver the deposit address by `postMessage`. On Android the bridge is exposed to every frame and the fallback bridge reports the top page's URL for every frame, so an iframe could post a forged `SEND_CRYPTO` with its own address undetectably. Because the deposit address is the one thing the wallet trusts (section 3.2), this is the most serious risk of the WebView route.
- **B7**, downloads carrying the site's cookies.

The system browser (Chrome Custom Tabs, `SFSafariViewController`) isolates the page, keeps the camera behind the browser's prompt, and is what Coinbase requires. But the deposit details must then return by redirect, and any app or website can open the wallet's link with a forged `depositWalletAddress`. MoonPay accepts only "HTTPS or Universal/App Link URLs" ("Custom-scheme links (e.g., myapp://…) are not supported"), so the wallet would need a domain it controls, which it does not have (the passkey domain is the same open input). `expo-web-browser` is not in `app/package.json` today.

The safest combination found: the system browser; deposit details from a redirect; before the confirm, re-read what the provider allows without a secret (Ramp's sale endpoint with its view token, MoonPay's sell transaction with the publishable key: status and amounts); then show the address with the statement that it came from the provider's page and ask the user to compare it with that page. No provider read lets the wallet re-read the address itself, so that comparison is the user's.

### 7.3 Can a provider be used with no account of the wallet's own?

No. CCTP's contracts and attestation API needed no key (`docs/BRIDGING.md` section 4.3); every off-ramp provider needs at least a partner account and a publishable key. The weaker property, "no secret in the app and no server", holds for MoonPay (publishable key, unsigned URL, no pre-filled addresses), Ramp Network (`hostApiKey` in the clear, keyless sale status) and Banxa's referral URL. A publishable key in a public repository is acceptable by its design but lets anyone attribute traffic to the project's account; the project's secret scan does not flag it. A secret key, which Transak, Coinbase, Alchemy Pay, Onramper (for addresses) and MoonPay (for signed URLs) require, must never be in the repository or the app; it would live in a backend the project does not have.

## 8. Comparison

| | MoonPay | Transak | Ramp Network | Coinbase | Banxa | Mercuryo | Alchemy Pay |
|---|---|---|---|---|---|---|---|
| ETH sell on Ethereum / Base / Arbitrum / Optimism | Yes / Yes / Yes / **No** | Yes / Yes / Yes / Yes | Yes / Yes / Yes / Yes | Yes (via Coinbase account) | Not read | Yes / Yes / Yes / Yes | ETH on Ethereum (one mode) |
| USDC sell on Ethereum / Base / Arbitrum / Optimism | Yes / Yes / Yes / **No** | Yes / Yes / Yes / **not listed** | Yes / Yes / Yes / Yes | Not read (keyed API) | Not read | Yes / Yes / Yes / Yes | USDC on Ethereum (one mode) |
| BTC / DOGE / SOL sell | Yes / Yes / Yes | Yes / Yes / Yes | Yes / Yes / Yes | BTC yes; DOGE implied | Not read | Yes / Yes / Yes | Not read |
| Seller needs a provider account | Provider login in widget | Provider login | Provider login | **Coinbase account with linked bank** | Provider login | Not read | Provider login |
| Payouts (as documented) | Card, ACH, GBP bank, SEPA, PayPal, Venmo, balance | Card in most currencies; GBP bank | ACH, RTP, SEPA, PIX, SPEI, card | ACH (US), PayPal, Coinbase balance | PayID (AUD), SEPA (EUR), ACH (US) | Not read | Not read |
| Fee for selling (provider's own page) | Up to 4.5%, minimum up to $4.50 when referred | 0.99% (card) | 0.99% bank, 4.49% card | Not stated | Not found | Not read | Not read |
| Wallet backend needed | No (unsigned URL); yes to pre-fill addresses | **Yes** (API secret) | **No** | **Yes** (secret key, session tokens) | No (referral); key in app (SDK) | Not read | **Yes** (signing, IP whitelist) |
| Deposit address reaches the wallet by | SDK event or HTTPS redirect | SDK event or redirect | `SEND_CRYPTO` message | Keyed status API | Shown on page or redirect | Not read | Callback (custodial mode) |
| Sandbox with test-network crypto | Yes (Sepolia, testnet3, devnet) | Yes (TRNSK on four test networks) | Demo lists Sepolia and Base Sepolia assets | No | No | Unverified | Small, BSC/TRX |
| Test fiat payout documented | Yes (test card) | Yes (test cards) | Not found | — | Simulated | Unverified | Mock |
| Stated registrations | FCA, FinCEN, FINTRAC, AUSTRAC, AFM, JFSC, US MTLs incl. NY | FinCEN, FCA, FINTRAC, AUSTRAC, US MTLs | FCA, FinCEN, 10 US MTLs, Central Bank of Ireland CASP | Not fetched | AUSTRAC, FINTRAC, AFM CASP, FCA | FINTRAC, CASP via partner (CNMV), FCA EMI | Not read |

## 9. Recommendation

### 9.1 Ranked

1. **Ramp Network, first.** The only public list covering every asset and network the wallet supports (including USDC on Optimism); a wallet-driven Native Flow meant for "a native mobile app that can execute the crypto transfer"; no server of the wallet's own needed for the sale or its status; 0.99% bank payouts; and it states that the Central Bank of Ireland authorises it as a Crypto Asset Service Provider (its site links this to "MiCAR Policies"), plus FCA and FinCEN registrations. Its demo API lists Circle's Base Sepolia USDC, which the dev EOA holds. Against it: a stale testing page, an unverified demo off-ramp and key requirement, and a `postMessage` channel that needs the B2/B3 mitigations or the system-browser route.
2. **MoonPay, second.** The best-documented selling sandbox (Sepolia ETH, testnet3, devnet, a test payout card); no server needed when no address is pre-filled; the broadest stated licensing. Against it: no selling on Optimism, the highest stated fee ceiling, Canada excluded, and the deposit address only via an SDK event or an HTTPS redirect.
3. **Transak, third.** TRNSK on all four of the wallet's test networks, clear refund tooling, a 0.99% card payout fee. Against it: a backend holding the API secret is mandatory, USDC on Optimism is not listed, payouts are mostly to cards, and its mobile guide asks for microphone and location permissions.
4. **Coinbase, later,** as an option for users who already have a Coinbase account; requiring one makes it a hand-off to an exchange, and it needs a backend and has no selling sandbox.
5. **Banxa, Mercuryo, Alchemy Pay, later or not at all** (narrow payouts and no on-chain sandbox; unreadable documentation; KYB, a signing server and IP whitelisting). Aggregators such as Onramper should wait, as in bridging: one more trusted party in the path of the deposit address, and server-side signing.

Provider optionality, as chosen for bridging, fits too: a `SellProvider` registry like `BridgeProvider`. Each provider, however, costs a partner agreement, a privacy-notice section and a rehearsal, so the first slice should have one.

### 9.2 Does the on-ramp hold block an off-ramp pilot?

Technically, no: every provider offers selling as a flow of its own (MoonPay `flow: "sell"`, Transak `productsAvailed=SELL`, Ramp `enabledFlows: ['OFFRAMP']`, Banxa `orderType=sell`). The feature catalogue's "Prerequisites: 65" is a product sequencing note, not a technical dependency. In practice, the record does not state why the on-ramp is on hold, but the phase 13 plan named its missing inputs as "a vendor account and compliance decisions", and an off-ramp needs exactly those: a partner agreement, counsel's view on the store clauses, and the privacy notice. So an off-ramp pilot waits on the same decision unless the Chairperson separates them.

### 9.3 The smallest honest first slice

**Stage 0, inputs (Chairperson):** choose the provider; obtain sandbox credentials (Ramp's or MoonPay's need no server; Transak's staging also needs a key and secret, which could live in `.dev-wallet/` for a local rehearsal script only); decide the WebView or system-browser route.

**Stage 1, rehearsal on test networks, regular account only.** A "Sell" entry on test networks behind a readiness row, opening the provider's sandbox; deposit details from the provider's event or redirect, re-checked against the network, asset and amount the user chose, and sent through the existing Send confirm with a statement that the destination came from the provider's page. Prove on the emulator a Sepolia ETH sale to MoonPay's sandbox or a Base Sepolia USDC sale to Ramp's demo, the provider's status read back, a wrong amount refused by the wallet, and an expired order handled, with every hash verified on-chain.

**Stage 2, smart account:** the same with a Kernel account selling a token (MoonPayToken, TRNSK or Base Sepolia USDC), observing whether the provider credits it and where a refund goes; native ETH only once that is confirmed.

**Stage 3, mainnet pilot:** the partner agreement and production keys; counsel on Apple 3.1.5(iii) and 5.1.1(ix) and Google's financial features declaration; the new `docs/PRIVACY.md` section; a universal-link domain or a development build carrying the B2/B3/B5 fixes; real-phone tests; one small real sale and one real refund. A regular-account sale is a plain transfer and does not depend on C1 to C3; a smart-account sale on mainnet does.

### 9.4 The readiness gate

A new row `fiat-offramp`. Unlike every other row, the feature only has meaning on mainnet; its test-network form is a sandbox rehearsal. Proposed: status `testnet-only` and **enforced** (as `bridge` and `dapp-browser` are), so the entry appears only on test networks and only when sandbox credentials are configured, with the reason "Selling crypto for fiat goes through a licensed provider that verifies your identity and pays your bank or card; this wallet only sends the crypto to the address the provider gives for your order, and it cannot check that address itself. A partner agreement, a legal review and real-phone tests are needed before it is offered with real funds." Evidence ids would be a new threat-model row for the deposit-address channel and the existing B2/B3/B5 findings (T-71, F-67). Moving it to mainnet would be a Chairperson decision recorded with the partner agreement.

## 10. Decisions for the Chairperson

1. Whether to offer selling at all while the on-ramp stays on hold, given that both need the same vendor and compliance inputs.
2. The provider for a first slice (recommended: Ramp Network, with MoonPay as the alternative for the sandbox rehearsal), and whether to open a sandbox account with it.
3. Whether the project may operate a backend (needed for Transak, Coinbase and Alchemy Pay, and for MoonPay if addresses are pre-filled), which would end the "no server" statement in the privacy notice.
4. WebView (provider events, but camera and message-attribution risks inside the wallet) or system browser (isolation, but a universal-link domain and redirect checks are needed).
5. Which countries to target, and whether counsel reviews Apple 3.1.5(iii) and 5.1.1(ix) and Google's financial features declaration for a sell flow.
6. Whether a smart-account sale is in scope for a pilot, given the undocumented refund and detection behaviour for internal transfers.
7. Whether the project wants provider optionality for selling (one agreement per provider) or a single provider.

## 11. Documentation-versus-API gaps found

1. **MoonPay US states.** The developer FAQ says selling is unavailable in Louisiana, Texas, New York and the US Virgin Islands; the public `v3/countries` answer blocks selling only in the US Virgin Islands.
2. **MoonPay fiat payouts.** The FAQ lists USD, GBP and EUR; the `quoteCurrencyCode` parameter lists 33 fiat codes.
3. **Coinbase sell payouts.** The overview lists ACH, PayPal and Coinbase balances; the payment-methods table also marks `CARD` as supporting "Buy, Sell".
4. **Ramp demo token name.** The demo API calls `0x16B6…9b75` "TEST" ("Test Token on Sepolia"); the contract's own `symbol()` and `name()` are "RMP" and "Ramp Test Token".
5. **Ramp testing page.** It names Ethereum Rinkeby and Matic Mumbai as the demo's test networks; the demo API today lists Sepolia, Base Sepolia (by its USDC address) and two unnamed rollup networks.
6. **Transak `isPayInAllowed`.** Used as a sell flag in the public API but not defined on the off-ramp pages read.
7. **Mercuryo.** `developers.mercuryo.io` serves an unedited documentation template ("Write your first page"), and the real documentation requires a login.
8. **Onramper's sell-widget page** (`/docs/sell-widget.md`) and Alchemy Pay's off-ramp page (`/docs/alchemypay-off-ramp.md`) answered HTTP 404 although search results link to them.

## 12. Could not verify

- Whether any sandbox actually completes a sale with test-network crypto and records a test payout: documented by MoonPay and Transak, listed by Ramp's demo, not exercised (no account was created).
- Whether Ramp's demo widget works without a key, which networks its `ARBITRUM` and `OPTIMISM` entries are, and whether a demo sale releases.
- Whether any provider credits native ETH sent by a smart account's internal call, and which address each provider treats as "the sender" for refunds and validation; whether ERC-1271 signatures are accepted for ownership proofs.
- Coinbase's sell fees, sell assets per country and regulatory registrations (keyed APIs and pages not read); Banxa's assets, fees and US licences; Mercuryo's integration, keys, sandbox and fees; Alchemy Pay's coverage (external Notion table) and licences.
- The Travel Rule threshold and method each provider applies to sales from self-hosted addresses (MoonPay's current page states no threshold; its older page is HTTP 404).
- Whether the providers' published audits or certifications (Transak's ISO 27001 and SOC 2 claim) cover the off-ramp components; no audit reports were read.
- Whether `expo-web-browser` is bundled in Expo Go for this SDK version (it is not in `app/package.json`).
- How Apple and Google would review a sell flow in this app; this needs counsel and, in practice, a submission.
- Whether a publishable key from any provider would be accepted in a public repository by that provider's terms.
