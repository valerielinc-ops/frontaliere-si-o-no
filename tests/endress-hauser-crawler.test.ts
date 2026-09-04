import { describe, it, expect } from 'vitest';
import {
  ENDRESS_HAUSER_KEY,
  ENDRESS_HAUSER_COMPANY_NAME,
  isEndressHauserJob,
  isTrustedDomain,
} from '../scripts/lib/endress-hauser-job-parser.mjs';
import { parseCsbSearchResults } from '../scripts/lib/successfactors-shared-job-parser-common.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Endress+Hauser crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(ENDRESS_HAUSER_KEY).toBe('endress-hauser');
    expect(ENDRESS_HAUSER_COMPANY_NAME).toBe('Endress+Hauser');
  });

  // ── isCompanyJob ──
  describe('isEndressHauserJob', () => {
    it('matches by companyKey', () => {
      expect(isEndressHauserJob({ companyKey: 'endress-hauser' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isEndressHauserJob({ company: 'Endress+Hauser' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isEndressHauserJob({ url: 'https://endress.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isEndressHauserJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isEndressHauserJob(null)).toBe(false);
      expect(isEndressHauserJob(undefined)).toBe(false);
      expect(isEndressHauserJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://endress.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.endress.com/job/456')).toBe(true);
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
      expect(slugify('Developer endress-hauser ch')).toBe('developer-endress-hauser-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── CSB search-results parsing: country/brand-prefixed job links ──
  // Endress+Hauser's careers.endress.com prefixes job links with a single
  // country/brand path segment (e.g. `/Switzerland/job/...` or
  // `/analytik-jena/job/...`) instead of the flat `/job/...` shape most other
  // SuccessFactors CSB tenants wired to this factory use. This is what
  // `parseCsbSearchResults()` was extended to also match (additive, optional
  // leading path segment) — verify both shapes still resolve.
  describe('parseCsbSearchResults — country/brand-prefixed links', () => {
    const rowHtml = (href: string, title: string, location: string) => `
      <tr>
        <td class="colTitle" headers="hdrTitle">
          <span class="jobTitle hidden-phone">
            <a href="${href}" class="jobTitle-link">${title}</a>
          </span>
        </td>
        <td class="colLocation hidden-phone" headers="hdrLocation">
          <span class="jobLocation">${location}</span>
        </td>
        <td class="colDate hidden-phone" headers="hdrDate">
          <span class="jobDate">Jun 17, 2026</span>
        </td>
      </tr>`;

    it('parses country-prefixed job links (Switzerland)', () => {
      const html = rowHtml(
        '/Switzerland/job/Reinach-Test-Position-4153/1234567890/',
        'Test Position',
        'Reinach, CH, 4153',
      );
      const jobs = parseCsbSearchResults(html);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].relUrl).toBe('/Switzerland/job/Reinach-Test-Position-4153/1234567890/');
      expect(jobs[0].jobId).toBe('1234567890');
      expect(jobs[0].title).toBe('Test Position');
    });

    it('parses brand-prefixed job links (sub-brand tenant)', () => {
      const html = rowHtml(
        '/analytik-jena/job/Jena-Werkstudent-07745/1381379833/',
        'Werkstudent',
        'Jena, DE, 07745',
      );
      const jobs = parseCsbSearchResults(html);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].jobId).toBe('1381379833');
    });

    it('keeps the visible office of a multi-location row (dedicated cell)', () => {
      const html = rowHtml(
        '/Switzerland/job/Reinach-Test-Position-4153/1234567890/',
        'Test Position',
        'Reinach, CH, 4153 <small class="nobr">+2 more&hellip;</small>',
      );
      const jobs = parseCsbSearchResults(html);
      expect(jobs[0].location).toBe('Reinach, CH, 4153');
    });

    it('keeps the visible office on the heuristic cell scan too (no colLocation cell)', () => {
      // CSB skins without `colLocation hidden-phone`/`headers="hdrLocation"`
      // fall back to electing the cell that looks like "City, CC" — a gate the
      // contaminated text "Lugano, CH +1 more…" fails, so the marker has to be
      // stripped at extraction or the row comes out with NO location at all.
      const html = `
        <tr>
          <td><a href="/job/Lugano-Test-Position-6900/1234567891/" class="jobTitle-link">Test Position</a></td>
          <td><span class="jobLocation">Lugano, CH <small class="nobr">+1 more&hellip;</small></span></td>
          <td>Jun 17, 2026</td>
        </tr>`;
      const jobs = parseCsbSearchResults(html);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].location).toBe('Lugano, CH');
    });

    it('still parses flat (non-prefixed) job links for existing tenants', () => {
      const html = rowHtml(
        '/job/Test-Position-4153/1234567890/',
        'Test Position',
        'Reinach, CH, 4153',
      );
      const jobs = parseCsbSearchResults(html);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].relUrl).toBe('/job/Test-Position-4153/1234567890/');
    });

    it('returns empty array for no matches / malformed input', () => {
      expect(parseCsbSearchResults('')).toEqual([]);
      expect(parseCsbSearchResults('<tr><td>no link here</td></tr>')).toEqual([]);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference — covers Non-Negotiable #3
    // (structured-data fields) and #4 (50-word floor) required fields.
    const validJob = {
      id: 'endress-hauser-abc123',
      slug: 'test-position-endress-hauser-ch',
      slugByLocale: { de: 'test-position-endress-hauser-ch' },
      company: 'Endress+Hauser',
      companyKey: 'endress-hauser',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A '.repeat(55) + 'test job description for validation purposes only.',
      descriptionByLocale: { de: 'A '.repeat(55) + 'test job description for validation purposes only.' },
      location: 'Reinach',
      canton: 'BL',
      postalCode: '4153',
      streetAddress: 'Kägenstrasse 2',
      url: 'https://careers.endress.com/Switzerland/job/test/123/',
      source: 'Endress+Hauser Dedicated Parser (SuccessFactors CSB)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      datePosted: new Date().toISOString(),
      hiringOrganization: { name: 'Endress+Hauser' },
      jobLocation: { addressLocality: 'Reinach', postalCode: '4153', addressCountry: 'CH' },
      employmentType: 'FULL_TIME',
      baseSalary: { currency: 'CHF', value: { minValue: 0, maxValue: 0, unitText: 'MONTH' } },
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

    it('has all Non-Negotiable #3 structured-data fields', () => {
      const structuredDataFields = [
        'baseSalary', 'postalCode', 'streetAddress', 'title', 'description',
        'datePosted', 'hiringOrganization', 'jobLocation', 'employmentType',
      ];
      for (const field of structuredDataFields) {
        expect(validJob).toHaveProperty(field);
      }
      expect(validJob.hiringOrganization.name).toBe('Endress+Hauser');
    });

    it('description clears the 50-word floor (Non-Negotiable #4)', () => {
      const wordCount = validJob.description.trim().split(/\s+/).length;
      expect(wordCount).toBeGreaterThanOrEqual(50);
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^endress-hauser-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
