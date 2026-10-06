import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Badge, Panel, Section } from "@/components/Panel";
import { PosterCard } from "@/components/PosterCard";
import { ScrollRow } from "@/components/ScrollRow";
import { RelatedLinks, type RelatedLink } from "@/components/title/RelatedLinks";
import { FactList, HeroTitle, MetaLine, TitleHero } from "@/components/title/TitleHero";
import { Container, RowContainer, TitlePageShell } from "@/components/title/TitlePageShell";
import { collectionHref, displayTitle, franchiseHref, getDisc, shortFormatLabel, workHref, yearOf, frameAspect, type CatalogImage } from "@/lib/catalog";
import { discOfSetLabel, distinctCi, formatRegion, formatRuntime, getDiscSetContext, regionChip, specialFeaturesText } from "@/lib/catalog/titlePages";

export const revalidate = 300;

export async function generateMetadata(props: PageProps<"/disc/[uniqueId]">): Promise<Metadata> {
  const { uniqueId } = await props.params;
  const disc = await getDisc(uniqueId);
  if (!disc) return { title: "Not found" };
  const format = shortFormatLabel(disc.row.format);
  return { title: `${displayTitle(disc.row)}${format ? ` (${format})` : ""}` };
}

/** DVD Page: one physical item (WEB APP DESIGN.md "DVD Pages"). */
export default async function DiscPage(props: PageProps<"/disc/[uniqueId]">) {
  const { uniqueId } = await props.params;
  const disc = await getDisc(uniqueId);
  if (!disc) notFound();
  // A box-set header has its own page type; keep one canonical URL per row.
  if (disc.row.is_collection) redirect(collectionHref(disc.row.unique_id));

  const row = disc.row;
  const setContext = await getDiscSetContext(disc);
  const title = displayTitle(row);
  const year = yearOf(row.release_date) ?? yearOf(disc.metadata?.release_date);
  const format = shortFormatLabel(row.format);
  const region = formatRegion(row.disk_region);
  const setLabel = setContext ? discOfSetLabel(row.disc_number_in_set, setContext.collection.header.row.disc_count) : null;
  const isTv = !!row.season_no && row.movie_or_tv !== "Movie";

  // The physical case is "the image" of a DVD page; the film poster is the fallback.
  const heroImage: CatalogImage | null = disc.caseImage ?? disc.poster;

  const related: RelatedLink[] = [];
  if (disc.imdbId) {
    related.push({
      href: workHref(disc.imdbId),
      kind: isTv ? "TV page" : "Movie page",
      label: disc.metadata?.title ?? row.title,
      detail: [yearOf(disc.metadata?.release_date) ?? year, "Every copy, cast & crew"].filter(Boolean).join(" // "),
    });
  }
  if (disc.collection) {
    related.push({
      href: collectionHref(disc.collection.uniqueId),
      kind: "Collection",
      label: disc.collection.title,
      detail: setLabel ? `${setLabel} in this set` : "Part of this box set",
    });
  }
  for (const f of distinctCi(row.franchise ?? [])) related.push({ href: franchiseHref(f), kind: "Franchise", label: f });

  return (
    <TitlePageShell
      title={title}
      eyebrow={[row.movie_or_tv, format].filter(Boolean).join(" // ")}
      backdrop={disc.poster ?? disc.caseImage}
      tmdbAttribution={!!disc.metadata || disc.poster?.source === "tmdb"}
      actions={row.is_currently_rented_out ? <Badge tone="signal">Rented out</Badge> : null}
    >
      <Container>
        <TitleHero image={heroImage} imageAlt={title} aspect={frameAspect(heroImage, disc.row.format)}>
          <HeroTitle
            kicker={row.title_in_a_collection ? "Physical release // In a box set" : "Physical release"}
            title={title}
            subtitle={row.release_name && row.release_name.trim() !== row.title ? `${row.title}${year ? ` (${year})` : ""}` : null}
          />
          <MetaLine parts={[format, `${row.disc_count} disc${row.disc_count === 1 ? "" : "s"}`, regionChip(region), setLabel]} />
          <div className="flex flex-wrap gap-1.5">
            {row.special_features ? <Badge>Special features</Badge> : <Badge tone="muted">No special features</Badge>}
            {row.steelbook ? <Badge>Steelbook</Badge> : null}
            {row.is_currently_rented_out ? <Badge tone="signal">Currently rented out</Badge> : null}
          </div>
          <Panel title="Disc data" bodyClassName="p-4">
            <FactList
              facts={[
                { label: "Format", value: row.format },
                { label: "Discs", value: String(row.disc_count) },
                setLabel && { label: "In the set", value: setLabel },
                { label: "Region", value: region ?? "Not recorded" },
                { label: "Special features", value: specialFeaturesText(row) },
                isTv && row.season_no && { label: "Season", value: row.part_of_season_no ? `${row.season_no} (part ${row.part_of_season_no})` : row.season_no },
                isTv && row.episode_count && { label: "Episodes", value: String(row.episode_count) },
                year && { label: "Released", value: year },
                formatRuntime(row.running_time_mins) && { label: "Runtime", value: formatRuntime(row.running_time_mins) },
                row.rating && { label: "Rating", value: row.rating },
                row.studio && { label: "Studio", value: row.studio },
                row.original_language && { label: "Language", value: row.original_language },
                row.genre?.length > 0 && { label: "Genre", value: row.genre.join(", ") },
                row.director?.length > 0 && { label: "Director", value: row.director.join(", ") },
                row.animation_or_live_action && { label: "Type", value: row.animation_or_live_action },
              ]}
            />
          </Panel>
        </TitleHero>
      </Container>

      {row.release_variant_note?.trim() ? (
        <Container>
          <Section title="About this release">
            <p className="max-w-4xl text-base leading-relaxed text-chrome">{row.release_variant_note}</p>
          </Section>
        </Container>
      ) : null}

      {related.length > 0 ? (
        <Container>
          <Section title="Related pages">
            <RelatedLinks links={related} />
          </Section>
        </Container>
      ) : null}

      {setContext && setContext.siblings.length > 0 ? (
        <RowContainer>
          <ScrollRow title="Also in this set" href={collectionHref(setContext.collection.header.row.unique_id)} hrefLabel="View set">
            {setContext.siblings.map((card) => (
              <PosterCard key={card.key} card={card} size="sm" />
            ))}
          </ScrollRow>
        </RowContainer>
      ) : null}
    </TitlePageShell>
  );
}
