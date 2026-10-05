// Plain-language copy for the Settings "Recovery phrase protection"
// section. Pure functions over ./storage.ts's StorageProtection and
// UpgradeResult, kept out of SettingsScreen.tsx so Node can load them
// (type stripping) and scripts/check-settings-protection.mjs can pin every
// string. The wording follows the states documented in ./storage.ts; do
// not reword a status sentence without updating that check.

import {
  PHRASE_UNREADABLE_MESSAGE,
  type StorageProtection,
  type UpgradeResult,
} from './storage.ts';
import { localDateLabel } from '../config/dates.ts';

/** What the Settings section shows for one storageProtection() result. */
export interface ProtectionStatusView {
  /** The main status sentence, or null when there is nothing to say (no wallet). */
  text: string | null;
  /** A second line (an unprotected copy still being removed), or null. */
  note: string | null;
  /** True when the text is a warning the user must act on (render it as one). */
  warning: boolean;
  /** True when the "Protect with biometrics" button should be offered. */
  showProtectButton: boolean;
  /**
   * Where the imported private keys are (feature 12), or null when there
   * are none. Shown as its own line under the phrase's status.
   */
  importedNote: string | null;
}

export const PROTECT_BUTTON_TITLE = 'Protect with biometrics';
export const PROTECT_CONFIRM_TITLE = 'Protect with biometrics?';
export const PROTECT_CONFIRM_MESSAGE =
  'After this, opening your recovery phrase needs your fingerprint or face. If you ever add or ' +
  'remove a fingerprint or face, or turn off the screen lock, this phone will no longer be able to ' +
  'open the phrase and you will need your written backup. Make sure your written recovery phrase ' +
  'is safe before continuing.';

/**
 * The confirm dialog's message: PROTECT_CONFIRM_MESSAGE, plus a sentence
 * when imported private keys would move too (feature 12), because the
 * invalidation rule is final for them: the phrase cannot restore them.
 */
export function protectConfirmMessage(s: StorageProtection | null): string {
  const k = s?.importedKeys;
  if (!k || k.standard === 0) return PROTECT_CONFIRM_MESSAGE;
  const subject = importedKeysSubject(k.standard, k.total);
  if (k.standard === 1) {
    return (
      `${PROTECT_CONFIRM_MESSAGE} ${subject} in standard storage moves too (it asks for your fingerprint or ` +
      'face again). The same rule applies to it, and your recovery phrase cannot restore it: keep a copy of ' +
      'the private key.'
    );
  }
  return (
    `${PROTECT_CONFIRM_MESSAGE} ${subject} in standard storage move ` +
    'too (each asks for your fingerprint or face again). The same rule applies to them, and your recovery ' +
    'phrase cannot restore them: keep a copy of each private key.'
  );
}

export const STANDARD_COPY_NOTE =
  'An unprotected copy is still being removed; it goes the next time you approve something.';

/**
 * The date shown in "protected … (since {date})": YYYY-MM-DD on the
 * device's local calendar (config/dates.ts), the same form and rule the
 * other Settings status lines use for their check dates.
 */
export function protectionDate(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return 'unknown date';
  return localDateLabel(ms);
}

/** " ({detail})" when the platform gave error text, otherwise nothing. */
function paren(detail: string | null): string {
  return detail ? ` (${detail})` : '';
}

export function protectedText(protectedSince: number | null): string {
  return (
    `Your recovery phrase is protected by biometrics (since ${protectionDate(protectedSince)}). ` +
    'Opening it needs your fingerprint or face every time. If you add or remove a fingerprint or ' +
    'face, or turn off the screen lock, this phone can no longer open it — keep your written ' +
    'recovery phrase safe.'
  );
}

export const NO_STRONG_BIOMETRICS_TEXT =
  'This phone has no strong fingerprint or face unlock enrolled, so the phrase is in standard ' +
  'secure storage: code inside the app can read it while the phone is unlocked, and your screen ' +
  'lock is the main protection.';
export const NOT_ATTEMPTED_TEXT =
  'Your recovery phrase is in standard secure storage. You can move it into biometric-protected ' +
  'storage below.';
export const CANCELLED_TEXT = 'Moving your phrase to biometric protection was cancelled.';
export const REVERTED_TEXT =
  'The protected copy stopped working after a biometric change; the wallet is using its standard copy.';
export const POLICY_OFF_TEXT = 'Biometric protection is turned off for this build.';

