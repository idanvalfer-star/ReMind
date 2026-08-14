import { beforeEach, describe, expect, it } from 'vitest';
import { db, type PackItem, type SharedList } from '../db/schema';
import { importListKey, newListKey } from './invite';
import { seal } from '../sync/crypto';
import { applyRemoteForList, effectiveTripId, pendingForList } from './list';
import type { ShareRecordAt } from '../shared/pushProtocol';

const NOW = Date.UTC(2026, 5, 10, 12, 0);

function makeList(overrides: Partial<SharedList> = {}): SharedList {
  return {
    id: crypto.randomUUID(),
    key: newListKey(),
    kind: 'packing',
    tripId: 'trip-owner-has-locally',
    title: 'Iceland packing list',
    role: 'owner',
    cursor: 0,
    lastSyncedAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

async function addItem(tripId: string, overrides: Partial<PackItem> = {}): Promise<PackItem> {
  const item: PackItem = {
    id: crypto.randomUUID(),
    tripId,
    label: 'Passport',
    quantity: 1,
    packed: 0,
    isReturnLeg: 0,
    category: 'documents',
    origin: 'manual',
    createdAt: NOW,
    ...overrides,
  };
  await db.packItems.add(item);
  return item;
}

/** A remote record as the server would return it, sealed with the list's key. */
async function remoteRecord(
  list: SharedList,
  item: PackItem,
  updatedAt: number,
  revision = 1,
  author = 'someone-else',
): Promise<ShareRecordAt> {
  const recordKey = `${list.id}/packItems:${item.id}`;
  const key = await importListKey(list.key);
  const sealed = await seal(key, JSON.stringify(item), recordKey);
  return { recordKey, ...sealed, updatedAt, deleted: false, revision, author };
}

beforeEach(async () => {
  await db.open();
  await Promise.all([
    db.packItems.clear(),
    db.sharedLists.clear(),
    db.shareMeta.clear(),
    db.trips.clear(),
  ]);
});

describe('effectiveTripId', () => {
  it('uses the real trip when this device owns one', () => {
    const list = makeList({ tripId: 'the-real-trip' });
    expect(effectiveTripId(list)).toBe('the-real-trip');
  });

  it('falls back to the list id when this device only joined', () => {
    const list = makeList({ tripId: null });
    expect(effectiveTripId(list)).toBe(list.id);
  });
});

describe('pendingForList', () => {
  it('sends a new item, keyed under the list rather than the bare table', async () => {
    const list = makeList();
    const item = await addItem(effectiveTripId(list));

    const { records } = await pendingForList(list);
    expect(records).toHaveLength(1);
    expect(records[0]?.recordKey).toBe(`${list.id}/packItems:${item.id}`);
  });

  it('does not resend an item already pushed and unchanged', async () => {
    const list = makeList();
    const item = await addItem(effectiveTripId(list));

    const first = await pendingForList(list);
    await db.shareMeta.bulkPut(first.meta.map((row) => ({ ...row, syncedAt: Date.now() })));

    const second = await pendingForList(list);
    expect(second.records).toHaveLength(0);
    void item;
  });

  it('resends an item whose content changed since it was last pushed', async () => {
    const list = makeList();
    const item = await addItem(effectiveTripId(list));
    const first = await pendingForList(list);
    await db.shareMeta.bulkPut(first.meta.map((row) => ({ ...row, syncedAt: Date.now() })));

    await db.packItems.update(item.id, { packed: 1 });
    const second = await pendingForList(list);
    expect(second.records).toHaveLength(1);
  });

  it('sends a tombstone for an item deleted since the last push', async () => {
    const list = makeList();
    const item = await addItem(effectiveTripId(list));
    const first = await pendingForList(list);
    await db.shareMeta.bulkPut(first.meta.map((row) => ({ ...row, syncedAt: Date.now() })));

    await db.packItems.delete(item.id);
    const second = await pendingForList(list);
    expect(second.records).toEqual([
      expect.objectContaining({ recordKey: `${list.id}/packItems:${item.id}`, deleted: true, ciphertext: null }),
    ]);
  });

  it('ignores items belonging to a different trip entirely', async () => {
    const list = makeList({ tripId: 'trip-a' });
    await addItem('trip-b');
    const { records } = await pendingForList(list);
    expect(records).toHaveLength(0);
  });

  it('seals content such that the plaintext label is absent from the wire record', async () => {
    const list = makeList();
    await addItem(effectiveTripId(list), { label: 'a-distinctive-label-4c7b' });
    const { records } = await pendingForList(list);
    expect(JSON.stringify(records)).not.toContain('a-distinctive-label-4c7b');
  });

  it('a retry after a dropped push does not advance updatedAt past the original edit', async () => {
    // Mirrors the guarantee in src/sync/sync.ts: re-pushing identical content must not let a retry
    // win a conflict it should lose against a genuinely newer edit from elsewhere.
    const list = makeList();
    const item = await addItem(effectiveTripId(list));
    const first = await pendingForList(list);
    // Simulate the push never having been marked synced (a dropped response).
    await db.shareMeta.bulkPut(first.meta);

    const second = await pendingForList(list);
    expect(second.meta[0]?.updatedAt).toBe(first.meta[0]?.updatedAt);
    void item;
  });
});

describe('applyRemoteForList', () => {
  it('writes a new remote item under this device\'s effective tripId', async () => {
    const list = makeList({ tripId: null });
    const item: PackItem = {
      id: crypto.randomUUID(),
      // The sender's own tripId — irrelevant to the receiver, and must not survive.
      tripId: 'the-senders-own-trip',
      label: 'Charger',
      quantity: 1,
      packed: 0,
      isReturnLeg: 0,
      category: 'tech',
      origin: 'manual',
      createdAt: NOW,
    };
    const record = await remoteRecord(list, item, NOW);

    const result = await applyRemoteForList(list, [record]);
    expect(result).toEqual({ applied: 1, conflicts: 0, undecryptable: 0 });

    const stored = await db.packItems.get(item.id);
    expect(stored?.tripId).toBe(list.id);
    expect(stored?.label).toBe('Charger');
  });

  it('writes under the real trip when this device owns one', async () => {
    const list = makeList({ tripId: 'my-real-trip' });
    const item: PackItem = {
      id: crypto.randomUUID(),
      tripId: 'unrelated',
      label: 'Adapter',
      quantity: 1,
      packed: 0,
      isReturnLeg: 0,
      category: 'tech',
      origin: 'manual',
      createdAt: NOW,
    };
    await applyRemoteForList(list, [await remoteRecord(list, item, NOW)]);
    expect((await db.packItems.get(item.id))?.tripId).toBe('my-real-trip');
  });

  it('applies a tombstone by deleting the local row', async () => {
    const list = makeList();
    const item = await addItem(effectiveTripId(list));
    const key = `${list.id}/packItems:${item.id}`;

    await applyRemoteForList(list, [
      { recordKey: key, ciphertext: null, iv: null, updatedAt: NOW, deleted: true, revision: 1, author: 'x' },
    ]);
    expect(await db.packItems.get(item.id)).toBeUndefined();
  });

  it('keeps a newer local edit over an older remote one', async () => {
    const list = makeList();
    const item = await addItem(effectiveTripId(list), { label: 'local edit' });
    // Mark it as already synced at NOW, so an incoming record from before NOW is stale.
    await db.shareMeta.put({
      key: `${list.id}/packItems:${item.id}`,
      listId: list.id,
      hash: JSON.stringify(item),
      updatedAt: NOW,
      syncedAt: NOW,
      deleted: 0,
    });

    const staleRemote = { ...item, label: 'stale remote edit' };
    const result = await applyRemoteForList(list, [
      await remoteRecord(list, staleRemote, NOW - 1000),
    ]);
    expect(result.conflicts).toBe(1);
    expect((await db.packItems.get(item.id))?.label).toBe('local edit');
  });

  it('takes a newer remote edit over an older local one', async () => {
    const list = makeList();
    const item = await addItem(effectiveTripId(list), { label: 'local edit' });
    await db.shareMeta.put({
      key: `${list.id}/packItems:${item.id}`,
      listId: list.id,
      hash: JSON.stringify(item),
      updatedAt: NOW,
      syncedAt: NOW,
      deleted: 0,
    });

    const newerRemote = { ...item, label: 'newer remote edit' };
    const result = await applyRemoteForList(list, [
      await remoteRecord(list, newerRemote, NOW + 1000),
    ]);
    expect(result.applied).toBe(1);
    expect((await db.packItems.get(item.id))?.label).toBe('newer remote edit');
  });

  it('counts, rather than throws on, a record sealed under a different key', async () => {
    const list = makeList();
    const other = makeList();
    const item: PackItem = {
      id: crypto.randomUUID(),
      tripId: 'x',
      label: 'Passport',
      quantity: 1,
      packed: 0,
      isReturnLeg: 0,
      category: 'documents',
      origin: 'manual',
      createdAt: NOW,
    };
    // Sealed under `other`'s key but delivered as if it belonged to `list` — simulates a passphrase
    // mismatch or a server bug, not tampering (tampering is what the AAD binding below covers).
    const record = await remoteRecord(other, item, NOW);
    const result = await applyRemoteForList(list, [{ ...record, recordKey: `${list.id}/packItems:${item.id}` }]);
    expect(result).toEqual({ applied: 0, conflicts: 0, undecryptable: 1 });
  });

  it('counts, rather than throws on, a ciphertext moved onto a different record key', async () => {
    const list = makeList();
    const itemA = await addItem(effectiveTripId(list));
    const itemB = await addItem(effectiveTripId(list));
    const recordForA = await remoteRecord(list, itemA, NOW);
    // The record key is authenticated as AES-GCM additional data, so moving the ciphertext onto B's
    // key must fail closed rather than silently decrypting into the wrong item.
    const relabelled = { ...recordForA, recordKey: `${list.id}/packItems:${itemB.id}` };
    const result = await applyRemoteForList(list, [relabelled]);
    expect(result.undecryptable).toBe(1);
  });

  it('ignores a record whose recordKey does not belong to this list', async () => {
    const list = makeList();
    const other = makeList();
    const item = await addItem(effectiveTripId(other));
    const record = await remoteRecord(other, item, NOW);
    const result = await applyRemoteForList(list, [record]);
    expect(result).toEqual({ applied: 0, conflicts: 0, undecryptable: 0 });
  });
});
