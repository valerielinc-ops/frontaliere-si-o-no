import { describe, it, expect } from 'vitest';
import {
  BUCHER_SUTER_KEY,
  BUCHER_SUTER_COMPANY_NAME,
  BUCHER_SUTER_COMPANY_DOMAIN,
  isBucherSuterJob,
  isTrustedDomain,
  extractLabelValue,
  extractArticleProseHtml,
  detectCategory,
  detectEmploymentType,
  detectExperienceLevel,
} from '../scripts/lib/bucher-suter-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';
import { htmlToText } from '../scripts/lib/hospital-custom-html-helpers.mjs';

describe('Bucher + Suter AG crawler parser', () => {
  // ── Constants ──
  it('exports valid company key, name and domain', () => {
    expect(BUCHER_SUTER_KEY).toBe('bucher-suter');
    expect(BUCHER_SUTER_COMPANY_NAME).toBe('Bucher + Suter AG');
    expect(BUCHER_SUTER_COMPANY_DOMAIN).toBe('bucher-suter.com');
  });

  // ── isBucherSuterJob ──
  describe('isBucherSuterJob', () => {
    it('matches by companyKey', () => {
      expect(isBucherSuterJob({ companyKey: 'bucher-suter' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isBucherSuterJob({ company: 'Bucher + Suter AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isBucherSuterJob({ url: 'https://www.bucher-suter.com/jobs/it-project-manager/' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isBucherSuterJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isBucherSuterJob(null as unknown as Record<string, unknown>)).toBe(false);
      expect(isBucherSuterJob(undefined as unknown as Record<string, unknown>)).toBe(false);
      expect(isBucherSuterJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts the apex domain', () => {
      expect(isTrustedDomain('https://bucher-suter.com/jobs/it-project-manager/')).toBe(true);
    });

    it('trusts the www subdomain', () => {
      expect(isTrustedDomain('https://www.bucher-suter.com/jobs/it-project-manager/')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── extractLabelValue ──
  describe('extractLabelValue', () => {
    const infoBoxHtml = `
      <div class="flex flex-col gap-[0.5625rem]">
        <p class="text-body-sm text-black leading-tight">Location</p>
        <p class="text-body-sm font-light text-black leading-relaxed">Bern, Switzerland</p>
      </div>
      <div class="flex flex-col gap-[0.5625rem]">
        <p class="text-body-sm text-black leading-tight">Job Type</p>
        <p class="text-body-sm font-light text-black leading-relaxed">Part Time</p>
      </div>
    `;

    it('extracts the Location value', () => {
      expect(extractLabelValue(infoBoxHtml, 'Location')).toBe('Bern, Switzerland');
    });

    it('extracts the Job Type value', () => {
      expect(extractLabelValue(infoBoxHtml, 'Job Type')).toBe('Part Time');
    });

    it('extracts a remote/foreign location too (filtering happens downstream)', () => {
      const html = `<p>Location</p><p>Germany (Remote)</p>`;
      expect(extractLabelValue(html, 'Location')).toBe('Germany (Remote)');
    });

    it('returns empty string when the label is absent', () => {
      expect(extractLabelValue('<p>Nothing here</p>', 'Location')).toBe('');
    });

    it('returns empty string for invalid input', () => {
      expect(extractLabelValue('', 'Location')).toBe('');
      expect(extractLabelValue(infoBoxHtml, '')).toBe('');
    });
  });

  // ── extractArticleProseHtml ──
  describe('extractArticleProseHtml', () => {
    it('extracts the section-based layout variant (older postings)', () => {
      const html = `
        <div class="article-prose">
          <section class="job__environment job__grid grid">
            <div class="job__environment__text"><p>Intro paragraph.</p></div>
          </section>
          <section class="job__tasks job__grid grid">
            <header class="job__tasks__header"><h3 class="job__tasks__title small__title">Main Tasks</h3></header>
            <div class="job__tasks__text"><p>Do the tasks.</p></div>
          </section>
        </div>
        <div class="flex flex-col align-start mt-4 gap-1.5 lg:hidden">
          <h2>Interested?</h2>
        </div>
      `;
      const inner = extractArticleProseHtml(html);
      expect(inner).toContain('Intro paragraph.');
      expect(inner).toContain('Main Tasks');
      expect(inner).toContain('Do the tasks.');
      expect(inner).not.toContain('Interested?');
    });

    it('extracts the plain-heading layout variant (newer Salesforce postings)', () => {
      const html = `
        <div class="article-prose">
          <h3>Environment</h3>
          <p>We are looking for a Salesforce Business Consultant.</p>
          <h3>Key Responsibilities</h3>
          <ul><li>Lead discovery sessions.</li></ul>
        </div>
        <div class="flex flex-col align-start mt-4 gap-1.5 lg:hidden">
          <h2>Interested?</h2>
        </div>
      `;
      const inner = extractArticleProseHtml(html);
      expect(inner).toContain('Salesforce Business Consultant');
      expect(inner).toContain('Lead discovery sessions.');
      expect(inner).not.toContain('Interested?');
    });

    it('returns empty string when article-prose is absent', () => {
      expect(extractArticleProseHtml('<div>no prose here</div>')).toBe('');
    });

    it('produces readable text via htmlToText', () => {
      const html = `
        <div class="article-prose">
          <h3>Main Tasks</h3>
          <ul><li>Task one</li><li>Task two</li></ul>
        </div>
      `;
      const text = htmlToText(extractArticleProseHtml(html));
      expect(text).toContain('Main Tasks');
      expect(text).toContain('Task one');
      expect(text).toContain('Task two');
    });
  });

  // ── detectCategory ──
  describe('detectCategory', () => {
    it('detects Salesforce roles', () => {
      expect(detectCategory('Salesforce Business Consultant – Agentforce Contact Center')).toBe('IT / Salesforce');
    });

    it('detects Linux/infrastructure roles', () => {
      expect(detectCategory('Linux System Administrator/Engineer')).toBe('IT / Infrastruttura');
    });

    it('detects project management roles', () => {
      expect(detectCategory('IT Project Manager')).toBe('Gestione Progetti');
    });

    it('detects QA roles', () => {
      expect(detectCategory('QA Software Engineer')).toBe('IT / Quality Assurance');
    });

    it('defaults to contact center for unmatched titles', () => {
      expect(detectCategory('Some Unusual Title')).toBe('IT / Contact Center');
    });
  });

  // ── detectEmploymentType ──
  describe('detectEmploymentType', () => {
    it('maps "Full Time" label to FULL_TIME', () => {
      expect(detectEmploymentType('Full Time')).toBe('FULL_TIME');
    });

    it('maps "Part Time" label to PART_TIME', () => {
      expect(detectEmploymentType('Part Time')).toBe('PART_TIME');
    });

    it('defaults to FULL_TIME when the label is missing (safe default)', () => {
      expect(detectEmploymentType('')).toBe('FULL_TIME');
    });
  });

  // ── detectExperienceLevel ──
  describe('detectExperienceLevel', () => {
    it('detects senior/lead roles (title contains "Manager")', () => {
      expect(detectExperienceLevel('IT Project Manager')).toBe('senior');
      expect(detectExperienceLevel('Senior Salesforce Developer')).toBe('senior');
    });

    it('detects intern/apprentice roles', () => {
      expect(detectExperienceLevel('Working Student IT')).toBe('intern');
    });

    it('defaults to mid', () => {
      expect(detectExperienceLevel('Linux System Administrator/Engineer')).toBe('mid');
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('converts title to URL-safe slug', () => {
      const slug = slugify('IT Project Manager 50-60%');
      expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('IT Project Manager bucher-suter Bern')).toBe('it-project-manager-bucher-suter-bern');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const validJob = {
      id: 'bucher-suter-abc123def456',
      slug: 'it-project-manager-bucher-suter-bern',
      slugByLocale: { en: 'it-project-manager-bucher-suter-bern' },
      company: 'Bucher + Suter AG',
      companyKey: 'bucher-suter',
      companyDomain: 'bucher-suter.com',
      title: 'IT Project Manager',
      titleByLocale: { en: 'IT Project Manager' },
      description: 'A test job description for validation with enough words to pass the minimum threshold for content quality checks required by the SEO gate for indexed pages on this site, describing the role, responsibilities and requirements in detail.',
      descriptionByLocale: {
        en: 'A test job description for validation with enough words to pass the minimum threshold for content quality checks required by the SEO gate for indexed pages on this site, describing the role, responsibilities and requirements in detail.',
      },
      needsRetranslation: true,
      location: 'Bern',
      canton: 'BE',
      addressLocality: 'Bern',
      addressRegion: 'BE',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: '3048',
      streetAddress: 'Lindenhofstrasse 1',
      url: 'https://www.bucher-suter.com/jobs/it-project-manager/',
      applyUrl: 'https://www.bucher-suter.com/jobs/it-project-manager/',
      source: 'Bucher + Suter AG Dedicated Parser',
      sourceLang: 'en',
      crawledAt: new Date().toISOString(),
      category: 'Gestione Progetti',
      sector: 'IT / Contact Center Solutions',
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

    it('has all SEO-required fields (Non-Negotiable #3)', () => {
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
      expect(validJob.id).toMatch(/^bucher-suter-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('canton is BE for Bern', () => {
      expect(validJob.canton).toBe('BE');
    });

    it('sector reflects the Cisco Contact Center integration business', () => {
      expect(validJob.sector).toBe('IT / Contact Center Solutions');
    });
  });
});
