/**
 * The app shell.
 *
 * Capture is the landing surface rather than one tab among several, because "launch to capture
 * under one second" is a requirement and any navigation between launch and the field costs more
 * than the budget allows. Today sits directly beneath it. The calendar, search and settings
 * arrive in the steps that follow.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Lang } from './db/schema';
import { detectTimezone, loadSettings } from './db/settings';
import { reconcile } from './engine/index';
import { applyDocumentLanguage, initI18n } from './i18n/index';
import { Capture } from './components/Capture';
import { TodayList } from './components/TodayList';

export function App() {
  const { t } = useTranslation();
  const [locale, setLocale] = useState<Lang>('en');
  const [timezone, setTimezone] = useState(detectTimezone);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const settings = await loadSettings();
      await initI18n(settings.locale);
      if (cancelled) return;

      applyDocumentLanguage(settings.locale);
      setLocale(settings.locale);
      setTimezone(settings.timezone);
      setReady(true);

      // The backend copy drifts for ordinary reasons — a request lost to a dead connection, a
      // push sent while offline — so every launch brings it back into line. Deliberately not
      // awaited: nothing on screen depends on it.
      void reconcile();
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main>
      <header className="app-header">
        <h1>{ready ? t('app.title') : 'ReMind'}</h1>
      </header>
      {/* Capture renders before settings resolve so the field is focusable immediately; it reads
          what it needs at submit time, not at mount. */}
      <Capture locale={locale} timezone={timezone} />
      {ready && <TodayList locale={locale} timezone={timezone} />}
    </main>
  );
}
