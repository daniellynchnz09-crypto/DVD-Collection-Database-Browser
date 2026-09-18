import { useEffect, useState } from "react";
import { Image, ScrollView, StyleSheet, Switch, Text, TextInput, TouchableOpacity, View } from "react-native";
import { previewTmdbFields, searchTitleOnOmdb, type OmdbSearchCandidate } from "../lib/scanApi";
import { loadFieldOptions, type FieldOptions } from "../lib/fieldOptions";
import SearchableModalInput from "./SearchableModalInput";

/** One title added to a Collection scan's running member list (ConfirmScreen.tsx's
 * Collection flow, added 2026-09-20 - see Claude/TECH STACK AND ARCHITECTURE/
 * barcode-scanning-pipeline.md).
 *
 * `format`/`discCount`/`specialFeatures*` are this title's OWN disc(s) - added 2026-09-20
 * after the user pointed out that Format/Disc Count/Special Features had been made hard-
 * shared across the whole collection, which breaks down the moment two titles in the same
 * box have different disc configurations (their own real example: every title in a set had
 * its own 4K UHD disc plus its own Blu-ray special-features disc). Per the user directly,
 * these fields exist at BOTH levels now - a collection can also have its own bonus disc
 * covering the set as a whole (kept as the header row's own Format/Special Features fields
 * in ConfirmScreen.tsx), separate from any individual title's own.
 *
 * There is deliberately no `existingMatchUniqueId` on this type any more - the duplicate
 * check used to run here, per title, at add time, but the user asked (2026-09-20) for it to
 * run once for the whole collection instead, after every title is added, right before
 * Confirm - see ConfirmScreen.tsx's own `duplicateQueue` for where that now lives. */
export interface CollectionMember {
  key: string;
  imdbId?: string;
  title: string;
  poster?: string;
  movieOrTv: string;
  seasonNo?: string;
  partOfSeasonNo?: string;
  episodeCount?: string;
  franchise?: string;
  watched: boolean;
  watchedDisc: boolean;
  format: string;
  discCount: string;
  specialFeatures: boolean;
  specialFeaturesDiscCount?: string;
  specialFeaturesDiscFormat?: string;
  /** This title's own packaging/edition name (e.g. "Definitive Edition"), independent of the
   * collection's own Release Name - added 2026-09-20 after the user pointed out a remastered
   * cut of one specific film can be bundled into an otherwise-ordinary box set. */
  releaseName?: string;
}

