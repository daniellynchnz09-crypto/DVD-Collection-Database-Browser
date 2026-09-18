/**
 * In-progress form state for a pending scan's Confirm screen. ConfirmScreen fully
 * unmounts every time the user navigates to Pending Scans and back (App.tsx's screen
 * switch is plain conditional rendering, same reason the scan-cooldown map had to move
 * up to App.tsx) - without this, anything typed or selected (best-match candidate, disc
 * count, format, ...) was silently lost the moment they left an incomplete scan and came
 * back to it. Cleared once the scan reaches a terminal state (confirmed, dismissed,
 * discarded, or attached to an existing entry) - a scan the user is still filling in
 * keeps its draft, but there's no reason to remember one that's actually done.
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
  specialFeatures: boolean;
  specialFeaturesDiscCount?: string;
  specialFeaturesDiscFormat?: string;
  releaseName?: string;
}

export interface ConfirmDraft {
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
  candidates?: ConfirmDraftCandidate[];
  titleSearchQuery?: string;
  hasSearchedOrSkipped?: boolean;
  isCustomDisc?: boolean;
  franchise?: string;
  animationOrLiveAction?: string;
  releaseVariantNote?: string;
  discCondition?: string;
  caseNotes?: string;
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

const drafts = new Map<string, ConfirmDraft>();

export function getConfirmDraft(pendingScanId: string): ConfirmDraft | undefined {
  return drafts.get(pendingScanId);
}

export function saveConfirmDraft(pendingScanId: string, draft: ConfirmDraft): void {
  drafts.set(pendingScanId, draft);
}

export function clearConfirmDraft(pendingScanId: string): void {
  drafts.delete(pendingScanId);
}
