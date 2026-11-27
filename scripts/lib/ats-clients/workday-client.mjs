#!/usr/bin/env node
/**
 * Workday ATS client — shared abstraction for the Workday Career Site (CXS) API.
 *
 *   tenant.wd3.myworkdayjobs.com → buildWorkdayApiBase → POST /wday/cxs/{tenant}/{site}/jobs
 *                                                              ↓
 *   {jobPostings: [...], total: N} ← paginate ← fetchWorkdayJobs (yield each)
 *                                              ↓
 *   extractWorkdayJobIdentity → normalized job
 *
 * Extracted from the Lonza parser (`scripts/lib/lonza-job-parser.mjs`) so any
 * marquee Workday-hosted employer (Roche, Novartis, ABB, Sika, …) can reuse
 * the same listing/pagination logic without copy-pasting.
 *
 * The existing `lonza-job-parser.mjs` is intentionally NOT migrated — that's a
 * follow-up task. New crawlers should import from this module.
 *
 * Source format references:
 *   - Listing endpoint: POST {apiBase}/jobs   body: { appliedFacets, limit, offset, searchText }
 *   - Detail endpoint:  GET  {apiBase}{externalPath}
 *   - Tenant URL:       https://{tenant}.{datacenter}.myworkdayjobs.com/{lang}/{site}
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sourcePostingDateFields } from '../source-posting-date.mjs';
import { isSwissLocationText } from '../target-swiss-locations.mjs';
import {
  fetchWithRetry,
  MAX_RETRY_AFTER_MS,
  parseRetryAfterMs,
  RETRYABLE_STATUS,
  isConnectionLevelFetchError,
  isRetryBudgetExhausted as isRetryBudgetExhaustedError,
  isTransientFetchError,
} from '../transient-fetch.mjs';
import { assertJsonListShape } from '../assert-json-list-shape.mjs';
import { normalizeDescriptionBullets } from '../crawler-template.mjs';
import { chromeUserAgent, isStealthBrowser, launchStealthOrChromium } from '../stealth-browser.mjs';
import {
  FOREIGN_COUNTRY_NAME_LABELS,
  ISO_ALPHA2_COUNTRY_CODES,
  ISO_ALPHA3_COUNTRY_CODES,
  SWISS_COUNTRY_LABELS,
} from '../prospector/country-inventory.mjs';
import { KNOWN_CANTON_CODES } from '../job-location-display.mjs';
import { truncateSlugAtWordBoundary } from '../slug-truncate.mjs';
import { withSingleFlightLockAsync } from '../single-flight-lock.mjs';

/* ── Errors ────────────────────────────────────────────────────────────── */

/**
 * Thrown when the Workday API returns 4xx/5xx after the configured retry budget.
 */
export class WorkdayApiError extends Error {
  /**
   * @param {string} message
   * @param {number} statusCode HTTP status that triggered the failure
   * @param {string} [url] Endpoint that failed
   */
  constructor(message, statusCode, url) {
    super(message);
    this.name = 'WorkdayApiError';
    this.statusCode = statusCode;
    this.url = url;
  }
}

/**
 * Thrown when Workday returns 401/403 — usually means anti-bot block or IP
 * fencing on the tenant. Caller should back off and retry from a different
 * runner / with a different User-Agent.
 */
export class WorkdayAuthError extends WorkdayApiError {
  /**
   * @param {string} message
   * @param {number} statusCode
   * @param {string} [url]
   */
  constructor(message, statusCode, url) {
    super(message, statusCode, url);
    this.name = 'WorkdayAuthError';
  }
}

/**
 * Run-level stop signal for a tenant that keeps returning HTTP 429. Continuing
 * through more URLs on the same runner cannot change its egress and would only
 * turn a controlled rate limit into a watchdog kill.
 */
export class WorkdayRateLimitError extends WorkdayApiError {
  /**
   * @param {string} url
   * @param {{ consecutiveFailures: number, retryAfterMs: number, circuitOpen: boolean, retryExhausted?: boolean }} metadata
   */
  constructor(url, metadata) {
    const retryAfterMs = Math.max(0, Number(metadata?.retryAfterMs) || 0);
    const consecutiveFailures = Math.max(1, Number(metadata?.consecutiveFailures) || 1);
    const waitLabel = retryAfterMs > 0 ? `; cooldown ${retryAfterMs}ms` : '';
    super(
      `Workday rate limit (HTTP 429) for ${url} after ${consecutiveFailures} consecutive response(s)${waitLabel}`,
      429,
      url,
    );
    this.name = 'WorkdayRateLimitError';
    this.status = 429;
    this.retryable = false;
    this.retryAfterMs = retryAfterMs;
    this.consecutiveFailures = consecutiveFailures;
    this.circuitOpen = Boolean(metadata?.circuitOpen);
    // Opening the bounded circuit is the terminal outcome of the same retry
    // policy. Preserve that fact so crawler boundaries can soft-exit with a
    // health summary instead of treating the typed 429 as an uncaught crash.
    this.retryExhausted = Boolean(metadata?.retryExhausted || metadata?.circuitOpen);
  }
}

/**
 * Preserve the shared listing policy across the dedicated Workday callers.
 * Rate limits always propagate; `throwOnError` makes all request failures
 * fail closed, including the statusCode 0 transport-failure marker.
 */
export function shouldPropagateWorkdayFetchError(error, throwOnError = false) {
  return error instanceof WorkdayRateLimitError
    || throwOnError;
}

/* ── Constants ─────────────────────────────────────────────────────────── */

const DEFAULT_USER_AGENT = 'FrontaliereTicino-Bot/1.0 (+https://frontaliereticino.ch/)';
const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_MAX_PAGES = 100000; // uncapped — loop breaks on yielded>=total / partial page
const DEFAULT_MIN_DELAY_MS = 2000;
const DEFAULT_TIMEOUT_MS = 20000;
// `ST` is both an ISO country code and the common compact prefix in
// `ST-MAURICE`; `LUXEMBOURG` is both a country label and a city component in
// `Luxembourg-Ville`. Only the explicitly spaced form is unambiguous there.
const AMBIGUOUS_COMPACT_LOCATION_MARKERS = new Set(['st', 'luxembourg']);

/**
 * Derive the public Workday career page from a CXS API base. The browser
 * fallback needs a same-origin page so its `fetch()` keeps the browser's
 * cookies, TLS stack and user-agent while posting to the JSON API.
 *
 * @param {string} apiBase
 * @returns {string}
 */
function workdayPublicUrlFromApiBase(apiBase) {
  const parsed = new URL(apiBase);
  const segments = parsed.pathname.split('/').filter(Boolean);
  const cxsIndex = segments.indexOf('cxs');
  const cxsPath = cxsIndex >= 0 ? segments.slice(cxsIndex + 1) : [];
  // Most tenants expose /cxs/<tenant>/<site>; a few use /cxs/<site>.
  const isWorkdaySiteHost = /(?:^|\.)myworkdaysite\.com$/i.test(parsed.hostname);
  const sitePath = cxsPath.length > 1 ? cxsPath.slice(1).join('/') : cxsPath.join('/');
  if (!sitePath) throw new Error(`Workday API base has no career-site path: ${apiBase}`);
  if (isWorkdaySiteHost) return `${parsed.origin}/recruiting/${cxsPath.join('/')}`;
  return `${parsed.origin}/en-US/${sitePath}`;
}

/**
 * Build a lazy browser transport for a Workday tenant. It is intentionally
 * opened only after the direct JSON fetch exhausts its connection-level retry;
 * healthy crawls keep the cheap direct path. The caller owns the session and
 * closes it after the Workday operation that uses it.
 *
 * @param {string} apiBase
 * @param {{ publicUrl?: string }} [options] Optional public career-page URL
 *   used to establish the same-origin browser session. The derived `en-US`
 *   URL remains the default for tenants that use the standard locale path.
 * @returns {{request: (args: {url: string, method: string, body?: string, userAgent: string, timeoutMs: number}) => Promise<any>, close: () => Promise<void>}}
 */
