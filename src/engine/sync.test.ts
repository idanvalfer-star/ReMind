import { describe, expect, it, vi } from 'vitest';
import type { Trigger } from '../db/schema';
import {
  SCHEDULE_HORIZON_DAYS,
  SIGNATURE_HEADER,
  SUBSCRIPTION_HEADER,
  TIMESTAMP_HEADER,
  SIGNING_KEY_ALGORITHM,
  verifyRequest,
} from '../shared/pushProtocol';
import {
  isPushWorthy,
  pendingPushes,
  PushBackendError,
  reconcilePushes,
  schedulePushes,
  subscribe,
  type SignedContext,
} from './sync';
import { DAY_MS } from './time';

const NOW = Date.UTC(2026, 5, 10, 12, 0);

function makeTrigger(overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: crypto.randomUUID(),
    targetType: 'event',
    targetId: 'e1',
    kind: 'time',
    condition: { kind: 'time', at: NOW + DAY_MS, timezone: 'UTC' },
    nextFireAt: NOW + DAY_MS,
    lastFiredAt: null,
    active: 1,
    snoozedUntil: null,
    location: null,
    syncedFireAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('isPushWorthy', () => {
  it('accepts an active, future, in-horizon trigger', () => {
    expect(isPushWorthy(makeTrigger(), NOW)).toBe(true);
  });

  it('rejects inactive triggers', () => {
    expect(isPushWorthy(makeTrigger({ active: 0 }), NOW)).toBe(false);
  });

  it('rejects unscheduled triggers', () => {
    expect(isPushWorthy(makeTrigger({ nextFireAt: null }), NOW)).toBe(false);
  });

  it('rejects times already past — the backend cannot un-send those', () => {
    expect(isPushWorthy(makeTrigger({ nextFireAt: NOW - 1 }), NOW)).toBe(false);
    expect(isPushWorthy(makeTrigger({ nextFireAt: NOW }), NOW)).toBe(false);
  });

  it('rejects anything beyond the horizon, and accepts the boundary', () => {
    const horizon = SCHEDULE_HORIZON_DAYS * DAY_MS;
    expect(isPushWorthy(makeTrigger({ nextFireAt: NOW + horizon }), NOW)).toBe(true);
    expect(isPushWorthy(makeTrigger({ nextFireAt: NOW + horizon + 1 }), NOW)).toBe(false);
  });

  it('rejects a trigger snoozed past its own fire time', () => {
    expect(
      isPushWorthy(makeTrigger({ nextFireAt: NOW + DAY_MS, snoozedUntil: NOW + 2 * DAY_MS }), NOW),
    ).toBe(false);
    // A snooze that has already elapsed is irrelevant.
    expect(
      isPushWorthy(makeTrigger({ nextFireAt: NOW + DAY_MS, snoozedUntil: NOW - DAY_MS }), NOW),
    ).toBe(true);
  });
});

describe('pendingPushes', () => {
  it('selects only push-worthy triggers, sorted by fire time', () => {
    const triggers = [
      makeTrigger({ id: 'later', nextFireAt: NOW + 3 * DAY_MS }),
      makeTrigger({ id: 'soon', nextFireAt: NOW + DAY_MS }),
      makeTrigger({ id: 'past', nextFireAt: NOW - DAY_MS }),
      makeTrigger({ id: 'inactive', nextFireAt: NOW + DAY_MS, active: 0 }),
      makeTrigger({ id: 'unscheduled', nextFireAt: null }),
    ];

    expect(pendingPushes(triggers, NOW)).toEqual([
      { triggerId: 'soon', fireAt: NOW + DAY_MS },
      { triggerId: 'later', fireAt: NOW + 3 * DAY_MS },
    ]);
  });

  it('carries nothing but the id and the time', () => {
    const [push] = pendingPushes([makeTrigger({ id: 'x' })], NOW);
    // If this ever grows a field, the privacy claim in PRIVACY.md is no longer true.
    expect(Object.keys(push!).sort()).toEqual(['fireAt', 'triggerId']);
  });

  it('is empty for no triggers', () => {
    expect(pendingPushes([], NOW)).toEqual([]);
  });
});

// ---------------------------------------------------------------- transport

async function signedContext(fetchImpl: SignedContext['fetchImpl']): Promise<{
  ctx: SignedContext;
  publicKeyJwk: JsonWebKey;
}> {
  const pair = await crypto.subtle.generateKey(SIGNING_KEY_ALGORITHM, false, ['sign', 'verify']);
  const publicKeyJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return {
    ctx: {
      subscriptionId: 'sub-1',
      privateKey: pair.privateKey,
      fetchImpl,
      now: () => NOW,
    },
    publicKeyJwk,
  };
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('signed transport', () => {
  it('sends a signature the server side can verify', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 204 });
    });

    const { ctx, publicKeyJwk } = await signedContext(fetchImpl);
    await schedulePushes(ctx, [{ triggerId: 't1', fireAt: NOW + DAY_MS }]);

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe('/api/schedule');

    const headers = init!.headers as Record<string, string>;
    expect(headers[SUBSCRIPTION_HEADER]).toBe('sub-1');
    expect(headers[TIMESTAMP_HEADER]).toBe(String(NOW));

    // Verify exactly as the Worker will.
    await expect(
      verifyRequest(
        publicKeyJwk,
        headers[SIGNATURE_HEADER]!,
        'POST',
        '/api/schedule',
        NOW,
        init!.body as string,
        NOW,
      ),
    ).resolves.toBe(true);
  });

  it('skips the network entirely when there is nothing to send', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const { ctx } = await signedContext(fetchImpl);

    await schedulePushes(ctx, []);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns what the backend holds after a reconcile', async () => {
    const held = [{ triggerId: 't1', fireAt: NOW + DAY_MS }];
    const fetchImpl = vi.fn(async () => jsonResponse({ pushes: held }));
    const { ctx } = await signedContext(fetchImpl);

    await expect(reconcilePushes(ctx, held)).resolves.toEqual(held);
  });

  it('reconciles an empty set, unlike schedule — that is how the last trigger is cleared', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ pushes: [] }));
    const { ctx } = await signedContext(fetchImpl);

    await expect(reconcilePushes(ctx, [])).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('throws a typed error carrying the status, so callers can keep local state', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 }));
    const { ctx } = await signedContext(fetchImpl);

    await expect(schedulePushes(ctx, [{ triggerId: 't1', fireAt: NOW + DAY_MS }])).rejects.toThrow(
      PushBackendError,
    );
    await expect(
      schedulePushes(ctx, [{ triggerId: 't1', fireAt: NOW + DAY_MS }]),
    ).rejects.toMatchObject({ status: 401, path: '/api/schedule' });
  });
});

describe('subscribe', () => {
  it('is unsigned, and sends the public key that will sign later calls', async () => {
    // Parameters are declared so the mock's call tuple is typed, not inferred as empty.
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ subscriptionId: 'sub-9' }),
    );
    const request = {
      endpoint: 'https://push.example/abc',
      p256dh: 'key',
      auth: 'auth',
      publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
    };

    await expect(subscribe(request, { fetchImpl })).resolves.toEqual({ subscriptionId: 'sub-9' });

    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers[SIGNATURE_HEADER]).toBeUndefined();
    expect(JSON.parse(init.body as string)).toEqual(request);
  });

  it('surfaces a failure as a typed error', async () => {
    const fetchImpl = vi.fn(async () => new Response('rate limited', { status: 429 }));
    await expect(
      subscribe(
        { endpoint: 'e', p256dh: 'p', auth: 'a', publicKeyJwk: {} },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({ status: 429 });
  });
});
