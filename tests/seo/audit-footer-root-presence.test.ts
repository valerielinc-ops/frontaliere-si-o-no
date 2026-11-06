/**
 * Unit tests for scripts/audit-footer-root-presence.mjs.
 *
 * Covers both zero-tolerance rules guarded by the audit:
 *   1. `missing-footer-root` — seo-static-content shell without footer-root.
 *   2. `static-job-page-inside-root` — legacy buildSimplePage shell that
 *      blank-on-hydrates because React wipes the static <main> inside #root.
 *
 * The auditor is exercised in-process via its factory (no fs walk needed);
 * each test feeds a synthetic HTML payload through `collect()` and asserts
 * the shape of `report()`.
 */
import { describe, expect, it } from 'vitest';
import * as auditorModule from '../../scripts/audit-footer-root-presence.mjs';
import { minifyHtml } from '../../build-plugins/shared/htmlMinify';

interface Offender {
  path: string;
  feature: string;
  kind: 'missing-footer-root' | 'static-job-page-inside-root';
}

interface AuditReport {
  passed: boolean;
  offendersTotal: number;
  offenders: Offender[];
  threshold: { metric: string; value: number; comparator: string };
  extra: {
    scannedSeoStatic: number;
    scannedStaticJob: number;
    missingFooter: number;
    insideRoot: number;
    limit: number;
  };
  humanSummary: string;
}

interface Auditor {
  name: string;
  collect: (file: string, html: string) => void;
  report: () => AuditReport;
}

const { createAuditor } = auditorModule as unknown as {
  createAuditor: (opts?: { limit?: number }) => Auditor;
};

const SAFE_SHELL = `
<!doctype html><html><body class="theme">
<main class="seo-static-content"><h1>OK</h1></main>
<div id="root"></div>
<div id="footer-root"></div>
</body></html>`;

const MISSING_FOOTER_ROOT = `
<!doctype html><html><body class="theme">
<main class="seo-static-content"><h1>oops</h1></main>
<div id="root"></div>
</body></html>`;

const LEGACY_STATIC_JOB_PAGE = `
<!doctype html><html><body class="theme">
<div id="root">
  <main class="static-job-page"><h1>blank-on-hydrate</h1></main>
</div>
<div id="footer-root"></div>
</body></html>`;

describe('audit-footer-root-presence', () => {
  it('passes for shells with seo-static-content + footer-root', () => {
    const a = createAuditor();
    a.collect('/dist/cerca-lavoro-zurigo/zurich/index.html', SAFE_SHELL);
    const r = a.report();
    expect(r.passed).toBe(true);
    expect(r.offendersTotal).toBe(0);
    expect(r.extra.scannedSeoStatic).toBe(1);
    expect(r.extra.scannedStaticJob).toBe(0);
  });

  it('accepts minified unquoted seo-static-content class attributes', () => {
    const a = createAuditor();
    const minified = minifyHtml(SAFE_SHELL);
    expect(minified).toContain('class=seo-static-content');
    expect(minified).toContain('id=footer-root');
    a.collect('/dist/fr/calculer-salaire/simuler-fiche-de-paie/index.html', minified);
    const r = a.report();
    expect(r.passed).toBe(true);
    expect(r.offendersTotal).toBe(0);
    expect(r.extra.scannedSeoStatic).toBe(1);
  });

  it('flags seo-static-content pages missing footer-root', () => {
    const a = createAuditor();
    a.collect('/dist/calcola-stipendio/lugano/index.html', MISSING_FOOTER_ROOT);
    const r = a.report();
    expect(r.passed).toBe(false);
    expect(r.offendersTotal).toBe(1);
    expect(r.offenders[0].kind).toBe('missing-footer-root');
    expect(r.extra.missingFooter).toBe(1);
    expect(r.extra.insideRoot).toBe(0);
  });

  it('flags the legacy <div id="root"><main class="static-job-page"> shell', () => {
    // Regression for PR #420 — buildSimplePage default mode emits this shape
    // and SPA users see a blank page after React hydrates #root.
    const a = createAuditor();
    a.collect('/dist/cerca-lavoro-ticino/pagina-2/index.html', LEGACY_STATIC_JOB_PAGE);
    const r = a.report();
    expect(r.passed).toBe(false);
    expect(r.offendersTotal).toBe(1);
    expect(r.offenders[0].kind).toBe('static-job-page-inside-root');
    expect(r.extra.insideRoot).toBe(1);
    expect(r.extra.missingFooter).toBe(0);
  });

  it('flags the minified legacy <div id=root><main class=static-job-page> shell', () => {
    const a = createAuditor();
    const minified = minifyHtml(LEGACY_STATIC_JOB_PAGE);
    expect(minified).toContain('id=root');
    expect(minified).toContain('class=static-job-page');
    a.collect('/dist/cerca-lavoro-ticino/pagina-2/index.html', minified);
    const r = a.report();
    expect(r.passed).toBe(false);
    expect(r.offendersTotal).toBe(1);
    expect(r.offenders[0].kind).toBe('static-job-page-inside-root');
  });

  it('accumulates offenders across files and preserves per-file kind', () => {
    const a = createAuditor();
    a.collect('/dist/ok/index.html', SAFE_SHELL);
    a.collect('/dist/missing/index.html', MISSING_FOOTER_ROOT);
    a.collect('/dist/legacy/index.html', LEGACY_STATIC_JOB_PAGE);
    const r = a.report();
    expect(r.passed).toBe(false);
    expect(r.offendersTotal).toBe(2);
    const kinds = r.offenders.map((o) => o.kind).sort();
    expect(kinds).toEqual(['missing-footer-root', 'static-job-page-inside-root']);
    expect(r.extra.scannedSeoStatic).toBe(2);
    expect(r.extra.scannedStaticJob).toBe(1);
  });

  it('does not match static-job-page outside #root (defensive boundary)', () => {
    // A page where <main class="static-job-page"> appears as a sibling of
    // #root (no longer reachable in current code, but the regex must stay
    // anchored to the buggy shape to avoid false positives if someone
    // intentionally renders the class elsewhere).
    const a = createAuditor();
    a.collect(
      '/dist/edge/index.html',
      `<!doctype html><html><body>
        <div id="root"></div>
        <main class="static-job-page"><h1>outside</h1></main>
        <div id="footer-root"></div>
      </body></html>`,
    );
    const r = a.report();
    expect(r.passed).toBe(true);
    expect(r.extra.scannedStaticJob).toBe(0);
  });

  it('produces a fresh closure per factory call (no cross-run state)', () => {
    const a1 = createAuditor();
    a1.collect('/dist/a/index.html', MISSING_FOOTER_ROOT);
    expect(a1.report().offendersTotal).toBe(1);
    const a2 = createAuditor();
    expect(a2.report().offendersTotal).toBe(0);
  });
});
