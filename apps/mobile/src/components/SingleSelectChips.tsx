import { StyleSheet, Text, TouchableOpacity, View } from "react-native";

/**
 * A row of toggle chips for a field with a small, closed set of options where exactly one
 * applies at a time (e.g. Disc Condition's severity scale) - unlike MultiSelectChips (Disk
 * Region, where a disc can genuinely be coded for more than one region at once), picking a
 * chip here always replaces whatever was previously selected rather than adding to it.
 */
export default function SingleSelectChips({
  options,
  value,
  onChange,
}: {
  options: readonly string[];
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <View style={styles.row}>
      {options.map((option) => {
        const isSelected = value === option;
        return (
          <TouchableOpacity
            key={option}
            style={[styles.chip, isSelected && styles.chipSelected]}
            onPress={() => onChange(option)}
          >
            <Text style={[styles.chipText, isSelected && styles.chipTextSelected]}>{option}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#3f3f46",
  },
  chipSelected: { backgroundColor: "#0284c7", borderColor: "#0284c7" },
  chipText: { color: "#e4e4e7" },
  chipTextSelected: { color: "#fff", fontWeight: "600" },
});
