/**
 * health-premiums-text-ratio.test.ts
 *
 * Regression test for the "low text-to-HTML ratio" Semrush gate on F2 LAMal
 * landing pages (build-plugins/healthPremiumsLandingPlugin.ts). Apr 2026
 * audit found 485 health-premium pages below the 10 % threshold; the fix
 * added two new methodology blocks to the root hub
 * (`rootDeductibleAndModelGuide`, `rootFrontalierGuide`) and two new
 * blocks to every canton hub (`cantonDeductibleGuide`,
 * `cantonFrontalierGuide`), all wired through the shared
 * `renderMethodologyBulletList` helper. After the fix the dist/ scan reports
 * zero offenders for the `health-premiums` feature bucket.
 *
 * This test calls the pure generator with a synthetic dataset and asserts
 * that:
 *  - the root hub HTML for every locale clears the 12 % visible-text-to-HTML
 *    ratio (2pt margin above Semrush's 10 % gate);
 *  - the canton hub HTML for the original 5 target cantons (TI/GR/UR/VS/ZH)
 *    × 2 locales clears the same 12 % floor;
 *  - leaf pages (per canton × age bracket) clear the 12 % floor too — the
 *    leaves already carried `renderHealthPremiumFrontalierContext` so this
 *    test guards against future regressions if anyone strips that block.
 *
 * If this test fails, do NOT lower the threshold (CLAUDE.md rule 1: zero
 * tolerance on quality). Investigate why the helper produced less prose and
 * fix the root cause — likely a copy field was deleted or the template
 * inadvertently dropped a section.
 */

import { describe, expect, it } from 'vitest';
import {
  generateHealthPremiumsPages,
  type HealthPremiumsDataset,
} from '../../build-plugins/healthPremiumsLandingPlugin';
import {
  buildHealthPremiumsCantonPath,
  buildHealthPremiumsLeafPath,
  buildHealthPremiumsRootPath,
  type HealthPremiumAgeBracket,
  type HealthPremiumCanton,
  type HealthPremiumLocale,
} from '../../build-plugins/healthPremiumsData';

/**
 * Strip HTML to its visible-text portion using the same heuristic Semrush
 * documents for "Low text-to-HTML ratio" — mirrors `extractVisibleText`
 * in scripts/audit-text-html-ratio.mjs so the test reflects production gate.
 */
