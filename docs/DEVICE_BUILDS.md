# Physical-Device Builds

First written for phase 5 item 6; revised 2026-10-02 for phase 9 item 3.
The end-to-end build, submission and update procedure now lives in
`docs/RELEASE.md`; this document covers what a build on a real phone is
for, what to test on it, and the platform facts behind those tests.

Everything phone-only in the validation record (real Secure
Enclave/StrongBox key storage, Face ID through expo-local-authentication
and the protected phrase class, real camera optics, passkeys, and the
release-only behaviour a store build must show) needs a development,
preview or store build rather than Expo Go.

## What exists

- `app/eas.json` with five build profiles, checked against the EAS
  documentation (docs.expo.dev/eas/json) and validated offline with EAS
  CLI's own `@expo/eas-json` library on 2026-10-02 (details in
  `docs/RELEASE.md` section 4):
  - `base`: pins Node 24.21.0; not built on its own.
  - `development`: development client, internal distribution. Android
    APK for phones and emulators; iOS build for registered iPhones.
  - `development-simulator`: the same for the iOS Simulator (no Apple
    account needed).
  - `preview`: release mode without developer tools, internal
    distribution, Android as an APK.
  - `production`: store builds (Android App Bundle, iOS archive) with
    remote build-number management.
- `app/app.json` audited for device and store builds (`docs/RELEASE.md`
  section 3): the expo-secure-store and expo-local-authentication plugins
  write a plain `NSFaceIDUsageDescription`; expo-camera keeps its QR-only
  `NSCameraUsageDescription` and no longer requests the microphone;
  `android.allowBackup` is `false`; unused storage and audio permissions
  are blocked.

## What is still missing before the first build

1. An Expo account, the iOS bundle identifier and the Android package
   name (inputs from the Chairperson; `docs/RELEASE.md` section 2).
2. `expo-dev-client`, which the development profiles require
   (`npx expo install expo-dev-client` in `app/`).
3. A post-install hook that builds the engine packages on EAS servers,
   because their `dist/` folders are not committed (`docs/RELEASE.md`
   section 2, step 3).
4. For iOS device builds, a paid Apple Developer Program membership
   (enrolled as an organization, which Apple requires of wallet apps) and
   each test iPhone registered with `npx eas-cli@latest device:create`.

An Android development build can also be made locally without any account
(`npx expo run:android --device` after installing `expo-dev-client`;
docs.expo.dev/develop/development-builds/introduction), which this machine
can do with the Android SDK installed for the emulator work.

## What to re-validate on the first device builds

In priority order. The W-numbers are the mainnet-readiness conditions in
`docs/THREAT_MODEL.md` section 5.

On a **development** build (real phones, iOS and Android):

1. **W2, biometric prompts.** Face ID / fingerprint on the seed reveal,
   send confirm, WalletConnect approvals and auto-lock unlock, and the OS
   passcode fallback (expo-local-authentication with
   `disableDeviceFallback: false`). On iOS, check that the Face ID prompt
   shows the `NSFaceIDUsageDescription` text from `app/app.json`.
2. **The protected phrase class on iOS** (never run anywhere yet): Settings
   → Recovery phrase protection → Protect with biometrics; one prompt per
   reveal and per approval; then re-enrol Face ID on a throwaway wallet
   and confirm the app shows the unreadable-phrase message rather than "no
   wallet" (`docs/THREAT_MODEL.md` 3.2.4–3.2.5).
3. **W3, secure storage on real hardware.** Persistence across restarts and
   updates; whether keys are StrongBox- or TEE-backed on Android cannot be
   read from the app itself, so record the phone model and Android
   version and treat hardware backing as unverified unless a platform tool
   shows it.
4. **Camera:** scanning paper and on-screen QR codes with real optics, a
   wrong-chain QR (must show the normal validation error), and pairing
   with a real dApp's WalletConnect QR.
5. **Passkeys:** the checklist in the Passkeys section below (needs the
   rpId domain).

On a **preview** build (release mode; the closest thing to a store build
that can be installed directly):

6. **W4, release-only behaviour.** No LogBox toasts, no dev menu on shake,
   no Metro connection; the app starts without a dev server. Screen
   capture blocking per the next section, on both platforms.
7. **W18, Android backup.** With `android:allowBackup="false"`, run the
   cloud-backup and device-to-device tests from
   developer.android.com/identity/data/testingbackup and confirm that
   neither the secure-store entries nor AsyncStorage (contacts, endpoint
   keys) are carried to the restored install.
8. **W19, still open:** the Import screen (where the phrase is typed) has
   no capture block, and there is no app-switcher privacy cover (findings
   N-04, N-05). These need app changes before they can be re-validated.

## Screenshot and screen-recording blocking in release builds

