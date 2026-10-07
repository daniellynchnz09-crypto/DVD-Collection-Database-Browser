import { useEffect, useRef, useState } from "react";
import {
  findNodeHandle,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { previewTmdbFields, searchTitleOnOmdb, type OmdbSearchCandidate } from "../lib/scanApi";
import { loadFieldOptions, type FieldOptions } from "../lib/fieldOptions";
import { createScrollIntoViewHandler } from "../lib/scrollIntoView";
import SearchableModalInput from "./SearchableModalInput";
import FranchiseEditor from "./FranchiseEditor";
import SingleSelectChips from "./SingleSelectChips";
import BigChoice from "./BigChoice";
import SummaryRow from "./SummaryRow";
import SlideFlow, { type Slide } from "./SlideFlow";
import { FONTS, GLOSS, WELL } from "../theme";

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
  /** Which physical disc(s) within the set this title is on (e.g. "1", "2", or "1,2" for a
   * title spanning more than one disc) - added 2026-09-20 after the user hit a real box set
   * that doesn't follow the "one disc per title" assumption the header's disc-count total was
   * built on (2 discs holding 4 titles, two titles sharing each disc). Distinct from
   * `discCount` (unchanged meaning: how many discs relate to this title) - this is what lets
   * the header total be computed as the count of DISTINCT disc numbers referenced across every
   * member, rather than a naive sum that double-counts a disc two titles share). Persisted to
   * the title's own row (0030_add_disc_number_in_set.sql) - also useful later for the web app
   * to show which disc in a set holds a given title (WEB APP DESIGN.md's DVD Collection Pages). */
  discNumbers: string;
  specialFeatures: boolean;
  /** How many discs hold this title's special features - derived automatically from however
   * many boxes are ticked in `specialFeaturesDiscNumbers` below, not typed by hand any more
   * (changed 2026-09-23). Kept as its own field (rather than just computing it at submit time)
   * because it maps straight onto the existing `special_features_disc_count` column. */
  specialFeaturesDiscCount?: string;
  specialFeaturesDiscFormat?: string;
  /** Which of the set's own numbered discs (1..Total Disc Count) actually hold this title's
   * special features - added 2026-09-23, per the user's own correction: a title's bonus
   * features don't always live on a separate, uncounted disc. They can be on the same disc(s)
   * already ticked in `discNumbers` above (the movie's own disc), or on a disc shared with
   * other titles' bonus features - so this reuses the exact same numbered-checklist UI as
   * `discNumbers`, just against a different question ("which disc(s) have the special
   * features?" instead of "which disc(s) is the movie on?"). Same free-text/comma-list shape
   * as `discNumbers`, and deliberately a separate field from it for the same reason: the two
   * can genuinely differ. Persisted to `special_features_disc_number_in_set`
   * (0031_add_special_features_disc_number_in_set.sql). */
  specialFeaturesDiscNumbers?: string;
  /** This title's own packaging/edition name (e.g. "Definitive Edition"), independent of the
   * collection's own Release Name - added 2026-09-20 after the user pointed out a remastered
   * cut of one specific film can be bundled into an otherwise-ordinary box set. */
  releaseName?: string;
  /** Derived once from the same TMDb preview already fetched for `franchise` above (added
   * 2026-09-27) - never shown as its own editable field, purely so ConfirmScreen.tsx's
   * Collection header can tell whether EVERY member is genred Family/Kids and EVERY member
   * came back animated, per the user's own rule: "It would map to collections if all the
   * titles in the collection were kids or family titles" (extending the same amber Disc
   * Condition warning / G-or-PG rating suggestion the single-title flow already gets to a
   * whole box set, but only when every title in it agrees - not just one). Undefined for a
   * fully-manual member (no TMDb match at all, e.g. a custom-burned disc) - the header's own
   * unanimity check treats "unknown" the same as "no", never assuming family/kids by default. */
  isFamilyOrKidsGenre?: boolean;
  isAnimatedStyle?: boolean;
  /** Manual-only fallback (added 2026-09-27, per the user's own report that some already-
   * catalogued collection titles ended up with no rating at all): mirrors the single-title
   * flow's own Rating field, shown only once a real TMDb match has been checked and come up
   * empty (or there's no candidate to check in the first place - a fully-manual entry). Sent
   * as this title's own `manual.rating` at submit time - the confirm route's own
   * `manualRating ?? tmdbFields.rating ?? omdbRating` precedence (identical for every entry,
   * header or member) already supported this per-member; nothing was ever wired up
   * client-side to actually populate it for a collection member until now. */
  rating?: string;
  /** Whether TMDb genuinely had a rating for this member the last time it was checked - null/
   * undefined means "no, or never checked" (a fully-manual entry). Lets ConfirmScreen.tsx's
   * own required-field check tell "TMDb covered this one" apart from "still needs a manual
   * value" without re-running the lookup itself. */
  tmdbRating?: string | null;
}

