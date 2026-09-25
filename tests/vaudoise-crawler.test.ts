import { describe, it, expect, vi } from 'vitest';
import {
  VAUDOISE_KEY,
  VAUDOISE_COMPANY_NAME,
  isVaudoiseJob,
  isTrustedDomain,
  fetchAllVaudoiseJobs,
  __testables,
} from '../scripts/lib/vaudoise-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

/* ── Stubbed Playwright runtime ────────────────────────────── */

class StubAntiBotBlockError extends Error {
  status?: number;
  title?: string;
  constructor(msg: string, opts: { status?: number; title?: string } = {}) {
    super(msg);
    this.name = 'AntiBotBlockError';
    this.status = opts.status;
    this.title = opts.title;
  }
}

class StubNavigationTimeout extends Error {
  url?: string;
  constructor(msg: string, opts: { url?: string } = {}) {
    super(msg);
    this.name = 'NavigationTimeout';
    this.url = opts.url;
  }
}

class StubBrowserLaunchError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'BrowserLaunchError';
  }
}

type RowShape = {
  title: string;
  url: string;
  location: string;
  postedDate: string;
  audience: string;
  jobCategory: string;
  id: string;
};

function makeRuntime(rows: RowShape[], opts: { rowsAppear?: boolean } = {}) {
  const page = {
    waitForSelector: vi.fn(async () => {
      if (opts.rowsAppear === false) {
        throw new Error('selector timeout');
      }
      return null;
    }),
    $$eval: vi.fn(async () => rows),
    close: vi.fn(async () => undefined),
  };

  return {
    runtime: {
      createBrowser: vi.fn(async () => ({})),
      createPoliteContext: vi.fn(async () => ({})),
      fetchWithRateLimit: vi.fn(async () => page),
      closeAll: vi.fn(async () => undefined),
      AntiBotBlockError: StubAntiBotBlockError,
      NavigationTimeout: StubNavigationTimeout,
      BrowserLaunchError: StubBrowserLaunchError,
    },
    page,
  };
}

