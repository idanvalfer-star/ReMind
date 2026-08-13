/**
 * Finding the people named in a piece of text.
 *
 * This is how the People module connects to everything else without asking the user to
 * maintain the connection. Notes are not tagged at capture time — capture has to stay
 * frictionless, and a note written before a person existed would have missed the tag anyway.
 * Instead, mentions are *derived* on read, which means adding someone retroactively surfaces
 * every note that ever named them.
 *
 * It reuses `tokenize()` rather than matching raw substrings, and that choice is doing real
 * work in Hebrew: particles attach directly to the following word, so "with Sarah" is written
 * as one token. The tokeniser already emits the prefix-stripped stem alongside the original,
 * so `לשרה` and `שרה` land on the same term and the name matches either way. Substring
 * matching would find `שרה` inside unrelated words; token equality does not.
 */

import { tokenize } from '../db/tokenize';
import type { Entry, ID, Person } from '../db/schema';

/**
 * The token lists a person can be recognised by — their name, then each alias.
 *
 * A variant that tokenises to nothing is dropped: single letters and punctuation fall below
 * the tokeniser's minimum length, and an empty token list would otherwise match every text.
 * Someone whose every variant is unusable simply never auto-matches, which is the safe
 * failure.
 */
export function nameVariants(person: Person): string[][] {
  return [person.name, ...person.aliases]
    .map((variant) => tokenize(variant))
    .filter((tokens) => tokens.length > 0);
}

/**
 * True when `tokens` contains every token of any one variant.
 *
 * Conjunctive within a variant, disjunctive across them. "Alex Cohen" needs both words present
 * — otherwise every note mentioning any Alex would match — while an alias of just "Cohen"
 * matches on its own, which is the point of having aliases.
 */
function mentions(variants: readonly string[][], tokens: ReadonlySet<string>): boolean {
  return variants.some((variant) => variant.every((token) => tokens.has(token)));
}

/** The ids of everyone named in `text`, in the order the people were given. */
export function matchPeopleIn(text: string, people: readonly Person[]): ID[] {
  const tokens = new Set(tokenize(text));
  if (tokens.size === 0) return [];
  return people.filter((person) => mentions(nameVariants(person), tokens)).map((p) => p.id);
}

/**
 * The people named in an Entry, using its stored tokens rather than re-tokenising the body.
 *
 * Reading the index instead of the text is not just an optimisation: `searchTokens` is what
 * the entry was actually indexed under, so matching against it guarantees that the People
 * screen and keyword search agree about what a note contains.
 */
export function matchPeopleInEntry(entry: Entry, people: readonly Person[]): ID[] {
  const tokens = new Set(entry.searchTokens);
  if (tokens.size === 0) return [];
  return people.filter((person) => mentions(nameVariants(person), tokens)).map((p) => p.id);
}

/**
 * Every token any variant of `person` could be indexed under.
 *
 * Used to narrow an IndexedDB `anyOf` query before the exact conjunctive check — the index
 * can only answer "contains any of these", so the precise test still has to run in memory.
 */
export function lookupTokens(person: Person): string[] {
  return [...new Set(nameVariants(person).flat())];
}
