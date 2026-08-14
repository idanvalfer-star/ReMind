import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, type Entry } from '../db/schema';
import { tokenize } from '../db/tokenize';
import type { EmbeddingProvider } from './embedding';
import { fakeEmbeddingProvider } from '../test/fakeEmbedding';
import {
  bodyHash,
  clearIndex,
  indexPending,
  indexStatus,
  isCurrent,
  pendingEntries,
  semanticSearch,
} from './semantic';

/** The shared fake, wrapped so call counts stay assertable. */
function wrapped(model = 'fake-v1'): EmbeddingProvider {
  const base = fakeEmbeddingProvider(model);
  return { ...base, embed: vi.fn(base.embed) };
}

async function addEntry(body: string, capturedAt = Date.now()): Promise<Entry> {
  const entry: Entry = {
    id: crypto.randomUUID(),
    body,
    rawInput: body,
    capturedAt,
    source: 'text',
    language: 'en',
    searchTokens: tokenize(body),
  };
  await db.entries.add(entry);
  return entry;
}

beforeEach(async () => {
  await db.open();
  await Promise.all([db.entries.clear(), db.embeddings.clear()]);
});

describe('bodyHash', () => {
  it('is stable for the same text', () => {
    expect(bodyHash('the vase Sarah liked')).toBe(bodyHash('the vase Sarah liked'));
  });

  it('differs for different text', () => {
    expect(bodyHash('a')).not.toBe(bodyHash('b'));
  });

  it('distinguishes an edit that preserves length', () => {
    expect(bodyHash('cat')).not.toBe(bodyHash('bat'));
  });

  it('handles empty and non-Latin text', () => {
    expect(bodyHash('')).toBe(bodyHash(''));
    expect(bodyHash('שרה')).not.toBe(bodyHash('שרי'));
  });
});

describe('isCurrent', () => {
  const entry = { id: 'e1', body: 'hello' } as Entry;

  it('is false with no embedding at all', () => {
    expect(isCurrent(undefined, entry, 'fake-v1')).toBe(false);
  });

  it('is true for a matching model and hash', () => {
    const embedding = {
      entryId: 'e1',
      model: 'fake-v1',
      vector: new Float32Array(5),
      bodyHash: bodyHash('hello'),
      createdAt: 0,
    };
    expect(isCurrent(embedding, entry, 'fake-v1')).toBe(true);
  });

  it('is false when the model differs', () => {
    // Vectors from different models are not comparable, so a model change invalidates the index.
    const embedding = {
      entryId: 'e1',
      model: 'other',
      vector: new Float32Array(5),
      bodyHash: bodyHash('hello'),
      createdAt: 0,
    };
    expect(isCurrent(embedding, entry, 'fake-v1')).toBe(false);
  });

  it('is false when the body has been edited', () => {
    const embedding = {
      entryId: 'e1',
      model: 'fake-v1',
      vector: new Float32Array(5),
      bodyHash: bodyHash('something else'),
      createdAt: 0,
    };
    expect(isCurrent(embedding, entry, 'fake-v1')).toBe(false);
  });
});

describe('pendingEntries and indexStatus', () => {
  it('lists everything on a fresh corpus', async () => {
    await addEntry('one');
    await addEntry('two');
    expect(await pendingEntries('fake-v1')).toHaveLength(2);
    expect(await indexStatus('fake-v1')).toEqual({ done: 0, total: 2 });
  });

  it('is empty once everything is indexed', async () => {
    await addEntry('one');
    await indexPending(wrapped());
    expect(await pendingEntries('fake-v1')).toEqual([]);
    expect(await indexStatus('fake-v1')).toEqual({ done: 1, total: 1 });
  });

  it('re-lists an entry whose body changed', async () => {
    const entry = await addEntry('original');
    await indexPending(wrapped());
    await db.entries.update(entry.id, { body: 'edited' });

    const pending = await pendingEntries('fake-v1');
    expect(pending.map((e) => e.id)).toEqual([entry.id]);
  });

  it('re-lists everything when the model changes', async () => {
    await addEntry('one');
    await addEntry('two');
    await indexPending(wrapped('fake-v1'));
    expect(await pendingEntries('fake-v2')).toHaveLength(2);
  });

  it('is empty for an empty corpus', async () => {
    expect(await pendingEntries('fake-v1')).toEqual([]);
    expect(await indexStatus('fake-v1')).toEqual({ done: 0, total: 0 });
  });
});

