import { beforeEach, describe, expect, it } from 'vitest';
import { db, type Entry, type Settings } from '../db/schema';
import { defaultSettings } from '../db/settings';
import { tokenize } from '../db/tokenize';
import { DAY_MS, minutesOfDay } from '../engine/time';
import { DEFAULT_CADENCE_MINUTE_OF_DAY } from '../engine/cadence';
import {
  comparePersonStatus,
  createFact,
  createPerson,
  deleteFact,
  deletePerson,
  entriesMentioning,
  factsFor,
  formatAliases,
  logInteraction,
  parseAliases,
  peopleWithStatus,
  updateFact,
  updatePerson,
} from './people';

const JLM = 'Asia/Jerusalem';

async function settings(overrides: Partial<Settings> = {}): Promise<void> {
  await db.settings.put({ ...defaultSettings(), timezone: JLM, ...overrides });
}

async function addEntry(body: string, capturedAt: number): Promise<Entry> {
  const entry: Entry = {
    id: crypto.randomUUID(),
    body,
    rawInput: body,
    capturedAt,
    source: 'text',
    language: 'en',
    searchTokens: tokenize(body),
  };
  await db.entries.add(entry);
  return entry;
}

/** The person's live cadence trigger, if any. */
async function cadenceTriggerFor(personId: string) {
  const triggers = await db.triggers
    .where('[targetType+targetId]')
    .equals(['person', personId])
    .toArray();
  return triggers.find((trigger) => trigger.kind === 'cadence' && trigger.active === 1);
}

beforeEach(async () => {
  await db.open();
  await Promise.all([
    db.people.clear(),
    db.facts.clear(),
    db.entries.clear(),
    db.triggers.clear(),
    db.links.clear(),
    db.triggerFires.clear(),
    db.settings.clear(),
    db.pushRegistration.clear(),
  ]);
  await settings();
});

describe('parseAliases / formatAliases', () => {
  it('round trips a comma separated field', () => {
    expect(parseAliases('Ali, Cohen , ')).toEqual(['Ali', 'Cohen']);
    expect(formatAliases(['Ali', 'Cohen'])).toBe('Ali, Cohen');
  });

  it('deduplicates rather than storing the same alias twice', () => {
    expect(parseAliases('Ali, Ali')).toEqual(['Ali']);
  });

  it('is empty for an empty field', () => {
    expect(parseAliases('   ')).toEqual([]);
  });
});

describe('createPerson', () => {
  it('stores a person with no cadence and arms no trigger', async () => {
    const person = await createPerson({ name: '  Sarah  ' });
    expect(person.name).toBe('Sarah');
    expect(person.cadenceDays).toBeNull();
    expect(await cadenceTriggerFor(person.id)).toBeUndefined();
  });

  it('arms exactly one cadence trigger when an interval is given', async () => {
    const person = await createPerson({ name: 'Sarah', cadenceDays: 14 });
    const trigger = await cadenceTriggerFor(person.id);

    expect(trigger).toBeDefined();
    expect(trigger?.condition).toMatchObject({ kind: 'cadence', personId: person.id, days: 14 });
    expect(minutesOfDay(trigger!.nextFireAt!, JLM)).toBe(DEFAULT_CADENCE_MINUTE_OF_DAY);
  });

  it('rejects a nonsensical interval instead of scheduling a nudge every zero days', async () => {
    for (const days of [0, -5, Number.NaN]) {
      const person = await createPerson({ name: `P${days}`, cadenceDays: days });
      expect(person.cadenceDays).toBeNull();
      expect(await cadenceTriggerFor(person.id)).toBeUndefined();
    }
  });

  it('rounds a fractional interval to whole days', async () => {
    const person = await createPerson({ name: 'Sarah', cadenceDays: 6.7 });
    expect(person.cadenceDays).toBe(7);
  });
});

