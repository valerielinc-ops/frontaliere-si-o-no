#!/usr/bin/env node
/**
 * audit-keyword-landing-coverage.mjs — dist/-level coverage gate for the GSC
 * keyword-landing family (build-plugins/jobsSeoPagesPlugin.ts, the
 * `KEYWORD_LANDING_MIN_JOBS` region), scoped companion to
 * `tests/keyword-landing-sitemap-parity.test.ts`.
 *
 * The gap this closes (issue #5655, item 2)
 * ------------------------------------------
 * PR #5623 fixed the historical bug (a keyword landing this build never
 * wrote could still receive a `<loc>` in `sitemap-jobs.xml` — see that
 * plugin's `kwSitemapLocales` comment) with a SOURCE contract:
 * `tests/keyword-landing-sitemap-parity.test.ts` proves via AST that the
 * emit loop and the sitemap block read the same `kwEmittedLocales` set. That
 * closes the divergence for THIS code path, at build time.
 *
 * It does not watch the built bytes. A dist-walking check needs a built
 * `dist/`, so it can only live in a post-deploy validator — and the natural
 * host, `npm run audit:all`, is SAMPLED in CI (`AUDIT_SAMPLE_RATE`). Sampling
 * is sound for per-page checks and wrong for a set-membership one: an
 * unsampled page is indistinguishable from an absent one, so a sampled walk
 * cannot tell "this URL is missing from the sitemap" from "this URL just
 * wasn't in this run's 25% slice". This script is therefore wired
 * unsampled into `post-deploy-validate-dist.yml`'s existing light pool
 * (`spawn_capped`), not into `audit:all`.
 *
 * What it checks
 * ---------------
 * For every `slug` in `data/keyword-pages-config.json` × every locale
 * (it/en/de/fr), the candidate URL is `keywordLandingPath(slug, locale)`
 * (`scripts/lib/keyword-page-paths.mjs` — the same path expression the
 * plugin itself builds). When the candidate file exists in `dist/`:
 *
 *   - GENUINE  = not noindex AND self-referencing canonical. Both are what
 *     the plugin's own doc comment names as the two shapes a page NOT
 *     written by this family takes when it occupies the URL instead
 *     (`relatedSearchClustersPlugin`'s non-self-canonical mirror, or a
 *     noindex bridge) — the same two classes `audit:sitemap-canonicals` and
 *     `validate:sitemap-pages` already hard-fail on, generically, sampled.
 *   - IN_SITEMAP = the URL has a `<loc>` in `dist/sitemap-jobs.xml`.
 *
 * `sitemappedNotGenuine` (IN_SITEMAP but not GENUINE) is the BLOCKING check
 * — it reproduces the exact historical defect shape byte-for-byte: a URL
 * this family's sitemap block advertises that resolves to a page it did not
 * write. It cannot false-positive on an unrelated `activeJobDirs` collision,
 * because it only fires on a URL some code already chose to sitemap.
 *
 * `emittedNotSitemapped` (GENUINE but not IN_SITEMAP) is the complementary
 * half of the parity invariant, but is NOT blocking: a self-canonical,
 * indexable page can legitimately sit at a keyword-shaped URL without being
 * this family's own page (`activeJobDirs` lets a different emitter claim the
 * directory first — see the long comment in
 * `scripts/lib/keyword-page-paths.mjs`, "a 200 at a predicted path proves
 * the path is taken, never by whom"). Reported for visibility only.
 *
 * Run AFTER `npm run build` so dist/ is fresh (same contract as
 * validate-sitemap-pages.mjs).
 *
 * Usage:
 *   node scripts/audit-keyword-landing-coverage.mjs
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeAuditReport } from './lib/auditReport.mjs';
import { keywordLandingPath } from './lib/keyword-page-paths.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const HOST = 'https://frontaliereticino.ch';
const LOCALES = ['it', 'en', 'de', 'fr'];
const SITEMAP_FILE = 'sitemap-jobs.xml';

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'");
}

/** Same shape as validate-sitemap-pages.mjs's hasNoindex — attribute-order
 *  independent, quote-flexible (PR #478 removeAttributeQuotes). */
