/**
 * Crawler anti-bot escalation (owner decision 2026-11-09). With
 * STEALTH_BROWSER_CRAWLER on, a page the vanilla Chromium could not get
 * (403/429/522 or a challenge title) is fetched once more in CloakBrowser on
 * the crawler's key, past the Cloudflare challenge; the context stays there.
 * With the flag off, or the key's only seat taken, the original
 * AntiBotBlockError surfaces exactly as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AntiBotBlockError,
  closeAll,
  fetchWithRateLimit,
} from '../scripts/lib/ats-clients/playwright-runtime.mjs';

const KEY = 'cb_0123456789abcdef0123456789abcdef';
const ON = { STEALTH_BROWSER_CRAWLER: '1', CLOAKBROWSER_LICENSE_KEY_CRAWLER: KEY };
const SESSION_LIMIT = 'CloakBrowser Pro: session limit reached for your plan.';

beforeEach(() => {
  process.env.JOBS_CRAWLER_RETRY_BASE_MS = '0';
});
afterEach(() => {
  delete process.env.JOBS_CRAWLER_RETRY_BASE_MS;
  vi.restoreAllMocks();
});

function blockedPage() {
  return {
    goto: vi.fn(async () => ({ status: () => 403 })),
    title: vi.fn(async () => 'Just a moment...'),
    close: vi.fn(async () => {}),
  };
}

function stealthPage(states: Array<{ title: string; cfInterstitial?: boolean }>, status = 403) {
  let i = 0;
  let title = states[0].title;
  return {
    goto: vi.fn(async () => ({ status: () => status })),
    title: vi.fn(async () => title),
    close: vi.fn(async () => {}),
    frames: () => [],
    evaluate: vi.fn(async () => {
      const state = states[Math.min(i++, states.length - 1)];
      title = state.title;
      return { title: state.title, cfInterstitial: Boolean(state.cfInterstitial), turnstileToken: false, turnstileWidget: false };
    }),
    waitForTimeout: vi.fn(async () => {}),
    waitForLoadState: vi.fn(async () => {}),
  };
}

function setup({ vanillaPages, stealthPages, launch }: {
  vanillaPages: unknown[];
  stealthPages: unknown[];
  launch?: () => Promise<unknown>;
}) {
  const vanillaBrowser = { close: vi.fn(async () => {}) };
  let v = 0;
  const context = { browser: () => vanillaBrowser, newPage: vi.fn(async () => vanillaPages[v++]) };
  let s = 0;
  const stealthContext = { newPage: vi.fn(async () => stealthPages[s++]), setDefaultNavigationTimeout: vi.fn() };
  const cloakBrowser = { close: vi.fn(async () => {}), isConnected: () => true, newContext: vi.fn(async () => stealthContext) };
  const cloak = { launch: vi.fn(launch || (async () => cloakBrowser)), licenseDenial: vi.fn(() => null) };
  const stealthDeps = {
    cloak,
    denialWaitMs: 0,
    launchChromium: vi.fn(async () => ({ close: vi.fn(async () => {}) })),
  };
  return { vanillaBrowser, context, stealthContext, cloakBrowser, cloak, stealthDeps };
}

describe('fetchWithRateLimit stealth escalation', () => {
  it('keeps failing fast when the flag is off', async () => {
    const t = setup({ vanillaPages: [blockedPage()], stealthPages: [] });
    await expect(fetchWithRateLimit(t.context as never, 'https://acme.test/jobs', { minDelayMs: 0, env: {}, stealthDeps: t.stealthDeps }))
      .rejects.toBeInstanceOf(AntiBotBlockError);
    expect(t.cloak.launch).not.toHaveBeenCalled();
  });

  it('re-fetches a blocked page in CloakBrowser, past the interstitial, and stays there', async () => {
    const first = stealthPage([{ title: 'Just a moment...', cfInterstitial: true }, { title: 'Jobs at Acme' }]);
    const second = stealthPage([{ title: 'Job 42 at Acme' }], 200);
    const t = setup({ vanillaPages: [blockedPage()], stealthPages: [first, second] });
    const options = {
      minDelayMs: 0,
      env: ON,
      stealthDeps: t.stealthDeps,
      challengeTimeoutMs: 2_000,
      navigationTimeoutMs: 1_000,
    };

    expect(await fetchWithRateLimit(t.context as never, 'https://acme.test/jobs', options)).toBe(first);
    expect(t.cloak.launch).toHaveBeenCalledWith(expect.objectContaining({ licenseKey: KEY, headless: true, locale: 'it-CH' }));
    // No CDP overrides on the stealth context: CloakBrowser's own fingerprint.
    expect(t.cloakBrowser.newContext).toHaveBeenCalledWith();
    expect(t.stealthContext.setDefaultNavigationTimeout).toHaveBeenCalledWith(1_000);

    expect(await fetchWithRateLimit(t.context as never, 'https://acme.test/jobs/42', options)).toBe(second);
    expect(t.context.newPage).toHaveBeenCalledTimes(1); // the second fetch skipped the vanilla browser
    expect(t.cloak.launch).toHaveBeenCalledTimes(1); // one CloakBrowser per vanilla browser

    await closeAll(t.vanillaBrowser as never);
    expect(t.cloakBrowser.close).toHaveBeenCalled(); // frees the key's seat
    expect(t.vanillaBrowser.close).toHaveBeenCalled();
  });

  it('surfaces the original block when the crawler key is already in use', async () => {
    const t = setup({
      vanillaPages: [blockedPage()],
      stealthPages: [],
      launch: async () => { throw new Error(SESSION_LIMIT); },
    });
    const error = await fetchWithRateLimit(t.context as never, 'https://acme.test/jobs', { minDelayMs: 0, env: ON, stealthDeps: t.stealthDeps })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(AntiBotBlockError);
    expect((error as Error).message).toMatch(/status=403/);
    expect(t.stealthDeps.launchChromium).toHaveBeenCalledTimes(1); // the fallback opened…
  });

  it('says the block held also with CloakBrowser when the refusal is not a challenge', async () => {
    const hard = stealthPage([{ title: 'Forbidden' }], 403);
    const t = setup({ vanillaPages: [blockedPage()], stealthPages: [hard] });
    const error = await fetchWithRateLimit(t.context as never, 'https://acme.test/jobs', { minDelayMs: 0, env: ON, stealthDeps: t.stealthDeps, challengeTimeoutMs: 50 })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(AntiBotBlockError);
    expect((error as { stealthTried?: boolean }).stealthTried).toBe(true);
    expect(hard.close).toHaveBeenCalled();
  });
});

describe('fetchWithRateLimit stealth escalation — review #17750', () => {
  it('retries a transient CloakBrowser navigation failure, then returns the page', async () => {
    const failing = stealthPage([{ title: 'Jobs at Acme' }]);
    failing.goto.mockImplementation(async () => { throw new Error('page.goto: Timeout 60000ms exceeded.'); });
    const succeeding = stealthPage([{ title: 'Jobs at Acme' }], 200);
    const t = setup({ vanillaPages: [blockedPage()], stealthPages: [failing, succeeding] });
    const page = await fetchWithRateLimit(t.context as never, 'https://acme.test/jobs', { minDelayMs: 0, env: ON, stealthDeps: t.stealthDeps });
    expect(page).toBe(succeeding);
    expect(failing.close).toHaveBeenCalled();
  });

  it('closes a launched CloakBrowser whose context cannot open, freeing the seat for the next escalation', async () => {
    const t = setup({ vanillaPages: [blockedPage(), blockedPage()], stealthPages: [] });
    t.cloakBrowser.newContext.mockRejectedValueOnce(new Error('context failed'));
    await expect(fetchWithRateLimit(t.context as never, 'https://acme.test/jobs', { minDelayMs: 0, env: ON, stealthDeps: t.stealthDeps }))
      .rejects.toBeInstanceOf(AntiBotBlockError);
    expect(t.cloakBrowser.close).toHaveBeenCalledTimes(1);
    await closeAll(t.vanillaBrowser as never);
    expect(t.vanillaBrowser.close).toHaveBeenCalled();
  });
});

describe('createBrowser user agent', () => {
  it('declares the bot unless the stealth escalation is on', async () => {
    vi.resetModules();
    vi.doMock('../scripts/lib/ensure-chromium.mjs', async (importOriginal) => ({
      ...(await importOriginal<Record<string, unknown>>()),
      launchChromium: vi.fn(async () => ({ version: () => '156.0.8078.47' })),
    }));
    const runtime = await import('../scripts/lib/ats-clients/playwright-runtime.mjs');
    const declared = await runtime.createBrowser({ env: {} });
    expect(declared._frontaliereDefaultUserAgent).toMatch(/^FrontaliereTicino-Bot\//);
    const disguised = await runtime.createBrowser({ env: ON });
    expect(disguised._frontaliereDefaultUserAgent).toMatch(/Chrome\/156\.0\.0\.0 Safari\/537\.36$/);
    expect(disguised._frontaliereDefaultUserAgent).not.toMatch(/bot|headless/i);
    vi.doUnmock('../scripts/lib/ensure-chromium.mjs');
  });
});
