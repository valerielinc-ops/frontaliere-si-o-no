/**
 * Shared anti-bot widget client for Swiss career portals running Cloudflare-
 * protected POST widget endpoints.
 *
 * Covers two ATS platforms used by Swiss employers:
 *
 *   PastaHR / publicjobs.ch — `https://www.publicjobs.ch/widget`
 *     Clients: IGS Bern (#1783), GZO Wetzikon (#1679)
 *     Body format: application/x-www-form-urlencoded (URLSearchParams)
 *
 *   Phenom People — e.g. `https://careers.straumann.com/widgets`
 *     Clients: Straumann (#1751)
 *     Body format: application/json (JSON.stringify)
 *
 * Both endpoints enforce a Cloudflare WAF that rejects GitHub Actions datacenter
 * IPs when the UA or request fingerprint looks like a bot. This module centralises
 * the anti-bot workarounds:
 *
 *   1. Realistic Chrome 131 UA and the full browser-fingerprinting header set
 *      (`Sec-CH-UA-*`, `Sec-Fetch-*`, `Accept`, `Accept-Language`, `Referer`,
 *      `Origin`, `X-Requested-With`) that the in-page widget XHR actually sends.
 *      In the common CI case this is enough to clear the WAF.
 *
 *   2. Playwright POST fallback: when the endpoint still returns 403 (IP-reputation
 *      block that no header tweak can fix), we replay the POST through a real
 *      headless Chromium. The browser presents an authentic TLS fingerprint + JS
 *      execution environment that the WAF accepts. Returns null if Playwright is
 *      unavailable or the request fails; the caller then re-throws the original
 *      error (prior data preserved).
 *
 * Why not Jina? Jina Reader only supports GET; a POST payload cannot be replayed
 * through it, so the Playwright browser path is the correct last-resort here.
 *
 * Exported surface:
 *   PASTAHR_BROWSER_USER_AGENTS               — UA pool
 *   makePastaHrBrowserHeaders(ref, origin)    — build the full header set
 *   fetchPastaHrWidgetPage(params, opts)      — PastaHR/URLSearchParams fetch
 *   fetchPostWidgetWithAntiBotHardening(body, contentType, endpoint, opts)
 *                                             — generic POST widget fetch (Phenom etc.)
 */
import { launchChromium } from './ensure-chromium.mjs';

/* ── Browser UA pool (within the publicjobs.ch / Cloudflare accepted window) ── */

export const PASTAHR_BROWSER_USER_AGENTS = [
  // Rotate across OS/platform to reduce fingerprint correlation between runs.
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
];

const PASTAHR_ENDPOINT = 'https://www.publicjobs.ch/widget';

/**
 * Derive the `Sec-CH-UA-Platform` client-hint value from the chosen UA string.
 * Cloudflare cross-checks the platform hint against the UA: a desktop UA that
 * says macOS/Linux paired with a `"Windows"` hint is a *mismatched* fingerprint
 * (worse than a missing hint) and raises the bot score — defeating the purpose
 * of this client. Always pair the hint with the actual UA platform.
 */
export function platformHintForUserAgent(ua) {
  if (/Mac OS X|Macintosh/i.test(ua)) return '"macOS"';
  if (/Linux|X11/i.test(ua)) return '"Linux"';
  return '"Windows"';
}

/**
 * Build the full browser-fingerprinting header set for a publicjobs.ch
 * widget POST. These are the headers the in-page widget JS actually sends;
 * missing any of them increases the WAF bot-score.
 *
 * @param {string} referer  — the employer's career page URL (e.g. 'https://www.igsbern.ch/jobs/offene-stellen/')
 * @param {string} origin   — the employer domain origin   (e.g. 'https://www.igsbern.ch')
 * @param {string} [ua]     — User-Agent override; defaults to round-robin from PASTAHR_BROWSER_USER_AGENTS
 * @param {number} [attempt] — used for UA rotation
 */
export function makePastaHrBrowserHeaders(referer, origin, { ua, attempt = 0 } = {}) {
  const userAgent = ua || PASTAHR_BROWSER_USER_AGENTS[attempt % PASTAHR_BROWSER_USER_AGENTS.length];
  return {
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'de-CH,de;q=0.9,en;q=0.8',
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'User-Agent': userAgent,
    // Client-hint UA headers that Cloudflare uses to validate the UA string.
    // Without these a desktop Chrome UA paired with no sec-ch-ua raises the
    // bot score because real Chrome always sends these.
    'Sec-CH-UA': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': platformHintForUserAgent(userAgent),
    'X-Requested-With': 'XMLHttpRequest',
    Referer: referer,
    Origin: origin,
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'cross-site',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
  };
}

