/**
 * Time audits, rendered inside Settings.
 *
 * The first consumer of `TriggerFire`, which Phase 1 wrote and nothing read. The useful question is
 * not how many reminders arrived but **which kinds you actually act on** — a type you dismiss nine
 * times in ten is one to turn off, and only the user can make that call.
 *
 * So nothing here adjusts behaviour. The brief says Phase 4 "tunes on" the response log; tuning
 * silently would mean the app quietly deciding to stop reminding someone about something it had
 * promised to. Showing the numbers next to the controls is the honest version, and the card says so.
 */

import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { db, type Lang } from '../db/schema';
import { buildAudit } from '../audit/audit';
import { DAY_MS } from '../engine/time';

export interface InsightsProps {
  locale: Lang;
  timezone: string;
}

/** A month is long enough to show a pattern and short enough to still describe your life now. */
const WINDOW_DAYS = 30;

export function Insights({ locale, timezone }: InsightsProps) {
  const { t } = useTranslation();

  const summary = useLiveQuery(async () => {
    const now = Date.now();
    const from = now - WINDOW_DAYS * DAY_MS;
    const [fires, triggers, events] = await Promise.all([
      db.triggerFires.toArray(),
      db.triggers.toArray(),
      db.events.where('startAt').between(from, now + DAY_MS, true, false).toArray(),
    ]);
    return buildAudit({ fires, triggers, events, timezone, from, to: now + DAY_MS });
  }, [timezone]);

  if (!summary) return null;

  const nothingYet = summary.responses.delivered === 0 && summary.days.length === 0;
  const percent = (value: number) =>
    new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(value);
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  const peak = Math.max(1, ...summary.hours);

  return (
    <div className="card" style={{ marginBlockStart: 'var(--gap)' }}>
      <span className="card__label">{t('audit.heading')}</span>

      {nothingYet ? (
        <p className="empty">{t('audit.noData')}</p>
      ) : (
        <>
          {summary.responses.delivered > 0 && (
            <>
              <span className="section-label">{t('audit.responses')}</span>
              <ul className="item-list">
                {(
                  [
                    ['delivered', summary.responses.delivered],
                    ['acted', summary.responses.acted],
                    ['dismissed', summary.responses.dismissed],
                    ['snoozed', summary.responses.snoozed],
                    ['ignored', summary.responses.ignored],
                  ] as const
                ).map(([key, value]) => (
                  <li key={key} className="item item--with-action">
                    <span className="item__dot" aria-hidden="true" />
                    <span className="item__title">{t(`audit.${key}`)}</span>
                    <span className="item__time">{number(value)}</span>
                  </li>
                ))}
              </ul>

              <span className="section-label">{t('audit.byKind')}</span>
              <ul className="item-list">
                {summary.byKind.map((row) => (
                  <li key={row.kind} className="item item--with-action">
                    <span className="item__dot" aria-hidden="true" />
                    <span className="item__title">{t(`audit.kind_${row.kind}`)}</span>
                    <span className="item__time">
                      {row.counts.actedRate === null
                        ? '—'
                        : `${percent(row.counts.actedRate)} ${t('audit.actedShare')}`}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {summary.averageHoursPerBusyDay !== null && (
            <>
              <span className="section-label">{t('audit.scheduled')}</span>
              <p className="item__body">
                {t('audit.avgBusyDay')} ·{' '}
                {t('audit.hoursUnit', {
                  hours: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(
                    summary.averageHoursPerBusyDay,
                  ),
                })}
              </p>
            </>
          )}

          {summary.hours.some((count) => count > 0) && (
            <>
              <span className="section-label">{t('audit.whenBusy')}</span>
              {/* 24 bars, one per hour. A histogram rather than a number because the shape is the
                  finding — "my evenings are gone" is not something a mean conveys. */}
              <div className="hour-histogram" role="img" aria-label={t('audit.whenBusy')}>
                {summary.hours.map((count, hour) => (
                  <span
                    key={hour}
                    className="hour-histogram__bar"
                    style={{ blockSize: `${Math.round((count / peak) * 100)}%` }}
                    data-empty={count === 0}
                    title={`${String(hour).padStart(2, '0')}:00 · ${number(count)}`}
                  />
                ))}
              </div>
            </>
          )}

          <p className="field__help">{t('audit.note')}</p>
        </>
      )}
    </div>
  );
}
