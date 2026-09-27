import type { ReactNode } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";

type Props = {
  label: string;
  value: string;
  /** Required but empty - shown in red so it can't be missed. */
  missing?: boolean;
  /** Optional but easy to accidentally skip and often worth a second look - shown in amber,
   * one notch below `missing` (added 2026-09-24, per the user's own request after a real scan
   * went through with no Rating: "we should add a yellow warning to sections of the review
   * slides as well for things that are optional but potentially important like franchise, and
   * special features"). Purely advisory - never blocks Confirm, unlike `missing`. Ignored
   * whenever `missing` is also true, since a hard requirement is the more urgent signal and
   * showing both at once would just be visual noise for the same row. Callers compute this the
   * same way they already compute `missing` (e.g. `notable={!franchise.trim()}`), rather than
   * this component guessing from `value` on their behalf. */
  notable?: boolean;
  onPress: () => void;
  /** Editor shown inline when expanded (tap the row to toggle). Without it the row just calls onPress. */
  children?: ReactNode;
  expanded?: boolean;
};

/** One tappable line of the Summary slide: label on the left, current value on the right. */
export default function SummaryRow({ label, value, missing, notable, onPress, children, expanded }: Props) {
  const isNotable = !missing && notable;
  return (
    <View>
    <TouchableOpacity
      style={[styles.row, isNotable && styles.rowNotable, missing && styles.rowMissing]}
      onPress={onPress}
    >
      <Text style={styles.label}>{label}</Text>
      <View style={styles.valueWrap}>
        <Text style={[styles.value, isNotable && styles.valueNotable, missing && styles.valueMissing]} numberOfLines={2}>
          {value.trim() ? value : missing ? "Needed - tap to fill in" : isNotable ? "Worth a look - tap to check" : "-"}
        </Text>
      </View>
      {children ? <Text style={styles.chevron}>{expanded ? "▴" : "▾"}</Text> : null}
    </TouchableOpacity>
    {expanded && children ? <View style={styles.panel}>{children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 52,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#27272a",
    backgroundColor: "#18181b",
    gap: 12,
  },
  rowMissing: { borderColor: "#dc2626", backgroundColor: "#2a1215" },
  // Same amber warning family used elsewhere on this screen (ConfirmScreen.tsx's own
  // categoryWarning banner), one notch below rowMissing's red.
  rowNotable: { borderColor: "#d97706", backgroundColor: "#2a1f0a" },
  valueNotable: { color: "#fbbf24" },
  chevron: { color: "#a1a1aa", fontSize: 16 },
  panel: { borderWidth: 1, borderColor: "#27272a", borderTopWidth: 0, borderBottomLeftRadius: 10, borderBottomRightRadius: 10, padding: 12, gap: 12, backgroundColor: "#101012" },
  label: { color: "#a1a1aa", fontSize: 14 },
  valueWrap: { flexShrink: 1, alignItems: "flex-end" },
  value: { color: "#f4f4f5", fontSize: 16, fontWeight: "600", textAlign: "right" },
  valueMissing: { color: "#f87171" },
});
