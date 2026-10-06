import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Badge, Panel, Section } from "@/components/Panel";
import { PosterImage } from "@/components/PosterImage";
import { RelatedLinks, type RelatedLink } from "@/components/title/RelatedLinks";
import { FactList, HeroTitle, MetaLine, TitleHero } from "@/components/title/TitleHero";
import { Container, TitlePageShell } from "@/components/title/TitlePageShell";
import {
  discHref,
  displayTitle,
  franchiseHref,
  getCollection,
  getDisc,
  shortFormatLabel,
  workHref,
  yearOf,
  type CatalogImage,
  frameAspect,
  type Disc,
} from "@/lib/catalog";
import {
  directorsFor,
  discOfSetLabel,
  distinctCi,
  formatRegion,
  formatRuntime,
  regionChip,
  getDirectorsByImdbId,
  memberDiscSortKey,
  personLinkHref,
  specialFeaturesText,
  type PersonLink,
} from "@/lib/catalog/titlePages";

export const revalidate = 300;

export async function generateMetadata(props: PageProps<"/collection/[uniqueId]">): Promise<Metadata> {
  const { uniqueId } = await props.params;
  const collection = await getCollection(uniqueId);
  if (!collection) return { title: "Not found" };
  return { title: displayTitle(collection.header.row) };
}

/** DVD Collection Page: a box set as a whole plus every catalogued title in it. */
export default async function CollectionPage(props: PageProps<"/collection/[uniqueId]">) {
  const { uniqueId } = await props.params;
  const collection = await getCollection(uniqueId);
  if (!collection) {
    // A valid row that just isn't a box set belongs on its DVD page.
    if (await getDisc(uniqueId)) redirect(discHref(uniqueId));
    notFound();
  }

  const { header } = collection;
  const row = header.row;
  const members = [...collection.members].sort((a, b) => memberDiscSortKey(a) - memberDiscSortKey(b));
  const directorCredits = await getDirectorsByImdbId(members.map((m) => m.imdbId));

  const title = displayTitle(row);
  const year = yearOf(row.release_date);
  const format = shortFormatLabel(row.format);
  const region = formatRegion(row.disk_region);
  const titleCount = row.number_of_titles_in_collection;
  const heroImage: CatalogImage | null = header.caseImage ?? header.poster ?? members.find((m) => m.poster)?.poster ?? null;

  // Related pages: the set's own Movie/TV page (e.g. a whole-series box set), franchises and
  // directors across the set.
  const related: RelatedLink[] = [];
  if (header.imdbId) {
    related.push({ href: workHref(header.imdbId), kind: "Movie / TV page", label: header.metadata?.title ?? row.title });
  }
  for (const f of distinctCi([row, ...members.map((m) => m.row)].flatMap((r) => r.franchise ?? []))) {
    related.push({ href: franchiseHref(f), kind: "Franchise", label: f });
  }
  const directors = dedupeByName(members.flatMap((m) => directorsFor(m.row, m.imdbId, directorCredits)).concat(directorsFor(row, null, directorCredits)));
  for (const d of directors) related.push({ href: personLinkHref(d), kind: "Director", label: d.name });

  const usesTmdb = !!header.metadata || [header, ...members].some((d) => d.poster?.source === "tmdb");

  return (
    <TitlePageShell title={title} eyebrow={["Collection", format].filter(Boolean).join(" // ")} backdrop={heroImage} tmdbAttribution={usesTmdb}>
      <Container>
        <TitleHero image={heroImage} imageAlt={title} aspect={frameAspect(heroImage, header.row.format)}>
          <HeroTitle kicker="Box set" title={title} subtitle={row.release_name && row.release_name.trim() !== row.title ? row.title : null} />
          <MetaLine
            parts={[
              format,
              `${row.disc_count} disc${row.disc_count === 1 ? "" : "s"}`,
              `${titleCount ?? members.length} title${(titleCount ?? members.length) === 1 ? "" : "s"}`,
              regionChip(region),
            ]}
          />
          <div className="flex flex-wrap gap-1.5">
            {row.special_features ? <Badge>Special features</Badge> : <Badge tone="muted">No special features</Badge>}
            {row.steelbook ? <Badge>Steelbook</Badge> : null}
            {row.is_currently_rented_out ? <Badge tone="signal">Currently rented out</Badge> : null}
          </div>
          <Panel title="Set data">
            <FactList
              facts={[
                { label: "Format", value: row.format },
                { label: "Total discs", value: String(row.disc_count) },
                {
                  label: "Titles",
                  value:
                    titleCount && titleCount !== members.length
                      ? `${titleCount} (${members.length} catalogued individually)`
                      : String(titleCount ?? members.length),
                },
                { label: "Region", value: region ?? "Not recorded" },
                { label: "Special features", value: specialFeaturesText(row) },
                year && { label: "Released", value: year },
                row.studio && { label: "Studio", value: row.studio },
                row.rating && { label: "Rating", value: row.rating },
                row.genre?.length > 0 && { label: "Genre", value: row.genre.join(", ") },
              ]}
            />
          </Panel>
        </TitleHero>
      </Container>

      {row.release_variant_note?.trim() ? (
        <Container>
          <Section title="About this set">
            <p className="max-w-4xl text-base leading-relaxed text-chrome">{row.release_variant_note}</p>
          </Section>
        </Container>
      ) : null}

      <Container>
        <Section title="Titles in this set" aside={`${members.length} catalogued`}>
          {members.length > 0 ? (
            <ol className="grid gap-3 lg:grid-cols-2">
              {members.map((m) => (
                <MemberRow key={m.row.unique_id} disc={m} setDiscCount={row.disc_count} directors={directorsFor(m.row, m.imdbId, directorCredits)} />
              ))}
            </ol>
          ) : (
            <p className="text-sm text-mist">None of this set&apos;s titles have been catalogued individually yet.</p>
          )}
        </Section>
      </Container>

      {related.length > 0 ? (
        <Container>
          <Section title="Related pages">
            <RelatedLinks links={related} />
          </Section>
        </Container>
      ) : null}
    </TitlePageShell>
  );
}

