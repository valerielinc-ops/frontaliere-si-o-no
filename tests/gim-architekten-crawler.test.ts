import { describe, it, expect } from 'vitest';
import {
  GIM_ARCHITEKTEN_KEY,
  GIM_ARCHITEKTEN_COMPANY_NAME,
  isGimArchitektenJob,
  isTrustedDomain,
  parseVacancyLinks,
  extractJobPostingJsonLd,
  cleanStreetAddress,
  detectCategory,
  detectEmploymentType,
  detectExperienceLevel,
} from '../scripts/lib/gim-architekten-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('GIM Architekten AG crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(GIM_ARCHITEKTEN_KEY).toBe('gim-architekten');
    expect(GIM_ARCHITEKTEN_COMPANY_NAME).toBe('GIM Architekten AG');
  });

  // ── isGimArchitektenJob ──
  describe('isGimArchitektenJob', () => {
    it('matches by companyKey', () => {
      expect(isGimArchitektenJob({ companyKey: 'gim-architekten' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isGimArchitektenJob({ company: 'GIM Architekten AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isGimArchitektenJob({ url: 'https://www.gim.ch/jobs/' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isGimArchitektenJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isGimArchitektenJob(null)).toBe(false);
      expect(isGimArchitektenJob(undefined)).toBe(false);
      expect(isGimArchitektenJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts jobs.ch (actual publishing channel)', () => {
      expect(isTrustedDomain('https://www.jobs.ch/en/vacancies/detail/abc123/')).toBe(true);
    });

    it('trusts jobs.ch subdomains', () => {
      expect(isTrustedDomain('https://media.jobs.ch/images/x.png')).toBe(true);
    });

    it('trusts gim.ch', () => {
      expect(isTrustedDomain('https://www.gim.ch/jobs/')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── parseVacancyLinks ──
  describe('parseVacancyLinks', () => {
    it('extracts vacancy detail links from a jobs.ch company page', () => {
      const html = `
        <a class="link" href="/en/vacancies/detail/af4cec50-62b4-4f52-9d0e-bf3d0c24bf80/" data-discover="true">
          <div data-cy="vacancy-serp-item">Leitung Administration, Personal &amp; Finanzbuchhaltung</div>
        </a>
        <a class="link" href="/en/vacancies/detail/1d796c78-bfb5-4f59-abbc-afa0ee492061/" data-discover="true">
          <div data-cy="vacancy-serp-item">Dipl. Architekt/In - GIM</div>
        </a>
      `;
      expect(parseVacancyLinks(html)).toEqual([
        'https://www.jobs.ch/en/vacancies/detail/af4cec50-62b4-4f52-9d0e-bf3d0c24bf80/',
        'https://www.jobs.ch/en/vacancies/detail/1d796c78-bfb5-4f59-abbc-afa0ee492061/',
      ]);
    });

    it('returns empty array when no vacancies are present', () => {
      expect(parseVacancyLinks('<html><body>No open positions</body></html>')).toEqual([]);
    });

    it('returns empty array for invalid input', () => {
      expect(parseVacancyLinks('')).toEqual([]);
      expect(parseVacancyLinks(null as unknown as string)).toEqual([]);
      expect(parseVacancyLinks(undefined as unknown as string)).toEqual([]);
    });

    it('deduplicates repeated links', () => {
      const html = `
        <a href="/en/vacancies/detail/af4cec50-62b4-4f52-9d0e-bf3d0c24bf80/">A</a>
        <a href="/en/vacancies/detail/af4cec50-62b4-4f52-9d0e-bf3d0c24bf80/">A dup</a>
      `;
      expect(parseVacancyLinks(html)).toHaveLength(1);
    });
  });

  // ── extractJobPostingJsonLd ──
  describe('extractJobPostingJsonLd', () => {
    it('extracts a JobPosting object from a single ld+json script', () => {
      const html = `
        <script type="application/ld+json">
          {"@context":"https://schema.org","@type":"JobPosting","title":"Leitung Administration, Personal & Finanzbuchhaltung"}
        </script>
      `;
      const posting = extractJobPostingJsonLd(html);
      expect(posting).not.toBeNull();
      expect(posting.title).toBe('Leitung Administration, Personal & Finanzbuchhaltung');
    });

    it('finds JobPosting inside an array of ld+json entries', () => {
      const html = `
        <script type="application/ld+json">
          [{"@type":"Organization","name":"GIM Architekten AG"},{"@type":"JobPosting","title":"Dipl. Architekt/In - GIM"}]
        </script>
      `;
      const posting = extractJobPostingJsonLd(html);
      expect(posting).not.toBeNull();
      expect(posting.title).toBe('Dipl. Architekt/In - GIM');
    });

    it('returns null when no JobPosting block is present', () => {
      const html = `<script type="application/ld+json">{"@type":"Organization","name":"GIM Architekten AG"}</script>`;
      expect(extractJobPostingJsonLd(html)).toBeNull();
    });

    it('returns null for invalid input', () => {
      expect(extractJobPostingJsonLd('')).toBeNull();
      expect(extractJobPostingJsonLd(undefined as unknown as string)).toBeNull();
    });
  });

  // ── cleanStreetAddress ──
  describe('cleanStreetAddress', () => {
    it('strips the redundant trailing "postal city" segment', () => {
      expect(cleanStreetAddress('Altenbergstrasse 28, 3013 Bern', 'Bern', '3013')).toBe('Altenbergstrasse 28');
    });

    it('falls back to city when streetAddress is empty (safe default)', () => {
      expect(cleanStreetAddress('', 'Bern', '3013')).toBe('Bern');
    });

    it('returns the raw value unchanged when there is no redundant suffix', () => {
      expect(cleanStreetAddress('Rue Centrale 4', 'Delémont', '2800')).toBe('Rue Centrale 4');
    });
  });

  // ── detectCategory ──
  describe('detectCategory', () => {
    it('detects architect/project-lead roles', () => {
      expect(detectCategory('Dipl. Architekt/In - GIM', '')).toBe('Ingegneria');
    });

    it('detects finance/accounting roles (more specific than generic admin)', () => {
      expect(detectCategory('Leitung Administration, Personal & Finanzbuchhaltung', '')).toBe('Finanza');
    });

    it('detects apprentice roles as Altro even when the title also mentions architecture', () => {
      expect(detectCategory('Lehrstelle Zeichner/-in EFZ Architektur', '')).toBe('Altro');
    });

    it('detects buyer-support/sales-adjacent roles as Commerciale', () => {
      expect(detectCategory('Käuferbetreuung', '')).toBe('Commerciale');
    });
  });

  // ── detectEmploymentType ──
  describe('detectEmploymentType', () => {
    it('detects full-time from high percentage in title', () => {
      expect(detectEmploymentType('Dipl. Architekt/In 100%', '')).toBe('FULL_TIME');
    });

    it('detects part-time from percentage in title', () => {
      expect(detectEmploymentType('Architekt:in / Projektleiter:in 60%', '')).toBe('PART_TIME');
    });

    it('detects part-time from keyword', () => {
      expect(detectEmploymentType('Teilzeit Position', '')).toBe('PART_TIME');
    });

    it('defaults to FULL_TIME', () => {
      expect(detectEmploymentType('Dipl. Architekt/In', '')).toBe('FULL_TIME');
    });
  });

  // ── detectExperienceLevel ──
  describe('detectExperienceLevel', () => {
    it('detects intern/apprentice roles', () => {
      expect(detectExperienceLevel('Lehrstelle Zeichner/-in EFZ Architektur')).toBe('intern');
    });

    it('detects senior/lead roles', () => {
      expect(detectExperienceLevel('Leitung Administration, Personal & Finanzbuchhaltung')).toBe('senior');
    });

    it('defaults to mid', () => {
      expect(detectExperienceLevel('Dipl. Architekt/In - GIM')).toBe('mid');
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('converts title to URL-safe slug', () => {
      const slug = slugify('Dipl. Architekt/In - GIM');
      expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('strips diacritics', () => {
      expect(slugify('Käuferbetreuung Bern')).toBe('kauferbetreuung-bern');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Architekt gim-architekten Bern')).toBe('architekt-gim-architekten-bern');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const validJob = {
      id: 'gim-architekten-abc123def456',
      slug: 'leitung-administration-personal-finanzbuchhaltung-gim-architekten-bern',
      slugByLocale: { de: 'leitung-administration-personal-finanzbuchhaltung-gim-architekten-bern' },
      company: 'GIM Architekten AG',
      companyKey: 'gim-architekten',
      companyDomain: 'gim.ch',
      title: 'Leitung Administration, Personal & Finanzbuchhaltung',
      titleByLocale: { de: 'Leitung Administration, Personal & Finanzbuchhaltung' },
      description: 'A test job description for validation with enough words to pass the minimum threshold for content quality checks required by the SEO gate for indexed pages on this site.',
      descriptionByLocale: {
        de: 'A test job description for validation with enough words to pass the minimum threshold for content quality checks required by the SEO gate for indexed pages on this site.',
      },
      location: 'Bern',
      canton: 'BE',
      addressLocality: 'Bern',
      addressRegion: 'BE',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: '3013',
      streetAddress: 'Altenbergstrasse 28',
      url: 'https://www.jobs.ch/en/vacancies/detail/af4cec50-62b4-4f52-9d0e-bf3d0c24bf80/',
      applyUrl: 'https://www.jobs.ch/en/vacancies/detail/af4cec50-62b4-4f52-9d0e-bf3d0c24bf80/',
      source: 'GIM Architekten AG Dedicated Parser (jobs.ch)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      category: 'Finanza',
      sector: 'Architettura / Edilizia',
      contract: 'full-time',
      employmentType: 'FULL_TIME',
      experienceLevel: 'senior',
      featured: false,
      postedDate: '2026-07-03',
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

    it('has all SEO-required fields', () => {
      const seoFields = [
        'addressLocality', 'addressRegion', 'addressCountry',
        'postalCode', 'streetAddress', 'employmentType',
        'sector', 'postedDate',
      ];
      for (const field of seoFields) {
        expect(validJob).toHaveProperty(field);
        expect(validJob[field as keyof typeof validJob]).toBeTruthy();
      }
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^gim-architekten-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('canton is BE for Bern', () => {
      expect(validJob.canton).toBe('BE');
    });

    it('sector is architecture/construction', () => {
      expect(validJob.sector).toBe('Architettura / Edilizia');
    });
  });
});
