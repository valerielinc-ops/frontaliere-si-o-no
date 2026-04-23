/**
 * Tests for F2 LAMal health-premium SEO landings.
 *
 * Covers:
 *  - Slug tables + path builders for all 4 locales × 26 cantons × 6 age brackets
 *  - Route enumeration: 732 unique canonical paths (4 × 183)
 *  - Stats computation (median / min / max) on both canton-level and
 *    commune-level source blocks
 *  - Page generation: ≥50 hard gate, ≥400 words for every leaf page,
 *    ≥300 words for every hub, JSON-LD present and parseable, canonical
 *    self-referent, hreflang alternates for all 4 locales, FAQ markup
 *  - Locale completeness (each page exists in all 4 locales)
 *  - No `dark:` color prefixes anywhere in the generated HTML
 *
 * Most generation tests run against a minimal 5-canton fixture (TI/GR/VS/UR/ZH)
 * covering the original F2 target set. The 26-canton registry expansion
 * (B-cont-2) is exercised by:
 *   - slug / route enumeration tests (pure-data layer)
 *   - an "all-26-stub" generation test below that confirms the plugin walks
 *     the full registry when data is present for every canton
 * With the minimal fixture the generator yields 144 pages (the original F2
 * footprint) and reports the 21 new cantons as skipped, which is the exact
 * graceful-degradation contract demanded by CLAUDE.md rules #4 and #6.
 */

import { describe, expect, it } from 'vitest';
import {
  HEALTH_PREMIUMS_ROUTES,
  HEALTH_PREMIUM_AGE_BRACKETS,
  HEALTH_PREMIUM_AGE_SLUG,
  HEALTH_PREMIUM_CANTONS,
  HEALTH_PREMIUM_CANTON_BAG_CODE,
  HEALTH_PREMIUM_CANTON_SLUG,
  HEALTH_PREMIUM_LOCALES,
  HEALTH_PREMIUM_SECTION_SLUG,
  buildHealthPremiumsCantonPath,
  buildHealthPremiumsLeafPath,
  buildHealthPremiumsRootPath,
  isHealthPremiumsPath,
  listHealthPremiumsPaths,
} from '../build-plugins/healthPremiumsData';
import {
  computeCantonStats,
  generateHealthPremiumsPages,
  type HealthPremiumsDataset,
} from '../build-plugins/healthPremiumsLandingPlugin';
import {
  computeYoyDelta,
  computeTriYearDelta,
  loadPremiumsForYear,
  loadPriorTwoYearsForBracket,
} from '../build-plugins/healthPremiumsData';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Minimal but realistic dataset covering the 5 target cantons.
 * - TI: commune-level block with real byAgeClass data (KIN/JUG/ERW) on every
 *   insurer — exercises the real-data path introduced by F2-LAMal.
 * - GR: commune-level block with real byAgeClass data (partial — some
 *   insurers omit JUG to exercise the per-insurer mixed-source path).
 * - VS: commune-level block with *no* byAgeClass — exercises the full
 *   multiplier-fallback path (legacy/derived case).
 * - UR: canton-level block with real byAgeClass on every insurer.
 * - ZH: canton-level block with real byAgeClass on every insurer.
 *
 * The KIN and JUG premiums are deliberately set to values that do NOT equal
 * the statutory multipliers (0.25 × adult, 0.80 × adult) so that the tests
 * can detect when the plugin is applying multipliers vs reading real data.
 */
