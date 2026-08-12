import { describe, expect, it } from 'vitest';
import { parseEnglish } from './en';
import { zonedParts, zonedWallClockToEpoch } from '../engine/time';

/**
 * Reference instant throughout: Wednesday 10 June 2026, 12:00 in Jerusalem.
 *
 * The timezone is deliberately not UTC. chrono resolves relative expressions against the host
 * clock, so a suite written in UTC would pass on this machine and be wrong on a phone.
 */
const JLM = 'Asia/Jerusalem';
const REFERENCE = zonedWallClockToEpoch(
  { year: 2026, month: 6, day: 10, hour: 12, minute: 0 },
  JLM,
);
const options = { reference: REFERENCE, timezone: JLM };

function expectStart(text: string, day: number, hour: number, minute = 0, month = 6) {
  const result = parseEnglish(text, options);
  expect(result.event, `no date found in: ${text}`).not.toBeNull();
  expect(zonedParts(result.event!.startAt, JLM), text).toMatchObject({ month, day, hour, minute });
  return result;
}

describe('relative days', () => {
  it('parses tomorrow with an explicit time', () => {
    expectStart('Dinner with Alex tomorrow at 8pm', 11, 20);
  });

  it('parses today and the day after tomorrow', () => {
    expectStart('Standup today at 4pm', 10, 16);
    expectStart('Review the day after tomorrow at 10am', 12, 10);
  });

  it('parses a weekday as the coming one, not one in the past', () => {
    // Reference is Wednesday; "Tuesday" means next week, not yesterday.
    expectStart('Lunch on Tuesday at 1pm', 16, 13);
    expectStart('Dinner next Tuesday at 8pm', 16, 20);
  });
});

describe('hour resolution', () => {
  it('honours an explicit meridiem', () => {
    expectStart('Call mum tomorrow at 8am', 11, 8);
    expectStart('Call mum tomorrow at 8pm', 11, 20);
  });

  it('honours a day-part word over the bare hour', () => {
    expectStart('Meeting tomorrow at 8 in the evening', 11, 20);
    expectStart('Meeting tomorrow at 8 in the morning', 11, 8);
  });

  it('takes an evening hint from the word "dinner"', () => {
    // The case that motivates the whole hint mechanism: a naive parser says 08:00.
    const result = expectStart('Dinner with Alex tomorrow at 8', 11, 20);
    expect(result.signals.timeIsAmbiguous).toBe(false);
  });

  it('takes a morning hint from "breakfast"', () => {
    expectStart('Breakfast tomorrow at 8', 11, 8);
  });

  it('flags a bare hour with no hint as ambiguous', () => {
    const result = parseEnglish('Meeting tomorrow at 3', options);
    expect(result.signals.timeIsAmbiguous).toBe(true);
    // 1-6 read as afternoon.
    expect(zonedParts(result.event!.startAt, JLM)).toMatchObject({ hour: 15 });
  });
});

describe('day parts without a clock time', () => {
  it('picks a representative hour and reports that it did', () => {
    const result = expectStart('Drinks tomorrow evening', 11, 19);
    expect(result.signals.usedDayPartOnly).toBe(true);
    expect(result.signals.hasExplicitTime).toBe(false);
  });
});

describe('all-day events', () => {
  it('treats a date with no time as all-day', () => {
    const result = parseEnglish("Sarah's birthday on 15 August", options);
    expect(result.event!.isAllDay).toBe(true);
    expect(zonedParts(result.event!.startAt, JLM)).toMatchObject({ month: 8, day: 15, hour: 0 });
  });
});

describe('titles', () => {
  it('removes the date expression', () => {
    expect(parseEnglish('Dinner with Alex tomorrow at 8pm', options).event!.title).toBe(
      'Dinner with Alex',
    );
  });

  it('removes a preposition orphaned by the removal', () => {
    expect(parseEnglish('Lunch with Dani on Tuesday', options).event!.title).toBe('Lunch with Dani');
  });

  it('removes the day-part phrase, which is scheduling rather than subject', () => {
    const title = parseEnglish('Drinks tomorrow evening', options).event!.title;
    expect(title).toBe('Drinks');
  });

  it('reports an empty title rather than inventing one', () => {
    const result = parseEnglish('tomorrow at 8pm', options);
    expect(result.event!.title).toBe('');
    expect(result.signals.hasTitle).toBe(false);
  });
});

describe('no date present', () => {
  it('returns no match for a plain note', () => {
    for (const text of ['Buy milk', "Dani's idea about the project", '', '   ']) {
      expect(parseEnglish(text, options).event, text).toBeNull();
    }
  });
});

describe('timezone independence', () => {
  it('resolves against the given zone, not the host clock', () => {
    // 23:00 in Jerusalem on the 10th is still the 10th there, and 20:00 UTC. Parsing the same
    // text for a UTC user must therefore give a different instant for the same wall clock.
    const jlm = parseEnglish('Meeting tomorrow at 11pm', options);
    const utc = parseEnglish('Meeting tomorrow at 11pm', {
      reference: REFERENCE,
      timezone: 'UTC',
    });

    expect(zonedParts(jlm.event!.startAt, JLM)).toMatchObject({ day: 11, hour: 23 });
    expect(zonedParts(utc.event!.startAt, 'UTC')).toMatchObject({ day: 11, hour: 23 });
    // Same wall clock, different instants — three hours apart in June.
    expect(utc.event!.startAt - jlm.event!.startAt).toBe(3 * 3_600_000);
  });
});
