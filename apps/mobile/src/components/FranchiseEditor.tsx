import { useMemo, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import SearchableModalInput from "./SearchableModalInput";
import { FONTS, GLOSS, PLATE } from "../theme";

type Props = {
  /** Comma-separated franchise tags, same string the form state already holds. */
  value: string;
  onChange: (value: string) => void;
  /** Every franchise already in the collection. */
  options: string[];
  /** franchiseCooccurrence from loadFieldOptions. */
  cooccurrence: Record<string, Record<string, number>>;
};

const MAX_SUGGESTIONS = 3;

function parse(value: string): string[] {
  return value.split(",").map((t) => t.trim()).filter(Boolean);
}

/** Franchise tags as removable blocks, up to three "often go with this" picks from past titles,
 * and a blank field (with the dropdown of every existing franchise) for anything else. */
export default function FranchiseEditor({ value, onChange, options, cooccurrence }: Props) {
  const [draft, setDraft] = useState("");
  const tags = useMemo(() => parse(value), [value]);
  const has = (t: string) => tags.some((x) => x.toLowerCase() === t.toLowerCase());

  const suggestions = useMemo(() => {
    const scores = new Map<string, number>();
    for (const tag of tags) {
      for (const [other, count] of Object.entries(cooccurrence[tag] ?? {})) {
        if (!has(other)) scores.set(other, (scores.get(other) ?? 0) + count);
      }
    }
    return [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_SUGGESTIONS).map(([name]) => name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tags, cooccurrence]);

  const add = (t: string) => {
    const clean = t.trim();
    if (!clean || has(clean)) return;
    onChange([...tags, clean].join(", "));
  };
  const remove = (t: string) => onChange(tags.filter((x) => x !== t).join(", "));

  const remaining = options.filter((o) => !has(o) && !suggestions.includes(o));

  return (
    <View style={styles.wrap}>
      <Text style={styles.heading}>On this title</Text>
      {tags.length === 0 ? (
        <Text style={styles.empty}>No franchise (fine for a standalone film).</Text>
      ) : (
        <View style={styles.blocks}>
          {tags.map((t) => (
            <View key={t} style={styles.block}>
              <Text style={styles.blockText}>{t}</Text>
              <TouchableOpacity onPress={() => remove(t)} hitSlop={8} style={styles.remove}>
                <Text style={styles.removeText}>×</Text>
              </TouchableOpacity>
            </View>
          ))}
        </View>
      )}

      {suggestions.length > 0 && (
        <>
          <Text style={styles.heading}>Franchises that often go with this selection</Text>
          <View style={styles.blocks}>
            {suggestions.map((t) => (
              <TouchableOpacity key={t} style={styles.suggestion} onPress={() => add(t)}>
                <Text style={styles.suggestionText}>+ {t}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </>
      )}

      <Text style={styles.heading}>Add another</Text>
      <SearchableModalInput value={draft} onChangeText={setDraft} options={remaining} placeholder="Type a new franchise or pick an existing one" />
      <TouchableOpacity
        style={[styles.addButton, !draft.trim() && styles.addDisabled]}
        disabled={!draft.trim()}
        onPress={() => {
          add(draft);
          setDraft("");
        }}
      >
        <Text style={styles.addText}>Add</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 10 },
  heading: { fontFamily: FONTS.body, color: "#a9b8cc", fontSize: 14, marginTop: 4 },
  empty: { fontFamily: FONTS.body, color: "#8193ab", fontStyle: "italic" },
  blocks: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  // maxWidth keeps a long franchise name inside the panel (2026-10-03, user-reported: a long
  // name pushed the chip past the panel's edge) - the text wraps onto extra lines instead.
  block: { ...GLOSS, flexDirection: "row", alignItems: "center", backgroundColor: "#1d6c9a", borderRadius: 0, paddingLeft: 14, minHeight: 48, maxWidth: "100%" },
  blockText: { color: "#fff", fontSize: 16, fontFamily: FONTS.displaySemiBold, flexShrink: 1, paddingVertical: 8 },
  remove: { paddingHorizontal: 14, height: 48, alignItems: "center", justifyContent: "center" },
  removeText: { color: "#fff", fontSize: 24, fontFamily: FONTS.displayBold },
  suggestion: { ...PLATE, borderWidth: 1, borderColor: "#5cc8ff", borderRadius: 0, paddingHorizontal: 14, minHeight: 48, alignItems: "center", justifyContent: "center", maxWidth: "100%" },
  suggestionText: { color: "#5cc8ff", fontSize: 16, fontFamily: FONTS.displaySemiBold, flexShrink: 1, paddingVertical: 8 },
  addButton: { ...GLOSS, minHeight: 52, borderRadius: 0, backgroundColor: "#16294a", alignItems: "center", justifyContent: "center" },
  addDisabled: { opacity: 0.4 },
  addText: { color: "#e9f1f9", fontSize: 16, fontFamily: FONTS.displayBold },
});
