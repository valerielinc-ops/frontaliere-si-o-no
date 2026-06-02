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

  it('resolves all 4 net-comparison scenarios in IT (canonical paths)', () => {
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

  // Regression guard for the 2026-05-19 bug: parseNetComparisonPath
  // previously returned null for every non-IT variant, dropping all 12
  // EN/DE/FR scenario URLs into the generic default branch. The sitemap
  // declares hreflang alternates in all 4 locales and dist/ emits HTML
  // for each — the resolver must keep all 16 mappings in sync with
  // services/router.ts REVERSE_SALARY_SUBTAB_BY_LOCALE.
  it('resolves all 4 net-comparison scenarios across EN, DE, FR', () => {
    const cases: Array<{ path: string; locale: SalaryLocale }> = [
      // confronto-netto-2025-2026-entro-20km
      { path: '/en/calculate-salary/net-comparison-2025-2026-within-20km', locale: 'en' },
      { path: '/de/gehalt-berechnen/nettovergleich-2025-2026-bis-20km', locale: 'de' },
      { path: '/fr/calculer-salaire/comparaison-net-2025-2026-moins-20km', locale: 'fr' },
      // confronto-netto-2025-2026-oltre-20km
      { path: '/en/calculate-salary/net-comparison-2025-2026-over-20km', locale: 'en' },
      { path: '/de/gehalt-berechnen/nettovergleich-2025-2026-ueber-20km', locale: 'de' },
      { path: '/fr/calculer-salaire/comparaison-net-2025-2026-plus-20km', locale: 'fr' },
      // confronto-permesso-g-vs-b-entro-20km
      { path: '/en/calculate-salary/permit-g-vs-b-comparison-within-20km', locale: 'en' },
      { path: '/de/gehalt-berechnen/vergleich-bewilligung-g-vs-b-bis-20km', locale: 'de' },
      { path: '/fr/calculer-salaire/comparaison-permis-g-vs-b-moins-20km', locale: 'fr' },
      // confronto-permesso-g-vs-b-oltre-20km
      { path: '/en/calculate-salary/permit-g-vs-b-comparison-over-20km', locale: 'en' },
      { path: '/de/gehalt-berechnen/vergleich-bewilligung-g-vs-b-ueber-20km', locale: 'de' },
      { path: '/fr/calculer-salaire/comparaison-permis-g-vs-b-plus-20km', locale: 'fr' },
    ];
    for (const c of cases) {
      const r = _internal.resolveScenarioData(c.path);
      expect(r.locale, `wrong locale for ${c.path}`).toBe(c.locale);
      // The shell must serve the net-comparison template (4-column table
      // + 4 tiles + 3 FAQs), not the generic default that would otherwise
      // catch unknown paths under /{locale}/{salary-hub}/anything.
      expect(r.data.table?.headers.length, `missing comparison table for ${c.path}`).toBe(4);
      expect(r.data.tiles.length, `wrong tile count for ${c.path}`).toBe(4);
      expect(r.data.faqs?.length, `wrong FAQ count for ${c.path}`).toBe(3);
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
    expect(html).toContain('oltre 20 km dal confine');
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
    // Net is now derived from calculateSimulation (single-A0 base variant,
    // WITHIN_20KM): CHF 48'156 net / EUR 52'779, matching the over-20km hub.
    expect(html).toMatch(/48['. \s]?156/);
    expect(html).toMatch(/52['. \s]?779/);
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
      // Class-extract migration (2026-05-20): inline `style="..."` for the
      // hero clamp font + the 180px auto-fit grid moved to content-hashed
      // classes in public/assets/seo-static.css. Both the CSS rule body and
      // the live rendered class reference are checked so a future hash
      // churn does not silently mask a style removal.
      const cssRules = require('node:fs').readFileSync(
        require('node:path').resolve(__dirname, '..', '..', 'public', 'assets', 'seo-static.css'),
        'utf-8',
      );
      const classMatches = new Set([...html.matchAll(/class="(?:[^"]* )?(s-[A-Za-z0-9_-]+)/g)].map(m => m[1]));
      const hasRule = (snippet: string) => {
        if (html.includes(snippet)) return true;
        return [...classMatches].some((c) => {
          const escapedSnippet = snippet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const rule = new RegExp(`\\.${c}\\s*\\{[^}]*${escapedSnippet}`);
          return rule.test(cssRules);
        });
      };
      expect(hasRule('clamp(1.8rem'), 'clamp(1.8rem) rule missing from inline html and extracted classes').toBe(true);
      expect(hasRule('minmax(180px,1fr)'), 'minmax(180px,1fr) rule missing from inline html and extracted classes').toBe(true);
      expect(html).toContain('<table');
      expect(html).toContain('<details');
    }
  });
});

describe('salaryLandingShell · salary-tier variants derive from calculateSimulation', () => {
  const VARIANTS = ['base', 'new', 'old', 'married', 'within20', 'over20'] as const;

  it('decomposition reconciles (net == gross - social - source - italian) and uses the real FX rate 1.096', () => {
    for (const ral of [60000, 80000, 100000, 120000]) {
      for (const variant of VARIANTS) {
        const d = _internal.tierDecomposition(ral, variant);
        // Real exchange rate, not the old fabricated 1.05.
        expect(d.fx).toBeCloseTo(1.096, 3);
        // The CHF decomposition reconciles exactly (rounding tolerance ±2 CHF).
        expect(Math.abs(d.gross - d.social - d.source - d.italian - d.net)).toBeLessThanOrEqual(2);
        // `married` (2 children) is the only variant whose gross exceeds the RAL
        // by the CH family allowance (CHF 3.000/child); all others gross == RAL.
        if (variant === 'married') {
          expect(d.allowance).toBe(6000);
          expect(d.gross).toBe(ral + 6000);
        } else {
          expect(d.allowance).toBe(0);
          expect(d.gross).toBe(ral);
        }
        // `old` (Swiss-exclusive regime) has no residual Italian IRPEF.
        if (variant === 'old') expect(d.italian).toBe(0);
      }
    }
  });

  it('does NOT use the removed fabricated flat deltas (within20:+1500 / over20:-1500 / married:+2800 / old:+1200)', () => {
    // Old heuristic net for RAL 80k: gross - 15% social - 12%-of-remainder source.
    const ral = 80000;
    const heurSocial = Math.round(ral * 0.15);
    const heurSource = Math.round((ral - heurSocial) * 0.12);
    const heurBaseNet = ral - heurSocial - heurSource;
    const fabricated: Record<string, number> = {
      old: heurBaseNet + 1200,
      married: heurBaseNet + 2800,
      within20: heurBaseNet + 1500,
      over20: heurBaseNet - 1500,
    };
    for (const [variant, fab] of Object.entries(fabricated)) {
      const d = _internal.tierDecomposition(ral, variant as typeof VARIANTS[number]);
      // The real calc must diverge from the fabricated heuristic by a meaningful
      // margin (the worst offender, `married`, was ~16% too high).
      expect(Math.abs(d.net - fab)).toBeGreaterThan(300);
    }
  });

  it('old net (no IT IRPEF) exceeds new net at the same RAL, married reflects allowance + Table C', () => {
    const ral = 80000;
    const newNet = _internal.tierDecomposition(ral, 'new').net;
    const oldNet = _internal.tierDecomposition(ral, 'old').net;
    const marriedNet = _internal.tierDecomposition(ral, 'married').net;
    expect(oldNet).toBeGreaterThan(newNet); // grandfathered keeps more
    // Spot-check the exact calculator-derived figures (guards against drift).
    expect(oldNet).toBe(61840);
    expect(marriedNet).toBe(53888);
  });

  it('table caption is variant-aware (no "single A0" on old/married pages)', () => {
    const old = _internal.buildSalaryTierData({ ral: 80, variant: 'old' }, 'it');
    const married = _internal.buildSalaryTierData({ ral: 80, variant: 'married' }, 'it');
    const base = _internal.buildSalaryTierData({ ral: 80, variant: 'base' }, 'it');
    expect(base.table.caption).toContain('single A0');
    expect(old.table.caption).toContain('Vecchio frontaliere');
    expect(old.table.caption).not.toContain('single A0');
    expect(married.table.caption).toContain('Sposato 2 figli');
    expect(married.table.caption).not.toContain('single A0');
    // Married gross row owns the family-allowance label and a gross > RAL.
    expect(married.table.rows[0].cells[0]).toContain('assegni familiari');
  });

  it('over-20km hub table delta equals the difference of the two rounded cells (no visible arithmetic contradiction)', () => {
    for (const row of _internal.OVER20_ROWS) {
      expect(row.delta).toBe(row.over - row.within);
    }
  });
});
