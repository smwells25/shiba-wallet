import * as LocalAuthentication from 'expo-local-authentication';

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
 * access control (the mnemonic itself stays in expo-secure-store with
 * WHEN_UNLOCKED_THIS_DEVICE_ONLY), not the primary protection, and a
 * device without biometrics must still be able to use the wallet.
 * Note: iOS FaceID does not work in Expo Go; a development build is
 * required to exercise the prompt there.
 */

export type LocalAuthOutcome =
  | { ok: true; gated: boolean }
  | { ok: false; message: string };

export async function requireLocalAuth(promptMessage: string): Promise<LocalAuthOutcome> {
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
