/**
 * VAPID request signing — RFC 8292.
 *
 * Identifies this application server to the push service. The signed JWT is what stops
 * anyone else pushing to our subscribers, and what gives the push service someone to
 * contact if we misbehave.
 *
 * WebCrypto's ECDSA output is already the raw `r || s` pair that JWS ES256 requires, so no
 * DER unwrapping is needed — a step that trips up implementations built on node's crypto.
 */

import { base64UrlDecode, base64UrlEncode } from '../../src/shared/pushProtocol';

const ECDSA_P256: EcKeyImportParams = { name: 'ECDSA', namedCurve: 'P-256' };
const ES256: EcdsaParams = { name: 'ECDSA', hash: 'SHA-256' };

/** RFC 8292 permits at most 24 hours; 12 leaves room for clock skew at either end. */
const DEFAULT_TTL_SECONDS = 12 * 60 * 60;
const MAX_TTL_SECONDS = 24 * 60 * 60;

export interface VapidInput {
  /** The subscription endpoint. Only its origin is used, as the `aud` claim. */
  endpoint: string;
  /** `mailto:` or `https:` URL the operator controls. */
  subject: string;
  /** Base64url, the 65-byte uncompressed point. */
  publicKey: string;
  /** Base64url, the 32-byte private scalar. Never logged, never returned. */
  privateKey: string;
  now?: number | undefined;
  ttlSeconds?: number | undefined;
}

const encoder = new TextEncoder();

function base64UrlJson(value: unknown): string {
  return base64UrlEncode(encoder.encode(JSON.stringify(value)));
}

/**
 * Rebuilds a signing key from the two halves as they are stored.
 *
 * The private scalar is kept on its own as a Worker secret, but WebCrypto will not import
 * a private EC key without the matching public coordinates — so they are recovered from
 * the public key, whose layout is `0x04 || X || Y`.
 */
async function importSigningKey(publicKey: string, privateKey: string): Promise<CryptoKey> {
  const point = base64UrlDecode(publicKey);
  if (point.length !== 65 || point[0] !== 0x04) {
    throw new Error('VAPID_PUBLIC_KEY must be a 65-byte uncompressed P-256 point');
  }
  const d = base64UrlDecode(privateKey);
  if (d.length !== 32) {
    throw new Error('VAPID_PRIVATE_KEY must be a 32-byte scalar');
  }

  return crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      x: base64UrlEncode(point.slice(1, 33)),
      y: base64UrlEncode(point.slice(33, 65)),
      d: privateKey,
      ext: false,
    },
    ECDSA_P256,
    false,
    ['sign'],
  );
}

/**
 * Builds the `Authorization` header value for a push request.
 *
 * Push services reject a subject that is missing or obviously not a contact address, so
 * that is validated here rather than left to a confusing 403 at delivery time.
 */
export async function vapidAuthorization({
  endpoint,
  subject,
  publicKey,
  privateKey,
  now = Date.now(),
  ttlSeconds = DEFAULT_TTL_SECONDS,
}: VapidInput): Promise<string> {
  if (!subject.startsWith('mailto:') && !subject.startsWith('https://')) {
    throw new Error(`VAPID_SUBJECT must be a mailto: or https: URL, got "${subject}"`);
  }
  if (ttlSeconds <= 0 || ttlSeconds > MAX_TTL_SECONDS) {
    throw new Error(`VAPID token lifetime must be between 1 and ${MAX_TTL_SECONDS} seconds`);
  }

  const header = base64UrlJson({ typ: 'JWT', alg: 'ES256' });
  const claims = base64UrlJson({
    // Origin only: the full endpoint path identifies the subscriber, and the push service
    // does not need it repeated in a signed claim.
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + ttlSeconds,
    sub: subject,
  });

  const signingInput = `${header}.${claims}`;
  const key = await importSigningKey(publicKey, privateKey);
  const signature = await crypto.subtle.sign(ES256, key, encoder.encode(signingInput));

  return `vapid t=${signingInput}.${base64UrlEncode(signature)}, k=${publicKey}`;
}
