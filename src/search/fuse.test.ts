import { describe, expect, it } from 'vitest';
import { fuse, RRF_K } from './fuse';

interface Row {
  id: string;
}
const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id }));
const keyOf = (row: Row) => row.id;
const ids = <T extends Row>(hits: { item: T }[]) => hits.map((hit) => hit.item.id);

describe('fuse', () => {
  it('returns nothing when both lists are empty', () => {
    expect(fuse({ keyword: [], semantic: [], keyOf })).toEqual([]);
  });

  it('passes a single list straight through, order preserved', () => {
    // The ordinary case before the user opts into semantic search at all.
    expect(ids(fuse({ keyword: rows('a', 'b', 'c'), semantic: [], keyOf }))).toEqual(['a', 'b', 'c']);
  });

  it('passes a semantic-only list through', () => {
    // And the reverse: a query whose every term is too short to index.
    expect(ids(fuse({ keyword: [], semantic: rows('x', 'y'), keyOf }))).toEqual(['x', 'y']);
  });

  it('ranks an item found by both above one found by either', () => {
    const merged = fuse({
      keyword: rows('both', 'keywordOnly'),
      semantic: rows('semanticOnly', 'both'),
      keyOf,
    });
    expect(ids(merged)[0]).toBe('both');
  });

  it('records which rankers found each item', () => {
    const merged = fuse({ keyword: rows('a', 'b'), semantic: rows('b', 'c'), keyOf });
    const sources = new Map(merged.map((hit) => [hit.item.id, hit.sources]));
    expect(sources.get('a')).toEqual(['keyword']);
    expect(sources.get('b')).toEqual(['keyword', 'semantic']);
    expect(sources.get('c')).toEqual(['semantic']);
  });

  it('does not duplicate an item present in both lists', () => {
    const merged = fuse({ keyword: rows('a'), semantic: rows('a'), keyOf });
    expect(merged).toHaveLength(1);
  });

  it('scores by rank position, not by any score the rankers supplied', () => {
    // The whole point: keyword scores are term counts and semantic scores are cosines, and no
    // principled conversion exists between them.
    const merged = fuse({ keyword: rows('first', 'second'), semantic: [], keyOf });
    expect(merged[0]!.score).toBeCloseTo(1 / (RRF_K + 1), 10);
    expect(merged[1]!.score).toBeCloseTo(1 / (RRF_K + 2), 10);
  });

  it('sums contributions for an item both rankers found', () => {
    const merged = fuse({ keyword: rows('a'), semantic: rows('a'), keyOf });
    expect(merged[0]!.score).toBeCloseTo(2 / (RRF_K + 1), 10);
  });

  it('lets a strong pair beat a single first place', () => {
    // Ranked 2nd and 2nd beats ranked 1st and absent, which is the behaviour that makes fusion
    // worth doing rather than just concatenating.
    const merged = fuse({
      keyword: rows('single', 'pair'),
      semantic: rows('other', 'pair'),
      keyOf,
    });
    expect(ids(merged)[0]).toBe('pair');
  });

  it('honours the limit', () => {
    expect(fuse({ keyword: rows('a', 'b', 'c', 'd'), semantic: [], keyOf, limit: 2 })).toHaveLength(2);
  });

  it('keeps the keyword ranker’s object for an item in both lists', () => {
    // The keyword hit carries the term-overlap count the UI may want, and preferring it makes the
    // merge deterministic rather than dependent on list lengths.
    const keywordRow = { id: 'a', from: 'keyword' };
    const semanticRow = { id: 'a', from: 'semantic' };
    const merged = fuse({
      keyword: [keywordRow],
      semantic: [semanticRow],
      keyOf: (row) => row.id,
    });
    expect(merged[0]!.item).toBe(keywordRow);
  });

  it('breaks ties deterministically rather than by insertion order', () => {
    // Two items at the same rank in different lists score identically; without a tiebreak the
    // order would depend on Map iteration, which makes the UI flicker between identical queries.
    const first = fuse({ keyword: rows('b'), semantic: rows('a'), keyOf });
    const second = fuse({ keyword: rows('b'), semantic: rows('a'), keyOf });
    expect(ids(first)).toEqual(ids(second));
    expect(ids(first)).toEqual(['a', 'b']);
  });

  it('respects a custom k', () => {
    // A smaller k sharpens the difference between adjacent ranks.
    const sharp = fuse({ keyword: rows('a', 'b'), semantic: [], keyOf, k: 1 });
    const flat = fuse({ keyword: rows('a', 'b'), semantic: [], keyOf, k: 1000 });
    const sharpGap = sharp[0]!.score - sharp[1]!.score;
    const flatGap = flat[0]!.score - flat[1]!.score;
    expect(sharpGap).toBeGreaterThan(flatGap);
  });

  it('handles long lists without losing anyone', () => {
    const many = rows(...Array.from({ length: 100 }, (_, i) => `k${i}`));
    const other = rows(...Array.from({ length: 100 }, (_, i) => `s${i}`));
    expect(fuse({ keyword: many, semantic: other, keyOf, limit: 500 })).toHaveLength(200);
  });
});
