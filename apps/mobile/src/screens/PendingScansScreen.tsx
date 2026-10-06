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
import { createManualPendingScan, discardScan, fetchPendingScans, fetchUpcQuotaStatus, type UpcQuotaStatus } from "../lib/scanApi";
import { clearConfirmDraft } from "../lib/confirmDrafts";
import { getHiddenPendingScanIds, useSubmissionsVersion } from "../lib/backgroundSubmissions";
import { CARD, CHROME_BAR, COLORS, FONTS, GLOSS, SCREEN, WELL } from "../theme";

export interface PendingScan {
  id: string;
  // null for a manual entry created via the "+" button - some of the collection's
  // custom-burned discs (the user's own creations) have no barcode to scan at all.
  barcode: string | null;
  status: "resolved" | "needs_manual";
  resolved_candidates: {
    // The full existing titles row when this barcode already belongs to a cataloged
    // entry - a rescan of a disc already in the collection (see ConfirmScreen's
    // "already logged" handling), not just a display title. `resolvedPosterUrl`
    // (added 2026-09-25) is a server-fetched fallback poster (scanResolver.ts's
    // `withResolvedPoster`) for when this entry's own `case_image_url` was never
    // captured - without it, the "best match" step has no image to show at all for an
    // already-cataloged title whose own case photo is missing.
    existingMatch?: Title & { resolvedPosterUrl?: string };
    omdbCandidates?: { Title: string; Year: string }[];
    upcProduct?: { title: string; description?: string; imageUrl?: string; category?: string };
    upcLookupFailed?: boolean;
    isCollection?: boolean;
    // The box set's own member titles, read directly off a scanned cover photo when it lists
    // them (packages/backend/src/coverVision.ts's collectionMemberTitles, added 2026-09-30) -
    // ConfirmScreen surfaces these as tappable suggestion chips in the Collection flow, never
    // auto-added. Null/undefined whenever no staged cover photo's analysis carried a list.
    coverMemberTitles?: string[] | null;
    // Best-effort vision-model format guess (packages/backend/src/formatVision.ts) - only
    // ever populated when the barcode listing's own text didn't already name the format, and
    // only ever a pre-fill suggestion on ConfirmScreen, never presented as confirmed fact.
    visionFormatGuess?: { format: string; steelbook: boolean; extraDiscs: "NONE" | "ONE_EXTRA" | "TWO_EXTRA" } | null;
    // LLM-based listing-text parse (packages/backend/src/listingTextExtract.ts) - only ever
    // populated when the plain regex-cleaned title search found zero OMDB candidates at all.
    // Shown read-only on ConfirmScreen for transparency into why a second-attempt search/cast
    // match came out the way it did; also feeds format/region pre-fill the same way
    // visionFormatGuess does, when the text-hint extractors found nothing themselves.
    listingTextExtraction?: {
      title: string;
      actors: string[];
      format: "DVD" | "Blu-Ray" | "4K UHD Blu-Ray" | "VHS" | "CD Movie" | null;
      region: string | null;
    } | null;
    // Cover-photo vision reads (packages/backend/src/coverVision.ts) - populated for any scan
    // with staged cover photos, not just a cover-only scan (a barcode scan that also captured
    // cover photos gets this too, riding along as a secondary pre-fill signal - see
    // scanResolver.ts). One entry per staged photo. Same "pre-fill suggestion, never
    // confirmed fact" status as visionFormatGuess above; ConfirmScreen takes the first
    // non-null value across every analysis for each field, since a value is only ever
    // reported when the model actually found it legible on that specific photo.
    coverAnalysis?: {
      stagedPath: string;
      analysis: {
        side: "front" | "back" | "unclear";
        title: string | null;
        mediaType: "Movie" | "TV Series" | "Unclear";
        format: "DVD" | "Blu-Ray" | "Blu-Ray 3D" | "4K UHD Blu-Ray" | "VHS" | "CD Movie" | null;
        discCount: number | null;
        rating: "G" | "PG" | "M" | "R12" | "R13" | "R15" | "R16" | "R18" | null;
        // Added 2026-09-29 - see coverVision.ts's own comment on why these exist (a real
        // "Five Nights at Freddy's" scan whose own cover photo showed a multi-disc banner, a
        // back-cover special-features list, and a region mark, none read before now).
        extraDiscs: "NONE" | "ONE_EXTRA" | "TWO_EXTRA";
        specialFeaturesListed: boolean | null;
        // Verbatim, unresolved region text (e.g. "Region 4", "UK") - can come from either the
        // front or back photo. ConfirmScreen.tsx resolves it via resolveDiskRegionText.
        region: string | null;
        // "drawn" vs "photographic" cover-art style, added 2026-10-01 - a confirming signal
        // for a classic Doctor Who serial's officially-released animated reconstruction (see
        // coverVision.ts and ConfirmScreen.tsx's Animation/Live Action prefill effect).
        artStyle: "drawn" | "photographic" | null;
        // A packaging/marketing edition name distinct from the base title (e.g. "Night Shift
        // Edition") - never a content-different cut, which stays merged into `title` instead.
        releaseName: string | null;
      };
    }[];
  };
  scanned_at: string;
}

