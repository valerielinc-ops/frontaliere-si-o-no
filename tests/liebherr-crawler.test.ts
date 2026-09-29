import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  LIEBHERR_KEY,
  LIEBHERR_COMPANY_NAME,
  isLiebherrJob,
  isTrustedDomain,
  fetchAllLiebherrJobs,
} from '../scripts/lib/liebherr-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Liebherr crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(LIEBHERR_KEY).toBe('liebherr');
    expect(LIEBHERR_COMPANY_NAME).toBe('Liebherr');
  });

  // ── isCompanyJob ──
  describe('isLiebherrJob', () => {
    it('matches by companyKey', () => {
      expect(isLiebherrJob({ companyKey: 'liebherr' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isLiebherrJob({ company: 'Liebherr' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isLiebherrJob({ url: 'https://liebherr.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isLiebherrJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isLiebherrJob(null)).toBe(false);
      expect(isLiebherrJob(undefined)).toBe(false);
      expect(isLiebherrJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://liebherr.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.liebherr.com/job/456')).toBe(true);
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
      expect(slugify('Developer liebherr ch')).toBe('developer-liebherr-ch');
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
      id: 'liebherr-abc123',
      slug: 'test-position-liebherr-ch',
      slugByLocale: { de: 'test-position-liebherr-ch' },
      company: 'Liebherr',
      companyKey: 'liebherr',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://liebherr.com/jobs/test',
      source: 'Liebherr Dedicated Parser',
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
      expect(validJob.id).toMatch(/^liebherr-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});

// Only the posting's own text is published (issue 5253): without a readable
// detail body a listing used to go out as "{title} — Liebherr ({city}, CH)".
// Shapes of careers.liebherr.com (jobs2web tiles, itemprop="description").
describe('fetchAllLiebherrJobs — listing without a vacancy body', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('publishes the listing with a body and skips the one without, never inventing text', async () => {
    const tile = (id: string, title: string) => `<li class="job-tile job-id-${id} job-row" data-url="/job/Bulle-${id}/${id}/">`
      + `<a class="jobTitle-link" href="/job/Bulle-${id}/${id}/">${title}</a><div id="job-${id}-desktop-section-location-value">Bulle, CH</div></li>`;
    const listing = `<ul>${tile('1438000001', 'Polymechaniker EFZ')}${tile('1438000002', 'Einkäufer')}</ul>`;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/search/')) return new Response(u.includes('startrow=') ? '<ul></ul>' : listing, { status: 200 });
      if (u.includes('1438000001')) {
        return new Response('<html><body><span itemprop="description"><p>Sie fertigen Präzisionsteile für unsere Baumaschinen und betreuen die CNC-Anlagen.</p></span></body></html>', { status: 200 });
      }
      return new Response('<html><body><h1>Einkäufer</h1></body></html>', { status: 200 });
    }));

    const jobs = await fetchAllLiebherrJobs();
    expect(jobs.map((job) => job.title)).toEqual(['Polymechaniker EFZ']);
    expect(jobs[0].description).toContain('Präzisionsteile');
    for (const job of jobs) expect(job.description).not.toMatch(/— Liebherr \(/);
  }, 20_000);
});
