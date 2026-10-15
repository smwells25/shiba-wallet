Status: design document, phase 20 item 2, written 2026-10-11 against HEAD
`a104227`, updated on 2026-10-14 (phase 21 item 2) with the Chairperson's
decisions (section 7) and the first two prerequisites done: the lock now
covers a cold start (Stage 0, commit `e0ef6c2`, threat-model row F-77(b)),
and the app's own storage keys go through one seam (Stage 1, section 5.2,
`app/src/wallet/store-keys.ts` with its check
`app/scripts/check-storage-seam.mjs`). Stage 2 — the opt-in app PIN, the
duress PIN and the decoy wallet — is BUILT AND CHECKED OFFLINE (phase 21,
2026-10-14; sections 7.7 to 7.10; `app/src/wallet/pin.ts`,
`app/src/wallet/duress.ts`, `packages/core/src/bip85.ts`,
`app/scripts/check-duress.mjs`). Nothing of Stage 2 has been seen on a device
yet, and section 7.10 lists what must be finished or confirmed before the
Stage 3 emulator pass on a throwaway wallet.

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

1. **The lock must cover a cold start. FIXED on 2026-10-12** (commit
   `e0ef6c2`, threat-model row F-77(b)). When this document was first
   written, `reduceLock` started unlocked (`INITIAL_LOCK_STATE = { locked:
   false, … }` in `lock.ts`), `WalletContext.tsx` reached `ready` at launch
   without any prompt, and `LockGate.tsx` armed only on AppState changes, so
   an app that had been swiped away or reclaimed by the system opened again
   unlocked whatever the auto-lock setting said — and a duress gate that a
   coercer can skip by swiping the app away is no gate. Since `e0ef6c2`,
   `lock.ts` `launchLockDecision` starts the wallet LOCKED on every launch
   while auto-lock is on (a neutral cover is shown until the preferences are
   read), and the emulator showed zero frames of Home before the lock on a
   cold start (phase 20 status in `AGENTS.md`). What remains for a duress
   gate is item 7 below: today auto-lock can still be switched off, which a
   duress PIN must not allow.
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
3.4). When this was written (`a104227`), 40 distinct `shiba-wallet.*` key
names or prefixes appeared as literals in `app/src` (`grep -rhoE
"'shiba-wallet\.[a-zA-Z0-9.-]+'" app/src`); on 2026-10-14 the same command
found 42 (the price-alert key and its notification prefix had been added),
and 30 files imported AsyncStorage. Stage 1 (section 5.2) moved them into one
registry; the rest of this paragraph describes the state before it. They
were read and written directly by 30 files that each import AsyncStorage
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
  cover a cold start (part b, fixed on 2026-10-12 in commit `e0ef6c2`); the
  lock screen opens the protected phrase; any future slice inherits the
  storage and offline-guessing limits of section 3.

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

- **Stage 0 — lock on launch. DONE** (commit `e0ef6c2`, 2026-10-12). With
  auto-lock set, the app also starts locked; the unlock is unchanged. This
  closed the cold-start gap for every user, duress or not (section 2.3
  item 1).
