#!/usr/bin/env node
/**
 * audit-dist-multi.mjs
 *
 * Consolidated dist/ walker that runs NINE audits in a single pipeline,
 * reading every dist/**\/*.html exactly once:
 *
 *   1. audit-text-html-ratio              (Semrush low-text/HTML ratio gate)
 *   2. audit-title-length                 (SERP title length ratchet)
 *   3. audit-h1-title-duplicates          (duplicate H1/title ratchet)
 *   4. audit-content-duplicates           (per-locale duplicate body clusters)
 *   5. audit-page-weight                  (200 KB HTML budget + <img> attrs)
 *   6. audit-hreflang                     (hreflang completeness/host/target)
 *   7. audit-title-uniqueness             (within-locale unique <title>s)
 *   8. validate-jobposting-schema         (9 mandatory JobPosting fields)
 *   9. validate-structured-data-completeness (Dataset/JobPosting/Event/Product)
 *
 * The nine original scripts remain unchanged and continue to be the source of
 * truth for `--feature=…`, `--json`, `--csv`, `--write-baseline`,
 * `--include-noindex`, etc. THIS script only reproduces the CI deploy
 * invocation each of them uses (`npm run audit:<name>` / `npm run validate:*`)
 * — the exact same baseline files, thresholds, regexes, sampling logic, and
 * exit semantics — pipelined through one walk + one file read per HTML page.
 *
 * Exit code:
 *   0 — all nine audits passed
 *   1 — at least one audit failed (regression vs baseline, or hard threshold)
 *   2 — dist/ missing or fatal IO error
 *
 * No CLI flags — this is the CI gate-mode entry point. Use the originals for
 * interactive analysis (top-N offenders, JSON dumps, baseline rewrites).
 */

import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, sep, isAbsolute, dirname, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { TYPES_ACCEPT_IN_LANGUAGE_LIST } from '../services/seo/inlanguage-whitelist.data.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist');

// Hard-coded to match `npm run audit:*` invocations in package.json. If you
// change the npm scripts, update these constants in lock-step.
const RATIO_THRESHOLD = 10;
const RATIO_BASELINE_PATH = join(ROOT, 'data', 'text-html-ratio-baseline.json');
const TITLE_THRESHOLD = 90;
const TITLE_BASELINE_PATH = join(ROOT, 'data', 'title-length-baseline.json');
const H1_BASELINE_PATH = join(ROOT, 'data', 'h1-title-duplicates-baseline.json');
const RATIO_LIMIT = 30; // matches default --limit in audit-text-html-ratio
const TITLE_LIMIT = 30;
const H1_LIMIT = 30;

// audit-content-duplicates constants.
const DUP_CLUSTER_THRESHOLD = 5;
const DUP_MAX_REPORTED = 20;
const DUP_LOCALE_PREFIXES = /** @type {const} */ (['en', 'de', 'fr']);

// audit-page-weight constants.
const MAX_HTML_BYTES = 200 * 1024; // 200 KB per CLAUDE.md non-negotiable perf gate.

// audit-hreflang constants.
const HREFLANG_BASE_URL = 'https://frontaliereticino.ch';
const HREFLANG_LOCALES = ['it', 'en', 'de', 'fr'];
const HREFLANG_PREFIXED_LOCALES = ['en', 'de', 'fr'];
const HREFLANG_MAX = 50;

// audit-title-uniqueness constants.
const TITLE_UNIQ_MAX_COLLISIONS_REPORTED = 20;

// validate-jobposting-schema constants.
const JOBPOSTING_MAX_ERRORS = 60;
const JOBPOSTING_EMPLOYMENT_TYPES = new Set([
  'FULL_TIME', 'PART_TIME', 'CONTRACTOR', 'TEMPORARY',
  'INTERN', 'VOLUNTEER', 'PER_DIEM', 'OTHER',
]);

// validate-structured-data-completeness constants.
const SD_MAX_ERRORS_TO_PRINT = 60;
const SD_SAMPLE_FRACTION = 0.1; // sample 10% of pages, minimum 50
const SD_MIN_SAMPLE = 50;
const SD_INLANGUAGE_WHITELIST = new Set(TYPES_ACCEPT_IN_LANGUAGE_LIST);
const SD_WEBAPP_TYPES = new Set(['WebApplication', 'SoftwareApplication']);
const SD_UNIQUE_TYPES = ['FAQPage', 'HowTo', 'Article', 'NewsArticle', 'BlogPosting'];

// ───── shared regexes (verbatim from the originals) ──────────────────────────
const NOINDEX_RE = /<meta[^>]+name=["']robots["'][^>]+content=["'][^"']*noindex/i;
const META_REFRESH_RE = /<meta[^>]+http-equiv=["']refresh["']/i;
const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const H1_RE = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i;
const HEAD_RE = /<head\b[^>]*>([\s\S]*?)<\/head>/i;

// ───── walker (matches audit-text-html-ratio's walk) ─────────────────────────
/** @param {string} dir */
async function walk(dir) {
  /** @type {string[]} */
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return out;
    throw err;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walk(p)));
    } else if (e.isFile() && p.endsWith('.html')) {
      out.push(p);
    }
  }
  return out;
}

// ───── extractors (verbatim from the originals) ──────────────────────────────

