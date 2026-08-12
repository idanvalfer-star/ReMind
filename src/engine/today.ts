/**
 * The "Today" view's data.
 *
 * There are no home-screen widgets on the web and no background execution, so the surface
 * that makes reminders feel present is the app's own first screen. It also has to carry the
 * cases push cannot: a reminder that was suppressed, one that fired while the device was
 * offline, and everything belonging to a user who never granted notification permission.
 */

import { db, type Entry, type EpochMs, type Event, type Trigger } from '../db/schema';
import { localDayKey, startOfNextLocalDay } from './time';
import type { IanaTz } from '../db/schema';

export interface TodayItem {
  trigger: Trigger;
  /** What the trigger points at, if it still exists. */
  target: { type: 'event'; event: Event } | { type: 'entry'; entry: Entry } | { type: 'unknown' };
  /** True when the fire time has passed but nothing has been delivered. */
  overdue: boolean;
}

/**
 * Active triggers due on the local day containing `now`, oldest first, including ones whose
 * time has already passed.
 *
 * Overdue items are included deliberately. A reminder whose push never arrived — no
 * permission, device offline, subscription silently dropped by iOS — is exactly what this
 * screen exists to catch. Hiding it because its moment passed would make the failure
 * invisible.
 */
export async function todayItems(timezone: IanaTz, now: EpochMs = Date.now()): Promise<TodayItem[]> {
  const dayEnd = startOfNextLocalDay(now, timezone);
  const today = localDayKey(now, timezone);

  const due = await db.triggers
    .where('[active+nextFireAt]')
    .between([1, 0], [1, dayEnd], true, false)
    .toArray();

  const items = await Promise.all(
    due
      // The index range starts at 0, so filter to the local day rather than all of history.
      .filter((trigger) => localDayKey(trigger.nextFireAt as EpochMs, timezone) === today)
      .map(async (trigger): Promise<TodayItem> => {
        const overdue = (trigger.nextFireAt as EpochMs) <= now && trigger.lastFiredAt === null;
        if (trigger.targetType === 'event') {
          const event = await db.events.get(trigger.targetId);
          return { trigger, target: event ? { type: 'event', event } : { type: 'unknown' }, overdue };
        }
        if (trigger.targetType === 'entry') {
          const entry = await db.entries.get(trigger.targetId);
          return { trigger, target: entry ? { type: 'entry', entry } : { type: 'unknown' }, overdue };
        }
        return { trigger, target: { type: 'unknown' }, overdue };
      }),
  );

  return items.sort((a, b) => (a.trigger.nextFireAt ?? 0) - (b.trigger.nextFireAt ?? 0));
}
