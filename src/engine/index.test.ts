import { beforeEach, describe, expect, it } from 'vitest';
import { db, type Event, type Settings } from '../db/schema';
import { defaultSettings } from '../db/settings';
import {
  cancelTrigger,
  reconcile,
  registerTrigger,
  snoozeTrigger,
  type RegisterOutcome,
} from './index';
import { zonedWallClockToEpoch } from './time';

const JLM = 'Asia/Jerusalem';
const local = (day: number, hour: number, minute = 0) =>
  zonedWallClockToEpoch({ year: 2026, month: 6, day, hour, minute }, JLM);

/**
 * These tests run with no push registration, so `mirror()` short-circuits and nothing touches
 * the network. That is a real supported state — a user who declined notifications, or never
 * installed to the home screen, still gets a working capture and calendar app — so it is
 * worth exercising as the default rather than mocking around.
 */

async function settings(overrides: Partial<Settings> = {}): Promise<void> {
  await db.settings.put({ ...defaultSettings(), timezone: JLM, ...overrides });
}

async function putEvent(overrides: Partial<Event> = {}): Promise<Event> {
  const event: Event = {
    id: crypto.randomUUID(),
    title: 'Dinner with Alex',
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
    ...overrides,
  };
  await db.events.add(event);
  return event;
}

beforeEach(async () => {
  await db.open();
  await Promise.all([
    db.triggers.clear(),
    db.events.clear(),
    db.links.clear(),
    db.settings.clear(),
    db.triggerFires.clear(),
    db.pushRegistration.clear(),
  ]);
  await settings();
});

describe('registerTrigger', () => {
  it('writes a trigger at exactly the requested time', async () => {
    const at = local(10, 15);
    const outcome = await registerTrigger({
      targetType: 'entry',
      targetId: 'entry-1',
      condition: { kind: 'time', at, timezone: JLM },
    });

    expect(outcome.kind).toBe('registered');
    if (outcome.kind !== 'registered') return;
    expect(outcome.trigger.nextFireAt).toBe(at);
    expect(outcome.trigger.active).toBe(1);
    // Nothing was mirrored, so nothing may claim to have been.
    expect(outcome.trigger.syncedFireAt).toBeNull();
    expect(await db.triggers.count()).toBe(1);
  });

  it('records the requested edge alongside the trigger', async () => {
    const outcome = await registerTrigger({
      targetType: 'entry',
      targetId: 'entry-1',
      condition: { kind: 'time', at: local(10, 15), timezone: JLM },
      link: { fromType: 'entry', fromId: 'entry-1', relation: 'reminds-of' },
    });
    if (outcome.kind !== 'registered') throw new Error('expected registration');

    const links = await db.links.where('[fromType+fromId]').equals(['entry', 'entry-1']).toArray();
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ toType: 'trigger', toId: outcome.trigger.id });
  });

  it('writes nothing when quiet hours forbid the time', async () => {
    const at = local(10, 23, 30);
    const outcome = await registerTrigger({
      targetType: 'entry',
      targetId: 'entry-1',
      condition: { kind: 'time', at, timezone: JLM },
      link: { fromType: 'entry', fromId: 'entry-1', relation: 'reminds-of' },
    });

    expect(outcome.kind).toBe('suppressed');
    if (outcome.kind !== 'suppressed') return;
    expect(outcome.reason).toBe('quiet-hours');
    expect(outcome.desiredAt).toBe(at);
    expect(outcome.suggestion).not.toBeNull();

    // Not a muted trigger, not a moved one — nothing at all, including no dangling edge.
    expect(await db.triggers.count()).toBe(0);
    expect(await db.links.count()).toBe(0);
  });

  it('writes nothing when the daily cap is spent', async () => {
    await settings({ dailyCap: 1 });
    await registerTrigger({
      targetType: 'entry',
      targetId: 'a',
      condition: { kind: 'time', at: local(10, 9), timezone: JLM },
    });

    const outcome = await registerTrigger({
      targetType: 'entry',
      targetId: 'b',
      condition: { kind: 'time', at: local(10, 15), timezone: JLM },
    });

    expect(outcome.kind).toBe('suppressed');
    if (outcome.kind === 'suppressed') expect(outcome.reason).toBe('daily-cap');
    expect(await db.triggers.count()).toBe(1);
  });

  it('counts existing triggers against the cap', async () => {
    await settings({ dailyCap: 2 });
    const results: RegisterOutcome[] = [];
    for (const hour of [9, 10, 11]) {
      results.push(
        await registerTrigger({
          targetType: 'entry',
          targetId: `e${hour}`,
          condition: { kind: 'time', at: local(10, hour), timezone: JLM },
        }),
      );
    }
    expect(results.map((r) => r.kind)).toEqual(['registered', 'registered', 'suppressed']);
  });

  it('resolves an event-adjacent condition against the stored event', async () => {
    const event = await putEvent({ startAt: local(10, 20), travelBufferMinutes: 30 });
    const outcome = await registerTrigger({
      targetType: 'event',
      targetId: event.id,
      condition: {
        kind: 'event-adjacent',
        eventId: event.id,
        offsetMinutes: -60,
        includeTravelBuffer: true,
      },
    });

    expect(outcome.kind).toBe('registered');
    if (outcome.kind !== 'registered') return;
    // 20:00 minus an hour minus the 30-minute buffer.
    expect(outcome.trigger.nextFireAt).toBe(local(10, 18, 30));
  });

  it('reports a missing target rather than guessing a time', async () => {
    const outcome = await registerTrigger({
      targetType: 'event',
      targetId: 'gone',
      condition: {
        kind: 'event-adjacent',
        eventId: 'gone',
        offsetMinutes: -30,
        includeTravelBuffer: false,
      },
    });

    expect(outcome.kind).toBe('missing-target');
    expect(await db.triggers.count()).toBe(0);
  });
});