export function createWorkdayBrowserJsonFallback(apiBase, options = {}) {
  const publicUrl = typeof options.publicUrl === 'string' && options.publicUrl.trim()
    ? options.publicUrl.trim()
    : workdayPublicUrlFromApiBase(apiBase);
  let sessionPromise;
  let closed = false;

  const open = async () => {
    const browser = await launchStealthOrChromium({
      purpose: 'crawler',
      headless: true,
      locale: 'en-US',
      timezone: 'Europe/Zurich',
      fallbackOptions: { headless: true },
    });
    let context;
    let page;
    try {
      const stealth = isStealthBrowser(browser);
      context = await browser.newContext(stealth
        ? { viewport: null }
        : {
            userAgent: chromeUserAgent(typeof browser.version === 'function' ? browser.version() : ''),
            viewport: { width: 1280, height: 720 },
            locale: 'en-US',
            timezoneId: 'Europe/Zurich',
          });
      page = await context.newPage();
      await page.goto(publicUrl, {
        waitUntil: 'domcontentloaded',
        timeout: Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
      });
      return { browser, context, page };
    } catch (err) {
      await page?.close().catch(() => {});
      await context?.close().catch(() => {});
      await browser.close().catch(() => {});
      throw err;
    }
  };

  const request = async ({ url, method, body, timeoutMs }) => {
    if (closed) throw new Error('Workday browser transport is already closed');
    sessionPromise ||= open();
    const { page } = await sessionPromise;
    const result = await page.evaluate(async ({ requestUrl, requestMethod, requestBody, requestTimeoutMs }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1, Number(requestTimeoutMs) || 20000));
      try {
        const response = await fetch(requestUrl, {
          method: requestMethod,
          body: requestBody,
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'Accept-Language': 'en,de-CH;q=0.9,it-CH;q=0.8,fr-CH;q=0.7',
          },
        });
        return {
          status: response.status,
          retryAfter: response.headers?.get?.('retry-after') ?? null,
          body: await response.text(),
        };
      } finally {
        clearTimeout(timer);
      }
    }, {
      requestUrl: url,
      requestMethod: method,
      requestBody: body,
      requestTimeoutMs: timeoutMs,
    });

    if (result.status === 401 || result.status === 403) {
      throw new WorkdayAuthError(
        `Workday browser auth/anti-bot block (HTTP ${result.status}) for ${url}`,
        result.status,
        url,
      );
    }
    if (result.status < 200 || result.status >= 300) {
      const err = new WorkdayApiError(
        `Workday browser API error HTTP ${result.status} for ${url}`,
        result.status,
        url,
      );
      err.status = result.status;
      err.retryable = RETRYABLE_STATUS.has(result.status);
      err.retryAfter = result.retryAfter ?? null;
      throw err;
    }
    try {
      return JSON.parse(result.body);
    } catch (parseErr) {
      const err = new WorkdayApiError(
        `Workday browser API returned non-JSON body for ${url}: ${parseErr?.message || parseErr}`,
        result.status,
        url,
      );
      err.retryable = true;
      throw err;
    }
  };

  const close = async () => {
    closed = true;
    if (!sessionPromise) return;
    let session;
    try {
      session = await sessionPromise;
    } catch {
      return;
    }
    await session.page?.close().catch(() => {});
    await session.context?.close().catch(() => {});
    await session.browser?.close().catch(() => {});
  };

  return { request, close };
}

/* ── URL building ──────────────────────────────────────────────────────── */

/**
 * Build the Workday CXS API base URL for a tenant + career site.
 *
 * @param {string} tenantHost Hostname of the tenant. Examples:
 *   - `lonza.wd3.myworkdayjobs.com`
 *   - `roche.wd3.myworkdayjobs.com`
 *   - `novartis.wd5.myworkdayjobs.com`
 *   The leading `https://` is tolerated and stripped.
 * @param {string} sitePath Career site path. Examples:
 *   - `Lonza_Careers`
 *   - `roche` (Roche's external site name)
 *   - `External` (generic Workday default)
 * @returns {string} API base URL — append `/jobs` for listings or
 *   `{externalPath}` (returned by listings) for detail.
 *
 * @example
 *   buildWorkdayApiBase('lonza.wd3.myworkdayjobs.com', 'Lonza_Careers')
 *   // → 'https://lonza.wd3.myworkdayjobs.com/wday/cxs/lonza/Lonza_Careers'
 */
export function buildWorkdayApiBase(tenantHost, sitePath) {
  if (!tenantHost) throw new TypeError('buildWorkdayApiBase: tenantHost is required');
  if (!sitePath) throw new TypeError('buildWorkdayApiBase: sitePath is required');

  const host = String(tenantHost)
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();

  // Tenant slug is everything before the first `.wd` segment.
  // `lonza.wd3.myworkdayjobs.com` → `lonza`
  // Fallback: first DNS label.
  const wdMatch = host.match(/^([^.]+)\.wd\d+\./);
  const tenant = wdMatch ? wdMatch[1] : host.split('.')[0];

  const cleanSite = String(sitePath).trim().replace(/^\/+|\/+$/g, '');

  return `https://${host}/wday/cxs/${tenant}/${cleanSite}`;
}

/* ── Internal HTTP helper ──────────────────────────────────────────────── */

/**
 * @param {string} url
 * @param {object} options
 * @returns {Promise<any>}
 */
async function fetchJsonWithRetry(url, options = {}) {
  const {
    method = 'GET',
    body,
    userAgent = DEFAULT_USER_AGENT,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries,
    retryBaseMs,
    browserFallback = null,
    beforeDirectAttempt,
    beforeBrowserFallback,
    onTransientFailure,
    withEgressRequest,
  } = options;

  // Route through the shared transient-fetch retry/backoff. Only TRANSIENT
  // failures retry: network blips/timeouts (shared classifier) and 5xx/429
  // (tagged `retryable`). Persistent failures fail fast — 401/403 anti-bot
  // (WorkdayAuthError) and 4xx WorkdayApiError (404 = moved). The previous
  // hand-rolled loop retried EVERY WorkdayApiError including 404s; this no
  // longer hammers a genuinely-gone endpoint.
  try {
    return await fetchWithRetry(
      async () => {
        const directRequest = async () => {
          if (typeof beforeDirectAttempt === 'function') await beforeDirectAttempt();
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          try {
            const res = await fetch(url, {
              method,
              body,
              signal: controller.signal,
              headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'Accept-Language': 'en,de-CH;q=0.9,it-CH;q=0.8,fr-CH;q=0.7',
                'User-Agent': userAgent,
              },
            });

            if (res.status === 401 || res.status === 403) {
              throw new WorkdayAuthError(
                `Workday auth/anti-bot block (HTTP ${res.status}) for ${url}`,
                res.status,
                url,
              );
            }
            if (!res.ok) {
              const err = new WorkdayApiError(
                `Workday API error HTTP ${res.status} for ${url}`,
                res.status,
                url,
              );
              err.status = res.status;
              err.retryable = RETRYABLE_STATUS.has(res.status);
              err.retryAfter = res.headers?.get?.('retry-after') ?? null;
              throw err;
            }
            const text = await res.text();
            try {
              return JSON.parse(text);
            } catch (parseErr) {
              // A 2xx status with a non-JSON body is the signature of a WAF/CDN
              // "challenge" page served on an otherwise-OK status (#4247 Bucher +
              // Suter — same class, different ATS). isTransientFetchError()
              // checks `err.retryable` first, so tag it explicitly to route
              // through the same backoff loop as a 5xx instead of failing fast
              // on one blip (a bare SyntaxError from res.json() has no such
              // signal and would otherwise fail immediately).
              const err = new WorkdayApiError(
                `Workday API returned non-JSON body for ${url}: ${parseErr?.message || parseErr}`,
                res.status,
                url,
              );
              err.retryable = true;
              throw err;
            }
          } finally {
            clearTimeout(timer);
          }
        };
        return typeof withEgressRequest === 'function'
          ? withEgressRequest(directRequest)
          : directRequest();
      },
      {
        retries,
        retryBaseMs,
        label: `workday ${url}`,
        // WorkdayAuthError (401/403) is a persistent anti-bot block, never
        // retry. Otherwise defer to the shared transient classifier (which
        // honours the `retryable` flag set above + network/timeout signals).
        isTransient: (err) =>
          !(err instanceof WorkdayAuthError)
          && !(err instanceof WorkdayRateLimitError)
          && isTransientFetchError(err),
        onTransientFailure,
      },
    );
  } catch (err) {
    const connectionLevelFailure = err instanceof WorkdayApiError
      ? err.statusCode === 0 && isTransientFetchError(err)
      : isConnectionLevelFetchError(err);
    // A retryable HTTP response can still be an edge/WAF failure for the
    // datacenter request. Workday's same-origin browser transport is the
    // available alternate egress/request stack for JSON POSTs; use it once
    // after the direct retry budget is exhausted, just like the connection
    // failure path. Jina Reader is intentionally not used here because it
    // cannot preserve Workday's POST JSON contract.
    const retryBudgetExhausted = err instanceof WorkdayApiError
      && isRetryBudgetExhaustedError(err);
    const rateLimited = Number(err?.statusCode ?? err?.status) === 429;
    if (browserFallback && !rateLimited && (connectionLevelFailure || retryBudgetExhausted)) {
      try {
        if (typeof beforeBrowserFallback === 'function') await beforeBrowserFallback();
        const browserRequest = () => browserFallback({ url, method, body, userAgent, timeoutMs });
        return await (typeof withEgressRequest === 'function'
          ? withEgressRequest(browserRequest)
          : browserRequest());
      } catch (fallbackErr) {
        // A browser response is stronger evidence than the original socket
        // failure: preserve an observed HTTP/auth failure. If the browser
        // transport also cannot connect, keep the original connection-level
        // error so the crawler's soft-exit and health receipt remain intact.
        if (fallbackErr instanceof WorkdayApiError && fallbackErr.statusCode !== 0) {
          const fallbackWasRetryable = fallbackErr.retryable === true
            || RETRYABLE_STATUS.has(fallbackErr.statusCode);
          if (retryBudgetExhausted && fallbackWasRetryable) {
            // Keep the direct terminal error's retryExhausted marker, but let
            // the browser response supply the HTTP metadata. In particular, a
            // browser 429 must reach the tenant limiter with its Retry-After.
            err.statusCode = fallbackErr.statusCode;
            if (fallbackErr.status !== undefined) err.status = fallbackErr.status;
            err.retryable = fallbackErr.retryable;
            err.retryAfter = fallbackErr.retryAfter ?? null;
            throw err;
          }
          throw fallbackErr;
        }
        console.warn(`⚠️ Workday browser transport fallback failed for ${url}: ${fallbackErr?.message || fallbackErr}`);
      }
    }
    if (err instanceof WorkdayApiError) throw err; // includes WorkdayAuthError
    throw new WorkdayApiError(
      `Workday fetch failed for ${url}: ${err?.message || err}`,
      0,
      url,
    );
  }
}

