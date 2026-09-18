**WEB APP UI**

Directly follows WEB APP DESIGN.md — Next.js implementing the Home/Browse page (header with logo/search/settings, Netflix-style scrolling rows that each terminate rather than looping forever), the four title-page templates (Movie/TV, DVD, DVD Collection, Cast/Crew/Franchise), and Advanced Search with filter chips, range sliders, and saved taste profiles. Design system: dark gradient background, rigid non-rounded icons/triangles, light blue accents, per the concept-design references in Claude/concept design/. Tailwind CSS is a natural fit for implementing that design language quickly and consistently across both apps (Tailwind/NativeWind on the Expo side).

Taste-profile "middle ground" matching (Aim Four) lives in packages/shared as a pure function so both apps call the same logic: each profile is a set of filter constraints, and matching two profiles means intersecting their constraint ranges rather than merging two separate search results.



**DIRECT DATABASE ACCESS**

The settings page's "Direct Database Access" entry (WEB APP DESIGN.md) is a spreadsheet-like admin UI: global + per-column search, multi-row selection that pins matches to the top of the list, and bulk-edit (editing one selected cell propagates to all selected rows). Because this writes directly to Supabase, it's gated behind the owner's Supabase Auth session — it should not be reachable, even by URL, without authentication. Edits made here flow through the same Sheet-sync path as any other write (see `google-sheet-sync.md`).



**AUTH**

Single owner account via Supabase Auth, used only to gate write access (barcode-scan submissions, Direct Database Access, any future settings). Taste profiles (Aim Four) do not need real user accounts — they're closer to named presets a household member fills out for a movie night — so they can be stored as simple named rows rather than requiring login, unless the user later wants profiles to persist per person across devices.
