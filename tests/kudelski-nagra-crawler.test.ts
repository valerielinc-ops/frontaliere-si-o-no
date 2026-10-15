import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Only the two network calls are stubbed; every other crawler-template export
// the parser relies on (slugify, stripHtml, normalizeSpace) stays real.
vi.mock('../scripts/lib/crawler-template.mjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../scripts/lib/crawler-template.mjs')>()),
  fetchJson: vi.fn(),
  fetchHtml: vi.fn(),
}));
import {
  KUDELSKI_NAGRA_KEY,
  KUDELSKI_NAGRA_COMPANY_NAME,
  isKudelskiNagraJob,
  isTrustedDomain,
  fetchAllKudelskiNagraJobs,
  extractNagraAdvertHtml,
} from '../scripts/lib/kudelski-nagra-job-parser.mjs';
import { slugify, fetchJson, fetchHtml } from '../scripts/lib/crawler-template.mjs';

describe('Kudelski NAGRA crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(KUDELSKI_NAGRA_KEY).toBe('kudelski-nagra');
    expect(KUDELSKI_NAGRA_COMPANY_NAME).toBe('Kudelski NAGRA');
  });

  // ── isCompanyJob ──
  describe('isKudelskiNagraJob', () => {
    it('matches by companyKey', () => {
      expect(isKudelskiNagraJob({ companyKey: 'kudelski-nagra' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isKudelskiNagraJob({ company: 'Kudelski NAGRA' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isKudelskiNagraJob({ url: 'https://nagra.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isKudelskiNagraJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isKudelskiNagraJob(null)).toBe(false);
      expect(isKudelskiNagraJob(undefined)).toBe(false);
      expect(isKudelskiNagraJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://nagra.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.nagra.com/job/456')).toBe(true);
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
      expect(slugify('Developer kudelski-nagra ch')).toBe('developer-kudelski-nagra-ch');
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
      id: 'kudelski-nagra-abc123',
      slug: 'test-position-kudelski-nagra-ch',
      slugByLocale: { en: 'test-position-kudelski-nagra-ch' },
      company: 'Kudelski NAGRA',
      companyKey: 'kudelski-nagra',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://nagra.com/jobs/test',
      source: 'Kudelski NAGRA Dedicated Parser',
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
      expect(validJob.id).toMatch(/^kudelski-nagra-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
  // ── Filtered-empty health signal (issue #7707) ──
  describe('discoveredCount', () => {
    beforeEach(() => {
      vi.mocked(fetchHtml).mockResolvedValue('');
      vi.mocked(fetchJson).mockReset();
    });

    /** Greenhouse board payload; the first board slug tried already answers. */
    function greenhouseBoard(jobs: Array<Record<string, unknown>>) {
      vi.mocked(fetchJson).mockResolvedValue({ jobs } as never);
    }

    it('reports the pre-filter candidate count when the Swiss gate keeps nothing', async () => {
      greenhouseBoard([
        { id: 1, title: 'Embedded Software Engineer', location: { name: 'Madrid, Spain' }, content: 'Firmware work.' },
        { id: 2, title: 'Security Architect', location: { name: 'Paris, France' }, content: 'Threat modelling.' },
      ]);

      const jobs = await fetchAllKudelskiNagraJobs();

      // Without this the crawler looks identical to a selector break: zero jobs
      // and no evidence that the board was parsed at all, so
      // check-crawler-health counts an empty streak and flags it broken.
      expect(jobs).toHaveLength(0);
      expect((jobs as unknown as { discoveredCount?: number }).discoveredCount).toBe(2);
    });

    it('does not count listings dropped by the non-geographic title gate', async () => {
      // Regression: discoveredCount used to be `listings.length`, the count
      // BEFORE every gate. If title extraction broke on every Swiss offer the
      // crawler would report `discovered > 0 && written === 0` — exactly the
      // shape autoFilteredEmpty reads as "healthy, just filtered" — and a real
      // outage would be laundered into a healthy verdict. Only the geographic
      // gate may leave a listing counted.
      greenhouseBoard([
        { id: 1, title: '', location: { name: 'Cheseaux-sur-Lausanne, Switzerland' }, content: 'Firmware work.' },
        { id: 2, title: '  ', location: { name: 'Lugano, Switzerland' }, content: 'Threat modelling.' },
      ]);

      const jobs = await fetchAllKudelskiNagraJobs();

      expect(jobs).toHaveLength(0);
      expect((jobs as unknown as { discoveredCount?: number }).discoveredCount).toBe(0);
    });

    it('keeps the count non-enumerable so it never leaks into the slice', async () => {
      greenhouseBoard([
        { id: 1, title: 'Embedded Software Engineer', location: { name: 'Madrid, Spain' }, content: 'Firmware work.' },
      ]);

      const jobs = await fetchAllKudelskiNagraJobs();

      expect(JSON.stringify(jobs)).toBe('[]');
    });

    it('fills a valid address fallback in the derived canton, not the company HQ canton', async () => {
      greenhouseBoard([
        {
          id: 1,
          title: 'Embedded Software Engineer',
          location: { name: 'Baden, Switzerland' },
          content: 'Firmware work.',
        },
      ]);

      const jobs = await fetchAllKudelskiNagraJobs();

      expect(jobs).toHaveLength(1);
      expect(jobs[0].canton).toBe('AG');
      expect(jobs[0].addressRegion).toBe('AG');
      expect(jobs[0].postalCode).toMatch(/^\d{4}$/);
      expect(jobs[0].postalCode).toBe('5000');
      expect(jobs[0].postalCode).not.toBe('6900');
      expect(jobs[0].streetAddress).toBeTruthy();
    });
  });
});

// ── #5253: the careers.nagra.com table has no description column ──────────
describe('careers.nagra.com detail body', () => {
  // Real page, minimised: `?page=advertisement_display&id=15828`.
  const ADVERT_15828 = fs.readFileSync(
    path.join(__dirname, 'fixtures', 'crawler-quality-f', 'nagra-advert-15828.html'),
    'utf8',
  );
  const TABLE = '<table><tr class="table-primary "><td>15828</td><td>20-08-2026</td>'
    + '<td><a href="?page=advertisement_display&id=15828">Security Operations Engineer.</a></td>'
    + '<td>Permanent CDI</td><td>Switzerland</td><td>Kudelski Security</td><td><a href="#">Apply</a></td></tr></table>';

  it('reads the whole #advert block, nested lists included', () => {
    const html = extractNagraAdvertHtml(ADVERT_15828);
    expect(html).toContain('Who We Are');
    expect(html).toContain('Palo Alto');
    expect(html).toContain('Why Join Kudelski Security?');
    expect(html).not.toContain('Publication Date');
    expect(extractNagraAdvertHtml('<div id="other">x</div>')).toBe('');
  });

  it('publishes the vacancy body instead of a sentence built from the table columns', async () => {
    vi.mocked(fetchJson).mockReset();
    vi.mocked(fetchJson).mockResolvedValue({ jobs: [] } as never);
    vi.mocked(fetchHtml).mockReset();
    vi.mocked(fetchHtml).mockImplementation(async (url: string) => (
      String(url).includes('advertisement_display') ? ADVERT_15828 : TABLE
    ));

    const jobs = await fetchAllKudelskiNagraJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0].url).toBe('https://careers.nagra.com/?page=advertisement_display&id=15828');
    expect(jobs[0].description).toContain('We are seeking a Security Operations Engineer to support a major client in Zurich');
    expect(jobs[0].description).toMatch(/^\s*• 3\+ years of experience in Security Operations/m);
    expect(jobs[0].description).not.toContain('Permanent CDI at Kudelski Security');
    expect(jobs[0].sourceLang).toBe('en');
    expect(jobs[0].canton).toBe('ZH');
    // One listing fetch plus ONE detail fetch: the page serves both the
    // workplace and the body.
    expect(vi.mocked(fetchHtml)).toHaveBeenCalledTimes(2);
  });
});
