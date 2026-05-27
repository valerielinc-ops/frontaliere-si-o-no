#!/usr/bin/env node
/**
 * Local/CI gate: assert every dist/sitemap-*.xml urlset has < SHARD_HARD_CAP URLs.
 *
 * Background: sitemaps.org caps each sitemap file at 50,000 URLs. We enforce
 * a 45,000 ceiling locally to leave a safety margin for incidental growth
 * between builds. The `sitemap-search-clusters.xml` cohort breached 81k
 * URLs in May 2026, silently failing GSC ingestion — this script prevents
 * that class of regression before it ships.
 *
 * Behavior:
 *   - Reads every dist/sitemap-*.xml that is NOT a sitemapindex.
 *   - Counts <url> opening tags per file.
 *   - Exits 1 with a detailed error if any shard ≥ SHARD_HARD_CAP.
 *   - Exits 0 with a summary when every shard fits.
 *
 * Companion to `check-sitemap-shard-size.mjs` (which polls the LIVE deployed
 * sitemap index post-deploy). This script runs against the local dist/ so
 * we catch regressions before they're pushed.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const DIST = path.resolve('dist');
const SHARD_HARD_CAP = 45_000;
const SHARD_WARN_CAP = 40_000;

function countUrlEntries(xml) {
  const matches = xml.match(/<url[\s>]/g);
  return matches ? matches.length : 0;
}

if (!existsSync(DIST)) {
  console.error(`[check-dist-sitemap-shard-size] dist/ does not exist at ${DIST}`);
  console.error('[check-dist-sitemap-shard-size] run a build first (e.g. `npm run build`)');
  process.exit(2);
}

const shardFiles = readdirSync(DIST)
  .filter((name) => name.startsWith('sitemap') && name.endsWith('.xml'))
  .sort();

if (shardFiles.length === 0) {
  console.error('[check-dist-sitemap-shard-size] no dist/sitemap-*.xml files found');
  process.exit(2);
}

const oversized = [];
const warnings = [];
let totalUrls = 0;
let inspected = 0;

for (const file of shardFiles) {
  const full = path.join(DIST, file);
  const xml = readFileSync(full, 'utf-8');
  // Sitemap indexes (sitemap.xml, sitemap-index.xml) contain <sitemap> entries,
  // not <url> entries. Skip the URL count for those.
  if (xml.includes('<sitemapindex')) continue;
  const urlCount = countUrlEntries(xml);
  totalUrls += urlCount;
  inspected += 1;
  if (urlCount >= SHARD_HARD_CAP) {
    oversized.push({ file, urlCount });
  } else if (urlCount >= SHARD_WARN_CAP) {
    warnings.push({ file, urlCount });
  }
}

for (const w of warnings) {
  console.warn(
    `[check-dist-sitemap-shard-size] WARNING ${w.file}: ${w.urlCount} URLs (≥${SHARD_WARN_CAP}, approaching ${SHARD_HARD_CAP} cap)`,
  );
}

if (oversized.length > 0) {
  console.error('');
  console.error(`[check-dist-sitemap-shard-size] FAIL — ${oversized.length} shard(s) over the ${SHARD_HARD_CAP}-URL cap:`);
  for (const o of oversized) {
    console.error(`  - ${o.file}: ${o.urlCount} URLs`);
  }
  console.error('');
  console.error('  Sharding is mandatory: sitemaps.org caps sitemap files at 50,000 URLs');
  console.error('  and Google Search Console silently drops oversized files. Fix the');
  console.error('  emitter (build-plugin or script) to split URLs across multiple files,');
  console.error('  e.g. sitemap-FEATURE-001.xml, sitemap-FEATURE-002.xml, …');
  process.exit(1);
}

console.log(
  `[check-dist-sitemap-shard-size] OK — ${inspected} shard(s), ${totalUrls} total URLs (cap ${SHARD_HARD_CAP}/shard, warn ${SHARD_WARN_CAP})`,
);
process.exit(0);
