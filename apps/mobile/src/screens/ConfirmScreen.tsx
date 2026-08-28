import { useState } from "react";
import {
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  confirmScan,
  discardScan,
  dismissScan,
  findExistingTitle,
  linkExistingTitle,
  type ConfirmEntry,
  type ExistingTitleCandidate,
  type FindExistingResult,
} from "../lib/scanApi";
import type { PendingScan } from "./PendingScansScreen";

interface OmdbCandidate {
  Title: string;
  Year: string;
  imdbID: string;
  Type: string;
}

type ShelfLocation = { before: string | null; after: string | null } | null;
type MatchCheck = Extract<FindExistingResult, { status: "auto" | "ambiguous" }>;

/**
 * Review/manual-fill form for one pending scan. Per Claude/TECH STACK AND
 * ARCHITECTURE.md: OMDB/UPC can suggest a match but never knows packaging details
 * (format, disc count, region, special features) - those are always manual. When the
 * resolver flagged this as a collection, candidates become a checklist instead of a
 * single pick, so every checked title gets its own entry in one submit.
 *
 * Before creating anything (single-title case only - collections aren't matched this way
 * yet), checks whether the title is already in the collection without a barcode attached
 * (the bulk-backfill scenario) and offers to attach this scan to that entry instead of
 * making a duplicate.
 */
