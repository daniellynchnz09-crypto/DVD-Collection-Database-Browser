import "server-only";
import { revalidatePath } from "next/cache";
import { invalidateSearchIndex } from "./search";

/**
 * Makes the website show a confirmed scan straight away (2026-10-07, the user: a re-scanned
 * disc that overwrites its entry should just update that entry on the site). Pages are cached
 * for up to 5 minutes (`revalidate = 300`) and search keeps a 5-minute index, so without this a
 * change could take that long to appear. Marks every page for re-rendering on its next visit
 * and drops the search index. Cheap at this collection's size. Never throws.
 */
export function refreshWebsiteCaches(): void {
  invalidateSearchIndex();
  try {
    revalidatePath("/", "layout");
  } catch (err) {
    console.error("[catalog] page cache refresh failed:", err);
  }
}