describe('cancelTrigger', () => {
  it('deactivates without deleting, so the response history keeps its subject', async () => {
    const outcome = await registerTrigger({
      targetType: 'entry',
      targetId: 'entry-1',
      condition: { kind: 'time', at: local(10, 15), timezone: JLM },
    });
    if (outcome.kind !== 'registered') throw new Error('expected registration');

    await cancelTrigger(outcome.trigger.id);

    const stored = await db.triggers.get(outcome.trigger.id);
    expect(stored).toMatchObject({ active: 0, nextFireAt: null, syncedFireAt: null });
    expect(await db.triggers.count()).toBe(1);
  });

  it('frees the day’s budget', async () => {
    await settings({ dailyCap: 1 });
    const first = await registerTrigger({
      targetType: 'entry',
      targetId: 'a',
      condition: { kind: 'time', at: local(10, 9), timezone: JLM },
    });
    if (first.kind !== 'registered') throw new Error('expected registration');
    await cancelTrigger(first.trigger.id);

    const second = await registerTrigger({
      targetType: 'entry',
      targetId: 'b',
      condition: { kind: 'time', at: local(10, 15), timezone: JLM },
    });
    expect(second.kind).toBe('registered');
  });

  it('is a no-op for an unknown id', async () => {
    await expect(cancelTrigger('nope')).resolves.toBeUndefined();
  });
});

describe('snoozeTrigger', () => {
  it('re-arms for a later time and logs the response', async () => {
    const outcome = await registerTrigger({
      targetType: 'entry',
      targetId: 'entry-1',
      condition: { kind: 'time', at: local(10, 9), timezone: JLM },
    });
    if (outcome.kind !== 'registered') throw new Error('expected registration');
    const { id } = outcome.trigger;

    // Pretend it fired, as the service worker would have logged.
    await db.triggerFires.add({
      id: crypto.randomUUID(),
      triggerId: id,
      firedAt: local(10, 9),
      deliveredVia: 'push',
      lookupFailed: 0,
      response: 'none',
      respondedAt: null,
    });

    const snoozed = await snoozeTrigger(id, local(10, 14));
    expect(snoozed.kind).toBe('registered');

    const stored = await db.triggers.get(id);
    expect(stored).toMatchObject({ nextFireAt: local(10, 14), snoozedUntil: local(10, 14) });

    const fires = await db.triggerFires.where('triggerId').equals(id).toArray();
    expect(fires[0]).toMatchObject({ response: 'snoozed' });
  });

  it('does not let a trigger compete with itself for the day’s budget', async () => {
    // Cap of 1, and the only scheduled trigger is the one being snoozed — so re-arming it
    // must succeed rather than be refused by its own presence.
    await settings({ dailyCap: 1 });
    const outcome = await registerTrigger({
      targetType: 'entry',
      targetId: 'entry-1',
      condition: { kind: 'time', at: local(10, 9), timezone: JLM },
    });
    if (outcome.kind !== 'registered') throw new Error('expected registration');

    expect((await snoozeTrigger(outcome.trigger.id, local(10, 14))).kind).toBe('registered');
  });

  it('refuses a snooze into quiet hours, offering an alternative', async () => {
    const outcome = await registerTrigger({
      targetType: 'entry',
      targetId: 'entry-1',
      condition: { kind: 'time', at: local(10, 9), timezone: JLM },
    });
    if (outcome.kind !== 'registered') throw new Error('expected registration');

    const snoozed = await snoozeTrigger(outcome.trigger.id, local(10, 23, 30));
    expect(snoozed.kind).toBe('suppressed');
    if (snoozed.kind === 'suppressed') expect(snoozed.reason).toBe('quiet-hours');

    // The original time stands, untouched.
    expect(await db.triggers.get(outcome.trigger.id)).toMatchObject({ nextFireAt: local(10, 9) });
  });

  it('reports a missing target for an unknown id', async () => {
    expect((await snoozeTrigger('nope', local(10, 14))).kind).toBe('missing-target');
  });
});

describe('reconcile', () => {
  it('reports the pending set without contacting anything when there is no registration', async () => {
    // The supported no-push state: reminders exist and surface in-app only.
    await registerTrigger({
      targetType: 'entry',
      targetId: 'entry-1',
      condition: { kind: 'time', at: local(10, 15), timezone: JLM },
    });

    const result = await reconcile(local(10, 8));
    expect(result).toEqual({ pending: 1, contacted: false, drifted: false });
  });

  it('excludes cancelled and past triggers from the pending set', async () => {
    const keep = await registerTrigger({
      targetType: 'entry',
      targetId: 'keep',
      condition: { kind: 'time', at: local(10, 15), timezone: JLM },
    });
    const drop = await registerTrigger({
      targetType: 'entry',
      targetId: 'drop',
      condition: { kind: 'time', at: local(10, 16), timezone: JLM },
    });
    if (keep.kind !== 'registered' || drop.kind !== 'registered') throw new Error('setup failed');
    await cancelTrigger(drop.trigger.id);

    expect((await reconcile(local(10, 8))).pending).toBe(1);
    // Reconciling after everything has passed leaves nothing to mirror.
    expect((await reconcile(local(11, 8))).pending).toBe(0);
  });
});
