/**
 * Distance on the surface of the Earth.
 *
 * There is no Geofencing API on the web and no background geolocation, so location resurfacing
 * cannot be a notification — it is a check performed when the app is opened. That makes this
 * module's only job comparing a position against a handful of pinned points, which the haversine
 * formula does to well inside the accuracy a phone's GPS reports anyway.
 *
 * Pure and unit-agnostic about time, so the interesting cases — the poles, the antimeridian, the
 * equator — are testable without a browser.
 */

import type { GeoPoint } from '../db/schema';

/** IUGG mean Earth radius. The ellipsoid's flattening is far below GPS noise at these ranges. */
const EARTH_RADIUS_M = 6_371_008.8;

/**
 * Default catchment for a pin, in metres.
 *
 * 200m is about a city block. Tighter and a phone's own position error — routinely 20-50m, worse
 * indoors and among tall buildings — would make the reminder miss while you are standing in the
 * shop. Wider and it fires while you are walking past the end of the street.
 */
export const DEFAULT_PIN_RADIUS_M = 200;

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/**
 * Great-circle distance between two points, in metres.
 *
 * `atan2` rather than `asin`, which is ill-conditioned for nearly antipodal points — irrelevant at
 * the scale this is used but free to get right.
 */
export function distanceMeters(a: GeoPoint, b: GeoPoint): number {
  const φ1 = toRadians(a.lat);
  const φ2 = toRadians(b.lat);
  const Δφ = toRadians(b.lat - a.lat);
  const Δλ = toRadians(b.lng - a.lng);

  const h =
    Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export interface Fix {
  lat: number;
  lng: number;
  /** Reported horizontal accuracy in metres, from `GeolocationCoordinates.accuracy`. */
  accuracyM: number;
}

/**
 * Whether a fix is close enough to a pin to count.
 *
 * The device's own reported accuracy is added to the pin's radius rather than ignored. A 500m fix
 * from a coarse network lookup should not be treated as proof you are anywhere in particular — and
 * the honest consequence of that is that it matches *more* pins, not fewer. Erring towards showing
 * a card the user can ignore beats staying silent while they stand in the right place.
 */
export function isNear(fix: Fix, pin: GeoPoint & { radiusM: number }): boolean {
  return distanceMeters(fix, pin) <= pin.radiusM + Math.max(0, fix.accuracyM);
}
