/**
 * Keyword search over captured Entries.
 *
 * No search library. `Entry.searchTokens` is a Dexie `*multiEntry` index, which is a genuine
 * inverted index, and the query runs through the same tokeniser that built it — so a Hebrew
 * query for a bare place name finds the prefixed form that was actually written.
 *
 * Ranking exploits a property of multiEntry indexes: `anyOf` returns one row per matching token,
 * so counting duplicates *is* the term-overlap score. No separate scoring pass is needed.
 */

import { db, type Entry, type ID } from '../db/schema';
import { tokenize } from '../db/tokenize';

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
