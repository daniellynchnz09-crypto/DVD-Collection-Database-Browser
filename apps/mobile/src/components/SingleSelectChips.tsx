import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { FONTS, GLOSS } from "../theme";

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
    borderRadius: 0,
    borderWidth: 1,
    borderColor: "#24395a",
  },
  chipSelected: { ...GLOSS, backgroundColor: "#1d6c9a", borderColor: "#1d6c9a" },
  chipText: { fontFamily: FONTS.body, color: "#d7e2ee" },
  chipTextSelected: { color: "#fff", fontFamily: FONTS.displaySemiBold },
});
