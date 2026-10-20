import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  ROLEX_KEY,
  ROLEX_COMPANY_NAME,
  isRolexJob,
  isTrustedDomain,
  fetchAllRolexJobs,
} from '../scripts/lib/rolex-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Rolex crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(ROLEX_KEY).toBe('rolex');
    expect(ROLEX_COMPANY_NAME).toBe('Rolex');
  });

  // ── isCompanyJob ──
  describe('isRolexJob', () => {
    it('matches by companyKey', () => {
      expect(isRolexJob({ companyKey: 'rolex' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isRolexJob({ company: 'Rolex' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isRolexJob({ url: 'https://rolex.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isRolexJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isRolexJob(null)).toBe(false);
      expect(isRolexJob(undefined)).toBe(false);
      expect(isRolexJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://rolex.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.rolex.com/job/456')).toBe(true);
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
      expect(slugify('Developer rolex ch')).toBe('developer-rolex-ch');
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
      id: 'rolex-abc123',
      slug: 'test-position-rolex-ch',
      slugByLocale: { fr: 'test-position-rolex-ch' },
      company: 'Rolex',
      companyKey: 'rolex',
      title: 'Test Position',
      titleByLocale: { fr: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { fr: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://rolex.com/jobs/test',
      source: 'Rolex Dedicated Parser',
      sourceLang: 'fr',
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
      expect(validJob.id).toMatch(/^rolex-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});

// Only the posting's own text is published (issue 5253): without a body the
// listing used to go out as "{title} — Rolex, {city} ({canton})." (5/174 rows
// on 2026-09-29, where a template token blanked the body). Shapes of
// carrieres-rolex.com (jobs2web rows, JobPosting microdata).
describe('fetchAllRolexJobs — listing without a vacancy body', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('publishes the listing with a body and skips the one without, never inventing text', async () => {
    const row = (id: string, title: string) => `<tr class="data-row"><td><a href="/Rolex/job/Geneve-${id}/${id}/" class="jobTitle-link">${title}</a><span class="jobFacility">Genève</span></td></tr>`;
    const listing = `<table>${row('1180001', 'Horloger / Horlogère')}${row('1180002', 'Stage découverte apprentissage')}</table>`;
    const detail = (body: string) => `<html><body><meta itemprop="addressLocality" content="Genève"><meta itemprop="addressCountry" content="CH"><span itemprop="description">${body}</span></section></body></html>`;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/go/Toutes-nos-offres-Rolex/')) return new Response(listing, { status: 200 });
      if (u.includes('1180001')) return new Response(detail("<p>Vous assemblez et réglez des mouvements dans nos ateliers de Genève, dans le respect des standards Rolex. Vous travaillez en étroite collaboration avec plusieurs services, documentez votre travail avec soin et contribuez à l'amélioration de nos processus. Nous offrons un poste moderne, des horaires flexibles, des formations continues et une culture d'équipe ouverte. De bonnes connaissances du français et une méthode de travail structurée complètent votre profil.</p>"), { status: 200 });
      return new Response(detail(''), { status: 200 });
    }));

    const jobs = await fetchAllRolexJobs();
    expect(jobs.map((job) => job.title)).toEqual(['Horloger / Horlogère']);
    expect(jobs[0].description).toContain('mouvements');
    for (const job of jobs) expect(job.description).not.toMatch(/— Rolex, /);
  }, 20_000);
});
