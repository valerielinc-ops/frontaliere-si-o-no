#!/usr/bin/env node
/**
 * Frontaliere Ticino — Analytics Report
 *
 * Comprehensive analytics report combining:
 *   1. Google Search Console  — top queries, top pages, 30-day trends, coverage
 *   2. PageSpeed Insights     — mobile + desktop scores for key pages
 *   3. GA4 Data API           — sessions, users, page views, traffic sources (optional)
 *
 * Usage:
 *   node scripts/analytics-report.mjs                  # All available reports
 *   node scripts/analytics-report.mjs --gsc            # Search Console only
 *   node scripts/analytics-report.mjs --pagespeed      # PageSpeed only
 *   node scripts/analytics-report.mjs --ga4            # GA4 only
 *   node scripts/analytics-report.mjs --indexing       # Indexing status only
 *   node scripts/analytics-report.mjs --bing           # Bing Webmaster Tools only
 *   node scripts/analytics-report.mjs --clarity        # Microsoft Clarity only
 *   node scripts/analytics-report.mjs --json           # Output raw JSON
 *   node scripts/analytics-report.mjs --days 30        # Override period (default: 30)
 *   node scripts/analytics-report.mjs --save           # Save report to reports/ folder
 *
 * Environment variables (loaded from Firebase Remote Config via load-rc-env.mjs):
 *   GSC_CLIENT_ID       — OAuth2 client ID (for Search Console + GA4)
 *   GSC_CLIENT_SECRET   — OAuth2 client secret
 *   GSC_REFRESH_TOKEN   — OAuth2 refresh token
 *   GA4_PROPERTY_ID     — GA4 property ID (e.g., "properties/123456789")
 *   PAGESPEED_API_KEY   — (optional) Google PageSpeed API key for higher quota
 *   BING_API_KEY        — (optional) Bing Webmaster Tools API key
 *   CLARITY_API_KEY     — (optional) Microsoft Clarity Data Export API token
 *
 * Always exits 0 — failures are logged, never block CI.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  aggregateRowsByTemplate,
  buildAnalyticsSnapshot,
  buildNearWinQueries,
  clusterTopQueries,
} from './lib/analytics-opportunity-utils.mjs';
import { normalizeInspectionUrl } from './lib/url-normalize.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE_URL = 'https://frontaliereticino.ch';
const SERP_HISTORY_PATH = resolve(__dirname, '..', 'data', 'seo-serp-experiment-history.json');
const SERP_LAST_RUN_PATH = resolve(__dirname, '..', 'data', 'seo-serp-autopilot-last-run.json');

// ── CLI Args ────────────────────────────────────────────────
const args = process.argv.slice(2);
const flags = {
  gsc: args.includes('--gsc'),
  pagespeed: args.includes('--pagespeed'),
  ga4: args.includes('--ga4'),
  indexing: args.includes('--indexing'),
  bing: args.includes('--bing'),
  clarity: args.includes('--clarity'),
  json: args.includes('--json'),
  save: args.includes('--save'),
};
// If no specific flag, run all
const runAll = !flags.gsc && !flags.pagespeed && !flags.ga4 && !flags.indexing && !flags.bing && !flags.clarity;

const daysIdx = args.indexOf('--days');
const DAYS = daysIdx !== -1 ? parseInt(args[daysIdx + 1], 10) || 30 : 30;

// ── Helpers ─────────────────────────────────────────────────
function log(emoji, msg) {
  if (!flags.json) console.log(`${emoji}  ${msg}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function fmtDate(d) {
  return d.toISOString().split('T')[0];
}

function fmtNum(n) {
  return new Intl.NumberFormat('it-CH').format(n);
}

function pct(n) {
  return (n * 100).toFixed(1) + '%';
}

function readJsonSafe(filePath, fallback = null) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function getCtrOpportunities(topPages = [], minImpressions = 150, maxCtrPercent = 1.5) {
  return topPages
    .filter((page) => page.impressions >= minImpressions && page.ctr <= maxCtrPercent)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 10);
}

function getLowCtrQueries(topQueries = [], minImpressions = 150, maxCtrPercent = 2.5, maxPosition = 8) {
  return topQueries
    .filter((query) => Number(query?.impressions || 0) >= minImpressions)
    .filter((query) => Number(query?.ctr || 0) <= maxCtrPercent)
    .filter((query) => Number(query?.position || 0) <= maxPosition)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 12);
}

const KEYWORD_STOPWORDS = new Set([
  'dei', 'degli', 'delle', 'della', 'dello', 'dall', 'dalla', 'dalle',
  'del', 'dell', 'alla', 'alle', 'allo', 'agli', 'con', 'per', 'tra', 'fra',
  'nel', 'nella', 'nelle', 'nello', 'sul', 'sulla', 'sulle', 'sullo',
  'che', 'chi', 'come', 'dove', 'quando', 'quale', 'quali', 'sono', 'se',
  'the', 'and', 'for', 'with', 'from', 'your', 'you', 'una', 'uno', 'gli',
  'das', 'der', 'die', 'und', 'mit', 'von', 'fuer',
]);

const ROUTE_NOISE_TOKENS = new Set([
  'frontaliere', 'frontalieri', 'ticino', 'svizzera', 'italia',
  'cerca', 'lavoro', 'compara', 'confronta', 'simula', 'calcola',
  'articoli', 'articolo', 'guida', 'servizi', 'statistiche',
  'page', 'pagina', 'home', 'index', 'www', 'http', 'https',
]);

function isArticlePagePath(path = '') {
  const clean = String(path || '').toLowerCase().split('?')[0].split('#')[0];
  return clean.startsWith('/articoli-frontaliere/');
}

function normalizeKeywordToken(token) {
  return String(token || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-+|-+$/g, '');
}

function extractKeywordsFromPath(path = '') {
  let cleanPath = String(path || '');
  try { cleanPath = decodeURIComponent(cleanPath); } catch { /* noop */ }
  cleanPath = cleanPath.toLowerCase().split('?')[0].split('#')[0];

  return cleanPath
    .split('/')
    .filter(Boolean)
    .flatMap(segment => segment.split(/[^a-z0-9]+/g))
    .map(normalizeKeywordToken)
    .filter((token) =>
      token.length >= 3 &&
      !/^\d+$/.test(token) &&
      !KEYWORD_STOPWORDS.has(token) &&
      !ROUTE_NOISE_TOKENS.has(token)
    );
}

function rankKeywordsFromPages(pages = [], { limit = 20, includeDurationWeight = false } = {}) {
  const buckets = new Map();

  for (const row of pages) {
    const keywords = extractKeywordsFromPath(row?.path || '');
    if (keywords.length === 0) continue;

    const views = Number(row?.views || 0);
    const avgDuration = Number(row?.avgDuration || 0);
    const durationBoost = includeDurationWeight ? Math.max(1, Math.min(avgDuration, 600) / 60) : 1;
    const score = views * durationBoost;

    for (const keyword of keywords) {
      const current = buckets.get(keyword) || {
        keyword,
        score: 0,
        views: 0,
        pages: 0,
      };
      current.score += score;
      current.views += views;
      current.pages += 1;
      buckets.set(keyword, current);
    }
  }

  return [...buckets.values()]
    .sort((a, b) => b.score - a.score || b.views - a.views || b.pages - a.pages)
    .slice(0, limit)
    .map((entry) => ({
      keyword: entry.keyword,
      score: Math.round(entry.score),
      views: Math.round(entry.views),
      pages: entry.pages,
    }));
}

function buildKeywordDirectionComment({
  keywordInterest = [],
  articleKeywordInterest = [],
  topArticlePages = [],
  topArticlePagesByTime = [],
}) {
  const focusKeywords = (articleKeywordInterest.length > 0 ? articleKeywordInterest : keywordInterest)
    .slice(0, 5)
    .map((k) => k.keyword);
  if (focusKeywords.length === 0) {
    return 'Dati keyword insufficienti: mantenere monitoraggio e ampliare finestra temporale del report.';
  }

  const supportKeywords = keywordInterest
    .map((k) => k.keyword)
    .filter((k) => !focusKeywords.includes(k))
    .slice(0, 4);

  const mostRead = topArticlePages.slice(0, 2).map((p) => p.path).join(', ');
  const longestRead = topArticlePagesByTime.slice(0, 2).map((p) => p.path).join(', ');

  let comment = `Priorita keyword: spingere i cluster ${focusKeywords.map((k) => `"${k}"`).join(', ')} con nuovi contenuti e refresh, perche concentrano interesse reale (traffico + lettura).`;
  if (supportKeywords.length > 0) {
    comment += ` In supporto, presidiare pagine evergreen su ${supportKeywords.map((k) => `"${k}"`).join(', ')}.`;
  }
  if (mostRead) {
    comment += ` Articoli piu visitati: ${mostRead}.`;
  }
  if (longestRead) {
    comment += ` Articoli con maggiore tempo medio: ${longestRead}.`;
  }
  comment += ' Aggiornare il piano keyword al prossimo run sulla base delle prime keyword per score.';
  return comment;
}

function reportSeoSerpABTest(report) {
  const history = readJsonSafe(SERP_HISTORY_PATH, { snapshots: [] });
  const lastRun = readJsonSafe(SERP_LAST_RUN_PATH, null);
  const snapshots = Array.isArray(history?.snapshots) ? history.snapshots : [];
  const cutoffTs = Date.now() - DAYS * 24 * 60 * 60 * 1000;

  const windowSnapshots = snapshots.filter((s) => {
    const ts = new Date(s?.createdAt || 0).getTime();
    return Number.isFinite(ts) && ts >= cutoffTs;
  });

  const variants = ['year_intent', 'intent_simulation'];
  const byVariant = {};
  for (const v of variants) {
    const arr = windowSnapshots.filter((s) => s?.variant === v);
    const impressions = arr.reduce((sum, s) => sum + Number(s?.kpi?.totalImpressions || 0), 0);
    const clicks = arr.reduce((sum, s) => sum + Number(s?.kpi?.totalClicks || 0), 0);
    byVariant[v] = {
      samples: arr.length,
      impressions,
      clicks,
      ctr: impressions > 0 ? Number(((clicks / impressions) * 100).toFixed(3)) : 0,
    };
  }

  const exposures = Array.isArray(report?.ga4?.serpExperiment)
    ? report.ga4.serpExperiment.reduce((sum, row) => sum + Number(row.eventCount || 0), 0)
    : 0;

  const currentVariant = lastRun?.desired?.variant || history?.lastVariant || 'unknown';
  const currentEnabled = Boolean(lastRun?.desired?.enabled);
  const lastDecision = lastRun?.decision?.reason || 'n/a';

  let recommendation = 'insufficient_data';
  const yearIntentCtr = byVariant.year_intent.ctr;
  const intentSimulationCtr = byVariant.intent_simulation.ctr;
  const delta = Number((yearIntentCtr - intentSimulationCtr).toFixed(3));
  const enoughData =
    byVariant.year_intent.impressions >= 4000 &&
    byVariant.intent_simulation.impressions >= 4000 &&
    byVariant.year_intent.samples >= 2 &&
    byVariant.intent_simulation.samples >= 2;
  if (enoughData) {
    if (Math.abs(delta) >= 0.15) {
      recommendation = delta > 0 ? 'winner_year_intent' : 'winner_intent_simulation';
    } else {
      recommendation = 'no_clear_winner';
    }
  }

  const summary = {
    enabled: currentEnabled,
    currentVariant,
    lastDecision,
    exposures,
    windowDays: DAYS,
    byVariant,
    deltaCtrYearIntentMinusIntentSimulation: delta,
    recommendation,
    lastAutopilotRunAt: lastRun?.generatedAt || null,
  };

  if (!flags.json) {
    log('', '');
    log('🧪', `A/B SEO SERP (ultimi ${DAYS} giorni)`);
    log('', '─'.repeat(50));
    log('', `  Enabled: ${summary.enabled ? 'true' : 'false'} | Variante attiva: ${summary.currentVariant}`);
    log('', `  Exposures GA4: ${fmtNum(summary.exposures)} | Ultima decisione: ${summary.lastDecision}`);
    log('', `  year_intent      -> CTR ${String(summary.byVariant.year_intent.ctr).padStart(5)}% | Impr ${fmtNum(summary.byVariant.year_intent.impressions).padStart(8)} | Samples ${summary.byVariant.year_intent.samples}`);
    log('', `  intent_simulation-> CTR ${String(summary.byVariant.intent_simulation.ctr).padStart(5)}% | Impr ${fmtNum(summary.byVariant.intent_simulation.impressions).padStart(8)} | Samples ${summary.byVariant.intent_simulation.samples}`);
    log('', `  Delta CTR (year_intent - intent_simulation): ${summary.deltaCtrYearIntentMinusIntentSimulation}%`);
    log('', `  Raccomandazione: ${summary.recommendation}`);
  }

  return summary;
}

async function fetchRetry(url, options = {}, retries = 2, timeoutMs = 0) {
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      const fetchOptions = { ...options };
      if (timeoutMs > 0) {
        fetchOptions.signal = AbortSignal.timeout(timeoutMs);
      }
      const res = await fetch(url, fetchOptions);
      if (res.ok) return res;
      if ((res.status === 429 || res.status >= 500) && attempt <= retries) {
        const delay = res.status === 429 ? 10000 * attempt : 2000 * attempt;
        await sleep(delay);
        continue;
      }
      return res;
    } catch (err) {
      if (attempt <= retries) {
        await sleep(2000 * attempt);
        continue;
      }
      throw err;
    }
  }
}

// ── Service Account Auth (for Admin API write operations) ───
async function getServiceAccountToken(scopes) {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) return null;
  try {
    const { GoogleAuth } = await import('google-auth-library');
    const auth = new GoogleAuth({ scopes });
    const client = await auth.getClient();
    // Log SA email for diagnostics (not a secret — it's a public GCP identifier)
    if (client.email) log('ℹ️', `Using service account: ${client.email}`);
    const { token } = await client.getAccessToken();
    return token;
  } catch (e) {
    log('⚠️', `Service account auth failed: ${e.message}`);
    return null;
  }
}

// ── OAuth2 Auth ─────────────────────────────────────────────
async function getAccessToken() {
  const clientId = process.env.GSC_CLIENT_ID;
  const clientSecret = process.env.GSC_CLIENT_SECRET;
  const refreshToken = process.env.GSC_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) return null;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  return (await res.json()).access_token;
}

// ── Detect GSC site property ────────────────────────────────
async function detectSiteUrl(token) {
  try {
    const res = await fetchRetry('https://www.googleapis.com/webmasters/v3/sites', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return SITE_URL;
    const data = await res.json();
    const sites = (data.siteEntry || []).map(s => s.siteUrl);
    const match = sites.find(s => s === SITE_URL || s === SITE_URL + '/');
    if (match) return match.replace(/\/$/, '');
    const domain = sites.find(s => s.startsWith('sc-domain:') && SITE_URL.includes(s.replace('sc-domain:', '')));
    return domain || SITE_URL;
  } catch {
    return SITE_URL;
  }
}

// ═══════════════════════════════════════════════════════════
// 1. GOOGLE SEARCH CONSOLE
// ═══════════════════════════════════════════════════════════
async function reportGSC(token) {
  log('🔎', `Search Console — Ultimi ${DAYS} giorni`);
  log('', '─'.repeat(50));

  const siteUrl = await detectSiteUrl(token);
  const encoded = encodeURIComponent(siteUrl);
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  const endDate = new Date();
  endDate.setDate(endDate.getDate() - 2); // GSC data has 2-day lag
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - DAYS);

  const baseBody = {
    startDate: fmtDate(startDate),
    endDate: fmtDate(endDate),
  };

  const result = { period: `${fmtDate(startDate)} → ${fmtDate(endDate)}` };

  // ── 1a. Overall summary ─────────────────
  try {
    const res = await fetchRetry(
      `https://www.googleapis.com/webmasters/v3/sites/${encoded}/searchAnalytics/query`,
      { method: 'POST', headers, body: JSON.stringify({ ...baseBody, dimensions: [], rowLimit: 1 }) }
    );
    if (res.ok) {
      const data = await res.json();
      const row = data.rows?.[0];
      if (row) {
        result.summary = {
          clicks: row.clicks,
          impressions: row.impressions,
          ctr: row.ctr,
          avgPosition: parseFloat(row.position.toFixed(1)),
        };
        log('📊', `Click: ${fmtNum(row.clicks)}  |  Impressioni: ${fmtNum(row.impressions)}  |  CTR: ${pct(row.ctr)}  |  Pos media: ${row.position.toFixed(1)}`);
      }
    }
  } catch (e) { log('⚠️', `Summary: ${e.message}`); }

  // ── 1b. Top 20 queries ──────────────────
  try {
    const res = await fetchRetry(
      `https://www.googleapis.com/webmasters/v3/sites/${encoded}/searchAnalytics/query`,
      { method: 'POST', headers, body: JSON.stringify({ ...baseBody, dimensions: ['query'], rowLimit: 20 }) }
    );
    if (res.ok) {
      const data = await res.json();
      result.topQueries = (data.rows || []).map(r => ({
        query: r.keys[0],
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: parseFloat((r.ctr * 100).toFixed(1)),
        position: parseFloat(r.position.toFixed(1)),
      }));
      result.nearWinQueries = buildNearWinQueries(result.topQueries);
      result.lowCtrQueries = getLowCtrQueries(result.topQueries);
      result.queryClusters = clusterTopQueries(result.topQueries);
      if (!flags.json && result.topQueries.length > 0) {
        log('', '');
        log('🔍', 'Top 20 Query:');
        log('', '  Query'.padEnd(50) + 'Click'.padStart(8) + 'Impr.'.padStart(10) + 'CTR'.padStart(8) + 'Pos'.padStart(6));
        log('', '  ' + '─'.repeat(78));
        for (const q of result.topQueries) {
          log('', `  ${q.query.slice(0, 47).padEnd(48)}${String(q.clicks).padStart(8)}${String(q.impressions).padStart(10)}${(q.ctr + '%').padStart(8)}${String(q.position).padStart(6)}`);
        }
        if (result.nearWinQueries.length > 0) {
          log('', '');
          log('🚀', 'Near-win queries (vicine ai primi risultati):');
          for (const q of result.nearWinQueries.slice(0, 8)) {
            log('', `  ${q.query.slice(0, 47).padEnd(48)}Pos ${String(q.position).padStart(4)}  Impr ${String(q.impressions).padStart(6)}  Score ${String(q.opportunityScore).padStart(6)}`);
          }
        }
        if (result.queryClusters.length > 0) {
          log('', '');
          log('🧭', 'Cluster query organiche:');
          for (const cluster of result.queryClusters.slice(0, 6)) {
            log('', `  ${cluster.cluster.padEnd(14)} ${String(cluster.impressions).padStart(8)} impr  ${String(cluster.clicks).padStart(6)} click  CTR ${String(cluster.ctr).padStart(5)}%`);
          }
        }
      }
    }
  } catch (e) { log('⚠️', `Queries: ${e.message}`); }

  // ── 1c. Top 20 pages ────────────────────
  try {
    const res = await fetchRetry(
      `https://www.googleapis.com/webmasters/v3/sites/${encoded}/searchAnalytics/query`,
      { method: 'POST', headers, body: JSON.stringify({ ...baseBody, dimensions: ['page'], rowLimit: 20 }) }
    );
    if (res.ok) {
      const data = await res.json();
      result.topPages = (data.rows || []).map(r => ({
        page: r.keys[0].replace(SITE_URL, ''),
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: parseFloat((r.ctr * 100).toFixed(1)),
        position: parseFloat(r.position.toFixed(1)),
      }));
      result.pageTemplatePerformance = aggregateRowsByTemplate(
        result.topPages.map((page) => ({ ...page, path: page.page })),
        'gsc',
      );
      result.lowCtrPages = getCtrOpportunities(result.topPages);
      if (!flags.json && result.topPages.length > 0) {
        log('', '');
        log('📄', 'Top 20 Pagine:');
        log('', '  Pagina'.padEnd(55) + 'Click'.padStart(8) + 'Impr.'.padStart(10) + 'CTR'.padStart(8) + 'Pos'.padStart(6));
        log('', '  ' + '─'.repeat(83));
        for (const p of result.topPages) {
          const shortPage = (p.page || '/').slice(0, 52);
          log('', `  ${shortPage.padEnd(53)}${String(p.clicks).padStart(8)}${String(p.impressions).padStart(10)}${(p.ctr + '%').padStart(8)}${String(p.position).padStart(6)}`);
        }
        if (result.pageTemplatePerformance.length > 0) {
          log('', '');
          log('🧱', 'Performance SEO per template pagina:');
          for (const row of result.pageTemplatePerformance.slice(0, 8)) {
            log('', `  ${row.pageTemplate.padEnd(20)} Impr ${String(row.impressions).padStart(7)}  Click ${String(row.clicks).padStart(6)}  CTR ${String(row.ctr).padStart(5)}%  Pos ${String(row.avgPosition).padStart(4)}`);
          }
        }
      }
    }
  } catch (e) { log('⚠️', `Pages: ${e.message}`); }

  // ── 1d. Daily trend ─────────────────────
  try {
    const res = await fetchRetry(
      `https://www.googleapis.com/webmasters/v3/sites/${encoded}/searchAnalytics/query`,
      { method: 'POST', headers, body: JSON.stringify({ ...baseBody, dimensions: ['date'], rowLimit: DAYS + 5 }) }
    );
    if (res.ok) {
      const data = await res.json();
      result.dailyTrend = (data.rows || []).map(r => ({
        date: r.keys[0],
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: parseFloat((r.ctr * 100).toFixed(1)),
        position: parseFloat(r.position.toFixed(1)),
      }));
      if (!flags.json && result.dailyTrend.length > 1) {
        log('', '');
        log('📈', 'Trend giornaliero:');
        const last7 = result.dailyTrend.slice(-7);
        const maxClicks = Math.max(...last7.map(d => d.clicks), 1);
        for (const d of last7) {
          const bar = '█'.repeat(Math.round((d.clicks / maxClicks) * 20));
          log('', `  ${d.date}  ${bar.padEnd(20)} ${String(d.clicks).padStart(5)} click`);
        }
      }
    }
  } catch (e) { log('⚠️', `Trend: ${e.message}`); }

  // ── 1e. Top countries ───────────────────
  try {
    const res = await fetchRetry(
      `https://www.googleapis.com/webmasters/v3/sites/${encoded}/searchAnalytics/query`,
      { method: 'POST', headers, body: JSON.stringify({ ...baseBody, dimensions: ['country'], rowLimit: 10 }) }
    );
    if (res.ok) {
      const data = await res.json();
      result.topCountries = (data.rows || []).map(r => ({
        country: r.keys[0],
        clicks: r.clicks,
        impressions: r.impressions,
      }));
      if (!flags.json && result.topCountries.length > 0) {
        log('', '');
        log('🌍', 'Top Paesi:');
        for (const c of result.topCountries) {
          log('', `  ${c.country.padEnd(6)} ${fmtNum(c.clicks)} click, ${fmtNum(c.impressions)} impressioni`);
        }
      }
    }
  } catch (e) { log('⚠️', `Countries: ${e.message}`); }

  // ── 1f. Top devices ─────────────────────
  try {
    const res = await fetchRetry(
      `https://www.googleapis.com/webmasters/v3/sites/${encoded}/searchAnalytics/query`,
      { method: 'POST', headers, body: JSON.stringify({ ...baseBody, dimensions: ['device'], rowLimit: 5 }) }
    );
    if (res.ok) {
      const data = await res.json();
      result.devices = (data.rows || []).map(r => ({
        device: r.keys[0],
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: parseFloat((r.ctr * 100).toFixed(1)),
      }));
      if (!flags.json && result.devices.length > 0) {
        log('', '');
        log('📱', 'Dispositivi:');
        for (const d of result.devices) {
          const icon = d.device === 'MOBILE' ? '📱' : d.device === 'DESKTOP' ? '💻' : '📟';
          log('', `  ${icon} ${d.device.padEnd(10)} ${fmtNum(d.clicks)} click (CTR ${d.ctr}%)`);
        }
      }
    }
  } catch (e) { log('⚠️', `Devices: ${e.message}`); }

  // ── 1g. Desktop CTR diagnostic — top queries with low desktop CTR ──
  try {
    const res = await fetchRetry(
      `https://www.googleapis.com/webmasters/v3/sites/${encoded}/searchAnalytics/query`,
      {
        method: 'POST', headers,
        body: JSON.stringify({
          ...baseBody,
          dimensions: ['query', 'device'],
          dimensionFilterGroups: [{
            filters: [{ dimension: 'device', expression: 'DESKTOP' }],
          }],
          rowLimit: 25,
        }),
      }
    );
    if (res.ok) {
      const data = await res.json();
      const desktopQueries = (data.rows || [])
        .map(r => ({
          query: r.keys[0],
          clicks: r.clicks,
          impressions: r.impressions,
          ctr: parseFloat((r.ctr * 100).toFixed(1)),
          position: parseFloat(r.position.toFixed(1)),
        }))
        .filter(q => q.impressions >= 20);

      result.desktopTopQueries = desktopQueries;

      if (!flags.json && desktopQueries.length > 0) {
        const lowCtr = desktopQueries.filter(q => q.ctr < 2 && q.impressions >= 50);
        if (lowCtr.length > 0) {
          log('', '');
          log('💻', 'Query desktop con CTR basso (< 2%, ≥50 impression):');
          for (const q of lowCtr.slice(0, 10)) {
            log('', `  ${q.query.padEnd(45)} CTR ${String(q.ctr).padStart(5)}% | Impr ${fmtNum(q.impressions).padStart(6)} | Pos ${q.position}`);
          }
          log('💡', '  Ottimizzare title/description per queste query → migliorare desktop CTR');
        }
      }
    }
  } catch (e) { log('⚠️', `Desktop CTR diagnostic: ${e.message}`); }

  return result;
}