The app blocks capture on the two screens that display the recovery
phrase: `app/src/screens/BackupScreen.tsx` calls
`usePreventScreenCapture()` for as long as the screen is mounted, and
`app/src/screens/SettingsScreen.tsx` calls
`preventScreenCaptureAsync('seed-reveal')` while the revealed phrase is
shown and `allowScreenCaptureAsync('seed-reveal')` when it is hidden or
the screen unmounts. Both screens render the phrase inline, not in a
React Native `Modal` (which on Android would be a separate window).
Facts below are from the installed `expo-screen-capture` 57.0.3 sources
and the SDK 57 documentation
(docs.expo.dev/versions/v57.0.0/sdk/screen-capture).

**Release builds behave the same as Expo Go and development builds.**
Neither native implementation checks the build type (no debug or
`BuildConfig` branches in `ScreenCaptureModule.kt` or
`ScreenCaptureModule.swift`), and no config plugin is involved. The
Android behaviour was proven in Expo Go on the emulator (`AGENTS.md`,
third emulator pass: `adb screencap` returned an empty file while the
phrase was shown). Seeing it in a release build on real phones is still
what W4 asks for.

**Android: what is prevented.** `preventScreenCapture` adds
`WindowManager.LayoutParams.FLAG_SECURE` to the current activity's window,
and `allowScreenCapture` clears it. While the flag is set, the window's
contents are excluded from screenshots and screen recordings, including
recordings by other apps through the `android.media.projection` API that
the Expo docs mention, and, per the Expo docs, "app switcher protection
is automatically provided by `preventScreenCaptureAsync()` using the
FLAG_SECURE window flag, which shows a blank screen in the recent apps
preview". The flag applies to the whole activity window, so while it is
set the entire app (not only the phrase) is protected.

**Android: what is not prevented.** A second camera pointed at the
screen; malware with root access; and, by our reading, accessibility
services, which read the view hierarchy rather than the window's pixels
(not tested). Other windows (system dialogs, any React Native `Modal`)
do not inherit the flag. The flag is removed as soon as the screen hides
the phrase.

**iOS: what is done.** The Expo docs state: "On iOS, this prevents screen
recordings and screenshots, and is only available on iOS 11+ (recordings)
and iOS 13+ (screenshots)." In the source:

- *Screenshots:* the module moves the key window's layer inside the layer
  of a `UITextField` with `isSecureTextEntry = true`. iOS leaves
  secure-text-entry content out of screenshots, so the screenshot shows a
  blank area instead of the phrase. This relies on how UIKit renders
  secure text fields, not on an Apple API for blocking screenshots (there
  is none), so a future iOS version could change it.
- *Recordings and mirroring:* if `UIScreen.main.isCaptured` is true when
  blocking starts, or becomes true later
  (`UIScreen.capturedDidChangeNotification`), the module places an opaque
  black view over the window's first subview, and removes it when capture
  stops.

**iOS: what is not prevented.** The user is not stopped from taking the
screenshot; it simply does not contain the protected content. The
app-switcher snapshot is **not** covered: on iOS that needs the separate
`enableAppSwitcherProtectionAsync()`, which the app never calls (finding
N-05). Content presented in a different window would not be covered (not
checked). A second camera, and a jailbroken device, are out of reach of
any app.

**How to test on devices** (from the Expo page): on the Android Emulator,
`adb shell input keyevent 120` triggers a screenshot; on the iOS
Simulator, Device → Trigger Screenshot. On real phones, take a screenshot
and start a screen recording while the Backup screen and the Settings
reveal are visible, then check the saved images and video, and check the
app-switcher preview on both platforms.

**Nothing on iOS has been observed yet**, in any build type.

### App-wide protection (phase 17)

Since phase 17 the whole app is protected by default, not only the
phrase screens: `app/src/wallet/screen-protection.ts` calls
`preventScreenCaptureAsync('app-wide')` at launch (and, on iOS,
`enableAppSwitcherProtectionAsync(1.0)`, which blurs the app-switcher
preview) while Settings → Privacy → "Hide in the app switcher and block
screenshots" is on. The key is distinct from the phrase screens' keys,
and the library releases the flag only when no key is held
(`node_modules/expo-screen-capture/src/ScreenCapture.ts` lines 63-72), so
turning the setting off never unprotects an open phrase screen. On
Android every screenshot, recording and recent-apps thumbnail of the
wallet is therefore blank while the setting is on: to capture anything
for a test report, turn it off before taking screenshots or recordings,
and turn it back on afterwards. React Native 0.86.3 copies the flag onto
a `Modal`'s dialog window when the dialog is created
(`ReactModalHostView.kt` lines 334-341), which corrects the statement
above that a `Modal` does not inherit it; system dialogs still do not.

