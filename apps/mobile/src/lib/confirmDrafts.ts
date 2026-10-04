import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * In-progress form state for a pending scan's Confirm screen. ConfirmScreen fully
 * unmounts every time the user navigates to Pending Scans and back (App.tsx's screen
 * switch is plain conditional rendering, same reason the scan-cooldown map had to move
 * up to App.tsx) - without this, anything typed or selected (best-match candidate, disc
 * count, format, ...) was silently lost the moment they left an incomplete scan and came
 * back to it. Cleared once the scan reaches a terminal state (confirmed, dismissed,
 * discarded, or attached to an existing entry) - a scan the user is still filling in
 * keeps its draft, but there's no reason to remember one that's actually done.
 *
 * Persisted to `AsyncStorage` (added 2026-09-24, same on-device persistence
 * `offlineQueue.ts` already uses) - originally just an in-memory `Map`, which turned out to
 * only ever survive plain in-app screen navigation, not what the user actually needed:
 * "when I have scanned a barcode and then put the information in about the title and then
 * left the app... all the data on the entry appears to be lost." An in-memory Map is wiped
 * the moment the JS engine itself restarts - backgrounding the app long enough for the OS to
 * reclaim it, a Fast Refresh full reload, or genuinely closing and reopening Expo Go - which
 * is exactly when this was being lost; a title search in particular (typing a query, waiting
 * on the OMDB/TMDb round-trip) is a natural moment to alt-tab away, making that step feel
 * "especially volatile" even though the underlying bug was never specific to it.
 *
 * The in-memory `drafts` Map below is kept as the fast, SYNCHRONOUS source of truth (every
 * read in ConfirmScreen.tsx seeds a `useState` initializer directly, and converting ~30 of
 * those to an async-loaded pattern would be a much larger, riskier change for no real
 * benefit) - `hydrateConfirmDrafts()` fills it from AsyncStorage once at app boot
 * (App.tsx), and every write/delete below also fires a fire-and-forget persist to
 * AsyncStorage, so the two stay in sync without any call site in ConfirmScreen needing to
 * change at all.
 */
export interface ConfirmDraftCandidate {
  Title: string;
  Year: string;
  imdbID: string;
  Type: string;
  Poster: string;
  Runtime?: string;
}

/** One title added to a Collection scan's running member list - see ConfirmScreen.tsx's own
 * `CollectionMember` interface (the live type used at runtime; this is just its serializable
 * shape for the draft cache). Added 2026-09-20 for the Collection scanning flow. */
export interface ConfirmDraftCollectionMember {
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
  discNumbers: string;
  specialFeatures: boolean;
  specialFeaturesDiscCount?: string;
  specialFeaturesDiscFormat?: string;
  specialFeaturesDiscNumbers?: string;
  releaseName?: string;
  // See TitleSearchPicker.tsx's CollectionMember - mirrored here so a Collection scan's
  // header-level family/kids unanimity check survives the app closing/restarting too.
  isFamilyOrKidsGenre?: boolean;
  isAnimatedStyle?: boolean;
  rating?: string;
  tmdbRating?: string | null;
}

export interface ConfirmDraft {
  /** Collection header's own typed Total Disc Count (every physical disc in the box, bonus disc
   * included) and which of those numbered discs is the collection's own bonus disc(s) -
   * redesigned 2026-09-20, see ConfirmScreen.tsx's collectionDiscCount/bonusDiscs. */
  collectionDiscCount?: string;
  bonusDiscs?: number[];
  showAllCandidates: boolean;
  selected: string[];
  manualTitle: string;
  releaseName: string;
  releaseNameMatchesTitle: boolean;
  format: string;
  discCount: string;
  diskRegions: string[];
  genreLocation: string;
  rating: string;
  studio: string;
  steelbook: boolean;
  specialFeatures: boolean;
  specialFeaturesDiscCount: string;
  specialFeaturesDiscFormat: string;
  /** True while the bonus-disc format is still the app's own assumption (2026-10-04). */
  specialFeaturesDiscFormatAssumed?: boolean;
  candidates?: ConfirmDraftCandidate[];
  titleSearchQuery?: string;
  hasSearchedOrSkipped?: boolean;
  isCustomDisc?: boolean;
  franchise?: string;
  animationOrLiveAction?: string;
  releaseVariantNote?: string;
  discCondition?: string;
  caseNotes?: string;
  // Collection-only, 2026-09-27 - see ConfirmScreen.tsx's own comment on the state variable.
  unintentionalCollection?: boolean;
  watched?: boolean;
  watchedDisc?: boolean;
  depictedEraLabel?: string;
  tmdbIdOverride?: string;
  genre?: string;
  runningTimeMins?: string;
  director?: string;
  isCurrentlyRentedOut?: boolean;
  rentedByWho?: string;
  dateRented?: string | null;
  originalLanguage?: string;
  movieOrTv?: string;
  seasonNo?: string;
  partOfSeasonNo?: string;
  episodeCount?: string;
  // Collection scanning flow (added 2026-09-20) - see barcode-scanning-pipeline.md.
  isCollectionOverride?: boolean;
  collectionMembers?: ConfirmDraftCollectionMember[];
}

