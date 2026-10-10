/**
 * Local reminders (phase 17 item 2; feature 93 in part, feature 83
 * groundwork): LOCAL notifications only, scheduled on this phone by the
 * wallet itself from data it already reads. There is no push service, no
 * account and no server: nothing about a reminder leaves the device.
 * Default OFF; the user turns it on in Settings → Privacy → Notifications.
 *
 * What is built (exactly these two kinds):
 *  (a) "A recurring payment is due" — one reminder per recurring payment, at
 *      the moment its next payment falls due, computed from the on-chain
 *      facts recurring.ts already reads (readRecurringDueStates →
 *      recurringDueState). Rescheduled on every check, cancelled when the
 *      payment is revoked, forgotten, completed or its key is gone. A
 *      payment that is already due when the wallet checks is shown by the
 *      in-app banner (RecurringDueBanner), not by a notification.
 *  (b) "A recovery of one of your accounts was started" — fired once per
 *      takeover proposal found by the existing "Check for takeover
 *      attempts" scan of the Inheritance screen (inheritance.ts
 *      checkTakeoverAttempts, which stores what it found; read here through
 *      listFoundTakeoverApprovals), and only when the user was not looking
 *      at that screen when the result arrived.
 * Deliberately NOT built: a merchant subscription's next pull slot (the
 * merchant collects those payments, not this wallet, so there is nothing
 * for the user to do at that moment), and an auto-lock reminder.
 *
 * Content rule: notifications can appear on the lock screen, so a
 * notification's title and body name only the KIND of event — never an
 * amount, an address, a name, a payee, a network or a date — and its data
 * holds only the screen to open and the kind. The content functions take no
 * record at all, so nothing from a record can reach them.
 *
 * Facts relied on, from the installed expo-notifications 57.0.22 source
 * (app/node_modules/expo-notifications) and the SDK 57 documentation
 * (https://docs.expo.dev/versions/v57.0.0/sdk/notifications/, fetched
 * 2026-10-10):
 *  - Expo Go: "Push notifications (remote notifications) functionality
 *    provided by expo-notifications is unavailable in Expo Go on Android
 *    from SDK 53" and "Local notifications (in-app notifications) remain
 *    available in Expo Go" (docs). BUT importing the package's index runs
 *    src/DevicePushTokenAutoRegistration.fx.ts, which calls
 *    addPushTokenListener (src/TokenEmitter.ts:43-44) →
 *    warnOfExpoGoPushUsage (src/warnOfExpoGoPushUsage.ts:6-12), and that
 *    THROWS on Android in Expo Go whenever the server-registration module
 *    exposes getRegistrationInfoAsync — which Expo Go's Android build
 *    registers (apps/expo-go/.../ExpoModuleRegistryAdapter.kt registers
 *    ScopedServerRegistrationModule, expo/expo main, read 2026-10-10). A
 *    module that throws while it is first loaded is reported as fatal by
 *    Metro's require (metro-runtime src/polyfills/require.js:178-186,
 *    guardedLoadModule → ErrorUtils.reportFatalError), whatever try/catch
 *    surrounds the import. So loadNotificationsNative() never imports the
 *    package index: it imports the individual build files it needs (none of
 *    which imports the .fx module or TokenEmitter), after checking with
 *    requireOptionalNativeModule that every native module they bind exists
 *    (each binding file calls requireNativeModule at load, which throws for
 *    a missing module, e.g. a development build made before this package
 *    was added). Side benefit: the push-token auto-registration code, the
 *    only JS path that contacts an Expo server
 *    (src/utils/updateDevicePushTokenAsync.ts:8, exp.host), is never loaded.
 *  - Android 8+: "all notifications must be assigned to a channel"; on
 *    Android 13 the permission prompt "will not appear until at least one
 *    notification channel is created" (docs). The library would fall back
 *    to its own channel (BaseNotificationBuilder.kt:87-118); this module
 *    creates its two channels before asking for permission.
 *  - Permission: requestPermissionsAsync asks for POST_NOTIFICATIONS on
 *    Android 13+ (NotificationPermissionsModule.kt:23, 43-45, 116-123); the
 *    library's AndroidManifest.xml declares POST_NOTIFICATIONS and
 *    RECEIVE_BOOT_COMPLETED itself, so no config plugin entry is needed for
 *    local notifications (the plugin only sets the icon, colour, FCM
 *    default channel, sounds and the iOS aps-environment push entitlement,
 *    plugin/src/withNotifications*.ts — none of which this wallet uses).
 *  - Triggers: SchedulableTriggerInputTypes DATE { type: 'date', date,
 *    channelId? } (src/Notifications.types.ts:263-271, 355-359); a trigger
 *    of { channelId } on Android or null presents at once
 *    (src/scheduleNotificationAsync.ts:89-151; ExpoSchedulingDelegate.kt:46-58).
 *  - Same identifier = replace: Android stores the request under its
 *    identifier (SharedPreferencesNotificationsStore) and arms the alarm
 *    with a PendingIntent whose data URI contains the identifier and
 *    FLAG_UPDATE_CURRENT (NotificationsService.kt:416-438), so scheduling
 *    an identifier again replaces the earlier alarm instead of adding one.
 *  - Reboot: the library's receiver re-arms every stored request on
 *    BOOT_COMPLETED, REBOOT and MY_PACKAGE_REPLACED
 *    (NotificationsService.kt:33-39, 643-645, 828-829;
 *    ExpoSchedulingDelegate.kt:22-31). Nothing re-arms after a FORCE STOP
 *    (Android clears a stopped app's alarms; the library has no hook for
 *    the next launch) — this wallet re-schedules on its next start.
 *  - Exact time: with the exact-alarm permission the library uses
 *    setExactAndAllowWhileIdle, otherwise setAndAllowWhileIdle
 *    (ExpoSchedulingDelegate.kt:105-121). This wallet does not request
 *    SCHEDULE_EXACT_ALARM, so a reminder may arrive somewhat late; a
 *    payment slot stays open for a whole period, so that is acceptable.
 *  - Foreground: without setNotificationHandler a notification received
 *    while the app is open is not shown (src/NotificationsHandler.ts:63-87).
 *
 * Node-loadable: no React, React Native or expo-notifications import at the
 * top level (scripts/check-notifications.mjs drives the real logic with an
 * injected fake). The native layer is reached only through
 * loadNotificationsNative(), called by the app at runtime.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
// Explicit .ts extensions: scripts/check-notifications.mjs loads this module
// under Node's type stripping, which resolves relative specifiers literally.
import { RECURRING_SOURCE, recurringEndsAt, type RecurringDue } from './recurring.ts';
import type { SessionRecord } from './sessions.ts';
import { termsOf } from './subscriptions.ts';
import type { KeyValueStore } from './tokens.ts';
// Type-only (erased under Node): the trigger shape of the installed package.
import type { NotificationTriggerInput } from 'expo-notifications/build/Notifications.types';

// ---------------------------------------------------------------------------
// Copy (one source for every surface; pinned by the check script)
// ---------------------------------------------------------------------------

export const NOTIFICATIONS_SECTION_TITLE = 'Notifications';
export const NOTIFICATIONS_SWITCH_LABEL = 'Remind me when something is due';
export const NOTIFICATIONS_WHAT_NOTE =
  'When this is on, this phone shows a reminder when one of your recurring payments falls due, and an alert ' +
  'when the takeover check on the Inheritance screen finds that a recovery of one of your accounts was ' +
  'started. A reminder never sends anything: each payment is still sent only after you confirm it in the wallet.';
export const NOTIFICATIONS_PRIVACY_NOTE =
  'The reminders are scheduled on this phone by the wallet itself. No notification service is used and ' +
  'nothing about them leaves the device. They say only what kind of event happened, never an amount, an ' +
  'address or a name, because notifications can appear on the lock screen.';
export const NOTIFICATIONS_LIMITS_NOTE =
  'Reminders are worked out from what the wallet read the last time it was open, so a change made elsewhere ' +
  'is picked up the next time you open it. After a force stop, Android drops the scheduled reminders until ' +
  'you open the wallet again. Not included: merchant subscriptions (the merchant collects those payments, ' +
  'not this wallet) and auto-lock reminders.';

export const RECURRING_DUE_TITLE = 'Recurring payment due';
export const RECURRING_DUE_BODY =
  'A recurring payment is due. Open the wallet to review it; nothing is sent until you confirm it.';
export const TAKEOVER_TITLE = 'Account recovery started';
export const TAKEOVER_BODY =
  'Someone started a recovery of one of your accounts. Open the wallet to review it, and veto it if you did not expect it.';

/** Android notification channels (names are shown in the system's notification settings). */
export const CHANNEL_PAYMENTS = { id: 'payments-due', name: 'Payments due', importance: 'default' } as const;
export const CHANNEL_SECURITY = { id: 'security-alerts', name: 'Security alerts', importance: 'high' } as const;
export type NotificationChannelSpec = { id: string; name: string; importance: 'default' | 'high' };

