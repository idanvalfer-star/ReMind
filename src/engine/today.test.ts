import { beforeEach, describe, expect, it } from 'vitest';
import { db, type Trigger } from '../db/schema';
import { todayItems } from './today';
import { zonedWallClockToEpoch } from './time';

const JLM = 'Asia/Jerusalem';
const local = (day: number, hour: number, minute = 0) =>
  zonedWallClockToEpoch({ year: 2026, month: 6, day, hour, minute }, JLM);

async function addTrigger(overrides: Partial<Trigger> = {}): Promise<Trigger> {
  const trigger: Trigger = {
    id: crypto.randomUUID(),
    targetType: 'entry',
    targetId: 'missing',
    kind: 'time',
    condition: { kind: 'time', at: local(10, 12), timezone: JLM },
    nextFireAt: local(10, 12),
    lastFiredAt: null,
    active: 1,
    snoozedUntil: null,
    location: null,
    syncedFireAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
  await db.triggers.add(trigger);
  return trigger;
}

beforeEach(async () => {
  await db.open();
  await Promise.all([db.triggers.clear(), db.entries.clear(), db.events.clear()]);
});

describe('todayItems', () => {
  it('returns the local day’s triggers in time order', async () => {
    await addTrigger({ nextFireAt: local(10, 18) });
    await addTrigger({ nextFireAt: local(10, 9) });
    await addTrigger({ nextFireAt: local(10, 13) });

    const items = await todayItems(JLM, local(10, 8));
    expect(items.map((i) => i.trigger.nextFireAt)).toEqual([
      local(10, 9),
      local(10, 13),
      local(10, 18),
    ]);
  });

  it('excludes other days, using local boundaries', async () => {
    await addTrigger({ nextFireAt: local(9, 23, 30) });
    await addTrigger({ nextFireAt: local(10, 0, 30) });
    await addTrigger({ nextFireAt: local(10, 23, 30) });
    await addTrigger({ nextFireAt: local(11, 0, 30) });

    const items = await todayItems(JLM, local(10, 12));
    expect(items.map((i) => i.trigger.nextFireAt)).toEqual([local(10, 0, 30), local(10, 23, 30)]);
  });

  it('includes reminders whose time has passed, flagged overdue', async () => {
    // The whole point of this screen: a push that never arrived — no permission, device
    // offline, subscription silently dropped by iOS — must still be visible.
    await addTrigger({ nextFireAt: local(10, 9) });
    const items = await todayItems(JLM, local(10, 15));

    expect(items).toHaveLength(1);
    expect(items[0]!.overdue).toBe(true);
  });

  it('does not flag a reminder that has already been delivered', async () => {
    await addTrigger({ nextFireAt: local(10, 9), lastFiredAt: local(10, 9) });
    const items = await todayItems(JLM, local(10, 15));
    expect(items[0]!.overdue).toBe(false);
  });

  it('does not flag a reminder that is still in the future', async () => {
    await addTrigger({ nextFireAt: local(10, 18) });
    const items = await todayItems(JLM, local(10, 15));
    expect(items[0]!.overdue).toBe(false);
  });

  it('excludes cancelled and unscheduled triggers', async () => {
    await addTrigger({ nextFireAt: local(10, 12), active: 0 });
    await addTrigger({ nextFireAt: null });
    expect(await todayItems(JLM, local(10, 8))).toEqual([]);
  });

  it('resolves entry and event targets, and survives a missing one', async () => {
    await db.entries.add({
      id: 'e1',
      body: 'Call the dentist',
      rawInput: 'Call the dentist',
      capturedAt: 0,
      source: 'text',
      language: 'en',
      searchTokens: [],
    });
    await db.events.add({
      id: 'v1',
      title: 'Dinner',
      startAt: local(10, 20),
      endAt: local(10, 22),
      timezone: JLM,
      isAllDay: false,
      location: null,
      travelBufferMinutes: 0,
      isPrivate: false,
      sourceEntryId: null,
      createdAt: 0,
      updatedAt: 0,
    });

    await addTrigger({ nextFireAt: local(10, 9), targetType: 'entry', targetId: 'e1' });
    await addTrigger({ nextFireAt: local(10, 10), targetType: 'event', targetId: 'v1' });
    await addTrigger({ nextFireAt: local(10, 11), targetType: 'entry', targetId: 'gone' });

    const items = await todayItems(JLM, local(10, 8));
    expect(items.map((i) => i.target.type)).toEqual(['entry', 'event', 'unknown']);
  });

  it('is empty when nothing is scheduled', async () => {
    expect(await todayItems(JLM, local(10, 8))).toEqual([]);
  });
});
