/**
 * Invite codes for shared lists.
 *
 * The difference from `src/sync/crypto.ts` is the whole reason this file exists, so it is worth
 * stating rather than leaving to be inferred.
 *
 * A **space code** carries no key. It names a space and supplies a salt, and the passphrase — which
 * never travels — is what actually decrypts anything. Intercepting a space code achieves nothing.
 *
 * An **invite code carries the key.** It has to: the person you are inviting has no passphrase of
 * yours and must not be given one, because the space passphrase decrypts your entire database and a
 * shared packing list is meant to share a packing list. So the list's own key goes inside the invite.
 *
 * Everything else here follows from that single fact:
 *
 * - **Whoever reads the invite can read the list.** No amount of server-side checking changes it. The
 *   UI says so in those words before showing the code.
 * - **Invites expire**, so a message left in a chat history stops being a working door.
 * - **Invites are single-use**, so a second redemption is refused and — more usefully — is
 *   *reported*, which is the only signal available that a code was intercepted.
 * - **The server never sees the token**, only its SHA-256. A leaked database yields no working
 *   invites, and the server cannot mint itself into a list it was merely asked to store rows for.
 *
 * The token is separate from the key on purpose. The server needs something to check redemption
 * against, and if that something were the key, the server would hold the key.
 */

import { fromBase64Url, toBase64Url } from '../sync/crypto';
import type { ShareRole } from '../db/schema';

/** 256 bits, matching the AES key it protects. Guessing is not a threat model this size admits. */
const TOKEN_BYTES = 32;

/** AES-256. */
const KEY_BYTES = 32;

/**
 * How long an invite stays live.
 *
 * Seven days is chosen against the actual failure mode: the invite sits in a chat thread forever, and
 * the longer it works the longer an old message is a credential. Long enough to send someone a code on
 * a Friday and have them act on it the next weekend; short enough that last year's trip is closed.
 */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface Invite {
  listId: string;
  /** Raw AES key material, base64url. **This is the secret.** */
  key: string;
  /** Single-use redemption token, base64url. Never sent to the server in the clear. */
  token: string;
  role: ShareRole;
  expiresAt: number;
  /**
   * The list's title, carried in the invite itself rather than fetched from the server.
   *
   * The server was never told the title — it is exactly the kind of content this design keeps out of
   * D1 — so there is nowhere else for a joining device to learn it from. Without this, a device that
   * only ever joined by invite would show every shared list as a bare id forever.
   */
  title: string;
}

/** A fresh list key. Separate from any passphrase, and never derived from one. */
export function newListKey(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
}

export function newInviteToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
}

/** Imports stored key material for use. Kept in one place so no caller invents its own parameters. */
export async function importListKey(key: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey('raw', fromBase64Url(key), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * SHA-256 of an invite token.
 *
 * The server stores and compares only this. It is deliberately a plain hash rather than a slow KDF:
 * the token is 256 random bits, so there is no dictionary to defend against, and a slow hash here
 * would only make redemption slow.
 */
export async function hashInviteToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return toBase64Url(new Uint8Array(digest));
}

/**
 * Hashes a device key exactly the way `worker/share.ts`'s `authorId` does, so a client can recognise
 * its own entries in a member or author list.
 *
 * This has to reproduce the server's computation bit for bit, not just be *a* stable hash of the same
 * key. The server hashes the literal string it stored at subscribe time — `JSON.stringify` of the JWK
 * exactly as the subscribing client serialised it, survives a JSON round trip over the wire. An earlier
 * version of this function re-serialised a hand-picked subset of fields in a fixed order, on the theory
 * that field-order independence was worth having. It produced a *different*, equally stable hash — and
 * a device could then never recognise itself in its own member list, because the two sides were hashing
 * different strings for the same key. There is no field selection here for exactly that reason: the
 * caller must pass the JWK as `crypto.subtle.exportKey('jwk', …)` returns it, unmodified, so this
 * matches whatever was sent at subscribe time.
 */
export async function hashDeviceKey(publicKeyJwk: JsonWebKey): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(publicKeyJwk)),
  );
  return toBase64Url(new Uint8Array(digest));
}

const ROLE_CODES: Record<ShareRole, string> = { owner: 'o', editor: 'e', viewer: 'v' };
const CODE_ROLES: Record<string, ShareRole> = { o: 'owner', e: 'editor', v: 'viewer' };

/**
 * FNV-1a over the payload, appended to the code so a damaged one is rejected at the door.
 *
 * Deliberately **not** cryptographic, and not pretending to be. It defends against a code that was
 * half-copied, wrapped by a mail client or truncated by a message length limit — not against anyone
 * malicious, who could trivially recompute it, and who in any case already holds the key if they can
 * rewrite the code at all.
 *
 * It earns its place by turning a specific bad failure into a good one. Without it, chopping the end
 * off a code still decodes: the key and token survive intact and only the trailing expiry digits are
 * lost, so a truncated invite reads as **expired** rather than incomplete. That sends the user to ask
 * for a fresh invite when what they needed was to copy the whole of the one they had.
 */
function checksum(payload: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    hash ^= payload.charCodeAt(i);
    // The FNV prime, via shifts: `hash * 16777619` overflows past 2^53 and loses low bits.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(36);
}

/**
 * Encodes an invite for sending.
 *
 * Not grouped with dashes the way a space code is. A space code is meant to be read aloud or typed
 * across a room; an invite is long, secret, and meant to be copied — formatting it for transcription
 * would encourage exactly the sharing-by-voice this should not invite.
 */
export function encodeInvite(invite: Invite): string {
  const payload = [
    invite.listId,
    invite.key,
    invite.token,
    ROLE_CODES[invite.role],
    String(invite.expiresAt),
    // Base64url'd so a title containing '.' — or anything else — cannot be mistaken for a field
    // separator by the parser below.
    toBase64Url(new TextEncoder().encode(invite.title)),
  ].join('.');
  return toBase64Url(new TextEncoder().encode(`${payload}.${checksum(payload)}`));
}

export function decodeInvite(code: string): Invite | null {
  try {
    const text = new TextDecoder().decode(fromBase64Url(code.replace(/\s/g, '')));
    const [listId, key, token, roleCode, expiresAt, titleB64, sum] = text.split('.');
    if (!listId || !key || !token || !roleCode || !expiresAt || titleB64 === undefined || !sum) {
      return null;
    }

    const payload = [listId, key, token, roleCode, expiresAt, titleB64].join('.');
    if (checksum(payload) !== sum) return null;

    const role = CODE_ROLES[roleCode];
    if (!role) return null;

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(listId)) return null;

    const expires = Number(expiresAt);
    if (!Number.isFinite(expires)) return null;

    // Length is checked because a truncated code that still decodes would otherwise fail later as a
    // decryption error, which reads as "your data is corrupt" rather than "that code is incomplete".
    if (fromBase64Url(key).length !== KEY_BYTES) return null;
    if (fromBase64Url(token).length !== TOKEN_BYTES) return null;

    const title = new TextDecoder().decode(fromBase64Url(titleB64));

    return { listId, key, token, role, expiresAt: expires, title };
  } catch {
    return null;
  }
}

/**
 * Whether an invite has expired, judged by the *reader's* clock.
 *
 * The server checks this too, and its answer is the one that decides. This exists so the app can say
 * "that invite has expired" without a round trip, and because a client that knows an invite is dead
 * should not send its token anywhere.
 */
export function isExpired(invite: Invite, now: number = Date.now()): boolean {
  return invite.expiresAt <= now;
}
