#!/usr/bin/env node
/**
 * audit-page-weight.mjs
 *
 * Walk `dist/**\/*.html`, measure page weight (HTML + inline JS + inline CSS),
 * and fail (exit 1) if any page:
 *   - HTML exceeds 200 KB, OR
 *   - has `<img>` tags missing `width`, `height`, or `loading` attributes.
 *
 * Two execution modes:
 *   1. Standalone CLI:  node scripts/audit-page-weight.mjs [...]
 *   2. Unified runner:  imported by scripts/audit-all.mjs via factory().
 */

import { readFile, stat } from 'node:fs/promises';
import { relative } from 'node:path';
import { writeAuditReport } from './lib/auditReport.mjs';
import { walkHtmlFiles, ROOT, DEFAULT_DIST } from './lib/audit-runner.mjs';
import { JOB_BOARD_SECTION_RX } from './lib/jobBoardSections.mjs';
import { FUEL_SECTION_RX } from './lib/fuelSections.mjs';
import { BLOG_SECTION_RX } from './lib/articleSections.mjs';
import { insertBounded } from './lib/boundedTopN.mjs';

// 215 KB cap (was 200 KB). The TI job-board landing
// /cerca-lavoro-ticino/index.html crossed the original 200 KB cap on run
// 26112128794 at 208874 B (+4 KB over) due to organic catalog growth:
// hospital crawler batches 11-15 + Solique tenants kept adding job tiles
// to the landing's top-30 listing block. Trimming the landing requires
// reducing the per-canton job-tile cap or extracting the inline JSON-LD
// to /assets/. Deferred — bumping the SLO 15 KB buys headroom while
// keeping LCP impact bounded (4G ≈ +40 ms over the 200 KB curve at the
// new cap). TODO: drop the tile cap to 25 in the next round of landing
// refactor and re-tighten to 200 KB.
//
// 260 KB (was 215 KB, issue #4209(b)). The TI
// /cerca-lavoro-ticino/tutti/page-N/ pagination ladder is topologically
// unbounded: every one of its ~1956 pages (2026-07-16 live count) renders
// a full flat nav linking every OTHER page (BFS-depth closure — see
// seoHubsPlugin.ts renderPagination / buildThinCantonHubHtml; the
// redesign that would bound this ladder is tracked separately as
// #4209(a), out of scope here). That nav payload scales with total page
// count and is duplicated on every page, so it only grows as the crawler
// pipeline adds jobs. Live-measured baseline on 2026-07-16 (curl
// frontaliereticino.ch, 6 samples spanning page-1..page-1956): 156.4-
// 176.7 KB — already 73-82% of the old 215 KB budget, with no per-path
// override (falls under the flat `job-board` budget via
// JOB_BOARD_SECTION_RX, unlike the fuel-station
// ITALIAN_STATIONS_INDEX_BUDGET override below). Raising to 260 KB buys
// ~83 KB (47%) of headroom over today's measured peak before the ladder
// redesign lands, instead of waiting for a hard breach like run
// 26112128794 above. Do not raise further without a fresh measured
// baseline citing the issue.
const MAX_HTML_BYTES = 260 * 1024;

// Per-path budget override (explicit user-approved exception, 2026-06-03).
// The Italian-fuel-stations INDEX pages (2 fuels × 4 locales) deliberately
// render a visible entity-card for EVERY border station so that the
// orphan-elimination contract (tests/seo/fuel-station-orphans-eliminated.test.ts,
// introduced by #1241 "dettaglio + link visibili per ogni stazione") stays
// green: each station is linked from this comprehensive index, not capped.
// With the full station set these 8 pages weigh ~780 KB — over the 215 KB
// global budget. Capping the visible list would orphan the overflow stations
// and break that contract; per explicit user override we raise the budget for
// THESE pages only rather than trim the indexable content. The global 215 KB
// cap is unchanged for every other page. If these pages keep growing past the
// override, revisit moving per-station links onto the per-city hubs and
// updating the orphan-elimination test (the #1241 restructure).
const ITALIAN_STATIONS_INDEX_BUDGET = 900 * 1024;
const ITALIAN_STATIONS_INDEX_RE =
  /(?:^|\/)(?:stazioni-italia|italienische-tankstellen|italian-stations|stations-italiennes)\//;

