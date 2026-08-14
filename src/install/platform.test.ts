import { describe, expect, it } from 'vitest';
import {
  pushAvailability,
  shouldShowInstallSheet,
  type PlatformFacts,
} from './platform';

/**
 * The iOS permission sequence, as a decision table.
 *
 * Worth testing exhaustively rather than by inspection: on iOS a notification prompt fired from a
 * browser tab does not merely fail, it burns the user's one chance and cannot be re-asked without a
 * trip into system settings. Getting this table wrong is unrecoverable for that user.
 */

const facts = (overrides: Partial<PlatformFacts> = {}): PlatformFacts => ({
  isStandalone: false,
  isIos: false,
  hasServiceWorker: true,
  hasPushManager: true,
  hasNotification: true,
  permission: 'default',
  ...overrides,
});

describe('pushAvailability', () => {
  it('reports granted only when the device also holds a registration', () => {
    expect(pushAvailability(facts({ permission: 'granted' }), true)).toBe('granted');
    expect(pushAvailability(facts({ permission: 'denied' }), true)).toBe('denied');
    expect(
      pushAvailability(facts({ permission: 'denied', isIos: true, isStandalone: false }), true),
    ).toBe('denied');
  });

  it('treats a granted permission with no registration as available, not on', () => {
    // The state that shipped a lie: deleting the registration leaves the permission granted, and
    // reporting that as `granted` told the user reminders were on when no push could ever be
    // delivered — and let the sync card offer a setup that could not sign a request.
    expect(pushAvailability(facts({ permission: 'granted' }), false)).toBe('available');
  });

  it('still refuses an iOS tab even when permission was somehow granted', () => {
    // Permission can survive an uninstall. Re-registering needs PushManager, which the tab lacks.
    expect(
      pushAvailability(
        facts({ permission: 'granted', isIos: true, isStandalone: false, hasPushManager: false }),
        false,
      ),
    ).toBe('needs-install');
  });

  it('tells an iOS browser tab to install, rather than calling it unsupported', () => {
    // The actionable answer. In a tab, iOS does not expose PushManager at all.
    expect(
      pushAvailability(facts({ isIos: true, isStandalone: false, hasPushManager: false }), false),
    ).toBe('needs-install');
  });

  it('allows the request once iOS is running standalone', () => {
    expect(pushAvailability(facts({ isIos: true, isStandalone: true }), false)).toBe('available');
  });

  it('allows the request on a desktop browser without any install step', () => {
    expect(pushAvailability(facts({ isIos: false, isStandalone: false }), false)).toBe('available');
  });

  it('reports unsupported when the platform genuinely cannot do it', () => {
    expect(pushAvailability(facts({ hasServiceWorker: false }), false)).toBe('unsupported');
    expect(pushAvailability(facts({ hasNotification: false }), false)).toBe('unsupported');
    expect(pushAvailability(facts({ isIos: false, hasPushManager: false }), false)).toBe(
      'unsupported',
    );
    // A stale registration cannot conjure support that is not there.
    expect(pushAvailability(facts({ hasServiceWorker: false, permission: 'granted' }), true)).toBe(
      'unsupported',
    );
  });

  it('never returns available for an iOS tab, under any combination', () => {
    // The single most important property here.
    for (const hasPushManager of [true, false]) {
      for (const permission of ['default', 'granted'] as const) {
        for (const hasRegistration of [true, false]) {
          expect(
            pushAvailability(
              facts({ isIos: true, isStandalone: false, hasPushManager, permission }),
              hasRegistration,
            ),
            `pushManager=${hasPushManager} permission=${permission} registered=${hasRegistration}`,
          ).not.toBe('available');
        }
      }
    }
  });
});

describe('shouldShowInstallSheet', () => {
  it('shows on an iOS browser tab', () => {
    expect(shouldShowInstallSheet(facts({ isIos: true, isStandalone: false }), false)).toBe(true);
  });

  it('does not show once installed', () => {
    expect(shouldShowInstallSheet(facts({ isIos: true, isStandalone: true }), false)).toBe(false);
  });

  it('does not show after the user dismissed it', () => {
    expect(shouldShowInstallSheet(facts({ isIos: true, isStandalone: false }), true)).toBe(false);
  });

  it('does not show on platforms that do not need it', () => {
    // Android and desktop get a real install prompt from the browser, or need no install at all.
    expect(shouldShowInstallSheet(facts({ isIos: false, isStandalone: false }), false)).toBe(false);
  });
});
