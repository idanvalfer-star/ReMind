/**
 * Time audits: what the app has actually been doing for you.
 *
 * This is the first thing that *reads* `TriggerFire`. Phase 1 wrote that log with a comment saying
 * nothing consumed it yet and that the data was only collectable as it happened. This is the
 * consumer.
 *
 * The useful question is not "how many reminders did I get" but **which kinds of reminder do I
 * actually act on**. A reminder type you dismiss nine times out of ten is one the app should stop
 * sending, and a person can only make that judgement if the numbers are in front of them.
 *
 * Everything here is pure aggregation. Nothing changes behaviour automatically — the brief says
 * Phase 4 "tunes on" the response log, and tuning silently would mean the app quietly deciding to
 * stop reminding someone about something. Showing them and letting them adjust the settings is the
 * honest version.
 */

import type { EpochMs, Event, IanaTz, Trigger, TriggerFire, TriggerKind } from '../db/schema';
import { HOUR_MS, localDayKey, minutesOfDay } from '../engine/time';

export interface ResponseCounts {
  acted: number;
  dismissed: number;
  snoozed: number;
  /** Delivered and never answered. Not the same as dismissed — silence is its own signal. */
  ignored: number;
  delivered: number;
  /** `acted / delivered`, or `null` when nothing has been delivered yet. */
  actedRate: number | null;
}

const EMPTY: ResponseCounts = {
  acted: 0,
  dismissed: 0,
  snoozed: 0,
  ignored: 0,
  delivered: 0,
  actedRate: null,
};

function tally(fires: readonly TriggerFire[]): ResponseCounts {
  const counts = { ...EMPTY };
  for (const fire of fires) {
    counts.delivered += 1;
    if (fire.response === 'none') counts.ignored += 1;
    else counts[fire.response] += 1;
  }
  counts.actedRate = counts.delivered === 0 ? null : counts.acted / counts.delivered;
  return counts;
}

/** Overall response counts across every delivery. */
export function overallResponses(fires: readonly TriggerFire[]): ResponseCounts {
  return tally(fires);
}

/**
 * Response counts split by the kind of trigger that produced them.
 *
 * Joined through the trigger rather than stored on the fire, because a fire is written by the service
 * worker in a hurry and denormalising the kind onto it would be one more thing to get wrong at the
 * moment there is least room to. Fires whose trigger has since been deleted are dropped — they cannot
 * be attributed, and guessing would be worse than a slightly smaller sample.
 */
export function responsesByKind(
  fires: readonly TriggerFire[],
  triggers: readonly Trigger[],
): { kind: TriggerKind; counts: ResponseCounts }[] {
  const kindOf = new Map(triggers.map((trigger) => [trigger.id, trigger.kind]));

  const grouped = new Map<TriggerKind, TriggerFire[]>();
  for (const fire of fires) {
    const kind = kindOf.get(fire.triggerId);
    if (!kind) continue;
    const list = grouped.get(kind);
    if (list) list.push(fire);
    else grouped.set(kind, [fire]);
  }

  return [...grouped.entries()]
    .map(([kind, own]) => ({ kind, counts: tally(own) }))
    // Worst-performing first: the point of the screen is to find the reminders that are not working.
    .sort((a, b) => (a.counts.actedRate ?? 1) - (b.counts.actedRate ?? 1));
}

/**
 * How many were delivered inside a window, and how many the user answered at all.
 *
 * "Answered" rather than "acted on" because a dismissal is engagement — the user saw it and made a
 * decision. Silence is the number that should worry you.
 */
export function deliveryVolume(
  fires: readonly TriggerFire[],
  from: EpochMs,
  to: EpochMs,
): { delivered: number; answered: number } {
  const within = fires.filter((fire) => fire.firedAt >= from && fire.firedAt < to);
  return {
    delivered: within.length,
    answered: within.filter((fire) => fire.response !== 'none').length,
  };
}

export interface DayLoad {
  /** Local day key, `YYYY-MM-DD`. */
  key: string;
  /** Scheduled hours on that day, from timed events only. */
  hours: number;
  eventCount: number;
}

/**
 * Hours of scheduled time per local day, in the order the days fall.
 *
 * All-day events are counted as events but contribute no hours. Counting them as 24 would swamp
 * every real number — a birthday is not a day's work — and counting them as some invented figure
 * would be making data up.
 *
 * Events that straddle midnight are attributed to the day they *start*, which is the day you would
 * say they were on.
 */
export function loadByDay(
  events: readonly Event[],
  timezone: IanaTz,
  from: EpochMs,
  to: EpochMs,
): DayLoad[] {
  const byDay = new Map<string, DayLoad>();

  for (const event of events) {
    if (event.startAt < from || event.startAt >= to) continue;
    const key = localDayKey(event.startAt, timezone);
    const entry = byDay.get(key) ?? { key, hours: 0, eventCount: 0 };
    entry.eventCount += 1;
    if (!event.isAllDay) {
      entry.hours += Math.max(0, event.endAt - event.startAt) / HOUR_MS;
    }
    byDay.set(key, entry);
  }

  return [...byDay.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Which hours of the day your commitments actually fall in, as 24 buckets.
 *
 * Counts an event once, at its start hour. Spreading a two-hour meeting across two buckets would be
 * more accurate about occupancy and less useful for the actual question, which is what time of day
 * your life makes demands on you.
 */
export function busyHours(events: readonly Event[], timezone: IanaTz): number[] {
  const buckets = new Array<number>(24).fill(0);
  for (const event of events) {
    if (event.isAllDay) continue;
    const hour = Math.floor(minutesOfDay(event.startAt, timezone) / 60);
    if (hour >= 0 && hour < 24) buckets[hour] = (buckets[hour] ?? 0) + 1;
  }
  return buckets;
}

export interface AuditSummary {
  responses: ResponseCounts;
  byKind: { kind: TriggerKind; counts: ResponseCounts }[];
  days: DayLoad[];
  hours: number[];
  /** Mean scheduled hours across days that had anything at all. Null when there were none. */
  averageHoursPerBusyDay: number | null;
}

/** Everything the audit screen needs, from data already on the device. */
export function buildAudit(input: {
  fires: readonly TriggerFire[];
  triggers: readonly Trigger[];
  events: readonly Event[];
  timezone: IanaTz;
  from: EpochMs;
  to: EpochMs;
}): AuditSummary {
  const days = loadByDay(input.events, input.timezone, input.from, input.to);
  const busy = days.filter((day) => day.hours > 0);

  return {
    responses: overallResponses(input.fires),
    byKind: responsesByKind(input.fires, input.triggers),
    days,
    hours: busyHours(input.events, input.timezone),
    averageHoursPerBusyDay:
      busy.length === 0 ? null : busy.reduce((sum, day) => sum + day.hours, 0) / busy.length,
  };
}
