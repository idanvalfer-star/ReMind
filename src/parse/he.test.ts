import { describe, expect, it } from 'vitest';
import { normalizeHebrew, parseHebrew } from './he';
import { zonedParts, zonedWallClockToEpoch } from '../engine/time';

/**
 * Table-driven, and written to be read by a Hebrew speaker rather than by a compiler. If a
 * phrasing you would actually type is missing or resolves wrongly, this is the file to say so
 * in — every case names the input in Hebrew and the wall clock it should produce.
 *
 * Reference instant throughout: Wednesday 10 June 2026, 12:00 in Jerusalem. Weekdays that week:
 * Mon 8th, Tue 9th, Wed 10th, Thu 11th, Fri 12th, Sat 13th, Sun 14th, Mon 15th, Tue 16th.
 */

const JLM = 'Asia/Jerusalem';
const REFERENCE = zonedWallClockToEpoch(
  { year: 2026, month: 6, day: 10, hour: 12, minute: 0 },
  JLM,
);
const options = { reference: REFERENCE, timezone: JLM };

/** Asserts the parsed start lands on a given local wall clock. */
function expectStart(text: string, day: number, hour: number, minute = 0, month = 6) {
  const result = parseHebrew(text, options);
  expect(result.event, `no date found in: ${text}`).not.toBeNull();
  expect(zonedParts(result.event!.startAt, JLM), text).toMatchObject({
    month,
    day,
    hour,
    minute,
  });
  return result;
}

describe('normalizeHebrew', () => {
  it('strips niqqud so pointed input parses the same', () => {
    expect(normalizeHebrew('מָחָר')).toBe('מחר');
  });

  it('normalises geresh, gershayim and maqaf to ASCII', () => {
    expect(normalizeHebrew('יום ג׳')).toBe("יום ג'");
    expect(normalizeHebrew('אחה״צ')).toBe('אחה"צ');
    expect(normalizeHebrew('ב־15')).toBe('ב-15');
  });
});

describe('relative days', () => {
  it('parses today, tomorrow and the day after', () => {
    // No time given, so these are all-day rather than an invented hour.
    expectStart('פגישה היום', 10, 0);
    expectStart('פגישה מחר', 11, 0);
    expectStart('פגישה מחרתיים', 12, 0);
  });

  it('parses tomorrow with a spelled-out hour and a day part', () => {
    // "tomorrow at eight in the evening"
    expectStart('ארוחת ערב מחר בשמונה בערב', 11, 20);
  });

  it('parses tomorrow with a digital time', () => {
    expectStart('פגישה מחר ב-14:30', 11, 14, 30);
  });
});

describe('named weekdays', () => {
  it('resolves to the next occurrence, 1 to 7 days out', () => {
    // Reference is Wednesday the 10th.
    expectStart('פגישה ביום חמישי', 11, 0); // Thursday, in 1 day
    expectStart('פגישה ביום שישי', 12, 0); // Friday, in 2 days
    expectStart('פגישה בשבת', 13, 0); // Saturday, in 3 days
    expectStart('פגישה ביום ראשון', 14, 0); // Sunday, in 4 days
    expectStart('פגישה ביום שני', 15, 0); // Monday, in 5 days
    expectStart('פגישה ביום שלישי', 16, 0); // Tuesday, in 6 days
  });

  it('never resolves to today, even when the weekday matches', () => {
    // Wednesday named on a Wednesday means next Wednesday.
    expectStart('פגישה ביום רביעי', 17, 0);
  });

  it('accepts the "next" and "this coming" qualifiers', () => {
    expectStart('פגישה ביום חמישי הבא', 11, 0);
    expectStart('פגישה ביום חמישי הקרוב', 11, 0);
  });

  it('accepts abbreviated weekdays with and without geresh', () => {
    expectStart('פגישה ביום ה׳', 11, 0);
    expectStart("פגישה ביום ה'", 11, 0);
    expectStart('פגישה ביום א׳', 14, 0);
  });
});

describe('relative durations', () => {
  it('parses "in a week" and "in N days/weeks"', () => {
    expectStart('לבדוק בעוד שבוע', 17, 0);
    expectStart('לבדוק בעוד 3 ימים', 13, 0);
    expectStart('לבדוק בעוד 2 שבועות', 24, 0);
    expectStart('לבדוק בעוד יום', 11, 0);
  });

  it('parses "in a month" as 30 days', () => {
    expectStart('לבדוק בעוד חודש', 10, 0, 0, 7);
  });
});

describe('explicit dates', () => {
  it('parses day-and-month, with or without particles', () => {
    expectStart('טיסה ב-15 באוגוסט', 15, 0, 0, 8);
    expectStart('טיסה 15 באוגוסט', 15, 0, 0, 8);
    expectStart('טיסה ב-15 אוגוסט', 15, 0, 0, 8);
  });

  it('rolls a past month into next year rather than the past', () => {
    // Reference is June 2026, so March means 2027.
    const result = parseHebrew('טיסה ב-3 במרץ', options);
    expect(zonedParts(result.event!.startAt, JLM)).toMatchObject({ year: 2027, month: 3, day: 3 });
  });
});

