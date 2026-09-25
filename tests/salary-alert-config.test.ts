/**
 * Salary alert config from the calculator (issue #4469).
 *
 * The one-tap salary alert must carry the criteria prefilled from the
 * simulation — profession keyword, region canton, and the desired minimum
 * monthly net — normalised so Firestore never stores a junk expectation.
 */
import { describe, it, expect } from 'vitest';
import {
  buildSalaryAlertConfig,
  normalizeMinNet,
} from '@/services/jobAlertService';

describe('normalizeMinNet', () => {
  it('rounds a positive number to a whole CHF', () => {
    expect(normalizeMinNet(4325.7)).toBe(4326);
  });

  it('collapses 0 / negative / NaN / null to null', () => {
    expect(normalizeMinNet(0)).toBeNull();
    expect(normalizeMinNet(-100)).toBeNull();
    expect(normalizeMinNet(Number.NaN)).toBeNull();
    expect(normalizeMinNet(null)).toBeNull();
    expect(normalizeMinNet(undefined)).toBeNull();
  });
});

describe('buildSalaryAlertConfig', () => {
  it('prefills canton geo-scope and salary expectation', () => {
    const cfg = buildSalaryAlertConfig({
      cantonCode: 'TI',
      minNetMonthlyCHF: 4300,
      locale: 'it',
    });
    expect(cfg.cantonFilter).toEqual(['TI']);
    expect(cfg.minNetMonthlyCHF).toBe(4300);
    expect(cfg.frequency).toBe('weekly');
    expect(cfg.locale).toBe('it');
    // Engine-managed cadence (no manual pin), like the other one-tap presets.
    expect(cfg.frequencyOverride).toBeUndefined();
  });

  it('sets a profession keyword when provided (emoji stripped)', () => {
    const cfg = buildSalaryAlertConfig({
      profession: '💻 Ingegnere',
      cantonCode: 'TI',
      minNetMonthlyCHF: 5000,
      locale: 'en',
    });
    expect(cfg.keywords).toEqual(['Ingegnere']);
  });

  it('leaves keywords empty when no profession is known', () => {
    const cfg = buildSalaryAlertConfig({ cantonCode: 'TI', minNetMonthlyCHF: 4000, locale: 'de' });
    expect(cfg.keywords).toEqual([]);
  });

  it('uppercases the canton code and drops a blank one', () => {
    expect(buildSalaryAlertConfig({ cantonCode: 'ti', minNetMonthlyCHF: 1, locale: 'fr' }).cantonFilter).toEqual(['TI']);
    expect(buildSalaryAlertConfig({ cantonCode: '', minNetMonthlyCHF: 1, locale: 'fr' }).cantonFilter).toBeNull();
  });

  it('normalises a junk salary expectation to null', () => {
    expect(
      buildSalaryAlertConfig({ cantonCode: 'TI', minNetMonthlyCHF: 0, locale: 'it' }).minNetMonthlyCHF,
    ).toBeNull();
  });
});
