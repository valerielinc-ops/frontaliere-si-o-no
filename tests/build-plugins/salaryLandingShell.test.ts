import { describe, it, expect } from 'vitest';
import {
  buildSalaryLandingBody,
  _internal,
  type SalaryLocale,
} from '../../build-plugins/shared/salaryLandingShell';

describe('salaryLandingShell · resolver', () => {
  it('matches every IT hub path emitted under /calcola-stipendio/* (per sitemap-pages.xml)', () => {
    const cases: Array<{ path: string; eyebrowSubstr: string }> = [
      { path: '/calcola-stipendio/nuovi-frontalieri-oltre-20-km', eyebrowSubstr: 'Oltre 20 km' },
      { path: '/calcola-stipendio/simula-busta-paga', eyebrowSubstr: 'Busta paga' },
      { path: '/calcola-stipendio/cosa-cambia-se', eyebrowSubstr: 'What-if' },
      { path: '/calcola-stipendio/confronta-retribuzione-ral', eyebrowSubstr: 'Da RAL' },
      { path: '/calcola-stipendio/quanto-guadagneresti-in-svizzera', eyebrowSubstr: 'Quiz' },
      { path: '/calcola-stipendio/simula-cambio-residenza', eyebrowSubstr: 'Simulatore residenza' },
      { path: '/calcola-stipendio/stima-bonus-frontaliere', eyebrowSubstr: 'Bonus' },
      { path: '/calcola-stipendio/verifica-congedo-parentale', eyebrowSubstr: 'Congedo parentale' },
    ];
    for (const c of cases) {
      const r = _internal.resolveScenarioData(c.path);
      expect(r.locale).toBe('it');
      expect(r.data.eyebrow).toContain(c.eyebrowSubstr);
    }
  });

  it('parses salary-tier paths with all variants (IT) and 4-locale prefixes', () => {
    const cases: Array<{ path: string; ral: number; variant: string; locale: SalaryLocale }> = [
      { path: '/calcola-stipendio/stipendio-netto-60000-chf', ral: 60, variant: 'base', locale: 'it' },
      { path: '/calcola-stipendio/stipendio-netto-80000-chf-nuovo-frontaliere-2026', ral: 80, variant: 'new', locale: 'it' },
      { path: '/calcola-stipendio/stipendio-netto-100000-chf-vecchio-frontaliere', ral: 100, variant: 'old', locale: 'it' },
      { path: '/calcola-stipendio/stipendio-netto-60000-chf-sposato-2-figli', ral: 60, variant: 'married', locale: 'it' },
      { path: '/calcola-stipendio/stipendio-netto-80000-chf-residenza-entro-20km', ral: 80, variant: 'within20', locale: 'it' },
      { path: '/calcola-stipendio/stipendio-netto-100000-chf-residenza-oltre-20km', ral: 100, variant: 'over20', locale: 'it' },
      { path: '/en/calculate-salary/net-salary-80000-chf-married-2-children', ral: 80, variant: 'married', locale: 'en' },
      { path: '/de/gehalt-berechnen/nettogehalt-100000-chf-wohnsitz-bis-20km', ral: 100, variant: 'within20', locale: 'de' },
      { path: '/fr/calculer-salaire/salaire-net-60000-chf-ancien-frontalier', ral: 60, variant: 'old', locale: 'fr' },
    ];
    for (const c of cases) {
      const parsed = _internal.parseSalaryTierPath(c.path);
      expect(parsed).not.toBeNull();
      expect(parsed!.ral).toBe(c.ral);
      expect(parsed!.variant).toBe(c.variant);
      expect(parsed!.locale).toBe(c.locale);
    }
  });

  it('resolves all 4 IT net-comparison scenarios (URLs only emitted in IT)', () => {
    const cases: Array<{ path: string; eyebrowSubstr: string }> = [
      { path: '/calcola-stipendio/confronto-netto-2025-2026-entro-20km', eyebrowSubstr: 'Entro 20 km' },
      { path: '/calcola-stipendio/confronto-netto-2025-2026-oltre-20km', eyebrowSubstr: 'Oltre 20 km' },
      { path: '/calcola-stipendio/confronto-permesso-g-vs-b-entro-20km', eyebrowSubstr: 'Permesso G vs B' },
      { path: '/calcola-stipendio/confronto-permesso-g-vs-b-oltre-20km', eyebrowSubstr: 'Permesso G vs B' },
    ];
    for (const c of cases) {
      const r = _internal.resolveScenarioData(c.path);
      expect(r.locale).toBe('it');
      expect(r.data.eyebrow).toContain(c.eyebrowSubstr);
      expect(r.data.table?.headers.length).toBe(4);
      expect(r.data.tiles.length).toBe(4);
      expect(r.data.faqs?.length).toBe(3);
    }
  });

  it('falls back to a localised generic default for unknown calcola-stipendio paths', () => {
    const r = _internal.resolveScenarioData('/calcola-stipendio/nonexistent');
    expect(r.locale).toBe('it');
    expect(r.data.tiles.length).toBeGreaterThan(0);
    expect(r.data.ctaPrimary.href).toMatch(/calcola-stipendio/);
  });

  it('honours locale prefix detection in the default branch', () => {
    const cases: Array<{ path: string; locale: SalaryLocale; ctaHref: string }> = [
      { path: '/calcola-stipendio/anything', locale: 'it', ctaHref: '/calcola-stipendio/' },
      { path: '/en/calculate-salary/anything', locale: 'en', ctaHref: '/en/calculate-salary/' },
      { path: '/de/gehalt-berechnen/anything', locale: 'de', ctaHref: '/de/gehalt-berechnen/' },
      { path: '/fr/calculer-salaire/anything', locale: 'fr', ctaHref: '/fr/calculer-salaire/' },
    ];
    for (const c of cases) {
      const r = _internal.resolveScenarioData(c.path);
      expect(r.locale).toBe(c.locale);
      expect(r.data.ctaPrimary.href).toBe(c.ctaHref);
    }
  });
});

