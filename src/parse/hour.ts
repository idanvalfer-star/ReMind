/**
 * Deciding which half of the day a bare hour means.
 *
 * "Dinner at 8" means 20:00 to every human who writes it and 08:00 to every naive parser. The
 * gap between those is the single most common way a capture app gets a reminder wrong, so it
 * is resolved deliberately here rather than left to whatever the date library assumed.
 *
 * The order of preference, strongest evidence first:
 *
 *   1. An explicit meridiem — "8pm", and in Hebrew the day-part particle that follows the hour.
 *   2. A day-part word anywhere in the text — "tomorrow evening at 8".
 *   3. A meal or activity word that implies a time of day — "dinner at 8", "breakfast at 8".
 *   4. Nothing: guess, and say so, so confidence drops and the user is asked to confirm.
 *
 * Rule 3 earns its keep. Meals are what people actually schedule, and it turns the worst
 * common case into the right answer for the cost of a dozen words.
 */

import type { DayPart } from './types';

/**
 * Words that place an hour in the day, in both languages.
 *
 * **Order matters and is load-bearing.** The first match wins, so any phrase that *contains* a
 * shorter one has to come first: "afternoon" contains "noon" in English, and the Hebrew for
 * "afternoon" literally contains the word for "noon". Listing noon first silently turns three
 * in the afternoon into three in the morning.
 */
const DAY_PART_WORDS: ReadonlyArray<readonly [RegExp, DayPart]> = [
  [/\b(afternoon)\b/i, 'afternoon'],
  [/\b(morning)\b/i, 'morning'],
  [/\b(noon|midday)\b/i, 'noon'],
  [/\b(evening|tonight)\b/i, 'evening'],
  [/\b(night|midnight)\b/i, 'night'],
  // Hebrew. No \b: word boundaries are defined on [A-Za-z0-9_], so next to a Hebrew letter
  // they match mid-word. The prefixed particle is part of the same token.
  [/אחר\s+הצהריים|אחר\s+הצהרים|אחה"צ|אחהצ/, 'afternoon'],
  [/בוקר/, 'morning'],
  [/צהריים|צהרים/, 'noon'],
  [/בערב|לערב|הערב/, 'evening'],
  [/בלילה|הלילה/, 'night'],
];

/**
 * Words implying a time of day without naming one.
 *
 * Note that Hebrew "arukhat erev" (dinner) contains "erev" (evening) and is therefore already
 * caught by the day-part list above; only the words that are not are listed here.
 */
const MEAL_HINTS: ReadonlyArray<readonly [RegExp, DayPart]> = [
  [/\b(breakfast)\b/i, 'morning'],
  [/\b(brunch)\b/i, 'morning'],
  [/\b(lunch)\b/i, 'noon'],
  [/\b(dinner|supper)\b/i, 'evening'],
  [/\b(drinks|pub|bar)\b/i, 'evening'],
  [/ארוחת בוקר/, 'morning'],
  [/ארוחת צהריים|ארוחת צהרים/, 'noon'],
  [/ארוחת ערב/, 'evening'],
  // Hebrew "kafe"/coffee is a morning word in practice.
  [/קפה של בוקר/, 'morning'],
];

export interface DayPartMatch {
  part: DayPart;
  start: number;
  end: number;
}

function firstMatch(
  text: string,
  table: ReadonlyArray<readonly [RegExp, DayPart]>,
): DayPartMatch | null {
  for (const [pattern, part] of table) {
    const found = pattern.exec(text);
    if (found) return { part, start: found.index, end: found.index + found[0].length };
  }
  return null;
}

/**
 * The day-part a text states outright, with its span.
 *
 * The span is returned because this phrase is scheduling information, not subject matter, so it
 * is stripped from the event title along with the date.
 */
export function matchDayPart(text: string): DayPartMatch | null {
  return firstMatch(text, DAY_PART_WORDS);
}

/**
 * The day-part a text merely implies, e.g. by naming a meal.
 *
 * No span, deliberately: "dinner" is what the event *is*, so it must survive into the title.
 */
export function detectDayPartHint(text: string): DayPart | null {
  return firstMatch(text, MEAL_HINTS)?.part ?? null;
}

/** Whether a day-part means the hour should be read as afternoon or later. */
function isAfternoonOrLater(part: DayPart): boolean {
  return part === 'afternoon' || part === 'evening' || part === 'night';
}

export interface ResolveHourInput {
  /** The hour as written, 0..23. Values above 12 are already unambiguous. */
  hour: number;
  /** An explicit am/pm, where the language has one. */
  meridiem?: 'am' | 'pm' | undefined;
  /** A day-part stated in the text. */
  dayPart?: DayPart | null | undefined;
  /** A day-part merely implied, e.g. by "dinner". */
  hint?: DayPart | null | undefined;
}

export interface ResolvedHour {
  hour: number;
  /** True when the half of the day was guessed rather than derived from the text. */
  ambiguous: boolean;
}

/**
 * Resolves a written hour to a 24-hour value.
 *
 * The fallback when nothing else applies: 1–6 read as afternoon, 7–11 as morning, on the
 * reasoning that "at 3" is far more often 15:00 than 03:00 while "at 9" is genuinely more often
 * 09:00. It is flagged ambiguous either way, which pushes confidence below the silent-create
 * threshold so the user gets the last word.
 */
export function resolveHour({ hour, meridiem, dayPart, hint }: ResolveHourInput): ResolvedHour {
  // 13:00 and up, and a stated 0, say what they mean already.
  if (hour === 0 || hour > 12) return { hour, ambiguous: false };

  if (meridiem === 'am') return { hour: hour === 12 ? 0 : hour, ambiguous: false };
  if (meridiem === 'pm') return { hour: hour === 12 ? 12 : hour + 12, ambiguous: false };

  const part = dayPart ?? hint ?? null;
  if (part) {
    if (part === 'noon') return { hour: hour === 12 ? 12 : hour, ambiguous: false };
    if (isAfternoonOrLater(part)) {
      return { hour: hour === 12 ? 12 : hour < 12 ? hour + 12 : hour, ambiguous: false };
    }
    // morning
    return { hour: hour === 12 ? 0 : hour, ambiguous: false };
  }

  if (hour === 12) return { hour: 12, ambiguous: false };
  if (hour >= 1 && hour <= 6) return { hour: hour + 12, ambiguous: true };
  return { hour, ambiguous: true };
}
