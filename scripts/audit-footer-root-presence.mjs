#!/usr/bin/env node
/**
 * audit-footer-root-presence
 *
 * Guarantees every static HTML page that ships the staticOverlay shell
 * (`<main class="seo-static-content">`) also ships the `<div id="footer-root">`
 * portal target App.tsx reads via `document.getElementById('footer-root')`.
 *
 * Without that div, the footer falls back to inline render INSIDE `#root` and
 * paints ABOVE the static body — burying the page content under the entire
 * footer chrome (~1500 px on mobile). PR #243 fixed this for `/calcola-stipendio/*`
 * via build-plugins/staticPagesPlugin.ts; this audit prevents the regression
 * on any other plugin that emits the staticOverlay shell.
 *
 * Zero-tolerance: any page with `seo-static-content` but no `footer-root`
 * fails the deploy.
 *
 * Two execution modes:
 *   1. Standalone:  `node scripts/audit-footer-root-presence.mjs`
 *                   (legacy entry point — walks dist/, runs the audit, writes
 *                    the report, exits 0/1/2)
 *   2. Unified runner: import { auditor } from this file, register it with
 *                       scripts/audit-all.mjs (one Node process, all audits).
 *
 * Both modes share the same `createAuditor()` factory so behaviour is
 * byte-identical.
 */
import { readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkHtmlFiles, ROOT, DEFAULT_DIST } from './lib/audit-runner.mjs';
import { writeAuditReport } from './lib/auditReport.mjs';

const SEO_STATIC_RE = /<main\b[^>]*class=["'][^"']*\bseo-static-content\b/i;
const FOOTER_ROOT_RE = /<div\b[^>]*\bid=["']footer-root["']/i;

/**
 * Factory that creates a fresh stateful Auditor closure.
 * Each call returns an independent collector so the audit-all runner can
 * spawn one auditor per pass without state contamination.
 *
 * @param {{ limit?: number }} [opts]
 * @returns {import('./lib/audit-runner.mjs').Auditor}
 */
export function createAuditor(opts = {}) {
  const limit = Math.max(1, opts.limit ?? 30);
  const offenders = [];
  let scanned = 0;

  return {
    name: 'footer-root-presence',
    collect(file, html) {
      if (!html || !SEO_STATIC_RE.test(html)) return;
      scanned++;
      if (!FOOTER_ROOT_RE.test(html)) {
        offenders.push({ path: relative(ROOT, file), feature: featureOf(file) });
      }
    },
    report() {
      const passed = offenders.length === 0;
      const humanSummary = passed
        ? `scanned ${scanned} seo-static-content page(s) — all have footer-root`
        : `${offenders.length} of ${scanned} seo-static-content page(s) missing <div id="footer-root">`;
      return {
        passed,
        offendersTotal: offenders.length,
        offenders,
        threshold: { metric: 'missingFooterRoot', value: 0, comparator: '<=' },
        extra: { scanned, limit },
        humanSummary,
      };
    },
  };
}

function featureOf(absPath) {
  const rel = relative(ROOT, absPath).replace(/^dist\//, '');
  const first = rel.split('/')[0];
  if (!first) return 'root';
  return first;
}

// ─── Auditor export for unified runner ───────────────────────────────────────
// Lazy-instantiated: audit-all.mjs calls `createAuditor()` to get a fresh
// closure per run. We also export the factory directly for tests.

export const auditor = createAuditor();
export { createAuditor as factory };

// ─── Standalone entry point ──────────────────────────────────────────────────

async function standalone() {
  const args = process.argv.slice(2);
  const limit = (() => {
    const a = args.find((s) => s.startsWith('--limit='));
    return a ? Math.max(1, parseInt(a.split('=')[1], 10) || 30) : 30;
  })();

  const distStat = await stat(DEFAULT_DIST).catch(() => null);
  if (!distStat || !distStat.isDirectory()) {
    console.error(`audit-footer-root-presence: dist/ not found at ${DEFAULT_DIST}. Run a build first.`);
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
    threshold: result.threshold ?? null,
    offenders: result.offenders ?? [],
    extra: result.extra ?? {},
  });

  console.log(`audit-footer-root-presence: ${result.humanSummary}`);
  if (result.passed) {
    console.log('PASS: every staticOverlay page also ships <div id="footer-root">.');
    process.exit(0);
  }

  console.error(`\nFAIL: ${result.offendersTotal} page(s) ship <main class="seo-static-content"> WITHOUT a matching <div id="footer-root">.`);
  console.error(`The SPA footer will paint INSIDE #root, above the static body, burying the page content.`);
  console.error(`\nFirst ${Math.min(limit, result.offenders.length)} offenders:`);
  for (const o of result.offenders.slice(0, limit)) console.error(`  ${o.path}`);
  if (result.offenders.length > limit) console.error(`  ... and ${result.offenders.length - limit} more`);
  console.error(`\nHow to fix`);
  console.error(`----------`);
  console.error(`Emit <div id="footer-root"></div> as a sibling AFTER <main class="seo-static-content">`);
  console.error(`in the plugin that produced these pages. Reference implementation:`);
  console.error(`  build-plugins/staticPagesPlugin.ts:4271-4279 (PR #243)`);
  console.error(`  build-plugins/shared/seoPageShell.ts:188-193 (canonical helper)`);
  process.exit(1);
}

// Run as standalone only if invoked directly.
const invokedDirectly = (() => {
  try { return import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1]); }
  catch { return false; }
})();

if (invokedDirectly) {
  standalone().catch((err) => {
    console.error('audit-footer-root-presence: fatal', err);
    process.exit(2);
  });
}
