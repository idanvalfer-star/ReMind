/**
 * The client side of a shared packing list: create, invite, redeem, and the push/pull loop.
 *
 * Deliberately not a generalisation of `src/sync/sync.ts`, even though the two loops rhyme. Sync
 * covers the whole database under one key and one membership proof; sharing covers one list, under its
 * own key, with per-member roles the server enforces. Merging them behind one abstraction would have
 * meant threading "which key, whose membership, is this table even shared" through every call, for a
 * pair of things that differ in exactly the ways that matter.
 *
 * ## The tripId problem, and how it is resolved
 *
 * A shared list holds `PackItem` rows, and every `PackItem` carries a `tripId`. The device that created
 * the list has a real local `Trip` for it. A device that only joined via an invite does not, and must
 * not be made to invent one — a fabricated destination and date range would be wrong data sitting in a
 * real table.
 *
 * So each device tracks its own **effective trip id** for a shared list: `sharedList.tripId` if this
 * device owns or created the underlying trip, otherwise `sharedList.id` itself, used as a stable
 * synthetic id that belongs to no real `Trip` row. Every pulled record has its `tripId` field rewritten
 * to this device's effective id before it is written locally — the field in the wire payload reflects
 * whoever sent it, not what this device should file it under. That is what lets `packItemsFor`,
 * `togglePacked`, `addPackItem` and `deletePackItem` work unmodified for shared items: they only ever
 * see a tripId, never a listId.
 *
 * ## `packItems` can be synced twice, deliberately
 *
 * `packItems` is also in `SYNCED_TABLES` for `src/sync/sync.ts`, which mirrors it to *your own* other
 * devices under the whole-database passphrase key. This module mirrors the same table to *other
 * people*, under a per-list key, keyed as `<listId>/packItems:<id>` rather than `packItems:<id>`. The
 * two record-key namespaces cannot collide, and a row travels through both without either one knowing
 * the other exists — which is correct: your own sync should not depend on whether a trip happens to be
 * shared, and sharing should not depend on whether personal sync is even turned on.
 */

import {
  db,
  type EpochMs,
  type PackItem,
  type ShareMeta,
  type ShareRole,
  type SharedList,
} from '../db/schema';
import { postSigned } from '../engine/sync';
import type { SignedContext } from '../engine/sync';
import {
  ROUTES,
  type ShareCreateRequest,
  type ShareCreateResponse,
  type ShareInviteRequest,
  type ShareLeaveRequest,
  type ShareListsResponse,
  type ShareMembersRequest,
  type ShareMembersResponse,
  type SharePullRequest,
  type SharePullResponse,
  type SharePushRequest,
  type SharePushResponse,
  type ShareRedeemRequest,
  type ShareRedeemResponse,
  type ShareRevokeRequest,
} from '../shared/pushProtocol';
import { open, seal } from '../sync/crypto';
import { canonicalJson, decideMerge, preferDeletion, type MergeDecision, type RecordVersion } from '../sync/records';
import {
  decodeInvite,
  encodeInvite,
  hashDeviceKey,
  hashInviteToken,
  importListKey,
  INVITE_TTL_MS,
  isExpired,
  newInviteToken,
  newListKey,
  type Invite,
} from './invite';

const PUSH_BATCH = 200;

function recordKey(listId: string, itemId: string): string {
  return `${listId}/packItems:${itemId}`;
}

function parseRecordKey(listId: string, key: string): string | null {
  const prefix = `${listId}/packItems:`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : null;
}

async function signedContext(): Promise<SignedContext | null> {
  const registration = await db.pushRegistration.get('singleton');
  if (!registration) return null;
  return {
    subscriptionId: registration.subscriptionId,
    privateKey: registration.signingKeyPair.privateKey,
  };
}

/** This device's effective tripId for a list — see the module doc for why this exists. */
export function effectiveTripId(list: SharedList): string {
  return list.tripId ?? list.id;
}

// ---------------------------------------------------------------- creating and joining

/**
 * Shares an existing trip's packing list.
 *
 * `tripId` is kept, so this device's own view of the items is unaffected — sharing is additive, not a
 * migration. `key` is generated fresh per list rather than derived from anything, so revoking a member
 * never touches any other list's confidentiality.
 */
