#!/usr/bin/env node
/**
 * preserve-clarity-assets.mjs
 *
 * Preserves ALL CSS and JS assets from the previous deploy so Microsoft Clarity
 * session recordings don't break. Clarity records DOM with references to specific
 * hashed asset URLs (/assets/index-A3bC4d.css, /assets/App-XyZ123.js, etc.).
 * When those files 404 after the next deploy, recordings render as unstyled HTML.
 *
 * How it works:
 *   --snapshot (before build):
 *     1. Copies every .css/.js file from dist/assets/ into .clarity-asset-cache/.
 *        In CI, dist/assets/ exists because the GitHub Actions cache restores it.
 *        New files get manifest['<file>'] = { firstSeen: now, lastSeen: now }.
 *        Files already in cache get manifest['<file>'].lastSeen = now (firstSeen
 *        stays unchanged).
 *     2. Manifest prune: drop manifest entries (and their on-disk files) whose
 *        `firstSeen` is older than MAX_AGE_DAYS. Aging is by `firstSeen` so an
 *        asset that's been around for MAX_AGE_DAYS continuously still exits
 *        the cache — bounded retention regardless of activity.
 *     3. Orphan reconciliation: any file in .clarity-asset-cache/ that has NO
 *        manifest entry is deleted. Without this step, a file that ends up in
 *        the cache directory through any path that bypasses the manifest
 *        (manifest corruption, manual copy, partial write) lives there
 *        forever — neither prune nor matching-by-name catches it. With this
 *        step, the cache directory is guaranteed to track the manifest 1:1.
 *
 *   --merge (after build):
 *     Copies cached assets into dist/assets/ — skipping files already present
 *     from the fresh build and files whose manifest `firstSeen` is older than
 *     MAX_AGE_DAYS. The latter never reach dist/, so a stale asset never
 *     ships even if a previous run somehow left it in cache.
 *
 * Asset rename behaviour (e.g. content-hash flip from index-AAA.js to
 * index-BBB.js): the OLD filename keeps living in cache until its
 * `firstSeen` crosses MAX_AGE_DAYS, then prune deletes it. The NEW filename
 * gets its own manifest entry with a fresh `firstSeen`. So renamed assets
 * DO get cleaned up — but only after the TTL. Lower MAX_AGE_DAYS → faster
 * eviction of orphan hashes; higher → longer Clarity replay window for
 * stale recordings. Default is 3 days as a balance.
 *
 * The GitHub Actions cache (`clarity-assets-*`) persists .clarity-asset-cache/
 * across deploys, so a build at T sees assets from every build in the last
 * MAX_AGE_DAYS.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(ROOT, '.clarity-asset-cache');
const DIST_ASSETS = path.join(ROOT, 'dist', 'assets');

const ASSET_EXTENSIONS = ['.css', '.js'];
// 1 days = roughly 1 deploy generations on this repo. Tight enough to keep
// the cache lean (~10-15 MB instead of 40+ MB) and cap GH Actions cache
// upload time, wide enough to keep Clarity recordings styled while users
// are actively replaying them (most session replays happen within 24-48 h
// of the original visit per Clarity dashboards). Bump if Clarity reports
// missing-asset 404s on recordings older than 1 days.
const MAX_AGE_DAYS = 1;

/**
 * --snapshot: Save ALL current dist/assets/*.{css,js} into the cache.
 * This runs BEFORE build (before prepareOutDirPlugin wipes dist/).
 * In CI, the GitHub Actions cache restores dist/assets/ from the previous deploy.
 */
