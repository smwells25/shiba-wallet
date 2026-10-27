# Release Procedure

Status: written 2026-10-02 for phase 9 item 3. No build has been made
with EAS yet: there is no Expo account, no bundle identifier and no
Android package name. Everything that does not need those inputs is in
place; this document lists exactly what remains and the commands that
follow once the inputs arrive.

All Expo and EAS statements below were checked on 2026-10-02 against the
Markdown versions of the pages cited (docs.expo.dev serves each page as
`<url>.md`; the index is https://docs.expo.dev/llms.txt). EAS CLI was at
version 24.10.0 on npm that day. Re-read the cited page before acting on
anything here if time has passed.

Related documents: `docs/DEVICE_BUILDS.md` (what to test on a phone,
passkey domain setup, screenshot blocking), `docs/STORE_LISTING.md`
(listing text, store policies, privacy answers), `docs/PRIVACY.md` (the
user-facing privacy notice), `docs/THREAT_MODEL.md` section 5 (mainnet
readiness conditions C1–C3 and W1–W20).

---

## 1. What is ready and what is not

| Item | State |
|---|---|
| `app/eas.json` | Four build profiles and one submit profile, validated offline against EAS CLI's own schema (section 4) |
| `app/app.json` | Audited for store readiness (section 3): Android backup off, unused permissions blocked, Face ID and camera texts set. Identifiers deliberately absent |
| `expo-dev-client` | **Not installed.** Required by the `development` profiles (section 2, step 2) |
| Engine build on EAS servers | **Not wired.** The engine packages' `dist/` folders are git-ignored, so a cloud build needs a hook that builds them (section 2, step 3) |
| Expo account, identifiers, Apple and Google accounts | **Inputs needed** (section 2, step 1) |
| Over-the-air updates (`expo-updates`) | **Not installed, deliberately.** A security decision (section 8) |
| Splash screen | `app/assets/splash-icon.png` exists but nothing uses it: SDK 57 configures the splash screen through the `expo-splash-screen` plugin, which is not installed (docs.expo.dev/versions/v57.0.0/sdk/splash-screen). Without it, release builds show the platform default |

---

## 2. One-time setup, in order

### Step 1. Inputs from the Chairperson

| Input | Used for | Where it goes |
|---|---|---|
| Expo account (an organization account is recommended so the project is not tied to one person) | Every EAS command | `npx eas-cli@latest login`; `eas init` ("Create or link an EAS project", EAS CLI reference) links the project and may write `extra.eas.projectId` into the app config, so review the diff; optionally `expo.owner` in `app/app.json` ("The name of the Expo account that owns the project", app config reference) |
| iOS bundle identifier, for example `com.<company>.<app>` | iOS builds and App Store | `expo.ios.bundleIdentifier` in `app/app.json` (docs: "You make it up, but it needs to be unique on the App Store") |
| Android package name | Android builds and Google Play | `expo.android.package` (docs: "may only contain lowercase and uppercase letters (a-z, A-Z), numbers (0-9) and underscores (_), separated by periods (.). Each component of the name should start with a lowercase letter") |
| Apple Developer Program membership, **enrolled as an organization** | iOS device builds, TestFlight, App Store. Apple guideline 3.1.5(i) allows wallet apps only from organization accounts (`docs/STORE_LISTING.md` 2.1). The internal-distribution page: ad hoc provisioning "requires a paid Apple Developer account" | EAS prompts for the Apple ID on the first iOS build |
| Apple Team ID and the App Store Connect app id | Non-interactive iOS submission | `submit.production.ios.appleTeamId` and `ascAppId` in `app/eas.json` (eas.json reference). Left out for now: EAS prompts interactively |
| Google Play developer account (organization), the app created in Play Console, and a Google Service Account key uploaded to EAS | Android submission | Uploaded with `eas credentials --platform android` or the EAS dashboard (docs.expo.dev/submit/android) |
| Passkey relying-party domain, with the two `.well-known` files hosted | Passkeys only | `docs/DEVICE_BUILDS.md`, "Passkeys" |
| Privacy policy URL and support URL | Both stores | `docs/STORE_LISTING.md` section 1 |
| Export-compliance answer for encryption | Every App Store submission | Section 6 |
| A real website for the WalletConnect metadata | dApps display it as the wallet's identity | `app/src/wallet/walletconnect.ts` currently uses the placeholder `https://shiba-wallet.example` |

### Step 2. Install the development client

The eas.json reference says of `developmentClient: true`: "For the build to
be successful, the project must have `expo-dev-client` installed and
configured." It is not in `app/package.json` today. From `app/`:

```sh
npx expo install expo-dev-client
```

This changes `app/package.json` and the lockfile, so it was not done as
part of this document's change (only configuration and docs were in
scope). Expo Go is unaffected.

### Step 3. Build the engine on EAS servers

The app depends on the engine through `file:` dependencies
(`app/package.json`: `"@shiba-wallet/core": "file:../packages/core"` and
four others), and each engine package's entry point is `dist/index.js`,
which `.gitignore` excludes. CI handles this by running `npm ci` at the
repository root and building the engine before bundling
(`.github/workflows/ci.yml`, `scripts/ci/run.mjs`). An EAS build must do
the same. Expo's monorepo page (docs.expo.dev/build-reference/build-with-monorepos)
says: run EAS commands from the app directory, and "If your project needs
additional setup beyond what is provided, add a `postinstall` step to
**package.json** in your project that builds all necessary dependencies in
other workspaces." EAS also provides a dedicated hook,
`eas-build-post-install`, which runs after `npm install` (and on iOS after
`pod install`) (docs.expo.dev/build-reference/npm-hooks). Proposed
addition to `app/package.json` `scripts`:

```json
"eas-build-post-install": "cd .. && npm ci --ignore-scripts && npm run build"
```

Why this exact command: it is the CI sequence (root `npm ci
--ignore-scripts`, then the root `build` script, which builds
`@shiba-wallet/core` first and then the other packages). Metro then finds
the engine's own dependencies in the root `node_modules`, as
`app/metro.config.js` already arranges.

**Unverified until the first cloud build:** that the EAS upload contains
the repository root and `packages/` (the monorepo page implies it, since
it tells apps to build "other workspaces"), and that the hook runs before
the JavaScript bundle is created. The first build log answers both.

Secret hygiene for uploads: EAS uses `.gitignore` to decide what not to
upload unless an `.easignore` exists (docs.expo.dev/build-reference/easignore).
The root `.gitignore` excludes `.dev-wallet/` (the development seed and
API keys) and `dist/`; do not add an `.easignore` without copying those
lines into it.

### Step 4. Link the project and set identifiers

```sh
cd app
npx eas-cli@latest login
npx eas-cli@latest init            # creates or links the EAS project
# then edit app.json: expo.ios.bundleIdentifier, expo.android.package
npx expo config --type public      # must still succeed
```

Run `npm test` from the repository root afterwards; `check-passkeys.mjs`
reads `app/app.json`.

---

## 3. The `app/app.json` audit

Checked against docs.expo.dev/versions/v57.0.0/config/app and the
installed config plugins; the resolved result was inspected with `npx
expo config --type introspect`, which applies every plugin and prints the
generated Info.plist, entitlements and AndroidManifest.