// ═══════════════════════════════════════════════════════════
// 2. PAGESPEED INSIGHTS
// ═══════════════════════════════════════════════════════════
async function reportPageSpeed() {
  log('', '');
  log('⚡', 'PageSpeed Insights');
  log('', '─'.repeat(50));

  const apiKey = process.env.PAGESPEED_API_KEY || '';
  const keyParam = apiKey ? `&key=${apiKey}` : '';

  // Key pages to test — each takes ~30-60s (remote Lighthouse run)
  // With API key + 30min timeout, all pages fit comfortably
  const allPages = [
    { name: 'Homepage', path: '/' },
    { name: 'Calcolatore', path: '/calcola-stipendio' },
    { name: 'Confronti', path: '/compara-servizi' },
    { name: 'Cambio Valuta', path: '/compara-servizi/cambio-franco-euro' },
    { name: 'Guida', path: '/guida-frontaliere' },
    { name: 'Articoli', path: '/articoli-frontaliere' },
    { name: 'FAQ', path: '/domande-frequenti-frontalieri' },
    { name: 'Pensioni', path: '/tasse-e-pensione/calcola-previdenza' },
    { name: 'Assicurazione Salute', path: '/compara-servizi/confronta-casse-malati' },
    { name: 'Mappa del Sito', path: '/mappa-del-sito' },
  ];
  const pages = allPages;
  if (!apiKey) {
    log('ℹ️', '  PAGESPEED_API_KEY non configurato — possibili errori 429');
  }

  const results = [];
  const delayBetweenRequests = apiKey ? 1000 : 5000;

  for (const page of pages) {
    const url = `${SITE_URL}${page.path}`;
    log('', `  Analisi: ${page.name}...`);

    for (const strategy of ['mobile', 'desktop']) {
      try {
        const apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=${strategy}&category=performance&category=accessibility&category=best-practices&category=seo${keyParam}`;

        const res = await fetchRetry(apiUrl, {}, 3, 90000);
        if (!res.ok) {
          log('⚠️', `  ${page.name} (${strategy}): HTTP ${res.status}`);
          continue;
        }

        const data = await res.json();
        const cats = data.lighthouseResult?.categories || {};
        const scores = {
          page: page.name,
          path: page.path,
          strategy,
          performance: Math.round((cats.performance?.score || 0) * 100),
          accessibility: Math.round((cats.accessibility?.score || 0) * 100),
          bestPractices: Math.round((cats['best-practices']?.score || 0) * 100),
          seo: Math.round((cats.seo?.score || 0) * 100),
        };

        // Core Web Vitals
        const audits = data.lighthouseResult?.audits || {};
        scores.lcp = audits['largest-contentful-paint']?.numericValue;
        scores.fid = audits['max-potential-fid']?.numericValue;
        scores.cls = audits['cumulative-layout-shift']?.numericValue;
        scores.fcp = audits['first-contentful-paint']?.numericValue;
        scores.tbt = audits['total-blocking-time']?.numericValue;
        scores.si = audits['speed-index']?.numericValue;

        results.push(scores);

        if (!flags.json) {
          const emoji = scores.performance >= 90 ? '🟢' : scores.performance >= 50 ? '🟡' : '🔴';
          log('', `  ${emoji} ${strategy.padEnd(8)} Perf: ${String(scores.performance).padStart(3)}  A11y: ${String(scores.accessibility).padStart(3)}  BP: ${String(scores.bestPractices).padStart(3)}  SEO: ${String(scores.seo).padStart(3)}`);
          if (scores.lcp) {
            log('', `    LCP: ${(scores.lcp / 1000).toFixed(1)}s  FCP: ${(scores.fcp / 1000).toFixed(1)}s  TBT: ${Math.round(scores.tbt)}ms  CLS: ${scores.cls?.toFixed(3)}`);
          }
        }

        // Respect rate limits: longer delay without API key
        await sleep(delayBetweenRequests);
      } catch (e) {
        log('⚠️', `  ${page.name} (${strategy}): ${e.message}`);
      }
    }
  }

  // Summary table
  if (!flags.json && results.length > 0) {
    log('', '');
    log('📊', 'Riepilogo PageSpeed:');
    const mobile = results.filter(r => r.strategy === 'mobile');
    const desktop = results.filter(r => r.strategy === 'desktop');

    if (mobile.length > 0) {
      const avgPerf = Math.round(mobile.reduce((s, r) => s + r.performance, 0) / mobile.length);
      const avgSeo = Math.round(mobile.reduce((s, r) => s + r.seo, 0) / mobile.length);
      const avgA11y = Math.round(mobile.reduce((s, r) => s + r.accessibility, 0) / mobile.length);
      log('📱', `  Mobile  — Perf media: ${avgPerf}  SEO: ${avgSeo}  A11y: ${avgA11y}`);
    }
    if (desktop.length > 0) {
      const avgPerf = Math.round(desktop.reduce((s, r) => s + r.performance, 0) / desktop.length);
      const avgSeo = Math.round(desktop.reduce((s, r) => s + r.seo, 0) / desktop.length);
      const avgA11y = Math.round(desktop.reduce((s, r) => s + r.accessibility, 0) / desktop.length);
      log('💻', `  Desktop — Perf media: ${avgPerf}  SEO: ${avgSeo}  A11y: ${avgA11y}`);
    }
  }

  return results;
}

// ═══════════════════════════════════════════════════════════
// 3. GA4 DATA API (via OAuth2)
// ═══════════════════════════════════════════════════════════
async function reportGA4(token) {
  // GA4 property ID is a public numeric identifier, not a secret
  const propertyId = process.env.GA4_PROPERTY_ID || 'properties/524485296';
  if (!propertyId || propertyId === 'properties/XXXXXXXX') {
    log('ℹ️', 'GA4_PROPERTY_ID non configurato — skip report GA4');
    return null;
  }

  log('', '');
  log('📊', `GA4 Analytics — Ultimi ${DAYS} giorni`);
  log('', '─'.repeat(50));

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - DAYS);

  const baseRequest = {
    dateRanges: [{ startDate: fmtDate(startDate), endDate: fmtDate(endDate) }],
  };

  const result = { period: `${fmtDate(startDate)} → ${fmtDate(endDate)}` };
  const defaultGaEvents = new Set([
    'page_view',
    'session_start',
    'user_engagement',
    'first_visit',
    'scroll',
    'click',
    'view_search_results',
    'file_download',
  ]);

  // ── 3a. Overall metrics ─────────────────
  try {
    const res = await fetchRetry(
      `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...baseRequest,
          metrics: [
            { name: 'sessions' },
            { name: 'totalUsers' },
            { name: 'newUsers' },
            { name: 'screenPageViews' },
            { name: 'averageSessionDuration' },
            { name: 'bounceRate' },
            { name: 'engagedSessions' },
          ],
        }),
      }
    );

    if (!res.ok) {
      const text = await res.text();
      if (res.status === 403) {
        log('⚠️', 'GA4 API: permessi insufficienti — aggiungi scope analytics.readonly');
        log('💡', 'Rigenera token: node scripts/setup-google-oauth.mjs <CLIENT_ID> <CLIENT_SECRET>');
        return null;
      }
      log('⚠️', `GA4 summary: ${res.status} — ${text.slice(0, 200)}`);
      return null;
    }

    const data = await res.json();
    const values = data.rows?.[0]?.metricValues || [];
    result.summary = {
      sessions: parseInt(values[0]?.value || '0'),
      users: parseInt(values[1]?.value || '0'),
      newUsers: parseInt(values[2]?.value || '0'),
      pageViews: parseInt(values[3]?.value || '0'),
      avgSessionDuration: parseFloat(values[4]?.value || '0'),
      bounceRate: parseFloat(values[5]?.value || '0'),
      engagedSessions: parseInt(values[6]?.value || '0'),
    };

    if (!flags.json) {
      const s = result.summary;
      log('📊', '┌──────────────────────────────────────┐');
      log('📊', '│  GA4 — Riepilogo                     │');
      log('📊', '├──────────────────────────────────────┤');
      log('📊', `│  Sessioni:    ${fmtNum(s.sessions).padStart(12)}           │`);
      log('📊', `│  Utenti:      ${fmtNum(s.users).padStart(12)}           │`);
      log('📊', `│  Nuovi:       ${fmtNum(s.newUsers).padStart(12)}           │`);
      log('📊', `│  Page views:  ${fmtNum(s.pageViews).padStart(12)}           │`);
      log('📊', `│  Durata avg:  ${Math.round(s.avgSessionDuration) + 's'.padStart(11)}           │`);
      log('📊', `│  Bounce rate: ${(s.bounceRate * 100).toFixed(1) + '%'.padStart(11)}           │`);
      log('📊', '└──────────────────────────────────────┘');
    }
  } catch (e) { log('⚠️', `GA4 summary: ${e.message}`); }

  // ── 3b. Top pages + top articles + keyword intent ─────────
  try {
    const topPagesRes = await fetchRetry(
      `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...baseRequest,
          dimensions: [{ name: 'pagePath' }],
          metrics: [
            { name: 'screenPageViews' },
            { name: 'totalUsers' },
            { name: 'averageSessionDuration' },
          ],
          orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
          limit: 20,
        }),
      }
    );

    if (topPagesRes.ok) {
      const data = await topPagesRes.json();
      result.topPages = (data.rows || []).map((r) => ({
        path: r.dimensionValues[0].value,
        views: parseInt(r.metricValues[0].value),
        users: parseInt(r.metricValues[1].value),
        avgDuration: Math.round(parseFloat(r.metricValues[2].value || '0')),
      }));
    } else {
      result.topPages = [];
    }

    const topArticlesRes = await fetchRetry(
      `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...baseRequest,
          dimensions: [{ name: 'pagePath' }],
          metrics: [
            { name: 'screenPageViews' },
            { name: 'totalUsers' },
            { name: 'averageSessionDuration' },
          ],
          dimensionFilter: {
            filter: {
              fieldName: 'pagePath',
              stringFilter: { value: '/articoli-frontaliere/', matchType: 'CONTAINS' },
            },
          },
          orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
          limit: 20,
        }),
      }
    );

    if (topArticlesRes.ok) {
      const data = await topArticlesRes.json();
      result.topArticlePages = (data.rows || []).map((r) => ({
        path: r.dimensionValues[0].value,
        views: parseInt(r.metricValues[0].value),
        users: parseInt(r.metricValues[1].value),
        avgDuration: Math.round(parseFloat(r.metricValues[2].value || '0')),
      }));
    } else {
      result.topArticlePages = [];
    }

    const topArticlesByTimeRes = await fetchRetry(
      `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...baseRequest,
          dimensions: [{ name: 'pagePath' }],
          metrics: [
            { name: 'screenPageViews' },
            { name: 'totalUsers' },
            { name: 'averageSessionDuration' },
          ],
          dimensionFilter: {
            filter: {
              fieldName: 'pagePath',
              stringFilter: { value: '/articoli-frontaliere/', matchType: 'CONTAINS' },
            },
          },
          orderBys: [{ metric: { metricName: 'averageSessionDuration' }, desc: true }],
          limit: 20,
        }),
      }
    );

    if (topArticlesByTimeRes.ok) {
      const data = await topArticlesByTimeRes.json();
      const rows = (data.rows || []).map((r) => ({
        path: r.dimensionValues[0].value,
        views: parseInt(r.metricValues[0].value),
        users: parseInt(r.metricValues[1].value),
        avgDuration: Math.round(parseFloat(r.metricValues[2].value || '0')),
      }));
      const minViewsForEngagement = Math.max(
        20,
        Math.floor((result.topArticlePages?.[0]?.views || 0) * 0.15)
      );
      result.topArticlePagesByTime = rows.filter((r) => r.views >= minViewsForEngagement).slice(0, 20);
    } else {
      result.topArticlePagesByTime = [];
    }

    if ((!result.topArticlePages || result.topArticlePages.length === 0) && Array.isArray(result.topPages)) {
      result.topArticlePages = result.topPages.filter((p) => isArticlePagePath(p.path)).slice(0, 20);
    }

    result.pageTemplatePerformance = aggregateRowsByTemplate(result.topPages || [], 'ga4');
    result.keywordInterest = rankKeywordsFromPages(result.topPages || [], { limit: 20 });
    result.articleKeywordInterest = rankKeywordsFromPages(result.topArticlePages || [], {
      limit: 20,
      includeDurationWeight: true,
    });
    result.keywordStrategyComment = buildKeywordDirectionComment({
      keywordInterest: result.keywordInterest,
      articleKeywordInterest: result.articleKeywordInterest,
      topArticlePages: result.topArticlePages,
      topArticlePagesByTime: result.topArticlePagesByTime,
    });

    if (!flags.json && result.topPages.length > 0) {
      log('', '');
      log('📄', 'Top 20 Pagine (GA4):');
      log('', '  Pagina'.padEnd(55) + 'Views'.padStart(8) + 'Users'.padStart(8) + 'Durata'.padStart(8));
      log('', '  ' + '─'.repeat(75));
      for (const p of result.topPages) {
        log('', `  ${p.path.slice(0, 52).padEnd(53)}${String(p.views).padStart(8)}${String(p.users).padStart(8)}${(p.avgDuration + 's').padStart(8)}`);
      }
      if (result.pageTemplatePerformance.length > 0) {
        log('', '');
        log('🧱', 'Performance GA4 per template pagina:');
        for (const row of result.pageTemplatePerformance.slice(0, 8)) {
          log('', `  ${row.pageTemplate.padEnd(20)} Views ${String(row.views).padStart(7)}  Users ${String(row.users).padStart(6)}  Dur ${String(`${row.avgDuration}s`).padStart(6)}`);
        }
      }
    }

    if (!flags.json && result.topArticlePages.length > 0) {
      log('', '');
      log('📰', 'Top 20 Articoli (GA4, per views):');
      log('', '  Articolo'.padEnd(55) + 'Views'.padStart(8) + 'Users'.padStart(8) + 'Durata'.padStart(8));
      log('', '  ' + '─'.repeat(75));
      for (const p of result.topArticlePages) {
        log('', `  ${p.path.slice(0, 52).padEnd(53)}${String(p.views).padStart(8)}${String(p.users).padStart(8)}${(p.avgDuration + 's').padStart(8)}`);
      }
    }

    if (!flags.json && result.topArticlePagesByTime.length > 0) {
      log('', '');
      log('⏱️', 'Top Articoli per tempo medio (filtrati per views):');
      log('', '  Articolo'.padEnd(55) + 'Views'.padStart(8) + 'Durata'.padStart(10));
      log('', '  ' + '─'.repeat(73));
      for (const p of result.topArticlePagesByTime) {
        log('', `  ${p.path.slice(0, 52).padEnd(53)}${String(p.views).padStart(8)}${(p.avgDuration + 's').padStart(10)}`);
      }
    }

    if (!flags.json && (result.keywordInterest.length > 0 || result.articleKeywordInterest.length > 0)) {
      log('', '');
      log('🔑', 'Keyword intent dalle URL top (score ponderato):');
      for (const k of result.keywordInterest.slice(0, 10)) {
        log('', `  [Pagine]   ${k.keyword.padEnd(24)} score ${String(k.score).padStart(8)}  views ${String(k.views).padStart(8)}`);
      }
      for (const k of result.articleKeywordInterest.slice(0, 10)) {
        log('', `  [Articoli] ${k.keyword.padEnd(24)} score ${String(k.score).padStart(8)}  views ${String(k.views).padStart(8)}`);
      }
      log('', '');
      log('🧭', `Direzione keyword: ${result.keywordStrategyComment}`);
    }
  } catch (e) { log('⚠️', `GA4 pages/articles/keywords: ${e.message}`); }

  // ── 3b-bis. Internal search demand ─────
  try {
    const res = await fetchRetry(
      `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...baseRequest,
          dimensions: [{ name: 'searchTerm' }],
          metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
          dimensionFilter: {
            filter: {
              fieldName: 'eventName',
              stringFilter: { value: 'search', matchType: 'EXACT' },
            },
          },
          orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
          limit: 20,
        }),
      }
    );

    if (res.ok) {
      const data = await res.json();
      result.internalSearchTerms = (data.rows || [])
        .map((r) => ({
          term: r.dimensionValues[0].value,
          searches: parseInt(r.metricValues[0].value, 10),
          users: parseInt(r.metricValues[1].value, 10),
        }))
        .filter((row) => row.term && row.term !== '(not set)');

      if (!flags.json && result.internalSearchTerms.length > 0) {
        log('', '');
        log('🔎', 'Top ricerche interne utenti:');
        for (const row of result.internalSearchTerms.slice(0, 10)) {
          log('', `  ${row.term.slice(0, 44).padEnd(46)} ${String(row.searches).padStart(6)} ricerche  ${String(row.users).padStart(5)} utenti`);
        }
      }
    }
  } catch (e) { log('⚠️', `GA4 internal search: ${e.message}`); }

  // ── 3c. Traffic sources ─────────────────
  try {
    const res = await fetchRetry(
      `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...baseRequest,
          dimensions: [{ name: 'sessionDefaultChannelGroup' }],
          metrics: [
            { name: 'sessions' },
            { name: 'totalUsers' },
            { name: 'engagedSessions' },
          ],
          orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
          limit: 10,
        }),
      }
    );

    if (res.ok) {
      const data = await res.json();
      result.trafficSources = (data.rows || []).map(r => ({
        channel: r.dimensionValues[0].value,
        sessions: parseInt(r.metricValues[0].value),
        users: parseInt(r.metricValues[1].value),
        engaged: parseInt(r.metricValues[2].value),
      }));

      if (!flags.json && result.trafficSources.length > 0) {
        log('', '');
        log('🔗', 'Sorgenti traffico:');
        const totalSessions = result.trafficSources.reduce((s, r) => s + r.sessions, 0);
        for (const src of result.trafficSources) {
          const share = ((src.sessions / totalSessions) * 100).toFixed(1);
          const bar = '█'.repeat(Math.round(parseFloat(share) / 5));
          log('', `  ${src.channel.padEnd(25)} ${bar.padEnd(20)} ${share}% (${fmtNum(src.sessions)})`);
        }
      }
    }
  } catch (e) { log('⚠️', `GA4 sources: ${e.message}`); }

  // ── 3d. Daily users trend ───────────────
  try {
    const res = await fetchRetry(
      `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...baseRequest,
          dimensions: [{ name: 'date' }],
          metrics: [
            { name: 'totalUsers' },
            { name: 'sessions' },
          ],
          orderBys: [{ dimension: { dimensionName: 'date' } }],
          limit: DAYS + 5,
        }),
      }
    );

    if (res.ok) {
      const data = await res.json();
      result.dailyUsers = (data.rows || []).map(r => ({
        date: r.dimensionValues[0].value.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'),
        users: parseInt(r.metricValues[0].value),
        sessions: parseInt(r.metricValues[1].value),
      }));

      if (!flags.json && result.dailyUsers.length > 1) {
        log('', '');
        log('📈', 'Trend utenti (ultimi 7 giorni):');
        const last7 = result.dailyUsers.slice(-7);
        const maxUsers = Math.max(...last7.map(d => d.users), 1);
        for (const d of last7) {
          const bar = '█'.repeat(Math.round((d.users / maxUsers) * 20));
          log('', `  ${d.date}  ${bar.padEnd(20)} ${String(d.users).padStart(5)} utenti`);
        }
      }
    }
  } catch (e) { log('⚠️', `GA4 trend: ${e.message}`); }

  // ── 3e. SEO SERP experiment events ──────
  try {
    const res = await fetchRetry(
      `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...baseRequest,
          dimensions: [{ name: 'date' }, { name: 'eventName' }],
          metrics: [{ name: 'eventCount' }],
          dimensionFilter: {
            filter: {
              fieldName: 'eventName',
              stringFilter: { value: 'seo_serp_variant_exposure', matchType: 'EXACT' },
            },
          },
          orderBys: [{ dimension: { dimensionName: 'date' } }],
          limit: 100,
        }),
      }
    );

    if (res.ok) {
      const data = await res.json();
      result.serpExperiment = (data.rows || []).map((r) => ({
        date: r.dimensionValues[0].value.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'),
        eventName: r.dimensionValues[1].value,
        eventCount: parseInt(r.metricValues[0].value, 10),
      }));

      if (!flags.json) {
        const totalExposures = result.serpExperiment.reduce((sum, row) => sum + row.eventCount, 0);
        log('', '');
        log('🧪', `SEO SERP experiment exposures: ${fmtNum(totalExposures)}`);
        const last7 = result.serpExperiment.slice(-7);
        for (const row of last7) {
          log('', `  ${row.date}: ${fmtNum(row.eventCount)} exposure`);
        }
      }
    }
  } catch (e) { log('⚠️', `GA4 serp experiment: ${e.message}`); }

  // ── 3f. Firebase Analytics custom events + product funnels ──────
  try {
    const res = await fetchRetry(
      `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...baseRequest,
          dimensions: [{ name: 'eventName' }],
          metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
          orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
          limit: 100,
        }),
      }
    );

    if (res.ok) {
      const data = await res.json();
      const allEvents = (data.rows || []).map((r) => ({
        eventName: r.dimensionValues[0].value,
        eventCount: parseInt(r.metricValues[0].value, 10),
        users: parseInt(r.metricValues[1].value, 10),
      }));

      const eventMap = new Map(allEvents.map((e) => [e.eventName, e]));
      const topCustomEvents = allEvents
        .filter((e) => !defaultGaEvents.has(e.eventName))
        .slice(0, 25);

      // ── Funnel breakdown by event parameter ──
      // The client fires composite events with parameters:
      //   chatbot_funnel → step: open_chat | question_started | gate_opened | method_selected | auth_success | response_generated
      //   chatbot_usage  → event: panel_open | panel_close | question_sent | auth_gate_open | api_error | rate_limited
      //   newsletter     → action: view_form | subscribe | unsubscribe | error
      //   funnel_step    → step_name: entry | input_start | calculate | compare | cta_click
      // We query GA4 with eventName + customEvent parameter dimensions to break these down.

      const funnelConfigs = [
        { eventName: 'chatbot_funnel', paramDim: 'customEvent:step', label: 'chatbot' },
        { eventName: 'chatbot_usage', paramDim: 'customEvent:event', label: 'chatbot_usage' },
        { eventName: 'newsletter', paramDim: 'customEvent:action', label: 'newsletter' },
        { eventName: 'funnel_step', paramDim: 'customEvent:step_name', label: 'conversion' },
      ];

      const funnels = {};
      for (const fc of funnelConfigs) {
        try {
          const fRes = await fetchRetry(
            `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`,
            {
              method: 'POST',
              headers,
              body: JSON.stringify({
                ...baseRequest,
                dimensions: [{ name: 'eventName' }, { name: fc.paramDim }],
                metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
                dimensionFilter: {
                  filter: { fieldName: 'eventName', stringFilter: { value: fc.eventName } },
                },
                orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
                limit: 20,
              }),
            }
          );
          if (fRes.ok) {
            const fData = await fRes.json();
            funnels[fc.label] = (fData.rows || []).map((r) => ({
              step: r.dimensionValues[1].value,
              eventCount: parseInt(r.metricValues[0].value, 10),
              users: parseInt(r.metricValues[1].value, 10),
            }));
          }
        } catch (e) { /* skip individual funnel errors */ }
      }

      // Aggregate-level funnel totals from the main event query
      const funnelTotals = {
        chatbot_funnel: eventMap.get('chatbot_funnel') || { eventCount: 0, users: 0 },
        chatbot_usage: eventMap.get('chatbot_usage') || { eventCount: 0, users: 0 },
        newsletter: eventMap.get('newsletter') || { eventCount: 0, users: 0 },
        funnel_step: eventMap.get('funnel_step') || { eventCount: 0, users: 0 },
      };

      result.firebaseAnalytics = {
        topCustomEvents,
        funnels,
        funnelTotals,
      };

      if (!flags.json) {
        log('', '');
        log('🔥', 'Firebase Analytics (eventi custom + funnel)');
        for (const e of topCustomEvents.slice(0, 12)) {
          log('', `  ${e.eventName.padEnd(34)} ${fmtNum(e.eventCount).padStart(8)} evt  ${fmtNum(e.users).padStart(7)} utenti`);
        }

        // Print funnel breakdowns
        for (const [label, steps] of Object.entries(funnels)) {
          if (steps.length > 0) {
            log('', '');
            log('🔄', `Funnel: ${label}`);
            for (const s of steps) {
              log('', `  ${s.step.padEnd(30)} ${fmtNum(s.eventCount).padStart(8)} evt  ${fmtNum(s.users).padStart(7)} utenti`);
            }
          }
        }

        // Chatbot completion rate
        const chatSteps = funnels.chatbot || [];
        const chatOpen = chatSteps.find(s => s.step === 'open_chat')?.eventCount || 0;
        const chatResp = chatSteps.find(s => s.step === 'response_generated')?.eventCount || 0;
        if (chatOpen > 0) {
          log('', `  Funnel chatbot completion rate: ${((chatResp / chatOpen) * 100).toFixed(1)}% (${fmtNum(chatResp)}/${fmtNum(chatOpen)})`);
        }
      }
    }
  } catch (e) {
    log('⚠️', `GA4 firebase events: ${e.message}`);
  }

  // ── 3g. Source/medium (more actionable than channels only) ──────
  try {
    const res = await fetchRetry(
      `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...baseRequest,
          dimensions: [{ name: 'sessionSourceMedium' }],
          metrics: [{ name: 'sessions' }, { name: 'engagedSessions' }],
          orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
          limit: 20,
        }),
      }
    );

    if (res.ok) {
      const data = await res.json();
      result.sourceMedium = (data.rows || []).map((r) => ({
        sourceMedium: r.dimensionValues[0].value,
        sessions: parseInt(r.metricValues[0].value, 10),
        engagedSessions: parseInt(r.metricValues[1].value, 10),
      }));
    }
  } catch (e) {
    log('⚠️', `GA4 source/medium: ${e.message}`);
  }

  // ── 3h-pre. Auto-register GA4 custom dimensions for error tracking + funnels ──
  // GA4 Data API can only query event parameters registered as custom dimensions.
  // Without registration, error_type/error_message/error_stack queries return empty.
  // Funnel params (step, event, action, step_name) also need registration for breakdown queries.
  const REQUIRED_CUSTOM_DIMS = [
    // Error tracking dimensions
    { parameterName: 'error_type', displayName: 'Error Type', description: 'Category of app error (error_boundary, unhandled_error, unhandled_rejection, chunk_load, api_error, cross_origin_script, etc.)' },
    { parameterName: 'error_message', displayName: 'Error Message', description: 'Human-readable error message (truncated to 200 chars)' },
    { parameterName: 'error_stack', displayName: 'Error Stack Trace', description: 'JS stack trace for debugging (truncated to 500 chars)' },
    { parameterName: 'component_stack', displayName: 'React Component Stack', description: 'React component hierarchy where the error occurred' },
    { parameterName: 'page_path', displayName: 'Error Page Path', description: 'URL path where the error occurred' },
    { parameterName: 'error_fingerprint', displayName: 'Error Fingerprint', description: 'Hash-based fingerprint for correlating error_page_view with app_error events' },
    // Exception event fallback dimension (standard GA4 exception description)
    { parameterName: 'description', displayName: 'Exception Description', description: 'Standard GA4 exception event description parameter' },
    // Funnel breakdown dimensions
    { parameterName: 'step', displayName: 'Funnel Step', description: 'Step identifier for chatbot_funnel events (open_chat, question_started, gate_opened, etc.)' },
    { parameterName: 'event', displayName: 'Usage Event', description: 'Event type for chatbot_usage events (panel_open, panel_close, question_sent, etc.)' },
    { parameterName: 'action', displayName: 'Action Type', description: 'Action identifier for newsletter events (view_form, subscribe, unsubscribe, error)' },
    { parameterName: 'step_name', displayName: 'Conversion Step Name', description: 'Step name for funnel_step events (entry, input_start, calculate, compare, cta_click)' },
    // Page context dimensions
    { parameterName: 'page_template', displayName: 'Page Template', description: 'Derived page template (job_detail, jobs_search, article_detail, calculator_tool, etc.)' },
    { parameterName: 'content_group', displayName: 'Content Group', description: 'Top-level content group (jobs, articles, tools, guides, stats, etc.)' },
    { parameterName: 'site_section', displayName: 'Site Section', description: 'Normalized site section for analytics segmentation' },
    { parameterName: 'content_locale', displayName: 'Content Locale', description: 'Locale of the page that triggered the event' },
    { parameterName: 'route_family', displayName: 'Route Family', description: 'Stable route family for grouping similar pages' },
    { parameterName: 'search_origin', displayName: 'Search Origin', description: 'Template or feature where the internal search originated' },
    { parameterName: 'search_results_count', displayName: 'Search Results Count', description: 'Number of results shown when an internal search was performed' },
  ];

  try {
    // Use service account token with analytics.edit scope for Admin API writes.
    // The OAuth2 token only has read scopes — Admin API create calls need analytics.edit.
    const adminToken = await getServiceAccountToken([
      'https://www.googleapis.com/auth/analytics.edit',
      'https://www.googleapis.com/auth/analytics.readonly',
    ]);
    const adminHeaders = adminToken
      ? { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }
      : headers; // fallback to OAuth2 (will fail with 403 if scopes are insufficient)

    // List existing custom dimensions
    const dimsRes = await fetchRetry(
      `https://analyticsadmin.googleapis.com/v1beta/${propertyId}/customDimensions?pageSize=200`,
      { headers: adminHeaders }
    );
    const existingDims = new Set();
    if (dimsRes.ok) {
      const dimsData = await dimsRes.json();
      for (const dim of dimsData.customDimensions || []) {
        existingDims.add(dim.parameterName);
      }
    }

    // Register missing dimensions
    let registered = 0;
    for (const dim of REQUIRED_CUSTOM_DIMS) {
      if (existingDims.has(dim.parameterName)) continue;
      const createRes = await fetchRetry(
        `https://analyticsadmin.googleapis.com/v1beta/${propertyId}/customDimensions`,
        {
          method: 'POST',
          headers: adminHeaders,
          body: JSON.stringify({
            parameterName: dim.parameterName,
            displayName: dim.displayName,
            description: dim.description,
            scope: 'EVENT',
          }),
        }
      );
      if (createRes.ok) {
        registered++;
        log('✅', `Registered GA4 custom dimension: ${dim.parameterName}`);
      } else {
        const errText = await createRes.text().catch(() => '');
        // 409 = already exists (race condition), skip silently
        if (createRes.status !== 409) {
          log('⚠️', `Failed to register ${dim.parameterName}: ${createRes.status} ${errText.slice(0, 100)}`);
        }
      }
    }
    if (registered > 0) {
      log('ℹ️', `Registered ${registered} new GA4 custom dimensions. Data will appear in the NEXT report.`);
    }
  } catch (e) {
    log('⚠️', `GA4 custom dimension auto-registration: ${e.message}`);
  }

  // ── 3h. Error page health metrics ──────
  // Tracks app_error GA4 events from ErrorBoundary & global handlers.
  // Rising error counts = unhealthy site → action needed.
  // app_error carries rich debug info: error_type, error_message, error_stack, component_stack.
  // NOTE: We count ONLY app_error events (not error_page_view) to avoid
  // double-counting — ErrorBoundary fires both app_error AND error_page_view
  // for each crash, which previously inflated the error rate ~2x.
  try {
    // 3h-i: Total error count (app_error only) + affected users
    const errRes = await fetchRetry(
      `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...baseRequest,
          metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
          dimensionFilter: {
            filter: {
              fieldName: 'eventName',
              stringFilter: { value: 'app_error', matchType: 'EXACT' },
            },
          },
        }),
      }
    );

    const errorHealth = {
      totalErrors: 0, affectedUsers: 0, errorRate: 0,
      userVisibleErrors: 0, // error_page_view count (errors that showed error UI)
      dailyTrend: [], topErrorPages: [],
      appErrors: [], errorsByType: [], errorsByDevice: [],
    };

    if (errRes.ok) {
      const errData = await errRes.json();
      const errRow = errData.rows?.[0];
      errorHealth.totalErrors = parseInt(errRow?.metricValues?.[0]?.value || '0', 10);
      errorHealth.affectedUsers = parseInt(errRow?.metricValues?.[1]?.value || '0', 10);
    }

    // 3h-i-b: User-visible errors (error_page_view) — tracked separately
    try {
      const visRes = await fetchRetry(
        `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            ...baseRequest,
            metrics: [{ name: 'eventCount' }],
            dimensionFilter: {
              filter: {
                fieldName: 'eventName',
                stringFilter: { value: 'error_page_view', matchType: 'EXACT' },
              },
            },
          }),
        }
      );
      if (visRes.ok) {
        const visData = await visRes.json();
        errorHealth.userVisibleErrors = parseInt(visData.rows?.[0]?.metricValues?.[0]?.value || '0', 10);
      }
    } catch { /* optional metric */ }

    // 3h-ii: Error rate = app_error / page_view
    const totalPageViews = result.summary?.pageViews || 0;
    if (totalPageViews > 0 && errorHealth.totalErrors > 0) {
      errorHealth.errorRate = parseFloat(((errorHealth.totalErrors / totalPageViews) * 100).toFixed(4));
    }

    // 3h-iii: Daily error trend (detect spikes)
    const errTrendRes = await fetchRetry(
      `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...baseRequest,
          dimensions: [{ name: 'date' }],
          metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
          dimensionFilter: {
            filter: {
              fieldName: 'eventName',
              stringFilter: { value: 'app_error', matchType: 'EXACT' },
            },
          },
          orderBys: [{ dimension: { dimensionName: 'date' } }],
          limit: DAYS + 5,
        }),
      }
    );

    if (errTrendRes.ok) {
      const trendData = await errTrendRes.json();
      errorHealth.dailyTrend = (trendData.rows || []).map((r) => ({
        date: r.dimensionValues[0].value.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'),
        errors: parseInt(r.metricValues[0].value, 10),
        users: parseInt(r.metricValues[1].value, 10),
      }));
    }

    // 3h-iv: Top pages triggering errors (by page_path custom dimension)
    const errPagesRes = await fetchRetry(
      `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...baseRequest,
          dimensions: [{ name: 'pagePath' }],
          metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
          dimensionFilter: {
            filter: {
              fieldName: 'eventName',
              stringFilter: { value: 'app_error', matchType: 'EXACT' },
            },
          },
          orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
          limit: 10,
        }),
      }
    );

    if (errPagesRes.ok) {
      const pagesData = await errPagesRes.json();
      errorHealth.topErrorPages = (pagesData.rows || []).map((r) => ({
        path: r.dimensionValues[0].value,
        errors: parseInt(r.metricValues[0].value, 10),
        users: parseInt(r.metricValues[1].value, 10),
      }));
    }

    // 3h-v: app_error events — rich debugging info (error_type, error_message, stack, component_stack)
    // These are fired by Analytics.trackAppError() from ErrorBoundary.componentDidCatch,
    // window error listener, and unhandled rejection listener.
    const appErrRes = await fetchRetry(
      `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...baseRequest,
          dimensions: [
            { name: 'customEvent:error_type' },
            { name: 'customEvent:error_message' },
            { name: 'pagePath' },
          ],
          metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
          dimensionFilter: {
            filter: {
              fieldName: 'eventName',
              stringFilter: { value: 'app_error', matchType: 'EXACT' },
            },
          },
          orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
          limit: 30,
        }),
      }
    );

    if (appErrRes.ok) {
      const appErrData = await appErrRes.json();
      errorHealth.appErrors = (appErrData.rows || []).map((r) => ({
        errorType: r.dimensionValues[0].value,
        errorMessage: r.dimensionValues[1].value,
        pagePath: r.dimensionValues[2].value,
        count: parseInt(r.metricValues[0].value, 10),
        users: parseInt(r.metricValues[1].value, 10),
      }));
    }

    // 3h-v-fallback: If app_error custom dimensions aren't registered in GA4,
    // fall back to standard 'exception' event descriptions (always queryable).
    if (!errorHealth.appErrors.length) {
      const excRes = await fetchRetry(
        `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            ...baseRequest,
            dimensions: [
              { name: 'customEvent:description' },
              { name: 'pagePath' },
            ],
            metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
            dimensionFilter: {
              filter: {
                fieldName: 'eventName',
                stringFilter: { value: 'exception', matchType: 'EXACT' },
              },
            },
            orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
            limit: 30,
          }),
        }
      );
      if (excRes.ok) {
        const excData = await excRes.json();
        errorHealth.appErrors = (excData.rows || []).map((r) => {
          const desc = r.dimensionValues[0].value || '';
          const typeMatch = desc.match(/^\[([^\]]+)\]/);
          return {
            errorType: typeMatch ? typeMatch[1] : 'exception',
            errorMessage: typeMatch ? desc.slice(typeMatch[0].length + 1).trim() : desc,
            pagePath: r.dimensionValues[1].value,
            count: parseInt(r.metricValues[0].value, 10),
            users: parseInt(r.metricValues[1].value, 10),
          };
        });
      }
    }

    // 3h-vi: app_error breakdown by error_type (error_boundary, unhandled_error, unhandled_rejection, etc.)
    const errByTypeRes = await fetchRetry(
      `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...baseRequest,
          dimensions: [{ name: 'customEvent:error_type' }],
          metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
          dimensionFilter: {
            filter: {
              fieldName: 'eventName',
              stringFilter: { value: 'app_error', matchType: 'EXACT' },
            },
          },
          orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
          limit: 10,
        }),
      }
    );

    if (errByTypeRes.ok) {
      const typeData = await errByTypeRes.json();
      errorHealth.errorsByType = (typeData.rows || []).map((r) => ({
        errorType: r.dimensionValues[0].value,
        count: parseInt(r.metricValues[0].value, 10),
        users: parseInt(r.metricValues[1].value, 10),
      }));
    }

    // 3h-vi-fallback: Derive errorsByType from appErrors if custom dimensions unavailable
    if (!errorHealth.errorsByType.length && errorHealth.appErrors.length) {
      const byType = {};
      for (const e of errorHealth.appErrors) {
        if (!byType[e.errorType]) byType[e.errorType] = { count: 0, users: 0 };
        byType[e.errorType].count += e.count;
        byType[e.errorType].users += e.users;
      }
      errorHealth.errorsByType = Object.entries(byType)
        .map(([errorType, v]) => ({ errorType, count: v.count, users: v.users }))
        .sort((a, b) => b.count - a.count);
    }

    // 3h-vii: Error context — user_agent, connection_type, screen size for debugging
    const errDeviceRes = await fetchRetry(
      `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...baseRequest,
          dimensions: [
            { name: 'deviceCategory' },
            { name: 'operatingSystem' },
            { name: 'browser' },
          ],
          metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
          dimensionFilter: {
            filter: {
              fieldName: 'eventName',
              stringFilter: { value: 'app_error', matchType: 'EXACT' },
            },
          },
          orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
          limit: 15,
        }),
      }
    );

    if (errDeviceRes.ok) {
      const devData = await errDeviceRes.json();
      errorHealth.errorsByDevice = (devData.rows || []).map((r) => ({
        device: r.dimensionValues[0].value,
        os: r.dimensionValues[1].value,
        browser: r.dimensionValues[2].value,
        count: parseInt(r.metricValues[0].value, 10),
        users: parseInt(r.metricValues[1].value, 10),
      }));
    }

    // 3h-viii: Stack traces — top error_stack values for debugging
    let topStacks = [];
    try {
      const stackRes = await fetchRetry(
        `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            ...baseRequest,
            dimensions: [
              { name: 'customEvent:error_stack' },
              { name: 'customEvent:error_message' },
            ],
            metrics: [{ name: 'eventCount' }],
            dimensionFilter: {
              filter: {
                fieldName: 'eventName',
                stringFilter: { value: 'app_error', matchType: 'EXACT' },
              },
            },
            orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
            limit: 10,
          }),
        }
      );

      if (stackRes.ok) {
        const stackData = await stackRes.json();
        topStacks = (stackData.rows || []).map((r) => ({
          stack: r.dimensionValues[0].value,
          message: r.dimensionValues[1].value,
          count: parseInt(r.metricValues[0].value, 10),
        }));
      }
    } catch { /* stack traces are optional — GA4 may not register them as custom dims */ }
    errorHealth.topStacks = topStacks;

    // 3h-ix: Component stacks (React-specific) — which components crash
    let componentStacks = [];
    try {
      const compRes = await fetchRetry(
        `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            ...baseRequest,
            dimensions: [
              { name: 'customEvent:component_stack' },
              { name: 'customEvent:error_message' },
              { name: 'pagePath' },
            ],
            metrics: [{ name: 'eventCount' }],
            dimensionFilter: {
              filter: {
                fieldName: 'eventName',
                stringFilter: { value: 'app_error', matchType: 'EXACT' },
              },
            },
            orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
            limit: 10,
          }),
        }
      );

      if (compRes.ok) {
        const compData = await compRes.json();
        componentStacks = (compData.rows || []).map((r) => ({
          componentStack: r.dimensionValues[0].value,
          message: r.dimensionValues[1].value,
          pagePath: r.dimensionValues[2].value,
          count: parseInt(r.metricValues[0].value, 10),
        }));
      }
    } catch { /* component stacks are optional */ }
    errorHealth.componentStacks = componentStacks;

    // Health assessment
    const trend = errorHealth.dailyTrend;
    let healthStatus = '🟢 HEALTHY';
    if (errorHealth.totalErrors > 0) {
      if (errorHealth.errorRate >= 1.0) {
        healthStatus = '🔴 CRITICAL — error rate ≥ 1%';
      } else if (errorHealth.errorRate >= 0.1) {
        healthStatus = '🟡 WARNING — error rate ≥ 0.1%';
      } else {
        healthStatus = '🟢 LOW — error rate < 0.1%';
      }
      // Check for spike: last 3 days avg vs previous 7 days avg
      if (trend.length >= 10) {
        const recent3 = trend.slice(-3).reduce((s, d) => s + d.errors, 0) / 3;
        const prev7 = trend.slice(-10, -3).reduce((s, d) => s + d.errors, 0) / 7;
        if (prev7 > 0 && recent3 / prev7 >= 2) {
          healthStatus += ' — ⚠️ SPIKE detected (2x+ increase)';
        }
      }
    }
    errorHealth.healthStatus = healthStatus;

    result.errorHealth = errorHealth;

    if (!flags.json) {
      log('', '');
      log('🛡️', 'Error Page Health (app_error)');
      log('', '─'.repeat(50));
      log('', `  Status:          ${healthStatus}`);
      log('', `  Total errors:    ${fmtNum(errorHealth.totalErrors)} (app_error events)`);
      log('', `  User-visible:    ${fmtNum(errorHealth.userVisibleErrors)} (error_page_view — showed error UI)`);
      log('', `  Affected users:  ${fmtNum(errorHealth.affectedUsers)}`);
      log('', `  Error rate:      ${errorHealth.errorRate}% (app_error / page_view)`);
      log('', `  Total PVs:       ${fmtNum(totalPageViews)}`);

      // Error type breakdown
      if (errorHealth.errorsByType.length > 0) {
        log('', '');
        log('🏷️', 'Errors by type (app_error):');
        log('', '  Type'.padEnd(30) + 'Count'.padStart(8) + 'Users'.padStart(8));
        log('', '  ' + '─'.repeat(42));
        for (const t of errorHealth.errorsByType) {
          log('', `  ${t.errorType.padEnd(28)}${String(t.count).padStart(8)}${String(t.users).padStart(8)}`);
        }
      }

      // Top error messages with context (THE KEY debugging table)
      if (errorHealth.appErrors.length > 0) {
        log('', '');
        log('🐛', 'Top error messages (app_error — for debugging):');
        log('', '  ' + '─'.repeat(90));
        for (const err of errorHealth.appErrors.slice(0, 15)) {
          const typeTag = `[${err.errorType}]`;
          log('', `  ${typeTag.padEnd(24)} ${err.errorMessage.slice(0, 60)}`);
          log('', `  ${''.padEnd(24)} Page: ${err.pagePath}  (${err.count}x, ${err.users} users)`);
        }
      }

      // Stack traces for debugging
      if (topStacks.length > 0) {
        log('', '');
        log('📜', 'Top stack traces (app_error — root cause):');
        log('', '  ' + '─'.repeat(90));
        for (const s of topStacks.slice(0, 5)) {
          log('', `  ${s.message.slice(0, 80)} (${s.count}x)`);
          // Show first 2 lines of stack (most informative)
          const stackLines = s.stack.split(/\\n|at /).filter(Boolean).slice(0, 2);
          for (const line of stackLines) {
            log('', `    ↳ ${line.trim().slice(0, 80)}`);
          }
        }
      }

      // Component stacks — which React components crash
      if (componentStacks.length > 0) {
        log('', '');
        log('⚛️', 'Crashing React components (component_stack):');
        log('', '  ' + '─'.repeat(90));
        for (const c of componentStacks.slice(0, 5)) {
          log('', `  ${c.message.slice(0, 60)}  @ ${c.pagePath}`);
          // Show first component in the stack (the one that actually crashed)
          const firstComponent = c.componentStack.split(/\\n|at /).filter(Boolean)[0] || '';
          if (firstComponent) {
            log('', `    ↳ Component: ${firstComponent.trim().slice(0, 70)}  (${c.count}x)`);
          }
        }
      }

      // Device/browser breakdown (helps reproduce)
      if (errorHealth.errorsByDevice.length > 0) {
        log('', '');
        log('📱', 'Error environment (device/OS/browser):');
        log('', '  Device'.padEnd(12) + 'OS'.padEnd(15) + 'Browser'.padEnd(20) + 'Count'.padStart(8) + 'Users'.padStart(8));
        log('', '  ' + '─'.repeat(59));
        for (const d of errorHealth.errorsByDevice) {
          log('', `  ${d.device.padEnd(10)}${d.os.padEnd(15)}${d.browser.padEnd(20)}${String(d.count).padStart(8)}${String(d.users).padStart(8)}`);
        }
      }

      // Daily trend
      if (errorHealth.dailyTrend.length > 0) {
        log('', '');
        log('📉', 'Error trend (ultimi 7 giorni):');
        const last7 = errorHealth.dailyTrend.slice(-7);
        const maxErr = Math.max(...last7.map(d => d.errors), 1);
        for (const d of last7) {
          const bar = d.errors > 0 ? '█'.repeat(Math.round((d.errors / maxErr) * 20)) : '·';
          log('', `  ${d.date}  ${bar.padEnd(20)} ${String(d.errors).padStart(5)} errori  ${String(d.users).padStart(4)} utenti`);
        }
      }

      // Top error pages
      if (errorHealth.topErrorPages.length > 0) {
        log('', '');
        log('📄', 'Pagine con più errori:');
        for (const p of errorHealth.topErrorPages) {
          log('', `  ${p.path.slice(0, 50).padEnd(52)} ${String(p.errors).padStart(5)} errori  ${String(p.users).padStart(4)} utenti`);
        }
      }

      if (errorHealth.totalErrors === 0 && errorHealth.appErrors.length === 0) {
        log('✅', '  Nessun errore nel periodo — sito sano!');
      }

      // Diagnostic: if we have errors but no details, explain why
      if (errorHealth.totalErrors > 0 && errorHealth.appErrors.length === 0
          && errorHealth.errorsByType.length === 0 && topStacks.length === 0) {
        log('', '');
        log('⚠️', 'No error details available (error_type, error_message, stack traces)');
        log('', '  GA4 custom dimensions may have just been registered above.');
        log('', '  Error detail data will appear in the NEXT report (GA4 needs ~24h to process).');
        log('', '  Verify in GA4 Admin → Custom definitions → Custom dimensions:');
        for (const dim of REQUIRED_CUSTOM_DIMS) {
          log('', `    • ${dim.parameterName} (scope: EVENT)`);
        }
      }
    }
  } catch (e) {
    log('⚠️', `GA4 error health: ${e.message}`);
  }

  // ── 3i. Reload & Resource Health ────────
  // Monitors forced page reloads, blocked resources (ad blocker), CSS fallback
  // activations, and chunk retry outcomes. Rising counts = deployment or
  // ad-blocker issues affecting user experience.
  //
  // GA4 events tracked:
  //   force_reload         — page forcefully reloaded (with source + reason)
  //   resource_load_error  — JS/CSS resource failed to load
  //   css_fallback         — CSS fallback timer had to force styles
  //   chunk_retry          — lazy chunk import retried (success/failure)
  try {
    const reloadHealth = {
      forceReloads: [], forceReloadTotal: 0,
      resourceErrors: [], resourceErrorTotal: 0,
      cssFallbacks: 0, cssFallbackPages: [],
      chunkRetries: [], chunkRetryTotal: 0,
      reloadsBySource: [], reloadsByDevice: [],
      adBlockerErrors: 0, genuineErrors: 0,
      blockedReloads: 0,
    };

    // 3i-i: Force reload events — total + breakdown by source
    const reloadRes = await fetchRetry(
      `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...baseRequest,
          dimensions: [
            { name: 'customEvent:reload_source' },
            { name: 'customEvent:reload_reason' },
            { name: 'customEvent:was_blocked' },
          ],
          metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
          dimensionFilter: {
            filter: {
              fieldName: 'eventName',
              stringFilter: { value: 'force_reload', matchType: 'EXACT' },
            },
          },
          orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
          limit: 30,
        }),
      }
    );

    if (reloadRes.ok) {
      const data = await reloadRes.json();
      reloadHealth.forceReloads = (data.rows || []).map((r) => ({
        source: r.dimensionValues[0].value,
        reason: r.dimensionValues[1].value,
        blocked: r.dimensionValues[2].value === 'true',
        count: parseInt(r.metricValues[0].value, 10),
        users: parseInt(r.metricValues[1].value, 10),
      }));
      reloadHealth.forceReloadTotal = reloadHealth.forceReloads.reduce((s, r) => s + r.count, 0);
      reloadHealth.blockedReloads = reloadHealth.forceReloads
        .filter(r => r.blocked)
        .reduce((s, r) => s + r.count, 0);
    }

    // 3i-ii: Force reload breakdown by source (pie chart data)
    const reloadSrcRes = await fetchRetry(
      `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...baseRequest,
          dimensions: [{ name: 'customEvent:reload_source' }],
          metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
          dimensionFilter: {
            filter: {
              fieldName: 'eventName',
              stringFilter: { value: 'force_reload', matchType: 'EXACT' },
            },
          },
          orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
          limit: 10,
        }),
      }
    );

    if (reloadSrcRes.ok) {
      const data = await reloadSrcRes.json();
      reloadHealth.reloadsBySource = (data.rows || []).map((r) => ({
        source: r.dimensionValues[0].value,
        count: parseInt(r.metricValues[0].value, 10),
        users: parseInt(r.metricValues[1].value, 10),
      }));
    }

    // 3i-iii: Resource load errors — breakdown by ad_blocker flag
    const resErrRes = await fetchRetry(
      `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...baseRequest,
          dimensions: [
            { name: 'customEvent:resource_type' },
            { name: 'customEvent:ad_blocker' },
            { name: 'customEvent:triggered_reload' },
          ],
          metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
          dimensionFilter: {
            filter: {
              fieldName: 'eventName',
              stringFilter: { value: 'resource_load_error', matchType: 'EXACT' },
            },
          },
          orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
          limit: 30,
        }),
      }
    );

    if (resErrRes.ok) {
      const data = await resErrRes.json();
      reloadHealth.resourceErrors = (data.rows || []).map((r) => ({
        resourceType: r.dimensionValues[0].value,
        adBlocker: r.dimensionValues[1].value === 'true',
        triggeredReload: r.dimensionValues[2].value === 'true',
        count: parseInt(r.metricValues[0].value, 10),
        users: parseInt(r.metricValues[1].value, 10),
      }));
      reloadHealth.resourceErrorTotal = reloadHealth.resourceErrors.reduce((s, r) => s + r.count, 0);
      reloadHealth.adBlockerErrors = reloadHealth.resourceErrors
        .filter(r => r.adBlocker)
        .reduce((s, r) => s + r.count, 0);
      reloadHealth.genuineErrors = reloadHealth.resourceErrors
        .filter(r => !r.adBlocker)
        .reduce((s, r) => s + r.count, 0);
    }

    // 3i-iv: Top resource URLs that fail (for debugging)
    const resUrlRes = await fetchRetry(
      `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...baseRequest,
          dimensions: [
            { name: 'customEvent:resource_url' },
            { name: 'customEvent:ad_blocker' },
          ],
          metrics: [{ name: 'eventCount' }],
          dimensionFilter: {
            filter: {
              fieldName: 'eventName',
              stringFilter: { value: 'resource_load_error', matchType: 'EXACT' },
            },
          },
          orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
          limit: 15,
        }),
      }
    );

    let topFailedResources = [];
    if (resUrlRes.ok) {
      const data = await resUrlRes.json();
      topFailedResources = (data.rows || []).map((r) => ({
        url: r.dimensionValues[0].value,
        adBlocker: r.dimensionValues[1].value === 'true',
        count: parseInt(r.metricValues[0].value, 10),
      }));
    }

    // 3i-v: CSS fallback activations
    const cssFallbackRes = await fetchRetry(
      `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...baseRequest,
          dimensions: [{ name: 'pagePath' }],
          metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
          dimensionFilter: {
            filter: {
              fieldName: 'eventName',
              stringFilter: { value: 'css_fallback', matchType: 'EXACT' },
            },
          },
          orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
          limit: 15,
        }),
      }
    );

    if (cssFallbackRes.ok) {
      const data = await cssFallbackRes.json();
      reloadHealth.cssFallbackPages = (data.rows || []).map((r) => ({
        path: r.dimensionValues[0].value,
        count: parseInt(r.metricValues[0].value, 10),
        users: parseInt(r.metricValues[1].value, 10),
      }));
      reloadHealth.cssFallbacks = reloadHealth.cssFallbackPages.reduce((s, p) => s + p.count, 0);
    }

    // 3i-vi: Chunk retry outcomes (success vs failure)
    const chunkRetryRes = await fetchRetry(
      `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...baseRequest,
          dimensions: [
            { name: 'customEvent:retry_outcome' },
            { name: 'customEvent:error_message' },
          ],
          metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
          dimensionFilter: {
            filter: {
              fieldName: 'eventName',
              stringFilter: { value: 'chunk_retry', matchType: 'EXACT' },
            },
          },
          orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
          limit: 20,
        }),
      }
    );

    if (chunkRetryRes.ok) {
      const data = await chunkRetryRes.json();
      reloadHealth.chunkRetries = (data.rows || []).map((r) => ({
        outcome: r.dimensionValues[0].value,
        errorMessage: r.dimensionValues[1].value,
        count: parseInt(r.metricValues[0].value, 10),
        users: parseInt(r.metricValues[1].value, 10),
      }));
      reloadHealth.chunkRetryTotal = reloadHealth.chunkRetries.reduce((s, r) => s + r.count, 0);
    }

    // 3i-vii: Reload events by device/browser (reproduce environment)
    const reloadDevRes = await fetchRetry(
      `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...baseRequest,
          dimensions: [
            { name: 'deviceCategory' },
            { name: 'operatingSystem' },
            { name: 'browser' },
          ],
          metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
          dimensionFilter: {
            filter: {
              fieldName: 'eventName',
              inListFilter: { values: ['force_reload', 'resource_load_error', 'css_fallback'] },
            },
          },
          orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
          limit: 15,
        }),
      }
    );

    if (reloadDevRes.ok) {
      const data = await reloadDevRes.json();
      reloadHealth.reloadsByDevice = (data.rows || []).map((r) => ({
        device: r.dimensionValues[0].value,
        os: r.dimensionValues[1].value,
        browser: r.dimensionValues[2].value,
        count: parseInt(r.metricValues[0].value, 10),
        users: parseInt(r.metricValues[1].value, 10),
      }));
    }

    // 3i-viii: Daily trend for all reload/resource events (correlate with deploys)
    const reloadTrendRes = await fetchRetry(
      `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...baseRequest,
          dimensions: [{ name: 'date' }, { name: 'eventName' }],
          metrics: [{ name: 'eventCount' }],
          dimensionFilter: {
            filter: {
              fieldName: 'eventName',
              inListFilter: { values: ['force_reload', 'resource_load_error', 'css_fallback', 'chunk_retry'] },
            },
          },
          orderBys: [{ dimension: { dimensionName: 'date' } }],
          limit: 200,
        }),
      }
    );

    if (reloadTrendRes.ok) {
      const data = await reloadTrendRes.json();
      // Group by date
      const byDate = {};
      for (const r of (data.rows || [])) {
        const date = r.dimensionValues[0].value;
        const event = r.dimensionValues[1].value;
        const count = parseInt(r.metricValues[0].value, 10);
        if (!byDate[date]) byDate[date] = { force_reload: 0, resource_load_error: 0, css_fallback: 0, chunk_retry: 0, total: 0 };
        byDate[date][event] = (byDate[date][event] || 0) + count;
        byDate[date].total += count;
      }
      reloadHealth.dailyTrend = Object.entries(byDate)
        .map(([date, counts]) => ({ date, ...counts }))
        .sort((a, b) => a.date.localeCompare(b.date));

      // Detect spikes (days with 3x the average)
      const days = reloadHealth.dailyTrend;
      if (days.length > 3) {
        const avg = days.reduce((s, d) => s + d.total, 0) / days.length;
        reloadHealth.spikeThreshold = Math.round(avg * 3);
        reloadHealth.spikeDays = days.filter(d => d.total > avg * 3);
      }
    }

    // Health assessment
    let reloadStatus = '🟢 HEALTHY — no force reloads';
    if (reloadHealth.forceReloadTotal > 0) {
      if (reloadHealth.blockedReloads > 0) {
        reloadStatus = '🔴 CRITICAL — blocked reloads detected (potential infinite loop prevented)';
      } else if (reloadHealth.forceReloadTotal >= 50) {
        reloadStatus = '🟡 WARNING — high reload count (possible deployment issue)';
      } else {
        reloadStatus = '🟢 LOW — occasional reloads (expected after deploys)';
      }
    }
    reloadHealth.healthStatus = reloadStatus;

    result.reloadHealth = reloadHealth;

    if (!flags.json) {
      log('', '');
      log('🔄', 'Reload & Resource Health (force_reload + resource_load_error + css_fallback + chunk_retry)');
      log('', '─'.repeat(70));
      log('', `  Status:              ${reloadStatus}`);
      log('', `  Force reloads:       ${fmtNum(reloadHealth.forceReloadTotal)} total, ${fmtNum(reloadHealth.blockedReloads)} blocked by guard`);
      log('', `  Resource errors:     ${fmtNum(reloadHealth.resourceErrorTotal)} total (${fmtNum(reloadHealth.adBlockerErrors)} ad-blocker, ${fmtNum(reloadHealth.genuineErrors)} genuine)`);
      log('', `  CSS fallbacks:       ${fmtNum(reloadHealth.cssFallbacks)} (onload stripped by content blocker)`);
      log('', `  Chunk retries:       ${fmtNum(reloadHealth.chunkRetryTotal)}`);

      // Reload source breakdown
      if (reloadHealth.reloadsBySource.length > 0) {
        log('', '');
        log('📊', 'Force reloads by source:');
        log('', '  Source'.padEnd(28) + 'Count'.padStart(8) + 'Users'.padStart(8));
        log('', '  ' + '─'.repeat(42));
        for (const s of reloadHealth.reloadsBySource) {
          log('', `  ${s.source.padEnd(26)}${String(s.count).padStart(8)}${String(s.users).padStart(8)}`);
        }
      }

      // Detailed force reload events
      if (reloadHealth.forceReloads.length > 0) {
        log('', '');
        log('🔁', 'Force reload details:');
        log('', '  ' + '─'.repeat(90));
        for (const r of reloadHealth.forceReloads.slice(0, 10)) {
          const blockedTag = r.blocked ? ' ⛔ BLOCKED' : '';
          log('', `  [${r.source}] ${r.reason.slice(0, 60)}${blockedTag}  (${r.count}x, ${r.users} users)`);
        }
      }

      // Resource errors — top failing URLs
      if (topFailedResources.length > 0) {
        log('', '');
        log('❌', 'Top failing resources:');
        log('', '  ' + '─'.repeat(90));
        for (const r of topFailedResources.slice(0, 10)) {
          const tag = r.adBlocker ? ' [ad-blocker]' : ' [GENUINE]';
          const shortUrl = r.url.length > 60 ? '...' + r.url.slice(-57) : r.url;
          log('', `  ${shortUrl.padEnd(62)}${tag.padEnd(16)}${String(r.count).padStart(5)}x`);
        }
      }

      // CSS fallback pages
      if (reloadHealth.cssFallbackPages.length > 0) {
        log('', '');
        log('🎨', 'CSS fallback activation by page (users saw unstyled content for 3s):');
        for (const p of reloadHealth.cssFallbackPages) {
          log('', `  ${p.path.slice(0, 50).padEnd(52)} ${String(p.count).padStart(5)}x  ${String(p.users).padStart(4)} users`);
        }
      }

      // Chunk retry outcomes
      if (reloadHealth.chunkRetries.length > 0) {
        log('', '');
        log('🔀', 'Chunk retry outcomes (lazyRetry):');
        const successes = reloadHealth.chunkRetries.filter(r => r.outcome === 'success');
        const failures = reloadHealth.chunkRetries.filter(r => r.outcome === 'failure');
        const totalRetries = reloadHealth.chunkRetryTotal;
        const successCount = successes.reduce((s, r) => s + r.count, 0);
        const failCount = failures.reduce((s, r) => s + r.count, 0);
        log('', `  ✅ Success: ${fmtNum(successCount)} (${totalRetries > 0 ? ((successCount / totalRetries) * 100).toFixed(1) : 0}%)`);
        log('', `  ❌ Failure: ${fmtNum(failCount)} (${totalRetries > 0 ? ((failCount / totalRetries) * 100).toFixed(1) : 0}%)`);
        if (failures.length > 0) {
          log('', '  Failed chunks:');
          for (const f of failures.slice(0, 5)) {
            log('', `    ${f.errorMessage.slice(0, 70)}  (${f.count}x, ${f.users} users)`);
          }
        }
      }

      // Device breakdown for reload/resource issues
      if (reloadHealth.reloadsByDevice.length > 0) {
        log('', '');
        log('📱', 'Affected environments (device/OS/browser):');
        log('', '  Device'.padEnd(12) + 'OS'.padEnd(15) + 'Browser'.padEnd(20) + 'Count'.padStart(8) + 'Users'.padStart(8));
        log('', '  ' + '─'.repeat(59));
        for (const d of reloadHealth.reloadsByDevice) {
          log('', `  ${d.device.padEnd(10)}${d.os.padEnd(15)}${d.browser.padEnd(20)}${String(d.count).padStart(8)}${String(d.users).padStart(8)}`);
        }
      }

      // Daily trend — correlate with deployments
      if (reloadHealth.dailyTrend && reloadHealth.dailyTrend.length > 0) {
        log('', '');
        log('📈', 'Daily reload/resource event trend:');
        log('', '  Date'.padEnd(14) + 'Reload'.padStart(8) + 'ResErr'.padStart(8) + 'CSS'.padStart(6) + 'Chunk'.padStart(7) + 'Total'.padStart(8) + '  Spark');
        log('', '  ' + '─'.repeat(53));
        const maxTotal = Math.max(...reloadHealth.dailyTrend.map(d => d.total), 1);
        for (const d of reloadHealth.dailyTrend) {
          const dateStr = `${d.date.slice(0, 4)}-${d.date.slice(4, 6)}-${d.date.slice(6, 8)}`;
          const spark = '█'.repeat(Math.round((d.total / maxTotal) * 15));
          const spike = (reloadHealth.spikeThreshold && d.total > reloadHealth.spikeThreshold) ? ' ⚡ SPIKE' : '';
          log('', `  ${dateStr.padEnd(12)} ${String(d.force_reload || 0).padStart(8)} ${String(d.resource_load_error || 0).padStart(8)} ${String(d.css_fallback || 0).padStart(6)} ${String(d.chunk_retry || 0).padStart(7)} ${String(d.total).padStart(8)}  ${spark}${spike}`);
        }
        if (reloadHealth.spikeDays && reloadHealth.spikeDays.length > 0) {
          log('', '');
          log('⚡', `${reloadHealth.spikeDays.length} spike day(s) detected (>${reloadHealth.spikeThreshold} events, 3x average) — check deployment timestamps`);
        }
      }

      if (reloadHealth.forceReloadTotal === 0 && reloadHealth.resourceErrorTotal === 0 &&
          reloadHealth.cssFallbacks === 0 && reloadHealth.chunkRetryTotal === 0) {
        log('✅', '  Nessun problema di caricamento risorse nel periodo!');
      }
    }
  } catch (e) {
    log('⚠️', `GA4 reload health: ${e.message}`);
  }

  // ── 3h. User Technology ─────────────────
  try {
    const res = await fetchRetry(
      `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...baseRequest,
          dimensions: [
            { name: 'browser' },
            { name: 'operatingSystem' },
          ],
          metrics: [
            { name: 'sessions' },
            { name: 'totalUsers' },
          ],
          orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
          limit: 15,
        }),
      }
    );

    if (res.ok) {
      const data = await res.json();
      result.technology = (data.rows || []).map(r => ({
        browser: r.dimensionValues[0].value,
        os: r.dimensionValues[1].value,
        sessions: parseInt(r.metricValues[0].value),
        users: parseInt(r.metricValues[1].value),
      }));

      if (!flags.json && result.technology.length > 0) {
        log('', '');
        log('💻', 'Tecnologia utenti:');
        log('', '  Browser / OS                      Sessioni   Utenti');
        log('', '  ' + '─'.repeat(55));
        for (const t of result.technology.slice(0, 10)) {
          const label = `${t.browser} / ${t.os}`;
          log('', `  ${label.padEnd(36)} ${String(t.sessions).padStart(8)} ${String(t.users).padStart(8)}`);
        }
      }
    }
  } catch (e) { log('⚠️', `GA4 technology: ${e.message}`); }

  // ── 3i. Device breakdown ────────────────
  try {
    const res = await fetchRetry(
      `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...baseRequest,
          dimensions: [{ name: 'deviceCategory' }],
          metrics: [
            { name: 'sessions' },
            { name: 'totalUsers' },
            { name: 'bounceRate' },
            { name: 'averageSessionDuration' },
          ],
          orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        }),
      }
    );

    if (res.ok) {
      const data = await res.json();
      result.devices = (data.rows || []).map(r => ({
        device: r.dimensionValues[0].value,
        sessions: parseInt(r.metricValues[0].value),
        users: parseInt(r.metricValues[1].value),
        bounceRate: parseFloat(r.metricValues[2].value),
        avgDuration: parseFloat(r.metricValues[3].value),
      }));

      if (!flags.json && result.devices.length > 0) {
        log('', '');
        log('📱', 'Dispositivi:');
        for (const d of result.devices) {
          log('', `  ${d.device.padEnd(12)} Sessioni: ${fmtNum(d.sessions).padStart(6)}  Bounce: ${(d.bounceRate * 100).toFixed(1)}%  Dur. media: ${Math.round(d.avgDuration)}s`);
        }
      }
    }
  } catch (e) { log('⚠️', `GA4 devices: ${e.message}`); }

  // ── 3j. Top landing pages ───────────────
  try {
    const res = await fetchRetry(
      `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...baseRequest,
          dimensions: [{ name: 'landingPage' }],
          metrics: [
            { name: 'sessions' },
            { name: 'bounceRate' },
            { name: 'averageSessionDuration' },
            { name: 'engagedSessions' },
          ],
          orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
          limit: 15,
        }),
      }
    );

    if (res.ok) {
      const data = await res.json();
      result.landingPages = (data.rows || []).map(r => ({
        path: r.dimensionValues[0].value,
        sessions: parseInt(r.metricValues[0].value),
        bounceRate: parseFloat(r.metricValues[1].value),
        avgDuration: parseFloat(r.metricValues[2].value),
        engagedSessions: parseInt(r.metricValues[3].value),
      }));

      if (!flags.json && result.landingPages.length > 0) {
        log('', '');
        log('🚪', 'Top landing pages (dove entrano gli utenti):');
        log('', '  Pagina                                 Sessioni  Bounce   Engaged  Durata');
        log('', '  ' + '─'.repeat(75));
        for (const p of result.landingPages.slice(0, 10)) {
          const path = p.path.slice(0, 40);
          const engRate = p.sessions > 0 ? ((p.engagedSessions / p.sessions) * 100).toFixed(0) : '0';
          log('', `  ${path.padEnd(41)} ${String(p.sessions).padStart(8)}  ${(p.bounceRate * 100).toFixed(0).padStart(5)}%  ${(engRate + '%').padStart(7)}  ${Math.round(p.avgDuration).toString().padStart(5)}s`);
        }
      }
    }
  } catch (e) { log('⚠️', `GA4 landing pages: ${e.message}`); }

  // ── 3j-bis. Empty landing page diagnostic ──
  try {
    const res = await fetchRetry(
      `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...baseRequest,
          dimensions: [
            { name: 'landingPage' },
            { name: 'sessionDefaultChannelGroup' },
            { name: 'sessionSourceMedium' },
          ],
          metrics: [
            { name: 'sessions' },
            { name: 'bounceRate' },
          ],
          dimensionFilter: {
            filter: {
              fieldName: 'landingPage',
              stringFilter: { matchType: 'EXACT', value: '(not set)' },
            },
          },
          orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
          limit: 10,
        }),
      }
    );

    if (res.ok) {
      const data = await res.json();
      const rows = (data.rows || []).map(r => ({
        channel: r.dimensionValues[1].value,
        sourceMedium: r.dimensionValues[2].value,
        sessions: parseInt(r.metricValues[0].value),
        bounceRate: parseFloat(r.metricValues[1].value),
      }));

      if (rows.length > 0) {
        result.emptyLandingDiagnostic = rows;
        if (!flags.json) {
          log('', '');
          log('🔍', 'Diagnostica landing page vuota ("not set"):');
          for (const r of rows) {
            log('', `  ${r.sourceMedium.padEnd(40)} ${r.channel.padEnd(20)} ${String(r.sessions).padStart(6)} sess  bounce ${(r.bounceRate * 100).toFixed(0)}%`);
          }
        }
      }
    }
  } catch (e) { log('⚠️', `Empty landing diagnostic: ${e.message}`); }

  // ── 3k. Week-over-week growth ───────────
  try {
    const thisWeekEnd = new Date();
    const thisWeekStart = new Date(); thisWeekStart.setDate(thisWeekStart.getDate() - 7);
    const prevWeekEnd = new Date(thisWeekStart); prevWeekEnd.setDate(prevWeekEnd.getDate() - 1);
    const prevWeekStart = new Date(prevWeekEnd); prevWeekStart.setDate(prevWeekStart.getDate() - 6);

    const res = await fetchRetry(
      `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          dateRanges: [
            { startDate: fmtDate(thisWeekStart), endDate: fmtDate(thisWeekEnd), name: 'thisWeek' },
            { startDate: fmtDate(prevWeekStart), endDate: fmtDate(prevWeekEnd), name: 'prevWeek' },
          ],
          metrics: [
            { name: 'sessions' },
            { name: 'totalUsers' },
            { name: 'screenPageViews' },
            { name: 'engagedSessions' },
          ],
        }),
      }
    );

    if (res.ok) {
      const data = await res.json();
      const rows = data.rows || [];
      // GA4 returns rows[0] for first date range, rows[1] for comparison (if no dimensions)
      const thisWeekVals = rows[0]?.metricValues || [];
      const prevWeekVals = rows[1]?.metricValues || [];

      const calc = (i) => {
        const curr = parseInt(thisWeekVals[i]?.value || '0');
        const prev = parseInt(prevWeekVals[i]?.value || '0');
        const delta = prev > 0 ? (((curr - prev) / prev) * 100).toFixed(1) : (curr > 0 ? '+∞' : '0.0');
        return { curr, prev, delta };
      };

      result.weekOverWeek = {
        period: `${fmtDate(thisWeekStart)} → ${fmtDate(thisWeekEnd)} vs ${fmtDate(prevWeekStart)} → ${fmtDate(prevWeekEnd)}`,
        sessions: calc(0),
        users: calc(1),
        pageViews: calc(2),
        engaged: calc(3),
      };

      if (!flags.json) {
        const w = result.weekOverWeek;
        log('', '');
        log('📈', 'Crescita settimana su settimana:');
        log('', `  Periodo: ${w.period}`);
        const fmt = (label, m) => {
          const arrow = parseFloat(m.delta) > 0 ? '↑' : parseFloat(m.delta) < 0 ? '↓' : '→';
          return `  ${label.padEnd(16)} ${String(m.curr).padStart(8)} vs ${String(m.prev).padStart(8)}  ${arrow} ${m.delta}%`;
        };
        log('', fmt('Sessioni', w.sessions));
        log('', fmt('Utenti', w.users));
        log('', fmt('Page views', w.pageViews));
        log('', fmt('Engaged', w.engaged));
      }
    }
  } catch (e) { log('⚠️', `GA4 week-over-week: ${e.message}`); }

  // ── 3l. Web Vitals RUM data ─────────────
  try {
    const res = await fetchRetry(
      `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...baseRequest,
          dimensions: [
            { name: 'customEvent:metric_name' },
            { name: 'customEvent:metric_rating' },
          ],
          metrics: [
            { name: 'eventCount' },
          ],
          dimensionFilter: {
            filter: {
              fieldName: 'eventName',
              stringFilter: { matchType: 'EXACT', value: 'web_vitals' },
            },
          },
          orderBys: [{ dimension: { dimensionName: 'customEvent:metric_name' } }],
        }),
      }
    );

    if (res.ok) {
      const data = await res.json();
      const rows = data.rows || [];
      if (rows.length > 0) {
        result.webVitalsRUM = rows.map(r => ({
          metric: r.dimensionValues[0].value,
          rating: r.dimensionValues[1].value,
          count: parseInt(r.metricValues[0].value),
        }));

        if (!flags.json) {
          log('', '');
          log('⚡', 'Core Web Vitals (RUM — dati reali utenti):');
          const metrics = {};
          for (const r of result.webVitalsRUM) {
            if (!metrics[r.metric]) metrics[r.metric] = { good: 0, 'needs-improvement': 0, poor: 0, total: 0 };
            metrics[r.metric][r.rating] = (metrics[r.metric][r.rating] || 0) + r.count;
            metrics[r.metric].total += r.count;
          }
          for (const [name, data] of Object.entries(metrics)) {
            const goodPct = data.total > 0 ? ((data.good / data.total) * 100).toFixed(0) : '0';
            const poorPct = data.total > 0 ? ((data.poor / data.total) * 100).toFixed(0) : '0';
            const emoji = parseInt(goodPct) >= 75 ? '🟢' : parseInt(poorPct) >= 25 ? '🔴' : '🟡';
            log('', `  ${emoji} ${name.padEnd(6)} ${goodPct}% good  ${poorPct}% poor   (n=${data.total})`);
          }
        }
      } else {
        result.webVitalsRUM = [];
        if (!flags.json) {
          log('', '');
          log('ℹ️', 'Web Vitals RUM: nessun dato (web-vitals tracking appena attivato)');
        }
      }
    }
  } catch (e) { log('⚠️', `GA4 web vitals RUM: ${e.message}`); }

  // ── 3m. Self-referral detection ─────────
  try {
    if (result.trafficSources) {
      const selfReferrals = result.trafficSources.filter(s =>
        s.source?.includes('frontaliereticino.ch') ||
        s.source === 'localhost' ||
        s.source?.startsWith('127.0.0.') ||
        s.source?.startsWith('192.168.')
      );

      if (selfReferrals.length > 0) {
        const totalSelfSessions = selfReferrals.reduce((sum, s) => sum + s.sessions, 0);
        result.selfReferralWarning = {
          detected: true,
          totalSessions: totalSelfSessions,
          sources: selfReferrals.map(s => ({ source: s.source, sessions: s.sessions })),
          recommendation: 'Configure GA4 referral exclusion list in Admin > Data Streams > Configure tag settings > List unwanted referrals. Add: frontaliereticino.ch, localhost',
        };

        if (!flags.json) {
          log('', '');
          log('⚠️', `Self-referral rilevato: ${totalSelfSessions} sessioni da sorgenti interne:`);
          for (const s of selfReferrals) {
            log('', `  • ${s.source}: ${s.sessions} sessioni`);
          }
          log('💡', '  Azione: Aggiungi frontaliereticino.ch e localhost alla lista esclusioni referral in GA4');
        }
      } else {
        result.selfReferralWarning = { detected: false };
      }
    }
  } catch (e) { log('⚠️', `Self-referral check: ${e.message}`); }

  // ── 3n. Content section performance ─────
  try {
    if (result.topPages) {
      const sections = {};
      for (const p of result.topPages) {
        const match = p.path.match(/^\/([^/]+)/);
        const section = match ? match[1] : '(homepage)';
        if (!sections[section]) sections[section] = { views: 0, users: 0, pages: 0, totalDuration: 0 };
        sections[section].views += p.views;
        sections[section].users += p.users;
        sections[section].pages += 1;
        sections[section].totalDuration += p.avgDuration * p.users;
      }

      result.contentSections = Object.entries(sections)
        .map(([name, data]) => ({
          section: name,
          views: data.views,
          users: data.users,
          pages: data.pages,
          avgDuration: data.users > 0 ? Math.round(data.totalDuration / data.users) : 0,
        }))
        .sort((a, b) => b.views - a.views);

      if (!flags.json && result.contentSections.length > 0) {
        log('', '');
        log('📂', 'Performance per sezione:');
        log('', '  Sezione                          Views    Utenti   Pagine  Dur. media');
        log('', '  ' + '─'.repeat(70));
        for (const s of result.contentSections.slice(0, 12)) {
          log('', `  ${s.section.padEnd(33)} ${String(s.views).padStart(7)} ${String(s.users).padStart(8)} ${String(s.pages).padStart(8)}  ${String(s.avgDuration + 's').padStart(9)}`);
        }
      }
    }
  } catch (e) { log('⚠️', `Content sections: ${e.message}`); }

  // ── 3p. Calculator funnel analysis ──────
  try {
    const res = await fetchRetry(
      `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...baseRequest,
          dimensions: [{ name: 'customEvent:step_name' }],
          metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
          dimensionFilter: {
            filter: {
              fieldName: 'eventName',
              stringFilter: { value: 'funnel_step', matchType: 'EXACT' },
            },
          },
          orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
          limit: 20,
        }),
      }
    );

    if (res.ok) {
      const data = await res.json();
      const steps = (data.rows || []).map(r => ({
        step: r.dimensionValues[0].value,
        count: parseInt(r.metricValues[0].value, 10),
        users: parseInt(r.metricValues[1].value, 10),
      }));

      // Order funnel steps logically
      const stepOrder = ['entry', 'input_start', 'calculate', 'compare', 'cta_click'];
      const orderedSteps = stepOrder
        .map(s => steps.find(st => st.step === s) || { step: s, count: 0, users: 0 })
        .filter(s => s.count > 0 || stepOrder.indexOf(s.step) <= 2); // Always show first 3

      result.calculatorFunnel = orderedSteps;

      if (!flags.json && orderedSteps.length > 0) {
        log('', '');
        log('🔢', 'Calculator Funnel (funnel_step events):');
        log('', '  Step'.padEnd(20) + 'Events'.padStart(8) + 'Users'.padStart(8) + 'Drop-off'.padStart(10));
        log('', '  ' + '─'.repeat(44));
        for (let i = 0; i < orderedSteps.length; i++) {
          const s = orderedSteps[i];
          const prev = i > 0 ? orderedSteps[i - 1].users : s.users;
          const dropOff = prev > 0 && i > 0 ? `-${((1 - s.users / prev) * 100).toFixed(0)}%` : '';
          const bar = '█'.repeat(Math.round((s.users / (orderedSteps[0]?.users || 1)) * 15));
          log('', `  ${s.step.padEnd(18)} ${String(s.count).padStart(8)} ${String(s.users).padStart(8)} ${dropOff.padStart(10)}  ${bar}`);
        }
        if (orderedSteps.length >= 2) {
          const entryUsers = orderedSteps[0].users;
          const lastStep = orderedSteps[orderedSteps.length - 1];
          const overallConversion = entryUsers > 0 ? ((lastStep.users / entryUsers) * 100).toFixed(1) : '0';
          log('', `  Overall conversion (${orderedSteps[0].step} → ${lastStep.step}): ${overallConversion}%`);
        }
      }
    }
  } catch (e) { log('⚠️', `Calculator funnel: ${e.message}`); }

  // ── 3q. Scroll depth analysis ───────────
  try {
    const res = await fetchRetry(
      `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...baseRequest,
          dimensions: [
            { name: 'customEvent:percent_scrolled' },
            { name: 'pagePath' },
          ],
          metrics: [{ name: 'eventCount' }],
          dimensionFilter: {
            filter: {
              fieldName: 'eventName',
              stringFilter: { value: 'scroll_depth', matchType: 'EXACT' },
            },
          },
          orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
          limit: 100,
        }),
      }
    );

    if (res.ok) {
      const data = await res.json();
      const rawRows = (data.rows || []).map(r => ({
        percent: r.dimensionValues[0].value,
        path: r.dimensionValues[1].value,
        count: parseInt(r.metricValues[0].value, 10),
      }));

      // Aggregate by scroll depth percentage
      const byPercent = {};
      for (const r of rawRows) {
        const pct = r.percent;
        if (!byPercent[pct]) byPercent[pct] = { count: 0, pages: new Set() };
        byPercent[pct].count += r.count;
        byPercent[pct].pages.add(r.path);
      }

      // Aggregate by page — how far users scroll on each page
      const byPage = {};
      for (const r of rawRows) {
        if (!byPage[r.path]) byPage[r.path] = {};
        byPage[r.path][r.percent] = (byPage[r.path][r.percent] || 0) + r.count;
      }

      result.scrollDepth = {
        byPercent: Object.entries(byPercent)
          .map(([pct, d]) => ({ percent: pct, count: d.count, uniquePages: d.pages.size }))
          .sort((a, b) => parseInt(a.percent) - parseInt(b.percent)),
        topPages: Object.entries(byPage)
          .map(([path, depths]) => ({ path, depths, total: Object.values(depths).reduce((s, c) => s + c, 0) }))
          .sort((a, b) => b.total - a.total)
          .slice(0, 10),
      };

      if (!flags.json && result.scrollDepth.byPercent.length > 0) {
        log('', '');
        log('📜', 'Scroll Depth Analysis:');
        log('', '  Depth'.padEnd(10) + 'Events'.padStart(8) + 'Pages'.padStart(8));
        log('', '  ' + '─'.repeat(24));
        for (const d of result.scrollDepth.byPercent) {
          const bar = '█'.repeat(Math.round((d.count / (result.scrollDepth.byPercent[0]?.count || 1)) * 15));
          log('', `  ${(d.percent + '%').padEnd(8)} ${String(d.count).padStart(8)} ${String(d.uniquePages).padStart(8)}  ${bar}`);
        }

        // Show pages where users scroll least (potential engagement issues)
        const pagesWithLowScroll = result.scrollDepth.topPages.filter(p => {
          const total = p.total;
          const deep = (p.depths['75'] || 0) + (p.depths['100'] || 0);
          return total > 10 && deep / total < 0.3; // Less than 30% reach 75%+
        });
        if (pagesWithLowScroll.length > 0) {
          log('', '');
          log('⚠️', 'Pages with low scroll depth (< 30% reach 75%):');
          for (const p of pagesWithLowScroll.slice(0, 5)) {
            const deepPct = ((((p.depths['75'] || 0) + (p.depths['100'] || 0)) / p.total) * 100).toFixed(0);
            log('', `  ${p.path.slice(0, 45).padEnd(47)} ${deepPct}% reach 75%+ (n=${p.total})`);
          }
        }
      }
    }
  } catch (e) { log('⚠️', `Scroll depth: ${e.message}`); }

  // ── 3r. New vs returning users ──────────
  try {
    const res = await fetchRetry(
      `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...baseRequest,
          dimensions: [{ name: 'newVsReturning' }],
          metrics: [
            { name: 'totalUsers' },
            { name: 'sessions' },
            { name: 'engagedSessions' },
            { name: 'averageSessionDuration' },
            { name: 'screenPageViews' },
          ],
          orderBys: [{ metric: { metricName: 'totalUsers' }, desc: true }],
        }),
      }
    );

    if (res.ok) {
      const data = await res.json();
      result.newVsReturning = (data.rows || []).map(r => ({
        type: r.dimensionValues[0].value,
        users: parseInt(r.metricValues[0].value),
        sessions: parseInt(r.metricValues[1].value),
        engaged: parseInt(r.metricValues[2].value),
        avgDuration: parseFloat(r.metricValues[3].value),
        pageViews: parseInt(r.metricValues[4].value),
      }));

      if (!flags.json && result.newVsReturning.length > 0) {
        log('', '');
        log('👥', 'New vs Returning Users:');
        log('', '  Type'.padEnd(14) + 'Users'.padStart(8) + 'Sessions'.padStart(10) + 'Engaged%'.padStart(10) + 'Pages/User'.padStart(11) + 'Avg Dur'.padStart(9));
        log('', '  ' + '─'.repeat(60));
        for (const r of result.newVsReturning) {
          const engRate = r.sessions > 0 ? ((r.engaged / r.sessions) * 100).toFixed(0) : '0';
          const pagesPerUser = r.users > 0 ? (r.pageViews / r.users).toFixed(1) : '0';
          log('', `  ${r.type.padEnd(12)} ${String(r.users).padStart(8)} ${String(r.sessions).padStart(10)} ${(engRate + '%').padStart(10)} ${pagesPerUser.padStart(11)} ${(Math.round(r.avgDuration) + 's').padStart(9)}`);
        }

        const returning = result.newVsReturning.find(r => r.type === 'returning');
        const newU = result.newVsReturning.find(r => r.type === 'new');
        if (returning && newU) {
          const retentionRate = ((returning.users / (returning.users + newU.users)) * 100).toFixed(1);
          log('', `  Retention rate: ${retentionRate}% (returning / total users)`);
        }
      }
    }
  } catch (e) { log('⚠️', `New vs returning: ${e.message}`); }

  // ── 3s. Exit pages analysis ─────────────
  try {
    const res = await fetchRetry(
      `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...baseRequest,
          dimensions: [{ name: 'pagePath' }],
          metrics: [
            { name: 'sessions' },
            { name: 'bounceRate' },
            { name: 'userEngagementDuration' },
          ],
          dimensionFilter: {
            filter: {
              fieldName: 'pagePath',
              stringFilter: { matchType: 'BEGINS_WITH', value: '/' },
            },
          },
          orderBys: [{ metric: { metricName: 'bounceRate' }, desc: true }],
          limit: 15,
        }),
      }
    );

    if (res.ok) {
      const data = await res.json();
      const highBouncePages = (data.rows || [])
        .map(r => ({
          path: r.dimensionValues[0].value,
          sessions: parseInt(r.metricValues[0].value),
          bounceRate: parseFloat(r.metricValues[1].value),
          engagementDuration: parseFloat(r.metricValues[2].value),
        }))
        .filter(p => p.sessions >= 10 && p.bounceRate > 0.5); // Min 10 sessions, >50% bounce

      result.highBouncePaths = highBouncePages;

      if (!flags.json && highBouncePages.length > 0) {
        log('', '');
        log('🚪', 'High-bounce pages (>50% bounce, ≥10 sessions):');
        log('', '  Page'.padEnd(48) + 'Sessions'.padStart(10) + 'Bounce'.padStart(8) + 'Eng.time'.padStart(10));
        log('', '  ' + '─'.repeat(74));
        for (const p of highBouncePages.slice(0, 10)) {
          const engMin = (p.engagementDuration / 60).toFixed(1);
          log('', `  ${p.path.slice(0, 46).padEnd(46)} ${String(p.sessions).padStart(10)} ${((p.bounceRate * 100).toFixed(0) + '%').padStart(8)} ${(engMin + 'm').padStart(10)}`);
        }
      }
    }
  } catch (e) { log('⚠️', `Exit pages: ${e.message}`); }

  // ── 3o. Actionable recommendations ──────
  try {
    const recommendations = [];

    // CLS recommendation from PageSpeed data (checked externally)
    if (result.summary) {
      const bounceRate = result.summary.bounceRate;
      if (bounceRate > 0.5) {
        recommendations.push({
          severity: 'high',
          area: 'engagement',
          message: `Bounce rate alto (${(bounceRate * 100).toFixed(1)}%) — verifica UX della landing page principale`,
        });
      }
      if (result.summary.avgSessionDuration < 60) {
        recommendations.push({
          severity: 'medium',
          area: 'engagement',
          message: `Durata sessione bassa (${Math.round(result.summary.avgSessionDuration)}s) — contenuti richiedono miglioramento`,
        });
      }
    }

    // Self-referral
    if (result.selfReferralWarning?.detected) {
      recommendations.push({
        severity: 'medium',
        area: 'tracking',
        message: `Self-referral: ${result.selfReferralWarning.totalSessions} sessioni da sorgenti interne — configura esclusioni GA4`,
      });
    }

    // Web Vitals
    if (result.webVitalsRUM && result.webVitalsRUM.length > 0) {
      const metrics = {};
      for (const r of result.webVitalsRUM) {
        if (!metrics[r.metric]) metrics[r.metric] = { good: 0, poor: 0, total: 0 };
        if (r.rating === 'good') metrics[r.metric].good += r.count;
        if (r.rating === 'poor') metrics[r.metric].poor += r.count;
        metrics[r.metric].total += r.count;
      }
      for (const [name, data] of Object.entries(metrics)) {
        const poorPct = data.total > 0 ? (data.poor / data.total) * 100 : 0;
        if (poorPct >= 25) {
          recommendations.push({
            severity: 'high',
            area: 'performance',
            message: `${name}: ${poorPct.toFixed(0)}% degli utenti ha esperienza "poor" — ottimizzare urgentemente`,
          });
        }
      }
    }

    // Traffic diversification
    if (result.trafficSources) {
      const totalSessions = result.trafficSources.reduce((s, t) => s + t.sessions, 0);
      const topSource = result.trafficSources[0];
      if (topSource && topSource.sessions / totalSessions > 0.5) {
        recommendations.push({
          severity: 'medium',
          area: 'traffic',
          message: `Dipendenza da ${topSource.source} (${((topSource.sessions / totalSessions) * 100).toFixed(0)}% del traffico) — diversificare le sorgenti`,
        });
      }
    }

    // Funnel health (uses new parameter-level breakdown)
    if (result.firebaseAnalytics?.funnels) {
      const funnels = result.firebaseAnalytics.funnels;
      const allEmpty = Object.values(funnels).every(f =>
        !f || (Array.isArray(f) ? f.length === 0 || f.every(s => s.eventCount === 0) : true)
      );
      if (allEmpty) {
        // Check funnelTotals to distinguish "events not fired" from "custom dimensions not registered"
        const totals = result.firebaseAnalytics.funnelTotals || {};
        const hasAnyEvents = Object.values(totals).some(t => (t?.eventCount || 0) > 0);
        if (hasAnyEvents) {
          const activeEvents = Object.entries(totals)
            .filter(([, t]) => (t?.eventCount || 0) > 0)
            .map(([name, t]) => `${name}(${t.eventCount})`)
            .join(', ');
          recommendations.push({
            severity: 'medium',
            area: 'tracking',
            message: `Funnel breakdown vuoti ma eventi presenti (${activeEvents}) — registrare le custom dimensions in GA4 Admin: step_name, step, event, action.`,
          });
        } else {
          recommendations.push({
            severity: 'high',
            area: 'tracking',
            message: 'Tutti i funnel sono a ZERO — tracking rotto o feature non attive. Verificare implementazione chatbot/newsletter/auth.',
          });
        }
      }
    } else if (result.funnels) {
      // Legacy check for old format (funnels at top level)
      const allZero = Object.values(result.funnels).every(f =>
        !f || (Array.isArray(f) ? f.every(s => (s.count || s.eventCount || 0) === 0) : true)
      );
      if (allZero) {
        recommendations.push({
          severity: 'high',
          area: 'tracking',
          message: 'Tutti i funnel sono a ZERO — tracking rotto o feature non attive. Verificare implementazione chatbot/newsletter/auth.',
        });
      }
    }

    // Calculator funnel drop-off (uses new parameter-level breakdown)
    const conversionFunnel = result.firebaseAnalytics?.funnels?.conversion || result.calculatorFunnel;
    if (conversionFunnel && conversionFunnel.length >= 2) {
      const entry = conversionFunnel.find(s => (s.step || s.step_name) === 'entry');
      const calculate = conversionFunnel.find(s => (s.step || s.step_name) === 'calculate');
      if (entry && calculate && (entry.users || 0) > 0) {
        const conversionRate = (calculate.users / entry.users) * 100;
        if (conversionRate < 30) {
          recommendations.push({
            severity: 'high',
            area: 'conversion',
            message: `Solo ${conversionRate.toFixed(0)}% degli utenti completa il calcolo (${calculate.users}/${entry.users}) — semplificare l'input o mostrare risultati parziali`,
          });
        } else if (conversionRate < 60) {
          recommendations.push({
            severity: 'medium',
            area: 'conversion',
            message: `${conversionRate.toFixed(0)}% calculator conversion rate — margine di miglioramento UX`,
          });
        }
      }
    }

    // Low scroll depth warning
    if (result.scrollDepth?.byPercent?.length > 0) {
      const depth25 = result.scrollDepth.byPercent.find(d => d.percent === '25');
      const depth75 = result.scrollDepth.byPercent.find(d => d.percent === '75');
      if (depth25 && depth75 && depth25.count > 0) {
        const completionRate = (depth75.count / depth25.count) * 100;
        if (completionRate < 20) {
          recommendations.push({
            severity: 'medium',
            area: 'content',
            message: `Solo ${completionRate.toFixed(0)}% degli utenti scorre fino al 75% della pagina — contenuti above-the-fold richiedono hook più forte`,
          });
        }
      }
    }

    // Retention warning
    if (result.newVsReturning) {
      const returning = result.newVsReturning.find(r => r.type === 'returning');
      const newU = result.newVsReturning.find(r => r.type === 'new');
      if (returning && newU && (returning.users + newU.users) > 50) {
        const retentionRate = (returning.users / (returning.users + newU.users)) * 100;
        if (retentionRate < 10) {
          recommendations.push({
            severity: 'high',
            area: 'retention',
            message: `Retention rate molto basso (${retentionRate.toFixed(1)}%) — implementare email digest, notifiche push o gamification per il ritorno`,
          });
        } else if (retentionRate < 25) {
          recommendations.push({
            severity: 'medium',
            area: 'retention',
            message: `Retention rate ${retentionRate.toFixed(1)}% — buono ma migliorabile con newsletter settimanale e notifiche push`,
          });
        }
      }
    }

    // High-bounce specific pages
    if (result.highBouncePaths && result.highBouncePaths.length > 0) {
      const criticalBounce = result.highBouncePaths.filter(p => p.sessions >= 50 && p.bounceRate > 0.7);
      if (criticalBounce.length > 0) {
        const paths = criticalBounce.slice(0, 3).map(p => p.path).join(', ');
        recommendations.push({
          severity: 'high',
          area: 'engagement',
          message: `Pagine con >70% bounce e ≥50 sessioni: ${paths} — rivedere contenuto e CTA`,
        });
      }
    }

    if (result.internalSearchTerms && result.internalSearchTerms.length > 0) {
      const highIntentTerms = result.internalSearchTerms.filter((term) => term.searches >= 5);
      if (highIntentTerms.length >= 3) {
        const examples = highIntentTerms.slice(0, 4).map((term) => term.term).join(', ');
        recommendations.push({
          severity: 'medium',
          area: 'product',
          message: `Domanda interna ricorrente su ${examples} — creare shortcut, landing dedicate o moduli homepage per ridurre la dipendenza dalla search box`,
        });
      }
    }

    if (result.pageTemplatePerformance && result.pageTemplatePerformance.length > 0) {
      const weakTemplates = result.pageTemplatePerformance
        .filter((row) => row.views >= 100 && row.avgDuration <= 45)
        .slice(0, 3);
      if (weakTemplates.length > 0) {
        recommendations.push({
          severity: 'medium',
          area: 'content',
          message: `Template con engagement debole: ${weakTemplates.map((row) => row.pageTemplate).join(', ')} — rivedere above-the-fold, link interni e CTA`,
        });
      }
    }

    // Reload & Resource Health alerts
    if (result.reloadHealth) {
      const rh = result.reloadHealth;

      // Blocked reloads = infinite loop prevented = critical
      if (rh.blockedReloads > 0) {
        recommendations.push({
          severity: 'high',
          area: 'stability',
          message: `${rh.blockedReloads} reload bloccati dal guard (loop infinito prevenuto) — verificare Service Worker e deployment`,
        });
      }

      // High force reload count
      if (rh.forceReloadTotal >= 50) {
        recommendations.push({
          severity: 'high',
          area: 'stability',
          message: `${rh.forceReloadTotal} force reload nel periodo — possibile problema di deployment o cache SW stale`,
        });
      } else if (rh.forceReloadTotal >= 10) {
        recommendations.push({
          severity: 'medium',
          area: 'stability',
          message: `${rh.forceReloadTotal} force reload nel periodo — monitorare correlazione con deploy`,
        });
      }

      // Genuine resource errors (not ad-blocker)
      if (rh.genuineErrors >= 20) {
        recommendations.push({
          severity: 'high',
          area: 'stability',
          message: `${rh.genuineErrors} errori di caricamento risorse genuini (non ad-blocker) — chunk stale o problemi CDN`,
        });
      } else if (rh.genuineErrors >= 5) {
        recommendations.push({
          severity: 'medium',
          area: 'stability',
          message: `${rh.genuineErrors} errori di caricamento risorse genuini — verificare integrità asset dopo deploy`,
        });
      }

      // CSS fallback = user saw unstyled content
      if (rh.cssFallbacks >= 10) {
        recommendations.push({
          severity: 'medium',
          area: 'performance',
          message: `${rh.cssFallbacks} attivazioni CSS fallback — utenti vedono contenuto senza stili per 3s. Considerare inline critical CSS`,
        });
      }

      // Chunk retry failure rate
      if (rh.chunkRetryTotal > 0) {
        const failures = rh.chunkRetries.filter(r => r.outcome === 'failure');
        const failCount = failures.reduce((s, r) => s + r.count, 0);
        if (failCount > 0) {
          const failRate = ((failCount / rh.chunkRetryTotal) * 100).toFixed(0);
          recommendations.push({
            severity: failCount >= 10 ? 'high' : 'medium',
            area: 'stability',
            message: `${failCount}/${rh.chunkRetryTotal} chunk retry falliti (${failRate}%) — ErrorBoundary mostra errore a questi utenti`,
          });
        }
      }
    }

    // ── Error health recommendations ──
    if (result.errorHealth) {
      const eh = result.errorHealth;
      if (eh.errorRate >= 3) {
        recommendations.push({
          severity: 'high',
          area: 'stability',
          message: `Error rate CRITICO: ${eh.errorRate.toFixed(1)}% (${eh.totalErrors} app_error su ${eh.totalEvents} eventi) — investigare stack trace`,
        });
      } else if (eh.errorRate >= 1) {
        recommendations.push({
          severity: 'medium',
          area: 'stability',
          message: `Error rate elevato: ${eh.errorRate.toFixed(1)}% (${eh.totalErrors} errori) — ridurre sotto 1%`,
        });
      }
      if (eh.topErrorPages && eh.topErrorPages.length > 0) {
        const topPage = eh.topErrorPages[0];
        if (topPage.errorCount >= 20) {
          recommendations.push({
            severity: 'high',
            area: 'stability',
            message: `Pagina con più errori: ${topPage.page} (${topPage.errorCount} errori) — debug urgente`,
          });
        }
      }
    }

    // ── PageSpeed recommendations ──
    if (result.pageSpeed) {
      const ps = Array.isArray(result.pageSpeed) ? result.pageSpeed : (result.pageSpeed.results || []);
      const mobileResults = ps.filter(r => r.strategy === 'mobile');
      const poorMobile = mobileResults.filter(r => r.performance < 50);
      if (poorMobile.length > 0) {
        const names = poorMobile.map(p => `${p.page}(${p.performance})`).join(', ');
        recommendations.push({
          severity: 'high',
          area: 'performance',
          message: `PageSpeed mobile SCARSO (<50): ${names} — ottimizzare LCP e TBT`,
        });
      }
      const highClsPages = ps.filter(r => r.cls > 0.1);
      if (highClsPages.length > 0) {
        const names = highClsPages.map(p => `${p.page}/${p.strategy}(CLS ${p.cls.toFixed(3)})`).join(', ');
        recommendations.push({
          severity: 'medium',
          area: 'performance',
          message: `CLS elevato (>0.1): ${names} — aggiungere dimensioni fisse agli elementi dinamici`,
        });
      }
    }

    // ── URL inspection recommendations ──
    if (result.urlInspection) {
      const inspections = Array.isArray(result.urlInspection) ? result.urlInspection : (result.urlInspection.results || []);
      const notIndexed = inspections.filter(u => u.verdict !== 'PASS' && u.coverageState !== 'Submitted and indexed');
      if (notIndexed.length > 0) {
        const urls = notIndexed.slice(0, 3).map(u => u.url || u.path).join(', ');
        recommendations.push({
          severity: 'high',
          area: 'seo',
          message: `${notIndexed.length} URL importanti NON indicizzate: ${urls} — richiedere indicizzazione in GSC`,
        });
      }
    }

    // ── Landing page gap ──
    if (result.landingPages) {
      const emptyLanding = result.landingPages.find(p => p.path === '(not set)' || p.path === '');
      if (emptyLanding && emptyLanding.sessions >= 50) {
        recommendations.push({
          severity: 'medium',
          area: 'tracking',
          message: `${emptyLanding.sessions} sessioni con landing page vuota (bounce ~100%) — probabile traffico bot o referral spam`,
        });
      }
    }

    // ── Desktop vs Mobile CTR gap ──
    if (result.deviceBreakdown) {
      const mobile = result.deviceBreakdown.find(d => d.device?.toLowerCase() === 'mobile');
      const desktop = result.deviceBreakdown.find(d => d.device?.toLowerCase() === 'desktop');
      if (mobile && desktop && mobile.ctr && desktop.ctr) {
        const gap = mobile.ctr - desktop.ctr;
        if (gap > 1.5) {
          recommendations.push({
            severity: 'medium',
            area: 'seo',
            message: `CTR mobile (${mobile.ctr.toFixed(1)}%) supera desktop (${desktop.ctr.toFixed(1)}%) di ${gap.toFixed(1)}pp — ottimizzare title/description per intent desktop`,
          });
        }
      }
    }

    // ── Traffic diversification alert ──
    if (result.trafficSources) {
      const organicSearch = result.trafficSources.find(t =>
        (t.source || t.channel || '').toLowerCase().includes('organic search'));
      const totalSessions = result.trafficSources.reduce((s, t) => s + (t.sessions || 0), 0);
      if (organicSearch && totalSessions > 0) {
        const searchPct = (organicSearch.sessions / totalSessions) * 100;
        if (searchPct < 25) {
          recommendations.push({
            severity: 'medium',
            area: 'seo',
            message: `Solo ${searchPct.toFixed(0)}% da ricerca organica (${organicSearch.sessions} sessioni) — aumentare focus SEO per ridurre dipendenza da social`,
          });
        }
      }
    }

    result.recommendations = recommendations;

    if (!flags.json && recommendations.length > 0) {
      log('', '');
      log('💡', 'RACCOMANDAZIONI AUTOMATICHE:');
      log('', '  ' + '─'.repeat(65));
      for (const r of recommendations) {
        const icon = r.severity === 'high' ? '🔴' : r.severity === 'medium' ? '🟡' : '🟢';
        log('', `  ${icon} [${r.area}] ${r.message}`);
      }
    }
  } catch (e) { log('⚠️', `Recommendations: ${e.message}`); }

  return result;
}

