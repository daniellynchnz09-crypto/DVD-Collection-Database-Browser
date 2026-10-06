import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { FONTS, GLOSS, PLATE } from "../theme";

/**
 * A row of toggle chips for a field with a small, genuinely fixed set of options (Disk
 * Region - 1/2/3/4/5/6/All/Not Listed for DVD, A/B/C/All/Not Listed for Blu-ray - never a
 * free-typed value like Format/Genre Location), where more than one can apply at once (some
 * discs are coded for multiple regions). `exclusiveOptions` (default just "All") lists
 * options that clear every other selection when picked and are themselves cleared by
 * picking anything else - "All" (region-free) and "Not Listed" (packaging simply doesn't
 * print a region) are both contradictory to being coded for specific individual regions,
 * and to each other.
 */
export default function MultiSelectChips({
  options,
  selected,
  onChange,
  exclusiveOptions = ["All"],
}: {
  options: string[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  exclusiveOptions?: string[];
}) {
  function toggle(option: string) {
    if (exclusiveOptions.includes(option)) {
      onChange(selected.has(option) ? new Set() : new Set([option]));
      return;
    }
    const next = new Set(selected);
    for (const exclusive of exclusiveOptions) next.delete(exclusive);
    if (next.has(option)) next.delete(option);
    else next.add(option);
    onChange(next);
  }

  return (
    <View style={styles.row}>
      {options.map((option) => {
        const isSelected = selected.has(option);
        return (
          <TouchableOpacity
            key={option}
            style={[styles.chip, isSelected && styles.chipSelected]}
            onPress={() => toggle(option)}
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
    ...PLATE,
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
