/**
 * Records what was delivered and what the user did about it.
 *
 * Nothing reads this yet. It exists now because the data is only collectable as it
 * happens — a later pass that wants to learn which reminders actually get acted on cannot
 * reconstruct a history that was never written down.
 */

import {
  db,
  type ID,
  type TriggerFire,
  type TriggerResponse,
} from '../db/schema';

export interface RecordFireInput {
  triggerId: ID;
  deliveredVia: TriggerFire['deliveredVia'];
  /** True when the local lookup failed and the generic fallback text was shown. */
  lookupFailed: boolean;
  at?: number;
}

/** Logs a delivery. Called from the service worker as the notification is shown. */
export async function recordFire({
  triggerId,
  deliveredVia,
  lookupFailed,
  at = Date.now(),
}: RecordFireInput): Promise<TriggerFire> {
  const fire: TriggerFire = {
    id: crypto.randomUUID(),
    triggerId,
    firedAt: at,
    deliveredVia,
    lookupFailed: lookupFailed ? 1 : 0,
    response: 'none',
    respondedAt: null,
  };
  await db.triggerFires.add(fire);
  return fire;
}

/**
 * Attaches a response to the most recent unanswered delivery for a trigger.
 *
 * Keyed on the trigger rather than the fire id because that is all a `notificationclick`
 * handler has to work with — the notification carries the trigger id, not the log row.
 * Returns undefined when there is nothing outstanding, which is the normal outcome for a
 * duplicate click or a notification dismissed twice.
 */
export async function recordResponse(
  triggerId: ID,
  response: TriggerResponse,
  at = Date.now(),
): Promise<TriggerFire | undefined> {
  const fires = await db.triggerFires.where('triggerId').equals(triggerId).toArray();

  let latest: TriggerFire | undefined;
  for (const fire of fires) {
    if (fire.response !== 'none') continue;
    if (!latest || fire.firedAt > latest.firedAt) latest = fire;
  }
  if (!latest) return undefined;

  const updated: TriggerFire = { ...latest, response, respondedAt: at };
  await db.triggerFires.put(updated);
  return updated;
}
