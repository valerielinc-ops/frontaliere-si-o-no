import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  SPRUENGLI_KEY,
  SPRUENGLI_COMPANY_NAME,
  isSpruengliJob,
  isTrustedDomain,
  parseSpruengliListing,
  parseSpruengliJsonLd,
  fetchAllSpruengliJobs,
} from '../scripts/lib/spruengli-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

const LISTING_URL = 'https://apply.refline.ch/116352/positions.html';

function htmlResponse(status: number, body: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as unknown as Response;
}

function listingRow(posId: string, rev: string, title: string, businessUnit: string, workplace: string, workload: string) {
  return `<tr>
      <td class="position"><a href="https://apply.refline.ch/116352/${posId}/pub/${rev}/index.html" target="_blank">${title}</a></td>
      <td class="businessUnit">${businessUnit}</td>
      <td class="workplace">${workplace}</td>
      <td class="workload">${workload}</td>
    </tr>`;
}

function listingHtml(rows: string[]) {
  return `<html><body><table>${rows.join('\n')}</table></body></html>`;
}

function jobPostingJsonLd(overrides: Record<string, unknown> = {}) {
  return {
    '@context': 'http://schema.org/',
    '@type': 'JobPosting',
    title: 'Konditor-Confiseur*in Abteilung Confiserie (100%)',
    description: '<div>Das 1836 gegründete Schweizer Familienunternehmen zählt heute zu den renommiertesten Confiserien Europas. In unserer Manufaktur in Dietikon suchen wir für die Abteilung Confiserie eine erfahrene, motivierte Person. Deine Aufgaben umfassen das Karamellisieren, das Portionieren und die Herstellung unseres anspruchsvollen Sortiments. Du bringst eine abgeschlossene Ausbildung als Konditor-Confiseur mit sowie mehrjährige Berufserfahrung in einem vergleichbaren Betrieb. Wir bieten attraktive Anstellungsbedingungen, moderne Infrastruktur und ein motiviertes Team in einem traditionsreichen Familienunternehmen.</div>',
    datePosted: '2026-06-01T10:00:00.000000+00:00',
    validThrough: '2026-12-31',
    jobLocationType: '',
    hiringOrganization: {
      '@type': 'Organization',
      name: 'Confiserie Sprüngli AG',
      sameAs: 'http://www.spruengli.ch',
    },
    employmentType: ['FULL_TIME'],
    jobLocation: {
      '@type': 'Place',
      address: {
        '@type': 'PostalAddress',
        addressCountry: 'CH',
        addressLocality: 'Dietikon',
        addressRegion: 'ZH',
        streetAddress: 'Bernstrasse 89',
        postalCode: '8953',
      },
    },
    identifier: { '@type': 'PropertyValue', name: 'Confiserie Sprüngli AG', value: 'refline-116352-master' },
    ...overrides,
  };
}

