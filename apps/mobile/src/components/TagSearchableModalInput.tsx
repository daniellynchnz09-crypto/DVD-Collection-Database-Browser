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
              placeholderTextColor="#71717a"
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
    alignItems: "flex-end",
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
