import { describe, expect, it } from 'vitest';
import { NOTIFICATION_KEYS } from '../engine/notify';
import { createTranslator, resources } from './resources';
import { LANGUAGES } from '../db/schema';

describe('translation resources', () => {
  it('defines every key the notification composer asks for, in every language', () => {
    // This is the check that stops a notification rendering as a raw key because someone
    // added a string to one language and forgot the other.
    for (const locale of LANGUAGES) {
      const t = createTranslator(locale);
      for (const key of NOTIFICATION_KEYS) {
        expect(t(key), `${locale} / ${key}`).not.toBe(key);
        expect(t(key).length, `${locale} / ${key}`).toBeGreaterThan(0);
      }
    }
  });

  it('keeps the two languages structurally identical', () => {
    const flatten = (node: unknown, prefix = ''): string[] =>
      typeof node === 'object' && node !== null
        ? Object.entries(node).flatMap(([k, v]) => flatten(v, prefix ? `${prefix}.${k}` : k))
        : [prefix];

    expect(flatten(resources.he).sort()).toEqual(flatten(resources.en).sort());
  });
});

describe('createTranslator', () => {
  it('resolves nested keys', () => {
    expect(createTranslator('en')('notify.entry.title')).toBe('Reminder');
    expect(createTranslator('he')('notify.entry.title')).toBe('תזכורת');
  });

  it('interpolates variables', () => {
    expect(createTranslator('en')('notify.event.body', { time: '20:00' })).toBe('Starts at 20:00');
  });

  it('leaves an unknown placeholder in place rather than printing undefined', () => {
    const t = createTranslator('en');
    expect(t('notify.event.body', { wrong: 'x' })).toBe('Starts at {{time}}');
  });

  it('returns the key when a string is missing, so the failure is diagnosable', () => {
    // A blank notification would be worse: userVisibleOnly means something is shown either
    // way, and "notify.nope" at least says what went wrong.
    expect(createTranslator('en')('notify.nope')).toBe('notify.nope');
    expect(createTranslator('en')('notify.event')).toBe('notify.event');
  });

  it('ignores variables when the template has no placeholders', () => {
    expect(createTranslator('en')('notify.entry.title', { time: '20:00' })).toBe('Reminder');
  });
});
