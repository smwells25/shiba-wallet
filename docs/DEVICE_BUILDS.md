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
