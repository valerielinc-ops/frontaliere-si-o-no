/**
 * fetch-article-performance.mjs
 *
 * Reads GSC + GA4 + PostHog + AdSense for each blog article URL,
 * computes composite performance score, writes data/article-performance.json.
 * Used by scripts/create-article.mjs to inject "winner fingerprint"
 * priors into the LLM generation prompt.
 *
 * Env (all optional, graceful):
 *   FIREBASE_SERVICE_ACCOUNT_JSON  — for GSC + GA4 (same SA reused)
 *   GOOGLE_APPLICATION_CREDENTIALS — path to SA file (workflow writes it)
 *   GA4_PROPERTY_ID                — GA4 property id (e.g. "properties/123" or just "123")
 *   POSTHOG_PERSONAL_API_KEY       — PostHog read-only key
 *   POSTHOG_PROJECT_ID             — PostHog project id
 *   POSTHOG_HOST                   — default https://eu.posthog.com
 *   ADSENSE_CLIENT_ID, ADSENSE_CLIENT_SECRET, ADSENSE_REFRESH_TOKEN
 *                                  — see revenue-monitor.mjs for the
 *                                    inherited GSC_* fallback chain.
 *   PERF_WINDOW_DAYS               — default 30
 *
 * When no source is configured, the script still exits 0, writes a
 * well-formed JSON with empty winners[]/losers[] and `sources.*.ok=false`.
 *
 * Spec: docs/superpowers/specs/2026-05-06-smarter-article-generator-design.md
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  discoverArticles,
  articleUrls,
  parseSeoBlogFiles,
  inferClusterFromTitleAndSlug,
} from './lib/perf-sources/articleDiscovery.mjs';
import { safe, pathnameFromUrl } from './lib/perf-sources/safe.mjs';
import { fetchGscByPage } from './lib/perf-sources/gsc.mjs';
import { fetchGa4ByPage } from './lib/perf-sources/ga4.mjs';
import { fetchPostHogByPage } from './lib/perf-sources/posthog.mjs';
import { fetchAdsenseChannelRevenue } from './lib/perf-sources/adsense.mjs';
import {
  composeScores,
  buildWinnerFingerprint,
  sortScored,
} from './lib/perf-sources/scoring.mjs';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

const WINDOW_DAYS = Number(process.env.PERF_WINDOW_DAYS || 30);
const MIN_AGE_DAYS = 14;
const MAX_WINNERS = 20;
const MAX_LOSERS = 50;
const LOSER_MIN_IMPRESSIONS = 50;

function isoNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function daysSince(isoDate) {
  if (!isoDate) return null;
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / 86_400_000);
}

/**
 * Pure aggregator — exported for tests. Given the source results, produces
 * the final JSON object that gets written to disk.
 *
 * sources.* shape:
 *   gsc:     { ok: true, rows, perPath: Map<path, {clicks, impressions, ctr, position}> }
 *   ga4:     { ok: true, rows, perPath: Map<path, {pageviews, engagementRate, ...}> }
 *   posthog: { ok: true, rows, perPath: Map<path, {pageviews, scrollP50}> }
 *   adsense: { ok: true, rows, totalRevenue, perChannel }
 *
 * articles: Array<{ slug, locale, url, title, excerpt }>
 * seoMeta: Map<slug, { cluster, publishedAt }>
 */
