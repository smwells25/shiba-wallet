# Optional outbound address screening (feature 86)

**Status:** Research only, written for phase 25 item 5 (`AGENTS.md`, "Phase 25 plan") against repository commit `215f3e0`. Nothing here is built and nothing was sent. The downloads and reads ran between 03:54 and 04:10 UTC on 2026-11-09 (the evening of 2026-11-08, US Eastern). Every count in this document comes from parsing the official files named in section 2; no sanctioned address is reproduced here, and none should be copied into this repository's documents, tests or logs except as part of a deliberately built, pinned data file. Section 11 lists what could not be verified. Nothing in this document is legal advice; the questions in section 9 are for the Chairperson and counsel.

## 1. Summary

1. **The U.S. Treasury's SDN list is the only primary public list found that publishes digital-currency addresses in a structured field.** The SDN file published on 6 November 2026 holds 1,081 address identifiers under 20 currency labels, attached to 113 of its 19,563 entries. For the networks this wallet sends on: 137 entries are Ethereum-format (`0x` plus 40 hex digits) under six labels (124 of them labelled ETH), 534 are labelled XBT (Bitcoin), 4 SOL and 2 DOGE. OFAC itself says its address listings "are not likely to be exhaustive" (FAQ 562).
2. **The other official lists checked do not offer a usable address field.** OFAC's consolidated non-SDN list carries none. The UK Sanctions List has no address field; five of its 6,420 designations mention wallet addresses in free text. The UN Security Council list carries none. The EU's public download could not be fetched (HTTP 500), so the EU is unverified.
3. **A warn-only check from a pinned snapshot is technically small and private.** An extract of the SDN addresses is tens of kilobytes; matching is an exact string comparison with no network request at confirm time, so no third party learns whom the user pays. The honest claim is narrow: "this address appears on the OFAC SDN list as published on <date>". It must never say an address is clean, safe or legal.
4. **It cannot do what commercial screening does.** It cannot see indirect exposure (funds that passed through a listed address), clusters of addresses controlled by the same person, addresses created after the snapshot, or entities blocked under OFAC's 50 percent rule that have no listed address. Those need a provider API, which is keyed, sees the user's counterparties, and conflicts with the feature's own "without imposing surveillance" promise (`docs/FEATURE_UNIVERSE.md`, feature 86).
5. **The lists name no test-network addresses.** A listed Ethereum address is the same 20 bytes on Sepolia, so a match can be shown there, but it says nothing about a test network; a test-network demonstration would have to say so.
6. **Recommendation: a conditional GO for a warn-only, off-by-default, pinned-snapshot slice** on the EVM confirm screens, only after the Chairperson and counsel answer section 9 (in particular whether to ship a list at all). NO-GO for blocking, for a provider API, and for the deprecated Chainalysis on-chain oracle (section 7.2).

## 2. Sources

