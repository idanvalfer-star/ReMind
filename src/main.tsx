import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App';
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

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
