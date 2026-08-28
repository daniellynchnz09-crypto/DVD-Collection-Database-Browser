export interface UpcProduct {
  title: string;
  description?: string;
}

/**
 * UPCitemdb trial lookup - free, no signup/API key, 100 requests/day (see
 * Claude/TECH STACK AND ARCHITECTURE.md for why this one and not the alternatives).
 */
export async function upcLookup(barcode: string): Promise<UpcProduct | null> {
  const res = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(barcode)}`);
  if (!res.ok) return null;
  const data = (await res.json()) as { items?: { title: string; description?: string }[] };
  const item = data?.items?.[0];
  if (!item?.title) return null;
  return { title: item.title, description: item.description };
}
