import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  BMS_BUILDING_KEY,
  BMS_BUILDING_COMPANY_NAME,
  BMS_NAVIGATION_PREFIX_RE,
  extractBmsBuildingDetailFields,
  isBmsBuildingJob,
  isTrustedDomain,
  prepareBmsBuildingExistingJobs,
} from '../scripts/lib/bms-building-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';
import { hasStructuredContent } from '../scripts/lib/translation-quality.mjs';

const DETAIL_FIXTURE = fs.readFileSync(new URL('./fixtures/bms-building/detail.html', import.meta.url), 'utf8');

describe('BMS Building Materials crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(BMS_BUILDING_KEY).toBe('bms-building');
    expect(BMS_BUILDING_COMPANY_NAME).toBe('BMS Building Materials');
  });

  // ── isCompanyJob ──
  describe('isBmsBuildingJob', () => {
    it('matches by companyKey', () => {
      expect(isBmsBuildingJob({ companyKey: 'bms-building' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isBmsBuildingJob({ company: 'BMS Building Materials' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isBmsBuildingJob({ url: 'https://bmsuisse.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isBmsBuildingJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isBmsBuildingJob(null)).toBe(false);
      expect(isBmsBuildingJob(undefined)).toBe(false);
      expect(isBmsBuildingJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://bmsuisse.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.bmsuisse.ch/job/456')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  describe('detail extraction', () => {
    it('publishes only the announcement and keeps source lists as hyphen bullets', () => {
      const detail = extractBmsBuildingDetailFields(DETAIL_FIXTURE, 'https://jobs.bmsuisse.ch/jobs/detail/1-test/');

      expect(detail.title).toBe('Logistikfachperson 80 - 100%');
      expect(detail.description).toContain('- Wareneingänge prüfen und Material bereitstellen');
      expect(detail.description).toContain('- Erfahrung im Lager oder in der Logistik');
      expect(hasStructuredContent(detail.description)).toBe(true);
      expect(detail.description).not.toContain('Arbeiten bei BMS');
      expect(detail.description).not.toContain('site footer');
    });

    it('fails closed instead of falling back to page chrome when the container is missing', () => {
      const detail = extractBmsBuildingDetailFields(
        '<main><nav>Arbeiten bei BMS Offene Stellen</nav><p>menu only</p></main>',
        'https://jobs.bmsuisse.ch/jobs/detail/missing-body/',
      );

      expect(detail.description).toBe('');
    });
  });

  describe('stored navigation repair', () => {
    const fullMenu = '•\n\nX\n\nArbeiten bei BMS\n\nArbeiten bei BMS\n\nUnsere Werte\n\nDeine Benefits\n\nHealth & Safety\n\nJobs\n\nJobs\n\nOffene Stellen\n\nLehrstellen\n\nDE\n\nFR\n\nIT\n\nDE\n\n';

    it('requires the complete menu sequence before stripping', () => {
      expect(BMS_NAVIGATION_PREFIX_RE.test(`${fullMenu}Annuncio reale`)).toBe(true);
      expect(BMS_NAVIGATION_PREFIX_RE.test(`${fullMenu.slice(0, -8)}Annuncio reale`)).toBe(false);
    });

    it('cleans the source, drops derived locale slots, and preserves slugs', () => {
      const job: any = {
        sourceLang: 'de',
        description: `${fullMenu}Annuncio reale\n- Un compito concreto`,
        descriptionByLocale: {
          de: `${fullMenu}Annuncio reale\n- Un compito concreto`,
          it: `${fullMenu}Annuncio tradotto\n- Un compito concreto`,
          en: `${fullMenu}Translated advert\n- One concrete task`,
        },
        slug: 'stable-slug',
        slugByLocale: { de: 'stable-slug', it: 'stable-slug-it' },
      };

      prepareBmsBuildingExistingJobs([job]);

      expect(job.description.startsWith('Annuncio reale')).toBe(true);
      expect(job.descriptionByLocale).toEqual({ de: job.description });
      expect(job.needsRetranslation).toBe(true);
      expect(job.slug).toBe('stable-slug');
      expect(job.slugByLocale).toEqual({ de: 'stable-slug', it: 'stable-slug-it' });
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
      expect(slugify('Developer bms-building ch')).toBe('developer-bms-building-ch');
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
      id: 'bms-building-abc123',
      slug: 'test-position-bms-building-ch',
      slugByLocale: { de: 'test-position-bms-building-ch' },
      company: 'BMS Building Materials',
      companyKey: 'bms-building',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://bmsuisse.ch/jobs/test',
      source: 'BMS Building Materials Dedicated Parser',
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
      expect(validJob.id).toMatch(/^bms-building-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
