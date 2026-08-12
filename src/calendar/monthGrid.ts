/**
 * Month grid geometry.
 *
 * Pure, and separated from rendering because every interesting bug in a calendar lives here:
 * the week a month starts on, the leading and trailing days that belong to neighbouring months,
 * and days that are 23 or 25 hours long. All of that is testable without a DOM.
 *
 * Day boundaries are computed in the user's zone via the calendar, never by adding 24 hours —
 * on a DST boundary that lands on the wrong date.
 */

import type { EpochMs, IanaTz } from '../db/schema';
import { localDayKey, startOfNextLocalDay, zonedParts, zonedWallClockToEpoch } from '../engine/time';

/** 0 = Sunday. Israel and the US start the week on Sunday; much of Europe does not. */
export type WeekStart = 0 | 1;

export interface CalendarDay {
  /** `YYYY-MM-DD` in the user's zone. Matches the keys used by the daily cap. */
  key: string;
  /** Local midnight opening the day. */
  startAt: EpochMs;
  /** Local midnight opening the *next* day, so `[startAt, endAt)` is the whole day. */
  endAt: EpochMs;
  dayOfMonth: number;
  /** False for the leading and trailing days borrowed from neighbouring months. */
  inMonth: boolean;
  isToday: boolean;
  /** 0 = Sunday. */
  weekday: number;
}

/**
 * Six weeks of days covering the given month.
 *
 * Always 42 cells, never a ragged grid: a month can span six calendar weeks, and a layout that
 * changes height between months is visibly unstable to scroll through.
 */
export function monthGrid(
  year: number,
  month: number,
  timezone: IanaTz,
  now: EpochMs,
  weekStart: WeekStart = 0,
): CalendarDay[] {
  const firstOfMonth = zonedWallClockToEpoch({ year, month, day: 1, hour: 0, minute: 0 }, timezone);
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();

  // How many days of the previous month to show before the 1st.
  const lead = (firstWeekday - weekStart + 7) % 7;

  const todayKey = localDayKey(now, timezone);
  const days: CalendarDay[] = [];

  // Walk back from the 1st using the calendar, then forward 42 days.
  let cursor = firstOfMonth;
  for (let i = 0; i < lead; i++) {
    const parts = zonedParts(cursor, timezone);
    const previous = new Date(Date.UTC(parts.year, parts.month - 1, parts.day) - 86_400_000);
    cursor = zonedWallClockToEpoch(
      {
        year: previous.getUTCFullYear(),
        month: previous.getUTCMonth() + 1,
        day: previous.getUTCDate(),
        hour: 0,
        minute: 0,
      },
      timezone,
    );
  }

  for (let i = 0; i < 42; i++) {
    const parts = zonedParts(cursor, timezone);
    const endAt = startOfNextLocalDay(cursor, timezone);
    const key = localDayKey(cursor, timezone);
    days.push({
      key,
      startAt: cursor,
      endAt,
      dayOfMonth: parts.day,
      inMonth: parts.year === year && parts.month === month,
      isToday: key === todayKey,
      weekday: new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay(),
    });
    cursor = endAt;
  }

  return days;
}

/** Month shown after this one, rolling the year over. */
export function nextMonth(year: number, month: number): { year: number; month: number } {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

export function previousMonth(year: number, month: number): { year: number; month: number } {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

/** Weekday column headers, localised, ordered to match the grid. */
export function weekdayLabels(locale: string, weekStart: WeekStart = 0): string[] {
  const formatter = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
  // 2026-06-07 was a Sunday, so it anchors the sequence without needing a lookup.
  const sundayEpoch = Date.UTC(2026, 5, 7);
  return Array.from({ length: 7 }, (_, i) =>
    formatter.format(new Date(sundayEpoch + ((i + weekStart) % 7) * 86_400_000)),
  );
}

/**
 * The seven days of the week containing `now`.
 *
 * Shares `CalendarDay` with the month grid so the week strip and the month view agree on what a day
 * is — same keys, same local-midnight boundaries, same `isToday`.
 */
export function weekDays(
  timezone: IanaTz,
  now: EpochMs,
  weekStart: WeekStart = 0,
): CalendarDay[] {
  const parts = zonedParts(now, timezone);
  const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  const back = (weekday - weekStart + 7) % 7;

  // Step back on the calendar rather than by subtracting hours: a local day is 23 or 25 hours long
  // across a DST boundary.
  let cursor = zonedWallClockToEpoch({ ...parts, hour: 0, minute: 0 }, timezone);
  for (let i = 0; i < back; i++) {
    const at = zonedParts(cursor, timezone);
    const previous = new Date(Date.UTC(at.year, at.month - 1, at.day) - 86_400_000);
    cursor = zonedWallClockToEpoch(
      {
        year: previous.getUTCFullYear(),
        month: previous.getUTCMonth() + 1,
        day: previous.getUTCDate(),
        hour: 0,
        minute: 0,
      },
      timezone,
    );
  }

  const todayKey = localDayKey(now, timezone);
  const days: CalendarDay[] = [];
  for (let i = 0; i < 7; i++) {
    const at = zonedParts(cursor, timezone);
    const endAt = startOfNextLocalDay(cursor, timezone);
    const key = localDayKey(cursor, timezone);
    days.push({
      key,
      startAt: cursor,
      endAt,
      dayOfMonth: at.day,
      inMonth: at.month === parts.month && at.year === parts.year,
      isToday: key === todayKey,
      weekday: new Date(Date.UTC(at.year, at.month - 1, at.day)).getUTCDay(),
    });
    cursor = endAt;
  }
  return days;
}
