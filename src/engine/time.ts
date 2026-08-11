/**
 * Timezone-aware wall-clock arithmetic, built on `Intl` alone.
 *
 * Quiet hours and the daily cap are both defined in *local wall-clock* terms ("silent
 * after 22:00", "six reminders per day"), while everything stored is a UTC instant. That
 * conversion is the only genuinely hard part of scheduling, so it lives here, is pure,
 * and is tested against real DST transitions.
 *
 * No date library: `Intl.DateTimeFormat` already carries the full IANA database, and the
 * inverse mapping is ~20 lines. Adding luxon to a PWA whose selling point is fast launch
 * would be a poor trade.
 */

import type { EpochMs, HHmm, IanaTz } from '../db/schema';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
export const MINUTES_PER_DAY = 1440;

/** A wall-clock reading, with `month` 1-based because that is how humans write dates. */
export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/**
 * `Intl.DateTimeFormat` construction is expensive relative to formatting, and the
 * scheduler formats in tight loops, so instances are cached per zone.
 */
const formatterCache = new Map<IanaTz, Intl.DateTimeFormat>();

function formatterFor(tz: IanaTz): Intl.DateTimeFormat {
  const cached = formatterCache.get(tz);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    // h23 rather than hour12:false — the latter can yield hour "24" on some ICU builds.
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  formatterCache.set(tz, created);
  return created;
}

/** Reads the wall clock in `tz` at a given instant. */
export function zonedParts(at: EpochMs, tz: IanaTz): ZonedParts {
  const parts = formatterFor(tz).formatToParts(new Date(at));
  let year = 0;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  for (const { type, value } of parts) {
    switch (type) {
      case 'year':
        year = Number(value);
        break;
      case 'month':
        month = Number(value);
        break;
      case 'day':
        day = Number(value);
        break;
      case 'hour':
        hour = Number(value);
        break;
      case 'minute':
        minute = Number(value);
        break;
      default:
        break;
    }
  }
  return { year, month, day, hour, minute };
}

/** Reinterprets a wall-clock reading as though it were UTC. Not an instant — a yardstick. */
function asPseudoUtc(parts: ZonedParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
}

/** Milliseconds to add to UTC to get local time in `tz` at that instant. */
function offsetMsAt(at: EpochMs, tz: IanaTz): number {
  return asPseudoUtc(zonedParts(at, tz)) - at;
}

/**
 * The instant at which `tz`'s wall clock reads `parts`.
 *
 * The offset depends on the instant, and the instant is what we are solving for, so this
 * iterates. Two DST cases have no single right answer and are resolved to match
 * `Temporal`'s `compatible` disambiguation:
 *
 * - **Ambiguous** (clocks went back; the wall time happens twice) → the *earlier* instant.
 * - **Nonexistent** (clocks went forward; the wall time is skipped) → shifted *forward*
 *   past the gap, so asking for 02:30 on a spring-forward morning yields 03:30.
 */
export function zonedWallClockToEpoch(parts: ZonedParts, tz: IanaTz): EpochMs {
  const wall = asPseudoUtc(parts);

  const offset1 = offsetMsAt(wall, tz);
  const candidate1 = wall - offset1;
  const offset2 = offsetMsAt(candidate1, tz);
  if (offset1 === offset2) return candidate1;

  const candidate2 = wall - offset2;
  const offset3 = offsetMsAt(candidate2, tz);
  if (offset2 === offset3) return candidate2;

  // Neither offset is self-consistent: the requested wall clock does not exist.
  return Math.max(candidate1, candidate2);
}

/** Minutes since local midnight, 0..1439. */
export function minutesOfDay(at: EpochMs, tz: IanaTz): number {
  const { hour, minute } = zonedParts(at, tz);
  return hour * 60 + minute;
}

/**
 * Local calendar date as `YYYY-MM-DD`. Used as the daily-cap bucket key: string equality
 * on this is what "the same day" means, and it stays correct across DST and across
 * zones with non-hour offsets.
 */
export function localDayKey(at: EpochMs, tz: IanaTz): string {
  const { year, month, day } = zonedParts(at, tz);
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day
    .toString()
    .padStart(2, '0')}`;
}

/** The instant at which the local clock next reads `minutes` past midnight, on `at`'s day. */
export function atLocalMinutesOnDayOf(at: EpochMs, tz: IanaTz, minutes: number): EpochMs {
  const { year, month, day } = zonedParts(at, tz);
  return zonedWallClockToEpoch(
    {
      year,
      month,
      day,
      hour: Math.floor(minutes / 60),
      minute: minutes % 60,
    },
    tz,
  );
}

/**
 * Local midnight following `at`.
 *
 * The day is advanced on the calendar rather than by adding 24 hours: on a DST boundary a
 * local day is 23 or 25 hours long, and adding `DAY_MS` would land on the wrong date.
 */
export function startOfNextLocalDay(at: EpochMs, tz: IanaTz): EpochMs {
  const { year, month, day } = zonedParts(at, tz);
  // UTC has no DST, so it is a safe calendar to do the +1 day rollover in.
  const next = new Date(Date.UTC(year, month - 1, day) + DAY_MS);
  return zonedWallClockToEpoch(
    {
      year: next.getUTCFullYear(),
      month: next.getUTCMonth() + 1,
      day: next.getUTCDate(),
      hour: 0,
      minute: 0,
    },
    tz,
  );
}

const HHMM_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Parses `HH:mm` into minutes since midnight, or `null` if malformed.
 *
 * Returns null rather than throwing because this parses persisted user settings, which a
 * hand-edited JSON import can corrupt. A bad quiet-hours value must degrade to "no quiet
 * hours", never crash the scheduler and lose the reminder.
 */
export function parseHHmm(value: HHmm): number | null {
  const match = HHMM_PATTERN.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}
