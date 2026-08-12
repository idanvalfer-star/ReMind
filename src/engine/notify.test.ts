import { describe, expect, it } from 'vitest';
import type { Entry, Event, Trigger } from '../db/schema';
import { composeNotification, truncate, type Translate } from './notify';

/** Echoes the key plus its interpolations, so tests assert on structure not on wording. */
const t: Translate = (key, vars) =>
  vars ? `${key}(${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(',')})` : key;

const trigger = { id: 'trig-1' } as Trigger;

const event: Event = {
  id: 'e1',
  title: 'Dinner with Alex',
  startAt: Date.UTC(2026, 5, 10, 17, 0), // 20:00 in Jerusalem
  endAt: Date.UTC(2026, 5, 10, 19, 0),
  timezone: 'Asia/Jerusalem',
  isAllDay: false,
  location: null,
  travelBufferMinutes: 0,
  isPrivate: false,
  sourceEntryId: null,
  createdAt: 0,
  updatedAt: 0,
};

const entry: Entry = {
  id: 'x1',
  body: 'Call the dentist',
  rawInput: 'Call the dentist',
  capturedAt: 0,
  source: 'text',
  language: 'en',
  searchTokens: [],
};

describe('truncate', () => {
  it('leaves short text alone', () => {
    expect(truncate('short', 20)).toBe('short');
  });

  it('breaks on a word boundary when one is near the limit', () => {
    expect(truncate('alpha beta gamma delta', 18)).toBe('alpha beta gamma…');
  });

  it('breaks mid-word rather than losing most of the text', () => {
    // No space near the limit, so a word-boundary break would discard almost everything.
    expect(truncate('aaaaaaaaaaaaaaaaaaaaaaaa b', 10)).toBe('aaaaaaaaa…');
  });

  it('trims surrounding whitespace', () => {
    expect(truncate('  padded  ', 20)).toBe('padded');
  });
});

describe('composeNotification — event', () => {
  it('uses the event title and localises the start time in the event’s own zone', () => {
    const content = composeNotification({
      trigger,
      target: { type: 'event', event },
      t,
      locale: 'en',
    });
    expect(content.title).toBe('Dinner with Alex');
    // 17:00Z is 20:00 in Jerusalem — the event's zone, not the reader's.
    expect(content.body).toBe('notify.event.body(time=08:00 PM)');
    expect(content.tag).toBe('trig-1');
  });

  it('marks an all-day event instead of inventing a time', () => {
    // A separate key, not "all day" substituted into the timed phrasing — that would read
    // "Starts at all day".
    const content = composeNotification({
      trigger,
      target: { type: 'event', event: { ...event, isAllDay: true } },
      t,
      locale: 'en',
    });
    expect(content.body).toBe('notify.event.allDayBody');
  });

  it('withholds the title of a private event entirely', () => {
    // The flag exists so the title stays off a lock screen, so it is replaced rather
    // than shortened.
    const content = composeNotification({
      trigger,
      target: { type: 'event', event: { ...event, isPrivate: true } },
      t,
      locale: 'en',
    });
    expect(content.title).toBe('notify.event.privateTitle');
    expect(content.body).toBe('notify.event.privateBody');
    expect(content.title).not.toContain('Alex');
    expect(content.body).not.toContain('Alex');
  });

  it('truncates an overlong title', () => {
    const long = 'A'.repeat(200);
    const content = composeNotification({
      trigger,
      target: { type: 'event', event: { ...event, title: long } },
      t,
      locale: 'en',
    });
    expect(content.title.length).toBeLessThan(long.length);
    expect(content.title.endsWith('…')).toBe(true);
  });
});

describe('composeNotification — entry', () => {
  it('shows the entry body under a generic title', () => {
    const content = composeNotification({ trigger, target: { type: 'entry', entry }, t, locale: 'en' });
    expect(content.title).toBe('notify.entry.title');
    expect(content.body).toBe('Call the dentist');
  });
});

describe('composeNotification — unknown target', () => {
  it('falls back to generic text rather than showing nothing', () => {
    // iOS can evict IndexedDB, so a push may arrive for data that is gone. userVisibleOnly
    // forbids swallowing it, so there must always be something to display.
    const content = composeNotification({ trigger, target: { type: 'unknown' }, t, locale: 'en' });
    expect(content.title).toBe('notify.fallback.title');
    expect(content.body).toBe('notify.fallback.body');
    expect(content.tag).toBe('trig-1');
  });
});

describe('composeNotification — always displayable', () => {
  it('never returns empty text for any target', () => {
    const targets = [
      { type: 'event', event } as const,
      { type: 'event', event: { ...event, isPrivate: true } } as const,
      { type: 'entry', entry } as const,
      { type: 'unknown' } as const,
    ];
    for (const target of targets) {
      const content = composeNotification({ trigger, target, t, locale: 'en' });
      expect(content.title.length, target.type).toBeGreaterThan(0);
      expect(content.body.length, target.type).toBeGreaterThan(0);
      expect(content.tag).toBe('trig-1');
    }
  });
});
