/**
 * The sync loop.
 *
 * Push what changed locally, pull what changed remotely, resolve conflicts, apply. Everything crosses
 * the wire sealed — see `crypto.ts` — so the server is a dumb store of ciphertext it cannot read.
 *
 * Two things make this more than a for-loop:
 *
 * - **Change detection without touching every entity.** No synced table gained an `updatedAt` column.
 *   Instead `syncMeta` records a hash of each row as it was last seen, and a row whose canonical hash
 *   differs has been edited. That kept sync out of `Entry`, `Person`, `PackItem` and every writer of
 *   one.
 * - **Interruption is the normal case.** A phone backgrounds the app mid-sync. Every step commits as it
 *   goes and recomputes what remains from the tables, so resuming is the same code path as starting.
 */

import {
  db,
  type EpochMs,
  type SyncMeta,
  type SyncSpace,
  type TableName,
} from '../db/schema';
import { postSigned } from '../engine/sync';
import type { SignedContext } from '../engine/sync';
import type {
  SyncJoinRequest,
  SyncJoinResponse,
  SyncPullRequest,
  SyncPullResponse,
  SyncPushRequest,
  SyncPushResponse,
  SyncRecord,
} from '../shared/pushProtocol';
import { ROUTES } from '../shared/pushProtocol';
import {
  checkVerifier,
  decodeSpaceCode,
  deriveSpaceSecrets,
  encodeSpaceCode,
  hashJoinSecret,
  makeVerifier,
  newSpaceIdentity,
  open,
  seal,
} from './crypto';
import {
  decideMerge,
  hashRecord,
  parseRecordKey,
  preferDeletion,
  recordKey,
  SYNCED_TABLES,
  type RecordVersion,
} from './records';

/** Records per push. Matches the server's per-request ceiling. */
const PUSH_BATCH = 200;

export type SyncOutcome =
  | { kind: 'synced'; pushed: number; pulled: number; conflicts: number; undecryptable: number }
  | { kind: 'disabled' }
  | { kind: 'offline'; detail: string };

// ---------------------------------------------------------------- space lifecycle

export interface SpaceSetup {
  space: SyncSpace;
  /** What the user carries to a second device. Non-secret; the passphrase is not in it. */
  code: string;
}

/**
 * Creates a new sync space on this device.
 *
 * The passphrase is used and discarded. Only the non-extractable key is kept, so nothing stored on this
 * device can be turned back into the passphrase, and there is nowhere for a "recover my passphrase"
 * feature to read it from. That is the guarantee, and the cost of it is that a forgotten passphrase is
 * unrecoverable.
 */
export async function createSpace(passphrase: string): Promise<SpaceSetup> {
  const identity = newSpaceIdentity();
  const { key, joinSecret } = await deriveSpaceSecrets(passphrase, identity.salt);

  const space: SyncSpace = {
    id: 'singleton',
    spaceId: identity.spaceId,
    salt: identity.salt,
    key,
    verifier: await makeVerifier(key, identity.spaceId),
    joinHash: await hashJoinSecret(joinSecret),
    enabled: true,
    lastSyncedAt: null,
    cursor: 0,
  };
  await db.syncSpace.put(space);

  const ctx = await signedContext();
  if (ctx) await join(ctx, identity.spaceId, joinSecret);

  return { space, code: encodeSpaceCode(identity) };
}

export type JoinResult =
  | { kind: 'joined'; members: number }
  | { kind: 'bad-code' }
  /** The code is valid but the passphrase does not match the space. */
  | { kind: 'wrong-passphrase' }
  | { kind: 'offline'; detail: string };

/**
 * Joins an existing space from a code and a passphrase.
 *
 * A wrong passphrase is caught **here**, by the server refusing the join hash, rather than at the first
 * pull. Without that check the device would appear to join successfully and then fail to decrypt every
 * record it received — which looks like data corruption rather than a typo, and is the kind of thing a
 * user reasonably concludes means the app has lost their notes.
 */
