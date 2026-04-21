/**
 * Tests for F2 LAMal health-premium SEO landings.
 *
 * Covers:
 *  - Slug tables + path builders for all 4 locales × 5 cantons × 6 age brackets
 *  - Route enumeration: 144 unique canonical paths (4 × 36)
 *  - Stats computation (median / min / max) on both canton-level and
 *    commune-level source blocks
 *  - Page generation: ≥50 hard gate, ≥400 words for every leaf page,
 *    ≥300 words for every hub, JSON-LD present and parseable, canonical
 *    self-referent, hreflang alternates for all 4 locales, FAQ markup
 *  - Locale completeness (each page exists in all 4 locales)
 *  - No `dark:` color prefixes anywhere in the generated HTML
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

  it('exposes exactly 5 cantons', () => {
    expect(HEALTH_PREMIUM_CANTONS).toEqual(['ticino', 'grigioni', 'uri', 'vallese', 'zurigo']);
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
  it('generates exactly 144 paths (4 locales × (1 root + 5 canton hubs + 30 leaves))', () => {
    const paths = listHealthPremiumsPaths();
    expect(paths).toHaveLength(144);
  });

  it('all 144 paths are unique', () => {
    const paths = listHealthPremiumsPaths();
    const unique = new Set(paths.map((p) => p.path));
    expect(unique.size).toBe(144);
  });

  it('HEALTH_PREMIUMS_ROUTES mirrors listHealthPremiumsPaths()', () => {
    expect(HEALTH_PREMIUMS_ROUTES).toHaveLength(144);
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

  it('isHealthPremiumsPath rejects unrelated paths', () => {
    expect(isHealthPremiumsPath('/')).toBe(false);
    expect(isHealthPremiumsPath('/compara-servizi/confronta-casse-malati/')).toBe(false);
    expect(isHealthPremiumsPath('/cerca-lavoro-ticino/lugano/')).toBe(false);
  });

  it('locale coverage — exactly 36 paths per locale', () => {
    const byLocale: Record<string, number> = { it: 0, en: 0, de: 0, fr: 0 };
    for (const p of listHealthPremiumsPaths()) {
      byLocale[p.locale]++;
    }
    expect(byLocale.it).toBe(36);
    expect(byLocale.en).toBe(36);
    expect(byLocale.de).toBe(36);
    expect(byLocale.fr).toBe(36);
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
  it('generates exactly 144 pages when all 5 cantons have data', () => {
    expect(Object.keys(generation.pages)).toHaveLength(144);
    expect(generation.skippedCantons).toHaveLength(0);
  });

  it('locale coverage — exactly 36 pages per locale', () => {
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

  it('every path in HEALTH_PREMIUMS_ROUTES is rendered', () => {
    for (const p of HEALTH_PREMIUMS_ROUTES) {
      expect(generation.pages[p], `missing ${p}`).toBeTypeOf('string');
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
    expect(leaves.length).toBe(120); // 5 cantons × 6 brackets × 4 locales
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

  it('ERW bracket is real across all cantons (legacy datasets alias ERW in flat fields)', () => {
    for (const canton of HEALTH_PREMIUM_CANTONS) {
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
        // no GR / UR / VS / ZH entries
      },
    };
    const { pages, skippedCantons } = generateHealthPremiumsPages({ dataset: partial, today });
    expect(skippedCantons.sort()).toEqual(['grigioni', 'uri', 'vallese', 'zurigo']);
    // Roots are still emitted (4 roots), TI canton hub + 6 TI leaves per locale = 7 × 4 = 28.
    // Total: 4 + 28 = 32.
    expect(Object.keys(pages)).toHaveLength(32);
  });

  it('produces zero pages when dataset is empty but does not throw', () => {
    const { pages, skippedCantons } = generateHealthPremiumsPages({
      dataset: { insurers: [], premiums: {} },
      today,
    });
    expect(skippedCantons).toHaveLength(5);
    // Only roots remain (4 locales × 1 root)
    expect(Object.keys(pages)).toHaveLength(4);
  });
});
