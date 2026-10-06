import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { ConnectedTabs } from "@/components/people/ConnectedTabs";
import { ProfileHero } from "@/components/people/ProfileHero";
import { describeConnections, getFranchisePage } from "@/lib/catalog/people";

// Built from titles.franchise alone, so it works without 0043's metadata. Re-rendered at most
// every 5 minutes so newly scanned titles appear without every visit hitting Supabase.
export const revalidate = 300;

export async function generateMetadata(props: PageProps<"/franchise/[slug]">): Promise<Metadata> {
  const { slug } = await props.params;
  const page = await getFranchisePage(slug);
  return { title: page ? `${page.name} (Franchise)` : "Franchise not found" };
}

export default async function FranchisePage(props: PageProps<"/franchise/[slug]">) {
  const { slug } = await props.params;
  const page = await getFranchisePage(slug);
  if (!page) notFound();

  const { summary } = page;
  const facts = [
    { label: "Films & TV", value: summary.works },
    { label: "Physical items", value: summary.discs },
    ...(summary.boxSets > 0 ? [{ label: "Box sets", value: summary.boxSets }] : []),
    ...(summary.firstYear
      ? [{ label: "Years", value: summary.firstYear === summary.lastYear ? summary.firstYear : `${summary.firstYear}–${summary.lastYear}` }]
      : []),
    ...(summary.formats.length > 0 ? [{ label: "Formats", value: summary.formats.map((f) => `${f.label} ×${f.count}`).join("  ") }] : []),
  ];

  return (
    <div>
      <PageHeader title={page.name} eyebrow="Franchise" />
      <ProfileHero
        name={page.name}
        kicker="Franchise"
        image={page.leadImage}
        backdrop={page.leadImage}
        facts={facts}
        description={describeConnections(summary, `in the ${page.name} franchise`)}
        descriptionLabel="About this franchise"
      />
      <div className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6 sm:py-8">
        <ConnectedTabs tabs={page.tabs} />
      </div>
    </div>
  );
}
