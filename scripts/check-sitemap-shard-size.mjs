#!/usr/bin/env node
// Weekly sitemap shard size monitor.
//
// Fetches https://frontaliereticino.ch/sitemap-index.xml, walks every shard
// listed inside, and counts <url> entries per shard. Emits a JSON report and
// exits with a code that lets the calling workflow branch its alerting:
//
//   exit 0 — every shard healthy
//   exit 1 — at least one shard ≥ WARNING_THRESHOLD (40k)
//   exit 2 — at least one shard ≥ CRITICAL_THRESHOLD (45k)
//
// Google's hard cap is 50,000 URLs per sitemap file; we want to react well
// before we hit it so we have time to reshard.
//
// Pure Node stdlib (native fetch) — no new deps. Simple regex XML parse so we
// don't pull xml2js into the dependency tree for this lightweight check.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

const SITEMAP_INDEX_URL = 'https://frontaliereticino.ch/sitemap-index.xml';
const WARNING_THRESHOLD = 40_000;
const CRITICAL_THRESHOLD = 45_000;
const USER_AGENT = 'FrontaliereTicino-Bot/1.0';
const FETCH_TIMEOUT_MS = 30_000;
const REPORT_PATH = resolve(PROJECT_ROOT, 'data/sitemap-shard-size-report.json');

const EXIT_OK = 0;
const EXIT_WARNING = 1;
const EXIT_CRITICAL = 2;
const EXIT_FETCH_ERROR = 3;

/**
 * Fetch a URL with a polite UA + timeout. Returns the response text or throws.
 */
async function politeFetch(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/xml,text/xml,*/*' },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract every <loc>…</loc> value from an XML document. Naive but sufficient
 * for sitemap index + urlset documents which never nest <loc> elements and
 * never use CDATA for the URL.
 */
function extractLocs(xml) {
  const out = [];
  const re = /<loc>\s*([^<]+?)\s*<\/loc>/g;
  let match;
  while ((match = re.exec(xml)) !== null) {
    out.push(match[1].trim());
  }
  return out;
}

/**
 * Count <url> opening tags in a urlset document. Counts opening tags only so
 * empty self-closing <url/> (rare) wouldn't slip past, but sitemap entries are
 * always wrapped in a real open/close pair.
 */
function countUrlEntries(xml) {
  const matches = xml.match(/<url[\s>]/g);
  return matches ? matches.length : 0;
}

/**
 * Derive a stable filename from a shard URL, falling back to the full URL if
 * we can't parse it (defensive — shouldn't happen for our own sitemap).
 */
function shardFilename(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    return last || url;
  } catch {
    return url;
  }
}

async function main() {
  console.log(`[sitemap-shard-size] fetching ${SITEMAP_INDEX_URL}`);

  let indexXml;
  try {
    indexXml = await politeFetch(SITEMAP_INDEX_URL);
  } catch (err) {
    console.error(`[sitemap-shard-size] failed to fetch sitemap index: ${err.message}`);
    process.exit(EXIT_FETCH_ERROR);
  }

  const shardUrls = extractLocs(indexXml);
  if (shardUrls.length === 0) {
    console.error('[sitemap-shard-size] sitemap index contained zero <loc> entries');
    process.exit(EXIT_FETCH_ERROR);
  }
  console.log(`[sitemap-shard-size] found ${shardUrls.length} shard(s) in index`);

  const shards = [];
  const warnings = [];
  const criticals = [];
  let totalUrls = 0;
  let fetchErrors = 0;

  for (const shardUrl of shardUrls) {
    const filename = shardFilename(shardUrl);
    try {
      const shardXml = await politeFetch(shardUrl);
      const urlCount = countUrlEntries(shardXml);
      const warning = urlCount >= WARNING_THRESHOLD;
      const critical = urlCount >= CRITICAL_THRESHOLD;
      totalUrls += urlCount;
      shards.push({ filename, url: shardUrl, urlCount, warning, critical });
      if (critical) criticals.push(filename);
      else if (warning) warnings.push(filename);
      console.log(
        `[sitemap-shard-size] ${filename}: ${urlCount} urls${
          critical ? ' [CRITICAL]' : warning ? ' [WARNING]' : ''
        }`,
      );
    } catch (err) {
      fetchErrors += 1;
      console.error(`[sitemap-shard-size] failed to fetch shard ${filename}: ${err.message}`);
      shards.push({ filename, url: shardUrl, urlCount: -1, warning: false, critical: false, error: err.message });
    }
  }

  const report = {
    _generatedAt: new Date().toISOString(),
    _thresholds: { warning: WARNING_THRESHOLD, critical: CRITICAL_THRESHOLD, googleCap: 50_000 },
    shardCount: shards.length,
    totalUrls,
    fetchErrors,
    shards,
    warnings,
    criticals,
  };

  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`[sitemap-shard-size] report written to ${REPORT_PATH}`);
  console.log(
    `[sitemap-shard-size] summary: ${shards.length} shards, ${totalUrls} urls, ` +
      `${warnings.length} warning(s), ${criticals.length} critical(s), ${fetchErrors} fetch error(s)`,
  );

  if (criticals.length > 0) process.exit(EXIT_CRITICAL);
  if (warnings.length > 0) process.exit(EXIT_WARNING);
  process.exit(EXIT_OK);
}

main().catch((err) => {
  console.error('[sitemap-shard-size] unexpected error:', err);
  process.exit(EXIT_FETCH_ERROR);
});
