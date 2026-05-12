#!/usr/bin/env node
/**
 * Post-build CI gate: validates that every URL listed in every sitemap
 * has a corresponding static HTML file in dist/.
 *
 * Checks both <loc> URLs and hreflang <xhtml:link> alternate URLs.
 * Exits with code 1 if any sitemap URL is missing its dist/ page,
 * blocking the deploy.
 *
 * Usage:
 *   node scripts/validate-sitemap-links.mjs            # validate all sitemaps
 *   node scripts/validate-sitemap-links.mjs --loc-only  # validate <loc> URLs only (skip hreflang)
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { writeAuditReport } from './lib/auditReport.mjs';

const ROOT = process.cwd();
const DIST = path.join(ROOT, 'dist');
const BASE_URL = 'https://frontaliereticino.ch';
const LOC_ONLY = process.argv.includes('--loc-only');

// ── Helpers ──────────────────────────────────────────────────────────

/** Extract all <loc> URLs from a sitemap XML string. */
function extractLocs(xml) {
  const re = /<loc>\s*(https?:\/\/[^<]+?)\s*<\/loc>/gi;
  const urls = [];
  let m;
  while ((m = re.exec(xml)) !== null) urls.push(m[1].trim());
  return urls;
}

/** Extract all hreflang alternate URLs from a sitemap XML string. */
function extractHreflangs(xml) {
  const re = /<xhtml:link[^>]*href="(https?:\/\/[^"]+)"[^>]*\/?\s*>/gi;
  const urls = new Set();
  let m;
  while ((m = re.exec(xml)) !== null) urls.add(m[1].trim());
  return [...urls];
}

/**
 * Convert an absolute URL to the expected dist/ file path.
 * e.g. https://frontaliereticino.ch/calcola-stipendio/ → dist/calcola-stipendio/index.html
 *      https://frontaliereticino.ch/                    → dist/index.html
 */
function urlToDistPath(url) {
  let pathname = url.replace(BASE_URL, '');
  // Remove trailing slash for consistency, but keep root as /
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }
  if (pathname === '' || pathname === '/') {
    return path.join(DIST, 'index.html');
  }
  // Strip leading slash
  const rel = pathname.startsWith('/') ? pathname.slice(1) : pathname;
  // If the URL has a file extension (e.g. .pdf, .xml), check the file directly
  if (path.extname(rel)) {
    return path.join(DIST, rel);
  }
  return path.join(DIST, rel, 'index.html');
}

// ── Main ─────────────────────────────────────────────────────────────

// Discover all sitemap XML files in dist/ (copied from public/ by Vite)
const sitemapFiles = readdirSync(DIST)
  .filter((f) => f.startsWith('sitemap') && f.endsWith('.xml'))
  .sort();

if (sitemapFiles.length === 0) {
  console.error('❌ No sitemap XML files found in dist/');
  process.exit(1);
}

console.log(`\n🔍 Validating sitemap links against dist/ (mode: ${LOC_ONLY ? 'loc-only' : 'loc + hreflang'})…\n`);

let totalUrls = 0;
let missingCount = 0;
const missing = []; // { sitemap, url, distPath }

for (const file of sitemapFiles) {
  const filePath = path.join(DIST, file);
  const xml = readFileSync(filePath, 'utf-8');

  // Skip the sitemap index (it only has <loc>s pointing to sub-sitemaps, not pages)
  if (xml.includes('<sitemapindex')) {
    console.log(`  ⏭️  ${file} (sitemap index — skipped)`);
    continue;
  }

  const locs = extractLocs(xml);
  const hreflangs = LOC_ONLY ? [] : extractHreflangs(xml);

  // Combine and deduplicate
  const allUrls = [...new Set([...locs, ...hreflangs])].filter(
    (u) => u.startsWith(BASE_URL)
  );

  let fileMissing = 0;

  for (const url of allUrls) {
    totalUrls++;
    const distPath = urlToDistPath(url);
    if (!existsSync(distPath)) {
      fileMissing++;
      missingCount++;
      missing.push({ sitemap: file, url, distPath });
    }
  }

  const status = fileMissing === 0 ? '✅' : '❌';
  console.log(`  ${status} ${file}: ${allUrls.length} URLs checked, ${fileMissing} missing`);
}

console.log(`\n📊 Total: ${totalUrls} URLs checked across ${sitemapFiles.length} sitemaps`);

const _byFeatureForReport = {};
for (const m of missing) {
  _byFeatureForReport[m.sitemap] = (_byFeatureForReport[m.sitemap] ?? 0) + 1;
}

if (missingCount > 0) {
  console.error(`\n❌ ${missingCount} sitemap URL(s) have no corresponding static page in dist/:\n`);
  for (const { sitemap, url } of missing) {
    console.error(`  • [${sitemap}] ${url}`);
  }
  console.error(
    '\n💡 Fix: Ensure the page has a SEO_METADATA entry with canonicalPath, ' +
    'is listed in the correct sitemap, and the build plugin generates its static HTML.\n'
  );
  await writeAuditReport({
    audit: 'validate-sitemap-links',
    passed: false,
    threshold: { metric: 'count', value: 0, comparator: '<=' },
    offenders: missing.map((m) => ({
      path: m.url,
      feature: m.sitemap,
      metric: 1,
      ratio: null,
      distPath: m.distPath,
    })),
    byFeature: _byFeatureForReport,
    extra: { totalUrls, sitemapFiles: sitemapFiles.length },
  });
  process.exit(1);
}

console.log('\n✅ All sitemap URLs have corresponding static pages in dist/.\n');
await writeAuditReport({
  audit: 'validate-sitemap-links',
  passed: true,
  threshold: { metric: 'count', value: 0, comparator: '<=' },
  offenders: [],
  extra: { totalUrls, sitemapFiles: sitemapFiles.length },
});
