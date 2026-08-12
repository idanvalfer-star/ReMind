/**
 * The ReMind push backend.
 *
 * One Worker serves three jobs: the SPA's static assets (handled by the platform, not by
 * this code), a small signed API for registering triggers, and a once-a-minute cron that
 * sends the pushes that have come due.
 *
 * It knows nothing about what any reminder says. A row here is a subscription and a list of
 * `(opaque uuid, timestamp)` pairs; the push payload is that uuid and nothing else, and the
 * words the user reads are composed on their device. See PRIVACY.md.
 */

// Imported by name rather than installed as global `types`, so the DOM lib's WebCrypto
// declarations stay intact — see the note in tsconfig.worker.json.
import type {
  D1Database,
  D1PreparedStatement,
  ScheduledController,
} from '@cloudflare/workers-types';
import {
  MAX_CLOCK_SKEW_MS,
  ROUTES,
  SIGNATURE_HEADER,
  SUBSCRIPTION_HEADER,
  TIMESTAMP_HEADER,
  verifyRequest,
  type PushPayload,
  type ReconcileRequest,
  type ReconcileResponse,
  type ScheduleRequest,
  type ScheduledPush,
  type SubscribeRequest,
  type SubscribeResponse,
  type UnscheduleRequest,
} from '../src/shared/pushProtocol';
import { isAllowedPushEndpoint } from './pushEndpoint';
import { sendPush } from './push/send';

export interface Env {
  DB: D1Database;
  VAPID_PUBLIC_KEY: string;
  VAPID_SUBJECT: string;
  /** Set with `wrangler secret put VAPID_PRIVATE_KEY`, never in wrangler.toml. */
  VAPID_PRIVATE_KEY: string;
}

/**
 * Pushes attempted per cron tick.
 *
 * The free plan allows 50 subrequests per invocation and each push is one, so this leaves
 * headroom for the D1 round trips. Anything not sent this minute is picked up by the next
 * tick, which for a personal app with a daily cap in single digits will never happen.
 */
const MAX_PUSHES_PER_TICK = 40;

/** Give up after this many failed attempts rather than retrying a row forever. */
const MAX_SEND_ATTEMPTS = 5;

/** Bound on a reconcile payload, so a malformed client cannot ask us to store the world. */
const MAX_PUSHES_PER_REQUEST = 500;

/**
 * How an existing row is updated when the client re-arms a trigger it already knows about.
 *
 * The subtlety is `sent_at`. A trigger that has already been delivered and then *snoozed*
 * comes back with the same id and a later time, and it must fire again — so a strictly later
 * `fire_at` clears `sent_at` and re-arms the row. A time that is the same or earlier does
 * not, which keeps a repeated or replayed request from resurrecting a push that has already
 * gone out.
 */
const REARM_ON_CONFLICT = `
  ON CONFLICT(subscription_id, trigger_id) DO UPDATE SET
    fire_at = excluded.fire_at,
    attempts = 0,
    sent_at = CASE
      WHEN excluded.fire_at > scheduled_pushes.fire_at THEN NULL
      ELSE scheduled_pushes.sent_at
    END`;

// ---------------------------------------------------------------- helpers

function json<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function problem(status: number, detail: string): Response {
  return json({ error: detail }, status);
}

function isUuidLike(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64;
}

function isValidPush(value: unknown): value is ScheduledPush {
  if (typeof value !== 'object' || value === null) return false;
  const push = value as Partial<ScheduledPush>;
  return isUuidLike(push.triggerId) && typeof push.fireAt === 'number' && Number.isFinite(push.fireAt);
}

interface AuthenticatedRequest {
  subscriptionId: string;
  body: string;
}

/**
 * Verifies a signed request against the device public key stored at subscribe time.
 *
 * Returns a `Response` on failure so callers can hand it straight back. Every rejection is
 * a bare 401 with no detail about which check failed — this endpoint is on the open
 * internet and there is nothing to gain from helping a prober.
 */
