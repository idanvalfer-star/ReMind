import { describe, expect, it } from 'vitest';
import { pinsNear } from './nearby';
import { DEFAULT_PIN_RADIUS_M } from './geo';
import type { Trigger } from '../db/schema';

const HERE = { lat: 32.08, lng: 34.78, accuracyM: 10 };

function pin(overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: crypto.randomUUID(),
    targetType: 'entry',
    targetId: 'entry-1',
    kind: 'time',
    condition: { kind: 'time', at: 0, timezone: 'UTC' },
    nextFireAt: null,
    lastFiredAt: null,
    active: 1,
    snoozedUntil: null,
    location: { lat: 32.08, lng: 34.78, radiusM: DEFAULT_PIN_RADIUS_M },
    syncedFireAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('pinsNear', () => {
  it('returns a pin you are standing on', () => {
    expect(pinsNear([pin()], HERE)).toHaveLength(1);
  });

  it('excludes a pin out of range', () => {
    const far = pin({ location: { lat: 31.76, lng: 35.21, radiusM: DEFAULT_PIN_RADIUS_M } });
    expect(pinsNear([far], HERE)).toEqual([]);
  });

  it('excludes triggers with no location', () => {
    expect(pinsNear([pin({ location: null })], HERE)).toEqual([]);
  });

  it('excludes inactive pins', () => {
    expect(pinsNear([pin({ active: 0 })], HERE)).toEqual([]);
  });

  it('excludes a pin that is also scheduled', () => {
    // It will arrive as a push at its own time. Surfacing it because you walked past would be a
    // second delivery of one reminder.
    expect(pinsNear([pin({ nextFireAt: Date.now() + 1000 })], HERE)).toEqual([]);
  });

  it('orders by distance, closest first', () => {
    const near = pin({ location: { lat: 32.0801, lng: 34.78, radiusM: 500 } });
    const further = pin({ location: { lat: 32.0815, lng: 34.78, radiusM: 500 } });
    const result = pinsNear([further, near], HERE);
    expect(result.map((r) => r.trigger.id)).toEqual([near.id, further.id]);
    expect(result[0]!.distanceM).toBeLessThan(result[1]!.distanceM);
  });

  it('reports the distance to each pin', () => {
    const result = pinsNear([pin({ location: { lat: 32.0809, lng: 34.78, radiusM: 500 } })], HERE);
    expect(result[0]!.distanceM).toBeGreaterThan(90);
    expect(result[0]!.distanceM).toBeLessThan(110);
  });

  it('is empty for no triggers', () => {
    expect(pinsNear([], HERE)).toEqual([]);
  });

  it('honours a coarse fix by matching more, not fewer, pins', () => {
    const justOutside = pin({ location: { lat: 32.0827, lng: 34.78, radiusM: 100 } });
    expect(pinsNear([justOutside], HERE)).toEqual([]);
    expect(pinsNear([justOutside], { ...HERE, accuracyM: 400 })).toHaveLength(1);
  });
});
