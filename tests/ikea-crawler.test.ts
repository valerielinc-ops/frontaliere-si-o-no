import { beforeEach, describe, it, expect, vi } from 'vitest';

const { fetchHtml } = vi.hoisted(() => ({ fetchHtml: vi.fn() }));

vi.mock('../scripts/lib/crawler-template.mjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../scripts/lib/crawler-template.mjs')>()),
  fetchHtml,
}));
import {
  IKEA_KEY,
  IKEA_COMPANY_NAME,
  isIkeaJob,
  isTrustedDomain,
  resolveIkeaAddressRegion,
  resolveIkeaListingGeography,
  fetchAllIkeaJobs,
} from '../scripts/lib/ikea-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';
import { schemaJobLocationCandidates } from '../scripts/lib/prospector/location-evidence.mjs';

describe('IKEA crawler parser', () => {
  beforeEach(() => fetchHtml.mockReset());
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(IKEA_KEY).toBe('ikea');
    expect(IKEA_COMPANY_NAME).toBe('IKEA');
  });

  // ── isCompanyJob ──
  describe('isIkeaJob', () => {
    it('matches by companyKey', () => {
      expect(isIkeaJob({ companyKey: 'ikea' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isIkeaJob({ company: 'IKEA' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isIkeaJob({ url: 'https://ikea.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isIkeaJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isIkeaJob(null)).toBe(false);
      expect(isIkeaJob(undefined)).toBe(false);
      expect(isIkeaJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://ikea.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.ikea.ch/job/456')).toBe(true);
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
      expect(slugify('Developer ikea ch')).toBe('developer-ikea-ch');
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
      id: 'ikea-abc123',
      slug: 'test-position-ikea-ch',
      slugByLocale: { de: 'test-position-ikea-ch' },
      company: 'IKEA',
      companyKey: 'ikea',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://ikea.ch/jobs/test',
      source: 'IKEA Dedicated Parser',
      sourceLang: 'de',
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
      expect(validJob.id).toMatch(/^ikea-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  describe('resolveIkeaAddressRegion', () => {
    it('trusts the feed region when it agrees with the inferred canton', () => {
      expect(resolveIkeaAddressRegion('TI', 'TI')).toBe('TI');
      expect(resolveIkeaAddressRegion('ti', 'TI')).toBe('TI');
    });

    it('rejects a feed region that disagrees with the inferred canton', () => {
      expect(resolveIkeaAddressRegion('BE', 'TI')).toBe('');
    });

    it('rejects a malformed (non 2-letter) feed region', () => {
      expect(resolveIkeaAddressRegion('Aargau', 'AG')).toBe('');
      expect(resolveIkeaAddressRegion('', 'AG')).toBe('');
    });
  });

  describe('structured location evidence', () => {
    it('evaluates every jobLocation and selects the Swiss candidate', () => {
      const locationCandidates = schemaJobLocationCandidates([
        { address: { addressLocality: 'Paris', addressCountry: 'FR' } },
        { address: { addressLocality: 'Zürich', addressRegion: 'ZH', addressCountry: 'CH' } },
      ]);
      const decision = resolveIkeaListingGeography({ location: 'Vernier', locationCandidates });
      expect(decision.geography)
        .toMatchObject({ location: 'Zürich, ZH', canton: 'ZH', addressCountry: 'CH' });
      expect(decision.candidate).toMatchObject({ addressLocality: 'Zürich', addressRegion: 'ZH' });
    });

    it('does not let a Swiss listing override authoritative foreign detail', () => {
      const locationCandidates = schemaJobLocationCandidates({
        address: { addressLocality: 'Geneva', addressRegion: 'NY', addressCountry: 'US' },
      });
      expect(resolveIkeaListingGeography({ location: 'Geneva', locationCandidates }).geography).toBeNull();
    });

    it('keeps a Remote listing until authoritative detail supplies a Swiss location', async () => {
      const listing = '<a href="/en/job/zurich/remote-role/123" data-job-id="123" class="job-list__anchor">' +
        '<span class="job-list__title">Data Engineer</span>' +
        '<span class="job-list__location">Remote / Multiple locations</span></a></section>';
      const detail = `<script type="application/ld+json">${JSON.stringify({
        '@type': 'JobPosting',
        description: 'Build and operate the data platform for IKEA Switzerland.',
        jobLocation: { address: {
          addressLocality: 'Pratteln', addressRegion: 'BL', addressCountry: 'CH', postalCode: '4133',
        } },
      })}</script>`;
      fetchHtml.mockImplementation(async (url: string) => String(url || '').includes('/remote-role/') ? detail : listing);

      const [job] = await fetchAllIkeaJobs();
      expect(job).toMatchObject({ location: 'Pratteln, BL', canton: 'BL', addressLocality: 'Pratteln', postalCode: '4133' });
    });
  });
});
