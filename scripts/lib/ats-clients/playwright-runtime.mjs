/**
 * playwright-runtime.mjs
 *
 * Shared Playwright helper for ATS crawlers (Workday, SuccessFactors, Greenhouse,
 * Lever, etc.) that require a real browser to render JS-driven listings.
 *
 * Flow:
 *
 *   ┌──────────────────┐
 *   │  createBrowser   │   launchChromium(headless, stealth args)
 *   └────────┬─────────┘
 *            │ Browser
 *            ▼
 *   ┌──────────────────────┐
 *   │ createPoliteContext  │   timezone=Europe/Zurich, locale=it-CH,
 *   │                      │   block images/fonts, default 60s timeout
 *   └────────┬─────────────┘
 *            │ BrowserContext (UA + WeakMap<context, lastReqMs>)
 *            ▼
 *   ┌──────────────────────┐    rate-limit gate
 *   │ fetchWithRateLimit   │ ── wait(now - last < minDelay) ──┐
 *   └────────┬─────────────┘                                  │
 *            │                                                ▼
 *            │   page.goto(url, {waitUntil: 'domcontentloaded'})
 *            │   anti-bot detection (status, title)
 *            ▼
 *         Page  ──► caller scrapes / parses
 *
 *   ┌──────────────────┐
 *   │     closeAll     │   browser.close()
 *   └──────────────────┘
 *
 * Public API:
 *   - createBrowser(options)
 *   - createPoliteContext(browser, options)
 *   - fetchWithRateLimit(context, url, options)
 *   - closeAll(browser)
 *
 * Errors (all subclasses of Error):
 *   - BrowserLaunchError
 *   - NavigationTimeout
 *   - AntiBotBlockError
 */

import { launchChromium } from '../ensure-chromium.mjs';
import { fetchWithRetry } from '../transient-fetch.mjs';
import { chromeUserAgent, isStealthBrowser, launchStealthOrChromium, stealthConfig } from '../stealth-browser.mjs';
import { passChallenge } from '../challenge-pass.mjs';

const DEFAULT_USER_AGENT =
  'FrontaliereTicino-Bot/1.0 (+https://frontaliereticino.ch/bot)';
const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
const DEFAULT_NAV_TIMEOUT_MS = 60_000;
const DEFAULT_MIN_DELAY_MS = 5_000;
const BLOCKED_RESOURCES_GLOB =
  '**/*.{png,jpg,jpeg,gif,webp,woff,woff2,ttf}';

/** Tracks the last request timestamp per BrowserContext for rate-limiting. */
const lastRequestAt = new WeakMap();

/**
 * Anti-bot escalation (owner decision 2026-11-09, STEALTH_BROWSER_CRAWLER):
 * per vanilla Browser, the CloakBrowser context its blocked contexts move to,
 * and the contexts already moved (their next fetches go straight there).
 */
const stealthByBrowser = new WeakMap();
const escalatedContexts = new WeakSet();

/**
 * Browser failed to launch (OOM, missing chromium binary, sandbox issue, …).
 */
export class BrowserLaunchError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = 'BrowserLaunchError';
    if (cause) this.cause = cause;
  }
}

/**
 * page.goto exceeded the configured navigation timeout.
 */
export class NavigationTimeout extends Error {
  constructor(message, { cause, url } = {}) {
    super(message);
    this.name = 'NavigationTimeout';
    if (cause) this.cause = cause;
    if (url) this.url = url;
  }
}

/**
 * Page returned a Cloudflare-style challenge, captcha, or "access denied"
 * marker — we've been classified as a bot.
 */
export class AntiBotBlockError extends Error {
  constructor(message, { url, status, title } = {}) {
    super(message);
    this.name = 'AntiBotBlockError';
    if (url) this.url = url;
    if (status !== undefined) this.status = status;
    if (title) this.title = title;
  }
}

