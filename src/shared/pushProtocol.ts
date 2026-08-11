/**
 * The contract between the app and the push backend.
 *
 * Imported by **both** `src/engine/sync.ts` and `worker/`, deliberately: request signing
 * fails in ways that are miserable to debug, and almost always because the two sides
 * canonicalise the request slightly differently. Sharing the code makes that impossible.
 *
 * What crosses the wire, and nothing else:
 *
 * - the push subscription (endpoint plus the `p256dh`/`auth` key material, which RFC 8291
 *   requires server-side to encrypt a payload),
 * - opaque trigger UUIDs,
 * - the instants they should fire at.
 *
 * No titles, no bodies, no names, no locations, no timezone, no locale, no trigger kinds.
 * See PRIVACY.md, including the part where `fireAt` is honestly acknowledged as timing
 * metadata rather than claimed to be nothing.
 */

export const PROTOCOL_VERSION = 1;

export const SUBSCRIPTION_HEADER = 'x-remind-subscription';
export const TIMESTAMP_HEADER = 'x-remind-timestamp';
export const SIGNATURE_HEADER = 'x-remind-signature';

/** Replay window for a signed request. Generous enough for a phone with a lazy clock. */
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * Only triggers due within this many days are mirrored to the backend. Bounds the
 * reconcile payload, and a reminder set for next year does not need to be on a server
 * today — it will be pushed there long before it fires.
 */
export const SCHEDULE_HORIZON_DAYS = 30;

/** Per-device signing key. Non-extractable, so the private half never leaves the device. */
export const SIGNING_KEY_ALGORITHM: EcKeyGenParams = { name: 'ECDSA', namedCurve: 'P-256' };
export const SIGNING_ALGORITHM: EcdsaParams = { name: 'ECDSA', hash: 'SHA-256' };

// ---------------------------------------------------------------- routes

/**
 * Every route is POST, including `unsubscribe`. Uniformity matters more than REST
 * aesthetics here: the HTTP method is part of the signed canonical string, and one shape
 * for all signed calls removes a whole category of signature mismatch.
 */
export const ROUTES = {
  subscribe: '/api/subscribe',
  schedule: '/api/schedule',
  unschedule: '/api/unschedule',
  reconcile: '/api/reconcile',
  unsubscribe: '/api/unsubscribe',
} as const;

// ---------------------------------------------------------------- payloads

/** A trigger the backend should push at a given time. The whole of what it learns. */
export interface ScheduledPush {
  triggerId: string;
  fireAt: number;
}

/**
 * The only unsigned request: it is what establishes the key that signs the rest.
 * The public half of the device keypair is presented here and stored against the row.
 */
export interface SubscribeRequest {
  endpoint: string;
  p256dh: string;
  auth: string;
  publicKeyJwk: JsonWebKey;
}

export interface SubscribeResponse {
  subscriptionId: string;
}

export interface ScheduleRequest {
  pushes: ScheduledPush[];
}

export interface UnscheduleRequest {
  triggerIds: string[];
}

/** Full replace of the unsent set. The device's IndexedDB is the source of truth. */
export interface ReconcileRequest {
  pushes: ScheduledPush[];
}

export interface ReconcileResponse {
  /** What the backend holds after the replace, so the client can detect drift. */
  pushes: ScheduledPush[];
}

/**
 * The entire push body. One opaque id — the service worker looks it up locally and
 * composes the notification text on-device.
 */
export interface PushPayload {
  t: string;
}

// ---------------------------------------------------------------- signing

const encoder = new TextEncoder();

export function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Returns `Uint8Array<ArrayBuffer>` rather than the default `Uint8Array<ArrayBufferLike>`:
 * WebCrypto's `BufferSource` will not accept a view that might be backed by a
 * `SharedArrayBuffer`, so the buffer is allocated explicitly.
 */
export function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * The exact bytes both sides sign and verify.
 *
 * Newline-delimited and includes the protocol version, so a future change to the scheme
 * cannot be mistaken for a valid signature under the old one. The body is hashed rather
 * than included so this stays a fixed size.
 */
export async function canonicalRequest(
  method: string,
  path: string,
  timestamp: number,
  body: string,
): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(body));
  return [PROTOCOL_VERSION, method.toUpperCase(), path, timestamp, base64UrlEncode(digest)].join(
    '\n',
  );
}

/** Signs a request with the device's private key. */
export async function signRequest(
  privateKey: CryptoKey,
  method: string,
  path: string,
  timestamp: number,
  body: string,
): Promise<string> {
  const canonical = await canonicalRequest(method, path, timestamp, body);
  const signature = await crypto.subtle.sign(
    SIGNING_ALGORITHM,
    privateKey,
    encoder.encode(canonical),
  );
  return base64UrlEncode(signature);
}

/**
 * Verifies a signed request. Returns false rather than throwing on malformed input —
 * this runs on untrusted data from the open internet.
 */
export async function verifyRequest(
  publicKeyJwk: JsonWebKey,
  signature: string,
  method: string,
  path: string,
  timestamp: number,
  body: string,
  now: number,
): Promise<boolean> {
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(now - timestamp) > MAX_CLOCK_SKEW_MS) return false;

  try {
    const key = await crypto.subtle.importKey('jwk', publicKeyJwk, SIGNING_KEY_ALGORITHM, false, [
      'verify',
    ]);
    const canonical = await canonicalRequest(method, path, timestamp, body);
    return await crypto.subtle.verify(
      SIGNING_ALGORITHM,
      key,
      base64UrlDecode(signature),
      encoder.encode(canonical),
    );
  } catch {
    return false;
  }
}
