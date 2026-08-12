/**
 * Month grid, day detail, and the event editor.
 *
 * The grid geometry and every timezone conversion live in `src/calendar/`, tested; this file is
 * layout and form state. That split is deliberate — the bugs in a calendar are nearly all in the
 * arithmetic, and arithmetic is much cheaper to test without a DOM.
 */

import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import type { Event, Lang } from '../db/schema';
import {
  createCalendarEvent,
  deleteCalendarEvent,
  eventsBetween,
  groupByLocalDay,
  updateCalendarEvent,
} from '../calendar/events';
import { fromDateTimeInput, toDateInput, toDateTimeInput } from '../calendar/inputs';
import {
  monthGrid,
  nextMonth,
  previousMonth,
  weekdayLabels,
  type CalendarDay,
} from '../calendar/monthGrid';
import { registerTrigger } from '../engine/index';
import { HOUR_MS, localDayKey, MINUTE_MS } from '../engine/time';

export interface CalendarProps {
  locale: Lang;
  timezone: string;
}

/** Offsets offered for an event reminder, in minutes before the start. */
const REMINDER_OFFSETS = [0, 10, 30, 60] as const;

interface EditorState {
  event: Event | null;
  title: string;
  start: string;
  end: string;
  isAllDay: boolean;
  isPrivate: boolean;
  travelBufferMinutes: string;
  reminderMinutesBefore: number | null;
}

function blankEditor(day: CalendarDay, timezone: string): EditorState {
  // A new event defaults to the next round hour on the chosen day, which is nearly always closer
  // to what is wanted than midnight.
  const start = day.startAt + 9 * HOUR_MS;
  return {
    event: null,
    title: '',
    start: toDateTimeInput(start, timezone),
    end: toDateTimeInput(start + HOUR_MS, timezone),
    isAllDay: false,
    isPrivate: false,
    travelBufferMinutes: '0',
    reminderMinutesBefore: null,
  };
}

function editorFor(event: Event, timezone: string): EditorState {
  return {
    event,
    title: event.title,
    start: toDateTimeInput(event.startAt, timezone),
    end: toDateTimeInput(event.endAt, timezone),
    isAllDay: event.isAllDay,
    isPrivate: event.isPrivate,
    travelBufferMinutes: String(event.travelBufferMinutes),
    reminderMinutesBefore: null,
  };
}

