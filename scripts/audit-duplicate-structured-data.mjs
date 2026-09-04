#!/usr/bin/env node
/**
 * audit-duplicate-structured-data.mjs
 *
 * Post-build gate (GSC rich-results): no page-scoped JSON-LD `@type` may
 * appear in two separate `application/ld+json` blocks on the same page.
 * Google's Rich Results validator marks such a page INVALID and the rich
 * result is disqualified for that URL ("Campo duplicato 'FAQPage'" in Search
 * Console).
 *
 * Mirror of `tests/dist-duplicate-structured-data.test.ts`, migrated into the
 * unified `audit-all` runner (issue #5845 item 6) on the pattern
 * `scripts/audit-breadcrumb-coverage.mjs` established (#5874 / PR #5883).
 * The vitest copy stays behind `RUN_DIST_GATES=1` as a manual mirror; the
 * REAL gate is this auditor, riding the single shared dist/ walk.
 *
 * WHY THE MIGRATION. `npm run gate:dist-quality` ran five full-corpus vitest
 * scans in one worker pool. Measured on run 31891126686 (2026-08-15): 4 of 5
 * files failed and the pool died `ERR_WORKER_OUT_OF_MEMORY` after 597.95 s.
 * The vitest mirror even carried its own soft budget assertion whose failure
 * text prescribed exactly this move ("register this invariant as an auditor
 * in scripts/audit-all.mjs so it rides the single shared walk"). That soft
 * budget is NOT ported: it existed to bound a walk this file no longer owns —
 * `audit-all` owns it, and reports its own walk/collect timings.
 *
 * THRESHOLD: unchanged. This is a PER-PAGE invariant with zero tolerance —
 * "this page has two FAQPage blocks" is a statement about one file and does
 * not depend on how many other files were scanned, so sampling costs recall
 * (which pages get looked at this run), never correctness of a verdict.
 *
 * Two execution modes:
 *   1. Standalone CLI:  node scripts/audit-duplicate-structured-data.mjs [--json] [--limit N]
 *   2. Unified runner:  imported by scripts/audit-all.mjs via factory().
 */

import { readFile, stat } from 'node:fs/promises';
import { relative } from 'node:path';
import { walkHtmlFiles, ROOT, DEFAULT_DIST } from './lib/audit-runner.mjs';
import { writeAuditReport } from './lib/auditReport.mjs';

/**
 * Top-level `@type` values that MUST appear at most once per page in separate
 * JSON-LD scripts.
 *
 * Scoped to FAQPage only — the type GSC actively flags. The other page-scoped
 * types (WebPage, CollectionPage, Article, NewsArticle, JobPosting,
 * BreadcrumbList) have pre-existing duplicate offenders in the current dist;
 * widening the set here would block a deploy without fixing an
 * actively-flagged GSC issue. Kept byte-identical to the vitest mirror's
 * `UNIQUE_TYPES` so the two cannot disagree silently.
 */
export const UNIQUE_TYPES = new Set(['FAQPage']);

/** Extract every `<script type="application/ld+json">…</script>` inner body. */
export function extractLdJsonBlocks(html) {
  const blocks = [];
  const re = /<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) blocks.push(m[1]);
  return blocks;
}

/**
 * Top-level `@type` value(s) of a JSON-LD block. Handles the string form
 * (`"@type": "FAQPage"`) and the array form (`"@type": ["WebPage", …]`).
 * Malformed JSON yields `[]` — a block Google cannot parse is not a
 * duplicate-type offender, it is a different (already gated) defect.
 */
export function topLevelTypes(jsonBody) {
  try {
    const parsed = JSON.parse(jsonBody);
    if (!parsed || typeof parsed !== 'object') return [];
    const t = parsed['@type'];
    if (typeof t === 'string') return [t];
    if (Array.isArray(t)) return t.filter((v) => typeof v === 'string');
    return [];
  } catch {
    return [];
  }
}

