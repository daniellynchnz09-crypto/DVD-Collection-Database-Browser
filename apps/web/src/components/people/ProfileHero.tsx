import Image from "next/image";
import type { ReactNode } from "react";
import type { CatalogImage } from "@/lib/catalog/types";
import { ExpandableText } from "./ExpandableText";
import { Portrait } from "./Portrait";

/**
 * Top of a Cast/Crew/Franchise page (WEB APP DESIGN.md): name with a circular image beside it,
 * then the description/biography. `backdrop` becomes the blurred, darkened, zoomed-in page
 * background the design calls for.
 */
export function ProfileHero({
  name,
  kicker,
  image,
  backdrop,
  facts = [],
  description,
  descriptionLabel = "Description",
  footer,
}: {
  name: string;
  /** Small uppercase line above the name, e.g. "Franchise" or "Actor // Director". */
  kicker: ReactNode;
  image: CatalogImage | null;
  backdrop?: CatalogImage | null;
  facts?: Array<{ label: string; value: ReactNode }>;
  description?: string | null;
  descriptionLabel?: string;
  /** Extra line under the description (e.g. a link to the full person page). */
  footer?: ReactNode;
}) {
  return (
    <section className="relative isolate overflow-hidden border-b border-rule">
      {backdrop ? (
        <div aria-hidden className="absolute inset-0 -z-10">
          <Image src={backdrop.src} alt="" fill sizes="100vw" unoptimized={backdrop.unoptimized} className="scale-125 object-cover opacity-35 blur-2xl" />
          <div className="absolute inset-0 bg-linear-to-b from-void/40 via-abyss/80 to-abyss" />
        </div>
      ) : null}

      <div className="mx-auto flex max-w-screen-2xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10">
        <div className="flex items-center gap-5 sm:gap-8">
          <Portrait image={image} name={name} preload />
          <div className="min-w-0">
            <div className="label-tech text-accent">{kicker}</div>
            <h2 className="mt-1 font-display text-2xl leading-tight font-semibold tracking-wide text-chrome-hi sm:text-4xl">{name}</h2>
            {facts.length > 0 ? (
              <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
                {facts.map((f) => (
                  <div key={f.label} className="min-w-0">
                    <dt className="label-tech text-mist-dim">{f.label}</dt>
                    <dd className="text-sm text-chrome">{f.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </div>
        </div>

        {description ? (
          <div className="panel clip-corner max-w-4xl p-4 sm:p-5">
            <div className="label-tech mb-2 text-accent">{descriptionLabel}</div>
            <ExpandableText text={description} />
            {footer ? <div className="mt-3">{footer}</div> : null}
          </div>
        ) : footer ? (
          <div>{footer}</div>
        ) : null}
      </div>
    </section>
  );
}