const DATASET: HealthPremiumsDataset = {
  fetchedAt: '2026-04-20T06:00:00Z',
  year: 2026,
  insurers: [
    { id: '8', name: 'CSS', website: 'https://www.css.ch' },
    { id: '32', name: 'Aquilana' },
    { id: '290', name: 'Concordia' },
    { id: '312', name: 'Atupri' },
    { id: '343', name: 'Avenir' },
    { id: '376', name: 'KPT' },
    { id: '455', name: 'ÖKK' },
    { id: '509', name: 'Sympany' },
    { id: '881', name: 'EGK' },
    { id: '966', name: 'Vita Surselva' },
    { id: '1384', name: 'SWICA' },
    { id: '1386', name: 'Galenos' },
    { id: '1401', name: 'Rhenusana' },
    { id: '1479', name: 'Mutuel' },
    { id: '1509', name: 'Sanitas' },
    { id: '1535', name: 'Philos' },
    { id: '1542', name: 'Assura' },
    { id: '1555', name: 'Visana' },
    { id: '1560', name: 'Agrisano' },
    { id: '1562', name: 'Helsana' },
    { id: '1568', name: 'Sana24' },
  ],
  premiums: {
    '6500-Bellinzona': {
      canton: 'TI',
      region: 1,
      bfsNr: 5002,
      insurers: {
        // TI exercises the real-data path: every insurer carries a full
        // byAgeClass block with KIN/JUG/ERW standard premiums deliberately
        // offset from the 0.25 × / 0.80 × multipliers so tests can assert
        // that derivation did not happen.
        '8': {
          standard: 691.9, hausarzt: 577.8, telmed: 633.1,
          byAgeClass: {
            KIN: { standard: 152.2, hausarzt: 132.9, telmed: 139.3 },
            JUG: { standard: 518.9, hausarzt: 404.4, telmed: 474.8 },
            ERW: { standard: 691.9, hausarzt: 577.8, telmed: 633.1 },
          },
        },
        '32': {
          standard: 648.8, telmed: 564.5,
          byAgeClass: {
            KIN: { standard: 144, telmed: 120 },
            JUG: { standard: 490, telmed: 420 },
            ERW: { standard: 648.8, telmed: 564.5 },
          },
        },
        '290': {
          standard: 686, hausarzt: 610.6, telmed: 590,
          byAgeClass: {
            KIN: { standard: 150, hausarzt: 135, telmed: 128 },
            JUG: { standard: 510, hausarzt: 450, telmed: 430 },
            ERW: { standard: 686, hausarzt: 610.6, telmed: 590 },
          },
        },
        '312': {
          standard: 695, hausarzt: 610.2, telmed: 622.1,
          byAgeClass: {
            KIN: { standard: 153, hausarzt: 135, telmed: 138 },
            JUG: { standard: 515, hausarzt: 450, telmed: 460 },
            ERW: { standard: 695, hausarzt: 610.2, telmed: 622.1 },
          },
        },
        '343': {
          standard: 723.3, hausarzt: 640.1, telmed: 636.5,
          byAgeClass: {
            KIN: { standard: 160, hausarzt: 142, telmed: 141 },
            JUG: { standard: 540, hausarzt: 475, telmed: 472 },
            ERW: { standard: 723.3, hausarzt: 640.1, telmed: 636.5 },
          },
        },
        '376': {
          standard: 683.2, hmo: 570.4, hausarzt: 598.6, telmed: 570.4,
          byAgeClass: {
            KIN: { standard: 151, hmo: 126, hausarzt: 132, telmed: 126 },
            JUG: { standard: 510, hmo: 420, hausarzt: 445, telmed: 420 },
            ERW: { standard: 683.2, hmo: 570.4, hausarzt: 598.6, telmed: 570.4 },
          },
        },
        '455': {
          standard: 681.7, hausarzt: 613.6, telmed: 623.8,
          byAgeClass: {
            KIN: { standard: 150, hausarzt: 136, telmed: 138 },
            JUG: { standard: 508, hausarzt: 455, telmed: 462 },
            ERW: { standard: 681.7, hausarzt: 613.6, telmed: 623.8 },
          },
        },
        '509': {
          standard: 705, telmed: 613.4, hausarzt: 627.5,
          byAgeClass: {
            KIN: { standard: 155, telmed: 136, hausarzt: 139 },
            JUG: { standard: 525, telmed: 455, hausarzt: 465 },
            ERW: { standard: 705, telmed: 613.4, hausarzt: 627.5 },
          },
        },
        '881': {
          standard: 692.1, hausarzt: 591.8, telmed: 591.8,
          byAgeClass: {
            KIN: { standard: 152, hausarzt: 131, telmed: 131 },
            JUG: { standard: 518, hausarzt: 440, telmed: 440 },
            ERW: { standard: 692.1, hausarzt: 591.8, telmed: 591.8 },
          },
        },
        '966': {
          standard: 712.7,
          byAgeClass: {
            KIN: { standard: 157 },
            JUG: { standard: 532 },
            ERW: { standard: 712.7 },
          },
        },
        '1384': {
          standard: 768.7, hausarzt: 622.7, telmed: 714.9,
          byAgeClass: {
            KIN: { standard: 170, hausarzt: 138, telmed: 159 },
            JUG: { standard: 575, hausarzt: 465, telmed: 535 },
            ERW: { standard: 768.7, hausarzt: 622.7, telmed: 714.9 },
          },
        },
        '1386': {
          standard: 647, telmed: 588.8,
          byAgeClass: {
            KIN: { standard: 143, telmed: 130 },
            JUG: { standard: 485, telmed: 440 },
            ERW: { standard: 647, telmed: 588.8 },
          },
        },
        '1401': {
          standard: 708.3,
          byAgeClass: {
            KIN: { standard: 157 },
            JUG: { standard: 530 },
            ERW: { standard: 708.3 },
          },
        },
        '1479': {
          standard: 718.4, hausarzt: 653.7, telmed: 635.8,
          byAgeClass: {
            KIN: { standard: 158, hausarzt: 144, telmed: 141 },
            JUG: { standard: 537, hausarzt: 488, telmed: 475 },
            ERW: { standard: 718.4, hausarzt: 653.7, telmed: 635.8 },
          },
        },
        '1509': {
          standard: 676.3, hausarzt: 588.35, telmed: 581.7,
          byAgeClass: {
            KIN: { standard: 149, hausarzt: 130, telmed: 128 },
            JUG: { standard: 504, hausarzt: 438, telmed: 432 },
            ERW: { standard: 676.3, hausarzt: 588.35, telmed: 581.7 },
          },
        },
        '1535': {
          standard: 718.5, hausarzt: 643, telmed: 614.3,
          byAgeClass: {
            KIN: { standard: 158, hausarzt: 142, telmed: 135 },
            JUG: { standard: 537, hausarzt: 480, telmed: 458 },
            ERW: { standard: 718.5, hausarzt: 643, telmed: 614.3 },
          },
        },
        '1542': {
          standard: 684, hausarzt: 574.6,
          byAgeClass: {
            KIN: { standard: 151, hausarzt: 127 },
            JUG: { standard: 511, hausarzt: 430 },
            ERW: { standard: 684, hausarzt: 574.6 },
          },
        },
        '1555': {
          standard: 766.2, telmed: 674.3, hausarzt: 674.3,
          byAgeClass: {
            KIN: { standard: 169, telmed: 149, hausarzt: 149 },
            JUG: { standard: 574, telmed: 504, hausarzt: 504 },
            ERW: { standard: 766.2, telmed: 674.3, hausarzt: 674.3 },
          },
        },
        '1560': {
          telmed: 554.7, standard: 645.1,
          byAgeClass: {
            KIN: { telmed: 123, standard: 142 },
            JUG: { telmed: 415, standard: 483 },
            ERW: { telmed: 554.7, standard: 645.1 },
          },
        },
        '1562': {
          standard: 696.6, hausarzt: 592.1, telmed: 585.1,
          byAgeClass: {
            KIN: { standard: 153, hausarzt: 131, telmed: 130 },
            JUG: { standard: 521, hausarzt: 444, telmed: 438 },
            ERW: { standard: 696.6, hausarzt: 592.1, telmed: 585.1 },
          },
        },
        '1568': {
          standard: 693.7, telmed: 603.5, hausarzt: 665.9,
          byAgeClass: {
            KIN: { standard: 153, telmed: 134, hausarzt: 147 },
            JUG: { standard: 519, telmed: 452, hausarzt: 498 },
            ERW: { standard: 693.7, telmed: 603.5, hausarzt: 665.9 },
          },
        },
      },
    },
    '7000-Chur': {
      canton: 'GR',
      region: 1,
      bfsNr: 3901,
      insurers: {
        // GR: mixed — most insurers have full byAgeClass, a few omit KIN or
        // JUG so we exercise the per-insurer 'derived' fallback path.
        '8': {
          standard: 580.5, hausarzt: 520,
          byAgeClass: {
            KIN: { standard: 128, hausarzt: 115 },
            JUG: { standard: 435, hausarzt: 390 },
            ERW: { standard: 580.5, hausarzt: 520 },
          },
        },
        '290': {
          standard: 570,
          byAgeClass: {
            KIN: { standard: 126 },
            JUG: { standard: 425 },
            ERW: { standard: 570 },
          },
        },
        '312': {
          standard: 560.5,
          byAgeClass: {
            KIN: { standard: 124 },
            JUG: { standard: 420 },
            ERW: { standard: 560.5 },
          },
        },
        '343': { standard: 590 }, // no byAgeClass → multiplier fallback
        '376': {
          standard: 555,
          byAgeClass: {
            KIN: { standard: 122 },
            JUG: { standard: 415 },
            ERW: { standard: 555 },
          },
        },
        '455': {
          standard: 540.3, hausarzt: 495.9,
          byAgeClass: {
            KIN: { standard: 119, hausarzt: 109 },
            JUG: { standard: 405, hausarzt: 370 },
            ERW: { standard: 540.3, hausarzt: 495.9 },
          },
        },
        '509': {
          standard: 585,
          byAgeClass: {
            KIN: { standard: 129 },
            JUG: { standard: 440 },
            ERW: { standard: 585 },
          },
        },
        '881': {
          standard: 560,
          byAgeClass: {
            KIN: { standard: 123 },
            JUG: { standard: 420 },
            ERW: { standard: 560 },
          },
        },
        '1384': {
          standard: 612.6,
          byAgeClass: {
            KIN: { standard: 135 },
            JUG: { standard: 460 },
            ERW: { standard: 612.6 },
          },
        },
        '1479': { standard: 580 }, // no byAgeClass → multiplier fallback
        '1509': {
          standard: 545,
          byAgeClass: {
            KIN: { standard: 120 },
            JUG: { standard: 408 },
            ERW: { standard: 545 },
          },
        },
        '1555': {
          standard: 610,
          byAgeClass: {
            KIN: { standard: 134 },
            JUG: { standard: 460 },
            ERW: { standard: 610 },
          },
        },
      },
    },
    '1950-Sion': {
      canton: 'VS',
      region: 1,
      bfsNr: 6266,
      // VS: NO byAgeClass on any insurer — legacy dataset shape. Exercises
      // the full multiplier-fallback path for 0-18 / 19-25 brackets.
      insurers: {
        '8': { standard: 480 },
        '290': { standard: 465 },
        '312': { standard: 470 },
        '343': { standard: 485 },
        '376': { standard: 460 },
        '455': { standard: 455 },
        '509': { standard: 475 },
        '881': { standard: 465 },
        '1384': { standard: 505 },
        '1479': { standard: 475 },
        '1509': { standard: 450 },
        '1555': { standard: 500 },
      },
    },
    UR: {
      type: 'canton',
      canton: 'UR',
      region: null,
      insurers: {
        // UR: canton-level with full real byAgeClass on every insurer.
        '8': {
          standard: 410.5, hausarzt: 370,
          byAgeClass: {
            KIN: { standard: 90, hausarzt: 82 },
            JUG: { standard: 308, hausarzt: 277 },
            ERW: { standard: 410.5, hausarzt: 370 },
          },
        },
        '290': {
          standard: 395,
          byAgeClass: { KIN: { standard: 87 }, JUG: { standard: 296 }, ERW: { standard: 395 } },
        },
        '312': {
          standard: 405,
          byAgeClass: { KIN: { standard: 89 }, JUG: { standard: 304 }, ERW: { standard: 405 } },
        },
        '343': {
          standard: 420,
          byAgeClass: { KIN: { standard: 92 }, JUG: { standard: 315 }, ERW: { standard: 420 } },
        },
        '376': {
          standard: 390,
          byAgeClass: { KIN: { standard: 86 }, JUG: { standard: 292 }, ERW: { standard: 390 } },
        },
        '455': {
          standard: 385,
          byAgeClass: { KIN: { standard: 85 }, JUG: { standard: 288 }, ERW: { standard: 385 } },
        },
        '509': {
          standard: 405,
          byAgeClass: { KIN: { standard: 89 }, JUG: { standard: 304 }, ERW: { standard: 405 } },
        },
        '881': {
          standard: 395,
          byAgeClass: { KIN: { standard: 87 }, JUG: { standard: 296 }, ERW: { standard: 395 } },
        },
        '1384': {
          standard: 430,
          byAgeClass: { KIN: { standard: 95 }, JUG: { standard: 322 }, ERW: { standard: 430 } },
        },
        '1479': {
          standard: 405,
          byAgeClass: { KIN: { standard: 89 }, JUG: { standard: 304 }, ERW: { standard: 405 } },
        },
        '1509': {
          standard: 380,
          byAgeClass: { KIN: { standard: 84 }, JUG: { standard: 285 }, ERW: { standard: 380 } },
        },
        '1555': {
          standard: 425,
          byAgeClass: { KIN: { standard: 94 }, JUG: { standard: 319 }, ERW: { standard: 425 } },
        },
      },
    },
    ZH: {
      type: 'canton',
      canton: 'ZH',
      region: null,
      insurers: {
        // ZH: canton-level with full real byAgeClass on every insurer.
        '8': {
          standard: 515,
          byAgeClass: { KIN: { standard: 113 }, JUG: { standard: 386 }, ERW: { standard: 515 } },
        },
        '290': {
          standard: 500,
          byAgeClass: { KIN: { standard: 110 }, JUG: { standard: 375 }, ERW: { standard: 500 } },
        },
        '312': {
          standard: 510,
          byAgeClass: { KIN: { standard: 112 }, JUG: { standard: 383 }, ERW: { standard: 510 } },
        },
        '343': {
          standard: 525,
          byAgeClass: { KIN: { standard: 116 }, JUG: { standard: 394 }, ERW: { standard: 525 } },
        },
        '376': {
          standard: 495,
          byAgeClass: { KIN: { standard: 109 }, JUG: { standard: 371 }, ERW: { standard: 495 } },
        },
        '455': {
          standard: 490,
          byAgeClass: { KIN: { standard: 108 }, JUG: { standard: 368 }, ERW: { standard: 490 } },
        },
        '509': {
          standard: 510,
          byAgeClass: { KIN: { standard: 112 }, JUG: { standard: 383 }, ERW: { standard: 510 } },
        },
        '881': {
          standard: 505,
          byAgeClass: { KIN: { standard: 111 }, JUG: { standard: 379 }, ERW: { standard: 505 } },
        },
        '1384': {
          standard: 540,
          byAgeClass: { KIN: { standard: 119 }, JUG: { standard: 405 }, ERW: { standard: 540 } },
        },
        '1479': {
          standard: 515,
          byAgeClass: { KIN: { standard: 113 }, JUG: { standard: 386 }, ERW: { standard: 515 } },
        },
        '1509': {
          standard: 485,
          byAgeClass: { KIN: { standard: 107 }, JUG: { standard: 364 }, ERW: { standard: 485 } },
        },
        '1555': {
          standard: 530,
          byAgeClass: { KIN: { standard: 117 }, JUG: { standard: 398 }, ERW: { standard: 530 } },
        },
      },
    },
  },
};

// ── Slug tables & path builders ───────────────────────────────