export async function joinSpace(code: string, passphrase: string): Promise<JoinResult> {
  const identity = decodeSpaceCode(code);
  if (!identity) return { kind: 'bad-code' };

  const { key, joinSecret } = await deriveSpaceSecrets(passphrase, identity.salt);

  const ctx = await signedContext();
  if (!ctx) return { kind: 'offline', detail: 'this device has no push registration to sign with' };

  let response: SyncJoinResponse;
  try {
    response = await join(ctx, identity.spaceId, joinSecret);
  } catch (cause) {
    // A 403 is the server saying the join hash does not match. Anything else is a transport problem.
    const status = (cause as { status?: number }).status;
    if (status === 403) return { kind: 'wrong-passphrase' };
    return { kind: 'offline', detail: String(cause) };
  }

  await db.syncSpace.put({
    id: 'singleton',
    spaceId: identity.spaceId,
    salt: identity.salt,
    key,
    verifier: await makeVerifier(key, identity.spaceId),
    joinHash: await hashJoinSecret(joinSecret),
    enabled: true,
    lastSyncedAt: null,
    // Zero, not the server's current revision: a joining device wants everything that already exists.
    cursor: 0,
  });

  return { kind: 'joined', members: response.members };
}

/**
 * Detaches this device.
 *
 * Local data is untouched. Leaving a space is withdrawing from sharing, not asking for your notes to be
 * forgotten — and `syncMeta` is cleared so that re-joining later re-pushes everything rather than
 * assuming the server still has it.
 */
export async function leaveSpace(): Promise<void> {
  const space = await db.syncSpace.get('singleton');
  const ctx = await signedContext();
  if (space && ctx) {
    try {
      await postSigned<void>(ctx, ROUTES.syncLeave, { spaceId: space.spaceId });
    } catch {
      // The local detach happens regardless. A server that cannot be reached must not be able to
      // trap someone in a sync space.
    }
  }
  await db.syncSpace.delete('singleton');
  await db.syncMeta.clear();
}

async function join(
  ctx: SignedContext,
  spaceId: string,
  joinSecret: string,
): Promise<SyncJoinResponse> {
  const request: SyncJoinRequest = { spaceId, joinHash: await hashJoinSecret(joinSecret) };
  return postSigned<SyncJoinResponse>(ctx, ROUTES.syncJoin, request);
}

/**
 * The signing credentials, which come from the push registration.
 *
 * Sync therefore requires a device that has registered for push — not because sync needs
 * notifications, but because that registration is where this device's identity keypair lives. Minting
 * a second identity just for sync would mean two things to keep in step for no benefit.
 */
async function signedContext(): Promise<SignedContext | null> {
  const registration = await db.pushRegistration.get('singleton');
  if (!registration) return null;
  return {
    subscriptionId: registration.subscriptionId,
    privateKey: registration.signingKeyPair.privateKey,
  };
}

// ---------------------------------------------------------------- change detection

interface LocalRow {
  key: string;
  table: TableName;
  row: Record<string, unknown>;
  hash: string;
}

/** Every synced row, with its canonical hash. */
async function readLocal(): Promise<Map<string, LocalRow>> {
  const local = new Map<string, LocalRow>();
  for (const table of SYNCED_TABLES) {
    const rows = (await db.table(table).toArray()) as Record<string, unknown>[];
    for (const row of rows) {
      const id = row['id'];
      if (typeof id !== 'string') continue;
      const key = recordKey(table, id);
      local.set(key, { key, table, row, hash: await hashRecord(row) });
    }
  }
  return local;
}

/**
 * What this device needs to send: rows whose hash has changed, and rows that have vanished.
 *
 * The vanished case is what makes deletions propagate at all. Nothing in this app deletes an `Entry`,
 * but events, people, facts, pack items and triggers are all deletable, and without tombstones a
 * deletion on one device would simply be undone by the next pull from another.
 */