const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;
// Workday crawler groups run several detached workers on one runner. A shared
// start interval keeps their aggregate request rate below the existing
// per-worker default while preventing bursts at the tenant/egress boundary.
const DEFAULT_EGRESS_MIN_DELAY_MS = 500;
const EGRESS_LOCK_RETRY_MS = 50;

function defaultWorkdayEgressStateDir() {
  const runnerTemp = String(process.env.RUNNER_TEMP || '').trim();
  // Unit tests and one-off local crawls do not share an egress with detached
  // crawler workers. Restrict the implicit path to the generated crawler job;
  // callers can still opt in explicitly with WORKDAY_EGRESS_STATE_DIR.
  if (!runnerTemp || (!process.env.CRAWLER_GROUP_MAX_PARALLEL && !process.env.JOBS_SLICE_FILE)) {
    return null;
  }
  return path.join(runnerTemp, 'crawler-generation', 'workday-egress');
}

function readWorkdayEgressState(statePath) {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return {
      blockedUntil: Number.isFinite(state?.blockedUntil) ? Math.max(0, state.blockedUntil) : 0,
      nextRequestAt: Number.isFinite(state?.nextRequestAt) ? Math.max(0, state.nextRequestAt) : 0,
    };
  } catch {
    // A missing or damaged advisory state file must not leave the runner stuck.
    // The lock itself is published atomically and has crash-safe takeover.
    return { blockedUntil: 0, nextRequestAt: 0 };
  }
}

function writeWorkdayEgressState(statePath, state) {
  const tempPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(state), { flag: 'wx' });
    fs.renameSync(tempPath, statePath);
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

async function withRunnerWorkdayEgress(operation, {
  stateDir,
  minDelayMs = DEFAULT_EGRESS_MIN_DELAY_MS,
  fallbackCooldownMs = DEFAULT_RATE_LIMIT_COOLDOWN_MS,
  retryAfterCapMs = MAX_RETRY_AFTER_MS,
} = {}) {
  if (!stateDir) return operation();

  const resolvedStateDir = path.resolve(stateDir);
  fs.mkdirSync(resolvedStateDir, { recursive: true });
  const lockPath = path.join(resolvedStateDir, 'workday-egress.lock');
  const statePath = path.join(resolvedStateDir, 'workday-egress-state.json');
  const minimumDelayMs = Number.isFinite(Number(minDelayMs))
    ? Math.max(0, Number(minDelayMs))
    : DEFAULT_EGRESS_MIN_DELAY_MS;

  while (true) {
    const gate = await withSingleFlightLockAsync(lockPath, async () => {
      const state = readWorkdayEgressState(statePath);
      const waitMs = Math.max(state.blockedUntil, state.nextRequestAt) - Date.now();
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));

      state.nextRequestAt = Date.now() + minimumDelayMs;
      writeWorkdayEgressState(statePath, state);
      try {
        return await operation();
      } catch (error) {
        const status = Number(error?.statusCode ?? error?.status);
        if (status === 429) {
          // Persist both source 429s and terminal circuit errors. The latter
          // carry the remaining in-process Retry-After window, which keeps
          // another worker from immediately recreating the same burst.
          const retryAfterMs = Number.isFinite(Number(error?.retryAfterMs))
            ? Math.min(retryAfterCapMs, Math.max(0, Number(error.retryAfterMs)))
            : parseRetryAfterMs(
              error?.retryAfter ?? error?.response?.headers?.get?.('retry-after'),
              { capMs: retryAfterCapMs },
            );
          const cooldownMs = retryAfterMs === null
            ? Math.max(0, Number(fallbackCooldownMs) || 0)
            : retryAfterMs;
          state.blockedUntil = Math.max(state.blockedUntil, Date.now() + cooldownMs);
          writeWorkdayEgressState(statePath, state);
        }
        throw error;
      }
    });

    if (gate.acquired) return gate.value;
    await new Promise((resolve) => setTimeout(resolve, EGRESS_LOCK_RETRY_MS));
  }
}

// Two consecutive 429s prove that changing only the Workday URL cannot clear
// a tenant/egress limit. With the existing two-minute Retry-After cap, this
// keeps the worst bounded exit below five minutes (2 x 120s).
const DEFAULT_RATE_LIMIT_CIRCUIT_THRESHOLD = 2;
const implicitRateLimitStates = new Map();

// Browser rescue budgets (see rescueThroughBrowser). They are counted per
// tenant for the whole process, across request contexts, so that several
// crawlers or parsers of one tenant cannot each spend a fresh allowance.
// Calibration: the largest Swiss listing seen in the group-22 proof run
// (45924044578) was 7 postings, one page; 25 pages of 20 and 40 details leave
// a wide margin over that while keeping the worst case, at ~2.5 s of backoff
// plus at most one 20 s request each, bounded to minutes rather than the job
// timeout. The first browser 429 halts the tenant regardless of what is left.
const DEFAULT_LISTING_BROWSER_BUDGET = 25;
const DEFAULT_DETAIL_BROWSER_BUDGET = 40;
const DEFAULT_BROWSER_BACKOFF_MS = 2_500;
const browserRescueLedgers = new Map();

function browserRescueLedger(apiBase) {
  const key = String(apiBase).replace(/\/+$/, '');
  if (!browserRescueLedgers.has(key)) {
    browserRescueLedgers.set(key, {
      listing: 0, detail: 0, halted: false, lastRequestAt: 0, queue: Promise.resolve(),
    });
  }
  return browserRescueLedgers.get(key);
}

function newRateLimitState(apiBase) {
  return {
    blockedUntil: 0,
    consecutiveRateLimits: 0,
    lastRateLimitUrl: apiBase,
    queue: Promise.resolve(),
    observedRateLimits: new WeakSet(),
    // True once the browser transport answered a request after the direct
    // circuit opened: the rest of the tenant's requests then go through it
    // (within budget) instead of re-sending direct requests known to be 429.
    browserEngaged: false,
  };
}

function implicitRateLimitState(apiBase) {
  const key = String(apiBase).replace(/\/+$/, '');
  if (!implicitRateLimitStates.has(key)) {
    implicitRateLimitStates.set(key, newRateLimitState(key));
  }
  return implicitRateLimitStates.get(key);
}

/** Test isolation for the process-wide policy used by legacy no-context callers. */
export function resetWorkdayImplicitRateLimitStateForTests() {
  implicitRateLimitStates.clear();
  browserRescueLedgers.clear();
}

/**
 * Own the transport for one Workday tenant during a crawler run.
 *
 * Workday rate-limits at the tenant/egress boundary, not at an individual
 * detail URL. A caller that fetches a listing followed by many details must
 * therefore share both the browser fallback session and the 429 cooldown. The
 * queue also makes the policy explicit: no second request can start while a
 * previous request is waiting out the tenant's Retry-After window.
 *
 * @param {string} apiBase
 * @param {{ browserFallback?: Function|null, retryAfterCapMs?: number, fallbackCooldownMs?: number, rateLimitCircuitThreshold?: number, rateLimitState?: object, egressStateDir?: string|null, egressMinDelayMs?: number, listingBrowserBudget?: number, detailBrowserBudget?: number, browserBackoffMs?: number }} [options] Browser rescue after the 429 circuit opens: sequential, budgeted per tenant and process (listing pages / details; details default to 0 for a caller-supplied transport), backoff between requests, halted at the first browser 429.
 * @param {{ browserFallback?: Function|null, publicUrl?: string, retryAfterCapMs?: number, fallbackCooldownMs?: number, rateLimitCircuitThreshold?: number, rateLimitState?: object }} [options]
 * @returns {{ request: (url: string, options?: object) => Promise<any>, close: () => Promise<void> }}
 */
