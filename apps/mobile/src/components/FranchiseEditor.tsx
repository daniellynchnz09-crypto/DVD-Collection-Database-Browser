import { useMemo, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import SearchableModalInput from "./SearchableModalInput";

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
  heading: { color: "#a1a1aa", fontSize: 14, marginTop: 4 },
  empty: { color: "#71717a", fontStyle: "italic" },
  blocks: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  block: { flexDirection: "row", alignItems: "center", backgroundColor: "#0284c7", borderRadius: 10, paddingLeft: 14, minHeight: 48 },
  blockText: { color: "#fff", fontSize: 16, fontWeight: "600", flexShrink: 1 },
  remove: { paddingHorizontal: 14, height: 48, alignItems: "center", justifyContent: "center" },
  removeText: { color: "#fff", fontSize: 24, fontWeight: "700" },
  suggestion: { borderWidth: 1, borderColor: "#38bdf8", borderRadius: 10, paddingHorizontal: 14, minHeight: 48, alignItems: "center", justifyContent: "center" },
  suggestionText: { color: "#38bdf8", fontSize: 16, fontWeight: "600" },
  addButton: { minHeight: 52, borderRadius: 10, backgroundColor: "#27272a", alignItems: "center", justifyContent: "center" },
  addDisabled: { opacity: 0.4 },
  addText: { color: "#f4f4f5", fontSize: 16, fontWeight: "700" },
});
