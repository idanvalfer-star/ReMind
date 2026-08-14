import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  decideMerge,
  hashRecord,
  parseRecordKey,
  preferDeletion,
  recordKey,
  SYNCED_TABLES,
  type RecordVersion,
} from './records';

const version = (overrides: Partial<RecordVersion> = {}): RecordVersion => ({
  key: 'entries:a',
  hash: 'aaa',
  updatedAt: 1000,
  deleted: false,
  ...overrides,
});

describe('SYNCED_TABLES', () => {
  it('excludes settings, which describes the device rather than the data', () => {
    // Syncing timezone would make two devices fight over which is correct, and the loser would
    // silently reschedule every reminder.
    expect(SYNCED_TABLES).not.toContain('settings');
  });

  it('includes the content tables', () => {
    for (const table of ['entries', 'events', 'people', 'facts', 'trips', 'packItems'] as const) {
      expect(SYNCED_TABLES).toContain(table);
    }
  });
});

describe('recordKey', () => {
  it('round trips', () => {
    const key = recordKey('entries', '0f9c-abc');
    expect(parseRecordKey(key)).toEqual({ table: 'entries', id: '0f9c-abc' });
  });

  it('keeps an id containing colons intact', () => {
    // Splitting on the *first* colon matters: an id is opaque and may contain anything.
    expect(parseRecordKey('entries:a:b:c')).toEqual({ table: 'entries', id: 'a:b:c' });
  });

  it('rejects a key for a table that does not sync', () => {
    expect(parseRecordKey('settings:singleton')).toBeNull();
  });

  it('rejects malformed keys', () => {
    expect(parseRecordKey('')).toBeNull();
    expect(parseRecordKey('entries')).toBeNull();
    expect(parseRecordKey('entries:')).toBeNull();
    expect(parseRecordKey(':abc')).toBeNull();
  });
});

describe('canonicalJson', () => {
  it('orders keys, so two spellings of the same row agree', () => {
    // Without this, a row built by a spread and a row built by a literal would hash differently and
    // sync would re-upload the whole database every run.
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it('orders keys at every depth', () => {
    expect(canonicalJson({ outer: { z: 1, a: 2 } })).toBe(canonicalJson({ outer: { a: 2, z: 1 } }));
  });

  it('preserves array order, which is meaningful', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('treats an undefined member as absent, matching JSON', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it('handles null, primitives and nesting', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(0)).toBe('0');
    expect(canonicalJson('x')).toBe('"x"');
    expect(canonicalJson(false)).toBe('false');
    expect(canonicalJson({ a: [{ z: null, y: 1 }] })).toBe('{"a":[{"y":1,"z":null}]}');
  });

  it('escapes keys and values properly', () => {
    expect(canonicalJson({ 'a"b': 'c\nd' })).toBe('{"a\\"b":"c\\nd"}');
  });

  it('handles Hebrew without mangling it', () => {
    expect(canonicalJson({ body: 'שרה' })).toBe('{"body":"שרה"}');
  });
});

describe('hashRecord', () => {
  it('is stable for equal rows regardless of key order', async () => {
    expect(await hashRecord({ a: 1, b: 2 })).toBe(await hashRecord({ b: 2, a: 1 }));
  });

  it('differs for different rows', async () => {
    expect(await hashRecord({ a: 1 })).not.toBe(await hashRecord({ a: 2 }));
  });

  it('notices a change buried in a nested field', async () => {
    const before = { id: 'x', condition: { kind: 'time', at: 1 } };
    const after = { id: 'x', condition: { kind: 'time', at: 2 } };
    expect(await hashRecord(before)).not.toBe(await hashRecord(after));
  });

  it('is a 64-character hex digest', async () => {
    expect(await hashRecord({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('decideMerge', () => {
  it('takes the remote when there is nothing local', () => {
    expect(decideMerge(undefined, version())).toBe('take-remote');
  });

  it('keeps the local when there is nothing remote', () => {
    expect(decideMerge(version(), undefined)).toBe('keep-local');
  });

  it('reports agreement when the hashes match', () => {
    // Checked before the timestamps, because it is both the common case and the only one that is
    // certainly not a conflict.
    expect(decideMerge(version({ updatedAt: 1 }), version({ updatedAt: 999 }))).toBe('same');
  });

  it('does not report agreement when only one side is deleted', () => {
    expect(decideMerge(version(), version({ deleted: true, updatedAt: 2000 }))).toBe('take-remote');
  });

  it('takes the newer side', () => {
    expect(decideMerge(version({ updatedAt: 1000 }), version({ hash: 'bbb', updatedAt: 2000 }))).toBe(
      'take-remote',
    );
    expect(decideMerge(version({ updatedAt: 3000 }), version({ hash: 'bbb', updatedAt: 2000 }))).toBe(
      'keep-local',
    );
  });

  it('breaks a timestamp tie the same way on both devices', () => {
    // Arbitrary but *stable*: both sides must reach the same answer or they ping-pong the record
    // between them forever.
    const local = version({ hash: 'aaa' });
    const remote = version({ hash: 'bbb' });
    expect(decideMerge(local, remote)).toBe('take-remote');
    // Now from the other device's point of view, where local and remote swap.
    expect(decideMerge(remote, local)).toBe('keep-local');
  });

  it('converges: applying the decision twice changes nothing', () => {
    const local = version({ hash: 'aaa', updatedAt: 5 });
    const remote = version({ hash: 'bbb', updatedAt: 9 });
    const winner = decideMerge(local, remote) === 'take-remote' ? remote : local;
    expect(decideMerge(winner, remote)).toBe('same');
  });

  it('handles both sides absent', () => {
    expect(decideMerge(undefined, undefined)).toBe('keep-local');
  });
});

describe('preferDeletion', () => {
  it('lets a deletion win a dead heat', () => {
    // Resurrecting something the user deleted is worse than losing an edit to it: the edit is one
    // record's fields, the resurrection is a thing reappearing that they wanted gone.
    const local = version({ hash: 'aaa', updatedAt: 1000 });
    const remote = version({ hash: 'bbb', updatedAt: 1000, deleted: true });
    expect(preferDeletion(local, remote)).toBe('take-remote');
    expect(preferDeletion(remote, local)).toBe('keep-local');
  });

  it('still respects a clearly newer edit over an older deletion', () => {
    const local = version({ hash: 'aaa', updatedAt: 2000 });
    const remote = version({ hash: 'bbb', updatedAt: 1000, deleted: true });
    expect(preferDeletion(local, remote)).toBe('keep-local');
  });

  it('falls back to the ordinary rule when neither side is deleted', () => {
    const local = version({ hash: 'aaa' });
    const remote = version({ hash: 'bbb' });
    expect(preferDeletion(local, remote)).toBe(decideMerge(local, remote));
  });

  it('falls back to the ordinary rule when both are deleted', () => {
    const local = version({ hash: 'aaa', deleted: true });
    const remote = version({ hash: 'bbb', deleted: true });
    expect(preferDeletion(local, remote)).toBe(decideMerge(local, remote));
  });
});
