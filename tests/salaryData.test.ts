import { describe, it, expect } from 'vitest';
import {
  getJobSalaryContext,
  SECTOR_METADATA,
  SALARY_DATA,
  TOTAL_SECTORS,
  TOTAL_PROFESSIONS,
  getSectorMedian,
  getJobSalaryRange,
  getAllProfessions,
} from '@/data/salaryData';

describe('getJobSalaryContext', () => {
  it('returns valid context for known category "tech"', () => {
    const ctx = getJobSalaryContext('tech');
    expect(ctx).not.toBeNull();
    expect(ctx!.sectorId).toBe('IT');
    expect(ctx!.employeeCount).toBeGreaterThan(0);
    expect(ctx!.frontialieriDiscount).toBeGreaterThanOrEqual(0);
    expect(ctx!.genderGapPercent).toBeGreaterThanOrEqual(0);
    expect(ctx!.nogaCodes).toBeTruthy();
  });

  it('returns valid context for "finance"', () => {
    const ctx = getJobSalaryContext('finance');
    expect(ctx).not.toBeNull();
    expect(ctx!.sectorId).toBe('Finance');
  });

  it('returns valid context for "healthcare"', () => {
    const ctx = getJobSalaryContext('healthcare');
    expect(ctx).not.toBeNull();
    expect(ctx!.sectorId).toBe('Healthcare');
  });

  it('is case-insensitive', () => {
    const ctx1 = getJobSalaryContext('TECH');
    const ctx2 = getJobSalaryContext('Tech');
    const ctx3 = getJobSalaryContext('tech');
    expect(ctx1).toEqual(ctx2);
    expect(ctx2).toEqual(ctx3);
  });

  it('falls back to Logistics for unknown categories', () => {
    const ctx = getJobSalaryContext('unknown-category');
    expect(ctx).not.toBeNull();
    expect(ctx!.sectorId).toBe('Logistics');
  });

  it('falls back to Logistics for empty string', () => {
    const ctx = getJobSalaryContext('');
    expect(ctx).not.toBeNull();
    expect(ctx!.sectorId).toBe('Logistics');
  });

  it('handles null/undefined gracefully', () => {
    const ctx = getJobSalaryContext(null as unknown as string);
    expect(ctx).not.toBeNull();
    expect(ctx!.sectorId).toBe('Logistics');
  });

  it('computes frontialieriDiscount correctly from metadata ratio', () => {
    const ctx = getJobSalaryContext('tech');
    const meta = SECTOR_METADATA['IT'];
    const expected = Math.round((1 - meta.frontialieriRatio) * 100);
    expect(ctx!.frontialieriDiscount).toBe(expected);
  });

  it('returns cclMinimumAnnual from metadata', () => {
    const ctx = getJobSalaryContext('construction');
    expect(ctx).not.toBeNull();
    expect(ctx!.sectorId).toBe('Construction');
    expect(ctx!.cclMinimumAnnual).toBeGreaterThan(0);
  });

  it('maps "dispositivi medici" to Pharma', () => {
    const ctx = getJobSalaryContext('dispositivi medici');
    expect(ctx).not.toBeNull();
    expect(ctx!.sectorId).toBe('Pharma');
  });

  it('maps "telecom" to IT', () => {
    const ctx = getJobSalaryContext('telecom');
    expect(ctx).not.toBeNull();
    expect(ctx!.sectorId).toBe('IT');
  });

  it('maps "beauty" to PersonalServices', () => {
    const ctx = getJobSalaryContext('beauty');
    expect(ctx).not.toBeNull();
    expect(ctx!.sectorId).toBe('PersonalServices');
  });

  it('all mapped sectors have valid SECTOR_METADATA entries', () => {
    const categories = [
      'tech', 'finance', 'pharma', 'engineering', 'health', 'healthcare',
      'admin', 'sales', 'hr', 'legal', 'logistics', 'hospitality',
      'construction', 'education', 'retail', 'other', 'marketing',
      'consulting', 'insurance', 'telecom', 'production', 'it',
      'energy', 'food', 'manufacturing', 'real estate', 'personal services',
    ];
    for (const cat of categories) {
      const ctx = getJobSalaryContext(cat);
      expect(ctx, `category "${cat}" should return context`).not.toBeNull();
      expect(ctx!.employeeCount, `category "${cat}" employeeCount`).toBeGreaterThan(0);
    }
  });
});

