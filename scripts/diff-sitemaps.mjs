#!/usr/bin/env node
/**
 * scripts/diff-sitemaps.mjs
 *
 * Compare per-sitemap URL lists between the currently deployed live site
 * (https://frontaliereticino.ch) and the freshly built dist/ directory.
 * Used in post-deploy validation to surface what each deploy actually
 * adds, removes, or shifts in the public sitemap surface.
 *
 * Output is INFORMATIONAL only — the script always exits 0 so it can never
 * block validation. The numbers help spot anomalies (e.g. 500 URLs removed
 * unexpectedly when only 5 jobs expired) before SEO regressions hit live.
 *
 * Usage:
 *   node scripts/diff-sitemaps.mjs
 *
 * Env vars:
 *   DIST_DIR     — dist directory to read new sitemaps from (default: dist)
 *   HOST         — host to fetch live sitemaps from (default: frontaliereticino.ch)
 *   DIFF_FIRST_N — how many added/removed URLs to print per category (default: 20)
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const HOST = process.env.HOST || 'frontaliereticino.ch';
const DIST = process.env.DIST_DIR || 'dist';
const FIRST_N = Number(process.env.DIFF_FIRST_N || '20');
const FETCH_TIMEOUT_MS = 15_000;

const SEP = '═'.repeat(72);
const SUB = '─'.repeat(72);

function parseLocs(xml) {
  const urls = new Set();
  for (const match of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    urls.add(match[1].trim());
  }
  return urls;
}

async function fetchLiveSitemap(name) {
  try {
    const res = await fetch(`https://${HOST}/${name}`, {
      headers: { Accept: 'application/xml, text/xml' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return parseLocs(await res.text());
  } catch {
    return null;
  }
}

function readDistSitemap(name) {
  const file = path.join(DIST, name);
  if (!existsSync(file)) return null;
  return parseLocs(readFileSync(file, 'utf8'));
}

function listDistSitemaps(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^sitemap-.+\.xml$/.test(f) && f !== 'sitemap-index.xml')
    .sort();
}

function main() {
  const distSitemaps = listDistSitemaps(DIST);
  if (distSitemaps.length === 0) {
    console.log(`ℹ️ No sitemap-*.xml found under ${DIST} — skipping diff`);
    return;
  }

  console.log(SEP);
  console.log(`Sitemap diff vs live (https://${HOST})`);
  console.log(SEP);

  return Promise.all(
    distSitemaps.map(async (name) => {
      const [live, next] = await Promise.all([
        fetchLiveSitemap(name),
        Promise.resolve(readDistSitemap(name)),
      ]);
      return { name, live, next };
    }),
  ).then((rows) => {
    let totalAdded = 0;
    let totalRemoved = 0;
    const allAdded = [];
    const allRemoved = [];

    for (const { name, live, next } of rows) {
      if (!next) {
        console.log(`  ${name.padEnd(48)} (missing in dist — skipped)`);
        continue;
      }
      if (!live) {
        console.log(
          `  ${name.padEnd(48)} ${String(next.size).padStart(5)} URLs · live unreachable (treated as net-new)`,
        );
        totalAdded += next.size;
        for (const u of next) allAdded.push(u);
        continue;
      }
      const added = [];
      const removed = [];
      for (const u of next) if (!live.has(u)) added.push(u);
      for (const u of live) if (!next.has(u)) removed.push(u);

      totalAdded += added.length;
      totalRemoved += removed.length;
      for (const u of added) allAdded.push(u);
      for (const u of removed) allRemoved.push(u);

      const net = added.length - removed.length;
      const marker = net === 0 ? '·' : net > 0 ? '↑' : '↓';
      console.log(
        `  ${name.padEnd(48)} +${String(added.length).padStart(4)}  -${String(removed.length).padStart(4)}  net ${net >= 0 ? '+' : ''}${net} ${marker}`,
      );
    }

    console.log(SUB);
    console.log(`Totals: +${totalAdded} added, -${totalRemoved} removed across ${rows.length} sitemap files`);
    console.log(SEP);

    if (allAdded.length > 0) {
      console.log(`\nFirst ${Math.min(FIRST_N, allAdded.length)} added URLs:`);
      for (const u of allAdded.slice(0, FIRST_N)) console.log(`  + ${u}`);
    }
    if (allRemoved.length > 0) {
      console.log(`\nFirst ${Math.min(FIRST_N, allRemoved.length)} removed URLs:`);
      for (const u of allRemoved.slice(0, FIRST_N)) console.log(`  - ${u}`);
    }
    if (allAdded.length === 0 && allRemoved.length === 0) {
      console.log('\nNo URL changes detected.');
    }
    console.log(SEP);
  });
}

main()
  .catch((err) => {
    console.warn(`⚠️ diff-sitemaps failed: ${err?.message ?? err}`);
  })
  .finally(() => {
    // Always exit 0 — informational only.
    process.exit(0);
  });
