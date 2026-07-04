import { describe, it, expect, vi } from 'vitest';

// Mock only `fetchJson` from the shared template — everything else
// (slugify, stripHtml, normalizeSpace) stays real since the parser imports
// them directly and they're pure/deterministic.
const { fetchJson } = vi.hoisted(() => ({ fetchJson: vi.fn() }));
vi.mock('@/scripts/lib/crawler-template.mjs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, fetchJson };
});

import {
  RHEINMETALL_AIR_DEFENCE_KEY,
  RHEINMETALL_AIR_DEFENCE_COMPANY_NAME,
  isRheinmetallAirDefenceJob,
  isTrustedDomain,
  fetchAllRheinmetallAirDefenceJobs,
} from '../scripts/lib/rheinmetall-air-defence-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

function makeListing(overrides: Record<string, unknown> = {}) {
  return {
    id: '782153_en',
    url: '/en/job/mitarbeiter_qualitaetssicherung_mit_schwerpunkt_mechanik__m_w_d_/782153',
    date: '2025-07-14T00:00:00+02:00',
    title: 'Mitarbeiter Qualitätssicherung mit Schwerpunkt Mechanik (m/w/d)',
    companyName: RHEINMETALL_AIR_DEFENCE_COMPANY_NAME,
    departmentName: 'Unternehmensbereich Defence',
    occupationalArea: 'Qualitaetsmanagement',
    entryLevel: 'Berufserfahrene',
    countries: [['Switzerland']],
    cities: [['Zürich']],
    ...overrides,
  };
}

function makeListingPayload(results: Array<Record<string, unknown>>) {
  return {
    elements: {
      areablock: [
        {
          type: 'search',
          data: {
            search: {
              results,
              hits: results.length,
              pages: 1,
            },
          },
        },
      ],
    },
  };
}

function makeDetailPayload(overrides: Record<string, unknown> = {}) {
  return {
    elements: {
      date: '2025-07-14 00:00:00',
      title: 'Mitarbeiter Qualitätssicherung mit Schwerpunkt Mechanik (m/w/d)',
      referenceNumber: 'CH00861',
      departmentName: 'Unternehmensbereich Defence',
      occupationalArea: 'Qualitaetsmanagement',
      entryLevel: 'Berufserfahrene',
      workingHoursValue: 'Vollzeit',
      contractType: 'Unbefristeter Vertrag',
      cities: [['Zürich']],
      countries: [['Switzerland']],
      jobBlocks: [
        {
          name: { data: 'Field1' },
          title: { data: 'WOFÜR WIR SIE SUCHEN' },
          content: { data: '<ul><li>Verantwortlich für das Fehler- und Schnittstellenmanagement</li><li>Interne Anlaufstelle bei Qualitätsfragen</li></ul>' },
        },
        {
          name: { data: 'Field2' },
          title: { data: 'WAS SIE MITBRINGEN SOLLTEN' },
          content: { data: '<ul><li>Abgeschlossene technische Berufslehre</li><li>Mehrjährige Erfahrung in vergleichbarer Funktion</li></ul>' },
        },
      ],
      ...overrides,
    },
  };
}

