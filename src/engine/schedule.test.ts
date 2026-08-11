import { describe, expect, it } from 'vitest';
import type { QuietHours } from '../db/schema';
import { hasCapacityOn, bucketByLocalDay } from './cap';
import { isQuiet } from './quietHours';
import { nearestAllowedInstant, resolveFireTime, type ScheduleContext } from './schedule';
import { zonedParts, zonedWallClockToEpoch } from './time';

const JLM = 'Asia/Jerusalem';
const OVERNIGHT: QuietHours = { enabled: true, start: '22:00', end: '07:00' };
const OFF: QuietHours = { enabled: false, start: '22:00', end: '07:00' };

const local = (day: number, hour: number, minute = 0, month = 6) =>
  zonedWallClockToEpoch({ year: 2026, month, day, hour, minute }, JLM);

function ctx(overrides: Partial<ScheduleContext> = {}): ScheduleContext {
  return {
    quietHours: OVERNIGHT,
    dailyCap: 6,
    timezone: JLM,
    scheduled: [],
    ...overrides,
  };
}

describe('resolveFireTime — allowed', () => {
  it('schedules at exactly the requested instant', () => {
    const at = local(10, 15);
    expect(resolveFireTime(at, ctx())).toEqual({ kind: 'scheduled', fireAt: at });
  });

  it('never moves an allowed time, even by a millisecond', () => {
    // The core promise of suppress-don't-move: a time the user set is the time they get.
    for (const hour of [7, 8, 12, 18, 21]) {
      const at = local(10, hour, 37);
      const decision = resolveFireTime(at, ctx());
      expect(decision.kind, `hour ${hour}`).toBe('scheduled');
      if (decision.kind === 'scheduled') expect(decision.fireAt).toBe(at);
    }
  });

  it('does not object to a time in the past — this function is clock-free', () => {
    const at = local(1, 15);
    expect(resolveFireTime(at, ctx())).toEqual({ kind: 'scheduled', fireAt: at });
  });

  it('allows a time inside a disabled quiet window', () => {
    const at = local(10, 23, 30);
    expect(resolveFireTime(at, ctx({ quietHours: OFF }))).toEqual({
      kind: 'scheduled',
      fireAt: at,
    });
  });
});

describe('resolveFireTime — suppressed by quiet hours', () => {
  it('refuses to notify, and suggests the end of the window', () => {
    const at = local(10, 23, 30);
    const decision = resolveFireTime(at, ctx());

    expect(decision.kind).toBe('suppressed');
    if (decision.kind !== 'suppressed') return;
    expect(decision.reason).toBe('quiet-hours');
    expect(decision.desiredAt).toBe(at);
    expect(zonedParts(decision.suggestion!, JLM)).toMatchObject({ day: 11, hour: 7, minute: 0 });
  });

  it('suppresses across the whole window, including after midnight', () => {
    for (const [day, hour] of [
      [10, 22],
      [10, 23],
      [11, 0],
      [11, 3],
      [11, 6],
    ] as const) {
      const decision = resolveFireTime(local(day, hour), ctx());
      expect(decision.kind, `${day} ${hour}`).toBe('suppressed');
    }
  });

  it('reports quiet hours rather than the cap when both apply', () => {
    // At 23:00 on a full day, "quiet hours" is the reason the user will recognise.
    const scheduled = [local(10, 9), local(10, 10)];
    const decision = resolveFireTime(local(10, 23), ctx({ dailyCap: 2, scheduled }));
    expect(decision.kind).toBe('suppressed');
    if (decision.kind === 'suppressed') expect(decision.reason).toBe('quiet-hours');
  });
});

