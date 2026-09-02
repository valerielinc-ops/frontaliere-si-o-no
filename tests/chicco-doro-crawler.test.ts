import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import {
  CHICCO_DORO_KEY,
  CHICCO_DORO_COMPANY_NAME,
  assertCompleteChiccoDoroSnapshot,
  fetchAllChiccoDoroJobs,
  isChiccoDoroJob,
  isTrustedDomain,
  parseListingPage,
} from '../scripts/lib/chicco-doro-job-parser.mjs';
import { evaluateAuthoritativeSnapshot, slugify } from '../scripts/lib/crawler-template.mjs';
import { mergePreserveLocaleData } from '../scripts/lib/dedicated-crawler-common.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OPEN_APPLICATION_FIXTURE = fs.readFileSync(
  path.join(ROOT, 'tests/fixtures/chicco-doro/contatti-open-application-only.html'),
  'utf8',
);

const brandedPage = (body = '') => `<!doctype html><html><head><title>Chicco d'Oro</title></head><body>${body}</body></html>`;

describe('Chicco d\u2019Oro crawler parser', () => {
  it('rejects the generic open-application CTA that caused the 1 -> 0 health loop', () => {
    expect(parseListingPage(OPEN_APPLICATION_FIXTURE, 'https://www.chiccodoro.com/contatti')).toEqual([]);
  });

  it('keeps a concrete vacancy beside the generic invitation', () => {
    const html = brandedPage(`
      <main>
        <h2>Lavora con noi</h2>
        <h3><a href="/jobs/tecnico-manutentore">Tecnico manutentore</a></h3>
        <p>Posizione aperta per la manutenzione degli impianti di produzione.</p>
      </main>
    `);
    expect(parseListingPage(html, 'https://www.chiccodoro.com/contatti')).toEqual([
      expect.objectContaining({
        title: 'Tecnico manutentore',
        url: 'https://www.chiccodoro.com/jobs/tecnico-manutentore',
      }),
    ]);
  });

  it('proves an empty snapshot only after the bounded source inventory resolves', async () => {
    const fetchPage = vi.fn(async (url: string) => {
      if (url.endsWith('/contatti')) {
        return OPEN_APPLICATION_FIXTURE;
      }
      throw new Error(`HTTP 404 from ${url}`);
    });
    const jobs = await fetchAllChiccoDoroJobs({ fetchPage, sleep: async () => {} });

    expect(jobs).toEqual([]);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(assertCompleteChiccoDoroSnapshot(jobs)).toBe(true);
    expect(evaluateAuthoritativeSnapshot(jobs, {
      validateAuthoritativeSnapshot: assertCompleteChiccoDoroSnapshot,
      allowAuthoritativeEmptySnapshot: true,
      companyLabel: CHICCO_DORO_COMPANY_NAME,
    })).toEqual({
      authoritativeSnapshotVerified: true,
      authoritativeEmptySnapshot: true,
    });
  });

  it('keeps real vacancies when an optional source path times out', async () => {
    const fetchPage = vi.fn(async (url: string) => {
      if (url.endsWith('/contatti')) {
        return brandedPage(`
          <h2>Lavora con noi</h2>
          <h3><a href="/jobs/tecnico-manutentore">Tecnico manutentore</a></h3>
          <p>Posizione aperta per la manutenzione degli impianti di produzione.</p>
        `);
      }
      if (url.endsWith('/jobs/tecnico-manutentore')) {
        return brandedPage(`<main class="job-detail">${'Descrizione autorevole della posizione '.repeat(8)}</main>`);
      }
      if (url.endsWith('/careers')) throw new Error(`HTTP 404 from ${url}`);
      throw new Error('socket timeout');
    });

    const jobs = await fetchAllChiccoDoroJobs({ fetchPage, sleep: async () => {} });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toEqual(expect.objectContaining({ title: 'Tecnico manutentore' }));
    expect(() => assertCompleteChiccoDoroSnapshot(jobs)).toThrow(/not a proven complete/);
    expect(evaluateAuthoritativeSnapshot(jobs, {
      validateAuthoritativeSnapshot: assertCompleteChiccoDoroSnapshot,
      allowAuthoritativeEmptySnapshot: true,
      authoritativeSnapshotScope: 'empty-only',
      companyLabel: CHICCO_DORO_COMPANY_NAME,
    })).toEqual({
      authoritativeSnapshotVerified: false,
      authoritativeEmptySnapshot: false,
    });
  });

  it('retires a real vacancy that disappears from a non-empty snapshot within a bounded number of runs', () => {
    // Follow-up #7020 item 1: the runner never confirms a proven-zero
    // snapshot while a real listing keeps showing up (`authoritativeSnapshotScope:
    // 'empty-only'` only verifies empty batches), so `retainMissingJobs` stays
    // at its shared default (true) for a job that goes missing here. That
    // default is NOT unbounded — mergePreserveLocaleData caps it at
    // GRACE_PERIOD_MAX_MISSES (2) consecutive misses regardless of company.
    const goneJob = {
      id: 'chicco-doro-gone-role',
      url: 'https://www.chiccodoro.com/jobs/gone-role',
      companyKey: CHICCO_DORO_KEY,
      company: CHICCO_DORO_COMPANY_NAME,
      title: 'Ruolo sparito',
      slug: 'ruolo-sparito-chicco-doro-ch',
    };
    const stayingJob = {
      id: 'chicco-doro-staying-role',
      url: 'https://www.chiccodoro.com/jobs/staying-role',
      companyKey: CHICCO_DORO_KEY,
      company: CHICCO_DORO_COMPANY_NAME,
      title: 'Ruolo presente',
      slug: 'ruolo-presente-chicco-doro-ch',
    };

    let existing = [goneJob];
    for (let run = 1; run <= 3; run++) {
      // parsedJobs is never empty across these runs — the crawl never proves
      // a complete zero, so authoritativeSnapshotVerified stays false and the
      // runner never sets retainMissingJobs: false (mirrors the mergeOpts
      // built in runStandardCrawlerPipeline).
      const parsedJobs = [{ ...stayingJob }];
      const { authoritativeSnapshotVerified } = evaluateAuthoritativeSnapshot(parsedJobs, {
        validateAuthoritativeSnapshot: assertCompleteChiccoDoroSnapshot,
        allowAuthoritativeEmptySnapshot: true,
        authoritativeSnapshotScope: 'empty-only',
        companyLabel: CHICCO_DORO_COMPANY_NAME,
      });
      expect(authoritativeSnapshotVerified).toBe(false);

      existing = mergePreserveLocaleData(existing, parsedJobs, {
        ...(authoritativeSnapshotVerified ? { retainMissingJobs: false } : {}),
      });

      if (run < 3) {
        expect(existing.find((j) => j.id === goneJob.id)).toBeDefined();
      }
    }

    expect(existing.find((j) => j.id === goneJob.id)).toBeUndefined();
  });

  it('fails closed when one source path is unresolved or the source identity disappears', async () => {
    const unresolved = vi.fn(async (url: string) => {
      if (url.endsWith('/contatti')) return brandedPage('<h2>Lavora con noi</h2>');
      if (url.endsWith('/careers')) throw new Error(`HTTP 404 from ${url}`);
      throw new Error('socket timeout');
    });
    const incomplete = await fetchAllChiccoDoroJobs({ fetchPage: unresolved, sleep: async () => {} });
    expect(() => assertCompleteChiccoDoroSnapshot(incomplete)).toThrow(/not a proven complete/);

    const wrongBrand = vi.fn(async (url: string) => {
      if (url.endsWith('/contatti')) return '<html><title>Unrelated company</title><h2>Lavora con noi</h2></html>';
      throw new Error(`HTTP 404 from ${url}`);
    });
    const untrusted = await fetchAllChiccoDoroJobs({ fetchPage: wrongBrand, sleep: async () => {} });
    expect(() => assertCompleteChiccoDoroSnapshot(untrusted)).toThrow(/not a proven complete/);

    const unparsedStructuredJob = vi.fn(async (url: string) => {
      if (url.endsWith('/contatti')) {
        return brandedPage('<h2>Lavora con noi</h2><script type="application/ld+json">{"@type":"JobPosting"}</script>');
      }
      throw new Error(`HTTP 404 from ${url}`);
    });
    const structured = await fetchAllChiccoDoroJobs({ fetchPage: unparsedStructuredJob, sleep: async () => {} });
    expect(() => assertCompleteChiccoDoroSnapshot(structured)).toThrow(/not a proven complete/);

    const unrelatedSchemaMention = vi.fn(async (url: string) => {
      if (url.endsWith('/contatti')) {
        return brandedPage('<h2>Lavora con noi</h2><script type="application/ld+json">{"description":"What is a JobPosting?"}</script>');
      }
      throw new Error(`HTTP 404 from ${url}`);
    });
    const unrelated = await fetchAllChiccoDoroJobs({ fetchPage: unrelatedSchemaMention, sleep: async () => {} });
    expect(assertCompleteChiccoDoroSnapshot(unrelated)).toBe(true);
  });

  it('opts the runner into source-validated authoritative empty publishing', () => {
    const runner = fs.readFileSync(path.join(ROOT, 'scripts/update-chicco-doro-jobs.mjs'), 'utf8');
    expect(runner).toContain('validateAuthoritativeSnapshot: assertCompleteChiccoDoroSnapshot');
    expect(runner).toContain('allowAuthoritativeEmptySnapshot: true');
    expect(runner).toContain("authoritativeSnapshotScope: 'empty-only'");
  });

  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(CHICCO_DORO_KEY).toBe('chicco-doro');
    expect(CHICCO_DORO_COMPANY_NAME).toBe("Chicco d\u2019Oro");
  });

  // ── isCompanyJob ──
  describe('isChiccoDoroJob', () => {
    it('matches by companyKey', () => {
      expect(isChiccoDoroJob({ companyKey: 'chicco-doro' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isChiccoDoroJob({ company: "Chicco d\u2019Oro" })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isChiccoDoroJob({ url: 'https://chiccodoro.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isChiccoDoroJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isChiccoDoroJob(null)).toBe(false);
      expect(isChiccoDoroJob(undefined)).toBe(false);
      expect(isChiccoDoroJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://chiccodoro.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.chiccodoro.com/job/456')).toBe(true);
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
      expect(slugify('Developer chicco-doro ch')).toBe('developer-chicco-doro-ch');
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
      id: 'chicco-doro-abc123',
      slug: 'test-position-chicco-doro-ch',
      slugByLocale: { it: 'test-position-chicco-doro-ch' },
      company: "Chicco d\u2019Oro",
      companyKey: 'chicco-doro',
      title: 'Test Position',
      titleByLocale: { it: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { it: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://chiccodoro.com/jobs/test',
      source: "Chicco d\u2019Oro Dedicated Parser",
      sourceLang: 'it',
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
      expect(validJob.id).toMatch(/^chicco-doro-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
