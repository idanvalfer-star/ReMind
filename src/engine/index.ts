/**
 * The resurfacing engine's public API.
 *
 * Every module registers triggers **here**; none touches the `triggers` table or the push
 * backend directly. That is the whole point of the boundary: quiet hours, the daily cap and
 * the response log are only trustworthy if there is exactly one path through which a
 * reminder can come into existence.
 *
 * Two rules that shape the code below:
 *
 * 1. **IndexedDB is authoritative.** Mirroring to the backend is best-effort. A failed
 *    network call never rolls back local state; the next `reconcile()` repairs the backend.
 * 2. **A reminder is never created at a time it cannot fire.** If quiet hours or the cap
 *    forbid the requested instant, nothing is written and the caller is told why, along with
 *    a time that would work. Silently moving it, or storing a muted trigger, would both be
 *    ways of lying about what will happen.
 */

import {
  db,
  type EntityType,
  type EpochMs,
  type Event,
  type ID,
  type Link,
  type LinkRelation,
  type Trigger,
  type TriggerResponse,
} from '../db/schema';
import { loadSettings } from '../db/settings';
import { desiredFireAt, type SchedulableCondition } from './evaluate';
import { recordResponse } from './log';
import { resolveFireTime, type ScheduleContext, type SuppressionReason } from './schedule';
import {
  deleteSubscription,
  pendingPushes,
  reconcilePushes,
  schedulePushes,
  unschedulePushes,
  type SignedContext,
} from './sync';

export interface RegisterTriggerInput {
  targetType: EntityType;
  targetId: ID;
  condition: SchedulableCondition;
  /** Optional edge to record alongside the trigger, e.g. entry → trigger. */
  link?: { fromType: EntityType; fromId: ID; relation: LinkRelation } | undefined;
  location?: Trigger['location'];
}

export type RegisterOutcome =
  | { kind: 'registered'; trigger: Trigger }
  | {
      kind: 'suppressed';
      reason: SuppressionReason;
      desiredAt: EpochMs;
      /** A time that would be permitted, for the caller to offer. Null if none exists. */
      suggestion: EpochMs | null;
    }
  /** An `event-adjacent` condition whose Event no longer exists. */
  | { kind: 'missing-target' };

// ---------------------------------------------------------------- internals

/**
 * Fire times already committed, which the daily cap is measured against.
 *
 * `excludeTriggerId` matters for re-arming: a trigger being snoozed must not be counted as
 * competing with itself for its own day's budget.
 */
async function committedFireTimes(excludeTriggerId?: ID): Promise<EpochMs[]> {
  const active = await db.triggers
    .where('[active+nextFireAt]')
    .between([1, 0], [1, Number.MAX_SAFE_INTEGER], true, true)
    .toArray();

  return active
    .filter((trigger) => trigger.id !== excludeTriggerId)
    .map((trigger) => trigger.nextFireAt)
    .filter((at): at is EpochMs => at !== null);
}

async function scheduleContext(excludeTriggerId?: ID): Promise<ScheduleContext> {
  const settings = await loadSettings();
  return {
    quietHours: settings.quietHours,
    dailyCap: settings.dailyCap,
    timezone: settings.timezone,
    scheduled: await committedFireTimes(excludeTriggerId),
  };
}

async function linkedEvent(condition: SchedulableCondition): Promise<Event | undefined> {
  if (condition.kind !== 'event-adjacent') return undefined;
  return db.events.get(condition.eventId);
}

/**
 * Credentials for talking to the backend, or `null` when this device has no push
 * registration.
 *
 * `null` is an ordinary state, not an error: a user who declined notifications, or who never
 * installed to the home screen, gets a working capture and calendar app whose reminders only
 * surface in-app. Nothing here should throw because of it.
 */
async function signedContext(): Promise<SignedContext | null> {
  const registration = await db.pushRegistration.get('singleton');
  if (!registration) return null;
  return {
    subscriptionId: registration.subscriptionId,
    privateKey: registration.signingKeyPair.privateKey,
  };
}

/**
 * Runs a backend call, swallowing failure.
 *
 * Deliberately silent to the caller: the local write has already succeeded and is the truth.
 * Surfacing a network error here would invite callers to undo it, which is exactly wrong.
 */
