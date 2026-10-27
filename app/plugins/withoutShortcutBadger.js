/**
 * Removes the launcher-badge permissions that the ShortcutBadger library
 * adds to the Android app (phase 23 item 2).
 *
 * WHERE THEY COME FROM. expo-notifications 57.0.22 depends on
 * me.leolin:ShortcutBadger:1.1.22 (node_modules/expo-notifications/
 * android/build.gradle line 45: `implementation
 * 'me.leolin:ShortcutBadger:1.1.22@aar'`) so that it can draw an unread
 * count on the launcher icon. That library's own AndroidManifest.xml
 * (inside ShortcutBadger-1.1.22.aar, lines 19-50) declares the sixteen
 * permissions listed below; its four `com.android.launcher.permission.*`
 * lines (12-15) are commented out and are not declared. Every kept build
 * of this wallet carries exactly these sixteen (`aapt2 dump permissions`
 * on the five APKs in .local/builds, 2026-10-27).
 *
 * WHY THEY GO. The wallet never sets a badge count (`shouldSetBadge: false`
 * and `allowBadge: false` in src/wallet/notifications.ts), so the
 * permissions are declared but never used.
 *
 * HOW. Android's manifest merger drops an element from the merged manifest
 * when the app's own manifest repeats it with `tools:node="remove"`
 * (developer.android.com/build/manage-manifests, "Merge rule markers",
 * fetched 2026-10-27: "Remove this element from the merged manifest. Used
 * when you discover an element in your merged manifest that you don't
 * need that was provided by a lower-priority manifest file that's out of
 * your control (such as an imported library)."). The markers need the
 * `tools` namespace declared on <manifest>. Expo's own
 * AndroidConfig.Permissions.withBlockedPermissions does both: it declares
 * the namespace (@expo/config-plugins 57.0.10, build/android/Manifest.js
 * ensureToolsAvailable, line 224) and writes one
 * `<uses-permission android:name="…" tools:node="remove"/>` per name
 * (build/android/Permissions.js withBlockedPermissions line 48,
 * ensureBlockedPermission lines 89-101). This plugin passes it exactly the
 * sixteen names below, so the list lives in one place the checks can read.
 */
const { AndroidConfig } = require('expo/config-plugins');

/** The sixteen permissions ShortcutBadger 1.1.22 declares, in its manifest's order. */
const SHORTCUT_BADGER_PERMISSIONS = Object.freeze([
  // Samsung
  'com.sec.android.provider.badge.permission.READ',
  'com.sec.android.provider.badge.permission.WRITE',
  // HTC
  'com.htc.launcher.permission.READ_SETTINGS',
  'com.htc.launcher.permission.UPDATE_SHORTCUT',
  // Sony
  'com.sonyericsson.home.permission.BROADCAST_BADGE',
  'com.sonymobile.home.permission.PROVIDER_INSERT_BADGE',
  // Apex launcher
  'com.anddoes.launcher.permission.UPDATE_COUNT',
  // Solid launcher
  'com.majeur.launcher.permission.UPDATE_BADGE',
  // Huawei
  'com.huawei.android.launcher.permission.CHANGE_BADGE',
  'com.huawei.android.launcher.permission.READ_SETTINGS',
  'com.huawei.android.launcher.permission.WRITE_SETTINGS',
  // ZUK
  'android.permission.READ_APP_BADGE',
  // OPPO
  'com.oppo.launcher.permission.READ_SETTINGS',
  'com.oppo.launcher.permission.WRITE_SETTINGS',
  // EverythingMe
  'me.everything.badger.permission.BADGE_COUNT_READ',
  'me.everything.badger.permission.BADGE_COUNT_WRITE',
]);

function withoutShortcutBadger(config) {
  return AndroidConfig.Permissions.withBlockedPermissions(config, [...SHORTCUT_BADGER_PERMISSIONS]);
}

module.exports = withoutShortcutBadger;
module.exports.SHORTCUT_BADGER_PERMISSIONS = SHORTCUT_BADGER_PERMISSIONS;
