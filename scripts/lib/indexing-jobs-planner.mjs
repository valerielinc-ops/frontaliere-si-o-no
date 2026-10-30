/**
 * Google Indexing API — job URL planner (pure, no network).
 *
 * Decides WHICH job URLs to notify on a given day and in which order, from:
 *   - the live job sitemaps (what Google is told exists right now),
 *   - a persistent ledger of what was already notified (restored from the
 *     Actions cache by the calling workflow),
 *   - an optional priority list (job pages the GSC monitor inspected and found
 *     WITHOUT a "Job Postings" rich result).
 *
 * Why a ledger and not "most recent N jobs.json entries" (the pre-2026-10
 * behaviour): between 4 and 22 October 2026 many job pages were served without
 * JobPosting and Google kept that last crawl. Picking the 15 newest jobs per
 * deploy would never reach the ~31k pages already crawled in that state; the
 * ledger lets every active job page be notified once, then keeps new and
 * updated ones flowing first.
 *
 * Quota: Google's default Indexing API quota is 200 publish requests per day
 * per GCP project, reset at midnight America/Los_Angeles. The day key below is
 * therefore the Pacific date, not UTC.
 *
 * @module scripts/lib/indexing-jobs-planner
 */

import {
  JOB_BOARD_SECTION_PREFIX_SOURCE,
  JOB_BOARD_COMPANY_HUB_PATH_RX,
} from './jobBoardSections.mjs';
import { DAILY_BUDGET } from './indexing-api-quota.mjs';

export const LEDGER_VERSION = 1;
export { DAILY_BUDGET };
/** Share of the run budget URL_DELETED may take, so deletions never starve updates (and vice versa). */
export const DELETE_SHARE = 0.2;
/** A priority URL (monitor: no Jobs rich result) is re-notified at most this often. */
export const PRIORITY_RESUBMIT_DAYS = 3;
/** A URL that failed the live JobPosting check is re-checked after this many days. */
export const NOT_JOB_RECHECK_DAYS = 7;
/** A URL gone from the sitemaps but still served indexable is re-checked after this many days. */
export const GONE_RECHECK_DAYS = 7;
/** Ledger entries for URLs gone from the sitemaps are dropped after this many days. */
export const GONE_FORGET_DAYS = 45;
/** Days of per-day counters kept in the ledger. */
const DAY_COUNTERS_KEPT = 10;

const SITE_ORIGIN = 'https://frontaliereticino.ch';
const JOB_DETAIL_PATH_RX = new RegExp(
  `^(?:/(?:en|de|fr))?/(?:${JOB_BOARD_SECTION_PREFIX_SOURCE})-[a-z][a-z-]*/([a-z0-9][a-z0-9-]*)/$`,
);
const PAGINATION_SLUG_RX = /^(?:pagina|page|seite)-\d+$/;

/**
 * Quota day key: the America/Los_Angeles calendar date (YYYY-MM-DD).
 * @param {Date} [now]
 */
