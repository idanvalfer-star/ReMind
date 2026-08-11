import { createECDH, type ECDH } from 'node:crypto';
import ece from 'http_ece';
import { beforeAll, describe, expect, it } from 'vitest';
import { encryptPayload } from './encrypt';

/**
 * Differential tests against `http_ece` — the reference implementation of RFC 8188/8291,
 * written by the RFC's own author. Hand-rolled crypto is only defensible if its output is
 * checked against something authoritative, so this file is the justification for
 * `encrypt.ts` existing at all.
 *
 * Two complementary properties:
 *
 * 1. **Byte-exact.** With the salt and ephemeral keypair pinned, our body must equal the
 *    reference's exactly. This catches any deviation in key derivation, in the padding
 *    delimiter, or in header framing.
 * 2. **Round-trip.** With everything random, the reference must be able to *decrypt* what
 *    we produced. This is the property that actually matters in production: it is the same
 *    operation the browser performs, so passing it means a real device can read the push.
 *
 * `http_ece` is a devDependency only. It uses node's crypto and never ships to the Worker.
 */

/** Loads a WebCrypto P-256 private key into a node ECDH object, so both sides share one key. */
async function toNodeEcdh(privateKey: CryptoKey): Promise<ECDH> {
  const jwk = await crypto.subtle.exportKey('jwk', privateKey);
  const ecdh = createECDH('prime256v1');
  // setPrivateKey derives the matching public key itself.
  ecdh.setPrivateKey(Buffer.from(jwk.d!, 'base64url'));
  return ecdh;
}

async function generateEphemeral(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
}

/** Stands in for a browser's push subscription keys. */
function makeSubscriber() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    ecdh,
    publicKey: new Uint8Array(ecdh.getPublicKey()),
    authSecret: new Uint8Array(crypto.getRandomValues(new Uint8Array(16))),
  };
}

const PAYLOAD = new TextEncoder().encode(JSON.stringify({ t: '6f9619ff-8b86-d011-b42d-00c04fc964ff' }));

describe('encryptPayload — byte-exact against the reference', () => {
  let subscriber: ReturnType<typeof makeSubscriber>;
  let salt: Uint8Array;
  let ephemeral: CryptoKeyPair;

  beforeAll(async () => {
    subscriber = makeSubscriber();
    salt = crypto.getRandomValues(new Uint8Array(16));
    ephemeral = await generateEphemeral();
  });

  it('produces exactly the same body as http_ece', async () => {
    const ours = await encryptPayload({
      payload: PAYLOAD,
      uaPublicKey: subscriber.publicKey,
      authSecret: subscriber.authSecret,
      salt,
      ephemeralKeyPair: ephemeral,
    });

    const theirs = ece.encrypt(Buffer.from(PAYLOAD), {
      version: 'aes128gcm',
      salt: Buffer.from(salt),
      privateKey: await toNodeEcdh(ephemeral.privateKey),
      dh: Buffer.from(subscriber.publicKey),
      authSecret: Buffer.from(subscriber.authSecret),
    });

    expect(Buffer.from(ours).toString('base64url')).toBe(theirs.toString('base64url'));
  });

  it('lays the header out as salt || rs || idlen || as_public', async () => {
    const body = await encryptPayload({
      payload: PAYLOAD,
      uaPublicKey: subscriber.publicKey,
      authSecret: subscriber.authSecret,
      salt,
      ephemeralKeyPair: ephemeral,
    });

    expect(body.slice(0, 16)).toEqual(salt);
    expect(new DataView(body.buffer, body.byteOffset).getUint32(16, false)).toBe(4096);
    expect(body[20]).toBe(65);

    const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));
    expect(body.slice(21, 86)).toEqual(asPublic);

    // 21-byte header + 65-byte key + plaintext + 1 delimiter + 16 tag.
    expect(body.length).toBe(21 + 65 + PAYLOAD.length + 1 + 16);
  });

  it('matches the reference across a range of payload sizes', async () => {
    for (const size of [1, 15, 16, 17, 100, 3000]) {
      const payload = crypto.getRandomValues(new Uint8Array(size));
      const pinnedSalt = crypto.getRandomValues(new Uint8Array(16));
      const pinnedKey = await generateEphemeral();

      const ours = await encryptPayload({
        payload,
        uaPublicKey: subscriber.publicKey,
        authSecret: subscriber.authSecret,
        salt: pinnedSalt,
        ephemeralKeyPair: pinnedKey,
      });
      const theirs = ece.encrypt(Buffer.from(payload), {
        version: 'aes128gcm',
        salt: Buffer.from(pinnedSalt),
        privateKey: await toNodeEcdh(pinnedKey.privateKey),
        dh: Buffer.from(subscriber.publicKey),
        authSecret: Buffer.from(subscriber.authSecret),
      });

      expect(Buffer.from(ours).toString('base64url'), `size ${size}`).toBe(
        theirs.toString('base64url'),
      );
    }
  });
});