export default function ConfirmScreen({
  scan,
  onConfirmed,
  onBack,
}: {
  scan: PendingScan;
  onConfirmed: (result: { shelfLocation: ShelfLocation; linkedTitle?: string }) => void;
  onBack: () => void;
}) {
  const insets = useSafeAreaInsets();
  const candidates = (scan.resolved_candidates?.omdbCandidates ?? []) as OmdbCandidate[];
  const isCollection = Boolean(scan.resolved_candidates?.isCollection);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [manualTitle, setManualTitle] = useState("");
  const [format, setFormat] = useState("DVD");
  const [discCount, setDiscCount] = useState("1");
  const [diskRegion, setDiskRegion] = useState("");
  const [genreLocation, setGenreLocation] = useState("");
  const [specialFeatures, setSpecialFeatures] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [checkingExisting, setCheckingExisting] = useState(false);
  const [existingCheck, setExistingCheck] = useState<MatchCheck | null>(null);
  const [chosenExistingId, setChosenExistingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedTypes = candidates.filter((c) => selected.has(c.imdbID)).map((c) => c.Type);
  const showTvFields = selectedTypes.some((t) => t === "series" || t === "episode");

  function toggleCandidate(imdbId: string) {
    setSelected((prev) => {
      const next = new Set(isCollection ? prev : []);
      if (prev.has(imdbId)) {
        next.delete(imdbId);
      } else {
        next.add(imdbId);
      }
      return next;
    });
  }

  async function handleDismiss() {
    setSubmitting(true);
    try {
      await dismissScan(scan.id);
      onBack();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function performCreate() {
    setSubmitting(true);
    setError(null);
    try {
      const manualFields = {
        format,
        disc_count: parseInt(discCount, 10) || 1,
        disk_region: diskRegion || null,
        genre_location: genreLocation || null,
        special_features: specialFeatures,
        case_image_url: scan.resolved_candidates?.upcProduct?.imageUrl ?? null,
        ...(selected.size === 0 ? { title: manualTitle || scan.barcode } : {}),
      };

      const chosen = candidates.filter((c) => selected.has(c.imdbID));
      const entries: ConfirmEntry[] =
        chosen.length > 0
          ? chosen.map((c, i) => ({
              imdbId: c.imdbID,
              barcodeId: i === 0 ? scan.barcode : undefined,
              manualFields,
            }))
          : [{ barcodeId: scan.barcode, manualFields }];

      const result = await confirmScan(scan.id, entries);
      onConfirmed({ shelfLocation: result.shelfLocation });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  /** Confirm button: for a single (non-collection) title, check for a backfill match
   * before creating anything - only proceeds straight to performCreate() when there's
   * genuinely nothing to match against. */
  async function handleConfirmPressed() {
    setError(null);
    if (isCollection && selected.size > 1) {
      await performCreate();
      return;
    }

    const titleForMatch =
      selected.size === 1
        ? candidates.find((c) => selected.has(c.imdbID))?.Title ?? null
        : selected.size === 0
          ? manualTitle.trim() || null
          : null;

    if (!titleForMatch) {
      await performCreate();
      return;
    }

    setCheckingExisting(true);
    try {
      const upcText = `${scan.resolved_candidates?.upcProduct?.title ?? ""} ${scan.resolved_candidates?.upcProduct?.description ?? ""}`.trim();
      const result = await findExistingTitle(titleForMatch, upcText);
      if (result.status === "none") {
        await performCreate();
      } else {
        setExistingCheck(result);
        if (result.status === "auto") setChosenExistingId(result.match.unique_id);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCheckingExisting(false);
    }
  }

  async function handleAttachExisting() {
    if (!chosenExistingId) return;
    setSubmitting(true);
    setError(null);
    try {
      const imdbId = selected.size === 1 ? [...selected][0] : undefined;
      const result = await linkExistingTitle({
        pendingScanId: scan.id,
        existingUniqueId: chosenExistingId,
        barcode: scan.barcode,
        imdbId,
        caseImageUrl: scan.resolved_candidates?.upcProduct?.imageUrl,
      });
      onConfirmed({ shelfLocation: null, linkedTitle: result.linkedTitle });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleTreatAsNew() {
    setExistingCheck(null);
    setChosenExistingId(null);
    await performCreate();
  }

  /** For a stray/junk read (e.g. a neighbouring disc's barcode glimpsed while lining up a
   * shot) that was never meant to be catalogued at all - deletes it outright. */
  async function handleDiscard() {
    setSubmitting(true);
    setError(null);
    try {
      await discardScan(scan.id);
      onBack();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  if (scan.resolved_candidates?.existingMatch) {
    return (
      <View
        style={[
          styles.container,
          {
            justifyContent: "center",
            alignItems: "center",
            gap: 16,
            padding: 24,
            paddingTop: 24 + insets.top,
            paddingBottom: 24 + insets.bottom,
          },
        ]}
      >
        <Text style={styles.title}>Already logged</Text>
        <Text style={styles.body}>
          This disc matches an existing entry: {scan.resolved_candidates.existingMatch.title}
        </Text>
        <TouchableOpacity style={styles.button} onPress={handleDismiss} disabled={submitting}>
          <Text style={styles.buttonText}>Dismiss</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={handleDiscard} disabled={submitting}>
          <Text style={styles.link}>Not this - discard the scan</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onBack}>
          <Text style={styles.link}>Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (existingCheck) {
    return (
      <ScrollView
        style={styles.container}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingTop: 48 + insets.top, paddingBottom: 24 + insets.bottom },
        ]}
      >
        <Text style={styles.title}>Matches your collection</Text>
        {existingCheck.status === "auto" ? (
          <Text style={styles.body}>
            This looks like your existing entry for &quot;{existingCheck.match.title}&quot; (
            {existingCheck.match.format}, {existingCheck.match.disc_count} disc
            {existingCheck.match.disc_count === 1 ? "" : "s"}). Attach this barcode and its image to
            that entry instead of creating a new one?
          </Text>
        ) : (
          <>
            <Text style={styles.body}>
              A few entries in your collection share this title. Which one is this disc?
            </Text>
            {existingCheck.candidates.map((c: ExistingTitleCandidate) => (
              <TouchableOpacity
                key={c.unique_id}
                style={[
                  styles.candidateRow,
                  chosenExistingId === c.unique_id && styles.candidateRowSelected,
                ]}
                onPress={() => setChosenExistingId(c.unique_id)}
              >
                <Text style={styles.candidateText}>
                  {chosenExistingId === c.unique_id ? "(o) " : "( ) "}
                  {c.title} - {c.format}, {c.disc_count} disc{c.disc_count === 1 ? "" : "s"}
                </Text>
              </TouchableOpacity>
            ))}
          </>
        )}

        {error && <Text style={styles.error}>{error}</Text>}

        <TouchableOpacity
          style={styles.button}
          onPress={handleAttachExisting}
          disabled={submitting || !chosenExistingId}
        >
          <Text style={styles.buttonText}>{submitting ? "Saving..." : "Attach to this entry"}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={handleTreatAsNew} disabled={submitting}>
          <Text style={styles.link}>No, this is a different item - add as new</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={handleDiscard} disabled={submitting}>
          <Text style={styles.link}>Neither - this was a stray scan, discard it</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[
        styles.scrollContent,
        { paddingTop: 48 + insets.top, paddingBottom: 24 + insets.bottom },
      ]}
    >
      <TouchableOpacity onPress={onBack}>
        <Text style={styles.link}>{"< Pending Scans"}</Text>
      </TouchableOpacity>
      <Text style={styles.title}>Barcode {scan.barcode}</Text>

      {isCollection && <Text style={styles.hint}>Looks like a collection - check every title actually in this set.</Text>}

      {candidates.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.label}>{isCollection ? "Titles in this set" : "Best match"}</Text>
          {candidates.map((c) => (
            <TouchableOpacity
              key={c.imdbID}
              style={[styles.candidateRow, selected.has(c.imdbID) && styles.candidateRowSelected]}
              onPress={() => toggleCandidate(c.imdbID)}
            >
              <Text style={styles.candidateText}>
                {selected.has(c.imdbID) ? "[x] " : "[ ] "}
                {c.Title} ({c.Year})
              </Text>
            </TouchableOpacity>
          ))}
          {isCollection && (
            <TouchableOpacity onPress={() => setSelected(new Set())}>
              <Text style={styles.link}>None of these match - enter manually</Text>
            </TouchableOpacity>
          )}
        </View>
      ) : (
        <Text style={styles.hint}>No match found - enter this title manually.</Text>
      )}

      {selected.size === 0 && (
        <View style={styles.section}>
          <Text style={styles.label}>Title</Text>
          <TextInput style={styles.input} value={manualTitle} onChangeText={setManualTitle} placeholder="Title" placeholderTextColor="#71717a" />
        </View>
      )}

      <View style={styles.section}>
        <Text style={styles.label}>Format</Text>
        <TextInput style={styles.input} value={format} onChangeText={setFormat} placeholderTextColor="#71717a" />
      </View>
      <View style={styles.section}>
        <Text style={styles.label}>Disc Count</Text>
        <TextInput style={styles.input} value={discCount} onChangeText={setDiscCount} keyboardType="number-pad" />
      </View>
      <View style={styles.section}>
        <Text style={styles.label}>Disk Region</Text>
        <TextInput style={styles.input} value={diskRegion} onChangeText={setDiskRegion} placeholder="e.g. 4, A, Free" placeholderTextColor="#71717a" />
      </View>
      <View style={styles.section}>
        <Text style={styles.label}>Genre Location (shelf section)</Text>
        <TextInput style={styles.input} value={genreLocation} onChangeText={setGenreLocation} placeholder="e.g. Action, History Documentary" placeholderTextColor="#71717a" />
      </View>
      <View style={[styles.section, styles.row]}>
        <Text style={styles.label}>Special Features</Text>
        <Switch value={specialFeatures} onValueChange={setSpecialFeatures} />
      </View>

      {showTvFields && <Text style={styles.hint}>TV-specific fields (season/episode) can be refined later via Direct Database Access.</Text>}

      {error && <Text style={styles.error}>{error}</Text>}

      <TouchableOpacity
        style={styles.button}
        onPress={handleConfirmPressed}
        disabled={submitting || checkingExisting}
      >
        <Text style={styles.buttonText}>
          {checkingExisting ? "Checking your collection..." : submitting ? "Saving..." : "Confirm"}
        </Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={handleDiscard} disabled={submitting || checkingExisting}>
        <Text style={styles.link}>This was a stray scan - discard it</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#09090b" },
  scrollContent: { padding: 16, paddingTop: 48, gap: 12 },
  title: { color: "#f4f4f5", fontSize: 18, fontWeight: "700" },
  body: { color: "#e4e4e7" },
  hint: { color: "#a1a1aa", fontStyle: "italic" },
  link: { color: "#38bdf8" },
  section: { gap: 6 },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  label: { color: "#a1a1aa" },
  input: {
    borderWidth: 1,
    borderColor: "#3f3f46",
    borderRadius: 8,
    padding: 10,
    color: "#f4f4f5",
  },
  candidateRow: {
    padding: 10,
    borderWidth: 1,
    borderColor: "#3f3f46",
    borderRadius: 8,
    marginBottom: 6,
  },
  candidateRowSelected: { borderColor: "#0284c7", backgroundColor: "#0c2a3a" },
  candidateText: { color: "#f4f4f5" },
  error: { color: "#f87171" },
  button: {
    backgroundColor: "#0284c7",
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: "center",
    marginTop: 12,
  },
  buttonText: { color: "#fff", fontWeight: "600" },
});