| Field | Value | Evidence and reasoning |
|---|---|---|
| `version` | `0.1.0` | User-facing version: `CFBundleShortVersionString` on iOS, `versionName` on Android (app config reference). Raise by hand for each store release (section 7) |
| `ios.buildNumber`, `android.versionCode` | Not set | Managed remotely by EAS (`cli.appVersionSource: "remote"`); the app-versions page says the local values are then ignored and "You can safely remove these values from your app config" |
| `runtimeVersion` | Not set | Only meaningful with `expo-updates`, which is not installed (section 8). `eas update:configure` writes it when updates are adopted (docs.expo.dev/eas-update/getting-started) |
| `icon`, `android.adaptiveIcon.*`, `web.favicon` | Files present | `app/assets/icon.png`, `android-icon-foreground.png`, `android-icon-background.png`, `android-icon-monochrome.png`, `favicon.png` all exist. Final artwork is a design input |
| Splash | Not configured | See section 1 |
| `android.allowBackup` | **`false`** (new) | See below |
| `android.blockedPermissions` | **`RECORD_AUDIO`, `READ_MEDIA_IMAGES`, `READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE`** (new) | See below |
| `expo-camera` plugin | `cameraPermission` text kept; **`microphonePermission: false`, `recordAudioAndroid: false`** (new) | The app only scans QR codes. The plugin's types allow `string \| false`; `false` deletes `NSMicrophoneUsageDescription` (`@expo/config-plugins` `applyPermissions`: `if (permissions[permission] === false) delete infoPlist[permission]`), and `recordAudioAndroid` defaults to `true` (camera docs, config plugin table). Introspection confirms no microphone string |
| `expo-secure-store` plugin | **`faceIDPermission`** set (new) | Writes `NSFaceIDUsageDescription` (securestore docs, plugin table). Needed for `requireAuthentication` on iOS (the protected phrase class) |
| `expo-local-authentication` plugin | Listed explicitly with the same `faceIDPermission` (new) | The plugin also writes `NSFaceIDUsageDescription` and adds `USE_BIOMETRIC` and `USE_FINGERPRINT`. It was already applied automatically as a "legacy" plugin (`@expo/prebuild-config` `withDefaultPlugins.js` `legacyExpoPlugins`), but with Expo's default text; listing it makes the text explicit and identical. Docs: without `NSFaceIDUsageDescription`, "the module will authenticate using device passcode" |
| `expo-notifications` plugin | **`icon: ./assets/notification-icon.png`, `color: #a65d13`** (phase 18) | The Android notification small icon and tint for the local reminders; see "Notification icon" below. The plugin also sets the iOS `aps-environment` entitlement, which it already did automatically before the entry was listed (accepted by the Chairperson on 2026-10-11) |
| `scheme` | **`shibawallet`** (phase 23 item 2) | The custom URL scheme that `app/src/wallet/deep-links.ts` reads (`APP_LINK_SCHEME`). See "The app scheme" below |
| `./plugins/withoutShortcutBadger` plugin | Listed last in `expo.plugins` (phase 23 item 2) | The wallet's own config plugin; removes the sixteen launcher-badge permissions that ShortcutBadger adds. See "Launcher-badge permissions removed" below |
| `ios.associatedDomains` | `webcredentials:passkey-domain-not-configured.invalid` (unchanged) | Placeholder for passkeys, as recorded in `AGENTS.md` and `docs/DEVICE_BUILDS.md`. Note: the v57 app-config page documents entries in the `applinks:` form; the `webcredentials:` form comes from the passkey library's README |
| `ios.supportsTablet` | `true` (unchanged) | A product decision: if it stays `true` the app is offered on iPad, and the iPad layout and screenshots must be checked |
| `ios.config.usesNonExemptEncryption` | Not set | Section 6 |
| `expo.owner`, `ios.bundleIdentifier`, `android.package` | Not set | Inputs (section 2) |

