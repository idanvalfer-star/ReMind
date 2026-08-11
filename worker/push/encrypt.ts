/**
 * Web Push payload encryption — `aes128gcm` content coding, RFC 8291.
 *
 * Hand-written against WebCrypto rather than taken from a library. The candidate packages
 * bundle a vendored JWT implementation including JWKS *verification*, none of which sending
 * a push needs, and this Worker holds the key that can notify every subscribed device — so
 * less code in that path is worth writing carefully.
 *
 * Correctness is not asserted, it is demonstrated: `encrypt.test.ts` diffs this byte-for-byte
 * against `http_ece`, the reference implementation written by RFC 8291's author, with the
 * salt and ephemeral key pinned so the comparison is exact.
 *
 * The scheme, for anyone reading this later:
 *
 *   ecdh   = ECDH(as_private, ua_public)                                    32 bytes
 *   ikm    = HKDF(salt=auth_secret, ikm=ecdh,
 *                 info="WebPush: info\0" || ua_public || as_public)         32 bytes
 *   cek    = HKDF(salt=random_salt, ikm, info="Content-Encoding: aes128gcm\0")  16 bytes
 *   nonce  = HKDF(salt=random_salt, ikm, info="Content-Encoding: nonce\0")      12 bytes
 *   body   = salt(16) || rs(4, big-endian) || idlen(1) || as_public(65) || AEAD
 *
 * WebCrypto's HKDF performs extract-then-expand in a single call, so deriving the key and
 * the nonce as two full HKDF invocations over the same salt and IKM yields the same PRK
 * internally. No hand-rolled HMAC is involved anywhere.
 */

const UNCOMPRESSED_POINT_LENGTH = 65;
const AUTH_SECRET_LENGTH = 16;
const SALT_LENGTH = 16;
const CEK_LENGTH = 16;
const NONCE_LENGTH = 12;
const AEAD_TAG_LENGTH = 16;

/** Header field. 4096 is what every push service accepts and what the reference uses. */
export const DEFAULT_RECORD_SIZE = 4096;

/** Marks the final record. A single-record message always ends with this byte. */
const LAST_RECORD_DELIMITER = 0x02;

const ECDH_P256: EcKeyImportParams = { name: 'ECDH', namedCurve: 'P-256' };

export interface EncryptPayloadInput {
  /** The plaintext. For ReMind this is a JSON object holding one opaque UUID. */
  payload: Uint8Array;
  /** The subscription's `p256dh`, decoded: an uncompressed P-256 point, 65 bytes. */
  uaPublicKey: Uint8Array;
  /** The subscription's `auth` secret, decoded: 16 bytes. */
  authSecret: Uint8Array;
  /**
   * Pinned only by tests. Production must let both default so every message gets a fresh
   * salt and a fresh ephemeral keypair — reusing either across messages would be a
   * genuine cryptographic failure, not a style problem.
   */
  salt?: Uint8Array | undefined;
  ephemeralKeyPair?: CryptoKeyPair | undefined;
  recordSize?: number | undefined;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Copies into a fresh ArrayBuffer-backed view, which is what `BufferSource` demands. */
function toBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.length));
  copy.set(bytes);
  return copy;
}

const ascii = (text: string) => new TextEncoder().encode(text);

async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  lengthBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', toBufferSource(ikm), 'HKDF', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: toBufferSource(salt),
      info: toBufferSource(info),
    },
    key,
    lengthBytes * 8,
  );
  return new Uint8Array(bits);
}

/**
 * Encrypts a push payload, returning the complete request body.
 *
 * Single-record only, which is a deliberate limit rather than an oversight: a ReMind push
 * carries one UUID, and multi-record framing is meaningful code for a case that cannot
 * arise. Oversized input throws instead of silently truncating.
 */
export async function encryptPayload({
  payload,
  uaPublicKey,
  authSecret,
  salt,
  ephemeralKeyPair,
  recordSize = DEFAULT_RECORD_SIZE,
}: EncryptPayloadInput): Promise<Uint8Array<ArrayBuffer>> {
  if (uaPublicKey.length !== UNCOMPRESSED_POINT_LENGTH) {
    throw new Error(
      `p256dh must be a ${UNCOMPRESSED_POINT_LENGTH}-byte uncompressed point, got ${uaPublicKey.length}`,
    );
  }
  if (authSecret.length !== AUTH_SECRET_LENGTH) {
    throw new Error(`auth secret must be ${AUTH_SECRET_LENGTH} bytes, got ${authSecret.length}`);
  }

  const maxPayload = recordSize - AEAD_TAG_LENGTH - 1;
  if (payload.length > maxPayload) {
    throw new Error(
      `payload of ${payload.length} bytes exceeds the single-record limit of ${maxPayload}`,
    );
  }

  const effectiveSalt = salt ?? crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  if (effectiveSalt.length !== SALT_LENGTH) {
    throw new Error(`salt must be ${SALT_LENGTH} bytes, got ${effectiveSalt.length}`);
  }

  const asKeyPair =
    ephemeralKeyPair ??
    (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']));

  const asPublicKey = new Uint8Array(await crypto.subtle.exportKey('raw', asKeyPair.publicKey));
  const uaKey = await crypto.subtle.importKey(
    'raw',
    toBufferSource(uaPublicKey),
    ECDH_P256,
    false,
    [],
  );

  // Raw ECDH output is the shared X coordinate.
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeyPair.privateKey, 256),
  );

  // Binding both public keys into the info is what ties the ciphertext to this exact
  // subscription, and is the step that distinguishes RFC 8291 from plain ECIES.
  const ikm = await hkdf(
    authSecret,
    ecdhSecret,
    concatBytes(ascii('WebPush: info\0'), uaPublicKey, asPublicKey),
    32,
  );

  const cek = await hkdf(effectiveSalt, ikm, ascii('Content-Encoding: aes128gcm\0'), CEK_LENGTH);
  const nonce = await hkdf(effectiveSalt, ikm, ascii('Content-Encoding: nonce\0'), NONCE_LENGTH);

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, tagLength: AEAD_TAG_LENGTH * 8 },
      aesKey,
      // The delimiter goes *after* the plaintext in aes128gcm, unlike the older aesgcm
      // coding which prefixed a padding length. Getting this backwards produces a body
      // that every push service accepts and no browser can decrypt.
      concatBytes(payload, new Uint8Array([LAST_RECORD_DELIMITER])),
    ),
  );

  const header = new Uint8Array(new ArrayBuffer(SALT_LENGTH + 4 + 1));
  header.set(effectiveSalt, 0);
  new DataView(header.buffer).setUint32(SALT_LENGTH, recordSize, false);
  header[SALT_LENGTH + 4] = asPublicKey.length;

  return concatBytes(header, asPublicKey, sealed);
}