// ---------------------------------------------------------------------------
// Identifiers and content
// ---------------------------------------------------------------------------

/** Every identifier this wallet schedules starts with this; nothing else is ever cancelled. */
export const NOTIFICATION_ID_PREFIX = 'shiba-wallet.';
export const RECURRING_ID_PREFIX = 'shiba-wallet.recurring.';
export const TAKEOVER_ID_PREFIX = 'shiba-wallet.takeover.';
/** This module's bookkeeping (seen takeover proposals as hashes; whether anything may be scheduled). */
export const NOTIFICATIONS_STORE_KEY = 'shiba-wallet.notifications.v1';

/** The screens a notification may open (an allow list; anything else is ignored). */
export type NotificationScreen = 'Sessions' | 'Inheritance';
export type NotificationKind = 'recurring-due' | 'takeover';

export interface NotificationContent {
  title: string;
  body: string;
  data: { screen: NotificationScreen; kind: NotificationKind };
}

/**
 * A short, stable, non-reversible tag: the first 16 hex characters of
 * sha256(text). Used in identifiers so the OS's scheduled-notification store
 * holds no address or permission id, only a tag the wallet can recompute.
 */
export function shortTag(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text))).slice(0, 16);
}

/** The scope (network + owner) part of a recurring identifier. */
export function recurringScopeTag(chain: string, owner: string): string {
  return shortTag(`scope|${chain}|${owner.toLowerCase()}`).slice(0, 8);
}

