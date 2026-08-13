/**
 * Turns a trigger's rule into the instant it *wants* to fire at, before quiet hours and
 * the daily cap get a say. `resolveFireTime` takes it from there.
 */

import type { EpochMs, Event, Person, TriggerCondition } from '../db/schema';
import { cadenceFireAt } from './cadence';
import { MINUTE_MS } from './time';

/**
 * The trigger kinds that have evaluators today.
 *
 * `spaced` is part of `TriggerCondition` so the union stays exhaustive, but it is excluded
 * here at the type level rather than handled with a runtime throw — that way adding it later
 * is a compile error at every call site instead of a surprise in production.
 */
export type SchedulableCondition = Extract<
  TriggerCondition,
  { kind: 'time' | 'event-adjacent' | 'cadence' }
>;

export function isSchedulable(condition: TriggerCondition): condition is SchedulableCondition {
  return (
    condition.kind === 'time' ||
    condition.kind === 'event-adjacent' ||
    condition.kind === 'cadence'
  );
}

/**
 * Everything an evaluator might need, already fetched.
 *
 * A bag rather than a discriminated pair because the alternative — proving at the type level
 * that a `cadence` condition arrives with a Person and not an Event — buys nothing: each arm
 * reads exactly one field and returns `null` when it is missing, which is the case that has
 * to be handled anyway.
 */
export interface TriggerTargets {
  event?: Event | undefined;
  person?: Person | undefined;
}

/**
 * The instant a trigger wants to fire.
 *
 * Returns `null` when the thing the trigger points at has gone — an Event deleted, a Person
 * removed, or either lost to a partial import. The caller deactivates the trigger rather than
 * guessing a time.
 *
 * `offsetMinutes` is signed: negative is before the event, which is the usual case. The
 * travel buffer always shifts *earlier*, since its entire purpose is leaving enough time to
 * arrive.
 *
 * `now` only matters to `cadence`, whose rule is an interval rather than an instant and so
 * has to be resolved against the present. The other arms ignore it.
 */
export function desiredFireAt(
  condition: SchedulableCondition,
  targets: TriggerTargets,
  now: EpochMs = Date.now(),
): EpochMs | null {
  switch (condition.kind) {
    case 'time':
      return condition.at;

    case 'event-adjacent': {
      const { event } = targets;
      if (!event) return null;
      const buffer = condition.includeTravelBuffer ? event.travelBufferMinutes : 0;
      return event.startAt + condition.offsetMinutes * MINUTE_MS - buffer * MINUTE_MS;
    }

    case 'cadence':
      return cadenceFireAt(condition, targets.person, now);
  }
}
