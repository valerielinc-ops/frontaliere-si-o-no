import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  BEEKEEPER_KEY,
  BEEKEEPER_COMPANY_NAME,
  fetchAllBeekeeperJobs,
  resolveBeekeeperSourceAddress,
  isBeekeeperJob,
  isTrustedDomain,
} from '../scripts/lib/beekeeper-job-parser.mjs';
import { evaluateAuthoritativeSnapshot, slugify } from '../scripts/lib/crawler-template.mjs';

describe('Beekeeper crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(BEEKEEPER_KEY).toBe('beekeeper');
    expect(BEEKEEPER_COMPANY_NAME).toBe('Beekeeper');
  });

  // ── isCompanyJob ──
  describe('isBeekeeperJob', () => {
    it('matches by companyKey', () => {
      expect(isBeekeeperJob({ companyKey: 'beekeeper' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isBeekeeperJob({ company: 'Beekeeper' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isBeekeeperJob({ url: 'https://www.beekeeper.io/careers/123' })).toBe(true);
    });

    it('matches by LumApps Teamtailor board URL', () => {
      expect(isBeekeeperJob({ url: 'https://job.lumapps.com/jobs/7971866-account-manager' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isBeekeeperJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isBeekeeperJob(null)).toBe(false);
      expect(isBeekeeperJob(undefined)).toBe(false);
      expect(isBeekeeperJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://www.beekeeper.io/careers/job-123')).toBe(true);
    });

    it('trusts LumApps domain (post-merger job board)', () => {
      expect(isTrustedDomain('https://job.lumapps.com/jobs/7971866-account-manager')).toBe(true);
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
      const slug = slugify('Account Manager (Zurich)');
      expect(slug).toBe('account-manager-zurich');
    });

    it('strips diacritics', () => {
      expect(slugify('Ingénieur qualité')).toBe('ingenieur-qualite');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Account Manager beekeeper zurich')).toBe('account-manager-beekeeper-zurich');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference (mirrors what fetchAllBeekeeperJobs emits)
    const validJob = {
      id: 'beekeeper-abc123',
      slug: 'test-position-beekeeper-zurich',
      slugByLocale: { en: 'test-position-beekeeper-zurich' },
      company: 'Beekeeper',
      companyKey: 'beekeeper',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Zürich',
      canton: 'ZH',
      url: 'https://job.lumapps.com/jobs/test',
      source: 'Beekeeper Dedicated Parser',
      sourceLang: 'en',
      crawledAt: new Date().toISOString(),
      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: 'Zürich',
      addressRegion: 'ZH',
      streetAddress: 'Herostrasse 12',
      postalCode: '8048',
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
      expect(validJob.id).toMatch(/^beekeeper-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});

describe('Beekeeper Teamtailor feed freshness', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('bypasses a stale CDN feed before filtering locations for Switzerland', async () => {
    const url = 'https://job.lumapps.com/jobs/8483000-senior-account-executive-germany';
    const staleItem = {
      id: '5fc108a3-d274-433d-9a59-17a2f335b244',
      title: 'Senior Account Executive – Germany',
      url,
      _jobposting: {
        title: 'Senior Account Executive – Germany',
        jobLocation: [
          { address: { addressLocality: 'Hamburg', addressCountry: 'DE' } },
          { address: { addressLocality: 'Zürich', addressCountry: 'CH' } },
        ],
      },
    };
    const freshItem = {
      ...staleItem,
      _jobposting: {
        ...staleItem._jobposting,
        jobLocation: [{ address: { addressLocality: 'Hamburg', addressCountry: 'DE' } }],
      },
    };
    const fetchMock = vi.fn(async (input: string | URL) => {
      const requestUrl = new URL(String(input));
      const items = requestUrl.searchParams.has('_') ? [freshItem] : [staleItem];
      return new Response(JSON.stringify({ items }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const jobs = await fetchAllBeekeeperJobs();

    expect(jobs).toEqual([]);
    expect(evaluateAuthoritativeSnapshot(jobs).authoritativeEmptySnapshot).toBe(true);
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get('_')).toMatch(/^\d+$/);
  });

  it('does not mark an empty feed as a verified zero-job snapshot', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 })));

    const jobs = await fetchAllBeekeeperJobs();

    expect(jobs).toEqual([]);
    expect(evaluateAuthoritativeSnapshot(jobs).authoritativeEmptySnapshot).toBe(false);
  });

  it.each([
    ['non-object feed item', null],
    ['missing _jobposting', { title: 'Account Executive' }],
    ['missing jobLocation', { _jobposting: { title: 'Account Executive' } }],
    ['uninterpretable addressCountry', {
      _jobposting: {
        title: 'Account Executive',
        jobLocation: [{ address: { addressLocality: 'Zürich' } }],
      },
    }],
    ['Swiss posting with unusable title', {
      _jobposting: {
        title: '',
        jobLocation: [{ address: { addressLocality: 'Zürich', addressCountry: 'CH' } }],
      },
    }],
  ])('does not mark a non-empty feed with %s as a verified zero', async (_reason, item) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [item] }), { status: 200 })));

    const jobs = await fetchAllBeekeeperJobs();

    expect(jobs).toEqual([]);
    expect(evaluateAuthoritativeSnapshot(jobs).authoritativeEmptySnapshot).toBe(false);
  });

  it('does not stamp a valid foreign row as zero when another Swiss row is uninterpretable', async () => {
    const items = [
      {
        title: 'Account Executive – Germany',
        _jobposting: {
          title: 'Account Executive – Germany',
          jobLocation: [{ address: { addressLocality: 'Hamburg', addressCountry: 'DE' } }],
        },
      },
      {
        _jobposting: {
          title: '',
          jobLocation: [{ address: { addressLocality: 'Zürich', addressCountry: 'CH' } }],
        },
      },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items }), { status: 200 })));

    const jobs = await fetchAllBeekeeperJobs();

    expect(jobs).toEqual([]);
    expect(evaluateAuthoritativeSnapshot(jobs).authoritativeEmptySnapshot).toBe(false);
  });

  it('recognizes a normalized Swiss country code instead of stamping a false zero', async () => {
    const item = {
      title: 'Account Executive',
      _jobposting: {
        title: 'Account Executive',
        jobLocation: [{ address: { addressLocality: 'Zürich', addressCountry: ' ch ' } }],
      },
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [item] }), { status: 200 })));

    const jobs = await fetchAllBeekeeperJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0].location).toBe('Zürich');
    expect(evaluateAuthoritativeSnapshot(jobs).authoritativeEmptySnapshot).toBe(false);
  });

  it('rejects a Swiss feed tag when the canonical detail is foreign', () => {
    expect(resolveBeekeeperSourceAddress({
      jobLocation: [{ address: { addressLocality: 'Zürich', addressCountry: 'CH' } }],
    }, {
      locality: 'Hamburg',
      postalCode: '20095',
      streetAddress: '',
      addressCountry: 'DE',
    })).toBeNull();
  });

  it('uses a Swiss canonical detail address when the feed is stale', () => {
    expect(resolveBeekeeperSourceAddress({
      jobLocation: [{ address: { addressLocality: 'Zürich', addressCountry: 'CH' } }],
    }, {
      locality: 'Zürich',
      postalCode: '8048',
      streetAddress: 'Herostrasse 12',
      addressCountry: 'CH',
    })).toMatchObject({
      city: 'Zürich',
      canton: 'ZH',
      postalCode: '8048',
      streetAddress: 'Herostrasse 12',
    });
  });
});
