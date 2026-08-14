/**
 * End-to-end encryption for sync.
 *
 * The server stores ciphertext and cannot read it. That is the whole design, and it is worth being
 * precise about what it does and does not buy, because "encrypted" is a word that gets used loosely:
 *
 * - The key is derived on the device from a passphrase the user types. It is never sent, never
 *   escrowed, and never recoverable. **A forgotten passphrase means the synced copy is unreadable
 *   forever.** That is not a bug to be fixed later; it is the property being paid for.
 * - The server learns record *ids*, *sizes* and *timestamps*. Those are metadata, they are real, and
 *   PRIVACY.md says so.
 *
 * Everything here is WebCrypto — no dependency. The derived key is imported **non-extractable**, so
 * once derived, nothing can read it back out, including this module. See `deriveSpaceSecrets` for the
 * one place the bytes exist transiently and why.
 */

/**
 * PBKDF2 iterations.
 *
 * OWASP's 2023 guidance for PBKDF2-HMAC-SHA256 is 600,000. It costs roughly a second on a phone,
 * which is acceptable for something typed once per device, and it is the difference between a
 * stolen database being brute-forceable against weak passphrases and not.
 */
export const PBKDF2_ITERATIONS = 600_000;

/** AES-GCM's nonce is 96 bits. Longer is not better here — the spec's construction assumes 12 bytes. */
const IV_BYTES = 12;

/** 128 bits of salt, random per space, stored in the clear alongside the ciphertext. */
const SALT_BYTES = 16;

export interface SpaceIdentity {
  /** Opaque, random, non-secret. Names the space on the server. */
  spaceId: string;
  /** Base64url. Non-secret by design: a KDF salt's job is uniqueness, not secrecy. */
  salt: string;
}

// ---------------------------------------------------------------- base64url

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Returns `Uint8Array<ArrayBuffer>` explicitly.
 *
 * WebCrypto rejects a view that TypeScript believes might be backed by a `SharedArrayBuffer`, so the
 * concrete type matters here rather than being pedantry.
 */
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------- identity

/** A fresh space: random id, random salt. Called once, on whichever device sets sync up first. */
export function newSpaceIdentity(): SpaceIdentity {
  return {
    spaceId: crypto.randomUUID(),
    salt: toBase64Url(crypto.getRandomValues(new Uint8Array(SALT_BYTES))),
  };
}

/**
 * The **space code**: what the user carries to a second device.
 *
 * Deliberately does *not* contain the passphrase or the key. It carries the space id and the salt,
 * both non-secret, so that a code intercepted in a screenshot or a chat message is not a compromise —
 * the passphrase is still required and is never transmitted anywhere at all.
 *
 * The alternative — deriving the space id from the passphrase — would mean a weak passphrase makes
 * your space *locatable* by guessing, turning an offline attack into an online one. Keeping the id
 * random and separate is what stops that.
 */
export function encodeSpaceCode(identity: SpaceIdentity): string {
  const payload = `${identity.spaceId}.${identity.salt}`;
  // Grouped for reading aloud and typing without losing your place.
  return toBase64Url(new TextEncoder().encode(payload)).replace(/(.{8})(?=.)/g, '$1-');
}