/**
 * Whether an HTTP status looks like the publicjobs.ch / Cloudflare anti-bot
 * fence. 429 is NOT here — it is routed as retryable-transient (backoff +
 * retry), not as an anti-bot block.
 */
function isAntiBotStatus(status) {
  return status === 403 || status === 401 || status === 406;
}

/**
 * Last-resort replay of a widget POST through a real headless Chromium.
 * The browser presents an authentic TLS fingerprint + JS execution environment
 * that the Cloudflare WAF accepts when a plain Node fetch (even with realistic
 * headers) is still blocked by IP-reputation rules.
 *
 * Uses Playwright's `page.evaluate` pattern: navigate to the employer's career
 * page (establishing the correct Referer/Origin context), then replay the POST
 * from within the page's JS execution context. This makes the request
 * indistinguishable from the in-page widget XHR.
 *
 * @param {string} bodyString    — serialised POST body (URLSearchParams.toString() or JSON.stringify())
 * @param {string} contentType   — e.g. 'application/x-www-form-urlencoded; charset=UTF-8' or 'application/json'
 * @param {string} endpoint      — the widget API URL
 * @param {Object} opts
 * @param {string} opts.referer  — employer's career page URL
 * @param {string} opts.origin   — employer's origin (scheme+host)
 * @param {string} [opts.ua]     — User-Agent
 * @param {number} [opts.timeoutMs]
 *
 * Returns the parsed JSON response, or null if Playwright is unavailable /
 * navigation fails / the response is not valid JSON.
 */
