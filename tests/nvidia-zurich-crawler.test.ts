import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  NVIDIA_ZURICH_KEY,
  NVIDIA_ZURICH_COMPANY_NAME,
  isNvidiaZurichJob,
  isTrustedDomain,
  hasNvidiaSwissLocation,
  hasNvidiaSwissPrimaryLocation,
  fetchAllNvidiaZurichJobs,
} from '../scripts/lib/nvidia-zurich-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

// Replay harness for fetchAllNvidiaZurichJobs: the Workday network calls are
// replaced by the payloads below, every pure helper of the client stays real.
const workdayReplay = vi.hoisted(() => ({
  listings: [] as Array<Record<string, unknown>>,
  details: new Map<string, Record<string, unknown>>(),
}));

vi.mock('../scripts/lib/ats-clients/workday-client.mjs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    async *fetchWorkdayJobs() {
      yield* workdayReplay.listings;
    },
    fetchWorkdayJobDetail: async (_apiBase: string, externalPath: string) =>
      workdayReplay.details.get(externalPath) ?? null,
    fetchWorkdayJobDescriptionText: async () => '',
  };
});

describe('NVIDIA (ufficio Zurich) crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(NVIDIA_ZURICH_KEY).toBe('nvidia-zurich');
    expect(NVIDIA_ZURICH_COMPANY_NAME).toBe('NVIDIA (ufficio Zurich)');
  });

  // ── isCompanyJob ──
  describe('isNvidiaZurichJob', () => {
    it('matches by companyKey', () => {
      expect(isNvidiaZurichJob({ companyKey: 'nvidia-zurich' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isNvidiaZurichJob({ company: 'NVIDIA (ufficio Zurich)' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isNvidiaZurichJob({ url: 'https://nvidia.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isNvidiaZurichJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isNvidiaZurichJob(null)).toBe(false);
      expect(isNvidiaZurichJob(undefined)).toBe(false);
      expect(isNvidiaZurichJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://nvidia.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.nvidia.com/job/456')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  describe('detail location resolution', () => {
    it.each([
      ['CH-ZH', 'hyphenated canton code'],
      ['CHE-8002', 'hyphenated postal code'],
    ])('recognizes %s as Swiss when Workday joins the code with a hyphen (%s)', (countryCode) => {
      expect(hasNvidiaSwissLocation({
        location: 'Berlin, Germany',
        additionalLocations: [
          { descriptor: 'Berlin, Germany', country: { code: countryCode } },
        ],
      })).toBe(true);
    });

    it('recognizes a Swiss descriptor object in additionalLocations', () => {
      expect(hasNvidiaSwissLocation({
        location: 'Germany, Remote',
        additionalLocations: [
          { descriptor: 'Zurich, Switzerland', country: { alpha2Code: 'CH' } },
        ],
      })).toBe(true);

      expect(hasNvidiaSwissLocation({
        location: 'Berlin, Germany',
        additionalLocations: [
          { descriptor: 'Berlin, Germany', country: { code: 'CH-WID' } },
        ],
      })).toBe(false);
    });

    it('rejects a foreign primary location even when an additional location is Swiss', () => {
      expect(hasNvidiaSwissPrimaryLocation({
        location: { descriptor: 'Paris, France', country: { alpha2Code: 'FR' } },
        additionalLocations: [
          { descriptor: 'Zurich, Switzerland', country: { alpha2Code: 'CH' } },
        ],
      })).toBe(false);
    });

    it('accepts a Swiss primary location', () => {
      expect(hasNvidiaSwissPrimaryLocation({
        location: { descriptor: 'Zurich, Switzerland', country: { alpha2Code: 'CH' } },
        additionalLocations: [{ descriptor: 'Paris, France' }],
      })).toBe(true);
    });
  });

  // The publish predicate is NOT the facet predicate. `hasNvidiaSwissLocation`
  // above answers «does this req touch Switzerland anywhere» over the union of
  // primary + additional + requisition + listing locations, and the cases above
  // pin that union on purpose. What licenses stamping a record
  // `Zürich / ZH / addressCountry: CH` is narrower: the req's OWN primary
  // workplace. Measured 2026-09-19 on data/jobs/by-crawler/nvidia-zurich.json —
  // 35 records, all published as `Zürich`, of which 21 had a non-Swiss primary
  // location in their own Workday path (France/Poland/Germany/UK/Italy/Spain).
  // Those are the mismatches audit-parser-quality.mjs --strict reports.
  describe('publish gate: primary workplace only', () => {
    it('refuses a foreign req that is merely cross-posted to Switzerland', () => {
      const crossPosted = {
        location: 'Germany, Munich',
        additionalLocations: [
          { descriptor: 'Zurich, Switzerland', country: { alpha2Code: 'CH' } },
        ],
      };
      // Still Switzerland-tagged for the facet…
      expect(hasNvidiaSwissLocation(crossPosted)).toBe(true);
      // …but not publishable as a Zürich job.
      expect(hasNvidiaSwissPrimaryLocation(crossPosted)).toBe(false);
    });

    it('accepts a req whose primary workplace is Swiss', () => {
      expect(hasNvidiaSwissPrimaryLocation({
        location: 'Switzerland, Zurich',
        additionalLocations: [{ descriptor: 'Germany, Munich' }],
      })).toBe(true);
      expect(hasNvidiaSwissPrimaryLocation({
        location: { descriptor: 'Zurich, Switzerland', country: { alpha2Code: 'CH' } },
      })).toBe(true);
    });

    it('refuses a Swiss primary that names no municipality (issue 9839)', () => {
      // `Switzerland, Remote` is a country plus a work mode: no commune for the
      // record to carry. It used to be published as Zürich / ZH, a place the
      // source does not name. Unknown geography stays fail-closed, and a Swiss
      // additional location does not license the stamp any more than it does
      // for a foreign primary.
      expect(hasNvidiaSwissPrimaryLocation({ location: 'Switzerland, Remote' })).toBe(false);
      expect(hasNvidiaSwissPrimaryLocation({
        location: 'Switzerland, Remote',
        additionalLocations: ['Switzerland, Zurich'],
      })).toBe(false);
      expect(hasNvidiaSwissPrimaryLocation({ location: 'Switzerland' })).toBe(false);
      expect(hasNvidiaSwissPrimaryLocation({ location: 'CH-ZH' })).toBe(false);
    });

    it('fails closed when the primary location is unreadable', () => {
      // No primary location on the detail payload: skip rather than default to
      // the hub city. Same rule as the shared Workday factory's empty-raw guard.
      expect(hasNvidiaSwissPrimaryLocation({
        additionalLocations: [{ descriptor: 'Zurich, Switzerland' }],
      })).toBe(false);
      expect(hasNvidiaSwissPrimaryLocation({ location: '' })).toBe(false);
      expect(hasNvidiaSwissPrimaryLocation({})).toBe(false);
    });

    it('ignores the listing summary, which is only a rollup count', () => {
      // `locationsText` degrades to "5 Locations" on multi-country reqs, and
      // used to be part of the union the publish decision read.
      expect(hasNvidiaSwissPrimaryLocation({
        location: 'Poland, Remote',
        jobRequisitionLocation: { descriptor: 'Zurich, Switzerland' },
      })).toBe(false);
    });
  });

  // Replay of the Workday payloads behind issue 9839, captured live on
  // 2026-09-25 from the Switzerland facet of the NVIDIA tenant (locations and
  // external paths verbatim). The published slice then carried 8 records whose
  // Workday path is `Switzerland-Remote`, all stamped `Zürich / ZH`.
  describe('fetchAllNvidiaZurichJobs replay: primary location decides the record', () => {
    const description = 'NVIDIA is looking for an engineer to join the team. '.repeat(4);
    const replay = [
      {
        posting: {
          title: 'Senior HPC Performance Engineer',
          externalPath: '/job/Switzerland-Remote/Senior-HPC-Performance-Engineer_JR2016204',
          locationsText: 'Switzerland, Remote',
          postedOn: 'Posted 30+ Days Ago',
          bulletFields: ['JR2016204'],
        },
        info: { location: 'Switzerland, Remote', additionalLocations: [] },
      },
      {
        posting: {
          title: 'Senior Performance Engineer',
          externalPath: '/job/Switzerland-Remote/Senior-Performance-Engineer_JR2022529',
          locationsText: '2 Locations',
          postedOn: 'Posted 30+ Days Ago',
          bulletFields: ['JR2022529'],
        },
        info: {
          location: 'Switzerland, Remote',
          additionalLocations: ['Switzerland, Zurich'],
          jobRequisitionLocation: {
            descriptor: 'Switzerland, Remote',
            country: { descriptor: 'Switzerland', alpha2Code: 'CH' },
          },
        },
      },
      {
        posting: {
          title: 'Senior HPC and AI Network Software Architect',
          externalPath: '/job/Switzerland-Zurich/Senior-HPC-and-AI-Network-Software-Architect_JR2022878',
          locationsText: 'Switzerland, Zurich',
          postedOn: 'Posted 24 Days Ago',
          bulletFields: ['JR2022878'],
        },
        info: { location: 'Switzerland, Zurich', additionalLocations: [] },
      },
      {
        posting: {
          title: 'Senior Solutions Architect, Remote France',
          externalPath: '/job/France-Remote/Senior-Solutions-Architect_JR0000001',
          locationsText: '2 Locations',
          postedOn: 'Posted 3 Days Ago',
          bulletFields: ['JR0000001'],
        },
        info: { location: 'France, Remote', additionalLocations: ['Switzerland, Zurich'] },
      },
    ];

    afterEach(() => {
      workdayReplay.listings = [];
      workdayReplay.details.clear();
      vi.restoreAllMocks();
    });

    async function runReplay() {
      for (const { posting, info } of replay) {
        workdayReplay.listings.push(posting);
        workdayReplay.details.set(posting.externalPath, {
          jobPostingInfo: { ...info, title: posting.title, timeType: 'Full time', jobDescription: `<p>${description}</p>` },
        });
      }
      // The parser paces detail fetches with setTimeout; the replay has no network.
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
        fn();
        return 0;
      }) as unknown as typeof setTimeout);
      vi.spyOn(console, 'log').mockImplementation(() => {});
      return fetchAllNvidiaZurichJobs();
    }

    it('publishes no job for a `Switzerland, Remote` primary, with or without a Swiss additional location', async () => {
      const jobs = await runReplay();
      const remote = jobs.filter((job: { url: string }) => job.url.includes('/job/Switzerland-Remote/'));
      expect(remote).toEqual([]);
    });

    it('publishes a `Switzerland, Zurich` primary as Zürich / ZH and nothing else', async () => {
      const jobs = await runReplay();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        title: 'Senior HPC and AI Network Software Architect',
        location: 'Zürich',
        canton: 'ZH',
        addressLocality: 'Zürich',
        addressRegion: 'ZH',
        addressCountry: 'CH',
        jobReqId: 'JR2022878',
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
      expect(slugify('Developer nvidia-zurich ch')).toBe('developer-nvidia-zurich-ch');
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
      id: 'nvidia-zurich-abc123',
      slug: 'test-position-nvidia-zurich-ch',
      slugByLocale: { en: 'test-position-nvidia-zurich-ch' },
      company: 'NVIDIA (ufficio Zurich)',
      companyKey: 'nvidia-zurich',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://nvidia.com/jobs/test',
      source: 'NVIDIA (ufficio Zurich) Dedicated Parser',
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
      expect(validJob.id).toMatch(/^nvidia-zurich-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