describe('updatePerson', () => {
  it('arms a cadence when one is switched on', async () => {
    const person = await createPerson({ name: 'Sarah' });
    await updatePerson(person.id, { cadenceDays: 7 });
    expect(await cadenceTriggerFor(person.id)).toBeDefined();
  });

  it('deactivates the nudge when the cadence is switched off', async () => {
    const person = await createPerson({ name: 'Sarah', cadenceDays: 7 });
    expect(await cadenceTriggerFor(person.id)).toBeDefined();

    await updatePerson(person.id, { cadenceDays: null });
    expect(await cadenceTriggerFor(person.id)).toBeUndefined();
  });

  it('keeps exactly one live cadence trigger after repeated interval changes', async () => {
    // Two live cadence triggers on one person would both fire, and the daily cap would go on
    // duplicate nudges about a single relationship.
    const person = await createPerson({ name: 'Sarah', cadenceDays: 7 });
    await updatePerson(person.id, { cadenceDays: 14 });
    await updatePerson(person.id, { cadenceDays: 30 });

    const all = await db.triggers.where('[targetType+targetId]').equals(['person', person.id]).toArray();
    expect(all.filter((trigger) => trigger.active === 1)).toHaveLength(1);
    expect((await cadenceTriggerFor(person.id))?.condition).toMatchObject({ days: 30 });
  });

  it('does not re-arm when only the name changes', async () => {
    const person = await createPerson({ name: 'Sarah', cadenceDays: 7 });
    const before = await cadenceTriggerFor(person.id);

    await updatePerson(person.id, { name: 'Sarah Levi' });
    const after = await cadenceTriggerFor(person.id);

    // Same trigger row: notification text is composed from the person at delivery time, so a
    // rename has nothing stale to fix.
    expect(after?.id).toBe(before?.id);
    expect((await db.people.get(person.id))?.name).toBe('Sarah Levi');
  });

  it('returns null for a person that no longer exists', async () => {
    expect(await updatePerson('missing', { cadenceDays: 7 })).toBeNull();
  });
});

describe('logInteraction', () => {
  it('records the interaction and pushes the next nudge out by an interval', async () => {
    const person = await createPerson({ name: 'Sarah', cadenceDays: 7 });
    const before = (await cadenceTriggerFor(person.id))!.nextFireAt!;

    // Three days after being added, which is the realistic shape: the anchor moves forward, so
    // the next nudge does too. Logging a check-in the same instant the person was created is
    // correctly a no-op, since the anchor was already now.
    const spokeAt = Date.now() + 3 * DAY_MS;
    await logInteraction(person.id, spokeAt);

    expect((await db.people.get(person.id))?.lastInteractionAt).toBe(spokeAt);

    const after = (await cadenceTriggerFor(person.id))!.nextFireAt!;
    expect(after - before).toBeGreaterThanOrEqual(2 * DAY_MS);
    expect(after).toBeGreaterThan(spokeAt);
  });

  it('is a no-op on the nudge when the anchor has not moved', async () => {
    const person = await createPerson({ name: 'Sarah', cadenceDays: 7 });
    const before = (await cadenceTriggerFor(person.id))!.nextFireAt!;

    await logInteraction(person.id, Date.now());
    expect((await cadenceTriggerFor(person.id))!.nextFireAt).toBe(before);
  });

  it('attributes the check-in to the nudge that prompted it', async () => {
    const person = await createPerson({ name: 'Sarah', cadenceDays: 7 });
    const trigger = (await cadenceTriggerFor(person.id))!;

    // Simulate the push having been delivered.
    await db.triggerFires.add({
      id: crypto.randomUUID(),
      triggerId: trigger.id,
      firedAt: Date.now() - 1000,
      deliveredVia: 'push',
      lookupFailed: 0,
      response: 'none',
      respondedAt: null,
    });

    await logInteraction(person.id);
    const fires = await db.triggerFires.where('triggerId').equals(trigger.id).toArray();
    expect(fires[0]?.response).toBe('acted');
  });

  it('is safe for a check-in logged with no nudge outstanding', async () => {
    const person = await createPerson({ name: 'Sarah', cadenceDays: 7 });
    await expect(logInteraction(person.id)).resolves.toBeUndefined();
  });

  it('does nothing for an unknown person', async () => {
    await expect(logInteraction('missing')).resolves.toBeUndefined();
  });
});

describe('deletePerson', () => {
  it('removes the person, their facts and their nudge', async () => {
    const person = await createPerson({ name: 'Sarah', cadenceDays: 7 });
    await createFact({ personId: person.id, body: 'likes tea', kind: 'preference' });

    await deletePerson(person.id);

    expect(await db.people.get(person.id)).toBeUndefined();
    expect(await factsFor(person.id)).toEqual([]);
    expect(await cadenceTriggerFor(person.id)).toBeUndefined();
  });
});

describe('facts', () => {
  it('creates, updates and deletes', async () => {
    const person = await createPerson({ name: 'Sarah' });
    const fact = await createFact({
      personId: person.id,
      body: '  drinks oat lattes  ',
      kind: 'preference',
    });
    expect(fact.body).toBe('drinks oat lattes');
    expect(fact.confidence).toBe(1);

    await updateFact(fact.id, { kind: 'gift-idea', body: 'wants a tea set' });
    const [updated] = await factsFor(person.id);
    expect(updated).toMatchObject({ kind: 'gift-idea', body: 'wants a tea set' });

    await deleteFact(fact.id);
    expect(await factsFor(person.id)).toEqual([]);
  });
});

