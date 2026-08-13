import { beforeEach, describe, expect, it } from 'vitest';
import { db, type Entry } from '../db/schema';
import { tokenize } from '../db/tokenize';
import { searchEntries } from './search';

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
  await db.entries.clear();
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
