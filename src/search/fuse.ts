/**
 * Combining keyword results with semantic results.
 *
 * The two rankers produce scores that are not comparable in any principled way: keyword search counts
 * matching terms (1, 2, 3…) and semantic search returns a cosine (0.31, 0.44…). Normalising them onto
 * a shared scale requires inventing a conversion, and every choice of conversion is a guess that
 * quietly decides which ranker wins.
 *
 * **Reciprocal Rank Fusion** avoids the question entirely by throwing the scores away and using only
 * the *positions*. An item ranked first by either list scores highly; an item ranked well by both
 * scores higher still. It is the standard answer to exactly this problem, needs no tuning, and cannot
 * be broken by one ranker's scores drifting in scale.
 *
 * Pure, so the fusion is testable without a model or a database.
 */

/**
 * RRF's smoothing constant.
 *
 * 60 is the value from Cormack, Clarke & Buettcher (2009) and the one every implementation uses. Its
 * effect is to flatten the difference between adjacent high ranks — first versus second matters much
 * less than first versus fiftieth — which is what stops a single ranker's arbitrary ordering at the
 * top from dominating the merged list.
 */
export const RRF_K = 60;

export interface FusedHit<T> {
  item: T;
  /** RRF score. Comparable within one result set, meaningless as an absolute. */
  score: number;
  /** Which rankers found it. Drives the "why is this here" affordance in the UI. */
  sources: ('keyword' | 'semantic')[];
}

export interface FuseInput<T> {
  keyword: readonly T[];
  semantic: readonly T[];
  /** Stable identity, since the same entry arrives as a different object from each ranker. */
  keyOf: (item: T) => string;
  limit?: number;
  k?: number;
}

/**
 * Merges two ranked lists into one.
 *
 * Both lists are expected in rank order, best first. Either may be empty — which is the ordinary case
 * rather than an edge one: semantic search is empty until the user opts into it, and keyword search is
 * empty for a query whose every term is too short to index.
 */
export function fuse<T>({ keyword, semantic, keyOf, limit = 50, k = RRF_K }: FuseInput<T>): FusedHit<T>[] {
  const merged = new Map<string, FusedHit<T>>();

  const contribute = (list: readonly T[], source: 'keyword' | 'semantic') => {
    list.forEach((item, index) => {
      const key = keyOf(item);
      const rank = index + 1;
      const contribution = 1 / (k + rank);

      const existing = merged.get(key);
      if (existing) {
        existing.score += contribution;
        if (!existing.sources.includes(source)) existing.sources.push(source);
      } else {
        merged.set(key, { item, score: contribution, sources: [source] });
      }
    });
  };

  // Keyword first, so an item found by both keeps the keyword ranker's object. That matters because
  // the keyword hit carries the term-overlap count the UI may want, and because it makes the merge
  // deterministic rather than dependent on which list happened to be longer.
  contribute(keyword, 'keyword');
  contribute(semantic, 'semantic');

  return [...merged.values()]
    .sort((a, b) => b.score - a.score || keyOf(a.item).localeCompare(keyOf(b.item)))
    .slice(0, limit);
}
