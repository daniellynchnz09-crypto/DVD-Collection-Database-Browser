import { StyleSheet, Text, View } from "react-native";
import { useIsOnline } from "../lib/network";

/**
 * A persistent warning banner shown whenever there's no real internet access - added
 * 2026-09-18 per the user's own explicit request ("warns them that some functionality may
 * not work"). Renders nothing at all while online, so every screen that includes this pays
 * no visual cost when there's nothing to warn about.
 *
 * Deliberately generic wording rather than screen-specific - the exact same limitation
 * applies everywhere this appears (ScannerScreen, ConfirmScreen): scanning/manual entry still
 * work, but anything needing the real internet (title search, format detection, pricing,
 * Confirm's actual write) won't until the connection is back.
 */
export default function OfflineBanner() {
  const isOnline = useIsOnline();
  if (isOnline) return null;

  return (
    <View style={styles.banner}>
      <Text style={styles.text}>
        You're offline - scanning and manual entries still work, but title search, format detection, and pricing tools won't until your
        internet connection is back.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: "#78350f",
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  text: { color: "#fde68a", fontSize: 12, textAlign: "center" },
});