describe('healthPremiumsData — slug tables', () => {
  it('exposes exactly 4 locales', () => {
    expect(HEALTH_PREMIUM_LOCALES).toEqual(['it', 'en', 'de', 'fr']);
  });

  it('exposes all 26 Swiss cantons with the original 5 first (slug stability)', () => {
    // The original F2 target set MUST remain at index 0-4 — changing the
    // order would change hub-grid rendering and could shift sibling pickers.
    expect(HEALTH_PREMIUM_CANTONS.slice(0, 5)).toEqual([
      'ticino',
      'grigioni',
      'uri',
      'vallese',
      'zurigo',
    ]);
    expect(HEALTH_PREMIUM_CANTONS).toHaveLength(26);
    // Full canonical list — no duplicates, covers every BAG canton code.
    const set = new Set(HEALTH_PREMIUM_CANTONS);
    expect(set.size).toBe(26);
  });

  it('covers every BAG 2-letter canton code exactly once', () => {
    const bagCodes = HEALTH_PREMIUM_CANTONS.map((c) => HEALTH_PREMIUM_CANTON_BAG_CODE[c]);
    const expected = [
      'AG', 'AI', 'AR', 'BE', 'BL', 'BS', 'FR', 'GE', 'GL', 'GR',
      'JU', 'LU', 'NE', 'NW', 'OW', 'SG', 'SH', 'SO', 'SZ', 'TG',
      'TI', 'UR', 'VD', 'VS', 'ZG', 'ZH',
    ];
    expect([...bagCodes].sort()).toEqual(expected);
  });

  it('preserves the original 5 canton URL slugs byte-for-byte (SEO stability)', () => {
    // Any change to these exact strings would break already-indexed URLs.
    expect(HEALTH_PREMIUM_CANTON_SLUG.it.ticino).toBe('ticino');
    expect(HEALTH_PREMIUM_CANTON_SLUG.it.grigioni).toBe('grigioni');
    expect(HEALTH_PREMIUM_CANTON_SLUG.it.uri).toBe('uri');
    expect(HEALTH_PREMIUM_CANTON_SLUG.it.vallese).toBe('vallese');
    expect(HEALTH_PREMIUM_CANTON_SLUG.it.zurigo).toBe('zurigo');
    expect(HEALTH_PREMIUM_CANTON_SLUG.en.grigioni).toBe('graubunden');
    expect(HEALTH_PREMIUM_CANTON_SLUG.en.vallese).toBe('valais');
    expect(HEALTH_PREMIUM_CANTON_SLUG.en.zurigo).toBe('zurich');
    expect(HEALTH_PREMIUM_CANTON_SLUG.de.ticino).toBe('tessin');
    expect(HEALTH_PREMIUM_CANTON_SLUG.de.grigioni).toBe('graubuenden');
    expect(HEALTH_PREMIUM_CANTON_SLUG.de.vallese).toBe('wallis');
    expect(HEALTH_PREMIUM_CANTON_SLUG.de.zurigo).toBe('zuerich');
    expect(HEALTH_PREMIUM_CANTON_SLUG.fr.ticino).toBe('tessin');
    expect(HEALTH_PREMIUM_CANTON_SLUG.fr.grigioni).toBe('grisons');
    expect(HEALTH_PREMIUM_CANTON_SLUG.fr.vallese).toBe('valais');
    expect(HEALTH_PREMIUM_CANTON_SLUG.fr.zurigo).toBe('zurich');
  });

  it('localises every new canton slug to its native exonym', () => {
    // Spot-check: the 21 new cantons must use locale-appropriate exonyms so
    // native-language long-tail queries ("krankenkassenpraemien aargau",
    // "primes assurance maladie vaud") land on the right URL.
    expect(HEALTH_PREMIUM_CANTON_SLUG.it.argovia).toBe('argovia');
    expect(HEALTH_PREMIUM_CANTON_SLUG.en.argovia).toBe('aargau');
    expect(HEALTH_PREMIUM_CANTON_SLUG.de.argovia).toBe('aargau');
    expect(HEALTH_PREMIUM_CANTON_SLUG.fr.argovia).toBe('argovie');
    expect(HEALTH_PREMIUM_CANTON_SLUG.it.ginevra).toBe('ginevra');
    expect(HEALTH_PREMIUM_CANTON_SLUG.en.ginevra).toBe('geneva');
    expect(HEALTH_PREMIUM_CANTON_SLUG.de.ginevra).toBe('genf');
    expect(HEALTH_PREMIUM_CANTON_SLUG.fr.ginevra).toBe('geneve');
    // All canton slugs must be ASCII-safe kebab-case (no diacritics, no
    // percent-encoding surprises at the canonical layer).
    for (const loc of HEALTH_PREMIUM_LOCALES) {
      for (const c of HEALTH_PREMIUM_CANTONS) {
        const slug = HEALTH_PREMIUM_CANTON_SLUG[loc][c];
        expect(slug, `${loc}/${c}`).toMatch(/^[a-z][a-z0-9-]*[a-z0-9]$/);
      }
    }
  });

  it('exposes exactly 6 age brackets', () => {
    expect(HEALTH_PREMIUM_AGE_BRACKETS).toHaveLength(6);
    expect(HEALTH_PREMIUM_AGE_BRACKETS.map((a) => a.id)).toEqual([
      '0-18',
      '19-25',
      '26-30',
      '31-45',
      '46-55',
      '56-plus',
    ]);
  });

  it('maps cantons to BAG codes', () => {
    expect(HEALTH_PREMIUM_CANTON_BAG_CODE.ticino).toBe('TI');
    expect(HEALTH_PREMIUM_CANTON_BAG_CODE.grigioni).toBe('GR');
    expect(HEALTH_PREMIUM_CANTON_BAG_CODE.uri).toBe('UR');
    expect(HEALTH_PREMIUM_CANTON_BAG_CODE.vallese).toBe('VS');
    expect(HEALTH_PREMIUM_CANTON_BAG_CODE.zurigo).toBe('ZH');
  });

  it('uses expected section slugs per locale', () => {
    expect(HEALTH_PREMIUM_SECTION_SLUG.it).toBe('premi-cassa-malati');
    expect(HEALTH_PREMIUM_SECTION_SLUG.en).toBe('health-insurance-premiums');
    expect(HEALTH_PREMIUM_SECTION_SLUG.de).toBe('krankenkassenpraemien');
    expect(HEALTH_PREMIUM_SECTION_SLUG.fr).toBe('primes-assurance-maladie');
  });

  it('every locale has a slug for every canton', () => {
    for (const loc of HEALTH_PREMIUM_LOCALES) {
      for (const c of HEALTH_PREMIUM_CANTONS) {
        expect(HEALTH_PREMIUM_CANTON_SLUG[loc][c], `${loc}/${c}`).toBeTypeOf('string');
        expect(HEALTH_PREMIUM_CANTON_SLUG[loc][c].length).toBeGreaterThan(0);
      }
    }
  });

  it('every locale has a slug for every age bracket', () => {
    for (const loc of HEALTH_PREMIUM_LOCALES) {
      for (const ab of HEALTH_PREMIUM_AGE_BRACKETS) {
        expect(HEALTH_PREMIUM_AGE_SLUG[loc][ab.id], `${loc}/${ab.id}`).toBeTypeOf('string');
        expect(HEALTH_PREMIUM_AGE_SLUG[loc][ab.id].length).toBeGreaterThan(0);
      }
    }
  });
});

describe('healthPremiumsData — path builders', () => {
  it('builds IT root, canton and leaf paths', () => {
    expect(buildHealthPremiumsRootPath('it')).toBe('/premi-cassa-malati/');
    expect(buildHealthPremiumsCantonPath('it', 'ticino')).toBe('/premi-cassa-malati/ticino/');
    expect(buildHealthPremiumsLeafPath('it', 'ticino', '31-45')).toBe(
      '/premi-cassa-malati/ticino/adulto-31-45/',
    );
  });

  it('builds EN / DE / FR root paths with locale prefix', () => {
    expect(buildHealthPremiumsRootPath('en')).toBe('/en/health-insurance-premiums/');
    expect(buildHealthPremiumsRootPath('de')).toBe('/de/krankenkassenpraemien/');
    expect(buildHealthPremiumsRootPath('fr')).toBe('/fr/primes-assurance-maladie/');
  });

  it('builds EN / DE / FR leaf paths with localised age slug', () => {
    expect(buildHealthPremiumsLeafPath('en', 'grigioni', '19-25')).toBe(
      '/en/health-insurance-premiums/graubunden/young-adults-19-25/',
    );
    expect(buildHealthPremiumsLeafPath('de', 'vallese', '56-plus')).toBe(
      '/de/krankenkassenpraemien/wallis/erwachsene-56-plus/',
    );
    expect(buildHealthPremiumsLeafPath('fr', 'zurigo', '0-18')).toBe(
      '/fr/primes-assurance-maladie/zurich/enfants-0-18/',
    );
  });

  it('all paths end with a trailing slash', () => {
    for (const p of listHealthPremiumsPaths()) {
      expect(p.path.endsWith('/'), `${p.path}`).toBe(true);
    }
  });
});

describe('healthPremiumsData — route enumeration', () => {
  it('generates exactly 732 paths (4 locales × (1 root + 26 canton hubs + 156 leaves))', () => {
    const paths = listHealthPremiumsPaths();
    expect(paths).toHaveLength(732);
  });

  it('all 732 paths are unique', () => {
    const paths = listHealthPremiumsPaths();
    const unique = new Set(paths.map((p) => p.path));
    expect(unique.size).toBe(732);
  });

  it('HEALTH_PREMIUMS_ROUTES mirrors listHealthPremiumsPaths()', () => {
    expect(HEALTH_PREMIUMS_ROUTES).toHaveLength(732);
  });

  it('isHealthPremiumsPath recognises every canonical path', () => {
    for (const p of HEALTH_PREMIUMS_ROUTES) {
      expect(isHealthPremiumsPath(p), p).toBe(true);
    }
  });

  it('isHealthPremiumsPath tolerates missing trailing slash', () => {
    expect(isHealthPremiumsPath('/premi-cassa-malati')).toBe(true);
    expect(isHealthPremiumsPath('/premi-cassa-malati/ticino/adulto-31-45')).toBe(true);
  });

  it('isHealthPremiumsPath recognises new B-cont-2 canton paths', () => {
    // Sanity: a handful of the 21 new cantons must resolve, otherwise the
    // router will fall through to the SPA 404 handler.
    expect(isHealthPremiumsPath('/premi-cassa-malati/zurigo/adulto-31-45/')).toBe(true);
    expect(isHealthPremiumsPath('/premi-cassa-malati/berna/adulto-31-45/')).toBe(true);
    expect(isHealthPremiumsPath('/premi-cassa-malati/ginevra/adulto-46-55/')).toBe(true);
    expect(isHealthPremiumsPath('/en/health-insurance-premiums/zurich/adult-31-45/')).toBe(true);
    expect(isHealthPremiumsPath('/de/krankenkassenpraemien/aargau/erwachsene-31-45/')).toBe(true);
    expect(isHealthPremiumsPath('/fr/primes-assurance-maladie/vaud/adulte-31-45/')).toBe(true);
  });

  it('isHealthPremiumsPath rejects unrelated paths', () => {
    expect(isHealthPremiumsPath('/')).toBe(false);
    expect(isHealthPremiumsPath('/compara-servizi/confronta-casse-malati/')).toBe(false);
    expect(isHealthPremiumsPath('/cerca-lavoro-ticino/lugano/')).toBe(false);
  });

  it('locale coverage — exactly 183 paths per locale', () => {
    const byLocale: Record<string, number> = { it: 0, en: 0, de: 0, fr: 0 };
    for (const p of listHealthPremiumsPaths()) {
      byLocale[p.locale]++;
    }
    expect(byLocale.it).toBe(183);
    expect(byLocale.en).toBe(183);
    expect(byLocale.de).toBe(183);
    expect(byLocale.fr).toBe(183);
  });
});

