// @vitest-environment jsdom
/**
 * Regression coverage for issue #8773 —
 * `GA4 Exception: unhandled_error — RangeError: Maximum call stack size exceeded.`
 *
 * The same infinite mutual recursion as #4173, in the variant whose frames are
 * NOT origin-redacted: WebKit attributes them to the DOCUMENT URL, so
 * `isOriginRedactedThirdPartyStack` cannot see it and the GA4 pipeline kept
 * filing it as a first-party `unhandled_error`.
 *
 * Production evidence (PostHog `$exception`, 90-day window to 2026-09-25):
 * 250/250 occurrences came from Chrome for iOS (`CriOS/`, 153 events / 45
 * sessions / 26 app versions) and the Google app (`GSA/`, 97 / 23 / 16);
 * zero from plain iOS Safari, Android, desktop or Firefox. No frame of any of
 * the 250 stacks points at one of our `/assets/*.js` chunks. The frames below
 * are verbatim (CriOS/153.0.8010.24, 2026-09-24): lines 187-226 of a static
 * job page that is 125 lines long — code the app injected into the page, not
 * the page's own inline scripts.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { isGoogleIosAppInjectedStackOverflow } from '@/services/benignErrorPatterns';

const DOC = 'https://frontaliereticino.ch/cerca-lavoro-ticino/case-anziani/';
const MESSAGE = 'RangeError: Maximum call stack size exceeded.';

/** WebKit-shaped stack (top frame first) rebuilt from the production frames. */
function injectedRecursionStack(doc: string, pairs = 40): string {
  const lines = [
    `@${doc}:190:70`,
    `@${doc}:197:363`,
    `@${doc}:190:41`,
    `@${doc}:198:237`,
    `Qk@${doc}:226:382`,
  ];
  for (let i = 0; i < pairs; i += 1) {
    lines.push(`Ok@${doc}:226:63`);
    lines.push(`Qk@${doc}:226:408`);
  }
  return lines.join('\n');
}

const INJECTED_STACK = injectedRecursionStack(DOC);

const UA = {
  chromeIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_6_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/153.0.8010.24 Mobile/15E148 Safari/604.1',
  googleAppIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) GSA/436.4.969249353 Mobile/15E148 Safari/604.1',
  safariIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_6_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  googleAppAndroid: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.0.0 Mobile Safari/537.36 GSA/15.33.40.29.arm64',
};

describe('isGoogleIosAppInjectedStackOverflow (#8773)', () => {
  it('recognises the production stack from Chrome for iOS', () => {
    expect(isGoogleIosAppInjectedStackOverflow(MESSAGE, INJECTED_STACK, UA.chromeIos)).toBe(true);
  });

  it('recognises the same stack from the Google app on iOS', () => {
    expect(isGoogleIosAppInjectedStackOverflow(MESSAGE, INJECTED_STACK, UA.googleAppIos)).toBe(true);
  });

  it('recognises the stackless variant (GA4 "(not set)" / `at undefined:188:70`)', () => {
    expect(isGoogleIosAppInjectedStackOverflow(MESSAGE, '', UA.chromeIos)).toBe(true);
    expect(isGoogleIosAppInjectedStackOverflow(MESSAGE, 'at undefined:188:70', UA.googleAppIos)).toBe(true);
  });

  it('KEEPS the same stack from plain iOS Safari — the engine alone never produced it', () => {
    expect(isGoogleIosAppInjectedStackOverflow(MESSAGE, INJECTED_STACK, UA.safariIos)).toBe(false);
  });

  it('KEEPS the Google app on Android (V8, no evidence there)', () => {
    expect(isGoogleIosAppInjectedStackOverflow(MESSAGE, INJECTED_STACK, UA.googleAppAndroid)).toBe(false);
  });

  it('KEEPS a Chrome-iOS stack overflow that runs through one of our chunks', () => {
    const ours = `walk@https://cdn.frontaliereticino.ch/assets/LivabilityIndex.js:12:3401\n${INJECTED_STACK}`;
    expect(isGoogleIosAppInjectedStackOverflow(MESSAGE, ours, UA.chromeIos)).toBe(false);
    const origin = `walk@https://frontaliereticino.ch/assets/index-entry.js:1:12\n${INJECTED_STACK}`;
    expect(isGoogleIosAppInjectedStackOverflow(MESSAGE, origin, UA.chromeIos)).toBe(false);
  });

  it('KEEPS any other error from Chrome for iOS', () => {
    expect(isGoogleIosAppInjectedStackOverflow('TypeError: undefined is not an object', INJECTED_STACK, UA.chromeIos)).toBe(false);
  });

  it('is a no-op for empty input', () => {
    expect(isGoogleIosAppInjectedStackOverflow('', '', '')).toBe(false);
    expect(isGoogleIosAppInjectedStackOverflow(MESSAGE, INJECTED_STACK, '')).toBe(false);
  });
});

describe('GA4 global error tracking drops the injected stack overflow (#8773)', () => {
  // `Analytics` methods are non-configurable (see the end of services/analytics.ts),
  // so the real handler is observed through its sink: every trackAppError()
  // mirrors an `app_error` event to PostHog's captureEvent (mocked in setup).
  let capture: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    const { Analytics } = await vi.importActual<typeof import('@/services/analytics')>('@/services/analytics');
    capture = (await import('@/services/posthog')).captureEvent as unknown as ReturnType<typeof vi.fn>;
    Analytics.initGlobalErrorTracking();
  });

  afterEach(() => {
    capture.mockClear();
    vi.restoreAllMocks();
  });

  const appErrors = () => capture.mock.calls.filter(([name]) => name === 'app_error').map(([, params]) => params);

  function throwOnPage(userAgent: string, stack: string, filename = DOC): void {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(userAgent);
    const error = new RangeError('Maximum call stack size exceeded.');
    error.stack = stack;
    window.dispatchEvent(new ErrorEvent('error', { message: MESSAGE, error, filename, lineno: 190, colno: 70 }));
  }

  it('does not report the production stack from Chrome for iOS', () => {
    throwOnPage(UA.chromeIos, INJECTED_STACK);
    expect(appErrors()).toEqual([]);
  });

  it('does not report the production stack from the Google app on iOS', () => {
    throwOnPage(UA.googleAppIos, INJECTED_STACK);
    expect(appErrors()).toEqual([]);
  });

  it('still reports the same stack from plain iOS Safari as unhandled_error', () => {
    throwOnPage(UA.safariIos, INJECTED_STACK);
    expect(appErrors()).toEqual([expect.objectContaining({ error_type: 'unhandled_error', is_fatal: true })]);
  });

  it('still reports a Chrome-iOS stack overflow thrown from one of our chunks', () => {
    const ours = 'walk@https://cdn.frontaliereticino.ch/assets/App.js:4:9001\nwalk@https://cdn.frontaliereticino.ch/assets/App.js:4:9001';
    throwOnPage(UA.chromeIos, ours, 'https://cdn.frontaliereticino.ch/assets/App.js');
    expect(appErrors()).toEqual([expect.objectContaining({ error_type: 'unhandled_error' })]);
  });

  it('does not report the same stack overflow as an unhandled rejection from Chrome for iOS', () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(UA.chromeIos);
    const reason = new RangeError('Maximum call stack size exceeded.');
    reason.stack = INJECTED_STACK;
    const event = new Event('unhandledrejection');
    Object.defineProperty(event, 'reason', { value: reason });
    window.dispatchEvent(event);
    expect(appErrors()).toEqual([]);
  });
});
