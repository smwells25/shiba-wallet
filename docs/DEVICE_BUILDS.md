# Physical-Device Builds (Phase 5, Item 6)

Everything phone-only in the validation record — real Secure
Enclave/StrongBox key storage, FaceID via expo-local-authentication,
real camera optics, and store submission — needs a development build of
the app rather than Expo Go. The configuration for that is now in
place; the only missing ingredient is an Expo account login.

## What exists

- `app/eas.json` with three profiles per the EAS documentation
  (docs.expo.dev/eas/json, verified 2026-09-28):
  `development` (developmentClient, internal distribution — installs on
  a registered device with the dev server), `preview` (internal
  shareable build), `production` (store build).
- `app/app.json` already carries the native configuration a build needs:
  the expo-secure-store plugin, and expo-camera with the plain-language
  NSCameraUsageDescription rationale (which replaces Expo Go's own
  permission string on device builds).

## What a human must do (one-time)

1. Create or use an Expo account and log in: `npx eas-cli@latest login`.
2. From `app/`: `npx eas-cli@latest build --profile development
   --platform ios` (or `android`). iOS device builds additionally need an
   Apple Developer account for signing; EAS walks through credentials
   interactively.
3. Install the produced build on the phone, run `npx expo start` from
   `app/`, and scan the dev-server QR from the build.

## What to re-validate on the first device build

In priority order, from the recorded emulator-validation gaps:
FaceID prompt behavior on the seed reveal, send confirm, and auto-lock
unlock (the OS passcode fallback matrix); StrongBox/Secure Enclave
key storage (expo-secure-store WHEN_UNLOCKED_THIS_DEVICE_ONLY on real
hardware); camera scanning with real optics against paper and screen
QRs; WalletConnect pairing by scanning a real dApp's QR (the paste path
is already live-proven); and the release-mode absence of dev-only
behaviors (LogBox, the EXPO_NO_METRO_LAZY dev-server workaround).

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
   the native module are compiled in).

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
