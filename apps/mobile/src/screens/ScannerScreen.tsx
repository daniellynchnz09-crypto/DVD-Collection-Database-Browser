import { useCallback, useEffect, useRef, useState } from "react";
import { Modal, StyleSheet, Switch, Text, TouchableOpacity, View } from "react-native";
import { CameraView, scanFromURLAsync, useCameraPermissions, type BarcodeScanningResult, type BarcodeType } from "expo-camera";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { cancelScanSession, fetchUpcQuotaStatus, finishScanSession, uploadCoverPhoto } from "../lib/scanApi";
import { useScannerSettings } from "../lib/scannerSettings";
import { clearConfirmDraft } from "../lib/confirmDrafts";
import { createScanSessionId } from "../lib/scanSession";
import OfflineBanner from "../components/OfflineBanner";
import { CHROME_BAR, COLORS, FONTS, GLOSS, PANEL } from "../theme";

interface ScanSession {
  sessionId: string;
  barcode: string | null;
  stagedCoverPaths: string[];
}

function freshSession(): ScanSession {
  return { sessionId: createScanSessionId(), barcode: null, stagedCoverPaths: [] };
}

type CaptureMode = "scanning" | "positioningCover";

const BARCODE_TYPES: BarcodeType[] = ["ean13", "upc_a", "upc_e"];

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
 * swaps the whole bottom overlay to a plain "Capture"/"Back" button pair (no on-screen framing
 * guide any more - see below); tapping Capture takes the photo immediately and uploads the raw,
 * uncropped bytes straight to temporary staging (uploadCoverPhoto). The screen never asks which
 * side was just photographed - front/back classification happens automatically, server-side,
 * during resolution (coverVision.ts), never at capture time. While `captureMode !== "scanning"`,
 * `handleBarcodeScanned` short-circuits so the two capture modes never race on the same
 * CameraView instance.
 *
 * Cropping moved server-side entirely as of 2026-09-29 (packages/backend/src/scanResolver.ts's
 * analyzeStagedCoverPhotos, via coverVision.ts's detectCoverBoundingBox) - the previous
 * client-side fixed-guide-rectangle crop (CoverCaptureGuide.tsx + coverGuide.ts, now deleted)
 * only ever trimmed a thin, content-blind border regardless of where the case actually was in
 * frame, which the user found "obviously isn't working" once a real photo showed plenty of
 * background surviving the crop. The on-screen guide overlay was removed outright rather than
 * kept as a non-functional aiming aid, per the user's own explicit choice.
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
 *
 * Automatic barcode capture (2026-10-04, per the user's own request): a barcode found on the
 * case while photographing its covers joins the scan automatically when Done is tapped - no
 * "Capture Barcode" tap needed. Two sources, since neither is reliable alone: the camera's live
 * barcode detector while a cover is being lined up (`positioningCover`), and
 * `scanFromURLAsync` run on each captured cover photo (Expo's own docs warn Android reads a
 * barcode from a still image best when it fills most of the frame, so a whole back cover can
 * miss). Only detections made while photographing covers count - a barcode merely glimpsed in
 * plain scanning mode still needs the manual tap, so a neighbouring disc's barcode can't sneak
 * in. The found code is shown before Done with a "Don't add it" option. Turned off when the
 * UPC lookup quota is used up (no credits left to spend on it), and by the persisted
 * "Manual barcode capture only" setting (scannerSettings.ts), which restores the old
 * manual-only behaviour so the user can choose not to spend UPC credits automatically.
 *
 * Focus: `expo-camera` (plain Expo Go, no native module) exposes no manual focus-distance/lens
 * API on either platform, only an on/off `autofocus` toggle - and Android's "off" isn't a no-op,
 * it actively freezes whatever focus distance the lens already had (`cancelFocusAndMetering`).
 * `focusLocked` drives that toggle: continuous autofocus (`"on"`) runs the whole time the user
 * is lining a shot up, then flips to locked (`"off"`) for a brief 250ms pause right before
 * `takePictureAsync` fires, so autofocus can't hunt for a new distance at the exact moment of
 * exposure. It resets back to `"on"` once the capture finishes (success or failure) so the next
 * positioning phase - or plain barcode scanning - gets continuous autofocus again.
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
  const [coverBusy, setCoverBusy] = useState(false);
  const [focusLocked, setFocusLocked] = useState(false);
  const busyRef = useRef(false);
  const { settings, loaded: settingsLoaded, update: updateSettings } = useScannerSettings();
  const [showSettings, setShowSettings] = useState(false);
  // Barcode found automatically while photographing covers (see the header comment), plus any
  // code the user said not to add, so the live detector doesn't immediately re-add it.
  const [autoBarcode, setAutoBarcode] = useState<string | null>(null);
  const [dismissedAutoBarcode, setDismissedAutoBarcode] = useState<string | null>(null);
  // null until the first quota check returns (or if it fails) - treated as "available".
  const [upcRemaining, setUpcRemaining] = useState<number | null>(null);
  const refreshUpcQuota = useCallback(() => {
    fetchUpcQuotaStatus()
      .then(({ quota }) => setUpcRemaining(quota.remaining))
      .catch(() => {});
  }, []);
  useEffect(() => {
    refreshUpcQuota();
  }, [refreshUpcQuota]);
  const upcQuotaExhausted = upcRemaining !== null && upcRemaining <= 0;
  const autoBarcodeEnabled = settingsLoaded && !settings.manualBarcodeCaptureOnly && !upcQuotaExhausted;

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

  function noteAutoBarcode(code: string) {
    if (!autoBarcodeEnabled || session.barcode || code === dismissedAutoBarcode) return;
    setAutoBarcode(code);
  }

  function handleBarcodeScanned(result: BarcodeScanningResult) {
    if (captureMode === "positioningCover") {
      noteAutoBarcode(result.data);
      return;
    }
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
  }

  async function handleCaptureCoverPhoto() {
    if (!cameraRef.current) {
      setCaptureMode("scanning");
      return;
    }
    setCoverBusy(true);
    try {
      // Lock focus just before the shutter fires rather than leaving continuous autofocus
      // running through the capture itself - autofocus can otherwise decide to hunt for a new
      // focus distance at the exact moment of exposure, blurring an otherwise well-aligned shot.
      // A short pause gives the native focus-lock time to actually take effect before capturing.
      setFocusLocked(true);
      await new Promise((resolve) => setTimeout(resolve, 250));

      const photo = await cameraRef.current.takePictureAsync({ quality: 0.9, shutterSound: false, base64: true });
      if (!photo) throw new Error("No photo returned");
      if (!photo.base64) throw new Error("Capture produced no image data");

      // Second automatic-barcode source (see header comment) - best-effort, never blocks the photo.
      if (autoBarcodeEnabled && !session.barcode && photo.uri) {
        try {
          const found = await scanFromURLAsync(photo.uri, BARCODE_TYPES);
          if (found[0]?.data) noteAutoBarcode(found[0].data);
        } catch {
          // No barcode read from this photo - the live detector may still have one.
        }
      }

      const { stagedPath } = await uploadCoverPhoto(session.sessionId, photo.base64, "image/jpeg");
      setSession((prev) => ({ ...prev, stagedCoverPaths: [...prev.stagedCoverPaths, stagedPath] }));
      setLastMessage(`Cover photo captured (${session.stagedCoverPaths.length + 1} this session).`);
    } catch (err) {
      setLastMessage(`Failed to capture cover photo: ${(err as Error).message}`);
    } finally {
      setCoverBusy(false);
      setFocusLocked(false);
      setCaptureMode("scanning");
    }
  }

  async function handleDone() {
    if (!session.barcode && session.stagedCoverPaths.length === 0) return;
    if (busyRef.current) return;
    busyRef.current = true;

    try {
      // A manually captured barcode always wins; otherwise the automatically found one is
      // added now, at Done (skipped if the same code was queued in the last few minutes).
      let barcode = session.barcode;
      let autoNote = "";
      if (!barcode && autoBarcode && autoBarcodeEnabled) {
        if (wasRecentlyQueued(autoBarcode)) autoNote = ` (barcode ${autoBarcode} was queued recently - left off)`;
        else {
          barcode = autoBarcode;
          autoNote = ` with barcode ${autoBarcode}`;
        }
      }
      const { replacedIds } = await finishScanSession(barcode, session.stagedCoverPaths);
      // Any old, still-unfinished pending scan for this same barcode was just deleted
      // server-side in favor of this fresh one - its local autosaved draft, if any, can
      // never be reopened again, so it must be cleared here too, not just left orphaned.
      replacedIds.forEach(clearConfirmDraft);
      if (barcode) markQueued(barcode);
      setLastMessage(`Scan session finished${autoNote} - queued for lookup.`);
      setSession(freshSession());
      setDetectedBarcode(null);
      setAutoBarcode(null);
      setDismissedAutoBarcode(null);
      // The resolver spends a UPC lookup on a barcode scan - re-check shortly afterwards so
      // auto-capture switches itself off once the quota actually runs out.
      if (barcode) setTimeout(refreshUpcQuota, 20000);
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
    setAutoBarcode(null);
    setDismissedAutoBarcode(null);
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
        autofocus={focusLocked ? "off" : "on"}
        barcodeScannerSettings={{ barcodeTypes: ["ean13", "upc_a", "upc_e"] }}
        onBarcodeScanned={handleBarcodeScanned}
      />
      <View style={[styles.topOverlay, { top: 0 }]}>
        {/* The website's header: logo left, settings right, on a brushed-metal strip. It
            starts at the very top of the screen and pads down past the camera cut-out, so
            the strip fills that gap while the logo sits where it always did. */}
        <View style={[styles.brandBar, { paddingTop: insets.top + 8 }]}>
          <View style={styles.brandMark} />
          <Text style={styles.brandText}>
            DANFLIX<Text style={styles.brandVersion}> 5.0</Text>
          </Text>
          <TouchableOpacity style={styles.settingsButton} onPress={() => setShowSettings(true)} hitSlop={10}>
            <Text style={styles.settingsButtonText}>Settings</Text>
          </TouchableOpacity>
        </View>
        <OfflineBanner />
      </View>

      <Modal visible={showSettings} transparent animationType="fade" onRequestClose={() => setShowSettings(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Scanner settings</Text>
            <View style={styles.settingRow}>
              <Text style={styles.settingLabel}>Manual barcode capture only</Text>
              <Switch
                value={settings.manualBarcodeCaptureOnly}
                onValueChange={(value) => updateSettings({ manualBarcodeCaptureOnly: value })}
              />
            </View>
            <Text style={styles.settingHint}>
              Off: a barcode spotted while you photograph the covers is added to the scan automatically when you tap
              Done (each one uses a UPC lookup credit). On: a barcode is only added when you tap Capture Barcode.
            </Text>
            {upcRemaining !== null && <Text style={styles.settingHint}>UPC lookups left today: {upcRemaining}</Text>}
            <TouchableOpacity style={styles.button} onPress={() => setShowSettings(false)}>
              <Text style={styles.buttonText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {captureMode === "scanning" ? (
        <View style={[styles.overlay, { paddingBottom: 20 + insets.bottom }]}>
          <Text style={styles.hint}>Point the camera at the disc case's barcode</Text>
          {detectedBarcode && <Text style={styles.message}>Detected: {detectedBarcode}</Text>}
          {session.barcode && <Text style={styles.captured}>Barcode captured: {session.barcode}</Text>}
          {!session.barcode && autoBarcode && autoBarcodeEnabled && (
            <View style={styles.autoBarcodeRow}>
              <Text style={styles.captured}>Barcode found on the case: {autoBarcode} - added when you tap Done</Text>
              <TouchableOpacity
                onPress={() => {
                  setDismissedAutoBarcode(autoBarcode);
                  setAutoBarcode(null);
                }}
              >
                <Text style={styles.link}>Don&apos;t add it</Text>
              </TouchableOpacity>
            </View>
          )}
          {upcQuotaExhausted && !settings.manualBarcodeCaptureOnly && (
            <Text style={styles.warning}>UPC lookups used up for today - automatic barcode capture is off.</Text>
          )}
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
        <View style={[styles.overlay, { paddingBottom: 20 + insets.bottom }]}>
          <Text style={styles.hint}>Point the camera at the front or back cover, then tap Capture</Text>
          {coverBusy ? (
            <Text style={styles.countdown}>Capturing...</Text>
          ) : (
            <>
              <TouchableOpacity style={styles.button} onPress={handleCaptureCoverPhoto}>
                <Text style={styles.buttonText}>Capture</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.button, styles.cancelButton]} onPress={handleCancelCoverCapture}>
                <Text style={styles.buttonText}>Back</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
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
  brandBar: { ...CHROME_BAR, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 8, opacity: 0.94 },
  // The logo's chevron, drawn as a CSS-style triangle.
  brandMark: {
    width: 0,
    height: 0,
    borderTopWidth: 9,
    borderBottomWidth: 9,
    borderLeftWidth: 10,
    borderTopColor: "transparent",
    borderBottomColor: "transparent",
    borderLeftColor: COLORS.accent,
  },
  brandText: {
    flex: 1,
    fontFamily: FONTS.displayBold,
    fontSize: 20,
    letterSpacing: 2.4,
    color: COLORS.accent,
    textShadowColor: "rgba(92,200,255,0.45)",
    textShadowRadius: 8,
  },
  brandVersion: { color: COLORS.accentHi },
  settingsButton: { ...GLOSS, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 0, backgroundColor: COLORS.accentDeep },
  settingsButtonText: { letterSpacing: 1, color: "#d7e2ee", fontFamily: FONTS.displaySemiBold },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.7)", justifyContent: "center", padding: 24 },
  modalCard: { ...PANEL, backgroundColor: "#0f1c2f", borderRadius: 0, padding: 20, gap: 14 },
  modalTitle: { color: "#f2f7fc", fontSize: 18, fontFamily: FONTS.displayBold },
  settingRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  settingLabel: { fontFamily: FONTS.body, color: "#e9f1f9", fontSize: 16, flexShrink: 1 },
  settingHint: { fontFamily: FONTS.body, color: "#a9b8cc", fontSize: 13 },
  autoBarcodeRow: { alignItems: "center", gap: 4 },
  link: { fontFamily: FONTS.body, color: "#5cc8ff", textDecorationLine: "underline" },
  warning: { fontFamily: FONTS.body, color: "#ffb347", textAlign: "center" },
  overlay: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    padding: 20,
    gap: 10,
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  hint: { fontFamily: FONTS.body, color: "#d7e2ee", textAlign: "center" },
  message: { fontFamily: FONTS.body, color: "#5cc8ff", textAlign: "center" },
  captured: { color: "#4ade80", textAlign: "center", fontFamily: FONTS.displaySemiBold },
  countdown: { color: "#ffb347", textAlign: "center", fontSize: 16, fontFamily: FONTS.displayBold },
  row: { flexDirection: "row", gap: 10 },
  rowButton: { flex: 1 },
  button: {
    ...GLOSS,
    backgroundColor: "#1d6c9a",
    paddingVertical: 12,
    borderRadius: 0,
    alignItems: "center",
  },
  buttonDisabled: { opacity: 0.4 },
  coverButton: { ...GLOSS, backgroundColor: "#2c5d8a" },
  doneButton: { ...GLOSS, flex: 1, backgroundColor: "#16a34a" },
  cancelButton: { ...GLOSS, flex: 1, backgroundColor: "#dc2626" },
  buttonText: { letterSpacing: 1, color: "#fff", fontFamily: FONTS.displaySemiBold },
});
