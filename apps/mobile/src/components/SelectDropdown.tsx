import { useState } from "react";
import { FlatList, Modal, StyleSheet, Text, TouchableOpacity, View } from "react-native";

/**
 * A genuine closed-choice dropdown - tap the field to open a full-screen list of options,
 * tap one to select and close. Unlike SearchableModalInput (free text with suggestions) or
 * SingleSelectChips (every option shown at once as a row of buttons), this never lets the
 * user type anything and never shows every option inline - built 2026-09-19 for the Movie or
 * TV field specifically, per the user's own clarification that a row of chips wasn't what
 * they meant by "dropdown box with no text entry."
 */
export default function SelectDropdown({
  options,
  value,
  onChange,
  placeholder,
}: {
  options: readonly string[];
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <View>
      <TouchableOpacity style={styles.field} onPress={() => setOpen(true)}>
        <Text style={value ? styles.valueText : styles.placeholderText}>
          {value || placeholder || "Select..."}
        </Text>
        <Text style={styles.chevron}>▾</Text>
      </TouchableOpacity>
      <Modal visible={open} animationType="fade" transparent onRequestClose={() => setOpen(false)}>
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={() => setOpen(false)}>
          <View style={styles.sheet}>
            <FlatList
              data={options}
              keyExtractor={(item) => item}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={[styles.optionRow, item === value && styles.optionRowSelected]}
                  onPress={() => {
                    onChange(item);
                    setOpen(false);
                  }}
                >
                  <Text style={[styles.optionText, item === value && styles.optionTextSelected]}>{item}</Text>
                </TouchableOpacity>
              )}
            />
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  field: {
    borderWidth: 1,
    borderColor: "#3f3f46",
    borderRadius: 8,
    padding: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  valueText: { color: "#f4f4f5" },
  placeholderText: { color: "#71717a" },
  chevron: { color: "#a1a1aa", marginLeft: 8 },
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: "#18181b",
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    maxHeight: "60%",
    paddingVertical: 8,
  },
  optionRow: {
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderBottomWidth: 1,
    borderBottomColor: "#27272a",
  },
  optionRowSelected: { backgroundColor: "#0c4a6e" },
  optionText: { color: "#e4e4e7", fontSize: 16 },
  optionTextSelected: { color: "#7dd3fc", fontWeight: "600" },
});