export function createWorkdayRequestContext(apiBase, options = {}) {
  if (!apiBase) throw new TypeError('createWorkdayRequestContext: apiBase is required');

  const {
    browserFallback: configuredBrowserFallback,
    publicUrl,
    retryAfterCapMs = MAX_RETRY_AFTER_MS,
    fallbackCooldownMs = DEFAULT_RATE_LIMIT_COOLDOWN_MS,
    rateLimitCircuitThreshold = DEFAULT_RATE_LIMIT_CIRCUIT_THRESHOLD,
    egressStateDir = process.env.WORKDAY_EGRESS_STATE_DIR || defaultWorkdayEgressStateDir(),
    egressMinDelayMs = DEFAULT_EGRESS_MIN_DELAY_MS,
    listingBrowserBudget = DEFAULT_LISTING_BROWSER_BUDGET,
    browserBackoffMs = DEFAULT_BROWSER_BACKOFF_MS,
  } = options;
  // Detail GETs are where #19723 forbade the browser: a 429 storm there is
  // what the circuit exists to stop. The budgeted rescue below stays inside
  // that bound, but it is on by default only for the built-in browser
  // transport; a caller-supplied transport must opt in explicitly.
  const detailBrowserBudget = options.detailBrowserBudget
    ?? (configuredBrowserFallback === undefined ? DEFAULT_DETAIL_BROWSER_BUDGET : 0);
  const ledger = browserRescueLedger(apiBase);
  let browserSession = null;
  let closed = false;
  const rateLimitState = options.rateLimitState ?? newRateLimitState(apiBase);
  const circuitThreshold = Math.max(
    1,
    Number(rateLimitCircuitThreshold) || DEFAULT_RATE_LIMIT_CIRCUIT_THRESHOLD,
  );

  const browserFallback = configuredBrowserFallback === undefined
    ? async (args) => {
        browserSession ||= createWorkdayBrowserJsonFallback(apiBase, { publicUrl });
        return browserSession.request(args);
      }
    : configuredBrowserFallback;

  const observeRateLimit = (err) => {
    const status = Number(err?.statusCode ?? err?.status);
    if (status !== 429) return false;
    const retryAfterMs = parseRetryAfterMs(
      err?.retryAfter ?? err?.response?.headers?.get?.('retry-after'),
      { capMs: retryAfterCapMs },
    );
    const cooldownMs = retryAfterMs === null
      ? Math.max(0, Number(fallbackCooldownMs) || 0)
      : retryAfterMs;
    rateLimitState.blockedUntil = Math.max(rateLimitState.blockedUntil, Date.now() + cooldownMs);
    rateLimitState.lastRateLimitUrl = err?.url || rateLimitState.lastRateLimitUrl;
    if (!err || typeof err !== 'object' || !rateLimitState.observedRateLimits.has(err)) {
      rateLimitState.consecutiveRateLimits += 1;
      if (err && typeof err === 'object') rateLimitState.observedRateLimits.add(err);
    }
    return true;
  };

  const waitForRateLimit = async () => {
    const waitMs = rateLimitState.blockedUntil - Date.now();
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  };

  const rateLimitError = (url, sourceError = null) => new WorkdayRateLimitError(url || rateLimitState.lastRateLimitUrl, {
    consecutiveFailures: rateLimitState.consecutiveRateLimits,
    retryAfterMs: Math.max(0, rateLimitState.blockedUntil - Date.now()),
    circuitOpen: rateLimitState.consecutiveRateLimits >= circuitThreshold,
    retryExhausted: Boolean(sourceError?.retryExhausted || sourceError?.retryBudgetExhausted),
  });

  const beforeDirectAttempt = async () => {
    if (rateLimitState.consecutiveRateLimits >= circuitThreshold) {
      throw rateLimitError(rateLimitState.lastRateLimitUrl);
    }
    await waitForRateLimit();
  };

  const onTransientFailure = async (err, retry) => {
    if (!observeRateLimit(err)) return;
    // fetchWithRetry invokes this hook before its exponential delay. Waiting
    // here makes the no-header tenant cooldown govern this retry too. A valid
    // Retry-After is already applied (with the same shared cap) by that loop;
    // waiting here as well would double the vendor-requested cooldown.
    const retryAfterMs = parseRetryAfterMs(
      err?.retryAfter ?? err?.response?.headers?.get?.('retry-after'),
      { capMs: retryAfterCapMs },
    );
    if (retryAfterMs === null
      && rateLimitState.consecutiveRateLimits < circuitThreshold
      && retry.attempt < retry.maxRetries) {
      await waitForRateLimit();
    }
  };

  const request = (url, requestOptions = {}) => {
    if (closed) return Promise.reject(new Error('Workday request context is already closed'));

    // Once the direct stack is rate limited, every remaining request of the
    // tenant is lost with it and the crawl aborts before publishing. The
    // same-origin browser stack (other TLS fingerprint and cookies) is the
    // alternate path, under the bounds #19723 asked for: only after the 429
    // circuit is open, strictly sequential (this queue), a per-tenant
    // per-process budget for listing pages and for details, a backoff between
    // browser requests, and a stop at the first 429 the browser itself gets.
    const rescueThroughBrowser = async (terminalError) => {
      const method = String(requestOptions.method || 'GET').toUpperCase();
      const kind = method === 'POST' ? 'listing' : 'detail';
      const budget = Math.max(0, Number(kind === 'listing' ? listingBrowserBudget : detailBrowserBudget) || 0);
      // Only a circuit opened by repeated 429s qualifies: a single terminal 429
      // (retry budget 0, or a short Retry-After) keeps its typed error and never
      // launches a browser.
      if (
        !browserFallback
        || ledger.halted
        || ledger[kind] >= budget
        || rateLimitState.consecutiveRateLimits < circuitThreshold
      ) {
        throw terminalError || rateLimitError(url);
      }
      // Request contexts of one tenant each own a queue, so browser requests
      // are serialized on the tenant ledger: never two in flight, and the
      // backoff counts from the completion of the previous one.
      const serial = ledger.queue.then(() => runBrowserRequest(), () => runBrowserRequest());
      ledger.queue = serial.catch(() => {});
      return serial;

      async function runBrowserRequest() {
      if (ledger.halted || ledger[kind] >= budget) throw terminalError || rateLimitError(url);
      ledger[kind] += 1;
      try {
        await waitForRateLimit();
        const backoffWait = ledger.lastRequestAt + Math.max(0, Number(browserBackoffMs) || 0) - Date.now();
        if (backoffWait > 0) await new Promise((resolve) => setTimeout(resolve, backoffWait));
        const browserRequest = () => browserFallback({
          url,
          method,
          body: requestOptions.body,
          userAgent: requestOptions.userAgent || DEFAULT_USER_AGENT,
          timeoutMs: requestOptions.timeoutMs || DEFAULT_TIMEOUT_MS,
        });
        ledger.lastRequestAt = Date.now();
        const data = await (egressStateDir
          ? withRunnerWorkdayEgress(browserRequest, {
              stateDir: egressStateDir,
              minDelayMs: egressMinDelayMs,
              fallbackCooldownMs,
              retryAfterCapMs,
            })
          : browserRequest());
        ledger.lastRequestAt = Date.now();
        if (!rateLimitState.browserEngaged) {
          console.warn(`⚠️ Workday ${kind} recovered through the browser transport after direct HTTP 429: ${url}`);
        }
        rateLimitState.browserEngaged = true;
        rateLimitState.blockedUntil = 0;
        return data;
      } catch (browserErr) {
        ledger.lastRequestAt = Date.now();
        console.warn(`⚠️ Workday browser transport could not recover the rate-limited ${kind} ${url}: ${browserErr?.message || browserErr}`);
        if (observeRateLimit(browserErr)) {
          // The browser is throttled too: the limit is the egress IP, so stop
          // every further browser request of this tenant and surface it.
          ledger.halted = true;
          rateLimitState.consecutiveRateLimits = Math.max(rateLimitState.consecutiveRateLimits, circuitThreshold);
          throw rateLimitError(url, browserErr);
        }
        if (terminalError) throw terminalError;
        // Engaged mode has no direct error to report: a real HTTP answer (404
        // for a withdrawn posting, auth) is the truth, anything else keeps the
        // tenant's open circuit.
        if (browserErr instanceof WorkdayApiError) throw browserErr;
        throw rateLimitError(url);
      }
      }
    };

    const run = async () => {
      // The browser already proved it can answer while the direct circuit is
      // open: do not send more direct requests that are known to be 429.
      if (rateLimitState.browserEngaged && !ledger.halted
          && rateLimitState.consecutiveRateLimits >= circuitThreshold) {
        return rescueThroughBrowser(null);
      }
      try {
        const data = await fetchJsonWithRetry(url, {
          ...requestOptions,
          browserFallback,
          beforeDirectAttempt,
          beforeBrowserFallback: waitForRateLimit,
          onTransientFailure,
          withEgressRequest: (operation) => withRunnerWorkdayEgress(operation, {
            stateDir: egressStateDir,
            minDelayMs: egressMinDelayMs,
            fallbackCooldownMs,
            retryAfterCapMs,
          }),
        });
        rateLimitState.consecutiveRateLimits = 0;
        rateLimitState.browserEngaged = false;
        return data;
      } catch (err) {
        // Browser fallback errors are outside fetchWithRetry's hook. Preserve a
        // terminal 429 there too, so the next detail remains behind Retry-After.
        if (err instanceof WorkdayRateLimitError) return rescueThroughBrowser(err);
        if (observeRateLimit(err)) return rescueThroughBrowser(rateLimitError(url, err));
        rateLimitState.consecutiveRateLimits = 0;
        throw err;
      }
    };

    const pending = rateLimitState.queue.then(run, run);
    rateLimitState.queue = pending.catch(() => {});
    return pending;
  };

  const close = async () => {
    closed = true;
    await rateLimitState.queue;
    await browserSession?.close();
  };

  return { request, close };
}

