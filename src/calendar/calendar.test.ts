import { beforeEach, describe, expect, it } from 'vitest';
import { db, type Settings } from '../db/schema';
import { defaultSettings } from '../db/settings';
import { registerTrigger } from '../engine/index';
import { zonedParts, zonedWallClockToEpoch } from '../engine/time';
import {
  createCalendarEvent,
  deleteCalendarEvent,
  eventsBetween,
  groupByLocalDay,
  updateCalendarEvent,
} from './events';
import { monthGrid, nextMonth, previousMonth, weekdayLabels } from './monthGrid';

const JLM = 'Asia/Jerusalem';
const at = (day: number, hour = 0, minute = 0, month = 6) =>
  zonedWallClockToEpoch({ year: 2026, month, day, hour, minute }, JLM);

async function settings(overrides: Partial<Settings> = {}): Promise<void> {
  await db.settings.put({ ...defaultSettings(), timezone: JLM, ...overrides });
}

beforeEach(async () => {
  await db.open();
  await Promise.all([
    db.events.clear(),
    db.triggers.clear(),
    db.links.clear(),
    db.settings.clear(),
    db.entries.clear(),
  ]);
  await settings();
});

describe('monthGrid', () => {
  it('always returns six weeks, so the layout does not change height between months', () => {
    for (const month of [1, 2, 6, 12]) {
      expect(monthGrid(2026, month, JLM, at(10)), `month ${month}`).toHaveLength(42);
    }
  });

  it('pads with the neighbouring months and marks them out of month', () => {
    // 1 June 2026 is a Monday, so with a Sunday week start there is one leading day: 31 May.
    const grid = monthGrid(2026, 6, JLM, at(10));
    expect(grid[0]).toMatchObject({ dayOfMonth: 31, inMonth: false, weekday: 0 });
    expect(grid[1]).toMatchObject({ dayOfMonth: 1, inMonth: true, weekday: 1 });
    expect(grid.filter((d) => d.inMonth)).toHaveLength(30);
  });

  it('starts the week on Monday when asked', () => {
    // With a Monday start, 1 June needs no leading days at all.
    const grid = monthGrid(2026, 6, JLM, at(10), 1);
    expect(grid[0]).toMatchObject({ dayOfMonth: 1, inMonth: true, weekday: 1 });
  });

  it('marks today', () => {
    const grid = monthGrid(2026, 6, JLM, at(10, 15));
    const today = grid.filter((day) => day.isToday);
    expect(today).toHaveLength(1);
    expect(today[0]!.dayOfMonth).toBe(10);
  });

  it('gives each day local midnight boundaries', () => {
    const grid = monthGrid(2026, 6, JLM, at(10));
    for (const day of grid) {
      expect(zonedParts(day.startAt, JLM), day.key).toMatchObject({ hour: 0, minute: 0 });
      expect(day.endAt).toBeGreaterThan(day.startAt);
    }
  });

  it('handles the 23-hour day at a DST transition', () => {
    // Jerusalem loses an hour on 27 March 2026. The grid must still be contiguous.
    const grid = monthGrid(2026, 3, JLM, at(10, 0, 0, 3));
    const march27 = grid.find((day) => day.key === '2026-03-27');
    expect(march27).toBeDefined();
    expect(march27!.endAt - march27!.startAt).toBe(23 * 3_600_000);

    // Every day ends exactly where the next begins.
    for (let i = 1; i < grid.length; i++) {
      expect(grid[i]!.startAt, grid[i]!.key).toBe(grid[i - 1]!.endAt);
    }
  });

  it('handles February in a leap and a non-leap year', () => {
    expect(monthGrid(2028, 2, JLM, at(10)).filter((d) => d.inMonth)).toHaveLength(29);
    expect(monthGrid(2026, 2, JLM, at(10)).filter((d) => d.inMonth)).toHaveLength(28);
  });
});

describe('month navigation', () => {
  it('rolls the year over in both directions', () => {
    expect(nextMonth(2026, 12)).toEqual({ year: 2027, month: 1 });
    expect(previousMonth(2026, 1)).toEqual({ year: 2025, month: 12 });
    expect(nextMonth(2026, 6)).toEqual({ year: 2026, month: 7 });
  });
});