- **Stage 1 — one storage seam. DONE for the app's own keys in
  `app/src/wallet`** (phase 21 item 2, 2026-10-14). `app/src/wallet/store-keys.ts`
  declares every storage key with its scope — 39 names: 21 per-wallet
  (`wallet`), 9 device-wide (`device`) and 9 secure-store items (`secret`)
  — plus the protected keychain service and the four notification-identifier
  prefixes. It holds the only functions that read, write, delete or list a
  key (`readStoreItem`, `writeStoreItem`, `removeStoreItem`,
  `listStoreKeys`, `readSecureItem`, `writeSecureItem`,
  `deleteSecureItem`), and the scope function `scopedStoreKey(key,
  profile)`, which today returns every key unchanged (no migration; pinned).
  A second profile, which nothing passes yet, would leave `device` keys
  alone and move `wallet` and `secret` keys to
  `shiba-wallet.profile-<prefix>.…`, names no declared key can have. Every
  store module in `app/src/wallet` (22 modules, `WalletContext.tsx`, and
  the vault in `storage.ts`, whose 45 secure-store calls now go through the
  seam with the same keys, options and order) was moved onto these
  functions with the same keys, values and error behaviour; every existing
  check suite stayed green, with only pins on a key literal or on a call's
  exact text updated (`check-home`, `check-key-import`).
  `app/scripts/check-storage-seam.mjs` fails on any key literal, any import
  of the AsyncStorage package, any AsyncStorage / SecureStore call, and any
  `getItem` / `setItem` / `removeItem` / `…ItemAsync` call outside the seam,
  apart from an exact allow-list. **What Stage 1 still leaves**, each in
  that allow-list or named here, to move before Stage 2 relies on it:
  `app/src/wallet/recovery.ts` (the recovery records and progress: two keys,
  six calls — being edited by another slice this wave, so left alone);
  `app/src/config/prefs.ts` and `app/src/config/networks.ts` (preferences
  and endpoint overrides, both device-wide); five screens and
  `WalletConnectContext.tsx`, which import the AsyncStorage package only to
  pass it on as the store argument; the WalletConnect SDK's own storage
  (`customStoragePrefix` in `@walletconnect/types` 2.25.0's core options,
  effect still unverified); the reminder identifiers, which are declared in
  the seam but not scoped (section 7.4 makes that moot by turning OS
  notifications off while an app PIN is on); and `shiba-wallet.aa-config.v1`,
  which mixes device-like bundler settings with per-wallet recovered
  accounts and is declared per-wallet until Stage 2 splits it.
- **Stage 2 — the app PIN, then the duress PIN. BUILT OFFLINE** (phase 21,
  2026-10-14; section 7.7 says piece by piece what was built and section
  7.10 what is left). Stage 1's remainders listed above were NOT moved in
  this slice (they belong to other files), so the decoy does not yet
  satisfy rule 2 for the recovery records and the WalletConnect sessions.
- **Stage 3 — an emulator pass on a throwaway wallet** (section 6.7).

### 5.3 Decisions for the Chairperson

All five were decided on 2026-10-14; section 7 records the answers.

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
  otherwise the largest power of two that does, stated). *As built (section
  7.7): a 32-byte salt per slot and N = 2^16, chosen from a Node
  measurement against a 500 ms budget; the device measurement is still
  owed.* Never a plain hash;
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
- Backup note (BIP-85, decided on 2026-10-14; section 7.2): "The second
  wallet is derived from this wallet's recovery phrase, so backing up that
  one phrase backs up both. Its own phrase does not reveal this wallet's."
- PIN screen: "Enter your PIN" and, after failures, "Wrong PIN. Try again in
  N seconds." — the same words whichever wallet the PIN would open.

### 6.6 Readiness

An advisory row (`duress-wallet`): the feature moves no funds, so it is not a
mainnet gate, but the row states the forensic and on-chain limits. *As
built, the row is named `duress-pin` (the phase 21 brief) and is still to
be added to the readiness table (section 7.7).*

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

## 7. The Chairperson's decisions of 2026-10-14 and what they set

Recorded in `AGENTS.md` ("DECIDED by the Chairperson (2026-10-14)", item 2,
and the phase 21 plan, item 2). They answer the five questions of section
5.3. Where a decision leaves a detail open, this section says which reading
it takes and marks it for confirmation.

### 7.1 An opt-in app PIN comes first; the duress PIN only on top of it

"A duress PIN only makes sense once an app PIN is enabled." So the order is:

1. **App PIN, opt-in.** Settings → Privacy offers an app PIN. While it is
   off, nothing changes: the lock stays the device's own biometric / PIN
   prompt, as recorded in `lock.ts` and threat-model row T-09. While it is
   on, the app's own PIN pad (section 2.3, items 5–8; section 6.2–6.3) is
   the unlock, auto-lock cannot be switched off, app-wide screen protection
   is forced on, and signing still asks for the device prompt
   (`requireLocalAuth`). This reverses the no-app-PIN decision only for
   users who opt in; `lock.ts`, T-09 and the Settings hint must be reworded
   when it is built.
2. **Duress PIN, only while the app PIN is on.** It can be set only from the
   real wallet, after the app PIN exists, and must differ from it (section
   6.2). Turning the app PIN off first removes the duress PIN and the decoy
   wallet (with a confirmation that says so).

### 7.2 The decoy is a BIP-85 child of the real seed

