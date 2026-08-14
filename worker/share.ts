/**
 * The shared-list endpoints.
 *
 * These look like the sync endpoints next door and differ in one structural way that changes what this
 * server is for. In sync, the server is a place ciphertext sits: membership is proved by a hash derived
 * from a passphrase it never learns, and every member is equal. Here, **the server enforces
 * permission**, because nothing else can.
 *
 * The reason is unavoidable rather than a design preference. A shared list's key travels inside the
 * invite — it has to, since the person being invited has no passphrase of yours and must not be given
 * one. So every member holds the key, and a key that decrypts also encrypts. Cryptography cannot
 * express "may read but may not write". Only a rule in `handleSharePush` can, and that rule is the one
 * thing here a modified client could not talk its way past.
 *
 * What that means honestly, and what PRIVACY.md says in the same words: a viewer is prevented from
 * writing by this Worker, not by mathematics. If you do not trust the Worker, do not rely on roles.
 *
 * Everything else follows the sync file's rules: revisions come from the server so catching up never
 * depends on device clocks, tombstones carry no content, and no handler ever inspects a ciphertext.
 */

import type {
  ShareCreateRequest,
  ShareCreateResponse,
  ShareInviteRequest,
  ShareLeaveRequest,
  ShareListsResponse,
  ShareMembersRequest,
  ShareMembersResponse,
  SharePullRequest,
  SharePullResponse,
  SharePushRequest,
  SharePushResponse,
  ShareRecordAt,
  ShareRedeemRequest,
  ShareRedeemResponse,
  ShareRevokeRequest,
  ShareRoleWire,
} from '../src/shared/pushProtocol';
import type { SyncEnv, SyncResult } from './sync';

const MAX_CIPHERTEXT_CHARS = 256 * 1024;
const DEFAULT_PULL_LIMIT = 200;
const MAX_PULL_LIMIT = 500;

/**
 * Ceiling on live invites per list.
 *
 * Each one is a working key in someone's inbox, so a list accumulating dozens of them is a list whose
 * owner has lost track of who can read it. The limit counts only unredeemed, unexpired rows.
 */
const MAX_LIVE_INVITES = 20;

/** How far ahead an invite may be dated. A code that outlives the trip is a key nobody remembers. */
const MAX_INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const fail = (status: number, detail: string): SyncResult<never> => ({ ok: false, status, detail });

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

const ROLES: readonly ShareRoleWire[] = ['owner', 'editor', 'viewer'];

