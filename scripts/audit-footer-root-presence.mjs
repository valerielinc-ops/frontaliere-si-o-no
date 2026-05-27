#!/usr/bin/env node
/**
 * audit-footer-root-presence
 *
 * Guards the hydration-safe staticOverlay shell. Two zero-tolerance checks
 * run on every dist HTML page in a single walk:
 *
 *   1. `missing-footer-root` — page ships `<main class="seo-static-content">`
 *      but no `<div id="footer-root">` portal target. Without it App.tsx's
 *      footer falls back to inline render INSIDE `#root` and paints ABOVE
 *      the static body, burying ~1500 px of content on mobile. PR #243 fixed
 *      this for `/calcola-stipendio/*`; this check stops other plugins from
 *      regressing.
 *
 *   2. `static-job-page-inside-root` — page ships the legacy buildSimplePage
 *      shell `<div id="root"><main class="static-job-page">`. React hydrates
 *      `#root` and wipes that static `<main>`; App.tsx then skips its own
 *      `<main>` because the route is `staticOverlay:true` — SPA users see a
 *      blank page (header + sub-nav only). Crawlers still see SSR content so
 *      the missing-footer-root check alone would miss this. PRs #376/#416/#420
 *      converted every known emit to `buildSeoPageHtml`; this check stops a
 *      future caller from reintroducing the buggy shape.
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

// Quote-flexible: build-plugins/shared/htmlMinify.ts removes quotes from
// single-token HTML5-safe class/id values, e.g. class=seo-static-content.
const SEO_STATIC_RE = /<main\b(?=[^>]*\bclass=(?:"[^"]*\bseo-static-content\b[^"]*"|'[^']*\bseo-static-content\b[^']*'|seo-static-content)(?=[\s>]))[^>]*>/i;
const FOOTER_ROOT_RE = /<div\b[^>]*\bid=["']?footer-root["']?(?=[\s/>])/i;
// Buggy legacy shell: `<div id="root">` immediately followed by `<main class="static-job-page">`.
// Mirrors the regression check in tests/city-jobs-hub.test.ts:358.
const STATIC_JOB_INSIDE_ROOT_RE =
  /<div\b[^>]*\bid=["']?root["']?(?=[\s/>])[^>]*>\s*<main\b(?=[^>]*\bclass=(?:"[^"]*\bstatic-job-page\b[^"]*"|'[^']*\bstatic-job-page\b[^']*'|static-job-page)(?=[\s>]))[^>]*>/i;

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
  /** @type {Array<{ path: string, feature: string, kind: 'missing-footer-root' | 'static-job-page-inside-root' }>} */
  const offenders = [];
  let scannedSeoStatic = 0;
  let scannedStaticJob = 0;

  return {
    name: 'footer-root-presence',
    collect(file, html) {
      if (!html) return;
      if (SEO_STATIC_RE.test(html)) {
        scannedSeoStatic++;
        if (!FOOTER_ROOT_RE.test(html)) {
          offenders.push({
            path: relative(ROOT, file),
            feature: featureOf(file),
            kind: 'missing-footer-root',
          });
        }
      }
      if (STATIC_JOB_INSIDE_ROOT_RE.test(html)) {
        scannedStaticJob++;
        offenders.push({
          path: relative(ROOT, file),
          feature: featureOf(file),
          kind: 'static-job-page-inside-root',
        });
      }
    },
    report() {
      const passed = offenders.length === 0;
      const missingFooter = offenders.filter((o) => o.kind === 'missing-footer-root').length;
      const insideRoot = offenders.filter((o) => o.kind === 'static-job-page-inside-root').length;
      const humanSummary = passed
        ? `scanned ${scannedSeoStatic} seo-static-content page(s); 0 legacy static-job-page emits — shell is hydration-safe`
        : `${missingFooter} missing footer-root (of ${scannedSeoStatic} seo-static-content), ${insideRoot} legacy static-job-page inside #root`;
      return {
        passed,
        offendersTotal: offenders.length,
        offenders,
        threshold: { metric: 'hydrationUnsafeShell', value: 0, comparator: '<=' },
        extra: { scannedSeoStatic, scannedStaticJob, missingFooter, insideRoot, limit },
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
    console.log('PASS: hydration-safe shell on every staticOverlay page.');
    process.exit(0);
  }

  const missingFooter = result.offenders.filter((o) => o.kind === 'missing-footer-root');
  const insideRoot = result.offenders.filter((o) => o.kind === 'static-job-page-inside-root');

  console.error(`\nFAIL: ${result.offendersTotal} hydration-unsafe page(s).`);

  if (missingFooter.length > 0) {
    console.error(`\n[missing-footer-root] ${missingFooter.length} page(s) ship <main class="seo-static-content"> WITHOUT <div id="footer-root">.`);
    console.error(`The SPA footer falls back to inline render INSIDE #root, above the static body, burying the page content.`);
    console.error(`First ${Math.min(limit, missingFooter.length)} offenders:`);
    for (const o of missingFooter.slice(0, limit)) console.error(`  ${o.path}`);
    if (missingFooter.length > limit) console.error(`  ... and ${missingFooter.length - limit} more`);
  }

  if (insideRoot.length > 0) {
    console.error(`\n[static-job-page-inside-root] ${insideRoot.length} page(s) ship the legacy <div id="root"><main class="static-job-page"> shell.`);
    console.error(`React hydration wipes that <main>; App.tsx skips its own <main> on staticOverlay routes → SPA users see a blank page.`);
    console.error(`First ${Math.min(limit, insideRoot.length)} offenders:`);
    for (const o of insideRoot.slice(0, limit)) console.error(`  ${o.path}`);
    if (insideRoot.length > limit) console.error(`  ... and ${insideRoot.length - limit} more`);
  }

  console.error(`\nHow to fix`);
  console.error(`----------`);
  console.error(`Emit pages via buildSeoPageHtml (build-plugins/shared/seoPageShell.ts), which`);
  console.error(`puts the static body in <main class="seo-static-content"> OUTSIDE #root AND`);
  console.error(`adds <div id="footer-root"></div> — both required by App.tsx + useNavigationState.`);
  console.error(`Reference: PR #243 (footer-root), PR #420 (sweep to buildSeoPageHtml).`);
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
