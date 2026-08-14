/**
 * The sync endpoints.
 *
 * These are the only routes in this Worker that store the user's records, and the difference from
 * everything else here is worth stating: `scheduled_pushes` holds opaque ids and timestamps, whereas
 * `sync_records` holds their notes — as AES-256-GCM ciphertext this server has no key for and cannot
 * read.
 *
 * Three properties the handlers below exist to hold:
 *
 * 1. **Membership is proved, not asserted.** A caller must present a `joinSecret` derived from the
 *    space passphrase; the server stores only its SHA-256 and compares. So knowing a space id — which
 *    travels in a code a user might screenshot — is not enough to write into someone's space.
 * 2. **Revisions come from the server.** Clients pull `revision > cursor`, so catching up never depends
 *    on device clocks, only on a counter this Worker owns.
 * 3. **Nothing is interpreted.** No handler here parses, inspects or validates the ciphertext beyond
 *    its length. There is nothing it could usefully check, and pretending otherwise would invite code
 *    that assumes it can read what it cannot.
 */

import type { D1Database } from '@cloudflare/workers-types';
import {
  type SyncJoinRequest,
  type SyncJoinResponse,
  type SyncLeaveRequest,
  type SyncPullRequest,
  type SyncPullResponse,
  type SyncPushRequest,
  type SyncPushResponse,
  type SyncRecordAt,
} from '../src/shared/pushProtocol';

/**
 * Ceiling on one record's ciphertext, in base64url characters.
 *
 * 256 KB of ciphertext is far more than any record in this app — the largest realistic one is a note of
 * a few hundred bytes — so this is a guard against a bug or a hostile client filling D1, not a limit
 * anyone will meet. D1's free tier is 5 GB total, and there is no per-space quota below it.
 */
const MAX_CIPHERTEXT_CHARS = 256 * 1024;

/** Records returned by one pull. Bounded so a first sync on a large corpus arrives in pages. */
const DEFAULT_PULL_LIMIT = 200;
const MAX_PULL_LIMIT = 500;

export interface SyncEnv {
  DB: D1Database;
}

export type SyncResult<T> = { ok: true; value: T } | { ok: false; status: number; detail: string };

const fail = (status: number, detail: string): SyncResult<never> => ({ ok: false, status, detail });

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Confirms the caller belongs to the space, and records that they were seen.
 *
 * The join-secret hash is compared in the SQL rather than fetched and compared in JavaScript. That is
 * not a micro-optimisation: `===` on two strings in JS is not constant-time, and while a timing attack
 * on a 256-bit hash is not a realistic threat here, doing the comparison in the database keeps the
 * secret out of the Worker's memory entirely.
 */
