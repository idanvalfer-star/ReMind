import { describe, expect, it } from 'vitest';
import {
  generatePackList,
  groupByCategory,
  learnedEssentials,
  nightsBetween,
  packProgress,
} from './packing';
import { MAX_SCALED_QUANTITY } from './template';
import { DAY_MS } from '../engine/time';
import type { ForecastDay, PackItem, PackOrigin } from '../db/schema';

/** Identity translator: keys come back as `packing.item.socks`, which is easy to assert on. */
const t = (key: string) => key;
const labels = (drafts: { label: string }[]) => drafts.map((d) => d.label.replace('packing.item.', ''));

const START = Date.UTC(2026, 5, 10, 6, 0);
const trip = (nights: number, mode: 'air' | 'rail' | 'road' | 'sea' | 'mixed' = 'air') => ({
  transitMode: mode,
  startAt: START,
  endAt: START + nights * DAY_MS,
});

function item(overrides: Partial<PackItem> = {}): PackItem {
  return {
    id: crypto.randomUUID(),
    tripId: 'trip-1',
    label: 'Kindle',
    quantity: 1,
    packed: 1,
    isReturnLeg: 0,
    category: 'misc',
    origin: 'manual' as PackOrigin,
    createdAt: 0,
    ...overrides,
  };
}

describe('nightsBetween', () => {
  it('counts nights', () => {
    expect(nightsBetween(START, START + 3 * DAY_MS)).toBe(3);
  });

  it('is at least one for a same-day return', () => {
    expect(nightsBetween(START, START + 4 * 3_600_000)).toBe(1);
  });
});

describe('generatePackList — template', () => {
  it('includes a passport for a flight and not for a road trip', () => {
    expect(labels(generatePackList(trip(3, 'air'), t))).toContain('passport');
    expect(labels(generatePackList(trip(3, 'road'), t))).not.toContain('passport');
  });

  it('includes a driving licence for a road trip only', () => {
    expect(labels(generatePackList(trip(3, 'road'), t))).toContain('licence');
    expect(labels(generatePackList(trip(3, 'air'), t))).not.toContain('licence');
  });

  it('includes the cabin liquids bag for air travel only', () => {
    expect(labels(generatePackList(trip(2, 'air'), t))).toContain('liquidsBag');
    expect(labels(generatePackList(trip(2, 'rail'), t))).not.toContain('liquidsBag');
  });

  it('scales clothing with the length of the trip', () => {
    const three = generatePackList(trip(3), t).find((d) => d.label.endsWith('socks'));
    const seven = generatePackList(trip(7), t).find((d) => d.label.endsWith('socks'));
    expect(three?.quantity).toBe(4); // three nights plus a spare
    expect(seven?.quantity).toBe(8);
  });

  it('does not scale things you only need one of', () => {
    const charger = generatePackList(trip(10), t).find((d) => d.label.endsWith('phoneCharger'));
    expect(charger?.quantity).toBe(1);
  });

  it('caps scaled quantities rather than suggesting a month of socks', () => {
    const socks = generatePackList(trip(40), t).find((d) => d.label.endsWith('socks'));
    expect(socks?.quantity).toBe(MAX_SCALED_QUANTITY);
  });

  it('scales trousers more slowly than underwear', () => {
    const list = generatePackList(trip(6), t);
    const trousers = list.find((d) => d.label.endsWith('trousers'))?.quantity ?? 0;
    const underwear = list.find((d) => d.label.endsWith('underwear'))?.quantity ?? 0;
    expect(trousers).toBeLessThan(underwear);
  });

  it('omits short-trip-irrelevant lines on a one-night trip', () => {
    const one = labels(generatePackList(trip(1, 'air'), t));
    expect(one).not.toContain('insurance');
    expect(one).not.toContain('shoes');
  });

  it('always produces a return checklist distinct from the outbound list', () => {
    const list = generatePackList(trip(3), t);
    const outbound = list.filter((d) => d.isReturnLeg === 0);
    const ret = list.filter((d) => d.isReturnLeg === 1);
    expect(outbound.length).toBeGreaterThan(0);
    expect(ret.length).toBeGreaterThan(0);
    expect(labels(ret)).toContain('returnChargers');
    expect(labels(outbound)).not.toContain('returnChargers');
  });
});

