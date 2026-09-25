/**
 * Bot-gate parity — guards that the inline-JS bot gate embedded in static pages
 * (`BOT_GATE_FN` in build-plugins/constants.ts, reused by ADSENSE_LOADER_CONTENT
 * and POSTHOG_INIT_CONTENT) stays behaviourally identical to the TS
 * `isLikelyBot()` in services/botPatterns.ts used by the SPA.
 *
 * The two MUST agree: the SPA gates PostHog/AdSense via `isLikelyBot()`, the
 * externalised static scripts gate the same surfaces via the string twin. If a
 * pattern or stealth heuristic is added to one and not the other, bot traffic
 * leaks back onto one surface. This test evals `BOT_GATE_FN` and asserts it
 * returns the same verdict as `isLikelyBot()` across the full UA matrix.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isLikelyBot, matchesAutomationScreenSignature } from '@/services/botPatterns';
import { BOT_GATE_FN } from '@/build-plugins/constants';

// Eval the inline gate string into a callable. It reads the global `navigator`
// / `window` (jsdom), exactly as it would in a real browser static page.
const inlineGate = new Function(`return (${BOT_GATE_FN});`)() as () => boolean;

const ORIGINAL_UA = window.navigator.userAgent;
const ORIGINAL_WEBDRIVER = (window.navigator as Navigator & { webdriver?: boolean }).webdriver;

function setUserAgent(ua: string): void {
  Object.defineProperty(window.navigator, 'userAgent', { configurable: true, get: () => ua });
}

function setWebdriver(value: boolean | undefined): void {
  Object.defineProperty(window.navigator, 'webdriver', { configurable: true, get: () => value });
}

/** Make navigator look like a real desktop Chrome so stealth signals don't fire. */
function setRealBrowserNavigator(): () => void {
  const restorers: Array<() => void> = [];
  const overrides: Array<readonly [string, unknown]> = [
    ['languages', ['en-US', 'en']],
    ['plugins', { length: 3 }],
    ['permissions', { query: () => Promise.resolve({ state: 'prompt' }) }],
  ];
  for (const [key, value] of overrides) {
    const original = (navigator as unknown as Record<string, unknown>)[key];
    Object.defineProperty(window.navigator, key, { configurable: true, get: () => value });
    restorers.push(() => Object.defineProperty(window.navigator, key, { configurable: true, get: () => original }));
  }
  return () => restorers.forEach((r) => r());
}

