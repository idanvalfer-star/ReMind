import { describe, expect, it } from 'vitest';
import {
  base64UrlDecode,
  base64UrlEncode,
  canonicalRequest,
  MAX_CLOCK_SKEW_MS,
  signRequest,
  SIGNING_KEY_ALGORITHM,
  verifyRequest,
} from './pushProtocol';

/**
 * These tests are the reason the canonicalisation lives in one shared module. A signature
 * scheme that is subtly asymmetric between client and server fails only in production, and
 * only for some requests.
 */

async function deviceKeys() {
  const pair = await crypto.subtle.generateKey(SIGNING_KEY_ALGORITHM, false, ['sign', 'verify']);
  const publicKeyJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { pair, publicKeyJwk };
}

describe('base64url', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 128, 64]);
    expect(base64UrlDecode(base64UrlEncode(bytes))).toEqual(bytes);
  });

  it('emits no characters that need escaping in a header', () => {
    // Signatures travel in an HTTP header, so +, / and = would all be trouble.
    const bytes = new Uint8Array(Array.from({ length: 64 }, (_, i) => (i * 7) % 256));
    const encoded = base64UrlEncode(bytes);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(base64UrlDecode(encoded)).toEqual(bytes);
  });

  it('handles an empty input', () => {
    expect(base64UrlEncode(new Uint8Array())).toBe('');
    expect(base64UrlDecode('')).toEqual(new Uint8Array());
  });
});

describe('canonicalRequest', () => {
  it('is stable for identical inputs', async () => {
    const a = await canonicalRequest('POST', '/api/schedule', 1000, '{"a":1}');
    const b = await canonicalRequest('POST', '/api/schedule', 1000, '{"a":1}');
    expect(a).toBe(b);
  });

  it('normalises the method but nothing else', async () => {
    expect(await canonicalRequest('post', '/api/schedule', 1000, '{}')).toBe(
      await canonicalRequest('POST', '/api/schedule', 1000, '{}'),
    );
  });

  it('changes when any component changes', async () => {
    const base = await canonicalRequest('POST', '/api/schedule', 1000, '{"a":1}');
    const variants = await Promise.all([
      canonicalRequest('POST', '/api/unschedule', 1000, '{"a":1}'),
      canonicalRequest('POST', '/api/schedule', 1001, '{"a":1}'),
      canonicalRequest('POST', '/api/schedule', 1000, '{"a":2}'),
    ]);
    for (const variant of variants) expect(variant).not.toBe(base);
  });

  it('includes the protocol version, so a scheme change cannot be replayed', async () => {
    const canonical = await canonicalRequest('POST', '/api/schedule', 1000, '{}');
    expect(canonical.split('\n')[0]).toBe('1');
  });
});

describe('signRequest / verifyRequest', () => {
  it('accepts a correctly signed request', async () => {
    const { pair, publicKeyJwk } = await deviceKeys();
    const body = JSON.stringify({ pushes: [{ triggerId: 'abc', fireAt: 123 }] });
    const timestamp = 1_700_000_000_000;
    const signature = await signRequest(pair.privateKey, 'POST', '/api/schedule', timestamp, body);

    await expect(
      verifyRequest(publicKeyJwk, signature, 'POST', '/api/schedule', timestamp, body, timestamp),
    ).resolves.toBe(true);
  });

  it('rejects a tampered body — this is the whole point', async () => {
    const { pair, publicKeyJwk } = await deviceKeys();
    const timestamp = 1_700_000_000_000;
    const body = JSON.stringify({ pushes: [{ triggerId: 'abc', fireAt: 123 }] });
    const signature = await signRequest(pair.privateKey, 'POST', '/api/schedule', timestamp, body);

    const tampered = JSON.stringify({ pushes: [{ triggerId: 'abc', fireAt: 999 }] });
    await expect(
      verifyRequest(
        publicKeyJwk,
        signature,
        'POST',
        '/api/schedule',
        timestamp,
        tampered,
        timestamp,
      ),
    ).resolves.toBe(false);
  });

  it('rejects a signature replayed against a different route', async () => {
    const { pair, publicKeyJwk } = await deviceKeys();
    const timestamp = 1_700_000_000_000;
    const body = '{}';
    const signature = await signRequest(pair.privateKey, 'POST', '/api/schedule', timestamp, body);

    await expect(
      verifyRequest(
        publicKeyJwk,
        signature,
        'POST',
        '/api/unsubscribe',
        timestamp,
        body,
        timestamp,
      ),
    ).resolves.toBe(false);
  });

  it('rejects another device’s key', async () => {
    const alice = await deviceKeys();
    const bob = await deviceKeys();
    const timestamp = 1_700_000_000_000;
    const signature = await signRequest(alice.pair.privateKey, 'POST', '/api/schedule', timestamp, '{}');

    await expect(
      verifyRequest(bob.publicKeyJwk, signature, 'POST', '/api/schedule', timestamp, '{}', timestamp),
    ).resolves.toBe(false);
  });

  it('rejects a stale timestamp outside the replay window', async () => {
    const { pair, publicKeyJwk } = await deviceKeys();
    const timestamp = 1_700_000_000_000;
    const signature = await signRequest(pair.privateKey, 'POST', '/api/schedule', timestamp, '{}');

    const tooOld = timestamp + MAX_CLOCK_SKEW_MS + 1;
    await expect(
      verifyRequest(publicKeyJwk, signature, 'POST', '/api/schedule', timestamp, '{}', tooOld),
    ).resolves.toBe(false);

    // A clock that is fast in the other direction is equally suspect.
    const tooNew = timestamp - MAX_CLOCK_SKEW_MS - 1;
    await expect(
      verifyRequest(publicKeyJwk, signature, 'POST', '/api/schedule', timestamp, '{}', tooNew),
    ).resolves.toBe(false);
  });

  it('tolerates a phone clock that is a little off', async () => {
    const { pair, publicKeyJwk } = await deviceKeys();
    const timestamp = 1_700_000_000_000;
    const signature = await signRequest(pair.privateKey, 'POST', '/api/schedule', timestamp, '{}');

    await expect(
      verifyRequest(
        publicKeyJwk,
        signature,
        'POST',
        '/api/schedule',
        timestamp,
        '{}',
        timestamp + MAX_CLOCK_SKEW_MS - 1,
      ),
    ).resolves.toBe(true);
  });

  it('returns false instead of throwing on malformed input from the open internet', async () => {
    const { publicKeyJwk } = await deviceKeys();
    const timestamp = 1_700_000_000_000;

    for (const signature of ['', 'not-base64url!!', 'AAAA']) {
      await expect(
        verifyRequest(publicKeyJwk, signature, 'POST', '/api/schedule', timestamp, '{}', timestamp),
      ).resolves.toBe(false);
    }
    await expect(
      verifyRequest({}, 'AAAA', 'POST', '/api/schedule', timestamp, '{}', timestamp),
    ).resolves.toBe(false);
    await expect(
      verifyRequest(publicKeyJwk, 'AAAA', 'POST', '/api/schedule', Number.NaN, '{}', timestamp),
    ).resolves.toBe(false);
  });
});
