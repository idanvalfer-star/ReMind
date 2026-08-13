import { describe, expect, it } from 'vitest';
import { DEFAULT_PIN_RADIUS_M, distanceMeters, isNear } from './geo';

describe('distanceMeters', () => {
  it('is zero for the same point', () => {
    expect(distanceMeters({ lat: 32.08, lng: 34.78 }, { lat: 32.08, lng: 34.78 })).toBe(0);
  });

  it('is symmetric', () => {
    const a = { lat: 32.0853, lng: 34.7818 };
    const b = { lat: 31.7683, lng: 35.2137 };
    expect(distanceMeters(a, b)).toBeCloseTo(distanceMeters(b, a), 6);
  });

  it('matches a known distance: Tel Aviv to Jerusalem is about 54 km', () => {
    const d = distanceMeters({ lat: 32.0853, lng: 34.7818 }, { lat: 31.7683, lng: 35.2137 });
    expect(d).toBeGreaterThan(53_000);
    expect(d).toBeLessThan(56_000);
  });

  it('matches a known short distance: one degree of latitude is about 111 km', () => {
    const d = distanceMeters({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
    expect(d).toBeGreaterThan(111_000);
    expect(d).toBeLessThan(111_400);
  });

  it('has longitude shrink with latitude', () => {
    // A degree of longitude is ~111 km at the equator and ~half that at 60° north. Getting this
    // wrong is the classic bug of treating lat/lng as a flat plane.
    const atEquator = distanceMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 1 });
    const atSixty = distanceMeters({ lat: 60, lng: 0 }, { lat: 60, lng: 1 });
    expect(atSixty / atEquator).toBeCloseTo(0.5, 2);
  });

  it('works across the antimeridian rather than going the long way round', () => {
    const d = distanceMeters({ lat: 0, lng: 179.9 }, { lat: 0, lng: -179.9 });
    // Two tenths of a degree at the equator, not 359.8 degrees.
    expect(d).toBeLessThan(23_000);
  });

  it('handles antipodal points without losing precision', () => {
    const d = distanceMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 180 });
    expect(d).toBeCloseTo(Math.PI * 6_371_008.8, 0);
  });

  it('measures small city distances sensibly', () => {
    // Roughly 100 m north.
    const d = distanceMeters({ lat: 32.08, lng: 34.78 }, { lat: 32.0809, lng: 34.78 });
    expect(d).toBeGreaterThan(90);
    expect(d).toBeLessThan(110);
  });
});

describe('isNear', () => {
  const pin = { lat: 32.08, lng: 34.78, radiusM: DEFAULT_PIN_RADIUS_M };

  it('is true standing on the pin with a good fix', () => {
    expect(isNear({ lat: 32.08, lng: 34.78, accuracyM: 10 }, pin)).toBe(true);
  });

  it('is false a kilometre away with a good fix', () => {
    expect(isNear({ lat: 32.089, lng: 34.78, accuracyM: 10 }, pin)).toBe(false);
  });

  it('lets a coarse fix match a pin just outside the radius', () => {
    // 300 m away with a 400 m fix: the device is not claiming to know where it is to better than
    // that, so refusing to match would be pretending to a precision we do not have.
    const fix = { lat: 32.0827, lng: 34.78, accuracyM: 400 };
    expect(isNear({ ...fix, accuracyM: 10 }, pin)).toBe(false);
    expect(isNear(fix, pin)).toBe(true);
  });

  it('ignores a nonsensical negative accuracy instead of shrinking the radius', () => {
    const justInside = { lat: 32.0817, lng: 34.78, accuracyM: -1000 };
    expect(isNear(justInside, pin)).toBe(true);
  });

  it('respects a per-pin radius', () => {
    const tight = { lat: 32.08, lng: 34.78, radiusM: 50 };
    const fix = { lat: 32.0809, lng: 34.78, accuracyM: 0 }; // ~100 m
    expect(isNear(fix, tight)).toBe(false);
    expect(isNear(fix, pin)).toBe(true);
  });
});