function isRole(value: unknown): value is ShareRoleWire {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** Owners and editors write; viewers do not. The whole of the permission model. */
function mayWrite(role: ShareRoleWire): boolean {
  return role === 'owner' || role === 'editor';
}

/**
 * The device key as it is shown to other members and used for revocation.
 *
 * A SHA-256 of the stored public key, so one member's client never handles another's key material and
 * the UI still has something stable to group changes by. The server learns nothing new: it is derived
 * from a value the server already holds.
 */
async function authorId(devicePubkey: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(devicePubkey));
  let binary = '';
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Confirms membership and returns the caller's role.
 *
 * "Not a member" and "no such list" deliberately give the same answer, for the same reason as in sync:
 * distinguishing them would turn the endpoint into an oracle for which list ids exist.
 */
async function requireMember(
  env: SyncEnv,
  listId: string,
  devicePubkey: string,
  now: number,
): Promise<SyncResult<ShareRoleWire>> {
  const row = await env.DB.prepare(
    'SELECT role FROM shared_members WHERE list_id = ? AND device_pubkey = ?',
  )
    .bind(listId, devicePubkey)
    .first<{ role: string }>();

  if (!row || !isRole(row.role)) return fail(403, 'not a member of that list');

  await env.DB.prepare(
    'UPDATE shared_members SET last_seen_at = ? WHERE list_id = ? AND device_pubkey = ?',
  )
    .bind(now, listId, devicePubkey)
    .run();

  return { ok: true, value: row.role };
}

// ---------------------------------------------------------------- create

/**
 * Creates a list, with the caller as its owner.
 *
 * The id is minted by the client rather than here, so the creating device can seal records under it
 * before this round trip completes. A collision would be a UUID collision.
 */
export async function handleShareCreate(
  env: SyncEnv,
  devicePubkey: string,
  body: unknown,
  now: number,
): Promise<SyncResult<ShareCreateResponse>> {
  const request = body as Partial<ShareCreateRequest>;
  if (!isNonEmptyString(request.listId)) return fail(400, 'listId is required');

  const existing = await env.DB.prepare('SELECT owner_pubkey FROM shared_lists WHERE id = ?')
    .bind(request.listId)
    .first<{ owner_pubkey: string }>();

  // Re-creating your own list is a no-op so a retry after a dropped response is safe. Someone else's
  // is refused, which is what stops a guessed id from being claimed out from under its owner.
  if (existing && existing.owner_pubkey !== devicePubkey) return fail(409, 'that list already exists');

  if (!existing) {
    await env.DB.prepare(
      'INSERT INTO shared_lists (id, owner_pubkey, revision, created_at, last_write_at) VALUES (?, ?, 0, ?, ?)',
    )
      .bind(request.listId, devicePubkey, now, now)
      .run();

    await env.DB.prepare(
      `INSERT INTO shared_members (list_id, device_pubkey, role, joined_at, last_seen_at)
       VALUES (?, ?, 'owner', ?, ?)
       ON CONFLICT(list_id, device_pubkey) DO NOTHING`,
    )
      .bind(request.listId, devicePubkey, now, now)
      .run();
  }

  const list = await env.DB.prepare('SELECT revision FROM shared_lists WHERE id = ?')
    .bind(request.listId)
    .first<{ revision: number }>();

  return { ok: true, value: { listId: request.listId, revision: list?.revision ?? 0 } };
}

// ---------------------------------------------------------------- invites

/** Mints an invite. Only an owner may, and only ever for a role at or below their own. */
export async function handleShareInvite(
  env: SyncEnv,
  devicePubkey: string,
  body: unknown,
  now: number,
): Promise<SyncResult<null>> {
  const request = body as Partial<ShareInviteRequest>;
  if (!isNonEmptyString(request.listId)) return fail(400, 'listId is required');
  if (!isNonEmptyString(request.tokenHash)) return fail(400, 'tokenHash is required');
  if (!isRole(request.role)) return fail(400, 'role must be owner, editor or viewer');
  if (typeof request.expiresAt !== 'number' || !Number.isFinite(request.expiresAt)) {
    return fail(400, 'expiresAt must be a number');
  }
  if (request.expiresAt <= now) return fail(400, 'that invite is already expired');
  if (request.expiresAt > now + MAX_INVITE_TTL_MS) return fail(400, 'that invite lasts too long');

  const member = await requireMember(env, request.listId, devicePubkey, now);
  if (!member.ok) return member;
  // Inviting is an owner's job. An editor who could invite could grant away a list they do not own.
  if (member.value !== 'owner') return fail(403, 'only the owner can invite');

  const live = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM shared_invites WHERE list_id = ? AND redeemed_at IS NULL AND expires_at > ?',
  )
    .bind(request.listId, now)
    .first<{ n: number }>();
  if ((live?.n ?? 0) >= MAX_LIVE_INVITES) return fail(429, 'too many invites are still live');

  await env.DB.prepare(
    `INSERT INTO shared_invites (token_hash, list_id, role, created_at, expires_at, redeemed_at, redeemed_by)
     VALUES (?, ?, ?, ?, ?, NULL, NULL)
     ON CONFLICT(token_hash) DO NOTHING`,
  )
    .bind(request.tokenHash, request.listId, request.role, now, request.expiresAt)
    .run();

  return { ok: true, value: null };
}

/**
 * Redeems an invite, adding the caller as a member.
 *
 * The four outcomes are distinguished on purpose. "Already used" in particular is the only signal a
 * user ever gets that a code they sent was intercepted, and collapsing it into a generic failure would
 * throw that away to save a line.
 */
