import { beforeEach, describe, expect, it } from 'vitest';
import { db, type Entry, type Settings, type Trigger } from '../db/schema';
import { defaultSettings } from '../db/settings';
import { tokenize } from '../db/tokenize';
import { DAY_MS, minutesOfDay } from '../engine/time';
import { isPushWorthy } from '../engine/sync';
import {
  clearDigest,
  dueAt,
  dueCount,
  dueTriggers,
  enrol,
  enrolledCount,
  ensureDigestArmed,
  isEnrolled,
  nextDigestAt,
  recordReview,
  reviewQueue,
  unenrol,
  DIGEST_TARGET_ID,
} from './review';

const JLM = 'Asia/Jerusalem';
const NOW = Date.UTC(2026, 5, 10, 6, 0); // 09:00 Jerusalem

async function settings(overrides: Partial<Settings> = {}): Promise<void> {
  await db.settings.put({ ...defaultSettings(), timezone: JLM, ...overrides });
}

async function addEntry(body: string): Promise<Entry> {
  const entry: Entry = {
    id: crypto.randomUUID(),
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

function spacedTrigger(overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: crypto.randomUUID(),
    targetType: 'entry',
    targetId: 'entry-1',
    kind: 'spaced',
    condition: {
      kind: 'spaced',
      entryId: 'entry-1',
      ease: 2.5,
      intervalDays: 1,
      reps: 1,
      lastReviewedAt: NOW,
      atMinuteOfDay: 8 * 60,
      timezone: JLM,
    },
    nextFireAt: NOW,
    lastFiredAt: null,
    active: 1,
    snoozedUntil: null,
    location: null,
    syncedFireAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

beforeEach(async () => {
  await db.open();
  await Promise.all([
    db.entries.clear(),
    db.triggers.clear(),
    db.links.clear(),
    db.settings.clear(),
    db.triggerFires.clear(),
    db.pushRegistration.clear(),
  ]);
  await settings();
});

describe('dueAt', () => {
  it('is the last review plus the interval', () => {
    expect(dueAt({ intervalDays: 6 }, NOW)).toBe(NOW + 6 * DAY_MS);
  });

  it('is the review instant itself for a zero interval', () => {
    expect(dueAt({ intervalDays: 0 }, NOW)).toBe(NOW);
  });
});

describe('dueTriggers', () => {
  it('includes a spaced trigger due now', () => {
    expect(dueTriggers([spacedTrigger()], NOW)).toHaveLength(1);
  });

  it('excludes one not yet due', () => {
    expect(dueTriggers([spacedTrigger({ nextFireAt: NOW + DAY_MS })], NOW)).toEqual([]);
  });

  it('excludes inactive triggers', () => {
    expect(dueTriggers([spacedTrigger({ active: 0 })], NOW)).toEqual([]);
  });

  it('ignores triggers of other kinds', () => {
    const time = spacedTrigger({
      kind: 'time',
      condition: { kind: 'time', at: NOW, timezone: JLM },
    });
    expect(dueTriggers([time], NOW)).toEqual([]);
  });

  it('puts the most overdue first, so a backlog drains from the front', () => {
    const recent = spacedTrigger({ nextFireAt: NOW - DAY_MS });
    const ancient = spacedTrigger({ nextFireAt: NOW - 30 * DAY_MS });
    expect(dueTriggers([recent, ancient], NOW).map((t) => t.id)).toEqual([ancient.id, recent.id]);
  });
});

describe('nextDigestAt', () => {
  it('is today when the slot is still ahead', () => {
    const early = Date.UTC(2026, 5, 10, 2, 0); // 05:00 Jerusalem
    const at = nextDigestAt(8 * 60, JLM, early);
    expect(minutesOfDay(at, JLM)).toBe(8 * 60);
    expect(at).toBeGreaterThan(early);
    expect(at - early).toBeLessThan(DAY_MS);
  });

  it('is tomorrow once the slot has passed', () => {
    const late = Date.UTC(2026, 5, 10, 12, 0); // 15:00 Jerusalem
    const at = nextDigestAt(8 * 60, JLM, late);
    expect(minutesOfDay(at, JLM)).toBe(8 * 60);
    expect(at).toBeGreaterThan(late);
    expect(at - late).toBeLessThan(DAY_MS);
  });

  it('keeps the wall clock across a DST transition', () => {
    // Israel springs forward in late March; the digest must stay at 08:00 local either side.
    const before = Date.UTC(2026, 2, 26, 12, 0);
    const after = Date.UTC(2026, 3, 2, 12, 0);
    expect(minutesOfDay(nextDigestAt(8 * 60, JLM, before), JLM)).toBe(8 * 60);
    expect(minutesOfDay(nextDigestAt(8 * 60, JLM, after), JLM)).toBe(8 * 60);
  });
});

describe('enrol', () => {
  it('puts an entry into rotation, due immediately', async () => {
    const entry = await addEntry('The vase Sarah liked');
    const trigger = await enrol(entry.id, NOW);

    expect(trigger).not.toBeNull();
    expect(await isEnrolled(entry.id)).toBe(true);
    // intervalDays 0 means the first sighting is today — enrolling something you want to see and
    // then hiding it for a day would be a strange way to honour the request.
    expect(trigger?.nextFireAt).toBeLessThanOrEqual(NOW + DAY_MS);
  });

  it('is idempotent', async () => {
    const entry = await addEntry('note');
    await enrol(entry.id, NOW);
    expect(await enrol(entry.id, NOW)).toBeNull();
    expect(await enrolledCount()).toBe(1);
  });

  it('refuses an entry that does not exist', async () => {
    expect(await enrol('missing', NOW)).toBeNull();
  });

  it('is never pushed to the backend, whatever its fire time', async () => {
    // The whole reason the digest exists: dozens of notes can come due on one day, and pushing each
    // would spend the entire daily cap on review prompts.
    const entry = await addEntry('note');
    await enrol(entry.id, NOW);
    const [trigger] = await db.triggers.toArray();
    expect(isPushWorthy({ ...trigger!, nextFireAt: NOW + DAY_MS }, NOW)).toBe(false);
  });
});

describe('unenrol', () => {
  it('takes an entry out of rotation', async () => {
    const entry = await addEntry('note');
    await enrol(entry.id, NOW);
    await unenrol(entry.id);
    expect(await isEnrolled(entry.id)).toBe(false);
    expect(await dueCount(NOW)).toBe(0);
  });

  it('is safe for an entry never enrolled', async () => {
    await expect(unenrol('missing')).resolves.toBeUndefined();
  });
});

describe('recordReview', () => {
  it('pushes the interval out on a successful review', async () => {
    const entry = await addEntry('note');
    await enrol(entry.id, NOW);

    await recordReview(entry.id, 'recalled', NOW);
    const [first] = await db.triggers.toArray();
    expect(first?.nextFireAt).toBeGreaterThan(NOW);

    // Second success reaches SM-2's six-day step.
    await recordReview(entry.id, 'recalled', NOW + DAY_MS);
    const [second] = await db.triggers.toArray();
    expect(second?.condition).toMatchObject({ intervalDays: 6, reps: 2 });
  });

  it('collapses the interval to a day on a lapse', async () => {
    const entry = await addEntry('note');
    await enrol(entry.id, NOW);
    for (const at of [NOW, NOW + DAY_MS, NOW + 8 * DAY_MS]) {
      await recordReview(entry.id, 'recalled', at);
    }
    await recordReview(entry.id, 'forgot', NOW + 30 * DAY_MS);

    const [trigger] = await db.triggers.toArray();
    expect(trigger?.condition).toMatchObject({ intervalDays: 1, reps: 0 });
  });

  it('lands the next review on the digest hour, not the minute it was answered', async () => {
    const entry = await addEntry('note');
    await enrol(entry.id, NOW);
    // 23:47 local, a deliberately awkward moment to answer at.
    await recordReview(entry.id, 'recalled', Date.UTC(2026, 5, 10, 20, 47));

    const [trigger] = await db.triggers.toArray();
    expect(minutesOfDay(trigger!.nextFireAt!, JLM)).toBe(8 * 60);
  });

  it('removes a dismissed note from rotation entirely', async () => {
    // The escape hatch SM-2 lacks: without it the only way out is an interval that grows until the
    // note vanishes, which is deletion by attrition and leaves the queue full of settled questions.
    const entry = await addEntry('note');
    await enrol(entry.id, NOW);
    await recordReview(entry.id, 'dismissed', NOW);

    expect(await isEnrolled(entry.id)).toBe(false);
    expect(await enrolledCount()).toBe(0);
  });

  it('does nothing for an entry not in rotation', async () => {
    const entry = await addEntry('note');
    await expect(recordReview(entry.id, 'recalled', NOW)).resolves.toBeUndefined();
  });
});

describe('reviewQueue', () => {
  it('returns due notes with their text, most overdue first', async () => {
    const older = await addEntry('older');
    const newer = await addEntry('newer');
    await enrol(older.id, NOW - 10 * DAY_MS);
    await enrol(newer.id, NOW - DAY_MS);

    const queue = await reviewQueue(10, NOW);
    expect(queue.map((item) => item.entry.body)).toEqual(['older', 'newer']);
    expect(queue[0]?.overdueDays).toBeGreaterThan(queue[1]!.overdueDays);
  });

  it('honours the limit', async () => {
    for (let i = 0; i < 4; i++) await enrol((await addEntry(`n${i}`)).id, NOW);
    expect(await reviewQueue(2, NOW)).toHaveLength(2);
  });

  it('skips a note whose entry has been deleted', async () => {
    const entry = await addEntry('doomed');
    await enrol(entry.id, NOW);
    await db.entries.delete(entry.id);
    expect(await reviewQueue(10, NOW)).toEqual([]);
  });

  it('is empty when nothing is due yet', async () => {
    const entry = await addEntry('note');
    await enrol(entry.id, NOW);
    await recordReview(entry.id, 'easy', NOW);
    expect(await reviewQueue(10, NOW)).toEqual([]);
  });
});

describe('ensureDigestArmed', () => {
  async function digestRow() {
    const rows = await db.triggers
      .where('[targetType+targetId]')
      .equals(['digest', DIGEST_TARGET_ID])
      .toArray();
    return rows.find((row) => row.active === 1);
  }

  it('arms nothing while the digest is off', async () => {
    await enrol((await addEntry('note')).id, NOW);
    expect(await ensureDigestArmed(NOW)).toBeNull();
    expect(await digestRow()).toBeUndefined();
  });

  it('arms nothing when the digest is on but nothing is enrolled', async () => {
    // An empty digest is the purest form of a notification that teaches people to ignore
    // notifications.
    await settings({ digest: { enabled: true, atMinuteOfDay: 8 * 60, maxItems: 5 } });
    expect(await ensureDigestArmed(NOW)).toBeNull();
    expect(await digestRow()).toBeUndefined();
  });

  it('arms one digest at the configured hour', async () => {
    await settings({ digest: { enabled: true, atMinuteOfDay: 8 * 60, maxItems: 5 } });
    await enrol((await addEntry('note')).id, NOW);

    const outcome = await ensureDigestArmed(NOW);
    expect(outcome?.kind).toBe('registered');

    const row = await digestRow();
    expect(row).toBeDefined();
    expect(minutesOfDay(row!.nextFireAt!, JLM)).toBe(8 * 60);
  });

  it('is idempotent — calling it twice leaves one digest', async () => {
    await settings({ digest: { enabled: true, atMinuteOfDay: 8 * 60, maxItems: 5 } });
    await enrol((await addEntry('note')).id, NOW);
    await ensureDigestArmed(NOW);
    await ensureDigestArmed(NOW);

    const rows = await db.triggers
      .where('[targetType+targetId]')
      .equals(['digest', DIGEST_TARGET_ID])
      .toArray();
    expect(rows.filter((row) => row.active === 1)).toHaveLength(1);
  });

  it('re-arms for the following day after the digest has fired', async () => {
    // This is the path the service worker takes: a `time` trigger fires once, so without it the
    // digest stops after one delivery.
    await settings({ digest: { enabled: true, atMinuteOfDay: 8 * 60, maxItems: 5 } });
    await enrol((await addEntry('note')).id, NOW);
    await ensureDigestArmed(NOW);

    const fired = await digestRow();
    await db.triggers.update(fired!.id, { nextFireAt: null, lastFiredAt: NOW });

    const afterFiring = Date.UTC(2026, 5, 11, 5, 1); // just past 08:00 Jerusalem
    await ensureDigestArmed(afterFiring);

    const next = await digestRow();
    expect(next?.nextFireAt).toBeGreaterThan(afterFiring);
    expect(minutesOfDay(next!.nextFireAt!, JLM)).toBe(8 * 60);
  });

  it('removes the digest when it is switched off', async () => {
    await settings({ digest: { enabled: true, atMinuteOfDay: 8 * 60, maxItems: 5 } });
    await enrol((await addEntry('note')).id, NOW);
    await ensureDigestArmed(NOW);
    expect(await digestRow()).toBeDefined();

    await settings({ digest: { enabled: false, atMinuteOfDay: 8 * 60, maxItems: 5 } });
    await ensureDigestArmed(NOW);
    expect(await digestRow()).toBeUndefined();
  });

  it('removes the digest once the last note leaves rotation', async () => {
    await settings({ digest: { enabled: true, atMinuteOfDay: 8 * 60, maxItems: 5 } });
    const entry = await addEntry('note');
    await enrol(entry.id, NOW);
    await ensureDigestArmed(NOW);

    await recordReview(entry.id, 'dismissed', NOW);
    await ensureDigestArmed(NOW);
    expect(await digestRow()).toBeUndefined();
  });

  it('clearDigest removes it directly', async () => {
    await settings({ digest: { enabled: true, atMinuteOfDay: 8 * 60, maxItems: 5 } });
    await enrol((await addEntry('note')).id, NOW);
    await ensureDigestArmed(NOW);
    await clearDigest();
    expect(await digestRow()).toBeUndefined();
  });
});

describe('enrolment is due immediately, whatever the hour', () => {
  it('is due at once even when enrolled before the digest hour', async () => {
    // The bug this pins: snapping a zero interval to the digest hour made a freshly enrolled note
    // invisible until 08:00, so the review card simply did not appear for anyone enrolling earlier.
    const beforeDigest = Date.UTC(2026, 5, 10, 2, 0); // 05:00 Jerusalem, digest at 08:00
    const entry = await addEntry('the vase');
    await enrol(entry.id, beforeDigest);

    const queue = await reviewQueue(10, beforeDigest);
    expect(queue.map((item) => item.entry.body)).toEqual(['the vase']);
  });

  it('is due at once when enrolled after the digest hour too', async () => {
    const afterDigest = Date.UTC(2026, 5, 10, 12, 0); // 15:00 Jerusalem
    const entry = await addEntry('the vase');
    await enrol(entry.id, afterDigest);
    expect(await reviewQueue(10, afterDigest)).toHaveLength(1);
  });

  it('snaps the *second* review to the digest hour, which is what snapping is for', async () => {
    const at = Date.UTC(2026, 5, 10, 2, 0);
    const entry = await addEntry('the vase');
    await enrol(entry.id, at);
    await recordReview(entry.id, 'recalled', at);

    const [trigger] = await db.triggers.toArray();
    expect(minutesOfDay(trigger!.nextFireAt!, JLM)).toBe(8 * 60);
  });
});
