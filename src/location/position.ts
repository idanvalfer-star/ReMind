/**
 * Reading the device's position, once, without ever making it someone's problem.
 *
 * Two rules shape this module, both learned from the notification-permission ordering the brief
 * spends a section on:
 *
 * 1. **Never ask unprompted.** A permission prompt on first launch, for a feature the user has not
 *    yet used, is spent for nothing — and unlike notifications there is no second chance dialog in
 *    Safari once it is dismissed. So the only caller that may trigger a *prompt* is the act of
 *    pinning a place, which is itself an explicit tap.
 * 2. **Never block.** A GPS fix can take twenty seconds indoors, or never arrive. Everything here
 *    resolves to `null` rather than hanging or throwing, because a location card failing to appear
 *    is an acceptable outcome and a stalled app is not.
 */

import type { Fix } from './geo';

/** Long enough for a warm fix, short enough that nothing waits on it visibly. */
const TIMEOUT_MS = 8_000;
/**
 * A fix from the last two minutes is fine. Location resurfacing is about which shop you are
 * standing in, and a cached fix answers that as well as a fresh one while costing no radio time.
 */
const MAX_AGE_MS = 120_000;

export type PositionOutcome =
  | { kind: 'fix'; fix: Fix }
  /** The user said no, now or previously. Nothing should ask again this session. */
  | { kind: 'denied' }
  /** No fix available: no signal, timeout, or a device without the API. */
  | { kind: 'unavailable' };

export function geolocationSupported(): boolean {
  return typeof navigator !== 'undefined' && 'geolocation' in navigator;
}

/**
 * Asks the platform where it is.
 *
 * Calling this is what shows the permission prompt the first time, so it must only ever be reached
 * from a user gesture. Later calls are silent once permission is settled either way.
 */
export function readPosition(): Promise<PositionOutcome> {
  if (!geolocationSupported()) return Promise.resolve({ kind: 'unavailable' });

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          kind: 'fix',
          fix: {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracyM: position.coords.accuracy,
          },
        }),
      (error) =>
        resolve(error.code === error.PERMISSION_DENIED ? { kind: 'denied' } : { kind: 'unavailable' }),
      { enableHighAccuracy: false, timeout: TIMEOUT_MS, maximumAge: MAX_AGE_MS },
    );
  });
}

/**
 * Whether permission is already granted, without asking for it.
 *
 * The Permissions API is what makes the "check on app open" half of the feature possible at all: it
 * distinguishes "granted, so reading the position is silent" from "not yet asked, so reading it
 * would prompt". Absent it — Safari shipped `navigator.permissions` late and its support for the
 * geolocation name has been patchy — this returns false and the check is simply skipped, leaving
 * pinning still fully functional.
 */
export async function geolocationAlreadyGranted(): Promise<boolean> {
  if (!geolocationSupported()) return false;
  if (typeof navigator.permissions?.query !== 'function') return false;
  try {
    const status = await navigator.permissions.query({ name: 'geolocation' as PermissionName });
    return status.state === 'granted';
  } catch {
    // Some engines throw on an unrecognised permission name rather than rejecting the descriptor.
    return false;
  }
}