export function hasNoindex(html) {
  return /<meta(?=[^>]*name=["']?robots["']?)(?=[^>]*content=["']?[^"'>]*noindex)/i.test(html);
}

/** First <link rel=canonical> href in the document, or null. Quote-flexible. */
export function extractCanonical(html) {
  const linkRe = /<link\b[^>]*>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const tag = m[0];
    if (!/rel\s*=\s*["']?canonical["']?/i.test(tag)) continue;
    const href = tag.match(/href\s*=\s*"([^"]+)"/i) || tag.match(/href\s*=\s*'([^']+)'/i);
    if (href && href[1]) return decodeEntities(href[1].trim());
  }
  return null;
}

/** Host-insensitive, trailing-slash-insensitive URL compare. */
export function normalizeUrl(u) {
  try {
    const parsed = new URL(u, HOST);
    let path = parsed.pathname;
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${parsed.search}`;
  } catch {
    return String(u).trim();
  }
}

/** `data/keyword-pages-config.json` → slug list. Empty array if the file is
 *  absent (mirrors the plugin's own `fs.existsSync` guard — an absent config
 *  emits nothing, so there is nothing to check). */
export function loadConfigSlugs(configPath) {
  if (!existsSync(configPath)) return [];
  let raw;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    return [];
  }
  const pages = Array.isArray(raw?.pages) ? raw.pages : [];
  return pages.map((p) => String(p?.slug || '').trim()).filter(Boolean);
}

/** Every {slug, locale, path} candidate the keyword-landing family could
 *  occupy — one per slug × locale, using the SAME path builder the plugin
 *  itself uses (scripts/lib/keyword-page-paths.mjs). */
export function candidatePaths(slugs) {
  const out = [];
  for (const slug of slugs) {
    for (const locale of LOCALES) {
      const path = keywordLandingPath(slug, locale);
      if (path) out.push({ slug, locale, path });
    }
  }
  return out;
}

function pathToDistFile(distRoot, urlPath) {
  const trimmed = urlPath.replace(/^\/+/, '');
  return join(distRoot, trimmed, 'index.html');
}

/** Every decoded <loc> path (pathname only) in `dist/<sitemapFile>`. Empty
 *  set if the sitemap is absent. */
export function loadSitemapPaths(distRoot, sitemapFile = SITEMAP_FILE) {
  const out = new Set();
  const p = join(distRoot, sitemapFile);
  if (!existsSync(p)) return out;
  const xml = readFileSync(p, 'utf-8');
  const re = /<loc>\s*([^<\s][^<]*?)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const loc = decodeEntities(m[1].trim());
    try {
      out.add(new URL(loc).pathname.replace(/\/$/, ''));
    } catch {
      out.add(loc.replace(/\/$/, ''));
    }
  }
  return out;
}

/**
 * Core check. Pure function of (distRoot, configPath) so tests can point it
 * at a tmp fixture instead of a real build.
 *
 * @param {{ distRoot: string, configPath: string, sitemapFile?: string }} opts
 */
export function auditKeywordLandingCoverage({ distRoot, configPath, sitemapFile = SITEMAP_FILE }) {
  const slugs = loadConfigSlugs(configPath);
  const candidates = candidatePaths(slugs);
  const sitemapPaths = loadSitemapPaths(distRoot, sitemapFile);

  const sitemappedNotGenuine = [];
  const emittedNotSitemapped = [];
  let checked = 0;

  for (const { slug, locale, path } of candidates) {
    const normPath = path.replace(/\/$/, '');
    const inSitemap = sitemapPaths.has(normPath);
    const file = pathToDistFile(distRoot, path);

    if (!existsSync(file)) {
      if (inSitemap) {
        sitemappedNotGenuine.push({ slug, locale, path, reason: 'missing-html' });
      }
      continue;
    }

    checked++;
    let html;
    try {
      html = readFileSync(file, 'utf-8');
    } catch {
      if (inSitemap) sitemappedNotGenuine.push({ slug, locale, path, reason: 'read-error' });
      continue;
    }

    const noindex = hasNoindex(html);
    const canonical = extractCanonical(html);
    const selfCanonical = canonical != null && normalizeUrl(canonical) === normalizeUrl(HOST + path);
    const genuine = !noindex && selfCanonical;

    if (inSitemap && !genuine) {
      const reason = noindex ? 'noindex' : `canonical-mismatch:${canonical ?? '(none)'}`;
      sitemappedNotGenuine.push({ slug, locale, path, reason });
    }
    if (genuine && !inSitemap) {
      emittedNotSitemapped.push({ slug, locale, path });
    }
  }

  return {
    candidateCount: candidates.length,
    checked,
    sitemappedNotGenuine,
    emittedNotSitemapped,
  };
}

// ── Driver ─────────────────────────────────────────────────────────────────
async function main() {
  const distRoot = join(ROOT, 'dist');
  const configPath = join(ROOT, 'data', 'keyword-pages-config.json');

  if (!existsSync(distRoot)) {
    process.stderr.write('audit-keyword-landing-coverage: dist/ not found. Run `npm run build` first.\n');
    process.exit(2);
  }

  const { candidateCount, checked, sitemappedNotGenuine, emittedNotSitemapped } =
    auditKeywordLandingCoverage({ distRoot, configPath });

  const pass = sitemappedNotGenuine.length === 0;

  process.stdout.write(
    `[audit-keyword-landing-coverage] ${candidateCount} candidate URL(s) (config slugs × 4 locales), ` +
      `${checked} present in dist/\n`,
  );

  if (emittedNotSitemapped.length > 0) {
    process.stdout.write(
      `\n⚠️  ${emittedNotSitemapped.length} genuine keyword-landing page(s) not listed in ${SITEMAP_FILE} ` +
        `(informational — see file header, not blocking):\n`,
    );
    for (const o of emittedNotSitemapped.slice(0, 20)) {
      process.stdout.write(`   [${o.locale}] ${o.path} (slug: ${o.slug})\n`);
    }
    if (emittedNotSitemapped.length > 20) {
      process.stdout.write(`   ... and ${emittedNotSitemapped.length - 20} more\n`);
    }
  }

  if (sitemappedNotGenuine.length > 0) {
    process.stdout.write(
      `\n❌ ${sitemappedNotGenuine.length} URL(s) listed in ${SITEMAP_FILE} under the keyword-landing shape ` +
        `do NOT resolve to a genuine (indexable, self-canonical) page — BLOCKING:\n`,
    );
    for (const o of sitemappedNotGenuine.slice(0, 30)) {
      process.stdout.write(`   [${o.locale}] ${o.path} (slug: ${o.slug}) — ${o.reason}\n`);
    }
    if (sitemappedNotGenuine.length > 30) {
      process.stdout.write(`   ... and ${sitemappedNotGenuine.length - 30} more\n`);
    }
    process.stdout.write(
      '\n🛑 A sitemap <loc> MUST resolve to a self-canonical, indexable page. See CLAUDE.md SEO rules.\n',
    );
  } else {
    process.stdout.write('\n✅ Every keyword-landing sitemap entry resolves to a genuine, indexable page.\n');
  }

  const offenders = sitemappedNotGenuine.map((o) => ({
    path: o.path,
    feature: 'keyword-landing-coverage',
    metric: o.reason,
    ratio: null,
    slug: o.slug,
    locale: o.locale,
  }));

  await writeAuditReport({
    audit: 'keyword-landing-coverage',
    passed: pass,
    threshold: { metric: 'sitemappedNotGenuine', value: 0, comparator: '<=' },
    offenders,
    byFeature: { 'keyword-landing-coverage': sitemappedNotGenuine.length },
    extra: { candidateCount, checked, emittedNotSitemappedCount: emittedNotSitemapped.length },
  });

  process.exit(pass ? 0 : 1);
}

// Only run main() when invoked directly as a script (not when imported by
// tests via dynamic import) — same guard shape as
// scripts/audit-orphan-pages-in-sitemaps.mjs.
const invokedDirectly = (() => {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const argv1 = process.argv[1] ? process.argv[1] : '';
    return Boolean(argv1) && (argv1 === thisFile || argv1.endsWith('audit-keyword-landing-coverage.mjs'));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`audit-keyword-landing-coverage crashed: ${err && err.stack ? err.stack : err}\n`);
    process.exit(2);
  });
}

// Internal exports for tests (unreachable via CLI invocation).
export const __test = {
  hasNoindex,
  extractCanonical,
  normalizeUrl,
  loadConfigSlugs,
  candidatePaths,
  loadSitemapPaths,
  auditKeywordLandingCoverage,
  pathToFileURL,
};
