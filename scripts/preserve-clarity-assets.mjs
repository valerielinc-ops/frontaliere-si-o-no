#!/usr/bin/env node
/**
 * preserve-clarity-assets.mjs
 *
 * Downloads CSS and JS assets from the currently-deployed site so they survive
 * the next deploy. Microsoft Clarity session recordings reference specific
 * hashed asset URLs; if those files 404 after a deploy, recordings render
 * without styling.
 *
 * Usage:
 *   BEFORE build:  node scripts/preserve-clarity-assets.mjs --download
 *                  → Fetches live index.html, extracts asset URLs, downloads them
 *                    to .clarity-asset-cache/
 *
 *   AFTER build:   node scripts/preserve-clarity-assets.mjs --merge
 *                  → Copies cached assets into dist/assets/ (skips files that
 *                    already exist from the fresh build)
 *
 * The cache directory is gitignored and ephemeral (CI-only).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(ROOT, '.clarity-asset-cache');
const DIST_ASSETS = path.join(ROOT, 'dist', 'assets');
const SITE_URL = 'https://frontaliereticino.ch';

// Only preserve CSS and JS — these are what Clarity needs for recording playback.
// Images, fonts, and HTML are not needed (Clarity caches those separately or
// they don't affect recording fidelity).
const ASSET_EXTENSIONS = ['.css', '.js'];

// Maximum age for cached assets (30 days). Older recordings are rarely replayed,
// and keeping too many old assets bloats the deploy artifact.
const MAX_AGE_DAYS = 30;

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Clarity-Asset-Preserver/1.0' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

async function fetchBuffer(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Clarity-Asset-Preserver/1.0' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) return null; // Silently skip 404s — asset may have been purged
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Extract hashed asset URLs from HTML content.
 * Matches patterns like: /assets/index-A3bC4dEf.css, /assets/vendor-react-XyZ123.js
 */
function extractAssetUrls(html) {
  const urls = new Set();
  // Match src="..." and href="..." pointing to /assets/
  const regex = /(?:src|href)=["']([^"']*\/assets\/[^"']+)["']/g;
  let m;
  while ((m = regex.exec(html)) !== null) {
    const assetPath = m[1];
    if (ASSET_EXTENSIONS.some(ext => assetPath.endsWith(ext))) {
      urls.add(assetPath);
    }
  }
  // Also match dynamic imports in inline scripts: import("/assets/...")
  const importRegex = /import\s*\(\s*["']([^"']*\/assets\/[^"']+)["']\s*\)/g;
  while ((m = importRegex.exec(html)) !== null) {
    const assetPath = m[1];
    if (ASSET_EXTENSIONS.some(ext => assetPath.endsWith(ext))) {
      urls.add(assetPath);
    }
  }
  return [...urls];
}

async function download() {
  console.log('📦 Downloading current live assets for Clarity recording continuity...');

  // Step 1: Fetch the live index.html
  let html;
  try {
    html = await fetchText(SITE_URL);
  } catch (err) {
    console.warn(`⚠️  Could not fetch live site (${err.message}) — skipping asset preservation`);
    process.exit(0); // Non-blocking: fresh deploy will work, just old recordings may break
  }

  // Step 2: Extract asset URLs
  const assetPaths = extractAssetUrls(html);
  console.log(`   Found ${assetPaths.length} CSS/JS assets on live site`);

  if (assetPaths.length === 0) {
    console.log('   No assets to preserve');
    return;
  }

  // Step 3: Create cache directory
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  // Step 4: Download each asset
  let downloaded = 0;
  let skipped = 0;
  for (const assetPath of assetPaths) {
    const filename = path.basename(assetPath);
    const cachePath = path.join(CACHE_DIR, filename);

    // Skip if already cached
    if (fs.existsSync(cachePath)) {
      skipped++;
      continue;
    }

    const url = assetPath.startsWith('http') ? assetPath : `${SITE_URL}${assetPath}`;
    const buf = await fetchBuffer(url);
    if (buf) {
      fs.writeFileSync(cachePath, buf);
      downloaded++;
    }
  }

  console.log(`   Downloaded: ${downloaded}, already cached: ${skipped}`);

  // Step 5: Write a manifest with timestamps for age-based cleanup
  const manifestPath = path.join(CACHE_DIR, '_manifest.json');
  let manifest = {};
  if (fs.existsSync(manifestPath)) {
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch {}
  }
  const now = new Date().toISOString();
  for (const assetPath of assetPaths) {
    const filename = path.basename(assetPath);
    if (!manifest[filename]) {
      manifest[filename] = { firstSeen: now, lastSeen: now };
    } else {
      manifest[filename].lastSeen = now;
    }
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log('   ✅ Assets cached for post-build merge');
}

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

  // Load manifest for age filtering
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
    // Skip assets older than MAX_AGE_DAYS
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
      skippedExists++; // Current build already has this file (hash unchanged)
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
if (cmd === '--download') {
  download().catch(err => { console.error('❌', err.message); process.exit(1); });
} else if (cmd === '--merge') {
  merge();
} else {
  console.error('Usage: node preserve-clarity-assets.mjs --download | --merge');
  process.exit(1);
}
