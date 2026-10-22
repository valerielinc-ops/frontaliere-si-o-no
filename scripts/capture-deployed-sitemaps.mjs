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
 * Output defaults to /tmp/pre-deploy-sitemap-urls.json and uses snapshot v3:
 * per-sitemap URL sets plus XML digests and per-URL lastmod values. The latter
 * let IndexNow submit existing URLs whose content changed, not only additions.
 */

import { writeFileSync } from 'node:fs';
import { crawlSitemaps, snapshotFromCrawl } from './lib/sitemap-crawl.mjs';

const HOST = process.env.HOST || 'frontaliereticino.ch';
const SOURCE = process.env.SOURCE || 'live';
const OUTPUT = process.env.OUTPUT || '/tmp/pre-deploy-sitemap-urls.json';
const ROOT_DIR = process.env.LOCAL_ROOT || 'dist';
const BASE_URL = (process.env.SITEMAP_BASE || `https://${HOST}`).replace(/\/+$/, '');

async function main() {
  const crawl = await crawlSitemaps({
    host: HOST,
    baseUrl: BASE_URL,
    source: SOURCE,
    rootDir: SOURCE === 'local' ? ROOT_DIR : undefined,
    // Edge-owned files are not materialized in dist/; local snapshots are
    // scoped to files present in this build. Live snapshots remain strict.
    strict: SOURCE !== 'local',
  });
  const snapshot = snapshotFromCrawl(crawl);
  writeFileSync(OUTPUT, JSON.stringify(snapshot), 'utf8');
  console.log(
    `📸 Captured ${snapshot._allUrls.length} URLs across ${snapshot.sitemapFiles.length} sitemap files ` +
    `(${SOURCE}) → ${OUTPUT}`,
  );
}

main().catch((err) => {
  console.error(`❌ Sitemap snapshot failed: ${err.message}`);
  // The deploy prep keeps this section non-fatal for compatibility. The
  // submitter sees the missing snapshot and safely falls back to all current
  // URLs rather than trusting a truncated baseline.
  process.exit(1);
});
