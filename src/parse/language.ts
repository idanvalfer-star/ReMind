/**
 * Script detection, kept in its own module on purpose.
 *
 * Capture needs to know a capture's language *before* parsing, in order to stamp the Entry — and
 * the Entry is written before parsing is even attempted. Importing this from `parse/index` would
 * drag chrono-node into the launch bundle for the sake of one regex, so it lives here where it
 * can be imported statically while the grammars stay lazy.
 */

import type { Lang } from '../db/schema';

const HEBREW_LETTER = /[א-ת]/;

/**
 * Chooses a grammar from the text itself rather than from the interface language.
 *
 * A Hebrew speaker with a Hebrew UI still types plenty of English, and the reverse happens too.
 * The script is a reliable signal; the setting is not.
 */
export function detectLanguage(text: string): Lang {
  return HEBREW_LETTER.test(text) ? 'he' : 'en';
}