export function createAuditor(opts = {}) {
  const limit = opts.limit ?? 20;
  // Counter + bounded sample, same shape and same reason as
  // `audit-single-h1-per-page.mjs` and `audit-link-anchor-text.mjs`: this is
  // also a per-page, per-template defect (a shared FAQPage-emitting component
  // duplicated on one page family), so a wide family can produce O(pages)
  // offenders — an unbounded `offenders.push()` here is the same accumulator
  // shape the fold exists to remove elsewhere (issue #5943).
  let offendersTotal = 0;
  const offenders = [];
  const OFFENDER_SAMPLE_CAP = 100;
  let filesScanned = 0;

  return {
    name: 'duplicate-structured-data',
    collect(file, html) {
      if (html.length === 0) return;
      filesScanned += 1;
      const blocks = extractLdJsonBlocks(html);
      if (blocks.length < 2) return;

      const counts = new Map();
      for (const body of blocks) {
        for (const t of topLevelTypes(body)) {
          if (!UNIQUE_TYPES.has(t)) continue;
          counts.set(t, (counts.get(t) ?? 0) + 1);
        }
      }
      const path = relative(ROOT, file).replace(/^dist\//, '');
      for (const [type, count] of counts) {
        if (count > 1) {
          offendersTotal += 1;
          if (offenders.length < OFFENDER_SAMPLE_CAP) {
            offenders.push({ path, type, metric: count });
          }
        }
      }
    },
    report() {
      const passed = offendersTotal === 0;
      return {
        passed,
        offendersTotal,
        offenders,
        threshold: { metric: 'count', value: 0, comparator: '<=' },
        extra: {
          limit,
          filesScanned,
          uniqueTypes: [...UNIQUE_TYPES],
          // Real count, not the sample-capped array length — see the same
          // field on `audit-single-h1-per-page.mjs` / `audit-link-anchor-
          // text.mjs` for why the writer's own `offendersTotal` cannot be
          // trusted once the cap bites.
          offendersTotalTrue: offendersTotal,
          offendersListTruncated: offendersTotal > offenders.length,
        },
        humanSummary: passed
          ? `duplicate structured-data gate: 0 offenders across ${filesScanned} page(s)`
          : `${offendersTotal} duplicate-type violation(s) (GSC rich-results invalid) of ${filesScanned} page(s) scanned`,
      };
    },
  };
}

export const factory = createAuditor;
export const auditor = factory();

// ─── Standalone CLI ──────────────────────────────────────────────────────────

async function standalone() {
  const args = process.argv.slice(2);
  const getArg = (name) => {
    const eq = args.find((a) => a.startsWith(`${name}=`));
    if (eq) return eq.slice(name.length + 1);
    const idx = args.indexOf(name);
    return idx === -1 ? undefined : args[idx + 1];
  };
  const limit = Number(getArg('--limit') ?? 20);
  const JSON_OUT = args.includes('--json');

  const s = await stat(DEFAULT_DIST).catch(() => null);
  if (!s || !s.isDirectory()) {
    console.error(`[audit-duplicate-structured-data] ${DEFAULT_DIST} not found — run \`npm run build\` first.`);
    process.exit(2);
  }

  const a = createAuditor({ limit });
  const files = await walkHtmlFiles(DEFAULT_DIST);
  for (const file of files) {
    let html;
    try { html = await readFile(file, 'utf8'); }
    catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    a.collect(file, html);
  }
  const result = await a.report();
  await writeAuditReport({
    audit: a.name,
    passed: result.passed,
    threshold: result.threshold,
    offenders: result.offenders.slice(0, 100),
    extra: result.extra,
  });

  if (JSON_OUT) {
    console.log(JSON.stringify({ total: result.offendersTotal, offenders: result.offenders.slice(0, limit) }, null, 2));
  } else if (result.passed) {
    console.log(`✅ duplicate structured-data gate: 0 offenders across ${result.extra.filesScanned} page(s).`);
  } else {
    console.error(`❌ duplicate structured-data gate: ${result.offendersTotal} violation(s).`);
    console.error('');
    console.error(`Top ${Math.min(limit, result.offenders.length)} offenders:`);
    for (const o of result.offenders.slice(0, limit)) {
      console.error(`  - ${o.path}: ${o.type}×${o.metric}`);
    }
    console.error('');
    console.error('Fix: identify the build plugin emitting the duplicate and consolidate to a single JSON-LD script.');
  }
  process.exit(result.passed ? 0 : 1);
}

const invokedDirectly = (() => {
  try { return import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1]); }
  catch { return false; }
})();

if (invokedDirectly) {
  standalone().catch((err) => {
    console.error('[audit-duplicate-structured-data] fatal', err);
    process.exit(2);
  });
}
