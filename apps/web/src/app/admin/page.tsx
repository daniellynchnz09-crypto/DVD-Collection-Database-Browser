import type { Metadata } from "next";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/Panel";

export const metadata: Metadata = { title: "Direct Database Access" };

// Placeholder: the real Direct Database Access portal (owner-only, behind auth) is Phase 4 of
// web-app-build-plan.md. Nothing here reads or writes data.
export default function AdminPage() {
  return (
    <>
      <PageHeader eyebrow="Settings" title="Direct Database Access" />
      <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
        <Panel title="Status" aside="Phase 4">
          <p className="text-chrome">This portal is coming later.</p>
          <p className="mt-2 text-sm text-mist">
            It will let the owner search and edit collection records directly, with changes syncing back to the Google
            Sheet. It will require an owner sign-in.
          </p>
        </Panel>
      </div>
    </>
  );
}