export function quotaDayKey(now = new Date()) {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

/** Whole days between two YYYY-MM-DD strings (b - a). */
export function daysBetween(a, b) {
  if (!a || !b) return Infinity;
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/**
 * Cheap shape filter for a job DETAIL page: one slug segment below a canton
 * job-board section, not a company hub, not a pagination page. It is a
 * pre-filter only — landing pages such as `/cerca-lavoro-ticino/oss-ticino/`
 * share the shape, so the caller still verifies the live page carries
 * JobPosting before notifying it.
 * @param {string} url
 */
export function isJobDetailCandidate(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.origin !== SITE_ORIGIN || u.search || u.hash) return false;
  const m = JOB_DETAIL_PATH_RX.exec(u.pathname);
  if (!m) return false;
  if (PAGINATION_SLUG_RX.test(m[1])) return false;
  if (JOB_BOARD_COMPANY_HUB_PATH_RX.test(u.pathname)) return false;
  return true;
}

/**
 * Extract `{loc, lastmod}` from a sitemap urlset (regex: sitemap XML here is
 * machine-emitted by scripts/lib/sitemap-shard.mjs, one <url> per block).
 * @param {string} xml
 * @returns {Array<{loc: string, lastmod: string|null}>}
 */
export function parseSitemapUrlset(xml) {
  const out = [];
  const blockRx = /<url>([\s\S]*?)<\/url>/g;
  let m;
  while ((m = blockRx.exec(xml)) !== null) {
    const loc = /<loc>\s*([^<\s]+)\s*<\/loc>/.exec(m[1])?.[1];
    if (!loc) continue;
    const lastmod = /<lastmod>\s*([^<\s]+)\s*<\/lastmod>/.exec(m[1])?.[1] || null;
    out.push({ loc: decodeXmlEntities(loc), lastmod: lastmod ? lastmod.slice(0, 10) : null });
  }
  return out;
}

/** Sub-sitemap URLs of the job family listed in a sitemap index. */
export function parseJobSitemapIndex(xml) {
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
  // The expired-jobs sitemap lists pages that must NOT be URL_UPDATED.
  return locs.filter((l) => /\/sitemap-jobs(?:-[a-z0-9-]+)?\.xml$/.test(l) && !/sitemap-jobs-expired\.xml$/.test(l));
}

function decodeXmlEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

/** Empty ledger. `createdAt` separates the bootstrap population from genuinely new jobs. */
export function createLedger(today) {
  return { version: LEDGER_VERSION, createdAt: today, days: {}, urls: {}, notifications: {} };
}

/** Parse a ledger, falling back to a fresh one on any shape mismatch. */
export function loadLedger(raw, today) {
  try {
    const l = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (l && l.version === LEDGER_VERSION && l.urls && typeof l.urls === 'object' && l.createdAt) {
      l.days = l.days && typeof l.days === 'object' ? l.days : {};
      l.notifications = l.notifications && typeof l.notifications === 'object' ? l.notifications : {};
      return l;
    }
  } catch { /* fall through */ }
  return createLedger(today);
}

/** Requests already spent on the given quota day (by every caller sharing the ledger). */
export function spentOn(ledger, day) {
  return Number(ledger.days?.[day]) || 0;
}

/** Reserve one real Indexing API publish request before making the POST. */
export function reserveQuota(ledger, today) {
  const spent = spentOn(ledger, today);
  if (spent >= DAILY_BUDGET) return false;
  ledger.days[today] = spent + 1;
  return true;
}

/** Keep the latest non-job caller visible in the shared ledger. */
export function recordNotification(ledger, { url, type = 'URL_UPDATED', source = 'article' }, outcome, today) {
  if (!ledger.notifications || typeof ledger.notifications !== 'object') ledger.notifications = {};
  ledger.notifications[url] = {
    source,
    type,
    attempted: today,
    ...(outcome.ok ? { sent: today } : { status: outcome.status ?? 0, error: outcome.error || 'request_failed' }),
  };
}

/**
 * Record the current sitemap population: set first-seen on new URLs, refresh
 * the observed lastmod, and mark entries that left the sitemaps.
 * @param {object} ledger mutated in place
 * @param {Array<{loc: string, lastmod: string|null}>} entries job-detail candidates only
 * @param {string} today YYYY-MM-DD
 */
export function observeSitemap(ledger, entries, today) {
  const present = new Set();
  for (const { loc, lastmod } of entries) {
    present.add(loc);
    const e = ledger.urls[loc] || (ledger.urls[loc] = { f: today });
    if (lastmod) e.m = lastmod;
    delete e.gone;
  }
  for (const [url, e] of Object.entries(ledger.urls)) {
    if (present.has(url)) continue;
    if (!e.gone) e.gone = today;
    if (daysBetween(e.gone, today) > GONE_FORGET_DAYS) delete ledger.urls[url];
  }
  for (const day of Object.keys(ledger.days).sort().slice(0, -DAY_COUNTERS_KEPT)) delete ledger.days[day];
  return present;
}

/**
 * Ordered work list. Tiers (first wins):
 *   1. priority — active URLs the monitor found without a Jobs rich result
 *      (re-notified at most every PRIORITY_RESUBMIT_DAYS);
 *   2. new — first seen after the ledger was bootstrapped, never notified;
 *   3. delete — dropped from the sitemaps after the ledger saw it there, never
 *      URL_DELETED-notified (capped at
 *      DELETE_SHARE of the run; the caller still verifies 404/410/noindex);
 *   4. updated — sitemap lastmod newer than the last notification;
 *   5. never notified — the bootstrap backlog, newest lastmod first.
 *
 * @param {object} ledger
 * @param {{today: string, max: number, priority?: string[]}} opts
 * @returns {Array<{url: string, type: 'URL_UPDATED'|'URL_DELETED', tier: string}>}
 */
export function planSubmissions(ledger, { today, max, priority = [] }) {
  if (!(max > 0)) return [];
  const out = [];
  const taken = new Set();
  const push = (url, type, tier) => {
    if (taken.has(url)) return;
    taken.add(url);
    out.push({ url, type, tier });
  };
  const fresh = (e) => !e.gone && !(e.n && daysBetween(e.n, today) < NOT_JOB_RECHECK_DAYS);
  const entries = Object.entries(ledger.urls);

  for (const url of priority) {
    const e = ledger.urls[url];
    if (!e || !fresh(e)) continue;
    if (e.s && daysBetween(e.s, today) < PRIORITY_RESUBMIT_DAYS) continue;
    push(url, 'URL_UPDATED', 'priority');
  }
  for (const [url, e] of entries) {
    if (fresh(e) && !e.s && e.f > ledger.createdAt) push(url, 'URL_UPDATED', 'new');
  }
  const deleteCap = Math.max(1, Math.floor(max * DELETE_SHARE));
  let deletes = 0;
  for (const [url, e] of entries) {
    if (deletes >= deleteCap) break;
    // Any URL the sitemaps advertised to Google and then dropped.
    if (!e.gone || e.d) continue;
    if (e.g && daysBetween(e.g, today) < GONE_RECHECK_DAYS) continue;
    push(url, 'URL_DELETED', 'delete');
    deletes += 1;
  }
  for (const [url, e] of entries) {
    if (fresh(e) && e.s && e.m && e.m > e.s) push(url, 'URL_UPDATED', 'updated');
  }
  const backlog = entries
    .filter(([, e]) => fresh(e) && !e.s)
    .sort(([ua, a], [ub, b]) => (b.m || '').localeCompare(a.m || '') || backlogRank(ua) - backlogRank(ub));
  for (const [url] of backlog) push(url, 'URL_UPDATED', 'backlog');

  return out;
}

/**
 * Backlog tie-break when lastmod is equal or absent: Ticino before the other
 * cantons (it carries most JOB_LISTING clicks, seo-data pages-L28 2026-10),
 * then the Italian URL before its EN/DE/FR alternates. Stable sort keeps the
 * sitemap order inside each bucket.
 * @param {string} url
 */
export function backlogRank(url) {
  const path = url.slice(SITE_ORIGIN.length);
  const localized = /^\/(?:en|de|fr)\//.test(path) ? 1 : 0;
  const ticino = /^(?:\/(?:en|de|fr))?\/[a-z-]*-(?:ticino|tessin)\//.test(path) ? 0 : 2;
  return ticino + localized;
}

/**
 * Apply the outcome of one attempt to the ledger.
 * @param {object} ledger
 * @param {{url: string, type: string}} item
 * @param {'sent'|'not-job'|'still-live'|'transient'|'failed'} outcome
 *   `transient` (timeout, network error, 429/5xx) leaves the entry untouched,
 *   so the URL stays plannable on the next run.
 * @param {string} today
 */
export function recordOutcome(ledger, item, outcome, today, { quotaReserved = false } = {}) {
  const e = ledger.urls[item.url] || (ledger.urls[item.url] = { f: today });
  if (outcome === 'sent') {
    if (item.type === 'URL_DELETED') e.d = today; else { e.s = today; delete e.n; }
    if (!quotaReserved) ledger.days[today] = spentOn(ledger, today) + 1;
  } else if (outcome === 'not-job') {
    e.n = today;
  } else if (outcome === 'still-live') {
    e.g = today;
  }
}

/**
 * Classify a live response for the planned notification type.
 * URL_UPDATED requires a 200 job page carrying JobPosting and no noindex.
 * URL_DELETED requires the page to be really gone for Google: 404/410, or a
 * 200 with a robots noindex (Google's Indexing API removal contract).
 * @param {'URL_UPDATED'|'URL_DELETED'} type
 * @param {{status: number, html?: string}} res
 * A 429/5xx is `transient`: the edge said nothing about the page itself.
 * @returns {'ok'|'not-job'|'still-live'|'transient'}
 */
export function judgeLive(type, { status, html = '' }) {
  if (status === 429 || status >= 500) return 'transient';
  const noindex = /<meta[^>]+name=["']?robots["']?[^>]*content=["'][^"']*noindex/i.test(html)
    || /<meta[^>]+content=["'][^"']*noindex[^"']*["'][^>]*name=["']?robots/i.test(html);
  if (type === 'URL_DELETED') {
    if (status === 404 || status === 410) return 'ok';
    if (status === 200 && noindex) return 'ok';
    return 'still-live';
  }
  if (status !== 200 || noindex) return 'not-job';
  return /"@type"\s*:\s*"JobPosting"/.test(html) ? 'ok' : 'not-job';
}
