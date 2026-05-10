/**
 * playwright-runtime.mjs
 *
 * Shared Playwright helper for ATS crawlers (Workday, SuccessFactors, Greenhouse,
 * Lever, etc.) that require a real browser to render JS-driven listings.
 *
 * Flow:
 *
 *   ┌──────────────────┐
 *   │  createBrowser   │   chromium.launch(headless, stealth args)
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

import { chromium } from 'playwright';

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
  const userAgent = options.userAgent || DEFAULT_USER_AGENT;
  try {
    const browser = await chromium.launch({
      headless: 'new',
      args: ['--disable-blink-features=AutomationControlled'],
    });
    // Stash the UA on the browser instance for context creation.
    browser._frontaliereDefaultUserAgent = userAgent;
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
 * @returns {Promise<import('playwright').Page>}
 * @throws {NavigationTimeout} If page.goto times out or aborts.
 * @throws {AntiBotBlockError} If the response looks like a bot challenge.
 */
export async function fetchWithRateLimit(context, url, options = {}) {
  const minDelayMs =
    typeof options.minDelayMs === 'number'
      ? options.minDelayMs
      : DEFAULT_MIN_DELAY_MS;

  const last = lastRequestAt.get(context) || 0;
  const now = Date.now();
  const elapsed = now - last;
  const waitMs = elapsed >= minDelayMs ? 0 : minDelayMs - elapsed;
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  process.stderr.write(
    `[playwright-runtime] GET ${url} (waited ${waitMs}ms)\n`,
  );

  lastRequestAt.set(context, Date.now());

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
}

/**
 * Close the browser (and implicitly all its contexts/pages). Safe to call
 * multiple times.
 *
 * @param {import('playwright').Browser | null | undefined} browser
 * @returns {Promise<void>}
 */
export async function closeAll(browser) {
  if (!browser) return;
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
