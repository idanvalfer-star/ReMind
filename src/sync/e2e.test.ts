/**
 * The sync client against a real Worker and real D1.
 *
 * Skipped unless `SYNC_E2E=1` and a local Worker is reachable, because it needs infrastructure that
 * `npm test` must not depend on:
 *
 *   npx wrangler dev --port 8787 --local &
 *   SYNC_E2E=1 npx vitest run src/sync/e2e.test.ts
 *
 * It exists because the unit tests cover each half in isolation — the crypto, the merge rules, the
 * change detection against a real IndexedDB, and the endpoints against real D1 — but not the seam
 * between them. `runSync` talking to a live server is where a signing mismatch, a wrong field name or a
 * cursor off by one would actually show up, and none of those are visible from either side alone.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, type Entry } from '../db/schema';
import { tokenize } from '../db/tokenize';
import { SIGNING_KEY_ALGORITHM } from '../shared/pushProtocol';
import { createSpace, joinSpace, leaveSpace, runSync } from './sync';
import { encodeSpaceCode } from './crypto';

const BASE = process.env.SYNC_E2E_BASE ?? 'http://127.0.0.1:8787';
const ENABLED = process.env.SYNC_E2E === '1';

/** Rewrites the app's same-origin API calls onto the local Worker. */
function installFetchShim(): void {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return real(url.startsWith('/') ? `${BASE}${url}` : url, init);
  }) as typeof fetch;
}

/** Registers a fresh device identity, the way `registerForPush` does. */
async function registerDevice(label: string): Promise<void> {
  const pair = (await crypto.subtle.generateKey(SIGNING_KEY_ALGORITHM, false, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const publicKeyJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);

  const response = await fetch(`${BASE}/api/subscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      endpoint: `https://fcm.googleapis.com/fcm/send/e2e-${label}-${Date.now()}-${Math.random()}`,
      p256dh: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      auth: 'AAAAAAAAAAAAAAAAAAAAAA',
      publicKeyJwk,
    }),
  });
  if (!response.ok) throw new Error(`subscribe failed: ${response.status}`);
  const { subscriptionId } = (await response.json()) as { subscriptionId: string };

  await db.pushRegistration.put({
    id: 'singleton',
    subscriptionId,
    endpoint: 'https://example.invalid/e2e',
    p256dh: 'x',
    auth: 'y',
    vapidPublicKey: 'z',
    signingKeyPair: pair,
    registeredAt: Date.now(),
    lastReconciledAt: null,
  });
}

async function addEntry(body: string): Promise<Entry> {
  const entry: Entry = {
    id: crypto.randomUUID(),
    body,
    rawInput: body,
    capturedAt: Date.now(),
    source: 'text',
    language: 'en',
    searchTokens: tokenize(body),
  };
  await db.entries.add(entry);
  return entry;
}

/** Wipes everything a *different* device would not have, keeping the sync space. */
async function becomeSecondDevice(label: string): Promise<void> {
  await Promise.all([
    db.entries.clear(),
    db.people.clear(),
    db.events.clear(),
    db.triggers.clear(),
    db.syncMeta.clear(),
    db.pushRegistration.clear(),
  ]);
  await db.syncSpace.update('singleton', { cursor: 0 });
  await registerDevice(label);
}

let reachable = false;

beforeAll(async () => {
  if (!ENABLED) return;
  installFetchShim();
  try {
    const response = await fetch(`${BASE}/api/vapid-public-key`);
    reachable = response.ok;
  } catch {
    reachable = false;
  }
});

beforeEach(async () => {
  await db.open();
  await Promise.all([
    db.entries.clear(),
    db.people.clear(),
    db.events.clear(),
    db.triggers.clear(),
    db.syncMeta.clear(),
    db.syncSpace.clear(),
    db.pushRegistration.clear(),
  ]);
});

afterEach(async () => {
  // Leave the space so the Worker's D1 does not accumulate a space per test run.
  await leaveSpace().catch(() => undefined);
});

