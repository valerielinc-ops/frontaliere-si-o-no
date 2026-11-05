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
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeAuditReport } from './lib/auditReport.mjs';
import { isExternallyServedUrl } from './lib/externally-served-paths.mjs';
import { flatString } from './lib/flat-string.mjs';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';

const ROOT = process.cwd();
const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const BASE_URL = 'https://frontaliereticino.ch';
const BASE_ORIGIN = new URL(BASE_URL).origin;
const LOCALES = ['it', 'en', 'de', 'fr'];
const PAGE_MANIFEST_VERSION = 2;
const PAGE_VALIDATOR_VERSION = 'publisher-page-index-v2';
const LOC_ONLY = process.argv.includes('--loc-only');
const OWNED_LOCALE = flagValue('--owned-locale');
const MANIFEST_OUT = flagValue('--manifest-out');
const VERIFY_MANIFEST = flagValue('--verify-manifest');
const IS_MAIN = isInvokedDirectly(import.meta.url);
const SECTION_SLUGS = JSON.parse(readFileSync(path.join(SCRIPT_ROOT, 'scripts/lib/section-shard-slugs.json'), 'utf8'));

function flagValue(name) {
  const prefix = `${name}=`;
  const arg = process.argv.find((candidate) => candidate.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Extract all <loc> URLs from a sitemap XML string. */
function extractLocs(xml) {
  const re = /<loc>\s*(https?:\/\/[^<]+?)\s*<\/loc>/gi;
  const urls = [];
  let m;
  // flatString: a `<loc>` capture slices INTO the whole sitemap XML, and the
  // derived URLs outlive it in a cross-sitemap accumulator — see
  // scripts/lib/flat-string.mjs (issue #7419).
  while ((m = re.exec(xml)) !== null) urls.push(flatString(m[1].trim()));
  return urls;
}

/** Extract all hreflang alternate URLs from a sitemap XML string. */
function extractHreflangs(xml) {
  const re = /<xhtml:link[^>]*href="(https?:\/\/[^"]+)"[^>]*\/?\s*>/gi;
  const urls = new Set();
  let m;
  while ((m = re.exec(xml)) !== null) urls.add(flatString(m[1].trim()));
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

/**
 * Return every static file shape that can answer a route in the Pages shard.
 * The audit accepts both /route/index.html and the historical flat
 * /route.html form, so the pre-prune check must use the same boundary.
 */
function urlToDistCandidates(url, distDir = DIST) {
  let pathname;
  try {
    const parsed = new URL(url);
    if (parsed.origin !== BASE_ORIGIN) return [];
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return [];
  }

  if (pathname.includes(String.fromCharCode(0))) return [];
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
  if (pathname === '' || pathname === '/') return [path.join(distDir, 'index.html')];

  const rel = pathname.startsWith('/') ? pathname.slice(1) : pathname;
  if (rel.split('/').some((segment) => segment === '..')) return [];
  if (path.extname(rel)) return [path.join(distDir, rel)];

  return [
    path.join(distDir, rel, 'index.html'),
    path.join(distDir, `${rel}.html`),
  ];
}

function isRegularFile(file) {
  try {
    return existsSync(file) && statSync(file).isFile();
  } catch {
    return false;
  }
}

function sameOriginPath(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin === BASE_ORIGIN ? parsed.pathname : null;
  } catch {
    return null;
  }
}

function ownsSitemapUrl(url, locale) {
  const pathname = sameOriginPath(url);
  if (!pathname || !LOCALES.includes(locale)) return false;
  if (locale === 'it') {
    return !LOCALES.filter((candidate) => candidate !== 'it')
      .some((other) => pathname === `/${other}`
        || pathname === `/${other}.html`
        || pathname.startsWith(`/${other}/`));
  }
  return pathname === `/${locale}`
    || pathname === `/${locale}.html`
    || pathname.startsWith(`/${locale}/`);
}

