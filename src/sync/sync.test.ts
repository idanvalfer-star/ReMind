import { beforeEach, describe, expect, it } from 'vitest';
import { db, type Entry, type Person, type SyncSpace } from '../db/schema';
import { tokenize } from '../db/tokenize';
import { hashJoinSecret, makeVerifier, newSpaceIdentity, seal } from './crypto';
import { applyRemote, pendingChanges } from './sync';
import { hashRecord, recordKey } from './records';
import type { SyncRecordAt } from '../shared/pushProtocol';

const NOW = Date.UTC(2026, 5, 10, 12, 0);

/**
 * A space with a raw AES key rather than a derived one.
 *
 * `deriveSpaceSecrets` is 600,000 PBKDF2 iterations and is tested on its own. These tests are about
 * change detection and merging, so they skip the KDF and keep the suite fast.
 */
async function makeSpace(): Promise<SyncSpace> {
  const identity = newSpaceIdentity();
  const key = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(new ArrayBuffer(32)).fill(3),
    'AES-GCM',
    false,
    ['encrypt', 'decrypt'],
  );
  const space: SyncSpace = {
    id: 'singleton',
    spaceId: identity.spaceId,
    salt: identity.salt,
    key,
    verifier: await makeVerifier(key, identity.spaceId),
    joinHash: await hashJoinSecret('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
    enabled: true,
    lastSyncedAt: null,
    cursor: 0,
  };
  await db.syncSpace.put(space);
  return space;
}

async function addEntry(body: string, id = crypto.randomUUID()): Promise<Entry> {
  const entry: Entry = {
    id,
    body,
    rawInput: body,
    capturedAt: NOW,
    source: 'text',
    language: 'en',
    searchTokens: tokenize(body),
  };
  await db.entries.add(entry);
  return entry;
}

/** A remote record as the server would return it, sealed with the space key. */
async function remoteRecord(
  space: SyncSpace,
  table: 'entries' | 'people',
  row: Record<string, unknown>,
  updatedAt: number,
  revision = 1,
): Promise<SyncRecordAt> {
  const key = recordKey(table, row['id'] as string);
  const sealed = await seal(space.key, JSON.stringify(row), key);
  return { recordKey: key, ...sealed, updatedAt, deleted: false, revision };
}

beforeEach(async () => {
  await db.open();
  await Promise.all([
    db.entries.clear(),
    db.people.clear(),
    db.events.clear(),
    db.triggers.clear(),
    db.syncMeta.clear(),
    db.syncSpace.clear(),
  ]);
});

