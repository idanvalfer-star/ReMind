/**
 * The iOS "Add to Home Screen" instructions.
 *
 * Safari fires no `beforeinstallprompt`, so there is no programmatic way to offer installation —
 * instructions are the only option. It matters because Web Push does not exist on iOS until the
 * app is on the home screen, so a user who skips this gets a capture app with no reminders.
 *
 * The brief is explicit that they should be told that plainly rather than discover it, which is
 * what the last line does.
 */

import { useTranslation } from 'react-i18next';

export interface InstallSheetProps {
  onDismiss: () => void;
}

export function InstallSheet({ onDismiss }: InstallSheetProps) {
  const { t } = useTranslation();

  return (
    <aside className="followup followup--sheet install-sheet">
      <strong>{t('install.heading')}</strong>
      <p className="muted">{t('install.why')}</p>
      <ol className="install-sheet__steps">
        <li>{t('install.step1')}</li>
        <li>{t('install.step2')}</li>
        <li>{t('install.step3')}</li>
      </ol>
      {/* Said outright, not left to be discovered. */}
      <p className="muted">{t('install.captureOnly')}</p>
      <button type="button" className="button button--quiet" onClick={onDismiss}>
        {t('install.dismiss')}
      </button>
    </aside>
  );
}
