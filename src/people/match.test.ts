import { describe, expect, it } from 'vitest';
import { lookupTokens, matchPeopleIn, matchPeopleInEntry, nameVariants } from './match';
import { tokenize } from '../db/tokenize';
import type { Entry, Person } from '../db/schema';

function person(name: string, aliases: string[] = [], id = name): Person {
  return { id, name, aliases, cadenceDays: null, lastInteractionAt: null, createdAt: 0 };
}

function entry(body: string): Entry {
  return {
    id: 'e1',
    body,
    rawInput: body,
    capturedAt: 0,
    source: 'text',
    language: 'en',
    searchTokens: tokenize(body),
  };
}

describe('nameVariants', () => {
  it('yields the name and each alias', () => {
    expect(nameVariants(person('Alex Cohen', ['Ali', 'Cohen']))).toEqual([
      ['alex', 'cohen'],
      ['ali'],
      ['cohen'],
    ]);
  });

  it('drops variants that tokenise to nothing', () => {
    // A single letter is below the tokeniser's minimum, and an empty token list would
    // vacuously match every text.
    expect(nameVariants(person('J', ['!!', 'Jay']))).toEqual([['jay']]);
  });

  it('has no variants at all when nothing is usable', () => {
    expect(nameVariants(person('X', ['?']))).toEqual([]);
  });
});

describe('matchPeopleIn — English', () => {
  const people = [person('Alex Cohen'), person('Sarah'), person('Dan')];

  it('finds a single-word name', () => {
    expect(matchPeopleIn('coffee with Sarah tomorrow', people)).toEqual(['Sarah']);
  });

  it('requires every word of a multi-word name', () => {
    expect(matchPeopleIn('dinner with Alex Cohen', people)).toEqual(['Alex Cohen']);
    expect(matchPeopleIn('dinner with Alex', people)).toEqual([]);
  });

  it('matches an alias on its own', () => {
    const withAlias = [person('Alex Cohen', ['Alex'])];
    expect(matchPeopleIn('dinner with Alex', withAlias)).toEqual(['Alex Cohen']);
  });

  it('is case insensitive', () => {
    expect(matchPeopleIn('SARAH called', people)).toEqual(['Sarah']);
  });

  it('does not match a name that is merely a prefix of another word', () => {
    // The bug substring matching would introduce: "Dan" inside "Danish".
    expect(matchPeopleIn('bought a danish pastry', people)).toEqual([]);
  });

  it('finds several people in one note', () => {
    expect(matchPeopleIn('Sarah and Dan are coming', people)).toEqual(['Sarah', 'Dan']);
  });

  it('handles a possessive, which the tokeniser elides', () => {
    expect(matchPeopleIn("Sarah's birthday", people)).toEqual(['Sarah']);
  });

  it('returns nothing for text with no usable tokens', () => {
    expect(matchPeopleIn('!!! ???', people)).toEqual([]);
    expect(matchPeopleIn('', people)).toEqual([]);
  });
});

describe('matchPeopleIn — Hebrew', () => {
  const people = [person('שרה'), person('דני'), person('אלכס כהן')];

  it('matches a bare name', () => {
    expect(matchPeopleIn('קפה עם שרה מחר', people)).toEqual(['שרה']);
  });

  it('matches through an attached prefix particle', () => {
    // "to Sarah" is one word in Hebrew. This is the case substring matching gets right by
    // accident and a naive whitespace split gets wrong.
    expect(matchPeopleIn('להתקשר לשרה', people)).toEqual(['שרה']);
  });

  it('matches through the vav conjunction', () => {
    expect(matchPeopleIn('ושרה אמרה', people)).toEqual(['שרה']);
  });

  it('requires both words of a two-word Hebrew name', () => {
    expect(matchPeopleIn('פגישה עם אלכס כהן', people)).toEqual(['אלכס כהן']);
    expect(matchPeopleIn('פגישה עם אלכס', people)).toEqual([]);
  });

  it('matches a name written with niqqud in the note', () => {
    expect(matchPeopleIn('שָׂרָה התקשרה', people)).toEqual(['שרה']);
  });

  it('matches across a maqaf, which separates rather than joins', () => {
    expect(matchPeopleIn('שרה־כהן', [person('שרה')])).toEqual(['שרה']);
  });

  it('matches a Hebrew name recorded as an alias of an English one', () => {
    const mixed = [person('Sarah', ['שרה'])];
    expect(matchPeopleIn('דיברתי עם שרה', mixed)).toEqual(['Sarah']);
    expect(matchPeopleIn('spoke to Sarah', mixed)).toEqual(['Sarah']);
  });
});

describe('matchPeopleInEntry', () => {
  it('reads the stored index, so the People screen and search agree', () => {
    const people = [person('שרה')];
    expect(matchPeopleInEntry(entry('להתקשר לשרה'), people)).toEqual(['שרה']);
  });

  it('finds nothing in an entry with an empty index', () => {
    const bare: Entry = { ...entry('x'), searchTokens: [] };
    expect(matchPeopleInEntry(bare, [person('Sarah')])).toEqual([]);
  });
});

describe('lookupTokens', () => {
  it('flattens every variant into a deduplicated candidate set', () => {
    expect(lookupTokens(person('Alex Cohen', ['Cohen', 'Ali']))).toEqual(['alex', 'cohen', 'ali']);
  });

  it('is empty when no variant is usable, so the caller can skip the query', () => {
    expect(lookupTokens(person('J'))).toEqual([]);
  });
});
