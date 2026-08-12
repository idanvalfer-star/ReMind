/**
 * Detecting that a capture is a thing to *do*, not a thing to remember.
 *
 * Used to offer a one-tap conversion into a reminder. It only ever offers — it never creates a
 * trigger on its own. An app that silently turns notes into notifications teaches you to stop
 * writing notes.
 *
 * Precision matters more than recall here, and the asymmetry is worth being explicit about: a
 * missed offer costs one tap, while a wrong offer puts a button on a note that is not a task,
 * every time, and the offers stop being read.
 */

import type { Lang } from '../db/schema';

/**
 * English imperative markers.
 *
 * Two kinds: explicit requests ("remind me to"), and a verb in the imperative at the very start
 * of the capture. The verb list is anchored to the start on purpose — "I bought milk" is a note,
 * "buy milk" is a task, and the only difference is position.
 */
const EN_EXPLICIT = /\b(?:remind me|don'?t forget|remember to|need to|have to|must|to-?do)\b/i;
const EN_IMPERATIVE_VERBS =
  /^(?:call|email|text|message|buy|get|pick up|book|send|pay|check|renew|cancel|schedule|submit|file|return|order|print|bring|ask|reply|confirm|register|apply|clean|fix|water|charge)\b/i;

/**
 * Hebrew markers.
 *
 * "tazkir li" (remind me), "al tishkach" (don't forget), "lo lishkoach" (not to forget),
 * "tzarich" / "chayav" (need / must).
 */
const HE_EXPLICIT = /תזכיר\s+לי|תזכירי\s+לי|אל\s+תשכח|לא\s+לשכוח|צריך\s+ל|צריכה\s+ל|חייב\s+ל|חייבת\s+ל/;

/**
 * A Hebrew infinitive at the start of the capture.
 *
 * Hebrew has no imperative form that is reliably distinguishable by shape, but the infinitive is
 * how tasks are actually written — "lehitkasher le-Dani" (to call Dani) is the natural phrasing
 * of a to-do. It is prefixed with lamed, so a leading lamed-word of reasonable length is a good
 * signal. Length 4 or more avoids matching "lo" (no) and other short function words.
 */
const HE_INFINITIVE = /^ל[א-ת]{3,}(?![א-ת])/;

export interface ActionableResult {
  isActionable: boolean;
  /** Which rule fired, for debugging and for tests to be specific about why. */
  marker: 'explicit' | 'imperative-verb' | 'infinitive' | null;
}

export function detectActionable(text: string, language: Lang): ActionableResult {
  const trimmed = text.trim();
  if (!trimmed) return { isActionable: false, marker: null };

  if (language === 'he') {
    if (HE_EXPLICIT.test(trimmed)) return { isActionable: true, marker: 'explicit' };
    if (HE_INFINITIVE.test(trimmed)) return { isActionable: true, marker: 'infinitive' };
    return { isActionable: false, marker: null };
  }

  if (EN_EXPLICIT.test(trimmed)) return { isActionable: true, marker: 'explicit' };
  if (EN_IMPERATIVE_VERBS.test(trimmed)) return { isActionable: true, marker: 'imperative-verb' };
  return { isActionable: false, marker: null };
}
