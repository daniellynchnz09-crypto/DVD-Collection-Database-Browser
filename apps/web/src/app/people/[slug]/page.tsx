import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { ConnectedTabs } from "@/components/people/ConnectedTabs";
import { ProfileHero } from "@/components/people/ProfileHero";
import { personHref, tmdbImage } from "@/lib/catalog";
import { describeConnections, getDirectorPage } from "@/lib/catalog/people";

/**
 * Director-by-name page: /people/[slug] where slug = slugify(name) (link with directorHref()).
 * titles.director stores NAMES, while /person/[id] is keyed by TMDb id and needs 0043's
 * title_credits - so this route makes director links work today. Once a `people` row with
 * the same name exists, its photo/biography are shown and the full person page is linked.
 */
export const revalidate = 300;

export async function generateMetadata(props: PageProps<"/people/[slug]">): Promise<Metadata> {
  const { slug } = await props.params;
  const page = await getDirectorPage(slug);
  return { title: page ? `${page.name} (Director)` : "Person not found" };
}

export default async function DirectorPage(props: PageProps<"/people/[slug]">) {
  const { slug } = await props.params;
  const page = await getDirectorPage(slug);
  if (!page) notFound();

  const { summary, person } = page;
  const facts = [
    { label: "Directed", value: `${summary.works} ${summary.works === 1 ? "title" : "titles"}` },
    { label: "Physical items", value: summary.discs },
    ...(summary.firstYear
      ? [{ label: "Years", value: summary.firstYear === summary.lastYear ? summary.firstYear : `${summary.firstYear}–${summary.lastYear}` }]
      : []),
    ...(person?.birthday ? [{ label: "Born", value: person.birthday }] : []),
  ];

  return (
    <div>
      <PageHeader title={page.name} eyebrow="Director" />
      <ProfileHero
        name={page.name}
        kicker="Director"
        image={tmdbImage(person?.profile_path, "h632")}
        backdrop={page.leadImage}
        facts={facts}
        description={person?.biography || describeConnections(summary, `directed by ${page.name}`)}
        descriptionLabel={person?.biography ? "Biography" : "In the collection"}
        footer={
          person ? (
            <Link href={personHref(person.tmdb_person_id)} className="label-tech text-accent hover:text-accent-hi">
              Full cast &amp; crew credits &#9656;
            </Link>
          ) : null
        }
      />
      <div className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6 sm:py-8">
        <ConnectedTabs tabs={page.tabs} />
      </div>
    </div>
  );
}
