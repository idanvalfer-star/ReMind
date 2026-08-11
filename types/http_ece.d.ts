/**
 * Minimal declarations for `http_ece`, which ships no types.
 *
 * A devDependency used only by `worker/push/encrypt.test.ts`, where it serves as the
 * reference implementation our hand-written RFC 8291 encryption is diffed against. It never
 * ships to the Worker.
 *
 * Typed only as far as those tests use it — this is not an attempt at complete coverage of
 * the package's API.
 */
declare module 'http_ece' {
  import type { ECDH } from 'node:crypto';

  interface EceParams {
    /** Only `aes128gcm` is used here; the older `aesgcm` coding is not. */
    version: 'aes128gcm' | 'aesgcm';
    /** Pinned by tests so the comparison is byte-exact. Random when omitted. */
    salt?: Buffer;
    /** The application server's ephemeral key, as a node ECDH object. */
    privateKey?: ECDH;
    /** The recipient's public key — the subscription's `p256dh`. */
    dh?: Buffer;
    /** The subscription's `auth` secret. */
    authSecret?: Buffer;
    rs?: number;
  }

  export function encrypt(buffer: Buffer, params: EceParams): Buffer;
  export function decrypt(buffer: Buffer, params: EceParams): Buffer;

  const ece: {
    encrypt: typeof encrypt;
    decrypt: typeof decrypt;
  };
  export default ece;
}