export async function pendingChanges(
  now: EpochMs = Date.now(),
): Promise<{ records: SyncRecord[]; meta: SyncMeta[] }> {
  const [local, metaRows] = await Promise.all([readLocal(), db.syncMeta.toArray()]);
  const meta = new Map(metaRows.map((row) => [row.key, row]));

  const records: SyncRecord[] = [];
  const updates: SyncMeta[] = [];

  for (const entry of local.values()) {
    const known = meta.get(entry.key);
    const unchanged = known && known.hash === entry.hash && known.deleted === 0;
    if (unchanged && known.syncedAt !== null) continue;

    // `updatedAt` only moves when the content actually changed. A row that was already pushed and is
    // merely being re-pushed after a failure must not appear newer than it is, or it would win a
    // conflict against a genuinely newer edit on another device.
    const updatedAt = unchanged ? known.updatedAt : now;
    updates.push({ key: entry.key, hash: entry.hash, updatedAt, syncedAt: null, deleted: 0 });
  }

  for (const known of metaRows) {
    if (local.has(known.key) || known.deleted === 1) continue;
    // Gone locally, and this device has not yet told anyone.
    updates.push({ ...known, deleted: 1, updatedAt: now, syncedAt: null });
  }

  const space = await db.syncSpace.get('singleton');
  if (!space) return { records: [], meta: [] };

  for (const update of updates) {
    if (update.deleted === 1) {
      records.push({
        recordKey: update.key,
        ciphertext: null,
        iv: null,
        updatedAt: update.updatedAt,
        deleted: true,
      });
      continue;
    }
    const entry = local.get(update.key);
    if (!entry) continue;
    // The record key is the AES-GCM additional data, so the server cannot move one record's ciphertext
    // onto another record's identity without the client noticing.
    const sealed = await seal(space.key, JSON.stringify(entry.row), update.key);
    records.push({
      recordKey: update.key,
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
      updatedAt: update.updatedAt,
      deleted: false,
    });
  }

  return { records, meta: updates };
}

// ---------------------------------------------------------------- applying remote changes

export interface ApplyResult {
  applied: number;
  conflicts: number;
  /** Records that could not be decrypted. Skipped, never fatal — see the note below. */
  undecryptable: number;
}

/**
 * Writes remote records into the local tables, resolving conflicts.
 *
 * A record that fails to decrypt is **counted and skipped**, not thrown. Two reasons: another device in
 * the space could have written with a different key after a passphrase change, and the server — or
 * anyone who obtained the space id — could have written garbage. Neither should be able to stop the rest
 * of a sync from working, and a count surfaced in Settings is more useful than an exception that hides
 * how much arrived intact.
 */
export async function applyRemote(
  space: SyncSpace,
  remote: SyncPullResponse['records'],
): Promise<ApplyResult> {
  const metaRows = await db.syncMeta.toArray();
  const meta = new Map(metaRows.map((row) => [row.key, row]));

  let applied = 0;
  let conflicts = 0;
  let undecryptable = 0;

  for (const record of remote) {
    const parsed = parseRecordKey(record.recordKey);
    if (!parsed) continue;

    const known = meta.get(record.recordKey);
    const localVersion: RecordVersion | undefined = known
      ? {
          key: known.key,
          hash: known.hash,
          updatedAt: known.updatedAt,
          deleted: known.deleted === 1,
        }
      : undefined;
    const remoteVersion: RecordVersion = {
      key: record.recordKey,
      // A tombstone has no content to hash, so a stable sentinel stands in — it only ever has to
      // differ from a real hash, which it does by being far too short.
      hash: record.deleted ? 'deleted' : (record.ciphertext ?? ''),
      updatedAt: record.updatedAt,
      deleted: record.deleted,
    };

    const decision = localVersion
      ? preferDeletion(localVersion, remoteVersion)
      : decideMerge(undefined, remoteVersion);
    if (decision !== 'take-remote') {
      if (decision === 'keep-local') conflicts += 1;
      continue;
    }

    if (record.deleted) {
      await db.table(parsed.table).delete(parsed.id);
      await db.syncMeta.put({
        key: record.recordKey,
        hash: 'deleted',
        updatedAt: record.updatedAt,
        // Already known to the server — this device learned about it *from* the server.
        syncedAt: Date.now(),
        deleted: 1,
      });
      applied += 1;
      continue;
    }

    if (!record.ciphertext || !record.iv) continue;
    let plaintext: string;
    try {
      plaintext = await open(
        space.key,
        { ciphertext: record.ciphertext, iv: record.iv },
        record.recordKey,
      );
    } catch {
      undecryptable += 1;
      continue;
    }

    let row: Record<string, unknown>;
    try {
      row = JSON.parse(plaintext) as Record<string, unknown>;
    } catch {
      undecryptable += 1;
      continue;
    }
    // Decrypted successfully but describing a different row: the id is authenticated, so this means a
    // client bug rather than tampering. Refusing it is still the right answer.
    if (row['id'] !== parsed.id) {
      undecryptable += 1;
      continue;
    }

    await db.table(parsed.table).put(row);
    await db.syncMeta.put({
      key: record.recordKey,
      hash: await hashRecord(row),
      updatedAt: record.updatedAt,
      syncedAt: Date.now(),
      deleted: 0,
    });
    applied += 1;
  }

  return { applied, conflicts, undecryptable };
}

