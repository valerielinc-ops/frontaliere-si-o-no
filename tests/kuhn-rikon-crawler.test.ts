import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  KUHN_RIKON_KEY,
  KUHN_RIKON_COMPANY_NAME,
  KUHN_RIKON_COMPANY_DOMAIN,
  isKuhnRikonJob,
  isTrustedDomain,
  resolveAddress,
  detectCategory,
  detectExperienceLevel,
  detectEmploymentType,
  fetchAllKuhnRikonJobs,
} from '../scripts/lib/kuhn-rikon-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

const LISTING_URL = 'https://my.jobalino.ch/custel_jobExternalList/kuhn-rikon';

function textResponse(status: number, body: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as unknown as Response;
}

function jobalinoTile({
  id, slug, title, workload = '', jobtype = 'Festanstellung', address = '',
  zip = '', city = '', country = 'Schweiz', filter3 = '',
}: {
  id: string; slug: string; title: string; workload?: string; jobtype?: string;
  address?: string; zip?: string; city?: string; country?: string; filter3?: string;
}) {
  return `<a href="https://my.jobalino.ch/job/${id}/${slug}" class="reflink">
      <span class="title">${title}</span>
      <span class="workload">${workload}</span>
      <span class="jobtype">${jobtype}</span>
      <span class="company">Kuhn Rikon AG</span>
      <span class="address">${address}</span>
      <span class="zip">${zip}</span>
      <span class="city">${city}</span>
      <span class="country">${country}</span>
      <span class="filter3">${filter3}</span>
    </a>`;
}

function listingJsonp(tilesHtml: string, error = '') {
  const payload = JSON.stringify({ error, html: `<div>${tilesHtml}</div>` });
  return `jb_ShowJsonHtml(${payload}, 'kuhn-rikon');`;
}

function jobPostingJsonLd(overrides: Record<string, unknown> = {}) {
  return {
    '@context': 'http://schema.org/',
    '@type': 'JobPosting',
    title: 'Verkaufsberater/in Outlet Landquart (50% - 80%)',
    description: '<div>Für unseren Outlet-Store in Landquart suchen wir per sofort oder nach '
      + 'Vereinbarung eine motivierte, kundenorientierte Verkaufspersönlichkeit. Zu Ihren '
      + 'Hauptaufgaben gehören die kompetente und freundliche Beratung unserer Kundschaft, die '
      + 'aktive Verkaufsförderung unserer hochwertigen Kuhn Rikon Produkte, die Warenpräsentation '
      + 'sowie allgemeine Verkaufstätigkeiten inklusive Kassenführung und Lagerbewirtschaftung. '
      + 'Sie verfügen über eine abgeschlossene Ausbildung im Detailhandel oder vergleichbare '
      + 'Erfahrung im Verkauf, sind flexibel einsetzbar und schätzen den direkten Kontakt zu '
      + 'Kundinnen und Kunden. Wir bieten Ihnen eine vielseitige Tätigkeit in einem '
      + 'traditionsreichen Schweizer Familienunternehmen, attraktive Personalrabatte sowie ein '
      + 'motiviertes Team.</div>',
    datePosted: '2026-06-15T08:00:00.000000+00:00',
    validThrough: '2026-12-31',
    hiringOrganization: { '@type': 'Organization', name: 'Kuhn Rikon AG', sameAs: 'https://www.kuhnrikon.com' },
    employmentType: ['FULL_TIME'],
    jobLocation: {
      '@type': 'Place',
      address: {
        '@type': 'PostalAddress',
        addressCountry: 'CH',
        addressLocality: 'Landquart',
        addressRegion: 'GR',
        streetAddress: 'Bahnhofstrasse 12',
        postalCode: '7302',
      },
    },
    ...overrides,
  };
}

