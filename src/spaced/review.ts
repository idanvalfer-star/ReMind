/**
 * The spaced-repetition review queue and its daily digest.
 *
 * Two halves that have to be kept apart:
 *
 * - **The schedule** is one `spaced` trigger per enrolled Entry, holding its SM-2 state. These are
 *   never pushed — see the note in `isPushWorthy`. Dozens of notes can come due on one day, and
 *   pushing each would spend the whole daily cap on review prompts.
 * - **The delivery** is a single daily digest trigger carrying a count. It is an ordinary trigger, so
 *   quiet hours and the cap apply to it like anything else.
 *
 * There are no home-screen widgets on the web, so this digest plus the Today screen is the entire
 * spaced-repetition surface — which is what the brief settles on for exactly that reason.
 */

import { db, type EpochMs, type Entry, type ID, type Trigger } from '../db/schema';
import { loadSettings } from '../db/settings';
import { cancelTrigger, registerTrigger, type RegisterOutcome } from '../engine/index';
import { atLocalMinutesOnDayOf, DAY_MS, startOfNextLocalDay } from '../engine/time';
import { answer, initialState, type Answer, type SpacedState } from './sm2';

/** The digest is a singleton, so its trigger has a fixed target id. */
export const DIGEST_TARGET_ID = 'singleton';

// ---------------------------------------------------------------- pure

/** When a note with this state, last reviewed then, is next due. */
export function dueAt(state: Pick<SpacedState, 'intervalDays'>, lastReviewedAt: EpochMs): EpochMs {
  return lastReviewedAt + state.intervalDays * DAY_MS;
}

/**
 * The spaced triggers due at or before `now`, most overdue first.
 *
 * Pure so the queue's ordering is testable without a database. Ordering matters: a note that has been
 * waiting three weeks should be asked about before one that came due this morning, otherwise a long
 * backlog never drains from the front.
 */
export function dueTriggers(triggers: readonly Trigger[], now: EpochMs): Trigger[] {
  return triggers
    .filter(
      (trigger) =>
        trigger.active === 1 &&
        trigger.condition.kind === 'spaced' &&
        trigger.nextFireAt !== null &&
        trigger.nextFireAt <= now,
    )
    .sort((a, b) => (a.nextFireAt as number) - (b.nextFireAt as number));
}

/**
 * The next daily digest instant strictly after `now`.
 *
 * Today's slot if it has not passed, tomorrow's otherwise. Calendar arithmetic rather than
 * `+ DAY_MS`, because a local day is 23 or 25 hours across a DST boundary and the digest has to keep
 * landing at the same wall-clock time.
 */
export function nextDigestAt(atMinuteOfDay: number, timezone: string, now: EpochMs): EpochMs {
  const today = atLocalMinutesOnDayOf(now, timezone, atMinuteOfDay);
  if (today > now) return today;
  return atLocalMinutesOnDayOf(startOfNextLocalDay(now, timezone), timezone, atMinuteOfDay);
}

// ---------------------------------------------------------------- enrolment

export interface ReviewItem {
  trigger: Trigger;
  entry: Entry;
  state: SpacedState;
  /** Whole days late. Zero means due today. */
  overdueDays: number;
}

function stateOf(trigger: Trigger): SpacedState {
  const condition = trigger.condition;
  if (condition.kind !== 'spaced') return initialState();
  return {
    ease: condition.ease,
    intervalDays: condition.intervalDays,
    reps: condition.reps,
  };
}

async function spacedTriggerFor(entryId: ID): Promise<Trigger | undefined> {
  const triggers = await db.triggers
    .where('[targetType+targetId]')
    .equals(['entry', entryId])
    .toArray();
  return triggers.find((trigger) => trigger.condition.kind === 'spaced' && trigger.active === 1);
}

export async function isEnrolled(entryId: ID): Promise<boolean> {
  return (await spacedTriggerFor(entryId)) !== undefined;
}

/**
 * Puts an Entry into the review rotation.
 *
 * The first review is due immediately — `intervalDays: 0` — because the point of enrolling something
 * is that you want to be shown it, and making the user wait a day for the first sight of it is a
 * strange way to honour that.
 *
 * Goes through `registerTrigger` like everything else. It cannot be refused by quiet hours or the
 * cap, but not because it is special-cased here — `canInterrupt` says a `spaced` trigger has no
 * delivery of its own, and the engine exempts exactly those. Getting that wrong meant enrolling a
 * note at 05:00 silently did nothing.
 */
export async function enrol(entryId: ID, now: EpochMs = Date.now()): Promise<Trigger | null> {
  if (await isEnrolled(entryId)) return null;
  const entry = await db.entries.get(entryId);
  if (!entry) return null;

  const settings = await loadSettings();
  const state = initialState();
  const outcome = await registerTrigger({
    targetType: 'entry',
    targetId: entryId,
    condition: {
      kind: 'spaced',
      entryId,
      ease: state.ease,
      intervalDays: state.intervalDays,
      reps: state.reps,
      lastReviewedAt: now,
      atMinuteOfDay: settings.digest.atMinuteOfDay,
      timezone: settings.timezone,
    },
    link: { fromType: 'entry', fromId: entryId, relation: 'reminds-of' },
  });

  return outcome.kind === 'registered' ? outcome.trigger : null;
}