/**
 * Launch a chromium browser with stealth-friendly defaults suitable for
 * polite ATS crawling.
 *
 * @param {object} [options]
 * @param {string} [options.userAgent] - Override the default UA string.
 * @returns {Promise<import('playwright').Browser>}
 * @throws {BrowserLaunchError} If chromium fails to launch.
 */
export async function createBrowser(options = {}) {
  // With the stealth escalation on, the first attempt no longer announces a
  // bot either: the browser's own Chrome user agent, without "Headless".
  const disguise = !options.userAgent && stealthConfig('crawler', options.env || process.env).enabled;
  try {
    const browser = await launchChromium({
      headless: true,
      args: ['--disable-blink-features=AutomationControlled'],
    });
    // Stash the UA on the browser instance for context creation.
    browser._frontaliereDefaultUserAgent = options.userAgent
      || (disguise ? chromeUserAgent(typeof browser.version === 'function' ? browser.version() : '') : DEFAULT_USER_AGENT);
    return browser;
  } catch (err) {
    const msg =
      '[playwright-runtime] chromium launch failed — ' +
      'check that the playwright browser binary is installed ' +
      '(npx playwright install chromium) and there is enough memory.';
    process.stderr.write(`${msg}\n${err && err.stack ? err.stack : err}\n`);
    throw new BrowserLaunchError(msg, { cause: err });
  }
}

/**
 * Create a "polite" BrowserContext: Swiss-Italian locale & timezone, blocked
 * heavy resources, default 60s navigation timeout. The returned context is
 * registered for per-context rate-limiting.
 *
 * @param {import('playwright').Browser} browser
 * @param {object} [options]
 * @param {string} [options.proxyServer] - Reserved for future use.
 * @param {string} [options.userAgent] - Override the browser-default UA.
 * @returns {Promise<import('playwright').BrowserContext>}
 */
export async function createPoliteContext(browser, options = {}) {
  const userAgent =
    options.userAgent ||
    browser._frontaliereDefaultUserAgent ||
    DEFAULT_USER_AGENT;

  const contextInit = {
    userAgent,
    viewport: DEFAULT_VIEWPORT,
    locale: 'it-CH',
    timezoneId: 'Europe/Zurich',
  };

  if (options.proxyServer) {
    contextInit.proxy = { server: options.proxyServer };
  }

  const context = await browser.newContext(contextInit);
  context.setDefaultNavigationTimeout(DEFAULT_NAV_TIMEOUT_MS);

  // Block images/fonts to keep crawls fast and quiet.
  await context.route(BLOCKED_RESOURCES_GLOB, (route) => route.abort());

  lastRequestAt.set(context, 0);
  return context;
}

/**
 * Open a new Page in the given context, navigate to `url`, and enforce a
 * minimum delay between consecutive requests on that context. Detects common
 * anti-bot challenge pages and throws AntiBotBlockError for them.
 *
 * @param {import('playwright').BrowserContext} context
 * @param {string} url
 * @param {object} [options]
 * @param {number} [options.minDelayMs=5000] - Minimum gap between requests.
 * @param {number} [options.navigationTimeoutMs=60000] - Default timeout for
 *   navigations in an escalated stealth context.
 * @returns {Promise<import('playwright').Page>}
 * @throws {NavigationTimeout} If page.goto times out or aborts.
 * @throws {AntiBotBlockError} If the response looks like a bot challenge.
 */
