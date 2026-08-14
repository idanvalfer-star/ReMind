/**
 * What gets synced, how a change is noticed, and who wins a conflict.
 *
 * The three hard parts of any sync layer, kept pure so each is testable on its own.
 *
 * ## Last-write-wins, and what it costs
 *
 * Conflicts are resolved per record by comparing the *client's* `updatedAt`. That is a real choice with
 * a real failure mode, stated here rather than buried:
 *
 * - Two devices editing the same note while offline: the later edit wins and **the earlier one is
 *   silently lost**. No merge, no prompt, no copy kept.
 * - Ordering depends on device clocks. A phone whose clock is ten minutes fast wins arguments it should
 *   have lost.
 *
 * The alternative is CRDTs or a merge UI. Both are large, and for a personal memory graph edited by one
 * person on two devices, per-record LWW is the rule most systems settle on because conflicts are rare
 * and the loss is bounded to a single record's fields. It is not the rule you would pick for a shared
 * document.
 */

import type { TableName } from '../db/schema';

/**
 * Tables that participate in sync.
 *
 * Two deliberate exclusions:
 *
 * - **`settings`** is per-device. Timezone and locale describe the phone in your hand, and syncing them
 *   would make two devices fight over whose timezone is correct — with the loser silently rescheduling
 *   every reminder.
 * - **`embeddings`** is derived data (and not in `TABLE_NAMES` at all). Vectors are recomputable and
 *   would be megabytes of ciphertext for nothing.
 */
export const SYNCED_TABLES: readonly TableName[] = [
  'entries',
  'events',
  'people',
  'facts',
  'trips',
  'packItems',
  'triggers',
  'triggerFires',
  'links',
] as const;

/** `"entries:0f9c…"`. Opaque to the server, and used as AES-GCM's authenticated context. */
export function recordKey(table: TableName, id: string): string {
  return `${table}:${id}`;
}

export function parseRecordKey(key: string): { table: TableName; id: string } | null {
  const separator = key.indexOf(':');
  if (separator <= 0) return null;
  const table = key.slice(0, separator) as TableName;
  const id = key.slice(separator + 1);
  if (id === '' || !SYNCED_TABLES.includes(table)) return null;
  return { table, id };
}

/**
 * JSON with keys in a stable order, so hashing a record is deterministic.
 *
 * `JSON.stringify` preserves insertion order, and two devices can easily build the same logical row
 * with its keys in different orders — a spread here, an explicit literal there. Without canonical
 * ordering the hashes would differ and every record would look permanently changed, so sync would
 * re-upload the entire database on every run.
 *
 * `Float32Array` and friends are not handled: no synced table contains one, and silently mangling a
 * typed array would be worse than the type error that stops it.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    // Undefined members are absent as far as JSON is concerned; including them would make two
    // equivalent rows hash differently.
    .filter(([, member]) => member !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(',')}}`;
}

/**
 * SHA-256 of the canonical JSON, base16.
 *
 * SHA-256 rather than the cheap FNV hash used for embedding staleness: there, a collision costs one
 * stale vector; here it costs a change that is never synced, which is silent data loss. Async is
 * acceptable because sync already runs in a batch.
 */
export async function hashRecord(row: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(row));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface RecordVersion {
  key: string;
  hash: string;
  updatedAt: number;
  deleted: boolean;
}

export type MergeDecision = 'same' | 'take-remote' | 'keep-local';

/**
 * Who wins.
 *
 * Identical hashes mean the two sides already agree, whatever their timestamps say — that check comes
 * first because it is both the common case and the only one that is certainly not a conflict.
 *
 * A tie on `updatedAt` is broken by hash comparison rather than left to chance. Arbitrary, but
 * *stable*: both devices independently reach the same answer, so they converge instead of ping-ponging
 * the record back and forth forever.
 */
export function decideMerge(
  local: RecordVersion | undefined,
  remote: RecordVersion | undefined,
): MergeDecision {
  if (!remote) return 'keep-local';
  if (!local) return 'take-remote';
  if (local.hash === remote.hash && local.deleted === remote.deleted) return 'same';

  if (remote.updatedAt > local.updatedAt) return 'take-remote';
  if (remote.updatedAt < local.updatedAt) return 'keep-local';
  return remote.hash > local.hash ? 'take-remote' : 'keep-local';
}

/**
 * A deletion beats a concurrent edit at the same instant.
 *
 * Not symmetric with `decideMerge`'s hash tiebreak, and on purpose: resurrecting something the user
 * deleted is a worse outcome than losing an edit to it. The edit is one record's fields; the
 * resurrection is a thing reappearing that they wanted gone, which they then have to notice and delete
 * again.
 */
export function preferDeletion(local: RecordVersion, remote: RecordVersion): MergeDecision {
  if (local.updatedAt !== remote.updatedAt) return decideMerge(local, remote);
  if (remote.deleted && !local.deleted) return 'take-remote';
  if (local.deleted && !remote.deleted) return 'keep-local';
  return decideMerge(local, remote);
}
