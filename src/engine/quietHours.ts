/**
 * Quiet hours.
 *
 * Enforced when a trigger is *registered*, not when it is delivered — the push backend
 * knows only a UUID and a timestamp, so by the time a notification is in flight it is too
 * late to suppress it on policy grounds. Everything here is therefore about choosing a
 * legal `fireAt` up front.
 *
 * The window is a half-open local wall-clock interval `[start, end)` and is allowed to
 * wrap past midnight, which is the normal case (22:00 → 07:00).
 */

import type { EpochMs, IanaTz, QuietHours } from '../db/schema';
import { atLocalMinutesOnDayOf, minutesOfDay, parseHHmm, startOfNextLocalDay } from './time';

/**
 * Whether `at` falls inside the silent window.
 *
 * Degrades to "not quiet" for a disabled, malformed or zero-length window. That direction
 * is deliberate: the failure mode of wrongly allowing a notification is one badly-timed
 * buzz, while the failure mode of wrongly silencing is a reminder that never arrives, and
 * an app that silently drops reminders is worthless.
 */
export function isQuiet(at: EpochMs, quietHours: QuietHours, tz: IanaTz): boolean {
  if (!quietHours.enabled) return false;

  const start = parseHHmm(quietHours.start);
  const end = parseHHmm(quietHours.end);
  if (start === null || end === null) return false;
  // "22:00 to 22:00" could mean 24 hours of silence, but reading it that way makes
  // scheduling impossible, so it means no silence at all.
  if (start === end) return false;

  const minutes = minutesOfDay(at, tz);
  return start < end
    ? minutes >= start && minutes < end
    : // Wrapped window: late evening or early morning.
      minutes >= start || minutes < end;
}

/**
 * The first instant at or after `at` that is not silent.
 *
 * Reminders are shifted to the end of the window rather than dropped. The user asked to
 * be reminded; quiet hours are about *when*, not *whether*.
 */
export function nextAllowedInstant(at: EpochMs, quietHours: QuietHours, tz: IanaTz): EpochMs {
  if (!isQuiet(at, quietHours, tz)) return at;

  // `isQuiet` returning true guarantees both ends parsed.
  const end = parseHHmm(quietHours.end);
  if (end === null) return at;

  const endToday = atLocalMinutesOnDayOf(at, tz, end);
  // Already past today: the window opened last evening and closes tomorrow morning.
  if (endToday > at) return endToday;
  return atLocalMinutesOnDayOf(startOfNextLocalDay(at, tz), tz, end);
}
