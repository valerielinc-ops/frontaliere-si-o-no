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
 * Strategy: rotate through the source-backed URL cohort produced by the GSC
 * Coverage ingest (`data/gsc-coverage-404s.json`) plus existing compatibility
 * paths that need a recovery check, inspecting a daily batch. For each URL
 * where Google reports NOT_FOUND / SOFT_404 / "Not found" coverage state,
 * append the path to the sharded compatibility store so the build pipeline can
 * generate a reconciled soft-landing or bridge page. The job-orphan URL
 * Inspection ledger is deliberately not a candidate source for this audit; it
 * is owned by `sync-gsc-orphans.mjs`.
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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertCompatFloor, COMPAT_PATHS_SANITY_FLOOR } from './lib/compat-paths-floor-guard.mjs';
import { readCompatPathsStrict, writeCompatPaths } from './lib/compat-paths-store.mjs';
import { gscCoveragePopulationSummary, readCanonicalGscCoverage } from './lib/gsc-coverage-population.mjs';
import { intFromEnv } from './lib/int-from-env.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SITE_URL = 'https://frontaliereticino.ch';
const INSPECTION_FETCH_TIMEOUT_MS = (() => {
  const value = Number(process.env.INSPECTION_FETCH_TIMEOUT_MS);
  if (!Number.isFinite(value) || value <= 0) return 30_000;
  return Math.min(Math.floor(value), 120_000);
})();

function fetchInspection(url, init = {}) {
  return fetch(url, {
    ...init,
    signal: AbortSignal.timeout(INSPECTION_FETCH_TIMEOUT_MS),
  });
}

const DRY_RUN = process.argv.includes('--dry-run');
// `intFromEnv` due volte, annidato: l'argomento di riga di comando ha
// esattamente la stessa classe di guasto della variabile d'ambiente (una
// stringa che puo' non essere un numero), quindi passa dallo stesso predicato
// invece di essere dato in pasto a `Number` cosi' com'e' — issue #7344.
const BATCH_SIZE = intFromEnv('BATCH_SIZE', intFromEnv('--batch-size', 1500, {
  env: { '--batch-size': (process.argv.find((a) => a.startsWith('--batch-size=')) || '').split('=')[1] },
}));
const MIN_AGE_DAYS = intFromEnv('MIN_AGE_DAYS', 14);
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
  const res = await fetchInspection('https://oauth2.googleapis.com/token', {
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
    const res = await fetchInspection('https://www.googleapis.com/webmasters/v3/sites', {
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
 * Candidate sources for this audit are the source-backed GSC Coverage snapshot
 * and the existing compatibility accumulator, so recovered compat-only paths
 * can be cleaned up. In particular, do not expand job registries or public
 * assembled datasets here: those are a different orphan-job cohort.
 */
export function collectCandidatePaths(
  population = readCanonicalGscCoverage(ROOT),
  compatPaths = [],
) {
  return [...new Set([...population.paths, ...compatPaths])];
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

export function applyInspectionResult(compatSet, p, result) {
  const is404 = isNotFoundResult(result);
  if (is404 && !compatSet.has(p)) {
    compatSet.add(p);
    return { newlyFound404: 1, clearedFromCompat: 0 };
  }
  if (!is404 && compatSet.has(p)) {
    // URL recovered (redirect, indexed, etc.) — safe to drop from compat.
    // The build pipeline will no longer generate a soft-landing for it,
    // which is correct because the path now resolves on its own.
    compatSet.delete(p);
    return { newlyFound404: 0, clearedFromCompat: 1 };
  }
  return { newlyFound404: 0, clearedFromCompat: 0 };
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

  const population = readCanonicalGscCoverage(ROOT);
  const populationSummary = gscCoveragePopulationSummary(population);
  console.log(`📚 Source-backed GSC Coverage cohort: ${populationSummary.sourceBacked} paths`);
  console.log(`🧭 Excluded unknown/ambiguous residue: ${populationSummary.unresolved}`);
  if (populationSummary.observedRows !== null) {
    console.log(`📐 GSC Coverage observed rows: ${populationSummary.observedRows}`);
  }

  // Existing compat paths are cleanup candidates too: a path can recover after
  // it was added to the accumulator and no longer appear in the current GSC
  // Coverage export. Keep the job-orphan ledger separate; it is owned by the
  // dedicated synchronizer.
  const compatPath = dataPath('seo-404-compat'); // sharded dir (issue #2988)
  const compat = readCompatPathsStrict(ROOT);

  // Collect candidate URLs and rank by "most in need of inspection"
  const candidates = collectCandidatePaths(population, compat.paths);
  console.log(`📦 Candidate URLs: ${candidates.length} (GSC cohort + compat cleanup)`);

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

  if (!compat.source) compat.source = 'gsc-export';
  if (!Array.isArray(compat.paths)) compat.paths = [];
  const compatSet = new Set(compat.paths);

  let inspected = 0;
  let newlyFound404 = 0;
  let clearedFromCompat = 0;
  let errors = 0;

  for (const { p } of ranked) {
    const inspectionUrl = `${SITE_URL}${p.startsWith('/') ? p : '/' + p}`;
    try {
      const res = await fetchInspection(
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
        source: 'gsc-coverage',
        lastInspected: new Date().toISOString(),
        verdict: result.verdict || '',
        coverageState: result.coverageState || '',
        pageFetchState: result.pageFetchState || '',
        is404,
      };

      const compatChanges = applyInspectionResult(compatSet, p, result);
      newlyFound404 += compatChanges.newlyFound404;
      clearedFromCompat += compatChanges.clearedFromCompat;

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
    // Floor-guard (2026-06-04, #404-truncation; #1353 shared helper): il compat
    // è un ACCUMULATORE (~300-650k path). Se la lettura iniziale (riga ~154) è
    // fallita con fallback `{paths:[]}` — es. file già toccato da un job
    // cancellato mid-write, o read race — `compatSet` parte vuoto e questo write
    // SOVRASCRIVE i 657k path buoni con poche migliaia → 404→301 resolver giù in
    // prod (osservato: commit 06546ba ha troncato 657594→0, main rosso, test
    // floor 150000 violato). Guard condiviso in scripts/lib/compat-paths-floor-guard.mjs
    // (stessa semantica per tutti i writer del compat): fire solo se il write
    // scende sotto floor MENTRE l'esistente è già grande. ABORTISCE rumorosamente.
    const prevCount = readCompatPathsStrict(ROOT).paths?.length ?? 0;
    try {
      assertCompatFloor(prevCount, updatedCompat.paths.length, {
        floor: COMPAT_PATHS_SANITY_FLOOR,
        label: compatPath,
      });
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    writeCompatPaths(updatedCompat, ROOT);
    console.log(`\n✅ Wrote ${compatPath} (${updatedCompat.paths.length} total paths)`);
  } else {
    console.log('\n✅ Inspection state updated (no compat changes)');
  }
}

if (process.argv[1] && (() => {
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})()) {
  main().catch((err) => {
    console.error('❌ Fatal:', err.message);
    process.exit(1);
  });
}