async function authenticate(
  request: Request,
  env: Env,
  path: string,
  now: number,
): Promise<AuthenticatedRequest | Response> {
  const subscriptionId = request.headers.get(SUBSCRIPTION_HEADER);
  const timestampHeader = request.headers.get(TIMESTAMP_HEADER);
  const signature = request.headers.get(SIGNATURE_HEADER);
  if (!subscriptionId || !timestampHeader || !signature) return problem(401, 'unauthorized');

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > MAX_CLOCK_SKEW_MS) {
    return problem(401, 'unauthorized');
  }

  const row = await env.DB.prepare('SELECT device_pubkey FROM subscriptions WHERE id = ?')
    .bind(subscriptionId)
    .first<{ device_pubkey: string }>();
  if (!row) return problem(401, 'unauthorized');

  let publicKeyJwk: JsonWebKey;
  try {
    publicKeyJwk = JSON.parse(row.device_pubkey) as JsonWebKey;
  } catch {
    return problem(401, 'unauthorized');
  }

  const body = await request.text();
  const valid = await verifyRequest(
    publicKeyJwk,
    signature,
    request.method,
    path,
    timestamp,
    body,
    now,
  );
  if (!valid) return problem(401, 'unauthorized');

  return { subscriptionId, body };
}

function parseJson<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- routes

/**
 * Registers a device. The only unauthenticated route — it establishes the key that signs
 * every other one.
 *
 * Re-subscribing with an endpoint we already know updates that row in place, including its
 * signing key. That is deliberate: a push subscription lives in the service worker
 * registration while the signing key lives in IndexedDB, so iOS evicting storage can leave
 * a device holding a valid endpoint and no key. Refusing the overwrite would leave it
 * permanently unable to schedule anything. The tradeoff is that whoever knows an endpoint
 * can take over its row — acceptable only because an endpoint is high-entropy and known
 * just to the device and this Worker. Noted in PRIVACY.md.
 */
async function handleSubscribe(request: Request, env: Env, now: number): Promise<Response> {
  const payload = parseJson<SubscribeRequest>(await request.text());
  if (!payload) return problem(400, 'malformed body');

  const { endpoint, p256dh, auth, publicKeyJwk } = payload;
  if (typeof endpoint !== 'string' || !isAllowedPushEndpoint(endpoint)) {
    return problem(400, 'endpoint is not a recognised push service');
  }
  if (typeof p256dh !== 'string' || typeof auth !== 'string' || !p256dh || !auth) {
    return problem(400, 'missing subscription keys');
  }
  if (typeof publicKeyJwk !== 'object' || publicKeyJwk === null) {
    return problem(400, 'missing device public key');
  }

  const existing = await env.DB.prepare('SELECT id FROM subscriptions WHERE endpoint = ?')
    .bind(endpoint)
    .first<{ id: string }>();

  const subscriptionId = existing?.id ?? crypto.randomUUID();
  const deviceKey = JSON.stringify(publicKeyJwk);

  await env.DB.prepare(
    `INSERT INTO subscriptions
       (id, endpoint, p256dh, auth, device_pubkey, created_at, last_seen_at, failure_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(endpoint) DO UPDATE SET
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       device_pubkey = excluded.device_pubkey,
       last_seen_at = excluded.last_seen_at,
       failure_count = 0`,
  )
    .bind(subscriptionId, endpoint, p256dh, auth, deviceKey, now, now)
    .run();

  return json<SubscribeResponse>({ subscriptionId });
}

/** Adds or re-arms pending pushes. */
async function handleSchedule(
  env: Env,
  subscriptionId: string,
  body: string,
  now: number,
): Promise<Response> {
  const payload = parseJson<ScheduleRequest>(body);
  if (!payload || !Array.isArray(payload.pushes)) return problem(400, 'malformed body');
  if (payload.pushes.length > MAX_PUSHES_PER_REQUEST) return problem(413, 'too many pushes');
  if (!payload.pushes.every(isValidPush)) return problem(400, 'malformed push');

  const statements = payload.pushes.map((push) =>
    env.DB.prepare(
      `INSERT INTO scheduled_pushes (subscription_id, trigger_id, fire_at, attempts, sent_at)
       VALUES (?, ?, ?, 0, NULL)
       ${REARM_ON_CONFLICT}`,
    ).bind(subscriptionId, push.triggerId, push.fireAt),
  );
  statements.push(
    env.DB.prepare('UPDATE subscriptions SET last_seen_at = ? WHERE id = ?').bind(
      now,
      subscriptionId,
    ),
  );
  await env.DB.batch(statements);

  return new Response(null, { status: 204 });
}

