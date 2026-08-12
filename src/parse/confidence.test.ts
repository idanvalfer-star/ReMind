import { describe, expect, it } from 'vitest';
import { scoreParse } from './confidence';
import type { ParseSignals } from './types';

const base: ParseSignals = {
  hasExplicitTime: false,
  hasExplicitDate: false,
  timeIsAmbiguous: false,
  usedDayPartOnly: false,
  candidateCount: 1,
  hasTitle: false,
  resolvedInPast: false,
};

const signals = (overrides: Partial<ParseSignals>): ParseSignals => ({ ...base, ...overrides });

/** The default threshold from Settings — the line between silent creation and asking first. */
const THRESHOLD = 0.8;

describe('scoreParse — calibration against the threshold', () => {
  it('clears the threshold for a fully specified capture', () => {
    // "Dinner with Alex tomorrow at 8pm"
    const score = scoreParse(
      signals({ hasExplicitDate: true, hasExplicitTime: true, hasTitle: true }),
    );
    expect(score).toBeGreaterThanOrEqual(THRESHOLD);
  });

  it('falls below the threshold when no time was given', () => {
    // "Dinner tomorrow" — a time would have to be invented, so the user should confirm.
    const score = scoreParse(signals({ hasExplicitDate: true, hasTitle: true }));
    expect(score).toBeLessThan(THRESHOLD);
  });

  it('falls below the threshold when the time came from a day-part word', () => {
    // "Dinner tomorrow evening" — 19:00 was chosen for them.
    const score = scoreParse(
      signals({ hasExplicitDate: true, hasTitle: true, usedDayPartOnly: true }),
    );
    expect(score).toBeLessThan(THRESHOLD);
  });

  it('falls below the threshold when no day was given', () => {
    // "Call the dentist at 3" — which day is anyone's guess.
    const score = scoreParse(signals({ hasExplicitTime: true, hasTitle: true }));
    expect(score).toBeLessThan(THRESHOLD);
  });

  it('still clears the threshold when only the half of the day was guessed', () => {
    // Everything stated except am/pm. The penalty applies but should not tip it over on its own,
    // because the date and the hour are both explicit.
    const score = scoreParse(
      signals({
        hasExplicitDate: true,
        hasExplicitTime: true,
        hasTitle: true,
        timeIsAmbiguous: true,
      }),
    );
    expect(score).toBeGreaterThanOrEqual(THRESHOLD);
  });

  it('drops well below the threshold for a date resolved into the past', () => {
    // Almost always a misparse, and creating a calendar entry in the past is worse than asking.
    const score = scoreParse(
      signals({
        hasExplicitDate: true,
        hasExplicitTime: true,
        hasTitle: true,
        resolvedInPast: true,
      }),
    );
    expect(score).toBeLessThan(THRESHOLD);
  });

  it('penalises several competing date expressions', () => {
    const one = scoreParse(signals({ hasExplicitDate: true, hasExplicitTime: true, hasTitle: true }));
    const many = scoreParse(
      signals({
        hasExplicitDate: true,
        hasExplicitTime: true,
        hasTitle: true,
        candidateCount: 3,
      }),
    );
    expect(many).toBeLessThan(one);
  });
});

describe('scoreParse — bounds', () => {
  it('stays within 0 and 1', () => {
    expect(scoreParse(base)).toBeGreaterThanOrEqual(0);
    expect(
      scoreParse(
        signals({
          hasExplicitDate: true,
          hasExplicitTime: true,
          hasTitle: true,
          timeIsAmbiguous: true,
          usedDayPartOnly: true,
          candidateCount: 5,
          resolvedInPast: true,
        }),
      ),
    ).toBeGreaterThanOrEqual(0);
    expect(
      scoreParse(signals({ hasExplicitDate: true, hasExplicitTime: true, hasTitle: true })),
    ).toBeLessThanOrEqual(1);
  });

  it('is monotonic in the positive signals', () => {
    const none = scoreParse(base);
    const date = scoreParse(signals({ hasExplicitDate: true }));
    const both = scoreParse(signals({ hasExplicitDate: true, hasExplicitTime: true }));
    expect(date).toBeGreaterThan(none);
    expect(both).toBeGreaterThan(date);
  });
});
