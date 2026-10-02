import { useEffect, useRef, useState } from "react";
import {
  Alert,
  FlatList,
  findNodeHandle,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
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
import DateTimePicker from "@react-native-community/datetimepicker";
import {
  cleanProductTitleForSearch,
  DISC_CONDITION_VALUES,
  extractDiskRegionHint,
  extractFormatHint,
  extractImdbIdFromPage,
  getDiskRegionOptions,
  isRegionFreeFormat,
  looksLikeExtraContent,
  looksLikeNonMediaCategory,
  normalizeTitleForMatch,
  NOT_LISTED_REGION,
  resolveDiskRegionText,
  splitCutVariantTitle,
} from "@danflix/shared";
import {
  confirmScan,
  discardScan,
  findExistingTitle,
  getCroppedImageSource,
  getStagedCoverImageSource,
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
import { getIsOnline } from "../lib/network";
import { queueSubmissionOffline } from "../lib/offlineQueue";
import { getSubmissionError, startBackgroundSubmission } from "../lib/backgroundSubmissions";
import SearchableModalInput from "../components/SearchableModalInput";
import TagSearchableModalInput from "../components/TagSearchableModalInput";
import IndeterminateBar from "../components/IndeterminateBar";
import ProgressBar from "../components/ProgressBar";
import SlideFlow from "../components/SlideFlow";
import BigChoice from "../components/BigChoice";
import SummaryRow from "../components/SummaryRow";
import FranchiseEditor from "../components/FranchiseEditor";
import { autoMatchTitlesFromName, isGenericCollectionName, nameListsAllTitles } from "../lib/collectionName";
import MultiSelectChips from "../components/MultiSelectChips";
import SingleSelectChips from "../components/SingleSelectChips";
import SelectDropdown from "../components/SelectDropdown";
import OfflineBanner from "../components/OfflineBanner";
import TitleSearchPicker, { type CollectionMember } from "../components/TitleSearchPicker";
import type { PendingScan } from "./PendingScansScreen";

interface OmdbCandidate {
  Title: string;
  Year: string;
  imdbID: string;
  Type: string;
  Poster: string;
  // Only populated server-side when this candidate shared an identical title+year with
  // another candidate in the same list - see packages/backend/src/scanResolver.ts's
  // enrichAndNarrowCandidates. Shown next to Year as a physical, human-checkable
  // distinguisher for cases cast/year/poster can't tell apart at all.
  Runtime?: string;
  // Only populated for a classic-era Doctor Who serial resolved via matchClassicWhoSerial
  // (packages/backend/src/classicWhoSerials.ts) - see guessMovieOrTvFromType below and the
  // season/episode-count/Animation prefill effect near singleSelectedImdbId.
  classicWhoSerial?: { season: number; episodeCount: number; missingEpisodeCount: number };
}

interface PosterMatch {
  bestImdbId: string | null;
  distances: Record<string, number>;
  confident: boolean;
}

type MatchCheck = Extract<FindExistingResult, { status: "auto" | "ambiguous" }>;

/** Parses/formats a plain "YYYY-MM-DD" date string entirely in local calendar terms (no
 * UTC round-trip) - `new Date("2026-02-01")`/`.toISOString()` both operate in UTC, which can
 * silently shift the displayed calendar day by one depending on the device's timezone. Used
 * by the Date Rented picker below, the one date field on this screen backed by a real native
 * date picker rather than free text. */
function parseDateOnly(value: string): Date {
  const [y, m, d] = value.split("-").map(Number);
  const now = new Date();
  return new Date(y || now.getFullYear(), (m || 1) - 1, d || 1);
}
/** Strips everything but digits as the user types - `keyboardType="number-pad"` only changes
 * which on-screen keyboard is shown, it doesn't stop a decimal point, minus sign, or pasted/
 * autocorrected text from landing in the field, so a disc count field could otherwise show
 * "2.5" or "1-2" while being edited even though parseInt() at submit time would silently
 * truncate/reject it anyway. Digits-only here keeps what's on screen honest, not just what
 * eventually gets saved. */
function digitsOnly(value: string): string {
  return value.replace(/[^0-9]/g, "");
}

/** Parses a CollectionMember's comma-separated disc-number field (discNumbers or
 * specialFeaturesDiscNumbers, e.g. "1,3") into real numbers - same parse used inline in
 * TitleSearchPicker.tsx's own state seeding, pulled out here as a named helper since
 * discFormatLookup below needs it twice. */
function parseDiscNumberList(value: string | undefined): number[] {
  return (value ?? "")
    .split(",")
    .map((n) => parseInt(n.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/** One-time migration for a draft saved before the 2026-09-27 "a special features disc
 * that's also the movie's own disc doesn't count as a separate disc" fix
 * (TitleSearchPicker.tsx's handleAddPressed) - that fix only runs when a member is actively
 * added/edited, so an already-saved, not-yet-submitted collection draft (confirmDrafts.ts,
 * on-device AsyncStorage) can still carry the old, unfiltered specialFeaturesDiscCount/
 * Format/Numbers. Applied once, right where `collectionMembers` loads from the draft, so
 * reopening any existing in-progress Collection scan (the user's own real Universal Monsters
 * box set, mid-scan when this shipped) self-corrects with no manual re-editing needed -
 * every future add/edit is already correct at the source and never needs this. Recomputes
 * from scratch (own discNumbers vs. specialFeaturesDiscNumbers) rather than just checking
 * "any overlap at all", so a member with a genuine MIX of shared and distinct discs keeps
 * only the distinct ones, exactly like handleAddPressed's own filter does. Returns the same
 * object reference untouched when nothing needs fixing, so this can't cause a spurious
 * re-render for the (typical) case of a draft that never needed correcting in the first
 * place. */
function sanitizeSpecialFeaturesDiscOverlap(member: CollectionMember): CollectionMember {
  const rawSpecialFeaturesDiscs = parseDiscNumberList(member.specialFeaturesDiscNumbers);
  if (rawSpecialFeaturesDiscs.length === 0) return member;
  const ownDiscs = new Set(parseDiscNumberList(member.discNumbers));
  const distinct = rawSpecialFeaturesDiscs.filter((d) => !ownDiscs.has(d));
  if (distinct.length === rawSpecialFeaturesDiscs.length) return member;
  return {
    ...member,
    specialFeaturesDiscCount: distinct.length > 0 ? String(distinct.length) : undefined,
    specialFeaturesDiscNumbers: distinct.length > 0 ? distinct.join(",") : undefined,
    specialFeaturesDiscFormat: distinct.length > 0 ? member.specialFeaturesDiscFormat : undefined,
  };
}

/** What a case's own format banner listing more than one disc format implies for the disc-
 * count/special-features fields - added 2026-09-18 per the user's own real-world experience
 * with multi-disc banners ("4K UHD + BLU-RAY" = 2 discs, one of them a Blu-ray special-
 * features disc; "+ BONUS DISC" on top of that = a second special-features disc). Kept as
 * plain, editable app code rather than folded into the vision prompt (see formatVision.ts's
 * own header comment) - `extraDiscs` only ever says how MANY extra items the banner lists,
 * never what an unlabeled "Bonus Disc" itself is, so that assumption lives here where it's
 * visible and easy to correct or extend:
 * - alongside a 4K UHD primary disc, the user has only ever seen a Blu-ray bonus disc
 * - alongside a plain Blu-ray primary disc, the user has only ever seen a DVD bonus disc
 * Returns null for every field when there's nothing to derive (extraDiscs is "NONE", or the
 * primary format isn't one either combination is known for) - the ordinary case for the vast
 * majority of scans, which touches none of these fields differently than they already work. */
function deriveDiscConfigFromExtraDiscs(
  primaryFormat: string,
  extraDiscs: "NONE" | "ONE_EXTRA" | "TWO_EXTRA" | undefined
): { discCount: number; specialFeaturesDiscCount: number; specialFeaturesDiscFormat: string } | null {
  if (!extraDiscs || extraDiscs === "NONE") return null;

  const bonusDiscFormat = primaryFormat === "4K UHD Blu-Ray" ? "Blu-Ray" : primaryFormat === "Blu-Ray" ? "DVD" : null;
  if (!bonusDiscFormat) return null;

  const specialFeaturesDiscCount = extraDiscs === "TWO_EXTRA" ? 2 : 1;
  return { discCount: 1 + specialFeaturesDiscCount, specialFeaturesDiscCount, specialFeaturesDiscFormat: bonusDiscFormat };
}
// movie_or_tv values where Season No./Part of a Season No./Episode Count are actually
// meaningful (see Claude/RESOURCES.md's "TV field semantics refined 2026-09-18" note) -
// real collection data confirms "TV Movie" essentially never has a season_no set (it behaves
// like an ordinary movie for these fields), so it's deliberately excluded here alongside
// Movie/Documentary/Short/etc. "Serial" (added 2026-09-18) is a classic theatrical chapter-
// play (Republic/Columbia/Universal-style) - always season_no "1", with an episode_count
// counted the same way TV Series counts it (episodes/chapters on this specific disc).
const SEASON_FIELDS_MOVIE_OR_TV_VALUES = new Set(["TV Series", "TV Mini-Series", "TV Special", "TV Episode", "Serial"]);

/** Best-guess movie_or_tv from an OMDB Type before the user has had a chance to correct it -
 * OMDB's own Type (movie/series/episode) can't distinguish TV Series from TV Mini-Series/TV
 * Special/TV Movie, so this is deliberately coarse; the SelectInput chips are always visible
 * and editable specifically because this guess will often need correcting (see barcode-
 * review-screen-fields.md's TV Scanning section - IMDb's own finer classification isn't
 * reachable, its robots.txt disallows scraping title pages). `classicWhoSerial` (only ever
 * set for a candidate resolved via matchClassicWhoSerial) overrides the generic Type-based
 * guess to "TV Series" - a classic Doctor Who serial is "a selection of TV episodes", per the
 * user's own words, not a single one, so the ordinary "episode"-Type -> "TV Episode" guess is
 * wrong specifically for this one show's classic era. */
function guessMovieOrTvFromType(type: string | undefined, isClassicWhoSerial: boolean): string {
  if (isClassicWhoSerial) return "TV Series";
  if (type === "series") return "TV Series";
  if (type === "episode") return "TV Episode";
  return "Movie";
}

/** Genre Location filtering by media type (added 2026-09-20) - the user started prefixing
 * shelf-location names to disambiguate two physically separate sections that happen to share
 * a genre name (e.g. a movie "Sci-Fi" shelf and a completely different TV "Sci-Fi" shelf):
 * "TV " in front of every TV-only location, "COLLECTION " in front of every collection-only
 * location (e.g. "COLLECTION Person" - box sets grouped by the actor/director they're about),
 * and no prefix at all for a plain movie location. Filtering the dropdown to only the
 * locations that actually apply to what's currently being catalogued means a movie scan never
 * has to scroll past TV/Collection shelves (and vice versa) to find its own. Existing values
 * predating this convention have no prefix either, so they fall into the "movie" bucket by
 * default - genuinely correct for the vast majority of the real collection, which is movies.
 *
 * **"BOX COLLECTION " added (2026-09-20, later)** - the user physically stores big, dedicated
 * box sets (e.g. the Alfred Hitchcock 4K Classics) in a separate area of the room from smaller
 * single-case multi-movie sets (e.g. a 2-movies-on-one-disc Abbott and Costello release), each
 * with their own "Person" (and presumably other) sub-categories - "BOX COLLECTION Person" and
 * plain "COLLECTION Person" are therefore two genuinely different real shelf sections, not a
 * spelling variant of each other. Both are collection-only prefixes for filtering purposes. */
function filterGenreLocationOptions(options: string[], isCollectionEntry: boolean, movieOrTvValue: string): string[] {
  if (isCollectionEntry) return options.filter((o) => o.startsWith("COLLECTION ") || o.startsWith("BOX COLLECTION "));
  const isTv = movieOrTvValue.startsWith("TV ");
  return options.filter(
    (o) => (isTv ? o.startsWith("TV ") : !o.startsWith("TV ") && !o.startsWith("COLLECTION ") && !o.startsWith("BOX COLLECTION "))
  );
}

// Hand-mapped synonyms between this collection's own genre_location words and TMDb's genre
// vocabulary (TMDb doesn't use OMDB's exact wording for everything - e.g. "Science Fiction"
// rather than "Sci-Fi") - only needed for the words where a direct case-insensitive match
// against TMDb's own genre list isn't enough. Every other genre_location word (Horror,
// Family, Western, Comedy, ...) already matches TMDb's own identical spelling with no
// mapping needed at all. Keyed by the bare genre_location word (lowercased, any TV /
// COLLECTION / BOX prefix already stripped) -> TMDb genre words (lowercased) that should
// count as a real match for it. Add to this, not a whole new matching scheme, for any future
// genre_location word TMDb has no identically-spelled genre for.
const GENRE_LOCATION_SYNONYMS: Record<string, string[]> = {
  "sci-fi": ["science fiction"],
  musical: ["music"],
  biography: ["history", "documentary"],
  monster: ["horror"],
  superhero: ["action", "adventure", "fantasy", "science fiction"],
};

function genreLocationMatchScore(option: string, genreSignalLower: string[]): number {
  const bare = option.replace(/^(TV |BOX COLLECTION |COLLECTION |BOX TV )/, "").toLowerCase();
  if (genreSignalLower.includes(bare)) return 2;
  if (GENRE_LOCATION_SYNONYMS[bare]?.some((syn) => genreSignalLower.includes(syn))) return 1;
  return 0;
}

/** Caps the big tappable Genre Location buttons at `maxButtons` (added 2026-10-02, per the
 * user's own instruction: with this collection's real genre_location list already past a
 * dozen entries and only growing, showing every single one as its own button was "becoming
 * too numerous"). Ranks by how well each option's own bare genre word matches `genreSignal`
 * (see genreSignalForLocationRanking's own comment for where that comes from) and keeps only
 * the top `maxButtons`; every option NOT shown as a button stays fully reachable through the
 * "Not listed? Type a new one here" SearchableModalInput right below the buttons at both call
 * sites, which always gets the full, unranked list - this function only ever trims the
 * big-button row, never what the user can actually search, select, or type as a new entry. A
 * stable sort (explicit index tie-break, not just relying on the engine's own sort stability)
 * means that with no genre signal at all (e.g. a fully-manual entry with no Genre typed in
 * yet), every option scores 0 and the first `maxButtons` come back in their original
 * (alphabetical) order - a sane, boring default rather than an arbitrary reshuffle. */
function rankGenreLocationOptions(options: string[], genreSignal: string[], maxButtons: number): string[] {
  const genreSignalLower = genreSignal.map((g) => g.toLowerCase());
  return options
    .map((option, index) => ({ option, index, score: genreLocationMatchScore(option, genreSignalLower) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, maxButtons)
    .map((o) => o.option);
}

function formatDateOnly(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

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
  /** Called the moment a save is handed off to the background (backgroundSubmissions.ts),
   * not once it finishes - SuccessScreen tracks the outcome by `submissionId`. */
  onConfirmed: (result: { submissionId: string }) => void;
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
   * TextInput needs measuring anyway, unlike SearchableModalInput which opens its own modal). */
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
  const collectionDiscCountInputRef = useRef<TextInput>(null);
  const specialFeaturesDiscCountInputRef = useRef<TextInput>(null);
  const releaseVariantNoteInputRef = useRef<TextInput>(null);
  const caseNotesInputRef = useRef<TextInput>(null);
  const depictedEraLabelInputRef = useRef<TextInput>(null);
  const tmdbIdOverrideInputRef = useRef<TextInput>(null);
  const runningTimeMinsInputRef = useRef<TextInput>(null);
  const directorInputRef = useRef<TextInput>(null);

  // Auto-detected from either the UPC listing's own title text OR a scanned cover photo's own
  // printed title (packages/shared/src/omdb.ts's looksLikeCollection, packages/backend/src/
  // scanResolver.ts's coverLooksLikeCollection - added 2026-09-30) - only ever used to seed
  // isCollectionOverride below, never read directly again, since the keyword heuristic can
  // misfire both ways (a non-collection title whose own name happens to contain "Trilogy"; a
  // real box set whose listing/cover text uses none of the trigger words) and the user needs to
  // be able to correct either mistake.
  const autoDetectedCollection = Boolean(scan.resolved_candidates?.isCollection);
  const upcProduct = scan.resolved_candidates?.upcProduct;
  // Added 2026-09-19: UPCitemdb's own crowdsourced category string, checked for whether this
  // barcode looks like it belongs to something other than physical media at all (e.g. a food
  // item's barcode scanned by accident). Deliberately a warning, not a hard block -
  // UPCitemdb's category data is genuinely unreliable for DVDs (verified live: a real Blade
  // Runner DVD from this collection came back filed under "Electronics > ... > DVD & Blu-ray
  // Players", not "Movies" - looksLikeNonMediaCategory already accounts for that specific
  // case, but the category taxonomy is inconsistent enough that a hard block risks losing a
  // real, correct scan). The user decides whether to proceed.
  const categoryWarning = looksLikeNonMediaCategory(upcProduct?.category) ? upcProduct?.category ?? null : null;
  // Real product photos vary in shape (portrait cover art, a square CDN canvas, etc.) - a
  // single guessed fixed ratio was tried twice (a fixed pixel height, then a hardcoded 2:3
  // "typical disc cover" ratio) and both still letterboxed some real photos, just on
  // different sides each time (grey bars on the left/right, then on top/bottom once 2:3
  // didn't match this particular photo's real shape either). Reading the image's own actual
  // dimensions via `Image.getSize` and sizing the box to match exactly - added 2026-09-18 -
  // is the only approach that can't be wrong for a given photo, since it isn't a guess at
  // all. Falls back to 2:3 only until the real size loads (or if it fails to load at all),
  // same as before.
  const [scannedImageAspectRatio, setScannedImageAspectRatio] = useState(2 / 3);
  // Sized against the CROPPED preview's own real dimensions (2026-09-22), not the raw source
  // image's - cropping changes the aspect ratio (the whole point of it), so measuring the
  // original would size this box wrong and letterbox the cropped photo inside it.
  // `getSizeWithHeaders` (not plain `getSize`) since the preview URL is secret-gated, same as
  // every other scan route.
  //
  // Front cover photo first, UPC listing photo second (added 2026-10-03) - a real "Pumping
  // Iron" scan left an empty box here: its UPC listing's only image was Alibris's generic
  // `no_image.gif` (a dead link), while the front cover the user photographed in the same
  // session was never shown at all - even though that photo is exactly what Confirm saves as
  // the case image (confirm/route.ts's front-cover promotion always wins over the listing
  // photo), so it's the truer preview anyway. Same front-pick rule as the backend's
  // pickFrontCoverPath (coverVision.ts). Each source that fails to load is skipped in turn,
  // and the whole section hides if none load, rather than leaving a blank box behind.
  const stagedCoverAnalyses = scan.resolved_candidates?.coverAnalysis ?? [];
  const unclearCovers = stagedCoverAnalyses.filter((a) => a.analysis.side === "unclear");
  const frontCoverStagedPath =
    stagedCoverAnalyses.find((a) => a.analysis.side === "front")?.stagedPath ??
    (unclearCovers.length === 1 ? unclearCovers[0].stagedPath : null);
  const scannedImageSources = [
    ...(frontCoverStagedPath ? [{ ...getStagedCoverImageSource(frontCoverStagedPath), isCoverPhoto: true }] : []),
    ...(upcProduct?.imageUrl ? [{ ...getCroppedImageSource(upcProduct.imageUrl), isCoverPhoto: false }] : []),
  ];
  const [scannedImageSourceIndex, setScannedImageSourceIndex] = useState(0);
  const scannedImageSource = scannedImageSources[scannedImageSourceIndex] ?? null;
  useEffect(() => {
    if (!scannedImageSource) return;
    Image.getSizeWithHeaders(
      scannedImageSource.uri,
      scannedImageSource.headers,
      (width, height) => {
        if (width > 0 && height > 0) setScannedImageAspectRatio(width / height);
      },
      () => {
        // Leave the 2:3 fallback in place - a failed size lookup shouldn't block the image
        // from rendering at all, just means it might letterbox slightly this one time.
      }
    );
  }, [scannedImageSource?.uri]);
  // Splits a barcode title like "Blade Runner the Final Cut" into the film's own base title
  // ("Blade Runner") and the full verbatim cleaned title ("Blade Runner the Final Cut") -
  // added 2026-09-17 so a disc's specific cut/edition (already correctly kept OUT of the
  // OMDB/TMDb search itself, see scanResolver.ts) doesn't just get silently dropped from the
  // UI either. `releaseTitle` is null for the ordinary case (no cut/edition named at all), in
  // which case this is a no-op everywhere it's used below.
  const upcCutVariant = upcProduct?.title
    ? splitCutVariantTitle(cleanProductTitleForSearch(upcProduct.title))
    : null;
  const posterMatch = (scan.resolved_candidates as { posterMatch?: PosterMatch | null })
    ?.posterMatch;
  // This barcode already belongs to a cataloged entry - a rescan of a disc already in the
  // collection. The resolver still runs the normal UPC/OMDB pipeline above so this screen
  // has real candidate/poster data, and Confirm skips straight to the Overwrite/Is-a-new-
  // entry/Reject choice below instead of running the ordinary title-text similar-entry
  // check - we already know the match with certainty (same physical barcode), not just a
  // similar title.
  //
  // PREFILL ONLY FROM AN UNSUBMITTED DRAFT, NEVER FROM existingMatch (2026-09-24): every
  // detail field below used to also pre-fill from this entry's current stored values (e.g.
  // "backfill the newer physical-only fields onto it" without retyping the rest), but real
  // use showed this backfires for the opposite, equally common case: rescanning specifically
  // to FIX a wrong or incomplete field (the user's own report: "even when I rescan the same
  // barcode to fix it it shows up with all the old details"). Since existingMatch is always
  // an already-CONFIRMED, permanent titles row - not "pending" in any sense - its stale
  // values just kept resurfacing no matter how many times the scan was discarded and
  // retried, because discarding only ever deletes the pending_scans row, never the
  // underlying confirmed entry that existingMatch keeps being found from. The user's own
  // fix: "remove the prefill data if the entry has been submitted, but keep it if
  // unsubmitted." So every field below now prefills from `draft` (an unsubmitted,
  // still-in-progress local autosave - confirmDrafts.ts) or a fresh guess (TMDb, the UPC
  // listing text, the vision model, ...) only - never from existingMatch. existingMatch
  // itself is still used for identification (the synthesized candidate/auto-selected
  // imdbId below, so Overwrite still has a certain target and no re-search is ever needed)
  // and for the "already matches" banner/choice - only the EDITABLE DETAIL FIELDS stopped
  // being pre-filled from it.
  const existingMatch = scan.resolved_candidates?.existingMatch ?? null;
  // No separate imdb_id column any more (0019_drop_imdb_id.sql) - recovered from imdb_page
  // instead, which already contains it.
  const existingMatchImdbId = extractImdbIdFromPage(existingMatch?.imdb_page);
  const draft = getConfirmDraft(scan.id);
  // Collection scanning flow (added 2026-09-20) - declared this early (rather than alongside
  // the rest of this flow's state further down) because needsTitleSearch below has to read it:
  // unchecking this toggle after an auto-detected collection (a real UPC listing that looked
  // like a box set) must fall back to the ordinary manual title-search box even though a UPC
  // listing did exist, which needsTitleSearch's own condition otherwise treats as "nothing to
  // search for" - see Claude/TECH STACK AND ARCHITECTURE/barcode-scanning-pipeline.md.
  const [isCollectionOverride, setIsCollectionOverride] = useState(
    draft?.isCollectionOverride ?? autoDetectedCollection
  );
  // OMDB candidates, either from the automatic resolver (a real UPC listing gave it a
  // title to search with) or from the manual title-search step below (the barcode came
  // back with no usable product data at all, so there was nothing to search with until
  // the user typed a title) - state rather than a derived const so a manual search's
  // results can populate it and hand off to all the same selection/poster/TMDb-preview
  // machinery below, unchanged.
  const [candidates, setCandidates] = useState<OmdbCandidate[]>(() => {
    const freshCandidates = (scan.resolved_candidates?.omdbCandidates ?? []) as OmdbCandidate[];
    // An empty draft must never permanently mask candidates the resolver has since found -
    // the same class of bug the existingMatch synthesis below already had to work around (a
    // draft saved before resolution finished can outlive whatever fix comes later). This
    // happens for real: opening a cover-only scan's review before its 15s/5min auto-resolve
    // has run yet finds zero candidates, and the draft-autosave effect further down persists
    // that empty list immediately - reopening the same scan after it resolves would otherwise
    // show that stale empty list (and the manual "Enter film name" search box) forever, even
    // though the server now has real matches. An empty draft carries no real user selection
    // worth preserving, so non-empty fresh server data always wins over it; a draft that does
    // hold real candidates (from a manual search, or a resolved list seen on an earlier open)
    // is left alone, same as before.
    const base = draft?.candidates && draft.candidates.length > 0 ? draft.candidates : freshCandidates;
    // An exact-barcode match already tells us the real film with certainty - if the fresh
    // OMDB search this scan ran (or the UPC lookup that feeds it) didn't happen to surface
    // that same imdb_id as a candidate, synthesize one from the entry's own stored data so
    // every downstream step (auto-selection, the TMDb preview, and critically the imdbId
    // that Confirm sends) still works exactly as if OMDB had found it - without this, a
    // rescan with no fresh OMDB match would submit with no imdbId at all, and "Overwrite"
    // would then blank out the entry's already-set tmdb_id/imdb_id. Deliberately NOT gated
    // on "no draft exists yet" - confirmDrafts.ts is an in-memory cache that outlives a code
    // fix (Fast Refresh preserves it), so a draft saved before this synthesis existed (e.g.
    // from hitting an earlier bug on this same scan) must not be allowed to keep permanently
    // suppressing it. This exact gap caused real data loss once already: Casper's Haunted
    // Christmas and Paper Planes both lost their entire OMDB/TMDB-sourced field set on
    // Overwrite because a stale empty draft from before this fix silently won out.
    if (existingMatch && existingMatchImdbId && !base.some((c) => c.imdbID === existingMatchImdbId)) {
      return [
        {
          Title: existingMatch.title,
          Year: existingMatch.release_date ? existingMatch.release_date.slice(0, 4) : "",
          imdbID: existingMatchImdbId,
          Type:
            existingMatch.movie_or_tv === "TV Series"
              ? "series"
              : existingMatch.movie_or_tv === "TV Episode"
                ? "episode"
                : "movie",
          // `resolvedPosterUrl` (scanResolver.ts's withResolvedPoster, 2026-09-25) - a
          // fresh OMDB poster fetched server-side when this entry has no case_image_url
          // of its own, so the "best match" step isn't left with no image at all.
          Poster: existingMatch.case_image_url ?? existingMatch.resolvedPosterUrl ?? "N/A",
        },
        ...base,
      ];
    }
    return base;
  });
  const autoMatched = posterMatch?.confident ? posterMatch : null;
  const autoMatchedCandidate = autoMatched
    ? candidates.find((c) => c.imdbID === autoMatched.bestImdbId) ?? null
    : null;
  // Only the "barcode gave literally nothing" case needs the title-search step - if a UPC
  // listing came back (even one OMDB couldn't find a match for), the user still has a
  // product photo/description to work from and the ordinary manual-entry form below is
  // enough; there's no title text to search with in that case anyway. An exact-barcode
  // match skips this step outright regardless - the title is already known for certain,
  // asking the user to search for it again would be pointless.
  const [titleSearchQuery, setTitleSearchQuery] = useState(draft?.titleSearchQuery ?? "");
  const [titleSearching, setTitleSearching] = useState(false);
  const [hasSearchedOrSkipped, setHasSearchedOrSkipped] = useState(draft?.hasSearchedOrSkipped ?? false);
  // `!isCollectionOverride` (added 2026-09-20): a real UPC listing that auto-detected as a
  // collection never gets an OMDB search at all (see scanResolver.ts), so `candidates` is
  // always empty for it - if the user then unchecks the collection toggle to correct a false
  // positive, this must still offer the ordinary manual title-search box even though a real
  // UPC listing (`upcProduct`) does exist, rather than silently falling through to the
  // fully-manual single-title form with no search attempted at all.
  const needsTitleSearch =
    candidates.length === 0 &&
    (!upcProduct || (autoDetectedCollection && !isCollectionOverride)) &&
    !hasSearchedOrSkipped &&
    !existingMatch;
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
  // A candidate's own Poster URL can be genuinely present (not "N/A") but still dead - found
  // live 2026-10-01: OMDB returned a real-looking Amazon CDN poster URL for the classic Who
  // serial "The Savages," but the URL itself 404s (image link rot, common for old IMDb/Amazon
  // image links - not something specific to this candidate or to Doctor Who). `<Image>`'s own
  // posterImage style has a dark `#18181b` background with no broken-image fallback UI, so a
  // dead-but-present URL silently rendered as a plain near-black box with no indication
  // anything was wrong. Tracked by imdbID (not per-render) so a failed load is remembered and
  // the "No poster image found" placeholder takes over instead, the same as a genuinely
  // missing "N/A" poster - never retried, since a dead CDN link isn't going to start working
  // moments later.
  const [posterLoadFailed, setPosterLoadFailed] = useState<Set<string>>(new Set());
  function markPosterLoadFailed(imdbId: string) {
    setPosterLoadFailed((prev) => (prev.has(imdbId) ? prev : new Set(prev).add(imdbId)));
  }
  // Collapsed by default - see looksLikeExtraContent (packages/shared/src/omdb.ts) for what
  // lands here (making-of documentaries, special-screening/behind-the-scenes footage that
  // legitimately shares a big film's title in OMDB's search results). Never dropped from the
  // candidate list entirely, just tucked a tap away so it doesn't clutter the main row.
  const [showExtras, setShowExtras] = useState(false);
  // A single candidate (whether the resolver only ever found one, or a manual title search
  // below only turned up one) is auto-selected rather than making the user tap it - nothing
  // to disambiguate when there's only one option. Still fully reversible: tapping it again
  // deselects it like any other candidate.
  const [selected, setSelected] = useState<Set<string>>(() => {
    // The exact-barcode match already tells us the real film with certainty - checked
    // before the draft (unlike every other field below), since a stale draft saved before
    // this match was known (or before this synthesis existed at all) must never be allowed
    // to leave the real film unselected - that's exactly what caused real data loss on a
    // rescan of Casper's Haunted Christmas/Paper Planes: Overwrite submitted with no
    // imdbId at all, which blanked out every OMDB/TMDB-sourced field on both rows.
    if (existingMatchImdbId && candidates.some((c) => c.imdbID === existingMatchImdbId)) {
      return new Set([existingMatchImdbId]);
    }
    if (draft?.selected) return new Set(draft.selected);
    if (autoMatchedCandidate) return new Set([autoMatchedCandidate.imdbID]);
    if (candidates.length === 1) return new Set([candidates[0].imdbID]);
    return new Set();
  });
  // Best-effort starting guesses from the UPC listing text - always editable, never
  // presented as confirmed fact. Packaging/marketing words ("Special Edition") are already
  // stripped by cleanProductTitleForSearch since those never belong in a title per how this
  // collection is catalogued (see Claude/TECH STACK AND ARCHITECTURE.md's Collections note).
  const [manualTitle, setManualTitle] = useState(() => {
    if (draft?.manualTitle) return draft.manualTitle;
    if (upcCutVariant?.baseTitle) return upcCutVariant.baseTitle;
    if (upcProduct?.title) return cleanProductTitleForSearch(upcProduct.title);
    // Cover-photo fallback (added 2026-09-30, found live: a real collection scan with no UPC
    // listing at all - upcLookupFailed - left this blank even though the cover photo had
    // already read the real name, "Gidget Film Collection", perfectly fine). Same
    // front-preferred, else-any precedence as scanResolver.ts's own pickCoverDerivedTitle -
    // never run through cleanProductTitleForSearch, which strips marketplace-listing noise
    // ("[Blu-ray] Free Shipping") a cover-photo read never has in the first place.
    const coverAnalysisForTitle = scan.resolved_candidates?.coverAnalysis ?? [];
    return (
      coverAnalysisForTitle.find((a) => a.analysis.side === "front" && a.analysis.title)?.analysis.title ??
      coverAnalysisForTitle.find((a) => a.analysis.title)?.analysis.title ??
      ""
    );
  });
  const visionFormatGuess = scan.resolved_candidates?.visionFormatGuess ?? null;
  // Only ever non-null when visionFormatGuess itself is - see deriveDiscConfigFromExtraDiscs's
  // own comment for the disc-count/special-features/bonus-disc-format mapping this implies.
  const visionDiscConfig = deriveDiscConfigFromExtraDiscs(visionFormatGuess?.format ?? "", visionFormatGuess?.extraDiscs);
  // LLM listing-text parse (packages/backend/src/listingTextExtract.ts) - only ever populated
  // when the plain regex-cleaned title search found zero OMDB candidates at all (see
  // scanResolver.ts). format/region below fall back to it the same way they already fall back
  // to visionFormatGuess/text hints; the block rendered near the UPC product image (below)
  // shows the raw parse (title/actors/format/region) read-only, for transparency into why a
  // second-attempt search or cast-hint match came out the way it did.
  const listingTextExtraction = scan.resolved_candidates?.listingTextExtraction ?? null;
  // Cover-photo vision reads (packages/backend/src/coverVision.ts) - only ever populated for
  // a cover-only scan (no barcode, so none of visionFormatGuess/listingTextExtraction/
  // upcProduct above exist for it either). One entry per staged photo; takes the first
  // non-null value across all of them for each field, since a value is only ever reported
  // when that specific photo actually had it legible - front vs. back doesn't matter here
  // the way it does for pickFrontCoverPath's case-image choice, since a genuinely legible
  // read is trustworthy regardless of which side happened to show it.
  const coverAnalysis = scan.resolved_candidates?.coverAnalysis ?? [];
  const coverFormatGuess = coverAnalysis.map((a) => a.analysis.format).find((f) => f != null) ?? null;
  const coverDiscCountGuess = coverAnalysis.map((a) => a.analysis.discCount).find((c) => c != null) ?? null;
  const coverRatingGuess = coverAnalysis.map((a) => a.analysis.rating).find((r) => r != null) ?? null;
  // Added 2026-10-01 - a second, independent confirming signal (alongside the missing-episode
  // data match below) for a classic Doctor Who serial's officially-released animated
  // reconstruction, whose cover art looks visibly illustrated/drawn rather than photographic.
  // Only ever acted on for a classic Who match - see the Animation/Live Action prefill effect
  // near singleSelectedImdbId - not a general "drawn cover = animated film" rule, since an
  // ordinary animated film's own TMDb genre already covers that case.
  const coverLooksDrawn = coverAnalysis.some((a) => a.analysis.artStyle === "drawn");
  // Banner-implied extra discs read directly off the user's own cover photo (added
  // 2026-09-29, alongside coverVision.ts's own extraDiscs/specialFeaturesListed fields) -
  // same derivation as visionDiscConfig below, just from a second possible source, since a
  // barcode listing's own stock photo isn't always present or doesn't always show the banner
  // clearly. `deriveDiscConfigFromExtraDiscs` returns null for "NONE" (the default when no
  // analysis reported anything), so this is a no-op whenever there's nothing to derive.
  // extraDiscs defaults to "NONE" (never null - see coverVision.ts), so "first non-null" would
  // just lock onto whichever photo was analyzed first even if a LATER photo is the one that
  // actually shows the banner - find the first one that reported real extras instead.
  const coverExtraDiscsGuess = coverAnalysis.map((a) => a.analysis.extraDiscs).find((e) => e !== "NONE") ?? undefined;
  const coverDiscConfig = deriveDiscConfigFromExtraDiscs(coverFormatGuess ?? "", coverExtraDiscsGuess);
  // A back cover explicitly listing "Special Features"/"Bonus Features" is its own separate
  // signal from a banner-implied bonus disc - the features can just be on the movie's own
  // disc, with no dedicated extra disc at all (see coverVision.ts's own comment).
  const coverSpecialFeaturesListed =
    coverAnalysis.map((a) => a.analysis.specialFeaturesListed).find((s) => s != null) ?? null;
  // Verbatim region text read off either the front or back cover photo (added 2026-09-29,
  // per the user's own correction that region marks aren't front-cover-only) - resolved
  // below via the same resolveDiskRegionText helper the LLM listing-text extraction's own
  // "region" field already goes through.
  const coverRegionGuess = coverAnalysis.map((a) => a.analysis.region).find((r) => r != null) ?? null;
  // A distinct packaging/marketing edition name read off the cover (e.g. "Night Shift
  // Edition") - added 2026-09-29 after the user pointed out a real "Five Nights at Freddy's:
  // Night Shift Edition" case whose edition name went uncaught. This is the first automatic
  // signal release_name has ever had (see its own comment below) - deliberately still just a
  // pre-fill suggestion, never trusted outright, since a misread edition name is easy for the
  // model to get subtly wrong (see releaseNameFromCoverVision below, which flags the review
  // row amber for exactly this reason).
  const coverReleaseNameGuess = coverAnalysis.map((a) => a.analysis.releaseName).find((r) => r != null) ?? null;
  // A saved release_name always includes the film's own base title before the edition wording
  // (per the user's own explicit standing convention, e.g. "Five Nights at Freddy's Night
  // Shift Edition" - matching how every existing release_name in this collection is recorded,
  // like the "Gladiator Special Edition" example in database-design.md), never just the bare
  // edition suffix. coverVision.ts deliberately reports only that suffix (it already reports
  // the base title separately as `title`/coverDerivedTitle in the same call) - composed here
  // as plain app code against `manualTitle` (the title the user is actually confirming)
  // instead of asked of the model, so the prefix can never drift from a subtly different
  // spelling/apostrophe/capitalization the model might otherwise retype into a second field.
  const composedCoverReleaseName = coverReleaseNameGuess ? `${manualTitle} ${coverReleaseNameGuess}`.trim() : null;
  const [format, setFormat] = useState(() => {
    if (draft?.format) return draft.format;
    const hint = upcProduct
      ? extractFormatHint(`${upcProduct.title} ${upcProduct.description ?? ""}`)
      : null;
    // A "DVD" text hint is extractFormatHint's own generic fallback (it only ever returns
    // "DVD" once its 4K/Blu-ray/VHS patterns have all failed to match), not a confirmed
    // signal the way those more specific hints are - found 2026-09-17 against a real barcode
    // listing whose own title text said "...Dvd" despite the actual disc being 4K UHD.
    // scanResolver.ts mirrors this exact same distinction for when it bothers calling the
    // vision model at all (see its own comment) - a specific text hint always wins outright,
    // but "DVD" specifically gets cross-checked against a real product photo when one exists.
    if (hint && hint !== "DVD") return hint;
    return visionFormatGuess?.format ?? listingTextExtraction?.format ?? coverFormatGuess ?? hint ?? "DVD";
  });
  const [discCount, setDiscCount] = useState(
    draft?.discCount ??
      visionDiscConfig?.discCount.toString() ??
      coverDiscConfig?.discCount.toString() ??
      coverDiscCountGuess?.toString() ??
      "1"
  );
  // A fixed small set of codes (see getDiskRegionOptions), not free text - and some discs
  // are coded for more than one region at once (e.g. "2, 4"), so this is a toggleable set
  // rather than a single value (see MultiSelectChips). Auto-filled from the UPC listing's own
  // text when it says (e.g. "[regions 2,5]", "Region A", "Region Free") - added 2026-09-19
  // after a real scan's listing text clearly stated the region but the field was still left
  // for the user to fill in by hand every time. Same draft-only precedence as every other
  // auto-filled field on this screen (see existingMatch's own 2026-09-24 comment above);
  // still fully editable either way.
  //
  // An EMPTY draft must never permanently mask a region guess the resolver has since found -
  // same class of bug `candidates` above already had to work around, found live 2026-09-30: a
  // scan whose cover analysis didn't have a region yet (or was still mid-reprocessing) caches
  // an empty `diskRegions: []` draft the moment the screen is first opened, and since this
  // in-memory draft cache outlives the server later finding/correcting the region, reopening
  // the same scan afterward showed a blank Disk Region forever even once the cover-read region
  // was genuinely available. An empty draft carries no real user selection worth preserving,
  // so non-empty fresh data always wins over it; a draft that holds a real region choice is
  // left alone, same as before.
  const draftDiskRegions = draft?.diskRegions && draft.diskRegions.length > 0 ? draft.diskRegions : undefined;
  const [diskRegions, setDiskRegions] = useState<Set<string>>(
    () =>
      new Set(
        draftDiskRegions ??
          (upcProduct
            ? extractDiskRegionHint(`${upcProduct.title} ${upcProduct.description ?? ""}`, format)
                ?.split(",")
                .map((r) => r.trim())
                .filter(Boolean)
            : null) ??
          // A country/market name in the LLM extraction's own words ("UK", "China") isn't a
          // real region code by itself - resolveDiskRegionText maps it to the actual
          // numeric/letter code that market uses for this format (see formatHints.ts).
          (listingTextExtraction?.region
            ? resolveDiskRegionText(listingTextExtraction.region!, format)
            : null) ??
          // The user's own cover photo (front OR back) showing a region mark that the
          // listing text/LLM extraction above never had a chance to catch at all (no UPC
          // listing, or a listing whose own text just doesn't mention it).
          (coverRegionGuess ? resolveDiskRegionText(coverRegionGuess, format) : null) ??
          []
      )
  );
  const [genreLocation, setGenreLocation] = useState(draft?.genreLocation ?? "");
  // Both exposed here for the first time, per the user's own request after finding
  // Casper's Haunted Christmas silently logged with no Franchise and the wrong Animation/
  // Live Action value - neither field had ever actually been asked for anywhere in the scan
  // form, so every barcode-scanned title got Franchise blank and (see confirm route)
  // Animation/Live Action hardcoded to "Live Action" regardless of truth. Prefilled from
  // TMDb (isAnimated)/Wikidata (franchise) below once a candidate is picked, but always a
  // plain editable field, never hidden - unlike Rating/Studio, neither source is reliable
  // enough to trust blindly (Wikidata's franchise guess in particular was proven wrong on
  // other titles during testing - see Claude/TECH STACK AND ARCHITECTURE.md). Held here as
  // comma-separated text backing a multi-value list (0020_merge_franchise_columns.sql,
  // merged with the former separate Sub-franchise field) - same representation as
  // Genre/Director below, since a film can genuinely belong to several franchises at once
  // at different specificities (e.g. Marvel, Marvel Cinematic Universe, and the Captain
  // Marvel character franchise itself, all at once).
  const [franchise, setFranchise] = useState(draft?.franchise ?? "");
  const [animationOrLiveAction, setAnimationOrLiveAction] = useState(
    draft?.animationOrLiveAction ?? ""
  );
  // Movie/TV type - always visible and editable (unlike Rating/Studio's hidden-until-no-
  // match pattern), since OMDB's own Type field is too coarse to reliably guess the real
  // vocabulary on its own (see guessMovieOrTvFromType above and barcode-review-screen-
  // fields.md's TV Scanning section). Deliberately NOT prefilled from an existingMatch (an
  // already-submitted, confirmed entry) any more - see this file's 2026-09-24 "prefill only
  // from an unsubmitted draft" note near existingMatch's own declaration. The initial guess
  // from the best match candidate is applied reactively below (near singleSelectedImdbId),
  // not here, so it stays correct if the user picks a different candidate after this screen
  // first renders.
  const [movieOrTv, setMovieOrTv] = useState(draft?.movieOrTv ?? "");
  const [seasonNo, setSeasonNo] = useState(draft?.seasonNo ?? "");
  const [partOfSeasonNo, setPartOfSeasonNo] = useState(draft?.partOfSeasonNo ?? "");
  const [episodeCount, setEpisodeCount] = useState(draft?.episodeCount ?? "");
  const showSeasonFields = SEASON_FIELDS_MOVIE_OR_TV_VALUES.has(movieOrTv);
  // Fields added ahead of the full-collection backfill rescan (Claude/TECH STACK AND
  // ARCHITECTURE.md's "Backfill Rescan" section) - captured now because they're only
  // observable from the physical disc/case itself, unlike the metadata-driven fields
  // above, which can be backfilled later via a script keyed on tmdb_id/imdb_id.
  const [releaseVariantNote, setReleaseVariantNote] = useState(draft?.releaseVariantNote ?? "");
  const [discCondition, setDiscCondition] = useState(draft?.discCondition ?? "None");
  const [caseNotes, setCaseNotes] = useState(draft?.caseNotes ?? "");
  // Collection-only: a previous owner put unrelated films in one disc case (2026-09-27) - see
  // buildSharedCollectionFields's own comment for why this flips the Estimated Value
  // pipeline's usual "price the header, skip the members" rule for this one set. Meaningless
  // for a single title, which is never sent through buildSharedCollectionFields at all.
  const [unintentionalCollection, setUnintentionalCollection] = useState(draft?.unintentionalCollection ?? false);
  // `watched` means "seen this film at all, any format" (the broad claim); `watchedDisc`
  // means "watched this specific disc" (the narrow claim) - see 0018_rename_watched_title_
  // to_watched_disc.sql for why this isn't named `watchedTitle` any more.
  const [watched, setWatched] = useState(draft?.watched ?? false);
  const [watchedDisc, setWatchedDisc] = useState(draft?.watchedDisc ?? false);
  const [depictedEraLabel, setDepictedEraLabel] = useState(draft?.depictedEraLabel ?? "");
  // Rental tracking (0021_add_rental_and_language_fields.sql) - a real physical loan can
  // happen to any already-catalogued disc at any time, independent of any scan/rescan event,
  // so this is asked for on every scan the same way Disc Condition/Case Notes are, not gated
  // on any particular candidate/collection state. rentedByWho/dateRented are only meaningful
  // while isCurrentlyRentedOut is true - unticking it clears both below (see the checkbox's
  // onPress), same "hide + clear" precedent as Special Features Disc Count/Format.
  const [isCurrentlyRentedOut, setIsCurrentlyRentedOut] = useState(
    draft?.isCurrentlyRentedOut ?? false
  );
  const [rentedByWho, setRentedByWho] = useState(draft?.rentedByWho ?? "");
  // Plain "YYYY-MM-DD" text, same shape release_date/last_watched_date already use - backed
  // by a real native date picker (below) rather than typed free text.
  const [dateRented, setDateRented] = useState(draft?.dateRented ?? "");
  const [showDateRentedPicker, setShowDateRentedPicker] = useState(false);
  // Auto-filled from TMDb (see showOriginalLanguageField below) - manual entry only shows
  // up as a fallback when TMDb has no match at all, same pattern as Rating/Studio (see
  // barcode-review-screen-fields.md for the full history of this field).
  const [originalLanguage, setOriginalLanguage] = useState(draft?.originalLanguage ?? "");
  // Manual fallback for when TMDb's own /find-by-imdb-id lookup comes up empty - see
  // showTmdbOverrideField below. Only ever needed for a genuine TMDb miss, not shown by
  // default.
  const [tmdbIdOverride, setTmdbIdOverride] = useState(draft?.tmdbIdOverride ?? "");
  // Manual-only detail fields, shown only in the fully-manual path (no OMDB/TMDb candidate
  // at all - selected.size === 0 below) per the user's own request: when a real candidate
  // is selected, these get backfilled automatically later from OMDB/TMDb (see the confirm
  // route's omdbFields fallback), but a title with no match at all - a custom-burned disc,
  // or anything OMDB/TMDb has simply never heard of - would otherwise have no way to ever
  // receive this data, since there's no id for a future refresh job to key off. Genre and
  // Director are comma-separated free text (matching RESOURCES.md's own Sheet convention -
  // "many genres can be listed separated by commas") rather than autocomplete chips, since
  // there's no existing-value list worth suggesting from for either.
  const [genre, setGenre] = useState(draft?.genre ?? "");
  const [runningTimeMins, setRunningTimeMins] = useState(draft?.runningTimeMins ?? "");
  const [director, setDirector] = useState(draft?.director ?? "");
  // Deliberately never auto-filled from OMDB's "Rated" field - that's a US MPAA-style value
  // and often just "Not Rated" even for titles that do carry a real NZ/Oceania classification
  // on the physical case, which is the authoritative source here. `coverRatingGuess` (added
  // 2026-09-29) is exactly that authoritative source read directly - coverVision.ts only ever
  // reports a genuine NZ/OFLC logo it actually saw on the case, never a translated foreign
  // rating (see its own PROMPT) - so pre-filling from it doesn't reintroduce the problem this
  // comment originally guarded against.
  const [rating, setRating] = useState(draft?.rating ?? coverRatingGuess ?? "");
  const [studio, setStudio] = useState(draft?.studio ?? "");
  // Verbatim edition/PACKAGING title (e.g. "Gladiator Special Edition"), distinct from the
  // canonical `title` above - saved as null/"n/a" whenever releaseNameMatchesTitle is
  // checked, regardless of whatever's left in the text field (see Claude/TECH STACK AND
  // ARCHITECTURE.md). Deliberately NOT pre-filled from `upcCutVariant` (a brief 2026-09-17
  // experiment that did prefill it from a detected cut, reverted 2026-09-18 per the user's
  // own explicit clarification): a specific CUT of a film ("the Final Cut," "Director's
  // Cut," ...) gets appended straight onto the catalogued `title` itself instead (see
  // `cutSuffix` sent in the confirm payload below) - release_name is reserved purely for
  // genuine packaging/marketing special editions ("Special Edition," "Collector's Edition,"
  // ...). This field's own original design note said there's "no reliable automatic signal"
  // for this - true of UPC listing text specifically (still no auto-fill from that), but
  // `coverReleaseNameGuess` (added 2026-09-29) reads it directly off the case photo instead,
  // a genuinely different and more reliable source.
  const [releaseName, setReleaseName] = useState(draft?.releaseName ?? composedCoverReleaseName ?? "");
  const [releaseNameMatchesTitle, setReleaseNameMatchesTitle] = useState(
    draft?.releaseNameMatchesTitle ?? !composedCoverReleaseName
  );
  // True only while the field still holds the composed cover-vision guess verbatim and hasn't
  // been unchecked - same "back off the moment it no longer holds the tool's own last
  // suggestion" guard used elsewhere on this screen. Drives the amber "worth a look" highlight
  // on the Release name summary row (SummaryRow's `notable` prop), per the user's own explicit
  // request that a cover-derived release name be flagged for a manual check rather than
  // trusted silently - a vision misread here is a real, disclosed risk (see coverVision.ts).
  const releaseNameFromCoverVision =
    Boolean(composedCoverReleaseName) && !releaseNameMatchesTitle && releaseName === composedCoverReleaseName;
  const [steelbook, setSteelbook] = useState(
    draft?.steelbook ?? visionFormatGuess?.steelbook ?? false
  );
  // A banner-implied bonus disc (either source) or an explicit "Special Features"/"Bonus
  // Features" list read straight off the back cover (coverSpecialFeaturesListed - added
  // 2026-09-29) each independently imply real special features exist, even when only one of
  // the two signals fired (a features list can sit on the movie's own disc with no separate
  // bonus disc at all, and vice versa).
  const [specialFeatures, setSpecialFeatures] = useState(
    draft?.specialFeatures ?? (Boolean(visionDiscConfig ?? coverDiscConfig) || coverSpecialFeaturesListed === true)
  );
  const [specialFeaturesDiscCount, setSpecialFeaturesDiscCount] = useState(
    draft?.specialFeaturesDiscCount ??
      visionDiscConfig?.specialFeaturesDiscCount.toString() ??
      coverDiscConfig?.specialFeaturesDiscCount.toString() ??
      ""
  );
  const [specialFeaturesDiscFormat, setSpecialFeaturesDiscFormat] = useState(
    draft?.specialFeaturesDiscFormat ?? visionDiscConfig?.specialFeaturesDiscFormat ?? coverDiscConfig?.specialFeaturesDiscFormat ?? ""
  );
  const [fieldOptions, setFieldOptions] = useState<FieldOptions | null>(null);
  // "Would TMDb find anything for this specific title" - keeps the manual Rating/Studio
  // fields hidden by default (TMDB now auto-fills both at confirm time - see
  // Claude/TECH STACK AND ARCHITECTURE.md's TMDb section) and only reveals one once TMDb
  // has genuinely come up empty for that specific field.
  const [tmdbPreview, setTmdbPreview] = useState<TmdbPreview | null>(null);
  const [tmdbPreviewLoading, setTmdbPreviewLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Drives ProgressBar during a Collection submit - see performCreateCollection's own comment.
  const [submitProgress, setSubmitProgress] = useState(0);
  const [activeSlide, setActiveSlide] = useState("title");
  const [slideReturn, setSlideReturn] = useState<string | null>(null);
  const [openRow, setOpenRow] = useState<string | null>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [activeSlide]);
  const [checkingExisting, setCheckingExisting] = useState(false);
  const [existingCheck, setExistingCheck] = useState<MatchCheck | null>(null);
  const [chosenExistingId, setChosenExistingId] = useState<string | null>(null);
  // Seeded with the last background save's failure, if any (2026-10-03) - a failed save
  // drops this scan back into Pending Scans with its draft intact, and reopening it should
  // say why rather than looking as if nothing happened.
  const [error, setError] = useState<string | null>(() => {
    const lastError = getSubmissionError(scan.id);
    return lastError ? `The last save attempt failed: ${lastError}` : null;
  });

  // Collection scanning flow (added 2026-09-20) - see Claude/TECH STACK AND ARCHITECTURE/
  // barcode-scanning-pipeline.md. A manual, editable toggle (per the user's own explicit
  // request) rather than trusting autoDetectedCollection outright. When true, this whole
  // screen renders an entirely separate flow below (shared physical-fields step, Name of
  // Collection, a per-title add loop) instead of the ordinary single-title candidate/field
  // form - see the isCollectionOverride branch in the render below. Deliberately reuses this
  // screen's own existing single-title state where the meaning genuinely carries over instead
  // of declaring parallel state: `manualTitle` doubles as "Name of Collection" text (both are
  // just "the title this entry gets", and manualTitle's own existing prefill already computes
  // the right starting value from the UPC listing), `movieOrTv` doubles as the collection
  // header's own Movie/TV type, and `watched`/`watchedDisc` double as "Watched Collection"/
  // "Watched Collection Disc" (the header row has its own real watched/watched_disc columns
  // like any title row - no new schema needed). Every shared physical field (format, disc
  // count, genre location, disk region, special features, release name, disc condition, case
  // notes, steelbook, rental tracking) is reused as-is too - per the user's own reasoning, a
  // physical box set is one object and can't sit in two shelf locations or have two disc
  // counts at once, so there is exactly one value of each for the header and every member.
  // (isCollectionOverride itself is declared much earlier, right after `draft` - needsTitleSearch
  // below needs to read it and runs before this point in the function.)
  // Collection header's own Total Disc Count (typed once - every physical disc in the box, bonus
  // disc included) and which numbered disc(s) are the collection's own bonus disc. Redesigned
  // 2026-09-20 (see barcode-scanning-pipeline.md's Collections section): the header total used to
  // be computed from the members, which double-counted a disc two titles share and was then
  // overwritten again server-side by a naive sum - now it's a plain typed field, and each title
  // just ticks which numbered disc(s) it's on. Kept separate from `discCount` (the single-title
  // form's own field) so it starts blank instead of inheriting that field's "1" default.
  // `coverDiscCountGuess` fallback added 2026-09-30, found live: a real "Gidget Film Collection"
  // cover printed "2 DISC SET" in the bottom-right spec area, and coverVision.ts's discCount
  // field genuinely read it (confirmed against the real resolved_candidates), but nothing wired
  // it into this field at all - `discCount` (the single-title field, right above) already had
  // this same fallback, this one just never got it. Still just a starting guess, same as every
  // other cover-derived pre-fill on this screen - fully editable, never presented as confirmed.
  const [collectionDiscCount, setCollectionDiscCount] = useState(
    draft?.collectionDiscCount ?? coverDiscCountGuess?.toString() ?? ""
  );
  const [bonusDiscs, setBonusDiscs] = useState<number[]>(draft?.bonusDiscs ?? []);
  // Key of the member currently open in the edit-title picker, or null when adding a new one.
  const [editingMemberKey, setEditingMemberKey] = useState<string | null>(null);
  // Set when a cover-derived member-title suggestion chip is tapped (added 2026-09-30) - passed
  // to TitleSearchPicker as initialQuery so it opens with that search already run, rather than
  // auto-adding the cover's own read straight into the set (a vision misread should still be
  // reviewed like any other title on this screen). Never set alongside editingMemberKey.
  const [pendingSuggestionQuery, setPendingSuggestionQuery] = useState<string | null>(null);
  const [collectionMembers, setCollectionMembers] = useState<CollectionMember[]>(() =>
    (draft?.collectionMembers ?? []).map(sanitizeSpecialFeaturesDiscOverlap)
  );
  // The box set's own member titles, when a cover photo actually listed them (added
  // 2026-09-30, per the user's own observation - see scanResolver.ts's coverMemberTitles for
  // the full read). Filters out anything matching a title already added, so a suggestion chip
  // doesn't linger once it's been used (or if the same name was independently typed by hand).
  // Declared here, after collectionMembers, not up near autoDetectedCollection where it first
  // lived - a real crash ("Cannot read property 'some' of undefined") found live 2026-09-30
  // from referencing collectionMembers before its own useState declaration further down this
  // same component.
  const coverMemberTitleSuggestions: string[] = (scan.resolved_candidates?.coverMemberTitles ?? []).filter(
    (t) => !collectionMembers.some((m) => m.title.trim().toLowerCase() === t.trim().toLowerCase())
  );
  // Extends the single-title flow's franchise-rating-buttons/family-genre Disc Condition
  // warning to the Collection header too, but only when every member agrees - added
  // 2026-09-27 per the user's own rule: "It would map to collections if all the titles in
  // the collection are of the same franchise, or if all the titles in the collection were
  // kids or family titles." Requires at least 2 members (an empty/single-member collection
  // has nothing to be unanimous about) - each check below intersects/ANDs across every
  // member rather than picking the first one, so one disagreeing title anywhere in the set
  // correctly suppresses it for the whole header, not just a majority vote.
  //
  // Every member's OWN franchise tags, intersected down to only the ones every single member
  // shares - empty the moment even one member has none, or the members don't actually share
  // one in common.
  const collectionSharedFranchiseTags =
    collectionMembers.length < 2
      ? []
      : collectionMembers.reduce<string[] | null>((shared, m) => {
          const tags = (m.franchise ?? "").split(",").map((f) => f.trim()).filter(Boolean);
          if (shared === null) return tags;
          return shared.filter((tag) => tags.includes(tag));
        }, null) ?? [];
  // Conservative both ways: undefined ("no TMDb match to check yet") counts as "no" for
  // either flag, same as TitleSearchPicker's own CollectionMember comment explains.
  const collectionAllMembersFamilyOrKids =
    collectionMembers.length >= 2 && collectionMembers.every((m) => m.isFamilyOrKidsGenre === true);
  const collectionAllMembersAnimated =
    collectionMembers.length >= 2 && collectionMembers.every((m) => m.isAnimatedStyle === true);
  // Same G/PG heuristic and franchise-ranked-count lookup the single-title flow's own
  // franchiseCommonRatings uses below, just fed from the shared-across-every-member values
  // above instead of the single-title flow's own franchise/genre/animation fields.
  const collectionCommonRatings = (() => {
    const suggestions = collectionAllMembersFamilyOrKids && collectionAllMembersAnimated ? ["G", "PG"] : [];
    const counts: Record<string, number> = {};
    for (const tag of collectionSharedFranchiseTags) {
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
  const [showTitleSearchPicker, setShowTitleSearchPicker] = useState(false);
  // Collection-wide duplicate check (redesigned 2026-09-20, twice the same day): originally
  // ran per-title inside TitleSearchPicker at add time, then briefly became a queue asking
  // Overwrite/New-Entry once per matched item - the user pointed out that's still one too many
  // questions: "as if done correctly all the titles that the system asks to overwrite or leave
  // are part of collections anyway," so a single match on the collection AS A WHOLE is enough.
  // `collectionMatchCheck` is the header's own collection-scoped fuzzy match (find-existing's
  // `collectionMemberTitles` mode - name+format+member-title-overlap, not exact text equality,
  // since a real box set was found to fail exact matching once already). Choosing "Overwrite"
  // resolves the WHOLE decision at once: the header itself overwrites the chosen candidate,
  // and each of the new collection's own members is matched against that one candidate's own
  // already-catalogued members (`existingMemberTitles`, returned alongside it) by exact
  // normalized title - a match becomes that member's own overwrite target, no match means it's
  // a genuinely new addition to the collection (see resolveCollectionMatch below).
  const [collectionMatchCheck, setCollectionMatchCheck] = useState<MatchCheck | null>(null);
  const [chosenCollectionMatchId, setChosenCollectionMatchId] = useState<string | null>(null);
  const [checkingCollectionDuplicates, setCheckingCollectionDuplicates] = useState(false);

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

  // A serial always has exactly one season (see RESOURCES.md's TV field semantics note) -
  // default the field the moment "Serial" is picked, same "only while the user hasn't
  // already typed something of their own" guard as the disk-region default above.
  useEffect(() => {
    if (movieOrTv === "Serial" && !seasonNo.trim()) setSeasonNo("1");
  }, [movieOrTv]);

  // Watched Collection / Watched Collection Disc bottom-up auto-derive (per the user's own
  // spec): "Watched Collection" auto-checks once every member's own Watched is checked, and
  // the same independently for "Watched Collection Disc" against every member's Watched Disc.
  // Only active in collection mode - `watched`/`watchedDisc` are shared, doubling as the
  // ordinary single-title fields outside of it, so this must never run then. Recomputes on
  // every member add/remove/toggle. The companion top-down cascade (manually toggling the
  // header checkbox sets every member to match) lives on that checkbox's own onPress instead
  // of here - setting every member to the same value makes this derivation trivially agree
  // with it afterward, so the two behaviors never fight each other once at least one member
  // exists.
  //
  // Skipped entirely while `collectionMembers` is still empty (found live 2026-09-20: checking
  // "Watched Collection Disc" before adding any titles cascaded true onto zero members, then
  // this effect re-ran on that same empty-array change and read "zero members" as "not
  // everything's watched," forcing both checkboxes straight back off - the exact "selects then
  // immediately deselects" bug the user reported). With no members yet, there's nothing to
  // derive a consensus from, so the header checkbox is left exactly as the user set it instead
  // of being forced to "false" - real derivation only takes over once a first member exists to
  // actually agree or disagree with it.
  useEffect(() => {
    if (!isCollectionOverride || collectionMembers.length === 0) return;
    setWatched(collectionMembers.every((m) => m.watched));
  }, [isCollectionOverride, collectionMembers]);
  useEffect(() => {
    if (!isCollectionOverride || collectionMembers.length === 0) return;
    setWatchedDisc(collectionMembers.every((m) => m.watchedDisc));
  }, [isCollectionOverride, collectionMembers]);
  // The header's own Movie/TV type - per the user directly, some collections are all-movie
  // and some are all-TV, so this stays a normal editable field (movieOrTv, shared with the
  // single-title flow's own field) rather than being hidden or hardcoded; this just seeds it
  // with the same plain fallback the confirm route itself would otherwise apply, since it's
  // "likely to be changed" either way.
  useEffect(() => {
    if (isCollectionOverride && !movieOrTv.trim()) setMovieOrTv("Movie");
  }, [isCollectionOverride]);

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
      unintentionalCollection,
      watched,
      watchedDisc,
      depictedEraLabel,
      tmdbIdOverride,
      genre,
      runningTimeMins,
      director,
      isCurrentlyRentedOut,
      rentedByWho,
      dateRented,
      originalLanguage,
      movieOrTv,
      seasonNo,
      partOfSeasonNo,
      episodeCount,
      isCollectionOverride,
      collectionMembers,
      collectionDiscCount,
      bonusDiscs,
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
    unintentionalCollection,
    watched,
    watchedDisc,
    depictedEraLabel,
    tmdbIdOverride,
    genre,
    runningTimeMins,
    director,
    isCurrentlyRentedOut,
    rentedByWho,
    dateRented,
    originalLanguage,
    movieOrTv,
    seasonNo,
    partOfSeasonNo,
    episodeCount,
    isCollectionOverride,
    collectionMembers,
    collectionDiscCount,
    bonusDiscs,
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

  const mainCandidates = candidates.filter((c) => !looksLikeExtraContent(c.Title));
  const extraCandidates = candidates.filter((c) => looksLikeExtraContent(c.Title));
  const diskRegionOptions = getDiskRegionOptions(format) ?? fieldOptions?.diskRegion ?? [];
  const showSpecialFeaturesDiscFields = specialFeatures && (parseInt(discCount, 10) || 1) > 1;
  // Collection mode's own header-level special-features gate (added 2026-09-20) - the header
  // row has no single "primary disc" of its own the way an ordinary scan does (its discs are
  // all inside the per-title members instead), so unlike showSpecialFeaturesDiscFields above,
  // this isn't gated on "more than 1 disc" - Special Features alone means "this collection has
  // its own bonus disc, separate from any title's own", per the user's own explicit spec.
  const showHeaderSpecialFeaturesDiscFields = specialFeatures;
  // Numeric form of the header's typed Total Disc Count - drives the per-title "What disc(s) is
  // this title on?" checkbox lists and the bonus-disc selector below (0 until it's filled in).
  const totalDiscCountNumber = Math.max(0, parseInt(collectionDiscCount, 10) || 0);
  // Which disc number maps to which physical format, derived live from what's already known
  // about this set - added 2026-09-23 per the user's own correction: the format of a shared
  // bonus disc doesn't need typing in fresh by every title that points at it, since it's
  // already recorded wherever that disc's format was first established. Passed to
  // TitleSearchPicker so it can auto-fill "Format of Special Features Disc(s)" instead of
  // asking again. Priority (highest first, later entries win the object-key overwrite below):
  // (1) any member's own movie-disc format - the most physically authoritative source, since
  // that's literally what format that disc actually is; (2) the header's own designated bonus
  // disc format; (3) any other member's own already-typed special-features-disc format, the
  // weakest source (just an earlier guess) but still better than asking a third time.
  const discFormatLookup = (() => {
    const map: Record<number, string> = {};
    for (const m of collectionMembers) {
      if (!m.specialFeatures || !m.specialFeaturesDiscFormat) continue;
      for (const n of parseDiscNumberList(m.specialFeaturesDiscNumbers)) if (!map[n]) map[n] = m.specialFeaturesDiscFormat;
    }
    if (specialFeatures && specialFeaturesDiscFormat) {
      for (const n of bonusDiscs) map[n] = specialFeaturesDiscFormat;
    }
    for (const m of collectionMembers) {
      if (!m.format) continue;
      for (const n of parseDiscNumberList(m.discNumbers)) map[n] = m.format;
    }
    return map;
  })();
  // Mirrors performCreateCollection's own `nameOfCollection` generation (kept in sync with it
  // deliberately) so the user can watch the real saved name build up live as titles are added,
  // rather than only discovering the final colon-list string after Confirm. `manualTitle` stays
  // the plain base name the whole time - this is a read-only preview, never fed back into it.
  // Two collection-name rules (2026-09-20, kept identical to performCreateCollection's): a name that
  // already lists every added title is saved exactly as typed (no ": Title1, Title2" suffix), and a
  // generic name like "2 Movie Collection" needs no Release Name at all.
  const collectionNameListsTitles = nameListsAllTitles(
    manualTitle,
    collectionMembers.map((m) => m.title)
  );
  const collectionNameIsGeneric = isGenericCollectionName(manualTitle);
  const previewCollectionName =
    collectionMembers.length > 0
      ? collectionNameListsTitles
        ? manualTitle.trim()
        : `${manualTitle.trim()}: ${collectionMembers.map((m) => m.title).join(", ")}`
      : "";

  // Pre-search (2026-09-20, "fully automatic on entering the name" per the user): once a name has
  // been typed and settled, look its film titles up on OMDB and pre-fill the titles list with the
  // confident matches. Only while the list is still empty (never overwrites work), each distinct
  // name is tried once, and a result for a name that has since changed is discarded.
  //
  // `userManagedMembersRef` (added 2026-09-27, fixing a real reported bug: auto-matched titles
  // kept reappearing after being removed and replaced with the user's own) tracks something the
  // old guard didn't - not "is the list currently empty" but "has the user ever taken over
  // curating it by hand." Those aren't the same thing: removing every auto-matched title (a
  // deliberate rejection of all of them) also makes the list empty again, and the old guard
  // read that bare zero-length exactly like "never touched yet," re-arming the very next debounce
  // tick if it happened to land while the name was still unchanged. Set the instant the user adds,
  // edits, or removes any member by hand (see removeCollectionMember and the Add/Edit modal's
  // onAdd below) - once true, this collection never auto-matches again for the rest of this
  // screen's life, regardless of how the list's length bounces around afterward.
  const autoMatchedNameRef = useRef("");
  const userManagedMembersRef = useRef(false);
  const [autoMatching, setAutoMatching] = useState(false);
  useEffect(() => {
    if (!isCollectionOverride || collectionMembers.length > 0 || userManagedMembersRef.current) return;
    const name = manualTitle.trim();
    if (name.length < 8 || autoMatchedNameRef.current === name) return;
    const handle = setTimeout(async () => {
      autoMatchedNameRef.current = name;
      setAutoMatching(true);
      try {
        const matched = await autoMatchTitlesFromName(
          name,
          format,
          (q) => searchTitleOnOmdb(q, false),
          () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
        );
        if (matched.length > 0 && autoMatchedNameRef.current === name && !userManagedMembersRef.current) {
          setCollectionMembers((prev) => (prev.length > 0 ? prev : matched));
        }
      } finally {
        setAutoMatching(false);
      }
    }, 1200);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCollectionOverride, manualTitle, collectionMembers.length]);
  // A multi-disc release with special features almost always means exactly one of those
  // discs is the bonus-features disc - default the count to 1 the moment these fields
  // become relevant, but only while blank, so it's never overwritten once the user has
  // actually typed a real value (2+ dedicated special-features discs is rare but real).
  useEffect(() => {
    if (showSpecialFeaturesDiscFields && !specialFeaturesDiscCount) setSpecialFeaturesDiscCount("1");
  }, [showSpecialFeaturesDiscFields]);
  // Special features can never occupy every disc in the case - at least one disc has to be
  // the main feature itself - so the count is capped at discCount - 1. Re-clamps whenever
  // Disc Count itself goes down (e.g. 3 -> 2 after a miscount fix) so a stale higher value
  // can't silently exceed the new cap. 0 is a valid, deliberately allowed value here (not
  // clamped up to 1) - the user's own case: a multi-disc release where disc 1 has the main
  // feature plus some special features, and disc 2 has the same movie again (e.g. a long
  // film split across two discs) - there, no disc is "the" dedicated special-features disc.
  useEffect(() => {
    if (!showSpecialFeaturesDiscFields) return;
    const max = Math.max(0, (parseInt(discCount, 10) || 1) - 1);
    const current = parseInt(specialFeaturesDiscCount, 10) || 0;
    if (current > max) setSpecialFeaturesDiscCount(String(max));
  }, [discCount, showSpecialFeaturesDiscFields]);
  // toggleCandidate above never lets `selected` hold more than one id any more - the old
  // multi-select checklist this candidate list used to support only ever existed to serve
  // the collection flow, which now has its own entirely separate UI (isCollectionOverride)
  // and never reads this candidate list at all.
  const singleSelectedImdbId = selected.size === 1 ? [...selected][0] : null;

  // Movie/TV type guess, reactive to whichever candidate is the current best match - added
  // 2026-09-19 per the user's own clarification that Type should be settled from the best
  // match, not just guessed once at mount. Never runs at all when a real starting value
  // already exists from a draft - an unsubmitted in-progress form is authoritative and must
  // never be silently overwritten by a fresh guess. An existingMatch (an already-submitted,
  // confirmed entry) is deliberately NOT treated the same way any more (2026-09-24, see this
  // file's "prefill only from an unsubmitted draft" note near existingMatch's own
  // declaration) - movieOrTv starts blank for one of those, so this guess is exactly what
  // fills it back in, freshly, rather than leaving it blank. Otherwise re-guesses every time
  // the selected candidate itself changes (e.g. the user picks a different candidate than
  // the one auto-selected), but backs off the moment the field no longer holds the tool's
  // own last suggestion verbatim - same guard pattern as the Title composition effects below.
  const lastAutoMovieOrTvRef = useRef<string | null>(null);
  useEffect(() => {
    if (draft?.movieOrTv) return;
    if (!singleSelectedImdbId) return;
    if (movieOrTv !== "" && movieOrTv !== lastAutoMovieOrTvRef.current) return;
    const selectedCandidate = candidates.find((c) => c.imdbID === singleSelectedImdbId);
    const guessed = guessMovieOrTvFromType(selectedCandidate?.Type, !!selectedCandidate?.classicWhoSerial);
    lastAutoMovieOrTvRef.current = guessed;
    setMovieOrTv(guessed);
  }, [singleSelectedImdbId]);

  // Season No./Episode Count prefill for a classic Doctor Who serial (added 2026-09-30) -
  // the matched serial's own season/episode-count is already known locally (the cached
  // classic_who_serial_index, see classicWhoSerials.ts), so there's no need to make the user
  // type in values this screen already has. Same "never overwrite a draft or a value the
  // user's already touched" guard as every other reactive-guess effect on this screen - only
  // fills a field that's still genuinely blank.
  useEffect(() => {
    if (!singleSelectedImdbId) return;
    const classicWhoSerial = candidates.find((c) => c.imdbID === singleSelectedImdbId)?.classicWhoSerial;
    if (!classicWhoSerial) return;
    if (!draft?.seasonNo && !seasonNo.trim()) setSeasonNo(String(classicWhoSerial.season));
    if (!draft?.episodeCount && !episodeCount.trim()) setEpisodeCount(String(classicWhoSerial.episodeCount));
    // "BOX TV Sci-Fi" is the user's own dedicated Doctor Who shelf (2026-09-30) - ordered by
    // release order server-side (apps/web/src/app/api/scan/confirm/route.ts's
    // computeShelfLocation) rather than alphabetically, which only works when every Doctor
    // Who title actually shares this same genre_location. Same guard as every other prefill
    // here - only fills a genuinely blank field, never overwrites the user's own choice.
    if (!draft?.genreLocation && !genreLocation.trim()) setGenreLocation("BOX TV Sci-Fi");
    // Animated-reconstruction prefill (added 2026-10-01) - see classicWhoSerials.ts and
    // coverVision.ts's own artStyle field for the two signals combined here. A classic serial
    // with any missing episodes could never have a purely-live-action standalone disc release
    // (the story either has no disc release at all - only surviving fragments inside "Doctor
    // Who Lost in Time" - or the one that does exist is necessarily an official animated
    // reconstruction filling the gap), so matching one here is itself strong evidence on its
    // own. A "drawn" cover-art read is a second, independent signal for the same conclusion,
    // and the only one at all for a serial this index's missing_episode_count hasn't caught
    // (e.g. a brand new reconstruction released after the data was last backfilled). Always
    // just a pre-fill, never locked - same "only a genuinely blank field" guard as the fields
    // above, since the user still has to pick which style (2D/3D/puppet) actually applies,
    // which neither signal can tell.
    if (!draft?.animationOrLiveAction && !animationOrLiveAction.trim()) {
      const { missingEpisodeCount, episodeCount: totalEpisodes } = classicWhoSerial;
      if (missingEpisodeCount > 0 && missingEpisodeCount >= totalEpisodes) setAnimationOrLiveAction("Animation");
      else if (missingEpisodeCount > 0) setAnimationOrLiveAction("Live Action/Animation Hybrid");
      else if (coverLooksDrawn) setAnimationOrLiveAction("Animation");
    }
  }, [singleSelectedImdbId]);

  // Sharpens the guess above from "Movie" to "TV Movie" once TMDb's own preview data has
  // actually arrived - added 2026-09-19 per the user's own idea after checking a real title
  // (the 1996 Doctor Who TV movie, TMDb movie id 15691) does carry TMDb's own "TV Movie"
  // genre tag (id 10770, a leftover of TMDb's taxonomy). Verified live this signal is tied to
  // the exact candidate already selected (TMDb's `/find` by this candidate's own imdbId), so
  // it can't accidentally pull in an unrelated title. Runs after the effect above (TMDb's
  // preview fetch is always slower than the initial OMDb-Type guess), refining the same
  // `lastAutoMovieOrTvRef`-tracked value rather than replacing it outright - never touches a
  // guess that wasn't "Movie" to begin with (a TV Series/TV Episode guess is left alone), and
  // backs off the instant the field no longer holds the tool's own last suggestion, same
  // guard as every other reactive-guess effect on this screen.
  useEffect(() => {
    if (lastAutoMovieOrTvRef.current !== "Movie") return;
    if (movieOrTv !== lastAutoMovieOrTvRef.current) return;
    if (!tmdbPreview?.genres.includes("TV Movie")) return;
    lastAutoMovieOrTvRef.current = "TV Movie";
    setMovieOrTv("TV Movie");
  }, [tmdbPreview]);

  // Title + season/part composition, added 2026-09-19: OMDB only ever has one entry per
  // whole show, never one per season, so a matched candidate's own Title is always just the
  // bare show name ("Breaking Bad") - with nothing else, the catalogued title would have no
  // way to tell two season discs of the same show apart, unlike how this collection's real
  // titles already work ("Friends Season 1", "Bewitched Season 2", ...). Suggests
  // "<Show> Season <N>" (plus " Part <N>" when Part of a Season No. is set) into the same
  // Title field used by the fully-manual path above - always fully editable, never enforced,
  // since the real collection already uses several different phrasings for this depending on
  // the show ("Series N", "the Complete Nth Season", a bare number with no word at all).
  const selectedCandidate = singleSelectedImdbId ? candidates.find((c) => c.imdbID === singleSelectedImdbId) : undefined;
  const selectedCandidateTitle = selectedCandidate?.Title ?? null;
  const lastAutoTitleRef = useRef<string | null>(null);
  // A classic Doctor Who serial's own matched title ("The Underwater Menace") is already the
  // complete, correct catalogue title on its own - unlike an ordinary show, where OMDB only
  // ever has one entry for the whole series ("Breaking Bad") and "Season N" has to be appended
  // to tell discs apart. Auto-filling Season No. for a classic serial (see the prefill effect
  // above) must never also trigger this composition, or it silently becomes "The Underwater
  // Menace Season 4" the moment that auto-filled Season No. lands - found live 2026-09-30.
  function composeSeasonTitle(baseTitle: string): string {
    if (selectedCandidate?.classicWhoSerial) return baseTitle;
    if (!showSeasonFields || !seasonNo.trim()) return baseTitle;
    const part = partOfSeasonNo.trim();
    return `${baseTitle} Season ${seasonNo.trim()}${part ? ` Part ${part}` : ""}`;
  }
  // Hard reset the moment a candidate is picked (or changed) - a fresh, deliberate action
  // that should always refresh the suggestion, even over a stale value left by something
  // else (e.g. handleTitleSearch pre-filling the bare search query into this same field).
  useEffect(() => {
    if (!selectedCandidateTitle) return;
    const suggested = composeSeasonTitle(selectedCandidateTitle);
    lastAutoTitleRef.current = suggested;
    setManualTitle(suggested);
  }, [singleSelectedImdbId]);
  // Soft update as Season No./Part of a Season No. change afterward - only while the title
  // field still holds our own last suggestion verbatim, so it never overwrites something the
  // user has since typed themselves.
  useEffect(() => {
    if (!selectedCandidateTitle) return;
    if (manualTitle !== lastAutoTitleRef.current) return;
    const suggested = composeSeasonTitle(selectedCandidateTitle);
    lastAutoTitleRef.current = suggested;
    setManualTitle(suggested);
  }, [seasonNo, partOfSeasonNo, showSeasonFields]);

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
        // as the 4K-region default and the UPC-listing format guess above. Wikidata can
        // return more than one franchise claim at once (P179 is multi-valued) - joined into
        // the same comma-separated text the field already holds for Genre/Director.
        setFranchise((prev) => (prev ? prev : result.franchise.length > 0 ? result.franchise.join(", ") : prev));
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
        if (!cancelled)
          setTmdbPreview({
            tmdbId: null,
            rating: null,
            studio: null,
            isAnimated: null,
            originalLanguage: null,
            franchise: [],
            genres: [],
          });
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
  const showOriginalLanguageField = singleSelectedImdbId
    ? !tmdbPreviewLoading && !tmdbPreview?.originalLanguage
    : true;
  // TMDb doesn't actually have a "Live Action" genre - only an "Animation" tag that's
  // present or absent - so isAnimated === false is a confirmed live-action answer, and the
  // field can be hidden entirely (locked to "Live Action" via the effect above), same as
  // Rating/Studio hiding once TMDb has answered. isAnimated === true keeps the field
  // visible so the user can pick the specific style TMDb doesn't know. isAnimated === null
  // (no TMDb match) also keeps it visible, since we have no confirmed answer either way.
  // A classic Who serial with any missing episodes (or drawn cover art) is treated as likely
  // animated regardless of what TMDb's own genre data says - TMDb has no reason to know a
  // classic serial's specific disc release is a reconstruction, so its "isAnimated: false"
  // read (the ordinary case for this show) must not hide/lock the field for one of these -
  // see the prefill effect near singleSelectedImdbId above for the same two signals.
  const isLikelyAnimatedWhoReconstruction =
    !!selectedCandidate?.classicWhoSerial &&
    (selectedCandidate.classicWhoSerial.missingEpisodeCount > 0 || coverLooksDrawn);
  const showAnimationField = singleSelectedImdbId
    ? isLikelyAnimatedWhoReconstruction || (!tmdbPreviewLoading && tmdbPreview?.isAnimated !== false)
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
  // Client-side genre signal for ranking Genre Location buttons (see rankGenreLocationOptions
  // above) - TMDb's own genre list for the selected candidate when one exists (the practical
  // client-side stand-in for OMDB's own Genre text, which this screen has no fetch for at
  // all - only the server resolves that, at confirm time), else the manually-typed Genre
  // field for a fully-manual entry (no candidate, no TMDb preview to draw from).
  const genreSignalForLocationRanking = tmdbPreview?.genres ?? (genre ? genre.split(",").map((g) => g.trim()) : []);
  const isHistoryDocumentary = /history document/i.test(genreLocation);
  // Added 2026-09-27 per the user's own observation: a high proportion of the family/kids/
  // animated titles already in the collection turned out scratched from previous owners -
  // Disc Condition is easy to breeze past on a title like this without a second look, so it's
  // flagged the same amber "worth a look" way Franchise/Special Features already are. Genre
  // is comma-separated free text (matches "Animated" and "Animation" both); Genre Location is
  // a single fixed value, checked the same case-insensitive way isHistoryDocumentary is above.
  const isFamilyRiskGenre =
    genre.split(",").some((g) => /family|kids|animat/i.test(g.trim())) || /family/i.test(genreLocation);
  // Added 2026-09-27, same day, per the user's follow-up: "if a title is given the genre
  // kids, family is found as animated rather than live action the rating buttons that appear
  // for quick selection will be G or PG" - a narrower pair of checks than isFamilyRiskGenre
  // above (genre kids/family specifically, not also matching "animat" as a genre tag - that
  // signal comes from animationOrLiveAction instead, a separate field entirely). Feeds
  // franchiseCommonRatings below, not the Disc Condition warning above.
  const isFamilyOrKidsGenre =
    genre.split(",").some((g) => /family|kids/i.test(g.trim())) || /family/i.test(genreLocation);
  const isAnimatedStyle = animationOrLiveAction.trim() !== "" && animationOrLiveAction !== "Live Action";
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

  // Single-select with deselect: tapping an already-selected candidate clears the selection,
  // tapping a different one replaces it. This screen's candidate list has never supported
  // picking more than one for a genuine single-disc scan - the old prev-preserving multi-
  // select branch here only ever existed to serve the collection checklist, which now has its
  // own entirely separate flow (see isCollectionOverride above) and no longer reads this list
  // at all.
  function toggleCandidate(imdbId: string) {
    setSelected((prev) => {
      const next = new Set<string>();
      if (!prev.has(imdbId)) {
        next.add(imdbId);
      }
      return next;
    });
  }

  /** Shared by both the main candidate row and the collapsed Extras row below it - same
   * poster-card look and toggle behavior regardless of which section a candidate landed in. */
  function renderCandidateCard(c: OmdbCandidate) {
    return (
      <TouchableOpacity
        style={[styles.posterCard, selected.has(c.imdbID) && styles.posterCardSelected]}
        onPress={() => toggleCandidate(c.imdbID)}
      >
        {c.Poster && c.Poster !== "N/A" && !posterLoadFailed.has(c.imdbID) ? (
          <Image
            source={{ uri: c.Poster }}
            style={styles.posterImage}
            resizeMode="cover"
            onError={() => markPosterLoadFailed(c.imdbID)}
          />
        ) : (
          <View style={[styles.posterImage, styles.posterPlaceholder]}>
            <Text style={styles.posterPlaceholderText}>No poster image found</Text>
          </View>
        )}
        <Text style={styles.posterTitle}>
          {selected.has(c.imdbID) ? "[x] " : "[ ] "}
          {c.Title}
        </Text>
        <Text style={styles.posterYear}>
          {c.Year}
          {c.Runtime ? ` · ${c.Runtime}` : ""}
        </Text>
      </TouchableOpacity>
    );
  }

  /** `overwriteUniqueId`, when given, replaces that already-catalogued title's every field
   * with this scan's data instead of creating a new row - the "Overwrite" choice on the
   * similar-entry check below. */
  async function performCreate(overwriteUniqueId?: string) {
    // Belt-and-suspenders: an Overwrite that already knows the real film (existingMatch)
    // must never be allowed to submit with nothing selected - that would silently rebuild
    // the row with every OMDB/TMDB-sourced field blanked out (the confirm route derives
    // them entirely from entry.imdbId). Catches this even if some future change reopens
    // the stale-draft gap that already caused this exact data loss once for real.
    if (overwriteUniqueId && existingMatchImdbId && selected.size === 0) {
      setError(
        "This scan lost track of the matched film before submitting - please reopen this " +
          "scan from Pending Scans and try again rather than risk overwriting with blank data."
      );
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const chosen = candidates.filter((c) => selected.has(c.imdbID));

      const manualFields = {
        format,
        disc_count: parseInt(discCount, 10) || 1,
        disk_region: diskRegions.size > 0 ? [...diskRegions].join(", ") : null,
        genre_location: genreLocation || null,
        // Multi-value list now (0020_merge_franchise_columns.sql) - always sent, same as
        // genre_location, since Franchise is (unlike Genre/Director below) asked for on
        // every scan, not just the fully-manual path.
        franchise: franchise.trim() ? franchise.split(",").map((f) => f.trim()).filter(Boolean) : [],
        // Always sent, same as franchise above - the Movie/TV type field is always visible,
        // not gated on selected.size the way Genre/Director/Running Time are (see
        // barcode-review-screen-fields.md's TV Scanning section). Season/episode fields are
        // only meaningful for the TV-ish subset of movie_or_tv values (showSeasonFields) -
        // sent as null otherwise rather than left showing stale text from a value the user
        // already changed away from.
        movie_or_tv: movieOrTv || null,
        season_no: showSeasonFields ? seasonNo.trim() || null : null,
        part_of_season_no: showSeasonFields ? partOfSeasonNo.trim() || null : null,
        episode_count: showSeasonFields ? parseInt(episodeCount, 10) || null : null,
        // The confirm route defaults a blank value to "Live Action" (the right call when
        // there's no TMDb signal at all). But if TMDb *has* confirmed this is animated and
        // the user leaves the style dropdown blank, falling through to that default would
        // silently mislabel a known-animated title - so that one case sends "Animation"
        // instead of null.
        animation_or_live_action:
          animationOrLiveAction.trim() ||
          (singleSelectedImdbId && tmdbPreview?.isAnimated === true ? "Animation" : null),
        rating: rating.trim() || null,
        studio: studio.trim() || null,
        original_language: originalLanguage.trim() || null,
        steelbook,
        release_name: releaseNameMatchesTitle ? null : releaseName.trim() || null,
        // A specific cut of the film ("the Final Cut," "Director's Cut," ...), detected from
        // the barcode's own listing text - added 2026-09-18 per the user's explicit
        // instruction that a cut belongs appended to the catalogued title itself, distinct
        // from release_name above (reserved for packaging/marketing special editions).
        // Always sent, regardless of whether a real OMDB/TMDb candidate was picked - the
        // confirm route appends it to whatever title it ends up with either way.
        cut_suffix: upcCutVariant?.cutSuffix ?? null,
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
        // Hidden fields are cleared here (not just hidden in the UI), so an Overwrite of an
        // already-rented entry can't leave a stale rentedByWho/dateRented behind after the
        // checkbox is unticked - same "hide + clear on submit" precedent as Special Features
        // Disc Count/Format above.
        is_currently_rented_out: isCurrentlyRentedOut,
        rented_by_who: isCurrentlyRentedOut ? rentedByWho.trim() || null : null,
        date_rented: isCurrentlyRentedOut ? dateRented || null : null,
        tmdb_id_override: showTmdbOverrideField ? tmdbIdOverride.trim() || null : null,
        // Only sent for a fully-manual entry (no OMDB/TMDb candidate at all) - omitted
        // entirely rather than sent as null/[] whenever a real candidate is selected, so
        // the confirm route's `manual.genre ?? omdbFields.genre` fallback (and the
        // equivalent for director/running_time_mins) still reaches the OMDB-derived value
        // instead of being clobbered by an empty array from a field that was never shown.
        ...(selected.size === 0
          ? {
              title: manualTitle || scan.barcode || "Untitled",
              genre: genre.trim() ? genre.split(",").map((g) => g.trim()).filter(Boolean) : [],
              director: director.trim() ? director.split(",").map((d) => d.trim()).filter(Boolean) : [],
              running_time_mins: parseInt(runningTimeMins, 10) || null,
            }
          // Single real candidate matched: the Title field above still applies (season/part
          // composition included), overriding OMDB's own bare show-name title - but Genre/
          // Director/Running Time are deliberately NOT sent here, unlike the fully-manual
          // case above, since a real match already has those from OMDB.
          : singleSelectedImdbId && manualTitle.trim()
            ? { title: manualTitle.trim() }
            : {}),
      };
      const entries: ConfirmEntry[] =
        chosen.length > 0
          ? chosen.map((c, i) => ({
              imdbId: c.imdbID,
              barcodeId: i === 0 ? (scan.barcode ?? undefined) : undefined,
              manualFields,
            }))
          : [{ barcodeId: scan.barcode ?? undefined, manualFields }];

      // Offline handling (added 2026-09-18, per the user's own explicit spec) - checked right
      // before the real network call rather than earlier, since everything above this point
      // (building manualFields/entries) is pure local form state and works identically either
      // way. The server can't be reached at all while offline (OMDB/TMDb, the similar-entry
      // check, and the actual write all need it), so instead of letting confirmScan fail with
      // a network error, the fully-built submission is saved on-device and resubmitted
      // automatically once the connection returns (see offlineQueue.ts's own header comment
      // for the full design, including how a later-found duplicate gets flagged rather than
      // silently resolved). `overwriteUniqueId` is only ever non-null here via the
      // barcode-certain `existingMatch` fast path, which needs no network to have reached this
      // point either - every other path queues as a plain new-entry submission.
      if (!(await getIsOnline())) {
        const chosenTitle = chosen.length === 1 ? chosen[0].Title : null;
        const chosenImdbId = chosen.length === 1 ? chosen[0].imdbID : undefined;
        const parsedDiscCount = parseInt(discCount, 10);
        const fallbackTitle = manualTitle || scan.barcode || "Untitled";
        await queueSubmissionOffline({
          pendingScanId: scan.id,
          entries,
          overwriteUniqueId,
          titleForMatch: chosenTitle ?? fallbackTitle,
          upcText: `${scan.resolved_candidates?.upcProduct?.title ?? ""} ${scan.resolved_candidates?.upcProduct?.description ?? ""}`.trim(),
          imdbId: chosenImdbId,
          formatOverride: format,
          discCountOverride: Number.isNaN(parsedDiscCount) ? undefined : parsedDiscCount,
          displayTitle: chosenTitle ?? fallbackTitle,
        });
        clearConfirmDraft(scan.id);
        Alert.alert(
          "Saved offline",
          "You're offline, so this entry hasn't been added to the database yet. It's been saved on this device and will be submitted automatically (including the normal checks and Estimated Value lookup) once your internet connection is back.",
          [{ text: "OK", onPress: onBack }]
        );
        return;
      }

      // overwriteUniqueId moved from a request-level field to a per-entry one (2026-09-20, for
      // the Collection scanning flow) - this single-title path only ever produces one entry,
      // so it's attached to that one entry here rather than needing its own separate param.
      if (overwriteUniqueId && entries.length > 0) {
        entries[0] = { ...entries[0], overwriteUniqueId };
      }
      // The real write runs in the background (backgroundSubmissions.ts, 2026-10-03) so the
      // user can move straight on to the next scan - SuccessScreen shows "Scanning..." and
      // the outcome, or App.tsx's banner does if they've already left. The draft is only
      // cleared on success, so a failure leaves this scan in Pending Scans fully filled in.
      const submittedTitle = (chosen.length === 1 ? chosen[0].Title : null) ?? (manualTitle.trim() || scan.barcode || "Untitled");
      const submissionId = startBackgroundSubmission(scan.id, submittedTitle, async () => {
        const result = await confirmScan(scan.id, entries);
        clearConfirmDraft(scan.id);
        // Refresh the shared field-options cache so a brand-new tag/value just typed on this
        // scan (Genre, Franchise, Format, etc.) is already suggestible on the very next scan
        // in this session, not just after an app restart - fire-and-forget.
        loadFieldOptions(true);
        return { shelfLocation: result.shelfLocation };
      });
      onConfirmed({ submissionId });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  /** Required fields this form has always presented as non-optional (no "(optional)" label)
   * but never actually enforced - added 2026-09-20 per the user's own request, after checking
   * and confirming nothing previously stopped an empty one from being submitted. Without this,
   * the confirm route would silently paper over a blank field with a placeholder-ish default
   * instead ("Unknown Title", "Movie", "DVD", ...) rather than genuinely valid data - see
   * `manual.title ?? omdbFields.title ?? "Unknown Title"` and its siblings in
   * apps/web/src/app/api/scan/confirm/route.ts. Only ever checks a field that's actually
   * visible/editable in the form's current state, never one that's hidden - the Title field
   * is deliberately excluded when it's hidden for a plain single-movie match, since the
   * season-composition hard-reset effect already keeps `manualTitle` synced to the real OMDB
   * title even while unseen, so there's nothing to actually go wrong there. Genuinely optional
   * fields (every one labeled "(optional)" in the form itself) are deliberately left out -
   * this isn't "every field must be filled," just the ones this form already treats as
   * required but never checked. */
  function getMissingRequiredFields(): string[] {
    const missing: string[] = [];
    if (!movieOrTv.trim()) missing.push("Movie or TV");
    if ((selected.size === 0 || showSeasonFields) && !manualTitle.trim()) {
      missing.push("Title");
    }
    if (!format.trim()) missing.push("Format");
    if (!genreLocation.trim()) missing.push("Genre Location");
    if (diskRegions.size === 0) missing.push("Disk Region");
    if (!discCondition.trim()) missing.push("Disc Condition");
    if (showSpecialFeaturesDiscFields) {
      if (!specialFeaturesDiscCount.trim()) missing.push("Number of Special Features Discs");
      if (!specialFeaturesDiscFormat.trim()) missing.push("Format of Special Features Discs");
    }
    if (isHistoryDocumentary && !depictedEraLabel.trim()) missing.push("Depicted Era");
    // Rating/Studio/Original Language only ever become visible manual fields once TMDb has
    // genuinely come up empty for that specific one - per the user's own explicit call
    // (2026-09-20): once the program is asking the user to supply something TMDb/OMDB
    // couldn't, that's the one chance to capture it, so it counts as required exactly like
    // Genre/Running Time/Director already do on a fully-manual entry. Franchise is
    // deliberately NOT included here despite being similarly unlabeled - unlike these three,
    // a blank Franchise is very often the genuinely correct answer (most films aren't part of
    // one at all), not missing data, so treating it as required would wrongly block
    // confirming any standalone film.
    //
    // Deliberately checked against tmdbPreview/tmdbPreviewLoading directly here, NOT via
    // showRatingField/showStudioField/showOriginalLanguageField - found live 2026-09-24, a
    // real "Resident Evil: Welcome to Raccoon City" scan confirmed with no Rating at all and
    // no warning. Root cause: those three show* flags are also used to control the manual
    // field's on-screen VISIBILITY, and are deliberately false while the TMDb lookup is still
    // in flight (to avoid a flash of the field appearing then disappearing once it resolves) -
    // but that same "false while loading" state also skipped this required-field check
    // entirely if Confirm was pressed before the lookup finished, so a fast tap-through could
    // slip past a field TMDb was always going to come up empty for (this film genuinely has no
    // NZ rating certification on TMDb - confirmed directly against the saved row afterward).
    // Requiring an ACTUAL confirmed value (not loading, and TMDb genuinely returned one) closes
    // that gap: while still loading, nothing is confirmed yet, so it's correctly treated as
    // still-missing until the lookup resolves one way or the other, exactly like Genre
    // Location's own unconditional check above already behaves.
    const tmdbConfirmedRating = singleSelectedImdbId ? !tmdbPreviewLoading && !!tmdbPreview?.rating : false;
    const tmdbConfirmedStudio = singleSelectedImdbId ? !tmdbPreviewLoading && !!tmdbPreview?.studio : false;
    const tmdbConfirmedOriginalLanguage = singleSelectedImdbId
      ? !tmdbPreviewLoading && !!tmdbPreview?.originalLanguage
      : false;
    if (!rating.trim() && !tmdbConfirmedRating) missing.push("Rating");
    if (!studio.trim() && !tmdbConfirmedStudio) missing.push("Studio");
    if (!originalLanguage.trim() && !tmdbConfirmedOriginalLanguage) missing.push("Original Language");
    // Unlike Franchise, Animation/Live Action always has a real answer (every film either is
    // or isn't animated) - so once OMDB/TMDb hasn't confirmed "Live Action" (showAnimationField
    // true, per the user's own explicit request), leaving it blank is genuinely missing data,
    // not a legitimately-blank field, and blocks Confirm the same way Title/Format do.
    if (showAnimationField && !animationOrLiveAction.trim()) missing.push("Animation / Live Action");
    return missing;
  }

  /** Collection-mode equivalent of getMissingRequiredFields above - Name of Collection and at
   * least two members (matches the domain definition: a collection is "more than one movie" -
   * a single title isn't a collection). Every shared physical field (Format/Genre Location/
   * Disk Region/Disc Condition/...) reuses the exact same state as the single-title form, so
   * it's still worth checking, but the single-title-only checks above (TMDb override, the
   * Title-visibility-gated check, Rating/Studio/Original Language) don't apply here at all -
   * none of those concepts exist for a collection header, and each member resolves its own
   * Rating/Studio from TMDb individually once confirmed. */
  function getMissingCollectionFields(): string[] {
    const missing: string[] = [];
    if (!manualTitle.trim()) missing.push("Name of Collection");
    if (!movieOrTv.trim()) missing.push("Movie or TV");
    if (!rating.trim()) missing.push("Rating");
    if (collectionMembers.length < 2) missing.push("At least two titles in this collection");
    if (!format.trim()) missing.push("Format");
    if (!genreLocation.trim()) missing.push("Genre Location");
    if (diskRegions.size === 0) missing.push("Disk Region");
    if (!discCondition.trim()) missing.push("Disc Condition");
    if (totalDiscCountNumber < 1) missing.push("Total Disc Count");
    const membersMissingDiscs = collectionMembers.filter((m) => !m.discNumbers.trim()).map((m) => m.title);
    if (membersMissingDiscs.length > 0) missing.push(`Disc(s) for: ${membersMissingDiscs.join(", ")}`);
    const membersMissingFormat = collectionMembers.filter((m) => !m.format.trim()).map((m) => m.title);
    if (membersMissingFormat.length > 0) missing.push(`Format for: ${membersMissingFormat.join(", ")}`);
    // Added 2026-09-27 per the user's report that some already-catalogued collection titles
    // ended up with no rating at all - `m.tmdbRating` (captured in TitleSearchPicker.tsx the
    // same way `isFamilyOrKidsGenre`/`isAnimatedStyle` already are) means TMDb genuinely had
    // one, so only a member with neither a manual value nor a confirmed TMDb one is missing -
    // same unconditional-once-resolved treatment the single-title flow's own Rating check got
    // in the earlier race-condition fix (getMissingRequiredFields below), just per-member here.
    const membersMissingRating = collectionMembers.filter((m) => !m.rating?.trim() && !m.tmdbRating).map((m) => m.title);
    if (membersMissingRating.length > 0) missing.push(`Rating for: ${membersMissingRating.join(", ")}`);
    if (showHeaderSpecialFeaturesDiscFields) {
      if (bonusDiscs.length === 0) missing.push("Which disc is the collection's own bonus disc");
      if (!specialFeaturesDiscFormat.trim()) missing.push("Format of Special Features Discs (for the collection's own bonus disc)");
    }
    if (isHistoryDocumentary && !depictedEraLabel.trim()) missing.push("Depicted Era");
    return missing;
  }

  /** Confirm button: for a single (non-collection) title, check for a backfill match
   * before creating anything - only proceeds straight to performCreate() when there's
   * genuinely nothing to match against. */
  async function handleConfirmPressed() {
    setError(null);
    const missingFields = getMissingRequiredFields();
    if (missingFields.length > 0) {
      setError(`Please fill in before confirming: ${missingFields.join(", ")}.`);
      return;
    }
    if (showTmdbOverrideField && !tmdbIdOverride.trim()) {
      setError("TMDb has no match for this title - enter a TMDb link/id above to continue.");
      return;
    }

    // This barcode already belongs to a cataloged entry with certainty (same physical
    // disc) - skip the ordinary title-text similar-entry check and go straight to the
    // same Overwrite/Is-a-new-entry/Reject choice it would have produced anyway.
    if (existingMatch) {
      const posterUrl =
        existingMatch.case_image_url ??
        candidates.find((c) => c.imdbID === existingMatchImdbId)?.Poster ??
        null;
      setExistingCheck({
        status: "auto",
        match: {
          unique_id: existingMatch.unique_id,
          title: existingMatch.title,
          release_name: existingMatch.release_name,
          format: existingMatch.format,
          disc_count: existingMatch.disc_count,
          disk_region: existingMatch.disk_region,
          genre_location: existingMatch.genre_location,
          franchise: existingMatch.franchise,
          rating: existingMatch.rating,
          studio: existingMatch.studio,
          animation_or_live_action: existingMatch.animation_or_live_action,
          special_features: existingMatch.special_features,
          steelbook: existingMatch.steelbook,
          barcode_id: existingMatch.barcode_id,
          case_image_url: existingMatch.case_image_url,
          imdb_page: existingMatch.imdb_page,
          release_date: existingMatch.release_date,
          movie_or_tv: existingMatch.movie_or_tv,
          season_no: existingMatch.season_no,
          part_of_season_no: existingMatch.part_of_season_no,
          episode_count: existingMatch.episode_count,
          is_collection: Boolean(existingMatch.is_collection),
          title_in_a_collection: Boolean(existingMatch.title_in_a_collection),
          name_of_collection: existingMatch.name_of_collection ?? null,
          posterUrl,
        },
      });
      setChosenExistingId(existingMatch.unique_id);
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

    // Offline: the similar-entry check itself needs the network just as much as the actual
    // write does, so there's no point attempting it (and no confusing network-error message
    // to show for it) - go straight to performCreate(), which queues the submission on-device
    // and runs this exact same check for real once the connection is back (see
    // offlineQueue.ts's trySyncOfflineQueue).
    if (!(await getIsOnline())) {
      await performCreate();
      return;
    }

    setCheckingExisting(true);
    try {
      const upcText = `${scan.resolved_candidates?.upcProduct?.title ?? ""} ${scan.resolved_candidates?.upcProduct?.description ?? ""}`.trim();
      const parsedDiscCount = parseInt(discCount, 10);
      const result = await findExistingTitle(
        titleForMatch,
        upcText,
        singleSelectedImdbId ?? undefined,
        format,
        Number.isNaN(parsedDiscCount) ? undefined : parsedDiscCount
      );
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

  // ---- Collection scanning flow (added 2026-09-20) ----
  // See Claude/TECH STACK AND ARCHITECTURE/barcode-scanning-pipeline.md for the full design.

  function removeCollectionMember(key: string) {
    userManagedMembersRef.current = true;
    setCollectionMembers((prev) => prev.filter((m) => m.key !== key));
  }

  function toggleMemberWatchedDisc(key: string) {
    setCollectionMembers((prev) =>
      prev.map((m) => (m.key === key ? { ...m, watchedDisc: !m.watchedDisc, watched: !m.watchedDisc ? true : m.watched } : m))
    );
  }

  function toggleMemberWatched(key: string) {
    setCollectionMembers((prev) =>
      prev.map((m) => (m.key === key ? { ...m, watched: !m.watched, watchedDisc: !m.watched ? m.watchedDisc : false } : m))
    );
  }

  /** Manual top-down cascade for "Watched Collection"/"Watched Collection Disc" (the header
   * row's own watched/watched_disc, per the user's own spec): toggling this checkbox by hand
   * sets every current member to match in the same pass. Never fights the bottom-up
   * auto-derive effect above - setting every member to the same value makes that derivation
   * trivially agree afterward. */
  function toggleWatchedCollection() {
    setWatched((prev) => {
      const next = !prev;
      setCollectionMembers((members) => members.map((m) => ({ ...m, watched: next, watchedDisc: next ? m.watchedDisc : false })));
      if (!next) setWatchedDisc(false);
      return next;
    });
  }

  function toggleWatchedCollectionDisc() {
    setWatchedDisc((prev) => {
      const next = !prev;
      setCollectionMembers((members) => members.map((m) => ({ ...m, watchedDisc: next, watched: next ? true : m.watched })));
      if (next) setWatched(true);
      return next;
    });
  }

  /** The shared "one physical box" fields, spread identically into the header entry and
   * every member entry - per the user's own reasoning, a box set is one physical object and
   * can't sit in two shelf locations, have two disc counts, etc. at once, so there's exactly
   * one value of each. Deliberately excludes `cut_suffix` (upcCutVariant, below) even though
   * every other physical field here is shared - a detected "cut" is a property of one film's
   * own edition, not of a box's listing text, and the box's own product title only rarely
   * contains anything that pattern would even match; sending it here risked silently
   * appending irrelevant box-listing text onto the Name of Collection or every member's title. */
  /** The fields that genuinely describe the one physical box/case as a whole, spread
   * identically into the header entry and every member entry - per the user's own reasoning,
   * a box set is one physical object and can't sit in two shelf locations at once, so there's
   * exactly one value of each. Format/Disc Count/Special Features moved OUT of this bucket
   * (2026-09-20) - each title in a box set typically has its own separate disc(s), which can
   * genuinely differ from other titles (the user's own real example: every title had its own
   * 4K UHD disc plus its own Blu-ray special-features disc) - see performCreateCollection's
   * own header/member construction for where those now live instead. `release_name` moved
   * OUT too, same day - the user pointed out a definitive/remastered edition of one specific
   * film is sometimes bundled into an otherwise-ordinary box set, so a member needs its own
   * independent Release Name rather than inheriting the collection's own (set directly on the
   * header entry in performCreateCollection; each member gets its own from `m.releaseName`,
   * asked in TitleSearchPicker). */
  function buildSharedCollectionFields(): Record<string, unknown> {
    return {
      disk_region: diskRegions.size > 0 ? [...diskRegions].join(", ") : null,
      genre_location: genreLocation || null,
      case_image_url: scan.resolved_candidates?.upcProduct?.imageUrl ?? null,
      release_variant_note: releaseVariantNote.trim() || null,
      disc_condition: discCondition,
      case_notes: caseNotes.trim() || null,
      // 0037_add_unintentional_collection.sql - flips the Estimated Value pipeline's usual
      // "price the header, skip the members" rule for a set that's really just unrelated films
      // a previous owner put in one disc case, not a genuine box-set product. Sent on the
      // header AND every member (this whole object is spread into both) since the eligibility
      // queries filter by this flag on the row being priced, not by looking up the header.
      unintentional_collection: unintentionalCollection,
      steelbook,
      // Optional collection-wide animation style ("2D 3D Hybrid Animation"); blank lets each title
      // use its own TMDb-detected value and the header derive from them.
      animation_or_live_action: animationOrLiveAction.trim() || undefined,
      is_currently_rented_out: isCurrentlyRentedOut,
      rented_by_who: isCurrentlyRentedOut ? rentedByWho.trim() || null : null,
      date_rented: isCurrentlyRentedOut ? dateRented || null : null,
      depicted_era_label: isHistoryDocumentary ? depictedEraLabel.trim() || null : null,
    };
  }

  /** Builds and submits the header + every member entry in one request - the ONLY point in
   * the whole Collection flow that ever writes anything to Supabase/the Sheet, per the user's
   * own explicit requirement: nothing is pushed until the collection and every one of its
   * titles has the right details, then it all goes in one action. `overwriteDecisions` maps
   * "header" and each member's own `key` to the existing row it should overwrite, if the
   * duplicate-check queue (handleConfirmCollectionPressed below) resolved that entry to
   * "Overwrite" - an entry with no decision (or an empty queue, the common case) is a plain
   * fresh insert, same as `entry.overwriteUniqueId` being undefined always means elsewhere.
   * Online-only, deliberately not wired into the offline queue (offlineQueue.ts) - that
   * queue's resync logic is built around a single title-text match/single overwrite target,
   * which doesn't fit a submission whose own per-entry overwrite decisions are already
   * resolved live before this point; scoping this out rather than bending that queue's shape
   * to fit is the simpler, lower-risk choice for this pass. */
  async function performCreateCollection(overwriteDecisions: Record<string, string | undefined>) {
    setSubmitting(true);
    // Scroll to the bottom (where the Confirm button now reads "Saving..." and the loading bar
    // sits) instead of letting the form snap back to the top - a Collection save takes a
    // few seconds and the user wants to watch it happen (2026-09-20). Delayed a beat so it runs
    // after the screen has finished switching back from the duplicate-resolution view, if any.
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 250);
    setError(null);
    // A real determinate progress bar (2026-09-27, ProgressBar.tsx - see its own comment on
    // why this is a time-based estimate, not exact backend progress: the header+members submit
    // as one atomic request specifically so a later entry's validation failure can never leave
    // an earlier one already written, which rules out genuine per-entry progress without a much
    // bigger streaming-response change). Eases toward a 95% cap rather than reaching it outright,
    // so it never falsely claims "done" for a collection that's actually still writing - the real
    // completion (100%) only ever happens once the request genuinely resolves, below.
    //
    // Decay rate tightened from -2 to -4 (2026-09-27, fixing a real reported bug: the bar "moves
    // smoothly until the last 16th and then moves at a snail's pace, and the title is submitted
    // before the loading bar gets to the end"). The old -2 rate only reached ~80% of its own cap
    // by the time the ESTIMATE itself fully elapsed (0.92*(1-e^-2) = 0.80), meaning most of a
    // real submit's whole duration was spent crawling through the flattest, slowest-feeling part
    // of the curve, then snapping a large, jarring distance to 100% the moment the real response
    // landed. At -4, the curve is already at ~93% of its cap by the time the estimate elapses
    // (0.95*(1-e^-4) = 0.933) and essentially fully capped soon after - so a submit that takes
    // roughly as long as estimated reads as "fast, then briefly holds near done" rather than
    // "slows to a crawl," and the final jump to 100% is small either way. A submit slower than
    // estimated still just holds flat at the 95% cap waiting for the real response, which reads
    // as "almost done" rather than broken.
    setSubmitProgress(0);
    const estimatedMs = (collectionMembers.length + 1) * 900;
    const progressStartedAt = Date.now();
    const progressInterval = setInterval(() => {
      const elapsed = (Date.now() - progressStartedAt) / estimatedMs;
      setSubmitProgress(0.95 * (1 - Math.exp(-4 * elapsed)));
    }, 150);
    try {
      const shared = buildSharedCollectionFields();
      // Colon-suffix disambiguation convention (barcode-scanning-pipeline.md's Collections
      // section): `<Name of Collection>: <Title1>, <Title2>, ...` - applied automatically now
      // rather than typed in by hand, since it's exactly the same real, comma-separated list
      // of member titles every time, and the user's own real data already follows this exact
      // format (e.g. "The Alfred Hitchcock Classics: Rear Window, Psycho, The Birds, Vertigo").
      // Both `title` and `name_of_collection` use it - `name_of_collection` must match exactly
      // across the header and every member (it's the join key find-existing/route.ts's fuzzy
      // match and the Sheet aggregation both group by), so members get this same full name too.
      const baseCollectionName = manualTitle.trim();
      const memberTitleList = collectionMembers.map((m) => m.title).join(", ");
      // A name that already lists every added title is kept exactly as typed (2026-09-20).
      const nameOfCollection =
        memberTitleList && !nameListsAllTitles(baseCollectionName, collectionMembers.map((m) => m.title))
          ? `${baseCollectionName}: ${memberTitleList}`
          : baseCollectionName;
      const headerEntry: ConfirmEntry = {
        barcodeId: scan.barcode ?? undefined,
        overwriteUniqueId: overwriteDecisions["header"],
        manualFields: {
          ...shared,
          title: nameOfCollection,
          movie_or_tv: movieOrTv || null,
          is_collection: true,
          name_of_collection: nameOfCollection,
          title_in_a_collection: false,
          number_of_titles_in_collection: collectionMembers.length,
          watched,
          watched_disc: watchedDisc,
          // The header's own disc fields (added 2026-09-20): `format` still describes the box
          // as a whole (still a plain manual field, unlike disc_count below), and
          // special_features/its sub-fields describe a bonus disc belonging to the collection
          // itself, separate from any title's own - `disc_count` is NOT the shared-step value
          // any more, it's the real total across every physical disc in the box (every
          // member's own disc_count, plus the collection's own bonus disc(s) if it has one).
          format,
          disc_count: totalDiscCountNumber || 1,
          special_features: specialFeatures,
          special_features_disc_count: showHeaderSpecialFeaturesDiscFields ? bonusDiscs.length || null : null,
          // Which numbered disc(s) hold the collection's own bonus features - stored in the
          // header's own disc_number_in_set (the same column each member uses for "which disc(s)
          // am I on"), so the shape of the data is the same at both levels.
          disc_number_in_set: showHeaderSpecialFeaturesDiscFields ? [...bonusDiscs].sort((x, y) => x - y).join(",") || null : null,
          special_features_disc_format: showHeaderSpecialFeaturesDiscFields ? specialFeaturesDiscFormat || null : null,
          // Release Name describes the box's own edition/packaging (e.g. "The Coppola
          // Restoration") - a member's own is independent, since a definitive/remastered cut
          // of one specific film can be bundled into an otherwise-ordinary box set. When
          // "Same as name" is checked, this deliberately stores `baseCollectionName` (the
          // plain name actually printed on the box) rather than null - unlike the single-title
          // flow (where null correctly means "release_name would just duplicate title, so skip
          // it"), a collection header's own `title`/`name_of_collection` always differ from the
          // box's own printed name once the colon+member-list suffix is appended, so nulling
          // this out would silently discard the one real fact the checkbox was confirming
          // (found 2026-09-20 - the user asked this be checked after this exact ambiguity).
          // A generic name ("2 Movie Collection") identifies nothing by itself, so no Release Name.
          release_name: isGenericCollectionName(baseCollectionName)
            ? null
            : releaseNameMatchesTitle
              ? baseCollectionName || null
              : releaseName.trim() || null,
          // Rating (#7): the collection's own classification as printed on the box - always a
          // plain manual field, since there's no TMDb id for a header to auto-fill it from.
          rating: rating.trim() || null,
          // Studio doubles as "Distributor" here - only actually used server-side as a
          // fallback when no single studio is common among every member (see the confirm
          // route's own aggregation comment) - the box's publisher (e.g. Universal) is a real,
          // different fact from any one film's own original production company.
          studio: studio.trim() || null,
        },
      };
      const memberEntries: ConfirmEntry[] = collectionMembers.map((m) => ({
        imdbId: m.imdbId,
        // Individual titles inside a box set have no barcode of their own - the box's own
        // barcode is shared onto every member, per the user's own explicit request, so a
        // future rescan of any single disc from this set can still resolve back to it.
        barcodeId: scan.barcode ?? undefined,
        overwriteUniqueId: overwriteDecisions[m.key],
        manualFields: {
          ...shared,
          title: m.title,
          movie_or_tv: m.movieOrTv || null,
          season_no: m.seasonNo || null,
          part_of_season_no: m.partOfSeasonNo || null,
          episode_count: m.episodeCount ? parseInt(m.episodeCount, 10) || null : null,
          franchise: m.franchise ? m.franchise.split(",").map((f) => f.trim()).filter(Boolean) : [],
          // Manual Rating fallback (2026-09-27) - see TitleSearchPicker's CollectionMember.rating
          // comment. The confirm route's own per-entry manualRating ?? tmdbFields.rating ??
          // omdbRating precedence already applied to every entry uniformly; this was simply
          // never populated for a member before, so a title with no TMDb rating silently ended
          // up with none saved at all.
          rating: m.rating?.trim() || null,
          is_collection: false,
          title_in_a_collection: true,
          name_of_collection: nameOfCollection,
          // Same total as the header's own - per the user's own request, every title in the
          // set should show how many titles the collection it belongs to actually has.
          number_of_titles_in_collection: collectionMembers.length,
          watched: m.watched,
          watched_disc: m.watchedDisc,
          // This title's own disc(s) - set per-member now (2026-09-20), since different
          // titles in the same box can genuinely have different disc configurations.
          format: m.format,
          disc_count: parseInt(m.discCount, 10) || 1,
          special_features: m.specialFeatures,
          special_features_disc_count: m.specialFeaturesDiscCount ? parseInt(m.specialFeaturesDiscCount, 10) || null : null,
          special_features_disc_format: m.specialFeaturesDiscFormat ?? null,
          // Which of the set's own numbered discs actually hold this title's special features -
          // can genuinely differ from disc_number_in_set below (its own movie disc(s)), e.g. a
          // bonus disc shared with other titles. See TitleSearchPicker's own comment on
          // CollectionMember.specialFeaturesDiscNumbers.
          special_features_disc_number_in_set: m.specialFeaturesDiscNumbers?.trim() || null,
          // This title's own Release Name, independent of the collection's - see the comment
          // on the header entry above.
          release_name: m.releaseName?.trim() || null,
          // Which physical disc(s) this title is on within the set - ticked from the header's
          // Total Disc Count checkbox list; disc_count above is just how many it ticked.
          disc_number_in_set: m.discNumbers?.trim() || null,
        },
      }));

      // Background write, same as performCreate's (see its own comment) - the progress bar
      // above only covers building the entries now; the save itself is tracked on
      // SuccessScreen / the banner.
      const submissionId = startBackgroundSubmission(scan.id, baseCollectionName || "Collection", async () => {
        const result = await confirmScan(scan.id, [headerEntry, ...memberEntries]);
        clearConfirmDraft(scan.id);
        loadFieldOptions(true);
        return { shelfLocation: result.shelfLocation };
      });
      clearInterval(progressInterval);
      setSubmitProgress(1);
      onConfirmed({ submissionId });
    } catch (err) {
      clearInterval(progressInterval);
      setSubmitProgress(0);
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  /** Confirm button for the collection flow - validates every required field first, then
   * (per the user's own explicit request, 2026-09-20) runs a single collection-scoped
   * duplicate check for the collection AS A WHOLE, passing every currently-added member's own
   * title along (`collectionMemberTitles`) so find-existing's fuzzy match can use member-title
   * overlap as its strongest signal - see find-existing/route.ts's own comment. A "none" result
   * (the common case) skips straight to submission with no overwrite decisions at all. */
  /** Same test the server uses for collection members (find-existing/route.ts): a shared IMDb id,
   * or titles equal once every space/hyphen/colon/case difference is ignored ("Spider-Man: Into the
   * Spider-Verse" vs "Spiderman into the Spiderverse"). */
  function memberMatchesExisting(m: CollectionMember, e: { title: string; imdbId?: string | null }): boolean {
    if (m.imdbId && e.imdbId && m.imdbId === e.imdbId) return true;
    const loose = (t: string) => normalizeTitleForMatch(t).replace(/\s+/g, "");
    return loose(m.title) === loose(e.title);
  }

  async function handleConfirmCollectionPressed() {
    setError(null);
    const missingFields = getMissingCollectionFields();
    if (missingFields.length > 0) {
      setError(`Please fill in before confirming: ${missingFields.join(", ")}.`);
      return;
    }
    if (!(await getIsOnline())) {
      setError("A collection scan needs an internet connection to check for duplicates before saving - please reconnect and try again.");
      return;
    }
    setCheckingCollectionDuplicates(true);
    try {
      const nameOfCollection = manualTitle.trim();
      const result = await findExistingTitle(
        nameOfCollection,
        "",
        undefined,
        format,
        undefined,
        true,
        collectionMembers.map((m) => m.title),
        collectionMembers.map((m) => m.imdbId)
      );
      if (result.status === "none") {
        await performCreateCollection({});
        return;
      }
      setCollectionMatchCheck(result);
      setChosenCollectionMatchId(result.status === "auto" ? result.match.unique_id : null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCheckingCollectionDuplicates(false);
    }
  }

  /** Resolves the single collection-wide match decision. "New entry" submits with no
   * overwrite decisions at all - every entry inserts fresh, same as the no-match case. Given
   * an existing collection to overwrite, "Overwrite" resolves the WHOLE decision at once: the
   * header itself overwrites the chosen candidate, and each of the new collection's own
   * members is independently matched against that one candidate's own already-catalogued
   * members (`existingMemberTitles`) by exact normalized title - a match becomes that
   * member's own overwrite target; no match means it's a genuinely new addition to the
   * collection (a title being added to a set that didn't have it before), never blocked. */
  async function resolveCollectionMatch(chosenMatch: ExistingTitleCandidate | null) {
    if (!chosenMatch) {
      setCollectionMatchCheck(null);
      setChosenCollectionMatchId(null);
      await performCreateCollection({});
      return;
    }
    // A member-only group (older set with no header row of its own) must never become the header's
    // overwrite target - the header is simply inserted fresh, only the matching members overwrite.
    const decisions: Record<string, string | undefined> = chosenMatch.memberOnlyGroup ? {} : { header: chosenMatch.unique_id };
    const existingMembers = chosenMatch.existingMemberTitles ?? [];
    for (const m of collectionMembers) {
      const existingMatch = existingMembers.find((e) => memberMatchesExisting(m, e));
      if (existingMatch) decisions[m.key] = existingMatch.unique_id;
    }
    setCollectionMatchCheck(null);
    setChosenCollectionMatchId(null);
    await performCreateCollection(decisions);
  }

  if (collectionMatchCheck) {
    const matchCandidates: ExistingTitleCandidate[] =
      collectionMatchCheck.status === "auto" ? [collectionMatchCheck.match] : collectionMatchCheck.candidates;
    const chosenMatch = matchCandidates.find((c) => c.unique_id === chosenCollectionMatchId) ?? null;
    const overlapCount = chosenMatch
      ? collectionMembers.filter((m) => (chosenMatch.existingMemberTitles ?? []).some((e) => memberMatchesExisting(m, e))).length
      : 0;

    return (
      <ScrollView
        style={styles.container}
        contentContainerStyle={[styles.scrollContent, { paddingTop: 48 + insets.top, paddingBottom: 24 + insets.bottom }]}
      >
        <Text style={styles.title}>Matches an existing collection</Text>
        {collectionMatchCheck.status === "auto" ? (
          <Text style={styles.body}>
            This looks like your existing &quot;{collectionMatchCheck.match.title}&quot; collection. Compare it
            against what you just added, then choose what to do.
          </Text>
        ) : (
          <>
            <Text style={styles.body}>A few of your existing collections could be this one. Which is it?</Text>
            {matchCandidates.map((c) => (
              <TouchableOpacity
                key={c.unique_id}
                style={[styles.candidateRow, chosenCollectionMatchId === c.unique_id && styles.candidateRowSelected]}
                onPress={() => setChosenCollectionMatchId(c.unique_id)}
              >
                <Text style={styles.candidateText}>
                  {chosenCollectionMatchId === c.unique_id ? "(o) " : "( ) "}
                  {c.title} - {c.format}, {c.disc_count} disc{c.disc_count === 1 ? "" : "s"}
                </Text>
              </TouchableOpacity>
            ))}
          </>
        )}

        {chosenMatch && (
          <View style={styles.section}>
            {chosenMatch.posterUrl ? (
              <Image source={{ uri: chosenMatch.posterUrl }} style={styles.scannedImage} resizeMode="cover" />
            ) : null}
            <Text style={styles.label}>Existing collection</Text>
            <Text style={styles.body}>
              {chosenMatch.format}, {chosenMatch.disc_count} disc{chosenMatch.disc_count === 1 ? "" : "s"}
              {chosenMatch.genre_location ? ` - Shelf: ${chosenMatch.genre_location}` : ""}
            </Text>
            <Text style={styles.body}>
              {chosenMatch.barcode_id ? `Barcode already on file: ${chosenMatch.barcode_id}.` : "No barcode on file yet."}
            </Text>
            {(chosenMatch.existingMemberTitles?.length ?? 0) > 0 && (
              <Text style={styles.hint}>
                {overlapCount} of the {chosenMatch.existingMemberTitles?.length} title
                {chosenMatch.existingMemberTitles?.length === 1 ? "" : "s"} already in it match{overlapCount === 1 ? "es" : ""} a
                title you just added - those will be overwritten in place, and any of your new titles it doesn&apos;t
                already have will be added to it.
              </Text>
            )}
          </View>
        )}

        {error && <Text style={styles.error}>{error}</Text>}

        <TouchableOpacity
          style={[styles.button, styles.buttonGreen]}
          onPress={() => resolveCollectionMatch(null)}
          disabled={submitting}
        >
          <Text style={styles.buttonText}>Is a new entry - I genuinely own a separate collection</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.button}
          onPress={() => resolveCollectionMatch(chosenMatch)}
          disabled={submitting || !chosenMatch}
        >
          <Text style={styles.buttonText}>
            {submitting ? "Saving..." : "Overwrite - replace it with this scan"}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.button, styles.buttonRed]} onPress={handleDiscard} disabled={submitting}>
          <Text style={styles.buttonText}>Reject this whole scan - don&apos;t add any of it</Text>
        </TouchableOpacity>
      </ScrollView>
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
            This looks like your existing entry for &quot;{existingCheck.match.title}&quot;
            {existingCheck.match.release_name ? ` (${existingCheck.match.release_name})` : ""}. Compare it
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
                  {c.title}
                  {/* release_name is the real disambiguator between two rows sharing the same
                      base title (e.g. a plain DVD vs. a "Special Edition") - added 2026-09-18,
                      since the title text alone can't tell them apart here. */}
                  {c.release_name ? ` (${c.release_name})` : ""} - {c.format}, {c.disc_count} disc
                  {c.disc_count === 1 ? "" : "s"}
                  {c.barcode_id ? "" : " (no barcode yet)"}
                </Text>
              </TouchableOpacity>
            ))}
          </>
        )}

        {chosen && (
          <View style={styles.section}>
            {chosen.posterUrl ? (
              <Image source={{ uri: chosen.posterUrl }} style={styles.scannedImage} resizeMode="cover" />
            ) : null}
            <Text style={styles.label}>Existing entry</Text>
            {chosen.release_name && <Text style={styles.body}>Release: {chosen.release_name}</Text>}
            <Text style={styles.body}>
              {chosen.format}, {chosen.disc_count} disc{chosen.disc_count === 1 ? "" : "s"}
              {chosen.disk_region ? ` - Region ${chosen.disk_region}` : ""}
              {chosen.release_date ? ` - ${chosen.release_date.slice(0, 4)}` : ""}
            </Text>
            {/* Each field gets its own labeled line (fixed 2026-10-02) - previously all of
                Animation/Rating/Studio ran on, unlabeled, right after "Franchise: ...", which
                read as if they were all part of the franchise list itself. */}
            {chosen.genre_location && <Text style={styles.body}>Shelf: {chosen.genre_location}</Text>}
            {chosen.franchise.length > 0 && (
              <Text style={styles.body}>Franchise: {chosen.franchise.join(", ")}</Text>
            )}
            {chosen.animation_or_live_action && (
              <Text style={styles.body}>Animation: {chosen.animation_or_live_action}</Text>
            )}
            {chosen.rating && <Text style={styles.body}>Rating: {chosen.rating}</Text>}
            {chosen.studio && <Text style={styles.body}>Studio: {chosen.studio}</Text>}
            <Text style={styles.body}>
              {chosen.special_features ? "Has special features. " : ""}
              {chosen.steelbook ? "Steelbook. " : ""}
              {chosen.barcode_id ? `Barcode already on file: ${chosen.barcode_id}.` : "No barcode on file yet."}
            </Text>
          </View>
        )}

        {error && <Text style={styles.error}>{error}</Text>}

        <TouchableOpacity
          style={[styles.button, styles.buttonGreen]}
          onPress={handleTreatAsNew}
          disabled={submitting}
        >
          <Text style={styles.buttonText}>Is a new entry - I genuinely own a separate copy</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.button}
          onPress={handleOverwriteExisting}
          disabled={submitting || !chosenExistingId}
        >
          <Text style={styles.buttonText}>{submitting ? "Saving..." : "Overwrite - replace it with this scan"}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.button, styles.buttonRed]}
          onPress={handleDiscard}
          disabled={submitting}
        >
          <Text style={styles.buttonText}>Reject - this scan shouldn&apos;t be added at all</Text>
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
      <OfflineBanner />
      {categoryWarning && (
        <View style={styles.categoryWarning}>
          <Text style={styles.categoryWarningText}>
            This barcode&apos;s catalog category doesn&apos;t look like a DVD/Blu-ray (&quot;{categoryWarning}&quot;) - double-check this is the right disc before confirming.
          </Text>
        </View>
      )}
      <TouchableOpacity onPress={onBack}>
        <Text style={styles.link}>{"< Pending Scans"}</Text>
      </TouchableOpacity>
      <Text style={styles.title}>{scan.barcode ? `Barcode ${scan.barcode}` : "New Entry"}</Text>

      {(isCollectionOverride || needsTitleSearch || activeSlide === "title" || (activeSlide === "summary" && selected.size === 0)) && (
      <TouchableOpacity style={styles.checkboxRow} onPress={() => setIsCollectionOverride((prev) => !prev)}>
        <View style={[styles.checkbox, isCollectionOverride && styles.checkboxChecked]}>
          {isCollectionOverride && <Text style={styles.checkboxMark}>✓</Text>}
        </View>
        <Text style={styles.checkboxLabel}>This is a collection / box set (more than one movie in this case)</Text>
      </TouchableOpacity>
      )}
      {autoDetectedCollection !== isCollectionOverride && (isCollectionOverride || needsTitleSearch || activeSlide === "title" || (activeSlide === "summary" && selected.size === 0)) && (
        <Text style={styles.hint}>Overriding the automatic guess.</Text>
      )}

      {isCollectionOverride ? (
        (() => {
          // Collection version of the single-title SlideFlow below (2026-09-22, per the
          // user's own explicit request to bring the "slideshow style" to Collections too) -
          // same SlideFlow/BigChoice/SummaryRow components, same activeSlide/slideReturn/
          // openRow state (shared with the single-title flow; harmless if a stale key from
          // the other mode briefly doesn't match one of these slides, since SlideFlow already
          // falls back to its first slide rather than crashing). Every field below is the
          // exact same state/handler this branch always used - only the JSX layout changed,
          // grouped into themed slides instead of one long scroll, mirroring the single-title
          // flow's own grouping (title/format/discs/location/franchise/release/details/
          // summary) as closely as this screen's different fields allow.
          const collectionNameNode = (
            <>
              <View style={styles.section}>
                <Text style={styles.label}>Name of Collection</Text>
                <TextInput
                  ref={manualTitleInputRef}
                  style={styles.input}
                  value={manualTitle}
                  onChangeText={setManualTitle}
                  onFocus={() => scrollInputRefIntoView(manualTitleInputRef)}
                  placeholder="e.g. Alfred Hitchcock: A Collection of 10 Classic Movies"
                  placeholderTextColor="#71717a"
                />
                <Text style={styles.hint}>
                  Just the base name - as you add titles below, this automatically becomes &quot;{"<name>"}: Title 1,
                  Title 2, ...&quot; so a box set sharing this same base name with a different set of titles can still be
                  told apart.
                </Text>
                {autoMatching && <Text style={styles.hint}>Looking up the film titles in this name...</Text>}
                {previewCollectionName !== "" && (
                  <Text style={styles.hint}>
                    Will be saved as: {previewCollectionName}
                    {collectionNameListsTitles ? " (this name already lists the titles, so nothing is added to it)" : ""}
                  </Text>
                )}
              </View>
              <View style={styles.section}>
                <Text style={styles.label}>Collection Type (Movie or TV)</Text>
                <SelectDropdown options={fieldOptions?.movieOrTv ?? [movieOrTv].filter(Boolean)} value={movieOrTv} onChange={setMovieOrTv} />
              </View>
              <View style={styles.section}>
                <Text style={styles.label}>Rating (as printed on the box)</Text>
                {collectionCommonRatings.length > 0 && (
                  <>
                    <Text style={styles.hint}>
                      {collectionAllMembersFamilyOrKids && collectionAllMembersAnimated
                        ? "Common for a family/kids animated set:"
                        : `Common for ${collectionSharedFranchiseTags[0]}:`}
                    </Text>
                    <SingleSelectChips options={collectionCommonRatings} value={rating} onChange={setRating} />
                  </>
                )}
                <SearchableModalInput value={rating} onChangeText={setRating} options={fieldOptions?.rating ?? []} />
              </View>
              <View style={styles.section}>
                <Text style={styles.label}>Distributor (optional)</Text>
                <SearchableModalInput value={studio} onChangeText={setStudio} options={fieldOptions?.studio ?? []} />
                <Text style={styles.hint}>
                  Only used if no single studio turns out to be common among the titles you add below - the box&apos;s
                  own publisher (e.g. Universal), not any one film&apos;s original production company.
                </Text>
              </View>
              <TouchableOpacity style={styles.checkboxRow} onPress={toggleWatchedCollectionDisc}>
                <View style={[styles.checkbox, watchedDisc && styles.checkboxChecked]}>
                  {watchedDisc && <Text style={styles.checkboxMark}>✓</Text>}
                </View>
                <Text style={styles.checkboxLabel}>Watched Collection Disc (every disc in this set watched)</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.checkboxRow} onPress={toggleWatchedCollection}>
                <View style={[styles.checkbox, watched && styles.checkboxChecked]}>
                  {watched && <Text style={styles.checkboxMark}>✓</Text>}
                </View>
                <Text style={styles.checkboxLabel}>Watched Collection (every film in this set watched)</Text>
              </TouchableOpacity>
              <Text style={styles.hint}>
                Checking either box above marks every title already added the same way. Set this before adding
                titles and their own Watched/Watched Disc checkboxes won&apos;t even be asked - they&apos;ll
                already match. Each title's own checkboxes still show up afterward in the list below, in case one
                title genuinely differs.
              </Text>
            </>
          );
          const collectionCommonFormats = (fieldOptions?.format ?? []).filter((f) => /^(dvd|blu-?ray|4k uhd blu-?ray)$/i.test(f.trim()));
          const collectionFormatNode = (
            <>
              <View style={styles.section}>
                <Text style={styles.label}>Format (the box's own general format)</Text>
                <BigChoice options={collectionCommonFormats} value={format} onChange={setFormat} />
                <Text style={styles.hint}>Something else (VHS, 3D, HD DVD...)? Pick it here:</Text>
                <SearchableModalInput
                  value={format}
                  onChangeText={setFormat}
                  options={fieldOptions?.format ?? []}
                  onFocusScroll={scrollFieldIntoView}
                />
                <Text style={styles.hint}>
                  Each title below also gets its own Format, in case any title's discs differ from
                  the rest.
                </Text>
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
                <Text style={styles.label}>Animation or Live Action (optional - applies to every title)</Text>
                <SearchableModalInput
                  value={animationOrLiveAction}
                  onChangeText={setAnimationOrLiveAction}
                  options={fieldOptions?.animationOrLiveAction ?? []}
                  onFocusScroll={scrollFieldIntoView}
                />
                <Text style={styles.hint}>
                  For an animated set, type or pick the style (e.g. 2D 3D Hybrid Animation). Leave blank and each
                  title uses what TMDb says, with the collection taking the shared value (or Hybrid if they differ).
                </Text>
              </View>
              <View style={[styles.section, styles.row]}>
                <Text style={styles.label}>Steelbook</Text>
                <Switch value={steelbook} onValueChange={setSteelbook} />
              </View>
            </>
          );
          const collectionDiscsNode = (
            <>
              <View style={styles.section}>
                <Text style={styles.label}>Total Disc Count</Text>
                <TextInput
                  ref={collectionDiscCountInputRef}
                  style={styles.input}
                  value={collectionDiscCount}
                  onChangeText={(text) => {
                    const next = digitsOnly(text);
                    setCollectionDiscCount(next);
                    const max = parseInt(next, 10) || 0;
                    setBonusDiscs((prev) => prev.filter((n) => n <= max));
                  }}
                  onFocus={() => scrollInputRefIntoView(collectionDiscCountInputRef)}
                  keyboardType="number-pad"
                  placeholder="e.g. 2"
                  placeholderTextColor="#71717a"
                />
                <Text style={styles.hint}>
                  Every physical disc in the box, the collection&apos;s own bonus disc included. Each title you add
                  below then just ticks which of these discs it&apos;s on.
                </Text>
              </View>
              <View style={[styles.section, styles.row]}>
                <Text style={styles.label}>Special Features (a bonus disc for the whole collection)</Text>
                <Switch value={specialFeatures} onValueChange={setSpecialFeatures} />
              </View>
              {showHeaderSpecialFeaturesDiscFields && (
                <>
                  <View style={styles.section}>
                    <Text style={styles.label}>Which disc is the bonus disc?</Text>
                    {totalDiscCountNumber > 0 ? (
                      Array.from({ length: totalDiscCountNumber }, (_, i) => i + 1).map((n) => {
                        const checked = bonusDiscs.includes(n);
                        return (
                          <TouchableOpacity
                            key={n}
                            style={styles.checkboxRow}
                            onPress={() => setBonusDiscs((prev) => (prev.includes(n) ? prev.filter((d) => d !== n) : [...prev, n]))}
                          >
                            <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
                              {checked && <Text style={styles.checkboxMark}>✓</Text>}
                            </View>
                            <Text style={styles.checkboxLabel}>Disc {n}</Text>
                          </TouchableOpacity>
                        );
                      })
                    ) : (
                      <Text style={styles.hint}>Enter the Total Disc Count above first, then pick the bonus disc here.</Text>
                    )}
                  </View>
                  <View style={styles.section}>
                    <Text style={styles.label}>Format of Special Features Discs</Text>
                    <SearchableModalInput
                      value={specialFeaturesDiscFormat}
                      onChangeText={setSpecialFeaturesDiscFormat}
                      options={fieldOptions?.format ?? []}
                      onFocusScroll={scrollFieldIntoView}
                    />
                  </View>
                </>
              )}
            </>
          );
          const collectionLocationNode = (
            <>
              <View style={styles.section}>
                <Text style={styles.label}>Genre Location (shelf section)</Text>
                <BigChoice
                  options={rankGenreLocationOptions(
                    filterGenreLocationOptions(fieldOptions?.genreLocation ?? [], true, movieOrTv),
                    genreSignalForLocationRanking,
                    4
                  )}
                  value={genreLocation}
                  onChange={setGenreLocation}
                />
                <Text style={styles.hint}>Not listed? Type a new one here:</Text>
                <SearchableModalInput
                  value={genreLocation}
                  onChangeText={setGenreLocation}
                  options={filterGenreLocationOptions(fieldOptions?.genreLocation ?? [], true, movieOrTv)}
                  placeholder="e.g. COLLECTION Person"
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
            </>
          );
          const collectionReleaseNode = (
            <>
              {collectionNameIsGeneric ? (
                <Text style={styles.hint}>
                  This name is generic, so it doesn&apos;t need a Release Name - it will be saved without one.
                </Text>
              ) : (
                <View style={styles.section}>
                  <View style={styles.row}>
                    <Text style={styles.label}>Release Name (if different from the collection name)</Text>
                    <TouchableOpacity style={styles.checkboxRow} onPress={() => setReleaseNameMatchesTitle((prev) => !prev)}>
                      <View style={[styles.checkbox, releaseNameMatchesTitle && styles.checkboxChecked]}>
                        {releaseNameMatchesTitle && <Text style={styles.checkboxMark}>✓</Text>}
                      </View>
                      <Text style={styles.checkboxLabel}>Same as name</Text>
                    </TouchableOpacity>
                  </View>
                  <TextInput
                    ref={releaseNameInputRef}
                    style={styles.input}
                    value={releaseName}
                    onChangeText={(text) => {
                      setReleaseName(text);
                      setReleaseNameMatchesTitle(text.trim().length === 0);
                    }}
                    onFocus={() => scrollInputRefIntoView(releaseNameInputRef)}
                    placeholder="e.g. The Coppola Restoration"
                    placeholderTextColor="#71717a"
                  />
                </View>
              )}
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
              <TouchableOpacity
                style={styles.checkboxRow}
                onPress={() => setUnintentionalCollection((prev) => !prev)}
              >
                <View style={[styles.checkbox, unintentionalCollection && styles.checkboxChecked]}>
                  {unintentionalCollection && <Text style={styles.checkboxMark}>✓</Text>}
                </View>
                <Text style={styles.checkboxLabel}>Unintentional collection (unrelated movies sharing one case)</Text>
              </TouchableOpacity>
              {unintentionalCollection && (
                <Text style={styles.hint}>
                  Estimated Value will price each title in this set individually instead of the set as a whole.
                </Text>
              )}
            </>
          );
          const collectionDetailsNode = (
            <>
              <View style={styles.section}>
                <Text style={styles.label}>Disc Condition</Text>
                <SingleSelectChips options={DISC_CONDITION_VALUES} value={discCondition} onChange={setDiscCondition} />
              </View>
              <TouchableOpacity
                style={styles.checkboxRow}
                onPress={() =>
                  setIsCurrentlyRentedOut((prev) => {
                    const next = !prev;
                    if (!next) {
                      setRentedByWho("");
                      setDateRented("");
                      setShowDateRentedPicker(false);
                    }
                    return next;
                  })
                }
              >
                <View style={[styles.checkbox, isCurrentlyRentedOut && styles.checkboxChecked]}>
                  {isCurrentlyRentedOut && <Text style={styles.checkboxMark}>✓</Text>}
                </View>
                <Text style={styles.checkboxLabel}>Currently rented out</Text>
              </TouchableOpacity>
              {isCurrentlyRentedOut && (
                <>
                  <View style={styles.section}>
                    <Text style={styles.label}>Rented By Who</Text>
                    <SearchableModalInput
                      value={rentedByWho}
                      onChangeText={setRentedByWho}
                      options={fieldOptions?.rentedByWho ?? []}
                      placeholder="e.g. Liam"
                      onFocusScroll={scrollFieldIntoView}
                    />
                  </View>
                  <View style={styles.section}>
                    <Text style={styles.label}>Date Rented</Text>
                    <TouchableOpacity style={styles.input} onPress={() => setShowDateRentedPicker(true)}>
                      <Text style={{ color: dateRented ? "#f4f4f5" : "#71717a" }}>{dateRented || "Select a date"}</Text>
                    </TouchableOpacity>
                    {showDateRentedPicker && (
                      <DateTimePicker
                        value={dateRented ? parseDateOnly(dateRented) : new Date()}
                        mode="date"
                        display={Platform.OS === "ios" ? "spinner" : "default"}
                        maximumDate={new Date()}
                        onChange={(event, selectedDate) => {
                          if (Platform.OS === "android") setShowDateRentedPicker(false);
                          if (event.type === "set" && selectedDate) setDateRented(formatDateOnly(selectedDate));
                        }}
                      />
                    )}
                    {Platform.OS === "ios" && showDateRentedPicker && (
                      <TouchableOpacity onPress={() => setShowDateRentedPicker(false)}>
                        <Text style={styles.link}>Done</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                </>
              )}
            </>
          );
          const collectionTitlesNode = (
            <>
              {previewCollectionName !== "" && (
                <Text style={styles.hint}>Will be saved as: {previewCollectionName}</Text>
              )}
              {collectionMembers.some((m) => !m.discNumbers.trim()) && (
                <Text style={styles.hint}>
                  Some titles were matched automatically from the collection name - tap Edit on each to tick which disc(s) it&apos;s on (set the Total Disc Count above first).
                </Text>
              )}
              {collectionMembers.map((m) => (
                <View key={m.key} style={styles.section}>
                  <TouchableOpacity
                    style={styles.row}
                    onPress={() => {
                      setEditingMemberKey(m.key);
                      setShowTitleSearchPicker(true);
                    }}
                  >
                    {m.poster && <Image source={{ uri: m.poster }} style={styles.posterThumbInline} resizeMode="cover" />}
                    <Text style={styles.body}>
                      {m.title}
                      {m.seasonNo ? ` - Season ${m.seasonNo}` : ""}
                    </Text>
                  </TouchableOpacity>
                  <Text style={styles.hint}>
                    {m.format}, disc{m.discNumbers.includes(",") ? "s" : ""} {m.discNumbers || "?"}
                    {m.specialFeatures ? " (+ special features disc)" : ""}
                  </Text>
                  <View style={styles.row}>
                    <TouchableOpacity style={styles.checkboxRow} onPress={() => toggleMemberWatchedDisc(m.key)}>
                      <View style={[styles.checkbox, m.watchedDisc && styles.checkboxChecked]}>
                        {m.watchedDisc && <Text style={styles.checkboxMark}>✓</Text>}
                      </View>
                      <Text style={styles.checkboxLabel}>Watched Disc</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.checkboxRow} onPress={() => toggleMemberWatched(m.key)}>
                      <View style={[styles.checkbox, m.watched && styles.checkboxChecked]}>
                        {m.watched && <Text style={styles.checkboxMark}>✓</Text>}
                      </View>
                      <Text style={styles.checkboxLabel}>Watched</Text>
                    </TouchableOpacity>
                  </View>
                  <View style={styles.row}>
                    <TouchableOpacity
                      onPress={() => {
                        setEditingMemberKey(m.key);
                        setShowTitleSearchPicker(true);
                      }}
                    >
                      <Text style={styles.link}>Edit</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => removeCollectionMember(m.key)}>
                      <Text style={styles.link}>Remove</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ))}
              {coverMemberTitleSuggestions.length > 0 && (
                <View style={styles.section}>
                  <Text style={styles.hint}>
                    The cover photo also lists these titles - tap one to search and add it:
                  </Text>
                  {totalDiscCountNumber < 1 && (
                    <Text style={styles.hint}>Enter the Total Disc Count above first - these are disabled until then.</Text>
                  )}
                  <View style={[styles.row, { flexWrap: "wrap" }]}>
                    {coverMemberTitleSuggestions.map((t) => (
                      <TouchableOpacity
                        key={t}
                        // Dimmed to match, added 2026-09-30 - found live the chip previously gave
                        // no visual sign it was disabled at all, so tapping it before Total Disc
                        // Count was entered just silently did nothing (same real gating "+ Add a
                        // title" already has, right below - this chip opens the exact same
                        // TitleSearchPicker, which needs totalDiscCount to render its disc
                        // checklist).
                        style={[styles.suggestionChip, totalDiscCountNumber < 1 && { opacity: 0.4 }]}
                        disabled={totalDiscCountNumber < 1}
                        onPress={() => {
                          setEditingMemberKey(null);
                          setPendingSuggestionQuery(t);
                          setShowTitleSearchPicker(true);
                        }}
                      >
                        <Text style={styles.suggestionChipText}>{t}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>
              )}
              <TouchableOpacity
                style={[styles.button, totalDiscCountNumber < 1 && { opacity: 0.4 }]}
                onPress={() => {
                  setEditingMemberKey(null);
                  setShowTitleSearchPicker(true);
                }}
                disabled={totalDiscCountNumber < 1}
              >
                <Text style={styles.buttonText}>+ Add a title</Text>
              </TouchableOpacity>
              {totalDiscCountNumber < 1 && (
                <Text style={styles.hint}>Enter the Total Disc Count above first, so each title can pick its disc(s).</Text>
              )}
              <Modal visible={showTitleSearchPicker} animationType="slide" onRequestClose={() => setShowTitleSearchPicker(false)}>
                {/* Seeded from the previously-added title's own disc fields (if any exist yet),
                    else the header's own shared-step values as a first guess - per the user's own
                    real example, most/all titles in a box set often share the same disc pattern,
                    so this cuts down on re-typing it for every title while still leaving each one
                    fully editable. Special Features Disc Format is handled differently
                    (discFormatLookup, 2026-09-23) - derived live from whatever's already known
                    about each disc NUMBER across the header and every member, rather than just
                    guessing from the previous title's own value regardless of which disc it was
                    actually about. */}
                <TitleSearchPicker
                  editingMember={editingMemberKey ? collectionMembers.find((m) => m.key === editingMemberKey) ?? null : null}
                  initialQuery={pendingSuggestionQuery ?? undefined}
                  totalDiscCount={totalDiscCountNumber}
                  onAdd={(member) => {
                    userManagedMembersRef.current = true;
                    setCollectionMembers((prev) =>
                      prev.some((m) => m.key === member.key) ? prev.map((m) => (m.key === member.key ? member : m)) : [...prev, member]
                    );
                    setEditingMemberKey(null);
                    setPendingSuggestionQuery(null);
                    setShowTitleSearchPicker(false);
                  }}
                  onCancel={() => {
                    setEditingMemberKey(null);
                    setPendingSuggestionQuery(null);
                    setShowTitleSearchPicker(false);
                  }}
                  initialFormat={collectionMembers.length > 0 ? collectionMembers[collectionMembers.length - 1].format : format}
                  initialSpecialFeatures={
                    collectionMembers.length > 0 ? collectionMembers[collectionMembers.length - 1].specialFeatures : false
                  }
                  initialSpecialFeaturesDiscNumbers={
                    collectionMembers.length > 0 ? collectionMembers[collectionMembers.length - 1].specialFeaturesDiscNumbers ?? "" : ""
                  }
                  discFormatLookup={discFormatLookup}
                  impliedWatched={watched}
                  impliedWatchedDisc={watchedDisc}
                />
              </Modal>
            </>
          );
          const collectionMissingNow = getMissingCollectionFields();
          const collectionToggleRow = (key: string) => setOpenRow((prev) => (prev === key ? null : key));
          const collectionSummaryNode = (
            <>
              <Text style={styles.hint}>Everything below is pre-filled. Tap a line to change it right here, or just Save.</Text>
              <SummaryRow
                label="Name & type"
                value={`${manualTitle}${movieOrTv ? ` (${movieOrTv})` : ""}`}
                missing={collectionMissingNow.includes("Name of Collection") || collectionMissingNow.includes("Movie or TV") || collectionMissingNow.includes("Rating")}
                expanded={openRow === "name"}
                onPress={() => collectionToggleRow("name")}
              >
                {collectionNameNode}
              </SummaryRow>
              <SummaryRow
                label="Format, region & animation"
                value={[format, [...diskRegions].join(" / "), steelbook ? "Steelbook" : ""].filter(Boolean).join(", ")}
                // Animation/Live Action red-highlighted the moment it's blank (added
                // 2026-09-30, per the user's explicit request) - NOT added to
                // getMissingCollectionFields, so it never blocks Confirm: a box set can
                // genuinely mix animated and live-action titles, so there's no single
                // "correct" shared answer to force here the way there is for a single title.
                // Left blank, the confirm route falls back to what the members themselves
                // resolved to (unanimous value, or "Live Action/Animation Hybrid" if they
                // differ), with "n/a" only as a last resort if that itself can't produce one.
                missing={
                  collectionMissingNow.includes("Format") ||
                  collectionMissingNow.includes("Disk Region") ||
                  !animationOrLiveAction.trim()
                }
                expanded={openRow === "format"}
                onPress={() => collectionToggleRow("format")}
              >
                {collectionFormatNode}
              </SummaryRow>
              <SummaryRow
                label="Discs"
                value={`${collectionDiscCount || "?"} disc(s)` + (specialFeatures ? ", special features" : "")}
                missing={
                  collectionMissingNow.includes("Total Disc Count") ||
                  collectionMissingNow.some((f) => f.startsWith("Which disc") || f.startsWith("Format of Special Features"))
                }
                // Worth a glance whenever the collection's OWN bonus disc isn't ticked
                // (2026-09-24) - a box set's shared bonus disc is easy to forget, per the
                // user's own request. Each member's own special features get the same
                // treatment inside TitleSearchPicker's own review slide.
                notable={!specialFeatures}
                expanded={openRow === "discs"}
                onPress={() => collectionToggleRow("discs")}
              >
                {collectionDiscsNode}
              </SummaryRow>
              <SummaryRow
                label="Genre Location"
                value={genreLocation + (isHistoryDocumentary && depictedEraLabel ? ` (${depictedEraLabel})` : "")}
                missing={collectionMissingNow.includes("Genre Location") || collectionMissingNow.includes("Depicted Era")}
                expanded={openRow === "location"}
                onPress={() => collectionToggleRow("location")}
              >
                {collectionLocationNode}
              </SummaryRow>
              <SummaryRow
                label="Release name & notes"
                value={
                  [collectionNameIsGeneric ? "" : releaseNameMatchesTitle ? "" : releaseName, releaseVariantNote, caseNotes]
                    .filter((v) => v.trim())
                    .join("; ") || "Same as name"
                }
                expanded={openRow === "release"}
                onPress={() => collectionToggleRow("release")}
              >
                {collectionReleaseNode}
              </SummaryRow>
              <SummaryRow
                label="Condition, watched & rental"
                value={[discCondition, watchedDisc ? "watched this disc" : watched ? "watched" : "", isCurrentlyRentedOut ? "rented out" : ""].filter(Boolean).join(", ")}
                missing={collectionMissingNow.includes("Disc Condition")}
                notable={collectionAllMembersFamilyOrKids && discCondition === "None"}
                expanded={openRow === "details"}
                onPress={() => collectionToggleRow("details")}
              >
                {collectionDetailsNode}
              </SummaryRow>
              <SummaryRow
                label="Titles in this set"
                value={`${collectionMembers.length} title${collectionMembers.length === 1 ? "" : "s"}`}
                missing={collectionMissingNow.some((f) => f.includes("titles in this collection") || f.startsWith("Disc(s) for") || f.startsWith("Format for"))}
                onPress={() => {
                  setSlideReturn("summary");
                  setActiveSlide("titles");
                }}
              />
              {error && <Text style={styles.error}>{error}</Text>}
              <TouchableOpacity
                style={styles.button}
                onPress={handleConfirmCollectionPressed}
                disabled={submitting || checkingCollectionDuplicates}
              >
                <Text style={styles.buttonText}>
                  {checkingCollectionDuplicates ? "Checking your collection..." : submitting ? "Saving..." : "Confirm Collection"}
                </Text>
              </TouchableOpacity>
              {/* Determinate while genuinely submitting (a real estimate scaled to entry
                  count - see performCreateCollection/ProgressBar's own comments), still
                  indeterminate for the duplicate check just before it - a single, short,
                  unknown-duration request with no meaningful "how much is left" figure. */}
              {submitting ? <ProgressBar progress={submitProgress} /> : checkingCollectionDuplicates && <IndeterminateBar />}
              <TouchableOpacity onPress={handleDiscard} disabled={submitting || checkingCollectionDuplicates}>
                <Text style={styles.link}>This was a stray scan - discard it</Text>
              </TouchableOpacity>
            </>
          );
          return (
            <SlideFlow
              activeKey={activeSlide}
              onChange={(key) => {
                setSlideReturn(null);
                setActiveSlide(key);
              }}
              returnKey={slideReturn}
              slides={[
                { key: "name", label: "Collection name & type", node: collectionNameNode },
                { key: "format", label: "Format, region & animation", node: collectionFormatNode },
                { key: "discs", label: "Discs & special features", node: collectionDiscsNode },
                { key: "location", label: "Where does it go on the shelf?", node: collectionLocationNode },
                { key: "release", label: "Release name & notes", node: collectionReleaseNode },
                { key: "details", label: "Condition, watched & rental", node: collectionDetailsNode },
                { key: "titles", label: `Titles in this set (${collectionMembers.length})`, node: collectionTitlesNode },
                { key: "summary", label: "Review & save", node: collectionSummaryNode },
              ]}
            />
          );
        })()
      ) : needsTitleSearch ? (
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


      {(() => {
        const commonFormats = (fieldOptions?.format ?? []).filter((f) => /^(dvd|blu-?ray|4k uhd blu-?ray)$/i.test(f.trim()));
        const matchNode = (
          <>
      {scannedImageSource && (
        <View style={styles.section}>
          <Text style={styles.label}>Your scanned item</Text>
          <Image
            source={{ uri: scannedImageSource.uri, headers: scannedImageSource.headers }}
            style={[styles.scannedItemImage, { aspectRatio: scannedImageAspectRatio }]}
            resizeMode="contain"
            onError={() => setScannedImageSourceIndex((i) => i + 1)}
          />
          <Text style={styles.hint}>
            {scannedImageSource.isCoverPhoto
              ? "Your own front cover photo from this scan - this is what gets saved as the case image. Compare it against the candidates below to confirm the specific release. If it's cropped wrong, that's worth flagging."
              : "Compare this against the candidates below - it's a photo of the actual listing, not a generic poster, so it's the best way to confirm the specific release. Shown auto-cropped (same crop that gets saved) - if it's cropped wrong, that's worth flagging."}
          </Text>
        </View>
      )}
      {listingTextExtraction && (listingTextExtraction.title || listingTextExtraction.actors.length > 0) && (
        <View style={styles.section}>
          <Text style={styles.label}>AI-parsed from listing text</Text>
          <Text style={styles.hint}>
            The plain listing text search found nothing, so this was pulled out by an AI model as a
            fallback - shown for transparency, not treated as confirmed.
            {listingTextExtraction.title ? `\nTitle: ${listingTextExtraction.title}` : ""}
            {listingTextExtraction.actors.length > 0 ? `\nCast mentioned: ${listingTextExtraction.actors.join(", ")}` : ""}
          </Text>
        </View>
      )}
      {autoMatchedCandidate && !showAllCandidates ? (
        <View style={styles.section}>
          <Text style={styles.label}>Matched by cover photo</Text>
          <View style={[styles.posterCard, styles.posterCardSelected, styles.autoMatchCard]}>
            {autoMatchedCandidate.Poster &&
            autoMatchedCandidate.Poster !== "N/A" &&
            !posterLoadFailed.has(autoMatchedCandidate.imdbID) ? (
              <Image
                source={{ uri: autoMatchedCandidate.Poster }}
                style={styles.posterImage}
                resizeMode="cover"
                onError={() => markPosterLoadFailed(autoMatchedCandidate.imdbID)}
              />
            ) : (
              <View style={[styles.posterImage, styles.posterPlaceholder]}>
                <Text style={styles.posterPlaceholderText}>No poster image found</Text>
              </View>
            )}
            <Text style={styles.posterTitle}>{autoMatchedCandidate.Title}</Text>
            <Text style={styles.posterYear}>
              {autoMatchedCandidate.Year}
              {autoMatchedCandidate.Runtime ? ` · ${autoMatchedCandidate.Runtime}` : ""}
            </Text>
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
          <Text style={styles.label}>Best match</Text>
          <Text style={styles.hint}>
            Compare the cover art before picking - different releases of the same film (special
            editions, re-releases) often look different but OMDB's text alone won&apos;t tell them apart.
          </Text>
          {mainCandidates.length > 0 && (
            <FlatList
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.candidateScroll}
              data={mainCandidates}
              keyExtractor={(c) => c.imdbID}
              renderItem={({ item }) => renderCandidateCard(item)}
              // Virtualizes off-screen cards (unlike the plain ScrollView this replaced,
              // which mounted and decoded every poster image up front) - fixed the visibly
              // laggy horizontal scroll the user hit live with a candidate list of any real
              // size, since remote poster images are usually far higher-resolution than the
              // 120x168 card they're displayed at.
              windowSize={5}
              initialNumToRender={4}
            />
          )}
          {extraCandidates.length > 0 && (
            <View style={styles.section}>
              <TouchableOpacity onPress={() => setShowExtras((prev) => !prev)}>
                <Text style={styles.link}>
                  {showExtras ? "Hide" : "Show"} Extras ({extraCandidates.length}) - making-of/behind-the-scenes/special-screening results that share this title
                </Text>
              </TouchableOpacity>
              {showExtras && (
                <FlatList
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  style={styles.candidateScroll}
                  data={extraCandidates}
                  keyExtractor={(c) => c.imdbID}
                  renderItem={({ item }) => renderCandidateCard(item)}
                  windowSize={5}
                  initialNumToRender={4}
                />
              )}
            </View>
          )}
        </View>
      ) : (
        <Text style={styles.hint}>No match found - enter this title manually.</Text>
      )}
      <View style={styles.section}>
        <Text style={styles.label}>Movie or TV</Text>
        <SelectDropdown
          options={fieldOptions?.movieOrTv ?? [movieOrTv].filter(Boolean)}
          value={movieOrTv}
          onChange={setMovieOrTv}
        />
      </View>
      {showSeasonFields && (
        <>
          <View style={styles.section}>
            <Text style={styles.label}>Season No. (optional - e.g. 2, or 1,3, or Assorted/All/Specials)</Text>
            <TextInput
              style={styles.input}
              value={seasonNo}
              onChangeText={setSeasonNo}
              placeholder="e.g. 2"
              placeholderTextColor="#71717a"
            />
          </View>
          <View style={styles.section}>
            <Text style={styles.label}>Part of a Season No. (optional)</Text>
            <TextInput
              style={styles.input}
              value={partOfSeasonNo}
              onChangeText={(t) => setPartOfSeasonNo(digitsOnly(t))}
              keyboardType="number-pad"
              placeholder="e.g. 1"
              placeholderTextColor="#71717a"
            />
          </View>
          <View style={styles.section}>
            <Text style={styles.label}>Episode Count on this disc (optional)</Text>
            <TextInput
              style={styles.input}
              value={episodeCount}
              onChangeText={(t) => setEpisodeCount(digitsOnly(t))}
              keyboardType="number-pad"
              placeholder="e.g. 12"
              placeholderTextColor="#71717a"
            />
          </View>
        </>
      )}
      {/* Hidden for a plain single-movie match with a real OMDB/TMDb title already linked -
          added 2026-09-19 per the user's own request: the Title field is only worth seeing
          when it's genuinely being modified from what OMDB/TMDb already supplies, which only
          really happens for a TV entry (season/part composition, showSeasonFields) - not for
          an ordinary movie, where the linked title is already correct as-is. Still shown for a
          fully manual entry (selected.size === 0), since there's nothing to link a title from
          at all in that case. (A collection scan never reaches this JSX at all any more - see
          isCollectionOverride's own separate render branch, which has its own Name of
          Collection field instead.) The composeSeasonTitle hard-reset effect above keeps
          `manualTitle` synced to the candidate's own title even while this field is hidden, so
          a plain movie's title override sent at submit time (see manualFields below) always
          exactly matches OMDB's own title rather than some stale leftover value. */}
      {(selected.size === 0 || showSeasonFields) && (
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
          {/* Season/part composition (added 2026-09-19) auto-suggests into this same field
              once a real candidate is matched and Season No. is filled in (e.g. "Breaking Bad"
              -> "Breaking Bad Season 3") - OMDB only ever has one entry per whole show, never
              one per season, so without this the catalogued title would just be the bare show
              name with no way to tell two season discs apart. Always fully editable - this
              collection's own real naming conventions vary a lot ("Season N", "Series N", "the
              Complete Nth Season", a bare number with no word at all for old syndicated sets),
              so this is a starting suggestion to adjust, never an enforced format. */}
          {showSeasonFields && singleSelectedImdbId && (
            <Text style={styles.hint}>Suggested from the show name + season - edit to match how you usually name these.</Text>
          )}
        </View>
      )}
      {selected.size === 0 && (
        <>
          {/* No OMDB/TMDb candidate exists here to backfill Genre/Runtime/Director later,
              unlike every field below this block - so these are asked for now, the one
              chance to capture them at all. Rotten Tomatoes/IMDb/TMDb links and ids are
              deliberately NOT asked for here (see showTmdbOverrideField above, already
              gated on singleSelectedImdbId) since a page almost certainly doesn't
              exist for a title neither database could find in the first place. */}
          <View style={styles.section}>
            <Text style={styles.label}>Genre (optional, comma-separated)</Text>
            <TagSearchableModalInput
              value={genre}
              onChangeText={setGenre}
              options={fieldOptions?.genre ?? []}
              placeholder="e.g. Action, Comedy"
              onFocusScroll={scrollFieldIntoView}
            />
          </View>
          <View style={styles.section}>
            <Text style={styles.label}>Running Time (mins, optional)</Text>
            <TextInput
              ref={runningTimeMinsInputRef}
              style={styles.input}
              value={runningTimeMins}
              onChangeText={setRunningTimeMins}
              onFocus={() => scrollInputRefIntoView(runningTimeMinsInputRef)}
              keyboardType="number-pad"
              placeholder="e.g. 124"
              placeholderTextColor="#71717a"
            />
          </View>
          <View style={styles.section}>
            <Text style={styles.label}>Director (optional, comma-separated)</Text>
            <TextInput
              ref={directorInputRef}
              style={styles.input}
              value={director}
              onChangeText={setDirector}
              onFocus={() => scrollInputRefIntoView(directorInputRef)}
              placeholder="e.g. Steven Spielberg"
              placeholderTextColor="#71717a"
            />
          </View>
        </>
      )}
            <TouchableOpacity style={styles.button} onPress={() => setActiveSlide("summary")}>
              <Text style={styles.buttonText}>{selected.size > 0 ? "This is the one - review" : "Continue to review"}</Text>
            </TouchableOpacity>
            {candidates.length > 0 && selected.size > 0 && (
              <TouchableOpacity onPress={() => setSelected(new Set())}>
                <Text style={styles.link}>None of these - enter it manually instead</Text>
              </TouchableOpacity>
            )}
          </>
        );
        const formatNode = (
          <>
                <View style={styles.section}>
                  <Text style={styles.label}>Format</Text>
                  <BigChoice
                    options={(fieldOptions?.format ?? []).filter((f) => /^(dvd|blu-?ray|4k uhd blu-?ray)$/i.test(f.trim()))}
                    value={format}
                    onChange={setFormat}
                  />
                  <Text style={styles.hint}>Something else (VHS, 3D, HD DVD...)? Pick it here:</Text>
        <SearchableModalInput
          value={format}
          onChangeText={setFormat}
          options={fieldOptions?.format ?? []}
          onFocusScroll={scrollFieldIntoView}
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
      <View style={[styles.section, styles.row]}>
        <Text style={styles.label}>Steelbook</Text>
        <Switch value={steelbook} onValueChange={setSteelbook} />
      </View>
          </>
        );
        const maxSpecialFeaturesDiscCount = Math.max(0, (parseInt(discCount, 10) || 1) - 1);
        const setSfCount = (n: number) =>
          setSpecialFeaturesDiscCount(String(Math.min(maxSpecialFeaturesDiscCount, Math.max(0, n))));
        const discsNode = (
          <>
                <View style={styles.section}>
                  <Text style={styles.label}>Disc Count</Text>
                  <View style={styles.stepper}>
                    <TouchableOpacity
                      style={styles.stepperButton}
                      onPress={() => setDiscCount(String(Math.max(1, (parseInt(discCount, 10) || 1) - 1)))}
                    >
                      <Text style={styles.stepperButtonText}>-</Text>
                    </TouchableOpacity>
                    <Text style={styles.stepperValue}>{discCount || "1"}</Text>
                    <TouchableOpacity
                      style={styles.stepperButton}
                      onPress={() => setDiscCount(String((parseInt(discCount, 10) || 1) + 1))}
                    >
                      <Text style={styles.stepperButtonText}>+</Text>
                    </TouchableOpacity>
                  </View>
                </View>
            <View style={[styles.section, styles.row]}>
              <Text style={styles.label}>Special Features</Text>
              <Switch value={specialFeatures} onValueChange={setSpecialFeatures} />
            </View>
            {showSpecialFeaturesDiscFields && (
              <>
                <View style={styles.section}>
                  <Text style={styles.label}>Number of Special Features Discs</Text>
                  <View style={styles.stepperSm}>
                    <TouchableOpacity style={styles.stepperSmButton} onPress={() => setSfCount((parseInt(specialFeaturesDiscCount, 10) || 1) - 1)}>
                      <Text style={styles.stepperSmText}>-</Text>
                    </TouchableOpacity>
                    <Text style={styles.stepperSmValue}>{specialFeaturesDiscCount || "1"}</Text>
                    <TouchableOpacity style={styles.stepperSmButton} onPress={() => setSfCount((parseInt(specialFeaturesDiscCount, 10) || 1) + 1)}>
                      <Text style={styles.stepperSmText}>+</Text>
                    </TouchableOpacity>
                  </View>
                </View>
                <View style={styles.section}>
                  <Text style={styles.label}>Format of Special Features Discs</Text>
                  <BigChoice options={commonFormats} value={specialFeaturesDiscFormat} onChange={setSpecialFeaturesDiscFormat} columns={3} />
                  <Text style={styles.hint}>Something else? Pick or type it here:</Text>
                  <SearchableModalInput
                    value={specialFeaturesDiscFormat}
                    onChangeText={setSpecialFeaturesDiscFormat}
                    options={fieldOptions?.format ?? []}
                    onFocusScroll={scrollFieldIntoView}
                  />
                </View>
              </>
            )}
          </>
        );
        const locationNode = (
          <>
            <View style={styles.section}>
              <Text style={styles.label}>Genre Location (shelf section)</Text>
              <BigChoice
                options={rankGenreLocationOptions(
                  filterGenreLocationOptions(fieldOptions?.genreLocation ?? [], false, movieOrTv),
                  genreSignalForLocationRanking,
                  4
                )}
                value={genreLocation}
                onChange={setGenreLocation}
              />
              <Text style={styles.hint}>Not listed? Type a new one here:</Text>
              <SearchableModalInput
                value={genreLocation}
                onChangeText={setGenreLocation}
                options={filterGenreLocationOptions(fieldOptions?.genreLocation ?? [], false, movieOrTv)}
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
          </>
        );
        const franchiseNode = (
          <>
            <View style={styles.section}>
              <Text style={styles.label}>
                Franchise (optional)
                {singleSelectedImdbId && !franchise ? " - no series match on Wikidata" : ""}
              </Text>
              <FranchiseEditor
                value={franchise}
                onChange={setFranchise}
                options={fieldOptions?.franchise ?? []}
                cooccurrence={fieldOptions?.franchiseCooccurrence ?? {}}
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
          <SearchableModalInput
            value={animationOrLiveAction}
            onChangeText={setAnimationOrLiveAction}
            options={animationOptions}
            placeholder="e.g. 2D Animation, 3D Animation, Claymation"
            onFocusScroll={scrollFieldIntoView}
          />
        </View>
      )}
          </>
        );
        const releaseNode = (
          <>
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
          onChangeText={(text) => {
            setReleaseName(text);
            // Typing anything unchecks "Same as Title" automatically - added 2026-09-17 per
            // the user's own request - and clearing the field all the way back to empty
            // re-checks it, rather than leaving the user to manage the checkbox and the text
            // in sync by hand. The checkbox's own direct tap (below) still works too, purely
            // as a manual override - either interaction ends up in the same place.
            setReleaseNameMatchesTitle(text.trim().length === 0);
          }}
          onFocus={() => scrollInputRefIntoView(releaseNameInputRef)}
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
          </>
        );
        const detailsNode = (
          <>
      <View style={styles.section}>
        <Text style={styles.label}>Disc Condition</Text>
        <SingleSelectChips options={DISC_CONDITION_VALUES} value={discCondition} onChange={setDiscCondition} />
      </View>
      <TouchableOpacity
        style={styles.checkboxRow}
        onPress={() =>
          setIsCurrentlyRentedOut((prev) => {
            const next = !prev;
            // Hidden fields are cleared, not just hidden - same precedent as
            // showSpecialFeaturesDiscFields's hidden fields (see the manualFields comment
            // above for why this also happens again, belt-and-suspenders, at submit time).
            if (!next) {
              setRentedByWho("");
              setDateRented("");
              setShowDateRentedPicker(false);
            }
            return next;
          })
        }
      >
        <View style={[styles.checkbox, isCurrentlyRentedOut && styles.checkboxChecked]}>
          {isCurrentlyRentedOut && <Text style={styles.checkboxMark}>✓</Text>}
        </View>
        <Text style={styles.checkboxLabel}>Currently rented out</Text>
      </TouchableOpacity>
      {isCurrentlyRentedOut && (
        <>
          <View style={styles.section}>
            <Text style={styles.label}>Rented By Who</Text>
            <SearchableModalInput
              value={rentedByWho}
              onChangeText={setRentedByWho}
              options={fieldOptions?.rentedByWho ?? []}
              placeholder="e.g. Liam"
              onFocusScroll={scrollFieldIntoView}
            />
          </View>
          <View style={styles.section}>
            <Text style={styles.label}>Date Rented</Text>
            <TouchableOpacity
              style={styles.input}
              onPress={() => setShowDateRentedPicker(true)}
            >
              <Text style={{ color: dateRented ? "#f4f4f5" : "#71717a" }}>
                {dateRented || "Select a date"}
              </Text>
            </TouchableOpacity>
            {showDateRentedPicker && (
              <DateTimePicker
                value={dateRented ? parseDateOnly(dateRented) : new Date()}
                mode="date"
                display={Platform.OS === "ios" ? "spinner" : "default"}
                maximumDate={new Date()}
                onChange={(event, selectedDate) => {
                  // Android's native dialog is modal and self-dismisses; iOS's inline
                  // spinner stays open until the explicit "Done" link below is tapped.
                  if (Platform.OS === "android") setShowDateRentedPicker(false);
                  if (event.type === "set" && selectedDate) {
                    setDateRented(formatDateOnly(selectedDate));
                  }
                }}
              />
            )}
            {Platform.OS === "ios" && showDateRentedPicker && (
              <TouchableOpacity onPress={() => setShowDateRentedPicker(false)}>
                <Text style={styles.link}>Done</Text>
              </TouchableOpacity>
            )}
          </View>
        </>
      )}
      <TouchableOpacity
        style={styles.checkboxRow}
        onPress={() =>
          setWatchedDisc((prev) => {
            const next = !prev;
            // Watching this specific disc implies having watched the film at all - the
            // narrow claim can't be true while the broad one is false. Only forces `watched`
            // on when checking this box; unchecking it leaves `watched` alone, since you may
            // well have seen the film some other way even if this particular disc wasn't it.
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
      <TouchableOpacity
        style={styles.checkboxRow}
        onPress={() =>
          setWatched((prev) => {
            const next = !prev;
            // Inverse of the above: can't have watched this specific disc if the film
            // hasn't been watched at all, so unchecking Watched must also clear Watched Disc
            // to avoid leaving a contradictory state on the row.
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
          </>
        );
        // Most-common ratings among titles already sharing this franchise (2026-09-27, per
        // the user's request: "give me buttons for the most common ratings for that
        // franchise... to make the most relevant ratings easier to click on") - a franchise's
        // films are usually classified the same handful of ways (every mainline X-Men film is
        // M or R13), so surfacing the real ratings already used for THIS franchise, ranked by
        // how often each one appears, is far more useful than the full alphabetical list of
        // every rating ever seen in the collection. Summed across every tag when the title
        // carries more than one franchise. Top 4 only - a quick-tap shortcut, not a
        // replacement for the full searchable list still available right below it. Also folds
        // in a straight G/PG suggestion (deduplicated) whenever isFamilyOrKidsGenre and
        // isAnimatedStyle both hold, ahead of the franchise-ranked ones - family/kids content
        // that's actually animated is near-universally G or PG regardless of franchise data.
        const franchiseCommonRatings = (() => {
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
        const needsCaseInfo = showTmdbOverrideField || showRatingField || showStudioField || showOriginalLanguageField;
        const neededNode = (
          <>
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
      {singleSelectedImdbId && tmdbPreviewLoading && (
        <Text style={styles.hint}>Checking TMDb for Rating/Studio/Original Language...</Text>
      )}
      {singleSelectedImdbId &&
        !tmdbPreviewLoading &&
        !showRatingField &&
        !showStudioField &&
        !showOriginalLanguageField && (
          <Text style={styles.hint}>Rating, Studio and Original Language will be filled in from TMDb.</Text>
        )}
      {showRatingField && (
        <View style={styles.section}>
          <Text style={styles.label}>
            Rating{singleSelectedImdbId ? " (not on TMDb - from the case)" : " (from the case)"}
          </Text>
          {franchiseCommonRatings.length > 0 && (
            <>
              <Text style={styles.hint}>Common for {franchise.split(",")[0].trim()}:</Text>
              <SingleSelectChips options={franchiseCommonRatings} value={rating} onChange={setRating} />
            </>
          )}
          <SearchableModalInput
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
          <SearchableModalInput
            value={studio}
            onChangeText={setStudio}
            options={fieldOptions?.studio ?? []}
            onFocusScroll={scrollFieldIntoView}
          />
        </View>
      )}
      {showOriginalLanguageField && (
        <View style={styles.section}>
          <Text style={styles.label}>
            Original Language{singleSelectedImdbId ? " (not on TMDb)" : ""}
          </Text>
          <SearchableModalInput
            value={originalLanguage}
            onChangeText={setOriginalLanguage}
            options={fieldOptions?.originalLanguage ?? []}
            placeholder="e.g. English, Japanese"
            onFocusScroll={scrollFieldIntoView}
          />
        </View>
      )}
          </>
        );
        const missingNow = getMissingRequiredFields();
        const toggleRow = (key: string) => setOpenRow((prev) => (prev === key ? null : key));
        const summaryNode = (
          <>
      {existingMatch && (
        <Text style={styles.hint}>
          This barcode already matches your entry for &quot;{existingMatch.title}&quot; - fields
          below are pre-filled from it. Add or edit anything new, then Confirm to choose whether
          to overwrite it, add it as a genuinely separate entry, or reject this scan.
        </Text>
      )}
            <Text style={styles.hint}>Everything below is pre-filled. Tap a line to change it right here, or just Save.</Text>
            <SummaryRow
              label="Match & type"
              value={
                ((singleSelectedImdbId ? candidates.find((c) => c.imdbID === singleSelectedImdbId)?.Title : "") ||
                  (candidates.length > 0 && selected.size === 0 ? "" : manualTitle)) + (movieOrTv ? ` (${movieOrTv})` : "")
              }
              missing={(candidates.length > 0 && selected.size === 0 && !manualTitle.trim()) || missingNow.includes("Title") || missingNow.includes("Movie or TV")}
              onPress={() => {
                setSlideReturn("summary");
                setActiveSlide("title");
              }}
            />
            <SummaryRow
              label="Format & region"
              value={[format, [...diskRegions].join(" / "), steelbook ? "Steelbook" : ""].filter(Boolean).join(", ")}
              missing={!format.trim() || diskRegions.size === 0}
              expanded={openRow === "format"}
              onPress={() => toggleRow("format")}
            >
              {formatNode}
            </SummaryRow>
            <SummaryRow
              label="Discs"
              value={`${discCount || "1"} disc(s)` + (specialFeatures ? (showSpecialFeaturesDiscFields ? `, special features: ${specialFeaturesDiscCount || "?"} x ${specialFeaturesDiscFormat || "format?"}` : ", special features") : "")}
              missing={showSpecialFeaturesDiscFields && (!specialFeaturesDiscCount.trim() || !specialFeaturesDiscFormat.trim())}
              // Worth a glance whenever Special Features is off (2026-09-24) - easy to forget
              // to tick if the case genuinely has a bonus disc/menu, per the user's own request.
              notable={!specialFeatures}
              expanded={openRow === "discs"}
              onPress={() => toggleRow("discs")}
            >
              {discsNode}
            </SummaryRow>
            <SummaryRow
              label="Genre Location"
              value={genreLocation + (isHistoryDocumentary && depictedEraLabel ? ` (${depictedEraLabel})` : "")}
              missing={!genreLocation.trim() || (isHistoryDocumentary && !depictedEraLabel.trim())}
              expanded={openRow === "location"}
              onPress={() => toggleRow("location")}
            >
              {locationNode}
            </SummaryRow>
            <SummaryRow
              label="Franchise & animation"
              value={franchise}
              // Amber, not red (2026-09-24) - a blank Franchise is very often genuinely
              // correct (most films aren't part of one), same reasoning
              // getMissingRequiredFields's own comment gives for never hard-requiring it - but
              // still worth a glance since it's easy to forget to check, per the user's own
              // request. Suppressed (SummaryRow ignores `notable` once `missing` is true) the
              // moment Animation/Live Action itself is unconfirmed below - that's the more
              // urgent signal for this same row.
              notable={!franchise.trim()}
              // Red (added 2026-09-30, per the user's explicit request): unlike Franchise,
              // Animation/Live Action always has a real answer, so once OMDB/TMDb hasn't
              // confirmed Live Action, a blank value here is genuinely missing data - see
              // getMissingRequiredFields's own matching comment. This is a hard block (also in
              // missingNow), not just a visual warning, per the user's own explicit choice.
              missing={missingNow.includes("Animation / Live Action")}
              expanded={openRow === "franchise"}
              onPress={() => toggleRow("franchise")}
            >
              {franchiseNode}
            </SummaryRow>
            <SummaryRow
              label="Release name & notes"
              value={[releaseNameMatchesTitle ? "" : releaseName, releaseVariantNote, caseNotes].filter((v) => v.trim()).join("; ") || "Same as Title"}
              // Flags a still-unconfirmed cover-photo-derived release name (added 2026-09-29,
              // per the user's own explicit request) - amber until the user taps in and either
              // confirms or edits it, since a vision misread of an edition name is a real risk.
              notable={releaseNameFromCoverVision}
              expanded={openRow === "release"}
              onPress={() => toggleRow("release")}
            >
              {releaseNode}
            </SummaryRow>
            <SummaryRow
              label="Condition & watched"
              value={[discCondition, watchedDisc ? "watched this disc" : watched ? "watched" : "", isCurrentlyRentedOut ? "rented out" : ""].filter(Boolean).join(", ")}
              missing={!discCondition.trim()}
              notable={isFamilyRiskGenre && discCondition === "None"}
              expanded={openRow === "details"}
              onPress={() => toggleRow("details")}
            >
              {detailsNode}
            </SummaryRow>
            {needsCaseInfo && (
              <SummaryRow
                label="Needed from the case"
                value={[showTmdbOverrideField ? "TMDb link" : "", showRatingField ? rating : "", showStudioField ? studio : "", showOriginalLanguageField ? originalLanguage : ""].filter(Boolean).join(", ")}
                missing={missingNow.some((f) => ["Rating", "Studio", "Original Language"].includes(f)) || (showTmdbOverrideField && !tmdbIdOverride.trim())}
                expanded={openRow === "needed"}
                onPress={() => toggleRow("needed")}
              >
                {neededNode}
              </SummaryRow>
            )}
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
        );
        return (
          <SlideFlow
            activeKey={activeSlide}
            onChange={(key) => {
              setSlideReturn(null);
              setActiveSlide(key);
            }}
            returnKey={slideReturn}
            slides={[
              { key: "title", label: "Which title is this?", node: matchNode },
              { key: "format", label: "Format & region", node: formatNode },
              { key: "discs", label: "Discs & special features", node: discsNode },
              { key: "location", label: "Where does it go on the shelf?", node: locationNode },
              { key: "franchise", label: "Franchise & animation", node: franchiseNode },
              { key: "release", label: "Release name & notes", node: releaseNode },
              { key: "details", label: "Condition & watched", node: detailsNode },
              ...(needsCaseInfo ? [{ key: "needed", label: "Needed from the case", node: neededNode }] : []),
              { key: "summary", label: "Review & save", node: summaryNode },
            ]}
          />
        );
      })()}
        </>
      )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#09090b" },
  stepper: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 24 },
  stepperButton: { width: 72, height: 72, borderRadius: 36, backgroundColor: "#27272a", alignItems: "center", justifyContent: "center" },
  stepperButtonText: { color: "#f4f4f5", fontSize: 36, fontWeight: "700" },
  stepperSm: { flexDirection: "row", alignItems: "center", gap: 16 },
  stepperSmButton: { width: 52, height: 52, borderRadius: 26, backgroundColor: "#27272a", alignItems: "center", justifyContent: "center" },
  stepperSmText: { color: "#f4f4f5", fontSize: 26, fontWeight: "700" },
  stepperSmValue: { color: "#f4f4f5", fontSize: 26, fontWeight: "700", minWidth: 36, textAlign: "center" },
  stepperValue: { color: "#f4f4f5", fontSize: 40, fontWeight: "700", minWidth: 60, textAlign: "center" },
  scrollView: { flex: 1 },
  scrollContent: { padding: 16, paddingTop: 48, gap: 12 },
  title: { color: "#f4f4f5", fontSize: 18, fontWeight: "700" },
  // flexShrink: 1 (added 2026-09-20, the "graphics safe area" follow-up) - RN's flexbox
  // defaults every child to flexShrink: 0, so a Text sitting next to a fixed-size Switch/
  // checkbox in a `row` (justifyContent: "space-between") renders at its own full natural
  // single-line width instead of wrapping, pushing the control straight off the right edge of
  // the screen once a label gets long enough - found live once the Collection flow's longer
  // labels ("Special Features (a bonus disc for the whole collection)", etc.) started doing
  // exactly that. This is a genuinely different axis from this app's existing vertical safe-
  // area handling (useSafeAreaInsets, keeping content clear of the front-camera punch-hole and
  // Android's on-screen nav buttons) - that's about the top/bottom of the screen and was
  // already correctly handled; this is the same "never let a real control get pushed off the
  // visible screen" discipline applied horizontally instead, which nothing had covered before.
  body: { color: "#e4e4e7", flexShrink: 1 },
  hint: { color: "#a1a1aa", fontStyle: "italic" },
  link: { color: "#38bdf8" },
  // Same amber warning family as OfflineBanner.tsx, for consistency between the two banners
  // that can appear on this screen.
  categoryWarning: {
    backgroundColor: "#78350f",
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  categoryWarningText: { color: "#fde68a", fontSize: 13 },
  // Same pill shape as MultiSelectChips' own chip, but blue-accented rather than a plain
  // toggle - this one is an action (tap to search/add), not a selection state.
  suggestionChip: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#38bdf8",
    marginRight: 8,
    marginBottom: 8,
  },
  suggestionChipText: { color: "#38bdf8" },
  // Small inline poster thumbnail for a Collection member row in the running "Titles in this
  // set" list - added 2026-09-20, deliberately much smaller than the full candidate poster
  // cards above, since this list can grow long (a real box set can hold a dozen+ titles).
  posterThumbInline: { width: 32, height: 46, borderRadius: 4 },
  scannedImage: {
    width: "100%",
    height: 220,
    borderRadius: 8,
    backgroundColor: "#18181b",
  },
  // Separate from scannedImage's fixed-height box, added 2026-09-18 - the real cause of the
  // "grey borders" the user reported wasn't padding baked into the source photo (confirmed by
  // downloading and looking at the actual barcode-listing image directly - it's a clean
  // full-bleed cover with no padding at all), it was this box's own shape not matching the
  // photo's, forcing `resizeMode="contain"` to shrink it down and expose the box's own dark
  // background (which read as "grey" at a glance) on whichever sides had the leftover space.
  // A hardcoded 2:3 "typical disc case" guess fixed the left/right bars but then produced the
  // exact same problem on the top/bottom for a photo that isn't actually 2:3 - so this no
  // longer guesses a ratio at all; `scannedImageAspectRatio` (state, set from the real image's
  // own dimensions via `Image.getSize`) is applied inline instead, and 2:3 only remains here
  // as that state's own initial/fallback value before the real size loads.
  scannedItemImage: {
    width: "100%",
    borderRadius: 8,
    backgroundColor: "#18181b",
  },
  section: { gap: 6 },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 },
  label: { color: "#a1a1aa", flexShrink: 1 },
  groupHeader: {
    color: "#f4f4f5",
    fontSize: 15,
    fontWeight: "700",
    marginTop: 20,
    borderTopWidth: 1,
    borderTopColor: "#27272a",
    paddingTop: 16,
  },
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
  checkboxLabel: { color: "#a1a1aa", fontSize: 13, flexShrink: 1 },
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
  // Overwrite/Is-a-new-entry/Reject on the similar-entry check are three equally-weighted
  // choices, not a primary action plus lesser links - all three get full button styling,
  // colored by consequence (green = additive, blue = replaces in place, red = destructive
  // to this scan) rather than all defaulting to the same blue.
  buttonGreen: { backgroundColor: "#16a34a" },
  buttonRed: { backgroundColor: "#dc2626" },
  buttonText: { color: "#fff", fontWeight: "600" },
});
