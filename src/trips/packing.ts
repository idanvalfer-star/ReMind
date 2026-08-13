/**
 * Generating a packing list.
 *
 * Three sources, merged in priority order: the template for the trip's shape, extras the forecast
 * justifies, and things this particular person has packed before. The last is the one that makes the
 * feature improve with use rather than being a static checklist.
 *
 * Pure, and takes its translator as an argument like `composeNotification` does. That matters for a
 * subtle reason: the *resolved* label is what gets stored, not the key. Once generated, a pack list
 * is the user's own data — they rename lines, delete some, add their own — and re-translating text
 * someone has edited would either destroy their edit or require tracking which lines are still
 * pristine. Storing the resolved string means a list generated in Hebrew stays in Hebrew even if the
 * app language changes later, which is the same way a captured note behaves.
 */

import type {
  EpochMs,
  ForecastDay,
  ID,
  PackCategory,
  PackItem,
  PackOrigin,
  TransitMode,
} from '../db/schema';
import { PACK_CATEGORIES } from '../db/schema';
import type { Translate } from '../engine/notify';
import { DAY_MS } from '../engine/time';
import { appliesTo, OUTBOUND_TEMPLATE, quantityFor, RETURN_TEMPLATE } from './template';
import { weatherItems } from './weather';

/** A line before it becomes a row: no id, no trip, not yet persisted. */
export interface PackDraft {
  label: string;
  quantity: number;
  category: PackCategory;
  origin: PackOrigin;
  isReturnLeg: 0 | 1;
}

/** Nights away, at least one — a same-day return still needs the day's things. */
export function nightsBetween(startAt: EpochMs, endAt: EpochMs): number {
  return Math.max(1, Math.round((endAt - startAt) / DAY_MS));
}

export interface GenerateInput {
  transitMode: TransitMode;
  startAt: EpochMs;
  endAt: EpochMs;
  forecastDays?: readonly ForecastDay[];
  /**
   * Labels this person has packed on previous trips often enough to count as theirs. Already
   * filtered by `learnedEssentials`; passed in rather than queried so this stays pure.
   */
  learned?: readonly string[];
}

/**
 * The full list for a trip, outbound and return.
 *
 * Deduplicated on label, case-insensitively, with the earlier source winning. Order matters: a
 * template line keeps its scaled quantity even if the same word turns up in the learned set, and a
 * weather item is not duplicated by a learned one. Without this, a user who packs an umbrella on
 * every trip would get two umbrella lines the moment it rains.
 */
export function generatePackList(input: GenerateInput, t: Translate): PackDraft[] {
  const nights = nightsBetween(input.startAt, input.endAt);
  const drafts: PackDraft[] = [];
  const seen = new Set<string>();

  const push = (draft: PackDraft) => {
    const key = `${draft.isReturnLeg}:${draft.label.trim().toLowerCase()}`;
    if (draft.label.trim() === '' || seen.has(key)) return;
    seen.add(key);
    drafts.push(draft);
  };

  for (const item of OUTBOUND_TEMPLATE) {
    if (!appliesTo(item, input.transitMode, nights)) continue;
    push({
      label: t(`packing.item.${item.key}`),
      quantity: quantityFor(item, nights),
      category: item.category,
      origin: 'template',
      isReturnLeg: 0,
    });
  }

  for (const item of weatherItems(input.forecastDays ?? [])) {
    push({
      label: t(`packing.item.${item.key}`),
      quantity: 1,
      category: item.category,
      origin: 'weather',
      isReturnLeg: 0,
    });
  }

  for (const label of input.learned ?? []) {
    push({ label, quantity: 1, category: 'misc', origin: 'learned', isReturnLeg: 0 });
  }

  for (const item of RETURN_TEMPLATE) {
    push({
      label: t(`packing.item.${item.key}`),
      quantity: 1,
      category: item.category,
      origin: 'template',
      isReturnLeg: 1,
    });
  }

  return drafts;
}

/** How many previous trips an item must appear on before it counts as this person's essential. */
export const LEARNED_THRESHOLD = 2;

/**
 * Labels this person packs on most trips, which the template does not already cover.
 *
 * Counted over *distinct trips*, not rows, and only over items that were actually **packed** — an
 * item generated and then ignored is evidence against it, not for it. That is what stops the list
 * from reinforcing its own suggestions: a template line the user never ticks never becomes
 * "learned", and one they add by hand every time does.
 *
 * Only `manual` items are considered, for the same reason. Learning from generated lines would mean
 * learning from the generator, which converges on whatever it happened to suggest first.
 */
export function learnedEssentials(
  items: readonly PackItem[],
  excludeTripId?: ID,
  threshold = LEARNED_THRESHOLD,
): string[] {
  const tripsByLabel = new Map<string, { trips: Set<ID>; label: string }>();

  for (const item of items) {
    if (item.tripId === excludeTripId) continue;
    if (item.origin !== 'manual' || item.packed !== 1 || item.isReturnLeg === 1) continue;

    const key = item.label.trim().toLowerCase();
    if (key === '') continue;
    const entry = tripsByLabel.get(key);
    if (entry) entry.trips.add(item.tripId);
    // Keep the first spelling seen, so "Kindle" does not become "kindle" on the next list.
    else tripsByLabel.set(key, { trips: new Set([item.tripId]), label: item.label.trim() });
  }

  return [...tripsByLabel.values()]
    .filter((entry) => entry.trips.size >= threshold)
    .sort((a, b) => b.trips.size - a.trips.size || a.label.localeCompare(b.label))
    .map((entry) => entry.label);
}

export interface PackProgress {
  packed: number;
  total: number;
}

/** Ticked versus total, for the one number the trip screen leads with. */
export function packProgress(items: readonly PackItem[], isReturnLeg: 0 | 1): PackProgress {
  const relevant = items.filter((item) => item.isReturnLeg === isReturnLeg);
  return {
    packed: relevant.filter((item) => item.packed === 1).length,
    total: relevant.length,
  };
}

/**
 * Items grouped for display, in the order things are actually packed.
 *
 * Empty categories are omitted rather than rendered as empty headings, and the category order comes
 * from `PACK_CATEGORIES` so it cannot drift from the type.
 */
export function groupByCategory(
  items: readonly PackItem[],
): { category: PackCategory; items: PackItem[] }[] {
  return PACK_CATEGORIES.map((category) => ({
    category,
    items: items
      .filter((item) => item.category === category)
      .sort((a, b) => a.createdAt - b.createdAt || a.label.localeCompare(b.label)),
  })).filter((group) => group.items.length > 0);
}