describe('encryptPayload — decryptable by the reference', () => {
  it('round-trips through http_ece, which is what the browser will do', async () => {
    const subscriber = makeSubscriber();

    // Nothing pinned: a fresh salt and ephemeral key, exactly as in production.
    const body = await encryptPayload({
      payload: PAYLOAD,
      uaPublicKey: subscriber.publicKey,
      authSecret: subscriber.authSecret,
    });

    const decrypted = ece.decrypt(Buffer.from(body), {
      version: 'aes128gcm',
      privateKey: subscriber.ecdh,
      authSecret: Buffer.from(subscriber.authSecret),
    });

    expect(decrypted.toString('utf8')).toBe(new TextDecoder().decode(PAYLOAD));
  });

  it('uses a fresh salt and ephemeral key for every message', async () => {
    // Reusing either across messages would be a real cryptographic failure, so this is
    // pinned rather than left to inspection.
    const subscriber = makeSubscriber();
    const bodies = await Promise.all(
      Array.from({ length: 5 }, () =>
        encryptPayload({
          payload: PAYLOAD,
          uaPublicKey: subscriber.publicKey,
          authSecret: subscriber.authSecret,
        }),
      ),
    );

    const salts = new Set(bodies.map((b) => Buffer.from(b.slice(0, 16)).toString('hex')));
    const keys = new Set(bodies.map((b) => Buffer.from(b.slice(21, 86)).toString('hex')));
    expect(salts.size).toBe(5);
    expect(keys.size).toBe(5);
  });

  it('is decryptable for each of several independent subscribers', async () => {
    for (let i = 0; i < 3; i++) {
      const subscriber = makeSubscriber();
      const body = await encryptPayload({
        payload: PAYLOAD,
        uaPublicKey: subscriber.publicKey,
        authSecret: subscriber.authSecret,
      });
      const decrypted = ece.decrypt(Buffer.from(body), {
        version: 'aes128gcm',
        privateKey: subscriber.ecdh,
        authSecret: Buffer.from(subscriber.authSecret),
      });
      expect(decrypted.toString('utf8')).toBe(new TextDecoder().decode(PAYLOAD));
    }
  });
});

describe('encryptPayload — input validation', () => {
  it('rejects a p256dh that is not an uncompressed point', async () => {
    const subscriber = makeSubscriber();
    await expect(
      encryptPayload({
        payload: PAYLOAD,
        uaPublicKey: new Uint8Array(64),
        authSecret: subscriber.authSecret,
      }),
    ).rejects.toThrow(/65-byte uncompressed point/);
  });

  it('rejects a malformed auth secret', async () => {
    const subscriber = makeSubscriber();
    await expect(
      encryptPayload({
        payload: PAYLOAD,
        uaPublicKey: subscriber.publicKey,
        authSecret: new Uint8Array(8),
      }),
    ).rejects.toThrow(/auth secret must be 16 bytes/);
  });

  it('refuses to silently truncate an oversized payload', async () => {
    const subscriber = makeSubscriber();
    await expect(
      encryptPayload({
        payload: new Uint8Array(4080),
        uaPublicKey: subscriber.publicKey,
        authSecret: subscriber.authSecret,
      }),
    ).rejects.toThrow(/exceeds the single-record limit/);
  });
});
