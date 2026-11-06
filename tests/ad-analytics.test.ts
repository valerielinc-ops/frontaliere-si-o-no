/**
 * Ad analytics bot detection tests.
 *
 * Verifies that AI assistant user-agents (which render JS but produce zero-RPM
 * AdSense impressions) are correctly classified as bots, while real Chrome and
 * Firefox UAs pass through. Also verifies the navigator.webdriver shortcut.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isLikelyBot } from '@/services/adAnalytics';

const ORIGINAL_UA = window.navigator.userAgent;
const ORIGINAL_WEBDRIVER = (window.navigator as Navigator & { webdriver?: boolean }).webdriver;

function setUserAgent(ua: string): void {
  Object.defineProperty(window.navigator, 'userAgent', {
    configurable: true,
    get: () => ua,
  });
}

function setWebdriver(value: boolean | undefined): void {
  Object.defineProperty(window.navigator, 'webdriver', {
    configurable: true,
    get: () => value,
  });
}

/**
 * Make `navigator` look like a real desktop Chrome — overrides languages,
 * plugins, permissions so the modern stealth-detection signals in
 * isLikelyBot() don't fire on legitimate test UAs.
 */
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

describe('isLikelyBot', () => {
  beforeEach(() => {
    setWebdriver(false);
  });

  afterEach(() => {
    setUserAgent(ORIGINAL_UA);
    setWebdriver(ORIGINAL_WEBDRIVER);
  });

  describe('AI assistant user-agents are flagged', () => {
    const aiBotUserAgents: ReadonlyArray<readonly [string, string]> = [
      ['ChatGPT user', 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot'],
      ['ClaudeBot', 'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)'],
      ['PerplexityBot', 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot'],
      ['GPTBot', 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot'],
      ['Google-Extended', 'Mozilla/5.0 (compatible; Google-Extended/1.0)'],
      ['Applebot-Extended', 'Mozilla/5.0 (compatible; Applebot-Extended/1.0)'],
    ];

    for (const [name, ua] of aiBotUserAgents) {
      it(`returns true for ${name}`, () => {
        setUserAgent(ua);
        expect(isLikelyBot()).toBe(true);
      });
    }
  });

  describe('Real browsers are not flagged', () => {
    it('returns false for desktop Chrome', () => {
      setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
      // Ensure window.chrome exists so the "headless without chrome" heuristic doesn't fire.
      const hadChrome = 'chrome' in window;
      if (!hadChrome) {
        Object.defineProperty(window, 'chrome', { configurable: true, value: {} });
      }
      const restoreNav = setRealBrowserNavigator();
      try {
        expect(isLikelyBot()).toBe(false);
      } finally {
        restoreNav();
        if (!hadChrome) {
          delete (window as unknown as Record<string, unknown>).chrome;
        }
      }
    });

    it('returns false for desktop Firefox', () => {
      // Firefox UA does not contain "chrome" so the stealth-Chrome layer is bypassed entirely.
      setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:125.0) Gecko/20100101 Firefox/125.0');
      expect(isLikelyBot()).toBe(false);
    });

    it('returns false for mobile Chrome (plugins.length === 0 is legitimate on mobile)', () => {
      setUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36');
      Object.defineProperty(window, 'chrome', { configurable: true, value: {} });
      try {
        expect(isLikelyBot()).toBe(false);
      } finally {
        delete (window as unknown as Record<string, unknown>).chrome;
      }
    });
  });

  describe('Modern stealth signals on a claimed-Chrome desktop UA', () => {
    const DESKTOP_CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

    it('flags empty navigator.languages', () => {
      setUserAgent(DESKTOP_CHROME_UA);
      Object.defineProperty(window, 'chrome', { configurable: true, value: {} });
      Object.defineProperty(window.navigator, 'languages', { configurable: true, get: () => [] });
      Object.defineProperty(window.navigator, 'plugins', { configurable: true, get: () => ({ length: 3 }) });
      Object.defineProperty(window.navigator, 'permissions', { configurable: true, get: () => ({}) });
      try {
        expect(isLikelyBot()).toBe(true);
      } finally {
        delete (window as unknown as Record<string, unknown>).chrome;
      }
    });

    it('flags zero plugins on a claimed desktop Chrome', () => {
      setUserAgent(DESKTOP_CHROME_UA);
      Object.defineProperty(window, 'chrome', { configurable: true, value: {} });
      Object.defineProperty(window.navigator, 'languages', { configurable: true, get: () => ['en-US'] });
      Object.defineProperty(window.navigator, 'plugins', { configurable: true, get: () => ({ length: 0 }) });
      Object.defineProperty(window.navigator, 'permissions', { configurable: true, get: () => ({}) });
      try {
        expect(isLikelyBot()).toBe(true);
      } finally {
        delete (window as unknown as Record<string, unknown>).chrome;
      }
    });

    it('flags missing Permissions API', () => {
      setUserAgent(DESKTOP_CHROME_UA);
      Object.defineProperty(window, 'chrome', { configurable: true, value: {} });
      Object.defineProperty(window.navigator, 'languages', { configurable: true, get: () => ['en-US'] });
      Object.defineProperty(window.navigator, 'plugins', { configurable: true, get: () => ({ length: 3 }) });
      Object.defineProperty(window.navigator, 'permissions', { configurable: true, get: () => undefined });
      try {
        expect(isLikelyBot()).toBe(true);
      } finally {
        delete (window as unknown as Record<string, unknown>).chrome;
      }
    });
  });

  describe('navigator.webdriver shortcut', () => {
    it('returns true when navigator.webdriver === true regardless of UA', () => {
      setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
      setWebdriver(true);
      expect(isLikelyBot()).toBe(true);
    });
  });
});
