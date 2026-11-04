/**
 * Paging for the built-ins' `describeChange` (U5 fix round): every listing is followed to its end,
 * but never forever. A server that repeats a page (the same next link or start offset), or a listing
 * longer than MAX_DESCRIBE_PAGES pages, stops the walk, and the caller reports the listing as
 * incomplete (`truncated` / `checksTruncated`) rather than whole.
 */
export const MAX_DESCRIBE_PAGES = 100;

export interface Paged<T> {
  items: T[];
  /** False when the walk stopped early: a repeated page, or the page cap. */
  complete: boolean;
}

/** Follows `next` from `first` (a URL, or any key the fetcher understands, such as a start offset). */
export async function followPages<T, K extends string | number>(first: K, fetchPage: (key: K) => Promise<{ items: T[]; next: K | null }>, maxPages = MAX_DESCRIBE_PAGES): Promise<Paged<T>> {
  const items: T[] = [];
  const seen = new Set<K>();
  let key: K | null = first;
  for (let pages = 0; key !== null; pages++) {
    if (seen.has(key) || pages >= maxPages) return { items, complete: false };
    seen.add(key);
    const page: { items: T[]; next: K | null } = await fetchPage(key);
    items.push(...page.items);
    key = page.next;
  }
  return { items, complete: true };
}
