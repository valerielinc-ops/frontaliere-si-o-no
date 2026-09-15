import { describe, expect, it } from 'vitest';
import {
  renderPagination,
  buildThinCantonHubHtml,
  buildPaginationIndexHtml,
} from '../../build-plugins/seoHubsPlugin';
import {
  isSeoHubPath,
  paginationIndexCount,
  paginationIndexPath,
} from '../../build-plugins/seoHubsData';
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
  it('renderPagination replaces the unbounded page ladder with bounded range indexes', () => {
    const total = 2500;
    const basePath = '/cerca-lavoro-ticino/tutti/';
    const html = renderPagination('it', basePath, 1, total);

    // Page 1 links to the bounded set of range indexes, not to every archive
    // page. Each index page carries its own complete range of page links.
    expect(html).toContain(paginationIndexPath(basePath, 1));
    expect(html).toContain(paginationIndexPath(basePath, paginationIndexCount(total)));
    const directPages = new Set(
      [...html.matchAll(/tutti\/page-(\d+)\//g)].map((m) => Number(m[1])),
    );
    // The compact nav contributes only its first/last/next links on page 1.
    expect([...directPages].sort((a, b) => a - b)).toEqual([2, total]);
    expect(paginationIndexCount(total)).toBe(50);

    // The old repeated per-anchor word prefix remains absent.
    expect(html).not.toContain('Pagina&nbsp;');
    expect(html).not.toContain('Seite&nbsp;');
    expect(html).not.toContain('Page&nbsp;');
    // Index labels carry the range context; the page-1 payload has no middle
    // page URL and keeps the existing container styling.
    expect(html).toContain('Pagine 1–50');
    expect(html).not.toContain(`${basePath}page-1200/`);
    expect(html).toContain('<div class="s-6_t7LY hpl">');
    expect(html).not.toContain('class="hp"');
  });

  it('keeps bounded page-1 navigation and compact deep-page navigation', () => {
    const total = 2500;
    const first = renderPagination('it', '/cerca-lavoro-ticino/tutti/', 1, total);
    const inner = renderPagination('it', '/cerca-lavoro-ticino/tutti/', 1200, total);

    expect(first).toContain(paginationIndexPath('/cerca-lavoro-ticino/tutti/', 1));
    expect(inner).not.toContain('s-4nYHgH');
    // The compact window still chains the archive for humans and prev/next;
    // the deep page does not repeat the index list.
    for (const frag of ['page-1199/', 'page-1201/', 'page-2500/', 'rel="prev"', 'rel="next"']) {
      expect(inner).toContain(frag);
    }
    expect(Buffer.byteLength(first)).toBeGreaterThan(Buffer.byteLength(inner));
    expect(Buffer.byteLength(first)).toBeLessThan(10000);
  });

  it('emits crawlable index pages with a complete range and index-chain links', () => {
    const basePath = '/cerca-lavoro-ticino/tutti/';
    const html = buildPaginationIndexHtml({
      locale: 'it',
      basePath,
      indexPage: 2,
      totalPages: 400,
      totalItems: 40000,
      archiveTitle: 'Tutti gli annunci di lavoro',
      archiveDescription: 'Archivio completo delle offerte di lavoro.',
      parentPath: '/cerca-lavoro-ticino/',
      parentLabel: 'Cerca lavoro in Ticino',
      dateStamp: '2026-09-06',
    });

    expect(html).toMatch(/<link rel=canonical href="?https:\/\/frontaliereticino\.ch\/cerca-lavoro-ticino\/tutti\/page-index-2\/"?>/);
    expect(html).toMatch(/<link rel=prev href="?https:\/\/frontaliereticino\.ch\/cerca-lavoro-ticino\/tutti\/page-index-1\/"?>/);
    expect(html).toMatch(/<link rel=next href="?https:\/\/frontaliereticino\.ch\/cerca-lavoro-ticino\/tutti\/page-index-3\/"?>/);
    expect(html).toContain(`${basePath}page-21/`);
    expect(html).toContain(`${basePath}page-40/`);
    expect(html).not.toContain(`${basePath}page-20/`);
    expect(html).not.toContain(`${basePath}page-41/`);
    expect(html).toContain('"@type":"CollectionPage"');
    expect(html).not.toContain('noindex');
  });

  it('routes emitted page indexes but not article indexes', () => {
    expect(isSeoHubPath('/cerca-lavoro-ticino/tutti/page-index-1/')).toBe(true);
    expect(isSeoHubPath('/cerca-lavoro-ticino/tutti/page-1200/')).toBe(true);
    expect(isSeoHubPath('/articoli-frontaliere/tutti/page-index-1/')).toBe(false);
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

  it('buildThinCantonHubHtml uses the same bounded range indexes', () => {
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
    expect(html).toContain('/cerca-lavoro-argovia/tutti/page-index-1/');
    expect(html).toContain('/cerca-lavoro-argovia/tutti/page-index-20/');
    expect(html).toContain('Pagine 381–400');
    expect(html).not.toContain('/cerca-lavoro-argovia/tutti/page-400/');
    expect(html).toContain('<div class="s-6_t7LY hpl">');
    expect(html).not.toContain('class="thp"');
  });

  it('buildThinCantonHubHtml keeps compact prev/next links on deep pages', () => {
    const totalPages = 400;
    const mk = (page: number) => buildThinCantonHubHtml({
      locale: 'it', hub: 'tutti', canton: 'argovia', cantonLabel: 'Argovia',
      basePath: '/cerca-lavoro-argovia/tutti/', totalItems: 40000,
      items: [{ href: '/cerca-lavoro-argovia/x/', label: 'Ruolo', sub: 'Aarau' }],
      hasSpaBundle: false, entryJs: '', entryCss: '', dateStamp: '2026-09-06',
      page, totalPages,
    });
    const inner = mk(200);

    const laddered = (html: string) =>
      new Set([...html.matchAll(/cerca-lavoro-argovia\/tutti\/page-(\d+)\//g)].map((m) => Number(m[1])));
    const first = mk(1);
    // Page 1 carries only the bounded index links; its compact next hint
    // still points to page 2.
    expect([...laddered(first)]).toEqual([2]);
    expect(first).toContain('/cerca-lavoro-argovia/tutti/page-index-20/');
    expect(first).toContain('Sfoglia tutte le pagine (400)');
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