export async function handleShareRedeem(
  env: SyncEnv,
  devicePubkey: string,
  body: unknown,
  now: number,
): Promise<SyncResult<ShareRedeemResponse>> {
  const request = body as Partial<ShareRedeemRequest>;
  if (!isNonEmptyString(request.listId)) return fail(400, 'listId is required');
  if (!isNonEmptyString(request.tokenHash)) return fail(400, 'tokenHash is required');

  const invite = await env.DB.prepare(
    'SELECT list_id, role, expires_at, redeemed_at, redeemed_by FROM shared_invites WHERE token_hash = ?',
  )
    .bind(request.tokenHash)
    .first<{
      list_id: string;
      role: string;
      expires_at: number;
      redeemed_at: number | null;
      redeemed_by: string | null;
    }>();

  if (!invite || invite.list_id !== request.listId || !isRole(invite.role)) {
    return { ok: true, value: { kind: 'unknown' } };
  }

  if (invite.redeemed_at !== null) {
    // Redeeming twice from the same device is a retry, not an interception — a dropped response would
    // otherwise leave a member unable to finish joining a list they are already in.
    if (invite.redeemed_by === devicePubkey) {
      const list = await env.DB.prepare('SELECT revision FROM shared_lists WHERE id = ?')
        .bind(invite.list_id)
        .first<{ revision: number }>();
      return {
        ok: true,
        value: { kind: 'joined', role: invite.role, revision: list?.revision ?? 0 },
      };
    }
    return { ok: true, value: { kind: 'already-used' } };
  }

  if (invite.expires_at <= now) return { ok: true, value: { kind: 'expired' } };

  // Claim the invite conditionally, so two devices racing the same code cannot both get in: whichever
  // UPDATE matches first leaves the other with no rows changed.
  const claimed = await env.DB.prepare(
    'UPDATE shared_invites SET redeemed_at = ?, redeemed_by = ? WHERE token_hash = ? AND redeemed_at IS NULL RETURNING list_id',
  )
    .bind(now, devicePubkey, request.tokenHash)
    .first<{ list_id: string }>();
  if (!claimed) return { ok: true, value: { kind: 'already-used' } };

  await env.DB.prepare(
    `INSERT INTO shared_members (list_id, device_pubkey, role, joined_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(list_id, device_pubkey) DO UPDATE SET role = excluded.role, last_seen_at = excluded.last_seen_at`,
  )
    .bind(invite.list_id, devicePubkey, invite.role, now, now)
    .run();

  const list = await env.DB.prepare('SELECT revision FROM shared_lists WHERE id = ?')
    .bind(invite.list_id)
    .first<{ revision: number }>();

  return { ok: true, value: { kind: 'joined', role: invite.role, revision: list?.revision ?? 0 } };
}

// ---------------------------------------------------------------- membership

/** Every list this device belongs to. The first call the client makes on open. */
export async function handleShareLists(
  env: SyncEnv,
  devicePubkey: string,
): Promise<SyncResult<ShareListsResponse>> {
  const rows = await env.DB.prepare(
    `SELECT m.list_id, m.role, l.revision,
            (SELECT COUNT(*) FROM shared_members x WHERE x.list_id = m.list_id) AS members
       FROM shared_members m
       JOIN shared_lists l ON l.id = m.list_id
      WHERE m.device_pubkey = ?`,
  )
    .bind(devicePubkey)
    .all<{ list_id: string; role: string; revision: number; members: number }>();

  return {
    ok: true,
    value: {
      lists: (rows.results ?? [])
        .filter((row) => isRole(row.role))
        .map((row) => ({
          listId: row.list_id,
          role: row.role as ShareRoleWire,
          revision: row.revision,
          members: row.members,
        })),
    },
  };
}

