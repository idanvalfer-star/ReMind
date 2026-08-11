/**
 * Delivers one push message to one subscription.
 *
 * Wraps encryption and VAPID signing, then interprets the push service's response — which
 * matters more than it looks, because a `404`/`410` is the only signal we ever get that a
 * subscription is dead, and failing to act on it means retrying that row forever.
 */

import { base64UrlDecode } from '../../src/shared/pushProtocol';
import { encryptPayload } from './encrypt';
import { vapidAuthorization } from './vapid';

/**
 * How long the push service should hold a message for an offline device.
 *
 * Four hours is a compromise: long enough to survive a flat battery or a tunnel, short
 * enough that a reminder does not surface half a day late. A stale reminder is not a
 * neutral event — it trains the user to ignore the app.
 */
export const DEFAULT_TTL_SECONDS = 4 * 60 * 60;

export interface VapidCredentials {
  subject: string;
  publicKey: string;
  privateKey: string;
}

export interface SendPushInput {
  endpoint: string;
  /** Base64url, from the subscription. */
  p256dh: string;
  /** Base64url, from the subscription. */
  auth: string;
  /** Serialised payload. For ReMind, a JSON object holding one opaque UUID. */
  payload: string;
  vapid: VapidCredentials;
  ttlSeconds?: number | undefined;
  fetchImpl?: ((input: string, init?: RequestInit) => Promise<Response>) | undefined;
  now?: number | undefined;
}

export interface SendPushResult {
  ok: boolean;
  status: number;
  /**
   * True when the push service says this subscription no longer exists. The caller must
   * delete it — the browser has already forgotten it, and retrying cannot succeed.
   */
  gone: boolean;
  /** True for conditions that may succeed later, such as rate limiting or a 5xx. */
  retryable: boolean;
  error?: string | undefined;
}

/** 404 Not Found and 410 Gone both mean the subscription is finished. */
function isGone(status: number): boolean {
  return status === 404 || status === 410;
}

function isRetryable(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

export async function sendPush({
  endpoint,
  p256dh,
  auth,
  payload,
  vapid,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  fetchImpl = fetch,
  now,
}: SendPushInput): Promise<SendPushResult> {
  // Explicitly ArrayBuffer-backed: `BodyInit` will not accept a view that might sit on a
  // SharedArrayBuffer, and the bare `Uint8Array` alias no longer implies which it is.
  let body: Uint8Array<ArrayBuffer>;
  let authorization: string;
  try {
    body = await encryptPayload({
      payload: new TextEncoder().encode(payload),
      uaPublicKey: base64UrlDecode(p256dh),
      authSecret: base64UrlDecode(auth),
    });
    authorization = await vapidAuthorization({
      endpoint,
      subject: vapid.subject,
      publicKey: vapid.publicKey,
      privateKey: vapid.privateKey,
      now,
    });
  } catch (cause) {
    // Malformed key material or a bad VAPID subject. Not retryable and not the
    // subscription's fault — a misconfiguration that will fail identically next minute.
    return {
      ok: false,
      status: 0,
      gone: false,
      retryable: false,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        authorization,
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: String(ttlSeconds),
        // Reminders are worth waking a dozing radio for, but not worth the battery cost of
        // `high`, which is reserved for calls and messages.
        urgency: 'normal',
      },
      body,
    });
  } catch (cause) {
    // Network failure reaching the push service. Worth another attempt.
    return {
      ok: false,
      status: 0,
      gone: false,
      retryable: true,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }

  if (response.ok) {
    return { ok: true, status: response.status, gone: false, retryable: false };
  }

  return {
    ok: false,
    status: response.status,
    gone: isGone(response.status),
    retryable: isRetryable(response.status),
    error: `push service returned ${response.status}`,
  };
}
