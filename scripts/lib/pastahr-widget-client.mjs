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
 *      CROSS-ORIGIN CAVEAT (#3255): this fallback can only work when the widget
 *      endpoint is SAME-ORIGIN with the employer's career page (the Phenom/
 *      Straumann case: both on careers.straumann.com). For PastaHR (IGS Bern /
 *      GZO Wetzikon) the referer is the employer's own domain (igsbern.ch /
 *      gzo.ch) but the endpoint is www.publicjobs.ch — a genuinely cross-origin
 *      fetch from inside the page. When Cloudflare blocks that request it does
 *      not attach CORS headers to the block response, so the browser can never
 *      surface a status code to `page.evaluate` — it always throws a generic
 *      `TypeError: Failed to fetch`, indistinguishable from a real network
 *      failure. Incident logs (#3255) show this fallback has a 0% observed
 *      success rate whenever it fires for the cross-origin case — it cannot
 *      clear a block it cannot even see. So for cross-origin pairs we skip the
 *      browser hop entirely (no point paying for a Chromium install/launch that
 *      is structurally unable to help) and let the block flow into the shared
 *      retry/backoff loop below instead, since the underlying WAF fence has
 *      proven to be transient (later scheduled runs on the same source
 *      routinely succeed with a plain Node fetch).
 *
 * Why not Jina? Jina Reader only supports GET; a POST payload cannot be replayed
 * through it, so the Playwright browser path is the correct last-resort here
 * for the same-origin (Phenom) case.
 *
 * Exported surface:
 *   PASTAHR_BROWSER_USER_AGENTS               — UA pool
 *   PASTAHR_RUN_USER_AGENT                    — the UA picked once for this run
 *   makePastaHrBrowserHeaders(ref, origin)    — build the full header set
 *   fetchPastaHrWidgetPage(params, opts)      — PastaHR/URLSearchParams fetch
 *   fetchPostWidgetWithAntiBotHardening(body, contentType, endpoint, opts)
 *                                             — generic POST widget fetch (Phenom etc.)
 */
import { launchChromium } from './ensure-chromium.mjs';
import { fetchWithRetry, RETRYABLE_STATUS } from './transient-fetch.mjs';

/* ── Browser UA pool (within the publicjobs.ch / Cloudflare accepted window) ── */

export const PASTAHR_BROWSER_USER_AGENTS = [
  // Rotate across OS/platform to reduce fingerprint correlation between runs.
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
];

/**
 * One User-Agent per RUN, seeded once at module load — never per page (#1824).
 *
 * Each crawler workflow runs as its own fresh Node process, so this index is
 * fixed for the lifetime of the run (every page within a session presents the
 * same UA + matching `Sec-CH-UA-Platform`) yet varies *between* runs (a new
 * random seed each process) — exactly the "reduce fingerprint correlation
 * between runs" intent of the UA pool. Selecting per page instead (the old
 * `PASTAHR_BROWSER_USER_AGENTS[attempt % len]`, with `attempt = page - 1`) made
 * pages 2+ of the same session — same IP, no cookies, milliseconds apart —
 * present a different OS/platform, which is itself a bot signal and the opposite
 * of the anti-detection goal. A `JOBS_CRAWLER_USER_AGENT` env override still wins.
 */
export const PASTAHR_RUN_USER_AGENT =
  PASTAHR_BROWSER_USER_AGENTS[Math.floor(Math.random() * PASTAHR_BROWSER_USER_AGENTS.length)];

export const PASTAHR_ENDPOINT = 'https://www.publicjobs.ch/widget';

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
 * @param {string} [ua]     — User-Agent override; defaults to the per-run UA (PASTAHR_RUN_USER_AGENT)
 */
export function makePastaHrBrowserHeaders(referer, origin, { ua } = {}) {
  const userAgent = ua || PASTAHR_RUN_USER_AGENT;
  return {
    Accept: 'application/json, text/javascript, */*; q=0.01',
    // Verified safe on the direct (non-Playwright) fetch path: undici (Node 22,
    // the runtime for every update-jobs-* crawler workflow) decompresses the
    // response body from its `Content-Encoding` *unconditionally* for `fetch`,
    // independent of the request `Accept-Encoding`. Pinning gzip/deflate/br here
    // (to mirror the real in-page widget XHR for the WAF) does NOT make the
    // downstream `res.json()` choke on compressed bytes — confirmed against
    // gzip, deflate and br via a local undici round-trip on Node v22.
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
 * Whether two URLs share an origin (scheme + host + port). Used to detect the
 * PastaHR cross-origin case (#3255) where the Playwright fallback's in-page
 * `fetch` is subject to the endpoint's CORS policy and can never observe a
 * WAF block response (see module doc "CROSS-ORIGIN CAVEAT" above).
 */
function isCrossOrigin(urlA, urlB) {
  try {
    return new URL(urlA).origin !== new URL(urlB).origin;
  } catch {
    // Malformed URL — be conservative and assume cross-origin (skip the
    // browser hop rather than risk a pointless launch).
    return true;
  }
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
  // Cross-origin pair (PastaHR): the in-page fetch below is subject to the
  // endpoint's CORS policy, and a Cloudflare block response never carries
  // CORS headers — so a blocked request always surfaces as an unreadable
  // `TypeError: Failed to fetch`, never a real result (#3255). Skip the
  // Chromium install/launch entirely rather than pay for an attempt that is
  // structurally unable to succeed; the caller's retry/backoff loop is the
  // only thing that can actually clear a transient WAF fence here.
  if (isCrossOrigin(referer, endpoint)) {
    console.warn(
      `[widget-pw] Skipping Playwright fallback — ${endpoint} is cross-origin to ${referer} `
      + '(CORS blocks a WAF-blocked response from ever being readable in-page, #3255)',
    );
    return null;
  }

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
    //
    // CORS NOTE: this fetch runs in the browser, so it IS subject to the page's
    // CORS policy (unlike the Node-side fetch path, which is not). The
    // cross-origin PastaHR case never reaches here — it's skipped earlier in
    // this function (see the guard above, #3255). What DOES reach here is the
    // same-origin Phenom/Straumann case, which is exempt from CORS entirely, so
    // this header set is a courtesy match of the real in-page widget XHR rather
    // than a CORS requirement. `X-Requested-With` is still deliberately omitted
    // — it is not on the CORS-safelist and forces a preflight OPTIONS that would
    // matter again if this function is ever reused for another cross-origin
    // pair, so keep the safelisted-only header set as the default (#2992).
    const result = await page.evaluate(
      async ({ ep, body, ct }) => {
        const res = await fetch(ep, {
          method: 'POST',
          headers: {
            Accept: 'application/json, text/javascript, */*; q=0.01',
            'Accept-Language': 'de-CH,de;q=0.9,en;q=0.8',
            'Content-Type': ct,
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
 * Steps (the whole sequence runs inside the shared transient-retry loop, so a
 * transient 429/5xx or network blip self-heals with exponential backoff):
 *   1. Attempt a plain Node fetch with realistic Chrome 131 headers.
 *   2. On 403 / 401 / 406 anti-bot fence: PastaHR's endpoint (publicjobs.ch) is
 *      cross-origin to the referer, so the Playwright fallback is skipped (see
 *      module doc "CROSS-ORIGIN CAVEAT", #3255) and the failure is instead
 *      marked retryable — the WAF fence has proven transient (subsequent
 *      scheduled runs routinely succeed), so a few backoff-spaced retries
 *      within THIS run give it a chance to self-heal instead of failing the
 *      whole crawl on a single blocked attempt.
 *   3. On a transient 429/5xx (not an anti-bot status): backoff + retry; a
 *      persistent failure throws after retries are exhausted.
 *
 * @param {URLSearchParams} params   — POST body (caller builds the full payload)
 * @param {Object} opts
 * @param {string} opts.referer      — employer's career page URL
 * @param {string} opts.origin       — employer's origin (scheme+host)
 * @param {number} [opts.timeoutMs]  — per-attempt timeout (default 20 000 ms)
 * @returns {Promise<Object>}        — parsed JSON from the widget API
 */
export async function fetchPastaHrWidgetPage(params, { referer, origin, timeoutMs = 20000 } = {}) {
  const ua = process.env.JOBS_CRAWLER_USER_AGENT || PASTAHR_RUN_USER_AGENT;
  const headers = makePastaHrBrowserHeaders(referer, origin, { ua });

  // Wrap the attempt in the shared transient-retry loop so a transient 429/5xx
  // or network blip self-heals with exponential backoff (the behaviour the old
  // `fetchJson` path provided before this client was extracted, #1846).
  return fetchWithRetry(async () => {
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
      if (res.ok) return await res.json();
      firstStatus = res.status;
      const err = new Error(`HTTP ${res.status} from ${PASTAHR_ENDPOINT}`);
      err.status = res.status;
      err.retryable = RETRYABLE_STATUS.has(res.status);
      throw err;
    } catch (err) {
      // Anti-bot fence (403/401/406): try the headless-browser replay, which
      // the WAF treats as a genuine visitor — but see the cross-origin caveat
      // above, PastaHR always skips it and falls straight through to marking
      // the error retryable.
      const status = firstStatus ?? err?.status;
      if (isAntiBotStatus(status)) {
        console.warn(`[pastahr] HTTP ${status} from ${PASTAHR_ENDPOINT} — trying Playwright anti-bot fallback`);
        const result = await fetchPastaHrPageViaPlaywright(params, { referer, origin, ua, timeoutMs: 45000 });
        if (result !== null) return result;
        // Playwright unavailable, cross-origin-skipped, or also blocked. The
        // WAF fence at this endpoint has proven transient (#3255) — mark the
        // error retryable so the shared backoff loop gives it a few more
        // spaced attempts within this run instead of failing on the first hit.
        err.retryable = true;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }, { label: `pastahr ${PASTAHR_ENDPOINT}` });
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
 * Steps (wrapped in the shared transient-retry loop — 429/5xx/network blips
 * self-heal with exponential backoff before any error surfaces):
 *   1. Plain Node fetch with Chrome 131 UA + full client-hint headers.
 *   2. On 403 / 401 / 406: Playwright browser POST fallback (skipped when
 *      `endpoint` is cross-origin to `referer` — see module doc "CROSS-ORIGIN
 *      CAVEAT", #3255 — since the in-page fetch can never observe a blocked
 *      response's status through the browser's CORS enforcement in that case).
 *   3. Playwright null: for a cross-origin pair, mark the error retryable so
 *      the shared backoff loop below gives the (empirically transient) WAF
 *      fence a few more spaced attempts within this run; for a same-origin
 *      pair (e.g. Phenom/Straumann, where Playwright genuinely could have
 *      cleared the block) re-throw the original error unchanged.
 *   4. Transient 429/5xx (non-anti-bot) → backoff + retry; throw on exhaustion.
 *
 * @param {string|object} body       — request body; objects are JSON-serialised automatically
 * @param {string}        endpoint   — full widget API URL
 * @param {Object}        opts
 * @param {string}        opts.referer      — career page URL (establishes WAF context)
 * @param {string}        opts.origin       — scheme+host of the career page
 * @param {number}        [opts.timeoutMs]  — per-attempt timeout (default 20 000 ms)
 * @returns {Promise<Object>} parsed JSON response
 */
export async function fetchPostWidgetWithAntiBotHardening(body, endpoint, { referer, origin, timeoutMs = 20000 } = {}) {
  const ua = process.env.JOBS_CRAWLER_USER_AGENT || PASTAHR_RUN_USER_AGENT;

  const bodyString = typeof body === 'string' ? body : JSON.stringify(body);
  const contentType = 'application/json';

  // Reuse the same header builder; the client-hint set is platform-agnostic.
  const headers = {
    ...makePastaHrBrowserHeaders(referer, origin, { ua }),
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

  // Wrap the attempt in the shared transient-retry loop so a transient 429/5xx
  // or network blip self-heals with exponential backoff — restoring the
  // behaviour the old `fetchJson` path provided before Straumann was wired
  // through this client (#1846). The anti-bot fence (403/401/406) is NOT
  // retryable: it routes to Playwright once per attempt and re-throws.
  return fetchWithRetry(async () => {
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
      if (res.ok) return await res.json();
      firstStatus = res.status;
      const err = new Error(`HTTP ${res.status} from ${endpoint}`);
      err.status = res.status;
      err.retryable = RETRYABLE_STATUS.has(res.status);
      throw err;
    } catch (err) {
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
        // Playwright unavailable/skipped/blocked. Only a cross-origin pair
        // (Playwright structurally could never observe the block, #3255) gets
        // marked retryable so the shared backoff loop below can self-heal a
        // transient WAF fence; a same-origin pair (Playwright genuinely had a
        // shot at clearing it) keeps the original fail-fast behaviour.
        if (isCrossOrigin(referer, endpoint)) err.retryable = true;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }, { label: `widget ${endpoint}` });
}
