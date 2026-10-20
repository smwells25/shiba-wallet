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

**Status update (2026-10-20, phase 22 refresh):** Stage 3 has run twice on
the Android emulator in the wallet's own development builds, on throwaway
wallets only: on 2026-10-18 UTC with the JavaScript scrypt (pass p21f, one
PIN check about 4 minutes) and on 2026-10-19 UTC with the native scrypt
decided by the Chairperson (commit `8b4ed84`, `react-native-quick-crypto`,
N kept at 2^16; pass p22a), where one unlock took about 2.5 seconds in both
the debug and the release build (section 5.2). The lock passphrase (stage
P1, section 8.2) is built and checked offline (commit `9e3dfea`), not yet
run on the emulator. The BIP-39 passphrase decoy (stage P2, section 8.3) is
not built and waits on the Chairperson's answers to section 8.5. No real
phone and no iOS build have run any of it.

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
  (`wallet`), 9 device-wide (`device`) and 9 secure-store items (`secret`);
  41 since phase 21 added the app-lock record (`secret`) and the Bridge
  screen's transfer list (`wallet`): 22 / 9 / 10
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
  apart from an exact allow-list. **The remainders it left were closed in
  phase 21** (the storage-seam follow-up slice, 2026-10-15; built and
  checked offline only, not yet seen on a device):
  - `app/src/wallet/recovery.ts` (the recovery records and recoveries in
    progress, per wallet), `app/src/config/prefs.ts` and
    `app/src/config/networks.ts` (the preferences and the endpoint
    overrides, device-wide) now read and write through the seam with keys
    declared in `store-keys.ts`, and the five screens and
    `WalletConnectContext.tsx` take the default store from the seam's
    re-export. The allow-list of `check-storage-seam.mjs` is EMPTY; the one
    exception it pins is `WalletContext.tsx`'s value import of
    `expo-secure-store`, which binds the native module once and calls
    nothing. A check drives each migrated module with a store bound to a
    second profile: the preferences and endpoint overrides stay on their
    shared keys, the recovery records move under the second profile's
    prefix.
  - `shiba-wallet.aa-config.v1` stays declared per wallet (it holds the
    real wallet's EIP-7702 owners and recovered accounts, which identify
    it), but its device fields — the bundler, factory and paymaster
    endpoints with their verification records (`aa.ts`
    `AA_ENDPOINT_FIELDS`) — are read from and written to the PRIMARY
    profile's copy whichever wallet is open. The decoy therefore shows the
    same bundler and factory rows as the real wallet from the moment it is
    created, keeps its own 7702 owners and recovered accounts under its
    own prefix, and a bundler change made in either wallet applies to
    both, like the other device settings. Nothing is migrated: for the
    primary wallet the record is read and written exactly as before. This
    was chosen over splitting the key in two (which would have moved the
    real wallet's stored fields and changed every suite that pins the
    record) and over copying the settings into the decoy once at creation
    (which would drift as soon as either wallet changed its bundler).
    `check-aa.mjs` pins that the decoy sees the same bundler row right
    after creation and none of the real wallet's links, and that a decoy
    write never overwrites a primary copy it cannot read.
  - The WalletConnect SDK keeps pairings, sessions, keys and pending
    requests in its own AsyncStorage keys, outside the seam:
    `wc@2:core:` or `wc@2:client:` + a version + `customStoragePrefix` +
    `//` + a name (`@walletconnect/core` 2.25.0, read from the installed
    package's source map: `src/core.ts` line 99 makes the prefix `:` plus
    the option, or empty; `controllers/store.ts` lines 77–78 and the other
    controllers use it in every key). The wallet now creates one SDK
    client per wallet: the primary wallet's with no prefix (its stored
    sessions keep their keys) and the second wallet's with its profile
    prefix (`w2`), so the decoy never reads the real wallet's sessions and
    the reverse; the SDK also keeps one process-wide core per prefix
    (`core.ts` lines 235–268), so the two clients share no relay
    connection or keychain. When the PIN opens the other wallet, the
    previous wallet's client closes its relay connection (`relayer.
    transportClose`) and reopens it when its wallet is opened again
    (`walletconnect.ts` `createWcClientCache`, `walletConnectFollowProfile`;
    `check-wc.mjs`). Two SDK keys carry no prefix, and neither is written
    by this app: `WALLETCONNECT_CLIENT_ID` (written only by `Core.init`,
    which the app does not call) and `WALLETCONNECT_LINK_MODE_APPS`
    (written only for link-mode peers, which needs the wallet's own
    `metadata.redirect.linkMode`; the app sets no redirect).
  - The reminder identifiers carry the open wallet's profile:
    unchanged for the primary wallet, `shiba-wallet.profile-w2.recurring.…`
    (and `.takeover.`, `.price-alert.`) for the second, so each wallet's
    planner schedules, cancels and dismisses only its own reminders
    (`store-keys.ts` `notificationIdNames`; `check-notifications.mjs`).
    This is moot today: with an app PIN on, the wallet posts no
    notifications for either wallet (section 7.4), and a decoy cannot exist
    without an app PIN. It matters only if that rule ever changes.
    Turning reminders off and the wipe still cancel by the one root
    `shiba-wallet.`, which covers both wallets.
  - **What remains:** the WalletConnect SDK's relay pause is best effort
    (the SDK reopens a closed connection by itself when the phone's network
    comes back, `controllers/relayer.ts` lines 632–646, so the real
    wallet's client could reconnect while the decoy is open; it would
    receive requests but no screen listens to it). Neither "Remove wallet"
    nor removing the duress PIN deletes the SDK's own keys (this was
    already so for the ordinary wipe); a decoy created again later is the
    same BIP-85 child, so it finds only its own earlier sessions. None of
    this has been seen on a device.
- **Stage 2 — the app PIN, then the duress PIN. BUILT OFFLINE** (phase 21,
  2026-10-14; section 7.7 says piece by piece what was built and section
  7.10 what is left). Stage 1's remainders were not moved in that slice;
  the follow-up slice above moved them (2026-10-15), so the decoy now
  satisfies rule 2 for the recovery records and the WalletConnect
  sessions, as far as offline checks can show.
- **Stage 3 — an emulator pass on a throwaway wallet. RUN ONCE, 2026-10-18
  UTC** (`AGENTS.md`, phase 21, "EMULATOR PASS p21f"), in the wallet's own
  debug development build on the Android emulator, on a throwaway wallet
  deleted with the app afterwards; nothing was sent. What passed: the
  backup check (a device prompt, then two words of the phrase) before the
  PIN is turned on and before a duress PIN is added; the PIN pad at launch
  and after auto-lock, with no wallet data loaded behind it and no
  biometric prompt; auto-lock, screen protection and notifications forced
  as section 7 says; a duress PIN equal to the app PIN refused; the
  second wallet opening with its own Account 1 and none of the real
  wallet's accounts, contacts or tokens (the network choice and a custom
  network are shared device settings by design, and the WalletConnect row
  showed the app's built-in project id as "Saved"), its Settings reading like a wallet with only an app PIN (section
  7.9); the real PIN opening the real wallet again; the second wallet's
  address equal, off the device, to the first account of the BIP-85 child
  at index 0 of the throwaway phrase; the secure store holding the two
  wallets under visibly different names (section 3.2), the PIN record a
  fixed size; and "Remove wallet" with the PIN on clearing both wallets
  and the PIN record. Two findings: (1) one PIN check (two scrypt hashes
  at N = 2^16) took 245 to 258 seconds under Hermes in the debug build,
  so the PIN is unusable as built; the release build on the same emulator
  (pass p21g) measured 49 to 53 seconds per hash at N = 2^16, about 100
  seconds per unlock, and about 3.5 seconds per hash even at N = 2^12,
  and the choice between a native scrypt and a lower N is the
  Chairperson's (`docs/THREAT_MODEL.md` F-81; section 6.2 above); (2) the
  wrong-PIN wait was stamped when an attempt started and so had always
  run out before "Wrong PIN" appeared (F-82; fixed in commit `0bfb134`,
  section 6.3 above, not yet seen on a device). What remains: the
  doubling waits and the countdown on screen; changing the PIN inside the
  second wallet; the WalletConnect separation (the development build
  failed to load the WalletConnect code, so neither wallet had sessions);
  a send's device prompt from either wallet; TalkBack; a real phone; iOS;
  and the open question of a BIP-39 passphrase (section 7.8).
  **Run again on 2026-10-19 UTC with the native scrypt** (`AGENTS.md`,
  phase 22, "EMULATOR PASS p22a"), in the debug and the release development
  builds made from commit `8b4ed84`'s content, on throwaway wallets: the
  module loaded and passed its RFC 7914 self-check in both builds; one hash
  at N = 2^16 took about 1.0 to 1.1 seconds in the release build; one
  unlock took about 2.5 seconds in both builds, one wrong PIN about 2.5 to
  2.9 seconds, turning the PIN on about 2 seconds (release) and adding a
  duress PIN about 14 seconds (debug); the duress PIN opened the second
  wallet and the real PIN the real one; TalkBack read the PIN pad in order;
  "Remove wallet" with the PIN on left the secure store empty and the app
  on onboarding. The wrong-PIN countdown was seen in pass p21g (release
  build, JavaScript scrypt). Still not tested: the doubling waits beyond
  the first, changing the PIN inside the second wallet, the WalletConnect
  separation, a send's device prompt from the second wallet, a real phone
  and iOS; the builds used predate the lock passphrase.
- **Stage P1 — a lock passphrase instead of the PIN. BUILT OFFLINE**
  (phase 22, 2026-10-19; section 8.2): the record's version 2 with its
  `kind` field (371 bytes for either kind; a version 1 record still opens
  and is converted on the next write), the passphrase rules, the
  passphrase field on the lock screen and in Settings, switching kinds in
  one record write, pinned in `app/scripts/check-duress.mjs` (commit
  `9e3dfea`). Not yet run on the emulator; the BIP-39 passphrase decoy
  (Stage P2) is not built and waits on the Chairperson's answers to section
  8.5.

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
   *Decided on 2026-10-19: both a lock passphrase and a BIP-39 passphrase
   wallet; designed in section 8.*

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
  owed. Pass p21f measured 245–258 s for one attempt (two hashes) in the
  emulator's debug development build, so N is now one named constant,
  PIN_SCRYPT_LOG2_N in app/src/wallet/pin.ts; the release-build figure
  from Settings → Developer → "Measure the PIN hashing cost" (test
  networks only; pass p21g, 2026-10-18) is 3.2–3.7 s at 2^12, 6.3–6.5 s
  at 2^13, 12–13 s at 2^14, 22–26 s at 2^15 and 49–53 s at 2^16 per hash
  on the emulator. The measurement times the same scrypt function at N = 2^12 to
  2^16.* Never a plain hash;
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
*As built after pass p21f (2026-10-18): the wait runs from the END of the
failed attempt. The pass measured about 4 minutes per attempt in the
emulator's debug build, so a wait stamped when the attempt started had
always run out before "Wrong PIN" appeared, and no wait was ever seen. The
counter is still written before the hashes; the wait is stamped after them,
and an attempt typed while a wait runs is refused at once with no hash. The
lock screen's pad counts the wait down from the stamped time.*

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

**Superseded on 2026-10-19:** the Chairperson chose both readings; section
8.2 designs the lock passphrase and section 8.3 the BIP-39 passphrase
wallet as a second decoy source.

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

- **Stage 1 remainders: closed offline** (section 5.2, the follow-up slice
  of 2026-10-15): the recovery records are per wallet through the seam,
  the WalletConnect SDK has one client and one storage namespace per
  wallet, the decoy shows the real wallet's bundler and factory settings
  without its account links, and the reminder identifiers carry the
  wallet's profile. Left: the SDK's relay pause is best effort, and the
  SDK's own keys are not deleted by either removal (section 5.2). Not yet
  seen on a device.
- **Readiness row `duress-pin`**: added with the Bridge screen slice
  (commit `fe34deb`; advisory, every network).
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

## 8. Passphrases (decided 2026-10-19; the lock passphrase, stage P1, built offline 2026-10-19; the passphrase decoy, stage P2, not built)

On 2026-10-19 the Chairperson answered the open passphrase question
(section 5.3 item 5, sections 7.6 and 7.8) with "both" (`AGENTS.md`,
"DECIDED by the Chairperson (2026-10-19)", item 4):

- **(a) a passphrase as an alternative to the 6-digit PIN** for the app
  lock, and therefore for the duress secret (section 8.2); and
- **(b) a BIP-39 passphrase wallet** — the same recovery phrase plus a
  passphrase gives a different seed, the pattern Ledger and Trezor ship —
  as a second way to derive the decoy, beside the BIP-85 child of section
  7.2 (section 8.3).

This section designs both with the same rigour as section 6. It was
written against HEAD `64d2a51`, and every code fact names the file and the
line at that commit. Nothing in it is built. While it was written, phase
22 item 2 was moving `pinScrypt` to a native scrypt (the Chairperson's
decision of the same day, threat-model row F-81) in the working tree; this
design depends only on `pinScrypt`'s contract — a string and a salt in, 32
bytes out — which that change keeps.

Two results shape everything below:

1. **The lock passphrase fits the existing record and lock almost
   unchanged** and is the smaller slice. It changes the offline-guessing
   picture that the PIN record cannot change (section 3.4), at one stated
   price: a passphrase is typed on the system keyboard, which the app-drawn
   PIN pad was designed to avoid (section 2.3 item 6).
2. **The passphrase decoy is workable only if the second profile stores
   the derived seed** — never the real phrase, and never only the
   passphrase — and it has one weakness the BIP-85 child does not: inside
   the app, the second wallet has no recovery phrase of its own to show,
   because the only thing that restores it is the real recovery phrase
   plus the passphrase (section 8.3.4). That is why the BIP-85 child stays
   the default.

This section supersedes two earlier judgements: section 7.6's minimum of
12 characters (now 15, section 8.2.2) and section 7.8's design note (now
section 8.3).

### 8.1 What the specifications and the code say

**BIP-39** (bitcoin/bips `bip-0039.mediawiki` at commit
`0d1b892ddb21c22def4af4541bfed7a2a3480e4a`, the newest commit touching the
file on 2026-10-19; sha256 of the file
`afcbcbed36fe9eb734bd607398a8c124683ded2a75c3830e1b16c47b043a9134`; read
2026-10-19), section "From mnemonic to seed":

> "A user may decide to protect their mnemonic with a passphrase. If a
> passphrase is not present, an empty string "" is used instead."

> "To create a binary seed from the mnemonic, we use the PBKDF2 function
> with a mnemonic sentence (in UTF-8 NFKD) used as the password and the
> string "mnemonic" + passphrase (again in UTF-8 NFKD) used as the salt.
> The iteration count is set to 2048 and HMAC-SHA512 is used as the
> pseudo-random function. The length of the derived key is 512 bits (= 64
> bytes)."

> "The described method also provides plausible deniability, because every
> passphrase generates a valid seed (and thus a deterministic wallet) but
> only the correct one will make the desired wallet available."

The last sentence is both the feature and its main hazard: the passphrase
has no checksum, so a mistyped passphrase opens another valid, empty
wallet without any error. The first sentence matters too: the wallet every
user of this app has today IS the empty-passphrase wallet. The section
"Test vectors" adds: "The passphrase "TREZOR" is used for all vectors."

**BIP-85** (bitcoin/bips `bip-0085.mediawiki` at
`6209768676bf85d7ef5ffb4055543d6286d79b96`, the commit
`packages/core/src/bip85.ts` cites; its sha256 `dcbeb977…d1cf7e` re-checked
on 2026-10-19): "We assume a single BIP32 master root key. This
specification is not concerned with how this was derived (e.g. directly or
via a mnemonic scheme such as BIP39)." A BIP-85 child therefore depends on
the root key and so on any BIP-39 passphrase; the wallet derives its
children from the empty passphrase (`bip85.ts` line 132,
`mnemonicToSeedSync(…, '')`).

**@scure/bip39 2.4.0** (installed at the root and in `app/node_modules`):
`psalt` builds the salt as `nfkd('mnemonic' + passphrase)` (`index.js`
lines 226–230); `nfkd` throws "expected well-formed Unicode string" for a
string with a lone surrogate before calling `str.normalize('NFKD')` (lines
33–39); `mnemonicToSeedSync` is PBKDF2-HMAC-SHA512 with `c: 2048, dkLen:
64` (lines 270–275). The library already applies BIP-39's NFKD rule to the
passphrase.

**This repository at `64d2a51`.**

- `packages/core/src/keyring/mnemonic.ts` lines 28–33:
  `mnemonicToSeed(mnemonic, passphrase = '')` validates the phrase and
  passes the passphrase to `mnemonicToSeedSync`; `HdKeyring.fromMnemonic`
  takes one too (`keyring.ts` lines 19–25). `packages/core/test/chains.test.ts`
  lines 210–218 checks only that a passphrase changes the address; no
  BIP-39 vector with the passphrase "TREZOR" is tested.
- The app never passes a passphrase: `WalletContext.tsx` derives the
  public data with `mnemonicToSeed(mnemonic)` (line 357) and signs with
  `mnemonicToSeed(mnemonic)` (line 1343). The vault holds one phrase per
  profile (`storage.ts`, `readPhrase` line 660, `saveNewPhrase` line 672).
- The PIN is digits only: `pinFormatError` accepts exactly
  `/^[0-9]{6}$/` (`pin.ts` lines 305–307); `isTriviallyGuessed` (lines
  310–312); every refusal of a new PIN that could reveal the other slot is
  the one sentence `PIN_NOT_USABLE_MESSAGE` (line 299). The record's keys
  are an exact set, `'N,fails,kdf,p,r,slots,until,v'` (line 242), at
  version 1 (line 243), and its encoded length is one constant,
  `PIN_RECORD_LENGTH` (lines 215–220; 358 characters, pass p21f).
  `pinScrypt` hands the input string to noble's `scryptAsync` (lines
  159–167), which encodes a string as its UTF-8 bytes (`@noble/hashes`
  2.4.0 `utils.js`, `kdfInputToBytes`, lines 514–518). `matchSlots` hashes
  the input against both slots and compares each in constant time (lines
  357–366); `attemptPin` writes the counter before hashing (line 401) and
  computes both hashes even for a malformed PIN (lines 402–404);
  `setPinSlot` refuses a new PIN that opens the other slot, computed by
  hash (lines 442–453).
- The lock screen's `PinPad` blocks screen capture with its own key
  (`LockGate.tsx` line 307, `usePreventScreenCapture('pin-pad')`), clears
  the digits before the check runs (line 346), and speaks only "N of 6
  digits entered" (line 382).
- `duress.ts`: the decoy is the BIP-85 child at the fixed index 0 (lines
  52–58); `effectivePrefs` forces auto-lock on, screen protection on and
  notifications off from one boolean, "is an app PIN set" (lines 101–110);
  the honest claim names "a 6-digit PIN" (lines 316–317), as does the
  readiness reason (lines 374–375).
- The EVM accounts use `m/44'/60'/0'/0/N` (`app/src/wallet/accounts.ts`
  line 773, the MetaMask convention).