/**
 * The stable identifier of one recurring payment's reminder:
 * "shiba-wallet.recurring.<scope 8 hex>.<record 16 hex>", the record part
 * from the record's key (network, account, permission id — the same triple
 * as sessions.ts sessionRecordKey). Scheduling it again replaces the
 * earlier reminder (see the module header).
 */
export function recurringNotificationId(record: Pick<SessionRecord, 'chain' | 'account' | 'owner' | 'permissionId'>): string {
  const recordKey = `${record.chain}|${record.account.toLowerCase()}|${record.permissionId.toLowerCase()}`;
  return `${RECURRING_ID_PREFIX}${recurringScopeTag(record.chain, record.owner)}.${shortTag(`recurring|${recordKey}`)}`;
}

/** The key of one found takeover proposal (network, account, proposal hash). */
export function takeoverKey(found: { chain: string; account: string; proposalHash: string }): string {
  return shortTag(`takeover|${found.chain}|${found.account.toLowerCase()}|${found.proposalHash.toLowerCase()}`);
}

export function takeoverNotificationId(found: { chain: string; account: string; proposalHash: string }): string {
  return `${TAKEOVER_ID_PREFIX}${takeoverKey(found)}`;
}

/** The reminder for a due recurring payment. Takes no record: nothing from one can reach the lock screen. */
export function recurringDueContent(): NotificationContent {
  return { title: RECURRING_DUE_TITLE, body: RECURRING_DUE_BODY, data: { screen: 'Sessions', kind: 'recurring-due' } };
}

/** The alert for a takeover attempt. Takes no record, for the same reason. */
export function takeoverContent(): NotificationContent {
  return { title: TAKEOVER_TITLE, body: TAKEOVER_BODY, data: { screen: 'Inheritance', kind: 'takeover' } };
}

