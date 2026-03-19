#!/usr/bin/env node
/**
 * scripts/capture-deployed-sitemaps.mjs
 *
 * Fetches all sitemap URLs from the currently deployed (live) site and saves
 * them to /tmp/pre-deploy-sitemap-urls.json.
 *
 * This snapshot is used by submit-indexnow.js to diff against the new build
 * and determine which URLs are truly new. Without this step the diff would
 * compare the new build against itself (since deploy happens before submission).
 *
 * Usage (in deploy.yml, BEFORE the deploy step):
 *   node scripts/capture-deployed-sitemaps.mjs
 */

import { writeFileSync } from 'node:fs';

const HOST = 'www.frontaliereticino.ch';
const OUTPUT = '/tmp/pre-deploy-sitemap-urls.json';
const SITEMAP_FILES = [
  'sitemap-pages.xml',
  'sitemap-blog.xml',
  'sitemap-glossario.xml',
  'sitemap-jobs.xml',
  'sitemap-news.xml',
];

async function main() {
  const urls = new Set();

  for (const file of SITEMAP_FILES) {
    try {
      const res = await fetch(`https://${HOST}/${file}`, {
        headers: { Accept: 'application/xml, text/xml' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) continue;
      const xml = await res.text();
      for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) urls.add(m[1].trim());
      for (const m of xml.matchAll(/hreflang="[^"]*"\s+href="([^"]+)"/g)) urls.add(m[1].trim());
    } catch {
      // Sitemap may not exist on deployed site — skip
    }
  }

  const sorted = [...urls].sort();
  writeFileSync(OUTPUT, JSON.stringify(sorted), 'utf-8');
  console.log(`📸 Captured ${sorted.length} pre-deploy sitemap URLs → ${OUTPUT}`);
}

main().catch((err) => {
  console.warn(`⚠️ Failed to capture pre-deploy sitemaps: ${err.message}`);
  // Non-fatal — submit-indexnow.js will fall back to submitting all URLs
  process.exit(0);
});
