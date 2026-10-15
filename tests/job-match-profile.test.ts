/**
 * Tests for jobMatchProfile.ts — localStorage store for survey-derived
 * job-match signals (sector/experience level/canton from SalarySurvey).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadJobMatchProfile, saveJobMatchProfile, mergeNewsletterSignals } from '@/services/jobMatchProfile';

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
    // Simulate storage unavailability (Safari private mode, quota exceeded,
    // etc.): isStorageAvailable() probes via setItem, so making it throw is
    // the actually-observable failure mode rather than deleting the global.
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('storage unavailable');
    });
    expect(() => saveJobMatchProfile({ sector: 'it_software' })).not.toThrow();
    expect(() => loadJobMatchProfile()).not.toThrow();
    setItemSpy.mockRestore();
  });
});

describe('mergeNewsletterSignals', () => {
  it('returns base unchanged when there is no newsletter doc', () => {
    const base = { version: 1 as const, sector: 'it_software', experienceLevel: null, canton: 'TI', updatedAt: 1 };
    expect(mergeNewsletterSignals(base, null)).toBe(base);
  });

  it('returns null when base is null and the newsletter doc has no usable signal', () => {
    expect(mergeNewsletterSignals(null, { sector_interest: null, location_interest: null })).toBeNull();
  });

  it('builds a fresh profile from newsletter signals when there is no SalarySurvey profile yet', () => {
    const merged = mergeNewsletterSignals(null, { sector_interest: 'health', location_interest: 'Lugano' });
    expect(merged?.sector).toBe('health');
    expect(merged?.canton).toBe('Lugano');
    expect(merged?.experienceLevel).toBeNull();
    expect(merged?.version).toBe(1);
  });

  it('falls back to job_category/geo_city when sector_interest/location_interest are absent', () => {
    const merged = mergeNewsletterSignals(null, { job_category: 'tech', geo_city: 'Bellinzona' });
    expect(merged?.sector).toBe('tech');
    expect(merged?.canton).toBe('Bellinzona');
  });

  it('fills only the missing fields, never overwriting an explicit SalarySurvey answer', () => {
    const base = { version: 1 as const, sector: 'it_software', experienceLevel: 'senior_6_10', canton: null, updatedAt: 1 };
    const merged = mergeNewsletterSignals(base, { sector_interest: 'health', location_interest: 'Lugano' });
    expect(merged?.sector).toBe('it_software'); // SalarySurvey wins, not overwritten
    expect(merged?.experienceLevel).toBe('senior_6_10'); // untouched — newsletter carries no experience signal
    expect(merged?.canton).toBe('Lugano'); // gap filled from newsletter
  });

  it('is a no-op once both sector and canton are already set', () => {
    const base = { version: 1 as const, sector: 'it_software', experienceLevel: null, canton: 'TI', updatedAt: 1 };
    expect(mergeNewsletterSignals(base, { sector_interest: 'health', location_interest: 'Bellinzona' })).toBe(base);
  });
});
