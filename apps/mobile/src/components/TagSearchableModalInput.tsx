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
 * Replaces TagAutocompleteInput (2026-09-19, same request as SearchableModalInput - the user
 * specifically called out tagging fields like Genre/Franchise as where this full-screen
 * picker helps most). Same tag semantics as before: suggestions match only the segment
 * currently being typed (the text after the last comma), tapping one appends it and resets
 * the current segment so the next tag is matched fresh, and free-typed text with no match is
 * kept as-is. Unlike the single-value SearchableModalInput, tapping a suggestion here always
 * left the modal open even before this redesign (adding several tags in one sitting is the
 * whole point) - "Done" or hiding the keyboard closes it once all tags are in.
 */
export default function TagSearchableModalInput({
  value,
  onChangeText,
  options,
  placeholder,
  numberOfLines,
}: {
  value: string;
  onChangeText: (text: string) => void;
  options: string[];
  placeholder?: string;
  onFocusScroll?: (nodeHandle: number | null, delayMs?: number) => void;
  numberOfLines?: number;
}) {
  const [open, setOpen] = useState(false);
  const inputRef = useRef<TextInput>(null);

  function close() {
    Keyboard.dismiss();
    setOpen(false);
  }

  const segments = value.split(",");
  const currentSegment = segments[segments.length - 1].trim();
  const priorTags = segments
    .slice(0, -1)
    .map((s) => s.trim())
    .filter(Boolean);
  const usedLower = new Set([...priorTags, currentSegment].map((t) => t.toLowerCase()));

  const currentLower = currentSegment.toLowerCase();
  const suggestions = options.filter((o) => {
    const oLower = o.toLowerCase();
    if (usedLower.has(oLower) && oLower !== currentLower) return false;
    if (oLower === currentLower) return false;
    return currentLower ? oLower.includes(currentLower) : true;
  });

  function selectSuggestion(option: string) {
    onChangeText([...priorTags, option].join(", ") + ", ");
  }

  const isMultiline = Boolean(numberOfLines && numberOfLines > 1);

  return (
    <View>
      <TouchableOpacity style={styles.field} onPress={() => setOpen(true)}>
        <Text
          style={value ? styles.valueText : styles.placeholderText}
          numberOfLines={isMultiline ? numberOfLines : 1}
        >
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
              style={[styles.searchInput, isMultiline && { minHeight: numberOfLines! * 22, textAlignVertical: "top" }]}
              value={value}
              onChangeText={onChangeText}
              placeholder={placeholder}
              placeholderTextColor="#8193ab"
              autoFocus
              multiline={isMultiline}
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
              <TouchableOpacity style={styles.optionRow} onPress={() => selectSuggestion(item)}>
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
    alignItems: "flex-end",
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
