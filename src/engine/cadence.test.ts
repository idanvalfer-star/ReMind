import { describe, expect, it } from 'vitest';
import { cadenceFireAt, cadenceOverdueDays, DEFAULT_CADENCE_MINUTE_OF_DAY } from './cadence';
import type { Person } from '../db/schema';
import { DAY_MS, minutesOfDay, zonedParts } from './time';

const TZ = 'Asia/Jerusalem';

function person(overrides: Partial<Person> = {}): Person {
  return {
    id: 'p1',
    name: 'Sarah',
    aliases: [],
    cadenceDays: 14,
    lastInteractionAt: null,
    createdAt: Date.UTC(2026, 0, 1, 12, 0),
    ...overrides,
  };
}

const rule = (days: number, atMinuteOfDay = DEFAULT_CADENCE_MINUTE_OF_DAY) => ({
  days,
  atMinuteOfDay,
  timezone: TZ,
});

describe('cadenceFireAt', () => {
  it('returns null for a person that no longer exists', () => {
    expect(cadenceFireAt(rule(14), undefined, Date.UTC(2026, 0, 1))).toBeNull();
  });

  it('counts from the last interaction when there is one', () => {
    const last = Date.UTC(2026, 2, 10, 18, 30);
    const at = cadenceFireAt(rule(7), person({ lastInteractionAt: last }), last)!;

    const parts = zonedParts(at, TZ);
    expect(`${parts.year}-${parts.month}-${parts.day}`).toBe('2026-3-17');
  });

  it('falls back to createdAt for a person never interacted with', () => {
    const created = Date.UTC(2026, 0, 1, 12, 0);
    const at = cadenceFireAt(rule(3), person({ createdAt: created }), created)!;

    const parts = zonedParts(at, TZ);
    expect(`${parts.year}-${parts.month}-${parts.day}`).toBe('2026-1-4');
  });

  it('lands on the preferred hour, not the hour of the anchor', () => {
    // Anchored at 18:30 local-ish; the reminder must not inherit that minute.
    const last = Date.UTC(2026, 5, 1, 15, 30);
    const at = cadenceFireAt(rule(5, 9 * 60), person({ lastInteractionAt: last }), last)!;

    expect(minutesOfDay(at, TZ)).toBe(9 * 60);
  });

  it('honours a non-default preferred hour', () => {
    const last = Date.UTC(2026, 5, 1, 3, 0);
    const at = cadenceFireAt(rule(2, 20 * 60 + 15), person({ lastInteractionAt: last }), last)!;

    expect(minutesOfDay(at, TZ)).toBe(20 * 60 + 15);
  });

  it('is allowed to be a few hours early rather than a whole day late', () => {
    // Anchor 20:00 local, one day later at 09:00 is 13 hours short of a full day. That is the
    // documented trade: an interval that was approximate should not slip a whole day to be
    // pedantically correct.
    const last = Date.UTC(2026, 5, 1, 17, 0); // 20:00 Jerusalem (UTC+3 in June)
    const at = cadenceFireAt(rule(1, 9 * 60), person({ lastInteractionAt: last }), last)!;

    expect(at - last).toBeLessThan(DAY_MS);
    expect(minutesOfDay(at, TZ)).toBe(9 * 60);
  });

  it('never returns an instant in the past', () => {
    const last = Date.UTC(2020, 0, 1);
    const now = Date.UTC(2026, 5, 15, 6, 0);
    const at = cadenceFireAt(rule(21), person({ lastInteractionAt: last }), now)!;

    expect(at).toBeGreaterThan(now);
  });

  it('surfaces a badly overdue cadence today, not on the original grid', () => {
    // Two months lapsed on a three-week cadence. Resuming at the next multiple of 21 days
    // would be answering the wrong question — contact has already lapsed, so the answer is now.
    const last = Date.UTC(2026, 3, 1, 6, 0);
    const now = Date.UTC(2026, 5, 15, 3, 0); // 06:00 Jerusalem, before the 09:00 slot
    const at = cadenceFireAt(rule(21, 9 * 60), person({ lastInteractionAt: last }), now)!;

    expect(at - now).toBeLessThan(DAY_MS);
    expect(minutesOfDay(at, TZ)).toBe(9 * 60);
  });

  it('rolls to tomorrow when the overdue slot has already passed today', () => {
    const last = Date.UTC(2026, 3, 1);
    const now = Date.UTC(2026, 5, 15, 12, 0); // 15:00 Jerusalem, past the 09:00 slot
    const at = cadenceFireAt(rule(21, 9 * 60), person({ lastInteractionAt: last }), now)!;

    expect(at).toBeGreaterThan(now);
    expect(at - now).toBeLessThan(DAY_MS);
    expect(zonedParts(at, TZ).day).toBe(zonedParts(now, TZ).day + 1);
  });

  it('treats a zero or negative interval as one day rather than firing instantly', () => {
    const last = Date.UTC(2026, 5, 1, 6, 0);
    const zero = cadenceFireAt(rule(0), person({ lastInteractionAt: last }), last)!;
    const one = cadenceFireAt(rule(1), person({ lastInteractionAt: last }), last)!;

    expect(zero).toBe(one);
  });

  it('lands on the preferred wall clock across a DST transition', () => {
    // Israel springs forward in late March. A cadence spanning it must still arrive at 09:00
    // local, not 08:00 or 10:00.
    const last = Date.UTC(2026, 2, 20, 7, 0);
    const at = cadenceFireAt(rule(14, 9 * 60), person({ lastInteractionAt: last }), last)!;

    expect(minutesOfDay(at, TZ)).toBe(9 * 60);
    expect(zonedParts(at, TZ).month).toBe(4);
  });
});

describe('cadenceOverdueDays', () => {
  it('is null for someone not on a cadence', () => {
    expect(cadenceOverdueDays(person({ cadenceDays: null }), Date.now())).toBeNull();
  });

  it('is negative before the interval elapses', () => {
    const last = Date.UTC(2026, 5, 1);
    expect(cadenceOverdueDays(person({ cadenceDays: 10, lastInteractionAt: last }), last)).toBe(-10);
  });

  it('counts whole days past due', () => {
    const last = Date.UTC(2026, 5, 1);
    const now = last + 13 * DAY_MS;
    expect(cadenceOverdueDays(person({ cadenceDays: 10, lastInteractionAt: last }), now)).toBe(3);
  });

  it('measures from createdAt when there has been no interaction', () => {
    const created = Date.UTC(2026, 5, 1);
    const now = created + 12 * DAY_MS;
    const p = person({ cadenceDays: 5, lastInteractionAt: null, createdAt: created });
    expect(cadenceOverdueDays(p, now)).toBe(7);
  });
});