/** From audit-text-html-ratio.extractVisibleText. */
function extractVisibleText(html) {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<!doctype[^>]*>/gi, ' ');
  s = s.replace(/<script\b[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ');
  s = s.replace(/<template\b[\s\S]*?<\/template>/gi, ' ');
  s = s.replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/** From audit-title-length.normalizeText / audit-h1-title-duplicates.normalizeText (identical). */
function normalizeText(raw) {
  if (!raw) return '';
  let s = raw.replace(/<[^>]+>/g, ' ');
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
  return s.replace(/\s+/g, ' ').trim();
}

/** From audit-content-duplicates.extractBodyText. */
function extractBodyText(html) {
  if (!html) return '';
  let body = html;
  body = body.replace(/<head[^>]*>[\s\S]*?<\/head>/gi, ' ');
  body = body.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ');
  body = body.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ');
  body = body.replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, ' ');
  body = body.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, ' ');
  body = body.replace(/<footer[\s\S]*?<\/footer>/gi, ' ');
  body = body.replace(/<header\b[^>]*(role=["']banner["']|class=["'][^"']*site-[^"']*["'])[^>]*>[\s\S]*?<\/header>/gi, ' ');
  body = body.replace(/<[^>]+>/g, ' ');
  body = body
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&(?:[a-z]+|#\d+);/gi, ' ');
  return body.replace(/\s+/g, ' ').trim();
}

/** From audit-content-duplicates.canonicalizeDistPath. */
function canonicalizeDistPath(relPath) {
  const posix = relPath.split(sep).join('/');
  if (posix === 'index.html') return '/';
  if (posix.endsWith('/index.html')) return posix.slice(0, -'index.html'.length);
  if (posix.endsWith('.html')) return `${posix.slice(0, -'.html'.length)}/`;
  return posix;
}

/** From audit-content-duplicates.inferLocale (uses path.sep, dist-relative). */
function inferDupLocale(relPath) {
  const first = relPath.split(sep)[0] || '';
  if (DUP_LOCALE_PREFIXES.includes(/** @type {'en'|'de'|'fr'} */ (first))) {
    return /** @type {'en'|'de'|'fr'} */ (first);
  }
  return 'it';
}

/** From audit-title-length.inferLocale / audit-h1-title-duplicates.inferLocale. */
function inferRootLocale(relPath) {
  const seg = relPath.replace(/\\/g, '/').replace(/^dist\//, '').split('/')[0];
  if (seg === 'en' || seg === 'de' || seg === 'fr') return seg;
  return 'it';
}

/** From audit-content-duplicates.extractCanonical. */
function extractCanonical(html) {
  const headMatch = HEAD_RE.exec(html);
  const scope = headMatch ? headMatch[1] : html;
  const m = /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i.exec(scope);
  if (m) return m[1].trim();
  const m2 = /<link[^>]+href=["']([^"']+)["'][^>]*rel=["']canonical["']/i.exec(scope);
  return m2 ? m2[1].trim() : null;
}

/** From audit-content-duplicates.hasNoindex (head-scoped, content attribute parse). */
function hasNoindexDup(html) {
  const headMatch = HEAD_RE.exec(html);
  const scope = headMatch ? headMatch[1] : html;
  const m = /<meta[^>]+name=["']robots["'][^>]*content=["']([^"']+)["']/i.exec(scope);
  if (!m) return false;
  return /\bnoindex\b/i.test(m[1]);
}

function sha256(content) {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

// ───── shared JSON-LD extraction (verbatim from validate-* originals) ─────────

/**
 * Extract every JSON-LD block from an HTML page. Mirrors both
 * validate-jobposting-schema.extractJsonLdBlocks and
 * validate-structured-data-completeness.extractJsonLd verbatim. Unparseable
 * blocks are silently skipped (matches both originals).
 */
function extractJsonLdBlocks(html) {
  const out = [];
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = (m[1] || '').trim();
    if (!raw) continue;
    try {
      out.push(JSON.parse(raw));
    } catch { /* skip unparseable */ }
  }
  return out;
}

/** Verbatim from validate-jobposting-schema.flattenBlocks (recursive @graph). */
function flattenJobPostingBlocks(blocks) {
  const out = [];
  const seen = new WeakSet();
  function visit(obj) {
    if (!obj || typeof obj !== 'object' || seen.has(obj)) return;
    seen.add(obj);
    if (Array.isArray(obj)) { for (const v of obj) visit(v); return; }
    out.push(obj);
    if (Array.isArray(obj['@graph'])) for (const v of obj['@graph']) visit(v);
  }
  for (const b of blocks) visit(b);
  return out;
}

/** Verbatim from validate-structured-data-completeness.flattenSchemas (full deep walk). */
function flattenSdSchemas(blocks) {
  const out = [];
  const seen = new WeakSet();
  function collect(obj) {
    if (!obj || typeof obj !== 'object' || seen.has(obj)) return;
    seen.add(obj);
    if (Array.isArray(obj)) { for (const item of obj) collect(item); return; }
    if (obj['@type']) out.push(obj);
    for (const val of Object.values(obj)) {
      if (val && typeof val === 'object') collect(val);
    }
  }
  for (const b of blocks) collect(b);
  return out;
}

// ───── feature classifiers (one per audit — they intentionally diverge) ──────

/** From audit-text-html-ratio.classifyFeature. */
function classifyFeatureRatio(relPath) {
  const p = '/' + relPath.replace(/\\/g, '/').replace(/^dist\//, '').replace(/index\.html$/, '');
  if (/(?:^|\/)(?:cerca-lavoro-ticino|find-jobs-ticino|jobs-im-tessin|trouver-emploi-tessin)\/(?:azienda|company|unternehmen|entreprise)-[^/]+\/?$/.test(p)) {
    return 'career-landings';
  }
  if (/(?:^|\/)(prezzi-benzina-svizzera|prezzi-benzina|prezzi-diesel|prezzi-carburante-svizzera|gasoline-price-switzerland|diesel-price-switzerland|prix-essence-suisse|prix-diesel-suisse|prix-gasoil-suisse|fuel-prices-switzerland|benzinpreis-schweiz|dieselpreis-schweiz|benzinpreise-schweiz)\//.test(p)) return 'fuel-daily';
  if (/(?:^|\/)(?:aziende-che-assumono|companies-hiring|unternehmen-einstellen|firmen-die-einstellen|entreprises-recrutent|entreprises-qui-recrutent)\/[^/]+\/[^/]+\//.test(p)) {
    return 'weekly-employers';
  }
  if (/(?:^|\/)(?:aziende-che-assumono|companies-hiring|unternehmen-einstellen|firmen-die-einstellen|entreprises-recrutent|entreprises-qui-recrutent)\//.test(p)) {
    return 'weekly-employers-hub';
  }
  if (/(?:^|\/)(?:cerca-lavoro-ticino|find-jobs-ticino|jobs-im-tessin|trouver-emploi-tessin)\//.test(p)) return 'job-board';
  if (/(?:^|\/)(?:premi-cassa-malati|health-insurance-premiums|health-premiums|krankenkassenpraemien|krankenkassen-praemien|primes-assurance-maladie|primes-assurance-maladie-communes|primi-cassa-malati-comuni)\//.test(p)) return 'health-premiums';
  if (/(?:^|\/)(?:mercato-lavoro-ticino|ticino-job-market|tessiner-arbeitsmarkt|tessin-arbeitsmarkt|marche-travail-tessin|tessin-marche-emploi|mercato-lavoro|job-market|arbeitsmarkt|marche-emploi)\//.test(p)) return 'job-market-snapshot';
  if (/(?:^|\/)(?:articoli-frontaliere|cross-border-articles|grenzgaenger-artikel|articles-frontalier|blog|articles)\//.test(p)) return 'blog';
  if (/(?:^|\/)(?:traffico-dogane|border-wait|wartezeit-grenze|temps-attente-douane|tempi-attesa-frontiera|border-wait-times|grenzwartezeiten|temps-attente-frontiere)\//.test(p)) return 'border-wait';
  if (/^\/(en|de|fr)\//.test(p)) return 'spa-locale';
  return 'spa-other';
}

/** From audit-title-length.classifyFeature. */
function classifyFeatureTitle(relPath) {
  const p = '/' + relPath.replace(/\\/g, '/').replace(/^dist\//, '').replace(/index\.html$/, '');
  if (/(?:^|\/)(prezzi-benzina-svizzera|prezzi-carburante-svizzera|prix-essence-suisse|fuel-prices-switzerland|benzinpreise?-schweiz|prezzi-benzina|prezzi-diesel|gasoline-price|diesel-price|benzinpreis|dieselpreis|prix-essence|prix-gasoil|prix-diesel)\//.test(p)) return 'fuel-daily';
  if (/(?:^|\/)(?:cerca-lavoro-ticino|find-jobs-ticino|jobs-im-tessin|trouver-emploi-tessin)\/(?:azienda|company|unternehmen|entreprise)-/.test(p)) return 'weekly-employers';
  if (/(?:^|\/)(?:aziende-che-assumono|companies-hiring|firmen-die-einstellen|unternehmen-die-einstellen|entreprises-qui-recrutent)\//.test(p)) return 'weekly-employers-hub';
  if (/(?:^|\/)(?:cerca-lavoro-ticino|find-jobs-ticino|jobs-im-tessin|trouver-emploi-tessin)\//.test(p)) return 'job-board';
  if (/(?:^|\/)(?:premi-cassa-malati|cassa-malati|health-premiums|health-insurance|krankenkassen-praemien|krankenkasse|primes-assurance-maladie)\//.test(p)) return 'health-premiums';
  if (/(?:^|\/)(?:mercato-lavoro|mercato-lavoro-ticino|job-market|ticino-job-market|arbeitsmarkt|arbeitsmarkt-tessin|marche-emploi|marche-travail|marche-emploi-tessin|marche-travail-tessin)\//.test(p)) return 'job-market-snapshot';
  if (/(?:^|\/)(?:articoli-frontaliere|cross-border-articles|grenzgaenger-artikel|articles-frontalier)\//.test(p)) return 'blog';
  if (/(?:^|\/)(?:tempi-attesa-frontiera|border-wait-times|grenzwartezeiten|wartezeit-grenze|temps-attente-frontiere)\//.test(p)) return 'border-wait';
  if (/^\/(en|de|fr)\//.test(p)) return 'spa-locale';
  return 'spa-other';
}

/** From audit-h1-title-duplicates.classifyFeature. */
function classifyFeatureH1(relPath) {
  const p = '/' + relPath.replace(/\\/g, '/').replace(/^dist\//, '').replace(/index\.html$/, '');
  if (/(?:^|\/)(prezzi-benzina-svizzera|prezzi-carburante-svizzera|prix-essence-suisse|fuel-prices-switzerland|benzinpreise?-schweiz)\//.test(p)) return 'fuel-daily';
  if (/(?:^|\/)(?:cerca-lavoro-ticino|find-jobs-ticino|jobs-im-tessin|trouver-emploi-tessin)\/(?:azienda|company|unternehmen|entreprise)-/.test(p)) return 'weekly-employers';
  if (/(?:^|\/)(?:cerca-lavoro-ticino|find-jobs-ticino|jobs-im-tessin|trouver-emploi-tessin)\//.test(p)) return 'job-board';
  if (/(?:^|\/)(?:aziende-che-assumono|companies-hiring|firmen-die-einstellen|entreprises-qui-recrutent)\//.test(p)) return 'weekly-employers-hub';
  if (/(?:^|\/)(?:premi-cassa-malati|health-premiums|krankenkassen-praemien|primes-assurance-maladie)\//.test(p)) return 'health-premiums';
  if (/(?:^|\/)(?:mercato-lavoro|job-market|arbeitsmarkt|marche-emploi)\//.test(p)) return 'job-market-snapshot';
  if (/(?:^|\/)(?:articoli-frontaliere|cross-border-articles|grenzgaenger-artikel|articles-frontalier)\//.test(p)) return 'blog';
  if (/(?:^|\/)(?:tempi-attesa-frontiera|border-wait-times|grenzwartezeiten|wartezeit-grenze|temps-attente-frontiere)\//.test(p)) return 'border-wait';
  if (/^\/(en|de|fr)\//.test(p)) return 'spa-locale';
  return 'spa-other';
}

// ───── per-audit accumulators ────────────────────────────────────────────────

class RatioAudit {
  constructor() {
    this.report = []; // { file, feature, htmlBytes, textBytes, ratio }
    this.skippedNoindex = 0;
  }
  /** Mirrors the per-file body of audit-text-html-ratio.main loop. */
  ingest(file, html, htmlBytes, relFromRoot) {
    if (htmlBytes === 0) return;
    if (NOINDEX_RE.test(html) || META_REFRESH_RE.test(html)) {
      this.skippedNoindex++;
      return;
    }
    const text = extractVisibleText(html);
    const textBytes = Buffer.byteLength(text, 'utf8');
    const ratio = (textBytes / htmlBytes) * 100;
    const feature = classifyFeatureRatio(relFromRoot);
    this.report.push({ file: relFromRoot, feature, htmlBytes, textBytes, ratio });
  }
}

class TitleAudit {
  constructor() {
    this.scanned = 0;
    this.skippedNoindex = 0;
    this.missingTitle = 0;
    this.offenders = []; // { file, feature, locale, title, length }
  }
  /** Mirrors the per-file body of audit-title-length.main loop. */
  ingest(file, html, relFromRoot) {
    if (!html) return;
    if (NOINDEX_RE.test(html) || META_REFRESH_RE.test(html)) {
      this.skippedNoindex++;
      return;
    }
    this.scanned++;
    const titleMatch = html.match(TITLE_RE);
    const title = normalizeText(titleMatch?.[1] ?? '');
    if (!title) { this.missingTitle++; return; }
    if (title.length <= TITLE_THRESHOLD) return;
    const feature = classifyFeatureTitle(relFromRoot);
    const locale = inferRootLocale(relFromRoot);
    this.offenders.push({ file: relFromRoot, feature, locale, title, length: title.length });
  }
}

class H1Audit {
  constructor() {
    this.scanned = 0;
    this.skippedNoindex = 0;
    this.missingTitle = 0;
    this.missingH1 = 0;
    this.offenders = []; // { file, feature, locale, title, h1 }
  }
  /** Mirrors the per-file body of audit-h1-title-duplicates.main loop. */
  ingest(file, html, relFromRoot) {
    if (!html) return;
    if (NOINDEX_RE.test(html) || META_REFRESH_RE.test(html)) {
      this.skippedNoindex++;
      return;
    }
    this.scanned++;
    const titleMatch = html.match(TITLE_RE);
    const h1Match = html.match(H1_RE);
    const title = normalizeText(titleMatch?.[1] ?? '');
    const h1 = normalizeText(h1Match?.[1] ?? '');
    if (!title) { this.missingTitle++; return; }
    if (!h1) { this.missingH1++; return; }
    if (title.toLowerCase() !== h1.toLowerCase()) return;
    const feature = classifyFeatureH1(relFromRoot);
    const locale = inferRootLocale(relFromRoot);
    this.offenders.push({ file: relFromRoot, feature, locale, title, h1 });
  }
}

// ───── audit-page-weight helpers (verbatim) ──────────────────────────────────

/** From audit-page-weight.findImgIssues. */
function findImgIssues(html) {
  const issues = [];
  const imgRe = /<img\b([^>]*)>/gi;
  let m;
  while ((m = imgRe.exec(html)) !== null) {
    const attrs = m[1];
    const missing = [];
    if (!/\bwidth\s*=/.test(attrs)) missing.push('width');
    if (!/\bheight\s*=/.test(attrs)) missing.push('height');
    const hasLoading = /\bloading\s*=/.test(attrs);
    const hasFetchPri = /\bfetchpriority\s*=\s*["']?high/i.test(attrs);
    if (!hasLoading && !hasFetchPri) missing.push('loading|fetchpriority');
    if (missing.length > 0) {
      issues.push({ tag: m[0].slice(0, 160), missing });
    }
  }
  return issues;
}

/** From audit-page-weight.inlineBreakdown. */
function inlineBreakdown(html) {
  let inlineJs = 0;
  const scriptRe = /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = scriptRe.exec(html)) !== null) inlineJs += Buffer.byteLength(m[1], 'utf8');
  let inlineCss = 0;
  const styleRe = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  while ((m = styleRe.exec(html)) !== null) inlineCss += Buffer.byteLength(m[1], 'utf8');
  return { inlineJs, inlineCss };
}

class PageWeightAudit {
  constructor() {
    this.report = []; // { file, bytes, inlineJs, inlineCss, imgIssues }
    this.oversized = []; // strings ("rel (size KB)")
    this.imgMissingAttrs = []; // { file, issues:[{tag, missing}] }
  }
  /** Mirrors per-file body of audit-page-weight.main loop. */
  ingest(file, html, htmlBytes, relFromRoot) {
    const { inlineJs, inlineCss } = inlineBreakdown(html);
    const imgIssues = findImgIssues(html);
    this.report.push({ file: relFromRoot, bytes: htmlBytes, inlineJs, inlineCss, imgIssues: imgIssues.length });
    if (htmlBytes > MAX_HTML_BYTES) {
      this.oversized.push(`${relFromRoot} (${(htmlBytes / 1024).toFixed(1)} KB)`);
    }
    if (imgIssues.length > 0) {
      this.imgMissingAttrs.push({ file: relFromRoot, issues: imgIssues });
    }
  }
}

// ───── audit-hreflang helpers (verbatim) ─────────────────────────────────────

/** From audit-hreflang.extractAlternates. */
function extractAlternates(html) {
  const map = new Map();
  const regex = /<link\s+rel="alternate"[^>]*hreflang="([^"]+)"[^>]*href="([^"]+)"/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    map.set(match[1], match[2]);
  }
  return map;
}

/** From audit-hreflang.urlToDistFile. */
function urlToDistFile(url) {
  const cleaned = url.split('#')[0].split('?')[0];
  if (!cleaned.startsWith(HREFLANG_BASE_URL)) return null;
  const pathname = cleaned.slice(HREFLANG_BASE_URL.length) || '/';
  if (pathname === '/' || pathname === '') return join(DIST, 'index.html');
  const rel = pathname.replace(/^\//, '').replace(/\/$/, '');
  if (extname(rel)) return join(DIST, rel);
  return join(DIST, rel, 'index.html');
}

/** From audit-hreflang.validateLocalePair. */
function validateLocalePair(hreflang, href) {
  if (!href.startsWith(`${HREFLANG_BASE_URL}/`) && href !== HREFLANG_BASE_URL) {
    return `href "${href}" is not on canonical host ${HREFLANG_BASE_URL}`;
  }
  if (hreflang === 'x-default') return null;
  if (!HREFLANG_LOCALES.includes(hreflang)) {
    return `unknown hreflang code "${hreflang}"`;
  }
  const pathname = href.slice(HREFLANG_BASE_URL.length) || '/';
  const isPrefixed = HREFLANG_PREFIXED_LOCALES.some((p) => pathname.startsWith(`/${p}/`));
  if (hreflang === 'it') {
    if (isPrefixed) {
      return `hreflang="it" path "${pathname}" starts with a non-IT locale prefix`;
    }
  } else {
    const expectedPrefix = `/${hreflang}/`;
    if (!pathname.startsWith(expectedPrefix)) {
      return `hreflang="${hreflang}" path "${pathname}" does not start with "${expectedPrefix}"`;
    }
  }
  return null;
}

function normaliseHref(href) {
  return href.replace(/\/$/, '');
}

class HreflangAudit {
  constructor(distFileSet) {
    this.distFileSet = distFileSet;
    this.scanned = 0;
    this.withHreflang = 0;
    this.failures = {
      tooFew: [],
      invalidPair: [],
      xDefaultMismatch: [],
      missingTarget: [],
    };
  }
  /** Mirrors per-file body of audit-hreflang.main loop (uses cached file index). */
  ingest(file, html, distRel) {
    this.scanned++;
    const alternates = extractAlternates(html);
    if (alternates.size === 0) return;
    this.withHreflang++;

    const rel = distRel;

    if (alternates.size < 5) {
      this.failures.tooFew.push(
        `${rel}: has only ${alternates.size} hreflang entries (need 4 locales + x-default)`,
      );
    }

    for (const [hreflang, href] of alternates) {
      const error = validateLocalePair(hreflang, href);
      if (error) {
        this.failures.invalidPair.push(`${rel}: ${error}`);
      }
    }

    const itHref = alternates.get('it');
    const xDefault = alternates.get('x-default');
    if (itHref && xDefault && normaliseHref(itHref) !== normaliseHref(xDefault)) {
      this.failures.xDefaultMismatch.push(
        `${rel}: x-default "${xDefault}" does not match IT hreflang "${itHref}"`,
      );
    }

    for (const [hreflang, href] of alternates) {
      if (!href.startsWith(HREFLANG_BASE_URL)) continue;
      const target = urlToDistFile(href);
      if (!target) continue;
      if (!this.distFileSet.has(target)) {
        const alt = target.endsWith(`${sep}index.html`)
          ? target.slice(0, -`${sep}index.html`.length) + '.html'
          : join(dirname(target), basename(target, '.html'), 'index.html');
        if (!this.distFileSet.has(alt)) {
          this.failures.missingTarget.push(
            `${rel}: hreflang="${hreflang}" target not found in dist/ (${href})`,
          );
        }
      }
    }
  }
}

// ───── audit-title-uniqueness helpers (verbatim) ─────────────────────────────

/** From audit-title-uniqueness.extractHeadTitle (HEAD-scoped). */
function extractHeadTitle(html) {
  const headMatch = HEAD_RE.exec(html);
  const scope = headMatch ? headMatch[1] : html;
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(scope);
  if (!titleMatch) return null;
  return titleMatch[1].replace(/\s+/g, ' ').trim();
}

class TitleUniqAudit {
  constructor() {
    this.totalPages = 0;
    this.missingTitles = 0;
    /** @type {Map<string, Map<string, Map<string, string[]>>>} */
    this.titlesByLocale = new Map();
  }
  /** Mirrors per-file body of audit-title-uniqueness.main loop. */
  ingest(file, html, distRel) {
    const locale = inferDupLocale(distRel);
    const fsCanonical = canonicalizeDistPath(distRel);

    const title = extractHeadTitle(html);
    this.totalPages += 1;
    if (!title) { this.missingTitles += 1; return; }
    if (hasNoindexDup(html)) return;

    const canonicalUrl = extractCanonical(html);
    const canonicalKey = canonicalUrl ?? fsCanonical;

    if (!this.titlesByLocale.has(locale)) {
      this.titlesByLocale.set(locale, new Map());
    }
    const bucket = /** @type {Map<string, Map<string, string[]>>} */ (this.titlesByLocale.get(locale));
    if (!bucket.has(title)) {
      bucket.set(title, new Map());
    }
    const byCanonical = /** @type {Map<string, string[]>} */ (bucket.get(title));
    if (!byCanonical.has(canonicalKey)) {
      byCanonical.set(canonicalKey, []);
    }
    /** @type {string[]} */ (byCanonical.get(canonicalKey)).push(distRel);
  }
}

// ───── validate-jobposting-schema helpers (verbatim) ─────────────────────────

function jpIsNonEmptyString(x) {
  return typeof x === 'string' && x.trim().length > 0;
}

function jpIsValidIsoDate(x) {
  if (!jpIsNonEmptyString(x)) return false;
  return !Number.isNaN(new Date(x).getTime());
}

/** Verbatim from validate-jobposting-schema.validateJobPosting. */
function validateJobPostingStrict(schema) {
  const errors = [];

  if (!jpIsNonEmptyString(schema.title)) errors.push('title missing/empty');

  if (!jpIsNonEmptyString(schema.description)) errors.push('description missing/empty');
  else if (schema.description.length < 50) errors.push(`description too short (${schema.description.length} < 50)`);

  if (!jpIsValidIsoDate(schema.datePosted)) errors.push('datePosted missing/invalid');

  if (!jpIsNonEmptyString(schema.employmentType)) errors.push('employmentType missing/empty');
  else if (!JOBPOSTING_EMPLOYMENT_TYPES.has(schema.employmentType)) {
    errors.push(`employmentType="${schema.employmentType}" not in schema.org enum`);
  }

  if (!schema.hiringOrganization || typeof schema.hiringOrganization !== 'object') {
    errors.push('hiringOrganization missing');
  } else if (!jpIsNonEmptyString(schema.hiringOrganization.name)) {
    errors.push('hiringOrganization.name missing/empty');
  }

  const loc = schema.jobLocation;
  if (!loc || typeof loc !== 'object') {
    errors.push('jobLocation missing');
  } else {
    const addr = loc.address;
    if (!addr || typeof addr !== 'object') {
      errors.push('jobLocation.address missing');
    } else {
      if (!jpIsNonEmptyString(addr.postalCode)) errors.push('jobLocation.address.postalCode missing/empty');
      else if (!/^\d{4,5}$/.test(String(addr.postalCode).trim())) errors.push(`jobLocation.address.postalCode="${addr.postalCode}" invalid`);
      if (!jpIsNonEmptyString(addr.streetAddress)) errors.push('jobLocation.address.streetAddress missing/empty');
      if (!jpIsNonEmptyString(addr.addressLocality)) errors.push('jobLocation.address.addressLocality missing/empty');
      if (!jpIsNonEmptyString(addr.addressRegion)) errors.push('jobLocation.address.addressRegion missing/empty');
      if (!jpIsNonEmptyString(addr.addressCountry)) {
        errors.push('jobLocation.address.addressCountry missing/empty');
      } else if (!/^[A-Z]{2}$/.test(String(addr.addressCountry).trim())) {
        errors.push(`jobLocation.address.addressCountry="${addr.addressCountry}" is not a 2-letter ISO 3166-1 alpha-2 code`);
      }
    }
  }

  const sal = schema.baseSalary;
  if (!sal || typeof sal !== 'object') {
    errors.push('baseSalary missing');
  } else {
    if (!jpIsNonEmptyString(sal.currency)) errors.push('baseSalary.currency missing/empty');
    if (!sal.value || typeof sal.value !== 'object') {
      errors.push('baseSalary.value missing');
    } else {
      const min = Number(sal.value.minValue);
      const max = Number(sal.value.maxValue);
      if (!(min > 0)) errors.push(`baseSalary.value.minValue=${sal.value.minValue} must be > 0`);
      if (!(max >= min)) errors.push(`baseSalary.value.maxValue=${sal.value.maxValue} must be >= minValue`);
      if (!jpIsNonEmptyString(sal.value.unitText)) errors.push('baseSalary.value.unitText missing/empty');
    }
  }

  return errors;
}

class JobPostingAudit {
  constructor() {
    this.totalFiles = 0;
    this.pagesWithJobPosting = 0;
    this.schemaCount = 0;
    this.failures = []; // { file, errors }
  }
  /**
   * Mirrors per-file body of validate-jobposting-schema.main loop.
   * Pre-extracted JSON-LD blocks may be passed (when JSON-LD has been parsed
   * once for shared use); otherwise we extract from html directly.
   */
  ingest(file, html, relFromCwd, sharedBlocks) {
    this.totalFiles++;
    if (!html.includes('"JobPosting"') && !html.includes("'JobPosting'")) return;
    const blocks = sharedBlocks ?? extractJsonLdBlocks(html);
    const flat = flattenJobPostingBlocks(blocks);
    const postings = flat.filter((b) => b && b['@type'] === 'JobPosting');
    if (postings.length === 0) return;
    this.pagesWithJobPosting++;
    for (const posting of postings) {
      this.schemaCount++;
      const errors = validateJobPostingStrict(posting);
      if (errors.length > 0) {
        this.failures.push({ file: relFromCwd, errors });
      }
    }
  }
}

// ───── validate-structured-data-completeness helpers (verbatim) ──────────────

function sdIsNonEmpty(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (typeof v === 'number') return true;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return Boolean(v);
}

function sdClassifyPage(filePath) {
  const rel = relative(DIST, filePath);
  if (/(^|\/)(prezzi-(diesel|benzina)|diesel-price-switzerland|gasoline-price-switzerland|dieselpreis-schweiz|benzinpreis-schweiz|prix-gasoil-suisse|prix-essence-suisse)\//.test(rel)) {
    return 'fuel';
  }
  if (/cerca-lavoro-ticino|find-jobs-ticino|jobs-im-tessin|trouver-emploi-tessin/.test(rel)) {
    return 'job';
  }
  if (/statistiche|statistics|statistiken|statistiques/.test(rel)) return 'statistics';
  if (/blog|articoli|articles/.test(rel)) return 'blog';
  if (/aziend|compan|unternehmen|entreprise/.test(rel)) return 'company';
  return 'other';
}

function sdValidateDataset(schema, filePath) {
  const errors = [];
  const type = schema['@type'];
  if (type !== 'Dataset') return errors;
  if (!sdIsNonEmpty(schema.description)) {
    errors.push({ file: filePath, type: 'Dataset', field: 'description', message: 'Dataset missing "description"' });
  }
  if (!schema.creator || !sdIsNonEmpty(schema.creator?.name || schema.creator)) {
    errors.push({ file: filePath, type: 'Dataset', field: 'creator', message: 'Dataset missing "creator" or creator.name' });
  }
  if (!sdIsNonEmpty(schema.license)) {
    errors.push({ file: filePath, type: 'Dataset', field: 'license', message: 'Dataset missing "license"' });
  }
  return errors;
}

function sdValidateJobPosting(schema, filePath) {
  const errors = [];
  const type = schema['@type'];
  if (type !== 'JobPosting') return errors;
  const checks = [
    ['title', schema.title],
    ['datePosted', schema.datePosted],
    ['hiringOrganization.name', schema.hiringOrganization?.name],
    ['employmentType', schema.employmentType],
    ['validThrough', schema.validThrough],
  ];
  for (const [field, value] of checks) {
    if (!sdIsNonEmpty(value)) {
      errors.push({ file: filePath, type: 'JobPosting', field, message: `JobPosting missing "${field}"` });
    }
  }
  if (sdIsNonEmpty(schema.validThrough)) {
    const vt = new Date(String(schema.validThrough));
    if (Number.isNaN(vt.getTime())) {
      errors.push({ file: filePath, type: 'JobPosting', field: 'validThrough', message: `JobPosting validThrough "${schema.validThrough}" is not a valid ISO date` });
    }
  }
  const desc = String(schema.description || '').trim();
  if (desc.length < 30) {
    errors.push({ file: filePath, type: 'JobPosting', field: 'description', message: `JobPosting description too short (${desc.length} chars, need >= 30)` });
  }
  const address = schema.jobLocation?.address;
  if (!address) {
    errors.push({ file: filePath, type: 'JobPosting', field: 'jobLocation', message: 'JobPosting missing "jobLocation.address"' });
  } else {
    if (!sdIsNonEmpty(address.addressLocality)) {
      errors.push({ file: filePath, type: 'JobPosting', field: 'jobLocation.address.addressLocality', message: 'JobPosting missing "addressLocality"' });
    }
    if (!sdIsNonEmpty(address.postalCode)) {
      errors.push({ file: filePath, type: 'JobPosting', field: 'jobLocation.address.postalCode', message: 'JobPosting missing "postalCode"' });
    }
    if (!sdIsNonEmpty(address.streetAddress)) {
      errors.push({ file: filePath, type: 'JobPosting', field: 'jobLocation.address.streetAddress', message: 'JobPosting missing "streetAddress"' });
    }
    if (!sdIsNonEmpty(address.addressRegion)) {
      errors.push({ file: filePath, type: 'JobPosting', field: 'jobLocation.address.addressRegion', message: 'JobPosting missing "addressRegion"' });
    } else if (!/^[A-Z]{2}$/.test(String(address.addressRegion).trim())) {
      errors.push({ file: filePath, type: 'JobPosting', field: 'jobLocation.address.addressRegion', message: `JobPosting addressRegion "${address.addressRegion}" is not a 2-letter Swiss canton code` });
    }
  }
  const bs = schema.baseSalary;
  if (!bs || typeof bs !== 'object') {
    errors.push({ file: filePath, type: 'JobPosting', field: 'baseSalary', message: 'JobPosting missing "baseSalary"' });
  } else {
    const val = bs.value;
    if (!val || typeof val !== 'object') {
      errors.push({ file: filePath, type: 'JobPosting', field: 'baseSalary.value', message: 'JobPosting baseSalary missing "value"' });
    } else {
      const minVal = Number(val.minValue);
      if (!Number.isFinite(minVal) || minVal <= 0) {
        errors.push({ file: filePath, type: 'JobPosting', field: 'baseSalary.value.minValue', message: 'JobPosting baseSalary.value.minValue missing or invalid' });
      }
      const maxVal = Number(val.maxValue);
      if (!Number.isFinite(maxVal) || maxVal <= 0) {
        errors.push({ file: filePath, type: 'JobPosting', field: 'baseSalary.value.maxValue', message: 'JobPosting baseSalary.value.maxValue missing or invalid' });
      } else if (Number.isFinite(minVal) && maxVal < minVal) {
        errors.push({ file: filePath, type: 'JobPosting', field: 'baseSalary.value.maxValue', message: 'JobPosting baseSalary.value.maxValue < minValue' });
      }
      if (!sdIsNonEmpty(val.unitText)) {
        errors.push({ file: filePath, type: 'JobPosting', field: 'baseSalary.value.unitText', message: 'JobPosting baseSalary.value.unitText missing' });
      }
    }
    if (!sdIsNonEmpty(bs.currency)) {
      errors.push({ file: filePath, type: 'JobPosting', field: 'baseSalary.currency', message: 'JobPosting baseSalary.currency missing' });
    }
  }
  return errors;
}

function sdValidateEvent(schema, filePath) {
  const errors = [];
  if (schema['@type'] !== 'Event') return errors;
  const stringChecks = [
    ['name', schema.name],
    ['startDate', schema.startDate],
    ['endDate', schema.endDate],
    ['eventStatus', schema.eventStatus],
    ['eventAttendanceMode', schema.eventAttendanceMode],
  ];
  for (const [field, value] of stringChecks) {
    if (!sdIsNonEmpty(value)) {
      errors.push({ file: filePath, type: 'Event', field, message: `Event missing "${field}"` });
    }
  }
  const desc = String(schema.description || '').trim();
  if (desc.length < 30) {
    errors.push({ file: filePath, type: 'Event', field: 'description', message: `Event description too short (${desc.length} chars, need >= 30)` });
  }
  if (!schema.location || typeof schema.location !== 'object') {
    errors.push({ file: filePath, type: 'Event', field: 'location', message: 'Event missing "location"' });
  } else {
    const addr = schema.location.address;
    if (!addr || !sdIsNonEmpty(addr.addressLocality)) {
      errors.push({ file: filePath, type: 'Event', field: 'location.address.addressLocality', message: 'Event missing "location.address.addressLocality"' });
    }
  }
  const hasImage = Array.isArray(schema.image)
    ? schema.image.some((img) => sdIsNonEmpty(typeof img === 'string' ? img : img?.url))
    : sdIsNonEmpty(typeof schema.image === 'string' ? schema.image : schema.image?.url);
  if (!hasImage) {
    errors.push({ file: filePath, type: 'Event', field: 'image', message: 'Event missing "image"' });
  }
  if (!schema.organizer || !sdIsNonEmpty(schema.organizer.name)) {
    errors.push({ file: filePath, type: 'Event', field: 'organizer', message: 'Event missing "organizer" or organizer.name' });
  } else if (!sdIsNonEmpty(schema.organizer.url)) {
    errors.push({ file: filePath, type: 'Event', field: 'organizer.url', message: 'Event missing "organizer.url"' });
  }
  if (!schema.performer || !sdIsNonEmpty(schema.performer.name)) {
    errors.push({ file: filePath, type: 'Event', field: 'performer', message: 'Event missing "performer" or performer.name' });
  }
  if (!schema.offers || typeof schema.offers !== 'object') {
    errors.push({ file: filePath, type: 'Event', field: 'offers', message: 'Event missing "offers"' });
  } else {
    if (schema.offers.price === undefined || schema.offers.price === null) {
      errors.push({ file: filePath, type: 'Event', field: 'offers.price', message: 'Event offers missing "price"' });
    }
    if (!sdIsNonEmpty(schema.offers.priceCurrency)) {
      errors.push({ file: filePath, type: 'Event', field: 'offers.priceCurrency', message: 'Event offers missing "priceCurrency"' });
    }
    if (!sdIsNonEmpty(schema.offers.availability)) {
      errors.push({ file: filePath, type: 'Event', field: 'offers.availability', message: 'Event offers missing "availability"' });
    }
    if (!sdIsNonEmpty(schema.offers.validFrom)) {
      errors.push({ file: filePath, type: 'Event', field: 'offers.validFrom', message: 'Event offers missing "validFrom"' });
    }
    if (!sdIsNonEmpty(schema.offers.url)) {
      errors.push({ file: filePath, type: 'Event', field: 'offers.url', message: 'Event offers missing "url"' });
    }
  }
  return errors;
}

function sdValidateWebApplication(schema, filePath) {
  const errors = [];
  const type = schema['@type'];
  const types = Array.isArray(type) ? type : [type];
  const isWebApp = types.includes('WebApplication') || types.includes('SoftwareApplication');
  if (!isWebApp) return errors;
  const rel = relative(DIST, filePath);
  const isHomepage = rel === 'index.html' || rel === 'en/index.html' || rel === 'de/index.html' || rel === 'fr/index.html';
  if (isHomepage) {
    const rating = schema.aggregateRating;
    if (!rating || typeof rating !== 'object') {
      errors.push({ file: filePath, type: 'WebApplication', field: 'aggregateRating', message: 'WebApplication/SoftwareApplication on homepage missing "aggregateRating"' });
    } else {
      if (!sdIsNonEmpty(rating.ratingValue)) {
        errors.push({ file: filePath, type: 'WebApplication', field: 'aggregateRating.ratingValue', message: 'aggregateRating missing "ratingValue"' });
      }
      if (!sdIsNonEmpty(rating.ratingCount)) {
        errors.push({ file: filePath, type: 'WebApplication', field: 'aggregateRating.ratingCount', message: 'aggregateRating missing "ratingCount"' });
      }
      if (!sdIsNonEmpty(rating.bestRating)) {
        errors.push({ file: filePath, type: 'WebApplication', field: 'aggregateRating.bestRating', message: 'aggregateRating missing "bestRating"' });
      }
      if (!sdIsNonEmpty(rating.worstRating)) {
        errors.push({ file: filePath, type: 'WebApplication', field: 'aggregateRating.worstRating', message: 'aggregateRating missing "worstRating"' });
      }
    }
  }
  return errors;
}

function sdWalkSchemaTree(node, visit) {
  if (Array.isArray(node)) {
    for (const item of node) sdWalkSchemaTree(item, visit);
    return;
  }
  if (node && typeof node === 'object') {
    visit(node);
    for (const v of Object.values(node)) {
      if (v && typeof v === 'object') sdWalkSchemaTree(v, visit);
    }
  }
}

function sdValidateWebApplicationRatingOrReview(schema, filePath) {
  const errors = [];
  sdWalkSchemaTree(schema, (obj) => {
    const types = Array.isArray(obj['@type']) ? obj['@type'] : [obj['@type']];
    if (!types.some((t) => SD_WEBAPP_TYPES.has(t))) return;
    const typeName = types.find((t) => SD_WEBAPP_TYPES.has(t)) ?? 'WebApplication';
    const rating = obj.aggregateRating;
    const ratingOk =
      rating &&
      typeof rating === 'object' &&
      sdIsNonEmpty(rating.ratingValue) &&
      (sdIsNonEmpty(rating.ratingCount) || sdIsNonEmpty(rating.reviewCount));
    const reviews = Array.isArray(obj.review)
      ? obj.review
      : (obj.review ? [obj.review] : []);
    const reviewOk = reviews.some((r) => {
      if (!r || typeof r !== 'object') return false;
      const rr = r.reviewRating;
      const author = r.author;
      const authorName = typeof author === 'string' ? author : author?.name;
      return (
        rr &&
        typeof rr === 'object' &&
        sdIsNonEmpty(rr.ratingValue) &&
        sdIsNonEmpty(authorName)
      );
    });
    if (!ratingOk && !reviewOk) {
      errors.push({
        file: filePath,
        type: typeName,
        field: 'aggregateRating|review',
        message: 'WebApplication/SoftwareApplication requires aggregateRating or review',
      });
    }
  });
  return errors;
}

function sdValidateLocalBusinessNoServiceType(schema, filePath) {
  const errors = [];
  sdWalkSchemaTree(schema, (obj) => {
    const types = Array.isArray(obj['@type']) ? obj['@type'] : [obj['@type']];
    const isLB = types.some((t) => typeof t === 'string' && t.includes('LocalBusiness'));
    if (!isLB) return;
    if (Object.prototype.hasOwnProperty.call(obj, 'serviceType')) {
      errors.push({
        file: filePath,
        type: 'LocalBusiness',
        field: 'serviceType',
        message: 'LocalBusiness must not carry "serviceType" (use makesOffer/hasOfferCatalog/knowsAbout)',
      });
    }
  });
  return errors;
}

function sdValidateInLanguageWhitelist(schema, filePath) {
  const errors = [];
  sdWalkSchemaTree(schema, (obj) => {
    if (!Object.prototype.hasOwnProperty.call(obj, 'inLanguage')) return;
    const types = Array.isArray(obj['@type']) ? obj['@type'] : [obj['@type']];
    const hasAllowed = types.some((t) => typeof t === 'string' && SD_INLANGUAGE_WHITELIST.has(t));
    if (hasAllowed) return;
    const typeName = (types.find((t) => typeof t === 'string') ?? 'unknown');
    errors.push({
      file: filePath,
      type: typeName,
      field: 'inLanguage',
      message: `inLanguage not allowed on @type "${typeName}" (CreativeWork descendants only)`,
    });
  });
  return errors;
}

function sdValidateFuelMerchantProduct(schema, filePath) {
  const errors = [];
  const types = Array.isArray(schema['@type']) ? schema['@type'] : [schema['@type']];
  if (!types.includes('Product')) return errors;
  const rel = relative(DIST, filePath);
  if (!/(^|\/)(prezzi-(diesel|benzina)|diesel-price-switzerland|gasoline-price-switzerland|dieselpreis-schweiz|benzinpreis-schweiz|prix-gasoil-suisse|prix-essence-suisse)\//.test(rel)) {
    return errors;
  }
  const hasImage = Array.isArray(schema.image)
    ? schema.image.some((img) => sdIsNonEmpty(img))
    : sdIsNonEmpty(schema.image);
  if (!hasImage) {
    errors.push({ file: filePath, type: 'Product', field: 'image', message: 'Fuel Product missing "image"' });
  }
  if (!sdIsNonEmpty(schema.description)) {
    errors.push({ file: filePath, type: 'Product', field: 'description', message: 'Fuel Product missing "description"' });
  }
  const brandName = typeof schema.brand === 'string' ? schema.brand : schema.brand?.name;
  const hasGlobalIdentifier =
    sdIsNonEmpty(brandName) ||
    sdIsNonEmpty(schema.gtin) ||
    sdIsNonEmpty(schema.gtin8) ||
    sdIsNonEmpty(schema.gtin12) ||
    sdIsNonEmpty(schema.gtin13) ||
    sdIsNonEmpty(schema.gtin14) ||
    sdIsNonEmpty(schema.isbn) ||
    sdIsNonEmpty(schema.mpn);
  if (!hasGlobalIdentifier) {
    errors.push({
      file: filePath,
      type: 'Product',
      field: 'brand_or_global_identifier',
      message: 'Fuel Product missing brand or global identifier (gtin/mpn/isbn)',
    });
  }
  const aggregateRating = schema.aggregateRating;
  if (!aggregateRating || typeof aggregateRating !== 'object') {
    errors.push({
      file: filePath,
      type: 'Product',
      field: 'aggregateRating',
      message: 'Fuel Product missing "aggregateRating"',
    });
  } else {
    if (!sdIsNonEmpty(aggregateRating.ratingValue)) {
      errors.push({
        file: filePath, type: 'Product', field: 'aggregateRating.ratingValue',
        message: 'Fuel Product aggregateRating missing "ratingValue"',
      });
    }
    if (!sdIsNonEmpty(aggregateRating.reviewCount) && !sdIsNonEmpty(aggregateRating.ratingCount)) {
      errors.push({
        file: filePath, type: 'Product', field: 'aggregateRating.reviewCount',
        message: 'Fuel Product aggregateRating missing "reviewCount" or "ratingCount"',
      });
    }
    if (!sdIsNonEmpty(aggregateRating.bestRating) || !sdIsNonEmpty(aggregateRating.worstRating)) {
      errors.push({
        file: filePath, type: 'Product', field: 'aggregateRating.scale',
        message: 'Fuel Product aggregateRating missing "bestRating" or "worstRating"',
      });
    }
  }
  const review = Array.isArray(schema.review) ? schema.review[0] : schema.review;
  if (!review || typeof review !== 'object') {
    errors.push({
      file: filePath, type: 'Product', field: 'review',
      message: 'Fuel Product missing "review"',
    });
  } else {
    if (!sdIsNonEmpty(review.reviewBody)) {
      errors.push({
        file: filePath, type: 'Product', field: 'review.reviewBody',
        message: 'Fuel Product review missing "reviewBody"',
      });
    }
    if (!sdIsNonEmpty(review.author?.name || review.author)) {
      errors.push({
        file: filePath, type: 'Product', field: 'review.author',
        message: 'Fuel Product review missing "author"',
      });
    }
    if (!sdIsNonEmpty(review.reviewRating?.ratingValue)) {
      errors.push({
        file: filePath, type: 'Product', field: 'review.reviewRating.ratingValue',
        message: 'Fuel Product review missing "reviewRating.ratingValue"',
      });
    }
  }
  const offer = schema.offers;
  if (!offer || typeof offer !== 'object') return errors;
  const returnPolicy = offer.hasMerchantReturnPolicy;
  if (!returnPolicy || typeof returnPolicy !== 'object') {
    errors.push({
      file: filePath, type: 'Offer', field: 'hasMerchantReturnPolicy',
      message: 'Fuel Offer missing "hasMerchantReturnPolicy"',
    });
  } else {
    if (!sdIsNonEmpty(returnPolicy.applicableCountry)) {
      errors.push({
        file: filePath, type: 'Offer', field: 'hasMerchantReturnPolicy.applicableCountry',
        message: 'Fuel Offer return policy missing "applicableCountry"',
      });
    }
    if (!sdIsNonEmpty(returnPolicy.returnPolicyCategory)) {
      errors.push({
        file: filePath, type: 'Offer', field: 'hasMerchantReturnPolicy.returnPolicyCategory',
        message: 'Fuel Offer return policy missing "returnPolicyCategory"',
      });
    }
  }
  const shipping = offer.shippingDetails;
  if (!shipping || typeof shipping !== 'object') {
    errors.push({
      file: filePath, type: 'Offer', field: 'shippingDetails',
      message: 'Fuel Offer missing "shippingDetails"',
    });
  } else {
    if (!sdIsNonEmpty(shipping.shippingDestination?.addressCountry)) {
      errors.push({
        file: filePath, type: 'Offer', field: 'shippingDetails.shippingDestination.addressCountry',
        message: 'Fuel Offer shippingDetails missing "shippingDestination.addressCountry"',
      });
    }
    if (!sdIsNonEmpty(shipping.shippingRate?.currency)) {
      errors.push({
        file: filePath, type: 'Offer', field: 'shippingDetails.shippingRate.currency',
        message: 'Fuel Offer shippingDetails missing "shippingRate.currency"',
      });
    }
    if (!sdIsNonEmpty(shipping.shippingRate?.value) && !sdIsNonEmpty(shipping.shippingRate?.maxValue)) {
      errors.push({
        file: filePath, type: 'Offer', field: 'shippingDetails.shippingRate.value',
        message: 'Fuel Offer shippingDetails missing shipping rate value/maxValue',
      });
    }
    const handling = shipping.deliveryTime?.handlingTime;
    const transit = shipping.deliveryTime?.transitTime;
    if (!handling || !transit) {
      errors.push({
        file: filePath, type: 'Offer', field: 'shippingDetails.deliveryTime',
        message: 'Fuel Offer shippingDetails missing "deliveryTime.handlingTime" or "deliveryTime.transitTime"',
      });
    } else {
      for (const [label, value] of [['handlingTime', handling], ['transitTime', transit]]) {
        if (!sdIsNonEmpty(value.minValue) || !sdIsNonEmpty(value.maxValue) || !sdIsNonEmpty(value.unitCode)) {
          errors.push({
            file: filePath, type: 'Offer', field: `shippingDetails.deliveryTime.${label}`,
            message: `Fuel Offer ${label} missing minValue/maxValue/unitCode`,
          });
        }
      }
    }
  }
  return errors;
}

class StructuredDataAudit {
  constructor(sampledSet, byCategoryCounts) {
    this.sampledSet = sampledSet;
    this.byCategoryCounts = byCategoryCounts;
    this.totalSchemas = 0;
    this.datasetCount = 0;
    this.jobPostingCount = 0;
    this.eventCount = 0;
    this.allErrors = [];
  }
  /**
   * Mirrors per-file body of validate-structured-data-completeness.main batch.
   * Only runs on files in the sampled set (matches original sampling logic).
   */
  ingest(file, html, sharedBlocks) {
    if (!this.sampledSet.has(file)) return;
    const blocks = sharedBlocks ?? extractJsonLdBlocks(html);
    const schemas = flattenSdSchemas(blocks);
    const errors = [];
    const isBridge = html.includes('__BRIDGE_TARGET_SLUG__');

    const topLevelTypeCounts = {};
    for (const block of blocks) {
      const t = block?.['@type'];
      if (t && typeof t === 'string') topLevelTypeCounts[t] = (topLevelTypeCounts[t] || 0) + 1;
    }
    for (const ut of SD_UNIQUE_TYPES) {
      if ((topLevelTypeCounts[ut] || 0) > 1) {
        errors.push({ file, type: ut, field: 'duplicate', message: `Duplicate ${ut} schema (${topLevelTypeCounts[ut]} found, max 1)` });
      }
    }

    for (const schema of schemas) {
      if (!schema || typeof schema !== 'object' || !schema['@type']) continue;
      this.totalSchemas++;
      if (schema['@type'] === 'Dataset') {
        this.datasetCount++;
        errors.push(...sdValidateDataset(schema, file));
      }
      if (schema['@type'] === 'JobPosting') {
        this.jobPostingCount++;
        if (!isBridge) errors.push(...sdValidateJobPosting(schema, file));
      }
      if (schema['@type'] === 'Event') {
        this.eventCount++;
        errors.push(...sdValidateEvent(schema, file));
      }
      const schemaTypes = Array.isArray(schema['@type']) ? schema['@type'] : [schema['@type']];
      if (schemaTypes.includes('WebApplication') || schemaTypes.includes('SoftwareApplication')) {
        errors.push(...sdValidateWebApplication(schema, file));
      }
      if (schemaTypes.includes('Product')) {
        errors.push(...sdValidateFuelMerchantProduct(schema, file));
      }
    }
    for (const schema of schemas) {
      if (!schema || typeof schema !== 'object' || !schema['@type']) continue;
      errors.push(...sdValidateWebApplicationRatingOrReview(schema, file));
      errors.push(...sdValidateLocalBusinessNoServiceType(schema, file));
      errors.push(...sdValidateInLanguageWhitelist(schema, file));
    }
    this.allErrors.push(...errors);
  }
}

/**
 * Build the structured-data sampled set, mirroring exactly the logic in
 * validate-structured-data-completeness.main:
 *   - All statistics, fuel, blog files
 *   - All homepage files (index.html for it/en/de/fr)
 *   - All Event-bearing pages (festivita-ticino + locale variants)
 *   - Proportional sample (10%, min 50) of job/blog/company/other categories
 *     using deterministic evenly-spaced step sampling.
 */
function buildSampledSet(allFiles) {
  /** @type {Record<'fuel'|'job'|'statistics'|'blog'|'company'|'other', string[]>} */
  const byCategory = { fuel: [], job: [], statistics: [], blog: [], company: [], other: [] };
  for (const f of allFiles) {
    const cat = sdClassifyPage(f);
    (byCategory[cat] || byCategory.other).push(f);
  }
  const sampled = new Set();
  for (const f of byCategory.statistics) sampled.add(f);
  for (const f of byCategory.fuel) sampled.add(f);
  for (const f of byCategory.blog) sampled.add(f);
  const homepageFiles = ['index.html', 'en/index.html', 'de/index.html', 'fr/index.html'];
  for (const hp of homepageFiles) {
    const full = join(DIST, hp);
    if (existsSync(full)) sampled.add(full);
  }
  const eventPages = [
    'tasse-e-pensione/festivita-ticino/index.html',
    'en/taxes-and-pension/ticino-public-holidays/index.html',
    'de/steuern-und-vorsorge/tessin-feiertage/index.html',
    'fr/impots-et-retraite/jours-feries-tessin/index.html',
  ];
  for (const ep of eventPages) {
    const full = join(DIST, ep);
    if (existsSync(full)) sampled.add(full);
  }
  for (const cat of /** @type {const} */ (['job', 'blog', 'company', 'other'])) {
    const files = byCategory[cat];
    const sampleSize = Math.max(SD_MIN_SAMPLE, Math.ceil(files.length * SD_SAMPLE_FRACTION));
    const step = Math.max(1, Math.floor(files.length / sampleSize));
    let added = 0;
    for (let i = 0; i < files.length && added < sampleSize; i += step) {
      sampled.add(files[i]);
      added++;
    }
  }
  return { sampled, byCategory };
}

class DupAudit {
  constructor() {
    this.seenUrlKeys = new Set();
    this.pages = []; // { relPath (dist-relative), locale, hash, wordCount }
  }
  /** Mirrors the per-file body of audit-content-duplicates.audit loop. */
  ingest(file, html, distRel) {
    const urlKey = canonicalizeDistPath(distRel);
    if (this.seenUrlKeys.has(urlKey)) return;
    this.seenUrlKeys.add(urlKey);

    if (hasNoindexDup(html)) return;
    const bodyText = extractBodyText(html);
    if (!bodyText) return;
    const wordCount = bodyText.split(/\s+/).length;
    if (wordCount < 40) return;
    const canonical = extractCanonical(html);
    if (canonical) {
      const canonicalPath = canonical.replace(/^https?:\/\/[^/]+/, '').replace(/#.*$/, '').replace(/\?.*$/, '');
      const normalizedCanonical = canonicalPath.replace(/\/$/, '') || '/';
      const normalizedSelf = urlKey.replace(/\/$/, '') || '/';
      if (normalizedCanonical !== normalizedSelf) return;
    }
    const locale = inferDupLocale(distRel);
    this.pages.push({ relPath: distRel, locale, hash: sha256(bodyText), wordCount });
  }
}

// ───── reporters (preserve original output formats) ──────────────────────────

async function runRatio(audit) {
  const offenders = audit.report.filter(r => r.ratio <= RATIO_THRESHOLD).sort((a, b) => a.ratio - b.ratio);

  console.log(`\n──── audit:text-html-ratio ────`);
  console.log(`audit-text-html-ratio: scanned ${audit.report.length} HTML files in dist/ (skipped ${audit.skippedNoindex} noindex/redirect pages)`);
  console.log(`Threshold (Semrush "low text/HTML"): ratio ≤ ${RATIO_THRESHOLD} %`);
  console.log(`Offenders: ${offenders.length} (${((offenders.length / Math.max(audit.report.length, 1)) * 100).toFixed(1)} % of scanned)`);

  /** @type {Map<string, {count:number, sumRatio:number}>} */
  const byFeature = new Map();
  for (const r of offenders) {
    const cur = byFeature.get(r.feature) ?? { count: 0, sumRatio: 0 };
    cur.count++;
    cur.sumRatio += r.ratio;
    byFeature.set(r.feature, cur);
  }
  if (byFeature.size > 0) {
    console.log('\nOffenders by feature:');
    const rows = [...byFeature.entries()].sort((a, b) => b[1].count - a[1].count);
    for (const [feature, { count, sumRatio }] of rows) {
      console.log(`  ${String(count).padStart(6)}  ${(sumRatio / count).toFixed(2).padStart(5)} %  ${feature}`);
    }
  }
  if (offenders.length > 0) {
    console.log(`\nWorst ${Math.min(RATIO_LIMIT, offenders.length)} offenders:`);
    for (const r of offenders.slice(0, RATIO_LIMIT)) {
      console.log(`  ${r.ratio.toFixed(2).padStart(5)} %  ${(r.htmlBytes / 1024).toFixed(1).padStart(6)} KB  ${r.file}`);
    }
  }

  /** @type {Record<string, number>} */
  const byFeatureCount = {};
  for (const r of offenders) {
    byFeatureCount[r.feature] = (byFeatureCount[r.feature] ?? 0) + 1;
  }

  let baseline;
  try {
    baseline = JSON.parse(await readFile(RATIO_BASELINE_PATH, 'utf8'));
  } catch (err) {
    console.error(`\nFAIL: baseline file ${relative(ROOT, RATIO_BASELINE_PATH)} could not be read: ${err.message}`);
    return { passed: false, fatal: true };
  }

  const baseTotal = Number(baseline.total ?? 0);
  /** @type {Record<string, number>} */
  const baseByFeature = baseline.byFeature ?? {};
  const featureRegressions = [];
  for (const [feature, count] of Object.entries(byFeatureCount)) {
    const max = baseByFeature[feature] ?? 0;
    if (count > max) featureRegressions.push({ feature, count, max });
  }
  const totalRegression = offenders.length > baseTotal;
  if (totalRegression || featureRegressions.length > 0) {
    console.error('\n══════════════════════════════════════════════════════════════════════');
    console.error('FAIL: Semrush "low text-to-HTML ratio" gate REGRESSED');
    console.error('══════════════════════════════════════════════════════════════════════');
    console.error('');
    console.error('Why this gate exists');
    console.error('--------------------');
    console.error(`Semrush flags any page with text/HTML ratio ≤ ${RATIO_THRESHOLD} % as`);
    console.error('"low text/HTML". Pages that hit this threshold rank worse because');
    console.error('search engines see lots of code wrapping very little content. The');
    console.error('Apr 2026 audit caught 1,193 such pages on frontaliereticino.ch.');
    console.error('');
    console.error('What just happened');
    console.error('------------------');
    if (totalRegression) {
      console.error(`  Total offenders: ${offenders.length} (baseline allows ${baseTotal})`);
    }
    for (const f of featureRegressions) {
      console.error(`  Feature "${f.feature}": ${f.count} offenders (baseline allows ${f.max})`);
    }
    console.error('');
    console.error('How to fix');
    console.error('----------');
    console.error('1. Run locally to see the actual offending pages:');
    console.error('     node scripts/audit-text-html-ratio.mjs --limit=50');
    console.error('     node scripts/audit-text-html-ratio.mjs --feature=<name>');
    console.error('');
    console.error('2. For each offending TEMPLATE, add COHERENT page-relevant content —');
    console.error('   not filler. Good extensions: methodology paragraph, FAQ block,');
    console.error('   contextual prose tying the page to the frontaliere use case,');
    console.error('   cross-references to related comparators. NEVER add hidden text');
    console.error('   or boilerplate that repeats across pages — Google penalises that.');
    console.error('');
    console.error('3. The build plugins to inspect (one per feature bucket):');
    console.error('     fuel-daily          → build-plugins/fuelDailyPagesPlugin.ts');
    console.error('     weekly-employers*   → build-plugins/weeklyEmployersPlugin.ts');
    console.error('     health-premiums     → build-plugins/healthPremiumsLandingPlugin.ts');
    console.error('     job-board           → build-plugins/jobsSeoPagesPlugin.ts');
    console.error('     blog                → scripts/create-article.mjs (article generator)');
    console.error('     spa-locale / -other → htmlTemplate.ts + the SPA prerender shell');
    console.error('');
    console.error('4. After lowering the count, regenerate the baseline:');
    console.error('     npm run build && \\');
    console.error('       node scripts/audit-text-html-ratio.mjs \\');
    console.error('         --write-baseline=data/text-html-ratio-baseline.json');
    console.error('   Commit the new baseline JSON together with the template change.');
    console.error('');
    console.error('5. The baseline number must only ever DECREASE. Raising it means new');
    console.error('   pages have dropped below the threshold — fix that, do not ratchet up.');
    console.error('');
    console.error('See CLAUDE.md > "SEO content gate" for the full playbook.');
    return { passed: false };
  }
  const totalDelta = baseTotal - offenders.length;
  console.log(`\nratchet OK: ${offenders.length} offenders ≤ baseline ${baseTotal} (${totalDelta >= 0 ? '−' : '+'}${Math.abs(totalDelta)})`);
  return { passed: true };
}

async function runTitle(audit) {
  const offenders = audit.offenders.slice().sort((a, b) => b.length - a.length);
  /** @type {Record<string, number>} */
  const byFeatureCount = {};
  /** @type {Record<string, number>} */
  const byLocaleCount = {};
  for (const r of offenders) {
    byFeatureCount[r.feature] = (byFeatureCount[r.feature] ?? 0) + 1;
    byLocaleCount[r.locale] = (byLocaleCount[r.locale] ?? 0) + 1;
  }

  console.log(`\n──── audit:title-length ────`);
  console.log(`audit-title-length: scanned ${audit.scanned} HTML files in dist/ (skipped ${audit.skippedNoindex} noindex/redirect, ${audit.missingTitle} missing <title>)`);
  console.log(`Threshold: ${TITLE_THRESHOLD} chars`);
  console.log(`Offenders (length > ${TITLE_THRESHOLD}): ${offenders.length} (${((offenders.length / Math.max(audit.scanned, 1)) * 100).toFixed(1)} % of scanned)`);

  if (Object.keys(byFeatureCount).length > 0) {
    console.log('\nOffenders by feature:');
    for (const [f, c] of Object.entries(byFeatureCount).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(c).padStart(6)}  ${f}`);
    }
  }
  if (Object.keys(byLocaleCount).length > 0) {
    console.log('\nOffenders by locale:');
    for (const [l, c] of Object.entries(byLocaleCount).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(c).padStart(6)}  ${l}`);
    }
  }
  if (offenders.length > 0) {
    console.log(`\nWorst ${Math.min(TITLE_LIMIT, offenders.length)} offenders:`);
    for (const r of offenders.slice(0, TITLE_LIMIT)) {
      console.log(`  ${String(r.length).padStart(4)} ch  [${r.locale}] ${r.feature.padEnd(22)}  ${r.file}`);
      console.log(`        ${JSON.stringify(r.title.slice(0, 120))}`);
    }
  }

  let baseline;
  try {
    baseline = JSON.parse(await readFile(TITLE_BASELINE_PATH, 'utf8'));
  } catch (err) {
    console.error(`audit-title-length: cannot read baseline ${TITLE_BASELINE_PATH}: ${err.message}`);
    return { passed: false, fatal: true };
  }
  let regression = false;
  if (typeof baseline.total === 'number' && offenders.length > baseline.total) {
    console.error(`\nREGRESSION: total offenders ${offenders.length} > baseline ${baseline.total}`);
    regression = true;
  }
  if (baseline.byFeature && typeof baseline.byFeature === 'object') {
    for (const [feat, count] of Object.entries(byFeatureCount)) {
      const cap = baseline.byFeature[feat] ?? 0;
      if (count > cap) {
        console.error(`REGRESSION: feature "${feat}" offenders ${count} > baseline ${cap}`);
        regression = true;
      }
    }
  }
  if (regression) {
    console.error('\nThe title-length baseline ratchet only allows the count to go DOWN.');
    console.error('Shorten the offending titleBases, then regenerate with --write-baseline=<path>.');
    return { passed: false };
  }
  console.log('\nBaseline ratchet: OK (no regressions vs ' + relative(ROOT, TITLE_BASELINE_PATH) + ')');
  return { passed: true };
}

async function runH1(audit) {
  const offenders = audit.offenders;
  /** @type {Record<string, number>} */
  const byFeatureCount = {};
  /** @type {Record<string, number>} */
  const byLocaleCount = {};
  for (const r of offenders) {
    byFeatureCount[r.feature] = (byFeatureCount[r.feature] ?? 0) + 1;
    byLocaleCount[r.locale] = (byLocaleCount[r.locale] ?? 0) + 1;
  }

  console.log(`\n──── audit:h1-title-duplicates ────`);
  console.log(`audit-h1-title-duplicates: scanned ${audit.scanned} HTML files in dist/ (skipped ${audit.skippedNoindex} noindex/redirect, ${audit.missingTitle} missing <title>, ${audit.missingH1} missing <h1>)`);
  console.log(`Offenders (title === h1, case+whitespace-insensitive): ${offenders.length} (${((offenders.length / Math.max(audit.scanned, 1)) * 100).toFixed(1)} % of scanned)`);

  if (Object.keys(byFeatureCount).length > 0) {
    console.log('\nOffenders by feature:');
    for (const [f, c] of Object.entries(byFeatureCount).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(c).padStart(6)}  ${f}`);
    }
  }
  if (Object.keys(byLocaleCount).length > 0) {
    console.log('\nOffenders by locale:');
    for (const [l, c] of Object.entries(byLocaleCount).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(c).padStart(6)}  ${l}`);
    }
  }
  if (offenders.length > 0) {
    console.log(`\nFirst ${Math.min(H1_LIMIT, offenders.length)} offenders:`);
    for (const r of offenders.slice(0, H1_LIMIT)) {
      console.log(`  [${r.locale}] ${r.feature.padEnd(22)}  ${r.file}`);
      console.log(`        title=h1=${JSON.stringify(r.title.slice(0, 120))}`);
    }
  }

  let baseline;
  try {
    baseline = JSON.parse(await readFile(H1_BASELINE_PATH, 'utf8'));
  } catch (err) {
    console.error(`audit-h1-title-duplicates: cannot read baseline ${H1_BASELINE_PATH}: ${err.message}`);
    return { passed: false, fatal: true };
  }
  let regression = false;
  if (typeof baseline.total === 'number' && offenders.length > baseline.total) {
    console.error(`\nREGRESSION: total offenders ${offenders.length} > baseline ${baseline.total}`);
    regression = true;
  }
  if (baseline.byFeature && typeof baseline.byFeature === 'object') {
    for (const [feat, count] of Object.entries(byFeatureCount)) {
      const cap = baseline.byFeature[feat] ?? 0;
      if (count > cap) {
        console.error(`REGRESSION: feature "${feat}" offenders ${count} > baseline ${cap}`);
        regression = true;
      }
    }
  }
  if (regression) {
    console.error('\nThe duplicate-h1 baseline ratchet only allows the count to go DOWN.');
    console.error('Fix the new offenders, then regenerate with --write-baseline=<path>.');
    return { passed: false };
  }
  console.log('\nBaseline ratchet: OK (no regressions vs ' + relative(ROOT, H1_BASELINE_PATH) + ')');
  return { passed: true };
}

function runDup(audit) {
  /** @type {Map<string, Map<string, string[]>>} */
  const byLocale = new Map();
  for (const p of audit.pages) {
    if (!byLocale.has(p.locale)) byLocale.set(p.locale, new Map());
    const localeMap = /** @type {Map<string, string[]>} */ (byLocale.get(p.locale));
    if (!localeMap.has(p.hash)) localeMap.set(p.hash, []);
    /** @type {string[]} */ (localeMap.get(p.hash)).push(p.relPath);
  }

  /** @type {Record<string, number>} */
  const totals = {};
  /** @type {Array<{ locale: string; hash: string; paths: string[] }>} */
  const duplicates = [];
  for (const [locale, localeMap] of byLocale.entries()) {
    let dupClusters = 0;
    for (const [hash, paths] of localeMap.entries()) {
      if (paths.length < 2) continue;
      dupClusters++;
      duplicates.push({ locale, hash, paths });
    }
    totals[locale] = dupClusters;
  }
  duplicates.sort((a, b) => b.paths.length - a.paths.length);
  const breached = Object.values(totals).some((n) => n > DUP_CLUSTER_THRESHOLD);

  console.log(`\n──── audit:content-duplicates ────`);
  console.log('[audit-content-duplicates] Duplicate clusters per locale:');
  const localeKeys = Object.keys(totals).sort();
  if (localeKeys.length === 0) {
    console.log('  (no locales detected)');
  } else {
    for (const loc of localeKeys) {
      console.log(`  ${loc}: ${totals[loc]} duplicate cluster(s)`);
    }
  }

  if (duplicates.length === 0) {
    console.log('[audit-content-duplicates] OK — no duplicate bodies detected.');
  } else {
    const reported = duplicates.slice(0, DUP_MAX_REPORTED);
    console.log(`\n[audit-content-duplicates] Top ${reported.length} duplicate cluster(s):`);
    for (const cluster of reported) {
      console.log(`  [${cluster.locale}] hash=${cluster.hash.slice(0, 12)}… pages=${cluster.paths.length}`);
      for (const p of cluster.paths.slice(0, 6)) {
        console.log(`    - ${p}`);
      }
      if (cluster.paths.length > 6) {
        console.log(`    … and ${cluster.paths.length - 6} more`);
      }
    }
  }

  if (breached) {
    console.error(`\n[audit-content-duplicates] FAIL — at least one locale exceeded the ${DUP_CLUSTER_THRESHOLD}-cluster threshold.`);
    return { passed: false };
  }
  return { passed: true };
}

// ───── reporters for the 5 newly-consolidated audits ────────────────────────

function runPageWeight(audit) {
  console.log(`\n──── audit:page-weight ────`);
  const topTen = [...audit.report].sort((a, b) => b.bytes - a.bytes).slice(0, 10);
  console.log(`audit-page-weight: scanned ${audit.report.length} HTML files in dist/`);
  console.log(`Top 10 heaviest pages:`);
  for (const r of topTen) {
    console.log(`  ${(r.bytes / 1024).toFixed(1).padStart(7)} KB  ${r.file}  (inlineJs=${r.inlineJs}B, inlineCss=${r.inlineCss}B)`);
  }

  const hasOffenders = audit.oversized.length > 0 || audit.imgMissingAttrs.length > 0;
  if (hasOffenders) {
    if (audit.oversized.length > 0) {
      console.error(`\nFAIL: ${audit.oversized.length} page(s) exceed ${MAX_HTML_BYTES / 1024} KB HTML budget:`);
      const show = audit.oversized.slice(0, 5);
      for (const o of show) console.error(`  - ${o}`);
      if (audit.oversized.length > 5) {
        console.error(`  ... and ${audit.oversized.length - 5} more (rerun with --summary)`);
      }
    }
    if (audit.imgMissingAttrs.length > 0) {
      console.error(`\nFAIL: ${audit.imgMissingAttrs.length} page(s) have <img> tags missing width/height/loading:`);
      const show = audit.imgMissingAttrs.slice(0, 5);
      for (const o of show) {
        console.error(`  - ${o.file} (${o.issues.length} tag(s))`);
        for (const i of o.issues.slice(0, 2)) {
          console.error(`      missing=[${i.missing.join(',')}]  ${i.tag}`);
        }
      }
    }
    return { passed: false };
  }
  console.log(`\nOK: all ${audit.report.length} pages within budget and <img> attrs present.`);
  return { passed: true };
}

function runHreflang(audit) {
  console.log(`\n──── audit:hreflang ────`);
  const totalFailures =
    audit.failures.tooFew.length +
    audit.failures.invalidPair.length +
    audit.failures.xDefaultMismatch.length +
    audit.failures.missingTarget.length;

  if (totalFailures === 0) {
    console.log(
      `audit-hreflang: OK — scanned ${audit.scanned} HTML files (${audit.withHreflang} with hreflang), no issues.`,
    );
    return { passed: true };
  }
  console.error(
    `audit-hreflang: FAILED — ${totalFailures} issue(s) across ${audit.withHreflang} pages with hreflang`,
  );
  for (const [kind, list] of Object.entries(audit.failures)) {
    if (list.length === 0) continue;
    console.error(`\n[${kind}] ${list.length} issue(s):`);
    for (const msg of list.slice(0, HREFLANG_MAX)) {
      console.error(`  - ${msg}`);
    }
    if (list.length > HREFLANG_MAX) {
      console.error(`  ... and ${list.length - HREFLANG_MAX} more`);
    }
  }
  return { passed: false };
}

function runTitleUniqueness(audit) {
  console.log(`\n──── audit:title-uniqueness ────`);

  /** @type {Map<string, Array<{title: string, canonicalPaths: Array<{canonical: string, relPaths: string[]}>}>>} */
  const collisionsByLocale = new Map();
  for (const [locale, bucket] of audit.titlesByLocale.entries()) {
    const dups = [];
    for (const [title, byCanonical] of bucket.entries()) {
      if (byCanonical.size > 1) {
        const canonicalPaths = Array.from(byCanonical.entries()).map(([canonical, relPaths]) => ({
          canonical,
          relPaths,
        }));
        dups.push({ title, canonicalPaths });
      }
    }
    if (dups.length > 0) collisionsByLocale.set(locale, dups);
  }

  const summary = Array.from(audit.titlesByLocale.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([locale, bucket]) => {
      const duplicates = collisionsByLocale.get(locale) ?? [];
      const dupPages = duplicates.reduce((acc, d) => acc + d.canonicalPaths.length, 0);
      const totalCanonicalPages = Array.from(bucket.values()).reduce((a, byCanonical) => a + byCanonical.size, 0);
      return `  ${locale}: ${bucket.size} unique titles across ${totalCanonicalPages} canonical pages (${duplicates.length} duplicate titles, ${dupPages} affected canonical pages)`;
    })
    .join('\n');

  process.stdout.write(
    `[audit:title-uniqueness] Scanned ${audit.totalPages} HTML pages in ${DIST}\n` +
    (audit.missingTitles > 0 ? `[audit:title-uniqueness] WARNING: ${audit.missingTitles} pages had no <title>\n` : '') +
    `${summary}\n`,
  );

  if (collisionsByLocale.size === 0 && audit.missingTitles === 0) {
    process.stdout.write('[audit:title-uniqueness] PASS — every locale has unique titles.\n');
    return { passed: true };
  }

  const reported = [];
  for (const [locale, dups] of collisionsByLocale.entries()) {
    for (const { title, canonicalPaths } of dups) {
      reported.push({ locale, title, canonicalPaths });
      if (reported.length >= TITLE_UNIQ_MAX_COLLISIONS_REPORTED) break;
    }
    if (reported.length >= TITLE_UNIQ_MAX_COLLISIONS_REPORTED) break;
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
  return { passed: false };
}

function runJobPosting(audit) {
  console.log(`\n──── validate:jobposting-schema ────`);
  console.log(
    `[validate-jobposting-schema] Scanned ${audit.totalFiles} HTML files — ` +
    `${audit.pagesWithJobPosting} pages carry ${audit.schemaCount} JobPosting schemas.`,
  );
  if (audit.failures.length === 0) {
    console.log('[validate-jobposting-schema] OK — every JobPosting has all 9 mandatory fields.');
    return { passed: true };
  }
  console.error(`[validate-jobposting-schema] FAIL — ${audit.failures.length} schemas have missing/invalid mandatory fields:`);
  for (const f of audit.failures.slice(0, JOBPOSTING_MAX_ERRORS)) {
    console.error(`\n  ${f.file}`);
    for (const e of f.errors) console.error(`    · ${e}`);
  }
  if (audit.failures.length > JOBPOSTING_MAX_ERRORS) {
    console.error(`\n  … and ${audit.failures.length - JOBPOSTING_MAX_ERRORS} more.`);
  }
  return { passed: false };
}

function runStructuredData(audit, totalFilesFound) {
  console.log(`\n──── validate:structured-data-completeness ────`);
  console.log('[structured-data-completeness] Scanning dist/ for HTML files...');
  console.log(`[structured-data-completeness] Found ${totalFilesFound} HTML files`);
  const c = audit.byCategoryCounts;
  console.log(`[structured-data-completeness] Sampling ${audit.sampledSet.size} pages (fuel: ${c.fuel.length}, statistics: ${c.statistics.length}, jobs: ${c.job.length}, blog: ${c.blog.length}, company: ${c.company.length}, other: ${c.other.length})`);

  const seen = new Set();
  const uniqueErrors = [];
  for (const e of audit.allErrors) {
    const key = `${e.file}|${e.field}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueErrors.push(e);
  }

  console.log(`[structured-data-completeness] Checked ${audit.totalSchemas} schemas (${audit.datasetCount} Dataset, ${audit.jobPostingCount} JobPosting, ${audit.eventCount} Event)`);

  if (uniqueErrors.length > 0) {
    const byField = {};
    for (const e of uniqueErrors) {
      const key = `${e.type}:${e.field}`;
      byField[key] = (byField[key] || 0) + 1;
    }
    console.error(`\n[structured-data-completeness] ${uniqueErrors.length} structured data errors found:\n`);
    console.error('Summary by field:');
    for (const [field, count] of Object.entries(byField).sort((a, b) => b[1] - a[1])) {
      console.error(`  ${field}: ${count} pages`);
    }
    console.error('\nDetails (first ' + SD_MAX_ERRORS_TO_PRINT + '):');
    for (const e of uniqueErrors.slice(0, SD_MAX_ERRORS_TO_PRINT)) {
      const rel = relative(DIST, e.file);
      console.error(`  ${rel} — ${e.message}`);
    }
    if (uniqueErrors.length > SD_MAX_ERRORS_TO_PRINT) {
      console.error(`  ... and ${uniqueErrors.length - SD_MAX_ERRORS_TO_PRINT} more`);
    }
    return { passed: false };
  }
  console.log(`[structured-data-completeness] All ${audit.totalSchemas} schemas valid (${audit.datasetCount} Dataset, ${audit.jobPostingCount} JobPosting, ${audit.eventCount} Event across ${audit.sampledSet.size} pages)`);
  return { passed: true };
}

// ───── pipeline driver ──────────────────────────────────────────────────────

async function main() {
  const startedAt = Date.now();

  const stats = await stat(DIST).catch(() => null);
  if (!stats || !stats.isDirectory()) {
    console.error(`audit-dist-multi: dist/ not found at ${DIST}. Run a build first.`);
    process.exit(2);
  }

  const files = await walk(DIST);
  console.log(`audit-dist-multi: starting pipeline over ${files.length} HTML files in dist/`);

  // Build the dist file index once for hreflang target-existence check
  // (audit-hreflang.main calls existsSync on every alternate target — using
  // a Set lookup over the already-collected file list avoids per-target stat).
  const distFileSet = new Set(files);

  // Build the structured-data sampled set up-front (mirrors original sampling).
  const { sampled: sdSampled, byCategory: sdByCategory } = buildSampledSet(files);

  const ratio = new RatioAudit();
  const titleA = new TitleAudit();
  const h1A = new H1Audit();
  const dupA = new DupAudit();
  const pageWeightA = new PageWeightAudit();
  const hreflangA = new HreflangAudit(distFileSet);
  const titleUniqA = new TitleUniqAudit();
  const jobPostingA = new JobPostingAudit();
  const sdA = new StructuredDataAudit(sdSampled, sdByCategory);

  for (const file of files) {
    let html;
    try {
      html = await readFile(file, 'utf8');
    } catch (err) {
      // Tolerate races (matches behaviour of the originals): autonomous
      // build/translation pipelines may delete pages between walk() and
      // readFile(). Skip and move on.
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') continue;
      throw err;
    }
    const htmlBytes = Buffer.byteLength(html, 'utf8');
    const relFromRoot = relative(ROOT, file);
    const distRel = relative(DIST, file);
    const relFromCwd = relative(process.cwd(), file);

    ratio.ingest(file, html, htmlBytes, relFromRoot);
    titleA.ingest(file, html, relFromRoot);
    h1A.ingest(file, html, relFromRoot);
    dupA.ingest(file, html, distRel);
    pageWeightA.ingest(file, html, htmlBytes, relFromRoot);
    hreflangA.ingest(file, html, distRel);
    titleUniqA.ingest(file, html, distRel);

    // JSON-LD is parsed at most once per file and shared between the two
    // schema validators. Both originals scan every HTML file's <script
    // type="application/ld+json"> blocks; jobposting uses an early-exit
    // `html.includes('"JobPosting"')` filter (we replicate that internally),
    // and structured-data only runs on the sampled subset.
    let sharedJsonLdBlocks = null;
    const willCheckJobPosting = html.includes('"JobPosting"') || html.includes("'JobPosting'");
    const willCheckSd = sdSampled.has(file);
    if (willCheckJobPosting || willCheckSd) {
      sharedJsonLdBlocks = extractJsonLdBlocks(html);
    }
    jobPostingA.ingest(file, html, relFromCwd, sharedJsonLdBlocks);
    sdA.ingest(file, html, sharedJsonLdBlocks);
  }

  const ratioRes = await runRatio(ratio);
  const titleRes = await runTitle(titleA);
  const h1Res = await runH1(h1A);
  const dupRes = runDup(dupA);
  const pageWeightRes = runPageWeight(pageWeightA);
  const hreflangRes = runHreflang(hreflangA);
  const titleUniqRes = runTitleUniqueness(titleUniqA);
  const jobPostingRes = runJobPosting(jobPostingA);
  const sdRes = runStructuredData(sdA, files.length);

  const wallSec = ((Date.now() - startedAt) / 1000).toFixed(2);
  console.log(`\n──── audit-dist-multi summary ────`);
  console.log(`scanned: ${files.length} HTML files`);
  console.log(`wall: ${wallSec}s`);
  console.log(`text-html-ratio:                ${ratioRes.passed ? 'PASS' : 'FAIL'}`);
  console.log(`title-length:                   ${titleRes.passed ? 'PASS' : 'FAIL'}`);
  console.log(`h1-title-duplicates:            ${h1Res.passed ? 'PASS' : 'FAIL'}`);
  console.log(`content-duplicates:             ${dupRes.passed ? 'PASS' : 'FAIL'}`);
  console.log(`page-weight:                    ${pageWeightRes.passed ? 'PASS' : 'FAIL'}`);
  console.log(`hreflang:                       ${hreflangRes.passed ? 'PASS' : 'FAIL'}`);
  console.log(`title-uniqueness:               ${titleUniqRes.passed ? 'PASS' : 'FAIL'}`);
  console.log(`jobposting-schema:              ${jobPostingRes.passed ? 'PASS' : 'FAIL'}`);
  console.log(`structured-data-completeness:   ${sdRes.passed ? 'PASS' : 'FAIL'}`);

  const allPassed =
    ratioRes.passed && titleRes.passed && h1Res.passed && dupRes.passed &&
    pageWeightRes.passed && hreflangRes.passed && titleUniqRes.passed &&
    jobPostingRes.passed && sdRes.passed;
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error('audit-dist-multi crashed:', err);
  process.exit(2);
});
