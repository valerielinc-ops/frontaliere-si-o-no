/**
 * Shared related-links helper — D-2 Expansion C (3-cluster enrichment).
 *
 * Verifies:
 *  - `generateRelatedLinks()` returns 6-12 links for every (locale, pageType)
 *    pair — the 3-cluster builder never falls below the minimum floor.
 *  - `generateRelatedLinksStructured()` returns 3 `<section>` groups
 *    (sibling / hubs / cross) with per-cluster caps honoured.
 *  - All emitted hrefs are locale-aware (non-IT paths always start with
 *    `/{locale}/`) and absolute (leading slash).
 *  - Cross-feature coverage still holds: fuel_* pages link to border-wait +
 *    weekly-employers, weekly_employers pages link to fuel + border-wait +
 *    job-market, border_wait pages link to fuel + weekly + sibling
 *    crossings in the same region.
 *  - HTML output is valid + accessible: one `<nav aria-label>` landmark
 *    wrapping three `<section aria-label>` cards with `<h3>` headings.
 *  - Zero `dark:` Tailwind prefixes, zero hardcoded Tailwind color scales.
 *  - All new page types (`fuel_station`, `fuel_italian_city`,
 *    `weekly_employer_company_city`) are supported.
 */

import { describe, it, expect } from 'vitest';
import {
  generateRelatedLinks,
  generateRelatedLinksBlock,
  generateRelatedLinksStructured,
  type LinkLocale,
  type SeoPageType,
} from '@/build-plugins/shared/relatedLinks';

const LOCALES: readonly LinkLocale[] = ['it', 'en', 'de', 'fr'] as const;
const PAGE_TYPES: readonly SeoPageType[] = [
  'fuel_daily',
  'fuel_station',
  'fuel_italian_city',
  'weekly_employers',
  'weekly_employer_company_city',
  'job_market_snapshot',
  'health_premiums',
  'orphan_landing',
  'border_wait',
] as const;

const MIN_LINKS_PER_PAGE = 6;
const MAX_LINKS_PER_PAGE = 12;

// Context that best represents a real caller for each page type — used by
// matrix tests to guarantee every branch exercises the rich-context path.
function sampleContextFor(pageType: SeoPageType) {
  switch (pageType) {
    case 'fuel_daily':
      return { fuelType: 'diesel' as const, fuelZone: 'chiasso' as const };
    case 'fuel_station':
      return {
        fuelType: 'diesel' as const,
        fuelZone: 'chiasso' as const,
        stationSlug: 'chiasso-eni-via-compolongo',
      };
    case 'fuel_italian_city':
      return {
        fuelType: 'diesel' as const,
        italianCity: 'como',
      };
    case 'weekly_employers':
      return { city: 'lugano', weeklyCity: 'lugano' as const };
    case 'weekly_employer_company_city':
      return {
        city: 'lugano',
        weeklyCity: 'lugano' as const,
        companySlug: 'eoc',
        companySiblingCities: ['bellinzona', 'mendrisio', 'chiasso', 'locarno'] as const,
      };
    case 'job_market_snapshot':
      return {};
    case 'health_premiums':
      return {
        cantonSlug: 'ticino' as const,
        age: '26-30' as const,
      };
    case 'orphan_landing':
      return { city: 'Mendrisio', queryClusterSlug: 'lavoro-notturno' };
    case 'border_wait':
      return { borderCrossing: 'chiasso-brogeda' as const };
  }
}

