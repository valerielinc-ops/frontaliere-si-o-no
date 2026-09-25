/**
 * expired-job-prose-marker.test.ts
 *
 * Verifies that the text-html-ratio auditor skips pages carrying the
 * `<!--EJP_STRIPPED-->` marker emitted when prose is intentionally
 * stripped via one of:
 *   - STRIP_EXPIRED_JOB_PROSE (default ON, soft-landing job pages)
 *   - STRIP_ACTIVE_JOB_PROSE  (default OFF, opt-in for active job-detail)
 *   - STRIP_BRIDGE_PAGE_PROSE (default ON, slug-rename / legacy alias bridges)
 *
 * In all three cases the page's low text/HTML ratio is by design (dist
 * shrinkage toward the 10 GB GitHub Pages cap), so it must not count as
 * an offender against the Semrush gate.
 */

import { describe, expect, it } from 'vitest';
// @ts-ignore: importing from an .mjs script with no .d.ts (works at runtime via vitest)
import { createAuditor } from '../../scripts/audit-text-html-ratio.mjs';
import { minifyHtml } from '../../build-plugins/shared/htmlMinify';

const STRIPPED_PAGE = `<!doctype html><html><head>
<title>Job — expired</title></head><body>
<h1>Foo Engineer — Acme</h1>
<p><strong>Questa posizione non è più attiva.</strong></p>
<section><h2>Dettaglio</h2><p>slug bla bla</p></section>
<!--EJP_STRIPPED-->
</body></html>`;

// Low text/HTML ratio (~5% — well below the 10% gate) so the page WOULD be
// flagged if the marker were ignored.
const LOW_RATIO_NO_MARKER = `<!doctype html><html><head>
<title>X</title></head><body><h1>Y</h1>${'<div></div>'.repeat(2000)}</body></html>`;

describe('audit-text-html-ratio — STRIP_EXPIRED_JOB_PROSE marker', () => {
  it('skips pages with <!--EJP_STRIPPED--> marker (no offender, no sample)', async () => {
    const a = createAuditor({ threshold: 10, failOnOffenders: true });
    a.collect('dist/cerca-lavoro-ticino/foo-acme/index.html', STRIPPED_PAGE);
    const r = await a.report();
    expect(r.offendersTotal).toBe(0);
    expect(r.extra.skippedEjpStripped).toBe(1);
    expect(r.extra.scanned).toBe(0);
  });

  it('still flags low-ratio pages without the marker (regression guard)', async () => {
    const a = createAuditor({ threshold: 10, failOnOffenders: true });
    a.collect('dist/spa-other/index.html', LOW_RATIO_NO_MARKER);
    const r = await a.report();
    expect(r.offendersTotal).toBe(1);
    expect(r.extra.skippedEjpStripped).toBe(0);
  });

  // Regression guard for the lowercase-marker bug: htmlMinify.ts strips
  // generic <!--…--> comments and only preserves <!--[A-Z][A-Z0-9_]*-->.
  // A lowercase marker silently disappears after minification — the audit
  // can never skip the stripped page, and bridge/expired/active pages
  // re-emerge as offenders (see validate-dist run 26283889992).
  it('marker survives htmlMinify (placeholder-comment preservation)', () => {
    const minified = minifyHtml(STRIPPED_PAGE);
    expect(minified).toContain('<!--EJP_STRIPPED-->');
  });

  it('audit still skips a stripped page AFTER it has been minified', async () => {
    const a = createAuditor({ threshold: 10, failOnOffenders: true });
    a.collect('dist/cerca-lavoro-ticino/foo-acme/index.html', minifyHtml(STRIPPED_PAGE));
    const r = await a.report();
    expect(r.offendersTotal).toBe(0);
    expect(r.extra.skippedEjpStripped).toBe(1);
  });
});