/** Takes an Entry out of the rotation. */
export async function unenrol(entryId: ID): Promise<void> {
  const trigger = await spacedTriggerFor(entryId);
  if (trigger) await cancelTrigger(trigger.id);
}

/**
 * Records a review and reschedules.
 *
 * `dismissed` is a fourth answer beyond SM-2's three, and it is the one that makes the feature
 * bearable: a note you no longer want asked about leaves the rotation entirely rather than being
 * pushed to a long interval. Without it, the only way out is a schedule that grows until the note
 * effectively disappears — which is deletion, achieved by attrition, and it leaves the queue full of
 * things the user has already decided about.
 */
export async function recordReview(
  entryId: ID,
  given: Answer | 'dismissed',
  now: EpochMs = Date.now(),
): Promise<void> {
  const trigger = await spacedTriggerFor(entryId);
  if (!trigger || trigger.condition.kind !== 'spaced') return;

  if (given === 'dismissed') {
    await cancelTrigger(trigger.id);
    return;
  }

  const next = answer(stateOf(trigger), given);
  await db.triggers.update(trigger.id, {
    condition: {
      ...trigger.condition,
      ease: next.ease,
      intervalDays: next.intervalDays,
      reps: next.reps,
      lastReviewedAt: now,
    },
    // Snapped to the digest hour on the due day, so a note due "in six days" surfaces with that
    // morning's digest rather than at whatever minute the review happened to be answered.
    nextFireAt: atLocalMinutesOnDayOf(
      dueAt(next, now),
      trigger.condition.timezone,
      trigger.condition.atMinuteOfDay,
    ),
    lastFiredAt: now,
    updatedAt: now,
  });
}

// ---------------------------------------------------------------- reading

/** The review queue, most overdue first, with each note's text. */
export async function reviewQueue(limit = 20, now: EpochMs = Date.now()): Promise<ReviewItem[]> {
  const active = await db.triggers.where('active').equals(1).toArray();
  const due = dueTriggers(active, now).slice(0, limit);

  const items = await Promise.all(
    due.map(async (trigger) => {
      const entry = await db.entries.get(trigger.targetId);
      if (!entry) return null;
      return {
        trigger,
        entry,
        state: stateOf(trigger),
        overdueDays: Math.floor((now - (trigger.nextFireAt as number)) / DAY_MS),
      };
    }),
  );
  return items.filter((item): item is ReviewItem => item !== null);
}

/** How many notes are due, for the digest's text and the Today badge. */
export async function dueCount(now: EpochMs = Date.now()): Promise<number> {
  const active = await db.triggers.where('active').equals(1).toArray();
  return dueTriggers(active, now).length;
}

/** Every enrolled note, due or not, for the review screen's "in rotation" list. */
export async function enrolledCount(): Promise<number> {
  const active = await db.triggers.where('active').equals(1).toArray();
  return active.filter((trigger) => trigger.condition.kind === 'spaced').length;
}

// ---------------------------------------------------------------- the digest

async function digestTrigger(): Promise<Trigger | undefined> {
  const triggers = await db.triggers
    .where('[targetType+targetId]')
    .equals(['digest', DIGEST_TARGET_ID])
    .toArray();
  return triggers.find((trigger) => trigger.active === 1);
}

export async function clearDigest(): Promise<void> {
  const existing = await digestTrigger();
  if (existing) await cancelTrigger(existing.id);
}

/**
 * Arms the next daily digest, if it is enabled and there is anything to review.
 *
 * Called on app open and again by the service worker after the digest fires — that second caller is
 * what keeps it recurring. A `time` trigger fires once, and with no background execution on this
 * platform the only two moments anything can re-arm it are an app launch and the push handler
 * itself. Relying on app launches alone would silently stop the digest for exactly the user who needs
 * it: the one who has stopped opening the app.
 *
 * Returns `null` when there was nothing to arm, which is the ordinary case for a user who has never
 * enrolled a note.
 */
export async function ensureDigestArmed(now: EpochMs = Date.now()): Promise<RegisterOutcome | null> {
  const settings = await loadSettings();
  if (!settings.digest.enabled) {
    await clearDigest();
    return null;
  }

  // Nothing enrolled means nothing to say. An empty digest is the purest form of a notification that
  // teaches people to ignore notifications.
  if ((await enrolledCount()) === 0) {
    await clearDigest();
    return null;
  }

  const at = nextDigestAt(settings.digest.atMinuteOfDay, settings.timezone, now);

  const existing = await digestTrigger();
  if (existing?.nextFireAt === at) return null;
  if (existing) await cancelTrigger(existing.id);

  return registerTrigger({
    targetType: 'digest',
    targetId: DIGEST_TARGET_ID,
    condition: { kind: 'time', at, timezone: settings.timezone },
  });
}
