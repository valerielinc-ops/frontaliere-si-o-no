import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  SWISS_LIFE_KEY,
  SWISS_LIFE_COMPANY_NAME,
  assertSwissLifeNationalReadComplete,
  fetchAllSwissLifeJobs,
  fetchSwissListings,
  isSwissLifeJob,
  isTrustedDomain,
  parseWorkdayLocation,
  resolveSwissLifeLocation,
} from '../scripts/lib/swiss-life-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';
import { resolveLocalityAddress } from '../scripts/lib/swiss-structured-address.mjs';
import { inferAnyCanton } from '../scripts/lib/target-swiss-locations.mjs';

function makeListing(id: string, locationsText = 'Zürich, Switzerland') {
  return {
    externalPath: `/job/${id}`,
    title: `Swiss Life job ${id}`,
    locationsText,
    bulletFields: [id],
  };
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    json: async () => body,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Swiss Life crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(SWISS_LIFE_KEY).toBe('swiss-life');
    expect(SWISS_LIFE_COMPANY_NAME).toBe('Swiss Life');
  });

  it('keeps the city before a mixed canton/country suffix', () => {
    expect(parseWorkdayLocation('Sion – VS, Suisse romande')).toBe('Sion');
    expect(parseWorkdayLocation('Sion-VS')).toBe('Sion');
    expect(parseWorkdayLocation('Visp-Switzerland')).toBe('Visp');
    expect(parseWorkdayLocation('ST-MAURICE')).toBe('ST-MAURICE');
  });

  it('resolves Swiss locations across cantons', () => {
    expect(resolveSwissLifeLocation({ location: 'Zürich, Switzerland' })).toBe('Zürich');
    expect(resolveSwissLifeLocation({ location: 'Lugano, Ticino' })).toBe('Lugano');
  });

  it('prefers a concrete additional locality over a country-only primary descriptor', () => {
    expect(resolveSwissLifeLocation({
      location: 'Switzerland',
      additionalLocations: [{ descriptor: 'Zürich, Switzerland' }],
    })).toBe('Zürich');
  });

  it('fails closed when no Swiss locality and canton can be resolved', () => {
    expect(resolveSwissLifeLocation({ location: 'Switzerland' })).toBe('');
    expect(resolveSwissLifeLocation({ location: 'Arezzo, Italy' })).toBe('');
  });

  // ── Agency labels are not localities (issue 9838) ──
  //
  // Workday names many Swiss Life postings after the general agency (`GA …`)
  // or its branch office (`GS …`). From `GA Wil` only the canton can be
  // inferred: the parser used to accept it, and `resolveLocalityAddress` then
  // published the canton capital's full tuple (`St. Gallen`, `Gallusstrasse
  // 14`, `9000`). The workplace is never deduced from the agency region.
  describe('agency labels (issue 9838)', () => {
    it('does not publish a GA label as a locality', () => {
      expect(resolveSwissLifeLocation({ location: 'GA Wil' })).toBe('');
    });

    it('takes the next candidate that is a known municipality', () => {
      expect(resolveSwissLifeLocation({
        location: 'GA Wil',
        additionalLocations: ['Wil SG'],
      })).toBe('Wil SG');
    });

    it('does not turn Rapperswil Rathausstrasse into St. Gallen', () => {
      // `Rapperswil` is a BFS homonym (Rapperswil BE; in SG only the former
      // commune now part of Rapperswil-Jona) and the posting carries no NPA
      // or canton: the geography is unknown, so the vacancy is skipped.
      const city = resolveSwissLifeLocation({
        location: 'Rapperswil Rathausstrasse',
        jobRequisitionLocation: { descriptor: 'Rapperswil Rathausstrasse' },
      }, 'Rapperswil Rathausstrasse');
      expect(city).not.toBe('St. Gallen');
      expect(city).toBe('');
    });

    // Replay of the live Workday detail candidates (Swiss_Life_Career_Site,
    // 2026-09-25): `listing` is the listing `locationsText`, the others are
    // `jobPostingInfo.location`, `additionalLocations` and
    // `jobRequisitionLocation.descriptor`. `expected` is the published
    // locality, '' when the vacancy must be skipped.
    const LIVE_REPLAY = [
      { listing: 'GA Graubünden', location: 'GA Graubünden', additional: [], requisition: 'GA Graubünden', expected: '' },
      { listing: 'GA Basel', location: 'GA Basel', additional: [], requisition: 'GA Basel', expected: '' },
      { listing: '2 Locations', location: 'GA Wil', additional: ['GS Rapperswil'], requisition: 'GA Wil', expected: '' },
      { listing: '2 Locations', location: 'GA Neuchâtel-Jura', additional: ['GS La Chaux-de-Fonds'], requisition: 'GA Neuchâtel-Jura', expected: '' },
      { listing: '2 Locations', location: 'GA Neuchâtel-Jura', additional: ['GS Delémont'], requisition: 'GA Neuchâtel-Jura', expected: '' },
      { listing: '2 Locations', location: 'GA Glarus-Rheintal', additional: ['GS Glarus'], requisition: 'GA Glarus-Rheintal', expected: '' },
      { listing: '2 Locations', location: 'GS Yverdon-les-Bains', additional: ['GS Montreux'], requisition: 'GA Lausanne', expected: '' },
      { listing: '2 Locations', location: 'GA St. Gallen-Appenzellerland', additional: ['GS Appenzell'], requisition: 'GA St. Gallen-Appenzellerland', expected: '' },
      { listing: 'Rapperswil Rathausstrasse', location: 'Rapperswil Rathausstrasse', additional: [], requisition: 'Rapperswil Rathausstrasse', expected: '' },
      { listing: '2 Locations', location: 'GA Thurgau', additional: ['Weinfelden'], requisition: 'GA Thurgau', expected: 'Weinfelden' },
      { listing: '2 Locations', location: 'GA Glarus-Rheintal', additional: ['Buchs SG'], requisition: 'GA Glarus-Rheintal', expected: 'Buchs SG' },
      { listing: '2 Locations', location: 'GA Baden', additional: ['Baden'], requisition: 'GA Baden', expected: 'Baden' },
      { listing: '2 Locations', location: 'Steinhausen', additional: ['GA Zug'], requisition: 'GA Zug', expected: 'Steinhausen' },
      { listing: '2 Locations', location: 'Sion', additional: ['GS Martigny'], requisition: 'AG Sion-Valais romand', expected: 'Sion' },
      { listing: '2 Locations', location: 'Meilen', additional: ['GS Zürich City'], requisition: 'GA Zürich-Pfannenstiel', expected: 'Meilen' },
      { listing: '2 Locations', location: 'Granges-Paccot', additional: ['GS Bulle'], requisition: 'AG Canton de Fribourg', expected: 'Granges-Paccot' },
      { listing: '2 Locations', location: 'Morges', additional: ['GS Gland'], requisition: 'GA Morges-La Côte', expected: 'Morges' },
      { listing: '2 Locations', location: 'Uster', additional: ['GA Uster'], requisition: 'GA Uster', expected: 'Uster' },
      { listing: '2 Locations', location: 'St. Gallen', additional: ['GS Appenzell'], requisition: 'GA St. Gallen-Appenzellerland', expected: 'St. Gallen' },
      { listing: '2 Locations', location: 'Schaffhausen', additional: ['GS Bülach'], requisition: 'GA Schaffhausen', expected: 'Schaffhausen' },
      { listing: '3 Locations', location: 'Schwyz', additional: ['GS Altdorf', 'GS Lachen'], requisition: 'GA Schwyz-Urnerland', expected: 'Schwyz' },
      { listing: '3 Locations', location: 'Lausanne', additional: ['GS Yverdon-les-Bains', 'GS Montreux'], requisition: 'GA Lausanne', expected: 'Lausanne' },
      { listing: '3 Locations', location: 'Kriens', additional: ['GS Stans', 'GS Sarnen'], requisition: 'GA Luzern-Stans', expected: 'Kriens' },
      { listing: '3 Locations', location: 'Zürich', additional: ['Weinfelden', 'Bern'], requisition: 'Zurich Binz Center', expected: 'Zürich' },
      { listing: 'Wil SG', location: 'Wil SG', additional: [], requisition: 'GA Wil', expected: 'Wil SG' },
      { listing: 'Buchs SG', location: 'Buchs SG', additional: [], requisition: 'GA Glarus-Rheintal', expected: 'Buchs SG' },
      { listing: 'Bern', location: 'Bern', additional: [], requisition: 'Bern Münzgraben', expected: 'Bern' },
    ];

    it.each(LIVE_REPLAY)('replays $location + $additional → "$expected"', ({ listing, location, additional, requisition, expected }) => {
      const city = resolveSwissLifeLocation({
        location,
        additionalLocations: additional,
        jobRequisitionLocation: { descriptor: requisition },
      }, listing);
      expect(city).toBe(expected);
    });

    it('publishes no canton-capital tuple over the live replay (issue 9838 metric)', () => {
      // Same chain as fetchAllSwissLifeJobs: city → canton → locality address.
      const published = LIVE_REPLAY.flatMap(({ listing, location, additional, requisition }) => {
        const city = resolveSwissLifeLocation({
          location,
          additionalLocations: additional,
          jobRequisitionLocation: { descriptor: requisition },
        }, listing);
        const canton = city ? inferAnyCanton(city) : '';
        if (!city || !canton) return [];
        return [{ location: city, canton, ...resolveLocalityAddress({ city, canton }) }];
      });
      expect(published.filter((job) => job.location !== job.addressLocality)).toEqual([]);
      expect(published.filter((job) => /^G[AS] /.test(job.location))).toEqual([]);
      expect(published).toHaveLength(LIVE_REPLAY.filter((row) => row.expected).length);
    });
  });

  // ── isCompanyJob ──
  describe('isSwissLifeJob', () => {
    it('matches by companyKey', () => {
      expect(isSwissLifeJob({ companyKey: 'swiss-life' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isSwissLifeJob({ company: 'Swiss Life' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isSwissLifeJob({ url: 'https://swisslife.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isSwissLifeJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isSwissLifeJob(null)).toBe(false);
      expect(isSwissLifeJob(undefined)).toBe(false);
      expect(isSwissLifeJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://swisslife.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.swisslife.ch/job/456')).toBe(true);
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
      expect(slugify('Developer swiss-life ch')).toBe('developer-swiss-life-ch');
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
      id: 'swiss-life-abc123',
      slug: 'test-position-swiss-life-ch',
      slugByLocale: { de: 'test-position-swiss-life-ch' },
      company: 'Swiss Life',
      companyKey: 'swiss-life',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://swisslife.ch/jobs/test',
      source: 'Swiss Life Dedicated Parser',
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
      expect(validJob.id).toMatch(/^swiss-life-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  describe('structured address', () => {
    it('publishes the vacancy municipality instead of the canton capital (issue 5253)', async () => {
      // Workday: primaria `Buchs SG`, JSON-LD con l'agenzia `GA Glarus-Rheintal`.
      // Il ripiego di capoluogo stampava `addressLocality: St. Gallen`.
      const listing = makeListing('Buchs-SG/Sales-Support_R10449-1', 'Buchs SG');
      vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
        if (options?.body) return jsonResponse({ total: 1, jobPostings: [listing] });
        expect(String(url)).toContain('/job/Buchs-SG/');
        return jsonResponse({
          jobPostingInfo: {
            title: 'Sales Support (w/m/d) 40% - 60% Generalagentur Glarus-Rheintal',
            location: 'Buchs SG',
            jobRequisitionLocation: { descriptor: 'GA Glarus-Rheintal' },
            jobDescription: '<p>Unterstützung der Generalagentur im Verkaufsinnendienst.</p>',
          },
          hiringOrganization: { name: 'Swiss Life GA Glarus-Rheintal' },
        });
      }));
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1000 });
      try {
        const [job] = await fetchAllSwissLifeJobs();
        expect(job.location).toBe('Buchs SG');
        expect(job.canton).toBe('SG');
        expect(job.addressLocality).toBe('Buchs SG');
        expect(job.streetAddress).not.toBe('Gallusstrasse 14');
      } finally {
        vi.useRealTimers();
      }
    });

    it('skips agency-only postings instead of publishing the canton capital (issue 9838)', async () => {
      // Live Workday shapes (2026-09-25): `GA Wil` + `GS Rapperswil` names two
      // agency offices and no municipality; `GA Thurgau` also lists `Weinfelden`.
      const details = new Map([
        ['R13300', {
          title: 'Vorsorge- und Finanzberatende (w/m/d) – Generalagentur Wil',
          location: 'GA Wil',
          additionalLocations: ['GS Rapperswil'],
          jobRequisitionLocation: { descriptor: 'GA Wil' },
        }],
        ['R12494', {
          title: 'Financial Planner & Relationship Manager (w/m/d) 100%',
          location: 'Rapperswil Rathausstrasse',
          jobRequisitionLocation: { descriptor: 'Rapperswil Rathausstrasse' },
        }],
        ['R09621', {
          title: 'Vorsorge- und Finanzberatende (w/m/d) – Generalagentur Thurgau',
          location: 'GA Thurgau',
          additionalLocations: ['Weinfelden'],
          jobRequisitionLocation: { descriptor: 'GA Thurgau' },
        }],
      ]);
      const listings = [
        makeListing('GA-Wil/Vorsorge_R13300', '2 Locations'),
        makeListing('Rapperswil-Rathausstrasse/Financial-Planner_R12494', 'Rapperswil Rathausstrasse'),
        makeListing('GA-Thurgau/Vorsorge_R09621', '2 Locations'),
      ];
      vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
        if (options?.body) return jsonResponse({ total: listings.length, jobPostings: listings });
        const id = String(url).match(/_(R\d+)$/)?.[1] || '';
        return jsonResponse({
          jobPostingInfo: { ...details.get(id), jobDescription: '<p>Beratung von Privat- und Firmenkunden.</p>' },
        });
      }));
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1000 });
      try {
        const jobs = await fetchAllSwissLifeJobs();
        expect(jobs.map((job) => job.location)).toEqual(['Weinfelden']);
        const [job] = jobs;
        expect(job.canton).toBe('TG');
        expect(job.addressLocality).toBe('Weinfelden');
        expect(job.streetAddress).not.toBe('Rathausplatz 1');
        for (const published of jobs) {
          expect(published.addressLocality).not.toBe('St. Gallen');
          expect(published.streetAddress).not.toBe('Gallusstrasse 14');
        }
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('national pagination', () => {
    it('continues after a short page until the declared total is reached', async () => {
      const pages = new Map([
        [0, { total: 2, jobPostings: [makeListing('one')] }],
        [1, { total: 2, jobPostings: [makeListing('two')] }],
      ]);
      const offsets: number[] = [];
      vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
        const body = JSON.parse(String(options.body));
        offsets.push(body.offset);
        return jsonResponse(pages.get(body.offset) || { total: 2, jobPostings: [] });
      }));

      const listings = await fetchSwissListings();

      expect(offsets).toEqual([0, 1]);
      expect(listings.map((listing) => listing.externalPath)).toEqual(['/job/one', '/job/two']);
    });

    it('fails explicitly when an empty page leaves the declared total incomplete', async () => {
      const pages = new Map([
        [0, { total: 2, jobPostings: [makeListing('only')] }],
        [1, { total: 2, jobPostings: [] }],
      ]);
      vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
        const body = JSON.parse(String(options.body));
        return jsonResponse(pages.get(body.offset) || { total: 2, jobPostings: [] });
      }));

      await expect(fetchSwissListings()).rejects.toThrow(/1 of 2 declared records fetched/);
    });

    it('fails closed when Workday repeats a page without new source records', async () => {
      const repeatedPage = { total: 3, jobPostings: [makeListing('repeated')] };
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(repeatedPage)));

      await expect(fetchSwissListings()).rejects.toThrow(/repeated page or no new records/);
    });

    it('fails closed when raw pages have no identity used by the final deduplication map', async () => {
      const pages = new Map([
        [0, {
          total: 2,
          jobPostings: [{
            externalPath: '',
            title: 'Unidentified Swiss Life job, first representation',
            locationsText: 'Zürich, Switzerland',
            bulletFields: [],
          }],
        }],
        [1, {
          total: 2,
          jobPostings: [{
            externalPath: '',
            title: 'Unidentified Swiss Life job, second representation',
            locationsText: 'Zürich, Switzerland',
            bulletFields: [],
          }],
        }],
      ]);
      vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
        const body = JSON.parse(String(options.body));
        return jsonResponse(pages.get(body.offset) || { total: 2, jobPostings: [] });
      }));

      await expect(fetchSwissListings()).rejects.toThrow(/stable record identity/);
    });
  });

  describe('national read completeness', () => {
    it('accepts a single declared listing without a count gate', () => {
      expect(() => assertSwissLifeNationalReadComplete({
        terminationProven: true,
        totalHits: 1,
        recordsSeen: 1,
      })).not.toThrow();
    });

    it('rejects a truncated read against the declared total', () => {
      expect(() => assertSwissLifeNationalReadComplete({
        terminationProven: false,
        totalHits: 123,
        recordsSeen: 80,
      })).toThrow(/80 of 123 declared records fetched/);
    });
  });
});
