/**
 * Hebrew date and time grammar, written from scratch.
 *
 * `chrono-node` supports en, ja, fr, nl, ru and uk fully and de, pt and zh.hant partially.
 * There is no Hebrew locale and no adapter that adds one, so this is the only way the app
 * parses Hebrew at all.
 *
 * Three things make Hebrew harder than plugging in another locale:
 *
 * - **Particles bind to the word.** "on Tuesday" is one token, and so is "at eight". Patterns
 *   have to allow an optional leading particle everywhere a word can appear.
 * - **`\b` does not work.** JavaScript word boundaries are defined on `[A-Za-z0-9_]`, so `\b`
 *   next to a Hebrew letter matches in the middle of a word. Lookarounds on the Hebrew letter
 *   range are used instead, via `edges()`.
 * - **Hours are spelled out, in the feminine.** "eight thirty" is written as two words meaning
 *   "eight and a half", and "quarter to nine" inverts the hour.
 *
 * Everything here is offline and deterministic. No network, no API key.
 */

import type { EpochMs } from '../db/schema';
import { zonedParts, zonedWallClockToEpoch, type ZonedParts } from '../engine/time';
import { detectDayPartHint, matchDayPart, resolveHour } from './hour';
import {
  DAY_PART_HOURS,
  DEFAULT_EVENT_MINUTES,
  noMatch,
  type ParseOptions,
  type ParseResult,
  type ParseSignals,
} from './types';

// ---------------------------------------------------------------- lexicon

