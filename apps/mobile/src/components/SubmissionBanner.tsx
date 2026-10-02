import { useEffect } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  acknowledgeSubmission,
  getNextUnacknowledgedSubmission,
  useSubmissionsVersion,
} from "../lib/backgroundSubmissions";

const SUCCESS_VISIBLE_MS = 4000;
const FAILURE_VISIBLE_MS = 7000;

/**
 * In-app tick/cross banner for a background save that finished after the user had already
 * left SuccessScreen (2026-10-03 - see backgroundSubmissions.ts). One at a time; auto-hides
 * (a failure stays up a little longer), or tap to dismiss. Hidden entirely while
 * `suppressedSubmissionId` - the one SuccessScreen is currently showing - is the next in line,
 * since that screen already shows its outcome itself.
 */
export default function SubmissionBanner({ suppressedSubmissionId }: { suppressedSubmissionId: string | null }) {
  const insets = useSafeAreaInsets();
  useSubmissionsVersion();
  const next = getNextUnacknowledgedSubmission();
  const visible = next && next.id !== suppressedSubmissionId ? next : null;

  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(
      () => acknowledgeSubmission(visible.id),
      visible.status === "failed" ? FAILURE_VISIBLE_MS : SUCCESS_VISIBLE_MS
    );
    return () => clearTimeout(timer);
  }, [visible?.id]);

  if (!visible) return null;
  const failed = visible.status === "failed";
  return (
    <View pointerEvents="box-none" style={[styles.wrapper, { top: insets.top + 8 }]}>
      <TouchableOpacity
        activeOpacity={0.85}
        onPress={() => acknowledgeSubmission(visible.id)}
        style={[styles.banner, failed ? styles.bannerFailed : styles.bannerSucceeded]}
      >
        <Text style={[styles.icon, failed ? styles.iconFailed : styles.iconSucceeded]}>{failed ? "✕" : "✓"}</Text>
        <View style={styles.textBlock}>
          <Text style={styles.title} numberOfLines={1}>
            {visible.title}
          </Text>
          <Text style={styles.subtitle} numberOfLines={2}>
            {failed ? "Scan failed - still in Pending Scans" : "Scan succeeded"}
          </Text>
        </View>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { position: "absolute", left: 12, right: 12, zIndex: 1000, elevation: 1000 },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    backgroundColor: "#18181b",
  },
  bannerSucceeded: { borderColor: "#166534" },
  bannerFailed: { borderColor: "#991b1b" },
  icon: { fontSize: 20, fontWeight: "700" },
  iconSucceeded: { color: "#4ade80" },
  iconFailed: { color: "#f87171" },
  textBlock: { flex: 1 },
  title: { color: "#fafafa", fontWeight: "600" },
  subtitle: { color: "#a1a1aa", fontSize: 12 },
});
