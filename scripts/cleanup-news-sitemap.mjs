#!/usr/bin/env node
/**
 * News Sitemap Whitelist Cleanup (Google News C1).
 *
 * Filters `dist/sitemap-news.xml` (and the source `public/sitemap-news.xml`
 * when --apply is passed) to keep only articles that:
 *   1. Were published in the last 48 hours (Google News window).
 *   2. Match the topic whitelist in `data/news-sitemap-whitelist.ts`
 *      (5 + 1 macro-themes: fisco, AVS/LPP, LAMal, dogana/lavoro, FX,
 *      trasporti). Case-insensitive substring match.
 *
 * The build pipeline (`scripts/create-article.mjs` + `htmlTemplate` copy of
 * public/* into dist/) already integrates the whitelist inline at emit-time
 * via the same module — this script is the verification + cleanup fallback
 * for legacy entries already in the sitemap.
 *
 * Usage:
 *   node scripts/cleanup-news-sitemap.mjs              # default: read dist/, dry-run
 *   node scripts/cleanup-news-sitemap.mjs --dry-run    # explicit dry-run, no writes
 *   node scripts/cleanup-news-sitemap.mjs --apply      # rewrite both public/ and dist/
 *   node scripts/cleanup-news-sitemap.mjs --source=public   # operate on public/ only
 *
 * Per CLAUDE.md non-negotiable rule #5 + memory `feedback_never_noindex`:
 * filtered URLs stay in `sitemap-blog.xml` and remain reachable. We never
 * noindex, never delete article HTML — we only narrow the news sitemap.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeAuditReport } from './lib/auditReport.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// CLI flags
const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');
const DRY_RUN = !APPLY || args.has('--dry-run');
const SOURCE_FLAG = [...args].find((a) => a.startsWith('--source='))?.slice(9);

const PUBLIC_PATH = resolve(REPO_ROOT, 'public', 'sitemap-news.xml');
const DIST_PATH = resolve(REPO_ROOT, 'dist', 'sitemap-news.xml');

/** Decide which file(s) we act on. */
function resolveTargets() {
  if (SOURCE_FLAG === 'public') return [PUBLIC_PATH];
  if (SOURCE_FLAG === 'dist') return [DIST_PATH];
  // Default: when applying, rewrite both (public is source-of-truth, dist is built artifact).
  // When dry-running, prefer dist if available, else public.
  if (APPLY) {
    return [PUBLIC_PATH, DIST_PATH].filter(existsSync);
  }
  return [existsSync(DIST_PATH) ? DIST_PATH : PUBLIC_PATH].filter(existsSync);
}

/** Dynamically import the TS whitelist via tsx if available, else fall back to a JS shim.
 *  tsx is already a dev dep used by other scripts in scripts/. */
