/**
 * Keyword search over captured Entries.
 *
 * No search library. `Entry.searchTokens` is a Dexie `*multiEntry` index, which is a genuine
 * inverted index, and the query runs through the same tokeniser that built it — so a Hebrew
 * query for a bare place name finds the prefixed form that was actually written.
 *
 * Ranking exploits a property of multiEntry indexes: `anyOf` returns one row per matching token,
 * so counting duplicates *is* the term-overlap score. No separate scoring pass is needed.
 *
 * `hybridSearch` at the bottom merges this with the semantic ranker when the user has opted into it.
 * The two are kept separate all the way down: keyword search must keep working exactly as it does
 * today for the majority of users who never download a model.
 */

import { db, type Entry, type ID } from '../db/schema';
import { tokenize } from '../db/tokenize';
import type { EmbeddingProvider } from './embedding';
import { fuse } from './fuse';
import { semanticSearch } from './semantic';

export interface SearchHit {
  entry: Entry;
  /** How many distinct query terms this entry matched. */
  score: number;
}

/** Enough to scroll; beyond this the query needs narrowing, not more results. */
const DEFAULT_LIMIT = 50;

/**
 * Searches Entries, best match first.
 *
 * Ties break on recency, because two equally relevant captures are almost never equally useful —
 * the newer one usually is.
 */
export async function searchEntries(query: string, limit = DEFAULT_LIMIT): Promise<SearchHit[]> {
  const terms = tokenize(query);
  if (terms.length === 0) return [];

  const rows = await db.entries.where('searchTokens').anyOf(terms).toArray();

  const scores = new Map<ID, { entry: Entry; score: number }>();
  for (const entry of rows) {
    const existing = scores.get(entry.id);
    if (existing) existing.score += 1;
    else scores.set(entry.id, { entry, score: 1 });
  }

  return [...scores.values()]
    .sort((a, b) => b.score - a.score || b.entry.capturedAt - a.entry.capturedAt)
    .slice(0, limit);
}

export interface HybridHit {
  entry: Entry;
  /** Which rankers found it, so the UI can say why a keyword-free result is here. */
  sources: ('keyword' | 'semantic')[];
}

/**
 * Keyword and semantic search, merged.
 *
 * The provider is optional and `null` is the ordinary case, not a degraded one: semantic search is
 * opt-in and most users will never enable it. With no provider this is exactly `searchEntries` with a
 * different return shape.
 *
 * A failing provider is caught rather than propagated. The model can be missing, evicted by iOS, or
 * mid-download, and none of those should turn the search box into an error message — keyword results
 * are still useful, and the settings screen is where the model's state is explained.
 */
export async function hybridSearch(
  query: string,
  provider: EmbeddingProvider | null,
  limit = DEFAULT_LIMIT,
): Promise<HybridHit[]> {
  const keyword = await searchEntries(query, limit);
  if (!provider) {
    return keyword.map((hit) => ({ entry: hit.entry, sources: ['keyword' as const] }));
  }

  let semantic: Entry[] = [];
  try {
    semantic = (await semanticSearch(query, provider, limit)).map((hit) => hit.entry);
  } catch (cause) {
    console.warn('semantic search unavailable; keyword results stand', cause);
  }

  return fuse({
    keyword: keyword.map((hit) => hit.entry),
    semantic,
    keyOf: (entry) => entry.id,
    limit,
  }).map((hit) => ({ entry: hit.item, sources: hit.sources }));
}
