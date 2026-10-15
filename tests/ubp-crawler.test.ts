import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  UBP_KEY,
  UBP_COMPANY_NAME,
  UBP_CAREERS_URL,
  isUbpJob,
  isTrustedDomain,
  fetchAllUbpJobs,
} from '../scripts/lib/ubp-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Union Bancaire Privée crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(UBP_KEY).toBe('ubp');
    expect(UBP_COMPANY_NAME).toBe('Union Bancaire Privée');
  });

  // ── isCompanyJob ──
  describe('isUbpJob', () => {
    it('matches by companyKey', () => {
      expect(isUbpJob({ companyKey: 'ubp' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isUbpJob({ company: 'Union Bancaire Privée' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isUbpJob({ url: 'https://ubp.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isUbpJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isUbpJob(null)).toBe(false);
      expect(isUbpJob(undefined)).toBe(false);
      expect(isUbpJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://ubp.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.ubp.com/job/456')).toBe(true);
    });

    it('keeps the application fallback on the employer domain', () => {
      expect(UBP_CAREERS_URL).toBe('https://www.ubp.com/en/about-us/careers/experienced-professionals');
      expect(isTrustedDomain(UBP_CAREERS_URL)).toBe(true);
      expect(UBP_CAREERS_URL).not.toContain('oraclecloud');
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
      expect(slugify('Developer ubp ch')).toBe('developer-ubp-ch');
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
      id: 'ubp-abc123',
      slug: 'test-position-ubp-ch',
      slugByLocale: { en: 'test-position-ubp-ch' },
      company: 'Union Bancaire Privée',
      companyKey: 'ubp',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://ubp.com/jobs/test',
      source: 'Union Bancaire Privée Dedicated Parser',
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
      expect(validJob.id).toMatch(/^ubp-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});

// Issue 5253: a requisition without a detail body was published with its
// ShortDescriptionStr at any length, or else with "Position at Union Bancaire
// Privée … one of Switzerland's leading private banks". Only the source's
// text above the 50-word floor is published; below it the job stays out of
// the run (the standard pipeline keeps the stored source body under its miss
// grace).
// Fixtures are minimised Oracle HCM REST payloads; no `data/**` is read.
describe('fetchAllUbpJobs — only a source body above the floor is published', () => {
  const SOURCE_WORDS = ('We are looking for an experienced Relationship Manager to join our private banking team in Lugano and develop a portfolio of '
    + 'Italian and Swiss clients. You will advise high net worth individuals on investment solutions, grow assets under management, '
    + 'work closely with portfolio managers and specialists, and ensure full compliance with regulatory requirements. You have at least '
    + 'ten years of experience in private banking, an established client network and excellent knowledge of Italian and English.').split(' ');
  const text = (n: number) => SOURCE_WORDS.slice(0, n).join(' ');
  function stubOracle({ external, short }: { external: string | null; short: string }) {
    vi.stubGlobal('fetch', async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/recruitingCEJobRequisitionDetails/')) {
        return new Response(JSON.stringify({ ExternalDescriptionStr: external === null ? '' : `<p>${external}</p>` }), { status: 200 });
      }
      if (url.includes('/recruitingCEJobRequisitions?')) {
        return new Response(JSON.stringify({ items: [{ TotalJobsCount: 1, requisitionList: [{
          Id: '4242', Title: 'Relationship Manager', PrimaryLocation: 'Lugano, Ticino, Switzerland', PrimaryLocationCountry: 'CH', ShortDescriptionStr: short,
        }] }] }), { status: 200 });
      }
      return new Response('', { status: 404 });
    });
    return fetchAllUbpJobs();
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('publishes the detail body under its own language', async () => {
    const [job] = await stubOracle({ external: text(SOURCE_WORDS.length), short: '' });
    expect(job.sourceLang).toBe('en');
    expect(job.description).toContain(SOURCE_WORDS.slice(0, 6).join(' '));
  });

  it('publishes a ShortDescriptionStr only when it clears the floor', async () => {
    const [job] = await stubOracle({ external: null, short: text(50) });
    expect(job.description.split(/\s+/)).toHaveLength(50);
    expect(await stubOracle({ external: null, short: text(12) })).toEqual([]);
  });

  it('does not publish a requisition without a body, and invents no description', async () => {
    const jobs = await stubOracle({ external: null, short: '' });
    expect(jobs).toEqual([]);
    expect(JSON.stringify(jobs)).not.toMatch(/leading private banks|Position at Union Bancaire Privée/);
  });

  it('publishes a 50-word detail body and not a 49-word one', async () => {
    expect(await stubOracle({ external: text(49), short: '' })).toEqual([]);
    const [job] = await stubOracle({ external: text(50), short: '' });
    expect(job.description.split(/\s+/)).toHaveLength(50);
  });
});
