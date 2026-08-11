/**
 * Resolves a desired reminder time into a legal one.
 *
 * Quiet hours and the daily cap interact, and the interaction is the whole reason this is
 * a fixpoint loop rather than two sequential adjustments: pushing a full day forward lands
 * on the next local midnight, which is itself inside a normal 22:00–07:00 quiet window, so
 * the constraints have to be re-checked until both hold at once.
 *
 * Pure and clock-free on purpose — `desiredAt` and the already-scheduled set come from the
 * caller — which is what makes the DST and cap-spill cases testable.
 */

import type { EpochMs, IanaTz, QuietHours } from '../db/schema';
import { bucketByLocalDay, nextInstantWithCapacity } from './cap';
import { nextAllowedInstant } from './quietHours';

export interface ScheduleContext {
  quietHours: QuietHours;
  dailyCap: number;
  timezone: IanaTz;
  /** Fire times already committed, in any order. */
  scheduled: readonly EpochMs[];
}

/** Which constraint moved the time, so the UI can explain itself rather than just lie. */
export type ScheduleAdjustment = 'none' | 'quiet-hours' | 'daily-cap' | 'both';

export interface ScheduleOutcome {
  /** The legal instant, or `null` when the current settings permit no reminders at all. */
  fireAt: EpochMs | null;
  adjusted: ScheduleAdjustment;
}

function describe(movedForQuiet: boolean, movedForCap: boolean): ScheduleAdjustment {
  if (movedForQuiet && movedForCap) return 'both';
  if (movedForQuiet) return 'quiet-hours';
  if (movedForCap) return 'daily-cap';
  return 'none';
}

/**
 * Finds the first instant at or after `desiredAt` that satisfies both constraints.
 *
 * Never drops a reminder to make the constraints fit: the only `null` outcome is a
 * non-positive daily cap, which is the user explicitly asking for no notifications. A
 * caller that gets `null` must tell them, not fail quietly.
 */
export function resolveFireTime(desiredAt: EpochMs, ctx: ScheduleContext): ScheduleOutcome {
  const counts = bucketByLocalDay(ctx.scheduled, ctx.timezone);

  let candidate = desiredAt;
  let movedForQuiet = false;
  let movedForCap = false;

  // Each pass through the loop strictly advances `candidate`, and each cap move advances a
  // whole day, so this converges in at most two moves per candidate day. The bound is
  // defensive only.
  const maxPasses = 4 * (counts.size + 3);

  for (let pass = 0; pass < maxPasses; pass++) {
    const afterQuiet = nextAllowedInstant(candidate, ctx.quietHours, ctx.timezone);
    if (afterQuiet !== candidate) {
      movedForQuiet = true;
      candidate = afterQuiet;
      // The new instant may be on a day that is already full — re-check both.
      continue;
    }

    const afterCap = nextInstantWithCapacity(candidate, counts, ctx.dailyCap, ctx.timezone);
    if (afterCap === null) {
      return { fireAt: null, adjusted: describe(movedForQuiet, movedForCap) };
    }
    if (afterCap !== candidate) {
      movedForCap = true;
      candidate = afterCap;
      // Next local midnight is almost always inside quiet hours — go round again.
      continue;
    }

    return { fireAt: candidate, adjusted: describe(movedForQuiet, movedForCap) };
  }

  // Unreachable given the argument above; reported rather than looping forever.
  return { fireAt: null, adjusted: describe(movedForQuiet, movedForCap) };
}
