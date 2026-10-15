import { describe, it, expect, vi } from 'vitest';

// Mock only `fetchHtml` from the shared template — everything else
// (slugify, stripHtml, normalizeSpace) stays real since the parser imports
// them directly and they're pure/deterministic.
const { fetchHtml } = vi.hoisted(() => ({ fetchHtml: vi.fn() }));
vi.mock('@/scripts/lib/crawler-template.mjs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, fetchHtml };
});

import {
  ZERMATT_BERGBAHNEN_KEY,
  ZERMATT_BERGBAHNEN_COMPANY_NAME,
  isZermattBergbahnenJob,
  isTrustedDomain,
  fetchAllZermattBergbahnenJobs,
} from '../scripts/lib/zermatt-bergbahnen-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

const LISTING_CARD = `
  <section class="card-item stretch-link">
    <div class="card-item__body">
      <div class="card-item__top-title">IT und Telekommunikation</div>
      <h3 class="card-item__title">
        <a href="/de/ueber-uns/job-und-karriere/informatiker/in_job_3001250" class="stretch-link__link">Informatiker/in</a>
      </h3>
      <div class="card-item__tag-list">
        <span class="card-item__tag-list-item">Vollzeit</span>
        <span class="card-item__tag-list-item">Unbefristet</span>
        <span class="card-item__tag-list-item">Jobs</span>
      </div>
    </div>
  </section>
`;