export function decodeSpaceCode(code: string): SpaceIdentity | null {
  try {
    // Grouping dashes and any whitespace the user's keyboard added are cosmetic.
    const text = new TextDecoder().decode(fromBase64Url(code.replace(/[-\s]/g, '')));
    const [spaceId, salt] = text.split('.');
    if (!spaceId || !salt) return null;
    // A space id is a UUID; anything else is a mistyped code rather than a different format.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(spaceId)) return null;
    return { spaceId, salt };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- keys

export interface SpaceSecrets {
  /** Non-extractable AES-256-GCM key. Encrypts every record. Never leaves the device. */
  key: CryptoKey;
  /**
   * A second secret derived from the same passphrase, used only to prove membership to the server.
   *
   * The server stores its SHA-256 and compares, so it can refuse a stranger who has seen a space code
   * while never holding anything that decrypts data. Without this, the space id alone — which travels
   * in a code the user might screenshot — would be enough to *write* into someone's space. Those writes
   * would be undecryptable garbage rather than a disclosure, but a space full of records that fail to
   * open is still a broken space.
   */
  joinSecret: string;
}

/**
 * Derives both secrets from the passphrase in a single PBKDF2 run.
 *
 * 64 bytes out, split down the middle: the first 32 become the AES key, the last 32 the join secret.
 * One run rather than two because 600,000 iterations is about a second on a phone and doing it twice
 * would double a wait the user already notices.
 *
 * The cost of `deriveBits` over `deriveKey` is that the key bytes exist transiently as a JavaScript
 * array before being imported. They are discarded immediately and the imported key is still
 * **non-extractable**, so nothing can read it back afterwards — but that momentary existence is a real
 * difference from `deriveKey`, and it is the price of getting two independent secrets from one run.
 */
export async function deriveSpaceSecrets(passphrase: string, salt: string): Promise<SpaceSecrets> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveBits'],
  );

  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: fromBase64Url(salt),
        iterations: PBKDF2_ITERATIONS,
        hash: 'SHA-256',
      },
      material,
      512,
    ),
  );

  const key = await crypto.subtle.importKey(
    'raw',
    bits.slice(0, 32),
    'AES-GCM',
    // Non-extractable: nothing can read this back out, including this module.
    false,
    ['encrypt', 'decrypt'],
  );
  const joinSecret = toBase64Url(bits.slice(32, 64));
  bits.fill(0);

  return { key, joinSecret };
}

/**
 * What the server stores to check membership.
 *
 * A plain SHA-256 rather than a slow hash, and that is correct here: the input is already 256 bits of
 * PBKDF2 output, not a password. There is nothing to brute-force.
 */
export async function hashJoinSecret(joinSecret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', fromBase64Url(joinSecret));
  return toBase64Url(new Uint8Array(digest));
}

// ---------------------------------------------------------------- payloads

export interface Sealed {
  /** Base64url ciphertext, including AES-GCM's appended authentication tag. */
  ciphertext: string;
  /** Base64url, 12 bytes, fresh for every single seal. */
  iv: string;
}

/**
 * Encrypts a record.
 *
 * A fresh random IV per call, which is not optional: AES-GCM catastrophically loses confidentiality
 * *and* integrity if a nonce is ever reused with the same key. That is why there is no API here for
 * supplying one.
 *
 * `additional` is authenticated but not encrypted, and the record id is passed through it. Without
 * that, a server could swap two records' ciphertexts and both would still decrypt cleanly — silently
 * moving one note's content onto another note's identity.
 */
export async function seal(key: CryptoKey, plaintext: string, additional: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(additional) },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { ciphertext: toBase64Url(new Uint8Array(ciphertext)), iv: toBase64Url(iv) };
}

export class DecryptionError extends Error {
  constructor() {
    super('could not decrypt: wrong passphrase, or the data has been tampered with');
    this.name = 'DecryptionError';
  }
}

/**
 * Decrypts a record, or throws.
 *
 * The two failures are indistinguishable and deliberately reported as one. AES-GCM's authentication
 * tag fails identically for a wrong key and for altered ciphertext, and pretending to tell them apart
 * would be inventing a distinction the cryptography does not provide.
 */
export async function open(
  key: CryptoKey,
  sealed: Sealed,
  additional: string,
): Promise<string> {
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: fromBase64Url(sealed.iv),
        additionalData: new TextEncoder().encode(additional),
      },
      key,
      fromBase64Url(sealed.ciphertext),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new DecryptionError();
  }
}

/**
 * A verifier stored with the space so a wrong passphrase is caught at setup, not at first sync.
 *
 * Without it, typing the passphrase wrong on the second device produces a space that appears to work
 * and then fails to decrypt every record it pulls — which reads as data corruption rather than a
 * typo. Sealing a known constant makes the check immediate and unambiguous.
 */
export const VERIFIER_PLAINTEXT = 'remind.sync.v1';

export async function makeVerifier(key: CryptoKey, spaceId: string): Promise<Sealed> {
  return seal(key, VERIFIER_PLAINTEXT, spaceId);
}

export async function checkVerifier(
  key: CryptoKey,
  spaceId: string,
  verifier: Sealed,
): Promise<boolean> {
  try {
    return (await open(key, verifier, spaceId)) === VERIFIER_PLAINTEXT;
  } catch {
    return false;
  }
}
