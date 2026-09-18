import { useRef, useState } from "react";
import {
  FlatList,
  Keyboard,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

/**
 * Replaces AutocompleteInput (2026-09-19, per the user's own request after trying the new
 * Type dropdown live: "replace the text entry fields that have dropdowns with previous
 * entries to something that is more like this dropdown"). Same drop-in props as
 * AutocompleteInput (including the now-unused onFocusScroll, kept so every call site didn't
 * need editing - a full-screen modal has nothing on the underlying screen that needs
 * scrolling into view). Tapping the field opens a full-screen modal with a text input at the
 * top (pre-filled with the current value, auto-focused) and the matching options narrowing
 * down live below it as you type - tapping one replaces the typed text but leaves the modal
 * open, same as before, so the user can keep refining; a "Done" button or hiding the
 * keyboard closes it, same exit gesture as the old inline dropdown's keyboardDidHide-closes-
 * suggestions behavior, just now closing the whole modal instead.
 */
export default function SearchableModalInput({
  value,
  onChangeText,
  options,
  placeholder,
}: {
  value: string;
  onChangeText: (text: string) => void;
  options: string[];
  placeholder?: string;
  onFocusScroll?: (nodeHandle: number | null, delayMs?: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const inputRef = useRef<TextInput>(null);

  function close() {
    Keyboard.dismiss();
    setOpen(false);
  }

  const trimmed = value.trim().toLowerCase();
  const suggestions = trimmed
    ? options.filter((o) => o.toLowerCase().includes(trimmed) && o.toLowerCase() !== trimmed)
    : options;

  return (
    <View>
      <TouchableOpacity style={styles.field} onPress={() => setOpen(true)}>
        <Text style={value ? styles.valueText : styles.placeholderText} numberOfLines={1}>
          {value || placeholder || "Select or type..."}
        </Text>
        <Text style={styles.chevron}>▾</Text>
      </TouchableOpacity>
      <Modal
        visible={open}
        animationType="slide"
        onRequestClose={close}
        onShow={() => inputRef.current?.focus()}
      >
        <View style={styles.modal}>
          <View style={styles.header}>
            <TextInput
              ref={inputRef}
              style={styles.searchInput}
              value={value}
              onChangeText={onChangeText}
              placeholder={placeholder}
              placeholderTextColor="#71717a"
              autoFocus
              onSubmitEditing={close}
            />
            <TouchableOpacity style={styles.doneButton} onPress={close}>
              <Text style={styles.doneButtonText}>Done</Text>
            </TouchableOpacity>
          </View>
          <FlatList
            data={suggestions}
            keyExtractor={(item) => item}
            keyboardShouldPersistTaps="always"
            renderItem={({ item }) => (
              <TouchableOpacity style={styles.optionRow} onPress={() => onChangeText(item)}>
                <Text style={styles.optionText}>{item}</Text>
              </TouchableOpacity>
            )}
            ListEmptyComponent={
              <Text style={styles.emptyText}>
                No matching entries yet - what you type here will be saved as-is.
              </Text>
            }
          />
        </View>
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
  valueText: { color: "#f4f4f5", flex: 1 },
  placeholderText: { color: "#71717a", flex: 1 },
  chevron: { color: "#a1a1aa", marginLeft: 8 },
  modal: {
    flex: 1,
    backgroundColor: "#18181b",
    paddingTop: Platform.OS === "ios" ? 60 : 24,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingBottom: 12,
    gap: 10,
  },
  searchInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#3f3f46",
    borderRadius: 8,
    padding: 10,
    color: "#f4f4f5",
    fontSize: 16,
  },
  doneButton: {
    backgroundColor: "#0c4a6e",
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  doneButtonText: { color: "#7dd3fc", fontWeight: "600" },
  optionRow: {
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderBottomWidth: 1,
    borderBottomColor: "#27272a",
  },
  optionText: { color: "#e4e4e7", fontSize: 16 },
  emptyText: { color: "#71717a", padding: 20, textAlign: "center" },
});
