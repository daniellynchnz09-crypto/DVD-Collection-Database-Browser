import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { FONTS, PANEL } from "../theme";

type Props = {
  options: string[];
  value: string;
  onChange: (value: string) => void;
  /** Tiles per row (default 2). */
  columns?: number;
};

/** Big single-choice tiles (min 56px tall) for slide-style forms; tapping the selected tile again
 * does nothing, so a value can't be cleared by accident. */
export default function BigChoice({ options, value, onChange, columns = 2 }: Props) {
  const width = `${Math.floor(100 / columns) - 2}%` as const;
  return (
    <View style={styles.grid}>
      {options.map((option) => {
        const selected = option === value;
        return (
          <TouchableOpacity
            key={option}
            style={[styles.tile, { width }, selected && styles.tileSelected]}
            onPress={() => onChange(option)}
          >
            <Text style={[styles.text, selected && styles.textSelected]}>{option}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  tile: {
    ...PANEL,
    minHeight: 56,
    borderRadius: 0,
    borderWidth: 1,
    borderColor: "#24395a",
    backgroundColor: "#0f1c2f",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 8,
    paddingVertical: 10,
  },
  tileSelected: { backgroundColor: "#1d6c9a", borderColor: "#5cc8ff" },
  text: { color: "#d7e2ee", fontSize: 16, fontFamily: FONTS.displaySemiBold, textAlign: "center" },
  textSelected: { fontFamily: FONTS.body, color: "#ffffff" },
});