function relativeDistPath(file, distDir = DIST) {
  const relative = path.relative(distDir, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

function sectionForUrl(url, locale) {
  const pathname = sameOriginPath(url);
  if (!pathname) return null;
  for (const [section, locales] of Object.entries(SECTION_SLUGS)) {
    const slug = locales?.[locale];
    if (!slug) continue;
    const prefix = locale === 'it' ? `/${slug}` : `/${locale}/${slug}`;
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return section;
  }
  return null;
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function localeSitemapFiles(distDir = DIST) {
  return readdirSync(distDir)
    .filter((file) => file.startsWith('sitemap') && file.endsWith('.xml'))
    .sort();
}

function collectOwnedLocaleEntries(locale, distDir = DIST) {
  const sitemapFiles = localeSitemapFiles(distDir);
  if (sitemapFiles.length === 0) {
    throw new Error('No sitemap XML files found in dist/');
  }

  const entries = new Map();
  for (const file of sitemapFiles) {
    const xml = readFileSync(path.join(distDir, file), 'utf-8');
    if (/<sitemapindex\b/i.test(xml)) continue;

    const urls = [...new Set([...extractLocs(xml), ...extractHreflangs(xml)])]
      .filter((url) => ownsSitemapUrl(url, locale))
      .filter((url) => !isExternallyServedUrl(url));
    for (const url of urls) {
      if (!entries.has(url)) entries.set(url, { sitemap: file, url });
    }
  }

  const missing = [];
  const resolvedEntries = [];
  for (const entry of entries.values()) {
    const candidates = urlToDistCandidates(entry.url, distDir);
    const pageFile = candidates.find(isRegularFile);
    if (!pageFile) {
      missing.push({ ...entry, candidates: candidates.map((file) => relativeDistPath(file, distDir)).filter(Boolean) });
      continue;
    }
    const pagePath = relativeDistPath(pageFile, distDir);
    resolvedEntries.push({
      ...entry,
      path: pagePath,
      sha256: sha256File(pageFile),
      locale,
      section: sectionForUrl(entry.url, locale),
    });
  }
  return { entries: resolvedEntries, missing, sitemapFiles };
}

function writeLocaleManifest(file, locale, entries, identity = {}) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({
    version: PAGE_MANIFEST_VERSION,
    schemaVersion: PAGE_MANIFEST_VERSION,
    kind: 'publisher-page-manifest',
    validatorVersion: PAGE_VALIDATOR_VERSION,
    locale,
    sourceRunId: String(identity.sourceRunId ?? process.env.SOURCE_RUN_ID ?? process.env.GITHUB_RUN_ID ?? ''),
    sourceSha: String(identity.sourceSha ?? process.env.SOURCE_SHA ?? process.env.GITHUB_SHA ?? '').toLowerCase(),
    artifactRunId: String(identity.artifactRunId ?? process.env.ARTIFACT_RUN_ID ?? process.env.GITHUB_RUN_ID ?? ''),
    artifactName: String(identity.artifactName ?? process.env.BASE_ARTIFACT_NAME ?? ''),
    artifactDigest: String(identity.artifactDigest ?? process.env.BASE_ARTIFACT_DIGEST ?? '').replace(/^sha256:/u, '').toLowerCase(),
    requiredSections: Array.isArray(identity.requiredSections)
      ? identity.requiredSections
      : String(process.env.LIVE_SHARD_SECTIONS ?? '').split(',').map((value) => value.trim()).filter(Boolean),
    entries: entries.map((entry) => ({
      sitemap: entry.sitemap,
      url: entry.url,
      path: entry.path,
      sha256: entry.sha256,
      locale: entry.locale ?? locale,
      section: entry.section ?? null,
    })),
  }, null, 2)}\n`);
}

function verifyLocaleManifest(file, locale, distDir = DIST) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, 'utf-8'));
  } catch (error) {
    return { errors: [`cannot read manifest ${file}: ${error instanceof Error ? error.message : String(error)}`] };
  }

  const errors = [];
  if (![1, PAGE_MANIFEST_VERSION].includes(manifest?.version)) {
    errors.push(`unsupported locale sitemap manifest version: ${String(manifest?.version)}`);
  }
  if (manifest?.locale !== locale) errors.push(`manifest locale ${JSON.stringify(manifest?.locale)} != ${JSON.stringify(locale)}`);
  if (!Array.isArray(manifest?.entries)) {
    errors.push('locale sitemap manifest entries is not an array');
    return { errors };
  }

  const seen = new Set();
  for (const entry of manifest.entries) {
    const url = typeof entry?.url === 'string' ? entry.url : '';
    if (!url || seen.has(url)) {
      errors.push(`invalid or duplicate manifest URL: ${JSON.stringify(url)}`);
      continue;
    }
    seen.add(url);
    if (!ownsSitemapUrl(url, locale) || isExternallyServedUrl(url)) {
      errors.push(`manifest URL is not owned by ${locale}: ${url}`);
      continue;
    }
    if (manifest.version === PAGE_MANIFEST_VERSION) {
      const pagePath = typeof entry?.path === 'string' ? entry.path : '';
      const digest = typeof entry?.sha256 === 'string' ? entry.sha256 : '';
      if (entry?.locale !== locale) errors.push(`manifest entry locale ${JSON.stringify(entry?.locale)} != ${locale}: ${url}`);
      if (!/^[0-9a-f]{64}$/u.test(digest)) errors.push(`manifest page digest is missing or malformed: ${url}`);
      const resolved = path.resolve(distDir, pagePath);
      const relative = path.relative(distDir, resolved);
      if (!pagePath || !relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        errors.push(`manifest page path is missing or escapes dist/: ${url}`);
      } else if (!urlToDistCandidates(url, distDir).includes(resolved)) {
        errors.push(`manifest page path does not map to its URL: ${url} (${pagePath})`);
      } else if (!isRegularFile(resolved)) {
        errors.push(`manifest page path is absent from extracted dist/: ${url} (${pagePath})`);
      } else if (/^[0-9a-f]{64}$/u.test(digest) && sha256File(resolved) !== digest) {
        errors.push(`manifest page digest does not match extracted bytes: ${url} (${pagePath})`);
      }
    }
    const candidates = urlToDistCandidates(url, distDir);
    const pageFile = manifest.version === PAGE_MANIFEST_VERSION
      ? path.resolve(distDir, entry.path)
      : null;
    if (manifest.version === PAGE_MANIFEST_VERSION) {
      if (!(pageFile && isRegularFile(pageFile))) {
        errors.push(`manifest URL has no page at its declared path: ${url} (${entry.path})`);
      }
    } else if (!candidates.some(isRegularFile)) {
      errors.push(`manifest URL has no extracted page: ${url} (candidates: ${candidates.map((filePath) => relativeDistPath(filePath, distDir)).join(', ') || 'none'})`);
    }
  }
  return { errors, entries: manifest.entries };
}

export {
  collectOwnedLocaleEntries,
  ownsSitemapUrl,
  sectionForUrl,
  urlToDistCandidates,
  verifyLocaleManifest,
  writeLocaleManifest,
};

if (IS_MAIN && VERIFY_MANIFEST) {
  if (!OWNED_LOCALE || !LOCALES.includes(OWNED_LOCALE)) {
    console.error('❌ --verify-manifest requires --owned-locale=<it|en|de|fr>');
    process.exit(1);
  }
  const result = verifyLocaleManifest(VERIFY_MANIFEST, OWNED_LOCALE);
  if (result.errors.length > 0) {
    console.error(`\n❌ Extracted locale sitemap coverage FAILED (${result.errors.length} error(s)):`);
    for (const error of result.errors.slice(0, 100)) console.error(`  • ${error}`);
    if (result.errors.length > 100) console.error(`  • … ${result.errors.length - 100} more`);
    process.exit(1);
  }
  console.log(`✅ Extracted ${result.entries.length} ${OWNED_LOCALE} sitemap route(s) have a static page.`);
  process.exit(0);
}

if (IS_MAIN && OWNED_LOCALE) {
  if (!LOCALES.includes(OWNED_LOCALE)) {
    console.error(`❌ --owned-locale must be one of ${LOCALES.join(', ')}`);
    process.exit(1);
  }
  let result;
  try {
    result = collectOwnedLocaleEntries(OWNED_LOCALE);
  } catch (error) {
    console.error(`❌ Locale sitemap coverage could not run: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  console.log(`\n🔍 Validating ${OWNED_LOCALE} sitemap routes against dist/ (${result.entries.length} owned route(s))…\n`);
  if (result.missing.length > 0) {
    console.error(`❌ ${result.missing.length} ${OWNED_LOCALE} sitemap URL(s) have no corresponding static page in dist/:`);
    for (const entry of result.missing.slice(0, 100)) {
      console.error(`  • [${entry.sitemap}] ${entry.url}`);
    }
    if (result.missing.length > 100) console.error(`  • … ${result.missing.length - 100} more`);
    process.exit(1);
  }
  if (MANIFEST_OUT) writeLocaleManifest(MANIFEST_OUT, OWNED_LOCALE, result.entries);
  console.log(`✅ All ${OWNED_LOCALE} sitemap routes have corresponding static pages in dist/.`);
  process.exit(0);
}

if (IS_MAIN) {
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

  let fileExternal = 0;
  for (const url of allUrls) {
    // Served from the article shard repos via the Worker, not from this build
    // — see scripts/lib/externally-served-paths.mjs. Listing them is correct;
    // expecting a file in dist/ for them is not.
    if (isExternallyServedUrl(url)) { fileExternal++; continue; }
    totalUrls++;
    // Use the same served-file boundary as the locale-shard manifest check:
    // a route may be present as either route/index.html or the historical
    // route.html form after shard assembly.
    const distCandidates = urlToDistCandidates(url);
    const distPath = distCandidates[0] ?? urlToDistPath(url);
    if (!distCandidates.some(isRegularFile)) {
      fileMissing++;
      missingCount++;
      missing.push({ sitemap: file, url, distPath });
    }
  }

  const status = fileMissing === 0 ? '✅' : '❌';
  const extNote = fileExternal > 0 ? `, ${fileExternal} externally served` : '';
  console.log(`  ${status} ${file}: ${allUrls.length - fileExternal} URLs checked, ${fileMissing} missing${extNote}`);
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
    sampleRate: 1,
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
  sampleRate: 1,
  extra: { totalUrls, sitemapFiles: sitemapFiles.length },
});
}
