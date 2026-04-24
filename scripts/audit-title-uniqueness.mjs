#!/usr/bin/env node
/**
 * audit-title-uniqueness.mjs
 *
 * Walks `dist/**\/*.html`, extracts the first <title> tag from each document,
 * groups titles by locale (inferred from URL path segment: `/en/`, `/de/`,
 * `/fr/` → that locale; everything else → `it`), and reports any locale that
 * has duplicate `<title>` values.
 *
 * Semrush Site Audit (2026-04-24) flagged 475 pages without a unique title.
 * Each locale legitimately produces a DIFFERENT title for the same page
 * (EN/DE/FR canonicals), so de-duplication must happen WITHIN locale only.
 *
 * Exit code:
 *   0 — every locale has 100% unique titles.
 *   1 — at least one locale contains duplicate titles; the first 20 collisions
 *       are listed on stderr.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(REPO_ROOT, 'dist');

const MAX_COLLISIONS_REPORTED = 20;

/**
 * Infer locale from a filesystem path relative to dist/.
 * `en/foo/bar/index.html` → `en`
 * `de/...` → `de`
 * `fr/...` → `fr`
 * otherwise → `it` (default locale, no prefix).
 */
function inferLocale(relPath) {
  const first = relPath.split(path.sep)[0];
  if (first === 'en' || first === 'de' || first === 'fr') return first;
  return 'it';
}

/**
 * Canonicalize a dist-relative HTML path so that `foo.html` and `foo/index.html`
 * — which GitHub Pages serves as the SAME logical URL — collapse to one key.
 *
 * Both forms emit identical `<title>`s by design (the build writes the flat
 * `.html` and the nested `index.html` from the same source), so counting them
 * separately double-reports every page. This audit is about LOGICAL URL
 * uniqueness, not filesystem uniqueness.
 *
 * `foo/index.html` → `foo/`
 * `foo.html`       → `foo/`
 * `index.html`     → `/`
 *
 * @param {string} relPath filesystem-relative path under dist/ using `path.sep`.
 * @returns {string} canonical URL-like key (forward slashes).
 */
function canonicalizePath(relPath) {
  const posix = relPath.split(path.sep).join('/');
  if (posix === 'index.html') return '/';
  if (posix.endsWith('/index.html')) return posix.slice(0, -'index.html'.length);
  if (posix.endsWith('.html')) return `${posix.slice(0, -'.html'.length)}/`;
  return posix;
}

/**
 * Recursively walk `dir` and yield absolute file paths ending in `.html`.
 */
function* walkHtmlFiles(dir) {
  if (!fs.existsSync(dir)) return;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith('.html')) {
        yield full;
      }
    }
  }
}

/**
 * Extract the first <title>...</title> from an HTML document body.
 * Returns null if no title is present. Only matches a HEAD title — skips
 * inline SVG <title> nodes (which appear inside <svg>, never in <head>).
 */
function extractHeadTitle(html) {
  // Limit to the first <head>...</head> block so SVG <title> tags that appear
  // inside the body (e.g. chart tooltips) never register as page titles.
  const headMatch = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html);
  const scope = headMatch ? headMatch[1] : html;
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(scope);
  if (!titleMatch) return null;
  return titleMatch[1]
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract the absolute canonical URL from `<link rel="canonical">`.
 * Returns null if absent.
 *
 * Bridge/alias pages (multi-locale slug variants, expired-job soft landings)
 * all legitimately share the same `<title>` because they all resolve — via
 * their rel=canonical — to the SAME canonical URL. Google collapses them
 * into one indexed page via the canonical signal, so counting them as
 * duplicate <title> collisions is a false positive.
 */
function extractCanonical(html) {
  const headMatch = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html);
  const scope = headMatch ? headMatch[1] : html;
  const m = /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i.exec(scope);
  if (m) return m[1].trim();
  // Alternate attribute order: href before rel.
  const m2 = /<link[^>]+href=["']([^"']+)["'][^>]*rel=["']canonical["']/i.exec(scope);
  return m2 ? m2[1].trim() : null;
}