async function handleUnschedule(
  env: Env,
  subscriptionId: string,
  body: string,
): Promise<Response> {
  const payload = parseJson<UnscheduleRequest>(body);
  if (!payload || !Array.isArray(payload.triggerIds)) return problem(400, 'malformed body');
  if (payload.triggerIds.length > MAX_PUSHES_PER_REQUEST) return problem(413, 'too many ids');
  if (!payload.triggerIds.every(isUuidLike)) return problem(400, 'malformed id');

  await env.DB.batch(
    payload.triggerIds.map((triggerId) =>
      env.DB.prepare(
        'DELETE FROM scheduled_pushes WHERE subscription_id = ? AND trigger_id = ?',
      ).bind(subscriptionId, triggerId),
    ),
  );

  return new Response(null, { status: 204 });
}

/**
 * Replaces this device's pending set wholesale and reports what is held afterwards.
 *
 * A full replace rather than a diff, because the device's IndexedDB is the source of truth:
 * whatever it sends *is* the correct state, so there is no merge to get wrong.
 *
 * Only *pending* rows are cleared. Already-sent rows survive as history and are re-armed
 * only if the client now wants a strictly later time — see REARM_ON_CONFLICT. That is what
 * lets a snooze work while stopping a repeated reconcile from re-delivering yesterday's
 * reminders.
 */
async function handleReconcile(
  env: Env,
  subscriptionId: string,
  body: string,
  now: number,
): Promise<Response> {
  const payload = parseJson<ReconcileRequest>(body);
  if (!payload || !Array.isArray(payload.pushes)) return problem(400, 'malformed body');
  if (payload.pushes.length > MAX_PUSHES_PER_REQUEST) return problem(413, 'too many pushes');
  if (!payload.pushes.every(isValidPush)) return problem(400, 'malformed push');

  const statements = [
    env.DB.prepare(
      'DELETE FROM scheduled_pushes WHERE subscription_id = ? AND sent_at IS NULL',
    ).bind(subscriptionId),
    ...payload.pushes.map((push) =>
      env.DB.prepare(
        `INSERT INTO scheduled_pushes (subscription_id, trigger_id, fire_at, attempts, sent_at)
         VALUES (?, ?, ?, 0, NULL)
         ${REARM_ON_CONFLICT}`,
      ).bind(subscriptionId, push.triggerId, push.fireAt),
    ),
    env.DB.prepare('UPDATE subscriptions SET last_seen_at = ? WHERE id = ?').bind(
      now,
      subscriptionId,
    ),
  ];
  await env.DB.batch(statements);

  const held = await env.DB.prepare(
    `SELECT trigger_id, fire_at FROM scheduled_pushes
     WHERE subscription_id = ? AND sent_at IS NULL ORDER BY fire_at`,
  )
    .bind(subscriptionId)
    .all<{ trigger_id: string; fire_at: number }>();

  return json<ReconcileResponse>({
    pushes: held.results.map((row) => ({ triggerId: row.trigger_id, fireAt: row.fire_at })),
  });
}

/** Erases everything for this device. The cascade takes the scheduled rows with it. */
async function handleUnsubscribe(env: Env, subscriptionId: string): Promise<Response> {
  await env.DB.prepare('DELETE FROM subscriptions WHERE id = ?').bind(subscriptionId).run();
  return new Response(null, { status: 204 });
}

// ---------------------------------------------------------------- cron

