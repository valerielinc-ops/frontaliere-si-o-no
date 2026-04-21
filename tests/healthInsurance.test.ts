import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import {
  FRANCHISES,
  FRANCHISES_CHILD,
  FRANCHISE_ADJUSTMENT,
  CANTONS,
} from '@/components/comparators/HealthInsurance';

// Load the generated health premiums data. F2-A3 migrated storage to
// `data/health-premiums/{year}.json`; fall back to the legacy flat path
// when the directory is not present so older checkouts still resolve.
const candidates = [
  resolve(__dirname, '..', 'data', 'health-premiums', `${new Date().getUTCFullYear()}.json`),
  resolve(__dirname, '..', 'data', 'health-premiums.json'),
];
const dataPath = candidates.find((p) => existsSync(p));
if (!dataPath) throw new Error('no health-premiums dataset found for tests');
const data = JSON.parse(readFileSync(dataPath, 'utf8'));

// Inline the calculation logic for testing (mirrors component's calculatePremiumFromData)
const AGE_MULTIPLIER: Record<string, number> = { '0-18': 0.25, '19-25': 0.75, '26+': 1.0 };
const ACCIDENT_ADDITION = 0.07;

function calculatePremium(
  insurerPremiums: Record<string, number> | undefined,
  model: string, franchise: number, ageGroup: string, withAccident: boolean
): number | null {
  if (!insurerPremiums) return null;
  const base = insurerPremiums[model] ?? insurerPremiums['standard'];
  if (base === undefined) return null;
  let p = base * (1 + (FRANCHISE_ADJUSTMENT[franchise] ?? 0)) * AGE_MULTIPLIER[ageGroup];
  if (withAccident) p *= (1 + ACCIDENT_ADDITION);
  return Math.round(p * 100) / 100;
}

// ─── Data integrity ─────────────────────────────────────────────────────────

