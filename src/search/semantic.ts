/**
 * The semantic half of search: indexing entries and querying the vectors.
 *
 * Everything here takes its `EmbeddingProvider` as an argument, which is what makes it testable
 * without a 130 MB model — the tests use a deterministic fake, and the real provider is injected at
 * the call site.
 *
 * Two properties the index has to have, both of which cost real code:
 *
 * - **It must be resumable.** A first index over a few hundred notes is slow, and a phone will
 *   background the app halfway through. So indexing is batched and every batch is committed, and
 *   `pendingEntries` recomputes what is left rather than tracking a cursor that could go stale.
 * - **It must know when it is wrong.** An edited note, or a vector from an older model, has to be
 *   detected rather than quietly returned as a match for text it no longer contains.
 */

import { db, type Embedding, type Entry } from '../db/schema';
import type { EmbeddingProvider } from './embedding';
import { PASSAGE_PREFIX, QUERY_PREFIX } from './embedding';
import { dot, normalize, topMatches } from './vector';

/**
 * Below this similarity, a result is noise.
 *
 * Cosine similarity between two unrelated real sentences is not zero — E5 puts them around 0.7 in
 * fact, because it embeds *everything* into a fairly tight cone. This threshold is therefore high by
 * the standards of a textbook cosine, and it was chosen for the property that matters: a search must
 * be able to return nothing, or the user cannot trust it when it returns something.
 */
export const MIN_SIMILARITY = 0.8;

/**
 * Entries embedded per batch.
 *
 * Small enough that a batch finishes between animation frames on a slow phone, large enough that
 * model invocation overhead is amortised.
 */
export const INDEX_BATCH_SIZE = 16;

/**
 * A cheap, stable fingerprint of the text a vector was computed from.
 *
 * Not a cryptographic hash and does not need to be — the only question it answers is "is this the same
 * string as last time", and the cost of a rare collision is one stale vector. FNV-1a, because it is
 * six lines and synchronous; `crypto.subtle.digest` would make every staleness check async and force
 * `pendingEntries` to await once per row.
 */
export function bodyHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // Length included so two different strings must collide on both to be confused.
  return `${(hash >>> 0).toString(36)}.${text.length.toString(36)}`;
}

/** Whether a stored vector still describes this entry, under this model. */
export function isCurrent(embedding: Embedding | undefined, entry: Entry, model: string): boolean {
  if (!embedding) return false;
  if (embedding.model !== model) return false;
  return embedding.bodyHash === bodyHash(entry.body);
}

export interface IndexProgress {
  done: number;
  total: number;
}

/**
 * Entries that need embedding: never indexed, edited since, or indexed by another model.
 *
 * Recomputed from the tables rather than tracked, so an interrupted index resumes correctly and a
 * model change invalidates everything without a migration.
 */
export async function pendingEntries(model: string): Promise<Entry[]> {
  const [entries, embeddings] = await Promise.all([db.entries.toArray(), db.embeddings.toArray()]);
  const byEntry = new Map(embeddings.map((embedding) => [embedding.entryId, embedding]));
  return entries.filter((entry) => !isCurrent(byEntry.get(entry.id), entry, model));
}

/** How much of the corpus is currently indexed, for the settings screen. */
export async function indexStatus(model: string): Promise<IndexProgress> {
  const [total, pending] = await Promise.all([db.entries.count(), pendingEntries(model)]);
  return { done: total - pending.length, total };
}

/**
 * Embeds everything outstanding, one batch at a time.
 *
 * `onProgress` fires after each committed batch rather than each entry, so a caller rendering a
 * progress bar is not re-rendering sixteen times per batch.
 *
 * A batch that throws aborts the run and leaves earlier batches committed. That is the intended
 * behaviour: partial progress is worth keeping, and the next call resumes from what is missing.
 */
export async function indexPending(
  provider: EmbeddingProvider,
  onProgress?: (progress: IndexProgress) => void,
  batchSize = INDEX_BATCH_SIZE,
): Promise<IndexProgress> {
  const pending = await pendingEntries(provider.model);
  const total = await db.entries.count();
  let done = total - pending.length;

  for (let offset = 0; offset < pending.length; offset += batchSize) {
    const batch = pending.slice(offset, offset + batchSize);
    // The passage prefix is not decoration: E5 is trained asymmetrically and gets noticeably worse
    // without it.
    const vectors = await provider.embed(batch.map((entry) => PASSAGE_PREFIX + entry.body));

    const rows: Embedding[] = [];
    batch.forEach((entry, index) => {
      const vector = vectors[index];
      if (!vector) return;
      rows.push({
        entryId: entry.id,
        model: provider.model,
        // Normalised here so every search is a dot product rather than a cosine with two square roots.
        vector: normalize(new Float32Array(vector)),
        bodyHash: bodyHash(entry.body),
        createdAt: Date.now(),
      });
    });

    // `bulkPut`, not `bulkAdd`: re-indexing an edited entry has to overwrite its row.
    if (rows.length > 0) await db.embeddings.bulkPut(rows);
    done += batch.length;
    onProgress?.({ done, total });
  }

  return { done, total };
}

/**
 * Drops the whole index.
 *
 * Called by the setting that turns semantic search off, and by a backup restore — a restore replaces
 * every Entry with rows carrying different ids, which leaves the entire index pointing at things that
 * no longer exist. `semanticSearch` would degrade gracefully (a missing entry is filtered out), but
 * the index would silently read as complete while matching nothing, and it would occupy megabytes
 * describing a corpus that is gone.
 */
export async function clearIndex(): Promise<void> {
  await db.embeddings.clear();
}

export interface SemanticHit {
  entry: Entry;
  /** Cosine similarity, 0..1. */
  score: number;
}

/**
 * Entries semantically nearest the query, best first.
 *
 * A linear scan over every vector. That is the right algorithm at this scale and not a placeholder for
 * a real index: a thousand notes is a thousand 384-element dot products, well under a millisecond,
 * and an ANN structure would add a dependency and an approximation to save time nobody would notice.
 *
 * Vectors whose model no longer matches are skipped rather than compared. `dot` already returns 0 for
 * mismatched dimensions, but two *different* models can share a dimension count, and comparing those
 * produces confident nonsense rather than a zero.
 */
export async function semanticSearch(
  query: string,
  provider: EmbeddingProvider,
  limit = 20,
  minScore = MIN_SIMILARITY,
): Promise<SemanticHit[]> {
  const trimmed = query.trim();
  if (trimmed === '') return [];

  const [queryVector] = await provider.embed([QUERY_PREFIX + trimmed]);
  if (!queryVector) return [];
  const unit = normalize(new Float32Array(queryVector));

  const embeddings = await db.embeddings.toArray();
  const usable = embeddings.filter((embedding) => embedding.model === provider.model);
  if (usable.length === 0) return [];

  const scored = usable.map((embedding) => ({
    item: embedding.entryId,
    score: dot(unit, embedding.vector),
  }));

  const best = topMatches(scored, limit, minScore);
  const entries = await db.entries.bulkGet(best.map((match) => match.item));

  return best
    .map((match, index) => ({ entry: entries[index], score: match.score }))
    // An entry deleted while its vector lingers is dropped rather than rendered as a blank row.
    .filter((hit): hit is SemanticHit => hit.entry !== undefined);
}