Resulting permissions (from introspection on 2026-10-02): iOS Info.plist
usage strings `NSCameraUsageDescription` and `NSFaceIDUsageDescription`
only; Android main manifest `INTERNET`, `SYSTEM_ALERT_WINDOW` and
`VIBRATE` (both from Expo's manifest template), `USE_BIOMETRIC`,
`USE_FINGERPRINT`, `CAMERA`, plus the four `tools:node="remove"` entries
for the blocked permissions. Library manifests merged at build time add
`ACCESS_NETWORK_STATE` and `ACCESS_WIFI_STATE` (NetInfo) and
`DETECT_SCREEN_CAPTURE` (expo-screen-capture, Android 14+). The final merged
manifest should be read from the first build (`aapt dump permissions` or
Play Console's App bundle explorer).

**Android backup.** The app config reference says `allowBackup` "Defaults
to the Android default, which is `true`", and the installed plugin agrees
(`@expo/config-plugins` 57.0.9, `build/android/AllowBackup.js`:
`config.android?.allowBackup ?? true`). The threat model asked whether
backups would include AsyncStorage, which holds users' API keys and
endpoint URLs (`docs/THREAT_MODEL.md` 3.4, finding N-08, condition W18).
Findings:

- `expo-secure-store` 57.0.4's plugin adds `fullBackupContent` and
  `dataExtractionRules` files that include the `sharedpref` domain and
  exclude its `SecureStore` file. Android's documentation says: "If you
  specify an `<include>` element, the system no longer includes any files by
  default and backs up only the files specified"
  (developer.android.com/identity/data/autobackup). AsyncStorage 2.2.0
  stores its data in the SQLite database `RKStorage` (database domain), so
  under those rules it should already be excluded.
- The same Android page also says that for apps targeting Android 12 or
  higher, "On devices from some device manufacturers, specifying
  `android:allowBackup="false"` disables cloud-based backup and restore
  (such as Google Drive backups) but doesn't disable device-to-device
  transfers for the app." Device-to-device transfers then follow the
  `device-transfer` rules above.
- Decision: `allowBackup` is set to `false` so cloud backup is off
  regardless of how the rules are read, and the secure-store rules still
  apply to device-to-device transfers. Introspection shows the generated
  manifest carries `android:allowBackup="false"` together with both rule
  files. Consequence for users: contacts, endpoint settings, API keys and
  smart-account recovery records do not move to a new phone through
  Android backup; the wallet is restored from the recovery phrase, and
  recovery records must be exported by hand (`docs/PRIVACY.md` 3.3).
- W18 can move to Met only after a device test with Android's backup
  test procedure (developer.android.com/identity/data/testingbackup, which
  covers both cloud backup with `adb shell bmgr backupnow` and the
  device-to-device test mode `backup_enable_d2d_test_mode`).

**Notification icon (done in phase 18 item 0; the push entitlement
accepted).** The local reminders (phase 17 item 2) used to show a
placeholder in the status bar: with no icon configured, the library falls
back to the app's launcher icon (`expo-notifications` 57.0.22,
`android/src/main/java/expo/modules/notifications/notifications/presentation/builders/ExpoNotificationBuilder.kt`
lines 342–362: the manifest meta-data
`expo.modules.notifications.default_notification_icon` if present, else
`context.applicationInfo.icon`), and Android draws a small icon only from
its transparency, so the full-colour launcher square became a plain shape
(seen as a ring on the emulator on 2026-10-10). On 2026-10-11 the
Chairperson decided to add the icon through the `expo-notifications`
config plugin and to accept the iOS push entitlement that comes with it.
The entry in `expo.plugins` in `app/app.json` is:

```json
[
  "expo-notifications",
  {
    "icon": "./assets/notification-icon.png",
    "color": "#a65d13"
  }
]
```

- **The artwork.** `app/assets/notification-icon.png` is a 96 × 96 PNG,
  every pixel white with only the alpha channel varying: a Shiba Inu head
  seen from the front (a wide face, two upright pointed ears with a V
  notch between them, a pointed ruff on each cheek) with transparent
  cut-outs for the two eyes and the nose, inside an 8-pixel transparent
  border (2 dp at the 24 dp icon size). It is drawn from source by
  `app/scripts/make-notification-icon.mjs` (run it from `app/` to
  regenerate the file; no design tool or download is involved), and
  `app/scripts/check-notifications.mjs` checks that the checked-in file is
  exactly what that script draws, that it is 96 × 96, and that every
  pixel is white. Final store artwork remains a design input; replacing
  the drawing in the script and re-running it is enough.
- **`icon`.** Documentation (docs.expo.dev/versions/v57.0.0/sdk/notifications,
  "Configurable properties", Android only): "Local path to an image to use
  as the icon for push notifications. 96x96 all-white png with
  transparency", and under "Custom notification icon and colors": "the
  icon must be all white with a transparent background" (otherwise "it may
  not be displayed as intended"). The installed plugin
  (`plugin/src/withNotificationsAndroid.ts`) resizes the image with
  `resizeMode: 'cover'` on a transparent background (lines 175–206) into
  `android/app/src/main/res/drawable-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/notification_icon.png`
  at 24 px times the density scale — 24, 36, 48, 72 and 96 px (lines
  20–27 and 33) — and adds two `<meta-data>` entries pointing at
  `@drawable/notification_icon` (lines 124–136):
  `expo.modules.notifications.default_notification_icon`, which local
  notifications read, and `com.google.firebase.messaging.default_notification_icon`,
  which only Firebase push messages would read. The plugin's own resizer
  (`@expo/image-utils` `generateImageAsync`, run on 2026-10-11 with the
  arguments the plugin passes) kept every one of the five sizes pure white.
- **`color`.** Documentation: "Tint color for the push notification image
  when it appears in the notification tray", default `#ffffff`, Android
  only. The plugin writes it to `res/values/colors.xml` as
  `notification_icon_color` (lines 66–75 and 98–106) and adds the
  meta-data `expo.modules.notifications.default_notification_color` and
  `com.google.firebase.messaging.default_notification_color` pointing at
  `@color/notification_icon_color` (lines 141–153). The library applies it
  to every notification that does not carry its own colour
  (`ExpoNotificationBuilder.kt` lines 364–396 and 111); the wallet's
  reminders carry none. The value `#a65d13` is the light theme's accent
  (`app/src/theme-palette.ts`, `lightTheme.accent`), the app's orange
  darkened for contrast in phase 11.
- **Left unset, on purpose.** `defaultChannel` is the "Default channel for
  FCMv1 notifications" (documentation); the plugin writes it only as
  `com.google.firebase.messaging.default_notification_channel_id` (lines
  159–171), which concerns Firebase push messages, and the reminders name
  their own channels. `sounds` copies sound files into `res/raw` (Android,
  lines 221–259) and into the Xcode project (iOS,
  `withNotificationsIOS.ts` lines 62–113); the reminders use the system
  sound. `enableBackgroundRemoteNotifications` (iOS, default `false`) adds
  `remote-notification` to `UIBackgroundModes` (lines 32–60), which only a
  push service would need. `mode` (iOS, in the plugin's types,
  `plugin/src/withNotifications.ts` lines 31–36, but not in the v57
  documentation table) is left at its default. `check-notifications.mjs`
  pins that the entry carries exactly `icon` and `color`.
- **The iOS push entitlement (accepted).** `withNotificationsIOS.ts`
  lines 20–25 set `aps-environment` in the app's entitlements to `mode`
  (default `development`) when the entitlements do not already have one.
  The documentation adds: "The iOS APNs entitlement is always set to
  'development'. Xcode automatically changes this to 'production' in the
  archive generated by a release build." The wallet uses no push
  notifications. FINDING (2026-10-11): the entitlement was already present
  before this entry was added. `@expo/prebuild-config` 57.0.17 applies
  `expo-notifications`' own plugin automatically, with no properties,
  whenever the package is installed (`build/plugins/withDefaultPlugins.js`
  line 171, `versionedExpoSDKPackages`, applied from
  `build/getPrebuildConfig.js` line 56 through
  `build/plugins/unversioned/createLegacyPlugin.js`), and
  `npx expo config --type introspect` on the previous `app.json` already
  showed `"aps-environment": "development"`. The explicit entry therefore
  adds only the Android icon and colour; it does not change the iOS
  entitlements. The Chairperson accepted the entitlement on 2026-10-11;
  Firebase Cloud Messaging is noted as the likely longer-term push option
  (feature 93 in full). An App Store reviewer may ask why a wallet without
  push carries the entitlement; the answer is the library's plugin, and
  the alternative (a custom plugin that removes it) is not built.
- **A new native build is needed** (the icon and colour are Android
  resources and manifest entries); Expo Go cannot show them, and the
  existing local development build keeps showing the placeholder until it
  is rebuilt (`docs/DEVICE_BUILDS.md`, "Rebuild after native
  configuration changes").

**Local reminders: what the notification library adds to the Android
manifest.** Seen in the merged manifest of the local debug development
build of 2026-10-10 (made from commit ccead60; `AGENTS.md`, phase 17,
"LOCAL REMINDERS PROVEN LIVE IN THE WALLET'S OWN DEVELOPMENT BUILD"):

- From `expo-notifications`' own manifest (`android/src/main/AndroidManifest.xml`
  in 57.0.22): the permissions `POST_NOTIFICATIONS` and
  `RECEIVE_BOOT_COMPLETED`; the non-exported receiver `NotificationsService`
  (its own event, `BOOT_COMPLETED`, `REBOOT`, the two `QUICKBOOT_POWERON`
  actions and `MY_PACKAGE_REPLACED`, which re-arm scheduled reminders); the
  non-exported `NotificationForwarderActivity`; and the non-exported
  `ExpoFirebaseMessagingService`.
- From the Firebase Cloud Messaging library that `expo-notifications`
  depends on (`android/build.gradle`: `com.google.firebase:firebase-messaging:25.0.1`),
  merged in although the wallet sends and receives no push messages: the
  permissions `WAKE_LOCK` and `com.google.android.c2dm.permission.RECEIVE`;
  an EXPORTED receiver `FirebaseInstanceIdReceiver`
  guarded by the permission `com.google.android.c2dm.permission.SEND`;
  the service `FirebaseMessagingService`;
  Firebase's component registrars; and the content provider
  `FirebaseInitProvider`, which runs at every app start.
- At every start logcat showed "Default FirebaseApp failed to initialize
  because no default options were found". The app ships no
  `google-services.json`, so Firebase has no project to start with.

**The two Firebase questions, answered from the library code (phase 18
item 3, 2026-10-11).** Read from the Android archives that the development
builds of phases 16 and 17 downloaded into their Gradle cache:
`firebase-messaging-25.0.1.aar`, `firebase-common-22.0.1.aar`,
`firebase-installations-18.0.0.aar`, `firebase-datatransport-18.2.0.aar`
and `firebase-iid-interop-17.1.0.aar` (their `AndroidManifest.xml` files,
and their classes disassembled with `javap` from JDK 17.0.20.1), plus
`expo-notifications` 57.0.22's own Kotlin sources.

1. *What `FirebaseInstanceIdReceiver` does, and who can address it.* It is
   declared in `firebase-messaging`'s manifest as an exported receiver for
   the action `com.google.android.c2dm.intent.RECEIVE`, with
   `android:permission="com.google.android.c2dm.permission.SEND"`. The class
   extends Google Play services' `CloudMessagingReceiver`; its
   `onMessageReceive` hands the broadcast to `FcmBroadcastProcessor.process`,
   which starts the app's `com.google.firebase.MESSAGING_EVENT` service (here
   `ExpoFirebaseMessagingService`), and its `onNotificationDismissed` can log a
   dismissal for Firebase's analytics (`MessagingAnalytics`) when the
   message asked for it. In other words it is the entry point
   for Firebase push messages that Google Play services delivers. The
   permission is NOT declared in any of these manifests (they only use it),
   so its protection level is set by the app that declares it. Google's
   documentation for the earlier `GoogleCloudMessaging` API said: "The
   `com.google.android.c2dm.permission.SEND` permission is held by Google
   Play services. This prevents other code from invoking the broadcast
   receiver." (the `GoogleCloudMessaging` class reference, read 2026-10-11
   through a copy of developer.android.com kept at
   spot.pcc.edu/~mgoodman/developer.android.com/reference/com/google/android/gms/gcm/GoogleCloudMessaging.html,
   because the original page is no longer published; its "Implementing GCM
   Client" page in the same copy says the receiver should require the
   permission "so that only the GCM Framework can send a message to it").
   A third-party package index (sysapps.bayton.org, "com.google.android.gsf",
   synced 2026-10-11) lists the permission among those DECLARED by the Google
   Services Framework package but shows no protection level. **Still
   unverified:** the protection level itself (that it is a signature-level
   permission, so that no ordinary app can hold it). It can be read on any
   Android phone or emulator with Google Play services, for example with
   `adb shell pm list permissions -f | grep -A 5 c2dm.permission.SEND` or
   `adb shell dumpsys package com.google.android.gsf`; it was not read here
   because the emulator is reserved for another agent.
