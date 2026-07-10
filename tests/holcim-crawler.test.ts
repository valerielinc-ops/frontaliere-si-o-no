import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  HOLCIM_KEY,
  HOLCIM_COMPANY_NAME,
  isHolcimJob,
  isTrustedDomain,
  parseSearchPage,
  extractJobDescriptionHtml,
} from '../scripts/lib/holcim-job-parser.mjs';
import { slugify, stripHtml } from '../scripts/lib/crawler-template.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

describe('Holcim Group crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(HOLCIM_KEY).toBe('holcim');
    expect(HOLCIM_COMPANY_NAME).toBe('Holcim Group');
  });

  // ── isCompanyJob ──
  describe('isHolcimJob', () => {
    it('matches by companyKey', () => {
      expect(isHolcimJob({ companyKey: 'holcim' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isHolcimJob({ company: 'Holcim Group' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isHolcimJob({ url: 'https://holcim.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isHolcimJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isHolcimJob(null)).toBe(false);
      expect(isHolcimJob(undefined)).toBe(false);
      expect(isHolcimJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://holcim.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.holcim.com/job/456')).toBe(true);
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
      expect(slugify('Developer holcim ch')).toBe('developer-holcim-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── parseSearchPage: positional location attribution ──
  describe('parseSearchPage', () => {
    /** Build one responsive copy of a job tile + its location block. */
    const tile = (href: string, title: string, loc: string) => `
      <div class="job-tile">
        <a class="jobTitle-link" href="${href}"> ${title} </a>
        <div class="foo-multilocation-value">${loc}</div>
      </div>`;

    /** Real tenant markup renders each tile up to 3x (responsive variants). */
    const page = (jobs: Array<{ href: string; title: string; loc: string; copies?: number }>, total = 0) => {
      let html = '<html><body>';
      for (const j of jobs) {
        for (let c = 0; c < (j.copies ?? 3); c += 1) html += tile(j.href, j.title, j.loc);
      }
      if (total) html += `<div>Showing 1 to ${jobs.length} of ${total} Jobs</div>`;
      html += '<footer>trailing markup</footer></body></html>';
      return html;
    };

    it('extracts unique rows with their own locations (uniform 3x render)', () => {
      const { rows, total } = parseSearchPage(page([
        { href: '/job/a/1/', title: 'Engineer', loc: 'Zug, CH, 6300' },
        { href: '/job/b/2/', title: 'Driver', loc: 'Oberdorf, NW, CH, 6370' },
      ], 36));
      expect(total).toBe(36);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ href: '/job/a/1/', title: 'Engineer', locationText: 'Zug, CH, 6300' });
      expect(rows[1]).toMatchObject({ href: '/job/b/2/', title: 'Driver', locationText: 'Oberdorf, NW, CH, 6370' });
    });

    it('keeps attribution correct when render ratio is NOT uniform', () => {
      // Job A renders 3 copies, job B only 1, job C renders 2 — the old
      // floor(locs/rows) indexing would misattribute B's and C's locations.
      const { rows } = parseSearchPage(page([
        { href: '/job/a/1/', title: 'Engineer', loc: 'Zug, CH, 6300', copies: 3 },
        { href: '/job/b/2/', title: 'Driver', loc: 'Oberdorf, NW, CH, 6370', copies: 1 },
        { href: '/job/c/3/', title: 'Mechanic', loc: 'Würenlingen, AG, CH, 5303', copies: 2 },
      ]));
      expect(rows).toHaveLength(3);
      expect(rows[0].locationText).toBe('Zug, CH, 6300');
      expect(rows[1].locationText).toBe('Oberdorf, NW, CH, 6370');
      expect(rows[2].locationText).toBe('Würenlingen, AG, CH, 5303');
    });

    it('handles a job tile with an extra location block (multi-location posting)', () => {
      const html = `
        <a class="jobTitle-link" href="/job/a/1/">Engineer</a>
        <div class="x-multilocation-value">Zug, CH, 6300</div>
        <div class="x-multilocation-value">Basel, BS, CH, 4051</div>
        <a class="jobTitle-link" href="/job/b/2/">Driver</a>
        <div class="x-multilocation-value">Oberdorf, NW, CH, 6370</div>
        <footer></footer>`;
      const { rows } = parseSearchPage(html);
      expect(rows).toHaveLength(2);
      // First tile claims its FIRST adjacent location; the extra block must
      // not shift the next tile's attribution.
      expect(rows[0].locationText).toBe('Zug, CH, 6300');
      expect(rows[1].locationText).toBe('Oberdorf, NW, CH, 6370');
    });

    it('leaves locationText empty (no cross-tile bleed) when a tile has no location block', () => {
      const html = `
        <a class="jobTitle-link" href="/job/a/1/">Engineer</a>
        <a class="jobTitle-link" href="/job/b/2/">Driver</a>
        <div class="x-multilocation-value">Oberdorf, NW, CH, 6370</div>`;
      const { rows } = parseSearchPage(html);
      expect(rows).toHaveLength(2);
      expect(rows[0].locationText).toBe('');
      expect(rows[1].locationText).toBe('Oberdorf, NW, CH, 6370');
    });

    it('backfills a missing location from a later responsive copy', () => {
      const html = `
        <a class="jobTitle-link" href="/job/a/1/">Engineer</a>
        <a class="jobTitle-link" href="/job/b/2/">Driver</a>
        <div class="x-multilocation-value">Oberdorf, NW, CH, 6370</div>
        <a class="jobTitle-link" href="/job/a/1/">Engineer</a>
        <div class="x-multilocation-value">Zug, CH, 6300</div>`;
      const { rows } = parseSearchPage(html);
      expect(rows).toHaveLength(2);
      expect(rows[0].locationText).toBe('Zug, CH, 6300');
      expect(rows[1].locationText).toBe('Oberdorf, NW, CH, 6370');
    });

    it('returns empty rows and zero total on empty/unrecognised HTML', () => {
      expect(parseSearchPage('')).toEqual({ rows: [], total: 0 });
      expect(parseSearchPage('<html><body>maintenance</body></html>')).toEqual({ rows: [], total: 0 });
    });
  });

  // ── extractJobDescriptionHtml: detail-page description block ──
  describe('extractJobDescriptionHtml', () => {
    it('extracts the full description from a REAL detail page where <p id="job-location"> precedes the span (issue #3836 regression)', () => {
      // Live-captured 2026-07-10: careers.holcimgroup.com renders the
      // job-location marker BEFORE the jobdescription span, which made the
      // old "slice up to the marker" logic return '' on every job and ship
      // 28/31 thin stub descriptions.
      const html = readFileSync(join(FIXTURES, 'holcim-detail-baumaschinenfuehrer.html'), 'utf8');
      expect(html.indexOf('<p id="job-location"')).toBeGreaterThan(-1);
      expect(html.indexOf('<p id="job-location"')).toBeLessThan(html.indexOf('<span class="jobdescription">'));

      const desc = extractJobDescriptionHtml(html);
      expect(desc.length).toBeGreaterThan(1000);
      expect(desc).toContain('Bedienung von Baumaschinen');
      expect(desc).toContain('<li>');
      // Must stop at the span's own close — no trailing page chrome.
      expect(desc).not.toContain('buttontext06ed94238f4892f7');

      // The audit's structured-content check must see bullets after stripHtml.
      const text = stripHtml(desc);
      expect(text.length).toBeGreaterThan(1000);
      expect(/^\s*[-•*]\s/m.test(text)).toBe(true);
    });

    it('handles nested <span> elements inside the description', () => {
      const html = '<div><span class="jobdescription"><p>Intro <span class="hl">highlight</span> tail</p><ul><li>Task</li></ul></span><p>after</p></div>';
      const desc = extractJobDescriptionHtml(html);
      expect(desc).toBe('<p>Intro <span class="hl">highlight</span> tail</p><ul><li>Task</li></ul>');
    });

    it('still supports the legacy layout (marker AFTER the span, unbalanced markup)', () => {
      const html = '<span class="jobdescription"><p>Role body</p><p id="job-location">Zug</p>';
      const desc = extractJobDescriptionHtml(html);
      expect(desc).toContain('Role body');
      expect(desc).not.toContain('Zug');
    });

    it('returns empty string when the description block is missing', () => {
      expect(extractJobDescriptionHtml('<html><body>maintenance</body></html>')).toBe('');
      expect(extractJobDescriptionHtml('')).toBe('');
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference
    const validJob = {
      id: 'holcim-abc123',
      slug: 'test-position-holcim-ch',
      slugByLocale: { en: 'test-position-holcim-ch' },
      company: 'Holcim Group',
      companyKey: 'holcim',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://holcim.com/jobs/test',
      source: 'Holcim Group Dedicated Parser',
      sourceLang: 'en',
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
      expect(validJob.id).toMatch(/^holcim-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
