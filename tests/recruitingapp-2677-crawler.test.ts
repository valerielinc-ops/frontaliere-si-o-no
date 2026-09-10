import fs from 'node:fs';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  RECRUITINGAPP_2677_KEY,
  RECRUITINGAPP_2677_COMPANY_NAME,
  assertCompleteRecruitingapp2677Snapshot,
  fetchAllRecruitingapp2677Jobs,
  isRecruitingapp2677Job,
  isTrustedDomain,
} from '../scripts/lib/recruitingapp-2677-job-parser.mjs';
import { clearPoliteFetchStateForTests } from '../scripts/lib/prospector/polite-fetch.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

const SEED_URL = 'https://recruitingapp-2677.umantis.com/Jobs/1?lang=ger&ContentOnly=&message=';

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

function foreignDetail(title: string, location: string) {
  return `<main><div class="content-width">
    <div class="intro"><h1>${title}</h1><p>100% <span>◆</span> ${location} <span>◆</span> w / m / d</p></div>
    <div class="customdatablock"><h2>Ihre Rolle</h2><p>
      Sie koordinieren anspruchsvolle Programme, bearbeiten vollständige Dossiers und arbeiten eng
      mit internen sowie externen Partnern zusammen. Sie dokumentieren Entscheidungen sorgfältig,
      überwachen Termine und stellen eine verlässliche Qualität über den gesamten Prozess sicher.
    </p><h2>Ihr Profil</h2><p>
      Sie verfügen über eine passende Ausbildung, mehrjährige Berufserfahrung, sehr gute
      Deutschkenntnisse und eine strukturierte, verantwortungsbewusste Arbeitsweise.
    </p></div>
  </div></main>`;
}