## Passkeys (phase 8, item 3)

The passkey signer uses the native module `react-native-passkeys` 0.4.2
(an Expo module; README at
https://github.com/peterferguson/react-native-passkeys, installed with
`npx expo install react-native-passkeys`). Expo Go does not contain it,
so passkeys work only in a development (or store) build. The app loads
the module lazily (`app/src/wallet/passkey-native.ts`) and shows "needs a
development build with a configured rpId" everywhere until both
conditions hold.

### One-time setup: the relying-party domain (rpId)

A passkey is bound to a domain that the app must prove it is associated
with. No domain has been chosen yet; the repository ships the reserved
placeholder `passkey-domain-not-configured.invalid` (RFC 2606 `.invalid`
never resolves), and the feature refuses to run while it is set.

1. Choose a domain the Chairperson controls (for example a subdomain of
   the product site). Put it in `app/src/config/passkey.ts`
   (`PASSKEY_RP_ID`) and replace the placeholder in `app/app.json`
   (`ios.associatedDomains`: `"webcredentials:<domain>"`).
   `app/scripts/check-passkeys.mjs` fails if the two disagree.
2. iOS: host `https://<domain>/.well-known/apple-app-site-association`
   (HTTPS, JSON, no `.json` extension) containing
   `{"webcredentials":{"apps":["<Apple Team ID>.<iOS bundle identifier>"]}}`.
   The app does not yet set `ios.bundleIdentifier` in `app.json`; EAS asks
   for one on the first iOS build, and the same value goes into this file.
3. Android: host `https://<domain>/.well-known/assetlinks.json` granting
   the Android package name and the SHA-256 fingerprint of the signing
   certificate (EAS shows it under the project's Android credentials) the
   relations `delegate_permission/common.handle_all_urls` and
   `delegate_permission/common.get_login_creds`. Serve it with
   `Content-Type: application/json`, status 200 and no redirect
   (developer.android.com/identity/credential-manager/prerequisites).
   Android caches the file for up to a day; reinstall the app after
   changing it. That page also describes an `asset_statements` manifest
   entry for sharing credentials between an app and a website; whether
   passkeys alone need it is not verified, and the app does not add it.
4. Make a new development build (the associated-domains entitlement and
   the native module are compiled in). The identifiers in steps 2 and 3
   are the same inputs `docs/RELEASE.md` section 2 asks for.

Platform minimums: Expo SDK 57 already requires iOS 16.4 and compiles
Android against SDK 36 (docs.expo.dev/versions/v57.0.0), above the
library's iOS 15 / compileSdk 34 requirements; the library reports
passkeys as unsupported below Android API level 28.

### Device checklist (nothing below has run on a real device yet)

Use Sepolia test mode, a ZeroDev bundler URL and a Kernel v3.3 account
that is already deployed and holds a little test ETH.

1. In Expo Go: Home shows the Passkey link for the deployed Kernel
   account; the screen shows the development-build note and no Add or
   Test button. Settings → Passkey shows the same note.
2. In the development build with the rpId still the placeholder: the same
   note appears (the gate is the rpId, not only the binary).
3. With the domain configured: Add passkey shows the platform sheet for
   the domain; after Face ID / fingerprint the confirm screen shows the
   public key, credential id, validator address and "P-256 precompile";
   approving runs the app's biometric gate and the owner-signed install.
   Record the userOpHash and the bundle transaction.
4. Status reads "Installed"; Home shows "Passkey ✓".
5. Test passkey: the confirm screen shows a 0-ETH call to the owner
   address and the fee; the platform passkey prompt appears at
   submission; the operation is included. This is the first live check
   of: the platform's clientDataJSON field order (type first, challenge
   at offset 23 — the engine refuses anything else before submission),
   the real clientDataJSON length against the gas padding, and the
   bundler accepting a passkey-validated operation through the
   precompile.
6. Send ETH with "Send from smart account" and "Sign with passkey": the
   confirm screen names the passkey as signer; the same smart account
   sends; included.
7. WalletConnect: connect a dApp as the smart account, request a
   personal_sign, choose "This phone's passkey", and check the dApp
   verifies the signature (ERC-1271 on the Kernel account).
8. Remove passkey: owner-signed; afterwards the status is "No passkey
   installed", the local details are gone, and the OS still lists the
   passkey (delete it in the system password manager).
9. Negative: cancel the passkey prompt (nothing is submitted); remove the
   passkey from the system password manager and try Test (plain "no
   matching passkey" message); on iOS repeat steps 3–5 to confirm the
   library's raw x||y public-key field matches the attestation key.

See also the device-only conditions W2–W4 and W18–W19 in docs/THREAT_MODEL.md section 5, which a development build is expected to re-validate.
