import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SYGNUM_KEY,
  SYGNUM_COMPANY_NAME,
  isSygnumJob,
  isTrustedDomain,
  fetchAllSygnumJobs,
} from '../scripts/lib/sygnum-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

const PORTAL_HOST = 'sygnumpeopleportal.my.salesforce-sites.com';
const LISTING_URL = `https://${PORTAL_HOST}/recruit`;
const DETAIL_URL = (vn: string) => `https://${PORTAL_HOST}/recruit/fRecruit__ApplyJob?vacancyNo=${vn}`;

function listingHtml(rows: Array<{ vacancyNo: string; title: string }>) {
  const links = rows
    .map((r) => `<a href="/recruit/fRecruit__ApplyJob?vacancyNo=${r.vacancyNo}">${r.title}</a>`)
    .join('\n');
  // No "Next" link → single page, pagination loop stops immediately.
  return `<html><body>${links}</body></html>`;
}

function detailHtml({
  title,
  locality,
  country,
  postalCode = '',
  employmentType = 'Permanent',
  datePosted = '2026-06-01',
  aboutRole = 'This is a hands-on role covering a wide range of technical and business responsibilities across the platform, working closely with engineering and product teams to deliver outcomes.',
  idealCandidate = 'You have several years of relevant experience, strong communication skills, and a track record of delivering complex projects in a regulated financial environment.',
}: {
  title: string;
  locality: string;
  country: string;
  postalCode?: string;
  employmentType?: string;
  datePosted?: string;
  aboutRole?: string;
  idealCandidate?: string;
}) {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title,
    datePosted,
    employmentType,
    jobLocation: {
      '@type': 'Place',
      address: {
        '@type': 'PostalAddress',
        addressLocality: locality,
        addressCountry: country,
        postalCode,
      },
    },
  };

  return `<html><body>
    <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
    <table>
      <tr><th class="labelCol"><label>Posting Title</label></th><td class="data2Col">${title}</td></tr>
      <tr><th class="labelCol"><label>Country</label></th><td class="data2Col">${country}</td></tr>
      <tr><th class="labelCol"><label>Location City</label></th><td class="data2Col">${locality}</td></tr>
      <tr><th class="labelCol"><label>About Sygnum</label></th><td class="data2Col">Sygnum is a global digital asset banking group.</td></tr>
      <tr><th class="labelCol"><label>About the role</label></th><td class="data2Col">${aboutRole}</td></tr>
      <tr><th class="labelCol"><label>Our ideal candidate</label></th><td class="data2Col">${idealCandidate}</td></tr>
      <tr><th class="labelCol"><label>Our Values</label></th><td class="data2Col">SYGN values boilerplate.</td></tr>
      <tr><th class="labelCol"><label>Employment Type</label></th><td class="data2Col">${employmentType}</td></tr>
      <tr><th class="labelCol"><label>Duration</label></th><td class="data2Col"></td></tr>
      <tr><th class="labelCol"><label>Working arrangement</label></th><td class="data2Col">Partial Home Office</td></tr>
    </table>
  </body></html>`;
}

function mockResponse(body: string, headers: Record<string, string> = {}) {
  const h = new Map(Object.entries(headers));
  return {
    ok: true,
    status: 200,
    text: async () => body,
    headers: { get: (k: string) => h.get(k) || h.get(k.toLowerCase()) || null },
  };
}