export async function fetchWithRateLimit(context, url, options = {}) {
  const minDelayMs =
    typeof options.minDelayMs === 'number'
      ? options.minDelayMs
      : DEFAULT_MIN_DELAY_MS;

  // Reserve a min-delay-spaced slot SYNCHRONOUSLY (read + write lastRequestAt
  // with no await in between) so concurrent fetches on the same context each get
  // a distinct slot instead of all reading the same timestamp, waiting the same
  // delta, and bursting together. Same race fixed in mymemory-translate.mjs.
  const now = Date.now();
  const slot = Math.max(now, lastRequestAt.get(context) || 0);
  lastRequestAt.set(context, slot + minDelayMs);
  const waitMs = slot - now;
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  process.stderr.write(
    `[playwright-runtime] GET ${url} (waited ${waitMs}ms)\n`,
  );

  // A context the escalation already moved goes straight to CloakBrowser.
  if (escalatedContexts.has(context)) {
    return fetchViaStealth(context, url, null, options);
  }

  try {
    return await fetchVanilla(context, url);
  } catch (err) {
    if (!(err instanceof AntiBotBlockError) || !stealthConfig('crawler', options.env || process.env).enabled) throw err;
    process.stderr.write(`[playwright-runtime] ${err.message} → CloakBrowser escalation\n`);
    return fetchViaStealth(context, url, err, options);
  }
}

function fetchVanilla(context, url) {
  // Retry only TRANSIENT navigation failures (page.goto timeout / network
  // blip → NavigationTimeout, #1308 Kantonsspital Obwalden). AntiBotBlockError
  // (403/429/522 / challenge title) is a PERSISTENT block, not transient: it
  // must not be retried on the same browser so the run surfaces the real
  // anti-bot signal rather than hammering the origin (the stealth escalation
  // above is the one second attempt). A fresh Page is opened per attempt and
  // closed on failure so retries never leak pages.
  return fetchWithRetry(
    async () => {
      const page = await context.newPage();

      let response;
      try {
        response = await page.goto(url, { waitUntil: 'domcontentloaded' });
      } catch (err) {
        process.stderr.write(
          `[playwright-runtime] navigation failed for ${url}: ` +
            `${err && err.message ? err.message : err}\n`,
        );
        await safeClosePage(page);
        throw new NavigationTimeout(
          `Navigation to ${url} failed: ${err && err.message ? err.message : err}`,
          { cause: err, url },
        );
      }

      const status = response ? response.status() : 0;

      // Cloudflare / origin overload signals strongly correlated with bot blocks.
      if (status === 522 || status === 403 || status === 429) {
        const title = await safeTitle(page);
        await safeClosePage(page);
        throw new AntiBotBlockError(
          `Anti-bot block on ${url} (status=${status}, title=${JSON.stringify(title)})`,
          { url, status, title },
        );
      }

      const title = await safeTitle(page);
      if (title && isAntiBotTitle(title)) {
        await safeClosePage(page);
        throw new AntiBotBlockError(
          `Anti-bot challenge page on ${url} (title=${JSON.stringify(title)})`,
          { url, status, title },
        );
      }

      return page;
    },
    {
      label: `playwright-runtime ${url}`,
      // Only NavigationTimeout is transient; AntiBotBlockError fails fast.
      isTransient: (err) => err instanceof NavigationTimeout,
    },
  );
}

/**
 * The CloakBrowser context for the vanilla browser behind `context`, launched
 * once. Null when the crawler key's only seat is taken or CloakBrowser cannot
 * start: the fallback would be the same vanilla Chromium that was just
 * blocked, so there is nothing to retry with.
 */
function stealthContextFor(context, options) {
  const owner = typeof context.browser === 'function' ? context.browser() : null;
  const key = owner || context;
  if (!stealthByBrowser.has(key)) {
    stealthByBrowser.set(key, (async () => {
      const browser = await launchStealthOrChromium({
        purpose: 'crawler',
        headless: true,
        locale: 'it-CH',
        env: options.env || process.env,
        deps: options.stealthDeps,
      });
      if (!isStealthBrowser(browser)) {
        await closeAll(browser);
        return null;
      }
      // No userAgent/locale/timezone here: CloakBrowser sets them as binary
      // flags, and a CDP override would be a tell. Images stay on too.
      // A context that cannot open must not strand the key's only seat:
      // nothing else holds this browser to close it later.
      let stealthContext;
      try {
        stealthContext = await browser.newContext();
      } catch (err) {
        await closeAll(browser);
        throw err;
      }
      stealthContext.setDefaultNavigationTimeout(
        typeof options.navigationTimeoutMs === 'number'
          ? options.navigationTimeoutMs
          : DEFAULT_NAV_TIMEOUT_MS,
      );
      return { browser, context: stealthContext };
    })().catch((err) => {
      process.stderr.write(`[playwright-runtime] CloakBrowser escalation unavailable: ${err && err.message ? err.message : err}\n`);
      return null;
    }));
  }
  return stealthByBrowser.get(key);
}