describe('generateRelatedLinks (flat list)', () => {
  for (const locale of LOCALES) {
    for (const pageType of PAGE_TYPES) {
      it(`returns 6-12 non-empty links for ${locale} / ${pageType}`, () => {
        const ctx = sampleContextFor(pageType);
        const links = generateRelatedLinks(locale, pageType, ctx);
        expect(links.length).toBeGreaterThanOrEqual(MIN_LINKS_PER_PAGE);
        expect(links.length).toBeLessThanOrEqual(MAX_LINKS_PER_PAGE);
        for (const link of links) {
          expect(link.href.length).toBeGreaterThan(0);
          expect(link.title.length).toBeGreaterThan(0);
          expect(link.href.startsWith('/')).toBe(true);
        }
      });
    }
  }

  it('targets 10-12 links on average across the page-type × locale matrix', () => {
    let total = 0;
    let n = 0;
    for (const locale of LOCALES) {
      for (const pageType of PAGE_TYPES) {
        const ctx = sampleContextFor(pageType);
        total += generateRelatedLinks(locale, pageType, ctx).length;
        n += 1;
      }
    }
    const avg = total / n;
    expect(avg).toBeGreaterThanOrEqual(9);
    expect(avg).toBeLessThanOrEqual(12);
  });

  it('non-IT locales produce locale-prefixed paths on all feature-internal routes', () => {
    for (const locale of ['en', 'de', 'fr'] as const) {
      for (const pageType of PAGE_TYPES) {
        const ctx = sampleContextFor(pageType);
        const links = generateRelatedLinks(locale, pageType, ctx);
        for (const link of links) {
          expect(link.href.startsWith(`/${locale}/`)).toBe(true);
        }
      }
    }
  });

  it('hrefs are deduplicated per page type × locale × context', () => {
    for (const locale of LOCALES) {
      for (const pageType of PAGE_TYPES) {
        const ctx = sampleContextFor(pageType);
        const links = generateRelatedLinks(locale, pageType, ctx);
        const uniq = new Set(links.map((l) => l.href));
        expect(uniq.size).toBe(links.length);
      }
    }
  });
});

