/**
 * The calculator CTA on the four FOREIGN border-municipality families states
 * which regime it computes (issue #4545 follow-up).
 *
 * The defect this locks down. `services/calculationService.ts` is hardwired to
 * the Italy-Switzerland regime — `getTicinoTaxRate`'s A/B/C/H withholding
 * tables, the Italian IRPEF brackets 23/35/43 % with addizionali, and
 * `FRANCHIGIA_NUOVI_FRONTALIERI` — and it takes no country-of-residence input,
 * so every run returns an Italian-regime net. The France, Germany, Austria and
 * Liechtenstein page families all link it as their primary CTA. A resident of
 * Lörrach following that CTA reads a number computed under someone else's tax
 * treaty, and a wrong NUMBER is believed far more readily than wrong prose —
 * the more so because those pages are otherwise careful to state each border's
 * own regime, so an unqualified calculator link contradicts its own page.
 *
 * The scope notice that prevents this shipped WITHOUT any test. Nothing turned
 * red if it was dropped from one of the four families, from one of the four
 * locales, or from the calculator page it points at — which is the failure mode
 * the sibling disclosure (`tests/avg-rent-estimate.test.ts`, #4875/#4922) exists
 * to prevent, stated there as: a disclosure that silently drops off one of
 * several surfaces is worse than none, because the reader cannot tell which
 * numbers were qualified. Same shape, same guard, applied here.
 *
 * Built on the RENDERED HTML, not on the plugin source. A source assertion
 * ("the file mentions CALCULATOR_REGIME_SCOPE_TAG") stays green for an import
 * left unused after a refactor, and green for a newly added third CTA that
 * nobody scoped. Rendering every commune in every locale and requiring the
 * notice next to a calculator link that is PROVEN PRESENT is the form that
 * fails when the user-visible page is wrong.
 *
 * Delete this file together with `build-plugins/shared/calculatorRegimeScope.ts`
 * and the `calculator.regimeScope.*` keys once the calculator accepts a
 * residence country — they all exist for the same reason.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { CALC_HREF } from '@/build-plugins/shared/calcHref';
import {
  CALCULATOR_REGIME_SCOPE_NOTICE,
  CALCULATOR_REGIME_SCOPE_TAG,
  type CalculatorScopeLocale,
} from '@/build-plugins/shared/calculatorRegimeScope';

import { renderAboveFloorPage as renderFrenchAbove, renderBridgePage as renderFrenchBridge } from '@/build-plugins/frenchBorderMunicipalityPagesPlugin';
import { renderAboveFloorPage as renderGermanAbove, renderBridgePage as renderGermanBridge } from '@/build-plugins/germanBorderMunicipalityPagesPlugin';
import { renderAboveFloorPage as renderAustrianAbove, renderBridgePage as renderAustrianBridge } from '@/build-plugins/austrianBorderMunicipalityPagesPlugin';
import { renderAboveFloorPage as renderLiechtensteinAbove, renderBridgePage as renderLiechtensteinBridge } from '@/build-plugins/liechtensteinBorderMunicipalityPagesPlugin';

import { FRENCH_ABOVE_FLOOR, FRENCH_BELOW_FLOOR, FRENCH_LOCALES } from '@/build-plugins/frenchBorderMunicipalityData';
import { GERMAN_ABOVE_FLOOR, GERMAN_BELOW_FLOOR, GERMAN_LOCALES } from '@/build-plugins/germanBorderMunicipalityData';
import { AUSTRIAN_ABOVE_FLOOR, AUSTRIAN_BELOW_FLOOR, AUSTRIAN_LOCALES } from '@/build-plugins/austrianBorderMunicipalityData';
import { LIECHTENSTEIN_ABOVE_FLOOR, LIECHTENSTEIN_BELOW_FLOOR, LIECHTENSTEIN_LOCALES } from '@/build-plugins/liechtensteinBorderMunicipalityData';

import itCalculator from '@/services/locales/it-calculator';
import enCalculator from '@/services/locales/en-calculator';
import deCalculator from '@/services/locales/de-calculator';
import frCalculator from '@/services/locales/fr-calculator';

const ROOT = path.resolve(__dirname, '..');
const DIST = '/tmp/__calculator_regime_scope_dist_does_not_exist__';
const DATE = '2026-08-06';
const LOCALES = ['it', 'en', 'de', 'fr'] as const;

/**
 * The shipped HTML is minified, so whitespace runs collapse and cannot be
 * matched literally. `esc()` in the plugins escapes only & < > " — apostrophes
 * and accents survive verbatim — so normalising whitespace is enough to compare
 * a notice against the page that carries it.
 */
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

