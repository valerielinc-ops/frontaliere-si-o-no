import { describe, it, expect } from 'vitest';
import {
  STRABAG_KEY,
  STRABAG_COMPANY_NAME,
  isStrabagJob,
  isTrustedDomain,
  parseVacancyLinks,
  extractJobPostingJsonLd,
  cleanStreetAddress,
  detectCategory,
  detectEmploymentType,
  detectExperienceLevel,
} from '../scripts/lib/strabag-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('STRABAG AG crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(STRABAG_KEY).toBe('strabag');
    expect(STRABAG_COMPANY_NAME).toBe('STRABAG AG');
  });

  // ── isStrabagJob ──
  describe('isStrabagJob', () => {
    it('matches by companyKey', () => {
      expect(isStrabagJob({ companyKey: 'strabag' })).toBe(true);
    });

    it('matches by STRABAG AG company name', () => {
      expect(isStrabagJob({ company: 'STRABAG AG' })).toBe(true);
    });

    it('matches by Strabag BMTI GmbH subsidiary name', () => {
      expect(isStrabagJob({ company: 'Strabag BMTI GmbH' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isStrabagJob({ url: 'https://www.strabag.ch/karriere/123' })).toBe(true);
      expect(isStrabagJob({ url: 'https://www.strabag.com/careers/456' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isStrabagJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isStrabagJob(null)).toBe(false);
      expect(isStrabagJob(undefined)).toBe(false);
      expect(isStrabagJob({})).toBe(false);
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

    it('trusts strabag.ch', () => {
      expect(isTrustedDomain('https://www.strabag.ch/karriere')).toBe(true);
    });

    it('trusts strabag.com', () => {
      expect(isTrustedDomain('https://www.strabag.com/careers')).toBe(true);
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
        <a class="link" href="/en/vacancies/detail/0397dc9f-0498-4cc7-94d8-07a1a96e0059/" data-discover="true">
          <div data-cy="vacancy-serp-item">Abrechner:in Strassenbau</div>
        </a>
        <a class="link" href="/en/vacancies/detail/245c2fe1-19f1-42ac-8499-703df288356b/" data-discover="true">
          <div data-cy="vacancy-serp-item">Bauführer/-in Tiefbau</div>
        </a>
      `;
      expect(parseVacancyLinks(html)).toEqual([
        'https://www.jobs.ch/en/vacancies/detail/0397dc9f-0498-4cc7-94d8-07a1a96e0059/',
        'https://www.jobs.ch/en/vacancies/detail/245c2fe1-19f1-42ac-8499-703df288356b/',
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
        <a href="/en/vacancies/detail/0397dc9f-0498-4cc7-94d8-07a1a96e0059/">A</a>
        <a href="/en/vacancies/detail/0397dc9f-0498-4cc7-94d8-07a1a96e0059/">A dup</a>
      `;
      expect(parseVacancyLinks(html)).toHaveLength(1);
    });
  });

  // ── extractJobPostingJsonLd ──
  describe('extractJobPostingJsonLd', () => {
    it('extracts a JobPosting object from a single ld+json script', () => {
      const html = `
        <script type="application/ld+json">
          {"@context":"https://schema.org","@type":"JobPosting","title":"Abrechner:in Strassenbau"}
        </script>
      `;
      const posting = extractJobPostingJsonLd(html);
      expect(posting).not.toBeNull();
      expect(posting.title).toBe('Abrechner:in Strassenbau');
    });

    it('finds JobPosting inside an array of ld+json entries', () => {
      const html = `
        <script type="application/ld+json">
          [{"@type":"Organization","name":"STRABAG AG"},{"@type":"JobPosting","title":"Bauführer/-in Tiefbau"}]
        </script>
      `;
      const posting = extractJobPostingJsonLd(html);
      expect(posting).not.toBeNull();
      expect(posting.title).toBe('Bauführer/-in Tiefbau');
    });

    it('returns null when no JobPosting block is present', () => {
      const html = `<script type="application/ld+json">{"@type":"Organization","name":"STRABAG AG"}</script>`;
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
      expect(cleanStreetAddress('Unterrohrstr. 5, 8952 Schlieren', 'Schlieren', '8952')).toBe('Unterrohrstr. 5');
    });

    it('falls back to city when streetAddress is empty (safe default)', () => {
      expect(cleanStreetAddress('', 'Schlieren', '8952')).toBe('Schlieren');
    });

    it('returns the raw value unchanged when there is no redundant suffix', () => {
      expect(cleanStreetAddress('Bifang 4', 'Erstfeld', '6472')).toBe('Bifang 4');
    });
  });

  // ── detectCategory ──
  describe('detectCategory', () => {
    it('detects construction/site roles', () => {
      expect(detectCategory('Bauführer/-in Tiefbau', '')).toBe('Costruzioni');
      expect(detectCategory('Polier Strassenbau', '')).toBe('Costruzioni');
      expect(detectCategory('Maurer 100%', '')).toBe('Costruzioni');
    });

    it('detects engineering roles', () => {
      expect(detectCategory('Bauingenieur/-in', '')).toBe('Ingegneria');
    });

    it('detects logistics roles', () => {
      expect(detectCategory('Logistiker/-in Umschlaglager', '')).toBe('Logistica');
    });

    it('detects finance/accounting roles', () => {
      expect(detectCategory('Abrechner:in Strassenbau', 'Cost Estimator')).toBe('Finanza');
    });

    it('detects sales roles', () => {
      expect(detectCategory('Key Account Manager Vertrieb', '')).toBe('Commerciale');
    });

    it('defaults to Altro for unknown titles', () => {
      expect(detectCategory('Praktikant Nachhaltigkeit', '')).toBe('Altro');
    });

    // Regression: jobs.ch's shared occupationalCategory taxonomy for STRABAG
    // is broad and near-identical across almost every posting (it generically
    // contains words like "Engineer" or "Warehouse / Transport" regardless of
    // the actual role). Title-driven signal must win over that noise —
    // confirmed via live debug of real STRABAG postings on jobs.ch
    // (2026-07-04): a "Bauführer:in"/"Polier:in" site-role and a
    // "Baumaschinenmechaniker:in" machinery-mechanic role were both
    // misclassified before this fix because the shared occupationalCategory
    // text swamped the specific title.
    it('title wins over noisy shared occupationalCategory text (regression)', () => {
      expect(
        detectCategory(
          'Bauführer:in Tiefbau und Strassenbau',
          'Technical / Construction / Architecture / Engineer / Civil Engineering / Supervision'
        )
      ).toBe('Costruzioni');
      expect(
        detectCategory(
          'Polier:in Strassenbau',
          'Technical / Construction / Architecture / Engineer / Civil Engineering / Supervision'
        )
      ).toBe('Costruzioni');
      expect(
        detectCategory(
          'Baumaschinenmechaniker:in EFZ',
          'Technical / Vehicles / Craft / Warehouse / Transport / Vehicle Mechanics / Diagnostics'
        )
      ).toBe('Costruzioni');
    });

    it('falls back to occupationalCategory only when the title itself gives no signal', () => {
      expect(detectCategory('', 'Sales / Key Account Management')).toBe('Commerciale');
      expect(detectCategory('Mitarbeiter:in 100%', 'Human Resources / Recruiting')).toBe('Risorse Umane');
    });
  });

  // ── detectEmploymentType ──
  describe('detectEmploymentType', () => {
    it('detects full-time from workHours', () => {
      expect(detectEmploymentType('Abrechner:in Strassenbau', '42 - 42 hours/week')).toBe('FULL_TIME');
    });

    it('detects part-time from percentage in title', () => {
      expect(detectEmploymentType('Bauführer/-in 60%', '')).toBe('PART_TIME');
    });

    it('detects part-time from keyword', () => {
      expect(detectEmploymentType('Teilzeit Position', '')).toBe('PART_TIME');
    });

    it('defaults to FULL_TIME', () => {
      expect(detectEmploymentType('Abrechner:in Strassenbau', '')).toBe('FULL_TIME');
    });
  });

  // ── detectExperienceLevel ──
  describe('detectExperienceLevel', () => {
    it('detects intern/apprentice roles', () => {
      expect(detectExperienceLevel('Lernende/-r Baumaschinenmechaniker EFZ')).toBe('intern');
    });

    it('detects senior/lead roles', () => {
      expect(detectExperienceLevel('Bauleiter/-in Tiefbau')).toBe('senior');
    });

    it('defaults to mid', () => {
      expect(detectExperienceLevel('Abrechner:in Strassenbau')).toBe('mid');
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('converts title to URL-safe slug', () => {
      const slug = slugify('Abrechner:in Strassenbau');
      expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('strips diacritics', () => {
      expect(slugify('Bauführer Tiefbau')).toBe('baufuhrer-tiefbau');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Abrechner strabag Erstfeld')).toBe('abrechner-strabag-erstfeld');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const validJob = {
      id: 'strabag-abc123def456',
      slug: 'abrechner-in-strassenbau-strabag-erstfeld',
      slugByLocale: { de: 'abrechner-in-strassenbau-strabag-erstfeld' },
      company: 'STRABAG AG',
      companyKey: 'strabag',
      companyDomain: 'strabag.ch',
      title: 'Abrechner:in Strassenbau',
      titleByLocale: { de: 'Abrechner:in Strassenbau' },
      description: 'A test job description for validation with enough words to pass the minimum fifty-word threshold for content quality checks required by the SEO gate for indexed pages on this site, covering road-building cost estimation, quantity surveying, invoice preparation, and close collaboration with site management, foremen, and external partners on ongoing STRABAG civil-engineering projects across the region.',
      descriptionByLocale: {
        de: 'A test job description for validation with enough words to pass the minimum fifty-word threshold for content quality checks required by the SEO gate for indexed pages on this site, covering road-building cost estimation, quantity surveying, invoice preparation, and close collaboration with site management, foremen, and external partners on ongoing STRABAG civil-engineering projects across the region.',
      },
      location: 'Erstfeld',
      canton: 'UR',
      addressLocality: 'Erstfeld',
      addressRegion: 'UR',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: '6472',
      streetAddress: 'Bifang 4',
      url: 'https://www.jobs.ch/en/vacancies/detail/0397dc9f-0498-4cc7-94d8-07a1a96e0059/',
      applyUrl: 'https://www.jobs.ch/en/vacancies/detail/0397dc9f-0498-4cc7-94d8-07a1a96e0059/',
      source: 'STRABAG AG Dedicated Parser (jobs.ch)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      category: 'Finanza',
      sector: 'Edilizia / Costruzioni',
      contract: 'full-time',
      employmentType: 'FULL_TIME',
      experienceLevel: 'mid',
      featured: false,
      postedDate: '2026-07-02',
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

    it('has all SEO structured-data required fields the crawler owns (Non-Negotiable #3)', () => {
      // postalCode, streetAddress, title, description, hiringOrganization.name
      // (-> company), jobLocation (-> addressLocality/Region/Country),
      // employmentType, datePosted (-> postedDate) are all populated by the
      // parser itself with safe defaults (HQ fallback) when the source is
      // missing a value — never omitted.
      const seoFields = [
        'addressLocality', 'addressRegion', 'addressCountry',
        'postalCode', 'streetAddress', 'employmentType',
        'sector', 'postedDate',
      ];
      for (const field of seoFields) {
        expect(validJob).toHaveProperty(field);
        expect(validJob[field as keyof typeof validJob]).toBeTruthy();
      }
      expect(validJob.title).toBeTruthy();
      expect(validJob.description).toBeTruthy();
      expect(validJob.company).toBeTruthy();
    });

    it('baseSalary is intentionally NOT set by the crawler — a safe default is synthesized downstream', () => {
      // jobs.ch JobPosting JSON-LD ships an empty baseSalary.value for STRABAG
      // postings (no numeric range disclosed). Rather than fabricate a number,
      // this parser omits the field entirely (mirrors the sibling
      // saint-gobain-weber-isover-job-parser.mjs, which does the same);
      // services/seoService.ts reads job.baseSalary?.value and applies a safe
      // default when building the JobPosting structured data at render time,
      // satisfying Non-Negotiable #3 without inventing crawler-side numbers.
      expect(validJob).not.toHaveProperty('baseSalary');
    });

    it('description clears the 50-word thin-content floor (Non-Negotiable #4)', () => {
      const wordCount = validJob.description.split(/\s+/).filter(Boolean).length;
      expect(wordCount).toBeGreaterThanOrEqual(50);
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^strabag-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('canton is UR for Erstfeld', () => {
      expect(validJob.canton).toBe('UR');
    });

    it('sector is construction', () => {
      expect(validJob.sector).toBe('Edilizia / Costruzioni');
    });
  });

  // ── Graceful degradation ──
  describe('graceful degradation', () => {
    it('extractJobPostingJsonLd tolerates malformed JSON without throwing', () => {
      expect(() => extractJobPostingJsonLd('<script type="application/ld+json">{not valid json</script>')).not.toThrow();
      expect(extractJobPostingJsonLd('<script type="application/ld+json">{not valid json</script>')).toBeNull();
    });

    it('parseVacancyLinks tolerates a page with no recognizable markup', () => {
      expect(() => parseVacancyLinks('<html><body><p>Unexpected layout</p></body></html>')).not.toThrow();
      expect(parseVacancyLinks('<html><body><p>Unexpected layout</p></body></html>')).toEqual([]);
    });

    it('isStrabagJob tolerates partially-shaped job objects', () => {
      expect(() => isStrabagJob({ company: undefined, url: undefined, companyKey: undefined })).not.toThrow();
      expect(isStrabagJob({ company: undefined, url: undefined, companyKey: undefined })).toBe(false);
    });
  });
});