function sourceRuntime(details: Record<string, {
  status?: number;
  body: string;
  title?: string;
  href?: string;
  responseBodies?: Record<string, string>;
}>, listingHtml = '') {
  const links = Object.keys(details).map((id) =>
    `<a href="${details[id].href || `/Vacancies/${id}/Description/1`}">${details[id].title || `Position ${id}`}</a>`).join('\n');
  const requested: string[] = [];
  const fetchImpl = vi.fn(async (url: string) => {
    requested.push(url);
    if (url === 'https://recruitingapp-2677.umantis.com/robots.txt') {
      return response(url, 200, 'User-agent: *\nAllow: /');
    }
    if (url === SEED_URL) return response(url, 200, listingHtml || links);
    const id = /\/Vacancies\/(\d+)\//.exec(url)?.[1] || '';
    if (id && details[id]) {
      const body = details[id].responseBodies?.[new URL(url).search] || details[id].body;
      return response(url, details[id].status ?? 200, body);
    }
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

describe('E-Recruiting LLB-Gruppe Stellen crawler parser', () => {
  beforeEach(() => clearPoliteFetchStateForTests());

  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(RECRUITINGAPP_2677_KEY).toBe('recruitingapp-2677');
    expect(RECRUITINGAPP_2677_COMPANY_NAME).toBe('E-Recruiting LLB-Gruppe Stellen');
  });

  // ── isCompanyJob ──
  describe('isRecruitingapp2677Job', () => {
    it('matches by companyKey', () => {
      expect(isRecruitingapp2677Job({ companyKey: 'recruitingapp-2677' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isRecruitingapp2677Job({ company: 'E-Recruiting LLB-Gruppe Stellen' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isRecruitingapp2677Job({ url: 'https://recruitingapp-2677.umantis.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isRecruitingapp2677Job({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isRecruitingapp2677Job(null)).toBe(false);
      expect(isRecruitingapp2677Job(undefined)).toBe(false);
      expect(isRecruitingapp2677Job({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://recruitingapp-2677.umantis.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.recruitingapp-2677.umantis.com/job/456')).toBe(true);
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
      expect(slugify('Developer recruitingapp-2677 ch')).toBe('developer-recruitingapp-2677-ch');
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
      id: 'recruitingapp-2677-abc123',
      slug: 'test-position-recruitingapp-2677-ch',
      slugByLocale: { de: 'test-position-recruitingapp-2677-ch' },
      company: 'E-Recruiting LLB-Gruppe Stellen',
      companyKey: 'recruitingapp-2677',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://recruitingapp-2677.umantis.com/jobs/test',
      source: 'E-Recruiting LLB-Gruppe Stellen Dedicated Parser',
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
      expect(validJob.id).toMatch(/^recruitingapp-2677-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  describe('authoritative non-Swiss snapshot', () => {
    it('proves a complete foreign snapshot and authorizes an atomic empty publication', async () => {
      const { runtime, requested } = sourceRuntime({
        '1994': { title: 'Kundenberater:in', body: foreignDetail('Kundenberater:in', 'Vaduz') },
        '1983': { title: 'Associate Institutional Banking', body: foreignDetail('Associate Institutional Banking', 'Wien') },
      });

      const jobs = await fetchAllRecruitingapp2677Jobs(runtime);

      expect(jobs).toEqual([]);
      expect((jobs as any).discoveredCount).toBe(2);
      expect((jobs as any).authoritativeSnapshotProof).toMatchObject({
        discoveredCount: 2,
        attemptedDetailCount: 2,
        detailCount: 2,
        publishedCount: 0,
        complete: true,
        details: expect.arrayContaining([
          expect.objectContaining({ id: '1994', rich: true, swiss: false, locations: ['Vaduz'] }),
          expect.objectContaining({ id: '1983', rich: true, swiss: false, locations: ['Wien'] }),
        ]),
      });
      expect(assertCompleteRecruitingapp2677Snapshot(jobs)).toBe(true);
      expect(requested).toContain('https://recruitingapp-2677.umantis.com/Vacancies/1994/Description/1');
      expect(requested).toContain('https://recruitingapp-2677.umantis.com/Vacancies/1983/Description/1');
    });

    it('preserves the generic rendered-empty proof for a genuinely empty board', async () => {
      const { runtime } = sourceRuntime({}, '<div>Es wurden noch keine Einträge erfasst</div>');

      const jobs = await fetchAllRecruitingapp2677Jobs(runtime);

      expect(jobs).toEqual([]);
      expect(assertCompleteRecruitingapp2677Snapshot(jobs)).toBe(true);
    });

    it('fails closed when duplicate listing links disagree even after a third link', async () => {
      const { runtime } = sourceRuntime({
        '1994': { title: 'Kundenberater:in', body: foreignDetail('Kundenberater:in', 'Vaduz') },
      }, `<a href="/Vacancies/1994/Description/1">Title A</a>
        <a href="/Vacancies/1994/Description/1?second=1">Title B</a>
        <a href="/Vacancies/1994/Description/1?third=1">Title C</a>`);

      await expect(fetchAllRecruitingapp2677Jobs(runtime))
        .rejects.toThrow('incomplete detail snapshot (1/1)');
    });

    it('fails closed when repeated detail identity includes an earlier thin response', async () => {
      const { runtime } = sourceRuntime({
        '1994': {
          title: 'Kundenberater:in',
          body: foreignDetail('Kundenberater:in', 'Vaduz'),
          responseBodies: {
            '?thin=1': '<main><h1>Kundenberater:in</h1></main>',
          },
        },
      }, `<a href="/Vacancies/1994/Description/1">Kundenberater:in</a>
        <a href="/Vacancies/1994/Description/1?thin=1">Kundenberater:in</a>`);

      await expect(fetchAllRecruitingapp2677Jobs(runtime))
        .rejects.toThrow('incomplete detail snapshot (1/1)');
    });

    it('finds the source locality in a later intro block', async () => {
      const body = foreignDetail('Kundenberater:in', 'Vaduz')
        .replace('<main><div class="content-width">', '<main><div class="intro"><p>Legacy metadata</p></div><div class="content-width">');
      const { runtime } = sourceRuntime({
        '1994': { title: 'Kundenberater:in', body },
      });

      const jobs = await fetchAllRecruitingapp2677Jobs(runtime);

      expect(assertCompleteRecruitingapp2677Snapshot(jobs)).toBe(true);
    });

    it('fails the whole batch when one detail request is unavailable', async () => {
      const { runtime } = sourceRuntime({
        '1994': { title: 'Kundenberater:in', body: foreignDetail('Kundenberater:in', 'Vaduz') },
        '1983': { title: 'Associate Institutional Banking', status: 503, body: 'temporarily unavailable' },
      });

      await expect(fetchAllRecruitingapp2677Jobs(runtime))
        .rejects.toThrow('incomplete detail snapshot (1/2)');
    });

    it('keeps an unfamiliar source locality fail-closed', async () => {
      const { runtime } = sourceRuntime({
        '1994': { title: 'Kundenberater:in', body: foreignDetail('Kundenberater:in', 'New City') },
      });

      const jobs = await fetchAllRecruitingapp2677Jobs(runtime);

      expect(jobs).toEqual([]);
      expect(assertCompleteRecruitingapp2677Snapshot(jobs)).toBe(false);
    });

    it('publishes a Swiss vacancy from the middle header segment', async () => {
      const { runtime } = sourceRuntime({
        '1989': { title: 'Spezialist:in Fondsadministration', body: foreignDetail('Spezialist:in Fondsadministration', 'Zürich') },
      });

      const [job] = await fetchAllRecruitingapp2677Jobs(runtime);

      expect(job).toMatchObject({
        location: 'Zürich',
        canton: 'ZH',
        country: 'CH',
      });
      expect((job as any).id).toMatch(/^recruitingapp-2677-[a-f0-9]{12}$/);
    });

    it('wires the complete snapshot validator at the updater boundary', () => {
      const updater = fs.readFileSync('scripts/update-recruitingapp-2677-jobs.mjs', 'utf8');
      expect(updater).toContain('validateAuthoritativeSnapshot: assertCompleteRecruitingapp2677Snapshot');
      expect(updater).toContain('allowAuthoritativeEmptySnapshot: true');
      expect(updater).toContain("authoritativeSnapshotScope: 'empty-only'");
      expect(updater).toContain('preserveExistingSlugs: true');
    });
  });
});