export async function createSharedList(
  tripId: string,
  title: string,
): Promise<{ list: SharedList; error?: string }> {
  const ctx = await signedContext();
  if (!ctx) return { list: null as never, error: 'no push registration to sign with' };

  const listId = crypto.randomUUID();
  const request: ShareCreateRequest = { listId };
  await postSigned<ShareCreateResponse>(ctx, ROUTES.shareCreate, request);

  const list: SharedList = {
    id: listId,
    key: newListKey(),
    kind: 'packing',
    tripId,
    title,
    role: 'owner',
    cursor: 0,
    lastSyncedAt: null,
    createdAt: Date.now(),
  };
  await db.sharedLists.put(list);
  return { list };
}

export type RedeemResult =
  | { kind: 'joined'; list: SharedList }
  | { kind: 'bad-code' }
  | { kind: 'expired' }
  | { kind: 'already-used' }
  | { kind: 'unknown' }
  | { kind: 'offline'; detail: string };

/**
 * Redeems an invite code, adding this device to the list it names.
 *
 * The list gets no local `tripId` — this device has no trip of its own for it, and `effectiveTripId`
 * falls back to the list's own id so the packing UI still has somewhere consistent to file items.
 */
export async function redeemInvite(code: string): Promise<RedeemResult> {
  const invite = decodeInvite(code);
  if (!invite) return { kind: 'bad-code' };
  if (isExpired(invite)) return { kind: 'expired' };

  const ctx = await signedContext();
  if (!ctx) return { kind: 'offline', detail: 'no push registration to sign with' };

  let response: ShareRedeemResponse;
  try {
    const request: ShareRedeemRequest = {
      listId: invite.listId,
      tokenHash: await hashInviteToken(invite.token),
    };
    response = await postSigned<ShareRedeemResponse>(ctx, ROUTES.shareRedeem, request);
  } catch (cause) {
    return { kind: 'offline', detail: String(cause) };
  }

  if (response.kind !== 'joined') return response;

  const list: SharedList = {
    id: invite.listId,
    key: invite.key,
    kind: 'packing',
    tripId: null,
    title: invite.title,
    role: response.role,
    cursor: 0,
    lastSyncedAt: null,
    createdAt: Date.now(),
  };
  await db.sharedLists.put(list);
  return { kind: 'joined', list };
}

export type MintInviteResult = { kind: 'ok'; code: string } | { kind: 'not-owner' } | { kind: 'offline'; detail: string };

/** Mints an invite. Only the owner may — the server enforces this, and this check avoids a wasted round trip. */
export async function mintInvite(listId: string, role: ShareRole): Promise<MintInviteResult> {
  const list = await db.sharedLists.get(listId);
  if (!list || list.role !== 'owner') return { kind: 'not-owner' };

  const ctx = await signedContext();
  if (!ctx) return { kind: 'offline', detail: 'no push registration to sign with' };

  const invite: Invite = {
    listId,
    key: list.key,
    token: newInviteToken(),
    role,
    expiresAt: Date.now() + INVITE_TTL_MS,
    title: list.title,
  };

  try {
    const request: ShareInviteRequest = {
      listId,
      tokenHash: await hashInviteToken(invite.token),
      role,
      expiresAt: invite.expiresAt,
    };
    await postSigned<null>(ctx, ROUTES.shareInvite, request);
  } catch (cause) {
    return { kind: 'offline', detail: String(cause) };
  }

  return { kind: 'ok', code: encodeInvite(invite) };
}

/**
 * Leaves a list. Local items are kept — leaving a share is not asking to lose the packing list you
 * have been ticking off, only to stop it changing under you.
 */
export async function leaveSharedList(listId: string): Promise<void> {
  const ctx = await signedContext();
  if (ctx) {
    const request: ShareLeaveRequest = { listId };
    await postSigned<null>(ctx, ROUTES.shareLeave, request).catch(() => undefined);
  }
  await db.sharedLists.delete(listId);
  await db.shareMeta.where('listId').equals(listId).delete();
}

export interface Member {
  author: string;
  role: ShareRole;
  joinedAt: EpochMs;
}

export async function listMembers(listId: string): Promise<Member[]> {
  const ctx = await signedContext();
  if (!ctx) return [];
  const request: ShareMembersRequest = { listId };
  const response = await postSigned<ShareMembersResponse>(ctx, ROUTES.shareMembers, request);
  return response.members.map((m) => ({ author: m.author, role: m.role, joinedAt: m.joinedAt }));
}

