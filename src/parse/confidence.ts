/**
 * Scoring how much to trust a parse.
 *
 * The score decides whether an Event is created silently with an undo, or whether the user is
 * asked first. Getting that wrong in either direction is costly: too eager and the app
 * fabricates calendar entries, too timid and every capture becomes a dialogue.
 *
 * It is a weighted sum of observable signals rather than anything a date library reported,
 * because chrono-node exposes no confidence value at all and the Hebrew grammar is ours — so
 * the only way for one number to mean the same thing in both languages is to compute it from
 * the same evidence.
 *
 * The weights are a judgement call, not a measurement. They are here, in one readable table,
 * precisely so they can be argued with and tuned against real captures.
 */

import type { ParseSignals } from './types';

/** Enough that a well-formed capture clears the default 0.8 threshold, and little else does. */
export const WEIGHTS = {
  /** Something was recognised at all. */
  base: 0.35,
  /** A day was named. Without one there is nothing to hang an event on. */
  explicitDate: 0.3,
  /** A clock time was given. Without one, a time has to be invented. */
  explicitTime: 0.3,
  /** Text remained for a title. A dateless fragment is a poor event. */
  hasTitle: 0.05,
  /** Which half of the day was a guess. */
  ambiguousTime: -0.15,
  /** The time came from "evening" rather than a clock. */
  dayPartOnly: -0.1,
  /** Several date expressions; the wrong one may have won. */
  multipleCandidates: -0.1,
  /** Resolved to the past, which usually means a misparse. */
  resolvedInPast: -0.25,
} as const;

/**
 * Combines signals into a 0..1 score.
 *
 * Worth tracing a few, since the calibration is the whole point:
 *
 * - "Dinner with Alex next Tuesday at 8" → date + time + title, ambiguous hour rescued by
 *   "dinner" implying evening → 1.0. Created silently.
 * - "Dinner tomorrow at 8pm" → date + time + title, unambiguous → 1.0. Created silently.
 * - "Dinner tomorrow" → date + title, no time → 0.70. Asks first, correctly: a time would
 *   otherwise be invented out of nothing.
 * - "Dinner tomorrow evening" → date + title + day-part only → 0.60. Asks first.
 * - "Call the dentist at 3" → time + title but no day → 0.55. Asks first.
 */
export function scoreParse(signals: ParseSignals): number {
  let score = WEIGHTS.base;

  if (signals.hasExplicitDate) score += WEIGHTS.explicitDate;
  if (signals.hasExplicitTime) score += WEIGHTS.explicitTime;
  if (signals.hasTitle) score += WEIGHTS.hasTitle;

  if (signals.timeIsAmbiguous) score += WEIGHTS.ambiguousTime;
  if (signals.usedDayPartOnly) score += WEIGHTS.dayPartOnly;
  if (signals.candidateCount > 1) score += WEIGHTS.multipleCandidates;
  if (signals.resolvedInPast) score += WEIGHTS.resolvedInPast;

  return Math.min(1, Math.max(0, Number(score.toFixed(4))));
}