export function aggregate({ articles, seoMeta, sources, generatedAt = isoNow(), windowDays = WINDOW_DAYS }) {
  // 1) Build per-URL row blending all available signals.
  // Pageview share is needed to distribute AdSense revenue when AdSense is
  // present (per-channel, distributed by GA4 pageviews → fall back to
  // PostHog pageviews → fall back to GSC clicks).
  const ga4PerPath = sources.ga4?.ok ? sources.ga4.perPath : new Map();
  const phPerPath = sources.posthog?.ok ? sources.posthog.perPath : new Map();
  const gscPerPath = sources.gsc?.ok ? sources.gsc.perPath : new Map();
  const adsenseTotal = sources.adsense?.ok ? Number(sources.adsense.totalRevenue || 0) : 0;

  // Compute per-path "view share" for AdSense distribution.
  let viewShareMap = null;
  if (adsenseTotal > 0) {
    const candidates = [];
    for (const a of articles) {
      const p = pathnameFromUrl(a.url);
      if (!p) continue;
      let views = 0;
      if (ga4PerPath.has(p)) views = Number(ga4PerPath.get(p).pageviews || 0);
      else if (phPerPath.has(p)) views = Number(phPerPath.get(p).pageviews || 0);
      else if (gscPerPath.has(p)) views = Number(gscPerPath.get(p).clicks || 0);
      if (views > 0) candidates.push({ p, views });
    }
    const totalViews = candidates.reduce((acc, c) => acc + c.views, 0);
    if (totalViews > 0) {
      viewShareMap = new Map(candidates.map((c) => [c.p, c.views / totalViews]));
    }
  }

  /** @type {Array<any>} */
  const rows = [];
  for (const a of articles) {
    const p = pathnameFromUrl(a.url);
    if (!p) continue;
    const gsc = gscPerPath.get(p) || null;
    const ga4 = ga4PerPath.get(p) || null;
    const ph = phPerPath.get(p) || null;
    const meta = seoMeta.get(a.slug) || { cluster: null, publishedAt: null };
    // articleSection is the preferred source; only ~10/2140 articles set it,
    // so for the rest we fall back to a heuristic over title+slug+excerpt.
    // Producer-side cluster filling drives the winnerFingerprint topClusters
    // off the 99% "unknown" floor that consumer-side filtering can only mute.
    const clusterValue = meta.cluster
      || inferClusterFromTitleAndSlug(a.title, a.slug, a.excerpt);

    const clicks = gsc?.clicks ?? null;
    const impressions = gsc?.impressions ?? null;
    const ctr = gsc?.ctr ?? null;
    const pageviews = ga4?.pageviews ?? ph?.pageviews ?? null;
    const adsenseRevenue = viewShareMap?.has(p)
      ? Number((viewShareMap.get(p) * adsenseTotal).toFixed(4))
      : null;
    // Use real adsense revenue if available, else pageviews-as-proxy.
    const adsenseRevenueOrProxy = adsenseRevenue !== null ? adsenseRevenue : pageviews;
    const scrollP50 = ph?.scrollP50 ?? null;

    // Skip articles too young to evaluate.
    const ageDays = daysSince(meta.publishedAt);
    const tooYoung = ageDays !== null && ageDays < MIN_AGE_DAYS;

    // Skip articles with NO metric across any source.
    const hasAnyMetric =
      (clicks !== null && clicks !== undefined) ||
      (impressions !== null && impressions !== undefined) ||
      (pageviews !== null && pageviews !== undefined) ||
      (adsenseRevenue !== null && adsenseRevenue !== undefined) ||
      (scrollP50 !== null && scrollP50 !== undefined);

    rows.push({
      slug: a.slug,
      locale: a.locale,
      url: a.url,
      title: a.title,
      excerpt: a.excerpt,
      cluster: clusterValue,
      publishedAt: meta.publishedAt || null,
      clicks,
      impressions,
      ctr,
      pageviews,
      adsenseRevenue,
      adsenseRevenueOrProxy,
      scrollP50,
      wordCount: a.wordCount || null, // populated where available
      tooYoung,
      hasAnyMetric,
    });
  }

  // 2) Score eligible rows (have a metric AND old enough).
  const eligible = rows.filter((r) => r.hasAnyMetric && !r.tooYoung);
  const scored = composeScores(eligible);
  const sorted = sortScored(scored);

  // 3) Winners (top N) and losers (bottom, with impressions filter).
  const winners = sorted.slice(0, MAX_WINNERS);
  const losersPool = [...sorted]
    .reverse()
    .filter((r) => (r.impressions || 0) > LOSER_MIN_IMPRESSIONS)
    .slice(0, MAX_LOSERS);

  const fingerprint = buildWinnerFingerprint(winners, articles);

  return {
    generatedAt,
    windowDays,
    articleCount: articles.length,
    articlesScored: scored.length,
    filters: {
      newsletter: { applied: true, method: 'utm_medium=newsletter (GA4 + PostHog); GSC is organic-only' },
    },
    sources: serializeSources(sources),
    scoreFormula: '0.4*z(clicks) + 0.2*z(impressions) + 0.2*z(adsense_revenue||proxy) + 0.1*z(scroll_depth_p50) + 0.1*z(ctr)',
    winners: winners.map(toOutputRow),
    losers: losersPool.map(toOutputRow),
    winnerFingerprint: fingerprint,
  };
}

