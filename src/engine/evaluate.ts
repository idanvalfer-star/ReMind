/**
 * Turns a trigger's rule into the instant it *wants* to fire at, before quiet hours and
 * the daily cap get a say. `resolveFireTime` takes it from there.
 *
 * Every `TriggerCondition` arm has an evaluator as of Phase 4. Earlier versions of this file carried
 * a `SchedulableCondition` type narrowing the union to the implemented subset, so that adding an
 * evaluator was a compile error at every call site rather than a surprise in production. It did its
 * job and is gone: with the union complete it was a tautology, and a type guard that always returns
 * true is worse than no guard, because it reads as if it were checking something.
 */

import type { Entry, EpochMs, Event, Person, TriggerCondition } from '../db/schema';
import { cadenceFireAt } from './cadence';
import { atLocalMinutesOnDayOf, DAY_MS, MINUTE_MS } from './time';

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
  entry?: Entry | undefined;
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
  condition: TriggerCondition,
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

    case 'spaced':
      // Derived from the last review rather than stored, so changing the interval takes effect
      // without a second write. Snapped to the digest hour, because a note due "in six days" should
      // arrive with that morning's digest and not at whatever minute the last review was answered.
      return atLocalMinutesOnDayOf(
        condition.lastReviewedAt + condition.intervalDays * DAY_MS,
        condition.timezone,
        condition.atMinuteOfDay,
      );
  }
}