describe('pendingChanges', () => {
  it('is empty with no space configured', async () => {
    await addEntry('a note');
    expect(await pendingChanges(NOW)).toEqual({ records: [], meta: [] });
  });

  it('seals every row on a first sync', async () => {
    const space = await makeSpace();
    await addEntry('one');
    await addEntry('two');

    const { records } = await pendingChanges(NOW);
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record.ciphertext).toBeTruthy();
      expect(record.iv).toBeTruthy();
      expect(record.deleted).toBe(false);
      // The record key is the authenticated context, so it must be the key the row is stored under.
      expect(record.recordKey.startsWith('entries:')).toBe(true);
    }
    expect(space.spaceId).toBeTruthy();
  });

  it('sends nothing for rows already synced and unchanged', async () => {
    await makeSpace();
    const entry = await addEntry('one');
    await db.syncMeta.put({
      key: recordKey('entries', entry.id),
      hash: await hashRecord(entry),
      updatedAt: NOW - 1000,
      syncedAt: NOW - 500,
      deleted: 0,
    });

    expect((await pendingChanges(NOW)).records).toEqual([]);
  });

  it('notices an edited row', async () => {
    await makeSpace();
    const entry = await addEntry('before');
    await db.syncMeta.put({
      key: recordKey('entries', entry.id),
      hash: await hashRecord(entry),
      updatedAt: NOW - 1000,
      syncedAt: NOW - 500,
      deleted: 0,
    });

    await db.entries.update(entry.id, { body: 'after' });
    const { records, meta } = await pendingChanges(NOW);
    expect(records).toHaveLength(1);
    // A real edit moves updatedAt forward, which is what lets it win a conflict.
    expect(meta[0]?.updatedAt).toBe(NOW);
  });

  it('does not move updatedAt when merely re-pushing after a failure', async () => {
    // Otherwise a retry would make an old edit look newer than a genuinely newer one on another device.
    await makeSpace();
    const entry = await addEntry('one');
    await db.syncMeta.put({
      key: recordKey('entries', entry.id),
      hash: await hashRecord(entry),
      updatedAt: NOW - 5000,
      // Never confirmed by the server.
      syncedAt: null,
      deleted: 0,
    });

    const { meta } = await pendingChanges(NOW);
    expect(meta[0]?.updatedAt).toBe(NOW - 5000);
  });

  it('emits a tombstone for a row that has gone', async () => {
    // Without this a deletion on one device is silently undone by the next pull from another.
    await makeSpace();
    const entry = await addEntry('doomed');
    await db.syncMeta.put({
      key: recordKey('entries', entry.id),
      hash: await hashRecord(entry),
      updatedAt: NOW - 1000,
      syncedAt: NOW - 500,
      deleted: 0,
    });
    await db.entries.delete(entry.id);

    const { records } = await pendingChanges(NOW);
    expect(records).toEqual([
      { recordKey: recordKey('entries', entry.id), ciphertext: null, iv: null, updatedAt: NOW, deleted: true },
    ]);
  });

  it('does not re-emit a tombstone that has already been sent', async () => {
    await makeSpace();
    await db.syncMeta.put({
      key: recordKey('entries', 'gone'),
      hash: 'deleted',
      updatedAt: NOW - 1000,
      syncedAt: NOW - 500,
      deleted: 1,
    });
    expect((await pendingChanges(NOW)).records).toEqual([]);
  });

  it('covers more than one table', async () => {
    await makeSpace();
    await addEntry('a note');
    await db.people.add({
      id: crypto.randomUUID(),
      name: 'Sarah',
      aliases: [],
      cadenceDays: null,
      lastInteractionAt: null,
      createdAt: NOW,
    });

    const { records } = await pendingChanges(NOW);
    const tables = records.map((record) => record.recordKey.split(':')[0]).sort();
    expect(tables).toEqual(['entries', 'people']);
  });

  it('never sends settings, which describes the device rather than the data', async () => {
    await makeSpace();
    await addEntry('a note');
    const { records } = await pendingChanges(NOW);
    expect(records.some((record) => record.recordKey.startsWith('settings:'))).toBe(false);
  });
});