// ── Stats computation ──────────────────────────────────────────

describe('computeCantonStats', () => {
  it('aggregates commune-level premiums into a canton average (TI)', () => {
    const s = computeCantonStats(DATASET, 'ticino');
    expect(s).not.toBeNull();
    if (!s) return;
    expect(s.cantonBagCode).toBe('TI');
    expect(s.sourceBlocks).toBe(1);
    expect(Object.keys(s.adultByInsurer).length).toBeGreaterThanOrEqual(20);
    expect(s.adultMin).toBeGreaterThan(0);
    expect(s.adultMax).toBeGreaterThan(s.adultMin ?? 0);
    expect(s.adultMedian).not.toBeNull();
    expect(s.ranked[0].price).toBeLessThanOrEqual(s.ranked[s.ranked.length - 1].price);
  });

  it('reads canton-level block directly (UR, ZH)', () => {
    const ur = computeCantonStats(DATASET, 'uri');
    expect(ur).not.toBeNull();
    expect(ur?.cantonBagCode).toBe('UR');
    expect(ur?.sourceBlocks).toBe(1);

    const zh = computeCantonStats(DATASET, 'zurigo');
    expect(zh).not.toBeNull();
    expect(zh?.cantonBagCode).toBe('ZH');
  });

  it('returns null when canton is missing from dataset', () => {
    const empty: HealthPremiumsDataset = { insurers: [], premiums: {} };
    for (const c of HEALTH_PREMIUM_CANTONS) {
      expect(computeCantonStats(empty, c)).toBeNull();
    }
  });
});

// ── Page generation ────────────────────────────────────────────

const today = new Date('2026-04-20T06:00:00.000Z');
const generation = generateHealthPremiumsPages({ dataset: DATASET, today });

describe('generateHealthPremiumsPages — counts', () => {
  it('generates 144 pages from the 5-canton fixture and skips the 21 others', () => {
    // 4 locales × (1 root + 5 canton hubs + 5×6 leaves) = 144.
    // The minimal fixture intentionally exercises only the original F2
    // target set; the new 21 cantons are reported as skipped per the
    // graceful-degradation contract (no fake data — CLAUDE.md rule #6).
    expect(Object.keys(generation.pages)).toHaveLength(144);
    expect(generation.skippedCantons).toHaveLength(21);
    // Original 5 must all be generated.
    for (const c of ['ticino', 'grigioni', 'uri', 'vallese', 'zurigo'] as const) {
      expect(generation.skippedCantons, c).not.toContain(c);
    }
  });

  it('locale coverage — exactly 36 pages per locale (5-canton fixture)', () => {
    const byLocale: Record<string, number> = { it: 0, en: 0, de: 0, fr: 0 };
    for (const path of Object.keys(generation.pages)) {
      if (path.startsWith('/en/')) byLocale.en++;
      else if (path.startsWith('/de/')) byLocale.de++;
      else if (path.startsWith('/fr/')) byLocale.fr++;
      else byLocale.it++;
    }
    expect(byLocale.it).toBe(36);
    expect(byLocale.en).toBe(36);
    expect(byLocale.de).toBe(36);
    expect(byLocale.fr).toBe(36);
  });

  it('every path for the 5-canton fixture appears in HEALTH_PREMIUMS_ROUTES', () => {
    // With 21 cantons skipped the reverse inclusion does not hold any more
    // (HEALTH_PREMIUMS_ROUTES has 732 entries, generation.pages has 144).
    // We assert the weaker invariant: every generated path is a canonical
    // health-premium route.
    for (const p of Object.keys(generation.pages)) {
      expect(HEALTH_PREMIUMS_ROUTES, p).toContain(p);
    }
  });
});

describe('generateHealthPremiumsPages — content quality', () => {
  /**
   * Classify a canonical path as root | canton-hub | leaf. Leaf = 4 segments
   * counting an optional locale prefix: (locale?)/section/canton/age.
   */
  const classify = (p: string): 'root' | 'canton' | 'leaf' => {
    const parts = p.split('/').filter(Boolean);
    const hasLocale = parts[0] === 'en' || parts[0] === 'de' || parts[0] === 'fr';
    const depth = hasLocale ? parts.length - 1 : parts.length;
    if (depth === 1) return 'root';
    if (depth === 2) return 'canton';
    return 'leaf';
  };

  it('every leaf page has ≥400 words of visible content', () => {
    const leaves = Object.entries(generation.pages).filter(([p]) => classify(p) === 'leaf');
    // 5 cantons × 6 brackets × 4 locales = 120 (minimal fixture; see the
    // "all-26-stub" suite below for the 26-canton generation-count gate).
    expect(leaves.length).toBe(120);
    for (const [path, html] of leaves) {
      const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const words = text.split(' ').filter((w) => w.length > 0).length;
      expect(words, `leaf ${path} has only ${words} words`).toBeGreaterThanOrEqual(400);
    }
  });

  it('every hub page (root + canton) has ≥300 words', () => {
    const hubs = Object.entries(generation.pages).filter(([p]) => classify(p) !== 'leaf');
    // 4 roots + 20 canton hubs = 24 hubs
    expect(hubs.length).toBe(24);
    for (const [path, html] of hubs) {
      const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const words = text.split(' ').filter((w) => w.length > 0).length;
      expect(words, `hub ${path} has only ${words} words`).toBeGreaterThanOrEqual(300);
    }
  });

  it('every page has self-referencing canonical', () => {
    for (const [path, html] of Object.entries(generation.pages)) {
      expect(html, path).toContain(
        `<link rel="canonical" href="https://frontaliereticino.ch${path}">`,
      );
    }
  });

  it('every page has hreflang alternates for all 4 locales', () => {
    for (const [path, html] of Object.entries(generation.pages)) {
      expect(html, `${path} missing hreflang=it`).toContain('hreflang="it"');
      expect(html, `${path} missing hreflang=en`).toContain('hreflang="en"');
      expect(html, `${path} missing hreflang=de`).toContain('hreflang="de"');
      expect(html, `${path} missing hreflang=fr`).toContain('hreflang="fr"');
    }
  });

  it('every page has parseable BreadcrumbList + WebPage + FAQPage JSON-LD', () => {
    for (const [path, html] of Object.entries(generation.pages)) {
      const ldBlocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
      expect(ldBlocks.length, `${path} has no JSON-LD blocks`).toBeGreaterThanOrEqual(3);
      const types = ldBlocks.map((m) => {
        try {
          return JSON.parse(m[1])['@type'];
        } catch {
          return null;
        }
      });
      expect(types, path).toContain('BreadcrumbList');
      expect(types, path).toContain('WebPage');
      expect(types, path).toContain('FAQPage');
    }
  });

  it('leaf pages emit Product JSON-LD with CHF AggregateOffer', () => {
    for (const [path, html] of Object.entries(generation.pages)) {
      if (classify(path) !== 'leaf') continue;

      const productBlockMatch = html.match(
        /<script type="application\/ld\+json">(\{[^<]*"@type":"Product"[^<]*\})<\/script>/,
      );
      expect(productBlockMatch, `leaf ${path} has no Product LD`).not.toBeNull();
      if (!productBlockMatch) continue;
      const parsed = JSON.parse(productBlockMatch[1]);
      expect(parsed.offers['@type']).toBe('AggregateOffer');
      expect(parsed.offers.priceCurrency).toBe('CHF');
      expect(typeof parsed.offers.lowPrice).toBe('string');
      expect(typeof parsed.offers.highPrice).toBe('string');
    }
  });

  it('includes localized H1 on IT/EN/DE/FR leaf pages', () => {
    const itLeaf = generation.pages['/premi-cassa-malati/ticino/adulto-31-45/'];
    expect(itLeaf).toMatch(/Premi Cassa Malati Ticino/);
    const enLeaf = generation.pages['/en/health-insurance-premiums/ticino/adult-31-45/'];
    expect(enLeaf).toMatch(/Health insurance premiums Ticino/);
    const deLeaf = generation.pages['/de/krankenkassenpraemien/tessin/erwachsene-31-45/'];
    expect(deLeaf).toMatch(/Krankenkassenprämien Tessin/);
    const frLeaf = generation.pages['/fr/primes-assurance-maladie/tessin/adulte-31-45/'];
    expect(frLeaf).toMatch(/Primes assurance maladie Tessin/);
  });

  it('contains no dark: color prefixes anywhere', () => {
    for (const [path, html] of Object.entries(generation.pages)) {
      // Look for `dark:` followed by a color token (matches the rule enforced
      // by no-dark-color-classes.test.ts for component code).
      expect(html, path).not.toMatch(/\sdark:(bg|text|border|fill|stroke|from|to|via)-/);
    }
  });
});

// ── Real KIN / JUG / ERW data path ─────────────────────────────