2. *Does unconfigured Firebase make any network call?* Not from the code
   paths this app reaches. `FirebaseInitProvider.onCreate` (the content
   provider that runs at every start) only calls
   `FirebaseApp.initializeApp(Context)` and logs "FirebaseApp initialization
   unsuccessful" when that returns null. `initializeApp(Context)` calls
   `FirebaseOptions.fromResource`, which reads the string resource
   `google_app_id` and returns null when it is empty or absent;
   `initializeApp` then logs "Default FirebaseApp failed to initialize
   because no default options were found. This usually means that
   com.google.gms:google-services was not applied to your gradle project."
   (the line seen in logcat) and returns null without constructing a
   `FirebaseApp`. Firebase's components (installations, messaging, the data
   transport) are created only by the `FirebaseApp` constructor's component
   runtime (`ComponentDiscovery.forContext(…, ComponentDiscoveryService)` →
   `ComponentRuntime.builder`), and `FirebaseMessaging.getInstance()` starts
   with `FirebaseApp.getInstance()`, which throws when no app exists. The
   app has no `google-services.json` and `app.json` sets no
   `googleServicesFile`, so nothing generates `google_app_id`. In
   `expo-notifications`, the only callers of `FirebaseMessaging.getInstance()`
   are `getDevicePushTokenAsync` / `unregisterForNotificationsAsync`
   (`tokens/PushTokenModule.kt` 54–98, through `getFirebaseMessagingInstance` at line 87) and the topic functions
   (`topics/TopicSubscriptionModule.kt` 22, 40); the wallet calls none of
   them (it imports only the scheduling, permission, presented-notification
   and handler files, `app/src/wallet/notifications.ts`). Without a
   registration token no server can address a push message to this app, so
   the receiver above has nothing to receive. **Still unverified:** a
   network capture of a fresh install, which would also cover anything the
   other bundled Google components do (ML Kit and data transport from
   `expo-camera`, section 10). Google Play services itself is a separate app
   whose own traffic is outside the wallet.

Removing the Firebase parts with `tools:node="remove"` was not tried: the
library's own `ExpoFirebaseMessagingService` extends Firebase's
`FirebaseMessagingService` (`ExpoFirebaseMessagingService.kt:7`), so a
removal would need a build and a reminders test on a device first. These entries also matter
for the store data-safety answers (`docs/PRIVACY.md` 2.8).

**Blocked permissions.** `expo-screen-capture` 57.0.3's library manifest
requests `READ_EXTERNAL_STORAGE` (up to API 32) and `READ_MEDIA_IMAGES`
(API 33) for its screenshot listener; the Expo docs warn that
`READ_MEDIA_IMAGES` "can be added only for apps needing broad access to
photos" under Google Play's Photo and Video Permissions policy. The app
never registers a screenshot listener (it only calls
`usePreventScreenCapture` and `preventScreenCaptureAsync`), and the
listener code checks the permission and only logs when it is missing
(`ScreenShotEventEmitter.kt`), so blocking is safe. `DETECT_SCREEN_CAPTURE`
is **not** blocked: on Android 14+ the module registers its
`ScreenCaptureCallback` when it is created, and that API needs the
permission. `expo-file-system` requests `READ/WRITE_EXTERNAL_STORAGE` up
to API 32; the app writes only to its cache directory and shares through
the system share sheet (`app/src/components/RecordFileActions.tsx`), so
neither is needed. `RECORD_AUDIO` is removed for the reason in the table.
The docs note `blockedPermissions` is "Not available in Expo Go", which
is irrelevant there. `SYSTEM_ALERT_WINDOW` (from Expo's template) was left
alone: the app does not use it, but whether removing it affects the
development client's tools was not checked.

**The app scheme (phase 23 item 2; approved with the phase 23 plan).**
`app/app.json` declares `"scheme": "shibawallet"`. Expo's default config
plugins turn it into native configuration (both are applied by
`@expo/prebuild-config` 57.0.17, `build/plugins/withDefaultPlugins.js`,
lines 126 and 157):

- Android: `@expo/config-plugins` 57.0.10, `build/android/Scheme.js`,
  `setScheme` (lines 40-62) adds `<data android:scheme="shibawallet"/>` to
  every VIEW intent filter of the `singleTask` main activity
  (`appendScheme`, lines 160-187). A local `expo prebuild --platform
  android` on 2026-10-27 (worktree only, not committed) wrote exactly
  that: the main activity's VIEW / DEFAULT / BROWSABLE intent filter
  carries `shibawallet` and the development client's `exp+shiba-wallet`.
- iOS: `build/ios/Scheme.js`, `setScheme` (lines 33-48) writes a
  `CFBundleURLTypes` entry; `npx expo config --type introspect` shows
  `CFBundleURLSchemes: ['shibawallet', …]` beside `exp+shiba-wallet`.
  (Introspection fills a placeholder bundle identifier, which `setScheme`
  appends to the same list, lines 36-38; the real identifier is an input.)

`app/scripts/check-inbox.mjs` calls those plugin functions on the real
`app.json` and fails if the scheme is removed or renamed.

**The custom-scheme caveat.** A custom scheme is not owned by anyone:
Android's guidance says "By design, Android allows multiple apps to
register intent filters for the same deep link URI"
(developer.android.com/privacy-and-security/risks/unsafe-use-of-deeplinks,
fetched 2026-10-27), and links that are not verified "are subject to the
system disambiguation dialog" (developer.android.com/training/app-links,
fetched 2026-10-27). Another app can therefore receive a `shibawallet://`
link, and the wallet can receive one from anyone; `deep-links.ts` treats
every link as untrusted input (an allow list of screens, a payment request
only pre-fills Send, nothing is signed without review). Verified Android
App Links (and iOS universal links) need an `https` domain the wallet
controls, with its association file published there: an **input** (the
domain), not done.

