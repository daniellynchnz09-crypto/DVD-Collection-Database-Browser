import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { cancelScanSession, finishScanSession, uploadCoverPhoto } from "../lib/scanApi";
import { clearConfirmDraft } from "../lib/confirmDrafts";
import { createScanSessionId } from "../lib/scanSession";
import { computeCoverCropRegion } from "../lib/coverGuide";
import CoverCaptureGuide from "../components/CoverCaptureGuide";
import OfflineBanner from "../components/OfflineBanner";

// Manual-tap countdown before a cover photo is actually captured - visually the same "3...2...1"
// style the barcode scanner used to show automatically, but triggered by a deliberate "Capture"
// tap here rather than a hold-steady detector, since there's no automatic "aligned" signal to
// key off (see this screen's own header comment).
const COVER_COUNTDOWN_SECONDS = 3;

interface ScanSession {
  sessionId: string;
  barcode: string | null;
  stagedCoverPaths: string[];
}

function freshSession(): ScanSession {
  return { sessionId: createScanSessionId(), barcode: null, stagedCoverPaths: [] };
}

type CaptureMode = "scanning" | "positioningCover" | "coverCountdown";

/**
 * Cover-photo scanning (2026-09-28) turned this screen from "instantly queue whatever barcode
 * you're pointing at" into "accumulate one scan session - a barcode and/or staged cover photos -
 * until you tap Done." Barcode capture became manual-tap too in the same change: since cover
 * capture already needs a deliberate "Capture" tap (there's no automatic way to know a cover
 * photo is well-aligned), the barcode side adopts the same interaction rather than running two
 * different capture paradigms side by side. The previous hold-steady countdown (guarding against
 * a brief accidental glimpse of a neighbouring disc's barcode while lining up a shot) is gone
 * entirely - `onBarcodeScanned` is now just a live "Detected: <code>" readout, and a manual
 * "Capture Barcode" button commits it instantly. There's no motion-blur/exposure concern here
 * the way there is for a real photo, so no countdown is needed on this side.
 *
 * Cover capture ("Scan Cover") is a repeatable mini-flow within the same session - tap it once
 * for the front, once for the back, in either order, as many times as needed: `captureMode`
 * swaps the whole bottom overlay to a static alignment guide (CoverCaptureGuide.tsx) + a manual
 * "Capture" button; tapping it starts a plain timer countdown, then takes the photo, crops it to
 * the guide's own fixed rectangle (coverGuide.ts - deterministic, content-blind, not a smart
 * crop), and uploads it to temporary staging (uploadCoverPhoto). The screen never asks which
 * side was just photographed - front/back classification happens automatically, server-side,
 * during resolution (coverVision.ts), never at capture time. While `captureMode !== "scanning"`,
 * `handleBarcodeScanned` short-circuits so the two capture modes never race on the same
 * CameraView instance.
 *
 * "Done" (enabled once a barcode or any staged cover exists) finishes the whole session in one
 * call (finishScanSession) and resets session state. "Cancel Session" explicitly cleans up any
 * staged photos for a session abandoned without finishing.
 *
 * `wasRecentlyQueued`/`markQueued` implement the "don't re-queue the same barcode within
 * 5 minutes" rule - they're owned by App.tsx rather than local state here because this
 * screen unmounts every time you navigate to Pending Scans and back, which would
 * otherwise silently reset the cooldown on every trip to review scans. The check now runs
 * at "Capture Barcode" tap time rather than at Done, since it's about the same barcode being
 * re-captured within a manual gesture, not about session completion.
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
  const cameraRef = useRef<CameraView>(null);
  const [session, setSession] = useState<ScanSession>(freshSession);
  const [detectedBarcode, setDetectedBarcode] = useState<string | null>(null);
  const [lastMessage, setLastMessage] = useState<string | null>(null);
  const [captureMode, setCaptureMode] = useState<CaptureMode>("scanning");
  const [coverCountdown, setCoverCountdown] = useState(COVER_COUNTDOWN_SECONDS);
  const [coverBusy, setCoverBusy] = useState(false);
  const busyRef = useRef(false);

  // Ticks the cover-capture countdown down once a second, then actually takes the photo once
  // it reaches zero. A plain timer, not tied to any live "is it aligned" signal - see this
  // screen's own header comment on why there's no automatic detection to key off here.
  useEffect(() => {
    if (captureMode !== "coverCountdown") return;
    if (coverCountdown <= 0) {
      handleCaptureCoverPhoto();
      return;
    }
    const timeout = setTimeout(() => setCoverCountdown((n) => n - 1), 1000);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captureMode, coverCountdown]);

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

  function handleBarcodeScanned(result: BarcodeScanningResult) {
    if (captureMode !== "scanning") return;
    setDetectedBarcode(result.data);
  }

  function handleCaptureBarcode() {
    if (!detectedBarcode) return;
    if (wasRecentlyQueued(detectedBarcode)) {
      setLastMessage(`Already queued ${detectedBarcode} recently - skipped duplicate scan.`);
      return;
    }
    setSession((prev) => ({ ...prev, barcode: detectedBarcode }));
    setLastMessage(`Captured barcode ${detectedBarcode}.`);
  }

  function handleStartCoverCapture() {
    setCaptureMode("positioningCover");
  }

  function handleCancelCoverCapture() {
    setCaptureMode("scanning");
    setCoverCountdown(COVER_COUNTDOWN_SECONDS);
  }

  function handleStartCoverCountdown() {
    setCoverCountdown(COVER_COUNTDOWN_SECONDS);
    setCaptureMode("coverCountdown");
  }

  async function handleCaptureCoverPhoto() {
    if (!cameraRef.current) {
      setCaptureMode("scanning");
      return;
    }
    setCoverBusy(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.9 });
      if (!photo) throw new Error("No photo returned");

      const region = computeCoverCropRegion(photo.width, photo.height);
      const cropped = await manipulateAsync(photo.uri, [{ crop: region }], {
        compress: 0.85,
        format: SaveFormat.JPEG,
        base64: true,
      });
      if (!cropped.base64) throw new Error("Crop produced no image data");

      const { stagedPath } = await uploadCoverPhoto(session.sessionId, cropped.base64, "image/jpeg");
      setSession((prev) => ({ ...prev, stagedCoverPaths: [...prev.stagedCoverPaths, stagedPath] }));
      setLastMessage(`Cover photo captured (${session.stagedCoverPaths.length + 1} this session).`);
    } catch (err) {
      setLastMessage(`Failed to capture cover photo: ${(err as Error).message}`);
    } finally {
      setCoverBusy(false);
      setCaptureMode("scanning");
    }
  }

  async function handleDone() {
    if (!session.barcode && session.stagedCoverPaths.length === 0) return;
    if (busyRef.current) return;
    busyRef.current = true;

    try {
      const { replacedIds } = await finishScanSession(session.barcode, session.stagedCoverPaths);
      // Any old, still-unfinished pending scan for this same barcode was just deleted
      // server-side in favor of this fresh one - its local autosaved draft, if any, can
      // never be reopened again, so it must be cleared here too, not just left orphaned.
      replacedIds.forEach(clearConfirmDraft);
      if (session.barcode) markQueued(session.barcode);
      setLastMessage("Scan session finished - queued for lookup.");
      setSession(freshSession());
      setDetectedBarcode(null);
    } catch (err) {
      setLastMessage(`Failed to finish scan session: ${(err as Error).message}`);
    } finally {
      busyRef.current = false;
    }
  }

  async function handleCancelSession() {
    const { sessionId } = session;
    setSession(freshSession());
    setDetectedBarcode(null);
    setLastMessage("Scan session cancelled.");
    try {
      await cancelScanSession(sessionId);
    } catch {
      // Best-effort - see cover-photo/route.ts's DELETE handler comment. A leaked staging
      // file is recoverable; not letting the user start a fresh session isn't worth blocking on.
    }
  }

  const hasCapture = Boolean(session.barcode) || session.stagedCoverPaths.length > 0;

  return (
    <View style={styles.container}>
      <CameraView
        ref={cameraRef}
        style={styles.camera}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["ean13", "upc_a", "upc_e"] }}
        onBarcodeScanned={handleBarcodeScanned}
      />
      <View style={[styles.topOverlay, { top: insets.top }]}>
        <OfflineBanner />
      </View>

      {captureMode === "scanning" ? (
        <View style={[styles.overlay, { paddingBottom: 20 + insets.bottom }]}>
          <Text style={styles.hint}>Point the camera at the disc case's barcode</Text>
          {detectedBarcode && <Text style={styles.message}>Detected: {detectedBarcode}</Text>}
          {session.barcode && <Text style={styles.captured}>Barcode captured: {session.barcode}</Text>}
          {session.stagedCoverPaths.length > 0 && (
            <Text style={styles.captured}>
              Cover photos captured: {session.stagedCoverPaths.length}
            </Text>
          )}
          {lastMessage && <Text style={styles.message}>{lastMessage}</Text>}

          <View style={styles.row}>
            <TouchableOpacity
              style={[styles.button, styles.rowButton, !detectedBarcode && styles.buttonDisabled]}
              onPress={handleCaptureBarcode}
              disabled={!detectedBarcode}
            >
              <Text style={styles.buttonText}>Capture Barcode</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.button, styles.rowButton, styles.coverButton]}
              onPress={handleStartCoverCapture}
            >
              <Text style={styles.buttonText}>Scan Cover</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.row}>
            <TouchableOpacity
              style={[styles.button, styles.doneButton, !hasCapture && styles.buttonDisabled]}
              onPress={handleDone}
              disabled={!hasCapture}
            >
              <Text style={styles.buttonText}>Done</Text>
            </TouchableOpacity>
            {hasCapture && (
              <TouchableOpacity style={[styles.button, styles.cancelButton]} onPress={handleCancelSession}>
                <Text style={styles.buttonText}>Cancel Session</Text>
              </TouchableOpacity>
            )}
          </View>

          <TouchableOpacity style={styles.button} onPress={onGoToPending}>
            <Text style={styles.buttonText}>Review Pending Scans</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          <CoverCaptureGuide />
          <View style={[styles.overlay, { paddingBottom: 20 + insets.bottom }]}>
            {captureMode === "positioningCover" ? (
              <>
                <Text style={styles.hint}>
                  Line up the front or back cover within the guide, then tap Capture
                </Text>
                <TouchableOpacity style={styles.button} onPress={handleStartCoverCountdown}>
                  <Text style={styles.buttonText}>Capture</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.button, styles.cancelButton]} onPress={handleCancelCoverCapture}>
                  <Text style={styles.buttonText}>Back</Text>
                </TouchableOpacity>
              </>
            ) : (
              <Text style={styles.countdown}>
                {coverBusy ? "Capturing..." : `Hold steady... ${coverCountdown}`}
              </Text>
            )}
          </View>
        </>
      )}
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
  topOverlay: { position: "absolute", left: 0, right: 0 },
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
  captured: { color: "#4ade80", textAlign: "center", fontWeight: "600" },
  countdown: { color: "#fbbf24", textAlign: "center", fontSize: 16, fontWeight: "700" },
  row: { flexDirection: "row", gap: 10 },
  rowButton: { flex: 1 },
  button: {
    backgroundColor: "#0284c7",
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: "center",
  },
  buttonDisabled: { opacity: 0.4 },
  coverButton: { backgroundColor: "#7c3aed" },
  doneButton: { flex: 1, backgroundColor: "#16a34a" },
  cancelButton: { flex: 1, backgroundColor: "#dc2626" },
  buttonText: { color: "#fff", fontWeight: "600" },
});