The decoy's recovery phrase is derived from the real wallet's seed with
BIP-85 (the BIP-39 application, path
`m/83696968'/39'/{language}'/{words}'/{index}'`, quoted in section 3.3), the
way COLDCARD derives its duress wallets. Consequences:

- **One phrase backs up both.** Whoever holds the real phrase can always
  re-derive the decoy; the decoy's own phrase cannot be turned back into the
  real one (BIP-85's HMAC step, section 3.3), so revealing the decoy's phrase
  under coercion gives away nothing of the real wallet.
- **The recovery rule: the real recovery phrase plus the child index.**
  Language is English (0) and the word count is the real phrase's (12 or 24),
  so the only free number is the index. **Recommendation: a fixed index,
  `0`, for every user, documented here and shown in the app's help text,
  so that nothing extra has to be written down or stored to recover it.** A
  restore asks for the real phrase (as it does today) and then, in the duress
  set-up, re-derives index 0. Why fixed rather than chosen:
  - an index that the user must write down beside the phrase is one more
    thing to lose, and a backup sheet that says "duress wallet: 7" tells
    whoever finds it that a decoy exists — while a fixed, published index
    tells them nothing they could not try anyway;
  - the index does not protect anything: anyone who has the real phrase
    already has the real wallet, so a secret index would only hide the
    decoy from someone who has already won;
  - on the phone, the index is never stored at all — the decoy's derived
    phrase is stored in the decoy profile's own secure-store slot exactly
    like the real phrase (section 6.1), so the device holds no "index"
    record whose presence would point at a decoy. (Its key names still show
    that a second profile exists; section 3.2 and the honest claim in 4.3.)
  - Choosing another index stays possible later (an advanced option), and a
    user who does so must write it down; the default needs nothing.
- **Unconfirmed, to check when building:** no BIP-85 implementation is
  installed (`grep -ri "83696968\|bip85"` over `node_modules/@scure`,
  `app/node_modules/@scure` and `packages/*/src` finds nothing on
  2026-10-14), so the derivation must be written over `@scure/bip32` and
  `@noble/hashes` (HMAC-SHA512, no new primitive) and validated against the
  official test vectors in BIP-85 itself before any decoy is created.
  *Done in phase 21: `packages/core/src/bip85.ts`, every applicable official
  vector passing (section 7.7).*
- The decoy phrase is created at set-up by reading the real phrase once
  through the vault (one device prompt when the phrase is protected), deriving
  the child, and storing it in the decoy profile; the real phrase is never
  stored a second time and never read while the decoy is open (rule 3).

### 7.3 "Remove wallet" removes both

Whichever wallet is open, "Remove wallet from this device" removes **both**
profiles' records and secrets, the PIN record and the throttle state (the
wipe in `WalletContext.tsx` runs over both profiles through the seam's
`listStoreKeys`). Under coercion this is the safe outcome: the coercer is
left with nothing, and the user recovers both wallets from the one backed-up
phrase (7.2). It also means the dialog text is the same in both wallets, so
it reveals nothing (rule 5). The cost is stated in the dialog that already
exists: a user who did not back up the phrase loses everything, which is why
7.5 makes the backup a precondition.

### 7.4 Reminders and price-alert notifications

**The question** ("do we need to remind if we require a normal PIN?"):
section 4.2 found that local notifications break the decoy. They are posted
by the operating system and read on the lock screen and in the shade without
any app PIN, they fire whichever wallet was last open, and the reminders
exist only for records of the real wallet (a recurring payment, a recurring
swap, a recovery started on a guardian-protected account, a price alert).
A "Recurring payment due" while the decoy (which has no such plan) is open
contradicts it; a coercer who sees one asks to be shown the plan.

Two rules were proposed:

- (a) a duress PIN disables OS notifications for the real wallet only while
  the decoy is the last-unlocked profile;
- (b) OS notifications are off entirely while a duress PIN exists.

**Recommendation: (b), with one refinement — apply it whenever the app PIN
is on, not only when a duress PIN exists.** The reasons:

1. **(a) fails in the most likely sequence.** Coercion usually starts with
   the phone as the user last left it — the real wallet was the last one
   opened. Under (a), real-wallet reminders keep firing until the decoy has
   been opened, which is exactly while the coercer first holds the phone.
   Reminders that were already scheduled with the OS would also have to be
   cancelled at the moment the decoy opens and re-armed when the real one
   opens, and a notification already in the shade would have to be
   dismissed in time; any slip contradicts the decoy.
