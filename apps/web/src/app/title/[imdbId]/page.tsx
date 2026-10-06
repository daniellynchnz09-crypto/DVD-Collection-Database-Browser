import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Section } from "@/components/Panel";
import { PosterCard } from "@/components/PosterCard";
import { ScrollRow } from "@/components/ScrollRow";
import { PersonCircle } from "@/components/title/PersonCircle";
import { ScoreTiles } from "@/components/title/ScoreTiles";
import { FactList, HeroTitle, MetaLine, TitleHero } from "@/components/title/TitleHero";
import { Container, RowContainer, TitlePageShell } from "@/components/title/TitlePageShell";
import { TvSeriesBrowser, type StoryExtras } from "@/components/title/TvSeriesBrowser";
import { franchiseHref, getWork, getWorkCredits, personHref, tmdbImageUrl, yearOf, type Credit, type Work } from "@/lib/catalog";
import { distinctCi, formatRuntime, getSeriesBrowser, getWorkItemCards, isTvWork, personLinkHref, workDisplayTitle, type PersonLink } from "@/lib/catalog/titlePages";

// Re-rendered at most every 5 minutes, so new scans and freshly backfilled metadata show up
// without every visit hitting Supabase.
export const revalidate = 300;

export async function generateMetadata(props: PageProps<"/title/[imdbId]">): Promise<Metadata> {
  const { imdbId } = await props.params;
  const work = await getWork(imdbId);
  if (!work) return { title: "Not found" };
  const year = workYear(work);
  const title = workDisplayTitle(work);
  return {
    title: year ? `${title} (${year})` : title,
    description: work.metadata?.overview?.slice(0, 200) ?? undefined,
  };
}