export async function revokeMember(listId: string, author: string): Promise<boolean> {
  const ctx = await signedContext();
  if (!ctx) return false;
  const request: ShareRevokeRequest = { listId, author };
  try {
    await postSigned<null>(ctx, ROUTES.shareRevoke, request);
    return true;
  } catch {
    return false;
  }
}

/**
 * This device's own membership hash, for telling "that member" apart from "me" in a member list.
 * Mirrors the server's `authorId` exactly so the two sides agree on what a device is called.
 */
export async function selfAuthorId(): Promise<string | null> {
  const registration = await db.pushRegistration.get('singleton');
  if (!registration) return null;
  const jwk = await crypto.subtle.exportKey('jwk', registration.signingKeyPair.publicKey);
  return hashDeviceKey(jwk);
}

/** Lists this device belongs to, as the server sees it — used to notice a list this device dropped out of. */
export async function remoteMemberships(): Promise<ShareListsResponse['lists']> {
  const ctx = await signedContext();
  if (!ctx) return [];
  return (await postSigned<ShareListsResponse>(ctx, ROUTES.shareLists, {})).lists;
}

// ---------------------------------------------------------------- push

/**
 * Exported so change detection can be unit tested without a network round trip — the same split
 * `src/sync/sync.ts` uses for `pendingChanges`/`applyRemote` against `runSync`.
 */
