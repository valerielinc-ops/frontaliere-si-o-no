/**
 * Stealth browser (owner decision 2026-11-09): CloakBrowser on a per-use
 * license key where a challenge stands in the way, the usual Chromium when the
 * flag is off, the key is missing, its only seat is taken, or the binary
 * cannot start — a run never fails because CloakBrowser could not open.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  browserEngine,
  chromeUserAgent,
  classifyStealthFailure,
  isStealthBrowser,
  launchStealthOrChromium,
  stealthConfig,
} from '../scripts/lib/stealth-browser.mjs';
import { challengeState, passChallenge } from '../scripts/lib/challenge-pass.mjs';

const KEY = 'cb_0123456789abcdef0123456789abcdef';
const SESSION_LIMIT = 'CloakBrowser Pro: session limit reached for your plan. Close another running session or upgrade your plan.';

function fakeBrowser(label: string) {
  return { label, close: vi.fn(async () => {}), isConnected: () => true, version: () => '156.0.8078.47' };
}

function deps({ launch, denial = null as unknown }: { launch: () => Promise<unknown>; denial?: unknown }) {
  const vanilla = fakeBrowser('chromium');
  return {
    vanilla,
    deps: {
      cloak: { launch: vi.fn(launch), licenseDenial: vi.fn(() => denial) },
      launchChromium: vi.fn(async () => vanilla),
      ensureChromiumInstalled: vi.fn(async () => {}),
      denialWaitMs: 0,
    },
  };
}

describe('stealthConfig', () => {
  it('is off by default and needs both the flag and a cb_ key', () => {
    expect(stealthConfig('crawler', {})).toMatchObject({ enabled: false, reason: 'disabled' });
    expect(stealthConfig('crawler', { STEALTH_BROWSER_CRAWLER: '1' })).toMatchObject({ enabled: false, reason: 'no_license_key' });
    expect(stealthConfig('crawler', { STEALTH_BROWSER_CRAWLER: '1', CLOAKBROWSER_LICENSE_KEY_CRAWLER: 'nope' }).enabled).toBe(false);
    expect(stealthConfig('crawler', { STEALTH_BROWSER_CRAWLER: '1', CLOAKBROWSER_LICENSE_KEY_CRAWLER: KEY })).toMatchObject({ enabled: true, licenseKey: KEY });
  });

  it('allows stealth only for the crawler purpose', () => {
    const env = { STEALTH_BROWSER_CRAWLER: '1', CLOAKBROWSER_LICENSE_KEY_CRAWLER: KEY };
    expect(stealthConfig('crawler', env).enabled).toBe(true);
    expect(() => stealthConfig('assisted' as never, env)).toThrow(/unknown purpose/);
    expect(() => stealthConfig('other' as never, env)).toThrow(/unknown purpose/);
  });
});

describe('classifyStealthFailure', () => {
  it.each([
    [SESSION_LIMIT, 'session_in_use'],
    ['CloakBrowser Pro: license key is invalid, expired, or missing. Check CLOAKBROWSER_LICENSE_KEY.', 'license_invalid'],
    ["CloakBrowser Pro: couldn't verify your license (license server unreachable or a connection problem).", 'license_unreachable'],
    ["Cannot find package 'cloakbrowser' imported from /x.mjs", 'not_installed'],
    ['error while loading shared libraries: libnss3.so', 'missing_system_libs'],
    ['Target page, context or browser has been closed', 'launch_error'],
  ])('%s → %s', (message, reason) => {
    expect(classifyStealthFailure(new Error(message))).toBe(reason);
  });
});

describe('launchStealthOrChromium', () => {
  const env = { STEALTH_BROWSER_CRAWLER: '1', CLOAKBROWSER_LICENSE_KEY_CRAWLER: KEY };

  it('uses Chromium, untouched, when the flag is off', async () => {
    const { deps: d, vanilla } = deps({ launch: async () => fakeBrowser('cloak') });
    const browser = await launchStealthOrChromium({ purpose: 'crawler', headless: false, env: {}, deps: d, log: () => {} });
    expect(browser).toBe(vanilla);
    expect(browserEngine(browser)).toEqual({ engine: 'chromium', reason: 'disabled' });
    expect(d.cloak.launch).not.toHaveBeenCalled();
    expect(d.launchChromium).toHaveBeenCalledWith({ headless: false });
  });

  it('launches CloakBrowser with the use\'s key, locale and timezone as binary options', async () => {
    const cloak = fakeBrowser('cloak');
    const { deps: d } = deps({ launch: async () => cloak });
    const lines: string[] = [];
    const browser = await launchStealthOrChromium({ purpose: 'crawler', headless: false, locale: 'de-CH', env, deps: d, log: (line: string) => lines.push(line) });
    expect(browser).toBe(cloak);
    expect(isStealthBrowser(browser)).toBe(true);
    expect(d.cloak.launch).toHaveBeenCalledWith({ licenseKey: KEY, headless: false, locale: 'de-CH', timezone: 'Europe/Zurich' });
    expect(lines.join('\n')).not.toContain(KEY);
  });

  it('passes the optional stealth proxy through', async () => {
    const { deps: d } = deps({ launch: async () => fakeBrowser('cloak') });
    await launchStealthOrChromium({ purpose: 'crawler', env: { ...env, STEALTH_BROWSER_PROXY: 'socks5://100.64.0.1:1080' }, deps: d, log: () => {} });
    expect(d.cloak.launch.mock.calls[0][0]).toMatchObject({ proxy: 'socks5://100.64.0.1:1080' });
  });

  it('falls back to Chromium when the key\'s only seat is in use', async () => {
    const { deps: d, vanilla } = deps({ launch: async () => { throw new Error(SESSION_LIMIT); } });
    const lines: string[] = [];
    const browser = await launchStealthOrChromium({ purpose: 'crawler', env, deps: d, log: (line: string) => lines.push(line) });
    expect(browser).toBe(vanilla);
    expect(browserEngine(browser)).toEqual({ engine: 'chromium', reason: 'session_in_use' });
    expect(lines.join('\n')).toMatch(/session_in_use/);
    expect(lines.join('\n')).not.toContain(KEY);
  });

  it('turns a seat refused after the handshake into the same fallback, closing the dying browser', async () => {
    const cloak = fakeBrowser('cloak');
    const { deps: d, vanilla } = deps({ launch: async () => cloak, denial: new Error(SESSION_LIMIT) });
    const browser = await launchStealthOrChromium({ purpose: 'crawler', env, deps: d, log: () => {} });
    expect(browser).toBe(vanilla);
    expect(cloak.close).toHaveBeenCalled();
    expect(browserEngine(browser).reason).toBe('session_in_use');
  });

  it('installs the missing system libraries once and retries CloakBrowser', async () => {
    const cloak = fakeBrowser('cloak');
    let calls = 0;
    const { deps: d } = deps({ launch: async () => { calls += 1; if (calls === 1) throw new Error('error while loading shared libraries: libnss3.so'); return cloak; } });
    const browser = await launchStealthOrChromium({ purpose: 'crawler', env: { STEALTH_BROWSER_CRAWLER: '1', CLOAKBROWSER_LICENSE_KEY_CRAWLER: KEY }, deps: d, log: () => {} });
    expect(browser).toBe(cloak);
    expect(d.ensureChromiumInstalled).toHaveBeenCalledTimes(1);
  });
});

describe('chromeUserAgent', () => {
  it('names the browser\'s own major version, never Headless', () => {
    const ua = chromeUserAgent('156.0.8078.47', 'linux');
    expect(ua).toBe('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36');
    expect(ua).not.toMatch(/headless|bot/i);
  });
});

type PageState = { title?: string; cfInterstitial?: boolean; turnstileToken?: boolean; turnstileWidget?: boolean };

function fakeChallengePage(states: PageState[], frameUrls: string[] = []) {
  let i = 0;
  const box = { x: 100, y: 200, width: 300, height: 65 };
  const frames = frameUrls.map((url) => ({ url: () => url, frameElement: async () => ({ boundingBox: async () => box }) }));
  return {
    frames: () => frames,
    evaluate: vi.fn(async () => ({ title: '', cfInterstitial: false, turnstileToken: false, turnstileWidget: false, ...states[Math.min(i++, states.length - 1)] })),
    waitForTimeout: vi.fn(async (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
    mouse: { move: vi.fn(async () => {}), click: vi.fn(async () => {}) },
  };
}

describe('challenge-pass', () => {
  it('waits out a Cloudflare interstitial until the page moves on', async () => {
    const page = fakeChallengePage([{ title: 'Just a moment...' }, { title: 'Just a moment...' }, { title: 'Jobs at Acme' }]);
    const result = await passChallenge(page as never, { timeoutMs: 2_000, pollMs: 5 });
    expect(result).toMatchObject({ passed: true, clicked: false });
    expect(result.initial.interstitial).toBe(true);
  });

  it('clicks a managed Turnstile once, on the left of its frame', async () => {
    const page = fakeChallengePage([{ turnstileWidget: true }], ['https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/xyz']);
    // The managed widget fills its token only once it has been clicked.
    page.evaluate.mockImplementation(async () => ({ title: 'Apply', cfInterstitial: false, turnstileWidget: true, turnstileToken: page.mouse.click.mock.calls.length > 0 }));
    const result = await passChallenge(page as never, { timeoutMs: 300, pollMs: 5 });
    expect(page.mouse.click).toHaveBeenCalledTimes(1);
    const [x, y] = page.mouse.click.mock.calls[0] as unknown as [number, number];
    expect(x).toBeGreaterThan(100);
    expect(x).toBeLessThan(140);
    expect(y).toBeGreaterThan(225);
    expect(y).toBeLessThan(240);
    expect(result.passed).toBe(true);
  });

  it('gives up at the deadline and says what is still on screen', async () => {
    const page = fakeChallengePage([{ title: 'Attention Required! | Cloudflare' }]);
    const result = await passChallenge(page as never, { timeoutMs: 40, pollMs: 5 });
    expect(result.passed).toBe(false);
    expect(result.state.interstitial).toBe(true);
  });

  it('reports a reCAPTCHA v2 or an hCaptcha without treating them as Cloudflare', async () => {
    const page = fakeChallengePage([{ title: 'Apply' }], [
      'https://www.google.com/recaptcha/api2/anchor?k=x&size=normal',
      'https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html',
    ]);
    const state = await challengeState(page as never);
    expect(state).toEqual({ interstitial: false, turnstile: false, recaptcha: true, hcaptcha: true });
    expect((await passChallenge(page as never, { timeoutMs: 20, pollMs: 5 })).passed).toBe(true);
  });

  it('does not count an invisible reCAPTCHA (v3) as a challenge to solve', async () => {
    const page = fakeChallengePage([{ title: 'Apply' }], ['https://www.google.com/recaptcha/api2/anchor?k=x&size=invisible']);
    expect((await challengeState(page as never)).recaptcha).toBe(false);
  });
});
