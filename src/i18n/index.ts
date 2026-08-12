/**
 * i18next setup for the app.
 *
 * The service worker deliberately does not use this — it reads the same JSON through the
 * 15-line lookup in `resources.ts`, because instantiating an i18n runtime to show one string
 * would delay the notification for no benefit. One set of resources, two readers; see the note
 * there.
 *
 * No hardcoded user-facing strings anywhere in the app. That is easy to say and easy to
 * violate, so `missingKeyHandler` shouts in development rather than silently rendering a key.
 */

import i18next, { type InitOptions } from 'i18next';
import { initReactI18next } from 'react-i18next';
import { LANGUAGES, type Lang } from '../db/schema';
import { resources } from './resources';

export async function initI18n(locale: Lang): Promise<void> {
  if (i18next.isInitialized) {
    await i18next.changeLanguage(locale);
    return;
  }

  const options: InitOptions = {
    lng: locale,
    fallbackLng: 'en',
    supportedLngs: [...LANGUAGES],
    resources: {
      en: { translation: resources.en },
      he: { translation: resources.he },
    },
    interpolation: {
      // React escapes for us; double-escaping mangles apostrophes in Hebrew transliterations.
      escapeValue: false,
    },
  };

  // Assigned conditionally rather than set to undefined: with exactOptionalPropertyTypes an
  // explicit undefined is not the same as absent, and i18next treats the key as configured.
  if (import.meta.env.DEV) {
    options.saveMissing = true;
    options.missingKeyHandler = (_lngs: readonly string[], _ns: string, key: string) => {
      console.error(`[i18n] missing translation key: ${key}`);
    };
  }

  await i18next.use(initReactI18next).init(options);
}

/**
 * Applies the language to the document.
 *
 * `dir` is what actually flips the layout — every stylesheet rule uses logical properties, so
 * this one attribute mirrors the whole interface.
 */
export function applyDocumentLanguage(locale: Lang): void {
  document.documentElement.lang = locale;
  document.documentElement.dir = locale === 'he' ? 'rtl' : 'ltr';
}

export async function changeLanguage(locale: Lang): Promise<void> {
  await i18next.changeLanguage(locale);
  applyDocumentLanguage(locale);
}
