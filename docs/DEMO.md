# Presenting the Wallet: an Account-Abstraction Demo on the Android Emulator

**Audience:** whoever presents the prototype to leadership, partners or reviewers, including someone who has never run the project.
**Purpose:** a step-by-step walkthrough that shows each account-abstraction feature working in the app, in a sensible order, with what to tap, what the audience should see, what each step proves, and what to do when something is missing.
**Evidence base:** every "what it proves" statement points at a run recorded in `AGENTS.md`. The status of each feature across the whole feature map is in `docs/FEATURE_UNIVERSE.md` section 15.

Everything in this walkthrough runs on the **Sepolia test network** with test ETH, except where a step says otherwise. No step needs real money, and the one real-money item (the Dogecoin mainnet demonstration) is shown from its recorded result rather than repeated.

---

## Before you start: three warnings

1. **Do not wipe the wallet on the demo emulator, and do not add or remove a fingerprint on it.** The emulator wallet's recovery phrase is stored in biometric-protected storage, and `AGENTS.md` records that the written phrase for that wallet is not kept anywhere ("Settings 'Recovery phrase protection' section"). Changing the fingerprint enrollment makes the phrase permanently unreadable; wiping deletes it. Either would lose Account 1, which owns the deployed Kernel smart account and the WalletConnect session this demo relies on. Show onboarding on a second, disposable emulator instead (see step 1).
2. **Quoted labels can drift.** Every flow in steps 1 to 9 has now been run live through the app's screens on the emulator (session keys and guardians in phase 10 item 1, the counterfactual deployment in phase 11 item 2). Steps 10 to 18 (subscriptions, Base Sepolia, per-network tokens, the fee in USDC, payment requests and names, watch-only accounts, the second paymaster, the inheritance demonstration and Arbitrum Sepolia) are newer and have each been run live through the app's screens once or twice; see the "progress" sections for phases 12 to 14 in `AGENTS.md`. Later phases keep editing these screens, so if a quoted label differs slightly on screen, trust the screen, and check the latest "progress" section of `AGENTS.md` before presenting. Step 19 (recurring payments) was rehearsed on the emulator on 2026-10-09 (set-up, two payments, the banner, revoke), step 21 (the in-app browser) and step 22 (screen protection) were rehearsed on 2026-10-10, and step 20 (multi-signature by script) runs from a terminal. Every step up to 24 has been rehearsed: the optional reminder in step 19 was proven on 2026-10-11 UTC in the wallet's own development build on the emulator (it cannot be turned on inside Expo Go, which does not register the notification channel provider), and steps 23 (a multi-signature account) and 24 (adding a network) were rehearsed on 2026-10-10. Step 24 now walks through Polygon Amoy because Hoodi is built in; the 2026-10-10 rehearsal used Hoodi, and the Polygon Amoy walk-through itself has not been rehearsed. Steps 25 (the Hoodi and OP Sepolia test networks) and 26 (staking on Sepolia) were rehearsed live in-app on 2026-10-11 (`AGENTS.md`, phase 18, "Items 1 and 2 PROVEN LIVE IN-APP"). Step 27 (a multi-signature account chosen in the account switcher) was rehearsed on 2026-10-11, in the same pass as the staking screens changed by phase 18 item 3 (the risk card's pinned-contract line on a stake and the rebasing note under the stETH row on Home). The fixes of the phase 18 findings (commits `9290864` and `1b6b322`: the staking success views with their note field, the payable-call funds refusal, the hidden Hoodi footer, the Polygon Amoy example, the staking Activity sentences, the token rows titled by symbol, the KNOWN STAKING TOKEN tag and the multisig copy) were re-checked on the emulator on 2026-10-11 (`AGENTS.md`, phase 18, "Fix slices RE-CHECKED ON THE EMULATOR"). A second re-check the same day (`AGENTS.md`, phase 18, "Smart-account history and the sent view PROVEN ON THE EMULATOR") covered the smart account's rows in Activity with a note that moved to its bundle transaction, the read-only multisig list under Settings → Accounts, the switcher's "What is backed up?" expander and the in-app browser's "Transaction sent" view with its note field after a Uniswap swap. Steps 28 to 32 are the phase 19 additions: step 28 (an OP Sepolia smart-account send with the layer 1 fee), step 30 (a multi-signature account by QR on Base Sepolia, the first off Ethereum Sepolia) and step 31 (a recurring swap) were each rehearsed live in-app on 2026-10-11 (`AGENTS.md`, phase 19, items 0a, 1 and 2), while step 29 (Hoodi staking through Lido and Rocket Pool) and step 32 (speeding up or cancelling a stuck transaction) were proven by script only on 2026-10-11 (items 0b and 3), with their in-app passes still pending. **Not yet rehearsed:** the Hoodi half of staking (the wallet holds no Hoodi test ETH, so no Hoodi or Rocket Pool transaction has been sent from the app); the automatic tracking of stETH or wstETH right after a stake (in that pass both were already tracked through "Find my tokens" before the stake); the Multisig list's deployment refresh on focus (commit `1b6b322`; the emulator's record was already stored as deployed); and the notification's own icon in step 19, which appears only in a development build rebuilt after phase 18 item 0.
3. **Bitcoin, Solana and Dogecoin in the app use their main networks.** Sepolia test mode only switches the Ethereum side. Anything you broadcast on those three chains from the app spends real coins. Step 9 explains how to show them without broadcasting.

---

## Preparation

Allow about an hour the first time, mostly for funding and for a rehearsal run.

### The machine and the emulator

- Use the Mac that holds the project at `/Users/sean/Documents/mobile-wallet`. Every terminal command below starts from that folder and assumes this line has been run first, because the shell's default Node is too old:

  ```
  export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
  ```

- The emulator is the Android Virtual Device named **`shiba`** (Pixel 7 profile, Android 14 with Google APIs). Start it from Android Studio's Device Manager, or with `~/Library/Android/sdk/emulator/emulator -avd shiba`.
- The device PIN is **1234** and one fingerprint is enrolled. To "touch" the fingerprint sensor, run `adb emu finger touch 1` in a terminal. After a cold boot the emulator says "PIN is required after device restarts"; `AGENTS.md` records that `adb shell locksettings verify --old 1234` unlocks the user storage, after which the PIN typed on the on-screen keypad is accepted (open the keypad with a finger touch first).
- The wallet runs inside **Expo Go**, which is already installed on the emulator.
- **Screen protection is on by default (phase 17).** Settings → Privacy → "Hide in the app switcher and block screenshots" makes every screen of the wallet come out blank in screenshots, screen recordings, `adb screencap` and the recent-apps thumbnail on Android. If you want to take screenshots or record the demo, turn it **off** before you start, and turn it back on afterwards. The screens that show the recovery phrase or a private key stay protected even with the setting off, so step 1's blank backup screenshot still works. The switch sits at the bottom of the Privacy section, where Expo Go's floating Tools button overlaps it: scroll it up before tapping (phase 18 emulator note), using slow swipes at the screen edge as everywhere in Settings.

### Metro, the development server

The app is served to Expo Go by Metro. The record's lessons, all from `AGENTS.md`:

- **Serve a clean copy of the code.** During phase 8 the team ran Metro from an isolated git worktree of the committed code (its own checkout of `HEAD`, with `node_modules` and the engine's built `dist` folders linked from the main checkout, and a worktree-only Metro configuration pointing back at the main checkout), so that edits other people were making could never reach the device mid-demo. That worktree lived in a temporary scratchpad and its exact Metro override is not committed. If nobody else is editing the repository on presentation day, running Metro from the main checkout is equivalent; otherwise create a fresh worktree of the commit you intend to show.
- **Build the engine first, then start Metro with a cleared cache:**

  ```
  npm run build
  cd app
  EXPO_NO_METRO_LAZY=1 npx expo start --clear
  ```

  `EXPO_NO_METRO_LAZY=1` produces one bundle with no lazy chunks; without it, the WalletConnect code failed to load with "Requiring unknown module". Do **not** set `CI=1`: it disables file watching and puts a "Cannot connect to Expo CLI" warning on the device. With the emulator running, press `a` in the Metro terminal to open the app in Expo Go.
- If you rebuild the engine (`npm run build`) while Metro is running, restart Metro with `--clear`. A half-built engine once made Home lose its account label.
- Start Metro so that it survives the terminal that launched it (the record used `nohup … & disown`); Metro died once when the task that started it was stopped.

### What the emulator wallet should look like

Open the app and check, before the audience arrives:

- **Settings → Developer → Sepolia test mode** is on. An orange TESTNET banner shows, and Home's Ethereum row reads "Ethereum Sepolia".
- **Home** shows "Account 1 · 0x772e…F44F". The full address is `0x772eAA1d3BEf14C0BD5cee980b90dB3FC680F44F`. Account 2 exists (`0xb6997390e1E3CDE9BF035Af75830Ae00C29781fE`).
- **Settings → Account Abstraction → Ethereum Sepolia** has a verified bundler, the account type **Kernel v3.3**, and the verified Kernel factory. The record says the Sepolia bundler was switched to **ZeroDev** for the EIP-7702 run (phase 8 live validation), but a later investigation could not confirm which bundler was saved at that point (phase 9 item 1, "UNVERIFIED"), so look: the row masks the URL to its host, and the host should be `rpc.zerodev.app`. ZeroDev is the vendor proven to accept everything in this walkthrough; Alchemy's bundler refuses Kernel deployments. To change it, paste `https://rpc.zerodev.app/api/v3/<project id>/chain/11155111`, where the project id is `ZERODEV_PROJECT_ID` in the git-ignored `.dev-wallet/env`. Never show that file or the full URL on screen.
- Account 1's **Kernel smart account** is `0xD31c2C54F21684eE2026a6C41e391130BdEeD8FA`, already deployed, owned by Account 1 (owner read back on-chain after the phase 9 owner-change test).
- **Settings → Contacts** has the Sepolia contact "Burn" for `0x000000000000000000000000000000000000dEaD`. It makes a safe, recognisable recipient for every send in this demo.
- **Account 2's EIP-7702 status** is "Regular account (no code)" (it was upgraded and revoked on 2026-10-01). Open Home → Upgrade on Account 2 to confirm.

### Funds (Sepolia test ETH)

Test ETH is free but must be in the right places. Check balances on Home (pull down to refresh) and on `sepolia.etherscan.io`.

| Who | Address | Needs | Used for |
|---|---|---|---|
| Account 1 (EOA) | `0x772e…F44F` | about 0.002 | Plain send, WalletConnect swap gas |
| Account 1's Kernel account | `0xD31c…D8FA` | about 0.003 | Smart-account send, session install/test/revoke, guardian install, recovery gas |
| Account 2 (EOA) | `0xb699…81fE` | about 0.002 | EIP-7702 upgrade and revoke; sending the guardians' approvals during recovery |

The project's dev wallet (the git-ignored `.dev-wallet/mnemonic.txt`, address `0x16DA2CAeaDa26516F919C6872F6C38AB378CaC5C`) is the usual source. It was down to about 0.0011 Sepolia ETH at the last record, so top it up from a Sepolia faucet first. Then send from it with:

```
TO=0xD31c2C54F21684eE2026a6C41e391130BdEeD8FA ETH=0.003 node scripts/testnet/fund.mjs
```

The script estimates gas, which matters for the Kernel account: a plain 21,000-gas transfer to a deployed Kernel account fails because receiving runs contract code (phase 7 live validation).

For the WalletConnect swap you also need a little **Sepolia USDC** in Account 1 (`0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`). The earlier runs swapped 1 USDC at a time. Get it from a Sepolia USDC faucet before the day.

For the phase 18 steps (figures from `AGENTS.md`, phase 18, "Items 1 and 2 PROVEN LIVE IN-APP"):

- **Staking on Sepolia (step 26).** Account 1's regular address needs the amounts to stake plus small fees: the rehearsal staked 0.001 and then 0.0005 test ETH, and each regular-account stake cost well under 0.000001 test ETH in fees at the time. The smart-account stake needs Account 1's Kernel account `0xD31c…D8FA` to cover the stake plus the worst-case fee: at the rehearsal the confirm showed a maximum network fee of 0.001454470713777846 test ETH for a 0.0005 stake, and the operation actually cost 0.0010078 test ETH. After the rehearsal, Account 1 held about 0.002619 test ETH, 0.000915 stETH and 0.000564 wstETH, and its Kernel account about 0.0123 test ETH, an EntryPoint deposit of 0.000447 and 0.0005 stETH.
- **Hoodi (steps 25 and 26).** The wallet holds no Hoodi test ETH, so every Hoodi send and stake is refused for funds. Staking on Hoodi (Lido's stake, withdrawal request and claim; Rocket Pool's deposit of at least 0.01 and its burn) needs Hoodi test ETH on Account 1 or at the dev EOA first. The Hoodi faucets need a social login, which is the Chairperson's call.
- **OP Sepolia (step 25).** The dev EOA holds 20 USDC on OP Sepolia but no ETH there, and in the rehearsal a send from the emulator wallet on OP Sepolia was refused for funds. Step 25 needs no funds.

### Guardian keys

The phase 10 plan uses two keys of the dev seed, at derivation indices 5 and 6, as guardians that "someone else" holds. Print their addresses with:

```
npm run build
node scripts/testnet/guardian-approve.mjs addresses
```

`guardian-approve.mjs` can **sign** a guardian approval for a request the app shares (`GUARDIAN_INDEX=5 node scripts/testnet/guardian-approve.mjs approve request.txt`), but it cannot **submit** the final recovery operation. The guardian contract accepts that final operation only with a guardian's signature, and the app's own screen says a guardian submits it from their wallet ("A guardian submits the recovery"). So at least one guardian must be an account inside the emulator wallet. The plan in step 7 therefore uses one dev-seed guardian (index 5, played by the script) and one in-wallet guardian (a new Account 3). Add Account 3 in Settings → Accounts before the demo; adding an account takes about 15 seconds on this emulator.

### A WalletConnect link

The WalletConnect step needs a fresh `wc:` pairing link from `app.uniswap.org` on a laptop browser, switched to the Sepolia test network. Links expire after about four to five minutes, so request it only when the wallet is already on the Connections screen. Typing a long link with `adb shell input text` drops characters; the record's reliable method is the ADBKeyboard input method already installed on the emulator: switch to it, then `adb shell am broadcast -a ADB_INPUT_TEXT --es msg '<the wc: link>'`, and switch back to the Google keyboard afterwards. Scanning the QR code with the emulator camera also works (the camera shows a virtual scene with a poster you can replace), but needs more setup.

### A rehearsal

Run the whole walkthrough once the day before. It surfaces funding gaps and any changed copy, and it lets you pre-run the slow parts (the guardian delay in step 7 is at least ten minutes).

---

## The walkthrough

Each step lists what to tap, what the audience sees, what it proves, and the fallback if something is missing. Quoted text is copied from the app's source code at the time of writing.

### Step 1. Onboarding, and one phrase for many chains

**Do this on a second, disposable emulator, never on `shiba`** (see the warnings). Any new Android Virtual Device with Expo Go works; open the same Metro project in it.

- Tap **Create a new wallet**. The welcome screen says: "A non-custodial multi-chain wallet. One seed phrase, generated and stored only on this device, controls Ethereum, Bitcoin, Dogecoin and Solana accounts."
- The backup screen ("Your recovery phrase") shows 12 words and a warning that begins "These 12 words are the only backup of your wallet." Point out that a screenshot here comes back blank: the screen blocks screen capture.
- Tap **I wrote the words down**, then answer the two-word quiz on "Confirm your backup".
- Home lists four chains with addresses all derived from that one phrase, and live balances fetched from public endpoints.

**What it proves:** keys are generated on the device, one phrase backs up every chain and every account, and the backup screen cannot be screenshotted. Run on the emulator on 2026-09-27 (`AGENTS.md` "Emulator validation"; screenshot blocking in the "third pass").

**Fallback:** if a second emulator is not available, switch back to `shiba` and show Home there: the footer says the addresses are "derived on this device from your recovery phrase (one phrase backs up every account)". Show Account 2 via the account switcher to make the "many accounts, one phrase" point.

### Step 2. A plain send with the balance-change preview and risk checks

On `shiba`, Account 1, Sepolia test mode.

- Home → Ethereum Sepolia row → **Send ↗**. Tap **Contacts** and pick "Burn". Enter 0.00001 and continue.
- The confirm screen shows the orange badge "Ethereum Sepolia TESTNET — test funds only", the "SAVED CONTACT Burn" notice with the full address, the fee and worst-case total, and a **"Balance changes (preview)"** card reading "You send 0.00001 test ETH", followed by "Pre-flight simulation passed (eth_call)."
- A **"Risk checks"** card appears only when a check finds something, with the footnote "Checked with public on-chain data only. No warning here does not mean a transaction is safe." To make it appear on purpose, type a fresh address instead of the contact: the first-interaction notice ("No earlier token transfers from you to this address were found in recent history…") is the most likely line. Whether it shows depends on what the endpoint returns, so treat it as a bonus rather than a promise.
- Show the anti-poisoning check too: type the Burn address with one character in the middle changed, keeping the first four and last four characters. The form warns 'This address looks similar to your contact "Burn" but is DIFFERENT. Check every character.' and does not label it (seen on 2026-09-28).
- Approve with the fingerprint (`adb emu finger touch 1`). With protected storage, exactly one system prompt appears, titled "Approve sending 0.00001 test ETH".

**What it proves:** every send is simulated before signing and shown as plain balance changes (preview matched the chain to the wei on 2026-09-28 and 2026-10-02, phase 6 emulator validation and the WalletConnect retest); contacts and look-alike warnings work in-app (2026-09-28); one biometric prompt both unlocks the protected phrase and approves (2026-10-02). The risk checks are built and tested offline; no recorded run shows a risk line on screen yet.

**Fallback:** if Account 1 has no test ETH, cancel at the biometric prompt; the confirm screen is the point. Cancelling shows "Not sent — Authentication cancelled." and nothing is broadcast.

### Step 3. The smart-account send (Kernel v3.3, ERC-4337)

- Home → Ethereum Sepolia → **Send ↗**, recipient "Burn", amount 0.0001, and turn on **Send from smart account** (marked EXPERIMENTAL; it appears only when the bundler and factory are configured and verified).
- The confirm screen shows "EXPERIMENTAL · ERC-4337 smart account · Kernel v3.3", **Owner account (signs)** Account 1, **From smart account** `0xD31c…D8FA`, the smart account's own balance, **Deployment: Already deployed**, a "Max network fee (bundler estimate)", the balance-change preview simulated as the smart account, and "Bundler gas estimate passed (eth_estimateUserOperationGas simulated the operation)."
- Approve with the fingerprint. The success screen shows the UserOperation hash, "Bundling… waiting for the UserOperation receipt.", then "Included on-chain — succeeded." with a link to the bundle transaction on Sepolia Etherscan.

**What to say:** the seed-derived key signs, but the account that pays and sends is a smart contract; a bundler carries the operation to the chain; the address of that contract was computable from the seed before it was deployed.

**What it proves:** proven live in-app on Sepolia on 2026-10-01 (phase 7 live validation, bundle transaction `0xe1892154…6e9a`). Smart accounts are enforced test-network-only (Settings → Mainnet readiness).

**Fallbacks:** "precheck failed: maxPriorityFeePerGas…" was fixed on 2026-10-01; if a bundler error appears, the app shows it verbatim, so read it out and check the Settings bundler row. If the smart account is out of test ETH, fund it with `fund.mjs` (preparation).

### Step 4. EIP-7702: upgrade a regular address in place, then undo it

Switch to **Account 2** (Home → account switcher). Its address has no code.

- Home → Ethereum row → **Upgrade**. The screen explains: "Your address stays the same. Your account will run ZeroDev Kernel v3.3 code (contract 0xd6CE…5b28), which enables batching, sponsored gas and, later, session keys. Your recovery phrase still controls everything. You can undo this at any time." The delegate address is shown in full, with a note about receiving (a plain 21,000-gas transfer to an upgraded address may fail). Current status: "Regular account (no code)".
- Tap **Upgrade with the next smart-account send**, then **Continue** ("Nothing is signed now…"). A **Cancel pending upgrade** button appears.
- Go back to Home → **Send ↗**, recipient "Burn", 0.0001, turn on **Send from smart account**. The confirm reads "Kernel v3.3 via EIP-7702 (your own address)", **From (your own address)** equal to Account 2's own address, and a warning box "This send also upgrades your account (EIP-7702 delegation to Kernel v3.3)…" with the delegate in full. The bundler estimate passes. Approve.
- After inclusion, Home shows "Account 2 · upgraded (Kernel v3.3) on Ethereum Sepolia" and the row link reads **Upgraded ✓**.
- Now undo it: **Upgraded ✓** → **Revoke upgrade**. The confirm explains the new code is "None — the delegation is removed (zero address)", that this is a type 0x04 transaction to yourself, the transaction and authorization nonces, a worst case of 86,000 gas, and why there is no pre-flight simulation. Approve; the screen ends with "Included — status: Regular account (no code)".

**What it proves:** an existing address gains smart-account powers without moving funds, and the user can always take them away again. Both directions proven live in-app on Sepolia on 2026-10-01 (phase 8 live validation; upgrade bundle `0xbd14fbeb…a7ec`, revoke `0x1287e768…594f`). Also say: the wallet only ever delegates to the pinned Kernel contract and refuses any dApp's request to sign a delegation (ADR D6).

**Fallback:** Account 2 needs test ETH for both the operation and the self-paid revoke. **Always finish with the revoke**: step 7 needs Account 2 as a regular account, and the app refuses to give one account both an upgrade and a recovered account.

### Step 5. WalletConnect with Uniswap: the global approval sheet

Switch back to **Account 1**.

- Settings → WalletConnect → **Open connections**. If an old Uniswap session is listed you can use it; otherwise get a fresh `wc:` link (preparation), paste it, and tap **Connect**.
- The connection sheet shows the dApp's name and URL, an identity line, "Will connect on Ethereum Sepolia (test network)", "Will connect account Account 1 (0x772e…F44F)", the chains offered but not included, and a **Connect as** choice between "Regular account (EOA)" and "Smart account (Kernel v3.3)". Keep the regular account (that is the path proven live), tap **Approve connection**, and pass the fingerprint.
- Go back to **Home**. On the laptop, ask Uniswap to swap 1 USDC for ETH (or EURC). The request appears **on top of Home**, not on the Connections screen: "Transaction request" with the sending account, the router contract, the fee, the balance-change preview ("You send 1 USDC (untracked token 0x1c7D…7238)", "You receive …"), and "Pre-flight simulation passed (eth_call)". Tap **Approve & send**.

**The identity line** reads one of "Verified by WalletConnect: origin matches (…)", "UNVERIFIED — the dApp's origin could not be confirmed…", "MISMATCH — … likely phishing" or "Flagged as a scam by WalletConnect…". For a mismatch or a scam, every approve button stays disabled until "I understand the risk — let me approve anyway" is switched on. Which verdict Uniswap gets over the live relay has **not** been observed yet (THREAT_MODEL W12), so say what it shows rather than predicting it.

**The Permit2 summary** appears only when Uniswap asks for a Permit2 signature. It then shows a card titled "Token approval (Permit2 PermitSingle)" with the spender, token, amount (with "Unlimited" spelled out when it is unlimited) and "Signature usable until", above the raw typed data. In the 2026-10-02 retest no Permit2 request came, because the earlier USDC permit was still valid. To provoke one, sell a token you have not sold through Uniswap before, such as the EURC received in that retest; this is likely to trigger an approval transaction and then a Permit2 signature, but it has not been rehearsed. The summary has been verified offline only (THREAT_MODEL W11).

**What it proves:** a production dApp works with the wallet end to end: pairing, typed-data signing, and transactions gated by simulation, on Sepolia, on 2026-09-27, 2026-09-28 and 2026-10-02 ("Grand finale", phase 6 emulator validation, the WalletConnect retest). The sheet surfaces on any screen and waits behind the lock screen (lock hold proven 2026-09-28).

**Fallbacks:** if the link expires during pairing, request a new one. If a LogBox toast covers **Approve & send**, tap the toast's Dismiss first (see rough edges). If the swap is declined automatically, check that Account 1 (the account the session belongs to) is active and test mode is on: the wallet declines on purpose otherwise, and Uniswap shows that as a generic "Swap failed".

### Step 6. Session keys: grant, use, revoke

Account 1, whose Kernel account is deployed. Rehearsed live in-app on 2026-10-03 (phase 10 item 1, and again after the fixes: two system prompts, success state intact).

- Home → Ethereum row → **Sessions**. The list starts with a warning that sessions are enforced on-chain but the session keys live only on this device ("…Revoke sessions you no longer need before wiping, and revoke everything you no longer recognise.").
- Tap **Grant a new session**. The form explains: "A session key is a new key on this device that may make ONLY the calls you list, until it expires. Your account enforces the limits on-chain. Each value cap is per call, not a total." For the allowed call, **Pick from contacts** → "Burn", leave the function empty and the cap at 0, choose **10 minutes**, and tap **Review**.
- The review lists every allowed call in plain words and the expiry. Confirm: the install is an ordinary smart-account operation signed by your account key, with "Bundler gas estimate passed" and the fingerprint.
- Back on the list, the session shows **Active** and "key on this device". Tap **Test this session (allowed call 1)**. The dialog says: "The SESSION key (not your account key) signs one operation…". Tap **Send test** and pass the fingerprint; the result screen reports inclusion.
- Tap **Revoke** and approve. The status becomes **Revoked**, and the session key is deleted from the device as soon as the bundler accepts the revocation.

**What to say:** this is consent that behaves like a phone app permission: one approval, then zero pop-ups inside a fence the account itself enforces. A session key cannot touch anything outside its list, and it cannot sign messages as the account.

**What it proves:** the whole cycle (install, a test operation signed by the session key alone, revocation) ran live on Sepolia through these exact screens on 2026-10-03 (phase 10 item 1), after the engine had proven install, use, refusal outside the grant, revocation and refusal after revocation on 2026-10-02 UTC (phase 8 item 2). The screens pass 117 offline checks (`check-sessions.mjs`). The policies are unaudited, so session keys are test-network-only.

**Fallbacks:** if the Sessions link is missing, the account is not eligible (the Kernel account must be deployed and the Kernel type selected for Sepolia). If the install is refused, read the bundler's message aloud (it is shown verbatim) and fall back to describing the engine run; `scripts/testnet/session-key-smoke.mjs` with `SESSION_SMOKE_DRY_RUN=1` replays the stages in simulation without spending anything.

### Step 7. Guardians: setup, the exposure warning, recovery, veto and owner change

Rehearsed live in-app on 2026-10-03 (phase 10 item 1: setup, a recovery request with pasted approvals and the on-chain delay, the owner's veto, a second recovery executed after the delay, attach, owner change back, removal). This is the longest step. It is described here as the screens and the record imply; rehearse it first and pre-run the waits.

**Setup (Account 1).**

- Home → Ethereum row → **Guardians** → **Set up guardians**. The form opens with: "Guardians are a trade-off, not a safety guarantee. They let people you choose replace the key that controls this account if you lose your recovery phrase — which also means that, together, they could take the account without you."
- Guardian 1: the dev seed's index-5 address (from `guardian-approve.mjs addresses`), label "Alice (external)", weight 1. Guardian 2: Account 3's Ethereum address, label "Bob (this phone)", weight 1. Threshold 2. Delay: **10 minutes (test networks only)**.
- **The exposure warning** appears as soon as the list is complete. For two guardians of weight 1 with threshold 2 it reads: "ONE guardian alone can sign messages as this account immediately, with no delay and no veto: any guardian holding at least half the threshold weight can — here …", followed by a sentence explaining that the deployed guardian contract lets the last signature repeat an earlier signer. Stop here and explain it: this is a real finding about ZeroDev's deployed module, proven live, and no wallet setting can fix it. The wallet never calls a guardian setup "safe".
- Tap **Review**, confirm (owner-signed operation, bundler estimate, fingerprint). After inclusion, the app asks you to back up the recovery record ("Back up the recovery record"); show the record's QR or the .json export, and explain that once an owner changes, the account can no longer be found from a recovery phrase alone.

**Start a recovery (Account 2 plays the person who lost their phrase).**

- Switch to Account 2. Home footer → "Lost a recovery phrase? Recover an account with guardians". The screen recommends **Use a fresh account for this (recommended)**, which adds a new "Recovered account"; recovering into the existing Account 2 keeps the demo shorter, but rehearse whichever you choose. Enter Account 1's Kernel account address `0xD31c…D8FA`, tap **Check the account**, review "Recover this account?", then tap **Create the recovery request**.
- The progress screen shows "Recovering 0xD31c…", the proposal id, and "1. Send this request to your guardians" with a QR code and share text. Copy the share text to the laptop (save it as `request.txt`).
- External guardian: run `GUARDIAN_INDEX=5 node scripts/testnet/guardian-approve.mjs approve request.txt` and paste the printed approval into "2. Add each approval you receive" → **Add approval**.
- In-app guardian: switch to Account 3 → Settings → Guardians → **Approve a recovery (as a guardian)**. Under "Recoveries in progress on this device", open the request. The review shows a warning that begins "Approving hands control of this account to the new owner shown below…", the account, its current owner, the **PROPOSED NEW OWNER** in full, and the guardian's weight. Tap **Approve (sign as guardian)**, pass the fingerprint, then **Add it to the recovery in progress on this device**.
- Switch back to Account 2. The weight bar is full; "3. Send the approvals on-chain" explains that this account pays the fee. Tap **Review the approval transaction** and approve. A countdown starts.

**Veto (Account 1, during the delay).**

- Switch to Account 1 → Guardians. Under "Recovery proposals (veto)", paste the request text and tap **Watch this proposal**. The card shows the proposed new owner, the time left before it can execute, and a **Veto** button. Explain why watching is manual: the guardian contract announces nothing, so the owner relies on guardians telling them.
- Tap **Veto** and approve. The proposal is dead.

**A recovery that goes through, then the owner change back.**

- On Account 2, the recovery screen now offers **Start over**. Start a new request (the wallet moves to the next guardian lane, so the proposal id differs), collect both approvals again, send them on-chain, and wait out the 10 minutes.
- Switch to Account 3 → Approve a recovery → open the request → **Submit the recovery**. The account pays this operation's gas. The screen shows "Recovery submitted to the bundler", then inclusion.
- Switch to Account 2 → the recovery screen → **Use this recovered account**. Home now labels Account 2 with "recovered account 0xD31c… on Ethereum Sepolia (not found from your recovery phrase alone; keep its record backed up)".
- Hand it back: Account 2 → Guardians → "Owner key" → **Change owner…** → pick Account 1 → **Change owner** and approve. The result reads "Included — the owner is now Account 1 (checked on-chain)" (wording per the phase 9 run, which showed it for Account 2).
- Clean up: Account 1 → Guardians → **Remove guardians**, so the account is back to its starting state.

**What it proves:** guardian install, recovery to a new owner, and rotation back ran live on Sepolia through the engine on 2026-10-02 UTC (phase 8 item 4, engine half); the delay and the veto were proven in simulation only. The in-app owner change ran live in both directions on 2026-10-02 (phase 9 item 1). The rest of the in-app flow is built and passes 231 offline checks (`check-recovery.mjs`). Moving to a second guardian lane after a veto has never run live (phase 8 item 4, app half). The guardian modules are unaudited, and the two findings above are why guardians stay test-network-only.

**Fallbacks and shortcuts:**

- To save time, pre-run the second proposal before the audience arrives so its 10 minutes have already passed, and show only **Submit the recovery** and the attach live.
- If the veto is not wanted, choose **No delay (no veto)** at setup: the app then requires the acknowledgement "No delay means enough guardians can replace your key in a single operation, and you cannot veto it. I understand there will be no veto." and Account 3 can submit as soon as both approvals are in.
- If something leaves the account with the wrong owner, `scripts/testnet/kernel-rotate-owner.mjs` can rotate a Kernel account back from a dev-seed key (see its header; it defaults to a different account, so pass `KERNEL_ACCOUNT`). It cannot sign for emulator-wallet keys, so the in-app **Change owner…** is the route for this account.
- Account 2 needs test ETH to send the approvals on-chain; the Kernel account needs test ETH for the final operation.

### Step 8. The mainnet readiness switchboard and protected storage

- Settings → **Mainnet readiness**. The introduction explains the two kinds of status. Walk down the list: "Sending from your regular account", "Tokens (ERC-20)", "NFTs", "Swaps", "Connecting to apps (WalletConnect)" and "Sending Dogecoin" are **Not yet cleared** (they still work on mainnet in this prototype, by the Chairperson's decision, with the reasons shown); the Kernel smart account, the EIP-7702 upgrade, session keys, passkeys, guardians, owner changes, SimpleAccount and gas sponsorship are **Test networks only**. Each row cites its open items, such as C1 (audit of the shipped Kernel version), from `docs/THREAT_MODEL.md` section 5.
- Make the enforcement visible: Settings → Developer → turn **Sepolia test mode** off. Open Home → Ethereum → **Upgrade**: the screen now shows a card "Upgrade this account (EIP-7702): test networks only" with the reason and "Turn on Sepolia test mode in Settings → Developer to use this feature.", and the start buttons are disabled. The smart-account toggle has disappeared from Send. Turn test mode back on.
- Settings → **Recovery phrase protection**. On the demo emulator it already reads "protected by biometrics (since 2026-10-03)" (the date of the original switch, as recorded). Explain the opt-in: the button "Protect with biometrics" asks for confirmation with the trade-off ("If you ever add or remove a fingerprint or face, or turn off the screen lock, this phone will no longer be able to open the phrase and you will need your written backup.") and then moves the phrase into storage that the phone unlocks only with a strong biometric. To show the button itself, use the disposable emulator from step 1 after enrolling a fingerprint there.
- Settings → Backup → **Show recovery phrase** raises exactly one system prompt ("Reveal recovery phrase"). Do **not** do this on a projected screen: it displays the real phrase of the demo wallet.

**What it proves:** smart-account features cannot be switched on outside test networks, by design and with no override (phase 9 item 6); the protected storage works in Expo Go on Android (proven 2026-10-02, "Settings 'Recovery phrase protection' section").

### Step 9. Dogecoin, Bitcoin and Solana, and the mainnet Dogecoin demonstration

These chains run on their main networks in the app, so show the flows to the confirm screen and stop.

- **Bitcoin and Solana:** Home → Bitcoin (or Solana) → **Send ↗**, recipient a valid address of that chain, any amount. With a zero balance the app refuses with a plain insufficient-funds message; with funds, the confirm screen shows the red badge "Bitcoin Mainnet — real funds" and the fee. Do not approve. Both chains' engine-built transactions were accepted live on their test networks on 2026-09-27 by script (Bitcoin testnet3 and Solana devnet; phase 2 task 8).
- **Dogecoin:** Dogecoin needs a Blockbook endpoint. Until one is saved, Home shows the honest "no endpoint" state and sending says it is unavailable. To configure it, Settings → Network endpoints → Dogecoin: the NOWNodes URL `https://dogebook.nownodes.io` and the `NOWNODES_KEY` from `.dev-wallet/env`; saving verifies the endpoint live before storing anything. Do not type the key on a projected screen.
- **The mainnet demonstration:** on 2026-10-03 the dev wallet sent itself 1 DOGE on the Dogecoin main network, built and signed by the same functions the Send screen uses, confirmed in block 6399309 (txid `2f05331b4e731e153636bdf92965882a79d2412eb3a5e3639e0380145465a6fd`, fee 0.00226678 DOGE). Show it on any Dogecoin block explorer, and if you want a live element, run the script in its default dry-run mode, which quotes, signs and independently decodes a fresh self-send and stops without broadcasting:

  ```
  npm run build
  node scripts/testnet/doge-mainnet-demo.mjs
  ```

  Broadcasting needs `DOGE_MAINNET_BROADCAST=1` plus typing the exact txid; do not do that in a presentation.

**What it proves:** one wallet, one phrase, four chain families with very different transaction formats, each proven with a live broadcast (three on test networks, Dogecoin on mainnet). The Dogecoin send has not yet been broadcast from the Send screen itself, and the emulator wallet holds no DOGE (about 10.69 DOGE remain in the dev wallet at `DEQ788Pe98Z97Le6feBa2P49JL7ETGSMNf`).

### Step 10. Subscriptions via session keys: a merchant pulls a payment on schedule

Account 1, whose Kernel account is deployed, on Sepolia. Rehearsed live in-app on 2026-10-04 UTC (two subscriptions: install, hand-over, keeper pulls, an expiry refusal, revocation; see "Phase 12 progress" in `AGENTS.md`). The subscription clock starts when **Start subscription** is tapped (fixed after the rehearsal, where it started at Review; the fix has not yet been re-run on the emulator), so the hand-over still uses up part of the first period: avoid periods shorter than a few minutes.

- Home → Ethereum row → **Sessions** → **New subscription**. Fill in a merchant address (for a rehearsal, the dev seed's index-5 address `0x69F0EC265702D0891b0AEF8e79ddDC3277ef7E8a`, which the keeper script can play), the token (test ETH, or a test-network USDC/EURC), the amount per payment, the period and the number of payments. The fee budget is pre-filled. Tap **Review**.
- Read the review aloud in this order. First the warning box: a single operation may contain several transfers each under the cap, so a dishonest merchant could take several periods' worth in one pull, up to the account's whole balance of that token. Then the plain sentence ("Lets … take up to … every … until …; at most one pull per period") and the on-chain lines: the per-call rules, the time window, the fee budget and the pull count. Then **Start subscription**: two system prompts ("Approve this subscription", then "Protect the new session key with biometrics"), then "Included".
- The Subscriptions list shows the card: next payment due, payments taken (0 of N), fee budget left, and "key on this device". Tap **Hand the key to the merchant**: after the fingerprint the hand-over JSON is shown once with screenshots blocked; share it as a file or copy it (a copied key is overwritten on the clipboard after a minute), then confirm, which deletes the key from this device. The card now shows the hand-over time and no hand-over button.
- To show a pull, give the JSON to the keeper on the host (on the emulator, the in-app Copy works because the emulator clipboard syncs to the host; the JSON holds the session private key, so keep it only under `.dev-wallet/` and clear the clipboard afterwards) and run it with only the session key: `node scripts/testnet/subscription-keeper.mjs import <file>` then `… run`. Refresh the card as the counts move. Then **Revoke** from the card and run `… pull --unchecked` to show the account refusing the next pull.

**What to say:** a subscription is a session key with a schedule. The merchant holds a key that can move at most the agreed amount, to itself only, at most once per period, until the expiry, and the account enforces all of that. The owner can cancel at any time. Be honest about the limit stated in the warning box: the deployed policies cannot forbid batching, so this is a schedule the account enforces, not a hard cap on what a dishonest merchant can take in one go.

**What it proves:** on 2026-10-03 the keeper pulled three scheduled payments of 1,000 wei through ZeroDev's bundler from the dev seed's index-2 Kernel account; an early pull was refused as not yet due, an over-cap pull was refused by the call policy, a fourth pull was refused by the rate limit, and after revocation the key was refused outright, with every receipt checked independently and the merchant holding exactly 3,000 wei (phase 12 item 2). The engine's dry run also showed the batching gap against the real contracts. The policies are unaudited, so subscriptions are test-network-only.

**Fallbacks:** if the Sessions link is missing, the account is not eligible (deployed Kernel account, Kernel type selected). If the install is refused, the bundler's message is shown verbatim. `node scripts/testnet/subscription-keeper.mjs dry-run` walks every stage in simulation (eth_simulateV1 against the real Sepolia contracts) without spending anything.

### Step 11. The same wallet on a Layer 2: Base Sepolia

Account 1. Rehearsed live in-app on 2026-10-03 (phase 12 item 1). Base Sepolia test ETH is needed on Account 1's regular address and, for the smart-account send, on its Kernel account `0xD31c2C54F21684eE2026a6C41e391130BdEeD8FA`, which has the same address on every chain. Faucets for Base Sepolia usually require a small mainnet ETH balance on the requesting address; `scripts/testnet/fund.mjs` can move test ETH from the dev wallet if it holds some.

- Settings → Developer → **Base Sepolia**. The banner becomes "TESTNET — Base Sepolia test mode is on. Amounts are test ETH, not real funds." and a note explains that every transaction on this layer-2 network also pays a layer 1 data fee, that the app reserves the fee oracle's estimate plus 50%, and that swaps are not offered here.
- Settings → Account Abstraction → Base Sepolia row. On the demo emulator it already reads "ready · Kernel v3.3 (ERC-7579)". To show the per-network check, paste the Ethereum Sepolia bundler URL into the Base row: the save is refused with "This bundler serves Ethereum Sepolia (chain id 11155111), but you are saving it for Base Sepolia (chain id 84532). Nothing was saved…". The Kernel factory pre-fill is the same address as on Ethereum, "each checked on-chain".
- Home → Ethereum → **Send**, smart-account toggle on, a small amount to Account 2. The confirm shows the smart account's balance, the deployment state and the bundler's estimate. Approve: one prompt, then "Included on-chain — succeeded." On the rehearsal this send deployed the Kernel account on Base from the app.
- A plain send with **Max**: the confirm shows "Max network fee … plus the layer 1 data fee below" and a separate "Layer 1 data fee (estimate)" line with the oracle figure and the 50% reserve. Tap **Review** within a few seconds of Max: the fee oracle moves, and Max leaves no slack, so a slow Review can be refused with "Not enough test ETH to cover this amount plus the network fee." Tap Max again and Review promptly.
- Switch back to **Ethereum Sepolia** afterwards: the emulator's Sepolia bundler, session and guardian state live there.

**What to say:** nothing about the account-abstraction stack is Ethereum-specific. The same Kernel contracts sit at the same addresses on Base, the same bundler project serves it, and a smart account has one address everywhere. The only new thing is the layer 1 data fee, which the app estimates from the network's own oracle and shows as its own line.

**What it proves:** on 2026-10-03 the app deployed Account 1's Kernel account on Base Sepolia through ZeroDev's bundler (block 47657170) and sent a Max transaction whose actual layer 1 fee came in 5.2% above the estimate and within the reserve (block 47657380), with every receipt checked independently (phase 12 item 1). The engine had deployed a Kernel account there by script the same day.

**Fallbacks:** without Base Sepolia test ETH, show the mode switch, the layer-2 note and the bundler refusal, and describe the recorded run. The Home account-tool links (Sessions, Guardians, Passkey) may stay hidden on Base until the app is relaunched after the deployment (a recorded bug).

### Step 12. Tokens on every network, and "Find my tokens"

Account 1 on Ethereum Sepolia. Rehearsed live in-app on 2026-10-04 (phase 13 items 1 and 5).

- Home → the Ethereum row now lists the test network's own tokens: USDC and EURC with live balances and no fiat values (test tokens are never priced). Switch briefly to mainnet mode in Settings → Developer to show that the lists never mix, then switch back.
- Home → **Manage tokens**. The header reads "Tokens · Ethereum Sepolia". Remove EURC ("Remove EURC?"), then tap **Find my tokens**. With the history indexer saved, the result reads "1 untracked token found · 1 already tracked · …" and shows an **UNTRACKED TOKEN** card with the balance and the full contract address. **Track EURC** asks first: "Track EURC? Contract 0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4 on Ethereum Sepolia. Anyone can create a token with any name and symbol; track it only if this is the contract you expect."
- Send a little USDC from the regular account to the wallet's own smart account (Home → USDC row → Send; the risk card names it as one of your own accounts), then send some back with the smart-account toggle on.

**What to say:** tokens follow the network you are on, and nothing is ever added for you. Discovery only lists what the indexer reports; the name and decimals are read from the chain, and the full contract address is always shown, because anyone can create a token with any name.

**What it proves:** per-network token lists, discovery and live USDC sends from both the regular and the smart account ran on Sepolia on 2026-10-04 (blocks 11843700 and 11843716), and the first ERC-20 subscription pull moved exactly 0.1 USDC to the merchant (block 11843849).

**Fallbacks:** without a history indexer the screen says that finding tokens needs one and names the Settings section. Discovery on Base Sepolia needs that network enabled for the indexer key.

### Step 13. Pay the network fee in USDC (Base Sepolia)

Account 1 on Base Sepolia; its Kernel account needs test USDC there. Rehearsed live in-app on 2026-10-04 (phase 13 item 2). Scroll Settings with slow swipes at the screen edge on this emulator: a fling that starts on a button can register as a tap, and the Danger zone is at the bottom.

- Settings → Developer → **Base Sepolia**. Settings → Mainnet readiness shows "Paying the network fee in USDC — Test networks only", with the reason: neither the smart account nor Circle's paymaster has a published audit, and Circle can upgrade or pause the paymaster.
- Home → USDC row → **Send**, turn on **Send from smart account**, then **Pay the network fee in USDC**. The hint reads: "Circle's token paymaster pays the gas and takes USDC from your smart account instead. The confirm screen shows the most it can take before you approve; ETH stays the default."
- Enter an amount and tap **Review**. Walk through the confirm: "Network fee paid in USDC: up to … USDC; the unused part is refunded in the same transaction; no ETH is needed for the fee."; the rate "1 test ETH = 3000 USDC, from the paymaster's on-chain oracle." with the note that the test oracle is a fixed price; the fee spread read from the paymaster; the paymaster's address in full; and the grant: "A one-time permit letting Circle's paymaster take at most … USDC. The permit is used up by this operation, so normally nothing stays approved."
- **Send**: one device prompt. The success screen ends with "Network fee charged: … USDC (up to … USDC was permitted; the rest was refunded in the same transaction)."
- Optional: a test-ETH send with the same switch on. **Max** equals the whole ETH balance, because no ETH is needed for the fee.

**What to say:** a new user can hold only a stablecoin and still transact: the account never needs the network's own coin. The fee comes out of the token being held, the most that can be taken is shown before approval, and the wallet refuses to sign more than that. Be plain about the dependencies: this is one issuer's paymaster for one token, on the networks where it is deployed, and it is not audited in public.

**What it proves:** on 2026-10-04 two sends from the app paid 0.005776 and 0.005424 USDC in fees through Circle's paymaster on Base Sepolia (blocks 47688510 and 47688684); the smart account's ETH balance and EntryPoint deposit were identical before and after, and no allowance remained.

**Fallbacks:** on Ethereum Sepolia the form explains that the choice is offered only on Base Sepolia. If the paymaster check fails, the switch is hidden with the reason. A send larger than the USDC balance minus the worst-case fee is refused before any prompt.

### Step 14. Request a payment, and pay to a name

Account 1 on Ethereum Sepolia. Rehearsed live in-app on 2026-10-05 (phase 14 items 1 and 2).

- Home → tap the address → Receive → **Request an amount**. Enter 0.001 and show the description ("This request asks the payer to send exactly 0.001 test ETH on Ethereum Sepolia (chain id 11155111) to your address …") and the QR. Switch the asset to USDC: the link becomes a token transfer that names the token contract and the network.
- Send: paste a request into the recipient field. The screen switches to the requested token with the recipient and amount filled in and a box that says "Filled in from a payment request (EIP-681). Check every field before you tap Review; you can change any of them." Paste a request made for another network: it is refused in one sentence that names both networks, and nothing is filled in.
- Send ETH: type `nick.eth`. The screen shows "Looking up nick.eth…", then the name with its full address, which registry answered, and "Names are looked up through your network endpoint (…), which sees the name you looked up." Review shows the name line on the confirm. Do not send.
- Type a name with an accent or an underscore: the screen says which characters are supported and asks for the address instead.

**What to say:** a request is only a pre-filled form. The wallet never changes network or adds a token because a link said so, and a name is only a way to find an address: the address is what gets checked, shown in full and used.

**What it proves:** request links and QR codes for all four chain families, the pre-fill and its refusals, and name resolution on mainnet and Sepolia ran on the emulator on 2026-10-05.

**Fallbacks:** names are not looked up on Base Sepolia or Arbitrum Sepolia, and names stored off-chain (every *.base.eth name) are refused with an explanation.

### Step 15. Watch an address

Rehearsed live in-app on 2026-10-05 (phase 14 item 6).

- Settings → Accounts → **Watch an address**. Paste any Ethereum address and name it. Pasting one of the wallet's own addresses is refused ("This address is already one of your accounts…").
- Switch to the watched address. Home shows "Watch-only — no key in this wallet" and the address's balances and tokens, with no Send, Swap or account tools. Open Settings → Sessions (or Guardians, Passkey, Connections): each shows one sentence saying the feature is not available for a watch-only account, and no prompt appears.
- Switch back to Account 1 and remove the watched address ("Stop watching this address? … Nothing secret is deleted…").

**What to say:** watching is reading. There is no key for this address anywhere in the wallet, so nothing can be signed for it, and the wallet never treats it as one of your own accounts.

**What it proves:** the watch-only account, its refusals and its removal ran on the emulator on 2026-10-05, including a lock and unlock that used the ordinary device prompt and never opened the recovery phrase.

### Step 16. The fee in USDC on Ethereum Sepolia, through a second paymaster

Account 1's Kernel account on Ethereum Sepolia with a few test USDC. Rehearsed live in-app on 2026-10-05 (phase 14 item 3).

- Send ETH with **Send from smart account** on. The form checks Pimlico's paymaster and the saved bundler, then offers **Pay the network fee in USDC** with the hint that this is a permissioned service: Pimlico sets the rate, must sign each operation, and can decline.
- Review. Compare with step 13: the fee line says the operation "first approves Pimlico's paymaster for exactly … USDC; after your calls run, it takes the actual fee, which can be less"; the rate is "set by Pimlico's service and signed into the operation; it is not read from an on-chain oracle"; the markup is "Included in the rate; not shown as a separate figure"; and the grant box says the rest of the approval stays in place afterwards.
- Send: one device prompt. The success line gives the fee charged and repeats that what was not charged stays approved until a later operation through the paymaster replaces it.

**What to say:** two different paymasters, two different trust models, one screen that tells the truth about each. Circle's reads a price on-chain and leaves nothing approved in the normal case; Pimlico's is a service that signs each operation, sets its own rate and leaves the unused approval in place.

**What it proves:** on 2026-10-05 a smart-account send on Sepolia paid 0.856453 USDC through Pimlico's paymaster (block 11846591): the approval equalled the displayed maximum, the charge equalled the success line, and the account's ETH fell by exactly the amount sent.

### Step 17. Inheritance, as a demonstration of what today's contracts cannot do

Account 1 on Ethereum Sepolia. Show the screens only; do not install an heir on the demo account. Reviewed live on 2026-10-05; the full flow ran by script on 2026-10-04 (phase 14 item 4).

- Home → **Inheritance** (test networks only). Read the first sentence aloud: "Read this first: your heir can sign messages AS THIS ACCOUNT from the moment you add them — not after the delay." Review stays disabled until the acknowledgement is switched on. Go back without installing.
- Settings → Developer → Off: the screen refuses with "Inheritance is a test-network demonstration only: …". Switch test mode back on.

**What to say:** this is the wallet declining to oversell. The deployed modules give a delay and an owner's veto for the change of owner, but an heir can sign as the account from day one, the owner cannot reliably see a takeover coming, and nothing on-chain can serve as a check-in. A real inheritance feature needs a module that does not exist in audited form today.

**What it proves:** the analysis is backed by eight simulated scenarios against the real contracts and a live Sepolia run (setup, approval, veto, takeover after the delay, rotation back), recorded in `AGENTS.md` under phase 14.

### Step 18. Arbitrum Sepolia: a third network with the same smart account

Account 1 with a little Arbitrum Sepolia test ETH and USDC on its regular address and on its Kernel smart account (the Chairperson funded the development address; the emulator wallet was funded from it). Rehearsed live in-app on 2026-10-09 (phase 15 item 0).

- Settings → Developer → **Arbitrum Sepolia**. The banner reads "TESTNET — Arbitrum Sepolia test mode is on", and the note under the choice explains the fee model: the cost of publishing data on Ethereum is charged as extra gas inside the network's own estimate, not as a separate fee, so there is no layer 1 line on the confirm and Max leaves exactly the estimate. Swaps are not offered.
- Settings → Account Abstraction → the Arbitrum Sepolia row. Paste a bundler URL for another network first: the save is refused with "This bundler serves Ethereum Sepolia (chain id 11155111), but you are saving it for Arbitrum Sepolia (chain id 421614). Nothing was saved." Then the right URL: "Verified ✓ — the bundler reported chain id 421614 (Arbitrum Sepolia) and eth_supportedEntryPoints includes EntryPoint v0.7". The Kernel factory pre-fill is the same contract set as on the other networks.
- Send ETH with **Send from smart account** on. The form shows the smart-account address with "Not deployed yet — the first send deploys it." Review: DEPLOYMENT "Will deploy with this send". One device prompt. The success screen shows the operation hash, then the bundle transaction.
- Send USDC from the smart account with **Pay the network fee in USDC** on, exactly as in step 13. The ceiling on Arbitrum is larger (about 0.75 USDC at the time of the rehearsal) because the gas price is higher; the actual charge was 0.054559 USDC. Ask for more than the balance can cover and the form refuses before any prompt, naming both figures.
- Send ETH from the regular account with Max. If the fee moved while you looked at the form, the confirm shows the "The amount was lowered from … because the network fee rose after you tapped Max" box. There is no layer 1 line.
- Settings → Developer → **Ethereum Sepolia** to return.

**What to say:** the same smart account, at the same address, now lives on three networks, and the wallet tells the truth about each network's fee model instead of pretending they are alike.

**What it proves:** on 2026-10-09 the app deployed Account 1's Kernel account on Arbitrum Sepolia through the bundler (block 317505893), paid a smart-account fee in USDC there (block 317507769, charge 0.054559 USDC, ETH balance and deposit unchanged) and sent a Max transfer with no separate layer 1 fee (block 317508661). The layer 1 component happened to be zero during the rehearsal, so the "extra gas" part of the fee model has only been shown at a zero price.

### Step 19. Recurring payments sent by the phone itself

Account 1's Kernel account on Ethereum Sepolia, eligible for the Sessions screen as in step 10. **Rehearsed live in-app on 2026-10-09 (phase 15 item 1): set-up (block 11881366), two payments by the recurring key with one device prompt each (blocks 11881383 and 11881417), the banner after a return to the foreground, and revoke and forget (block 11881439).** It was built in phase 15 item 1 and is verified only by the offline suites (`check-recurring.mjs`, 114 checks); no recurring payment has yet been sent through the app on a live network. Run it completely at the rehearsal before showing it, and where a quoted label differs, trust the screen. The Kernel account needs enough test ETH for the set-up fee, the payments and the fee budget; the form's funding lines say what is missing. To show the reminder with the wallet's own notification icon (phase 18 item 0), use a development build rebuilt after that change; see the reminder bullet below.

- Home → Ethereum row → **Sessions** → **New recurring payment**. The form opens with "Pays one recipient up to a fixed amount once per period from your smart account, until the payments run out or you revoke. A new payment key is created on this phone and never leaves it; your account enforces the limits on-chain." and the box "Payments are sent only while this wallet is open. … Nothing is sent in the background or while the wallet is closed. A payment missed while the wallet was closed is not lost…". Fill in a payee (for a rehearsal, the dev seed's index-5 address `0x69F0EC265702D0891b0AEF8e79ddDC3277ef7E8a`, as in step 10), the token (test ETH or test USDC), the amount per payment, the period and the number of payments. The fee budget is pre-filled. Tap **Review**.
- Read the review aloud in this order. First the batching box, which opens "ONE PAYMENT OPERATION CAN HOLD SEVERAL TRANSFERS": anyone who obtained the payment key could take up to the account's whole balance of that token in one operation, though only to this payee. Then the plain sentence ("Pays … up to … every … until …: at most one payment per period, each sent by this wallet after you confirm it.") and the on-chain lines. The schedule starts when **Start recurring payment** is tapped, and the first payment is due right away.
- Tap **Start recurring payment**. Expect two system prompts on the demo emulator: "Approve this recurring payment", then a second prompt that protects the new payment key, because the emulator wallet's recovery phrase is in protected storage.
- The card on the Sessions screen shows the first payment as due, with **Send the payment now**. Tap it: the wallet's own dialog asks "Send this payment now?" with **Cancel** and **Send payment**. After **Send payment**, expect one system prompt, "Use the session key" (the payment key is protected; a wallet whose phrase is not protected shows no system prompt here). The recovery phrase is never opened for a payment.
- To show the reminder, leave the app and come back while a payment is due: a banner says "1 recurring payment is due. Each is sent only after you confirm it on the Sessions screen." with **Review** and **Not now**. The due check itself raises no prompt.
- Optional, **proven in the wallet's own development build on 2026-10-11 UTC; not available inside Expo Go** (phase 17 item 2): Settings → Privacy → Notifications → **Remind me when something is due** (off by default; the first time, Android asks for the notification permission). With it on, the wallet schedules a notification "Recurring payment due" for the moment the next payment of a schedule falls due, to be shown even while the wallet is in the background or closed (delivery has not yet been observed); tapping it opens the Sessions screen. Say that the reminder is scheduled on the phone with no notification service, names no amount, address or payee because it can appear on the lock screen, and never sends anything. After a force stop Android drops the reminder until the wallet is opened again. Since phase 18 item 0 the notification carries the wallet's own small icon (a white Shiba head on a transparent background, with the wallet's accent colour `#a65d13` as the notification colour), but only in a development build made after that change: native configuration is fixed when the build is made, so run `npx expo prebuild --platform android --clean` and then `npx expo run:android` (`docs/DEVICE_BUILDS.md`, "Rebuild after native configuration changes"). The development build used for the 2026-10-11 reminder proof predates the icon, and the new icon has not yet been seen in the notification shade.
- End with **Revoke (stop the recurring payment)** on the card (one prompt). A schedule whose payments have all been sent offers **Revoke and forget** instead.

**What to say:** this is "pay my rent every month" without handing anything to a third party. The account itself limits the payment key to one payee, one amount cap, one payment per period, an end date and a fee budget; the key never leaves this phone; and the wallet sends each payment only while it is open and only after the user confirms it. Nothing runs in the background: that would need a development build and a decision on whether a payment may ever go out without the user present. Be honest about the batching limit in the first box, as in step 10.

**What it proves:** on 2026-10-09 a recurring payment of 1,000 wei every 5 minutes was set up from the Sessions screen (block 11881366), two payments were sent by the recurring key alone after the in-app confirmation with exactly one device prompt each and no recovery-phrase prompt (blocks 11881383 and 11881417, the second as a catch-up after the banner), and the plan was revoked and forgotten (block 11881439); the third payment was lost to a transient network error near the plan's end, which led to the grace-period fix. The on-chain limits are the subscription grant's, which the keeper exercise of step 10 pulled against earlier.

**Fallbacks:** if the Sessions link is missing, see step 10. If a payment is refused, the card keeps "Last payment attempt refused: …" with the reason. A payment that would go over one of the app's spending limits is not sent, and there is deliberately no "send anyway".

### Step 20. A 2-of-3 multi-signature account, by script only

This step shows the engine's proof from a terminal on the host (phase 15 item 2, `docs/MULTISIG.md`). The app's own multi-signature screens, built later, are step 23. The live run is recorded for 2026-10-09 UTC (Sepolia block timestamps).

- Run the dry run, which uses no dev keys, needs no bundler and broadcasts nothing (each check is a read-only `eth_simulateV1` request against the real EntryPoint, Kernel v3.3 and weighted validator on Sepolia, for an undeployed 2-of-3 account of the public BIP-39 test mnemonic):

  ```
  npm run build
  node scripts/testnet/multisig-smoke.mjs
  ```

  Point out, in its output: an operation signed by two distinct signers is accepted; one signer alone, and one signer used twice, are refused (`AA24 signature error`); one signer duplicating its own signature makes the account's message check (`isValidSignature`) return `0x1626ba7e`, while the same signer's single signature is rejected; and the exposure lines, for example a 2-of-2 needing 2 signers for an operation but 1 for a message.
- Then show the live account on `sepolia.etherscan.io`: `0xd927ac18Cd58D4E6DdfD8D97D0B3e78c64f28c57` (dev seed indices 0, 1 and 2, weight 1 each, threshold 2). Its deployment and first operation were self-bundled in transaction `0xb28a55de36be77d7d43c3220c43580523715ebbcea46d4f0078c6ced0a01b6c4` (block 11879418), and a second operation went through ZeroDev's bundler in transaction `0x716bb33a2b1c8fa76a1cf55228fad6a5fd22e8079e164324ffd5244b5a37e508` (block 11879423). About 0.0017 test ETH was left in it for demonstrations.
- Do not run the live leg (`MULTISIG_SMOKE_LIVE=1`) for a demo: it uses the dev seed's keys and spends test ETH, and the dry run shows the same behaviour.

**What to say:** in a modular account, multi-signature is a validator choice, and with the deployed weighted validator as the account's root an operation really needs two of the three signers. The same validator's message check counts a repeated signer, and the analysis proves that no choice of weights fixes that, so this wallet will never let a multisig account sign messages, logins or permits. Co-signers approve the calls and the nonce; the submitter alone chooses the fees and any paymaster. Stronger designs (Safe with its ERC-4337 module, Rhinestone's ownable validator) were compared from their sources but none is adopted yet.

**What it proves:** the dry run against the real contracts, and the live 2-of-3 on Sepolia: deployed and operated, with a second operation accepted by ZeroDev's bundler, which settled that a real bundler accepts operations from a weighted-root account (phase 15 item 2). Not shown anywhere: a bundler-accepted deployment of such an account, session keys or passkeys on it, and the delayed path. The app's screens exist since phase 17 item 1 but have not yet been rehearsed (step 23).

---

### Step 21. A dApp inside the wallet: the in-app browser

Account 1 on Ethereum Sepolia with a little test ETH. Rehearsed live in-app on 2026-10-10 (phase 16 item 2).

- Home → **Apps**. The screen is titled "Apps (test networks)". There is no address field: two cards, Uniswap and the ENS app, each with its origin and "Why it is listed", and a box headed "What this test build cannot yet prevent" that states what the web-view library allows on Android until a native build exists (a silent camera grant, cookies on downloads, the file picker).
- Open Uniswap. The bar shows `https://app.uniswap.org` and "Not connected · Ethereum Sepolia (test network)". In Uniswap's wallet picker, "Shiba Wallet — Detected" appears through EIP-6963. Connect: the same approval sheet as WalletConnect, with the line "Opened in this wallet's browser: the request came from https://app.uniswap.org, as reported by the web view (not a name the site gives itself). This confirms which site asked, not that the site is safe." One device prompt. The first connection can take a minute or two while Uniswap's own backend runs its checks.
- Turn on Uniswap's testnet mode in its settings and swap a small amount of test ETH for USDC. The wallet sheet shows the transaction, the balance-change preview ("You send 0.0001 test ETH / You receive 5.286847 USDC"), the risk card and "Pre-flight simulation passed (eth_call)". One prompt. The hash goes back to the page.
- Open the ENS app and choose "Sign in with Wallet": the SIWE card shows the site, account, network, URI and the exact message; one prompt "Sign for app.ens.dev".
- Tap a link that leaves the site (Uniswap's Developers page): "Open outside the wallet?" with the full URL; Cancel keeps the page.
- Settings → Developer → Off (mainnet): the Apps link disappears and the screen shows only the test-networks-only card. Switch back.

**What to say:** the wallet now has two ways into dApps, WalletConnect and its own browser, and both go through one approval path. The browser knows the site's real origin first-hand, which WalletConnect cannot, but that proves which site asked, not that the site is honest.

**What it proves:** on 2026-10-10 a swap started inside the wallet's browser was simulated, approved and included (block 11882561) with the USDC received equal to the preview, and the ENS app completed a Sign-In with Ethereum through the SIWE card. The emulator's WebView dates from 2023 and still rendered both sites.

### Step 22. Screen protection: what the wallet hides from screenshots and the app switcher

Rehearsed on the emulator on 2026-10-10 (phase 17 item 0). **If the demo is being recorded or screenshotted on the phone itself, do this step first, before anything else.**

- Settings → **Privacy** → the switch **Hide in the app switcher and block screenshots**. It is on by default. On Android it makes every screen of the wallet come out blank in screenshots, screen recordings, `adb screencap` and the recent-apps thumbnail, so a recording of the demo would show nothing but black frames. Switch it **off** for a recorded demo; the status line reads "Screen protection is off." Switch it back **on** at the end ("Screen protection is on.").
- To show what it does: with the switch on, open the recent-apps view. The wallet's card is blank. Switch it off and open the recent-apps view again: the card now shows Home with the balances.
- Read the two notes under the switch: "On Android this also blocks screenshots and screen recording of every screen in this wallet, including your Receive QR; copy the address instead. On iOS, screenshots come out blank and the app switcher shows a cover." and "The screens that show or take in your recovery phrase or a private key are always protected, whatever this setting." (The private-key import screen is protected once its field holds text.)

**What to say:** the wallet is meant for real value, so it errs on the side of caution: nothing on its screens reaches screenshots, recordings or the app switcher unless the user chooses otherwise. The cost on Android is that the user cannot screenshot their own Receive QR, and the setting says so.

**What it proves:** on 2026-10-10, with the switch on, every `adb screencap` was empty (Home, Settings, the account-switcher dialog, the lock screen) and the recent-apps thumbnail was a blank card; with it off, screenshots worked and the thumbnail showed Home with balances; a stored "off" survived a restart. iOS has not been tested, and native alerts, system dialogs and the fingerprint prompt are not known to be covered.

### Step 23. A multi-signature account in the app

**Rehearsed live in-app on 2026-10-10** (phase 17 item 1): a 2-of-3 was created at the predicted address, deployed by its first operation through ZeroDev's bundler (block 11885650), operated a second time (block 11885722), and this wallet co-signed a third request (block 11885853); the refusals, the mainnet gate and remove-and-re-import behaved as designed. Expect a weighted-root deployment to need a few thousandths of test ETH at today's Sepolia fees, and a first Review may be refused for funds with the exact shortfall unknown; fund the multisig address and review again. Ethereum Sepolia, Account 1 active, a little test ETH on Account 1 to fund the new account. The co-signer is played from the host by a scratch helper, `multisig-cosigner.mjs`, which signs with keys of the dev seed (`.dev-wallet/mnemonic.txt`); it was written for the phase 17 emulator pass and **is not part of the repository**, so get a copy from the CTO before the rehearsal. Its usage, from the repository root with the engine built:

```
node multisig-cosigner.mjs address 5                        # the dev index-5 address, to use as the co-signer
node multisig-cosigner.mjs approve request.json 5 > approval-5.json
```

- Home → **Multisig** (shown on test networks) → **Create a multisig**. The screen "New multi-signature account" takes this wallet's signer (Account 1) with its weight and one or more co-signers (**Add a co-signer**: paste the dev index-5 address). The app refuses any set in which one signer could act alone. Tap **Review**.
- Read the review aloud: the account is always a new account, deployed fresh, never converted from an existing one; the exposure line (for an account that needs two signers: "Any 2 co-signers together can send an operation; for messages the deployed validator needs only 1, so this account must never be used to sign logins, orders or token permits — the wallet refuses that."); "Co-signers approve the calls and the nonce, not the network fee or paymaster, which the submitter sets."; and the note that the signer module has no published audit. Tap **Create this multisig**.
- Send a little test ETH from Account 1 to the multisig's address (shown with a QR code on the Multisig screen). The account says it is not deployed yet: its first operation deploys it, and that operation also needs the co-signers' approvals.
- **New operation (send)**, for example 0.0001 test ETH to the "Burn" contact, then **Build the signing request**. Share the request as a file or as text and move it to the host (this transport has not been rehearsed). On the host, sign it as the co-signer with the helper's `approve` command.
- Back in the app, **Add approval** (paste the approval) or **Add an approval from a file**, then **Review and submit** → **Approve and submit**. Expect one device prompt for Account 1's own signature. This first operation also deploys the account.
- To show the refusals: the multisig is never offered over WalletConnect or in the Apps browser, and the Guardians, Inheritance, Passkey and Sessions screens do not accept it.

**What to say:** the same validator as step 20, now in the app: a shared account that needs two signers for every operation, with approvals collected off the device the way guardian approvals are. The screens say plainly that this account must never sign messages, logins or permits, and the wallet refuses to.

**What it proves:** on 2026-10-10 a 2-of-3 was created from the Multisig screen at the engine-predicted address and deployed by its first operation through ZeroDev's bundler from the app (block 11885650; the weighted validator read back as the root), a second operation approved by the other co-signer was included (block 11885722), and this wallet co-signed a third request that the submitter used (block 11885853); the network and account refusals, the mainnet gate and remove-and-re-import at the same address behaved as designed. Message signing stays refused by design, because the deployed validator would accept fewer signers for a message than for an operation.

**Fallbacks:** if the bundler refuses the first operation, the app shows its message verbatim and adds: "If the bundler refused because of the prefund or the fee, send a little more test ETH to the multisig address and try again. The approvals stay valid as long as no other operation used this nonce." Test networks only: on mainnet the Multisig link is not shown.

### Step 24. Add a network: Polygon Amoy as a test network

**Not yet rehearsed with Polygon Amoy.** This step was rehearsed live on the emulator on 2026-10-10 (phase 17 item 3) with Hoodi, before Hoodi became a built-in test network in phase 18 (step 25): Hoodi was added, used and removed, and every refusal appeared exactly as the app's checks pin it. The form now refuses Hoodi's chain id `560048` as "already built in", so the walk-through below uses Polygon Amoy (chain id `80002`), which is on the wallet's list of well-known public test networks and is not built in. The screens and refusals are the same code as in the rehearsal; only the network differs. The endpoint below was probed read-only on 2026-10-11 at 05:27 UTC: `eth_chainId` answered `0x13882` (80002), the newest block was 49,873,916 and 1 second old, and the block 100 below it was 100 seconds older (about 1 second per block). Probe it again before presenting. No funds are needed: the wallet holds no Polygon Amoy test POL, so balances read 0.

- Settings → Developer → **Networks you added**. In the form: name `Polygon Amoy`, chain id `80002`, RPC `https://polygon-amoy-bor-rpc.publicnode.com`, symbol `POL`, no explorer, and **This is a test network** on. Tap **Verify and save**. The wallet checks that the endpoint reports chain id 80002 and that its newest block is less than 10 minutes old, measures the block time over 100 blocks, and only then saves.
- Choose **Polygon Amoy** under "Networks you added". The banner should read "TESTNET — Polygon Amoy test mode is on (a network you added). Amounts are test POL, not real funds." (built from the same code as the rehearsed Hoodi banner). Home's EVM row takes the network's name and should show 0 test POL.
- To show the refusals: enter chain id `11155111`, which is refused with "Chain id 11155111 is already built in as Ethereum Sepolia; choose it in the network list above instead. Nothing was saved."; enter chain id `560048`, which is refused because Hoodi is built in; enter the Polygon Amoy endpoint with chain id `59141`, which is refused with "This RPC endpoint serves chain id 80002, but you entered chain id 59141. Nothing was saved. Check the chain id or the RPC URL."; tick "This is a test network" for a chain id not on the wallet's list of well-known test networks (for example `137`), which is refused because the wallet would then treat real funds as worthless. The note under the switch lists the networks that can be added as test networks: Polygon Amoy, Linea Sepolia and Scroll Sepolia. Holesky (`17000`) is no longer on that list, because the Ethereum Foundation announced its end of life; ticking it is refused with its own sentence.
- Switch back to **Ethereum Sepolia**, then **Remove** Polygon Amoy. The confirmation lists what is deleted for that network and what is kept (records needed to revoke or recover).

**What to say:** a user can add any EVM network without a new release, and the wallet verifies the endpoint before saving it. A network the user adds counts as a main network, with real-funds caution, unless it is a well-known public test network and the user says so. The endpoint is the user's choice and the wallet trusts it for that network's balances and previews, so it should come from a source the user trusts.

**What it proves:** the add, use and remove flow and its refusals were shown live on 2026-10-10 with Hoodi; for Polygon Amoy, only the offline checks (`check-custom-networks.mjs`) and the read-only endpoint probe of 2026-10-11 above. Swaps, prices and names are never offered on an added network, and smart accounts only after the user pastes a Kernel factory address that the wallet verifies on-chain.

**Fallbacks:** a Hoodi or Holesky record saved by an earlier version keeps working: a Hoodi record is replaced by the built-in profile on load, with a one-time note in Settings, and a Holesky record stays a test network. If the endpoint's newest block is more than 10 minutes old, the save is refused; use another Polygon Amoy endpoint you have checked.

### Step 25. Two more test networks: Hoodi and OP Sepolia

**Rehearsed live in-app on 2026-10-11** (phase 18 items 1 and 2, "PROVEN LIVE IN-APP"). Nothing was sent on either network, because the wallet holds no ETH there (preparation). Account 1.

- Settings → Developer. The network choice reads "Off (mainnet) / Ethereum Sepolia / Base Sepolia / Arbitrum Sepolia / Hoodi / OP Sepolia", and the hint under it names the five test networks with their chain ids and explorers.
- Choose **Hoodi** (chain id 560048, the Ethereum test network meant for staking). The TESTNET banner follows the choice, the Developer section reads "Test mode is ON (Hoodi)…", and there is no layer-2 note. Settings → Network endpoints shows "Hoodi — default (1 of 3: ethereum-hoodi-rpc.publicnode.com)". Home's Ethereum row reads "Hoodi" with 0 test ETH and the links Send, Activity, NFTs, Approvals, Apps and **Staking**: no Swap, Upgrade, Multisig, Sessions, Guardians or Passkey, and no token rows.
- Show why: Hoodi has no smart-account stack. Settings → Account Abstraction → the Hoodi row reads "incomplete" with the sentence "No Kernel v3.3 factory is pre-filled on Hoodi: the wallet checked this network and found the Kernel v3.3 factory and implementation have no code there, so smart-account features are not available on it. …". Paste the Kernel factory address used on the other networks: the save is refused because the factory "has no code on this chain". These refusals come from the wallet's deployment checks, not from the readiness switchboard, which lists Hoodi as a test network like the others.
- Home → **Staking** on Hoodi: Lido's four risk sentences and Rocket Pool's two FAQ sentences, each with source and date, and the sentence that Rocket Pool's documentation has no page on the risks of holding rETH; the note that staking from a smart account is not offered on Hoodi; zero balances; "Minimum deposit 0.01 test ETH; deposit fee 0.05% (both read just now)"; refusals for an amount below the minimum or above the balance; and "Nothing to claim…". Do not go further: a send of 0.001 is refused for funds.
- Choose **OP Sepolia** (chain id 11155420, an OP-stack layer 2 like Base Sepolia). The banner and the layer-1 data-fee note appear (the note includes "(0x does not support OP Sepolia)"). Home shows a USDC row and the Upgrade and Multisig links, and no Staking link. Manage tokens reads "Tokens · OP Sepolia" with USDC at `0x5fd84259d66Cd46123540766Be93DFE6D43130D7`.
- Settings → Account Abstraction → the OP Sepolia row: the Kernel factory pre-fill is verified on-chain ("Verified ✓") and can be saved; it is already saved on the demo emulator. **Pay the network fee in USDC** is not offered on OP Sepolia, because Circle's paymaster for EntryPoint v0.7 is not deployed there.
- Optional: Settings → Developer → Networks you added, chain id `560048`: refused with "Chain id 560048 is already built in as Hoodi; choose it in the network list above instead…".
- Switch back to **Ethereum Sepolia**.

**What to say:** each network the wallet ships with was checked on-chain, and the screens show what each one has and lacks instead of pretending they are alike. Hoodi is Ethereum's staking test network and has none of the smart-account contracts, so the wallet offers only the regular account there; OP Sepolia has the same Kernel contracts as Sepolia, byte for byte, but no token paymaster, so the fee in USDC is not offered.

**What it proves:** on 2026-10-11 the app showed both networks as described above, verified and saved the OP Sepolia Kernel factory on the device, refused the factory on Hoodi, and refused to add Hoodi as a custom network. Not shown: any transaction on either network, the OP Sepolia smart-account path (no bundler is saved there), and a real layer-1 fee on OP Sepolia.

**Rough edges recorded in that pass** (a fix slice was dispatched for them, so check the screen before presenting): Hoodi's Home footer still offers "Recover an account with guardians", although Hoodi has no guardian contracts (do not tap it); the Developer hint says each test network runs the smart-account path, which is not true of Hoodi; OP Sepolia's Tokens text mentions EURC, which does not exist there.

### Step 26. Staking on Sepolia with Lido

**Rehearsed live in-app on 2026-10-11** (phase 18 items 1 and 2, "PROVEN LIVE IN-APP"): stake for stETH (block 11889090), stake for wstETH (block 11889104), the exact approval and the wrap (blocks 11889114 and 11889119), the unwrap (block 11889130) and a stake from the smart account (block 11889151). Account 1 on Ethereum Sepolia; funds as in the preparation section. Staking is test networks only (Settings → Mainnet readiness, "Staking (Lido and Rocket Pool) — Test networks only").

- Home → Ethereum row → **Staking**. Read the top aloud: "Lido calls its deployment on this network deprecated. Test stETH here does not earn rewards: Lido's oracle has not reported since 2 July 2025." Then Lido's own four risk sentences under "Lido's own statement of the risks of staking with Lido:", with the source (Lido's help centre) and the date they were read. The wallet quotes Lido rather than writing its own summary.
- **Stake → stETH**, amount 0.001, **Review**. The confirm shows "You send 0.001 test ETH", "You receive ≈ 0.001 stETH" and "Simulated: 0.000999999999999999 stETH…", the rebasing note ("stETH is a rebasing token: its balance changes when Lido's oracle reports, without any transfer. …"), the fee, the balance-change preview and "Pre-flight simulation passed". One prompt: "Stake 0.001 test ETH with Lido for stETH". The stETH that arrives is 1 wei short of 0.001, as the note says it can be.
- **Stake → wstETH**, 0.0005. The contract line reads "LIDO WSTETH CONTRACT (STAKE AND WRAP IN ONE STEP)" and the outcome showed "You receive ≈ 0.000481826550135307 wstETH" at the rehearsal (the figure follows Lido's rate). This is a plain transfer of test ETH to the wstETH contract, with no calldata.
- **Wrap stETH**, 0.0005. Step 1 of 2 approves exactly that amount: "… This approves exactly 0.0005 stETH, never more, and the next step uses all of it." Prompt: "Approve exactly 0.0005 stETH for Lido wstETH contract (wrap)". Step 2 is quoted again after the approval is included, and its preview shows "Approval revoked", because the wrap uses all of it. Prompt: "Wrap 0.0005 stETH into wstETH". Nothing stays approved afterwards.
- **Unwrap wstETH**, 0.0004. One prompt. The stETH that arrives can be 1 wei below the figure shown, which is the case the rebasing note describes.
- **Unstake (request)**: the screen says "Unstaking through Lido is paused on Sepolia: its withdrawal queue reports that it is paused (read just now) and has never accepted a request. …", and Review stays disabled. **Claim** says "Nothing to claim…".
- **From the smart account**: switch on **Use the smart account** and stake 0.0005 for stETH. The confirm shows the owner and the smart account, the calls, the "Max network fee (bundler estimate)" (0.001454470713777846 test ETH at the rehearsal), the EntryPoint deposit row with its top-up, and "Bundler gas estimate passed (eth_estimateUserOperationGas simulated the operation)." One prompt: "Stake 0.0005 test ETH with Lido for stETH from your smart account". At the rehearsal the success screen showed only the UserOperation hash, not the bundle transaction (a recorded finding); look the transaction up on the explorer if the audience wants it.
- **Say the fee caveat aloud.** That smart-account stake cost 0.0010078 test ETH in fees to stake 0.0005, twice the amount staked: the bundler's price on Sepolia was 2.04 gwei against about 0.001 gwei for the regular-account stakes, about 2,000 times the network's base fee. This is accepted on a test network and is to be revisited before mainnet (`docs/THREAT_MODEL.md`, F-71).

**What to say:** staking from a wallet is a handful of contract calls to protocols the wallet does not control. The wallet pins those contracts from Lido's published list, quotes Lido's own risk statement, approves exact amounts only, checks whether a step is paused before offering it, and says plainly that a stETH balance moves by itself.

**What it proves:** on 2026-10-11 each operation above was included on Sepolia and matched its preview: 999,999,999,999,999 stETH minted for 0.001 test ETH (block 11889090); 481,826,550,135,307 wstETH minted, equal to the simulated figure (block 11889104); the wrap after an exact approval, with the allowance 0 afterwards (blocks 11889114 and 11889119); the unwrap (block 11889130); and the smart-account stake through ZeroDev's bundler, which delivered 499,999,999,999,999 stETH to the Kernel account (block 11889151). Before that, the dev EOA had staked once through the app's code by script (block 11888829).

**Changed after the rehearsal and not yet seen on screen:** phase 18 item 3 makes the risk card name the pinned contract ("This transaction goes to Lido's stETH contract on Ethereum Sepolia (0x…), pinned by this wallet from Lido's published list of deployed contracts."), where the rehearsal showed the generic lines; tracks stETH and wstETH after a successful stake, where the rehearsal's preview labelled stETH an "untracked token"; and adds a rebasing note under the stETH row on Home.

**Fallbacks:** do not try a stake larger than the balance: a recorded bug shows the contract's own revert ("execution reverted: ZERO_DEPOSIT") instead of "not enough test ETH" (a fix is in progress; F-70). An amount of 0 is refused with "Enter an amount greater than zero.". Base Sepolia, Arbitrum Sepolia, OP Sepolia and mainnet have no Staking link. Staking on Hoodi (Lido's withdrawal request and claim, Rocket Pool's deposit and burn) is built but needs Hoodi test ETH (preparation); without it, show the Hoodi screen from step 25.

### Step 27. A multi-signature account in the account switcher

Built in phase 18 item 3 (commit `cd120b1`) and rehearsed on the emulator on 2026-10-11 (`AGENTS.md`, phase 18, "Item 3 PROVEN ON THE EMULATOR"). Ethereum Sepolia, with a multisig recorded in this wallet: if the emulator still holds the one from the phase 17 pass (re-imported there as "Multisig 2 (2-of-3)"), use it; otherwise create one as in step 23. Where a quoted label differs on screen, trust the screen.

- Home → **Switch**. Multisig accounts are listed last, each with a "Multisig" chip and the line "Multisig — operations need co-signers; Ethereum networks only". Choose one. Its name is its shape label, for example "Multisig 2 (2-of-3)".
- Home shows the notice "Multi-signature account: no single key in this wallet can send from it. Its operations are signing requests that its co-signers approve on the Multisig screen. It cannot sign messages or connect to apps." The Ethereum card shows the balance and an EntryPoint deposit row (both hidden when Hide amounts is on) and the links Activity, Receive, Multisig, Manage tokens, NFTs and Approvals. There is no Send, Swap or Upgrade, no account-tools row and no recovery link. The Bitcoin, Dogecoin and Solana rows read "Not available for a multi-signature account. …". On a network other than the one the multisig is recorded on, a note names that network.
- **Receive** shows the address, its QR code and "This is the multi-signature account's own address. Anyone can send to it, but every operation that moves anything out of it needs its co-signers' approvals, built on the Multisig screen." There is no Send button, no payment request, no proof of ownership and no smart-account box.
- The Send refusal: Home → **Manage tokens** → **Send** next to a token (this path is read from the code: the Tokens screen keeps its Send buttons, and the route gate catches them). The screen shows "Sends from a multi-signature account are signing requests for the co-signers; build one on the Multisig screen.", a hint naming this wallet's signer account for the multisig, and an **Open the Multisig screen** button. **Approvals** opens read-only, without Revoke.
- Switch back: Home → **Switch** → **Account 1**.

**What to say:** a shared account now sits in the same switcher as the user's own accounts, but the wallet never pretends that one key can move its funds: every way out goes through the co-signers on the Multisig screen.

**What it proves:** rehearsed on the emulator on 2026-10-11 with the multisig from step 23: the switcher row and chip, the Home notice, the balance and EntryPoint deposit rows (masked by Hide amounts), the other-network sentence on Base Sepolia, Receive with a QR that decodes to the multisig's address and only "Copy address" under it, Activity naming the multisig as the sender of its own operations, the Apps, Connected apps and Send refusals with the signer hint, the ordinary unlock prompt after the auto-lock (never the recovery-phrase prompt), and the switch back to Account 1, all with zero prompts apart from the unlock. Offline, the mutants for a multisig that could sign, a device check that would open the recovery phrase, Send not refused, the Apps link offered and Activity not recognising the multisig are each caught. The multisig's on-chain behaviour is step 23's live run.

**Fallbacks:** Settings → Accounts lists multisigs read-only under "Multi-signature accounts" (shape label, short address, network) but cannot switch to one, so choose it from the Home switcher. If the active multisig's record is removed, the wallet switches to Account 1.

### Step 28. OP Sepolia: a smart-account send with the layer 1 data fee

Account 1 with a little OP Sepolia test ETH on its regular address and on its Kernel smart account. **Rehearsed live in-app on 2026-10-11** (phase 19 item 0a). OP Sepolia is an OP-stack layer 2, like Base Sepolia, and is now a built-in test network.

- Settings → Developer → **OP Sepolia**. The banner appears, with the layer-2 note: the layer 1 data fee shows on a regular-account confirm, a smart-account send pays it through the bundler's gas estimate, and swaps are not offered here (0x does not support OP Sepolia).
- Save the OP Sepolia bundler if it is not already saved (the bundler chain-id check refuses a bundler saved for another chain, naming both chain ids).
- Home → Ethereum → **Send**, smart-account toggle on, a small amount to Account 2. If the Kernel account is not deployed, the confirm says the first send deploys it. One prompt, then "Included on-chain — succeeded." There is no separate layer 1 line on a smart-account send.
- An EOA send of a tiny amount shows "LAYER 1 DATA FEE (ESTIMATE)" with the 50% reserve explained; at the rehearsal the actual layer 1 fee matched the oracle estimate to the wei.

**What it proves:** on 2026-10-11 the app deployed Account 1's Kernel account on OP Sepolia through ZeroDev's bundler (block 49968873) and sent an EOA transfer whose layer 1 fee came in at 99.975% of the worst case (block 49969452). The engine had deployed a Kernel account there by script the same day (block 49967417). The layer 1 component was near-zero (244–280 wei) throughout, so the "extra gas on top" part of the fee model has only been shown at a near-zero L1 price.

### Step 29. Hoodi: staking live through Lido and Rocket Pool

By script on 2026-10-11 (phase 19 item 0b, `scripts/testnet/staking-smoke.mjs`, mode `hoodi`). Hoodi is a staking-focused test network with no Kernel v3.3 deployment, so its smart-account features are refused and staking runs through the regular account. The staking screens render in-app (step 25 reached them with 0 balances), but **no Hoodi transaction has yet been sent from the app's own screens** — show this step by script, or describe it, unless the emulator wallet has been funded with Hoodi test ETH. The script drives the app's own `staking.ts` and `send.ts` code.

- Lido: a stake for stETH, a stake for wstETH, a wrap after an exact approval, an unwrap, and a withdrawal request that mints the queue NFT.
- Rocket Pool: a deposit for rETH (at least 0.01 ETH, the minimum and fee read live), and a burn of rETH back to ETH.

**What it proves:** on 2026-10-11 every operation above was included on Hoodi and matched its on-chain figure — Lido stake to stETH (block 3797182) and wstETH (block 3797184), wrap and unwrap (blocks 3797186–3797190), a withdrawal request minting the queue NFT (block 3797194), a Rocket Pool deposit for rETH (block 3797196) and a burn back to ETH two blocks later (block 3797198), each hash re-read on three RPCs. Unlike Sepolia's deprecated Lido (step 26), Hoodi pays rewards.

**Not yet rehearsed:** the withdrawal **claim** is pending Lido's once-a-day oracle report on Hoodi and has not run live; and the whole Hoodi staking flow through the app's own screens is a later emulator slot.

### Step 30. A multi-signature account by QR, off Ethereum Sepolia

Account 1 with a little Base Sepolia test ETH. **Rehearsed live in-app on 2026-10-11** (phase 19 item 1) — the first multi-signature account off Ethereum Sepolia. This deepens step 23 with the QR exchange and a second network. The co-signer is played from the host by the same scratch helper as step 23 (`multisig-cosigner.mjs`, not in the repository).

- Create a 2-of-3 as in step 23. On Base Sepolia the address is the **same** as on Sepolia for the same signer set, because the signer set determines the address on every chain.
- The request is shown as multi-part QR codes ("Multisig signing request — part 1 of 2", with **Previous part** / **Next part**). The co-signer scans each part with the camera; parts may arrive in any order, and a repeat, a mismatched part or an unrelated code is refused with a plain sentence.
- The approval comes back as a QR code or a file, and an external wallet's bare EIP-712 signature is accepted (v ending 27/28, or 0/1).
- Submit through the bundler: the first operation carries the deployment.

**Emulator note:** QR scanning uses the virtual-scene camera (`adb emu virtualscene-image` plus a pose macro). The file **open** path was fixed after this pass — in Expo Go it had failed for every file with a "Missing READ permission" error, which also broke guardian recovery-file import; both now read the picked file directly (verified against the installed native source, not yet re-run on a device).

**What it proves:** on 2026-10-11 a 2-of-3 was created and deployed on Base Sepolia through ZeroDev's bundler (block 47989600, the same address as on Sepolia), this wallet co-signed another of its operations (block 47989869), and requests and approvals travelled by multi-part QR and by an external wallet's EIP-712 signature; the deployment cost about 0.0000035 ETH.

**Fallback:** if QR scanning is not set up, paste or share the request and approval text as in step 23.

### Step 31. A recurring swap (dollar-cost averaging)

Account 1's Kernel account on Ethereum Sepolia with enough test ETH: the one-time set-up is expensive after Glamsterdam (about 0.016 ETH at today's fees, and the bundler needs about 0.0185 ETH available just to estimate it), then about 0.003 ETH per swap. **Rehearsed live in-app on 2026-10-11** (phase 19 item 2). Dollar-cost averaging is Ethereum Sepolia only, smart account only, test networks only (readiness row `dca`).

- Home → Ethereum row → **Sessions** → **New recurring swap**. The form shows the pinned Uniswap v3 pool (full address, re-checked against Uniswap's factory on every read), the router and quoter, a live quote ("0.00001 test ETH → 0.468907 USDC" at the rehearsal) and the fixed minimum to receive per swap (95% of the quote), plus the set-up cost note.
- **Review** shows every honest caveat in order: the batching box, "THE MINIMUM DOES NOT FOLLOW THE PRICE", no deadline, a reverting swap uses up its period, ETH can be left in the router on a partial fill, the swap key can only buy USDC for this account, the catch-up with its two-period grace, revoke, and where the key lives.
- **Start**: two prompts (approve the plan, protect the new swap key). Then the plan appears under "Recurring swaps" with "Swap now".
- **Swap now** sends one swap after a confirm: exactly one "Use the session key" prompt and no recovery-phrase prompt. The progress line shows the USDC received, the quote just before sending and the minimum asked.
- **Revoke (stop the recurring swap)**, or **Revoke and forget** for a finished plan.

**What it proves:** on 2026-10-11 a recurring-swap plan was installed from the Sessions screen (block 11894109) and one swap was signed by the swap key alone with one prompt (block 11894126; 0.468907 USDC received for 0.00001 test ETH, matched on-chain), then revoked. The engine had proved two swaps and the on-chain refusals (an over-amount swap, an early second swap, a lower floor, another recipient, a swap after revocation) by script the same day (blocks 11893108 and 11893119).

**Not captured in-app:** a second successful swap and the catch-up path — the 2-minute testing period expired after one swap, and the account correctly refused the expired swap on-chain (proof the end date is enforced). Fees dominate at these tiny test amounts (one swap's fee was about 160 times the amount swapped on Sepolia).

### Step 32. Speed up or cancel a stuck transaction

By script on 2026-10-11 (phase 19 item 3, the transaction half of feature 95). The in-app Activity "pending" row with its **Speed up** and **Cancel** buttons is built, but the on-emulator pass is pending, so show this step by script or describe it from the screens.

- A stuck regular-account send (an under-priced fee) appears under "Pending on this phone" in Activity and on the Send success view, with **Speed up** and **Cancel**.
- **Speed up** replaces it with the same nonce and a higher fee — both the fee cap and the tip at least 10% higher, the rule the wallet enforces. **Cancel** sends a 0-value transfer to yourself at the same nonce, so only the fee is paid; the confirm says so instead of a risk card.
- A replacement's full worst-case fee counts toward spending limits, and there is no readiness gate: a replacement is an ordinary regular-account transaction, offered wherever Send is.
- A smart-account operation cannot be replaced from this wallet: it explains plainly that the bundler holds the submitted operation and the EntryPoint nonce decides what runs, and it offers a re-quote once the bundler has dropped the operation.

**What it proves:** on 2026-10-11 an under-priced send was sped up (the replacement was included in block 11893089 and the original dropped) and a second was cancelled (block 11893098, so the original will never be included); an already-included nonce was refused. The EIP-1559 replacement rule (both fields at least 10% higher) was verified from the go-ethereum and reth sources.

**Not yet rehearsed:** the Activity "pending" row and its Speed up / Cancel buttons on the emulator, a bundler-dropped operation and the smart-account "Send again" path.

## Known rough edges (development builds only)

- **LogBox toasts.** React Native's development warnings appear as toasts at the bottom of the screen and can sit exactly over the approval sheet's **Approve & send** button. Tapping one opens LogBox; its **Dismiss** control closes it. Release builds do not have LogBox. A "Cannot connect to Expo CLI" toast means Metro was started with `CI=1`.
- **The Expo floating button** overlaps Home's account **Switch** control. Tap the left edge of Switch. The Expo developer menu can also catch taps near the top right.
- **Adding an account takes about 15 seconds** on this software-rendered emulator (the seed is stretched in JavaScript). Add accounts before the audience arrives. It has not been measured on a real phone.
- **The keyboard covers the WalletConnect sheet** after pasting a link; hide it before scrolling.
- **An intermittent "Error: undefined" warning** sometimes appears in the logs during long sessions; it has never affected a flow.
- **WalletConnect links expire** in four to five minutes; keep the wallet on the Connections screen before requesting one.
- **After a cold boot** the emulator asks for the PIN before Expo Go can even start (see preparation).
- **Uniswap's error wording** for transactions the wallet declined on purpose (wrong account, wrong network mode) is a generic "Swap failed — try adjusting slippage"; that text comes from Uniswap, not the wallet.

## What this demo cannot show

Passkeys need a development build and a domain for the passkey relying party, neither of which exists yet, so the Passkey screen will explain that it needs a development build; describe the engine's simulation proof instead (phase 8 item 3). Gas sponsorship needs a paymaster policy (phase 10 item 2 was probing for one). Live swap quotes inside the wallet's own Swap screen need a 0x API key. Face ID, hardware-backed storage and screen readers need real phones. Staking on Hoodi (Lido's withdrawal request and claim, Rocket Pool's deposit and burn) needs Hoodi test ETH, which the wallet does not hold; smart-account features cannot be shown on Hoodi at all, because the Kernel contracts are not deployed there.
