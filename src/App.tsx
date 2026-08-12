/**
 * The app shell.
 *
 * Capture is the landing view rather than one tab among several, because "launch to capture under
 * one second" is a requirement and any navigation between launch and the field costs more than the
 * budget allows. Everything else sits behind the bottom bar.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { db, type Lang } from './db/schema';
import { detectLocale, detectTimezone, loadSettings } from './db/settings';
import { reconcile } from './engine/index';
import { DAY_MS } from './engine/time';
import { applyDocumentLanguage, changeLanguage } from './i18n/index';
import { readPlatform, shouldShowInstallSheet } from './install/platform';
import { Calendar } from './components/Calendar';
import { Capture } from './components/Capture';
import { InstallSheet } from './components/InstallSheet';
import { Search } from './components/Search';
import { Settings } from './components/Settings';
import { TodayList } from './components/TodayList';

type View = 'today' | 'calendar' | 'search' | 'settings';

const VIEWS: View[] = ['today', 'calendar', 'search', 'settings'];

export function App() {
  const { t } = useTranslation();
  const [view, setView] = useState<View>('today');
  const [locale, setLocale] = useState<Lang>(detectLocale);
  const [timezone, setTimezone] = useState(detectTimezone);
  const [ready, setReady] = useState(false);
  const [showInstall, setShowInstall] = useState(false);
  const [backupOverdue, setBackupOverdue] = useState(false);

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
      setShowInstall(
        shouldShowInstallSheet(readPlatform(), settings.onboarding.dismissedInstallSheet),
      );
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
        </header>

        {showInstall && <InstallSheet onDismiss={dismissInstall} />}

        {view === 'today' && (
          <>
            {/* Rendered before settings resolve so the field is focusable immediately; it reads
                what it needs at submit time, not at mount. */}
            <Capture locale={locale} timezone={timezone} />
            {backupOverdue && <p className="empty">{t('settings.backupOverdue')}</p>}
            {ready && <TodayList locale={locale} timezone={timezone} />}
          </>
        )}
        {view === 'calendar' && ready && <Calendar locale={locale} timezone={timezone} />}
        {view === 'search' && ready && <Search locale={locale} timezone={timezone} />}
        {view === 'settings' && ready && (
          <Settings locale={locale} onLocaleChange={handleLocaleChange} />
        )}
      </main>

      <nav className="tabbar">
        {VIEWS.map((candidate) => (
          <button
            key={candidate}
            type="button"
            className="tabbar__tab"
            data-active={view === candidate}
            aria-current={view === candidate ? 'page' : undefined}
            onClick={() => setView(candidate)}
          >
            {t(`nav.${candidate}`)}
          </button>
        ))}
      </nav>
    </>
  );
}
