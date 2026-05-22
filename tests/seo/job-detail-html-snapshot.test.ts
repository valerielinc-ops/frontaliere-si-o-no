/**
 * Output regression gate for the extracted job-detail HTML emitters
 * (Phase 1 of the L3 refactor — see `build-plugins/shared/jobDetailHtml/`).
 *
 * Three representative fixture jobs cover the gating branches each
 * emitter exposes:
 *   1. Canonical-rich job (highlights[] + featured + new + salary)
 *   2. No-canonical job (Relewant-style — bare keywords, no highlights)
 *   3. Featured + new + salary, no canonical, no postal code
 *
 * The previous coverage (`tests/seo/static-job-page-spa-alignment.test.ts`)
 * is a source-walker — it asserts the *syntactic shape* of the IIFE/emitter
 * source survives extraction. This file asserts the *rendered output* of
 * the new pure-TS emitters stays byte-stable as Phase 2 (SPA consumption)
 * lands. Follows the project convention of explicit toContain / toMatch
 * assertions (no vitest snapshot files — see other tests/seo/*.ts).
 */
import { describe, expect, it } from 'vitest';

import {
  renderHeroBadges,
  renderHighlightsChips,
  renderMobileActionBlock,
  renderRightRail,
  type JobDetailJob,
  type JobDetailRenderContext,
} from '../../build-plugins/shared/jobDetailHtml';

// Minimal HTML escaper mirroring the plugin's `esc` so the fixtures
// exercise the same encoding path. Kept inline (rather than importing
// `escHtml` from `../../build-plugins/shared/htmlEscape`) so the test
// is self-contained and a future renamed helper doesn't drag this
// regression gate with it.
const esc = (s: string): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const referralUrl = (raw: string): string => raw;

function buildCtx(
  partial: Partial<JobDetailRenderContext> & {
    job: JobDetailJob;
    locale: JobDetailRenderContext['locale'];
  },
): JobDetailRenderContext {
  return {
    salaryText: '',
    salaryMin: NaN,
    canonicalUrl: 'https://frontaliereticino.ch/example/',
    addressLocality: '',
    addressRegion: '',
    postalCode: '',
    canonicalKeywords: [],
    localeLabels: {
      applyNow: 'Vai alla candidatura',
      quickDetails: 'Dettagli rapidi',
      location: 'Località',
      contract: 'Contratto',
    },
    referralUrl,
    esc,
    ...partial,
  } as JobDetailRenderContext;
}

