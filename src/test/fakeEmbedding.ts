/**
 * A deterministic stand-in for the on-device embedding model, for tests.
 *
 * Lives under `src/test/` alongside the vitest setup because it is test-only: nothing in the app
 * imports it, and putting it next to the modules it fakes would leave production-looking code that
 * only tests call.
 *
 * It has to do two things a naive fake gets wrong:
 *
 * 1. **Put related texts near each other.** Three topical axes keyed by overlapping vocabularies, so
 *    "pottery" genuinely lands near "ceramic vase" with no shared token — which is the property the
 *    whole feature exists for.
 * 2. **Keep *unrelated* texts apart.** An earlier version gave every unrecognised text the same
 *    small uniform vector, so two notes about nothing in particular scored a perfect 1.0 against each
 *    other and a search for "submarine" matched a dinner reservation. Unrecognised text now gets a
 *    direction derived from its own characters, so distinct strings are distinct — the real model's
 *    most basic guarantee, and one a fake has to honour or it tests the wrong thing.
 */

import type { EmbeddingProvider } from '../search/embedding';

/** Three topical axes plus two carrying a per-string direction. */
const DIMENSIONS = 5;

const TOPICS: readonly RegExp[] = [
  /vase|pottery|ceramic|porcelain/i,
  /dentist|tooth|appointment/i,
  /flight|airport|boarding/i,
];

/** Cheap angle from the string, so unrelated texts point in unrelated directions. */
function angleOf(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) / 0xffffffff) * Math.PI * 2;
}

export function fakeEmbeddingProvider(model = 'fake-v1'): EmbeddingProvider {
  return {
    model,
    dimensions: DIMENSIONS,
    embed: async (texts) =>
      texts.map((text) => {
        const vector = new Float32Array(DIMENSIONS);
        let matched = false;
        TOPICS.forEach((pattern, axis) => {
          if (pattern.test(text)) {
            vector[axis] = 1;
            matched = true;
          }
        });

        if (!matched) {
          // The E5 prefixes are part of every real call and must not make two texts look alike, so
          // they are stripped before the angle is taken.
          const angle = angleOf(text.replace(/^(query|passage):\s*/i, ''));
          vector[3] = Math.cos(angle);
          vector[4] = Math.sin(angle);
        }
        return vector;
      }),
  };
}
