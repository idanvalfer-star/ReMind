import { describe, expect, it } from 'vitest';
import {
  atLocalMinutesOnDayOf,
  DAY_MS,
  HOUR_MS,
  localDayKey,
  minutesOfDay,
  parseHHmm,
  startOfNextLocalDay,
  zonedParts,
  zonedWallClockToEpoch,
} from './time';

/**
 * Expected instants here are written as raw UTC, never via `zonedWallClockToEpoch`, since
 * that is the function under test.
 *
 * Reference transitions (verified against the IANA database):
 * - America/New_York 2026-03-08: 02:00 → 03:00, so 02:00–02:59 local does not exist.
 * - America/New_York 2026-11-01: 02:00 → 01:00, so 01:00–01:59 local happens twice.
 * - Asia/Jerusalem   2026-03-27: 02:00 → 03:00 (DST begins).
 */
const NY = 'America/New_York';
const JLM = 'Asia/Jerusalem';
const KTM = 'Asia/Kathmandu'; // UTC+5:45 — catches anything assuming whole-hour offsets

const utc = (y: number, m: number, d: number, h = 0, min = 0) => Date.UTC(y, m - 1, d, h, min);

describe('zonedParts', () => {
  it('reads the local wall clock, not UTC', () => {
    // Jerusalem is UTC+3 in June.
    expect(zonedParts(utc(2026, 6, 1, 9, 0), JLM)).toEqual({
      year: 2026,
      month: 6,
      day: 1,
      hour: 12,
      minute: 0,
    });
    // ...and UTC+2 in December.
    expect(zonedParts(utc(2026, 12, 1, 9, 0), JLM)).toEqual({
      year: 2026,
      month: 12,
      day: 1,
      hour: 11,
      minute: 0,
    });
  });

  it('handles a non-whole-hour offset', () => {
    expect(zonedParts(utc(2026, 6, 1, 9, 0), KTM)).toEqual({
      year: 2026,
      month: 6,
      day: 1,
      hour: 14,
      minute: 45,
    });
  });

  it('uses a 24-hour clock, so local midnight is hour 0 and not hour 24', () => {
    // hourCycle h23 exists for exactly this: some ICU builds report "24" for midnight.
    expect(zonedParts(utc(2026, 6, 1, 21, 0), JLM).hour).toBe(0);
    expect(minutesOfDay(utc(2026, 6, 1, 21, 0), JLM)).toBe(0);
  });
});

describe('localDayKey', () => {
  it('rolls over at local midnight rather than UTC midnight', () => {
    // 21:30Z is already the next day in Jerusalem (UTC+3).
    expect(localDayKey(utc(2026, 6, 1, 21, 30), JLM)).toBe('2026-06-02');
    expect(localDayKey(utc(2026, 6, 1, 21, 30), 'UTC')).toBe('2026-06-01');
    // ...and still the previous day in New York (UTC-4).
    expect(localDayKey(utc(2026, 6, 1, 3, 30), NY)).toBe('2026-05-31');
  });

  it('zero-pads so keys sort lexicographically', () => {
    expect(localDayKey(utc(2026, 1, 5, 12, 0), 'UTC')).toBe('2026-01-05');
  });
});