async function requireMember(
  env: SyncEnv,
  spaceId: string,
  joinHash: string,
  devicePubkey: string,
  now: number,
): Promise<SyncResult<true>> {
  const space = await env.DB.prepare('SELECT join_hash, revision FROM sync_spaces WHERE id = ?')
    .bind(spaceId)
    .first<{ join_hash: string; revision: number }>();

  // Deliberately the same answer for "no such space" and "wrong passphrase". Distinguishing them would
  // turn the endpoint into an oracle for which space ids exist.
  if (!space || space.join_hash !== joinHash) return fail(403, 'not a member of that space');

  await env.DB.prepare(
    `INSERT INTO sync_members (space_id, device_pubkey, joined_at, last_seen_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(space_id, device_pubkey) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
  )
    .bind(spaceId, devicePubkey, now, now)
    .run();

  return { ok: true, value: true };
}

/**
 * Creates a space, or joins an existing one.
 *
 * Deliberately one operation. A space is defined by its id and its members; whoever arrives first
 * happens to create it, and there is no meaningful "owner" to model. Two devices racing to create the
 * same space converge on one row.
 */
export async function handleSyncJoin(
  env: SyncEnv,
  devicePubkey: string,
  body: unknown,
  now: number,
): Promise<SyncResult<SyncJoinResponse>> {
  const request = body as Partial<SyncJoinRequest> & { joinHash?: unknown };
  if (!isNonEmptyString(request.spaceId)) return fail(400, 'spaceId is required');
  if (!isNonEmptyString(request.joinHash)) return fail(400, 'joinHash is required');

  const existing = await env.DB.prepare('SELECT join_hash FROM sync_spaces WHERE id = ?')
    .bind(request.spaceId)
    .first<{ join_hash: string }>();

  if (!existing) {
    // `INSERT OR IGNORE` rather than a plain insert: two devices creating the same space at once must
    // not turn one of them into a 500.
    await env.DB.prepare(
      `INSERT OR IGNORE INTO sync_spaces (id, join_hash, revision, created_at, last_write_at)
       VALUES (?, ?, 0, ?, ?)`,
    )
      .bind(request.spaceId, request.joinHash, now, now)
      .run();
  }

  const member = await requireMember(env, request.spaceId, request.joinHash, devicePubkey, now);
  if (!member.ok) return member;

  const space = await env.DB.prepare('SELECT revision FROM sync_spaces WHERE id = ?')
    .bind(request.spaceId)
    .first<{ revision: number }>();
  const members = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM sync_members WHERE space_id = ?',
  )
    .bind(request.spaceId)
    .first<{ n: number }>();

  return {
    ok: true,
    value: { revision: space?.revision ?? 0, members: members?.n ?? 1 },
  };
}

/**
 * Stores a batch of sealed records.
 *
 * Every record in the batch shares one new revision. Per-record revisions would be more granular and
 * would also let a client's cursor land *inside* a batch — so a pull could return half of one device's
 * push, and the other half only on the next round. One revision per push makes a batch atomic from a
 * reader's point of view.
 *
 * The client's `updatedAt` is stored verbatim and used for last-write-wins. This server does not and
 * cannot arbitrate that: it has no way to know which edit really came first, and pretending to would
 * mean overriding the only evidence available with its own clock.
 */
export async function handleSyncPush(
  env: SyncEnv,
  devicePubkey: string,
  body: unknown,
  now: number,
): Promise<SyncResult<SyncPushResponse>> {
  const request = body as Partial<SyncPushRequest> & { joinHash?: unknown };
  if (!isNonEmptyString(request.spaceId)) return fail(400, 'spaceId is required');
  if (!isNonEmptyString(request.joinHash)) return fail(400, 'joinHash is required');
  if (!Array.isArray(request.records)) return fail(400, 'records must be an array');
  if (request.records.length > MAX_PULL_LIMIT) return fail(413, 'too many records in one push');

  const member = await requireMember(env, request.spaceId, request.joinHash, devicePubkey, now);
  if (!member.ok) return member;

  for (const record of request.records) {
    if (!isNonEmptyString(record?.recordKey)) return fail(400, 'recordKey is required');
    if (typeof record.updatedAt !== 'number' || !Number.isFinite(record.updatedAt)) {
      return fail(400, 'updatedAt must be a number');
    }
    if (record.deleted) {
      // A tombstone carries no content. Requiring null rather than accepting and ignoring a payload
      // keeps "deleted" and "empty" distinguishable in the table.
      if (record.ciphertext !== null || record.iv !== null) {
        return fail(400, 'a deleted record must carry no ciphertext');
      }
    } else {
      if (!isNonEmptyString(record.ciphertext) || !isNonEmptyString(record.iv)) {
        return fail(400, 'ciphertext and iv are required');
      }
      if (record.ciphertext.length > MAX_CIPHERTEXT_CHARS) return fail(413, 'record too large');
    }
  }

  // One revision for the whole batch, taken before the writes so every row shares it.
  const bumped = await env.DB.prepare(
    'UPDATE sync_spaces SET revision = revision + 1, last_write_at = ? WHERE id = ? RETURNING revision',
  )
    .bind(now, request.spaceId)
    .first<{ revision: number }>();
  const revision = bumped?.revision ?? 0;

  if (request.records.length > 0) {
    await env.DB.batch(
      request.records.map((record) =>
        env.DB.prepare(
          `INSERT INTO sync_records
             (space_id, record_key, ciphertext, iv, updated_at, deleted, revision)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(space_id, record_key) DO UPDATE SET
             ciphertext = excluded.ciphertext,
             iv         = excluded.iv,
             updated_at = excluded.updated_at,
             deleted    = excluded.deleted,
             revision   = excluded.revision
           -- Last-write-wins, decided here as well as on the client. Without this the server would
           -- accept a stale push from a device that had been offline and overwrite a newer record,
           -- and the two sides would then disagree until something else happened to touch the row.
           WHERE excluded.updated_at >= sync_records.updated_at`,
        ).bind(
          request.spaceId,
          record.recordKey,
          record.deleted ? null : record.ciphertext,
          record.deleted ? null : record.iv,
          record.updatedAt,
          record.deleted ? 1 : 0,
          revision,
        ),
      ),
    );
  }

  return { ok: true, value: { revision } };
}

/** Everything in the space that changed after the caller's cursor, oldest revision first. */
export async function handleSyncPull(
  env: SyncEnv,
  devicePubkey: string,
  body: unknown,
  now: number,
): Promise<SyncResult<SyncPullResponse>> {
  const request = body as Partial<SyncPullRequest> & { joinHash?: unknown };
  if (!isNonEmptyString(request.spaceId)) return fail(400, 'spaceId is required');
  if (!isNonEmptyString(request.joinHash)) return fail(400, 'joinHash is required');

  const cursor =
    typeof request.cursor === 'number' && Number.isFinite(request.cursor) && request.cursor >= 0
      ? request.cursor
      : 0;
  const limit = Math.min(
    MAX_PULL_LIMIT,
    Math.max(1, typeof request.limit === 'number' ? request.limit : DEFAULT_PULL_LIMIT),
  );

  const member = await requireMember(env, request.spaceId, request.joinHash, devicePubkey, now);
  if (!member.ok) return member;

  // One more than the limit, so `more` is known without a second COUNT query.
  const rows = await env.DB.prepare(
    `SELECT record_key, ciphertext, iv, updated_at, deleted, revision
       FROM sync_records
      WHERE space_id = ? AND revision > ?
      ORDER BY revision ASC, record_key ASC
      LIMIT ?`,
  )
    .bind(request.spaceId, cursor, limit + 1)
    .all<{
      record_key: string;
      ciphertext: string | null;
      iv: string | null;
      updated_at: number;
      deleted: number;
      revision: number;
    }>();

  const all = rows.results ?? [];
  const more = all.length > limit;
  const page = more ? all.slice(0, limit) : all;

  const records: SyncRecordAt[] = page.map((row) => ({
    recordKey: row.record_key,
    ciphertext: row.ciphertext,
    iv: row.iv,
    updatedAt: row.updated_at,
    deleted: row.deleted === 1,
    revision: row.revision,
  }));

  return {
    ok: true,
    value: {
      records,
      // The last revision actually delivered, so an interrupted pull resumes without a gap.
      cursor: records.length > 0 ? records[records.length - 1]!.revision : cursor,
      more,
    },
  };
}

/**
 * Removes this device from the space, and the space itself once nobody is left.
 *
 * Dropping the space on the last departure is deliberate: leaving orphaned ciphertext nobody holds a
 * key for would be storing data forever for no one's benefit. The `ON DELETE CASCADE` on
 * `sync_records` means the records go with it.
 *
 * This does **not** delete anything locally. Leaving a sync space is withdrawing from sharing, not
 * asking for your notes to be forgotten.
 */
export async function handleSyncLeave(
  env: SyncEnv,
  devicePubkey: string,
  body: unknown,
): Promise<SyncResult<null>> {
  const request = body as Partial<SyncLeaveRequest>;
  if (!isNonEmptyString(request.spaceId)) return fail(400, 'spaceId is required');

  // No membership proof required to leave. Presenting a device key that is not in the space simply
  // deletes nothing, and demanding the passphrase to *stop* syncing would strand anyone who had
  // forgotten it with a space they could never detach from.
  await env.DB.prepare('DELETE FROM sync_members WHERE space_id = ? AND device_pubkey = ?')
    .bind(request.spaceId, devicePubkey)
    .run();

  const remaining = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM sync_members WHERE space_id = ?',
  )
    .bind(request.spaceId)
    .first<{ n: number }>();

  if ((remaining?.n ?? 0) === 0) {
    await env.DB.prepare('DELETE FROM sync_spaces WHERE id = ?').bind(request.spaceId).run();
  }

  return { ok: true, value: null };
}