describe('entriesMentioning', () => {
  it('finds notes naming the person, newest first', async () => {
    const person = await createPerson({ name: 'Sarah' });
    await addEntry('Sarah loved the vase', 1000);
    await addEntry('call Sarah back', 3000);
    await addEntry('buy milk', 2000);

    const found = await entriesMentioning(person);
    expect(found.map((entry) => entry.body)).toEqual(['call Sarah back', 'Sarah loved the vase']);
  });

  it('finds notes written before the person was added', async () => {
    // The reason mentions are derived rather than tagged at capture time.
    await addEntry("Sarah's birthday is in June", 1000);
    const person = await createPerson({ name: 'Sarah' });
    expect(await entriesMentioning(person)).toHaveLength(1);
  });

  it('requires every word of a two-word name', async () => {
    const person = await createPerson({ name: 'Alex Cohen' });
    await addEntry('lunch with Alex', 1000);
    await addEntry('lunch with Alex Cohen', 2000);

    const found = await entriesMentioning(person);
    expect(found.map((entry) => entry.body)).toEqual(['lunch with Alex Cohen']);
  });

  it('matches a Hebrew note through an attached particle', async () => {
    const person = await createPerson({ name: 'שרה' });
    await addEntry('להתקשר לשרה', 1000);
    expect(await entriesMentioning(person)).toHaveLength(1);
  });

  it('skips the query entirely for a name with no usable token', async () => {
    const person = await createPerson({ name: 'J' });
    await addEntry('J called', 1000);
    expect(await entriesMentioning(person)).toEqual([]);
  });

  it('honours the limit', async () => {
    const person = await createPerson({ name: 'Sarah' });
    for (let i = 0; i < 5; i++) await addEntry(`Sarah note ${i}`, 1000 + i);
    expect(await entriesMentioning(person, 2)).toHaveLength(2);
  });
});

describe('peopleWithStatus', () => {
  it('puts the most overdue relationship first', async () => {
    const now = Date.UTC(2026, 5, 20, 12, 0);
    const slightly = await createPerson({ name: 'Slightly' });
    const badly = await createPerson({ name: 'Badly' });
    const notDue = await createPerson({ name: 'NotDue' });
    await createPerson({ name: 'Untracked' });

    await db.people.update(slightly.id, { cadenceDays: 7, lastInteractionAt: now - 8 * DAY_MS });
    await db.people.update(badly.id, { cadenceDays: 7, lastInteractionAt: now - 40 * DAY_MS });
    await db.people.update(notDue.id, { cadenceDays: 30, lastInteractionAt: now - DAY_MS });

    const statuses = await peopleWithStatus(now);
    expect(statuses.map((status) => status.person.name)).toEqual([
      'Badly',
      'Slightly',
      'NotDue',
      'Untracked',
    ]);
    expect(statuses[0]?.overdueDays).toBe(33);
    expect(statuses[3]?.overdueDays).toBeNull();
  });

  it('counts facts per person', async () => {
    const person = await createPerson({ name: 'Sarah' });
    await createFact({ personId: person.id, body: 'a', kind: 'misc' });
    await createFact({ personId: person.id, body: 'b', kind: 'misc' });

    const [status] = await peopleWithStatus();
    expect(status?.factCount).toBe(2);
  });

  it('is empty with nobody stored', async () => {
    expect(await peopleWithStatus()).toEqual([]);
  });
});

describe('comparePersonStatus', () => {
  const status = (name: string, overdueDays: number | null) => ({
    person: {
      id: name,
      name,
      aliases: [],
      cadenceDays: overdueDays === null ? null : 7,
      lastInteractionAt: null,
      createdAt: 0,
    },
    overdueDays,
    factCount: 0,
  });

  it('sorts untracked people alphabetically at the end', () => {
    const sorted = [status('Zoe', null), status('Adam', null)].sort(comparePersonStatus);
    expect(sorted.map((s) => s.person.name)).toEqual(['Adam', 'Zoe']);
  });

  it('treats due-today as due', () => {
    const sorted = [status('NotYet', -1), status('Today', 0)].sort(comparePersonStatus);
    expect(sorted.map((s) => s.person.name)).toEqual(['Today', 'NotYet']);
  });

  it('orders not-yet-due by closeness to due', () => {
    const sorted = [status('Far', -30), status('Soon', -2)].sort(comparePersonStatus);
    expect(sorted.map((s) => s.person.name)).toEqual(['Soon', 'Far']);
  });
});
