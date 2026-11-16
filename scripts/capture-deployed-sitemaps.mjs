#!/usr/bin/env node
/**
 * Capture the complete sitemap graph before a deploy, or a local build's
 * sitemap graph when SOURCE=local.
 *
 * Live mode is deliberately fail-closed: sitemap.xml, robots.txt-declared
 * sitemaps and every nested sitemap index are crawled. A partial snapshot is
 * worse than no snapshot because it would make the post-deploy diff look
 * complete while silently excluding a whole URL family.
 *
 * Output defaults to /tmp/pre-deploy-sitemap-urls.json and uses snapshot v4
 * (NDJSON, one line per sitemap): per-sitemap URL sets plus XML digests and
 * per-URL lastmod values for live snapshots. Local publisher snapshots omit
 * the duplicate per-URL lastmod index. The file is streamed one sitemap at a
 * time, so its size can never hit V8's maximum string length no matter how
 * large the sitemap graph grows; read it back with `readSitemapSnapshot`.
 */

import { appendFileSync, rmSync } from 'node:fs';
import { crawlSitemaps, writeSnapshotFile } from './lib/sitemap-crawl.mjs';
import { isExpiredJobSitemapKey } from './lib/sitemap-family-coverage.mjs';

const HOST = process.env.HOST || 'frontaliereticino.ch';
const SOURCE = process.env.SOURCE || 'live';
const OUTPUT = process.env.OUTPUT || '/tmp/pre-deploy-sitemap-urls.json';
const ROOT_DIR = process.env.LOCAL_ROOT || 'dist';
const BASE_URL = (process.env.SITEMAP_BASE || `https://${HOST}`).replace(/\/+$/, '');

function formatMissingDetail({ key, parent, status, cfCacheStatus, age }) {
  return `${key}; parent=${parent ?? 'unknown'}; status=${status ?? 'unknown'}; `
    + `cf-cache-status=${cfCacheStatus ?? 'unknown'}; age=${age ?? 'unknown'}`;
}

function writeToleratedMissingSummary(entries) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath || entries.length === 0) return;
  const lines = [
    '',
    '### Tolerated expired-archive sitemap fetches',
    '',
    ...entries.map((entry) => `- ${formatMissingDetail(entry)}`),
    '',
  ];
  try {
    appendFileSync(summaryPath, `${lines.join('\n')}\n`, 'utf8');
  } catch (error) {
    console.warn(`⚠️ Could not append tolerated sitemap details to step summary: ${error.message}`);
  }
}

async function main() {
  const crawl = await crawlSitemaps({
    host: HOST,
    baseUrl: BASE_URL,
    source: SOURCE,
    rootDir: SOURCE === 'local' ? ROOT_DIR : undefined,
    // Edge-owned files are not materialized in dist/; local snapshots are
    // scoped to files present in this build. Live snapshots remain strict.
    strict: SOURCE !== 'local',
    tolerateMissing: isExpiredJobSitemapKey,
    unreachableRetry: {
      cacheBust: process.env.GITHUB_RUN_ID || String(Date.now()),
    },
  });
  if (crawl.toleratedMissing.length > 0) {
    console.warn(`⚠️ Tolerated ${crawl.toleratedMissing.length} unreachable expired-archive sitemap(s):`);
    for (const entry of crawl.toleratedMissing) {
      console.warn(`  - ${formatMissingDetail(entry)}`);
    }
    writeToleratedMissingSummary(crawl.toleratedMissing);
  }
  const stats = await writeSnapshotFile(OUTPUT, crawl, {
    includeDerivedIndexes: SOURCE !== 'local',
  });
  console.log(
    `📸 Captured ${stats.urls} URL entries across ${stats.sitemaps} sitemap files ` +
    `(${SOURCE}, ${stats.bytes} bytes, largest chunk ${stats.maxChunkChars} chars) → ${OUTPUT}`,
  );
}

main().catch((err) => {
  console.error(`❌ Sitemap snapshot failed: ${err.message}`);
  // Never leave an earlier file at OUTPUT that a consumer could mistake for the
  // snapshot of this run (the writer already removes its own partial output).
  try { rmSync(OUTPUT, { force: true }); } catch { /* best effort */ }
  // The deploy prep keeps this section non-fatal for compatibility. The
  // submitter sees the missing snapshot and safely falls back to all current
  // URLs rather than trusting a truncated baseline.
  process.exit(1);
});
