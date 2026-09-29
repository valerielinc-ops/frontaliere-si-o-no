import fs from 'node:fs';
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  STADLER_RAIL_KEY,
  STADLER_RAIL_COMPANY_NAME,
  STADLER_RAIL_FABRICATED_DESCRIPTION_RE,
  fetchAllStadlerRailJobs,
  isStadlerRailJob,
  isTrustedDomain,
} from '../scripts/lib/stadler-rail-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';
import { __resetJinaBreaker } from '../scripts/lib/jina-proxy.mjs';
import { dropFabricatedDescriptions } from '../scripts/lib/drop-fabricated-description.mjs';

describe('Stadler Rail crawler parser', () => {
  afterEach(() => {
    __resetJinaBreaker();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(STADLER_RAIL_KEY).toBe('stadler-rail');
    expect(STADLER_RAIL_COMPANY_NAME).toBe('Stadler Rail');
  });

  // ── isCompanyJob ──
  describe('isStadlerRailJob', () => {
    it('matches by companyKey', () => {
      expect(isStadlerRailJob({ companyKey: 'stadler-rail' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isStadlerRailJob({ company: 'Stadler Rail' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isStadlerRailJob({ url: 'https://stadlerrail.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isStadlerRailJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isStadlerRailJob(null)).toBe(false);
      expect(isStadlerRailJob(undefined)).toBe(false);
      expect(isStadlerRailJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://stadlerrail.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.stadlerrail.com/job/456')).toBe(true);
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
      expect(slugify('Developer stadler-rail ch')).toBe('developer-stadler-rail-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  it('uses the shared Jina fallback when the origin TLS connection fails', async () => {
    vi.stubEnv('JOBS_CRAWLER_RETRIES', '0');
    vi.stubEnv('JOBS_CRAWLER_RETRY_BASE_MS', '0');
    vi.stubEnv('JOBS_JINA_RETRIES', '0');
    vi.stubEnv('JOBS_JINA_RETRY_BASE_MS', '0');
    vi.stubEnv('JOBS_JINA_BREAKER_THRESHOLD', '0');
    vi.stubEnv('JOBS_CRAWLER_TIMEOUT_MS', '100');

    const fixture = '<a class="jobTitle-link" href="/job/Bussnang-Test-Position-TG-T-9565/123456789/">Test Position</a>'
      + `<p>${'Test description '.repeat(30)}</p>`;
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      if (String(input).startsWith('https://r.jina.ai/')) {
        return new Response(fixture, { status: 200 });
      }
      const error = new TypeError('fetch failed');
      error.cause = { code: 'CERT_HAS_EXPIRED' };
      throw error;
    }));

    await expect(fetchAllStadlerRailJobs()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'Test Position',
          url: 'https://careers.stadlerrail.com/job/Bussnang-Test-Position-TG-T-9565/123456789/',
        }),
      ]),
    );
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference
    const validJob = {
      id: 'stadler-rail-abc123',
      slug: 'test-position-stadler-rail-ch',
      slugByLocale: { de: 'test-position-stadler-rail-ch' },
      company: 'Stadler Rail',
      companyKey: 'stadler-rail',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://stadlerrail.com/jobs/test',
      source: 'Stadler Rail Dedicated Parser',
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
      expect(validJob.id).toMatch(/^stadler-rail-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});

// Issue 5253: a detail body under 50 words used to be DISCARDED and replaced
// by "<title> bei Stadler Rail in <city>." plus a paragraph about Stadler
// written by the parser. Now a body under the shared 50-word floor
// (`scripts/lib/source-body-floor.mjs`) is not published either: the job gets
// no description and takes the thin-source path (quarantine) instead of
// becoming an indexable thin page. Fixture: the live "Lackierer:in" page
// (49 words), minimized.
describe('fetchAllStadlerRailJobs — the detail text only', () => {
  const DETAIL = fs.readFileSync(new URL('./fixtures/stadler-rail-detail-short-lackierer.html', import.meta.url), 'utf8');
  const LISTING = '<a class="jobTitle-link" href="/job/Altenrhein-Lackiererin-SG-S-9423/1327192555/">Lackierer:in</a>';

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function stubSite(detailHtml: string) {
    vi.stubEnv('JOBS_CRAWLER_RETRIES', '0');
    vi.stubGlobal('fetch', vi.fn(async (input) => new Response(
      String(input).includes('/search/') ? LISTING : detailHtml,
      { status: 200, headers: { 'content-type': 'text/html' } },
    )));
  }

  it('gives the 49-word body of the live Lackierer:in page no indexable text, not a padded one', async () => {
    expect(DETAIL).toContain('Carrosserielackierer:in oder Industrielackierer:in');
    stubSite(DETAIL);

    const jobs = await fetchAllStadlerRailJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0].description).toBe('');
    expect(jobs[0].descriptionByLocale).toEqual({});
  });

  it('publishes a body from 50 words up as the source wrote it', async () => {
    const longer = DETAIL.replace('Vielfältige Tagesaufgaben in unterschiedlichen Gruppe', 'Vielfältige Tagesaufgaben in unterschiedlichen Gruppen der Lackiererei am Standort Altenrhein');
    stubSite(longer);

    const jobs = await fetchAllStadlerRailJobs();

    expect(jobs).toHaveLength(1);
    const [job] = jobs;
    expect(job.description.split(/\s+/).filter(Boolean).length).toBeGreaterThanOrEqual(50);
    expect(job.description).toMatch(/^PROFIL\n\n- abgeschlossene Ausbildung als Carrosserielackierer:in/);
    expect(job.descriptionByLocale).toEqual({ de: job.description });
    expect(job.description).not.toMatch(/bei Stadler Rail in|Stadler ist ein weltweit tätiger/);
  });

  it('gives a posting without a body no description', async () => {
    const withoutBody = DETAIL.replace(/<span itemprop="description"[\s\S]*?<\/div>\s*<\/span>/, '');
    expect(withoutBody).not.toContain('itemprop="description"');
    stubSite(withoutBody);

    const jobs = await fetchAllStadlerRailJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0].description).toBe('');
    expect(jobs[0].descriptionByLocale).toEqual({});
  });
});

// Issue 5253: stored jobs still carry the paragraph the parser used to publish
// instead of a short body. The standard pipeline keeps a stored source slot
// when the fresh one is empty, so the runner drops that text from its stored
// jobs through the `prepareExistingJobs` hook before the merge. Fixture: the
// "Lackierer:in" record of the origin/main slice (2026-09-29), all four slots.
describe('stored fallback paragraph — removed before the merge', () => {
  const STORED = JSON.parse(fs.readFileSync(new URL('./fixtures/stadler-rail-stored-fallback-lackierer.json', import.meta.url), 'utf8'));

  it('recognises the stored paragraph and removes it with its translations, slugs untouched', () => {
    expect(STADLER_RAIL_FABRICATED_DESCRIPTION_RE.test(STORED.descriptionByLocale.de)).toBe(true);
    const jobs = dropFabricatedDescriptions([JSON.parse(JSON.stringify(STORED))], STADLER_RAIL_FABRICATED_DESCRIPTION_RE, 'Stadler Rail');

    expect(jobs).toHaveLength(1);
    expect(jobs[0].description).toBe('');
    expect(jobs[0].descriptionByLocale).toEqual({});
    expect(jobs[0].needsRetranslation).toBe(true);
    expect(jobs[0].slug).toBe(STORED.slug);
    expect(jobs[0].slugByLocale).toEqual(STORED.slugByLocale);
  });

  it('never matches the text the parser publishes now', () => {
    const DETAIL = fs.readFileSync(new URL('./fixtures/stadler-rail-detail-short-lackierer.html', import.meta.url), 'utf8');
    expect(STADLER_RAIL_FABRICATED_DESCRIPTION_RE.test(DETAIL)).toBe(false);
  });

  it('is wired as prepareExistingJobs in the runner', () => {
    const runner = fs.readFileSync('scripts/update-stadler-rail-jobs.mjs', 'utf8');
    expect(runner).toMatch(/prepareExistingJobs: \(jobs\) => dropFabricatedDescriptions\(jobs, STADLER_RAIL_FABRICATED_DESCRIPTION_RE,/);
  });
});
