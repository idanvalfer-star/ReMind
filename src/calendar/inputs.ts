/**
 * Conversion between epoch instants and the strings `<input type="datetime-local">` speaks.
 *
 * A `datetime-local` value has no timezone — it is a bare wall clock. The browser interprets it in
 * the *host* zone, which is not necessarily the zone the event belongs to, so neither
 * `new Date(value)` nor `toISOString().slice(0,16)` is correct here. Both are the standard way to
 * get this wrong.
 */

import type { EpochMs, IanaTz } from '../db/schema';
import { zonedParts, zonedWallClockToEpoch } from '../engine/time';

const pad = (value: number, width = 2) => value.toString().padStart(width, '0');

/** `YYYY-MM-DDTHH:mm` reading of an instant in the given zone. */
export function toDateTimeInput(at: EpochMs, timezone: IanaTz): string {
  const { year, month, day, hour, minute } = zonedParts(at, timezone);
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`;
}

/** `YYYY-MM-DD` reading of an instant in the given zone, for all-day events. */
export function toDateInput(at: EpochMs, timezone: IanaTz): string {
  const { year, month, day } = zonedParts(at, timezone);
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Interprets an input value as a wall clock in `timezone`.
 *
 * Returns null for anything malformed rather than throwing: these values come straight from a form
 * field, and a partially typed date is a normal transient state, not an error.
 */
export function fromDateTimeInput(value: string, timezone: IanaTz): EpochMs | null {
  const withTime = DATE_TIME.exec(value);
  if (withTime) {
    return zonedWallClockToEpoch(
      {
        year: Number(withTime[1]),
        month: Number(withTime[2]),
        day: Number(withTime[3]),
        hour: Number(withTime[4]),
        minute: Number(withTime[5]),
      },
      timezone,
    );
  }

  const dateOnly = DATE_ONLY.exec(value);
  if (dateOnly) {
    return zonedWallClockToEpoch(
      {
        year: Number(dateOnly[1]),
        month: Number(dateOnly[2]),
        day: Number(dateOnly[3]),
        hour: 0,
        minute: 0,
      },
      timezone,
    );
  }

  return null;
}
