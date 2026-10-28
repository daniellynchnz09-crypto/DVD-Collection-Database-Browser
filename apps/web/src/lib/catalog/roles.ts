/**
 * Production roles for the People tab's tags and the person page's ordering (2026-10-28).
 * title_credits keeps cast plus these crew jobs (0043): Director, Writer/Screenplay, Producer,
 * Original Music Composer and Director of Photography. Pure - safe for any module.
 */
export const PEOPLE_ROLES = [
  { key: "actor", label: "Actors", singular: "Actor" },
  { key: "director", label: "Directors", singular: "Director" },
  { key: "writer", label: "Writers", singular: "Writer" },
  { key: "producer", label: "Producers", singular: "Producer" },
  { key: "composer", label: "Composers", singular: "Composer" },
  { key: "cinematographer", label: "Cinematographers", singular: "Cinematographer" },
] as const;

export type PeopleRole = (typeof PEOPLE_ROLES)[number]["key"];

export function isPeopleRole(value: unknown): value is PeopleRole {
  return PEOPLE_ROLES.some((r) => r.key === value);
}

export function roleSingular(role: PeopleRole): string {
  return PEOPLE_ROLES.find((r) => r.key === role)!.singular;
}

/** Which tag a credit counts under, or null for a crew job no tag covers. */
export function roleOfCredit(creditType: string, job: string | null | undefined): PeopleRole | null {
  if (creditType === "cast") return "actor";
  const j = (job ?? "").toLowerCase();
  if (j === "director") return "director";
  if (j === "writer" || j === "screenplay") return "writer";
  if (j.includes("producer")) return "producer";
  if (j.includes("composer") || j === "music") return "composer";
  if (j === "director of photography") return "cinematographer";
  return null;
}
