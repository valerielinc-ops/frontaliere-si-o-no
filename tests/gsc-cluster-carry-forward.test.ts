import { describe, it, expect } from 'vitest';
import { carryForwardGscClusterPages } from '../scripts/lib/gsc-cluster-carry-forward.mjs';

/**
 * Coverage gate for issue #5631 — the GSC-cluster half of the carry-forward
 * gap `scripts/generate-keyword-pages-config.mjs` left open (PR #5603 "Non
 * implementato": "Il carry-forward protegge solo le pagine
 * `source: 'profession-gap'`, non i cluster GSC: una pagina che esce dal
 * feed smette di essere rigenerata ma resta viva e indicizzata").
 *
 * `carryForwardGscClusterPages` is the pure function
 * `generate-keyword-pages-config.mjs` now calls right after building the
 * fresh top-50 cluster pages and before the profession-gap feed section —
 * see scripts/lib/gsc-cluster-carry-forward.mjs for the full defect
 * history.
 */

const GENERIC_PATTERNS = [
  /^(offerte?\s+)?(di\s+)?lavoro?\s+(in\s+)?ticino$/,
  /^cerco\s+lavoro\s+(in\s+)?ticino$/,
];
const COVERED_KEYWORDS = new Set(['infermieri', 'infermiere', 'lugano']);

function page(overrides: Partial<{ slug: string; query: string; source: string; professionId: string }> = {}) {
  return {
    slug: 'receptionist-ticino',
    query: 'receptionist ticino',
    filterKeywords: ['receptionist'],
    totalClicks: 12,
    totalImpressions: 300,
    ...overrides,
  };
}

describe('carryForwardGscClusterPages (#5631)', () => {
  it('THE HISTORICAL BUG: carries forward a GSC-cluster page that fell out of this run\'s top-50 ranking', () => {
    // This is exactly the measured shape of the bug: a page from a previous
    // run (no `source` field — a plain GSC-cluster page) that this run's
    // fresh cluster loop did not reproduce (usedSlugs is empty — the slug
    // never made the cut this time).
    const prevPages = [page({ slug: 'receptionist-ticino', query: 'receptionist ticino' })];
    const usedSlugs = new Set<string>();

    const carried = carryForwardGscClusterPages(prevPages, {
      usedSlugs,
      genericPatterns: GENERIC_PATTERNS,
      coveredKeywords: COVERED_KEYWORDS,
    });

    expect(carried).toHaveLength(1);
    expect(carried[0].slug).toBe('receptionist-ticino');
    expect(usedSlugs.has('receptionist-ticino')).toBe(true); // mutated in place
  });

  it('does not carry a page already reproduced by the fresh run (avoids a duplicate slug)', () => {
    const prevPages = [page({ slug: 'receptionist-ticino' })];
    const usedSlugs = new Set(['receptionist-ticino']); // fresh loop already re-generated it

    const carried = carryForwardGscClusterPages(prevPages, {
      usedSlugs,
      genericPatterns: GENERIC_PATTERNS,
      coveredKeywords: COVERED_KEYWORDS,
    });

    expect(carried).toHaveLength(0);
  });

  it('does not double-carry a profession-gap page — that is the other block\'s job', () => {
    const prevPages = [page({ slug: 'oss-ticino', query: 'oss ticino', source: 'profession-gap', professionId: 'oss' })];
    const usedSlugs = new Set<string>();

    const carried = carryForwardGscClusterPages(prevPages, {
      usedSlugs,
      genericPatterns: GENERIC_PATTERNS,
      coveredKeywords: COVERED_KEYWORDS,
    });

    expect(carried).toHaveLength(0);
    expect(usedSlugs.has('oss-ticino')).toBe(false);
  });

  it('drops a carried page whose query is now covered by an editorial keyword (legitimate supersession)', () => {
    const prevPages = [page({ slug: 'infermiere-lugano', query: 'infermiere lugano' })];
    const usedSlugs = new Set<string>();

    const carried = carryForwardGscClusterPages(prevPages, {
      usedSlugs,
      genericPatterns: GENERIC_PATTERNS,
      coveredKeywords: COVERED_KEYWORDS,
    });

    expect(carried).toHaveLength(0);
  });

  it('drops a carried page whose query now matches a generic pattern (legitimate supersession)', () => {
    const prevPages = [page({ slug: 'lavoro-ticino-generic', query: 'lavoro ticino' })];
    const usedSlugs = new Set<string>();

    const carried = carryForwardGscClusterPages(prevPages, {
      usedSlugs,
      genericPatterns: GENERIC_PATTERNS,
      coveredKeywords: COVERED_KEYWORDS,
    });

    expect(carried).toHaveLength(0);
  });

  it('carries multiple independent pages and never emits a duplicate slug within the same call', () => {
    const prevPages = [
      page({ slug: 'venditrice-lavoro-ticino', query: 'venditrice lavoro ticino' }),
      page({ slug: 'receptionist-ticino', query: 'receptionist ticino' }),
      page({ slug: 'offerte-lavoro-assistente-di-cura-ticino', query: 'offerte lavoro assistente di cura ticino' }),
    ];
    const usedSlugs = new Set<string>();

    const carried = carryForwardGscClusterPages(prevPages, {
      usedSlugs,
      genericPatterns: GENERIC_PATTERNS,
      coveredKeywords: COVERED_KEYWORDS,
    });

    expect(carried.map((p) => p.slug).sort()).toEqual(
      ['offerte-lavoro-assistente-di-cura-ticino', 'receptionist-ticino', 'venditrice-lavoro-ticino'].sort(),
    );
    expect(usedSlugs.size).toBe(3);
  });

  it('ignores a malformed previous entry (missing slug) without throwing', () => {
    const prevPages = [{ query: 'no slug here' }, page({ slug: 'ok-ticino', query: 'ok ticino' })];
    const usedSlugs = new Set<string>();

    const carried = carryForwardGscClusterPages(prevPages as never[], {
      usedSlugs,
      genericPatterns: GENERIC_PATTERNS,
      coveredKeywords: COVERED_KEYWORDS,
    });

    expect(carried).toHaveLength(1);
    expect(carried[0].slug).toBe('ok-ticino');
  });
});