**Products** (read 2026-10-19). Trezor's knowledge base, "What is a
passphrase?" (<https://trezor.io/learn/a/passphrases-and-hidden-wallets>):
"Your Trezor combines your wallet backup and the passphrase to generate a
unique wallet."; "Your Trezor device doesn't store your passphrase. You'll
need to enter it manually every time you want to access the associated
wallet."; "Entering a different passphrase—intentionally or by
mistake—creates a new, empty wallet."; "Passphrases cannot be changed,
removed, or recovered."; a passphrase can be "up to 128 characters long on
Trezor Model T, Safe 3, Safe 5, and Safe 7, or up to 50 characters long on
Trezor Model One." Ledger is quoted in section 1.1. (Section 9 records that
Trezor's passphrase pages did not load on 2026-10-11; this one did on
2026-10-19.)

**NIST SP 800-63B-4** (<https://pages.nist.gov/800-63-4/sp800-63b.html>,
read 2026-10-19), for the password rules this design follows or departs
from: "Verifiers and CSPs SHALL require passwords that are used as a
single-factor authentication mechanism to be a minimum of 15 characters in
length."; "Verifiers and CSPs SHOULD permit a maximum password length of
at least 64 characters."; "Each Unicode code point SHALL be counted as a
single character when evaluating password length. Verifiers and CSPs SHALL
NOT impose other composition rules"; "If the CSP disallows a chosen
password because it is on a blocklist of commonly used, expected, or
compromised values …, the subscriber SHALL be required to choose a
different password."; on normalisation, "the verifier SHOULD apply the
normalization process for stabilized strings using the Normalization Form
Canonical Composition (NFC)"; "Verifiers MAY make limited allowances for
mistyping (e.g., removing leading and trailing whitespace characters
before verification …) if the password remains at least the required
minimum length after such processing"; and "Verifiers SHALL allow the use
of password managers and autofill functionality." NIST writes for online
account verifiers, not for a secret that guards a wallet under coercion;
where this design departs from it, it says so and why.