describe('resolveFireTime — suppressed by the daily cap', () => {
  it('refuses the reminder past the cap instead of spilling it to another day', () => {
    const scheduled = [local(10, 9), local(10, 10)];
    const at = local(10, 15);
    const decision = resolveFireTime(at, ctx({ dailyCap: 2, scheduled }));

    expect(decision.kind).toBe('suppressed');
    if (decision.kind !== 'suppressed') return;
    expect(decision.reason).toBe('daily-cap');
    expect(decision.desiredAt).toBe(at);
    // The suggestion is the next day — but at 07:00, not midnight, since midnight is
    // inside quiet hours. That interaction is why the suggestion is a fixpoint loop.
    expect(zonedParts(decision.suggestion!, JLM)).toMatchObject({ day: 11, hour: 7, minute: 0 });
  });

  it('counts only the target day, so a busy neighbour is irrelevant', () => {
    const scheduled = [local(9, 9), local(9, 10), local(9, 11), local(11, 9), local(11, 10)];
    const at = local(10, 15);
    expect(resolveFireTime(at, ctx({ dailyCap: 2, scheduled }))).toEqual({
      kind: 'scheduled',
      fireAt: at,
    });
  });

  it('allows the last slot under the cap and refuses the one after', () => {
    const scheduled = [local(10, 9)];
    expect(resolveFireTime(local(10, 15), ctx({ dailyCap: 2, scheduled })).kind).toBe('scheduled');
    expect(
      resolveFireTime(local(10, 15), ctx({ dailyCap: 2, scheduled: [...scheduled, local(10, 11)] }))
        .kind,
    ).toBe('suppressed');
  });

  it('suggests nothing when the cap forbids reminders outright', () => {
    const decision = resolveFireTime(local(10, 15), ctx({ dailyCap: 0 }));
    expect(decision.kind).toBe('suppressed');
    if (decision.kind !== 'suppressed') return;
    expect(decision.reason).toBe('daily-cap');
    // A cap of zero is the user asking for no notifications; there is no time that works.
    expect(decision.suggestion).toBeNull();
  });
});

describe('nearestAllowedInstant', () => {
  it('returns the instant itself when it is already allowed', () => {
    const at = local(10, 15);
    expect(nearestAllowedInstant(at, ctx())).toBe(at);
  });

  it('steps over a run of full days, landing at the window end each time', () => {
    const scheduled = [
      local(10, 9),
      local(10, 10),
      local(11, 7),
      local(11, 12),
      local(12, 9),
      local(12, 10),
    ];
    const result = nearestAllowedInstant(local(10, 15), ctx({ dailyCap: 2, scheduled }));
    expect(zonedParts(result!, JLM)).toMatchObject({ day: 13, hour: 7 });
  });

  it('keeps the window end at the intended wall clock across a spring-forward night', () => {
    // Jerusalem loses 02:00–02:59 local on 2026-03-27.
    const result = nearestAllowedInstant(local(26, 23, 30, 3), ctx());
    expect(zonedParts(result!, JLM)).toMatchObject({ month: 3, day: 27, hour: 7, minute: 0 });
    expect(result).toBe(Date.UTC(2026, 2, 27, 4, 0)); // 07:00 at UTC+3
  });

  it('steps across a 23-hour day without losing one', () => {
    const scheduled = [local(27, 9, 0, 3), local(27, 10, 0, 3)];
    const result = nearestAllowedInstant(local(27, 15, 0, 3), ctx({ dailyCap: 2, scheduled }));
    expect(zonedParts(result!, JLM)).toMatchObject({ month: 3, day: 28, hour: 7 });
  });

  it('is null when nothing is ever permitted', () => {
    expect(nearestAllowedInstant(local(10, 15), ctx({ dailyCap: 0 }))).toBeNull();
  });
});

describe('resolveFireTime — invariants', () => {
  it('either schedules the exact instant requested, or suppresses with a usable suggestion', () => {
    const scheduled = [local(10, 9), local(10, 10), local(11, 8)];
    const cap = 2;
    const context = ctx({ dailyCap: cap, scheduled });
    const counts = bucketByLocalDay(scheduled, JLM);

    for (const day of [10, 11, 12]) {
      for (const hour of [0, 3, 6, 7, 12, 21, 22, 23]) {
        const desired = local(day, hour);
        const decision = resolveFireTime(desired, context);
        const where = `day ${day} hour ${hour}`;

        if (decision.kind === 'scheduled') {
          // Allowed means untouched, and genuinely legal.
          expect(decision.fireAt, where).toBe(desired);
          expect(isQuiet(desired, OVERNIGHT, JLM), where).toBe(false);
          expect(hasCapacityOn(desired, counts, cap, JLM), where).toBe(true);
        } else {
          // Suppressed means at least one constraint really did bite...
          const quiet = isQuiet(desired, OVERNIGHT, JLM);
          const full = !hasCapacityOn(desired, counts, cap, JLM);
          expect(quiet || full, where).toBe(true);

          // ...and any suggestion offered must itself be legal and not in the past.
          expect(decision.suggestion, where).not.toBeNull();
          expect(decision.suggestion!, where).toBeGreaterThanOrEqual(desired);
          expect(isQuiet(decision.suggestion!, OVERNIGHT, JLM), where).toBe(false);
          expect(hasCapacityOn(decision.suggestion!, counts, cap, JLM), where).toBe(true);
        }
      }
    }
  });
});
