# Agent rules — the emulator and device builds

Read this before launching, driving or screenshotting the Android
emulator (AVD "shiba"), or building or installing a development or
release build. Moved verbatim from the standing rules of AGENTS.md on
2026-11-20; other tasks do not need it.

## Current state (read first; it supersedes the older text below)

Collected on 2026-11-20 from the phase records:

- Launch, from a foreground Terminal tab. A fresh tab does not have the
  emulator on its PATH, and a command sent to a new tab with osascript
  can lose its first character, so it starts with " ; ":

  ```
   ; export PATH=$HOME/Library/Android/sdk/emulator:$PATH; export ANDROID_EMULATOR_WAIT_TIME_BEFORE_KILL=120; emulator -avd shiba -gpu swangle
  ```

  Then find the qemu process id (for example `pgrep -f qemu`), start
  `caffeinate -i -w <qemu pid>`, run `adb reverse tcp:8081 tcp:8081`, and
  keep the window in front.
- The renderer is pinned to `-gpu swangle` (decided 2026-11-07). The
  statements below that the ANGLE renderer or `-gpu angle_indirect` is
  the confirmed-visible configuration are history: 37.1.11 never
  accepted that flag. The quick boot loads only when the renderer
  matches the saved snapshot.
- Before ANY keyguard-clearing input, read
  `adb shell dumpsys window | grep isKeyguardShowing` and send none when
  it is false (2026-11-07).
- An accessibility finding from a uiautomator dump needs a TalkBack read
  before it counts: the dump drops some visible text (2026-10-20).
- iOS Simulator: a Simulator reboot drops the Face ID enrolment while
  the menu still shows it ticked; toggle Features → Face ID → Enrolled
  off and on after every reboot (2026-11-08). Metro under CI=1 does not
  watch files: restart it with --clear after an edit (2026-11-08). A
  pass that unticks the Simulator's "Connect Hardware Keyboard" ticks it
  again at the end (2026-11-08).

## The original standing rules (verbatim)

