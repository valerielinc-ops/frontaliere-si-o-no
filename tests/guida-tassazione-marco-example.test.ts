// Regression guard for #9733: the "Marco" worked example on the taxation pillar
// page (/guida-tassazione-frontalieri-2026, build-plugins/editorialContent.ts)
// claimed an Italian IRPEF balance of EUR 2,000-5,000, while its own inputs give
// roughly EUR 18,000. Every figure printed in the example is recomputed here from
// the site's calculation service, so the published prose cannot drift from the
// calculator again.
import { describe, expect, it } from 'vitest';
import { SECTION_EDITORIAL } from '../build-plugins/editorialContent';
import { calculateIrpefGross, calculateProportionalTaxCredit } from '../services/calculationService';
import { FRANCHIGIA_NUOVI_FRONTALIERI } from '../constants';

// Hypotheses stated in the example itself.
const GROSS_SALARY_CHF = 84000;
const SWISS_SOURCE_TAX_CHF = 7800;
const CHF_PER_EUR = 0.96;

// 2026 IRPEF brackets (art. 11 TUIR as amended by L. 199/2025): 23% up to
// EUR 28,000, 33% up to EUR 50,000, 43% above. The service switches the middle
// bracket from 35% to 33% in PR #9724 (#9713); until then only the middle
// slice is computed from the declared 2026 rate, the other two come from the
// service and the strict equality check below is skipped.
const LOWER_THRESHOLD = 28000;
const UPPER_THRESHOLD = 50000;
const MIDDLE_RATE_2026 = 0.33;
const serviceMiddleRate =
  (calculateIrpefGross(UPPER_THRESHOLD) - calculateIrpefGross(LOWER_THRESHOLD)) /
  (UPPER_THRESHOLD - LOWER_THRESHOLD);

const grossIncomeEUR = GROSS_SALARY_CHF / CHF_PER_EUR;
const swissTaxEUR = SWISS_SOURCE_TAX_CHF / CHF_PER_EUR;
const taxableBaseEUR = grossIncomeEUR - FRANCHIGIA_NUOVI_FRONTALIERI;
const irpefGrossEUR =
  calculateIrpefGross(LOWER_THRESHOLD) +
  (UPPER_THRESHOLD - LOWER_THRESHOLD) * MIDDLE_RATE_2026 +
  (calculateIrpefGross(taxableBaseEUR) - calculateIrpefGross(UPPER_THRESHOLD));
const creditEUR = calculateProportionalTaxCredit(swissTaxEUR, taxableBaseEUR, grossIncomeEUR);
const balanceEUR = irpefGrossEUR - creditEUR;

// The example declares "circa"/"about" figures rounded to the hundred.
const round100 = (n: number) => Math.round(n / 100) * 100;
const fmt = (n: number, sep: string) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, sep);

const LOCALES = [
  { locale: 'it', marker: 'Un caso pratico', sep: '.' },
  { locale: 'en', marker: 'A practical example', sep: ',' },
] as const;

function example(locale: string, marker: string): string {
  const paragraphs = SECTION_EDITORIAL['/guida-tassazione-frontalieri-2026']?.[locale] ?? [];
  const found = paragraphs.filter((p) => p.startsWith(marker) && p.includes('Marco'));
  expect(found, `${locale}: exactly one Marco example`).toHaveLength(1);
  return found[0];
}

describe('taxation guide: Marco worked example matches the calculator (#9733)', () => {
  it('only IT and EN carry the example (DE/FR have no Marco paragraph to keep in sync)', () => {
    const section = SECTION_EDITORIAL['/guida-tassazione-frontalieri-2026'];
    const withMarco = Object.keys(section).filter((l) => section[l].some((p) => p.includes('Marco')));
    expect(withMarco.sort()).toEqual(['en', 'it']);
  });

  it.each(LOCALES)('$locale: every printed figure is recomputed from the service', ({ locale, marker, sep }) => {
    const text = example(locale, marker);
    const eur = (n: number) => `EUR ${fmt(n, sep)}`;

    expect(text).toContain(eur(grossIncomeEUR)); // 87,500
    expect(text).toContain(eur(taxableBaseEUR)); // 77,500
    expect(text).toContain(eur(swissTaxEUR)); // 8,125
    expect(text).toContain('23-33-43%');
    expect(text).toContain(eur(round100(irpefGrossEUR))); // ~25,500
    expect(text).toContain(eur(round100(creditEUR))); // ~7,200
    expect(text).toContain(eur(round100(balanceEUR))); // ~18,300
    expect(text).not.toMatch(/2[.,]000-5[.,]000/);
    expect(text).not.toContain('23-35-43%');
  });

  it('the recomputed balance is far from the old 2,000-5,000 claim', () => {
    expect(balanceEUR).toBeGreaterThan(5000 * 3);
  });

  it.skipIf(serviceMiddleRate === 0.35)(
    'the service applies the 2026 middle bracket declared by the example (active once #9724 lands)',
    () => {
      expect(serviceMiddleRate).toBeCloseTo(MIDDLE_RATE_2026, 10);
      expect(calculateIrpefGross(taxableBaseEUR)).toBeCloseTo(irpefGrossEUR, 6);
    },
  );
});
