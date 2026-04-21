/**
 * Shared related-links helper — Layer 1 internal linking.
 *
 * Verifies:
 *  - generateRelatedLinks returns 5 links for every (locale, pageType) pair
 *  - Each link has a non-empty href and a non-empty localized title
 *  - Hrefs are locale-aware (non-IT paths always start with /{locale}/)
 *  - Cross-feature coverage: fuel_daily pages link to weekly_employers and
 *    job_market_snapshot; weekly_employers pages link to fuel_daily and
 *    job_market_snapshot (and to health_premiums for breadth)
 *  - Rendered HTML block is a <nav aria-label=...> with exactly 5 <a> tags
 *  - No `dark:` color classes, no hardcoded Tailwind color scales
 */

import { describe, it, expect } from 'vitest';
import {
  generateRelatedLinks,
  generateRelatedLinksBlock,
  type LinkLocale,
  type SeoPageType,
} from '@/build-plugins/shared/relatedLinks';

const LOCALES: readonly LinkLocale[] = ['it', 'en', 'de', 'fr'] as const;
const PAGE_TYPES: readonly SeoPageType[] = [
  'fuel_daily',
  'weekly_employers',
  'job_market_snapshot',
  'health_premiums',
  'orphan_landing',
] as const;

describe('generateRelatedLinks', () => {
  for (const locale of LOCALES) {
    for (const pageType of PAGE_TYPES) {
      it(`returns exactly 5 non-empty links for ${locale} / ${pageType}`, () => {
        const links = generateRelatedLinks(locale, pageType);
        expect(links).toHaveLength(5);
        for (const link of links) {
          expect(link.href.length).toBeGreaterThan(0);
          expect(link.title.length).toBeGreaterThan(0);
          // Every href starts with a slash (absolute path).
          expect(link.href.startsWith('/')).toBe(true);
        }
      });
    }
  }

  it('non-IT locales produce locale-prefixed paths on localized routes', () => {
    for (const locale of ['en', 'de', 'fr'] as const) {
      const links = generateRelatedLinks(locale, 'fuel_daily');
      for (const link of links) {
        // SALARY_SIM_ROOT for en/de/fr is /{locale}/ — every other link must
        // also start with /{locale}/ since the shared helper only emits
        // feature-internal paths.
        expect(link.href.startsWith(`/${locale}/`)).toBe(true);
      }
    }
  });

  it('fuel_daily page type links to weekly_employers, job_market_snapshot AND border_wait', () => {
    const links = generateRelatedLinks('it', 'fuel_daily', { fuelType: 'diesel', fuelZone: 'chiasso' });
    const hrefs = links.map((l) => l.href);
    expect(hrefs.some((h) => h.includes('aziende-che-assumono'))).toBe(true);
    expect(hrefs.some((h) => h.includes('mercato-lavoro-ticino'))).toBe(true);
    // At least one sibling fuel zone link.
    expect(hrefs.some((h) => h.includes('prezzi-diesel/') && !h.includes('chiasso'))).toBe(true);
    // F8: bidirectional fuel ↔ border-wait link for the same zone.
    expect(hrefs.some((h) => h.includes('traffico-dogane/chiasso-brogeda/oggi/'))).toBe(true);
  });

  it('weekly_employers page type links to fuel_daily, job_market_snapshot AND border_wait', () => {
    const links = generateRelatedLinks('it', 'weekly_employers', { weeklyCity: 'lugano' });
    const hrefs = links.map((l) => l.href);
    expect(hrefs.some((h) => h.includes('prezzi-diesel'))).toBe(true);
    expect(hrefs.some((h) => h.includes('mercato-lavoro-ticino'))).toBe(true);
    // F8: weekly_employers now includes the border-wait crossing nearest
    // the city (Lugano → ponte-tresa) as its 5th link, replacing the old
    // health_premiums link. See build-plugins/shared/relatedLinks.ts.
    expect(hrefs.some((h) => h.includes('traffico-dogane/'))).toBe(true);
  });

  it('border_wait page type links to fuel_daily, weekly_employers AND sibling crossings', () => {
    const links = generateRelatedLinks('it', 'border_wait', {
      borderCrossing: 'chiasso-brogeda',
    });
    const hrefs = links.map((l) => l.href);
    // 1) Fuel for the closest zone (chiasso)
    expect(hrefs.some((h) => h.includes('prezzi-diesel/chiasso/oggi/'))).toBe(true);
    // 2) Weekly employers for the closest city (chiasso)
    expect(hrefs.some((h) => h.includes('aziende-che-assumono/chiasso/'))).toBe(true);
    // 3-4) At least 2 sibling border-wait crossings (not Brogeda itself)
    const siblingLinks = hrefs.filter(
      (h) => h.includes('/traffico-dogane/') && !h.includes('/chiasso-brogeda/'),
    );
    expect(siblingLinks.length).toBeGreaterThanOrEqual(2);
    // Exactly 5 links total
    expect(links.length).toBe(5);
  });

  it('job_market_snapshot page type links to weekly_employers and city hubs', () => {
    const links = generateRelatedLinks('it', 'job_market_snapshot');
    const hrefs = links.map((l) => l.href);
    expect(hrefs.some((h) => h.includes('aziende-che-assumono'))).toBe(true);
    expect(hrefs.some((h) => h.includes('cerca-lavoro-ticino/lugano'))).toBe(true);
    expect(hrefs.some((h) => h.includes('cerca-lavoro-ticino/mendrisio'))).toBe(true);
  });

  it('health_premiums page type links to the comparator and sibling cantons/age brackets', () => {
    const links = generateRelatedLinks('it', 'health_premiums', { cantonSlug: 'ticino', age: '26-30' });
    const hrefs = links.map((l) => l.href);
    // Comparator path.
    expect(hrefs.some((h) => h.includes('compara-servizi') || h.includes('confronta-casse-malati'))).toBe(true);
    // At least one health-premium URL beyond the comparator.
    expect(hrefs.filter((h) => h.includes('premi-cassa-malati')).length).toBeGreaterThanOrEqual(1);
  });

  it('orphan_landing page type links to main listing, city hub and recency hub', () => {
    const links = generateRelatedLinks('it', 'orphan_landing', { city: 'Mendrisio' });
    const hrefs = links.map((l) => l.href);
    expect(hrefs).toContain('/cerca-lavoro-ticino/');
    expect(hrefs.some((h) => h.includes('cerca-lavoro-ticino/mendrisio'))).toBe(true);
    expect(hrefs.some((h) => h.includes('mercato-lavoro-ticino'))).toBe(true);
    expect(hrefs.some((h) => h.includes('da-ieri'))).toBe(true);
  });

  it('hrefs are deduplicated per page type × locale × context', () => {
    for (const locale of LOCALES) {
      for (const pageType of PAGE_TYPES) {
        const links = generateRelatedLinks(locale, pageType);
        const uniq = new Set(links.map((l) => l.href));
        expect(uniq.size).toBe(links.length);
      }
    }
  });
});

