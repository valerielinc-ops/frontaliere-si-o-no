import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  RECRUITINGAPP_2649_KEY,
  RECRUITINGAPP_2649_COMPANY_NAME,
  assertCompleteRecruitingapp2649Snapshot,
  canonicalRecruitingapp2649Url,
  fetchAllRecruitingapp2649Jobs,
  isRecruitingapp2649Job,
  isTrustedDomain,
} from '../scripts/lib/recruitingapp-2649-job-parser.mjs';
import { clearPoliteFetchStateForTests } from '../scripts/lib/prospector/polite-fetch.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

const SEED_URL = 'https://recruitingapp-2649.umantis.com/Jobs/1?lang=ger&ContentOnly=&message=';
const FIXTURE_DIR = path.join(process.cwd(), 'tests', 'fixtures');
const BONN_DETAIL = fs.readFileSync(path.join(FIXTURE_DIR, 'umantis-prospector-2649.html'), 'utf8');

function response(url: string, status: number, body = '') {
  const value = {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: () => null },
    body: { cancel: vi.fn() },
    text: async () => body,
    clone: () => response(url, status, body),
  } as any;
  return value;
}

function sourceRuntime(details: Record<string, {
  status?: number;
  body: string;
  title?: string;
  href?: string;
}>) {
  const links = Object.keys(details).map((id) =>
    `<a href="${details[id].href || `/Vacancies/${id}/Description/1`}">${details[id].title || 'Liegenschaftskoordinator (m/w/d)'}</a>`).join('\n');
  const requested: string[] = [];
  const fetchImpl = vi.fn(async (url: string) => {
    requested.push(url);
    if (url === 'https://recruitingapp-2649.umantis.com/robots.txt') {
      return response(url, 200, 'User-agent: *\nAllow: /');
    }
    if (url === SEED_URL) return response(url, 200, links);
    const id = /\/Vacancies\/(\d+)\//.exec(url)?.[1] || '';
    if (id && details[id]) return response(url, details[id].status ?? 200, details[id].body);
    throw new Error(`unexpected URL ${url}`);
  });
  return {
    runtime: {
      fetchImpl,
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      sleepImpl: async () => {},
      retries: 0,
    },
    requested,
  };
}

const CHIASSO_DETAIL = `<main>
  <div class="intro"><h1>Source-backed Swiss vacancy</h1><p>Chiasso ◆ 100%</p></div>
  <div class="customdatablock"><h2>Ihre Aufgaben</h2><p>
    Sie koordinieren anspruchsvolle Programme, bearbeiten vollständige Dossiers und arbeiten eng
    mit internen sowie externen Partnern zusammen. Sie dokumentieren Entscheidungen sorgfältig,
    überwachen Termine und stellen eine verlässliche Qualität über den gesamten Prozess sicher.
  </p><h2>Ihr Profil</h2><p>
    Sie verfügen über eine passende Ausbildung, mehrjährige Berufserfahrung, sehr gute
    Deutschkenntnisse und eine strukturierte, verantwortungsbewusste Arbeitsweise.
  </p></div>
</main>`;

