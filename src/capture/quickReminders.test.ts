import { describe, expect, it } from 'vitest';
import { zonedParts, zonedWallClockToEpoch, HOUR_MS } from '../engine/time';
import { quickReminders } from './quickReminders';

const JLM = 'Asia/Jerusalem';
const at = (day: number, hour: number, minute = 0) =>
  zonedWallClockToEpoch({ year: 2026, month: 6, day, hour, minute }, JLM);

describe('quickReminders', () => {
  it('offers an hour from now, this evening and tomorrow morning', () => {
    const offers = quickReminders(at(10, 12), JLM);
    expect(offers.map((o) => o.id)).toEqual(['inAnHour', 'thisEvening', 'tomorrowMorning']);

    expect(offers[0]!.at).toBe(at(10, 12) + HOUR_MS);
    expect(zonedParts(offers[1]!.at, JLM)).toMatchObject({ day: 10, hour: 19 });
    expect(zonedParts(offers[2]!.at, JLM)).toMatchObject({ day: 11, hour: 9 });
  });

  it('drops "this evening" once it has passed', () => {
    // An option that silently means tomorrow is worse than one fewer option.
    const offers = quickReminders(at(10, 20), JLM);
    expect(offers.map((o) => o.id)).toEqual(['inAnHour', 'tomorrowMorning']);
  });

  it('puts the parsed time first when the capture named one', () => {
    const parsed = at(10, 16);
    const offers = quickReminders(at(10, 12), JLM, parsed);
    expect(offers[0]).toEqual({ id: 'atParsedTime', at: parsed });
  });

  it('ignores a parsed time that has already gone', () => {
    const offers = quickReminders(at(10, 12), JLM, at(10, 9));
    expect(offers.some((o) => o.id === 'atParsedTime')).toBe(false);
  });

  it('crosses midnight without offering anything in the past', () => {
    const now = at(10, 23, 50);
    const offers = quickReminders(now, JLM);
    for (const offer of offers) expect(offer.at, offer.id).toBeGreaterThan(now);
    // Tomorrow morning is the 11th, and "in an hour" has already rolled past midnight.
    expect(zonedParts(offers.at(-1)!.at, JLM)).toMatchObject({ day: 11, hour: 9 });
  });

  it('never offers a time in the past, at any hour of the day', () => {
    for (let hour = 0; hour < 24; hour++) {
      const now = at(10, hour, 30);
      for (const offer of quickReminders(now, JLM)) {
        expect(offer.at, `${hour}:30 / ${offer.id}`).toBeGreaterThan(now);
      }
    }
  });
});
