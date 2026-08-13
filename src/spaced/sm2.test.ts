import { describe, expect, it } from 'vitest';
import {
  answer,
  initialState,
  MAX_EASE,
  MAX_INTERVAL_DAYS,
  MIN_EASE,
  review,
  type Grade,
  type SpacedState,
} from './sm2';

/** Applies a sequence of grades, which is the only way to see the schedule's shape. */
const sequence = (grades: Grade[], from: SpacedState = initialState()) =>
  grades.reduce((state, grade) => review(state, grade), from);

describe('initialState', () => {
  it('is due immediately and starts at the standard easiness', () => {
    expect(initialState()).toEqual({ ease: 2.5, intervalDays: 0, reps: 0 });
  });
});

describe('review — the canonical schedule', () => {
  it('gives one day after the first success', () => {
    expect(review(initialState(), 4)).toMatchObject({ intervalDays: 1, reps: 1 });
  });

  it('gives six days after the second, as SM-2 specifies', () => {
    expect(sequence([4, 4])).toMatchObject({ intervalDays: 6, reps: 2 });
  });

  it('multiplies by easiness from the third review onwards', () => {
    // 6 × 2.5 = 15.
    expect(sequence([4, 4, 4])).toMatchObject({ intervalDays: 15, reps: 3 });
  });

  it('keeps growing multiplicatively', () => {
    const state = sequence([4, 4, 4, 4]);
    expect(state.intervalDays).toBe(Math.round(15 * 2.5));
    expect(state.reps).toBe(4);
  });

  it('holds easiness steady on a grade of 4', () => {
    // The SM-2 bracket is exactly zero at 4: "recalled without difficulty" is the baseline, not
    // evidence the note is getting easier.
    expect(sequence([4, 4, 4]).ease).toBeCloseTo(2.5, 10);
  });

  it('raises easiness on a grade of 5', () => {
    expect(review(initialState(), 5).ease).toBeCloseTo(2.6, 10);
  });

  it('lowers easiness on a grade of 3, while still counting it as a success', () => {
    const state = review(initialState(), 3);
    expect(state.ease).toBeLessThan(2.5);
    expect(state.reps).toBe(1);
    expect(state.intervalDays).toBe(1);
  });
});

describe('review — lapses', () => {
  it('sends a forgotten note back to tomorrow and resets reps', () => {
    const mature = sequence([4, 4, 4, 4]);
    const lapsed = review(mature, 1);
    expect(lapsed.intervalDays).toBe(1);
    expect(lapsed.reps).toBe(0);
  });

  it('nudges easiness down rather than resetting it', () => {
    // A note forgotten once is not a note never seen; discarding the accumulated estimate makes the
    // schedule oscillate.
    const mature = sequence([5, 5, 5]);
    const lapsed = review(mature, 1);
    expect(lapsed.ease).toBeCloseTo(mature.ease - 0.2, 10);
    expect(lapsed.ease).toBeGreaterThan(MIN_EASE);
  });

  it('rebuilds the schedule from the start after a lapse', () => {
    const recovered = sequence([4, 4], review(sequence([4, 4, 4, 4]), 0));
    expect(recovered.intervalDays).toBe(6);
  });

  it('treats every grade below 3 as a lapse', () => {
    for (const grade of [0, 1, 2] as Grade[]) {
      expect(review(sequence([4, 4, 4]), grade).reps).toBe(0);
    }
  });
});

describe('review — bounds', () => {
  it('never lets easiness fall below the SM-2 floor', () => {
    let state = initialState();
    for (let i = 0; i < 20; i++) state = review(state, 0);
    expect(state.ease).toBe(MIN_EASE);
  });

  it('never lets easiness exceed the cap', () => {
    let state = initialState();
    for (let i = 0; i < 40; i++) state = review(state, 5);
    expect(state.ease).toBe(MAX_EASE);
  });

  it('caps the interval at a year', () => {
    // Without a cap a few easy answers push a note out of sight for a decade, which is deletion
    // wearing a schedule.
    let state = initialState();
    for (let i = 0; i < 30; i++) state = review(state, 5);
    expect(state.intervalDays).toBe(MAX_INTERVAL_DAYS);
  });

  it('keeps the interval at least a day', () => {
    let state = initialState();
    for (let i = 0; i < 30; i++) state = review(state, 3);
    expect(state.intervalDays).toBeGreaterThanOrEqual(1);
  });

  it('produces whole days, never fractions', () => {
    let state = initialState();
    for (const grade of [4, 5, 3, 4, 5, 4, 3, 5] as Grade[]) {
      state = review(state, grade);
      expect(Number.isInteger(state.intervalDays)).toBe(true);
    }
  });
});

describe('answer', () => {
  it('maps the three buttons onto the standard scale', () => {
    const state = sequence([4, 4]);
    expect(answer(state, 'recalled')).toEqual(review(state, 4));
    expect(answer(state, 'easy')).toEqual(review(state, 5));
    expect(answer(state, 'forgot')).toEqual(review(state, 2));
  });

  it('makes "easy" stretch further than "recalled"', () => {
    const state = sequence([4, 4, 4]);
    expect(answer(state, 'easy').ease).toBeGreaterThan(answer(state, 'recalled').ease);
  });

  it('makes "forgot" the only answer that collapses the interval', () => {
    const state = sequence([4, 4, 4]);
    expect(answer(state, 'forgot').intervalDays).toBe(1);
    expect(answer(state, 'recalled').intervalDays).toBeGreaterThan(1);
    expect(answer(state, 'easy').intervalDays).toBeGreaterThan(1);
  });
});