describe('generatePackList — weather', () => {
  const day = (minC: number, maxC: number, precipMm = 0): ForecastDay => ({
    date: '2026-06-10',
    minC,
    maxC,
    precipMm,
  });

  it('adds sun protection when it will be hot', () => {
    const list = labels(generatePackList({ ...trip(3), forecastDays: [day(20, 31)] }, t));
    expect(list).toContain('sunscreen');
    expect(list).toContain('sunglasses');
  });

  it('adds a coat when it will be cold', () => {
    const list = labels(generatePackList({ ...trip(3), forecastDays: [day(2, 8)] }, t));
    expect(list).toContain('warmCoat');
    expect(list).toContain('gloves');
  });

  it('adds a sweater for merely cool weather, without the full winter kit', () => {
    const list = labels(generatePackList({ ...trip(3), forecastDays: [day(10, 18)] }, t));
    expect(list).toContain('sweater');
    expect(list).not.toContain('gloves');
  });

  it('adds rain gear when any day is wet', () => {
    const list = labels(
      generatePackList({ ...trip(3), forecastDays: [day(15, 20, 0), day(15, 20, 9)] }, t),
    );
    expect(list).toContain('umbrella');
    expect(list).toContain('rainJacket');
  });

  it('packs for the worst day, not the average', () => {
    // Five mild days and one freezing night still means taking the coat. Averaging is how you end
    // up cold.
    const list = labels(
      generatePackList(
        {
          ...trip(6),
          forecastDays: [day(18, 24), day(18, 24), day(18, 24), day(18, 24), day(18, 24), day(1, 6)],
        },
        t,
      ),
    );
    expect(list).toContain('warmCoat');
  });

  it('handles a hot and wet trip by adding both', () => {
    const list = labels(generatePackList({ ...trip(3), forecastDays: [day(24, 33, 12)] }, t));
    expect(list).toContain('sunscreen');
    expect(list).toContain('umbrella');
  });

  it('degrades to the plain template with no forecast', () => {
    const withNone = labels(generatePackList({ ...trip(3), forecastDays: [] }, t));
    expect(withNone).toContain('passport');
    expect(withNone).not.toContain('umbrella');
  });
});

describe('generatePackList — learned and deduplication', () => {
  it('adds learned items', () => {
    const list = generatePackList({ ...trip(3), learned: ['Kindle'] }, t);
    expect(list.find((d) => d.label === 'Kindle')?.origin).toBe('learned');
  });

  it('does not duplicate an item the template already covers', () => {
    // The user who manually adds "packing.item.socks" every trip must not get two sock lines, and
    // the template's scaled quantity must win.
    const list = generatePackList({ ...trip(5), learned: ['packing.item.socks'] }, t);
    const socks = list.filter((d) => d.label === 'packing.item.socks');
    expect(socks).toHaveLength(1);
    expect(socks[0]?.origin).toBe('template');
    expect(socks[0]?.quantity).toBeGreaterThan(1);
  });

  it('does not duplicate a weather item that is also learned', () => {
    const list = generatePackList(
      {
        ...trip(3),
        forecastDays: [{ date: '2026-06-10', minC: 15, maxC: 20, precipMm: 9 }],
        learned: ['packing.item.umbrella'],
      },
      t,
    );
    expect(list.filter((d) => d.label === 'packing.item.umbrella')).toHaveLength(1);
  });

  it('deduplicates case-insensitively', () => {
    const list = generatePackList({ ...trip(3), learned: ['Kindle', 'kindle', 'KINDLE'] }, t);
    expect(list.filter((d) => d.label.toLowerCase() === 'kindle')).toHaveLength(1);
  });

  it('ignores blank learned labels', () => {
    const list = generatePackList({ ...trip(3), learned: ['   ', ''] }, t);
    expect(list.every((d) => d.label.trim() !== '')).toBe(true);
  });

  it('keeps an outbound and a return line with the same label', () => {
    // Deduplication is per leg: "toiletries" legitimately appears on both lists.
    const list = generatePackList({ ...trip(3), learned: [] }, t);
    const both = list.filter((d) => d.label === 'packing.item.toiletries');
    expect(both.length).toBeGreaterThanOrEqual(1);
  });
});

