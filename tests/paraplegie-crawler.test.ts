import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  PARAPLEGIE_KEY,
  PARAPLEGIE_COMPANY_NAME,
  isParaplegieJob,
  isTrustedDomain,
  fetchAllParaplegieJobs,
} from '../scripts/lib/paraplegie-job-parser.mjs';

// Migration (issue #1877): SPG moved off the dead Umantis tenant
// (recruitingapp-2782.umantis.com, detail URLs 302-redirect cross-host) onto a
// Prospective.ch career center (jobs.paraplegie.ch), served by the public JSON
// endpoint at medium 1001777. These tests pin the new Prospective contract.
const MEDIUM_ENDPOINT_PREFIX =
  'https://ohws.prospective.ch/public/v1/medium/1001777/jobs';

describe('Schweizer Paraplegiker-Gruppe (paraplegie) crawler parser', () => {
  it('exports valid company key and name', () => {
    expect(PARAPLEGIE_KEY).toBe('paraplegie');
    expect(PARAPLEGIE_COMPANY_NAME).toBe('Schweizer Paraplegiker-Gruppe');
  });

  describe('isParaplegieJob', () => {
    it('matches by companyKey', () => {
      expect(isParaplegieJob({ companyKey: 'paraplegie' })).toBe(true);
    });
    it('matches by company name', () => {
      expect(isParaplegieJob({ company: 'Schweizer Paraplegiker-Gruppe' })).toBe(true);
    });
    it('matches by URL domain', () => {
      expect(isParaplegieJob({ url: 'https://jobs.paraplegie.ch/offene-stellen/x/uuid' })).toBe(true);
    });
    it('rejects unrelated jobs', () => {
      expect(isParaplegieJob({ companyKey: 'other', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });
    it('handles null/undefined gracefully', () => {
      expect(isParaplegieJob(null)).toBe(false);
      expect(isParaplegieJob(undefined)).toBe(false);
      expect(isParaplegieJob({})).toBe(false);
    });
  });

  describe('isTrustedDomain', () => {
    it('trusts the corporate domain', () => {
      expect(isTrustedDomain('https://www.paraplegie.ch/de/karriere')).toBe(true);
    });
    it('trusts the Prospective career-center host (detail/apply URLs)', () => {
      expect(isTrustedDomain('https://jobs.paraplegie.ch/offene-stellen/x/uuid')).toBe(true);
    });
    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });
    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  describe('fetchAllParaplegieJobs — Prospective medium 1001777', () => {
    const realFetch = globalThis.fetch;

    beforeEach(() => {
      // Skip the real exponential backoff (1s/2s/4s) fetchWithRetry does on
      // retryable statuses — several tests below deliberately return 500/503
      // to exercise graceful degradation, and don't need the real delay.
      process.env.JOBS_CRAWLER_RETRY_BASE_MS = '0';
      globalThis.fetch = vi.fn(async () => new Response('', { status: 500 })) as any;
    });
    afterEach(() => {
      globalThis.fetch = realFetch;
      delete process.env.JOBS_CRAWLER_RETRY_BASE_MS;
    });

    it('hits the correct Prospective medium endpoint and parses a rich job', async () => {
      let requestedUrl = '';
      globalThis.fetch = vi.fn(async (url: any) => {
        const u = String(url);
        if (u.startsWith(MEDIUM_ENDPOINT_PREFIX)) {
          requestedUrl = u;
          return new Response(
            JSON.stringify({
              medium_id: 1001777,
              total: 1,
              jobs: [
                {
                  szas: {
                    sza_title:
                      'Drogist*in oder Fachfrau/-mann Gesundheit in beratender Funktion für Kontinenz- und Alltagshilfen',
                    'sza_workplace.city': 'Nottwil',
                    'sza_workplace.zip': '6207',
                    'sza_workplace.region': 'Luzern',
                    sza_introduction:
                      'Werde Teil von etwas Grösserem. Arbeite mit über 2000 Spezialistinnen und Spezialisten aus mehr als 100 Berufen zusammen und ermögliche querschnittgelähmten Menschen ein selbstbestimmtes Leben auf dem modernen Campus in Nottwil.',
                    sza_tasks:
                      '<ul><li>Beratung von Klientinnen und Klienten zu Kontinenz- und Alltagshilfen</li><li>Verkauf und Abgabe von Hilfsmitteln</li><li>Pflege der Kundenbeziehungen und Bewirtschaftung des Sortiments</li></ul>',
                    sza_requirements:
                      '<ul><li>Abgeschlossene Ausbildung als Drogist*in oder Fachfrau/-mann Gesundheit</li><li>Freude am Kundenkontakt und an der Beratung</li><li>Selbstständige und strukturierte Arbeitsweise</li></ul>',
                    sza_pensum: '80-100%',
                    'sza_pensum.min': '80',
                    'sza_pensum.max': '100',
                  },
                  attributes: { '20': ['Orthotec AG'] },
                  links: {
                    directlink:
                      'https://jobs.paraplegie.ch/offene-stellen/drogist-in-oder-fachfrau-mann-gesundheit-in-beratender-funktion-fuer-kontinenz-und-alltagshilfen/321dfb94-5c54-4c00-8fa1-06870df9c289',
                  },
                  start_date: '2026-06-01',
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('', { status: 404 });
      }) as any;

      const jobs = await fetchAllParaplegieJobs();
      expect(jobs).toHaveLength(1);
      // Correct tenant + language was requested.
      expect(requestedUrl).toContain('/medium/1001777/jobs');
      expect(requestedUrl).toContain('lang=de');

      const job = jobs[0];
      expect(job).toMatchObject({
        company: 'Schweizer Paraplegiker-Gruppe',
        companyKey: 'paraplegie',
        location: 'Nottwil',
        canton: 'LU',
        postalCode: '6207',
        country: 'CH',
      });
      expect(job.id).toMatch(/^paraplegie-/);
      expect(job.url).toBe(
        'https://jobs.paraplegie.ch/offene-stellen/drogist-in-oder-fachfrau-mann-gesundheit-in-beratender-funktion-fuer-kontinenz-und-alltagshilfen/321dfb94-5c54-4c00-8fa1-06870df9c289',
      );
      // Detail/apply URL must pass the trusted-domain gate.
      expect(isTrustedDomain(job.url)).toBe(true);

      // Description must be rich — well above the 50-word thin-content floor.
      const words = String(job.description || '').split(/\s+/).filter(Boolean).length;
      expect(words).toBeGreaterThan(50);
      // The sza_* body fields must actually be merged into the description.
      expect(job.description).toContain('Beratung von Klientinnen');
      expect(job.description).toContain('Abgeschlossene Ausbildung als Drogist');
    });

    it('returns [] (no throw) when the Prospective API is unreachable', async () => {
      globalThis.fetch = vi.fn(async () => {
        throw new Error('ENOTFOUND ohws.prospective.ch');
      }) as any;
      const jobs = await fetchAllParaplegieJobs();
      expect(jobs).toEqual([]);
    });

    it('returns [] (no throw) when the Prospective API errors mid-pagination', async () => {
      globalThis.fetch = vi.fn(async () => new Response('', { status: 503 })) as any;
      const jobs = await fetchAllParaplegieJobs();
      expect(jobs).toEqual([]);
    });
  });
});