/**
 * Fetch one Workday JSON request with the direct transport first and a lazy
 * same-origin browser transport after the direct retry budget is exhausted.
 * The browser session is owned by this call, so callers that need to recover
 * multiple requests should pass a shared `browserFallback` function instead.
 *
 * @param {string} apiBase Workday CXS base used to derive the public career URL.
 * @param {string} url Request URL under the same Workday tenant.
 * @param {object} [options]
 * @returns {Promise<any>}
 */
export async function fetchWorkdayJsonWithRetry(apiBase, url, options = {}) {
  if (options.requestContext) {
    const { requestContext, ...requestOptions } = options;
    return requestContext.request(url, requestOptions);
  }

  // A caller without a tenant-wide context still needs the same policy inside
  // this request. Otherwise its retry loop bypasses the no-header cooldown and
  // returns an untyped 429 that higher-level listing/detail helpers can degrade
  // into partial output.
  const {
    browserFallback,
    publicUrl,
    retryAfterCapMs,
    fallbackCooldownMs,
    rateLimitCircuitThreshold,
    egressStateDir,
    egressMinDelayMs,
    listingBrowserBudget,
    detailBrowserBudget,
    browserBackoffMs,
    ...requestOptions
  } = options;
  const requestContext = createWorkdayRequestContext(apiBase, {
    listingBrowserBudget,
    detailBrowserBudget,
    browserBackoffMs,
    browserFallback,
    publicUrl,
    retryAfterCapMs,
    fallbackCooldownMs,
    rateLimitCircuitThreshold,
    egressStateDir,
    egressMinDelayMs,
    rateLimitState: implicitRateLimitState(apiBase),
  });

  try {
    return await requestContext.request(url, requestOptions);
  } finally {
    await requestContext.close();
  }
}

/* ── Listing iterator ──────────────────────────────────────────────────── */

/**
 * @typedef {object} WorkdayJobPosting
 * @property {string} [title]
 * @property {string} [externalPath]
 * @property {string} [locationsText]
 * @property {string} [postedOn]
 * @property {string[]} [bulletFields]
 */

/**
 * @typedef {object} WorkdayFetchOptions
 * @property {string[]} [locationFilters] Workday `locationCountry` facet values
 *   (Switzerland is `187134fccb084a0ea9b4b95f23890dbe` on most tenants but
 *   varies — caller must supply the correct ID for the target tenant).
 * @property {Record<string, string[]>} [appliedFacets] Raw facet override; if
 *   provided, takes precedence over `locationFilters`.
 * @property {string} [searchText] Optional keyword filter (default `''`).
 * @property {number} [pageSize] Postings per page (Workday accepts ≤20 reliably; default 20).
 * @property {number} [maxPages] Hard cap on pagination (default 10 → 200 jobs).
 * @property {string} [userAgent] Override User-Agent header.
 * @property {number} [minDelayMs] Polite delay between paginated calls (default 2000ms).
 * @property {number} [timeoutMs] Per-request timeout (default 20000ms).
 * @property {number} [fallbackCooldownMs] Cooldown for a 429 without Retry-After.
 * @property {number} [rateLimitCircuitThreshold] Consecutive 429 responses before opening the circuit.
 * @property {{ request: (url: string, options?: object) => Promise<any> }} [requestContext]
 *   Shared tenant transport. When present, listing pages use its serialized
 *   browser session and Retry-After cooldown instead of owning a new session.
 * @property {(args: {url: string, method: string, body?: string, userAgent: string, timeoutMs: number}) => Promise<any>|null} [browserFallback] Test or caller-supplied browser transport for connection-level failures. `null` disables the default browser transport.
 * @property {WorkdayFetchStats} [stats] Optional mutable object the iterator
 *   fills with how pagination ended. Read-only signal: passing it never changes
 *   what is fetched or yielded.
 */

/**
 * @typedef {Object} WorkdayFetchStats
 * @property {number|null} firstPageTotal `total` reported by page 0, or null
 *   when page 0 did not carry a finite number.
 * @property {number} yielded Postings yielded so far.
 * @property {'empty-page'|'total-reached'|'short-page'|'max-pages'|'page-error'|null} endReason
 *   Why pagination stopped. `page-error` is the silent partial board: a page
 *   after page 0 failed and the iterator returned what it had.
 */

/**
 * Iterate over Workday job postings for a given tenant, paginating politely.
 *
 * Yields one `jobPosting` at a time. Stops when:
 *   - A page returns no `jobPostings`
 *   - We've collected `total` postings
 *   - We hit `maxPages`
 *
 * Throws `WorkdayAuthError` on 401/403 (anti-bot block — caller should back off)
 * or `WorkdayApiError` on other persistent 4xx/5xx after one retry.
 *
 * @param {string} apiBase Output of `buildWorkdayApiBase`.
 * @param {WorkdayFetchOptions} [options]
 * @returns {AsyncGenerator<WorkdayJobPosting>}
 *
 * @example
 *   const apiBase = buildWorkdayApiBase('lonza.wd3.myworkdayjobs.com', 'Lonza_Careers');
 *   for await (const posting of fetchWorkdayJobs(apiBase, {
 *     locationFilters: ['187134fccb084a0ea9b4b95f23890dbe'],
 *     maxPages: 10,
 *   })) {
 *     const id = extractWorkdayJobIdentity(posting, { apiBase, company: 'Lonza' });
 *     console.log(id.title, id.location);
 *   }
 */
export async function* fetchWorkdayJobs(apiBase, options = {}) {
  if (!apiBase) throw new TypeError('fetchWorkdayJobs: apiBase is required');

  const {
    locationFilters,
    appliedFacets,
    searchText = '',
    pageSize = DEFAULT_PAGE_SIZE,
    maxPages = DEFAULT_MAX_PAGES,
    userAgent = DEFAULT_USER_AGENT,
    minDelayMs = DEFAULT_MIN_DELAY_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    publicUrl,
  } = options;

  const facets = appliedFacets
    ? appliedFacets
    : Array.isArray(locationFilters) && locationFilters.length > 0
    ? { locationCountry: locationFilters }
    : {};

  const endpoint = `${apiBase.replace(/\/+$/, '')}/jobs`;
  const requestContext = options.requestContext ?? null;
  const browserSession = !requestContext && options.browserFallback === undefined
    ? createWorkdayBrowserJsonFallback(apiBase, { publicUrl })
    : null;
  const browserFallback = !requestContext && options.browserFallback === undefined
    ? browserSession.request
    : options.browserFallback;
  const transport = requestContext ? { requestContext } : { browserFallback };

  let offset = 0;
  let yielded = 0;
  let total = Infinity;
  const stats = options.stats && typeof options.stats === 'object' ? options.stats : null;
  if (stats) {
    stats.firstPageTotal = null;
    stats.yielded = 0;
    stats.endReason = null;
  }
  const end = (reason) => {
    if (stats) stats.endReason = reason;
  };

  try {
    for (let page = 0; page < maxPages; page += 1) {
      const body = JSON.stringify({
        appliedFacets: facets,
        limit: pageSize,
        offset,
        searchText,
      });

      let data;
      try {
        data = await fetchWorkdayJsonWithRetry(apiBase, endpoint, {
          method: 'POST',
          body,
          userAgent,
          timeoutMs,
          retries: 1,
          retryAfterCapMs: options.retryAfterCapMs,
          fallbackCooldownMs: options.fallbackCooldownMs,
          rateLimitCircuitThreshold: options.rateLimitCircuitThreshold,
          ...transport,
        });
      } catch (err) {
        // Surface auth errors verbatim; for other failures on the first page,
        // re-throw so the caller knows nothing was fetched. On later pages, stop
        // gracefully (we already returned partial results).
        if (err instanceof WorkdayAuthError || err instanceof WorkdayRateLimitError) throw err;
        if (page === 0) throw err;
        end('page-error');
        return;
      }

      const postings = assertJsonListShape(data, { key: 'jobPostings', source: `workday:${apiBase}` });
      // Some Workday tenants (e.g. logitech.wd5) return `total: 0` on every
      // page after the first — and an unfiltered query can even report total:0
      // on page 0 alongside a full page of postings. Trust only the first page's
      // total, and use it as a positive upper bound: rely on
      // `postings.length < pageSize` / empty payload to detect the genuine end of
      // pagination so a degenerate total:0 never short-circuits after page 1.
      if (page === 0 && typeof data?.total === 'number' && Number.isFinite(data.total)) {
        total = data.total;
        if (stats) stats.firstPageTotal = data.total;
      }

      if (postings.length === 0) {
        end('empty-page');
        return;
      }

      for (const posting of postings) {
        yield posting;
        yielded += 1;
        if (stats) stats.yielded = yielded;
      }

      if (total > 0 && yielded >= total) {
        end('total-reached');
        return;
      }
      if (postings.length < pageSize) {
        end('short-page');
        return;
      }

      offset += pageSize;

      // Polite delay before the next paginated call.
      if (page < maxPages - 1 && minDelayMs > 0) {
        await new Promise((r) => setTimeout(r, minDelayMs));
      }
    }
    end('max-pages');
  } finally {
    await browserSession?.close();
  }
}

