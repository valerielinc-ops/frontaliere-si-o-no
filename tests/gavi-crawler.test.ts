import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  GAVI_KEY,
  GAVI_COMPANY_NAME,
  isGaviJob,
  isTrustedDomain,
  fetchAllGaviJobs,
} from '../scripts/lib/gavi-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

const PORTAL_HOST = 'fs-2662.my.salesforce-sites.com';
const LISTING_URL = `https://${PORTAL_HOST}/recruit/fRecruit__ApplyJobList?portal=Global`;
const DETAIL_URL = (vn: string) => `https://${PORTAL_HOST}/recruit/fRecruit__ApplyJob?vacancyNo=${vn}&portal=Global`;

function listingHtml(rows: Array<{ vacancyNo: string; title: string; location: string }>) {
  // Mirrors the real fRecruit table markup: a "Job Title" link cell
  // immediately followed by a "Location" cell, matching the row regex
  // in extractVacancyRows(). No "Next" link → single page.
  const trs = rows
    .map(
      (r) => `<tr class="dataRow"><td class="dataCell"><span><span>${r.vacancyNo}</span></span></td>` +
        `<td class="dataCell"><span><a href="/recruit/fRecruit__ApplyJob?vacancyNo=${r.vacancyNo}&amp;portal=Global">${r.title}</a></span></td>` +
        `<td class="dataCell"><span><span>${r.location}</span></span></td>` +
        `<td class="dataCell"><span><span>22 Jul 2026</span></span></td></tr>`,
    )
    .join('\n');
  return `<html><body><table class="list jobListPanel">${trs}</table></body></html>`;
}