export default async function TitlePage(props: PageProps<"/title/[imdbId]">) {
  const { imdbId } = await props.params;
  const work = await getWork(imdbId);
  if (!work) notFound();

  const tv = isTvWork(work);
  const [credits, itemCards, series] = await Promise.all([
    getWorkCredits(imdbId),
    getWorkItemCards(work),
    tv ? getSeriesBrowser(work) : Promise.resolve(null),
  ]);

  const meta = work.metadata;
  const rows = work.items.map((d) => d.row);
  // A standalone copy describes the film better than a box-set header row does.
  const primary = (work.items.find((d) => !d.row.is_collection) ?? work.items[0]).row;
  const year = workYear(work);
  const title = workDisplayTitle(work);
  const kind = tv ? (primary.movie_or_tv && primary.movie_or_tv !== "Movie" ? primary.movie_or_tv : "TV Series") : primary.movie_or_tv || "Movie";
  const runtime = formatRuntime(meta?.runtime_mins ?? (tv ? null : primary.running_time_mins));
  const genres = meta?.genres?.length ? meta.genres : distinctCi(rows.flatMap((r) => r.genre ?? []));
  const franchises = distinctCi(rows.flatMap((r) => r.franchise ?? []));

  const directorCredits = credits.crew.filter((c) => c.job === "Director");
  const directors: Array<PersonLink & { imageSrc: string | null }> =
    directorCredits.length > 0
      ? dedupePeople(directorCredits).map((c) => ({ name: c.person.name, tmdbPersonId: c.person.tmdb_person_id, imageSrc: tmdbImageUrl(c.person.profile_path, "w185") }))
      : distinctCi(rows.flatMap((r) => r.director ?? [])).map((name) => ({ name, tmdbPersonId: null, imageSrc: null }));
  const crew = groupCrew(credits.crew.filter((c) => c.job !== "Director"));

  const rtUrl = rows.map((r) => r.rotten_tomatoes_page).find((u) => !!u && /^https:\/\/(www\.)?rottentomatoes\.com\//i.test(u)) ?? null;
  const usesTmdb = !!meta || work.poster?.source === "tmdb" || !!series?.usedTmdb;
  let ownScoreTile: ReactNode = null;
  let ownReview: ReactNode = null;
  let storyExtras: StoryExtras | undefined;

  return (
    <TitlePageShell title={title} eyebrow={`${kind}${year ? ` // ${year}` : ""}`} backdrop={work.poster ?? work.backdrop} tmdbAttribution={usesTmdb}>
      <Container>
        <TitleHero image={work.poster} imageAlt={title}>
          <HeroTitle kicker={kind} title={title} subtitle={meta?.tagline || null} />
          <MetaLine
            parts={[
              year,
              runtime,
              primary.rating,
              tv && meta?.number_of_seasons ? `${meta.number_of_seasons} season${meta.number_of_seasons === 1 ? "" : "s"}` : null,
            ]}
          />
          <ScoreTiles
            imdbRating={meta?.imdb_rating ?? null}
            imdbVotes={meta?.imdb_votes ?? null}
            rottenTomatoes={meta?.rotten_tomatoes_score ?? null}
            rtAudience={meta?.rt_audience_score ?? null}
            metacritic={meta?.metacritic_score ?? null}
            imdbUrl={`https://www.imdb.com/title/${imdbId}/`}
            rottenTomatoesUrl={rtUrl}
            extraTiles={ownScoreTile}
          />
          {ownReview}
          <FactList
            facts={[
              directors.length > 0 && {
                label: directors.length > 1 ? "Directors" : "Director",
                value: <PeopleInline people={directors} />,
              },
              genres.length > 0 && { label: "Genre", value: genres.join(", ") },
              franchises.length > 0 && {
                label: "Franchise",
                value: (
                  <span className="flex flex-wrap gap-x-3">
                    {franchises.map((f) => (
                      <Link key={f} href={franchiseHref(f)} className="text-accent hover:text-accent-hi">
                        {f}
                      </Link>
                    ))}
                  </span>
                ),
              },
              primary.studio && { label: "Studio", value: primary.studio },
              primary.original_language && { label: "Language", value: primary.original_language },
              meta?.original_title && meta.original_title !== title && { label: "Original title", value: meta.original_title },
              { label: "Owned", value: <OwnedBadges count={work.items.length} formats={distinctCi(rows.map((r) => r.format))} /> },
            ]}
          />
        </TitleHero>
      </Container>

      {meta?.overview ? (
        <Container>
          <Section title="Synopsis">
            <p className="max-w-4xl text-base leading-relaxed text-chrome sm:text-lg">{meta.overview}</p>
          </Section>
        </Container>
      ) : null}

      {series && series.seasons.length > 0 ? (
        <Container>
          <Section title="Series Browser" aside={`${series.seasons.length} in collection`}>
            <TvSeriesBrowser seasons={series.seasons} tmdbLinked={series.tmdbLinked} storyExtras={storyExtras} />
          </Section>
        </Container>
      ) : null}

      {itemCards.length > 0 ? (
        <RowContainer>
          <ScrollRow title="In the collection" label={`${itemCards.length}x`}>
            {itemCards.map((card) => (
              <PosterCard key={card.key} card={card} />
            ))}
          </ScrollRow>
        </RowContainer>
      ) : null}

      {directors.length > 0 ? (
        <Container>
          <Section title={directors.length > 1 ? "Directors" : "Director"}>
            <div className="flex flex-wrap gap-6">
              {directors.map((d) => (
                <PersonCircle key={d.name} size="lg" name={d.name} role="Director" imageSrc={d.imageSrc} href={personLinkHref(d)} />
              ))}
            </div>
          </Section>
        </Container>
      ) : null}

      {credits.cast.length > 0 ? (
        <RowContainer>
          <ScrollRow title="Cast">
            {credits.cast.map((c) => (
              <PersonCircle
                key={`${c.person.tmdb_person_id}:${c.character ?? ""}`}
                name={c.person.name}
                role={c.character}
                imageSrc={tmdbImageUrl(c.person.profile_path, "w185")}
                href={personHref(c.person.tmdb_person_id)}
              />
            ))}
          </ScrollRow>
        </RowContainer>
      ) : null}

      {crew.length > 0 ? (
        <RowContainer>
          <ScrollRow title="Crew">
            {crew.map((c) => (
              <PersonCircle
                key={c.person.tmdb_person_id}
                name={c.person.name}
                role={c.jobs.join(", ")}
                imageSrc={tmdbImageUrl(c.person.profile_path, "w185")}
                href={personHref(c.person.tmdb_person_id)}
              />
            ))}
          </ScrollRow>
        </RowContainer>
      ) : null}

      {credits.cast.length === 0 && crew.length === 0 ? (
        <Container>
          <p className="label-tech text-mist-dim">Full cast &amp; crew appear once this title&apos;s film data has been fetched.</p>
        </Container>
      ) : null}
    </TitlePageShell>
  );
}

function workYear(work: Work): string | null {
  const primary = work.items.find((d) => !d.row.is_collection) ?? work.items[0];
  return yearOf(work.metadata?.release_date) ?? yearOf(primary.row.release_date);
}

function dedupePeople(credits: Credit[]): Credit[] {
  const seen = new Set<number>();
  return credits.filter((c) => (seen.has(c.person.tmdb_person_id) ? false : (seen.add(c.person.tmdb_person_id), true)));
}

/** One circle per crew member, with all their jobs ("Writer, Producer"). */
function groupCrew(credits: Credit[]): Array<{ person: Credit["person"]; jobs: string[] }> {
  const byId = new Map<number, { person: Credit["person"]; jobs: string[] }>();
  for (const c of credits) {
    const entry = byId.get(c.person.tmdb_person_id) ?? { person: c.person, jobs: [] };
    const job = c.job ?? c.department;
    if (job && !entry.jobs.includes(job)) entry.jobs.push(job);
    byId.set(c.person.tmdb_person_id, entry);
  }
  return [...byId.values()];
}

function PeopleInline({ people }: { people: PersonLink[] }) {
  return (
    <span className="flex flex-wrap gap-x-3">
      {people.map((p) => (
        <Link key={p.name} href={personLinkHref(p)} className="text-accent hover:text-accent-hi">
          {p.name}
        </Link>
      ))}
    </span>
  );
}

function OwnedBadges({ count, formats }: { count: number; formats: string[] }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1">
        {count} cop{count === 1 ? "y" : "ies"}
      </span>
      {formats.map((f) => (
        <Badge key={f}>{f}</Badge>
      ))}
    </span>
  );
}
