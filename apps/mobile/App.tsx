import { useState } from "react";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import ScannerScreen from "./src/screens/ScannerScreen";
import PendingScansScreen, { type PendingScan } from "./src/screens/PendingScansScreen";
import ConfirmScreen from "./src/screens/ConfirmScreen";
import SuccessScreen from "./src/screens/SuccessScreen";

// Three screens are simple enough for local state - a real navigator (react-navigation)
// is worth introducing in Phase 2 once browse/search adds many more routes. See
// Claude/TECH STACK AND ARCHITECTURE.md's "BARCODE SCANNING PIPELINE" section.
type Screen =
  | { name: "scanner" }
  | { name: "pending" }
  | { name: "confirm"; scan: PendingScan }
  | { name: "success"; shelfLocation: { before: string | null; after: string | null } | null };

export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: "scanner" });

  return (
    <SafeAreaProvider>
      {screen.name === "scanner" && (
        <ScannerScreen onGoToPending={() => setScreen({ name: "pending" })} />
      )}
      {screen.name === "pending" && (
        <PendingScansScreen
          onSelect={(scan) => setScreen({ name: "confirm", scan })}
          onBack={() => setScreen({ name: "scanner" })}
        />
      )}
      {screen.name === "confirm" && (
        <ConfirmScreen
          scan={screen.scan}
          onConfirmed={(shelfLocation) => setScreen({ name: "success", shelfLocation })}
          onBack={() => setScreen({ name: "pending" })}
        />
      )}
      {screen.name === "success" && (
        <SuccessScreen
          shelfLocation={screen.shelfLocation}
          onDone={() => setScreen({ name: "scanner" })}
        />
      )}
      <StatusBar style="light" />
    </SafeAreaProvider>
  );
}
