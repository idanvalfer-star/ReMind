/**
 * Trip and PackItem operations.
 *
 * Two responsibilities beyond CRUD, both of which have to survive a trip being edited rather than
 * only created:
 *
 * 1. **The pack list is regenerated, never merged blindly.** A trip that moves from three nights to
 *    ten needs more socks; one that switches from a flight to a drive no longer needs a passport.
 *    But anything the user has touched — ticked, renamed, added — has to survive that, or the
 *    feature is actively hostile.
 * 2. **Stage reminders go through the engine** like everything else, so quiet hours and the daily
 *    cap apply. A four-stage trip is four reminders competing for the same budget as everything
 *    else, and it does not get an exemption.
 */

import {
  db,
  type EpochMs,
  type Forecast,
  type ID,
  type PackCategory,
  type PackItem,
  type Trip,
  type TransitMode,
} from '../db/schema';
import { loadSettings } from '../db/settings';
import { cancelTrigger, registerTrigger, type RegisterOutcome } from '../engine/index';
import type { Translate } from '../engine/notify';
import { generatePackList, learnedEssentials } from './packing';
import { stageIdAt, stagesFor, STAGE_RULES, type StageId } from './stages';

export interface CreateTripInput {
  destination: string;
  startAt: EpochMs;
  endAt: EpochMs;
  purpose: string;
  transitMode: TransitMode;
  luggageConstraint: string | null;
}

export interface TripStageResult {
  id: StageId;
  outcome: RegisterOutcome;
}

export async function createTrip(input: CreateTripInput, t: Translate): Promise<Trip> {
  const now = Date.now();
  const settings = await loadSettings();
  const trip: Trip = {
    id: crypto.randomUUID(),
    destination: input.destination.trim(),
    startAt: input.startAt,
    // A trip that ends before it starts is a typo; a same-day return is legitimate.
    endAt: Math.max(input.endAt, input.startAt),
    purpose: input.purpose.trim(),
    transitMode: input.transitMode,
    luggageConstraint: input.luggageConstraint?.trim() || null,
    timezone: settings.timezone,
    forecast: null,
    createdAt: now,
    updatedAt: now,
  };

  await db.trips.add(trip);
  await regeneratePackList(trip, t);
  return trip;
}

export async function updateTrip(
  id: ID,
  patch: Partial<CreateTripInput>,
  t: Translate,
): Promise<Trip | null> {
  const existing = await db.trips.get(id);
  if (!existing) return null;

  const next: Trip = {
    ...existing,
    ...(patch.destination !== undefined ? { destination: patch.destination.trim() } : {}),
    ...(patch.startAt !== undefined ? { startAt: patch.startAt } : {}),
    ...(patch.purpose !== undefined ? { purpose: patch.purpose.trim() } : {}),
    ...(patch.transitMode !== undefined ? { transitMode: patch.transitMode } : {}),
    ...(patch.luggageConstraint !== undefined
      ? { luggageConstraint: patch.luggageConstraint?.trim() || null }
      : {}),
    updatedAt: Date.now(),
  };
  if (patch.endAt !== undefined) next.endAt = Math.max(patch.endAt, next.startAt);

  // The destination moving invalidates the forecast — it is a forecast for somewhere else. Dates
  // moving invalidate it too, since the cached days no longer cover the trip.
  const movedPlace = next.destination !== existing.destination;
  const movedDates = next.startAt !== existing.startAt || next.endAt !== existing.endAt;
  if (movedPlace || movedDates) next.forecast = null;

  await db.trips.put(next);
  if (movedPlace || movedDates || next.transitMode !== existing.transitMode) {
    await regeneratePackList(next, t);
  }
  return next;
}

export async function deleteTrip(id: ID): Promise<void> {
  await clearStageTriggers(id);
  await db.transaction('rw', db.trips, db.packItems, async () => {
    await db.packItems.where('tripId').equals(id).delete();
    await db.trips.delete(id);
  });
}

// ---------------------------------------------------------------- pack list

