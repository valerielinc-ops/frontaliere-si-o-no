/**
 * Regression for issue 9713: the 2026 IRPEF brackets.
 *
 * Legge 30 dicembre 2025 n. 199 (legge di bilancio 2026), art. 1 c. 3, lowered
 * the second IRPEF bracket (€28,000-€50,000) from 35% to 33% starting with tax
 * year 2026. Brackets: 23% up to €28,000, 33% up to €50,000, 43% above.
 * Every case below fails if any bracket still applies 35%.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { calculateIrpefGross, irpefMarginalRate, IRPEF_BRACKETS_2026 } from '@/services/calculationService';

describe('IRPEF 2026 brackets (L. 199/2025)', () => {
  it('declares 23% / 33% / 43% with thresholds at €28,000 and €50,000', () => {
    expect(IRPEF_BRACKETS_2026.map((b) => [b.upTo, b.rate])).toEqual([
      [28000, 0.23],
      [50000, 0.33],
      [Infinity, 0.43],
    ]);
  });

  it.each([
    // [taxable base EUR, gross IRPEF EUR]
    [20000, 4600], // 20000 * 23%
    [28000, 6440], // 28000 * 23%
    [40000, 10400], // 6440 + 12000 * 33%
    [50000, 13700], // 6440 + 22000 * 33% (was 14140 with 35%)
    [60000, 18000], // 6440 + 7260 + 10000 * 43%
  ])('gross IRPEF on €%i is €%i', (base, expected) => {
    expect(calculateIrpefGross(base)).toBeCloseTo(expected, 6);
  });

  it('saves exactly 2% of the second bracket width (€440) versus the 2025 rates from €50,000 up', () => {
    const rates2025 = (x: number) => Math.min(x, 28000) * 0.23
      + Math.max(0, Math.min(x, 50000) - 28000) * 0.35
      + Math.max(0, x - 50000) * 0.43;
    for (const base of [50000, 60000, 120000]) {
      expect(rates2025(base) - calculateIrpefGross(base)).toBeCloseTo(440, 6);
    }
  });

  it('reports the marginal rate from the same table', () => {
    expect(irpefMarginalRate(20000)).toBe(0.23);
    expect(irpefMarginalRate(28000)).toBe(0.23);
    expect(irpefMarginalRate(28001)).toBe(0.33);
    expect(irpefMarginalRate(50000)).toBe(0.33);
    expect(irpefMarginalRate(50001)).toBe(0.43);
  });
});

// Site copy that states the brackets (FAQ, glossary, calculator SEO block,
// salary pages, editorial copy) must agree with IRPEF_BRACKETS_2026. The PR
// review of 9724 found a 23/35/43 sentence the first sweep missed.
describe('site copy states the 2026 IRPEF second bracket as 33%', () => {
  const root = path.resolve(__dirname, '..');
  const files = [
    'build-plugins/staticPagesPlugin.ts',
    'build-plugins/editorialContent.ts',
    'build-plugins/shared/calculatorRegimeScope.ts',
    'services/seo/seo-pages.ts',
    'services/seo/faq-translations.ts',
    'components/calculator/BonusCalculator.tsx',
    ...readdirSync(path.join(root, 'services/locales'))
      .filter((f) => /^(it|en|de|fr)-(core|stats)\.ts$/.test(f))
      .map((f) => `services/locales/${f}`),
  ];
  // "23 % ... 35 % ... 43" or "35 % up to / fino a / bis / jusqu'à € 50 000".
  const stale = [
    /23\s?%?[^0-9%]{1,40}35\s?%?[^0-9%]{1,40}43/,
    /35\s?%\s?(?:\(|fino a|up to|bis|jusqu|tra|between)[^.]{0,20}50[.,' \u2019]?000/i,
    /(?:irpef|scaglion|bracket)[^.]{0,80}\b35\s?%/i,
  ];
  // The "Marco" worked example in editorialContent.ts (it/en) is rewritten by
  // PR #9736, which recomputes the whole example from the calculator. Until it
  // lands, the old lines stay as on main so the two PRs do not conflict. The
  // match is on the pre-#9736 opening, so the exemption lapses once #9736
  // replaces those lines.
  const pendingElsewhere = [
    /^\s*'Un caso pratico: Marco, /,
    /^\s*'A practical example: Marco, /,
  ];
  it.each(files)('%s', (rel) => {
    const src = readFileSync(path.join(root, rel), 'utf8');
    const hits = src.split('\n').flatMap((line, i) =>
      stale.some((re) => re.test(line))
        && !(rel === 'build-plugins/editorialContent.ts' && pendingElsewhere.some((re) => re.test(line)))
        ? [`${rel}:${i + 1}`] : []);
    expect(hits).toEqual([]);
  });
});
