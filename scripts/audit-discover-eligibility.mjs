#!/usr/bin/env node
/**
 * audit-discover-eligibility.mjs
 *
 * Measures, per page family, whether the pages in `dist/` actually satisfy
 * what Google Discover requires of an indexable page. Issue #5001.
 *
 * WHY THIS EXISTS, and why as a REPORT rather than a gate.
 *
 * Discover eligibility was assumed rather than measured. On 2026-08-05, one
 * URL from each of the 87 sitemaps was fetched with a Googlebot UA: 50 of the
 * 83 families that answered 200 shipped without `max-image-preview:large`. The
 * assumption had been recorded as "already present on every page". The point
 * of this script is that the next such claim is a number, produced by CI on
 * every deploy, not a spot check.
 *
 * It is REPORT-ONLY by default and exits 0 no matter what it finds. Two
 * reasons, and neither is squeamishness about gates:
 *
 *  1. One of the four checks (a crawlable ≥1200px image) is NOT satisfiable
 *     today by most families, and will not be for a while — those pages are
 *     data landings that legitimately have no hero photograph. Shipping it as
 *     a gate would paint `validate-dist` red on day one, and a red
 *     `validate-dist` skips the whole `publish` job — IndexNow, the Indexing
 *     API, GSC sync. An audit whose first act is to stop the site from telling
 *     Google about its pages has done more harm than the thing it audits.
 *  2. The two checks that ARE universal (`max-image-preview:large`, single
 *     `<h1>`) are already enforced where enforcement belongs: at the source,
 *     by `tests/seo/discover-robots-directive.test.ts` and
 *     `tests/dist-single-h1-per-page.test.ts`. Re-litigating them as a second
 *     blocking gate over dist/ buys nothing but another way to be red.
 *
 * `--strict` flips it to exit 1 on findings, so the day a family's numbers are
 * clean it can be promoted to a gate deliberately, per-check, instead of by
 * accident.
 *
 * Usage:
 *   npm run audit:discover-eligibility
 *   node scripts/audit-discover-eligibility.mjs --dist=path/to/dist --json
 *   node scripts/audit-discover-eligibility.mjs --strict     # exit 1 on findings
 *
 * Exit codes:
 *   0 — always, unless --strict and findings exist, or dist/ is missing
 *   1 — --strict and at least one page failed a check
 *   2 — dist/ missing or fatal error
 */

import { readFile, stat } from 'node:fs/promises';
import { relative } from 'node:path';

import {
  walkHtmlFiles,
  DEFAULT_DIST,
  resolveSamplingEnv,
  sampleFiles,
} from './lib/audit-runner.mjs';
import { writeAuditReport, auditReportPath } from './lib/auditReport.mjs';

// ─── Detection ───────────────────────────────────────────────────────────────
// Regex, not a DOM parse, for the same reason every other audit in this repo
// uses regex: dist/ is millions of files and the checks are all single-tag
// presence questions. Quote-flexible because the upstream minifier drops quotes
// around single-token attribute values (see audit-runner.mjs's RX_NOINDEX).

