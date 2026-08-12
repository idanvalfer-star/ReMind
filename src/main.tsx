import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App';
import { detectLocale } from './db/settings';
import { applyDocumentLanguage, initI18n } from './i18n/index';
import './index.css';

/**
 * Registers the service worker.
 *
 * `registerType: 'prompt'` in the Vite config means updates are not applied silently. That is
 * deliberate: a reload triggered mid-capture would discard whatever the user was typing, and
 * capture being trustworthy matters more than running the newest bundle immediately.
 *
 * The update prompt itself belongs with the rest of the UI chrome and is not built yet, so for
 * now a waiting update simply stays waiting — which is the safe direction.
 */
registerSW({ immediate: true });

const container = document.getElementById('root');
if (!container) throw new Error('#root missing from index.html');

/**
 * i18n is initialised **before** the first render, not in an effect.
 *
 * `useTranslation` needs an i18next instance during render; without one, react-i18next warns and
 * then throws from its own effect, which takes down the whole tree and leaves an empty page. That
 * is not a subtle failure and it is not recoverable at the component level, so initialisation is a
 * precondition for rendering rather than something React coordinates.
 *
 * The locale comes from `navigator` rather than from the database, so this costs no IndexedDB read
 * and does not delay first paint. `App` switches language afterwards if the stored setting differs.
 */
const initialLocale = detectLocale();
applyDocumentLanguage(initialLocale);

void initI18n(initialLocale).then(() => {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
