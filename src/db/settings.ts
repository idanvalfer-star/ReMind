/**
 * Settings defaults and access.
 *
 * `Settings` is a single row. It is read on almost every scheduling decision, so it is
 * loaded through here rather than queried ad hoc, and it is created on first read so no
 * caller has to care whether onboarding has run yet.
 */

import { db, type IanaTz, type Lang, type QuietHours, type Settings } from './schema';

/**
 * Silent by default, and enabled by default. An app that resurfaces at 03:00 gets its
 * notifications switched off, and is then worth nothing — so the safe default is the
 * quiet one, and the user opts *out*.
 */
export const DEFAULT_QUIET_HOURS: QuietHours = { enabled: true, start: '22:00', end: '07:00' };

/**
 * Reminders scheduled per local day. Six is a guess, deliberately on the low side for
 * the same reason quiet hours default on.
 */
export const DEFAULT_DAILY_CAP = 6;

/** At or above this, a parsed Event is created silently with undo; below, it asks. */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.8;

/** iOS can evict IndexedDB without warning, so a backup nag is not optional. */
export const DEFAULT_BACKUP_REMINDER_DAYS = 14;

const SINGLETON = 'singleton' as const;

/** Falls back to English for anything that is not Hebrew. */
export function detectLocale(): Lang {
  if (typeof navigator === 'undefined') return 'en';
  const tags = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const tag of tags) {
    if (tag?.toLowerCase().startsWith('he') || tag?.toLowerCase().startsWith('iw')) return 'he';
  }
  return 'en';
}

/** The host's zone, or UTC where the platform will not say. */
export function detectTimezone(): IanaTz {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function defaultSettings(): Settings {
  return {
    id: SINGLETON,
    locale: detectLocale(),
    timezone: detectTimezone(),
    quietHours: { ...DEFAULT_QUIET_HOURS },
    dailyCap: DEFAULT_DAILY_CAP,
    confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD,
    allowNetworkInterpretation: false,
    lastExportAt: null,
    backupReminderDays: DEFAULT_BACKUP_REMINDER_DAYS,
    onboarding: {
      dismissedInstallSheet: false,
      completedPushPrompt: false,
    },
  };
}

/**
 * Reads settings, creating the row on first call.
 *
 * Note what is *not* stored: whether the app is running standalone, and the current
 * notification permission. Both are live platform state that changes between launches,
 * and persisting a copy would only guarantee it goes stale — they are read from the
 * platform at the point of use instead.
 */
export async function loadSettings(): Promise<Settings> {
  const existing = await db.settings.get(SINGLETON);
  if (existing) return existing;

  const created = defaultSettings();
  // `put`, not `add`: two callers racing on a cold start must not throw.
  await db.settings.put(created);
  return created;
}
