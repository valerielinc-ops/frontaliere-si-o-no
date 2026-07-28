#!/usr/bin/env node
/**
 * Poll all locale shard URLs from a publish-article-fast.mjs summary JSON
 * until every one is live (or a timeout is reached).
 *
 * Built for fast-publish-article.yml (issue #4837 stream C): unlike
 * scripts/wait-for-live-article-meta.mjs (which polls ONE url and requires an
 * expected og:title to match against), the fast-publish summary contract
 * (stream A) only guarantees `{ shards: [{ locale, url, ... }, ...] }` — no
 * og:title. Reuses the SAME liveness primitive
 * (scripts/lib/live-link-check.mjs's checkLink/runWithConcurrency) already
 * shared by send-job-alerts.mjs and check-journalist-article-links.mjs,
 * instead of a third hand-rolled HEAD/timeout construct (AGENTS.md
 * Non-Negotiable #6).
 *
 * Usage:
 *   node scripts/wait-for-live-article-shards.mjs <summary-json-path>
 *
 * Exit codes:
 *   0 = every shard URL verified live
 *   1 = timeout with at least one shard still not live, or bad input
 */
import fs from 'node:fs';
import { checkLink, runWithConcurrency } from './lib/live-link-check.mjs';

const [, , summaryPath] = process.argv;

if (!summaryPath) {
  console.error('Usage: node scripts/wait-for-live-article-shards.mjs <summary-json-path>');
  process.exit(1);
}

let summary;
try {
  summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
} catch (error) {
  console.error(`❌ Could not read/parse summary JSON at ${summaryPath}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const shards = Array.isArray(summary?.shards) ? summary.shards : [];
const urls = shards.map((shard) => shard?.url).filter((url) => typeof url === 'string' && url.length > 0);

if (urls.length === 0) {
  console.error(`❌ No shard URLs found in ${summaryPath} (expected .shards[].url)`);
  process.exit(1);
}

const timeoutMs = Number(process.env.FAST_PUBLISH_WAIT_TIMEOUT_MS || 3 * 60 * 1000);
const intervalMs = Number(process.env.FAST_PUBLISH_WAIT_INTERVAL_MS || 5 * 1000);
const deadline = Date.now() + timeoutMs;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

console.log(`🔍 Verifying ${urls.length} live shard URL(s):`);
for (const url of urls) console.log(`   - ${url}`);

let lastResults = urls.map(() => false);

while (Date.now() < deadline) {
  lastResults = await runWithConcurrency(urls, urls.length, (url) => checkLink(url, 8000, { cacheBust: true }));
  if (lastResults.every(Boolean)) {
    console.log('✅ All shard URLs are live.');
    process.exit(0);
  }
  const pending = urls.filter((_, i) => !lastResults[i]);
  console.log(`⏳ ${pending.length}/${urls.length} shard URL(s) not yet live — retrying in ${Math.round(intervalMs / 1000)}s`);
  for (const url of pending) console.log(`   - ${url}`);
  await sleep(intervalMs);
}

const stillDown = urls.filter((_, i) => !lastResults[i]);
console.error(`❌ Timed out after ${Math.round(timeoutMs / 1000)}s — ${stillDown.length}/${urls.length} shard URL(s) still not live:`);
for (const url of stillDown) console.error(`   - ${url}`);
process.exit(1);