const RX_NOINDEX = /<meta\s+name=["']?robots["']?\s+content=["']?[^"'>]*\bnoindex\b/i;
const RX_META_REFRESH = /<meta\s+http-equiv=["']?refresh["']?[^>]*url=/i;
const RX_MAX_IMAGE_PREVIEW_LARGE = /max-image-preview\s*:\s*large/i;
const RX_CANONICAL = /<link\s+[^>]*rel=["']?canonical["']?/i;
const RX_H1_OPEN = /<h1[\s>]/gi;
const RX_IMG_TAG = /<img\b[^>]*>/gi;
const RX_IMG_WIDTH = /\bwidth=["']?(\d{2,5})/i;

/**
 * Strip the regions where an `<h1>` is markup-that-is-not-content: HTML
 * comments, `<template>` bodies, and inline `<script>`/`<style>`. Mirrors
 * `tests/dist-single-h1-per-page.test.ts` so the two never disagree about what
 * counts as a second H1.
 */
function stripNonContentRegions(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<template[\s\S]*?<\/template>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');
}

/**
 * The widest intrinsic width declared by any `<img>` in the markup.
 *
 * Deliberately reads the DECLARED `width` attribute rather than probing the
 * asset: Discover reads the page as crawled, and an image without declared
 * dimensions also costs CLS (Non-Negotiable #7). An image the crawler can only
 * size by fetching it is exactly the case this is meant to surface — see
 * `tests/article-hero-image-discover.test.ts`, where article pages carried
 * `max-image-preview:large` and zero `<img>` at all.
 *
 * @returns {number} 0 when the page has no img with a declared width
 */
function widestDeclaredImageWidth(html) {
  let widest = 0;
  RX_IMG_TAG.lastIndex = 0;
  let m;
  while ((m = RX_IMG_TAG.exec(html)) !== null) {
    const w = m[0].match(RX_IMG_WIDTH);
    if (w) {
      const n = Number(w[1]);
      if (Number.isFinite(n) && n > widest) widest = n;
    }
  }
  return widest;
}

/** Google's floor for a large-format Discover card. */
export const LARGE_CARD_MIN_WIDTH = 1200;

/**
 * Bucket a dist-relative path into a coarse "page family" so the report says
 * WHICH generator to fix rather than listing 40k paths. The first path segment
 * (after an optional locale prefix) is the generator's own namespace in every
 * family this site emits.
 */
export function pageFamily(relPath) {
  const parts = relPath.replace(/^[/\\]+/, '').split(/[/\\]/);
  if (parts[0] && /^(en|de|fr)$/.test(parts[0])) parts.shift();
  const head = parts[0] ?? '';
  if (!head || head === 'index.html') return '(root)';
  return head.replace(/\.html$/, '');
}

/**
 * Evaluate one page. Pure, exported, and total — the unit tests drive this
 * directly rather than materialising a dist/ tree.
 *
 * @param {string} html
 * @returns {{ indexable: boolean, checks: Record<string, boolean>, h1Count: number, widestImage: number }}
 */
export function evaluatePage(html) {
  const indexable = !(RX_NOINDEX.test(html) || RX_META_REFRESH.test(html));
  const h1Count = (html.match(RX_H1_OPEN) ?? []).length;
  const contentH1Count = (stripNonContentRegions(html).match(RX_H1_OPEN) ?? []).length;
  const widestImage = widestDeclaredImageWidth(html);

  return {
    indexable,
    h1Count: contentH1Count || h1Count,
    widestImage,
    checks: {
      // The non-negotiable one: without it the preview is capped at a
      // thumbnail and the page can never take a large Discover card.
      maxImagePreviewLarge: RX_MAX_IMAGE_PREVIEW_LARGE.test(html),
      // Exactly one, not "at most one": a page with zero H1 has no headline
      // for Discover to render, which the existing dist gate does not catch.
      singleH1: (contentH1Count || h1Count) === 1,
      canonical: RX_CANONICAL.test(html),
      // Advisory tier — see the header on why this is not a gate.
      largeImage: widestImage >= LARGE_CARD_MIN_WIDTH,
    },
  };
}

/** Checks that are universal properties of an indexable page. */
const REQUIRED_CHECKS = ['maxImagePreviewLarge', 'singleH1', 'canonical'];
/** Checks reported for visibility but not treated as findings even in --strict. */
const ADVISORY_CHECKS = ['largeImage'];

export function createAuditor(opts = {}) {
  const limit = opts.limit ?? 50;
  // Paths are reported relative to the scanned dist root, so the report reads
  // like a URL path and stays stable whatever the checkout location is.
  const distDir = opts.distDir ?? DEFAULT_DIST;
  const byFamily = new Map();
  const offenders = [];
  let scanned = 0;
  let indexableCount = 0;

  const bucket = (family) => {
    let b = byFamily.get(family);
    if (!b) {
      b = { family, indexable: 0, ...Object.fromEntries([...REQUIRED_CHECKS, ...ADVISORY_CHECKS].map((c) => [c, 0])) };
      byFamily.set(family, b);
    }
    return b;
  };

  return {
    name: 'discover-eligibility',

    collect(file, html) {
      scanned++;
      const result = evaluatePage(html);
      // A noindex page is outside Discover's universe by construction; counting
      // it would drown the signal in bridge pages.
      if (!result.indexable) return;
      indexableCount++;

      const rel = relative(distDir, file);
      const family = pageFamily(rel);
      const b = bucket(family);
      b.indexable++;

      const failed = [];
      for (const check of [...REQUIRED_CHECKS, ...ADVISORY_CHECKS]) {
        if (result.checks[check]) b[check]++;
        else if (REQUIRED_CHECKS.includes(check)) failed.push(check);
      }

      if (failed.length > 0 && offenders.length < limit) {
        offenders.push({
          path: rel,
          feature: family,
          metric: failed.length,
          ratio: null,
          failed,
          h1Count: result.h1Count,
          widestImage: result.widestImage,
        });
      }
      if (failed.length > 0) b.failedPages = (b.failedPages ?? 0) + 1;
    },

    report() {
      const families = [...byFamily.values()].sort((a, b) => b.indexable - a.indexable || a.family.localeCompare(b.family));
      const totalFailing = families.reduce((n, f) => n + (f.failedPages ?? 0), 0);

      const byFeature = {};
      for (const f of families) if (f.failedPages) byFeature[f.family] = f.failedPages;

      return {
        // Report-only: the verdict is always "passed" so that registering this
        // in a pipeline can never turn `validate-dist` red by surprise. The
        // caller decides via --strict; see the module header.
        passed: true,
        offendersTotal: totalFailing,
        offenders,
        threshold: { metric: 'count', value: 0, comparator: '<= (advisory)' },
        byFeature,
        extra: {
          scanned,
          indexable: indexableCount,
          families: families.length,
          requiredChecks: REQUIRED_CHECKS,
          advisoryChecks: ADVISORY_CHECKS,
          largeCardMinWidth: LARGE_CARD_MIN_WIDTH,
          perFamily: families,
          reportOnly: true,
        },
        humanSummary:
          `${indexableCount} indexable page(s) across ${families.length} families — ` +
          `${totalFailing} failing a required Discover check`,
        families,
        totalFailing,
      };
    },
  };
}

export const factory = createAuditor;

// ─── Standalone CLI ──────────────────────────────────────────────────────────

function pct(n, d) {
  if (!d) return '  —  ';
  return `${((n / d) * 100).toFixed(1).padStart(5)}%`;
}

async function standalone() {
  const args = process.argv.slice(2);
  const getArg = (name, fallback) => {
    const a = args.find((s) => s.startsWith(`--${name}=`));
    return a ? a.split('=').slice(1).join('=') : fallback;
  };
  const distDir = getArg('dist', DEFAULT_DIST);
  const strict = args.includes('--strict');
  const jsonOut = args.includes('--json');
  const limit = Number(getArg('limit', 50));

  const s = await stat(distDir).catch(() => null);
  if (!s || !s.isDirectory()) {
    console.error(`[audit-discover-eligibility] ${distDir} not found — run \`npm run build\` first.`);
    process.exit(2);
  }

  const auditor = createAuditor({ limit, distDir });
  const allFiles = await walkHtmlFiles(distDir);
  const { rate, salt } = resolveSamplingEnv();
  const { sampled, totalBuckets, activeBucket } = sampleFiles(allFiles, distDir, rate, salt);
  if (totalBuckets > 1) {
    console.log(
      `[audit-discover-eligibility] SAMPLED run: bucket ${activeBucket + 1}/${totalBuckets} — ` +
        `scanning ${sampled.length}/${allFiles.length} files.`,
    );
  }

  for (const file of sampled) {
    let html;
    try {
      html = await readFile(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    auditor.collect(file, html);
  }

  const result = auditor.report();

  await writeAuditReport({
    audit: auditor.name,
    passed: result.passed,
    threshold: result.threshold,
    offenders: result.offenders,
    byFeature: result.byFeature,
    extra: {
      ...result.extra,
      sampling: totalBuckets > 1 ? { totalBuckets, activeBucket, filesOnDisk: allFiles.length } : null,
    },
  });

  if (jsonOut) {
    console.log(JSON.stringify({ summary: result.humanSummary, families: result.families, offenders: result.offenders }, null, 2));
  } else {
    console.log('');
    console.log('Discover eligibility by page family (indexable pages only)');
    console.log('─'.repeat(96));
    console.log(
      `${'family'.padEnd(34)}${'pages'.padStart(8)}${'img-prev'.padStart(10)}${'1×h1'.padStart(10)}${'canon'.padStart(10)}${'≥1200px'.padStart(10)}`,
    );
    console.log('─'.repeat(96));
    for (const f of result.families) {
      console.log(
        `${f.family.slice(0, 33).padEnd(34)}${String(f.indexable).padStart(8)}` +
          `${pct(f.maxImagePreviewLarge, f.indexable).padStart(10)}` +
          `${pct(f.singleH1, f.indexable).padStart(10)}` +
          `${pct(f.canonical, f.indexable).padStart(10)}` +
          `${pct(f.largeImage, f.indexable).padStart(10)}`,
      );
    }
    console.log('─'.repeat(96));
    console.log(result.humanSummary);
    if (result.offenders.length > 0) {
      console.log(`\nFirst ${result.offenders.length} page(s) failing a required check:`);
      for (const o of result.offenders) console.log(`  - ${o.path} → ${o.failed.join(', ')}`);
    }
    console.log(`\nReport: ${auditReportPath(auditor.name)}`);
    if (!strict) {
      console.log('Report-only run (exit 0). Pass --strict to fail on findings.');
    }
  }

  process.exit(strict && result.totalFailing > 0 ? 1 : 0);
}

const invokedDirectly = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1]);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  standalone().catch((err) => {
    console.error('[audit-discover-eligibility] fatal', err);
    process.exit(2);
  });
}
