/**
 * What goes on a packing list, and why.
 *
 * The template is data rather than code so the rules stay legible: every line says which transit
 * modes it applies to, whether its quantity scales with the length of the trip, and which category
 * it belongs in. Reading this file should be enough to predict any generated list.
 *
 * Labels are i18n keys, not text. The generator resolves them once, at generation time — see the
 * note in `packing.ts` about why the resolved string is what gets stored.
 */

import type { PackCategory, TransitMode } from '../db/schema';

export interface TemplateItem {
  /** Key under `packing.item.*`. */
  key: string;
  category: PackCategory;
  /**
   * Items needed per night. Absent means a single one regardless of length — you take one charger
   * whether you are away for two nights or ten.
   */
  perNight?: number;
  /** Restricts the line to certain transit modes. Absent means every mode. */
  modes?: readonly TransitMode[];
  /** Suppresses the line on trips shorter than this. */
  minNights?: number;
}

/** Nobody needs eleven pairs of socks; past this you are doing laundry instead. */
export const MAX_SCALED_QUANTITY = 10;

/**
 * The outbound list.
 *
 * Ordered by category so a generated list reads in the order you actually pack: papers you must not
 * forget, then clothes, then the bathroom, then cables.
 */
export const OUTBOUND_TEMPLATE: readonly TemplateItem[] = [
  // Documents. Passport is air and sea only — a road trip inside one country does not need one, and
  // a list that cries wolf on every line gets skimmed.
  { key: 'passport', category: 'documents', modes: ['air', 'sea'] },
  { key: 'tickets', category: 'documents', modes: ['air', 'rail', 'sea'] },
  { key: 'wallet', category: 'documents' },
  { key: 'insurance', category: 'documents', modes: ['air', 'sea'], minNights: 2 },
  { key: 'licence', category: 'documents', modes: ['road'] },

  // Clothing. These are the only lines that scale with length.
  { key: 'underwear', category: 'clothing', perNight: 1 },
  { key: 'socks', category: 'clothing', perNight: 1 },
  { key: 'tops', category: 'clothing', perNight: 1 },
  { key: 'trousers', category: 'clothing', perNight: 1 / 3 },
  { key: 'sleepwear', category: 'clothing', minNights: 1 },
  { key: 'shoes', category: 'clothing', minNights: 2 },

  { key: 'toothbrush', category: 'toiletries' },
  { key: 'toiletries', category: 'toiletries' },
  // Air travel always has a cabin-bag liquids rule, whatever the airline.
  { key: 'liquidsBag', category: 'toiletries', modes: ['air'] },

  { key: 'phoneCharger', category: 'tech' },
  { key: 'powerBank', category: 'tech', modes: ['air', 'rail', 'sea'] },
  { key: 'adapter', category: 'tech', modes: ['air', 'sea'] },
  { key: 'headphones', category: 'tech', modes: ['air', 'rail', 'sea'] },

  { key: 'medication', category: 'health' },
  { key: 'snacks', category: 'misc', modes: ['air', 'road', 'rail'] },
  { key: 'waterBottle', category: 'misc' },
];

/**
 * The return checklist.
 *
 * A different problem from packing to leave, and the reason it is a separate list rather than the
 * same one re-ticked: going home, the risk is not forgetting to bring something, it is leaving
 * something behind. These are the things that end up plugged into a wall, hanging in a bathroom, or
 * shut in a hotel safe.
 */
export const RETURN_TEMPLATE: readonly TemplateItem[] = [
  { key: 'returnChargers', category: 'tech' },
  { key: 'returnBathroom', category: 'toiletries' },
  { key: 'returnSafe', category: 'documents' },
  { key: 'returnWardrobe', category: 'clothing' },
  { key: 'returnLaundry', category: 'clothing' },
  { key: 'returnPurchases', category: 'misc' },
];

/** Whether a template line applies to a given trip shape. */
export function appliesTo(item: TemplateItem, mode: TransitMode, nights: number): boolean {
  if (item.modes && !item.modes.includes(mode)) return false;
  if (item.minNights !== undefined && nights < item.minNights) return false;
  return true;
}

/**
 * How many to take.
 *
 * One spare above the nightly need, because the failure mode people actually hit is one short — and
 * capped, because past ten you are doing laundry rather than packing more.
 */
export function quantityFor(item: TemplateItem, nights: number): number {
  if (item.perNight === undefined) return 1;
  const needed = Math.ceil(nights * item.perNight) + 1;
  return Math.max(1, Math.min(MAX_SCALED_QUANTITY, needed));
}