function main() {
  if (!fs.existsSync(DIST_DIR)) {
    console.error(`[audit:title-uniqueness] dist/ not found at ${DIST_DIR}. Run a build first.`);
    process.exit(2);
  }

  /** Map<locale, Map<title, Map<canonicalKey, string[] relPaths>>>
   * `canonicalKey` is, in priority order:
   *   1. the absolute URL from `<link rel="canonical">` (bridge/alias pages
   *      collapse via this signal — Google treats them as one),
   *   2. the URL-equivalent of the filesystem path (`foo.html` and
   *      `foo/index.html` collapse to `foo/`).
   */
  const titlesByLocale = new Map();
  let totalPages = 0;
  let missingTitles = 0;

  for (const abs of walkHtmlFiles(DIST_DIR)) {
    const rel = path.relative(DIST_DIR, abs);
    const locale = inferLocale(rel);
    const fsCanonical = canonicalizePath(rel);

    let html;
    try {
      html = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }

    const title = extractHeadTitle(html);
    totalPages += 1;
    if (!title) {
      missingTitles += 1;
      continue;
    }

    const canonicalUrl = extractCanonical(html);
    const canonicalKey = canonicalUrl ?? fsCanonical;

    if (!titlesByLocale.has(locale)) {
      titlesByLocale.set(locale, new Map());
    }
    const bucket = titlesByLocale.get(locale);
    if (!bucket.has(title)) {
      bucket.set(title, new Map());
    }
    const byCanonical = bucket.get(title);
    if (!byCanonical.has(canonicalKey)) {
      byCanonical.set(canonicalKey, []);
    }
    byCanonical.get(canonicalKey).push(rel);
  }

  // Tally collisions per locale — only count TRUE duplicates after collapsing
  // `foo.html` + `foo/index.html` pairs into one canonical URL.
  const collisionsByLocale = new Map();
  for (const [locale, bucket] of titlesByLocale.entries()) {
    const dups = [];
    for (const [title, byCanonical] of bucket.entries()) {
      if (byCanonical.size > 1) {
        // Each canonical URL keeps one representative relPath for reporting.
        const canonicalPaths = Array.from(byCanonical.entries()).map(([canonical, relPaths]) => ({
          canonical,
          relPaths,
        }));
        dups.push({ title, canonicalPaths });
      }
    }
    if (dups.length > 0) collisionsByLocale.set(locale, dups);
  }

  // Summary — always print, even when clean. Page counts are CANONICAL pages
  // (the .html + index.html pair counts once).
  const summary = Array.from(titlesByLocale.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([locale, bucket]) => {
      const duplicates = collisionsByLocale.get(locale) ?? [];
      const dupPages = duplicates.reduce((acc, d) => acc + d.canonicalPaths.length, 0);
      const totalCanonicalPages = Array.from(bucket.values()).reduce((a, byCanonical) => a + byCanonical.size, 0);
      return `  ${locale}: ${bucket.size} unique titles across ${totalCanonicalPages} canonical pages (${duplicates.length} duplicate titles, ${dupPages} affected canonical pages)`;
    })
    .join('\n');

  process.stdout.write(
    `[audit:title-uniqueness] Scanned ${totalPages} HTML pages in ${DIST_DIR}\n` +
    (missingTitles > 0 ? `[audit:title-uniqueness] WARNING: ${missingTitles} pages had no <title>\n` : '') +
    `${summary}\n`,
  );

  if (collisionsByLocale.size === 0 && missingTitles === 0) {
    process.stdout.write('[audit:title-uniqueness] PASS — every locale has unique titles.\n');
    process.exit(0);
  }

  // Fail with first 20 collisions on stderr.
  const reported = [];
  for (const [locale, dups] of collisionsByLocale.entries()) {
    for (const { title, canonicalPaths } of dups) {
      reported.push({ locale, title, canonicalPaths });
      if (reported.length >= MAX_COLLISIONS_REPORTED) break;
    }
    if (reported.length >= MAX_COLLISIONS_REPORTED) break;
  }

  process.stderr.write(
    `\n[audit:title-uniqueness] FAIL — duplicate <title> values detected.\n` +
    `First ${reported.length} collisions:\n`,
  );
  for (const { locale, title, canonicalPaths } of reported) {
    process.stderr.write(`  [${locale}] ${title}\n`);
    for (const { canonical } of canonicalPaths.slice(0, 5)) {
      process.stderr.write(`      ${canonical}\n`);
    }
    if (canonicalPaths.length > 5) {
      process.stderr.write(`      …and ${canonicalPaths.length - 5} more\n`);
    }
  }

  process.exit(1);
}

main();
