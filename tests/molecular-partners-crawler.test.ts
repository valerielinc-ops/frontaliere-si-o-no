import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchAllMolecularPartnersJobs,
  isMolecularPartnersEmptyListingPage,
  MOLECULAR_PARTNERS_KEY,
  MOLECULAR_PARTNERS_COMPANY_NAME,
  isMolecularPartnersJob,
  isTrustedDomain,
  LISTING_URL,
} from '../scripts/lib/molecular-partners-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Molecular Partners crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(MOLECULAR_PARTNERS_KEY).toBe('molecular-partners');
    expect(MOLECULAR_PARTNERS_COMPANY_NAME).toBe('Molecular Partners');
    expect(LISTING_URL).toBe('https://molecularpartners-career.talent-soft.com/Pages/Offre/ListeOffre.aspx?lcid=2057');
  });

  describe('empty source proof', () => {
    const emptyListing = `
      <main>
        <h2>No results</h2>
        <p>No vacancies match your search criteria.</p>
      </main>
    `;

    it('accepts the explicit visible Talentsoft empty state', () => {
      expect(isMolecularPartnersEmptyListingPage(emptyListing)).toBe(true);
    });

    it('rejects a near-match empty message', () => {
      expect(isMolecularPartnersEmptyListingPage(
        '<main><h2>No results</h2><p>No vacancies are listed.</p></main>',
      )).toBe(false);
    });

    it('ignores empty markers that are hidden', () => {
      expect(isMolecularPartnersEmptyListingPage(
        '<main><div hidden><h2>No results</h2><p>No vacancies match your search criteria.</p></div></main>',
      )).toBe(false);
    });

    it('does not call a page with an actual offer empty', () => {
      const listingWithOffer = `
        <main>
          <h2>No results</h2>
          <p>No vacancies match your search criteria.</p>
          <li class="ts-offer-list-item" onclick="location.href='/job/job-test_1.aspx';">
            <h3><a class="ts-offer-list-item__title-link" href="/job/job-test_1.aspx">Test role</a></h3>
            <ul class="ts-offer-list-item__description"><li>Ref. : 2026-001</li></ul>
          </li>
        </main>
      `;
      expect(isMolecularPartnersEmptyListingPage(listingWithOffer)).toBe(false);
    });

    it('publishes an authoritative zero only for the explicit source state', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(emptyListing, { status: 200 })));

      const jobs = await fetchAllMolecularPartnersJobs();

      expect(jobs).toEqual([]);
      expect(jobs.authoritativeEmptyState).toBe('authoritative-source-zero');
      expect(jobs.discoveredCount).toBe(0);
    });

    it('keeps an unrecognised zero fail-closed', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(
        '<main><h2>No results</h2><p>Try a different filter.</p></main>',
        { status: 200 },
      )));

      const jobs = await fetchAllMolecularPartnersJobs();

      expect(jobs).toEqual([]);
      expect(jobs.authoritativeEmptyState).toBeUndefined();
    });
  });

  // ── isCompanyJob ──
  describe('isMolecularPartnersJob', () => {
    it('matches by companyKey', () => {
      expect(isMolecularPartnersJob({ companyKey: 'molecular-partners' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isMolecularPartnersJob({ company: 'Molecular Partners' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isMolecularPartnersJob({ url: 'https://molecularpartners.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isMolecularPartnersJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isMolecularPartnersJob(null)).toBe(false);
      expect(isMolecularPartnersJob(undefined)).toBe(false);
      expect(isMolecularPartnersJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://molecularpartners.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.molecularpartners.com/job/456')).toBe(true);
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
      const slug = slugify('Software Engineer (m/f/d)');
      expect(slug).toBe('software-engineer-m-f-d');
    });

    it('strips diacritics', () => {
      expect(slugify('Ingénieur qualité')).toBe('ingenieur-qualite');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Developer molecular-partners ch')).toBe('developer-molecular-partners-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference
    const validJob = {
      id: 'molecular-partners-abc123',
      slug: 'test-position-molecular-partners-ch',
      slugByLocale: { en: 'test-position-molecular-partners-ch' },
      company: 'Molecular Partners',
      companyKey: 'molecular-partners',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://molecularpartners.com/jobs/test',
      source: 'Molecular Partners Dedicated Parser',
      sourceLang: 'en',
      crawledAt: new Date().toISOString(),
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

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^molecular-partners-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
