/**
 * Reads whatever a trigger points at.
 *
 * Shared by the service worker (composing a notification), the Today screen (rendering the
 * same reminder in-app) and the response log. It lives here rather than being repeated at each
 * site because the two surfaces must never disagree about what a reminder is *about* — a push
 * that says one thing and a screen that says another is worse than either alone, and adding a
 * target type in three places means eventually adding it in two.
 */

import { db, type Event, type Trigger } from '../db/schema';
import { buildBriefing, groupFactsByPerson, type PersonFacts } from '../people/briefing';
import { stageIdAt } from '../trips/stages';
import type { NotificationTarget } from './notify';

/**
 * The target for a trigger, or `{ type: 'unknown' }` when it has gone.
 *
 * Missing is an ordinary outcome, not an error: iOS evicts IndexedDB, imports can be partial,
 * and a push can arrive for something the user deleted a minute earlier. Every caller has to
 * render *something*, so this never throws and never returns null.
 */
export async function resolveTriggerTarget(trigger: Trigger): Promise<NotificationTarget> {
  switch (trigger.targetType) {
    case 'event': {
      const event = await db.events.get(trigger.targetId);
      if (!event) return { type: 'unknown' };
      return { type: 'event', event, attendees: await attendeesOf(event) };
    }

    case 'entry': {
      const entry = await db.entries.get(trigger.targetId);
      return entry ? { type: 'entry', entry } : { type: 'unknown' };
    }

    case 'person': {
      const person = await db.people.get(trigger.targetId);
      if (!person) return { type: 'unknown' };
      // Facts come along because the whole value of a check-in nudge is having something to
      // say. Fetched here rather than by the caller so the service worker's one round trip
      // through IndexedDB gets everything it needs.
      const facts = await db.facts.where('personId').equals(person.id).toArray();
      return { type: 'person', person, facts };
    }

    case 'trip': {
      const trip = await db.trips.get(trigger.targetId);
      if (!trip) return { type: 'unknown' };
      // The stage is derived from the trip's *current* dates and this trigger's fire time, so
      // moving a trip re-labels its pending reminders instead of leaving them lying about the day.
      const at = trigger.nextFireAt ?? trigger.lastFiredAt ?? Date.now();
      return { type: 'trip', trip, stage: stageIdAt(trip, at) };
    }

    default:
      return { type: 'unknown' };
  }
}

/**
 * People the event's title names, with facts, or an empty list.
 *
 * Short-circuits before touching `facts` when there are no people at all, which is the state
 * this returns to for anyone who never uses the People module — the cost of the feature for them
 * is one empty-table read.
 */
async function attendeesOf(event: Event): Promise<readonly PersonFacts[] | undefined> {
  const people = await db.people.toArray();
  if (people.length === 0) return undefined;

  const facts = await db.facts.toArray();
  if (facts.length === 0) return undefined;

  return buildBriefing(event, people, groupFactsByPerson(facts))?.people;
}