// ═══════════════════════════════════════════════════════════
// 3d. BING WEBMASTER TOOLS
// ═══════════════════════════════════════════════════════════
async function reportBing() {
  const apiKey = process.env.BING_API_KEY;
  if (!apiKey) {
    log('ℹ️', 'BING_API_KEY non configurata — skip Bing Webmaster');
    return null;
  }

  log('', '');
  log('🔵', 'Bing Webmaster Tools');
  log('', '─'.repeat(50));

  const siteHost = 'https://frontaliereticino.ch';
  const base = 'https://ssl.bing.com/webmaster/api.svc/json';
  const result = {};

  // ── Traffic stats (clicks, impressions, CTR) ──
  try {
    const res = await fetchRetry(
      `${base}/GetPageStats?apikey=${encodeURIComponent(apiKey)}&siteUrl=${encodeURIComponent(siteHost)}`,
      { headers: { 'Content-Type': 'application/json' } }
    );
    if (res.ok) {
      const data = await res.json();
      const stats = data.d || data;
      if (Array.isArray(stats) && stats.length > 0) {
        // Last 30 days aggregation
        const recent = stats.slice(-DAYS);
        const totalClicks = recent.reduce((s, d) => s + (d.Clicks || 0), 0);
        const totalImpressions = recent.reduce((s, d) => s + (d.Impressions || 0), 0);
        const avgCtr = totalImpressions > 0 ? (totalClicks / totalImpressions * 100).toFixed(2) : '0.00';

        result.traffic = {
          clicks: totalClicks,
          impressions: totalImpressions,
          ctr: parseFloat(avgCtr),
          days: recent.length,
        };

        if (!flags.json) {
          log('📊', `Bing Traffic (${recent.length}gg): ${fmtNum(totalClicks)} click, ${fmtNum(totalImpressions)} impression, CTR ${avgCtr}%`);
        }
      } else {
        log('ℹ️', 'Bing: nessun dato di traffico disponibile');
      }
    } else {
      log('⚠️', `Bing PageStats: HTTP ${res.status}`);
    }
  } catch (e) { log('⚠️', `Bing traffic: ${e.message}`); }

  // ── Top search queries ──
  try {
    const res = await fetchRetry(
      `${base}/GetQueryStats?apikey=${encodeURIComponent(apiKey)}&siteUrl=${encodeURIComponent(siteHost)}`,
      { headers: { 'Content-Type': 'application/json' } }
    );
    if (res.ok) {
      const data = await res.json();
      const queries = data.d || data;
      if (Array.isArray(queries) && queries.length > 0) {
        // Aggregate by query
        const qMap = new Map();
        for (const q of queries) {
          const key = q.Query || '';
          if (!key) continue;
          const existing = qMap.get(key) || { query: key, clicks: 0, impressions: 0 };
          existing.clicks += q.Clicks || 0;
          existing.impressions += q.Impressions || 0;
          qMap.set(key, existing);
        }
        const topQueries = [...qMap.values()]
          .sort((a, b) => b.impressions - a.impressions)
          .slice(0, 20)
          .map(q => ({
            ...q,
            ctr: q.impressions > 0 ? parseFloat((q.clicks / q.impressions * 100).toFixed(2)) : 0,
          }));

        result.topQueries = topQueries;

        if (!flags.json && topQueries.length > 0) {
          log('', '');
          log('🔍', 'Top query Bing:');
          for (const q of topQueries.slice(0, 10)) {
            log('', `  ${q.query.padEnd(45)} Click: ${String(q.clicks).padStart(5)} | Impr: ${fmtNum(q.impressions).padStart(8)} | CTR: ${String(q.ctr).padStart(5)}%`);
          }
        }
      }
    } else if (res.status !== 404) {
      log('⚠️', `Bing QueryStats: HTTP ${res.status}`);
    }
  } catch (e) { log('⚠️', `Bing queries: ${e.message}`); }

  // ── Crawl stats ──
  try {
    const res = await fetchRetry(
      `${base}/GetCrawlStats?apikey=${encodeURIComponent(apiKey)}&siteUrl=${encodeURIComponent(siteHost)}`,
      { headers: { 'Content-Type': 'application/json' } }
    );
    if (res.ok) {
      const data = await res.json();
      const stats = data.d || data;
      if (Array.isArray(stats) && stats.length > 0) {
        const recent = stats.slice(-DAYS);
        const totalCrawled = recent.reduce((s, d) => s + (d.CrawledPages || 0), 0);
        const totalErrors = recent.reduce((s, d) => s + (d.CrawlErrors || 0), 0);
        const avgPerDay = Math.round(totalCrawled / recent.length);

        result.crawl = {
          totalCrawled,
          totalErrors,
          avgPerDay,
          days: recent.length,
        };

        if (!flags.json) {
          log('🕷️', `Bing Crawl (${recent.length}gg): ${fmtNum(totalCrawled)} pagine, ${totalErrors} errori, media ${avgPerDay}/giorno`);
        }
      }
    } else if (res.status !== 404) {
      log('⚠️', `Bing CrawlStats: HTTP ${res.status}`);
    }
  } catch (e) { log('⚠️', `Bing crawl: ${e.message}`); }

  return Object.keys(result).length > 0 ? result : null;
}