async function loadWhitelist() {
  const tsPath = resolve(REPO_ROOT, 'data', 'news-sitemap-whitelist.ts');
  // Prefer tsx, which is how every other script in this repo imports TS modules.
  try {
    const { register } = await import('tsx/esm/api');
    register();
    const mod = await import(pathToFileURL(tsPath).href);
    return mod;
  } catch {
    // Fallback: parse the .ts file with a regex to extract the whitelist array.
    const src = readFileSync(tsPath, 'utf-8');
    const match = src.match(/NEWS_SITEMAP_WHITELIST[^=]*=\s*Object\.freeze\(\s*\[([\s\S]*?)\]\s*\)/);
    if (!match) throw new Error('Could not parse NEWS_SITEMAP_WHITELIST from .ts file');
    const tokens = [...match[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => m[1] || m[2]);
    const NEWS_SITEMAP_WHITELIST = tokens;
    const NEWS_SITEMAP_WINDOW_HOURS = 48;
    /** @param {{slug?:string,title?:string,articleSection?:string,tags?:string[],keywords?:string,publishedAt?:string|Date}} a */
    function isArticleNewsEligible(a, now = Date.now()) {
      if (a.publishedAt !== undefined) {
        const ts = a.publishedAt instanceof Date
          ? a.publishedAt.getTime()
          : new Date(a.publishedAt).getTime();
        if (Number.isNaN(ts)) return false;
        const age = now - ts;
        if (age < 0 || age > NEWS_SITEMAP_WINDOW_HOURS * 3600_000) return false;
      }
      const lower = (v) => (v == null ? '' : String(v).toLowerCase());
      const hay = [
        lower(a.slug), lower(a.title), lower(a.articleSection), lower(a.keywords),
        ...(a.tags ?? []).map(lower),
      ].join('  ');
      return NEWS_SITEMAP_WHITELIST.some((t) => hay.includes(t.toLowerCase()));
    }
    return { NEWS_SITEMAP_WHITELIST, NEWS_SITEMAP_WINDOW_HOURS, isArticleNewsEligible };
  }
}

/** Extract slug from a `<loc>` URL like `.../articoli-frontaliere/<slug>/`. */
function slugFromLoc(loc) {
  const m = loc.match(/\/articoli-frontaliere\/([^/?#]+)/);
  return m ? m[1] : '';
}

/** Parse a single <url>...</url> block into a structured record. */
function parseUrlBlock(block) {
  const loc = block.match(/<loc>([^<]+)<\/loc>/)?.[1] || '';
  const date = block.match(/<news:publication_date>([^<]+)<\/news:publication_date>/)?.[1];
  const title = block.match(/<news:title>([^<]+)<\/news:title>/)?.[1];
  const keywordsTag = block.match(/<news:keywords>([^<]+)<\/news:keywords>/)?.[1];
  return {
    block,
    loc,
    slug: slugFromLoc(loc),
    title: title ? decodeXml(title) : undefined,
    publishedAt: date,
    keywords: keywordsTag,
  };
}

function decodeXml(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

/** Read SEO metadata for a slug from services/seo/seo-blog.ts (best-effort regex parse). */
function loadSeoBySlug() {
  const seoPath = resolve(REPO_ROOT, 'services', 'seo', 'seo-blog.ts');
  if (!existsSync(seoPath)) return new Map();
  const src = readFileSync(seoPath, 'utf-8');
  const map = new Map();
  // Per-entry: 'blog-<id>': { ... canonicalPath: '/articoli-frontaliere/<slug>' ... articleSection: 'X' ... keywords: '...' }
  const entryRe = /'(blog-[^']+)':\s*\{([\s\S]*?)\n\s*\},?\s*\n/g;
  for (const m of src.matchAll(entryRe)) {
    const body = m[2];
    const canonical = body.match(/canonicalPath:\s*'([^']+)'/)?.[1] || '';
    const slug = canonical.split('/articoli-frontaliere/')[1]?.replace(/\/$/, '') || '';
    if (!slug) continue;
    const keywords = body.match(/keywords:\s*'([^']*)'/)?.[1];
    const articleSection = body.match(/"articleSection":\s*"([^"]*)"/)?.[1];
    map.set(slug, { keywords, articleSection });
  }
  return map;
}

async function processFile(filePath, ctx) {
  const src = readFileSync(filePath, 'utf-8');
  const urlBlocks = [...src.matchAll(/<url>[\s\S]*?<\/url>/g)].map((m) => m[0]);

  const seoBySlug = ctx.seoBySlug;
  const kept = [];
  const removed = [];

  for (const block of urlBlocks) {
    const parsed = parseUrlBlock(block);
    const seo = seoBySlug.get(parsed.slug) || {};
    const article = {
      slug: parsed.slug,
      title: parsed.title,
      keywords: seo.keywords,
      articleSection: seo.articleSection,
      publishedAt: parsed.publishedAt,
    };
    const eligible = ctx.isArticleNewsEligible(article);
    if (eligible) {
      kept.push(parsed);
    } else {
      // Determine reason: stale window vs off-topic.
      const ts = parsed.publishedAt ? new Date(parsed.publishedAt).getTime() : NaN;
      const age = Number.isNaN(ts) ? null : (Date.now() - ts) / 3600_000;
      const stale = age != null && age > ctx.NEWS_SITEMAP_WINDOW_HOURS;
      removed.push({
        slug: parsed.slug,
        loc: parsed.loc,
        title: parsed.title,
        publishedAt: parsed.publishedAt,
        ageHours: age != null ? Math.round(age * 10) / 10 : null,
        reason: stale ? 'stale-48h-window' : 'off-topic-not-in-whitelist',
      });
    }
  }

  return { filePath, kept, removed, originalCount: urlBlocks.length };
}

