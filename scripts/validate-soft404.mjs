#!/usr/bin/env node
/**
 * Post-build CI gate: detects soft-404 indicators in static HTML pages.
 *
 * For every URL in the sitemaps, this script checks the generated dist/ HTML for:
 *   1. Minimum visible text content (stripped of HTML tags)
 *   2. Expired/archive job pages have <meta name="robots" content="noindex...">
 *   3. Pages indexed in sitemaps are not thin shells (skeleton-only)
 *
 * Exits with code 1 if any page fails validation, blocking the deploy.
 *
 * Usage:
 *   node scripts/validate-soft404.mjs                # full validation
 *   node scripts/validate-soft404.mjs --warn-only    # report issues but don't block
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DIST = path.join(ROOT, 'dist');
const BASE_URL = 'https://frontaliereticino.ch';
const WARN_ONLY = process.argv.includes('--warn-only');

// Minimum visible text characters for a page to not be flagged as soft 404.
// Includes JSON-LD text which is visible to Google's structured data parser.
const MIN_TEXT_CHARS = 800;
// Pages below this are definitely problematic
const CRITICAL_TEXT_CHARS = 400;

// ── Helpers ──────────────────────────────────────────────────────────

function extractLocs(xml) {
  const re = /<loc>\s*(https?:\/\/[^<]+?)\s*<\/loc>/gi;
  const urls = [];
  let m;
  while ((m = re.exec(xml)) !== null) urls.push(m[1].trim());
  return urls;
}

function extractHreflangs(xml) {
  const re = /<xhtml:link[^>]*href="(https?:\/\/[^"]+)"[^>]*\/?\s*>/gi;
  const urls = new Set();
  let m;
  while ((m = re.exec(xml)) !== null) urls.add(m[1].trim());
  return [...urls];
}

function urlToDistPath(url) {
  let rel = url.replace(BASE_URL, '').replace(/\/$/, '') || '/';
  if (rel === '/') return path.join(DIST, 'index.html');
  rel = rel.startsWith('/') ? rel.slice(1) : rel;
  return path.join(DIST, rel, 'index.html');
}

/** Strip HTML tags and entities, return visible text only. */
function extractVisibleText(html) {
  return html
    // Remove <script> and <style> blocks entirely
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    // Remove HTML tags
    .replace(/<[^>]+>/g, ' ')
    // Decode common HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&[a-z]+;/gi, ' ')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

/** Check if a page has noindex in its robots meta tag. */
function hasNoindex(html) {
  const match = html.match(/<meta\s+name=["']robots["']\s+content=["']([^"']+)["']/i);
  return match ? match[1].toLowerCase().includes('noindex') : false;
}

/** Check if a page is an expired job archive page (has archive indicators). */
function isExpiredJobArchive(html) {
  // Archive pages have specific copy patterns
  return (
    /questa posizione.*non.*più disponibile/i.test(html) ||
    /this position.*no longer available/i.test(html) ||
    /diese stelle.*nicht mehr verfügbar/i.test(html) ||
    /ce poste.*plus disponible/i.test(html) ||
    /posizioni aperte simili/i.test(html) ||
    /similar open positions/i.test(html)
  );
}

/** Detect skeleton-dominated pages (more gray boxes than content). */
function isSkeletonDominated(html) {
  const skeletonCount = (html.match(/background:#e2e8f0/g) || []).length;
  const textLen = extractVisibleText(html).length;
  // If skeleton placeholders outnumber substantial text, flag it
  return skeletonCount >= 3 && textLen < 1200;
}

// ── Main ─────────────────────────────────────────────────────────────

console.log('\n🔍 Soft-404 Validation\n');

// Discover sitemap files (skip sitemap-jobs.xml — job pages have different rules)
const sitemapDir = path.join(DIST.replace('/dist', ''), 'public');
const sitemapFiles = readdirSync(sitemapDir)
  .filter(f => f.startsWith('sitemap-') && f.endsWith('.xml') && f !== 'sitemap-jobs.xml')
  .sort();

const issues = [];
let totalChecked = 0;
let skippedMissing = 0;

for (const file of sitemapFiles) {
  const xml = readFileSync(path.join(sitemapDir, file), 'utf-8');
  const locs = extractLocs(xml);
  const hreflangs = extractHreflangs(xml);
  const allUrls = [...new Set([...locs, ...hreflangs])];
  let fileIssues = 0;

  for (const url of allUrls) {
    const distPath = urlToDistPath(url);
    if (!existsSync(distPath)) {
      skippedMissing++;
      continue; // validate-sitemap-links.mjs handles missing files
    }

    totalChecked++;
    const html = readFileSync(distPath, 'utf-8');
    const visibleText = extractVisibleText(html);
    const textLen = visibleText.length;
    const noindex = hasNoindex(html);
    const isArchive = isExpiredJobArchive(html);
    const relPath = url.replace(BASE_URL, '');

    // Rule 1: Archive/expired pages MUST have noindex
    if (isArchive && !noindex) {
      issues.push({
        severity: 'error',
        url: relPath,
        sitemap: file,
        message: `Expired job archive page missing noindex meta tag`,
      });
      fileIssues++;
    }

    // Rule 2: Indexed pages (no noindex) must have minimum text content
    if (!noindex && textLen < MIN_TEXT_CHARS) {
      const severity = textLen < CRITICAL_TEXT_CHARS ? 'error' : 'warning';
      issues.push({
        severity,
        url: relPath,
        sitemap: file,
        message: `Thin content: ${textLen} chars (min: ${MIN_TEXT_CHARS})`,
      });
      fileIssues++;
    }

    // Rule 3: Skeleton-dominated pages are soft-404 candidates
    if (!noindex && isSkeletonDominated(html)) {
      issues.push({
        severity: 'warning',
        url: relPath,
        sitemap: file,
        message: `Skeleton-dominated: gray placeholders dominate over text content`,
      });
      fileIssues++;
    }

    // Rule 4: Sitemap pages MUST NOT have noindex (they're meant to be indexed)
    if (noindex && !isArchive) {
      issues.push({
        severity: 'error',
        url: relPath,
        sitemap: file,
        message: `Sitemap URL has noindex — will be excluded from Google index`,
      });
      fileIssues++;
    }
  }

  const status = fileIssues === 0 ? '✅' : '⚠️';
  console.log(`  ${status} ${file}: ${allUrls.length} URLs, ${fileIssues} issues`);
}

console.log(`\n📊 Checked ${totalChecked} pages across ${sitemapFiles.length} sitemaps (${skippedMissing} missing files skipped)`);

const errors = issues.filter(i => i.severity === 'error');
const warnings = issues.filter(i => i.severity === 'warning');

if (warnings.length > 0) {
  console.warn(`\n⚠️  ${warnings.length} warning(s):\n`);
  for (const w of warnings.slice(0, 20)) {
    console.warn(`  ⚠️  [${w.sitemap}] ${w.url}`);
    console.warn(`     ${w.message}`);
  }
  if (warnings.length > 20) console.warn(`  ... and ${warnings.length - 20} more`);
}

if (errors.length > 0) {
  console.error(`\n❌ ${errors.length} error(s):\n`);
  for (const e of errors.slice(0, 20)) {
    console.error(`  ❌ [${e.sitemap}] ${e.url}`);
    console.error(`     ${e.message}`);
  }
  if (errors.length > 20) console.error(`  ... and ${errors.length - 20} more`);
}

if (errors.length > 0 && !WARN_ONLY) {
  console.error(
    '\n💡 Fix options:\n' +
    '  • Add/enrich editorial content in build-plugins/editorialContent.ts\n' +
    '  • Add <meta name="robots" content="noindex"> for expired/archive pages\n' +
    '  • Remove thin pages from sitemaps if they have no real content\n' +
    '  • Ensure SEO_METADATA entry exists with proper canonicalPath\n'
  );
  process.exit(1);
}

if (issues.length === 0) {
  console.log('\n✅ No soft-404 indicators found.\n');
} else {
  console.log(`\n${WARN_ONLY ? '⚠️  Issues found but --warn-only mode, not blocking.' : '✅ No blocking errors.'}\n`);
}