// ═══════════════════════════════════════════════════════════
// 5. MICROSOFT CLARITY — Behavior Analytics
// ═══════════════════════════════════════════════════════════
async function reportClarity() {
  const apiKey = process.env.CLARITY_API_KEY;
  if (!apiKey) {
    log('⏭️', 'Microsoft Clarity saltato: CLARITY_API_KEY non impostata');
    return null;
  }

  log('', '');
  log('🔬', 'Microsoft Clarity — Analisi comportamento utenti');
  log('', '─'.repeat(50));

  const BASE = 'https://www.clarity.ms/export-data/api/v1/project-live-insights';
  const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };

  async function clarityFetch(params = {}) {
    const qs = new URLSearchParams({ numOfDays: '3', ...params }).toString();
    const url = `${BASE}?${qs}`;
    const res = await fetchRetry(url, { headers }, 2);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Clarity API HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json();
  }

  // Helper: extract a specific metric from the Clarity response array
  function getMetric(data, name) {
    return data?.find(m => m.metricName === name)?.information ?? [];
  }

  const result = {};

  // ── Call 1: Overall metrics (no dimensions) ──
  try {
    const overview = await clarityFetch();
    const traffic = getMetric(overview, 'Traffic');
    const scrollDepth = getMetric(overview, 'Scroll Depth');
    const engagement = getMetric(overview, 'Engagement Time');
    const deadClicks = getMetric(overview, 'Dead Click Count');
    const rageClicks = getMetric(overview, 'Rage Click Count');
    const quickbacks = getMetric(overview, 'Quickback Click');
    const excessiveScroll = getMetric(overview, 'Excessive Scroll');
    const scriptErrors = getMetric(overview, 'Script Error Count');

    if (traffic.length > 0) {
      const t = traffic[0];
      result.overview = {
        totalSessions: t.totalSessionCount ?? 0,
        botSessions: t.totalBotSessionCount ?? 0,
        distinctUsers: t.distantUserCount ?? 0,
        pagesPerSession: t.PagesPerSessionPercentage ?? 0,
      };

      if (!flags.json) {
        log('👥', `Sessioni (3gg): ${fmtNum(result.overview.totalSessions)} totali, ${fmtNum(result.overview.distinctUsers)} utenti unici`);
        log('🤖', `Bot: ${fmtNum(result.overview.botSessions)} sessioni (${pct(result.overview.botSessions, result.overview.totalSessions)})`);
        log('📄', `Pagine/sessione: ${result.overview.pagesPerSession}`);
      }
    }

    if (scrollDepth.length > 0) {
      result.scrollDepth = scrollDepth.map(s => ({
        percentage: s.Percentage,
        totalCount: s.totalCount,
      }));
      if (!flags.json) {
        const deepScrolls = scrollDepth.filter(s => (s.Percentage ?? 0) >= 75);
        const totalScrolled = scrollDepth.reduce((a, s) => a + (s.totalCount ?? 0), 0);
        const deepCount = deepScrolls.reduce((a, s) => a + (s.totalCount ?? 0), 0);
        log('📜', `Scroll profondo (≥75%): ${fmtNum(deepCount)} su ${fmtNum(totalScrolled)} sessioni (${pct(deepCount, totalScrolled)})`);
      }
    }

    if (engagement.length > 0) {
      result.engagement = engagement.map(e => ({
        duration: e.Duration,
        totalCount: e.totalCount,
      }));
      if (!flags.json) {
        const totalEngaged = engagement.reduce((a, e) => a + (e.totalCount ?? 0), 0);
        log('⏱️', `Sessioni con engagement: ${fmtNum(totalEngaged)}`);
      }
    }

    // UX friction signals
    const frictionMetrics = {};
    if (deadClicks.length > 0) {
      frictionMetrics.deadClicks = deadClicks.reduce((a, d) => a + (d.totalCount ?? 0), 0);
    }
    if (rageClicks.length > 0) {
      frictionMetrics.rageClicks = rageClicks.reduce((a, r) => a + (r.totalCount ?? 0), 0);
    }
    if (quickbacks.length > 0) {
      frictionMetrics.quickbacks = quickbacks.reduce((a, q) => a + (q.totalCount ?? 0), 0);
    }
    if (excessiveScroll.length > 0) {
      frictionMetrics.excessiveScroll = excessiveScroll.reduce((a, e) => a + (e.totalCount ?? 0), 0);
    }
    if (scriptErrors.length > 0) {
      frictionMetrics.scriptErrors = scriptErrors.reduce((a, s) => a + (s.totalCount ?? 0), 0);
    }

    if (Object.keys(frictionMetrics).length > 0) {
      result.friction = frictionMetrics;
      if (!flags.json) {
        log('', '');
        log('⚠️', 'Segnali di frizione UX (3 giorni):');
        if (frictionMetrics.deadClicks) log('  🖱️', `Dead click: ${fmtNum(frictionMetrics.deadClicks)}`);
        if (frictionMetrics.rageClicks) log('  😤', `Rage click: ${fmtNum(frictionMetrics.rageClicks)}`);
        if (frictionMetrics.quickbacks) log('  ⬅️', `Quickback: ${fmtNum(frictionMetrics.quickbacks)}`);
        if (frictionMetrics.excessiveScroll) log('  📜', `Scroll eccessivo: ${fmtNum(frictionMetrics.excessiveScroll)}`);
        if (frictionMetrics.scriptErrors) log('  🐛', `Errori script: ${fmtNum(frictionMetrics.scriptErrors)}`);
      }
    }
  } catch (e) {
    log('⚠️', `Clarity overview: ${e.message}`);
  }

  // ── Call 2: Per-page breakdown (dimension1=URL) ──
  try {
    await sleep(1000);
    const byPage = await clarityFetch({ dimension1: 'URL' });
    const pageTraffic = getMetric(byPage, 'Traffic');
    const pageDeadClicks = getMetric(byPage, 'Dead Click Count');
    const pageRageClicks = getMetric(byPage, 'Rage Click Count');

    if (pageTraffic.length > 0) {
      const topPages = pageTraffic
        .filter(p => p.URL)
        .sort((a, b) => (b.totalSessionCount ?? 0) - (a.totalSessionCount ?? 0))
        .slice(0, 15)
        .map(p => ({
          url: p.URL,
          sessions: p.totalSessionCount ?? 0,
          users: p.distantUserCount ?? 0,
        }));
      result.topPages = topPages;

      if (!flags.json && topPages.length > 0) {
        log('', '');
        log('📊', 'Top pagine per sessioni (3gg):');
        topPages.slice(0, 10).forEach((p, i) => {
          const path = p.url.replace(SITE_URL, '') || '/';
          log(`  ${i + 1}.`, `${path} — ${fmtNum(p.sessions)} sessioni, ${fmtNum(p.users)} utenti`);
        });
      }
    }

    // Pages with most friction
    const frictionPages = [];
    const deadByPage = pageDeadClicks.filter(p => p.URL && (p.totalCount ?? 0) > 0);
    const rageByPage = pageRageClicks.filter(p => p.URL && (p.totalCount ?? 0) > 0);

    deadByPage.sort((a, b) => (b.totalCount ?? 0) - (a.totalCount ?? 0));
    rageByPage.sort((a, b) => (b.totalCount ?? 0) - (a.totalCount ?? 0));

    deadByPage.slice(0, 5).forEach(p => {
      frictionPages.push({ url: p.URL, type: 'dead_click', count: p.totalCount });
    });
    rageByPage.slice(0, 5).forEach(p => {
      frictionPages.push({ url: p.URL, type: 'rage_click', count: p.totalCount });
    });

    if (frictionPages.length > 0) {
      result.frictionPages = frictionPages;
      if (!flags.json) {
        log('', '');
        log('🚨', 'Pagine con più frizione:');
        const uniqueUrls = [...new Set(frictionPages.map(f => f.url))];
        uniqueUrls.slice(0, 5).forEach(url => {
          const path = url.replace(SITE_URL, '') || '/';
          const issues = frictionPages.filter(f => f.url === url);
          const desc = issues.map(f => `${f.type === 'dead_click' ? 'dead' : 'rage'}: ${f.count}`).join(', ');
          log('  ⚡', `${path} — ${desc}`);
        });
      }
    }
  } catch (e) {
    log('⚠️', `Clarity per-page: ${e.message}`);
  }

  // ── Call 3: Device breakdown ──
  try {
    await sleep(1000);
    const byDevice = await clarityFetch({ dimension1: 'Device' });
    const deviceTraffic = getMetric(byDevice, 'Traffic');

    if (deviceTraffic.length > 0) {
      result.devices = deviceTraffic
        .filter(d => d.Device)
        .map(d => ({
          device: d.Device,
          sessions: d.totalSessionCount ?? 0,
          users: d.distantUserCount ?? 0,
          pagesPerSession: d.PagesPerSessionPercentage ?? 0,
        }))
        .sort((a, b) => b.sessions - a.sessions);

      if (!flags.json && result.devices.length > 0) {
        log('', '');
        log('📱', 'Breakdown per dispositivo (3gg):');
        result.devices.forEach(d => {
          log('  ', `${d.device}: ${fmtNum(d.sessions)} sessioni, ${d.pagesPerSession} pag/sess`);
        });
      }
    }
  } catch (e) {
    log('⚠️', `Clarity devices: ${e.message}`);
  }

  // ── AI-powered UX suggestions ──
  if (Object.keys(result).length > 0) {
    try {
      const { callLLM, isAnyModelAvailable } = await import('./lib/ai-models.mjs');
      if (isAnyModelAvailable()) {
        log('', '');
        log('🤖', 'Generazione suggerimenti AI basati su Clarity...');

        const clarityJson = JSON.stringify(result, null, 2);
        const messages = [
          {
            role: 'system',
            content: `Sei un esperto UX analyst per un sito web italiano (frontaliereticino.ch) dedicato ai lavoratori frontalieri Svizzera-Italia. Analizza i dati di Microsoft Clarity e fornisci suggerimenti concreti e azionabili per migliorare l'esperienza utente. Rispondi in italiano. Concentrati su:
1. Pagine con alta frizione (rage click, dead click) — cosa potrebbe causarli e come risolvere
2. Scroll depth basso — contenuti da riposizionare o riorganizzare
3. Quickback elevati — possibili problemi di contenuto o navigazione
4. Differenze tra dispositivi — ottimizzazioni mobile-specific
5. Errori script — priorità di fix
Fornisci max 5 suggerimenti, ognuno con: problema identificato, impatto stimato (alto/medio/basso), azione consigliata. Formato: elenco numerato conciso.`
          },
          {
            role: 'user',
            content: `Ecco i dati Clarity degli ultimi 3 giorni:\n\n${clarityJson}`
          }
        ];

        const aiResponse = await callLLM(messages, { maxTokens: 1000, temperature: 0.3 });
        if (aiResponse) {
          result.aiSuggestions = aiResponse;
          if (!flags.json) {
            log('', '');
            log('💡', 'Suggerimenti AI per migliorare la UX:');
            log('', '─'.repeat(50));
            // Print each line of the AI response
            aiResponse.split('\n').filter(l => l.trim()).forEach(line => {
              log('  ', line);
            });
            log('', '─'.repeat(50));
          }
        }
      }
    } catch (e) {
      log('⚠️', `AI suggestions: ${e.message}`);
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

// ═══════════════════════════════════════════════════════════
// 4. INDEXING STATUS (site:frontaliereticino.ch)
// ═══════════════════════════════════════════════════════════
async function reportIndexing(token, existingReport = {}) {
  log('', '');
  log('🔍', 'Stato indicizzazione Google (site:frontaliereticino.ch)');
  log('', '─'.repeat(50));

  const siteUrl = await detectSiteUrl(token);
  const encoded = encodeURIComponent(siteUrl);
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  const result = {};

  // ── 4a. Sitemaps status ─────────────────
  try {
    const res = await fetchRetry(
      `https://www.googleapis.com/webmasters/v3/sites/${encoded}/sitemaps`,
      { headers }
    );
    if (res.ok) {
      const data = await res.json();
      result.sitemaps = (data.sitemap || []).map(s => ({
        path: s.path,
        lastSubmitted: s.lastSubmitted,
        lastDownloaded: s.lastDownloaded,
        isPending: s.isPending,
        warnings: parseInt(s.warnings || '0'),
        errors: parseInt(s.errors || '0'),
        contents: (s.contents || []).map(c => ({
          type: c.type,
          submitted: parseInt(c.submitted || '0'),
          indexed: parseInt(c.indexed || '0'),
        })),
      }));

      if (!flags.json && result.sitemaps.length > 0) {
        log('🗺️', 'Stato Sitemap:');
        let totalSubmitted = 0, totalIndexed = 0;
        for (const sm of result.sitemaps) {
          const name = sm.path.replace(SITE_URL + '/', '');
          for (const c of sm.contents) {
            totalSubmitted += c.submitted;
            totalIndexed += c.indexed;
            log('', `  ${name.padEnd(30)} Inviate: ${String(c.submitted).padStart(5)}  Indicizzate: ${String(c.indexed).padStart(5)}`);
          }
          if (sm.errors > 0) log('❌', `    Errori: ${sm.errors}`);
          if (sm.warnings > 0) log('⚠️', `    Avvisi: ${sm.warnings}`);
        }
        log('', '');
        const indexRate = totalSubmitted > 0 ? ((totalIndexed / totalSubmitted) * 100).toFixed(1) : '0.0';
        log('📊', `  Totale: ${totalSubmitted} URL inviate, ${totalIndexed} indicizzate (${indexRate}%)`);
      }
    } else {
      log('⚠️', `Sitemaps API: HTTP ${res.status}`);
    }
  } catch (e) { log('⚠️', `Sitemaps: ${e.message}`); }

  // ── 4b. URL Inspection (key pages + dynamic top GSC pages) ──────
  const staticPages = [
    '/',
    '/calcola-stipendio',
    '/compara-servizi',
    '/guida-frontaliere',
    '/tasse-e-pensione',
    '/vivere-in-ticino',
    '/statistiche',
    '/articoli-frontaliere',
    '/domande-frequenti-frontalieri',
    '/mappa-del-sito',
    '/compara-servizi/cambio-franco-euro',
    '/compara-servizi/confronta-casse-malati',
    '/compara-servizi/confronta-banche',
    '/guida-frontaliere/primo-giorno-lavoro',
    '/tasse-e-pensione/calcola-previdenza',
    '/calcola-stipendio/simula-busta-paga',
    '/buongiorno-frontaliere',
    '/calcola-stipendio/stipendio-netto-80000-chf',
    '/calcola-stipendio/stipendio-netto-80000-chf-residenza-entro-20km',
    '/calcola-stipendio/stipendio-netto-80000-chf-residenza-oltre-20km',
    '/cerca-lavoro-ticino',
  ];

  // Dynamically add top GSC pages not already in the static list
  const staticSet = new Set(staticPages);
  const gscTopPaths = (existingReport.searchConsole?.topPages || [])
    .map(p => {
      try { return new URL(p.page).pathname.replace(/\/$/, '') || '/'; } catch { return null; }
    })
    .filter(p => p && !staticSet.has(p));

  const keyPages = [...staticPages, ...gscTopPaths.slice(0, 10)];

  result.urlInspection = [];
  let indexed = 0, notIndexed = 0, inspectErrors = 0;

  log('', '');
  log('🔎', `Ispezione URL (${keyPages.length} pagine chiave):`);

  for (const path of keyPages) {
    try {
      const res = await fetchRetry(
        'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect',
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            inspectionUrl: normalizeInspectionUrl(`${SITE_URL}${path}`),
            siteUrl: siteUrl,
          }),
        }
      );

      if (res.ok) {
        const data = await res.json();
        const ir = data.inspectionResult?.indexStatusResult;
        const status = {
          url: path,
          verdict: ir?.verdict || 'UNKNOWN',
          coverageState: ir?.coverageState || 'Unknown',
          indexingState: ir?.indexingState || 'UNKNOWN',
          lastCrawlTime: ir?.lastCrawlTime || null,
          pageFetchState: ir?.pageFetchState || 'UNKNOWN',
          robotsTxtState: ir?.robotsTxtState || 'UNKNOWN',
        };

        result.urlInspection.push(status);

        const isIndexed = status.verdict === 'PASS';
        if (isIndexed) indexed++; else notIndexed++;

        if (!flags.json) {
          const icon = isIndexed ? '✅' : status.verdict === 'NEUTRAL' ? '🟡' : '❌';
          const crawlDate = status.lastCrawlTime
            ? new Date(status.lastCrawlTime).toISOString().split('T')[0]
            : 'mai';
          log('', `  ${icon} ${path.padEnd(55)} ${status.coverageState.slice(0, 35).padEnd(37)} Crawl: ${crawlDate}`);
        }
      } else if (res.status === 429) {
        log('⚠️', `  ⏳ ${path} — Rate limit, attendo...`);
        await sleep(5000);
        inspectErrors++;
      } else {
        const text = await res.text();
        log('⚠️', `  ${path}: HTTP ${res.status} — ${text.slice(0, 100)}`);
        inspectErrors++;
      }

      // Rate limit: max 600/day, ~1 req/s is safe
      await sleep(1200);
    } catch (e) {
      inspectErrors++;
      log('⚠️', `  ${path}: ${e.message}`);
    }
  }

  result.summary = {
    total: keyPages.length,
    indexed,
    notIndexed,
    errors: inspectErrors,
  };

  if (!flags.json) {
    log('', '');
    log('📊', `Riepilogo indicizzazione: ${indexed}/${keyPages.length} indicizzate, ${notIndexed} non indicizzate${inspectErrors > 0 ? `, ${inspectErrors} errori` : ''}`);
    if (notIndexed > 0) {
      log('💡', 'Pagine non indicizzate → richiedere indicizzazione via Google Search Console');
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════
async function main() {
  const report = {
    generated: new Date().toISOString(),
    site: SITE_URL,
    period: `${DAYS} giorni`,
  };

  if (!flags.json) {
    console.log('');
    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║   📊  Frontaliere Ticino — Analytics Report     ║');
    console.log(`║   📅  Periodo: ultimi ${String(DAYS).padEnd(3)} giorni               ║`);
    console.log('╚══════════════════════════════════════════════════╝');
    console.log('');
  }

  // Auth (needed for GSC and GA4)
  let token = null;
  if (runAll || flags.gsc || flags.ga4) {
    try {
      token = await getAccessToken();
      if (token) {
        log('🔑', 'OAuth2 autenticato');
      } else {
        log('ℹ️', 'Credenziali OAuth2 non configurate — skip GSC e GA4');
      }
    } catch (e) {
      log('❌', `Auth fallita: ${e.message}`);
    }
  }

  // 1. Search Console
  if ((runAll || flags.gsc) && token) {
    try {
      report.searchConsole = await reportGSC(token);
    } catch (e) {
      log('❌', `GSC report fallito: ${e.message}`);
    }
  }

  // 2. PageSpeed
  if (runAll || flags.pagespeed) {
    try {
      report.pageSpeed = await reportPageSpeed();
    } catch (e) {
      log('❌', `PageSpeed report fallito: ${e.message}`);
    }
  }

  // 3. GA4
  if ((runAll || flags.ga4) && token) {
    try {
      report.ga4 = await reportGA4(token);
    } catch (e) {
      log('❌', `GA4 report fallito: ${e.message}`);
    }
  }

  // 3b. SEO SERP A/B test summary (uses GA4 + local autopilot history)
  try {
    report.seoSerpAB = reportSeoSerpABTest(report);
  } catch (e) {
    log('⚠️', `SEO SERP A/B summary: ${e.message}`);
  }

  // 3c. CrUX API — Real-world Core Web Vitals (28-day aggregation)
  if (runAll || flags.pagespeed) {
    try {
      const cruxApiKey = process.env.PAGESPEED_API_KEY;
      if (cruxApiKey) {
        log('', '');
        log('📊', 'CrUX — Core Web Vitals reali (dati campo, 28 giorni):');
        const cruxRes = await fetchRetry(
          `https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=${cruxApiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ origin: SITE_URL }),
          }
        );

        if (cruxRes.ok) {
          const cruxData = await cruxRes.json();
          const metrics = cruxData.record?.metrics || {};
          report.crux = {};

          for (const [key, data] of Object.entries(metrics)) {
            const p75 = data.percentiles?.p75;
            const hist = data.histogram || [];
            const good = hist[0]?.density || 0;
            const ni = hist[1]?.density || 0;
            const poor = hist[2]?.density || 0;

            report.crux[key] = { p75, good, needsImprovement: ni, poor };

            if (!flags.json) {
              const goodPct = (good * 100).toFixed(0);
              const poorPct = (poor * 100).toFixed(0);
              const emoji = parseFloat(goodPct) >= 75 ? '🟢' : parseFloat(poorPct) >= 25 ? '🔴' : '🟡';
              log('', `  ${emoji} ${key.padEnd(35)} p75: ${String(p75).padStart(8)}  Good: ${goodPct}%  Poor: ${poorPct}%`);
            }
          }
        } else if (cruxRes.status === 404) {
          log('ℹ️', '  CrUX: nessun dato disponibile (sito troppo nuovo o traffico insufficiente)');
          report.crux = { status: 'no_data' };
        } else {
          log('⚠️', `  CrUX API: HTTP ${cruxRes.status}`);
        }

        // Per-page CrUX for key pages (helps identify which pages drag down scores)
        const cruxPages = ['/', '/calcola-stipendio', '/compara-servizi', '/articoli-frontaliere', '/cerca-lavoro-ticino'];
        report.cruxPages = {};
        log('', '');
        log('📊', 'CrUX per-page breakdown:');
        for (const pagePath of cruxPages) {
          try {
            const pageRes = await fetchRetry(
              `https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=${cruxApiKey}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: `${SITE_URL}${pagePath}` }),
              }
            );
            if (pageRes.ok) {
              const pageData = await pageRes.json();
              const pageMetrics = pageData.record?.metrics || {};
              report.cruxPages[pagePath] = {};
              const parts = [];
              for (const [key, data] of Object.entries(pageMetrics)) {
                const p75 = data.percentiles?.p75;
                const good = (data.histogram?.[0]?.density || 0) * 100;
                const poor = (data.histogram?.[2]?.density || 0) * 100;
                report.cruxPages[pagePath][key] = { p75, good: good.toFixed(0), poor: poor.toFixed(0) };
                if (['largest_contentful_paint', 'interaction_to_next_paint', 'cumulative_layout_shift'].includes(key)) {
                  const emoji = good >= 75 ? '🟢' : poor >= 25 ? '🔴' : '🟡';
                  parts.push(`${emoji}${key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).slice(0, 3)}:${p75}`);
                }
              }
              if (!flags.json && parts.length > 0) {
                log('', `  ${pagePath.padEnd(40)} ${parts.join('  ')}`);
              }
            } else if (pageRes.status !== 404) {
              log('⚠️', `  ${pagePath}: HTTP ${pageRes.status}`);
            }
            await sleep(200); // Respect rate limits
          } catch (e) { /* skip individual page errors */ }
        }
      }
    } catch (e) {
      log('⚠️', `CrUX: ${e.message}`);
    }
  }

  // 4. Indexing status
  if ((runAll || flags.indexing) && token) {
    try {
      report.indexing = await reportIndexing(token, report);
    } catch (e) {
      log('❌', `Indexing report fallito: ${e.message}`);
    }
  }

  // 4b. Bing Webmaster Tools
  if (runAll || flags.bing) {
    try {
      const bingResult = await reportBing();
      if (bingResult) report.bing = bingResult;
    } catch (e) {
      log('⚠️', `Bing report fallito: ${e.message}`);
    }
  }

  // 5. Microsoft Clarity — Behavior Analytics
  if (runAll || flags.clarity) {
    try {
      const clarityResult = await reportClarity();
      if (clarityResult) report.clarity = clarityResult;
    } catch (e) {
      log('⚠️', `Clarity report fallito: ${e.message}`);
    }
  }

  // 5. Historical comparison with previous report
  try {
    const reportsDir = resolve(__dirname, '..', 'reports');
    if (existsSync(reportsDir)) {
      const files = readdirSync(reportsDir)
        .filter(f => f.startsWith('analytics-') && f.endsWith('.json') && f !== 'analytics-latest.json')
        .sort()
        .reverse();
      if (files.length > 0) {
        const prevReport = readJsonSafe(resolve(reportsDir, files[0]));
        if (prevReport) {
          const deltas = {};

          // GSC deltas
          if (report.searchConsole?.summary && prevReport.searchConsole?.summary) {
            const cur = report.searchConsole.summary;
            const prev = prevReport.searchConsole.summary;
            deltas.searchConsole = {
              clicks: { current: cur.totalClicks, previous: prev.totalClicks, change: cur.totalClicks - prev.totalClicks },
              impressions: { current: cur.totalImpressions, previous: prev.totalImpressions, change: cur.totalImpressions - prev.totalImpressions },
              ctr: { current: cur.avgCtr, previous: prev.avgCtr, change: parseFloat((cur.avgCtr - prev.avgCtr).toFixed(2)) },
              position: { current: cur.avgPosition, previous: prev.avgPosition, change: parseFloat((cur.avgPosition - prev.avgPosition).toFixed(1)) },
            };
          }

          // GA4 deltas
          const curGa4 = report.ga4?.summary || report.ga4?.overview;
          const prevGa4 = prevReport.ga4?.summary || prevReport.ga4?.overview;
          if (curGa4 && prevGa4) {
            const cur = curGa4;
            const prev = prevGa4;
            deltas.ga4 = {
              sessions: { current: cur.sessions, previous: prev.sessions, change: cur.sessions - prev.sessions },
              users: { current: cur.users, previous: prev.users, change: cur.users - prev.users },
              bounceRate: { current: cur.bounceRate, previous: prev.bounceRate, change: parseFloat(((cur.bounceRate || 0) - (prev.bounceRate || 0)).toFixed(1)) },
            };
          }

          // Indexing deltas
          if (report.indexing?.summary && prevReport.indexing?.summary) {
            const cur = report.indexing.summary;
            const prev = prevReport.indexing.summary;
            deltas.indexing = {
              indexed: { current: cur.indexed, previous: prev.indexed, change: cur.indexed - prev.indexed },
              total: { current: cur.total, previous: prev.total, change: cur.total - prev.total },
            };
          }

          // Clarity deltas
          if (report.clarity?.overview && prevReport.clarity?.overview) {
            const cur = report.clarity.overview;
            const prev = prevReport.clarity.overview;
            deltas.clarity = {
              sessions: { current: cur.totalSessions, previous: prev.totalSessions, change: cur.totalSessions - prev.totalSessions },
              users: { current: cur.distinctUsers, previous: prev.distinctUsers, change: cur.distinctUsers - prev.distinctUsers },
            };
            if (report.clarity?.friction && prevReport.clarity?.friction) {
              deltas.clarity.rageClicks = {
                current: report.clarity.friction.rageClicks ?? 0,
                previous: prevReport.clarity.friction.rageClicks ?? 0,
                change: (report.clarity.friction.rageClicks ?? 0) - (prevReport.clarity.friction.rageClicks ?? 0),
              };
              deltas.clarity.deadClicks = {
                current: report.clarity.friction.deadClicks ?? 0,
                previous: prevReport.clarity.friction.deadClicks ?? 0,
                change: (report.clarity.friction.deadClicks ?? 0) - (prevReport.clarity.friction.deadClicks ?? 0),
              };
            }
          }

          if (Object.keys(deltas).length > 0) {
            report.historical = {
              previousReport: files[0],
              previousDate: prevReport.generated,
              deltas,
            };

            if (!flags.json) {
              log('', '');
              log('📈', `Confronto con report precedente (${files[0]}):`);
              if (deltas.searchConsole) {
                const d = deltas.searchConsole;
                const arrow = (v) => v > 0 ? '↑' : v < 0 ? '↓' : '→';
                log('', `  GSC: Click ${arrow(d.clicks.change)}${Math.abs(d.clicks.change)} | Impression ${arrow(d.impressions.change)}${fmtNum(Math.abs(d.impressions.change))} | CTR ${arrow(d.ctr.change)}${Math.abs(d.ctr.change)}% | Pos ${arrow(-d.position.change)}${Math.abs(d.position.change)}`);
              }
              if (deltas.ga4) {
                const d = deltas.ga4;
                const arrow = (v) => v > 0 ? '↑' : v < 0 ? '↓' : '→';
                log('', `  GA4: Sessioni ${arrow(d.sessions.change)}${Math.abs(d.sessions.change)} | Utenti ${arrow(d.users.change)}${Math.abs(d.users.change)} | Bounce ${arrow(-d.bounceRate.change)}${Math.abs(d.bounceRate.change)}%`);
              }
              if (deltas.indexing) {
                const d = deltas.indexing;
                const arrow = (v) => v > 0 ? '↑' : v < 0 ? '↓' : '→';
                log('', `  Indicizzazione: ${arrow(d.indexed.change)}${Math.abs(d.indexed.change)} pagine (${d.indexed.current}/${d.total.current})`);
              }
              if (deltas.clarity) {
                const d = deltas.clarity;
                const arrow = (v) => v > 0 ? '↑' : v < 0 ? '↓' : '→';
                const parts = [`Sessioni ${arrow(d.sessions.change)}${Math.abs(d.sessions.change)}`];
                if (d.rageClicks) parts.push(`Rage ${arrow(-d.rageClicks.change)}${Math.abs(d.rageClicks.change)}`);
                if (d.deadClicks) parts.push(`Dead ${arrow(-d.deadClicks.change)}${Math.abs(d.deadClicks.change)}`);
                log('', `  Clarity: ${parts.join(' | ')}`);
              }
            }
          }
        }
      }
    }
  } catch (e) { log('⚠️', `Confronto storico: ${e.message}`); }

  // Weekly SEO insights (for CTR-focused iteration)
  if (!flags.json && report.searchConsole?.topPages) {
    const opportunities = getCtrOpportunities(report.searchConsole.topPages);
    log('', '');
    log('🎯', 'Opportunita CTR SERP (impression alte, CTR basso):');
    if (opportunities.length === 0) {
      log('', '  Nessuna pagina critica rilevata con la soglia attuale.');
    } else {
      for (const page of opportunities) {
        log('', `  ${page.page.padEnd(58)} CTR ${String(page.ctr).padStart(4)}% | Impr ${fmtNum(page.impressions).padStart(8)} | Pos ${page.position}`);
      }
      log('💡', '  Suggerimento: applicare variant "year_intent" o "intent_simulation" via Firebase Remote Config.');
    }
  }

  // Quick wins — queries on positions 4-20 with high impressions (close to page 1)
  if (!flags.json && report.searchConsole?.topQueries) {
    const quickWins = report.searchConsole.topQueries
      .filter(q => q.position >= 4 && q.position <= 20 && q.impressions >= 30)
      .sort((a, b) => a.position - b.position)
      .slice(0, 10);

    if (quickWins.length > 0) {
      log('', '');
      log('🚀', 'Quick wins — query vicine a pagina 1 (pos 4-20, impression ≥30):');
      for (const q of quickWins) {
        log('', `  ${q.query.padEnd(45)} Pos ${String(q.position).padStart(5)} | Impr ${fmtNum(q.impressions).padStart(6)} | CTR ${String(q.ctr).padStart(5)}% | Click ${q.clicks}`);
      }
      log('💡', '  Migliorare contenuto e link interni per queste query per salire in pagina 1.');
    }
  }

  // Output JSON if requested
  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
  }

  // Save to file if requested
  if (flags.save) {
    const reportsDir = resolve(__dirname, '..', 'reports');
    mkdirSync(reportsDir, { recursive: true });
    const json = JSON.stringify(report, null, 2);
    const snapshot = JSON.stringify(buildAnalyticsSnapshot(report), null, 2);
    const filename = `analytics-${fmtDate(new Date())}.json`;
    const filepath = resolve(reportsDir, filename);
    writeFileSync(filepath, json);
    // Also write analytics-latest.json for CI workflow consumption
    const latestPath = resolve(reportsDir, 'analytics-latest.json');
    writeFileSync(latestPath, json);
    writeFileSync(resolve(reportsDir, 'analytics-snapshot-latest.json'), snapshot);
    log('💾', `Report salvato: reports/${filename} + reports/analytics-latest.json + reports/analytics-snapshot-latest.json`);
  }

  if (!flags.json) {
    console.log('');
    log('✅', 'Report completato');
    console.log('');
  }

  process.exit(0);
}

main();
