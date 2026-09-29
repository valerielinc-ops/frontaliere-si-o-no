import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  fetchAllKantonAargauJobs,
  parseAgJobsApi,
  extractAgJobPosting,
  KANTON_AARGAU_KEY,
  KANTON_AARGAU_COMPANY_NAME,
  isKantonAargauJob,
  isTrustedDomain,
} from '../scripts/lib/kanton-aargau-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';
import { isConnectionLevelFetchError } from '../scripts/lib/transient-fetch.mjs';

describe('Kanton Aargau crawler parser', () => {
  // -- Constants --
  it('exports valid company key and name', () => {
    expect(KANTON_AARGAU_KEY).toBe('kanton-aargau');
    expect(KANTON_AARGAU_COMPANY_NAME).toBe('Kanton Aargau');
  });

  // -- isCompanyJob --
  describe('isKantonAargauJob', () => {
    it('matches by companyKey', () => {
      expect(isKantonAargauJob({ companyKey: 'kanton-aargau' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isKantonAargauJob({ company: 'Kanton Aargau' })).toBe(true);
    });

    it('matches by ag.ch URL', () => {
      expect(isKantonAargauJob({ url: 'https://www.ag.ch/de/ueber-uns/jobs-karriere/offene-stellen/stellenmarkt' })).toBe(true);
    });

    it('matches by Umantis tenant URL', () => {
      expect(isKantonAargauJob({ url: 'https://recruitingapp-12705.umantis.com/Vacancies/10927/Application/CheckLogin/1' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isKantonAargauJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isKantonAargauJob(null)).toBe(false);
      expect(isKantonAargauJob(undefined)).toBe(false);
      expect(isKantonAargauJob({})).toBe(false);
    });
  });

  // -- isTrustedDomain --
  describe('isTrustedDomain', () => {
    it('trusts ag.ch primary domain', () => {
      expect(isTrustedDomain('https://ag.ch/de/jobs')).toBe(true);
    });

    it('trusts ag.ch subdomains', () => {
      expect(isTrustedDomain('https://www.ag.ch/de/ueber-uns/jobs-karriere/offene-stellen/stellenmarkt')).toBe(true);
    });

    it('trusts the job-market pages and their Prospective apply redirect', () => {
      expect(isTrustedDomain('https://jobs.ag.ch/offene-stellen/juristisches-praktikum/f931e82c-ed5b-4ed8-bd63-17355638c2ff')).toBe(true);
      expect(isTrustedDomain('https://ohws.prospective.ch/public/v1/redirect/f931e82c-ed5b-4ed8-bd63-17355638c2ff/ats/')).toBe(true);
    });

    it('no longer trusts the retired Umantis back office', () => {
      expect(isTrustedDomain('https://recruitingapp-12705.umantis.com/Vacancies/10927/Application/CheckLogin/1')).toBe(false);
      expect(isTrustedDomain('https://recruitingapp-999999.umantis.com/Jobs/All')).toBe(false);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('rejects domains containing ag.ch as substring', () => {
      expect(isTrustedDomain('https://notag.ch/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // -- slugify (imported from crawler-template) --
  describe('slugify', () => {
    it('converts title to URL-safe slug', () => {
      const slug = slugify('Software Engineer (m/f/d)');
      expect(slug).toBe('software-engineer-m-f-d');
    });

    it('strips diacritics', () => {
      expect(slugify('Ingénieur qualité')).toBe('ingenieur-qualite');
    });

    it('handles German umlauts', () => {
      const slug = slugify('Leiterin Sektion Revision Aargau');
      expect(slug).toMatch(/^[a-z0-9-]+$/);
      expect(slug).not.toContain('ä');
      expect(slug).not.toContain('ü');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Sachbearbeiter kanton-aargau ch')).toBe('sachbearbeiter-kanton-aargau-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // -- Job Shape Validation --
  describe('job shape', () => {
    const validJob = {
      id: 'kanton-aargau-61b3a948a8d6',
      slug: 'leiterin-leiter-sektion-revision-kanton-aargau-ch',
      slugByLocale: { de: 'leiterin-leiter-sektion-revision-kanton-aargau-ch' },
      company: 'Kanton Aargau',
      companyKey: 'kanton-aargau',
      companyDomain: 'ag.ch',
      title: 'Leiterin / Leiter Sektion Revision 80-100%',
      titleByLocale: { de: 'Leiterin / Leiter Sektion Revision 80-100%' },
      description: 'Leiterin / Leiter Sektion Revision 80-100% — offene Stelle beim Kanton Aargau, direkt auf dem offiziellen Stellenportal der Kantonalen Verwaltung ausgeschrieben. Der Kanton Aargau zählt mit rund 700\'000 Einwohnerinnen und Einwohnern zu den bevölkerungsreichsten Kantonen der Schweiz und ist einer der grössten Arbeitgeber der Region. Als öffentliche Verwaltung beschäftigt er Mitarbeitende in der kantonalen Verwaltung, den Gerichten, der Kantonspolizei und im Bildungswesen und bietet vielfältige, sinnstiftende Karrieremöglichkeiten in unterschiedlichen Fachbereichen.',
      descriptionByLocale: { de: 'Leiterin / Leiter Sektion Revision 80-100% — offene Stelle beim Kanton Aargau, direkt auf dem offiziellen Stellenportal der Kantonalen Verwaltung ausgeschrieben.' },
      location: 'Aarau',
      canton: 'AG',
      url: 'https://jobs.ag.ch/offene-stellen/leiterin-leiter-sektion-revision/0b6b1b5e-0000-4000-8000-000000000000',
      source: 'Kanton Aargau Dedicated Parser (ag.ch job market)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      addressLocality: 'Aarau',
      streetAddress: 'Bahnhofstrasse 2',
      postalCode: '5000',
      addressCountry: 'CH',
      country: 'CH',
      category: 'Amministrazione',
      contract: 'full-time',
      employmentType: 'FULL_TIME',
      experienceLevel: 'senior',
      sector: 'Amministrazione Pubblica',
      currency: 'CHF',
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

    it('has all recommended fields', () => {
      const recommended = [
        'addressLocality', 'streetAddress', 'postalCode', 'addressCountry', 'country',
        'category', 'contract', 'employmentType', 'experienceLevel',
        'sector', 'currency',
      ];
      for (const field of recommended) {
        expect(validJob).toHaveProperty(field);
      }
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^kanton-aargau-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('description has minimum 50 words (thin-content floor)', () => {
      const wordCount = validJob.description.split(/\s+/).filter(Boolean).length;
      expect(wordCount).toBeGreaterThanOrEqual(50);
    });

    it('sector is Amministrazione Pubblica', () => {
      expect(validJob.sector).toBe('Amministrazione Pubblica');
    });

    it('URL points to the vacancy page of the official job market', () => {
      expect(validJob.url).toMatch(/^https:\/\/jobs\.ag\.ch\/offene-stellen\//);
    });
  });

  // Issue 5253: the Umantis back office listed 423 rows (~110 from 2020-2022,
  // repeated titles, synthesised body); the canton's job market lists the open
  // vacancies with full ads. Real API payload and page, minimised.
  describe('official job market', () => {
    const fixture = (name: string) => readFileSync(resolve(__dirname, 'fixtures', 'kanton-aargau', name), 'utf8');

    it('reads one entry per vacancy from the jobs-proxy API', () => {
      const entries = parseAgJobsApi(JSON.parse(fixture('jobs-proxy-sample.json')));
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({
        id: '10199001',
        title: 'Juristisches Praktikum 100%',
        url: 'https://jobs.ag.ch/offene-stellen/juristisches-praktikum/f931e82c-ed5b-4ed8-bd63-17355638c2ff',
        location: 'Schafisheim',
        department: 'Strassenverkehrsamt',
        pensum: '80 - 100%',
        term: 'befristet',
      });
    });

    it('publishes the JSON-LD ad with lists, the benefits and the workplace address', () => {
      const detail = extractAgJobPosting(fixture('detail-juristisches-praktikum.html'));
      expect(detail.description).toContain('Spannende Aufgaben warten:\n• Abklärung und Beurteilung rechtlicher Fragestellungen');
      expect(detail.description).toContain('Was du mitbringst:\n• Abgeschlossenes juristisches Studium');
      expect(detail.description).toContain('Dein Arbeitsumfeld');
      expect(detail.description).toContain('Benefits\nGesund bleiben\n• Ganzheitliches Betriebliches Gesundheitsmanagement');
      expect(detail.description).not.toMatch(/&#39;|<[a-z]/i);
      expect(detail).toMatchObject({ addressLocality: 'Schafisheim', postalCode: '5503', streetAddress: 'Länzert 2' });
    });

    it('returns an empty body when the page has no JobPosting', () => {
      expect(extractAgJobPosting('<html><body><p>Seite nicht gefunden</p></body></html>').description).toBe('');
    });
  });

  // Review of PR 10336: the board is published whole or not at all. A partial
  // API answer or an unreadable vacancy page must fail the run (exit non-zero
  // from the runner) so the pipeline keeps the slice it already has.
  describe('fetchAllKantonAargauJobs — all-or-nothing snapshot', () => {
    const fixture = (name: string) => readFileSync(resolve(__dirname, 'fixtures', 'kanton-aargau', name), 'utf8');
    const api = (patch: Record<string, unknown> = {}) => JSON.stringify({ ...JSON.parse(fixture('jobs-proxy-sample.json')), ...patch });
    const detailHtml = fixture('detail-juristisches-praktikum.html');
    const serve = (routes: (url: string) => Response) => {
      const fetchMock = vi.fn(async (input: string | URL) => routes(String(input)));
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    };
    const isApi = (url: string) => url.includes('/io/jobs-proxy/jobs');

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it('fails when the API declares more vacancies than it returned', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const fetchMock = serve((url) => (isApi(url) ? new Response(api({ total: 3 })) : new Response(detailHtml)));
      await expect(fetchAllKantonAargauJobs()).rejects.toThrow(/reports 3 vacancies but returned 2/);
      // No vacancy page is read: nothing partial is assembled.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('fails with the HTTP status when a vacancy page answers 500, and publishes no stand-in', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      serve((url) => (isApi(url) ? new Response(api()) : new Response('oops', { status: 500 })));
      const err = await fetchAllKantonAargauJobs().then(() => null, (e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/HTTP 500 from https:\/\/jobs\.ag\.ch\//);
      expect(err.status).toBe(500);
      // A status means the source answered: the pipeline must not treat it as
      // a connection-level soft exit.
      expect(isConnectionLevelFetchError(err)).toBe(false);
    });

    it('fails when a vacancy page carries no ad body', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      serve((url) => (isApi(url) ? new Response(api()) : new Response('<html><body><p>Seite nicht gefunden</p></body></html>')));
      await expect(fetchAllKantonAargauJobs()).rejects.toThrow(/has no ad body/);
    });

    it('publishes every vacancy with its page body when the board is complete', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      serve((url) => (isApi(url) ? new Response(api()) : new Response(detailHtml)));
      const jobs = await fetchAllKantonAargauJobs();
      expect(jobs).toHaveLength(2);
      const body = extractAgJobPosting(detailHtml).description;
      for (const job of jobs) {
        expect(job.description.startsWith(body)).toBe(true);
        expect(job.description).not.toContain(`${job.title} — Kanton Aargau.`);
      }
    });
  });
});
