import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  SELECTA_KEY,
  SELECTA_COMPANY_NAME,
  SELECTA_COMPANY_DOMAIN,
  isSelectaJob,
  isTrustedDomain,
  resolveAddress,
  fetchAllSelectaJobs,
} from '../scripts/lib/selecta-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Selecta crawler parser', () => {
  // ── Constants ──
  it('exports valid company key, name and domain', () => {
    expect(SELECTA_KEY).toBe('selecta');
    expect(SELECTA_COMPANY_NAME).toBe('Selecta');
    expect(SELECTA_COMPANY_DOMAIN).toBe('selecta.com');
  });

  // ── isCompanyJob ──
  describe('isSelectaJob', () => {
    it('matches by companyKey', () => {
      expect(isSelectaJob({ companyKey: 'selecta' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isSelectaJob({ company: 'Selecta' })).toBe(true);
    });

    it('matches by URL domain (ATS host)', () => {
      expect(isSelectaJob({ url: 'https://careers.selecta.ch/Job/4614' })).toBe(true);
    });

    it('matches by URL domain (marketing domain)', () => {
      expect(isSelectaJob({ url: 'https://www.selecta.com/en/career/' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isSelectaJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isSelectaJob(null)).toBe(false);
      expect(isSelectaJob(undefined)).toBe(false);
      expect(isSelectaJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts the eRecruiter ATS host', () => {
      expect(isTrustedDomain('https://careers.selecta.ch/Job/4614')).toBe(true);
    });

    it('trusts the primary marketing domain', () => {
      expect(isTrustedDomain('https://www.selecta.com/en/career/')).toBe(true);
    });

    it('trusts subdomains of selecta.com', () => {
      expect(isTrustedDomain('https://intranet.selecta.com/x')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('rejects lookalike domains', () => {
      expect(isTrustedDomain('https://selecta.com.evil.example/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── resolveAddress — city-gated HQ fallback, NEVER canton-gated (AGENTS.md #7) ──
  describe('resolveAddress', () => {
    it('resolves the Steinhausen HQ street address for a Steinhausen posting', () => {
      expect(resolveAddress('Steinhausen')).toEqual({
        city: 'Steinhausen',
        canton: 'ZG',
        postalCode: '6312',
        streetAddress: 'Hinterbergstrasse 16',
      });
    });

    it('matches Steinhausen case-insensitively', () => {
      const resolved = resolveAddress('STEINHAUSEN');
      expect(resolved.postalCode).toBe('6312');
      expect(resolved.streetAddress).toBe('Hinterbergstrasse 16');
    });

    it('does NOT inherit the HQ street/postal address for a same-canton (ZG) but different city', () => {
      // Regression guard: gating must key off the resolved CITY TEXT, never
      // off the canton alone (AGENTS.md non-negotiable #7 / recurring bug
      // class). "Zug" and "Cham" both resolve to canton ZG, exactly like
      // Steinhausen, but must NOT get the Steinhausen street/postal code.
      const zug = resolveAddress('Zug');
      expect(zug.canton).toBe('ZG');
      expect(zug.city).toBe('Zug');
      expect(zug.postalCode).not.toBe('6312');
      expect(zug.streetAddress).not.toBe('Hinterbergstrasse 16');
      expect(zug.postalCode).toBe('');
      expect(zug.streetAddress).toBe('');

      const cham = resolveAddress('Cham');
      expect(cham.canton).toBe('ZG');
      expect(cham.postalCode).toBe('');
      expect(cham.streetAddress).toBe('');
    });

    it('strips the "Region " prefix Selecta uses for its coverage-area postings', () => {
      const resolved = resolveAddress('Region Solothurn');
      expect(resolved.city).toBe('Solothurn');
      expect(resolved.canton).toBe('SO');
      expect(resolved.postalCode).toBe('');
      expect(resolved.streetAddress).toBe('');
    });

    it('resolves a two-token "City CANTON" style location', () => {
      expect(resolveAddress('Kirchberg BE').canton).toBe('BE');
    });

    it('strips a trailing scheduling parenthetical before resolving', () => {
      const resolved = resolveAddress('Winterthur (Start 1. Juni 2026 oder nach Vereinbarung)');
      expect(resolved.city).toBe('Winterthur');
      expect(resolved.canton).toBe('ZH');
    });

    it('resolves colloquial region phrases via REGION_CANTON_HINTS fallback', () => {
      // "Berner Oberland" is not a canton/municipality alias inferAnyCanton()
      // knows about — needs the local hint table.
      expect(resolveAddress('Region Berner Oberland').canton).toBe('BE');
    });

    it('falls back to the FULL HQ address (never dropped) for an unmappable multi-canton region', () => {
      // "Westschweiz" spans several cantons — cannot resolve to one, so the
      // safe default is the full HQ object, same as postauto-job-parser.mjs.
      expect(resolveAddress('Westschweiz')).toEqual({
        city: 'Steinhausen',
        canton: 'ZG',
        postalCode: '6312',
        streetAddress: 'Hinterbergstrasse 16',
      });
    });

    it('falls back to the FULL HQ address for an empty location', () => {
      expect(resolveAddress('')).toEqual({
        city: 'Steinhausen',
        canton: 'ZG',
        postalCode: '6312',
        streetAddress: 'Hinterbergstrasse 16',
      });
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('builds slug with company suffix inline', () => {
      expect(slugify('Automatenbetreuer selecta Solothurn')).toBe('automatenbetreuer-selecta-solothurn');
    });

    it('strips diacritics and slashes', () => {
      expect(slugify('Automatenbetreuer/in (a) selecta Zürich')).toMatch(/^[a-z0-9-]+$/);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const validJob = {
      id: 'selecta-abc123',
      slug: 'test-position-selecta-ch',
      slugByLocale: { de: 'test-position-selecta-ch' },
      company: 'Selecta',
      companyKey: 'selecta',
      companyDomain: 'selecta.com',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation purposes only.',
      descriptionByLocale: { de: 'A test job description for validation purposes only.' },
      location: 'Solothurn',
      canton: 'SO',
      url: 'https://careers.selecta.ch/Job/9999',
      source: 'Selecta Dedicated Parser (eRecruiter)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: 'Solothurn',
      addressRegion: 'SO',
      streetAddress: '',
      postalCode: '',
      addressCountry: 'CH',
      country: 'CH',
      employmentType: 'FULL_TIME',
      hiringOrganization: { name: 'Selecta' },
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

    it('has fields required for job-page structured data (baseSalary source inputs)', () => {
      // baseSalary itself is synthesized downstream from safe defaults;
      // the parser is responsible for supplying its per-job inputs.
      const structuredDataInputs = [
        'postalCode', 'streetAddress', 'title', 'description',
        'addressLocality', 'addressCountry', 'employmentType',
      ];
      for (const field of structuredDataInputs) {
        expect(validJob).toHaveProperty(field);
      }
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^selecta-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('sourceLang is always de (eRecruiter instance is German-only — FR/IT/EN locales 404)', () => {
      expect(validJob.sourceLang).toBe('de');
    });
  });
});

describe('fetchAllSelectaJobs (eRecruiter listing + detail-page scrape)', () => {
  beforeEach(() => { process.env.JOBS_CRAWLER_RETRY_BASE_MS = '0'; });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.JOBS_CRAWLER_RETRY_BASE_MS;
  });

  function listingHtml(jobs: Array<{ Id: number; Title: string; SubTitle: string; Location: string; Date: string; OnlineDateCorrected: string }>) {
    return `<!doctype html><html><body>
<div id="jobListPlaceholder"></div>
<script>
$(function () {
  new JobList($("#jobListPlaceholder"), $("#jobListTemplate"), {"TotalJobsCount":${jobs.length},"DisplayPagination":false,"RegionsViewModel":{"Regions":[]},"Jobs":${JSON.stringify(jobs)}});
});
</script>
</body></html>`;
  }

  function detailHtml(over = '') {
    return `<!doctype html><html><body>
<div class="jobAdContent">
<p>Selecta ist der führende Anbieter für Verpflegungslösungen am Arbeitsplatz und unterwegs in der Schweiz.${over}</p>
<h2>Ihre Aufgaben</h2>
<ul><li>Betreuung und Bestückung der Automaten</li><li>Reinigung und Wartung vor Ort</li></ul>
<h2>Ihr Profil</h2>
<ul><li>Freude am Kundenkontakt</li></ul>
</div>
<div class="jobBlock jobApply"><button>Jetzt online Bewerben</button></div>
</body></html>`;
  }

  function mockFetch(jobs: Array<Record<string, unknown>>) {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
      const href = String(url);
      if (href.includes('/Jobs')) {
        return {
          ok: true,
          status: 200,
          text: async () => listingHtml(jobs as never),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        text: async () => detailHtml(),
      } as unknown as Response;
    });
  }

  function listing(over: Record<string, unknown> = {}) {
    return {
      Id: 4614,
      Title: 'Automatenbetreuer/in (a) 100%',
      SubTitle: '100% - Unbefristete Anstellung',
      Location: 'Region Solothurn',
      Date: '01.07.2026',
      OnlineDateCorrected: '/Date(1783123200000)/',
      ...over,
    };
  }

  it('maps a listing + detail page pair into a full job record', async () => {
    mockFetch([listing()]);
    const jobs = await fetchAllSelectaJobs();
    expect(jobs).toHaveLength(1);
    const j = jobs[0];
    expect(j.title).toBe('Automatenbetreuer/in (a) 100%');
    expect(j.location).toBe('Solothurn');
    expect(j.canton).toBe('SO');
    expect(j.postalCode).toBe('');
    expect(j.streetAddress).toBe('');
    expect(j.sourceLang).toBe('de');
    expect(j.employmentType).toBe('FULL_TIME');
    expect(j.description.length).toBeGreaterThan(50);
    expect(j.description).toMatch(/Ihre Aufgaben/);
    expect(j.descriptionByLocale.de).toBe(j.description);
    expect(j.url).toBe('https://careers.selecta.ch/Job/4614');
    expect(j.jobReqId).toBe('4614');
  });

  it('parses the .NET /Date(epoch)/ wire format into an ISO date (not the ambiguous dd.mm.yyyy display string)', async () => {
    mockFetch([listing({ OnlineDateCorrected: '/Date(1783123200000)/' })]);
    const jobs = await fetchAllSelectaJobs();
    expect(jobs[0].postedDate).toBe(new Date(1783123200000).toISOString().split('T')[0]);
  });

  it('resolves the HQ address only for the Steinhausen posting, not for other ZG postings in the same batch', async () => {
    mockFetch([
      listing({ Id: 4557, Title: 'Mitarbeiter/in Innendienst Zug (a) 50%', Location: 'Steinhausen' }),
      listing({ Id: 4600, Title: 'Servicetechniker (a) 100%', Location: 'Zug' }),
    ]);
    const jobs = await fetchAllSelectaJobs();
    const steinhausenJob = jobs.find((j: { location: string }) => j.location === 'Steinhausen');
    const zugJob = jobs.find((j: { location: string }) => j.location === 'Zug');
    expect(steinhausenJob.postalCode).toBe('6312');
    expect(steinhausenJob.streetAddress).toBe('Hinterbergstrasse 16');
    expect(zugJob.canton).toBe('ZG');
    expect(zugJob.postalCode).toBe('');
    expect(zugJob.streetAddress).toBe('');
  });

  it('detects an apprenticeship listing as INTERN employmentType', async () => {
    mockFetch([listing({
      Id: 4592,
      Title: 'Lernende/r Detailhandelsfachmann/-frau EFZ',
      SubTitle: '100% - Ausbildung',
      Location: 'Kirchberg BE',
    })]);
    const jobs = await fetchAllSelectaJobs();
    expect(jobs[0].employmentType).toBe('INTERN');
    expect(jobs[0].category).toBe('Formazione');
  });

  it('detects a low-percentage listing as PART_TIME employmentType', async () => {
    mockFetch([listing({
      Id: 4557,
      Title: 'Mitarbeiter/in Innendienst (a) 50%',
      SubTitle: '50% (Einsatz Montag - Freitag)',
      Location: 'Steinhausen',
    })]);
    const jobs = await fetchAllSelectaJobs();
    expect(jobs[0].employmentType).toBe('PART_TIME');
  });

  it('deduplicates repeated listing entries by URL', async () => {
    mockFetch([listing(), listing()]);
    const jobs = await fetchAllSelectaJobs();
    expect(jobs).toHaveLength(1);
  });

  it('skips listings without a usable title', async () => {
    mockFetch([listing({ Title: '' }), listing({ Id: 4600, Title: 'ab' })]);
    const jobs = await fetchAllSelectaJobs();
    expect(jobs).toHaveLength(0);
  });

  it('returns [] (no throw) when the listing page has no recognizable payload', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '<html><body>no jobs here</body></html>',
    } as unknown as Response);
    const jobs = await fetchAllSelectaJobs();
    expect(jobs).toEqual([]);
  });

  it('falls back to a synthesized description (never drops the field) when the detail page has no jobAdContent block', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
      const href = String(url);
      if (href.includes('/Jobs')) {
        return { ok: true, status: 200, text: async () => listingHtml([listing()] as never) } as unknown as Response;
      }
      return { ok: true, status: 200, text: async () => '<html><body>no ad content</body></html>' } as unknown as Response;
    });
    const jobs = await fetchAllSelectaJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].description.length).toBeGreaterThan(0);
    expect(jobs[0].description).toMatch(/Selecta/);
  });

  it('does not throw when a single detail-page fetch rejects — job still emitted with a synthesized description', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
      const href = String(url);
      if (href.includes('/Jobs')) {
        return { ok: true, status: 200, text: async () => listingHtml([listing()] as never) } as unknown as Response;
      }
      throw new Error('network error');
    });
    const jobs = await fetchAllSelectaJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].description.length).toBeGreaterThan(0);
  });

  it('returns [] (no throw) when the listing fetch itself fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 503, text: async () => '' } as unknown as Response);
    await expect(fetchAllSelectaJobs()).resolves.toEqual([]);
  });
});