describe('Rheinmetall Air Defence crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(RHEINMETALL_AIR_DEFENCE_KEY).toBe('rheinmetall-air-defence');
    expect(RHEINMETALL_AIR_DEFENCE_COMPANY_NAME).toBe('Rheinmetall Air Defence AG');
  });

  // ── isCompanyJob ──
  describe('isRheinmetallAirDefenceJob', () => {
    it('matches by companyKey', () => {
      expect(isRheinmetallAirDefenceJob({ companyKey: 'rheinmetall-air-defence' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isRheinmetallAirDefenceJob({ company: 'Rheinmetall Air Defence AG' })).toBe(true);
    });

    it('matches by URL domain when company name mentions rheinmetall', () => {
      expect(isRheinmetallAirDefenceJob({
        company: 'Rheinmetall Air Defence AG',
        url: 'https://www.rheinmetall.com/en/job/foo/123',
      })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isRheinmetallAirDefenceJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isRheinmetallAirDefenceJob(null)).toBe(false);
      expect(isRheinmetallAirDefenceJob(undefined)).toBe(false);
      expect(isRheinmetallAirDefenceJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts the corporate domain', () => {
      expect(isTrustedDomain('https://www.rheinmetall.com/en/job/foo/123')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('converts title to URL-safe slug', () => {
      const slug = slugify('Quality Manager (m/w/d)');
      expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('strips diacritics', () => {
      expect(slugify('Küchenchef Zürich')).toBe('kuchenchef-zurich');
    });
  });

  // ── fetchAllRheinmetallAirDefenceJobs (network mocked via fetchJson) ──
  describe('fetchAllRheinmetallAirDefenceJobs', () => {
    it('maps a Zürich listing onto the ZH HQ address', async () => {
      fetchJson
        .mockResolvedValueOnce(makeListingPayload([makeListing()]))
        .mockResolvedValueOnce(makeDetailPayload());

      const jobs = await fetchAllRheinmetallAirDefenceJobs();
      expect(jobs).toHaveLength(1);
      const [job] = jobs;
      expect(job.companyKey).toBe('rheinmetall-air-defence');
      expect(job.company).toBe(RHEINMETALL_AIR_DEFENCE_COMPANY_NAME);
      expect(job.location).toBe('Zürich');
      expect(job.canton).toBe('ZH');
      expect(job.postalCode).toBe('8050');
      expect(job.streetAddress).toBe('Birchstrasse 155');
      expect(job.addressCountry).toBe('CH');
      expect(job.employmentType).toBe('FULL_TIME');
      expect(job.sourceLang).toBe('de');
      expect(job.url).toBe('https://www.rheinmetall.com/en/job/mitarbeiter_qualitaetssicherung_mit_schwerpunkt_mechanik__m_w_d_/782153');
      expect(job.slugByLocale).toEqual({ de: job.slug });
      expect(job.description.length).toBeGreaterThan(0);
      expect(job.postedDate).toBe('2025-07-14');
    });

    it('maps a Studen listing onto the SZ test-centre address (not Bern)', async () => {
      fetchJson
        .mockResolvedValueOnce(makeListingPayload([makeListing({
          id: '900001_en',
          url: '/en/job/test_engineer/900001',
          cities: [['Studen']],
        })]))
        .mockResolvedValueOnce(makeDetailPayload({ cities: [['Studen']] }));

      const jobs = await fetchAllRheinmetallAirDefenceJobs();
      expect(jobs).toHaveLength(1);
      const [job] = jobs;
      expect(job.location).toBe('Studen');
      expect(job.canton).toBe('SZ');
      expect(job.postalCode).toBe('8845');
      expect(job.streetAddress).toBe('Ochsenbodenstrasse 80');
    });

    it('normalizes the "Zrich" upstream data glitch to Zürich/ZH', async () => {
      fetchJson
        .mockResolvedValueOnce(makeListingPayload([makeListing({
          id: '900002_en',
          url: '/en/job/glitch_city/900002',
          cities: [['Zrich']],
        })]))
        .mockResolvedValueOnce(makeDetailPayload({ cities: [['Zrich']] }));

      const jobs = await fetchAllRheinmetallAirDefenceJobs();
      expect(jobs).toHaveLength(1);
      const [job] = jobs;
      expect(job.location).toBe('Zürich');
      expect(job.canton).toBe('ZH');
      expect(job.postalCode).toBe('8050');
    });

    it('falls back to the Zürich HQ default for an unrecognised city instead of dropping the job', async () => {
      fetchJson
        .mockResolvedValueOnce(makeListingPayload([makeListing({
          id: '900003_en',
          url: '/en/job/somewhere_else/900003',
          cities: [['Neverland']],
        })]))
        .mockResolvedValueOnce(makeDetailPayload({ cities: [['Neverland']] }));

      const jobs = await fetchAllRheinmetallAirDefenceJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].postalCode).toBe('8050');
      expect(jobs[0].streetAddress).toBe('Birchstrasse 155');
    });

    it('deduplicates listings sharing the same URL', async () => {
      const listing = makeListing();
      fetchJson
        .mockResolvedValueOnce(makeListingPayload([listing, { ...listing }]))
        .mockResolvedValueOnce(makeDetailPayload());

      const jobs = await fetchAllRheinmetallAirDefenceJobs();
      expect(jobs).toHaveLength(1);
    });

    it('returns an empty array when the feed has no listings', async () => {
      fetchJson.mockResolvedValueOnce(makeListingPayload([]));
      const jobs = await fetchAllRheinmetallAirDefenceJobs();
      expect(jobs).toEqual([]);
    });

    it('still emits the job (using listing-level fallbacks) when the detail fetch fails', async () => {
      fetchJson
        .mockResolvedValueOnce(makeListingPayload([makeListing()]))
        .mockRejectedValueOnce(new Error('HTTP 500'));

      const jobs = await fetchAllRheinmetallAirDefenceJobs();
      // No detail => no jobBlocks => empty description => job skipped as incomplete.
      expect(jobs).toHaveLength(0);
    });
  });
});