export async function pendingForList(
  list: SharedList,
): Promise<{ records: SharePushRequest['records']; meta: ShareMeta[] }> {
  const tripId = effectiveTripId(list);
  const items = await db.packItems.where('tripId').equals(tripId).toArray();
  const local = new Map(items.map((item) => [recordKey(list.id, item.id), item]));

  const metaRows = await db.shareMeta.where('listId').equals(list.id).toArray();
  const meta = new Map(metaRows.map((row) => [row.key, row]));

  const updates: ShareMeta[] = [];
  for (const [key, item] of local) {
    const hash = canonicalJson(item);
    const known = meta.get(key);
    const unchanged = known && known.hash === hash && known.deleted === 0;
    if (unchanged && known.syncedAt !== null) continue;
    const updatedAt = unchanged ? known.updatedAt : Date.now();
    updates.push({ key, listId: list.id, hash, updatedAt, syncedAt: null, deleted: 0 });
  }
  for (const known of metaRows) {
    if (local.has(known.key) || known.deleted === 1) continue;
    updates.push({ ...known, deleted: 1, updatedAt: Date.now(), syncedAt: null });
  }

  const key = await importListKey(list.key);
  const records: SharePushRequest['records'] = [];
  for (const update of updates) {
    if (update.deleted === 1) {
      records.push({ recordKey: update.key, ciphertext: null, iv: null, updatedAt: update.updatedAt, deleted: true });
      continue;
    }
    const item = local.get(update.key);
    if (!item) continue;
    const sealed = await seal(key, JSON.stringify(item), update.key);
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

// ---------------------------------------------------------------- pull

export interface ApplyResult {
  applied: number;
  conflicts: number;
  undecryptable: number;
}

export async function applyRemoteForList(
  list: SharedList,
  remote: SharePullResponse['records'],
): Promise<ApplyResult> {
  const key = await importListKey(list.key);
  const tripId = effectiveTripId(list);
  const metaRows = await db.shareMeta.where('listId').equals(list.id).toArray();
  const meta = new Map(metaRows.map((row) => [row.key, row]));

  let applied = 0;
  let conflicts = 0;
  let undecryptable = 0;

  for (const record of remote) {
    const itemId = parseRecordKey(list.id, record.recordKey);
    if (!itemId) continue;

    const known = meta.get(record.recordKey);
    const localVersion: RecordVersion | undefined = known
      ? { key: known.key, hash: known.hash, updatedAt: known.updatedAt, deleted: known.deleted === 1 }
      : undefined;
    const remoteVersion: RecordVersion = {
      key: record.recordKey,
      hash: record.deleted ? 'deleted' : (record.ciphertext ?? ''),
      updatedAt: record.updatedAt,
      deleted: record.deleted,
    };

    const decision: MergeDecision = localVersion
      ? preferDeletion(localVersion, remoteVersion)
      : decideMerge(undefined, remoteVersion);
    if (decision !== 'take-remote') {
      if (decision === 'keep-local') conflicts += 1;
      continue;
    }

    if (record.deleted) {
      await db.packItems.delete(itemId);
      await db.shareMeta.put({
        key: record.recordKey,
        listId: list.id,
        hash: 'deleted',
        updatedAt: record.updatedAt,
        syncedAt: Date.now(),
        deleted: 1,
      });
      applied += 1;
      continue;
    }

    if (!record.ciphertext || !record.iv) continue;
    let plaintext: string;
    try {
      plaintext = await open(key, { ciphertext: record.ciphertext, iv: record.iv }, record.recordKey);
    } catch {
      undecryptable += 1;
      continue;
    }

    let item: PackItem;
    try {
      item = JSON.parse(plaintext) as PackItem;
    } catch {
      undecryptable += 1;
      continue;
    }
    if (item.id !== itemId) {
      undecryptable += 1;
      continue;
    }

    // The one field never taken as sent: see the module doc. Every other field is the sender's.
    const stored: PackItem = { ...item, tripId };
    await db.packItems.put(stored);
    await db.shareMeta.put({
      key: record.recordKey,
      listId: list.id,
      hash: canonicalJson(stored),
      updatedAt: record.updatedAt,
      syncedAt: Date.now(),
      deleted: 0,
    });
    applied += 1;
  }

  return { applied, conflicts, undecryptable };
}

// ---------------------------------------------------------------- the loop

export type ShareSyncOutcome =
  | { kind: 'synced'; pushed: number; pulled: number; conflicts: number; undecryptable: number }
  | { kind: 'forbidden' }
  | { kind: 'offline'; detail: string };

/** One full sync of one list: push what changed here, then pull until caught up. */
export async function runShareSync(listId: string, now: EpochMs = Date.now()): Promise<ShareSyncOutcome> {
  const list = await db.sharedLists.get(listId);
  if (!list) return { kind: 'offline', detail: 'no such list on this device' };

  const ctx = await signedContext();
  if (!ctx) return { kind: 'offline', detail: 'no push registration to sign with' };

  try {
    // Viewers never attempt a push: the server would refuse it, but skipping avoids a doomed request
    // and the false "conflicts" a refused write would otherwise be miscounted as by the caller.
    let pushed = 0;
    if (list.role !== 'viewer') {
      const { records, meta } = await pendingForList(list);
      for (let offset = 0; offset < records.length; offset += PUSH_BATCH) {
        const batch = records.slice(offset, offset + PUSH_BATCH);
        const request: SharePushRequest = { listId, records: batch };
        const response = await postSigned<SharePushResponse>(ctx, ROUTES.sharePush, request);
        if (response.kind === 'forbidden') return { kind: 'forbidden' };

        const keys = new Set(batch.map((r) => r.recordKey));
        await db.shareMeta.bulkPut(meta.filter((row) => keys.has(row.key)).map((row) => ({ ...row, syncedAt: Date.now() })));
        pushed += batch.length;
      }
    }

    let cursor = list.cursor;
    let pulled = 0;
    let conflicts = 0;
    let undecryptable = 0;
    let more = true;
    let role = list.role;

    while (more) {
      const request: SharePullRequest = { listId, cursor };
      const response = await postSigned<SharePullResponse>(ctx, ROUTES.sharePull, request);
      const result = await applyRemoteForList(list, response.records);
      pulled += result.applied;
      conflicts += result.conflicts;
      undecryptable += result.undecryptable;
      cursor = response.cursor;
      more = response.more;
      role = response.role;
      await db.sharedLists.update(listId, { cursor, lastSyncedAt: now, role });
    }

    return { kind: 'synced', pushed, pulled, conflicts, undecryptable };
  } catch (cause) {
    return { kind: 'offline', detail: String(cause) };
  }
}

/** Runs every list this device belongs to. Failures are independent — one offline list does not stop the rest. */
export async function runAllShareSyncs(now: EpochMs = Date.now()): Promise<Map<string, ShareSyncOutcome>> {
  const lists = await db.sharedLists.toArray();
  const results = new Map<string, ShareSyncOutcome>();
  for (const list of lists) results.set(list.id, await runShareSync(list.id, now));
  return results;
}