function generateMemberKey(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// Same digits-only guard ConfirmScreen.tsx's own digitsOnly enforces on every numeric field -
// kept as its own tiny local copy for the same reason guessMovieOrTvFromType is, below.
function digitsOnly(value: string): string {
  return value.replace(/[^0-9]/g, "");
}

// Same coarse OMDB-Type-based guess ConfirmScreen.tsx's own guessMovieOrTvFromType uses -
// kept as its own tiny local copy rather than exported/shared, since it's three lines and
// this component otherwise has no dependency on that file at all.
function guessMovieOrTvFromType(type: string | undefined): string {
  if (type === "series") return "TV Series";
  if (type === "episode") return "TV Episode";
  return "Movie";
}

const SEASON_FIELDS_MOVIE_OR_TV_VALUES = new Set(["TV Series", "TV Mini-Series", "TV Special", "TV Episode", "Serial"]);

/**
 * Small standalone "add one title to a collection" search UI - deliberately NOT a reuse of
 * ConfirmScreen's own inline single-title search block, which is entangled with ~15 of that
 * screen's own top-level state variables and logic that doesn't apply to a collection member
 * at all (the TMDb-id-override hard requirement, Rating/Studio reveal-once-TMDb-fails, the
 * season/title auto-composition effects). A collection member needs much less: search, pick
 * one candidate (or fall through to manual entry), set type/season fields if TV-ish, and its
 * own Watched/Watched Disc checkboxes (when not already implied - see `impliedWatched`/
 * `impliedWatchedDisc` below). No duplicate check happens here any more (2026-09-20) - that
 * now runs once for the whole collection at Confirm time instead, per the user's own request.
 */
export default function TitleSearchPicker({
  onAdd,
  onCancel,
  initialFormat,
  initialDiscCount,
  initialSpecialFeatures,
  initialSpecialFeaturesDiscCount,
  initialSpecialFeaturesDiscFormat,
  impliedWatched,
  impliedWatchedDisc,
}: {
  onAdd: (member: CollectionMember) => void;
  onCancel: () => void;
  /** Starting values for this title's own disc fields - ConfirmScreen.tsx passes the
   * previously-added member's own values (if any exist yet), else the header's own shared-
   * step values as a first guess. Still fully editable per title - this is just a starting
   * point to cut down on re-typing the same disc pattern for every title in a box set where
   * most/all titles share it, per the user's own real example. */
  initialFormat: string;
  initialDiscCount: string;
  initialSpecialFeatures: boolean;
  initialSpecialFeaturesDiscCount: string;
  initialSpecialFeaturesDiscFormat: string;
  /** ConfirmScreen's own current "Watched Collection"/"Watched Collection Disc" state - per
   * the user's own request (2026-09-20), once the whole collection is declared watched (or
   * watched-on-disc), every title added from then on should default to matching rather than
   * asking again for something already declared true - see the Watched/Watched Disc section
   * below, which hides itself entirely rather than just defaulting when these are true. */
  impliedWatched: boolean;
  impliedWatchedDisc: boolean;
}) {
  const [query, setQuery] = useState("");
  const [isCustomDisc, setIsCustomDisc] = useState(false);
  const [searching, setSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [candidates, setCandidates] = useState<OmdbSearchCandidate[]>([]);
  const [selectedImdbId, setSelectedImdbId] = useState<string | null>(null);
  const [manualTitle, setManualTitle] = useState("");
  const [movieOrTv, setMovieOrTv] = useState("Movie");
  const [seasonNo, setSeasonNo] = useState("");
  const [partOfSeasonNo, setPartOfSeasonNo] = useState("");
  const [episodeCount, setEpisodeCount] = useState("");
  const [franchise, setFranchise] = useState("");
  const [watched, setWatched] = useState(impliedWatched);
  const [watchedDisc, setWatchedDisc] = useState(impliedWatchedDisc);
  const [format, setFormat] = useState(initialFormat);
  const [discCount, setDiscCount] = useState(initialDiscCount);
  const [releaseName, setReleaseName] = useState("");
  const [specialFeatures, setSpecialFeatures] = useState(initialSpecialFeatures);
  const [specialFeaturesDiscCount, setSpecialFeaturesDiscCount] = useState(initialSpecialFeaturesDiscCount);
  const [specialFeaturesDiscFormat, setSpecialFeaturesDiscFormat] = useState(initialSpecialFeaturesDiscFormat);
  const [fieldOptions, setFieldOptions] = useState<FieldOptions | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadFieldOptions().then(setFieldOptions);
  }, []);

  const showMemberSpecialFeaturesDiscFields = specialFeatures && (parseInt(discCount, 10) || 1) > 1;

  const selectedCandidate = selectedImdbId ? candidates.find((c) => c.imdbID === selectedImdbId) ?? null : null;
  const resolvedTitle = selectedCandidate?.Title ?? manualTitle.trim();
  const showSeasonFields = SEASON_FIELDS_MOVIE_OR_TV_VALUES.has(movieOrTv);

  async function handleSearch() {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setError(null);
    try {
      const result = await searchTitleOnOmdb(q, isCustomDisc);
      setCandidates(result.candidates);
      setHasSearched(true);
      if (result.candidates.length === 1) {
        selectCandidate(result.candidates[0]);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSearching(false);
    }
  }

  function selectCandidate(c: OmdbSearchCandidate) {
    setSelectedImdbId(c.imdbID);
    setMovieOrTv(guessMovieOrTvFromType(c.Type));
    previewTmdbFields(c.imdbID)
      .then((preview) => {
        if (preview.franchise.length > 0) setFranchise((prev) => prev || preview.franchise.join(", "));
      })
      .catch(() => {
        // Read-only preview - a failure here just means no franchise suggestion, nothing to
        // recover or block on.
      });
  }

  function handleSkipToManual() {
    setManualTitle(query.trim());
    setHasSearched(true);
  }

  /** Adds this title to the collection's running member list directly - no duplicate check
   * here any more (2026-09-20, per the user's own request): that now runs once for the whole
   * collection, after every title is added, right before Confirm (see ConfirmScreen.tsx's own
   * `duplicateQueue`), rather than interrupting the add-a-title flow for each one. */
  function handleAddPressed() {
    if (!resolvedTitle) return;
    setError(null);
    onAdd({
      key: generateMemberKey(),
      imdbId: selectedImdbId ?? undefined,
      title: resolvedTitle,
      poster: selectedCandidate?.Poster !== "N/A" ? selectedCandidate?.Poster : undefined,
      movieOrTv,
      seasonNo: showSeasonFields ? seasonNo.trim() || undefined : undefined,
      partOfSeasonNo: showSeasonFields ? partOfSeasonNo.trim() || undefined : undefined,
      episodeCount: showSeasonFields ? episodeCount.trim() || undefined : undefined,
      franchise: franchise.trim() || undefined,
      watched,
      watchedDisc,
      format,
      discCount,
      specialFeatures,
      specialFeaturesDiscCount: showMemberSpecialFeaturesDiscFields ? specialFeaturesDiscCount.trim() || undefined : undefined,
      specialFeaturesDiscFormat: showMemberSpecialFeaturesDiscFields ? specialFeaturesDiscFormat || undefined : undefined,
      releaseName: releaseName.trim() || undefined,
    });
  }

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <Text style={styles.title}>Add a title to this set</Text>

        {!hasSearched && !selectedCandidate && (
          <View style={styles.section}>
            <TextInput
              style={styles.input}
              value={query}
              onChangeText={setQuery}
              placeholder="Title"
              placeholderTextColor="#71717a"
              autoFocus
            />
            <TouchableOpacity style={styles.checkboxRow} onPress={() => setIsCustomDisc((prev) => !prev)}>
              <View style={[styles.checkbox, isCustomDisc && styles.checkboxChecked]}>
                {isCustomDisc && <Text style={styles.checkboxMark}>✓</Text>}
              </View>
              <Text style={styles.checkboxLabel}>Custom/homemade disc - don&apos;t autocorrect spelling</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.button} onPress={handleSearch} disabled={searching || !query.trim()}>
              <Text style={styles.buttonText}>{searching ? "Searching..." : "Search"}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={handleSkipToManual} disabled={searching}>
              <Text style={styles.link}>Skip - enter manually instead</Text>
            </TouchableOpacity>
          </View>
        )}

        {hasSearched && !selectedCandidate && (
          <View style={styles.section}>
            {candidates.length > 0 ? (
              <>
                <Text style={styles.label}>Which one is this?</Text>
                {candidates.map((c) => (
                  <TouchableOpacity key={c.imdbID} style={styles.candidateRow} onPress={() => selectCandidate(c)}>
                    {c.Poster && c.Poster !== "N/A" ? (
                      <Image source={{ uri: c.Poster }} style={styles.posterThumb} resizeMode="cover" />
                    ) : null}
                    <Text style={styles.candidateText}>
                      {c.Title} ({c.Year})
                    </Text>
                  </TouchableOpacity>
                ))}
                <TouchableOpacity onPress={() => setHasSearched(false)}>
                  <Text style={styles.link}>Search again</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <Text style={styles.hint}>No match found for &quot;{query}&quot;.</Text>
                <View style={styles.section}>
                  <Text style={styles.label}>Title</Text>
                  <TextInput
                    style={styles.input}
                    value={manualTitle}
                    onChangeText={setManualTitle}
                    placeholder="Title"
                    placeholderTextColor="#71717a"
                  />
                </View>
              </>
            )}
          </View>
        )}

        {(selectedCandidate || (hasSearched && candidates.length === 0)) && (
          <>
            {selectedCandidate && (
              <View style={styles.section}>
                {selectedCandidate.Poster && selectedCandidate.Poster !== "N/A" && (
                  <Image source={{ uri: selectedCandidate.Poster }} style={styles.posterLarge} resizeMode="cover" />
                )}
                <Text style={styles.label}>{selectedCandidate.Title} ({selectedCandidate.Year})</Text>
                <TouchableOpacity onPress={() => setSelectedImdbId(null)}>
                  <Text style={styles.link}>Not this one - pick again</Text>
                </TouchableOpacity>
              </View>
            )}

            <View style={styles.section}>
              <Text style={styles.label}>Movie or TV</Text>
              <View style={styles.chipRow}>
                {["Movie", "TV Series", "TV Movie", "TV Mini-Series", "TV Special", "Documentary", "Serial"].map((opt) => (
                  <TouchableOpacity
                    key={opt}
                    style={[styles.chip, movieOrTv === opt && styles.chipSelected]}
                    onPress={() => setMovieOrTv(opt)}
                  >
                    <Text style={[styles.chipText, movieOrTv === opt && styles.chipTextSelected]}>{opt}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
            <View style={styles.section}>
              <Text style={styles.label}>Format (this title's own disc)</Text>
              <SearchableModalInput value={format} onChangeText={setFormat} options={fieldOptions?.format ?? []} />
            </View>
            <View style={styles.section}>
              <Text style={styles.label}>Disc Count</Text>
              <TextInput
                style={styles.input}
                value={discCount}
                onChangeText={(text) => setDiscCount(digitsOnly(text))}
                keyboardType="number-pad"
              />
            </View>
            <View style={[styles.section, styles.row]}>
              <Text style={styles.label}>Special Features (this title's own bonus disc)</Text>
              <Switch value={specialFeatures} onValueChange={setSpecialFeatures} />
            </View>
            {showMemberSpecialFeaturesDiscFields && (
              <>
                <View style={styles.section}>
                  <Text style={styles.label}>Number of Special Features Discs</Text>
                  <TextInput
                    style={styles.input}
                    value={specialFeaturesDiscCount}
                    onChangeText={(text) => setSpecialFeaturesDiscCount(digitsOnly(text))}
                    keyboardType="number-pad"
                    placeholder="e.g. 1"
                    placeholderTextColor="#71717a"
                  />
                </View>
                <View style={styles.section}>
                  <Text style={styles.label}>Format of Special Features Discs</Text>
                  <SearchableModalInput
                    value={specialFeaturesDiscFormat}
                    onChangeText={setSpecialFeaturesDiscFormat}
                    options={fieldOptions?.format ?? []}
                  />
                </View>
              </>
            )}
            {showSeasonFields && (
              <>
                <View style={styles.section}>
                  <Text style={styles.label}>Season No. (optional)</Text>
                  <TextInput style={styles.input} value={seasonNo} onChangeText={setSeasonNo} placeholderTextColor="#71717a" />
                </View>
                <View style={styles.section}>
                  <Text style={styles.label}>Part of a Season No. (optional)</Text>
                  <TextInput
                    style={styles.input}
                    value={partOfSeasonNo}
                    onChangeText={setPartOfSeasonNo}
                    keyboardType="number-pad"
                    placeholderTextColor="#71717a"
                  />
                </View>
                <View style={styles.section}>
                  <Text style={styles.label}>Episode Count on this disc (optional)</Text>
                  <TextInput
                    style={styles.input}
                    value={episodeCount}
                    onChangeText={setEpisodeCount}
                    keyboardType="number-pad"
                    placeholderTextColor="#71717a"
                  />
                </View>
              </>
            )}
            {!selectedCandidate && (
              <View style={styles.section}>
                <Text style={styles.label}>Title</Text>
                <TextInput style={styles.input} value={manualTitle} onChangeText={setManualTitle} placeholderTextColor="#71717a" />
              </View>
            )}
            <View style={styles.section}>
              <Text style={styles.label}>Franchise (optional, comma-separated)</Text>
              <TextInput style={styles.input} value={franchise} onChangeText={setFranchise} placeholderTextColor="#71717a" />
            </View>
            <View style={styles.section}>
              <Text style={styles.label}>Release Name (optional, if different from Title)</Text>
              <TextInput
                style={styles.input}
                value={releaseName}
                onChangeText={setReleaseName}
                placeholder="e.g. Definitive Edition"
                placeholderTextColor="#71717a"
              />
            </View>

            {/* Hidden entirely (not just defaulted) once the collection-wide equivalent is
                already checked, per the user's own request (2026-09-20) - asking again for
                something already declared true for the whole set is pure friction. Watched
                Collection Disc implies both fields for every title; Watched Collection alone
                only implies "Watched" (watching the film doesn't necessarily mean via this
                specific disc, so Watched Disc is still a real question in that case). */}
            {!impliedWatchedDisc && (
              <TouchableOpacity
                style={styles.checkboxRow}
                onPress={() =>
                  setWatchedDisc((prev) => {
                    const next = !prev;
                    if (next) setWatched(true);
                    return next;
                  })
                }
              >
                <View style={[styles.checkbox, watchedDisc && styles.checkboxChecked]}>
                  {watchedDisc && <Text style={styles.checkboxMark}>✓</Text>}
                </View>
                <Text style={styles.checkboxLabel}>Watched this disc</Text>
              </TouchableOpacity>
            )}
            {!impliedWatchedDisc && !impliedWatched && (
              <TouchableOpacity
                style={styles.checkboxRow}
                onPress={() =>
                  setWatched((prev) => {
                    const next = !prev;
                    if (!next) setWatchedDisc(false);
                    return next;
                  })
                }
              >
                <View style={[styles.checkbox, watched && styles.checkboxChecked]}>
                  {watched && <Text style={styles.checkboxMark}>✓</Text>}
                </View>
                <Text style={styles.checkboxLabel}>Watched</Text>
              </TouchableOpacity>
            )}

            <TouchableOpacity
              style={styles.button}
              onPress={handleAddPressed}
              disabled={!resolvedTitle || !format.trim() || !discCount.trim()}
            >
              <Text style={styles.buttonText}>Add to set</Text>
            </TouchableOpacity>
          </>
        )}

        {error && <Text style={styles.error}>{error}</Text>}
        <TouchableOpacity onPress={onCancel}>
          <Text style={styles.link}>Cancel</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#09090b", paddingTop: 48 },
  scrollContent: { padding: 16, gap: 12 },
  title: { color: "#f4f4f5", fontSize: 18, fontWeight: "700" },
  section: { gap: 8 },
  // gap + flexShrink on the sibling text styles below (added 2026-09-20) - see
  // ConfirmScreen.tsx's own `label` style comment for the full reasoning: without flexShrink,
  // a long label next to a fixed-size Switch/checkbox renders at its full natural width and
  // pushes the control off the right edge of the screen instead of wrapping.
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 },
  label: { color: "#e4e4e7", fontWeight: "600", flexShrink: 1 },
  hint: { color: "#a1a1aa", fontStyle: "italic" },
  link: { color: "#38bdf8" },
  error: { color: "#f87171" },
  input: {
    borderWidth: 1,
    borderColor: "#3f3f46",
    borderRadius: 8,
    padding: 10,
    color: "#f4f4f5",
  },
  button: {
    backgroundColor: "#0284c7",
    borderRadius: 8,
    padding: 12,
    alignItems: "center",
  },
  buttonGreen: { backgroundColor: "#16a34a" },
  buttonText: { color: "#f4f4f5", fontWeight: "600" },
  checkboxRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: "#71717a",
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxChecked: { backgroundColor: "#0284c7", borderColor: "#0284c7" },
  checkboxMark: { color: "#f4f4f5", fontSize: 14 },
  checkboxLabel: { color: "#e4e4e7", flexShrink: 1 },
  candidateRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8 },
  candidateText: { color: "#e4e4e7", flexShrink: 1 },
  posterThumb: { width: 40, height: 56, borderRadius: 4 },
  posterLarge: { width: 100, height: 140, borderRadius: 6 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    borderWidth: 1,
    borderColor: "#3f3f46",
    borderRadius: 16,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  chipSelected: { backgroundColor: "#0284c7", borderColor: "#0284c7" },
  chipText: { color: "#e4e4e7" },
  chipTextSelected: { color: "#f4f4f5", fontWeight: "600" },
});