describe('jobDetailHtml emitters — output regression', () => {
  describe('fixture 1: canonical-rich (featured + new + salary + highlights)', () => {
    const ctx = buildCtx({
      job: {
        slug: 'senior-engineer-acme-lugano',
        title: 'Senior Engineer',
        company: 'Acme SA',
        location: 'Lugano',
        canton: 'TI',
        category: 'technology',
        contract: 'full-time',
        featured: true,
        // 1 day ago — within the 7-day "Nuovo" window
        postedDate: new Date(Date.now() - 86400000).toISOString(),
        url: 'https://example.com/job/123',
      },
      locale: 'it',
      salaryMin: 90000,
      salaryText: 'CHF 90,000 - 120,000',
      addressLocality: 'Lugano',
      addressRegion: 'TI',
      postalCode: '6900',
      canonicalKeywords: ['typescript', 'react', 'node'],
      canonicalLocale: {
        highlights: [
          'Tech stack moderno',
          'Smart working ibrido',
          'Bonus annuale',
        ],
      },
    });

    it('hero badges include all three gates', () => {
      const html = renderHeroBadges(ctx);
      expect(html).toContain('class="hero-badges"');
      expect(html).toContain('badge-featured');
      expect(html).toContain('★ In evidenza');
      expect(html).toContain('badge-new');
      expect(html).toContain('Nuovo');
      expect(html).toContain('badge-salary');
      expect(html).toContain('CHF 90,000 - 120,000');
    });

    it('mobile action block emits CTA, location/contract/published tiles and salary line', () => {
      const html = renderMobileActionBlock(ctx);
      expect(html).toContain('class="mobile-action-block"');
      expect(html).toContain('class="mab-cta"');
      expect(html).toContain('Vai alla candidatura');
      expect(html).toContain('Lugano');
      expect(html).toContain('full-time');
      expect(html).toContain('mab-salary');
      // 1-day-ago fixture → "Ieri" in Italian
      expect(html).toContain('Ieri');
    });

    it('highlights prefers canonicalLocale.highlights over canonicalKeywords', () => {
      const html = renderHighlightsChips(ctx);
      expect(html).toContain('class="highlights"');
      expect(html).toContain('Tech stack moderno');
      // canonicalKeywords are NOT used when highlights is non-empty
      expect(html).not.toContain('typescript');
    });

    it('right rail emits all four cards (location, salary, sector, related)', () => {
      const html = renderRightRail(ctx);
      expect(html).toContain('class="job-detail-rail"');
      expect(html).toContain('class="rail-card"');
      // Location rows
      expect(html).toContain('Città');
      expect(html).toContain('Lugano');
      expect(html).toContain('Cantone');
      expect(html).toContain('CAP');
      expect(html).toContain('6900');
      // Salary card
      expect(html).toContain('rail-salary');
      // Sector card (technology → tecnologia in IT)
      expect(html).toContain('rail-sector');
      expect(html).toContain('tecnologia');
      // Related-search chips fed from canonicalKeywords
      expect(html).toContain('rail-chips');
      expect(html).toContain('typescript');
    });
  });

  describe('fixture 2: no canonical (Relewant-style, en locale)', () => {
    const ctx = buildCtx({
      job: {
        slug: 'system-engineer-relewant-chiasso',
        title: 'Senior System Engineer',
        company: 'Relewant',
        location: 'Chiasso',
        canton: 'TI',
        category: 'technology',
        contract: 'full-time',
        // 30 days ago — outside the "New" window
        postedDate: new Date(Date.now() - 30 * 86400000).toISOString(),
      },
      locale: 'en',
      salaryMin: NaN,
      salaryText: 'not specified',
      addressLocality: 'Chiasso',
      addressRegion: 'TI',
      postalCode: '6830',
      canonicalKeywords: ['azure', 'nutanix', 'vdi'],
      // No canonicalLocale.highlights — fallback to canonicalKeywords
    });

    it('hero badges emit nothing when no signal is true', () => {
      // featured=false, postedDate>7d, salary not finite → all three off
      expect(renderHeroBadges(ctx)).toBe('');
    });

    it('mobile action block omits the salary line when salaryMin is NaN', () => {
      const html = renderMobileActionBlock(ctx);
      expect(html).toContain('class="mobile-action-block"');
      // No salary line rendered (no `mab-salary` div)
      expect(html).not.toContain('mab-salary');
      // English labels propagate
      expect(html).toContain('Chiasso');
    });

    it('highlights falls back to canonicalKeywords when highlights is absent', () => {
      const html = renderHighlightsChips(ctx);
      expect(html).toContain('class="highlights"');
      expect(html).toContain('azure');
      expect(html).toContain('nutanix');
    });

    it('right rail omits the salary card when salaryMin is NaN', () => {
      const html = renderRightRail(ctx);
      expect(html).toContain('class="job-detail-rail"');
      expect(html).toContain('rail-card');
      // Salary card absent
      expect(html).not.toContain('rail-salary');
      // Sector still rendered (English label)
      expect(html).toContain('technology');
      // Related chips still present
      expect(html).toContain('rail-chips');
    });
  });

  describe('fixture 3: featured+new+salary, no canonical, no postal, fr locale', () => {
    const ctx = buildCtx({
      job: {
        slug: 'consultant-bigfour-geneve',
        title: 'Senior Consultant',
        company: 'BigFour',
        location: 'Genève',
        canton: 'GE',
        category: 'finance',
        contract: 'contract',
        featured: true,
        postedDate: new Date().toISOString(),
        url: 'https://bigfour.example/apply',
      },
      locale: 'fr',
      salaryMin: 130000,
      salaryText: 'CHF 130 000 - 180 000',
      addressLocality: 'Genève',
      addressRegion: 'GE',
      postalCode: '',
      canonicalKeywords: ['audit', 'IFRS'],
      localeLabels: {
        applyNow: 'Postuler',
        quickDetails: 'Détails',
        location: 'Lieu',
        contract: 'Contrat',
      },
    });

    it('hero badges show all three with French labels', () => {
      const html = renderHeroBadges(ctx);
      expect(html).toContain('★ En vedette');
      expect(html).toContain('Nouveau');
      expect(html).toContain('CHF 130 000 - 180 000');
    });

    it('mobile action block uses French labels and "Today" formatter', () => {
      const html = renderMobileActionBlock(ctx);
      expect(html).toContain('Postuler');
      expect(html).toContain('Détails');
      // Today → "Aujourd'hui" (raw apostrophe — the plugin's `esc` only
      // escapes & < > " to match the established jobsSeoPagesPlugin
      // convention; the emitter preserves that contract).
      expect(html).toContain("Aujourd'hui");
    });

    it('right rail omits the postal row when postalCode is empty', () => {
      const html = renderRightRail(ctx);
      expect(html).toContain('Ville');
      expect(html).toContain('Genève');
      expect(html).toContain('Canton');
      // No postal row
      expect(html).not.toContain('Code postal');
      // Salary card present (finite salaryMin)
      expect(html).toContain('rail-salary');
      // Sector — finance → services financiers in fr
      expect(html).toContain('services financiers');
    });
  });

  describe('emitter contracts', () => {
    it('every emitter returns a string', () => {
      const minimal = buildCtx({
        job: {},
        locale: 'it',
      });
      expect(typeof renderHeroBadges(minimal)).toBe('string');
      expect(typeof renderMobileActionBlock(minimal)).toBe('string');
      expect(typeof renderHighlightsChips(minimal)).toBe('string');
      expect(typeof renderRightRail(minimal)).toBe('string');
    });

    it('right rail returns "" when every card would be empty', () => {
      const empty = buildCtx({
        job: { category: '' },
        locale: 'it',
        addressLocality: '',
        addressRegion: '',
        postalCode: '',
        salaryMin: NaN,
        canonicalKeywords: [],
      });
      expect(renderRightRail(empty)).toBe('');
    });

    it('highlights returns "" when both sources are empty', () => {
      const empty = buildCtx({
        job: {},
        locale: 'it',
        canonicalKeywords: [],
      });
      expect(renderHighlightsChips(empty)).toBe('');
    });
  });
});
