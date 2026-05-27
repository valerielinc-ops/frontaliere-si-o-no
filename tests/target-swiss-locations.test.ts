import { describe, expect, it } from 'vitest';
import {
  GRIGIONI_MUNICIPALITIES,
  inferSwissTargetCanton,
  isCantonRelevant,
  isGrigioniRelevant,
  isTargetSwissLocation,
  isTicinoRelevant,
  TICINO_MUNICIPALITIES,
} from '../scripts/lib/target-swiss-locations.mjs';

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

  it('does not classify unrelated Swiss cities as target', () => {
    // Cathedral 2026-05-10: TARGET_CANTONS now covers all 26 CH cantons —
    // Zurich (ZH) and Geneva (GE) are now targets. Assert non-CH locations instead.
    expect(isTargetSwissLocation('Milan, IT')).toBe(false);
    expect(inferSwissTargetCanton('Tokyo, JP')).toBe('');
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
