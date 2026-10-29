import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { BUTTON_HEIGHT, FONTS, GLOSS } from "../theme";

/**
 * A screen's back button, shaped as an arrow: a glossy plate with a point on its left end in
 * place of the old "<" in the label (2026-10-29, the user's request). React Native can't clip a
 * view to a polygon, so the point is two border-trick triangles - the upper one in the gloss's
 * lit top half, the lower one in its shaded bottom half - butted against the plate.
 */
const HALF = BUTTON_HEIGHT / 2;
const POINT = 14;
const FACE = "#1d6c9a";
// GLOSS over FACE, averaged per half: ~20% white above the midline, ~17% black below.
const FACE_LIT = "#4a89ae";
const FACE_SHADED = "#185a80";

export function BackButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <TouchableOpacity
      style={styles.row}
      onPress={onPress}
      hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
      accessibilityRole="button"
      accessibilityLabel={`Back to ${label}`}
    >
      <View>
        <View style={styles.pointTop} />
        <View style={styles.pointBottom} />
      </View>
      <View style={styles.plate}>
        <Text style={styles.text}>{label}</Text>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignSelf: "flex-start" },
  pointTop: {
    width: 0,
    height: 0,
    borderLeftWidth: POINT,
    borderLeftColor: "transparent",
    borderBottomWidth: HALF,
    borderBottomColor: FACE_LIT,
  },
  pointBottom: {
    width: 0,
    height: 0,
    borderLeftWidth: POINT,
    borderLeftColor: "transparent",
    borderTopWidth: HALF,
    borderTopColor: FACE_SHADED,
  },
  plate: {
    ...GLOSS,
    // No drop shadow: the point can't cast one, so the plate doesn't either.
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.45), inset 0 -1px 0 rgba(0,0,0,0.35)",
    backgroundColor: FACE,
    height: BUTTON_HEIGHT,
    paddingLeft: 8,
    paddingRight: 14,
    justifyContent: "center",
  },
  text: { letterSpacing: 1, color: "#fff", fontSize: 14, fontFamily: FONTS.displayBold },
});