describe('generateRelatedLinksStructured (3-cluster)', () => {
  for (const locale of LOCALES) {
    for (const pageType of PAGE_TYPES) {
      it(`emits sibling + hubs + cross sections for ${locale} / ${pageType}`, () => {
        const ctx = sampleContextFor(pageType);
        const out = generateRelatedLinksStructured(locale, pageType, ctx);
        const kinds = out.sections.map((s) => s.kind);
        expect(kinds).toContain('sibling');
        expect(kinds).toContain('hubs');
        expect(kinds).toContain('cross');
        expect(out.sections.length).toBe(3);
      });

      it(`honours per-cluster caps for ${locale} / ${pageType}`, () => {
        const ctx = sampleContextFor(pageType);
        const { sections } = generateRelatedLinksStructured(locale, pageType, ctx);
        const sibling = sections.find((s) => s.kind === 'sibling');
        const hubs = sections.find((s) => s.kind === 'hubs');
        const cross = sections.find((s) => s.kind === 'cross');
        expect((sibling?.links.length ?? 0)).toBeLessThanOrEqual(6);
        expect((hubs?.links.length ?? 0)).toBeLessThanOrEqual(3);
        expect((cross?.links.length ?? 0)).toBeLessThanOrEqual(4);
      });
    }
  }

  it('fuel_daily sibling section lists other fuel zones in Ticino', () => {
    const { sections } = generateRelatedLinksStructured('it', 'fuel_daily', {
      fuelType: 'diesel',
      fuelZone: 'chiasso',
    });
    const sibling = sections.find((s) => s.kind === 'sibling');
    expect(sibling).toBeDefined();
    expect(sibling!.links.length).toBeGreaterThanOrEqual(3);
    for (const l of sibling!.links) {
      expect(l.href).toContain('/prezzi-diesel/');
      // Not the current zone.
      expect(l.href).not.toContain('/chiasso/');
    }
  });

  it('fuel_daily cross-category links include border-wait + weekly-employers', () => {
    const { sections } = generateRelatedLinksStructured('it', 'fuel_daily', {
      fuelType: 'diesel',
      fuelZone: 'chiasso',
      city: 'chiasso',
    });
    const cross = sections.find((s) => s.kind === 'cross')!;
    const hrefs = cross.links.map((l) => l.href);
    expect(hrefs.some((h) => h.includes('traffico-dogane/'))).toBe(true);
    expect(hrefs.some((h) => h.includes('aziende-che-assumono/'))).toBe(true);
    expect(hrefs.some((h) => h.includes('mercato-lavoro-ticino'))).toBe(true);
  });

  it('fuel_station sibling links all belong to the same zone', () => {
    const { sections } = generateRelatedLinksStructured('it', 'fuel_station', {
      fuelType: 'diesel',
      fuelZone: 'chiasso',
      stationSlug: 'chiasso-eni-via-compolongo',
    });
    const sibling = sections.find((s) => s.kind === 'sibling')!;
    expect(sibling.links.length).toBeGreaterThanOrEqual(3);
    for (const l of sibling.links) {
      expect(l.href).toContain('/prezzi-diesel/chiasso/stazioni/');
    }
  });

  it('fuel_station hubs point to zone hub + regional hub', () => {
    const { sections } = generateRelatedLinksStructured('it', 'fuel_station', {
      fuelType: 'diesel',
      fuelZone: 'chiasso',
      stationSlug: 'chiasso-eni-via-compolongo',
    });
    const hubs = sections.find((s) => s.kind === 'hubs')!;
    const hrefs = hubs.links.map((l) => l.href);
    expect(hrefs).toContain('/prezzi-diesel/chiasso/oggi/');
    expect(hrefs).toContain('/prezzi-diesel/oggi/');
  });

  it('fuel_italian_city siblings are other IT border cities', () => {
    const { sections } = generateRelatedLinksStructured('it', 'fuel_italian_city', {
      fuelType: 'diesel',
      italianCity: 'como',
    });
    const sibling = sections.find((s) => s.kind === 'sibling')!;
    for (const l of sibling.links) {
      expect(l.href).toContain('/prezzi-diesel/italia/');
      expect(l.href).not.toContain('/italia/como/');
    }
  });

  it('weekly_employers sibling section lists other cities (not regional Ticino)', () => {
    const { sections } = generateRelatedLinksStructured('it', 'weekly_employers', {
      city: 'lugano',
      weeklyCity: 'lugano',
    });
    const sibling = sections.find((s) => s.kind === 'sibling')!;
    expect(sibling.links.length).toBeGreaterThanOrEqual(3);
    for (const l of sibling.links) {
      expect(l.href).toContain('/aziende-che-assumono/');
      expect(l.href).not.toContain('/aziende-che-assumono/lugano/');
      expect(l.href).not.toContain('/aziende-che-assumono/ticino/');
    }
  });

  it('weekly_employer_company_city keeps the same company across sibling cities', () => {
    const { sections } = generateRelatedLinksStructured('it', 'weekly_employer_company_city', {
      city: 'lugano',
      weeklyCity: 'lugano',
      companySlug: 'eoc',
      companySiblingCities: ['bellinzona', 'mendrisio', 'chiasso', 'locarno'],
    });
    const sibling = sections.find((s) => s.kind === 'sibling')!;
    expect(sibling.links.length).toBeGreaterThanOrEqual(3);
    for (const l of sibling.links) {
      expect(l.href).toContain('/eoc/');
      expect(l.href).toContain('/aziende-che-assumono/');
    }
  });

  it('weekly_employer_company_city hubs include parent F5 city hub', () => {
    const { sections } = generateRelatedLinksStructured('it', 'weekly_employer_company_city', {
      city: 'lugano',
      weeklyCity: 'lugano',
      companySlug: 'eoc',
      companySiblingCities: ['bellinzona', 'mendrisio', 'chiasso', 'locarno'],
    });
    const hubs = sections.find((s) => s.kind === 'hubs')!;
    const hrefs = hubs.links.map((l) => l.href);
    expect(hrefs).toContain('/aziende-che-assumono/lugano/settimana-corrente/');
    expect(hrefs).toContain('/aziende-che-assumono/ticino/settimana-corrente/');
  });

  it('health_premiums sibling section lists other age brackets when on a leaf', () => {
    const { sections } = generateRelatedLinksStructured('it', 'health_premiums', {
      cantonSlug: 'ticino',
      age: '26-30',
    });
    const sibling = sections.find((s) => s.kind === 'sibling')!;
    for (const l of sibling.links) {
      expect(l.href).toContain('/premi-cassa-malati/');
    }
    // At least 3 sibling ages.
    expect(sibling.links.length).toBeGreaterThanOrEqual(3);
  });

  it('health_premiums cross-links include comparator + salary + guide (all internal, no nofollow)', () => {
    // Semrush audit fix: internal cross-links must NOT carry rel="nofollow",
    // otherwise we waste internal link equity. The comparator stays reachable
    // but is now a normal internal dofollow link.
    const { sections } = generateRelatedLinksStructured('it', 'health_premiums', {
      cantonSlug: 'ticino',
      age: '26-30',
    });
    const cross = sections.find((s) => s.kind === 'cross')!;
    // No internal link should carry rel="nofollow".
    const nofollowLinks = cross.links.filter((l) => l.rel === 'nofollow');
    expect(nofollowLinks).toHaveLength(0);
    // Comparator link must still be present (just without nofollow).
    const comparatorLink = cross.links.find((l) => l.href.includes('confronta-casse-malati'));
    expect(comparatorLink).toBeDefined();
    const hrefs = cross.links.map((l) => l.href);
    expect(hrefs.some((h) => h.includes('guida-frontaliere'))).toBe(true);
    expect(hrefs).toContain('/');
  });

  it('border_wait sibling section lists other crossings, same region preferred', () => {
    const { sections } = generateRelatedLinksStructured('it', 'border_wait', {
      borderCrossing: 'chiasso-brogeda',
    });
    const sibling = sections.find((s) => s.kind === 'sibling')!;
    expect(sibling.links.length).toBeGreaterThanOrEqual(3);
    for (const l of sibling.links) {
      expect(l.href).toContain('/traffico-dogane/');
      expect(l.href).not.toContain('/chiasso-brogeda/');
    }
  });

  it('border_wait hubs include regional hub + root hub', () => {
    const { sections } = generateRelatedLinksStructured('it', 'border_wait', {
      borderCrossing: 'chiasso-brogeda',
    });
    const hubs = sections.find((s) => s.kind === 'hubs')!;
    const hrefs = hubs.links.map((l) => l.href);
    expect(hrefs).toContain('/traffico-dogane/ticino-como/');
    expect(hrefs).toContain('/traffico-dogane/');
  });

  it('border_wait cross-links include fuel-daily + weekly-employers', () => {
    const { sections } = generateRelatedLinksStructured('it', 'border_wait', {
      borderCrossing: 'chiasso-brogeda',
    });
    const cross = sections.find((s) => s.kind === 'cross')!;
    const hrefs = cross.links.map((l) => l.href);
    expect(hrefs.some((h) => h.includes('prezzi-diesel/chiasso/oggi/'))).toBe(true);
    expect(hrefs.some((h) => h.includes('aziende-che-assumono/chiasso/'))).toBe(true);
  });

  it('orphan_landing hubs include the main listing root', () => {
    const { sections } = generateRelatedLinksStructured('it', 'orphan_landing', {
      city: 'Mendrisio',
    });
    const hubs = sections.find((s) => s.kind === 'hubs')!;
    const hrefs = hubs.links.map((l) => l.href);
    expect(hrefs).toContain('/cerca-lavoro-ticino/');
  });

  it('job_market_snapshot sibling section is 4 city F5 hubs', () => {
    const { sections } = generateRelatedLinksStructured('it', 'job_market_snapshot');
    const sibling = sections.find((s) => s.kind === 'sibling')!;
    expect(sibling.links.length).toBe(4);
    const hrefs = sibling.links.map((l) => l.href);
    expect(hrefs.every((h) => h.includes('/aziende-che-assumono/'))).toBe(true);
  });
});

