import { describe, expect, it } from 'vitest';
import { NOTIFICATION_KEYS } from '../engine/notify';
import { createTranslator, resources } from './resources';
import { LANGUAGES } from '../db/schema';
import { PACK_CATEGORIES, TRANSIT_MODES } from '../db/schema';
import { OUTBOUND_TEMPLATE, RETURN_TEMPLATE } from '../trips/template';
import { STAGE_RULES } from '../trips/stages';
import { weatherItems } from '../trips/weather';

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

describe('packing translations', () => {
  /**
   * Every key the packing generator can emit, collected by running the real functions rather than
   * by keeping a second list next to the first. A template line added without a translation shows up
   * here as a raw `packing.item.thing` on someone's packing list, which is exactly the class of bug
   * a hand-maintained key list fails to catch.
   */
  const generatedKeys = () => {
    const keys = new Set<string>();
    for (const item of [...OUTBOUND_TEMPLATE, ...RETURN_TEMPLATE]) {
      keys.add(`packing.item.${item.key}`);
    }
    // Forecasts chosen to hit every branch in `weatherItems`: hot, cold, cool and wet.
    const extremes = [
      { date: '2026-06-01', minC: 24, maxC: 35, precipMm: 20 },
      { date: '2026-06-02', minC: 1, maxC: 5, precipMm: 0 },
      { date: '2026-06-03', minC: 11, maxC: 18, precipMm: 0 },
    ];
    for (const item of weatherItems(extremes)) keys.add(`packing.item.${item.key}`);
    return [...keys];
  };

  for (const locale of LANGUAGES) {
    it(`defines every packing item the generator can produce in ${locale}`, () => {
      const t = createTranslator(locale);
      for (const key of generatedKeys()) {
        expect(t(key), `${locale} / ${key}`).not.toBe(key);
        expect(t(key).trim().length, `${locale} / ${key}`).toBeGreaterThan(0);
      }
    });

    it(`defines every packing category and origin in ${locale}`, () => {
      const t = createTranslator(locale);
      for (const category of PACK_CATEGORIES) {
        expect(t(`packing.category.${category}`)).not.toBe(`packing.category.${category}`);
      }
      for (const origin of ['template', 'weather', 'learned', 'manual'] as const) {
        expect(t(`packing.origin.${origin}`)).not.toBe(`packing.origin.${origin}`);
      }
    });

    it(`defines a label for every transit mode and stage in ${locale}`, () => {
      const t = createTranslator(locale);
      for (const mode of TRANSIT_MODES) {
        expect(t(`trips.mode_${mode}`), `${locale} / ${mode}`).not.toBe(`trips.mode_${mode}`);
      }
      for (const rule of STAGE_RULES) {
        expect(t(`trips.stage_${rule.id}`), `${locale} / ${rule.id}`).not.toBe(
          `trips.stage_${rule.id}`,
        );
      }
    });
  }
});
