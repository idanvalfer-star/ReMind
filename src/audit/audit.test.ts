import { describe, expect, it } from 'vitest';
import {
  buildAudit,
  busyHours,
  deliveryVolume,
  loadByDay,
  overallResponses,
  responsesByKind,
} from './audit';
import type { Event, Trigger, TriggerFire, TriggerKind, TriggerResponse } from '../db/schema';
import { DAY_MS, HOUR_MS, zonedWallClockToEpoch } from '../engine/time';

const JLM = 'Asia/Jerusalem';
const local = (day: number, hour = 0, minute = 0) =>
  zonedWallClockToEpoch({ year: 2026, month: 6, day, hour, minute }, JLM);

function fire(response: TriggerResponse, triggerId = 't1', firedAt = local(10, 9)): TriggerFire {
  return {
    id: crypto.randomUUID(),
    triggerId,
    firedAt,
    deliveredVia: 'push',
    lookupFailed: 0,
    response,
    respondedAt: response === 'none' ? null : firedAt + 1000,
  };
}

function trigger(id: string, kind: TriggerKind): Trigger {
  return {
    id,
    targetType: 'entry',
    targetId: 'e1',
    kind,
    condition: { kind: 'time', at: 0, timezone: JLM },
    nextFireAt: null,
    lastFiredAt: null,
    active: 1,
    snoozedUntil: null,
    location: null,
    syncedFireAt: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

function event(startAt: number, hours: number, overrides: Partial<Event> = {}): Event {
  return {
    id: crypto.randomUUID(),
    title: 'Thing',
    startAt,
    endAt: startAt + hours * HOUR_MS,
    timezone: JLM,
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

describe('overallResponses', () => {
  it('is empty and rate-null with no deliveries', () => {
    expect(overallResponses([])).toMatchObject({ delivered: 0, actedRate: null });
  });

  it('counts each response kind', () => {
    const counts = overallResponses([
      fire('acted'),
      fire('acted'),
      fire('dismissed'),
      fire('snoozed'),
      fire('none'),
    ]);
    expect(counts).toMatchObject({
      acted: 2,
      dismissed: 1,
      snoozed: 1,
      ignored: 1,
      delivered: 5,
    });
    expect(counts.actedRate).toBeCloseTo(0.4);
  });

  it('separates silence from dismissal', () => {
    // Being ignored and being deliberately dismissed are different signals about a reminder.
    const counts = overallResponses([fire('none'), fire('none'), fire('dismissed')]);
    expect(counts.ignored).toBe(2);
    expect(counts.dismissed).toBe(1);
  });
});

describe('responsesByKind', () => {
  const triggers = [trigger('t1', 'time'), trigger('t2', 'cadence'), trigger('t3', 'spaced')];

  it('groups deliveries by the kind that produced them', () => {
    const byKind = responsesByKind(
      [fire('acted', 't1'), fire('dismissed', 't2'), fire('dismissed', 't2')],
      triggers,
    );
    expect(byKind.find((row) => row.kind === 'time')?.counts.acted).toBe(1);
    expect(byKind.find((row) => row.kind === 'cadence')?.counts.dismissed).toBe(2);
  });

  it('puts the worst-performing kind first, since that is the point of looking', () => {
    const byKind = responsesByKind(
      [
        fire('acted', 't1'),
        fire('acted', 't1'),
        fire('dismissed', 't2'),
        fire('none', 't2'),
      ],
      triggers,
    );
    expect(byKind[0]?.kind).toBe('cadence');
    expect(byKind[0]?.counts.actedRate).toBe(0);
  });

  it('omits kinds with no deliveries rather than showing empty rows', () => {
    const byKind = responsesByKind([fire('acted', 't1')], triggers);
    expect(byKind.map((row) => row.kind)).toEqual(['time']);
  });

  it('drops fires whose trigger has been deleted rather than guessing', () => {
    const byKind = responsesByKind([fire('acted', 'gone')], triggers);
    expect(byKind).toEqual([]);
  });

  it('is empty with no fires at all', () => {
    expect(responsesByKind([], triggers)).toEqual([]);
  });
});

describe('deliveryVolume', () => {
  it('counts only deliveries inside the window', () => {
    const fires = [
      fire('acted', 't1', local(5, 9)),
      fire('none', 't1', local(10, 9)),
      fire('dismissed', 't1', local(20, 9)),
    ];
    expect(deliveryVolume(fires, local(8), local(15))).toEqual({ delivered: 1, answered: 0 });
  });

  it('treats a dismissal as answered, since the user made a decision', () => {
    const fires = [fire('dismissed', 't1', local(10, 9)), fire('none', 't1', local(10, 10))];
    expect(deliveryVolume(fires, local(1), local(30))).toEqual({ delivered: 2, answered: 1 });
  });

  it('is zero for an empty window', () => {
    expect(deliveryVolume([fire('acted')], local(1), local(2))).toEqual({
      delivered: 0,
      answered: 0,
    });
  });
});

describe('loadByDay', () => {
  it('sums scheduled hours per local day', () => {
    const events = [event(local(10, 9), 2), event(local(10, 14), 1), event(local(11, 9), 3)];
    const days = loadByDay(events, JLM, local(1), local(30));
    expect(days.map((day) => [day.key, day.hours])).toEqual([
      ['2026-06-10', 3],
      ['2026-06-11', 3],
    ]);
  });

  it('counts an all-day event without inventing hours for it', () => {
    // Counting it as 24 would swamp every real number; a birthday is not a day's work.
    const days = loadByDay([event(local(10), 24, { isAllDay: true })], JLM, local(1), local(30));
    expect(days[0]).toMatchObject({ hours: 0, eventCount: 1 });
  });

  it('attributes a midnight-straddling event to the day it starts', () => {
    const days = loadByDay([event(local(10, 23), 3)], JLM, local(1), local(30));
    expect(days.map((day) => day.key)).toEqual(['2026-06-10']);
    expect(days[0]?.hours).toBe(3);
  });

  it('excludes events outside the window', () => {
    const events = [event(local(1, 9), 2), event(local(10, 9), 2), event(local(25, 9), 2)];
    expect(loadByDay(events, JLM, local(5), local(20))).toHaveLength(1);
  });

  it('returns days in chronological order', () => {
    const events = [event(local(20, 9), 1), event(local(2, 9), 1), event(local(11, 9), 1)];
    expect(loadByDay(events, JLM, local(1), local(30)).map((d) => d.key)).toEqual([
      '2026-06-02',
      '2026-06-11',
      '2026-06-20',
    ]);
  });

  it('ignores a negative duration rather than subtracting from the total', () => {
    const broken = event(local(10, 9), 0);
    const days = loadByDay([{ ...broken, endAt: broken.startAt - HOUR_MS }], JLM, local(1), local(30));
    expect(days[0]?.hours).toBe(0);
  });

  it('is empty with no events', () => {
    expect(loadByDay([], JLM, local(1), local(30))).toEqual([]);
  });
});

describe('busyHours', () => {
  it('has 24 buckets', () => {
    expect(busyHours([], JLM)).toHaveLength(24);
  });

  it('buckets an event at its local start hour', () => {
    const hours = busyHours([event(local(10, 14, 30), 1)], JLM);
    expect(hours[14]).toBe(1);
    expect(hours[15]).toBe(0);
  });

  it('counts a long event once, at its start', () => {
    // The question is what time of day your life makes demands, not occupancy.
    const hours = busyHours([event(local(10, 9), 5)], JLM);
    expect(hours[9]).toBe(1);
    expect(hours[13]).toBe(0);
  });

  it('excludes all-day events, which have no hour', () => {
    expect(busyHours([event(local(10), 24, { isAllDay: true })], JLM)).toEqual(
      new Array<number>(24).fill(0),
    );
  });

  it('buckets by the given zone, not UTC', () => {
    // 22:00 UTC is 01:00 the next day in Jerusalem.
    const at = Date.UTC(2026, 5, 10, 22, 0);
    expect(busyHours([event(at, 1)], JLM)[1]).toBe(1);
    expect(busyHours([event(at, 1)], 'UTC')[22]).toBe(1);
  });
});

describe('buildAudit', () => {
  it('assembles everything from data already on the device', () => {
    const summary = buildAudit({
      fires: [fire('acted', 't1'), fire('none', 't2')],
      triggers: [trigger('t1', 'time'), trigger('t2', 'cadence')],
      events: [event(local(10, 9), 2), event(local(11, 9), 4)],
      timezone: JLM,
      from: local(1),
      to: local(30),
    });

    expect(summary.responses.delivered).toBe(2);
    expect(summary.byKind).toHaveLength(2);
    expect(summary.days).toHaveLength(2);
    expect(summary.hours[9]).toBe(2);
    expect(summary.averageHoursPerBusyDay).toBe(3);
  });

  it('has a null average when no day had scheduled hours', () => {
    const summary = buildAudit({
      fires: [],
      triggers: [],
      events: [event(local(10), 24, { isAllDay: true })],
      timezone: JLM,
      from: local(1),
      to: local(30),
    });
    expect(summary.averageHoursPerBusyDay).toBeNull();
  });

  it('is entirely empty for a fresh install', () => {
    const summary = buildAudit({
      fires: [],
      triggers: [],
      events: [],
      timezone: JLM,
      from: local(1),
      to: local(30),
    });
    expect(summary.responses.delivered).toBe(0);
    expect(summary.byKind).toEqual([]);
    expect(summary.days).toEqual([]);
    expect(summary.averageHoursPerBusyDay).toBeNull();
  });

  it('averages only over days that had something, not the whole window', () => {
    const summary = buildAudit({
      fires: [],
      triggers: [],
      events: [event(local(10, 9), 6)],
      timezone: JLM,
      from: local(1),
      to: local(30),
    });
    // One busy day of six hours, not six hours spread across a month.
    expect(summary.averageHoursPerBusyDay).toBe(6);
  });

  it('handles a window shorter than a day', () => {
    const summary = buildAudit({
      fires: [],
      triggers: [],
      events: [event(local(10, 9), 1)],
      timezone: JLM,
      from: local(10),
      to: local(10) + DAY_MS,
    });
    expect(summary.days).toHaveLength(1);
  });
});