/** The screen a tapped notification asks for, from its data; only the allow-listed screens. */
export function screenFromNotificationData(data: unknown): NotificationScreen | null {
  if (typeof data !== 'object' || data === null) return null;
  const screen = (data as Record<string, unknown>).screen;
  return screen === 'Sessions' || screen === 'Inheritance' ? screen : null;
}

// ---------------------------------------------------------------------------
// Planning (pure)
// ---------------------------------------------------------------------------

/**
 * When the reminder for one recurring payment should fire (unix seconds), or
 * null for none:
 *  - 'later': when the next payment falls due;
 *  - 'due': the payment(s) open now are the banner's job; the reminder is for
 *    the slot after them — slot k opens at since + k × period
 *    (recurring.ts openSlotCount), so the next one is since + openSlots ×
 *    period, if a payment is left for it and it opens no later than the
 *    installed grant's end (recurringEndsAt). The period is the terms'
 *    periodSeconds, which subscriptionGrantFor installs as the
 *    RateLimitPolicy interval;
 *  - completed, inactive, not-ready, unknown: none.
 * Never a time at or before `now`.
 */
export function recurringReminderAt(record: SessionRecord, due: RecurringDue | null, now: number): number | null {
  if (!due) return null;
  if (due.kind === 'later') return due.at > now ? due.at : null;
  if (due.kind !== 'due') return null;
  if (due.openSlots >= due.remaining) return null;
  let period: number;
  let end: number;
  try {
    period = termsOf(record).periodSeconds;
    end = recurringEndsAt(record);
  } catch {
    return null;
  }
  if (!Number.isFinite(period) || period <= 0) return null;
  const at = due.since + due.openSlots * period;
  return at > now && at <= end ? at : null;
}

/** A record whose reminder may exist at all: recurring, set-up confirmed, key on this phone. */
export function recurringReminderEligible(record: SessionRecord): boolean {
  return record.source === RECURRING_SOURCE && !!record.subscription && record.localStatus === 'installed' && record.keyHeld;
}

export interface RecurringSyncPlan {
  schedule: { identifier: string; at: number }[];
  cancel: string[];
}

/**
 * What to schedule and cancel for recurring payments.
 *  - Everywhere (no network needed): a scheduled recurring reminder whose
 *    record is gone or no longer eligible (revoked, revoking, failed,
 *    forgotten, key gone) is cancelled.
 *  - For the states just read (one network + owner): each record's reminder
 *    is (re)scheduled at recurringReminderAt, or cancelled when there is no
 *    future time (completed, inactive, already due with nothing after it). A
 *    record whose status read failed (`due: null`) is left as it is.
 * Identifiers are stable, so scheduling never duplicates.
 */
export function planRecurringSync(args: {
  scheduled: readonly string[];
  records: readonly SessionRecord[];
  states: readonly { record: SessionRecord; due: RecurringDue | null }[];
  now: number;
}): RecurringSyncPlan {
  const eligible = new Set(args.records.filter(recurringReminderEligible).map(recurringNotificationId));
  const scheduled = new Set(args.scheduled.filter((id) => id.startsWith(RECURRING_ID_PREFIX)));
  const cancel = new Set<string>();
  for (const id of scheduled) if (!eligible.has(id)) cancel.add(id);
  const schedule: { identifier: string; at: number }[] = [];
  const planned = new Set<string>();
  for (const { record, due } of args.states) {
    const identifier = recurringNotificationId(record);
    if (planned.has(identifier) || due === null) continue;
    planned.add(identifier);
    if (!eligible.has(identifier)) {
      if (scheduled.has(identifier)) cancel.add(identifier);
      continue;
    }
    const at = recurringReminderAt(record, due, args.now);
    if (at === null) {
      if (scheduled.has(identifier)) cancel.add(identifier);
    } else {
      cancel.delete(identifier);
      schedule.push({ identifier, at });
    }
  }
  return { schedule, cancel: [...cancel] };
}

/**
 * Which found takeover proposals to announce. Each proposal is announced at
 * most once (its key joins `seen`). While the user is looking at the
 * Inheritance screen (`looking`), whatever is found is marked seen without a
 * notification: the screen already shows it.
 */
