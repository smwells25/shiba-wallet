import React, { useEffect, useRef } from 'react';
import { Modal, StyleSheet, Text, View } from 'react-native';
// expo-camera 57.0.5 (SDK 57). API names verified against BOTH the SDK 57
// docs (docs.expo.dev/versions/v57.0.0/sdk/camera, fetched 2026-09-27) and
// this installed package's own typings (node_modules/expo-camera/build/
// index.d.ts + Camera.types.d.ts): CameraView, useCameraPermissions,
// barcodeScannerSettings={{ barcodeTypes: ['qr'] }}, and
// onBarcodeScanned(result: BarcodeScanningResult) where result.data is the
// decoded string. The docs' platform list includes Expo Go, and expo-camera
// is bundled in the Expo Go SDK 57 client (expo/expo repo,
// apps/expo-go/package.json on the sdk-57 branch), so scanning works in
// Expo Go — no dev build required. The older expo-barcode-scanner package
// is deprecated and deliberately not used.
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { Button } from '../components';
import { useTheme } from '../theme';

/**
 * Full-screen QR scanning modal. Purely a convenience layer: every caller
 * keeps its paste path working, so a device without a camera, a denied
 * permission, or Expo Go quirks never block a feature — the modal explains
 * calmly and the user pastes instead.
 *
 * The camera permission is requested only after the user opens the scanner
 * (never at app start), with `rationale` shown first in plain language so
 * the OS prompt is never a surprise.
 */
export function QrScanner({
  visible,
  rationale,
  onScanned,
  onClose,
}: {
  visible: boolean;
  /** Plain-language line shown above the permission request / camera. */
  rationale: string;
  /** Called once with the decoded QR string; the caller closes the modal. */
  onScanned: (data: string) => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  // onBarcodeScanned fires repeatedly while a code stays in view; deliver
  // only the first hit per open. Reset whenever the modal closes.
  const deliveredRef = useRef(false);
  useEffect(() => {
    if (!visible) deliveredRef.current = false;
  }, [visible]);

  const onBarcode = (result: BarcodeScanningResult) => {
    if (deliveredRef.current) return;
    const data = typeof result.data === 'string' ? result.data.trim() : '';
    if (!data) return;
    deliveredRef.current = true;
    onScanned(data);
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.container, { backgroundColor: theme.background }]}>
        <Text style={[styles.rationale, { color: theme.text }]}>{rationale}</Text>

        {permission === null ? null : permission.granted ? (
          <View style={styles.cameraBox}>
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={onBarcode}
            />
            {/* Simple aim frame; the scanner reads the whole preview. */}
            <View pointerEvents="none" style={styles.frame} />
          </View>
        ) : permission.canAskAgain ? (
          <View style={styles.messageBox}>
            <Text style={[styles.message, { color: theme.textMuted }]}>
              The camera is used only while this scanner is open, and only to
              read the QR code — no photos are taken or stored.
            </Text>
            <Button title="Allow camera access" onPress={() => void requestPermission()} />
          </View>
        ) : (
          <View style={styles.messageBox}>
            <Text style={[styles.message, { color: theme.textMuted }]}>
              Camera access is turned off for this app in the system
              settings. That's fine — scanning is only a convenience. Close
              this and paste the text instead, or enable the camera in your
              device settings and come back.
            </Text>
          </View>
        )}

        <Button title="Cancel" variant="secondary" onPress={onClose} />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 24,
    paddingTop: 64,
    gap: 20,
  },
  rationale: {
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
  },
  cameraBox: {
    flex: 1,
    borderRadius: 16,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  frame: {
    width: 220,
    height: 220,
    borderRadius: 18,
    borderWidth: 3,
    borderColor: 'rgba(255,255,255,0.85)',
  },
  messageBox: {
    flex: 1,
    justifyContent: 'center',
    gap: 16,
  },
  message: {
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'center',
  },
});
