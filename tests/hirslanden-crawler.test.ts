import { describe, it, expect } from 'vitest';
import {
  HIRSLANDEN_KEY,
  HIRSLANDEN_COMPANY_NAME,
  isHirslandenJob,
  isTrustedDomain,
  parseSearchResults,
} from '../scripts/lib/hirslanden-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Hirslanden Klinik crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(HIRSLANDEN_KEY).toBe('hirslanden');
    expect(HIRSLANDEN_COMPANY_NAME).toBe('Hirslanden Klinik');
  });

  // ── isCompanyJob ──
  describe('isHirslandenJob', () => {
    it('matches by companyKey', () => {
      expect(isHirslandenJob({ companyKey: 'hirslanden' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isHirslandenJob({ company: 'Hirslanden Klinik' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isHirslandenJob({ url: 'https://hirslanden.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isHirslandenJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isHirslandenJob(null)).toBe(false);
      expect(isHirslandenJob(undefined)).toBe(false);
      expect(isHirslandenJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://hirslanden.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.hirslanden.ch/job/456')).toBe(true);
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
      expect(slugify('Developer hirslanden ch')).toBe('developer-hirslanden-ch');
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
      id: 'hirslanden-abc123',
      slug: 'test-position-hirslanden-ch',
      slugByLocale: { de: 'test-position-hirslanden-ch' },
      company: 'Hirslanden Klinik',
      companyKey: 'hirslanden',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://hirslanden.ch/jobs/test',
      source: 'Hirslanden Klinik Dedicated Parser',
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
      expect(validJob.id).toMatch(/^hirslanden-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  // ── parseSearchResults: layout handling ──
  describe('parseSearchResults', () => {
    it('parses the legacy <tr>/<td> table layout', () => {
      const html = `
        <table>
          <tr>
            <td><a href="/Hirslanden/job/Some-Role-Zurich-8008/111/">Dipl. Pflegefachfrau</a></td>
            <td>Zürich</td>
            <td>2026-06-01</td>
          </tr>
        </table>`;
      const jobs = parseSearchResults(html);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].jobId).toBe('111');
      expect(jobs[0].title).toBe('Dipl. Pflegefachfrau');
      expect(jobs[0].location).toBe('Zürich');
      expect(jobs[0].url).toContain('/Hirslanden/job/Some-Role-Zurich-8008/111/');
    });

    it('falls back to the div-based tile layout (current SF skin)', () => {
      // careers.mediclinic.com migrated away from <tr> rows to job tiles.
      const html = `
        <div class="job-row">
          <span class="section-title title" role="heading">
            <a class="jobTitle-link fontcolorc63bfd23" data-focus-tile=".job-id-1293595201"
               href="/Hirslanden/job/Hirslanden-Klinik-St_-Anna-Luze-6003/1293595201/">
               Dipl. Expertin / Experte Anästhesiepflege NDS (a) 80-100%
            </a>
          </span>
          <div id="job-1293595201-desktop-section-customfield5-value">Luzern</div>
          <!-- tablet variant repeats the same job -->
          <a class="jobTitle-link" href="/Hirslanden/job/Hirslanden-Klinik-St_-Anna-Luze-6003/1293595201/">
            Dipl. Expertin / Experte Anästhesiepflege NDS (a) 80-100%
          </a>
        </div>`;
      const jobs = parseSearchResults(html);
      expect(jobs).toHaveLength(1); // deduped across tile variants
      expect(jobs[0].jobId).toBe('1293595201');
      expect(jobs[0].title).toContain('Anästhesiepflege');
      expect(jobs[0].location).toBe('Luzern');
      expect(jobs[0].url).toContain('/Hirslanden/job/');
    });

    it('matches tile anchors regardless of class/href attribute order', () => {
      // A future SF skin could emit `href` before `class`; the lookahead-based
      // linkRe must not depend on `class` preceding `href` (would zero-match).
      const html = `
        <div class="job-row">
          <a data-focus-tile=".job-id-555" href="/Hirslanden/job/Some-Role-Bern-3000/555/"
             class="jobTitle-link fontcolorc63bfd23">
             Fachperson Operationstechnik (a) 100%
          </a>
          <div id="job-555-desktop-section-customfield5-value">Bern</div>
        </div>`;
      const jobs = parseSearchResults(html);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].jobId).toBe('555');
      expect(jobs[0].title).toContain('Operationstechnik');
      expect(jobs[0].location).toBe('Bern');
    });

    it('returns empty array for HTML with no job links', () => {
      expect(parseSearchResults('<div>Keine Ergebnisse</div>')).toEqual([]);
      expect(parseSearchResults('')).toEqual([]);
    });
  });
});
