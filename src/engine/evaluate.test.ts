import { describe, expect, it } from 'vitest';
import type { Event, TriggerCondition } from '../db/schema';
import { desiredFireAt, isSchedulable, type SchedulableCondition } from './evaluate';
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

describe('isSchedulable', () => {
  it('accepts the kinds that have evaluators', () => {
    expect(isSchedulable({ kind: 'time', at: START, timezone: 'UTC' })).toBe(true);
    expect(
      isSchedulable({
        kind: 'event-adjacent',
        eventId: 'e1',
        offsetMinutes: -30,
        includeTravelBuffer: false,
      }),
    ).toBe(true);
  });

  it('rejects the kinds that do not', () => {
    const cadence: TriggerCondition = { kind: 'cadence', personId: 'p1', days: 30 };
    const spaced: TriggerCondition = {
      kind: 'spaced',
      entryId: 'x1',
      ease: 2.5,
      intervalDays: 1,
      reps: 0,
    };
    expect(isSchedulable(cadence)).toBe(false);
    expect(isSchedulable(spaced)).toBe(false);
  });
});

describe('desiredFireAt — time', () => {
  it('is the stored instant', () => {
    expect(desiredFireAt({ kind: 'time', at: START, timezone: 'UTC' }, undefined)).toBe(START);
  });
});

describe('desiredFireAt — event-adjacent', () => {
  const adjacent = (
    offsetMinutes: number,
    includeTravelBuffer = false,
  ): SchedulableCondition => ({
    kind: 'event-adjacent',
    eventId: 'e1',
    offsetMinutes,
    includeTravelBuffer,
  });

  it('fires before the event for a negative offset', () => {
    expect(desiredFireAt(adjacent(-30), makeEvent())).toBe(START - 30 * MINUTE_MS);
  });

  it('fires after the event for a positive offset', () => {
    expect(desiredFireAt(adjacent(15), makeEvent())).toBe(START + 15 * MINUTE_MS);
  });

  it('fires at the event start for a zero offset', () => {
    expect(desiredFireAt(adjacent(0), makeEvent())).toBe(START);
  });

  it('ignores the travel buffer unless asked to include it', () => {
    const event = makeEvent({ travelBufferMinutes: 45 });
    expect(desiredFireAt(adjacent(-30), event)).toBe(START - 30 * MINUTE_MS);
  });

  it('subtracts the travel buffer on top of the offset', () => {
    // "Half an hour before I need to leave", where leaving takes 45 minutes.
    const event = makeEvent({ travelBufferMinutes: 45 });
    expect(desiredFireAt(adjacent(-30, true), event)).toBe(START - 75 * MINUTE_MS);
  });

  it('always shifts earlier, even for an offset after the event', () => {
    const event = makeEvent({ travelBufferMinutes: 45 });
    expect(desiredFireAt(adjacent(15, true), event)).toBe(START - 30 * MINUTE_MS);
  });

  it('returns null when the event has gone, rather than guessing a time', () => {
    // Deleted, or lost to a partial import. The caller deactivates the trigger.
    expect(desiredFireAt(adjacent(-30), undefined)).toBeNull();
    expect(desiredFireAt(adjacent(-30, true), undefined)).toBeNull();
  });
});