/* ── Board summary (total + facets) ───────────────────────────────────── */

/**
 * @typedef {Object} WorkdayBoardSummary
 * @property {number|null} total `total` stated by page 0, or null when absent
 *   or not a finite number.
 * @property {number} postingCount postings shipped on page 0.
 * @property {Array<{ facetParameter?: string, values?: unknown[] }>} facets the
 *   `facets` array of page 0 (`[]` when absent).
 */

/**
 * Read page 0 of a career site for what it says about the WHOLE board: its
 * `total` and its `facets` (the tenant's own per-value counts, e.g. postings by
 * country). The listing iterator never exposes the facets, and they are the
 * only place a tenant states which countries it currently posts in.
 *
 * Fails loudly like the iterator: 401/403 → `WorkdayAuthError`, other HTTP
 * errors (404 for a renamed or retired site) → `WorkdayApiError`.
 *
 * @param {string} apiBase Output of `buildWorkdayApiBase`.
 * @param {{ appliedFacets?: Record<string, string[]>, userAgent?: string, timeoutMs?: number, requestContext?: { request: Function }, browserFallback?: Function|null, retryAfterCapMs?: number, fallbackCooldownMs?: number, rateLimitCircuitThreshold?: number }} [options]
 * @returns {Promise<WorkdayBoardSummary>}
 */
export async function fetchWorkdayBoardSummary(apiBase, options = {}) {
  if (!apiBase) throw new TypeError('fetchWorkdayBoardSummary: apiBase is required');
  const {
    appliedFacets = {},
    userAgent = DEFAULT_USER_AGENT,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    publicUrl,
  } = options;
  const endpoint = `${apiBase.replace(/\/+$/, '')}/jobs`;
  const requestContext = options.requestContext ?? null;
  const browserSession = !requestContext && options.browserFallback === undefined
    ? createWorkdayBrowserJsonFallback(apiBase, { publicUrl })
    : null;
  const browserFallback = !requestContext && options.browserFallback === undefined
    ? browserSession.request
    : options.browserFallback;
  const transport = requestContext ? { requestContext } : { browserFallback };
  try {
    const data = await fetchWorkdayJsonWithRetry(apiBase, endpoint, {
      method: 'POST',
      body: JSON.stringify({ appliedFacets, limit: DEFAULT_PAGE_SIZE, offset: 0, searchText: '' }),
      userAgent,
      timeoutMs,
      retries: 1,
      retryAfterCapMs: options.retryAfterCapMs,
      fallbackCooldownMs: options.fallbackCooldownMs,
      rateLimitCircuitThreshold: options.rateLimitCircuitThreshold,
      ...transport,
    });
    const postings = assertJsonListShape(data, { key: 'jobPostings', source: `workday:${apiBase}` });
    return {
      total: typeof data?.total === 'number' && Number.isFinite(data.total) ? data.total : null,
      postingCount: postings.length,
      facets: Array.isArray(data?.facets) ? data.facets : [],
    };
  } finally {
    await browserSession?.close();
  }
}

/**
 * The leaf values of one facet, flattened: `[{ id, descriptor, count }]`.
 * Workday nests some facets (`locationMainGroup` → `Locations` → sites), so
 * groups are walked and only leaves are returned. `null` when the facet is not
 * on the page at all — which is not the same statement as "no values".
 *
 * @param {WorkdayBoardSummary['facets']} facets
 * @param {string} facetParameter e.g. `Country`, `locationCountry`
 * @returns {Array<{ id: string, descriptor: string, count: number|null }>|null}
 */
export function workdayFacetLeafValues(facets, facetParameter) {
  const facet = (Array.isArray(facets) ? facets : []).find((f) => f?.facetParameter === facetParameter);
  if (!facet || !Array.isArray(facet.values)) return null;
  const leaves = [];
  const walk = (values) => {
    for (const value of values) {
      if (!value || typeof value !== 'object') continue;
      if (Array.isArray(value.values)) {
        walk(value.values);
        continue;
      }
      leaves.push({
        id: String(value.id ?? ''),
        descriptor: String(value.descriptor ?? ''),
        count: typeof value.count === 'number' && Number.isFinite(value.count) ? value.count : null,
      });
    }
  };
  walk(facet.values);
  return leaves;
}

/* ── Detail fetch ──────────────────────────────────────────────────────── */

/**
 * Fetch a single Workday job's detail payload (`jobPostingInfo`) from the CXS
 * API.
 *
 * The listing endpoint (`POST /jobs`) returns only summary fields
 * (`title`, `externalPath`, `locationsText`, `postedOn`, `bulletFields`) —
 * it never carries the job body. The body lives at
 * `GET {apiBase}{externalPath}` under `jobPostingInfo.jobDescription` (HTML).
 *
 * Returns the parsed JSON on success. Returns `null` on any failure (4xx, 5xx,
 * timeout, abort, network error) so the caller can fall back to a structured
 * stub built from listing metadata without aborting the whole crawler run.
 *
 * NOTE: this helper deliberately swallows errors. Workday occasionally serves
 * 403 on individual listings (anti-bot heuristics) or 404 when a posting was
 * pulled between the listing and detail fetch. Either case should not poison
 * the rest of the run — the caller's thin-source guard catches widespread
 * failures.
 *
 * @param {string} apiBase Output of `buildWorkdayApiBase`.
 * @param {string} externalPath The `externalPath` field returned for each
 *   posting by the listing endpoint (already starts with `/job/...`).
 * @param {Object} [options]
 * @param {number} [options.timeoutMs] Per-request timeout. Default 15000ms.
 * @param {string} [options.userAgent] Override User-Agent header.
 * @param {number} [options.retries] Override the shared transient retry count.
 * @param {number} [options.retryAfterCapMs] Maximum accepted Retry-After cooldown.
 * @param {number} [options.fallbackCooldownMs] Cooldown for a 429 without Retry-After.
 * @param {number} [options.rateLimitCircuitThreshold] Consecutive 429 responses before opening the circuit.
 * @param {{ request: (url: string, options?: object) => Promise<any> }} [options.requestContext]
 *   Shared tenant transport for listing, detail and summary requests.
 * @param {(args: {url: string, method: string, body?: string, userAgent: string, timeoutMs: number}) => Promise<any>|null} [options.browserFallback] Alternate browser transport after direct retries are exhausted. Omit to use the lazy default browser transport; pass `null` to disable it.
 * @returns {Promise<any|null>} The detail JSON, or `null` on failure.
 *
 * @example
 *   const apiBase = buildWorkdayApiBase('roche.wd3.myworkdayjobs.com', 'roche-ext');
 *   const detail = await fetchWorkdayJobDetail(apiBase, posting.externalPath);
 *   const html = detail?.jobPostingInfo?.jobDescription || '';
 */
export async function fetchWorkdayJobDetail(apiBase, externalPath, options = {}) {
  if (!apiBase || !externalPath) return null;
  const {
    timeoutMs = 15_000,
    userAgent = DEFAULT_USER_AGENT,
    retries,
    publicUrl,
  } = options;
  const requestContext = options.requestContext ?? null;
  const browserSession = !requestContext && options.browserFallback === undefined
    ? createWorkdayBrowserJsonFallback(apiBase, { publicUrl })
    : null;
  const browserFallback = !requestContext && options.browserFallback === undefined
    ? browserSession.request
    : options.browserFallback;
  const transport = requestContext ? { requestContext } : { browserFallback };

  const url = `${String(apiBase).replace(/\/+$/, '')}${externalPath}`;

  // Per-job detail: degrade to null on persistent failure (the job is still
  // kept without enriched detail) but retry TRANSIENT blips so a network
  // hiccup doesn't silently drop the description on a single attempt.
  try {
    return await fetchWorkdayJsonWithRetry(apiBase, url, {
      method: 'GET',
      userAgent,
      timeoutMs,
      retries,
      retryAfterCapMs: options.retryAfterCapMs,
      fallbackCooldownMs: options.fallbackCooldownMs,
      rateLimitCircuitThreshold: options.rateLimitCircuitThreshold,
      ...transport,
    });
  } catch (err) {
    if (err instanceof WorkdayRateLimitError) throw err;
    return null;
  } finally {
    await browserSession?.close();
  }
}

/**
 * Convenience: fetch the job detail and return the description body as
 * bullet-preserving plain text. Returns '' on any failure.
 *
 * Pipeline:
 *   GET {apiBase}{externalPath} → jobPostingInfo.jobDescription (HTML)
 *   → stripHtml (caller-supplied) → newline-preserving compaction
 *
 * The caller passes `stripHtml` (typically from `crawler-template.mjs`) so this
 * client module has no dependency on the project's stripper.
 *
 * No default length cap: the body is the vacancy, and a cut one is an
 * incomplete one. The former 4000-character default chopped the tail
 * (profile, benefits, application notes) of every long Workday posting — the
 * parser-quality audit reads that as a published description shorter than its
 * source (issue 5253). A caller that really needs a bound passes `maxChars`.
 *
 * @param {string} apiBase
 * @param {string} externalPath
 * @param {(html: string) => string} stripHtml HTML→text stripper.
 * @param {Object} [options]
 * @param {number} [options.timeoutMs]
 * @param {string} [options.userAgent]
 * @param {number} [options.maxChars] Optional hard cap on returned text (no cap by default).
 * @returns {Promise<string>} Plain-text description, or '' on failure.
 */
