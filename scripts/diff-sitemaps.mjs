#!/usr/bin/env node
/**
 * Informational diff between the complete pre-deploy sitemap graph and the
 * local build graph. It uses the same recursive crawler as IndexNow, including
 * nested sitemap indexes and hreflang URLs.
 */

import { existsSync, readFileSync } from 'node:fs';
import { changedUrls, crawlSitemaps, snapshotFromCrawl } from './lib/sitemap-crawl.mjs';
import { intFromEnv } from './lib/int-from-env.mjs';

const DIST = process.env.DIST_DIR || 'dist';
const PRE_DEPLOY_FILE = process.env.PRE_DEPLOY_FILE || '/tmp/pre-deploy-sitemap-urls.json';
const FIRST_N = intFromEnv('DIFF_FIRST_N', 20);
const SEP = '═'.repeat(72);

function loadSnapshot(file) {
  if (!existsSync(file)) return null;
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (Array.isArray(value)) return value;
    if (value && value.perSitemap) return value;
  } catch (error) {
    console.warn('⚠️ Could not parse ' + file + ': ' + error.message);
  }
  return null;
}

function urlsFor(snapshot, key) {
  return new Set(snapshot?.perSitemap?.[key] || []);
}

async function main() {
  const previous = loadSnapshot(PRE_DEPLOY_FILE);
  console.log(SEP);
  console.log('Sitemap graph diff vs pre-deploy snapshot');
  console.log(SEP);
  if (!previous) {
    console.log('ℹ️ Snapshot ' + PRE_DEPLOY_FILE + ' not present — skipping diff (informational).');
    console.log(SEP);
    return;
  }

  const crawl = await crawlSitemaps({
    source: 'local',
    rootDir: DIST,
    baseUrl: 'https://' + (process.env.HOST || 'frontaliereticino.ch'),
    strict: false,
  });
  const current = snapshotFromCrawl(crawl);
  const changed = changedUrls(current, previous, { includeRemoved: true });
  const previousPer = Array.isArray(previous) ? { _legacy_flat: previous } : (previous.perSitemap || {});
  const keys = new Set([...Object.keys(previousPer), ...Object.keys(current.perSitemap)]);
  let added = 0;
  let removed = 0;
  for (const key of [...keys].sort()) {
    const now = new Set(current.perSitemap[key] || []);
    const before = urlsFor({ perSitemap: previousPer }, key);
    const plus = [...now].filter((url) => !before.has(url));
    const minus = [...before].filter((url) => !now.has(url));
    added += plus.length;
    removed += minus.length;
    if (plus.length || minus.length) {
      console.log('  ' + key.padEnd(52) + ' +' + String(plus.length).padStart(4) + ' -' + String(minus.length).padStart(4));
    }
  }
  console.log('Totals: +' + added + ' added, -' + removed + ' removed, ' + changed.length + ' URLs changed/modified');
  if (changed.length > 0) {
    console.log('\nFirst ' + Math.min(FIRST_N, changed.length) + ' URLs IndexNow would reconcile:');
    for (const url of changed.slice(0, FIRST_N)) console.log('  • ' + url);
  }
  if (crawl.missing.length > 0) console.log('⚠️ Local graph omitted ' + crawl.missing.length + ' edge-owned sitemap(s).');
  console.log(SEP);
}

main().catch((error) => {
  console.warn('⚠️ diff-sitemaps failed: ' + error.message);
});