describe('salaryLandingShell · buildSalaryLandingBody', () => {
  it('emits breadcrumb + eyebrow + H1 + lede + tiles + advice + CTA + table + FAQ + prose', () => {
    const html = buildSalaryLandingBody({
      canonicalPath: '/calcola-stipendio/nuovi-frontalieri-oltre-20-km',
      h1Text: 'Calcolo Tasse Frontalieri Oltre 20 km',
      seoDesc: 'desc',
      editorialHtml: '<p>extra prose</p>',
      navHtml: '<a href="/">Home</a>',
    });
    expect(html).toContain('aria-label="breadcrumb"');
    expect(html).toContain('Nuovo Accordo 2024');
    expect(html).toContain('Calcolo Tasse Frontalieri Oltre 20 km');
    expect(html).toContain('Tassazione concorrente');
    expect(html).toContain('Imposta alla fonte CH');
    expect(html).toContain('Consiglio');
    expect(html).toContain('Calcola il tuo netto');
    expect(html).toContain('<table');
    expect(html).toContain('<details');
    expect(html).toContain('Domande frequenti');
    expect(html).toContain('extra prose');
  });

  it('uses semantic OKLCH tokens, never hardcoded hex colors', () => {
    const html = buildSalaryLandingBody({
      canonicalPath: '/calcola-stipendio/simula-busta-paga',
      h1Text: 'Simula busta paga',
      seoDesc: '',
      editorialHtml: '',
      navHtml: '',
    });
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(html).toContain('var(--color-');
  });

  it('generates a coherent salary-tier table with deterministic numbers (IT)', () => {
    const html = buildSalaryLandingBody({
      canonicalPath: '/calcola-stipendio/stipendio-netto-80000-chf',
      h1Text: 'Stipendio netto 80.000 CHF',
      seoDesc: '',
      editorialHtml: '',
      navHtml: '',
    });
    expect(html).toMatch(/80['. \s]?000/);
    expect(html).toMatch(/59['. \s]?(840|800|912)/);
  });

  it('shipsh bespoke data for the 4 new orphan hubs', () => {
    for (const slug of ['simula-cambio-residenza', 'stima-bonus-frontaliere', 'verifica-congedo-parentale', 'quanto-guadagneresti-in-svizzera']) {
      const html = buildSalaryLandingBody({
        canonicalPath: `/calcola-stipendio/${slug}`,
        h1Text: slug,
        seoDesc: '',
        editorialHtml: '',
        navHtml: '',
      });
      expect(html).toContain('aria-label="breadcrumb"');
      expect(html).toContain('clamp(1.8rem');
      expect(html).toContain('minmax(180px,1fr)');
      expect(html).toContain('<table');
      expect(html).toContain('<details');
    }
  });
});
