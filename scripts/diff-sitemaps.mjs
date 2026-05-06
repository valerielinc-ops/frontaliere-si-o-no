#!/usr/bin/env node
/**
 * scripts/diff-sitemaps.mjs
 *
 * Compare the per-sitemap URL list captured PRE-deploy from the live site
 * (saved by `scripts/capture-deployed-sitemaps.mjs` to a JSON snapshot)
 * against the freshly built `dist/sitemap-*.xml`. The post-deploy validate
 * job uses this to surface what each deploy actually adds, removes, or
 * shifts in the public sitemap surface.
 *
 * Why this design (vs fetching live AT diff time):
 *   When run after the deploy step, the live site already serves the new
 *   sitemap — diffing live-vs-dist would always be 0. The pre-deploy
 *   snapshot, captured BEFORE actions/deploy-pages, is the only honest
 *   "before" state to compare against.
 *
 * Output is INFORMATIONAL only — the script always exits 0 so it can never
 * block validation.
 *
 * Usage:
 *   node scripts/diff-sitemaps.mjs
 *
 * Env vars:
 *   DIST_DIR          — dist directory to read new sitemaps from (default: dist)
 *   PRE_DEPLOY_FILE   — path to the snapshot JSON
 *                       (default: /tmp/pre-deploy-sitemap-urls.json)
 *   DIFF_FIRST_N      — how many added/removed URLs to print per category
 *                       (default: 20)
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const DIST = process.env.DIST_DIR || 'dist';
const PRE_DEPLOY_FILE = process.env.PRE_DEPLOY_FILE || '/tmp/pre-deploy-sitemap-urls.json';
const FIRST_N = Number(process.env.DIFF_FIRST_N || '20');

const SEP = '═'.repeat(72);
const SUB = '─'.repeat(72);

function parseLocs(xml) {
  const urls = new Set();
  for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) urls.add(m[1].trim());
  return urls;
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

/**
 * Load the pre-deploy snapshot in either v2 (per-sitemap struct) or v1
 * (flat array — older capture-deployed-sitemaps.mjs format). v1 fallback
 * maps everything into a single virtual `_legacy_flat` bucket so the diff
 * still produces a meaningful global +N/-M instead of crashing.
 */
function loadPreDeploySnapshot(file) {
  if (!existsSync(file)) return null;
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    console.warn(`⚠️ Could not parse ${file}: ${err.message}`);
    return null;
  }
  if (Array.isArray(raw)) {
    return { version: 1, perSitemap: { _legacy_flat: new Set(raw) } };
  }
  if (raw && raw.version === 2 && raw.perSitemap) {
    /** @type {Record<string, Set<string>>} */
    const perSitemap = {};
    for (const [name, urls] of Object.entries(raw.perSitemap)) {
      perSitemap[name] = new Set(urls);
    }
    return { version: 2, perSitemap };
  }
  console.warn(`⚠️ Unknown snapshot shape in ${file} — skipping diff`);
  return null;
}

function main() {
  const distSitemaps = listDistSitemaps(DIST);
  const snapshot = loadPreDeploySnapshot(PRE_DEPLOY_FILE);

  console.log(SEP);
  console.log(`Sitemap diff vs pre-deploy snapshot`);
  console.log(SEP);

  if (!snapshot) {
    console.log(`ℹ️ Snapshot ${PRE_DEPLOY_FILE} not present — first deploy or capture failed`);
    console.log(`   Skipping diff (informational, not fatal).`);
    console.log(SEP);
    return;
  }

  if (distSitemaps.length === 0) {
    console.log(`ℹ️ No sitemap-*.xml found under ${DIST} — skipping diff`);
    console.log(SEP);
    return;
  }

  if (snapshot.version === 1) {
    const next = new Set();
    for (const name of distSitemaps) {
      for (const u of readDistSitemap(name) ?? []) next.add(u);
    }
    const live = snapshot.perSitemap._legacy_flat;
    const added = [...next].filter((u) => !live.has(u));
    const removed = [...live].filter((u) => !next.has(u));
    console.log(`(v1 flat snapshot — global diff only)`);
    console.log(`Total: +${added.length} added, -${removed.length} removed`);
    if (added.length > 0) {
      console.log(`\nFirst ${Math.min(FIRST_N, added.length)} added URLs:`);
      for (const u of added.slice(0, FIRST_N)) console.log(`  + ${u}`);
    }
    if (removed.length > 0) {
      console.log(`\nFirst ${Math.min(FIRST_N, removed.length)} removed URLs:`);
      for (const u of removed.slice(0, FIRST_N)) console.log(`  - ${u}`);
    }
    console.log(SEP);
    return;
  }

  let totalAdded = 0;
  let totalRemoved = 0;
  const allAdded = [];
  const allRemoved = [];
  const allFiles = new Set([...distSitemaps, ...Object.keys(snapshot.perSitemap)]);

  for (const name of [...allFiles].sort()) {
    const next = readDistSitemap(name);
    const live = snapshot.perSitemap[name];

    if (!next && !live) continue;

    if (!next) {
      console.log(`  ${name.padEnd(48)} (deleted from dist)  -${live.size}`);
      totalRemoved += live.size;
      for (const u of live) allRemoved.push(u);
      continue;
    }
    if (!live) {
      console.log(`  ${name.padEnd(48)} (new in dist)         +${next.size}`);
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
  console.log(`Totals: +${totalAdded} added, -${totalRemoved} removed across ${allFiles.size} sitemap files`);
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
    console.log(`\nNo URL changes detected.`);
  }
  console.log(SEP);
}

try {
  main();
} catch (err) {
  console.warn(`⚠️ diff-sitemaps failed: ${err?.message ?? err}`);
}
process.exit(0);
