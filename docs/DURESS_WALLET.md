# Duress and Decoy Wallet (feature 53): Design

Status: design document, phase 20 item 2, written 2026-10-11 against HEAD
`a104227`. No code was changed for this item. The decision in section 5 is
**design only for now**: no honest slice can be built until two
prerequisites exist (a lock that also covers a cold start, and a single
storage seam that every per-wallet record goes through). Section 6 specifies
the slice so that it can be built as soon as they do.

Every fact below names its source: the installed package sources under
`app/node_modules` (with the version), this repository's own code (file and
line), a public product page read on 2026-10-11 (URL), or a measurement made
for this document (the command and the machine). Anything that could not be
checked is marked as unverified.

---

## 1. What the feature is, and what it must never do

### 1.1 How shipped products define it

A duress or decoy wallet is a second credential that, when given up under
coercion, opens a believable wallet holding little, while the real wallet
stays closed and, ideally, cannot be shown to exist. Three shipped products,
read on 2026-10-11:

- **COLDCARD (Coinkite), "Trick PINs"** —
  <https://coldcard.com/docs/pins/>. A trick PIN can be set to "log into a
  duress wallet of your choice", and then "the COLDCARD acts as if the true
  Main PIN was entered. The main wallet is not accessible." The duress wallet
  is derived from the main seed with BIP-85 ("a derivation path index of
  `1001`, `1002`, or `1003` for wallets 1-3, if you have a 24 word seed").
  Other trick PINs brick the device ("will only display the word `Bricked`
  forever") or start a login countdown, and "After 13 failed PIN attempts the
  COLDCARD will always brick itself, regardless of any other settings." The
  page does not state that the duress mode is indistinguishable from the real
  one.
- **BlueWallet (a mobile wallet), "Plausible Deniability"** —
  <https://bluewallet.io/docs/plausible-deniability/>. "BlueWallet stores your
  wallets in an encrypted container on your device. With Plausible
  Deniability, the app keeps multiple encrypted containers (called buckets).
  Each password unlocks exactly one of them." "When you open the app, the
  password you enter decides which storage you see. There is no switch inside
  the app. The storages are completely separate: wallets, transaction history,
  and settings saved in one storage do not appear in the other." "The second
  storage is real, not a visual trick." It warns that one operation means
  "Every other encrypted storage is deleted permanently", and that each
  storage's recovery phrases must be backed up.
- **Ledger, a passphrase attached to a second PIN** —
  <https://www.ledger.com/academy/passphrase-an-advanced-security-feature>.
  "Another option is to link a passphrase of your choosing to a secondary PIN
  code." "If you enter your secondary PIN code, you'll gain access to your
  passphrase-protected accounts." On coercion: "With a passphrase, you can make
  someone believe they have full access to your crypto assets", keeping "a
  small balance on your regular accounts while most of your crypto sits on
  hidden accounts." And: "If you forget your passphrase, access to the
  associated hidden wallet is permanently lost."

Two shapes recur. In the hardware model (COLDCARD, Ledger) the device itself
decides, from the PIN, which seed to unlock, and the secret that separates
the wallets lives in a secure element. In the app model (BlueWallet) every
wallet's data, including its history and settings, lives in a container
encrypted under that wallet's own password, so the password, not a switch,
decides what the app can even read. Both models depend on one property this
app does not have today: **all of a wallet's data is reachable only through
the credential that opens it.**

### 1.2 What a decoy must never do

These rules are the acceptance test for any future slice. A decoy that breaks
one of them is worse than no decoy, because a coercer who catches a deception
has a reason to escalate.

1. **Never reveal under the decoy that a duress mode exists or is in use.**
   Every screen under the decoy must read as an ordinary wallet: no "decoy"
   label, no badge, no setting that says a second wallet is configured, no
   difference in timing or prompts between opening the decoy and opening the
   real wallet.
2. **Never show any of the real wallet's data under the decoy.** Not its
   addresses, balances, accounts, contacts, transaction notes, tracked tokens,
   WalletConnect or in-app-browser connections, smart-account records,
   sessions and subscriptions, multisig or recovery records, pending
   transactions, spending limits, reminders, or custom networks.
3. **Never read the real wallet's secrets while the decoy is open.** The real
   recovery phrase and imported keys must not be read (not even by the lock
   screen's own prompt; see section 2.3), so a bug elsewhere cannot leak them
   and a protected-storage prompt cannot appear for a secret the decoy does
   not own.
4. **Never weaken the real wallet.** Adding a duress credential must not lower
   the protection of the real phrase (protected storage, the approval gate,
   app-wide screen protection) and must not create a path that opens the real
   wallet with less than it needs today.
5. **Never let the real wallet's existence be inferred from what the coercer
   can do at the screen** — including asking to reveal the recovery phrase
   (the decoy's own phrase is shown), asking to wipe the wallet, asking to
   change the PIN, or watching the notification shade.
6. **Never claim more than holds.** The app must not say "undetectable",
   "hidden" or "invisible". What it can honestly claim is narrower (section
   4.3).

---

## 2. The constraint in this app: the lock is the device's own prompt

### 2.1 What the app can observe about an unlock

The wallet's lock and approval gate are `requireLocalAuth` in
`app/src/wallet/biometric.ts`, which calls `authenticateAsync` from
`expo-local-authentication` with `disableDeviceFallback: false`, so the
system falls back to the device PIN, pattern or password ("Use PIN" on the
emulator). What comes back, from the installed `expo-local-authentication`
57.0.3:

- The JavaScript result type is `{ success: true } | { success: false; error;
  warning? }` (`build/LocalAuthentication.types.d.ts`, lines 1–7). Nothing
  else is returned.
- Android: `onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult)`
  resolves a bundle holding only `success = true`; the `result` object is
  dropped (`android/src/main/java/expo/modules/localauthentication/LocalAuthenticationModule.kt`,
  lines 155–161). The platform class itself
  (`android.hardware.biometrics.BiometricPrompt$AuthenticationResult` in the
  installed Android SDK `platforms/android-36/android.jar`) has two public
  getters, `getAuthenticationType` and `getCryptoObject`: at most "biometric
  or device credential", never which fingerprint or face matched.
- iOS: `context.evaluatePolicy(policyForAuth, localizedReason:) { success,
  error in … }` resolves `success`, `error` and `warning` only
  (`ios/LocalAuthenticationModule.swift`, lines 102–111).

**Consequence: the app cannot tell a "duress finger" from the real finger, or
a second device PIN from the first.** It cannot even tell, through this
package, whether the biometric or the device PIN was used. A duress
credential therefore has to be a secret the app asks for and checks itself:
an **app-level PIN or passphrase entered on the app's own lock screen.**
(Whether the operating system can host a second user profile with its own
credential is outside the app and is not relied on here.)

### 2.2 That reverses a recorded decision

`app/src/wallet/lock.ts` records a "DELIBERATE NO-PIN DECISION": "there is no
custom in-app PIN pad … A homemade PIN pad would be strictly weaker than that
OS credential path", and the Settings note says so to users
(`SettingsScreen.tsx`, the "Auto-lock is unavailable on this device" hint).
The threat model repeats it (T-09: "**Recorded decision: there is no app
PIN**"). A duress PIN does not have to contradict the reasoning — the app PIN
would be an extra gate in front of the wallet, never a replacement for the
device prompt on signing — but it does reverse the decision as written, and
it is the Chairperson's to make.

### 2.3 What an app PIN changes in the lock model

1. **The lock must cover a cold start.** It did not when this was written; fixed on 2026-10-12 (commit `e0ef6c2`): with auto-lock on, the wallet now starts locked (threat-model row F-77, part b).
   `reduceLock` starts unlocked (`INITIAL_LOCK_STATE = { locked: false, … }`,
   `lock.ts`) and locks only when the app returns from the background after
   the threshold; `WalletContext.tsx` (lines 533–590) moves to `ready` at
   launch without any prompt; and `LockGate.tsx` arms only on AppState
   changes. So an app that is killed (swiped away, or reclaimed by the system
   while in the background) opens again **unlocked**, whatever the auto-lock
   setting. The Settings label is honest ("Auto-lock after returning from
   background"), but a duress gate that a coercer can skip by swiping the app
   away is no gate. This is reasoned from the code, not yet observed on the
   emulator with auto-lock on; see the checklist in section 6.7.
2. **The PIN screen sits in front of everything, at every launch and every
   return**, before any wallet data is loaded. Under the current overlay
   design the screens are mounted underneath the lock (only hidden), and the
   wallet's state is loaded at launch; a duress gate must instead decide
   *which* wallet to load before anything is loaded, or the real wallet's
   data is already in memory (and on screen behind a crash or a native window,
   F-27) when the decoy opens.
3. **The device prompt stays, but it no longer decides which wallet opens.**
   Signing inside either wallet keeps `requireLocalAuth`. The app PIN is the
   only thing that chooses between the wallets, because a coercer holding the
   phone can make the victim pass the device prompt anyway.
4. **The lock screen must not open the real phrase under the decoy.** Today
   the unlock button calls `requireLocalAuth('Unlock Shiba Wallet')`, which
   first asks the vault to open the approval target's secret
   (`openPhraseForApproval` in `storage.ts`); with a protected phrase, "gates
   that do not sign (the lock screen) also open the phrase briefly"
   (`biometric.ts` header). Under a decoy the approval target must be the
   decoy's secret, never the real phrase (rule 3).
5. **Brute-force limits move into the app.** The device credential is rate
   limited by the operating system; an app PIN is limited only by what the app
   stores. A delay that grows after failures (section 6.3) stops guessing at
   the screen. It does not stop an attacker who can copy and restore the app's
   files, who can reset the counter, or who can guess offline (section 3.4).
6. **PIN entry needs its own protections.** A digit pad drawn by the app (not
   the system keyboard, which third-party keyboards may learn from; T-04),
   with screen capture blocked while it is shown regardless of the app-wide
   switch, and no "wrong PIN" message that differs between "wrong" and "this
   is the duress PIN".
7. **Auto-lock becomes always-on when a PIN exists.** "Off" cannot be offered
   while a duress PIN is set (otherwise the coercer simply needs the app open),
   and the gate must work on phones without enrolled biometrics, where
   auto-lock is hidden today.
8. **Screen protection.** App-wide screen protection (T-74) must be forced on
   while a duress PIN exists, because the recents thumbnail and screenshots
   would otherwise show whichever wallet was last open; and its Settings
   switch must look the same under both wallets.

---

## 3. Storage: what a reader of the app's data can tell

### 3.1 What is stored where today

**Secure store, Android** (installed `expo-secure-store` 57.0.4,
`android/src/main/java/expo/modules/securestore/SecureStoreModule.kt`): every
item is a string in one private SharedPreferences file named `SecureStore`
(line 370, `SHARED_PREFERENCES_NAME = "SecureStore"`). The preference key is
`"$keychainService-$key"` in plain text (`createKeychainAwareKey`, lines
364–366), so `key_v1-shiba-wallet.mnemonic.v1` and
`shiba-wallet.protected-shiba-wallet.mnemonic.v2` are readable names. The
value is a JSON object holding the AES-GCM ciphertext (`ct`), the IV, the tag
length, the keystore alias and the `requireAuthentication` flag
(`saveEncryptedItem`, lines 227–241; `encryptors/AESEncryptor.kt`, lines
105–107, 136–142). AES-GCM ciphertext has the plaintext's length, so the
**length of a stored phrase (12 or 24 words) and whether an item is
biometric-protected are visible without decrypting anything.** Phase 16's
development-build probe saw exactly these names in `SecureStore.xml`
(`mnemonic.v1`, `vault-meta.v1`, `public-account.v1.0`; `AGENTS.md` phase 16
item 3) and confirmed that Android backup excludes the file and the
device-to-device transfer carries no key material, so reading it needs a
rooted phone or a forensic extraction, not a backup.

**AsyncStorage** is an unencrypted SQLite database (threat model section
3.4). At HEAD, 40 distinct `shiba-wallet.*` key names or prefixes appear as
literals in `app/src` (`grep -rhoE "'shiba-wallet\.[a-zA-Z0-9.-]+'" app/src`),
read and written directly by 30 files that each import AsyncStorage
(accounts, prefs, contacts, tokens, notes, sessions, multisig, recovery,
inheritance, passkeys, spending limits, pending transactions, browser
connections, WalletConnect bindings, custom networks, notifications state and
more). The WalletConnect SDK (`@walletconnect/core` 2.25.0) keeps its own
records, and `expo-notifications` keeps scheduled reminders in the operating
system. **None of these goes through one seam; there is no notion of "which
wallet" below `WalletContext`.**

### 3.2 What a decoy would add, and what it would reveal

The simplest decoy — a second phrase in its own secure-store slot and its own
account-store key — would show up as new key names in `SecureStore.xml` and
in AsyncStorage. Anyone who knows this app (it is public) would see two
wallets. Four ways to reduce that, and what each actually buys:

| Option | What it hides | What it does not hide |
|---|---|---|
| A. Separate, named slots for the decoy | Nothing | Two phrase entries, two account stores, by name |
| B. Fixed-shape slots present on every install (a second phrase slot filled with random data of the same length when no decoy exists; the same for every per-wallet record) | The presence of a decoy from someone listing key names | Anything an attacker can decrypt: a 6-digit PIN that selects the slot is brute-forced offline (3.4); the slot content itself is readable by code running as the app on a rooted phone |
| C. One encrypted container per wallet, BlueWallet-style: every per-wallet record encrypted under a key derived from that wallet's PIN or passphrase | Which records belong to which wallet, if every container has the same shape | With a short PIN, the same offline brute force; and it needs every one of the 40 stores, the WalletConnect SDK store and the reminders re-architected |
| D. A hidden wallet that is never persisted (a passphrase typed at each use, nothing written while it is open, as with a hardware wallet's temporary passphrase) | The hidden wallet entirely: nothing about it is stored | Usability: no saved accounts, contacts, notes, sessions, subscriptions, reminders or smart-account records for that wallet, which contradicts most of this app's features |

**Honest statement: storage-level indistinguishability is not achievable in
this app with a short PIN — with or without a native change — because any
secret that selects or decrypts a wallet can be guessed offline once the
app's files are copied (3.4).** With a long passphrase, option C could give
it in principle, at the price of encrypting every per-wallet store; option D
gives it fully but only for a wallet that remembers nothing. A slice built on
options A or B must say plainly that a forensic reader of the app's storage
can tell that two wallets exist.

### 3.3 The recovery phrase

If the decoy has its own freshly generated phrase, the real phrase reveals
nothing about it and it reveals nothing about the real one; the user must
back up both. If the decoy is derived from the real seed with BIP-85, as
COLDCARD does, the real backup also restores the decoy, and the decoy's
phrase cannot be turned back into the real one: BIP-85 derives "a unique
private key … from the BIP32 master root key using a fully hardened derivation
path" and passes it through `HMAC-SHA512(key="bip-entropy-from-k", msg=k)`
"to prevent leakage of the parent tree should the derived key (k) be
compromised"; the BIP-39 path is `m/83696968'/39'/{language}'/{words}'/{index}'`
(<https://github.com/bitcoin/bips/blob/master/bip-0085.mediawiki>, read
2026-10-11 at `927b6de9`). The trade-off is a choice for the Chairperson
(section 5.3). Either way, "reveal the recovery phrase" under the decoy must
show the decoy's phrase.

### 3.4 What a PIN hash costs an attacker

`@noble/hashes` 2.4.0 is installed (root and `app/node_modules`) and provides
`scrypt(password, salt, { N, r, p, dkLen, maxmem? })` (RFC 7914) and
`pbkdf2(hash, password, salt, { c, dkLen })` (`scrypt.d.ts` line 65,
`pbkdf2.d.ts` line 34). The OWASP Password Storage Cheat Sheet
(<https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html>,
read 2026-10-11) recommends scrypt "N=2^17 (128 MiB), r=8 (1024 bytes), p=1"
or PBKDF2-HMAC-SHA256 "600,000 iterations".

Measured for this document with `node -e` on Node v24.21.0 (Intel Core
i7-9750H, 12 threads), one guess of a 6-digit PIN with a 16-byte salt:

| KDF | One guess |
|---|---|
| scrypt N=2^14, r=8, p=1 | 89 ms |
| scrypt N=2^15, r=8, p=1 | 128–141 ms |
| scrypt N=2^16, r=8, p=1 | 262 ms |
| scrypt N=2^17, r=8, p=1 (OWASP) | 454–562 ms |
| PBKDF2-HMAC-SHA256, 600,000 iterations (OWASP) | 806 ms |

A 6-digit PIN has 10^6 values. At the OWASP scrypt setting, about 0.5 s per
guess, the whole space is about 500,000 CPU-seconds: under six days on one
thread of this laptop and roughly half a day on its 12 threads, in
JavaScript; a native or GPU implementation is faster. So **a 6-digit PIN
protects against guessing at the screen (where the app's delay applies) and
not against anyone who can copy the app's files.** A longer passphrase changes
the arithmetic; a PIN does not. How long the same scrypt call takes on a phone
under Hermes (which has no JIT) is unmeasured and must be measured on the
emulator and a device before parameters are fixed; if N=2^17 takes several
seconds there, a lower N with an honest statement is the better choice.

On a non-rooted phone the hash would sit in the secure store, so its
ciphertext is bound to a Keystore key that only the app can use; that stops a
file copy from being guessed offline only if the Keystore key cannot be used
outside the app — which is the hardware property recorded as unverified in
threat model section 3.2.5, and which root defeats.

---

## 4. Threat model

### 4.1 Who the attacker is

- **A coercer at the screen** ("open your wallet"). Has the phone and the
  victim, can make the victim pass the device lock and the device prompt, and
  looks at what the app shows, possibly also at a block explorer. This is the
  attacker a duress PIN is for.
- **A coercer who already knows something.** Knows one of the victim's
  addresses (an ENS name, an exchange withdrawal, a public post) or that the
  victim uses this wallet with a duress feature. No decoy survives "show me
  address 0x…"; the feature only helps when the coercer does not know what to
  look for.
- **A forensic reader** (a border lab, a thief with a rooted phone and time).
  Copies the app's files. Section 3 shows this attacker can tell that two
  wallets exist and can guess a 6-digit PIN offline. Out of reach for any
  design that uses a short PIN.

### 4.2 Leaks that are not in storage

- **On-chain links.** If the decoy is funded from the real wallet, the
  explorer shows the decoy's funding transaction coming from a richer address.
  The decoy must be funded from an unrelated source, and the app must say so.
- **The notification shade.** Local reminders (phase 17) are scheduled with
  the operating system and fire whichever wallet is open. A "Recurring payment
  due" or "Account recovery started" notification while the decoy (which has
  no such plan) is open contradicts it.
- **WalletConnect and the in-app browser.** The SDK reconnects its stored
  sessions at launch; a dApp could show the real address.
- **A wallet that has never been used.** An empty decoy with no history is
  itself suspicious. Products that ship this feature tell users to keep a
  small, real balance in the decoy (Ledger, quoted in 1.1).
- **The on-chain "deeper defence" described in `docs/FEATURE_UNIVERSE.md`
  feature 53** (time-locked limits a coercer cannot exceed) does not exist
  with deployed modules: phase 11 found that "no deployed, audited module can
  enforce an account-wide spending limit on Kernel v3.3" (`docs/HISTORY.md`,
  phase 11 item 1), and the app's own spending limits are app-enforced, so a
  coerced user can switch them off.

### 4.3 What is honest to claim on screen

Never "undetectable", "hidden" or "invisible". The most a slice built on
section 6 can claim is:

> "The duress PIN opens a separate wallet instead of this one. Someone
> looking at the screen sees an ordinary wallet. Someone who copies this
> app's storage from the phone can tell that two wallets exist, and a 6-digit
> PIN can be guessed from such a copy. Fund the second wallet from somewhere
> unconnected to this one, or the blockchain links them."

### 4.4 Rows added to `docs/THREAT_MODEL.md`

- **T-78** (section 4.2): coercion ("rubber-hose") of the user to open the
  wallet — no mitigation exists; the residual is everything in this section.
- **F-77** (section 6.1): no duress protection exists; the lock does not
  cover a cold start; the lock screen opens the protected phrase; any future
  slice inherits the storage and offline-guessing limits of section 3.

---

## 5. Recommendation

### 5.1 Decision: design only for now

Option (b). No slice is built in phase 20. The reasons, in order of weight:

1. **A decoy that reads as a normal wallet needs every per-wallet record
   behind one seam, and none is.** Forty AsyncStorage key names in 30 files,
   the WalletConnect SDK's storage, the reminders, and the public-account and
   imported-key records in the secure store would all show the real wallet
   under the decoy unless each is scoped (rule 2). A slice that scopes only the
   phrase and the account list would show the real wallet's contacts, notes,
   connections, smart-account records, pending transactions and reminders
   under the decoy. Under coercion a discovered deception is dangerous, so a
   leaky decoy is worse than none.
2. **The lock did not cover a cold start** (2.3 item 1; fixed on 2026-10-12, commit `e0ef6c2`). A duress gate that
   swiping the app away skips is no gate, and fixing it changes the lock
   model that every emulator pass relies on.
3. **It reverses a recorded decision** (2.2): the Chairperson's call.
4. **The honest claim is narrow** (4.3): protection against a person at the
   screen only, with the forensic and on-chain limits stated. That is worth
   having — BlueWallet and Ledger ship it — but only once rules 1–5 hold.
5. **The files that would need to change belong to other work this wave**
   (`WalletContext.tsx`, the notification scheduler, the WalletConnect
   context and most stores), so a slice now would be built against a moving
   base.

### 5.2 The path to an honest slice

- **Stage 0 — lock on launch (small; independent; recommended now).** When
  auto-lock is set, the app also starts locked; the unlock is unchanged. This
  closes the cold-start gap for every user, duress or not. It touches
  `lock.ts`, `LockGate.tsx` and the Settings hint, and it changes emulator
  passes (every relaunch needs an unlock).
- **Stage 1 — one storage seam (a refactor; prerequisite).** A wallet-scope
  module through which every per-wallet AsyncStorage key, every per-wallet
  secure-store key, the WalletConnect SDK's storage prefix
  (`customStoragePrefix` exists in `@walletconnect/types` 2.25.0's core
  options; its effect is unverified) and every reminder identifier pass, with
  the current names as the real wallet's scope (no migration) and a check
  script that fails on any `shiba-wallet.` literal used outside the seam.
  Useful beyond this feature (multiple wallets on one phone, a clean wipe).
- **Stage 2 — the duress PIN itself**, specified in section 6.
- **Stage 3 — an emulator pass on a throwaway wallet** (section 6.7).

### 5.3 Decisions for the Chairperson

1. Reverse the no-app-PIN decision for users who set a duress PIN? (2.2)
2. The decoy's phrase: freshly generated (two backups, nothing linked) or a
   BIP-85 child of the real seed (one backup restores both; the coercer who
   gets the decoy phrase learns nothing of the real one)? (3.3)
3. Reminders and a duress PIN: make them mutually exclusive (the simplest
   honest rule), or accept that the notification shade can contradict the
   decoy? (4.2)
4. What "Remove wallet" does under the decoy: remove the decoy only (the app
   then still asks for a PIN at launch, which a coercer may notice), or
   refuse? (rule 5)
5. Whether to offer a passphrase instead of, or as well as, a 6-digit PIN,
   given section 3.4.

---

## 6. The slice, specified for when the prerequisites exist

### 6.1 Scope

An app PIN (at least 6 digits) set from Settings → Privacy → "Duress PIN";
a duress PIN that differs from it; a decoy wallet with its own phrase in its
own secure-store slot and its own scope (Stage 1) for every per-wallet record;
the PIN screen at every launch and return; test and main networks alike (it
moves no funds by itself), with an advisory readiness row.

### 6.2 PIN records

- KDF: `scrypt` from `@noble/hashes/scrypt.js` with r=8, p=1, dkLen=32, a
  random 16-byte salt per record, and N chosen after measuring on the emulator
  and a device (OWASP's 2^17 if it costs under about one second there,
  otherwise the largest power of two that does, stated). Never a plain hash;
  never stored or logged in plain form; the typed digits are dropped from
  state as soon as the hash is computed.
- One record in the standard secure store holding both entries in a fixed
  shape (the duress entry filled with random bytes of the same length when no
  duress PIN is set), so the record's length and keys do not say whether a
  duress PIN exists. It does not hide it from offline guessing (3.4).
- Verification computes both hashes every time, compares with a
  constant-time comparison, and only then decides `real` / `decoy` / `wrong`,
  so the work done is the same whichever PIN was typed.
- The real PIN and the duress PIN must differ, and both must differ from the
  trivially guessed values (all one digit, 123456 and its reverse).

### 6.3 Throttling

After 5 wrong PINs in a row the screen waits 30 seconds, then the wait
doubles with every further wrong PIN up to 1 hour; a correct PIN (either one)
resets the count. The count and the time of the last failure are stored in
the secure store, and a wait already started is honoured after a restart. No
automatic wipe: COLDCARD bricks after 13 failures, but on a phone an
accidental wipe of an unbacked-up wallet is the likelier harm. Stated limits:
this stops guessing at the screen only; an attacker who restores an earlier
copy of the app's files resets it, and offline guessing ignores it.

### 6.4 Invariants and their checks (check-duress)

- With the decoy open, zero reads of the real phrase and imported keys,
  counted on the fake secure store used by `check-storage.mjs`; the lock
  screen's approval target is the decoy's secret.
- A mutant that lets the duress PIN open the real wallet, or that compares
  only the first matching hash (unequal work), must fail a check.
- Every per-wallet store resolves to the decoy scope while the decoy is open
  (the Stage 1 seam check, run with the scope switched).
- Wipe clears both wallets, both PIN records and the throttle state.
- The decoy's Settings shows the Duress PIN section exactly as a wallet with
  an app PIN and no duress PIN would.

### 6.5 Draft user-facing copy (to be pinned when built)

- Section title: "Duress PIN".
- Explanation: "A duress PIN opens a separate wallet instead of this one, for
  when someone forces you to open your wallet. Keep a small amount in it and
  use it now and then so it looks lived in."
- Honesty note: the paragraph in section 4.3.
- Funding note: "Fund the second wallet from an exchange or another source
  that has never sent to or received from this wallet. A transfer between the
  two wallets links them permanently on the blockchain."
- Backup note: "The second wallet has its own recovery phrase. Write it down
  too; this wallet's phrase does not restore it." (or the BIP-85 wording,
  depending on decision 2).
- PIN screen: "Enter your PIN" and, after failures, "Wrong PIN. Try again in
  N seconds." — the same words whichever wallet the PIN would open.

### 6.6 Readiness

An advisory row (`duress-wallet`): the feature moves no funds, so it is not a
mainnet gate, but the row states the forensic and on-chain limits.

### 6.7 Emulator checklist (throwaway wallet only)

The emulator AVD "shiba" holds the project's real test wallet, whose phrase
is written nowhere; a PIN gate that misbehaves could lock it out. The duress
flow must therefore be tested only in the wallet's own development build
installed beside Expo Go (package `com.anonymous.shibawallet`, phase 16 item
3) with a throwaway wallet, or on a separate disposable AVD, never in Expo Go
on the real wallet. Steps: (1) Stage 0 first, on the real wallet only if the
lock-on-launch change is all that is installed: set auto-lock to 1 minute,
force-stop, relaunch — expect the lock screen (today, per the code, Home opens
without a prompt; confirming that is the first step); (2) in the development
build, create a throwaway wallet, set an app PIN and a duress PIN, add a
contact, a note and a tracked token to the real wallet; (3) relaunch, enter
the duress PIN: a different address, none of the contact, note or token, the
recovery-phrase reveal shows the decoy's phrase, Settings shows "Duress PIN"
as not set; (4) count secure-store reads of the real phrase through a debug
build log of key names only (never values) — zero; (5) wrong PINs: the 30 s
wait after the fifth, doubling after; restart keeps the wait; (6) screen
capture blank on the PIN screen with the app-wide switch off; (7) wipe from
the real wallet removes both; uninstall the development build afterwards.

### 6.8 What only a device can confirm

The scrypt cost under Hermes on a real phone; whether a Keystore-bound record
resists a file copy on real hardware (threat model 3.2.5); the PIN pad with
TalkBack and VoiceOver (it must not speak which wallet opened); iOS
behaviour of the app-switcher cover over the PIN screen.

---

## 7. Sources

Read on 2026-10-11 unless stated.

- COLDCARD documentation, Trick PINs: <https://coldcard.com/docs/pins/>
- BlueWallet documentation, Plausible Deniability:
  <https://bluewallet.io/docs/plausible-deniability/>
- Ledger Academy, passphrase: <https://www.ledger.com/academy/passphrase-an-advanced-security-feature>
- BIP-85: <https://github.com/bitcoin/bips/blob/master/bip-0085.mediawiki>
  (raw file at bitcoin/bips `927b6de9`)
- OWASP Password Storage Cheat Sheet:
  <https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html>
- Installed packages: `expo-local-authentication` 57.0.3, `expo-secure-store`
  57.0.4, `@noble/hashes` 2.4.0, `@walletconnect/core` 2.25.0; the Android SDK
  `platforms/android-36/android.jar`
- This repository at `a104227`: `app/src/wallet/lock.ts`,
  `app/src/wallet/biometric.ts`, `app/src/wallet/storage.ts`,
  `app/src/components/LockGate.tsx`, `app/src/wallet/WalletContext.tsx`,
  `app/src/screens/SettingsScreen.tsx`, `app/src/config/prefs.ts`,
  `docs/THREAT_MODEL.md`, `docs/HISTORY.md`, `docs/FEATURE_UNIVERSE.md`
- Not used: Trezor's passphrase pages (one returned 404 and its blog 403 on
  2026-10-11), so nothing here relies on them.
