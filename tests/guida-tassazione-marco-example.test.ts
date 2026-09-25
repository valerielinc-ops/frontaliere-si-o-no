// Regression guard for #9733: the "Marco" worked example on the taxation pillar
// page (/guida-tassazione-frontalieri-2026, build-plugins/editorialContent.ts)
// claimed an Italian IRPEF balance of EUR 2,000-5,000, while its own inputs give
// roughly EUR 18,000. The example's hypotheses (salary, Swiss tax, exchange
// rate, exemption) are read from the published prose, and every derived figure
// is recomputed with the site's calculation service: no result is copied here
// by hand, so the prose cannot drift from the calculator again. When the
// service changes a bracket (e.g. #9713 / PR #9724, 35% -> 33%) this test fails
// until the published figures are recomputed.
import { describe, expect, it } from 'vitest';
import { SECTION_EDITORIAL } from '../build-plugins/editorialContent';
import { calculateIrpefGross, calculateProportionalTaxCredit } from '../services/calculationService';
import { FRANCHIGIA_NUOVI_FRONTALIERI } from '../constants';

const PAGE = '/guida-tassazione-frontalieri-2026';

// Bracket rates as the service applies them, derived from calculateIrpefGross
// itself rather than re-declared.
const rateBetween = (from: number, to: number) =>
  (calculateIrpefGross(to) - calculateIrpefGross(from)) / (to - from);
const serviceRatesLabel = [rateBetween(0, 28000), rateBetween(28000, 50000), rateBetween(50000, 60000)]
  .map((r) => Math.round(r * 100))
  .join('-') + '%';

// The example declares "circa"/"about" figures rounded to the hundred.
const round100 = (n: number) => Math.round(n / 100) * 100;

interface LocaleSpec {
  locale: 'it' | 'en';
  marker: string;
  thousands: string;
  decimal: string;
  // Each pattern captures one hypothesis stated in the prose.
  salaryCHF: RegExp;
  swissTaxCHF: RegExp;
  chfPerEur: RegExp;
  exemptionEUR: RegExp;
}

const LOCALES: LocaleSpec[] = [
  {
    locale: 'it',
    marker: 'Un caso pratico',
    thousands: '.',
    decimal: ',',
    salaryCHF: /salario lordo CHF ([\d.]+)/,
    swissTaxCHF: /CHF ([\d.]+) di imposta alla fonte/,
    chfPerEur: /cambio di (\d+,\d+) CHF per 1 EUR/,
    exemptionEUR: /([\d.]+) EUR di franchigia/,
  },
  {
    locale: 'en',
    marker: 'A practical example',
    thousands: ',',
    decimal: '.',
    salaryCHF: /CHF ([\d,]+) gross salary/,
    swissTaxCHF: /CHF ([\d,]+) of Swiss withholding tax/,
    chfPerEur: /exchange rate of CHF (\d+\.\d+) per EUR 1/,
    exemptionEUR: /([\d,]+) EUR exemption/,
  },
];

function example({ locale, marker }: LocaleSpec): string {
  const paragraphs = SECTION_EDITORIAL[PAGE]?.[locale] ?? [];
  const found = paragraphs.filter((p) => p.startsWith(marker) && p.includes('Marco'));
  expect(found, `${locale}: exactly one Marco example`).toHaveLength(1);
  return found[0];
}

function parseNumber(raw: string, spec: LocaleSpec): number {
  return Number(raw.split(spec.thousands).join('').replace(spec.decimal, '.'));
}

function capture(text: string, re: RegExp, spec: LocaleSpec): number {
  const m = text.match(re);
  expect(m, `${spec.locale}: ${re} not found in the Marco example`).not.toBeNull();
  const value = parseNumber(m![1], spec);
  expect(Number.isFinite(value), `${spec.locale}: ${re} captured "${m![1]}"`).toBe(true);
  return value;
}

function fmt(n: number, spec: LocaleSpec): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, spec.thousands);
}

function recompute(spec: LocaleSpec) {
  const text = example(spec);
  const salaryCHF = capture(text, spec.salaryCHF, spec);
  const swissTaxCHF = capture(text, spec.swissTaxCHF, spec);
  const chfPerEur = capture(text, spec.chfPerEur, spec);
  const exemptionEUR = capture(text, spec.exemptionEUR, spec);

  const grossIncomeEUR = salaryCHF / chfPerEur;
  const swissTaxEUR = swissTaxCHF / chfPerEur;
  const taxableBaseEUR = grossIncomeEUR - exemptionEUR;
  const irpefGrossEUR = calculateIrpefGross(taxableBaseEUR);
  const creditEUR = calculateProportionalTaxCredit(swissTaxEUR, taxableBaseEUR, grossIncomeEUR);
  return {
    text,
    inputs: { salaryCHF, swissTaxCHF, chfPerEur, exemptionEUR },
    grossIncomeEUR,
    swissTaxEUR,
    taxableBaseEUR,
    irpefGrossEUR,
    creditEUR,
    balanceEUR: irpefGrossEUR - creditEUR,
  };
}

describe('taxation guide: Marco worked example matches the calculator (#9733)', () => {
  it('only IT and EN carry the example (DE/FR have no Marco paragraph to keep in sync)', () => {
    const section = SECTION_EDITORIAL[PAGE];
    const withMarco = Object.keys(section).filter((l) => section[l].some((p) => p.includes('Marco')));
    expect(withMarco.sort()).toEqual(['en', 'it']);
  });

  it('IT and EN state the same hypotheses, and the exemption is the one the calculator applies', () => {
    const [itInputs, enInputs] = LOCALES.map((spec) => recompute(spec).inputs);
    expect(enInputs).toEqual(itInputs);
    expect(itInputs.exemptionEUR).toBe(FRANCHIGIA_NUOVI_FRONTALIERI);
  });

  it.each(LOCALES)('$locale: every printed figure is recomputed from the service', (spec) => {
    const r = recompute(spec);
    const eur = (n: number) => `EUR ${fmt(n, spec)}`;

    expect(r.text).toContain(eur(r.grossIncomeEUR));
    expect(r.text).toContain(eur(r.taxableBaseEUR));
    expect(r.text).toContain(eur(r.swissTaxEUR));
    expect(r.text).toContain(`${fmt(r.taxableBaseEUR, spec)} ÷ ${fmt(r.grossIncomeEUR, spec)}`);
    expect(r.text).toContain(serviceRatesLabel);
    expect(r.text).toContain(eur(round100(r.irpefGrossEUR)));
    expect(r.text).toContain(eur(round100(r.creditEUR)));
    expect(r.text).toContain(eur(round100(r.balanceEUR)));
    expect(r.text).not.toMatch(/2[.,]000-5[.,]000/);
  });

  it('the recomputed balance is far from the old 2,000-5,000 claim', () => {
    expect(recompute(LOCALES[0]).balanceEUR).toBeGreaterThan(5000 * 3);
  });
});