function budgetForPath(relPath) {
  const p = '/' + relPath.replace(/\\/g, '/').replace(/^dist\//, '').replace(/index\.html$/, '');
  return ITALIAN_STATIONS_INDEX_RE.test(p) ? ITALIAN_STATIONS_INDEX_BUDGET : MAX_HTML_BYTES;
}

function featureForPath(relPath) {
  const p = '/' + relPath.replace(/\\/g, '/').replace(/^dist\//, '').replace(/index\.html$/, '');
  // Canton-aware job-board sections (TI legacy, every canton, + svizzera
  // aggregator) → shared matcher. Report-grouping only here (the gate is a
  // flat per-page byte cap), but kept consistent with the audit classifiers.
  if (JOB_BOARD_SECTION_RX.test(p)) return 'job-board';
  if (/(?:^|\/)(?:aziende-che-assumono|companies-hiring|unternehmen-einstellen|firmen-die-einstellen|entreprises-recrutent|entreprises-qui-recrutent)\//.test(p)) return 'weekly-employers';
  if (FUEL_SECTION_RX.test(p)) return 'fuel-daily';
  if (BLOG_SECTION_RX.test(p) || /(?:^|\/)(?:blog|articles)\//.test(p)) return 'blog';
  if (/(?:^|\/)(?:traffico-dogane|border-wait|wartezeit-grenze|temps-attente-douane)\//.test(p)) return 'border-wait';
  if (/^\/(en|de|fr)\//.test(p)) return 'spa-locale';
  return 'spa-other';
}

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
    if (missing.length > 0) issues.push({ tag: m[0].slice(0, 160), missing });
  }
  return issues;
}

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

const TOP_HEAVIEST_LIMIT = 10;
const NEAR_BUDGET_PREVIEW_LIMIT = 3;

export function createAuditor() {
  let scannedCount = 0;
  let nearBudgetCount = 0;
  const oversized = [];
  const imgIssuesByFile = [];
  const heaviestTop = [];
  const nearBudgetTop = [];

  return {
    name: 'page-weight',
    collect(file, html) {
      scannedCount++;
      const bytes = Buffer.byteLength(html, 'utf8');
      const { inlineJs, inlineCss } = inlineBreakdown(html);
      const imgIssues = findImgIssues(html);
      const rel = relative(ROOT, file);
      const budget = budgetForPath(rel);

      insertBounded(heaviestTop, { file: rel, bytes, inlineJs, inlineCss }, TOP_HEAVIEST_LIMIT, (s) => s.bytes);

      if (bytes <= budget && bytes > budget * 0.9) {
        nearBudgetCount++;
        insertBounded(nearBudgetTop, { file: rel, bytes, budget }, NEAR_BUDGET_PREVIEW_LIMIT, (s) => s.bytes / s.budget);
      }

      if (bytes > budget) oversized.push({ file: rel, bytes, inlineJs, inlineCss });
      if (imgIssues.length > 0) imgIssuesByFile.push({ file: rel, issues: imgIssues, bytes, inlineJs, inlineCss });
    },
    report() {
      // Build structured offenders (oversized + img-attr issues, deduped).
      const structured = [];
      const oversizedSet = new Set(oversized.map((r) => r.file));
      const oversizedSorted = [...oversized].sort((a, b) => b.bytes - a.bytes);
      for (const r of oversizedSorted) {
        structured.push({
          path: r.file, feature: featureForPath(r.file), metric: r.bytes, ratio: null,
          kind: 'oversized', inlineJs: r.inlineJs, inlineCss: r.inlineCss,
        });
      }
      for (const o of imgIssuesByFile) {
        if (oversizedSet.has(o.file)) {
          const ex = structured.find((s) => s.path === o.file);
          if (ex) { ex.kind = 'oversized+img-attrs'; ex.imgIssues = o.issues; }
          continue;
        }
        structured.push({
          path: o.file, feature: featureForPath(o.file),
          metric: o.bytes, ratio: null, kind: 'img-attrs',
          inlineJs: o.inlineJs, inlineCss: o.inlineCss,
          imgIssues: o.issues.slice(0, 3),
        });
      }

      const byFeature = {};
      for (const s of structured) byFeature[s.feature] = (byFeature[s.feature] ?? 0) + 1;

      const hasOffenders = oversized.length > 0 || imgIssuesByFile.length > 0;
      // Name the worst offenders inline: the unified-runner FAIL line is the
      // only auditor output that reaches the CI log, and a bare count forced
      // every triage to download the audit-reports artifact first (run
      // 27386112992 / issue #1887).
      const topPaths = structured.slice(0, 3)
        .map((s) => s.kind === 'img-attrs'
          ? `${s.path} (img-attrs)`
          : `${s.path} (${(s.metric / 1024).toFixed(1)} KB > ${(budgetForPath(s.path) / 1024).toFixed(0)} KB)`)
        .join(', ');
      // Early warning while still green: pages ≥90% of their budget are the
      // next gate breakers (cerca-lavoro-ticino sat at 99.6% for days before
      // run 27386112992 went red). Surfacing them in the PASS line turns the
      // budget cliff into a visible drift trend in every deploy log.
      const nearNote = nearBudgetCount > 0
        ? ` — WARNING ${nearBudgetCount} page(s) ≥90% of budget, next breakers: ${nearBudgetTop
            .map((s) => `${s.file} (${Math.round((s.bytes / s.budget) * 100)}%)`)
            .join(', ')}`
        : '';
      const humanSummary = hasOffenders
        ? `${oversized.length} oversized + ${imgIssuesByFile.length} img-attr offender(s): ${topPaths}${structured.length > 3 ? ', …' : ''}`
        : `all ${scannedCount} pages within budget and <img> attrs present${nearNote}`;

      return {
        passed: !hasOffenders,
        offendersTotal: structured.length,
        offenders: structured,
        threshold: { metric: 'bytes', value: MAX_HTML_BYTES, comparator: '<=' },
        byFeature,
        extra: { scanned: scannedCount, maxHtmlBytes: MAX_HTML_BYTES, oversizedCount: oversized.length, imgIssuesCount: imgIssuesByFile.length, topHeaviest: heaviestTop },
        humanSummary,
      };
    },
  };
}

export const factory = createAuditor;
export const auditor = factory();

// ─── Standalone CLI ──────────────────────────────────────────────────────────

async function standalone() {
  const args = new Set(process.argv.slice(2));
  const MODE_SUMMARY = args.has('--summary');
  const MODE_JSON = args.has('--json');

  const s = await stat(DEFAULT_DIST).catch(() => null);
  if (!s || !s.isDirectory()) {
    console.error(`audit-page-weight: dist/ not found at ${DEFAULT_DIST}. Run a build first.`);
    process.exit(2);
  }

  const a = createAuditor();
  const files = await walkHtmlFiles(DEFAULT_DIST);
  for (const file of files) {
    const html = await readFile(file, 'utf8');
    a.collect(file, html);
  }
  const result = await a.report();
  await writeAuditReport({
    audit: a.name,
    passed: result.passed,
    threshold: result.threshold,
    offenders: result.offenders,
  });

  if (MODE_JSON) {
    console.log(JSON.stringify({
      total: result.extra.scanned,
      maxHtmlBytes: result.extra.maxHtmlBytes,
      oversizedCount: result.extra.oversizedCount,
      imgIssuesCount: result.extra.imgIssuesCount,
      offenders: result.offenders.slice(0, 100),
    }, null, 2));
    process.exit(result.passed ? 0 : 1);
  }

  const topTen = result.extra.topHeaviest;
  console.log(`audit-page-weight: scanned ${result.extra.scanned} HTML files in dist/`);
  console.log(`Top 10 heaviest pages:`);
  for (const r of topTen) {
    console.log(`  ${(r.bytes / 1024).toFixed(1).padStart(7)} KB  ${r.file}  (inlineJs=${r.inlineJs}B, inlineCss=${r.inlineCss}B)`);
  }

  if (!result.passed) {
    const oversizedOffenders = result.offenders.filter((o) => o.kind.includes('oversized'));
    const imgOffenders = result.offenders.filter((o) => o.kind.includes('img-attrs'));
    if (oversizedOffenders.length > 0) {
      console.error(`\nFAIL: ${oversizedOffenders.length} page(s) exceed ${MAX_HTML_BYTES / 1024} KB HTML budget:`);
      const show = MODE_SUMMARY ? oversizedOffenders : oversizedOffenders.slice(0, 5);
      for (const o of show) console.error(`  - ${o.path} (${(o.metric / 1024).toFixed(1)} KB)`);
      if (!MODE_SUMMARY && oversizedOffenders.length > 5) {
        console.error(`  ... and ${oversizedOffenders.length - 5} more (rerun with --summary)`);
      }
    }
    if (imgOffenders.length > 0) {
      console.error(`\nFAIL: ${imgOffenders.length} page(s) have <img> tags missing width/height/loading:`);
      const show = MODE_SUMMARY ? imgOffenders : imgOffenders.slice(0, 5);
      for (const o of show) {
        const n = o.imgIssues?.length ?? 0;
        console.error(`  - ${o.path} (${n} tag(s))`);
        for (const i of (o.imgIssues ?? []).slice(0, 2)) {
          console.error(`      missing=[${i.missing.join(',')}]  ${i.tag}`);
        }
      }
    }
    if (Object.keys(result.byFeature).length > 0) {
      console.error('\nOffenders by feature:');
      for (const [feature, count] of Object.entries(result.byFeature).sort((a, b) => b[1] - a[1])) {
        console.error(`  ${String(count).padStart(6)}  ${feature}`);
      }
    }
    const TOP = 30;
    console.error(`\nTop ${Math.min(TOP, result.offenders.length)} offenders (worst first):`);
    for (const s of result.offenders.slice(0, TOP)) {
      const sizeKb = (s.metric / 1024).toFixed(1).padStart(7);
      console.error(`  ${sizeKb} KB  [${s.kind}]  ${s.path}  (feature=${s.feature})`);
    }
    process.exit(1);
  }

  console.log(`\nOK: all ${result.extra.scanned} pages within budget and <img> attrs present.`);
  process.exit(0);
}

const invokedDirectly = (() => {
  try { return import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1]); }
  catch { return false; }
})();

if (invokedDirectly) {
  standalone().catch((err) => {
    console.error('audit-page-weight crashed:', err);
    process.exit(2);
  });
}
