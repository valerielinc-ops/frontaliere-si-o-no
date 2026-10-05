/**
 * Detail-page transport of the MySwitzerland events crawler, and ONLY of it.
 *
 * From 2026-10-04 the www.myswitzerland.com CDN (Fastly Next-Gen WAF) answers
 * HTTP 406 with an empty body to every uncached detail page requested with an
 * identifying User-Agent. Measured on 2026-10-05 from one IP with the same
 * Chromium build: the crawler UA and the `HeadlessChrome` UA got 406 on the
 * same uncached URL that a desktop Chrome UA got as 200. Cookies, JS and
 * request headers made no difference; only the User-Agent did.
 *
 * The browser User-Agent below is an EXCEPTION decided by the site owner on
 * 2026-10-05 (decision D1, issue #10710) to the crawler rule "clearly
 * identifying User-Agent". Do not copy it into any other crawler or request:
 * tests/myswitzerland-browser-ua-confinement.test.ts fails if this module or
 * the constant is used anywhere else under scripts/. The Algolia index and
 * every other request of the crawler keep the identifying User-Agent.
 *
 * Limits that come with the exception (decision D1):
 * - one fixed User-Agent, one egress (the runner), no rotation, no proxy;
 * - no cookies (plain fetch keeps no jar), no captcha or challenge solving;
 * - only https://www.myswitzerland.com detail pages, never /api/ or /sitecore*
 *   (disallowed by robots.txt);
 * - at least 1000 ms between two detail requests (robots.txt Crawl-delay: 1),
 *   enforced by the crawler's DETAIL_DELAY_MS;
 * - stop the detail phase at the first 403, 429 or challenge page, or when
 *   406 refusals exceed the fail-closed policy threshold: the run then writes
 *   nothing (no aggressive retries, previous slice untouched).
 */

import { appendFileSync } from 'node:fs';
import { DETAIL_FAILURE_RATIO_THRESHOLD } from './detail-failure-reuse-policy.mjs';

// Stable desktop Chrome string: the exact one measured as 200 on 2026-10-05.
// Never rotated. Owner decision D1 of 2026-10-05; exception, do not copy.
export const MYSWITZERLAND_DETAIL_BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

export const MYSWITZERLAND_DETAIL_TRANSPORT_MODE = 'browser-UA (eccezione D1)';

const DETAIL_HOST = 'www.myswitzerland.com';
const DETAIL_TIMEOUT_MS = 20_000;
// The 406 stop rule never judges a ratio on fewer than this many requests:
// the first refusal of a run is 1/1 = 100% and must not stop the phase alone.
export const REFUSAL_STOP_MIN_SAMPLE = 20;

const LD_JSON_RE = /<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["']/i;
// Real detail pages measured at ~250 KB with JSON-LD; a 2xx without JSON-LD
// under this size is an interstitial (challenge, captcha or the 3 KB
// `private, no-store` page measured on 05-10), never content to parse. Size
// and not wording: a full page may legitimately mention "captcha" in a form.
export const CHALLENGE_MAX_BYTES = 20_000;

/** Reject any URL outside the detail pages robots.txt allows. */
export function assertDetailUrlAllowed(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' || url.hostname !== DETAIL_HOST) {
    throw new Error(`myswitzerland detail transport: host not allowed (${url.hostname})`);
  }
  if (/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:api\/|sitecore)/i.test(url.pathname)) {
    throw new Error(`myswitzerland detail transport: path disallowed by robots.txt (${url.pathname})`);
  }
  return url;
}

/**
 * `ok` (2xx with content), `refused` (406), `escalation` (403, 429 or a
 * challenge/captcha page), `other` (404, 5xx, network error).
 */
export function classifyDetailResponse({ status, html }) {
  if (status === 406) return 'refused';
  if (status === 403 || status === 429) return 'escalation';
  if (status >= 200 && status < 300) {
    const body = typeof html === 'string' ? html : '';
    if (!LD_JSON_RE.test(body) && body.length < CHALLENGE_MAX_BYTES) {
      return 'escalation';
    }
    return 'ok';
  }
  return 'other';
}

export function createDetailTransportStats() {
  return { attempted: 0, ok: 0, refused: 0, other: 0, escalation: 0, stopped: null };
}

/**
 * Record one detail response and decide whether the detail phase must stop.
 * Returns the classification; `stats.stopped` is set once and never cleared.
 */
export function recordDetailResponse(stats, response, url) {
  const kind = classifyDetailResponse(response);
  stats.attempted += 1;
  stats[kind] += 1;
  if (stats.stopped) return kind;
  if (kind === 'escalation') {
    stats.stopped = {
      reason: response.status === 403 || response.status === 429 ? `HTTP ${response.status}` : 'challenge page',
      url,
    };
  } else if (kind === 'refused'
    && stats.refused / Math.max(stats.attempted, REFUSAL_STOP_MIN_SAMPLE) > DETAIL_FAILURE_RATIO_THRESHOLD) {
    stats.stopped = {
      reason: `HTTP 406 above the ${Math.round(DETAIL_FAILURE_RATIO_THRESHOLD * 100)}% policy threshold (${stats.refused}/${stats.attempted})`,
      url,
    };
  }
  return kind;
}

/** One detail request: `{ status, html }`, html null unless 2xx; status 0 on network error. */
export async function fetchMySwitzerlandDetailPage(rawUrl, { fetchImpl = globalThis.fetch, timeoutMs = DETAIL_TIMEOUT_MS } = {}) {
  const url = assertDetailUrlAllowed(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: {
        'User-Agent': MYSWITZERLAND_DETAIL_BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: controller.signal,
    });
    if (!res.ok) return { status: res.status, html: null };
    return { status: res.status, html: await res.text() };
  } catch {
    return { status: 0, html: null };
  } finally {
    clearTimeout(timer);
  }
}

/** Markdown for the step summary; also used for the log line. */
export function formatDetailTransportSummary(stats) {
  const lines = [
    '### MySwitzerland: pagine di dettaglio',
    '',
    `- Modo: ${MYSWITZERLAND_DETAIL_TRANSPORT_MODE}`,
    `- Dettagli tentati: ${stats.attempted}`,
    `- 200: ${stats.ok} · 406: ${stats.refused} · 403/429/challenge: ${stats.escalation} · altro: ${stats.other}`,
  ];
  if (stats.stopped) {
    lines.push(`- Fase dettagli FERMATA: ${stats.stopped.reason} (${stats.stopped.url}); batch non scritto, slice invariato`);
  }
  return `${lines.join('\n')}\n`;
}

/** Write the summary (and the `::error::` annotation when stopped). */
export function reportDetailTransport(stats, { env = process.env, log = console.log } = {}) {
  const summary = formatDetailTransportSummary(stats);
  log(`[myswitzerland] detail transport ${MYSWITZERLAND_DETAIL_TRANSPORT_MODE}: attempted ${stats.attempted}, 200 ${stats.ok}, 406 ${stats.refused}, 403/429/challenge ${stats.escalation}, other ${stats.other}`);
  let annotation = null;
  if (stats.stopped) {
    annotation = `::error::MySwitzerland detail phase stopped: ${stats.stopped.reason} at ${stats.stopped.url}; batch not written`;
    log(annotation);
  }
  if (env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(env.GITHUB_STEP_SUMMARY, `${summary}${annotation ? `\n${annotation}\n` : ''}\n`);
    } catch {
      // The summary is an observer: never fail the crawl over it.
    }
  }
  return summary;
}
