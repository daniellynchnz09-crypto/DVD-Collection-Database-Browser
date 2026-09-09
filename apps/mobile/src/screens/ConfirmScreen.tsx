import { useEffect, useRef, useState } from "react";
import {
  findNodeHandle,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
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
import {
  cleanProductTitleForSearch,
  DISC_CONDITION_VALUES,
  extractFormatHint,
  getDiskRegionOptions,
  isRegionFreeFormat,
  NOT_LISTED_REGION,
} from "@danflix/shared";
import {
  confirmScan,
  discardScan,
  dismissScan,
  findExistingTitle,
  previewTmdbFields,
  searchTitleOnOmdb,
  type ConfirmEntry,
  type ExistingTitleCandidate,
  type FindExistingResult,
  type TmdbPreview,
} from "../lib/scanApi";
import { loadFieldOptions, type FieldOptions } from "../lib/fieldOptions";
import { clearConfirmDraft, getConfirmDraft, saveConfirmDraft } from "../lib/confirmDrafts";
import { createScrollIntoViewHandler } from "../lib/scrollIntoView";
import AutocompleteInput from "../components/AutocompleteInput";
import MultiSelectChips from "../components/MultiSelectChips";
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

  // Scroll-to-focused-field: KeyboardAvoidingView's padding (below) reserves room for the
  // keyboard, but never moves the scroll position - a field far down this long form can
  // still end up hidden behind the keyboard with nothing to bring it into view. Built
  // directly on RN's own UIManager.measureInWindow rather than a third-party keyboard-
  // aware scroll view, which was tried on this exact screen before and proved inconsistent
  // in real testing (see Claude/TECH STACK AND ARCHITECTURE.md's keyboard-avoidance history).
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
  /** Plain TextInputs scroll themselves into view via their own ref (not the focus event's
   * target - findNodeHandle wants a component ref, and a component ref is all a single
   * TextInput needs measuring anyway, unlike AutocompleteInput which also has a dropdown). */
  function scrollInputRefIntoView(ref: React.RefObject<TextInput | null>) {
    scrollFieldIntoView(findNodeHandle(ref.current));
  }
  function handleScroll(event: NativeSyntheticEvent<NativeScrollEvent>) {
    scrollYRef.current = event.nativeEvent.contentOffset.y;
  }
  const titleSearchInputRef = useRef<TextInput>(null);
  const manualTitleInputRef = useRef<TextInput>(null);
  const releaseNameInputRef = useRef<TextInput>(null);
  const discCountInputRef = useRef<TextInput>(null);
  const specialFeaturesDiscCountInputRef = useRef<TextInput>(null);
  const releaseVariantNoteInputRef = useRef<TextInput>(null);
  const caseNotesInputRef = useRef<TextInput>(null);
  const depictedEraLabelInputRef = useRef<TextInput>(null);
  const tmdbIdOverrideInputRef = useRef<TextInput>(null);

  const isCollection = Boolean(scan.resolved_candidates?.isCollection);
  const upcProduct = scan.resolved_candidates?.upcProduct;
  const posterMatch = (scan.resolved_candidates as { posterMatch?: PosterMatch | null })
    ?.posterMatch;
  const draft = getConfirmDraft(scan.id);
  // OMDB candidates, either from the automatic resolver (a real UPC listing gave it a
  // title to search with) or from the manual title-search step below (the barcode came
  // back with no usable product data at all, so there was nothing to search with until
  // the user typed a title) - state rather than a derived const so a manual search's
  // results can populate it and hand off to all the same selection/poster/TMDb-preview
  // machinery below, unchanged.
  const [candidates, setCandidates] = useState<OmdbCandidate[]>(
    () => draft?.candidates ?? ((scan.resolved_candidates?.omdbCandidates ?? []) as OmdbCandidate[])
  );
  const autoMatched = posterMatch?.confident ? posterMatch : null;
  const autoMatchedCandidate = autoMatched
    ? candidates.find((c) => c.imdbID === autoMatched.bestImdbId) ?? null
    : null;
  // Only the "barcode gave literally nothing" case needs the title-search step - if a UPC
  // listing came back (even one OMDB couldn't find a match for), the user still has a
  // product photo/description to work from and the ordinary manual-entry form below is
  // enough; there's no title text to search with in that case anyway.
  const [titleSearchQuery, setTitleSearchQuery] = useState(draft?.titleSearchQuery ?? "");
  const [titleSearching, setTitleSearching] = useState(false);
  const [hasSearchedOrSkipped, setHasSearchedOrSkipped] = useState(draft?.hasSearchedOrSkipped ?? false);
  const needsTitleSearch = candidates.length === 0 && !upcProduct && !hasSearchedOrSkipped;
  // "DVD (Custom Burn)" discs often carry non-English/obscure franchise names that a
  // generic English spellchecker or a fuzzy match against real TMDb titles would "correct"
  // into something wrong - the user flags this before searching rather than the app
  // guessing from the format field, which isn't chosen yet at this point in the flow.
  const [isCustomDisc, setIsCustomDisc] = useState(draft?.isCustomDisc ?? false);

  // Starts collapsed to just the auto-matched candidate when the listing's own photo
  // confidently matched one poster - "Not this item" reveals the full list to pick from
  // manually instead. (Or, if a draft exists - the user was already partway through this
  // scan and left - restores exactly what they'd chosen instead of these defaults.)
  const [showAllCandidates, setShowAllCandidates] = useState(draft?.showAllCandidates ?? !autoMatchedCandidate);
  // A single candidate (whether the resolver only ever found one, or a manual title search
  // below only turned up one) is auto-selected rather than making the user tap it - nothing
  // to disambiguate when there's only one option. Still fully reversible: tapping it again
  // deselects it like any other candidate.
  const [selected, setSelected] = useState<Set<string>>(() => {
    if (draft?.selected) return new Set(draft.selected);
    if (autoMatchedCandidate) return new Set([autoMatchedCandidate.imdbID]);
    if (candidates.length === 1) return new Set([candidates[0].imdbID]);
    return new Set();
  });
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
  // A fixed small set of codes (see getDiskRegionOptions), not free text - and some discs
  // are coded for more than one region at once (e.g. "2, 4"), so this is a toggleable set
  // rather than a single value (see MultiSelectChips).
  const [diskRegions, setDiskRegions] = useState<Set<string>>(() => new Set(draft?.diskRegions ?? []));
  const [genreLocation, setGenreLocation] = useState(draft?.genreLocation ?? "");
  // Both exposed here for the first time, per the user's own request after finding
  // Casper's Haunted Christmas silently logged with no Franchise and the wrong Animation/
  // Live Action value - neither field had ever actually been asked for anywhere in the scan
  // form, so every barcode-scanned title got Franchise blank and (see confirm route)
  // Animation/Live Action hardcoded to "Live Action" regardless of truth. Prefilled from
  // TMDb (isAnimated)/Wikidata (franchise) below once a candidate is picked, but always a
  // plain editable field, never hidden - unlike Rating/Studio, neither source is reliable
  // enough to trust blindly (Wikidata's franchise guess in particular was proven wrong on
  // other titles during testing - see Claude/TECH STACK AND ARCHITECTURE.md).
  const [franchise, setFranchise] = useState(draft?.franchise ?? "");
  const [animationOrLiveAction, setAnimationOrLiveAction] = useState(draft?.animationOrLiveAction ?? "");
  // Fields added ahead of the full-collection backfill rescan (Claude/TECH STACK AND
  // ARCHITECTURE.md's "Backfill Rescan" section) - captured now because they're only
  // observable from the physical disc/case itself, unlike the metadata-driven fields
  // above, which can be backfilled later via a script keyed on tmdb_id/imdb_id.
  const [releaseVariantNote, setReleaseVariantNote] = useState(draft?.releaseVariantNote ?? "");
  const [discCondition, setDiscCondition] = useState(draft?.discCondition ?? "None");
  const [caseNotes, setCaseNotes] = useState(draft?.caseNotes ?? "");
  // `watched` means "seen this film at all, any format" (the broad claim); `watchedDisc`
  // means "watched this specific disc" (the narrow claim) - see 0018_rename_watched_title_
  // to_watched_disc.sql for why this isn't named `watchedTitle` any more.
  const [watched, setWatched] = useState(draft?.watched ?? false);
  const [watchedDisc, setWatchedDisc] = useState(draft?.watchedDisc ?? false);
  const [depictedEraLabel, setDepictedEraLabel] = useState(draft?.depictedEraLabel ?? "");
  // Manual fallback for when TMDb's own /find-by-imdb-id lookup comes up empty - see
  // showTmdbOverrideField below. Only ever needed for a genuine TMDb miss, not shown by
  // default.
  const [tmdbIdOverride, setTmdbIdOverride] = useState(draft?.tmdbIdOverride ?? "");
  // Manual-only, deliberately never auto-filled from OMDB's "Rated" field - that's a US
  // MPAA-style value and often just "Not Rated" even for titles that do carry a real NZ/
  // Oceania classification on the physical case, which is the authoritative source here.
  const [rating, setRating] = useState(draft?.rating ?? "");
  const [studio, setStudio] = useState(draft?.studio ?? "");
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
  // "Would TMDb find anything for this specific title" - keeps the manual Rating/Studio
  // fields hidden by default (TMDB now auto-fills both at confirm time - see
  // Claude/TECH STACK AND ARCHITECTURE.md's TMDb section) and only reveals one once TMDb
  // has genuinely come up empty for that specific field.
  const [tmdbPreview, setTmdbPreview] = useState<TmdbPreview | null>(null);
  const [tmdbPreviewLoading, setTmdbPreviewLoading] = useState(false);
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
    if (diskRegions.size > 0) return;
    if (isRegionFreeFormat(format)) setDiskRegions(new Set(["All"]));
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
      diskRegions: [...diskRegions],
      genreLocation,
      rating,
      studio,
      steelbook,
      specialFeatures,
      specialFeaturesDiscCount,
      specialFeaturesDiscFormat,
      candidates,
      titleSearchQuery,
      hasSearchedOrSkipped,
      isCustomDisc,
      franchise,
      animationOrLiveAction,
      releaseVariantNote,
      discCondition,
      caseNotes,
      watched,
      watchedDisc,
      depictedEraLabel,
      tmdbIdOverride,
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
    diskRegions,
    genreLocation,
    rating,
    studio,
    steelbook,
    specialFeatures,
    specialFeaturesDiscCount,
    specialFeaturesDiscFormat,
    candidates,
    titleSearchQuery,
    hasSearchedOrSkipped,
    isCustomDisc,
    franchise,
    animationOrLiveAction,
    releaseVariantNote,
    discCondition,
    caseNotes,
    watched,
    watchedDisc,
    depictedEraLabel,
    tmdbIdOverride,
  ]);

  /** Runs the typed title through the same OMDB search the automatic resolver uses,
   * handing the results to the existing candidate-picker/poster/TMDb-preview UI below
   * exactly as if a real UPC listing had produced them. */
  async function handleTitleSearch() {
    const query = titleSearchQuery.trim();
    if (!query) return;
    setTitleSearching(true);
    setError(null);
    try {
      const result = await searchTitleOnOmdb(query, isCustomDisc);
      setCandidates(result.candidates);
      setHasSearchedOrSkipped(true);
      if (result.candidates.length === 1) setSelected(new Set([result.candidates[0].imdbID]));
      if (!manualTitle) setManualTitle(query);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setTitleSearching(false);
    }
  }

  /** Skips straight to the ordinary manual-entry form instead of searching OMDB at all. */
  function handleSkipTitleSearch() {
    if (!manualTitle) setManualTitle(titleSearchQuery.trim());
    setHasSearchedOrSkipped(true);
  }

  const diskRegionOptions = getDiskRegionOptions(format) ?? fieldOptions?.diskRegion ?? [];
  const showSpecialFeaturesDiscFields = specialFeatures && (parseInt(discCount, 10) || 1) > 1;
  // A box set's cover only ever shows one rating/studio for the whole collection, which
  // isn't necessarily any single film's own rating - so manual Rating/Studio entry only
  // applies when this scan is producing exactly one title. For an actual multi-title
  // collection, each member instead keeps whatever OMDB itself has for that specific
  // title (already computed per-entry server-side), imperfect as that sometimes is.
  const isMultiTitleCollection = selected.size > 1;
  const singleSelectedImdbId = !isMultiTitleCollection && selected.size === 1 ? [...selected][0] : null;

  // Re-checks TMDb every time the chosen candidate changes - a different film can have
  // different TMDb availability. No candidate selected at all (pure manual entry, no
  // imdbId to look up) means TMDb can never be tried, so the fields show immediately
  // rather than waiting on a preview that will never resolve.
  useEffect(() => {
    if (!singleSelectedImdbId) {
      setTmdbPreview(null);
      setTmdbPreviewLoading(false);
      return;
    }
    let cancelled = false;
    setTmdbPreviewLoading(true);
    previewTmdbFields(singleSelectedImdbId)
      .then((result) => {
        if (cancelled) return;
        setTmdbPreview(result);
        // Never overwrites something already typed - same non-destructive prefill pattern
        // as the 4K-region default and the UPC-listing format guess above.
        setFranchise((prev) => (prev ? prev : result.franchise ?? prev));
        // isAnimated === false is a confirmed "no Animation genre on TMDb" - safe to lock
        // the field to Live Action. isAnimated === true leaves this blank rather than
        // guessing a specific style (2D/3D/Puppet/...), which TMDb doesn't tell us; the
        // field stays visible as a real dropdown for the user to pick one. isAnimated ===
        // null (no TMDb match at all) is left alone too - genuinely unknown, not "Live
        // Action" by default.
        setAnimationOrLiveAction((prev) => (prev ? prev : result.isAnimated === false ? "Live Action" : prev));
      })
      .catch(() => {
        // A failed preview fetch is "unknown", not "confirmed Live Action" - must not
        // collapse to isAnimated: false, which would hide the field and force the wrong
        // value below.
        if (!cancelled) setTmdbPreview({ tmdbId: null, rating: null, studio: null, isAnimated: null, franchise: null });
      })
      .finally(() => {
        if (!cancelled) setTmdbPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [singleSelectedImdbId]);

  // While a lookup for the current candidate is still in flight, keep the fields hidden
  // rather than briefly showing them and then hiding them again once TMDb answers.
  const showRatingField = singleSelectedImdbId
    ? !tmdbPreviewLoading && !tmdbPreview?.rating
    : true;
  const showStudioField = singleSelectedImdbId
    ? !tmdbPreviewLoading && !tmdbPreview?.studio
    : true;
  // TMDb doesn't actually have a "Live Action" genre - only an "Animation" tag that's
  // present or absent - so isAnimated === false is a confirmed live-action answer, and the
  // field can be hidden entirely (locked to "Live Action" via the effect above), same as
  // Rating/Studio hiding once TMDb has answered. isAnimated === true keeps the field
  // visible so the user can pick the specific style TMDb doesn't know. isAnimated === null
  // (no TMDb match) also keeps it visible, since we have no confirmed answer either way.
  const showAnimationField = singleSelectedImdbId
    ? !tmdbPreviewLoading && tmdbPreview?.isAnimated !== false
    : true;
  // Once TMDb has confirmed this is animated, "Live Action" itself is never a valid choice
  // for the style dropdown - filtered out only in that specific case, not for the
  // unknown/no-match case where it may still be the right answer.
  const animationOptions =
    singleSelectedImdbId && tmdbPreview?.isAnimated === true
      ? (fieldOptions?.animationOrLiveAction ?? []).filter((option) => option !== "Live Action")
      : fieldOptions?.animationOrLiveAction ?? [];
  // Same regex computeShelfLocation itself uses server-side (apps/web/src/app/api/scan/
  // confirm/route.ts) - only worth asking for a worded era label when this scan is
  // actually headed for that shelf section.
  const isHistoryDocumentary = /history document/i.test(genreLocation);
  // Hard requirement (Claude/TECH STACK AND ARCHITECTURE.md's "Backfill Rescan" section):
  // a candidate-backed entry (a real film was identified) must end up with a real TMDb id,
  // so every metadata-driven feature can be backfilled later without re-touching the
  // physical disc. TMDb's own /find lookup sometimes has nothing - this shows a manual
  // override field in that case and blocks Confirm until it's filled in.
  const showTmdbOverrideField = Boolean(
    singleSelectedImdbId && !tmdbPreviewLoading && tmdbPreview?.tmdbId == null
  );

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

  /** `overwriteUniqueId`, when given, replaces that already-catalogued title's every field
   * with this scan's data instead of creating a new row - the "Overwrite" choice on the
   * similar-entry check below. */
  async function performCreate(overwriteUniqueId?: string) {
    setSubmitting(true);
    setError(null);
    try {
      const chosen = candidates.filter((c) => selected.has(c.imdbID));

      const manualFields = {
        format,
        disc_count: parseInt(discCount, 10) || 1,
        disk_region: diskRegions.size > 0 ? [...diskRegions].join(", ") : null,
        genre_location: genreLocation || null,
        franchise: franchise.trim() || null,
        // The confirm route defaults a blank value to "Live Action" (the right call when
        // there's no TMDb signal at all). But if TMDb *has* confirmed this is animated and
        // the user leaves the style dropdown blank, falling through to that default would
        // silently mislabel a known-animated title - so that one case sends "Animation"
        // instead of null.
        animation_or_live_action:
          animationOrLiveAction.trim() ||
          (singleSelectedImdbId && tmdbPreview?.isAnimated === true ? "Animation" : null),
        rating: isMultiTitleCollection ? null : rating.trim() || null,
        studio: isMultiTitleCollection ? null : studio.trim() || null,
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
        release_variant_note: releaseVariantNote.trim() || null,
        disc_condition: discCondition,
        case_notes: caseNotes.trim() || null,
        watched,
        watched_disc: watchedDisc,
        depicted_era_label: isHistoryDocumentary ? depictedEraLabel.trim() || null : null,
        tmdb_id_override: showTmdbOverrideField ? tmdbIdOverride.trim() || null : null,
        ...(selected.size === 0 ? { title: manualTitle || scan.barcode || "Untitled" } : {}),
      };
      const entries: ConfirmEntry[] =
        chosen.length > 0
          ? chosen.map((c, i) => ({
              imdbId: c.imdbID,
              barcodeId: i === 0 ? (scan.barcode ?? undefined) : undefined,
              manualFields,
            }))
          : [{ barcodeId: scan.barcode ?? undefined, manualFields }];

      const result = await confirmScan(scan.id, entries, overwriteUniqueId);
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
    if (showTmdbOverrideField && !tmdbIdOverride.trim()) {
      setError("TMDb has no match for this title - enter a TMDb link/id above to continue.");
      return;
    }
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
      const result = await findExistingTitle(titleForMatch, upcText, singleSelectedImdbId ?? undefined);
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

  /** "Overwrite" on the similar-entry check: replaces every field of the chosen existing
   * title with this scan's data instead of creating a new row. */
  async function handleOverwriteExisting() {
    if (!chosenExistingId) return;
    await performCreate(chosenExistingId);
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
      if (scan.barcode) onDiscarded?.(scan.barcode);
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
    const existingCandidates: ExistingTitleCandidate[] =
      existingCheck.status === "auto" ? [existingCheck.match] : existingCheck.candidates;
    const chosen = existingCandidates.find((c) => c.unique_id === chosenExistingId) ?? null;

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
            This looks like your existing entry for &quot;{existingCheck.match.title}&quot;. Compare it
            against what you just scanned, then choose what to do.
          </Text>
        ) : (
          <>
            <Text style={styles.body}>
              A few entries in your collection share this title. Which one is this disc?
            </Text>
            {existingCandidates.map((c) => (
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
                  {c.barcode_id ? "" : " (no barcode yet)"}
                </Text>
              </TouchableOpacity>
            ))}
          </>
        )}

        {chosen && (
          <View style={styles.section}>
            {chosen.posterUrl ? (
              <Image source={{ uri: chosen.posterUrl }} style={styles.scannedImage} resizeMode="contain" />
            ) : null}
            <Text style={styles.label}>Existing entry</Text>
            <Text style={styles.body}>
              {chosen.format}, {chosen.disc_count} disc{chosen.disc_count === 1 ? "" : "s"}
              {chosen.disk_region ? ` - Region ${chosen.disk_region}` : ""}
              {chosen.release_date ? ` - ${chosen.release_date.slice(0, 4)}` : ""}
            </Text>
            <Text style={styles.body}>
              {chosen.genre_location ? `Shelf: ${chosen.genre_location}. ` : ""}
              {chosen.franchise ? `Franchise: ${chosen.franchise}. ` : ""}
              {chosen.animation_or_live_action}
              {chosen.rating ? ` - Rated ${chosen.rating}` : ""}
              {chosen.studio ? ` - ${chosen.studio}` : ""}
            </Text>
            <Text style={styles.body}>
              {chosen.special_features ? "Has special features. " : ""}
              {chosen.steelbook ? "Steelbook. " : ""}
              {chosen.barcode_id ? `Barcode already on file: ${chosen.barcode_id}.` : "No barcode on file yet."}
            </Text>
          </View>
        )}

        {error && <Text style={styles.error}>{error}</Text>}

        <TouchableOpacity
          style={styles.button}
          onPress={handleOverwriteExisting}
          disabled={submitting || !chosenExistingId}
        >
          <Text style={styles.buttonText}>{submitting ? "Saving..." : "Overwrite - replace it with this scan"}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={handleTreatAsNew} disabled={submitting}>
          <Text style={styles.link}>Is a new entry - I genuinely own a separate copy</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={handleDiscard} disabled={submitting}>
          <Text style={styles.link}>Reject - this scan shouldn&apos;t be added at all</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  return (
    // Two different automatic approaches (KeyboardAvoidingView's "height" behavior, then
    // the react-native-keyboard-aware-scroll-view library) each proved inconsistent on
    // Android in real testing - one left a blank gap above the keyboard, the other
    // sometimes still let the keyboard cover a field and other times over-corrected,
    // pushing the Confirm button half out of the safe area. A static extra bottom padding
    // (an earlier attempt at a fix) made it worse in a different way - it doesn't go away
    // when the keyboard closes, leaving permanent dead space or cutting content off,
    // exactly like KeyboardAvoidingView's own "height" bug. Settled on the simplest thing
    // that stays correct in both keyboard states: iOS gets KeyboardAvoidingView's real
    // padding-based avoidance (it dynamically adds/removes padding matching the actual
    // keyboard, cleanly reverting on hide - no static leftover); Android has no such
    // behavior applied at all and relies entirely on its own native window resize
    // (app.json's softwareKeyboardLayoutMode), which already shrinks the available height
    // (and therefore the scrollable range) correctly on its own.
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView
        ref={scrollRef}
        onScroll={handleScroll}
        scrollEventThrottle={16}
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
      <Text style={styles.title}>{scan.barcode ? `Barcode ${scan.barcode}` : "New Entry"}</Text>

      {needsTitleSearch ? (
        <View style={styles.section}>
          <Text style={styles.hint}>
            {scan.barcode
              ? "This barcode didn't come back with any product data at all. What's the title?"
              : "What's the title?"}
          </Text>
          <TextInput
            ref={titleSearchInputRef}
            style={styles.input}
            value={titleSearchQuery}
            onChangeText={setTitleSearchQuery}
            onFocus={() => scrollInputRefIntoView(titleSearchInputRef)}
            placeholder="Title"
            placeholderTextColor="#71717a"
            autoFocus
          />
          <TouchableOpacity
            style={styles.checkboxRow}
            onPress={() => setIsCustomDisc((prev) => !prev)}
          >
            <View style={[styles.checkbox, isCustomDisc && styles.checkboxChecked]}>
              {isCustomDisc && <Text style={styles.checkboxMark}>✓</Text>}
            </View>
            <Text style={styles.checkboxLabel}>
              Custom/homemade disc - don&apos;t autocorrect spelling
            </Text>
          </TouchableOpacity>
          {error && <Text style={styles.error}>{error}</Text>}
          <TouchableOpacity
            style={styles.button}
            onPress={handleTitleSearch}
            disabled={titleSearching || !titleSearchQuery.trim()}
          >
            <Text style={styles.buttonText}>{titleSearching ? "Searching..." : "Search"}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={handleSkipTitleSearch} disabled={titleSearching}>
            <Text style={styles.link}>Skip - enter manually instead</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={handleDiscard} disabled={submitting || titleSearching}>
            <Text style={styles.link}>
              {scan.barcode ? "This was a stray scan - discard it" : "Discard this entry"}
            </Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
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
          <TextInput
            ref={manualTitleInputRef}
            style={styles.input}
            value={manualTitle}
            onChangeText={setManualTitle}
            onFocus={() => scrollInputRefIntoView(manualTitleInputRef)}
            placeholder="Title"
            placeholderTextColor="#71717a"
          />
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
          ref={releaseNameInputRef}
          style={styles.input}
          value={releaseName}
          onChangeText={setReleaseName}
          onFocus={() => scrollInputRefIntoView(releaseNameInputRef)}
          editable={!releaseNameMatchesTitle}
          placeholder="e.g. Gladiator Special Edition"
          placeholderTextColor="#71717a"
        />
      </View>
      <View style={styles.section}>
        <Text style={styles.label}>Release Variant Note (optional)</Text>
        <TextInput
          ref={releaseVariantNoteInputRef}
          style={styles.input}
          value={releaseVariantNote}
          onChangeText={setReleaseVariantNote}
          onFocus={() => scrollInputRefIntoView(releaseVariantNoteInputRef)}
          placeholder="e.g. numbered slipcover, first pressing"
          placeholderTextColor="#71717a"
        />
      </View>

      <View style={styles.section}>
        <Text style={styles.label}>Format</Text>
        <AutocompleteInput
          value={format}
          onChangeText={setFormat}
          options={fieldOptions?.format ?? []}
          onFocusScroll={scrollFieldIntoView}
        />
      </View>
      <View style={styles.section}>
        <Text style={styles.label}>Disc Count</Text>
        <TextInput
          ref={discCountInputRef}
          style={styles.input}
          value={discCount}
          onChangeText={setDiscCount}
          onFocus={() => scrollInputRefIntoView(discCountInputRef)}
          keyboardType="number-pad"
        />
      </View>
      <View style={styles.section}>
        <Text style={styles.label}>Disk Region</Text>
        <MultiSelectChips
          options={diskRegionOptions}
          selected={diskRegions}
          onChange={setDiskRegions}
          exclusiveOptions={["All", NOT_LISTED_REGION]}
        />
      </View>
      <View style={styles.section}>
        <Text style={styles.label}>Genre Location (shelf section)</Text>
        <AutocompleteInput
          value={genreLocation}
          onChangeText={setGenreLocation}
          options={fieldOptions?.genreLocation ?? []}
          placeholder="e.g. Action, History Documentary"
          onFocusScroll={scrollFieldIntoView}
        />
      </View>
      {isHistoryDocumentary && (
        <View style={styles.section}>
          <Text style={styles.label}>Depicted Era (worded, e.g. &quot;Spanish Civil War&quot;)</Text>
          <TextInput
            ref={depictedEraLabelInputRef}
            style={styles.input}
            value={depictedEraLabel}
            onChangeText={setDepictedEraLabel}
            onFocus={() => scrollInputRefIntoView(depictedEraLabelInputRef)}
            placeholder="e.g. Spanish Civil War, 1980s"
            placeholderTextColor="#71717a"
          />
        </View>
      )}
      <View style={styles.section}>
        <Text style={styles.label}>
          Franchise{singleSelectedImdbId && !franchise ? " (no series match on Wikidata)" : ""}
        </Text>
        <AutocompleteInput
          value={franchise}
          onChangeText={setFranchise}
          options={fieldOptions?.franchise ?? []}
          placeholder="e.g. Casper, Alien, X-Men"
          onFocusScroll={scrollFieldIntoView}
        />
      </View>
      {singleSelectedImdbId && tmdbPreviewLoading && (
        <Text style={styles.hint}>Checking TMDb for Animation/Live Action...</Text>
      )}
      {singleSelectedImdbId && !tmdbPreviewLoading && !showAnimationField && (
        <Text style={styles.hint}>Confirmed Live Action on TMDb.</Text>
      )}
      {showAnimationField && (
        <View style={styles.section}>
          <Text style={styles.label}>
            Animation / Live Action
            {singleSelectedImdbId && tmdbPreview?.isAnimated === true ? " (TMDb: Animation - pick a style)" : ""}
          </Text>
          <AutocompleteInput
            value={animationOrLiveAction}
            onChangeText={setAnimationOrLiveAction}
            options={animationOptions}
            placeholder="e.g. 2D Animation, 3D Animation, Claymation"
            onFocusScroll={scrollFieldIntoView}
          />
        </View>
      )}
      {showTmdbOverrideField && (
        <View style={styles.section}>
          <Text style={styles.label}>TMDb Link or ID (required - TMDb had no automatic match)</Text>
          <TextInput
            ref={tmdbIdOverrideInputRef}
            style={styles.input}
            value={tmdbIdOverride}
            onChangeText={setTmdbIdOverride}
            onFocus={() => scrollInputRefIntoView(tmdbIdOverrideInputRef)}
            placeholder="e.g. https://www.themoviedb.org/movie/12345"
            placeholderTextColor="#71717a"
            autoCapitalize="none"
          />
          <Text style={styles.hint}>
            Every scanned title needs a real TMDb match so ratings, cast, posters and everything
            else can be filled in automatically later - search themoviedb.org for this title and
            paste its link here.
          </Text>
        </View>
      )}
      {isMultiTitleCollection ? (
        <Text style={styles.hint}>
          Rating and Studio aren&apos;t set here for a multi-title collection - the box's
          own cover rating isn&apos;t necessarily any single film's, so each title gets its
          own from TMDb instead once confirmed.
        </Text>
      ) : (
        <>
          {singleSelectedImdbId && tmdbPreviewLoading && (
            <Text style={styles.hint}>Checking TMDb for Rating/Studio...</Text>
          )}
          {singleSelectedImdbId && !tmdbPreviewLoading && !showRatingField && !showStudioField && (
            <Text style={styles.hint}>Rating and Studio will be filled in from TMDb.</Text>
          )}
          {showRatingField && (
            <View style={styles.section}>
              <Text style={styles.label}>
                Rating{singleSelectedImdbId ? " (not on TMDb - from the case)" : " (from the case)"}
              </Text>
              <AutocompleteInput
                value={rating}
                onChangeText={setRating}
                options={fieldOptions?.rating ?? []}
                placeholder="e.g. G, PG, M, R13"
                onFocusScroll={scrollFieldIntoView}
              />
            </View>
          )}
          {showStudioField && (
            <View style={styles.section}>
              <Text style={styles.label}>Studio{singleSelectedImdbId ? " (not on TMDb)" : ""}</Text>
              <AutocompleteInput
                value={studio}
                onChangeText={setStudio}
                options={fieldOptions?.studio ?? []}
                onFocusScroll={scrollFieldIntoView}
              />
            </View>
          )}
        </>
      )}
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
              ref={specialFeaturesDiscCountInputRef}
              style={styles.input}
              value={specialFeaturesDiscCount}
              onChangeText={setSpecialFeaturesDiscCount}
              onFocus={() => scrollInputRefIntoView(specialFeaturesDiscCountInputRef)}
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
              onFocusScroll={scrollFieldIntoView}
            />
          </View>
        </>
      )}
      <TouchableOpacity style={styles.checkboxRow} onPress={() => setWatchedDisc((prev) => !prev)}>
        <View style={[styles.checkbox, watchedDisc && styles.checkboxChecked]}>
          {watchedDisc && <Text style={styles.checkboxMark}>✓</Text>}
        </View>
        <Text style={styles.checkboxLabel}>Watched this disc</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.checkboxRow} onPress={() => setWatched((prev) => !prev)}>
        <View style={[styles.checkbox, watched && styles.checkboxChecked]}>
          {watched && <Text style={styles.checkboxMark}>✓</Text>}
        </View>
        <Text style={styles.checkboxLabel}>Watched this title (any format - e.g. seen it elsewhere before this scan)</Text>
      </TouchableOpacity>
      <View style={styles.section}>
        <Text style={styles.label}>Disc Condition</Text>
        <AutocompleteInput
          value={discCondition}
          onChangeText={setDiscCondition}
          options={[...DISC_CONDITION_VALUES]}
          onFocusScroll={scrollFieldIntoView}
        />
      </View>
      <View style={styles.section}>
        <Text style={styles.label}>Case Notes (optional)</Text>
        <TextInput
          ref={caseNotesInputRef}
          style={styles.input}
          value={caseNotes}
          onChangeText={setCaseNotes}
          onFocus={() => scrollInputRefIntoView(caseNotesInputRef)}
          placeholder="e.g. blank case, wrong disc inside"
          placeholderTextColor="#71717a"
        />
      </View>

      {showTvFields && <Text style={styles.hint}>TV-specific fields (season/episode) can be refined later via Direct Database Access.</Text>}

      {error && <Text style={styles.error}>{error}</Text>}

      <TouchableOpacity
        style={styles.button}
        onPress={handleConfirmPressed}
        disabled={submitting || checkingExisting || (showTmdbOverrideField && !tmdbIdOverride.trim())}
      >
        <Text style={styles.buttonText}>
          {checkingExisting ? "Checking your collection..." : submitting ? "Saving..." : "Confirm"}
        </Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={handleDiscard} disabled={submitting || checkingExisting}>
        <Text style={styles.link}>This was a stray scan - discard it</Text>
      </TouchableOpacity>
        </>
      )}
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
