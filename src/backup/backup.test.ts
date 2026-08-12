import { beforeEach, describe, expect, it } from 'vitest';
import { db, DB_VERSION, type Entry } from '../db/schema';
import { defaultSettings } from '../db/settings';
import {
  BACKUP_FORMAT,
  BackupFormatError,
  backupFilename,
  exportBackup,
  importBackup,
} from './backup';

async function addEntry(body: string): Promise<Entry> {
  const entry: Entry = {
    id: crypto.randomUUID(),
    body,
    rawInput: body,
    capturedAt: 1000,
    source: 'text',
    language: 'en',
    searchTokens: [body.toLowerCase()],
  };
  await db.entries.add(entry);
  return entry;
}

beforeEach(async () => {
  await db.open();
  await Promise.all([
    db.entries.clear(),
    db.events.clear(),
    db.triggers.clear(),
    db.links.clear(),
    db.settings.clear(),
    db.pushRegistration.clear(),
  ]);
  await db.settings.put(defaultSettings());
});

describe('exportBackup', () => {
  it('round-trips the data through a full wipe', async () => {
    // The property that matters: iOS clears storage, the user restores, nothing is lost.
    const entry = await addEntry('Dinner with Alex');
    const backup = await exportBackup(5000);

    await db.entries.clear();
    expect(await db.entries.count()).toBe(0);

    const result = await importBackup(JSON.stringify(backup));
    expect(result.restored).toBeGreaterThan(0);
    const restored = await db.entries.get(entry.id);
    expect(restored).toEqual(entry);
  });

  it('stamps the schema version and export time', async () => {
    const backup = await exportBackup(5000);
    expect(backup.format).toBe(BACKUP_FORMAT);
    expect(backup.schemaVersion).toBe(DB_VERSION);
    expect(backup.exportedAt).toBe(5000);
  });

  it('records the export so the backup nag can stop asking', async () => {
    await exportBackup(5000);
    expect((await db.settings.get('singleton'))!.lastExportAt).toBe(5000);
  });

  it('never includes the push registration', async () => {
    // Per-install. A backup restored onto another device must not inherit the first device's
    // subscription, or one person's reminders would arrive on another person's phone.
    await db.pushRegistration.put({
      id: 'singleton',
      subscriptionId: 'sub-1',
      endpoint: 'https://web.push.apple.com/x',
      p256dh: 'p',
      auth: 'a',
      vapidPublicKey: 'k',
      signingKeyPair: {} as CryptoKeyPair,
      registeredAt: 1,
      lastReconciledAt: null,
    });

    const backup = await exportBackup(5000);
    expect(Object.keys(backup.tables)).not.toContain('pushRegistration');
    expect(JSON.stringify(backup)).not.toContain('web.push.apple.com');
  });

  it('survives a round trip through JSON text', async () => {
    await addEntry('Dinner with Alex');
    const text = JSON.stringify(await exportBackup(5000));
    await db.entries.clear();
    await importBackup(text);
    expect(await db.entries.count()).toBe(1);
  });
});

describe('backupFilename', () => {
  it('sorts chronologically and has no characters that break a filesystem', () => {
    const name = backupFilename(Date.UTC(2026, 5, 10, 14, 30, 5));
    expect(name).toBe('remind-backup-2026-06-10-14-30-05.json');
    expect(name).not.toMatch(/[:/\\]/);
  });
});

describe('importBackup — replaces rather than merges', () => {
  it('removes data that is not in the backup', async () => {
    const kept = await addEntry('In the backup');
    const backup = await exportBackup(5000);
    const extra = await addEntry('Added after the backup');

    await importBackup(JSON.stringify(backup));

    expect(await db.entries.get(kept.id)).toBeDefined();
    // Replace, not merge: merging divergent copies needs conflict rules this app cannot invent.
    expect(await db.entries.get(extra.id)).toBeUndefined();
  });
});

describe('importBackup — refuses bad input', () => {
  it('rejects malformed JSON', async () => {
    await expect(importBackup('not json at all')).rejects.toThrow(BackupFormatError);
  });

  it('rejects a file that is not a ReMind backup', async () => {
    await expect(importBackup(JSON.stringify({ hello: 'world' }))).rejects.toThrow(
      /not a ReMind backup/,
    );
    await expect(importBackup(JSON.stringify(null))).rejects.toThrow(BackupFormatError);
  });

  it('refuses a backup from a newer schema rather than silently dropping fields', async () => {
    const future = {
      format: BACKUP_FORMAT,
      schemaVersion: DB_VERSION + 1,
      exportedAt: 1,
      tables: {},
    };
    await expect(importBackup(JSON.stringify(future))).rejects.toThrow(/newer version/);
  });

  it('leaves existing data intact when the import fails', async () => {
    const entry = await addEntry('Should survive');
    await expect(importBackup('{ broken')).rejects.toThrow();
    expect(await db.entries.get(entry.id)).toBeDefined();
  });

  it('reports unknown tables instead of failing on them', async () => {
    // Forward compatibility within the same schema version: a table this build does not know is
    // skipped and named, not guessed at.
    const backup = await exportBackup(5000);
    const withExtra = {
      ...backup,
      tables: { ...backup.tables, futurePhaseTable: [{ id: 'x' }] },
    };
    const result = await importBackup(JSON.stringify(withExtra));
    expect(result.skippedTables).toEqual(['futurePhaseTable']);
  });
});
