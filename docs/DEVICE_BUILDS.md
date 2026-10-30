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
2. For iOS device builds, a paid Apple Developer Program membership
   (enrolled as an organization, which Apple requires of wallet apps) and
   each test iPhone registered with `npx eas-cli@latest device:create`.

Two items once listed here are done: `expo-dev-client`, which the
development profiles require, and the `eas-build-post-install` hook in
`app/package.json`, which builds the engine packages on EAS servers because
their `dist/` folders are not committed, were both added in commit
`4bf76d2` (phase 9 item 3). No EAS build has been made yet.

An Android development build can also be made locally without any account
(`npx expo run:android --device` after installing `expo-dev-client`;
docs.expo.dev/develop/development-builds/introduction), which this machine
can do with the Android SDK installed for the emulator work.

### Rebuild after native configuration changes

A development build carries the native configuration it was built with;
reloading JavaScript from Metro does not change it. After a change to a
config plugin entry in `app/app.json` the build must be made again (the
SDK 57 notifications documentation: these settings "cannot be set at
runtime and require building a new app binary to take effect"). Locally,
run `npx expo prebuild --platform android --clean` and then
`npx expo run:android`: `run:android` generates the native project only
when the `android/` folder is missing (`@expo/cli` 57.0.28,
`build/src/run/ensureNativeProject.js`, `ensureNativeProjectAsync`), so a
folder left by an earlier build would otherwise keep the old
configuration.

The current case is the Android notification icon (phase 18 item 0,
`docs/RELEASE.md` section 3, "Notification icon"): the
`expo-notifications` entry now names `./assets/notification-icon.png` and
the tint `#a65d13`. The local debug development build made in phase 17
predates it and keeps showing the launcher-icon placeholder in the status
bar until it is rebuilt. What only a rebuilt build can confirm:

- the merged manifest carries the meta-data
  `expo.modules.notifications.default_notification_icon` →
  `@drawable/notification_icon` and
  `expo.modules.notifications.default_notification_color` →
  `@color/notification_icon_color`, and `res/drawable-*/notification_icon.png`
  exists at 24, 36, 48, 72 and 96 px;
- a reminder shows the white Shiba head in the status bar and in the
  shade, with `#a65d13` used as the notification's colour wherever the
  Android version applies one (the exact rendering depends on the Android
  version and is not verified), in light and dark mode;
- nothing else in the reminders changed (channels, sound, the tap into
  Sessions).

`app/scripts/check-notifications.mjs` checks the entry and the image
offline; `npx expo config --type introspect` shows the plugin's effect on
the generated manifest without a prebuild.

### Lazy bundling and the development client

When Metro serves the app, Expo's development server asks Metro for a
lazily bundled app by default: the bundle URL it hands to the app carries
`lazy` set to the opposite of `EXPO_NO_METRO_LAZY`, whatever the mode
(`@expo/cli` 57.0.28, `build/src/start/server/middleware/ManifestMiddleware.js`,
`_getBundleUrl`; the variable is read in `build/src/utils/env.js`). A
module the wallet loads with a dynamic `import()` is then fetched from
Metro as a separate chunk when it is first needed. Bundles made by
`expo export` and by a release build are not lazy
(`build/src/start/server/metro/MetroBundlerDevServer.js` sets `lazy: false`
on its export paths).

What the emulator passes established (phase 21, passes p21f and p21g):

- Metro keeps lazy bundling both for the wallet's development client and
  for a production-mode bundle served by the development server.
- In the development client, the lazily loaded WalletConnect chunk failed
  with "Requiring unknown module" (for example "1892"), followed by
  "Cannot set property 'importedAll' of undefined", so Settings →
  Connected apps did not open.
- A production-mode bundle served by Metro failed every lazily loaded
  module with "Unable to determine the production URL…", which broke
  WalletConnect and the screen-protection setting's own message.
- Starting Metro with lazy bundling switched off made the development
  client load one bundle (2,392 modules on 2026-10-18), and Settings →
  Connected apps then opened normally, with no "Requiring unknown module"
  error:

  ```sh
  EXPO_NO_METRO_LAZY=1 CI=1 npx expo start --port 8082 --dev-client
  ```

- A release APK embeds one bundle that is not lazy, so it is not affected.

In pass p23-build (the phase 23 release-candidate development client,
Metro started with `EXPO_NO_METRO_LAZY=1`, one bundle of 2,446 modules)
Connected apps opened in both wallets of a duress set-up, and no
"Requiring unknown module", "importedAll" or "Unable to determine the
production URL" line appeared in logcat or Metro's log. Not yet tested: a
real WalletConnect pairing in the development client with lazy bundling
switched off. Expo Go also loads a lazily bundled app
from Metro, and Connected apps opened in it in earlier passes (phase 16);
why only the development client failed was not established.

### The release-candidate configuration (phase 23 item 2)

Three native configuration changes landed together, so every development
or release build made before them must be rebuilt (see "Rebuild after
native configuration changes" above); Expo Go carries none of the first
two. `docs/RELEASE.md` section 3 has the sources for each.

- **The link scheme.** `app/app.json` declares `"scheme": "shibawallet"`.
  Prebuild adds it to the main activity's VIEW intent filter on Android
  and to `CFBundleURLTypes` on iOS (seen in a local `expo prebuild
  --platform android` and in `npx expo config --type introspect` on
  2026-10-27). A custom scheme is not verified: Android lets any app
  register an intent filter for the same scheme
  (developer.android.com/privacy-and-security/risks/unsafe-use-of-deeplinks,
  fetched 2026-10-27), so a `shibawallet://` link may open another app,
  and the wallet treats every link as untrusted input. Verified Android
  App Links and iOS universal links need an `https` domain the wallet
  controls: an input, not done.
- **The launcher-badge permissions.** The wallet's own config plugin
  `app/plugins/withoutShortcutBadger.js` writes
  `<uses-permission … tools:node="remove"/>` for the sixteen permissions
  that ShortcutBadger 1.1.22 (pulled in by `expo-notifications`) declares.
- **The navigation bar.** `expo-navigation-bar` 57.0.3 is a new native
  dependency. `App.tsx`'s `NavigationBarStyle` sets the bar's button style
  from the colour scheme at launch and on every scheme change, through
  `app/src/wallet/navigation-bar.ts` (Android only; nothing happens when
  the module is missing; a failure is one log line). The package cannot
  set a background colour (removed in its 56.0.0); the bar stays
  transparent. Whether Expo Go carries the module: the cached Expo Go
  57.0.9 APK in `~/.expo/android-apk-cache` contains the class
  `expo.modules.navigationbar.NavigationBarModule` (read from its dex
  files on 2026-10-27), but whether the Expo Go on the emulator is that
  APK, and whether its module answers `setStyle`, is not verified; the
  guard makes either answer safe.
- **The wallet's own navigation-bar module (pass p23-navbar).** Pass
  p23-navbar established why `setStyle` alone does not make the buttons
  follow a theme change while the app runs: on API 30-34 it writes only
  the deprecated `SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR` view flag
  (androidx.core 1.18.0 `WindowInsetsControllerCompat` Impl30 when built
  with a window), and Android ignores that flag once React Native's
  `StatusBar` has set the window's appearance through
  `WindowInsetsController.setSystemBarsAppearance` (the window is then
  `APPEARANCE_CONTROLLED`). The app therefore carries a small local Expo
  module, `app/modules/shiba-navigation-bar` (JavaScript name
  `ShibaNavigationBar`, Android only, no dependency of its own), which
  Expo autolinking picks up from the app's `modules` folder (its default
  `nativeModulesDir`, `expo-modules-autolinking` 57.0.14
  `build/commands/autolinkingOptions.js` lines 166-175). Its one function,
  `setNavigationBarAppearance(light)`, calls `setSystemBarsAppearance`
  for the navigation-bar bit alone on API 31 and up (React Native's own
  switch point for its status bar, `WindowUtil.kt` line 101) and writes
  the deprecated flag on API 26-30, on the main thread.
  `navigation-bar.ts` uses it when the build has it and falls back to
  `expo-navigation-bar`'s `setStyle` otherwise; Expo Go cannot carry a
  local module, so in Expo Go the old behaviour remains and
  `expo-navigation-bar` stays a dependency for that. Settings → Developer
  names the path that ran ("set through the platform API", "set through
  the compat flag", or `setStyle(…)` of `expo-navigation-bar`). A local
  module needs a rebuilt development or release build; `expo prebuild`
  links it like any other Expo module.

What the next build must verify (none of it can be seen without one):

1. The MERGED manifest of a debug and a release APK (`aapt2 dump
   permissions` and `aapt2 dump xmltree --file AndroidManifest.xml`):
   none of the sixteen badge permissions remains, no other permission was
   removed by mistake (compare with the 31 / 32 entries of the kept
   APKs), and the main activity's VIEW intent filter carries
   `shibawallet`.
2. A deep link in the development build:
   `adb shell am start -a android.intent.action.VIEW -d "shibawallet://inbox"`
   opens the Inbox (and the other routes and refusals of
   `deep-links.ts`), including a link held behind the lock and a launch
   link after a force-stop; whether Android shows a chooser when another
   app claims the scheme.
3. The navigation bar on screen: with the system switched to dark mode
   while the app runs (`adb shell cmd uimode night yes`), the white strip
   under the TESTNET banner (pass p20c finding 15) turns dark, in
   gesture and in three-button navigation, in both directions, and no
   "Navigation bar style not applied" line appears in logcat. If the strip
   stays light, the next option is the library's `enforceContrast: false`
   plugin option (the bar then draws no scrim at all, so content and the
   buttons share the bar area): a decision, not taken here.
4. Reminders still work after the badge permissions are gone (a reminder
   posts and a tap opens Sessions).

**What the build showed (pass p23-build, 2026-10-27 to 2026-10-28 local
dates; `AGENTS.md` phase 23, item 2 build half).** The debug development
client and the release APK were built from commit `4e34507` (whose code
is `a71ef32`) in an APFS-clone worktree, with Gradle run only while the
emulator was closed; their files, sizes and digests are in
`docs/RELEASE.md` section 11.1.

1. Manifests: exactly the sixteen badge permissions are gone from both
   merged manifests (debug 32 → 16 `uses-permission` entries, release
   31 → 15), nothing else changed, and the main activity's VIEW intent
   filter carries `shibawallet` beside `exp+shiba-wallet`.
2. Deep links, in the debug development build on a throwaway wallet:
   `pm query-activities` resolved `shibawallet://` to the wallet's main
   activity alone (Expo Go does not claim it); the inbox, home, Activity
   for Bitcoin, Receive for Solana, price-alerts and sessions routes each
   opened their screen; a Send link carrying an EIP-681 request opened
   Send with the outside-link sentence first and nothing sent; an unknown
   route and a route with an extra parameter were refused; a link sent
   after 75 seconds in the background showed only the lock and acted once
   after Unlock. A launch link after a force-stop was first caught by the
   development launcher's "DEVELOPMENT SERVERS" screen (development builds
   only) and, once the server was chosen, opened its screen once behind
   the cold-start lock. Whether Android shows a chooser when another app
   claims the scheme was not tested (no other app claims it on this
   emulator).
3. The navigation bar: the white strip is gone in light and dark mode
   and in gesture and three-button navigation (pixel reads at the bottom
   rows); but the buttons' appearance did not follow a theme change made
   while the app was running (it kept the appearance of the theme the app
   started in, while the status bar followed), with no "Navigation bar
   style not applied" line in logcat. Pass p23-navbar later established
   the cause (the bullet on the wallet's own navigation-bar module above),
   and the local module is the fix. Once, right after
   switching to three-button navigation while the app ran, the home button
   overlapped the banner's last line until the insets were laid out again
   (not seen after a cold start).
4. Reminders, on Base Sepolia: the system permission prompt, the
   `payments-due` (importance 3) and `security-alerts` (importance 4)
   channels, and a recurring-payment reminder posted within 69 seconds on
   `payments-due` with icon `drawable/notification_icon` — the wallet's
   Shiba head on the `#a65d13` circle, the phase 18 icon seen in the shade
   for the first time — whose tap opened Sessions after the unlock.

The same pass restored a records backup after a wipe, exported the duress
decoy's own records only, and opened Connected apps in both wallets with
lazy bundling off (`docs/FEATURE_UNIVERSE.md` rows 47 and 53); it found
that "Wipe wallet" keeps the contacts (`docs/THREAT_MODEL.md` F-85, fix in
progress).

### The emulator and the build environment: facts from pass p23-build

These concern the Android emulator on the development Mac (emulator
37.1.11) and the local build route, not the app; they are recorded here
because every emulator result in this document depends on them
(`AGENTS.md` phase 23, item 2 build half).

- **The renderer flag is rejected.** The project's launch command passes
  `-gpu angle_indirect`. Emulator 37.1.11 logs "Selected GPU option
  'angle_indirect' is not valid, switching to 'auto' mode." on every
  launch, so the ANGLE renderer the command names has never been
  applied; 'auto' resolved to the host renderer on one launch and to
  SwiftShader-on-ANGLE ("swangle") on the next. The emulator window the
  Chairperson confirmed visible on 2026-10-14 was therefore drawn by
  whatever 'auto' chose that day.
- **The quick-boot snapshot loads only under the renderer it was saved
  with.** A relaunch logged "Change of GLES renderer detected… Failed to
  load snapshot 'default_boot'… Reason: different renderer configured"
  and cold-booted. Naming a renderer explicitly would make the save and
  the load agree, but the host renderer and SwiftShader both gave a black
  window on the developer's Mac on 2026-10-14, so which one to pin is the
  Chairperson's decision.
- **The shutdown wait.** Closing the emulator window is a graceful
  shutdown, but the launcher kills the emulator after 20 seconds by
  default; one snapshot save took longer ("Saving snapshot 'default_boot'
  using 20030 ms", then killed) and left a truncated snapshot. The
  variable that changes the wait, `ANDROID_EMULATOR_WAIT_TIME_BEFORE_KILL`,
  is named in no documentation found — not `emulator -help-environment`,
  not `emulator -help-all`, no Google page in a web search — only in the
  emulator's own message, found with `strings` in the launcher binary:
  "Wait for emulator (pid %d) %d seconds to shutdown gracefully before
  kill;you can set environment variable
  ANDROID_EMULATOR_WAIT_TIME_BEFORE_KILL(in seconds) to change the default
  value (%d seconds)". Which process reads it is inferred (the launcher,
  the parent of the emulator process). Set to 120 in the launching shell,
  the close logged the 120-second wait and then "Saving snapshot
  'default_boot' using 7969 ms" with no kill, and the snapshot files were
  complete.
- **The bundle step passes in a cloned worktree.** The offline runner
  with the `expo export` bundle step (`node scripts/ci/run.mjs --mode
  offline`, without `--skip-bundle`) passed in an APFS-clone worktree in
  497 seconds (one bundle of 10.9 MB, 2,318 modules). The 2026-10-18
  failure ("Unable to resolve module expo") belonged to the older
  worktrees made of symlinks into the main checkout, which are no longer
  used.
- **Gradle and the emulator.** Gradle ran only while the emulator was
  closed, and `./gradlew --stop` left no Java process before the
  emulator was driven again (a Gradle build beside a driven emulator
  once got the emulator's system server killed by its watchdog, phase
  16).
- **The git-ignored secrets folder.** A symbolic link named `.dev-wallet`
  inside a worktree is NOT matched by the `.dev-wallet/` ignore pattern
  (`git check-ignore` prints nothing for it); never link that folder into
  a worktree.

### The native scrypt for the app PIN (phase 22 item 2)

On the Chairperson's decision of 2026-10-19 (`docs/THREAT_MODEL.md` F-81),
the app PIN's scrypt runs natively wherever the app binary allows it. Three
native packages were added to `app/package.json` for this:

- `react-native-quick-crypto` 1.1.8 (MIT), pinned to exactly that version
  because the wallet calls its native `Scrypt` object directly
  (`app/src/wallet/pin-native-scrypt.ts`);
- `react-native-nitro-modules` 0.37.1 (MIT), the native runtime it is built
  on;
- `react-native-quick-base64` 3.0.1 (MIT), a required peer of the first.

`npx expo install` also added the library's config plugin,
`"react-native-quick-crypto"`, to `app/app.json`. With its default options
it changes only the iOS project (it raises the iOS deployment target to
16.4 wherever it is lower); the optional libsodium support stays off.

What this means for builds:

- Any development, preview or store build made before this change does not
  contain the native scrypt. It must be rebuilt (`npx expo prebuild
  --platform android --clean`, then the build), as for any other native
  change (see "Rebuild after native configuration changes" above).
- Building fetches a prebuilt OpenSSL: on Android the Maven artefact
  `io.github.ronickg:openssl-static` 3.6.2-3, named in the library's
  `android/build.gradle`; on iOS a prebuilt OpenSSL 3.6.2 archive that the
  library's podspec downloads from its GitHub releases at `pod install`
  time and checks against a pinned SHA-256. These are build-time downloads
  only; the library makes no network request when the app runs.
- Expo Go does not contain these modules. There the wallet keeps the
  JavaScript scrypt of `@noble/hashes`, with the cost measured in phase 21
  (about 100 seconds per unlock in the emulator's release build, and more
  in Expo Go's development bundle). Both paths give the same bytes, so a PIN
  set in one build opens in the other.
- Settings → Developer (test networks only) shows which path the running
  build uses: "PIN hashing path: native scrypt (react-native-quick-crypto),
  self-check passed", or the JavaScript path with its reason. The self-check
  hashes a test vector of RFC 7914 once per session before the native path
  is trusted. The PIN hashing cost measurement on the same screen times
  whichever path is in use and names it in its platform line.

Done on the Android emulator on 2026-10-19 UTC (`AGENTS.md`, phase 22,
"EMULATOR PASS p22a"): a rebuilt debug development build and a release
build with these modules (kept in the git-ignored `.local/builds/` folder
as `shiba-devclient-b414989-qc-debug.apk` and
`shiba-release-8b4ed84-qc.apk`; the release build adds no Android
permission compared with the one before it) both loaded the module and
passed the self-check; one hash at N = 2^16 took about 1.0 to 1.1 seconds
in the release build (0.6 to 1.7 seconds in debug), and one unlock about
2.5 seconds in both. Not yet done: a measurement on a phone, and any iOS
build (the library's podspec download has never run).

### An iOS Simulator build on this Mac (phase 23 item 3)

The first iOS build of the wallet was made on 2026-10-25 for the iOS
Simulator, from commit f4b9339, on the Intel Mac that also runs the
Android emulator (macOS 26.7.1, Xcode 26.5 build 17F42). No Apple account,
no paid membership and no administrator password were needed. A simulator
build is not a device build: it says nothing about the Secure Enclave,
real Face ID, VoiceOver or App Store signing (see "What it does not prove"
below).

**Toolchain, once per Mac.**

1. The iOS simulator runtime, without opening Xcode. Apple documents the
   command in "Downloading and installing additional Xcode components"
   (developer.apple.com/documentation/xcode, read 2026-10-25):
   `xcodebuild -downloadPlatform iOS`. On this Intel Mac it downloaded the
   universal "iOS 26.5 Simulator (23F77)", 10.6 GB, in about 10 minutes,
   and installed it with no login. `xcrun simctl list runtimes` then lists
   `com.apple.CoreSimulator.SimRuntime.iOS-26-5`.
2. CocoaPods. Expo's own installer (`@expo/package-manager`,
   CocoaPodsPackageManager.js) tries `gem install cocoapods` and then
   `sudo gem install`, which needs an administrator password with the
   system Ruby; it falls back to Homebrew. Homebrew under /usr/local is
   owned by the user here, so `brew install cocoapods` needs no password.
   It installed CocoaPods 1.17.0 at /usr/local/bin/pod, but took 2 hours
   11 minutes: macOS 26 on an Intel Mac is a Homebrew "Tier 3"
   configuration, and llvm, rust and z3 were compiled from source as
   dependencies. Homebrew's rustc, cargo and ruby are now on the PATH
   ahead of a rustup toolchain in some shells.

**Each build.**

1. A worktree with APFS clones of both node_modules:
   `.local/helpers/mkwt.sh wt-ios <commit>` (it also builds the engine).
2. In `wt-ios/app`: `CI=1 npx expo prebuild --platform ios --no-install`.
   Because `app/app.json` has no `ios.bundleIdentifier`, prebuild picks
   `com.anonymous.shiba-wallet` and writes it into the worktree's app.json
   (and adds an Android permissions list and the `run:` scripts to
   package.json). Do not commit those worktree edits.
3. In `wt-ios/app/ios`: `LANG=en_US.UTF-8 pod install` (about 1.5 minutes,
   117 pods). react-native-quick-crypto downloads its prebuilt OpenSSL
   3.6.2 here and refuses it unless its SHA-256 equals the value pinned
   in QuickCrypto.podspec (a50e3c84…d3a4; checked independently on
   2026-10-25). The archive carries an `ios-arm64_x86_64-simulator`
   slice. React Native core and Hermes come as checksum-verified
   prebuilt archives from Maven Central.
4. Build with Xcode directly, not `expo run:ios`, so Metro stays off 8081:

   ```
   xcodebuild -workspace ShibaWallet.xcworkspace -scheme ShibaWallet \
     -configuration Debug -sdk iphonesimulator \
     -destination 'id=<simulator udid>' \
     -derivedDataPath <scratch>/dd RCT_METRO_PORT=8083 build
   ```

   The first build took 17 minutes and succeeded with no configuration
   change (about 1,200 warnings from third-party code, none from a
   missing privacy manifest). The app is signed ad hoc for the
   simulator; on an Intel Mac it is built for x86_64 only.
5. A simulator, the app and Metro:
   `xcrun simctl create shiba-ios com.apple.CoreSimulator.SimDeviceType.iPhone-17 com.apple.CoreSimulator.SimRuntime.iOS-26-5`,
   `xcrun simctl boot <udid>`, `open -a Simulator`,
   `xcrun simctl install <udid> <dd>/Build/Products/Debug-iphonesimulator/ShibaWallet.app`;
   in `wt-ios/app`: `EXPO_NO_METRO_LAZY=1 CI=1 npx expo start --port 8083 --dev-client`;
   then open the development client on that Metro:
   `xcrun simctl openurl <udid> "exp+shiba-wallet://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8083"`
   (iOS asks "Open in “Shiba Wallet”?" the first time).

**What the generated project contains.** Deployment target iOS 16.4;
URL schemes `com.anonymous.shiba-wallet` and `exp+shiba-wallet` only (no
`shibawallet` until app.json declares it); the Face ID and camera usage
strings from app.json; a local-network usage string and a Bonjour entry
from the development client; the entitlements `aps-environment`
(development, added by expo-notifications' plugin) and the placeholder
passkey associated domain; an aggregated PrivacyInfo.xcprivacy (no
tracking, no collected data; accessed-API reasons for file timestamps,
user defaults and system boot time).

**What the first simulator pass showed (throwaway wallet only).**

- The keychain-backed store works: a new wallet's phrase is written as
  `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` items in the app's
  access group and read back intact; "Protect with biometrics" moves it to
  an access-controlled item; the wallet's "Wipe" removes every item.
- **The simulator does not enforce the biometric access control on a
  keychain item.** The protected phrase was read, and the app unlocked,
  with no Face ID prompt at all. A real iPhone is needed to test the
  protected class (Apple's developer forums thread 733588 reports the
  same simulator behaviour; Apple's documentation does not state it).
- Face ID itself works through Simulator → Features → Face ID →
  Enrolled / Matching Face. One attempt, where the matching face was
  sent about five seconds after the prompt appeared, ended "Authentication
  failed (unknown: -1000, Authentication failure.)"; sent within about a
  second, it succeeded (the cause of the failure was not established).
- Screenshots through iOS itself (Simulator → Device → Trigger
  Screenshot) come out black on the Backup screen and on the lock screen;
  `xcrun simctl io <udid> screenshot` reads the simulator's frame buffer
  and is NOT blocked, so it is not a test of the protection.
- The app-switcher cover blurs the app in the app switcher and whenever
  a system sheet (Face ID, "Open in…") covers it.
- The launch lock, the background lock, the passphrase lock screen and
  the native scrypt ("PIN hashing path: native scrypt
  (react-native-quick-crypto), self-check passed"; one hash at N = 2^16
  in 0.47–0.70 s in the debug build) all work.
- VoiceOver is not available in the iOS 26.5 Simulator (Settings →
  Accessibility lists no VoiceOver); Accessibility Inspector is the
  substitute and needs a person at the Mac.

**What it does not prove.** Anything about the Secure Enclave, real Face
ID, the biometric access control on the keychain, VoiceOver, an arm64
build, push or App Store signing; those need an iPhone and an Apple
Developer membership (see "What is still missing before the first
build").

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
8. **W19:** the app changes it waited for exist since commit `6e1106f`
   (phase 17): the Import screen and the backup quiz hold their own capture
   keys, and app-wide screen protection (on by default) blanks the Android
   app-switcher thumbnail and adds a cover on iOS (findings N-04, N-05). On
   a preview build, confirm both on Android and, for the first time, on
   iOS.

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
