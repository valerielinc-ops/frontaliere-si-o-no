import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  RECRUITINGAPP_1123_KEY,
  RECRUITINGAPP_1123_COMPANY_NAME,
  assertCompleteRecruitingapp1123Snapshot,
  discoverRecruitingapp1123Listings,
  fetchAllRecruitingapp1123Jobs,
  isRecruitingapp1123Job,
  isTrustedDomain,
} from '../scripts/lib/recruitingapp-1123-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

const richDetail = fs.readFileSync(
  path.resolve(import.meta.dirname, 'fixtures', 'recruitingapp-1123-detail-rich.html'),
  'utf8',
);

function listingHtml(ids = ['101', '102']) {
  return ids.map((id, index) => `<a href="/Vacancies/${id}/Description/1">Technische Projektleitung ${index + 1} (m/w/d)</a>`).join('\n');
}

function runtimeFor(routes: Record<string, string | Error | { status: number; body?: string }>) {
  return {
    now: () => '2026-09-01T12:00:00.000Z',
    ignoreRobots: true,
    retries: 0,
    sleepImpl: async () => {},
    fetchImpl: async (input: string | URL) => {
      const url = String(input);
      const route = Object.entries(routes).find(([needle]) => url.includes(needle))?.[1];
      if (!route) return new Response('not found', { status: 404 });
      if (typeof route === 'string') return new Response(route, { status: 200 });
      if (route instanceof Error) throw route;
      return new Response(route.body || '', { status: route.status });
    },
  };
}

