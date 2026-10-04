import { describe, it, expect, vi } from 'vitest';
import {
  TALLY_WEIJL_KEY,
  fetchAllTallyWeijlJobs,
  TALLY_WEIJL_COMPANY_NAME,
  isTallyWeijlJob,
  isTrustedDomain,
} from '../scripts/lib/tally-weijl-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('TALLY WEiJL crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(TALLY_WEIJL_KEY).toBe('tally-weijl');
    expect(TALLY_WEIJL_COMPANY_NAME).toBe('TALLY WEiJL');
  });

  // ── isCompanyJob ──
  describe('isTallyWeijlJob', () => {
    it('matches by companyKey', () => {
      expect(isTallyWeijlJob({ companyKey: 'tally-weijl' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isTallyWeijlJob({ company: 'TALLY WEiJL' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isTallyWeijlJob({ url: 'https://tally-weijl.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isTallyWeijlJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isTallyWeijlJob(null)).toBe(false);
      expect(isTallyWeijlJob(undefined)).toBe(false);
      expect(isTallyWeijlJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://tally-weijl.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.tally-weijl.com/job/456')).toBe(true);
    });

    it('trusts Trakstar Hire ATS domain', () => {
      expect(isTrustedDomain('https://tallyweijl.hire.trakstar.com/jobs/123/')).toBe(true);
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
      expect(slugify('Developer tally-weijl ch')).toBe('developer-tally-weijl-ch');
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
      id: 'tally-weijl-abc123',
      slug: 'test-position-tally-weijl-ch',
      slugByLocale: { en: 'test-position-tally-weijl-ch' },
      company: 'TALLY WEiJL',
      companyKey: 'tally-weijl',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://tally-weijl.com/jobs/test',
      source: 'TALLY WEiJL Dedicated Parser',
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
      expect(validJob.id).toMatch(/^tally-weijl-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});


describe('Tally publication versus application deadline', () => {
  it('keeps Apply by exclusively as validThrough and reads publication only from JobPosting', async () => {
    const deadline = new Date(Date.now() + 30 * 86400000);
    const deadlineIso = deadline.toISOString().slice(0, 10);
    const month = deadline.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
    const label = `${month}. ${deadline.getUTCDate()}, ${deadline.getUTCFullYear()}`;
    const publication = new Date(Date.now() - 4 * 86400000).toISOString();
    const listing = `<div class="js-card list-item" data-href="/jobs/fixture/"><h3 class="js-job-list-opening-name" title="Sales Assistant">Sales Assistant</h3><div class="js-job-list-opening-loc" title="Basel, Basel, Switzerland"></div><span title="Apply by: ${label}"></span></div><footer></footer>`;
    try {
      for (const datePosted of [publication, '']) {
        vi.stubGlobal('fetch', vi.fn(async (url) => new Response(String(url).includes('?country=')
          ? (String(url).includes('Switzerland') ? listing : '<footer></footer>')
          : `<div class="jobdesciption">${'Source vacancy responsibilities and experience. '.repeat(15)}</div><section></section><script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', datePosted })}</script>`)));
        const [job] = await fetchAllTallyWeijlJobs();
        expect(job).toMatchObject({ validThrough: deadlineIso, datePosted, postedDate: datePosted, postingDateSource: datePosted ? 'reported' : 'unknown' });
      }
    } finally { vi.unstubAllGlobals(); }
  });
});
