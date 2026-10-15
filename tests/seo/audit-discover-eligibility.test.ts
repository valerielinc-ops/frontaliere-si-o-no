// @vitest-environment node
/**
 * Unit tests for `scripts/audit-discover-eligibility.mjs` (issue #5001).
 *
 * Drives the exported pure functions rather than materialising a dist/ tree,
 * matching the convention in `tests/seo/audit-no-literal-markdown.test.ts`.
 *
 * The load-bearing assertion here is the LAST one: the auditor must report
 * `passed: true` even with offenders. That is not a rubber stamp, it is the
 * contract — a red `validate-dist` skips the `publish` job (IndexNow, Google
 * Indexing API, GSC sync), so an audit that can fail on day one costs more
 * indexation than it wins. Anything that changes this must be a deliberate
 * per-check promotion, and this test is what makes that visible.
 */
import { describe, expect, it } from 'vitest';

import {
  createAuditor,
  evaluatePage,
  pageFamily,
  LARGE_CARD_MIN_WIDTH,
} from '../../scripts/audit-discover-eligibility.mjs';

const head = (robots: string, extra = '') =>
  `<html><head><meta name="robots" content="${robots}">` +
  `<link rel="canonical" href="https://frontaliereticino.ch/x/">${extra}</head>`;

const GOOD =
  head('index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1') +
  '<body><h1>Titolo</h1><img src="/a.webp" width="1200" height="675" alt="a"></body></html>';

describe('evaluatePage', () => {
  it('passes every check on a fully Discover-eligible page', () => {
    const r = evaluatePage(GOOD);
    expect(r.indexable).toBe(true);
    expect(r.checks).toEqual({
      maxImagePreviewLarge: true,
      singleH1: true,
      canonical: true,
      largeImage: true,
    });
    expect(r.widestImage).toBe(1200);
  });

  it('catches the exact defect measured on 50 of 83 live families', () => {
    const r = evaluatePage(head('index,follow') + '<body><h1>T</h1></body></html>');
    expect(r.indexable).toBe(true);
    expect(r.checks.maxImagePreviewLarge).toBe(false);
  });

  it('treats noindex and meta-refresh pages as outside Discover', () => {
    expect(evaluatePage(head('noindex,follow') + '<body><h1>T</h1></body>').indexable).toBe(false);
    expect(
      evaluatePage('<html><head><meta http-equiv="refresh" content="0;url=/x/"></head></html>').indexable,
    ).toBe(false);
  });

  it('requires EXACTLY one h1 — zero is a failure too', () => {
    expect(evaluatePage(head('index, follow, max-image-preview:large') + '<body><p>no headline</p></body>').checks.singleH1).toBe(false);
    expect(
      evaluatePage(head('index, follow, max-image-preview:large') + '<body><h1>a</h1><h1>b</h1></body>').checks.singleH1,
    ).toBe(false);
  });

  it('does not count an h1 that lives in a comment, template, script or style', () => {
    const html =
      head('index, follow, max-image-preview:large') +
      '<body><h1>real</h1><!-- <h1>commented</h1> --><template><h1>tpl</h1></template>' +
      '<script>var s = "<h1>js</h1>";</script><style>/* <h1>css</h1> */</style></body>';
    expect(evaluatePage(html).checks.singleH1).toBe(true);
  });

  it('flags a missing canonical', () => {
    const html = '<html><head><meta name="robots" content="index, follow, max-image-preview:large"></head><body><h1>T</h1></body>';
    expect(evaluatePage(html).checks.canonical).toBe(false);
  });

  it('reads the widest DECLARED image width, ignoring undeclared images', () => {
    const html =
      head('index, follow, max-image-preview:large') +
      '<body><h1>T</h1><img src="/small.webp" width="320" height="180" alt="s">' +
      '<img src="/big.webp" width="1600" height="900" alt="b"><img src="/nodims.webp" alt="n"></body>';
    const r = evaluatePage(html);
    expect(r.widestImage).toBe(1600);
    expect(r.checks.largeImage).toBe(true);
  });

  it('fails the large-card check just below the Google floor', () => {
    const html =
      head('index, follow, max-image-preview:large') +
      `<body><h1>T</h1><img src="/a.webp" width="${LARGE_CARD_MIN_WIDTH - 1}" height="600" alt="a"></body>`;
    expect(evaluatePage(html).checks.largeImage).toBe(false);
  });

  it('treats a page with max-image-preview:large but zero images as not large-card ready', () => {
    // The #5101 defect verbatim: the directive raises the CAP on preview size,
    // it does not supply an image.
    const r = evaluatePage(head('index, follow, max-image-preview:large') + '<body><h1>T</h1></body>');
    expect(r.checks.maxImagePreviewLarge).toBe(true);
    expect(r.checks.largeImage).toBe(false);
  });
});

describe('pageFamily', () => {
  it('buckets by generator namespace, ignoring the locale prefix', () => {
    expect(pageFamily('articoli-frontaliere/lamal-vs-cmi/index.html')).toBe('articoli-frontaliere');
    expect(pageFamily('en/find-jobs-ticino/nurse/index.html')).toBe('find-jobs-ticino');
    expect(pageFamily('de/haeufige-fragen/index.html')).toBe('haeufige-fragen');
    expect(pageFamily('index.html')).toBe('(root)');
  });
});

describe('the auditor aggregates per family and stays report-only', () => {
  it('counts indexable pages per family and skips noindex ones', () => {
    const a = createAuditor({ distDir: '/repo/dist' });
    a.collect('/repo/dist/comuni/a/index.html', GOOD);
    a.collect('/repo/dist/comuni/b/index.html', head('index,follow') + '<body><h1>T</h1></body>');
    a.collect('/repo/dist/comuni/c/index.html', head('noindex,follow') + '<body><h1>T</h1></body>');

    const r = a.report();
    const comuni = r.families.find((f: { family: string }) => f.family === 'comuni');
    expect(comuni.indexable).toBe(2);
    expect(comuni.maxImagePreviewLarge).toBe(1);
    expect(r.extra.indexable).toBe(2);
    expect(r.extra.scanned).toBe(3);
  });

  it('reports offenders with the failed check names and the owning family', () => {
    const a = createAuditor({ distDir: '/repo/dist' });
    a.collect('/repo/dist/meteo-frontalieri/lugano/index.html', head('index,follow') + '<body><h1>T</h1></body>');
    const r = a.report();
    expect(r.offendersTotal).toBe(1);
    expect(r.offenders[0]).toMatchObject({
      path: 'meteo-frontalieri/lugano/index.html',
      feature: 'meteo-frontalieri',
      failed: ['maxImagePreviewLarge'],
    });
    expect(r.byFeature).toEqual({ 'meteo-frontalieri': 1 });
  });

  it('NEVER reports passed:false — a red validate-dist skips the publish job', () => {
    const a = createAuditor({ distDir: '/repo/dist' });
    for (let i = 0; i < 5; i++) {
      a.collect(`/repo/dist/x/${i}/index.html`, head('index,follow') + '<body></body>');
    }
    const r = a.report();
    expect(r.offendersTotal).toBe(5);
    expect(r.passed).toBe(true);
    expect(r.extra.reportOnly).toBe(true);
  });

  it('caps the offender list so the JSON report stays small', () => {
    const a = createAuditor({ distDir: '/repo/dist', limit: 3 });
    for (let i = 0; i < 20; i++) {
      a.collect(`/repo/dist/x/${i}/index.html`, head('index,follow') + '<body></body>');
    }
    const r = a.report();
    expect(r.offenders).toHaveLength(3);
    expect(r.offendersTotal).toBe(20);
  });
});
