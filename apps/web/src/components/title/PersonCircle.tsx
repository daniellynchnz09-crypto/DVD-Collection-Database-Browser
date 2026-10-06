import Image from "next/image";
import Link from "next/link";

/**
 * A person as a circular portrait with name and role underneath (WEB APP DESIGN.md asks for
 * circular images specifically for cast/crew, the one place the site isn't angular). Links to
 * /person/[id] when the TMDb person id is known, otherwise to a search for the name.
 */
export function PersonCircle({
  name,
  role,
  imageSrc,
  href,
  size = "md",
}: {
  name: string;
  role?: string | null;
  imageSrc: string | null;
  href: string;
  size?: "md" | "lg";
}) {
  const box = size === "lg" ? "h-28 w-28 sm:h-32 sm:w-32" : "h-20 w-20 sm:h-24 sm:w-24";
  const width = size === "lg" ? "w-32 sm:w-36" : "w-24 sm:w-28";
  return (
    <Link href={href} className={`group flex shrink-0 flex-col items-center text-center outline-none ${width}`} title={name}>
      <div
        className={`relative ${box} overflow-hidden rounded-full bg-linear-to-br from-panel-hi to-void ring-1 ring-rule-strong transition group-hover:ring-2 group-hover:ring-accent group-focus-visible:ring-2 group-focus-visible:ring-accent`}
      >
        {imageSrc ? (
          <Image src={imageSrc} alt={name} fill sizes="128px" unoptimized className="object-cover object-top" />
        ) : (
          <span className="absolute inset-0 flex items-center justify-center font-display text-xl font-semibold tracking-wider text-accent">
            {initials(name)}
          </span>
        )}
      </div>
      <p className="mt-2 line-clamp-2 text-sm leading-tight font-medium text-chrome group-hover:text-accent-hi">{name}</p>
      {role ? <p className="label-tech mt-0.5 line-clamp-2 normal-case tracking-wide">{role}</p> : null}
    </Link>
  );
}

function initials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}
