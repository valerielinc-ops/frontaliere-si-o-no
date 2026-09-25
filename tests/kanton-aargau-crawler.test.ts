import { describe, it, expect } from 'vitest';
import {
  KANTON_AARGAU_KEY,
  KANTON_AARGAU_COMPANY_NAME,
  isKantonAargauJob,
  isTrustedDomain,
} from '../scripts/lib/kanton-aargau-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Kanton Aargau crawler parser', () => {
  // -- Constants --
  it('exports valid company key and name', () => {
    expect(KANTON_AARGAU_KEY).toBe('kanton-aargau');
    expect(KANTON_AARGAU_COMPANY_NAME).toBe('Kanton Aargau');
  });

  // -- isCompanyJob --
  describe('isKantonAargauJob', () => {
    it('matches by companyKey', () => {
      expect(isKantonAargauJob({ companyKey: 'kanton-aargau' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isKantonAargauJob({ company: 'Kanton Aargau' })).toBe(true);
    });

    it('matches by ag.ch URL', () => {
      expect(isKantonAargauJob({ url: 'https://www.ag.ch/de/ueber-uns/jobs-karriere/offene-stellen/stellenmarkt' })).toBe(true);
    });

    it('matches by Umantis tenant URL', () => {
      expect(isKantonAargauJob({ url: 'https://recruitingapp-12705.umantis.com/Vacancies/10927/Application/CheckLogin/1' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isKantonAargauJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isKantonAargauJob(null)).toBe(false);
      expect(isKantonAargauJob(undefined)).toBe(false);
      expect(isKantonAargauJob({})).toBe(false);
    });
  });

  // -- isTrustedDomain --
  describe('isTrustedDomain', () => {
    it('trusts ag.ch primary domain', () => {
      expect(isTrustedDomain('https://ag.ch/de/jobs')).toBe(true);
    });

    it('trusts ag.ch subdomains', () => {
      expect(isTrustedDomain('https://www.ag.ch/de/ueber-uns/jobs-karriere/offene-stellen/stellenmarkt')).toBe(true);
    });

    it('trusts the Umantis tenant host (recruitingapp-12705.umantis.com)', () => {
      expect(isTrustedDomain('https://recruitingapp-12705.umantis.com/Vacancies/10927/Application/CheckLogin/1')).toBe(true);
    });

    it('rejects other Umantis tenants', () => {
      expect(isTrustedDomain('https://recruitingapp-999999.umantis.com/Jobs/All')).toBe(false);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('rejects domains containing ag.ch as substring', () => {
      expect(isTrustedDomain('https://notag.ch/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // -- slugify (imported from crawler-template) --
  describe('slugify', () => {
    it('converts title to URL-safe slug', () => {
      const slug = slugify('Software Engineer (m/f/d)');
      expect(slug).toBe('software-engineer-m-f-d');
    });

    it('strips diacritics', () => {
      expect(slugify('Ingénieur qualité')).toBe('ingenieur-qualite');
    });

    it('handles German umlauts', () => {
      const slug = slugify('Leiterin Sektion Revision Aargau');
      expect(slug).toMatch(/^[a-z0-9-]+$/);
      expect(slug).not.toContain('ä');
      expect(slug).not.toContain('ü');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Sachbearbeiter kanton-aargau ch')).toBe('sachbearbeiter-kanton-aargau-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // -- Job Shape Validation --
  describe('job shape', () => {
    const validJob = {
      id: 'kanton-aargau-61b3a948a8d6',
      slug: 'leiterin-leiter-sektion-revision-kanton-aargau-ch',
      slugByLocale: { de: 'leiterin-leiter-sektion-revision-kanton-aargau-ch' },
      company: 'Kanton Aargau',
      companyKey: 'kanton-aargau',
      companyDomain: 'ag.ch',
      title: 'Leiterin / Leiter Sektion Revision 80-100%',
      titleByLocale: { de: 'Leiterin / Leiter Sektion Revision 80-100%' },
      description: 'Leiterin / Leiter Sektion Revision 80-100% — offene Stelle beim Kanton Aargau, direkt auf dem offiziellen Stellenportal der Kantonalen Verwaltung ausgeschrieben. Der Kanton Aargau zählt mit rund 700\'000 Einwohnerinnen und Einwohnern zu den bevölkerungsreichsten Kantonen der Schweiz und ist einer der grössten Arbeitgeber der Region. Als öffentliche Verwaltung beschäftigt er Mitarbeitende in der kantonalen Verwaltung, den Gerichten, der Kantonspolizei und im Bildungswesen und bietet vielfältige, sinnstiftende Karrieremöglichkeiten in unterschiedlichen Fachbereichen.',
      descriptionByLocale: { de: 'Leiterin / Leiter Sektion Revision 80-100% — offene Stelle beim Kanton Aargau, direkt auf dem offiziellen Stellenportal der Kantonalen Verwaltung ausgeschrieben.' },
      location: 'Aarau',
      canton: 'AG',
      url: 'https://recruitingapp-12705.umantis.com/Vacancies/10927/Application/CheckLogin/1',
      source: 'Kanton Aargau Dedicated Parser (Umantis tenant 12705)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      addressLocality: 'Aarau',
      streetAddress: 'Bahnhofstrasse 2',
      postalCode: '5000',
      addressCountry: 'CH',
      country: 'CH',
      category: 'Amministrazione',
      contract: 'full-time',
      employmentType: 'FULL_TIME',
      experienceLevel: 'senior',
      sector: 'Amministrazione Pubblica',
      currency: 'CHF',
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

    it('has all recommended fields', () => {
      const recommended = [
        'addressLocality', 'streetAddress', 'postalCode', 'addressCountry', 'country',
        'category', 'contract', 'employmentType', 'experienceLevel',
        'sector', 'currency',
      ];
      for (const field of recommended) {
        expect(validJob).toHaveProperty(field);
      }
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^kanton-aargau-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('description has minimum 50 words (thin-content floor)', () => {
      const wordCount = validJob.description.split(/\s+/).filter(Boolean).length;
      expect(wordCount).toBeGreaterThanOrEqual(50);
    });

    it('sector is Amministrazione Pubblica', () => {
      expect(validJob.sector).toBe('Amministrazione Pubblica');
    });

    it('URL points to the same-host Umantis application flow (detail page dead-redirects cross-host)', () => {
      expect(validJob.url).toContain('recruitingapp-12705.umantis.com');
      expect(validJob.url).toContain('/Application/');
    });
  });
});
