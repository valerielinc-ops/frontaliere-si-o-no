#!/usr/bin/env node
/**
 * Drop from `public/sitemap-*.xml` every `<url>` block the edge answers 301/410.
 *
 * This is the hand the retirement commit runs (issue #7670). Declaring a URL in
 * `EDGE_RETIRED_PATHS` switches the 301 on immediately; without this step the
 * sitemap keeps inviting Google to crawl it until the next
 * `sync-articles-sitemaps.yml` run (`cron: '23 5,17 * * *'`, so up to ~12h).
 * Running it in the SAME commit closes the window to zero, and
 * tests/sitemap-retired-paths-absent.test.ts is the gate that makes forgetting
 * it a red build rather than half a day of redirect-only sitemap entries.
 *
 *   node scripts/prune-retired-sitemap-urls.mjs            # rewrite in place
 *   node scripts/prune-retired-sitemap-urls.mjs --check     # report, exit 1 if any
 *
 * The pages are NOT touched — they are already retired at the edge. Only the
 * "please crawl this as a distinct page" signal goes, which is precisely the
 * signal the retirement contradicts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { dropRetiredSitemapUrlBlocks, retiredLocsIn } from './lib/sitemap-retired-urls.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

const checkOnly = process.argv.includes('--check');

/** Every committed sitemap document, index included. */
export function sitemapFilesIn(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('sitemap') && f.endsWith('.xml'))
    .sort();
}

const files = sitemapFilesIn(PUBLIC_DIR);
if (files.length === 0) {
  console.error(`no sitemap-*.xml under ${path.relative(ROOT, PUBLIC_DIR)} — refusing to report clean`);
  process.exit(1);
}

let hits = 0;
for (const name of files) {
  const file = path.join(PUBLIC_DIR, name);
  const xml = fs.readFileSync(file, 'utf-8');

  // Report on every retired <loc>, prune only the <url> blocks. The two agree on
  // a page sitemap; on a sitemap INDEX there are no <url> blocks to prune and no
  // retired <loc>s to report, so both are empty.
  const listed = retiredLocsIn(xml);
  if (listed.length === 0) continue;
  hits += listed.length;

  if (checkOnly) {
    console.error(`${name}: ${listed.length} retired URL(s) still listed`);
    for (const loc of listed) console.error(`  ${loc}`);
    continue;
  }

  const { xml: pruned, dropped } = dropRetiredSitemapUrlBlocks(xml);
  fs.writeFileSync(file, pruned, 'utf-8');
  console.log(`${name}: dropped ${dropped.length} retired URL(s)`);
  for (const loc of dropped) console.log(`  ${loc}`);
}

if (hits === 0) {
  console.log(`${files.length} sitemap(s) clean — no URL the edge answers 301/410 is listed`);
  process.exit(0);
}

if (checkOnly) {
  console.error('\nRun `npm run sitemap:prune-retired` and commit the result.');
  process.exit(1);
}
