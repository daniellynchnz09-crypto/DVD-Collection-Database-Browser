export interface OmdbSearchCandidate {
  Title: string;
  Year: string;
  imdbID: string;
  Type: string;
  Poster: string;
}

export interface OmdbDetail {
  Title: string;
  Year: string;
  Rated: string;
  Released: string;
  Runtime: string;
  Genre: string;
  Director: string;
  Plot: string;
  Poster: string;
  imdbRating: string;
  imdbID: string;
  Type: string;
}

function getApiKey(): string {
  const key = process.env.OMDB_API_KEY;
  if (!key) throw new Error("OMDB_API_KEY not configured.");
  return key;
}

/** Searches OMDB by title text, returning candidate matches for the user to pick from. */
export async function omdbSearch(query: string): Promise<OmdbSearchCandidate[]> {
  const url = `https://www.omdbapi.com/?s=${encodeURIComponent(query)}&apikey=${getApiKey()}`;
  const res = await fetch(url);
  const data = (await res.json()) as { Response: string; Search?: OmdbSearchCandidate[] };
  if (data.Response === "False") return [];
  return data.Search ?? [];
}

/** Fetches full OMDB detail for a chosen imdbID. */
export async function omdbGetById(imdbId: string): Promise<OmdbDetail | null> {
  const url = `https://www.omdbapi.com/?i=${encodeURIComponent(imdbId)}&apikey=${getApiKey()}`;
  const res = await fetch(url);
  const data = (await res.json()) as { Response: string } & OmdbDetail;
  if (data.Response === "False") return null;
  return data;
}

// OMDB's Released format is "05 May 2017"; the Sheet/DB want yyyy-mm-dd.
const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

export function parseOmdbReleaseDate(released: string | undefined): string | null {
  if (!released || released === "N/A") return null;
  const [day, monthName, year] = released.split(" ");
  const month = MONTHS[monthName?.slice(0, 3).toLowerCase()];
  if (!day || !month || !year) return null;
  return `${year}-${month}-${day.padStart(2, "0")}`;
}

export function parseOmdbRuntimeMins(runtime: string | undefined): number | null {
  if (!runtime) return null;
  const match = runtime.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Words that show up in box-set product titles but aren't part of a searchable movie/
 * franchise name - stripped before querying OMDB. Also used to flag "this looks like a
 * collection" so the confirm flow can offer the sub-title checklist.
 */
const COLLECTION_HINT_WORDS =
  /\b(collection|box ?set|boxset|complete series|trilogy|duology|anthology|bundle|\d+[- ]?(film|movie|disc)s?)\b/i;

export function looksLikeCollection(productTitle: string): boolean {
  return COLLECTION_HINT_WORDS.test(productTitle);
}

// UPCitemdb's titles are crowdsourced/scraped from resale listings, not just packaging -
// found via a real scan whose product title was "Paper Planes Dvd (2015) (region 4, Non Uk
// Standard), , Used; Acceptable Dvd": condition/listing words like "Used; Acceptable"
// weren't being stripped, so the OMDB search query came out as "Paper Planes , , Used;
// Acceptable" and matched nothing even though "Paper Planes" alone finds it easily.
const MARKETPLACE_NOISE_WORDS =
  /\b(brand new|like new|very good|good condition|acceptable|used|pre-?owned|second-?hand|free shipping|fast dispatch|fast shipping|ex-?rental|near mint|mint condition)\b/gi;

/** Strips packaging/format noise from a UPC product title to get a usable OMDB search term. */
export function cleanProductTitleForSearch(productTitle: string): string {
  return productTitle
    .replace(/\b(blu-?ray|dvd|4k|uhd|ultra ?hd|steelbook|region [a-z0-9]+|edition|disc|widescreen)\b/gi, "")
    .replace(COLLECTION_HINT_WORDS, "")
    .replace(MARKETPLACE_NOISE_WORDS, "")
    .replace(/\(.*?\)/g, "")
    .replace(/[,;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
