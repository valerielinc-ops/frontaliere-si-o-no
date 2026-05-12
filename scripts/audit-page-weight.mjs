#!/usr/bin/env node
/**
 * audit-page-weight.mjs
 *
 * Walk `dist/**\/*.html`, measure page weight (HTML + inline JS + inline CSS),
 * and fail (exit 1) if any page:
 *   - HTML exceeds 200 KB, OR
 *   - has `<img>` tags missing `width`, `height`, or `loading` attributes.
 *
 * Purpose: catch SEO-slow-page regressions caught by Semrush (2026-04-24 audit
 * flagged 6 pages as slow). This acts as a hard gate in the prepush/CI loop
 * alongside the Lighthouse CI workflow.
 *
 * Usage:
 *   node scripts/audit-page-weight.mjs            # fail on first offender
 *   node scripts/audit-page-weight.mjs --summary  # list all offenders
 *   node scripts/audit-page-weight.mjs --json     # emit JSON report
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { writeAuditReport } from './lib/auditReport.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist');

const MAX_HTML_BYTES = 200 * 1024; // 200 KB per CLAUDE.md non-negotiable perf gate.

/**
 * Cheap feature bucket for offender grouping. Mirrors the classification the
 * other audits use (notably audit-text-html-ratio.mjs). Kept lightweight on
 * purpose — full plugin attribution lives in audit-text-html-ratio.mjs.
 * @param {string} relPath repo-relative path
 */