describe('applyRemote', () => {
  it('writes a new record into its table', async () => {
    const space = await makeSpace();
    const row = {
      id: crypto.randomUUID(),
      body: 'from the other device',
      rawInput: 'from the other device',
      capturedAt: NOW,
      source: 'text',
      language: 'en',
      searchTokens: ['from', 'the', 'other', 'device'],
    };

    const result = await applyRemote(space, [await remoteRecord(space, 'entries', row, NOW)]);
    expect(result).toMatchObject({ applied: 1, conflicts: 0, undecryptable: 0 });
    expect((await db.entries.get(row.id))?.body).toBe('from the other device');
  });

  it('records sync metadata so the row is not immediately re-pushed', async () => {
    const space = await makeSpace();
    const row = { id: crypto.randomUUID(), name: 'Sarah', aliases: [], cadenceDays: null, lastInteractionAt: null, createdAt: NOW };
    await applyRemote(space, [await remoteRecord(space, 'people', row, NOW)]);

    const { records } = await pendingChanges(NOW);
    expect(records).toEqual([]);
  });

  it('takes a newer remote edit over the local row', async () => {
    const space = await makeSpace();
    const entry = await addEntry('local version');
    await db.syncMeta.put({
      key: recordKey('entries', entry.id),
      hash: await hashRecord(entry),
      updatedAt: NOW - 5000,
      syncedAt: NOW - 5000,
      deleted: 0,
    });

    const result = await applyRemote(space, [
      await remoteRecord(space, 'entries', { ...entry, body: 'remote version' }, NOW),
    ]);
    expect(result.applied).toBe(1);
    expect((await db.entries.get(entry.id))?.body).toBe('remote version');
  });

  it('keeps a newer local edit and counts the conflict', async () => {
    const space = await makeSpace();
    const entry = await addEntry('local wins');
    await db.syncMeta.put({
      key: recordKey('entries', entry.id),
      hash: await hashRecord(entry),
      updatedAt: NOW,
      syncedAt: NOW,
      deleted: 0,
    });

    const result = await applyRemote(space, [
      await remoteRecord(space, 'entries', { ...entry, body: 'stale remote' }, NOW - 5000),
    ]);
    expect(result).toMatchObject({ applied: 0, conflicts: 1 });
    expect((await db.entries.get(entry.id))?.body).toBe('local wins');
  });

  it('applies a remote deletion', async () => {
    const space = await makeSpace();
    const entry = await addEntry('to be deleted');
    await db.syncMeta.put({
      key: recordKey('entries', entry.id),
      hash: await hashRecord(entry),
      updatedAt: NOW - 5000,
      syncedAt: NOW - 5000,
      deleted: 0,
    });

    const result = await applyRemote(space, [
      {
        recordKey: recordKey('entries', entry.id),
        ciphertext: null,
        iv: null,
        updatedAt: NOW,
        deleted: true,
        revision: 2,
      },
    ]);
    expect(result.applied).toBe(1);
    expect(await db.entries.get(entry.id)).toBeUndefined();
  });

  it('does not re-push a deletion it learned from the server', async () => {
    const space = await makeSpace();
    const entry = await addEntry('doomed');
    await applyRemote(space, [
      {
        recordKey: recordKey('entries', entry.id),
        ciphertext: null,
        iv: null,
        updatedAt: NOW,
        deleted: true,
        revision: 2,
      },
    ]);
    expect((await pendingChanges(NOW)).records).toEqual([]);
  });

  it('skips a record it cannot decrypt rather than failing the whole sync', async () => {
    // Another device could have written with a different key after a passphrase change, or someone with
    // the space id could have written garbage. Neither should stop the records that did arrive intact.
    const space = await makeSpace();
    const good = { id: crypto.randomUUID(), body: 'fine', rawInput: 'fine', capturedAt: NOW, source: 'text', language: 'en', searchTokens: ['fine'] };

    const result = await applyRemote(space, [
      { recordKey: 'entries:garbage', ciphertext: 'AAAAAAAAAAAAAAAAAAAA', iv: 'AAAAAAAAAAAAAAAA', updatedAt: NOW, deleted: false, revision: 1 },
      await remoteRecord(space, 'entries', good, NOW, 1),
    ]);

    expect(result).toMatchObject({ applied: 1, undecryptable: 1 });
    expect((await db.entries.get(good.id))?.body).toBe('fine');
  });

  it('refuses a record whose decrypted id does not match its key', async () => {
    const space = await makeSpace();
    const row = { id: 'the-real-id', body: 'x', rawInput: 'x', capturedAt: NOW, source: 'text', language: 'en', searchTokens: [] };
    // Sealed under one key but claiming another id: a client bug rather than tampering, since the id is
    // authenticated. Refusing it is still right.
    const key = recordKey('entries', 'a-different-id');
    const sealed = await seal(space.key, JSON.stringify(row), key);

    const result = await applyRemote(space, [
      { recordKey: key, ...sealed, updatedAt: NOW, deleted: false, revision: 1 },
    ]);
    expect(result.undecryptable).toBe(1);
    expect(await db.entries.get('the-real-id')).toBeUndefined();
  });

  it('ignores a record for a table that does not sync', async () => {
    const space = await makeSpace();
    const result = await applyRemote(space, [
      { recordKey: 'settings:singleton', ciphertext: 'x', iv: 'y', updatedAt: NOW, deleted: false, revision: 1 },
    ]);
    expect(result.applied).toBe(0);
  });

  it('is a no-op for an empty batch', async () => {
    const space = await makeSpace();
    expect(await applyRemote(space, [])).toEqual({ applied: 0, conflicts: 0, undecryptable: 0 });
  });

  it('round trips a Person through seal and apply unchanged', async () => {
    const space = await makeSpace();
    const person: Person = {
      id: crypto.randomUUID(),
      name: 'שרה',
      aliases: ['Sarah'],
      cadenceDays: 14,
      lastInteractionAt: NOW - 1000,
      createdAt: NOW - 90_000,
    };
    await applyRemote(space, [await remoteRecord(space, 'people', { ...person }, NOW)]);
    expect(await db.people.get(person.id)).toEqual(person);
  });
});
