/**
 * The "Today" view's data.
 *
 * There are no home-screen widgets on the web and no background execution, so the surface
 * that makes reminders feel present is the app's own first screen. It also has to carry the
 * cases push cannot: a reminder that was suppressed, one that fired while the device was
 * offline, and everything belonging to a user who never granted notification permission.
 */

import { db, type Entry, type EpochMs, type Trigger } from '../db/schema';
import type { NotificationTarget } from './notify';
import { resolveTriggerTarget } from './target';
import { localDayKey, startOfNextLocalDay } from './time';
import type { IanaTz } from '../db/schema';

export interface TodayItem {
  trigger: Trigger;
  /**
   * What the trigger points at, if it still exists. The same shape the notification composer
   * takes, so the screen and the push cannot describe a reminder differently.
   */
  target: NotificationTarget;
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
/**
 * Whether a trigger belongs in the scheduled-reminders list.
 *
 * Two kinds are deliberately excluded because they have their own surface, and showing them here is
 * actively misleading rather than merely redundant:
 *
 * - **`spaced`** triggers are a review schedule, not a delivery. One due today has never "fired", so
 *   it would render as an *overdue reminder that was missed* — describing the review queue working
 *   exactly as designed as a failure of the notification system.
 * - **The digest** is the notification *about* that queue. Listing it next to the queue's own card is
 *   telling the user the same thing twice, once as a piece of plumbing.
 */
function isSurfacedHere(trigger: Trigger): boolean {
  return trigger.kind !== 'spaced' && trigger.targetType !== 'digest';
}

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
      .filter(isSurfacedHere)
      .map(async (trigger): Promise<TodayItem> => ({
        trigger,
        target: await resolveTriggerTarget(trigger),
        overdue: (trigger.nextFireAt as EpochMs) <= now && trigger.lastFiredAt === null,
      })),
  );

  return items.sort((a, b) => (a.trigger.nextFireAt ?? 0) - (b.trigger.nextFireAt ?? 0));
}

/**
 * Recent captures with nothing scheduled against them.
 *
 * The counterpart to `todayItems`: notes that were written down and then never turned into an event
 * or a reminder. They are the things most likely to be genuinely forgotten, since nothing will ever
 * resurface them on its own — which makes them worth a place on the first screen.
 *
 * "Nothing scheduled" means no outgoing `Link`. An Entry that became an Event, or that produced a
 * reminder, has one; a bare note does not.
 */
export async function unscheduledEntries(limit = 6): Promise<Entry[]> {
  // Newest first, and only a page of them: this is a glance, not an inbox.
  const recent = await db.entries.orderBy('capturedAt').reverse().limit(limit * 4).toArray();
  if (recent.length === 0) return [];

  const linked = new Set<string>();
  const edges = await db.links
    .where('[fromType+fromId]')
    .anyOf(recent.map((entry) => ['entry', entry.id] as [string, string]))
    .toArray();
  for (const edge of edges) linked.add(edge.fromId);

  return recent.filter((entry) => !linked.has(entry.id)).slice(0, limit);
}