// ---------------------------------------------------------------- the loop

/**
 * One full sync: push, then pull until caught up.
 *
 * Push first so that a device which has been editing offline gets its work onto the server before it
 * starts taking other devices' versions of the same records. The order does not change who wins a
 * conflict — that is decided by `updatedAt` on both sides — but it does mean a first sync after a long
 * offline stretch does not discard local work and then immediately re-upload it.
 */
export async function runSync(now: EpochMs = Date.now()): Promise<SyncOutcome> {
  const space = await db.syncSpace.get('singleton');
  if (!space || !space.enabled) return { kind: 'disabled' };

  const ctx = await signedContext();
  if (!ctx) return { kind: 'offline', detail: 'no push registration to sign with' };

  // Catches a stored key that no longer opens this space — a passphrase changed on another device, or
  // a half-restored backup. Cheaper to find here than as every record failing to decrypt.
  const verifierOk = await checkVerifier(space.key, space.spaceId, space.verifier);
  if (!verifierOk) return { kind: 'offline', detail: 'stored key does not match this space' };

  try {
    const { records, meta } = await pendingChanges(now);
    let pushed = 0;

    for (let offset = 0; offset < records.length; offset += PUSH_BATCH) {
      const batch = records.slice(offset, offset + PUSH_BATCH);
      const request: SyncPushRequest & { joinHash: string } = {
        spaceId: space.spaceId,
        joinHash: space.joinHash,
        records: batch,
      };
      await postSigned<SyncPushResponse>(ctx, ROUTES.syncPush, request);

      // Mark synced only after the server has it, so an interrupted push is retried rather than lost.
      const keys = new Set(batch.map((record) => record.recordKey));
      await db.syncMeta.bulkPut(
        meta
          .filter((row) => keys.has(row.key))
          .map((row) => ({ ...row, syncedAt: Date.now() })),
      );
      pushed += batch.length;
    }

    let cursor = space.cursor;
    let pulled = 0;
    let conflicts = 0;
    let undecryptable = 0;
    let more = true;

    while (more) {
      const request: SyncPullRequest & { joinHash: string } = {
        spaceId: space.spaceId,
        joinHash: space.joinHash,
        cursor,
      };
      const response = await postSigned<SyncPullResponse>(ctx, ROUTES.syncPull, request);

      const result = await applyRemote(space, response.records);
      pulled += result.applied;
      conflicts += result.conflicts;
      undecryptable += result.undecryptable;

      cursor = response.cursor;
      more = response.more;
      // The cursor is committed per page, so an interrupted pull resumes rather than restarting.
      await db.syncSpace.update('singleton', { cursor, lastSyncedAt: Date.now() });
    }

    return { kind: 'synced', pushed, pulled, conflicts, undecryptable };
  } catch (cause) {
    // Sync failing is ordinary: no signal, a captive portal, the Worker restarting. Local state is
    // untouched and the next run picks up where this one stopped.
    return { kind: 'offline', detail: String(cause) };
  }
}