/**
 * Rebuilds the generated part of a trip's pack list, preserving everything the user has touched.
 *
 * The rule: a row the user has ticked, renamed or added by hand is theirs and is never removed. A
 * row that is purely generated and no longer justified is. That is why `origin` is stored — without
 * it there is no way to tell a suggestion the user endorsed from one they merely have not deleted.
 *
 * Ticked state survives by label, so lengthening a trip does not silently un-pack the bag.
 */
export async function regeneratePackList(trip: Trip, t: Translate): Promise<void> {
  const [existing, allItems] = await Promise.all([
    db.packItems.where('tripId').equals(trip.id).toArray(),
    db.packItems.toArray(),
  ]);

  const packedLabels = new Set(
    existing.filter((item) => item.packed === 1).map((item) => item.label.trim().toLowerCase()),
  );
  const drafts = generatePackList(
    {
      transitMode: trip.transitMode,
      startAt: trip.startAt,
      endAt: trip.endAt,
      forecastDays: trip.forecast?.days ?? [],
      learned: learnedEssentials(allItems, trip.id),
    },
    t,
  );

  const now = Date.now();
  await db.transaction('rw', db.packItems, async () => {
    // Manual rows and anything already ticked are kept exactly as they are.
    const keep = existing.filter((item) => item.origin === 'manual' || item.packed === 1);
    const keptLabels = new Set(keep.map((item) => `${item.isReturnLeg}:${item.label.trim().toLowerCase()}`));

    const doomed = existing.filter((item) => !keep.includes(item));
    if (doomed.length > 0) await db.packItems.bulkDelete(doomed.map((item) => item.id));

    const fresh: PackItem[] = drafts
      .filter((draft) => !keptLabels.has(`${draft.isReturnLeg}:${draft.label.trim().toLowerCase()}`))
      .map((draft, index) => ({
        id: crypto.randomUUID(),
        tripId: trip.id,
        label: draft.label,
        quantity: draft.quantity,
        // A label that was ticked before keeps its tick through a regeneration.
        packed: packedLabels.has(draft.label.trim().toLowerCase()) ? 1 : 0,
        isReturnLeg: draft.isReturnLeg,
        category: draft.category,
        origin: draft.origin,
        // Index keeps the template's order stable, which `groupByCategory` sorts on.
        createdAt: now + index,
      }));
    if (fresh.length > 0) await db.packItems.bulkAdd(fresh);
  });
}

export async function packItemsFor(tripId: ID): Promise<PackItem[]> {
  return db.packItems.where('tripId').equals(tripId).toArray();
}

export async function togglePacked(id: ID): Promise<void> {
  const item = await db.packItems.get(id);
  if (!item) return;
  await db.packItems.update(id, { packed: item.packed === 1 ? 0 : 1 });
}

export async function addPackItem(input: {
  tripId: ID;
  label: string;
  quantity?: number;
  category?: PackCategory;
  isReturnLeg?: 0 | 1;
}): Promise<PackItem | null> {
  const label = input.label.trim();
  if (label === '') return null;

  const item: PackItem = {
    id: crypto.randomUUID(),
    tripId: input.tripId,
    label,
    quantity: Math.max(1, Math.round(input.quantity ?? 1)),
    packed: 0,
    isReturnLeg: input.isReturnLeg ?? 0,
    category: input.category ?? 'misc',
    // Manual is what `learnedEssentials` learns from, so this is the field that makes the list
    // improve with use.
    origin: 'manual',
    createdAt: Date.now(),
  };
  await db.packItems.add(item);
  return item;
}

export async function deletePackItem(id: ID): Promise<void> {
  await db.packItems.delete(id);
}

// ---------------------------------------------------------------- forecast

/** Stores a fetched forecast and rebuilds the list so the weather items appear. */
export async function applyForecast(tripId: ID, forecast: Forecast, t: Translate): Promise<void> {
  const trip = await db.trips.get(tripId);
  if (!trip) return;
  const next: Trip = { ...trip, forecast, updatedAt: Date.now() };
  await db.trips.put(next);
  await regeneratePackList(next, t);
}

// ---------------------------------------------------------------- reminders

