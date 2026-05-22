/**
 * expired-job-prose-marker.test.ts
 *
 * Verifies that the text-html-ratio auditor skips pages carrying the
 * `<!--ejp-stripped-->` marker emitted by jobsSeoPagesPlugin when the
 * STRIP_EXPIRED_JOB_PROSE flag is on (default). Those pages have their
 * SEO prose deliberately removed to keep dist under the 10 GB GitHub
 * Pages limit; their low text/HTML ratio is by design, so they must
 * not be counted as offenders.
 */

import { describe, expect, it } from 'vitest';
// @ts-expect-error: importing from an .mjs script with no .d.ts
import { createAuditor } from '../../scripts/audit-text-html-ratio.mjs';

const STRIPPED_PAGE = `<!doctype html><html><head>
<title>Job — expired</title></head><body>
<h1>Foo Engineer — Acme</h1>
<p><strong>Questa posizione non è più attiva.</strong></p>
<section><h2>Dettaglio</h2><p>slug bla bla</p></section>
<!--ejp-stripped-->
</body></html>`;

// Low text/HTML ratio (~5% — well below the 10% gate) so the page WOULD be
// flagged if the marker were ignored.
const LOW_RATIO_NO_MARKER = `<!doctype html><html><head>
<title>X</title></head><body><h1>Y</h1>${'<div></div>'.repeat(2000)}</body></html>`;

describe('audit-text-html-ratio — STRIP_EXPIRED_JOB_PROSE marker', () => {
  it('skips pages with <!--ejp-stripped--> marker (no offender, no sample)', async () => {
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
});
