/**
 * Decides whether a desired reminder time is allowed to notify.
 *
 * **Semantics: suppress, never move.** If the requested instant falls inside quiet hours,
 * or its local day has already spent the daily cap, the reminder is *not* rescheduled to
 * some other time — the notification is refused and the reason is handed back. A reminder
 * arriving at 07:00 when the user asked for 22:30 is a notification they did not ask for,
 * at a time they did not choose, and it teaches them not to trust the times they set.
 *
 * Nothing is silently lost, because a refusal is not a deletion:
 *
 * - The `Entry` is always saved. Capture is never blocked on any of this.
 * - `suggestion` carries the nearest instant that *would* be allowed, so the caller can
 *   offer it as a one-tap alternative instead of guessing on the user's behalf.
 * - The trigger is simply not created until a legal time is chosen, so no "scheduled but
 *   muted" state has to be represented in the schema at all.
 *
 * Pure and clock-free: `desiredAt` and the already-scheduled set come from the caller,
 * which is what makes the DST and cap cases testable.
 */

import type { EpochMs, IanaTz, QuietHours } from '../db/schema';
import { bucketByLocalDay, hasCapacityOn, nextInstantWithCapacity } from './cap';
import { isQuiet, nextAllowedInstant } from './quietHours';

export interface ScheduleContext {
  quietHours: QuietHours;
  dailyCap: number;
  timezone: IanaTz;
  /** Fire times already committed, in any order. */
  scheduled: readonly EpochMs[];
}

export type SuppressionReason = 'quiet-hours' | 'daily-cap';

export type ScheduleDecision =
  | {
      kind: 'scheduled';
      /** Always exactly the instant requested. This function never moves a reminder. */
      fireAt: EpochMs;
    }
  | {
      kind: 'suppressed';
      desiredAt: EpochMs;
      reason: SuppressionReason;
      /**
       * Nearest instant that would be permitted, for the caller to offer as an
       * alternative. `null` when the settings permit no reminders at all — a daily cap of
       * zero, which is the user asking for none.
       */
      suggestion: EpochMs | null;
    };

/**
 * The first instant at or after `desiredAt` that satisfies both constraints, or `null` if
 * there is none.
 *
 * A fixpoint loop rather than two sequential adjustments, because the constraints
 * interact: stepping over a full day lands on the next local midnight, which is itself
 * inside a normal 22:00–07:00 quiet window, so both have to be re-checked until they hold
 * at once.
 *
 * This is only ever a *suggestion* — see the module note. Nothing here is applied
 * automatically.
 */
export function nearestAllowedInstant(desiredAt: EpochMs, ctx: ScheduleContext): EpochMs | null {
  const counts = bucketByLocalDay(ctx.scheduled, ctx.timezone);

  let candidate = desiredAt;
  // Each pass strictly advances `candidate`, and each cap step advances a whole day, so
  // this converges in at most two moves per day. The bound is defensive only.
  const maxPasses = 4 * (counts.size + 3);

  for (let pass = 0; pass < maxPasses; pass++) {
    const afterQuiet = nextAllowedInstant(candidate, ctx.quietHours, ctx.timezone);
    if (afterQuiet !== candidate) {
      candidate = afterQuiet;
      // May have landed on a day that is already full — re-check both.
      continue;
    }

    const afterCap = nextInstantWithCapacity(candidate, counts, ctx.dailyCap, ctx.timezone);
    if (afterCap === null) return null;
    if (afterCap !== candidate) {
      candidate = afterCap;
      // Next local midnight is almost always inside quiet hours — go round again.
      continue;
    }

    return candidate;
  }

  // Unreachable given the argument above; reported rather than looping forever.
  return null;
}

/**
 * Whether a reminder may notify at `desiredAt`, and if not, why, and what would work.
 *
 * Quiet hours are checked before the cap so that the reason returned is the one the user
 * will recognise: at 23:00 on a busy day, "quiet hours" is the answer that makes sense to
 * them, even though both constraints apply.
 */
export function resolveFireTime(desiredAt: EpochMs, ctx: ScheduleContext): ScheduleDecision {
  if (isQuiet(desiredAt, ctx.quietHours, ctx.timezone)) {
    return {
      kind: 'suppressed',
      desiredAt,
      reason: 'quiet-hours',
      suggestion: nearestAllowedInstant(desiredAt, ctx),
    };
  }

  const counts = bucketByLocalDay(ctx.scheduled, ctx.timezone);
  if (!hasCapacityOn(desiredAt, counts, ctx.dailyCap, ctx.timezone)) {
    return {
      kind: 'suppressed',
      desiredAt,
      reason: 'daily-cap',
      suggestion: nearestAllowedInstant(desiredAt, ctx),
    };
  }

  return { kind: 'scheduled', fireAt: desiredAt };
}
