/**
 * Tokeniser for `Entry.searchTokens`.
 *
 * Backs keyword search directly: `searchTokens` is a Dexie `*multiEntry` index, which is
 * a genuine inverted index, so no search library is required. The same function
 * tokenises the query — indexing and querying must agree, and the cheapest way to
 * guarantee that is to run identical code on both sides.
 *
 * Hebrew needs real work here, not just a Unicode-aware split:
 *
 * - **Niqqud** (vowel points) are separate codepoints, so pointed and unpointed
 *   spellings of the same word must collapse to one token.
 * - **Geresh / gershayim** punctuate acronyms and abbreviations, so they are elided rather
 *   than treated as separators: `צה״ל` has to index as one term.
 * - **English possessives** are removed before that elision, because eliding alone would turn
 *   "Sarah's" into `sarahs` and lose the name.
 * - **Maqaf** (U+05BE) is a hyphen: it separates words rather than joining them.
 * - **Prefix particles** — bet, lamed, kaf, mem, he, shin, vav — attach directly to the
 *   following word, so "in Jerusalem" is a single token in Hebrew. Without stripping
 *   them, a search for the bare place name misses it. Both the original and the stripped
 *   forms are indexed, so recall improves without losing literal matching.
 *
 * A warning for anyone editing the character classes below: they contain literal Hebrew
 * codepoints, and the combining marks in `HEBREW_MARKS` render as invisible or as
 * apparent garbage depending on your editor. The intended ranges are spelled out in the
 * comment on each constant — trust those over what the glyphs look like, and check any
 * change against the round-trip test in `tokenize.test.ts`.
 */

/** Points, accents and cantillation: U+0591..U+05BD, U+05BF, U+05C1..U+05C2,
 *  U+05C4..U+05C5, U+05C7. */
const HEBREW_MARKS = /[֑-ׇֽֿׁׂׅׄ]/g;
/** Maqaf U+05BE, paseq U+05C0, sof pasuq U+05C3, nun hafukha U+05C6 — word separators. */
const HEBREW_SEPARATORS = /[־׀׃׆]/g;
/** Geresh U+05F3, gershayim U+05F4, plus the straight/curly quotes standing in for them. */
const ELIDED_PUNCTUATION = /[׳״'"‘’“”]/g;
/**
 * An English possessive ending a word: the `'s` in "Sarah's".
 *
 * Removed *before* the general elision, and this ordering is load-bearing. Eliding first
 * would leave `sarahs`, which nobody searches for and which no longer matches the name it was
 * written about — so a note saying "Sarah's birthday" would be invisible to a search for
 * "Sarah". Restricted to a Latin letter followed by an ASCII or curly apostrophe so it cannot
 * touch a Hebrew geresh, where the same shape is an abbreviation rather than a possessive.
 */
const ENGLISH_POSSESSIVE = /(?<=[a-z])['’]s(?![\p{L}\p{N}])/gu;
/** Anything that is not a letter or a digit separates tokens. */
const NON_WORD = /[^\p{L}\p{N}]+/u;

/** Alef..tav, U+05D0..U+05EA, final forms included. */
const HEBREW_LETTERS = /^[א-ת]+$/;
/** bet U+05D1, lamed U+05DC, kaf U+05DB, mem U+05DE, he U+05D4, shin U+05E9, vav U+05D5. */
const HEBREW_PREFIXES = new Set([
  'ב',
  'ל',
  'כ',
  'מ',
  'ה',
  'ש',
  'ו',
]);
/** Vav U+05D5, the conjunction — the only particle that may stack in front of another. */
const HEBREW_VAV = 'ו';

/**
 * Shorter than this and a token is noise. This also drops bare single digits: the "8"
 * in "at 8" is not a useful search term.
 */
const MIN_TOKEN_LENGTH = 2;
/** Enough for any hand-written note; stops a pasted wall of text bloating the index. */
const MAX_TOKENS = 200;
/** Only strip a particle when what remains is still a plausible word. */
const MIN_STEM_LENGTH = 3;

/**
 * Emits the token itself plus, for Hebrew, the forms with leading particles removed.
 *
 * This over-generates slightly — a word that merely *begins* with a particle letter also
 * yields a non-word stem. Those extra terms only ever sit in the index and nobody
 * searches for them, so recall is worth more here than index purity.
 */
function* withHebrewStems(token: string): Generator<string> {
  yield token;
  if (!HEBREW_LETTERS.test(token)) return;

  const first = token[0];
  if (first === undefined || !HEBREW_PREFIXES.has(first)) return;
  if (token.length - 1 < MIN_STEM_LENGTH) return;
  const stem = token.slice(1);
  yield stem;

  // Only vav may stack, as in "and-in-Jerusalem".
  if (first !== HEBREW_VAV) return;
  const second = stem[0];
  if (second === undefined || !HEBREW_PREFIXES.has(second)) return;
  if (stem.length - 1 < MIN_STEM_LENGTH) return;
  yield stem.slice(1);
}

/**
 * Splits text into search terms. Safe on empty, mixed-script or untrusted input.
 * Insertion-ordered, duplicates removed.
 */
export function tokenize(text: string): string[] {
  if (!text) return [];

  const normalized = text
    .normalize('NFC')
    .toLowerCase()
    .replace(HEBREW_SEPARATORS, ' ')
    .replace(HEBREW_MARKS, '')
    .replace(ENGLISH_POSSESSIVE, '')
    .replace(ELIDED_PUNCTUATION, '');

  const seen = new Set<string>();
  for (const raw of normalized.split(NON_WORD)) {
    if (raw.length < MIN_TOKEN_LENGTH) continue;
    for (const token of withHebrewStems(raw)) {
      if (token.length < MIN_TOKEN_LENGTH) continue;
      seen.add(token);
      if (seen.size >= MAX_TOKENS) return [...seen];
    }
  }
  return [...seen];
}