**Launcher-badge permissions removed (phase 23 item 2).**
`expo-notifications` 57.0.22 depends on `me.leolin:ShortcutBadger:1.1.22`
(`android/build.gradle`, line 45) so it can draw an unread count on the
launcher icon; the wallet never sets one (`shouldSetBadge: false` and
`allowBadge: false` in `app/src/wallet/notifications.ts`). The library's
own `AndroidManifest.xml` (inside `ShortcutBadger-1.1.22.aar` in the
local Gradle cache, sha256 `cd1610dc…dad8c3`) declares **sixteen**
`<uses-permission>` entries (lines 19-50): Samsung
`com.sec.android.provider.badge.permission.READ` / `WRITE`, HTC
`com.htc.launcher.permission.READ_SETTINGS` / `UPDATE_SHORTCUT`, Sony
`com.sonyericsson.home.permission.BROADCAST_BADGE` and
`com.sonymobile.home.permission.PROVIDER_INSERT_BADGE`, Apex
`com.anddoes.launcher.permission.UPDATE_COUNT`, Solid
`com.majeur.launcher.permission.UPDATE_BADGE`, Huawei
`com.huawei.android.launcher.permission.CHANGE_BADGE` / `READ_SETTINGS` /
`WRITE_SETTINGS`, ZUK `android.permission.READ_APP_BADGE`, OPPO
`com.oppo.launcher.permission.READ_SETTINGS` / `WRITE_SETTINGS`, and
EverythingMe `me.everything.badger.permission.BADGE_COUNT_READ` /
`BADGE_COUNT_WRITE`. Its four `com.android.launcher.permission.*` lines
(12-15) are commented out. `aapt2 dump permissions` on all five kept
APKs in `.local/builds` (2026-10-27) lists exactly these sixteen. (This
corrects the earlier record of "twenty" in section 10 and in `AGENTS.md`,
phase 21.)

The wallet's own config plugin `app/plugins/withoutShortcutBadger.js`
(listed in `expo.plugins`) removes them from the merged manifest through
Expo's `AndroidConfig.Permissions.withBlockedPermissions`, which declares
the `tools` namespace (`build/android/Manifest.js`, `ensureToolsAvailable`,
line 224) and writes `<uses-permission android:name="…"
tools:node="remove"/>` for each name (`build/android/Permissions.js`,
lines 48 and 89-101). Android's manifest merger documents the marker:
"Remove this element from the merged manifest. Used when you discover an
element in your merged manifest that you don't need that was provided by a
lower-priority manifest file that's out of your control (such as an
imported library)", and "All markers belong to the Android tools
namespace, so you must first declare this namespace in the `<manifest>`
element" (developer.android.com/build/manage-manifests, fetched
2026-10-27). The local prebuild of 2026-10-27 wrote all sixteen remove
entries and the `xmlns:tools` declaration into
`android/app/src/main/AndroidManifest.xml`.
`app/scripts/check-notifications.mjs` pins the plugin entry, the sixteen
names and the plugin's manifest change. **Not verified without a Gradle
build:** that the MERGED manifest of a debug and a release build carries
none of the sixteen (`aapt2 dump permissions` on the new APK), and that
reminders still work.

**The navigation bar (phase 23 item 2; pass p20c finding 15).**
`expo-navigation-bar` 57.0.3 is a dependency (the version
`expo/bundledNativeModules.json` pins for SDK 57). Its 57 API has no
background-colour function: `setBackgroundColorAsync`,
`setButtonStyleAsync` and the `backgroundColor` plugin property were
removed in 56.0.0 (its `CHANGELOG.md`, lines 49-51); the bar stays
transparent, as React Native's edge-to-edge set-up makes it
(`react-native` 0.86.3, `ReactAndroid/.../views/view/WindowUtil.kt`,
`enableEdgeToEdge`, lines 164-190). What it can do is set the bar's
appearance (`NavigationBarModule.kt`, AsyncFunction `setStyle`, lines
126-133), which React Native sets only once, when the window is created.
`App.tsx` mounts `NavigationBarStyle` (beside the `StatusBar` component), which
calls it through `app/src/wallet/navigation-bar.ts` at launch and on every
colour-scheme change: Android only, nothing when the native module is
missing, any failure one log line. The library's own Android manifest is
empty (no permission), it depends only on `androidx.core` and
`androidx.appcompat`, and its sources make no network request. Its config
plugin is applied automatically by prebuild (`withDefaultPlugins.js` line
171) and changes nothing without options; the wallet sets none, so
`enforceNavigationBarContrast` keeps its default (on). **Not verified
without a device:** that the system's contrast scrim turns dark with the
dark appearance (the white strip of finding 15), and the button colour
(the library documents a visible effect only on a button navigation bar
with `enforceContrast: false`, `src/NavigationBar.types.ts` lines 34-42).

---

## 4. The `app/eas.json` profiles

Reference: docs.expo.dev/eas/json and docs.expo.dev/build/eas-json.

| Profile | What it produces | Distribution | Needs |
|---|---|---|---|
| `development` | Development build (`developmentClient: true`): Android APK built with `:app:assembleDebug`, iOS device build with `Debug` configuration (eas.json reference). Loads JavaScript from a Metro dev server | `internal` | Expo account; `expo-dev-client` installed. **iOS device:** paid Apple Developer account and each test iPhone registered with `eas device:create` (ad hoc provisioning, "at most 100 iPhones per year", internal-distribution page). Android: nothing else; the same APK runs on phones and emulators (APK page) |
| `development-simulator` | The same, for the iOS Simulator (`ios.simulator: true`) | `internal` | Expo account only. The simulators page: runs "without needing to deploy to TestFlight or even having an Apple Developer account". Android output is identical to `development`. Expo's eas-json page recommends exactly this separate profile when you want both device and simulator builds |
| `preview` | Release-mode build without developer tools, for testers. Android forced to an APK (`android.buildType: "apk"`) so it can be sideloaded | `internal` | Expo account; iOS needs the Apple account (ad hoc). This is the build that validates release-only behaviour (section 5) |
| `production` | Store build: Android App Bundle (`app-bundle`, required by Google Play for new apps per the Android submit page), iOS archive for App Store Connect. `autoIncrement: true` bumps `versionCode` / `buildNumber` remotely | `store` | Expo account, identifiers, Apple and Google developer accounts |

