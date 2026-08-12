/**
 * The app shell.
 *
 * Today only, for now. Capture, the calendar, search and settings land in the steps that
 * follow; this is the screen the brief asks to be prominent on launch, and it is the one that
 * carries every case push cannot reach — a suppressed reminder, one that fired while the
 * device was offline, and everything belonging to a user who never granted permission.
 */

import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { loadSettings } from './db/settings';
import { reconcile } from './engine/index';
import { todayItems, type TodayItem } from './engine/today';
import { createTranslator } from './i18n/resources';
import type { Lang } from './db/schema';

function formatTime(at: number, timezone: string, locale: Lang): string {
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
  }).format(new Date(at));
}

function itemLabel(item: TodayItem, fallback: string): string {
  switch (item.target.type) {
    case 'event':
      return item.target.event.isPrivate ? fallback : item.target.event.title;
    case 'entry':
      return item.target.entry.body;
    case 'unknown':
      return fallback;
  }
}

export function App() {
  const [locale, setLocale] = useState<Lang>('en');
  const [timezone, setTimezone] = useState('UTC');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const settings = await loadSettings();
      if (cancelled) return;
      setLocale(settings.locale);
      setTimezone(settings.timezone);

      // The backend copy drifts for mundane reasons — a request lost to a dead connection, a
      // push sent while offline — so every launch brings it back into line.
      void reconcile();
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === 'he' ? 'rtl' : 'ltr';
  }, [locale]);

  // Re-runs whenever the underlying tables change, so a reminder that fires while the app is
  // open updates without a manual refresh.
  const items = useLiveQuery(() => todayItems(timezone), [timezone], undefined);
  const t = createTranslator(locale);

  return (
    <main>
      <h1>ReMind</h1>
      {items === undefined ? (
        <p className="muted">…</p>
      ) : items.length === 0 ? (
        <p className="empty">{t('today.empty')}</p>
      ) : (
        <ul className="today-list">
          {items.map((item) => (
            <li key={item.trigger.id} className="today-item" data-overdue={item.overdue}>
              <div className="today-item__time">
                {formatTime(item.trigger.nextFireAt ?? 0, timezone, locale)}
                {item.overdue ? ` · ${t('today.overdue')}` : ''}
              </div>
              <div className="today-item__title">{itemLabel(item, t('notify.entry.title'))}</div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
