import { useRef, useState } from "react";
import { findNodeHandle, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";

/**
 * A plain text input backed by a list of existing values (Format/Disk Region/Genre
 * Location on ConfirmScreen - see Claude/TECH STACK AND ARCHITECTURE.md's Barcode
 * Scanning Pipeline section) - typing filters the suggestions, tapping one fills the
 * field, and typing something not in the list just keeps that as free text. No fixed
 * enum anywhere: a new value typed here becomes selectable for every future scan simply
 * because it's now one of the distinct values already in the collection (see
 * apps/mobile/src/lib/fieldOptions.ts).
 */
export default function AutocompleteInput({
  value,
  onChangeText,
  options,
  placeholder,
  onFocusScroll,
}: {
  value: string;
  onChangeText: (text: string) => void;
  options: string[];
  placeholder?: string;
  /** Called with this field's own node handle (covering the input plus its dropdown, once
   * open) so the screen can scroll it above the keyboard - see lib/scrollIntoView.ts. Called
   * twice: once immediately on focus (catches the input itself), once again shortly after
   * (catches the dropdown, which only exists once `focused` has actually re-rendered). */
  onFocusScroll?: (nodeHandle: number | null, delayMs?: number) => void;
}) {
  const [focused, setFocused] = useState(false);
  const containerRef = useRef<View>(null);

  const trimmed = value.trim().toLowerCase();
  const suggestions = trimmed
    ? options.filter((o) => o.toLowerCase().includes(trimmed) && o.toLowerCase() !== trimmed)
    : options;

  function handleFocus() {
    setFocused(true);
    const nodeHandle = findNodeHandle(containerRef.current);
    onFocusScroll?.(nodeHandle);
    onFocusScroll?.(nodeHandle, 120);
  }

  return (
    <View ref={containerRef}>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        onFocus={handleFocus}
        // Delay hiding suggestions so a tap on one registers before the list disappears.
        onBlur={() => setTimeout(() => setFocused(false), 150)}
        placeholder={placeholder}
        placeholderTextColor="#71717a"
      />
      {focused && suggestions.length > 0 && (
        <View style={styles.suggestions}>
          {suggestions.slice(0, 6).map((option) => (
            <TouchableOpacity
              key={option}
              style={styles.suggestionRow}
              onPress={() => {
                onChangeText(option);
                setFocused(false);
              }}
            >
              <Text style={styles.suggestionText}>{option}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  input: {
    borderWidth: 1,
    borderColor: "#3f3f46",
    borderRadius: 8,
    padding: 10,
    color: "#f4f4f5",
  },
  suggestions: {
    borderWidth: 1,
    borderColor: "#3f3f46",
    borderTopWidth: 0,
    borderBottomLeftRadius: 8,
    borderBottomRightRadius: 8,
    marginTop: -1,
  },
  suggestionRow: {
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderTopWidth: 1,
    borderTopColor: "#27272a",
  },
  suggestionText: { color: "#e4e4e7" },
});
