/**
 * When a `cadence` trigger wants to fire.
 *
 * A cadence is not a moment the way an event is. "Check in with Sarah every three weeks"
 * names an interval, not a time, so the rule has to supply the hour itself — see
 * `atMinuteOfDay` on the condition. Left to inherit whatever minute the person happened to
 * be added at, a cadence reminder would be suppressed outright whenever that minute fell
 * inside quiet hours, and the user would have no way to tell why some people get nudges and
 * others silently don't.
 *
 * Pure and clock-injected, because every interesting case here is about the relationship
 * between the anchor, the preferred hour and *now*.
 */

import type { EpochMs, IanaTz, Person } from '../db/schema';
import { atLocalMinutesOnDayOf, DAY_MS, startOfNextLocalDay } from './time';

/**
 * 09:00 local. Early enough to act on during the day, late enough not to be the first thing
 * on a phone at breakfast, and outside the default 22:00–07:00 quiet window.
 */
export const DEFAULT_CADENCE_MINUTE_OF_DAY = 9 * 60;

/** Below this a "cadence" is really a daily task, and the People module is the wrong home. */
export const MIN_CADENCE_DAYS = 1;

export interface CadenceRule {
  days: number;
  atMinuteOfDay: number;
  timezone: IanaTz;
}

/**
 * The instant a cadence next wants to fire, or `null` when the person is gone.
 *
 * The anchor is the last real interaction, falling back to when the person was added — a
 * cadence set on someone never yet contacted still has to start counting from something, and
 * "when you decided to keep in touch" is the only honest choice available.
 *
 * An **overdue** cadence deliberately does not resume on the original grid. If the last
 * interaction was two months ago on a three-week cadence, the answer is today or tomorrow,
 * not the next multiple of 21 days — the point of the reminder is that contact has lapsed,
 * and the lapse is the thing to act on now.
 */
export function cadenceFireAt(
  rule: CadenceRule,
  person: Person | undefined,
  now: EpochMs,
): EpochMs | null {
  if (!person) return null;

  const anchor = person.lastInteractionAt ?? person.createdAt;
  const due = anchor + Math.max(MIN_CADENCE_DAYS, rule.days) * DAY_MS;

  // Snap to the preferred hour on the local day the interval lands in. This can be a few
  // hours early rather than a whole day late, which is the right trade for an interval that
  // was approximate to begin with.
  const onDueDay = atLocalMinutesOnDayOf(due, rule.timezone, rule.atMinuteOfDay);
  if (onDueDay > now) return onDueDay;

  const today = atLocalMinutesOnDayOf(now, rule.timezone, rule.atMinuteOfDay);
  if (today > now) return today;
  return atLocalMinutesOnDayOf(
    startOfNextLocalDay(now, rule.timezone),
    rule.timezone,
    rule.atMinuteOfDay,
  );
}

/**
 * How overdue a check-in is, in whole days, or `null` when the person is not on a cadence.
 *
 * Drives ordering in the People list: someone six weeks past a two-week cadence should sit
 * above someone one day past, and neither should be buried under alphabetical order.
 * Negative means not yet due.
 */
export function cadenceOverdueDays(person: Person, now: EpochMs): number | null {
  if (person.cadenceDays === null) return null;
  const anchor = person.lastInteractionAt ?? person.createdAt;
  const due = anchor + person.cadenceDays * DAY_MS;
  return Math.floor((now - due) / DAY_MS);
}