describe('zonedWallClockToEpoch', () => {
  it('round-trips ordinary times across several zones', () => {
    for (const tz of [NY, JLM, KTM, 'UTC', 'Australia/Sydney']) {
      const parts = { year: 2026, month: 6, day: 15, hour: 14, minute: 30 };
      const instant = zonedWallClockToEpoch(parts, tz);
      expect(zonedParts(instant, tz), tz).toEqual(parts);
    }
  });

  it('resolves an ambiguous time to the earlier of the two instants', () => {
    // 01:30 happens twice on 2026-11-01 in New York: once at -04:00, once at -05:00.
    const instant = zonedWallClockToEpoch(
      { year: 2026, month: 11, day: 1, hour: 1, minute: 30 },
      NY,
    );
    expect(instant).toBe(utc(2026, 11, 1, 5, 30)); // the -04:00 (earlier) occurrence
    // Both readings are 01:30 locally, so confirm we picked the first one.
    expect(zonedParts(instant, NY).hour).toBe(1);
    expect(instant).toBeLessThan(utc(2026, 11, 1, 6, 30));
  });

  it('shifts a nonexistent time forward past the gap', () => {
    // 02:30 does not exist on 2026-03-08 in New York; the clock goes 01:59 → 03:00.
    const instant = zonedWallClockToEpoch(
      { year: 2026, month: 3, day: 8, hour: 2, minute: 30 },
      NY,
    );
    expect(instant).toBe(utc(2026, 3, 8, 7, 30));
    expect(zonedParts(instant, NY)).toMatchObject({ hour: 3, minute: 30 });
  });

  it('shifts forward for the Jerusalem spring-forward gap too', () => {
    // Asia/Jerusalem 2026-03-27: 02:00 → 03:00.
    const instant = zonedWallClockToEpoch(
      { year: 2026, month: 3, day: 27, hour: 2, minute: 30 },
      JLM,
    );
    expect(zonedParts(instant, JLM)).toMatchObject({ day: 27, hour: 3, minute: 30 });
  });
});

describe('atLocalMinutesOnDayOf', () => {
  it('finds a wall-clock time on the local day containing the instant', () => {
    // 21:30Z on Jun 1 is Jun 2 in Jerusalem, so 07:00 means Jun 2 at 07:00 local.
    const instant = atLocalMinutesOnDayOf(utc(2026, 6, 1, 21, 30), JLM, 7 * 60);
    expect(zonedParts(instant, JLM)).toEqual({
      year: 2026,
      month: 6,
      day: 2,
      hour: 7,
      minute: 0,
    });
  });
});

describe('startOfNextLocalDay', () => {
  it('lands on local midnight', () => {
    const instant = startOfNextLocalDay(utc(2026, 6, 1, 9, 0), JLM);
    expect(zonedParts(instant, JLM)).toEqual({
      year: 2026,
      month: 6,
      day: 2,
      hour: 0,
      minute: 0,
    });
  });

  it('advances the calendar rather than adding 24 hours', () => {
    // The local day containing the spring-forward transition is 23 hours long. Adding
    // DAY_MS would overshoot into the day after next.
    const midnightMar27 = zonedWallClockToEpoch(
      { year: 2026, month: 3, day: 27, hour: 0, minute: 0 },
      JLM,
    );
    const midnightMar28 = startOfNextLocalDay(midnightMar27, JLM);

    expect(zonedParts(midnightMar28, JLM)).toMatchObject({ month: 3, day: 28, hour: 0 });
    expect(midnightMar28 - midnightMar27).toBe(23 * HOUR_MS);
    expect(midnightMar28 - midnightMar27).not.toBe(DAY_MS);
  });

  it('crosses month and year boundaries', () => {
    expect(zonedParts(startOfNextLocalDay(utc(2026, 1, 31, 12, 0), 'UTC'), 'UTC')).toMatchObject({
      year: 2026,
      month: 2,
      day: 1,
    });
    expect(zonedParts(startOfNextLocalDay(utc(2026, 12, 31, 12, 0), 'UTC'), 'UTC')).toMatchObject({
      year: 2027,
      month: 1,
      day: 1,
    });
  });
});

describe('parseHHmm', () => {
  it('parses valid 24-hour times', () => {
    expect(parseHHmm('00:00')).toBe(0);
    expect(parseHHmm('07:00')).toBe(420);
    expect(parseHHmm('22:30')).toBe(1350);
    expect(parseHHmm('23:59')).toBe(1439);
  });

  it('returns null for anything malformed, so corrupt settings degrade instead of throwing', () => {
    for (const bad of ['', '7:00', '24:00', '22:60', '22', '22:00:00', 'ten', '-1:00', '2:0']) {
      expect(parseHHmm(bad), bad).toBeNull();
    }
  });
});
