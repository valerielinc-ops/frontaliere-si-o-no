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
      try {
        expect(isLikelyBot()).toBe(false);
      } finally {
        if (!hadChrome) {
          delete (window as unknown as Record<string, unknown>).chrome;
        }
      }
    });

    it('returns false for desktop Firefox', () => {
      setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:125.0) Gecko/20100101 Firefox/125.0');
      expect(isLikelyBot()).toBe(false);
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
