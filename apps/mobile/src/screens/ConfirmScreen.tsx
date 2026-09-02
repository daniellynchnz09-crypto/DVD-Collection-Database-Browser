import { useEffect, useState } from "react";
import {
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { cleanProductTitleForSearch, extractFormatHint, getDiskRegionOptions } from "@danflix/shared";
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
import { loadFieldOptions, type FieldOptions } from "../lib/fieldOptions";
import { clearConfirmDraft, getConfirmDraft, saveConfirmDraft } from "../lib/confirmDrafts";
import AutocompleteInput from "../components/AutocompleteInput";
import type { PendingScan } from "./PendingScansScreen";

interface OmdbCandidate {
  Title: string;
  Year: string;
  imdbID: string;
  Type: string;
  Poster: string;
}

interface PosterMatch {
  bestImdbId: string | null;
  distances: Record<string, number>;
  confident: boolean;
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
  onDiscarded,
}: {
  scan: PendingScan;
  onConfirmed: (result: { shelfLocation: ShelfLocation; linkedTitle?: string }) => void;
  onBack: () => void;
  /** Called with the barcode when this scan is discarded, so the scanner's re-scan
   * cooldown can forget it - the user explicitly said they want to rescan it. */
  onDiscarded?: (barcode: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const candidates = (scan.resolved_candidates?.omdbCandidates ?? []) as OmdbCandidate[];
  const isCollection = Boolean(scan.resolved_candidates?.isCollection);
  const upcProduct = scan.resolved_candidates?.upcProduct;
  const posterMatch = (scan.resolved_candidates as { posterMatch?: PosterMatch | null })
    ?.posterMatch;
  const autoMatched = posterMatch?.confident ? posterMatch : null;
  const autoMatchedCandidate = autoMatched
    ? candidates.find((c) => c.imdbID === autoMatched.bestImdbId) ?? null
    : null;
  const draft = getConfirmDraft(scan.id);

  // Starts collapsed to just the auto-matched candidate when the listing's own photo
  // confidently matched one poster - "Not this item" reveals the full list to pick from
  // manually instead. (Or, if a draft exists - the user was already partway through this
  // scan and left - restores exactly what they'd chosen instead of these defaults.)
  const [showAllCandidates, setShowAllCandidates] = useState(draft?.showAllCandidates ?? !autoMatchedCandidate);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(draft?.selected ?? (autoMatchedCandidate ? [autoMatchedCandidate.imdbID] : []))
  );
  // Best-effort starting guesses from the UPC listing text - always editable, never
  // presented as confirmed fact. Packaging/marketing words ("Special Edition") are already
  // stripped by cleanProductTitleForSearch since those never belong in a title per how this
  // collection is catalogued (see Claude/TECH STACK AND ARCHITECTURE.md's Collections note).
  const [manualTitle, setManualTitle] = useState(
    () => draft?.manualTitle ?? (upcProduct?.title ? cleanProductTitleForSearch(upcProduct.title) : "")
  );
  const [format, setFormat] = useState(() => {
    if (draft?.format) return draft.format;
    const hint = upcProduct
      ? extractFormatHint(`${upcProduct.title} ${upcProduct.description ?? ""}`)
      : null;
    return hint ?? "DVD";
  });
  const [discCount, setDiscCount] = useState(draft?.discCount ?? "1");
  const [diskRegion, setDiskRegion] = useState(draft?.diskRegion ?? "");
  const [genreLocation, setGenreLocation] = useState(draft?.genreLocation ?? "");
  // Verbatim edition/packaging title (e.g. "Gladiator Special Edition"), distinct from the
  // canonical `title` above - saved as null/"n/a" whenever releaseNameMatchesTitle is
  // checked, regardless of whatever's left in the text field (see Claude/TECH STACK AND
  // ARCHITECTURE.md). Never auto-filled: unlike title/format, there's no reliable signal
  // in the UPC listing for which words are "part of the release name" vs. ordinary
  // packaging noise, so this is manual-only. Defaults checked since most discs' release
  // name is just their title.
  const [releaseName, setReleaseName] = useState(draft?.releaseName ?? "");
  const [releaseNameMatchesTitle, setReleaseNameMatchesTitle] = useState(
    draft?.releaseNameMatchesTitle ?? true
  );
  const [steelbook, setSteelbook] = useState(draft?.steelbook ?? false);
  const [specialFeatures, setSpecialFeatures] = useState(draft?.specialFeatures ?? false);
  const [specialFeaturesDiscCount, setSpecialFeaturesDiscCount] = useState(draft?.specialFeaturesDiscCount ?? "");
  const [specialFeaturesDiscFormat, setSpecialFeaturesDiscFormat] = useState(draft?.specialFeaturesDiscFormat ?? "");
  const [fieldOptions, setFieldOptions] = useState<FieldOptions | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [checkingExisting, setCheckingExisting] = useState(false);
  const [existingCheck, setExistingCheck] = useState<MatchCheck | null>(null);
  const [chosenExistingId, setChosenExistingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedTypes = candidates.filter((c) => selected.has(c.imdbID)).map((c) => c.Type);
  const showTvFields = selectedTypes.some((t) => t === "series" || t === "episode");

  useEffect(() => {
    loadFieldOptions().then(setFieldOptions);
  }, []);

  // 4K UHD Blu-ray carries no region coding at all - default the field to "All" as soon
  // as the format looks like 4K, but only while the user hasn't already typed something
  // of their own in here (never stomp a deliberate manual entry).
  useEffect(() => {
    if (diskRegion.trim() !== "") return;
    if (getDiskRegionOptions(format)?.length === 1) setDiskRegion(getDiskRegionOptions(format)![0]);
  }, [format]);

  // Keeps the draft cache current on every change, so leaving this scan half-finished
  // (back to Pending Scans, or even backgrounding the whole app) and coming back to it
  // later restores exactly this state instead of the freshly-computed defaults above.
  useEffect(() => {
    saveConfirmDraft(scan.id, {
      showAllCandidates,
      selected: [...selected],
      manualTitle,
      releaseName,
      releaseNameMatchesTitle,
      format,
      discCount,
      diskRegion,
      genreLocation,
      steelbook,
      specialFeatures,
      specialFeaturesDiscCount,
      specialFeaturesDiscFormat,
    });
  }, [
    scan.id,
    showAllCandidates,
    selected,
    manualTitle,
    releaseName,
    releaseNameMatchesTitle,
    format,
    discCount,
    diskRegion,
    genreLocation,
    steelbook,
    specialFeatures,
    specialFeaturesDiscCount,
    specialFeaturesDiscFormat,
  ]);

  const diskRegionOptions = getDiskRegionOptions(format) ?? fieldOptions?.diskRegion ?? [];
  const showSpecialFeaturesDiscFields = specialFeatures && (parseInt(discCount, 10) || 1) > 1;

  function handleNotThisItem() {
    setShowAllCandidates(true);
    setSelected(new Set());
  }

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
      clearConfirmDraft(scan.id);
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
      const chosen = candidates.filter((c) => selected.has(c.imdbID));

      const manualFields = {
        format,
        disc_count: parseInt(discCount, 10) || 1,
        disk_region: diskRegion || null,
        genre_location: genreLocation || null,
        steelbook,
        release_name: releaseNameMatchesTitle ? null : releaseName.trim() || null,
        special_features: specialFeatures,
        special_features_disc_count: showSpecialFeaturesDiscFields
          ? parseInt(specialFeaturesDiscCount, 10) || null
          : null,
        special_features_disc_format: showSpecialFeaturesDiscFields
          ? specialFeaturesDiscFormat || null
          : null,
        case_image_url: scan.resolved_candidates?.upcProduct?.imageUrl ?? null,
        ...(selected.size === 0 ? { title: manualTitle || scan.barcode } : {}),
      };
      const entries: ConfirmEntry[] =
        chosen.length > 0
          ? chosen.map((c, i) => ({
              imdbId: c.imdbID,
              barcodeId: i === 0 ? scan.barcode : undefined,
              manualFields,
            }))
          : [{ barcodeId: scan.barcode, manualFields }];

      const result = await confirmScan(scan.id, entries);
      clearConfirmDraft(scan.id);
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
      clearConfirmDraft(scan.id);
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
      clearConfirmDraft(scan.id);
      onDiscarded?.(scan.barcode);
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
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      // Clears the tab/nav bar area so the keyboard doesn't have to push past it too -
      // matters most for fields near the bottom of this long form.
      keyboardVerticalOffset={insets.top}
    >
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingTop: 48 + insets.top, paddingBottom: 24 + insets.bottom },
        ]}
        keyboardShouldPersistTaps="handled"
      >
      <TouchableOpacity onPress={onBack}>
        <Text style={styles.link}>{"< Pending Scans"}</Text>
      </TouchableOpacity>
      <Text style={styles.title}>Barcode {scan.barcode}</Text>

      {isCollection && <Text style={styles.hint}>Looks like a collection - check every title actually in this set.</Text>}

      {upcProduct?.imageUrl && (
        <View style={styles.section}>
          <Text style={styles.label}>Your scanned item</Text>
          <Image source={{ uri: upcProduct.imageUrl }} style={styles.scannedImage} resizeMode="contain" />
          <Text style={styles.hint}>
            Compare this against the candidates below - it's a photo of the actual listing, not a
            generic poster, so it's the best way to confirm the specific release.
          </Text>
        </View>
      )}

      {autoMatchedCandidate && !showAllCandidates ? (
        <View style={styles.section}>
          <Text style={styles.label}>Matched by cover photo</Text>
          <View style={[styles.posterCard, styles.posterCardSelected, styles.autoMatchCard]}>
            {autoMatchedCandidate.Poster && autoMatchedCandidate.Poster !== "N/A" ? (
              <Image
                source={{ uri: autoMatchedCandidate.Poster }}
                style={styles.posterImage}
                resizeMode="cover"
              />
            ) : (
              <View style={[styles.posterImage, styles.posterPlaceholder]}>
                <Text style={styles.posterPlaceholderText}>No image</Text>
              </View>
            )}
            <Text style={styles.posterTitle} numberOfLines={2}>
              {autoMatchedCandidate.Title}
            </Text>
            <Text style={styles.posterYear}>{autoMatchedCandidate.Year}</Text>
          </View>
          <Text style={styles.hint}>
            The scanned item's own photo was compared against every candidate's poster - this one
            matched clearly. Still worth a glance before confirming.
          </Text>
          <TouchableOpacity onPress={handleNotThisItem}>
            <Text style={styles.link}>Not this item - show what it was compared against</Text>
          </TouchableOpacity>
        </View>
      ) : candidates.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.label}>{isCollection ? "Titles in this set" : "Best match"}</Text>
          <Text style={styles.hint}>
            Compare the cover art before picking - different releases of the same film (special
            editions, re-releases) often look different but OMDB's text alone won&apos;t tell them apart.
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.candidateScroll}>
            {candidates.map((c) => (
              <TouchableOpacity
                key={c.imdbID}
                style={[styles.posterCard, selected.has(c.imdbID) && styles.posterCardSelected]}
                onPress={() => toggleCandidate(c.imdbID)}
              >
                {c.Poster && c.Poster !== "N/A" ? (
                  <Image source={{ uri: c.Poster }} style={styles.posterImage} resizeMode="cover" />
                ) : (
                  <View style={[styles.posterImage, styles.posterPlaceholder]}>
                    <Text style={styles.posterPlaceholderText}>No image</Text>
                  </View>
                )}
                <Text style={styles.posterTitle} numberOfLines={2}>
                  {selected.has(c.imdbID) ? "[x] " : "[ ] "}
                  {c.Title}
                </Text>
                <Text style={styles.posterYear}>{c.Year}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
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
        <View style={styles.row}>
          <Text style={styles.label}>Release Name (if different from Title)</Text>
          <TouchableOpacity
            style={styles.checkboxRow}
            onPress={() => setReleaseNameMatchesTitle((prev) => !prev)}
          >
            <View style={[styles.checkbox, releaseNameMatchesTitle && styles.checkboxChecked]}>
              {releaseNameMatchesTitle && <Text style={styles.checkboxMark}>✓</Text>}
            </View>
            <Text style={styles.checkboxLabel}>Same as Title</Text>
          </TouchableOpacity>
        </View>
        <TextInput
          style={styles.input}
          value={releaseName}
          onChangeText={setReleaseName}
          editable={!releaseNameMatchesTitle}
          placeholder="e.g. Gladiator Special Edition"
          placeholderTextColor="#71717a"
        />
      </View>

      <View style={styles.section}>
        <Text style={styles.label}>Format</Text>
        <AutocompleteInput value={format} onChangeText={setFormat} options={fieldOptions?.format ?? []} />
      </View>
      <View style={styles.section}>
        <Text style={styles.label}>Disc Count</Text>
        <TextInput style={styles.input} value={discCount} onChangeText={setDiscCount} keyboardType="number-pad" />
      </View>
      <View style={styles.section}>
        <Text style={styles.label}>Disk Region</Text>
        <AutocompleteInput
          value={diskRegion}
          onChangeText={setDiskRegion}
          options={diskRegionOptions}
          placeholder="e.g. 4, A, All"
        />
      </View>
      <View style={styles.section}>
        <Text style={styles.label}>Genre Location (shelf section)</Text>
        <AutocompleteInput
          value={genreLocation}
          onChangeText={setGenreLocation}
          options={fieldOptions?.genreLocation ?? []}
          placeholder="e.g. Action, History Documentary"
        />
      </View>
      <View style={[styles.section, styles.row]}>
        <Text style={styles.label}>Steelbook</Text>
        <Switch value={steelbook} onValueChange={setSteelbook} />
      </View>
      <View style={[styles.section, styles.row]}>
        <Text style={styles.label}>Special Features</Text>
        <Switch value={specialFeatures} onValueChange={setSpecialFeatures} />
      </View>
      {showSpecialFeaturesDiscFields && (
        <>
          <View style={styles.section}>
            <Text style={styles.label}>Number of Special Features Discs</Text>
            <TextInput
              style={styles.input}
              value={specialFeaturesDiscCount}
              onChangeText={setSpecialFeaturesDiscCount}
              keyboardType="number-pad"
              placeholder="e.g. 1"
              placeholderTextColor="#71717a"
            />
          </View>
          <View style={styles.section}>
            <Text style={styles.label}>Format of Special Features Discs</Text>
            <AutocompleteInput
              value={specialFeaturesDiscFormat}
              onChangeText={setSpecialFeaturesDiscFormat}
              options={fieldOptions?.format ?? []}
            />
          </View>
        </>
      )}

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
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#09090b" },
  scrollView: { flex: 1 },
  scrollContent: { padding: 16, paddingTop: 48, gap: 12 },
  title: { color: "#f4f4f5", fontSize: 18, fontWeight: "700" },
  body: { color: "#e4e4e7" },
  hint: { color: "#a1a1aa", fontStyle: "italic" },
  link: { color: "#38bdf8" },
  scannedImage: {
    width: "100%",
    height: 220,
    borderRadius: 8,
    backgroundColor: "#18181b",
  },
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
  checkboxRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: "#52525b",
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxChecked: { backgroundColor: "#38bdf8", borderColor: "#38bdf8" },
  checkboxMark: { color: "#09090b", fontSize: 11, fontWeight: "700" },
  checkboxLabel: { color: "#a1a1aa", fontSize: 13 },
  candidateRow: {
    padding: 10,
    borderWidth: 1,
    borderColor: "#3f3f46",
    borderRadius: 8,
    marginBottom: 6,
  },
  candidateRowSelected: { borderColor: "#0284c7", backgroundColor: "#0c2a3a" },
  candidateText: { color: "#f4f4f5" },
  candidateScroll: { marginTop: 4 },
  posterCard: {
    width: 120,
    marginRight: 10,
    padding: 6,
    borderWidth: 1,
    borderColor: "#3f3f46",
    borderRadius: 8,
  },
  posterCardSelected: { borderColor: "#0284c7", backgroundColor: "#0c2a3a" },
  autoMatchCard: { width: 160, marginRight: 0 },
  posterImage: {
    width: "100%",
    height: 168,
    borderRadius: 6,
    backgroundColor: "#18181b",
  },
  posterPlaceholder: { alignItems: "center", justifyContent: "center" },
  posterPlaceholderText: { color: "#71717a", fontSize: 12, textAlign: "center" },
  posterTitle: { color: "#f4f4f5", fontSize: 13, marginTop: 6 },
  posterYear: { color: "#a1a1aa", fontSize: 12 },
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
