import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, FlatList, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { confirmScan, ScanApiError, yearSuffix } from "../lib/scanApi";
import {
  getQueuedSubmissions,
  removeQueuedSubmission,
  trySyncOfflineQueue,
  type QueuedSubmission,
} from "../lib/offlineQueue";
import { CHROME_BAR, FONTS, GLOSS, SCREEN } from "../theme";

/**
 * Lists every Confirm submission saved on-device while offline (offlineQueue.ts) - added
 * 2026-09-18. Most items here just show a status and resolve themselves automatically once
 * the app is back online and `trySyncOfflineQueue` runs (triggered from App.tsx on
 * reconnect); this screen exists specifically for the one case that can't resolve itself - a
 * `needs_review` item, where the automatic resync found a real possible duplicate and, per
 * the user's own explicit spec, left the Overwrite/Is-a-new-entry/Reject decision for the
 * user to make by hand instead of guessing or showing it as an unattended live dialog.
 *
 * A deliberately smaller decision UI than ConfirmScreen's own similar-entry screen - no
 * poster/side-by-side field comparison, just enough to tell the candidates apart (title,
 * release name, format, disc count) and make the same three-way choice.
 */
export default function OfflineQueueScreen({ onBack }: { onBack: () => void }) {
  const insets = useSafeAreaInsets();
  const [items, setItems] = useState<QueuedSubmission[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await getQueuedSubmissions());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSyncNow() {
    setSyncing(true);
    try {
      const result = await trySyncOfflineQueue();
      await load();
      Alert.alert(
        "Sync complete",
        `Submitted: ${result.submitted}. Needs your review: ${result.flagged}. Failed (will retry): ${result.failed}.`
      );
    } catch (err) {
      Alert.alert("Sync failed", (err as Error).message);
    } finally {
      setSyncing(false);
    }
  }

  async function resolveAsOverwrite(item: QueuedSubmission, uniqueId: string) {
    setResolvingId(item.id);
    try {
      // overwriteUniqueId moved from a request-level field to a per-entry one (2026-09-20,
      // for the Collection scanning flow) - this queue only ever holds single-entry
      // submissions (see offlineQueue.ts's own header comment), so it's attached to that one
      // entry here.
      const entries =
        item.entries.length > 0
          ? [{ ...item.entries[0], overwriteUniqueId: uniqueId }, ...item.entries.slice(1)]
          : item.entries;
      await confirmScan(item.pendingScanId, entries);
      await removeQueuedSubmission(item.id);
      await load();
    } catch (err) {
      // Already saved (409) - nothing left to do, so the item just goes (2026-10-09).
      if (err instanceof ScanApiError && err.status === 409) {
        await removeQueuedSubmission(item.id);
        await load();
        return;
      }
      Alert.alert("Couldn't submit", (err as Error).message);
    } finally {
      setResolvingId(null);
    }
  }

  async function resolveAsNewEntry(item: QueuedSubmission) {
    setResolvingId(item.id);
    try {
      await confirmScan(item.pendingScanId, item.entries);
      await removeQueuedSubmission(item.id);
      await load();
    } catch (err) {
      // Already saved (409) - nothing left to do, so the item just goes (2026-10-09).
      if (err instanceof ScanApiError && err.status === 409) {
        await removeQueuedSubmission(item.id);
        await load();
        return;
      }
      Alert.alert("Couldn't submit", (err as Error).message);
    } finally {
      setResolvingId(null);
    }
  }

  function resolveAsReject(item: QueuedSubmission) {
    Alert.alert("Reject this entry?", "This queued entry will be discarded and never added to your collection.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Reject",
        style: "destructive",
        onPress: async () => {
          await removeQueuedSubmission(item.id);
          await load();
        },
      },
    ]);
  }

  function statusLabel(item: QueuedSubmission): string {
    if (item.status === "queued") return "Waiting to sync";
    if (item.status === "error") return `Sync failed, will retry - ${item.lastError ?? "unknown error"}`;
    return "Needs your review - a possible duplicate was found";
  }

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: 16 + insets.top }]}>
        <TouchableOpacity style={styles.backButton} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} onPress={onBack}>
          <Text style={styles.backButtonText}>{"< Pending Scans"}</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Offline Queue ({items.length})</Text>
        <TouchableOpacity style={[styles.syncButton, syncing && styles.syncButtonDisabled]} onPress={handleSyncNow} disabled={syncing}>
          {syncing ? <ActivityIndicator color="#fff" /> : <Text style={styles.syncButtonText}>Sync Now</Text>}
        </TouchableOpacity>
      </View>
      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        refreshing={loading}
        onRefresh={load}
        contentContainerStyle={[items.length === 0 ? styles.emptyContainer : undefined, { paddingBottom: insets.bottom }]}
        ListEmptyComponent={<Text style={styles.empty}>Nothing queued - every offline entry has been submitted.</Text>}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <Text style={styles.rowTitle}>{item.displayTitle}</Text>
            <Text style={styles.rowStatus}>{statusLabel(item)}</Text>
            {item.status === "needs_review" && item.reviewResult && (
              <View style={styles.reviewSection}>
                {(item.reviewResult.status === "auto" ? [item.reviewResult.match] : item.reviewResult.candidates).map((c) => (
                  <View key={c.unique_id} style={styles.candidateRow}>
                    <Text style={styles.candidateText}>
                      {c.title}
                      {yearSuffix(c.release_date)}
                      {c.release_name ? ` (${c.release_name})` : ""} - {c.format}, {c.disc_count} disc{c.disc_count === 1 ? "" : "s"}
                    </Text>
                    <TouchableOpacity
                      style={styles.smallButton}
                      onPress={() => resolveAsOverwrite(item, c.unique_id)}
                      disabled={resolvingId === item.id}
                    >
                      <Text style={styles.smallButtonText}>Overwrite this one</Text>
                    </TouchableOpacity>
                  </View>
                ))}
                <View style={styles.decisionRow}>
                  <TouchableOpacity
                    style={[styles.smallButton, styles.smallButtonGreen]}
                    onPress={() => resolveAsNewEntry(item)}
                    disabled={resolvingId === item.id}
                  >
                    <Text style={styles.smallButtonText}>Is a new entry</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.smallButton, styles.smallButtonRed]}
                    onPress={() => resolveAsReject(item)}
                    disabled={resolvingId === item.id}
                  >
                    <Text style={styles.smallButtonText}>Reject</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { ...SCREEN, flex: 1, backgroundColor: "#070d17" },
  header: { ...CHROME_BAR, padding: 16, borderBottomWidth: 1, borderBottomColor: "#16294a", gap: 8 },
  backButton: { ...GLOSS, backgroundColor: "#1d6c9a", paddingVertical: 10, paddingHorizontal: 16, borderRadius: 0, alignSelf: "flex-start" },
  backButtonText: { letterSpacing: 1, color: "#fff", fontSize: 15, fontFamily: FONTS.displayBold },
  title: { color: "#e9f1f9", fontSize: 18, fontFamily: FONTS.displayBold },
  syncButton: { ...GLOSS, backgroundColor: "#78350f", paddingVertical: 10, borderRadius: 0, alignItems: "center" },
  syncButtonDisabled: { opacity: 0.6 },
  syncButtonText: { letterSpacing: 1, color: "#fde68a", fontSize: 14, fontFamily: FONTS.displayBold },
  row: { padding: 16, gap: 4, borderBottomWidth: 1, borderBottomColor: "#16294a" },
  rowTitle: { color: "#e9f1f9", fontSize: 16, fontFamily: FONTS.displaySemiBold },
  rowStatus: { fontFamily: FONTS.body, color: "#a9b8cc", fontSize: 13 },
  reviewSection: { marginTop: 10, gap: 8 },
  candidateRow: { gap: 6, borderWidth: 1, borderColor: "#24395a", borderRadius: 0, padding: 10 },
  candidateText: { fontFamily: FONTS.body, color: "#d7e2ee", fontSize: 13 },
  decisionRow: { flexDirection: "row", gap: 8, marginTop: 4 },
  smallButton: { ...GLOSS, backgroundColor: "#16294a", paddingVertical: 8, paddingHorizontal: 12, borderRadius: 0, alignItems: "center", flex: 1 },
  smallButtonGreen: { ...GLOSS, backgroundColor: "#166534" },
  smallButtonRed: { ...GLOSS, backgroundColor: "#7f1d1d" },
  smallButtonText: { letterSpacing: 1, color: "#e9f1f9", fontSize: 12, fontFamily: FONTS.displaySemiBold },
  emptyContainer: { flexGrow: 1, justifyContent: "center", alignItems: "center" },
  empty: { fontFamily: FONTS.body, color: "#a9b8cc", padding: 16, textAlign: "center" },
});