export async function handleShareMembers(
  env: SyncEnv,
  devicePubkey: string,
  body: unknown,
  now: number,
): Promise<SyncResult<ShareMembersResponse>> {
  const request = body as Partial<ShareMembersRequest>;
  if (!isNonEmptyString(request.listId)) return fail(400, 'listId is required');

  const member = await requireMember(env, request.listId, devicePubkey, now);
  if (!member.ok) return member;

  const rows = await env.DB.prepare(
    'SELECT device_pubkey, role, joined_at FROM shared_members WHERE list_id = ? ORDER BY joined_at',
  )
    .bind(request.listId)
    .all<{ device_pubkey: string; role: string; joined_at: number }>();

  const members = [];
  for (const row of rows.results ?? []) {
    if (!isRole(row.role)) continue;
    members.push({
      author: await authorId(row.device_pubkey),
      role: row.role,
      joinedAt: row.joined_at,
    });
  }

  return { ok: true, value: { members } };
}

/**
 * Removes a member.
 *
 * Worth being clear about what this can and cannot do: it stops that device from reading further
 * updates or writing anything, and it does not — cannot — take back what they already have. They hold
 * the list key and whatever they already pulled. Rotating the key would mean re-inviting everyone else,
 * which is a real feature and not this one; the UI says as much rather than implying an undo.
 */
export async function handleShareRevoke(
  env: SyncEnv,
  devicePubkey: string,
  body: unknown,
  now: number,
): Promise<SyncResult<null>> {
  const request = body as Partial<ShareRevokeRequest>;
  if (!isNonEmptyString(request.listId)) return fail(400, 'listId is required');
  if (!isNonEmptyString(request.author)) return fail(400, 'author is required');

  const member = await requireMember(env, request.listId, devicePubkey, now);
  if (!member.ok) return member;
  if (member.value !== 'owner') return fail(403, 'only the owner can remove members');

  const rows = await env.DB.prepare(
    'SELECT device_pubkey FROM shared_members WHERE list_id = ?',
  )
    .bind(request.listId)
    .all<{ device_pubkey: string }>();

  for (const row of rows.results ?? []) {
    if ((await authorId(row.device_pubkey)) !== request.author) continue;
    // An owner removing themselves would leave a list nobody can invite into. `leave` is the route
    // for that, and it says what happens.
    if (row.device_pubkey === devicePubkey) return fail(400, 'use leave to remove yourself');
    await env.DB.prepare('DELETE FROM shared_members WHERE list_id = ? AND device_pubkey = ?')
      .bind(request.listId, row.device_pubkey)
      .run();
    return { ok: true, value: null };
  }

  return fail(404, 'no such member');
}

/**
 * Leaves a list, deleting it once the last member is gone.
 *
 * No membership proof is required, for the same reason as in sync: demanding one to *stop* sharing
 * would strand anyone whose state had drifted, and presenting a key that is not a member simply
 * deletes nothing.
 */
export async function handleShareLeave(
  env: SyncEnv,
  devicePubkey: string,
  body: unknown,
): Promise<SyncResult<null>> {
  const request = body as Partial<ShareLeaveRequest>;
  if (!isNonEmptyString(request.listId)) return fail(400, 'listId is required');

  await env.DB.prepare('DELETE FROM shared_members WHERE list_id = ? AND device_pubkey = ?')
    .bind(request.listId, devicePubkey)
    .run();

  const remaining = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM shared_members WHERE list_id = ?',
  )
    .bind(request.listId)
    .first<{ n: number }>();

  if ((remaining?.n ?? 0) === 0) {
    await env.DB.prepare('DELETE FROM shared_lists WHERE id = ?').bind(request.listId).run();
  }

  return { ok: true, value: null };
}

// ---------------------------------------------------------------- records

