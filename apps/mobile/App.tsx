import { useCallback, useRef, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import ScannerScreen from "./src/screens/ScannerScreen";
import PendingScansScreen, { type PendingScan } from "./src/screens/PendingScansScreen";
import ConfirmScreen from "./src/screens/ConfirmScreen";
import SuccessScreen from "./src/screens/SuccessScreen";

// How long ScannerScreen remembers a barcode after queuing it, to avoid re-queuing the
// same disc if you point back at it a few seconds or minutes later. Lives here rather
// than inside ScannerScreen itself so it survives navigating away to review/delete
// pending scans and back to the camera - ScannerScreen unmounts on every navigation
// away, which would otherwise reset the cooldown for free.
const RECENT_QUEUE_COOLDOWN_MS = 5 * 60 * 1000;

// Three screens are simple enough for local state - a real navigator (react-navigation)
// is worth introducing in Phase 2 once browse/search adds many more routes. See
// Claude/TECH STACK AND ARCHITECTURE.md's "BARCODE SCANNING PIPELINE" section.
type Screen =
  | { name: "scanner" }
  | { name: "pending" }
  | { name: "confirm"; scan: PendingScan }
  | {
      name: "success";
      shelfLocation: { before: string | null; after: string | null } | null;
      linkedTitle?: string;
    };

export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: "scanner" });
  const recentlyQueuedRef = useRef<Map<string, number>>(new Map());

  const wasRecentlyQueued = useCallback((barcode: string) => {
    const queuedAt = recentlyQueuedRef.current.get(barcode);
    return queuedAt !== undefined && Date.now() - queuedAt < RECENT_QUEUE_COOLDOWN_MS;
  }, []);
  const markQueued = useCallback((barcode: string) => {
    recentlyQueuedRef.current.set(barcode, Date.now());
  }, []);
  // Called when the user deletes/discards a pending scan - that barcode is no longer
  // "recently queued" from the user's perspective, so let it be scanned again right away
  // instead of waiting out the rest of the cooldown.
  const forgetQueued = useCallback((barcode: string) => {
    recentlyQueuedRef.current.delete(barcode);
  }, []);

  return (
    <SafeAreaProvider>
      {screen.name === "scanner" && (
        <ScannerScreen
          onGoToPending={() => setScreen({ name: "pending" })}
          wasRecentlyQueued={wasRecentlyQueued}
          markQueued={markQueued}
        />
      )}
      {screen.name === "pending" && (
        <PendingScansScreen
          onSelect={(scan) => setScreen({ name: "confirm", scan })}
          onBack={() => setScreen({ name: "scanner" })}
          onDeleted={(barcodes) => barcodes.forEach(forgetQueued)}
        />
      )}
      {screen.name === "confirm" && (
        <ConfirmScreen
          scan={screen.scan}
          onConfirmed={({ shelfLocation, linkedTitle }) =>
            setScreen({ name: "success", shelfLocation, linkedTitle })
          }
          onBack={() => setScreen({ name: "pending" })}
          onDiscarded={forgetQueued}
        />
      )}
      {screen.name === "success" && (
        <SuccessScreen
          shelfLocation={screen.shelfLocation}
          linkedTitle={screen.linkedTitle}
          onDone={() => setScreen({ name: "scanner" })}
        />
      )}
      <StatusBar style="light" />
    </SafeAreaProvider>
  );
}
