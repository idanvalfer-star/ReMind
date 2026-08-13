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

import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import type { Lang } from '../db/schema';
import { groupByLocalDay, eventsBetween } from '../calendar/events';
import { monthGrid, weekDays, weekdayLabels } from '../calendar/monthGrid';
import type { NotificationTarget } from '../engine/notify';
import { pinTriggerToPlace } from '../engine/index';
import { todayItems, unscheduledEntries } from '../engine/today';
import { DEFAULT_PIN_RADIUS_M, type Fix } from '../location/geo';
import { hasAnyPin, nearbyPins } from '../location/nearby';
import { geolocationAlreadyGranted, readPosition } from '../location/position';
import { startOfNextLocalDay } from '../engine/time';
import { briefingsBetween } from '../people/briefing';
import { Review } from './Review';

export interface TodayProps {
  locale: Lang;
  timezone: string;
}

function label(
  target: NotificationTarget,
  fallback: string,
  personLabel: (name: string) => string,
): string {
  switch (target.type) {
    case 'event':
      // A private event keeps its title off any surface that might be glanced at.
      return target.event.isPrivate ? fallback : target.event.title;
    case 'entry':
      return target.entry.body;
    case 'person':
      return personLabel(target.person.name);
    case 'trip':
      return target.trip.destination;
    case 'digest':
      return target.first?.body ?? fallback;
    case 'unknown':
      return fallback;
  }
}

export function Today({ locale, timezone }: TodayProps) {
  const { t } = useTranslation();
  const now = Date.now();
  const [fix, setFix] = useState<Fix | null>(null);
  const [positionProblem, setPositionProblem] = useState<'denied' | 'unavailable' | null>(null);

  /**
   * The "check on open" half of location resurfacing.
   *
   * Runs only when something is actually pinned *and* permission is already granted, so it can
   * never be the thing that raises a prompt. Both conditions failing is the ordinary case, and the
   * cost of the feature for a user who never pins anything is one indexed read.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!(await hasAnyPin())) return;
      if (!(await geolocationAlreadyGranted())) return;
      const outcome = await readPosition();
      if (cancelled) return;
      if (outcome.kind === 'fix') setFix(outcome.fix);
      else setPositionProblem(outcome.kind);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Pins an entry to wherever the device is standing. Prompts for permission if it must. */
  async function pinHere(entryId: string) {
    const outcome = await readPosition();
    if (outcome.kind !== 'fix') {
      setPositionProblem(outcome.kind);
      return;
    }
    setPositionProblem(null);
    setFix(outcome.fix);
    await pinTriggerToPlace({
      targetType: 'entry',
      targetId: entryId,
      location: {
        lat: outcome.fix.lat,
        lng: outcome.fix.lng,
        radiusM: DEFAULT_PIN_RADIUS_M,
      },
      link: { fromType: 'entry', fromId: entryId, relation: 'reminds-of' },
    });
  }

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

  // Keyed on the fix so walking somewhere else re-evaluates, and on the trigger table so a pin made
  // in this session appears without a reload.
  const nearby = useLiveQuery(
    () => (fix ? nearbyPins(fix) : Promise.resolve([])),
    [fix?.lat, fix?.lng, fix?.accuracyM],
    [],
  );

  const formatDistance = (meters: number) => {
    if (meters < 30) return t('nearby.here');
    return t('nearby.away', {
      distance: new Intl.NumberFormat(locale, {
        style: 'unit',
        unit: meters >= 1000 ? 'kilometer' : 'meter',
        maximumFractionDigits: meters >= 1000 ? 1 : 0,
      }).format(meters >= 1000 ? meters / 1000 : meters),
    });
  };

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
                <li key={entry.id} className="item item--with-action">
                  <span className="item__dot" aria-hidden="true" />
                  <span className="item__title">{entry.body}</span>
                  {/* This tap is the only thing in the app that may raise the location prompt.
                      Asking on launch, for a feature never used, spends it for nothing. */}
                  <button
                    type="button"
                    className="button button--quiet button--small"
                    onClick={() => void pinHere(entry.id)}
                  >
                    {t('nearby.pin')}
                  </button>
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
                    {label(item.target, t('notify.entry.title'), (name) =>
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

      <Review locale={locale} />

      {/* There is no geofencing on the web, so this card *is* the feature: pinned notes surface
          when the app is opened somewhere near them, and never otherwise. */}
      {nearby.length > 0 && (
        <div className="card" style={{ marginBlockStart: 'var(--gap)' }}>
          <span className="card__label">{t('nearby.heading')}</span>
          <ul className="item-list">
            {nearby.map((pin) => (
              <li key={pin.trigger.id} className="item">
                <span className="item__dot" aria-hidden="true" />
                <span className="item__title">
                  {label(pin.target, t('notify.entry.title'), (name) =>
                    t('notify.person.title', { name }),
                  )}
                </span>
                <span className="item__time item__body">{formatDistance(pin.distanceM)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {positionProblem && (
        <p className="card empty" style={{ marginBlockStart: 'var(--gap)' }}>
          {t(`nearby.${positionProblem}`)}
        </p>
      )}

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
