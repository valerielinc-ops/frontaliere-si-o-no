#!/usr/bin/env node
/**
 * audit-salary-landing-template
 *
 * Enforces CLAUDE.md non-negotiable rule #17 ("SEO-landing UI/UX template")
 * on every static HTML page emitted under the salary-calculator hubs:
 *
 *   /calcola-stipendio/{slug}/      (IT)
 *   /en/calculate-salary/{slug}/    (EN)
 *   /de/gehalt-berechnen/{slug}/    (DE)
 *   /fr/calculer-salaire/{slug}/    (FR)
 *
 * Every URL emitted by build-plugins/staticPagesPlugin.ts under those hubs
 * MUST be rendered through build-plugins/shared/salaryLandingShell.ts's
 * `buildSalaryLandingBody()`, which produces:
 *
 *   <main class="seo-static-content"> ... </main>
 *     ├─ eyebrow line
 *     ├─ <h1 style="...clamp(...)">  ← large clamp-sized H1
 *     ├─ lede ≤120 chars
 *     ├─ stat-tile grid (≥3 tiles, OKLCH semantic tokens)
 *     ├─ "Consiglio" advisory banner (when applicable)
 *     ├─ primary CTA above the fold
 *     ├─ data area (comparative table / list / cards)
 *     └─ long prose BELOW the action area
 *
 * Symptom this catches: a salary-landing URL falls through the default
 * "thin" placeholder branch in staticPagesPlugin (empty calculator slot
 * `<div height:38rem>`, tiny `<h1 style="font-size:1.25rem">`, no stat tiles).
 * Root cause for the 2026-05-19 regression: the regex gate at
 * staticPagesPlugin.ts:4151 was IT-only — non-IT locale variants leaked
 * through to the default branch.
 *
 * Zero tolerance: any matching URL without `<main class="seo-static-content">`
 * fails the deploy.
 */
import { readFile, stat } from 'node:fs/promises';
import { relative } from 'node:path';
import { walkHtmlFiles, ROOT, DEFAULT_DIST } from './lib/audit-runner.mjs';
import { writeAuditReport } from './lib/auditReport.mjs';

// Match every salary-landing scenario URL across the 4 locales. The trailing
// segment must be a real slug (`[^/]+`) — the hub root pages `/calcola-stipendio/`
// and locale variants are intentionally out of scope (they ship through a
// different code path: see `isCalcStipendioIndex` in staticPagesPlugin.ts).
const SALARY_LANDING_PATH_RE = new RegExp(
  '/dist/(?:' +
  '(?:calcola-stipendio|calculate-salary|gehalt-berechnen|calculer-salaire)/[^/]+/index\\.html$' +
  '|' +
  '(?:en|de|fr)/(?:calcola-stipendio|calculate-salary|gehalt-berechnen|calculer-salaire)/[^/]+/index\\.html$' +
  ')',
);

const SEO_STATIC_RE = /<main\b[^>]*class=["'][^"']*\bseo-static-content\b/i;
// Thin/default placeholder H1 emitted by the `} else {` fallback branch.
// salary-landing shell uses `font-size:clamp(...)` so this exact string
// can only come from the default thin layout.
const THIN_H1_RE = /<h1\s+style="font-size:1\.25rem;font-weight:700;margin-bottom:\.5rem">/i;
// Empty calculator placeholder div from the default branch.
const PLACEHOLDER_DIV_RE = /<div\s+style="[^"]*;height:38rem;margin-top:1\.5rem"><\/div>/i;
// Legacy-redirect bridge detection: pages whose `<link rel="canonical">`
// points to a different URL than the page's own path are intentional
// redirects (handled by legacyRedirectsPlugin / shell helpers), NOT
// salary-landing templates. Same exclusion pattern used by
// audit-content-duplicates.mjs.
const CANONICAL_RE = /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i;

/**
 * @param {{ limit?: number }} [opts]
 * @returns {import('./lib/audit-runner.mjs').Auditor}
 */
