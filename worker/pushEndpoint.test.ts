import { describe, expect, it } from 'vitest';
import { isAllowedPushEndpoint } from './pushEndpoint';

/**
 * This is a security boundary, not input tidying. `/api/subscribe` cannot be authenticated —
 * it is what establishes the signing key — and the cron POSTs to whatever endpoint a
 * subscription carries. Without this check the Worker is a request forwarder that anyone can
 * aim at private address space.
 */

describe('isAllowedPushEndpoint — accepts real push services', () => {
  it('accepts the services that actually exist', () => {
    for (const endpoint of [
      // Apple: the one that matters for an installed iOS PWA.
      'https://web.push.apple.com/QABC123def456',
      'https://fcm.googleapis.com/fcm/send/abc123:APA91b',
      'https://android.googleapis.com/gcm/send/abc123',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAAAA',
      // Edge uses many regional subdomains.
      'https://wns2-by3p.notify.windows.com/w/?token=BQYAAAB',
      'https://sin.notify.windows.com/w/?token=xyz',
    ]) {
      expect(isAllowedPushEndpoint(endpoint), endpoint).toBe(true);
    }
  });

  it('accepts a long opaque path and query, which is what these endpoints look like', () => {
    expect(
      isAllowedPushEndpoint(`https://web.push.apple.com/${'A'.repeat(300)}?a=1&b=2#frag`),
    ).toBe(true);
  });
});

describe('isAllowedPushEndpoint — refuses to be a request forwarder', () => {
  it('rejects private and loopback addresses', () => {
    for (const endpoint of [
      'https://localhost/push',
      'https://127.0.0.1/push',
      'https://[::1]/push',
      'https://10.0.0.5/push',
      'https://192.168.1.1/push',
      'https://172.16.0.1/push',
      // Cloud metadata services are the classic SSRF target.
      'https://169.254.169.254/latest/meta-data/',
    ]) {
      expect(isAllowedPushEndpoint(endpoint), endpoint).toBe(false);
    }
  });

  it('rejects arbitrary third parties', () => {
    for (const endpoint of [
      'https://example.com/push',
      'https://attacker.test/collect',
      'https://cloudflare.com/',
    ]) {
      expect(isAllowedPushEndpoint(endpoint), endpoint).toBe(false);
    }
  });

  it('rejects a hostname that merely contains an allowed name', () => {
    // The suffix match is on a dot boundary, so none of these pass.
    for (const endpoint of [
      'https://web.push.apple.com.attacker.test/push',
      'https://notify.windows.com.evil.test/push',
      'https://evilweb.push.apple.com/push',
      'https://fcm.googleapis.com.evil.test/push',
      'https://xnotify.windows.com/push',
    ]) {
      expect(isAllowedPushEndpoint(endpoint), endpoint).toBe(false);
    }
  });

  it('rejects non-https schemes', () => {
    for (const endpoint of [
      'http://web.push.apple.com/abc',
      'file:///etc/passwd',
      'ftp://web.push.apple.com/abc',
      'javascript:alert(1)',
      'data:text/plain,hello',
    ]) {
      expect(isAllowedPushEndpoint(endpoint), endpoint).toBe(false);
    }
  });

  it('rejects embedded credentials, which confuse origin comparisons', () => {
    expect(isAllowedPushEndpoint('https://user:pass@web.push.apple.com/abc')).toBe(false);
    expect(isAllowedPushEndpoint('https://attacker.test@web.push.apple.com/abc')).toBe(false);
    // The reverse trick: allowed host in the userinfo, attacker host as the real target.
    expect(isAllowedPushEndpoint('https://web.push.apple.com@attacker.test/abc')).toBe(false);
  });

  it('rejects anything that is not a parseable absolute URL', () => {
    for (const endpoint of ['', 'not a url', '/relative/path', 'web.push.apple.com/abc', '//x']) {
      expect(isAllowedPushEndpoint(endpoint), JSON.stringify(endpoint)).toBe(false);
    }
  });

  it('is case-insensitive about the hostname', () => {
    // Hostnames are case-insensitive, so casing must not be a bypass.
    expect(isAllowedPushEndpoint('https://WEB.PUSH.APPLE.COM/abc')).toBe(true);
    expect(isAllowedPushEndpoint('https://Web.Push.Apple.Com.evil.test/abc')).toBe(false);
  });
});
