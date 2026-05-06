#!/usr/bin/env node
/**
 * scripts/capture-deployed-sitemaps.mjs
 *
 * Fetches the URL list from each sitemap-*.xml on the currently deployed
 * (live) site and saves the snapshot to /tmp/pre-deploy-sitemap-urls.json.
 *
 * Output format (v2 — per-sitemap struct):
 *   {
 *     version: 2,
 *     capturedAt: "2026-05-06T08:00:00Z",
 *     host: "frontaliereticino.ch",
 *     perSitemap: {
 *       "sitemap-blog.xml": [ "https://...", ... ],
 *       "sitemap-jobs.xml": [ ... ],
 *       ...
 *     },
 *     _allUrls: [ "https://...", ... ]    // sorted union, kept for backward
 *                                         // compat with old submit-indexnow.js
 *   }
 *
 * Why per-sitemap: the post-deploy validate diffs the new dist sitemaps
 * against the live snapshot. Without per-sitemap structure the diff can
 * only report a single global +N/-M; with it we get +/-counts per file
 * (e.g. "sitemap-weekly-employers.xml: +28 added"). The IndexNow / Google
 * indexing pipelines also benefit by submitting only the URLs that
 * actually moved.
 *
 * Discovery: starts from sitemap-index.xml so the file list stays in sync
 * with build-plugins (no hardcoded list to drift from). Falls back to a
 * curated short list if the index isn't reachable (first deploy, etc).
 *
 * Usage (in deploy.yml, BEFORE the deploy step):
 *   node scripts/capture-deployed-sitemaps.mjs
 */

import { writeFileSync } from 'node:fs';

const HOST = process.env.HOST || 'frontaliereticino.ch';
const OUTPUT = process.env.OUTPUT || '/tmp/pre-deploy-sitemap-urls.json';
const FETCH_TIMEOUT_MS = 10_000;

// Fallback list when sitemap-index.xml is unreachable (e.g. very first
// deploy). Match what older versions of this script used so the snapshot
// shape stays compatible with downstream consumers in degraded mode.
const FALLBACK_FILES = [
  'sitemap-pages.xml',
  'sitemap-blog.xml',
  'sitemap-glossario.xml',
  'sitemap-jobs.xml',
  'sitemap-news.xml',
];

function parseSitemapBody(xml) {
  const urls = new Set();
  for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) urls.add(m[1].trim());
  // hreflang `<a>`-style alternates in sitemap-pages — keep them so the
  // diff covers locale variants too.
  for (const m of xml.matchAll(/hreflang="[^"]*"\s+href="([^"]+)"/g)) urls.add(m[1].trim());
  return [...urls];
}

async function fetchText(url) {
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/xml, text/xml' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * Discover the list of sitemap-*.xml files by reading sitemap-index.xml.
 * Each entry there is a full URL — we strip back to the basename so callers
 * can refer to it as "sitemap-X.xml" regardless of host.
 */
async function discoverSitemapFiles() {
  const indexXml = await fetchText(`https://${HOST}/sitemap-index.xml`);
  if (!indexXml) return null;
  const files = new Set();
  for (const m of indexXml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const u = m[1].trim();
    const tail = u.split('/').pop();
    if (tail && /^sitemap-.+\.xml$/.test(tail) && tail !== 'sitemap-index.xml') {
      files.add(tail);
    }
  }
  return [...files].sort();
}

async function main() {
  let files = await discoverSitemapFiles();
  if (!files || files.length === 0) {
    console.warn(`⚠️ Could not read sitemap-index.xml from https://${HOST}/ — falling back to curated list`);
    files = FALLBACK_FILES;
  }

  /** @type {Record<string, string[]>} */
  const perSitemap = {};
  const allUrls = new Set();

  for (const file of files) {
    const xml = await fetchText(`https://${HOST}/${file}`);
    if (!xml) {
      // Sitemap referenced by index but currently unreachable — record empty
      // so the diff later treats it as "no urls live" instead of "missing entry".
      perSitemap[file] = [];
      continue;
    }
    const urls = parseSitemapBody(xml).sort();
    perSitemap[file] = urls;
    for (const u of urls) allUrls.add(u);
  }

  const snapshot = {
    version: 2,
    capturedAt: new Date().toISOString(),
    host: HOST,
    perSitemap,
    _allUrls: [...allUrls].sort(),
  };

  writeFileSync(OUTPUT, JSON.stringify(snapshot), 'utf-8');
  const fileCount = Object.keys(perSitemap).length;
  console.log(
    `📸 Captured ${snapshot._allUrls.length} pre-deploy URLs across ${fileCount} sitemap files → ${OUTPUT}`,
  );
}

main().catch((err) => {
  console.warn(`⚠️ Failed to capture pre-deploy sitemaps: ${err.message}`);
  // Non-fatal — submit-indexnow.js will fall back to submitting all URLs.
  process.exit(0);
});