| Source | Fetched (UTC) | Used for |
|---|---|---|
| OFAC SDN list, XML: `https://www.treasury.gov/ofac/downloads/sdn.xml` (redirects to `https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML`, then to a signed Amazon S3 URL under `wc2h-sls-prod-public-published`) | 2026-11-09 03:55 | 29,555,846 bytes, SHA-256 `bbf4658b7803ed6aa25712670bd6dfea56b6f9f93001d99e5d8ea221b237a597`; `Publish_Date` 11/06/2026, `Record_Count` 19,563; HTTP `Last-Modified: Fri, 06 Nov 2026 19:33:15 GMT` |
| OFAC SDN list, advanced XML: `https://www.treasury.gov/ofac/downloads/sanctions/1.0/sdn_advanced.xml` (same redirect chain, `SDN_ADVANCED.XML`) | 2026-11-09 03:55 | 128,630,615 bytes, SHA-256 `60698e6e3edd49ac9398576aae7e98e06f2c0bf44cc41e485bca4732ac56805f`; `DateOfIssue` 2026-11-06; used to cross-check the counts |
| OFAC SDN list, CSV: `https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV`; `https://www.treasury.gov/ofac/downloads/sdn_comments.csv` | 2026-11-09 03:57–03:59 | Shows that the CSV carries addresses only inside free-text remarks (section 3.3) |
| OFAC consolidated (non-SDN) list: `…/exports/CONSOLIDATED.XML` | 2026-11-09 03:59 | `Publish_Date` 11/04/2026, 486 records, no address identifiers |
| OFAC FAQs 560, 562, 563, 594 (`https://ofac.treasury.gov/faqs/<n>`) and the topic "Information on List File Formats and Downloads" (`https://ofac.treasury.gov/faqs/topic/1641`, FAQs 79–89) | 2026-11-09 03:58–04:00 | What the address field means, its format, exact-match search, download guidance |
| OFAC recent action of 2025-03-21 (`https://ofac.treasury.gov/recent-actions/20250321`) | 2026-11-09 04:01 | The Tornado Cash removal (section 3.5) |
| OFAC "Sanctions List Service" page (`https://ofac.treasury.gov/sanctions-list-service`) | 2026-11-09 04:00 | What the service offers |
| UK Sanctions List, XML: `https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.xml`; GOV.UK page `https://www.gov.uk/government/publications/the-uk-sanctions-list` | 2026-11-09 03:59–04:02 | 22,084,218 bytes, `DateGenerated` 03/11/2026 (day first), 6,420 designations; the page's statement that OFSI's consolidated list closed on 28 January 2026 |
| OFSI consolidated list (former address `https://ofsistorage.blob.core.windows.net/publishlive/2022format/ConList.csv`) | 2026-11-09 03:59 | Answered HTTP 409 "PublicAccessNotPermitted" |
| EU Financial Sanctions Files, public XML and CSV (`https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=…` and its CSV and older forms) | 2026-11-09 03:59–04:00 | Answered HTTP 500 three times; not verified |
| UN Security Council consolidated list: `https://scsanctions.un.org/resources/xml/en/consolidated.xml` | 2026-11-09 04:09 | `dateGenerated` 2026-11-08; no address identifiers |
| Chainalysis sanctions oracle page `https://go.chainalysis.com/chainalysis-oracle-docs.html`; Chainalysis public API `https://public.chainalysis.com/api/v1/address/…` | 2026-11-09 04:00–04:01 | The oracle's deprecation; the API refusing an unkeyed request |
| TRM Labs sanctions API page `https://docs.trmlabs.com/guides/sanctions/introduction` | 2026-11-09 04:02 | Access by form |
| Keyless RPC reads (`ethereum-rpc.publicnode.com`, `0xrpc.io/eth`, and the wallet's test-network endpoints listed in `docs/TOKEN_BOUND_ACCOUNTS.md` section 2) | 2026-11-09 04:05 | Whether the Chainalysis oracle address holds code on each network |
| This repository at `215f3e0` | — | Where a check would hook in (section 5) |

Counts were made with a Python script using the standard library's XML parser and checked with a second, independent regular-expression count over the advanced XML; Ethereum checksums were checked with `getAddress` from ethers 6 as installed in this repository. The scripts and the files they read stayed in the session's scratchpad; the extracted addresses were kept in a private folder and never printed.

## 3. The public sanctions data

### 3.1 How OFAC lists an address

OFAC states the structure in FAQ 563 (released 6 June 2018): "Each digital currency address listed on the SDN list will have its own field: the structure will always begin with "Digital Currency Address", followed by a dash and the digital currency's symbol (e.g., "Digital Currency Address - XBT", "Digital Currency Address - ETH"). This information is followed by the unique alphanumeric identifier of the specific address." The identifier is "up to 256 characters".

In `sdn.xml` the field is an `<id>` element inside an entry's `<idList>`: `<idType>` holds the label (for example `Digital Currency Address - ETH`) and `<idNumber>` holds the address. In the advanced XML the same data is a `<Feature>` whose `FeatureTypeID` points at a `<FeatureType>` named with the same label; that file defines exactly the 20 labels in use today (none of the examples FAQ 563 also mentions, NEO, MIOTA or PTR, is currently defined).

FAQ 562 (released 19 March 2018) says what the field is for and what it is not: "OFAC may add digital currency addresses to the SDN List to alert the public of specific digital currency identifiers associated with a blocked person. OFAC's digital currency address listings are not likely to be exhaustive." FAQ 594 (18 May 2021) says the official search tool matches addresses exactly: "The ID # field does not use fuzzy logic, so only exact matches will be returned when searching for digital currency addresses", and that the downloadable files "can be used to identify and screen for listed digital currency addresses".

On keeping a copy current, FAQ 88 says OFAC "cannot give specific advice on how to design an automated system"; institutions "conduct their own risk assessments and decide how often they need to download the lists", and "OFAC is updating its sanctions lists at an ever increasing pace."

### 3.2 What the 6 November 2026 SDN file holds

Of 19,563 entries, 113 carry at least one address. The two XML formats agree on every count below.

| Label | Identifiers | Distinct values | Entries carrying it |
|---|---:|---:|---:|
| XBT (Bitcoin) | 534 | 532 | 65 |
| TRX (Tron) | 272 | 272 | 44 |
| ETH (Ethereum) | 124 | 123 | 48 |
| USDT | 94 | 94 | 20 |
| LTC | 14 | 13 | 10 |
| XMR | 11 | 11 | 4 |
| BCH | 7 | 7 | 4 |
| DASH | 5 | 5 | 4 |
| ZEC | 4 | 4 | 4 |
| SOL (Solana) | 4 | 4 | 3 |
| USDC | 2 | 2 | 2 |
| DOGE (Dogecoin) | 2 | 2 | 1 |
| BTG, ETC, BSV, XVG, XRP, ARB, BSC, BNB | 1 each | 1 each | 1 each |
| **Total** | **1,081** | **1,077** | **113** |

Facts that matter for matching:

- **Ethereum-format addresses appear under six labels.** 137 identifiers have the form `0x` plus 40 hex digits: 124 ETH, 8 USDT, 2 USDC and one each under ARB, BSC and ETC. Lower-cased, they reduce to 127 distinct addresses. A label names a currency, not a chain; the same 20-byte address is the same account on every EVM chain.
- **Letter case is mixed.** Of the 137 Ethereum-format identifiers, 66 are written all in lower case and 71 in mixed case; every one of the 71 is a valid EIP-55 checksum. None is all upper case. A comparison must therefore lower-case both sides.
- **The USDT label holds three address families:** 79 Tron-format (starting with `T`), 8 Ethereum-format and 7 Bitcoin-format strings. A check cannot rely on the label to know the address family; it must classify each string by its form.
- **Bitcoin identifiers by form:** 209 start with `1`, 178 with `3`, 146 with `bc1q`, and one identifier under the XBT label starts with `T`, which is the shape of a Tron address, not a Bitcoin one. That is an observation about the data, not a claim that the entry is wrong; it shows that a pinned extract should keep the label and the original string unchanged and should not "repair" anything.
- **Solana and Dogecoin:** the 4 SOL identifiers are base-58 strings of Solana's length; the 2 DOGE identifiers start with `D`.

### 3.3 Formats and size

`sdn.xml` (29.6 MB) and the advanced XML (128.6 MB) carry the address in its own field. The CSV export carries identifiers only inside the free-text remarks column, with overflow moved to `sdn_comments.csv` (FAQ 83 points to the data specification guides for the layout); counting the label in `SDN.CSV` alone found fewer addresses (for example 262 XBT instead of 534), so the CSV is the wrong source for an extract. A shipped extract of all 1,081 identifiers with their labels, entry numbers and entry names would be in the order of tens of kilobytes; the Ethereum-format subset alone is 127 addresses.

### 3.4 Other official lists

- **OFAC consolidated (non-SDN) list** (published 4 November 2026, 486 records): no address identifiers.
- **UK.** The GOV.UK page states that "The UK Sanctions List is now the only source for all UK sanctions designations" and that "The OFSI Consolidated List of Asset Freeze Targets closed on Wednesday 28 January 2026 and is no longer being updated." The UK Sanctions List XML of 3 November 2026 has no element for a digital-currency address. Five of its 6,420 designations (under the counter-terrorism, global human rights and Russia regimes, judging by their identifier prefixes) mention wallet addresses inside the free-text `OtherInformation` or statement-of-reasons fields, six distinct Ethereum-format strings in all. Free text is not a dependable source: its wording varies ("Digital Currency Address: ETH", "Ethereum crypto addresses:", a numbered list) and a parser would have to guess.
- **UN Security Council consolidated list** (generated 8 November 2026): no address identifiers and no mention of digital currency.
- **EU.** The public Financial Sanctions Files download answered HTTP 500 for the XML and CSV forms tried; whether the EU publishes addresses, and in what form, is not verified. The Commission's own help pages, as reported by a search on 2026-11-09, say the authentic text is what is published in the Official Journal. To confirm: fetch the file from the Financial Sanctions Files site (an account may be needed) or read recent Council regulations in the Official Journal.

### 3.5 Lists change in both directions

A snapshot goes stale by addition and by removal. OFAC's recent action of 21 March 2025 ("Cyber-related Designation Removal; North Korea Designation Update and Removal") deleted the Tornado Cash entry, which had carried 90 distinct Ethereum addresses. A wallet that shipped a snapshot from before that date would have kept warning about those addresses after they stopped being listed. Any warning must therefore carry the snapshot's date and say the list may have changed.

## 4. How a warn-only check could run

### 4.1 Pinned snapshot or fetched list

| | Pinned snapshot in the app | List fetched by the app |
|---|---|---|
| Privacy | No request at all; nobody learns that the user screens or whom they pay | A request to `treasury.gov` (or a mirror) reveals the user's IP address and that the check is on, though not the counterparty |
| Size | Tens of kilobytes | 29.6 MB for `sdn.xml`, 128.6 MB for the advanced XML: too large to fetch on a phone routinely; a smaller derived file would have to be hosted by someone, which adds a trust point |
| Freshness | As old as the app build; updated only by a new release | As fresh as the last fetch |
| Integrity | Reviewed in the repository; the source file's SHA-256 and publication date are recorded with it | The app would have to check what it fetched; OFAC publishes no signature or checksum that was found for these files |

The recommended shape is a pinned snapshot built by a script from the official `sdn.xml`, recording the source URL, the file's SHA-256, `Publish_Date` and the build date beside the extract; a later "check for a newer list" action could be considered separately. No network call is made at confirm time in either design.

### 4.2 The match

- **Exact only.** No fuzzy, partial, prefix or "looks like" matching; OFAC's own tool is exact-match for addresses (FAQ 594).
- **Ethereum-format:** lower-case both the listed string and the counterparty, then compare. Match every Ethereum-format identifier whatever its label (ETH, USDT, USDC, ARB, BSC, ETC), and state the label in the warning, because the label names a currency, not a chain.
- **Bitcoin `bc1` (bech32):** BIP-173 (`bitcoin/bips` at `a34f044b`, read 2026-11-09, lines 184–194) says "Encoders MUST always output an all lowercase Bech32 string" and "Decoders MUST NOT accept strings where some characters are uppercase and some are lowercase", so an upper-case copy is the same address: compare case-insensitively. **Base-58 forms** (Bitcoin `1…`/`3…`, Dogecoin, Solana) are case-sensitive and must be compared exactly.
- **Only real subjects.** The address checked must be one the wallet itself decoded as the counterparty (section 5), never free text from a dApp.
- **Absence says nothing.** No green tick, no "not on any list". A non-match is silent, because the list is "not likely to be exhaustive".

### 4.3 What the warning could say

A proposed sentence, for counsel to review:

> "This address appears on the U.S. Treasury's OFAC sanctions list (SDN list) as published on 6 November 2026, listed as a digital currency address (ETH) for one entry on that list. The wallet has not blocked this transfer and cannot tell you whether it is lawful for you to make it. The list may have changed since that date."

It must not claim: that an address not on the snapshot is safe or clean; that the counterparty is a sanctioned person (the list associates the address with an entry; OFAC's FAQ 562 frames it as an identifier "associated with a blocked person", and a listing can be removed); that the wallet has performed a compliance check, screened for the user or knows the user's legal position; that the snapshot is current; or anything about test networks beyond "this address string is on the list". Whether to show the listed entry's name is a question for counsel (section 9).

### 4.4 Where it would sit

On the existing risk card, as one more line from `computeRiskLines` (`app/src/wallet/risk.ts` 1105), off by default behind a Settings switch whose text says what it does and does not do; the switch, the snapshot date and the source hash shown in Settings.

## 5. The counterparties the wallet already decodes

The wallet already works out "who is this transaction really for" on its EVM confirm screens, and a screening line should use exactly those subjects, not invent new ones:

- **Plain sends:** the transaction's `to` (`gatherRiskFacts`, `risk.ts` 1424, with `counterparty` falling back to `to` at 1455–1456).
- **ERC-20 transfers of a tracked or known token:** the decoded recipient, not the token contract (`tokenTransferTarget`, `risk.ts` 455–476; `erc20TransferRecipientFromCalldata`, 435; `computeRiskLines` takes `transfer.recipient` as the subject, 1109).
- **Approvals:** the spender decoded from `approve` calldata (`approvalChangesFromCalldata`, `risk.ts` 385–433; the WalletConnect sheet's `spenderRiskWarnings` in `app/src/components/WcApprovalSheet.tsx`).
- **Smart-account operations:** the inner call's target or the token recipient (`aaRiskWarningTarget`, used at `app/src/screens/SendScreen.tsx` 2110).
- **Bridges:** the recipient is always one of the wallet's own accounts (`app/src/wallet/bridge.ts` 103–118), so only the pinned provider contract is a counterparty; screening the user's own address is pointless.
- **Other screens drawing the same risk card:** Swap, Staking, Multisig, ColdSign, Handle, PendingTransactions and the WalletConnect / in-app browser sheet (`RiskWarnings` is used in each; found by searching `app/src` for `RiskWarnings`).

Not covered today: Bitcoin, Dogecoin and Solana sends, including the Solana token send screen, draw no risk card (the four `RiskWarnings` uses in `SendScreen.tsx`, lines 2110, 2207, 2308 and 2438, are on its EVM confirms; `SolanaTokenSendScreen.tsx` has none). Screening there would need its own line on those confirms, and the SDN file has 534 Bitcoin, 4 Solana and 2 Dogecoin identifiers.

## 6. What a list check cannot do

- **Indirect exposure.** A listed address that sent funds to the counterparty last week is invisible to an exact match.
- **Clustering.** Analytics firms group addresses they believe one person controls; the public list names only the addresses OFAC chose to publish.
- **Fresh addresses.** A blocked person can receive at an address created after the snapshot, or never published.
- **Ownership-based blocking.** FAQ 560 states the obligation covers persons named on the SDN List "or any entity owned in the aggregate, directly or indirectly, 50 percent or more by one or more blocked persons"; such entities may have no listed address.
- **Names.** The wallet sees addresses, not identities; it cannot screen a person.

Covering any of these needs a commercial provider. What was found on the providers' own pages:

- **Chainalysis.** The free public API endpoint answered an unkeyed request with an "Access restricted" page; its documentation (`public.chainalysis.com/docs`) answered HTTP 403. Chainalysis's supported product is "Address Screening" (commercial; terms not read).
- **TRM Labs.** Its sanctions API page says it is free and that one fills in a contact form to receive "the API documentation and instructions to get started"; endpoint, limits, lists covered and terms are not public.
- **Elliptic** and others were not read.

Every provider sees each counterparty the user is about to pay, and usually the user's IP address, which is the surveillance the feature text promises not to impose. A provider integration should not be built without the Chairperson's explicit decision and a privacy statement in `docs/PRIVACY.md`.

## 7. Two things not to use

### 7.1 The CSV and free-text lists

As section 3.3 and 3.4 show, the CSV and the UK list carry addresses in free text. Parsing free text guesses; an extract must come from the structured SDN field.

### 7.2 The Chainalysis on-chain oracle

The oracle page now opens: "The Chainalysis Sanctions Oracle is no longer supported or maintained. The smart contract cannot be removed from the blockchain and may remain queryable, but Chainalysis will not add new sanctioned addresses or provide further updates. It is not recommended for new integrations or production sanctions screening." and "Last oracle update was made on March 18, 2026." The page lists no test network. Read on 2026-11-09: the listed Ethereum address `0x40C57923924B5c5c5455c48D93317139ADDaC8fb` holds 3,557 bytes of code on mainnet (code hash `0x2aaadc77…8875`, the same on two RPCs) and none on Ethereum Sepolia, Arbitrum Sepolia, OP Sepolia or Hoodi. On Base Sepolia the same address holds 2,957 bytes of different code (hash `0x7f071e09…a79a`), which is not identified and must not be treated as the oracle (Chainalysis lists a different address for Base mainnet). The oracle is also an on-chain read at confirm time, which an RPC provider can observe.

## 8. Test networks

The lists name no test-network addresses: the SDN labels are currencies with real value, and nothing in the files refers to Sepolia, Hoodi or any test network. Because an Ethereum address is the same on every EVM chain, a listed address will still match on Sepolia, but the match says nothing about the test network. Two honest options, the Chairperson's choice: run the check on main networks only; or allow it on test networks for demonstration, with the warning saying "this address string appears on the list for <label>; this is a test network, where the list does not apply". The wallet's current test-network demonstrations never send to a listed address, so a live demonstration would need to type one in deliberately, which itself needs a decision.

## 9. Questions for the Chairperson and counsel

1. **Ship a list at all?** Whether a non-custodial wallet that shows such a warning takes on any obligation or implies a compliance service it does not provide (FAQ 560 addresses "technology companies" and "users of digital currencies" generally; how it applies to a self-custody software publisher is a legal question).
2. **Which jurisdictions?** Only the U.S. SDN list publishes addresses in a field; offering it alone may read as U.S.-centric; adding UK free-text or EU data needs a decision on parsing and liability.
3. **Warn or block?** This document recommends warn-only. Blocking would make the wallet decide for the user, and with a stale snapshot it would block delisted addresses (section 3.5) and miss new ones.
4. **Default off?** The feature text says "off-by-default, clearly disclosed"; confirm.
5. **Show the listed name?** It helps the user judge a match but repeats personal data from a government list on screen.
6. **Update cadence.** How old a snapshot may be before the switch says "out of date" or turns itself off.
7. **Test networks:** section 8's two options.
8. **Where the extract lives:** a data file in the repository is public and versioned; whether that is acceptable for this data.
9. **A provider later?** Only with a privacy decision.

## 10. Go / no-go

**Conditional GO for a small slice:** a warn-only, off-by-default check against a pinned extract of the SDN digital-currency field, on the EVM confirm screens' existing counterparties (section 5), exact matching as in section 4.2, the sentence in section 4.3 with its date, silence on a non-match, a build script that records the source hash and publication date, no network request at confirm time, and tests built from synthetic fixtures (never real listed addresses in test code). The condition is the Chairperson's and counsel's answer to questions 1–4 and 7; without it, nothing should be built. Bitcoin, Dogecoin and Solana confirms would follow as a second step once those screens have a risk line.

**NO-GO** for blocking, for any provider API, for the deprecated on-chain oracle, for parsing free-text lists, and for presenting a test-network match as screening.

## 11. Could not verify

- The EU list: the public download answered HTTP 500; whether and how the EU publishes addresses is unknown. Confirm through the Financial Sanctions Files site or the Official Journal.
- OFSI's consolidated list content after its closure (its storage refuses public access); the GOV.UK statement was used instead.
- Whether OFAC publishes a checksum or signature for its export files (none was found; the files were reached through short-lived signed S3 URLs).
- The legal effect of a warning in a non-custodial wallet in any jurisdiction (section 9).
- Chainalysis's and TRM's actual API terms, limits and list coverage (behind a key or a form); Elliptic and other providers were not read.
- The Commission's statement about the Official Journal was read through a web search summary, not on the Commission's page itself.
- Whether the one Tron-shaped identifier under the XBT label is an error in the list; it was only observed.
- The exact size of a shipped extract (estimated, not built).