describe('weekdayLabels', () => {
  it('orders labels to match the grid', () => {
    const sundayFirst = weekdayLabels('en', 0);
    const mondayFirst = weekdayLabels('en', 1);
    expect(sundayFirst).toHaveLength(7);
    expect(sundayFirst[0]).not.toBe(mondayFirst[0]);
    expect(mondayFirst[0]).toBe(sundayFirst[1]);
  });

  it('localises', () => {
    expect(weekdayLabels('he', 0)[0]).not.toBe(weekdayLabels('en', 0)[0]);
  });
});

describe('eventsBetween', () => {
  it('returns events overlapping the window, not merely starting inside it', () => {
    // The distinction between a calendar and a list of start times.
    return (async () => {
      await createCalendarEvent({
        title: 'Spans the window',
        startAt: at(9, 20),
        endAt: at(11, 6),
        timezone: JLM,
        isAllDay: false,
      });
      await createCalendarEvent({
        title: 'Inside',
        startAt: at(10, 12),
        endAt: at(10, 13),
        timezone: JLM,
        isAllDay: false,
      });
      await createCalendarEvent({
        title: 'Before',
        startAt: at(8, 12),
        endAt: at(8, 13),
        timezone: JLM,
        isAllDay: false,
      });

      const found = await eventsBetween(at(10), at(11));
      expect(found.map((e) => e.title)).toEqual(['Spans the window', 'Inside']);
    })();
  });

  it('excludes an event ending exactly as the window opens', () => {
    return (async () => {
      await createCalendarEvent({
        title: 'Touches',
        startAt: at(9, 12),
        endAt: at(10),
        timezone: JLM,
        isAllDay: false,
      });
      expect(await eventsBetween(at(10), at(11))).toEqual([]);
    })();
  });
});

describe('groupByLocalDay', () => {
  it('places a multi-day event on every day it touches', async () => {
    const event = await createCalendarEvent({
      title: 'Conference',
      startAt: at(10, 9),
      endAt: at(12, 17),
      timezone: JLM,
      isAllDay: false,
    });

    const byDay = groupByLocalDay([event], JLM);
    expect([...byDay.keys()].sort()).toEqual(['2026-06-10', '2026-06-11', '2026-06-12']);
  });

  it('does not claim the next day for an event ending at midnight', async () => {
    // endAt is exclusive.
    const event = await createCalendarEvent({
      title: 'All day',
      startAt: at(10),
      endAt: at(11),
      timezone: JLM,
      isAllDay: true,
    });
    expect([...groupByLocalDay([event], JLM).keys()]).toEqual(['2026-06-10']);
  });

  it('groups several events under one day', async () => {
    const a = await createCalendarEvent({
      title: 'A',
      startAt: at(10, 9),
      endAt: at(10, 10),
      timezone: JLM,
      isAllDay: false,
    });
    const b = await createCalendarEvent({
      title: 'B',
      startAt: at(10, 14),
      endAt: at(10, 15),
      timezone: JLM,
      isAllDay: false,
    });
    expect(groupByLocalDay([a, b], JLM).get('2026-06-10')).toHaveLength(2);
  });
});