describe('indexPending', () => {
  it('stores one normalised vector per entry', async () => {
    await addEntry('a vase');
    const provider = wrapped();
    await indexPending(provider);

    const rows = await db.embeddings.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.model).toBe('fake-v1');
    // Unit length, so search is a dot product.
    const length = Math.hypot(...rows[0]!.vector);
    expect(length).toBeCloseTo(1, 5);
  });

  it('batches rather than embedding everything in one call', async () => {
    for (let i = 0; i < 5; i++) await addEntry(`note ${i}`);
    const provider = wrapped();
    await indexPending(provider, undefined, 2);
    // 5 entries in batches of 2 = 3 calls.
    expect(provider.embed).toHaveBeenCalledTimes(3);
  });

  it('reports progress after each committed batch', async () => {
    for (let i = 0; i < 4; i++) await addEntry(`note ${i}`);
    const seen: number[] = [];
    await indexPending(wrapped(), (progress) => seen.push(progress.done), 2);
    expect(seen).toEqual([2, 4]);
  });

  it('resumes rather than re-embedding what is already done', async () => {
    await addEntry('one');
    const provider = wrapped();
    await indexPending(provider);
    const callsAfterFirst = (provider.embed as ReturnType<typeof vi.fn>).mock.calls.length;

    await addEntry('two');
    await indexPending(provider);
    expect((provider.embed as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterFirst + 1);
    expect(await db.embeddings.count()).toBe(2);
  });

  it('keeps committed batches when a later one fails', async () => {
    // Partial progress is worth keeping; the next call resumes from what is missing.
    for (let i = 0; i < 4; i++) await addEntry(`note ${i}`);
    let call = 0;
    const flaky: EmbeddingProvider = {
      model: 'fake-v1',
      dimensions: 5,
      embed: async (texts) => {
        if (++call === 2) throw new Error('offline');
        return texts.map(() => new Float32Array([1, 0, 0, 0, 0]));
      },
    };

    await expect(indexPending(flaky, undefined, 2)).rejects.toThrow('offline');
    expect(await db.embeddings.count()).toBe(2);

    // A second run finishes the job.
    await indexPending(wrapped(), undefined, 2);
    expect(await db.embeddings.count()).toBe(4);
  });

  it('overwrites rather than accumulating a second row for an edited entry', async () => {
    const entry = await addEntry('original');
    await indexPending(wrapped());
    await db.entries.update(entry.id, { body: 'a vase' });
    await indexPending(wrapped());

    expect(await db.embeddings.count()).toBe(1);
    const [row] = await db.embeddings.toArray();
    expect(row!.bodyHash).toBe(bodyHash('a vase'));
  });

  it('does nothing on an empty corpus', async () => {
    const provider = wrapped();
    expect(await indexPending(provider)).toEqual({ done: 0, total: 0 });
    expect(provider.embed).not.toHaveBeenCalled();
  });
});

describe('semanticSearch', () => {
  it('finds a related note that shares no keywords', async () => {
    // The entire point of the feature: "pottery" and "vase" have no token in common.
    await addEntry('the vase Sarah liked');
    await addEntry('dentist appointment on Tuesday');
    const provider = wrapped();
    await indexPending(provider);

    const hits = await semanticSearch('pottery', provider);
    expect(hits.map((hit) => hit.entry.body)).toEqual(['the vase Sarah liked']);
  });

  it('orders by similarity', async () => {
    await addEntry('a ceramic vase');
    await addEntry('boarding a flight');
    const provider = wrapped();
    await indexPending(provider);

    const hits = await semanticSearch('pottery', provider, 10, 0);
    expect(hits[0]!.entry.body).toBe('a ceramic vase');
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  it('returns nothing rather than the least-bad match', async () => {
    // A search that always returns something cannot be trusted when it does.
    await addEntry('dentist appointment');
    const provider = wrapped();
    await indexPending(provider);
    expect(await semanticSearch('pottery', provider)).toEqual([]);
  });

  it('is empty for a blank query', async () => {
    await addEntry('a vase');
    const provider = wrapped();
    await indexPending(provider);
    expect(await semanticSearch('   ', provider)).toEqual([]);
  });

  it('is empty when nothing has been indexed', async () => {
    await addEntry('a vase');
    expect(await semanticSearch('pottery', wrapped())).toEqual([]);
  });

  it('ignores vectors from a different model rather than comparing them', async () => {
    // Two models can share a dimension count, and comparing across them produces confident nonsense
    // rather than a harmless zero.
    await addEntry('a vase');
    await indexPending(wrapped('fake-v1'));
    expect(await semanticSearch('pottery', wrapped('fake-v2'), 10, 0)).toEqual([]);
  });

  it('honours the limit', async () => {
    for (let i = 0; i < 5; i++) await addEntry(`ceramic vase ${i}`);
    const provider = wrapped();
    await indexPending(provider);
    expect(await semanticSearch('pottery', provider, 2)).toHaveLength(2);
  });

  it('drops a hit whose entry was deleted while its vector lingered', async () => {
    const entry = await addEntry('a vase');
    const provider = wrapped();
    await indexPending(provider);
    await db.entries.delete(entry.id);

    expect(await semanticSearch('pottery', provider, 10, 0)).toEqual([]);
  });

  it('sends the query through the provider exactly once', async () => {
    await addEntry('a vase');
    const provider = wrapped();
    await indexPending(provider);
    (provider.embed as ReturnType<typeof vi.fn>).mockClear();

    await semanticSearch('pottery', provider);
    expect(provider.embed).toHaveBeenCalledTimes(1);
  });
});

describe('clearIndex', () => {
  it('drops everything', async () => {
    await addEntry('one');
    await indexPending(wrapped());
    await clearIndex();
    expect(await db.embeddings.count()).toBe(0);
  });
});
