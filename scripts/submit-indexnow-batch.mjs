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
 * - Reads all sub-sitemaps from dist/ or public/ to collect every URL
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
 *
 * Environment:
 *   INDEXNOW_KEY (optional) — override the default key
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

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

const SUB_SITEMAPS = [
  'sitemap-pages.xml',
  'sitemap-blog.xml',
  'sitemap-glossario.xml',
  'sitemap-jobs.xml',
  'sitemap-news.xml',
];

// ── CLI argument parsing ──────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const endpointArg = args.find((_, i, a) => a[i - 1] === '--endpoint');
const sitemapArg = args.find((_, i, a) => a[i - 1] === '--sitemap');

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage: node scripts/submit-indexnow-batch.mjs [options]

Options:
  --dry-run              Preview URLs without submitting
  --endpoint <name>      Submit to a single engine: indexnow, bing, yandex
  --sitemap <filter>     Only include sitemaps matching this substring (e.g. "jobs", "blog")
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

// ── Collect URLs from sitemaps ────────────────────────────────
function getUrlsFromSitemaps() {
  const rootDir = getProjectRoot();
  const urls = new Set();

  // Prefer dist/ (post-build) over public/ (pre-build source)
  const sitemapDir = existsSync(resolve(rootDir, 'dist', 'sitemap-pages.xml'))
    ? resolve(rootDir, 'dist')
    : resolve(rootDir, 'public');

  const filteredSitemaps = sitemapArg
    ? SUB_SITEMAPS.filter((f) => f.includes(sitemapArg))
    : SUB_SITEMAPS;

  if (filteredSitemaps.length === 0) {
    console.error(`No sitemaps match filter "${sitemapArg}". Available: ${SUB_SITEMAPS.join(', ')}`);
    process.exit(1);
  }

  for (const file of filteredSitemaps) {
    const filePath = resolve(sitemapDir, file);
    try {
      const xml = readFileSync(filePath, 'utf-8');
      let count = 0;
      for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
        urls.add(m[1].trim());
        count++;
      }
      for (const m of xml.matchAll(/hreflang="[^"]*"\s+href="([^"]+)"/g)) {
        urls.add(m[1].trim());
        count++;
      }
      console.log(`  ${file}: ${count} raw entries (${urls.size} unique so far)`);
    } catch {
      console.log(`  ${file}: not found — skipping`);
    }
  }

  console.log(`  Source directory: ${sitemapDir}`);
  return [...urls].sort();
}

// ── Verify key file accessibility ─────────────────────────────
async function verifyKeyFile() {
  try {
    const res = await fetch(KEY_LOCATION, {
      headers: { Accept: 'text/plain' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(`Key file not reachable: ${res.status} ${res.statusText}`);
      console.error(`  URL: ${KEY_LOCATION}`);
      return false;
    }
    const body = (await res.text()).trim();
    if (body !== INDEXNOW_KEY) {
      console.error(`Key file content mismatch!`);
      console.error(`  Expected: ${INDEXNOW_KEY}`);
      console.error(`  Found: ${body.slice(0, 60)}`);
      return false;
    }
    console.log(`Key file verified: ${KEY_LOCATION}`);
    return true;
  } catch (err) {
    console.error(`Key file fetch error: ${err.message}`);
    return false;
  }
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
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
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
  console.log('Collecting URLs from sitemaps...');
  const urlList = getUrlsFromSitemaps();
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

main().catch((err) => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
