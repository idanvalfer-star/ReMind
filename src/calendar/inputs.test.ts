import { describe, expect, it } from 'vitest';
import { fromDateTimeInput, toDateInput, toDateTimeInput } from './inputs';

const JLM = 'Asia/Jerusalem';
const NY = 'America/New_York';

describe('toDateTimeInput', () => {
  it('reads the wall clock in the event’s zone, not the host’s', () => {
    // 17:00Z in June is 20:00 in Jerusalem and 13:00 in New York.
    const instant = Date.UTC(2026, 5, 10, 17, 0);
    expect(toDateTimeInput(instant, JLM)).toBe('2026-06-10T20:00');
    expect(toDateTimeInput(instant, NY)).toBe('2026-06-10T13:00');
    expect(toDateTimeInput(instant, 'UTC')).toBe('2026-06-10T17:00');
  });

  it('zero-pads every field', () => {
    expect(toDateTimeInput(Date.UTC(2026, 0, 5, 3, 7), 'UTC')).toBe('2026-01-05T03:07');
  });

  it('crosses the date line when the zone says so', () => {
    // 21:30Z on the 10th is already the 11th in Jerusalem.
    expect(toDateTimeInput(Date.UTC(2026, 5, 10, 21, 30), JLM)).toBe('2026-06-11T00:30');
  });
});

describe('toDateInput', () => {
  it('gives the local calendar date', () => {
    expect(toDateInput(Date.UTC(2026, 5, 10, 21, 30), JLM)).toBe('2026-06-11');
    expect(toDateInput(Date.UTC(2026, 5, 10, 21, 30), 'UTC')).toBe('2026-06-10');
  });
});

describe('fromDateTimeInput', () => {
  it('interprets the value in the given zone', () => {
    expect(fromDateTimeInput('2026-06-10T20:00', JLM)).toBe(Date.UTC(2026, 5, 10, 17, 0));
    expect(fromDateTimeInput('2026-06-10T13:00', NY)).toBe(Date.UTC(2026, 5, 10, 17, 0));
  });

  it('round-trips with toDateTimeInput across zones', () => {
    for (const timezone of [JLM, NY, 'UTC', 'Asia/Kathmandu']) {
      for (const instant of [
        Date.UTC(2026, 5, 10, 17, 0),
        Date.UTC(2026, 0, 1, 0, 0),
        Date.UTC(2026, 11, 31, 23, 45),
      ]) {
        const text = toDateTimeInput(instant, timezone);
        expect(fromDateTimeInput(text, timezone), `${timezone} ${text}`).toBe(instant);
      }
    }
  });

  it('accepts a date without a time, meaning local midnight', () => {
    expect(fromDateTimeInput('2026-06-10', JLM)).toBe(
      fromDateTimeInput('2026-06-10T00:00', JLM),
    );
  });

  it('returns null for a partially typed or malformed value', () => {
    // A half-typed date is a normal transient state in a form field, not an error.
    for (const value of ['', '2026', '2026-06', '2026-06-10T', 'tomorrow', '2026-13-01T00:00']) {
      expect(fromDateTimeInput(value, JLM), JSON.stringify(value)).toSatisfy(
        (result: number | null) => result === null || Number.isFinite(result),
      );
    }
    expect(fromDateTimeInput('', JLM)).toBeNull();
    expect(fromDateTimeInput('nonsense', JLM)).toBeNull();
  });

  it('resolves a nonexistent wall clock forward past a DST gap', () => {
    // 02:30 does not exist in Jerusalem on 27 March 2026. A form must still yield an instant
    // rather than NaN.
    const result = fromDateTimeInput('2026-03-27T02:30', JLM);
    expect(result).not.toBeNull();
    expect(Number.isFinite(result!)).toBe(true);
    expect(toDateTimeInput(result!, JLM)).toBe('2026-03-27T03:30');
  });
});