interface Family {
  name: string;
  locales: readonly string[];
  above: readonly { slug: string }[];
  below: readonly { slug: string }[];
  renderAbove: (m: never, locale: never) => string;
  renderBridge: (m: never, locale: never) => string;
}

const FAMILIES: Family[] = [
  {
    name: 'France',
    locales: FRENCH_LOCALES,
    above: FRENCH_ABOVE_FLOOR,
    below: FRENCH_BELOW_FLOOR,
    renderAbove: ((m, locale) => renderFrenchAbove({ municipality: m, locale, dateStamp: DATE, distDir: DIST }).html) as Family['renderAbove'],
    renderBridge: ((m, locale) => renderFrenchBridge({ municipality: m, locale, distDir: DIST })) as Family['renderBridge'],
  },
  {
    name: 'Germany',
    locales: GERMAN_LOCALES,
    above: GERMAN_ABOVE_FLOOR,
    below: GERMAN_BELOW_FLOOR,
    renderAbove: ((m, locale) => renderGermanAbove({ municipality: m, locale, dateStamp: DATE, distDir: DIST }).html) as Family['renderAbove'],
    renderBridge: ((m, locale) => renderGermanBridge({ municipality: m, locale, distDir: DIST })) as Family['renderBridge'],
  },
  {
    name: 'Austria',
    locales: AUSTRIAN_LOCALES,
    above: AUSTRIAN_ABOVE_FLOOR,
    below: AUSTRIAN_BELOW_FLOOR,
    renderAbove: ((m, locale) => renderAustrianAbove({ municipality: m, locale, dateStamp: DATE, distDir: DIST }).html) as Family['renderAbove'],
    renderBridge: ((m, locale) => renderAustrianBridge({ municipality: m, locale, distDir: DIST })) as Family['renderBridge'],
  },
  {
    name: 'Liechtenstein',
    locales: LIECHTENSTEIN_LOCALES,
    above: LIECHTENSTEIN_ABOVE_FLOOR,
    below: LIECHTENSTEIN_BELOW_FLOOR,
    renderAbove: ((m, locale) => renderLiechtensteinAbove({ municipality: m, locale, dateStamp: DATE, distDir: DIST }).html) as Family['renderAbove'],
    renderBridge: ((m, locale) => renderLiechtensteinBridge({ municipality: m, locale, distDir: DIST })) as Family['renderBridge'],
  },
];

interface Page { label: string; locale: CalculatorScopeLocale; html: string; kind: 'above' | 'bridge' }

/** Rendered once and shared: ~170 communes x 4 locales is not free. */
const PAGES: Page[] = FAMILIES.flatMap((family) =>
  family.locales.flatMap((locale) => [
    ...family.above.map((m) => ({
      label: `${family.name}/${m.slug}/${locale}`,
      locale: locale as CalculatorScopeLocale,
      html: flat(family.renderAbove(m as never, locale as never)),
      kind: 'above' as const,
    })),
    ...family.below.map((m) => ({
      label: `${family.name}/${m.slug}/${locale} (bridge)`,
      locale: locale as CalculatorScopeLocale,
      html: flat(family.renderBridge(m as never, locale as never)),
      kind: 'bridge' as const,
    })),
  ]),
);

describe('the corpus under test is real (nothing below can pass vacuously)', () => {
  it('renders pages for all four families in all four locales', () => {
    expect(PAGES.length).toBeGreaterThan(400);
    for (const family of FAMILIES) {
      expect(family.above.length, `${family.name} has no above-floor communes`).toBeGreaterThan(0);
      expect([...family.locales].sort()).toEqual([...LOCALES].sort());
    }
  });

  it('every page really does link the calculator', () => {
    // The assertions below are "wherever the calculator is linked, it is
    // scoped". Without this one, deleting the CTA entirely would satisfy them.
    for (const page of PAGES) {
      expect(page.html, `${page.label} does not link the calculator`).toContain(CALC_HREF[page.locale]);
    }
  });
});

