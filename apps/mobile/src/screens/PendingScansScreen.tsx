import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Title } from "@danflix/shared";
import { supabase } from "../lib/supabase";
import { createManualPendingScan, discardScan, fetchUpcQuotaStatus, type UpcQuotaStatus } from "../lib/scanApi";

export interface PendingScan {
  id: string;
  // null for a manual entry created via the "+" button - some of the collection's
  // custom-burned discs (the user's own creations) have no barcode to scan at all.
  barcode: string | null;
  status: "resolved" | "needs_manual";
  resolved_candidates: {
    // The full existing titles row when this barcode already belongs to a cataloged
    // entry - a rescan of a disc already in the collection (see ConfirmScreen's
    // "already logged" handling), not just a display title.
    existingMatch?: Title;
    omdbCandidates?: { Title: string; Year: string }[];
    upcProduct?: { title: string; description?: string; imageUrl?: string; category?: string };
    upcLookupFailed?: boolean;
    isCollection?: boolean;
    // Best-effort vision-model format guess (packages/backend/src/formatVision.ts) - only
    // ever populated when the barcode listing's own text didn't already name the format, and
    // only ever a pre-fill suggestion on ConfirmScreen, never presented as confirmed fact.
    visionFormatGuess?: { format: string; steelbook: boolean; extraDiscs: "NONE" | "ONE_EXTRA" | "TWO_EXTRA" } | null;
  };
  scanned_at: string;
}

