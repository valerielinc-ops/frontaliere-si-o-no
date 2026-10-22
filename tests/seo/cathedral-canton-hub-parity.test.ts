/**
 * Phase 8(g) — TI editorial structure and inventory contract.
 *
 * The helper extraction in `build-plugins/shared/cantonHubEditorial.ts`
 * retains its established heading, archive navigator and block order.
 * Unsupported claims about vacancy activity, employer totals, crawler
 * cadence, permit eligibility and salary estimates were removed, so this
 * test protects the page structure and collected count instead of stale copy.
 *
 * Reference commit: see PR for Phase 8(g) (canton hub editorial parity).
 */
import { describe, it, expect } from 'vitest';
import { buildCantonHubEditorial } from '../../build-plugins/shared/cantonHubEditorial';

describe('Phase 8(g) — canton hub editorial structure', () => {
  it('keeps TI heading and archive navigation while using collected inventory copy', () => {
    const blocks = buildCantonHubEditorial({
      canton: 'TI',
      locale: 'it',
      display: 'Ticino',
      // The number is the real count passed by the page emitter.
      jobsCount: 5914,
      totalPages: 304,
      archiveBaseHref: '/cerca-lavoro-ticino/tutti/',
    });
    // With totalPages > 1 the helper returns 8 entries:
    // [H2, intro, archive-nav, prose1, prose2, prose3, prose4, sources, faq]
    // — actually [0..1] = H2/intro, [2] = archive-nav, [3..7] = prose×4
    // + sources line, [8] = FAQ details. Length 9.
    expect(blocks).toHaveLength(9);

    // Pin the H2 — definition block for AI extraction.
    expect(blocks[0]).toMatch(
      /^<h2 (style="font-size:1\.05rem;font-weight:700;margin:1rem 0 \.5rem"|class="s-[A-Za-z0-9_-]+")>Offerte di Lavoro in Ticino — Bacheca Lavoro per Frontalieri<\/h2>$/,
    );
    // Intro paragraph mentions Ticino + the live collected count.
    expect(blocks[1]).toMatch(/lavoro in Ticino/);
    expect(blocks[1]).toContain(`<strong>${(5914).toLocaleString('de-CH')}</strong>`);
    expect(blocks[1]).not.toMatch(/oltre 1\.500/);
    // Archive navigator is a single <details> collapsible. For long archives
    // (> 25 pages) it emits bounded page-range indexes; each index owns a
    // complete range of archive-page links. Small archives (cathedral
    // cantons with ≤ 25 pages) still emit every page anchor directly.
    expect(blocks[2].startsWith('<details ')).toBe(true);
    expect(blocks[2]).toMatch(/Sfoglia tutto l'archivio offerte per pagina \(304 pagine\)/);
    expect(blocks[2]).toMatch(/Pagina&nbsp;1/);
    expect(blocks[2]).toMatch(/Pagine 1–18/);
    expect(blocks[2]).toMatch(/Pagine 289–304/);
    // The page-1 bridge no longer embeds a direct middle-page URL.
    expect(blocks[2]).not.toContain('/cerca-lavoro-ticino/tutti/page-150/');
    // Prose avoids the old unverified company total and freshness claim.
    expect(blocks[3]).toMatch(/offerte lavoro Ticino/);
    expect(blocks[3]).not.toMatch(/oltre 100 aziende|ogni 12 ore|offerte attive/);
    // Language requirements are checked against the source listing.
    expect(blocks[6]).toMatch(/lingua della pagina o di una traduzione/);
    // Sources line points to seco.admin.ch.
    expect(blocks[7]).toMatch(/seco\.admin\.ch/);
    // FAQ is a collapsible <details>.
    expect(blocks[8].startsWith('<details ')).toBe(true);
    expect(blocks[8]).toMatch(/Domande frequenti sulla ricerca lavoro in Ticino/);
    expect(blocks[8]).toMatch(/Gli annunci raccolti sono ancora disponibili/);
    expect(blocks[8]).not.toContain((5914).toLocaleString('de-CH'));
    expect(blocks[8]).not.toMatch(/CHF 62\.000|permesso viene richiesto|oltre 100 aziende|oltre 1\.500|offerte attive/);
  });

  it('reports a zero collected count without inventing vacancies', () => {
    const blocks = buildCantonHubEditorial({
      canton: 'TI',
      locale: 'it',
      display: 'Ticino',
      jobsCount: 0,
      totalPages: 1,
      archiveBaseHref: '/cerca-lavoro-ticino/tutti/',
    });
    expect(blocks[1]).toContain('<strong>0</strong>');
    const faq = blocks[blocks.length - 1];
    expect(faq).toMatch(/Gli annunci raccolti sono ancora disponibili/);
  });

  it('omits the archive navigator when totalPages === 1 (single-page TI)', () => {
    const blocks = buildCantonHubEditorial({
      canton: 'TI',
      locale: 'it',
      display: 'Ticino',
      jobsCount: 50,
      totalPages: 1,
      archiveBaseHref: '/cerca-lavoro-ticino/tutti/',
    });
    // Without the archive navigator the array drops to 8 entries.
    expect(blocks).toHaveLength(8);
    // First two entries are still H2 + intro.
    expect(blocks[0]).toMatch(/<h2 /);
    expect(blocks[1]).toMatch(/lavoro in Ticino/);
    // No entry should be the archive <details>.
    expect(blocks.some((b) => b.includes('Sfoglia tutto l\'archivio offerte per pagina'))).toBe(false);
  });

  it('emits a canton-agnostic variant for cathedral cantons (ZH)', () => {
    const blocks = buildCantonHubEditorial({
      canton: 'ZH',
      locale: 'it',
      display: 'Zurigo',
      jobsCount: 250,
      totalPages: 3,
      archiveBaseHref: '/cerca-lavoro-zurigo/tutti/',
    });
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    // H2 mentions Zurigo, not Ticino.
    expect(blocks[0]).toMatch(/Canton Zurigo/);
    expect(blocks[0]).not.toMatch(/Ticino/);
    // Intro uses the canton-aware label.
    expect(blocks[0]).toMatch(/Canton Zurigo/);
    expect(blocks[0]).not.toMatch(/oltre 1\.500/); // TI-specific copy
    // FAQ mentions Zurigo.
    const faq = blocks[blocks.length - 1];
    expect(faq).toMatch(/Canton Zurigo/);
    expect(faq).toMatch(/<details /);
  });

  it('emits a Svizzera (federal) variant for the AGGREGATE key', () => {
    const blocks = buildCantonHubEditorial({
      canton: '_AGGREGATE_',
      locale: 'it',
      display: 'Svizzera',
      jobsCount: 5000,
      totalPages: 50,
      archiveBaseHref: '/cerca-lavoro-svizzera/tutti/',
    });
    // H2 + intro must read "in Svizzera", never "nel Canton Svizzera".
    expect(blocks[0]).toMatch(/in Svizzera/);
    expect(blocks[0]).not.toMatch(/nel Canton Svizzera/);
    expect(blocks[0]).toContain(`raccoglie ${(5000).toLocaleString('it-CH')} annunci`);
  });
});
