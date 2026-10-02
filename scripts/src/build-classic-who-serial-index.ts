/**
 * One-time build of the classic_who_serial_index table (supabase/migrations/
 * 0039_classic_who_serial_index.sql) - see that migration's own header comment for why this
 * exists: OMDB's s= title-search endpoint cannot find a classic-era (1963-1989) Doctor Who
 * serial at all, since each serial's episodes are nested under the classic show's own IMDb
 * entry (tt0056751) and only reachable via its season/episode listing.
 *
 * CLASSIC_WHO_SEASONS below is the canonical season/story/episode-count breakdown, hand-
 * verified against real, documented broadcast history and then cross-checked here at
 * import time (see the sum-check below) against OMDB's own per-season episode totals -
 * every one of the 26 seasons reconciles exactly. Season 23 ("The Trial of a Time Lord")
 * is deliberately kept as four separate serials (The Mysterious Planet/Mindwarp/Terror of
 * the Vervoids/The Ultimate Foe) rather than one merged 14-part entry, the same way Season
 * 16 ("The Key to Time")'s six serials are kept separate rather than merged into one
 * "Key to Time" mega-serial - the user's own explicit call on this.
 *
 * For each season, this fetches OMDB's ordered episode list once (i=tt0056751&Season=N)
 * and slices it sequentially by each serial's own episodeCount to get that serial's real
 * imdbIDs - no title-text pattern-matching needed (which would fail on the earliest
 * seasons, where a serial's parts don't share a common "Story: Episode N" prefix at all,
 * e.g. "An Unearthly Child"/"The Cave of Skulls"/"The Forest of Fear"/"The Firemaker").
 *
 * Required env vars (see .env.example): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 * OMDB_API_KEY. Run once via `npm run build-classic-who-serial-index` from the repo root -
 * idempotent (upserts on the season+title unique constraint), safe to re-run.
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const CLASSIC_WHO_SERIES_IMDB_ID = "tt0056751";

interface SerialSpec {
  title: string;
  episodeCount: number;
  year: number;
}
interface SeasonSpec {
  season: number;
  serials: SerialSpec[];
}

const CLASSIC_WHO_SEASONS: SeasonSpec[] = [
  { season: 1, serials: [
    { title: "An Unearthly Child", episodeCount: 4, year: 1963 },
    { title: "The Daleks", episodeCount: 7, year: 1963 },
    { title: "The Edge of Destruction", episodeCount: 2, year: 1964 },
    { title: "Marco Polo", episodeCount: 7, year: 1964 },
    { title: "The Keys of Marinus", episodeCount: 6, year: 1964 },
    { title: "The Aztecs", episodeCount: 4, year: 1964 },
    { title: "The Sensorites", episodeCount: 6, year: 1964 },
    { title: "The Reign of Terror", episodeCount: 6, year: 1964 },
  ]},
  { season: 2, serials: [
    { title: "Planet of Giants", episodeCount: 3, year: 1964 },
    { title: "The Dalek Invasion of Earth", episodeCount: 6, year: 1964 },
    { title: "The Rescue", episodeCount: 2, year: 1965 },
    { title: "The Romans", episodeCount: 4, year: 1965 },
    { title: "The Web Planet", episodeCount: 6, year: 1965 },
    { title: "The Crusade", episodeCount: 4, year: 1965 },
    { title: "The Space Museum", episodeCount: 4, year: 1965 },
    { title: "The Chase", episodeCount: 6, year: 1965 },
    { title: "The Time Meddler", episodeCount: 4, year: 1965 },
  ]},
  { season: 3, serials: [
    { title: "Galaxy 4", episodeCount: 4, year: 1965 },
    { title: "Mission to the Unknown", episodeCount: 1, year: 1965 },
    { title: "The Myth Makers", episodeCount: 4, year: 1965 },
    { title: "The Daleks' Master Plan", episodeCount: 12, year: 1965 },
    { title: "The Massacre of St Bartholomew's Eve", episodeCount: 4, year: 1966 },
    { title: "The Ark", episodeCount: 4, year: 1966 },
    { title: "The Celestial Toymaker", episodeCount: 4, year: 1966 },
    { title: "The Gunfighters", episodeCount: 4, year: 1966 },
    { title: "The Savages", episodeCount: 4, year: 1966 },
    { title: "The War Machines", episodeCount: 4, year: 1966 },
  ]},
  { season: 4, serials: [
    { title: "The Smugglers", episodeCount: 4, year: 1966 },
    { title: "The Tenth Planet", episodeCount: 4, year: 1966 },
    { title: "The Power of the Daleks", episodeCount: 6, year: 1966 },
    { title: "The Highlanders", episodeCount: 4, year: 1966 },
    { title: "The Underwater Menace", episodeCount: 4, year: 1967 },
    { title: "The Moonbase", episodeCount: 4, year: 1967 },
    { title: "The Macra Terror", episodeCount: 4, year: 1967 },
    { title: "The Faceless Ones", episodeCount: 6, year: 1967 },
    { title: "The Evil of the Daleks", episodeCount: 7, year: 1967 },
  ]},
  { season: 5, serials: [
    { title: "The Tomb of the Cybermen", episodeCount: 4, year: 1967 },
    { title: "The Abominable Snowmen", episodeCount: 6, year: 1967 },
    { title: "The Ice Warriors", episodeCount: 6, year: 1967 },
    { title: "The Enemy of the World", episodeCount: 6, year: 1967 },
    { title: "The Web of Fear", episodeCount: 6, year: 1968 },
    { title: "Fury from the Deep", episodeCount: 6, year: 1968 },
    { title: "The Wheel in Space", episodeCount: 6, year: 1968 },
  ]},
  { season: 6, serials: [
    { title: "The Dominators", episodeCount: 5, year: 1968 },
    { title: "The Mind Robber", episodeCount: 5, year: 1968 },
    { title: "The Invasion", episodeCount: 8, year: 1968 },
    { title: "The Krotons", episodeCount: 4, year: 1968 },
    { title: "The Seeds of Death", episodeCount: 6, year: 1969 },
    { title: "The Space Pirates", episodeCount: 6, year: 1969 },
    { title: "The War Games", episodeCount: 10, year: 1969 },
  ]},
  { season: 7, serials: [
    { title: "Spearhead from Space", episodeCount: 4, year: 1970 },
    { title: "Doctor Who and the Silurians", episodeCount: 7, year: 1970 },
    { title: "The Ambassadors of Death", episodeCount: 7, year: 1970 },
    { title: "Inferno", episodeCount: 7, year: 1970 },
  ]},
  { season: 8, serials: [
    { title: "Terror of the Autons", episodeCount: 4, year: 1971 },
    { title: "The Mind of Evil", episodeCount: 6, year: 1971 },
    { title: "The Claws of Axos", episodeCount: 4, year: 1971 },
    { title: "Colony in Space", episodeCount: 6, year: 1971 },
    { title: "The Daemons", episodeCount: 5, year: 1971 },
  ]},
  { season: 9, serials: [
    { title: "Day of the Daleks", episodeCount: 4, year: 1972 },
    { title: "The Curse of Peladon", episodeCount: 4, year: 1972 },
    { title: "The Sea Devils", episodeCount: 6, year: 1972 },
    { title: "The Mutants", episodeCount: 6, year: 1972 },
    { title: "The Time Monster", episodeCount: 6, year: 1972 },
  ]},
  { season: 10, serials: [
    { title: "The Three Doctors", episodeCount: 4, year: 1972 },
    { title: "Carnival of Monsters", episodeCount: 4, year: 1973 },
    { title: "Frontier in Space", episodeCount: 6, year: 1973 },
    { title: "Planet of the Daleks", episodeCount: 6, year: 1973 },
    { title: "The Green Death", episodeCount: 6, year: 1973 },
  ]},
  { season: 11, serials: [
    { title: "The Time Warrior", episodeCount: 4, year: 1973 },
    { title: "Invasion of the Dinosaurs", episodeCount: 6, year: 1974 },
    { title: "Death to the Daleks", episodeCount: 4, year: 1974 },
    { title: "The Monster of Peladon", episodeCount: 6, year: 1974 },
    { title: "Planet of the Spiders", episodeCount: 6, year: 1974 },
  ]},
  { season: 12, serials: [
    { title: "Robot", episodeCount: 4, year: 1974 },
    { title: "The Ark in Space", episodeCount: 4, year: 1975 },
    { title: "The Sontaran Experiment", episodeCount: 2, year: 1975 },
    { title: "Genesis of the Daleks", episodeCount: 6, year: 1975 },
    { title: "Revenge of the Cybermen", episodeCount: 4, year: 1975 },
  ]},
  { season: 13, serials: [
    { title: "Terror of the Zygons", episodeCount: 4, year: 1975 },
    { title: "Planet of Evil", episodeCount: 4, year: 1975 },
    { title: "Pyramids of Mars", episodeCount: 4, year: 1975 },
    { title: "The Android Invasion", episodeCount: 4, year: 1975 },
    { title: "The Brain of Morbius", episodeCount: 4, year: 1976 },
    { title: "The Seeds of Doom", episodeCount: 6, year: 1976 },
  ]},
  { season: 14, serials: [
    { title: "The Masque of Mandragora", episodeCount: 4, year: 1976 },
    { title: "The Hand of Fear", episodeCount: 4, year: 1976 },
    { title: "The Deadly Assassin", episodeCount: 4, year: 1976 },
    { title: "The Face of Evil", episodeCount: 4, year: 1977 },
    { title: "The Robots of Death", episodeCount: 4, year: 1977 },
    { title: "The Talons of Weng-Chiang", episodeCount: 6, year: 1977 },
  ]},
  { season: 15, serials: [
    { title: "Horror of Fang Rock", episodeCount: 4, year: 1977 },
    { title: "The Invisible Enemy", episodeCount: 4, year: 1977 },
    { title: "Image of the Fendahl", episodeCount: 4, year: 1977 },
    { title: "The Sun Makers", episodeCount: 4, year: 1977 },
    { title: "Underworld", episodeCount: 4, year: 1978 },
    { title: "The Invasion of Time", episodeCount: 6, year: 1978 },
  ]},
  { season: 16, serials: [
    { title: "The Ribos Operation", episodeCount: 4, year: 1978 },
    { title: "The Pirate Planet", episodeCount: 4, year: 1978 },
    { title: "The Stones of Blood", episodeCount: 4, year: 1978 },
    { title: "The Androids of Tara", episodeCount: 4, year: 1978 },
    { title: "The Power of Kroll", episodeCount: 4, year: 1979 },
    { title: "The Armageddon Factor", episodeCount: 6, year: 1979 },
  ]},
  { season: 17, serials: [
    { title: "Destiny of the Daleks", episodeCount: 4, year: 1979 },
    { title: "City of Death", episodeCount: 4, year: 1979 },
    { title: "The Creature from the Pit", episodeCount: 4, year: 1979 },
    { title: "Nightmare of Eden", episodeCount: 4, year: 1979 },
    { title: "The Horns of Nimon", episodeCount: 4, year: 1979 },
  ]},
  { season: 18, serials: [
    { title: "The Leisure Hive", episodeCount: 4, year: 1980 },
    { title: "Meglos", episodeCount: 4, year: 1980 },
    { title: "Full Circle", episodeCount: 4, year: 1980 },
    { title: "State of Decay", episodeCount: 4, year: 1980 },
    { title: "Warriors' Gate", episodeCount: 4, year: 1981 },
    { title: "The Keeper of Traken", episodeCount: 4, year: 1981 },
    { title: "Logopolis", episodeCount: 4, year: 1981 },
  ]},
  { season: 19, serials: [
    { title: "Castrovalva", episodeCount: 4, year: 1982 },
    { title: "Four to Doomsday", episodeCount: 4, year: 1982 },
    { title: "Kinda", episodeCount: 4, year: 1982 },
    { title: "The Visitation", episodeCount: 4, year: 1982 },
    { title: "Black Orchid", episodeCount: 2, year: 1982 },
    { title: "Earthshock", episodeCount: 4, year: 1982 },
    { title: "Time-Flight", episodeCount: 4, year: 1982 },
  ]},
  { season: 20, serials: [
    { title: "Arc of Infinity", episodeCount: 4, year: 1983 },
    { title: "Snakedance", episodeCount: 4, year: 1983 },
    { title: "Mawdryn Undead", episodeCount: 4, year: 1983 },
    { title: "Terminus", episodeCount: 4, year: 1983 },
    { title: "Enlightenment", episodeCount: 4, year: 1983 },
    { title: "The King's Demons", episodeCount: 2, year: 1983 },
    { title: "The Five Doctors", episodeCount: 1, year: 1983 },
  ]},
  { season: 21, serials: [
    { title: "Warriors of the Deep", episodeCount: 4, year: 1984 },
    { title: "The Awakening", episodeCount: 2, year: 1984 },
    { title: "Frontios", episodeCount: 4, year: 1984 },
    { title: "Resurrection of the Daleks", episodeCount: 2, year: 1984 },
    { title: "Planet of Fire", episodeCount: 4, year: 1984 },
    { title: "The Caves of Androzani", episodeCount: 4, year: 1984 },
    { title: "The Twin Dilemma", episodeCount: 4, year: 1984 },
  ]},
  { season: 22, serials: [
    { title: "Attack of the Cybermen", episodeCount: 2, year: 1985 },
    { title: "Vengeance on Varos", episodeCount: 2, year: 1985 },
    { title: "The Mark of the Rani", episodeCount: 2, year: 1985 },
    { title: "The Two Doctors", episodeCount: 3, year: 1985 },
    { title: "Timelash", episodeCount: 2, year: 1985 },
    { title: "Revelation of the Daleks", episodeCount: 2, year: 1985 },
  ]},
  // Season 23 ("The Trial of a Time Lord") kept as four separate serials, same convention
  // as Season 16 ("The Key to Time") - see this file's header comment.
  { season: 23, serials: [
    { title: "The Mysterious Planet", episodeCount: 4, year: 1986 },
    { title: "Mindwarp", episodeCount: 4, year: 1986 },
    { title: "Terror of the Vervoids", episodeCount: 4, year: 1986 },
    { title: "The Ultimate Foe", episodeCount: 2, year: 1986 },
  ]},
  { season: 24, serials: [
    { title: "Time and the Rani", episodeCount: 4, year: 1987 },
    { title: "Paradise Towers", episodeCount: 4, year: 1987 },
    { title: "Delta and the Bannermen", episodeCount: 3, year: 1987 },
    { title: "Dragonfire", episodeCount: 3, year: 1987 },
  ]},
  { season: 25, serials: [
    { title: "Remembrance of the Daleks", episodeCount: 4, year: 1988 },
    { title: "The Happiness Patrol", episodeCount: 3, year: 1988 },
    { title: "Silver Nemesis", episodeCount: 3, year: 1988 },
    { title: "The Greatest Show in the Galaxy", episodeCount: 4, year: 1988 },
  ]},
  { season: 26, serials: [
    { title: "Battlefield", episodeCount: 4, year: 1989 },
    { title: "Ghost Light", episodeCount: 3, year: 1989 },
    { title: "The Curse of Fenric", episodeCount: 4, year: 1989 },
    { title: "Survival", episodeCount: 3, year: 1989 },
  ]},
];

interface OmdbSeasonEpisode {
  imdbID: string;
}
interface OmdbSeasonResponse {
  Response: string;
  Error?: string;
  Episodes?: OmdbSeasonEpisode[];
}

function getOmdbApiKey(): string {
  const key = process.env.OMDB_API_KEY;
  if (!key) throw new Error("OMDB_API_KEY not configured.");
  return key;
}

async function fetchSeasonEpisodeIds(season: number): Promise<string[]> {
  const url = `https://www.omdbapi.com/?i=${CLASSIC_WHO_SERIES_IMDB_ID}&Season=${season}&apikey=${getOmdbApiKey()}`;
  const res = await fetch(url);
  const data = (await res.json()) as OmdbSeasonResponse;
  if (data.Response === "False" || !data.Episodes) {
    throw new Error(`OMDB season ${season} lookup failed: ${data.Error ?? "no Episodes returned"}`);
  }
  return data.Episodes.map((e) => e.imdbID);
}

async function main() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error(
      "Missing required env vars. Copy .env.example to .env and fill in SUPABASE_URL and " +
        "SUPABASE_SERVICE_ROLE_KEY, then re-run."
    );
    process.exit(1);
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const rows: {
    title: string;
    season: number;
    year: number;
    episode_count: number;
    primary_imdb_id: string;
    imdb_ids: string[];
    story_order_in_season: number;
  }[] = [];

  for (const seasonSpec of CLASSIC_WHO_SEASONS) {
    const episodeIds = await fetchSeasonEpisodeIds(seasonSpec.season);
    const expectedTotal = seasonSpec.serials.reduce((sum, s) => sum + s.episodeCount, 0);
    if (episodeIds.length !== expectedTotal) {
      throw new Error(
        `Season ${seasonSpec.season}: expected ${expectedTotal} episodes across its serials, ` +
          `but OMDB returned ${episodeIds.length}. Refusing to guess - fix CLASSIC_WHO_SEASONS first.`
      );
    }

    let cursor = 0;
    seasonSpec.serials.forEach((serial, index) => {
      const imdbIds = episodeIds.slice(cursor, cursor + serial.episodeCount);
      cursor += serial.episodeCount;
      rows.push({
        title: serial.title,
        season: seasonSpec.season,
        year: serial.year,
        episode_count: serial.episodeCount,
        primary_imdb_id: imdbIds[0],
        imdb_ids: imdbIds,
        // 1-based broadcast position within this season - CLASSIC_WHO_SEASONS already lists
        // each season's serials in real broadcast order (see this file's header comment), so
        // this is just that position. Backs the Doctor Who shelf-ordering feature (0041_add_
        // who_shelf_order.sql) - lets an individual serial disc sort directly before the
        // season box set it belongs to, and every other serial in that season sort in the
        // right relative order too.
        story_order_in_season: index + 1,
      });
    });
    console.log(`Season ${seasonSpec.season}: ${seasonSpec.serials.length} serials, ${episodeIds.length} episodes - OK.`);
  }

  console.log(`Upserting ${rows.length} classic Doctor Who serials...`);
  const { error } = await supabase.from("classic_who_serial_index").upsert(rows, { onConflict: "season,title" });
  if (error) {
    console.error("Upsert failed:", error.message);
    process.exit(1);
  }

  console.log(`Done. ${rows.length} classic Doctor Who serials indexed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
