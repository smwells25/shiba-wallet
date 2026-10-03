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
}

export const PROTECT_BUTTON_TITLE = 'Protect with biometrics';
export const PROTECT_CONFIRM_TITLE = 'Protect with biometrics?';
export const PROTECT_CONFIRM_MESSAGE =
  'After this, opening your recovery phrase needs your fingerprint or face. If you ever add or ' +
  'remove a fingerprint or face, or turn off the screen lock, this phone will no longer be able to ' +
  'open the phrase and you will need your written backup. Make sure your written recovery phrase ' +
  'is safe before continuing.';

export const STANDARD_COPY_NOTE =
  'An unprotected copy is still being removed; it goes the next time you approve something.';

/**
 * The date shown in "protected … (since {date})": YYYY-MM-DD, the same
 * form the other Settings status lines use for their check dates.
 */
export function protectionDate(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return 'unknown date';
  return new Date(ms).toISOString().slice(0, 10);
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

export function describeProtectionStatus(s: StorageProtection): ProtectionStatusView {
  const view = (text: string | null, extra: Partial<ProtectionStatusView> = {}): ProtectionStatusView => ({
    text,
    note: null,
    warning: false,
    showProtectButton: s.canProtectNow,
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
        showProtectButton: false,
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

/** Alert shown after "Protect with biometrics" ran. */
export function describeUpgradeOutcome(r: UpgradeResult): { title: string; message: string } {
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
