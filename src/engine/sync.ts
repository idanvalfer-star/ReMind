/**
 * Mirrors due triggers to the push backend, and reconciles against it on app open.
 *
 * Two things shape this module:
 *
 * 1. **The backend is not authoritative.** IndexedDB is. Every network call here is
 *    best-effort: if it fails, the local trigger is still correct and the next reconcile
 *    fixes the backend. Callers must not roll back local state because a POST failed.
 * 2. **Reconcile is a full replace, not a diff.** Since the client owns the truth, sending
 *    the whole pending set is both simpler than diffing and incapable of drifting.
 */

import type { EpochMs, Trigger } from '../db/schema';
import {
  ROUTES,
  SCHEDULE_HORIZON_DAYS,
  SIGNATURE_HEADER,
  SUBSCRIPTION_HEADER,
  TIMESTAMP_HEADER,
  signRequest,
  type ReconcileRequest,
  type ReconcileResponse,
  type ScheduleRequest,
  type ScheduledPush,
  type SubscribeRequest,
  type SubscribeResponse,
  type UnscheduleRequest,
} from '../shared/pushProtocol';
import { DAY_MS } from './time';

// ---------------------------------------------------------------- selection (pure)

/**
 * Whether a trigger should currently exist on the backend.
 *
 * Snoozed and inactive triggers are excluded, as is anything beyond the horizon — a
 * reminder set for next year gets mirrored when it comes into range, not today.
 */
export function isPushWorthy(
  trigger: Trigger,
  now: EpochMs,
  horizonMs = SCHEDULE_HORIZON_DAYS * DAY_MS,
): boolean {
  if (!trigger.active) return false;
  if (trigger.nextFireAt === null) return false;
  // Spaced-repetition triggers are a *schedule*, not a delivery. Dozens of notes can come due on one
  // day, and pushing each would spend the entire daily cap on review prompts and starve the reminders
  // the user actually set. One digest trigger carries them instead, so these stay local: they drive
  // the in-app review queue and never reach the backend.
  if (trigger.kind === 'spaced') return false;
  if (trigger.nextFireAt <= now) return false;
  if (trigger.nextFireAt > now + horizonMs) return false;
  if (trigger.snoozedUntil !== null && trigger.snoozedUntil > trigger.nextFireAt) return false;
  return true;
}

/** The complete set the backend should hold, in fire order. */
export function pendingPushes(
  triggers: readonly Trigger[],
  now: EpochMs,
  horizonMs = SCHEDULE_HORIZON_DAYS * DAY_MS,
): ScheduledPush[] {
  return triggers
    .filter((trigger) => isPushWorthy(trigger, now, horizonMs))
    .map((trigger) => ({ triggerId: trigger.id, fireAt: trigger.nextFireAt as number }))
    .sort((a, b) => a.fireAt - b.fireAt);
}

// ---------------------------------------------------------------- transport

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Optional fields spell out `| undefined` because the project runs with
 * `exactOptionalPropertyTypes`, and callers legitimately pass an explicitly undefined
 * override.
 */
export interface BackendOptions {
  /** Same-origin by default: one Worker serves both the app and the API. */
  baseUrl?: string | undefined;
  fetchImpl?: FetchLike | undefined;
  now?: (() => number) | undefined;
}

/** Credentials for a signed call. The private key is non-extractable and stays on-device. */
export interface SignedContext extends BackendOptions {
  subscriptionId: string;
  privateKey: CryptoKey;
}

export class PushBackendError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'PushBackendError';
  }
}

function resolveFetch(options: BackendOptions): FetchLike {
  const impl = options.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
  if (!impl) throw new Error('No fetch implementation available');
  return impl;
}

async function postSigned<TResponse>(
  ctx: SignedContext,
  path: string,
  payload: unknown,
): Promise<TResponse> {
  const body = JSON.stringify(payload);
  const timestamp = (ctx.now ?? Date.now)();
  const signature = await signRequest(ctx.privateKey, 'POST', path, timestamp, body);

  const response = await resolveFetch(ctx)(`${ctx.baseUrl ?? ''}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [SUBSCRIPTION_HEADER]: ctx.subscriptionId,
      [TIMESTAMP_HEADER]: String(timestamp),
      [SIGNATURE_HEADER]: signature,
    },
    body,
  });

  if (!response.ok) {
    throw new PushBackendError(response.status, path, `${path} failed: ${response.status}`);
  }
  // 204 carries no body; callers of those routes expect void.
  if (response.status === 204) return undefined as TResponse;
  return (await response.json()) as TResponse;
}

/**
 * Registers this device. The only unsigned call — it is what establishes the key that
 * signs everything else.
 */
export async function subscribe(
  request: SubscribeRequest,
  options: BackendOptions = {},
): Promise<SubscribeResponse> {
  const response = await resolveFetch(options)(`${options.baseUrl ?? ''}${ROUTES.subscribe}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    throw new PushBackendError(
      response.status,
      ROUTES.subscribe,
      `subscribe failed: ${response.status}`,
    );
  }
  return (await response.json()) as SubscribeResponse;
}

export async function schedulePushes(ctx: SignedContext, pushes: ScheduledPush[]): Promise<void> {
  if (pushes.length === 0) return;
  const request: ScheduleRequest = { pushes };
  await postSigned<void>(ctx, ROUTES.schedule, request);
}

export async function unschedulePushes(ctx: SignedContext, triggerIds: string[]): Promise<void> {
  if (triggerIds.length === 0) return;
  const request: UnscheduleRequest = { triggerIds };
  await postSigned<void>(ctx, ROUTES.unschedule, request);
}

/**
 * Replaces the backend's unsent set with `pushes` and returns what it holds afterwards, so
 * the caller can tell whether the two sides now agree.
 */
export async function reconcilePushes(
  ctx: SignedContext,
  pushes: ScheduledPush[],
): Promise<ScheduledPush[]> {
  const request: ReconcileRequest = { pushes };
  const response = await postSigned<ReconcileResponse>(ctx, ROUTES.reconcile, request);
  return response.pushes;
}

/** Erases everything the backend holds for this device. */
export async function deleteSubscription(ctx: SignedContext): Promise<void> {
  await postSigned<void>(ctx, ROUTES.unsubscribe, {});
}