function toOutputRow(r) {
  return {
    slug: r.slug,
    locale: r.locale,
    url: r.url,
    title: r.title,
    score: r.score,
    cluster: r.cluster,
    publishedAt: r.publishedAt,
    metrics: {
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: r.ctr !== null && r.ctr !== undefined ? Number(r.ctr.toFixed?.(4) ?? r.ctr) : null,
      pageviews: r.pageviews,
      adsenseRevenue: r.adsenseRevenue,
      scrollP50: r.scrollP50,
    },
  };
}

function serializeSources(sources) {
  const out = {};
  for (const [name, s] of Object.entries(sources)) {
    if (!s) {
      out[name] = { ok: false, reason: 'not run' };
    } else if (s.ok) {
      const entry = { ok: true };
      if (typeof s.rows === 'number') entry.rows = s.rows;
      if (typeof s.totalRevenue === 'number') entry.totalRevenue = s.totalRevenue;
      // AdSense visibility: surface per-channel revenue + which hint matched
      // so the JSON consumer can debug zero-revenue cases without re-running.
      if (typeof s.totalAcrossAllChannels === 'number') {
        entry.totalAcrossAllChannels = s.totalAcrossAllChannels;
      }
      if (typeof s.matchedHints === 'boolean') entry.matchedHints = s.matchedHints;
      if (Array.isArray(s.matchedChannelNames)) entry.matchedChannelNames = s.matchedChannelNames;
      if (s.perChannel && typeof s.perChannel === 'object') entry.perChannel = s.perChannel;
      // AdSense pagination diagnostics — `rows` alone hides whether the
      // count is small because the API returned little data or because we
      // truncated. Surface pages/truncated/dropped so the JSON consumer
      // can tell at a glance.
      if (typeof s.pages === 'number') entry.pages = s.pages;
      if (typeof s.truncated === 'boolean' && s.truncated) entry.truncated = true;
      if (typeof s.droppedMalformed === 'number' && s.droppedMalformed > 0) {
        entry.droppedMalformed = s.droppedMalformed;
      }
      out[name] = entry;
    } else {
      out[name] = { ok: false, reason: s.reason || 'unknown' };
    }
  }
  return out;
}

async function main() {
  console.log(`[perf] window: ${WINDOW_DAYS} days`);

  const articleMap = discoverArticles({ rootDir: ROOT });
  const articles = articleUrls(articleMap);
  const seoMeta = parseSeoBlogFiles({ rootDir: ROOT });
  console.log(`[perf] discovered ${articles.length} URLs across ${articleMap.size} unique slugs`);
  console.log(`[perf] seo-blog meta entries: ${seoMeta.size}`);

  // Each source is wrapped in safe() so the orchestrator never throws.
  const [gsc, ga4, posthog, adsense] = await Promise.all([
    safe('gsc', () => fetchGscByPage({ windowDays: WINDOW_DAYS })),
    safe('ga4', () => fetchGa4ByPage({ windowDays: WINDOW_DAYS })),
    safe('posthog', () => fetchPostHogByPage({ windowDays: WINDOW_DAYS })),
    safe('adsense', () => fetchAdsenseChannelRevenue({ windowDays: WINDOW_DAYS })),
  ]);

  for (const [name, s] of Object.entries({ gsc, ga4, posthog, adsense })) {
    if (s.ok) {
      console.log(`[perf] ${name}: ok (${s.rows ?? 'n/a'} rows)`);
    } else {
      console.log(`[perf] ${name}: SKIP — ${s.reason}`);
    }
  }

  const output = aggregate({
    articles,
    seoMeta,
    sources: { gsc, ga4, posthog, adsense },
  });

  const outPath = path.join(ROOT, 'data', 'article-performance.json');
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n');
  console.log(
    `[perf] wrote ${outPath} — ${output.articlesScored} scored / ${output.articleCount} total, ${output.winners.length} winners, ${output.losers.length} losers`,
  );
}

// Entry-point gate (so tests can `import` the module without side effects).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    // We deliberately do NOT exit 1 on top-level failure: the contract is
    // "always succeed, write a partial file". But fingerprint+aggregate
    // failures are programming errors and should fail the workflow loudly.
    console.error('[perf] FATAL', err);
    process.exit(1);
  });
}
