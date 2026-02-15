import { describe, it, expect } from 'vitest';
import {
  INSURERS,
  calculatePremium,
  FRANCHISES,
  FRANCHISES_CHILD,
  MODEL_DISCOUNT,
  FRANCHISE_ADJUSTMENT,
  CANTONS,
} from '@/components/HealthInsurance';

// ─── Data integrity ─────────────────────────────────────────────────────────

describe('Health Insurance — Data Integrity', () => {
  it('has at least 10 insurers', () => {
    expect(INSURERS.length).toBeGreaterThanOrEqual(10);
  });

  it('every insurer has required fields', () => {
    for (const ins of INSURERS) {
      expect(ins.id).toBeTruthy();
      expect(ins.name).toBeTruthy();
      expect(ins.website).toMatch(/^https?:\/\//);
      expect(ins.rating).toBeGreaterThanOrEqual(1);
      expect(ins.rating).toBeLessThanOrEqual(5);
      expect(ins.models.length).toBeGreaterThanOrEqual(1);
      expect(ins.models).toContain('standard');
    }
  });

  it('no duplicate insurer IDs', () => {
    const ids = INSURERS.map(i => i.id);
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

  it('CANTONS has at least 5 entries', () => {
    expect(CANTONS.length).toBeGreaterThanOrEqual(5);
  });

  it('each canton has a value and label', () => {
    for (const c of CANTONS) {
      expect(c.value).toBeTruthy();
      expect(c.label).toBeTruthy();
    }
  });

  it('MODEL_DISCOUNT has no negative values', () => {
    for (const [, disc] of Object.entries(MODEL_DISCOUNT)) {
      expect(disc).toBeGreaterThanOrEqual(0);
      expect(disc).toBeLessThan(1);
    }
  });

  it('standard model has 0 discount', () => {
    expect(MODEL_DISCOUNT.standard).toBe(0);
  });
});

// ─── calculatePremium ───────────────────────────────────────────────────────

describe('Health Insurance — calculatePremium', () => {
  it('returns a positive number for valid inputs', () => {
    const p = calculatePremium('assura', 'TI', 'standard', 300, '26+', false);
    expect(p).not.toBeNull();
    expect(p!).toBeGreaterThan(0);
  });

  it('returns null for unknown insurer', () => {
    expect(calculatePremium('fake_insurer', 'TI', 'standard', 300, '26+', false)).toBeNull();
  });

  it('returns null for unknown canton', () => {
    expect(calculatePremium('assura', 'XX', 'standard', 300, '26+', false)).toBeNull();
  });

  it('returns null when insurer does not offer the model', () => {
    // Aquilana only offers standard and hausarzt
    expect(calculatePremium('aquilana', 'TI', 'hmo', 300, '26+', false)).toBeNull();
  });

  it('HMO discount produces lower premium than standard', () => {
    const std = calculatePremium('css', 'TI', 'standard', 300, '26+', false)!;
    const hmo = calculatePremium('css', 'TI', 'hmo', 300, '26+', false)!;
    expect(hmo).toBeLessThan(std);
  });

  it('higher franchise reduces premium', () => {
    const low = calculatePremium('assura', 'TI', 'standard', 300, '26+', false)!;
    const high = calculatePremium('assura', 'TI', 'standard', 2500, '26+', false)!;
    expect(high).toBeLessThan(low);
  });

  it('children pay less than adults', () => {
    const adult = calculatePremium('css', 'TI', 'standard', 300, '26+', false)!;
    const child = calculatePremium('css', 'TI', 'standard', 0, '0-18', false)!;
    expect(child).toBeLessThan(adult);
  });

  it('young adults (19-25) pay less than full adults', () => {
    const adult = calculatePremium('css', 'TI', 'standard', 300, '26+', false)!;
    const young = calculatePremium('css', 'TI', 'standard', 300, '19-25', false)!;
    expect(young).toBeLessThan(adult);
  });

  it('accident cover increases premium', () => {
    const without = calculatePremium('css', 'TI', 'standard', 300, '26+', false)!;
    const with_ = calculatePremium('css', 'TI', 'standard', 300, '26+', true)!;
    expect(with_).toBeGreaterThan(without);
  });

  it('calculates for every insurer/canton combination', () => {
    let nullCount = 0;
    let validCount = 0;
    for (const ins of INSURERS) {
      for (const canton of CANTONS) {
        const p = calculatePremium(ins.id, canton.value, 'standard', 300, '26+', false);
        if (p !== null) validCount++;
        else nullCount++;
      }
    }
    expect(validCount).toBeGreaterThan(0);
    // All insurers should have base premiums for all cantons
    expect(nullCount).toBe(0);
  });

  it('premiums are in a reasonable range (50-1000 CHF/month)', () => {
    for (const ins of INSURERS) {
      for (const canton of CANTONS) {
        const p = calculatePremium(ins.id, canton.value, 'standard', 300, '26+', false);
        if (p !== null) {
          expect(p).toBeGreaterThan(50);
          expect(p).toBeLessThan(1000);
        }
      }
    }
  });
});

// ─── Ranking logic ──────────────────────────────────────────────────────────

describe('Health Insurance — Ranking', () => {
  it('sorted results put cheapest first', () => {
    const premiums: { name: string; premium: number }[] = [];
    for (const ins of INSURERS) {
      const p = calculatePremium(ins.id, 'TI', 'standard', 300, '26+', false);
      if (p !== null) premiums.push({ name: ins.name, premium: p });
    }
    premiums.sort((a, b) => a.premium - b.premium);
    expect(premiums.length).toBeGreaterThan(0);
    expect(premiums[0].premium).toBeLessThanOrEqual(premiums[premiums.length - 1].premium);
  });

  it('different cantons produce different prices for the same insurer', () => {
    const ti = calculatePremium('assura', 'TI', 'standard', 300, '26+', false)!;
    const zh = calculatePremium('assura', 'ZH', 'standard', 300, '26+', false)!;
    expect(ti).not.toBe(zh);
  });
});
