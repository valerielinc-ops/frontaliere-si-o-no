import { describe, expect, it } from 'vitest';
import {
  renderPagination,
  buildThinCantonHubHtml,
} from '../../build-plugins/seoHubsPlugin';
import { createAuditor } from '../../scripts/audit-no-literal-markdown.mjs';
import { ROOT } from '../../scripts/lib/audit-runner.mjs';
import { minifyHtml } from '../../build-plugins/shared/htmlMinify';

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
  it('strips separator runs / bold tokens from tutti-hub item titles', () => {
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
    // Bare-number anchors instead.
    expect(html).toMatch(/class="hp">2500<\/a>/);
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
    expect(html).toMatch(/class="thp">400<\/a>/);
  });
});
