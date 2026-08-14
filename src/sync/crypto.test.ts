import { describe, expect, it } from 'vitest';
import {
  checkVerifier,
  DecryptionError,
  decodeSpaceCode,
  deriveSpaceSecrets,
  hashJoinSecret,
  encodeSpaceCode,
  fromBase64Url,
  makeVerifier,
  newSpaceIdentity,
  open,
  seal,
  toBase64Url,
  VERIFIER_PLAINTEXT,
} from './crypto';

/**
 * Helpers so the suite stays fast without weakening what ships.
 *
 * `deriveSpaceSecrets` runs 600,000 PBKDF2 iterations — the right number in production, and about half a
 * second per call here. Tests that are about AES-GCM rather than about the KDF import a raw key instead.
 */
async function deriveKeyOnly(passphrase: string, salt: string): Promise<CryptoKey> {
  return (await deriveSpaceSecrets(passphrase, salt)).key;
}

async function rawKey(byte = 7): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new Uint8Array(new ArrayBuffer(32)).fill(byte),
    'AES-GCM',
    false,
    ['encrypt', 'decrypt'],
  );
}

describe('base64url', () => {
  it('round trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255, 62, 63]);
    expect([...fromBase64Url(toBase64Url(bytes))]).toEqual([...bytes]);
  });

  it('emits no padding and no URL-unsafe characters', () => {
    for (let length = 1; length <= 8; length++) {
      const encoded = toBase64Url(crypto.getRandomValues(new Uint8Array(length)));
      expect(encoded).not.toMatch(/[+/=]/);
    }
  });

  it('round trips an empty array', () => {
    expect([...fromBase64Url(toBase64Url(new Uint8Array(0)))]).toEqual([]);
  });
});

describe('space identity', () => {
  it('generates a distinct id and salt each time', () => {
    const a = newSpaceIdentity();
    const b = newSpaceIdentity();
    expect(a.spaceId).not.toBe(b.spaceId);
    expect(a.salt).not.toBe(b.salt);
  });

  it('round trips through a space code', () => {
    const identity = newSpaceIdentity();
    expect(decodeSpaceCode(encodeSpaceCode(identity))).toEqual(identity);
  });

  it('tolerates the grouping dashes and stray whitespace', () => {
    const identity = newSpaceIdentity();
    const code = encodeSpaceCode(identity);
    expect(decodeSpaceCode(code.replace(/-/g, ''))).toEqual(identity);
    expect(decodeSpaceCode(` ${code.replace(/-/g, ' ')} `)).toEqual(identity);
  });

  it('carries neither the passphrase nor any key material', () => {
    // The point of the design: a code seen in a screenshot is not a compromise.
    const identity = newSpaceIdentity();
    const decoded = new TextDecoder().decode(
      fromBase64Url(encodeSpaceCode(identity).replace(/-/g, '')),
    );
    expect(decoded).toBe(`${identity.spaceId}.${identity.salt}`);
  });

  it('rejects a mistyped code rather than producing a plausible space', () => {
    expect(decodeSpaceCode('')).toBeNull();
    expect(decodeSpaceCode('not-a-code')).toBeNull();
    expect(decodeSpaceCode(toBase64Url(new TextEncoder().encode('nosalt')))).toBeNull();
    expect(decodeSpaceCode(toBase64Url(new TextEncoder().encode('not-a-uuid.abc')))).toBeNull();
  });
});