export function platformRefusedText(detail: string | null): string {
  return `This phone refused biometric-protected storage${paren(detail)}; the phrase stays in standard secure storage.`;
}

export function verifyFailedText(detail: string | null): string {
  return (
    'The protected copy could not be confirmed, so it was discarded; the phrase stays in standard ' +
    `storage${paren(detail)}.`
  );
}

function keysWord(n: number): string {
  return n === 1 ? '1 imported private key' : `${n} imported private keys`;
}

/**
 * The subject of a sentence about `count` of the phone's `total` imported
 * keys, written to read naturally for one key (finding 8 of the 2026-10-04
 * private-key run: "Your 1 imported private key is protected…"): "Your
 * imported private key" when it is the only one, "Your 3 imported private
 * keys" for all of several, "One of your imported private keys" or "2 of
 * your 3 imported private keys" for some of them.
 */
export function importedKeysSubject(count: number, total: number): string {
  if (count >= total) return count === 1 ? 'Your imported private key' : `Your ${count} imported private keys`;
  return count === 1 ? 'One of your imported private keys' : `${count} of your ${total} imported private keys`;
}

/** "is" / "are", and "it" / "them", for importedKeysSubject's count. */
function verb(count: number): string {
  return count === 1 ? 'is' : 'are';
}
function pronoun(count: number): string {
  return count === 1 ? 'it' : 'them';
}

/**
 * Exactly what is protected and what is not among the imported keys
 * (feature 12): a key's protection follows the phrase's when it is saved,
 * and "Protect with biometrics" moves the rest; anything that could not be
 * moved is named here.
 */
export function importedKeysProtectionNote(s: StorageProtection): string | null {
  const k = s.importedKeys;
  if (!k) return null;
  if (k.damaged) {
    return (
      'The record of imported private keys on this phone could not be read, so where they are kept is ' +
      'unknown. No key was deleted.'
    );
  }
  if (k.total === 0) return null;
  const parts: string[] = [];
  if (k.unreadable > 0) {
    parts.push(
      `${importedKeysSubject(k.unreadable, k.total)} can no longer be opened on this phone after a biometric ` +
        `change; your recovery phrase cannot restore ${pronoun(k.unreadable)}, only a copy you kept yourself can.`,
    );
  }
  if (s.phrase === 'protected' || s.phrase === 'unreadable') {
    if (k.standard > 0) {
      parts.push(
        `${importedKeysSubject(k.standard, k.total)} ${verb(k.standard)} still in standard secure storage, ` +
          'readable by code inside the app while the phone is unlocked.' +
          (s.canProtectNow ? ` Protect with biometrics moves ${pronoun(k.standard)} too.` : ''),
      );
    } else if (k.protected - k.unreadable > 0) {
      const n = k.protected - k.unreadable;
      parts.push(`${importedKeysSubject(n, k.total - k.unreadable)} ${verb(n)} protected by biometrics too.`);
    }
  } else if (s.phrase === 'standard') {
    parts.push(
      `${importedKeysSubject(k.total, k.total)} ${verb(k.total)} in standard secure storage too` +
        (s.canProtectNow ? `; protecting the phrase moves ${pronoun(k.total)} too.` : '.'),
    );
  }
  parts.push('The recovery phrase does not back up imported keys.');
  return parts.join(' ');
}

export function describeProtectionStatus(s: StorageProtection): ProtectionStatusView {
  const importedNote = importedKeysProtectionNote(s);
  const view = (text: string | null, extra: Partial<ProtectionStatusView> = {}): ProtectionStatusView => ({
    text,
    note: null,
    warning: false,
    showProtectButton: s.canProtectNow,
    importedNote,
    ...extra,
  });
  switch (s.phrase) {
    case 'none':
      return view(null, { showProtectButton: false });
    case 'unreadable':
      return view(PHRASE_UNREADABLE_MESSAGE, { warning: true, showProtectButton: false });
    case 'protected':
      return view(protectedText(s.protectedSince), {
        note: s.standardCopyPresent ? STANDARD_COPY_NOTE : null,
        // Offered again only while imported keys remain in standard storage
        // (storage.ts sets canProtectNow for exactly that case).
        showProtectButton: s.canProtectNow,
      });
    case 'standard':
      switch (s.reason) {
        case 'no-strong-biometrics':
          return view(NO_STRONG_BIOMETRICS_TEXT);
        case 'not-attempted':
          return view(NOT_ATTEMPTED_TEXT);
        case 'cancelled':
          return view(CANCELLED_TEXT);
        case 'platform-refused':
          return view(platformRefusedText(s.detail));
        case 'verify-failed':
          return view(verifyFailedText(s.detail));
        case 'reverted':
          return view(REVERTED_TEXT);
        case 'policy-off':
          return view(POLICY_OFF_TEXT);
        default:
          // storage.ts always sets a reason for 'standard'; a missing one
          // reads as the plain standard-storage sentence.
          return view(NOT_ATTEMPTED_TEXT);
      }
    default:
      return view(null, { showProtectButton: false });
  }
}

