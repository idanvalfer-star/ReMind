/**
 * Which pinned notes are worth surfacing from where the device is standing.
 *
 * The filtering is pure and the IndexedDB read is a thin wrapper around it, because everything that
 * can be wrong here — the radius, the accuracy allowance, the ordering, whether an already-answered
 * pin comes back — is decidable without a database.
 */

import { db, type Trigger } from '../db/schema';
import type { NotificationTarget } from '../engine/notify';
import { resolveTriggerTarget } from '../engine/target';
import { isNear, type Fix, distanceMeters } from './geo';

export interface NearbyPin {
  trigger: Trigger;
  target: NotificationTarget;
  /** Metres from the fix to the pin, for ordering and for showing how close it is. */
  distanceM: number;
}

/**
 * Active triggers pinned within range of a fix, closest first.
 *
 * Only `nextFireAt === null` rows qualify. A trigger that *is* scheduled will arrive as a push at
 * its own time, and surfacing it early because you happened to walk past somewhere would be a
 * second, unasked-for delivery of the same reminder.
 */
export function pinsNear(triggers: readonly Trigger[], fix: Fix): { trigger: Trigger; distanceM: number }[] {
  return triggers
    .filter((trigger) => {
      if (!trigger.active || trigger.location === null) return false;
      if (trigger.nextFireAt !== null) return false;
      return isNear(fix, trigger.location);
    })
    .map((trigger) => ({
      trigger,
      // Non-null by the filter above; narrowing does not survive into `map`.
      distanceM: distanceMeters(fix, trigger.location as NonNullable<Trigger['location']>),
    }))
    .sort((a, b) => a.distanceM - b.distanceM);
}

/** Whether anything at all is pinned, which is what gates asking for a position on app open. */
export async function hasAnyPin(): Promise<boolean> {
  const active = await db.triggers.where('active').equals(1).toArray();
  return active.some((trigger) => trigger.location !== null && trigger.nextFireAt === null);
}

/** `pinsNear` against the stored triggers, with each pin's target resolved for display. */
export async function nearbyPins(fix: Fix, limit = 5): Promise<NearbyPin[]> {
  const active = await db.triggers.where('active').equals(1).toArray();
  const near = pinsNear(active, fix).slice(0, limit);

  return Promise.all(
    near.map(async ({ trigger, distanceM }) => ({
      trigger,
      distanceM,
      target: await resolveTriggerTarget(trigger),
    })),
  );
}
