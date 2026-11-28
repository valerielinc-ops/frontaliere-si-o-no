// @vitest-environment jsdom
/**
 * Regression coverage for #20435 / #20436 —
 * `GA4 Exception: NS_ERROR_NOT_INITIALIZED` from the gstatic reCAPTCHA client
 * on Firefox. The GA4 `app_error` sink must apply the same "stack entirely
 * third-party" verdict as the PostHog `before_send` filter (fail-open).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  areAllOriginsThirdParty,
  extractStackOrigins,
  isThirdPartyOnlyStack,
} from '@/services/thirdPartyStackOrigins';

const RECAPTCHA = 'https://www.gstatic.com/recaptcha/releases/EXAMPLE_RELEASE/recaptcha__en.js';
const OURS = 'https://frontaliereticino.ch/assets/App-abc123.js';
const MESSAGE = 'NS_ERROR_NOT_INITIALIZED:';

const FIREFOX_RECAPTCHA_ONLY = [`e<@${RECAPTCHA}:140:87`, `f@${RECAPTCHA}:141:12`].join('\n');
const FIREFOX_MIXED = [`e<@${RECAPTCHA}:140:87`, `render@${OURS}:1:2345`].join('\n');
const CHROME_RECAPTCHA_ONLY = [
  'Error: boom',
  `    at e (${RECAPTCHA}:140:87)`,
  `    at ${RECAPTCHA}:141:12`,
  '    at Array.map (<anonymous>)',
].join('\n');
const CHROME_MIXED = [`    at e (${RECAPTCHA}:140:87)`, `    at render (${OURS}:1:2345)`].join('\n');

describe('thirdPartyStackOrigins parsing', () => {
  it('parses Firefox and Chrome frames to their script URL', () => {
    expect(extractStackOrigins(FIREFOX_RECAPTCHA_ONLY)).toEqual([RECAPTCHA, RECAPTCHA]);
    expect(extractStackOrigins(CHROME_RECAPTCHA_ONLY)).toEqual([RECAPTCHA, RECAPTCHA, '<anonymous>']);
  });

  it('fails open on empty, redacted and native-only stacks', () => {
    expect(isThirdPartyOnlyStack('')).toBe(false);
    expect(isThirdPartyOnlyStack('Nk@\nPk@')).toBe(false);
    expect(isThirdPartyOnlyStack('at :0:1')).toBe(false);
    expect(areAllOriginsThirdParty(['[native code]'])).toBe(false);
  });

  it('uses the filename fallback only when the stack has no frames', () => {
    expect(isThirdPartyOnlyStack('', RECAPTCHA)).toBe(true);
    expect(isThirdPartyOnlyStack('', OURS)).toBe(false);
  });
});

describe('GA4 global error tracking drops third-party-only stacks (#20435, #20436)', () => {
  let capture: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    const { Analytics } = await vi.importActual<typeof import('@/services/analytics')>('@/services/analytics');
    capture = (await import('@/services/posthog')).captureEvent as unknown as ReturnType<typeof vi.fn>;
    Analytics.initGlobalErrorTracking();
  });

  afterEach(() => capture.mockClear());

  const appErrors = () => capture.mock.calls.filter(([name]) => name === 'app_error').map(([, params]) => params);

  function throwError(stack: string, filename = ''): void {
    const error = new Error(MESSAGE);
    error.stack = stack;
    window.dispatchEvent(new ErrorEvent('error', { message: MESSAGE, error, filename, lineno: 140, colno: 87 }));
  }

  function rejectWith(stack: string): void {
    const reason = new Error(MESSAGE);
    reason.stack = stack;
    const event = new Event('unhandledrejection');
    Object.defineProperty(event, 'reason', { value: reason });
    window.dispatchEvent(event);
  }

  it('drops a Firefox stack made only of reCAPTCHA frames', () => {
    throwError(FIREFOX_RECAPTCHA_ONLY, RECAPTCHA);
    expect(appErrors()).toEqual([]);
  });

  it('drops a Chrome-format stack made only of third-party frames', () => {
    throwError(CHROME_RECAPTCHA_ONLY, RECAPTCHA);
    expect(appErrors()).toEqual([]);
  });

  it('drops the same signature arriving as an unhandled rejection', () => {
    rejectWith(FIREFOX_RECAPTCHA_ONLY);
    expect(appErrors()).toEqual([]);
  });

  it('drops a stackless error whose event.filename is reCAPTCHA', () => {
    throwError('', RECAPTCHA);
    expect(appErrors()).toEqual([]);
  });

  it('still emits when one frame is ours (Firefox and Chrome formats)', () => {
    throwError(FIREFOX_MIXED, OURS);
    throwError(CHROME_MIXED, OURS);
    expect(appErrors()).toHaveLength(2);
  });

  it('still emits for a rejection with a first-party frame', () => {
    rejectWith(FIREFOX_MIXED);
    expect(appErrors()).toHaveLength(1);
  });

  it('still emits when the stack is empty and the filename is ours or missing', () => {
    throwError('', '');
    throwError('', OURS);
    expect(appErrors()).toHaveLength(2);
  });
});
