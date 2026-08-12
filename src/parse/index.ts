/**
 * The parser's entry point.
 *
 * Picks a grammar by script, runs it, and scores the result. Phase 1 is rules-only: no LLM, no
 * API key, no network. Capture works with the radio off, which is the point — a capture app that
 * needs connectivity to understand "tomorrow at 8" is not a capture app.
 */

import type { Lang } from '../db/schema';
import { scoreParse } from './confidence';
import { parseEnglish } from './en';
import { parseHebrew } from './he';
import type { ParseOptions, ParseResult } from './types';

const HEBREW_LETTER = /[א-ת]/;

/**
 * Chooses a grammar from the text itself rather than from the UI language.
 *
 * A Hebrew speaker with a Hebrew interface still types plenty of English, and the reverse
 * happens too. The script is the reliable signal; the setting is not.
 */
export function detectLanguage(text: string): Lang {
  return HEBREW_LETTER.test(text) ? 'he' : 'en';
}

/**
 * Parses a capture into an Event proposal with a confidence score.
 *
 * Never throws. A capture that cannot be parsed is the ordinary case for a plain note, and
 * parsing must never be able to block or lose a capture.
 */
export function parseCapture(text: string, options: ParseOptions): ParseResult {
  const language = detectLanguage(text);
  try {
    const result = language === 'he' ? parseHebrew(text, options) : parseEnglish(text, options);
    if (!result.event) return result;
    return { ...result, confidence: scoreParse(result.signals) };
  } catch (cause) {
    // A malformed input reaching an edge of the grammar must cost the user nothing.
    console.warn('parse failed; capture is unaffected', cause);
    return { ...noParse(language), language };
  }
}

function noParse(language: Lang): ParseResult {
  return {
    event: null,
    confidence: 0,
    matchedText: null,
    language,
    signals: {
      hasExplicitTime: false,
      hasExplicitDate: false,
      timeIsAmbiguous: false,
      usedDayPartOnly: false,
      candidateCount: 0,
      hasTitle: false,
      resolvedInPast: false,
    },
  };
}

export { detectActionable, type ActionableResult } from './actionable';
export type { ParseOptions, ParseResult, ParsedEvent, ParseSignals } from './types';
