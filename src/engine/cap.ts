/**
 * The global daily cap.
 *
 * A budget over triggers *scheduled* per local day, checked before registration. The
 * point is not tidiness: an app that resurfaces too eagerly gets its notifications turned
 * off at the OS level, after which it is worth exactly nothing. The cap is the mechanism
 * that keeps that from happening.
 */

import type { EpochMs, IanaTz } from '../db/schema';
import { localDayKey, startOfNextLocalDay } from './time';

/** Scheduled-trigger counts per `YYYY-MM-DD` local day. Days with none are absent. */
export type DayCounts = ReadonlyMap<string, number>;

/**
 * Buckets already-committed fire times by local day.
 *
 * Built once per scheduling decision and passed down, because the alternative — counting
 * a list per candidate day — re-runs `Intl` formatting inside a loop, and the scheduler
 * can walk many days when the calendar is busy.
 */
export function bucketByLocalDay(scheduled: readonly EpochMs[], tz: IanaTz): Map<string, number> {
  const counts = new Map<string, number>();
  for (const at of scheduled) {
    const key = localDayKey(at, tz);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Whether `at`'s local day is still under the cap. */
export function hasCapacityOn(
  at: EpochMs,
  counts: DayCounts,
  dailyCap: number,
  tz: IanaTz,
): boolean {
  if (dailyCap <= 0) return false;
  return (counts.get(localDayKey(at, tz)) ?? 0) < dailyCap;
}

/**
 * The first instant at or after `at` whose local day has room, or `null` if there is
 * none.
 *
 * `null` happens only when the cap is zero or negative — the user asking for no
 * notifications at all. That is a legitimate setting, not an error, so callers must
 * handle it and say so rather than silently scheduling anyway.
 *
 * When a day is full the search jumps to the next local midnight, which will usually land
 * inside quiet hours; resolving that interaction is `resolveFireTime`'s job, not this
 * function's.
 */
export function nextInstantWithCapacity(
  at: EpochMs,
  counts: DayCounts,
  dailyCap: number,
  tz: IanaTz,
): EpochMs | null {
  if (dailyCap <= 0) return null;

  // At most `counts.size` distinct days can be full, so scanning one more than that is
  // guaranteed to reach a day with no scheduled triggers at all.
  const maxDays = counts.size + 1;
  let candidate = at;
  for (let day = 0; day <= maxDays; day++) {
    if (hasCapacityOn(candidate, counts, dailyCap, tz)) return candidate;
    candidate = startOfNextLocalDay(candidate, tz);
  }
  return null;
}