describe('updateCalendarEvent — reminders follow the event', () => {
  it('moves an event-adjacent trigger when the start time changes', async () => {
    const event = await createCalendarEvent({
      title: 'Dinner',
      startAt: at(11, 20),
      endAt: at(11, 22),
      timezone: JLM,
      isAllDay: false,
    });
    const registered = await registerTrigger({
      targetType: 'event',
      targetId: event.id,
      condition: {
        kind: 'event-adjacent',
        eventId: event.id,
        offsetMinutes: -30,
        includeTravelBuffer: false,
      },
    });
    if (registered.kind !== 'registered') throw new Error('expected registration');
    expect(registered.trigger.nextFireAt).toBe(at(11, 19, 30));

    // Push the dinner an hour later.
    await updateCalendarEvent(event.id, { startAt: at(11, 21) });

    const after = await db.triggers.get(registered.trigger.id);
    // The reminder moved with it. Without this, it would fire at 19:30 for a 21:00 dinner.
    expect(after!.nextFireAt).toBe(at(11, 20, 30));
    expect(after!.syncedFireAt).toBeNull();
  });

  it('moves the trigger when only the travel buffer changes', async () => {
    const event = await createCalendarEvent({
      title: 'Flight',
      startAt: at(11, 20),
      endAt: at(11, 22),
      timezone: JLM,
      isAllDay: false,
    });
    const registered = await registerTrigger({
      targetType: 'event',
      targetId: event.id,
      condition: {
        kind: 'event-adjacent',
        eventId: event.id,
        offsetMinutes: 0,
        includeTravelBuffer: true,
      },
    });
    if (registered.kind !== 'registered') throw new Error('expected registration');

    await updateCalendarEvent(event.id, { travelBufferMinutes: 90 });
    expect((await db.triggers.get(registered.trigger.id))!.nextFireAt).toBe(at(11, 18, 30));
  });

  it('leaves triggers alone when only the title changes', async () => {
    const event = await createCalendarEvent({
      title: 'Dinner',
      startAt: at(11, 20),
      endAt: at(11, 22),
      timezone: JLM,
      isAllDay: false,
    });
    const registered = await registerTrigger({
      targetType: 'event',
      targetId: event.id,
      condition: {
        kind: 'event-adjacent',
        eventId: event.id,
        offsetMinutes: -30,
        includeTravelBuffer: false,
      },
    });
    if (registered.kind !== 'registered') throw new Error('expected registration');
    const before = await db.triggers.get(registered.trigger.id);

    await updateCalendarEvent(event.id, { title: 'Dinner with Alex' });

    expect(await db.triggers.get(registered.trigger.id)).toEqual(before);
    expect((await db.events.get(event.id))!.title).toBe('Dinner with Alex');
  });

  it('deactivates a trigger whose new time is no longer permitted', async () => {
    const event = await createCalendarEvent({
      title: 'Dinner',
      startAt: at(11, 20),
      endAt: at(11, 22),
      timezone: JLM,
      isAllDay: false,
    });
    const registered = await registerTrigger({
      targetType: 'event',
      targetId: event.id,
      condition: {
        kind: 'event-adjacent',
        eventId: event.id,
        offsetMinutes: -30,
        includeTravelBuffer: false,
      },
    });
    if (registered.kind !== 'registered') throw new Error('expected registration');

    // Move the dinner to 23:30, so the reminder would land inside quiet hours.
    await updateCalendarEvent(event.id, { startAt: at(11, 23, 30) });

    const after = await db.triggers.get(registered.trigger.id);
    expect(after!.active).toBe(0);
    expect(after!.nextFireAt).toBeNull();
  });
});

describe('deleteCalendarEvent', () => {
  it('retires the event’s triggers and edges but keeps the trigger rows', async () => {
    const event = await createCalendarEvent({
      title: 'Dinner',
      startAt: at(11, 20),
      endAt: at(11, 22),
      timezone: JLM,
      isAllDay: false,
    });
    const registered = await registerTrigger({
      targetType: 'event',
      targetId: event.id,
      condition: {
        kind: 'event-adjacent',
        eventId: event.id,
        offsetMinutes: -30,
        includeTravelBuffer: false,
      },
    });
    if (registered.kind !== 'registered') throw new Error('expected registration');

    await deleteCalendarEvent(event.id);

    expect(await db.events.get(event.id)).toBeUndefined();
    // Cancelled, not deleted: the delivery history keeps its subject.
    const trigger = await db.triggers.get(registered.trigger.id);
    expect(trigger).toBeDefined();
    expect(trigger!.active).toBe(0);
  });

  it('leaves the Entry that produced the event untouched', async () => {
    const entry = {
      id: crypto.randomUUID(),
      body: 'Dinner with Alex tomorrow at 8pm',
      rawInput: 'Dinner with Alex tomorrow at 8pm',
      capturedAt: at(10, 12),
      source: 'text' as const,
      language: 'en' as const,
      searchTokens: ['dinner'],
    };
    await db.entries.add(entry);
    const event = await createCalendarEvent({
      title: 'Dinner with Alex',
      startAt: at(11, 20),
      endAt: at(11, 22),
      timezone: JLM,
      isAllDay: false,
      sourceEntryId: entry.id,
    });

    await deleteCalendarEvent(event.id);

    // Deleting a calendar entry is not a request to forget what was written.
    expect(await db.entries.get(entry.id)).toBeDefined();
  });
});
