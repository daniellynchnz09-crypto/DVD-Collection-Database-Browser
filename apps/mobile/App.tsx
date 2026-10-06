import { useCallback, useEffect, useRef, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { useFonts } from "expo-font";
import { Barlow_400Regular, Barlow_500Medium, Barlow_600SemiBold } from "@expo-google-fonts/barlow";
import { ChakraPetch_500Medium, ChakraPetch_600SemiBold, ChakraPetch_700Bold } from "@expo-google-fonts/chakra-petch";
import { SafeAreaProvider } from "react-native-safe-area-context";
import ScannerScreen from "./src/screens/ScannerScreen";
import PendingScansScreen, { type PendingScan } from "./src/screens/PendingScansScreen";
import ConfirmScreen from "./src/screens/ConfirmScreen";
import SuccessScreen from "./src/screens/SuccessScreen";
import OfflineQueueScreen from "./src/screens/OfflineQueueScreen";
import SubmissionBanner from "./src/components/SubmissionBanner";
import { subscribeToReconnect } from "./src/lib/network";
import { getQueuedSubmissions, trySyncOfflineQueue } from "./src/lib/offlineQueue";
import { hydrateConfirmDrafts } from "./src/lib/confirmDrafts";

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
  | { name: "offlineQueue" }
  // Just the background save's id (2026-10-03) - SuccessScreen reads its live status/outcome
  // from backgroundSubmissions.ts rather than receiving a finished result.
  | { name: "success"; submissionId: string };

export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: "scanner" });
  const recentlyQueuedRef = useRef<Map<string, number>>(new Map());
  const [offlineQueueCount, setOfflineQueueCount] = useState(0);
  // Confirm-screen drafts are cached in memory for fast synchronous reads (confirmDrafts.ts),
  // but persisted to AsyncStorage so they survive the app actually closing/restarting, not
  // just in-app navigation (2026-09-24, per the user's own real data-loss report - see that
  // file's own header comment). Gates the screen switch below so a scan can never be opened
  // before its saved draft, if any, has actually been loaded - in practice this resolves in a
  // handful of milliseconds, well before the earliest possible tap into a scan (scanner ->
  // pending -> select one, at least two taps away).
  const [draftsReady, setDraftsReady] = useState(false);
  // The website's two typefaces (theme.ts's FONTS), bundled with the app so they load from
  // the device in a moment. A failed load still opens the app, in the system font.
  const [fontsLoaded, fontError] = useFonts({
    Barlow_400Regular,
    Barlow_500Medium,
    Barlow_600SemiBold,
    ChakraPetch_500Medium,
    ChakraPetch_600SemiBold,
    ChakraPetch_700Bold,
  });
  useEffect(() => {
    hydrateConfirmDrafts().then(() => setDraftsReady(true));
  }, []);

  const refreshOfflineQueueCount = useCallback(async () => {
    setOfflineQueueCount((await getQueuedSubmissions()).length);
  }, []);

  // Auto-resync (added 2026-09-18) - the moment the connection comes back after being down,
  // automatically attempt every queued offline submission for real, per the user's own
  // explicit spec ("when internet is back up and running the program will submit it to the
  // database... automatically"). Runs for the lifetime of the app, not just while a
  // particular screen is mounted, since reconnection can happen at any point.
  useEffect(() => {
    refreshOfflineQueueCount();
    const unsubscribe = subscribeToReconnect(async () => {
      await trySyncOfflineQueue();
      await refreshOfflineQueueCount();
    });
    return unsubscribe;
  }, [refreshOfflineQueueCount]);

  // Also refreshed on every visit to Pending Scans (where the badge shows) - covers the case
  // where an item was just queued (offline Confirm) or resolved (from the Offline Queue
  // screen) without relying solely on the reconnect event, which only fires for an actual
  // offline->online transition.
  useEffect(() => {
    if (screen.name === "pending") refreshOfflineQueueCount();
  }, [screen, refreshOfflineQueueCount]);

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
      {!draftsReady || (!fontsLoaded && !fontError) ? null : (
        <>
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
              onGoToOfflineQueue={() => setScreen({ name: "offlineQueue" })}
              offlineQueueCount={offlineQueueCount}
            />
          )}
          {screen.name === "offlineQueue" && <OfflineQueueScreen onBack={() => setScreen({ name: "pending" })} />}
          {screen.name === "confirm" && (
            <ConfirmScreen
              scan={screen.scan}
              onConfirmed={({ submissionId }) => setScreen({ name: "success", submissionId })}
              onBack={() => setScreen({ name: "pending" })}
              onDiscarded={forgetQueued}
            />
          )}
          {screen.name === "success" && (
            <SuccessScreen
              submissionId={screen.submissionId}
              onGoToScanner={() => setScreen({ name: "scanner" })}
              onGoToPending={() => setScreen({ name: "pending" })}
            />
          )}
          <SubmissionBanner suppressedSubmissionId={screen.name === "success" ? screen.submissionId : null} />
        </>
      )}
      <StatusBar style="light" />
    </SafeAreaProvider>
  );
}