function scanDisplayTitle(scan: PendingScan): string {
  return (
    scan.resolved_candidates?.existingMatch?.title ??
    scan.resolved_candidates?.omdbCandidates?.[0]?.Title ??
    scan.resolved_candidates?.upcProduct?.title ??
    scan.barcode ??
    "New entry"
  );
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function dateSectionLabel(iso: string): string {
  const scanned = new Date(iso);
  const now = new Date();
  const diffDays = Math.round((startOfDay(now) - startOfDay(scanned)) / 86_400_000);

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return scanned.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: scanned.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}

interface ScanSection {
  key: string;
  title: string;
  data: PendingScan[];
}

/** Assumes scans are already sorted by scanned_at so each date's scans stay contiguous. */
function groupByDate(scans: PendingScan[]): ScanSection[] {
  const sections: ScanSection[] = [];
  for (const scan of scans) {
    const key = String(startOfDay(new Date(scan.scanned_at)));
    const current = sections[sections.length - 1];
    if (current && current.key === key) {
      current.data.push(scan);
    } else {
      sections.push({ key, title: dateSectionLabel(scan.scanned_at), data: [scan] });
    }
  }
  return sections;
}

export default function PendingScansScreen({
  onSelect,
  onBack,
  onDeleted,
  onGoToOfflineQueue,
  offlineQueueCount,
}: {
  onSelect: (scan: PendingScan) => void;
  onBack: () => void;
  /** Called with the barcodes of every scan just deleted, so the scanner's re-scan
   * cooldown can forget them - the user explicitly said they want to rescan it. */
  onDeleted?: (barcodes: string[]) => void;
  /** Offline-submission queue (offlineQueue.ts, added 2026-09-18) - not tied to the
   * private-only pricing feature, so unlike Pending Value below this stays in the public
   * repo too. */
  onGoToOfflineQueue?: () => void;
  offlineQueueCount?: number;
}) {
  const insets = useSafeAreaInsets();
  const [scans, setScans] = useState<PendingScan[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [upcQuota, setUpcQuota] = useState<UpcQuotaStatus | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("pending_scans")
      .select("*")
      .in("status", ["resolved", "needs_manual"])
      .order("scanned_at", { ascending: true });
    setScans((data as PendingScan[] | null) ?? []);
    setLoading(false);
    // Refreshed alongside the scan list (every mount, pull-to-refresh and post-delete reload),
    // not on a timer - the server-side resolver (the one real spender of UPC quota) runs
    // around the same time new scans get resolved, so this screen's own load points are
    // already the moments the number could have moved.
    fetchUpcQuotaStatus()
      .then(({ quota }) => setUpcQuota(quota))
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const sections = useMemo(() => groupByDate(scans), [scans]);

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function startSelecting(id: string) {
    setSelectionMode(true);
    setSelectedIds(new Set([id]));
  }

  function cancelSelecting() {
    setSelectionMode(false);
    setSelectedIds(new Set());
  }

  function confirmDelete() {
    const count = selectedIds.size;
    if (count === 0) return;
    Alert.alert(
      `Delete ${count} scan${count === 1 ? "" : "s"}?`,
      "This can't be undone.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: doDelete },
      ]
    );
  }

  async function doDelete() {
    setDeleting(true);
    const idsToDelete = [...selectedIds];
    const barcodes = scans
      .filter((s) => selectedIds.has(s.id))
      .map((s) => s.barcode)
      .filter((b): b is string => b !== null);
    try {
      await Promise.all(idsToDelete.map((id) => discardScan(id)));
      onDeleted?.(barcodes);
    } finally {
      setDeleting(false);
      cancelSelecting();
      load();
    }
  }

  /** "+" button: some of the collection's custom-burned discs have no barcode to scan at
   * all (the user's own creations, some not even listed on IMDb) - this creates a pending
   * scan directly and jumps straight into ConfirmScreen's manual title-search step. */
  async function createManualEntry() {
    setCreating(true);
    try {
      const { scan } = await createManualPendingScan();
      onSelect(scan as PendingScan);
    } catch (err) {
      Alert.alert("Couldn't create entry", (err as Error).message);
    } finally {
      setCreating(false);
    }
  }

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: 16 + insets.top }]}>
        <View style={styles.headerRow}>
          <TouchableOpacity
            style={styles.backButton}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            onPress={selectionMode ? cancelSelecting : onBack}
          >
            <Text style={styles.backButtonText}>{selectionMode ? "Cancel" : "< Scanner"}</Text>
          </TouchableOpacity>
          {selectionMode ? (
            <TouchableOpacity onPress={confirmDelete} disabled={selectedIds.size === 0 || deleting}>
              <Text
                style={[
                  styles.link,
                  styles.deleteLink,
                  (selectedIds.size === 0 || deleting) && styles.deleteLinkDisabled,
                ]}
              >
                {deleting ? "Deleting..." : `Delete (${selectedIds.size})`}
              </Text>
            </TouchableOpacity>
          ) : (
            <View style={styles.headerActions}>
              {scans.length > 0 && (
                <TouchableOpacity onPress={() => setSelectionMode(true)}>
                  <Text style={styles.link}>Select</Text>
                </TouchableOpacity>
              )}
              {onGoToOfflineQueue && !!offlineQueueCount && (
                <TouchableOpacity onPress={onGoToOfflineQueue}>
                  <Text style={styles.link}>Offline Queue ({offlineQueueCount})</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={styles.addButton}
                onPress={createManualEntry}
                disabled={creating}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={styles.addButtonText}>{creating ? "..." : "+"}</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
        <Text style={styles.title}>
          {selectionMode ? `${selectedIds.size} selected` : `Pending Scans (${scans.length})`}
        </Text>
        {upcQuota && !selectionMode && (
          <View style={styles.quotaRow}>
            <View style={styles.quotaBarTrack}>
              <View
                style={[
                  styles.quotaBarFill,
                  { width: `${Math.min(100, (upcQuota.used / upcQuota.limit) * 100)}%` },
                  upcQuota.remaining === 0 && styles.quotaBarFillExhausted,
                ]}
              />
            </View>
            <Text style={styles.quotaCount}>
              UPC lookups: {upcQuota.used}/{upcQuota.limit} today
            </Text>
          </View>
        )}
      </View>
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}
        contentContainerStyle={[
          scans.length === 0 ? styles.emptyContainer : undefined,
          { paddingBottom: insets.bottom },
        ]}
        ListEmptyComponent={<Text style={styles.empty}>No pending scans to review.</Text>}
        renderSectionHeader={({ section }) => (
          <Text style={styles.sectionHeader}>{section.title}</Text>
        )}
        renderItem={({ item }) => {
          const checked = selectedIds.has(item.id);
          return (
            <TouchableOpacity
              style={styles.row}
              onPress={() => (selectionMode ? toggleSelected(item.id) : onSelect(item))}
              onLongPress={() => !selectionMode && startSelecting(item.id)}
            >
              <View style={styles.rowContent}>
                {selectionMode && (
                  <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
                    {checked && <Text style={styles.checkboxMark}>✓</Text>}
                  </View>
                )}
                <View style={styles.rowText}>
                  <Text style={styles.rowTitle}>{scanDisplayTitle(item)}</Text>
                  <Text style={styles.rowStatus}>
                    {item.status === "needs_manual" ? "Needs manual entry" : "Ready to confirm"}
                  </Text>
                </View>
              </View>
            </TouchableOpacity>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#09090b" },
  header: {
    padding: 16,
    paddingTop: 48,
    borderBottomWidth: 1,
    borderBottomColor: "#27272a",
    gap: 8,
  },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 14 },
  link: { color: "#38bdf8" },
  addButton: {
    backgroundColor: "#0284c7",
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  addButtonText: { color: "#fff", fontSize: 20, fontWeight: "700", lineHeight: 22 },
  backButton: {
    backgroundColor: "#0284c7",
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
  },
  backButtonText: { color: "#fff", fontSize: 15, fontWeight: "700" },
  deleteLink: { color: "#f87171" },
  deleteLinkDisabled: { color: "#52171a" },
  title: { color: "#f4f4f5", fontSize: 18, fontWeight: "700" },
  quotaRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 10 },
  quotaBarTrack: { flex: 1, height: 6, borderRadius: 3, backgroundColor: "#27272a", overflow: "hidden" },
  quotaBarFill: { height: "100%", backgroundColor: "#eab308", borderRadius: 3 },
  quotaBarFillExhausted: { backgroundColor: "#f87171" },
  quotaCount: { color: "#71717a", fontSize: 11 },
  sectionHeader: {
    color: "#a1a1aa",
    fontSize: 13,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    backgroundColor: "#09090b",
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
  },
  row: {
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#27272a",
  },
  rowContent: { flexDirection: "row", alignItems: "center", gap: 12 },
  rowText: { flex: 1 },
  rowTitle: { color: "#f4f4f5", fontSize: 16 },
  rowStatus: { color: "#a1a1aa", marginTop: 4 },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: "#52525b",
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxChecked: { backgroundColor: "#38bdf8", borderColor: "#38bdf8" },
  checkboxMark: { color: "#09090b", fontSize: 13, fontWeight: "700" },
  emptyContainer: { flexGrow: 1, justifyContent: "center", alignItems: "center" },
  empty: { color: "#a1a1aa" },
});