2. **(b) as literally written would itself reveal the duress PIN.** If
   reminders worked with an app PIN alone but stopped when a duress PIN was
   added, the Settings → Notifications section would read differently in a
   wallet that has a duress PIN than in one that does not — and under the
   decoy, the coercer would see "reminders unavailable" in a wallet that
   (by its own Settings) has only an app PIN. Rule 1 (section 1.2) and the
   last invariant of section 6.4 require the decoy's Settings to look
   exactly like an app-PIN-only wallet.
3. **So the trigger is the app PIN.** While the app PIN is on, the app
   posts no OS notification of any kind — no reminders, no takeover alerts,
   no price alerts — and turning the app PIN on cancels every scheduled
   reminder and dismisses every shown one (the cleanup `notifications.ts`
   already runs when reminders are switched off). The Notifications section
   then says the same thing in every wallet with an app PIN: "Notifications
   are off while the app PIN is on: a notification can be read on the lock
   screen without your PIN." That sentence is true, reveals nothing about a
   duress PIN, and answers the Chairperson's question: **with a PIN that
   guards the wallet, reminders outside the app would undo part of what the
   PIN protects, so they are not offered.**
4. **What remains, inside the PIN.** The in-app checks keep working behind
   the PIN: the "payment due" banner (`RecurringDueBanner`), the Sessions
   screen's due state, the Inheritance takeover check and the price-alert
   banner (`PriceAlertMonitor`) all run once the wallet is unlocked, and
   each reads only the open profile's records through the seam. Nothing
   leaks into the shade.

**The UX cost, stated plainly.** A user who turns the app PIN on loses the
reminders that tell them, while the wallet is closed, that a recurring
payment or swap is due (they will see it the next time they open the
wallet; RateLimitPolicy keeps a missed slot open and the grant's grace
period gives the last payment one more period, so nothing is lost by a short
delay), and — the larger cost — the immediate "Account recovery started"
alert for a guardian or heir takeover, which is a security alert: the user
learns of a takeover attempt only when they next open the wallet, and must
veto within the guardian delay. The Settings text for the app PIN must say
this before it is turned on. A user who values the reminders more than the
PIN keeps the PIN off; nothing is taken from users who never opt in.

### 7.5 The user must back up the seed phrase

Setting a duress PIN is refused until the recovery phrase has been backed
up and confirmed (the existing backup quiz), because the decoy and the real
wallet are both recovered from that one phrase (7.2), and "Remove wallet"
removes both (7.3). Turning on the app PIN alone shows the same reminder but
does not require it.

### 7.6 A passphrase is an option

**Reading taken (to confirm with the Chairperson):** "a passphrase is a good
option" refers to question 5 of section 5.3 — the secret typed on the app's
own lock screen. Both the app PIN and the duress PIN may be either a PIN of
at least 6 digits or a passphrase (letters and digits, at least 12
characters — a judgement to confirm), entered on an app-drawn pad or a
secure text field with suggestions, autocorrect and autofill off. Section
3.4 is the reason: a 6-digit PIN can be guessed offline from a copy of the
app's files in about half a day of CPU time at the OWASP scrypt setting,
while a long passphrase moves that out of reach. The honest claim (4.3)
then names which one the user chose. **Not the same thing:** a BIP-39
passphrase (the "25th word") would change the wallet's seed and therefore
every address and the BIP-85 child (7.2); it is not part of this plan, and
offering one would need its own decision because existing users' backups
would not restore a passphrase wallet without it.

### 7.7 Stage 2, piece by piece

In order; each piece is its own slice with its own check and emulator
pass on a throwaway wallet (section 6.7):

1. **Finish the seam (Stage 1 remainders, section 5.2).** Move
   `recovery.ts`, `config/prefs.ts` and `config/networks.ts` onto the seam;
   change the five screens and `WalletConnectContext.tsx` to import the
   seam's `AsyncStorage` re-export; empty the allow-list in
   `check-storage-seam.mjs`; split `shiba-wallet.aa-config.v1` into a
   device part (bundler URLs, factories) and a wallet part (recovered
   accounts, EIP-7702 owners); verify on the emulator what
   `customStoragePrefix` does to the WalletConnect SDK's records and either
   scope it or disconnect every WalletConnect session when a profile other
   than the last one opens.
