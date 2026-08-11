import { describe, expect, it } from 'vitest';
import { base64UrlDecode, base64UrlEncode } from '../../src/shared/pushProtocol';
import { vapidAuthorization } from './vapid';

/**
 * The JWT is verified here the same way a push service verifies it: parse the header, check
 * the claims, then check the signature against the `k` parameter carried alongside it. A
 * self-consistent token that a push service would accept is the property under test.
 */

async function generateVapidKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const publicKey = base64UrlEncode(await crypto.subtle.exportKey('raw', pair.publicKey));
  const { d } = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { publicKey, privateKey: d! };
}

/** Splits `vapid t=<jwt>, k=<key>` back into its parts. */
function parseAuthorization(value: string) {
  const match = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(value);
  if (!match) throw new Error(`malformed Authorization: ${value}`);
  const [, token, key] = match;
  const [header, claims, signature] = token!.split('.');
  const decode = (part: string) => JSON.parse(new TextDecoder().decode(base64UrlDecode(part)));
  return {
    token: token!,
    key: key!,
    header: decode(header!),
    claims: decode(claims!),
    signature: signature!,
    signingInput: `${header}.${claims}`,
  };
}

const ENDPOINT = 'https://web.push.apple.com/QABC123/some/subscriber/path?x=1';
const SUBJECT = 'mailto:someone@example.com';
const NOW = 1_700_000_000_000;

describe('vapidAuthorization', () => {
  it('produces a token a push service can verify with the advertised key', async () => {
    const keys = await generateVapidKeys();
    const parsed = parseAuthorization(
      await vapidAuthorization({ endpoint: ENDPOINT, subject: SUBJECT, ...keys, now: NOW }),
    );

    expect(parsed.header).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(parsed.key).toBe(keys.publicKey);

    const verifyKey = await crypto.subtle.importKey(
      'raw',
      base64UrlDecode(parsed.key),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    await expect(
      crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        verifyKey,
        base64UrlDecode(parsed.signature),
        new TextEncoder().encode(parsed.signingInput),
      ),
    ).resolves.toBe(true);
  });

  it('claims the endpoint origin only, not the subscriber path', async () => {
    // The path identifies the subscriber; repeating it in a signed claim would leak it into
    // somewhere it does not need to be.
    const keys = await generateVapidKeys();
    const { claims } = parseAuthorization(
      await vapidAuthorization({ endpoint: ENDPOINT, subject: SUBJECT, ...keys, now: NOW }),
    );

    expect(claims.aud).toBe('https://web.push.apple.com');
    expect(claims.aud).not.toContain('QABC123');
    expect(claims.sub).toBe(SUBJECT);
  });

  it('expires within the 24 hours RFC 8292 permits', async () => {
    const keys = await generateVapidKeys();
    const { claims } = parseAuthorization(
      await vapidAuthorization({ endpoint: ENDPOINT, subject: SUBJECT, ...keys, now: NOW }),
    );

    const nowSeconds = Math.floor(NOW / 1000);
    expect(claims.exp).toBeGreaterThan(nowSeconds);
    expect(claims.exp).toBeLessThanOrEqual(nowSeconds + 24 * 60 * 60);
  });

  it('emits a signature of the right shape — raw r||s, not DER', async () => {
    // WebCrypto gives raw r||s, which is what JWS wants. An implementation built on node's
    // crypto would produce DER here and every push would be rejected.
    const keys = await generateVapidKeys();
    const { signature } = parseAuthorization(
      await vapidAuthorization({ endpoint: ENDPOINT, subject: SUBJECT, ...keys, now: NOW }),
    );
    expect(base64UrlDecode(signature).length).toBe(64);
  });

  it('accepts an https: subject as well as mailto:', async () => {
    const keys = await generateVapidKeys();
    await expect(
      vapidAuthorization({ endpoint: ENDPOINT, subject: 'https://example.com/contact', ...keys }),
    ).resolves.toContain('vapid t=');
  });

  it('rejects a subject that is not a contact URL, rather than earning a confusing 403', async () => {
    const keys = await generateVapidKeys();
    for (const subject of ['', 'someone@example.com', 'http://example.com', 'change-me']) {
      await expect(
        vapidAuthorization({ endpoint: ENDPOINT, subject, ...keys }),
        subject,
      ).rejects.toThrow(/mailto: or https:/);
    }
  });

  it('rejects malformed key material', async () => {
    const keys = await generateVapidKeys();
    await expect(
      vapidAuthorization({
        endpoint: ENDPOINT,
        subject: SUBJECT,
        publicKey: base64UrlEncode(new Uint8Array(64)),
        privateKey: keys.privateKey,
      }),
    ).rejects.toThrow(/65-byte uncompressed P-256 point/);

    await expect(
      vapidAuthorization({
        endpoint: ENDPOINT,
        subject: SUBJECT,
        publicKey: keys.publicKey,
        privateKey: base64UrlEncode(new Uint8Array(16)),
      }),
    ).rejects.toThrow(/32-byte scalar/);
  });

  it('rejects a lifetime outside the permitted range', async () => {
    const keys = await generateVapidKeys();
    for (const ttlSeconds of [0, -1, 24 * 60 * 60 + 1]) {
      await expect(
        vapidAuthorization({ endpoint: ENDPOINT, subject: SUBJECT, ...keys, ttlSeconds }),
        String(ttlSeconds),
      ).rejects.toThrow(/token lifetime/);
    }
  });
});
