import { beforeEach, describe, expect, it } from 'vitest';
import { db, type Settings } from '../db/schema';
import { defaultSettings } from '../db/settings';
import { zonedParts, zonedWallClockToEpoch } from '../engine/time';
import { captureText, confirmProposal, undoEventCreation } from './capture';

const JLM = 'Asia/Jerusalem';
const NOW = zonedWallClockToEpoch({ year: 2026, month: 6, day: 10, hour: 12, minute: 0 }, JLM);

async function settings(overrides: Partial<Settings> = {}): Promise<void> {
  await db.settings.put({ ...defaultSettings(), timezone: JLM, ...overrides });
}

beforeEach(async () => {
  await db.open();
  await Promise.all([db.entries.clear(), db.events.clear(), db.links.clear(), db.settings.clear()]);
  await settings();
});

describe('captureText — the Entry is never at risk', () => {
  it('saves the Entry even when nothing is parseable', async () => {
    const result = await captureText('Buy milk', { now: NOW });

    expect(await db.entries.get(result.entry.id)).toBeDefined();
    expect(result.event).toBeNull();
    expect(result.proposal).toBeNull();
    expect(await db.events.count()).toBe(0);
  });

  it('keeps the raw input verbatim while trimming the body', async () => {
    const result = await captureText('  Buy milk  ', { now: NOW });
    expect(result.entry.body).toBe('Buy milk');
    expect(result.entry.rawInput).toBe('  Buy milk  ');
  });

  it('indexes the Entry for search on the way in', async () => {
    const result = await captureText('Dinner with Alex', { now: NOW });
    expect(result.entry.searchTokens).toContain('alex');

    const hits = await db.entries.where('searchTokens').anyOf(['alex']).toArray();
    expect(hits.map((e) => e.id)).toEqual([result.entry.id]);
  });

  it('records the language it detected from the script', async () => {
    expect((await captureText('Buy milk', { now: NOW })).entry.language).toBe('en');
    expect((await captureText('לקנות חלב', { now: NOW })).entry.language).toBe('he');
  });

  it('saves the Entry even for input that parses to nothing useful', async () => {
    for (const text of ['🎉', 'at at at', 'ב-99 באוגוסט', 'a'.repeat(2000)]) {
      const result = await captureText(text, { now: NOW });
      expect(await db.entries.get(result.entry.id), text).toBeDefined();
    }
  });
});

describe('captureText — silent creation above the threshold', () => {
  it('creates the Event and links it to the Entry', async () => {
    const result = await captureText('Dinner with Alex tomorrow at 8pm', { now: NOW });

    expect(result.event).not.toBeNull();
    expect(result.proposal).toBeNull();
    expect(result.event!.title).toBe('Dinner with Alex');
    expect(zonedParts(result.event!.startAt, JLM)).toMatchObject({ day: 11, hour: 20 });

    // The Entry persists and is linked, not consumed.
    expect(await db.entries.get(result.entry.id)).toBeDefined();
    expect(result.event!.sourceEntryId).toBe(result.entry.id);
    const edges = await db.links
      .where('[fromType+fromId]')
      .equals(['entry', result.entry.id])
      .toArray();
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ toType: 'event', relation: 'interpreted-as' });
  });

  it('works the same in Hebrew', async () => {
    const result = await captureText('ארוחת ערב עם אלכס מחר בשמונה בערב', { now: NOW });
    expect(result.event).not.toBeNull();
    expect(result.event!.title).toBe('ארוחת ערב עם אלכס');
    expect(zonedParts(result.event!.startAt, JLM)).toMatchObject({ day: 11, hour: 20 });
  });

  it('respects a raised threshold', async () => {
    await settings({ confidenceThreshold: 1.01 });
    const result = await captureText('Dinner with Alex tomorrow at 8pm', { now: NOW });
    expect(result.event).toBeNull();
    expect(result.proposal).not.toBeNull();
  });

  it('never creates silently without a title, whatever the score', async () => {
    // "tomorrow at 8pm" has no subject, so there would be nothing to show in the calendar.
    const result = await captureText('tomorrow at 8pm', { now: NOW });
    expect(result.event).toBeNull();
    expect(result.proposal).not.toBeNull();
    expect(result.proposal!.title).toBe('');
  });
});

describe('captureText — proposal below the threshold', () => {
  it('proposes rather than creates when the time had to be invented', async () => {
    const result = await captureText('Dinner with Alex tomorrow', { now: NOW });

    expect(result.event).toBeNull();
    expect(result.proposal).not.toBeNull();
    expect(result.proposal!.isAllDay).toBe(true);
    // Nothing was written to the calendar.
    expect(await db.events.count()).toBe(0);
    expect(await db.links.count()).toBe(0);
  });

  it('creates the Event once confirmed, linked to the original Entry', async () => {
    const result = await captureText('Dinner with Alex tomorrow', { now: NOW });
    const event = await confirmProposal(result.entry.id, result.proposal!, NOW);

    expect(await db.events.get(event.id)).toBeDefined();
    expect(event.sourceEntryId).toBe(result.entry.id);
    const edges = await db.links.where('[toType+toId]').equals(['event', event.id]).toArray();
    expect(edges).toHaveLength(1);
  });

  it('accepts an edited title on confirmation', async () => {
    const result = await captureText('tomorrow at 8pm', { now: NOW });
    const event = await confirmProposal(
      result.entry.id,
      { ...result.proposal!, title: 'Dinner with Alex' },
      NOW,
    );
    expect(event.title).toBe('Dinner with Alex');
  });
});

describe('undoEventCreation', () => {
  it('removes the Event and its edges but keeps the Entry', async () => {
    // Undo means "you misread me", not "forget what I said".
    const result = await captureText('Dinner with Alex tomorrow at 8pm', { now: NOW });
    await undoEventCreation(result.event!.id);

    expect(await db.events.count()).toBe(0);
    expect(await db.links.count()).toBe(0);
    const entry = await db.entries.get(result.entry.id);
    expect(entry).toBeDefined();
    expect(entry!.rawInput).toBe('Dinner with Alex tomorrow at 8pm');
  });

  it('is safe to call twice', async () => {
    const result = await captureText('Dinner with Alex tomorrow at 8pm', { now: NOW });
    await undoEventCreation(result.event!.id);
    await expect(undoEventCreation(result.event!.id)).resolves.toBeUndefined();
  });
});

describe('captureText — actionable detection', () => {
  it('offers a reminder for a task, in both languages', async () => {
    expect((await captureText('Call Dani', { now: NOW })).actionable.isActionable).toBe(true);
    expect((await captureText('להתקשר לדני', { now: NOW })).actionable.isActionable).toBe(true);
  });

  it('does not offer one for a note', async () => {
    expect((await captureText('Alex prefers oat milk', { now: NOW })).actionable.isActionable).toBe(
      false,
    );
  });

  it('only ever offers — it never creates a trigger by itself', async () => {
    const result = await captureText('Call Dani tomorrow at 3pm', { now: NOW });
    expect(result.actionable.isActionable).toBe(true);
    // An offer, not an action.
    expect(await db.triggers.count()).toBe(0);
  });
});