2. **The active profile.** Add to `store-keys.ts` the single place that
   holds the active profile (set once per launch by the lock screen, before
   `WalletContext.tsx` loads anything), and make `scopedStoreKey` use it by
   default; declare the PIN record and the throttle state as device-wide
   secure-store keys (a fourth scope, `device-secret`, or `device` with
   secure-store backing). `check-storage-seam.mjs` then runs the whole
   key list with a second profile and asserts no key of one profile is read
   while the other is active.
3. **The app PIN (7.1).** The PIN record (section 6.2: scrypt with N fixed
   after measuring under Hermes on the emulator, a random salt, one
   fixed-shape record), the throttle (6.3), the PIN pad or passphrase field
   with screen capture blocked, the lock screen asking for the PIN before
   anything is loaded and with the approval target set to the open
   profile's secret (section 2.3 item 4), auto-lock forced on, screen
   protection forced on, the notifications rule (7.4), and the rewording of
   `lock.ts`, T-09 and the Settings hint. A readiness row
   (`app-pin`, advisory).
4. **BIP-85 in the engine (7.2).** The derivation in `packages/core`,
   checked against BIP-85's published test vectors.
5. **The duress PIN and the decoy (7.1, 7.2, 7.5).** Set-up (backup
   confirmed, a PIN or passphrase different from the app PIN, the decoy
   derived at index 0 and stored in its own profile, the funding and backup
   notes of section 6.5), verification that computes both hashes every
   time with a constant-time compare (6.2), the decoy opening with the
   same timing and prompts as the real wallet, "Remove wallet" removing
   both (7.3), and the decoy's Settings showing the duress-PIN section
   exactly as an app-PIN-only wallet does. The check-duress invariants of
   section 6.4. A readiness row (`duress-wallet`, advisory; section 6.6).
6. **The honest claim (4.3) on every screen** that sets up or describes the
   feature, pinned by the check.

Stage 3 (section 6.7) follows on a throwaway wallet only, never on the
emulator's real test wallet.

**What was built (phase 21, 2026-10-14), against this list:** piece 1 was
NOT done (its files belong to other slices; section 7.10); pieces 2 to 6
were built and checked offline, with these choices:

- **The active profile (piece 2)** lives in `store-keys.ts`
  (`activeStoreProfile` / `setActiveStoreProfile`), in memory only — never
  written to a store (pinned) — and every unbound read and write is scoped
  by it. Stores and secure-store backends can also be BOUND to a profile
  (`profileBoundStore`, `profileBoundSecureBackend`), which the duress set-up
  and the wipe use to reach the other wallet without switching. The decoy's
  profile prefix is `w2` (`shiba-wallet.profile-w2.…`), a neutral name.
  The PIN record is declared `secret` (it lives in the secure store) under
  the neutral name `shiba-wallet.app-lock.v1` and is ALWAYS addressed through
  a backend bound to the primary profile, so it is one device-wide record
  read before any wallet is chosen (a fourth scope was not needed).
