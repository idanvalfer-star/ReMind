/**
 * Registering this device for push.
 *
 * Called only from an explicit user tap, and only when `pushAvailability` says `available`. On iOS
 * a permission prompt fired at the wrong moment is not retryable, so the gating in `platform.ts`
 * is not advisory.
 *
 * The device signing keypair is generated here and its private half is **non-extractable**: it
 * exists inside IndexedDB as a `CryptoKey` that neither this code nor anything else can read out.
 * Only the public half is sent to the backend.
 */

import { db, type PushRegistration } from '../db/schema';
import { subscribe } from '../engine/sync';
import { base64UrlDecode, ROUTES, SIGNING_KEY_ALGORITHM } from '../shared/pushProtocol';

export type RegistrationOutcome =
  | { kind: 'registered' }
  | { kind: 'denied' }
  | { kind: 'failed'; reason: string };

/**
 * `applicationServerKey` must be raw bytes, not the base64url string, in every browser that
 * matters. Passing the string works in some and fails opaquely in others.
 */
function applicationServerKey(vapidPublicKey: string): Uint8Array<ArrayBuffer> {
  return base64UrlDecode(vapidPublicKey);
}

/**
 * Fetches the application server's public key.
 *
 * Read from the backend rather than baked into the client build, so the key lives in exactly one
 * place — wrangler.toml — and cannot drift between the two halves of the deployment.
 */
async function fetchVapidPublicKey(): Promise<string> {
  const response = await fetch(ROUTES.vapidPublicKey);
  if (!response.ok) throw new Error(`could not read the VAPID key: ${response.status}`);
  const { key } = (await response.json()) as { key?: string };
  if (!key) throw new Error('the backend has no VAPID public key configured');
  return key;
}

export async function registerForPush(): Promise<RegistrationOutcome> {
  // Permission first: there is no point fetching anything if the answer is no, and on iOS the
  // request must happen in the same user gesture that started this.
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { kind: 'denied' };

  try {
    const vapidPublicKey = await fetchVapidPublicKey();
    const registration = await navigator.serviceWorker.ready;

    // Reuse an existing browser subscription if there is one; re-subscribing needlessly rotates
    // the endpoint and orphans the backend row.
    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey(vapidPublicKey),
      }));

    const keys = subscription.toJSON().keys;
    if (!keys?.p256dh || !keys.auth) {
      return { kind: 'failed', reason: 'subscription is missing its keys' };
    }

    // extractable: false. The private half can never be read back out — not by us, not by
    // anything with access to the database.
    const signingKeyPair = await crypto.subtle.generateKey(SIGNING_KEY_ALGORITHM, false, [
      'sign',
      'verify',
    ]);
    const publicKeyJwk = await crypto.subtle.exportKey('jwk', signingKeyPair.publicKey);

    const { subscriptionId } = await subscribe({
      endpoint: subscription.endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      publicKeyJwk,
    });

    const record: PushRegistration = {
      id: 'singleton',
      subscriptionId,
      endpoint: subscription.endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      vapidPublicKey,
      signingKeyPair,
      registeredAt: Date.now(),
      lastReconciledAt: null,
    };
    await db.pushRegistration.put(record);

    return { kind: 'registered' };
  } catch (cause) {
    return {
      kind: 'failed',
      reason: cause instanceof Error ? cause.message : String(cause),
    };
  }
}
