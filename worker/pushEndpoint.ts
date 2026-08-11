/**
 * Validates that a subscription endpoint belongs to a real push service.
 *
 * This is a security control, not tidiness. The Worker POSTs to whatever endpoint a
 * subscription carries, and `/api/subscribe` is necessarily unauthenticated — so without
 * this check, anyone could register an arbitrary URL and use the Worker as a request
 * forwarder into private address space or at a third party. Allowlisting the handful of
 * hosts that actually operate push services closes that off.
 *
 * The cost of the allowlist is that a browser shipping a brand-new push host stops working
 * until this list is updated. That is the right way round: failing closed on an unknown
 * host is recoverable, being an open relay is not.
 */

/** Hosts, or parent domains, that operate Web Push services. */
const ALLOWED_PUSH_HOSTS: readonly string[] = [
  // Apple — the one that matters for an installed iOS PWA.
  'web.push.apple.com',
  // Chrome and Chromium derivatives.
  'fcm.googleapis.com',
  'android.googleapis.com',
  // Firefox.
  'updates.push.services.mozilla.com',
  // Edge / Windows Notification Service, which uses many regional subdomains.
  'notify.windows.com',
  'push.services.mozilla.com',
];

function isHostAllowed(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return ALLOWED_PUSH_HOSTS.some(
    // Suffix match on a dot boundary only, so "evil-notify.windows.com.attacker.test"
    // cannot pass by containing an allowed name.
    (allowed) => host === allowed || host.endsWith(`.${allowed}`),
  );
}

/**
 * Whether `endpoint` is a usable push endpoint: a well-formed absolute HTTPS URL on a known
 * push host, with no embedded credentials.
 */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }

  if (url.protocol !== 'https:') return false;
  // Credentials in a URL are never legitimate here and confuse origin comparisons.
  if (url.username !== '' || url.password !== '') return false;
  return isHostAllowed(url.hostname);
}
