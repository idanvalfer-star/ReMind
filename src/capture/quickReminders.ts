/**
 * The preset times offered when a capture is a task but names no time.
 *
 * "Call Dani" is the archetypal actionable capture and it carries no date at all, so an offer
 * that only appears when a time was parsed would miss the main case. Rather than open a time
 * picker — a lot of interface for a one-tap affordance — three presets cover most of what people
 * actually pick.
 *
 * Pure and clock-injected, so the boundary behaviour is testable rather than a thing that only
 * misbehaves at 23:50.
 */

import type { EpochMs, IanaTz } from '../db/schema';
import { atLocalMinutesOnDayOf, HOUR_MS, startOfNextLocalDay } from '../engine/time';

export type QuickReminderId = 'inAnHour' | 'thisEvening' | 'tomorrowMorning' | 'atParsedTime';

export interface QuickReminder {
  id: QuickReminderId;
  at: EpochMs;
}

const EVENING_MINUTES = 19 * 60;
const MORNING_MINUTES = 9 * 60;

/**
 * Builds the offers that make sense right now.
 *
 * "This evening" is omitted once evening has passed — an option that silently means tomorrow is
 * worse than one fewer option. `parsedAt` is included first when the capture named a time, since
 * the user's own words beat any preset.
 */
export function quickReminders(
  now: EpochMs,
  timezone: IanaTz,
  parsedAt?: EpochMs | null,
): QuickReminder[] {
  const offers: QuickReminder[] = [];

  if (parsedAt != null && parsedAt > now) {
    offers.push({ id: 'atParsedTime', at: parsedAt });
  }

  offers.push({ id: 'inAnHour', at: now + HOUR_MS });

  const evening = atLocalMinutesOnDayOf(now, timezone, EVENING_MINUTES);
  if (evening > now) offers.push({ id: 'thisEvening', at: evening });

  offers.push({
    id: 'tomorrowMorning',
    at: atLocalMinutesOnDayOf(startOfNextLocalDay(now, timezone), timezone, MORNING_MINUTES),
  });

  return offers;
}
