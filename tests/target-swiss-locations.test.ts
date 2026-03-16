import { describe, expect, it } from 'vitest';
import {
  GRIGIONI_MUNICIPALITIES,
  inferSwissTargetCanton,
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
    expect(isTargetSwissLocation('Zurich, CH')).toBe(false);
    expect(inferSwissTargetCanton('Geneva, CH')).toBe('');
  });
});
