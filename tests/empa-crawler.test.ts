import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  EMPA_KEY,
  EMPA_COMPANY_NAME,
  isEmpaJob,
  isTrustedDomain,
  fetchAllEmpaJobs,
} from '../scripts/lib/empa-job-parser.mjs';
import { parseReflineTableListing, parseReflineJobPostingJsonLd } from '../scripts/lib/refline-common.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

const REFLINE_TENANT = '673276';
const LISTING_HOST = 'apply.refline.ch';
const LISTING_URL = `https://${LISTING_HOST}/${REFLINE_TENANT}/search.html?form.buttons.listAll=1&lang=de`;

function htmlResponse(status: number, body: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as unknown as Response;
}

// Empa's real column order is position → workload → workplace → published
// (deliberately different order than other Refline table-row tenants, to
// exercise the order-independent shared parser).
function listingRow(posId: string, rev: string, title: string, workload: string, workplace: string, published: string) {
  return `<tr>
      <td class="position"><a href="https://${LISTING_HOST}/${REFLINE_TENANT}/${posId}/pub/${rev}/index.html" target="_blank">${title}</a></td>
      <td class="workload">${workload}</td>
      <td class="workplace">${workplace}</td>
      <td class="published">${published}</td>
    </tr>`;
}

function listingHtml(rows: string[]) {
  return `<html><body><table>${rows.join('\n')}</table></body></html>`;
}

function jobPostingJsonLd(overrides: Record<string, unknown> = {}) {
  return {
    '@context': 'http://schema.org/',
    '@type': 'JobPosting',
    title: 'PhD Position on All-Solid-State Batteries',
    description: '<div>Empa’s Laboratory Materials for Energy Conversion focuses on materials and device innovation for sustainable energy technologies.</div><br /><div>Your tasks</div><br /><div>The aim of this PhD project is to investigate lithium- and sodium-based solid-state batteries using muon-based bulk and interface characterization techniques. The main objective is to gain a mechanistic understanding of electrochemical performance, with a focus on ion distribution, transport, and degradation processes during battery operation. The project addresses key questions on the formation of Li/Na concentration gradients during charge and discharge, the evolution of interphases, and degradation mechanisms including ageing, material dissolution, and transition-metal migration.</div><br /><div>Your profile</div><br /><div>You hold a Master’s degree in chemistry, materials science, or a related field, experience in electrochemistry or batteries is an advantage. Excellent communication skills in English are required.</div><br /><div>We offer</div><br /><div>You will conduct your research in Empa’s laboratories in Dübendorf and will be enrolled in the doctoral program in Electrical Engineering at ETH Zurich, benefiting from a highly interdisciplinary and international research environment with state-of-the-art infrastructure.</div>',
    datePosted: '2026-03-23T16:26:34.485783+00:00',
    validThrough: '2026-09-30',
    jobLocationType: '',
    hiringOrganization: {
      '@type': 'Organization',
      name: 'Empa',
      sameAs: 'https://www.empa.ch',
      logo: 'https://apply.refline.ch/673276/companies/master/img/logo.jpg',
    },
    employmentType: ['FULL_TIME'],
    jobLocation: {
      '@type': 'Place',
      address: {
        '@type': 'PostalAddress',
        addressCountry: 'CH',
        addressLocality: 'Dübendorf',
        addressRegion: 'ZH',
        streetAddress: 'Ueberlandstrasse 129',
        postalCode: '8600',
      },
    },
    identifier: { '@type': 'PropertyValue', name: 'Empa', value: 'refline-673276-master' },
    ...overrides,
  };
}

