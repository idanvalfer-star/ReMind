/**
 * Settings, including the notification permission sequence and backup.
 *
 * The notification section is the one that needs care. `pushAvailability` decides what may be
 * offered, and on iOS the answer in a browser tab is "install first" rather than "unsupported" —
 * requesting permission there burns the user's one chance and cannot be retried without a trip
 * into system settings. Permission is therefore only ever requested from a tap on the button
 * below, and only when the platform says it is available.
 */

import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { LANGUAGES, db, type Lang, type Settings as SettingsRow } from '../db/schema';
import { loadSettings } from '../db/settings';
import { backupFilename, exportBackup, importBackup } from '../backup/backup';
import { forgetPushRegistration } from '../engine/index';
import { changeLanguage } from '../i18n/index';
import { pushAvailability, readPlatform } from '../install/platform';
import { registerForPush } from '../install/push';
import { parseHHmm } from '../engine/time';
import { enrolledCount, ensureDigestArmed } from '../spaced/review';
import { Insights } from './Insights';
import { SemanticSetting } from './SemanticSetting';
import { ShareSetting } from './ShareSetting';
import { SyncSetting } from './SyncSetting';

export interface SettingsProps {
  locale: Lang;
  timezone: string;
  onLocaleChange: (locale: Lang) => void;
}

