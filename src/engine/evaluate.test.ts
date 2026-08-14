import { describe, expect, it } from 'vitest';
import type { Event, TriggerCondition } from '../db/schema';
import { desiredFireAt } from './evaluate';
import { HOUR_MS, MINUTE_MS } from './time';

const START = Date.UTC(2026, 5, 10, 17, 0); // 20:00 local in Jerusalem

function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: 'e1',
    title: 'Dinner with Alex',
    startAt: START,
    endAt: START + 2 * HOUR_MS,
    timezone: 'Asia/Jerusalem',
    isAllDay: false,
    location: null,
    travelBufferMinutes: 0,
    isPrivate: false,
    sourceEntryId: null,
    createdAt: START,
    updatedAt: START,
    ...overrides,
  };
}

describe('desiredFireAt — cadence', () => {
  it('delegates to the cadence rule, which needs the person and the clock', () => {
    const person = {
      id: 'p1',
      name: 'Sarah',
      aliases: [],
      cadenceDays: 7,
      lastInteractionAt: START,
      createdAt: START,
    };
    const at = desiredFireAt(
      { kind: 'cadence', personId: 'p1', days: 7, atMinuteOfDay: 9 * 60, timezone: 'UTC' },
      { person },
      START,
    );

    // START is 10 June 17:00Z; seven days on is 17 June, and 09:00 on that day is the slot.
    expect(at).toBe(Date.UTC(2026, 5, 17, 9, 0));
  });

  it('returns null when the person has been deleted', () => {
    expect(
      desiredFireAt(
        { kind: 'cadence', personId: 'p1', days: 7, atMinuteOfDay: 540, timezone: 'UTC' },
        {},
        START,
      ),
    ).toBeNull();
  });
});

describe('desiredFireAt — time', () => {
  it('is the stored instant', () => {
    expect(desiredFireAt({ kind: 'time', at: START, timezone: 'UTC' }, { event: undefined })).toBe(START);
  });
});

describe('desiredFireAt — event-adjacent', () => {
  const adjacent = (
    offsetMinutes: number,
    includeTravelBuffer = false,
  ): TriggerCondition => ({
    kind: 'event-adjacent',
    eventId: 'e1',
    offsetMinutes,
    includeTravelBuffer,
  });

  it('fires before the event for a negative offset', () => {
    expect(desiredFireAt(adjacent(-30), { event: makeEvent() })).toBe(START - 30 * MINUTE_MS);
  });

  it('fires after the event for a positive offset', () => {
    expect(desiredFireAt(adjacent(15), { event: makeEvent() })).toBe(START + 15 * MINUTE_MS);
  });

  it('fires at the event start for a zero offset', () => {
    expect(desiredFireAt(adjacent(0), { event: makeEvent() })).toBe(START);
  });

  it('ignores the travel buffer unless asked to include it', () => {
    const event = makeEvent({ travelBufferMinutes: 45 });
    expect(desiredFireAt(adjacent(-30), { event })).toBe(START - 30 * MINUTE_MS);
  });

  it('subtracts the travel buffer on top of the offset', () => {
    // "Half an hour before I need to leave", where leaving takes 45 minutes.
    const event = makeEvent({ travelBufferMinutes: 45 });
    expect(desiredFireAt(adjacent(-30, true), { event })).toBe(START - 75 * MINUTE_MS);
  });

  it('always shifts earlier, even for an offset after the event', () => {
    const event = makeEvent({ travelBufferMinutes: 45 });
    expect(desiredFireAt(adjacent(15, true), { event })).toBe(START - 30 * MINUTE_MS);
  });

  it('returns null when the event has gone, rather than guessing a time', () => {
    // Deleted, or lost to a partial import. The caller deactivates the trigger.
    expect(desiredFireAt(adjacent(-30), { event: undefined })).toBeNull();
    expect(desiredFireAt(adjacent(-30, true), { event: undefined })).toBeNull();
  });
});

describe('desiredFireAt — spaced', () => {
  const spaced = (intervalDays: number, lastReviewedAt = START): TriggerCondition => ({
    kind: 'spaced',
    entryId: 'x1',
    ease: 2.5,
    intervalDays,
    reps: 1,
    lastReviewedAt,
    atMinuteOfDay: 8 * 60,
    timezone: 'UTC',
  });

  it('derives the due date from the last review plus the interval', () => {
    // 10 June + 6 days = 16 June, snapped to the digest hour.
    expect(desiredFireAt(spaced(6), {}, START)).toBe(Date.UTC(2026, 5, 16, 8, 0));
  });

  it('is due at the review instant itself for a zero interval, unsnapped', () => {
    // Enrolling something you want to see must not hide it until the next digest hour — and for
    // anyone enrolling before that hour, snapping would mean "due later today" rather than now.
    expect(desiredFireAt(spaced(0), {}, START)).toBe(START);
  });

  it('is due now even when the digest hour is still ahead on the same day', () => {
    // 05:00Z, with a digest at 08:00. The regression this pins only appears before the digest hour.
    const earlyMorning = Date.UTC(2026, 5, 10, 5, 0);
    expect(desiredFireAt(spaced(0, earlyMorning), {}, earlyMorning)).toBe(earlyMorning);
  });

  it('snaps to the digest hour rather than the minute the review was answered', () => {
    // A note due "in six days" should arrive with that morning's digest.
    const odd = Date.UTC(2026, 5, 10, 23, 47);
    expect(desiredFireAt(spaced(1, odd), {}, odd)).toBe(Date.UTC(2026, 5, 11, 8, 0));
  });

  it('needs no fetched target at all', () => {
    expect(desiredFireAt(spaced(3), {}, START)).not.toBeNull();
  });
});
