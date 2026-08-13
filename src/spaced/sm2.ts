/**
 * SM-2, the spaced-repetition interval scheduler.
 *
 * Adapted from SuperMemo 2 (Wozniak, 1990), which is the algorithm Anki's original scheduler is
 * built on. It is used here for something slightly different from flashcards: the question is not
 * "do you remember this fact" but "is this note still worth resurfacing", and the answer stretches
 * or collapses the interval the same way.
 *
 * Two departures from the textbook version, both deliberate and both noted at the point they happen:
 * the interval is capped, and a lapse does not reset the easiness all the way.
 *
 * Pure. No clock, no storage — the caller turns an interval into a date.
 */

/**
 * How well the note was recalled, on SM-2's 0–5 scale.
 *
 * The UI offers three buttons rather than six, because nobody can distinguish six degrees of
 * remembering, and mapping them onto the standard scale keeps the arithmetic canonical instead of
 * inventing a private variant.
 */
export type Grade = 0 | 1 | 2 | 3 | 4 | 5;

/** The three buttons, and what they mean on the 0–5 scale. */
export const GRADE_FOR_ANSWER = {
  /** No — I had forgotten this, or it needs attention now. */
  forgot: 2,
  /** Yes — still relevant, nothing surprising. */
  recalled: 4,
  /** Yes, obviously — do not ask me about this for a long time. */
  easy: 5,
} as const satisfies Record<string, Grade>;

export type Answer = keyof typeof GRADE_FOR_ANSWER;

export interface SpacedState {
  /** SM-2 easiness factor. Higher means the interval grows faster. */
  ease: number;
  intervalDays: number;
  /** Consecutive successful reviews. Reset by a lapse. */
  reps: number;
}

/** SM-2's starting easiness. */
export const INITIAL_EASE = 2.5;
/** The floor SM-2 specifies. Below it, intervals barely grow and the note is asked about forever. */
export const MIN_EASE = 1.3;
/** No upper bound in the original. Without one, a few `easy` answers push a note out of sight. */
export const MAX_EASE = 3;

/** First two intervals are fixed in SM-2; the third onwards is multiplicative. */
const FIRST_INTERVAL_DAYS = 1;
const SECOND_INTERVAL_DAYS = 6;

/**
 * A year.
 *
 * SM-2 has no ceiling, and for a memory app that is wrong in a specific way: an interval of eleven
 * years is indistinguishable from deletion, but the note keeps occupying a schedule and the user
 * never gets the chance to decide it is finished. Capping at a year means anything genuinely
 * permanent still comes round once, and can then be dismissed on purpose.
 */
export const MAX_INTERVAL_DAYS = 365;

/** A note not yet reviewed. `intervalDays: 0` means "due now". */
export function initialState(): SpacedState {
  return { ease: INITIAL_EASE, intervalDays: 0, reps: 0 };
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * The next state after a review.
 *
 * A grade below 3 is a lapse: reps reset and the note comes back tomorrow. The easiness drops by
 * 0.2 rather than being reset to its initial value — a note you have forgotten once is not a note
 * you have never seen, and throwing away the accumulated estimate makes the schedule oscillate.
 *
 * The interval is computed with the *current* easiness and the easiness updated afterwards, so a
 * grade affects the interval after next rather than the one it produced. That is the ordering
 * SuperMemo specifies and the one Anki follows.
 */
export function review(state: SpacedState, grade: Grade): SpacedState {
  if (grade < 3) {
    return {
      ease: clamp(state.ease - 0.2, MIN_EASE, MAX_EASE),
      intervalDays: FIRST_INTERVAL_DAYS,
      reps: 0,
    };
  }

  const reps = state.reps + 1;
  const intervalDays =
    reps === 1
      ? FIRST_INTERVAL_DAYS
      : reps === 2
        ? SECOND_INTERVAL_DAYS
        : Math.round(state.intervalDays * state.ease);

  // SM-2's easiness update. The bracket is zero at grade 4, positive at 5, negative at 3 — so
  // "recalled without difficulty" holds the estimate steady rather than inflating it.
  const delta = 0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02);

  return {
    ease: clamp(state.ease + delta, MIN_EASE, MAX_EASE),
    intervalDays: clamp(intervalDays, FIRST_INTERVAL_DAYS, MAX_INTERVAL_DAYS),
    reps,
  };
}

/** `review` keyed by the answer the UI actually offers. */
export function answer(state: SpacedState, given: Answer): SpacedState {
  return review(state, GRADE_FOR_ANSWER[given]);
}
