/**
 * The Today list.
 *
 * There are no widgets on the web and no background execution, so this is the surface that makes
 * reminders feel present — and the one that catches everything push cannot: a suppressed
 * reminder, one that fired while the device was offline, and everything belonging to a user who
 * never granted notification permission. Overdue items are shown, flagged, rather than hidden.
 */

import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import type { Lang } from '../db/schema';
import { todayItems, type TodayItem } from '../engine/today';

export interface TodayListProps {
  locale: Lang;
  timezone: string;
}

function label(item: TodayItem, fallback: string): string {
  switch (item.target.type) {
    case 'event':
      // A private event keeps its title off any surface that might be glanced at.
      return item.target.event.isPrivate ? fallback : item.target.event.title;
    case 'entry':
      return item.target.entry.body;
    case 'unknown':
      return fallback;
  }
}

export function TodayList({ locale, timezone }: TodayListProps) {
  const { t } = useTranslation();
  // Re-runs whenever the tables change, so a reminder firing while the app is open appears
  // without a refresh.
  const items = useLiveQuery(() => todayItems(timezone), [timezone], undefined);

  const formatTime = (at: number) =>
    new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: timezone,
    }).format(new Date(at));

  return (
    <section>
      <h2 className="section-heading">{t('today.heading')}</h2>
      {items === undefined ? (
        <p className="muted">…</p>
      ) : items.length === 0 ? (
        <p className="empty">{t('today.empty')}</p>
      ) : (
        <ul className="today-list">
          {items.map((item) => (
            <li key={item.trigger.id} className="today-item" data-overdue={item.overdue}>
              <div className="today-item__time">
                {formatTime(item.trigger.nextFireAt ?? 0)}
                {item.overdue ? ` · ${t('today.overdue')}` : ''}
              </div>
              <div className="today-item__title">{label(item, t('notify.entry.title'))}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