**Measured for this section** (Node v24.21.0 on the development machine,
Intel Core i7-9750H, the installed `@noble/hashes` 2.4.0 and `@scure/bip39`
2.4.0, 2026-10-19; a freshly generated mnemonic, never printed):

- scrypt at N = 2^14, r = 8, p = 1, five runs per input: 56–78 ms for a
  6-character input, 55–63 ms for 20 characters, 55–62 ms for 128
  characters. **The cost does not depend on the input's length** at any
  resolution that matters.
- `mnemonicToSeedSync` with a 6-digit passphrase, 20 runs: 8.0 ms minimum,
  8.1 ms median, 21.2 ms maximum per seed.

### 8.2 The lock passphrase

#### 8.2.1 What it is

When the app lock is turned on (Settings → Privacy, today the section
"App PIN", `duress.ts` line 290), the user chooses its kind: a 6-digit PIN
(as built) or a passphrase. The kind belongs to the whole lock: the app
secret and the duress secret are both PINs or both passphrases (section
8.2.6). Everything else in sections 6 and 7 holds unchanged: the two-slot
record, both hashes computed on every attempt with a constant-time
compare, the wait schedule (section 6.3), the forced auto-lock, screen
protection and notifications rule (section 7.4; `effectivePrefs` does not
look at the kind), the backup check before the lock or a duress secret is
set (section 7.5), the second wallet, "Remove wallet" removing both
(section 7.3), and the second wallet's Settings (section 7.9).

