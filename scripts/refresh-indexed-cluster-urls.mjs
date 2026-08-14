#!/usr/bin/env node
/**
 * Refresh data/indexed-cluster-urls.json — the union of related-search cluster
 * URL paths that any traffic source reports as still active under a NON-canonical
 * (non-aggregator) section. Sourced from:
 *   1. Google Search Console (impressions)
 *   2. Google Analytics 4 (pageviews)
 *   3. PostHog (pageviews)
 *
 * Background:
 *   `build-plugins/relatedSearchClustersPlugin.ts` canonicalizes every cluster
 *   under the Switzerland-wide aggregator section
 *   (`/cerca-lavoro-svizzera/ricerca-{slug}/` and per-locale equivalents) since
 *   PR #704. Per-canton URLs Google had crawled before that refactor are kept
 *   alive as byte-identical mirrors at TI + the legacy top-match canton by
 *   default. This script extends the mirror set with EVERY cluster URL that
 *   any traffic source reports as still receiving impressions / views — so
 *   sections beyond TI + legacyCanton (e.g. /cerca-lavoro-zurigo/ricerca-...
 *   that Google indexed back when the top-match was elsewhere) stay 200 OK
 *   instead of 404 once their canton stops being the build-time pin.
 *
 * Auth:
 *   - GSC: Firebase Service Account
 *   - GA4: GA4_PROPERTY_ID env + GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_JSON
 *   - PostHog: POSTHOG_PERSONAL_API_KEY + POSTHOG_PROJECT_ID env
 *
 *   Missing sources are silently skipped (best-effort union — mirrors the
 *   refresh-noslash-keep.mjs sibling).
 *
 * Output (data/indexed-cluster-urls.json):
 *   {
 *     "refreshedAt": "2026-05-28T...",
 *     "lookbackDays": 90,
 *     "minImpressions": 1,
 *     "sources": {
 *       "gsc":     { "ok": true,  "rowsScanned": 12000, "clusterSeen": 580, "kept": 412 },
 *       "ga4":     { "ok": false, "reason": "missing creds" },
 *       "posthog": { "ok": false, "reason": "missing creds" }
 *     },
 *     "indexedCount": 412,
 *     "indexedPaths": [ "/cerca-lavoro-zurigo/ricerca-data-center-technician/", ... ]
 *   }
 *
 * Usage:
 *   node scripts/refresh-indexed-cluster-urls.mjs                # 90 days, threshold 1
 *   node scripts/refresh-indexed-cluster-urls.mjs --days 180
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { checkPostHogLiveness } from './lib/source-liveness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_PATH = path.join(ROOT, 'data', 'indexed-cluster-urls.json');
const SITE = 'sc-domain:frontaliereticino.ch';

const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
}
const days = parseInt(arg('--days', '90'), 10);
const minImpressions = parseInt(arg('--min-impressions', '1'), 10);

// Match cluster-page paths under a NON-aggregator section. Captures:
//   group 1: optional locale prefix (en|de|fr) — IT has no prefix
//   group 2: canton section slug (cerca-lavoro-{canton} / find-jobs-{canton} /
//            jobs-im-{canton} / jobs-in-{canton} / trouver-emploi-{canton})
//   group 3: cluster slug (ricerca-... / search-... / suche-... / recherche-...)
// The svizzera/switzerland/schweiz/suisse aggregator sections are explicitly
// excluded — those URLs ARE the canonical and don't need a mirror.
const CLUSTER_PATH_RX = /^\/(?:(en|de|fr)\/)?((?:cerca-lavoro|find-jobs|jobs-im|jobs-in|jobs-in-der|trouver-emploi)-(?!svizzera\/|switzerland\/|schweiz\/|suisse\/)[a-z-]+)\/((?:ricerca|search|suche|recherche)-[a-z0-9-]+)\/?$/i;

function loadServiceAccount() {
  const envPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (envPath && fs.existsSync(envPath)) {
    return JSON.parse(fs.readFileSync(envPath, 'utf8'));
  }
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  }
  const local = path.join(ROOT, 'mcp-gsc-main', 'service_account_credentials.json');
  if (fs.existsSync(local)) {
    return JSON.parse(fs.readFileSync(local, 'utf8'));
  }
  return null;
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function getAccessToken(sa, scopes) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT', kid: sa.private_key_id };
  const claims = {
    iss: sa.client_email,
    scope: scopes,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const jwt = `${unsigned}.${base64url(signer.sign(sa.private_key))}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status}`);
  const data = await res.json();
  if (!data.access_token) throw new Error('no access_token');
  return data.access_token;
}

function pathFromUrl(u) {
  try {
    return new URL(u).pathname;
  } catch {
    if (typeof u === 'string' && u.startsWith('/')) return u;
    return null;
  }
}

// Canonicalize cluster path: ensure trailing slash, lowercase. Returns the
// normalized path on match, null otherwise. Filters out svizzera/aggregator
// variants (those ARE the canonical and don't need a mirror).
function normalizeClusterPath(p) {
  if (!p) return null;
  const trimmed = p.endsWith('/') ? p : `${p}/`;
  const lower = trimmed.toLowerCase();
  if (!CLUSTER_PATH_RX.test(lower)) return null;
  return lower;
}

async function fetchGsc(sa, startDate, endDate) {
  const token = await getAccessToken(sa, 'https://www.googleapis.com/auth/webmasters.readonly');
  const rows = [];
  let startRow = 0;
  for (let i = 0; i < 10; i++) {
    const body = { startDate, endDate, dimensions: ['page'], rowLimit: 25000, startRow, type: 'web' };
    const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(SITE)}/searchAnalytics/query`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`GSC ${res.status}: ${await res.text()}`);
    const data = await res.json();
    if (!data.rows || data.rows.length === 0) break;
    rows.push(...data.rows);
    if (data.rows.length < 25000) break;
    startRow += data.rows.length;
  }
  return rows;
}

async function fetchGa4(sa, startDate, endDate) {
  const propertyIdRaw = process.env.GA4_PROPERTY_ID;
  if (!propertyIdRaw) throw new Error('GA4_PROPERTY_ID unset');
  const propertyId = propertyIdRaw.startsWith('properties/') ? propertyIdRaw : `properties/${propertyIdRaw}`;
  const token = await getAccessToken(sa, 'https://www.googleapis.com/auth/analytics.readonly');
  const url = `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: 'pagePath' }],
      metrics: [{ name: 'screenPageViews' }],
      limit: 100000,
    }),
  });
  if (!res.ok) throw new Error(`GA4 ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.rows || []).map((r) => ({
    path: r.dimensionValues?.[0]?.value || '',
    views: parseInt(r.metricValues?.[0]?.value || '0', 10),
  }));
}

async function fetchPosthog(startDate, endDate) {
  const apiKey = process.env.POSTHOG_PERSONAL_API_KEY;
  const projectId = process.env.POSTHOG_PROJECT_ID;
  const host = (process.env.POSTHOG_HOST || 'https://eu.posthog.com').replace(/\/$/, '');
  if (!apiKey || !projectId) throw new Error('POSTHOG_PERSONAL_API_KEY/POSTHOG_PROJECT_ID unset');
  // Restrict to cluster prefixes (ricerca/search/suche/recherche) under any
  // job-section root, so the HogQL query stays under PostHog's 60s timeout
  // on the full pageview firehose.
  const query = `
    SELECT properties.$pathname AS path, count() AS views
    FROM events
    WHERE event = '$pageview'
      AND properties.$pathname IS NOT NULL
      AND (
        properties.$pathname LIKE '/cerca-lavoro-%/ricerca-%'
        OR properties.$pathname LIKE '/en/find-jobs-%/search-%'
        OR properties.$pathname LIKE '/de/jobs-im-%/suche-%'
        OR properties.$pathname LIKE '/de/jobs-in-%/suche-%'
        OR properties.$pathname LIKE '/fr/trouver-emploi-%/recherche-%'
      )
      AND timestamp >= toDateTime('${startDate} 00:00:00')
      AND timestamp <= toDateTime('${endDate} 23:59:59')
    GROUP BY path
    LIMIT 10000
  `.trim();
  const url = `${host}/api/projects/${projectId}/query/`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
  });
  if (!res.ok) throw new Error(`PostHog ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.results || []).map((row) => ({ path: row[0], views: row[1] }));
}

async function main() {
  const today = new Date();
  const endDate = today.toISOString().slice(0, 10);
  const startD = new Date(today);
  startD.setDate(startD.getDate() - days);
  const startDate = startD.toISOString().slice(0, 10);

  console.error(`[indexed-cluster-urls] lookback ${startDate} → ${endDate} (${days} days), min impressions/views = ${minImpressions}`);

  const indexed = new Set();
  const sources = { gsc: { ok: false }, ga4: { ok: false }, posthog: { ok: false } };
  const sa = loadServiceAccount();

  // ─── GSC ───────────────────────────────────────────────────────────────
  if (sa) {
    try {
      const rows = await fetchGsc(sa, startDate, endDate);
      let clusterSeen = 0, kept = 0;
      for (const row of rows) {
        const raw = pathFromUrl(row.keys?.[0]);
        const normalized = normalizeClusterPath(raw);
        if (!normalized) continue;
        clusterSeen += 1;
        if (row.impressions < minImpressions) continue;
        indexed.add(normalized);
        kept += 1;
      }
      sources.gsc = { ok: true, rowsScanned: rows.length, clusterSeen, kept };
      console.error(`[indexed-cluster-urls] GSC: ${kept} non-aggregator cluster paths kept from ${clusterSeen} cluster URLs (${rows.length} rows scanned)`);
    } catch (err) {
      sources.gsc = { ok: false, reason: err.message };
      console.error(`[indexed-cluster-urls] GSC: ${err.message}`);
    }
  } else {
    sources.gsc = { ok: false, reason: 'no service account' };
    console.error('[indexed-cluster-urls] GSC: no service account');
  }

  // ─── GA4 ───────────────────────────────────────────────────────────────
  if (sa && process.env.GA4_PROPERTY_ID) {
    try {
      const rows = await fetchGa4(sa, startDate, endDate);
      let clusterSeen = 0, kept = 0;
      for (const row of rows) {
        const normalized = normalizeClusterPath(row.path);
        if (!normalized) continue;
        clusterSeen += 1;
        if (row.views < minImpressions) continue;
        indexed.add(normalized);
        kept += 1;
      }
      sources.ga4 = { ok: true, rowsScanned: rows.length, clusterSeen, kept };
      console.error(`[indexed-cluster-urls] GA4: ${kept} non-aggregator cluster paths kept from ${clusterSeen} cluster URLs (${rows.length} rows)`);
    } catch (err) {
      sources.ga4 = { ok: false, reason: err.message };
      console.error(`[indexed-cluster-urls] GA4: ${err.message}`);
    }
  } else {
    sources.ga4 = { ok: false, reason: 'missing GA4_PROPERTY_ID or service account' };
    console.error('[indexed-cluster-urls] GA4: skipped (missing credentials)');
  }

  // ─── PostHog ───────────────────────────────────────────────────────────
  if (process.env.POSTHOG_PERSONAL_API_KEY && process.env.POSTHOG_PROJECT_ID) {
    const liveness = await checkPostHogLiveness();
    if (!liveness.alive) {
      // A dead source answers HogQL with a successful empty result, which
      // used to be recorded as ok:true rowsScanned:0 — indistinguishable
      // from a real quiet day. Record it as unhealthy instead (issue #5881).
      sources.posthog = { ok: false, reason: `source not alive: ${liveness.reason}` };
      console.error(`[indexed-cluster-urls] PostHog: source not alive (${liveness.reason})`);
    } else {
      try {
        const rows = await fetchPosthog(startDate, endDate);
        let clusterSeen = 0, kept = 0;
        for (const row of rows) {
          const normalized = normalizeClusterPath(row.path);
          if (!normalized) continue;
          clusterSeen += 1;
          if (row.views < minImpressions) continue;
          indexed.add(normalized);
          kept += 1;
        }
        sources.posthog = { ok: true, rowsScanned: rows.length, clusterSeen, kept };
        console.error(`[indexed-cluster-urls] PostHog: ${kept} non-aggregator cluster paths kept from ${clusterSeen} cluster URLs (${rows.length} rows)`);
      } catch (err) {
        sources.posthog = { ok: false, reason: err.message };
        console.error(`[indexed-cluster-urls] PostHog: ${err.message}`);
      }
    }
  } else {
    sources.posthog = { ok: false, reason: 'missing POSTHOG_* env' };
    console.error('[indexed-cluster-urls] PostHog: skipped (missing credentials)');
  }

  // Merge previous indexed list so a temporarily-unavailable source can't
  // shrink the mirror set. Same UNION policy as refresh-noslash-keep.mjs:
  // paths only disappear when all sources agree they're dead AND we
  // re-publish the same file — for safety we keep them forever in the
  // current revision (cheap: file scales with traffic, not corpus).
  let prev = null;
  if (fs.existsSync(OUT_PATH)) {
    try {
      prev = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
    } catch {
      prev = null;
    }
  }
  if (prev && Array.isArray(prev.indexedPaths)) {
    for (const p of prev.indexedPaths) {
      const normalized = normalizeClusterPath(p);
      if (normalized) indexed.add(normalized);
    }
  }

  const indexedPaths = Array.from(indexed).sort();
  const output = {
    refreshedAt: new Date().toISOString(),
    lookbackDays: days,
    minImpressions,
    sources,
    indexedCount: indexedPaths.length,
    indexedPaths,
  };
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + '\n');
  console.error(`[indexed-cluster-urls] Wrote ${OUT_PATH} — ${indexedPaths.length} indexed cluster paths total (union of GSC/GA4/PostHog + previous list)`);
}

main().catch((err) => {
  console.error('[indexed-cluster-urls] Fatal:', err.message);
  process.exit(1);
});
