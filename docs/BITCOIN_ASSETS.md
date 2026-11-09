# Bitcoin-native assets: Ordinals inscriptions and Runes (feature 42)

**Status:** Research only, written 2026-11-09 against repository HEAD `d001f99` for phase 26 item 5 (`AGENTS.md`, "Phase 26 plan"). Nothing here is built. No transaction was sent, nothing was signed, no key or wallet address was read. Every network call was a read-only HTTP GET made on 2026-11-09 between 22:51 and 22:54 UTC; the time of each is given where it matters. Repository sources were cloned at the commits named in section 2 into a scratch directory and read as text only; none of their code was run. Commits are cited by their first eight characters (the full hashes are in the slice's report, not here, to keep long hexadecimal strings out of this file). Section 10 lists what could not be verified.

This file is plain technical prose for leadership and for the engineers who would build a slice; it follows the model of `docs/LENDING_VAULTS.md` and `docs/STAKING.md`. The persona and compression rules do not apply to it.

## 1. Summary and recommendation

1. **An Ordinals inscription is content attached to one particular satoshi, and the satoshi moves by position.** Ordinal theory numbers every satoshi and moves them through a transaction first-in-first-out: the inputs' satoshis fill the outputs in order, and whatever is left over goes to the miner as the fee. A wallet that does not know which of its coins carry an inscription can hand that inscription to the person it is paying, to its own change, or to the miner, simply by choosing coins and laying out outputs the ordinary way (section 3).
2. **Runes are fungible balances attached to transaction outputs, moved by a message in an `OP_RETURN` output.** A transaction that spends an output holding Runes but carries no Runes message gives all of those Runes to the first output that is not an `OP_RETURN` (section 4). This wallet always places the recipient first, so an ordinary Bitcoin send from an output holding Runes would give the Runes to whoever was being paid.
3. **This wallet is not Ordinals-aware today and nothing in its backends can make it so.** It derives one native-segwit (P2WPKH) address per account, which can receive inscriptions and Runes like any other address. Its coin selection is largest-first over every unspent output its Esplora backend returns, and its "Max" spends every output (section 6). Esplora (Blockstream, mempool.space) and Blockbook return value and confirmation status for each output and nothing about inscriptions or Runes. Only an Ordinals indexer can say which outputs are safe to spend.
4. **The protection a wallet needs is a "do not spend" rule, and it is small.** ord's own wallet locks every output holding an inscription or Runes before it builds an ordinary payment (`src/wallet.rs` lines 165–191 at `1c2c8dee`), and ord's server answers "which of this address's outputs hold neither" in one request (`/outputs/<address>?type=cardinal`). In this wallet the rule plugs in between fetching the outputs and calling `buildTransfer`, in two functions of `app/src/wallet/send.ts`, plus a guard in the engine (section 7).
5. **No keyless, reliable Ordinals index exists for the test networks today.** ord's documentation names hosted explorers at `signet.ordinals.com` and `testnet.ordinals.com`; neither name resolved on 2026-11-09, and the main-network `ordinals.com` answered a script with a Cloudflare challenge (HTTP 403). Hiro, whose Ordinals and Runes APIs were the usual hosted choice, has announced their deprecation and recommends Xverse. Xverse's API serves the main network and signet (a testnet4 host exists but answered "overload" today) and needs an API key or a per-request Lightning payment. UniSat's testnet3 and signet hosts answered a status request without a key; its testnet4 host refused unauthenticated requests. Best in Slot's hosted API is retired. Running ord oneself against one's own Bitcoin Core node is the only keyless option, and it is the most trustworthy one (section 8).
6. **Bitcoin's test networks are all alive.** Blockstream's and mempool.space's Esplora instances both served testnet3 (tip 5,322,592), testnet4 (tip 160,233) and signet (tip 330,151) with recent blocks. Bitcoin Core 28.0's release notes say support for testnet3 is meant to be phased out; no later release note through 31.1 mentions its removal. ord supports testnet3, testnet4 and signet. The app itself has no Bitcoin test network: its Bitcoin slot is the main network only, and the test networks are reachable from the smoke scripts alone.
7. **Dogecoin "Doginals" exist as a community protocol described in one README, not as a specification.** The indexers are forks of an early ord, they disagree with each other on how satoshis (koinu) are numbered, the original fork has not been updated since March 2023, and no public keyless API or test-network index was found (section 5). The wallet's Dogecoin side has no default backend at all.

**Recommendation.** A **go**, test networks only and conditional on three inputs, for a **protect-only slice**: on a Bitcoin test network (signet first, testnet4 second; not testnet3, which Bitcoin Core intends to drop), spend only outputs that an Ordinals index positively reports as holding neither inscriptions nor Runes, refuse everything else with a plain sentence, refuse to send at all when the index cannot be read or is behind, and show nothing about the inscriptions or Runes themselves. The inputs are (a) the Chairperson's choice of index — a self-hosted ord server (keyless, trusted only as far as the person running it) or Xverse's keyed API (a third party that sees every address asked about); (b) a Bitcoin test-network switch in the app, which does not exist today and is a prerequisite slice like Solana's devnet switch; (c) test coins and at least one test inscription and one test Rune held by a wallet address, to prove the refusal live. A **no-go** for now for displaying inscriptions or Runes, sending them, inscribing, etching or minting, for anything on Dogecoin, and for any of this on the main network. Independently of any index, one sentence on the main-network Bitcoin send screen would be honest and cheap today: this wallet does not track inscriptions or Runes, and coins sent to its address that carry them can be spent away by an ordinary send (section 9).

## 2. Sources

| Source | Pinned at / fetched | Used for |
|---|---|---|
| `ordinals/ord` (the reference implementation, version 0.29.1 in `Cargo.toml`) | commit `1c2c8dee` (2026-11-01), cloned 2026-11-09 | the handbook under `docs/src/` (`overview.md`, `faq.md`, `inscriptions.md`, `runes.md`, `runes/specification.md`, `guides/wallet.md`, `guides/api.md`, `guides/explorer.md`, `guides/testing.md`); the source `src/wallet.rs`, `src/wallet/transaction_builder.rs`, `src/index/updater/rune_updater.rs`, `src/subcommand/server.rs`, `src/chain.rs`, `src/lib.rs`, `crates/ordinals/src/rune.rs` |
| `Blockstream/esplora` | commit `57ae2e7f`, `API.md` fetched 2026-11-09 | what Esplora's UTXO and transaction endpoints return |
| `trezor/blockbook` | commit `f39be4db`, `docs/api.md` and `openapi.yaml` fetched 2026-11-09 | what Blockbook's API returns |
| `mempool/mempool` | commit `cfe242ee`, `frontend/src/app/docs/api-docs/api-docs-data.ts` fetched 2026-11-09 | whether mempool.space documents any Ordinals or Runes endpoint |
| `bitcoin-core/bitcoincore.org` | commit `08331130`, `_releases/28.0.md` to `31.1.md` fetched 2026-11-09 | testnet3 and testnet4 in Bitcoin Core's release notes |
| `apezord/doginals` | commit `5c586d5e` (2023-03-17) | the Doginals protocol description (`README.md`) and minter (`doginals.js`) |
| `apezord/ord-dogecoin` | commit `73b220f3` (2023-03-15) | the original Dogecoin fork of ord (`README.md`) |
| `Trac-Systems/ord-dogecoin` | commit `1ae4f3fe` (2025-01-12) | a later Dogecoin indexer fork (`README.md`) |
| Hiro | https://www.hiro.so/blog/upcoming-deprecation-of-ordinals-runes-and-brc-20-apis, fetched 2026-11-09 | the deprecation of Hiro's Ordinals and Runes APIs |
| Xverse API | https://docs.xverse.app/api/get-started, fetched 2026-11-09; `https://api-signet.secretkeylabs.io/openapi.json` fetched 2026-11-09 | Xverse's hosts, keys and endpoints |
| UniSat | https://docs.unisat.io/developer-support/open-api-documentation, fetched 2026-11-09 | UniSat's hosts and keys |
| Best in Slot | https://docs.bestinslot.xyz/api-reference/overview.md, fetched 2026-11-09 | the retirement of its hosted API |
| This repository | `d001f99` | `packages/chains-utxo/src/*`, `packages/core/src/chains/utxo.ts`, `app/src/wallet/send.ts`, `app/src/wallet/balances.ts`, `app/src/config/defaults.ts`, `scripts/testnet/config.mjs`, `docs/FEATURE_UNIVERSE.md` row 42 |

## 3. Ordinals inscriptions at the protocol level

### 3.1 Ordinal theory: numbered satoshis that move first-in-first-out

ord's overview states the two halves of ordinal theory in one sentence: satoshis are numbered in the order in which they are mined, and transferred from transaction inputs to outputs first-in-first-out (`docs/src/overview.md` lines 4–10). Nothing about this is enforced by Bitcoin's consensus rules; it is a convention that indexers apply to the ordinary transaction graph. A satoshi's number is therefore a fact an indexer computes, not something a node or an Esplora server knows.

The handbook's FAQ walks through the transfer rule (`docs/src/faq.md` lines 45–90). Think of the inputs as one long list of satoshis in input order, and of the outputs as slots in output order; each input satoshi fills the first free slot. If the inputs hold more satoshis than the outputs, the surplus — the satoshis at the end of the input list — has nowhere to go and is paid to the miner as the fee, where it is treated as an extra input to the block's coinbase transaction. Three consequences follow for any wallet:

- **Input order matters.** Which satoshi lands where depends on the order of inputs as well as their values.
- **Output order matters.** The first output receives the first satoshis.
- **The fee is the tail.** A satoshi near the end of the last input is the one most likely to be paid to the miner.

### 3.2 Inscriptions: content in a taproot witness, attached to the first satoshi

An inscription attaches arbitrary content (a content type and a byte string, the model of an HTTP response) to a satoshi (`docs/src/inscriptions.md` lines 4–19). The content is stored in a taproot script-path spend, so it sits in the witness of a transaction input and benefits from the witness discount (lines 21–24). Because a taproot script-path spend can only spend an existing taproot output, an inscription is made in two transactions: a *commit* transaction creates a taproot output committing to a script that holds the content, and a *reveal* transaction spends it, revealing the content on-chain (lines 26–31).

The content is wrapped in an *envelope*: an `OP_FALSE OP_IF … OP_ENDIF` block of data pushes that the script never executes, starting with the push `ord` so it cannot be confused with other uses of envelopes (lines 33–37, 53–54). Tagged fields follow (content type, pointer, parent, metadata, delegate and others; thirteen are defined, table at lines 79–95), with an "it is fine to be odd" rule: an unknown odd tag can be ignored, while an unknown even tag makes the inscription "unbound", without a location (lines 100–109).

Most important for a wallet: the inscription is made **on the first satoshi of its input** unless a pointer field says otherwise (lines 62–65), and from then on that satoshi is tracked by the first-in-first-out rule, so it can be "transferred, bought, sold, lost to fees, and recovered" (line 65). The inscription is identified by the reveal transaction's id and an index (`<txid>i<n>`, lines 114–121).

ord's own wallet sends inscriptions in small outputs: its target "postage" is 10,000 satoshis and at most 20,000 (`src/lib.rs` line 156 `TARGET_POSTAGE`, `src/wallet/transaction_builder.rs` line 138 `MAX_POSTAGE`). An inscription therefore usually arrives in a small output, which matters for this wallet's largest-first coin selection (section 6.3).

### 3.3 What a wallet must do to avoid destroying an inscription

ord's wallet guide is direct: working with inscriptions requires a wallet that can "perform sat control" when building transactions, and Bitcoin Core's own wallet does not (`docs/src/guides/wallet.md` lines 10–15). For an *ordinary* payment — one that is not trying to move an inscription — "sat control" reduces to a single rule:

> Never spend an output that holds an inscribed satoshi as part of an ordinary payment.

ord itself enforces exactly this. Its wallet's `lock_non_cardinal_outputs` collects every output that holds an inscription, adds every output that holds Runes, and asks the Bitcoin Core node to lock them so that the node's coin selection cannot pick them (`src/wallet.rs` lines 165–191). ord calls the remaining outputs *cardinal*; when they are not enough its transaction builder fails with "wallet does not contain enough cardinal UTXOs" rather than reaching for an inscribed one (`src/wallet/transaction_builder.rs` lines 83–86). The header comment of that file opens with "Ordinal transaction construction is fraught" (line 1).

The rule needs one input the wallet does not have today: **which of its outputs hold inscriptions**. Only an index that has followed every satoshi from the first inscription height can answer it. ord's server answers it per output (`GET /output/<outpoint>`, with an `inscriptions` list and a `runes` map) and per address (`GET /outputs/<address>?type=cardinal`, "return UTXOs not containing inscriptions or runes"; the `type` values `any`, `cardinal`, `inscribed` and `runic` are documented in `docs/src/guides/api.md` around line 2051 and implemented in `src/subcommand/server.rs` lines 953–996). The per-address listing needs the server to run with its address index (`--index-addresses`, `api.md` line 22) and refuses a `type` filter unless both the inscription and Runes indexes are on (`server.rs` lines 955–966). Each output answer also carries an `indexed` flag that is false when the server has not indexed that output (`src/index.rs` lines 2585–2606) — a wallet must treat such an answer as "unknown", not "empty".

## 4. Runes

### 4.1 What the protocol says, and who decides

ord's specification page opens by saying it is not a specification: the code of `ord` is the normative specification of Runes, the prose is a guide to it, and services are "strongly encouraged" to use `ord` itself to build Runes transactions and to determine balances (`docs/src/runes/specification.md` lines 1–18). Any wallet that implements Runes on its own does so at its own risk by the protocol author's own words. The protocol activated at block 840,000 on the main network (line 24); on testnet3 the first Runes height is 2,520,000, and on signet and testnet4 it is 0 (`crates/ordinals/src/rune.rs` lines 50–59, twelve halving intervals of 210,000 for testnet3).

### 4.2 Runestones, etching, minting, transfers

A Runes message, a *runestone*, sits in an output whose script begins `OP_RETURN OP_13`, followed by data pushes that are concatenated and decoded as a sequence of 128-bit LEB128 integers (`docs/src/runes.md` lines 13–20; `specification.md` lines 91–135). A transaction has at most one runestone, and only the first `OP_RETURN OP_13` output is read (lines 112–113). A runestone can *etch* a new Rune (its name of up to 26 letters, divisibility, symbol, premine and mint terms, all immutable once etched), *mint* an existing Rune whose mint terms are open, and *transfer* Runes with *edicts* (`specification.md` lines 26–90 for the fields, 402–535 for executing a runestone).

Runes are balances held by outputs, and one output can hold balances of any number of Runes (`runes.md` line 25). An edict names a Rune, an amount and an output; edicts are processed in order against the transaction's "unallocated" Runes, which start as all the Runes in the inputs plus anything minted or premined (`specification.md` lines 494–528).

### 4.3 Where Runes go when nobody says

Two rules decide what happens to Runes a transaction does not explicitly allocate:

- **Unallocated Runes go to a default output.** If the runestone has a `Pointer`, they go to that output; if not, to the first output that is not an `OP_RETURN` (`specification.md` lines 320–325). ord's indexer applies the same default **when the transaction carries no runestone at all**: with no artifact, the pointer is absent and every unallocated balance is assigned to the first non-`OP_RETURN` output (`src/index/updater/rune_updater.rs` lines 136–161). Only when every output is an `OP_RETURN` are they burned (lines 162–167).
- **A cenotaph burns everything.** A malformed runestone — an unknown even tag, an unknown flag, an edict pointing past the last output, a pointer past the last output, trailing integers, a non-push opcode, a bad varint — is a *cenotaph*: all Runes input to the transaction are burned, and an etching or mint in it is spent but its Runes are burned (`specification.md` lines 379–395; `rune_updater.rs` lines 132–135).

### 4.4 What a wallet needs

To **show** a Runes balance a wallet needs, for each of its outputs, the Runes balances an index has computed (ord: the `runes` map of `/output/<outpoint>`, or `/address/<address>`'s `runes_balances` with the address index on; Xverse: `/v1/runes/address/{address}/utxo`, section 8). The amounts are integers that must be scaled by each Rune's divisibility. Names may contain spacers (bullets) that do not affect uniqueness (`runes.md` lines 39–52), so a look-alike rule like the wallet's token rule would be needed.

To **transfer** Runes without burning or misdirecting them, a wallet must build a correct runestone (edicts sorted by Rune ID and delta-encoded, `specification.md` lines 162–203), make sure every edict's output exists, decide the pointer, and make sure the *change* of Runes lands on an output it controls. A one-byte mistake produces a cenotaph and burns every Rune in the inputs. Given the protocol author's own advice to use ord for this, a wallet-built Runes transfer is out of scope for any first slice.

To **avoid losing** Runes during an ordinary Bitcoin payment the same "do not spend" rule as for inscriptions applies, and ord applies it to both (`src/wallet.rs` line 183 adds the "runic" outputs to the locked set).

## 5. Dogecoin: Doginals and what is documented

**What exists.** `apezord/doginals` describes itself as "a minter and protocol for inscriptions on Dogecoin" (`README.md` line 3). Its "Protocol" section is the whole written description: an inscription is the familiar series of pushes starting with `ord`, with three extensions — content split into numbered parts counting down to zero, encoding in **P2SH** redeem scripts (Dogecoin has no segwit and no taproot), and parts allowed to chain across several transactions (README, section "Protocol"). Its minter caps a chunk at 240 bytes and builds P2SH locking scripts that drop the pushes (`doginals.js` lines 247–316). The README itself advises minting into a fresh wallet holding nothing else "until proper wallet for doginals support comes".

**The indexers.** The original indexer `apezord/ord-dogecoin` was last committed on 2023-03-15; its README warns that Dogecoin reorganises more often than Bitcoin and that the ord code it is based on "does not handle reorgs", and recommends periodic database checkpoints. A later fork, `Trac-Systems/ord-dogecoin` (last commit 2025-01-12), says its code "may still have bugs", that it uses "the real wonky block rewards" for blocks 0 to 144,999 where the earlier fork used a simplified schedule, and that its pre-indexed file is about 300 GB and omits DRC-20 and "Dunes" data. The two forks therefore number koinu differently for the early blocks, which means **two Doginals indexers can disagree on which koinu carry an inscription**. The canonical repository the Trac fork names for its OpenAPI file (`verydogelabs/wonky-ord-dogecoin`) answered "Repository not found" on 2026-11-09.

**What is not documented.** No written specification beyond the README was found; no Dogecoin Core document mentions Doginals; no public keyless Doginals API and no Dogecoin test-network index were found; the "Dunes" (Runes-like) protocol named in the forks' flags has no specification in any source read.

**What this wallet's Dogecoin side would need.** The wallet's Dogecoin address is P2PKH, so it can receive Doginals (the minter's own example sends to a legacy address). Protection would need a Doginals index the wallet trusts, plus a decision about which numbering is "right". The Dogecoin slot has no default backend today (no keyless Blockbook could be verified; `app/src/config/defaults.ts` around line 160) and no test network in the app. Dogecoin is a **no-go**.

## 6. This wallet today

### 6.1 Addresses and backends

Each Bitcoin account derives one BIP-84 native-segwit address at `m/84'/0'/<account>'/0/<index>` (`packages/core/src/chains/utxo.ts` lines 50–66 and 86–92); Dogecoin derives a BIP-44 P2PKH address with coin type 3 (lines 101–107). An inscription or Runes balance can be sent to either kind of address by anyone; nothing stops it.

The app's Bitcoin slot is the **main network only**, served by an Esplora backend with two defaults, Blockstream and mempool.space (`app/src/config/defaults.ts` lines 76–100 and 143–151). There is no Bitcoin test network in the app; the testnet3 and signet Esplora endpoints appear only in `scripts/testnet/config.mjs` (lines 13–16) for the smoke script.

### 6.2 What the backends can and cannot tell the wallet

- **Esplora** `GET /address/:address/utxo` returns `txid`, `vout`, `value` and the funding transaction's `status` (`API.md` lines 122–127 at `57ae2e7f`). The engine keeps only `txid`, `vout` and `value` and drops `status` (`packages/chains-utxo/src/transport.ts` lines 36–43), so the app's balance and coin selection include unconfirmed outputs. Esplora's transaction objects do expose each input's `witness` and each output's `scriptpubkey_asm` (`API.md` lines 395–430). From those a wallet could notice that a transaction *revealed* an envelope or carries an `OP_RETURN OP_13` output — but not which satoshi now sits in which of the wallet's outputs, which needs the whole first-in-first-out history since the inscription. Esplora cannot answer the protection question.
- **mempool.space** documents no Ordinals or Runes endpoint (no match for "ordinal", "inscription" or "rune" in `api-docs-data.ts` at `cfe242ee`).
- **Blockbook** (Dogecoin's backend kind) documents no such data either (no match in `openapi.yaml` at `f39be4db`).

### 6.3 Coin selection and the two places it can destroy an asset

`selectCoins` sorts the outputs it is given largest first and adds them until the payment plus fee is covered, with or without change (`packages/chains-utxo/src/coinselect.ts` lines 113–157). `buildTransfer` places the recipient output first and the change last (`transfer.ts` lines 77–103). Two app functions feed it every output the backend returned:

- **An ordinary send** — `prepareUtxoSend` fetches the outputs (`app/src/wallet/send.ts` line 1322) and passes them all to `buildTransfer` (line 1340). A small inscribed output is picked only when the larger ones are not enough, but then it is spent like any other. Whether its inscribed satoshi then goes to the recipient, to the change or to the miner depends on the amounts and the satoshi's position; the wallet has no way to know which.
- **Max** — `maxUtxoSend` sums every output (line 1375) and prices a transaction spending all of them into one output (line 1380). A Max send therefore always spends every inscribed output the address holds. With largest-first order an inscribed satoshi at the start of a small output sits near the end of the input list; it goes to the miner when the fee is larger than the distance from that satoshi to the end, and to the recipient otherwise.
- **Runes** — any spend of an output holding Runes, by either path, carries no runestone (the wallet never writes an `OP_RETURN`), so by section 4.3 every Rune in the inputs goes to the first non-`OP_RETURN` output, which in this wallet is always the recipient. The Runes are not burned; they are given away.

The balance on Home is also the sum of every output, inscribed ones included (`app/src/wallet/balances.ts` lines 34–37), so it overstates what can safely be spent once inscriptions are present.

Two further facts bound any future "send an inscription" work: the engine refuses taproot recipient addresses ("Taproot (P2TR) addresses are not supported yet", `packages/chains-utxo/src/address.ts` lines 184–202), and most Ordinals tooling, ord's included, receives at taproot addresses; and the engine signs only P2WPKH and P2PKH inputs (`tx.ts` lines 18–25), so it can spend an inscription that arrived at the wallet's own address but could not take part in a commit/reveal.

## 7. Where an inscription-aware "do not spend" set would plug in

### 7.1 The minimum honest slice: protect

The smallest change that would make the wallet safe to hold Ordinals and Runes is **a positive list of spendable outputs**, taken from an index, applied before coin selection:

1. **Fetch both lists.** Keep Esplora's `/address/:address/utxo` as the source of what exists, and ask the index which of the address's outputs are *cardinal* (ord: `/outputs/<address>?type=cardinal`; Xverse: its per-UTXO listing, filtered to outputs with no inscriptions and no Runes).
2. **Spend only the intersection, and only confirmed outputs.** An output is spendable only if Esplora lists it, its funding transaction is confirmed (which needs the engine's `Utxo` to keep Esplora's `status`), the index reports it explicitly as cardinal, and the index has indexed it (ord's `indexed` flag; Xverse lists confirmed outputs only). Using the index's *positive* list rather than subtracting its *inscribed* list makes the slice fail closed: an output the index forgot or has not reached is not spent.
3. **Refuse when unsure.** Refuse to quote — with no "send anyway" — when the index cannot be read, when its height is below the Esplora tip of the confirmed outputs in question (ord's `/status` gives `height`; `api.md` around line 5215), or when it answers for another network. Refuse Max the same way; Max then means "all cardinal outputs".
4. **Say what was left out.** On the send form: "N outputs at this address hold inscriptions or Runes, according to <index>; this wallet does not spend them. They are not counted in the amount you can send." On Home: the spendable balance and, separately, the value held in protected outputs, without naming or showing the assets.

**Where it goes in the code.** The filter belongs between `transport.getUtxos(fromAddress)` and `buildTransfer` in `prepareUtxoSend` (`send.ts` lines 1312–1340) and in `maxUtxoSend` (lines 1362–1380), so both the quote and Max see only the spendable set. As defence in depth the engine's pure `buildTransfer` (`transfer.ts` line 53) would take an optional set of protected outpoints and throw if a selected input is in it, so that no future caller can bypass the app's filter; `selectCoins` itself needs no change. The `UtxoTransport.getUtxos` shape gains the confirmation status; the index is a new transport kind (an "ordinals-index" endpoint in Settings beside the Esplora one), with the same verify-before-save, chain-identity and freshness probes the Esplora endpoints already have (`app/src/config/endpoint-probe.ts`).

**What it does not do.** It does not show, send, receive-track, inscribe, etch or mint anything; it does not tell the user what the protected outputs hold; it does not help with Dogecoin.

### 7.2 A display slice, and why it waits

A display slice would list each inscription (id, number, content type, perhaps a rendered preview) and each Runes balance (name with spacers, symbol, amount scaled by divisibility). It adds risk without adding protection: inscription content is arbitrary bytes, often HTML and SVG that the ord handbook serves as web pages (`inscriptions.md` lines 15–19), so rendering it raises the same questions the NFT gallery answers today by not rendering SVG; Runes names invite look-alikes. It should follow a protect slice that has been proven live, not precede it.

### 7.3 A send slice, and why it waits longer

Sending an inscription needs sat control proper — putting the inscribed output first, keeping its value near postage, paying the fee from other inputs, adding change carefully — plus taproot recipient support the engine does not have. Sending Runes needs a correct runestone, where a mistake burns everything (section 4.3). ord's transaction builder, whose own header calls ordinal-aware construction "fraught", is 2,213 lines of Rust including its tests (`src/wallet/transaction_builder.rs` at `1c2c8dee`). Neither is a candidate for this phase.

## 8. Indexers and test networks as of 2026-11-09

### 8.1 Esplora on the test networks

| Network | Blockstream (`blockstream.info/<net>/api`) | mempool.space (`mempool.space/<net>/api`) | Tip block time |
|---|---|---|---|
| testnet3 (`/testnet`) | tip 5,322,592 | tip 5,322,592 | 2026-11-10 00:34:54 UTC |
| testnet4 (`/testnet4`) | tip 160,233 | tip 160,233 | 2026-11-10 00:35:26 UTC |
| signet (`/signet`) | tip 330,151 | tip 330,151 | 2026-11-09 22:26:45 UTC |
| main network (`/api`) | tip 975,222 | tip 975,222 | 2026-11-09 22:43:09 UTC |

Read at 22:53:50 UTC; each instance's height-0 block hash matched the expected genesis prefix of its network. The testnet3 and testnet4 tip timestamps are ahead of the wall clock at the moment of reading. This is most likely miners setting block times ahead of real time, which Bitcoin allows within a limit, rather than a fault of the endpoint; that explanation is an inference, not verified. Both providers serve all three test networks, so the wallet's existing Esplora transport would work unchanged on any of them.

**testnet3's future.** Bitcoin Core 28.0's release notes add testnet4 (BIP94) and say the intention is to phase out testnet3 in an upcoming version while still supporting it for now (`_releases/28.0.md` lines 77–86). The notes for 29.0 mention BIP94 only in other contexts, and the notes for 30.0, 30.1, 31.0 and 31.1 do not mention testnet3 at all. Whether a later Bitcoin Core has removed it is therefore not established from the release notes; secondary sources disagree. The repository's smoke script was funded on testnet3 (`scripts/testnet/config.mjs` lines 7–10). A new slice should use signet or testnet4.

### 8.2 Ordinals and Runes indexes

| Index | Networks | Key | Status on 2026-11-09 |
|---|---|---|---|
| **ord, self-hosted** (`ord server` against one's own Bitcoin Core with `-txindex`) | main, testnet3 (`--testnet`), testnet4 (`--testnet4`), signet (`--signet`), regtest (`src/chain.rs` lines 10–13, 116–133) | none | Software at 0.29.1. Needs a full node of the chosen network plus ord's own index; disk size and sync time on a test network not measured. The testing guide lists only the testnet, signet and regtest flags (`guides/testing.md` lines 54–58), although the code supports testnet4. On test networks ord limits inscription content to 1,024 bytes (`chain.rs` lines 38–42). |
| **ordinals.com** (ord's public explorer) | main; the handbook also names `signet.ordinals.com` and `testnet.ordinals.com` (`guides/explorer.md` lines 4–7) | none | Main network answered a script with HTTP 403 and a Cloudflare challenge page (22:51 UTC). `signet.`, `testnet.` and `testnet4.ordinals.com` did not resolve in DNS. Not usable by an app. |
| **Hiro** Ordinals API and Runes API | main (a Hiro documentation page, seen only as a search-result summary and not fetched, said there is no test-network version) | `x-api-key` | Hiro's blog announces the deprecation of its Ordinals, BRC-20 and Runes APIs and its Bitcoin indexer and recommends migrating to Xverse; the page gives the effective date as 9 March 2026 but is dated 11 August 2026, so one of the dates is wrong on the page. `api.hiro.so/ordinals/v1/` and `api.testnet.hiro.so/ordinals/v1/` both answered 403 "Missing Authentication Token". Not usable. |
| **Xverse API** (Secret Key Labs) | main `api.secretkeylabs.io`, signet `api-signet.secretkeylabs.io` (get-started page); a testnet4 host `api-testnet4.secretkeylabs.io` exists | `x-api-key` from a free trial in its dashboard, or no key with a 1-satoshi Lightning payment per request (the "Machine Payments Protocol", per the get-started page) | Main and signet hosts answered with an API reference page; the signet OpenAPI document (`openapi.json`, 141 paths) declares an `x-api-key` scheme for every call, and a keyless call answered 403. The testnet4 host answered 503 "unconditional drop overload". `GET /v2/ordinals/address/{address}/utxo` returns, for every **confirmed** output of the address, its inscriptions (with each inscription's offset) and Runes; `GET /v1/runes/address/{address}/utxo` returns the Rune-holding outputs with names, amounts and divisibility. |
| **UniSat Open API** | main `open-api.unisat.io`; `open-api-testnet.unisat.io`; `open-api-signet.unisat.io` and `open-api-testnet4.unisat.io` hosts exist | `Authorization: Bearer <key>`; a free plan of 5 calls per second and 2,000 per day per its documentation | `/v1/indexer/blockchain/info` answered without a key on the testnet host (height 5,322,593, which matches testnet3) and the signet host (330,152); the testnet4 host refused with "exceeded the request limit for unauthenticated requests". Which UniSat endpoint lists an address's safe outputs, and whether it works without a key, was not verified. |
| **Best in Slot** | formerly main, testnet4 and signet | formerly `x-api-key` | Its documentation now says the hosted API "has been retired" and no new keys are issued; it points to its self-hosted OPI indexer, which covers BRC-20, Bitmap and SNS. Not usable. |
| **mempool.space, Blockstream Esplora, Blockbook** | — | — | No Ordinals or Runes data (section 6.2). |

**What this means.** For a test-network protect slice the realistic choices are a self-hosted ord server (keyless, needs a machine and a node, trusted as far as its operator) or Xverse's signet API (keyed or paid per request, a third party). UniSat is a possible third if its address endpoints prove to work. Signet has the best hosted coverage today (Xverse documents it; UniSat answered on it); testnet4 is Bitcoin Core's chosen successor to testnet3 but its hosted indexes answered "overload" and "authentication required" today.

## 9. Risks and honest claims

**The index is a trusted third party.** Whatever the wallet claims about protection is only as good as the index's answer. An index that is behind, buggy, pointed at the wrong network or malicious can report an inscribed output as cardinal, and the wallet would then spend it. The only claim the wallet can make honestly is of the form: "This wallet does not spend outputs that <index> reports as holding inscriptions or Runes. It relies on that index; if the index is wrong, an inscription or Runes balance can still be lost." It must not say "your inscriptions are safe" or "your inscriptions are protected" without naming the index.

**Privacy.** Asking a hosted index about an address tells that service which addresses the user controls and when the wallet is used, in addition to what Esplora already learns. A self-hosted index avoids this. The Settings text for the index endpoint should say so.

**Freshness and reorganisations.** ord indexes blocks, not the mempool; an output funded by an unconfirmed transaction has no answer, which is why the slice spends confirmed outputs only. ord's status reports `unrecoverably_reorged` (`api.md` around line 5215); a reorganisation can move a satoshi's position, so the height check must be made at each quote, not cached.

**Disagreement between indexers.** Different indexers can disagree (most visibly on Dogecoin, section 5; on Bitcoin, at least in edge cases such as "cursed" inscriptions, which ord's status counts separately). The wallet should not mix indexes for one decision.

**What the wallet cannot claim today, with no index.** Nothing about inscriptions or Runes. It can say, truthfully and on the main network today, that it does not track them and that an ordinary send or Max can spend outputs holding them — a single sentence on the Bitcoin send form and in the Bitcoin row's help text, at no cost. Whether to add it is the Chairperson's call; the risk it describes exists on the main network now for any user who receives an inscription or Runes at their Shiba Wallet address.

**Fees and dust.** Protected outputs are usually small; a user with only small, protected outputs will see "not enough to send" while the balance looks positive. The send form's sentence above prevents that confusion. Dust policy (546 / 294 satoshis, `dust.ts`) is unchanged.

**Licence.** ord's `LICENSE` file at `1c2c8dee` is the Creative Commons CC0 1.0 Universal dedication. Running ord as a separate server raises no licence question for the wallet; whether copying its logic into the wallet would raise any is a question for counsel, not settled here.

## 10. Could not verify

1. Whether CC0 covers every file ord ships (only the top-level `LICENSE` was read).
2. The disk size, memory and sync time of an ord index on signet, testnet4 or testnet3, and whether a Bitcoin Core node for those networks fits on the hardware the project has.
3. Whether `signet.ordinals.com` and `testnet.ordinals.com` have moved to other names or were retired; only that the names in ord's handbook did not resolve on 2026-11-09.
4. The actual effective date of Hiro's deprecation (the blog page gives 9 March 2026 and is dated 11 August 2026), and whether any Hiro Ordinals route still answers with a key.
5. Whether Xverse's testnet4 host works when not overloaded, whether its free trial covers signet, its rate limits, and what its 1-satoshi-per-request Lightning payment requires of a client.
6. Which UniSat endpoints list an address's cardinal, inscribed and Runes-holding outputs, whether they answer without a key, and which networks its `testnet` host serves (testnet3 is inferred from the block height only).
7. Whether any keyless public ord server exists for any test network.
8. Whether a later Bitcoin Core release removed testnet3; the release notes through 31.1 do not say so, and secondary sources disagree.
9. Faucets for signet and testnet4 coins and their limits; whether the project's dev wallet holds signet or testnet4 coins (the record says testnet3 was funded; no address was read for this document).
10. How a test inscription and a test Rune would be obtained for a live proof (ord's own wallet against a node, or a third-party service on signet), and at what cost.
11. That inscriptions and Runes have actually been received at any address of this wallet; nothing was looked up for the wallet's addresses.
12. Any Doginals specification beyond the `apezord/doginals` README; the canonical `wonky-ord-dogecoin` repository (not found under the name the Trac fork gives); any Dogecoin test-network index; any "Dunes" specification.
13. The behaviour of "cursed" inscriptions, the "jubilee" heights (`chain.rs` lines 59–67) and inscriptions with unknown even tags in any hosted index; only ord's own handbook was read.
14. That Esplora's `status` field is present on every provider's UTXO answer for the test networks (documented in `API.md`; not checked against a live address).
15. Any audit of ord's indexer or wallet code; none was searched for.