- **The app PIN (piece 3)**: 6 digits on an app-drawn pad
  (`components/LockGate.tsx` `PinPad`; never the system keyboard; screen
  capture blocked with its own key `pin-pad`), scrypt from `@noble/hashes`
  2.4.0 with r = 8, p = 1, dkLen = 32 and a **32-byte** salt per slot (the
  phase 21 brief; section 6.2 said 16), **N = 2^16**, chosen by measurement
  on 2026-10-14 under Node v24.21.0 on the Intel Core i7-9750H with the
  installed noble: N = 2^16 took 240–313 ms per hash (11 runs, synchronous
  and asynchronous), N = 2^17 took 479–589 ms, above the 500 ms budget the
  brief set. Every attempt computes both slots' hashes, so an attempt costs
  about twice that on Node. **The cost under Hermes on a phone is not
  measured** (section 6.8): it must be before N is final. The record is one
  fixed-shape JSON of 358 bytes whether or not a duress PIN exists (slot 0
  primary, slot 1 duress, 64 random bytes in an unset slot; the counter
  and the wait as fixed-width hex). The wait schedule of section 6.3, with
  the counter written before the hashes are computed. The lock screen
  takes the PIN at launch and after auto-lock (the same view); it does not
  call the device prompt, which is not a fallback for the PIN (section 6
  does not make it one). Auto-lock is forced on (one minute when the stored
  choice is "off"; "Off" is not offered), screen protection is forced on,
  and notifications are forced off (section 7.4) while the PIN is on; the
  stored choices are kept for when it is turned off. `lock.ts` and the
  Settings hint were reworded; threat-model row T-09 still states the old
  decision and needs the same rewording (outside this slice's rows).
  Turning the PIN on requires the backup check described below. No
  readiness row `app-pin` was added (see `duress-pin` below).
- **BIP-85 (piece 4)**: `packages/core/src/bip85.ts`, from bitcoin/bips
  `bip-0085.mediawiki` at commit `6209768676bf85d7ef5ffb4055543d6286d79b96`
  (sha256 `dcbeb977…d1cf7e`), checked in `packages/core/test/bip85.test.ts`
  against every official vector of the parts it implements: the two
  raw-entropy test cases (derived key and 64 bytes of entropy) and the 12-,
  18- and 24-word BIP39 mnemonics.
- **The duress PIN and the decoy (piece 5)**: set only from the real wallet,
  only while the app PIN is on; the steps are the backup check, the current
  app PIN, the duress PIN twice; the decoy's phrase (index 0, the parent's
  word count) is stored in the decoy profile's standard secure storage
  BEFORE the duress slot is set, so the slot never opens a missing wallet.
  The PIN typed on the lock screen decides the profile; WalletContext then
  drops any held secret, sets the profile, and reloads everything through
  the seam behind the lock; LockGate remounts the whole tree when the
  profile changes, so no screen keeps the other wallet's state. "Remove
  wallet" with an app PIN removes both wallets (the decoy first), every
  per-wallet AsyncStorage record of both profiles (device settings kept),
  both wallets' secure-store items and the PIN record, and returns to the
  primary profile; the dialog adds one sentence that is the same in both
  wallets. Turning the app PIN off (from the real wallet) or removing the
  duress PIN deletes the decoy's keys and records.
- **The backup check (section 7.5)**: the app records nothing when the
  backup quiz passes — a created wallet is stored only after
  `ConfirmBackupScreen` passes (`confirmCreate`), an imported one was typed
  in by the user — so turning the app PIN on and adding a duress PIN both
  ask for two words of the open wallet's phrase, at random positions, from
  the written backup (after one device prompt that opens the phrase). This
  is stricter than section 7.5 asked for the app PIN alone (the phase 21
  brief required it).
- **Readiness**: the row `duress-pin` (advisory, every network) is not in
  `app/src/config/readiness.ts` yet: that file and `check-readiness.mjs`
  are a shared registry outside this slice's files. Its reason is ready in
  `duress.ts` (`DURESS_READINESS_REASON`, three sentences as the readiness
  rules require).
- **The honest claim (piece 6)** is rendered in the Duress PIN section
  (`DURESS_HONEST_CLAIM`) with the funding and backup notes, and pinned.

### 7.8 A BIP-39 passphrase (design note only; not built)