function detailHtml(jsonLd: Record<string, unknown>) {
  return `<html><body><h1>${jsonLd.title}</h1><script type="application/ld+json">${JSON.stringify(jsonLd)}</script></body></html>`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Kuhn Rikon crawler parser', () => {
  // ── Constants ──
  it('exports valid company key, name and domain', () => {
    expect(KUHN_RIKON_KEY).toBe('kuhn-rikon');
    expect(KUHN_RIKON_COMPANY_NAME).toBe('Kuhn Rikon');
    expect(KUHN_RIKON_COMPANY_DOMAIN).toBe('kuhnrikon.com');
  });

  // ── isKuhnRikonJob ──
  describe('isKuhnRikonJob', () => {
    it('matches by companyKey', () => {
      expect(isKuhnRikonJob({ companyKey: 'kuhn-rikon' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isKuhnRikonJob({ company: 'Kuhn Rikon' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isKuhnRikonJob({ url: 'https://kuhnrikon.com/ch_de/karriere' })).toBe(true);
    });

    it('matches by Jobalino tenant URL when company name confirms it', () => {
      expect(isKuhnRikonJob({ company: 'Kuhn Rikon AG', url: 'https://my.jobalino.ch/job/abc123/verkaufsberater' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isKuhnRikonJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isKuhnRikonJob(null)).toBe(false);
      expect(isKuhnRikonJob(undefined)).toBe(false);
      expect(isKuhnRikonJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://kuhnrikon.com/ch_de/karriere')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://www.kuhnrikon.com/ch_de/karriere')).toBe(true);
    });

    it('trusts the Jobalino ATS host', () => {
      expect(isTrustedDomain('https://my.jobalino.ch/job/abc123/verkaufsberater')).toBe(true);
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
    it('converts a title to a URL-safe slug', () => {
      const slug = slugify('Verkaufsberater/in Outlet Landquart (50%)');
      expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('strips diacritics', () => {
      expect(slugify('Verkäufer/in Zürich')).not.toMatch(/[üäö]/);
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── resolveAddress (city-gated, NEVER canton-only) ──
  describe('resolveAddress', () => {
    it('fills the HQ street when the tile city matches Rikon (im Tösstal)', () => {
      expect(resolveAddress({ city: 'Rikon im Tösstal' })).toEqual({
        city: 'Rikon im Tösstal',
        postalCode: '8486',
        streetAddress: 'Neschwilerstrasse 4',
      });
    });

    it('fills the HQ street when the tile has no city at all', () => {
      expect(resolveAddress({})).toEqual({
        city: 'Rikon im Tösstal',
        postalCode: '8486',
        streetAddress: 'Neschwilerstrasse 4',
      });
    });

    it('keeps the tile’s own street/zip/city untouched when present', () => {
      expect(resolveAddress({
        city: 'Landquart', zip: '7302', address: 'Bahnhofstrasse 12',
      })).toEqual({
        city: 'Landquart',
        postalCode: '7302',
        streetAddress: 'Bahnhofstrasse 12',
      });
    });

    // Negative control (Non-Negotiable-adjacent requirement): a same-canton
    // (ZH) but different-city posting must NEVER inherit the Rikon HQ street.
    it('NEGATIVE CONTROL: does NOT inherit the HQ street for Winterthur (same canton ZH, different city)', () => {
      const resolved = resolveAddress({ city: 'Winterthur' });
      expect(resolved.city).toBe('Winterthur');
      expect(resolved.streetAddress).not.toBe('Neschwilerstrasse 4');
      expect(resolved.streetAddress).toBe('');
      expect(resolved.postalCode).not.toBe('8486');
      expect(resolved.postalCode).toBe('');
    });

    it('NEGATIVE CONTROL: does NOT inherit the HQ street for Zürich city (same canton ZH, different city)', () => {
      const resolved = resolveAddress({ city: 'Zürich' });
      expect(resolved.streetAddress).toBe('');
      expect(resolved.postalCode).toBe('');
    });

    it('decodes HTML entities in the tile city/address before matching', () => {
      const resolved = resolveAddress({ city: 'Rikon&nbsp;im&nbsp;Tösstal' });
      expect(resolved.streetAddress).toBe('Neschwilerstrasse 4');
    });
  });

  // ── detectCategory ──
  describe('detectCategory', () => {
    it('detects retail/sales roles', () => {
      expect(detectCategory('Verkaufsberater/in Outlet Landquart')).toBe('Vendita al dettaglio');
      expect(detectCategory('Consultante vente Globus Genève')).toBe('Vendita al dettaglio');
    });

    it('detects production roles', () => {
      expect(detectCategory('Produktionsmitarbeiter/in 100%')).toBe('Produzione');
    });

    it('detects logistics roles', () => {
      expect(detectCategory('Mitarbeiter/in Lager und Logistik')).toBe('Logistica');
    });

    it('detects admin roles', () => {
      expect(detectCategory('Sachbearbeiter/in Administration')).toBe('Amministrazione');
    });

    it('falls back to Altro for unmatched titles', () => {
      expect(detectCategory('Something Unrelated Title')).toBe('Altro');
    });
  });

  // ── detectExperienceLevel ──
  describe('detectExperienceLevel', () => {
    it('detects intern/apprentice roles', () => {
      expect(detectExperienceLevel('Lernende/r Detailhandel')).toBe('intern');
    });

    it('detects senior/lead roles', () => {
      expect(detectExperienceLevel('Filialleiter/in Outlet')).toBe('senior');
    });

    it('defaults to mid', () => {
      expect(detectExperienceLevel('Verkaufsberater/in')).toBe('mid');
    });
  });

  // ── detectEmploymentType (workload-in-title nuance) ──
  describe('detectEmploymentType', () => {
    it('detects full-time from an explicit keyword', () => {
      expect(detectEmploymentType('', 'Vollzeit Position')).toBe('FULL_TIME');
    });

    it('detects part-time from an explicit keyword', () => {
      expect(detectEmploymentType('', 'Teilzeit Position')).toBe('PART_TIME');
    });

    // The nuance found during investigation: Kuhn Rikon's Jobalino tiles leave
    // `workload` empty; the percentage instead lives as a suffix on the title
    // itself (e.g. "... (50% - 80%)"), which must still resolve correctly.
    it('detects part-time from a workload percentage embedded in the title (empty tile.workload)', () => {
      expect(detectEmploymentType('', 'Verkaufsberater/in Outlet Landquart (50% - 80%)')).toBe('PART_TIME');
    });

    it('detects full-time from a high workload percentage embedded in the title', () => {
      expect(detectEmploymentType('', 'Verkaufsberater/in Outlet Landquart (90% - 100%)')).toBe('FULL_TIME');
    });

    it('detects full-time from a single 100% figure', () => {
      expect(detectEmploymentType('100%', 'Produktionsmitarbeiter/in')).toBe('FULL_TIME');
    });

    it('detects part-time from a single low percentage figure', () => {
      expect(detectEmploymentType('60%', 'Verkaufsberater/in')).toBe('PART_TIME');
    });

    it('defaults to full-time with no signal at all', () => {
      expect(detectEmploymentType('', 'Verkaufsberater/in')).toBe('FULL_TIME');
    });
  });

  // ── fetchAllKuhnRikonJobs (mocked fetch, Jobalino JSONP + JSON-LD detail) ──
  describe('fetchAllKuhnRikonJobs', () => {
    it('parses a successful listing + detail fetch into a full job object', async () => {
      const jsonLd = jobPostingJsonLd();
      const tile = jobalinoTile({
        id: 'a1b2c3d4e5f6', slug: 'verkaufsberater-in-outlet-landquart',
        title: jsonLd.title as string, workload: '', jobtype: 'Festanstellung',
        address: 'Bahnhofstrasse 12', zip: '7302', city: 'Landquart', country: 'Schweiz',
        filter3: 'Verkauf',
      });
      const fetchMock = vi.fn(async (url: string) => {
        if (url === LISTING_URL) return textResponse(200, listingJsonp(tile));
        if (url.includes('/job/a1b2c3d4e5f6/')) return textResponse(200, detailHtml(jsonLd));
        return textResponse(404, '');
      });
      vi.stubGlobal('fetch', fetchMock);

      const jobs = await fetchAllKuhnRikonJobs();
      expect(jobs).toHaveLength(1);
      const job = jobs[0];
      expect(job.company).toBe(KUHN_RIKON_COMPANY_NAME);
      expect(job.companyKey).toBe(KUHN_RIKON_KEY);
      expect(job.canton).toBe('GR');
      expect(job.postalCode).toBe('7302');
      expect(job.streetAddress).toBe('Bahnhofstrasse 12');
      expect(job.employmentType).toBe('PART_TIME'); // title carries "(50% - 80%)"
      expect(job.postedDate).toBe('2026-06-15');
      expect(job.hiringOrganizationName).toBe(KUHN_RIKON_COMPANY_NAME);
      expect(job.sector).not.toMatch(/sanit|ospedal/i);
    });

    it('returns an empty array when the listing has no jobs', async () => {
      const fetchMock = vi.fn(async () => textResponse(200, listingJsonp('')));
      vi.stubGlobal('fetch', fetchMock);

      const jobs = await fetchAllKuhnRikonJobs();
      expect(jobs).toEqual([]);
    });

    it('returns an empty array when Jobalino reports a company-not-found error', async () => {
      const fetchMock = vi.fn(async () => textResponse(200, listingJsonp('', 'Die Firma wurde nicht gefunden.')));
      vi.stubGlobal('fetch', fetchMock);

      const jobs = await fetchAllKuhnRikonJobs();
      expect(jobs).toEqual([]);
    });

    it('returns an empty array when the listing fetch throws', async () => {
      const fetchMock = vi.fn(async () => { throw new Error('network unreachable'); });
      vi.stubGlobal('fetch', fetchMock);

      const jobs = await fetchAllKuhnRikonJobs();
      expect(jobs).toEqual([]);
    });

    it('still builds a job when the detail-page fetch fails (falls back to the listing tile)', async () => {
      const tile = jobalinoTile({
        id: 'f0f0f0f0f0f0', slug: 'produktionsmitarbeiter',
        title: 'Produktionsmitarbeiter/in 100%', workload: '100%', jobtype: 'Festanstellung',
        city: 'Rikon im Tösstal', country: 'Schweiz',
      });
      const fetchMock = vi.fn(async (url: string) => {
        if (url === LISTING_URL) return textResponse(200, listingJsonp(tile));
        return textResponse(404, ''); // non-retryable, keeps the test fast
      });
      vi.stubGlobal('fetch', fetchMock);

      const jobs = await fetchAllKuhnRikonJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].title).toBe('Produktionsmitarbeiter/in 100%');
      expect(jobs[0].streetAddress).toBe('Neschwilerstrasse 4');
      expect(jobs[0].postalCode).toBe('8486');
      expect(jobs[0].employmentType).toBe('FULL_TIME');
    });

    it('deduplicates tiles sharing the same Jobalino id', async () => {
      const jsonLd = jobPostingJsonLd();
      const tile = jobalinoTile({
        id: 'dad0000001', slug: 'verkaufsberater-in-outlet-landquart',
        title: jsonLd.title as string, city: 'Landquart',
      });
      const fetchMock = vi.fn(async (url: string) => {
        if (url === LISTING_URL) return textResponse(200, listingJsonp(tile + tile));
        if (url.includes('/job/dad0000001/')) return textResponse(200, detailHtml(jsonLd));
        return textResponse(404, '');
      });
      vi.stubGlobal('fetch', fetchMock);

      const jobs = await fetchAllKuhnRikonJobs();
      expect(jobs).toHaveLength(1);
    });

    it('parses a tile whose slug has a Jobalino collision-disambiguation suffix (regression #5998)', async () => {
      const jsonLd = jobPostingJsonLd();
      const tile = jobalinoTile({
        id: 'ffee00001122', slug: 'verkaufsberater-in-outlet-landquart_0002',
        title: jsonLd.title as string, city: 'Landquart',
      });
      const fetchMock = vi.fn(async (url: string) => {
        if (url === LISTING_URL) return textResponse(200, listingJsonp(tile));
        if (url.includes('/job/ffee00001122/')) return textResponse(200, detailHtml(jsonLd));
        return textResponse(404, '');
      });
      vi.stubGlobal('fetch', fetchMock);

      const jobs = await fetchAllKuhnRikonJobs();
      expect(jobs).toHaveLength(1);
    });

    it('never leaks the Rikon HQ street address onto a same-canton different-city job (Zürich)', async () => {
      const rikonJsonLd = jobPostingJsonLd({
        title: 'Sachbearbeiter/in Administration Rikon (100%)',
        jobLocation: {
          '@type': 'Place',
          address: {
            '@type': 'PostalAddress', addressCountry: 'CH', addressLocality: 'Rikon im Tösstal',
            addressRegion: 'ZH', streetAddress: '', postalCode: '',
          },
        },
      });
      const zhJsonLd = jobPostingJsonLd({
        title: 'Verkaufsberater/in Filiale Zürich (100%)',
        jobLocation: {
          '@type': 'Place',
          address: {
            '@type': 'PostalAddress', addressCountry: 'CH', addressLocality: 'Zürich',
            addressRegion: 'ZH', streetAddress: '', postalCode: '',
          },
        },
      });
      const rikonTile = jobalinoTile({
        id: 'facade00001', slug: 'sachbearbeiter-administration-rikon',
        title: rikonJsonLd.title as string, city: 'Rikon im Tösstal', country: 'Schweiz',
      });
      const zhTile = jobalinoTile({
        id: 'cafe00000001', slug: 'verkaufsberater-filiale-zuerich',
        title: zhJsonLd.title as string, city: 'Zürich', country: 'Schweiz',
      });
      const fetchMock = vi.fn(async (url: string) => {
        if (url === LISTING_URL) return textResponse(200, listingJsonp(rikonTile + zhTile));
        if (url.includes('/job/facade00001/')) return textResponse(200, detailHtml(rikonJsonLd));
        if (url.includes('/job/cafe00000001/')) return textResponse(200, detailHtml(zhJsonLd));
        return textResponse(404, '');
      });
      vi.stubGlobal('fetch', fetchMock);

      const jobs = await fetchAllKuhnRikonJobs();
      expect(jobs).toHaveLength(2);

      const rikonJob = jobs.find((j) => j.url.includes('/facade00001/'));
      const zhJob = jobs.find((j) => j.url.includes('/cafe00000001/'));
      expect(rikonJob?.streetAddress).toBe('Neschwilerstrasse 4');
      expect(rikonJob?.postalCode).toBe('8486');

      // The negative control at the fetch-pipeline level, not just the unit level.
      expect(zhJob?.canton).toBe('ZH');
      expect(zhJob?.streetAddress).not.toBe('Neschwilerstrasse 4');
      expect(zhJob?.streetAddress).toBe('');
      expect(zhJob?.postalCode).not.toBe('8486');
      expect(zhJob?.postalCode).toBe('');
    });

    it('enriches thin (<50 word) descriptions instead of leaving them indexable as-is', async () => {
      const thinJsonLd = jobPostingJsonLd({ description: '<div>Kurze Stelle.</div>' });
      const tile = jobalinoTile({
        id: 'beef00000001', slug: 'kurze-stelle', title: thinJsonLd.title as string, city: 'Landquart',
      });
      const fetchMock = vi.fn(async (url: string) => {
        if (url === LISTING_URL) return textResponse(200, listingJsonp(tile));
        if (url.includes('/job/beef00000001/')) return textResponse(200, detailHtml(thinJsonLd));
        return textResponse(404, '');
      });
      vi.stubGlobal('fetch', fetchMock);

      const jobs = await fetchAllKuhnRikonJobs();
      expect(jobs).toHaveLength(1);
      const wordCount = jobs[0].description.split(/\s+/).filter(Boolean).length;
      expect(wordCount).toBeGreaterThanOrEqual(50);
    });

    it('never leaks recruiter email/phone PII through the parsed description', async () => {
      const jsonLd = jobPostingJsonLd();
      const tile = jobalinoTile({
        id: 'deaf00000001', slug: 'verkaufsberater', title: jsonLd.title as string, city: 'Landquart',
      });
      const fetchMock = vi.fn(async (url: string) => {
        if (url === LISTING_URL) return textResponse(200, listingJsonp(tile));
        if (url.includes('/job/deaf00000001/')) return textResponse(200, detailHtml(jsonLd));
        return textResponse(404, '');
      });
      vi.stubGlobal('fetch', fetchMock);

      const jobs = await fetchAllKuhnRikonJobs();
      expect(jobs[0].description).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
      expect(jobs[0].description).not.toMatch(/\+41\s?\d{2}\s?\d{3}\s?\d{2}\s?\d{2}/);
    });

    it('includes every structured-data field required by Non-Negotiable #3', async () => {
      const jsonLd = jobPostingJsonLd();
      const tile = jobalinoTile({
        id: 'aced0000001', slug: 'verkaufsberater', title: jsonLd.title as string, city: 'Landquart',
        address: 'Bahnhofstrasse 12', zip: '7302',
      });
      const fetchMock = vi.fn(async (url: string) => {
        if (url === LISTING_URL) return textResponse(200, listingJsonp(tile));
        if (url.includes('/job/aced0000001/')) return textResponse(200, detailHtml(jsonLd));
        return textResponse(404, '');
      });
      vi.stubGlobal('fetch', fetchMock);

      const jobs = await fetchAllKuhnRikonJobs();
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

    it('skips a tile whose title cannot be resolved at all (no JSON-LD title, no tile title)', async () => {
      const brokenTile = `<a href="https://my.jobalino.ch/job/facebeef0001/no-title" class="reflink">
        <span class="title"></span>
        <span class="workload"></span>
      </a>`;
      const fetchMock = vi.fn(async (url: string) => {
        if (url === LISTING_URL) return textResponse(200, listingJsonp(brokenTile));
        return textResponse(404, '');
      });
      vi.stubGlobal('fetch', fetchMock);

      const jobs = await fetchAllKuhnRikonJobs();
      expect(jobs).toEqual([]);
    });
  });

  // ── Job Shape Validation (static reference, mirrors sibling crawler tests) ──
  describe('job shape', () => {
    const validJob = {
      id: 'kuhn-rikon-abc123',
      slug: 'test-position-kuhn-rikon-landquart',
      slugByLocale: { de: 'test-position-kuhn-rikon-landquart' },
      company: 'Kuhn Rikon',
      companyKey: 'kuhn-rikon',
      companyDomain: 'kuhnrikon.com',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation, long enough to pass any thin-content guard checks applied elsewhere in the pipeline for indexable pages.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Landquart',
      canton: 'GR',
      url: 'https://my.jobalino.ch/job/abc123/test-position',
      source: 'Kuhn Rikon Dedicated Parser (Jobalino)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      addressLocality: 'Landquart',
      addressRegion: 'GR',
      streetAddress: 'Bahnhofstrasse 12',
      postalCode: '7302',
      addressCountry: 'CH',
      country: 'CH',
      employmentType: 'FULL_TIME',
      postedDate: new Date().toISOString().split('T')[0],
      hiringOrganizationName: 'Kuhn Rikon',
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

    it('slug only contains the source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with the company key', () => {
      expect(validJob.id).toMatch(/^kuhn-rikon-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
