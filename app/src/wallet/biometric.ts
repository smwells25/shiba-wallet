import * as LocalAuthentication from 'expo-local-authentication';
import { openPhraseForApproval, type ApprovalTarget } from './storage';

/**
 * Local-authentication gate for the two sensitive actions in the app: the
 * Settings seed-phrase reveal and the final send confirmation.
 *
 * API per the expo-local-authentication SDK 57 reference
 * (docs.expo.dev/versions/v57.0.0/sdk/local-authentication, fetched
 * 2026-09-27): hasHardwareAsync() reports whether a face/fingerprint
 * scanner exists, isEnrolledAsync() whether biometric data is enrolled,
 * and authenticateAsync() resolves to { success } or { success: false,
 * error }. disableDeviceFallback is deliberately false: per the docs,
 * "after several failed attempts, the system falls back to the device
 * passcode", so a user whose biometric reads fail can still authenticate
 * with their OS PIN/passcode instead of being locked out.
 *
 * Behavior matrix (documented for reviewers):
 *   hardware yes, enrolled yes -> biometric prompt, with OS passcode
 *                                 fallback after failed attempts
 *   hardware yes, enrolled no  -> no prompt; action proceeds (gated: false)
 *   hardware no,  enrolled --  -> no prompt; action proceeds (gated: false)
 *   module errors/unavailable  -> no prompt; action proceeds (gated: false)
 *
 * Proceeding without a prompt on unequipped devices is intentional: the
 * gate is defense in depth on top of the OS device lock and secure-store
 * access control, not the primary protection, and a device without
 * biometrics must still be able to use the wallet.
 * Note: iOS FaceID does not work in Expo Go; a development build is
 * required to exercise the prompt there.
 *
 * PROTECTED PHRASE (threat-model N-01, ./storage.ts): when the recovery
 * phrase is held in biometric-protected secure storage, reading it raises
 * the SYSTEM prompt by itself. Showing this module's prompt first and then
 * the system prompt would ask twice for one operation. So requireLocalAuth
 * first asks ./storage.ts openPhraseForApproval(promptMessage):
 *
 *   - protected phrase opened (one system prompt, the user's verification)
 *     → { ok: true, gated: true }; the opened phrase is held for at most
 *     30 s, for one use, by the signing call that follows (signWith,
 *     revealMnemonic), which then does not prompt again;
 *   - system prompt cancelled → { ok: false }, as before;
 *   - anything else (standard storage, nothing to open, a lockout, an
 *     invalidated key) → this module's own prompt, exactly as before.
 *
 * Every call site keeps calling requireLocalAuth unchanged (defense in
 * depth: the app-level gate still exists, it is just satisfied by the
 * system prompt when one is unavoidable anyway). Two consequences, both
 * deliberate: (1) with a protected phrase the approval is biometric-only —
 * the system prompt of a protected secure-store item has no PIN fallback
 * on either platform; if it fails for a reason other than a cancel (e.g. a
 * lockout) the ordinary prompt with the passcode fallback still unlocks the
 * screen, but signing needs the biometric; (2) gates that do not sign (the
 * lock screen) also open the phrase briefly; the held copy is dropped after
 * 30 s or when the app goes to the background.
 *
 * Existing installs are moved into protected storage at their first
 * approval after the update (policy 'automatic' in ./storage.ts): that
 * approval shows the protection prompts instead (Android: two — the
 * protected write and the read-back check; iOS: one). If the user cancels
 * them, the phrase stays where it was and the ordinary prompt is shown for
 * the action they started.
 */

export type LocalAuthOutcome =
  | { ok: true; gated: boolean }
  | { ok: false; message: string };

/**
 * True when a local-auth prompt would actually appear (hardware present
 * AND biometrics enrolled). Used by the auto-lock feature (phase 4, item
 * 5.1): on devices where this is false the auto-lock setting is hidden in
 * Settings — requireLocalAuth would proceed ungated there, so an
 * "auto-lock" would be an empty ritual. No custom PIN pad substitutes for
 * it, deliberately: see the decision note in wallet/lock.ts.
 */
export async function localAuthAvailable(): Promise<boolean> {
  try {
    return (
      (await LocalAuthentication.hasHardwareAsync()) &&
      (await LocalAuthentication.isEnrolledAsync())
    );
  } catch {
    return false;
  }
}

/**
 * IMPORTED KEYS (feature 12): the vault opens the ACTIVE account's secret —
 * the phrase, or the active imported account's key (WalletContext sets the
 * approval target on every account change). `target` overrides that for a
 * gate that is about a different secret, e.g. revealing the recovery
 * phrase while an imported account is active, so the one prompt opens the
 * secret that is actually used.
 */
export async function requireLocalAuth(promptMessage: string, target?: ApprovalTarget): Promise<LocalAuthOutcome> {
  try {
    const vault = await openPhraseForApproval(promptMessage, target);
    if (vault.kind === 'authenticated') return { ok: true, gated: true };
    if (vault.kind === 'cancelled') return { ok: false, message: 'Authentication cancelled.' };
  } catch {
    // Fall through to the ordinary prompt.
  }

  let available = false;
  try {
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    available = hasHardware && (await LocalAuthentication.isEnrolledAsync());
  } catch {
    available = false;
  }
  if (!available) return { ok: true, gated: false };

  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage,
      disableDeviceFallback: false,
      cancelLabel: 'Cancel',
    });
    if (result.success) return { ok: true, gated: true };
    return {
      ok: false,
      message:
        result.error === 'user_cancel' || result.error === 'app_cancel'
          ? 'Authentication cancelled.'
          : `Authentication failed (${result.error}).`,
    };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : 'Authentication failed.',
    };
  }
}