interface DueRow {
  trigger_id: string;
  subscription_id: string;
  attempts: number;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * Sends every push that has come due.
 *
 * Runs once a minute: 1,440 invocations a day against a 100,000/day free-tier ceiling.
 */
export async function deliverDuePushes(env: Env, now: number): Promise<void> {
  const due = await env.DB.prepare(
    `SELECT p.trigger_id, p.subscription_id, p.attempts, s.endpoint, s.p256dh, s.auth
       FROM scheduled_pushes p
       JOIN subscriptions s ON s.id = p.subscription_id
      WHERE p.sent_at IS NULL AND p.fire_at <= ?
      ORDER BY p.fire_at
      LIMIT ?`,
  )
    .bind(now, MAX_PUSHES_PER_TICK)
    .all<DueRow>();

  if (due.results.length === 0) return;

  const vapid = {
    subject: env.VAPID_SUBJECT,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  };

  const followUp: D1PreparedStatement[] = [];
  const deadSubscriptions = new Set<string>();

  for (const row of due.results) {
    // The entire payload: one opaque id. Meaningless without the device's local database.
    const payload: PushPayload = { t: row.trigger_id };

    const result = await sendPush({
      endpoint: row.endpoint,
      p256dh: row.p256dh,
      auth: row.auth,
      payload: JSON.stringify(payload),
      vapid,
      now,
    });

    if (result.ok) {
      followUp.push(
        env.DB.prepare(
          'UPDATE scheduled_pushes SET sent_at = ?, attempts = attempts + 1 WHERE subscription_id = ? AND trigger_id = ?',
        ).bind(now, row.subscription_id, row.trigger_id),
      );
      continue;
    }

    if (result.gone) {
      // The browser has already forgotten this subscription; retrying cannot work.
      deadSubscriptions.add(row.subscription_id);
      continue;
    }

    const attempts = row.attempts + 1;
    if (result.retryable && attempts < MAX_SEND_ATTEMPTS) {
      followUp.push(
        env.DB.prepare(
          'UPDATE scheduled_pushes SET attempts = ? WHERE subscription_id = ? AND trigger_id = ?',
        ).bind(attempts, row.subscription_id, row.trigger_id),
      );
    } else {
      // Out of attempts, or a permanent failure such as a misconfigured VAPID subject.
      // Marked sent so it stops consuming a slot every minute forever; the reminder still
      // exists on the device and will surface there.
      followUp.push(
        env.DB.prepare(
          'UPDATE scheduled_pushes SET sent_at = ?, attempts = ? WHERE subscription_id = ? AND trigger_id = ?',
        ).bind(now, attempts, row.subscription_id, row.trigger_id),
      );
      console.error(
        `giving up on trigger after ${attempts} attempts: status=${result.status} ${result.error ?? ''}`,
      );
    }
  }

  for (const subscriptionId of deadSubscriptions) {
    followUp.push(
      env.DB.prepare('DELETE FROM subscriptions WHERE id = ?').bind(subscriptionId),
    );
  }

  if (followUp.length > 0) await env.DB.batch(followUp);
}

// ---------------------------------------------------------------- entry point

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const now = Date.now();

    // Only /api/* is routed here by wrangler.toml's run_worker_first. Anything else that
    // reaches this Worker is a non-navigation request for an asset that does not exist;
    // SPA deep links are served index.html by the platform and never arrive.
    if (!path.startsWith('/api/')) return problem(404, 'not found');

    // The VAPID public key is handed to the browser at subscribe time anyway, so serving it is
    // not a disclosure. Doing so keeps wrangler.toml the single source of truth for it.
    if (path === ROUTES.vapidPublicKey) {
      if (request.method !== 'GET') {
        return new Response(null, { status: 405, headers: { allow: 'GET' } });
      }
      return json({ key: env.VAPID_PUBLIC_KEY });
    }

    if (request.method !== 'POST') {
      return new Response(null, { status: 405, headers: { allow: 'POST' } });
    }

    if (path === ROUTES.subscribe) return handleSubscribe(request, env, now);

    const authenticated = await authenticate(request, env, path, now);
    if (authenticated instanceof Response) return authenticated;
    const { subscriptionId, body } = authenticated;

    switch (path) {
      case ROUTES.schedule:
        return handleSchedule(env, subscriptionId, body, now);
      case ROUTES.unschedule:
        return handleUnschedule(env, subscriptionId, body);
      case ROUTES.reconcile:
        return handleReconcile(env, subscriptionId, body, now);
      case ROUTES.unsubscribe:
        return handleUnsubscribe(env, subscriptionId);
      default:
        return problem(404, 'not found');
    }
  },

  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await deliverDuePushes(env, Date.now());
  },
};