export async function fetchWorkdayJobDescriptionText(
  apiBase,
  externalPath,
  stripHtml,
  options = {},
) {
  if (typeof stripHtml !== 'function') {
    throw new TypeError('fetchWorkdayJobDescriptionText: stripHtml function is required');
  }
  return (await fetchWorkdayJobDetailParts(apiBase, externalPath, stripHtml, options)).text;
}

/**
 * One detail request, both halves a dedicated parser needs: the body as
 * plain text (exactly what `fetchWorkdayJobDescriptionText` returns) and the
 * `jobPostingInfo` itself — the structured primary location, country and
 * `timeType`, none of which the CXS listing row carries (a listing-row
 * `timeType` is always empty, so every part-time req was typed from its title
 * alone).
 *
 * @param {string} apiBase
 * @param {string} externalPath
 * @param {(html: string) => string} stripHtml
 * @param {Object} [options] same as `fetchWorkdayJobDescriptionText`
 * @returns {Promise<{ text: string, info: Record<string, any> }>} `info` is
 *   `{}` when the detail could not be read.
 */
export async function fetchWorkdayJobDetailParts(apiBase, externalPath, stripHtml, options = {}) {
  if (typeof stripHtml !== 'function') {
    throw new TypeError('fetchWorkdayJobDetailParts: stripHtml function is required');
  }
  const { maxChars = Infinity, ...fetchOptions } = options;

  const detail = await fetchWorkdayJobDetail(apiBase, externalPath, fetchOptions);
  const info = detail?.jobPostingInfo && typeof detail.jobPostingInfo === 'object' ? detail.jobPostingInfo : {};
  const html = String(info.jobDescription || '').trim();
  if (!html) return { text: '', info };

  const text = stripHtml(html);
  const normalized = normalizeDescriptionBullets(String(text || '')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim());
  return { text: Number.isFinite(maxChars) ? normalized.slice(0, maxChars) : normalized, info };
}

const workdaySidebarCache = new Map();

/**
 * Fetch the career site's sidebar text blocks (`GET {apiBase}/sidebar`), e.g.
 * KSB's "About us" panel. Workday renders them next to every posting on the
 * site and folds them into each posting's JSON-LD `description`, so they are
 * part of what the source publishes for a vacancy — but the CXS job payload
 * (`jobPostingInfo.jobDescription`) never carries them.
 *
 * Returned as plain text, one "Title\n\nbody" block per TEXT/IMAGE sidebar
 * entry with a non-empty body (video captions are skipped); '' on any failure
 * (the posting body alone is still valid).
 * Cached per `apiBase` for the process lifetime: the sidebar is site-level,
 * one request per run is enough.
 *
 * @param {string} apiBase Output of `buildWorkdayApiBase`.
 * @param {(html: string) => string} stripHtml HTML→text stripper.
 * @param {Object} [options] Same fetch options as `fetchWorkdayJobDetail`.
 * @returns {Promise<string>}
 */
export function fetchWorkdaySidebarText(apiBase, stripHtml, options = {}) {
  if (!apiBase || typeof stripHtml !== 'function') return Promise.resolve('');
  const key = String(apiBase).replace(/\/+$/, '');
  if (!workdaySidebarCache.has(key)) {
    const pending = fetchWorkdayJobDetail(key, '/sidebar', options)
      .then((entries) => formatWorkdaySidebarText(entries, stripHtml))
      .catch((err) => {
        if (err instanceof WorkdayRateLimitError) {
          if (workdaySidebarCache.get(key) === pending) workdaySidebarCache.delete(key);
          throw err;
        }
        return '';
      });
    workdaySidebarCache.set(key, pending);
  }
  return workdaySidebarCache.get(key);
}

/**
 * Pure formatter for the `/sidebar` payload (exported for tests).
 *
 * @param {unknown} entries
 * @param {(html: string) => string} stripHtml
 * @returns {string}
 */
