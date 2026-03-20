#!/usr/bin/env node
/**
 * validate-canonical.mjs — Post-build pipeline check that verifies:
 * 1. Every sitemap URL's static HTML has a self-referencing canonical tag
 *    (canonical must point to the URL itself, not a different page)
 * 2. No sitemap URL is a thin "Versione canonica" bridge page
 *
 * Exits with code 1 if blocking errors are found, blocking deployment.
 *
 * Usage: node scripts/validate-canonical.mjs
 */

import fs from 'fs';
import path from 'path';

const DIST = path.resolve('dist');
const BASE_URL = 'https://www.frontaliereticino.ch';

// Parse all sitemap XML files and extract <loc> URLs
function extractSitemapUrls() {
  const urls = new Set();
  const sitemapDir = DIST;

  for (const file of fs.readdirSync(sitemapDir)) {
    if (!file.startsWith('sitemap') || !file.endsWith('.xml')) continue;
    // Skip sitemap index
    if (file === 'sitemap.xml') continue;
    const content = fs.readFileSync(path.join(sitemapDir, file), 'utf-8');
    const locRegex = /<loc>([^<]+)<\/loc>/g;
    let match;
    while ((match = locRegex.exec(content)) !== null) {
      const url = match[1].trim();
      if (url.startsWith(BASE_URL)) {
        urls.add(url);
      }
    }
  }
  return urls;
}

// For a given URL, find the static HTML file in dist/
function findHtmlFile(url) {
  const urlPath = url.replace(BASE_URL, '').replace(/\/$/, '');
  if (!urlPath || urlPath === '') {
    // Root URL
    const indexPath = path.join(DIST, 'index.html');
    return fs.existsSync(indexPath) ? indexPath : null;
  }

  // Try directory/index.html first (trailing-slash canonical)
  const dirIndex = path.join(DIST, urlPath.replace(/^\//, ''), 'index.html');
  if (fs.existsSync(dirIndex)) return dirIndex;

  // Try flat .html file
  const flatFile = path.join(DIST, urlPath.replace(/^\//, '') + '.html');
  if (fs.existsSync(flatFile)) return flatFile;

  return null;
}

// Extract canonical URL from HTML content
function extractCanonical(content) {
  const match = content.match(/<link\s+rel="canonical"\s+href="([^"]+)"/);
  return match ? match[1] : null;
}

// Check if content is a thin bridge page
function isBridgePage(content) {
  return content.includes('Versione canonica disponibile');
}

// Main validation
const sitemapUrls = extractSitemapUrls();
console.log(`[validate-canonical] Checking ${sitemapUrls.size} sitemap URLs...\n`);

const errors = [];
const warnings = [];

for (const url of sitemapUrls) {
  const htmlFile = findHtmlFile(url);

  if (!htmlFile) {
    // Missing file is caught by validate-sitemap-links, skip here
    continue;
  }

  const content = fs.readFileSync(htmlFile, 'utf-8').slice(0, 3000);

  // Check 1: Bridge page in sitemap
  if (isBridgePage(content)) {
    errors.push({
      url,
      issue: 'Sitemap URL is a thin "Versione canonica" bridge page — will be flagged by Google as redirect',
    });
    continue;
  }

  // Check 2: Canonical mismatch
  const canonical = extractCanonical(content);
  if (!canonical) {
    warnings.push({ url, issue: 'No canonical tag found' });
    continue;
  }

  // Normalize for comparison (trailing slash)
  const normalizeUrl = (u) => u.replace(/\/$/, '');
  if (normalizeUrl(canonical) !== normalizeUrl(url)) {
    // Check if it's just trailing-slash difference
    const canonPath = canonical.replace(BASE_URL, '');
    const urlPath = url.replace(BASE_URL, '');
    const isSlashDiff = normalizeUrl(canonPath) === normalizeUrl(urlPath);

    if (!isSlashDiff) {
      errors.push({
        url,
        issue: `Canonical mismatch: canonical → ${canonical} (different page)`,
      });
    }
    // Trailing-slash difference is fine — not an error
  }
}

// Report
if (errors.length > 0) {
  console.log(`❌ ${errors.length} blocking error(s):\n`);
  for (const e of errors.slice(0, 20)) {
    console.log(`  ❌ ${e.url}`);
    console.log(`     ${e.issue}`);
  }
  if (errors.length > 20) {
    console.log(`  ... and ${errors.length - 20} more`);
  }
}

if (warnings.length > 0) {
  console.log(`\n⚠️  ${warnings.length} warning(s):\n`);
  for (const w of warnings.slice(0, 10)) {
    console.log(`  ⚠️  ${w.url}`);
    console.log(`     ${w.issue}`);
  }
  if (warnings.length > 10) {
    console.log(`  ... and ${warnings.length - 10} more`);
  }
}

if (errors.length === 0 && warnings.length === 0) {
  console.log('✅ All sitemap URLs have correct self-referencing canonical tags.');
}

if (errors.length === 0) {
  console.log('\n✅ No blocking canonical errors.');
  process.exit(0);
} else {
  console.log(`\n🛑 ${errors.length} blocking error(s) found. Fix before deploying.`);
  process.exit(1);
}
