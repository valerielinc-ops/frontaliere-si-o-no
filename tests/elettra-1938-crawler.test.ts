import { beforeEach, describe, it, expect, vi } from 'vitest';

// Mock only network access from the shared template; parsing helpers stay real.
const { fetchHtml, fetchJson } = vi.hoisted(() => ({ fetchHtml: vi.fn(), fetchJson: vi.fn() }));
vi.mock('@/scripts/lib/crawler-template.mjs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, fetchHtml, fetchJson };
});

import {
  ELETTRA_1938_KEY,
  ELETTRA_1938_COMPANY_NAME,
  isElettra1938Job,
  isTrustedDomain,
  fetchAllElettra1938Jobs,
} from '../scripts/lib/elettra-1938-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

const STABIO_CARD = `
  <div class="vacancy__render">
    <div class="vacancy__title"><h3><a href="/fiammcomponents/it/career/job-1">Tecnico elettrico</a></h3></div>
    <span class="subtitle__informations" title="Sede">Stabio, Svizzera</span>
    <span class="subtitle__informations" title="Azienda">Elettra 1938</span>
    <div class="vacancy__description">Descrizione posizione.</div>
  </div>
`;

const NON_STABIO_CARD = `
  <div class="vacancy__render">
    <div class="vacancy__title"><h3><a href="/fiammcomponents/it/career/job-2">Ingegnere</a></h3></div>
    <span class="subtitle__informations" title="Sede">Avellino, Italia</span>
    <span class="subtitle__informations" title="Azienda">FIAMM</span>
    <div class="vacancy__description">Descrizione posizione.</div>
  </div>
`;

const AJAX_SCAFFOLD = `
  <html><body>
    <div id="vacancyList">
      <input id="url-for-announces" value="https://inrecruiting.intervieweb.it/app.php?module=newcareer&amp;ajax=1">
    </div>
    <script>const request = { act1: "vacancyListCareer", "section": "test-section" };</script>
  </body></html>
`;

const EMPTY_AJAX_RESPONSE = {
  success: true,
  data: '<div class="vacancy-list-empty">Nessun annuncio disponibile</div>',
};

describe('Elettra 1938 crawler parser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(ELETTRA_1938_KEY).toBe('elettra-1938');
    expect(ELETTRA_1938_COMPANY_NAME).toBe('Elettra 1938');
  });

  // ── isCompanyJob ──
  describe('isElettra1938Job', () => {
    it('matches by companyKey', () => {
      expect(isElettra1938Job({ companyKey: 'elettra-1938' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isElettra1938Job({ company: 'Elettra 1938' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isElettra1938Job({ url: 'https://inrecruiting.intervieweb.it/fiammcomponents/it/job/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isElettra1938Job({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isElettra1938Job(null)).toBe(false);
      expect(isElettra1938Job(undefined)).toBe(false);
      expect(isElettra1938Job({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://inrecruiting.intervieweb.it/fiammcomponents/it/career/job-123')).toBe(true);
    });

    it('trusts other locale paths under fiammcomponents', () => {
      expect(isTrustedDomain('https://inrecruiting.intervieweb.it/fiammcomponents/en/career/456')).toBe(true);
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
      expect(slugify('Developer elettra-1938 ch')).toBe('developer-elettra-1938-ch');
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
      id: 'elettra-1938-abc123',
      slug: 'test-position-elettra-1938-ch',
      slugByLocale: { it: 'test-position-elettra-1938-ch' },
      company: 'Elettra 1938',
      companyKey: 'elettra-1938',
      title: 'Test Position',
      titleByLocale: { it: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { it: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://elettra1938.ch/jobs/test',
      source: 'Elettra 1938 Dedicated Parser',
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
      expect(validJob.id).toMatch(/^elettra-1938-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  // ── fetchAllElettra1938Jobs markup sanity check (network mocked, #5981) ──
  describe('fetchAllElettra1938Jobs markup sanity check', () => {
    it('parses Stabio jobs and skips non-Stabio cards on the shared portal', async () => {
      fetchHtml.mockResolvedValueOnce(`<html><body>${STABIO_CARD}${NON_STABIO_CARD}</body></html>`);
      const jobs = await fetchAllElettra1938Jobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].title).toBe('Tecnico elettrico');
      expect(fetchJson).not.toHaveBeenCalled();
    });

    it('returns an empty array when the portal has cards but none in Stabio (genuine zero)', async () => {
      fetchHtml.mockResolvedValueOnce(`<html><body>${NON_STABIO_CARD}</body></html>`);
      const jobs = await fetchAllElettra1938Jobs();
      expect(jobs).toEqual([]);
    });

    it('accepts zero cards only when coherent markup and the live endpoint independently confirm an empty state', async () => {
      fetchHtml.mockResolvedValueOnce(AJAX_SCAFFOLD);
      fetchJson.mockResolvedValueOnce(EMPTY_AJAX_RESPONSE);
      const jobs = await fetchAllElettra1938Jobs();
      expect(jobs).toEqual([]);
      expect(fetchJson).toHaveBeenCalledWith(
        'https://inrecruiting.intervieweb.it/app.php?module=newcareer&ajax=1',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('act1=vacancyListCareer'),
        }),
      );
    });

    it('uses cards returned by the live endpoint when the initial page has none', async () => {
      fetchHtml.mockResolvedValueOnce(AJAX_SCAFFOLD);
      fetchJson.mockResolvedValueOnce({ success: true, data: STABIO_CARD });
      const jobs = await fetchAllElettra1938Jobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].title).toBe('Tecnico elettrico');
    });

    it('throws on a class rename even when a stray .vacancy__render reference survives', async () => {
      fetchHtml.mockResolvedValueOnce(AJAX_SCAFFOLD);
      fetchJson.mockResolvedValueOnce({
        success: true,
        data: '<style>.vacancy__render { display: block }</style><div class="vacancy-card-renamed">Posizione aperta</div>',
      });
      await expect(fetchAllElettra1938Jobs()).rejects.toThrow(/selector\/template drift/i);
    });

    it('throws before probing when markup is partial and the endpoint is absent', async () => {
      fetchHtml.mockResolvedValueOnce('<html><body><div id="vacancyList"></div><script>{ "section": "test-section" }</script></body></html>');
      await expect(fetchAllElettra1938Jobs()).rejects.toThrow(/selector\/template drift/i);
      expect(fetchJson).not.toHaveBeenCalled();
    });

    it('surfaces a career-page fetch error instead of treating it as a genuine lull', async () => {
      fetchHtml.mockRejectedValueOnce(new Error('request timed out'));
      await expect(fetchAllElettra1938Jobs()).rejects.toThrow(/failed to fetch.*request timed out/i);
      expect(fetchJson).not.toHaveBeenCalled();
    });

    it('surfaces an endpoint fetch error instead of treating it as a genuine lull', async () => {
      fetchHtml.mockResolvedValueOnce(AJAX_SCAFFOLD);
      fetchJson.mockRejectedValueOnce(new Error('endpoint timed out'));
      await expect(fetchAllElettra1938Jobs()).rejects.toThrow(/failed to verify.*endpoint timed out/i);
    });
  });
});
