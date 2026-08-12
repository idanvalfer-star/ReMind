/**
 * Translation resources, and a translator small enough for the service worker.
 *
 * The app proper uses i18next. The service worker cannot: it wakes up to show one string and
 * has no business instantiating an i18n runtime, and every byte it carries delays the
 * notification. So this module exposes the same JSON both consume, plus a ~15-line lookup
 * that handles the only two features a notification needs — nested keys and `{{var}}`
 * interpolation.
 *
 * One set of resources, two readers. The alternative — a separate copy of the notification
 * strings for the worker — would drift the moment anyone edited one and not the other.
 */

import en from './en.json';
import he from './he.json';
import type { Lang } from '../db/schema';

export const resources = { en, he } as const;

/** Shape of a resource file: arbitrarily nested objects with string leaves. */
type ResourceNode = { [key: string]: string | ResourceNode };

const INTERPOLATION = /\{\{(\w+)\}\}/g;

function resolve(node: ResourceNode, path: readonly string[]): string | undefined {
  let current: string | ResourceNode | undefined = node;
  for (const segment of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = current[segment];
  }
  return typeof current === 'string' ? current : undefined;
}

export type Translate = (key: string, vars?: Record<string, string | number>) => string;

/**
 * Builds a translator for one language, falling back to English and then to the key itself.
 *
 * Returning the key rather than an empty string matters here: a missing notification string
 * would otherwise produce a blank notification, and `userVisibleOnly` means the user gets
 * *something* either way. An ugly `notify.event.body` is at least diagnosable; a blank
 * notification is not.
 */
export function createTranslator(locale: Lang): Translate {
  const primary = resources[locale] as ResourceNode;
  const fallback = resources.en as ResourceNode;

  return (key, vars) => {
    const path = key.split('.');
    const template = resolve(primary, path) ?? resolve(fallback, path) ?? key;
    if (!vars) return template;
    return template.replace(INTERPOLATION, (whole, name: string) => {
      const value = vars[name];
      return value === undefined ? whole : String(value);
    });
  };
}