#### 8.2.2 Length: at least 15 characters, at most 128

**Decision: a lock passphrase has 15 to 128 Unicode code points, counted
as typed (before normalisation), with no composition rules.**

Why a passphrase can matter at all — the offline-guessing arithmetic of
section 3.4, at the Node figure behind `PIN_SCRYPT_LOG2_N` (`pin.ts`
comment, lines 85–89: 240–313 ms per hash at N = 2^16; 0.27 s is used
below), for ONE slot and one laptop thread:

| Secret | Bits | Whole space at 0.27 s a guess |
|---|---|---|
| 6-digit PIN | log2(10^6) ≈ 19.9 | about 3.1 days |
| 4 words from a 7,776-word list (five dice, 6^5) | 4 × 12.92 ≈ 51.7 | about 31 million years |
| 5 words from the BIP-39 English list (2,048) | 5 × 11 = 55 | about 310 million years |
| 5 words from a 7,776-word list | ≈ 64.6 | about 2.4 × 10^11 years |
| 15 random lowercase letters | 15 × 4.70 ≈ 70.5 | about 1.4 × 10^13 years |
| 15 characters a person makes up | unknown | possibly not much more than the PIN |

An attacker with faster hardware divides every figure by the same factor:
a million-fold speed-up takes the PIN space to under a second and the
4-word passphrase to about 31 years. The row that matters most is the
last: **a length rule cannot measure strength.** A 15-character sentence a
person makes up ("my dog is called rex") may be found by a dictionary
attack far sooner than its length suggests. The minimum is a floor against
short secrets, not a promise; the copy says how to choose a strong one
(section 8.2.9).

Why 15: NIST's single-factor floor (quoted in section 8.1). Against the
attacker this feature is for, the lock secret is single-factor: the PIN
record lives in standard secure storage (`pin.ts` lines 141–144,
`whenUnlockedThisDeviceOnly`, no biometric binding), and a file copier who
gets past the Keystore question of section 3.4 guesses it with nothing
else in the way. Section 7.6 proposed 12 as a judgement; 15 replaces it
with a published rule.

Why 128: NIST asks for at least 64; 128 matches the newer Trezor models
(section 8.1) and is ample. Because scrypt's cost does not depend on the
input's length (measured, section 8.1), a long passphrase costs the lock
screen nothing extra.

Why code points, as typed: NIST's counting rule. NFKD can expand a
character into several code points (a precomposed "é" becomes "e" plus a
combining accent), so counting after normalisation would credit accents
twice. An emoji counts as one.

#### 8.2.3 Normalisation and whitespace

**Decision: the passphrase is normalised to NFKD — with the same function
`@scure/bip39` applies to a BIP-39 passphrase — before it is hashed; it is
case-sensitive; inner whitespace is kept exactly; leading and trailing
whitespace is refused at set-up and stripped at entry.**

Why NFKD rather than NFC or nothing:

- **Not "nothing".** The same visible text can arrive as different code
  points from different keyboards (a precomposed "é" or "e" + a combining
  accent). Without normalisation that is two different passphrases, and a
  user who changes keyboards is locked out with nothing wrong.
- **NFKD rather than NIST's NFC.** Both make canonically equivalent text
  equal. NFKD also folds compatibility forms (full-width Latin letters from
  some East Asian keyboards, ligatures such as "ﬁ"), so text that looks the
  same hashes the same; the space it removes is negligible. And it is what
  BIP-39 does to its own passphrase (section 8.1), so the app has one
  normalisation for every passphrase it handles, and a user who types the
  same words as a lock passphrase and as a BIP-39 passphrase (section 8.3)
  gets the same bytes in both places. Using `@scure/bip39`'s behaviour also
  inherits its refusal of ill-formed Unicode (a lone surrogate), which
  `TextEncoder` would otherwise turn silently into a replacement character.