function detailHtml(jsonLd: Record<string, unknown>) {
  return `<html><body><h1 id="bTitle">${jsonLd.title}</h1><script type="application/ld+json">${JSON.stringify(jsonLd)}</script></body></html>`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Empa crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(EMPA_KEY).toBe('empa');
    expect(EMPA_COMPANY_NAME).toBe('Empa');
  });

  // ── isEmpaJob ──
  describe('isEmpaJob', () => {
    it('matches by companyKey', () => {
      expect(isEmpaJob({ companyKey: 'empa' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isEmpaJob({ company: 'Empa' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isEmpaJob({ url: 'https://www.empa.ch/web/empa/jobs' })).toBe(true);
    });

    it('matches by Refline tenant URL', () => {
      expect(isEmpaJob({ url: 'https://apply.refline.ch/673276/1241/pub/5/index.html' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isEmpaJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('rejects a different Refline tenant (e.g. Eawag / WSL sibling ETH-Domain boards)', () => {
      expect(isEmpaJob({ url: 'https://apply.refline.ch/673277/1/pub/1/index.html' })).toBe(false);
      expect(isEmpaJob({ url: 'https://apply.refline.ch/273855/1/pub/1/index.html' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isEmpaJob(null)).toBe(false);
      expect(isEmpaJob(undefined)).toBe(false);
      expect(isEmpaJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://www.empa.ch/web/empa/jobs')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://jobs.empa.ch/foo')).toBe(true);
    });

    it('trusts Refline ATS host', () => {
      expect(isTrustedDomain('https://apply.refline.ch/673276/1241/pub/5/index.html')).toBe(true);
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
      const slug = slugify('PhD Position on All-Solid-State Batteries');
      expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('strips diacritics', () => {
      expect(slugify('Forschungsingenieur/in Mechatronik für biomedizinische Sensorsysteme')).not.toMatch(/[üäö]/);
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Postdoc empa dubendorf')).toBe('postdoc-empa-dubendorf');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Shared listing parser (order/name-independent) ──
  describe('parseReflineTableListing (Empa column order: workload → workplace → published)', () => {
    it('parses table rows regardless of Empa-specific column order/naming', () => {
      const html = listingHtml([
        listingRow('55841', '1', 'PhD Position on All-Solid-State Batteries', '100%', 'Dübendorf', '23.03.2026'),
      ]);
      const rows = parseReflineTableListing(html, { listingHost: LISTING_HOST, tenant: REFLINE_TENANT });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        posId: '55841',
        rev: '1',
        title: 'PhD Position on All-Solid-State Batteries',
        workplace: 'Dübendorf',
        workload: '100%',
        entryDate: '23.03.2026',
      });
    });

    it('returns empty array for empty/no-match HTML', () => {
      expect(parseReflineTableListing('', { listingHost: LISTING_HOST, tenant: REFLINE_TENANT })).toEqual([]);
      expect(parseReflineTableListing('<html><body>No jobs right now.</body></html>', { listingHost: LISTING_HOST, tenant: REFLINE_TENANT })).toEqual([]);
    });

    it('deduplicates rows by posId', () => {
      const row = listingRow('55841', '1', 'Duplicate Title', '100%', 'Dübendorf', '23.03.2026');
      const rows = parseReflineTableListing(listingHtml([row, row]), { listingHost: LISTING_HOST, tenant: REFLINE_TENANT });
      expect(rows).toHaveLength(1);
    });
  });

  // ── Shared JSON-LD extraction (factored out of Sprüngli's parser) ──
  describe('parseReflineJobPostingJsonLd', () => {
    it('extracts a valid JobPosting JSON-LD block', () => {
      const jsonLd = jobPostingJsonLd();
      const html = detailHtml(jsonLd);
      const parsed = parseReflineJobPostingJsonLd(html);
      expect(parsed).not.toBeNull();
      expect(parsed?.['@type']).toBe('JobPosting');
      expect(parsed?.jobLocation?.address?.addressRegion).toBe('ZH');
    });

    it('returns null when no JSON-LD script is present', () => {
      expect(parseReflineJobPostingJsonLd('<html><body>No structured data</body></html>')).toBeNull();
    });

    it('returns null on malformed JSON', () => {
      const html = '<html><body><script type="application/ld+json">{not valid json</script></body></html>';
      expect(parseReflineJobPostingJsonLd(html)).toBeNull();
    });
  });

  // ── fetchAllEmpaJobs (mocked fetch) ──
  describe('fetchAllEmpaJobs', () => {
    it('parses a successful listing + detail fetch into full job objects', async () => {
      const jsonLd = jobPostingJsonLd();
      const rows = [listingRow('55841', '1', jsonLd.title as string, '100%', 'Dübendorf', '23.03.2026')];
      const fetchMock = vi.fn(async (url: string) => {
        if (url === LISTING_URL) return htmlResponse(200, listingHtml(rows));
        if (url.includes('/55841/')) return htmlResponse(200, detailHtml(jsonLd));
        return htmlResponse(404, '');
      });
      vi.stubGlobal('fetch', fetchMock);

      const jobs = await fetchAllEmpaJobs();
      expect(jobs).toHaveLength(1);
      const job = jobs[0];
      expect(job.company).toBe(EMPA_COMPANY_NAME);
      expect(job.companyKey).toBe(EMPA_KEY);
      expect(job.canton).toBe('ZH');
      expect(job.postalCode).toBe('8600');
      expect(job.streetAddress).toBe('Ueberlandstrasse 129');
      expect(job.employmentType).toBe('FULL_TIME');
      expect(job.postedDate).toBe('2026-03-23');
      expect(job.hiringOrganizationName).toBe('Empa');
      expect(job.sector).toBe('Università / Ricerca');
    });

    it('returns an empty array when the listing has no jobs', async () => {
      const fetchMock = vi.fn(async () => htmlResponse(200, listingHtml([])));
      vi.stubGlobal('fetch', fetchMock);

      const jobs = await fetchAllEmpaJobs();
      expect(jobs).toEqual([]);
    });

    it('filters out non-Swiss / foreign-office postings', async () => {
      const chJsonLd = jobPostingJsonLd();
      const foreignJsonLd = jobPostingJsonLd({
        title: 'Visiting Scientist Program',
        jobLocation: {
          '@type': 'Place',
          address: {
            '@type': 'PostalAddress',
            addressCountry: 'DE',
            addressLocality: 'München',
            addressRegion: 'BY',
            streetAddress: 'Foreign Street 1',
            postalCode: '80331',
          },
        },
      });
      const rows = [
        listingRow('55841', '1', chJsonLd.title as string, '100%', 'Dübendorf', '23.03.2026'),
        listingRow('99999', '1', foreignJsonLd.title as string, '100%', 'München', '23.03.2026'),
      ];
      const fetchMock = vi.fn(async (url: string) => {
        if (url === LISTING_URL) return htmlResponse(200, listingHtml(rows));
        if (url.includes('/55841/')) return htmlResponse(200, detailHtml(chJsonLd));
        if (url.includes('/99999/')) return htmlResponse(200, detailHtml(foreignJsonLd));
        return htmlResponse(404, '');
      });
      vi.stubGlobal('fetch', fetchMock);

      const jobs = await fetchAllEmpaJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].url).toContain('/55841/');
    });

    it('resolves real per-job location/address across all 3 Empa sites, never leaking the Dübendorf HQ street address onto a St. Gallen/Thun job', async () => {
      const zhJsonLd = jobPostingJsonLd();
      const sgJsonLd = jobPostingJsonLd({
        title: 'Forschungsingenieur/in Mechatronik für biomedizinische Sensorsysteme (a)',
        jobLocation: {
          '@type': 'Place',
          address: {
            '@type': 'PostalAddress',
            addressCountry: 'CH',
            addressLocality: 'St. Gallen',
            addressRegion: 'SG',
            streetAddress: 'Lerchenfeldstrasse 5',
            postalCode: '9014',
          },
        },
      });
      const beJsonLd = jobPostingJsonLd({
        title: 'Postdoc/Engineer in acoustics for laser processing (80-100%)',
        jobLocation: {
          '@type': 'Place',
          address: {
            '@type': 'PostalAddress',
            addressCountry: 'CH',
            addressLocality: 'Thun',
            addressRegion: 'BE',
            streetAddress: 'Feuerwerkerstrasse 39',
            postalCode: '3602',
          },
        },
      });
      const rows = [
        listingRow('55841', '1', zhJsonLd.title as string, '100%', 'Dübendorf', '23.03.2026'),
        listingRow('55842', '1', sgJsonLd.title as string, '80%', 'St. Gallen', '23.03.2026'),
        listingRow('55843', '1', beJsonLd.title as string, '90%', 'Thun', '23.03.2026'),
      ];
      const fetchMock = vi.fn(async (url: string) => {
        if (url === LISTING_URL) return htmlResponse(200, listingHtml(rows));
        if (url.includes('/55841/')) return htmlResponse(200, detailHtml(zhJsonLd));
        if (url.includes('/55842/')) return htmlResponse(200, detailHtml(sgJsonLd));
        if (url.includes('/55843/')) return htmlResponse(200, detailHtml(beJsonLd));
        return htmlResponse(404, '');
      });
      vi.stubGlobal('fetch', fetchMock);

      const jobs = await fetchAllEmpaJobs();
      expect(jobs).toHaveLength(3);

      const zhJob = jobs.find((j) => j.url.includes('/55841/'));
      const sgJob = jobs.find((j) => j.url.includes('/55842/'));
      const beJob = jobs.find((j) => j.url.includes('/55843/'));

      expect(zhJob?.canton).toBe('ZH');
      expect(sgJob?.canton).toBe('SG');
      expect(beJob?.canton).toBe('BE');

      // The bug this parser must avoid: unconditionally falling back to the
      // Dübendorf HQ street address for a job whose resolved canton isn't ZH.
      expect(sgJob?.streetAddress).toBe('Lerchenfeldstrasse 5');
      expect(sgJob?.streetAddress).not.toBe('Ueberlandstrasse 129');
      expect(sgJob?.postalCode).toBe('9014');

      expect(beJob?.streetAddress).toBe('Feuerwerkerstrasse 39');
      expect(beJob?.streetAddress).not.toBe('Ueberlandstrasse 129');
      expect(beJob?.postalCode).toBe('3602');
    });

    it('enriches thin (<50 word) descriptions instead of leaving them indexable as-is', async () => {
      const thinJsonLd = jobPostingJsonLd({ description: '<div>Kurze Stelle.</div>' });
      const rows = [listingRow('55850', '1', thinJsonLd.title as string, '100%', 'Dübendorf', '23.03.2026')];
      const fetchMock = vi.fn(async (url: string) => {
        if (url === LISTING_URL) return htmlResponse(200, listingHtml(rows));
        if (url.includes('/55850/')) return htmlResponse(200, detailHtml(thinJsonLd));
        return htmlResponse(404, '');
      });
      vi.stubGlobal('fetch', fetchMock);

      const jobs = await fetchAllEmpaJobs();
      expect(jobs).toHaveLength(1);
      const wordCount = jobs[0].description.split(/\s+/).filter(Boolean).length;
      expect(wordCount).toBeGreaterThanOrEqual(50);
    });

    it('includes every structured-data field required by Non-Negotiable #3', async () => {
      const jsonLd = jobPostingJsonLd();
      const rows = [listingRow('55841', '1', jsonLd.title as string, '100%', 'Dübendorf', '23.03.2026')];
      const fetchMock = vi.fn(async (url: string) => {
        if (url === LISTING_URL) return htmlResponse(200, listingHtml(rows));
        if (url.includes('/55841/')) return htmlResponse(200, detailHtml(jsonLd));
        return htmlResponse(404, '');
      });
      vi.stubGlobal('fetch', fetchMock);

      const jobs = await fetchAllEmpaJobs();
      const job = jobs[0];
      const structuredDataInputs = [
        'postalCode', 'streetAddress', 'title', 'description',
        'addressLocality', 'addressCountry', 'employmentType', 'postedDate',
        'hiringOrganizationName',
      ];
      for (const field of structuredDataInputs) {
        expect(job).toHaveProperty(field);
        expect(job[field as keyof typeof job]).toBeTruthy();
      }
    });

    // ── Graceful degradation: detail fetch fails (404 / network error) ──
    describe('graceful degradation when detail fetch fails', () => {
      it('still produces a job with a safe-default (non-thin) description when the detail page 404s', async () => {
        const rows = [listingRow('55860', '1', 'Wissenschaftliche/r Mitarbeiter/in Materialwissenschaft', '100%', 'Dübendorf', '23.03.2026')];
        const fetchMock = vi.fn(async (url: string) => {
          if (url === LISTING_URL) return htmlResponse(200, listingHtml(rows));
          if (url.includes('/55860/')) return htmlResponse(404, '');
          return htmlResponse(404, '');
        });
        vi.stubGlobal('fetch', fetchMock);

        const jobs = await fetchAllEmpaJobs();
        expect(jobs).toHaveLength(1);
        const job = jobs[0];
        expect(job.title).toBe('Wissenschaftliche/r Mitarbeiter/in Materialwissenschaft');
        // No JSON-LD available → falls back to Dübendorf HQ defaults.
        expect(job.canton).toBe('ZH');
        expect(job.postalCode).toBe('8600');
        expect(job.streetAddress).toBe('Überlandstrasse 129');
        const wordCount = job.description.split(/\s+/).filter(Boolean).length;
        expect(wordCount).toBeGreaterThanOrEqual(50);
      });

      // NOTE: a fully-failed *listing* fetch (as opposed to a single job's
      // detail fetch) is intentionally NOT swallowed here — it propagates,
      // exactly like every sibling Refline crawler (fetchAllSpruengliJobs
      // has the same shape). `runStandardCrawlerPipeline` in
      // crawler-template.mjs already catches this at the pipeline level
      // (connection-level fetch failures are treated as transient and
      // reported without crashing the wider multi-company crawl run).
    });
  });

  // ── Job Shape Validation (static reference, mirrors sibling crawler tests) ──
  describe('job shape', () => {
    const validJob = {
      id: 'empa-abc123',
      slug: 'test-position-empa-dubendorf',
      slugByLocale: { de: 'test-position-empa-dubendorf' },
      company: 'Empa',
      companyKey: 'empa',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Dübendorf',
      canton: 'ZH',
      url: 'https://apply.refline.ch/673276/9000/pub/1/index.html',
      source: 'Empa Dedicated Parser (Refline 673276)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      addressLocality: 'Dübendorf',
      addressRegion: 'ZH',
      streetAddress: 'Ueberlandstrasse 129',
      postalCode: '8600',
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

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^empa-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
