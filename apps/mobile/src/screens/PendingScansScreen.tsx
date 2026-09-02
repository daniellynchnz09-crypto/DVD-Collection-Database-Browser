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
import { supabase } from "../lib/supabase";
import { discardScan } from "../lib/scanApi";

export interface PendingScan {
  id: string;
  barcode: string;
  status: "resolved" | "needs_manual";
  resolved_candidates: {
    existingMatch?: { title: string };
    omdbCandidates?: { Title: string; Year: string }[];
    upcProduct?: { title: string; description?: string; imageUrl?: string };
    upcLookupFailed?: boolean;
    isCollection?: boolean;
  };
  scanned_at: string;
}

function scanDisplayTitle(scan: PendingScan): string {
  return (
    scan.resolved_candidates?.existingMatch?.title ??
    scan.resolved_candidates?.omdbCandidates?.[0]?.Title ??
    scan.resolved_candidates?.upcProduct?.title ??
    scan.barcode
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
}: {
  onSelect: (scan: PendingScan) => void;
  onBack: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [scans, setScans] = useState<PendingScan[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("pending_scans")
      .select("*")
      .in("status", ["resolved", "needs_manual"])
      .order("scanned_at", { ascending: true });
    setScans((data as PendingScan[] | null) ?? []);
    setLoading(false);
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
    try {
      await Promise.all([...selectedIds].map((id) => discardScan(id)));
    } finally {
      setDeleting(false);
      cancelSelecting();
      load();
    }
  }

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: 16 + insets.top }]}>
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={selectionMode ? cancelSelecting : onBack}>
            <Text style={styles.link}>{selectionMode ? "Cancel" : "< Scanner"}</Text>
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
          ) : scans.length > 0 ? (
            <TouchableOpacity onPress={() => setSelectionMode(true)}>
              <Text style={styles.link}>Select</Text>
            </TouchableOpacity>
          ) : null}
        </View>
        <Text style={styles.title}>
          {selectionMode ? `${selectedIds.size} selected` : `Pending Scans (${scans.length})`}
        </Text>
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
  link: { color: "#38bdf8" },
  deleteLink: { color: "#f87171" },
  deleteLinkDisabled: { color: "#52171a" },
  title: { color: "#f4f4f5", fontSize: 18, fontWeight: "700" },
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
