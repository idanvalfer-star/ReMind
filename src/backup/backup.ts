/**
 * JSON export and import.
 *
 * Not a nice-to-have. iOS evicts IndexedDB from home-screen web apps without warning and without
 * asking, and this app holds someone's externalised memory — so a way to get the data out, and
 * back, is a correctness requirement rather than a feature.
 *
 * What is deliberately *not* exported: the push registration. It is per-install, and a backup
 * restored onto another device must not inherit the first device's push subscription — that would
 * silently send one person's reminders to another's phone.
 */

import { db, DB_VERSION, TABLE_NAMES, type TableName } from '../db/schema';

export const BACKUP_FORMAT = 'remind.backup';

export interface Backup {
  format: typeof BACKUP_FORMAT;
  /** Dexie schema version the export came from. */
  schemaVersion: number;
  exportedAt: number;
  tables: Partial<Record<TableName, unknown[]>>;
}

/** Serialises every table that carries user data. */
export async function exportBackup(now = Date.now()): Promise<Backup> {
  const tables: Partial<Record<TableName, unknown[]>> = {};

  await db.transaction('r', TABLE_NAMES.map((name) => db.table(name)), async () => {
    for (const name of TABLE_NAMES) {
      tables[name] = await db.table(name).toArray();
    }
  });

  // Stamped so the nag knows when to stop asking.
  await db.settings.update('singleton', { lastExportAt: now });

  return { format: BACKUP_FORMAT, schemaVersion: DB_VERSION, exportedAt: now, tables };
}

/** Filename that sorts chronologically and survives being emailed to yourself. */
export function backupFilename(now = Date.now()): string {
  const stamp = new Date(now).toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `remind-backup-${stamp}.json`;
}

export interface ImportResult {
  restored: number;
  /** Tables present in the file but unknown to this build — ignored rather than guessed at. */
  skippedTables: string[];
}

export class BackupFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupFormatError';
  }
}

function assertBackup(value: unknown): asserts value is Backup {
  if (typeof value !== 'object' || value === null) {
    throw new BackupFormatError('not an object');
  }
  const candidate = value as Partial<Backup>;
  if (candidate.format !== BACKUP_FORMAT) {
    throw new BackupFormatError('not a ReMind backup');
  }
  if (typeof candidate.schemaVersion !== 'number') {
    throw new BackupFormatError('missing schema version');
  }
  if (candidate.schemaVersion > DB_VERSION) {
    // Refuse rather than guess: a newer file may contain fields this build would silently drop,
    // and the user would not find out until the data was already gone.
    throw new BackupFormatError(
      `backup is from a newer version (${candidate.schemaVersion} > ${DB_VERSION})`,
    );
  }
  if (typeof candidate.tables !== 'object' || candidate.tables === null) {
    throw new BackupFormatError('missing tables');
  }
}

/**
 * Replaces this device's contents with a backup.
 *
 * A replace, not a merge. Merging two divergent copies of an entity graph needs conflict rules
 * this app has no basis for inventing, and a half-merged memory is worse than either version. The
 * caller is responsible for saying so plainly before invoking it.
 *
 * The whole thing runs in one transaction, so a malformed file part-way through leaves the
 * existing data intact rather than half-erased.
 */
export async function importBackup(raw: string): Promise<ImportResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BackupFormatError('not valid JSON');
  }
  assertBackup(parsed);

  const known = new Set<string>(TABLE_NAMES);
  const skippedTables = Object.keys(parsed.tables).filter((name) => !known.has(name));

  let restored = 0;
  await db.transaction('rw', TABLE_NAMES.map((name) => db.table(name)), async () => {
    for (const name of TABLE_NAMES) {
      const rows = parsed.tables[name];
      await db.table(name).clear();
      if (!Array.isArray(rows) || rows.length === 0) continue;
      await db.table(name).bulkAdd(rows);
      restored += rows.length;
    }
  });

  return { restored, skippedTables };
}
