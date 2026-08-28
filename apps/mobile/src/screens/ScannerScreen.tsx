import { useRef, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { queueScan } from "../lib/scanApi";

// How long a gap in sightings of the same barcode means "you moved away and came back"
// rather than "still holding it in frame." Comfortably longer than the ~1s interval
// CameraView re-fires at, short enough that deliberately rescanning the same disc later
// still works normally.
const SIGHTING_GAP_MS = 2000;

/**
 * Scan-then-resolve-later (Claude/TECH STACK AND ARCHITECTURE.md): this screen only
 * ever records the barcode and returns to scanning immediately - no network wait, no
 * per-scan lookup, so a free API's daily limit never gates how fast you can physically
 * scan a shelf. Review/confirm happens later in PendingScansScreen.
 */
export default function ScannerScreen({ onGoToPending }: { onGoToPending: () => void }) {
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [lastMessage, setLastMessage] = useState<string | null>(null);
  const busyRef = useRef(false);
  // Tracks the barcode currently held in view, not just "recently scanned" - CameraView
  // fires onBarcodeScanned repeatedly (roughly every frame) for as long as the same code
  // stays in shot, so a fixed cooldown re-arms and re-queues the same disc over and over
  // while you're just holding it steady. Only queue again once the gap since the last
  // sighting of this code exceeds SIGHTING_GAP_MS - i.e. you actually pointed away and
  // came back, not "3 seconds passed while continuously staring at the same barcode."
  const activeBarcodeRef = useRef<{ code: string; lastSeenAt: number } | null>(null);

  if (!permission) {
    return <View style={styles.container} />;
  }

  if (!permission.granted) {
    return (
      <View style={styles.permissionContainer}>
        <Text style={styles.message}>Camera access is needed to scan disc barcodes.</Text>
        <TouchableOpacity style={styles.button} onPress={requestPermission}>
          <Text style={styles.buttonText}>Grant Camera Access</Text>
        </TouchableOpacity>
      </View>
    );
  }

  async function handleBarcodeScanned(result: BarcodeScanningResult) {
    const barcode = result.data;
    const now = Date.now();

    // Refresh the "still holding this code" clock on every single frame, independent of
    // busyRef below - otherwise a slow network call could let the clock go stale and
    // cause one spurious re-queue right as the busy window clears.
    const active = activeBarcodeRef.current;
    const stillHoldingSameCode =
      active?.code === barcode && now - active.lastSeenAt < SIGHTING_GAP_MS;
    activeBarcodeRef.current = { code: barcode, lastSeenAt: now };
    if (stillHoldingSameCode) return;

    if (busyRef.current) return;
    busyRef.current = true;

    try {
      await queueScan(barcode);
      setLastMessage(`Scanned ${barcode} - queued for lookup.`);
    } catch (err) {
      setLastMessage(`Failed to queue ${barcode}: ${(err as Error).message}`);
    } finally {
      setTimeout(() => {
        busyRef.current = false;
      }, 800);
    }
  }

  return (
    <View style={styles.container}>
      <CameraView
        style={styles.camera}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["ean13", "upc_a", "upc_e"] }}
        onBarcodeScanned={handleBarcodeScanned}
      />
      <View style={[styles.overlay, { paddingBottom: 20 + insets.bottom }]}>
        <Text style={styles.hint}>Point the camera at the disc case's barcode</Text>
        {lastMessage && <Text style={styles.message}>{lastMessage}</Text>}
        <TouchableOpacity style={styles.button} onPress={onGoToPending}>
          <Text style={styles.buttonText}>Review Pending Scans</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  permissionContainer: {
    flex: 1,
    backgroundColor: "#000",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
    gap: 16,
  },
  camera: { flex: 1 },
  overlay: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    padding: 20,
    gap: 10,
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  hint: { color: "#e4e4e7", textAlign: "center" },
  message: { color: "#38bdf8", textAlign: "center" },
  button: {
    backgroundColor: "#0284c7",
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: "center",
  },
  buttonText: { color: "#fff", fontWeight: "600" },
});