function featureForPath(relPath) {
  const p = '/' + relPath.replace(/\\/g, '/').replace(/^dist\//, '').replace(/index\.html$/, '');
  if (/(?:^|\/)(?:cerca-lavoro-ticino|find-jobs-ticino|jobs-im-tessin|trouver-emploi-tessin)\//.test(p)) return 'job-board';
  if (/(?:^|\/)(?:aziende-che-assumono|companies-hiring|unternehmen-einstellen|firmen-die-einstellen|entreprises-recrutent|entreprises-qui-recrutent)\//.test(p)) return 'weekly-employers';
  if (/(?:^|\/)(?:prezzi-benzina|prezzi-diesel|prezzi-carburante-svizzera|gasoline-price-switzerland|diesel-price-switzerland|prix-essence-suisse|prix-diesel-suisse|prix-gasoil-suisse|fuel-prices-switzerland|benzinpreis-schweiz|dieselpreis-schweiz|benzinpreise-schweiz)\//.test(p)) return 'fuel-daily';
  if (/(?:^|\/)(?:articoli-frontaliere|cross-border-articles|grenzgaenger-artikel|articles-frontalier|blog|articles)\//.test(p)) return 'blog';
  if (/(?:^|\/)(?:traffico-dogane|border-wait|wartezeit-grenze|temps-attente-douane)\//.test(p)) return 'border-wait';
  if (/^\/(en|de|fr)\//.test(p)) return 'spa-locale';
  return 'spa-other';
}

const args = new Set(process.argv.slice(2));
const MODE_SUMMARY = args.has('--summary');
const MODE_JSON = args.has('--json');

/** @param {string} dir */
async function walk(dir) {
  // Iterative — the cathedral expansion produced dist/ trees deep enough
  // to blow the call stack via async recursion + array spread.
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const stack = [dir];
  while (stack.length > 0) {
    const cur = /** @type {string} */ (stack.pop());
    let entries;
    try {
      entries = await readdir(cur, { withFileTypes: true });
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') continue;
      throw err;
    }
    for (const e of entries) {
      const p = join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(p);
      } else if (e.isFile() && p.endsWith('.html')) {
        out.push(p);
      }
    }
  }
  return out;
}

/**
 * Inspect every <img ...> tag in the HTML. Return attribute-compliance issues.
 * Required attrs per CLAUDE.md SEO section: width, height, loading (or
 * `fetchpriority="high"` for above-the-fold LCP hero images).
 *
 * @param {string} html
 * @returns {{ tag: string, missing: string[] }[]}
 */
function findImgIssues(html) {
  const issues = [];
  const imgRe = /<img\b([^>]*)>/gi;
  let m;
  while ((m = imgRe.exec(html)) !== null) {
    const attrs = m[1];
    const missing = [];
    if (!/\bwidth\s*=/.test(attrs)) missing.push('width');
    if (!/\bheight\s*=/.test(attrs)) missing.push('height');
    // loading="lazy" OR fetchpriority="high" satisfies the rule (LCP exemption).
    const hasLoading = /\bloading\s*=/.test(attrs);
    const hasFetchPri = /\bfetchpriority\s*=\s*["']?high/i.test(attrs);
    if (!hasLoading && !hasFetchPri) missing.push('loading|fetchpriority');
    if (missing.length > 0) {
      issues.push({ tag: m[0].slice(0, 160), missing });
    }
  }
  return issues;
}

/**
 * Measure inline script + style bytes (sum of their contents, not counting tags).
 * @param {string} html
 */
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

async function main() {
  const stats = await stat(DIST).catch(() => null);
  if (!stats || !stats.isDirectory()) {
    console.error(`audit-page-weight: dist/ not found at ${DIST}. Run a build first.`);
    process.exit(2);
  }

  const files = await walk(DIST);
  /** @type {{file:string, bytes:number, inlineJs:number, inlineCss:number, imgIssues:number}[]} */
  const report = [];
  const offenders = { oversized: /** @type {string[]} */ ([]), imgMissingAttrs: /** @type {{file:string, issues:{tag:string,missing:string[]}[]}[]} */ ([]) };

  for (const file of files) {
    const html = await readFile(file, 'utf8');
    const bytes = Buffer.byteLength(html, 'utf8');
    const { inlineJs, inlineCss } = inlineBreakdown(html);
    const imgIssues = findImgIssues(html);
    const rel = relative(ROOT, file);
    report.push({ file: rel, bytes, inlineJs, inlineCss, imgIssues: imgIssues.length });
    if (bytes > MAX_HTML_BYTES) offenders.oversized.push(`${rel} (${(bytes / 1024).toFixed(1)} KB)`);
    if (imgIssues.length > 0) offenders.imgMissingAttrs.push({ file: rel, issues: imgIssues });
  }

  if (MODE_JSON) {
    console.log(JSON.stringify({ total: report.length, maxHtmlBytes: MAX_HTML_BYTES, offenders, report }, null, 2));
  } else {
    const topTen = [...report].sort((a, b) => b.bytes - a.bytes).slice(0, 10);
    console.log(`audit-page-weight: scanned ${report.length} HTML files in dist/`);
    console.log(`Top 10 heaviest pages:`);
    for (const r of topTen) {
      console.log(`  ${(r.bytes / 1024).toFixed(1).padStart(7)} KB  ${r.file}  (inlineJs=${r.inlineJs}B, inlineCss=${r.inlineCss}B)`);
    }
  }

  const hasOffenders = offenders.oversized.length > 0 || offenders.imgMissingAttrs.length > 0;

  // ── Structured offender list for both stdout + JSON report ──
  // We surface offenders even when the gate passes, so audit-reports/ always
  // captures the current state and run-over-run diffs are possible. Sort
  // oversized offenders worst-first (biggest bytes); merge with img-issue
  // offenders so a single `topOffenders` slice carries both failure modes.
  /** @type {Array<{path:string, feature:string, metric:number, ratio:null, kind:string, inlineJs:number, inlineCss:number, imgIssues?:Array<{tag:string,missing:string[]}>}>} */
  const structuredOffenders = [];
  const oversizedDetail = report
    .filter((r) => r.bytes > MAX_HTML_BYTES)
    .sort((a, b) => b.bytes - a.bytes);
  for (const r of oversizedDetail) {
    structuredOffenders.push({
      path: r.file,
      feature: featureForPath(r.file),
      metric: r.bytes,
      ratio: null,
      kind: 'oversized',
      inlineJs: r.inlineJs,
      inlineCss: r.inlineCss,
    });
  }
  // Deduplicate img-issue offenders that are also oversized — same file
  // shouldn't appear twice; widen the existing entry's `kind` instead.
  const oversizedSet = new Set(oversizedDetail.map((r) => r.file));
  for (const o of offenders.imgMissingAttrs) {
    if (oversizedSet.has(o.file)) {
      const ex = structuredOffenders.find((s) => s.path === o.file);
      if (ex) { ex.kind = 'oversized+img-attrs'; ex.imgIssues = o.issues; }
      continue;
    }
    const matched = report.find((r) => r.file === o.file);
    structuredOffenders.push({
      path: o.file,
      feature: featureForPath(o.file),
      metric: matched ? matched.bytes : 0,
      ratio: null,
      kind: 'img-attrs',
      inlineJs: matched ? matched.inlineJs : 0,
      inlineCss: matched ? matched.inlineCss : 0,
      imgIssues: o.issues.slice(0, 3),
    });
  }

  if (hasOffenders) {
    if (offenders.oversized.length > 0) {
      console.error(`\nFAIL: ${offenders.oversized.length} page(s) exceed ${MAX_HTML_BYTES / 1024} KB HTML budget:`);
      const show = MODE_SUMMARY ? offenders.oversized : offenders.oversized.slice(0, 5);
      for (const o of show) console.error(`  - ${o}`);
      if (!MODE_SUMMARY && offenders.oversized.length > 5) {
        console.error(`  ... and ${offenders.oversized.length - 5} more (rerun with --summary)`);
      }
    }
    if (offenders.imgMissingAttrs.length > 0) {
      console.error(`\nFAIL: ${offenders.imgMissingAttrs.length} page(s) have <img> tags missing width/height/loading:`);
      const show = MODE_SUMMARY ? offenders.imgMissingAttrs : offenders.imgMissingAttrs.slice(0, 5);
      for (const o of show) {
        console.error(`  - ${o.file} (${o.issues.length} tag(s))`);
        for (const i of o.issues.slice(0, 2)) {
          console.error(`      missing=[${i.missing.join(',')}]  ${i.tag}`);
        }
      }
    }

    // ── Always print top-30 + per-feature breakdown on FAIL so CI logs
    //    carry enough signal to diagnose without artifact downloads. ──
    /** @type {Record<string, number>} */
    const byFeature = {};
    for (const s of structuredOffenders) {
      byFeature[s.feature] = (byFeature[s.feature] ?? 0) + 1;
    }
    if (Object.keys(byFeature).length > 0) {
      console.error('\nOffenders by feature:');
      for (const [feature, count] of Object.entries(byFeature).sort((a, b) => b[1] - a[1])) {
        console.error(`  ${String(count).padStart(6)}  ${feature}`);
      }
    }
    const TOP = 30;
    if (structuredOffenders.length > 0) {
      console.error(`\nTop ${Math.min(TOP, structuredOffenders.length)} offenders (worst first):`);
      for (const s of structuredOffenders.slice(0, TOP)) {
        const sizeKb = (s.metric / 1024).toFixed(1).padStart(7);
        console.error(`  ${sizeKb} KB  [${s.kind}]  ${s.path}  (feature=${s.feature})`);
      }
    }

    await writeAuditReport({
      audit: 'page-weight',
      passed: false,
      threshold: { metric: 'bytes', value: MAX_HTML_BYTES, comparator: '<=' },
      baselineFile: null,
      baselineDelta: null,
      offenders: structuredOffenders,
    });
    process.exit(1);
  }

  console.log(`\nOK: all ${report.length} pages within budget and <img> attrs present.`);
  // On pass we still emit a report (offendersTotal=0) so artifact diffs
  // between runs can show "regression introduced N new offenders".
  await writeAuditReport({
    audit: 'page-weight',
    passed: true,
    threshold: { metric: 'bytes', value: MAX_HTML_BYTES, comparator: '<=' },
    offenders: [],
  });
}

main().catch(err => {
  console.error('audit-page-weight crashed:', err);
  process.exit(2);
});