export function planTakeoverAlerts(args: {
  found: readonly { chain: string; account: string; proposalHash: string }[];
  seen: readonly string[];
  looking: boolean;
}): { fire: { identifier: string; key: string }[]; seen: string[] } {
  const seen = new Set(args.seen);
  const fire: { identifier: string; key: string }[] = [];
  for (const f of args.found) {
    const key = takeoverKey(f);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!args.looking) fire.push({ identifier: `${TAKEOVER_ID_PREFIX}${key}`, key });
  }
  return { fire, seen: [...seen] };
}

// ---------------------------------------------------------------------------
// The native layer (injected) and the controller
// ---------------------------------------------------------------------------

export interface NotificationPermission {
  granted: boolean;
  canAskAgain: boolean;
}

/** The calls this module makes; the app's implementation is loadNotificationsNative(). */
export interface NotificationsNative {
  platform: string;
  getPermission(): Promise<NotificationPermission>;
  requestPermission(): Promise<NotificationPermission>;
  /** Creates (or updates) the Android channels; a no-op elsewhere. */
  ensureChannels(channels: readonly NotificationChannelSpec[]): Promise<void>;
  /** at: unix seconds, or null for "show now". */
  schedule(request: { identifier: string; content: NotificationContent; at: number | null; channelId: string }): Promise<void>;
  cancel(identifier: string): Promise<void>;
  /** Removes a shown notification from the tray (best effort). */
  dismiss(identifier: string): Promise<void>;
  scheduledIdentifiers(): Promise<string[]>;
  /** The data of the notification the user last tapped, if not yet handled. */
  lastResponseData(): unknown;
  clearLastResponse(): void;
  onResponse(listener: (data: unknown) => void): { remove(): void };
}

export type EnableOutcome =
  | { ok: true }
  | { ok: false; reason: 'denied' }
  | { ok: false; reason: 'unavailable'; detail: string };

export const NOTIFICATIONS_DENIED_TEXT =
  'Notifications are turned off for Shiba Wallet in this phone’s settings, so no reminder can be shown. ' +
  'Allow notifications for Shiba Wallet in the system settings, then turn this on again.';
export const NOTIFICATIONS_UNAVAILABLE_TEXT =
  'Reminders are not available in this build of the app (its notification module is missing), so nothing ' +
  'was scheduled.';

export type NotificationsStatus =
  | { state: 'off' }
  | { state: 'on' }
  | { state: 'blocked' }
  | { state: 'unavailable'; detail: string }
  | { state: 'failed'; detail: string };

/** The status sentence under the switch. */
export function describeNotificationsStatus(status: NotificationsStatus): string {
  switch (status.state) {
    case 'off':
      return 'Reminders are off. Nothing is scheduled.';
    case 'on':
      return 'Reminders are on.';
    case 'blocked':
      return NOTIFICATIONS_DENIED_TEXT;
    case 'unavailable':
      return `${NOTIFICATIONS_UNAVAILABLE_TEXT} Technical detail: ${status.detail}`;
    case 'failed':
      return `The last reminder update failed; it is tried again the next time the wallet checks. Technical detail: ${status.detail}`;
  }
}

/** One plain line from a native error (no stack). */
export function describeNotificationError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n')[0]!.slice(0, 300);
}

interface StoreState {
  version: 1;
  seenTakeovers: string[];
  /** True from the first schedule until a full cancel succeeded. */
  mayHaveScheduled: boolean;
}

const MAX_SEEN = 500;

function emptyState(): StoreState {
  return { version: 1, seenTakeovers: [], mayHaveScheduled: false };
}

async function readState(store: KeyValueStore): Promise<StoreState> {
  try {
    const text = await store.getItem(NOTIFICATIONS_STORE_KEY);
    if (!text) return emptyState();
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed?.version !== 1) return { ...emptyState(), mayHaveScheduled: true };
    return {
      version: 1,
      seenTakeovers: Array.isArray(parsed.seenTakeovers)
        ? (parsed.seenTakeovers as unknown[]).filter((s): s is string => typeof s === 'string' && /^[0-9a-f]{16}$/.test(s))
        : [],
      // Anything but an explicit false counts as "may have scheduled", so a
      // damaged record leads to a cleanup rather than to a forgotten reminder.
      mayHaveScheduled: parsed.mayHaveScheduled !== false,
    };
  } catch {
    return { ...emptyState(), mayHaveScheduled: true };
  }
}

