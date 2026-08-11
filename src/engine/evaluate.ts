/**
 * Turns a trigger's rule into the instant it *wants* to fire at, before quiet hours and
 * the daily cap get a say. `resolveFireTime` takes it from there.
 */

import type { EpochMs, Event, TriggerCondition } from '../db/schema';
import { MINUTE_MS } from './time';

/**
 * The trigger kinds that have evaluators today.
 *
 * `cadence` and `spaced` are part of `TriggerCondition` so the union stays exhaustive, but
 * they are excluded here at the type level rather than handled with a runtime throw — that
 * way adding one later is a compile error at every call site instead of a surprise in
 * production.
 */
export type SchedulableCondition = Extract<
  TriggerCondition,
  { kind: 'time' | 'event-adjacent' }
>;

export function isSchedulable(condition: TriggerCondition): condition is SchedulableCondition {
  return condition.kind === 'time' || condition.kind === 'event-adjacent';
}

/**
 * The instant a trigger wants to fire.
 *
 * Returns `null` for an `event-adjacent` trigger whose Event has gone — deleted, or lost
 * to a partial import. The caller deactivates the trigger rather than guessing a time.
 *
 * `offsetMinutes` is signed: negative is before the event, which is the usual case.
 * The travel buffer always shifts *earlier*, since its entire purpose is leaving enough
 * time to arrive.
 */
export function desiredFireAt(
  condition: SchedulableCondition,
  event: Event | undefined,
): EpochMs | null {
  switch (condition.kind) {
    case 'time':
      return condition.at;

    case 'event-adjacent': {
      if (!event) return null;
      const buffer = condition.includeTravelBuffer ? event.travelBufferMinutes : 0;
      return event.startAt + condition.offsetMinutes * MINUTE_MS - buffer * MINUTE_MS;
    }
  }
}
