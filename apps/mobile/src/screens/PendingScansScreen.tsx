import { useCallback, useEffect, useState } from "react";
import { FlatList, RefreshControl, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { supabase } from "../lib/supabase";

export interface PendingScan {
  id: string;
  barcode: string;
  status: "resolved" | "needs_manual";
  resolved_candidates: {
    existingMatch?: { title: string };
    omdbCandidates?: { Title: string; Year: string }[];
    upcProduct?: { title: string };
    upcLookupFailed?: boolean;
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

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: 16 + insets.top }]}>
        <TouchableOpacity onPress={onBack}>
          <Text style={styles.link}>{"< Scanner"}</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Pending Scans ({scans.length})</Text>
      </View>
      <FlatList
        data={scans}
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}
        contentContainerStyle={[
          scans.length === 0 ? styles.emptyContainer : undefined,
          { paddingBottom: insets.bottom },
        ]}
        ListEmptyComponent={<Text style={styles.empty}>No pending scans to review.</Text>}
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.row} onPress={() => onSelect(item)}>
            <Text style={styles.rowTitle}>{scanDisplayTitle(item)}</Text>
            <Text style={styles.rowStatus}>
              {item.status === "needs_manual" ? "Needs manual entry" : "Ready to confirm"}
            </Text>
          </TouchableOpacity>
        )}
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
  link: { color: "#38bdf8" },
  title: { color: "#f4f4f5", fontSize: 18, fontWeight: "700" },
  row: {
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#27272a",
  },
  rowTitle: { color: "#f4f4f5", fontSize: 16 },
  rowStatus: { color: "#a1a1aa", marginTop: 4 },
  emptyContainer: { flexGrow: 1, justifyContent: "center", alignItems: "center" },
  empty: { color: "#a1a1aa" },
});
