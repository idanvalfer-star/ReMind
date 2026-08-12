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

import type { Entry, Event, Lang, Trigger } from '../db/schema';

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
  | { type: 'event'; event: Event }
  | { type: 'entry'; entry: Entry }
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
      return {
        title: truncate(event.title),
        body: event.isAllDay
          ? t('notify.event.allDayBody')
          : t('notify.event.body', { time: formatTime(event.startAt, event.timezone, locale) }),
        tag,
      };
    }

    case 'entry':
      return {
        title: t('notify.entry.title'),
        body: truncate(target.entry.body),
        tag,
      };

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
  'notify.fallback.title',
  'notify.fallback.body',
] as const;
