/**
 * Trips: a list, a detail view with two packing lists, and an editor.
 *
 * The detail view leads with progress rather than with the trip's details, because the question the
 * screen exists to answer is "am I packed", not "where am I going" — you know where you are going.
 *
 * Every generated line shows where it came from. A list that says "umbrella · weather" is one you can
 * argue with; one that just says "umbrella" is one you stop trusting the first time it is wrong.
 */

import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import {
  PACK_CATEGORIES,
  TRANSIT_MODES,
  type ID,
  type Lang,
  type PackCategory,
  type PackItem,
  type TransitMode,
} from '../db/schema';
import { fromDateTimeInput, toDateTimeInput } from '../calendar/inputs';
import { DAY_MS, HOUR_MS } from '../engine/time';
import type { Translate } from '../engine/notify';
import { groupByCategory, nightsBetween } from '../trips/packing';
import { fetchForecast, forecastRange, WeatherError } from '../trips/weather';
import {
  addPackItem,
  applyForecast,
  armTripReminders,
  clearStageTriggers,
  createTrip,
  deletePackItem,
  deleteTrip,
  packItemsFor,
  armedStages,
  togglePacked,
  tripSummaries,
  updateTrip,
  type TripSummary,
} from '../trips/trips';

export interface TripsProps {
  locale: Lang;
  timezone: string;
}

interface EditorState {
  id: ID | null;
  destination: string;
  purpose: string;
  start: string;
  end: string;
  transitMode: TransitMode;
  luggageConstraint: string;
}

function blankEditor(timezone: string): EditorState {
  // Defaults to a week away for four nights, which is a more useful starting point than today.
  const start = Date.now() + 7 * DAY_MS;
  return {
    id: null,
    destination: '',
    purpose: '',
    start: toDateTimeInput(start, timezone),
    end: toDateTimeInput(start + 4 * DAY_MS, timezone),
    transitMode: 'air',
    luggageConstraint: '',
  };
}