export function Calendar({ locale, timezone }: CalendarProps) {
  const { t } = useTranslation();
  const now = Date.now();
  const [{ year, month }, setMonth] = useState(() => {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date(now));
    const [y, m] = parts.split('-').map(Number);
    return { year: y!, month: m! };
  });
  const [selectedKey, setSelectedKey] = useState(() => localDayKey(now, timezone));
  const [editor, setEditor] = useState<EditorState | null>(null);

  const grid = useMemo(() => monthGrid(year, month, timezone, now), [year, month, timezone, now]);
  const windowStart = grid[0]!.startAt;
  const windowEnd = grid[grid.length - 1]!.endAt;

  const events = useLiveQuery(
    () => eventsBetween(windowStart, windowEnd),
    [windowStart, windowEnd],
    undefined,
  );
  const byDay = useMemo(
    () => groupByLocalDay(events ?? [], timezone),
    [events, timezone],
  );

  const selected = grid.find((day) => day.key === selectedKey) ?? grid.find((day) => day.isToday);
  const dayEvents = selected ? (byDay.get(selected.key) ?? []) : [];

  const monthLabel = new Intl.DateTimeFormat(locale, {
    month: 'long',
    year: 'numeric',
    timeZone: timezone,
  }).format(new Date(grid.find((day) => day.inMonth)!.startAt));

  const formatTime = (at: number) =>
    new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: timezone,
    }).format(new Date(at));

  /** "0 minutes before" is not how anyone says it, and "60 minutes" is not either. */
  const reminderLabel = (minutes: number) => {
    if (minutes === 0) return t('calendar.atStart');
    if (minutes === 60) return t('calendar.hourBefore');
    return t('calendar.minutesBefore', { count: minutes });
  };

  async function save() {
    if (!editor) return;
    const start = fromDateTimeInput(editor.start, timezone);
    if (start === null || !editor.title.trim()) return;
    const end = fromDateTimeInput(editor.end, timezone) ?? start + HOUR_MS;

    const input = {
      title: editor.title.trim(),
      startAt: start,
      // An end before the start is a typo, not an intention.
      endAt: Math.max(end, start + MINUTE_MS),
      timezone,
      isAllDay: editor.isAllDay,
      isPrivate: editor.isPrivate,
      travelBufferMinutes: Number(editor.travelBufferMinutes) || 0,
    };

    const event = editor.event
      ? (await updateCalendarEvent(editor.event.id, input), editor.event)
      : await createCalendarEvent(input);

    if (editor.reminderMinutesBefore !== null) {
      await registerTrigger({
        targetType: 'event',
        targetId: event.id,
        condition: {
          kind: 'event-adjacent',
          eventId: event.id,
          offsetMinutes: -editor.reminderMinutesBefore,
          includeTravelBuffer: input.travelBufferMinutes > 0,
        },
        link: { fromType: 'event', fromId: event.id, relation: 'about' },
      });
    }

    setEditor(null);
  }

  return (
    <section>
      <div className="month-header">
        <button
          type="button"
          className="button button--quiet"
          aria-label={t('calendar.prevMonth')}
          onClick={() => setMonth(previousMonth(year, month))}
        >
          {/* Chevrons are mirrored by dir, so a single glyph works in both directions. */}
          ‹
        </button>
        <strong>{monthLabel}</strong>
        <button
          type="button"
          className="button button--quiet"
          aria-label={t('calendar.nextMonth')}
          onClick={() => setMonth(nextMonth(year, month))}
        >
          ›
        </button>
      </div>

      <div className="month-grid" role="grid">
        {weekdayLabels(locale).map((label) => (
          <div key={label} className="month-grid__weekday">
            {label}
          </div>
        ))}
        {grid.map((day) => {
          const count = byDay.get(day.key)?.length ?? 0;
          return (
            <button
              key={day.key}
              type="button"
              className="month-grid__day"
              data-in-month={day.inMonth}
              data-today={day.isToday}
              data-selected={day.key === selected?.key}
              onClick={() => setSelectedKey(day.key)}
            >
              <span>{day.dayOfMonth}</span>
              {count > 0 && <span className="month-grid__dot" aria-hidden="true" />}
            </button>
          );
        })}
      </div>

      {selected && (
        <div className="day-detail">
          <div className="month-header">
            <strong>
              {new Intl.DateTimeFormat(locale, {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
                timeZone: timezone,
              }).format(new Date(selected.startAt))}
            </strong>
            <button
              type="button"
              className="button"
              onClick={() => setEditor(blankEditor(selected, timezone))}
            >
              {t('calendar.add')}
            </button>
          </div>

          {dayEvents.length === 0 ? (
            <p className="empty">{t('calendar.noEvents')}</p>
          ) : (
            <ul className="item-list">
              {dayEvents.map((event) => (
                <li key={event.id} className="item card">
                  <div className="item__time">
                    {event.isAllDay ? t('calendar.allDay') : formatTime(event.startAt)}
                  </div>
                  <div className="item__title">{event.title}</div>
                  <div className="capture__actions">
                    <button
                      type="button"
                      className="button button--quiet"
                      onClick={() => setEditor(editorFor(event, timezone))}
                    >
                      {t('calendar.edit')}
                    </button>
                    <button
                      type="button"
                      className="button button--quiet"
                      onClick={() => void deleteCalendarEvent(event.id)}
                    >
                      {t('calendar.delete')}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {editor && (
        <div className="followup followup--sheet">
          <label className="field">
            <span className="field__label">{t('calendar.titleLabel')}</span>
            <input
              className="field__input"
              value={editor.title}
              placeholder={t('calendar.titlePlaceholder')}
              onChange={(e) => setEditor({ ...editor, title: e.target.value })}
            />
          </label>

          <label className="field">
            <span className="field__label">{t('calendar.startLabel')}</span>
            <input
              className="field__input"
              type={editor.isAllDay ? 'date' : 'datetime-local'}
              value={editor.isAllDay ? editor.start.slice(0, 10) : editor.start}
              onChange={(e) => setEditor({ ...editor, start: e.target.value })}
            />
          </label>

          {!editor.isAllDay && (
            <label className="field">
              <span className="field__label">{t('calendar.endLabel')}</span>
              <input
                className="field__input"
                type="datetime-local"
                value={editor.end}
                onChange={(e) => setEditor({ ...editor, end: e.target.value })}
              />
            </label>
          )}

          <label className="checkbox">
            <input
              type="checkbox"
              checked={editor.isAllDay}
              onChange={(e) => {
                const isAllDay = e.target.checked;
                const start = fromDateTimeInput(editor.start, timezone);
                setEditor({
                  ...editor,
                  isAllDay,
                  start:
                    isAllDay && start !== null
                      ? `${toDateInput(start, timezone)}T00:00`
                      : editor.start,
                });
              }}
            />
            <span>{t('calendar.allDay')}</span>
          </label>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={editor.isPrivate}
              onChange={(e) => setEditor({ ...editor, isPrivate: e.target.checked })}
            />
            <span>{t('calendar.private')}</span>
          </label>

          <label className="field">
            <span className="field__label">{t('calendar.travelBuffer')}</span>
            <input
              className="field__input"
              type="number"
              min="0"
              inputMode="numeric"
              value={editor.travelBufferMinutes}
              onChange={(e) => setEditor({ ...editor, travelBufferMinutes: e.target.value })}
            />
          </label>

          <div className="field">
            <span className="field__label">{t('calendar.remindMe')}</span>
            <div className="capture__actions capture__actions--wrap">
              <button
                type="button"
                className="button button--quiet"
                data-active={editor.reminderMinutesBefore === null}
                onClick={() => setEditor({ ...editor, reminderMinutesBefore: null })}
              >
                {t('calendar.reminderNone')}
              </button>
              {REMINDER_OFFSETS.map((minutes) => (
                <button
                  key={minutes}
                  type="button"
                  className="button button--quiet"
                  data-active={editor.reminderMinutesBefore === minutes}
                  onClick={() => setEditor({ ...editor, reminderMinutesBefore: minutes })}
                >
                  {reminderLabel(minutes)}
                </button>
              ))}
            </div>
          </div>

          <div className="capture__actions">
            <button
              type="button"
              className="button"
              disabled={!editor.title.trim()}
              onClick={() => void save()}
            >
              {t('calendar.save')}
            </button>
            <button
              type="button"
              className="button button--quiet"
              onClick={() => setEditor(null)}
            >
              {t('calendar.cancel')}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
