import { describe, it, expect } from 'vitest';
import {
  SAINT_GOBAIN_WEBER_ISOVER_KEY,
  SAINT_GOBAIN_WEBER_ISOVER_COMPANY_NAME,
  isSaintGobainWeberIsoverJob,
  isTrustedDomain,
  parseVacancyLinks,
  extractJobPostingJsonLd,
  cleanStreetAddress,
  detectCategory,
  detectEmploymentType,
  detectExperienceLevel,
} from '../scripts/lib/saint-gobain-weber-isover-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Saint-Gobain Weber/Isover Suisse crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(SAINT_GOBAIN_WEBER_ISOVER_KEY).toBe('saint-gobain-weber-isover');
    expect(SAINT_GOBAIN_WEBER_ISOVER_COMPANY_NAME).toBe('Saint-Gobain Weber/Isover Suisse');
  });

  // ── isSaintGobainWeberIsoverJob ──
  describe('isSaintGobainWeberIsoverJob', () => {
    it('matches by companyKey', () => {
      expect(isSaintGobainWeberIsoverJob({ companyKey: 'saint-gobain-weber-isover' })).toBe(true);
    });

    it('matches by Weber company name', () => {
      expect(isSaintGobainWeberIsoverJob({ company: 'Saint-Gobain Weber AG' })).toBe(true);
    });

    it('matches by Isover company name', () => {
      expect(isSaintGobainWeberIsoverJob({ company: 'Saint-Gobain Isover SA' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isSaintGobainWeberIsoverJob({ url: 'https://www.ch.weber/jobs/123' })).toBe(true);
      expect(isSaintGobainWeberIsoverJob({ url: 'https://www.isover.ch/jobs/456' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isSaintGobainWeberIsoverJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isSaintGobainWeberIsoverJob(null)).toBe(false);
      expect(isSaintGobainWeberIsoverJob(undefined)).toBe(false);
      expect(isSaintGobainWeberIsoverJob({})).toBe(false);
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

    it('trusts the ch.weber dot-brand domain', () => {
      expect(isTrustedDomain('https://www.ch.weber/karriere')).toBe(true);
    });

    it('trusts isover.ch', () => {
      expect(isTrustedDomain('https://www.isover.ch/jobs')).toBe(true);
    });

    it('trusts saint-gobain.ch', () => {
      expect(isTrustedDomain('https://www.saint-gobain.ch/careers')).toBe(true);
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
        <a class="link" href="/en/vacancies/detail/befb0d31-c26f-417c-8888-8059d462ef72/" data-discover="true">
          <div data-cy="vacancy-serp-item">Farbmetriker/-in</div>
        </a>
        <a class="link" href="/en/vacancies/detail/0a518e8f-594a-49dd-b2cd-4e90f5d3bbc6/" data-discover="true">
          <div data-cy="vacancy-serp-item">Leiter/-in Produktsicherheit</div>
        </a>
      `;
      expect(parseVacancyLinks(html)).toEqual([
        'https://www.jobs.ch/en/vacancies/detail/befb0d31-c26f-417c-8888-8059d462ef72/',
        'https://www.jobs.ch/en/vacancies/detail/0a518e8f-594a-49dd-b2cd-4e90f5d3bbc6/',
      ]);
    });

    it('returns empty array when no vacancies are present (Isover: 0 open positions)', () => {
      expect(parseVacancyLinks('<html><body>No open positions</body></html>')).toEqual([]);
    });

    it('returns empty array for invalid input', () => {
      expect(parseVacancyLinks('')).toEqual([]);
      expect(parseVacancyLinks(null as unknown as string)).toEqual([]);
      expect(parseVacancyLinks(undefined as unknown as string)).toEqual([]);
    });

    it('deduplicates repeated links', () => {
      const html = `
        <a href="/en/vacancies/detail/befb0d31-c26f-417c-8888-8059d462ef72/">A</a>
        <a href="/en/vacancies/detail/befb0d31-c26f-417c-8888-8059d462ef72/">A dup</a>
      `;
      expect(parseVacancyLinks(html)).toHaveLength(1);
    });
  });

  // ── extractJobPostingJsonLd ──
  describe('extractJobPostingJsonLd', () => {
    it('extracts a JobPosting object from a single ld+json script', () => {
      const html = `
        <script type="application/ld+json">
          {"@context":"https://schema.org","@type":"JobPosting","title":"Farbmetriker/-in im Betriebslabor"}
        </script>
      `;
      const posting = extractJobPostingJsonLd(html);
      expect(posting).not.toBeNull();
      expect(posting.title).toBe('Farbmetriker/-in im Betriebslabor');
    });

    it('finds JobPosting inside an array of ld+json entries', () => {
      const html = `
        <script type="application/ld+json">
          [{"@type":"Organization","name":"Saint-Gobain Weber AG"},{"@type":"JobPosting","title":"Leiter/-in Produktsicherheit"}]
        </script>
      `;
      const posting = extractJobPostingJsonLd(html);
      expect(posting).not.toBeNull();
      expect(posting.title).toBe('Leiter/-in Produktsicherheit');
    });

    it('returns null when no JobPosting block is present', () => {
      const html = `<script type="application/ld+json">{"@type":"Organization","name":"Saint-Gobain Weber AG"}</script>`;
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
      expect(cleanStreetAddress('Industriestrasse 10, 8604 Volketswil', 'Volketswil', '8604')).toBe('Industriestrasse 10');
    });

    it('falls back to city when streetAddress is empty (safe default)', () => {
      expect(cleanStreetAddress('', 'Volketswil', '8604')).toBe('Volketswil');
    });

    it('returns the raw value unchanged when there is no redundant suffix', () => {
      expect(cleanStreetAddress('Chemin des Champs 4', 'Lucens', '1522')).toBe('Chemin des Champs 4');
    });
  });

  // ── detectCategory ──
  describe('detectCategory', () => {
    it('detects lab/technical roles', () => {
      expect(detectCategory('Farbmetriker/-in im Betriebslabor', 'Technical / Chemical / Pharma')).toBe('Tecnica');
    });

    it('detects production roles', () => {
      expect(detectCategory('Anlagenführer Produktion', '')).toBe('Produzione');
    });

    it('detects logistics roles', () => {
      expect(detectCategory('Chauffeur C/E', '')).toBe('Logistica');
    });

    it('detects sales roles', () => {
      expect(detectCategory('Key Account Manager Vertrieb', '')).toBe('Commerciale');
    });

    it('defaults to Altro for unknown titles', () => {
      expect(detectCategory('Praktikant Nachhaltigkeit', '')).toBe('Altro');
    });
  });

  // ── detectEmploymentType ──
  describe('detectEmploymentType', () => {
    it('detects full-time from workHours', () => {
      expect(detectEmploymentType('Farbmetriker/-in', '42 - 42 hours/week')).toBe('FULL_TIME');
    });

    it('detects part-time from percentage in title', () => {
      expect(detectEmploymentType('Leiter/-in Produktsicherheit 60%', '')).toBe('PART_TIME');
    });

    it('detects part-time from keyword', () => {
      expect(detectEmploymentType('Teilzeit Position', '')).toBe('PART_TIME');
    });

    it('defaults to FULL_TIME', () => {
      expect(detectEmploymentType('Farbmetriker', '')).toBe('FULL_TIME');
    });
  });

  // ── detectExperienceLevel ──
  describe('detectExperienceLevel', () => {
    it('detects intern/apprentice roles', () => {
      expect(detectExperienceLevel('Lernende/-r Praktikant')).toBe('intern');
    });

    it('detects senior/lead roles', () => {
      expect(detectExperienceLevel('Leiter/-in Produktsicherheit')).toBe('senior');
    });

    it('defaults to mid', () => {
      expect(detectExperienceLevel('Farbmetriker/-in im Betriebslabor')).toBe('mid');
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('converts title to URL-safe slug', () => {
      const slug = slugify('Farbmetriker/-in im Betriebslabor');
      expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('strips diacritics', () => {
      expect(slugify('Ingénieur qualité')).toBe('ingenieur-qualite');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Farbmetriker saint-gobain-weber-isover Volketswil')).toBe('farbmetriker-saint-gobain-weber-isover-volketswil');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const validJob = {
      id: 'saint-gobain-weber-isover-abc123def456',
      slug: 'farbmetriker-in-im-betriebslabor-saint-gobain-weber-isover-volketswil',
      slugByLocale: { de: 'farbmetriker-in-im-betriebslabor-saint-gobain-weber-isover-volketswil' },
      company: 'Saint-Gobain Weber AG',
      companyKey: 'saint-gobain-weber-isover',
      companyDomain: 'ch.weber',
      title: 'Farbmetriker/-in im Betriebslabor, Volketswil, 100%',
      titleByLocale: { de: 'Farbmetriker/-in im Betriebslabor, Volketswil, 100%' },
      description: 'A test job description for validation with enough words to pass the minimum threshold for content quality checks required by the SEO gate for indexed pages on this site.',
      descriptionByLocale: {
        de: 'A test job description for validation with enough words to pass the minimum threshold for content quality checks required by the SEO gate for indexed pages on this site.',
      },
      location: 'Volketswil',
      canton: 'ZH',
      addressLocality: 'Volketswil',
      addressRegion: 'ZH',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: '8604',
      streetAddress: 'Industriestrasse 10',
      url: 'https://www.jobs.ch/en/vacancies/detail/befb0d31-c26f-417c-8888-8059d462ef72/',
      applyUrl: 'https://www.jobs.ch/en/vacancies/detail/befb0d31-c26f-417c-8888-8059d462ef72/',
      source: 'Saint-Gobain Weber/Isover Suisse Dedicated Parser (jobs.ch)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      category: 'Tecnica',
      sector: 'Edilizia / Materiali da Costruzione',
      contract: 'full-time',
      employmentType: 'FULL_TIME',
      experienceLevel: 'mid',
      featured: false,
      postedDate: '2026-07-01',
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
      expect(validJob.id).toMatch(/^saint-gobain-weber-isover-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('canton is ZH for Volketswil', () => {
      expect(validJob.canton).toBe('ZH');
    });

    it('sector is building materials', () => {
      expect(validJob.sector).toBe('Edilizia / Materiali da Costruzione');
    });
  });
});
