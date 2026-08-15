#!/usr/bin/env node
/**
 * audit-duplicate-meta-description.mjs
 *
 * Post-build gate (Semrush E6 / issue 6): no `<meta name="description">`
 * string may be shared by more than `MAX_DUPLICATE_PAGES_PER_DESCRIPTION`
 * URLs. The recurring offender is a plugin fallback ("Calcolatore stipendio…")
 * emitted verbatim on a whole family of pages.
 *
 * Mirror of `tests/dist-duplicate-meta-description.test.ts`, migrated into the
 * unified `audit-all` runner (issue #5845 item 6) on the pattern
 * `scripts/audit-breadcrumb-coverage.mjs` established (#5874 / PR #5883).
 * The vitest copy stays behind `RUN_DIST_GATES=1` as a manual mirror; the
 * REAL gate is this auditor, riding the single shared dist/ walk.
 *
 * WHY THE MIGRATION. `npm run gate:dist-quality` ran five full-corpus vitest
 * scans in one worker pool. Measured on run 31891126686 (2026-08-15): 4 of 5
 * files failed and the pool died `ERR_WORKER_OUT_OF_MEMORY` after 597.95 s.
 *
 * ─── THE SAMPLING SEMANTICS, DECLARED ──────────────────────────────────────
 *
 * This is the one invariant of the four that is CUMULATIVE: its subject is a
 * GROUP of pages sharing a string, not a page. Under CI's
 * `AUDIT_SAMPLE_RATE=0.25` a group of 8 real pages shows up as ~2 sampled
 * ones, so the threshold cannot be carried over naively and cannot be
 * converted to a rate either — "descriptions duplicated per page scanned" is
 * not a quantity anyone can act on, and scaling the group threshold down
 * (`ceil(2 × 0.25)` = 1) would fail every page that merely HAS a description.
 *
 * What is done instead, and what it costs, stated plainly:
 *
 *   The threshold stays 2, applied to group sizes WITHIN THE SCANNED SET.
 *   A group of >2 pages in the sample is a group of >2 pages in dist/ (the
 *   sample is a subset), so the gate NEVER fires on a duplication that does
 *   not exist: no false positives, ever, at any sample rate.
 *   What it loses is RECALL: a group of 3-8 pages split across buckets may go
 *   unseen in a given run. The salt rotation does not fully repair that —
 *   buckets are disjoint, so a group is only ever seen through one bucket at
 *   a time. Concretely at rate 0.25 the gate reliably catches the wide
 *   fallback families it exists for (a 14-page family shows ~3-4 sampled) and
 *   under-reports the narrow ones near the threshold.
 *
 * That is the same direction of error every sampled gate in this runner
 * already accepts — under-report, never over-report — and it is stated in the
 * report `extra` (`samplingSemantics`) so nobody reads a green run as proof
 * the corpus is clean.
 *
 * Two execution modes:
 *   1. Standalone CLI:  node scripts/audit-duplicate-meta-description.mjs [--json] [--limit N]
 *   2. Unified runner:  imported by scripts/audit-all.mjs via factory().
 */

import { readFile, stat } from 'node:fs/promises';
import { relative } from 'node:path';
import { walkHtmlFiles, ROOT, DEFAULT_DIST } from './lib/audit-runner.mjs';
import { writeAuditReport } from './lib/auditReport.mjs';
import { extractMetaDescriptionRaw } from './lib/meta-description-extract.mjs';

export const MAX_DUPLICATE_PAGES_PER_DESCRIPTION = 2;

/**
 * Description prefixes duplicated BY DESIGN (404 / soft-404 stubs share one
 * noindex description). Kept byte-identical to the vitest mirror's
 * `ALLOWLIST_PREFIXES`.
 */
export const ALLOWLIST_PREFIXES = Object.freeze([
  'Pagina non trovata',
  'Page not found',
  'Seite nicht gefunden',
  'Page introuvable',
]);

