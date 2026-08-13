/**
 * The Today screen.
 *
 * Four cards over data that already exists: what is scheduled, what was captured and *isn't*
 * scheduled, the week, and the month. Nothing here writes — it is entirely a set of views, which
 * is why none of it needed new storage.
 *
 * The pairing of the first two cards is the point. "Scheduled Reminders" is what the app will
 * surface on its own; "Quick Tasks" is what it won't, because nothing has been scheduled against
 * it. Those are the notes most likely to be genuinely forgotten, so they sit next to each other.
 */

import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import type { Lang } from '../db/schema';
import { groupByLocalDay, eventsBetween } from '../calendar/events';
import { monthGrid, weekDays, weekdayLabels } from '../calendar/monthGrid';
import { todayItems, unscheduledEntries, type TodayItem } from '../engine/today';
import { startOfNextLocalDay } from '../engine/time';
import { briefingsBetween } from '../people/briefing';

export interface TodayProps {
  locale: Lang;
  timezone: string;
}

function label(item: TodayItem, fallback: string, personLabel: (name: string) => string): string {
  switch (item.target.type) {
    case 'event':
      // A private event keeps its title off any surface that might be glanced at.
      return item.target.event.isPrivate ? fallback : item.target.event.title;
    case 'entry':
      return item.target.entry.body;
    case 'person':
      return personLabel(item.target.person.name);
    case 'unknown':
      return fallback;
  }
}

export function Today({ locale, timezone }: TodayProps) {
  const { t } = useTranslation();
  const now = Date.now();

  // Re-run whenever the tables change, so a reminder firing while the app is open appears without
  // a refresh.
  const items = useLiveQuery(() => todayItems(timezone), [timezone], undefined);
  const quick = useLiveQuery(() => unscheduledEntries(4), [], undefined);
  // Only what is still ahead: a briefing for a meeting that already happened is not a briefing.
  const briefings = useLiveQuery(
    () => briefingsBetween(now, startOfNextLocalDay(now, timezone)),
    [timezone],
    undefined,
  );

  const week = weekDays(timezone, now);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date(now));
  const [year, month] = parts.split('-').map(Number);
  const grid = monthGrid(year!, month!, timezone, now);

  const monthEvents = useLiveQuery(
    () => eventsBetween(grid[0]!.startAt, grid[grid.length - 1]!.endAt),
    [grid[0]!.startAt],
    undefined,
  );
  const byDay = groupByLocalDay(monthEvents ?? [], timezone);

  const formatTime = (at: number) =>
    new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: timezone,
    }).format(new Date(at));

  return (
    <>
      <h2 className="section-heading">{t('today.heading')}</h2>

      <div className="card-row">
        <div className="card">
          <span className="card__label">{t('today.quickTasks')}</span>
          {quick === undefined ? (
            <p className="empty">…</p>
          ) : quick.length === 0 ? (
            <p className="empty">{t('today.noQuickTasks')}</p>
          ) : (
            <ul className="item-list">
              {quick.map((entry) => (
                <li key={entry.id} className="item">
                  <span className="item__dot" aria-hidden="true" />
                  <span className="item__title">{entry.body}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card">
          <span className="card__label">{t('today.scheduled')}</span>
          {items === undefined ? (
            <p className="empty">…</p>
          ) : items.length === 0 ? (
            <p className="empty">{t('today.empty')}</p>
          ) : (
            <ul className="item-list">
              {items.map((item) => (
                <li key={item.trigger.id} className="item">
                  <span className="item__dot" data-overdue={item.overdue} aria-hidden="true" />
                  <span className="item__title">
                    {label(item, t('notify.entry.title'), (name) =>
                      t('notify.person.title', { name }),
                    )}
                  </span>
                  <span className="item__time item__body">
                    {formatTime(item.trigger.nextFireAt ?? 0)}
                    {item.overdue ? ` · ${t('today.overdue')}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Only rendered when there is something to say — `briefingsBetween` returns nothing for a
          matched person with no recorded facts, so this card cannot appear empty. */}
      {briefings !== undefined && briefings.length > 0 && (
        <div className="card" style={{ marginBlockStart: 'var(--gap)' }}>
          <span className="card__label">{t('people.briefing')}</span>
          {briefings.map((briefing) => (
            <div key={briefing.event.id} style={{ marginBlockStart: '0.5rem' }}>
              <div className="item__time">
                {formatTime(briefing.event.startAt)} · {briefing.event.title}
              </div>
              <ul className="item-list">
                {briefing.people.map(({ person, facts }) =>
                  facts.slice(0, 2).map((fact) => (
                    <li key={fact.id} className="item item--fact">
                      <span className="fact-kind">{person.name}</span>
                      <span className="item__title">{fact.body}</span>
                    </li>
                  )),
                )}
              </ul>
            </div>
          ))}
        </div>
      )}

      <div className="card" style={{ marginBlockStart: 'var(--gap)' }}>
        <span className="card__label">{t('today.week')}</span>
        <div className="week-strip">
          {week.map((day) => (
            <div key={day.key} className="week-day" data-today={day.isToday}>
              <span>
                {new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: timezone }).format(
                  new Date(day.startAt),
                )}
              </span>
              <span className="week-day__number">{day.dayOfMonth}</span>
              {(byDay.get(day.key)?.length ?? 0) > 0 && (
                <span className="week-day__dot" aria-hidden="true" />
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="card" style={{ marginBlockStart: 'var(--gap)' }}>
        <span className="card__label">{t('today.calendarOverview')}</span>
        <div className="month-grid month-grid--compact">
          {weekdayLabels(locale).map((name) => (
            <div key={name} className="month-grid__weekday">
              {name}
            </div>
          ))}
          {grid.map((day) => (
            <div
              key={day.key}
              className="month-grid__day"
              data-in-month={day.inMonth}
              data-today={day.isToday}
            >
              <span>{day.dayOfMonth}</span>
              {(byDay.get(day.key)?.length ?? 0) > 0 && (
                <span className="month-grid__dot" aria-hidden="true" />
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