export function createAuditor(opts = {}) {
  const limit = Math.max(1, opts.limit ?? 30);
  const offenders = [];
  let scanned = 0;

  return {
    name: 'salary-landing-template',
    collect(file, html) {
      // Normalize to a posix-style path so the regex matches on Windows too.
      const posixPath = file.replace(/\\/g, '/');
      if (!SALARY_LANDING_PATH_RE.test(posixPath)) return;

      // Skip legacy-redirect bridge pages. legacyRedirectsPlugin emits
      // ~10 historical-slug-bridge HTML pages at /calcola-stipendio/{old}/
      // whose canonical points to the new slug (`/calcola-stipendio/{new}/`)
      // or to a target outside the salary-calculator hub. These are
      // intentionally thin (meta-refresh + JS location.replace) — they're
      // NOT salary-landing templates and must not trigger this audit.
      //
      // Detection: parse the canonical href, compare to the page's own
      // URL path (derived from the file path). If they differ, skip.
      // Mirror pattern used by audit-content-duplicates.mjs.
      const canonicalMatch = html.match(CANONICAL_RE);
      if (canonicalMatch) {
        const canonicalHref = canonicalMatch[1].trim();
        // Convert canonical absolute URL to a normalized path
        const canonicalPath = canonicalHref
          .replace(/^https?:\/\/[^/]+/, '')
          .replace(/[?#].*$/, '')
          .replace(/\/$/, '') || '/';
        // Convert file path to URL path: dist/foo/bar/index.html → /foo/bar
        const ownPath = ('/' + relative(ROOT, file)
          .replace(/\\/g, '/')
          .replace(/^dist\//, '')
          .replace(/\/index\.html$/, '')
          .replace(/\.html$/, '')).replace(/\/$/, '') || '/';
        if (canonicalPath !== ownPath) return; // legacy redirect bridge, skip
      }

      scanned++;

      const reasons = [];
      if (!SEO_STATIC_RE.test(html)) reasons.push('missing <main class="seo-static-content">');
      if (THIN_H1_RE.test(html)) reasons.push('thin default H1 (font-size:1.25rem)');
      if (PLACEHOLDER_DIV_RE.test(html)) reasons.push('empty calculator placeholder (height:38rem)');

      if (reasons.length > 0) {
        offenders.push({ path: relative(ROOT, file), reasons });
      }
    },
    report() {
      const passed = offenders.length === 0;
      const humanSummary = passed
        ? `scanned ${scanned} salary-landing page(s) — all use buildSalaryLandingBody template`
        : `${offenders.length} of ${scanned} salary-landing page(s) ship the thin fallback layout`;
      return {
        passed,
        offendersTotal: offenders.length,
        offenders,
        threshold: { metric: 'thinSalaryLandings', value: 0, comparator: '<=' },
        extra: { scanned, limit },
        humanSummary,
      };
    },
  };
}

export const auditor = createAuditor();
export { createAuditor as factory };

async function standalone() {
  const args = process.argv.slice(2);
  const limit = (() => {
    const a = args.find((s) => s.startsWith('--limit='));
    return a ? Math.max(1, parseInt(a.split('=')[1], 10) || 30) : 30;
  })();

  const distStat = await stat(DEFAULT_DIST).catch(() => null);
  if (!distStat || !distStat.isDirectory()) {
    console.error(`audit-salary-landing-template: dist/ not found at ${DEFAULT_DIST}. Run a build first.`);
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

  console.log(`audit-salary-landing-template: ${result.humanSummary}`);
  if (result.passed) {
    console.log('PASS: every salary-landing page uses the mobile-first SEO template.');
    process.exit(0);
  }

  console.error(`\nFAIL: ${result.offendersTotal} salary-landing page(s) ship the thin fallback layout.`);
  console.error(`CLAUDE.md rule #17 requires every /{calcola-stipendio|calculate-salary|gehalt-berechnen|calculer-salaire}/*`);
  console.error(`scenario page to render through buildSalaryLandingBody() (eyebrow + H1 + lede + stat tiles + CTA + data area + long prose).`);
  console.error(`\nFirst ${Math.min(limit, result.offenders.length)} offenders:`);
  for (const o of result.offenders.slice(0, limit)) {
    console.error(`  ${o.path}`);
    for (const r of o.reasons) console.error(`    - ${r}`);
  }
  if (result.offenders.length > limit) console.error(`  ... and ${result.offenders.length - limit} more`);
  console.error(`\nHow to fix`);
  console.error(`----------`);
  console.error(`In build-plugins/staticPagesPlugin.ts, confirm both gates accept the locale prefix:`);
  console.error(`  - lookupStaticOverlayHubChrome() at line ~106`);
  console.error(`  - the salary-landing branch around line ~4145`);
  console.error(`In build-plugins/shared/salaryLandingShell.ts, confirm parseNetComparisonPath()`);
  console.error(`maps every locale variant (4 slugs × 4 locales = 16 entries).`);
  process.exit(1);
}

const invokedDirectly = (() => {
  try { return import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1]); }
  catch { return false; }
})();

if (invokedDirectly) {
  standalone().catch((err) => {
    console.error('audit-salary-landing-template: fatal', err);
    process.exit(2);
  });
}