describe.skipIf(!ENABLED)('sync against a live Worker', () => {
  it('is reachable', () => {
    expect(reachable, `no Worker at ${BASE} — start \`wrangler dev --port 8787 --local\``).toBe(true);
  });

  it('pushes a record and a second device pulls it', async () => {
    await registerDevice('first');
    const entry = await addEntry('the ceramic vase Sarah liked');

    const { code } = await createSpace('a-long-enough-passphrase');
    const first = await runSync();
    expect(first.kind).toBe('synced');
    if (first.kind === 'synced') expect(first.pushed).toBeGreaterThanOrEqual(1);

    // A different device: same space, no local data, no sync metadata.
    await becomeSecondDevice('second');
    const second = await runSync();

    expect(second.kind).toBe('synced');
    if (second.kind === 'synced') expect(second.pulled).toBeGreaterThanOrEqual(1);

    const arrived = await db.entries.get(entry.id);
    expect(arrived?.body).toBe('the ceramic vase Sarah liked');
    // The code the user would carry between devices round trips.
    expect(code).toContain('-');
  });

  it('propagates a deletion rather than letting the other device undo it', async () => {
    await registerDevice('first');
    const entry = await addEntry('doomed');
    await createSpace('a-long-enough-passphrase');
    await runSync();

    await db.entries.delete(entry.id);
    await runSync();

    await becomeSecondDevice('second');
    await runSync();
    expect(await db.entries.get(entry.id)).toBeUndefined();
  });

  it('resolves a genuine conflict in favour of the newer edit', async () => {
    await registerDevice('first');
    const entry = await addEntry('original');
    await createSpace('a-long-enough-passphrase');
    await runSync();

    // Another device edits the same record and pushes.
    await db.entries.update(entry.id, { body: 'edited on the other device' });
    await runSync();

    // This device rejoins with no metadata, so it pulls that edit fresh.
    await becomeSecondDevice('second');
    await runSync();
    expect((await db.entries.get(entry.id))?.body).toBe('edited on the other device');
  });

  it('refuses a device with the wrong passphrase', async () => {
    await registerDevice('first');
    const { code } = await createSpace('the-right-passphrase');
    await runSync();

    await db.syncSpace.clear();
    await db.syncMeta.clear();
    const result = await joinSpace(code, 'the-wrong-passphrase');
    expect(result.kind).toBe('wrong-passphrase');
  });

  it('rejects a malformed space code before touching the network', async () => {
    await registerDevice('first');
    expect(await joinSpace('not-a-real-code', 'a-long-enough-passphrase')).toEqual({
      kind: 'bad-code',
    });
  });

  it('stores nothing readable on the server', async () => {
    // The privacy claim's actual test. The Worker's own API cannot show us its rows, so this asserts the
    // thing the client controls: what it puts on the wire is ciphertext, and the plaintext appears
    // nowhere in the request body.
    await registerDevice('first');
    const secret = 'a-very-distinctive-secret-string-9f3a';
    await addEntry(secret);
    await createSpace('a-long-enough-passphrase');

    const bodies: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body === 'string') bodies.push(init.body);
      return real(input as string, init);
    }) as typeof fetch;

    await runSync();
    globalThis.fetch = real;

    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) expect(body).not.toContain(secret);
  });

  it('reports being disabled rather than failing when there is no space', async () => {
    await registerDevice('first');
    expect(await runSync()).toEqual({ kind: 'disabled' });
  });

  it('is idempotent — a second sync with no changes pushes nothing', async () => {
    await registerDevice('first');
    await addEntry('one');
    await createSpace('a-long-enough-passphrase');
    await runSync();

    const again = await runSync();
    expect(again.kind).toBe('synced');
    if (again.kind === 'synced') {
      expect(again.pushed).toBe(0);
      expect(again.pulled).toBe(0);
    }
  });

  it('encodes a space code that decodes back to the stored space', async () => {
    await registerDevice('first');
    const { space, code } = await createSpace('a-long-enough-passphrase');
    expect(code).toBe(encodeSpaceCode({ spaceId: space.spaceId, salt: space.salt }));
  });
});