function snapshot() {
  console.log('📸 Snapshotting current dist/assets/ for Clarity recording continuity...');

  if (!fs.existsSync(DIST_ASSETS)) {
    console.log('   dist/assets/ does not exist — nothing to snapshot');
    console.log('   (First deploy or cache miss — old recordings may lose styling)');
    return;
  }

  const files = fs.readdirSync(DIST_ASSETS).filter(f =>
    ASSET_EXTENSIONS.some(ext => f.endsWith(ext))
  );

  if (files.length === 0) {
    console.log('   No CSS/JS files found in dist/assets/ — skipping');
    return;
  }

  fs.mkdirSync(CACHE_DIR, { recursive: true });

  // Load existing manifest (may have entries from previous deploys via GH Actions cache)
  const manifestPath = path.join(CACHE_DIR, '_manifest.json');
  let manifest = {};
  if (fs.existsSync(manifestPath)) {
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch {}
  }

  const now = new Date().toISOString();
  let copied = 0;
  let skipped = 0;

  for (const file of files) {
    const src = path.join(DIST_ASSETS, file);
    const dest = path.join(CACHE_DIR, file);

    if (fs.existsSync(dest)) {
      // Already in cache — just update lastSeen
      if (manifest[file]) manifest[file].lastSeen = now;
      skipped++;
      continue;
    }

    fs.copyFileSync(src, dest);
    manifest[file] = { firstSeen: now, lastSeen: now };
    copied++;
  }

  // Prune expired entries from manifest (files older than MAX_AGE_DAYS).
  // Aging is by `firstSeen` so retention is bounded even for assets that
  // keep showing up in dist/ across consecutive builds.
  const maxAgeMs = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const nowMs = Date.now();
  let pruned = 0;
  for (const [file, entry] of Object.entries(manifest)) {
    if (entry.firstSeen && (nowMs - new Date(entry.firstSeen).getTime()) > maxAgeMs) {
      // Remove expired asset from cache
      const cached = path.join(CACHE_DIR, file);
      if (fs.existsSync(cached)) fs.unlinkSync(cached);
      delete manifest[file];
      pruned++;
    }
  }

  // Orphan reconciliation: any file in .clarity-asset-cache/ NOT referenced
  // by the manifest is deleted. Without this, files that ended up in the
  // cache directory through any path that bypasses manifest tracking
  // (manifest corruption, manual copy, partial write from a killed process)
  // would leak forever — neither the prune above nor the snapshot copy
  // loop ever sees them. Excludes _manifest.json (the manifest itself) and
  // any other underscore-prefixed metadata file.
  const trackedFiles = new Set(Object.keys(manifest));
  let orphans = 0;
  for (const file of fs.readdirSync(CACHE_DIR)) {
    if (file.startsWith('_')) continue; // _manifest.json and friends
    if (trackedFiles.has(file)) continue;
    if (!ASSET_EXTENSIONS.some(ext => file.endsWith(ext))) continue;
    fs.unlinkSync(path.join(CACHE_DIR, file));
    orphans++;
  }

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(`   Snapshot: ${copied} new, ${skipped} already cached, ${pruned} expired & pruned, ${orphans} orphan files reconciled`);
  console.log(`   Total in cache: ${Object.keys(manifest).length} assets`);
  console.log('   ✅ Assets cached for post-build merge');
}

/**
 * --merge: Copy cached assets into the fresh dist/assets/.
 * Skips files that already exist (same hash = same filename).
 * Skips files older than MAX_AGE_DAYS.
 */
function merge() {
  console.log('🔀 Merging previous CSS/JS assets into dist/ for Clarity...');

  if (!fs.existsSync(CACHE_DIR)) {
    console.log('   No cached assets found — skipping');
    return;
  }

  if (!fs.existsSync(DIST_ASSETS)) {
    console.log('   dist/assets/ does not exist — skipping');
    return;
  }

  const manifestPath = path.join(CACHE_DIR, '_manifest.json');
  let manifest = {};
  if (fs.existsSync(manifestPath)) {
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch {}
  }

  const maxAgeMs = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const now = Date.now();

  const files = fs.readdirSync(CACHE_DIR).filter(f =>
    !f.startsWith('_') && ASSET_EXTENSIONS.some(ext => f.endsWith(ext))
  );

  let merged = 0;
  let skippedExists = 0;
  let skippedOld = 0;

  for (const file of files) {
    const entry = manifest[file];
    if (entry?.firstSeen) {
      const age = now - new Date(entry.firstSeen).getTime();
      if (age > maxAgeMs) {
        skippedOld++;
        continue;
      }
    }

    const dest = path.join(DIST_ASSETS, file);
    if (fs.existsSync(dest)) {
      skippedExists++;
      continue;
    }

    fs.copyFileSync(path.join(CACHE_DIR, file), dest);
    merged++;
  }

  console.log(`   Merged: ${merged}, already in build: ${skippedExists}, expired (>${MAX_AGE_DAYS}d): ${skippedOld}`);
  console.log('   ✅ Previous assets preserved for Clarity recording playback');
}

// ── CLI ──
const cmd = process.argv[2];
if (cmd === '--snapshot') {
  snapshot();
} else if (cmd === '--merge') {
  merge();
} else {
  console.error('Usage: node preserve-clarity-assets.mjs --snapshot | --merge');
  process.exit(1);
}
