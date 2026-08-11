import { describe, expect, it } from 'vitest';
import type { QuietHours } from '../db/schema';
import { isQuiet } from './quietHours';
import { resolveFireTime, type ScheduleContext } from './schedule';
import { localDayKey, zonedParts, zonedWallClockToEpoch } from './time';

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

describe('resolveFireTime — no adjustment needed', () => {
  it('leaves a legal time alone', () => {
    const at = local(10, 15);
    expect(resolveFireTime(at, ctx())).toEqual({ fireAt: at, adjusted: 'none' });
  });

  it('does not object to a time in the past — this function is clock-free', () => {
    const at = local(1, 15);
    expect(resolveFireTime(at, ctx()).fireAt).toBe(at);
  });
});

describe('resolveFireTime — quiet hours', () => {
  it('shifts a reminder that lands mid-window to the end of it', () => {
    const outcome = resolveFireTime(local(10, 23, 30), ctx());
    expect(outcome.adjusted).toBe('quiet-hours');
    expect(zonedParts(outcome.fireAt!, JLM)).toMatchObject({ day: 11, hour: 7, minute: 0 });
  });

  it('does not shift when quiet hours are disabled', () => {
    const at = local(10, 23, 30);
    expect(resolveFireTime(at, ctx({ quietHours: OFF }))).toEqual({ fireAt: at, adjusted: 'none' });
  });
});

describe('resolveFireTime — daily cap', () => {
  it('spills the reminder past the cap onto the next day', () => {
    const scheduled = [local(10, 9), local(10, 10)];
    const outcome = resolveFireTime(local(10, 15), ctx({ dailyCap: 2, scheduled }));

    expect(outcome.adjusted).toBe('both');
    // The next day is not full, so it lands there — but at 07:00, not midnight, because
    // midnight is inside quiet hours. This interaction is the reason resolveFireTime is a
    // fixpoint loop rather than two sequential adjustments.
    expect(zonedParts(outcome.fireAt!, JLM)).toMatchObject({ day: 11, hour: 7, minute: 0 });
  });

  it('reports only the cap when quiet hours are off', () => {
    const scheduled = [local(10, 9), local(10, 10)];
    const outcome = resolveFireTime(
      local(10, 15),
      ctx({ dailyCap: 2, scheduled, quietHours: OFF }),
    );
    expect(outcome.adjusted).toBe('daily-cap');
    expect(zonedParts(outcome.fireAt!, JLM)).toMatchObject({ day: 11, hour: 0, minute: 0 });
  });

  it('walks over a run of full days', () => {
    const scheduled = [
      local(10, 9),
      local(10, 10),
      // Day 11 is filled by the 07:00 slot plus one more.
      local(11, 7),
      local(11, 12),
      local(12, 9),
      local(12, 10),
    ];
    const outcome = resolveFireTime(local(10, 15), ctx({ dailyCap: 2, scheduled }));
    expect(zonedParts(outcome.fireAt!, JLM)).toMatchObject({ day: 13, hour: 7 });
  });

  it('counts only the target day, so a busy neighbour is irrelevant', () => {
    const scheduled = [local(9, 9), local(9, 10), local(9, 11), local(11, 9), local(11, 10)];
    const at = local(10, 15);
    expect(resolveFireTime(at, ctx({ dailyCap: 2, scheduled })).fireAt).toBe(at);
  });

  it('returns null when the cap is zero, rather than scheduling anyway', () => {
    const outcome = resolveFireTime(local(10, 15), ctx({ dailyCap: 0 }));
    expect(outcome.fireAt).toBeNull();
  });
});

describe('resolveFireTime — DST', () => {
  it('keeps the window end at the intended wall clock across a spring-forward night', () => {
    // Jerusalem loses 02:00–02:59 local on 2026-03-27.
    const outcome = resolveFireTime(local(26, 23, 30, 3), ctx());
    expect(zonedParts(outcome.fireAt!, JLM)).toMatchObject({
      month: 3,
      day: 27,
      hour: 7,
      minute: 0,
    });
    expect(outcome.fireAt).toBe(Date.UTC(2026, 2, 27, 4, 0)); // 07:00 at UTC+3
  });

  it('spills across a 23-hour day without losing a day', () => {
    const scheduled = [local(27, 9, 0, 3), local(27, 10, 0, 3)];
    const outcome = resolveFireTime(local(27, 15, 0, 3), ctx({ dailyCap: 2, scheduled }));
    expect(zonedParts(outcome.fireAt!, JLM)).toMatchObject({ month: 3, day: 28, hour: 7 });
  });
});

describe('resolveFireTime — invariants', () => {
  it('never returns a time that is quiet, capped, or earlier than requested', () => {
    const scheduled = [local(10, 9), local(10, 10), local(11, 8)];
    const cap = 2;

    for (const day of [10, 11, 12]) {
      for (const hour of [0, 3, 6, 7, 12, 21, 22, 23]) {
        const desired = local(day, hour);
        const { fireAt } = resolveFireTime(desired, ctx({ dailyCap: cap, scheduled }));
        expect(fireAt, `day ${day} hour ${hour}`).not.toBeNull();
        expect(fireAt!, `day ${day} hour ${hour}`).toBeGreaterThanOrEqual(desired);
        expect(isQuiet(fireAt!, OVERNIGHT, JLM), `day ${day} hour ${hour}`).toBe(false);

        const onDay = scheduled.filter((s) => localDayKey(s, JLM) === localDayKey(fireAt!, JLM));
        expect(onDay.length, `day ${day} hour ${hour}`).toBeLessThan(cap);
      }
    }
  });
});
