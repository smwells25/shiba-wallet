/**
 * Whether the QR scanner has a camera to show (phase 24 item 4, finding 6:
 * in the iOS Simulator, which has no camera, the scanner showed an empty
 * grey preview and said nothing).
 *
 * How expo-camera 57.0.6 reports a missing camera, read in the installed
 * sources:
 *  - iOS. CameraView.swift 319–324 calls startSessionIfNeeded() when the
 *    view enters a window, and 193–206 then fires onCameraReady whether or
 *    not a camera exists. CameraSessionManager.swift 371–373 and 386–389:
 *    startSession() returns early, with NO onMountError, when
 *    AVCaptureDevice.default(for: .video) is nil. So on iOS the only signal
 *    is the lens list: the view method getAvailableLenses
 *    (CameraViewModule.swift 254–255, CameraView.swift 262–264) returns the
 *    localized names of the discovered cameras on the chosen side
 *    (CameraSessionManager.swift 227–241, DeviceDiscovery.swift 82–108), an
 *    empty list when there is none. The JavaScript wrapper is
 *    CameraView.getAvailableLensesAsync() (build/CameraView.js 86–88).
 *  - Android. ExpoCameraView.kt 440–452: when CameraX cannot bind a camera
 *    the view fires onMountError ("Camera could not be started, it may be
 *    unavailable or in use by another app: …"); onCameraReady fires only
 *    when the camera reports OPEN (658). The Android module defines no
 *    getAvailableLenses view function (CameraViewModule.kt lists only the
 *    event name, line 51), so it is never called there.
 *  - CameraView.isAvailableAsync() is documented "@platform web"
 *    (build/CameraView.d.ts 10–16) and throws UnavailabilityError on native
 *    (build/CameraView.js 54–59), so it is not used.
 *
 * One iOS mount error is not about the camera being missing: "Camera
 * session was reset" (CameraSessionManager.swift 319) comes after the
 * session restarted itself, so it is ignored.
 *
 * Pure (no React Native import), loaded by scripts/check-qr.mjs.
 */

/** Shown in place of the preview when no camera can be used. */
export const QR_NO_CAMERA_MESSAGE =
  'This device has no camera that this app can use, so a QR code cannot be scanned here; paste the text instead.';

/** The iOS mount error sent after the capture session reset itself (not a missing camera). */
export const IOS_SESSION_RESET_MESSAGE = 'Camera session was reset';

export type CameraAvailability = 'checking' | 'available' | 'none';

/** A mount error from CameraView: 'none' with its message as the technical detail, except the iOS session reset. */
export function availabilityAfterMountError(message: unknown): { availability: CameraAvailability; detail: string | null } | null {
  const text = typeof message === 'string' ? message.trim() : '';
  if (text === IOS_SESSION_RESET_MESSAGE) return null;
  return { availability: 'none', detail: text.length > 0 ? text : null };
}

/**
 * After onCameraReady. On iOS the lens list decides (an empty list: no
 * camera); a failed or malformed answer keeps the preview, because it
 * proves nothing. On every other platform onCameraReady means the camera
 * opened.
 */
export async function availabilityAfterReady(platform: string, getLenses: () => Promise<unknown>): Promise<CameraAvailability> {
  if (platform !== 'ios') return 'available';
  let lenses: unknown;
  try {
    lenses = await getLenses();
  } catch {
    return 'available';
  }
  if (Array.isArray(lenses) && lenses.length === 0) return 'none';
  return 'available';
}