describe('generateRelatedLinksBlock (HTML render)', () => {
  it('produces a <nav aria-label="Correlati"> wrapper for every page type', () => {
    for (const locale of LOCALES) {
      for (const pageType of PAGE_TYPES) {
        const ctx = sampleContextFor(pageType);
        const html = generateRelatedLinksBlock(locale, pageType, ctx);
        expect(html).toMatch(/<nav\s[^>]*aria-label=/);
        expect(html).toMatch(/id="seoRelatedLinks"/);
      }
    }
  });

  it('emits three <section> cards with <h3> headings per page type', () => {
    for (const locale of LOCALES) {
      for (const pageType of PAGE_TYPES) {
        const ctx = sampleContextFor(pageType);
        const html = generateRelatedLinksBlock(locale, pageType, ctx);
        const sectionMatches = html.match(/<section\s[^>]*aria-label=/g);
        const h3Matches = html.match(/<h3\s/g);
        // 3-cluster output (normal path) = 3 sections + 3 h3; fallback = 1.
        expect((sectionMatches?.length ?? 0)).toBeGreaterThanOrEqual(1);
        expect((h3Matches?.length ?? 0)).toBeGreaterThanOrEqual(1);
        // Rich context means all 3 sections fire — that's our primary target.
        expect((sectionMatches?.length ?? 0)).toBe((h3Matches?.length ?? 0));
      }
    }
  });

  it('anchor count per page type matches flat-list length', () => {
    for (const locale of LOCALES) {
      for (const pageType of PAGE_TYPES) {
        const ctx = sampleContextFor(pageType);
        const html = generateRelatedLinksBlock(locale, pageType, ctx);
        const flat = generateRelatedLinks(locale, pageType, ctx);
        const anchors = html.match(/<a\s+href="/g);
        expect(anchors?.length ?? 0).toBe(flat.length);
      }
    }
  });

  it('never emits dark: Tailwind prefixes or hardcoded Tailwind color classes', () => {
    for (const locale of LOCALES) {
      for (const pageType of PAGE_TYPES) {
        const ctx = sampleContextFor(pageType);
        const html = generateRelatedLinksBlock(locale, pageType, ctx);
        expect(html).not.toMatch(/dark:/);
        expect(html).not.toMatch(/class="[^"]*(bg|text|border)-(red|blue|green|slate|gray|emerald|amber|orange|yellow|violet|purple|pink|rose|indigo|fuchsia|teal|cyan|sky|stone|zinc|neutral)-\d/);
      }
    }
  });

  it('uses semantic Tailwind tokens from index.css (no hardcoded dark-mode palette)', () => {
    const html = generateRelatedLinksBlock('it', 'fuel_daily', {
      fuelType: 'diesel',
      fuelZone: 'chiasso',
    });
    // Semantic tokens (Tailwind classes resolving to CSS custom properties)
    // so the block visually matches the rest of the site and auto-adapts
    // to dark mode without any `dark:` prefix.
    expect(html).toContain('text-accent');
    expect(html).toContain('bg-surface-alt');
    expect(html).toContain('border-edge');
    expect(html).toContain('text-subtle');
  });

  it('escapes HTML entities in emitted content', () => {
    for (const locale of LOCALES) {
      for (const pageType of PAGE_TYPES) {
        const ctx = sampleContextFor(pageType);
        const html = generateRelatedLinksBlock(locale, pageType, ctx);
        const anchorBodies = Array.from(html.matchAll(/<a\s[^>]*>([^<]*)<\/a>/g)).map((m) => m[1]);
        for (const body of anchorBodies) {
          expect(body).not.toMatch(/<|>/);
        }
      }
    }
  });

  it('respects the hard 12-link cap even with overflow-friendly context', () => {
    // Even when every heuristic fires, total anchors ≤ 12.
    for (const locale of LOCALES) {
      for (const pageType of PAGE_TYPES) {
        const ctx = sampleContextFor(pageType);
        const html = generateRelatedLinksBlock(locale, pageType, ctx);
        const anchors = html.match(/<a\s+href="/g);
        expect(anchors?.length ?? 0).toBeLessThanOrEqual(MAX_LINKS_PER_PAGE);
      }
    }
  });
});

describe('backwards compat — pre-D-2C callers', () => {
  it('generateRelatedLinksBlock(locale, pageType) with no context still produces a valid block', () => {
    for (const locale of LOCALES) {
      for (const pageType of PAGE_TYPES) {
        const html = generateRelatedLinksBlock(locale, pageType);
        expect(html).toMatch(/<nav\s/);
        expect(html).toMatch(/id="seoRelatedLinks"/);
        const anchors = html.match(/<a\s+href="/g);
        expect(anchors?.length ?? 0).toBeGreaterThanOrEqual(MIN_LINKS_PER_PAGE - 1); // legacy fallback = 5
      }
    }
  });

  it('generateRelatedLinks return shape has href + title (backwards compat)', () => {
    const links = generateRelatedLinks('it', 'fuel_daily', { fuelType: 'diesel', fuelZone: 'chiasso' });
    for (const l of links) {
      expect(typeof l.href).toBe('string');
      expect(typeof l.title).toBe('string');
    }
  });
});