function generateMemberKey(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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
const MOVIE_OR_TV_OPTIONS = ["Movie", "TV Series", "TV Movie", "TV Mini-Series", "TV Special", "Documentary", "Serial"];

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
 *
 * SLIDES (2026-09-22, per the user's own request to bring the same "slideshow style" from
 * ConfirmScreen's single-title/Collection-header flows to this per-member editor too, for a
 * consistent look throughout the whole Collection flow): "Which title?" -> "Movie or TV" ->
 * "Format & discs" -> "Special features" -> "Franchise, release & watched" -> "Review & save",
 * using the same SlideFlow/BigChoice/SummaryRow components those other flows use, with the own
 * local activeSlide/openRow/slideReturn state this component needs (mirroring ConfirmScreen's
 * exact shape, just scoped to this one small modal instead of the whole screen). Originally one
 * combined "Type, format & discs" slide - split into three (2026-09-23) after the user found it
 * too cluttered; Special Features got pulled out at the same time since it had been bundled in
 * too, and its own bonus-disc question changed shape in the same pass - see
 * CollectionMember.specialFeaturesDiscNumbers above. A saved edit
 * (`editingMember` set) opens straight on "summary" - the candidate/fields are already known,
 * so landing on the review slide and drilling into whichever one field is wrong is faster
 * than re-walking the whole flow from the search step. A brand-new add still starts on
 * "title", since there's nothing to review yet.
 */
export default function TitleSearchPicker({
  onAdd,
  onCancel,
  initialFormat,
  totalDiscCount,
  editingMember,
  initialSpecialFeatures,
  initialSpecialFeaturesDiscNumbers,
  discFormatLookup,
  impliedWatched,
  impliedWatchedDisc,
  initialQuery,
}: {
  /** Fires for both a brand-new title and a saved edit - a saved edit hands back the SAME `key`
   * it was opened with, which ConfirmScreen uses to replace that member in place. */
  onAdd: (member: CollectionMember) => void;
  onCancel: () => void;
  /** The collection header's own typed Total Disc Count (every physical disc in the box, bonus
   * disc included) - generates the "What disc(s) is this title on?" checkbox list, 1..N.
   * Redesigned 2026-09-20: this replaces both the old per-title Disc Count input and the old
   * free-typed Disc Number(s) field, since a title's own disc count is now simply how many
   * discs it ticks. */
  totalDiscCount: number;
  /** When set, the picker opens on the details step already filled in with this member's saved
   * values (tap-to-edit from ConfirmScreen's "Titles in this set" list, 2026-09-20). */
  editingMember?: CollectionMember | null;
  /** Starting values for this title's own disc fields - ConfirmScreen.tsx passes the
   * previously-added member's own values (if any exist yet), else the header's own shared-
   * step values as a first guess. Still fully editable per title - this is just a starting
   * point to cut down on re-typing the same disc pattern for every title in a box set where
   * most/all titles share it, per the user's own real example. */
  initialFormat: string;
  initialSpecialFeatures: boolean;
  initialSpecialFeaturesDiscNumbers: string;
  /** Disc number -> known format, derived live by ConfirmScreen (`discFormatLookup`, 2026-09-23)
   * from the header's own bonus disc and every other title already added - per the user's own
   * correction, a shared bonus disc's format is already recorded wherever it was first typed in
   * (or wherever that disc's actual movie lives, if the bonus features are bundled onto a movie
   * disc), so asking again for every title that also points at the same disc number is pure
   * redundant re-entry. Used to auto-fill "Format of Special Features Disc(s)" below instead of
   * leaving it to a weaker "copy the previous title's value" guess. */
  discFormatLookup: Record<number, string>;
  /** ConfirmScreen's own current "Watched Collection"/"Watched Collection Disc" state - per
   * the user's own request (2026-09-20), once the whole collection is declared watched (or
   * watched-on-disc), every title added from then on should default to matching rather than
   * asking again for something already declared true - see the Watched/Watched Disc section
   * below, which hides itself entirely rather than just defaulting when these are true. */
  impliedWatched: boolean;
  impliedWatchedDisc: boolean;
  /** Pre-fills and auto-runs the search the moment this picker opens fresh (never applies
   * alongside `editingMember`, which already seeds its own known values) - added 2026-09-30 for
   * ConfirmScreen's cover-derived member-title suggestion chips, so tapping a chip lands
   * straight on real candidates to review/pick rather than making the user retype the name the
   * cover photo already gave. Still just a starting point like every other suggestion on this
   * screen - the query box stays fully editable if the read was slightly off. */
  initialQuery?: string;
}) {
  const [query, setQuery] = useState(editingMember?.title ?? initialQuery ?? "");
  const [isCustomDisc, setIsCustomDisc] = useState(false);
  const [searching, setSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(!!editingMember);
  // Edit mode seeds the candidate list with one synthesized entry built from what was saved
  // (title/poster/imdbId), so the same "matched film" details block renders exactly as if the
  // user had just picked it from a real search - no OMDB call needed to re-open an edit.
  const [candidates, setCandidates] = useState<OmdbSearchCandidate[]>(
    editingMember?.imdbId
      ? [{ Title: editingMember.title, Year: "", imdbID: editingMember.imdbId, Type: "", Poster: editingMember.poster ?? "N/A" }]
      : []
  );
  const [selectedImdbId, setSelectedImdbId] = useState<string | null>(editingMember?.imdbId ?? null);
  const [manualTitle, setManualTitle] = useState(editingMember && !editingMember.imdbId ? editingMember.title : "");
  const [movieOrTv, setMovieOrTv] = useState(editingMember?.movieOrTv ?? "Movie");
  const [seasonNo, setSeasonNo] = useState(editingMember?.seasonNo ?? "");
  const [partOfSeasonNo, setPartOfSeasonNo] = useState(editingMember?.partOfSeasonNo ?? "");
  const [episodeCount, setEpisodeCount] = useState(editingMember?.episodeCount ?? "");
  const [franchise, setFranchise] = useState(editingMember?.franchise ?? "");
  // See CollectionMember's own comment on these two - captured from the same TMDb preview
  // fetched below for `franchise`, never surfaced as an editable field of their own.
  const [isFamilyOrKidsGenre, setIsFamilyOrKidsGenre] = useState(editingMember?.isFamilyOrKidsGenre);
  const [isAnimatedStyle, setIsAnimatedStyle] = useState(editingMember?.isAnimatedStyle);
  // Manual Rating fallback (see CollectionMember.rating's own comment) - `tmdbRating`/
  // `tmdbPreviewLoading` mirror ConfirmScreen.tsx's own `tmdbPreview`/`tmdbPreviewLoading`
  // shape closely enough to reuse the same showRatingField logic, just scoped to this one
  // member instead of the whole screen.
  const [rating, setRating] = useState(editingMember?.rating ?? "");
  const [tmdbRating, setTmdbRating] = useState<string | null>(editingMember?.tmdbRating ?? null);
  const [tmdbPreviewLoading, setTmdbPreviewLoading] = useState(false);
  const [watched, setWatched] = useState(editingMember ? editingMember.watched : impliedWatched);
  const [watchedDisc, setWatchedDisc] = useState(editingMember ? editingMember.watchedDisc : impliedWatchedDisc);
  const [format, setFormat] = useState(editingMember?.format ?? initialFormat);
  const [selectedDiscs, setSelectedDiscs] = useState<number[]>(
    (editingMember?.discNumbers ?? "")
      .split(",")
      .map((n) => parseInt(n.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0)
  );
  const [releaseName, setReleaseName] = useState(editingMember?.releaseName ?? "");
  const [specialFeatures, setSpecialFeatures] = useState(editingMember ? editingMember.specialFeatures : initialSpecialFeatures);
  // Which of the set's own numbered discs hold the special features - replaces a typed count
  // (2026-09-23, see CollectionMember.specialFeaturesDiscNumbers above). Same
  // parse-a-comma-list-into-numbers pattern as selectedDiscs above, seeded the same way every
  // other per-title field here is: the saved value on an edit, else the previous member's own
  // value as a starting guess for a new add.
  const [selectedSpecialFeaturesDiscs, setSelectedSpecialFeaturesDiscs] = useState<number[]>(
    (editingMember ? editingMember.specialFeaturesDiscNumbers ?? "" : initialSpecialFeaturesDiscNumbers)
      .split(",")
      .map((n) => parseInt(n.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0)
  );
  // No "initial" seed prop any more (2026-09-23) - a brand-new add starts blank and gets
  // auto-filled by the discFormatLookup effect below the moment a disc number with a known
  // format is ticked, which is more accurate than guessing from the previous title's value
  // regardless of which disc it was actually about.
  const [specialFeaturesDiscFormat, setSpecialFeaturesDiscFormat] = useState(editingMember?.specialFeaturesDiscFormat ?? "");
  const [fieldOptions, setFieldOptions] = useState<FieldOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeSlide, setActiveSlide] = useState(editingMember ? "summary" : "title");
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [slideReturn, setSlideReturn] = useState<string | null>(null);

  // Scroll-to-focused-field (added 2026-09-27, fixing a real reported bug: a plain TextInput
  // lower in a slide - Part of a Season No., Episode Count, Release Name, ... - was getting
  // covered outright by the on-screen keyboard, with nothing here to bring it back into view).
  // Same mechanism as ConfirmScreen.tsx's own (built directly on RN's UIManager.measureInWindow
  // rather than a third-party keyboard-aware scroll view, which proved inconsistent there in
  // real testing - see that screen's own comment) - this component just never had it at all,
  // unlike ConfirmScreen where every field was wired for it from the start.
  const scrollRef = useRef<ScrollView>(null);
  const scrollYRef = useRef(0);
  const keyboardHeightRef = useRef(0);
  useEffect(() => {
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const showSub = Keyboard.addListener(showEvent, (e) => {
      keyboardHeightRef.current = e.endCoordinates.height;
    });
    const hideSub = Keyboard.addListener(hideEvent, () => {
      keyboardHeightRef.current = 0;
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);
  const scrollFieldIntoView = useRef(
    createScrollIntoViewHandler(scrollRef, () => keyboardHeightRef.current, () => scrollYRef.current)
  ).current;
  function scrollInputRefIntoView(ref: React.RefObject<TextInput | null>) {
    scrollFieldIntoView(findNodeHandle(ref.current));
  }
  function handleScroll(event: NativeSyntheticEvent<NativeScrollEvent>) {
    scrollYRef.current = event.nativeEvent.contentOffset.y;
  }
  const queryInputRef = useRef<TextInput>(null);
  const manualTitleInputRef = useRef<TextInput>(null);
  const seasonNoInputRef = useRef<TextInput>(null);
  const partOfSeasonNoInputRef = useRef<TextInput>(null);
  const episodeCountInputRef = useRef<TextInput>(null);
  const releaseNameInputRef = useRef<TextInput>(null);

  // Defaults the special-features disc to the LAST (highest-numbered) disc this title's own
  // movie occupies - added 2026-09-24, per the user's own direct instruction after backfilling
  // three real collections that all followed this exact pattern (a 4K+Blu-ray combo where the
  // second, Blu-ray disc is the bonus-features one): "the last disk listed is the disk that has
  // special features, and that is often the case... so that should be set as default." Only
  // fires while nothing has been ticked yet (a fresh toggle-on, or a brand-new add with a movie
  // disc already picked) - a genuinely exceptional title just gets its default box unticked and
  // the real one(s) ticked instead, same "seed a starting guess, stay fully editable" pattern
  // every other default in this file already follows.
  useEffect(() => {
    if (specialFeatures && selectedSpecialFeaturesDiscs.length === 0 && selectedDiscs.length > 0) {
      setSelectedSpecialFeaturesDiscs([Math.max(...selectedDiscs)]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specialFeatures, selectedDiscs]);

  // Auto-fills the bonus-disc format the moment a ticked disc number's format is already known
  // (2026-09-23, per the user's own correction - see discFormatLookup's own comment above).
  // Checks this title's own live in-progress movie-disc format first (selectedDiscs/format -
  // covers the case where the bonus features are bundled onto the movie's own disc, which
  // wouldn't be in discFormatLookup yet if this is a brand-new add not saved to
  // collectionMembers), then falls back to the passed-in lookup. Never overwrites a value the
  // user has actually typed - only fills in while the field is still blank.
  useEffect(() => {
    if (specialFeaturesDiscFormat.trim()) return;
    for (const n of selectedSpecialFeaturesDiscs) {
      if (selectedDiscs.includes(n) && format) {
        setSpecialFeaturesDiscFormat(format);
        return;
      }
      if (discFormatLookup[n]) {
        setSpecialFeaturesDiscFormat(discFormatLookup[n]);
        return;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSpecialFeaturesDiscs]);

  useEffect(() => {
    loadFieldOptions().then(setFieldOptions);
  }, []);

  // Simply "is special features on" now (2026-09-23) - previously gated on the movie's own
  // disc count being >1, which made no sense once the bonus-features disc question moved to
  // its own numbered checklist independent of how many discs the movie itself is on.
  const showMemberSpecialFeaturesDiscFields = specialFeatures;
  // Same shape as ConfirmScreen.tsx's own showRatingField - hidden while a real TMDb lookup
  // for this member is still in flight (so it doesn't flash on then off once the lookup
  // resolves), shown once that lookup has genuinely come up empty, or immediately for a
  // fully-manual member (selectedImdbId null) with no TMDb match to check at all.
  const showMemberRatingField = selectedImdbId ? !tmdbPreviewLoading && !tmdbRating : true;
  // Same G/PG-then-franchise-ranked combination ConfirmScreen.tsx's own franchiseCommonRatings/
  // collectionCommonRatings use, just scoped to this one member's own franchise/family/animated
  // values instead of the whole screen's or the whole collection's.
  const memberCommonRatings = (() => {
    const suggestions = isFamilyOrKidsGenre && isAnimatedStyle ? ["G", "PG"] : [];
    const tags = franchise.split(",").map((f) => f.trim()).filter(Boolean);
    const counts: Record<string, number> = {};
    for (const tag of tags) {
      const byRating = fieldOptions?.ratingsByFranchise?.[tag];
      if (!byRating) continue;
      for (const [ratingValue, count] of Object.entries(byRating)) {
        counts[ratingValue] = (counts[ratingValue] ?? 0) + count;
      }
    }
    const ranked = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([ratingValue]) => ratingValue);
    return [...new Set([...suggestions, ...ranked])];
  })();

  const selectedCandidate = selectedImdbId ? candidates.find((c) => c.imdbID === selectedImdbId) ?? null : null;
  const resolvedTitle = selectedCandidate?.Title ?? manualTitle.trim();
  const showSeasonFields = SEASON_FIELDS_MOVIE_OR_TV_VALUES.has(movieOrTv);
  const commonFormats = (fieldOptions?.format ?? []).filter((f) => /^(dvd|blu-?ray|4k uhd blu-?ray)$/i.test(f.trim()));

  async function handleSearch() {
    const q = query.trim();
    if (!q) return;
    // Closes the on-screen keyboard AND searches in the one press (item 7, 2026-09-20) - the
    // ScrollView below uses keyboardShouldPersistTaps="handled", so the tap itself now reaches
    // this handler instead of being spent only on dismissing the keyboard first.
    Keyboard.dismiss();
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

  // Auto-runs the search once, only for a fresh add opened from a suggestion chip
  // (initialQuery set, no editingMember - an edit already has its own known candidate, nothing
  // to search for). Mount-only by design, matching this component's own real-world lifecycle:
  // ConfirmScreen remounts a fresh TitleSearchPicker per modal open (same assumption its own
  // editingMember pre-fill already relies on), so this never needs to react to a later change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (initialQuery && !editingMember) handleSearch();
  }, []);

  // The candidate whose TMDb preview still counts (2026-10-07): picking A, tapping "Not this
  // one" and then picking B let A's slower lookup land afterwards and fill B's franchise,
  // rating and family/animated flags with A's values, and end B's loading state early.
  const previewForImdbIdRef = useRef<string | null>(null);

  function selectCandidate(c: OmdbSearchCandidate) {
    setSelectedImdbId(c.imdbID);
    setMovieOrTv(guessMovieOrTvFromType(c.Type));
    setTmdbRating(null);
    setTmdbPreviewLoading(true);
    previewForImdbIdRef.current = c.imdbID;
    previewTmdbFields(c.imdbID)
      .then((preview) => {
        if (previewForImdbIdRef.current !== c.imdbID) return;
        if (preview.franchise.length > 0) setFranchise((prev) => prev || preview.franchise.join(", "));
        // See CollectionMember's own comment - a confirmed answer either way (true/false),
        // never left at the "unknown" default once a real TMDb match came back, so the
        // header's unanimity check can tell "confirmed not family" apart from "no data yet".
        setIsFamilyOrKidsGenre(preview.genres.some((g) => /family|kids/i.test(g)));
        setIsAnimatedStyle(preview.isAnimated === true);
        setTmdbRating(preview.rating);
      })
      .catch(() => {
        // Read-only preview - a failure here just means no franchise suggestion, nothing to
        // recover or block on. Treated the same as "TMDb has no rating either" below - the
        // manual Rating field must still be offered, not silently left missing forever.
      })
      .finally(() => {
        if (previewForImdbIdRef.current === c.imdbID) setTmdbPreviewLoading(false);
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
    const sortedDiscs = [...selectedDiscs].sort((a, b) => a - b);
    // A "special features disc" that's also one of this title's OWN movie discs isn't a
    // separate disc at all - added 2026-09-27 per the user's own correction: "if the special
    // features disk selected is the same disk that the movie exists on, then it does not
    // count as having a 'special features disk' as it just counts as having special
    // features." `specialFeatures` below already fully captures "this release has special
    // features"; specialFeaturesDiscCount/Format/Numbers exist specifically to describe a
    // disc genuinely distinct from the movie's own, so only discs that don't overlap
    // `selectedDiscs` count toward them. The picker itself (and its default-to-last-disc
    // effect above) is untouched - the user still picks whichever disc actually has the
    // features, even when that happens to be the same disc the movie's on; only what gets
    // SAVED as a distinct bonus disc changes here.
    const sortedSpecialFeaturesDiscs = [...selectedSpecialFeaturesDiscs]
      .filter((d) => !selectedDiscs.includes(d))
      .sort((a, b) => a - b);
    onAdd({
      key: editingMember?.key ?? generateMemberKey(),
      imdbId: selectedImdbId ?? undefined,
      title: resolvedTitle,
      poster: selectedCandidate?.Poster !== "N/A" ? selectedCandidate?.Poster : undefined,
      movieOrTv,
      seasonNo: showSeasonFields ? seasonNo.trim() || undefined : undefined,
      partOfSeasonNo: showSeasonFields ? partOfSeasonNo.trim() || undefined : undefined,
      episodeCount: showSeasonFields ? episodeCount.trim() || undefined : undefined,
      franchise: franchise.trim() || undefined,
      rating: rating.trim() || undefined,
      tmdbRating,
      watched,
      watchedDisc,
      format,
      // A title's own disc count is simply how many discs it ticked (redesigned 2026-09-20 -
      // there is no separate per-title Disc Count input any more).
      discCount: String(sortedDiscs.length || 1),
      discNumbers: sortedDiscs.join(","),
      specialFeatures,
      // `sortedSpecialFeaturesDiscs` above is already filtered down to discs distinct from
      // this title's own movie disc(s) - when nothing survives that filter (every disc
      // ticked for special features turned out to be one of the movie's own), none of these
      // three are set at all, since there's no genuinely separate disc to describe. Guards
      // explicitly against `.length` (rather than `String(...) || undefined`, which would
      // wrongly keep the literal string "0") since a length of exactly 0 is now a real,
      // common case this filter produces, not just a theoretical one.
      specialFeaturesDiscCount:
        showMemberSpecialFeaturesDiscFields && sortedSpecialFeaturesDiscs.length > 0
          ? String(sortedSpecialFeaturesDiscs.length)
          : undefined,
      specialFeaturesDiscFormat:
        showMemberSpecialFeaturesDiscFields && sortedSpecialFeaturesDiscs.length > 0
          ? specialFeaturesDiscFormat || undefined
          : undefined,
      specialFeaturesDiscNumbers:
        showMemberSpecialFeaturesDiscFields && sortedSpecialFeaturesDiscs.length > 0
          ? sortedSpecialFeaturesDiscs.join(",")
          : undefined,
      releaseName: releaseName.trim() || undefined,
      isFamilyOrKidsGenre,
      isAnimatedStyle,
    });
  }

  const titleNode = (
    <>
      {!hasSearched && !selectedCandidate && (
        <View style={styles.section}>
          <TextInput
            ref={queryInputRef}
            style={styles.input}
            value={query}
            onChangeText={setQuery}
            onFocus={() => scrollInputRefIntoView(queryInputRef)}
            placeholder="Title"
            placeholderTextColor="#8193ab"
            autoFocus
            returnKeyType="search"
            onSubmitEditing={handleSearch}
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
                  ref={manualTitleInputRef}
                  style={styles.input}
                  value={manualTitle}
                  onChangeText={setManualTitle}
                  onFocus={() => scrollInputRefIntoView(manualTitleInputRef)}
                  placeholder="Title"
                  placeholderTextColor="#8193ab"
                />
              </View>
            </>
          )}
        </View>
      )}

      {selectedCandidate && (
        <View style={styles.section}>
          {selectedCandidate.Poster && selectedCandidate.Poster !== "N/A" && (
            <Image source={{ uri: selectedCandidate.Poster }} style={styles.posterLarge} resizeMode="cover" />
          )}
          <Text style={styles.label}>{selectedCandidate.Title} ({selectedCandidate.Year})</Text>
          <TouchableOpacity
            onPress={() => {
              previewForImdbIdRef.current = null;
              setSelectedImdbId(null);
              setTmdbPreviewLoading(false);
            }}
          >
            <Text style={styles.link}>Not this one - pick again</Text>
          </TouchableOpacity>
        </View>
      )}

      {(selectedCandidate || (hasSearched && candidates.length === 0)) && (
        <TouchableOpacity
          style={styles.button}
          onPress={() => (slideReturn ? setActiveSlide(slideReturn) : setActiveSlide("type"))}
          disabled={!resolvedTitle}
        >
          <Text style={styles.buttonText}>{slideReturn ? "Back to review" : "Continue"}</Text>
        </TouchableOpacity>
      )}
    </>
  );

  // Split into typeNode / formatNode / specialFeaturesNode (2026-09-23, previously one combined
  // "Type, format & discs" slide the user found too cluttered) - each is both a real top-level
  // slide in its own right (see `slides` below) AND reused inline inside summaryNode's own
  // expandable rows, same dual-use pattern extraNode already has.
  const typeNode = (
    <>
      <View style={styles.section}>
        <Text style={styles.label}>Movie or TV</Text>
        <BigChoice options={MOVIE_OR_TV_OPTIONS} value={movieOrTv} onChange={setMovieOrTv} columns={2} />
      </View>
      {showSeasonFields && (
        <>
          <View style={styles.section}>
            <Text style={styles.label}>Season No. (optional)</Text>
            <TextInput
              ref={seasonNoInputRef}
              style={styles.input}
              value={seasonNo}
              onChangeText={setSeasonNo}
              onFocus={() => scrollInputRefIntoView(seasonNoInputRef)}
              placeholderTextColor="#8193ab"
            />
          </View>
          <View style={styles.section}>
            <Text style={styles.label}>Part of a Season No. (optional)</Text>
            <TextInput
              ref={partOfSeasonNoInputRef}
              style={styles.input}
              value={partOfSeasonNo}
              onChangeText={setPartOfSeasonNo}
              onFocus={() => scrollInputRefIntoView(partOfSeasonNoInputRef)}
              keyboardType="number-pad"
              placeholderTextColor="#8193ab"
            />
          </View>
          <View style={styles.section}>
            <Text style={styles.label}>Episode Count on this disc (optional)</Text>
            <TextInput
              ref={episodeCountInputRef}
              style={styles.input}
              value={episodeCount}
              onChangeText={setEpisodeCount}
              onFocus={() => scrollInputRefIntoView(episodeCountInputRef)}
              keyboardType="number-pad"
              placeholderTextColor="#8193ab"
            />
          </View>
        </>
      )}
      {!selectedCandidate && (
        <View style={styles.section}>
          <Text style={styles.label}>Title</Text>
          <TextInput
            ref={manualTitleInputRef}
            style={styles.input}
            value={manualTitle}
            onChangeText={setManualTitle}
            onFocus={() => scrollInputRefIntoView(manualTitleInputRef)}
            placeholderTextColor="#8193ab"
          />
        </View>
      )}
    </>
  );

  const formatNode = (
    <>
      <View style={styles.section}>
        <Text style={styles.label}>Format (this title's own disc)</Text>
        <BigChoice options={commonFormats} value={format} onChange={setFormat} />
        <Text style={styles.hint}>Something else? Pick or type it here:</Text>
        <SearchableModalInput value={format} onChangeText={setFormat} options={fieldOptions?.format ?? []} />
      </View>
      <View style={styles.section}>
        <Text style={styles.label}>What disc(s) is this title on?</Text>
        {totalDiscCount > 0 ? (
          <>
            {Array.from({ length: totalDiscCount }, (_, i) => i + 1).map((n) => {
              const checked = selectedDiscs.includes(n);
              return (
                <TouchableOpacity
                  key={n}
                  style={styles.checkboxRow}
                  onPress={() => setSelectedDiscs((prev) => (prev.includes(n) ? prev.filter((d) => d !== n) : [...prev, n]))}
                >
                  <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
                    {checked && <Text style={styles.checkboxMark}>✓</Text>}
                  </View>
                  <Text style={styles.checkboxLabel}>Disc {n}</Text>
                </TouchableOpacity>
              );
            })}
            <Text style={styles.hint}>
              Tick every disc this title is on. Two titles that share a disc just tick the same one.
            </Text>
          </>
        ) : (
          <Text style={styles.hint}>Set the collection&apos;s Total Disc Count first, then come back.</Text>
        )}
      </View>
    </>
  );

  const specialFeaturesNode = (
    <>
      <View style={[styles.section, styles.row]}>
        <Text style={styles.label}>Special Features</Text>
        <Switch value={specialFeatures} onValueChange={setSpecialFeatures} />
      </View>
      {showMemberSpecialFeaturesDiscFields && (
        <>
          <View style={styles.section}>
            <Text style={styles.label}>Which disc(s) have the special features?</Text>
            {totalDiscCount > 0 ? (
              <>
                {Array.from({ length: totalDiscCount }, (_, i) => i + 1).map((n) => {
                  const checked = selectedSpecialFeaturesDiscs.includes(n);
                  return (
                    <TouchableOpacity
                      key={n}
                      style={styles.checkboxRow}
                      onPress={() =>
                        setSelectedSpecialFeaturesDiscs((prev) => (prev.includes(n) ? prev.filter((d) => d !== n) : [...prev, n]))
                      }
                    >
                      <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
                        {checked && <Text style={styles.checkboxMark}>✓</Text>}
                      </View>
                      <Text style={styles.checkboxLabel}>Disc {n}</Text>
                    </TouchableOpacity>
                  );
                })}
                <Text style={styles.hint}>
                  Could be the same disc as the movie itself (if the features are bundled onto it), a disc shared
                  with other titles&apos; bonus features, or any other disc in this set.
                </Text>
              </>
            ) : (
              <Text style={styles.hint}>Set the collection&apos;s Total Disc Count first, then come back.</Text>
            )}
          </View>
          <View style={styles.section}>
            <Text style={styles.label}>Format of Special Features Disc(s)</Text>
            <SearchableModalInput
              value={specialFeaturesDiscFormat}
              onChangeText={setSpecialFeaturesDiscFormat}
              options={fieldOptions?.format ?? []}
            />
            <Text style={styles.hint}>
              Can differ from the title&apos;s own format above (e.g. a Blu-ray bonus disc in a 4K set). Fills in
              automatically once you tick a disc whose format is already known from elsewhere in this set - still
              yours to correct if it&apos;s wrong.
            </Text>
          </View>
        </>
      )}
    </>
  );

  const extraNode = (
    <>
      <View style={styles.section}>
        <Text style={styles.label}>Franchise (optional)</Text>
        <FranchiseEditor
          value={franchise}
          onChange={setFranchise}
          options={fieldOptions?.franchise ?? []}
          cooccurrence={fieldOptions?.franchiseCooccurrence ?? {}}
        />
      </View>
      {tmdbPreviewLoading && <Text style={styles.hint}>Checking TMDb for Rating...</Text>}
      {showMemberRatingField && (
        <View style={styles.section}>
          <Text style={styles.label}>
            Rating{selectedImdbId ? " (not on TMDb - from the case)" : " (from the case)"}
          </Text>
          {memberCommonRatings.length > 0 && (
            <>
              <Text style={styles.hint}>
                {isFamilyOrKidsGenre && isAnimatedStyle ? "Common for family/kids animated titles:" : `Common for ${franchise.split(",")[0].trim()}:`}
              </Text>
              <SingleSelectChips options={memberCommonRatings} value={rating} onChange={setRating} />
            </>
          )}
          <SearchableModalInput
            value={rating}
            onChangeText={setRating}
            options={fieldOptions?.rating ?? []}
            placeholder="e.g. G, PG, M, R13"
          />
        </View>
      )}
      <View style={styles.section}>
        <Text style={styles.label}>Release Name (optional, if different from Title)</Text>
        <TextInput
          ref={releaseNameInputRef}
          style={styles.input}
          value={releaseName}
          onChangeText={setReleaseName}
          onFocus={() => scrollInputRefIntoView(releaseNameInputRef)}
          placeholder="e.g. Definitive Edition"
          placeholderTextColor="#8193ab"
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
    </>
  );

  const toggleRow = (key: string) => setOpenRow((prev) => (prev === key ? null : key));
  const summaryNode = (
    <>
      <Text style={styles.hint}>Everything below is pre-filled. Tap a line to change it right here, or just Save.</Text>
      <SummaryRow
        label="Match"
        value={resolvedTitle || "?"}
        missing={!resolvedTitle}
        onPress={() => {
          setSlideReturn("summary");
          setActiveSlide("title");
        }}
      />
      <SummaryRow
        label="Type"
        value={movieOrTv || "?"}
        expanded={openRow === "type"}
        onPress={() => toggleRow("type")}
      >
        {typeNode}
      </SummaryRow>
      <SummaryRow
        label="Format & discs"
        value={`${format || "?"}, disc(s) ${selectedDiscs.join(",") || "?"}`}
        missing={!format.trim() || selectedDiscs.length === 0}
        expanded={openRow === "format"}
        onPress={() => toggleRow("format")}
      >
        {formatNode}
      </SummaryRow>
      <SummaryRow
        label="Special features"
        value={
          specialFeatures
            ? `disc(s) ${selectedSpecialFeaturesDiscs.join(",") || "?"}, ${specialFeaturesDiscFormat || "format?"}`
            : "None"
        }
        missing={specialFeatures && (selectedSpecialFeaturesDiscs.length === 0 || !specialFeaturesDiscFormat.trim())}
        // Worth a glance when off (2026-09-24, per the user's own request) - easy to forget to
        // tick for a title that does have its own bonus content.
        notable={!specialFeatures}
        expanded={openRow === "specialFeatures"}
        onPress={() => toggleRow("specialFeatures")}
      >
        {specialFeaturesNode}
      </SummaryRow>
      <SummaryRow
        label="Franchise, release & watched"
        value={
          [franchise, releaseName, watchedDisc ? "watched this disc" : watched ? "watched" : ""].filter((v) => v.trim()).join(", ") ||
          "-"
        }
        // Amber when Franchise is blank (2026-09-24, per the user's own request) - same
        // "worth a glance, not required" treatment as the single-title flow's own Franchise
        // row (a blank Franchise is very often genuinely correct, just easy to forget to check).
        notable={!franchise.trim()}
        expanded={openRow === "extra"}
        onPress={() => toggleRow("extra")}
      >
        {extraNode}
      </SummaryRow>
      {error && <Text style={styles.error}>{error}</Text>}
      <TouchableOpacity
        style={styles.button}
        onPress={handleAddPressed}
        disabled={!resolvedTitle || !format.trim() || selectedDiscs.length === 0}
      >
        <Text style={styles.buttonText}>{editingMember ? "Save changes" : "Add to set"}</Text>
      </TouchableOpacity>
    </>
  );

  const slides: Slide[] = [
    { key: "title", label: "Which title is this?", node: titleNode },
    { key: "type", label: "Movie or TV", node: typeNode },
    { key: "format", label: "Format & discs", node: formatNode },
    { key: "specialFeatures", label: "Special features", node: specialFeaturesNode },
    { key: "extra", label: "Franchise, release & watched", node: extraNode },
    { key: "summary", label: "Review & save", node: summaryNode },
  ];

  return (
    // Same iOS-only KeyboardAvoidingView + manual scroll-to-focused-field split as
    // ConfirmScreen.tsx's own return - see that screen's comment for why (two automatic
    // approaches proved inconsistent on Android in real testing; Android relies entirely on
    // its own native window resize, app.json's softwareKeyboardLayoutMode).
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView
        ref={scrollRef}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.title}>{editingMember ? "Edit this title" : "Add a title to this set"}</Text>
        <SlideFlow
          activeKey={activeSlide}
          onChange={(key) => {
            setSlideReturn(null);
            setActiveSlide(key);
          }}
          returnKey={slideReturn}
          slides={slides}
        />
        <TouchableOpacity onPress={onCancel}>
          <Text style={styles.link}>Cancel</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#070d17" },
  scrollContent: { padding: 16, paddingTop: 48, gap: 12 },
  title: { color: "#e9f1f9", fontSize: 18, fontFamily: FONTS.displayBold },
  section: { gap: 8 },
  // gap + flexShrink on the sibling text styles below (added 2026-09-20) - see
  // ConfirmScreen.tsx's own `label` style comment for the full reasoning: without flexShrink,
  // a long label next to a fixed-size Switch/checkbox renders at its full natural width and
  // pushes the control off the right edge of the screen instead of wrapping.
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 },
  label: { color: "#d7e2ee", fontFamily: FONTS.displaySemiBold, flexShrink: 1 },
  hint: { fontFamily: FONTS.body, color: "#a9b8cc", fontStyle: "italic" },
  link: { fontFamily: FONTS.body, color: "#5cc8ff" },
  error: { fontFamily: FONTS.body, color: "#f87171" },
  input: {
    ...WELL,
    fontFamily: FONTS.body,
    borderWidth: 1,
    borderColor: "#24395a",
    borderRadius: 0,
    padding: 10,
    color: "#e9f1f9",
  },
  button: {
    ...GLOSS,
    backgroundColor: "#1d6c9a",
    borderRadius: 0,
    padding: 12,
    alignItems: "center",
  },
  buttonText: { letterSpacing: 1, color: "#e9f1f9", fontFamily: FONTS.displaySemiBold },
  checkboxRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 0,
    borderWidth: 1,
    borderColor: "#8193ab",
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxChecked: { backgroundColor: "#1d6c9a", borderColor: "#1d6c9a" },
  checkboxMark: { fontFamily: FONTS.body, color: "#e9f1f9", fontSize: 14 },
  checkboxLabel: { fontFamily: FONTS.body, color: "#d7e2ee", flexShrink: 1 },
  candidateRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8 },
  candidateText: { fontFamily: FONTS.body, color: "#d7e2ee", flexShrink: 1 },
  posterThumb: { width: 40, height: 56, borderRadius: 0 },
  posterLarge: { width: 100, height: 140, borderRadius: 0 },
});
