import { StyleSheet, Text, TouchableOpacity, View } from "react-native";

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
    minHeight: 56,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#3f3f46",
    backgroundColor: "#18181b",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 8,
    paddingVertical: 10,
  },
  tileSelected: { backgroundColor: "#0284c7", borderColor: "#38bdf8" },
  text: { color: "#e4e4e7", fontSize: 16, fontWeight: "600", textAlign: "center" },
  textSelected: { color: "#ffffff" },
});
