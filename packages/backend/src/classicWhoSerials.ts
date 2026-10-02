import type { SupabaseClient } from "@supabase/supabase-js";
import { omdbGetById, type OmdbSearchCandidate } from "@danflix/shared";

/**
 * Detects and resolves a classic-era (1963-1989) Doctor Who serial by title text, bypassing
 * the generic OMDB/TMDb text search entirely for these - see supabase/migrations/
 * 0039_classic_who_serial_index.sql for why: OMDB's own s= search endpoint cannot find a
 * classic serial at all (its episodes are only reachable via the classic show's own
 * season/episode listing, never a plain title search), and a real scan of "The Underwater
 * Menace" confirmed this live - it false-matched an unrelated 1969 short film called "Look
 * at Life: Underwater Menace" (Type "movie"), which is what caused the scan to come back
 * wrongly classified as a plain Movie.
 *
 * Deliberately scoped to Doctor Who only, per the user's own instruction - this is NOT a
 * general "episode-Type OMDB match" rule, since that guess (TV Episode) is already correct
 * for an ordinary modern show's single-episode disc. Two gates, both required, before this
 * ever overrides the generic search:
 *   1. The typed/cover-read title text contains "Doctor Who" (case-insensitive) - classic-
 *      era BBC video/DVD releases always carry this as the series branding text.
 *   2. The best fuzzy match against classic_who_serial_index's cached serial list is
 *      genuinely close AND that matched serial's own year is before 1990 - the classic era
 *      cutoff, distinguishing it from a same-named modern-era (2005+) story that also has
 *      "Doctor Who" on its cover but should go through the normal search path instead.
 */

const DOCTOR_WHO_MENTION = /doctor who/i;
// A trigram similarity below this is treated as "not really the same title" - e.g. a typo
// or OCR misread is still well above this, but two genuinely unrelated titles are not.
const MIN_SIMILARITY = 0.4;
const CLASSIC_ERA_CUTOFF_YEAR = 1990;

// The classic (1963-1989) Doctor Who show's own IMDb id - distinct from the modern revival's
// (tt0436992). Exported so /api/scan/confirm/route.ts can check a matched OMDB detail's own
// `seriesID` against this directly (more robust than trusting a client-supplied flag) to
// decide the movie_or_tv guess: "TV Series" for a classic serial ("a selection of TV
// episodes", per the user's own words - not "TV Episode", the generic OMDB "episode"-Type
// guess that's already correct for an ordinary modern show's single-episode disc).
export const CLASSIC_WHO_SERIES_IMDB_ID = "tt0056751";

interface ClassicWhoSerialRow {
  title: string;
  season: number;
  year: number;
  episode_count: number;
  missing_episode_count: number;
  primary_imdb_id: string;
  imdb_ids: string[];
  sim: number;
}

/** Strips a leading "Doctor Who" mention (with any following colon/dash/space) so the
 * fuzzy match below compares against just the story name, e.g. "Doctor Who: The Underwater
 * Menace" -> "The Underwater Menace" - matching against the full mention text instead would
 * needlessly weaken every real serial's similarity score by the same fixed amount. */
function stripDoctorWhoMention(title: string): string {
  return title.replace(/doctor who\s*[:\-]?\s*/i, "").trim();
}

export async function matchClassicWhoSerial(
  supabase: SupabaseClient,
  typedTitle: string
): Promise<OmdbSearchCandidate[]> {
  if (!DOCTOR_WHO_MENTION.test(typedTitle)) return [];

  const storyTitle = stripDoctorWhoMention(typedTitle);
  if (!storyTitle) return [];

  const { data, error } = await supabase.rpc("fuzzy_search_classic_who_serials", {
    search_query: storyTitle,
    match_limit: 1,
  });
  if (error || !data || data.length === 0) return [];

  const match = (data as ClassicWhoSerialRow[])[0];
  if (match.sim < MIN_SIMILARITY || match.year >= CLASSIC_ERA_CUTOFF_YEAR) return [];

  // OMDB does carry a real, serial-specific poster for a classic serial's own episode entry
  // (confirmed live 2026-10-01: distinct URLs for The Underwater Menace/The Power of the
  // Daleks/The Tomb of the Cybermen, not one shared generic series image) - the original
  // hardcoded "N/A" here was never actually checked against real OMDB data, and the review
  // screen's poster card fell back to its "No poster image found" placeholder for every
  // classic serial match as a result. One extra OMDB detail lookup per match - `omdbGetById`
  // can throw (missing OMDB_API_KEY, a network failure, an unparseable response), which must
  // never sink the match itself, just leave the poster as "N/A" same as before.
  let poster = "N/A";
  try {
    const detail = await omdbGetById(match.primary_imdb_id);
    if (detail?.Poster && detail.Poster !== "N/A") poster = detail.Poster;
  } catch {
    // Keep poster as "N/A" - a missing poster is never worth failing the whole match over.
  }

  return [
    {
      Title: match.title,
      Year: String(match.year),
      imdbID: match.primary_imdb_id,
      Type: "episode",
      Poster: poster,
      classicWhoSerial: {
        season: match.season,
        episodeCount: match.episode_count,
        // See 0042_add_classic_who_missing_episodes.sql / backfill-classic-who-missing-
        // episodes.ts - used by ConfirmScreen.tsx to prefill Animation/Live Action for an
        // officially-released animated reconstruction of a serial missing some or all of its
        // episodes. 0 for the vast majority of serials, which are fully intact.
        missingEpisodeCount: match.missing_episode_count,
      },
    },
  ];
}

/**
 * Looks a confirmed candidate's own imdbID back up in classic_who_serial_index - used at
 * confirm time (/api/scan/confirm/route.ts) to compute `who_shelf_order`
 * (0041_add_who_shelf_order.sql) independent of whatever the client's own candidate list
 * still says, since the server already re-fetches the real OMDB detail record at confirm
 * time anyway (to decide movie_or_tv) and checking `imdb_ids` directly here is a single
 * source of truth rather than trusting a client-relayed field that could be stale. Matches
 * against `imdb_ids` (every episode of the serial), not just `primary_imdb_id`, since a user
 * could in principle pick a different one of the serial's own episodes as the confirmed
 * imdbID. Returns null for anything not in the classic-era index at all.
 */
export async function lookupClassicWhoSerialByImdbId(
  supabase: SupabaseClient,
  imdbId: string
): Promise<{ season: number; episodeCount: number; storyOrderInSeason: number } | null> {
  const { data, error } = await supabase
    .from("classic_who_serial_index")
    .select("season, episode_count, story_order_in_season")
    .contains("imdb_ids", [imdbId])
    .limit(1);
  if (error || !data || data.length === 0) return null;
  const row = data[0] as { season: number; episode_count: number; story_order_in_season: number };
  return { season: row.season, episodeCount: row.episode_count, storyOrderInSeason: row.story_order_in_season };
}
