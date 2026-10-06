import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/Panel";
import { ConnectedTabs } from "@/components/people/ConnectedTabs";
import { ProfileHero } from "@/components/people/ProfileHero";
import { describeConnections, getPersonPage, isTmdbPersonId } from "@/lib/catalog/people";

/**
 * Cast/Crew page keyed by TMDb person id, listing every owned title the person is credited on
 * (0043's title_credits). Before 0043 is applied this renders a "not available yet" state
 * instead of erroring; it starts working within a minute of the migration, no restart.
 * A short revalidate so that interim state isn't cached for long.
 */
export const revalidate = 60;

async function load(params: PageProps<"/person/[id]">["params"]) {
  const { id } = await params;
  if (!isTmdbPersonId(id)) notFound();
  return getPersonPage(Number(id));
}

export async function generateMetadata(props: PageProps<"/person/[id]">): Promise<Metadata> {
  const result = await load(props.params);
  return { title: result.status === "ok" ? result.page.person.name : result.status === "unavailable" ? "Cast & Crew" : "Person not found" };
}

export default async function PersonPage(props: PageProps<"/person/[id]">) {
  const result = await load(props.params);
  if (result.status === "not_found") notFound();

  if (result.status === "unavailable") {
    return (
      <div>
        <PageHeader title="Cast & Crew" eyebrow="Person" />
        <div className="mx-auto max-w-screen-md px-4 py-10 sm:px-6">
          <Panel title="Not available yet">
            <p className="text-chrome">Cast and crew details haven&apos;t been loaded into the catalogue yet. Check back soon.</p>
          </Panel>
        </div>
      </div>
    );
  }

  const { person, profile, roles, summary, tabs, leadImage } = result.page;
  const facts = [
    ...(person.known_for_department ? [{ label: "Known for", value: person.known_for_department }] : []),
    ...(person.birthday ? [{ label: "Born", value: person.birthday + (person.place_of_birth ? ` // ${person.place_of_birth}` : "") }] : []),
    ...(person.deathday ? [{ label: "Died", value: person.deathday }] : []),
    { label: "In the collection", value: `${summary.works} ${summary.works === 1 ? "title" : "titles"}` },
  ];

  return (
    <div>
      <PageHeader title={person.name} eyebrow={roles.length > 0 ? roles.slice(0, 3).join(" // ") : "Person"} />
      <ProfileHero
        name={person.name}
        kicker={roles.length > 0 ? roles.slice(0, 4).join(" // ") : "Cast & Crew"}
        image={profile}
        backdrop={leadImage}
        facts={facts}
        description={person.biography || describeConnections(summary, `featuring ${person.name}`)}
        descriptionLabel={person.biography ? "Biography" : "In the collection"}
      />
      <div className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6 sm:py-8">
        <ConnectedTabs tabs={tabs} />
      </div>
    </div>
  );
}
