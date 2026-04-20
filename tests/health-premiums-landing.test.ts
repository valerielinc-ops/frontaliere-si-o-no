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
 * - TI: commune-level block (matches shape in data/health-premiums.json).
 * - GR: commune-level block.
 * - VS: commune-level block.
 * - UR: canton-level block.
 * - ZH: canton-level block.
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
        '8': { standard: 691.9, hausarzt: 577.8, telmed: 633.1 },
        '32': { standard: 648.8, telmed: 564.5 },
        '290': { standard: 686, hausarzt: 610.6, telmed: 590 },
        '312': { standard: 695, hausarzt: 610.2, telmed: 622.1 },
        '343': { standard: 723.3, hausarzt: 640.1, telmed: 636.5 },
        '376': { standard: 683.2, hmo: 570.4, hausarzt: 598.6, telmed: 570.4 },
        '455': { standard: 681.7, hausarzt: 613.6, telmed: 623.8 },
        '509': { standard: 705, telmed: 613.4, hausarzt: 627.5 },
        '881': { standard: 692.1, hausarzt: 591.8, telmed: 591.8 },
        '966': { standard: 712.7 },
        '1384': { standard: 768.7, hausarzt: 622.7, telmed: 714.9 },
        '1386': { standard: 647, telmed: 588.8 },
        '1401': { standard: 708.3 },
        '1479': { standard: 718.4, hausarzt: 653.7, telmed: 635.8 },
        '1509': { standard: 676.3, hausarzt: 588.35, telmed: 581.7 },
        '1535': { standard: 718.5, hausarzt: 643, telmed: 614.3 },
        '1542': { standard: 684, hausarzt: 574.6 },
        '1555': { standard: 766.2, telmed: 674.3, hausarzt: 674.3 },
        '1560': { telmed: 554.7, standard: 645.1 },
        '1562': { standard: 696.6, hausarzt: 592.1, telmed: 585.1 },
        '1568': { standard: 693.7, telmed: 603.5, hausarzt: 665.9 },
      },
    },
    '7000-Chur': {
      canton: 'GR',
      region: 1,
      bfsNr: 3901,
      insurers: {
        '8': { standard: 580.5, hausarzt: 520 },
        '290': { standard: 570 },
        '312': { standard: 560.5 },
        '343': { standard: 590 },
        '376': { standard: 555 },
        '455': { standard: 540.3, hausarzt: 495.9 },
        '509': { standard: 585 },
        '881': { standard: 560 },
        '1384': { standard: 612.6 },
        '1479': { standard: 580 },
        '1509': { standard: 545 },
        '1555': { standard: 610 },
      },
    },
    '1950-Sion': {
      canton: 'VS',
      region: 1,
      bfsNr: 6266,
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
        '8': { standard: 410.5, hausarzt: 370 },
        '290': { standard: 395 },
        '312': { standard: 405 },
        '343': { standard: 420 },
        '376': { standard: 390 },
        '455': { standard: 385 },
        '509': { standard: 405 },
        '881': { standard: 395 },
        '1384': { standard: 430 },
        '1479': { standard: 405 },
        '1509': { standard: 380 },
        '1555': { standard: 425 },
      },
    },
    ZH: {
      type: 'canton',
      canton: 'ZH',
      region: null,
      insurers: {
        '8': { standard: 515 },
        '290': { standard: 500 },
        '312': { standard: 510 },
        '343': { standard: 525 },
        '376': { standard: 495 },
        '455': { standard: 490 },
        '509': { standard: 510 },
        '881': { standard: 505 },
        '1384': { standard: 540 },
        '1479': { standard: 515 },
        '1509': { standard: 485 },
        '1555': { standard: 530 },
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