describe('times', () => {
  it('parses digital times', () => {
    expectStart('פגישה מחר ב-9:15', 11, 9, 15);
    expectStart('פגישה מחר בשעה 20:00', 11, 20, 0);
  });

  it('parses spelled-out hours', () => {
    expectStart('פגישה מחר בשמונה בבוקר', 11, 8);
    expectStart('פגישה מחר בתשע בבוקר', 11, 9);
    expectStart('פגישה מחר בשלוש אחר הצהריים', 11, 15);
  });

  it('parses "half past" and "quarter past"', () => {
    expectStart('פגישה מחר בשמונה וחצי בבוקר', 11, 8, 30);
    expectStart('פגישה מחר בשמונה ורבע בבוקר', 11, 8, 15);
  });

  it('parses "quarter to", which names the following hour', () => {
    // "quarter to nine" is 08:45, not 09:45 — the inversion is the point.
    expectStart('פגישה מחר רבע לתשע בבוקר', 11, 8, 45);
    expectStart('פגישה מחר רבע ל-9 בבוקר', 11, 8, 45);
  });

  it('applies the day part to a bare hour', () => {
    expectStart('פגישה מחר ב-8 בערב', 11, 20);
    expectStart('פגישה מחר ב-8 בבוקר', 11, 8);
    expectStart('פגישה מחר ב-8 בלילה', 11, 20);
  });

  it('takes an evening hint from the meal, not just from a day part', () => {
    // "arukhat erev" contains "erev", so dinner reads as evening without an explicit part.
    expectStart('ארוחת ערב מחר בשמונה', 11, 20);
  });

  it('flags a bare hour with no day part as ambiguous', () => {
    const result = parseHebrew('פגישה מחר בשלוש', options);
    expect(result.signals.timeIsAmbiguous).toBe(true);
    // 1-6 read as afternoon.
    expect(zonedParts(result.event!.startAt, JLM)).toMatchObject({ hour: 15 });
  });

  it('treats a time with no date as today, or tomorrow if it has passed', () => {
    // Reference is 12:00. 15:00 is still ahead...
    expectStart('להתקשר בשלוש', 10, 15);
    // ...but 09:00 has gone, so it means tomorrow.
    expectStart('להתקשר בתשע בבוקר', 11, 9);
  });
});

describe('day parts without a clock time', () => {
  it('picks a representative hour and says it did so', () => {
    const result = expectStart('פגישה מחר בערב', 11, 19);
    expect(result.signals.usedDayPartOnly).toBe(true);
    expect(result.signals.hasExplicitTime).toBe(false);
    expect(result.event!.isAllDay).toBe(false);
  });

  it('handles each day part', () => {
    expectStart('פגישה מחר בבוקר', 11, 9);
    expectStart('פגישה מחר בצהריים', 11, 12);
    expectStart('פגישה מחר בלילה', 11, 21);
  });
});

describe('all-day events', () => {
  it('marks a date with no time at all as all-day, spanning to the next midnight', () => {
    const result = parseHebrew('יום הולדת של שרה ב-15 באוגוסט', options);
    expect(result.event!.isAllDay).toBe(true);
    expect(zonedParts(result.event!.startAt, JLM)).toMatchObject({ hour: 0, minute: 0 });
    expect(zonedParts(result.event!.endAt, JLM)).toMatchObject({ day: 16, hour: 0 });
  });
});

describe('titles', () => {
  it('removes the date expression and leaves the subject', () => {
    expect(parseHebrew('ארוחת ערב עם אלכס מחר בשמונה', options).event!.title).toBe(
      'ארוחת ערב עם אלכס',
    );
  });

  it('does not leave a dangling particle behind', () => {
    const title = parseHebrew('פגישה עם דני ביום חמישי', options).event!.title;
    expect(title).toBe('פגישה עם דני');
    expect(title.endsWith('ב')).toBe(false);
  });

  it('reports an empty title rather than inventing one', () => {
    const result = parseHebrew('מחר בשמונה בערב', options);
    expect(result.event!.title).toBe('');
    expect(result.signals.hasTitle).toBe(false);
  });
});

describe('no date present', () => {
  it('returns no match for a plain note, which is not a failure', () => {
    for (const text of ['לקנות חלב', 'הרעיון של דני לגבי הפרויקט', '']) {
      const result = parseHebrew(text, options);
      expect(result.event, text).toBeNull();
      expect(result.confidence, text).toBe(0);
    }
  });

  it('does not match a date word buried inside a longer word', () => {
    // "makhar" (tomorrow) is a prefix of "makhara" — the lookarounds must reject it.
    const result = parseHebrew('מחרשה בשדה', options);
    expect(result.event).toBeNull();
  });
});