const STORAGE_KEY = "confirmDrafts";

const drafts = new Map<string, ConfirmDraft>();

function persistDrafts(): void {
  // Fire-and-forget, same convention offlineQueue.ts's own writeQueue is called with from
  // every mutating call site there - a write failure (disk full, whatever) must never block
  // the UI, and the in-memory Map above is already correct regardless of whether this
  // succeeds, so there's nothing meaningful to await or react to here.
  AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(drafts))).catch((err) => {
    console.warn("Failed to persist confirm drafts (non-fatal):", err);
  });
}

/** Loads every saved draft from AsyncStorage into the in-memory Map - call once at app boot
 * (App.tsx), before any screen that could call getConfirmDraft has a chance to mount. A
 * corrupted/unreadable store is treated as "no drafts" rather than crashing the app, same
 * "wrong/unreadable data is worse than no data" convention offlineQueue.ts's own readQueue
 * follows. */
export async function hydrateConfirmDrafts(): Promise<void> {
  await wipeAllDraftsOnceForTesting();
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, ConfirmDraft>;
    for (const [id, draft] of Object.entries(parsed)) drafts.set(id, draft);
  } catch (err) {
    console.warn("Failed to load saved confirm drafts (non-fatal):", err);
  }
}

export function getConfirmDraft(pendingScanId: string): ConfirmDraft | undefined {
  return drafts.get(pendingScanId);
}

/** Every saved draft across all pending scans - fieldOptions.ts reads this so a brand-new
 * Franchise/Genre/etc. typed into one unsubmitted scan is offered on the others too. */
export function getAllConfirmDrafts(): ConfirmDraft[] {
  return [...drafts.values()];
}

export function saveConfirmDraft(pendingScanId: string, draft: ConfirmDraft): void {
  drafts.set(pendingScanId, draft);
  persistDrafts();
}

export function clearConfirmDraft(pendingScanId: string): void {
  drafts.delete(pendingScanId);
  persistDrafts();
}

const WIPE_FLAG_KEY = "confirmDrafts_wipedForTesting_2026-09-25";

/** One-time wipe of every saved draft (2026-09-25) - the user asked to clear all of them
 * while testing the existingMatch-prefill fix from the day before ("remove all previous
 * saves for entries and start fresh"), suspecting a leftover draft from repeatedly testing
 * the same Resident Evil barcode might be the reason old data kept resurfacing. Guarded by
 * a flag in AsyncStorage so it only ever runs once, on the first hydrate after this
 * shipped - it must never fire again after that, or it would silently destroy a real future
 * in-progress draft every time the app restarts. Safe to delete this function and its call
 * in hydrateConfirmDrafts() in a later cleanup once this is confirmed no longer needed. */
async function wipeAllDraftsOnceForTesting(): Promise<void> {
  try {
    const alreadyWiped = await AsyncStorage.getItem(WIPE_FLAG_KEY);
    if (alreadyWiped) return;
    await AsyncStorage.removeItem(STORAGE_KEY);
    await AsyncStorage.setItem(WIPE_FLAG_KEY, "true");
  } catch (err) {
    console.warn("Failed to run one-time draft wipe (non-fatal):", err);
  }
}