export function formatWorkdaySidebarText(entries, stripHtml) {
  if (!Array.isArray(entries)) return '';
  const blocks = [];
  for (const entry of entries) {
    // A VIDEO entry's text is the caption of a player we cannot carry
    // ("Willkommen auf der Karriereseite …"), not employer content.
    if (String(entry?.type || '').toUpperCase() === 'VIDEO') continue;
    const body = String(stripHtml(String(entry?.text || '')) || '')
      .replace(/[ \t]+/g, ' ')
      .replace(/[ \t]*\n[ \t]*/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (!body) continue;
    const title = normalizeSpace(entry?.title || '');
    blocks.push(title ? `${title}\n\n${body}` : body);
  }
  return blocks.join('\n\n');
}

/* ── Date parsing ──────────────────────────────────────────────────────── */

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function normalizeWorkdayLocationField(value) {
  if (typeof value === 'string' || typeof value === 'number') {
    return normalizeSpace(value);
  }
  if (!value || typeof value !== 'object') return '';
  return normalizeSpace(value.descriptor || value.name || '');
}

/**
 * Convert the string/object shapes used by Workday location fields to text.
 * Detail payloads commonly put the country in a nested object and use
 * `descriptor` for the human-readable location; String(object) loses both.
 * The flattened contract is explicit: descriptor, location, city, cityName,
 * region, country descriptor/name, country.alpha2Code, and country.code.
 */
export function normalizeWorkdayLocationCandidate(candidate) {
  if (typeof candidate === 'string' || typeof candidate === 'number') {
    return normalizeSpace(candidate);
  }
  if (!candidate || typeof candidate !== 'object') return '';

  const parts = [
    candidate.descriptor,
    candidate.location,
    candidate.city,
    candidate.cityName,
    candidate.region,
    candidate.country,
    candidate.country?.descriptor,
    candidate.country?.name,
    candidate.country?.alpha2Code,
    candidate.country?.code,
  ].map(normalizeWorkdayLocationField).filter(Boolean);

  return [...new Set(parts)].join(', ');
}

/**
 * Whether a Workday location candidate names Switzerland.
 *
 * Shared because the alternative is a literal-substring test per tenant, and a
 * substring test is fail-CLOSED on the representations Workday actually sends:
 * `CH`, `CHE`, `756`, a `country.alpha2Code` of `CH` that
 * `normalizeWorkdayLocationCandidate` above folds into the flattened string,
 * and the localised country names. `huntsman-job-parser.mjs` shipped exactly
 * that bug for one commit — it accepted a primary only if the normalised text
 * contained the English word `switzerland`, which drops legitimate Swiss reqs.
 *
 * The hyphenated branch is narrow on purpose: `CH-ZH` and `CHE-8002` are the
 * observed country+canton / country+postcode shapes, while an arbitrary
 * internal code such as `CH-WID` is NOT a country signal.
 */
export function isSwissWorkdayLocationCandidate(locationText) {
  const text = String(locationText || '');
  const tokens = text.split(/[\s,;|/-]+/);
  const hasStandaloneSwissCountryCode = tokens.some((token) =>
    /^(?:ch|che|756)$/i.test(token)
    && new RegExp(`(?:^|[\\s,;|/])${token}(?=$|[\\s,;|/])`, 'i').test(text),
  );
  const hasHyphenatedSwissCountryCode = /\b(?:ch-[a-z]{2}|che-\d{4})\b/i.test(text);
  return /\b(?:switzerland|schweiz|suisse|svizzera)\b/i.test(text)
    || hasStandaloneSwissCountryCode
    || hasHyphenatedSwissCountryCode
    || isSwissLocationText(text);
}

/**
 * The state of a req's OWN primary location: is the field there at all, and
 * what does it say.
 *
 * `present` and `text` are separate answers because a resolver that returns
 * `''` conflates «the field is absent» with «the field is there and I did not
 * recognise it», and every caller that then writes
 * `resolved || listing.locationRaw` turns the second case into the first. That
 * is fail-OPEN: a Swiss listing row can publish an unknown — or foreign —
 * primary under a Swiss city and canton. It is the same semantic error as a
 * canton resolver that never fails, one layer up: here the resolver fails
 * correctly and the CALLER misreads the empty answer.
 *
 * A listing fallback is legitimate only when `present` is false.
 */
export function workdayPrimaryLocationState(info = {}) {
  const raw = info?.location;
  const hasField = raw !== undefined && raw !== null && raw !== '';
  const text = normalizeWorkdayLocationCandidate(raw);
  return {
    // A primary that is present but unreadable still counts as PRESENT: that is
    // precisely the case the listing fallback must not paper over.
    present: Boolean(hasField),
    text,
    isSwiss: Boolean(text) && isSwissWorkdayLocationCandidate(text),
  };
}

/**
 * Return all location candidates from a Workday detail plus its listing.
 * Keep the source order: primary detail, additional detail locations,
 * requisition location, then listing summary.
 */
export function getWorkdayLocationCandidates(info = {}, listingLocation = '') {
  // Keep the source order explicit: primary detail, extra detail locations,
  // requisition location, then the listing summary. Every object in this
  // list is flattened by normalizeWorkdayLocationCandidate above, including
  // country.alpha2Code and country.code when Workday supplies them.
  const rawCandidates = [
    info?.location,
    ...(Array.isArray(info?.additionalLocations) ? info.additionalLocations : []),
    info?.jobRequisitionLocation,
    listingLocation,
  ];
  return rawCandidates.map(normalizeWorkdayLocationCandidate).filter(Boolean);
}

/** Only explicit source dates are precise enough to persist as publication dates.
 * Relative listing labels (including today and 30+ days) carry no source timezone
 * or exact instant, so they remain unknown until the detail supplies a date.
 */
export function parseWorkdayPostedDate(postedOnRaw, now = new Date()) {
  return sourcePostingDateFields(normalizeSpace(postedOnRaw), now).postedDate || null;
}

/** CXS detail startDate is the publication date exposed as datePosted by Workday's
 * public JobPosting JSON-LD; it is distinct from an arbitrary top-level startDate.
 * Prefer detail evidence over lossy relative listing labels.
 */
export function workdayPostingDateFields(posting, now = new Date()) {
  const info = posting?.jobPostingInfo || {};
  for (const value of [info.datePosted, info.startDate, posting?.datePosted, info.postedOn, posting?.postedOn]) {
    const fields = sourcePostingDateFields(value, now);
    if (fields.postingDateSource === 'reported') return fields;
  }
  return sourcePostingDateFields('', now);
}

/* ── Job identity normalization ────────────────────────────────────────── */

/**
 * @typedef {object} WorkdayJobIdentity
 * @property {string} jobReqId Workday `jobReqId` or first bullet field
 * @property {string} slug URL-safe lowercase slug derived from the title
 * @property {string} title Cleaned job title
 * @property {string} location First location segment (e.g. "Visp" from "Visp - VS, Switzerland")
 * @property {string} company Resolved company display name (from options.company)
 * @property {string|null} postedAt Explicit ISO source publication date or null
 * @property {string} postingDateSource reported or unknown
 * @property {string} datePosted Validated publication date or empty
 * @property {string} postedDate Validated publication date or empty
 * @property {string} applyUrl Public-facing URL (Workday `en/{site}{externalPath}` format)
 * @property {string} externalPath Raw Workday externalPath (use to fetch detail)
 */

function slugifyTitle(text = '', suffix = '') {
  let s = String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (suffix) s = `${s}-${suffix}`.replace(/--+/g, '-');
  return truncateSlugAtWordBoundary(s, 200);
}

const normalizeLocationMarker = (value) => String(value || '')
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

function isAdministrativeLocationCode(value) {
  const token = String(value || '').trim();
  if (!token) return false;
  const upper = token.toUpperCase();
  return /^[A-Z]{2,3}$/.test(upper)
    && (ISO_ALPHA2_COUNTRY_CODES.has(upper)
      || ISO_ALPHA3_COUNTRY_CODES.has(upper)
      || KNOWN_CANTON_CODES.has(upper));
}

function isAdministrativeLocationMarker(value) {
  if (isAdministrativeLocationCode(value)) return true;
  const token = String(value || '').trim();
  if (!token) return false;
  const folded = normalizeLocationMarker(token);
  return SWISS_COUNTRY_LABELS.has(folded) || FOREIGN_COUNTRY_NAME_LABELS.has(folded);
}

function stripTrailingAdministrativeMarker(value) {
  const commaHead = String(value || '').split(/\s*,\s*/)[0].trim();
  const suffix = commaHead.match(/^(.+?)\s*[-–—]\s*([^,]+)$/);
  const suffixToken = suffix?.[2]?.trim() || '';
  const cityPrefix = suffix?.[1]?.trim() || '';
  // An all-uppercase suffix can be part of an all-uppercase hyphenated city
  // (`ST-MAURICE`). Country names in Workday are title-cased; codes remain
  // unambiguous and are still stripped by the branch below.
  const suffixIsUppercaseCityToken = /^[A-Z][A-Z\s]*$/.test(suffixToken)
    && !isAdministrativeLocationCode(suffixToken);
  const saintCity = /^(?:st\.?|saint)$/i.test(cityPrefix);
  if (suffix && !saintCity && !suffixIsUppercaseCityToken && isAdministrativeLocationMarker(suffixToken)) {
    return suffix[1].trim();
  }
  return String(value || '').trim();
}

export function firstLocationSegment(locText = '') {
  const cleaned = String(locText || '').trim();
  if (/\d+\s+location/i.test(cleaned)) return '';

  // Workday emits both spaced (`CH - Visp`) and compact (`CH-Visp`) country
  // prefixes. Country-name prefixes occur in the same compact form
  // (`Switzerland-Visp`), so accept any recognized administrative marker while
  // keeping compact markers that are also city components (`ST-MAURICE` and
  // `Luxembourg-Ville`) intact.
  const administrativePrefixMatch = cleaned.match(/^(.+?)(\s*[-–—]\s*)(.+)$/);
  const administrativePrefix = administrativePrefixMatch?.[1]?.trim() || '';
  const administrativeSeparator = administrativePrefixMatch?.[2] || '';
  const prefixIsExplicitlySpaced = /^\s+[-–—]\s+$/.test(administrativeSeparator);
  const compactPrefixIsUnambiguous = isAdministrativeLocationMarker(administrativePrefix)
    && (!AMBIGUOUS_COMPACT_LOCATION_MARKERS.has(normalizeLocationMarker(administrativePrefix))
      || prefixIsExplicitlySpaced);
  const prefixMatch = administrativePrefixMatch && compactPrefixIsUnambiguous
    ? [administrativePrefixMatch[0], administrativePrefix, administrativePrefixMatch[3]]
    : cleaned.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  const countryPrefix = prefixMatch && isAdministrativeLocationMarker(prefixMatch[1])
    ? prefixMatch
    : null;
  const locationText = countryPrefix?.[2]?.trim() || cleaned;

  // Split only on a spaced dash: an unspaced dash belongs to a hyphenated city
  // such as "Plan-les-Ouates" or "St-Maurice". A trailing canton/country
  // marker without spaces (`Sion-VS`, `Visp-Switzerland`) is stripped below.
  const parts = locationText.split(/\s+[-–—]\s+/).map((part) => part.trim()).filter(Boolean);
  // Bare country/canton codes are not cities; country *names* are kept for
  // the existing region-only fallback (`Switzerland` remains honest data).
  const first = parts.find((part) => !isAdministrativeLocationCode(part));
  if (!first) return '';
  return stripTrailingAdministrativeMarker(first);
}

/**
 * @typedef {object} WorkdayIdentityOptions
 * @property {string} [apiBase] If provided, used to derive a public apply URL
 *   in the form `{tenantOrigin}/en/{site}{externalPath}`.
 * @property {string} [publicBase] Override for the public URL base (e.g.
 *   `https://lonza.wd3.myworkdayjobs.com/en/Lonza_Careers`). Wins over `apiBase`.
 * @property {string} [company] Display name to attach to the identity.
 * @property {string} [slugSuffix] Extra suffix appended to the slug (e.g. `lonza-ch`).
 */

/**
 * Normalize a raw Workday `jobPosting` (from listing or detail) into a flat
 * identity object. Tolerant of the small shape differences between tenants —
 * any missing field becomes `''` or `null`.
 *
 * @param {WorkdayJobPosting} posting
 * @param {WorkdayIdentityOptions} [options]
 * @returns {WorkdayJobIdentity}
 */
export function extractWorkdayJobIdentity(posting, options = {}) {
  const safe = posting || {};
  const { apiBase, publicBase, company = '', slugSuffix = '' } = options;

  const title = normalizeSpace(safe.title || safe?.jobPostingInfo?.title || '');
  const externalPath = safe.externalPath || safe?.jobPostingInfo?.externalPath || '';
  const locationRaw =
    safe.locationsText ||
    safe?.jobPostingInfo?.location ||
    safe.location ||
    '';
  const location = firstLocationSegment(locationRaw);

  const jobReqId =
    safe?.jobPostingInfo?.jobReqId ||
    safe.jobReqId ||
    (Array.isArray(safe.bulletFields) ? safe.bulletFields[0] : '') ||
    '';

  const publication = workdayPostingDateFields(safe);
  const postedAt = publication.postedDate || null;

  // Build the public apply URL.
  // CXS API base: https://{host}/wday/cxs/{tenant}/{site}
  // Public form:  https://{host}/en/{site}{externalPath}
  let applyUrl = '';
  if (publicBase && externalPath) {
    applyUrl = `${publicBase.replace(/\/+$/, '')}${externalPath}`;
  } else if (apiBase && externalPath) {
    try {
      const u = new URL(apiBase);
      const cxsParts = u.pathname.split('/').filter(Boolean); // ['wday','cxs','{tenant}','{site}']
      const site = cxsParts[3] || '';
      if (site) applyUrl = `${u.origin}/en/${site}${externalPath}`;
    } catch {
      /* ignore — applyUrl stays empty */
    }
  }

  return {
    jobReqId,
    slug: slugifyTitle(title, slugSuffix),
    title,
    location,
    company,
    postedAt,
    ...publication,
    applyUrl,
    externalPath,
  };
}
