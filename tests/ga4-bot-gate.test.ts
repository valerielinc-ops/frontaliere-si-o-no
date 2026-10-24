// @vitest-environment jsdom
/**
 * GA4 bot gate (2026-10-24): GA4 was the one producer outside the shared bot
 * verdict, so the 1280x1200 headless fleet reached the property as ~106k
 * sessions in 28 days (and the 1600x1600 Chrome 99 fleet ~11k more). The static gate (`GA4_BOT_GATE_FN`, used by
 * gtag-init.js and the /go/ redirect) and the SPA gate
 * (`isAutomatedAnalyticsVisitor()`, used before Firebase Analytics init) must
 * give the same verdict: isLikelyBot() OR a declared crawler/unfurler.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GA4_BOT_GATE_FN, GTAG_INIT_CONTENT } from '@/build-plugins/constants';
import { buildRedirectPage } from '@/build-plugins/affiliateRedirectPlugin';
import { isAutomatedAnalyticsVisitor } from '@/services/analyticsBotGate';
import { PARTNERS } from '@/services/affiliateService';

const inlineGate = new Function(`return (${GA4_BOT_GATE_FN});`)() as () => boolean;
const ORIGINAL_UA = window.navigator.userAgent;
const DESKTOP_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

function setUserAgent(ua: string): void {
  Object.defineProperty(window.navigator, 'userAgent', { configurable: true, get: () => ua });
}

let restorers: Array<() => void> = [];
function setRealDesktopChrome(): void {
  setUserAgent(DESKTOP_CHROME);
  const had = 'chrome' in window;
  if (!had) Object.defineProperty(window, 'chrome', { configurable: true, value: {} });
  restorers.push(() => { if (!had) delete (window as unknown as Record<string, unknown>).chrome; });
  for (const [key, value] of [['languages', ['it-CH', 'it']], ['plugins', { length: 3 }], ['permissions', { query: () => Promise.resolve({}) }]] as const) {
    const original = (navigator as unknown as Record<string, unknown>)[key];
    Object.defineProperty(window.navigator, key, { configurable: true, get: () => value });
    restorers.push(() => Object.defineProperty(window.navigator, key, { configurable: true, get: () => original }));
  }
}

beforeEach(() => {
  Object.defineProperty(window.navigator, 'webdriver', { configurable: true, get: () => false });
});
afterEach(() => {
  restorers.reverse().forEach((restore) => restore());
  restorers = [];
  setUserAgent(ORIGINAL_UA);
  delete (window as unknown as Record<string, unknown>).dataLayer;
});

describe('GA4 bot gate: static GA4_BOT_GATE_FN ≡ SPA isAutomatedAnalyticsVisitor()', () => {
  const automated: ReadonlyArray<readonly [string, string]> = [
    ['headless Chrome', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/124.0.0.0 Safari/537.36'],
    ['GPTBot', 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot'],
    // Declared crawlers that isLikelyBot() alone lets through: the crawler pattern adds them.
    ['Googlebot rendering', 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'],
    ['Bingbot', 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)'],
    ['facebookexternalhit', 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'],
    ['WhatsApp unfurler', 'WhatsApp/2.23.20.0'],
  ];
  for (const [name, ua] of automated) {
    it(`both skip GA4 for ${name}`, async () => {
      setUserAgent(ua);
      expect(inlineGate()).toBe(true);
      expect(await isAutomatedAnalyticsVisitor()).toBe(true);
    });
  }

  it('both keep GA4 for a real desktop Chrome', async () => {
    setRealDesktopChrome();
    expect(inlineGate()).toBe(false);
    expect(await isAutomatedAnalyticsVisitor()).toBe(false);
  });

  it('both keep GA4 for a CUBOT handset, whose model name contains the crawler `bot` token', async () => {
    // Real Android Chrome exposes `window.chrome`, like the desktop helper sets.
    setRealDesktopChrome();
    setUserAgent('Mozilla/5.0 (Linux; Android 12; CUBOT P50) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36');
    expect(inlineGate()).toBe(false);
    expect(await isAutomatedAnalyticsVisitor()).toBe(false);
  });

  it('both skip GA4 for the 1600x1600 zh-CN Chrome 99 fleet and keep it for current Chrome on that screen', async () => {
    setRealDesktopChrome();
    const win99 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/99.0.4844.51 Safari/537.36';
    const win133 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.6943.141 Safari/537.36';
    Object.defineProperty(window.screen, 'width', { configurable: true, get: () => 1600 });
    Object.defineProperty(window.screen, 'height', { configurable: true, get: () => 1600 });
    Object.defineProperty(window.navigator, 'language', { configurable: true, get: () => 'zh-CN' });
    restorers.push(() => {
      delete (window.screen as unknown as Record<string, unknown>).width;
      delete (window.screen as unknown as Record<string, unknown>).height;
      delete (window.navigator as unknown as Record<string, unknown>).language;
    });
    setUserAgent(win99);
    expect(inlineGate()).toBe(true);
    expect(await isAutomatedAnalyticsVisitor()).toBe(true);
    setUserAgent(win133);
    expect(inlineGate()).toBe(false);
    expect(await isAutomatedAnalyticsVisitor()).toBe(false);
  });

  it('both keep GA4 for iPhone Safari', async () => {
    setUserAgent(IPHONE_SAFARI);
    expect(inlineGate()).toBe(false);
    expect(await isAutomatedAnalyticsVisitor()).toBe(false);
  });
});

describe('gtag-init.js', () => {
  const runInit = () => new Function(GTAG_INIT_CONTENT)();

  it('sends no config and no page_view for an automated visitor', () => {
    setUserAgent('Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)');
    runInit();
    expect((window as unknown as { dataLayer?: unknown[] }).dataLayer).toBeUndefined();
  });

  it('still sends config + page_view for a real visitor', () => {
    setRealDesktopChrome();
    runInit();
    const queue = ((window as unknown as { dataLayer?: IArguments[] }).dataLayer || []).map((entry) => Array.from(entry));
    expect(queue.some(([command]) => command === 'config')).toBe(true);
    expect(queue.some(([command, name]) => command === 'event' && name === 'page_view')).toBe(true);
  });
});

describe('/go/ affiliate redirect', () => {
  it('redirects an automated visitor without queuing the GA4 page_view', () => {
    const html = buildRedirectPage(PARTNERS[0]);
    const gateAt = html.indexOf(`if((${GA4_BOT_GATE_FN})()){go();return;}`);
    expect(gateAt).toBeGreaterThan(html.indexOf('function go(){'));
    expect(gateAt).toBeLessThan(html.indexOf("gtag('config'"));
  });
});