async function mirror(work: (ctx: SignedContext) => Promise<unknown>): Promise<boolean> {
  const ctx = await signedContext();
  if (!ctx) return false;
  try {
    await work(ctx);
    return true;
  } catch (cause) {
    console.warn('push backend unreachable; local state stands', cause);
    return false;
  }
}

// ---------------------------------------------------------------- public API

/**
 * Creates a trigger, if the requested time is one it may actually fire at.
 *
 * On success the trigger is written, any requested `Link` is recorded, and the fire time is
 * mirrored to the backend. On suppression nothing is written at all.
 */
export async function registerTrigger(input: RegisterTriggerInput): Promise<RegisterOutcome> {
  const event = await linkedEvent(input.condition);
  const desired = desiredFireAt(input.condition, event);
  if (desired === null) return { kind: 'missing-target' };

  const decision = resolveFireTime(desired, await scheduleContext());
  if (decision.kind === 'suppressed') {
    return {
      kind: 'suppressed',
      reason: decision.reason,
      desiredAt: decision.desiredAt,
      suggestion: decision.suggestion,
    };
  }

  const now = Date.now();
  const trigger: Trigger = {
    id: crypto.randomUUID(),
    targetType: input.targetType,
    targetId: input.targetId,
    kind: input.condition.kind,
    condition: input.condition,
    nextFireAt: decision.fireAt,
    lastFiredAt: null,
    active: 1,
    snoozedUntil: null,
    location: input.location ?? null,
    syncedFireAt: null,
    createdAt: now,
    updatedAt: now,
  };

  const writes: Promise<unknown>[] = [db.triggers.add(trigger)];
  if (input.link) {
    const link: Link = {
      id: crypto.randomUUID(),
      fromType: input.link.fromType,
      fromId: input.link.fromId,
      toType: 'trigger',
      toId: trigger.id,
      relation: input.link.relation,
      createdAt: now,
    };
    writes.push(db.links.add(link));
  }
  await Promise.all(writes);

  const mirrored = await mirror((ctx) =>
    schedulePushes(ctx, [{ triggerId: trigger.id, fireAt: decision.fireAt }]),
  );
  if (mirrored) {
    await db.triggers.update(trigger.id, { syncedFireAt: decision.fireAt });
  }

  return { kind: 'registered', trigger };
}

/**
 * Deactivates a trigger and removes it from the backend.
 *
 * Deactivated rather than deleted: the row is the only thing tying a `TriggerFire` history to
 * what produced it, and the response log is worth more than the few bytes.
 */
export async function cancelTrigger(triggerId: ID): Promise<void> {
  const trigger = await db.triggers.get(triggerId);
  if (!trigger) return;

  await db.triggers.update(triggerId, {
    active: 0,
    nextFireAt: null,
    syncedFireAt: null,
    updatedAt: Date.now(),
  });
  await mirror((ctx) => unschedulePushes(ctx, [triggerId]));
}

/**
 * Re-arms a trigger for a later time.
 *
 * Goes through `resolveFireTime` like any other scheduling decision — a snooze that lands at
 * 23:00 is as unwelcome as an original reminder that does, so it is suppressed the same way
 * and the caller is offered a legal alternative.
 */
export async function snoozeTrigger(triggerId: ID, until: EpochMs): Promise<RegisterOutcome> {
  const trigger = await db.triggers.get(triggerId);
  if (!trigger) return { kind: 'missing-target' };

  const decision = resolveFireTime(until, await scheduleContext(triggerId));
  if (decision.kind === 'suppressed') {
    return {
      kind: 'suppressed',
      reason: decision.reason,
      desiredAt: decision.desiredAt,
      suggestion: decision.suggestion,
    };
  }

  const updated: Trigger = {
    ...trigger,
    active: 1,
    nextFireAt: decision.fireAt,
    snoozedUntil: decision.fireAt,
    syncedFireAt: null,
    updatedAt: Date.now(),
  };
  await db.triggers.put(updated);

  const mirrored = await mirror((ctx) =>
    schedulePushes(ctx, [{ triggerId, fireAt: decision.fireAt }]),
  );
  if (mirrored) {
    await db.triggers.update(triggerId, { syncedFireAt: decision.fireAt });
  }

  await recordResponse(triggerId, 'snoozed');
  return { kind: 'registered', trigger: updated };
}

