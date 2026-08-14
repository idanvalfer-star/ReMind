/**
 * The shared-list endpoints against a real Worker and real D1, with two independent devices.
 *
 * Skipped unless `SHARE_E2E=1` and a local Worker is reachable:
 *
 *   npx wrangler dev --port 8787 --local &
 *   SHARE_E2E=1 npx vitest run src/share/e2e.test.ts
 *
 * Two devices is the point. Every interesting property of sharing is a statement about what *someone
 * else* can do — a viewer cannot write, a revoked member cannot read, an invite works once — and none
 * of them can be tested from one identity. So this file talks to the API directly with two real
 * keypairs rather than going through the app's singleton client.
 *
 * It signs with the same `signRequest` the app uses. An earlier ad-hoc version of this script rolled
 * its own canonical string and got the protocol version wrong, which failed as a signature mismatch
 * and looked for a while like a server bug.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ROUTES,
  SIGNATURE_HEADER,
  SIGNING_KEY_ALGORITHM,
  SUBSCRIPTION_HEADER,
  TIMESTAMP_HEADER,
  signRequest,
  type ShareListsResponse,
  type ShareMembersResponse,
  type SharePullResponse,
  type SharePushResponse,
  type ShareRedeemResponse,
} from '../shared/pushProtocol';
import { seal, open } from '../sync/crypto';
import {
  hashDeviceKey,
  hashInviteToken,
  importListKey,
  newInviteToken,
  newListKey,
  INVITE_TTL_MS,
} from './invite';

const BASE = process.env.SHARE_E2E_BASE ?? 'http://127.0.0.1:8787';
const ENABLED = process.env.SHARE_E2E === '1';

interface Device {
  label: string;
  subscriptionId: string;
  privateKey: CryptoKey;
  publicKeyJwk: JsonWebKey;
}

/** Registers a device the way `registerForPush` does, and keeps its signing key. */
async function newDevice(label: string): Promise<Device> {
  const pair = (await crypto.subtle.generateKey(SIGNING_KEY_ALGORITHM, false, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const publicKeyJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);

  const response = await fetch(`${BASE}${ROUTES.subscribe}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      endpoint: `https://fcm.googleapis.com/fcm/send/share-${label}-${Date.now()}-${Math.random()}`,
      p256dh: `${'B'.repeat(87)}A`,
      auth: 'A'.repeat(22),
      publicKeyJwk,
    }),
  });
  if (!response.ok) throw new Error(`subscribe failed for ${label}: ${response.status}`);
  const { subscriptionId } = (await response.json()) as { subscriptionId: string };
  return { label, subscriptionId, privateKey: pair.privateKey, publicKeyJwk };
}

interface Reply<T> {
  status: number;
  body: T | null;
}

async function post<T>(device: Device, path: string, payload: unknown): Promise<Reply<T>> {
  const body = JSON.stringify(payload);
  const timestamp = Date.now();
  const signature = await signRequest(device.privateKey, 'POST', path, timestamp, body);

  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [SUBSCRIPTION_HEADER]: device.subscriptionId,
      [TIMESTAMP_HEADER]: String(timestamp),
      [SIGNATURE_HEADER]: signature,
    },
    body,
  });

  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as T) : null };
}

/** A complete list, owned by `owner`, with a fresh key. */
async function newList(owner: Device): Promise<{ listId: string; key: string }> {
  const listId = crypto.randomUUID();
  const created = await post(owner, ROUTES.shareCreate, { listId });
  expect(created.status, 'create').toBe(200);
  return { listId, key: newListKey() };
}

/** Mints an invite and returns the token, as the inviting client would. */
async function invite(
  owner: Device,
  listId: string,
  role: 'owner' | 'editor' | 'viewer',
  expiresAt = Date.now() + INVITE_TTL_MS,
): Promise<{ token: string; status: number }> {
  const token = newInviteToken();
  const reply = await post(owner, ROUTES.shareInvite, {
    listId,
    tokenHash: await hashInviteToken(token),
    role,
    expiresAt,
  });
  return { token, status: reply.status };
}

async function sealed(key: string, recordKey: string, plaintext: string) {
  const cryptoKey = await importListKey(key);
  const { ciphertext, iv } = await seal(cryptoKey, plaintext, recordKey);
  return { recordKey, ciphertext, iv, updatedAt: Date.now(), deleted: false };
}

let reachable = false;
let alice: Device;
let bob: Device;

beforeAll(async () => {
  if (!ENABLED) return;
  try {
    reachable = (await fetch(`${BASE}${ROUTES.vapidPublicKey}`)).ok;
  } catch {
    reachable = false;
  }
  if (!reachable) return;
  alice = await newDevice('alice');
  bob = await newDevice('bob');
});

