#!/usr/bin/env node
/**
 * News Sitemap Window Cleanup (Google News).
 *
 * Filters `dist/sitemap-news.xml` and the source `public/sitemap-news.xml`
 * (unless --dry-run is passed) to keep only the entries published in the last
 * 48 hours — Google News' own rule, `isWithinNewsWindow` in
 * `data/news-sitemap-whitelist.ts`. Every locale (it/en/de/fr) and every
 * article section is kept on the same terms: the <loc> is never parsed.
 *
 * Until 2026-10-24 this script ALSO dropped every entry that did not match the
 * topic whitelist of that module. That filter, together with the corpus
 * emitter's, had narrowed the live news sitemap to 7 Italian URLs on a corpus
 * that publishes in four languages every day, so it is gone: topic is not a
 * Google News criterion.
 *
 * The producer (frontaliere-articles `scripts/build-api.mjs` →
 * sitemap-news-candidates.xml, merged by `scripts/pull-articles-api.mjs`)
 * already applies the window — this script is the verification + cleanup
 * fallback for entries that aged out between two syncs.
 *
 * Usage:
 *   node scripts/cleanup-news-sitemap.mjs              # default: rewrite both public/ and dist/
 *   node scripts/cleanup-news-sitemap.mjs --dry-run    # explicit dry-run, no writes (report only)
 *   node scripts/cleanup-news-sitemap.mjs --apply      # same as default, kept for explicit invocations
 *   node scripts/cleanup-news-sitemap.mjs --source=public   # operate on public/ only
 *
 * Default flipped to apply (was dry-run-by-default) because none of the 5 CI
 * call sites ever passed --apply, so rewriteFile() was permanently dead code
 * and sitemap-news.xml was never actually narrowed to the whitelist/48h
 * window in production (issue #4848). --dry-run remains available for local
 * inspection (`npm run audit:news-sitemap`).
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

// CLI flags. Apply-by-default (see Usage above): only an explicit --dry-run
// opts into the read-only report. --apply is accepted for backward
// compatibility with existing explicit invocations (e.g. package.json
// `sanitize:news-sitemap`) but is no longer required to trigger a rewrite.
const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const APPLY = !DRY_RUN;
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

/** Dynamically import the TS module via tsx if available, else fall back to a JS shim.
 *  tsx is already a dev dep used by other scripts in scripts/. */
async function loadWindow() {
  const tsPath = resolve(REPO_ROOT, 'data', 'news-sitemap-whitelist.ts');
  try {
    const { register } = await import('tsx/esm/api');
    register();
    const mod = await import(pathToFileURL(tsPath).href);
    return { isWithinNewsWindow: mod.isWithinNewsWindow, NEWS_SITEMAP_WINDOW_HOURS: mod.NEWS_SITEMAP_WINDOW_HOURS };
  } catch {
    // Fallback: read the window from the .ts file and re-state the predicate.
    const src = readFileSync(tsPath, 'utf-8');
    const m = src.match(/NEWS_SITEMAP_WINDOW_HOURS\s*=\s*(\d+)/);
    if (!m) throw new Error('Could not parse NEWS_SITEMAP_WINDOW_HOURS from .ts file');
    const NEWS_SITEMAP_WINDOW_HOURS = Number(m[1]);
    function isWithinNewsWindow(publishedAt, now = Date.now()) {
      if (publishedAt === undefined || publishedAt === null || publishedAt === '') return false;
      const ts = publishedAt instanceof Date ? publishedAt.getTime() : new Date(publishedAt).getTime();
      if (Number.isNaN(ts)) return false;
      const age = now - ts;
      return age >= 0 && age <= NEWS_SITEMAP_WINDOW_HOURS * 3600_000;
    }
    return { isWithinNewsWindow, NEWS_SITEMAP_WINDOW_HOURS };
  }
}

/** Parse a single <url>...</url> block into a structured record. */
function parseUrlBlock(block) {
  const loc = block.match(/<loc>([^<]+)<\/loc>/)?.[1] || '';
  const date = block.match(/<news:publication_date>([^<]+)<\/news:publication_date>/)?.[1];
  const title = block.match(/<news:title>([^<]+)<\/news:title>/)?.[1];
  const language = block.match(/<news:language>([^<]+)<\/news:language>/)?.[1];
  return {
    block,
    loc,
    language,
    title: title ? decodeXml(title) : undefined,
    publishedAt: date,
  };
}

function decodeXml(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

async function processFile(filePath, ctx) {
  const src = readFileSync(filePath, 'utf-8');
  const urlBlocks = [...src.matchAll(/<url>[\s\S]*?<\/url>/g)].map((m) => m[0]);

  const kept = [];
  const removed = [];

  for (const block of urlBlocks) {
    const parsed = parseUrlBlock(block);
    if (ctx.isWithinNewsWindow(parsed.publishedAt)) {
      kept.push(parsed);
      continue;
    }
    const ts = parsed.publishedAt ? new Date(parsed.publishedAt).getTime() : NaN;
    const age = Number.isNaN(ts) ? null : (Date.now() - ts) / 3600_000;
    removed.push({
      loc: parsed.loc,
      language: parsed.language,
      title: parsed.title,
      publishedAt: parsed.publishedAt,
      ageHours: age != null ? Math.round(age * 10) / 10 : null,
      reason: age == null ? 'missing-or-invalid-date' : age < 0 ? 'future-dated' : 'stale-48h-window',
    });
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

  const ctx = await loadWindow();

  const report = {
    timestamp: new Date().toISOString(),
    mode: APPLY ? 'apply' : 'dry-run',
    windowHours: ctx.NEWS_SITEMAP_WINDOW_HOURS,
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
    const bad = result.removed.length - stale;
    if (stale) console.log(`    - stale (>48h):        ${stale}`);
    if (bad) console.log(`    - bad/future date:     ${bad}`);

    if (APPLY && result.removed.length > 0) {
      rewriteFile(filePath, result.kept);
      console.log(`  ✅ rewrote ${fileReport.file}`);
    }
  }

  const summaryFile = writeSummary(report);
  console.log(`\nSummary written to ${summaryFile.replace(REPO_ROOT + '/', '')}`);
  if (DRY_RUN) {
    console.log('(dry-run — no files modified; omit --dry-run to rewrite)');
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
    extra: { mode: report.mode, windowHours: report.windowHours },
  });
}

main().catch((err) => {
  console.error('cleanup-news-sitemap: FAILED');
  console.error(err);
  process.exit(1);
});