export function createAuditor(opts = {}) {
  const limit = opts.limit ?? 20;
  const maxPages = opts.maxPagesPerDescription ?? MAX_DUPLICATE_PAGES_PER_DESCRIPTION;
  const sampleRate = opts.sampleRate ?? (() => {
    const v = Number(process.env.AUDIT_SAMPLE_RATE);
    return v > 0 && v <= 1 ? v : 1;
  })();

  /** description → paths that carry it, capped so one fallback family cannot
   *  grow the accumulator without bound on a 3.8M-file corpus. */
  const byDescription = new Map();
  const PATHS_PER_DESCRIPTION_CAP = 25;
  let filesScanned = 0;

  return {
    name: 'duplicate-meta-description',
    collect(file, html) {
      if (html.length === 0) return;
      filesScanned += 1;
      const desc = extractMetaDescriptionRaw(html);
      if (!desc) return;
      if (ALLOWLIST_PREFIXES.some((p) => desc.startsWith(p))) return;
      const entry = byDescription.get(desc);
      if (entry) {
        entry.count += 1;
        if (entry.paths.length < PATHS_PER_DESCRIPTION_CAP) {
          entry.paths.push(relative(ROOT, file).replace(/^dist\//, ''));
        }
      } else {
        byDescription.set(desc, { count: 1, paths: [relative(ROOT, file).replace(/^dist\//, '')] });
      }
    },
    report() {
      const offenders = [];
      for (const [desc, { count, paths }] of byDescription) {
        if (count > maxPages) {
          offenders.push({
            path: paths[0],
            description: desc.slice(0, 100),
            metric: count,
            pages: paths.slice(0, 5),
          });
        }
      }
      offenders.sort((a, b) => b.metric - a.metric);
      const passed = offenders.length === 0;
      return {
        passed,
        offendersTotal: offenders.length,
        offenders: offenders.slice(0, 100),
        threshold: { metric: 'pagesPerDescription', value: maxPages, comparator: '<= (within the scanned set)' },
        extra: {
          limit,
          filesScanned,
          sampleRate,
          distinctDescriptions: byDescription.size,
          samplingSemantics:
            sampleRate < 1
              ? `group sizes are counted WITHIN the ${(sampleRate * 100).toFixed(0)}% sampled slice: no false positives (a sampled group is a real group), reduced recall (a real group may be split across buckets and never seen whole). A green run is not proof the corpus is clean.`
              : 'full walk: group sizes are corpus-exact.',
        },
        humanSummary: passed
          ? `duplicate meta-description gate: 0 description(s) on more than ${maxPages} of ${filesScanned} scanned page(s)`
          : `${offenders.length} description(s) shared by more than ${maxPages} pages (worst: ${offenders[0].metric} pages)`,
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
    console.error(`[audit-duplicate-meta-description] ${DEFAULT_DIST} not found — run \`npm run build\` first.`);
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
    offenders: result.offenders,
    extra: result.extra,
  });

  if (JSON_OUT) {
    console.log(JSON.stringify({ total: result.offendersTotal, extra: result.extra, offenders: result.offenders.slice(0, limit) }, null, 2));
  } else if (result.passed) {
    console.log(`✅ ${result.humanSummary}.`);
  } else {
    console.error(`❌ ${result.humanSummary}.`);
    console.error('');
    for (const o of result.offenders.slice(0, limit)) {
      console.error(`  - "${o.description}…" on ${o.metric} pages: ${o.pages.join(', ')}${o.metric > o.pages.length ? ', …' : ''}`);
    }
    console.error('');
    console.error('Fix: parameterise the plugin fallback with path-specific keywords (staticPagesPlugin, ogPagesPlugin, jobsSeoPagesPlugin).');
  }
  process.exit(result.passed ? 0 : 1);
}

const invokedDirectly = (() => {
  try { return import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1]); }
  catch { return false; }
})();

if (invokedDirectly) {
  standalone().catch((err) => {
    console.error('[audit-duplicate-meta-description] fatal', err);
    process.exit(2);
  });
}
