import { beforeEach, describe, expect, it } from 'vitest';
import { ReMindDB, type Entry, type Trigger } from './schema';
import { tokenize } from './tokenize';

/**
 * These tests exist to catch mistakes in the `stores()` declaration — a mistyped index is
 * silent at compile time and only shows up as a query that quietly returns nothing.
 *
 * The null-key behaviour in the last block is load-bearing, not incidental: the whole
 * due-trigger query depends on it, so it is pinned here.
 */

let db: ReMindDB;

beforeEach(async () => {
  db = new ReMindDB(`remind-test-${crypto.randomUUID()}`);
  await db.open();
});

function makeEntry(body: string): Entry {
  return {
    id: crypto.randomUUID(),
    body,
    rawInput: body,
    capturedAt: Date.now(),
    source: 'text',
    language: 'en',
    searchTokens: tokenize(body),
  };
}

function makeTrigger(overrides: Partial<Trigger> = {}): Trigger {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    targetType: 'entry',
    targetId: crypto.randomUUID(),
    kind: 'time',
    condition: { kind: 'time', at: now, timezone: 'UTC' },
    nextFireAt: now,
    lastFiredAt: null,
    active: 1,
    snoozedUntil: null,
    location: null,
    syncedFireAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('entries — keyword search index', () => {
  it('finds an entry by any of its tokens', async () => {
    await db.entries.bulkAdd([
      makeEntry('Dinner with Alex on Tuesday'),
      makeEntry('Buy milk and bread'),
    ]);

    const hits = await db.entries.where('searchTokens').anyOf(tokenize('alex')).toArray();
    expect(hits).toHaveLength(1);
    expect(hits[0]?.body).toBe('Dinner with Alex on Tuesday');
  });

  it('ranks by how many query tokens an entry matches', async () => {
    await db.entries.bulkAdd([
      makeEntry('Dinner with Alex'),
      makeEntry('Dinner with Alex on Tuesday in Jerusalem'),
      makeEntry('Groceries'),
    ]);

    // A multiEntry index returns one row per matching token, so counting duplicates is
    // the ranking signal — this is what the search screen will do.
    const terms = tokenize('dinner alex tuesday');
    const rows = await db.entries.where('searchTokens').anyOf(terms).toArray();

    const scores = new Map<string, number>();
    for (const row of rows) scores.set(row.id, (scores.get(row.id) ?? 0) + 1);
    const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);

    expect(ranked).toHaveLength(2);
    const best = await db.entries.get(ranked[0]![0]);
    expect(best?.body).toBe('Dinner with Alex on Tuesday in Jerusalem');
  });
});

describe('triggers — due query', () => {
  it('selects active triggers up to a cutoff in one compound-index range', async () => {
    await db.triggers.bulkAdd([
      makeTrigger({ id: 'past', nextFireAt: 1_000 }),
      makeTrigger({ id: 'due', nextFireAt: 2_000 }),
      makeTrigger({ id: 'future', nextFireAt: 9_000 }),
      makeTrigger({ id: 'inactive', nextFireAt: 1_500, active: 0 }),
    ]);

    const due = await db.triggers
      .where('[active+nextFireAt]')
      .between([1, 0], [1, 2_000], true, true)
      .toArray();

    expect(due.map((t) => t.id).sort()).toEqual(['due', 'past']);
  });

  it('excludes unscheduled triggers from the index without needing a filter', async () => {
    // null is not a valid IndexedDB key, so a row with nextFireAt === null is absent
    // from [active+nextFireAt] entirely. The engine relies on this.
    await db.triggers.bulkAdd([
      makeTrigger({ id: 'scheduled', nextFireAt: 5_000 }),
      makeTrigger({ id: 'unscheduled', nextFireAt: null }),
    ]);

    const indexed = await db.triggers
      .where('[active+nextFireAt]')
      .between([1, 0], [1, Number.MAX_SAFE_INTEGER], true, true)
      .toArray();

    expect(indexed.map((t) => t.id)).toEqual(['scheduled']);
    // ...but the row itself is still very much there.
    expect(await db.triggers.get('unscheduled')).toBeDefined();
    expect(await db.triggers.count()).toBe(2);
  });

  it('looks a trigger up by its target, which is how the graph is walked', async () => {
    const targetId = crypto.randomUUID();
    await db.triggers.bulkAdd([
      makeTrigger({ targetType: 'event', targetId }),
      makeTrigger({ targetType: 'event', targetId: crypto.randomUUID() }),
    ]);

    const found = await db.triggers.where('[targetType+targetId]').equals(['event', targetId]).toArray();
    expect(found).toHaveLength(1);
  });
});

describe('links — polymorphic edges', () => {
  it('traverses in both directions', async () => {
    const entryId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    await db.links.add({
      id: crypto.randomUUID(),
      fromType: 'entry',
      fromId: entryId,
      toType: 'event',
      toId: eventId,
      relation: 'interpreted-as',
      createdAt: Date.now(),
    });

    const forward = await db.links.where('[fromType+fromId]').equals(['entry', entryId]).toArray();
    const backward = await db.links.where('[toType+toId]').equals(['event', eventId]).toArray();

    expect(forward).toHaveLength(1);
    expect(backward).toHaveLength(1);
    expect(forward[0]?.id).toBe(backward[0]?.id);
  });
});
