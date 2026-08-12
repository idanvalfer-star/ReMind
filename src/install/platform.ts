/**
 * Platform detection for the iOS install and permission sequence.
 *
 * This is where PWAs most often fail on iPhone, so the rules are made explicit rather than left
 * implicit in component logic:
 *
 * 1. Safari fires no `beforeinstallprompt`, so there is no way to offer installation
 *    programmatically. The only option is to show instructions.
 * 2. **Web Push does not exist until the app is on the home screen.** Asking for notification
 *    permission from a browser tab does not merely fail — on iOS it burns the prompt, and the user
 *    cannot be asked again without going into system settings.
 * 3. So permission may only be requested when running standalone, and only from an explicit tap.
 *
 * Every check is a pure function of injected values wherever possible, so the sequencing can be
 * tested without a browser.
 */

export type PushAvailability =
  /** Everything needed is present and permission can be requested. */
  | 'available'
  /** iOS Safari in a browser tab: must be installed to the home screen first. */
  | 'needs-install'
  /** The browser has no push support at all. */
  | 'unsupported'
  /** Permission was already refused; only system settings can undo that. */
  | 'denied'
  /** Already granted. */
  | 'granted';

export interface PlatformFacts {
  isStandalone: boolean;
  isIos: boolean;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  permission: NotificationPermission | 'unavailable';
}

/**
 * Reads the current platform state.
 *
 * `navigator.standalone` is the iOS-specific signal and is the one that actually matters there;
 * the `display-mode` media query covers everywhere else.
 */
export function readPlatform(): PlatformFacts {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  const iosStandalone = (nav as (Navigator & { standalone?: boolean }) | undefined)?.standalone;
  const displayModeStandalone =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(display-mode: standalone)').matches
      : false;

  const ua = nav?.userAgent ?? '';
  // iPadOS reports itself as a Mac, so touch points are the distinguishing signal.
  const isIpadOs = /Macintosh/.test(ua) && (nav?.maxTouchPoints ?? 0) > 1;

  return {
    isStandalone: iosStandalone === true || displayModeStandalone,
    isIos: /iPad|iPhone|iPod/.test(ua) || isIpadOs,
    hasServiceWorker: typeof nav !== 'undefined' && 'serviceWorker' in nav,
    hasPushManager: typeof window !== 'undefined' && 'PushManager' in window,
    hasNotification: typeof Notification !== 'undefined',
    permission: typeof Notification === 'undefined' ? 'unavailable' : Notification.permission,
  };
}

/**
 * Decides what, if anything, can be offered to the user.
 *
 * Pure, so the whole decision table is testable — which matters, because getting this wrong on iOS
 * costs the user their one chance to grant permission.
 */
export function pushAvailability(facts: PlatformFacts): PushAvailability {
  if (facts.permission === 'granted') return 'granted';
  if (facts.permission === 'denied') return 'denied';

  if (!facts.hasServiceWorker || !facts.hasNotification) return 'unsupported';

  // On iOS, PushManager only exists in a standalone window. Checking standalone first gives the
  // user an actionable answer ("install it") instead of a dead end ("unsupported").
  if (facts.isIos && !facts.isStandalone) return 'needs-install';
  if (!facts.hasPushManager) return facts.isIos ? 'needs-install' : 'unsupported';

  return 'available';
}

/** Whether to show the "add to home screen" instructions. */
export function shouldShowInstallSheet(
  facts: PlatformFacts,
  dismissedPreviously: boolean,
): boolean {
  if (dismissedPreviously) return false;
  if (facts.isStandalone) return false;
  return facts.isIos;
}