async function writeState(store: KeyValueStore, state: StoreState): Promise<void> {
  await store.setItem(
    NOTIFICATIONS_STORE_KEY,
    JSON.stringify({ ...state, seenTakeovers: state.seenTakeovers.slice(-MAX_SEEN) }),
  );
}

export interface NotificationCenter {
  /**
   * Turning reminders on: creates the channels, asks for permission only
   * when it is not granted yet and the system still allows asking (so the
   * prompt appears at most once per decision), and marks every takeover
   * already found as seen so turning this on never replays old alerts.
   */
  enable(args: { found: readonly { chain: string; account: string; proposalHash: string }[] }): Promise<EnableOutcome>;
  /** Turning reminders off (and the wallet wipe): cancels every reminder this wallet scheduled and forgets the bookkeeping. */
  disable(): Promise<void>;
  /**
   * With reminders off (at start, after turning off, and after a wipe):
   * cancels this wallet's reminders if any may still be scheduled and
   * forgets the bookkeeping. Loads the native module only in the first case.
   */
  cleanupIfOff(): Promise<void>;
  syncRecurring(args: {
    enabled: boolean;
    records: readonly SessionRecord[];
    states: readonly { record: SessionRecord; due: RecurringDue | null }[];
  }): Promise<void>;
  observeTakeovers(args: {
    enabled: boolean;
    found: readonly { chain: string; account: string; proposalHash: string }[];
    looking: boolean;
  }): Promise<void>;
  /** The permission as the system reports it now (for the Settings status). */
  permission(): Promise<NotificationPermission | null>;
  native(): Promise<NotificationsNative>;
  status(): NotificationsStatus | null;
  subscribe(listener: () => void): () => void;
}

/**
 * Builds the controller. Every operation is serialized (one runs at a time,
 * in call order), so a sync can never interleave with a disable. With
 * `enabled` false, sync and observe return at once without loading the
 * native module: nothing is ever scheduled while reminders are off.
 */