- Emulator AVD "shiba": never wipe it and never add or remove its
  fingerprint (its wallet's phrase is in biometric-protected storage and
  written nowhere); never run an engine build in the checkout Metro
  serves from (Metro runs from an isolated git worktree with real dist
  copies); never press BACK in loops; scroll Settings only with slow
  swipes at the screen edge and never fling near the Danger zone; type
  secrets only through the ADBKeyboard IME and redact every UI dump;
  never run a Gradle build while driving the AVD (2026-10-10: the
  watchdog killed system_server) — build first, close Gradle, then drive;
  READ `adb shell dumpsys window | grep isKeyguardShowing` BEFORE ANY
  KEYGUARD-CLEARING INPUT and send none when it is false (2026-11-07: a
  loaded quick-boot snapshot restored an unlocked screen and a blind Enter
  opened the real wallet's Send form).
  LAUNCH THE AVD WITH `emulator -avd shiba -gpu swangle` (DECIDED 2026-11-07,
  see the DECISION note below; the command until then was `-gpu
  angle_indirect`, which 37.1.11 rejects) from a
  foreground Terminal tab (osascript `do script`; the new tab may first
  need its zsh compinit prompt answered): on 2026-10-14 the Chairperson
  saw only a BLACK EMULATOR WINDOW for days while adb screenshots were
  normal, no window carried the secure flag and protection was off —
  the window itself was not rendering on macOS 26.7.1 with emulator
  37.1.11: the SwiftShader default and `-gpu host` were both black for
  the Chairperson (their clicks were logged by Qt as "no target
  window"), the ANGLE (Metal) renderer is VISIBLE (confirmed by the
  Chairperson). NOTE (2026-10-28, pass p23-build): emulator 37.1.11 logs
  "Selected GPU option 'angle_indirect' is not valid, switching to
  'auto' mode" on every launch, so ANGLE was never applied — 'auto'
  resolved to gles host on one launch and swangle on the next, and the
  quick-boot snapshot loads only under the renderer it was saved with;
  which renderer to pin is the Chairperson's decision; until then keep
  the command and expect a cold boot unless 'auto' picks the renderer the
  snapshot was saved under (it did on 2026-10-29, pass p23-devbuild-recheck:
  the first quick boot that loaded; in three logs 'auto' chose swangle
  exactly when the emulator printed its memory-pressure warning, host
  otherwise), so `-no-snapshot-load` is no longer needed by default.
  DECISION (2026-11-07, the Chairperson delegated it: "I just want to make
  sure I can see the emulator"): PIN `-gpu swangle`. Reasons: 37.1.11's own
  `-help-gpu` lists auto, host, software, lavapipe, swiftshader and swangle
  (no `_indirect` names), so `angle_indirect` was never an option; on
  2026-10-14 `-gpu host` and the SwiftShader default were both BLACK for
  the Chairperson while the 'auto' launch of that day was VISIBLE, and
  swangle ("ANGLE with Swiftshader backend" — the ANGLE renderer the record
  called visible) is the one candidate never reported black; swangle is the
  renderer the first successful quick-boot load ran under, and pinning it
  makes every save and load agree so the quick boot survives every graceful
  close. UNVERIFIED until the Chairperson looks once at the next launch's
  window: if swangle is black too, the fallback is `-gpu host` with the
  window-visibility question reopened. Set
  ANDROID_EMULATOR_WAIT_TIME_BEFORE_KILL=120 in the launching shell so a
  graceful close finishes its save. A renderer change discards the quick-boot snapshot
  (cold boot, the PIN keyguard, `adb reverse` lost). CLOSING THE WINDOW
  IS A GRACEFUL SHUTDOWN (snapshot saved) and is fine; a pass relaunches
  it. NEVER SET AN APP PIN ON THE AVD'S REAL WALLET: with the PIN on,
  screen protection is forced on (phase 21 item 2) and the window goes
  black again; the duress stages run on a THROWAWAY wallet in the local
  development build only. The emulator package: 37.2.12 was installed
  on 2026-10-14 and ROLLED BACK to 37.1.11 on 2026-10-15 — the
  Chairperson saw a black window on 37.2.12 while adb was normal; 37.1.11
  with the launch command above is the configuration confirmed visible
  (CORRECTED 2026-10-28: the GPU option in force was 'auto', not ANGLE —
  see the NOTE above; 37.2.12 kept at
  ~/Library/Android/emulator-dl/emulator-37.2.12-set-aside; it was installed BY HAND: sdkmanager 21.0 fails to unzip the archive — "Error reading Zip
  content from a SeekableByteChannel" — so the official archive
  emulator-darwin_x64-16428233.zip was downloaded from
  dl.google.com/android/repository, its SHA-1 0c08fc22…e30b checked
  against repository2-3.xml, unzipped and swapped in; package.xml
  rewritten with the new revision); ROLLBACK = stop the emulator and
  put ~/Library/Android/emulator-37.1.11.bak (or
  ~/Library/Android/emulator-dl/emulator-37.1.11-removed) back as
  sdk/emulator; the version change discarded the quick-boot snapshot
  once (cold boot, PIN keyguard). With the ANGLE renderer the window is
  confirmed visible to the Chairperson on 37.1.11; the first 37.2.12
  launch rendered the wallet on Home for adb (window visibility to be
  confirmed by the Chairperson). A JDK for
  sdkmanager and dev builds lives in the git-ignored .local/jdk
  (env.sh sets JAVA_HOME; the scratchpad copy was deleted by the temp
  cleaner). AFTER ANY EMULATOR RESTART re-add `adb
  reverse tcp:8081 tcp:8081` before relaunching Expo Go, or it shows
  "Something went wrong" (the mapping is lost with the device); a
  `touch` of the Metro worktree makes Metro demand a restart
  ("Detected a change in metro.config.js").
  KEEP THE EMULATOR WINDOW IN FRONT DURING LONG PASSES: macOS throttles
  qemu whenever its window is not frontmost (priority 4, "throttled",
  about 2–3% JavaScript CPU — 2026-10-18 pass p21f: a PIN set-up did not
  finish in 37 minutes behind Zoom and finished 36 s after the window
  was brought forward; `taskpolicy -B` / `-t` / `-l` did not help; the
  same demotion slowed pass p19a); a driver brings it forward with
  osascript before any long wait.
  START `caffeinate -i -w <qemu pid>` WITH EVERY AVD LAUNCH (2026-10-19
  pass p22a: with it running, qemu's priority never dropped below 55 over
  2,025 samples; Apple documents an app that holds a power assertion as
  exempt from App Nap, and qemu has no bundle id for any defaults key —
  NSAppSleepDisabled / LSAppNapIsDisabled are undocumented anyway).
  Since phase 17 item 0 the app blocks screenshots everywhere by default.
  ON THE EMULATOR IT STAYS OFF (the Chairperson's request, 2026-10-11:
  the secure flag blanks the emulator window for a human watching it
  live): turn Settings → Privacy → "Hide in the app switcher and block
  screenshots" OFF if a pass finds it on, and leave it OFF at the end;
  a pass that needs to prove the protection itself turns it on for that
  step only and off again afterwards. Since the lock-on-launch fix
  (phase 20, 2026-10-12) a COLD RELAUNCH SHOWS "Shiba Wallet is locked"
  whenever auto-lock is on (this AVD: 1 min) — after a force-stop, a
  swipe-away plus `am kill`, or a Metro reload that restarts the JS; a
  pass taps Unlock and answers with `adb emu finger touch 1` (the AVD's
  enrolled fingerprint) before driving, or sets Auto-lock Off first and
  restores it at the end.
