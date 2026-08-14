/**
 * The app shell.
 *
 * Capture is the landing view rather than one tab among several, because "launch to capture under
 * one second" is a requirement and any navigation between launch and the field costs more than the
 * budget allows. Everything else sits behind the bottom bar.
 */

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { db, type Lang } from './db/schema';
import { detectLocale, detectTimezone, loadSettings } from './db/settings';
import { reconcile } from './engine/index';
import { ensureDigestArmed } from './spaced/review';
import { DAY_MS } from './engine/time';
import { applyDocumentLanguage, changeLanguage } from './i18n/index';
import { pushAvailability, readPlatform, shouldShowInstallSheet } from './install/platform';
import { Calendar } from './components/Calendar';
import { Capture } from './components/Capture';
import {
  BellIcon,
  CalendarIcon,
  CheckCircleIcon,
  PeopleIcon,
  SearchIcon,
  TripIcon,
  SettingsIcon,
} from './components/Icons';
import { InstallSheet } from './components/InstallSheet';
import { People } from './components/People';
import { Trips } from './components/Trips';
import { Search } from './components/Search';
import { Settings } from './components/Settings';
import { Today } from './components/Today';

type View = 'today' | 'calendar' | 'people' | 'trips' | 'search' | 'settings';

const VIEWS: { id: View; Icon: (props: { size?: number }) => ReactElement }[] = [
  { id: 'today', Icon: CheckCircleIcon },
  { id: 'calendar', Icon: CalendarIcon },
  { id: 'people', Icon: PeopleIcon },
  { id: 'trips', Icon: TripIcon },
  { id: 'search', Icon: SearchIcon },
  { id: 'settings', Icon: SettingsIcon },
];

export function App() {
  const { t } = useTranslation();
  const [view, setView] = useState<View>('today');
  const [locale, setLocale] = useState<Lang>(detectLocale);
  const [timezone, setTimezone] = useState(detectTimezone);
  const [ready, setReady] = useState(false);
  const [showInstall, setShowInstall] = useState(false);
  const [backupOverdue, setBackupOverdue] = useState(false);
  /**
   * Drives the header bell, so whether reminders can actually reach you is visible at a glance rather
   * than buried in settings.
   *
   * A live query rather than state read once on mount: the registration can disappear while the app is
   * open — Settings can delete it, and a restored backup replaces it — and a bell that stayed lit
   * afterwards would be claiming reminders work when nothing would arrive.
   */
  const hasPushIdentity = useLiveQuery(
    () => db.pushRegistration.get('singleton').then((row) => !!row),
    [],
    false,
  );
  const notificationsOn = pushAvailability(readPlatform(), hasPushIdentity) === 'granted';

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const settings = await loadSettings();
      if (cancelled) return;

      // i18n was already initialised from navigator before the first render; this only switches
      // language if the stored preference differs from what was guessed.
      await changeLanguage(settings.locale);
      if (cancelled) return;

      setLocale(settings.locale);
      setTimezone(settings.timezone);
      const platform = readPlatform();
      setShowInstall(shouldShowInstallSheet(platform, settings.onboarding.dismissedInstallSheet));
      // iOS can clear storage without warning, so the nag is not optional. Only shown once there
      // is something worth losing.
      const since = settings.lastExportAt ?? 0;
      const entries = await db.entries.count();
      setBackupOverdue(
        entries > 0 && Date.now() - since > settings.backupReminderDays * DAY_MS,
      );
      setReady(true);

      // The backend copy drifts for ordinary reasons — a request lost to a dead connection, a
      // push sent while offline — so every launch brings it back into line. Not awaited: nothing
      // on screen depends on it.
      void reconcile();
      // The digest is a one-shot `time` trigger. The service worker re-arms it after each firing;
      // this is the other half, covering the case where it never fired at all — permission
      // declined, device offline, or the setting only just switched on.
      void ensureDigestArmed();
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const dismissInstall = useCallback(() => {
    setShowInstall(false);
    void loadSettings().then((settings) =>
      db.settings.update('singleton', {
        onboarding: { ...settings.onboarding, dismissedInstallSheet: true },
      }),
    );
  }, []);

  const handleLocaleChange = useCallback((next: Lang) => {
    setLocale(next);
    applyDocumentLanguage(next);
  }, []);

  return (
    <>
      <main>
        <header className="app-header">
          <h1>{t('app.title')}</h1>
          <button
            type="button"
            className="header-button"
            data-active={notificationsOn}
            aria-label={t('settings.notifications')}
            onClick={() => setView('settings')}
          >
            <BellIcon active={notificationsOn} />
          </button>
        </header>

        {showInstall && <InstallSheet onDismiss={dismissInstall} />}

        {view === 'today' && (
          <>
            {/* Rendered before settings resolve so the field is focusable immediately; it reads
                what it needs at submit time, not at mount. */}
            <Capture locale={locale} timezone={timezone} />
            {backupOverdue && <p className="card empty">{t('settings.backupOverdue')}</p>}
            {ready && <Today locale={locale} timezone={timezone} />}
          </>
        )}
        {view === 'calendar' && ready && <Calendar locale={locale} timezone={timezone} />}
        {view === 'people' && ready && <People locale={locale} />}
        {view === 'trips' && ready && <Trips locale={locale} timezone={timezone} />}
        {view === 'search' && ready && <Search locale={locale} timezone={timezone} />}
        {view === 'settings' && ready && (
          <Settings locale={locale} timezone={timezone} onLocaleChange={handleLocaleChange} />
        )}
      </main>

      <nav className="tabbar">
        {VIEWS.map(({ id, Icon }) => (
          <button
            key={id}
            type="button"
            className="tabbar__tab"
            data-active={view === id}
            aria-current={view === id ? 'page' : undefined}
            onClick={() => setView(id)}
          >
            <Icon />
            {t(`nav.${id}`)}
          </button>
        ))}
      </nav>
    </>
  );
}