export function createNotificationCenter(deps: {
  loadNative: () => Promise<NotificationsNative>;
  store: KeyValueStore;
  /** Unix seconds. */
  now?: () => number;
}): NotificationCenter {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  let queue: Promise<unknown> = Promise.resolve();
  let lastStatus: NotificationsStatus | null = null;
  const listeners = new Set<() => void>();
  let nativePromise: Promise<NotificationsNative> | null = null;

  function setStatus(status: NotificationsStatus | null): void {
    lastStatus = status;
    for (const l of listeners) l();
  }

  function native(): Promise<NotificationsNative> {
    if (!nativePromise) {
      nativePromise = deps.loadNative();
      // A failed load (a build without the module) is retried next time, not cached.
      nativePromise.catch(() => {
        nativePromise = null;
      });
    }
    return nativePromise;
  }

  function serial<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  }

  async function cancelAllOurs(n: NotificationsNative): Promise<void> {
    const ids = (await n.scheduledIdentifiers()).filter((id) => id.startsWith(NOTIFICATION_ID_PREFIX));
    for (const id of ids) await n.cancel(id);
  }

  return {
    enable: ({ found }) =>
      serial(async () => {
        let n: NotificationsNative;
        try {
          n = await native();
        } catch (e) {
          const detail = describeNotificationError(e);
          setStatus({ state: 'unavailable', detail });
          return { ok: false, reason: 'unavailable', detail } as const;
        }
        try {
          // Android 13: the permission prompt appears only once a channel exists (docs).
          await n.ensureChannels([CHANNEL_PAYMENTS, CHANNEL_SECURITY]);
          let permission = await n.getPermission();
          if (!permission.granted && permission.canAskAgain) permission = await n.requestPermission();
          if (!permission.granted) {
            setStatus({ state: 'blocked' });
            return { ok: false, reason: 'denied' } as const;
          }
          const state = await readState(deps.store);
          const plan = planTakeoverAlerts({ found, seen: state.seenTakeovers, looking: true });
          await writeState(deps.store, { ...state, seenTakeovers: plan.seen });
          setStatus({ state: 'on' });
          return { ok: true } as const;
        } catch (e) {
          const detail = describeNotificationError(e);
          setStatus({ state: 'unavailable', detail });
          return { ok: false, reason: 'unavailable', detail } as const;
        }
      }),

    disable: () =>
      serial(async () => {
        const n = await native();
        await cancelAllOurs(n);
        await writeState(deps.store, emptyState());
        setStatus({ state: 'off' });
      }),

    cleanupIfOff: () =>
      serial(async () => {
        const state = await readState(deps.store);
        if (state.mayHaveScheduled) await cancelAllOurs(await native());
        if (state.mayHaveScheduled || state.seenTakeovers.length > 0) await writeState(deps.store, emptyState());
        if (lastStatus?.state !== 'blocked' && lastStatus?.state !== 'unavailable') setStatus({ state: 'off' });
      }),

    syncRecurring: ({ enabled, records, states }) =>
      serial(async () => {
        if (!enabled) return;
        try {
          const n = await native();
          const plan = planRecurringSync({ scheduled: await n.scheduledIdentifiers(), records, states, now: now() });
          if (plan.schedule.length > 0) {
            const state = await readState(deps.store);
            if (!state.mayHaveScheduled) await writeState(deps.store, { ...state, mayHaveScheduled: true });
          }
          for (const id of plan.cancel) await n.cancel(id);
          for (const s of plan.schedule) {
            await n.schedule({ identifier: s.identifier, content: recurringDueContent(), at: s.at, channelId: CHANNEL_PAYMENTS.id });
          }
          if (lastStatus?.state !== 'blocked') setStatus({ state: 'on' });
        } catch (e) {
          setStatus({ state: 'failed', detail: describeNotificationError(e) });
        }
      }),

    observeTakeovers: ({ enabled, found, looking }) =>
      serial(async () => {
        if (!enabled) return;
        try {
          const state = await readState(deps.store);
          const plan = planTakeoverAlerts({ found, seen: state.seenTakeovers, looking });
          if (plan.seen.length === state.seenTakeovers.length) return;
          if (plan.fire.length > 0) {
            const n = await native();
            // Record first: a proposal is announced at most once even if presenting fails part-way.
            await writeState(deps.store, { ...state, seenTakeovers: plan.seen, mayHaveScheduled: true });
            for (const f of plan.fire) {
              await n.schedule({ identifier: f.identifier, content: takeoverContent(), at: null, channelId: CHANNEL_SECURITY.id });
            }
          } else {
            await writeState(deps.store, { ...state, seenTakeovers: plan.seen });
          }
        } catch (e) {
          setStatus({ state: 'failed', detail: describeNotificationError(e) });
        }
      }),

    permission: () =>
      serial(async () => {
        try {
          return await (await native()).getPermission();
        } catch {
          return null;
        }
      }),

    native,
    status: () => lastStatus,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// ---------------------------------------------------------------------------
// The app's instance (runtime only)
// ---------------------------------------------------------------------------

/** Native modules the imported build files bind at load (requireNativeModule). */
const REQUIRED_NATIVE_MODULES: Record<string, readonly string[]> = {
  android: [
    'ExpoNotificationScheduler',
    'ExpoNotificationPermissionsModule',
    'ExpoNotificationsHandlerModule',
    'ExpoNotificationsEmitter',
    'ExpoNotificationPresenter',
    'ExpoNotificationChannelManager',
  ],
  ios: [
    'ExpoNotificationScheduler',
    'ExpoNotificationPermissionsModule',
    'ExpoNotificationsHandlerModule',
    'ExpoNotificationsEmitter',
    'ExpoNotificationPresenter',
  ],
};

/**
 * Loads the native layer. Called only by the app at runtime, never by the
 * check script. It imports individual files of expo-notifications' build
 * (never the package index; see the module header for why), each only after
 * the native modules it binds were found.
 */
export async function loadNotificationsNative(): Promise<NotificationsNative> {
  const { Platform } = await import('react-native');
  const { requireOptionalNativeModule } = await import('expo');
  const required = REQUIRED_NATIVE_MODULES[Platform.OS];
  if (!required) throw new Error(`Local notifications are not supported on ${Platform.OS}.`);
  const missing = required.filter((name) => !requireOptionalNativeModule(name));
  if (missing.length > 0) {
    throw new Error(`Native module${missing.length === 1 ? '' : 's'} missing: ${missing.join(', ')}. A new build of the app is needed.`);
  }
  const { scheduleNotificationAsync } = await import('expo-notifications/build/scheduleNotificationAsync');
  const { cancelScheduledNotificationAsync } = await import('expo-notifications/build/cancelScheduledNotificationAsync');
  const { getAllScheduledNotificationsAsync } = await import('expo-notifications/build/getAllScheduledNotificationsAsync');
  const { dismissNotificationAsync } = await import('expo-notifications/build/dismissNotificationAsync');
  const { getPermissionsAsync, requestPermissionsAsync } = await import('expo-notifications/build/NotificationPermissions');
  const { setNotificationHandler } = await import('expo-notifications/build/NotificationsHandler');
  const emitter = await import('expo-notifications/build/NotificationsEmitter');
  const { SchedulableTriggerInputTypes } = await import('expo-notifications/build/Notifications.types');
  const android = Platform.OS === 'android';
  const channels = android ? await import('expo-notifications/build/setNotificationChannelAsync') : null;
  const { AndroidImportance } = await import('expo-notifications/build/NotificationChannelManager.types');

  // Shown while the app is open too (otherwise a notification arriving in the
  // foreground is not displayed); no sound, no badge.
  setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });

  const toPermission = (p: { granted: boolean; canAskAgain: boolean }): NotificationPermission => ({
    granted: p.granted === true,
    canAskAgain: p.canAskAgain === true,
  });

  return {
    platform: Platform.OS,
    getPermission: async () => toPermission(await getPermissionsAsync()),
    requestPermission: async () =>
      toPermission(await requestPermissionsAsync({ ios: { allowAlert: true, allowBadge: false, allowSound: true } })),
    ensureChannels: async (list) => {
      if (!channels) return;
      for (const c of list) {
        await channels.setNotificationChannelAsync(c.id, {
          name: c.name,
          importance: c.importance === 'high' ? AndroidImportance.HIGH : AndroidImportance.DEFAULT,
        });
      }
    },
    schedule: async ({ identifier, content, at, channelId }) => {
      const trigger: NotificationTriggerInput =
        at === null
          ? android
            ? { channelId }
            : null
          : android
            ? { type: SchedulableTriggerInputTypes.DATE, date: at * 1000, channelId }
            : { type: SchedulableTriggerInputTypes.DATE, date: at * 1000 };
      await scheduleNotificationAsync({
        identifier,
        content: { title: content.title, body: content.body, data: { ...content.data } },
        trigger,
      });
    },
    cancel: (identifier) => cancelScheduledNotificationAsync(identifier),
    dismiss: (identifier) => dismissNotificationAsync(identifier),
    scheduledIdentifiers: async () => (await getAllScheduledNotificationsAsync()).map((r) => r.identifier),
    lastResponseData: () => emitter.getLastNotificationResponse()?.notification.request.content.data ?? null,
    clearLastResponse: () => emitter.clearLastNotificationResponse(),
    onResponse: (listener) =>
      emitter.addNotificationResponseReceivedListener((response) => listener(response.notification.request.content.data)),
  };
}

let appInstance: NotificationCenter | null = null;

/** The single app-wide controller (created on first use; AsyncStorage is imported lazily). */
export function appNotifications(): NotificationCenter {
  if (!appInstance) {
    let storePromise: Promise<KeyValueStore> | null = null;
    const store = (): Promise<KeyValueStore> => {
      if (!storePromise) storePromise = import('@react-native-async-storage/async-storage').then((m) => m.default);
      return storePromise;
    };
    appInstance = createNotificationCenter({
      loadNative: loadNotificationsNative,
      store: {
        getItem: async (k) => (await store()).getItem(k),
        setItem: async (k, v) => (await store()).setItem(k, v),
      },
    });
  }
  return appInstance;
}
