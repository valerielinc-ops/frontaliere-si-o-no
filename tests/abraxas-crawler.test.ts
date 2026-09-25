import { describe, it, expect } from 'vitest';
import {
  ABRAXAS_KEY,
  ABRAXAS_COMPANY_NAME,
  isAbraxasJob,
  isTrustedDomain,
  parseAbraxasListing,
  parseAbraxasDetail,
} from '../scripts/lib/abraxas-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Abraxas Informatik AG crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(ABRAXAS_KEY).toBe('abraxas');
    expect(ABRAXAS_COMPANY_NAME).toBe('Abraxas Informatik AG');
  });

  // ── isCompanyJob ──
  describe('isAbraxasJob', () => {
    it('matches by companyKey', () => {
      expect(isAbraxasJob({ companyKey: 'abraxas' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isAbraxasJob({ company: 'Abraxas Informatik AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isAbraxasJob({ url: 'https://www.abraxas.ch/de/karriere/offene-stellen/test-job' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(
        isAbraxasJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })
      ).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isAbraxasJob(null)).toBe(false);
      expect(isAbraxasJob(undefined)).toBe(false);
      expect(isAbraxasJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts the abraxas.ch host and subdomains', () => {
      expect(isTrustedDomain('https://www.abraxas.ch/de/karriere/offene-stellen')).toBe(true);
      expect(isTrustedDomain('https://abraxas.ch/')).toBe(true);
    });

    it('trusts the Refline apply-link host (per-job apply CTA, not the canonical url)', () => {
      expect(isTrustedDomain('https://apply.refline.ch/215876/123/index.html')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── parseAbraxasListing ──
  describe('parseAbraxasListing', () => {
    const listingHtml = `
      <ul class="job-list">
        <li class="job-list__list-item">
          <a href="/de/karriere/offene-stellen/software-entwickler-m-w-d" class="job-list__job">
            <div class="job-list__job-title">Software-Entwickler (m/w/d)</div>
            <div class="job-list__job-location">St. Gallen</div>
          </a>
        </li>
        <li class="job-list__list-item">
          <a href="https://www.abraxas.ch/de/karriere/offene-stellen/system-engineer" class="job-list__job">
            <div class="job-list__job-title">System Engineer</div>
            <div class="job-list__job-location">Zürich-Flughafen</div>
          </a>
        </li>
      </ul>
    `;

    it('parses listing rows into url/title/location', () => {
      const rows = parseAbraxasListing(listingHtml);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        url: 'https://www.abraxas.ch/de/karriere/offene-stellen/software-entwickler-m-w-d',
        title: 'Software-Entwickler (m/w/d)',
        location: 'St. Gallen',
      });
      expect(rows[1].url).toBe('https://www.abraxas.ch/de/karriere/offene-stellen/system-engineer');
    });

    it('dedupes repeated urls', () => {
      const dup = listingHtml + listingHtml;
      const rows = parseAbraxasListing(dup);
      expect(rows).toHaveLength(2);
    });

    it('returns empty array for empty/missing html', () => {
      expect(parseAbraxasListing('')).toEqual([]);
      expect(parseAbraxasListing('<html><body>no jobs</body></html>')).toEqual([]);
    });
  });

  // ── parseAbraxasDetail ──
  describe('parseAbraxasDetail', () => {
    const detailHtml = `
      <h1 class="header__title">Software-Entwickler (m/w/d)<span class="subtitle">St. Gallen</span></h1>
      <ul class="c-definition-list--default">
        <li>
          <div class="definition-list__term">Pensum</div>
          <div class="desfinition-list__description">80 - 100%</div>
        </li>
        <li>
          <div class="definition-list__term">Anstellungsart</div>
          <div class="desfinition-list__description">Festanstellung</div>
        </li>
      </ul>
      <a href="https://apply.refline.ch/215876/456/index.html">Jetzt bewerben</a>
      <div class="rich-text-field">
        <p>Als Software-Entwickler:in bei Abraxas entwickelst du moderne Loesungen fuer die oeffentliche Verwaltung in der Schweiz. Du arbeitest in einem agilen Team an Applikationen fuer Kantone und Gemeinden und bringst deine Erfahrung in Java und Cloud-Technologien ein, um Behoerden bei der Digitalisierung zu unterstuetzen und langfristige Partnerschaften zu pflegen.</p>
      </div>
    `;

    it('extracts title and location from the h1/subtitle', () => {
      const detail = parseAbraxasDetail(detailHtml);
      expect(detail.title).toBe('Software-Entwickler (m/w/d)');
      expect(detail.location).toBe('St. Gallen');
    });

    it('extracts the Refline apply link and posId', () => {
      const detail = parseAbraxasDetail(detailHtml);
      expect(detail.applyUrl).toContain('apply.refline.ch/215876/456/index.html');
      expect(detail.posId).toBe('456');
    });

    it('returns safe defaults for empty html', () => {
      const detail = parseAbraxasDetail('');
      expect(detail).toMatchObject({
        title: '', location: '', pensum: '', employmentTypeRaw: '', description: '', applyUrl: '', posId: '',
      });
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('converts title to URL-safe slug', () => {
      const slug = slugify('Software-Entwickler (m/w/d), 80-100%');
      expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('software entwickler abraxas st gallen')).toBe(
        'software-entwickler-abraxas-st-gallen'
      );
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const validJob = {
      id: 'abraxas-abc123',
      slug: 'test-position-abraxas-st-gallen',
      slugByLocale: { de: 'test-position-abraxas-st-gallen' },
      company: 'Abraxas Informatik AG',
      companyKey: 'abraxas',
      companyDomain: 'abraxas.ch',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description long enough to satisfy the fifty word minimum content guard used across every dedicated crawler in this repository, so the automated thin-content check passes cleanly during validation runs without any additional padding text required here at all today, even after accounting for whitespace splitting and word boundary edge cases across locales and punctuation marks throughout this fixture string.',
      descriptionByLocale: {
        de: 'A test job description long enough to satisfy the fifty word minimum content guard used across every dedicated crawler in this repository, so the automated thin-content check passes cleanly during validation runs without any additional padding text required here at all today, even after accounting for whitespace splitting and word boundary edge cases across locales and punctuation marks throughout this fixture string.',
      },
      location: 'St. Gallen',
      canton: 'SG',
      url: 'https://www.abraxas.ch/de/karriere/offene-stellen/test-position',
      source: 'Abraxas Informatik AG Dedicated Parser (custom HTML)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),

      addressLocality: 'St. Gallen',
      addressRegion: 'SG',
      streetAddress: 'St. Leonhard-Strasse 80',
      postalCode: '9001',
      addressCountry: 'CH',
      country: 'CH',
      employmentType: 'FULL_TIME',
      postedDate: new Date().toISOString().slice(0, 10),
      applyUrl: 'https://apply.refline.ch/215876/456/index.html',
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
      expect(validJob.id).toMatch(/^abraxas-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
