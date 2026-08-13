/**
 * Person and Fact operations.
 *
 * The People module's whole job is to make a relationship resurface before it lapses, so the
 * interesting code here is not the CRUD — it is keeping exactly one cadence trigger per person
 * in step with their interval and their last interaction. Every write that could change when
 * the next nudge is due goes back through the engine; nothing in this file touches the
 * `triggers` table.
 */

import {
  db,
  type EpochMs,
  type Entry,
  type Fact,
  type FactKind,
  type ID,
  type Person,
} from '../db/schema';
import { loadSettings } from '../db/settings';
import { cadenceOverdueDays, DEFAULT_CADENCE_MINUTE_OF_DAY, MIN_CADENCE_DAYS } from '../engine/cadence';
import {
  cancelTrigger,
  recomputeCadenceForPerson,
  recordTriggerResponse,
  registerTrigger,
  type RegisterOutcome,
} from '../engine/index';
import { lookupTokens, matchPeopleInEntry } from './match';


export interface CreatePersonInput {
  name: string;
  aliases?: readonly string[];
  cadenceDays?: number | null;
}

/**
 * Splits the comma-separated alias field a user types into stored aliases.
 *
 * Exported because the People form needs to render the round trip, and a field whose parse and
 * its display disagree is the kind of thing that quietly eats an alias.
 */
export function parseAliases(raw: string): string[] {
  return [...new Set(raw.split(',').map((part) => part.trim()).filter(Boolean))];
}

export function formatAliases(aliases: readonly string[]): string {
  return aliases.join(', ');
}

export async function createPerson(input: CreatePersonInput): Promise<Person> {
  const person: Person = {
    id: crypto.randomUUID(),
    name: input.name.trim(),
    aliases: [...(input.aliases ?? [])],
    cadenceDays: normaliseCadence(input.cadenceDays ?? null),
    lastInteractionAt: null,
    createdAt: Date.now(),
  };
  await db.people.add(person);
  if (person.cadenceDays !== null) await armCadence(person);
  return person;
}

function normaliseCadence(days: number | null): number | null {
  if (days === null || !Number.isFinite(days) || days <= 0) return null;
  return Math.max(MIN_CADENCE_DAYS, Math.round(days));
}

/**
 * Updates a person, re-arming their cadence only if the interval itself changed.
 *
 * A rename deliberately leaves the trigger alone. Notification text is composed from the person
 * at delivery time, so there is no stale copy of the name to repair — re-arming would reset the
 * schedule for no reason and lose the pending nudge's place in the day's cap budget.
 *
 * Returns the scheduling outcome when a cadence was armed, so the caller can tell the user if
 * quiet hours or the cap refused it, and `null` when nothing about the timing changed.
 */
export async function updatePerson(
  id: ID,
  patch: Partial<Pick<Person, 'name' | 'aliases' | 'cadenceDays'>>,
): Promise<RegisterOutcome | null> {
  const existing = await db.people.get(id);
  if (!existing) return null;

  const next: Person = {
    ...existing,
    ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
    ...(patch.aliases !== undefined ? { aliases: [...patch.aliases] } : {}),
    ...(patch.cadenceDays !== undefined
      ? { cadenceDays: normaliseCadence(patch.cadenceDays) }
      : {}),
  };
  await db.people.put(next);

  const cadenceChanged = next.cadenceDays !== existing.cadenceDays;
  if (!cadenceChanged) return null;

  if (next.cadenceDays === null) {
    await recomputeCadenceForPerson(id); // deactivates the pending nudge
    return null;
  }
  return armCadence(next);
}

/**
 * Creates or replaces the person's single cadence trigger.
 *
 * One per person, enforced by cancelling any existing one first. Two cadence triggers on the
 * same person would both fire, and the daily cap would then be spent on duplicate nudges about
 * one relationship.
 */
async function armCadence(person: Person): Promise<RegisterOutcome> {
  await clearCadenceTriggers(person.id);
  const settings = await loadSettings();
  return registerTrigger({
    targetType: 'person',
    targetId: person.id,
    condition: {
      kind: 'cadence',
      personId: person.id,
      days: person.cadenceDays ?? MIN_CADENCE_DAYS,
      atMinuteOfDay: DEFAULT_CADENCE_MINUTE_OF_DAY,
      timezone: settings.timezone,
    },
    link: { fromType: 'person', fromId: person.id, relation: 'about' },
  });
}

async function clearCadenceTriggers(personId: ID): Promise<void> {
  const triggers = await db.triggers
    .where('[targetType+targetId]')
    .equals(['person', personId])
    .toArray();
  for (const trigger of triggers) {
    if (trigger.kind === 'cadence' && trigger.active) await cancelTrigger(trigger.id);
  }
}

/**
 * Records that contact happened, which is what closes the cadence loop.
 *
 * Three things in one action, deliberately: the interaction is stored, the pending nudge is
 * marked as acted on so the response log reflects that the reminder worked, and the cadence is
 * recomputed so the next one is due an interval from *now* rather than from the last nudge.
 */
