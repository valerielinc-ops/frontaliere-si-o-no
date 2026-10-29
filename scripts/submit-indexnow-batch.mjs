#!/usr/bin/env node
/**
 * IndexNow Batch Submission Script
 *
 * Submits ALL sitemap URLs to IndexNow for bulk indexation by Bing, Yandex,
 * and other IndexNow partners. Unlike submit-indexnow.js (which only submits
 * new/changed URLs per deploy), this script is designed for catch-up scenarios
 * where Bing has a large indexation backlog (e.g. 16k+ pages, 1-4 crawled/day).
 *
 * Features:
 * - Fetches all sub-sitemaps LIVE over HTTP from the deployed site (default)
 *   to collect every URL — no local build required. IndexNow tells engines
 *   to crawl live URLs, so the live sitemaps are the correct source of truth;
 *   reading them avoids a full `vite build` (~38 min, OOM-prone) just to
 *   regenerate XML the deploy already publishes. Pass --local to read from
 *   dist/ or public/ instead (e.g. when validating a not-yet-deployed build).
 * - Batches URLs in groups of 10,000 (IndexNow API limit)
 * - Submits to multiple IndexNow endpoints (api.indexnow.org, Bing, Yandex)
 * - Verifies the key file is accessible before submitting
 * - Retries failed submissions with exponential backoff
 * - Respects Retry-After headers on 429 responses
 * - Logs detailed results per endpoint
 * - Supports --dry-run flag to preview without submitting
 * - Supports --endpoint flag to target a single engine
 * - Supports --sitemap flag to limit to specific sub-sitemaps
 *
 * Usage:
 *   node scripts/submit-indexnow-batch.mjs                    # Submit all URLs to all engines
 *   node scripts/submit-indexnow-batch.mjs --dry-run          # Preview URLs without submitting
 *   node scripts/submit-indexnow-batch.mjs --endpoint bing    # Submit only to Bing
 *   node scripts/submit-indexnow-batch.mjs --sitemap jobs     # Only job sitemap URLs
 *   node scripts/submit-indexnow-batch.mjs --local            # Read sitemaps from dist/public, not live
 *
 * Environment:
 *   INDEXNOW_KEY (optional) — override the default key
 *   SITEMAP_BASE (optional) — override the live sitemap origin
 *                             (default https://frontaliereticino.ch)
 */

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { DEFAULT_LIVE_CHECK_USER_AGENT } from './lib/live-link-check.mjs';
import { INDEXNOW_SITEMAPS } from './submit-indexnow.js';
import {
  crawlSitemaps,
  filterSnapshot,
  snapshotFromCrawl,
  snapshotUrls,
} from './lib/sitemap-crawl.mjs';

// ── Configuration ─────────────────────────────────────────────
const DEFAULT_KEY = '39093e02a74b4a2dbf867c74bc53a7d8';
const INDEXNOW_KEY = process.env.INDEXNOW_KEY || DEFAULT_KEY;
const HOST = 'frontaliereticino.ch';
const KEY_LOCATION = `https://${HOST}/${INDEXNOW_KEY}.txt`;
const BATCH_SIZE = 10_000; // IndexNow API limit per request
const MAX_RETRIES = 3;
const INTER_BATCH_DELAY_MS = 1_500; // polite delay between batches

const ENDPOINTS = {
  indexnow: 'https://api.indexnow.org/indexnow',
  bing: 'https://www.bing.com/indexnow',
  yandex: 'https://yandex.com/indexnow',
};

export const SUB_SITEMAPS = [...INDEXNOW_SITEMAPS, 'sitemap-news.xml', 'sitemap-guides.xml'];

// Key pages that may not appear in sitemaps but should always be submitted
const EXTRA_URLS = [
  `https://${HOST}/`,
  `https://${HOST}/en/`,
  `https://${HOST}/de/`,
  `https://${HOST}/fr/`,
];

// ── CLI argument parsing ──────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const USE_LOCAL = args.includes('--local');
const endpointArg = args.find((_, i, a) => a[i - 1] === '--endpoint');
const sitemapFilters = args
  .flatMap((arg, index) => (arg === '--sitemap' ? [args[index + 1]] : []))
  .filter(Boolean);

// Live sitemap origin (default = deployed site). The sub-sitemaps are public
// XML, always reflecting the latest deploy, so the weekly catch-up can read
// them directly instead of rebuilding the site.
const SITEMAP_BASE = (process.env.SITEMAP_BASE || `https://${HOST}`).replace(/\/+$/, '');

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage: node scripts/submit-indexnow-batch.mjs [options]

Options:
  --dry-run              Preview URLs without submitting
  --endpoint <name>      Submit to a single engine: indexnow, bing, yandex
  --sitemap <filter>     Only include sitemaps matching this substring (e.g. "jobs", "blog")
  --local                Read sitemaps from dist/ or public/ instead of live HTTP
  --help, -h             Show this help message