describe('every foreign border page scopes the calculator it links', () => {
  it('tags the CTA itself, so the regime is visible before the click', () => {
    const missing = PAGES.filter((p) => !p.html.includes(flat(CALCULATOR_REGIME_SCOPE_TAG[p.locale])));
    expect(missing.map((p) => p.label)).toEqual([]);
  });

  it('carries the full notice on the main guide pages', () => {
    const missing = PAGES.filter(
      (p) => p.kind === 'above' && !p.html.includes(flat(CALCULATOR_REGIME_SCOPE_NOTICE[p.locale])),
    );
    expect(missing.map((p) => p.label)).toEqual([]);
  });

  it('places the notice on the page in the reader\'s own language', () => {
    // A German page carrying the Italian notice would satisfy a naive
    // "contains some notice" check while telling the reader nothing.
    for (const page of PAGES.filter((p) => p.kind === 'above')) {
      for (const other of LOCALES) {
        if (other === page.locale) continue;
        expect(
          page.html.includes(flat(CALCULATOR_REGIME_SCOPE_NOTICE[other])),
          `${page.label} carries the ${other} notice`,
        ).toBe(false);
      }
    }
  });
});

describe('the notice tables are complete and say what they must', () => {
  it.each(LOCALES)('%s notice and tag are present and non-trivial', (locale) => {
    expect(CALCULATOR_REGIME_SCOPE_NOTICE[locale].length).toBeGreaterThan(60);
    expect(CALCULATOR_REGIME_SCOPE_TAG[locale].length).toBeGreaterThan(10);
  });

  it('is translated, not duplicated, across the four locales', () => {
    expect(new Set(LOCALES.map((l) => CALCULATOR_REGIME_SCOPE_NOTICE[l])).size).toBe(4);
    expect(new Set(LOCALES.map((l) => CALCULATOR_REGIME_SCOPE_TAG[l])).size).toBe(4);
  });

  it('names BOTH countries of the regime the calculator actually implements', () => {
    // The whole point is telling the reader which treaty produced the number.
    // A notice softened to "results are indicative" would pass a length check
    // and fail the reader; naming Italy and Switzerland is the checkable part.
    const ITALY = /itali|italy/i;
    const SWISS = /svizzer|switzerland|schweiz|suisse/i;
    for (const locale of LOCALES) {
      expect(CALCULATOR_REGIME_SCOPE_NOTICE[locale], `${locale} notice`).toMatch(ITALY);
      expect(CALCULATOR_REGIME_SCOPE_NOTICE[locale], `${locale} notice`).toMatch(SWISS);
      expect(CALCULATOR_REGIME_SCOPE_TAG[locale], `${locale} tag`).toMatch(ITALY);
      expect(CALCULATOR_REGIME_SCOPE_TAG[locale], `${locale} tag`).toMatch(SWISS);
    }
  });
});

describe('the calculator the CTA lands on repeats the scope', () => {
  // Source-level, because the destination is a React tab deep in the SPA
  // shell. Kept narrow: the key and the test id, both of which a removal or a
  // rename would take with it.
  const CALC_TAB = path.join(ROOT, 'components/tabs/CalcolatoreTabContent.tsx');

  it('renders the regime-scope paragraph', () => {
    const src = fs.readFileSync(CALC_TAB, 'utf-8');
    expect(src).toContain('calculator.regimeScope.notice');
    expect(src).toContain('data-testid="calculator-regime-scope"');
  });

  it.each([
    ['it', itCalculator],
    ['en', enCalculator],
    ['de', deCalculator],
    ['fr', frCalculator],
  ] as const)('%s defines the key the calculator renders', (_locale, table) => {
    const notice = table['calculator.regimeScope.notice'];
    expect(notice, 'missing calculator.regimeScope.notice').toBeTruthy();
    expect(notice.length).toBeGreaterThan(60);
    expect(notice).toMatch(/itali|italy/i);
    expect(notice).toMatch(/svizzer|switzerland|schweiz|suisse/i);
  });

  it('names the countries the calculator does NOT cover', () => {
    // The four families that link here. If a fifth regime is ever added, this
    // is the line that should force the copy to be revisited.
    for (const table of [itCalculator, enCalculator, deCalculator, frCalculator]) {
      const notice = table['calculator.regimeScope.notice'];
      expect(notice).toMatch(/franc|frankreich/i);
      expect(notice).toMatch(/german|deutschland|allemagne|germania/i);
      expect(notice).toMatch(/austri|österreich|autriche/i);
      expect(notice).toMatch(/liechtenstein/i);
    }
  });
});