describe('generateRelatedLinksBlock (HTML render)', () => {
  it('produces a <nav aria-label="..."> wrapper with exactly 5 anchors for every page type', () => {
    for (const locale of LOCALES) {
      for (const pageType of PAGE_TYPES) {
        const html = generateRelatedLinksBlock(locale, pageType);
        expect(html).toMatch(/<nav\s[^>]*aria-label=/);
        expect(html).toMatch(/id="seoRelatedLinks"/);
        // Count anchors in the block.
        const matches = html.match(/<a\s+href="/g);
        expect(matches?.length ?? 0).toBe(5);
      }
    }
  });

  it('never emits dark: Tailwind prefixes or hardcoded Tailwind color classes', () => {
    // The block uses inline-styled markup with hex colors — it must NOT
    // accidentally leak Tailwind utility classes that would flag
    // tests/no-dark-color-classes.test.ts.
    for (const locale of LOCALES) {
      for (const pageType of PAGE_TYPES) {
        const html = generateRelatedLinksBlock(locale, pageType);
        expect(html).not.toMatch(/dark:/);
        expect(html).not.toMatch(/class="[^"]*(bg|text|border)-(red|blue|green|slate|gray|emerald|amber|orange|yellow|violet|purple|pink|rose|indigo|fuchsia|teal|cyan|sky|stone|zinc|neutral)-\d/);
      }
    }
  });

  it('escapes HTML entities in emitted content', () => {
    // The renderer passes all text through escHtml; verify it doesn't leak
    // raw `<` / `>` into title text (which would indicate unescaped output).
    for (const locale of LOCALES) {
      for (const pageType of PAGE_TYPES) {
        const html = generateRelatedLinksBlock(locale, pageType);
        // Titles are rendered between <a ...>TITLE →</a>; any raw `<` inside
        // the anchor body (other than the closing tag) would be a bug.
        const anchorBodies = Array.from(html.matchAll(/<a\s[^>]*>([^<]*)<\/a>/g)).map((m) => m[1]);
        expect(anchorBodies.length).toBe(5);
        for (const body of anchorBodies) {
          expect(body).not.toMatch(/<|>/);
        }
      }
    }
  });
});
