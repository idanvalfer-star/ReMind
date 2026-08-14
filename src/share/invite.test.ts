import { describe, expect, it } from 'vitest';
import {
  INVITE_TTL_MS,
  decodeInvite,
  encodeInvite,
  hashDeviceKey,
  hashInviteToken,
  importListKey,
  isExpired,
  newInviteToken,
  newListKey,
  type Invite,
} from './invite';
import { fromBase64Url, toBase64Url, seal, open } from '../sync/crypto';
import type { ShareRole } from '../db/schema';

const invite = (overrides: Partial<Invite> = {}): Invite => ({
  listId: '8f14e45f-ceea-467a-9a3d-1b6a4c9e1234',
  key: newListKey(),
  token: newInviteToken(),
  role: 'editor',
  expiresAt: Date.now() + INVITE_TTL_MS,
  title: 'Iceland packing list',
  ...overrides,
});

describe('list keys', () => {
  it('mints 256 bits', () => {
    expect(fromBase64Url(newListKey())).toHaveLength(32);
  });

  it('never repeats', () => {
    const keys = new Set(Array.from({ length: 50 }, () => newListKey()));
    expect(keys.size).toBe(50);
  });

  it('imports into a usable AES-GCM key', async () => {
    const raw = newListKey();
    const key = await importListKey(raw);
    const sealed = await seal(key, 'socks ×5', 'packItems:abc');
    expect(await open(key, sealed, 'packItems:abc')).toBe('socks ×5');
  });

  it('produces a key that only decrypts under its own record key', async () => {
    // The same authentication the sync layer relies on: a ciphertext moved onto another record must
    // fail rather than decrypt into the wrong row.
    const key = await importListKey(newListKey());
    const sealed = await seal(key, 'passport', 'packItems:one');
    await expect(open(key, sealed, 'packItems:two')).rejects.toThrow();
  });

  it('cannot be opened by a different list key', async () => {
    const sealed = await seal(await importListKey(newListKey()), 'passport', 'packItems:one');
    await expect(open(await importListKey(newListKey()), sealed, 'packItems:one')).rejects.toThrow();
  });
});

describe('invite codes', () => {
  it('round trips', () => {
    const original = invite();
    expect(decodeInvite(encodeInvite(original))).toEqual(original);
  });

  it('round trips every role', () => {
    for (const role of ['owner', 'editor', 'viewer'] as const) {
      const original = invite({ role });
      expect(decodeInvite(encodeInvite(original))?.role).toBe(role);
    }
  });

  it('survives whitespace a mail client may have inserted', () => {
    const original = invite();
    const code = encodeInvite(original);
    const mangled = `${code.slice(0, 20)}\n  ${code.slice(20)}`;
    expect(decodeInvite(mangled)).toEqual(original);
  });

  it('rejects nonsense rather than throwing', () => {
    expect(decodeInvite('')).toBeNull();
    expect(decodeInvite('not-an-invite')).toBeNull();
    expect(decodeInvite('!!!!')).toBeNull();
  });

  it('rejects a truncated code instead of failing later as a decryption error', () => {
    // The point of the length check: a half-copied code should say "that code is incomplete" at the
    // door, not surface as "your data could not be decrypted" three steps in.
    const code = encodeInvite(invite());
    expect(decodeInvite(code.slice(0, code.length - 12))).toBeNull();
  });

  it('rejects a code whose key is the wrong size', () => {
    const short = { ...invite(), key: 'AAAA' };
    expect(decodeInvite(encodeInvite(short))).toBeNull();
  });

  it('rejects a code with an unknown role marker', () => {
    // Encoded through the real path so the checksum is valid — otherwise this would pass by tripping
    // the checksum and never exercise the role check at all.
    const code = encodeInvite({ ...invite(), role: 'admin' as ShareRole });
    expect(decodeInvite(code)).toBeNull();
  });

  it('rejects a code whose payload was edited without recomputing the checksum', () => {
    const code = encodeInvite(invite());
    const text = new TextDecoder().decode(fromBase64Url(code));
    const parts = text.split('.');
    // A plausible attack on a code seen in transit: extend its life.
    parts[4] = String(Number(parts[4]) + 86_400_000);
    const tampered = toBase64Url(new TextEncoder().encode(parts.join('.')));
    expect(decodeInvite(tampered)).toBeNull();
  });

  it('rejects a list id that is not a UUID', () => {
    expect(decodeInvite(encodeInvite(invite({ listId: 'not-a-uuid' })))).toBeNull();
  });

  it('carries the key, which is the thing that makes it dangerous', () => {
    // Pinning the property the documentation warns about, so nobody "hardens" this by removing the
    // key and quietly breaking every invite.
    const original = invite();
    expect(decodeInvite(encodeInvite(original))?.key).toBe(original.key);
  });

  it('carries a title containing the field separator without corrupting the other fields', () => {
    // A title is free text a user typed, so it can contain '.' — the exact character the payload uses
    // to separate fields. If the title were not isolated, this would misparse the role or expiry.
    const original = invite({ title: 'Trip: Iceland. Round 2.' });
    const decoded = decodeInvite(encodeInvite(original));
    expect(decoded).toEqual(original);
  });

  it('round trips a Hebrew title', () => {
    const original = invite({ title: 'רשימת אריזה לטיול' });
    expect(decodeInvite(encodeInvite(original))?.title).toBe(original.title);
  });

  it('round trips an empty title', () => {
    const original = invite({ title: '' });
    expect(decodeInvite(encodeInvite(original))?.title).toBe('');
  });

  it('is not dash-grouped like a space code', () => {
    // Space codes are grouped for reading aloud. An invite is a secret to be copied, and formatting
    // it for transcription would invite the one way of sharing it that should not be encouraged.
    expect(encodeInvite(invite())).not.toContain('-');
  });
});

