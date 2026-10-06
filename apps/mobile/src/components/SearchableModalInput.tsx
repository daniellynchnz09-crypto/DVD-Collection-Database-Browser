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
import { FONTS, GLOSS, PANEL, WELL } from "../theme";

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
              placeholderTextColor="#8193ab"
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
    borderColor: "#24395a",
    borderRadius: 0,
    padding: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  valueText: { fontFamily: FONTS.body, color: "#e9f1f9", flex: 1 },
  placeholderText: { fontFamily: FONTS.body, color: "#8193ab", flex: 1 },
  chevron: { fontFamily: FONTS.body, color: "#a9b8cc", marginLeft: 8 },
  modal: {
    ...PANEL,
    flex: 1,
    backgroundColor: "#0f1c2f",
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
    ...WELL,
    fontFamily: FONTS.body,
    flex: 1,
    borderWidth: 1,
    borderColor: "#24395a",
    borderRadius: 0,
    padding: 10,
    color: "#e9f1f9",
    fontSize: 16,
  },
  doneButton: {
    ...GLOSS,
    backgroundColor: "#0c3554",
    borderRadius: 0,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  doneButtonText: { letterSpacing: 1, color: "#b3e8ff", fontFamily: FONTS.displaySemiBold },
  optionRow: {
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderBottomWidth: 1,
    borderBottomColor: "#16294a",
  },
  optionText: { fontFamily: FONTS.body, color: "#d7e2ee", fontSize: 16 },
  emptyText: { fontFamily: FONTS.body, color: "#8193ab", padding: 20, textAlign: "center" },
});