async function fetchViaStealth(context, url, blocked, options) {
  const stealth = await stealthContextFor(context, options);
  if (!stealth) {
    if (blocked) throw blocked;
    throw new AntiBotBlockError(`CloakBrowser escalation unavailable for ${url}`, { url });
  }
  // Same transient retry as the vanilla fetch: a timeout or network blip on
  // the CloakBrowser navigation must not drop the listing.
  const { page, response } = await fetchWithRetry(
    async () => {
      const attemptPage = await stealth.context.newPage();
      try {
        return { page: attemptPage, response: await attemptPage.goto(url, { waitUntil: 'domcontentloaded' }) };
      } catch (err) {
        await safeClosePage(attemptPage);
        throw new NavigationTimeout(
          `Navigation to ${url} failed (CloakBrowser): ${err && err.message ? err.message : err}`,
          { cause: err, url },
        );
      }
    },
    {
      label: `playwright-runtime CloakBrowser ${url}`,
      isTransient: (err) => err instanceof NavigationTimeout,
    },
  );
  const challenge = await passChallenge(page, {
    timeoutMs: options.challengeTimeoutMs ?? 30_000,
    log: (line) => process.stderr.write(`${line}\n`),
  });
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  const status = response ? response.status() : 0;
  const title = await safeTitle(page);
  // A challenge page answers 403/429 and reloads once cleared, so that status
  // only counts as a refusal when no challenge was on screen to begin with.
  const challenged = challenge.initial.interstitial || challenge.initial.turnstile;
  const hardBlock = [403, 429, 522].includes(status) && !challenged;
  if (!challenge.passed || hardBlock || (title && isAntiBotTitle(title))) {
    await safeClosePage(page);
    const err = new AntiBotBlockError(
      `Anti-bot block on ${url} also with CloakBrowser (status=${status}, title=${JSON.stringify(title)})`,
      { url, status, title },
    );
    err.stealthTried = true;
    throw err;
  }
  escalatedContexts.add(context);
  process.stderr.write(`[playwright-runtime] GET ${url} via CloakBrowser (status=${status})\n`);
  return page;
}

/**
 * Close the browser (and implicitly all its contexts/pages), and the
 * CloakBrowser the escalation opened for it — closing frees the key's seat.
 * Safe to call multiple times.
 *
 * @param {import('playwright').Browser | null | undefined} browser
 * @returns {Promise<void>}
 */
export async function closeAll(browser) {
  if (!browser) return;
  const stealth = stealthByBrowser.get(browser);
  if (stealth) {
    stealthByBrowser.delete(browser);
    const entry = await stealth;
    if (entry) await closeAll(entry.browser);
  }
  try {
    await browser.close();
  } catch (err) {
    process.stderr.write(
      `[playwright-runtime] browser.close() error (ignored): ` +
        `${err && err.message ? err.message : err}\n`,
    );
  }
}

// --- internal helpers -------------------------------------------------------

const ANTI_BOT_TITLE_MARKERS = [
  'captcha',
  'security check',
  'access denied',
  'attention required',
  'just a moment',
];

function isAntiBotTitle(title) {
  const lower = title.toLowerCase();
  return ANTI_BOT_TITLE_MARKERS.some((marker) => lower.includes(marker));
}

async function safeTitle(page) {
  try {
    return await page.title();
  } catch {
    return '';
  }
}

async function safeClosePage(page) {
  try {
    await page.close();
  } catch {
    /* no-op */
  }
}