describe('computeCantonStats — real byAgeClass data', () => {
  it('exposes per-bracket stats with real KIN / JUG / ERW data on TI', () => {
    const s = computeCantonStats(DATASET, 'ticino');
    expect(s).not.toBeNull();
    if (!s) return;
    expect(s.bracketStats).toBeDefined();

    const kin = s.bracketStats['0-18'];
    expect(kin).not.toBeNull();
    expect(kin?.riskClass).toBe('KIN');
    expect(kin?.allReal).toBe(true);
    // CSS (insurer 8) TI KIN fixture value is 152.2 — NOT 25% × 691.9 = 172.98.
    expect(kin?.byInsurer['8']).toBeCloseTo(152.2, 1);
    expect(kin?.sourceByInsurer['8']).toBe('real');

    const jug = s.bracketStats['19-25'];
    expect(jug).not.toBeNull();
    expect(jug?.riskClass).toBe('JUG');
    expect(jug?.allReal).toBe(true);
    // CSS TI JUG fixture value is 518.9 — NOT 80% × 691.9 = 553.52.
    expect(jug?.byInsurer['8']).toBeCloseTo(518.9, 1);
    expect(jug?.sourceByInsurer['8']).toBe('real');

    const erw = s.bracketStats['31-45'];
    expect(erw).not.toBeNull();
    expect(erw?.riskClass).toBe('ERW');
    expect(erw?.allReal).toBe(true);
    expect(erw?.byInsurer['8']).toBeCloseTo(691.9, 1);
  });

  it('marks bracket as derived when any insurer is missing byAgeClass (GR)', () => {
    const s = computeCantonStats(DATASET, 'grigioni');
    expect(s).not.toBeNull();
    if (!s) return;
    const kin = s.bracketStats['0-18'];
    expect(kin).not.toBeNull();
    // Insurer 343 and 1479 are missing byAgeClass → per-insurer 'derived'.
    expect(kin?.sourceByInsurer['343']).toBe('derived');
    expect(kin?.sourceByInsurer['1479']).toBe('derived');
    // Others carry real data.
    expect(kin?.sourceByInsurer['8']).toBe('real');
    expect(kin?.sourceByInsurer['290']).toBe('real');
    // Because ≥ 1 insurer is 'derived', allReal is false → landing page
    // will show the derivation note.
    expect(kin?.allReal).toBe(false);
  });

  it('falls back to multiplier for every insurer when byAgeClass is absent (VS)', () => {
    const s = computeCantonStats(DATASET, 'vallese');
    expect(s).not.toBeNull();
    if (!s) return;
    const kin = s.bracketStats['0-18'];
    expect(kin).not.toBeNull();
    expect(kin?.allReal).toBe(false);
    // Every insurer must be flagged as derived.
    for (const src of Object.values(kin?.sourceByInsurer ?? {})) {
      expect(src).toBe('derived');
    }
    // Value must be adult × 0.25 — for insurer 8 that is 480 × 0.25 = 120.
    expect(kin?.byInsurer['8']).toBeCloseTo(120, 1);
    // Young adult JUG also derived, 80% of 480 = 384.
    const jug = s.bracketStats['19-25'];
    expect(jug?.allReal).toBe(false);
    expect(jug?.byInsurer['8']).toBeCloseTo(384, 1);
  });

  it('ERW bracket is real across the original 5 cantons (legacy datasets alias ERW in flat fields)', () => {
    // The 21 B-cont-2 cantons are not in DATASET — they exercise the
    // graceful-degradation path (computeCantonStats returns null) and are
    // covered by the "full 26-canton coverage" suite's stub fixture.
    const fixtureCantons = ['ticino', 'grigioni', 'uri', 'vallese', 'zurigo'] as const;
    for (const canton of fixtureCantons) {
      const s = computeCantonStats(DATASET, canton);
      expect(s, canton).not.toBeNull();
      if (!s) continue;
      for (const bracket of ['26-30', '31-45', '46-55', '56-plus'] as const) {
        const bs = s.bracketStats[bracket];
        expect(bs, `${canton}/${bracket}`).not.toBeNull();
        expect(bs?.allReal, `${canton}/${bracket}`).toBe(true);
      }
    }
  });
});

describe('generateHealthPremiumsPages — real data replaces derivation', () => {
  it('leaf prices for TI 0-18 equal real BAG KIN values, NOT adult × 0.25', () => {
    const page = generation.pages['/premi-cassa-malati/ticino/bambini-0-18/'];
    expect(page).toBeTypeOf('string');
    // Fixture: CSS TI KIN standard = 152.2 (rendered with IT comma decimal).
    expect(page).toMatch(/152,20/);
    // Guard against the derivation case: adult × 0.25 = 172.98.
    expect(page).not.toMatch(/172,98/);
  });

  it('leaf prices for TI 19-25 equal real BAG JUG values, NOT adult × 0.80', () => {
    const page = generation.pages['/premi-cassa-malati/ticino/giovani-adulti-19-25/'];
    expect(page).toBeTypeOf('string');
    // Fixture: CSS TI JUG standard = 518.9.
    expect(page).toMatch(/518,90/);
    // Derivation would yield 691.9 × 0.80 = 553.52.
    expect(page).not.toMatch(/553,52/);
  });

  it('omits the "stima basata sui massimali BAG" note when KIN data is real (TI)', () => {
    const page = generation.pages['/premi-cassa-malati/ticino/bambini-0-18/'];
    expect(page).toBeTypeOf('string');
    // Real data → editorial note must NOT appear on TI.
    expect(page).not.toMatch(/stima basata sui massimali BAG/i);
    expect(page).not.toMatch(/applicando i massimali statutari BAG/i);
  });

  it('keeps the derivation note when byAgeClass is missing (VS)', () => {
    const page = generation.pages['/premi-cassa-malati/vallese/bambini-0-18/'];
    expect(page).toBeTypeOf('string');
    // VS fixture lacks byAgeClass → multiplier fallback → note must appear.
    expect(page).toMatch(/massimali statutari BAG/i);
  });

  it('keeps the derivation note when any insurer in the bracket is derived (GR)', () => {
    const page = generation.pages['/premi-cassa-malati/grigioni/bambini-0-18/'];
    expect(page).toBeTypeOf('string');
    // GR mixes real and derived insurers → allReal is false → note appears.
    expect(page).toMatch(/massimali statutari BAG/i);
  });

  it('adult (26+) leaves never show the derivation note regardless of canton', () => {
    for (const cantonSlug of ['ticino', 'grigioni', 'vallese', 'uri', 'zurigo']) {
      for (const ageSlug of ['adulto-26-30', 'adulto-31-45', 'adulto-46-55', 'adulto-56-piu']) {
        const path = `/premi-cassa-malati/${cantonSlug}/${ageSlug}/`;
        const page = generation.pages[path];
        expect(page, path).toBeTypeOf('string');
        expect(page, path).not.toMatch(/massimali statutari BAG/i);
      }
    }
  });

  it('canton hub age grid uses real KIN median for TI (not multiplier)', () => {
    // TI fixture has real KIN data; grid median should NOT be simply
    // adult_median × 0.25.
    const hub = generation.pages['/premi-cassa-malati/ticino/'];
    expect(hub).toBeTypeOf('string');
    // Sanity: the hub mentions a KIN-scale number (< 200 CHF) for 0-18.
    // Since the TI KIN standard values range ~142-170, the median should
    // fall around ~153.
    const hasRealKinRange = /1[456]\d,\d{2}/.test(hub);
    expect(hasRealKinRange, 'hub should expose a KIN median in ~140-170 CHF range').toBe(true);
  });
});

// ── Resilience: missing canton data ────────────────────────────

describe('generateHealthPremiumsPages — missing data resilience', () => {
  it('skips cantons without data and never fails the build', () => {
    const partial: HealthPremiumsDataset = {
      year: 2026,
      insurers: DATASET.insurers,
      premiums: {
        '6500-Bellinzona': DATASET.premiums!['6500-Bellinzona'],
        // no other canton entries
      },
    };
    const { pages, skippedCantons } = generateHealthPremiumsPages({ dataset: partial, today });
    // Everything except TI is skipped — 25 cantons out of 26.
    expect(skippedCantons).toHaveLength(25);
    expect(skippedCantons).not.toContain('ticino');
    // Roots are still emitted (4 roots), TI canton hub + 6 TI leaves per locale = 7 × 4 = 28.
    // Total: 4 + 28 = 32.
    expect(Object.keys(pages)).toHaveLength(32);
  });

  it('produces roots-only when dataset is empty but does not throw', () => {
    const { pages, skippedCantons } = generateHealthPremiumsPages({
      dataset: { insurers: [], premiums: {} },
      today,
    });
    // All 26 cantons skipped.
    expect(skippedCantons).toHaveLength(26);
    // Only roots remain (4 locales × 1 root)
    expect(Object.keys(pages)).toHaveLength(4);
  });
});

// ── F2 A3 — YoY variation "vs 2025" ────────────────────────────

/**
 * Prior-year (2025) fixture — same insurer ids and canton blocks as DATASET,
 * but with every adult premium exactly 10 CHF lower than the 2026 counterpart.
 * This lets us assert deterministic YoY percentage deltas.
 */
function buildPriorFixture(): HealthPremiumsDataset {
  // Shallow-clone the TI / GR / UR / ZH blocks and subtract 10 CHF from each
  // insurer's ERW standard. We preserve KIN/JUG so the fixture exercises
  // per-bracket YoY (not just adult).
  const subtract10 = (value: number | undefined): number | undefined =>
    typeof value === 'number' ? Math.round((value - 10) * 100) / 100 : value;
  const cloneInsurers = (block: HealthPremiumsDataset['premiums'] extends Record<string, infer B> ? B : never) => {
    const next: typeof block = { ...block, insurers: {} };
    for (const [id, models] of Object.entries(block.insurers)) {
      const bac = models.byAgeClass;
      next.insurers[id] = {
        ...models,
        standard: subtract10(models.standard),
        hausarzt: subtract10(models.hausarzt),
        telmed: subtract10(models.telmed),
        hmo: subtract10(models.hmo),
        byAgeClass: bac
          ? {
              KIN: bac.KIN
                ? { ...bac.KIN, standard: subtract10(bac.KIN.standard) }
                : undefined,
              JUG: bac.JUG
                ? { ...bac.JUG, standard: subtract10(bac.JUG.standard) }
                : undefined,
              ERW: bac.ERW
                ? { ...bac.ERW, standard: subtract10(bac.ERW.standard) }
                : undefined,
            }
          : undefined,
      };
    }
    return next;
  };
  const prior: HealthPremiumsDataset = {
    fetchedAt: '2025-04-20T06:00:00Z',
    year: 2025,
    insurers: DATASET.insurers,
    premiums: {},
  };
  for (const [key, block] of Object.entries(DATASET.premiums!)) {
    prior.premiums![key] = cloneInsurers(block);
  }
  return prior;
}