describe('bot-gate parity: BOT_GATE_FN ≡ isLikelyBot()', () => {
  beforeEach(() => {
    setWebdriver(false);
  });

  afterEach(() => {
    setUserAgent(ORIGINAL_UA);
    setWebdriver(ORIGINAL_WEBDRIVER);
  });

  const botUserAgents: ReadonlyArray<readonly [string, string]> = [
    ['ChatGPT user', 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot'],
    ['ClaudeBot', 'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)'],
    ['PerplexityBot', 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot'],
    ['GPTBot', 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot'],
    ['Google-Extended', 'Mozilla/5.0 (compatible; Google-Extended/1.0)'],
    ['AhrefsBot', 'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)'],
    ['curl', 'curl/8.4.0'],
    ['python-requests', 'python-requests/2.31.0'],
  ];

  for (const [name, ua] of botUserAgents) {
    it(`both flag ${name} as bot`, () => {
      setUserAgent(ua);
      expect(inlineGate()).toBe(true);
      expect(inlineGate()).toBe(isLikelyBot());
    });
  }

  it('both pass real desktop Chrome', () => {
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    const hadChrome = 'chrome' in window;
    if (!hadChrome) Object.defineProperty(window, 'chrome', { configurable: true, value: {} });
    const restoreNav = setRealBrowserNavigator();
    try {
      expect(inlineGate()).toBe(false);
      expect(inlineGate()).toBe(isLikelyBot());
    } finally {
      restoreNav();
      if (!hadChrome) delete (window as unknown as Record<string, unknown>).chrome;
    }
  });

  it('both pass desktop Firefox', () => {
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:125.0) Gecko/20100101 Firefox/125.0');
    expect(inlineGate()).toBe(false);
    expect(inlineGate()).toBe(isLikelyBot());
  });

  it('both flag navigator.webdriver === true regardless of UA', () => {
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    setWebdriver(true);
    expect(inlineGate()).toBe(true);
    expect(inlineGate()).toBe(isLikelyBot());
  });

  it('both flag empty navigator.languages on a claimed desktop Chrome', () => {
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    Object.defineProperty(window, 'chrome', { configurable: true, value: {} });
    Object.defineProperty(window.navigator, 'languages', { configurable: true, get: () => [] });
    Object.defineProperty(window.navigator, 'plugins', { configurable: true, get: () => ({ length: 3 }) });
    Object.defineProperty(window.navigator, 'permissions', { configurable: true, get: () => ({}) });
    try {
      expect(inlineGate()).toBe(true);
      expect(inlineGate()).toBe(isLikelyBot());
    } finally {
      delete (window as unknown as Record<string, unknown>).chrome;
    }
  });
});

/**
 * Automation screen signature (1280x1200 Windows/Chrome fleet from Singapore,
 * GA4 2026-09): positive AND negative matrix, asserted on BOTH gates so the
 * static pages and the SPA exclude exactly the same visitors.
 */
describe('automation screen signature (1280x1200 Windows/Chrome)', () => {
  const WIN_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36';
  const WIN_CHROME_OLD = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/106.0.5249.119 Safari/537.36';
  const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  const WIN_FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0';
  const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

  const originalScreen = { width: window.screen.width, height: window.screen.height };
  const originalLanguage = window.navigator.language;
  let restoreNav: () => void = () => {};
  let hadChrome = false;

  function setScreen(width: number, height: number): void {
    Object.defineProperty(window.screen, 'width', { configurable: true, get: () => width });
    Object.defineProperty(window.screen, 'height', { configurable: true, get: () => height });
  }

  function setLanguage(language: string): void {
    Object.defineProperty(window.navigator, 'language', { configurable: true, get: () => language });
  }

  function setTimeZone(timeZone: string): void {
    const real = Intl.DateTimeFormat.prototype.resolvedOptions;
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (this: Intl.DateTimeFormat) {
      return { ...real.call(this), timeZone };
    });
  }

  beforeEach(() => {
    setWebdriver(false);
    // A real desktop browser in every other respect: only the signature decides.
    hadChrome = 'chrome' in window;
    if (!hadChrome) Object.defineProperty(window, 'chrome', { configurable: true, value: {} });
    restoreNav = setRealBrowserNavigator();
    setTimeZone('Europe/Zurich');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreNav();
    if (!hadChrome) delete (window as unknown as Record<string, unknown>).chrome;
    setScreen(originalScreen.width, originalScreen.height);
    setLanguage(originalLanguage);
    setUserAgent(ORIGINAL_UA);
    setWebdriver(ORIGINAL_WEBDRIVER);
  });

  function verdict(): boolean {
    const inline = inlineGate();
    expect(inline).toBe(isLikelyBot());
    return inline;
  }

  const positives: ReadonlyArray<readonly [string, string, string, string]> = [
    ['Chrome 116, English, Singapore time zone', WIN_CHROME, 'en-US', 'Asia/Singapore'],
    ['Chrome 106, English, UTC (cloud VM default)', WIN_CHROME_OLD, 'en-US', 'UTC'],
    ['Chrome 116, English, European time zone (proxy exit elsewhere)', WIN_CHROME, 'en-GB', 'Europe/Zurich'],
    ['Chrome 116, non-English UI but Singapore time zone', WIN_CHROME, 'zh-CN', 'Asia/Singapore'],
  ];
  for (const [name, ua, language, timeZone] of positives) {
    it(`flags the fleet: ${name}`, () => {
      setUserAgent(ua);
      setScreen(1280, 1200);
      setLanguage(language);
      vi.restoreAllMocks();
      setTimeZone(timeZone);
      expect(matchesAutomationScreenSignature(ua.toLowerCase())).toBe(true);
      expect(verdict()).toBe(true);
    });
  }

  const negatives: ReadonlyArray<readonly [string, string, number, number, string, string]> = [
    ['Italian visitor, real 1280x1024 monitor', WIN_CHROME, 1280, 1024, 'it-IT', 'Europe/Rome'],
    ['English visitor, 1280x720 laptop', WIN_CHROME, 1280, 720, 'en-US', 'Europe/Zurich'],
    ['English visitor, 1920x1200 monitor', WIN_CHROME, 1920, 1200, 'en-US', 'Asia/Singapore'],
    ['1280x1200 but Italian UI in a European time zone', WIN_CHROME, 1280, 1200, 'it-CH', 'Europe/Zurich'],
    ['1280x1200 but German UI in a European time zone', WIN_CHROME, 1280, 1200, 'de-CH', 'Europe/Zurich'],
    ['1280x1200 but macOS Chrome', MAC_CHROME, 1280, 1200, 'en-US', 'Asia/Singapore'],
    ['1280x1200 but Windows Firefox', WIN_FIREFOX, 1280, 1200, 'en-US', 'Asia/Singapore'],
    ['1280x1200 but mobile Chrome', ANDROID_CHROME, 1280, 1200, 'en-US', 'Asia/Singapore'],
    ['rotated 1200x1280', WIN_CHROME, 1200, 1280, 'en-US', 'Asia/Singapore'],
  ];
  for (const [name, ua, width, height, language, timeZone] of negatives) {
    it(`passes a real visitor: ${name}`, () => {
      setUserAgent(ua);
      setScreen(width, height);
      setLanguage(language);
      vi.restoreAllMocks();
      setTimeZone(timeZone);
      expect(matchesAutomationScreenSignature(ua.toLowerCase())).toBe(false);
      expect(verdict()).toBe(false);
    });
  }

  it('Intl without a time zone falls back to the language signal', () => {
    setUserAgent(WIN_CHROME);
    setScreen(1280, 1200);
    vi.restoreAllMocks();
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(() => {
      throw new Error('Intl unavailable');
    });
    setLanguage('it-IT');
    expect(verdict()).toBe(false);
    setLanguage('en-US');
    expect(verdict()).toBe(true);
  });
});
