/**
 * Shared vocabulary for the deterministic parsers.
 *
 * English and Hebrew are parsed by completely different machinery — chrono-node has no Hebrew
 * locale, so that grammar is hand-written — but they produce the same result shape and are
 * scored by the same confidence function. Otherwise "how sure are we?" would mean two
 * different things depending on the language, and the create-silently threshold would be
 * meaningless.
 */

import type { EpochMs, IanaTz, Lang } from '../db/schema';

/** Which part of the day a phrase pointed at, when it did not give a clock time. */
export type DayPart = 'morning' | 'noon' | 'afternoon' | 'evening' | 'night';

/**
 * Observations about *how* a date was arrived at. These, not the parser's internal certainty,
 * are what confidence is computed from — so the score means the same thing in both languages.
 */
export interface ParseSignals {
  /** A clock time was stated, e.g. "at 8", "20:30", "half past eight". */
  hasExplicitTime: boolean;
  /** A day was stated, e.g. "tomorrow", "next Tuesday", "15 August". */
  hasExplicitDate: boolean;
  /**
   * A bare hour with no am/pm, no day-part word and no contextual hint, so which half of the
   * day it means was guessed.
   */
  timeIsAmbiguous: boolean;
  /** Only a day-part word was given, so the exact time was chosen for the user. */
  usedDayPartOnly: boolean;
  /** More than one date expression was found, so the wrong one may have been picked. */
  candidateCount: number;
  /** Text survived after removing the date expression, so the event has something to be called. */
  hasTitle: boolean;
  /** The resolved instant is before the reference time. Usually means a misparse. */
  resolvedInPast: boolean;
}

export interface ParsedEvent {
  title: string;
  startAt: EpochMs;
  endAt: EpochMs;
  isAllDay: boolean;
  timezone: IanaTz;
}

export interface ParseResult {
  /** Null when no date expression was recognised at all. */
  event: ParsedEvent | null;
  /** 0..1. Compared against `Settings.confidenceThreshold`. */
  confidence: number;
  signals: ParseSignals;
  /** The span that produced the date, so the UI can show what it understood. */
  matchedText: string | null;
  language: Lang;
}

export interface ParseOptions {
  /** "Now", for resolving relative expressions. Injected so tests are not clock-dependent. */
  reference: EpochMs;
  timezone: IanaTz;
}

/** An empty result, for text with no date in it. */
export function noMatch(language: Lang): ParseResult {
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

/** Default duration for an event with a start but no stated end. */
export const DEFAULT_EVENT_MINUTES = 60;

/** Clock time each day-part word resolves to, when no explicit hour is given. */
export const DAY_PART_HOURS: Record<DayPart, number> = {
  morning: 9,
  noon: 12,
  afternoon: 15,
  evening: 19,
  night: 21,
};
