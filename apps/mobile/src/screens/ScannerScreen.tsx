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

// How long the same barcode must be held continuously in frame before it's actually
// queued - a brief accidental glimpse (lining up the shot, a neighbouring disc's barcode
// passing through frame) no longer queues instantly; only a barcode the user is
// deliberately holding steady does.
const COUNTDOWN_MS = 3000;

/**
 * Scan-then-resolve-later (Claude/TECH STACK AND ARCHITECTURE.md): this screen only
 * ever records the barcode and returns to scanning immediately - no network wait, no
 * per-scan lookup, so a free API's daily limit never gates how fast you can physically
 * scan a shelf. Review/confirm happens later in PendingScansScreen.
 *
 * `wasRecentlyQueued`/`markQueued` implement the "don't re-queue the same barcode within
 * 5 minutes" rule - they're owned by App.tsx rather than local state here because this
 * screen unmounts every time you navigate to Pending Scans and back, which would
 * otherwise silently reset the cooldown on every trip to review scans.
 */
export default function ScannerScreen({
  onGoToPending,
  wasRecentlyQueued,
  markQueued,
}: {
  onGoToPending: () => void;
  wasRecentlyQueued: (barcode: string) => boolean;
  markQueued: (barcode: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [lastMessage, setLastMessage] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<{ code: string; secondsLeft: number } | null>(null);
  const busyRef = useRef(false);
  // Tracks the barcode currently held in view - CameraView fires onBarcodeScanned
  // repeatedly (roughly every frame) for as long as the same code stays in shot.
  // `firstSeenAt` drives the hold-steady countdown below; `lastSeenAt` (refreshed every
  // frame) is what decides whether a new sighting is "still the same hold" or "you looked
  // away and came back" (gap since last sighting exceeds SIGHTING_GAP_MS) - a brief gap
  // between frames doesn't reset the countdown, but actually pointing elsewhere does.
  // `queued` stops the countdown from re-firing on every subsequent frame once this
  // exact hold has already been queued.
  const pendingBarcodeRef = useRef<{
    code: string;
    firstSeenAt: number;
    lastSeenAt: number;
    queued: boolean;
  } | null>(null);

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

    const pending = pendingBarcodeRef.current;
    const continuingSameHold =
      pending?.code === barcode && now - pending.lastSeenAt < SIGHTING_GAP_MS;

    if (continuingSameHold) {
      pending.lastSeenAt = now;
    } else {
      // A genuinely new code, or the same code seen again after too long a gap (you
      // pointed away and came back) - either way this is a fresh hold, so the countdown
      // starts over rather than picking up wherever the last one left off.
      pendingBarcodeRef.current = { code: barcode, firstSeenAt: now, lastSeenAt: now, queued: false };
    }
    const current = pendingBarcodeRef.current!;

    if (current.queued) return;

    const elapsed = now - current.firstSeenAt;
    if (elapsed < COUNTDOWN_MS) {
      setCountdown({ code: barcode, secondsLeft: Math.ceil((COUNTDOWN_MS - elapsed) / 1000) });
      return;
    }

    current.queued = true;
    setCountdown(null);

    if (wasRecentlyQueued(barcode)) {
      setLastMessage(`Already queued ${barcode} recently - skipped duplicate scan.`);
      return;
    }

    if (busyRef.current) return;
    busyRef.current = true;

    try {
      await queueScan(barcode);
      markQueued(barcode);
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
        {countdown ? (
          <Text style={styles.countdown}>
            Barcode detected - hold steady... {countdown.secondsLeft}
          </Text>
        ) : (
          lastMessage && <Text style={styles.message}>{lastMessage}</Text>
        )}
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
  countdown: { color: "#fbbf24", textAlign: "center", fontSize: 16, fontWeight: "700" },
  button: {
    backgroundColor: "#0284c7",
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: "center",
  },
  buttonText: { color: "#fff", fontWeight: "600" },
});
