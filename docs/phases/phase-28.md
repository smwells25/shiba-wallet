# Phase 28 — full progress record

The full record of each phase 28 slice and pass, in order. AGENTS.md keeps
a summary of at most five lines per entry and points here. The first four
entries were moved verbatim from AGENTS.md on 2026-11-20.

- [x] Item 1 — THE PRE-PROMPT ESTIMATE ON THE REMAINING SMART-ACCOUNT PATHS,
      AND A TRUTHFUL BUSY LINE FOR COLD SIGNING (commit 2af4bc5; 29 files,
      +1,153 / −118, no new file, no new dependency; engine 1,441 → 1,447
      (chains-evm 971; smart-account.test 55 → 61), check-aa 479 (was 467),
      check-passkeys 162 (153), check-token-gas 270 (264), check-recovery 282
      (276), check-sessions 153 (149), check-recurring 218 (215), check-dca
      175 (172), check-subscriptions 203 (199), check-cold-aa 131 (127),
      check-i18n 215; offline runner ALL GREEN in the CTO's isolated worktree
      on HEAD 924cdfb with --skip-bundle: checkout 0 / apply 0 / 29 files,
      the staged patch id a57507b35329 equal to the verified worktree's and
      the agent's, the engine rebuilt, app 12,256 across 68 suites, lint 0/0,
      tsc clean; the pre-commit scan clean; 17 hand mutants and the new
      in-suite mutants caught by the agent; the CTO read the sessions.ts
      hunk; not seen on a device, nothing live). ENGINE: the first half of
      buildUnsignedOperation extracted unchanged into estimationStub, and
      SmartAccountClient.estimateBeforeSigning(owner, calls, fees) — refuses
      an EIP-7702 spec before any request (building its operation signs an
      authorization), builds the same stub sendCalls builds, runs one checked
      estimate under the client's retry policy and returns a
      PreCheckedGasEstimate; signs and sends nothing; works with an
      address-only owner. (a) PASSKEY: the passkey quote is a copy of a
      prepareAaCalls quote, so aa.ts carryPrePromptEstimate gives the copy
      the original's check; sendPasskeyCalls hands the kept estimate to
      sendCalls; the Passkey screen's test operation runs under the guard
      with the check before the prompt. (b) USDC FEE: CIRCLE — NOTHING BUILT
      AND NONE CAN BE HONEST: its estimation stub carries a real EIP-2612
      permit signed by the owner (token-paymaster.ts
      createCirclePaymasterTransport), i.e. an owner signature before the
      device prompt, and a placeholder permit grants no allowance while the
      paymaster pulls during validation; the stage stays "final" there;
      ERC-7677 (Pimlico) — built: one estimate of the exact calls with the
      paymaster's stub data before the prompt, never the final data, and NO
      stand-in reuse (a paymaster takes part). (c) GUARDIAN RECOVERY: a
      shared guardianSubmitClient serves the check and the submission, which
      hands over the kept estimate. (d) SESSIONS: the subscription, recurring
      and DCA Start handlers run checkAaQuoteBeforeApproval after the
      re-quote and before the device check; sendSessionCalls (pay now, swap
      now, session operations) is reordered — chain id, spec, FEES, client,
      the estimate with the session key's ADDRESS only, THEN the vault read
      (the key's system prompt), then sendCalls with the stand-in —
      BEHAVIOUR CHANGE: the fees are read before the key, not after; the
      session paths still never read the recovery phrase. NOT COVERED: the
      Sessions screen's manual test operation asks its device check before
      sendSessionCalls (the estimate still precedes the key read); pay-now
      and swap-now show no busy line (the in-app dialog precedes them and
      "before asking you to approve" would be untrue for an unprotected
      key). (e) COLD SIGNING: coldSign.prePrompt.show "Checking the spending
      limits, the bundler's minimum fee and its gas estimate before the
      request for the off-line signer is shown. This can take up to about a
      minute; nothing has been signed or sent." and coldSign.prePrompt.submit
      "Checking the signature, the account's nonce and deployment and the
      bundler's minimum fee, then handing the signed operation to the
      bundler. This phone signs nothing here." (Spanish drafts; "about a
      minute" because Show runs two estimates); check-cold-aa requires them
      and still forbids the confirm's line on that screen. COST: one more
      bundler estimate per approval on the ERC-7677, guardian and passkey
      paths and one per session send. UNVERIFIED: every layout and spoken
      line; ZeroDev's answer to an ERC-7677 stub estimate from an
      address-only owner; any live run. Slip: one build log written to /tmp
      and deleted at once.
- [x] Item 2 — A BITCOIN SIGNET SWITCH, AND THE BITCOIN MAINNET SEND FORM
      NAMING ITS NETWORK (commit d3a79be; 44 files, +1,517 / −87, three new
      — app/src/wallet/bitcoin-signet.ts, components/BitcoinSignetBanner.tsx,
      app/scripts/check-btc-signet.mjs (65 checks, 10 in-suite mutants)
      registered in suites.mjs; engine +5 (core +3, chains-utxo +2);
      check-pnl 208, check-devmode 478, check-home 145, check-doge 112,
      check-notes 229, check-insights 144, check-portfolio 75; the agent's
      patch (id 1472d74be606, cut against 924cdfb) REBASED onto f5e3adc by
      the CTO with a three-way apply — conflicts only in the two string
      tables' and the fixture's appended tails (both blocks kept, item 1
      first) and in check-i18n (both id lists, the new-entries rule naming
      both); the rebased patch id 0309909b5377 equals what was committed; the
      offline runner ALL GREEN on the merged tree with --skip-bundle after an
      engine rebuild: engine 1,452, app 12,338 across 69 suites (= 12,256
      plus this slice's 82), lint 0/0, tsc clean; the pre-commit scan clean;
      ten hand mutants caught by the agent; not seen on a device; nothing
      signed or broadcast; network use read-only). FACTS (read 2026-11-16):
      signet's genesis hash 00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6,
      base58 versions 0x6f / 0xc4 and bech32 HRP "tb" from bitcoin/bitcoin
      src/kernel/chainparams.cpp at 8130b3b8 (SigNetParams); the CAIP-2 id
      bip122:00000008819873e925422c1ff0f99f7c (the first 32 hex characters,
      per the bip122 namespace at 2a9193da) — every signet, custom ones
      included, shares that genesis, so the id cannot tell the default signet
      from a custom one; coin type 1 for test networks (BIP-44, SLIP-44; the
      repository's own testnet scripts already use it); endpoints
      mempool.space/signet/api then blockstream.info/signet/api, each from
      its provider's own documentation and read live (tip 331153 on both, the
      genesis, a header, an address query, fee estimates; a mainnet address
      refused HTTP 400) and through the app's own probe (fresh; a mainnet
      Esplora and testnet4 reported wrong-chain). DESIGN: Settings →
      Developer "Use Bitcoin signet", off by default, only a stored explicit
      true reads as on; DERIVATION m/84'/1'/N'/0/0 — the signet address is
      NOT the mainnet address re-encoded, and the on-note says so; the
      address is cached as public data, and an EXISTING wallet needs the
      phrase once — Home shows a pending card "Work out the signet address"
      (one device prompt "Work out your Bitcoin signet addresses" when the
      phrase is protected, nothing signed) and until then the Bitcoin row is
      LEFT OUT on signet, never the mainnet address on a signet endpoint; the
      whole slot moves (Home, Receive, Send, Max, Activity, the CSV name and
      note key, the pending network id) as "Bitcoin signet" / "test BTC"; a
      bc1 recipient refused on signet and a tb1 one on mainnet; the UTXO
      network and the signing chain come from the endpoint that quoted, so a
      signet quote can only be signed with the signet key; NEVER VALUED (no
      fiat, no profit and loss while the switch is on, the F-94 rule); the
      Ordinals and Runes warning stays mainnet-only (pinned); contacts not
      offered on signet (the store does not take the id); no explorer link
      (none verified); NO readiness row (an ordinary send of valueless coins,
      as the devnet SOL send has none — CTO accepted); Dogecoin and Solana
      untouched. FINDING 9 of pass p27-emu2: the Ethereum TESTNET banner is
      app-wide by design, so it is unchanged and the Bitcoin mainnet Send
      form instead says "This send is on Bitcoin mainnet, with real funds.
      The TESTNET banner at the bottom of the screen is about the Ethereum
      network chosen in Settings → Developer, not about this send." Twelve
      ids with Spanish drafts. KNOWN GAP: the import-check derivePublic call
      in WalletContext still derives without signet (the launch, activate and
      ensureDerived paths add the entry). INPUT for a live send: signet coins
      at Account 1's signet address (a faucet). UNVERIFIED: everything on a
      device; any signet transaction; the endpoints' rate limits. Agent
      slips: a first run red on a check-names pin and two lint warnings
      (fixed); a peek script truncated four files, each restored from its
      copy and confirmed byte-identical.
- [x] EMULATOR PASS p28-emu1 — THE FIRST CCTP BURN FROM A SMART ACCOUNT AND
      MINT TO ONE, THE FIRST OP SEPOLIA CCTP ROUTE, AN EVM SPENDING LIMIT
      REFUSING A REAL SEND, THE f146133 FIXES HEARD (2026-11-16 ~17:10–18:35
      UTC; Expo Go on emulator 37.1.11, Metro moved to wt-app at 924cdfb
      (node 20303 on 8081) — BEFORE items 1 and 2 landed, so neither was
      under test; the REAL wallet; 14 prompts, 13 titles read from the prompt
      window (the first, the C1 burn's, was answered before its title was in
      the dump — a helper slip, fixed for the rest), 2 cancelled on purpose;
      no repository file touched; .dev-wallet never read; nothing from the
      dev EOA; no renewal approved; THE CTO RE-READ all ten receipts on two
      RPCs per network (identical status, block, gas, log count) and the
      three changed USDC balances; the report with dumps and the arithmetic
      in the session scratchpad p28-emu1/REPORT.md; CI green on 71ebda5).
      (C1) BASE SEPOLIA → ARBITRUM SEPOLIA, 0.3 USDC, the Kernel as sender
      AND recipient: the confirm's one-operation sentence, "…Paying it in
      USDC through Circle's paymaster is not offered for bridging in this
      version.", the pinned TokenMessengerV2 risk line; ONE prompt; burn
      bundle 0x0df063e9edce08c4c6e32e42c0c3b341980275da466bbcdcd6d5366b72ac5e51,
      Base block 59643047 (17:34:38 UTC), 227,327 gas, userOp 0x66865c99…2a69
      nonce 11, DepositForBurn 300,000 with depositor and mintRecipient the
      Kernel, destination domain 3; Circle's attestation complete 976–997 s
      after the burn block; "Switch to Arbitrum Sepolia" then the mint FROM
      ACCOUNT 1'S REGULAR ACCOUNT TO THE KERNEL (prompt "Mint the bridged USDC
      on Arbitrum Sepolia") — tx
      0xcda2e049bdc9648f13f35c7070034090173398eb0166e2cdc4be82738af26ab6,
      block 329850783, 154,152 gas, MintAndWithdraw to the Kernel 300,000,
      usedNonces 0 → 1, the Kernel's Arbitrum USDC 745,442 → 1,045,442 and
      its Base USDC 21,466,350 → 21,166,350 (the CTO re-read both),
      "Delivered on Arbitrum Sepolia". (C2) ARBITRUM SEPOLIA → OP SEPOLIA,
      0.2 USDC from Account 1: approve 0xf65a6c36…f220 (block 329851895; the
      approval view's new "Total (worst case)" row and note seen), burn
      0x3555ba54722bbf0cdd7974de830b3229e6740934c28ba1348f6b1f00657b4244
      (block 329852244, 18:05:35 UTC, destination domain 2), the attestation
      complete 1,006–1,026 s after the burn block (THE FIRST MEASUREMENT OF
      THIS ROUTE), "Switch to OP Sepolia", the mint confirm with a separate
      "Layer 1 data fee (estimate)" row (first seen live) and "You receive
      0.2 USDC", mint
      0x7ececa1eb934e4b9d8bab6c1cead55233727ca39cf3e9129b6a42bf45dad13c3, OP
      block 51525470, 171,240 gas, l1Fee 902, Account 1's OP USDC 0 →
      200,000, "Delivered on OP Sepolia". (B) THE EVM SPENDING LIMIT (row
      19): 0.0001 test ETH per 1 hour, "Send anyway" and fee counting off; a
      0.0002 send warned at Review and REFUSED with NO prompt ("Over your
      spending limit" / "…Already spent in this window: 0 test ETH; this
      send: 0.0002 test ETH…"); 0.00005 sent with one prompt (tx
      0x0cfb620eacf0ddab47e733bb0f1da2c0a462ac588905dd0ce2aa24f8a80af255,
      block 12148896, 21,000 gas), the card "Spent in the current window:
      0.00005 of 0.0001 test ETH"; 0.00006 refused before any prompt; the
      limit removed behind its prompt. (A) f146133: four Lend sends from the
      Kernel on Arbitrum Sepolia (two supply-and-withdraw rounds of 0.1 USDC;
      bundles 0xda13fa0e…3a97, 0xebb50269…87ae, 0x34e7a4b6…d5a9,
      0x8cc6ca3d…fc02, blocks 329853341 / 329853903 / 329854998 / 329855515),
      one prompt each and NO refusal after a prompt, three Reviews refused at
      Review during a burst — but nothing shows whether a send-time estimate
      answered zero, so THE STAND-IN IS NOT SHOWN TO HAVE BEEN EXERCISED;
      TalkBack spoke the busy line ONCE and in full, the button's "disabled"
      queued behind it, then "Running the last checks before asking you to
      approve; nothing has been signed." once (the first time that stage was
      heard); the handle's cancel alert reads "Not sent". FINDINGS (fix slice
      dispatched for 2–5): (1) the Mac's screen was locked for the whole
      pass, so the emulator window could not be brought forward, qemu sat at
      PRI 4 for long stretches and dumps took 6–20 s — every timing is
      coarse; (2) the CCTP confirm's "Circle's USDC fee paymaster cannot pay
      for the first mint…" sentence shows for an OP Sepolia destination,
      where that paymaster has no code; (3) a mint sent from the regular
      account to the Kernel previews "No balance changes for your address…"
      and never says the USDC arrives at the smart account; (4) the CCTP
      smart-account burn confirm has no "Total (worst case)" row; (5) the EVM
      over-limit alert lacks the closing "Nothing was signed." the Solana one
      has; (6) the USDC renewal confirm shows the test-ETH limit box
      (harmless); (7) uiautomator drops the measured-time sentence (straight
      quotes; read from a screenshot). NOTED: the Kernel's Base Sepolia USDC
      was 21.466350 at the start, 20 more than the record — untraced, most
      likely a faucet deposit by the Chairperson (not confirmed). SPEND: 0.2
      USDC through Aave and back, 0.5 USDC bridged, 0.00005 test ETH. END
      STATE: Home, Ethereum Sepolia, Account 1, devnet OFF, language System,
      light mode, TalkBack OFF (level 6), protection OFF, IME ADBKeyboard, no
      limit, no Aave position; Metro node 20303 on 8081 from wt-app at
      924cdfb; qemu 86708 with caffeinate 86986.