/** Lists created here are left behind unless leave is called, so each test cleans up after itself. */
const created: { device: Device; listId: string }[] = [];
afterAll(async () => {
  if (!ENABLED || !reachable) return;
  for (const { device, listId } of created) {
    await post(device, ROUTES.shareLeave, { listId }).catch(() => undefined);
  }
});

function track(device: Device, listId: string): string {
  created.push({ device, listId });
  return listId;
}

describe.skipIf(!ENABLED)('shared lists against a live Worker', () => {
  it('is reachable', () => {
    expect(reachable, `no Worker at ${BASE} — start \`wrangler dev --port 8787 --local\``).toBe(
      true,
    );
  });

  it('lets an invited editor read and write what the owner wrote', async () => {
    const { listId, key } = await newList(alice);
    track(alice, listId);
    track(bob, listId);

    const { token, status } = await invite(alice, listId, 'editor');
    // A successful invite has nothing to return, so the endpoint answers 204 rather than an empty 200.
    expect(status).toBe(204);

    const redeemed = await post<ShareRedeemResponse>(bob, ROUTES.shareRedeem, {
      listId,
      tokenHash: await hashInviteToken(token),
    });
    expect(redeemed.body).toMatchObject({ kind: 'joined', role: 'editor' });

    const pushed = await post<SharePushResponse>(alice, ROUTES.sharePush, {
      listId,
      records: [await sealed(key, 'packItems:one', 'Passport')],
    });
    expect(pushed.body?.kind).toBe('written');

    const pulled = await post<SharePullResponse>(bob, ROUTES.sharePull, { listId, cursor: 0 });
    expect(pulled.body?.records).toHaveLength(1);
    const record = pulled.body!.records[0]!;
    // The key came from the invite, so this is the whole point: Bob can actually read it.
    expect(
      await open(
        await importListKey(key),
        { ciphertext: record.ciphertext!, iv: record.iv! },
        'packItems:one',
      ),
    ).toBe('Passport');

    // And an editor may write back.
    const bobWrote = await post<SharePushResponse>(bob, ROUTES.sharePush, {
      listId,
      records: [await sealed(key, 'packItems:two', 'Charger')],
    });
    expect(bobWrote.body?.kind).toBe('written');
  });

  it('refuses a write from a viewer', async () => {
    // The one guarantee no key can provide, so the one most worth testing.
    const { listId, key } = await newList(alice);
    track(alice, listId);
    track(bob, listId);

    const { token } = await invite(alice, listId, 'viewer');
    await post(bob, ROUTES.shareRedeem, { listId, tokenHash: await hashInviteToken(token) });

    const attempt = await post<SharePushResponse>(bob, ROUTES.sharePush, {
      listId,
      records: [await sealed(key, 'packItems:sneaky', 'Contraband')],
    });
    expect(attempt.status).toBe(200);
    expect(attempt.body?.kind).toBe('forbidden');

    // And nothing landed.
    const pulled = await post<SharePullResponse>(alice, ROUTES.sharePull, { listId, cursor: 0 });
    expect(pulled.body?.records ?? []).toHaveLength(0);
  });

  it('tells a viewer their role on every pull, so a demotion is noticed', async () => {
    const { listId } = await newList(alice);
    track(alice, listId);
    track(bob, listId);
    const { token } = await invite(alice, listId, 'viewer');
    await post(bob, ROUTES.shareRedeem, { listId, tokenHash: await hashInviteToken(token) });

    const pulled = await post<SharePullResponse>(bob, ROUTES.sharePull, { listId, cursor: 0 });
    expect(pulled.body?.role).toBe('viewer');
  });

  it('burns an invite after one use', async () => {
    const { listId } = await newList(alice);
    track(alice, listId);
    track(bob, listId);

    const { token } = await invite(alice, listId, 'editor');
    const tokenHash = await hashInviteToken(token);
    await post(bob, ROUTES.shareRedeem, { listId, tokenHash });

    // A third device presenting the same code is refused, and told it was already used — the only
    // signal anyone gets that a code was intercepted.
    const carol = await newDevice('carol');
    const second = await post<ShareRedeemResponse>(carol, ROUTES.shareRedeem, { listId, tokenHash });
    expect(second.body?.kind).toBe('already-used');
  });

  it('treats a repeat redemption from the same device as a retry, not an interception', async () => {
    // A dropped response must not lock someone out of a list they already joined.
    const { listId } = await newList(alice);
    track(alice, listId);
    track(bob, listId);

    const { token } = await invite(alice, listId, 'editor');
    const tokenHash = await hashInviteToken(token);
    await post(bob, ROUTES.shareRedeem, { listId, tokenHash });
    const again = await post<ShareRedeemResponse>(bob, ROUTES.shareRedeem, { listId, tokenHash });
    expect(again.body).toMatchObject({ kind: 'joined', role: 'editor' });
  });

  it('refuses an expired invite', async () => {
    const { listId } = await newList(alice);
    track(alice, listId);

    // The server refuses to mint one already dead, so this mints a live one and waits it out.
    const { token, status } = await invite(alice, listId, 'editor', Date.now() + 1200);
    expect(status).toBe(204);
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const reply = await post<ShareRedeemResponse>(bob, ROUTES.shareRedeem, {
      listId,
      tokenHash: await hashInviteToken(token),
    });
    expect(reply.body?.kind).toBe('expired');
  });

  it('refuses to mint an invite that is already expired', async () => {
    const { listId } = await newList(alice);
    track(alice, listId);
    expect((await invite(alice, listId, 'editor', Date.now() - 1000)).status).toBe(400);
  });

  it('reports an unknown token as unknown rather than as an error', async () => {
    const { listId } = await newList(alice);
    track(alice, listId);
    const reply = await post<ShareRedeemResponse>(bob, ROUTES.shareRedeem, {
      listId,
      tokenHash: await hashInviteToken(newInviteToken()),
    });
    expect(reply.body?.kind).toBe('unknown');
  });

  it('lets only the owner invite', async () => {
    const { listId } = await newList(alice);
    track(alice, listId);
    track(bob, listId);

    const { token } = await invite(alice, listId, 'editor');
    await post(bob, ROUTES.shareRedeem, { listId, tokenHash: await hashInviteToken(token) });

    // An editor who could invite could give away a list they do not own.
    expect((await invite(bob, listId, 'editor')).status).toBe(403);
  });

  it('refuses a stranger everything', async () => {
    const { listId, key } = await newList(alice);
    track(alice, listId);

    const stranger = await newDevice('stranger');
    expect((await post(stranger, ROUTES.sharePull, { listId, cursor: 0 })).status).toBe(403);
    expect(
      (
        await post(stranger, ROUTES.sharePush, {
          listId,
          records: [await sealed(key, 'packItems:x', 'nope')],
        })
      ).status,
    ).toBe(403);
    expect((await post(stranger, ROUTES.shareMembers, { listId })).status).toBe(403);
  });

  it('refuses to let someone else claim an existing list id', async () => {
    const { listId } = await newList(alice);
    track(alice, listId);
    expect((await post(bob, ROUTES.shareCreate, { listId })).status).toBe(409);
  });

  it('is idempotent when the owner re-creates their own list', async () => {
    // A retry after a dropped response must not fail.
    const { listId } = await newList(alice);
    track(alice, listId);
    expect((await post(alice, ROUTES.shareCreate, { listId })).status).toBe(200);
  });

  it('lets a device recognise itself in the member list it just joined', async () => {
    // The regression this guards: `hashDeviceKey` must reproduce exactly what the server computed as
    // `author` for this device, not merely be *a* stable hash of the same key. A version of this
    // function that canonicalised the JWK differently from the server passed every other test in this
    // file — signing, pushing, pulling, revoking all still worked — and only broke here, because it is
    // the one place two independently computed hashes of the same key are compared against each other.
    const { listId } = await newList(alice);
    track(alice, listId);
    const members = await post<ShareMembersResponse>(alice, ROUTES.shareMembers, { listId });
    const own = await hashDeviceKey(alice.publicKeyJwk);
    expect(members.body!.members.map((m) => m.author)).toContain(own);
  });

  it('cuts off a revoked member', async () => {
    const { listId, key } = await newList(alice);
    track(alice, listId);

    const { token } = await invite(alice, listId, 'editor');
    await post(bob, ROUTES.shareRedeem, { listId, tokenHash: await hashInviteToken(token) });
    await post(alice, ROUTES.sharePush, {
      listId,
      records: [await sealed(key, 'packItems:one', 'Passport')],
    });
    expect((await post<SharePullResponse>(bob, ROUTES.sharePull, { listId, cursor: 0 })).status).toBe(
      200,
    );

    const members = await post<ShareMembersResponse>(alice, ROUTES.shareMembers, { listId });
    const bobEntry = members.body!.members.find((m) => m.role === 'editor')!;
    // Revoke returns nothing on success, so it is 204 too.
    expect((await post(alice, ROUTES.shareRevoke, { listId, author: bobEntry.author })).status).toBe(
      204,
    );

    // No further reads, no further writes.
    expect((await post(bob, ROUTES.sharePull, { listId, cursor: 0 })).status).toBe(403);
    expect(
      (
        await post(bob, ROUTES.sharePush, {
          listId,
          records: [await sealed(key, 'packItems:three', 'Late')],
        })
      ).status,
    ).toBe(403);
  });

  it('will not let an owner revoke themselves into a list nobody can invite into', async () => {
    const { listId } = await newList(alice);
    track(alice, listId);
    const members = await post<ShareMembersResponse>(alice, ROUTES.shareMembers, { listId });
    const self = members.body!.members[0]!;
    expect((await post(alice, ROUTES.shareRevoke, { listId, author: self.author })).status).toBe(400);
  });

  it('lets a non-owner be refused revocation', async () => {
    const { listId } = await newList(alice);
    track(alice, listId);
    track(bob, listId);
    const { token } = await invite(alice, listId, 'editor');
    await post(bob, ROUTES.shareRedeem, { listId, tokenHash: await hashInviteToken(token) });

    const members = await post<ShareMembersResponse>(bob, ROUTES.shareMembers, { listId });
    const owner = members.body!.members.find((m) => m.role === 'owner')!;
    expect((await post(bob, ROUTES.shareRevoke, { listId, author: owner.author })).status).toBe(403);
  });

  it('lists the lists a device belongs to', async () => {
    const { listId } = await newList(alice);
    track(alice, listId);
    const lists = await post<ShareListsResponse>(alice, ROUTES.shareLists, {});
    expect(lists.body?.lists.some((entry) => entry.listId === listId)).toBe(true);
    expect(lists.body?.lists.find((entry) => entry.listId === listId)?.role).toBe('owner');
  });

  it('pulls only what changed after the cursor', async () => {
    const { listId, key } = await newList(alice);
    track(alice, listId);

    await post(alice, ROUTES.sharePush, {
      listId,
      records: [await sealed(key, 'packItems:one', 'Passport')],
    });
    const first = await post<SharePullResponse>(alice, ROUTES.sharePull, { listId, cursor: 0 });
    expect(first.body?.records).toHaveLength(1);

    await post(alice, ROUTES.sharePush, {
      listId,
      records: [await sealed(key, 'packItems:two', 'Charger')],
    });
    const second = await post<SharePullResponse>(alice, ROUTES.sharePull, {
      listId,
      cursor: first.body!.cursor,
    });
    expect(second.body?.records).toHaveLength(1);
    expect(second.body?.records[0]?.recordKey).toBe('packItems:two');
  });

  it('propagates a deletion as a tombstone carrying no content', async () => {
    const { listId, key } = await newList(alice);
    track(alice, listId);

    await post(alice, ROUTES.sharePush, {
      listId,
      records: [await sealed(key, 'packItems:one', 'Passport')],
    });
    await post(alice, ROUTES.sharePush, {
      listId,
      records: [
        { recordKey: 'packItems:one', ciphertext: null, iv: null, updatedAt: Date.now(), deleted: true },
      ],
    });

    const pulled = await post<SharePullResponse>(alice, ROUTES.sharePull, { listId, cursor: 0 });
    const record = pulled.body!.records[0]!;
    expect(record.deleted).toBe(true);
    expect(record.ciphertext).toBeNull();
  });

  it('refuses a deletion that carries a payload', async () => {
    const { listId, key } = await newList(alice);
    track(alice, listId);
    const record = await sealed(key, 'packItems:one', 'Passport');
    const reply = await post(alice, ROUTES.sharePush, {
      listId,
      records: [{ ...record, deleted: true }],
    });
    expect(reply.status).toBe(400);
  });

  it('names who last wrote each record, without naming a person', async () => {
    const { listId, key } = await newList(alice);
    track(alice, listId);
    track(bob, listId);
    const { token } = await invite(alice, listId, 'editor');
    await post(bob, ROUTES.shareRedeem, { listId, tokenHash: await hashInviteToken(token) });

    await post(alice, ROUTES.sharePush, {
      listId,
      records: [await sealed(key, 'packItems:one', 'Passport')],
    });
    await post(bob, ROUTES.sharePush, {
      listId,
      records: [await sealed(key, 'packItems:two', 'Charger')],
    });

    const pulled = await post<SharePullResponse>(alice, ROUTES.sharePull, { listId, cursor: 0 });
    const authors = new Set(pulled.body!.records.map((record) => record.author));
    expect(authors.size).toBe(2);
    // A hash, not a name. The server has never been told anyone's name.
    for (const author of authors) expect(author).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('keeps the plaintext off the wire entirely', async () => {
    const { listId, key } = await newList(alice);
    track(alice, listId);
    const secret = 'a-distinctive-shared-secret-4c7b';
    const record = await sealed(key, 'packItems:one', secret);
    expect(JSON.stringify(record)).not.toContain(secret);
  });

  it('deletes the list once its last member leaves', async () => {
    const { listId } = await newList(alice);
    expect((await post(alice, ROUTES.shareLeave, { listId })).status).toBe(204);
    // Gone: not a member of anything, so a pull is refused rather than empty.
    expect((await post(alice, ROUTES.sharePull, { listId, cursor: 0 })).status).toBe(403);
  });
});
