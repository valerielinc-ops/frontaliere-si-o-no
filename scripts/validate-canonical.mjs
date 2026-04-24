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
const BASE_URL = 'https://frontaliereticino.ch';

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

// Check if content is a thin bridge page (old-style redirect)
function isBridgePage(content) {
  return content.includes('Versione canonica disponibile');
}

// Check if content is a full-content previousSlug bridge page.
// These intentionally have canonical → current slug (not self-referencing)
// because they serve identical content at the old URL while consolidating
// search signals to the canonical slug. This is correct SEO behavior.
function isPreviousSlugBridgePage(content) {
  return content.includes('__BRIDGE_TARGET_SLUG__');
}

// Legacy English-content alias pages at the root. These carry English body
// copy but legitimately canonicalize to their /en/ cluster counterparts to
// consolidate PageRank onto the canonical EN slug (see staticPagesPlugin.ts).
// The mapping is exhaustive; any future alias must be added here.
const LEGACY_ALIAS_CANONICALS = new Map([
  ['/about/', '/en/about-us/'],
  ['/about', '/en/about-us/'],
  ['/contact/', '/en/contact-us/'],
  ['/contact', '/en/contact-us/'],
  ['/privacy-policy/', '/en/privacy/'],
  ['/privacy-policy', '/en/privacy/'],
]);

function isLegitLegacyAliasCanonicalization(url, canonical) {
  const urlPath = url.replace(BASE_URL, '');
  const canonPath = canonical.replace(BASE_URL, '');
  const expected = LEGACY_ALIAS_CANONICALS.get(urlPath);
  if (!expected) return false;
  return canonPath === expected;
}

// Check if a canonical mismatch is legitimate job-section consolidation.
// Job pages under /cerca-lavoro-ticino/ legitimately point canonical to
// other job pages in the same section for: previousSlugs bridges,
// locale-variant legacy redirects, and dedup suffix changes.
// The one BAD case (canonical → listing page without sub-path) is excluded.
function isLegitJobCanonicalConsolidation(url, canonical) {
  const JOB_SECTION = '/cerca-lavoro-ticino/';
  const urlPath = url.replace(BASE_URL, '');
  const canonPath = canonical.replace(BASE_URL, '');

  // Both must be in the job section
  if (!urlPath.startsWith(JOB_SECTION) || !canonPath.startsWith(JOB_SECTION)) return false;

  // Canonical pointing to the listing page root (no sub-path) is a BUG, not consolidation
  const canonSubPath = canonPath.slice(JOB_SECTION.length).replace(/\/$/, '');
  if (!canonSubPath) return false;

  // Canonical points to a specific job page within the section — legitimate consolidation
  return true;
}

// Main validation
const sitemapUrls = extractSitemapUrls();
console.log(`[validate-canonical] Checking ${sitemapUrls.size} sitemap URLs...\n`);

const errors = [];
const warnings = [];
let bridgeSkipped = 0;

for (const url of sitemapUrls) {
  const htmlFile = findHtmlFile(url);

  if (!htmlFile) {
    // Missing file is caught by validate-sitemap-links, skip here
    continue;
  }

  // Read full file for bridge detection (BRIDGE_TARGET can be deep in <head>
  // after large JSON-LD blocks), then slice for other checks.
  const fullContent = fs.readFileSync(htmlFile, 'utf-8');
  const content = fullContent.slice(0, 8000);

  // Check 1: Thin "Versione canonica" bridge page in sitemap
  if (isBridgePage(content)) {
    errors.push({
      url,
      issue: 'Sitemap URL is a thin "Versione canonica" bridge page — will be flagged by Google as redirect',
    });
    continue;
  }

  // Check 2: previousSlug / locale-variant bridge pages — intentional non-self
  // canonical. These serve full content at old/alternate URLs with canonical
  // pointing to the current active slug. Also covers legacy locale bridges
  // (e.g., EN slug in IT section) and buildCanonicalBridgePage() output.
  if (isPreviousSlugBridgePage(fullContent)) {
    bridgeSkipped++;
    continue;
  }

  // Check 3: Canonical mismatch
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
      // Check if this is a legacy English-content alias canonicalizing to
      // its /en/ cluster counterpart (see LEGACY_ALIAS_CANONICALS).
      if (isLegitLegacyAliasCanonicalization(url, canonical)) {
        bridgeSkipped++;
        continue;
      }
      // Check if this is legitimate job-section canonical consolidation
      // (previousSlugs, locale variants, dedup suffix changes)
      if (isLegitJobCanonicalConsolidation(url, canonical)) {
        bridgeSkipped++;
      } else {
        errors.push({
          url,
          issue: `Canonical mismatch: canonical → ${canonical} (different page)`,
        });
      }
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

if (bridgeSkipped > 0) {
  console.log(`ℹ️  ${bridgeSkipped} previousSlug bridge page(s) skipped (canonical → current slug is correct).`);
}

if (errors.length === 0) {
  console.log('\n✅ No blocking canonical errors.');
  process.exit(0);
} else {
  console.log(`\n🛑 ${errors.length} blocking error(s) found. Fix before deploying.`);
  process.exit(1);
}
