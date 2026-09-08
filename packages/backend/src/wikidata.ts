/**
 * Best-effort franchise lookup via Wikidata's public SPARQL Query Service. Verified this is
 * legitimate to build on before writing any code (Claude/TECH STACK AND ARCHITECTURE.md) -
 * unlike IMDb, whose own robots.txt bans automated access outright, Wikidata's own docs
 * (wikidata.org/wiki/Wikidata:Data_access) explicitly describe and permit bot/API access to
 * both the MediaWiki Action API and the SPARQL endpoint, and all its data is CC0. The two
 * robots.txt `Disallow` lines that look alarming at first glance (`/w/` on www.wikidata.org,
 * `/sparql` on query.wikidata.org) are there to stop search-engine crawlers from indexing
 * those endpoints as if they were regular pages - not a ban on the deliberate, well-scoped
 * API queries this project's own docs teach people to make. Followed their etiquette
 * requirements anyway: a descriptive User-Agent, and treating a 429 as "back off", not
 * "retry harder".
 *
 * No open, free "franchise database" exists (verified - this is why Casper's Haunted
 * Christmas's real Casper franchise membership was missing in the first place: TMDb's own
 * `belongs_to_collection` field is null for it despite obviously being a Casper film). Uses
 * Wikidata's P179 ("part of the series") as the franchise proxy - only that, deliberately.
 * P674 ("characters") was tried too and dropped after live testing: it's the property this
 * exact Casper film DOES have (as "Casper the Friendly Ghost"), and would have solved this
 * specific case, but it produces real false positives on other titles - Gladiator (a
 * standalone film, pre-2024 sequel) returned "Marcus Aurelius" as its "featured character",
 * which is a real historical figure appearing in many unrelated productions about Rome, not
 * evidence of a franchise. P179 is only ever set by Wikidata editors when a genuine series
 * actually exists, so it's far more precise, at the cost of missing titles - like this one -
 * that Wikidata hasn't explicitly tagged with a series; those just fall through to the
 * manual autocomplete field with no prefill, same as before this existed.
 */

const WIKIDATA_SPARQL_URL = "https://query.wikidata.org/sparql";
const USER_AGENT =
  "DanflixCollectionTool/1.0 (personal physical-media cataloguing app; single-user, non-commercial)";

interface SparqlBinding {
  seriesLabel?: { value: string };
}

/** Looks up a best-guess franchise/series name for a film via Wikidata, keyed by its IMDb
 * id (Wikidata's P345). Returns null (never throws) whenever nothing is found or the
 * request fails - this is a prefill suggestion for a still-editable field, not an
 * authoritative source, so a miss should never block the rest of the confirm flow. */
export async function lookupFranchiseFromWikidata(imdbId: string): Promise<string | null> {
  if (!/^tt\d+$/.test(imdbId)) return null;

  const query = `
    SELECT ?seriesLabel WHERE {
      ?item wdt:P345 "${imdbId}".
      ?item wdt:P179 ?series.
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }
    LIMIT 1
  `;

  try {
    const res = await fetch(`${WIKIDATA_SPARQL_URL}?query=${encodeURIComponent(query)}&format=json`, {
      headers: { Accept: "application/sparql-results+json", "User-Agent": USER_AGENT },
    });
    if (!res.ok) return null;

    const data = (await res.json()) as { results?: { bindings?: SparqlBinding[] } };
    return data.results?.bindings?.[0]?.seriesLabel?.value ?? null;
  } catch {
    return null;
  }
}
