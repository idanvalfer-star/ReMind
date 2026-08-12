/// <reference lib="webworker" />

/**
 * The service worker. Where the privacy design pays off.
 *
 * A push arrives carrying one opaque UUID and nothing else. This code looks that id up in the
 * local database, reads the reminder it refers to, and composes the notification text
 * on-device. The server that woke us has no idea what it just caused to appear.
 *
 * The hard constraint throughout is `userVisibleOnly`. Having received a push, we *must* show
 * a notification — iOS cancels the subscription outright for a service worker that receives
 * one and shows nothing, which would silently disable reminders for good. So every path here
 * ends in `showNotification`, and the fallback path is treated as a normal outcome rather
 * than an error: iOS evicts IndexedDB, and when it does, a push will arrive for data that no
 * longer exists.
 */

import { precacheAndRoute } from 'workbox-precaching';
import { db, type Entry, type Event, type Trigger } from './db/schema';
import { loadSettings } from './db/settings';
import { composeNotification, type NotificationTarget } from './engine/notify';
import { recordFire, recordResponse } from './engine/log';
import { pendingPushes, reconcilePushes, subscribe } from './engine/sync';
import { createTranslator } from './i18n/resources';
import type { PushPayload } from './shared/pushProtocol';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

precacheAndRoute(self.__WB_MANIFEST);

// Take over promptly so a freshly installed app can receive a push without a second launch.
self.addEventListener('install', () => {
  void self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// ---------------------------------------------------------------- push

function parseTriggerId(event: PushEvent): string | null {
  if (!event.data) return null;
  try {
    const payload = event.data.json() as PushPayload;
    return typeof payload?.t === 'string' && payload.t.length > 0 ? payload.t : null;
  } catch {
    return null;
  }
}

/** Reads whatever the trigger points at, or reports that it is gone. */
async function resolveTarget(trigger: Trigger): Promise<NotificationTarget> {
  switch (trigger.targetType) {
    case 'event': {
      const event: Event | undefined = await db.events.get(trigger.targetId);
      return event ? { type: 'event', event } : { type: 'unknown' };
    }
    case 'entry': {
      const entry: Entry | undefined = await db.entries.get(trigger.targetId);
      return entry ? { type: 'entry', entry } : { type: 'unknown' };
    }
    default:
      // Later phases add person- and trip-targeted triggers; until then anything else is
      // unexpected and gets the generic treatment rather than crashing the handler.
      return { type: 'unknown' };
  }
}

/**
 * Shows the generic notification.
 *
 * Reached when the payload is unreadable, the trigger is unknown, or anything at all throws.
 * The locale is best-effort: if settings cannot be read either, `navigator.language` is all
 * there is to go on.
 */
async function showFallback(triggerId: string | null): Promise<void> {
  let locale: 'en' | 'he' = navigator.language?.toLowerCase().startsWith('he') ? 'he' : 'en';
  try {
    locale = (await loadSettings()).locale;
  } catch {
    // Storage is unavailable — which is very likely why we are here at all.
  }

  const t = createTranslator(locale);
  await self.registration.showNotification(t('notify.fallback.title'), {
    body: t('notify.fallback.body'),
    tag: triggerId ?? 'remind-fallback',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { triggerId },
  });

  if (triggerId) {
    try {
      await recordFire({ triggerId, deliveredVia: 'push', lookupFailed: true });
    } catch {
      // Nothing to be done: if the log is unwritable the notification still showed, which is
      // the part that matters.
    }
  }
}

async function handlePush(event: PushEvent): Promise<void> {
  const triggerId = parseTriggerId(event);
  if (!triggerId) return showFallback(null);

  try {
    const trigger = await db.triggers.get(triggerId);
    if (!trigger) return showFallback(triggerId);

    const target = await resolveTarget(trigger);
    const settings = await loadSettings();
    const content = composeNotification({
      trigger,
      target,
      t: createTranslator(settings.locale),
      locale: settings.locale,
    });

    await self.registration.showNotification(content.title, {
      body: content.body,
      tag: content.tag,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      // Carried so notificationclick can attribute the response without another lookup.
      data: { triggerId },
    });

    const now = Date.now();
    await Promise.all([
      recordFire({
        triggerId,
        deliveredVia: 'push',
        lookupFailed: target.type === 'unknown',
        at: now,
      }),
      // Fired, so no longer scheduled — but still active, so a snooze can re-arm it.
      db.triggers.update(triggerId, {
        lastFiredAt: now,
        nextFireAt: null,
        syncedFireAt: null,
        updatedAt: now,
      }),
    ]);
  } catch (cause) {
    console.error('push handling failed; showing the generic notification', cause);
    await showFallback(triggerId);
  }
}

self.addEventListener('push', (event) => {
  // waitUntil is not optional: without it the worker may be killed before the notification
  // is shown, which iOS treats as showing nothing.
  event.waitUntil(handlePush(event));
});

// ---------------------------------------------------------------- interaction

/** Focuses an existing window if there is one, otherwise opens the app. */
async function openApp(): Promise<void> {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clients) {
    if ('focus' in client) {
      await client.focus();
      return;
    }
  }
  await self.clients.openWindow('/');
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const triggerId = (event.notification.data as { triggerId?: string } | null)?.triggerId;

  event.waitUntil(
    (async () => {
      if (triggerId) {
        // Opening the app counts as acting on it. The Today section is what they land on.
        await recordResponse(triggerId, 'acted').catch(() => undefined);
      }
      await openApp();
    })(),
  );
});

self.addEventListener('notificationclose', (event) => {
  const triggerId = (event.notification.data as { triggerId?: string } | null)?.triggerId;
  if (!triggerId) return;
  event.waitUntil(recordResponse(triggerId, 'dismissed').catch(() => undefined));
});

// ---------------------------------------------------------------- subscription rotation

/**
 * Re-subscribes when the browser rotates or drops the push subscription.
 *
 * Not a theoretical case: iOS is known to unsubscribe home-screen web apps spontaneously, and
 * without this the device goes quiet permanently with no visible symptom. The signing keypair
 * is reused, so the backend recognises the device; only the endpoint changes.
 */
async function handleSubscriptionChange(): Promise<void> {
  const registration = await db.pushRegistration.get('singleton');
  if (!registration) return;

  const fresh = await self.registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: registration.vapidPublicKey,
  });

  const keys = fresh.toJSON().keys;
  if (!keys?.p256dh || !keys.auth) return;

  const publicKeyJwk = await crypto.subtle.exportKey(
    'jwk',
    registration.signingKeyPair.publicKey,
  );
  const { subscriptionId } = await subscribe({
    endpoint: fresh.endpoint,
    p256dh: keys.p256dh,
    auth: keys.auth,
    publicKeyJwk,
  });

  await db.pushRegistration.put({
    ...registration,
    subscriptionId,
    endpoint: fresh.endpoint,
    p256dh: keys.p256dh,
    auth: keys.auth,
  });

  // The new subscription starts with an empty schedule, so everything pending must be
  // re-sent or those reminders would simply never arrive.
  const triggers = await db.triggers.toArray();
  await reconcilePushes(
    { subscriptionId, privateKey: registration.signingKeyPair.privateKey },
    pendingPushes(triggers, Date.now()),
  );
}

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    handleSubscriptionChange().catch((cause) => {
      console.error('failed to re-subscribe after subscription change', cause);
    }),
  );
});