describe('Zermatt Bergbahnen crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(ZERMATT_BERGBAHNEN_KEY).toBe('zermatt-bergbahnen');
    expect(ZERMATT_BERGBAHNEN_COMPANY_NAME).toBe('Zermatt Bergbahnen');
  });

  // ── isCompanyJob ──
  describe('isZermattBergbahnenJob', () => {
    it('matches by companyKey', () => {
      expect(isZermattBergbahnenJob({ companyKey: 'zermatt-bergbahnen' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isZermattBergbahnenJob({ company: 'Zermatt Bergbahnen' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isZermattBergbahnenJob({ url: 'https://matterhornparadise.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isZermattBergbahnenJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isZermattBergbahnenJob(null)).toBe(false);
      expect(isZermattBergbahnenJob(undefined)).toBe(false);
      expect(isZermattBergbahnenJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://matterhornparadise.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.matterhornparadise.ch/job/456')).toBe(true);
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
      expect(slugify('Developer zermatt-bergbahnen ch')).toBe('developer-zermatt-bergbahnen-ch');
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
      id: 'zermatt-bergbahnen-abc123',
      slug: 'test-position-zermatt-bergbahnen-ch',
      slugByLocale: { de: 'test-position-zermatt-bergbahnen-ch' },
      company: 'Zermatt Bergbahnen',
      companyKey: 'zermatt-bergbahnen',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://matterhornparadise.ch/jobs/test',
      source: 'Zermatt Bergbahnen Dedicated Parser',
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
      expect(validJob.id).toMatch(/^zermatt-bergbahnen-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  // ── fetchAllZermattBergbahnenJobs (network mocked via fetchHtml) ──
  // Regression for #3900: the careers page stopped embedding job cards and
  // now loads them client-side via the "Alle" tab AJAX endpoint, which
  // returns JSON `{ html, success }` instead of raw HTML.
  describe('fetchAllZermattBergbahnenJobs', () => {
    it('parses jobs from the AJAX tab JSON payload', async () => {
      fetchHtml
        .mockResolvedValueOnce(JSON.stringify({ html: `<ul>${LISTING_CARD}</ul>`, success: true }))
        .mockResolvedValueOnce(`<article>${'x'.repeat(120)}</article>`);

      const jobs = await fetchAllZermattBergbahnenJobs();

      expect(jobs).toHaveLength(1);
      expect(jobs[0].title).toBe('Informatiker/in');
      expect(jobs[0].url).toBe('https://www.matterhornparadise.ch/de/ueber-uns/job-und-karriere/informatiker/in_job_3001250');
      expect(jobs[0].companyKey).toBe(ZERMATT_BERGBAHNEN_KEY);
    });

    it('falls back to treating the response as raw HTML if it is not JSON', async () => {
      fetchHtml
        .mockResolvedValueOnce(`<ul>${LISTING_CARD}</ul>`)
        .mockResolvedValueOnce(`<article>${'x'.repeat(120)}</article>`);

      const jobs = await fetchAllZermattBergbahnenJobs();

      expect(jobs).toHaveLength(1);
      expect(jobs[0].title).toBe('Informatiker/in');
    });

    it('files the German detail body under de even when the title reads as English (issue 5253)', async () => {
      const englishCard = LISTING_CARD.replace(/>Informatiker\/in</, '>Customer Service Agent for the Valley Station<');
      const germanBody = 'Du empfängst unsere Gäste an der Talstation, berätst sie zu Tickets und Pisten und sorgst für einen reibungslosen Ablauf im Kundendienst. '
        + 'Wir bieten dir ein engagiertes Team, ein Saisonabonnement und vergünstigte Mahlzeiten in unseren Restaurants.';
      fetchHtml
        .mockResolvedValueOnce(JSON.stringify({ html: `<ul>${englishCard}</ul>`, success: true }))
        .mockResolvedValueOnce(`<div class="wysiwyg-usp-area"><p>${germanBody}</p></div>`);

      const [job] = await fetchAllZermattBergbahnenJobs();

      expect(job.title).toBe('Customer Service Agent for the Valley Station');
      expect(job.sourceLang).toBe('de');
      expect(Object.keys(job.descriptionByLocale)).toEqual(['de']);
    });

    it('reads only the text sections: no breadcrumbs, no apply button, no application form (issue 5253)', async () => {
      // Minimized from the live page of job 3001261 (2026-09-29): the old
      // parser took the whole outer `.content-block`, category and breadcrumbs
      // included, down to the online application form.
      const detail = `
        <div class="content-block js-content-visibility">
          <div class="hero">Technik Mitarbeitende/r Unterhalt &amp; Revision Gletscherlifte</div>
          <nav class="breadcrumbs">breadcrumbs.home Über uns Jobs und Karriere</nav>
          <div class="wysiwyg-usp-area content-block container">
            <p>Die Zermatt Bergbahnen AG betreibt das ganzjährige, internationale Ausflugs- und Schneesportgebiet von Zermatt. Als moderner Arbeitgeber sind wir in Zermatt und im gesamten Mattertal stark verankert.</p>
            <a class="btn btn-secondary" href="#application-form">Jetzt bewerben</a>
          </div>
          <div class="wysiwyg-with-medium content-block container">
            <h3>Dein Job</h3><ul><li>Revisions- und Instandhaltungsarbeiten an den Gletscherliften</li><li>Störungsanalyse an mechanischen und hydraulischen Systemen</li></ul>
          </div>
          <div class="slide bg-white-dark content-block" id="application-form">
            <form><label>Vorname *</label><input name="firstname"><label>Lebenslauf *</label><input type="file"> Datei hochladen</form>
          </div>
        </div>`;
      fetchHtml
        .mockResolvedValueOnce(JSON.stringify({ html: `<ul>${LISTING_CARD}</ul>`, success: true }))
        .mockResolvedValueOnce(detail);

      const [job] = await fetchAllZermattBergbahnenJobs();

      expect(job.description).toContain('Die Zermatt Bergbahnen AG betreibt');
      expect(job.description).toContain('• Revisions- und Instandhaltungsarbeiten');
      expect(job.description).not.toContain('breadcrumbs.home');
      expect(job.description).not.toContain('Jetzt bewerben');
      expect(job.description).not.toContain('Datei hochladen');
    });

    it('returns an empty array when the tab payload has no job cards', async () => {
      fetchHtml.mockResolvedValueOnce(JSON.stringify({ html: '<ul></ul>', success: true }));

      const jobs = await fetchAllZermattBergbahnenJobs();

      expect(jobs).toEqual([]);
    });
  });
});
