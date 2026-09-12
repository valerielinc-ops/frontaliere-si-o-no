import { describe, expect, it } from 'vitest';
import {
  renderPagination,
  buildThinCantonHubHtml,
} from '../../build-plugins/seoHubsPlugin';
import { createAuditor } from '../../scripts/audit-no-literal-markdown.mjs';
import { ROOT } from '../../scripts/lib/audit-runner.mjs';
import { minifyHtml } from '../../build-plugins/shared/htmlMinify';
import { SCAN_TEST_TIMEOUT_MS } from '../helpers/distHtmlScan';

// Regression for post-deploy validate-dist run 29330607996 (issue #4060),
// audit:all failing sub-audits:
//   1) audit:no-literal-markdown — a crawled Stadtspital-Zürich job title
//      `Assistenzärzt*in Medizinische Onkologie___Ärzte-DIM-Onkologie` leaked
//      the literal `___` separator into the Zurich `/tutti/` hub listing
//      (the compact `.thi` / `.s-7DS5hj` lists bypassed the card renderer's
//      stripLiteralMarkdown), tripping the 0-tolerance gate.
//   2) audit:page-weight — the `/cerca-lavoro-ticino/tutti/` full pagination
//      ladder (every page-N anchor, load-bearing for BFS-depth) carried a
//      repeated `Pagina&nbsp;`/`Seite&nbsp;`/`Page&nbsp;` word prefix that at
//      ~2 200 archive pages pushed the HTML back over the 215 KB budget.

const JOB_BOARD_PATH = `${ROOT}/dist/cerca-lavoro-zurigo/tutti/index.html`;

const DIRTY_TITLE = 'Assistenzärzt*in Medizinische Onkologie___Ärzte-DIM-Onkologie';

describe('seoHubs — no literal markdown leaks into hub listings', () => {
  it('strips separator runs / bold tokens from tutti-hub item titles', { timeout: SCAN_TEST_TIMEOUT_MS }, () => {
    const html = buildThinCantonHubHtml({
      locale: 'de',
      hub: 'tutti',
      canton: 'zurigo',
      cantonLabel: 'Zürich',
      basePath: '/cerca-lavoro-zurigo/tutti/',
      totalItems: 3,
      items: [
        { href: '/cerca-lavoro-zurigo/onkologie-stadtspital-zurich/', label: DIRTY_TITLE, sub: 'Zürich' },
        { href: '/cerca-lavoro-zurigo/leiter-finanzen/', label: 'Leiter **Finanzen** === Abteilung', sub: 'Zürich' },
        { href: '/cerca-lavoro-zurigo/pflege/', label: 'Pflegefachperson', sub: 'Winterthur' },
      ],
      hasSpaBundle: false,
      entryJs: '',
      entryCss: '',
      dateStamp: '2026-07-14',
    });

    // The audit only scans the minified, quote-flexible shell.
    const minified = minifyHtml(html);
    const audit = createAuditor();
    audit.collect(JOB_BOARD_PATH, minified);
    const report = audit.report();

    expect(report.passed).toBe(true);
    expect(report.offendersTotal).toBe(0);
    // Sanity: the raw markdown tokens are gone from the rendered listing.
    expect(html).not.toContain('___');
    expect(html).not.toMatch(/\*\*[^*\n]+\*\*/);
    // The visible words survive the scrub (only the markdown noise is removed).
    expect(html).toContain('Medizinische Onkologie');
  });
});

