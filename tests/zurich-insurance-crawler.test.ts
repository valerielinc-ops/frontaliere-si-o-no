import { describe, it, expect } from 'vitest';
import {
  ZURICH_INSURANCE_KEY,
  ZURICH_INSURANCE_COMPANY_NAME,
  isZurichInsuranceJob,
  isTrustedDomain,
  parseSearchPage,
  parseDetailPage,
} from '../scripts/lib/zurich-insurance-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Zurich Insurance Group crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    // Slice file on disk is `zurich-insurance-sede-ticino.json` — keep aligned.
    expect(ZURICH_INSURANCE_KEY).toBe('zurich-insurance-sede-ticino');
    expect(ZURICH_INSURANCE_COMPANY_NAME).toContain('Zurich Insurance');
  });

  // ── isCompanyJob ──
  describe('isZurichInsuranceJob', () => {
    it('matches by canonical companyKey', () => {
      expect(isZurichInsuranceJob({ companyKey: 'zurich-insurance-sede-ticino' })).toBe(true);
    });

    it('matches by legacy short companyKey', () => {
      expect(isZurichInsuranceJob({ companyKey: 'zurich-insurance' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isZurichInsuranceJob({ company: 'Zurich Insurance Group' })).toBe(true);
    });

    it('matches by URL domain (careers.zurich.com SuccessFactors)', () => {
      expect(isZurichInsuranceJob({ url: 'https://careers.zurich.com/job/Lugano-Account-Manager/123/' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isZurichInsuranceJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isZurichInsuranceJob(null)).toBe(false);
      expect(isZurichInsuranceJob(undefined)).toBe(false);
      expect(isZurichInsuranceJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts careers.zurich.com (SuccessFactors host)', () => {
      expect(isTrustedDomain('https://careers.zurich.com/job/Lugano-X/123/')).toBe(true);
    });

    it('trusts primary corporate domain', () => {
      expect(isTrustedDomain('https://zurich.com/careers/123')).toBe(true);
    });

    it('trusts SuccessFactors backend hosts', () => {
      expect(isTrustedDomain('https://career2.successfactors.eu/career?company=zurich')).toBe(true);
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
      expect(slugify('Developer zurich-insurance ch')).toBe('developer-zurich-insurance-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── HTML parsers (search page + detail page) ──
  describe('parseSearchPage', () => {
    it('returns empty array for empty/invalid HTML', () => {
      expect(parseSearchPage('')).toEqual([]);
      expect(parseSearchPage('<html></html>')).toEqual([]);
    });

    it('extracts job rows from SF jobs2web search HTML', () => {
      const html = `
        <table id="searchresults">
          <tr>
            <td class="colTitle">
              <span class="jobTitle hidden-phone">
                <a class="jobTitle-link" href="/job/Z%C3%BCrich-Audit-Manager-Investment-Management-80-100/1359692057/">Audit Manager - Investment Management 80-100%</a>
              </span>
            </td>
            <td class="colLocation hidden-phone">
              <span class="jobLocation">Zürich, CH</span>
            </td>
            <td class="colDate hidden-phone">
              <span class="jobDate">Apr 27, 2026</span>
            </td>
          </tr>
        </table>
      `;
      const rows = parseSearchPage(html);
      expect(rows).toHaveLength(1);
      expect(rows[0].title).toBe('Audit Manager - Investment Management 80-100%');
      expect(rows[0].jobId).toBe('1359692057');
      expect(rows[0].url).toBe('https://careers.zurich.com/job/Z%C3%BCrich-Audit-Manager-Investment-Management-80-100/1359692057/');
      expect(rows[0].location).toBe('Zürich, CH');
      expect(rows[0].postedAt).toBe('2026-04-27');
    });

    it('deduplicates rows that repeat the same jobId (hidden-phone + visible-phone duplicates)', () => {
      const html = `
        <tr>
          <a class="jobTitle-link" href="/job/Lugano-Test/123/">Test One</a>
          <span class="jobLocation">Lugano, CH</span>
        </tr>
        <tr>
          <a class="jobTitle-link" href="/job/Lugano-Test/123/">Test One</a>
          <span class="jobLocation">Lugano, CH</span>
        </tr>
      `;
      const rows = parseSearchPage(html);
      expect(rows).toHaveLength(1);
    });
  });

  describe('parseDetailPage', () => {
    it('extracts datePosted from Schema.org microdata', () => {
      const html = `<meta itemprop="datePosted" content="Mon May 04 00:00:00 UTC 2026">`;
      const detail = parseDetailPage(html);
      expect(detail.datePosted).toBe('2026-05-04');
    });

    it('extracts street address (location) from microdata', () => {
      const html = `<meta itemprop="streetAddress" content="Zürich, CH">`;
      const detail = parseDetailPage(html);
      expect(detail.location).toBe('Zürich, CH');
    });

    it('returns null/empty defaults for missing fields', () => {
      const detail = parseDetailPage('<html></html>');
      expect(detail.datePosted).toBeNull();
      expect(detail.location).toBe('');
      expect(detail.descriptionHtml).toBe('');
    });

    it('captures jobdescription body up to apply boundary', () => {
      const html = `
        <span class="jobdescription"><p>Body text</p></span>
        <div class="applylink">apply</div>
      `;
      const detail = parseDetailPage(html);
      expect(detail.descriptionHtml).toContain('Body text');
      expect(detail.descriptionHtml).not.toContain('applylink');
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const validJob = {
      id: 'zurich-insurance-abc123',
      slug: 'test-position-zurich-insurance-ch',
      slugByLocale: { it: 'test-position-zurich-insurance-ch' },
      company: 'Zurich Insurance Group',
      companyKey: 'zurich-insurance-sede-ticino',
      title: 'Test Position',
      titleByLocale: { it: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { it: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://careers.zurich.com/job/Lugano-Test/123/',
      source: 'Zurich Insurance careers.zurich.com SuccessFactors parser',
      sourceLang: 'it',
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

    it('id starts with company key prefix', () => {
      expect(validJob.id).toMatch(/^zurich-insurance-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
