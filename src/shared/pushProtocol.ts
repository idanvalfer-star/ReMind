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
 * Every *signed* route is POST, including `unsubscribe`. Uniformity matters more than REST
 * aesthetics here: the HTTP method is part of the signed canonical string, and one shape
 * for all signed calls removes a whole category of signature mismatch.
 *
 * `vapidPublicKey` is the exception: a GET, unsigned, and public. It exists so the key lives
 * in exactly one place — wrangler.toml — rather than being copied into a client build where
 * the two could drift.
 */
export const ROUTES = {
  vapidPublicKey: '/api/vapid-public-key',
  subscribe: '/api/subscribe',
  schedule: '/api/schedule',
  unschedule: '/api/unschedule',
  reconcile: '/api/reconcile',
  unsubscribe: '/api/unsubscribe',
  syncJoin: '/api/sync/join',
  syncPush: '/api/sync/push',
  syncPull: '/api/sync/pull',
  syncLeave: '/api/sync/leave',
  shareCreate: '/api/share/create',
  shareInvite: '/api/share/invite',
  shareRedeem: '/api/share/redeem',
  shareLists: '/api/share/lists',
  sharePush: '/api/share/push',
  sharePull: '/api/share/pull',
  shareMembers: '/api/share/members',
  shareRevoke: '/api/share/revoke',
  shareLeave: '/api/share/leave',
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

// ---------------------------------------------------------------- sync payloads

/**
 * One record, sealed.
 *
 * `ciphertext` and `iv` are `null` for a tombstone: a deletion carries no content, and sending an
 * encrypted empty string instead would be paying for a payload that says nothing while making the
 * server unable to distinguish "deleted" from "empty".
 */
export interface SyncRecord {
  recordKey: string;
  ciphertext: string | null;
  iv: string | null;
  updatedAt: number;
  deleted: boolean;
}

/** A record as the server hands it back, stamped with the revision at which it changed. */
export interface SyncRecordAt extends SyncRecord {
  revision: number;
}

/**
 * Creating or joining a space.
 *
 * Both are the same request: the server creates the row if it does not exist and adds the caller's
 * device key either way. There is no distinction to draw — a space is defined by its id and its
 * members, and whoever arrives first happens to create it.
 */
export interface SyncJoinRequest {
  spaceId: string;
  /**
   * SHA-256 of the passphrase-derived join secret.
   *
   * Present on every sync call, not just this one: it is the membership proof, and the server has no
   * session to remember it in. Sending it repeatedly is what keeps the server free of any state that
   * could be stolen and replayed as a login.
   */
  joinHash: string;
}

export interface SyncJoinResponse {
  /** The space's current revision, so a joining device knows where to pull from. */
  revision: number;
  /** How many devices are in the space, including this one. Shown in Settings. */
  members: number;
}

export interface SyncPushRequest {
  spaceId: string;
  joinHash: string;
  records: SyncRecord[];
}

export interface SyncPushResponse {
  /** The space revision after these writes. Becomes the client's new cursor floor. */
  revision: number;
}

export interface SyncPullRequest {
  spaceId: string;
  joinHash: string;
  /** Everything with a revision strictly greater than this. */
  cursor: number;
  limit?: number;
}

export interface SyncPullResponse {
  records: SyncRecordAt[];
  /** The highest revision in this batch, or the cursor unchanged when it is empty. */
  cursor: number;
  /** True when more remains beyond `limit`, so the client pulls again. */
  more: boolean;
}

export interface SyncLeaveRequest {
  spaceId: string;
}

// ---------------------------------------------------------------- shared list payloads

/**
 * Membership of a shared list is proved by the request signature and nothing else.
 *
 * Sync sends a `joinHash` on every call because its membership derives from a passphrase the server
 * must not learn. Here there is no passphrase: the server holds a row saying this device key is a
 * member with a role, and every signed request already proves possession of that key. Adding a shared
 * secret would be a second thing to leak that proves less than the signature does.
 */
export type ShareRoleWire = 'owner' | 'editor' | 'viewer';

export interface ShareCreateRequest {
  /** Client-minted, so the creator can seal records under it before the round trip completes. */
  listId: string;
}

export interface ShareCreateResponse {
  listId: string;
  revision: number;
}

/**
 * Minting an invite.
 *
 * The server is given only the token's hash — never the token, which stays on the inviting device and
 * goes into the code the user sends. A stolen database therefore yields no working invites.
 */
export interface ShareInviteRequest {
  listId: string;
  tokenHash: string;
  role: ShareRoleWire;
  expiresAt: number;
}

export interface ShareRedeemRequest {
  listId: string;
  /** Hash of the token from the invite code; the server compares hashes, never plaintext. */
  tokenHash: string;
}

export type ShareRedeemResponse =
  | { kind: 'joined'; role: ShareRoleWire; revision: number }
  /** Distinguished from `unknown` on purpose: "already used" is what tells someone they were beaten to it. */
  | { kind: 'already-used' }
  | { kind: 'expired' }
  | { kind: 'unknown' };

/** One list this device belongs to, as the server sees it. */
export interface ShareMembership {
  listId: string;
  role: ShareRoleWire;
  revision: number;
  members: number;
}

export interface ShareListsResponse {
  lists: ShareMembership[];
}

export interface SharePushRequest {
  listId: string;
  records: SyncRecord[];
}

export type SharePushResponse =
  | { kind: 'written'; revision: number }
  /** A viewer tried to write. Refused here because no key can refuse it. */
  | { kind: 'forbidden' };

export interface SharePullRequest {
  listId: string;
  cursor: number;
  limit?: number;
}

/** A shared record carries who last wrote it, which a sync record has no need of. */
export interface ShareRecordAt extends SyncRecordAt {
  /** The author's device key, hashed. Enough to group changes by person, never to name one. */
  author: string;
}

export interface SharePullResponse {
  records: ShareRecordAt[];
  cursor: number;
  more: boolean;
  /** This device's current role, so a demotion is noticed on the next pull rather than the next write. */
  role: ShareRoleWire;
}

export interface ShareMembersRequest {
  listId: string;
}

export interface ShareMembersResponse {
  members: { author: string; role: ShareRoleWire; joinedAt: number }[];
}

export interface ShareRevokeRequest {
  listId: string;
  /** The hashed device key, as returned by `members` — the client never handles raw keys of others. */
  author: string;
}

export interface ShareLeaveRequest {
  listId: string;
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