describe('expiry', () => {
  it('is live before its expiry and dead after', () => {
    const now = 1_700_000_000_000;
    expect(isExpired(invite({ expiresAt: now + 1 }), now)).toBe(false);
    expect(isExpired(invite({ expiresAt: now - 1 }), now)).toBe(true);
  });

  it('treats the exact expiry instant as expired', () => {
    const now = 1_700_000_000_000;
    expect(isExpired(invite({ expiresAt: now }), now)).toBe(true);
  });

  it('defaults to a week', () => {
    expect(INVITE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe('hashing', () => {
  it('hashes a token to a stable value', async () => {
    const token = newInviteToken();
    expect(await hashInviteToken(token)).toBe(await hashInviteToken(token));
  });

  it('gives different tokens different hashes', async () => {
    expect(await hashInviteToken(newInviteToken())).not.toBe(
      await hashInviteToken(newInviteToken()),
    );
  });

  it('does not leak the token', async () => {
    const token = newInviteToken();
    expect(await hashInviteToken(token)).not.toContain(token.slice(0, 12));
  });

  it('matches what the server would compute from the wire string a device sends at subscribe time', async () => {
    // Mirrors worker/share.ts's authorId exactly: the server hashes JSON.stringify of whatever JWK
    // object the subscribing client put in the request body, after that body has been through a JSON
    // round trip (stringify on the way out, parse on the way in). This is the property that broke: an
    // earlier version of hashDeviceKey re-serialised a hand-picked subset of fields, so a device could
    // never recognise itself in its own member list because the two sides hashed different strings.
    const jwk = { kty: 'EC', crv: 'P-256', x: 'AAAA', y: 'BBBB', ext: true, key_ops: ['verify'] };
    const bodyOnTheWire = JSON.stringify({ publicKeyJwk: jwk });
    const serverSide = (JSON.parse(bodyOnTheWire) as { publicKeyJwk: JsonWebKey }).publicKeyJwk;
    const serverDeviceKeyString = JSON.stringify(serverSide);
    const serverDigest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(serverDeviceKeyString),
    );
    const serverHash = toBase64Url(new Uint8Array(serverDigest));

    expect(await hashDeviceKey(jwk)).toBe(serverHash);
  });

  it('changes if the JWK field order changes, matching the server rather than being order-independent', async () => {
    // The opposite of what an earlier version of this function guaranteed, and correctly so: the two
    // objects below serialise to different strings, and the server would compute two different hashes
    // for them too, so this function must not paper over that with its own canonicalisation.
    const a = { kty: 'EC', crv: 'P-256', x: 'AAAA', y: 'BBBB' };
    const b = { y: 'BBBB', x: 'AAAA', crv: 'P-256', kty: 'EC' };
    expect(await hashDeviceKey(a)).not.toBe(await hashDeviceKey(b));
  });

  it('distinguishes two device keys', async () => {
    const a = { kty: 'EC', crv: 'P-256', x: 'AAAA', y: 'BBBB' };
    const b = { kty: 'EC', crv: 'P-256', x: 'AAAA', y: 'CCCC' };
    expect(await hashDeviceKey(a)).not.toBe(await hashDeviceKey(b));
  });
});