/** The sentence about imported keys appended to the outcome alert, or ''. */
export function importedKeysOutcomeSentence(r: UpgradeResult): string {
  const k = r.importedKeys;
  if (!k) return '';
  const moved = k.moved > 0 ? ` ${keysWord(k.moved)} also moved into biometric protection.` : '';
  if (k.remaining === 0) return moved;
  const why = k.cancelled ? 'the prompt was cancelled' : `the move did not finish${paren(k.detail)}`;
  return (
    `${moved} ${keysWord(k.remaining)} ${k.remaining === 1 ? 'is' : 'are'} still in standard secure storage ` +
    `because ${why}; Settings shows which, and you can try again.`
  );
}

/** Alert shown after "Protect with biometrics" ran. */
export function describeUpgradeOutcome(r: UpgradeResult): { title: string; message: string } {
  const base = describePhraseUpgradeOutcome(r);
  const extra = importedKeysOutcomeSentence(r);
  if (!extra) return base;
  if (r.outcome === 'already-protected' && r.importedKeys && r.importedKeys.remaining === 0) {
    return { title: 'Imported keys protected', message: extra.trim() };
  }
  return { title: base.title, message: `${base.message}${extra}` };
}

function describePhraseUpgradeOutcome(r: UpgradeResult): { title: string; message: string } {
  switch (r.outcome) {
    case 'protected':
      return {
        title: 'Recovery phrase protected',
        message:
          'Your recovery phrase is now protected by biometrics. Opening it needs your fingerprint or ' +
          'face every time. Keep your written recovery phrase safe.',
      };
    case 'already-protected':
      return { title: 'Already protected', message: 'Your recovery phrase is already protected by biometrics.' };
    case 'cancelled':
      return {
        title: 'Not protected',
        message: `${CANCELLED_TEXT} Nothing changed: the phrase stays in standard secure storage.`,
      };
    case 'platform-refused':
      return { title: 'Not protected', message: platformRefusedText(r.detail) };
    case 'verify-failed':
      return { title: 'Not protected', message: verifyFailedText(r.detail) };
    case 'no-strong-biometrics':
      return { title: 'Not protected', message: NO_STRONG_BIOMETRICS_TEXT };
    case 'policy-off':
      return { title: 'Not protected', message: POLICY_OFF_TEXT };
    case 'no-wallet':
      return { title: 'Not protected', message: 'There is no recovery phrase on this phone to protect.' };
    case 'failed':
    case 'skipped':
    default:
      return {
        title: 'Not protected',
        message:
          `Moving your phrase to biometric protection did not finish${paren(r.detail)}. ` +
          'The status in Settings shows where your phrase is kept now.',
      };
  }
}

/**
 * Alert shown when the Settings reveal could not open the phrase
 * (revealMnemonic() returned null), chosen from a fresh storageProtection()
 * read so the user gets the reason rather than "not found".
 */
export function describeRevealFailure(s: StorageProtection): { title: string; message: string } {
  if (s.phrase === 'unreadable') {
    return { title: 'Recovery phrase unavailable', message: PHRASE_UNREADABLE_MESSAGE };
  }
  if (s.phrase === 'none') {
    return { title: 'Recovery phrase unavailable', message: 'There is no recovery phrase stored on this phone.' };
  }
  if (s.phrase === 'protected') {
    return {
      title: 'Not revealed',
      message:
        'Your recovery phrase could not be opened. If the fingerprint or face prompt was cancelled, ' +
        'try again.',
    };
  }
  return {
    title: 'Not revealed',
    message:
      'Your recovery phrase could not be read from secure storage just now. Try again; your ' +
      'written recovery phrase remains your backup.',
  };
}
