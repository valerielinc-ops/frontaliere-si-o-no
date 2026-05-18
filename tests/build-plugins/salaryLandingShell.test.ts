import { describe, it, expect } from 'vitest';
import {
  buildSalaryLandingBody,
  _internal,
  type SalaryLocale,
} from '../../build-plugins/shared/salaryLandingShell';

describe('salaryLandingShell · resolver', () => {
  it('matches all hub paths across IT/EN/DE/FR', () => {
    const cases: Array<{ path: string; locale: SalaryLocale; eyebrowSubstr: string }> = [
      { path: '/calcola-stipendio/nuovi-frontalieri-oltre-20-km', locale: 'it', eyebrowSubstr: 'Oltre 20 km' },
      { path: '/en/calculate-salary/new-cross-border-workers-over-20km', locale: 'en', eyebrowSubstr: 'Over 20 km' },
      { path: '/de/gehalt-berechnen/neue-grenzgaenger-ueber-20-km', locale: 'de', eyebrowSubstr: 'Über 20 km' },
      { path: '/fr/calculer-salaire/nouveaux-frontaliers-plus-20-km', locale: 'fr', eyebrowSubstr: 'Plus de 20 km' },
      { path: '/calcola-stipendio/simula-busta-paga', locale: 'it', eyebrowSubstr: 'Busta paga' },
      { path: '/calcola-stipendio/cosa-cambia-se', locale: 'it', eyebrowSubstr: 'What-if' },
      { path: '/calcola-stipendio/quiz-stipendio', locale: 'it', eyebrowSubstr: 'Quiz' },
    ];
    for (const c of cases) {
      const r = _internal.resolveScenarioData(c.path);
      expect(r.locale).toBe(c.locale);
      expect(r.data.eyebrow).toContain(c.eyebrowSubstr);
    }
  });

  it('parses salary-tier paths with all variants', () => {
    const cases: Array<{ path: string; ral: number; variant: string }> = [
      { path: '/calcola-stipendio/stipendio-netto-60000-chf', ral: 60, variant: 'base' },
      { path: '/calcola-stipendio/stipendio-netto-80000-chf-nuovo-frontaliere-2026', ral: 80, variant: 'new' },
      { path: '/calcola-stipendio/stipendio-netto-100000-chf-vecchio-frontaliere', ral: 100, variant: 'old' },
      { path: '/calcola-stipendio/stipendio-netto-60000-chf-sposato-2-figli', ral: 60, variant: 'married' },
      { path: '/calcola-stipendio/stipendio-netto-80000-chf-residenza-entro-20km', ral: 80, variant: 'within20' },
      { path: '/calcola-stipendio/stipendio-netto-100000-chf-residenza-oltre-20km', ral: 100, variant: 'over20' },
    ];
    for (const c of cases) {
      const parsed = _internal.parseSalaryTierPath(c.path);
      expect(parsed).not.toBeNull();
      expect(parsed!.ral).toBe(c.ral);
      expect(parsed!.variant).toBe(c.variant);
      expect(parsed!.locale).toBe('it');
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

  it('renders English content for the EN locale variant', () => {
    const html = buildSalaryLandingBody({
      canonicalPath: '/en/calculate-salary/simulate-payslip',
      h1Text: 'Simulate Payslip',
      seoDesc: '',
      editorialHtml: '',
      navHtml: '',
    });
    expect(html).toContain('Cross-border payslip');
    expect(html).toContain('Open the simulator');
    expect(html).toContain('Frequently asked');
  });

  it('generates a coherent salary-tier table with deterministic numbers', () => {
    const html = buildSalaryLandingBody({
      canonicalPath: '/calcola-stipendio/stipendio-netto-80000-chf',
      h1Text: 'Stipendio netto 80.000 CHF',
      seoDesc: '',
      editorialHtml: '',
      navHtml: '',
    });
    // Gross row
    expect(html).toMatch(/80['. \s]?000/);
    // Net row (gross - social - source ≈ 60k)
    expect(html).toMatch(/59['. \s]?(840|800|912)/);
  });
});
