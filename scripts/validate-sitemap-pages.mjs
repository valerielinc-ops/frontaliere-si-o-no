#!/usr/bin/env node
/**
 * validate-sitemap-pages.mjs
 *
 * Consolidated sitemap-driven validator. Replaces 4 separate scripts that
 * each parsed sitemap XML and re-read every targeted HTML page:
 *   - audit-sitemap-canonicals.mjs (canonical self-reference, hard gate)
 *   - validate-canonical.mjs        (canonical self-reference + bridge-page)
 *   - validate-soft404.mjs          (visible text 800/400 char threshold)
 *   - validate-content-quality.mjs  (50 words + JobPosting schema check)
 *
 * Each input sitemap is parsed exactly once, and each HTML file referenced is
 * read exactly once per source sitemap directory. The 4 checks then run in
 * pipeline against the cached HTML, preserving every threshold, skip-rule
 * and exit semantics from the originals.
 *
 * Exit code: 0 if every check passes; 1 if any check fails. Per-check
 * PASS/FAIL is reported separately so individual failures stay identifiable
 * in the CI log (the 4 originals were dispatched as 4 spawn_capped tasks
 * each with its own log; we mirror that granularity in stdout).
 *
 * ── Differences PRESERVED across the 4 originals ──────────────────────────
 *
 * 1. Sitemap source directory
 *    - audit-sitemap-canonicals + validate-canonical + validate-content-quality
 *      read from `dist/sitemap*.xml` (post-build, includes ~24 child sitemaps).
 *    - validate-soft404 reads from `public/sitemap-*.xml` (source dir, only
 *      the 6 hand-maintained sitemaps shipped via public/). This script keeps
 *      that distinction: the "soft404" check uses the public/ source list,
 *      the other three use dist/. Different URL sets → different counts.
 *
 * 2. Sitemap-name skip rules
 *    - audit-sitemap-canonicals: skips `sitemap.xml` (index) and
 *      `sitemap_news.xml` (Google News format). Pattern: /^sitemap-.+\.xml$/i
 *    - validate-canonical: skips only `sitemap.xml`. Pattern:
 *      file.startsWith('sitemap') && file.endsWith('.xml')
 *    - validate-soft404: in public/, skips `sitemap-jobs.xml` only.
 *    - validate-content-quality: no explicit skip; pattern
 *      file.startsWith('sitemap') && file.endsWith('.xml'). Picks up
 *      `sitemap.xml` and `sitemap_news.xml` too — but extractSitemapUrls
 *      filters out anything ending in `.xml` (skip sub-sitemap references)
 *      and discards the homepage entry, so the surviving URL set is similar
 *      to validate-canonical's. We replicate this filter literally.
 *
 * 3. URL → dist HTML resolution
 *    - audit-sitemap-canonicals: tries both `<path>/index.html` and
 *      `<path>.html`, plus root special case. Skips assets matching
 *      `\.(pdf|xml|txt|json|rss|xsl|ico)(\?|#|$)/i` BEFORE looking up.
 *    - validate-canonical: tries `<path>/index.html` first, then
 *      `<path>.html`. Root special case present. No asset extension skip.
 *    - validate-soft404: tries only `<path>/index.html`. No flat .html
 *      fallback. No extension skip.
 *    - validate-content-quality: if the URL path has any extension, treats
 *      it as a literal file path; else `<path>/index.html`. Skips entries
 *      whose path ends in `.xml` (sub-sitemap references).
 *    Each check uses ITS OWN resolver to keep counts byte-equivalent.
 *
 * 4. Text-extraction differences
 *    - validate-soft404 strips: <script>, <style>, then tags, then named
 *      entities (&amp; &lt; &gt; &quot; &#39; and any &[a-z]+;), collapse
 *      whitespace. JSON-LD <script type="application/ld+json"> is REMOVED
 *      (since `<script[^>]*>...</script>` strip is unconditional). The
 *      header comment claims it's "included" but the regex disagrees — we
 *      preserve the actual behaviour, not the comment.
 *    - validate-content-quality strips identically.
 *    - Both then count chars (soft404) or words (content-quality). We run
 *      both metrics over the same stripped text per URL.
 *
 * 5. Bridge / alias / consolidation skip rules
 *    - validate-canonical:
 *      • "Versione canonica disponibile" thin bridge → ERROR
 *      • `__BRIDGE_TARGET_SLUG__` (full-content previousSlug bridge) → SKIP
 *      • LEGACY_ALIAS_CANONICALS hardcoded path map → SKIP
 *      • job-section consolidation (urlPath + canonPath both under
 *        /cerca-lavoro-ticino/, canonPath has a sub-path) → SKIP
 *      • Trailing-slash-only difference → not an error
 *      Only the first 8000 bytes of HTML are scanned for canonical/bridge.
 *    - validate-content-quality:
 *      • `__BRIDGE_TARGET_SLUG__` → SKIP
 *      • Legacy job bridge (`Apri la pagina`, individual job page,
 *        words<50) → SKIP from thin-content check
 *      • Noindex on a sitemap URL → ERROR (BLOCKING)
 *    - audit-sitemap-canonicals: no bridge logic at all, hard gate on
 *      raw canonical match.
 *    Each check applies its own skip rules independently.
 *
 * 6. Job-page heuristics
 *    - validate-content-quality has rich isIndividualJobPage() classifier:
 *      excludes company/, search/, category/, pagination/, filter combo,
 *      and a hardcoded editorial-slugs list across all 4 locales.
 *      hasJobPostingSchema = `"JobPosting"` or `'JobPosting'` substring.
 *
 * Run AFTER `npm run build` so dist/ is fresh.
 *
 * Usage:
 *   node scripts/validate-sitemap-pages.mjs
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist');
const PUBLIC_DIR = join(ROOT, 'public');
const HOST = 'https://frontaliereticino.ch';
const BASE_URL_TRAILING = HOST + '/';

// ── Thresholds (must match the originals) ──────────────────────────────────
const MIN_TEXT_CHARS = 800;       // validate-soft404
const CRITICAL_TEXT_CHARS = 400;  // validate-soft404
const MIN_WORDS = 50;             // validate-content-quality

// ── Shared helpers ─────────────────────────────────────────────────────────

function decodeEntities(s) {
  return s
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'");
}

/**
 * Identical text-stripper used by validate-soft404 and validate-content-quality.
 * <script> and <style> blocks are removed wholesale (so JSON-LD content does
 * NOT contribute to the visible-text length, despite what the soft-404 header
 * comment suggests — the regex is the source of truth).
 */