Common settings: every build profile extends a `base` profile that pins
`node` to `24.21.0`, the repository's Node version (`AGENTS.md`
toolchain; CI uses Node 24). Without it, EAS uses the image's Node: the
`sdk-57` images listed on docs.expo.dev/build-reference/infrastructure
ship Node 22.23.x. `AGENTS.md` records that npm 11 (Node 24) recreates the
`file:` symlinks correctly in CI, so matching it avoids an untested npm
version. `base` itself is not meant to be built.

`cli.appVersionSource: "remote"` is the recommended source "from EAS CLI
version 12.0.0" (app-versions page). `cli.version: ">= 19.1.0"` is the
version that introduced `--refresh-ad-hoc-provisioning-profile`
(internal-distribution page), used in section 5.

Submit profile `production`: Android uploads to the `internal` track with
`releaseStatus: "draft"`, so nothing reaches users without a person
promoting it in Play Console (eas.json reference: `track`,
`releaseStatus`; the Android submit page describes `draft` for "upload
without rolling out"). The iOS submit fields are left out; EAS prompts for
the Apple ID and creates or picks the App Store Connect app.

Validation: `eas config` (the documented way to print the resolved
configuration) requires a logged-in account ("An Expo user account is
required to proceed"), and `eas build` has no dry-run mode. Instead, the
file was validated with `@expo/eas-json` 24.9.0, the library EAS CLI
uses, by resolving every build profile for both platforms and the submit
profile (all resolved; a deliberately invalid `buildType` was rejected
with "eas.json is not valid", proving the check is real). Resolved values,
for example: `development` iOS = `{"distribution":"internal","node":"24.21.0","developmentClient":true,"simulator":false}`;
`production` Android = `{"distribution":"store","node":"24.21.0","autoIncrement":true,"buildType":"app-bundle"}`.

---

## 5. Commands, per profile

Run from `app/`. `npx eas-cli@latest` is the documented alternative to a
global install (EAS Update getting-started page).

```sh
# Development build on an Android phone or emulator (APK)
npx eas-cli@latest build --profile development --platform android

# Development build on a registered iPhone
npx eas-cli@latest device:create        # once per iPhone
npx eas-cli@latest build --profile development --platform ios

# Development build for the iOS Simulator, installed automatically
npx eas-cli@latest build --profile development-simulator --platform ios
npx eas-cli@latest build:run --platform ios --latest

# Then serve JavaScript to the development build
npx expo start

# Preview (release-mode) builds for testers
npx eas-cli@latest build --profile preview --platform all

# Production builds and submission
npx eas-cli@latest build --profile production --platform all
npx eas-cli@latest submit --platform android --profile production
npx eas-cli@latest submit --platform ios --profile production
# or in one step:
npx eas-cli@latest build --profile production --platform all --auto-submit
```

iOS ad hoc profiles do not pick up newly registered iPhones in
non-interactive builds unless `--refresh-ad-hoc-provisioning-profile` is
passed (internal-distribution page). Apple can take "up to 24–72 hours" to
process a newly registered device on a new membership (same page).

**Account-free path for an early device test.** The development-builds
introduction (docs.expo.dev/develop/development-builds/introduction)
describes building locally with `npx expo run:android` / `npx expo
run:ios` (add `--device` for a physical device): "No Expo account is
required and this is the only way to install a development build on an
iPhone without a paid Apple Developer account." This machine already has
the Android SDK and emulator from the phase-4 emulator work. It still needs
`expo-dev-client` installed and generates `app/android` / `app/ios`
(both git-ignored). Not run for this document.

---

## 6. iOS export compliance (encryption)

Apple's "Overview of export compliance" page
(developer.apple.com/help/app-store-connect/manage-app-information/overview-of-export-compliance)
lists apps that use "Standard encryption algorithms" and "Crypto
functionality within Apple's operating system" among those needing an
export-compliance determination, and states that the developer is
"responsible for all liabilities associated with misinterpretation of
export regulations or claiming exemption inaccurately". It also notes that
France controls "Secure Storage" applications. The wallet uses HTTPS,
digital signatures (secp256k1, ed25519, P-256 via WebAuthn), hashing, and
the platform keystores. The answer is a legal determination, not an
engineering one, so `ios.config.usesNonExemptEncryption` (which "Sets
`ITSAppUsesNonExemptEncryption`", app config reference) is deliberately
unset; App Store Connect will ask on each submission until counsel's
answer is recorded there.

---

## 7. Versioning rules

1. `expo.version` in `app/app.json` is the user-facing version. Change it
   by hand when starting a release that will go to the stores (app-versions
   page: "the user-facing version should be explicitly set and updated by
   you"). Use semantic versioning: patch for fixes, minor for features,
   major for anything that changes recovery or storage formats.
2. Build numbers (`android.versionCode`, `ios.buildNumber`) are owned by
   EAS (`appVersionSource: "remote"`) and incremented on every production
   build (`autoIncrement: true`). If builds were ever uploaded by another
   route, align EAS first with `npx eas-cli@latest build:version:set`.
3. Every store build is made from a commit on `main` whose CI run is green
   and whose `AGENTS.md` entry records the release; tag it
   `v<version>-<build>`.
4. Never reuse a version for different code; the app-versions page names
   duplicate build numbers as "One common cause for app store rejections".

---

## 8. Updates and rollback

### 8.1 Today: no over-the-air updates

`expo-updates` is not installed (`app/node_modules/expo-updates` is
absent; `expo` lists it only as a devDependency). Every change therefore
ships as a new store binary, and the rollback story is the stores' own:

- **Google Play:** submit with a staged rollout (`rollout`, "The initial
  fraction of users who are eligible to receive the release", with
  `releaseStatus: "inProgress"`), and stop a bad release with
  `releaseStatus: "halted"` (eas.json reference; the statuses link to
  Google's `edits.tracks` API documentation) or in Play Console. What a
  halt does for users who already updated was not checked for this
  document; plan on shipping a fixed build either way.
- **App Store:** a released binary cannot be withdrawn from devices that
  installed it; the fix is a new build through review. App Store Connect's
  phased-release option was not checked for this document.

### 8.2 If EAS Update is adopted later: a security decision first

An over-the-air update replaces the app's JavaScript, which is where
`signWith`, the confirmation screens and the recovery-phrase handling
live (`docs/THREAT_MODEL.md` 3.3). Whoever can publish an update to the
production channel can therefore change what the wallet signs. Before
adopting it:

- **Code signing:** "EAS Update Code Signing is only available to accounts
  subscribed to the EAS Production or Enterprise plans"
  (docs.expo.dev/eas-update/code-signing). With it, signatures are
  "verified on the client before the update is applied, which ensures
  ISPs, CDNs, cloud providers, and even EAS itself cannot tamper with
  updates". A wallet should not ship unsigned updates; budget for the plan
  and keep the private key offline.
- **Store policy:** Apple guideline 2.5.2 says apps may not "download,
  install, or execute code which introduces or changes features or
  functionality of the app" (`docs/STORE_LISTING.md` 2.1). Limit updates
  to fixes.
- **Threat model:** add a threat entry for the update channel and the Expo
  account (two-factor authentication, who can publish) before enabling it.

If adopted, the documented steps are: `npx expo install expo-updates`,
then `npx eas-cli@latest update:configure`, which writes `runtimeVersion`
and `updates.url` and sets `channel` on the `preview` and `production`
profiles (getting-started page). Prefer the `fingerprint` runtime-version
policy, which "will increment the runtime version whenever anything that
may impact the native runtime changes" (runtime-versions page), so an
update can never reach a binary whose native code it does not match.
Publishing and rollback:

```sh
npx eas-cli@latest update --channel preview --message "<what changed>"
npx eas-cli@latest update --channel production --message "<what changed>"
npx eas-cli@latest update:rollback   # interactive
```

`eas update:rollback` supports rolling back "to a previously-published
update" or "to the update embedded in the build" (docs.expo.dev/eas-update/rollbacks).
Test every update on a preview build pointing at the `preview` channel
before publishing to `production` (runtime-versions page, "Manually verify
updates with a smaller group of users"), and use rollouts for a gradual
release (docs.expo.dev/eas-update/rollouts).

---

## 9. Pre-release checklist

Every item must be checked for the exact commit being built.

**Automated checks**

- [ ] `npm test` at the repository root ends with `ALL GREEN` (engine
      vitest, all offline app suites, lint with zero warnings, `tsc`, the
      Android export). Last run for this document: 2026-10-02, 602 engine
      tests and 2,815 app checks across 29 suites, ALL GREEN, with the
      `app.json` changes in place.
- [ ] The GitHub Actions CI run for the commit concluded `success`
      (github.com/smwells25/shiba-wallet/actions).
- [ ] `npm run secret-scan` is clean, and the pre-commit hook is enabled
      on the releasing machine (`npm run hooks:install`).
- [ ] `npx expo-doctor` passes. On 2026-10-02 it reported 20 of 21 checks
      passed; the one failure is the known patch-version drift (`expo`
      expected `~57.0.26`, found `57.0.25`; `expo-camera` expected
      `~57.0.6`, found `57.0.5`), which is condition W20 and was not
      changed here.
- [ ] `npx expo install --check` is clean (W20).
- [ ] `npx expo config --type public` succeeds and shows the intended
      identifiers and version.

**Readiness and threat model**

- [ ] `app/src/config/readiness.ts` and Settings → Mainnet readiness
      reviewed: every feature's status matches `docs/THREAT_MODEL.md`
      section 5, `check-readiness.mjs` passes, and the store description
      (`docs/STORE_LISTING.md` 3.5) claims nothing the switchboard keeps
      testnet-only.
- [ ] Device conditions re-validated on the build being released, per
      `docs/DEVICE_BUILDS.md`: W2 (biometric prompts and passcode
      fallback on a real iPhone and Android phone), W3 (secure-storage
      behaviour on real hardware), W4 (release build free of LogBox, the
      dev menu and Metro; screenshot blocking works), W18 (Android backup
      test), W19 (Import screen capture block and app-switcher cover).
- [ ] W5: identifiers set, listing and privacy answers entered from
      `docs/STORE_LISTING.md`, and `docs/PRIVACY.md` published at the
      privacy-policy URL with its open items closed.
- [ ] No placeholder remains in a shipped feature: passkey rpId (or
      passkeys hidden), the WalletConnect metadata URL, the publisher
      contact in `docs/PRIVACY.md`.
- [x] The Android notification icon and colour (section 3, "Notification
      icon"; done in phase 18 item 0). Still to confirm on the build being
      released: the icon in the status bar and the shade.

**Build hygiene**

- [ ] The EAS build log shows the engine hook ran and the uploaded
      archive does not contain `.dev-wallet/`.
- [ ] The merged Android manifest's permission list matches section 3.
- [ ] Release notes written; `AGENTS.md` updated with the version, build
      numbers, commit and CI run.

---

## 10. Not verified (as of 2026-10-02)

- Any EAS build, submission or update: nothing has run without an
  account.
- That an EAS upload includes the monorepo root and that the proposed
  post-install hook builds the engine in time (section 2, step 3).
- The merged Android manifest of a real build (only the plugin-generated
  manifest was inspected).
- Whether removing `SYSTEM_ALERT_WINDOW` would be safe.
- Seen in a local release build's merged manifest on 2026-10-10 (not in
  the list above): `com.google.android.finsky.permission.BIND_GET_INSTALL_REFERRER_SERVICE`
  from the installreferrer library that expo-application pulls in; ML Kit
  barcode and Google datatransport components (from expo-camera's barcode
  support) and androidx.credentials.playservices (from the passkey
  module). Whether ML Kit or datatransport send anything off the device is
  unverified and belongs in PRIVACY.md once answered. The template also
  leaves `expo.modules.updates.*` meta-data although expo-updates is not
  installed.
- The Firebase parts that `expo-notifications` merges into the Android
  manifest (section 3, "Local reminders"): answered from the library code
  on 2026-10-11 (Firebase does not initialise without a configuration, so
  none of its components start; the exported receiver is guarded by
  `com.google.android.c2dm.permission.SEND`, which Google's documentation
  says Google Play services holds). Still open: the permission's protection
  level read on a device, and a network capture of a fresh install.
- Seen in a local debug development build's merged manifest on
  2026-10-15 (commit 45506f2; the build is kept at
  `.local/builds/shiba-devclient-45506f2-debug.apk`, git-ignored): the
  launcher badge and shortcut permissions of `me.leolin:ShortcutBadger:1.1.22`,
  which `expo-notifications` 57.0.22 declares in its `android/build.gradle`
  (line 45). The record of that day said "twenty", including four
  `com.android.launcher.permission.*` entries; re-read on 2026-10-27, the
  library's manifest declares sixteen (its four `com.android.launcher`
  lines are commented out) and `aapt2 dump permissions` on that APK lists
  sixteen. Since phase 23 item 2 the wallet's own config plugin removes
  them (section 3, "Launcher-badge permissions removed"); the merged
  manifest of a rebuilt APK has not been read yet. The debug manifest also
  carries the dev-launcher's `CHANGE_WIFI_MULTICAST_STATE`.
- App Store Connect's phased-release controls.
- The export-compliance answer (legal input).

## 11. Reproducible builds: the kept Android APKs

Written 2026-10-25 for phase 23 item 1 (the audit pack), so that an
auditor can tell which source each kept build came from, how it was made
and how it is signed. Every fact below is either read from the files on
that date or quoted from the project's running record (`AGENTS.md`,
phases 16, 21 and 22), which is named where it is the only source.

**Two points first.** All five builds are signed with the **template
debug keystore**, the one whose private key and password ship inside
Expo's public project template; anyone can sign an APK with that key.
**No release signing key exists yet**: creating one locally, or using
EAS-managed credentials, waits on the package name and the other inputs
in section 2, step 1. None of these builds may
be distributed to users, and byte-for-byte reproducibility has **not**
been tested: no build was ever made twice from the same tree and
compared.

### 11.1 The builds

The files live in the git-ignored `.local/builds/` of the main checkout.
Sizes from `ls -l`; hashes from `shasum -a 256`, both run 2026-10-25.

| File | Bytes | SHA-256 | Variant | Source tree | Record |
|---|---|---|---|---|---|
| `shiba-devclient-45506f2-debug.apk` | 84,803,531 | `9f7ae79443b9bae7a22d02d9d5f41fe7fe4674cc8fe38670d17ccccad9eee564` | debug development client | commit `45506f2` | phase 21, "the phase-21 development build for duress Stage 3" |
| `shiba-devclient-7244fd5-debug.apk` | 84,803,531 | `ae3ec9c7a74ae0e3711f94d267b38a103b4b36904c5951c3b3474d5daef62731` | debug development client | commit `7244fd5` (the `45506f2` prebuild output reused) | phase 21, pass p21g, "assembleDebug 2 min 45 s" |
| `shiba-release-7244fd5.apk` | 53,359,829 | `f73133e089a3ceafcd6cd5a820fad943a5a7426183a7aa25577891333f65a64e` | release | commit `7244fd5` (same tree as above) | phase 21, pass p21g, "assembleRelease 8 min 56 s" |
| `shiba-devclient-b414989-qc-debug.apk` | 97,878,200 | `c06d4245f69e4eb333005c16e6f9d764e366ae424e248565b818bc233321f949` | debug development client | commit `b414989` plus the native-scrypt patch that became commit `8b4ed84` | phase 22 item 2, "assembleDebug 6 min 59 s" |
| `shiba-release-8b4ed84-qc.apk` | 65,086,370 | `acbd14be97ceb70dbebc94fa80222c94d28db44f0c9cf2fd8385c93fb69b233a` | release | the same tree as the line above | phase 22, pass p22a, "BUILD SUCCESSFUL in 6 min 24 s" |

The two debug builds of `45506f2` and `7244fd5` have the same size and
different hashes.

**A correction to the record's naming.** The last two builds were made
from `b414989` with the native-scrypt change applied as a patch, which
the record describes as "8b4ed84's content". That is true of the change,
not of the whole tree: commit `8b4ed84`'s parent is `b0f3b7d`, four
commits after `b414989` (`6e41dec` visible captions for the paste boxes,
`7c07120` and `b0f3b7d` records, `8adaff7` the passphrase design), and
those commits change `app/src/components/AccountsSection.tsx`,
`RecoveryViews.tsx` and six screens (`git diff --stat b414989 8b4ed84^`,
read 2026-10-25). The `-qc` builds therefore contain the native scrypt
but not those caption changes. The file names are kept as they are.

The worktrees the builds were made in (`wt-build`, `wt-build2` in the
session scratchpad) no longer exist (the scratchpad is cleaned by
macOS), so the exact generated `android/` folders cannot be re-read; a
rebuild starts again from the commit.

### 11.2 Toolchain

From the phase 16 record ("Item 3 — local development build on the
emulator") and the commit lockfiles:

- Expo SDK `expo` 57.0.27 and React Native 0.86.3 in `app/package-lock.json`
  at all four commits; `react-native-quick-crypto` 1.1.8 at `8b4ed84`
  only (absent at the other three).
- JDK: Temurin 17.0.20.1+1, kept in the git-ignored `.local/jdk`.
- Android SDK packages: `build-tools;36.0.0`, `platforms;android-36`,
  `cmake;3.22.1`, `ndk;27.1.12297006`; the record names AGP 8.12.0 and
  Gradle 9.3.1 from React Native's `libs.versions.toml`.
- Gradle user home: the git-ignored `.local/gradle-home`. Gradle
  downloads its dependencies at build time; with the native scrypt it
  also downloads `io.github.ronickg:openssl-static` 3.6.2-3
  (`docs/DEVICE_BUILDS.md`, "The native scrypt for the app PIN").

### 11.3 The commands

The record's route (phase 16, kept as the git-ignored helper
`.local/helpers/p16c/build-devclient.sh`), run in a separate git
worktree at the commit, never in the checkout Metro serves from, and
never while the emulator is being driven:

```sh
git worktree add <worktree> <commit>
cp -cR node_modules <worktree>/node_modules          # APFS clones, so Gradle's build folders stay out of the main checkout
cp -cR app/node_modules <worktree>/app/node_modules  # then point app/node_modules/@shiba-wallet/* at <worktree>/packages/*
(cd <worktree> && npm run build)
(cd <worktree>/app && CI=1 EXPO_NO_TELEMETRY=1 npx expo prebuild --platform android --no-install)
cd <worktree>/app/android
./gradlew assembleDebug -PreactNativeArchitectures=x86_64 -PreactNativeDevServerPort=8082 --no-daemon   # development client
./gradlew assembleRelease -PreactNativeArchitectures=x86_64 --no-daemon                                  # release
# outputs: app/build/outputs/apk/<variant>/app-<variant>.apk
```

`-PreactNativeArchitectures=x86_64` builds for the emulator only; a phone
build needs `arm64-v8a` (not made). `-PreactNativeDevServerPort=8082`
keeps the development client off the port Expo Go's Metro uses. For the
`-qc` builds `npx expo prebuild --platform android --clean` is the
documented step after a native dependency change (`docs/DEVICE_BUILDS.md`,
"Rebuild after native configuration changes"); the record says prebuild
was run for them and that it autolinked the three new native modules,
but not with which flags. When a development client is tested with the
JavaScript served by Metro, start Metro with `EXPO_NO_METRO_LAZY=1`
(`docs/DEVICE_BUILDS.md`, "Lazy bundling and the development client").

### 11.4 Signing, as read from the files

`apksigner verify --print-certs -v` (Android build-tools 36.0.0, run
2026-10-25) on each of the five files: verified with APK Signature
Scheme v2 only (not v1, v3, v3.1 or v4), one signer, certificate
`CN=Android Debug, OU=Android, O=Unknown, L=Unknown, ST=Unknown, C=US`,
certificate SHA-256
`fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`.

That is the certificate of the keystore inside Expo's project template:
`app/node_modules/expo/template.tgz` (expo 57.0.27) contains
`android/app/debug.keystore` with alias `androiddebugkey`, store and key
password `android`, and the same SHA-256 fingerprint (read with
`keytool -list -v`), and the template's `android/app/build.gradle` signs
BOTH build types with it:

```
release {
    // Caution! In production, you need to generate your own keystore file.
    // see https://reactnative.dev/docs/signed-apk-android.
    signingConfig signingConfigs.debug
```

So the "release" APKs are release-mode builds but are not
release-signed. (The phase 16 record found Hermes bytecode and no
development-menu classes in an earlier release APK made by the same
route; these two files were not re-inspected for that.)
Before any store or tester build, a release keystore must be created and
kept outside the repository, or EAS-managed credentials used (section 2),
and the passkey Digital Asset Links file must name that key's
fingerprint, not this one (`docs/DEVICE_BUILDS.md`).

### 11.5 What would make a build reproducible

Not done; listed so the auditor knows what is missing: a pinned
toolchain in the repository (the JDK, SDK packages and Gradle are set up
by hand today), recorded prebuild output or a committed `android/`
folder, a record of the Gradle dependency resolution, a second build
from the same commit compared byte for byte (with the signature block
excluded), and an `arm64-v8a` build for phones.