function scanDisplayTitle(scan: PendingScan): string {
  const coverAnalysis = scan.resolved_candidates?.coverAnalysis ?? [];
  // Same front-preferred, else-any precedence as scanResolver.ts's own pickCoverDerivedTitle -
  // added 2026-09-30, found live: a real collection scan with no UPC listing (upcLookupFailed)
  // and no OMDB candidates (a collection's own title is never searched, see scanResolver.ts's
  // Collections comment) fell all the way through to the raw barcode number here, when the
  // cover photo had already read the real name ("Gidget Film Collection") perfectly fine.
  const coverDerivedTitle =
    coverAnalysis.find((a) => a.analysis.side === "front" && a.analysis.title)?.analysis.title ??
    coverAnalysis.find((a) => a.analysis.title)?.analysis.title ??
    null;
  return (
    scan.resolved_candidates?.existingMatch?.title ??
    scan.resolved_candidates?.omdbCandidates?.[0]?.Title ??
    scan.resolved_candidates?.upcProduct?.title ??
    coverDerivedTitle ??
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
  const [loadedScans, setLoadedScans] = useState<PendingScan[]>([]);
  // A scan whose Confirm save is running (or just succeeded) in the background (backgroundSubmissions.ts,
  // 2026-10-03) is hidden here so it can't be opened and submitted twice - it reappears on
  // its own the moment that save fails (re-rendered via useSubmissionsVersion), with its
  // draft intact. The server still lists it as unconfirmed until the write lands, which is
  // why this filter is client-side rather than part of the query.
  const submissionsVersion = useSubmissionsVersion();
  const scans = useMemo(() => {
    const saving = getHiddenPendingScanIds();
    return loadedScans.filter((s) => !saving.has(s.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedScans, submissionsVersion]);
  const [loading, setLoading] = useState(true);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [upcQuota, setUpcQuota] = useState<UpcQuotaStatus | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    // Via the web server since 2026-10-06 (migration 0044 removed the public key's direct read
    // access to pending_scans). A failed load keeps whatever list was already showing.
    try {
      const { scans } = await fetchPendingScans<PendingScan>();
      setLoadedScans(scans);
    } catch {
      // Offline or server unreachable - leave the current list in place.
    }
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
      // A deleted pending scan can never be reopened - its local autosaved draft, if any,
      // must go with it (same principle as the queue route's own replacedIds cleanup: a
      // draft should only ever outlive the pending_scans row it belongs to).
      idsToDelete.forEach(clearConfirmDraft);
      onDeleted?.(barcodes);
    } catch (err) {
      // Previously silent: a failed request (e.g. the scan API being unreachable) left the
      // item sitting in the list with no explanation - found live 2026-09-24 after a power
      // outage left apps/mobile/.env pointed at a stale LAN IP, so every delete failed but
      // looked like nothing had happened at all.
      Alert.alert("Couldn't delete", (err as Error).message);
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
  container: { ...SCREEN, flex: 1, backgroundColor: "#070d17" },
  header: {
    ...CHROME_BAR,
    padding: 16,
    paddingTop: 48,
    borderBottomWidth: 1,
    borderBottomColor: "#16294a",
    gap: 8,
  },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 14 },
  link: { fontFamily: FONTS.body, color: "#5cc8ff" },
  headerButton: { ...GLOSS, backgroundColor: COLORS.accentDeep, borderWidth: 1, borderColor: COLORS.accentDim, paddingVertical: 6, paddingHorizontal: 10 },
  headerButtonText: { fontFamily: FONTS.displaySemiBold, color: COLORS.accentHi, fontSize: 12, letterSpacing: 1, textTransform: "uppercase" },
  addButton: {
    ...GLOSS,
    backgroundColor: "#1d6c9a",
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  addButtonText: { letterSpacing: 1, color: "#fff", fontSize: 20, fontFamily: FONTS.displayBold, lineHeight: 22 },
  backButton: {
    ...GLOSS,
    backgroundColor: "#1d6c9a",
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 0,
  },
  backButtonText: { letterSpacing: 1, color: "#fff", fontSize: 15, fontFamily: FONTS.displayBold },
  deleteLink: { fontFamily: FONTS.body, color: "#f87171" },
  deleteLinkDisabled: { fontFamily: FONTS.body, color: "#52171a" },
  title: { color: "#e9f1f9", fontSize: 18, fontFamily: FONTS.displayBold },
  quotaRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 10 },
  quotaBarTrack: { ...WELL, flex: 1, height: 6, borderRadius: 3, backgroundColor: "#16294a", overflow: "hidden" },
  quotaBarFill: { height: "100%", backgroundColor: "#eab308", borderRadius: 0 },
  quotaBarFillExhausted: { backgroundColor: "#f87171" },
  quotaCount: { fontFamily: FONTS.body, color: "#8193ab", fontSize: 11 },
  // A translucent strip, so the screen gradient shows through behind the list.
  sectionHeader: {
    color: COLORS.accent,
    fontSize: 12,
    fontFamily: FONTS.displaySemiBold,
    textTransform: "uppercase",
    letterSpacing: 2,
    backgroundColor: "rgba(7,13,23,0.82)",
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
  },
  row: {
    ...CARD,
    padding: 14,
    marginHorizontal: 12,
    marginBottom: 8,
  },
  rowContent: { flexDirection: "row", alignItems: "center", gap: 12 },
  rowText: { flex: 1 },
  rowTitle: { fontFamily: FONTS.body, color: "#e9f1f9", fontSize: 16 },
  rowStatus: { fontFamily: FONTS.body, color: "#a9b8cc", marginTop: 4 },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: "#56667d",
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxChecked: { backgroundColor: "#5cc8ff", borderColor: "#5cc8ff" },
  checkboxMark: { color: "#070d17", fontSize: 13, fontFamily: FONTS.displayBold },
  emptyContainer: { flexGrow: 1, justifyContent: "center", alignItems: "center" },
  empty: { fontFamily: FONTS.body, color: "#a9b8cc" },
});