/** One title in the set: links to its DVD page and its Movie/TV page, with its disc number. */
function MemberRow({ disc, setDiscCount, directors }: { disc: Disc; setDiscCount: number; directors: PersonLink[] }) {
  const row = disc.row;
  const name = displayTitle(row);
  const year = yearOf(row.release_date) ?? yearOf(disc.metadata?.release_date);
  const discLabel = discOfSetLabel(row.disc_number_in_set, setDiscCount);
  return (
    <li className="panel clip-corner flex gap-4 p-3">
      <Link href={discHref(row.unique_id)} className="clip-corner-sm relative aspect-[2/3] w-16 shrink-0 overflow-hidden bg-void sm:w-20" tabIndex={-1} aria-hidden>
        <PosterImage image={disc.poster} title={name} sizes="80px" />
      </Link>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <Link href={discHref(row.unique_id)} className="font-display text-base font-semibold tracking-wide text-chrome-hi hover:text-accent-hi">
            {name}
          </Link>
          {year ? <span className="label-tech">{year}</span> : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {discLabel ? <Badge>{discLabel}</Badge> : null}
          {shortFormatLabel(row.format) ? <Badge tone="muted">{shortFormatLabel(row.format)}</Badge> : null}
          {formatRuntime(row.running_time_mins) ? <span className="label-tech">{formatRuntime(row.running_time_mins)}</span> : null}
        </div>
        {directors.length > 0 ? (
          <p className="text-sm text-mist">
            Dir.{" "}
            {directors.map((d, i) => (
              <span key={d.name}>
                {i > 0 ? ", " : null}
                <Link href={personLinkHref(d)} className="text-accent hover:text-accent-hi">
                  {d.name}
                </Link>
              </span>
            ))}
          </p>
        ) : null}
        <div className="mt-auto flex flex-wrap gap-x-4 gap-y-1 pt-1">
          <Link href={discHref(row.unique_id)} className="label-tech text-accent hover:text-accent-hi">
            DVD page &#9656;
          </Link>
          {disc.imdbId ? (
            <Link href={workHref(disc.imdbId)} className="label-tech text-accent hover:text-accent-hi">
              {row.season_no && row.movie_or_tv !== "Movie" ? "TV" : "Movie"} page &#9656;
            </Link>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function dedupeByName(people: PersonLink[]): PersonLink[] {
  const seen = new Map<string, PersonLink>();
  for (const p of people) {
    const key = p.name.toLowerCase();
    // Prefer the entry that carries a person id (links to the person page).
    if (!seen.has(key) || (!seen.get(key)!.tmdbPersonId && p.tmdbPersonId)) seen.set(key, p);
  }
  return [...seen.values()];
}
