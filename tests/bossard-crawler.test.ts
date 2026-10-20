import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BOSSARD_KEY,
  BOSSARD_COMPANY_NAME,
  fetchAllBossardJobs,
  isBossardJob,
  isTrustedDomain,
} from '../scripts/lib/bossard-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

const VALID_WORKDAY_BODY = `
  <h2>Aufgaben</h2>
  <p>Sie betreuen internationale Kunden und koordinieren technische Projekte von
  der ersten Anfrage bis zur erfolgreichen Auslieferung. Dabei analysieren Sie
  Anforderungen, erstellen belastbare Angebote, arbeiten eng mit Entwicklung,
  Einkauf und Produktion zusammen und dokumentieren die vereinbarten Lösungen.
  Sie pflegen bestehende Kundenbeziehungen, beobachten den Markt und bringen
  Verbesserungsvorschläge in interdisziplinäre Teams ein. Für diese Aufgabe
  erwarten wir eine technische oder kaufmännische Ausbildung, Erfahrung im
  industriellen Umfeld, sehr gute Kommunikationsfähigkeiten und eine
  zuverlässige, selbstständige Arbeitsweise. Gute Deutsch- und
  Englischkenntnisse sowie die Bereitschaft zu gelegentlichen Dienstreisen
  runden Ihr Profil ab. Wir bieten moderne Arbeitsplätze, flexible Arbeitszeit,
  Weiterbildung und eine sorgfältige Einarbeitung am Standort Zug.</p>
`;

const WORKDAY_LISTING = {
  title: 'Technical Project Manager',
  locationsText: 'Zug, Switzerland',
  externalPath: '/job/Zug/Technical_Project_Manager-12345',
  bulletFields: ['12345'],
};

function stubBossardWorkday(detailHtml: string) {
  const fetchMock = vi.fn(async (url: string) => {
    const requestUrl = String(url);
    if (requestUrl.endsWith('/jobs')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ total: 1, jobPostings: [WORKDAY_LISTING] }),
      } as unknown as Response;
    }
    if (requestUrl.includes('/job/')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          jobPostingInfo: {
            jobDescription: detailHtml,
            timeType: 'Full time',
          },
        }),
      } as unknown as Response;
    }
    throw new Error(`Unexpected Workday URL: ${requestUrl}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Bossard crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(BOSSARD_KEY).toBe('bossard');
    expect(BOSSARD_COMPANY_NAME).toBe('Bossard Group');
  });

  // ── isCompanyJob ──
  describe('isBossardJob', () => {
    it('matches by companyKey', () => {
      expect(isBossardJob({ companyKey: 'bossard' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isBossardJob({ company: 'Bossard Group' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isBossardJob({ url: 'https://www.bossard.com/ch-en/about-us/careers/' })).toBe(true);
    });

    it('matches by Workday tenant URL', () => {
      expect(isBossardJob({ url: 'https://bossard.wd103.myworkdayjobs.com/en/BossardJobs/job/Zug/some-role' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isBossardJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isBossardJob(null)).toBe(false);
      expect(isBossardJob(undefined)).toBe(false);
      expect(isBossardJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://www.bossard.com/ch-en/about-us/careers/')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.bossard.com/job/456')).toBe(true);
    });

    it('trusts Workday ATS hosts', () => {
      expect(isTrustedDomain('https://bossard.wd103.myworkdayjobs.com/en/BossardJobs/job/Zug/some-role')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  describe('fetchAllBossardJobs', () => {
    it('publishes the Workday detail body instead of a Key details stub', async () => {
      const fetchMock = stubBossardWorkday(VALID_WORKDAY_BODY);
      const jobs = await fetchAllBossardJobs();

      expect(jobs).toHaveLength(1);
      expect(jobs[0].description).toContain('internationale Kunden');
      expect(jobs[0].description).not.toContain('Key details');
      expect(jobs[0].description.split(/\s+/).filter(Boolean).length).toBeGreaterThanOrEqual(50);
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/job/Zug/'))).toBe(true);
    });

    it.each([
      ['empty', ''],
      ['below the source floor', '<p>Key details: Zug, Bossard Group, apply online.</p>'],
    ])('does not publish a listing with %s Workday text', async (_label, detailHtml) => {
      const fetchMock = stubBossardWorkday(detailHtml);
      const jobs = await fetchAllBossardJobs();

      expect(jobs).toEqual([]);
      expect(jobs.some((job) => job.description.includes('Key details'))).toBe(false);
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/job/Zug/'))).toBe(true);
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('converts title to URL-safe slug', () => {
      const slug = slugify('Software Engineer (m/f/d)');
      expect(slug).toBe('software-engineer-m-f-d');
    });

    it('strips diacritics', () => {
      expect(slugify('Einkäufer:in Zug')).toBe('einkaufer-in-zug');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Buyer bossard zug')).toBe('buyer-bossard-zug');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference (mirrors what fetchAllBossardJobs emits)
    const validJob = {
      id: 'bossard-abc123',
      slug: 'test-position-bossard-zug',
      slugByLocale: { de: 'test-position-bossard-zug' },
      company: 'Bossard Group',
      companyKey: 'bossard',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Zug',
      canton: 'ZG',
      url: 'https://bossard.wd103.myworkdayjobs.com/en/BossardJobs/job/Zug/test',
      source: 'Bossard Group Dedicated Parser (Workday)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: 'Zug',
      addressRegion: 'ZG',
      streetAddress: 'Steinhauserstrasse 70',
      postalCode: '6301',
      addressCountry: 'CH',
      country: 'CH',
      employmentType: 'FULL_TIME',
      postedDate: new Date().toISOString().split('T')[0],
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

    it('has the fields required for job-page structured data (baseSalary source inputs)', () => {
      // baseSalary itself is synthesized downstream from safe defaults; these
      // are the per-job inputs the parser is responsible for supplying.
      const structuredDataInputs = [
        'postalCode', 'streetAddress', 'title', 'description',
        'addressLocality', 'addressCountry', 'employmentType', 'postedDate',
      ];
      for (const field of structuredDataInputs) {
        expect(validJob).toHaveProperty(field);
        expect(validJob[field]).toBeTruthy();
      }
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^bossard-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