The Chairperson's "a passphrase is a good option" can also be read as a
BIP-39 passphrase — the "25th word" of BIP-39, which changes the seed and
therefore every address (the Ledger pattern quoted in section 1.1, "a
passphrase … linked to a secondary PIN code"). As an ALTERNATIVE to the
BIP-85 child, the hidden wallet would be the same recovery phrase plus a
passphrase, and the wallet the duress PIN opens could be either side: the
phrase alone as the decoy and phrase + passphrase as the real wallet, or
the reverse. As an ADDITION, a passphrase could protect the real wallet on
top of a BIP-85 decoy.

- **Recovery rule.** Restoring needs the phrase AND the exact passphrase
  (character for character; BIP-39 normalises it with NFKD). There is no
  checksum: a mistyped passphrase opens a different, empty, valid-looking
  wallet. Losing the passphrase loses that wallet ("If you forget your
  passphrase, access to the associated hidden wallet is permanently lost",
  Ledger, section 1.1). This is the opposite trade to the BIP-85 child,
  whose recovery needs nothing written down (section 7.2).
- **What it would buy.** A wallet whose existence the phone need not
  record at all if the passphrase is typed at each use (option D of
  section 3.2), at the cost of every saved record for that wallet.
- **What it would cost.** Existing backups would not restore a passphrase
  wallet without the passphrase; the derivation, the account cache, the
  smart-account owners and every per-wallet record would have to carry the
  passphrase's wallet as a third identity.
- **Decision pending.** The choice between a BIP-39 passphrase and the
  BIP-85 child (or both) is the Chairperson's; this slice builds the
  BIP-85 child only, and no passphrase field exists anywhere in the app.
  (Section 7.6's other reading — a passphrase as the lock-screen secret
  instead of 6 digits — is also not built: the PIN is 6 digits.)

### 7.9 What the second wallet's Settings do (a decision to confirm)

Rule 1 (section 1.2) requires the second wallet's Settings to look exactly
like a wallet with an app PIN and no duress PIN. With two slots and no
third wallet, three actions cannot do there what they appear to do. What
was built, for the Chairperson to confirm or change:

- **Change PIN** changes the PIN that opened this wallet (the duress
  slot). A new PIN equal to the other slot's PIN is refused with the same
  sentence as a trivially guessed PIN ("This PIN cannot be used. Choose a
  different 6-digit PIN."), and a "current PIN" typed there that belongs to
  the other wallet counts as wrong without resetting the counter, so
  neither the message nor the wait schedule can reveal the real PIN.
- **Remove the PIN** and **Add a duress PIN** run the same steps (the
  confirmation, the backup check, the PINs) and end with "This could not
  be completed on this phone. Nothing was changed." Removing the PIN there
  would leave the real wallet without its PIN (rule 4); a third wallet does
  not exist. The sentence is true and does not name either wallet, but a
  coercer who sees it may grow suspicious. Alternatives: pretend success
  for the session only (the app asks for a PIN again at the next launch),
  or hide the actions (the Settings would then differ from an
  app-PIN-only wallet). Not decided.

### 7.10 Left before the Stage 3 pass, and not verified

- **Stage 1 remainders still leak the real wallet into the decoy** (rule
  2): `app/src/wallet/recovery.ts` reads and writes the recovery records and
  recoveries in progress under their unscoped names (allow-listed in
  `check-storage-seam.mjs`), so the Guardians and recovery screens under the
  decoy would show the real wallet's records; the WalletConnect SDK keeps
  its sessions in its own storage and its client in memory
  (`walletconnect.ts` caches the initialised client), so the decoy's
  Connections screen could list and reconnect the real wallet's sessions;
  `shiba-wallet.aa-config.v1` is per wallet, so the decoy starts with no
  bundler or factory configured (a visible difference, not a leak). These
  must be finished (section 7.7 piece 1) before the feature is offered.
- **Readiness row `duress-pin`** to add (above).
- **Hermes cost of scrypt** at N = 2^16, twice per attempt: unmeasured. If
  an attempt takes several seconds on a phone, N must come down and the
  claim say so.
- **iOS**: the Keychain may keep the PIN record across an uninstall, so
  "reinstall to reset a forgotten PIN" may not hold there (unverified);
  the PIN pad with VoiceOver; the app-switcher cover over the PIN pad.
- **Timing**: both wallets load through the same path, but the real
  wallet usually loads from its public account cache (protected phrase)
  while the decoy derives from its standard-storage phrase on first load;
  the difference is small and unmeasured.
- **Not seen on a device**: everything in Stage 2, including the PIN pad's
  layout, TalkBack on it, screen capture blocked on it with the app-wide
  switch off, the profile switch at a background lock, and "Remove wallet"
  from the decoy.


---

## 8. Sources

Read on 2026-10-11 unless stated.

- COLDCARD documentation, Trick PINs: <https://coldcard.com/docs/pins/>
- BlueWallet documentation, Plausible Deniability:
  <https://bluewallet.io/docs/plausible-deniability/>
- Ledger Academy, passphrase: <https://www.ledger.com/academy/passphrase-an-advanced-security-feature>
- BIP-85: <https://github.com/bitcoin/bips/blob/master/bip-0085.mediawiki>
  (raw file at bitcoin/bips `927b6de9`); for the implementation and its test vectors,
  re-read on 2026-10-14 at `6209768676bf85d7ef5ffb4055543d6286d79b96`
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