describe('SALARY_DATA integrity', () => {
  it('has the expected number of sectors', () => {
    expect(SALARY_DATA.length).toBe(TOTAL_SECTORS);
    expect(TOTAL_SECTORS).toBeGreaterThanOrEqual(20);
  });

  it('has the expected number of professions', () => {
    expect(TOTAL_PROFESSIONS).toBeGreaterThanOrEqual(90);
  });

  it('all sectors have at least 1 profession', () => {
    for (const sector of SALARY_DATA) {
      expect(sector.professions.length, `sector ${sector.id}`).toBeGreaterThanOrEqual(1);
    }
  });

  it('all salary tuples are [min, median, max] in ascending order', () => {
    for (const sector of SALARY_DATA) {
      for (const prof of sector.professions) {
        for (const country of ['ch', 'it'] as const) {
          for (const level of ['junior', 'mid', 'senior'] as const) {
            const [min, med, max] = prof[country][level];
            expect(min, `${sector.id}/${prof.id}/${country}/${level} min`).toBeLessThanOrEqual(med);
            expect(med, `${sector.id}/${prof.id}/${country}/${level} med`).toBeLessThanOrEqual(max);
            expect(min, `${sector.id}/${prof.id}/${country}/${level} min>0`).toBeGreaterThan(0);
          }
        }
      }
    }
  });
});

describe('SECTOR_METADATA integrity', () => {
  it('every SALARY_DATA sector has metadata', () => {
    for (const sector of SALARY_DATA) {
      expect(SECTOR_METADATA[sector.id], `metadata for ${sector.id}`).toBeDefined();
    }
  });

  it('metadata fields are valid numbers', () => {
    for (const [id, meta] of Object.entries(SECTOR_METADATA)) {
      expect(meta.employeeCount, `${id} employeeCount`).toBeGreaterThan(0);
      expect(meta.frontialieriRatio, `${id} frontialieriRatio`).toBeGreaterThan(0);
      expect(meta.frontialieriRatio, `${id} frontialieriRatio`).toBeLessThanOrEqual(1.1);
      expect(meta.genderGapPercent, `${id} genderGapPercent`).toBeGreaterThanOrEqual(-10);
      expect(meta.educationPremiumRatio, `${id} educationPremiumRatio`).toBeGreaterThanOrEqual(1);
      expect(meta.nogaCodes, `${id} nogaCodes`).toBeTruthy();
    }
  });
});

describe('getSectorMedian', () => {
  it('returns the median value for a given level and country', () => {
    const itSector = SALARY_DATA.find(s => s.id === 'IT')!;
    const med = getSectorMedian(itSector, 'mid', 'ch');
    expect(med).toBeGreaterThan(0);
  });
});

describe('getJobSalaryRange', () => {
  it('returns {min, median, max, currency} for a valid profession', () => {
    const range = getJobSalaryRange('IT', 'softwareDev', 'mid');
    expect(range).not.toBeNull();
    expect(range!.min).toBeLessThanOrEqual(range!.median);
    expect(range!.median).toBeLessThanOrEqual(range!.max);
    expect(range!.currency).toBe('CHF');
  });

  it('returns null for unknown profession', () => {
    const range = getJobSalaryRange('IT', 'nonExistent', 'mid');
    expect(range).toBeNull();
  });

  it('returns null for unknown sector', () => {
    const range = getJobSalaryRange('FakeSector', 'softwareDev', 'mid');
    expect(range).toBeNull();
  });
});

describe('getAllProfessions', () => {
  it('returns all professions with sectorId attached', () => {
    const all = getAllProfessions();
    expect(all.length).toBe(TOTAL_PROFESSIONS);
    for (const prof of all) {
      expect(prof.sectorId).toBeTruthy();
      expect(prof.id).toBeTruthy();
    }
  });
});