describe('Sygnum crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(SYGNUM_KEY).toBe('sygnum');
    expect(SYGNUM_COMPANY_NAME).toBe('Sygnum Bank');
  });

  // ── isCompanyJob ──
  describe('isSygnumJob', () => {
    it('matches by companyKey', () => {
      expect(isSygnumJob({ companyKey: 'sygnum' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isSygnumJob({ company: 'Sygnum Bank' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isSygnumJob({ url: 'https://www.sygnum.com/working-at-sygnum-careers/' })).toBe(true);
    });

    it('matches by Salesforce fRecruit portal URL', () => {
      expect(isSygnumJob({ url: `${DETAIL_URL('VN123')}` })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isSygnumJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isSygnumJob(null)).toBe(false);
      expect(isSygnumJob(undefined)).toBe(false);
      expect(isSygnumJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://www.sygnum.com/working-at-sygnum-careers/')).toBe(true);
    });

    it('trusts Salesforce fRecruit portal domain', () => {
      expect(isTrustedDomain(DETAIL_URL('VN123'))).toBe(true);
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
      const slug = slugify('Software Engineer (Zurich)');
      expect(slug).toBe('software-engineer-zurich');
    });

    it('strips diacritics', () => {
      expect(slugify('Ingénieur qualité')).toBe('ingenieur-qualite');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Software Engineer sygnum zurich')).toBe('software-engineer-sygnum-zurich');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── fetchAllSygnumJobs (network mocked) ──
  describe('fetchAllSygnumJobs', () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      fetchSpy = vi.spyOn(global, 'fetch' as any);
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it('parses a successful feed into well-formed ParsedJob objects', async () => {
      fetchSpy.mockImplementation(async (url: any) => {
        const u = String(url);
        if (u === LISTING_URL) {
          return mockResponse(listingHtml([{ vacancyNo: 'VN001', title: 'Senior Software Engineer, AI' }])) as any;
        }
        if (u === DETAIL_URL('VN001')) {
          return mockResponse(
            detailHtml({ title: 'Senior Software Engineer, AI', locality: 'Zurich', country: 'Switzerland', postalCode: '8045' }),
          ) as any;
        }
        throw new Error(`Unexpected fetch: ${u}`);
      });

      const jobs = await fetchAllSygnumJobs();
      expect(jobs).toHaveLength(1);

      const job = jobs[0];
      expect(job.id).toMatch(/^sygnum-/);
      expect(job.companyKey).toBe('sygnum');
      expect(job.company).toBe('Sygnum Bank');
      expect(job.title).toBe('Senior Software Engineer, AI');
      expect(job.canton).toBe('ZH');
      expect(job.addressCountry).toBe('CH');
      expect(job.country).toBe('CH');
      expect(job.url).toBe(DETAIL_URL('VN001'));
      expect(job.employmentType).toBe('FULL_TIME');
      expect(job.postedDate).toBe('2026-06-01');
      expect(job.description.length).toBeGreaterThanOrEqual(50);
      expect(job.slugByLocale[job.sourceLang]).toBe(job.slug);
    });

    it('returns an empty array when the feed has no listings', async () => {
      fetchSpy.mockImplementation(async (url: any) => {
        const u = String(url);
        if (u === LISTING_URL) {
          return mockResponse(listingHtml([])) as any;
        }
        throw new Error(`Unexpected fetch: ${u}`);
      });

      const jobs = await fetchAllSygnumJobs();
      expect(jobs).toEqual([]);
    });

    it('filters out non-Swiss/foreign office postings', async () => {
      fetchSpy.mockImplementation(async (url: any) => {
        const u = String(url);
        if (u === LISTING_URL) {
          return mockResponse(
            listingHtml([
              { vacancyNo: 'VN001', title: 'Relationship Manager EAM & MFO' },
              { vacancyNo: 'VN143', title: 'Legal Counsel Liechtenstein' },
              { vacancyNo: 'VN222', title: 'Head of Singapore Operations' },
            ]),
          ) as any;
        }
        if (u === DETAIL_URL('VN001')) {
          return mockResponse(
            detailHtml({ title: 'Relationship Manager EAM & MFO', locality: 'Zurich', country: 'Switzerland', postalCode: '8045' }),
          ) as any;
        }
        if (u === DETAIL_URL('VN143')) {
          return mockResponse(
            detailHtml({ title: 'Legal Counsel Liechtenstein', locality: 'Vaduz', country: 'Liechtenstein' }),
          ) as any;
        }
        if (u === DETAIL_URL('VN222')) {
          return mockResponse(
            detailHtml({ title: 'Head of Singapore Operations', locality: 'Singapore', country: 'Singapore' }),
          ) as any;
        }
        throw new Error(`Unexpected fetch: ${u}`);
      });

      const jobs = await fetchAllSygnumJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].title).toBe('Relationship Manager EAM & MFO');
      expect(jobs.some((j: any) => j.title.includes('Liechtenstein'))).toBe(false);
      expect(jobs.some((j: any) => j.title.includes('Singapore'))).toBe(false);
    });

    it('infers canton from the office locality and gates HQ street address/postal code to the matching canton only', async () => {
      fetchSpy.mockImplementation(async (url: any) => {
        const u = String(url);
        if (u === LISTING_URL) {
          return mockResponse(
            listingHtml([
              { vacancyNo: 'VN001', title: 'Zurich Role' },
              { vacancyNo: 'VN002', title: 'Geneva Role' },
            ]),
          ) as any;
        }
        if (u === DETAIL_URL('VN001')) {
          return mockResponse(detailHtml({ title: 'Zurich Role', locality: 'Zurich', country: 'Switzerland' })) as any;
        }
        if (u === DETAIL_URL('VN002')) {
          return mockResponse(detailHtml({ title: 'Geneva Role', locality: 'Geneva', country: 'Switzerland' })) as any;
        }
        throw new Error(`Unexpected fetch: ${u}`);
      });

      const jobs = await fetchAllSygnumJobs();
      const zurichJob = jobs.find((j: any) => j.title === 'Zurich Role');
      const genevaJob = jobs.find((j: any) => j.title === 'Geneva Role');

      expect(zurichJob.canton).toBe('ZH');
      expect(zurichJob.streetAddress).toBe('Uetlibergstrasse 134A');
      expect(zurichJob.postalCode).toBe('8045');

      // Geneva is a different canton from HQ (ZH) — must NOT inherit HQ's
      // street address or postal code (the canton-gating bug this parser
      // must avoid).
      expect(genevaJob.canton).toBe('GE');
      expect(genevaJob.streetAddress).toBe('');
      expect(genevaJob.postalCode).toBe('');
    });

    it('applies the thin-description guard when the source description is too short', async () => {
      fetchSpy.mockImplementation(async (url: any) => {
        const u = String(url);
        if (u === LISTING_URL) {
          return mockResponse(listingHtml([{ vacancyNo: 'VN001', title: 'Thin Description Role' }])) as any;
        }
        if (u === DETAIL_URL('VN001')) {
          return mockResponse(
            detailHtml({
              title: 'Thin Description Role',
              locality: 'Zurich',
              country: 'Switzerland',
              aboutRole: 'Short.',
              idealCandidate: '',
            }),
          ) as any;
        }
        throw new Error(`Unexpected fetch: ${u}`);
      });

      const jobs = await fetchAllSygnumJobs();
      expect(jobs).toHaveLength(1);
      const job = jobs[0];
      // Guard should kick in and synthesize a safe fallback description
      // rather than emit near-empty/thin content.
      expect(job.description).toContain('Thin Description Role');
      expect(job.description).toContain('Sygnum Bank');
      expect(job.description.split(/\s+/).length).toBeGreaterThan(3);
    });

    it('always emits the structured-data completeness fields required by Non-Negotiable #3', async () => {
      fetchSpy.mockImplementation(async (url: any) => {
        const u = String(url);
        if (u === LISTING_URL) {
          return mockResponse(listingHtml([{ vacancyNo: 'VN001', title: 'Structured Data Role' }])) as any;
        }
        if (u === DETAIL_URL('VN001')) {
          return mockResponse(
            detailHtml({ title: 'Structured Data Role', locality: 'Zurich', country: 'Switzerland', postalCode: '8045' }),
          ) as any;
        }
        throw new Error(`Unexpected fetch: ${u}`);
      });

      const jobs = await fetchAllSygnumJobs();
      const job = jobs[0];

      const structuredDataInputs = [
        'postalCode', 'streetAddress', 'title', 'description',
        'addressLocality', 'addressCountry', 'employmentType', 'postedDate',
      ];
      for (const field of structuredDataInputs) {
        expect(job).toHaveProperty(field);
        expect((job as any)[field]).toBeTruthy();
      }
      expect(job.company).toBe('Sygnum Bank');
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference (mirrors what fetchAllSygnumJobs emits)
    const validJob = {
      id: 'sygnum-abc123',
      slug: 'test-position-sygnum-zurich',
      slugByLocale: { en: 'test-position-sygnum-zurich' },
      company: 'Sygnum Bank',
      companyKey: 'sygnum',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Zürich',
      canton: 'ZH',
      url: DETAIL_URL('VN999'),
      source: 'Sygnum Dedicated Parser (Salesforce fRecruit)',
      sourceLang: 'en',
      crawledAt: new Date().toISOString(),
      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: 'Zürich',
      addressRegion: 'ZH',
      streetAddress: 'Uetlibergstrasse 134A',
      postalCode: '8045',
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
      expect(validJob.id).toMatch(/^sygnum-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
