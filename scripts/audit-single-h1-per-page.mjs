#!/usr/bin/env node
/**
 * audit-single-h1-per-page.mjs
 *
 * Post-build gate (Semrush W6 / issue 104): every emitted `dist/` HTML page
 * must contain at most ONE `<h1>` element in the static / pre-hydration HTML.
 * Crawlers and Lighthouse score multi-H1 pages down because the primary topic
 * of the page becomes ambiguous.
 *
 * Mirror of `tests/dist-single-h1-per-page.test.ts`, migrated into the
 * unified `audit-all` runner (issue #5845 item 6) on the pattern
 * `scripts/audit-breadcrumb-coverage.mjs` established (#5874 / PR #5883).
 * The vitest copy stays behind `RUN_DIST_GATES=1` as a manual mirror; the
 * REAL gate is this auditor, riding the single shared dist/ walk.
 *
 * WHY THE MIGRATION. `npm run gate:dist-quality` ran five full-corpus vitest
 * scans in one worker pool. Measured on run 31891126686 (2026-08-15): 4 of 5
 * files failed and the pool died `ERR_WORKER_OUT_OF_MEMORY` after 597.95 s
 * under `--max-old-space-size=4096`. dist/ was 3,798,763 HTML files on
 * 2026-08-14 (`tests/helpers/distHtmlScan.ts`), and vitest has no lever that
 * bounds that: `audit-all` does (AUDIT_SAMPLE_RATE / AUDIT_SAMPLE_SALT, with
 * the rotation guarantee in `scripts/lib/audit-runner.mjs::sampleFiles`).
 *
 * THRESHOLD: unchanged. This is a PER-PAGE invariant with zero tolerance —
 * "this page has 2 h1" is true or false about one file and does not depend on
 * how many other files were scanned, so sampling costs recall (which pages
 * get looked at this run), never correctness of a verdict. No conversion was
 * needed, and none was made.
 *
 * Two execution modes:
 *   1. Standalone CLI:  node scripts/audit-single-h1-per-page.mjs [--json] [--limit N]
 *   2. Unified runner:  imported by scripts/audit-all.mjs via factory().
 */

import { readFile, stat } from 'node:fs/promises';
import { relative } from 'node:path';
import { walkHtmlFiles, ROOT, DEFAULT_DIST } from './lib/audit-runner.mjs';
import { writeAuditReport } from './lib/auditReport.mjs';

/**
 * Pages where a multi-H1 emit pattern is intentional and a single-H1 fix
 * would require reworking shared chrome. Add a path here only with a GitHub
 * issue reference explaining why.
 *
 * ENTRIES CARRY A LEADING SLASH — `/de/lavoro/x/index.html`. That is the
 * shape the vitest mirror's `ALLOWLIST_PATHS` uses, because `scanDistHtml`
 * yields `full.slice(distDir.length)`. Both lists are empty today, so a
 * mismatch would be inert right up until someone adds the same entry to both
 * files (which the mirror's header tells them to do) and the exemption
 * silently applies in only one of the two. `audit-breadcrumb-coverage.mjs`
 * normalises the same way for the same reason.
 */
export const ALLOWLIST_PATHS = Object.freeze([]);

/** dist-relative path WITH the leading slash the allowlist is written in. */
function toDistRelPath(absPath) {
  return `/${relative(ROOT, absPath).replace(/^dist\//, '')}`;
}

/**
 * Counts `<h1>` opening tags in the static HTML, ignoring tags inside
 * `<template>` blocks, `<script>` (JSON-LD included), `<style>` or HTML
 * comments. Permissive tag regex (`<h1[\s>]`) matches both bare `<h1>` and
 * `<h1 class="…">` but not `&lt;h1&gt;` text. Copied from the mirror's
 * `countH1Tags`, and NOTHING enforces that the two stay in step — the mirror
 * is manual-only and no test imports it. If they ever disagree, this one is
 * the gate and the mirror is the stale copy.
 */
