import { describe, expect, it } from 'vitest';
import { bucketByLocalDay, hasCapacityOn, nextInstantWithCapacity } from './cap';
import { zonedParts, zonedWallClockToEpoch } from './time';

const JLM = 'Asia/Jerusalem';

const local = (day: number, hour: number, minute = 0) =>
  zonedWallClockToEpoch({ year: 2026, month: 6, day, hour, minute }, JLM);

describe('bucketByLocalDay', () => {
  it('groups by local day, not UTC day', () => {
    // 22:00Z on Jun 10 is already Jun 11 in Jerusalem (UTC+3), so these two land in
    // different buckets despite sharing a UTC date.
    const counts = bucketByLocalDay([Date.UTC(2026, 5, 10, 12, 0), Date.UTC(2026, 5, 10, 22, 0)], JLM);
    expect(counts.get('2026-06-10')).toBe(1);
    expect(counts.get('2026-06-11')).toBe(1);
  });

  it('counts repeats within a day', () => {
    const counts = bucketByLocalDay([local(10, 9), local(10, 10), local(10, 11)], JLM);
    expect(counts.get('2026-06-10')).toBe(3);
    expect(counts.size).toBe(1);
  });

  it('is empty for no input', () => {
    expect(bucketByLocalDay([], JLM).size).toBe(0);
  });
});

describe('hasCapacityOn', () => {
  it('compares the day count against the cap', () => {
    const counts = bucketByLocalDay([local(10, 9), local(10, 10)], JLM);
    expect(hasCapacityOn(local(10, 15), counts, 3, JLM)).toBe(true);
    expect(hasCapacityOn(local(10, 15), counts, 2, JLM)).toBe(false);
    expect(hasCapacityOn(local(10, 15), counts, 1, JLM)).toBe(false);
    // A day with nothing scheduled always has room.
    expect(hasCapacityOn(local(11, 15), counts, 2, JLM)).toBe(true);
  });

  it('has no capacity at all when the cap is zero or negative', () => {
    const empty = bucketByLocalDay([], JLM);
    expect(hasCapacityOn(local(10, 15), empty, 0, JLM)).toBe(false);
    expect(hasCapacityOn(local(10, 15), empty, -1, JLM)).toBe(false);
  });
});

describe('nextInstantWithCapacity', () => {
  it('returns the instant unchanged when its day has room', () => {
    const at = local(10, 15);
    const counts = bucketByLocalDay([local(10, 9)], JLM);
    expect(nextInstantWithCapacity(at, counts, 2, JLM)).toBe(at);
  });

  it('jumps to the next local midnight when the day is full', () => {
    const counts = bucketByLocalDay([local(10, 9), local(10, 10)], JLM);
    const result = nextInstantWithCapacity(local(10, 15), counts, 2, JLM);
    expect(result).not.toBeNull();
    expect(zonedParts(result!, JLM)).toMatchObject({ day: 11, hour: 0, minute: 0 });
  });

  it('skips past several consecutive full days', () => {
    const counts = bucketByLocalDay(
      [local(10, 9), local(10, 10), local(11, 9), local(11, 10), local(12, 9), local(12, 10)],
      JLM,
    );
    const result = nextInstantWithCapacity(local(10, 15), counts, 2, JLM);
    expect(zonedParts(result!, JLM)).toMatchObject({ day: 13, hour: 0 });
  });

  it('returns null when the cap forbids reminders outright', () => {
    // Not an error: the user is entitled to ask for none. Callers must say so rather
    // than scheduling anyway.
    expect(nextInstantWithCapacity(local(10, 15), bucketByLocalDay([], JLM), 0, JLM)).toBeNull();
  });
});
