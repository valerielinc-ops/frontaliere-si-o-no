import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  LOCARNO_FILM_FESTIVAL_KEY,
  LOCARNO_FILM_FESTIVAL_COMPANY_NAME,
  fetchAllLocarnoFilmFestivalJobs,
  isLocarnoFilmFestivalJob,
  isTrustedDomain,
} from '../scripts/lib/locarno-film-festival-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

const { runSpecInProduction } = vi.hoisted(() => ({
  runSpecInProduction: vi.fn(),
}));
vi.mock('../scripts/lib/prospector/spec-crawler.mjs', async (importOriginal) => ({
  ...(await importOriginal()),
  runSpecInProduction,
}));

describe('Locarno Film Festival crawler parser', () => {
  beforeEach(() => runSpecInProduction.mockReset());

  it('keeps the verified application form URL from the PDF annotation', async () => {
    const detailUrl = 'https://www.locarnofestival.ch/it/dam/job.pdf';
    const formUrl = 'https://form.locarnofestival.ch/forms/example';
    runSpecInProduction.mockResolvedValueOnce([{
      title: 'Atelier du Futur Project Manager',
      url: detailUrl,
      applyUrl: formUrl,
      location: 'Locarno',
      description: '<p>Gestione e realizzazione del progetto culturale.</p>',
    }]);

    const jobs = await fetchAllLocarnoFilmFestivalJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0].url).toBe(detailUrl);
    expect(jobs[0].applyUrl).toBe(formUrl);
  });

  it('falls back to the source PDF when an application URL is outside the verified form path', async () => {
    const detailUrl = 'https://www.locarnofestival.ch/it/dam/job.pdf';
    runSpecInProduction.mockResolvedValueOnce([{
      title: 'Atelier du Futur Project Manager',
      url: detailUrl,
      applyUrl: 'https://attacker.example/forms/example',
      location: 'Locarno',
      description: '<p>Gestione e realizzazione del progetto culturale.</p>',
    }]);

    const jobs = await fetchAllLocarnoFilmFestivalJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0].applyUrl).toBe(detailUrl);
  });

  it('rescues an unmarked empty listing before failing closed', async () => {
    runSpecInProduction.mockResolvedValueOnce([]);

    await expect(fetchAllLocarnoFilmFestivalJobs()).resolves.toEqual([]);

    expect(runSpecInProduction).toHaveBeenCalledWith(
      expect.objectContaining({
        browserRescue: true,
        rescueOnEmptyListing: true,
        emptyListingOutcome: 'anti_bot_block',
      }),
    );
  });

  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(LOCARNO_FILM_FESTIVAL_KEY).toBe('locarno-film-festival');
    expect(LOCARNO_FILM_FESTIVAL_COMPANY_NAME).toBe('Locarno Film Festival');
  });

  // ── isCompanyJob ──
  describe('isLocarnoFilmFestivalJob', () => {
    it('matches by companyKey', () => {
      expect(isLocarnoFilmFestivalJob({ companyKey: 'locarno-film-festival' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isLocarnoFilmFestivalJob({ company: 'Locarno Film Festival' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isLocarnoFilmFestivalJob({ url: 'https://locarnofestival.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isLocarnoFilmFestivalJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isLocarnoFilmFestivalJob(null)).toBe(false);
      expect(isLocarnoFilmFestivalJob(undefined)).toBe(false);
      expect(isLocarnoFilmFestivalJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://locarnofestival.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.locarnofestival.ch/job/456')).toBe(true);
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
      expect(slugify('Developer locarno-film-festival ch')).toBe('developer-locarno-film-festival-ch');
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
      id: 'locarno-film-festival-abc123',
      slug: 'test-position-locarno-film-festival-ch',
      slugByLocale: { it: 'test-position-locarno-film-festival-ch' },
      company: 'Locarno Film Festival',
      companyKey: 'locarno-film-festival',
      title: 'Test Position',
      titleByLocale: { it: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { it: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://locarnofestival.ch/jobs/test',
      source: 'Locarno Film Festival Dedicated Parser',
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
      expect(validJob.id).toMatch(/^locarno-film-festival-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
