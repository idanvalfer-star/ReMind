import { describe, expect, it } from 'vitest';
import { formatRelativeDays } from './relative';

describe('formatRelativeDays', () => {
  it('says yesterday and tomorrow rather than counting one', () => {
    expect(formatRelativeDays(-1, 'en')).toBe('yesterday');
    expect(formatRelativeDays(1, 'en')).toBe('tomorrow');
  });

  it('says today for zero', () => {
    expect(formatRelativeDays(0, 'en')).toBe('today');
  });

  it('counts days inside a fortnight', () => {
    expect(formatRelativeDays(-5, 'en')).toBe('5 days ago');
    expect(formatRelativeDays(9, 'en')).toBe('in 9 days');
  });

  it('switches to weeks rather than saying 30 days', () => {
    expect(formatRelativeDays(-30, 'en')).toBe('4 weeks ago');
  });

  it('switches to months for long gaps', () => {
    expect(formatRelativeDays(-90, 'en')).toBe('3 months ago');
  });

  it('produces idiomatic Hebrew, not a translated English shape', () => {
    // Two days ago has its own word in Hebrew, and Intl knows it. A hand-written
    // "לפני {{count}} ימים" string could never produce this, and would also get the dual form
    // wrong for two of anything. This is the whole reason the module delegates.
    expect(formatRelativeDays(-2, 'he')).toBe('שלשום');
    expect(formatRelativeDays(-5, 'he')).toBe('לפני 5 ימים');
    expect(formatRelativeDays(-1, 'he')).toBe('אתמול');
  });

  it('is symmetric about the unit thresholds', () => {
    expect(formatRelativeDays(13, 'en')).toContain('days');
    expect(formatRelativeDays(14, 'en')).toContain('weeks');
    expect(formatRelativeDays(-13, 'en')).toContain('days');
    expect(formatRelativeDays(-14, 'en')).toContain('weeks');
  });
});