describe('seoHubs — pagination ladder page-weight byte-shave', () => {
  it('renderPagination keeps every page-N anchor (BFS) but drops the word prefix', () => {
    const total = 2500;
    const html = renderPagination('it', '/cerca-lavoro-ticino/tutti/', 1, total);

    // BFS-depth closure: the full flat ladder must still link every page.
    expect(html).toContain('/cerca-lavoro-ticino/tutti/page-2/');
    expect(html).toContain(`/cerca-lavoro-ticino/tutti/page-${total}/`);
    const linkedPages = new Set(
      [...html.matchAll(/tutti\/page-(\d+)\//g)].map((m) => Number(m[1])),
    );
    // page-1 is the basePath (not `/page-1/`), so 2..2500 == 2499 distinct.
    expect(linkedPages.size).toBe(total - 1);

    // The repeated per-anchor word prefix is gone (this is the byte-shave).
    expect(html).not.toContain('Pagina&nbsp;');
    expect(html).not.toContain('Seite&nbsp;');
    expect(html).not.toContain('Page&nbsp;');
    // Bare-number anchors, and no per-anchor class either: the chip styling
    // moved onto the `.hpl` container (issue #7662), which is the largest
    // remaining byte-shave on this ladder (13 B x every anchor).
    expect(html).toMatch(/<a href="\/cerca-lavoro-ticino\/tutti\/page-2500\/">2500<\/a>/);
    expect(html).toContain('<div class="s-6_t7LY hpl">');
    expect(html).not.toContain('class="hp"');
  });

  it('renderPagination ships the flat ladder on page-1 only (O(total) instead of O(total^2))', () => {
    // Issue #7662: the ladder is O(total) bytes, so emitting it on all `total`
    // pages made the archive O(total^2) HTML and put 885
    // /cerca-lavoro-ticino/tutti/page-N/ files at 282-284 KB against the
    // 260 KB audit:page-weight budget. BFS depth is unaffected: page-1 is the
    // only entry point the parent hubs link, so page-N already took its
    // minimum depth from page-1's ladder.
    const total = 2500;
    const first = renderPagination('it', '/cerca-lavoro-ticino/tutti/', 1, total);
    const inner = renderPagination('it', '/cerca-lavoro-ticino/tutti/', 1200, total);

    expect(first).toContain('s-4nYHgH');
    expect(inner).not.toContain('s-4nYHgH');
    // The compact window still chains the archive for humans and prev/next.
    for (const frag of ['page-1199/', 'page-1201/', 'page-2500/', 'rel="prev"', 'rel="next"']) {
      expect(inner).toContain(frag);
    }
    expect(Buffer.byteLength(inner)).toBeLessThan(Buffer.byteLength(first) / 50);
  });

  it('visible breadcrumb links the hub (not a dead span) so page-N can pass equity to the root', () => {
    const html = buildThinCantonHubHtml({
      locale: 'it',
      hub: 'tutti',
      canton: 'ticino',
      cantonLabel: 'Ticino',
      basePath: '/cerca-lavoro-ticino/tutti/',
      totalItems: 40000,
      items: [{ href: '/cerca-lavoro-ticino/x/', label: 'Ruolo', sub: 'Lugano' }],
      hasSpaBundle: false,
      entryJs: '',
      entryCss: '',
      dateStamp: '2026-08-25',
      page: 2,
      totalPages: 400,
    });
    expect(html).toMatch(
      /<nav class="s-AxRVCF" aria-label="Breadcrumb">[\s\S]*<a class="s-wfUMYx" href="\/cerca-lavoro-ticino\/tutti\/">/,
    );
    expect(html).not.toMatch(
      /<nav class="s-AxRVCF" aria-label="Breadcrumb">[\s\S]*<span>Ticino · /,
    );
    expect(html).toContain('"position":2');
    expect(html).toContain('/cerca-lavoro-ticino/tutti/');
    expect(html).toContain('"position":3');
  });

  it('buildThinCantonHubHtml ladder is shaved in lockstep (CLAUDE.md #6)', () => {
    const totalPages = 400;
    const html = buildThinCantonHubHtml({
      locale: 'it',
      hub: 'tutti',
      canton: 'argovia',
      cantonLabel: 'Argovia',
      basePath: '/cerca-lavoro-argovia/tutti/',
      totalItems: 40000,
      items: [{ href: '/cerca-lavoro-argovia/x/', label: 'Ruolo', sub: 'Aarau' }],
      hasSpaBundle: false,
      entryJs: '',
      entryCss: '',
      dateStamp: '2026-07-14',
      page: 1,
      totalPages,
    });
    expect(html).not.toContain('Pagina&nbsp;');
    expect(html).toContain('/cerca-lavoro-argovia/tutti/page-400/');
    expect(html).toMatch(/<a href="\/cerca-lavoro-argovia\/tutti\/page-400\/">400<\/a>/);
    expect(html).toContain('<div class="s-6_t7LY hpl">');
    expect(html).not.toContain('class="thp"');
  });

  it('buildThinCantonHubHtml keeps a compact window on page 1 and page N (#8016)', () => {
    const totalPages = 400;
    const mk = (page: number) => buildThinCantonHubHtml({
      locale: 'it', hub: 'tutti', canton: 'argovia', cantonLabel: 'Argovia',
      basePath: '/cerca-lavoro-argovia/tutti/', totalItems: 40000,
      items: [{ href: '/cerca-lavoro-argovia/x/', label: 'Ruolo', sub: 'Aarau' }],
      hasSpaBundle: false, entryJs: '', entryCss: '', dateStamp: '2026-09-06',
      page, totalPages,
    });
    const first = mk(1);
    const inner = mk(200);

    const laddered = (html: string) =>
      new Set([...html.matchAll(/cerca-lavoro-argovia\/tutti\/page-(\d+)\//g)].map((m) => Number(m[1])));
    // Both page-1 and page-N keep only the compact window: 1 / current +/- 1 / last.
    expect([...laddered(first)].sort((a, b) => a - b)).toEqual([2, 400]);
    // 200 is page-200's own canonical/og:url, not a ladder anchor (the current
    // page renders as a bare <strong>, so the ladder itself links 199/201/400
    // plus the basePath for page-1).
    expect([...laddered(inner)].sort((a, b) => a - b)).toEqual([199, 200, 201, 400]);
    expect(inner).toContain('<a href="/cerca-lavoro-argovia/tutti/page-199/" rel="prev">199</a>');
    expect(inner).toContain('<a href="/cerca-lavoro-argovia/tutti/page-201/" rel="next">201</a>');
    expect(inner).toContain('/cerca-lavoro-argovia/tutti/');
    const pagination = (html: string) => html.match(/<nav class="s-ay7Grc"[\s\S]*?<\/nav>/)?.[0] ?? '';
    expect(Buffer.byteLength(pagination(first))).toBeLessThan(2000);
    expect(Buffer.byteLength(pagination(inner))).toBeLessThan(2000);
  });

  it('keeps head and body prev/next URLs identical on page 2', () => {
    const basePath = '/cerca-lavoro-argovia/tutti/';
    const html = buildThinCantonHubHtml({
      locale: 'it', hub: 'tutti', canton: 'argovia', cantonLabel: 'Argovia',
      basePath, totalItems: 40000,
      items: [{ href: '/cerca-lavoro-argovia/x/', label: 'Ruolo', sub: 'Aarau' }],
      hasSpaBundle: false, entryJs: '', entryCss: '', dateStamp: '2026-09-06',
      page: 2, totalPages: 400,
    });
    const headPrev = html.match(/<link rel="prev" href="([^"]+)">/)?.[1];
    const bodyPrev = html.match(/<a href="([^"]+)" rel="prev">1<\/a>/)?.[1];
    const headNext = html.match(/<link rel="next" href="([^"]+)">/)?.[1];
    const bodyNext = html.match(/<a href="([^"]+)" rel="next">3<\/a>/)?.[1];

    expect(headPrev).toBe(`https://frontaliereticino.ch${basePath}`);
    expect(bodyPrev).toBe(basePath);
    expect(headNext).toBe(`https://frontaliereticino.ch${basePath}page-3/`);
    expect(bodyNext).toBe(`${basePath}page-3/`);
  });
});