/** The inverse of `parseHHmm`, for an `<input type="time">` bound to a minute count. */
function minutesToHHmm(minutes: number): string {
  const clamped = Math.max(0, Math.min(24 * 60 - 1, Math.round(minutes)));
  const hh = String(Math.floor(clamped / 60)).padStart(2, '0');
  const mm = String(clamped % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function Settings({ locale, timezone, onLocaleChange }: SettingsProps) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<SettingsRow | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  /**
   * Whether this device holds a push identity, live from the database rather than copied into state.
   *
   * Deriving `availability` from this instead of storing it means every path that creates or destroys
   * the registration updates the screen on its own — including `forgetPushRegistration`, which used to
   * leave the section claiming "reminders are on" because the permission it read was still granted.
   */
  const hasPushIdentity = useLiveQuery(
    () => db.pushRegistration.get('singleton').then((row) => !!row),
    [],
    undefined,
  );
  const fileInput = useRef<HTMLInputElement>(null);
  const rotation = useLiveQuery(() => enrolledCount(), [], 0);

  useEffect(() => {
    void loadSettings().then(setSettings);
  }, []);

  async function patch(changes: Partial<Omit<SettingsRow, 'id'>>) {
    await db.settings.update('singleton', changes);
    setSettings(await loadSettings());
  }

  async function enableNotifications() {
    const outcome = await registerForPush();
    if (outcome.kind === 'failed') setMessage(outcome.reason);
    if (outcome.kind === 'registered') {
      await patch({
        onboarding: { ...settings!.onboarding, completedPushPrompt: true },
      });
    }
  }

  async function runExport() {
    const backup = await exportBackup();
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = backupFilename();
    anchor.click();
    // Revoking immediately can cancel the download on some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    setSettings(await loadSettings());
  }

  async function runImport(file: File) {
    try {
      const result = await importBackup(await file.text());
      setMessage(t('settings.importDone', { count: result.restored }));
      setSettings(await loadSettings());
    } catch {
      setMessage(t('settings.importFailed'));
    }
  }

  // Both reads are async, and guessing at either one would flash a wrong answer about notifications.
  if (!settings || hasPushIdentity === undefined) return <p className="muted">…</p>;

  const availability = pushAvailability(readPlatform(), hasPushIdentity);

  const lastExport = settings.lastExportAt
    ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: settings.timezone }).format(
        new Date(settings.lastExportAt),
      )
    : t('settings.never');

  return (
    <section className="settings">
      <div className="card">
        <span className="card__label">{t('settings.system')}</span>
      <label className="field">
        <span className="field__label">{t('settings.language')}</span>
        <select
          className="field__input"
          value={settings.locale}
          onChange={(event) => {
            const next = event.target.value as Lang;
            void patch({ locale: next }).then(() => changeLanguage(next));
            onLocaleChange(next);
          }}
        >
          {LANGUAGES.map((lang) => (
            <option key={lang} value={lang}>
              {lang === 'en' ? 'English' : 'עברית'}
            </option>
          ))}
        </select>
      </label>

      <p className="muted">
        {t('settings.timezone')}: {settings.timezone}
      </p>

      <span className="card__label" style={{ marginBlockStart: '0.75rem' }}>
        {t('settings.notifications')}
      </span>
      {availability === 'granted' ? (
        <div className="followup">
          <span>{t('install.granted')}</span>
          <button
            type="button"
            className="button button--quiet"
            onClick={() => void forgetPushRegistration()}
          >
            {t('calendar.delete')}
          </button>
        </div>
      ) : availability === 'available' ? (
        <button type="button" className="button" onClick={() => void enableNotifications()}>
          {t('install.enable')}
        </button>
      ) : availability === 'needs-install' ? (
        <p className="empty">{t('install.why')}</p>
      ) : availability === 'denied' ? (
        <p className="empty">{t('install.denied')}</p>
      ) : (
        <p className="empty">{t('install.unsupported')}</p>
      )}
      {availability !== 'granted' && <p className="muted">{t('install.captureOnly')}</p>}
      </div>

      <div className="card">
        <span className="card__label">{t('settings.quietHours')}</span>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={settings.quietHours.enabled}
          onChange={(event) =>
            void patch({ quietHours: { ...settings.quietHours, enabled: event.target.checked } })
          }
        />
        <span>{t('settings.quietHoursOn')}</span>
      </label>
      <div className="settings__row">
        <label className="field">
          <span className="field__label">{t('settings.quietFrom')}</span>
          <input
            className="field__input"
            type="time"
            value={settings.quietHours.start}
            onChange={(event) =>
              void patch({ quietHours: { ...settings.quietHours, start: event.target.value } })
            }
          />
        </label>
        <label className="field">
          <span className="field__label">{t('settings.quietTo')}</span>
          <input
            className="field__input"
            type="time"
            value={settings.quietHours.end}
            onChange={(event) =>
              void patch({ quietHours: { ...settings.quietHours, end: event.target.value } })
            }
          />
        </label>
      </div>

      </div>

      <div className="card">
        <span className="card__label">{t('settings.frequencyPerDay')}</span>
      <label className="field">
        <span className="field__label">
          {t('settings.dailyCap')}: {settings.dailyCap}
        </span>
        <input
          type="range"
          min="0"
          max="20"
          step="1"
          value={settings.dailyCap}
          onChange={(event) => void patch({ dailyCap: Number(event.target.value) })}
        />
      </label>

      </div>

      <div className="card">
        <span className="card__label">{t('review.digest')}</span>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={settings.digest.enabled}
            onChange={(event) =>
              // `ensureDigestArmed` both arms and clears, so one call covers either direction — and
              // it is the only thing that decides whether there is anything worth arming.
              void patch({ digest: { ...settings.digest, enabled: event.target.checked } }).then(() =>
                ensureDigestArmed(),
              )
            }
          />
          <span>{t('review.digestOn')}</span>
        </label>
        <label className="field">
          <span className="field__label">{t('review.digestHour')}</span>
          <input
            className="field__input"
            type="time"
            value={minutesToHHmm(settings.digest.atMinuteOfDay)}
            onChange={(event) => {
              const minutes = parseHHmm(event.target.value);
              if (minutes === null) return;
              void patch({ digest: { ...settings.digest, atMinuteOfDay: minutes } }).then(() =>
                ensureDigestArmed(),
              );
            }}
          />
        </label>
        {rotation === 0 && <p className="field__help">{t('review.digestNeedsNotes')}</p>}
      </div>

      <div className="card">
        <span className="card__label">{t('settings.interpretation')}</span>
      <label className="field">
        <span className="field__label">
          {t('settings.confidence')} {settings.confidenceThreshold.toFixed(2)}
        </span>
        <input
          type="range"
          min="0.5"
          max="1"
          step="0.05"
          value={settings.confidenceThreshold}
          onChange={(event) => void patch({ confidenceThreshold: Number(event.target.value) })}
        />
      </label>

      </div>

      <div className="card">
        <span className="card__label">{t('settings.backup')}</span>
      <p className="muted">{t('settings.lastExport', { when: lastExport })}</p>
      <div className="capture__actions capture__actions--wrap">
        <button type="button" className="button" onClick={() => void runExport()}>
          {t('settings.export')}
        </button>
        <button
          type="button"
          className="button button--quiet"
          onClick={() => fileInput.current?.click()}
        >
          {t('settings.restore')}
        </button>
      </div>
      <p className="muted">{t('settings.importReplaces')}</p>
      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void runImport(file);
          event.target.value = '';
        }}
      />

      </div>

      {message && (
        <p className="followup" role="status">
          {message}
        </p>
      )}
      <div style={{ marginBlockStart: 'var(--gap)' }}>
        <SyncSetting locale={locale} hasPushIdentity={hasPushIdentity} />
      </div>

      <div style={{ marginBlockStart: 'var(--gap)' }}>
        <ShareSetting hasPushIdentity={hasPushIdentity} />
      </div>

      <div style={{ marginBlockStart: 'var(--gap)' }}>
        <SemanticSetting
          enabled={settings.semanticSearchEnabled}
          onChange={(next) => patch({ semanticSearchEnabled: next })}
        />
      </div>

      <Insights locale={locale} timezone={timezone} />
    </section>
  );
}
