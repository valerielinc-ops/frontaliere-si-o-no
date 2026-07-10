import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  OMEGA_KEY,
  OMEGA_COMPANY_NAME,
  isOmegaJob,
  isTrustedDomain,
  parseListPage,
  parseDetailPage,
  parseJobLocation,
  jinaSafeUrl,
  detectCategory,
  detectExperienceLevel,
  detectContractType,
} from '../scripts/lib/omega-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const listHtml = readFileSync(path.join(FIXTURES, 'omega-swatchgroup-list.html'), 'utf8');
const detailHtml = readFileSync(path.join(FIXTURES, 'omega-swatchgroup-detail.html'), 'utf8');

describe('OMEGA SA crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(OMEGA_KEY).toBe('omega');
    expect(OMEGA_COMPANY_NAME).toBe('OMEGA SA');
  });

  // ── isCompanyJob ──
  describe('isOmegaJob', () => {
    it('matches by companyKey', () => {
      expect(isOmegaJob({ companyKey: 'omega' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isOmegaJob({ company: 'OMEGA SA' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isOmegaJob({ url: 'https://www.omegawatches.com/careers/view/258050/de' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isOmegaJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isOmegaJob(null)).toBe(false);
      expect(isOmegaJob(undefined)).toBe(false);
      expect(isOmegaJob({})).toBe(false);
    });
  });

  // ── parseListPage (Swatch Group job-finder fixture) ──
  describe('parseListPage', () => {
    it('keeps only OMEGA-brand cards and reports the total card count', () => {
      const { listings, cardCount } = parseListPage(listHtml);
      expect(cardCount).toBe(3); // 2 omega + 1 other Swatch Group brand
      expect(listings).toHaveLength(2);
    });

    it('extracts url, lang, jobId, title, teaser and domain from a card', () => {
      const { listings } = parseListPage(listHtml);
      const job = listings.find((l) => l.jobId === '32500');
      expect(job).toBeDefined();
      expect(job.url).toBe('https://www.swatchgroup.com/en/job/32500');
      expect(job.lang).toBe('en');
      expect(job.title).toBe('INTERNATIONAL CRM MANAGER (M/W)');
      expect(job.teaser).toContain('CRM roadmap');
      expect(job.domain).toBe('Sales');
    });

    it('carries the card link locale for non-English postings', () => {
      const { listings } = parseListPage(listHtml);
      const frJob = listings.find((l) => l.lang === 'fr');
      expect(frJob).toBeDefined();
      expect(frJob.url).toMatch(/^https:\/\/www\.swatchgroup\.com\/fr\/job\/\d+$/);
    });

    it('returns empty results on an empty/last pager page', () => {
      const { listings, cardCount } = parseListPage('<div class="view-content"></div>');
      expect(cardCount).toBe(0);
      expect(listings).toHaveLength(0);
    });
  });

  // ── parseDetailPage (Swatch Group job detail fixture) ──
  describe('parseDetailPage', () => {
    const detail = parseDetailPage(detailHtml);

    it('extracts the title from the f-n-title h1', () => {
      expect(detail.title).toBe('INTERNATIONAL CRM MANAGER (M/W)');
    });

    it('extracts the named sections with their localized headings', () => {
      expect(detail.sections['company-intro'].heading).toBe('The company');
      expect(detail.sections['company-intro'].text).toContain('OMEGA is a prestigious global brand');
      expect(detail.sections['body'].heading).toBe('Job description');
      expect(detail.sections['body'].text).toContain('CRM roadmap');
      expect(detail.sections['profile'].text).toContain('5-8 years');
      expect(detail.sections['prof-requ'].text).toContain('Dynamics 365');
      expect(detail.sections['languages'].text).toContain('French & English');
    });

    it('extracts the job location block preserving line structure', () => {
      expect(detail.locationText).toContain('2502 Biel/Bienne (Bern)');
      expect(detail.locationText).toContain('Jakob-Stämpfli');
      // Newlines between address lines must survive htmlToText (regression:
      // a \s-based per-line trim glued "…96" and "2502 …" together).
      const loc = parseJobLocation(detail.locationText);
      expect(loc.postalCode).toBe('2502');
      expect(loc.city).toBe('Biel/Bienne');
      expect(loc.region).toBe('Bern');
      expect(loc.street).toBe('Rue Jakob-Stämpfli - Jakob-Stämpfli-Strasse 96');
    });

    it('splits section text into lines usable as requirements', () => {
      expect(detail.sections['prof-requ'].text.split('\n').length).toBeGreaterThan(4);
    });

    it('extracts the Lumesse TalentLink apply URL with entities decoded', () => {
      expect(detail.applyUrl).toMatch(/^https:\/\/apply5\.lumessetalentlink\.com\/apply-app\//);
      expect(detail.applyUrl).toContain('&langCode=en_GB');
      expect(detail.applyUrl).not.toContain('&amp;');
    });

    it('recognizes the OMEGA brand logo', () => {
      expect(detail.isOmegaBrand).toBe(true);
    });
  });

  // ── parseJobLocation ──
  describe('parseJobLocation', () => {
    it('parses street, postal code, city and region', () => {
      const loc = parseJobLocation('Rue Jakob-Stämpfli - Jakob-Stämpfli-Strasse 96\n2502 Biel/Bienne (Bern)\nSwitzerland');
      expect(loc.street).toBe('Rue Jakob-Stämpfli - Jakob-Stämpfli-Strasse 96');
      expect(loc.postalCode).toBe('2502');
      expect(loc.city).toBe('Biel/Bienne');
      expect(loc.region).toBe('Bern');
    });

    it('handles a location without a region suffix', () => {
      const loc = parseJobLocation('Bahnhofstrasse 30a\n3920 Zermatt\nSchweiz');
      expect(loc.postalCode).toBe('3920');
      expect(loc.city).toBe('Zermatt');
      expect(loc.region).toBe('');
    });

    it('handles empty input', () => {
      const loc = parseJobLocation('');
      expect(loc).toEqual({ street: '', postalCode: '', city: '', region: '' });
    });
  });

  // ── metadata detectors ──
  describe('metadata detectors', () => {
    it('does not classify INTERNATIONAL titles as intern level', () => {
      expect(detectExperienceLevel('INTERNATIONAL CRM MANAGER (M/W)')).toBe('senior');
    });

    it('classifies real internships as intern level', () => {
      expect(detectExperienceLevel('Internship Marketing')).toBe('intern');
      expect(detectExperienceLevel('Stage en horlogerie')).toBe('intern');
    });

    it('detects temporary contracts across languages', () => {
      expect(detectContractType('CUISINIER (H/F) - TEMPORAIRE')).toBe('fixed-term');
      expect(detectContractType('Sachbearbeiter (befristet)')).toBe('fixed-term');
      expect(detectContractType('Warehouse employee', 'This is a temporary position')).toBe('fixed-term');
      expect(detectContractType('DESIGNER (H/F)')).toBe('permanent');
    });

    it('maps the portal domain hint to a category', () => {
      expect(detectCategory('INTERNATIONAL CRM MANAGER (M/W)', 'Sales')).toBe('Commerciale');
      expect(detectCategory('SPARE PARTS STOCK EMPLOYEE (H/F)', '')).toBe('Logistica');
    });
  });

  // ── jinaSafeUrl ──
  describe('jinaSafeUrl', () => {
    it('percent-encodes query delimiters so Jina cannot claim them as its own params', () => {
      expect(jinaSafeUrl('https://www.swatchgroup.com/en/job-finder?jf_country=40&page=0'))
        .toBe('https://www.swatchgroup.com/en/job-finder%3Fjf_country%3D40%26page%3D0');
    });

    it('leaves query-less URLs untouched', () => {
      expect(jinaSafeUrl('https://www.swatchgroup.com/en/job/32500'))
        .toBe('https://www.swatchgroup.com/en/job/32500');
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://omegawatches.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://www.omegawatches.com/careers/view/258050/de')).toBe(true);
    });

    it('trusts the Swatch Group job-finder domain', () => {
      expect(isTrustedDomain('https://www.swatchgroup.com/en/job/32500')).toBe(true);
    });

    it('trusts Lumesse TalentLink apply URLs', () => {
      expect(isTrustedDomain('https://apply5.lumessetalentlink.com/apply-app/pages/application-form?jobId=123')).toBe(true);
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
      expect(slugify('Developer omega ch')).toBe('developer-omega-ch');
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
      id: 'omega-abc123',
      slug: 'test-position-omega-ch',
      slugByLocale: { en: 'test-position-omega-ch' },
      company: 'OMEGA SA',
      companyKey: 'omega',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://omegawatches.com/jobs/test',
      source: 'OMEGA SA Dedicated Parser',
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
      expect(validJob.id).toMatch(/^omega-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
