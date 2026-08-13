import { describe, expect, it } from 'vitest';
import { buildBriefing, groupFactsByPerson } from './briefing';
import type { Event, Fact, FactKind, ID, Person } from '../db/schema';

const START = Date.UTC(2026, 5, 10, 17, 0);

function event(title: string, overrides: Partial<Event> = {}): Event {
  return {
    id: 'e1',
    title,
    startAt: START,
    endAt: START + 3_600_000,
    timezone: 'Asia/Jerusalem',
    isAllDay: false,
    location: null,
    travelBufferMinutes: 0,
    isPrivate: false,
    sourceEntryId: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function person(name: string, aliases: string[] = [], id = name): Person {
  return { id, name, aliases, cadenceDays: null, lastInteractionAt: null, createdAt: 0 };
}

function fact(personId: ID, body: string, kind: FactKind = 'misc', confidence = 1): Fact {
  return {
    id: `${personId}:${body}`,
    personId,
    body,
    kind,
    confidence,
    sourceEntryId: null,
    createdAt: 0,
  };
}

describe('groupFactsByPerson', () => {
  it('buckets by person and keeps every fact', () => {
    const grouped = groupFactsByPerson([
      fact('a', 'one'),
      fact('b', 'two'),
      fact('a', 'three'),
    ]);
    expect(grouped.get('a')).toHaveLength(2);
    expect(grouped.get('b')).toHaveLength(1);
    expect(grouped.get('c')).toBeUndefined();
  });

  it('is empty for no facts', () => {
    expect(groupFactsByPerson([]).size).toBe(0);
  });
});

describe('buildBriefing', () => {
  const alex = person('Alex');
  const facts = groupFactsByPerson([fact('Alex', 'drinks coffee black', 'preference')]);

  it('matches a person from the event title', () => {
    const briefing = buildBriefing(event('Dinner with Alex'), [alex], facts);
    expect(briefing?.people.map((p) => p.person.id)).toEqual(['Alex']);
    expect(briefing?.people[0]?.facts.map((f) => f.body)).toEqual(['drinks coffee black']);
  });

  it('is null when nobody in the title is known', () => {
    expect(buildBriefing(event('Dinner with Morgan'), [alex], facts)).toBeNull();
  });

  it('is null for a matched person with nothing recorded', () => {
    // An empty "Before you meet Alex" card is noise, and this surface has to earn its place.
    expect(buildBriefing(event('Dinner with Alex'), [alex], new Map())).toBeNull();
  });

  it('drops matched people who have no facts but keeps those who do', () => {
    const dana = person('Dana');
    const briefing = buildBriefing(event('Alex and Dana'), [alex, dana], facts);
    expect(briefing?.people.map((p) => p.person.id)).toEqual(['Alex']);
  });

  it('never mines a private event, whose title is exactly what was to be kept off screen', () => {
    expect(buildBriefing(event('Dinner with Alex', { isPrivate: true }), [alex], facts)).toBeNull();
  });

  it('ranks facts so the most surfaceable one is first', () => {
    const ranked = groupFactsByPerson([
      fact('Alex', 'likes jazz', 'misc'),
      fact('Alex', 'just changed jobs', 'milestone'),
      fact('Alex', 'drinks coffee black', 'preference'),
    ]);
    const briefing = buildBriefing(event('Coffee with Alex'), [alex], ranked);
    expect(briefing?.people[0]?.facts.map((f) => f.body)).toEqual([
      'just changed jobs',
      'drinks coffee black',
      'likes jazz',
    ]);
  });

  it('matches through a Hebrew title with an attached particle', () => {
    const sarah = person('שרה');
    const hebrewFacts = groupFactsByPerson([fact('שרה', 'אוהבת תה ירוק', 'preference')]);
    const briefing = buildBriefing(event('פגישה עם שרה'), [sarah], hebrewFacts);
    expect(briefing?.people[0]?.person.id).toBe('שרה');
  });

  it('keeps several people when the title names several', () => {
    const dana = person('Dana');
    const both = groupFactsByPerson([
      fact('Alex', 'drinks coffee black', 'preference'),
      fact('Dana', 'allergic to shellfish', 'preference'),
    ]);
    const briefing = buildBriefing(event('Lunch with Alex and Dana'), [alex, dana], both);
    expect(briefing?.people).toHaveLength(2);
  });
});
