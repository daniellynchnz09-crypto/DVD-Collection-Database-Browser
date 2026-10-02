/**
 * ONE-TIME backfill (2026-10-01): populates `missing_episode_count`
 * (0042_add_classic_who_missing_episodes.sql) on the classic_who_serial_index rows for every
 * serial that's missing some or all of its episodes from the BBC archive - see that
 * migration's own header comment for why this matters (an animated-reconstruction detection
 * signal, not just trivia).
 *
 * MISSING_EPISODES below is hand-verified against Wikipedia's "List of incomplete Doctor Who
 * serials" (2026-10-01), the same "hand-verified against a real documented source" precedent
 * build-classic-who-serial-index.ts's own CLASSIC_WHO_SEASONS data already follows. Every
 * serial not listed here keeps the column's default of 0 (fully intact) - this script never
 * writes a 0 itself, only the real missing counts, so re-running it is always safe and it
 * never needs updating for a serial that stays complete.
 *
 * Every title string here must match classic_who_serial_index's own `title` column exactly
 * (see build-classic-who-serial-index.ts's CLASSIC_WHO_SEASONS for the canonical spelling) -
 * matched together with `season` against the table's own unique(season, title) key, so a
 * spelling mismatch fails loudly (SKIP, not a silent no-op) rather than writing nothing.
 *
 * Dry run by default - only writes to Supabase with `--apply`, same convention as this
 * project's other backfill scripts.
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const MISSING_EPISODES: { season: number; title: string; missingEpisodeCount: number }[] = [
  // First Doctor
  { season: 1, title: "Marco Polo", missingEpisodeCount: 7 },
  { season: 1, title: "The Reign of Terror", missingEpisodeCount: 2 },
  { season: 2, title: "The Crusade", missingEpisodeCount: 2 },
  { season: 3, title: "Galaxy 4", missingEpisodeCount: 3 },
  { season: 3, title: "Mission to the Unknown", missingEpisodeCount: 1 },
  { season: 3, title: "The Myth Makers", missingEpisodeCount: 4 },
  { season: 3, title: "The Daleks' Master Plan", missingEpisodeCount: 7 },
  { season: 3, title: "The Massacre of St Bartholomew's Eve", missingEpisodeCount: 4 },
  { season: 3, title: "The Celestial Toymaker", missingEpisodeCount: 3 },
  { season: 3, title: "The Savages", missingEpisodeCount: 4 },
  { season: 4, title: "The Smugglers", missingEpisodeCount: 4 },
  { season: 4, title: "The Tenth Planet", missingEpisodeCount: 1 },
  // Second Doctor
  { season: 4, title: "The Power of the Daleks", missingEpisodeCount: 6 },
  { season: 4, title: "The Highlanders", missingEpisodeCount: 4 },
  { season: 4, title: "The Underwater Menace", missingEpisodeCount: 2 },
  { season: 4, title: "The Moonbase", missingEpisodeCount: 2 },
  { season: 4, title: "The Macra Terror", missingEpisodeCount: 4 },
  { season: 4, title: "The Faceless Ones", missingEpisodeCount: 4 },
  { season: 4, title: "The Evil of the Daleks", missingEpisodeCount: 6 },
  { season: 5, title: "The Abominable Snowmen", missingEpisodeCount: 5 },
  { season: 5, title: "The Ice Warriors", missingEpisodeCount: 2 },
  { season: 5, title: "The Web of Fear", missingEpisodeCount: 1 },
  { season: 5, title: "Fury from the Deep", missingEpisodeCount: 6 },
  { season: 5, title: "The Wheel in Space", missingEpisodeCount: 4 },
  { season: 6, title: "The Invasion", missingEpisodeCount: 2 },
  { season: 6, title: "The Space Pirates", missingEpisodeCount: 5 },
];

async function main() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY - copy .env.example to .env and fill them in.");
    process.exit(1);
  }
  const apply = process.argv.includes("--apply");
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  for (const row of MISSING_EPISODES) {
    const { data: current, error: fetchError } = await supabase
      .from("classic_who_serial_index")
      .select("episode_count, missing_episode_count")
      .eq("season", row.season)
      .eq("title", row.title)
      .maybeSingle();
    if (fetchError || !current) {
      console.log(`  SKIP (not found - season ${row.season}, title "${row.title}") - check spelling against CLASSIC_WHO_SEASONS`);
      continue;
    }
    if (row.missingEpisodeCount > current.episode_count) {
      console.log(
        `  SKIP (missing count ${row.missingEpisodeCount} exceeds episode_count ${current.episode_count}) - "${row.title}"`
      );
      continue;
    }
    if (current.missing_episode_count === row.missingEpisodeCount) {
      console.log(`  OK already - ${row.title}`);
      continue;
    }

    console.log(
      `  ${apply ? "UPDATING" : "WOULD UPDATE"} - ${row.title} (season ${row.season}): missing_episode_count ${current.missing_episode_count} -> ${row.missingEpisodeCount}`
    );
    if (apply) {
      const { error: updateError } = await supabase
        .from("classic_who_serial_index")
        .update({ missing_episode_count: row.missingEpisodeCount })
        .eq("season", row.season)
        .eq("title", row.title);
      if (updateError) console.log(`    FAILED: ${updateError.message}`);
    }
  }

  if (!apply) console.log("\nDry run - re-run with --apply to actually update Supabase.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