describe('Vaudoise Assurances crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(VAUDOISE_KEY).toBe('vaudoise');
    expect(VAUDOISE_COMPANY_NAME).toBe('Vaudoise Assurances');
  });

  // ── isCompanyJob ──
  describe('isVaudoiseJob', () => {
    it('matches by companyKey', () => {
      expect(isVaudoiseJob({ companyKey: 'vaudoise' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isVaudoiseJob({ company: 'Vaudoise Assurances' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isVaudoiseJob({ url: 'https://vaudoise.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isVaudoiseJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isVaudoiseJob(null)).toBe(false);
      expect(isVaudoiseJob(undefined)).toBe(false);
      expect(isVaudoiseJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://vaudoise.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.vaudoise.ch/job/456')).toBe(true);
    });

    // Postings live on the Softgarden ATS subdomain — the dedicated
    // locale-validation gate flags `url_not_vaudoise_domain` otherwise
    // (regression covered by GH run 26004869125, 49/49 jobs).
    it('trusts the Softgarden ATS subdomain', () => {
      expect(
        isTrustedDomain('https://vaudoise.softgarden.io/job/64060113/some-title'),
      ).toBe(true);
    });

    it('rejects other softgarden tenants', () => {
      expect(isTrustedDomain('https://other.softgarden.io/job/1/foo')).toBe(false);
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
      expect(slugify('Developer vaudoise ch')).toBe('developer-vaudoise-ch');
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
      id: 'vaudoise-abc123',
      slug: 'test-position-vaudoise-ch',
      slugByLocale: { fr: 'test-position-vaudoise-ch' },
      company: 'Vaudoise Assurances',
      companyKey: 'vaudoise',
      title: 'Test Position',
      titleByLocale: { fr: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { fr: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://vaudoise.ch/jobs/test',
      source: 'Vaudoise Assurances Dedicated Parser',
      sourceLang: 'fr',
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
      expect(validJob.id).toMatch(/^vaudoise-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  // ── Softgarden URL helper ──
  describe('resolveApplyUrl', () => {
    it('resolves a relative ../job/{id} href to softgarden host', () => {
      expect(__testables.resolveApplyUrl('../job/64060113/Gestionnaire-contentieux-FR-DE')).toBe(
        'https://vaudoise.softgarden.io/job/64060113/Gestionnaire-contentieux-FR-DE',
      );
    });

    it('passes through an absolute URL untouched', () => {
      expect(
        __testables.resolveApplyUrl('https://vaudoise.softgarden.io/job/123/foo'),
      ).toBe('https://vaudoise.softgarden.io/job/123/foo');
    });

    it('falls back to listing URL on empty input', () => {
      expect(__testables.resolveApplyUrl('')).toBe(__testables.SOFTGARDEN_LISTING_URL);
    });
  });

  // ── Swiss location regex ──
  describe('SWISS_LOCATION_RX', () => {
    it.each([
      ['Lausanne', true],
      ['Genève', true],
      ['Zurich', true],
      ['Basel', true],
      ['Lugano', true],
      ['Paris, France', false],
      ['London', false],
      ['', false],
    ])('matches %s → %s', (input, expected) => {
      expect(__testables.SWISS_LOCATION_RX.test(input)).toBe(expected);
    });
  });

  // ── Softgarden scraper (Playwright path) ──
  describe('fetchJobListings (Softgarden Playwright)', () => {
    const lausanneRow: RowShape = {
      title: 'Gestionnaire contentieux FR/DE (f/h/x) – 80-100%',
      url: '../job/64060113/Gestionnaire-contentieux-FR-DE-f-h-x-80-100',
      location: 'Lausanne',
      postedDate: '5/10/26',
      audience: 'Expérimenté',
      jobCategory: 'Finances',
      id: '64060113',
    };
    const genevaRow: RowShape = {
      title: 'Conseiller / Conseillère en assurance (h/f/x) - 100%',
      url: '../job/64060555/Conseiller-en-assurance',
      location: 'Genève',
      postedDate: '5/9/26',
      audience: 'Expérimenté',
      jobCategory: 'Vente',
      id: '64060555',
    };
    const parisRow: RowShape = {
      title: 'Foreign role',
      url: '../job/99999/Foreign-Role',
      location: 'Paris, France',
      postedDate: '5/8/26',
      audience: 'Expérimenté',
      jobCategory: 'Other',
      id: '99999',
    };

    it('returns Swiss-only rows and resolves urls to absolute', async () => {
      const { runtime } = makeRuntime([lausanneRow, genevaRow, parisRow]);
      const out = await __testables.fetchJobListings({
        _runtime: async () => runtime,
      });
      expect(out).toHaveLength(2);
      expect(out.map((r: { title: string }) => r.title).sort()).toEqual([
        lausanneRow.title,
        genevaRow.title,
      ].sort());
      const lausanneOut = out.find((r: { id: string }) => r.id === '64060113');
      expect(lausanneOut.url).toBe(
        'https://vaudoise.softgarden.io/job/64060113/Gestionnaire-contentieux-FR-DE-f-h-x-80-100',
      );
    });

    it('dedupes rows by job id', async () => {
      const { runtime } = makeRuntime([lausanneRow, lausanneRow, genevaRow]);
      const out = await __testables.fetchJobListings({
        _runtime: async () => runtime,
      });
      expect(out).toHaveLength(2);
    });

    it('returns [] when row selector never appears (selector drift)', async () => {
      const { runtime } = makeRuntime([], { rowsAppear: false });
      const out = await __testables.fetchJobListings({
        _runtime: async () => runtime,
      });
      expect(out).toEqual([]);
    });

    it('returns [] gracefully on AntiBotBlockError', async () => {
      const runtime = {
        createBrowser: vi.fn(async () => ({})),
        createPoliteContext: vi.fn(async () => ({})),
        fetchWithRateLimit: vi.fn(async () => {
          throw new StubAntiBotBlockError('blocked', { status: 403, title: 'Access denied' });
        }),
        closeAll: vi.fn(async () => undefined),
        AntiBotBlockError: StubAntiBotBlockError,
        NavigationTimeout: StubNavigationTimeout,
        BrowserLaunchError: StubBrowserLaunchError,
      };
      const out = await __testables.fetchJobListings({ _runtime: async () => runtime });
      expect(out).toEqual([]);
      expect(runtime.closeAll).toHaveBeenCalled();
    });

    it('returns [] gracefully on NavigationTimeout', async () => {
      const runtime = {
        createBrowser: vi.fn(async () => ({})),
        createPoliteContext: vi.fn(async () => ({})),
        fetchWithRateLimit: vi.fn(async () => {
          throw new StubNavigationTimeout('timeout', { url: 'https://vaudoise.softgarden.io/' });
        }),
        closeAll: vi.fn(async () => undefined),
        AntiBotBlockError: StubAntiBotBlockError,
        NavigationTimeout: StubNavigationTimeout,
        BrowserLaunchError: StubBrowserLaunchError,
      };
      const out = await __testables.fetchJobListings({ _runtime: async () => runtime });
      expect(out).toEqual([]);
    });

    it('returns [] gracefully on BrowserLaunchError', async () => {
      const runtime = {
        createBrowser: vi.fn(async () => {
          throw new StubBrowserLaunchError('chromium not installed');
        }),
        createPoliteContext: vi.fn(async () => ({})),
        fetchWithRateLimit: vi.fn(async () => ({})),
        closeAll: vi.fn(async () => undefined),
        AntiBotBlockError: StubAntiBotBlockError,
        NavigationTimeout: StubNavigationTimeout,
        BrowserLaunchError: StubBrowserLaunchError,
      };
      const out = await __testables.fetchJobListings({ _runtime: async () => runtime });
      expect(out).toEqual([]);
    });
  });

  // ── Detail-page description extraction ──
  describe('parseVaudoiseDetailHtml', () => {
    it('returns the JSON-LD description (HTML stripped)', () => {
      const html = `
        <html><head>
        <script type="application/ld+json">
        {"@context":"http://schema.org/","@type":"JobPosting","title":"X","description":"<p>Première phrase.</p><p>Seconde phrase avec plus de détails sur le poste à pourvoir au sein du Département Assurances de personnes pour assurer la gestion des sinistres.</p>"}
        </script>
        </head><body></body></html>`;
      const out = __testables.parseVaudoiseDetailHtml(html);
      expect(out).toContain('Première phrase.');
      expect(out).toContain('gestion des sinistres');
      expect(out).not.toContain('<p>');
      expect(out.length).toBeGreaterThanOrEqual(120);
    });

    it('handles array-shaped JSON-LD (multiple @types)', () => {
      const html = `
        <script type="application/ld+json">
        [{"@type":"WebPage"},{"@type":"JobPosting","description":"<strong>Real description body content that comfortably exceeds the one-hundred-and-twenty character minimum threshold required by the locale-validation gate.</strong>"}]
        </script>`;
      const out = __testables.parseVaudoiseDetailHtml(html);
      expect(out).toMatch(/Real description body/);
      expect(out.length).toBeGreaterThanOrEqual(120);
    });

    it('returns empty string when no JSON-LD is present', () => {
      expect(__testables.parseVaudoiseDetailHtml('<html></html>')).toBe('');
    });

    it('returns empty string when JSON-LD is malformed', () => {
      const html = `<script type="application/ld+json">{ not json }</script>`;
      expect(__testables.parseVaudoiseDetailHtml(html)).toBe('');
    });

    it('handles null/undefined gracefully', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(__testables.parseVaudoiseDetailHtml(null as any)).toBe('');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(__testables.parseVaudoiseDetailHtml(undefined as any)).toBe('');
    });
  });

  describe('fetchVaudoiseDescription', () => {
    it('returns description when fetcher resolves with JSON-LD HTML', async () => {
      const longDesc =
        'Lorem ipsum dolor sit amet consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua, plus assez de texte pour le seuil de 120 caractères.';
      const html = `<script type="application/ld+json">{"@type":"JobPosting","description":"${longDesc}"}</script>`;
      const fetcher = vi.fn(async () => html);
      const out = await __testables.fetchVaudoiseDescription(
        'https://vaudoise.softgarden.io/job/123/foo',
        fetcher,
      );
      expect(out).toContain('Lorem ipsum');
      expect(fetcher).toHaveBeenCalledOnce();
    });

    it('returns empty string on fetcher failure', async () => {
      const fetcher = vi.fn(async () => '');
      const out = await __testables.fetchVaudoiseDescription(
        'https://vaudoise.softgarden.io/job/123/foo',
        fetcher,
      );
      expect(out).toBe('');
    });

    it('returns empty string for empty url', async () => {
      const fetcher = vi.fn(async () => 'whatever');
      const out = await __testables.fetchVaudoiseDescription('', fetcher);
      expect(out).toBe('');
      expect(fetcher).not.toHaveBeenCalled();
    });
  });

  // ── End-to-end through fetchAllVaudoiseJobs ──
  describe('fetchAllVaudoiseJobs (with stubbed runtime)', () => {
    const longDetailDesc =
      "Employeur solide et tourné vers l'avenir, la Vaudoise est l'un des assureurs leaders en Suisse. Nous recherchons un spécialiste avec expérience confirmée dans la gestion des sinistres pour rejoindre notre équipe.";
    const detailHtml = `<script type="application/ld+json">{"@type":"JobPosting","description":"<p>${longDetailDesc}</p>"}</script>`;
    const detailFetcher = async () => detailHtml;

    it('builds NormalizedJob shape from a Softgarden row', async () => {
      const row: RowShape = {
        title: 'Product Manager/in Vorsorge (m/w/d) - 80-100%',
        url: '../job/64653009/Product-Manager-in-Vorsorge',
        location: 'Lausanne',
        postedDate: '5/8/26',
        audience: 'Expérimenté',
        jobCategory: 'Prévoyance',
        id: '64653009',
      };
      const { runtime } = makeRuntime([row]);

      const jobs = await fetchAllVaudoiseJobs({
        _runtime: async () => runtime,
        _detailFetcher: detailFetcher,
      });

      expect(jobs).toHaveLength(1);
      const job = jobs[0];
      expect(job.id).toMatch(/^vaudoise-/);
      expect(job.company).toBe(VAUDOISE_COMPANY_NAME);
      expect(job.companyKey).toBe(VAUDOISE_KEY);
      expect(job.title).toBe(row.title);
      expect(job.location).toBe('Lausanne');
      expect(job.canton).toBe('VD');
      expect(job.country).toBe('CH');
      expect(job.url).toBe('https://vaudoise.softgarden.io/job/64653009/Product-Manager-in-Vorsorge');
      expect(job.applyUrl).toBe(job.url);
      expect(job.postedDate).toBe('5/8/26');
      expect(job.experienceLevel).toBe('senior');
      // Title has "80-100%" → part-time bracket
      expect(job.employmentType).toBe('PART_TIME');
      expect(job.slug).toMatch(/^product-manager/);
      expect(job.slugByLocale).toHaveProperty(job.sourceLang);
      // Description should come from the detail page (≥120 chars) so the
      // locale-validation gate doesn't flag the locale copies as
      // `untranslated_description`.
      expect(job.description.length).toBeGreaterThanOrEqual(120);
      expect(job.description).toContain('assureurs leaders');
      expect(job.descriptionByLocale[job.sourceLang]).toBe(job.description);
    });

    it('falls back to a stub description when the detail fetcher returns empty', async () => {
      const row: RowShape = {
        title: 'Stub Test Role 100%',
        url: '../job/77/Stub-Test',
        location: 'Lausanne',
        postedDate: '5/8/26',
        audience: '',
        jobCategory: '',
        id: '77',
      };
      const { runtime } = makeRuntime([row]);
      const jobs = await fetchAllVaudoiseJobs({
        _runtime: async () => runtime,
        _detailFetcher: async () => '',
      });
      expect(jobs).toHaveLength(1);
      const job = jobs[0];
      expect(job.description).toContain('Vaudoise Assurances');
      expect(job.descriptionByLocale[job.sourceLang]).toBe(job.description);
    });

    it('returns [] when no Swiss listings are found', async () => {
      const row: RowShape = {
        title: 'Foreign role',
        url: '../job/1/Foreign-role',
        location: 'Paris, France',
        postedDate: '5/8/26',
        audience: '',
        jobCategory: '',
        id: '1',
      };
      const { runtime } = makeRuntime([row]);

      const jobs = await fetchAllVaudoiseJobs({
        _runtime: async () => runtime,
        _detailFetcher: detailFetcher,
      });
      expect(jobs).toEqual([]);
    });
  });
});
