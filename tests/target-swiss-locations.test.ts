import { describe, expect, it } from 'vitest';
import {
  GRIGIONI_MUNICIPALITIES,
  canonicalSwissCityName,
  inferAnyCanton,
  inferSwissTargetCanton,
  isCantonRelevant,
  isAllSwissLocation,
  isGrigioniRelevant,
  isKnownSwissMunicipalityInCanton,
  isTargetSwissLocation,
  isTicinoRelevant,
  TICINO_MUNICIPALITIES,
} from '../scripts/lib/target-swiss-locations.mjs';
import { ALL_CANTON_CODES, TARGET_CANTONS } from '../scripts/lib/crawler-location-config.mjs';

describe('target swiss locations', () => {
  it('recognizes extended Ticino municipalities like Bedano', () => {
    expect(isTicinoRelevant('Bedano, CH, 6930')).toBe(true);
    expect(inferSwissTargetCanton('Bedano, CH, 6930')).toBe('TI');
  });

  it('recognizes Grigioni locations', () => {
    expect(isGrigioniRelevant('Chur, CH')).toBe(true);
    expect(isTargetSwissLocation('Coira, CH')).toBe(true);
    expect(inferSwissTargetCanton('Landquart, CH')).toBe('GR');
  });

  it('ships the official BFS municipality snapshots for TI and GR', () => {
    expect(TICINO_MUNICIPALITIES).toContain("Sant'Antonino");
    expect(TICINO_MUNICIPALITIES).toContain('Torricella-Taverne');
    expect(GRIGIONI_MUNICIPALITIES).toContain('Santa Maria in Calanca');
    expect(GRIGIONI_MUNICIPALITIES).toContain('Roveredo (GR)');
  });

  it('keeps legacy locality aliases used by job boards after municipal mergers', () => {
    expect(isTicinoRelevant('Giubiasco, CH')).toBe(true);
    expect(inferSwissTargetCanton('Coira, Switzerland')).toBe('GR');
  });

  it('canonicalizes Davos sub-localities to their BFS municipality parent', () => {
    expect(canonicalSwissCityName('Davos Platz')).toBe('Davos');
    expect(canonicalSwissCityName('Davos Glaris')).toBe('Davos');
  });

  it('uses ambiguous raw municipality names once the canton disambiguates them', () => {
    expect(isKnownSwissMunicipalityInCanton('Court', 'BE')).toBe(true);
    expect(isKnownSwissMunicipalityInCanton('Sâles', 'FR')).toBe(true);
    expect(isKnownSwissMunicipalityInCanton('Concise', 'VD')).toBe(true);
    expect(isKnownSwissMunicipalityInCanton('Court', 'FR')).toBe(false);
  });

  it('does not classify unrelated Swiss cities as target', () => {
    // Cathedral 2026-05-10: TARGET_CANTONS now covers all 26 CH cantons —
    // Zurich (ZH) and Geneva (GE) are now targets. Assert non-CH locations instead.
    expect(isTargetSwissLocation('Milan, IT')).toBe(false);
    expect(inferSwissTargetCanton('Tokyo, JP')).toBe('');
  });

  it('keeps the target scope aligned with all 26 Swiss cantons', () => {
    expect(TARGET_CANTONS).toHaveLength(ALL_CANTON_CODES.length);
    expect(new Set(TARGET_CANTONS)).toEqual(new Set(ALL_CANTON_CODES));
  });

  it('exposes an explicit all-canton predicate for national crawlers', () => {
    expect(isAllSwissLocation('Aarau, Switzerland', { includeBorderProximity: false })).toBe(true);
    expect(isAllSwissLocation('Como, Italy', { includeBorderProximity: false })).toBe(false);
  });

  it('accepts a representative municipality from every Swiss canton', () => {
    const representativeByCanton = {
      AG: 'Aarau', AI: 'Appenzell', AR: 'Herisau', BE: 'Bern',
      BL: 'Liestal', BS: 'Basel', FR: 'Fribourg', GE: 'Genève',
      GL: 'Glarus', GR: 'Chur', JU: 'Delémont', LU: 'Luzern',
      NE: 'Neuchâtel', NW: 'Stans', OW: 'Sarnen', SG: 'St. Gallen',
      SH: 'Schaffhausen', SO: 'Solothurn', SZ: 'Schwyz', TG: 'Frauenfeld',
      TI: 'Lugano', UR: 'Altdorf', VD: 'Lausanne', VS: 'Sion',
      ZG: 'Zug', ZH: 'Zürich',
    };

    expect(Object.keys(representativeByCanton)).toEqual(expect.arrayContaining(ALL_CANTON_CODES));
    for (const city of Object.values(representativeByCanton)) {
      expect(isTargetSwissLocation(`${city}, Switzerland`)).toBe(true);
    }
  });

  it('honors explicit parenthesized canton codes before same-name city aliases', () => {
    expect(inferSwissTargetCanton('Buchs (AG)')).toBe('AG');
    expect(inferSwissTargetCanton('Reinach (AG)')).toBe('AG');
    expect(inferAnyCanton('Buchs (AG)')).toBe('AG');
  });

  it('prefers a full canton name over a shorter alias from another canton', () => {
    expect(inferSwissTargetCanton('Stein Appenzell Ausserrhoden')).toBe('AR');
    expect(inferAnyCanton('Stein Appenzell Ausserrhoden')).toBe('AR');
  });

  it('prefers an explicit canton name over a city alias from another canton', () => {
    expect(inferSwissTargetCanton('Reinach, Aargau')).toBe('AG');
    expect(inferAnyCanton('Reinach, Aargau')).toBe('AG');
  });

  // ── VS (Valais/Wallis) canton matching ──
  describe('Valais (VS) canton matching', () => {
    it('recognizes VS major cities', () => {
      expect(isCantonRelevant('Sion, CH', 'VS')).toBe(true);
      expect(isCantonRelevant('Brig, Switzerland', 'VS')).toBe(true);
      expect(isCantonRelevant('Visp', 'VS')).toBe(true);
      expect(isCantonRelevant('Martigny', 'VS')).toBe(true);
      expect(isCantonRelevant('Monthey', 'VS')).toBe(true);
      expect(isCantonRelevant('Sierre', 'VS')).toBe(true);
    });

    it('recognizes VS canton names in all languages', () => {
      expect(isCantonRelevant('Valais', 'VS')).toBe(true);
      expect(isCantonRelevant('Wallis', 'VS')).toBe(true);
      expect(isCantonRelevant('Vallese', 'VS')).toBe(true);
    });

    it('recognizes VS BFS municipalities', () => {
      expect(isCantonRelevant('Fully', 'VS')).toBe(true);
      expect(isCantonRelevant('Conthey', 'VS')).toBe(true);
      expect(isCantonRelevant('Naters', 'VS')).toBe(true);
      expect(isCantonRelevant('Zermatt', 'VS')).toBe(true);
    });

    it('recognizes VS location aliases', () => {
      expect(isCantonRelevant('Crans-Montana', 'VS')).toBe(true);
      expect(isCantonRelevant('Saas-Fee', 'VS')).toBe(true);
      expect(isCantonRelevant('Verbier', 'VS')).toBe(true);
      expect(isCantonRelevant('Leukerbad', 'VS')).toBe(true);
    });

    it('does not cross-match TI locations as VS', () => {
      expect(isCantonRelevant('Lugano', 'VS')).toBe(false);
      expect(isCantonRelevant('Bellinzona', 'VS')).toBe(false);
      expect(isCantonRelevant('Ticino', 'VS')).toBe(false);
    });

    it('does not cross-match VS locations as TI', () => {
      expect(isCantonRelevant('Sion', 'TI')).toBe(false);
      expect(isCantonRelevant('Valais', 'TI')).toBe(false);
      expect(isCantonRelevant('Brig', 'TI')).toBe(false);
    });
  });

  describe('inferSwissTargetCanton for VS', () => {
    it('infers VS from city names', () => {
      expect(inferSwissTargetCanton('Lavoro a Sion, VS')).toBe('VS');
      expect(inferSwissTargetCanton('Martigny, Valais, CH')).toBe('VS');
      expect(inferSwissTargetCanton('Visp (VS)')).toBe('VS');
    });

    it('infers VS from canton name', () => {
      expect(inferSwissTargetCanton('Canton Valais')).toBe('VS');
      expect(inferSwissTargetCanton('Wallis, Schweiz')).toBe('VS');
    });
  });

  describe('isTargetSwissLocation includes VS', () => {
    it('recognizes VS locations as target', () => {
      expect(isTargetSwissLocation('Sion, CH')).toBe(true);
      expect(isTargetSwissLocation('Martigny')).toBe(true);
      expect(isTargetSwissLocation('Brig-Glis')).toBe(true);
    });
  });

  describe('backward compatibility', () => {
    it('TI/GR wrapper functions still work', () => {
      expect(isTicinoRelevant('Lugano')).toBe(true);
      expect(isGrigioniRelevant('Chur')).toBe(true);
      expect(isTicinoRelevant('Sion')).toBe(false);
      expect(isGrigioniRelevant('Martigny')).toBe(false);
    });

    it('TICINO_MUNICIPALITIES and GRIGIONI_MUNICIPALITIES are non-empty arrays', () => {
      expect(TICINO_MUNICIPALITIES.length).toBeGreaterThan(90);
      expect(GRIGIONI_MUNICIPALITIES.length).toBeGreaterThan(90);
    });
  });
});