describe('deriveSpaceSecrets', () => {
  it('is deterministic for the same passphrase and salt', async () => {
    const { salt } = newSpaceIdentity();
    const first = await deriveKeyOnly('correct horse battery staple', salt);
    const second = await deriveKeyOnly('correct horse battery staple', salt);

    // The keys cannot be compared directly — they are non-extractable — so compare behaviour.
    const sealed = await seal(first, 'hello', 'ctx');
    expect(await open(second, sealed, 'ctx')).toBe('hello');
  });

  it('produces a different key for a different passphrase', async () => {
    const { salt } = newSpaceIdentity();
    const right = await deriveKeyOnly('right', salt);
    const wrong = await deriveKeyOnly('wrong', salt);

    const sealed = await seal(right, 'hello', 'ctx');
    await expect(open(wrong, sealed, 'ctx')).rejects.toBeInstanceOf(DecryptionError);
  });

  it('produces a different key for a different salt', async () => {
    const a = await deriveKeyOnly('same', newSpaceIdentity().salt);
    const b = await deriveKeyOnly('same', newSpaceIdentity().salt);

    const sealed = await seal(a, 'hello', 'ctx');
    await expect(open(b, sealed, 'ctx')).rejects.toBeInstanceOf(DecryptionError);
  });

  it('is non-extractable, so the key cannot be read back out', async () => {
    const key = await deriveKeyOnly('anything', newSpaceIdentity().salt);
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toBeTruthy();
  });

  it('derives a join secret independent of the encryption key', async () => {
    const { salt } = newSpaceIdentity();
    const a = await deriveSpaceSecrets('same passphrase', salt);
    const b = await deriveSpaceSecrets('same passphrase', salt);
    const other = await deriveSpaceSecrets('different', salt);

    // Deterministic for the same passphrase, different for another.
    expect(a.joinSecret).toBe(b.joinSecret);
    expect(a.joinSecret).not.toBe(other.joinSecret);
    // 32 bytes of base64url.
    expect(a.joinSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('produces a join hash that does not reveal the secret', async () => {
    const { joinSecret } = await deriveSpaceSecrets('pass', newSpaceIdentity().salt);
    const hash = await hashJoinSecret(joinSecret);
    expect(hash).not.toBe(joinSecret);
    expect(hash).toBe(await hashJoinSecret(joinSecret));
  });

  it('gives different join hashes for different passphrases', async () => {
    const { salt } = newSpaceIdentity();
    const a = await deriveSpaceSecrets('one', salt);
    const b = await deriveSpaceSecrets('two', salt);
    expect(await hashJoinSecret(a.joinSecret)).not.toBe(await hashJoinSecret(b.joinSecret));
  });
});

describe('seal and open', () => {
  it('round trips', async () => {
    const key = await rawKey();
    const sealed = await seal(key, 'the vase Sarah liked', 'entries:abc');
    expect(await open(key, sealed, 'entries:abc')).toBe('the vase Sarah liked');
  });

  it('round trips Hebrew and emoji unchanged', async () => {
    const key = await rawKey();
    const text = 'ארוחת ערב עם דני 🎉';
    expect(await open(key, await seal(key, text, 'x'), 'x')).toBe(text);
  });

  it('round trips an empty string', async () => {
    const key = await rawKey();
    expect(await open(key, await seal(key, '', 'x'), 'x')).toBe('');
  });

  it('uses a fresh IV every time', async () => {
    // Reusing a nonce with the same key destroys both confidentiality and integrity in AES-GCM, which
    // is why there is no API for supplying one.
    const key = await rawKey();
    const ivs = new Set<string>();
    for (let i = 0; i < 32; i++) ivs.add((await seal(key, 'same text', 'same ctx')).iv);
    expect(ivs.size).toBe(32);
  });

  it('produces different ciphertext for the same plaintext', async () => {
    const key = await rawKey();
    const a = await seal(key, 'same', 'ctx');
    const b = await seal(key, 'same', 'ctx');
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('refuses a wrong key', async () => {
    const sealed = await seal(await rawKey(1), 'secret', 'ctx');
    await expect(open(await rawKey(2), sealed, 'ctx')).rejects.toBeInstanceOf(DecryptionError);
  });

  it('refuses ciphertext that has been altered', async () => {
    const key = await rawKey();
    const sealed = await seal(key, 'secret', 'ctx');
    const bytes = fromBase64Url(sealed.ciphertext);
    bytes[0] ^= 0xff;
    await expect(
      open(key, { ...sealed, ciphertext: toBase64Url(bytes) }, 'ctx'),
    ).rejects.toBeInstanceOf(DecryptionError);
  });

  it('refuses an altered IV', async () => {
    const key = await rawKey();
    const sealed = await seal(key, 'secret', 'ctx');
    const iv = fromBase64Url(sealed.iv);
    iv[0] ^= 0xff;
    await expect(open(key, { ...sealed, iv: toBase64Url(iv) }, 'ctx')).rejects.toBeInstanceOf(
      DecryptionError,
    );
  });

  it('refuses a record moved onto another record’s identity', async () => {
    // Without the record id as authenticated data, a server could swap two ciphertexts and both would
    // decrypt cleanly — silently putting one note's content under another note's id.
    const key = await rawKey();
    const sealed = await seal(key, 'note about Sarah', 'entries:aaa');
    await expect(open(key, sealed, 'entries:bbb')).rejects.toBeInstanceOf(DecryptionError);
  });

  it('reports a wrong key and tampering identically', async () => {
    // AES-GCM's tag fails the same way for both, and claiming to distinguish them would invent a
    // distinction the cryptography does not offer.
    const key = await rawKey();
    const sealed = await seal(key, 'secret', 'ctx');
    const wrongKey = open(await rawKey(9), sealed, 'ctx').catch((error) => String(error));
    const tampered = open(key, { ...sealed, ciphertext: toBase64Url(new Uint8Array(40)) }, 'ctx').catch(
      (error) => String(error),
    );
    expect(await wrongKey).toBe(await tampered);
  });

  it('handles a payload far larger than one AES block', async () => {
    const key = await rawKey();
    const long = 'x'.repeat(100_000);
    expect(await open(key, await seal(key, long, 'ctx'), 'ctx')).toBe(long);
  });
});

describe('verifier', () => {
  it('accepts the key that made it', async () => {
    const key = await rawKey();
    const verifier = await makeVerifier(key, 'space-1');
    expect(await checkVerifier(key, 'space-1', verifier)).toBe(true);
  });

  it('rejects a wrong passphrase at setup rather than at first sync', async () => {
    // Otherwise a typo on the second device produces a space that looks fine and then fails to
    // decrypt everything it pulls, which reads as corruption rather than a typo.
    const verifier = await makeVerifier(await rawKey(1), 'space-1');
    expect(await checkVerifier(await rawKey(2), 'space-1', verifier)).toBe(false);
  });

  it('rejects a verifier from a different space', async () => {
    const key = await rawKey();
    const verifier = await makeVerifier(key, 'space-1');
    expect(await checkVerifier(key, 'space-2', verifier)).toBe(false);
  });

  it('returns false rather than throwing on nonsense', async () => {
    const key = await rawKey();
    expect(await checkVerifier(key, 'space-1', { ciphertext: 'zzz', iv: 'zzz' })).toBe(false);
  });

  it('seals a known constant, so it reveals nothing about the user’s data', async () => {
    expect(VERIFIER_PLAINTEXT).toBe('remind.sync.v1');
  });
});