/** The one place a role decides anything. */
export async function handleSharePush(
  env: SyncEnv,
  devicePubkey: string,
  body: unknown,
  now: number,
): Promise<SyncResult<SharePushResponse>> {
  const request = body as Partial<SharePushRequest>;
  if (!isNonEmptyString(request.listId)) return fail(400, 'listId is required');
  if (!Array.isArray(request.records)) return fail(400, 'records must be an array');
  if (request.records.length > MAX_PULL_LIMIT) return fail(413, 'too many records in one push');

  const member = await requireMember(env, request.listId, devicePubkey, now);
  if (!member.ok) return member;

  // A 200 carrying `forbidden` rather than a 403, because this is an expected answer the client shows
  // as "you have view-only access", not a transport failure it should retry.
  if (!mayWrite(member.value)) return { ok: true, value: { kind: 'forbidden' } };

  for (const record of request.records) {
    if (!isNonEmptyString(record?.recordKey)) return fail(400, 'recordKey is required');
    if (typeof record.updatedAt !== 'number' || !Number.isFinite(record.updatedAt)) {
      return fail(400, 'updatedAt must be a number');
    }
    if (record.deleted) {
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

  const bumped = await env.DB.prepare(
    'UPDATE shared_lists SET revision = revision + 1, last_write_at = ? WHERE id = ? RETURNING revision',
  )
    .bind(now, request.listId)
    .first<{ revision: number }>();
  const revision = bumped?.revision ?? 0;

  if (request.records.length > 0) {
    const author = await authorId(devicePubkey);
    await env.DB.batch(
      request.records.map((record) =>
        env.DB.prepare(
          `INSERT INTO shared_records
             (list_id, record_key, ciphertext, iv, updated_at, deleted, revision, author)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(list_id, record_key) DO UPDATE SET
             ciphertext = excluded.ciphertext,
             iv         = excluded.iv,
             updated_at = excluded.updated_at,
             deleted    = excluded.deleted,
             revision   = excluded.revision,
             author     = excluded.author
           WHERE excluded.updated_at >= shared_records.updated_at`,
        ).bind(
          request.listId,
          record.recordKey,
          record.deleted ? null : record.ciphertext,
          record.deleted ? null : record.iv,
          record.updatedAt,
          record.deleted ? 1 : 0,
          revision,
          author,
        ),
      ),
    );
  }

  return { ok: true, value: { kind: 'written', revision } };
}

export async function handleSharePull(
  env: SyncEnv,
  devicePubkey: string,
  body: unknown,
  now: number,
): Promise<SyncResult<SharePullResponse>> {
  const request = body as Partial<SharePullRequest>;
  if (!isNonEmptyString(request.listId)) return fail(400, 'listId is required');
  if (typeof request.cursor !== 'number' || !Number.isFinite(request.cursor)) {
    return fail(400, 'cursor must be a number');
  }

  const member = await requireMember(env, request.listId, devicePubkey, now);
  if (!member.ok) return member;

  const limit = Math.min(
    Math.max(1, Math.floor(request.limit ?? DEFAULT_PULL_LIMIT)),
    MAX_PULL_LIMIT,
  );

  const rows = await env.DB.prepare(
    `SELECT record_key, ciphertext, iv, updated_at, deleted, revision, author
       FROM shared_records
      WHERE list_id = ? AND revision > ?
      ORDER BY revision
      LIMIT ?`,
  )
    .bind(request.listId, request.cursor, limit + 1)
    .all<{
      record_key: string;
      ciphertext: string | null;
      iv: string | null;
      updated_at: number;
      deleted: number;
      revision: number;
      author: string;
    }>();

  const all = rows.results ?? [];
  const more = all.length > limit;
  const page = more ? all.slice(0, limit) : all;

  const records: ShareRecordAt[] = page.map((row) => ({
    recordKey: row.record_key,
    ciphertext: row.ciphertext,
    iv: row.iv,
    updatedAt: row.updated_at,
    deleted: row.deleted === 1,
    revision: row.revision,
    author: row.author,
  }));

  return {
    ok: true,
    value: {
      records,
      cursor: records.length > 0 ? (records[records.length - 1] as ShareRecordAt).revision : request.cursor,
      more,
      // Returned on every pull so a demotion is noticed here rather than at the next rejected write.
      role: member.value,
    },
  };
}