describe('Alexander von Humboldt-Stiftung Stellen crawler parser', () => {
  beforeEach(() => clearPoliteFetchStateForTests());

  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(RECRUITINGAPP_2649_KEY).toBe('recruitingapp-2649');
    expect(RECRUITINGAPP_2649_COMPANY_NAME).toBe('Alexander von Humboldt-Stiftung Stellen');
  });

  // ── isCompanyJob ──
  describe('isRecruitingapp2649Job', () => {
    it('matches by companyKey', () => {
      expect(isRecruitingapp2649Job({ companyKey: 'recruitingapp-2649' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isRecruitingapp2649Job({ company: 'Alexander von Humboldt-Stiftung Stellen' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isRecruitingapp2649Job({ url: 'https://recruitingapp-2649.umantis.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isRecruitingapp2649Job({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isRecruitingapp2649Job(null)).toBe(false);
      expect(isRecruitingapp2649Job(undefined)).toBe(false);
      expect(isRecruitingapp2649Job({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://recruitingapp-2649.umantis.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.recruitingapp-2649.umantis.com/job/456')).toBe(true);
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
      expect(slugify('Developer recruitingapp-2649 ch')).toBe('developer-recruitingapp-2649-ch');
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
      id: 'recruitingapp-2649-abc123',
      slug: 'test-position-recruitingapp-2649-ch',
      slugByLocale: { de: 'test-position-recruitingapp-2649-ch' },
      company: 'Alexander von Humboldt-Stiftung Stellen',
      companyKey: 'recruitingapp-2649',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://recruitingapp-2649.umantis.com/jobs/test',
      source: 'Alexander von Humboldt-Stiftung Stellen Dedicated Parser',
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
      expect(validJob.id).toMatch(/^recruitingapp-2649-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  describe('authoritative non-Swiss snapshot', () => {
    it('canonicalizes Umantis query, hash and Description/N variants before identity hashing', () => {
      expect(canonicalRecruitingapp2649Url(
        'https://recruitingapp-2649.umantis.com/Vacancies/9001/Description/4?lang=ger#apply',
      )).toBe('https://recruitingapp-2649.umantis.com/Vacancies/9001/Description/1');
      expect(canonicalRecruitingapp2649Url(
        'https://other.example/Vacancies/9001/Description/1',
      )).toBe('');
    });

    it('proves a complete rich Bonn snapshot and authorizes an atomic empty publication', async () => {
      const { runtime, requested } = sourceRuntime({
        '3705': { body: BONN_DETAIL },
        '4018': { body: BONN_DETAIL },
      });

      const jobs = await fetchAllRecruitingapp2649Jobs(runtime);

      expect(jobs).toEqual([]);
      expect((jobs as any).discoveredCount).toBe(2);
      expect((jobs as any).authoritativeSnapshotProof).toMatchObject({
        discoveredCount: 2,
        detailCount: 2,
        publishedCount: 0,
        complete: true,
        details: [
          expect.objectContaining({ id: '3705', rich: true, swiss: false, locations: ['Bonn'] }),
          expect.objectContaining({ id: '4018', rich: true, swiss: false, locations: ['Bonn'] }),
        ],
      });
      expect(assertCompleteRecruitingapp2649Snapshot(jobs)).toBe(true);
      expect(requested).toContain('https://recruitingapp-2649.umantis.com/Vacancies/3705/Description/1');
      expect(requested).toContain('https://recruitingapp-2649.umantis.com/Vacancies/4018/Description/1');
    });

    it('fails the whole batch when one canonical detail request is unavailable', async () => {
      const { runtime } = sourceRuntime({
        '3705': { body: BONN_DETAIL },
        '4018': { status: 503, body: 'temporarily unavailable' },
      });

      await expect(fetchAllRecruitingapp2649Jobs(runtime))
        .rejects.toThrow('incomplete detail snapshot (1/2)');
    });

    it('fails the whole batch when a detail is thin or has no source location', async () => {
      const { runtime } = sourceRuntime({
        '3705': { body: BONN_DETAIL },
        '4018': { body: '<main><h1>Maintenance</h1></main>' },
      });

      await expect(fetchAllRecruitingapp2649Jobs(runtime))
        .rejects.toThrow('incomplete detail snapshot (2/2)');
    });

    it('publishes a Swiss source row with stable canonical URL, ID and slug across two runs', async () => {
      const firstSource = sourceRuntime({
        '9001': {
          body: CHIASSO_DETAIL,
          title: 'Source-backed Swiss vacancy',
          href: '/Vacancies/9001/Description/1?lang=ger#overview',
        },
      });
      const secondSource = sourceRuntime({
        '9001': {
          body: CHIASSO_DETAIL,
          title: 'Source-backed Swiss vacancy',
          href: '/Vacancies/9001/Description/1?lang=eng#apply',
        },
      });

      const [first] = await fetchAllRecruitingapp2649Jobs(firstSource.runtime);
      clearPoliteFetchStateForTests();
      const [second] = await fetchAllRecruitingapp2649Jobs(secondSource.runtime);

      expect(first).toMatchObject({
        id: expect.stringMatching(/^recruitingapp-2649-[a-f0-9]{12}$/),
        url: 'https://recruitingapp-2649.umantis.com/Vacancies/9001/Description/1',
        applyUrl: 'https://recruitingapp-2649.umantis.com/Vacancies/9001/Description/1',
        location: 'Chiasso',
        canton: 'TI',
        country: 'CH',
      });
      expect(first.description.length).toBeGreaterThan(300);
      expect(second).toMatchObject({ id: first.id, url: first.url, slug: first.slug });
      expect(first.previousSlugs).toBeUndefined();
      expect(second.previousSlugs).toBeUndefined();
    });

    it('wires empty-only authority and slug preservation at the updater boundary', () => {
      const updater = fs.readFileSync('scripts/update-recruitingapp-2649-jobs.mjs', 'utf8');
      expect(updater).toContain('validateAuthoritativeSnapshot: assertCompleteRecruitingapp2649Snapshot');
      expect(updater).toContain('allowAuthoritativeEmptySnapshot: true');
      expect(updater).toContain("authoritativeSnapshotScope: 'empty-only'");
      expect(updater).toContain('preserveExistingSlugs: true');
    });
  });
});
