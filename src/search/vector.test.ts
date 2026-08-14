import { describe, expect, it } from 'vitest';
import { cosine, dot, magnitude, normalize, topMatches } from './vector';

const v = (...values: number[]) => new Float32Array(values);

describe('magnitude', () => {
  it('is zero for a zero vector', () => {
    expect(magnitude(v(0, 0, 0))).toBe(0);
  });

  it('is the Euclidean length', () => {
    expect(magnitude(v(3, 4))).toBeCloseTo(5, 6);
  });
});

describe('normalize', () => {
  it('produces a unit vector', () => {
    expect(magnitude(normalize(v(3, 4)))).toBeCloseTo(1, 6);
  });

  it('preserves direction', () => {
    const unit = normalize(v(3, 4));
    expect(unit[0]! / unit[1]!).toBeCloseTo(0.75, 6);
  });

  it('leaves a zero vector alone rather than producing NaNs', () => {
    // A model handed an empty or all-punctuation string can return one, and a single NaN poisons
    // every similarity it takes part in.
    const zero = normalize(v(0, 0, 0));
    expect([...zero]).toEqual([0, 0, 0]);
    expect(zero.some(Number.isNaN)).toBe(false);
  });

  it('mutates in place and returns the same array', () => {
    const original = v(3, 4);
    expect(normalize(original)).toBe(original);
  });

  it('is idempotent on an already-unit vector', () => {
    const once = normalize(v(1, 2, 3));
    const twice = normalize(new Float32Array(once));
    for (let i = 0; i < once.length; i++) expect(twice[i]).toBeCloseTo(once[i]!, 6);
  });
});

describe('dot', () => {
  it('is the sum of products', () => {
    expect(dot(v(1, 2, 3), v(4, 5, 6))).toBeCloseTo(32, 6);
  });

  it('is zero for orthogonal vectors', () => {
    expect(dot(v(1, 0), v(0, 1))).toBe(0);
  });

  it('is 1 for identical unit vectors', () => {
    const unit = normalize(v(2, 5, 1));
    expect(dot(unit, new Float32Array(unit))).toBeCloseTo(1, 6);
  });

  it('is zero for mismatched dimensions rather than throwing', () => {
    // The stored index can hold vectors from a previous model. "Not comparable" is the honest
    // answer, and it scores the same as unrelated.
    expect(dot(v(1, 2), v(1, 2, 3))).toBe(0);
  });
});

describe('cosine', () => {
  it('is 1 for parallel vectors of different lengths', () => {
    expect(cosine(v(1, 2, 3), v(2, 4, 6))).toBeCloseTo(1, 6);
  });

  it('is -1 for opposite vectors', () => {
    expect(cosine(v(1, 1), v(-1, -1))).toBeCloseTo(-1, 6);
  });

  it('is zero when either vector is zero, rather than NaN', () => {
    expect(cosine(v(0, 0), v(1, 1))).toBe(0);
    expect(cosine(v(1, 1), v(0, 0))).toBe(0);
  });

  it('is zero for mismatched dimensions', () => {
    expect(cosine(v(1), v(1, 1))).toBe(0);
  });
});

describe('topMatches', () => {
  const scored = [
    { item: 'a', score: 0.9 },
    { item: 'b', score: 0.4 },
    { item: 'c', score: 0.65 },
    { item: 'd', score: 0.1 },
  ];

  it('returns the best first', () => {
    expect(topMatches(scored, 10, 0).map((s) => s.item)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('honours the limit', () => {
    expect(topMatches(scored, 2, 0).map((s) => s.item)).toEqual(['a', 'c']);
  });

  it('drops everything below the floor', () => {
    // Cosine is never zero for two real sentences — an unrelated note still scores 0.2 or 0.3. A
    // search that never says "nothing matched" cannot be trusted when it does return an answer.
    expect(topMatches(scored, 10, 0.5).map((s) => s.item)).toEqual(['a', 'c']);
  });

  it('can return nothing at all', () => {
    expect(topMatches(scored, 10, 0.99)).toEqual([]);
  });

  it('includes a score exactly at the floor', () => {
    expect(topMatches(scored, 10, 0.65).map((s) => s.item)).toEqual(['a', 'c']);
  });

  it('is empty for no input', () => {
    expect(topMatches([], 10, 0)).toEqual([]);
  });
});