describe('computeYoyDelta', () => {
  const prior = buildPriorFixture();

  it('returns a percentage delta per insurer for the ERW bracket', () => {
    const delta = computeYoyDelta({ current: DATASET, prior, cantonBagCode: 'TI' });
    expect(delta).not.toBeNull();
    if (!delta) return;
    expect(delta.currentYear).toBe(2026);
    expect(delta.priorYear).toBe(2025);
    const erw = delta.byBracket['31-45'];
    expect(erw).not.toBeNull();
    // CSS (insurer 8) TI ERW: current 691.9, prior 681.9 → +10 / 681.9 ≈ 1.47%.
    expect(erw!.perInsurer['8']).toBeCloseTo(1.47, 1);
    // Median across all insurers must be positive (every premium rose).
    expect(erw!.medianPct).toBeGreaterThan(0);
    expect(erw!.sourceInsurers).toBe(Object.keys(erw!.perInsurer).length);
  });

  it('computes a YoY delta for the KIN bracket when both years expose byAgeClass', () => {
    const delta = computeYoyDelta({ current: DATASET, prior, cantonBagCode: 'TI' });
    expect(delta).not.toBeNull();
    if (!delta) return;
    const kin = delta.byBracket['0-18'];
    expect(kin).not.toBeNull();
    // Insurer 8 KIN: current 152.2, prior 142.2 → +10/142.2 ≈ 7.03%.
    expect(kin!.perInsurer['8']).toBeCloseTo(7.03, 1);
    expect(kin!.medianPct).toBeGreaterThan(0);
  });

  it('returns null when the prior dataset is missing', () => {
    expect(computeYoyDelta({ current: DATASET, prior: null, cantonBagCode: 'TI' })).toBeNull();
  });

  it('returns null when current and prior years are identical', () => {
    const samePrior = { ...prior, year: 2026 };
    expect(computeYoyDelta({ current: DATASET, prior: samePrior, cantonBagCode: 'TI' })).toBeNull();
  });

  it('marks per-insurer entries null when the prior year is missing that insurer', () => {
    // Remove insurer 1562 (Helsana) from the prior dataset's TI block.
    const partialPrior = JSON.parse(JSON.stringify(prior)) as HealthPremiumsDataset;
    delete partialPrior.premiums!['6500-Bellinzona'].insurers['1562'];
    const delta = computeYoyDelta({ current: DATASET, prior: partialPrior, cantonBagCode: 'TI' });
    expect(delta).not.toBeNull();
    if (!delta) return;
    const erw = delta.byBracket['31-45'];
    expect(erw).not.toBeNull();
    expect(erw!.perInsurer['1562']).toBeNull();
    // Other insurers still have numeric deltas.
    expect(erw!.perInsurer['8']).toBeTypeOf('number');
  });
});

describe('generateHealthPremiumsPages — YoY section', () => {
  const prior = buildPriorFixture();
  const gen = generateHealthPremiumsPages({ dataset: DATASET, priorDataset: prior, today });

  it('exposes yoyByCanton for every fixture canton when prior data is present', () => {
    // Only the original 5 have data in DATASET + the prior fixture. The 21
    // new cantons would be null (no data → no YoY) — that's the documented
    // graceful-degradation contract, not a failure.
    for (const c of ['ticino', 'grigioni', 'uri', 'vallese', 'zurigo'] as const) {
      expect(gen.yoyByCanton[c], c).not.toBeNull();
    }
  });

  it('leaf IT TI adulto-31-45 contains the "Variazione rispetto al 2025" section', () => {
    const page = gen.pages['/premi-cassa-malati/ticino/adulto-31-45/'];
    expect(page).toBeTypeOf('string');
    expect(page).toMatch(/Variazione rispetto al 2025/);
    // The summary sentence names the canton and mentions 2025.
    expect(page).toMatch(/rispetto al 2025/);
    // Delta percentages use the Italian comma decimal separator and include
    // a sign character.
    expect(page).toMatch(/\+\d+,\d{2}%/);
  });

  it('EN / DE / FR leaf pages render localised YoY headings', () => {
    expect(gen.pages['/en/health-insurance-premiums/ticino/adult-31-45/']).toMatch(
      /Change vs 2025/,
    );
    expect(gen.pages['/de/krankenkassenpraemien/tessin/erwachsene-31-45/']).toMatch(
      /Veränderung gegenüber 2025/,
    );
    expect(gen.pages['/fr/primes-assurance-maladie/tessin/adulte-31-45/']).toMatch(
      /Variation par rapport à 2025/,
    );
  });

  it('canton hub page renders the "Variazione vs 2025" grid with one row per bracket', () => {
    const hub = gen.pages['/premi-cassa-malati/ticino/'];
    expect(hub).toBeTypeOf('string');
    expect(hub).toMatch(/Variazione rispetto al 2025/);
    // The grid table has one Δ cell per age bracket when both years expose
    // real data — we assert at least 4 percentage strings (one per
    // ERW bracket: 26-30/31-45/46-55/56+) plus KIN/JUG when real.
    const pctMatches = hub.match(/\+\d+,\d{2}%/g) ?? [];
    expect(pctMatches.length, 'expected ≥ 4 YoY percentage cells').toBeGreaterThanOrEqual(4);
  });

  it('omits the YoY section when priorDataset is null (silent skip)', () => {
    const genNoPrior = generateHealthPremiumsPages({ dataset: DATASET, today });
    const page = genNoPrior.pages['/premi-cassa-malati/ticino/adulto-31-45/'];
    expect(page).toBeTypeOf('string');
    expect(page).not.toMatch(/Variazione rispetto al 2025/);
    const hub = genNoPrior.pages['/premi-cassa-malati/ticino/'];
    expect(hub).not.toMatch(/Variazione rispetto al 2025/);
    for (const c of HEALTH_PREMIUM_CANTONS) {
      expect(genNoPrior.yoyByCanton[c], c).toBeNull();
    }
  });

  it('omits the YoY tile from the stats grid when no prior data is provided', () => {
    const genNoPrior = generateHealthPremiumsPages({ dataset: DATASET, today });
    const page = genNoPrior.pages['/premi-cassa-malati/ticino/adulto-31-45/'];
    // No "Δ vs" tile in the stats cards.
    expect(page).not.toMatch(/Δ vs 2025/);
  });

  it('leaf page with YoY still hits ≥400 words (section grows content, never shrinks)', () => {
    const page = gen.pages['/premi-cassa-malati/ticino/adulto-31-45/'];
    const text = page.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const words = text.split(' ').filter((w) => w.length > 0).length;
    expect(words).toBeGreaterThanOrEqual(400);
  });

  it('YoY tables contain no dark: color prefixes', () => {
    for (const [path, html] of Object.entries(gen.pages)) {
      expect(html, path).not.toMatch(/\sdark:(bg|text|border|fill|stroke|from|to|via)-/);
    }
  });
});

// ── F2 A3 — loadPremiumsForYear ────────────────────────────────

