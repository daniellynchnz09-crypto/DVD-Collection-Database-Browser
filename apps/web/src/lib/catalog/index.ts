import "server-only";

/**
 * Server-only data access for the website's pages. Import from "@/lib/catalog" in Server
 * Components / route files; client components may only import types (`import type`) or the
 * pure helpers in "@/lib/catalog/display".
 */
export * from "./types";
export * from "./display";
export { getCatalogClient, isMissingTableError } from "./client";
export { FORBIDDEN_TITLE_COLUMNS, TITLE_CARD_COLUMNS, TITLE_DETAIL_COLUMNS } from "./columns";
export { tmdbImage, tmdbImageUrl, resolveImages, signStoragePaths, TMDB_IMAGE_BASE } from "./images";
export type { TmdbPosterSize, TmdbBackdropSize, TmdbProfileSize, ResolvedImages } from "./images";
export { getTitleMetadata, getTitleMetadataMap, getWorkCredits, getPerson, isImdbId } from "./metadata";
export {
  findFranchise,
  getCollection,
  getDisc,
  getWork,
  isUniqueId,
  listCollectionMembers,
  listFranchises,
  listGenres,
  listRecentlyAdded,
  listTitlesByFranchise,
  listTitlesByGenre,
  rowHref,
  toPosterCards,
} from "./queries";