function rewriteFile(filePath, keptBlocks) {
  const src = readFileSync(filePath, 'utf-8');
  const headerMatch = src.match(/^[\s\S]*?<urlset[^>]*>/);
  const header = headerMatch ? headerMatch[0] : '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1" xmlns:xhtml="http://www.w3.org/1999/xhtml">';
  const body = keptBlocks.map((b) => '  ' + b.block.replace(/^\s+/, '')).join('\n\n');
  const out = `${header}\n\n${body}\n\n</urlset>\n`;
  writeFileSync(filePath, out, 'utf-8');
}

function writeSummary(report) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dataDir = resolve(REPO_ROOT, 'data');
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const file = resolve(dataDir, `news-sitemap-cleanup-${ts}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2), 'utf-8');
  return file;
}

async function main() {
  const targets = resolveTargets();
  if (targets.length === 0) {
    console.error('cleanup-news-sitemap: no sitemap-news.xml found in dist/ or public/. Skipping.');
    process.exit(0);
  }

  const wl = await loadWhitelist();
  const seoBySlug = loadSeoBySlug();
  const ctx = {
    isArticleNewsEligible: wl.isArticleNewsEligible,
    NEWS_SITEMAP_WINDOW_HOURS: wl.NEWS_SITEMAP_WINDOW_HOURS,
    seoBySlug,
  };

  const report = {
    timestamp: new Date().toISOString(),
    mode: APPLY ? 'apply' : 'dry-run',
    whitelistTokens: wl.NEWS_SITEMAP_WHITELIST.length,
    files: [],
  };

  for (const filePath of targets) {
    const result = await processFile(filePath, ctx);
    const fileReport = {
      file: filePath.replace(REPO_ROOT + '/', ''),
      originalCount: result.originalCount,
      keptCount: result.kept.length,
      removedCount: result.removed.length,
      removed: result.removed,
    };
    report.files.push(fileReport);

    console.log(`\n${fileReport.file}`);
    console.log(`  original: ${fileReport.originalCount}`);
    console.log(`  kept:     ${fileReport.keptCount}`);
    console.log(`  removed:  ${fileReport.removedCount}`);
    const stale = result.removed.filter((r) => r.reason === 'stale-48h-window').length;
    const off = result.removed.filter((r) => r.reason === 'off-topic-not-in-whitelist').length;
    if (stale) console.log(`    - stale (>48h):  ${stale}`);
    if (off) console.log(`    - off-topic:     ${off}`);

    if (APPLY && result.removed.length > 0) {
      rewriteFile(filePath, result.kept);
      console.log(`  ✅ rewrote ${fileReport.file}`);
    }
  }

  const summaryFile = writeSummary(report);
  console.log(`\nSummary written to ${summaryFile.replace(REPO_ROOT + '/', '')}`);
  if (DRY_RUN && !APPLY) {
    console.log('(dry-run — no files modified; use --apply to rewrite)');
  }

  // Structured report — informational. The audit always passes; the JSON
  // captures how many URLs would be / were stripped so debug agents can see
  // it from the artifact.
  const _flatOffenders = [];
  const _byFile = {};
  for (const fr of report.files) {
    _byFile[fr.file] = fr.removedCount;
    for (const r of fr.removed) {
      _flatOffenders.push({
        path: typeof r === 'string' ? r : (r && r.loc) || String(r),
        feature: fr.file,
        metric: 1,
        ratio: null,
        reason: r && r.reason ? r.reason : null,
      });
    }
  }
  await writeAuditReport({
    audit: 'news-sitemap',
    passed: true,
    threshold: null,
    offenders: _flatOffenders,
    byFeature: _byFile,
    extra: { mode: report.mode, whitelistTokens: report.whitelistTokens },
  });
}

main().catch((err) => {
  console.error('cleanup-news-sitemap: FAILED');
  console.error(err);
  process.exit(1);
});
