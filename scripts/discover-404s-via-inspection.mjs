#!/usr/bin/env node
/**
 * discover-404s-via-inspection.mjs
 *
 * Proactive 404 discovery via the Google Search Console URL Inspection API.
 *
 * Problem: GSC does NOT expose the "Coverage → Not found (404)" report via
 * any public API. The Search Analytics API only returns URLs with ≥1 impression,
 * which misses zero-impression 404s. The only programmatic workaround is to
 * ask `urlInspection` about URLs we suspect.
 *
 * Strategy: rotate through our universe of known URLs (tracking + previous
 * slugs + compat paths), inspecting a daily batch. For each URL where Google
 * reports NOT_FOUND / SOFT_404 / "Not found" coverage state, append the path
 * to `data/seo-404-compat-paths.json` so the build pipeline generates a
 * reconciled soft-landing or bridge page at that URL.
 *
 * State is persisted in `data/inspection-state.json` (lastInspected per URL)
 * so successive runs rotate through the full universe without redoing URLs.
 *
 * Usage:
 *   node scripts/load-rc-env.mjs && node scripts/discover-404s-via-inspection.mjs
 *   node scripts/discover-404s-via-inspection.mjs --dry-run
 *   node scripts/discover-404s-via-inspection.mjs --batch-size=500
 *
 * Environment variables (required):
 *   GSC_CLIENT_ID, GSC_CLIENT_SECRET, GSC_REFRESH_TOKEN
 *
 * Optional env flags:
 *   BATCH_SIZE=1500          Number of URLs to inspect per run (quota budget)
 *   MIN_AGE_DAYS=14          Skip URLs inspected more recently than this
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SITE_URL = 'https://frontaliereticino.ch';

const DRY_RUN = process.argv.includes('--dry-run');
const BATCH_SIZE = Number(
  process.env.BATCH_SIZE ||
  (process.argv.find((a) => a.startsWith('--batch-size=')) || '').split('=')[1] ||
  1500,
);
const MIN_AGE_DAYS = Number(process.env.MIN_AGE_DAYS || 14);
const MIN_AGE_MS = MIN_AGE_DAYS * 24 * 60 * 60 * 1000;

const GSC_CLIENT_ID = process.env.GSC_CLIENT_ID || '';
const GSC_CLIENT_SECRET = process.env.GSC_CLIENT_SECRET || '';
const GSC_REFRESH_TOKEN = process.env.GSC_REFRESH_TOKEN || '';

const dataPath = (...p) => path.resolve(ROOT, 'data', ...p);
const readJsonSafe = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return fallback; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Load and refresh an OAuth2 access token using the stored refresh token. */
async function getAccessToken() {
  if (!GSC_CLIENT_ID || !GSC_CLIENT_SECRET || !GSC_REFRESH_TOKEN) {
    throw new Error('Missing GSC_CLIENT_ID, GSC_CLIENT_SECRET, or GSC_REFRESH_TOKEN');
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GSC_CLIENT_ID,
      client_secret: GSC_CLIENT_SECRET,
      refresh_token: GSC_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`OAuth token error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

/** Detect the registered GSC site property (prefers URL-prefix over domain-property). */
async function detectSiteProperty(accessToken) {
  try {
    const res = await fetch('https://www.googleapis.com/webmasters/v3/sites', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return SITE_URL;
    const data = await res.json();
    const sites = (data.siteEntry || []).map((s) => s.siteUrl);
    return sites.find((s) => s === SITE_URL || s === `${SITE_URL}/`)
      || sites.find((s) => typeof s === 'string' && s.includes('frontaliereticino'))
      || SITE_URL;
  } catch {
    return SITE_URL;
  }
}

/**
 * Build the candidate URL universe: paths that exist in our known tracking,
 * per-locale previous slugs, and the GSC-404 compat file. These are the URLs
 * we could conceivably receive 404 hits on — perfect candidates for status
 * verification via URL Inspection.
 */
function collectCandidatePaths() {
  const paths = new Set();
  const LOCALE_PREFIXES = {
    it: '/cerca-lavoro-ticino/',
    en: '/en/find-jobs-ticino/',
    de: '/de/jobs-im-tessin/',
    fr: '/fr/trouver-emploi-tessin/',
  };

  // 1. Active job tracking — paths for every (slug, locale) pair
  const tracking = readJsonSafe(dataPath('all-known-job-slugs.json'), {});
  for (const [, localePaths] of Object.entries(tracking)) {
    if (localePaths && typeof localePaths === 'object') {
      for (const p of Object.values(localePaths)) {
        if (typeof p === 'string' && p.startsWith('/')) paths.add(p.replace(/\/+$/, ''));
      }
    }
  }

  // 2. Active jobs: expand previousSlugsByLocale under every locale base URL
  // (covers cross-locale 404s where a historical slug was indexed under a
  // different locale prefix than it was generated for).
  const activeJobs = readJsonSafe(path.resolve(ROOT, 'public/data/jobs.json'), []);
  if (Array.isArray(activeJobs)) {
    for (const job of activeJobs) {
      const psBL = job && job.previousSlugsByLocale;
      if (!psBL || typeof psBL !== 'object') continue;
      for (const arr of Object.values(psBL)) {
        if (!Array.isArray(arr)) continue;
        for (const oldSlug of arr) {
          if (typeof oldSlug !== 'string' || !oldSlug) continue;
          for (const prefix of Object.values(LOCALE_PREFIXES)) {
            paths.add(`${prefix}${oldSlug}`.replace(/\/+$/, ''));
          }
        }
      }
      if (Array.isArray(job.previousSlugs)) {
        for (const oldSlug of job.previousSlugs) {
          if (typeof oldSlug !== 'string' || !oldSlug) continue;
          for (const prefix of Object.values(LOCALE_PREFIXES)) {
            paths.add(`${prefix}${oldSlug}`.replace(/\/+$/, ''));
          }
        }
      }
    }
  }

  // 3. Existing compat paths — they're already flagged, but re-inspecting
  // confirms Google still sees them as 404 (vs. recovered / redirected) and
  // captures any state changes.
  const compat = readJsonSafe(dataPath('seo-404-compat-paths.json'), { paths: [] });
  if (Array.isArray(compat.paths)) {
    for (const p of compat.paths) {
      if (typeof p === 'string' && p.startsWith('/')) paths.add(p.replace(/\/+$/, ''));
    }
  }

  return [...paths];
}

/**
 * Decide if an inspection response indicates a URL is effectively 404.
 * Checks both the structured `pageFetchState` (authoritative) and the
 * human-readable `coverageState` string (catches older / localized forms).
 */
function isNotFoundResult(result) {
  const pfs = String(result?.pageFetchState || '').toUpperCase();
  if (pfs === 'NOT_FOUND' || pfs === 'SOFT_404' || pfs === 'BLOCKED_4XX') return true;
  const cs = String(result?.coverageState || '').toLowerCase();
  if (cs.includes('not found') || cs.includes('404') || cs.includes('soft 404')) return true;
  return false;
}

async function main() {
  const startedAt = Date.now();
  console.log(`🔎 404 discovery via URL Inspection (batch=${BATCH_SIZE}, minAge=${MIN_AGE_DAYS}d${DRY_RUN ? ', dry-run' : ''})`);

  const accessToken = await getAccessToken();
  console.log('✅ OAuth token obtained');
  const siteProperty = await detectSiteProperty(accessToken);
  console.log(`📍 Site property: ${siteProperty}`);

  // Load state (per-URL lastInspected timestamp + last known 404 state)
  const statePath = dataPath('inspection-state.json');
  const state = readJsonSafe(statePath, { inspected: {} });
  if (!state.inspected || typeof state.inspected !== 'object') state.inspected = {};

  // Collect candidate URLs and rank by "most in need of inspection"
  const candidates = collectCandidatePaths();
  console.log(`📦 Candidate URLs: ${candidates.length}`);

  const now = Date.now();
  const ranked = candidates
    .map((p) => ({
      p,
      lastInspected: state.inspected[p]?.lastInspected
        ? new Date(state.inspected[p].lastInspected).getTime()
        : 0,
    }))
    .filter((c) => now - c.lastInspected >= MIN_AGE_MS)
    .sort((a, b) => a.lastInspected - b.lastInspected)
    .slice(0, BATCH_SIZE);

  console.log(`📋 Eligible (≥${MIN_AGE_DAYS}d since last check): ${ranked.length}`);

  if (ranked.length === 0) {
    console.log('✅ Nothing to do — all URLs are fresh.');
    return;
  }

  const compatPath = dataPath('seo-404-compat-paths.json');
  const compat = readJsonSafe(compatPath, { paths: [], source: 'gsc-export' });
  if (!Array.isArray(compat.paths)) compat.paths = [];
  const compatSet = new Set(compat.paths);

  let inspected = 0;
  let newlyFound404 = 0;
  let clearedFromCompat = 0;
  let errors = 0;

  for (const { p } of ranked) {
    const inspectionUrl = `${SITE_URL}${p.startsWith('/') ? p : '/' + p}`;
    try {
      const res = await fetch(
        'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ inspectionUrl, siteUrl: siteProperty }),
        },
      );

      if (res.status === 429) {
        console.warn('⚠️  Rate limited — stopping early and saving progress');
        break;
      }
      if (res.status === 403) {
        console.error('❌ Forbidden — stopping (auth or quota issue)');
        break;
      }
      if (!res.ok) {
        errors++;
        if (errors > 20) {
          console.warn('⚠️  Too many errors — stopping');
          break;
        }
        continue;
      }

      const data = await res.json();
      const result = data.inspectionResult?.indexStatusResult || {};
      const is404 = isNotFoundResult(result);

      state.inspected[p] = {
        lastInspected: new Date().toISOString(),
        verdict: result.verdict || '',
        coverageState: result.coverageState || '',
        pageFetchState: result.pageFetchState || '',
        is404,
      };

      if (is404 && !compatSet.has(p)) {
        compatSet.add(p);
        newlyFound404++;
      } else if (!is404 && compatSet.has(p)) {
        // URL recovered (redirect, indexed, etc.) — safe to drop from compat.
        // The build pipeline will no longer generate a soft-landing for it,
        // which is correct because the path now resolves on its own.
        compatSet.delete(p);
        clearedFromCompat++;
      }

      inspected++;
      if (inspected % 100 === 0) {
        console.log(`   … ${inspected}/${ranked.length} inspected (${newlyFound404} new 404s)`);
      }
      await sleep(500);
    } catch (err) {
      errors++;
      if (errors > 20) break;
    }
  }

  console.log(`\n📊 Results:`);
  console.log(`   Inspected:          ${inspected}`);
  console.log(`   New 404s added:     ${newlyFound404}`);
  console.log(`   Recovered (dropped): ${clearedFromCompat}`);
  console.log(`   Errors:             ${errors}`);
  console.log(`   Elapsed:            ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

  if (DRY_RUN) {
    console.log('\n🔍 Dry run — no files written');
    return;
  }

  // Persist state (always — captures what we inspected even if nothing changed)
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');

  if (newlyFound404 > 0 || clearedFromCompat > 0) {
    const updatedCompat = {
      ...compat,
      paths: [...compatSet].sort(),
      source: (compat.source || 'gsc-export').includes('url-inspection')
        ? compat.source
        : `${compat.source || 'gsc-export'}+url-inspection`,
      lastUpdated: new Date().toISOString().slice(0, 10),
    };
    fs.writeFileSync(compatPath, JSON.stringify(updatedCompat, null, 2) + '\n');
    console.log(`\n✅ Wrote ${compatPath} (${updatedCompat.paths.length} total paths)`);
  } else {
    console.log('\n✅ Inspection state updated (no compat changes)');
  }
}

main().catch((err) => {
  console.error('❌ Fatal:', err.message);
  process.exit(1);
});