function detailHtml({
  title,
  location,
  team = 'Some Team',
  contractLine = '5 year contract defined duration',
  datePosted = '2026-06-30',
  aboutRole = 'The role sits within the department and reports administratively to the CEO, working closely with the Board, Executive Leadership Team, staff, Legal, Internal Audit and relevant external counterparts to advance the mission.',
  keyResponsibilities = 'Advise senior leadership as principal counsel, supervise drafting and negotiation of agreements, provide strategic advice on risks, and manage a high-performing team aligned to organisational values.',
}: {
  title: string;
  location: string;
  team?: string;
  contractLine?: string;
  datePosted?: string;
  aboutRole?: string;
  keyResponsibilities?: string;
}) {
  // Real Gavi JSON-LD is placeholder-only for address/hiringOrganization/
  // employmentType/description — only datePosted (and validThrough) carry
  // real values. Mirrored here deliberately.
  const jsonLd = {
    '@context': 'http://schema.org',
    '@type': 'JobPosting',
    title,
    datePosted,
    jobLocation: {
      '@type': 'Place',
      address: {
        streetAddress: '',
        postalCode: '',
        addressRegion: '',
        addressLocality: '',
        addressCountry: '',
      },
    },
    description: title,
    hiringOrganization: { '@type': 'Organization', name: '' },
    baseSalary: { '@type': 'MonetaryAmount', currency: 'AFN' },
    employmentType: 'Gavi 5-years',
  };

  const jobDescriptionHtml = `<strong>Position title:</strong> ${title}<br>` +
    `<strong>Contract type / duration:</strong> ${contractLine}<br>` +
    `<strong>Location:</strong> ${location}<br>` +
    `<strong>Team:</strong> ${team}<br>` +
    `<br><strong>1. About the Role</strong><br>${aboutRole}` +
    `<br><br><strong>2. Key Responsibilities</strong><br><ul><li>${keyResponsibilities}</li></ul>`;

  return `<html><body>
    <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
    <table>
      <tr><th class="labelCol"><label>Vacancy No</label></th><td class="data2Col">VN0001</td></tr>
      <tr><th class="labelCol"><label>Job Title</label></th><td class="data2Col">${title}</td></tr>
      <tr><th class="labelCol"><label>Location</label></th><td class="data2Col">${location}</td></tr>
      <tr><th class="labelCol"><label>Team</label></th><td class="data2Col">${team}</td></tr>
      <tr><th class="labelCol"><label>Reporting to</label></th><td class="data2Col">CEO</td></tr>
      <tr><th class="labelCol"><label>Career Step Level</label></th><td class="data2Col">6</td></tr>
      <tr><th class="labelCol"><label>Job Description</label></th><td class="data2Col">${jobDescriptionHtml}</td></tr>
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

describe('Gavi crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(GAVI_KEY).toBe('gavi');
    expect(GAVI_COMPANY_NAME).toBe('Gavi, the Vaccine Alliance');
  });

  // ── isCompanyJob ──
  describe('isGaviJob', () => {
    it('matches by companyKey', () => {
      expect(isGaviJob({ companyKey: 'gavi' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isGaviJob({ company: 'Gavi, the Vaccine Alliance' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isGaviJob({ url: 'https://www.gavi.org/about-us/work-us/vacancies' })).toBe(true);
    });

    it('matches by Salesforce fRecruit portal URL', () => {
      expect(isGaviJob({ url: DETAIL_URL('VN123') })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isGaviJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isGaviJob(null)).toBe(false);
      expect(isGaviJob(undefined)).toBe(false);
      expect(isGaviJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://www.gavi.org/about-us/work-us/vacancies')).toBe(true);
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
      const slug = slugify('General Counsel (Geneva)');
      expect(slug).toBe('general-counsel-geneva');
    });

    it('strips diacritics', () => {
      expect(slugify('Ingénieur qualité')).toBe('ingenieur-qualite');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('General Counsel gavi geneva')).toBe('general-counsel-gavi-geneva');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── fetchAllGaviJobs (network mocked) ──
  describe('fetchAllGaviJobs', () => {
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
          return mockResponse(
            listingHtml([{ vacancyNo: 'VN2507', title: 'Chief Ethics, Risk & Compliance Officer', location: 'Geneva' }]),
          ) as any;
        }
        if (u === DETAIL_URL('VN2507')) {
          return mockResponse(
            detailHtml({ title: 'Chief Ethics, Risk & Compliance Officer', location: 'Geneva', team: 'Ethics, Risk and Compliance' }),
          ) as any;
        }
        throw new Error(`Unexpected fetch: ${u}`);
      });

      const jobs = await fetchAllGaviJobs();
      expect(jobs).toHaveLength(1);

      const job = jobs[0];
      expect(job.id).toMatch(/^gavi-/);
      expect(job.companyKey).toBe('gavi');
      expect(job.company).toBe('Gavi, the Vaccine Alliance');
      expect(job.title).toBe('Chief Ethics, Risk & Compliance Officer');
      expect(job.canton).toBe('GE');
      expect(job.addressCountry).toBe('CH');
      expect(job.country).toBe('CH');
      expect(job.url).toBe(DETAIL_URL('VN2507'));
      expect(job.employmentType).toBe('FULL_TIME');
      expect(job.postedDate).toBe('2026-06-30');
      expect(job.description.length).toBeGreaterThanOrEqual(50);
      expect(job.postalCode).toBe('1218');
      expect(job.streetAddress).toBe('Chemin du Pommier 40');
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

      const jobs = await fetchAllGaviJobs();
      expect(jobs).toEqual([]);
    });

    it('filters out non-Swiss postings (e.g. the Washington DC liaison office)', async () => {
      fetchSpy.mockImplementation(async (url: any) => {
        const u = String(url);
        if (u === LISTING_URL) {
          return mockResponse(
            listingHtml([
              { vacancyNo: 'VN2510', title: 'General Counsel', location: 'Geneva' },
              { vacancyNo: 'VN9999', title: 'DC Liaison Officer', location: 'Washington DC' },
            ]),
          ) as any;
        }
        if (u === DETAIL_URL('VN2510')) {
          return mockResponse(detailHtml({ title: 'General Counsel', location: 'Geneva', team: 'Legal' })) as any;
        }
        if (u === DETAIL_URL('VN9999')) {
          return mockResponse(detailHtml({ title: 'DC Liaison Officer', location: 'Washington DC', team: 'External Relations' })) as any;
        }
        throw new Error(`Unexpected fetch: ${u}`);
      });

      const jobs = await fetchAllGaviJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].title).toBe('General Counsel');
      expect(jobs.some((j: any) => j.title.includes('DC Liaison'))).toBe(false);
    });

    it('gates HQ street address/postal code to the Geneva HQ locality only', async () => {
      fetchSpy.mockImplementation(async (url: any) => {
        const u = String(url);
        if (u === LISTING_URL) {
          return mockResponse(
            listingHtml([{ vacancyNo: 'VN0002', title: 'Programme Officer', location: 'Le Grand-Saconnex' }]),
          ) as any;
        }
        if (u === DETAIL_URL('VN0002')) {
          return mockResponse(detailHtml({ title: 'Programme Officer', location: 'Le Grand-Saconnex', team: 'Programmes' })) as any;
        }
        throw new Error(`Unexpected fetch: ${u}`);
      });

      const jobs = await fetchAllGaviJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].canton).toBe('GE');
      expect(jobs[0].streetAddress).toBe('Chemin du Pommier 40');
      expect(jobs[0].postalCode).toBe('1218');
    });

    it('applies the thin-description guard when the source has no usable "Job Description" field', async () => {
      // Simulates a detail page whose label/value table is missing the rich
      // "Job Description" field entirely (all other label fields are
      // excluded from the aggregated description as metadata) — the parser
      // must fall back to a synthesized description rather than emit an
      // empty/near-empty one.
      const minimalDetailHtml = `<html><body>
        <script type="application/ld+json">${JSON.stringify({
          '@context': 'http://schema.org', '@type': 'JobPosting',
          title: 'Thin Description Role', datePosted: '2026-06-30',
          jobLocation: { '@type': 'Place', address: {} },
          description: 'Thin Description Role', hiringOrganization: { name: '' },
          baseSalary: { currency: 'AFN' }, employmentType: 'Gavi 5-years',
        })}</script>
        <table>
          <tr><th class="labelCol"><label>Vacancy No</label></th><td class="data2Col">VN0003</td></tr>
          <tr><th class="labelCol"><label>Job Title</label></th><td class="data2Col">Thin Description Role</td></tr>
          <tr><th class="labelCol"><label>Location</label></th><td class="data2Col">Geneva</td></tr>
        </table>
      </body></html>`;

      fetchSpy.mockImplementation(async (url: any) => {
        const u = String(url);
        if (u === LISTING_URL) {
          return mockResponse(listingHtml([{ vacancyNo: 'VN0003', title: 'Thin Description Role', location: 'Geneva' }])) as any;
        }
        if (u === DETAIL_URL('VN0003')) {
          return mockResponse(minimalDetailHtml) as any;
        }
        throw new Error(`Unexpected fetch: ${u}`);
      });

      const jobs = await fetchAllGaviJobs();
      expect(jobs).toHaveLength(1);
      const job = jobs[0];
      expect(job.description).toContain('Thin Description Role');
      expect(job.description).toContain('Gavi, the Vaccine Alliance');
      expect(job.description.split(/\s+/).length).toBeGreaterThan(3);
    });

    it('always emits the structured-data completeness fields required by Non-Negotiable #3', async () => {
      fetchSpy.mockImplementation(async (url: any) => {
        const u = String(url);
        if (u === LISTING_URL) {
          return mockResponse(listingHtml([{ vacancyNo: 'VN0004', title: 'Structured Data Role', location: 'Geneva' }])) as any;
        }
        if (u === DETAIL_URL('VN0004')) {
          return mockResponse(detailHtml({ title: 'Structured Data Role', location: 'Geneva' })) as any;
        }
        throw new Error(`Unexpected fetch: ${u}`);
      });

      const jobs = await fetchAllGaviJobs();
      const job = jobs[0];

      const structuredDataInputs = [
        'postalCode', 'streetAddress', 'title', 'description',
        'addressLocality', 'addressCountry', 'employmentType', 'postedDate',
      ];
      for (const field of structuredDataInputs) {
        expect(job).toHaveProperty(field);
        expect((job as any)[field]).toBeTruthy();
      }
      expect(job.company).toBe('Gavi, the Vaccine Alliance');
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference (mirrors what fetchAllGaviJobs emits)
    const validJob = {
      id: 'gavi-abc123',
      slug: 'test-position-gavi-geneva',
      slugByLocale: { en: 'test-position-gavi-geneva' },
      company: 'Gavi, the Vaccine Alliance',
      companyKey: 'gavi',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Le Grand-Saconnex',
      canton: 'GE',
      url: DETAIL_URL('VN999'),
      source: 'Gavi Dedicated Parser (Salesforce fRecruit)',
      sourceLang: 'en',
      crawledAt: new Date().toISOString(),
      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: 'Le Grand-Saconnex',
      addressRegion: 'GE',
      streetAddress: 'Chemin du Pommier 40',
      postalCode: '1218',
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
      expect(validJob.id).toMatch(/^gavi-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