/**
 * Arms the trip's stage reminders, replacing any it already had.
 *
 * Returns an outcome per stage rather than a boolean, because the daily cap can legitimately refuse
 * some and not others — four stages on a busy day is exactly the case the cap exists for — and the
 * user is owed a specific answer about which ones did not take.
 */
export async function armTripReminders(
  tripId: ID,
  now: EpochMs = Date.now(),
): Promise<TripStageResult[]> {
  const trip = await db.trips.get(tripId);
  if (!trip) return [];

  await clearStageTriggers(tripId);

  const results: TripStageResult[] = [];
  for (const stage of stagesFor(trip, now)) {
    const outcome = await registerTrigger({
      targetType: 'trip',
      targetId: tripId,
      condition: { kind: 'time', at: stage.at, timezone: trip.timezone },
      link: { fromType: 'trip', fromId: tripId, relation: 'about' },
    });
    results.push({ id: stage.id, outcome });
  }
  return results;
}

export async function clearStageTriggers(tripId: ID): Promise<void> {
  const triggers = await db.triggers
    .where('[targetType+targetId]')
    .equals(['trip', tripId])
    .toArray();
  for (const trigger of triggers) {
    if (trigger.active) await cancelTrigger(trigger.id);
  }
}

/**
 * Which stages this trip actually has live reminders for.
 *
 * Not the same as "which stages a trip of this shape gets": a trip booked six days out has no
 * week-before stage, and the daily cap can refuse others. The UI has to list what exists rather
 * than what the rules would ideally produce — a card promising "a week before" when no such
 * reminder was armed is a lie the user only discovers by not being reminded.
 *
 * The stage is recovered from each trigger's fire time by the same derivation the notification uses,
 * so the list and the eventual push cannot disagree.
 */
export async function armedStages(tripId: ID): Promise<StageId[]> {
  const trip = await db.trips.get(tripId);
  if (!trip) return [];

  const triggers = await db.triggers
    .where('[targetType+targetId]')
    .equals(['trip', tripId])
    .toArray();

  const stages = new Set<StageId>();
  for (const trigger of triggers) {
    if (trigger.active !== 1 || trigger.nextFireAt === null) continue;
    const stage = stageIdAt(trip, trigger.nextFireAt);
    if (stage) stages.add(stage);
  }

  // Ordered by the rules rather than by insertion, so the card reads chronologically.
  return STAGE_RULES.map((rule) => rule.id).filter((id) => stages.has(id));
}

// ---------------------------------------------------------------- reading

export interface TripSummary {
  trip: Trip;
  packed: number;
  total: number;
  returnPacked: number;
  returnTotal: number;
}

/**
 * Trips with their packing progress, upcoming first and past trips last.
 *
 * Sorted so the trip you are about to take is at the top even if a longer-ago one is alphabetically
 * or chronologically earlier — a list of holidays is only useful pointed at the next one.
 */
export async function tripSummaries(now: EpochMs = Date.now()): Promise<TripSummary[]> {
  const [trips, items] = await Promise.all([db.trips.toArray(), db.packItems.toArray()]);

  const byTrip = new Map<ID, PackItem[]>();
  for (const item of items) {
    const list = byTrip.get(item.tripId);
    if (list) list.push(item);
    else byTrip.set(item.tripId, [item]);
  }

  return trips
    .map((trip) => {
      const own = byTrip.get(trip.id) ?? [];
      const outbound = own.filter((item) => item.isReturnLeg === 0);
      const returning = own.filter((item) => item.isReturnLeg === 1);
      return {
        trip,
        packed: outbound.filter((item) => item.packed === 1).length,
        total: outbound.length,
        returnPacked: returning.filter((item) => item.packed === 1).length,
        returnTotal: returning.length,
      };
    })
    .sort((a, b) => {
      const aOver = a.trip.endAt < now;
      const bOver = b.trip.endAt < now;
      if (aOver !== bOver) return aOver ? 1 : -1;
      // Upcoming: soonest first. Past: most recent first.
      return aOver ? b.trip.startAt - a.trip.startAt : a.trip.startAt - b.trip.startAt;
    });
}
