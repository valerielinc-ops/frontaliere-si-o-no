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
});