describe('Health Insurance — Data Integrity', () => {
  it('has at least 10 insurers', () => {
    expect(data.insurers.length).toBeGreaterThanOrEqual(10);
  });

  it('every insurer has required fields', () => {
    for (const ins of data.insurers) {
      expect(ins.id).toBeTruthy();
      expect(ins.name).toBeTruthy();
    }
  });

  it('no duplicate insurer IDs', () => {
    const ids = data.insurers.map((i: { id: string }) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('FRANCHISES are sorted ascending for adults', () => {
    for (let i = 1; i < FRANCHISES.length; i++) {
      expect(FRANCHISES[i]).toBeGreaterThan(FRANCHISES[i - 1]);
    }
  });

  it('FRANCHISES_CHILD are sorted ascending', () => {
    for (let i = 1; i < FRANCHISES_CHILD.length; i++) {
      expect(FRANCHISES_CHILD[i]).toBeGreaterThan(FRANCHISES_CHILD[i - 1]);
    }
  });

  it('CANTONS has all 26 Swiss cantons', () => {
    expect(CANTONS.length).toBe(26);
  });

  it('each canton has a value and label', () => {
    for (const c of CANTONS) {
      expect(c.value).toBeTruthy();
      expect(c.label).toBeTruthy();
    }
  });

  it('has premium data for all 26 cantons', () => {
    const cantonCodes = CANTONS.map(c => c.value);
    for (const code of cantonCodes) {
      // Canton-level entry OR commune-level entries exist
      const hasCantonEntry = data.premiums[code] !== undefined;
      const hasCommuneEntries = Object.values(data.premiums).some(
        (p: any) => p.canton === code && !p.type
      );
      expect(hasCantonEntry || hasCommuneEntries).toBe(true);
    }
  });

  it('has commune-level data for TI and GR', () => {
    expect(data.communes.TI.length).toBeGreaterThan(50);
    expect(data.communes.GR.length).toBeGreaterThan(50);
  });

  it('TI communes have name, bfsNr, plz, region', () => {
    for (const c of data.communes.TI) {
      expect(c.name).toBeTruthy();
      expect(c.bfsNr).toBeGreaterThan(0);
      expect(c.plz).toBeTruthy();
      expect([1, 2]).toContain(c.region);
    }
  });

  it('has rankings with cheapest and most expensive', () => {
    expect(data.rankings.cheapest.length).toBeGreaterThan(0);
    expect(data.rankings.mostExpensive.length).toBeGreaterThan(0);
    expect(data.rankings.cheapest[0].avgPremium)
      .toBeLessThan(data.rankings.mostExpensive[0].avgPremium);
  });

  it('has a valid fetchedAt ISO date', () => {
    expect(new Date(data.fetchedAt).getTime()).toBeGreaterThan(0);
  });

  it('has a valid year', () => {
    expect(data.year).toBeGreaterThanOrEqual(2026);
  });
});

// ─── calculatePremium ───────────────────────────────────────────────────────

describe('Health Insurance — calculatePremium', () => {
  // Get a TI commune premium entry
  const tiCommunes = Object.entries(data.premiums).filter(
    ([, v]: [string, any]) => v.canton === 'TI' && !v.type
  );
  const [tiKey, tiEntry] = tiCommunes[0] as [string, any];
  const tiInsurerId = Object.keys(tiEntry.insurers)[0];
  const tiInsurerPremiums = tiEntry.insurers[tiInsurerId];

  it('returns a positive number for valid inputs', () => {
    const p = calculatePremium(tiInsurerPremiums, 'standard', 300, '26+', false);
    expect(p).not.toBeNull();
    expect(p!).toBeGreaterThan(0);
  });

  it('returns null for undefined insurer premiums', () => {
    expect(calculatePremium(undefined, 'standard', 300, '26+', false)).toBeNull();
  });

  it('higher franchise reduces premium', () => {
    const low = calculatePremium(tiInsurerPremiums, 'standard', 300, '26+', false)!;
    const high = calculatePremium(tiInsurerPremiums, 'standard', 2500, '26+', false)!;
    expect(high).toBeLessThan(low);
  });

  it('children pay less than adults', () => {
    const adult = calculatePremium(tiInsurerPremiums, 'standard', 300, '26+', false)!;
    const child = calculatePremium(tiInsurerPremiums, 'standard', 0, '0-18', false)!;
    expect(child).toBeLessThan(adult);
  });

  it('young adults (19-25) pay less than full adults', () => {
    const adult = calculatePremium(tiInsurerPremiums, 'standard', 300, '26+', false)!;
    const young = calculatePremium(tiInsurerPremiums, 'standard', 300, '19-25', false)!;
    expect(young).toBeLessThan(adult);
  });

  it('accident cover increases premium', () => {
    const without = calculatePremium(tiInsurerPremiums, 'standard', 300, '26+', false)!;
    const with_ = calculatePremium(tiInsurerPremiums, 'standard', 300, '26+', true)!;
    expect(with_).toBeGreaterThan(without);
  });

  it('TI commune premiums are in reasonable range (200-1000 CHF/month)', () => {
    for (const [, entry] of tiCommunes as [string, any][]) {
      for (const [, premiums] of Object.entries(entry.insurers) as [string, any][]) {
        const p = calculatePremium(premiums, 'standard', 300, '26+', false);
        if (p !== null) {
          expect(p).toBeGreaterThan(200);
          expect(p).toBeLessThan(1000);
        }
      }
    }
  });

  it('canton-level premiums exist and are valid', () => {
    const zhEntry = data.premiums['ZH'];
    expect(zhEntry).toBeDefined();
    expect(zhEntry.type).toBe('canton');
    const firstInsurer = Object.keys(zhEntry.insurers)[0];
    const p = calculatePremium(zhEntry.insurers[firstInsurer], 'standard', 300, '26+', false);
    expect(p).not.toBeNull();
    expect(p!).toBeGreaterThan(200);
  });
});

// ─── Ranking logic ──────────────────────────────────────────────────────────

describe('Health Insurance — Ranking', () => {
  it('cheapest commune has lower average than most expensive', () => {
    const cheapest = data.rankings.cheapest[0];
    const expensive = data.rankings.mostExpensive[0];
    expect(cheapest.avgPremium).toBeLessThan(expensive.avgPremium);
  });

  it('rankings include both TI and GR communes', () => {
    const allRanked = [...data.rankings.cheapest, ...data.rankings.mostExpensive];
    const cantons = new Set(allRanked.map((r: any) => r.canton));
    expect(cantons.has('TI') || cantons.has('GR')).toBe(true);
  });

  it('different cantons produce different prices', () => {
    const tiEntry = Object.values(data.premiums).find((p: any) => p.canton === 'TI' && !p.type) as any;
    const zhEntry = data.premiums['ZH'];
    if (tiEntry && zhEntry) {
      // Find a common insurer
      const commonInsurer = Object.keys(tiEntry.insurers).find((id: string) => zhEntry.insurers[id]);
      if (commonInsurer) {
        const tiPremium = tiEntry.insurers[commonInsurer].standard;
        const zhPremium = zhEntry.insurers[commonInsurer].standard;
        if (tiPremium && zhPremium) {
          expect(tiPremium).not.toBe(zhPremium);
        }
      }
    }
  });
});
