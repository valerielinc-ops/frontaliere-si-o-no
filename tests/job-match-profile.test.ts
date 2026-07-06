/**
 * Tests for jobMatchProfile.ts — localStorage store for survey-derived
 * job-match signals (sector/experience level/canton from SalarySurvey).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { loadJobMatchProfile, saveJobMatchProfile } from '@/services/jobMatchProfile';

beforeEach(() => {
  localStorage.clear();
});

describe('loadJobMatchProfile', () => {
  it('returns null when nothing has been saved', () => {
    expect(loadJobMatchProfile()).toBeNull();
  });

  it('recovers from corrupt JSON', () => {
    localStorage.setItem('frontaliere_job_match_profile', '{invalid json');
    expect(loadJobMatchProfile()).toBeNull();
  });

  it('resets when version mismatches', () => {
    localStorage.setItem('frontaliere_job_match_profile', JSON.stringify({ version: 99, sector: 'it_software' }));
    expect(loadJobMatchProfile()).toBeNull();
  });
});

describe('saveJobMatchProfile', () => {
  it('persists sector, experienceLevel and canton', () => {
    saveJobMatchProfile({ sector: 'it_software', experienceLevel: 'senior_6_10', canton: 'TI' });
    const profile = loadJobMatchProfile();
    expect(profile?.sector).toBe('it_software');
    expect(profile?.experienceLevel).toBe('senior_6_10');
    expect(profile?.canton).toBe('TI');
    expect(profile?.version).toBe(1);
    expect(typeof profile?.updatedAt).toBe('number');
  });

  it('partial-merges into an existing profile instead of overwriting it', () => {
    saveJobMatchProfile({ sector: 'it_software', experienceLevel: 'senior_6_10', canton: 'TI' });
    saveJobMatchProfile({ canton: 'ZH' });
    const profile = loadJobMatchProfile();
    expect(profile?.sector).toBe('it_software');
    expect(profile?.experienceLevel).toBe('senior_6_10');
    expect(profile?.canton).toBe('ZH');
  });

  it('does not throw when localStorage is unavailable', () => {
    const original = globalThis.localStorage;
    // @ts-expect-error simulate storage unavailability (Safari private mode, etc.)
    delete globalThis.localStorage;
    expect(() => saveJobMatchProfile({ sector: 'it_software' })).not.toThrow();
    expect(() => loadJobMatchProfile()).not.toThrow();
    Object.defineProperty(globalThis, 'localStorage', { value: original, configurable: true });
  });
});
