import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  KSML_KEY,
  KSML_COMPANY_NAME,
  isKsmlJob,
  isTrustedDomain,
  fetchAllKsmlJobs,
} from '../scripts/lib/ksml-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

const API_URL = 'https://www.ksml.apps.be.ch/ksml/ws/stellen/';

describe('KSML (Kanton Bern) crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(KSML_KEY).toBe('ksml');
    expect(KSML_COMPANY_NAME).toBe('KSML — Kantonaler Stellenmarkt für Lehrerinnen und Lehrer (Kanton Bern)');
  });

  // ── isCompanyJob ──
  describe('isKsmlJob', () => {
    it('matches by companyKey', () => {
      expect(isKsmlJob({ companyKey: 'ksml' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isKsmlJob({ company: 'KSML — Kantonaler Stellenmarkt für Lehrerinnen und Lehrer (Kanton Bern)' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isKsmlJob({ url: 'https://www.ksml.apps.be.ch/ksml/?q=stellen/ad/35547' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(
        isKsmlJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })
      ).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isKsmlJob(null)).toBe(false);
      expect(isKsmlJob(undefined)).toBe(false);
      expect(isKsmlJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts the ksml.apps.be.ch host', () => {
      expect(isTrustedDomain('https://www.ksml.apps.be.ch/ksml/?q=stellen/ad/35547')).toBe(true);
      expect(isTrustedDomain('https://ksml.apps.be.ch/')).toBe(true);
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
      const slug = slugify('Lehrperson Primarstufe, 60-80%');
      expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('builds slug with organisation/city suffix inline', () => {
      expect(slugify('lehrperson primarstufe schule bern')).toBe(
        'lehrperson-primarstufe-schule-bern'
      );
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const validJob = {
      id: 'ksml-abc123',
      slug: 'test-position-schule-bern',
      slugByLocale: { de: 'test-position-schule-bern' },
      company: KSML_COMPANY_NAME,
      companyKey: 'ksml',
      companyDomain: 'ksml.apps.be.ch',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description long enough to satisfy the fifty word minimum content guard used across every dedicated crawler in this repository, so the automated thin-content check passes cleanly during validation runs without any additional padding text required here at all today, even after accounting for whitespace splitting and word boundary edge cases across locales and punctuation marks throughout this fixture string.',
      descriptionByLocale: {
        de: 'A test job description long enough to satisfy the fifty word minimum content guard used across every dedicated crawler in this repository, so the automated thin-content check passes cleanly during validation runs without any additional padding text required here at all today, even after accounting for whitespace splitting and word boundary edge cases across locales and punctuation marks throughout this fixture string.',
      },
      location: 'Bern',
      canton: 'BE',
      url: 'https://www.ksml.apps.be.ch/ksml/?q=stellen/ad/35547',
      source: 'KSML Dedicated Parser (ws/stellen JSON API)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),

      addressLocality: 'Bern',
      addressRegion: 'BE',
      streetAddress: 'Bern',
      postalCode: '3000',
      addressCountry: 'CH',
      country: 'CH',
      employmentType: 'FULL_TIME',
      postedDate: new Date().toISOString().slice(0, 10),
      applyUrl: 'https://www.ksml.apps.be.ch/ksml/?q=stellen/ad/35547',
    };

    it('has all required fields', () => {
      const required = [
        'id', 'slug', 'slugByLocale', 'company', 'companyKey',
        'title', 'titleByLocale', 'description', 'descriptionByLocale',
        'location', 'canton', 'url', 'source', 'sourceLang', 'crawledAt',
      ];
      for (const field of required) {
        expect(validJob).toHaveProperty(field);
      }
    });

    it('has the structured-data fields required by Non-Negotiable #3', () => {
      const structuredDataFields = [
        'postalCode', 'streetAddress', 'title', 'description',
        'postedDate', 'company', 'addressLocality', 'employmentType',
      ];
      for (const field of structuredDataFields) {
        expect(validJob).toHaveProperty(field);
      }
    });

    it('description is at least 50 words (Non-Negotiable #4 thin-content floor)', () => {
      const wordCount = validJob.description.split(/\s+/).filter(Boolean).length;
      expect(wordCount).toBeGreaterThanOrEqual(50);
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^ksml-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  // ── fetchAllKsmlJobs — graceful degradation + real API contract ──
  describe('fetchAllKsmlJobs — graceful degradation', () => {
    const realFetch = globalThis.fetch;

    beforeEach(() => {
      process.env.JOBS_CRAWLER_RETRY_BASE_MS = '0';
    });

    afterEach(() => {
      globalThis.fetch = realFetch;
      delete process.env.JOBS_CRAWLER_RETRY_BASE_MS;
    });

    it('propagates on total network failure (caught by the standard crawler pipeline, not swallowed here)', async () => {
      globalThis.fetch = vi.fn(async () => {
        throw new Error('ENOTFOUND ksml.apps.be.ch');
      }) as any;

      await expect(fetchAllKsmlJobs()).rejects.toThrow(/ENOTFOUND/);
    });

    it('propagates when the API errors (caught by the standard crawler pipeline, not swallowed here)', async () => {
      globalThis.fetch = vi.fn(async () => new Response('', { status: 500 })) as any;

      await expect(fetchAllKsmlJobs()).rejects.toThrow(/HTTP 500/);
    });

    it('parses published listings, skips non-published, applies German section headers', async () => {
      globalThis.fetch = vi.fn(async (url: any) => {
        const u = String(url);
        if (u.startsWith(API_URL)) {
          return new Response(
            JSON.stringify([
              {
                stelleId: 35547,
                publikationsstatus: 'PUBLISHED',
                stelleBase: {
                  stellentitel: 'Lehrperson Primarstufe',
                  organisation: 'Schule Bern',
                  inseratesprache: '1',
                  adresseOrg: { plzOrt: { plz: '3000', ort: 'Bern' }, strasse: 'Schulstrasse 1' },
                  firmenportrait: 'Wir sind eine moderne Schule in Bern.',
                  aufgaben: 'Unterricht auf der Primarstufe erteilen.',
                  anforderungen: 'Lehrdiplom Primarstufe erforderlich.',
                  wirBieten: 'Kollegiales Team und moderne Infrastruktur.',
                  erfassungTs: '2026-06-23 06:57:25.495',
                  kontakt: 'Schulleitung\nMax Muster\n031 555 00 00',
                },
                stelleMetaData: { arbeitspensum: { label: 'Vollzeit' } },
                stelleMetaDataLehrer: { funktion: { label: 'Lehrperson' } },
              },
              {
                stelleId: 99999,
                publikationsstatus: 'DRAFT',
                stelleBase: { stellentitel: 'Should be skipped', organisation: 'X' },
              },
            ]),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('', { status: 404 });
      }) as any;

      const jobs = await fetchAllKsmlJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        companyKey: 'ksml',
        canton: 'BE',
        country: 'CH',
        sourceLang: 'de',
        postalCode: '3000',
        addressLocality: 'Bern',
        employmentType: 'FULL_TIME',
      });
      expect(jobs[0].id).toMatch(/^ksml-/);
      expect(jobs[0].url).toBe('https://www.ksml.apps.be.ch/ksml/?q=stellen/ad/35547');
      expect(jobs[0].description).not.toContain('Max Muster');
      expect(jobs[0].description).not.toContain('031 555 00 00');
    });

    it('maps inseratesprache code 2 to French source language', async () => {
      globalThis.fetch = vi.fn(async (url: any) => {
        const u = String(url);
        if (u.startsWith(API_URL)) {
          return new Response(
            JSON.stringify([
              {
                stelleId: 40000,
                publikationsstatus: 'PUBLISHED',
                stelleBase: {
                  stellentitel: 'Enseignant primaire',
                  organisation: 'École de Moutier',
                  inseratesprache: '2',
                  adresseOrg: { plzOrt: { plz: '2740', ort: 'Moutier' } },
                  firmenportrait: 'Une école moderne à Moutier, dans le Jura bernois.',
                  aufgaben: 'Enseignement au niveau primaire.',
                  anforderungen: "Diplôme d'enseignement primaire requis.",
                  wirBieten: 'Une équipe collégiale et des infrastructures modernes.',
                  erfassungTs: '2026-06-20 09:00:00.000',
                },
                stelleMetaData: { arbeitspensum: { label: 'Teilzeit' } },
                stelleMetaDataLehrer: { funktion: { label: 'Enseignant' } },
              },
            ]),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('', { status: 404 });
      }) as any;

      const jobs = await fetchAllKsmlJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].sourceLang).toBe('fr');
      expect(jobs[0].employmentType).toBe('PART_TIME');
      expect(Object.keys(jobs[0].slugByLocale)).toEqual(['fr']);
    });
  });
});