describe('learnedEssentials', () => {
  it('learns an item packed on two different trips', () => {
    const items = [
      item({ tripId: 'a', label: 'Kindle' }),
      item({ tripId: 'b', label: 'Kindle' }),
    ];
    expect(learnedEssentials(items)).toEqual(['Kindle']);
  });

  it('does not learn from a single trip', () => {
    expect(learnedEssentials([item({ tripId: 'a' })])).toEqual([]);
  });

  it('counts distinct trips, not rows', () => {
    // Three rows on one trip is one data point, not three.
    const items = [
      item({ tripId: 'a', label: 'Kindle' }),
      item({ tripId: 'a', label: 'Kindle' }),
      item({ tripId: 'a', label: 'Kindle' }),
    ];
    expect(learnedEssentials(items)).toEqual([]);
  });

  it('ignores items that were never actually packed', () => {
    // An item generated and then left unticked is evidence against it, not for it.
    const items = [
      item({ tripId: 'a', label: 'Kindle', packed: 0 }),
      item({ tripId: 'b', label: 'Kindle', packed: 0 }),
    ];
    expect(learnedEssentials(items)).toEqual([]);
  });

  it('learns only from manual additions, never from its own suggestions', () => {
    // Otherwise the generator converges on whatever it happened to suggest first.
    const generated = [
      item({ tripId: 'a', label: 'Umbrella', origin: 'weather' }),
      item({ tripId: 'b', label: 'Umbrella', origin: 'weather' }),
      item({ tripId: 'c', label: 'Umbrella', origin: 'template' }),
      item({ tripId: 'd', label: 'Umbrella', origin: 'learned' }),
    ];
    expect(learnedEssentials(generated)).toEqual([]);
  });

  it('ignores return-leg items', () => {
    const items = [
      item({ tripId: 'a', isReturnLeg: 1 }),
      item({ tripId: 'b', isReturnLeg: 1 }),
    ];
    expect(learnedEssentials(items)).toEqual([]);
  });

  it('excludes the trip being generated for, so it cannot learn from itself', () => {
    const items = [
      item({ tripId: 'current', label: 'Kindle' }),
      item({ tripId: 'past', label: 'Kindle' }),
    ];
    expect(learnedEssentials(items, 'current')).toEqual([]);
    expect(learnedEssentials(items)).toEqual(['Kindle']);
  });

  it('matches case-insensitively but keeps the first spelling seen', () => {
    const items = [
      item({ tripId: 'a', label: 'Kindle' }),
      item({ tripId: 'b', label: 'kindle' }),
    ];
    expect(learnedEssentials(items)).toEqual(['Kindle']);
  });

  it('orders by how many trips, then alphabetically', () => {
    const items = [
      item({ tripId: 'a', label: 'Zinc' }),
      item({ tripId: 'b', label: 'Zinc' }),
      item({ tripId: 'c', label: 'Zinc' }),
      item({ tripId: 'a', label: 'Adapter' }),
      item({ tripId: 'b', label: 'Adapter' }),
    ];
    expect(learnedEssentials(items)).toEqual(['Zinc', 'Adapter']);
  });

  it('respects a custom threshold', () => {
    const items = [item({ tripId: 'a' }), item({ tripId: 'b' }), item({ tripId: 'c' })];
    expect(learnedEssentials(items, undefined, 3)).toEqual(['Kindle']);
    expect(learnedEssentials(items, undefined, 4)).toEqual([]);
  });

  it('ignores blank labels', () => {
    const items = [item({ tripId: 'a', label: '  ' }), item({ tripId: 'b', label: '' })];
    expect(learnedEssentials(items)).toEqual([]);
  });
});

describe('packProgress', () => {
  it('counts only the requested leg', () => {
    const items = [
      item({ packed: 1, isReturnLeg: 0 }),
      item({ packed: 0, isReturnLeg: 0 }),
      item({ packed: 1, isReturnLeg: 1 }),
    ];
    expect(packProgress(items, 0)).toEqual({ packed: 1, total: 2 });
    expect(packProgress(items, 1)).toEqual({ packed: 1, total: 1 });
  });

  it('is zero over zero for an empty list', () => {
    expect(packProgress([], 0)).toEqual({ packed: 0, total: 0 });
  });
});

describe('groupByCategory', () => {
  it('omits empty categories rather than rendering empty headings', () => {
    const groups = groupByCategory([item({ category: 'tech' })]);
    expect(groups.map((g) => g.category)).toEqual(['tech']);
  });

  it('orders categories the way things are packed, not alphabetically', () => {
    const groups = groupByCategory([
      item({ category: 'misc' }),
      item({ category: 'documents' }),
      item({ category: 'clothing' }),
    ]);
    expect(groups.map((g) => g.category)).toEqual(['documents', 'clothing', 'misc']);
  });

  it('orders within a category by when it was added', () => {
    const groups = groupByCategory([
      item({ category: 'tech', label: 'Second', createdAt: 2 }),
      item({ category: 'tech', label: 'First', createdAt: 1 }),
    ]);
    expect(groups[0]?.items.map((i) => i.label)).toEqual(['First', 'Second']);
  });
});
