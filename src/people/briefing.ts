/**
 * What you should know before a meeting.
 *
 * The brief calls this "calendar→person surfacing", and it is the clearest example of the core
 * thesis in the whole app: the fact that Alex drinks his coffee black is worthless sitting in a
 * list of people, and valuable in the ten minutes before you meet him. Same fragment, different
 * moment.
 *
 * People are matched from the event's *title* rather than from a stored attendee list. That is a
 * deliberate trade. An explicit attendee field would be more precise and would also be one more
 * thing to maintain on every event — and "Dinner with Alex" already contains the answer. When it
 * guesses wrong, the fix is an alias on the person, which is a knob the user already has for
 * other reasons.
 */

import type { Event, Fact, ID, Person } from '../db/schema';
import { db } from '../db/schema';
import { rankFacts } from '../engine/notify';
import { matchPeopleIn } from './match';

/** A person the event appears to involve, with what is worth recalling about them. */
export interface PersonFacts {
  person: Person;
  /** Ordered by how worth surfacing they are — see `rankFacts`. */
  facts: readonly Fact[];
}

export interface Briefing {
  event: Event;
  people: readonly PersonFacts[];
}

/**
 * Builds a briefing, or `null` when there is nothing worth saying.
 *
 * Returning `null` rather than an empty briefing is the point: a "Before you meet Alex" card
 * that lists nothing about Alex is noise, and this surface has to earn its place on the first
 * screen. A matched person with no recorded facts contributes nothing.
 */
export function buildBriefing(
  event: Event,
  people: readonly Person[],
  factsByPerson: ReadonlyMap<ID, readonly Fact[]>,
): Briefing | null {
  // A private event's title is exactly what the user asked not to have surfaced, so it is not
  // mined for names either.
  if (event.isPrivate) return null;

  const matched = matchPeopleIn(event.title, people);
  if (matched.length === 0) return null;

  const byId = new Map(people.map((person) => [person.id, person]));
  const withFacts: PersonFacts[] = [];
  for (const id of matched) {
    const person = byId.get(id);
    const facts = factsByPerson.get(id) ?? [];
    if (person && facts.length > 0) withFacts.push({ person, facts: rankFacts(facts) });
  }

  return withFacts.length > 0 ? { event, people: withFacts } : null;
}

/** Groups facts by person, for the map `buildBriefing` takes. */
export function groupFactsByPerson(facts: readonly Fact[]): Map<ID, Fact[]> {
  const grouped = new Map<ID, Fact[]>();
  for (const fact of facts) {
    const list = grouped.get(fact.personId);
    if (list) list.push(fact);
    else grouped.set(fact.personId, [fact]);
  }
  return grouped;
}

/**
 * Briefings for every event overlapping a window, soonest first.
 *
 * Reads all people and facts in one pass rather than querying per event. Both tables are small
 * by nature — they hold the people someone chooses to keep track of — and a per-event query
 * would be N round trips through IndexedDB to answer a question about a handful of rows.
 */
export async function briefingsBetween(from: number, to: number): Promise<Briefing[]> {
  const [events, people, facts] = await Promise.all([
    db.events.where('startAt').between(from, to, true, false).toArray(),
    db.people.toArray(),
    db.facts.toArray(),
  ]);
  if (people.length === 0 || facts.length === 0) return [];

  const grouped = groupFactsByPerson(facts);
  return events
    .sort((a, b) => a.startAt - b.startAt)
    .map((event) => buildBriefing(event, people, grouped))
    .filter((briefing): briefing is Briefing => briefing !== null);
}
