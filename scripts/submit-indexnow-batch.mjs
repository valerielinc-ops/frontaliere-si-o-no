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
  'sitemap-guides.xml',
];

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
const sitemapArg = args.find((_, i, a) => a[i - 1] === '--sitemap');

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

// ── Fetch one sub-sitemap live over HTTP (with retry) ─────────
async function fetchSitemapXml(file) {
  const url = `${SITEMAP_BASE}/${file}`;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/xml,text/xml' },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) return await res.text();
      if (res.status >= 500 && attempt < MAX_RETRIES) {
        await sleep(2000 * attempt);
        continue;
      }
      console.log(`  ${file}: HTTP ${res.status} — skipping`);
      return null;
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        await sleep(2000 * attempt);
        continue;
      }
      console.log(`  ${file}: fetch error (${err.message}) — skipping`);
      return null;
    }
  }
  return null;
}

// ── Collect URLs from sitemaps (live by default, --local for FS) ─
export async function getUrlsFromSitemaps() {
  const urls = new Set();

  const filteredSitemaps = sitemapArg
    ? SUB_SITEMAPS.filter((f) => f.includes(sitemapArg))
    : SUB_SITEMAPS;

  if (filteredSitemaps.length === 0) {
    console.error(`No sitemaps match filter "${sitemapArg}". Available: ${SUB_SITEMAPS.join(', ')}`);
    process.exit(1);
  }

  if (USE_LOCAL) {
    // Prefer dist/ (post-build) over public/ (pre-build source)
    const rootDir = getProjectRoot();
    const sitemapDir = existsSync(resolve(rootDir, 'dist', 'sitemap-pages.xml'))
      ? resolve(rootDir, 'dist')
      : resolve(rootDir, 'public');
    for (const file of filteredSitemaps) {
      try {
        const count = extractUrls(readFileSync(resolve(sitemapDir, file), 'utf-8'), urls);
        console.log(`  ${file}: ${count} raw entries (${urls.size} unique so far)`);
      } catch {
        console.log(`  ${file}: not found — skipping`);
      }
    }
    console.log(`  Source: local ${sitemapDir}`);
  } else {
    const failed = [];
    const empty = [];
    for (const file of filteredSitemaps) {
      const xml = await fetchSitemapXml(file);
      // null = unreachable (5xx after retries / 404 / network); an empty but
      // 200-OK urlset returns '' and is treated as a legitimate empty sitemap.
      if (xml == null) {
        failed.push(file);
        continue;
      }
      const count = extractUrls(xml, urls);
      if (count === 0) empty.push(file);
      console.log(`  ${file}: ${count} raw entries (${urls.size} unique so far)`);
    }
    console.log(`  Source: live ${SITEMAP_BASE}`);
    // Abort on ANY expected sub-sitemap failure, not only when all six fail.
    // A partial fetch would silently drop a whole content type — e.g. if
    // sitemap-jobs.xml (the job funnel) 5xx/404s after a deploy while the
    // other five succeed — and still exit 0, masking the gap as a clean run.
    if (failed.length > 0) {
      console.error(
        `Failed to fetch ${failed.length}/${filteredSitemaps.length} sitemap(s) from ${SITEMAP_BASE}: ${failed.join(', ')}.\n` +
        `Aborting to avoid a partial submission that would drop those URLs silently.`,
      );
      process.exit(1);
    }
    // A 200-OK sitemap with zero URLs is treated as legitimately empty (some
    // categories can be small), but a normally-populated one returning 0 —
    // e.g. sitemap-jobs.xml truncated by a partial deploy — would otherwise
    // hide behind its count line. Surface it loudly so it's visible in logs.
    if (empty.length > 0) {
      console.warn(`  ⚠️  ${empty.length} sitemap(s) returned 200 but 0 URLs: ${empty.join(', ')} — verify this is expected.`);
    }
  }

  // Locale-alternate compensation from the public/ registry (see
  // extractAlternateUrls docs). No-op when the checkout is unavailable or
  // when the sitemap still carries its annotations (pure union).
  const publicDir = resolve(getProjectRoot(), 'public');
  let alternatesAdded = 0;
  for (const file of filteredSitemaps) {
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
  if (!sitemapArg) {
    for (const url of EXTRA_URLS) urls.add(url);
  }

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

// ── Bing Webmaster URL Submission API ─────────────────────────
async function submitToBingApi(urlList) {
  const apiKey = process.env.BING_API_KEY;
  if (!apiKey) {
    console.log('\nBing Webmaster API: BING_API_KEY not set — skipping');
    return;
  }

  const siteUrl = `https://${HOST}`;
  const BING_BATCH = 500;

  console.log(`\nBing Webmaster URL Submission API: ${urlList.length} URLs`);

  if (DRY_RUN) {
    console.log(`  Would submit ${urlList.length} URLs in ${Math.ceil(urlList.length / BING_BATCH)} batches`);
    return;
  }

  const batches = [];
  for (let i = 0; i < urlList.length; i += BING_BATCH) {
    batches.push(urlList.slice(i, i + BING_BATCH));
  }

  let totalSubmitted = 0;

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const endpoint = `https://ssl.bing.com/webmaster/api.svc/json/SubmitUrlbatch?apikey=${apiKey}`;
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ siteUrl, urlList: batch }),
        signal: AbortSignal.timeout(30_000),
      });

      if (res.ok) {
        totalSubmitted += batch.length;
        console.log(`  Batch ${b + 1}/${batches.length}: ${batch.length} URLs submitted`);
      } else {
        const text = await res.text().catch(() => '');
        if (/quota|exceeded/i.test(text)) {
          console.warn(`  Bing daily quota exceeded after ${totalSubmitted} URLs — stopping`);
        } else {
          console.error(`  Bing API: HTTP ${res.status} — ${text.slice(0, 200)}`);
        }
        break;
      }
    } catch (err) {
      console.error(`  Bing API error: ${err.message}`);
      break;
    }
    if (b < batches.length - 1) await sleep(500);
  }

  console.log(`  Bing API total: ${totalSubmitted}/${urlList.length} URLs submitted`);
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

  // 6. Also submit to Bing Webmaster URL Submission API if configured
  await submitToBingApi(urlList);

  // 7. Summary
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
  try { return import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1]); }
  catch { return false; }
})();

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`Fatal error: ${err.message}`);
    process.exit(1);
  });
}
