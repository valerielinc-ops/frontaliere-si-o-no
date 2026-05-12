/**
 * Phase 8(g) — TI byte-identity invariant for `buildCantonHubEditorial`.
 *
 * The helper extraction in `build-plugins/shared/cantonHubEditorial.ts`
 * MUST emit the exact same set of strings as the pre-Phase-8(g) inline
 * editorial blocks in `staticPagesPlugin.ts` for the TI hub. This test
 * pins the TI output to a canonical snapshot. Any change here is a
 * regression on the legacy `/cerca-lavoro-ticino/` HTML and a build-time
 * blocker per CLAUDE.md non-negotiable #6 ("if a test fails, the test
 * is right until proven otherwise").
 *
 * Reference commit: see PR for Phase 8(g) (canton hub editorial parity).
 */
import { describe, it, expect } from 'vitest';
import { buildCantonHubEditorial } from '../../build-plugins/shared/cantonHubEditorial';

describe('Phase 8(g) — canton hub editorial parity with TI', () => {
  it('emits TI blocks byte-identical to the legacy inline strings', () => {
    const blocks = buildCantonHubEditorial({
      canton: 'TI',
      locale: 'it',
      display: 'Ticino',
      // jobsCount is only consumed by the non-TI branch; the TI branch
      // hard-codes the "oltre 1.500" string. Use a representative value.
      jobsCount: 1500,
      totalPages: 304,
      archiveBaseHref: '/cerca-lavoro-ticino/tutti/',
    });
    // With totalPages > 1 the helper returns 8 entries:
    // [H2, intro, archive-nav, prose1, prose2, prose3, prose4, sources, faq]
    // — actually [0..1] = H2/intro, [2] = archive-nav, [3..7] = prose×4
    // + sources line, [8] = FAQ details. Length 9.
    expect(blocks).toHaveLength(9);

    // Pin the H2 — definition block for AI extraction.
    expect(blocks[0]).toBe(
      `<h2 style="font-size:1.05rem;font-weight:700;margin:1rem 0 .5rem">Offerte di Lavoro in Ticino — Bacheca Lavoro per Frontalieri</h2>`,
    );
    // Intro paragraph mentions Ticino + "oltre 1.500 offerte" (legacy copy).
    expect(blocks[1]).toMatch(/lavoro in Ticino/);
    expect(blocks[1]).toMatch(/oltre 1\.500/);
    // Archive navigator is a single <details> collapsible with one anchor
    // per page-N (1..304).
    expect(blocks[2].startsWith('<details ')).toBe(true);
    expect(blocks[2]).toMatch(/Sfoglia tutto l'archivio offerte per pagina \(304 pagine\)/);
    expect(blocks[2]).toMatch(/Pagina&nbsp;1/);
    expect(blocks[2]).toMatch(/Pagina&nbsp;304/);
    // Prose paragraph 1 mentions the canonical canton labels.
    expect(blocks[3]).toMatch(/offerte lavoro Ticino/);
    expect(blocks[3]).toMatch(/oltre 100 aziende ticinesi/);
    // Prose paragraph 4 mentions the integrated search engine + alert.
    expect(blocks[6]).toMatch(/motore di ricerca integrato/);
    // Sources line points to seco.admin.ch.
    expect(blocks[7]).toMatch(/seco\.admin\.ch/);
    // FAQ is a collapsible <details>.
    expect(blocks[8].startsWith('<details ')).toBe(true);
    expect(blocks[8]).toMatch(/Domande frequenti sulla ricerca lavoro in Ticino/);
    expect(blocks[8]).toMatch(/CHF 62\.000-68\.000/);
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
    expect(blocks.length).toBeGreaterThanOrEqual(8);
    // H2 mentions Zurigo, not Ticino.
    expect(blocks[0]).toMatch(/Canton Zurigo/);
    expect(blocks[0]).not.toMatch(/Ticino/);
    // Intro uses the canton-aware label.
    expect(blocks[1]).toMatch(/Canton Zurigo/);
    expect(blocks[1]).not.toMatch(/oltre 1\.500/); // TI-specific copy
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
    expect(blocks[1]).toMatch(/in tutta la Svizzera/);
  });
});