export function Trips({ locale, timezone }: TripsProps) {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState<ID | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);

  const summaries = useLiveQuery(() => tripSummaries(), [], undefined);
  const selected = summaries?.find((summary) => summary.trip.id === selectedId);

  const formatDate = (at: number) =>
    new Intl.DateTimeFormat(locale, {
      day: 'numeric',
      month: 'short',
      timeZone: timezone,
    }).format(new Date(at));

  if (editor) {
    return <TripForm editor={editor} timezone={timezone} onChange={setEditor} onDone={() => setEditor(null)} />;
  }

  if (selected) {
    return (
      <TripDetail
        summary={selected}
        locale={locale}
        timezone={timezone}
        onBack={() => setSelectedId(null)}
        onEdit={() =>
          setEditor({
            id: selected.trip.id,
            destination: selected.trip.destination,
            purpose: selected.trip.purpose,
            start: toDateTimeInput(selected.trip.startAt, timezone),
            end: toDateTimeInput(selected.trip.endAt, timezone),
            transitMode: selected.trip.transitMode,
            luggageConstraint: selected.trip.luggageConstraint ?? '',
          })
        }
      />
    );
  }

  return (
    <section>
      <div className="month-header">
        <h2 className="section-heading">{t('trips.heading')}</h2>
        <button type="button" className="button" onClick={() => setEditor(blankEditor(timezone))}>
          {t('trips.add')}
        </button>
      </div>

      {summaries === undefined ? (
        <p className="empty">…</p>
      ) : summaries.length === 0 ? (
        <p className="card empty">{t('trips.empty')}</p>
      ) : (
        <ul className="item-list">
          {summaries.map((summary) => (
            <li key={summary.trip.id} className="item card">
              <button
                type="button"
                className="person-row"
                onClick={() => setSelectedId(summary.trip.id)}
              >
                <span className="item__title">{summary.trip.destination}</span>
                <span className="item__body">
                  {formatDate(summary.trip.startAt)} – {formatDate(summary.trip.endAt)}
                  {summary.trip.endAt < Date.now() && ` · ${t('trips.past')}`}
                </span>
                <span className="item__time">
                  {summary.total > 0 && summary.packed === summary.total
                    ? t('trips.allPacked')
                    : t('trips.progress', { packed: summary.packed, total: summary.total })}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface TripDetailProps {
  summary: TripSummary;
  locale: Lang;
  timezone: string;
  onBack: () => void;
  onEdit: () => void;
}

function TripDetail({ summary, locale, timezone, onBack, onEdit }: TripDetailProps) {
  const { t } = useTranslation();
  // i18next's `t` carries overloads that do not structurally satisfy `Translate`, so the generator
  // gets an explicit adapter rather than the function itself.
  const translate: Translate = (key, vars) => t(key, vars ?? {});
  const { trip } = summary;
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [weatherState, setWeatherState] = useState<'idle' | 'loading' | 'not-found' | 'failed'>('idle');
  const [remindersSuppressed, setRemindersSuppressed] = useState(false);

  const items = useLiveQuery(() => packItemsFor(trip.id), [trip.id], undefined);
  const stages = useLiveQuery(() => armedStages(trip.id), [trip.id], []);
  const remindersOn = stages.length > 0;

  const nights = nightsBetween(trip.startAt, trip.endAt);
  const range = forecastRange(trip.forecast?.days ?? []);

  async function loadForecast() {
    setWeatherState('loading');
    try {
      const forecast = await fetchForecast({
        destination: trip.destination,
        startAt: trip.startAt,
        endAt: trip.endAt,
        timezone: trip.timezone,
      });
      await applyForecast(trip.id, forecast, translate);
      setWeatherState('idle');
    } catch (cause) {
      // The two failures need different words: "that place does not exist" is the user's to fix,
      // "the service is down" is not.
      setWeatherState(cause instanceof WeatherError && cause.reason === 'not-found' ? 'not-found' : 'failed');
    }
  }

  async function toggleReminders() {
    if (remindersOn) {
      await clearStageTriggers(trip.id);
      setRemindersSuppressed(false);
      return;
    }
    const results = await armTripReminders(trip.id);
    setRemindersSuppressed(results.some((result) => result.outcome.kind === 'suppressed'));
  }

  return (
    <section>
      <div className="month-header">
        <button type="button" className="button button--quiet button--small" onClick={onBack}>
          ‹ {t('trips.back')}
        </button>
        <button type="button" className="button button--quiet button--small" onClick={onEdit}>
          {t('trips.edit')}
        </button>
      </div>

      <div className="card">
        <h2 className="section-heading">{trip.destination}</h2>
        <p className="item__body">
          {new Intl.DateTimeFormat(locale, {
            day: 'numeric',
            month: 'long',
            timeZone: timezone,
          }).format(new Date(trip.startAt))}
          {' – '}
          {new Intl.DateTimeFormat(locale, {
            day: 'numeric',
            month: 'long',
            timeZone: timezone,
          }).format(new Date(trip.endAt))}
          {' · '}
          {nights === 1 ? t('trips.oneNight') : t('trips.nights', { count: nights })}
          {' · '}
          {t(`trips.mode_${trip.transitMode}`)}
        </p>
        {trip.purpose && <p className="item__body muted">{trip.purpose}</p>}
        {trip.luggageConstraint && <p className="item__body muted">{trip.luggageConstraint}</p>}
      </div>

      {/* The forecast card doubles as the disclosure for the app's only outbound request. */}
      <div className="card" style={{ marginBlockStart: 'var(--gap)' }}>
        <span className="card__label">{t('trips.forecast')}</span>
        {range && trip.forecast ? (
          <p className="item__body">
            {t('trips.forecastFor', {
              place: trip.forecast.resolvedName,
              min: Math.round(range.minC),
              max: Math.round(range.maxC),
            })}
            {range.wettestMm >= 2 && ` · ${t('trips.forecastWet')}`}
          </p>
        ) : (
          <p className="field__help">{t('trips.forecastSends')}</p>
        )}
        {weatherState === 'not-found' && <p className="empty">{t('trips.forecastNone')}</p>}
        {weatherState === 'failed' && <p className="empty">{t('trips.forecastFailed')}</p>}
        <div className="capture__actions">
          <button
            type="button"
            className="button button--quiet"
            disabled={weatherState === 'loading' || !trip.destination}
            onClick={() => void loadForecast()}
          >
            {trip.forecast ? t('trips.forecastRefresh') : t('trips.forecast')}
          </button>
        </div>
      </div>

      <div className="card" style={{ marginBlockStart: 'var(--gap)' }}>
        <span className="card__label">{t('trips.reminders')}</span>
        <p className="item__body">{remindersOn ? t('trips.remindersOn') : t('trips.remindersOff')}</p>
        {stages.length > 0 && (
          <ul className="item-list">
            {/* Exactly the stages that were armed. A trip six days out has no week-before nudge, and
                claiming one it does not have is a lie the user discovers by not being reminded. */}
            {stages.map((stage) => (
              <li key={stage} className="item">
                <span className="item__dot" aria-hidden="true" />
                <span className="item__title">{t(`trips.stage_${stage}`)}</span>
              </li>
            ))}
          </ul>
        )}
        {remindersSuppressed && <p className="empty">{t('trips.remindersSuppressed')}</p>}
        <div className="capture__actions">
          <button type="button" className="button button--quiet" onClick={() => void toggleReminders()}>
            {remindersOn ? t('trips.clearReminders') : t('trips.setReminders')}
          </button>
        </div>
      </div>

      <PackList
        title={t('trips.packing')}
        tripId={trip.id}
        isReturnLeg={0}
        items={items?.filter((item) => item.isReturnLeg === 0)}
        packed={summary.packed}
        total={summary.total}
      />

      {summary.returnTotal > 0 && (
        <PackList
          title={t('trips.returnList')}
          tripId={trip.id}
          isReturnLeg={1}
          items={items?.filter((item) => item.isReturnLeg === 1)}
          packed={summary.returnPacked}
          total={summary.returnTotal}
        />
      )}

      <div className="capture__actions" style={{ marginBlockStart: 'var(--gap)' }}>
        {confirmingDelete ? (
          <>
            <button
              type="button"
              className="button button--danger"
              onClick={() => void deleteTrip(trip.id).then(onBack)}
            >
              {t('trips.deleteConfirm')}
            </button>
            <button
              type="button"
              className="button button--quiet"
              onClick={() => setConfirmingDelete(false)}
            >
              {t('trips.cancel')}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="button button--quiet"
            onClick={() => setConfirmingDelete(true)}
          >
            {t('trips.delete')}
          </button>
        )}
      </div>
    </section>
  );
}

interface PackListProps {
  title: string;
  tripId: ID;
  isReturnLeg: 0 | 1;
  items: PackItem[] | undefined;
  packed: number;
  total: number;
}

function PackList({ title, tripId, isReturnLeg, items, packed, total }: PackListProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');
  const [category, setCategory] = useState<PackCategory>('misc');

  async function add() {
    if (!draft.trim()) return;
    await addPackItem({ tripId, label: draft, category, isReturnLeg });
    setDraft('');
  }

  return (
    <div className="card" style={{ marginBlockStart: 'var(--gap)' }}>
      <div className="month-header">
        <span className="card__label" style={{ marginBlockEnd: 0 }}>
          {title}
        </span>
        <span className="item__time">
          {total > 0 && packed === total ? t('trips.allPacked') : t('trips.progress', { packed, total })}
        </span>
      </div>

      {items === undefined ? (
        <p className="empty">…</p>
      ) : (
        groupByCategory(items).map((group) => (
          <div key={group.category}>
            <span className="section-label">{t(`packing.category.${group.category}`)}</span>
            <ul className="item-list">
              {group.items.map((item) => (
                <li key={item.id} className="item item--with-action">
                  <input
                    type="checkbox"
                    checked={item.packed === 1}
                    aria-label={item.label}
                    onChange={() => void togglePacked(item.id)}
                  />
                  <span className="item__title" data-packed={item.packed === 1}>
                    {item.label}
                    {item.quantity > 1 && ` ×${item.quantity}`}
                    {/* Where the line came from, so a surprising suggestion can be interrogated
                        rather than merely distrusted. */}
                    {item.origin !== 'template' && (
                      <span className="pack-origin"> {t(`packing.origin.${item.origin}`)}</span>
                    )}
                  </span>
                  <button
                    type="button"
                    className="button button--quiet button--small"
                    onClick={() => void deletePackItem(item.id)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}

      <div className="followup followup--sheet" style={{ marginBlockStart: 'var(--gap)' }}>
        <label className="field">
          <span className="field__label">{t('trips.addItem')}</span>
          <input
            className="field__input"
            value={draft}
            placeholder={t('trips.itemPlaceholder')}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <div className="capture__actions capture__actions--wrap">
          {PACK_CATEGORIES.map((option) => (
            <button
              key={option}
              type="button"
              className="button button--quiet button--small"
              data-active={category === option}
              onClick={() => setCategory(option)}
            >
              {t(`packing.category.${option}`)}
            </button>
          ))}
        </div>
        <div className="capture__actions">
          <button type="button" className="button" disabled={!draft.trim()} onClick={() => void add()}>
            {t('trips.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

interface TripFormProps {
  editor: EditorState;
  timezone: string;
  onChange: (next: EditorState) => void;
  onDone: () => void;
}

function TripForm({ editor, timezone, onChange, onDone }: TripFormProps) {
  const { t } = useTranslation();
  const translate: Translate = (key, vars) => t(key, vars ?? {});

  async function save() {
    const start = fromDateTimeInput(editor.start, timezone);
    if (start === null || !editor.destination.trim()) return;
    const end = fromDateTimeInput(editor.end, timezone) ?? start + HOUR_MS;

    const input = {
      destination: editor.destination,
      purpose: editor.purpose,
      startAt: start,
      endAt: end,
      transitMode: editor.transitMode,
      luggageConstraint: editor.luggageConstraint,
    };

    if (editor.id) await updateTrip(editor.id, input, translate);
    else await createTrip(input, translate);
    onDone();
  }

  return (
    <section>
      <div className="followup followup--sheet">
        <label className="field">
          <span className="field__label">{t('trips.destination')}</span>
          <input
            className="field__input"
            value={editor.destination}
            placeholder={t('trips.destinationPlaceholder')}
            onChange={(event) => onChange({ ...editor, destination: event.target.value })}
            autoFocus
          />
        </label>

        <label className="field">
          <span className="field__label">{t('trips.startLabel')}</span>
          <input
            className="field__input"
            type="datetime-local"
            value={editor.start}
            onChange={(event) => onChange({ ...editor, start: event.target.value })}
          />
        </label>

        <label className="field">
          <span className="field__label">{t('trips.endLabel')}</span>
          <input
            className="field__input"
            type="datetime-local"
            value={editor.end}
            onChange={(event) => onChange({ ...editor, end: event.target.value })}
          />
        </label>

        <div className="field">
          <span className="field__label">{t('trips.mode')}</span>
          <div className="capture__actions capture__actions--wrap">
            {TRANSIT_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                className="button button--quiet button--small"
                data-active={editor.transitMode === mode}
                onClick={() => onChange({ ...editor, transitMode: mode })}
              >
                {t(`trips.mode_${mode}`)}
              </button>
            ))}
          </div>
        </div>

        <label className="field">
          <span className="field__label">{t('trips.purpose')}</span>
          <input
            className="field__input"
            value={editor.purpose}
            placeholder={t('trips.purposePlaceholder')}
            onChange={(event) => onChange({ ...editor, purpose: event.target.value })}
          />
        </label>

        <label className="field">
          <span className="field__label">{t('trips.luggage')}</span>
          <input
            className="field__input"
            value={editor.luggageConstraint}
            placeholder={t('trips.luggagePlaceholder')}
            onChange={(event) => onChange({ ...editor, luggageConstraint: event.target.value })}
          />
        </label>

        <div className="capture__actions">
          <button
            type="button"
            className="button"
            disabled={!editor.destination.trim()}
            onClick={() => void save()}
          >
            {t('trips.save')}
          </button>
          <button type="button" className="button button--quiet" onClick={onDone}>
            {t('trips.cancel')}
          </button>
        </div>
      </div>
    </section>
  );
}
