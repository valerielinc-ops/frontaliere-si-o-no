import { describe, expect, it } from 'vitest';
import { createAuditor } from '../../scripts/audit-no-literal-markdown.mjs';
import { ROOT } from '../../scripts/lib/audit-runner.mjs';
import { minifyHtml } from '../../build-plugins/shared/htmlMinify';

const JOB_PATH = `${ROOT}/dist/cerca-lavoro-ticino/sviluppatore-acme/index.html`;

describe('audit-no-literal-markdown', () => {
  it('scans minified unquoted seo-static-content shells', () => {
    const html = minifyHtml(`<!doctype html><html><body>
      <main class="seo-static-content"><h1>Offerta</h1><p>Testo **non convertito**</p></main>
    </body></html>`);
    expect(html).toContain('class=seo-static-content');

    const audit = createAuditor();
    audit.collect(JOB_PATH, html);
    const report = audit.report();

    expect(report.passed).toBe(false);
    expect(report.offendersTotal).toBe(1);
    expect(report.offenders[0].literalBoldSamples).toEqual(['**non convertito**']);
  });

  it('does not flag === / runs inside inline <script> as literal markdown', () => {
    // The per-card logo fallback script (jcLF) carries JS strict-equality
    // `===` runs; these are code, not visible markdown separators, and must
    // not trip the separator gate.
    const html = minifyHtml(`<!doctype html><html><body>
      <main class="seo-static-content"><h1>Offerta</h1><p>Testo regolare</p>
      <script>function jcLF(c){var w=c.split(' ').filter(Boolean);return w.length===0?'?':w.length===1?w[0].slice(0,2):w[0][0]+w[1][0]}</script>
      </main>
    </body></html>`);

    const audit = createAuditor();
    audit.collect(JOB_PATH, html);
    const report = audit.report();

    expect(report.passed).toBe(true);
    expect(report.offendersTotal).toBe(0);
  });
});