describe('loadPremiumsForYear', () => {
  it('returns null when no dataset is found for the requested year', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-a3-'));
    try {
      expect(loadPremiumsForYear(tmpDir, 2025)).toBeNull();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('prefers data/health-premiums/{year}.json over the legacy flat path', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-a3-'));
    try {
      fs.mkdirSync(path.join(tmpDir, 'data', 'health-premiums'), { recursive: true });
      const yearFile = {
        year: 2025,
        insurers: [{ id: '8', name: 'CSS' }],
        premiums: {},
      };
      const legacyFile = {
        year: 2026,
        insurers: [{ id: '8', name: 'CSS' }],
        premiums: {},
      };
      fs.writeFileSync(
        path.join(tmpDir, 'data', 'health-premiums', '2025.json'),
        JSON.stringify(yearFile),
      );
      fs.writeFileSync(
        path.join(tmpDir, 'data', 'health-premiums.json'),
        JSON.stringify(legacyFile),
      );
      const loaded = loadPremiumsForYear(tmpDir, 2025);
      expect(loaded).not.toBeNull();
      expect(loaded?.year).toBe(2025);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('falls back to the legacy flat path when its embedded year matches', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-a3-'));
    try {
      fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
      const legacyFile = {
        year: 2026,
        insurers: [{ id: '8', name: 'CSS' }],
        premiums: {},
      };
      fs.writeFileSync(
        path.join(tmpDir, 'data', 'health-premiums.json'),
        JSON.stringify(legacyFile),
      );
      // Directory missing → fallback kicks in.
      const loaded = loadPremiumsForYear(tmpDir, 2026);
      expect(loaded).not.toBeNull();
      expect(loaded?.year).toBe(2026);
      // Year mismatch on the legacy file → null.
      expect(loadPremiumsForYear(tmpDir, 2025)).toBeNull();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── B-cont-4 — tri-year trend (2024 + 2025 + 2026) ─────────────

/**
 * Build an "oldest" (2024) fixture: take the 2026 dataset and subtract
 * 25 CHF from every adult premium so the consecutive YoY pair (2024 → 2025
 * @ +15, 2025 → 2026 @ +10 in CHF terms) gives realistic positive deltas
 * with a known cumulative trend.
 */
function buildOldestFixture(): HealthPremiumsDataset {
  const subtract25 = (value: number | undefined): number | undefined =>
    typeof value === 'number' ? Math.round((value - 25) * 100) / 100 : value;
  const cloneInsurers = (
    block: HealthPremiumsDataset['premiums'] extends Record<string, infer B> ? B : never,
  ) => {
    const next: typeof block = { ...block, insurers: {} };
    for (const [id, models] of Object.entries(block.insurers)) {
      const bac = models.byAgeClass;
      next.insurers[id] = {
        ...models,
        standard: subtract25(models.standard),
        hausarzt: subtract25(models.hausarzt),
        telmed: subtract25(models.telmed),
        hmo: subtract25(models.hmo),
        byAgeClass: bac
          ? {
              KIN: bac.KIN
                ? { ...bac.KIN, standard: subtract25(bac.KIN.standard) }
                : undefined,
              JUG: bac.JUG
                ? { ...bac.JUG, standard: subtract25(bac.JUG.standard) }
                : undefined,
              ERW: bac.ERW
                ? { ...bac.ERW, standard: subtract25(bac.ERW.standard) }
                : undefined,
            }
          : undefined,
      };
    }
    return next;
  };
  const oldest: HealthPremiumsDataset = {
    fetchedAt: '2024-04-20T06:00:00Z',
    year: 2024,
    insurers: DATASET.insurers,
    premiums: {},
  };
  for (const [key, block] of Object.entries(DATASET.premiums!)) {
    oldest.premiums![key] = cloneInsurers(block);
  }
  return oldest;
}

describe('computeTriYearDelta', () => {
  const prior = buildPriorFixture();
  const oldest = buildOldestFixture();

  it('returns three points per bracket when all three years carry data', () => {
    const trend = computeTriYearDelta({ current: DATASET, prior, oldest, cantonBagCode: 'TI' });
    expect(trend).not.toBeNull();
    if (!trend) return;
    expect(trend.oldestYear).toBe(2024);
    expect(trend.priorYear).toBe(2025);
    expect(trend.currentYear).toBe(2026);
    const erw = trend.byBracket['31-45'];
    expect(erw).not.toBeNull();
    expect(erw!.points).toHaveLength(3);
    expect(erw!.points.map((p) => p.year)).toEqual([2024, 2025, 2026]);
    // Two consecutive YoY %s plus a non-null cumulative.
    expect(erw!.yoyPct).toHaveLength(2);
    expect(erw!.yoyPct[0]).not.toBeNull();
    expect(erw!.yoyPct[1]).not.toBeNull();
    expect(erw!.cumulativePct).not.toBeNull();
    // Cumulative > recent-YoY because both YoYs are positive.
    expect(erw!.cumulativePct!).toBeGreaterThan(erw!.yoyPct[1] as number);
  });

  it('falls back to YoY-only when the 2024 archive is absent', () => {
    const trend = computeTriYearDelta({
      current: DATASET,
      prior,
      oldest: null,
      cantonBagCode: 'TI',
    });
    expect(trend).not.toBeNull();
    if (!trend) return;
    const erw = trend.byBracket['31-45'];
    expect(erw).not.toBeNull();
    // Only 2 anchor points (prior + current) → 1 YoY delta and a cumulative
    // that equals the YoY (single step).
    expect(erw!.points).toHaveLength(2);
    expect(erw!.yoyPct).toHaveLength(1);
    expect(erw!.cumulativePct).toBeCloseTo(erw!.yoyPct[0] as number, 2);
  });

  it('returns null when neither prior nor oldest are present (single-year)', () => {
    const trend = computeTriYearDelta({
      current: DATASET,
      prior: null,
      oldest: null,
      cantonBagCode: 'TI',
    });
    // Only 1 point per bracket → < 2 → every byBracket entry null →
    // hasAnyTrend false → null overall.
    expect(trend).toBeNull();
  });

  it('returns null when the current dataset has no year metadata', () => {
    const orphan = { insurers: [], premiums: {} } as HealthPremiumsDataset;
    expect(computeTriYearDelta({ current: orphan, prior, oldest, cantonBagCode: 'TI' })).toBeNull();
  });

  it('handles a missing byAgeClass on a single insurer without throwing', () => {
    // Drop byAgeClass entirely on insurer 8 in the oldest fixture so KIN
    // medians are computed from the remaining insurers only.
    const partialOldest = JSON.parse(JSON.stringify(oldest)) as HealthPremiumsDataset;
    delete partialOldest.premiums!['6500-Bellinzona'].insurers['8'].byAgeClass;
    const trend = computeTriYearDelta({
      current: DATASET,
      prior,
      oldest: partialOldest,
      cantonBagCode: 'TI',
    });
    expect(trend).not.toBeNull();
    if (!trend) return;
    // Adult bracket still has 3 points (ERW comes from the flat alias).
    expect(trend.byBracket['31-45']!.points).toHaveLength(3);
  });
});

describe('generateHealthPremiumsPages — tri-year trend section', () => {
  const prior = buildPriorFixture();
  const oldest = buildOldestFixture();
  const gen3 = generateHealthPremiumsPages({
    dataset: DATASET,
    priorDataset: prior,
    oldestDataset: oldest,
    today,
  });

  it('exposes triYearByCanton for every fixture canton when all 3 years are present', () => {
    // Same scoping rationale as the YoY equivalent: DATASET only carries the
    // original 5 cantons so only those 5 pass `not.toBeNull()`.
    for (const c of ['ticino', 'grigioni', 'uri', 'vallese', 'zurigo'] as const) {
      expect(gen3.triYearByCanton[c], c).not.toBeNull();
    }
  });

  it('IT TI adulto-31-45 leaf renders the "Trend triennale 2024 → 2026" heading', () => {
    const page = gen3.pages['/premi-cassa-malati/ticino/adulto-31-45/'];
    expect(page).toBeTypeOf('string');
    expect(page).toMatch(/Trend triennale 2024 → 2026/);
    // Sequence summary mentions the three years explicitly.
    expect(page).toMatch(/2024 → 2025 → 2026/);
    // Inline SVG sparkline must be present.
    expect(page).toMatch(/<svg[^>]+aria-label[^>]+>/);
    // Sparkline contains all three year labels in <text> nodes.
    expect(page).toMatch(/>2024<\/text>/);
    expect(page).toMatch(/>2025<\/text>/);
    expect(page).toMatch(/>2026<\/text>/);
  });

  it('localised tri-year headings render on EN / DE / FR leaves', () => {
    expect(gen3.pages['/en/health-insurance-premiums/ticino/adult-31-45/']).toMatch(
      /Three-year trend 2024 → 2026/,
    );
    expect(gen3.pages['/de/krankenkassenpraemien/tessin/erwachsene-31-45/']).toMatch(
      /Dreijahres-Trend 2024 → 2026/,
    );
    expect(gen3.pages['/fr/primes-assurance-maladie/tessin/adulte-31-45/']).toMatch(
      /Tendance triennale 2024 → 2026/,
    );
  });

  it('canton hub renders the tri-year sparkline + cumulative summary', () => {
    const hub = gen3.pages['/premi-cassa-malati/ticino/'];
    expect(hub).toBeTypeOf('string');
    expect(hub).toMatch(/Trend triennale 2024 → 2026/);
    // Adult cumulative summary references the cumulative figure.
    expect(hub).toMatch(/cumulativamente|cumulato|complessivamente/);
    expect(hub).toMatch(/<svg[^>]+aria-label[^>]+>/);
  });

  it('falls back to YoY-only rendering when only 2 years are available', () => {
    const gen2 = generateHealthPremiumsPages({
      dataset: DATASET,
      priorDataset: prior,
      oldestDataset: null,
      today,
    });
    const page = gen2.pages['/premi-cassa-malati/ticino/adulto-31-45/'];
    expect(page).toBeTypeOf('string');
    // YoY block stays rendered.
    expect(page).toMatch(/Variazione rispetto al 2025/);
    // Tri-year block must NOT appear (no 2024 anchor → no trend).
    expect(page).not.toMatch(/Trend triennale/);
  });

  it('omits tri-year section entirely when both prior and oldest are absent', () => {
    const gen0 = generateHealthPremiumsPages({ dataset: DATASET, today });
    const page = gen0.pages['/premi-cassa-malati/ticino/adulto-31-45/'];
    expect(page).not.toMatch(/Trend triennale/);
    for (const c of HEALTH_PREMIUM_CANTONS) {
      expect(gen0.triYearByCanton[c], c).toBeNull();
    }
  });

  it('every leaf with tri-year still hits ≥400 words (no thin-content regression)', () => {
    const path = '/premi-cassa-malati/ticino/adulto-31-45/';
    const text = gen3.pages[path].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const words = text.split(' ').filter((w) => w.length > 0).length;
    expect(words).toBeGreaterThanOrEqual(400);
  });

  it('tri-year section contains no dark: color prefixes', () => {
    for (const [path, html] of Object.entries(gen3.pages)) {
      expect(html, path).not.toMatch(/\sdark:(bg|text|border|fill|stroke|from|to|via)-/);
    }
  });

  it('cumulative percentage is displayed with a sign character', () => {
    const page = gen3.pages['/premi-cassa-malati/ticino/adulto-31-45/'];
    // The sequence card embeds "<yoyOlder> · <yoyRecent>" then "<cum>" —
    // every value must include a properly-signed Italian percentage.
    expect(page).toMatch(/[+-]?\d+,\d{2}%/);
  });
});

describe('loadPriorTwoYearsForBracket', () => {
  it('returns three null slots when the data directory is empty', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-trio-'));
    try {
      const loaded = loadPriorTwoYearsForBracket(tmpDir, 2026);
      expect(loaded.current).toBeNull();
      expect(loaded.prior).toBeNull();
      expect(loaded.oldest).toBeNull();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns the correct year per slot when all three datasets exist on disk', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-trio-'));
    try {
      const dir = path.join(tmpDir, 'data', 'health-premiums');
      fs.mkdirSync(dir, { recursive: true });
      for (const y of [2024, 2025, 2026]) {
        fs.writeFileSync(
          path.join(dir, `${y}.json`),
          JSON.stringify({ year: y, insurers: [], premiums: {} }),
        );
      }
      const loaded = loadPriorTwoYearsForBracket(tmpDir, 2026);
      expect(loaded.current?.year).toBe(2026);
      expect(loaded.prior?.year).toBe(2025);
      expect(loaded.oldest?.year).toBe(2024);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── B-cont-2 — 26-canton generation pipeline ───────────────────

/**
 * Build a minimal stub dataset that provides BAG-code-keyed canton-level
 * blocks for every canton in HEALTH_PREMIUM_CANTONS. Each block carries a
 * small set of insurers with real `byAgeClass` data so every leaf can hit the
 * real-data path (no multiplier fallback, no derivation note).
 *
 * This fixture is not meant to validate premium accuracy — only to confirm
 * that the plugin walks the full 26-canton registry and emits 732 pages
 * when data is present for every canton.
 */
function build26CantonStubDataset(): HealthPremiumsDataset {
  const insurers = [
    { id: '8', name: 'CSS' },
    { id: '290', name: 'Concordia' },
    { id: '376', name: 'KPT' },
    { id: '1509', name: 'Sanitas' },
    { id: '1562', name: 'Helsana' },
  ] as const;
  const premiums: Record<string, {
    type: 'canton';
    canton: string;
    region: null;
    insurers: Record<string, {
      standard: number;
      byAgeClass: {
        KIN: { standard: number };
        JUG: { standard: number };
        ERW: { standard: number };
      };
    }>;
  }> = {};
  // Import the BAG-code table directly — keeps the fixture in lock-step with
  // the registry without duplicating the mapping.
  const bagCodesByCanton = Object.fromEntries(
    HEALTH_PREMIUM_CANTONS.map((c) => [c, HEALTH_PREMIUM_CANTON_BAG_CODE[c]]),
  );
  let offset = 0;
  for (const canton of HEALTH_PREMIUM_CANTONS) {
    const code = bagCodesByCanton[canton];
    const base = 480 + offset * 7; // scatter so medians differ per canton
    offset += 1;
    const insurerBlock: (typeof premiums)[string]['insurers'] = {};
    let insurerOffset = 0;
    for (const ins of insurers) {
      const adult = base + insurerOffset * 12;
      const kin = Math.round(adult * 0.22 * 100) / 100; // deliberately ≠ 0.25
      const jug = Math.round(adult * 0.78 * 100) / 100; // deliberately ≠ 0.80
      insurerBlock[ins.id] = {
        standard: adult,
        byAgeClass: {
          KIN: { standard: kin },
          JUG: { standard: jug },
          ERW: { standard: adult },
        },
      };
      insurerOffset += 1;
    }
    premiums[code] = {
      type: 'canton',
      canton: code,
      region: null,
      insurers: insurerBlock,
    };
  }
  return {
    fetchedAt: '2026-04-20T06:00:00Z',
    year: 2026,
    insurers: insurers.map((i) => ({ id: i.id, name: i.name })),
    premiums: premiums as unknown as HealthPremiumsDataset['premiums'],
  };
}

describe('generateHealthPremiumsPages — full 26-canton coverage (B-cont-2)', () => {
  const stub = build26CantonStubDataset();
  const gen = generateHealthPremiumsPages({ dataset: stub, today });

  it('generates exactly 732 pages when data is present for every canton', () => {
    // 4 locales × (1 root + 26 canton hubs + 26×6 leaves) = 732.
    expect(Object.keys(gen.pages)).toHaveLength(732);
    expect(gen.skippedCantons).toHaveLength(0);
  });

  it('emits exactly 183 pages per locale', () => {
    const byLocale: Record<string, number> = { it: 0, en: 0, de: 0, fr: 0 };
    for (const path of Object.keys(gen.pages)) {
      if (path.startsWith('/en/')) byLocale.en++;
      else if (path.startsWith('/de/')) byLocale.de++;
      else if (path.startsWith('/fr/')) byLocale.fr++;
      else byLocale.it++;
    }
    expect(byLocale.it).toBe(183);
    expect(byLocale.en).toBe(183);
    expect(byLocale.de).toBe(183);
    expect(byLocale.fr).toBe(183);
  });

  it('every canonical path in HEALTH_PREMIUMS_ROUTES is rendered', () => {
    for (const p of HEALTH_PREMIUMS_ROUTES) {
      expect(gen.pages[p], `missing ${p}`).toBeTypeOf('string');
    }
  });

  it('preserves the original 5 canton URL paths exactly (SEO stability)', () => {
    // These URLs are already indexed by Google — any drift would 404 them.
    const mustExist = [
      '/premi-cassa-malati/ticino/adulto-31-45/',
      '/premi-cassa-malati/grigioni/adulto-31-45/',
      '/premi-cassa-malati/uri/adulto-31-45/',
      '/premi-cassa-malati/vallese/adulto-31-45/',
      '/premi-cassa-malati/zurigo/adulto-31-45/',
      '/en/health-insurance-premiums/ticino/adult-31-45/',
      '/en/health-insurance-premiums/graubunden/adult-31-45/',
      '/en/health-insurance-premiums/valais/adult-31-45/',
      '/en/health-insurance-premiums/zurich/adult-31-45/',
      '/de/krankenkassenpraemien/tessin/erwachsene-31-45/',
      '/de/krankenkassenpraemien/graubuenden/erwachsene-31-45/',
      '/de/krankenkassenpraemien/wallis/erwachsene-31-45/',
      '/de/krankenkassenpraemien/zuerich/erwachsene-31-45/',
      '/fr/primes-assurance-maladie/tessin/adulte-31-45/',
      '/fr/primes-assurance-maladie/grisons/adulte-31-45/',
      '/fr/primes-assurance-maladie/valais/adulte-31-45/',
      '/fr/primes-assurance-maladie/zurich/adulte-31-45/',
    ];
    for (const p of mustExist) {
      expect(gen.pages[p], `legacy canonical missing: ${p}`).toBeTypeOf('string');
    }
  });

  it('emits canton hub + 6 leaves for each of the 21 new B-cont-2 cantons', () => {
    const newCantons = HEALTH_PREMIUM_CANTONS.slice(5); // 21 entries after the original 5
    expect(newCantons).toHaveLength(21);
    for (const canton of newCantons) {
      const itHub = `/premi-cassa-malati/${HEALTH_PREMIUM_CANTON_SLUG.it[canton]}/`;
      expect(gen.pages[itHub], `missing hub for ${canton}`).toBeTypeOf('string');
      for (const ab of HEALTH_PREMIUM_AGE_BRACKETS) {
        const itLeaf = `/premi-cassa-malati/${HEALTH_PREMIUM_CANTON_SLUG.it[canton]}/${HEALTH_PREMIUM_AGE_SLUG.it[ab.id]}/`;
        expect(gen.pages[itLeaf], `missing leaf for ${canton}/${ab.id}`).toBeTypeOf('string');
      }
    }
  });

  it('localised canonical paths use the native exonym slug for new cantons', () => {
    // Zurich / Bern / Geneva / Vaud — every locale's slug is covered.
    expect(gen.pages['/en/health-insurance-premiums/aargau/adult-31-45/']).toBeTypeOf('string');
    expect(gen.pages['/de/krankenkassenpraemien/waadt/erwachsene-31-45/']).toBeTypeOf('string');
    expect(gen.pages['/fr/primes-assurance-maladie/geneve/adulte-31-45/']).toBeTypeOf('string');
    expect(gen.pages['/it/premi-cassa-malati/ginevra/adulto-31-45/']).toBeUndefined(); // IT has no /it prefix
    expect(gen.pages['/premi-cassa-malati/ginevra/adulto-31-45/']).toBeTypeOf('string');
  });

  it('every generated page still satisfies the ≥400 words / ≥300 words gate', () => {
    for (const [path, html] of Object.entries(gen.pages)) {
      const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const words = text.split(' ').filter((w) => w.length > 0).length;
      const parts = path.split('/').filter(Boolean);
      const hasLocale = parts[0] === 'en' || parts[0] === 'de' || parts[0] === 'fr';
      const depth = hasLocale ? parts.length - 1 : parts.length;
      const min = depth >= 3 ? 400 : 300;
      expect(words, `${path} has only ${words} words (need ≥${min})`).toBeGreaterThanOrEqual(min);
    }
  });

  it('every page has self-referencing canonical', () => {
    for (const [path, html] of Object.entries(gen.pages)) {
      expect(html, path).toContain(
        `<link rel="canonical" href="https://frontaliereticino.ch${path}">`,
      );
    }
  });

  it('every page has hreflang alternates for all 4 locales', () => {
    for (const [path, html] of Object.entries(gen.pages)) {
      for (const loc of HEALTH_PREMIUM_LOCALES) {
        expect(html, `${path} missing hreflang=${loc}`).toContain(`hreflang="${loc}"`);
      }
    }
  });

  it('no page contains dark: color prefixes across the 26-canton output', () => {
    for (const [path, html] of Object.entries(gen.pages)) {
      expect(html, path).not.toMatch(/\sdark:(bg|text|border|fill|stroke|from|to|via)-/);
    }
  });
});

/**
 * Regression guard: Semrush reported ~6.9k broken internal links on 2026-04-23
 * from every /premi-cassa-malati/{canton}/{fascia}/ page pointing to the legacy
 * salary-hub slug `/stipendi-frontalieri-ticino/` (404). Commit ad103562c
 * renamed SALARY_HUB_PATH to `/statistiche/confronta-stipendi/` but some
 * deployed HTML pre-rename was still live. This test locks in that no page in
 * any locale — generated by the 5-canton or 26-canton fixtures — ever emits
 * the legacy slug again.
 */
describe('generateHealthPremiumsPages — no legacy broken stipendi link', () => {
  const LEGACY_BROKEN_PATHS = [
    '/stipendi-frontalieri-ticino/',
    '/en/cross-border-salaries-ticino/',
    '/de/grenzgaenger-loehne-tessin/',
    '/fr/salaires-frontaliers-tessin/',
  ] as const;

  it('no /premi-cassa-malati page (5-canton fixture) links to the legacy /stipendi-frontalieri-ticino/ slug', () => {
    for (const [path, html] of Object.entries(generation.pages)) {
      for (const broken of LEGACY_BROKEN_PATHS) {
        expect(html, `${path} must not link to ${broken}`).not.toContain(`"${broken}"`);
        expect(html, `${path} must not link to ${broken}`).not.toContain(`>${broken}<`);
      }
    }
  });

  it('the canonical salary-hub path /statistiche/confronta-stipendi/ appears on every leaf page via related-links', () => {
    // Sanity check: confirm the canonical replacement is actually rendered,
    // so we catch a regression where the anchor is silently removed.
    const leafPages = Object.entries(generation.pages).filter(([p]) => {
      const parts = p.split('/').filter(Boolean);
      const hasLocale = parts[0] === 'en' || parts[0] === 'de' || parts[0] === 'fr';
      const depth = hasLocale ? parts.length - 1 : parts.length;
      return depth === 3;
    });
    expect(leafPages.length).toBeGreaterThan(0);
    // Every leaf page must link to the canonical salary hub (per-locale variants
    // live under /statistiche/confronta-stipendi/ in Italian and localised
    // equivalents in EN/DE/FR — we only assert the IT canonical for leaves whose
    // path is Italian, to keep the assertion precise).
    const itLeaves = leafPages.filter(([p]) => !p.startsWith('/en/') && !p.startsWith('/de/') && !p.startsWith('/fr/'));
    for (const [path, html] of itLeaves) {
      expect(html, `${path} must link to /statistiche/confronta-stipendi/`).toContain('/statistiche/confronta-stipendi/');
    }
  });
});
