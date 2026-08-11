/**
 * Generates a VAPID keypair for Web Push.
 *
 *   npm run vapid:generate
 *
 * VAPID keys are an ECDSA P-256 pair (RFC 8292). The two halves are handled very
 * differently, and the difference matters:
 *
 * - The **public** key is not a secret. It is handed to the browser at subscribe time and
 *   ships inside the client bundle. It belongs in `wrangler.toml` under `[vars]`.
 * - The **private** key signs the JWT that authorises each push. Anyone holding it can
 *   send notifications to every device subscribed to this application. It goes into
 *   `wrangler secret put VAPID_PRIVATE_KEY` and nowhere else — not into the repo, not into
 *   a chat window, not into an issue.
 *
 * Run this yourself rather than having anyone run it for you. A keypair that has been
 * pasted anywhere should be regenerated; rotating it only costs each device a
 * re-subscribe.
 */

const KEY_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' };

function base64Url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

const pair = await crypto.subtle.generateKey(KEY_ALGORITHM, true, ['sign', 'verify']);

// The public key travels as the uncompressed EC point: 0x04 || X || Y, 65 bytes.
const publicKey = base64Url(await crypto.subtle.exportKey('raw', pair.publicKey));
// JWK `d` is the 32-byte private scalar, already base64url.
const { d: privateKey } = await crypto.subtle.exportKey('jwk', pair.privateKey);

console.log(`
VAPID keypair generated.

  Public key  (${publicKey.length} chars, not secret)
  ${publicKey}

  Private key (${privateKey.length} chars, SECRET)
  ${privateKey}

Next steps:

  1. Put the public key in wrangler.toml:

       [vars]
       VAPID_PUBLIC_KEY = "${publicKey}"
       VAPID_SUBJECT = "mailto:you@example.com"

     VAPID_SUBJECT must be a real mailto: or https: URL you control — push services use
     it to contact you if this application misbehaves, and some reject a missing or
     obviously fake value.

  2. Store the private key as a Worker secret:

       npx wrangler secret put VAPID_PRIVATE_KEY

     Paste it at the prompt. Do not put it in wrangler.toml, a .env file, or anywhere git
     can see it.

  3. Scroll back and clear your terminal, so the private key is not left in scrollback.
`);