function extractVisibleText(html: string): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<!doctype[^>]*>/gi, ' ');
  s = s.replace(/<script\b[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ');
  s = s.replace(/<template\b[\s\S]*?<\/template>/gi, ' ');
  s = s.replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function ratio(html: string): number {
  const htmlBytes = Buffer.byteLength(html, 'utf8');
  const text = extractVisibleText(html);
  const textBytes = Buffer.byteLength(text, 'utf8');
  return (textBytes / Math.max(htmlBytes, 1)) * 100;
}

const RATIO_FLOOR_PCT = 12; // 2pt margin above Semrush 10 % gate

/**
 * Minimal but complete dataset for the 5 original target cantons. Includes
 * `byAgeClass` so the leaf pages render real per-bracket prices (not the
 * multiplier fallback). The numbers are realistic but synthetic — we only
 * care about the rendered prose footprint, not the figures.
 */
function buildInsurerBlock(adultPrice: number) {
  return {
    standard: adultPrice,
    hausarzt: Math.round(adultPrice * 0.88 * 100) / 100,
    telmed: Math.round(adultPrice * 0.85 * 100) / 100,
    byAgeClass: {
      KIN: { standard: Math.round(adultPrice * 0.22 * 100) / 100 },
      JUG: { standard: Math.round(adultPrice * 0.78 * 100) / 100 },
      ERW: {
        standard: adultPrice,
        hausarzt: Math.round(adultPrice * 0.88 * 100) / 100,
        telmed: Math.round(adultPrice * 0.85 * 100) / 100,
      },
    },
  };
}

const FIXTURE: HealthPremiumsDataset = {
  fetchedAt: '2026-01-01T00:00:00Z',
  year: 2026,
  insurers: [
    { id: '8', name: 'CSS' },
    { id: '290', name: 'Concordia' },
    { id: '376', name: 'KPT' },
    { id: '1509', name: 'Sanitas' },
    { id: '1542', name: 'Assura' },
    { id: '1562', name: 'Helsana' },
  ],
  premiums: {
    TI: {
      type: 'canton',
      canton: 'TI',
      region: 1,
      insurers: {
        '8': buildInsurerBlock(640),
        '290': buildInsurerBlock(625),
        '376': buildInsurerBlock(610),
        '1509': buildInsurerBlock(655),
        '1542': buildInsurerBlock(595),
        '1562': buildInsurerBlock(670),
      },
    },
    GR: {
      type: 'canton',
      canton: 'GR',
      region: 1,
      insurers: {
        '8': buildInsurerBlock(540),
        '290': buildInsurerBlock(520),
        '376': buildInsurerBlock(515),
        '1509': buildInsurerBlock(560),
        '1542': buildInsurerBlock(495),
        '1562': buildInsurerBlock(575),
      },
    },
    UR: {
      type: 'canton',
      canton: 'UR',
      region: 1,
      insurers: {
        '8': buildInsurerBlock(380),
        '290': buildInsurerBlock(365),
        '376': buildInsurerBlock(355),
        '1509': buildInsurerBlock(395),
        '1542': buildInsurerBlock(345),
        '1562': buildInsurerBlock(405),
      },
    },
    VS: {
      type: 'canton',
      canton: 'VS',
      region: 1,
      insurers: {
        '8': buildInsurerBlock(420),
        '290': buildInsurerBlock(410),
        '376': buildInsurerBlock(400),
        '1509': buildInsurerBlock(435),
        '1542': buildInsurerBlock(385),
        '1562': buildInsurerBlock(445),
      },
    },
    ZH: {
      type: 'canton',
      canton: 'ZH',
      region: 1,
      insurers: {
        '8': buildInsurerBlock(450),
        '290': buildInsurerBlock(440),
        '376': buildInsurerBlock(430),
        '1509': buildInsurerBlock(465),
        '1542': buildInsurerBlock(415),
        '1562': buildInsurerBlock(475),
      },
    },
  },
};

const RESULT = generateHealthPremiumsPages({
  dataset: FIXTURE,
  today: new Date('2026-04-28T12:00:00Z'),
});

function getPage(p: string): string {
  const html = RESULT.pages[p];
  if (!html) throw new Error(`page not generated: ${p}`);
  return html;
}

describe('health-premiums root hub — text-to-HTML ratio', () => {
  const locales: HealthPremiumLocale[] = ['it', 'en', 'de', 'fr'];
  for (const locale of locales) {
    it(`${locale} root hub clears the ${RATIO_FLOOR_PCT}% floor`, () => {
      const html = getPage(buildHealthPremiumsRootPath(locale));
      expect(html.length).toBeGreaterThan(20_000);
      // Both new methodology blocks must be present (id markers) so that
      // future refactors that drop the helper call surface as test failures
      // even if some other section accidentally lifts the ratio.
      expect(html).toContain('rootDeductibleAndModelGuide');
      expect(html).toContain('rootFrontalierGuide');
      expect(ratio(html)).toBeGreaterThan(RATIO_FLOOR_PCT);
    });
  }
});

describe('health-premiums canton hub — text-to-HTML ratio', () => {
  // Sample three cantons × two locales = 6 pages: enough to catch a
  // template-level regression while staying fast (< 1 s).
  const samples: Array<{ canton: HealthPremiumCanton; locale: HealthPremiumLocale }> = [
    { canton: 'ticino', locale: 'it' },
    { canton: 'ticino', locale: 'en' },
    { canton: 'uri', locale: 'de' },
    { canton: 'uri', locale: 'fr' },
    { canton: 'zurigo', locale: 'it' },
    { canton: 'zurigo', locale: 'de' },
  ];
  for (const { canton, locale } of samples) {
    it(`${locale}/${canton} canton hub clears the ${RATIO_FLOOR_PCT}% floor`, () => {
      const html = getPage(buildHealthPremiumsCantonPath(locale, canton));
      expect(html.length).toBeGreaterThan(15_000);
      expect(html).toContain('cantonDeductibleGuide');
      expect(html).toContain('cantonFrontalierGuide');
      expect(html).toContain('cantonContext');
      expect(ratio(html)).toBeGreaterThan(RATIO_FLOOR_PCT);
    });
  }
});

describe('health-premiums leaf — text-to-HTML ratio', () => {
  // Sample 6 leaves spanning child / young-adult / adult / senior brackets
  // across all 4 locales so we cover both the youth-specific copy branch
  // and the senior-specific copy branch in renderHealthPremiumFrontalierContext.
  const samples: Array<{
    canton: HealthPremiumCanton;
    age: HealthPremiumAgeBracket;
    locale: HealthPremiumLocale;
  }> = [
    { canton: 'ticino', age: '0-18', locale: 'it' },
    { canton: 'ticino', age: '31-45', locale: 'it' },
    { canton: 'grigioni', age: '19-25', locale: 'en' },
    { canton: 'uri', age: '46-55', locale: 'de' },
    { canton: 'vallese', age: '56-plus', locale: 'fr' },
    { canton: 'zurigo', age: '26-30', locale: 'en' },
  ];
  for (const { canton, age, locale } of samples) {
    it(`${locale}/${canton}/${age} leaf clears the ${RATIO_FLOOR_PCT}% floor`, () => {
      const html = getPage(buildHealthPremiumsLeafPath(locale, canton, age));
      expect(html.length).toBeGreaterThan(20_000);
      // Frontaliere prose section is present — guards against accidental
      // removal of the `renderHealthPremiumFrontalierContext` call.
      expect(html).toContain('frontalierContext');
      expect(ratio(html)).toBeGreaterThan(RATIO_FLOOR_PCT);
    });
  }
});

describe('health-premiums generator determinism', () => {
  it('regenerating with the same fixture+date yields byte-identical output', () => {
    const a = generateHealthPremiumsPages({
      dataset: FIXTURE,
      today: new Date('2026-04-28T12:00:00Z'),
    });
    const b = generateHealthPremiumsPages({
      dataset: FIXTURE,
      today: new Date('2026-04-28T12:00:00Z'),
    });
    const root = buildHealthPremiumsRootPath('it');
    expect(a.pages[root]).toBe(b.pages[root]);
  });
});