/** Sunday-first, matching `Date` semantics: Sunday is day 0 and the Hebrew "first day". */
const WEEKDAYS: ReadonlyArray<readonly [RegExp, number]> = [
  [/(?:יום\s+)?ראשון/, 0],
  [/(?:יום\s+)?שני/, 1],
  [/(?:יום\s+)?שלישי/, 2],
  [/(?:יום\s+)?רביעי/, 3],
  [/(?:יום\s+)?חמישי/, 4],
  [/(?:יום\s+)?שישי/, 5],
  [/שבת/, 6],
  // Abbreviated forms. The geresh is optional because keyboards often omit it, and it is
  // normalised to a straight apostrophe before matching.
  [/יום\s+א'?/, 0],
  [/יום\s+ב'?/, 1],
  [/יום\s+ג'?/, 2],
  [/יום\s+ד'?/, 3],
  [/יום\s+ה'?/, 4],
  [/יום\s+ו'?/, 5],
  [/יום\s+ש'?/, 6],
];

const MONTHS: ReadonlyArray<readonly [RegExp, number]> = [
  [/ינואר/, 1],
  [/פברואר/, 2],
  [/מרץ|מרס/, 3],
  [/אפריל/, 4],
  [/מאי/, 5],
  [/יוני/, 6],
  [/יולי/, 7],
  [/אוגוסט/, 8],
  [/ספטמבר/, 9],
  [/אוקטובר/, 10],
  [/נובמבר/, 11],
  [/דצמבר/, 12],
];

/** Feminine numerals, which is the form used for telling the time. */
const SPELLED_HOURS: ReadonlyArray<readonly [string, number]> = [
  // Longest first: "one o'clock" is a prefix of "eleven".
  ['אחת עשרה', 11],
  ['שתים עשרה', 12],
  ['שתיים עשרה', 12],
  ['אחת', 1],
  ['שתיים', 2],
  ['שתים', 2],
  ['שלוש', 3],
  ['ארבע', 4],
  ['חמש', 5],
  ['שש', 6],
  ['שבע', 7],
  ['שמונה', 8],
  ['תשע', 9],
  ['עשר', 10],
];

// ---------------------------------------------------------------- helpers

/**
 * Wraps a pattern so it cannot match inside a longer Hebrew word.
 *
 * `\b` is useless here: it is defined in terms of `[A-Za-z0-9_]`, so between two Hebrew letters
 * it reports a boundary. These lookarounds check the Hebrew letter range directly. A leading
 * particle is allowed because in Hebrew it is part of the same token.
 */
function edges(source: string, { allowPrefix = true } = {}): RegExp {
  const prefix = allowPrefix ? '[בלכמהוש]?-?' : '';
  return new RegExp(`(?<![א-ת])${prefix}(?:${source})(?![א-ת])`);
}

interface Match<T> {
  value: T;
  start: number;
  end: number;
}

function find<T>(text: string, pattern: RegExp, value: T): Match<T> | null {
  const found = pattern.exec(text);
  if (!found) return null;
  return { value, start: found.index, end: found.index + found[0].length };
}

/** Normalises the spellings that vary by keyboard, so patterns can assume one form. */
export function normalizeHebrew(text: string): string {
  return (
    text
      .normalize('NFC')
      // Maqaf and the punctuation marks are replaced *before* the niqqud strip, not after: the
      // combining-mark range abuts them, and stripping first deletes the hyphen outright
      // instead of converting it, silently joining "on-15" into "on15".
      .replace(/־/g, '-')
      .replace(/[׳’]/g, "'")
      .replace(/[״”]/g, '"')
      // Niqqud and cantillation.
      .replace(/[֑-ׇֽֿׁׂׅׄ]/g, '')
  );
}

function addDays(parts: ZonedParts, days: number): ZonedParts {
  // UTC has no DST, so it is a safe calendar for the arithmetic.
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day) + days * 86_400_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: parts.hour,
    minute: parts.minute,
  };
}

function weekdayOf(parts: ZonedParts): number {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

// ---------------------------------------------------------------- date matchers

interface DateMatch {
  /** Calendar date, with hour/minute left at the reference's values. */
  date: ZonedParts;
}

function matchRelativeDay(text: string, today: ZonedParts): Match<DateMatch> | null {
  const table: ReadonlyArray<readonly [string, number]> = [
    ['מחרתיים', 2],
    ['מחר', 1],
    ['היום', 0],
  ];
  for (const [word, offset] of table) {
    const match = find(text, edges(word), { date: addDays(today, offset) });
    if (match) return match;
  }
  return null;
}

/**
 * Named weekdays. Resolves to the next such day, 1–7 days out.
 *
 * Never today: someone writing "on Tuesday" on a Tuesday means the next one. "ha-ba" (next) and
 * "ha-karov" (this coming) are accepted and treated identically, since in practice both are
 * used for the same thing.
 */
function matchWeekday(text: string, today: ZonedParts): Match<DateMatch> | null {
  for (const [pattern, target] of WEEKDAYS) {
    const withQualifier = new RegExp(`${pattern.source}(?:\\s+(?:הבא|הקרוב|הבאה|הקרובה))?`);
    const found = edges(withQualifier.source).exec(text);
    if (!found) continue;

    const current = weekdayOf(today);
    const offset = ((target - current + 7) % 7) || 7;
    return {
      value: { date: addDays(today, offset) },
      start: found.index,
      end: found.index + found[0].length,
    };
  }
  return null;
}

/** "be-od X yamim/shavuot/chodashim" — in X days/weeks/months. Also the bare "in a week". */
function matchInDuration(text: string, today: ZonedParts): Match<DateMatch> | null {
  const pattern =
    /(?<![א-ת])בעוד\s+(?:(\d+)\s+)?(ימים|יום|שבועות|שבוע|חודשים|חודש)(?![א-ת])/;
  const found = pattern.exec(text);
  if (!found) return null;

  const count = found[1] ? Number(found[1]) : 1;
  const unit = found[2]!;
  const days = unit.startsWith('שבוע') ? count * 7 : unit.startsWith('חודש') ? count * 30 : count;

  return {
    value: { date: addDays(today, days) },
    start: found.index,
    end: found.index + found[0].length,
  };
}

/** "15 be-August", with or without the leading particle on the number. */
function matchExplicitDate(text: string, today: ZonedParts): Match<DateMatch> | null {
  for (const [monthPattern, month] of MONTHS) {
    const pattern = new RegExp(
      `(?<![א-ת\\d])[בל]?-?(\\d{1,2})\\s+ב?(?:${monthPattern.source})(?![א-ת])`,
    );
    const found = pattern.exec(text);
    if (!found) continue;

    const day = Number(found[1]);
    if (day < 1 || day > 31) continue;

    // No year is given, so assume the coming occurrence rather than one in the past.
    let year = today.year;
    const isPast =
      month < today.month || (month === today.month && day < today.day);
    if (isPast) year += 1;

    return {
      value: { date: { year, month, day, hour: today.hour, minute: today.minute } },
      start: found.index,
      end: found.index + found[0].length,
    };
  }
  return null;
}

// ---------------------------------------------------------------- time matchers

interface TimeMatch {
  hour: number;
  minute: number;
}

/** Digits, e.g. "at 8:30" or "at 20:30", with an optional particle or "at the hour of". */
function matchDigitalTime(text: string): Match<TimeMatch> | null {
  const pattern = /(?<![א-ת\d])(?:בשעה\s+)?[ב]?-?(\d{1,2}):(\d{2})(?![\d])/;
  const found = pattern.exec(text);
  if (!found) return null;

  const hour = Number(found[1]);
  const minute = Number(found[2]);
  if (hour > 23 || minute > 59) return null;
  return { value: { hour, minute }, start: found.index, end: found.index + found[0].length };
}

/** A bare hour as digits, e.g. "at 8". Deliberately tried after the digital form. */
function matchBareHour(text: string): Match<TimeMatch> | null {
  const pattern = /(?<![א-ת\d])(?:בשעה\s+)?ב-?(\d{1,2})(?![\d:])/;
  const found = pattern.exec(text);
  if (!found) return null;

  const hour = Number(found[1]);
  if (hour > 23) return null;
  return { value: { hour, minute: 0 }, start: found.index, end: found.index + found[0].length };
}

/**
 * Hours spelled out, including the two idioms that shift the minutes:
 * "<hour> and a half" (:30), "<hour> and a quarter" (:15), "a quarter to <hour>" (:45 of the
 * hour before).
 */
function matchSpelledTime(text: string): Match<TimeMatch> | null {
  // "quarter to <hour>" first: it names the *following* hour, so matching the hour alone
  // would silently drop the inversion.
  for (const [word, hour] of SPELLED_HOURS) {
    const pattern = new RegExp(`(?<![א-ת])רבע\\s+ל[־-]?${word}(?![א-ת])`);
    const found = pattern.exec(text);
    if (found) {
      const previous = ((hour + 11 - 1) % 12) + 1;
      return {
        value: { hour: previous, minute: 45 },
        start: found.index,
        end: found.index + found[0].length,
      };
    }
  }
  // "quarter to <digits>"
  const toDigits = /(?<![א-ת])רבע\s+ל[־-]?(\d{1,2})(?![\d])/.exec(text);
  if (toDigits) {
    const hour = Number(toDigits[1]);
    const previous = ((hour + 11 - 1) % 12) + 1;
    return {
      value: { hour: previous, minute: 45 },
      start: toDigits.index,
      end: toDigits.index + toDigits[0].length,
    };
  }

  for (const [word, hour] of SPELLED_HOURS) {
    const pattern = new RegExp(
      `(?<![א-ת])(?:בשעה\\s+)?[בל]?${word}(?:\\s+(וחצי|ורבע))?(?![א-ת])`,
    );
    const found = pattern.exec(text);
    if (!found) continue;

    const minute = found[1] === 'וחצי' ? 30 : found[1] === 'ורבע' ? 15 : 0;
    return { value: { hour, minute }, start: found.index, end: found.index + found[0].length };
  }
  return null;
}

// ---------------------------------------------------------------- assembly

/**
 * Blanks a span while preserving every other character's index.
 *
 * Used to hide the date expression from the time matchers. Without it, "on the 15th of August"
 * has its *day number* read as an hour — the bare-hour pattern matches "b-15" quite happily,
 * and the result is a 15:00 event instead of an all-day one.
 */
function mask(text: string, spans: ReadonlyArray<[number, number]>): string {
  const chars = [...text];
  for (const [start, end] of spans) {
    for (let i = start; i < end && i < chars.length; i++) chars[i] = ' ';
  }
  return chars.join('');
}

/**
 * Strips matched spans and tidies what is left into a title.
 *
 * Note what is *not* done here: no word is removed by name. An earlier version stripped a list
 * of particles and connectors to tidy the seam, which also deleted "with" and "of" from the
 * middle of perfectly good titles. Since `edges()` already folds the leading particle into each
 * matched span, the seam needs nothing beyond whitespace collapsing.
 */
function buildTitle(original: string, spans: ReadonlyArray<[number, number]>): string {
  let result = '';
  let cursor = 0;
  for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0])) {
    if (start > cursor) result += original.slice(cursor, start);
    cursor = Math.max(cursor, end);
  }
  result += original.slice(cursor);

  return result
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.\-–—]+|[\s,.\-–—]+$/g, '')
    .trim();
}

/**
 * Parses a Hebrew capture into an Event proposal.
 *
 * Returns `noMatch` when no date expression is recognised, which is the common case for a plain
 * note and is not a failure — capture is never blocked on parsing.
 */
export function parseHebrew(text: string, options: ParseOptions): ParseResult {
  const normalized = normalizeHebrew(text);
  const today = zonedParts(options.reference, options.timezone);

  const dateMatchers = [matchRelativeDay, matchInDuration, matchExplicitDate, matchWeekday];
  const dateMatches = dateMatchers
    .map((matcher) => matcher(normalized, today))
    .filter((match): match is Match<DateMatch> => match !== null);

  // Time matchers run against text with the date spans blanked out, so a day-of-month cannot be
  // mistaken for an hour. Indices are preserved, so the spans they report still line up.
  const withoutDates = mask(
    normalized,
    dateMatches.map((match): [number, number] => [match.start, match.end]),
  );
  const timeMatch =
    matchDigitalTime(withoutDates) ??
    matchSpelledTime(withoutDates) ??
    matchBareHour(withoutDates);

  const dateMatch = dateMatches[0];
  if (!dateMatch && !timeMatch) return noMatch('he');

  const dayPartMatch = matchDayPart(normalized);
  const dayPart = dayPartMatch?.part ?? null;
  const hint = detectDayPartHint(normalized);

  // With no date, "at 8" means today — or tomorrow, if today's 8 has already gone.
  const baseDate = dateMatch ? dateMatch.value.date : today;

  let hour: number;
  let minute: number;
  let ambiguous = false;
  let usedDayPartOnly = false;

  if (timeMatch) {
    const resolved = resolveHour({ hour: timeMatch.value.hour, dayPart, hint });
    hour = resolved.hour;
    minute = timeMatch.value.minute;
    ambiguous = resolved.ambiguous;
  } else if (dayPart) {
    hour = DAY_PART_HOURS[dayPart];
    minute = 0;
    usedDayPartOnly = true;
  } else {
    // A date with no time at all: an all-day event rather than an invented hour.
    hour = 0;
    minute = 0;
  }

  const isAllDay = !timeMatch && !dayPart;
  const spans: Array<[number, number]> = [];
  if (dateMatch) spans.push([dateMatch.start, dateMatch.end]);
  if (timeMatch) spans.push([timeMatch.start, timeMatch.end]);
  // The day-part phrase is scheduling information, not subject matter, so it leaves the title.
  if (dayPartMatch) spans.push([dayPartMatch.start, dayPartMatch.end]);

  let startAt: EpochMs = zonedWallClockToEpoch(
    { ...baseDate, hour, minute },
    options.timezone,
  );

  // "at 8" with no day, already past today, means tomorrow.
  if (!dateMatch && startAt <= options.reference) {
    startAt = zonedWallClockToEpoch(
      { ...addDays(baseDate, 1), hour, minute },
      options.timezone,
    );
  }

  const title = buildTitle(text, spans);
  const signals: ParseSignals = {
    hasExplicitTime: timeMatch !== null,
    hasExplicitDate: dateMatch !== undefined,
    timeIsAmbiguous: ambiguous,
    usedDayPartOnly,
    candidateCount: dateMatches.length,
    hasTitle: title.length > 0,
    resolvedInPast: startAt < options.reference,
  };

  return {
    event: {
      title,
      startAt,
      endAt: isAllDay
        ? zonedWallClockToEpoch({ ...addDays(baseDate, 1), hour: 0, minute: 0 }, options.timezone)
        : startAt + DEFAULT_EVENT_MINUTES * 60_000,
      isAllDay,
      timezone: options.timezone,
    },
    confidence: 0, // filled in by the caller, which owns the scoring
    signals,
    matchedText: spans.length
      ? normalized.slice(
          Math.min(...spans.map((s) => s[0])),
          Math.max(...spans.map((s) => s[1])),
        )
      : null,
    language: 'he',
  };
}