export async function logInteraction(personId: ID, at: EpochMs = Date.now()): Promise<void> {
  const person = await db.people.get(personId);
  if (!person) return;

  await db.people.put({ ...person, lastInteractionAt: at });

  // Attribute the check-in to the nudge that prompted it, if one had fired. `recordTriggerResponse`
  // is a no-op when nothing is outstanding, so this is safe for a check-in logged unprompted.
  for (const trigger of await db.triggers
    .where('[targetType+targetId]')
    .equals(['person', personId])
    .toArray()) {
    if (trigger.kind === 'cadence') await recordTriggerResponse(trigger.id, 'acted');
  }

  await recomputeCadenceForPerson(personId);
}

/** Removes a person, their facts and their pending nudge. */
export async function deletePerson(id: ID): Promise<void> {
  await clearCadenceTriggers(id);
  await db.transaction('rw', db.people, db.facts, async () => {
    await db.facts.where('personId').equals(id).delete();
    await db.people.delete(id);
  });
}

// ---------------------------------------------------------------- facts

export interface CreateFactInput {
  personId: ID;
  body: string;
  kind: FactKind;
  /** Present when the fact was lifted out of something the user had already written down. */
  sourceEntryId?: ID | null;
  /** Below 1 only for machine-inferred facts. Anything typed by hand is certain. */
  confidence?: number;
}

export async function createFact(input: CreateFactInput): Promise<Fact> {
  const fact: Fact = {
    id: crypto.randomUUID(),
    personId: input.personId,
    body: input.body.trim(),
    kind: input.kind,
    confidence: input.confidence ?? 1,
    sourceEntryId: input.sourceEntryId ?? null,
    createdAt: Date.now(),
  };
  await db.facts.add(fact);
  return fact;
}

export async function updateFact(
  id: ID,
  patch: Partial<Pick<Fact, 'body' | 'kind'>>,
): Promise<void> {
  await db.facts.update(id, {
    ...(patch.body !== undefined ? { body: patch.body.trim() } : {}),
    ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
  });
}

export async function deleteFact(id: ID): Promise<void> {
  await db.facts.delete(id);
}

export async function factsFor(personId: ID): Promise<Fact[]> {
  return db.facts.where('personId').equals(personId).toArray();
}

// ---------------------------------------------------------------- reading

/**
 * Entries that name this person, newest first.
 *
 * Two-step because IndexedDB can only answer "contains any of these tokens": the index narrows
 * the candidates, then the exact conjunctive check runs in memory. A person with no usable name
 * token skips the query entirely rather than fetching the whole table to reject it.
 */
export async function entriesMentioning(person: Person, limit = 20): Promise<Entry[]> {
  const tokens = lookupTokens(person);
  if (tokens.length === 0) return [];

  // A multiEntry `anyOf` yields one row per matching token, so a two-word name returns the same
  // entry twice. `searchEntries` exploits exactly that as its relevance score; here it is a
  // duplicate, so the id is the key.
  const candidates = await db.entries.where('searchTokens').anyOf(tokens).toArray();
  const unique = new Map<ID, Entry>();
  for (const entry of candidates) {
    if (matchPeopleInEntry(entry, [person]).length > 0) unique.set(entry.id, entry);
  }

  return [...unique.values()].sort((a, b) => b.capturedAt - a.capturedAt).slice(0, limit);
}

export interface PersonStatus {
  person: Person;
  /** Whole days past due. Negative before due, `null` when not on a cadence. */
  overdueDays: number | null;
  factCount: number;
}

/**
 * Everyone, ordered by how much attention they need.
 *
 * Most-overdue first, then people on a cadence that is not yet due, then everyone else
 * alphabetically. An alphabetical list would bury the one relationship that has actually
 * lapsed, which is the only thing this screen exists to prevent.
 */
export async function peopleWithStatus(now: EpochMs = Date.now()): Promise<PersonStatus[]> {
  const [people, facts] = await Promise.all([db.people.toArray(), db.facts.toArray()]);

  const counts = new Map<ID, number>();
  for (const fact of facts) counts.set(fact.personId, (counts.get(fact.personId) ?? 0) + 1);

  return people
    .map((person) => ({
      person,
      overdueDays: cadenceOverdueDays(person, now),
      factCount: counts.get(person.id) ?? 0,
    }))
    .sort(comparePersonStatus);
}

export function comparePersonStatus(a: PersonStatus, b: PersonStatus): number {
  const aDue = a.overdueDays !== null && a.overdueDays >= 0;
  const bDue = b.overdueDays !== null && b.overdueDays >= 0;
  if (aDue !== bDue) return aDue ? -1 : 1;
  if (aDue && bDue) return (b.overdueDays ?? 0) - (a.overdueDays ?? 0);

  const aTracked = a.overdueDays !== null;
  const bTracked = b.overdueDays !== null;
  if (aTracked !== bTracked) return aTracked ? -1 : 1;
  // Within a group, closest to due first, then by name.
  if (aTracked && bTracked && a.overdueDays !== b.overdueDays) {
    return (b.overdueDays ?? 0) - (a.overdueDays ?? 0);
  }
  return a.person.name.localeCompare(b.person.name);
}