function extractVisibleText(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countWords(text) {
  return text.split(' ').filter(w => w.length > 0).length;
}

/** soft404 + content-quality both use this exact noindex regex shape. */
function hasNoindex(html) {
  // soft404 uses match(); content-quality uses test() — same intent, same outcome.
  return /<meta[^>]*name=["']robots["'][^>]*content=["'][^"']*noindex/i.test(html);
}

function hasJobPostingSchema(html) {
  return html.includes('"JobPosting"') || html.includes("'JobPosting'");
}

/** validate-content-quality.isIndividualJobPage — preserved verbatim. */
function isJobPage(path) {
  return /\/(cerca-lavoro-ticino|find-jobs-ticino|jobs-im-tessin|trouver-emploi-tessin)\//.test('/' + path);
}

const EDITORIAL_JOB_SLUGS = new Set([
  'offerte-di-lavoro-ticino-oggi', 'ticino-jobs-today', 'jobs-tessin-heute', 'offres-emploi-tessin-aujourdhui',
  'foglio-ufficiale-offerte-di-lavoro-ticino', 'official-gazette-ticino-jobs', 'amtsblatt-stellen-tessin', 'feuille-officielle-emplois-tessin',
  'infermieri-in-ticino', 'nurses-in-ticino', 'pflege-jobs-im-tessin', 'infirmiers-au-tessin',
  'cliniche-ticino', 'clinics-ticino-jobs', 'kliniken-tessin-jobs', 'cliniques-tessin',
  'case-anziani-ticino', 'care-homes-ticino-jobs', 'altersheime-tessin-jobs', 'maisons-retraite-tessin',
  'oss-ticino', 'healthcare-assistants-ticino', 'pflegeassistenz-tessin', 'oss-tessin',
  'educatori-ticino', 'educators-ticino', 'paedagogen-tessin', 'educateurs-tessin',
]);

function isIndividualJobPage(path) {
  if (!isJobPage(path)) return false;
  const slug = path.split('/').pop() || '';
  if (/^(azienda|company|unternehmen|entreprise)-/.test(slug)) return false;
  if (/^(ricerca|search|suche|recherche)-/.test(slug)) return false;
  if (/^(categoria|category|kategorie|categorie)-/.test(slug)) return false;
  if (/^(pagina|page|seite)-\d+$/.test(slug)) return false;
  if (/^(lavoro|jobs?|stellen|emploi|offerte)-(part-time|full-time|tempo-pieno|teilzeit|vollzeit|temps-partiel|temps-plein)/.test(slug)) return false;
  if (EDITORIAL_JOB_SLUGS.has(slug)) return false;
  return true;
}

// ── Per-check sitemap loaders + URL resolvers ─────────────────────────────

/** audit-sitemap-canonicals: dist/sitemap-*.xml minus index + news, no asset URLs. */
function loadAuditSitemapCanonicalsUrls() {
  const entries = readdirSync(DIST);
  const sitemapFiles = entries
    .filter(name => /^sitemap-.+\.xml$/i.test(name))
    .filter(name => name.toLowerCase() !== 'sitemap.xml')
    .filter(name => name.toLowerCase() !== 'sitemap_news.xml')
    .sort();

  const out = [];
  for (const sitemap of sitemapFiles) {
    const xml = readFileSync(join(DIST, sitemap), 'utf8');
    if (/<sitemapindex\b/i.test(xml)) continue;
    const re = /<url\b[\s\S]*?<\/url>/gi;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const block = m[0];
      const loc = block.match(/<loc>\s*([^<\s][^<]*?)\s*<\/loc>/i);
      if (loc && loc[1]) out.push({ sitemap, loc: decodeEntities(loc[1].trim()) });
    }
  }
  return { sitemapFiles, urls: out };
}

function locToHtmlPath_audit(loc) {
  let urlPath;
  try { urlPath = new URL(loc).pathname; }
  catch { urlPath = loc.startsWith('/') ? loc : '/' + loc; }
  urlPath = urlPath.split('#')[0].split('?')[0];

  const candidates = [];
  if (urlPath.endsWith('/')) {
    candidates.push(join(DIST, urlPath, 'index.html'));
    const trimmed = urlPath.replace(/\/+$/, '');
    if (trimmed) candidates.push(join(DIST, trimmed + '.html'));
  } else {
    candidates.push(join(DIST, urlPath + '.html'));
    candidates.push(join(DIST, urlPath, 'index.html'));
  }
  if (urlPath === '/' || urlPath === '') {
    candidates.unshift(join(DIST, 'index.html'));
  }
  for (const c of candidates) {
    if (existsSync(c)) {
      try { if (statSync(c).isFile()) return c; } catch { /* ignore */ }
    }
  }
  return null;
}

function normalizeUrlAudit(u) {
  try {
    const parsed = new URL(u, HOST);
    let path = parsed.pathname;
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${parsed.search}`;
  } catch {
    return u.trim();
  }
}

/** validate-canonical: dist/sitemap*.xml minus sitemap.xml only. */
function loadValidateCanonicalUrls() {
  const urls = new Set();
  for (const file of readdirSync(DIST)) {
    if (!file.startsWith('sitemap') || !file.endsWith('.xml')) continue;
    if (file === 'sitemap.xml') continue;
    const content = readFileSync(join(DIST, file), 'utf-8');
    const re = /<loc>([^<]+)<\/loc>/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      const url = m[1].trim();
      if (url.startsWith(HOST)) urls.add(url);
    }
  }
  return urls;
}

function findHtmlFile_vc(url) {
  const urlPath = url.replace(HOST, '').replace(/\/$/, '');
  if (!urlPath || urlPath === '') {
    const indexPath = join(DIST, 'index.html');
    return existsSync(indexPath) ? indexPath : null;
  }
  const dirIndex = join(DIST, urlPath.replace(/^\//, ''), 'index.html');
  if (existsSync(dirIndex)) return dirIndex;
  const flatFile = join(DIST, urlPath.replace(/^\//, '') + '.html');
  if (existsSync(flatFile)) return flatFile;
  return null;
}

function extractCanonical_vc(content) {
  const match = content.match(/<link\s+rel="canonical"\s+href="([^"]+)"/);
  return match ? match[1] : null;
}

const LEGACY_ALIAS_CANONICALS = new Map([
  ['/about/', '/en/about-us/'],
  ['/about', '/en/about-us/'],
  ['/contact/', '/en/contact-us/'],
  ['/contact', '/en/contact-us/'],
  ['/privacy-policy/', '/en/privacy/'],
  ['/privacy-policy', '/en/privacy/'],
]);

function isLegitLegacyAlias(url, canonical) {
  const urlPath = url.replace(HOST, '');
  const canonPath = canonical.replace(HOST, '');
  const expected = LEGACY_ALIAS_CANONICALS.get(urlPath);
  if (!expected) return false;
  return canonPath === expected;
}

function isLegitJobConsolidation(url, canonical) {
  const JOB_SECTION = '/cerca-lavoro-ticino/';
  const urlPath = url.replace(HOST, '');
  const canonPath = canonical.replace(HOST, '');
  if (!urlPath.startsWith(JOB_SECTION) || !canonPath.startsWith(JOB_SECTION)) return false;
  const canonSubPath = canonPath.slice(JOB_SECTION.length).replace(/\/$/, '');
  if (!canonSubPath) return false;
  return true;
}

/** validate-soft404: public/sitemap-*.xml minus sitemap-jobs.xml. */
function loadSoft404Urls() {
  if (!existsSync(PUBLIC_DIR)) return { sitemapFiles: [], perSitemap: [] };
  const sitemapFiles = readdirSync(PUBLIC_DIR)
    .filter(f => f.startsWith('sitemap-') && f.endsWith('.xml') && f !== 'sitemap-jobs.xml')
    .sort();
  const perSitemap = [];
  for (const file of sitemapFiles) {
    const xml = readFileSync(join(PUBLIC_DIR, file), 'utf-8');
    const locs = [];
    {
      const re = /<loc>\s*(https?:\/\/[^<]+?)\s*<\/loc>/gi;
      let m;
      while ((m = re.exec(xml)) !== null) locs.push(m[1].trim());
    }
    const hreflangs = new Set();
    {
      const re = /<xhtml:link[^>]*href="(https?:\/\/[^"]+)"[^>]*\/?\s*>/gi;
      let m;
      while ((m = re.exec(xml)) !== null) hreflangs.add(m[1].trim());
    }
    const allUrls = [...new Set([...locs, ...hreflangs])];
    perSitemap.push({ file, urls: allUrls });
  }
  return { sitemapFiles, perSitemap };
}

function urlToDistPath_soft404(url) {
  let rel = url.replace(HOST, '').replace(/\/$/, '') || '/';
  if (rel === '/') return join(DIST, 'index.html');
  rel = rel.startsWith('/') ? rel.slice(1) : rel;
  return join(DIST, rel, 'index.html');
}

function isExpiredJobArchive(html) {
  return (
    /questa posizione.*non.*più disponibile/i.test(html) ||
    /this position.*no longer available/i.test(html) ||
    /diese stelle.*nicht mehr verfügbar/i.test(html) ||
    /ce poste.*plus disponible/i.test(html) ||
    /posizioni aperte simili/i.test(html) ||
    /similar open positions/i.test(html)
  );
}

function isSkeletonDominated(html, textLen) {
  const skeletonCount = (html.match(/background:#e2e8f0/g) || []).length;
  return skeletonCount >= 3 && textLen < 1200;
}

/** validate-content-quality: dist/sitemap*.xml, no exclusions, drop .xml + homepage. */
function loadContentQualityUrls() {
  const sitemaps = readdirSync(DIST).filter(f => f.startsWith('sitemap') && f.endsWith('.xml'));
  const out = [];
  for (const sm of sitemaps) {
    const content = readFileSync(join(DIST, sm), 'utf-8');
    const matches = [...content.matchAll(/<loc>([^<]+)<\/loc>/g)];
    for (const m of matches) {
      const url = m[1];
      if (!url.startsWith(BASE_URL_TRAILING)) continue;
      const path = url.slice(BASE_URL_TRAILING.length).replace(/\/$/, '') || '';
      if (!path) continue;          // skip homepage
      if (path.endsWith('.xml')) continue; // skip sub-sitemap references
      out.push({ sitemap: sm, url, path });
    }
  }
  return out;
}

function urlToFile_vcq(path) {
  const hasExt = extname(path).length > 0;
  return hasExt ? join(DIST, path) : join(DIST, path, 'index.html');
}

// ── HTML reader ────────────────────────────────────────────────────────────
//
// Earlier versions cached every HTML body across all 4 checks. With ~132k
// sitemap URLs averaging ~80 KB each, the cache exceeded 10 GB of resident
// strings and OOM-killed the 4 GB-cap CI process (post-deploy run, rc=134
// "Reached heap limit Allocation failed"). The OS page cache makes the
// re-read across checks cheap enough that an in-process cache is not worth
// the heap blow-up.

function readHtml(filePath) {
  try {
    if (existsSync(filePath) && statSync(filePath).isFile()) {
      return readFileSync(filePath, 'utf-8');
    }
  } catch { /* ignore */ }
  return null;
}

// ── Check runners ──────────────────────────────────────────────────────────

const checks = {
  sitemapCanonicals: { name: 'audit:sitemap-canonicals', pass: true, summary: '', details: '' },
  canonical:         { name: 'validate:canonical',        pass: true, summary: '', details: '' },
  soft404:           { name: 'validate:soft-404',         pass: true, summary: '', details: '' },
  contentQuality:    { name: 'validate:content-quality',  pass: true, summary: '', details: '' },
};

// ── 1) audit-sitemap-canonicals ────────────────────────────────────────────
function runAuditSitemapCanonicals() {
  const out = [];
  let { sitemapFiles, urls } = loadAuditSitemapCanonicalsUrls();
  if (sitemapFiles.length === 0) {
    checks.sitemapCanonicals.pass = false;
    checks.sitemapCanonicals.summary =
      'audit-sitemap-canonicals: no dist/sitemap-*.xml files matched.\n';
    return;
  }

  const offenders = [];
  let okCount = 0;
  let totalChecked = 0;
  const LIMIT = 50;

  for (const { sitemap, loc } of urls) {
    if (/\.(pdf|xml|txt|json|rss|xsl|ico)(\?|#|$)/i.test(loc)) continue;
    totalChecked++;
    const htmlPath = locToHtmlPath_audit(loc);
    if (!htmlPath) {
      offenders.push({ category: 'missing-html', sitemap, loc, canonical: null });
      continue;
    }
    const html = readHtml(htmlPath);
    if (html === null) {
      offenders.push({ category: 'missing-html', sitemap, loc, canonical: null });
      continue;
    }
    // audit version of canonical extractor: search all <link> tags for rel=canonical
    let canonical = null;
    {
      const linkRe = /<link\b[^>]*>/gi;
      let m;
      while ((m = linkRe.exec(html)) !== null) {
        const tag = m[0];
        if (!/rel\s*=\s*["']?canonical["']?/i.test(tag)) continue;
        const href = tag.match(/href\s*=\s*"([^"]+)"/i) || tag.match(/href\s*=\s*'([^']+)'/i);
        if (href && href[1]) { canonical = decodeEntities(href[1].trim()); break; }
      }
    }
    if (!canonical) {
      offenders.push({ category: 'missing-canonical', sitemap, loc, canonical: null });
      continue;
    }
    if (normalizeUrlAudit(canonical) !== normalizeUrlAudit(loc)) {
      offenders.push({ category: 'mismatch', sitemap, loc, canonical });
      continue;
    }
    okCount++;
  }

  const counts = { mismatch: 0, 'missing-html': 0, 'missing-canonical': 0 };
  for (const o of offenders) counts[o.category]++;

  out.push(
    `audit-sitemap-canonicals: scanned ${sitemapFiles.length} sitemap file(s), checked ${totalChecked} URL(s)\n` +
    `OK: ${okCount}, mismatches: ${counts.mismatch}, missing-html: ${counts['missing-html']}, missing-canonical: ${counts['missing-canonical']}\n`
  );

  const hardFailers = offenders.filter(o => o.category !== 'missing-html');
  const warners = offenders.filter(o => o.category === 'missing-html');

  if (warners.length > 0) {
    out.push(
      `\nWARN: ${warners.length} sitemap <loc>(s) have no HTML in dist/ ` +
      `(separate concern — see sitemap-completeness.test.ts):\n`
    );
    const slice = warners.slice(0, Math.min(LIMIT, warners.length));
    for (const o of slice) out.push(`[missing-html] ${o.sitemap}: ${o.loc}\n`);
    if (warners.length > slice.length) out.push(`… ${warners.length - slice.length} more\n`);
  }

  if (hardFailers.length === 0) {
    checks.sitemapCanonicals.pass = true;
    checks.sitemapCanonicals.summary = out.join('');
    return;
  }

  out.push(
    `\nFAIL: sitemap canonical integrity gate found ${hardFailers.length} offender(s).\n` +
    `Sitemap <loc> URLs MUST self-canonicalize. See CLAUDE.md SEO rules.\n\n`
  );

  const order = ['mismatch', 'missing-canonical'];
  const byCat = new Map();
  for (const c of order) byCat.set(c, []);
  for (const o of hardFailers) byCat.get(o.category).push(o);

  let printed = 0;
  for (const cat of order) {
    const list = byCat.get(cat);
    if (!list.length) continue;
    for (const o of list) {
      if (printed >= LIMIT) break;
      const canon = o.canonical ?? '(none)';
      out.push(`[${o.category}] ${o.sitemap}: ${o.loc} → ${canon}\n`);
      printed++;
    }
    if (printed >= LIMIT) break;
  }
  if (hardFailers.length > printed) {
    out.push(`… ${hardFailers.length - printed} more (raise --limit=N to see them)\n`);
  }

  checks.sitemapCanonicals.pass = false;
  checks.sitemapCanonicals.summary = out.join('');
}

// ── 2) validate-canonical ──────────────────────────────────────────────────
function runValidateCanonical() {
  const out = [];
  const sitemapUrls = loadValidateCanonicalUrls();
  out.push(`[validate-canonical] Checking ${sitemapUrls.size} sitemap URLs...\n\n`);

  const errors = [];
  const warnings = [];
  let bridgeSkipped = 0;

  for (const url of sitemapUrls) {
    const htmlFile = findHtmlFile_vc(url);
    if (!htmlFile) continue;

    const fullContent = readHtml(htmlFile);
    if (fullContent === null) continue;
    const content = fullContent.slice(0, 8000);

    if (content.includes('Versione canonica disponibile')) {
      errors.push({
        url,
        issue: 'Sitemap URL is a thin "Versione canonica" bridge page — will be flagged by Google as redirect',
      });
      continue;
    }

    if (fullContent.includes('__BRIDGE_TARGET_SLUG__')) {
      bridgeSkipped++;
      continue;
    }

    const canonical = extractCanonical_vc(content);
    if (!canonical) {
      warnings.push({ url, issue: 'No canonical tag found' });
      continue;
    }

    const norm = (u) => u.replace(/\/$/, '');
    if (norm(canonical) !== norm(url)) {
      const canonPath = canonical.replace(HOST, '');
      const urlPath = url.replace(HOST, '');
      const isSlashDiff = norm(canonPath) === norm(urlPath);
      if (!isSlashDiff) {
        if (isLegitLegacyAlias(url, canonical)) { bridgeSkipped++; continue; }
        if (isLegitJobConsolidation(url, canonical)) {
          bridgeSkipped++;
        } else {
          errors.push({ url, issue: `Canonical mismatch: canonical → ${canonical} (different page)` });
        }
      }
    }
  }

  if (errors.length > 0) {
    out.push(`❌ ${errors.length} blocking error(s):\n\n`);
    for (const e of errors.slice(0, 20)) {
      out.push(`  ❌ ${e.url}\n     ${e.issue}\n`);
    }
    if (errors.length > 20) out.push(`  ... and ${errors.length - 20} more\n`);
  }
  if (warnings.length > 0) {
    out.push(`\n⚠️  ${warnings.length} warning(s):\n\n`);
    for (const w of warnings.slice(0, 10)) {
      out.push(`  ⚠️  ${w.url}\n     ${w.issue}\n`);
    }
    if (warnings.length > 10) out.push(`  ... and ${warnings.length - 10} more\n`);
  }
  if (errors.length === 0 && warnings.length === 0) {
    out.push('✅ All sitemap URLs have correct self-referencing canonical tags.\n');
  }
  if (bridgeSkipped > 0) {
    out.push(`ℹ️  ${bridgeSkipped} previousSlug bridge page(s) skipped (canonical → current slug is correct).\n`);
  }

  if (errors.length === 0) {
    out.push('\n✅ No blocking canonical errors.\n');
    checks.canonical.pass = true;
  } else {
    out.push(`\n🛑 ${errors.length} blocking error(s) found. Fix before deploying.\n`);
    checks.canonical.pass = false;
  }
  checks.canonical.summary = out.join('');
}

// ── 3) validate-soft404 ────────────────────────────────────────────────────
function runValidateSoft404() {
  const out = [];
  out.push('\n🔍 Soft-404 Validation\n\n');

  const { sitemapFiles, perSitemap } = loadSoft404Urls();
  const issues = [];
  let totalChecked = 0;
  let skippedMissing = 0;

  for (const { file, urls } of perSitemap) {
    let fileIssues = 0;
    for (const url of urls) {
      const distPath = urlToDistPath_soft404(url);
      // Match validate-soft404.mjs exactly: existsSync gate, then read.
      if (!existsSync(distPath)) {
        skippedMissing++;
        continue;
      }
      const html = readHtml(distPath);
      if (html === null) {
        // File existed on disk but read failed (rare — eg. broken symlink).
        // Original behaviour was to readFileSync and crash; we degrade
        // gracefully here. Preserve count semantics by treating as missing.
        skippedMissing++;
        continue;
      }
      totalChecked++;
      const visibleText = extractVisibleText(html);
      const textLen = visibleText.length;
      const noindex = hasNoindex(html);
      const isArchive = isExpiredJobArchive(html);
      const relPath = url.replace(HOST, '');

      if (isArchive && !noindex) {
        issues.push({ severity: 'error', url: relPath, sitemap: file,
          message: `Expired job archive page missing noindex meta tag` });
        fileIssues++;
      }
      if (!noindex && textLen < MIN_TEXT_CHARS) {
        const severity = textLen < CRITICAL_TEXT_CHARS ? 'error' : 'warning';
        issues.push({ severity, url: relPath, sitemap: file,
          message: `Thin content: ${textLen} chars (min: ${MIN_TEXT_CHARS})` });
        fileIssues++;
      }
      if (!noindex && isSkeletonDominated(html, textLen)) {
        issues.push({ severity: 'warning', url: relPath, sitemap: file,
          message: `Skeleton-dominated: gray placeholders dominate over text content` });
        fileIssues++;
      }
      if (noindex && !isArchive) {
        issues.push({ severity: 'error', url: relPath, sitemap: file,
          message: `Sitemap URL has noindex — will be excluded from Google index` });
        fileIssues++;
      }
    }
    const status = fileIssues === 0 ? '✅' : '⚠️';
    out.push(`  ${status} ${file}: ${urls.length} URLs, ${fileIssues} issues\n`);
  }

  out.push(`\n📊 Checked ${totalChecked} pages across ${sitemapFiles.length} sitemaps (${skippedMissing} missing files skipped)\n`);

  const errors = issues.filter(i => i.severity === 'error');
  const warnings = issues.filter(i => i.severity === 'warning');

  if (warnings.length > 0) {
    out.push(`\n⚠️  ${warnings.length} warning(s):\n\n`);
    for (const w of warnings.slice(0, 20)) {
      out.push(`  ⚠️  [${w.sitemap}] ${w.url}\n     ${w.message}\n`);
    }
    if (warnings.length > 20) out.push(`  ... and ${warnings.length - 20} more\n`);
  }
  if (errors.length > 0) {
    out.push(`\n❌ ${errors.length} error(s):\n\n`);
    for (const e of errors.slice(0, 20)) {
      out.push(`  ❌ [${e.sitemap}] ${e.url}\n     ${e.message}\n`);
    }
    if (errors.length > 20) out.push(`  ... and ${errors.length - 20} more\n`);
  }

  if (errors.length > 0) {
    out.push(
      '\n💡 Fix options:\n' +
      '  • Add/enrich editorial content in build-plugins/editorialContent.ts\n' +
      '  • Add <meta name="robots" content="noindex"> for expired/archive pages\n' +
      '  • Remove thin pages from sitemaps if they have no real content\n' +
      '  • Ensure SEO_METADATA entry exists with proper canonicalPath\n\n'
    );
    checks.soft404.pass = false;
  } else {
    if (issues.length === 0) {
      out.push('\n✅ No soft-404 indicators found.\n\n');
    } else {
      out.push('\n✅ No blocking errors.\n\n');
    }
    checks.soft404.pass = true;
  }
  checks.soft404.summary = out.join('');
}

// ── 4) validate-content-quality ────────────────────────────────────────────
function runValidateContentQuality() {
  const out = [];
  const urls = loadContentQualityUrls();
  out.push(`[validate-content] Checking ${urls.length} sitemap URLs...\n\n`);

  const missing = [];
  const thinContent = [];
  const jobsNoSchema = [];
  const noindexInSitemap = [];
  let errors = 0;

  for (const { sitemap, url, path } of urls) {
    const filePath = urlToFile_vcq(path);
    const html = readHtml(filePath);
    if (html === null) {
      missing.push({ sitemap, path });
      errors++;
      continue;
    }
    const hasExt = extname(path).length > 0;
    if (hasExt && !path.endsWith('.html')) continue;

    if (html.includes('__BRIDGE_TARGET_SLUG__')) continue;

    if (hasNoindex(html)) {
      noindexInSitemap.push({ sitemap, path });
      errors++;
      continue;
    }

    const text = extractVisibleText(html);
    const words = countWords(text);

    if (words < MIN_WORDS && isIndividualJobPage(path) && html.includes('Apri la pagina')) {
      continue;
    }

    if (words < MIN_WORDS) {
      thinContent.push({ sitemap, path, words });
      errors++;
    }
    if (isIndividualJobPage(path) && !hasJobPostingSchema(html) && words >= MIN_WORDS) {
      jobsNoSchema.push({ sitemap, path, words });
    }
  }

  if (missing.length > 0) {
    out.push(`❌ ${missing.length} sitemap URL(s) have NO file in dist/ (BLOCKING):\n`);
    for (const { sitemap, path } of missing.slice(0, 20)) {
      out.push(`   [${sitemap}] /${path}\n`);
    }
    if (missing.length > 20) out.push(`   ... and ${missing.length - 20} more\n`);
    out.push('\n');
  }
  if (noindexInSitemap.length > 0) {
    out.push(`❌ ${noindexInSitemap.length} sitemap URL(s) have noindex tag (BLOCKING):\n`);
    out.push(`   Pages with noindex must NOT be in sitemaps — wastes crawl budget.\n`);
    for (const { sitemap, path } of noindexInSitemap.slice(0, 20)) {
      out.push(`   [${sitemap}] /${path}\n`);
    }
    if (noindexInSitemap.length > 20) out.push(`   ... and ${noindexInSitemap.length - 20} more\n`);
    out.push('\n');
  }
  if (thinContent.length > 0) {
    out.push(`❌ ${thinContent.length} sitemap URL(s) have thin content (<${MIN_WORDS} words) (BLOCKING):\n`);
    for (const { sitemap, path, words } of thinContent.slice(0, 15)) {
      out.push(`   [${words}w] [${sitemap}] /${path}\n`);
    }
    if (thinContent.length > 15) out.push(`   ... and ${thinContent.length - 15} more\n`);
    out.push('\n');
  }
  if (jobsNoSchema.length > 0) {
    out.push(`⚠️  ${jobsNoSchema.length} job page(s) in sitemaps without JobPosting schema:\n`);
    for (const { sitemap, path, words } of jobsNoSchema.slice(0, 10)) {
      out.push(`   [${words}w] [${sitemap}] /${path}\n`);
    }
    if (jobsNoSchema.length > 10) out.push(`   ... and ${jobsNoSchema.length - 10} more\n`);
    out.push('\n');
  }

  if (errors > 0) {
    out.push(`\n❌ BLOCKING: ${errors} error(s) found. Fix before deploying.\n`);
    checks.contentQuality.pass = false;
  } else {
    const warningsCount = jobsNoSchema.length;
    if (warningsCount > 0) {
      out.push(`✅ No blocking errors. ${warningsCount} warning(s).\n`);
    } else {
      out.push(`✅ All ${urls.length} sitemap URLs have files with adequate content (>=${MIN_WORDS} words).\n`);
    }
    checks.contentQuality.pass = true;
  }
  checks.contentQuality.summary = out.join('');
}

// ── Driver ─────────────────────────────────────────────────────────────────
function main() {
  if (!existsSync(DIST)) {
    process.stderr.write(`validate-sitemap-pages: dist/ not found. Run \`npm run build\` first.\n`);
    process.exit(2);
  }

  // Each runner is independent; HTML reads are cached across runners.
  runAuditSitemapCanonicals();
  runValidateCanonical();
  runValidateSoft404();
  runValidateContentQuality();

  // Per-check report — preserves the original 4-script log identity.
  const sections = ['sitemapCanonicals', 'canonical', 'soft404', 'contentQuality'];
  let anyFailed = false;
  for (const key of sections) {
    const c = checks[key];
    process.stdout.write(`\n══════════════════════════════════════════════════════════════════════\n`);
    process.stdout.write(`  ${c.name}: ${c.pass ? 'PASS' : 'FAIL'}\n`);
    process.stdout.write(`══════════════════════════════════════════════════════════════════════\n`);
    process.stdout.write(c.summary);
    if (!c.pass) anyFailed = true;
  }
  process.stdout.write('\n══════════════════════════════════════════════════════════════════════\n');
  process.stdout.write('  validate-sitemap-pages: overall ' + (anyFailed ? 'FAIL' : 'PASS') + '\n');
  for (const key of sections) {
    process.stdout.write(`    - ${checks[key].name}: ${checks[key].pass ? 'PASS' : 'FAIL'}\n`);
  }
  process.stdout.write('══════════════════════════════════════════════════════════════════════\n');

  process.exit(anyFailed ? 1 : 0);
}

try {
  main();
} catch (err) {
  process.stderr.write(`validate-sitemap-pages crashed: ${err && err.stack ? err.stack : err}\n`);
  process.exit(2);
}
