/**
 * Vector arithmetic for semantic search.
 *
 * Kept separate from both the model and the database because it is the part that has to be exactly
 * right and is trivially testable: a similarity function that is subtly wrong produces results that
 * look plausible and are useless, which is the hardest kind of bug to notice in a search feature.
 *
 * Vectors are stored as `Float32Array`. Int8 quantisation would cut storage fourfold and is what a
 * large index would want, but 384 floats is 1.5 KB and a personal corpus is hundreds to low thousands
 * of notes — so the whole index is a couple of megabytes at worst, and paying for that in accuracy
 * would be optimising the wrong thing.
 */

/** Euclidean length. */
export function magnitude(vector: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) sum += vector[i]! * vector[i]!;
  return Math.sqrt(sum);
}

/**
 * Unit vector, in place, returning the same array.
 *
 * Normalising at index time is what makes search cheap: cosine similarity between unit vectors is
 * just the dot product, so a query against a thousand notes is a thousand dot products and no square
 * roots.
 *
 * A zero vector is left alone rather than producing NaNs. It can happen: a model handed an empty or
 * all-punctuation string may return one, and one NaN in a similarity score poisons every comparison
 * it takes part in.
 */
export function normalize(vector: Float32Array): Float32Array {
  const length = magnitude(vector);
  if (length === 0) return vector;
  for (let i = 0; i < vector.length; i++) vector[i] = vector[i]! / length;
  return vector;
}

/**
 * Dot product, which equals cosine similarity when both vectors are unit length.
 *
 * Returns 0 for mismatched dimensions rather than throwing or reading past the end. That is not
 * defensive noise: the stored index can hold vectors from a previous model, and the honest answer for
 * "how similar is a 384-dimensional vector to a 768-dimensional one" is "not comparable", which
 * scores the same as unrelated.
 */
export function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

/**
 * Cosine similarity, without assuming either input is normalised.
 *
 * Used for one-off comparisons and in tests. The search path uses `dot` over pre-normalised vectors.
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  const denominator = magnitude(a) * magnitude(b);
  if (denominator === 0) return 0;
  return dot(a, b) / denominator;
}

export interface Scored<T> {
  item: T;
  score: number;
}

/**
 * The `limit` highest-scoring items above `minScore`, best first.
 *
 * `minScore` matters more than it looks. Cosine similarity is never zero for two real sentences — an
 * unrelated note still scores 0.2 or 0.3 — so without a floor, semantic search always returns
 * something, and a search that never says "nothing matched" is one you cannot trust when it does
 * return an answer.
 */
export function topMatches<T>(
  scored: readonly Scored<T>[],
  limit: number,
  minScore: number,
): Scored<T>[] {
  return scored
    .filter((entry) => entry.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