/**
 * Recomputes every `event-adjacent` trigger hanging off an event, after its timing changed.
 *
 * This is the cross-module behaviour that makes the calendar and the engine one product rather
 * than two features. Move a dinner from 20:00 to 21:00 and the "leave in 30 minutes" reminder has
 * to move with it — otherwise it fires at the old time, which is worse than not firing at all,
 * because it is silently wrong rather than visibly absent.
 *
 * A trigger whose new time is no longer permitted is deactivated rather than left pointing at an
 * instant it cannot fire at. It stays visible in Today, where the user can act on it.
 */
export async function recomputeTriggersForEvent(eventId: ID): Promise<void> {
  const event = await db.events.get(eventId);
  const triggers = await db.triggers
    .where('[targetType+targetId]')
    .equals(['event', eventId])
    .toArray();

  for (const trigger of triggers) {
    if (!trigger.active || trigger.condition.kind !== 'event-adjacent') continue;

    const desired = desiredFireAt(trigger.condition, event);
    if (desired === null) {
      await cancelTrigger(trigger.id);
      continue;
    }

    const decision = resolveFireTime(desired, await scheduleContext(trigger.id));
    if (decision.kind === 'suppressed') {
      await cancelTrigger(trigger.id);
      continue;
    }
    if (decision.fireAt === trigger.nextFireAt) continue;

    await db.triggers.update(trigger.id, {
      nextFireAt: decision.fireAt,
      syncedFireAt: null,
      updatedAt: Date.now(),
    });
    const mirrored = await mirror((ctx) =>
      schedulePushes(ctx, [{ triggerId: trigger.id, fireAt: decision.fireAt }]),
    );
    if (mirrored) await db.triggers.update(trigger.id, { syncedFireAt: decision.fireAt });
  }
}

/** Records what the user did with a delivered reminder. */
export async function recordTriggerResponse(
  triggerId: ID,
  response: TriggerResponse,
): Promise<void> {
  await recordResponse(triggerId, response);
}

export interface ReconcileResult {
  /** Number of pending triggers the backend should now hold. */
  pending: number;
  /** False when there is no push registration, so nothing was contacted. */
  contacted: boolean;
  /** True when the backend's set did not match ours before the replace. */
  drifted: boolean;
}

/**
 * Brings the backend into line with local state. Call on app open.
 *
 * The server copy drifts for mundane reasons — a request lost to a dead connection, a push
 * sent while the device was offline — so this is a full replace rather than a diff, and the
 * response is compared to what we sent so drift is at least visible in the log.
 */
export async function reconcile(now = Date.now()): Promise<ReconcileResult> {
  const triggers = await db.triggers.toArray();
  const expected = pendingPushes(triggers, now);

  const ctx = await signedContext();
  if (!ctx) return { pending: expected.length, contacted: false, drifted: false };

  let held: Awaited<ReturnType<typeof reconcilePushes>>;
  try {
    held = await reconcilePushes(ctx, expected);
  } catch (cause) {
    console.warn('reconcile failed; will retry on next open', cause);
    return { pending: expected.length, contacted: false, drifted: false };
  }

  const fingerprint = (pushes: { triggerId: string; fireAt: number }[]) =>
    pushes
      .map((push) => `${push.triggerId}@${push.fireAt}`)
      .sort()
      .join('|');
  const drifted = fingerprint(held) !== fingerprint(expected);

  // Record what the backend confirmed, so the next open can tell synced from unsynced.
  await db.transaction('rw', db.triggers, async () => {
    for (const push of held) {
      await db.triggers.update(push.triggerId, { syncedFireAt: push.fireAt });
    }
  });

  return { pending: expected.length, contacted: true, drifted };
}

/**
 * Erases this device's push registration, locally and on the backend.
 *
 * Local triggers survive: the user has withdrawn permission to be notified, not asked for
 * their reminders to be forgotten. They will still surface in-app.
 */
export async function forgetPushRegistration(): Promise<void> {
  await mirror((ctx) => deleteSubscription(ctx));
  await db.pushRegistration.delete('singleton');
  await db.triggers.toCollection().modify({ syncedFireAt: null });
}
