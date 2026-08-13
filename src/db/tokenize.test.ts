import { describe, expect, it } from 'vitest';
import { tokenize } from './tokenize';

/**
 * Hebrew fixtures are named and transliterated because the literals are hard to review
 * in a diff — `shalomPointed` in particular carries three invisible combining marks.
 * Compare against the transliterations in the comments, not against the glyphs.
 */
const HE = {
  /** shalom, unpointed */
  shalom: 'שלום',
  /** shalom with shin-dot, qamats and holam */
  shalomPointed: 'שָׁלוֹם',
  /** yerushalayim */
  jerusalem: 'ירושלים',
  /** be-yerushalayim, "in Jerusalem" */
  inJerusalem: 'בירושלים',
  /** u-ve-yerushalayim, "and in Jerusalem" */
  andInJerusalem: 'ובירושלים',
  /** akhar ha-tsohorayim, abbreviated with gershayim: afternoon */
  afternoonAbbrev: 'אחה״צ',
  /** the same, with the gershayim elided */
  afternoonPlain: 'אחהצ',
  /** bayit, "house" */
  house: 'בית',
  /** sefer, "book" */
  book: 'ספר',
  /** bet-sefer joined with maqaf: "school" */
  school: 'בית־ספר',
  /** makhar, "tomorrow" */
  tomorrow: 'מחר',
} as const;

describe('tokenize — English', () => {
  it('splits on whitespace and drops single characters', () => {
    // The bare "8" is dropped: a one-character token is not a useful search term.
    expect(tokenize('Dinner with Alex next Tuesday at 8')).toEqual([
      'dinner',
      'with',
      'alex',
      'next',
      'tuesday',
      'at',
    ]);
  });

  it('elides apostrophes inside contractions so they collapse to one token', () => {
    expect(tokenize("Don't forget")).toEqual(['dont', 'forget']);
  });

  it('deduplicates while preserving first-seen order', () => {
    expect(tokenize('the cat the hat the cat')).toEqual(['the', 'cat', 'hat']);
  });

  it('returns nothing for input with no words', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('   ')).toEqual([]);
    expect(tokenize('... !? --')).toEqual([]);
  });
});

describe('tokenize — Hebrew', () => {
  it('strips niqqud so pointed and unpointed spellings agree', () => {
    // This is the round-trip the HEBREW_MARKS comment refers to. If someone edits that
    // character class and breaks it, this fails. The property under test is the
    // *equivalence* of the two spellings, not the exact token list.
    expect(tokenize(HE.shalomPointed)).toEqual(tokenize(HE.shalom));
    expect(tokenize(HE.shalomPointed)[0]).toBe(HE.shalom);
  });

  it('over-generates a junk stem when a word merely starts with a particle letter', () => {
    // shalom begins with shin, which is also the subordinating particle "she-", so the
    // stemmer strips it and produces a non-word. This is the accepted cost of having no
    // Hebrew lexicon: the alternative threshold that would spare shalom would also stop
    // "ba-bayit" -> "bayit" ("in the house" -> "house"), which is a real query people
    // make. Junk stems only ever sit in the index; nobody searches for them.
    expect(tokenize(HE.shalom)).toEqual([HE.shalom, 'לום']);
  });

  it('indexes the stripped stem alongside a prefixed word', () => {
    expect(tokenize(HE.inJerusalem)).toEqual([HE.inJerusalem, HE.jerusalem]);
  });

  it('strips a stacked vav + particle, but only vav may stack', () => {
    expect(tokenize(HE.andInJerusalem)).toEqual([
      HE.andInJerusalem,
      HE.inJerusalem,
      HE.jerusalem,
    ]);
  });

  it('leaves short words alone rather than mangling them into non-words', () => {
    // Both begin with a particle letter, but stripping it would leave two characters.
    expect(tokenize(HE.tomorrow)).toEqual([HE.tomorrow]);
    expect(tokenize(HE.house)).toEqual([HE.house]);
  });

  it('elides gershayim inside abbreviations', () => {
    expect(tokenize(HE.afternoonAbbrev)).toEqual([HE.afternoonPlain]);
  });

  it('treats maqaf as a separator, not a joiner', () => {
    expect(tokenize(HE.school)).toEqual([HE.house, HE.book]);
  });
});

describe('tokenize — mixed script', () => {
  it('handles Hebrew and Latin in one string', () => {
    expect(tokenize(`Meeting ${HE.inJerusalem}`)).toEqual([
      'meeting',
      HE.inJerusalem,
      HE.jerusalem,
    ]);
  });

  it('keeps multi-digit numbers and drops the one-letter particle', () => {
    // "on the 15th of August" written with a hanging particle and a hyphen.
    const augustHe = 'באוגוסט';
    const augustStem = 'אוגוסט';
    expect(tokenize(`ב-15 ${augustHe}`)).toEqual(['15', augustHe, augustStem]);
  });

  it('is a pure function of its input, safe to run on the query side too', () => {
    const text = `${HE.inJerusalem} dinner`;
    expect(tokenize(text)).toEqual(tokenize(text));
    // A query for the bare stem is a subset of what indexing produced, which is what
    // makes `anyOf(tokenize(query))` find the prefixed original.
    expect(tokenize(text)).toContain(tokenize(HE.jerusalem)[0]);
  });
});

describe('English possessives', () => {
  it('indexes the name, not the name plus s', () => {
    // Eliding the apostrophe on its own yields "sarahs", which loses the name a note is
    // about: searching "Sarah" would not find "Sarah's birthday".
    expect(tokenize("Sarah's birthday")).toEqual(['sarah', 'birthday']);
  });

  it('handles a curly apostrophe, which is what phone keyboards produce', () => {
    expect(tokenize('Sarah’s birthday')).toEqual(['sarah', 'birthday']);
  });

  it('leaves contractions that are not possessives alone', () => {
    expect(tokenize("don't forget")).toEqual(['dont', 'forget']);
  });

  it('strips a possessive mid-sentence, not just at the end', () => {
    expect(tokenize("Alex's car is at Dan's place")).toEqual([
      'alex',
      'car',
      'is',
      'at',
      'dan',
      'place',
    ]);
  });

  it('does not touch a Hebrew geresh, where the same shape is an abbreviation', () => {
    // The rule requires a preceding Latin letter precisely so this keeps working.
    expect(tokenize('צה״ל')).toEqual(['צהל']);
  });
});
