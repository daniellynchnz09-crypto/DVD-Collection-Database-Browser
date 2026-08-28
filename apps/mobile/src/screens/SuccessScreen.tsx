import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/**
 * Shelf-location suggestion (Claude/AIM.md Aim Five): alphabetical within
 * genre_location, or by depicted_era_start for the History Documentary bucket.
 */
export default function SuccessScreen({
  shelfLocation,
  linkedTitle,
  onDone,
}: {
  shelfLocation: { before: string | null; after: string | null } | null;
  linkedTitle?: string;
  onDone: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.container, { paddingTop: 24 + insets.top, paddingBottom: 24 + insets.bottom }]}>
      <Text style={styles.title}>{linkedTitle ? "Updated!" : "Added!"}</Text>
      {linkedTitle ? (
        <Text style={styles.body}>
          Attached this barcode and its image to your existing entry for &quot;{linkedTitle}&quot;.
        </Text>
      ) : shelfLocation && (shelfLocation.before || shelfLocation.after) ? (
        <Text style={styles.body}>
          Goes on the shelf{" "}
          {shelfLocation.before ? `after "${shelfLocation.before}"` : ""}
          {shelfLocation.before && shelfLocation.after ? " and " : ""}
          {shelfLocation.after ? `before "${shelfLocation.after}"` : ""}
          {!shelfLocation.before && !shelfLocation.after ? "" : "."}
        </Text>
      ) : (
        <Text style={styles.body}>No shelf-location suggestion yet - set a Genre Location to get one next time.</Text>
      )}
      <TouchableOpacity style={styles.button} onPress={onDone}>
        <Text style={styles.buttonText}>Back to Scanner</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#09090b", justifyContent: "center", padding: 24, gap: 16 },
  title: { color: "#4ade80", fontSize: 24, fontWeight: "700", textAlign: "center" },
  body: { color: "#e4e4e7", textAlign: "center" },
  button: {
    backgroundColor: "#0284c7",
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: "center",
  },
  buttonText: { color: "#fff", fontWeight: "600" },
});
