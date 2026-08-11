import { describe, expect, it } from 'vitest';
import type { QuietHours } from '../db/schema';
import { isQuiet, nextAllowedInstant } from './quietHours';
import { zonedParts, zonedWallClockToEpoch } from './time';

const JLM = 'Asia/Jerusalem';

/** The default window: wraps past midnight, which is the case that gets edge cases wrong. */
const OVERNIGHT: QuietHours = { enabled: true, start: '22:00', end: '07:00' };
/** A window inside a single day, for contrast. */
const MIDDAY: QuietHours = { enabled: true, start: '13:00', end: '14:00' };

/** Builds an instant from a Jerusalem wall clock, which is how these cases are specified. */
const local = (day: number, hour: number, minute = 0, month = 6) =>
  zonedWallClockToEpoch({ year: 2026, month, day, hour, minute }, JLM);

describe('isQuiet — overnight window', () => {
  it('is quiet from the start time through to just before the end time', () => {
    expect(isQuiet(local(10, 22, 0), OVERNIGHT, JLM)).toBe(true); // inclusive start
    expect(isQuiet(local(10, 23, 30), OVERNIGHT, JLM)).toBe(true);
    expect(isQuiet(local(11, 0, 0), OVERNIGHT, JLM)).toBe(true); // across midnight
    expect(isQuiet(local(11, 3, 0), OVERNIGHT, JLM)).toBe(true);
    expect(isQuiet(local(11, 6, 59), OVERNIGHT, JLM)).toBe(true);
  });

  it('is not quiet outside it, with an exclusive end', () => {
    expect(isQuiet(local(11, 7, 0), OVERNIGHT, JLM)).toBe(false); // exclusive end
    expect(isQuiet(local(11, 12, 0), OVERNIGHT, JLM)).toBe(false);
    expect(isQuiet(local(11, 21, 59), OVERNIGHT, JLM)).toBe(false);
  });
});

describe('isQuiet — same-day window', () => {
  it('brackets the window without wrapping', () => {
    expect(isQuiet(local(10, 12, 59), MIDDAY, JLM)).toBe(false);
    expect(isQuiet(local(10, 13, 0), MIDDAY, JLM)).toBe(true);
    expect(isQuiet(local(10, 13, 59), MIDDAY, JLM)).toBe(true);
    expect(isQuiet(local(10, 14, 0), MIDDAY, JLM)).toBe(false);
    expect(isQuiet(local(10, 3, 0), MIDDAY, JLM)).toBe(false);
  });
});

describe('isQuiet — degrades open, never closed', () => {
  it('is never quiet when disabled', () => {
    expect(isQuiet(local(10, 23, 0), { ...OVERNIGHT, enabled: false }, JLM)).toBe(false);
  });

  it('is never quiet for a malformed window', () => {
    // A hand-edited JSON import can produce this. Losing a reminder is worse than one
    // badly-timed buzz, so a broken window silences nothing.
    expect(isQuiet(local(10, 23, 0), { enabled: true, start: 'nope', end: '07:00' }, JLM)).toBe(
      false,
    );
    expect(isQuiet(local(10, 23, 0), { enabled: true, start: '22:00', end: '25:00' }, JLM)).toBe(
      false,
    );
  });

  it('treats a zero-length window as no window at all', () => {
    // "22:00 to 22:00" could be read as 24 hours of silence, but that would make
    // scheduling impossible.
    expect(isQuiet(local(10, 23, 0), { enabled: true, start: '22:00', end: '22:00' }, JLM)).toBe(
      false,
    );
  });
});

describe('nextAllowedInstant', () => {
  it('leaves an already-allowed instant untouched', () => {
    const at = local(10, 12, 0);
    expect(nextAllowedInstant(at, OVERNIGHT, JLM)).toBe(at);
  });

  it('moves a late-evening time to the following morning', () => {
    const result = nextAllowedInstant(local(10, 23, 30), OVERNIGHT, JLM);
    expect(zonedParts(result, JLM)).toMatchObject({ day: 11, hour: 7, minute: 0 });
  });

  it('moves an early-morning time to later the same morning', () => {
    const result = nextAllowedInstant(local(11, 3, 0), OVERNIGHT, JLM);
    expect(zonedParts(result, JLM)).toMatchObject({ day: 11, hour: 7, minute: 0 });
  });

  it('moves to the end of a same-day window', () => {
    const result = nextAllowedInstant(local(10, 13, 30), MIDDAY, JLM);
    expect(zonedParts(result, JLM)).toMatchObject({ day: 10, hour: 14, minute: 0 });
  });

  it('handles a window that ends at midnight', () => {
    const toMidnight: QuietHours = { enabled: true, start: '22:00', end: '00:00' };
    const result = nextAllowedInstant(local(10, 23, 0), toMidnight, JLM);
    expect(zonedParts(result, JLM)).toMatchObject({ day: 11, hour: 0, minute: 0 });
  });

  it('lands on the right wall-clock time across a DST transition', () => {
    // Asia/Jerusalem gains an hour at 02:00 on 2026-03-27, in the middle of the window.
    // The reminder must surface at 07:00 local — the *wall clock* the user set — not at
    // whatever instant 07:00 would have been under the old offset.
    const at = zonedWallClockToEpoch({ year: 2026, month: 3, day: 27, hour: 1, minute: 0 }, JLM);
    expect(isQuiet(at, OVERNIGHT, JLM)).toBe(true);

    const result = nextAllowedInstant(at, OVERNIGHT, JLM);
    expect(zonedParts(result, JLM)).toMatchObject({ month: 3, day: 27, hour: 7, minute: 0 });
    // 07:00 at UTC+3 is 04:00Z. Under the pre-transition +2 offset it would have been 05:00Z.
    expect(result).toBe(Date.UTC(2026, 2, 27, 4, 0));
  });

  it('always returns an instant that is itself allowed', () => {
    // Property check: whatever the window, one application is enough.
    for (const hour of [0, 3, 6, 7, 12, 21, 22, 23]) {
      for (const window of [OVERNIGHT, MIDDAY]) {
        const at = local(10, hour);
        const result = nextAllowedInstant(at, window, JLM);
        expect(isQuiet(result, window, JLM), `hour ${hour}`).toBe(false);
        expect(result).toBeGreaterThanOrEqual(at);
      }
    }
  });
});