Why the whitespace rules: a passphrase that begins or ends with a space
is almost always a mistake, and a trailing space is invisible in a secure
field. Refusing it at set-up means no stored passphrase can have one;
stripping it at entry (NIST's allowance, quoted in section 8.1) then only
rescues a stray space and can never turn a correct passphrase into a wrong
one. The two rules are a pair and are pinned together (section 8.2.11):
stripping at entry without refusing at set-up would make a passphrase
with a trailing space impossible to type. Inner whitespace is kept exactly
(two spaces are not one), because the same rule must hold for a BIP-39
passphrase, where other wallets would derive a different seed from a
collapsed string.

The PIN path is unchanged: six ASCII digits need no normalisation.

#### 8.2.4 What a new passphrase is refused for

NIST forbids composition rules but requires a blocklist where one is used.
A new lock passphrase is refused when it:

1. has fewer than 15 or more than 128 code points;
2. begins or ends with whitespace;
3. contains a control character (Unicode category Cc, which includes line
   breaks and tabs) or ill-formed Unicode;
4. is one character repeated;
5. contains three or more words of the open wallet's recovery phrase
   (whitespace-separated, compared after lower-casing). Reason: a lock
   passphrase is typed on the system keyboard at every unlock, so recovery
   words in it feed part of the seed to the keyboard, and every such word
   removes 11 bits from what protects the wallet. The phrase is already
   open at this point for the backup check (section 7.7), so the rule
   costs no extra prompt. The threshold of three is a judgement (section
   8.5);
6. opens the other slot (computed by hash, as `setPinSlot` does);
7. for a duress passphrase only: is too close to the app passphrase. A
   person who must invent two passphrases tends to make the second a
   variant of the first ("…horse" and "…horse!"), and the coercer is given
   the duress passphrase — with a file copy, that variant is the best
   possible hint for guessing the real slot. At duress set-up both
   plaintexts are typed in the same flow (the current app secret is asked
   for first, `PIN_PROMPTS.current`, `duress.ts` line 351), so the flow can
   refuse a duress passphrase that contains the app passphrase or is
   contained in it, that differs from it by four or fewer single-character
   edits, or that shares a run of eight or more characters with it (after
   NFKD and lower-casing; thresholds are judgements). **Gap, stated:** when
   either passphrase is changed later, only that one plaintext is
   available (the other slot holds a hash), so the rule cannot be applied
   then; the change screen shows the advice instead.

Refusals 4, 6 and 7 share one sentence, as PINs do today, so a change made
inside the second wallet cannot tell its user anything about the real
passphrase: "This passphrase cannot be used. Choose a different
passphrase." Refusals 1, 2, 3 and 5 reveal nothing about the other slot and
can say exactly what is wrong. No breach list is consulted: the app has
none offline, and asking a service would send a hash prefix of the secret
over the network.

#### 8.2.5 What the record stores

**Version 2 of the record adds one field, `kind`, with the value `"pin"`
or `"phr"` — three characters either way — that describes BOTH slots.**

- The lock screen must draw a digit pad or a text field before anything is
  typed, so the kind has to be readable before any wallet is chosen. Being
  common to both slots, it says nothing about the duress slot, and it is
  visible on the lock screen anyway.
- The record stays fixed-shape: `v`, `kdf`, `N`, `r`, `p`, `kind`,
  `slots`, `fails`, `until`, every field fixed-width, so its encoded
  length is one constant for both kinds (a new pinned constant beside
  `PIN_RECORD_LENGTH`). On Android the stored ciphertext has the
  plaintext's length (section 3.1), so this matters: a variable field would
  leak.
- **The passphrase's length is not stored or derivable**: each slot is
  still a 32-byte salt and a 32-byte scrypt hash (64 bytes; an unset slot
  is 64 random bytes), and the hash's cost does not depend on the length
  (section 8.1).
- **Migration:** the decoder accepts version 1 (read as kind `"pin"`, at
  its exact length of 358) and version 2; every write writes version 2, so
  the first counter write after the update converts the record. A version
  1 record with a `kind` field, a version 2 record without one, or an
  unknown kind is damaged, as an extra key is today (line 242).
- **The hash input** is the normalised, edge-stripped passphrase as UTF-8
  bytes through `pinScrypt` (the same scrypt, the same N, the same
  per-slot salt). A PIN still hashes exactly as before ("123456" is
  already its own NFKD form), so existing PIN records open unchanged. The
  native path being added in phase 22 item 2 is specified to feed the same
  UTF-8 bytes as noble; that must be re-checked against a non-ASCII
  passphrase when it lands (a pinned vector).
- **The attempt keeps its shape:** the counter is written first, both
  hashes are computed, and a malformed entry (too short, say) costs both
  hashes and counts, exactly as a malformed PIN does (lines 402–404). The
  lock screen therefore never answers a format error faster than a wrong
  passphrase and never states the minimum length.

#### 8.2.6 A PIN in one slot and a passphrase in the other: refused

**Decision: the duress secret must be of the same kind as the app
secret.** Reasons:

1. **The lock screen shows one input before it knows which wallet.** With
   mixed kinds it would need both — a digit pad with a "use a passphrase
   instead" switch, say — and a coercer who was told "it is a PIN" and sees
   that switch learns that a second credential exists (rule 1, section
   1.2).
2. **The second wallet's Settings must read like a wallet with only an app
   lock** (section 6.4, last invariant; section 7.9), of the same kind as
   the lock screen it was opened from. With mixed kinds, the second
   wallet's Settings would either name the kind it was opened with — which
   differs from what the real wallet's lock screen asks for when the
   coercer later sees the phone locked — or lie.
3. **One `kind` field describes both slots**, so nothing in the record
   distinguishes them.

An alternative was considered and rejected: a lock screen that always
shows a text field and accepts a 6-digit PIN typed into it as a short
passphrase. It would allow any mix, but it gives up the app-drawn pad for
every PIN user (section 2.3 item 6) to support a combination that buys
nothing. Consequence, stated in Settings: choosing a passphrase as the
duress secret means the app lock is a passphrase too.

#### 8.2.7 Switching between a PIN and a passphrase

From the real wallet only: type the current secret, choose the new kind,
type the new app secret twice, and — if a duress secret exists — type a new
duress secret of the same kind twice. Both slots are rewritten in ONE
record write, so the record never holds mixed kinds, not even after a
crash. The second wallet is not touched (only the secret that opens it
changes).

Inside the second wallet, the same control runs the same steps and ends
with `PIN_ACTION_NOT_COMPLETED` ("This could not be completed on this
phone. Nothing was changed.", `duress.ts` line 332), as "Remove the PIN"
and "Add a duress PIN" already do there (section 7.9): it cannot rewrite
the real slot, and rewriting only its own slot would create mixed kinds.
That adds a third such action to the second wallet's Settings — an open
question (section 8.5).

#### 8.2.8 The lock screen

The passphrase view replaces the pad when the record's kind is `"phr"`: a
prompt "Enter your passphrase", one single-line secure field, and an
"Unlock" button (the keyboard's return key also submits). Its field uses
the same input-hygiene props as the private-key import
(`ImportKeyScreen.tsx` lines 153–159), each in the installed React Native
0.86.3 (`Libraries/Components/TextInput/TextInput.d.ts`):

- `secureTextEntry` (line 951); on Android it sets the input type
  `TYPE_TEXT_VARIATION_PASSWORD` (`ReactTextInputManager.kt` lines
  687–699);
- `autoCorrect={false}` (line 744) and `spellCheck={false}` (line 211);
- `autoComplete="off"` (line 668; the value at line 737),
  `importantForAutofill="no"` (line 391) and `textContentType="none"`
  (line 269);
- `autoCapitalize="none"` (line 588);
- `contextMenuHidden` (line 794), so the field offers no paste menu;
- `maxLength` (line 827) as a typing guard only: how React Native counts it
  on Android (UTF-16 units or code points) was not checked, so it is set
  generously (256) and the 128-code-point rule is enforced in code.

As with the pad: screen capture is blocked with the same `'pin-pad'` key
whatever the app-wide switch says; the field's text is copied into the
check and cleared from state before the check runs; nothing about the
input is logged; the message line and the countdown are the pad's.

**What this view gives up, stated in Settings:**

- **The keyboard sees every character.** A third-party keyboard is in a
  position to record what is typed (threat model T-04), which is why the
  PIN uses an app-drawn pad. React Native 0.86.3 exposes no prop for
  Android's "no personalised learning" input flag (no match in its Android
  sources on 2026-10-19), so whether a keyboard learns from a password
  field is that keyboard's own choice — unverified for Gboard.
- **Autofill and password managers are switched off, against NIST's
  "SHALL allow".** NIST's reasoning (password managers encourage strong
  passwords) assumes an online account. Here: (1) a saved copy of the lock
  secret outside the app undoes what the lock protects against a file
  copy; (2) under coercion, autofill on the lock screen would offer the
  saved passphrase — the real one; (3) two saved entries for this app
  would tell a coercer that a duress secret exists.
- **Paste is not a security boundary.** `contextMenuHidden` hides the
  menu, but a keyboard's own clipboard strip may still insert text
  (unverified). The copy advises against copying the passphrase.
- **Shoulder-surfing takes longer.** A passphrase is on screen, as dots,
  for longer than six digits; whether Android's "show passwords" setting
  briefly shows each typed character in a React Native secure field is
  unverified.
- **What a screen reader says while typing** into the secure field is
  unverified; it must never speak the characters (an emulator check).

#### 8.2.9 Settings and copy (draft, to be pinned when built)

- Switch: "Use a PIN or passphrase to unlock" (replacing
  `APP_PIN_SWITCH_LABEL`, `duress.ts` line 291). Choice: "6-digit PIN" /
  "Passphrase (15 to 128 characters)".
- Section titles follow the kind: "App PIN" / "App passphrase"; "Duress
  PIN" / "Duress passphrase". Inside the second wallet they follow the same
  kind, so they read as in any wallet with that kind of lock.
- Passphrase advice: "A passphrase is typed on your keyboard each time the
  wallet opens. Use four or more random words, for example picked with
  dice, not a sentence or quotation someone could guess. Do not use words
  from your recovery phrase. Do not save it in a password manager: this
  wallet turns autofill off for it."
- Keyboard note: "Unlike the PIN pad, your keyboard sees what you type.
  Use a keyboard you trust."
- Limits note (the passphrase form of `APP_PIN_LIMITS_NOTE`): "What the
  passphrase does not protect against: someone who copies this app's
  storage from the phone can try passphrases on a computer. A long, random
  passphrase makes that impractical; a short or common one does not. After
  5 wrong passphrases the lock screen waits 30 seconds, and the wait
  doubles with each further wrong passphrase up to 1 hour; it never wipes
  the wallet. There is no passphrase reset: if you forget it, clear the
  app's data or reinstall it, and restore the wallet from your recovery
  phrase."
- The honest claim, passphrase form (`DURESS_HONEST_CLAIM` names "a
  6-digit PIN"): "The duress passphrase opens a separate wallet instead of
  this one, so someone looking at the screen sees an ordinary wallet.
  Anyone who copies this app's files from the phone can tell that two
  wallets exist and can try to guess both passphrases from such a copy: a
  long, random passphrase makes that impractical, a short or common one
  does not. Funding the second wallet from this wallet links them
  on-chain." The readiness reason (`DURESS_READINESS_REASON`) becomes
  kind-neutral: "…and a 6-digit PIN or a short passphrase can be guessed
  from such a copy."
- Prompts: "Choose a passphrase", "Type the passphrase again", "Choose a
  duress passphrase", "Type the duress passphrase again", "Type your
  current passphrase".
- Refusals: "A passphrase has 15 to 128 characters."; "A passphrase cannot
  begin or end with a space."; "A passphrase cannot contain line breaks or
  other control characters."; "Do not use words from your recovery phrase
  in your passphrase."; and the shared "This passphrase cannot be used.
  Choose a different passphrase."
- Lock screen: "Enter your passphrase"; "Wrong passphrase. Try again." /
  "Wrong passphrase. Try again in N seconds."; "Too many wrong
  passphrases. Try again in N seconds."; "You can enter your passphrase
  again."; spinner "Checking the passphrase". The same words whichever
  wallet a passphrase would open.

#### 8.2.10 What it resists, and what it does not

Resisted: guessing at the screen (the same wait schedule); guessing from a
file copy, for a long random passphrase (the table in section 8.2.2 —
millions of years where the PIN takes days); reading the passphrase's
length or kind of duress secret from the record (fixed shape); a duress
passphrase that is a near copy of the real one, at set-up.

Not resisted: a keyboard that records what is typed (T-04); a made-up
passphrase that is long but guessable; someone watching the user type;
the forensic reader telling that two wallets exist (section 3.2,
unchanged); the Keystore question of section 3.4 (unchanged); coercion
itself — the coercer asks for the passphrase as they would for the PIN.

#### 8.2.11 Invariants and the mutants a suite needs (check-duress)

Each line is an invariant; the mutant after the dash must fail a check.

- Both slots' hashes are computed for every passphrase attempt and
  compared in constant time — a mutant that stops after the first match.
- The record's encoded length is the same constant for kind `"pin"` and
  `"phr"`, with or without a duress secret, on every write — a mutant that
  writes the kind with a variable width, or stores the passphrase's length.
- A version 1 record decodes as kind `"pin"` and opens with the same PIN —
  a mutant that refuses version 1.
- The input to both slot hashes is the same canonical string (NFKD, edge
  whitespace stripped) — mutants that use NFC (a check with a full-width
  letter and with "ﬁ"), that skip the strip at entry, and that accept edge
  whitespace at set-up (a passphrase with a trailing space then never
  opens).
- Length is counted in code points as typed — a mutant that counts UTF-16
  units (15 emoji accepted, 14 refused).
- A malformed entry costs both hashes and counts as a wrong attempt — a
  mutant with a fast refusal.
- A duress secret of the other kind is refused, and switching kinds
  rewrites both slots in one write — a mutant that allows mixed kinds, and
  one that writes the slots in two writes.
- The other-slot, near-variant and repeated-character refusals give the
  one shared sentence — a mutant with a distinct sentence for the
  other-slot case.
- The recovery-word rule refuses three phrase words and accepts two — a
  mutant that never reads the phrase.
- The field's props (`secureTextEntry`, `autoCorrect={false}`,
  `spellCheck={false}`, `autoComplete="off"`, `importantForAutofill="no"`,
  `textContentType="none"`, `contextMenuHidden`) and the `'pin-pad'`
  capture key are pinned by a source scan — a mutant that removes any one.
- The field's state is cleared before the check runs — a mutant that keeps
  it.
- `effectivePrefs` gives the same result for both kinds — a mutant keyed
  on the kind.
- Every new copy string above, per kind, and the second wallet showing the
  same kind's titles.

### 8.3 A BIP-39 passphrase wallet as a second decoy source

#### 8.3.1 How it differs from the BIP-85 child

| | BIP-85 child (built, section 7.2) | BIP-39 passphrase wallet |
|---|---|---|
| What the second wallet is | A new phrase: the BIP-85 child at index 0 of the real phrase (`duress.ts` lines 52–58) | The real phrase's own words with a passphrase: the seed is PBKDF2 of the phrase with "mnemonic" + passphrase as the salt (section 8.1) |
| What recovers it | The real phrase and the published index 0; nothing else is written down | The real phrase and the exact passphrase, which the user must remember or write down: a second secret |
| A typing mistake at recovery | Not possible (the index is fixed) | Silently opens another, empty wallet ("every passphrase generates a valid seed", BIP-39) |
| Its own recovery phrase | Yes: 12 or 24 words that restore it, alone, in any BIP-39 wallet | None: no phrase restores it without the passphrase (section 8.3.4) |
| In other wallets | Its own phrase works anywhere; deriving it from the real phrase needs a BIP-85-aware wallet such as COLDCARD (section 1.1) | Wallets with BIP-39 passphrase support (Trezor, Ledger, section 8.1 and 1.1) can open it from the phrase and passphrase — with the same addresses only where they use the same paths (`m/44'/60'/0'/0/N` for Ethereum, `accounts.ts` line 773); not checked for any other wallet |
| Who can find it from the real phrase | Anyone (index 0 is published) | Anyone who also finds the passphrase |
| Stored on the phone | Its phrase, under the second profile | Its 64-byte seed, under the second profile (section 8.3.2) |

#### 8.3.2 What the second profile stores

Three options:

1. **Store the passphrase**, encrypted under the second profile, and
   derive the seed when needed. Rejected: the seed also needs the real
   phrase, so opening the second wallet or signing in it would read the
   real phrase, which rule 3 (section 1.2) forbids; with a protected
   phrase a biometric prompt for the recovery phrase would appear as the
   second wallet opens — a visible difference (rule 1).
2. **Store nothing**: the duress secret is the BIP-39 passphrase, and the
   seed is derived at each unlock from the real phrase and the secret just
   typed. Attractive — nothing is stored, and the second wallet is
   reproducible from the phrase and the duress secret — but rejected for
   the same reason, more strongly: every unlock and every signature in the
   second wallet would read the real phrase. (Section 8.3.3 also rejects
   tying the passphrase to the duress secret for other reasons.)
3. **Store the derived seed. Chosen.** At set-up, the real phrase is
   opened once through the vault (as `setUpDecoyWallet` does today,
   `duress.ts` lines 134–138, after the backup check's prompt), the seed is
   computed with core's `mnemonicToSeed(phrase, passphrase)`
   (`mnemonic.ts` lines 28–33), stored under the second profile, both
   strings dropped and the seed buffer zeroed. Afterwards the second wallet
   reads only its own seed; the real phrase is never read while it is
   open. PBKDF2 is one-way, so the stored seed reveals neither the phrase
   nor the passphrase.

Consequences of option 3:

- **A new kind of wallet root.** The vault holds a phrase per profile and
  `WalletContext.tsx` derives everything from a phrase (lines 357 and
  1343). Both need a seed-backed path: the public data and signing from a
  stored seed, for the second profile only. It can be protected with
  biometrics as a phrase can.
- **A new declared secret key** in `store-keys.ts` (a neutral name such as
  `shiba-wallet.wallet-seed.v1`). Its name and its ciphertext length (64
  bytes of seed, not a 12- or 24-word phrase) are visible on Android
  (section 3.1), so a file copier learns that the second wallet is a
  passphrase wallet. They already learn that it exists (section 3.2).

#### 8.3.3 Which passphrase: a separate one, not the duress secret

Two variants: **(B1)** a separate BIP-39 passphrase chosen at duress
set-up, or **(B2)** the duress secret itself (PIN or lock passphrase)
doubling as the BIP-39 passphrase.

B2 is attractive — nothing extra to remember — and is rejected:

- **Changing the duress secret would break the second wallet.** Either
  the stored seed stays (the wallet keeps opening, but recovery from the
  phrase and the new secret gives a different, empty wallet: the recovery
  rule silently breaks), or the seed is derived again (the funds stay
  behind in the old wallet). Section 7.9 makes "Change PIN" in the second
  wallet change the duress slot, and rule 1 requires it to work there as
  in any wallet, so B2 could not refuse it without a tell. Trezor's own
  page says "Passphrases cannot be changed" — a lock secret must be
  changeable.
- **A 6-digit duress PIN would make the second wallet a search from the
  phrase alone.** With the phrase, 10^6 candidate seeds at about 8.1 ms
  each (section 8.1) are about 2.3 hours of one laptop thread, plus a key
  derivation and an address check per candidate (not measured). In this
  orientation that costs little — whoever holds the phrase already holds
  the real wallet, and the BIP-85 decoy is found with no search at all,
  since index 0 is published — but it is decisive in the other
  orientation (section 8.3.4), and it means two different secrets'
  requirements are merged into one.
- **The two jobs need different rules.** A lock secret must resist
  guessing from a file copy and be changeable; a BIP-39 passphrase must
  stay exactly the same forever and be typable in other wallets.

**B1 is chosen.** The BIP-39 passphrase is chosen at duress set-up, typed
twice, never stored and never changed; the duress secret stays an ordinary
lock secret. Rules for the BIP-39 passphrase:

- **Never empty.** The empty passphrase IS the real wallet (BIP-39: "an
  empty string "" is used instead"), so an empty passphrase would make the
  duress secret open the real wallet. Refused, and set-up also checks that
  the new wallet's first Ethereum address differs from the real wallet's
  Account 1 before anything is stored.
- **Printable ASCII (space to tilde), 1 to 50 characters, no leading or
  trailing space.** Reason: the passphrase may one day be typed on another
  wallet or a hardware device. BIP-39's NFKD makes any Unicode
  deterministic, but whether a given device can enter a given character is
  outside this app's knowledge, and Trezor Model One stops at 50
  characters (section 8.1). Whether other wallets trim edge spaces was not
  checked, so edge spaces are refused. No strength floor: in this
  orientation the passphrase guards only the link between the second
  wallet and the phrase, which the published BIP-85 index already gives
  away today.
- **Normalisation is the library's.** The typed string goes to
  `mnemonicToSeed` unchanged; `@scure/bip39` applies NFKD (lines 226–230).
- **A check against typing mistakes.** After the passphrase is typed twice,
  the screen shows the first Ethereum address of the wallet it opens
  ("This passphrase opens a wallet whose first Ethereum address is
  0x….") and asks the user to note it; when the passphrase is
  typed again later (section 8.3.7), the same address is shown before
  anything is saved, so a one-character slip is visible.

#### 8.3.4 The finding: the second wallet has no recovery phrase to show

Rule 5 (section 1.2) and section 3.3 require "reveal the recovery phrase"
under the decoy to show the decoy's phrase.

- **BIP-85 decoy:** it shows its child phrase, which restores it, alone, in
  any BIP-39 wallet. A coercer who checks it elsewhere finds exactly this
  wallet, and learns nothing of the real one.
- **Passphrase decoy:** no phrase restores it alone. Its only true
  recovery data is the real phrase plus the passphrase. Showing the real
  phrase hands over the real wallet (the empty-passphrase wallet); showing
  any other phrase is a lie a coercer can check. The only truthful screen
  is: "This wallet comes from a recovery phrase together with a
  passphrase. Neither is stored on this phone, so there is no recovery
  phrase to show here." No other wallet in this app shows that screen —
  the app has no ordinary passphrase wallets (section 7.8) — so it is
  itself unusual, and it invites the question "then where is that
  recovery phrase?", whose truthful answer is the real phrase.

The difference is only inside the app: the written backup is the real
phrase in both designs, so a coercer who demands the paper gets the real
wallet whichever decoy is used.

**Ledger's pattern is the other orientation.** In Ledger's own words
(section 1.1) the user keeps "a small balance on your regular accounts
while most of your crypto sits on hidden accounts": the decoy is the
phrase ALONE and the real wallet is the passphrase wallet. There the
decoy's reveal shows the phrase truthfully, but:

1. the coercer then holds the phrase and can search for the real
   passphrase offline at about 8 ms a guess plus an address check — so the
   real passphrase must be long and random (a 6-digit secret falls in
   hours) and must not be the app lock secret;
2. every existing user's funds, smart accounts, sessions, subscriptions,
   multisigs and records belong to the phrase-only wallet, which would
   become the decoy, so adopting it means moving everything to a new
   wallet;
3. the real wallet would need the seed-backed path of section 8.3.2 under
   the primary profile.

That is a different feature — a hidden main wallet — and is not designed
further here; whether to build it instead of, or as well as, the
passphrase decoy is the first open question (section 8.5).

#### 8.3.5 The choice at duress set-up, and the default

Duress set-up (real wallet only, after the backup check and the current
app secret) gains one step, "Which second wallet should the duress PIN
open?" ("duress passphrase" when the lock is a passphrase):

1. **"A wallet derived from your recovery phrase (BIP-85). There is
   nothing more to remember."** — the DEFAULT, pre-selected;
2. **"A wallet from your recovery phrase and a passphrase you choose
   (BIP-39 passphrase). You must remember or write down the passphrase."**

BIP-85 is the default because nothing extra has to be remembered or can
be lost; its own phrase can be shown under coercion (section 8.3.4); a
mistake at recovery is impossible; and it is built and was exercised on
the emulator (pass p21f). The choice is made once; changing it means
removing the duress secret (which deletes the second wallet) and setting it
again. Nothing in the second wallet's Settings names its source; the
reveal screen of section 8.3.4 is the one place where the two sources
differ under coercion.

#### 8.3.6 Backup wording and the honest claim

- Backup note (in place of `DURESS_BACKUP_NOTE`, `duress.ts` lines
  320–321, when this source is chosen): "The second wallet comes from this
  wallet's recovery phrase together with the passphrase you chose (a
  BIP-39 passphrase). To restore it, on this phone or in another wallet,
  you need both, typed exactly. This phone does not keep the passphrase and
  cannot show it again. A passphrase typed differently by even one
  character opens a different, empty wallet without any warning. Writing
  the passphrase next to your recovery phrase tells whoever finds them that
  a second wallet exists."
- Added to the honest claim at this set-up: "Because this is a standard
  BIP-39 passphrase, anyone who has your recovery phrase and this
  passphrase can open the second wallet here or in another wallet that
  supports passphrases. If you are made to show the second wallet's
  recovery details, the only thing that restores it is your recovery
  phrase, which also opens this wallet." The file-copy sentence is
  unchanged: two wallets remain visible to anyone who copies the app's
  files.
- Under the second wallet, the reveal screen's sentence of section 8.3.4.

#### 8.3.7 Removal

"Remove wallet" with an app lock removes both profiles, as today
(`wipeBothWallets`, `duress.ts` lines 218–233), and must also delete the
second profile's stored seed (a new item; an invariant). Removing the
duress secret, or turning the app lock off, deletes the second wallet's
seed and records, as it deletes its phrase today. Setting the duress
secret again with this source asks for the BIP-39 passphrase again and
shows the first address before saving (section 8.3.3); the same passphrase
brings back the same wallet, and a different one silently opens another,
which the address shows. With the BIP-85 source, the same wallet always
comes back with nothing typed.

#### 8.3.8 Invariants and the mutants a suite needs

- An empty BIP-39 passphrase is refused, and a wallet whose first address
  equals the real Account 1 is never stored — a mutant that accepts the
  empty string (the duress secret then opens the real wallet).
- With the passphrase decoy open, the fake secure store records zero reads
  of the real phrase (the counting method of section 6.4) — a mutant that
  derives the seed at unlock from the real phrase.
- Set-up stores exactly one new item, the 64-byte seed under the second
  profile, and no write during set-up contains the passphrase's bytes — a
  mutant that stores the passphrase.
- The stored seed equals `mnemonicToSeed(phrase, passphrase)`, and
  `packages/core` tests BIP-39's official vectors with the passphrase
  "TREZOR" (absent today, section 8.1), pinned by entropy and seed rather
  than by the phrase because the pre-commit secret scan refuses
  checksum-valid phrases, as `bip85.test.ts` already does — a mutant that
  passes an empty passphrase.
- The two typings must match — a mutant that reads only the first.
- Under the passphrase decoy, the reveal screen never shows any phrase — a
  mutant that shows the real phrase.
- "Remove wallet" deletes the seed item — a mutant that leaves it.
- Changing the duress secret leaves the second wallet's seed and its first
  address unchanged — a mutant that derives the wallet again.
- The ASCII, length and edge-space rules of section 8.3.3 — a mutant per
  rule.

### 8.4 Staging, checks and the emulator pass

**Status of P1 (2026-10-19; unchanged at the 2026-10-20 refresh): built
and checked offline (commit `9e3dfea`), not yet on the emulator.** The
native scrypt it depends on is in (commit `8b4ed84`) and was measured on the
emulator on 2026-10-19 UTC at about 2.5 seconds per unlock for a PIN
(section 5.2); a passphrase goes through the same `pinScrypt` at the same
cost, which has not itself been timed on the emulator. **Status of P2
(2026-10-20): not built; waiting on section 8.5.** Where the code departs from this section: `@scure/bip39`
does not export its `nfkd`, so `pin.ts` mirrors its rule (the same
well-formedness loop, then `normalize('NFKD')`) and the check pins the
equivalence through `mnemonicToSeedSync`; changing a passphrase (no
backup check) opens the recovery phrase with one device prompt so the
recovery-word rule can run; the near-copy rule also runs when a duress
passphrase is changed, because the app passphrase is typed first in that
flow; the field has no "Show" toggle; and the Settings notes of other
sections (auto-lock, screen protection, notifications) still say "app
PIN" while a passphrase is in use.

**Stage P1 — the lock passphrase (section 8.2). Smaller; lands first**,
after phase 22 item 2's native scrypt is in, since both go through
`pinScrypt`. Files: `pin.ts` (the kind, the version 2 record, the
canonical input, the rules), `LockGate.tsx` (the passphrase view beside
`PinPad`), the Settings flows (the choice, kind switching, the copy),
`duress.ts` (the copy per kind and the kind-neutral readiness reason).
Checks: `check-duress.mjs` per section 8.2.11; the offline runner.

**Stage P2 — the passphrase decoy (section 8.3). Only after the
Chairperson answers questions 1 to 3 of section 8.5.** Files: the BIP-39
vectors in `packages/core`; a seed-backed root per profile in `storage.ts`;
derivation and signing from a seed in `WalletContext.tsx`; the set-up
step; `store-keys.ts` (the new key). Checks: `check-duress.mjs` per
section 8.3.8 and `check-storage-seam.mjs` for the new key.

**The emulator pass, for each stage**, in the wallet's own development
build on a THROWAWAY wallet only (section 6.7; the standing rule never to
set an app PIN on the emulator's real wallet applies equally to a
passphrase):

- P1: choose a passphrase; the refusals (14 characters, a trailing space, a
  line break, three words of the throwaway's phrase, a near copy for the
  duress passphrase); a cold start shows the text field, not the pad;
  no keyboard suggestions and no autofill offer on the field; a screencap
  of the lock screen is empty and the window carries the secure flag;
  TalkBack does not speak the characters; five wrong passphrases start the
  30-second wait; the duress passphrase opens the second wallet, whose
  Settings show "App passphrase" and no duress passphrase; switching
  between PIN and passphrase from the real wallet rewrites both slots; the
  secure-store listing (names and lengths only) shows the same record
  length for both kinds; "Remove wallet" clears both; the time of one
  unlock with the native scrypt, recorded.
- P2: set up with a BIP-39 passphrase; the first address shown matches,
  off the device, the first account of `mnemonicToSeed(throwaway phrase,
  passphrase)`; the reveal screen under the second wallet shows the
  sentence and no phrase; a debug build's key-name log shows no read of
  the real phrase while the second wallet is open; changing the duress
  secret keeps the same second wallet; removing and re-adding with the
  same passphrase shows the same address, and with one character changed
  a different one.

### 8.5 Open questions for the Chairperson

1. **The passphrase decoy's reveal screen** (section 8.3.4): accept that
   the second wallet cannot show a recovery phrase of its own, or build
   Ledger's orientation — a hidden main wallet behind a long passphrase,
   which means moving existing funds — instead, or both?
2. **A separate BIP-39 passphrase (B1) rather than the duress secret
   (B2)** (section 8.3.3)?
3. **Printable ASCII and at most 50 characters** for the BIP-39 passphrase,
   so it can be typed on other wallets and Trezor Model One (section
   8.3.3)?
4. **A minimum of 15 characters** for the lock passphrase, NIST's
   single-factor floor, instead of section 7.6's 12 (section 8.2.2)?
5. **Autofill and password managers switched off** for the lock
   passphrase, against NIST's "SHALL allow" (section 8.2.8)?
6. **A third "could not be completed" action** in the second wallet's
   Settings, switching between PIN and passphrase (section 8.2.7; it
   joins the question of section 7.9)?
7. **A generated passphrase suggestion**: the app ships only the BIP-39
   English wordlist, and suggesting lock passphrases made of those words
   invites confusion with the recovery phrase; a dice-style list would be a
   new asset. Offer one, or advice only (section 8.2.9)?
8. **The thresholds** of the recovery-word rule (three words) and the
   near-copy rule (four edits, eight shared characters) (section 8.2.4).

### 8.6 Sources read for this section

All on 2026-10-19.

- BIP-39: <https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki>,
  read as the raw file at `0d1b892ddb21c22def4af4541bfed7a2a3480e4a`
  (sha256 `afcbcbed36fe9eb734bd607398a8c124683ded2a75c3830e1b16c47b043a9134`).
- BIP-85: the raw file at `6209768676bf85d7ef5ffb4055543d6286d79b96`
  (sha256 `dcbeb977…d1cf7e`, as recorded in `bip85.ts`).
- Trezor knowledge base, "What is a passphrase?":
  <https://trezor.io/learn/a/passphrases-and-hidden-wallets>.
- NIST SP 800-63B-4: <https://pages.nist.gov/800-63-4/sp800-63b.html>.
- Installed packages: `@scure/bip39` 2.4.0, `@noble/hashes` 2.4.0,
  `react-native` 0.86.3 (`TextInput.d.ts`, `ReactTextInputManager.kt`).
- This repository at `64d2a51`: `app/src/wallet/pin.ts`,
  `app/src/wallet/duress.ts`, `app/src/wallet/WalletContext.tsx`,
  `app/src/wallet/storage.ts`, `app/src/wallet/accounts.ts`,
  `app/src/components/LockGate.tsx`, `app/src/screens/ImportKeyScreen.tsx`,
  `packages/core/src/bip85.ts`, `packages/core/src/keyring/mnemonic.ts`,
  `packages/core/src/keyring/keyring.ts`,
  `packages/core/test/chains.test.ts`.
- The Node measurements of section 8.1.

---

## 9. Sources

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