async function fetchWidgetViaPlaywright(bodyString, contentType, endpoint, { referer, origin, ua, timeoutMs }) {
  let browser;
  try {
    browser = await launchChromium({ headless: true });
    const playwrightUa = ua || PASTAHR_BROWSER_USER_AGENTS[0];
    const context = await browser.newContext({
      userAgent: playwrightUa,
      locale: 'de-CH',
      extraHTTPHeaders: {
        'Accept-Language': 'de-CH,de;q=0.9,en;q=0.8',
        'Sec-CH-UA': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        'Sec-CH-UA-Mobile': '?0',
        'Sec-CH-UA-Platform': platformHintForUserAgent(playwrightUa),
      },
    });
    const page = await context.newPage();

    // Navigate to the employer's career page first to establish the correct
    // Referer/Origin context — the widget POST is an XHR from that page.
    await page.goto(referer, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

    // Replay the widget POST from within the page's JS context.
    const result = await page.evaluate(
      async ({ ep, body, ct }) => {
        const res = await fetch(ep, {
          method: 'POST',
          headers: {
            Accept: 'application/json, text/javascript, */*; q=0.01',
            'Accept-Language': 'de-CH,de;q=0.9,en;q=0.8',
            'Content-Type': ct,
            'X-Requested-With': 'XMLHttpRequest',
          },
          body,
        });
        if (!res.ok) return { __error: res.status };
        return res.json();
      },
      { ep: endpoint, body: bodyString, ct: contentType },
    );
    if (result && result.__error) {
      console.warn(`[widget-pw] Playwright POST returned HTTP ${result.__error} from ${endpoint}`);
      return null;
    }
    return result;
  } catch (err) {
    console.warn(`[widget-pw] Playwright fallback failed: ${err?.message || err}`);
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// Keep the old name as an alias for backward compatibility (used internally).
function fetchPastaHrPageViaPlaywright(params, opts) {
  return fetchWidgetViaPlaywright(
    params.toString(),
    'application/x-www-form-urlencoded; charset=UTF-8',
    PASTAHR_ENDPOINT,
    opts,
  );
}

/**
 * Fetch one page from the publicjobs.ch widget API with full anti-bot
 * hardening.
 *
 * Steps:
 *   1. Attempt a plain Node fetch with realistic Chrome 131 headers.
 *   2. On 403 / 401 / 406 anti-bot fence: replay via a real headless Chromium
 *      (the browser's TLS fingerprint + JS context clears IP-reputation blocks).
 *   3. On null from Playwright (unavailable / timed out): re-throw the original
 *      error so the caller's safe-fail / prior-data-preserved path runs.
 *
 * @param {URLSearchParams} params   — POST body (caller builds the full payload)
 * @param {Object} opts
 * @param {string} opts.referer      — employer's career page URL
 * @param {string} opts.origin       — employer's origin (scheme+host)
 * @param {number} [opts.timeoutMs]  — per-attempt timeout (default 20 000 ms)
 * @param {number} [opts.attempt]    — UA rotation index (optional)
 * @returns {Promise<Object>}        — parsed JSON from the widget API
 */
export async function fetchPastaHrWidgetPage(params, { referer, origin, timeoutMs = 20000, attempt = 0 } = {}) {
  const ua = process.env.JOBS_CRAWLER_USER_AGENT
    || PASTAHR_BROWSER_USER_AGENTS[attempt % PASTAHR_BROWSER_USER_AGENTS.length];
  const headers = makePastaHrBrowserHeaders(referer, origin, { ua, attempt });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let firstStatus = null;
  try {
    const res = await fetch(PASTAHR_ENDPOINT, {
      method: 'POST',
      headers,
      body: params.toString(),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.ok) return await res.json();
    firstStatus = res.status;
    const err = new Error(`HTTP ${res.status} from ${PASTAHR_ENDPOINT}`);
    err.status = res.status;
    throw err;
  } catch (err) {
    clearTimeout(timer);
    // Anti-bot fence (403/401/406): retry once via headless browser, which
    // the WAF treats as a genuine visitor.
    const status = firstStatus ?? err?.status;
    if (isAntiBotStatus(status)) {
      console.warn(`[pastahr] HTTP ${status} from ${PASTAHR_ENDPOINT} — trying Playwright anti-bot fallback`);
      const result = await fetchPastaHrPageViaPlaywright(params, { referer, origin, ua, timeoutMs: 45000 });
      if (result !== null) return result;
      // Playwright unavailable or also blocked — re-throw original HTTP error.
    }
    throw err;
  }
}

/**
 * Generic anti-bot-hardened POST fetch for any JSON-body career widget endpoint
 * (e.g. Phenom People ATS, used by Straumann on `careers.straumann.com/widgets`).
 *
 * Applies the same Chrome 131 UA + client-hint header pattern as
 * `fetchPastaHrWidgetPage`, with one difference: the body is sent as
 * `application/json` instead of URL-encoded, and the endpoint is caller-supplied.
 *
 * The Playwright fallback replays the POST from within the browser's JS context
 * using the same JSON body and content-type, giving the WAF an authentic TLS
 * fingerprint that clears IP-reputation blocks.
 *
 * Steps:
 *   1. Plain Node fetch with Chrome 131 UA + full client-hint headers.
 *   2. On 403 / 401 / 406: Playwright browser POST fallback.
 *   3. Playwright null → re-throw original error.
 *
 * @param {string|object} body       — request body; objects are JSON-serialised automatically
 * @param {string}        endpoint   — full widget API URL
 * @param {Object}        opts
 * @param {string}        opts.referer      — career page URL (establishes WAF context)
 * @param {string}        opts.origin       — scheme+host of the career page
 * @param {number}        [opts.timeoutMs]  — per-attempt timeout (default 20 000 ms)
 * @param {number}        [opts.attempt]    — UA rotation index
 * @returns {Promise<Object>} parsed JSON response
 */
export async function fetchPostWidgetWithAntiBotHardening(body, endpoint, { referer, origin, timeoutMs = 20000, attempt = 0 } = {}) {
  const ua = process.env.JOBS_CRAWLER_USER_AGENT
    || PASTAHR_BROWSER_USER_AGENTS[attempt % PASTAHR_BROWSER_USER_AGENTS.length];

  const bodyString = typeof body === 'string' ? body : JSON.stringify(body);
  const contentType = 'application/json';

  // Reuse the same header builder; the client-hint set is platform-agnostic.
  const headers = {
    ...makePastaHrBrowserHeaders(referer, origin, { ua, attempt }),
    // Override the PastaHR-specific content-type with JSON.
    'Content-Type': contentType,
    // Phenom People expects standard JSON Accept.
    Accept: 'application/json, text/javascript, */*; q=0.01',
    // Remove X-Requested-With — Phenom's widget JS does not send it.
    'X-Requested-With': undefined,
  };
  // Clean up the undefined key (Object spread keeps it; fetch ignores undefined values
  // but it is cleaner to delete it explicitly).
  delete headers['X-Requested-With'];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let firstStatus = null;
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: bodyString,
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.ok) return await res.json();
    firstStatus = res.status;
    const err = new Error(`HTTP ${res.status} from ${endpoint}`);
    err.status = res.status;
    throw err;
  } catch (err) {
    clearTimeout(timer);
    const status = firstStatus ?? err?.status;
    if (isAntiBotStatus(status)) {
      console.warn(`[widget] HTTP ${status} from ${endpoint} — trying Playwright anti-bot fallback`);
      const result = await fetchWidgetViaPlaywright(bodyString, contentType, endpoint, {
        referer,
        origin,
        ua,
        timeoutMs: 45000,
      });
      if (result !== null) return result;
    }
    throw err;
  }
}
