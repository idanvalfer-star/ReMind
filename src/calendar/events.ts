/**
 * Calendar reads and writes.
 *
 * The query is an *overlap* query, not a containment one, so a multi-day event appears on every
 * day it touches rather than only on the day it starts. That distinction is the difference
 * between a calendar and a list of start times.
 *
 * Writes go through here so that editing an event also fixes the reminders hanging off it —
 * changing a dinner from 8pm to 9pm has to move the "leave in 30 minutes" trigger with it, or the
 * reminder quietly becomes wrong. That is the cross-module behaviour the brief calls the product.
 */

import {
  db,
  type EpochMs,
  type Event,
  type IanaTz,
  type ID,
} from '../db/schema';
import { cancelTrigger, recomputeTriggersForEvent } from '../engine/index';
import { localDayKey, startOfNextLocalDay } from '../engine/time';

/** Events overlapping `[from, to)`, earliest first. */
export async function eventsBetween(from: EpochMs, to: EpochMs): Promise<Event[]> {
  // Indexed on endAt, then filtered on startAt: an event overlaps the window if it ends after the
  // window opens and starts before it closes.
  const candidates = await db.events.where('endAt').above(from).toArray();
  return candidates
    .filter((event) => event.startAt < to)
    .sort((a, b) => a.startAt - b.startAt);
}

/**
 * Buckets events by every local day they touch.
 *
 * An event spanning three days appears under three keys, which is what a month grid needs.
 */
export function groupByLocalDay(
  events: readonly Event[],
  timezone: IanaTz,
): Map<string, Event[]> {
  const byDay = new Map<string, Event[]>();

  for (const event of events) {
    // Walk day by day from the start to the last day the event is still running. `endAt` is
    // exclusive, so an event finishing exactly at midnight does not claim the next day.
    let cursor = event.startAt;
    const lastInstant = Math.max(event.startAt, event.endAt - 1);
    let guard = 0;

    while (cursor <= lastInstant && guard++ < 400) {
      const key = localDayKey(cursor, timezone);
      const bucket = byDay.get(key);
      if (bucket) bucket.push(event);
      else byDay.set(key, [event]);

      cursor = startOfNextLocalDay(cursor, timezone);
    }
  }

  return byDay;
}

export interface EventInput {
  title: string;
  startAt: EpochMs;
  endAt: EpochMs;
  timezone: IanaTz;
  isAllDay: boolean;
  travelBufferMinutes?: number;
  isPrivate?: boolean;
  sourceEntryId?: ID | null;
}

export async function createCalendarEvent(
  input: EventInput,
  now: EpochMs = Date.now(),
): Promise<Event> {
  const event: Event = {
    id: crypto.randomUUID(),
    title: input.title,
    startAt: input.startAt,
    endAt: input.endAt,
    timezone: input.timezone,
    isAllDay: input.isAllDay,
    location: null,
    travelBufferMinutes: input.travelBufferMinutes ?? 0,
    isPrivate: input.isPrivate ?? false,
    sourceEntryId: input.sourceEntryId ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await db.events.add(event);
  return event;
}

/**
 * Updates an event and moves its reminders with it.
 *
 * The trigger recomputation is the point. Without it, editing the time leaves every
 * `event-adjacent` reminder pointing at the old instant — and a reminder that fires at the wrong
 * time is worse than none, because it is silently wrong rather than visibly absent.
 */
export async function updateCalendarEvent(
  eventId: ID,
  patch: Partial<EventInput>,
  now: EpochMs = Date.now(),
): Promise<void> {
  const existing = await db.events.get(eventId);
  if (!existing) return;

  await db.events.update(eventId, { ...patch, updatedAt: now });

  const timingChanged =
    (patch.startAt !== undefined && patch.startAt !== existing.startAt) ||
    (patch.travelBufferMinutes !== undefined &&
      patch.travelBufferMinutes !== existing.travelBufferMinutes);

  if (timingChanged) await recomputeTriggersForEvent(eventId);
}

/**
 * Deletes an event and retires its reminders.
 *
 * Triggers are cancelled rather than deleted, so the delivery history keeps its subject. Any
 * `Entry` that produced the event survives untouched — deleting a calendar entry is not a request
 * to forget what was written.
 */
export async function deleteCalendarEvent(eventId: ID): Promise<void> {
  const triggers = await db.triggers
    .where('[targetType+targetId]')
    .equals(['event', eventId])
    .toArray();
  for (const trigger of triggers) await cancelTrigger(trigger.id);

  const edges = await db.links.where('[toType+toId]').equals(['event', eventId]).toArray();
  await db.transaction('rw', db.events, db.links, async () => {
    await db.links.bulkDelete(edges.map((edge) => edge.id));
    await db.events.delete(eventId);
  });
}