function detailHtml(jsonLd: Record<string, unknown>, extraBody = '') {
  return `<html><body><h1 id="bTitle">${jsonLd.title}</h1>${extraBody}<script type="application/ld+json">${JSON.stringify(jsonLd)}</script></body></html>`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Sprüngli crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(SPRUENGLI_KEY).toBe('spruengli');
    expect(SPRUENGLI_COMPANY_NAME).toBe('Confiserie Sprüngli AG');
  });

  // ── isCompanyJob ──
  describe('isSpruengliJob', () => {
    it('matches by companyKey', () => {
      expect(isSpruengliJob({ companyKey: 'spruengli' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isSpruengliJob({ company: 'Confiserie Sprüngli AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isSpruengliJob({ url: 'https://www.spruengli.ch/en/jobs/job-vacancies.html' })).toBe(true);
    });

    it('matches by Refline tenant URL', () => {
      expect(isSpruengliJob({ url: 'https://apply.refline.ch/116352/1241/pub/5/index.html' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isSpruengliJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isSpruengliJob(null)).toBe(false);
      expect(isSpruengliJob(undefined)).toBe(false);
      expect(isSpruengliJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://spruengli.ch/en/jobs')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://www.spruengli.ch/en/jobs/job-vacancies.html')).toBe(true);
    });

    it('trusts Refline ATS host', () => {
      expect(isTrustedDomain('https://apply.refline.ch/116352/1241/pub/5/index.html')).toBe(true);
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
      const slug = slugify('Konditor-Confiseur (100%)');
      expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('strips diacritics', () => {
      expect(slugify('Filialleiter*in Zürich')).not.toMatch(/[üäö]/);
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Chauffeur spruengli dietikon')).toBe('chauffeur-spruengli-dietikon');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Listing parser (bespoke — extra businessUnit column) ──
  describe('parseSpruengliListing', () => {
    it('parses table rows with the businessUnit column', () => {
      const html = listingHtml([
        listingRow('1241', '5', 'Chauffeur*euse Kat. C1 (100%)', 'Logistics & Services', 'Dietikon', '100%'),
      ]);
      const rows = parseSpruengliListing(html);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        posId: '1241',
        rev: '5',
        title: 'Chauffeur*euse Kat. C1 (100%)',
        businessUnit: 'Logistics & Services',
        workplace: 'Dietikon',
        workload: '100%',
      });
    });

    it('returns empty array for empty/no-match HTML', () => {
      expect(parseSpruengliListing('')).toEqual([]);
      expect(parseSpruengliListing('<html><body>No jobs right now.</body></html>')).toEqual([]);
    });

    it('deduplicates rows by posId', () => {
      const row = listingRow('1241', '5', 'Duplicate Title', 'Verkauf', 'Zürich', '100%');
      const rows = parseSpruengliListing(listingHtml([row, row]));
      expect(rows).toHaveLength(1);
    });
  });

  // ── JSON-LD extraction ──
  describe('parseSpruengliJsonLd', () => {
    it('extracts a valid JobPosting JSON-LD block', () => {
      const jsonLd = jobPostingJsonLd();
      const html = detailHtml(jsonLd);
      const parsed = parseSpruengliJsonLd(html);
      expect(parsed).not.toBeNull();
      expect(parsed?.['@type']).toBe('JobPosting');
      expect(parsed?.jobLocation?.address?.addressRegion).toBe('ZH');
    });

    it('returns null when no JSON-LD script is present', () => {
      expect(parseSpruengliJsonLd('<html><body>No structured data</body></html>')).toBeNull();
    });

    it('returns null on malformed JSON', () => {
      const html = '<html><body><script type="application/ld+json">{not valid json</script></body></html>';
      expect(parseSpruengliJsonLd(html)).toBeNull();
    });
  });

  // ── fetchAllSpruengliJobs (mocked fetch) ──
  describe('fetchAllSpruengliJobs', () => {
    it('parses a successful listing + detail fetch into full job objects', async () => {
      const zhJsonLd = jobPostingJsonLd();
      const rows = [listingRow('1241', '5', zhJsonLd.title as string, 'Produktion (Konditorei, Confiserie)', 'Dietikon', '100%')];
      const fetchMock = vi.fn(async (url: string) => {
        if (url === LISTING_URL) return htmlResponse(200, listingHtml(rows));
        if (url.includes('/1241/')) return htmlResponse(200, detailHtml(zhJsonLd));
        return htmlResponse(404, '');
      });
      vi.stubGlobal('fetch', fetchMock);

      const jobs = await fetchAllSpruengliJobs();
      expect(jobs).toHaveLength(1);
      const job = jobs[0];
      expect(job.company).toBe(SPRUENGLI_COMPANY_NAME);
      expect(job.companyKey).toBe(SPRUENGLI_KEY);
      expect(job.canton).toBe('ZH');
      expect(job.postalCode).toBe('8953');
      expect(job.streetAddress).toBe('Bernstrasse 89');
      expect(job.employmentType).toBe('FULL_TIME');
      expect(job.postedDate).toBe('2026-06-01');
      expect(job.hiringOrganizationName).toBe('Confiserie Sprüngli AG');
    });

    it('returns an empty array when the listing has no jobs', async () => {
      const fetchMock = vi.fn(async () => htmlResponse(200, listingHtml([])));
      vi.stubGlobal('fetch', fetchMock);

      const jobs = await fetchAllSpruengliJobs();
      expect(jobs).toEqual([]);
    });

    it('filters out non-Swiss / foreign-office postings', async () => {
      const chJsonLd = jobPostingJsonLd();
      const foreignJsonLd = jobPostingJsonLd({
        title: 'International Confectionery Advisor',
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
        listingRow('1241', '5', chJsonLd.title as string, 'Produktion (Konditorei, Confiserie)', 'Dietikon', '100%'),
        listingRow('9999', '1', foreignJsonLd.title as string, 'International', 'München', '100%'),
      ];
      const fetchMock = vi.fn(async (url: string) => {
        if (url === LISTING_URL) return htmlResponse(200, listingHtml(rows));
        if (url.includes('/1241/')) return htmlResponse(200, detailHtml(chJsonLd));
        if (url.includes('/9999/')) return htmlResponse(200, detailHtml(foreignJsonLd));
        return htmlResponse(404, '');
      });
      vi.stubGlobal('fetch', fetchMock);

      const jobs = await fetchAllSpruengliJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].url).toContain('/1241/');
    });

    it('infers canton per-job and never leaks the Zürich HQ street address onto a Geneva job', async () => {
      const zhJsonLd = jobPostingJsonLd();
      const geJsonLd = jobPostingJsonLd({
        title: 'Spécialiste du commerce de détail - Genf Bahnhof (60%)',
        jobLocation: {
          '@type': 'Place',
          address: {
            '@type': 'PostalAddress',
            addressCountry: 'CH',
            addressLocality: 'Genève',
            addressRegion: 'GE',
            streetAddress: 'Place de Cornavin 7',
            postalCode: '1201',
          },
        },
      });
      const rows = [
        listingRow('1241', '5', zhJsonLd.title as string, 'Produktion (Konditorei, Confiserie)', 'Dietikon', '100%'),
        listingRow('1245', '1', geJsonLd.title as string, 'Verkauf', 'Genève', '60%'),
      ];
      const fetchMock = vi.fn(async (url: string) => {
        if (url === LISTING_URL) return htmlResponse(200, listingHtml(rows));
        if (url.includes('/1241/')) return htmlResponse(200, detailHtml(zhJsonLd));
        if (url.includes('/1245/')) return htmlResponse(200, detailHtml(geJsonLd));
        return htmlResponse(404, '');
      });
      vi.stubGlobal('fetch', fetchMock);

      const jobs = await fetchAllSpruengliJobs();
      expect(jobs).toHaveLength(2);

      const zhJob = jobs.find((j) => j.url.includes('/1241/'));
      const geJob = jobs.find((j) => j.url.includes('/1245/'));
      expect(zhJob?.canton).toBe('ZH');
      expect(geJob?.canton).toBe('GE');

      // The bug this parser must avoid: unconditionally falling back to the
      // Zürich HQ street address for a job whose resolved canton isn't ZH.
      expect(geJob?.streetAddress).toBe('Place de Cornavin 7');
      expect(geJob?.streetAddress).not.toBe('Bahnhofstrasse 21');
      expect(geJob?.postalCode).toBe('1201');
      expect(geJob?.postalCode).not.toBe('8001');
    });

    it('enriches thin (<50 word) descriptions instead of leaving them indexable as-is', async () => {
      const thinJsonLd = jobPostingJsonLd({ description: '<div>Kurze Stelle.</div>' });
      const rows = [listingRow('1300', '1', thinJsonLd.title as string, 'Verkauf', 'Zürich', '100%')];
      const fetchMock = vi.fn(async (url: string) => {
        if (url === LISTING_URL) return htmlResponse(200, listingHtml(rows));
        if (url.includes('/1300/')) return htmlResponse(200, detailHtml(thinJsonLd));
        return htmlResponse(404, '');
      });
      vi.stubGlobal('fetch', fetchMock);

      const jobs = await fetchAllSpruengliJobs();
      expect(jobs).toHaveLength(1);
      const wordCount = jobs[0].description.split(/\s+/).filter(Boolean).length;
      expect(wordCount).toBeGreaterThanOrEqual(50);
    });

    it('includes every structured-data field required by Non-Negotiable #3', async () => {
      const zhJsonLd = jobPostingJsonLd();
      const rows = [listingRow('1241', '5', zhJsonLd.title as string, 'Produktion (Konditorei, Confiserie)', 'Dietikon', '100%')];
      const fetchMock = vi.fn(async (url: string) => {
        if (url === LISTING_URL) return htmlResponse(200, listingHtml(rows));
        if (url.includes('/1241/')) return htmlResponse(200, detailHtml(zhJsonLd));
        return htmlResponse(404, '');
      });
      vi.stubGlobal('fetch', fetchMock);

      const jobs = await fetchAllSpruengliJobs();
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
  });

  // ── Job Shape Validation (static reference, mirrors sibling crawler tests) ──
  describe('job shape', () => {
    const validJob = {
      id: 'spruengli-abc123',
      slug: 'test-position-spruengli-dietikon',
      slugByLocale: { de: 'test-position-spruengli-dietikon' },
      company: 'Confiserie Sprüngli AG',
      companyKey: 'spruengli',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Dietikon',
      canton: 'ZH',
      url: 'https://apply.refline.ch/116352/9000/pub/1/index.html',
      source: 'Confiserie Sprüngli Dedicated Parser (Refline 116352)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      addressLocality: 'Dietikon',
      addressRegion: 'ZH',
      streetAddress: 'Bernstrasse 89',
      postalCode: '8953',
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
      expect(validJob.id).toMatch(/^spruengli-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