Examples:
  node scripts/submit-indexnow-batch.mjs --dry-run
  node scripts/submit-indexnow-batch.mjs --endpoint bing
  node scripts/submit-indexnow-batch.mjs --sitemap jobs --endpoint bing
`);
  process.exit(0);
}

// ── Helpers ───────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getProjectRoot() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  return resolve(__dirname, '..');
}

// ── Extract URLs from one sitemap's XML into the accumulator ───
export function extractUrls(xml, urls) {
  let count = 0;
  for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    urls.add(m[1].trim());
    count++;
  }
  for (const m of xml.matchAll(/hreflang="[^"]*"\s+href="([^"]+)"/g)) {
    urls.add(m[1].trim());
    count++;
  }
  return count;
}

// ── Extract only hreflang alternate URLs into the accumulator ──
// Used by the public/-registry compensation pass below: the DEPLOYED
// sitemaps no longer carry xhtml:link annotations for one-sided hreflang
// groups (the build strips them per Google's sitemap-hreflang reciprocity
// rule — see build-plugins/sitemapAliasPlugin.ts, issue #3474), but the
// EN/DE/FR alternate pages are live and must keep receiving IndexNow
// submissions. The committed public/ sitemap sources keep the annotations
// as build metadata, so the locale URLs are read from there. <loc> truth
// stays with the live/dist sitemaps — only alternate hrefs are unioned.
export function extractAlternateUrls(xml, urls) {
  let count = 0;
  for (const m of xml.matchAll(/hreflang="[^"]*"\s+href="([^"]+)"/g)) {
    urls.add(m[1].trim());
    count++;
  }
  return count;
}

// ── Collect URLs from the complete sitemap graph ───────────────────────────
export async function getUrlsFromSitemaps({ fetchAttempts, fetchDelayMs } = {}) {
  const rootDir = getProjectRoot();
  const sitemapDir = existsSync(resolve(rootDir, 'dist', 'sitemap.xml'))
    ? resolve(rootDir, 'dist')
    : resolve(rootDir, 'public');
  let crawl;
  try {
    // The live root index and robots.txt are authoritative. Do not make a
    // historical filename list a required part of the live crawl: a producer
    // may retire/rename a sitemap while the root index is already correct.
    // Compatibility seeds are used only when an old local/root fixture is a
    // URL set rather than the generated master index.
    const graphSeeds = ['sitemap.xml', 'sitemap-news.xml', 'sitemap-cantons.xml'];
    crawl = await crawlSitemaps({
      host: HOST,
      baseUrl: SITEMAP_BASE,
      source: USE_LOCAL ? 'local' : 'live',
      rootDir: USE_LOCAL ? sitemapDir : undefined,
      seeds: graphSeeds,
      strict: !USE_LOCAL,
      ...(fetchAttempts === undefined ? {} : { fetchAttempts }),
      ...(fetchDelayMs === undefined ? {} : { fetchDelayMs }),
    });

    const rootRecord = crawl.records.get('sitemap.xml');
    if (!rootRecord || rootRecord.kind !== 'index') {
      crawl = await crawlSitemaps({
        host: HOST,
        baseUrl: SITEMAP_BASE,
        source: USE_LOCAL ? 'local' : 'live',
        rootDir: USE_LOCAL ? sitemapDir : undefined,
        seeds: [...new Set([...graphSeeds, ...SUB_SITEMAPS])],
        strict: !USE_LOCAL,
        ...(fetchAttempts === undefined ? {} : { fetchAttempts }),
        ...(fetchDelayMs === undefined ? {} : { fetchDelayMs }),
      });
    }
  } catch (error) {
    console.error(`Failed to crawl the sitemap graph from ${SITEMAP_BASE}: ${error.message}`);
    process.exit(1);
    throw error;
  }

  let snapshot = snapshotFromCrawl(crawl);
  if (sitemapFilters.length > 0) {
    const expandedFilters = sitemapFilters.flatMap((filter) =>
      String(filter).toLowerCase() === 'article' ? ['article', 'blog', 'news'] : [filter]);
    snapshot = filterSnapshot(snapshot, expandedFilters);
    if (snapshot.sitemapFiles.length === 0) {
      console.error(`No sitemap matches filter(s) "${sitemapFilters.join(', ')}".`);
      process.exit(1);
      throw new Error('No sitemap filter match');
    }
  }

  const empty = [...crawl.records.values()]
    .filter((record) => record.kind === 'urlset' && record.urls.length === 0)
    .map((record) => record.key)
    .sort();
  if (empty.length > 0) {
    console.warn(`  ⚠️  ${empty.length} sitemap(s) returned 200 but 0 URLs: ${empty.join(', ')} — verify this is expected.`);
  }
  for (const [file, urls] of Object.entries(snapshot.perSitemap)) {
    console.log(`  ${file}: ${urls.length} URLs (${snapshotUrls(snapshot).size} unique total)`);
  }
  console.log(`  Source: ${USE_LOCAL ? `local ${sitemapDir}` : `live ${SITEMAP_BASE}`}`);

  const urls = snapshotUrls(snapshot);

  // Locale-alternate compensation from the public/ registry (see
  // extractAlternateUrls docs). No-op when the checkout is unavailable or
  // when the sitemap still carries its annotations (pure union).
  const publicDir = resolve(getProjectRoot(), 'public');
  let alternatesAdded = 0;
  const registryFiles = SUB_SITEMAPS.filter((file) =>
    sitemapFilters.length === 0 || sitemapFilters.some((filter) => {
      const normalized = String(filter).toLowerCase();
      return file.toLowerCase().includes(normalized)
        || (normalized === 'article' && /article|blog|news/.test(file));
    }));
  for (const file of registryFiles) {
    const publicPath = resolve(publicDir, file);
    if (!existsSync(publicPath)) continue;
    try {
      alternatesAdded += extractAlternateUrls(readFileSync(publicPath, 'utf-8'), urls);
    } catch { /* unreadable public sitemap — live/dist collection stands */ }
  }
  if (alternatesAdded > 0) {
    console.log(`  public/ registry: ${alternatesAdded} hreflang alternates unioned (${urls.size} unique total)`);
  }

  // Add extra key URLs not typically in sitemaps
  if (sitemapFilters.length === 0) {
    for (const url of EXTRA_URLS) urls.add(url);
  }

  return [...urls].sort();
}

// ── Verify key file accessibility ─────────────────────────────
async function verifyKeyFile() {
  let reason = 'unknown error';
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const res = await fetch(KEY_LOCATION, {
        headers: { Accept: 'text/plain', 'User-Agent': DEFAULT_LIVE_CHECK_USER_AGENT },
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.text()).trim();
      if (res.ok && body === INDEXNOW_KEY) {
        console.log(`Key file verified: ${KEY_LOCATION} (attempt ${attempt})`);
        return true;
      }
      reason = res.ok ? `content mismatch (${body.slice(0, 60)})` : `HTTP ${res.status} ${res.statusText}`;
    } catch (err) {
      reason = err.message;
    }
    if (attempt < 4) {
      const delay = attempt * 2000;
      console.warn(`Key file check failed (${reason}); retrying in ${delay / 1000}s (${attempt}/3)`);
      await sleep(delay);
    }
  }
  console.error(`Key file verification failed after 4 attempts: ${reason}`);
  console.error(`  URL: ${KEY_LOCATION}`);
  return false;
}

// ── Submit a batch of URLs to a single endpoint ───────────────
async function submitBatch(endpoint, urlBatch, batchIndex, totalBatches, attempt = 1) {
  const engineName = new URL(endpoint).hostname;
  const label = totalBatches > 1 ? ` [batch ${batchIndex + 1}/${totalBatches}]` : '';
  const payload = {
    host: HOST,
    key: INDEXNOW_KEY,
    keyLocation: KEY_LOCATION,
    urlList: urlBatch,
  };

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'User-Agent': DEFAULT_LIVE_CHECK_USER_AGENT,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });

    if (response.ok || response.status === 202) {
      return { ok: true, status: response.status, submitted: urlBatch.length };
    }

    const text = await response.text().catch(() => '');

    // Handle rate limiting with Retry-After
    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get('Retry-After') || '0', 10);
      const delay = retryAfter > 0
        ? Math.min(retryAfter * 1000, 60_000) // cap at 60s
        : 3000 * attempt;

      if (attempt <= MAX_RETRIES) {
        console.log(`  ${engineName}${label}: 429 rate limited — waiting ${(delay / 1000).toFixed(0)}s (retry ${attempt}/${MAX_RETRIES})`);
        await sleep(delay);
        return submitBatch(endpoint, urlBatch, batchIndex, totalBatches, attempt + 1);
      }
    }

    // Retry on 5xx
    if (response.status >= 500 && attempt <= MAX_RETRIES) {
      const delay = 2000 * attempt;
      console.log(`  ${engineName}${label}: ${response.status} server error — retry ${attempt}/${MAX_RETRIES} in ${(delay / 1000).toFixed(0)}s`);
      await sleep(delay);
      return submitBatch(endpoint, urlBatch, batchIndex, totalBatches, attempt + 1);
    }

    return { ok: false, status: response.status, body: text, submitted: 0 };
  } catch (error) {
    if (attempt <= MAX_RETRIES) {
      const delay = 2000 * attempt;
      console.log(`  ${engineName}${label}: network error — retry ${attempt}/${MAX_RETRIES} in ${(delay / 1000).toFixed(0)}s`);
      await sleep(delay);
      return submitBatch(endpoint, urlBatch, batchIndex, totalBatches, attempt + 1);
    }
    return { ok: false, status: 0, body: error.message, submitted: 0 };
  }
}

// ── Submit all URLs to a single endpoint ──────────────────────
async function submitToEndpoint(endpointName, endpoint, urlList) {
  const engineName = new URL(endpoint).hostname;
  const batches = [];
  for (let i = 0; i < urlList.length; i += BATCH_SIZE) {
    batches.push(urlList.slice(i, i + BATCH_SIZE));
  }

  console.log(`\n${engineName}: submitting ${urlList.length} URLs in ${batches.length} batch(es)...`);

  let totalSubmitted = 0;
  let failed = false;

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const result = await submitBatch(endpoint, batch, b, batches.length);

    if (result.ok) {
      totalSubmitted += result.submitted;
      console.log(`  Batch ${b + 1}/${batches.length}: ${result.submitted} URLs accepted (HTTP ${result.status})`);
    } else {
      console.error(`  Batch ${b + 1}/${batches.length}: FAILED — HTTP ${result.status}`);
      if (result.body) {
        console.error(`  Response: ${result.body.slice(0, 300)}`);
      }
      failed = true;
      break;
    }

    // Polite delay between batches
    if (b < batches.length - 1) {
      await sleep(INTER_BATCH_DELAY_MS);
    }
  }

  return { engineName, totalSubmitted, total: urlList.length, failed };
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  console.log('=== IndexNow Batch Submission ===\n');

  // 1. Collect URLs
  console.log(`Collecting URLs from sitemaps (${USE_LOCAL ? 'local files' : `live ${SITEMAP_BASE}`})...`);
  const urlList = await getUrlsFromSitemaps();
  console.log(`\nTotal unique URLs: ${urlList.length}\n`);

  if (urlList.length === 0) {
    console.log('No URLs found in sitemaps. Nothing to submit.');
    process.exit(0);
  }

  // 2. Determine target endpoints
  const selectedEndpoints = endpointArg
    ? { [endpointArg]: ENDPOINTS[endpointArg] }
    : { ...ENDPOINTS };

  if (endpointArg && !ENDPOINTS[endpointArg]) {
    console.error(`Unknown endpoint "${endpointArg}". Available: ${Object.keys(ENDPOINTS).join(', ')}`);
    process.exit(1);
  }

  // 3. Dry run — just preview
  if (DRY_RUN) {
    console.log('--- DRY RUN (no submissions) ---\n');
    console.log(`Would submit ${urlList.length} URLs to: ${Object.keys(selectedEndpoints).join(', ')}`);
    console.log(`Batch size: ${BATCH_SIZE} URLs/request`);
    console.log(`Total batches per endpoint: ${Math.ceil(urlList.length / BATCH_SIZE)}`);
    console.log(`\nSample URLs (first 20):`);
    for (const url of urlList.slice(0, 20)) {
      console.log(`  ${url}`);
    }
    if (urlList.length > 20) {
      console.log(`  ... and ${urlList.length - 20} more`);
    }
    process.exit(0);
  }

  // 4. Verify key file
  console.log('Verifying IndexNow key file...');
  const keyOk = await verifyKeyFile();
  if (!keyOk) {
    console.error('\nKey file verification failed. Ensure the site is deployed and the key file is accessible.');
    process.exit(1);
  }

  // 5. Submit to each endpoint
  const results = [];
  for (const [name, endpoint] of Object.entries(selectedEndpoints)) {
    const result = await submitToEndpoint(name, endpoint, urlList);
    results.push(result);
  }

  // 6. Summary
  console.log('\n=== Summary ===\n');
  for (const r of results) {
    const status = r.failed ? 'PARTIAL' : 'OK';
    console.log(`  ${r.engineName}: ${r.totalSubmitted}/${r.total} URLs submitted [${status}]`);
  }

  const anyFailed = results.some((r) => r.failed);
  if (anyFailed) {
    console.log('\nSome endpoints failed. Check logs above for details.');
    process.exit(1);
  }

  console.log('\nAll submissions completed successfully.');
}

const invokedDirectly = (() => {
  // Entrypoint canonico, non suffisso del path (#7292): `endsWith` diceva true
  // per QUALUNQUE entrypoint il cui `argv[1]` finisse con questo nome di file;
  // `realpathSync` copre l'invocazione via symlink, dove `argv[1]` e' il link.
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; }
  catch { return false; }
})();

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`Fatal error: ${err.message}`);
    process.exit(1);
  });
}
