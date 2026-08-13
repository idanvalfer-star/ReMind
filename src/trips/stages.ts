/**
 * When to nudge someone about a trip.
 *
 * Packing fails at specific moments, and they are not the moment you booked the trip. It fails a
 * week out, when there is still time to buy the thing you do not own; the night before, when you
 * still have time to do laundry; the morning of, when the passport is still on the desk; and the day
 * before you come home, when the charger is still in the wall.
 *
 * So this is four reminders at four different distances, each with a different job — not one alarm
 * repeated. Pure and clock-injected: every interesting case is about which stages are still ahead of
 * *now* for a trip of a given length.
 */

import type { EpochMs, IanaTz } from '../db/schema';
import { atLocalMinutesOnDayOf, DAY_MS } from '../engine/time';

export type StageId = 'shop' | 'night-before' | 'departure-day' | 'return-eve';

export interface Stage {
  id: StageId;
  at: EpochMs;
}

export interface StageRule {
  id: StageId;
  /** Days before the anchor. */
  daysBefore: number;
  /** Minutes past local midnight on that day. */
  atMinuteOfDay: number;
  /** Which end of the trip the offset is measured from. */
  anchor: 'start' | 'end';
  /**
   * Suppressed on trips shorter than this many nights. A one-night trip does not need a shopping
   * reminder a week out, and it does not need a return checklist either.
   */
  minNights?: number;
}

/**
 * The four stages.
 *
 * The hours are chosen for when the reminder can still be *acted on*: 18:00 the night before is
 * before laundry becomes impossible; 07:00 on the day is before leaving; 20:00 on the last evening
 * is while you are still in the room with your charger.
 */
export const STAGE_RULES: readonly StageRule[] = [
  { id: 'shop', daysBefore: 7, atMinuteOfDay: 11 * 60, anchor: 'start', minNights: 2 },
  { id: 'night-before', daysBefore: 1, atMinuteOfDay: 18 * 60, anchor: 'start' },
  { id: 'departure-day', daysBefore: 0, atMinuteOfDay: 7 * 60, anchor: 'start' },
  { id: 'return-eve', daysBefore: 1, atMinuteOfDay: 20 * 60, anchor: 'end', minNights: 2 },
];

export interface TripShape {
  startAt: EpochMs;
  endAt: EpochMs;
  timezone: IanaTz;
}

/**
 * The stages still worth scheduling for a trip, earliest first.
 *
 * A stage in the past is dropped rather than fired late. A reminder to buy something for a trip that
 * left yesterday is noise, and the engine would refuse a past instant anyway — dropping it here
 * means the caller never has to distinguish "refused" from "already gone".
 *
 * The departure-day stage is also dropped if it would land *after* departure: a 06:00 flight does not
 * want a 07:00 reminder to check the passport.
 */
export function stagesFor(trip: TripShape, now: EpochMs = Date.now()): Stage[] {
  return stageInstants(trip).filter((stage) => stage.at > now);
}

/**
 * Every stage the trip's shape justifies, regardless of the clock.
 *
 * Separated from `stagesFor` because two callers want different things from it: scheduling wants the
 * ones still ahead, and `stageIdAt` — working out which stage a fired reminder *was* — needs them
 * all, since by definition it is asking about one in the past.
 */
export function stageInstants(trip: TripShape): Stage[] {
  const nights = Math.max(1, Math.round((trip.endAt - trip.startAt) / DAY_MS));

  const stages: Stage[] = [];
  for (const rule of STAGE_RULES) {
    if (rule.minNights !== undefined && nights < rule.minNights) continue;

    const anchor = rule.anchor === 'start' ? trip.startAt : trip.endAt;
    const day = anchor - rule.daysBefore * DAY_MS;
    const at = atLocalMinutesOnDayOf(day, trip.timezone, rule.atMinuteOfDay);

    // A stage must land before the moment it prepares you for. Written once against the stage's own
    // anchor rather than per-arm: today only the departure-day rule can actually trip it (a 07:00
    // reminder for a 06:00 flight), but stating the invariant is what keeps a future rule honest.
    if (at >= anchor) continue;

    stages.push({ id: rule.id, at });
  }

  return stages.sort((a, b) => a.at - b.at);
}

/** How far a fired reminder may sit from a computed stage instant and still be that stage. */
const STAGE_MATCH_TOLERANCE_MS = 12 * 60 * 60 * 1000;

/**
 * Which stage a reminder at `at` belongs to, or `null` if none is close enough.
 *
 * Derived rather than stored, and that is the interesting choice here. The alternative — putting a
 * stage id on the trigger — would go stale the moment the trip's dates moved, leaving a reminder
 * that says "leaving today" on a day that is no longer the departure. Recomputing from the trip's
 * *current* dates means the text is always consistent with them, and the honest `null` case covers a
 * trip that moved so far the old reminder no longer means anything.
 */
export function stageIdAt(trip: TripShape, at: EpochMs): StageId | null {
  let best: { id: StageId; delta: number } | null = null;
  for (const stage of stageInstants(trip)) {
    const delta = Math.abs(stage.at - at);
    if (delta > STAGE_MATCH_TOLERANCE_MS) continue;
    if (!best || delta < best.delta) best = { id: stage.id, delta };
  }
  return best?.id ?? null;
}
