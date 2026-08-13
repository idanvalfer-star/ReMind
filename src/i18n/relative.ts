/**
 * Human phrasing for "how long ago" and "how far off".
 *
 * `Intl.RelativeTimeFormat` is doing the hard part. Hebrew plural rules are not English plural
 * rules — CLDR gives it `one`, `two`, `many` and `other`, so "2 days" is its own form — and
 * hand-written translation strings with `{{count}}` in them get that wrong in a way that looks
 * like broken grammar to a native reader. Delegating to Intl means neither language needs plural
 * strings at all.
 *
 * The only judgement left here is the unit: "45 days ago" is technically right and nobody talks
 * that way.
 */

import type { Lang } from '../db/schema';

/** Beyond this many days, days stop being the unit anyone thinks in. */
const DAYS_BEFORE_WEEKS = 14;
const DAYS_BEFORE_MONTHS = 60;
const DAYS_PER_WEEK = 7;
const DAYS_PER_MONTH = 30;

/**
 * Formats a signed day offset — negative for the past — as a relative phrase.
 *
 * `numeric: 'auto'` is what turns -1 into "yesterday" rather than "1 day ago", which is the
 * difference between the app sounding like a person and sounding like a log file.
 */
export function formatRelativeDays(days: number, locale: Lang): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const magnitude = Math.abs(days);

  if (magnitude < DAYS_BEFORE_WEEKS) return rtf.format(days, 'day');
  if (magnitude < DAYS_BEFORE_MONTHS) return rtf.format(Math.round(days / DAYS_PER_WEEK), 'week');
  return rtf.format(Math.round(days / DAYS_PER_MONTH), 'month');
}
