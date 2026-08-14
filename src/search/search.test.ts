import { beforeEach, describe, expect, it } from 'vitest';
import { db, type Entry } from '../db/schema';
import { tokenize } from '../db/tokenize';
import { hybridSearch, searchEntries } from './search';
import { indexPending } from './semantic';
import { fakeEmbeddingProvider } from '../test/fakeEmbedding';

async function addEntry(body: string, capturedAt: number): Promise<Entry> {
  const entry: Entry = {
    id: crypto.randomUUID(),
    body,
    rawInput: body,
    capturedAt,
    source: 'text',
    language: /[א-ת]/.test(body) ? 'he' : 'en',
    searchTokens: tokenize(body),
  };
  await db.entries.add(entry);
  return entry;
}

beforeEach(async () => {
  await db.open();
  await Promise.all([db.entries.clear(), db.embeddings.clear()]);
});

describe('searchEntries', () => {
  it('finds an entry by a single term', async () => {
    await addEntry('Dinner with Alex on Tuesday', 1000);
    await addEntry('Buy milk and bread', 2000);

    const hits = await searchEntries('alex');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.entry.body).toBe('Dinner with Alex on Tuesday');
  });

  it('ranks by how many query terms an entry matches', async () => {
    await addEntry('Dinner with Alex', 1000);
    await addEntry('Dinner with Alex on Tuesday in Jerusalem', 2000);
    await addEntry('Groceries', 3000);

    const hits = await searchEntries('dinner alex tuesday');
    expect(hits).toHaveLength(2);
    expect(hits[0]!.entry.body).toBe('Dinner with Alex on Tuesday in Jerusalem');
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  it('breaks ties on recency', async () => {
    await addEntry('Call Dani', 1000);
    await addEntry('Call Dani', 5000);

    const hits = await searchEntries('call dani');
    expect(hits[0]!.entry.capturedAt).toBe(5000);
  });

  it('is case-insensitive', async () => {
    await addEntry('Dinner with ALEX', 1000);
    expect(await searchEntries('alex')).toHaveLength(1);
    expect(await searchEntries('ALEX')).toHaveLength(1);
  });

  it('finds a Hebrew place name written with a bound particle', async () => {
    // The reason the tokeniser stems prefixes: what was written is "be-Yerushalayim", and what
    // gets searched for is the bare name.
    await addEntry('פגישה בירושלים', 1000);
    const hits = await searchEntries('ירושלים');
    expect(hits).toHaveLength(1);
  });

  it('finds a pointed word from an unpointed query and vice versa', async () => {
    await addEntry('שָׁלוֹם עולם', 1000);
    expect(await searchEntries('שלום')).toHaveLength(1);
  });

  it('finds a possessive by the bare name, which is what anyone would type', async () => {
    await addEntry("Sarah's vase", 1000);
    expect(await searchEntries('sarah')).toHaveLength(1);
    expect(await searchEntries("sarah's")).toHaveLength(1);
    expect(await searchEntries('Sarah’s')).toHaveLength(1);
  });

  it('returns nothing for a query with no usable terms', async () => {
    await addEntry('Dinner with Alex', 1000);
    for (const query of ['', '   ', '!!!', 'a']) {
      expect(await searchEntries(query), JSON.stringify(query)).toEqual([]);
    }
  });

  it('respects the limit', async () => {
    for (let i = 0; i < 10; i++) await addEntry(`Meeting number ${i}`, 1000 + i);
    expect(await searchEntries('meeting', 3)).toHaveLength(3);
  });

  it('does not return an entry twice, however many terms it matches', async () => {
    await addEntry('Dinner dinner dinner with Alex', 1000);
    const hits = await searchEntries('dinner alex');
    expect(hits).toHaveLength(1);
  });
});

describe('hybridSearch', () => {
  const provider = fakeEmbeddingProvider();

  it('is exactly keyword search when there is no provider', async () => {
    // The ordinary case: semantic search is opt-in and most users never enable it.
    await addEntry('Dinner with Alex', 1000);
    const hits = await hybridSearch('alex', null);
    expect(hits.map((hit) => hit.entry.body)).toEqual(['Dinner with Alex']);
    expect(hits[0]!.sources).toEqual(['keyword']);
  });

  it('finds a note by meaning that keyword search misses entirely', async () => {
    await addEntry('the ceramic vase Sarah liked', 1000);
    await indexPending(provider);

    const keywordOnly = await searchEntries('pottery');
    expect(keywordOnly).toEqual([]);

    const hybrid = await hybridSearch('pottery', provider);
    expect(hybrid.map((hit) => hit.entry.body)).toEqual(['the ceramic vase Sarah liked']);
    expect(hybrid[0]!.sources).toEqual(['semantic']);
  });

  it('marks a hit found by both rankers', async () => {
    await addEntry('a ceramic vase', 1000);
    await indexPending(provider);
    const hits = await hybridSearch('ceramic', provider);
    expect(hits[0]!.sources).toEqual(['keyword', 'semantic']);
  });

  it('keeps keyword results when the provider throws', async () => {
    // The model can be missing, evicted by iOS, or mid-download. None of those should turn the
    // search box into an error message.
    await addEntry('Dinner with Alex', 1000);
    const broken = {
      model: 'fake-v1',
      dimensions: 5,
      embed: async () => {
        throw new Error('model evicted');
      },
    };
    const hits = await hybridSearch('alex', broken);
    expect(hits.map((hit) => hit.entry.body)).toEqual(['Dinner with Alex']);
  });

  it('returns nothing for a query neither ranker matches', async () => {
    await addEntry('Dinner with Alex', 1000);
    await indexPending(provider);
    expect(await hybridSearch('submarine', provider)).toEqual([]);
  });

  it('honours the limit across both rankers', async () => {
    for (let i = 0; i < 6; i++) await addEntry(`ceramic vase ${i}`, 1000 + i);
    await indexPending(provider);
    expect(await hybridSearch('ceramic', provider, 3)).toHaveLength(3);
  });
});
