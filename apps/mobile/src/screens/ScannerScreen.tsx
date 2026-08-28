import { useRef, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { queueScan } from "../lib/scanApi";

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
  const lastBarcodeRef = useRef<{ code: string; at: number } | null>(null);

  if (!permission) {
    return <View style={styles.container} />;
  }

  if (!permission.granted) {
    return (
      <View style={styles.container}>
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
    // Debounce: ignore the same barcode re-firing within 3s (CameraView keeps scanning
    // the same frame while it's in view) and ignore anything while a queue call is in flight.
    if (busyRef.current) return;
    if (lastBarcodeRef.current?.code === barcode && now - lastBarcodeRef.current.at < 3000) return;
    lastBarcodeRef.current = { code: barcode, at: now };
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
  container: { flex: 1, backgroundColor: "#000", justifyContent: "center", alignItems: "center", padding: 24, gap: 16 },
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
