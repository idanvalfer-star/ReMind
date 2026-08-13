/**
 * Composes notification text from local data.
 *
 * This module is the reason the privacy design works at all: the push that wakes the
 * device carries nothing but a UUID, so the words the user reads have to be assembled
 * here, on-device, from IndexedDB.
 *
 * It is imported by both the app and the service worker, so it takes its translator as an
 * argument rather than importing i18next — the service worker has no business pulling in a
 * full i18n runtime, and injecting the lookup keeps this pure and testable.
 */

import type { Entry, Event, Fact, FactKind, Lang, Person, Trigger, Trip } from '../db/schema';
import type { StageId } from '../trips/stages';

/** Minimal translator shape, satisfied by i18next's `t` and by a plain lookup in the SW. */
export type Translate = (key: string, vars?: Record<string, string | number>) => string;

/**
 * What the trigger points at, already fetched.
 *
 * `unknown` is not a theoretical case: iOS evicts IndexedDB, and a push can arrive for a
 * trigger whose data is gone. `userVisibleOnly` forbids swallowing it silently, so
 * something generic has to be shown.
 */
export type NotificationTarget =
  | {
      type: 'event';
      event: Event;
      /**
       * People the event appears to involve, with facts already ranked. Present so a meeting
       * reminder can carry something useful rather than only a time — the whole point of the
       * app is the right fragment at the right moment, and ten minutes before you meet someone
       * is the moment.
       */
      attendees?: readonly { person: Person; facts: readonly Fact[] }[] | undefined;
    }
  | { type: 'entry'; entry: Entry }
  | { type: 'person'; person: Person; facts: readonly Fact[] }
  | {
      type: 'trip';
      trip: Trip;
      /**
       * Which of the four packing stages this is, recomputed from the trip's current dates rather
       * than stored on the trigger — see `stageIdAt`. `null` when the trip moved far enough that the
       * reminder no longer lines up with any stage, which gets neutral text instead of a confident
       * lie about today being departure day.
       */
      stage: StageId | null;
    }
  | { type: 'unknown' };

export interface NotificationContent {
  title: string;
  body: string;
  /**
   * Set to the trigger id so a redelivered push replaces the existing notification
   * instead of stacking a second copy of the same reminder.
   */
  tag: string;
}

/**
 * How useful each kind of fact is when there is only room for one.
 *
 * A milestone is the best conversation opener there is — it is news, and it dates. A preference
 * is what makes a meeting go well. A gift idea only matters near an occasion, and the app has no
 * way to know one is near. `relation` and `misc` are context rather than prompts.
 */
const FACT_KIND_WEIGHT: Record<FactKind, number> = {
  milestone: 5,
  preference: 4,
  'gift-idea': 3,
  relation: 2,
  misc: 1,
};

/**
 * Facts ordered by how worth surfacing they are. Stable and pure, so both the one-line
 * notification and the full pre-meeting briefing agree on what matters most.
 *
 * Confidence breaks ties within a kind, and recency breaks ties within that: a preference
 * recorded last week supersedes one from two years ago, which is usually how preferences work.
 */
export function rankFacts(facts: readonly Fact[]): Fact[] {
  return [...facts].sort(
    (a, b) =>
      FACT_KIND_WEIGHT[b.kind] - FACT_KIND_WEIGHT[a.kind] ||
      b.confidence - a.confidence ||
      b.createdAt - a.createdAt,
  );
}

/** Long bodies get truncated by the OS anyway, and mid-word is uglier than an ellipsis. */
const MAX_BODY_LENGTH = 120;

export function truncate(text: string, max = MAX_BODY_LENGTH): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  // Only break on a word boundary if one is reasonably close to the limit.
  const base = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${base.trimEnd()}…`;
}

function formatTime(at: number, timezone: string, locale: Lang): string {
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
  }).format(new Date(at));
}

export interface ComposeInput {
  trigger: Trigger;
  target: NotificationTarget;
  t: Translate;
  locale: Lang;
}

/**
 * Builds the notification the user actually sees.
 *
 * A private Event contributes no text at all — the whole point of the flag is that its
 * title should not appear on a lock screen, so it is replaced rather than truncated.
 */
export function composeNotification({
  trigger,
  target,
  t,
  locale,
}: ComposeInput): NotificationContent {
  const tag = trigger.id;

  switch (target.type) {
    case 'event': {
      const { event } = target;
      if (event.isPrivate) {
        return {
          title: t('notify.event.privateTitle'),
          body: t('notify.event.privateBody'),
          tag,
        };
      }
      // Separate keys rather than substituting "all day" into the timed phrasing, which
      // would read "Starts at all day".
      const when = event.isAllDay
        ? t('notify.event.allDayBody')
        : t('notify.event.body', { time: formatTime(event.startAt, event.timezone, locale) });

      // One fact, from the first attendee who has any. Two would turn a glanceable reminder
      // into a briefing document, and the notification body is a single line on a lock screen.
      const detail = target.attendees?.flatMap((a) => a.facts)[0];

      return {
        title: truncate(event.title),
        body: detail
          ? truncate(t('notify.withDetail', { main: when, detail: detail.body }))
          : when,
        tag,
      };
    }

    case 'entry':
      return {
        title: t('notify.entry.title'),
        body: truncate(target.entry.body),
        tag,
      };

    case 'person': {
      // The name goes in the title so the notification is identifiable at a glance, and the
      // body carries something to actually say — a nudge that only says "check in with Sarah"
      // is a chore, one that reminds you she just moved is a reason.
      const best = rankFacts(target.facts)[0];
      return {
        title: t('notify.person.title', { name: truncate(target.person.name, 40) }),
        body: best ? truncate(best.body) : t('notify.person.body'),
        tag,
      };
    }

    case 'trip': {
      const { trip, stage } = target;
      // Neutral text for an unmatched stage: better a reminder that just names the trip than one
      // confidently announcing a departure that has moved.
      const key = stage ?? 'generic';
      return {
        title: truncate(t(`notify.trip.${key}.title`, { destination: trip.destination })),
        body: t(`notify.trip.${key}.body`),
        tag,
      };
    }

    case 'unknown':
      // Data cleared, or a push for a trigger this device no longer knows about.
      return {
        title: t('notify.fallback.title'),
        body: t('notify.fallback.body'),
        tag,
      };
  }
}

/**
 * Translation keys this module requires. Exported so the i18n resources can be checked
 * against it by a test rather than by hoping nobody forgets one.
 */
export const NOTIFICATION_KEYS = [
  'notify.event.privateTitle',
  'notify.event.privateBody',
  'notify.event.allDayBody',
  'notify.event.body',
  'notify.entry.title',
  'notify.person.title',
  'notify.person.body',
  'notify.withDetail',
  'notify.trip.shop.title',
  'notify.trip.shop.body',
  'notify.trip.night-before.title',
  'notify.trip.night-before.body',
  'notify.trip.departure-day.title',
  'notify.trip.departure-day.body',
  'notify.trip.return-eve.title',
  'notify.trip.return-eve.body',
  'notify.trip.generic.title',
  'notify.trip.generic.body',
  'notify.fallback.title',
  'notify.fallback.body',
] as const;