export function countH1Tags(html) {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<template[\s\S]*?<\/template>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');
  const matches = stripped.match(/<h1[\s>]/gi);
  return matches ? matches.length : 0;
}

export function createAuditor(opts = {}) {
  const limit = opts.limit ?? 25;
  // Injectable so the leading-slash contract above is TESTABLE. Both lists
  // being empty is exactly what let the mismatch with the mirror survive
  // review: an exemption nobody can exercise is an exemption nobody can check.
  const allowlist = opts.allowlist ?? ALLOWLIST_PATHS;
  // Counter + bounded sample, same shape and same reason as the sibling fold
  // auditors' accumulators (`audit-link-anchor-text.mjs`'s `nonDescriptiveTotal`
  // / `nonDescriptiveSample`): the known failure mode here is a shared SPA
  // component that emits a mobile + desktop <h1> variant, which is
  // PER-TEMPLATE — one offender per page it renders on, so a wide family can
  // hit O(pages) offenders. At ~950k pages scanned under 25% sampling that is
  // ~285 MB of offender objects in the exact process this migration exists to
  // keep under 4096 MB. An unbounded `offenders.push()` was the accumulator
  // shape `audit-link-anchor-text.mjs` was written to avoid; this file just
  // hadn't been given the same treatment yet (issue #5943).
  let offendersTotal = 0;
  const offenders = [];
  const OFFENDER_SAMPLE_CAP = 100;
  let filesScanned = 0;

  return {
    name: 'single-h1-per-page',
    collect(file, html) {
      // Zero-byte files are corrupted artifacts (e.g. from an OOM crash
      // mid-build), not real pages — same skip as audit-breadcrumb-coverage.
      if (html.length === 0) return;
      filesScanned += 1;
      const url = toDistRelPath(file);
      if (allowlist.includes(url)) return;
      const count = countH1Tags(html);
      if (count > 1) {
        offendersTotal += 1;
        // `path` stays slash-less for report readability (every sibling
        // auditor reports that shape); `url` is the allowlist's shape. Two
        // names because they are two different things, which is what went
        // wrong before.
        if (offenders.length < OFFENDER_SAMPLE_CAP) {
          offenders.push({ path: url.slice(1), url, metric: count });
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
          // The writer (`writeAuditReport`) derives ITS OWN `offendersTotal`
          // from `offenders.length`, so in the artifact that field is the
          // sample size once the cap bites, not the true count. This is the
          // real number, and it is the one the verdict was taken on.
          offendersTotalTrue: offendersTotal,
          offendersListTruncated: offendersTotal > offenders.length,
        },
        humanSummary: passed
          ? `single-H1 gate: 0 offenders across ${filesScanned} page(s)`
          : `${offendersTotal} page(s) with more than one <h1> (of ${filesScanned} scanned)`,
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
  const limit = Number(getArg('--limit') ?? 25);
  const JSON_OUT = args.includes('--json');

  const s = await stat(DEFAULT_DIST).catch(() => null);
  if (!s || !s.isDirectory()) {
    console.error(`[audit-single-h1-per-page] ${DEFAULT_DIST} not found — run \`npm run build\` first.`);
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
    console.log(`✅ single-H1 gate: 0 offenders across ${result.extra.filesScanned} page(s).`);
  } else {
    console.error(`❌ single-H1 gate: ${result.offendersTotal} page(s) with multiple <h1>.`);
    console.error('');
    console.error(`Top ${Math.min(limit, result.offenders.length)} offenders:`);
    for (const o of result.offenders.slice(0, limit)) {
      console.error(`  - ${o.path} → ${o.metric} <h1> tags`);
    }
    console.error('');
    console.error('Fix: in the responsible component or plugin, demote the duplicate H1 to <h2>, or render only one variant at a time.');
  }
  process.exit(result.passed ? 0 : 1);
}

const invokedDirectly = (() => {
  try { return import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1]); }
  catch { return false; }
})();

if (invokedDirectly) {
  standalone().catch((err) => {
    console.error('[audit-single-h1-per-page] fatal', err);
    process.exit(2);
  });
}