describe('BIG & ARE Stellen crawler parser', () => {
  describe('authoritative Umantis detail contract (#5253)', () => {
    it('discovers only canonical numeric vacancy links', () => {
      const html = '<a href="http://recruitingapp-1123.umantis.com/Vacancies/101/Description/2?lang=ger&utm_source=x#top">Technische Projektleitung</a>' +
        '<a href="/Vacancies/InitiativeApplication/CheckLogin/1">Initiativ</a>';
      expect(discoverRecruitingapp1123Listings(html)).toEqual([expect.objectContaining({
        vacancyId: '101',
        url: 'https://recruitingapp-1123.umantis.com/Vacancies/101/Description/1',
      })]);
    });

    it('keeps canonical URL and ID when the listing varies Description, query, or fragment', async () => {
      const runtime = runtimeFor({
        '/Jobs/1': '<a href="/Vacancies/101/Description/2?lang=ger&utm_source=x#top">Technische Projektleitung</a>',
        '/Vacancies/101/': richDetail.replace(
          'Wir bieten moderne Arbeitsmittel',
          'Als Immobilieneigentümerin Österreichs bieten wir moderne Arbeitsmittel',
        ),
      });
      const [job] = await fetchAllRecruitingapp1123Jobs(runtime);
      expect(job).toMatchObject({
        url: 'https://recruitingapp-1123.umantis.com/Vacancies/101/Description/1',
        id: 'recruitingapp-1123-70aa3727c62d',
        location: 'Bern',
        canton: 'BE',
      });
    });

    it('publishes rich source-backed descriptions atomically and is idempotent', async () => {
      const runtime = runtimeFor({
        '/Jobs/1': listingHtml(),
        '/Vacancies/101/': richDetail,
        '/Vacancies/102/': richDetail.replace('Standort: Bern', 'Standort: Zürich'),
      });
      const first = await fetchAllRecruitingapp1123Jobs(runtime);
      const second = await fetchAllRecruitingapp1123Jobs(runtime);

      expect(first).toHaveLength(2);
      expect(first.map((job) => `${job.location}/${job.canton}`)).toEqual(['Bern/BE', 'Zürich/ZH']);
      expect(first.every((job) => job.description.trim().split(/\s+/).length >= 50)).toBe(true);
      expect(first.every((job) => !job.description.includes('BIG & ARE Stellen, Lugano'))).toBe(true);
      expect(first.map((job) => job.id)).toEqual([
        'recruitingapp-1123-70aa3727c62d',
        'recruitingapp-1123-bb6c89475996',
      ]);
      expect(second).toEqual(first);
      expect(assertCompleteRecruitingapp1123Snapshot(first)).toBe(true);
      expect(first.map(({ id, url, slug, slugByLocale }) => ({ id, url, slug, slugByLocale })))
        .toEqual(second.map(({ id, url, slug, slugByLocale }) => ({ id, url, slug, slugByLocale })));
    });

    it('rejects the complete batch when one rich detail request fails', async () => {
      const runtime = runtimeFor({
        '/Jobs/1': listingHtml(),
        '/Vacancies/101/': richDetail,
        '/Vacancies/102/': { status: 503 },
      });
      await expect(fetchAllRecruitingapp1123Jobs(runtime)).rejects.toThrow(/source fetch failed \(503\)/);
    });

    it('rejects the complete batch on a detail timeout', async () => {
      const runtime = runtimeFor({
        '/Jobs/1': listingHtml(['101']),
        '/Vacancies/101/': new DOMException('request timed out', 'AbortError'),
      });
      await expect(fetchAllRecruitingapp1123Jobs(runtime)).rejects.toThrow(/source fetch failed \(0\)/);
    });

    it('rejects malformed or thin detail instead of publishing listing boilerplate', async () => {
      const runtime = runtimeFor({
        '/Jobs/1': listingHtml(['101']),
        '/Vacancies/101/': '<main class="content-main"><p>Standort: Bern</p><p>Kurzer Text.</p></main>',
      });
      await expect(fetchAllRecruitingapp1123Jobs(runtime)).rejects.toThrow(/description is thin/);
    });

    it('rejects a rich detail without source-backed location evidence', async () => {
      const runtime = runtimeFor({
        '/Jobs/1': listingHtml(['101']),
        '/Vacancies/101/': richDetail.replace('<p>Standort: Bern</p>', ''),
      });
      await expect(fetchAllRecruitingapp1123Jobs(runtime)).rejects.toThrow(/detail location is missing/);
    });

    it('rejects contradictory Swiss and foreign structured detail locations', async () => {
      const pageUrl = 'https://recruitingapp-1123.umantis.com/Vacancies/101/Description/1';
      const jsonLd = JSON.stringify({
        '@type': 'JobPosting',
        title: 'Technische Projektleitung (m/w/d)',
        url: pageUrl,
        jobLocation: {
          address: { addressLocality: 'Bern', addressRegion: 'BE', addressCountry: 'CH' },
        },
      });
      const conflictingDetail = richDetail.replace('<main class="content-main">',
        `<script type="application/ld+json">${jsonLd}</script>` +
        '<article itemscope itemtype="https://schema.org/JobPosting">' +
        '<meta itemprop="title" content="Technische Projektleitung (m/w/d)">' +
        '<div itemprop="jobLocation"><meta itemprop="addressLocality" content="Geneva">' +
        '<meta itemprop="addressRegion" content="NY"><meta itemprop="addressCountry" content="US"></div>' +
        '</article><main class="content-main">');
      const runtime = runtimeFor({
        '/Jobs/1': listingHtml(['101']),
        '/Vacancies/101/': conflictingDetail,
      });
      await expect(fetchAllRecruitingapp1123Jobs(runtime)).rejects.toThrow(/location evidence conflicts/);
    });

    it('drops an authoritative non-Swiss detail without inventing Lugano or an HQ', async () => {
      const runtime = runtimeFor({
        '/Jobs/1': listingHtml(['101']),
        '/Vacancies/101/': richDetail
          .replace('Standort: Bern', 'Standort: Linz')
          .replace('Wir bieten moderne Arbeitsmittel', 'Als Immobilieneigentümerin Österreichs bieten wir moderne Arbeitsmittel'),
      });
      const empty = await fetchAllRecruitingapp1123Jobs(runtime);
      expect(empty).toHaveLength(0);
      expect(empty.discoveredCount).toBe(1);
      expect(empty.detailCount).toBe(1);
      expect(empty.foreignCount).toBe(1);
      expect(assertCompleteRecruitingapp1123Snapshot(empty)).toBe(true);
    });

    it('wires stable slug/history preservation in the runner', () => {
      const runner = fs.readFileSync(path.resolve(import.meta.dirname, '../scripts/update-recruitingapp-1123-jobs.mjs'), 'utf8');
      expect(runner).toContain('preserveExistingSlugs: true');
      expect(runner).toContain('validateAuthoritativeSnapshot: assertCompleteRecruitingapp1123Snapshot');
      expect(runner).toContain('allowAuthoritativeEmptySnapshot: true');
    });
  });

  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(RECRUITINGAPP_1123_KEY).toBe('recruitingapp-1123');
    expect(RECRUITINGAPP_1123_COMPANY_NAME).toBe('BIG & ARE Stellen');
  });

  // ── isCompanyJob ──
  describe('isRecruitingapp1123Job', () => {
    it('matches by companyKey', () => {
      expect(isRecruitingapp1123Job({ companyKey: 'recruitingapp-1123' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isRecruitingapp1123Job({ company: 'BIG & ARE Stellen' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isRecruitingapp1123Job({ url: 'https://recruitingapp-1123.umantis.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isRecruitingapp1123Job({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isRecruitingapp1123Job(null)).toBe(false);
      expect(isRecruitingapp1123Job(undefined)).toBe(false);
      expect(isRecruitingapp1123Job({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://recruitingapp-1123.umantis.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.recruitingapp-1123.umantis.com/job/456')).toBe(true);
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
      expect(slugify('Developer recruitingapp-1123 ch')).toBe('developer-recruitingapp-1123-ch');
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
      id: 'recruitingapp-1123-abc123',
      slug: 'test-position-recruitingapp-1123-ch',
      slugByLocale: { de: 'test-position-recruitingapp-1123-ch' },
      company: 'BIG & ARE Stellen',
      companyKey: 'recruitingapp-1123',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://recruitingapp-1123.umantis.com/jobs/test',
      source: 'BIG & ARE Stellen Dedicated Parser',
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
      expect(validJob.id).toMatch(/^recruitingapp-1123-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