- [x] Item 5 and the pass p28-emu1 findings — THE SPANISH GAPS, THE CCTP
      CONFIRM LINES, THE OVER-LIMIT ALERT (commit 8ea90f5; 36 files, +3,844
      / −270, one new — the golden fixture
      app/scripts/fixtures/i18n-sixth-pass-golden.json (83 cases over 22
      module functions); no packages/ change; check-bridge 446 (was 433),
      check-i18n 234 (216; mutants 43 → 49), check-spending-policy 202 (196),
      pins changed in place in check-aa, check-spl-tokens, check-devmode and
      check-home, none loosened; offline runner ALL GREEN in the CTO's
      isolated worktree on HEAD df6926b with --skip-bundle: checkout 0 /
      apply 0 / 36 files, the staged patch id c976165cf5ab equal to the
      verified worktree's and the agent's, engine 1,452, app 12,375 across 69
      suites, lint 0/0, tsc clean; the pre-commit scan clean; ten hand
      mutants caught by the agent (one survived first and its check was
      tightened); the agent was cut once by the session limit and resumed;
      not seen on a device). FINDINGS: (2) cctpPaymasterOfferedOn(caip2) =
      tokenGasPaymasterFor(caip2) !== null — the first-mint paymaster
      sentence shows only where Circle's paymaster is offered on the
      RECEIVING network (Base and Arbitrum Sepolia), nothing for an OP or
      Ethereum Sepolia destination; (3) the mint confirm, when the recipient
      written into the burn is not the sending account, says
      (bridge.mint.recipientOther, the one new id) "This mint pays {amount}
      USDC to {recipient}, the recipient written into the burn, not to the
      account sending it ({sender}). The balance-change preview below is
      simulated for the sending account only, so it does not show the USDC
      arriving.", accounts named by label, short addresses in speech; (4) the
      CCTP smart-account burn confirm gains Send's "Total {symbol} (worst
      case)" row (the fee in the network's coin; a burn carries no value);
      (5) spendingBlockAlertText ends "Nothing was signed." only when no
      "Send anyway" is offered — every caller runs the gate before the device
      check (Send, Swap, Staking, Bridge, Lend, Handle, WalletConnect, the
      pending card, cold signing); (6) NOT BUILT: filtering the limit notice
      by the sent asset could hide a limit the gate then applies (a test-ETH
      limit can count fees on a token send). SPANISH: 132 ids in one
      delimited block — 131 migrated from df6926b (86 literals, 33 templates,
      12 composites, each checked against the base commit; the golden replay
      0 differences) and the one new id; covered: both halves of Spending
      limits with the window chips through period-text.ts
      spendingWindowText (the mixed "…durante 1 hour…" sentence now "…durante
      1 hora…"), "Authentication cancelled." and every "Not sent" alert
      title, the balance-change preview's and the risk card's own headings
      and notes, the ENS risk lines, Home's Solana devnet card and token
      lines, the app-built Solana token-send sentences and confirm row
      labels, the "<coin> address" placeholders, the "Use Solana devnet"
      switch and notes. STAYS ENGLISH: prompt titles and the prompt's Cancel,
      header titles registered in App.tsx, engine-built sentences (the SPL
      quote notes, the preview rows "You send …", risk lines other than the
      ENS ones), the DCA and recurring over-limit texts, share texts.
      UNVERIFIED: everything on a device; the Spanish drafts (the reviewer on
      hold). Agent slips: its baseline run overlapped its edits (the brief's
      counts used); a mutant restore reverted a lint fix, caught and
      re-applied before the green run.
