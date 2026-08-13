import { describe, expect, it } from 'vitest';
import { stagesFor, STAGE_RULES } from './stages';
import { DAY_MS, minutesOfDay, zonedWallClockToEpoch } from '../engine/time';

const JLM = 'Asia/Jerusalem';
const local = (month: number, day: number, hour = 0, minute = 0) =>
  zonedWallClockToEpoch({ year: 2026, month, day, hour, minute }, JLM);

/** A trip departing 20 June at 09:00 local and returning on the 27th. */
const trip = (nights = 7) => ({
  startAt: local(6, 20, 9),
  endAt: local(6, 20, 9) + nights * DAY_MS,
  timezone: JLM,
});

const ids = (now: number, nights = 7) => stagesFor(trip(nights), now).map((s) => s.id);

describe('stagesFor', () => {
  it('schedules all four stages when the trip is far enough away', () => {
    expect(ids(local(6, 1, 12))).toEqual(['shop', 'night-before', 'departure-day', 'return-eve']);
  });

  it('returns them in chronological order', () => {
    const stages = stagesFor(trip(), local(6, 1, 12));
    const times = stages.map((s) => s.at);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('drops the shopping stage once it is in the past', () => {
    // Five days out: the week-ahead nudge has already gone by.
    expect(ids(local(6, 15, 12))).toEqual(['night-before', 'departure-day', 'return-eve']);
  });

  it('drops everything before departure once the trip has begun', () => {
    expect(ids(local(6, 21, 12))).toEqual(['return-eve']);
  });

  it('returns nothing for a trip already over', () => {
    expect(ids(local(7, 1, 12))).toEqual([]);
  });

  it('puts each stage at its intended local hour', () => {
    const stages = stagesFor(trip(), local(6, 1, 12));
    const at = (id: string) => stages.find((s) => s.id === id)!.at;

    expect(minutesOfDay(at('shop'), JLM)).toBe(11 * 60);
    expect(minutesOfDay(at('night-before'), JLM)).toBe(18 * 60);
    expect(minutesOfDay(at('departure-day'), JLM)).toBe(7 * 60);
    expect(minutesOfDay(at('return-eve'), JLM)).toBe(20 * 60);
  });

  it('puts the shopping stage a week before departure', () => {
    const stages = stagesFor(trip(), local(6, 1, 12));
    const shop = stages.find((s) => s.id === 'shop')!.at;
    expect(shop).toBeGreaterThan(local(6, 13, 0));
    expect(shop).toBeLessThan(local(6, 13, 23, 59));
  });

  it('skips the shopping stage and the return checklist on a one-night trip', () => {
    // A single overnight needs neither a week of notice nor a checklist for going home.
    expect(ids(local(6, 1, 12), 1)).toEqual(['night-before', 'departure-day']);
  });

  it('drops the departure-day stage for an early departure it would arrive after', () => {
    // A 06:00 flight does not want a 07:00 reminder to check the passport.
    const early = { startAt: local(6, 20, 6), endAt: local(6, 27, 12), timezone: JLM };
    expect(stagesFor(early, local(6, 1, 12)).map((s) => s.id)).not.toContain('departure-day');
  });

  it('keeps the departure-day stage for a departure comfortably after 07:00', () => {
    const later = { startAt: local(6, 20, 14), endAt: local(6, 27, 12), timezone: JLM };
    expect(stagesFor(later, local(6, 1, 12)).map((s) => s.id)).toContain('departure-day');
  });

  it('always lands every stage before the moment it prepares you for', () => {
    // The general invariant behind the departure-day case above. Swept across departure hours so a
    // future change to any rule's hour cannot quietly produce a stage that arrives too late.
    for (const departureHour of [0, 5, 6, 7, 8, 12, 21, 23]) {
      const shape = {
        startAt: local(6, 20, departureHour),
        endAt: local(6, 27, departureHour),
        timezone: JLM,
      };
      for (const stage of stagesFor(shape, local(6, 1, 12))) {
        const rule = STAGE_RULES.find((r) => r.id === stage.id)!;
        const anchor = rule.anchor === 'start' ? shape.startAt : shape.endAt;
        expect(stage.at).toBeLessThan(anchor);
      }
    }
  });

  it('lands on the intended wall clock across a DST boundary', () => {
    // Israel springs forward in late March; a trip spanning it must still be nudged at 18:00 local.
    const spring = {
      startAt: local(3, 30, 12),
      endAt: local(4, 6, 12),
      timezone: JLM,
    };
    const stages = stagesFor(spring, local(3, 1, 12));
    for (const stage of stages) {
      const rule = STAGE_RULES.find((r) => r.id === stage.id)!;
      expect(minutesOfDay(stage.at, JLM)).toBe(rule.atMinuteOfDay);
    }
  });

  it('never returns a stage in the past', () => {
    for (const now of [local(6, 1), local(6, 14), local(6, 19, 20), local(6, 25)]) {
      for (const stage of stagesFor(trip(), now)) expect(stage.at).toBeGreaterThan(now);
    }
  });
});
