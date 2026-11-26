import { describe, it, expect } from 'vitest';
import {
  RITUALS_COSMETICS_KEY,
  RITUALS_COSMETICS_COMPANY_NAME,
  RITUALS_COSMETICS_CAREER_URL,
  fetchAllRitualsCosmeticsJobs,
  isRitualsCosmeticsJob,
  isTrustedDomain,
  parseRitualsDetailPage,
  parseRitualsListingPage,
} from '../scripts/lib/rituals-cosmetics-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

const DETAIL_URL = 'https://careers.rituals.com/de-CH/jobs/aushilfe-verkaufsberater-m-w-d/R3605/';
const LISTING_HTML = `<main>
  <article>
    <h2>Aushilfe Verkaufsberater (m/w/d)</h2>
    <a href="${DETAIL_URL}">Aushilfe Verkaufsberater (m/w/d)</a>
    <span>Shop • Stans Einkaufscenter Länderpark • 0-41 Stunden</span>
  </article>
</main>`;
const SOURCE_BODY = 'Responsibilities and requirements of the role, described at length by the employer. '.repeat(5);
const daysAgo = (days: number) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

describe('Rituals Cosmetics Switzerland crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(RITUALS_COSMETICS_KEY).toBe('rituals-cosmetics');
    expect(RITUALS_COSMETICS_COMPANY_NAME).toBe('Rituals Cosmetics Switzerland');
  });

  // ── isCompanyJob ──
  describe('isRitualsCosmeticsJob', () => {
    it('matches by companyKey', () => {
      expect(isRitualsCosmeticsJob({ companyKey: 'rituals-cosmetics' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isRitualsCosmeticsJob({ company: 'Rituals Cosmetics Switzerland' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isRitualsCosmeticsJob({ url: 'https://rituals.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isRitualsCosmeticsJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
      expect(isRitualsCosmeticsJob({ companyKey: 'other-company', company: 'Other', url: 'https://notrituals.com/rituals.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isRitualsCosmeticsJob(null)).toBe(false);
      expect(isRitualsCosmeticsJob(undefined)).toBe(false);
      expect(isRitualsCosmeticsJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://rituals.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.rituals.com/job/456')).toBe(true);
    });

    it('trusts the official Kaliber origin used by the branded careers site', () => {
      expect(isTrustedDomain('https://rituals-careers-prd.kaliber.io/de-CH/jobs/role/R1/')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  describe('official careers source', () => {
    it('parses the current server-rendered listing card and requisition id', () => {
      expect(parseRitualsListingPage(LISTING_HTML)).toEqual([{
        title: 'Aushilfe Verkaufsberater (m/w/d)',
        url: DETAIL_URL,
        jobReqId: 'R3605',
        locationRaw: 'Stans Einkaufscenter Länderpark',
        timeType: expect.stringContaining('0-41 Stunden'),
      }]);
    });

    it('uses the vacancy body when JSON-LD is only a short summary', () => {
      const datePosted = daysAgo(2);
      const detailHtml = `<main>
        <div>Stans Einkaufscenter Länderpark</div>
        <h1>Aushilfe Verkaufsberater (m/w/d)</h1>
        <div class="job-description"><p>${SOURCE_BODY}</p></div>
        <h2>Mehr Shop-Karrieren</h2>
        <form><p>Newsletter and application chrome</p></form>
      </main>
      <script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'JobPosting',
        title: 'Aushilfe Verkaufsberater (m/w/d)',
        description: 'Apply now',
        datePosted,
        employmentType: 'PART_TIME',
        jobLocation: { address: { addressLocality: 'Stans' } },
      })}</script>`;

      const detail = parseRitualsDetailPage(detailHtml, {
        title: 'Aushilfe Verkaufsberater (m/w/d)',
        locationRaw: 'Stans Einkaufscenter Länderpark',
      });
      expect(detail).toMatchObject({
        title: 'Aushilfe Verkaufsberater (m/w/d)',
        description: expect.stringContaining('Responsibilities and requirements'),
        location: 'Stans',
        employmentType: 'PART_TIME',
        datePosted,
        postedDate: datePosted,
        postingDateSource: 'reported',
      });
      expect(detail.description).not.toContain('Newsletter');
    });

    it('publishes official jobs and skips a detail without source body', async () => {
      const fetchHtml = async (url: string) => {
        if (url === RITUALS_COSMETICS_CAREER_URL) return LISTING_HTML;
        if (url === DETAIL_URL) return `<main><h1>Aushilfe Verkaufsberater (m/w/d)</h1><p>Apply now</p></main>`;
        throw new Error(`unexpected Rituals URL: ${url}`);
      };

      const jobs: any[] = await fetchAllRitualsCosmeticsJobs({ _fetchHtml: fetchHtml });

      expect(jobs).toHaveLength(0);
      expect((jobs as any).discoveredCount).toBe(1);
    });

    it('keeps the Schönbühl store in Bern instead of using the legal-seat canton', async () => {
      const detailUrl = 'https://careers.rituals.com/de-CH/jobs/aushilfe-verkaufsberater-m-w-d/R3950/';
      const listingHtml = `<main><article>
        <h2>Aushilfe Verkaufsberater (m/w/d)</h2>
        <a href="${detailUrl}">Aushilfe Verkaufsberater (m/w/d)</a>
        <span>Shop • Schoenbuehl Shoppyland • 0-41 Stunden</span>
      </article></main>`;
      const detailHtml = `<main>
        <h1>Aushilfe Verkaufsberater (m/w/d)</h1>
        <div>Schoenbuehl Shoppyland</div>
        <p>${SOURCE_BODY}</p>
      </main>`;
      const fetchHtml = async (url: string) => {
        if (url === RITUALS_COSMETICS_CAREER_URL) return listingHtml;
        if (url === detailUrl) return detailHtml;
        throw new Error(`unexpected Rituals URL: ${url}`);
      };

      const [job]: any[] = await fetchAllRitualsCosmeticsJobs({ _fetchHtml: fetchHtml });

      expect(job).toMatchObject({ canton: 'BE', jobReqId: 'R3950' });
      expect(job.location.toLowerCase()).toContain('schoenbuehl');
    });

    it('fails closed when the next listing page cannot be fetched', async () => {
      const listingHtml = `<main>${Array.from({ length: 20 }, (_, index) => `
        <article><a href="https://careers.rituals.com/de-CH/jobs/role-${index}/R${index}/">Role ${index}</a>
        <span>Shop • Stans • 0-41 Stunden</span></article>`).join('')}</main>`;
      const fetchHtml = async (url: string) => {
        if (url === RITUALS_COSMETICS_CAREER_URL) return listingHtml;
        throw new Error(`listing page unavailable: ${url}`);
      };

      await expect(fetchAllRitualsCosmeticsJobs({ _fetchHtml: fetchHtml })).rejects.toMatchObject({
        specListingFailure: true,
        specDiscoveredCount: 20,
      });
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
      expect(slugify('Developer rituals-cosmetics ch')).toBe('developer-rituals-cosmetics-ch');
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
      id: 'rituals-cosmetics-abc123',
      slug: 'test-position-rituals-cosmetics-ch',
      slugByLocale: { de: 'test-position-rituals-cosmetics-ch' },
      company: 'Rituals Cosmetics Switzerland',
      companyKey: 'rituals-cosmetics',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://rituals.com/jobs/test',
      source: 'Rituals Cosmetics Switzerland Dedicated Parser',
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
      expect(validJob.id).toMatch(/^rituals-cosmetics-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
