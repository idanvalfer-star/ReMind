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
import { useTranslation } from 'react-i18next';
import { LANGUAGES, db, type Lang, type Settings as SettingsRow } from '../db/schema';
import { loadSettings } from '../db/settings';
import { backupFilename, exportBackup, importBackup } from '../backup/backup';
import { forgetPushRegistration } from '../engine/index';
import { changeLanguage } from '../i18n/index';
import { pushAvailability, readPlatform } from '../install/platform';
import { registerForPush } from '../install/push';

export interface SettingsProps {
  locale: Lang;
  onLocaleChange: (locale: Lang) => void;
}

export function Settings({ locale, onLocaleChange }: SettingsProps) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<SettingsRow | null>(null);
  const [availability, setAvailability] = useState(() => pushAvailability(readPlatform()));
  const [message, setMessage] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void loadSettings().then(setSettings);
  }, []);

  async function patch(changes: Partial<Omit<SettingsRow, 'id'>>) {
    await db.settings.update('singleton', changes);
    setSettings(await loadSettings());
  }

  async function enableNotifications() {
    const outcome = await registerForPush();
    setAvailability(pushAvailability(readPlatform()));
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

  if (!settings) return <p className="muted">…</p>;

  const lastExport = settings.lastExportAt
    ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: settings.timezone }).format(
        new Date(settings.lastExportAt),
      )
    : t('settings.never');

  return (
    <section className="settings">
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

      <h2 className="section-heading">{t('settings.notifications')}</h2>
      {availability === 'granted' ? (
        <div className="followup">
          <span>{t('install.granted')}</span>
          <button
            type="button"
            className="button button--quiet"
            onClick={() => {
              void forgetPushRegistration();
              setAvailability(pushAvailability(readPlatform()));
            }}
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

      <h2 className="section-heading">{t('settings.quietHours')}</h2>
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

      <label className="field">
        <span className="field__label">{t('settings.dailyCap')}</span>
        <input
          className="field__input"
          type="number"
          min="0"
          max="50"
          inputMode="numeric"
          value={settings.dailyCap}
          onChange={(event) => void patch({ dailyCap: Number(event.target.value) })}
        />
      </label>

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

      <h2 className="section-heading">{t('settings.backup')}</h2>
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
          {t('settings.import')}
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

      {message && (
        <p className="followup" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
