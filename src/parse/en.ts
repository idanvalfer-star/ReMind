/**
 * English date and time parsing, on top of `chrono-node`.
 *
 * chrono handles the long tail well — "the 15th", "in three weeks", "next Tuesday" — so writing
 * another grammar for English would be waste. Two things are still done here rather than
 * delegated:
 *
 * - **The timezone.** chrono resolves relative expressions against the *host* clock. A Worker or
 *   a phone in another zone would then produce a different answer for the same input. So the
 *   reference is handed over as an explicit UTC wall clock, chrono's component values are read
 *   as wall-clock numbers, and the instant is rebuilt with the app's own timezone maths.
 * - **The hour.** chrono reports whether a meridiem was certain but still fills in a value when
 *   it was not. That guess is discarded in favour of the shared `resolveHour` heuristic, so
 *   "dinner at 8" lands at 20:00 in both languages rather than in whichever one happens to have
 *   the better library.
 */

import * as chrono from 'chrono-node';
import type { EpochMs } from '../db/schema';
import { zonedParts, zonedWallClockToEpoch } from '../engine/time';
import { detectDayPartHint, matchDayPart, resolveHour } from './hour';
import {
  DAY_PART_HOURS,
  DEFAULT_EVENT_MINUTES,
  noMatch,
  type ParseOptions,
  type ParseResult,
  type ParseSignals,
} from './types';

/** Strips the matched span and tidies what remains. */
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
    // A preposition orphaned by removing the date it governed — "dinner on <removed>".
    .replace(/\s+(?:on|at|in|by)\s*$/i, '')
    .replace(/^[\s,.\-–—]+|[\s,.\-–—]+$/g, '')
    .trim();
}

export function parseEnglish(text: string, options: ParseOptions): ParseResult {
  if (!text.trim()) return noMatch('en');

  // The reference is expressed as a UTC instant whose fields *are* the target zone's wall
  // clock, and chrono is told the zone is UTC. Its output components are then plain wall-clock
  // numbers, independent of wherever this happens to be running.
  const wall = zonedParts(options.reference, options.timezone);
  const results = chrono.en.parse(
    text,
    {
      instant: new Date(Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute)),
      timezone: 0,
    },
    // A capture is almost always about the future; "Tuesday" said on Wednesday means next week.
    { forwardDate: true },
  );

  const best = results[0];
  if (!best) return noMatch('en');

  const dayPartMatch = matchDayPart(text);
  const hint = detectDayPartHint(text);

  const hasExplicitTime = best.start.isCertain('hour');
  const hasExplicitDate =
    best.start.isCertain('day') || best.start.isCertain('weekday') || best.start.isCertain('month');

  const parsedHour = best.start.get('hour') ?? 0;
  const meridiemCertain = best.start.isCertain('meridiem');

  let hour: number;
  let minute: number;
  let ambiguous = false;
  let usedDayPartOnly = false;

  if (hasExplicitTime) {
    const resolved = resolveHour({
      hour: parsedHour,
      // Trust chrono only when it says the meridiem was explicit in the text.
      meridiem: meridiemCertain ? (parsedHour >= 12 ? 'pm' : 'am') : undefined,
      dayPart: dayPartMatch?.part ?? null,
      hint,
    });
    hour = resolved.hour;
    minute = best.start.get('minute') ?? 0;
    ambiguous = resolved.ambiguous;
  } else if (dayPartMatch) {
    hour = DAY_PART_HOURS[dayPartMatch.part];
    minute = 0;
    usedDayPartOnly = true;
  } else {
    hour = 0;
    minute = 0;
  }

  const isAllDay = !hasExplicitTime && !dayPartMatch;

  const startAt: EpochMs = zonedWallClockToEpoch(
    {
      year: best.start.get('year') ?? wall.year,
      month: best.start.get('month') ?? wall.month,
      day: best.start.get('day') ?? wall.day,
      hour,
      minute,
    },
    options.timezone,
  );

  const spans: Array<[number, number]> = [[best.index, best.index + best.text.length]];
  if (dayPartMatch) spans.push([dayPartMatch.start, dayPartMatch.end]);

  // chrono can report an explicit end ("2 to 4pm"); otherwise a default duration applies.
  const endAt = best.end
    ? zonedWallClockToEpoch(
        {
          year: best.end.get('year') ?? wall.year,
          month: best.end.get('month') ?? wall.month,
          day: best.end.get('day') ?? wall.day,
          hour: best.end.get('hour') ?? hour,
          minute: best.end.get('minute') ?? minute,
        },
        options.timezone,
      )
    : isAllDay
      ? startAt + 86_400_000
      : startAt + DEFAULT_EVENT_MINUTES * 60_000;

  const title = buildTitle(text, spans);
  const signals: ParseSignals = {
    hasExplicitTime,
    hasExplicitDate,
    timeIsAmbiguous: ambiguous,
    usedDayPartOnly,
    candidateCount: results.length,
    hasTitle: title.length > 0,
    resolvedInPast: startAt < options.reference,
  };

  return {
    event: { title, startAt, endAt, isAllDay, timezone: options.timezone },
    confidence: 0, // the caller owns scoring
    signals,
    matchedText: best.text,
    language: 'en',
  };
}
